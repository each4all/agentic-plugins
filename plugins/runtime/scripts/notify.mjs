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
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  claimDedupe,
  kindEnabled,
  notifyDedupeDir,
  notifyStateDir,
  parseKindsFilter,
  sweepExpiredClaims,
  validateEvent,
} from './lib/notify-schema.mjs';
import {
  CONFIG_KEY_FAMILIES,
  NOTIFY_KEY_DEFAULTS,
  loadEffectiveConfig,
} from './lib/runtime-config.mjs';
import {
  EGRESS_ENV_KEYS,
  loadEgressActivation,
  loadEgressHeadlineOptIn,
} from './lib/egress-config.mjs';
import {
  EGRESS_OUTCOMES,
  buildEgressMirrorRecord,
  egressConfigFingerprint,
  egressThrottleDir,
  finalizeEgressAttempt,
  shouldAttemptEgress,
  suppressThrottledEgress,
} from './lib/egress-semantics.mjs';
import {
  TELEGRAM_SERVICE,
  buildEgressPayload,
  buildTelegramSendBody,
  classifyTelegramError,
  classifyTelegramResult,
  mapActivationReasonToOutcome,
  renderEgressText,
  scrubSecrets,
  validateTelegramChatId,
  validateTelegramToken,
} from './lib/egress-channel.mjs';

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

// Effective notify config over repo → user → shipped default, validated per
// key by the OFFICIAL settings validators. The emitter validates EFFECTIVE
// values only — surfacing shadowed-invalid lower-precedence entries is the
// settings plan's per-target scan job. Layering, fail-closed unreadable-layer
// semantics, and per-key validation live in the shared lib/runtime-config.mjs
// core (one copy — the ADR-0044 session loader shares it); this wrapper adds
// only notify's own post-processing (kinds parse, type coercion).
export function loadNotifyConfig({ repoRoot, homeDir = os.homedir() } = {}) {
  const loaded = loadEffectiveConfig({
    repoRoot,
    homeDir,
    keys: CONFIG_KEY_FAMILIES.notify,
    defaults: NOTIFY_KEY_DEFAULTS,
  });
  if (!loaded.ok) return { ok: false, config: null, errors: loaded.errors };
  const effective = loaded.effective;
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
// Channel: telegram — ADR-0041 §2b/§2d/§2e E1 enumerated-metadata network egress
// ---------------------------------------------------------------------------

// Bounded timeout for the pinned request (§2e). Raised 5000→8000 to match the
// personal curl prototype's `-m 8` resilience: on the owner's IPv6-broken host a
// transient network blip can make even the reliable IPv4 path briefly slow, and
// the old 5s budget lost that race (live mirror showed intermittent egress
// timeouts). A slow/hung endpoint still aborts here and resolves to
// EGRESS_OUTCOMES.TIMEOUT — the fail-closed hook path is never wedged and never
// throws. NOTE: the attention sensor spawns this emitter under its OWN spawnSync
// timeout (sensor.mjs emitEvent `timeoutMs`), which MUST exceed this budget plus
// node/pipeline overhead or it would kill the dispatch before the deadline; the
// two are tuned together.
export const TELEGRAM_API_TIMEOUT_MS = 8000;

// Budget each NON-FINAL attempt holds back for the attempts after it (the IPv4
// retry and the default-family fallback), replacing the old even 1/familyCount
// split that starved the reliable IPv4 path. Small on purpose: IPv4 should get the
// bulk of the budget so a merely-SLOW IPv4 (a transient blip) still completes,
// while a FAST-failing IPv4 (genuinely unavailable, e.g. an IPv6-only host) returns
// before consuming this and — because the FINAL attempt gets ALL remaining budget —
// hands the fallback nearly the whole window anyway. See telegramAttemptTimeoutMs.
export const TELEGRAM_FALLBACK_RESERVE_MS = 2000;

// ADR-0041 §2d address-family attempt order: IPv4, IPv4-RETRY, then the default
// family. Owner-env diagnostic (getMe): explicit IPv4 is 100% reliable (~253ms)
// while the default family fast-fails on the broken IPv6 stack (undici's default
// selection likewise hung). So IPv4 is tried FIRST; because a transient blip can
// make a single IPv4 connect briefly fail or stall, a SECOND IPv4 attempt (the
// retry) precedes the default fallback; and the default family stays LAST for
// portability (IPv6-only / DNS64-NAT64 hosts, where IPv4 fast-fails and hands the
// final attempt the full remaining budget). The retry and the fallback fire ONLY
// while no POST body has been written (the loop's bodyWritten gate below): Telegram
// `sendMessage` has no idempotency key, so a written body is never re-sent.
const TELEGRAM_ADDRESS_FAMILIES = [4, 4, undefined];

// Defense-in-depth bound on the buffered response body. The endpoint is pinned to
// api.telegram.org (a small JSON `{ ok, result }`); the AbortSignal bounds read
// time, and this bounds memory if the pinned host ever returns an unbounded body.
const TELEGRAM_RESPONSE_READ_CAP = 65536;

// Per-attempt timeout for the §2d IPv4-preferred→retry→fallback dispatch. ONE
// shared `deadline` bounds the WHOLE dispatch to TELEGRAM_API_TIMEOUT_MS. A
// NON-FINAL attempt gets the remaining budget MINUS TELEGRAM_FALLBACK_RESERVE_MS
// rather than an even 1/familyCount share: the reliable IPv4 path is thereby given
// the bulk of the budget so a merely-SLOW IPv4 (a transient blip) still completes,
// while a FAST-failing IPv4 (genuinely unavailable, e.g. an IPv6-only host) returns
// quickly and — being followed by the FINAL default attempt, which gets ALL
// remaining budget — hands the fallback nearly the whole window. The final attempt
// always gets the full remaining budget. Pure + exported so the family/budget logic
// is unit-testable even though the surrounding node:https socket path is not
// (real-network smoke / release-dogfood). Returns 0 when the shared budget is spent
// OR the reserve already consumes the remainder for a non-final attempt — the
// dispatch loop then SKIPS that attempt (continue) rather than open a
// zero/negative-timeout socket, while a LATER family (the default fallback) still
// receives its own remaining budget, so a slow/black-holed IPv4 never starves it.
export function telegramAttemptTimeoutMs({ deadline, now, index, familyCount }) {
  const remaining = deadline - now;
  if (remaining <= 0) return 0;
  const isFinal = index >= familyCount - 1;
  return isFinal ? remaining : Math.max(0, remaining - TELEGRAM_FALLBACK_RESERVE_MS);
}

// The ONE pinned egress request (ADR-0041 §2b/§2d). The transport is an in-process
// `node:https` request — NOT `fetch` (undici silently failed to deliver on the
// owner's IPv6-broken host; §2d [decide-transport]) and NOT `curl` (no external-
// process egress; `curl` stays out of ALLOWED_COMMAND_LITERALS). The executor
// guard's pinned-https-gate (tests/plugin-shape/runtime-executor-scan.mjs) permits
// exactly one DIRECT `https.request(url, options)` in this file — url an inline
// literal pinned to https://api.telegram.org/bot<TOKEN>/sendMessage, method POST, a
// bounded AbortSignal.timeout, options carrying ONLY the allowlisted keys — and
// rejects every alias/member/computed/variable-URL form or a second call. The
// IPv4-preferred retry is a LOOP around this SINGLE call site (only the non-pinned
// `family` varies). The `fetchImpl` injection arm (test-only, ADR-0041 §2b — the
// pipeline's non-transport logic is unit-tested through it; the node:https-shape
// injection landed in the [acceptance-gate] subtask, and real-delivery proof is the
// [release-dogfood] subtask) uses a DISTINCT identifier that never matches a `fetch`
// token. The token is shape-validated (validateTelegramToken) before it reaches
// this interpolation, so it can contribute only URL-path-safe characters — no
// percent-encoding (which Telegram rejects on the ':' separator).
async function dispatchTelegramRequest({ token, body, fetchImpl = null }) {
  if (fetchImpl) {
    // ADR-0041 §2b/§2d test-injection seam: a double observes the (url, options) and
    // returns the { status, json } shape the real node:https path resolves to — so
    // the pipeline's NON-transport logic (payload/scrub/outcome-classification/claim/
    // throttle/mirror/leak-containment) is exercised deterministically. Reworked to
    // the node:https REQUEST-LEVEL shape ([acceptance-gate] subtask): method POST, a
    // bounded AbortSignal, and the content-type + content-length headers, with the
    // body carried alongside for observation. No fetch `redirect` key — node:https
    // never follows redirects, so egress-bounding is STRUCTURAL (the executor guard's
    // maxCalls:1 single call site; a Location would need a forbidden second request).
    // This seam deliberately does NOT — and structurally CANNOT — reproduce the real
    // transport BEHAVIOR just below (the IPv4-preferred family fallback, the
    // secureConnect body-write timing, the no-retry-after-write idempotency): the
    // guard forbids aliasing that single pinned call site, which is what an injection
    // would require. That behavior is covered instead by the exported
    // `telegramAttemptTimeoutMs` budget unit test, the (K) opt-in real-network smoke,
    // and the [release-dogfood] subtask. The token is shape-validated before it
    // interpolates into the URL (same as the real path below).
    return fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      body,
    });
  }
  // Real transport: node:https, IPv4-preferred with an IPv4 retry then a bounded
  // default-family fallback (§2d). ONE shared deadline bounds the WHOLE dispatch to
  // TELEGRAM_API_TIMEOUT_MS; each non-final attempt reserves budget for the ones
  // after it (telegramAttemptTimeoutMs) so the reliable IPv4 path gets the bulk of
  // the window — a slow IPv4 still completes — yet a fast IPv4 failure returns the
  // budget to the fallback. The body is
  // buffered and the Promise resolves on 'end' with { status, json } — the exact
  // fetch Response fields the caller reads (response.status, response.json()). A
  // body-read failure (incl. the bounded signal aborting mid-body — which surfaces
  // on `res` as a connection reset, not a TimeoutError) rejects and is classified by
  // the caller as a failure outcome; TIMEOUT / provider-error all share the
  // release+throttle disposition, so the exact label is non-load-bearing.
  const deadline = Date.now() + TELEGRAM_API_TIMEOUT_MS;
  const familyCount = TELEGRAM_ADDRESS_FAMILIES.length;
  let lastError = null;
  for (let familyIndex = 0; familyIndex < familyCount; familyIndex += 1) {
    const family = TELEGRAM_ADDRESS_FAMILIES[familyIndex];
    const attemptTimeout = telegramAttemptTimeoutMs({
      deadline, now: Date.now(), index: familyIndex, familyCount,
    });
    // This family's slice is spent (its own budget, or the reserve zeroed a
    // non-final attempt). SKIP it but keep going: a SLOW/black-holed IPv4 must not
    // starve the default-family fallback by way of the intervening IPv4-retry's
    // zeroed reserve (the [4, 4, undefined] retry sits between IPv4 and the
    // fallback, so a `break` here would drop the fallback the [4, undefined] form
    // always reached). The FINAL attempt's budget is the full `remaining`, so the
    // shared deadline is still never exceeded.
    if (attemptTimeout <= 0) continue;
    let bodyWritten = false;
    try {
      return await new Promise((resolve, reject) => {
        const req = https.request(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          family,
          signal: AbortSignal.timeout(attemptTimeout),
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        }, (res) => {
          // Buffer the (small, capped) JSON body; resolve on 'end' with the two
          // fields the caller reads. A stalled/aborted body read rejects via res
          // 'error' (bounded by the signal) — the Promise settles definitively, so
          // the process never lingers on a half-read response.
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { if (data.length < TELEGRAM_RESPONSE_READ_CAP) data += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, json: async () => JSON.parse(data) }));
          res.on('error', reject);
        });
        req.on('error', reject);
        // ADR-0041 §2d idempotency: write the POST body ONLY once the socket has
        // securely connected, so a pre-connect failure (a dead-family SYN hang,
        // aborted by the bounded signal) falls back to the next family with NO body
        // written. After a write, an error is surfaced (bodyWritten short-circuits
        // the retry below) and the body is never re-sent (no idempotency key).
        req.on('socket', (socket) => {
          const flush = () => { bodyWritten = true; req.end(body); };
          if (socket.connecting) socket.once('secureConnect', flush);
          else flush();
        });
      });
    } catch (error) {
      lastError = error;
      if (bodyWritten) throw error; // the body reached the wire — never retry
      // otherwise fall through and try the next address family
    }
  }
  throw lastError;
}

// Orchestrate ONE egress attempt around the pinned request, consuming
// egress-semantics' claim-finalization + failure throttle + attempt-mirror
// (ADR-0041 §6/§7) and egress-channel's payload/scrub/validation helpers.
// Reached ONLY when E1 is ENGAGED (loadEgressActivation.reason !==
// 'missing-activation') — the operator explicitly opted into egress via env or
// the verified-ignored-local layer, overriding the local channel for this emit
// (§2c egress-override rule). Owns the pipeline's pre-claim (finalize
// promote/release on the same event_id, so a local channel does not also run —
// the mirror gives file-log visibility). NEVER throws: every path resolves to a
// data result and the bounded await catches all rejections (§2e).
async function runEgressDispatch({
  root, event, egress, ownerToken, quietSuppressed, env, now, fetchImpl, homeDir,
}) {
  // `service` is the coerced, non-empty label for the throttle key + mirror (both
  // require a non-empty service). v1 has exactly one egress service, so an
  // engaged-but-unknown-channel misconfig still labels under 'telegram'.
  const service = egress.channel || TELEGRAM_SERVICE;
  const dedupeDir = notifyDedupeDir(root);
  const throttleDir = egressThrottleDir(root);
  const eventId = event.event_id;
  // The credential is read from the operator environment ONLY (never a file,
  // never the activation descriptor). It is folded one-way into the throttle
  // fingerprint (so a fixed/changed token auto-bypasses any cooldown) and passed
  // to the pinned request; it is never logged, mirrored, or returned.
  const rawToken = typeof env[EGRESS_ENV_KEYS.credential] === 'string'
    ? env[EGRESS_ENV_KEYS.credential].trim()
    : '';
  // The fingerprint uses the RAW enum-safe channel (egress.channel — '' for a
  // misconfig, 'telegram' when active), NOT the coerced `service`: §7's config-fix
  // bypass requires that fixing the channel key (unknown → telegram) changes the
  // fingerprint so the cooldown is bypassed. Coercing to 'telegram' here would
  // leave the channel component constant across the fix and strand the retry.
  const fingerprint = egressConfigFingerprint({
    channel: egress.channel ?? '',
    recipient: egress.recipient ?? '',
    token: rawToken,
  });

  // ADR-0041 §3a — resolve the SEPARATE headline opt-in ONCE (env or user-home
  // verified-ignored-local; default OFF; tracked config can never enable it). This
  // runs only here, so opt-in-alone (opt-in set but egress NOT engaged) never
  // reaches it — the structural "opt-in-alone inert" guarantee. Threaded into BOTH
  // the payload and the mirror so the two agree (parity).
  const headlineOptIn = loadEgressHeadlineOptIn({ repoRoot: root, homeDir, env });

  // finalize (promote/release the owned claim + record/clear throttle) then
  // mirror a single sanitized attempt row (§6). The mirror is best-effort — a
  // mirror-write failure must never fail the fail-closed emit path.
  const finalizeAndMirror = (outcome) => {
    const result = finalizeEgressAttempt({
      dedupeDir, throttleDir, eventId, ownerToken, outcome, service, fingerprint, now,
    });
    try {
      // §2b/§5 — the attempt-mirror is an EGRESS artifact: a token-shaped value
      // in an event field (a credential-URL topic, an sk-/AKIA event_id) must
      // never persist RAW into the file-log. buildEgressMirrorRecord scrubs each
      // event-derived field BEFORE its cap (scrub injected here), so a secret the
      // cap would otherwise truncate — losing its `@`/marker before the scrub saw
      // it — is redacted while still intact (peer CRITICAL: the scrub was
      // previously applied AFTER the cap). The egress_* control fields are short
      // enums that carry no secret; ts is an ISO timestamp.
      const record = buildEgressMirrorRecord({
        event, service, egressStatus: result.egressStatus, outcome, now, scrub: scrubSecrets, headlineOptIn,
      });
      appendFileLog({ repoRoot: root, record });
    } catch {
      // best-effort attempt visibility; never fail the emit path on a mirror write
    }
    return { status: result.egressStatus, stage: 'egress', reason: `egress-${outcome}`, channel: service };
  };

  // Config/credential errors are checked BEFORE quiet hours (peer MAJOR). A
  // mirror row is a file-log record, not a phone notification, so surfacing a
  // config error during quiet hours adds no notification noise — whereas letting
  // quiet-hours preempt it would PROMOTE the claim (burning the TTL) and mask the
  // error until the window closes, stranding the post-fix retry within the TTL.
  // These paths RELEASE the claim so a fixed config re-fires immediately.

  // Engaged but not active (missing token/recipient, unknown channel, credential
  // collision): release the claim, record the failure throttle, mirror.
  if (!egress.active) return finalizeAndMirror(mapActivationReasonToOutcome(egress.reason));

  // Active but a shape-invalid credential/recipient — never interpolate a
  // malformed token into the request path (§2b); treat as invalid activation.
  if (!validateTelegramToken(rawToken) || !validateTelegramChatId(egress.recipient)) {
    return finalizeAndMirror(EGRESS_OUTCOMES.INVALID_LOCAL_ACTIVATION);
  }

  // Quiet hours (§7 QUIET_HOURS): reached only for a WOULD-SEND (active + valid)
  // egress — an intentional suppression that still burns the slot (promote), no
  // throttle, mirror the suppression.
  if (quietSuppressed) return finalizeAndMirror(EGRESS_OUTCOMES.QUIET_HOURS);

  // Failure-throttle gate (§7): a persistently-failing provider must not
  // re-dispatch on every repeated event. When throttled, release the owned
  // pre-claim (so the post-cooldown retry is not itself deduped) and write NO
  // mirror row — the dashboard surfaces active throttles separately.
  const gate = shouldAttemptEgress({ throttleDir, eventId, service, fingerprint, now });
  if (!gate.attempt) {
    suppressThrottledEgress({ dedupeDir, eventId, ownerToken, now });
    return { status: 'suppressed', stage: 'egress', reason: 'egress-throttled', channel: service };
  }

  // Build the enumerated §3 payload → plain text → §5 scrub → fixed body.
  const payload = buildEgressPayload(event, { headlineOptIn });
  const text = scrubSecrets(renderEgressText(payload));
  const send = buildTelegramSendBody({ chatId: egress.recipient, text });
  if (!send.ok) return finalizeAndMirror(send.outcome); // BODY_CAP

  // The one bounded request (§2e). All rejections are caught and classified — a
  // slow, failing, or redirecting endpoint degrades to a recorded outcome, never
  // a throw. Only response.status (a number) and the Telegram `ok` boolean are
  // read — never the raw response text (§3: raw response text is never egressed
  // or mirrored).
  let outcome;
  try {
    const response = await dispatchTelegramRequest({ token: rawToken, body: send.body, fetchImpl });
    const httpOk = Boolean(response) && typeof response.status === 'number'
      && response.status >= 200 && response.status < 300;
    let telegramOk = false;
    if (httpOk && response && typeof response.json === 'function') {
      try {
        const parsed = await response.json();
        telegramOk = parsed?.ok === true;
      } catch (jsonError) {
        // A body read aborted by AbortSignal.timeout is a TIMEOUT, not a
        // provider rejection (peer MINOR) — rethrow so the outer catch classifies
        // it. A genuine parse failure (unparseable 2xx body) stays provider-
        // rejected.
        if (jsonError?.name === 'AbortError' || jsonError?.name === 'TimeoutError') throw jsonError;
        telegramOk = false;
      }
    }
    outcome = classifyTelegramResult({ httpOk, telegramOk });
  } catch (error) {
    outcome = classifyTelegramError(error);
  }
  return finalizeAndMirror(outcome);
}

// ---------------------------------------------------------------------------
// The emit pipeline
// ---------------------------------------------------------------------------

// Runs the full emit flow and NEVER throws — every outcome is data:
//   { status: 'dispatched'|'suppressed'|'failed', stage, reason, channel }.
// The CLI wrapper turns 'failed' into the single stderr line; suppressed
// outcomes are fully silent by contract.
export async function runEmit({
  eventText,
  repoRoot = null,
  cwd = process.cwd(),
  homeDir = os.homedir(),
  now = Date.now(),
  spawnImpl = null,
  fetchImpl = null,
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

    // ADR-0041 §2c — E1 egress activation is resolved by a SEPARATE loader from
    // the operator environment or a fail-closed-verified ignored-local layer,
    // NEVER from the tracked notify_channel config. When ENGAGED it OVERRIDES the
    // effective channel to the egress service (the "explicit egress-override
    // rule"), so a default notify_channel=none does not suppress it and tracked
    // config can never activate it. `engaged` (reason !== 'missing-activation')
    // means the operator opted in — even a misconfigured opt-in takes the egress
    // path so the failure is mirrored + throttled rather than silently dropped.
    const egress = loadEgressActivation({ repoRoot: root, homeDir, env });
    const egressEngaged = egress.reason !== 'missing-activation';
    const effectiveChannel = egressEngaged ? (egress.channel || TELEGRAM_SERVICE) : config.channel;

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
    // suppress that subject's first real notification. The EFFECTIVE channel is
    // gated (not config.channel): an engaged E1 egress override lifts the
    // none-default so egress fires even when the local channel is off (§2c).
    if (effectiveChannel === 'none') {
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

    // ADR-0047 §6 — ONE bounded, fair, best-effort expired-claim sweep per
    // emit that reaches the dedupe stage. Placement is contractual: after the
    // effective-channel gate (an off system touches no notify state) and the
    // kinds filter (a filtered event does no maintenance), after the current
    // event's own claimDedupe, and regardless of the claim outcome — claimed
    // and deduped emits both do maintenance. The current event's claim path
    // is excluded, and the call is fenced so janitorial failure can never
    // change this emit's outcome (computed from `claim` alone below).
    try {
      sweepExpiredClaims({
        dedupeDir: notifyDedupeDir(root),
        ttlSeconds: config.dedupeTtlSeconds,
        now,
        excludeClaimPath: claim.claimPath,
      });
    } catch {
      // sweepExpiredClaims never throws by contract; this fence is the
      // belt-and-suspenders form of the same containment rule.
    }

    if (!claim.claimed) {
      return {
        status: 'suppressed',
        stage: 'dedupe',
        reason: `dedupe-${claim.reason ?? 'duplicate'}`,
        channel: config.channel,
      };
    }

    // §1 pipeline stage 4 — quiet hours. Computed WITHOUT early-returning: the
    // egress path records quiet-hours as an outcome (promote claim + mirror)
    // rather than a bare suppression, so evaluate first, branch below.
    const quiet = evaluateQuietHours({
      window: config.quietHours,
      timeZone: config.quietHoursTz,
      urgency: event.urgency,
      urgentBypass: config.urgentBypass,
      now,
    });

    // ADR-0041 §2c/§6/§7 — E1 egress override. When engaged, egress OWNS the
    // stage-3 pre-claim (finalize promote/release on this event_id) and records
    // its own outcome (including quiet-hours) + attempt-mirror; the local channel
    // does NOT also run. `claim.ownerToken` exists here because a non-claimed
    // outcome already returned at stage 3.
    if (effectiveChannel === TELEGRAM_SERVICE) {
      return await runEgressDispatch({
        root,
        event,
        egress,
        ownerToken: claim.ownerToken,
        quietSuppressed: quiet.suppressed,
        env,
        now,
        fetchImpl,
        homeDir,
      });
    }

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
        const result = await runEmit({ eventText, repoRoot: parsed.opts.repoRoot });
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
