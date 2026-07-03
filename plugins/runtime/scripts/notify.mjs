#!/usr/bin/env node
// plugins/runtime/scripts/notify.mjs
//
// ADR-0040 §2 runtime notification emitter. `notify.mjs emit` consumes ONE
// event JSON (stdin or --event-file) and is the only runtime component that
// touches notification channels. It consumes only the payload it is handed —
// it never reads persona state itself (the session-handoff inversion-of-
// control contract: sensors read their own domain and pass bounded fields).
//
// Pipeline (§1 PIPELINE_ORDER): validate → kinds-filter → dedupe claim →
// quiet-hours gate → redact → channel dispatch. Config resolution precedes
// the pipeline and uses the OFFICIAL settings notify_* key contract from
// lib/runtime-config.mjs (shared with settings.mjs — no private duplicate
// parsing), effective value = repo → user → shipped default, each validated
// by the same per-key validators settings applies.
//
// ADR-0035 tier: M1 with the one bounded extension ADR-0040 §2 authorizes —
// fixed-argv notification dispatch (a repo-owned, byte-pinned osascript
// template with payload only as trailing argv). The §3 invariants are
// narrowly amended for THIS surface only:
//   - invariant 1 (dry-run default + explicit flag) → explicit CONFIG KEY:
//     the shipped default notify_channel=none makes the hook-auto-invoked
//     emitter a no-op until the operator opts into a channel;
//   - invariant 5 (finite timeout) → detached+unref() fire-and-forget: an
//     unref'd child cannot be awaited or killed; accepted because the
//     allowlisted binary is local, prompt-returning, and inconsequential on
//     failure by design;
//   - invariant 8 (semantic failure classification + surfaced recovery) →
//     fail-closed silent on the emit path: exit 0 always, NOTHING on stdout
//     ever (stdout is load-bearing on completion paths per ADR-0039), at
//     most one stderr diagnostic line; recovery guidance surfaces pull-side
//     (dashboard / file-log), never on the load-bearing completion path.
// Every other executor remains bound by §3 as written; the §4 ceiling is
// untouched (see tests/plugin-shape/runtime-executor-registry.mjs).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  claimDedupe,
  kindEnabled,
  notifyDedupeDir,
  notifyStateDir,
  parseKindsFilter,
  validateEvent,
} from './lib/notify-schema.mjs';
import {
  CONFIG_KEY_FAMILIES,
  NOTIFY_KEY_DEFAULTS,
  parseRuntimeConfigToml,
  validateConfigValue,
} from './lib/runtime-config.mjs';

export const NOTIFY_LOG_MAX_BYTES = 1024 * 1024;
export const NOTIFY_LOG_ROTATE_LOCK_STALE_MS = 60_000;

// Redaction contract (§2): field allowlist PLUS content hardening — per-field
// length caps, control-character stripping, injection-safe rendering.
// Payload text is data, never command/format material: the osascript channel
// passes it as trailing argv (never into the -e program), the file-log
// channel JSON-encodes it.
export const REDACT_FIELD_CAPS = Object.freeze({
  event_id: 256,
  source: 64,
  kind: 32,
  urgency: 16,
  title: 120,
  body: 400,
});
export const REDACT_REF_KEYS = Object.freeze(['workflow_id', 'run_id', 'path']);
export const REDACT_REF_VALUE_CAP = 256;

// C0 + DEL + C1 — stripped to single spaces before rendering anywhere.
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/g;

// The sanitized minimal env for the fire-and-forget channel child. PATH is
// fixed to the system binary dirs; only these session-context keys pass
// through (never the caller's full env).
const SPAWN_ENV_ALLOWLIST = Object.freeze(['HOME', 'LANG', 'LC_ALL', 'LOGNAME', 'TMPDIR', 'USER']);

// ---------------------------------------------------------------------------
// Repo root + config resolution
// ---------------------------------------------------------------------------

// Explicit --repo-root wins; otherwise walk up from cwd to the nearest .git
// marker (dir or worktree file) with pure fs — the emitter spawns nothing to
// find its own state home.
export function resolveRepoRoot({ cwd = process.cwd(), explicit = null } = {}) {
  if (explicit) return path.resolve(explicit);
  let current = path.resolve(cwd);
  try {
    current = fs.realpathSync(current);
  } catch {
    return null;
  }
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readTomlIfExists(filePath) {
  // ONLY a genuinely absent layer reads as empty (ENOENT; ENOTDIR = a parent
  // path component is a file). Any other failure (EACCES, EISDIR, EIO) is NOT
  // "absent" and fail-closes the whole load (Codex review MAJOR): treating an
  // unreadable HIGHER-precedence layer as missing would let a lower-precedence
  // layer flip the channel on against the operator's recorded intent.
  try {
    return { ok: true, text: fs.readFileSync(filePath, 'utf8') };
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { ok: true, text: '' };
    }
    return { ok: false, error: `${filePath}: ${error?.code ?? error?.message ?? 'unreadable'}` };
  }
}

// Effective notify config over repo → user → shipped default, validated per
// key by the OFFICIAL settings validators. The emitter validates EFFECTIVE
// values only — surfacing shadowed-invalid lower-precedence entries is the
// settings plan's per-target scan job.
export function loadNotifyConfig({ repoRoot, homeDir = os.homedir() } = {}) {
  const repoRead = readTomlIfExists(path.join(repoRoot, '.agentic-plugins', 'config.toml'));
  const userRead = readTomlIfExists(path.join(homeDir, '.agentic-plugins', 'config.toml'));
  const readErrors = [repoRead, userRead]
    .filter((layer) => !layer.ok)
    .map((layer) => `config layer unreadable (fail-closed): ${layer.error}`);
  if (readErrors.length > 0) return { ok: false, config: null, errors: readErrors };
  const repoConfig = parseRuntimeConfigToml(repoRead.text);
  const userConfig = parseRuntimeConfigToml(userRead.text);
  const errors = [];
  const effective = {};
  for (const key of CONFIG_KEY_FAMILIES.notify) {
    const value = repoConfig[key] ?? userConfig[key] ?? NOTIFY_KEY_DEFAULTS[key];
    if (value !== null) {
      try {
        validateConfigValue(key, value);
      } catch (error) {
        errors.push(error.message);
        continue;
      }
    }
    effective[key] = value;
  }
  if (errors.length > 0) return { ok: false, config: null, errors };
  const kinds = parseKindsFilter(effective.notify_kinds);
  if (!kinds.ok) return { ok: false, config: null, errors: kinds.errors };
  return {
    ok: true,
    errors: [],
    config: {
      channel: effective.notify_channel,
      quietHours: effective.notify_quiet_hours,
      quietHoursTz: effective.notify_quiet_hours_tz,
      dedupeTtlSeconds: Number.parseInt(effective.notify_dedupe_ttl_seconds, 10),
      urgentBypass: effective.notify_urgent_bypass_quiet_hours === 'true',
      kinds: kinds.kinds,
    },
  };
}

// ---------------------------------------------------------------------------
// Quiet hours (§2): HH:MM-HH:MM local-time window with explicit timezone,
// cross-midnight supported; urgent bypasses by default (configurable off).
// ---------------------------------------------------------------------------

function minutesOfDay(now, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    ...(timeZone ? { timeZone } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  let hour = 0;
  let minute = 0;
  for (const part of formatter.formatToParts(new Date(now))) {
    if (part.type === 'hour') hour = Number(part.value);
    else if (part.type === 'minute') minute = Number(part.value);
  }
  return hour * 60 + minute;
}

export function evaluateQuietHours({
  window = null,
  timeZone = null,
  urgency,
  urgentBypass,
  now = Date.now(),
} = {}) {
  if (!window) return { suppressed: false };
  const [startText, endText] = window.split('-');
  const [startHour, startMinute] = startText.split(':').map(Number);
  const [endHour, endMinute] = endText.split(':').map(Number);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  const current = minutesOfDay(now, timeZone);
  // [start, end): start inclusive, end exclusive. start > end wraps midnight;
  // start === end is an EMPTY window (never a 24h one — a zero-length spec
  // reading as "suppress everything" would be the surprising direction).
  const inWindow = start < end
    ? current >= start && current < end
    : start > end
      ? current >= start || current < end
      : false;
  const suppressed = inWindow && !(urgency === 'urgent' && urgentBypass);
  return { suppressed };
}

// ---------------------------------------------------------------------------
// Redaction (§1 pipeline stage 5)
// ---------------------------------------------------------------------------

function sanitizeText(value, cap) {
  return String(value)
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
}

export function redactEvent(event, { now = Date.now() } = {}) {
  const title = sanitizeText(event.title ?? '', REDACT_FIELD_CAPS.title);
  const body = sanitizeText(event.body ?? '', REDACT_FIELD_CAPS.body);
  const refs = {};
  if (event.refs && typeof event.refs === 'object' && !Array.isArray(event.refs)) {
    for (const key of REDACT_REF_KEYS) {
      if (typeof event.refs[key] === 'string') {
        refs[key] = sanitizeText(event.refs[key], REDACT_REF_VALUE_CAP);
      }
    }
  }
  const record = {
    ts: new Date(now).toISOString(),
    event_id: sanitizeText(event.event_id ?? '', REDACT_FIELD_CAPS.event_id),
    source: sanitizeText(event.source ?? '', REDACT_FIELD_CAPS.source),
    kind: sanitizeText(event.kind ?? '', REDACT_FIELD_CAPS.kind),
    urgency: sanitizeText(event.urgency ?? '', REDACT_FIELD_CAPS.urgency),
    title,
    body,
    refs,
  };
  return { title, body, record };
}

// ---------------------------------------------------------------------------
// Channel: file-log — NDJSON append with concurrency-safe bounded rotation
// ---------------------------------------------------------------------------

// Append one redacted record as one NDJSON line. Appends are lock-free
// single writes on an O_APPEND handle; only ROTATION takes an mkdir lock
// (atomic across processes). Concurrency posture, explicit:
//   - the rotate lock loser (or a stale-lock sweeper) CONCEDES rotation and
//     appends anyway — the log may briefly overshoot maxBytes by the losing
//     writers' lines until the next emit rotates (bounded overshoot, no
//     loss);
//   - an append racing the winner's rename lands in the rotated .1
//     generation via its already-open handle (kept data, not loss);
//   - exactly two generations exist (log.ndjson + log.ndjson.1) — rotation
//     replaces .1, so retention stays bounded at ~2×maxBytes.
export function appendFileLog({
  repoRoot,
  record,
  maxBytes = NOTIFY_LOG_MAX_BYTES,
  lockStaleMs = NOTIFY_LOG_ROTATE_LOCK_STALE_MS,
} = {}) {
  const dir = notifyStateDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, 'log.ndjson');
  const line = `${JSON.stringify(record)}\n`;
  maybeRotate({ logPath, incomingBytes: Buffer.byteLength(line), maxBytes, lockStaleMs });
  fs.appendFileSync(logPath, line);
  return { logPath };
}

function maybeRotate({ logPath, incomingBytes, maxBytes, lockStaleMs }) {
  let size = 0;
  try {
    size = fs.statSync(logPath).size;
  } catch {
    return; // no log yet — nothing to rotate
  }
  if (size === 0 || size + incomingBytes <= maxBytes) return;
  const lockDir = `${logPath}.rotate.lock`;
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
    // A concurrent rotator holds the lock. Sweep a stale one for the NEXT
    // caller, but never sweep-and-rotate in the same call — the same
    // concession rule as the §1 dedupe reclaim lock (sweeping and acting at
    // once is the double-rotate hole).
    let lockMtimeMs = null;
    try {
      lockMtimeMs = fs.statSync(lockDir).mtimeMs;
    } catch {
      lockMtimeMs = null; // vanished — holder finished; concede this round
    }
    if (lockMtimeMs !== null && Date.now() - lockMtimeMs >= lockStaleMs) {
      try {
        fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // Lost the sweep race — same concession either way.
      }
    }
    return;
  }
  try {
    // Size RE-CHECK inside the lock: a concurrent rotator may have already
    // rotated while we were observing.
    let recheckedSize = 0;
    try {
      recheckedSize = fs.statSync(logPath).size;
    } catch {
      return;
    }
    if (recheckedSize === 0 || recheckedSize + incomingBytes <= maxBytes) return;
    try {
      fs.rmSync(`${logPath}.1`, { force: true });
    } catch {
      // Best effort — rename below replaces it anyway on most platforms.
    }
    try {
      fs.renameSync(logPath, `${logPath}.1`);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  } finally {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // A leftover lock is swept as stale by a later caller.
    }
  }
}

// ---------------------------------------------------------------------------
// Channel: macos-osascript — fixed argv template, payload only as argv
// ---------------------------------------------------------------------------

function minimalSpawnEnv(env) {
  const spawnEnv = { PATH: '/usr/bin:/bin' };
  for (const key of SPAWN_ENV_ALLOWLIST) {
    if (typeof env[key] === 'string') spawnEnv[key] = env[key];
  }
  return spawnEnv;
}

function dispatchOsascript({ title, body, spawnImpl = null, env = process.env }) {
  const doSpawn = spawnImpl ?? spawn;
  // The FIXED AppleScript program: one single-line string literal per -e so
  // the ADR-0035 §4 executor registry pins the exact program byte-for-byte
  // (ARGV_VERB_ALLOWLIST['/usr/bin/osascript']); payload rides ONLY as the
  // two trailing argv items. Escaping payload into the -e expression would
  // still be code interpolation — the classic osascript trap — so the
  // program text below must never carry an interpolation.
  const child = doSpawn('/usr/bin/osascript', [
    '-e', 'on run argv',
    '-e', 'display notification (item 2 of argv) with title (item 1 of argv)',
    '-e', 'end run',
    title,
    body,
  ], {
    // Spawn contract (§2): no shell, fire-and-forget; a missing/slow/failing
    // binary never blocks or fails the calling hook (invariant 5 amendment).
    stdio: 'ignore',
    detached: true,
    env: minimalSpawnEnv(env),
  });
  if (child && typeof child.on === 'function') child.on('error', () => {});
  if (child && typeof child.unref === 'function') child.unref();
}

// ---------------------------------------------------------------------------
// The emit pipeline
// ---------------------------------------------------------------------------

// Runs the full emit flow and NEVER throws — every outcome is data:
//   { status: 'dispatched'|'suppressed'|'failed', stage, reason, channel }.
// The CLI wrapper turns 'failed' into the single stderr line; suppressed
// outcomes are fully silent by contract.
export function runEmit({
  eventText,
  repoRoot = null,
  cwd = process.cwd(),
  homeDir = os.homedir(),
  now = Date.now(),
  spawnImpl = null,
  env = process.env,
} = {}) {
  try {
    const root = resolveRepoRoot({ cwd, explicit: repoRoot });
    if (!root) {
      return { status: 'failed', stage: 'repo-root', reason: 'no repository root (.git) found', channel: null };
    }

    const loaded = loadNotifyConfig({ repoRoot: root, homeDir });
    if (!loaded.ok) {
      return { status: 'failed', stage: 'config', reason: loaded.errors.join('; '), channel: null };
    }
    const config = loaded.config;

    let event;
    try {
      event = JSON.parse(String(eventText ?? ''));
    } catch {
      return { status: 'failed', stage: 'parse', reason: 'event is not valid JSON', channel: config.channel };
    }

    // §1 pipeline stage 1 — validate (result-object validator; errors are data).
    const validated = validateEvent(event);
    if (!validated.ok) {
      return { status: 'failed', stage: 'validate', reason: validated.errors.join('; '), channel: config.channel };
    }
    // Pre-state cap, still stage 1 (Codex review MAJOR): the §1 order writes
    // event_id into the dedupe claim file BEFORE redaction runs, so the id is
    // capped here — a buggy producer must not park oversized subject material
    // in notify state ahead of the redaction stage.
    if (event.event_id.length > REDACT_FIELD_CAPS.event_id) {
      return {
        status: 'failed',
        stage: 'validate',
        reason: `event_id exceeds ${REDACT_FIELD_CAPS.event_id} chars`,
        channel: config.channel,
      };
    }

    // System gate — before the configured-system pipeline stages: the shipped
    // default notify_channel=none means "notifications off" (invariant 1
    // amendment: the action-specific gate is a CONFIG KEY). An off system
    // leaves NO notify state behind — in particular it must not burn a TTL
    // slot, or enabling a channel right after an event would wrongly
    // suppress that subject's first real notification.
    if (config.channel === 'none') {
      return { status: 'suppressed', stage: 'channel', reason: 'channel-none', channel: 'none' };
    }

    // §1 pipeline stage 2 — kinds filter (BEFORE dedupe by contract: a
    // disabled event never consumes a TTL slot).
    if (!kindEnabled(event.kind, config.kinds)) {
      return { status: 'suppressed', stage: 'kinds-filter', reason: 'kinds-filter', channel: config.channel };
    }

    // §1 pipeline stage 3 — dedupe claim (BEFORE quiet-hours by contract: a
    // quiet-hours-suppressed event burns its slot exactly once rather than
    // re-firing at window close).
    let claim;
    try {
      claim = claimDedupe({
        dedupeDir: notifyDedupeDir(root),
        eventId: event.event_id,
        ttlSeconds: config.dedupeTtlSeconds,
        now,
      });
    } catch (error) {
      return { status: 'failed', stage: 'dedupe', reason: error?.message ?? 'dedupe claim failed', channel: config.channel };
    }
    if (!claim.claimed) {
      return {
        status: 'suppressed',
        stage: 'dedupe',
        reason: `dedupe-${claim.reason ?? 'duplicate'}`,
        channel: config.channel,
      };
    }

    // §1 pipeline stage 4 — quiet hours.
    const quiet = evaluateQuietHours({
      window: config.quietHours,
      timeZone: config.quietHoursTz,
      urgency: event.urgency,
      urgentBypass: config.urgentBypass,
      now,
    });
    if (quiet.suppressed) {
      return { status: 'suppressed', stage: 'quiet-hours', reason: 'quiet-hours', channel: config.channel };
    }

    // §1 pipeline stage 5 — redact.
    const { title, body, record } = redactEvent(event, { now });

    // §1 pipeline stage 6 — dispatch (built-in allowlist channels only).
    try {
      if (config.channel === 'macos-osascript') {
        dispatchOsascript({ title, body, spawnImpl, env });
      } else if (config.channel === 'file-log') {
        appendFileLog({ repoRoot: root, record });
      }
    } catch (error) {
      return { status: 'failed', stage: 'dispatch', reason: error?.message ?? 'dispatch failed', channel: config.channel };
    }
    return { status: 'dispatched', stage: 'dispatch', reason: null, channel: config.channel };
  } catch (error) {
    // Absolute backstop — runEmit never throws (fail-closed contract).
    return { status: 'failed', stage: 'internal', reason: error?.message ?? 'unknown failure', channel: null };
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function truncateReason(reason) {
  const text = String(reason ?? 'unknown').replace(/\s+/g, ' ').trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function parseEmitArgs(argv) {
  const opts = { eventFile: null, repoRoot: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--event-file' || arg === '--repo-root') {
      const value = argv[i + 1];
      // A missing value must NOT silently fall back to stdin / cwd discovery
      // (Codex review MINOR): under hook invocation a malformed argv would
      // read the wrong input or write state under the wrong discovered repo.
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, reason: `${arg} requires a value` };
      }
      i += 1;
      if (arg === '--event-file') opts.eventFile = value;
      else opts.repoRoot = value;
    } else {
      return { ok: false, reason: `unknown argument ${arg}` };
    }
  }
  return { ok: true, opts };
}

async function readEventText({ eventFile }) {
  if (eventFile) return fs.readFileSync(eventFile, 'utf8');
  if (process.stdin.isTTY) {
    throw new Error('no --event-file given and stdin is a TTY');
  }
  // Async stream read — a synchronous readFileSync(0) EAGAINs on a
  // non-blocking stdin pipe (observed on macOS under execFile).
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(argv) {
  const [subcommand, ...rest] = argv;
  if (subcommand !== 'emit') {
    // Developer-facing misuse (wrong subcommand) is honest: usage + exit 1.
    // The fail-closed exit-0 contract belongs to the emit path below.
    process.stderr.write('usage: notify.mjs emit [--event-file <path>] [--repo-root <path>]\n');
    process.exitCode = 1;
    return;
  }
  // The emit path is fail-closed silent (invariant 8 amendment): exit 0
  // always, never stdout, at most ONE stderr diagnostic line; suppressed
  // outcomes are fully silent.
  try {
    const parsed = parseEmitArgs(rest);
    if (!parsed.ok) {
      process.stderr.write(`notify: emit failed at args: ${truncateReason(parsed.reason)}\n`);
    } else {
      let eventText = null;
      try {
        eventText = await readEventText({ eventFile: parsed.opts.eventFile });
      } catch (error) {
        process.stderr.write(`notify: emit failed at input: ${truncateReason(error?.message)}\n`);
      }
      if (eventText !== null) {
        const result = runEmit({ eventText, repoRoot: parsed.opts.repoRoot });
        if (result.status === 'failed') {
          process.stderr.write(`notify: emit failed at ${result.stage}: ${truncateReason(result.reason)}\n`);
        }
      }
    }
  } catch (error) {
    process.stderr.write(`notify: emit failed at internal: ${truncateReason(error?.message)}\n`);
  }
  process.exitCode = 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch(() => {
    // Absolute backstop — the emit path never exits non-zero.
    process.exitCode = 0;
  });
}
