// Tests for the ADR-0040 §2 runtime notification emitter (notify.mjs emit).
//
// Covers: effective-config resolution over the OFFICIAL settings notify_*
// keys (repo → user → shipped default, per-key validators, fail-closed on
// invalid effective values), the §1 pipeline order (validate → kinds-filter
// → dedupe → quiet-hours → redact → dispatch) including the state
// consequences the order implies (a kinds-disabled event never burns a TTL
// slot; a quiet-hours-suppressed event does), quiet-hours evaluation with
// explicit timezone / cross-midnight / urgent bypass, redaction (field
// allowlist + per-field caps + control-char strip), the built-in channels
// (none no-op, macos-osascript fixed-argv spawn contract, file-log NDJSON
// append with concurrency-safe bounded rotation), and the fail-closed CLI
// contract (exit 0 always on the emit path, never stdout, ≤1 stderr line) —
// the ADR-0040 §2 narrow ADR-0035 §3 amendment semantics (invariants 1/5/8).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REDACT_FIELD_CAPS,
  REDACT_REF_KEYS,
  REDACT_REF_VALUE_CAP,
  appendFileLog,
  evaluateQuietHours,
  loadNotifyConfig,
  redactEvent,
  resolveRepoRoot,
  runEmit,
  TELEGRAM_API_TIMEOUT_MS,
  telegramAttemptTimeoutMs,
} from '../../plugins/runtime/scripts/notify.mjs';
import { NOTIFY_KEY_DEFAULTS } from '../../plugins/runtime/scripts/lib/runtime-config.mjs';
import { notifyDedupeDir, notifyStateDir } from '../../plugins/runtime/scripts/lib/notify-schema.mjs';
import { egressThrottleDir } from '../../plugins/runtime/scripts/lib/egress-semantics.mjs';

const NOTIFY_CLI = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../plugins/runtime/scripts/notify.mjs',
);

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A minimal repo fixture: a .git dir (resolveRepoRoot walk-up marker) plus
// an optional .agentic-plugins/config.toml.
function makeRepo({ configLines = null } = {}) {
  const root = makeTempDir('notify-repo-');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  if (configLines !== null) {
    fs.mkdirSync(path.join(root, '.agentic-plugins'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agentic-plugins', 'config.toml'), `${configLines.join('\n')}\n`);
  }
  return root;
}

function makeHome({ configLines = null } = {}) {
  const home = makeTempDir('notify-home-');
  if (configLines !== null) {
    fs.mkdirSync(path.join(home, '.agentic-plugins'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agentic-plugins', 'config.toml'), `${configLines.join('\n')}\n`);
  }
  return home;
}

function makeEvent(overrides = {}) {
  return {
    event_id: 'repo-abc123:approval:session:s1:aaaa:fired',
    source: 'attention-claude',
    kind: 'approval',
    title: 'Approval needed',
    body: 'Session s1 is waiting on a permission prompt',
    urgency: 'urgent',
    refs: { workflow_id: 'wf-1' },
    ...overrides,
  };
}

function emitArgs({ repoRoot, home, event = makeEvent(), overrides = {} }) {
  return {
    eventText: JSON.stringify(event),
    repoRoot,
    homeDir: home ?? makeHome(),
    now: Date.UTC(2026, 0, 15, 12, 0, 0),
    ...overrides,
  };
}

function readLog(repoRoot) {
  const logPath = path.join(notifyStateDir(repoRoot), 'log.ndjson');
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function dedupeClaimCount(repoRoot) {
  const dir = notifyDedupeDir(repoRoot);
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((name) => name.endsWith('.claim')).length;
}

function fakeSpawn(calls) {
  return (cmd, args, opts) => {
    const child = {
      unrefed: false,
      handlers: {},
      on(eventName, handler) { this.handlers[eventName] = handler; return this; },
      unref() { this.unrefed = true; },
    };
    calls.push({ cmd, args, opts, child });
    return child;
  };
}

// ---------------------------------------------------------------------------
// ADR-0041 E1 egress fixtures (a fake token — no real/token-shaped value ever
// reaches a real endpoint, log, mirror, or artifact per §2b)
// ---------------------------------------------------------------------------

const FAKE_TELEGRAM_TOKEN = '123456789:AAA_bbbCCCdddEEEfffGGGhhhIIIjjjKKK';
const FAKE_CHAT_ID = '-1001234567890';

// The operator-environment activation triple (§2c): explicit channel key +
// recipient + credential, all from env (never tracked config).
function egressEnv(overrides = {}) {
  return {
    AGENTIC_NOTIFY_EGRESS_CHANNEL: 'telegram',
    TELEGRAM_CHAT_ID: FAKE_CHAT_ID,
    TELEGRAM_BOT_TOKEN: FAKE_TELEGRAM_TOKEN,
    ...overrides,
  };
}

// A fetchImpl double (the ADR-0041 §2b injection seam, mirroring the spawnImpl
// precedent). Records every (url, init) it receives and returns/throws a
// configurable outcome. `respond` maps a call to { status, ok } (Telegram body
// ok) or an Error to throw (timeout / redirect / network).
function fakeFetch(calls, respond = () => ({ status: 200, ok: true })) {
  return async (url, init) => {
    calls.push({ url, init });
    const r = respond(calls.length);
    if (r instanceof Error) throw r; // a fetch-level rejection (timeout / redirect / network)
    return {
      status: r.status,
      // r.jsonError lets a test simulate a body-read failure (abort mid-read, or
      // an unparseable 2xx body).
      json: async () => { if (r.jsonError) throw r.jsonError; return { ok: r.ok }; },
    };
  };
}

function abortError() {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

function throttleCount(repoRoot) {
  const dir = egressThrottleDir(repoRoot);
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((name) => name.endsWith('.throttle')).length;
}

function timeoutError() {
  const e = new Error('The operation was aborted due to timeout');
  e.name = 'TimeoutError';
  return e;
}

function redirectError() {
  const e = new TypeError('fetch failed: redirect count exceeded');
  return e;
}

// ---------------------------------------------------------------------------
// resolveRepoRoot
// ---------------------------------------------------------------------------

describe('notify resolveRepoRoot', () => {
  it('prefers the explicit root over cwd discovery', () => {
    const root = makeRepo();
    const other = makeRepo();
    assert.equal(resolveRepoRoot({ cwd: other, explicit: root }), path.resolve(root));
  });

  it('walks up from cwd to the nearest .git marker', () => {
    const root = makeRepo();
    const nested = path.join(root, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(resolveRepoRoot({ cwd: nested }), fs.realpathSync(root));
  });

  it('returns null when no repo marker exists upward', () => {
    const loose = makeTempDir('notify-noroot-');
    assert.equal(resolveRepoRoot({ cwd: loose }), null);
  });
});

// ---------------------------------------------------------------------------
// Config resolution (OFFICIAL settings notify_* keys — no private parsing)
// ---------------------------------------------------------------------------

describe('notify config resolution', () => {
  it('resolves shipped defaults when nothing is configured', () => {
    const result = loadNotifyConfig({ repoRoot: makeRepo(), homeDir: makeHome() });
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.config.channel, 'none');
    assert.equal(result.config.quietHours, null);
    assert.equal(result.config.quietHoursTz, null);
    assert.equal(result.config.dedupeTtlSeconds, 300);
    assert.equal(result.config.urgentBypass, true);
    assert.equal(result.config.kinds, null);
  });

  it('repo config shadows user config; user config applies when repo is unset', () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "file-log"'] });
    const home = makeHome({ configLines: [
      'notify_channel = "macos-osascript"',
      'notify_dedupe_ttl_seconds = "60"',
    ] });
    const result = loadNotifyConfig({ repoRoot, homeDir: home });
    assert.equal(result.ok, true);
    assert.equal(result.config.channel, 'file-log');
    assert.equal(result.config.dedupeTtlSeconds, 60);
  });

  it('fail-closes on an invalid EFFECTIVE value', () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "carrier-pigeon"'] });
    const result = loadNotifyConfig({ repoRoot, homeDir: makeHome() });
    assert.equal(result.ok, false);
    assert.equal(result.config, null);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /notify_channel/);
  });

  it('ignores an invalid value that is shadowed by a valid higher-precedence one', () => {
    // The emitter validates EFFECTIVE values only; surfacing shadowed-invalid
    // entries is settings' per-target scan job (ADR-0040 §2 settings slice).
    const repoRoot = makeRepo({ configLines: ['notify_channel = "file-log"'] });
    const home = makeHome({ configLines: ['notify_channel = "bogus"'] });
    const result = loadNotifyConfig({ repoRoot, homeDir: home });
    assert.equal(result.ok, true);
    assert.equal(result.config.channel, 'file-log');
  });

  it('parses notify_kinds through the §1 contract parser into a Set', () => {
    const repoRoot = makeRepo({ configLines: ['notify_kinds = "approval, peer-run-terminal"'] });
    const result = loadNotifyConfig({ repoRoot, homeDir: makeHome() });
    assert.equal(result.ok, true);
    assert.ok(result.config.kinds instanceof Set);
    assert.deepEqual([...result.config.kinds].sort(), ['approval', 'peer-run-terminal']);
  });

  it('fail-closes on an invalid ttl / boolean / quiet-hours shape', () => {
    for (const line of [
      'notify_dedupe_ttl_seconds = "0"',
      'notify_urgent_bypass_quiet_hours = "yes"',
      'notify_quiet_hours = "25:00-08:00"',
    ]) {
      const result = loadNotifyConfig({ repoRoot: makeRepo({ configLines: [line] }), homeDir: makeHome() });
      assert.equal(result.ok, false, `expected fail-closed for: ${line}`);
    }
  });

  it('an UNREADABLE higher-precedence layer fail-closes instead of falling through (Codex review MAJOR)', async () => {
    // repo config.toml is a DIRECTORY → EISDIR (not ENOENT). Falling through
    // would let the user layer flip the channel on against repo intent.
    const repoRoot = makeRepo();
    fs.mkdirSync(path.join(repoRoot, '.agentic-plugins', 'config.toml'), { recursive: true });
    const home = makeHome({ configLines: ['notify_channel = "macos-osascript"'] });
    const result = loadNotifyConfig({ repoRoot, homeDir: home });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /unreadable \(fail-closed\)/);
    // And through the pipeline: no spawn ever happens.
    const calls = [];
    const emitted = await runEmit(emitArgs({ repoRoot, home, overrides: { spawnImpl: fakeSpawn(calls) } }));
    assert.deepEqual({ status: emitted.status, stage: emitted.stage }, { status: 'failed', stage: 'config' });
    assert.equal(calls.length, 0);
  });

  it('a genuinely absent layer (ENOENT) still reads as empty, not an error', () => {
    const result = loadNotifyConfig({ repoRoot: makeRepo(), homeDir: makeHome() });
    assert.equal(result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// Quiet hours
// ---------------------------------------------------------------------------

describe('notify quiet-hours evaluation', () => {
  const NOON_UTC = Date.UTC(2026, 0, 15, 12, 0, 0);

  it('never suppresses without a configured window', () => {
    assert.equal(
      evaluateQuietHours({ window: null, timeZone: 'UTC', urgency: 'normal', urgentBypass: true, now: NOON_UTC }).suppressed,
      false,
    );
  });

  it('suppresses inside a same-day window; start inclusive, end exclusive', () => {
    const opts = { window: '09:00-17:00', timeZone: 'UTC', urgency: 'normal', urgentBypass: true };
    assert.equal(evaluateQuietHours({ ...opts, now: NOON_UTC }).suppressed, true);
    assert.equal(evaluateQuietHours({ ...opts, now: Date.UTC(2026, 0, 15, 9, 0, 0) }).suppressed, true);
    assert.equal(evaluateQuietHours({ ...opts, now: Date.UTC(2026, 0, 15, 17, 0, 0) }).suppressed, false);
    assert.equal(evaluateQuietHours({ ...opts, now: Date.UTC(2026, 0, 15, 8, 59, 0) }).suppressed, false);
  });

  it('supports a cross-midnight window', () => {
    const opts = { window: '22:00-08:00', timeZone: 'UTC', urgency: 'normal', urgentBypass: true };
    assert.equal(evaluateQuietHours({ ...opts, now: Date.UTC(2026, 0, 15, 23, 30, 0) }).suppressed, true);
    assert.equal(evaluateQuietHours({ ...opts, now: Date.UTC(2026, 0, 15, 7, 59, 0) }).suppressed, true);
    assert.equal(evaluateQuietHours({ ...opts, now: Date.UTC(2026, 0, 15, 8, 0, 0) }).suppressed, false);
    assert.equal(evaluateQuietHours({ ...opts, now: NOON_UTC }).suppressed, false);
  });

  it('evaluates the window in the configured timezone', () => {
    // UTC 15:00 = Asia/Seoul 00:00 next day — inside 22:00-08:00 in Seoul,
    // outside it in UTC.
    const now = Date.UTC(2026, 0, 15, 15, 0, 0);
    const base = { window: '22:00-08:00', urgency: 'normal', urgentBypass: true, now };
    assert.equal(evaluateQuietHours({ ...base, timeZone: 'Asia/Seoul' }).suppressed, true);
    assert.equal(evaluateQuietHours({ ...base, timeZone: 'UTC' }).suppressed, false);
  });

  it('urgent bypasses quiet hours by default; bypass=false suppresses urgent too', () => {
    const opts = { window: '09:00-17:00', timeZone: 'UTC', now: NOON_UTC };
    assert.equal(evaluateQuietHours({ ...opts, urgency: 'urgent', urgentBypass: true }).suppressed, false);
    assert.equal(evaluateQuietHours({ ...opts, urgency: 'urgent', urgentBypass: false }).suppressed, true);
    assert.equal(evaluateQuietHours({ ...opts, urgency: 'normal', urgentBypass: true }).suppressed, true);
  });

  it('treats start==end as an empty window (no suppression), never a 24h one', () => {
    assert.equal(
      evaluateQuietHours({ window: '09:00-09:00', timeZone: 'UTC', urgency: 'normal', urgentBypass: true, now: NOON_UTC }).suppressed,
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe('notify redaction', () => {
  const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

  it('keeps only allowlisted fields and allowlisted refs keys', () => {
    const { record } = redactEvent(makeEvent({
      secret_token: 'hunter2',
      refs: { workflow_id: 'wf-1', run_id: 'run-1', path: '/tmp/x', session_cookie: 'nope' },
    }), { now: NOW });
    assert.deepEqual(
      Object.keys(record).sort(),
      ['body', 'event_id', 'kind', 'refs', 'source', 'title', 'ts', 'urgency'],
    );
    assert.equal(record.secret_token, undefined);
    assert.deepEqual(Object.keys(record.refs).sort(), ['path', 'run_id', 'workflow_id']);
  });

  it('carries ts/urgency and the identity fields', () => {
    const { record } = redactEvent(makeEvent(), { now: NOW });
    assert.equal(record.ts, new Date(NOW).toISOString());
    assert.equal(record.urgency, 'urgent');
    assert.equal(record.kind, 'approval');
    assert.equal(record.event_id, 'repo-abc123:approval:session:s1:aaaa:fired');
  });

  it('caps every field to its per-field length', () => {
    const { title, body, record } = redactEvent(makeEvent({
      title: 'T'.repeat(REDACT_FIELD_CAPS.title + 50),
      body: 'B'.repeat(REDACT_FIELD_CAPS.body + 50),
      refs: { workflow_id: 'W'.repeat(REDACT_REF_VALUE_CAP + 50) },
    }), { now: NOW });
    assert.equal(title.length, REDACT_FIELD_CAPS.title);
    assert.equal(body.length, REDACT_FIELD_CAPS.body);
    assert.equal(record.refs.workflow_id.length, REDACT_REF_VALUE_CAP);
  });

  it('strips control characters into single spaces (payload is data, never format material)', () => {
    const { title, body } = redactEvent(makeEvent({
      title: 'line1\nline2\ttab\u0007bell',
      body: 'a\r\nb\u009Cc',
    }), { now: NOW });
    assert.equal(title, 'line1 line2 tab bell');
    assert.equal(body, 'a b c');
  });

  it('renders a missing body as an empty string', () => {
    const { body } = redactEvent(makeEvent({ body: undefined }), { now: NOW });
    assert.equal(body, '');
  });
});

// ---------------------------------------------------------------------------
// runEmit pipeline — file-log channel (observable end to end)
// ---------------------------------------------------------------------------

describe('notify runEmit pipeline (file-log)', () => {
  it('dispatches: appends one redacted NDJSON record and burns one TTL slot', async () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "file-log"'] });
    const result = await runEmit(emitArgs({ repoRoot }));
    assert.deepEqual(
      { status: result.status, channel: result.channel },
      { status: 'dispatched', channel: 'file-log' },
    );
    const records = readLog(repoRoot);
    assert.equal(records.length, 1);
    assert.equal(records[0].event_id, makeEvent().event_id);
    assert.equal(records[0].title, 'Approval needed');
    assert.equal(dedupeClaimCount(repoRoot), 1);
  });

  it('ADR-0041 §4 — an event carrying the OPTIONAL routing fields validates + dispatches (forward-compat)', async () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "file-log"'] });
    const event = makeEvent({
      // A host-woven event_id (the shape the attention sensor now emits) plus
      // the top-level routing fields. Nothing in the emitter pipeline rejects
      // the extra keys.
      event_id: 'repo-abc123:approval:host-mba:session:s1:aaaa:fired',
      hostname: 'mba',
      topic: 'repo:main',
      session_hint: 'abc123def456',
    });
    const result = await runEmit(emitArgs({ repoRoot, event }));
    assert.equal(result.status, 'dispatched');
    const records = readLog(repoRoot);
    assert.equal(records.length, 1);
    assert.equal(records[0].event_id, event.event_id);
    // The LOCAL file-log record keeps the ADR-0040 allowlist only — routing
    // fields are the egress channel's concern (buildEgressPayload, a later
    // slice), never a local render field, so they stay out of the record.
    assert.ok(!('hostname' in records[0]), 'hostname must not leak into the local record');
    assert.ok(!('topic' in records[0]), 'topic must not leak into the local record');
    assert.ok(!('session_hint' in records[0]), 'session_hint must not leak into the local record');
  });

  it('channel=none (shipped default) is a system-off no-op that burns NO TTL slot', async () => {
    // ADR-0040 §2 / ADR-0035 §3 invariant 1 amendment: the action-specific
    // gate is the notify_channel CONFIG KEY, whose shipped default is none.
    assert.equal(NOTIFY_KEY_DEFAULTS.notify_channel, 'none');
    const repoRoot = makeRepo();
    const result = await runEmit(emitArgs({ repoRoot }));
    assert.equal(result.status, 'suppressed');
    assert.equal(result.reason, 'channel-none');
    assert.equal(dedupeClaimCount(repoRoot), 0);
    assert.equal(readLog(repoRoot).length, 0);
  });

  it('a kinds-disabled event never consumes a TTL slot (filter runs BEFORE dedupe)', async () => {
    const repoRoot = makeRepo({ configLines: [
      'notify_channel = "file-log"',
      'notify_kinds = "peer-run-terminal"',
    ] });
    const result = await runEmit(emitArgs({ repoRoot }));
    assert.equal(result.status, 'suppressed');
    assert.equal(result.reason, 'kinds-filter');
    assert.equal(dedupeClaimCount(repoRoot), 0);
  });

  it('a duplicate within the TTL window is suppressed (one log line total)', async () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "file-log"'] });
    const home = makeHome();
    assert.equal((await runEmit(emitArgs({ repoRoot, home }))).status, 'dispatched');
    const second = await runEmit(emitArgs({ repoRoot, home }));
    assert.equal(second.status, 'suppressed');
    assert.equal(second.reason, 'dedupe-duplicate');
    assert.equal(readLog(repoRoot).length, 1);
  });

  it('a quiet-hours-suppressed event still burns its TTL slot (dedupe BEFORE quiet-hours)', async () => {
    const repoRoot = makeRepo({ configLines: [
      'notify_channel = "file-log"',
      'notify_quiet_hours = "09:00-17:00"',
      'notify_quiet_hours_tz = "UTC"',
    ] });
    const result = await runEmit(emitArgs({ repoRoot, event: makeEvent({ urgency: 'normal' }) }));
    assert.equal(result.status, 'suppressed');
    assert.equal(result.reason, 'quiet-hours');
    assert.equal(readLog(repoRoot).length, 0);
    assert.equal(dedupeClaimCount(repoRoot), 1);
  });

  it('an urgent event bypasses quiet hours by default', async () => {
    const repoRoot = makeRepo({ configLines: [
      'notify_channel = "file-log"',
      'notify_quiet_hours = "09:00-17:00"',
      'notify_quiet_hours_tz = "UTC"',
    ] });
    assert.equal((await runEmit(emitArgs({ repoRoot }))).status, 'dispatched');
  });

  it('fail-closes on malformed JSON / invalid event / invalid config / missing repo root', async () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "file-log"'] });
    const malformed = await runEmit(emitArgs({ repoRoot, overrides: { eventText: '{not json' } }));
    assert.deepEqual({ status: malformed.status, stage: malformed.stage }, { status: 'failed', stage: 'parse' });

    const invalidEvent = await runEmit(emitArgs({ repoRoot, event: makeEvent({ kind: 'party' }) }));
    assert.deepEqual({ status: invalidEvent.status, stage: invalidEvent.stage }, { status: 'failed', stage: 'validate' });

    const badConfigRoot = makeRepo({ configLines: ['notify_channel = "bogus"'] });
    const invalidConfig = await runEmit(emitArgs({ repoRoot: badConfigRoot }));
    assert.deepEqual({ status: invalidConfig.status, stage: invalidConfig.stage }, { status: 'failed', stage: 'config' });

    const loose = makeTempDir('notify-noroot-');
    const noRoot = await runEmit(emitArgs({ repoRoot: null, overrides: { cwd: loose } }));
    assert.deepEqual({ status: noRoot.status, stage: noRoot.stage }, { status: 'failed', stage: 'repo-root' });
  });

  it('caps event_id at the validate stage BEFORE any dedupe state is written (Codex review MAJOR)', async () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "file-log"'] });
    const longSubject = 's'.repeat(REDACT_FIELD_CAPS.event_id + 50);
    const event = makeEvent({ event_id: `repo-abc123:approval:${longSubject}:fired` });
    const result = await runEmit(emitArgs({ repoRoot, event }));
    assert.deepEqual({ status: result.status, stage: result.stage }, { status: 'failed', stage: 'validate' });
    assert.match(result.reason, /event_id exceeds/);
    assert.equal(dedupeClaimCount(repoRoot), 0, 'no oversized subject material parked in notify state');
  });

  it('fail-closes (never throws) when the dedupe state dir is unwritable', async () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "file-log"'] });
    // Occupy the notify state dir path with a FILE so mkdir fails.
    fs.mkdirSync(path.dirname(notifyStateDir(repoRoot)), { recursive: true });
    fs.writeFileSync(notifyStateDir(repoRoot), 'not a dir');
    const result = await runEmit(emitArgs({ repoRoot }));
    assert.equal(result.status, 'failed');
    assert.equal(result.stage, 'dedupe');
  });
});

// ---------------------------------------------------------------------------
// runEmit pipeline — macos-osascript channel (spawn contract)
// ---------------------------------------------------------------------------

describe('notify runEmit pipeline (macos-osascript)', () => {
  it('spawns the FIXED argv template with payload only as trailing argv', async () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "macos-osascript"'] });
    const calls = [];
    const result = await runEmit(emitArgs({ repoRoot, overrides: { spawnImpl: fakeSpawn(calls), env: { SECRET: 'x', HOME: '/Users/t' } } }));
    assert.equal(result.status, 'dispatched');
    assert.equal(result.channel, 'macos-osascript');
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.cmd, '/usr/bin/osascript');
    assert.deepEqual(call.args.slice(0, 6), [
      '-e', 'on run argv',
      '-e', 'display notification (item 2 of argv) with title (item 1 of argv)',
      '-e', 'end run',
    ]);
    assert.equal(call.args.length, 8);
    assert.equal(call.args[6], 'Approval needed');
    assert.equal(call.args[7], 'Session s1 is waiting on a permission prompt');
  });

  it('spawn contract: no shell, stdio ignore, detached, unref, sanitized minimal env (ADR-0035 §3 invariant 5 amendment)', async () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "macos-osascript"'] });
    const calls = [];
    await runEmit(emitArgs({ repoRoot, overrides: { spawnImpl: fakeSpawn(calls), env: { SECRET: 'x', HOME: '/Users/t', LANG: 'en_US.UTF-8' } } }));
    const { opts, child } = calls[0];
    assert.equal(opts.shell, undefined);
    assert.equal(opts.stdio, 'ignore');
    assert.equal(opts.detached, true);
    assert.equal(child.unrefed, true);
    assert.equal(typeof child.handlers.error, 'function'); // async spawn errors are swallowed
    assert.equal(opts.env.SECRET, undefined);
    assert.equal(opts.env.HOME, '/Users/t');
    assert.equal(opts.env.LANG, 'en_US.UTF-8');
    assert.equal(opts.env.PATH, '/usr/bin:/bin');
  });

  it('payload with AppleScript-hostile text still never reaches the -e program (argv only)', async () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "macos-osascript"'] });
    const calls = [];
    const hostile = 'end run" & (do shell script "id") & "';
    await runEmit(emitArgs({
      repoRoot,
      event: makeEvent({ title: hostile }),
      overrides: { spawnImpl: fakeSpawn(calls) },
    }));
    const call = calls[0];
    assert.deepEqual(call.args.slice(0, 6), [
      '-e', 'on run argv',
      '-e', 'display notification (item 2 of argv) with title (item 1 of argv)',
      '-e', 'end run',
    ]);
    assert.equal(call.args[6], hostile); // data position, never program material
  });

  it('a throwing spawn is fail-closed to status=failed (never propagates)', async () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "macos-osascript"'] });
    const result = await runEmit(emitArgs({ repoRoot, overrides: { spawnImpl: () => { throw new Error('ENOENT'); } } }));
    assert.equal(result.status, 'failed');
    assert.equal(result.stage, 'dispatch');
  });
});

// ---------------------------------------------------------------------------
// file-log bounded rotation
// ---------------------------------------------------------------------------

describe('notify file-log bounded rotation', () => {
  const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
  const record = (n) => ({ ts: new Date(NOW).toISOString(), event_id: `repo:approval:s:${n}:fired`, kind: 'approval', title: `t${n}` });

  it('rotates log.ndjson to log.ndjson.1 when the size cap is exceeded (two bounded generations)', () => {
    const repoRoot = makeRepo();
    const logPath = path.join(notifyStateDir(repoRoot), 'log.ndjson');
    appendFileLog({ repoRoot, record: record(1), maxBytes: 1 });
    // First append lands even above cap (empty log never rotates itself away).
    assert.equal(readLog(repoRoot).length, 1);
    appendFileLog({ repoRoot, record: record(2), maxBytes: 1 });
    assert.ok(fs.existsSync(`${logPath}.1`), 'previous generation kept as .1');
    assert.equal(readLog(repoRoot).length, 1);
    assert.equal(readLog(repoRoot)[0].event_id, record(2).event_id);
    const firstGen = fs.readFileSync(`${logPath}.1`, 'utf8');
    assert.match(firstGen, /repo:approval:s:1:fired/);
    // A third rotation replaces .1 — exactly two generations, bounded.
    appendFileLog({ repoRoot, record: record(3), maxBytes: 1 });
    assert.match(fs.readFileSync(`${logPath}.1`, 'utf8'), /repo:approval:s:2:fired/);
    assert.equal(readLog(repoRoot)[0].event_id, record(3).event_id);
  });

  it('a concurrent FRESH rotate lock skips rotation but still appends (no loss)', () => {
    const repoRoot = makeRepo();
    const logPath = path.join(notifyStateDir(repoRoot), 'log.ndjson');
    appendFileLog({ repoRoot, record: record(1), maxBytes: 1 });
    fs.mkdirSync(`${logPath}.rotate.lock`);
    appendFileLog({ repoRoot, record: record(2), maxBytes: 1 });
    assert.ok(!fs.existsSync(`${logPath}.1`), 'rotation conceded to the lock holder');
    assert.equal(readLog(repoRoot).length, 2, 'append is lock-free — no loss');
  });

  it('a STALE rotate lock is swept for the next caller; this call concedes rotation', () => {
    const repoRoot = makeRepo();
    const logPath = path.join(notifyStateDir(repoRoot), 'log.ndjson');
    appendFileLog({ repoRoot, record: record(1), maxBytes: 1 });
    const lockDir = `${logPath}.rotate.lock`;
    fs.mkdirSync(lockDir);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockDir, old, old);
    appendFileLog({ repoRoot, record: record(2), maxBytes: 1, lockStaleMs: 60_000 });
    assert.ok(!fs.existsSync(lockDir), 'stale lock swept');
    assert.ok(!fs.existsSync(`${logPath}.1`), 'sweep-and-rotate in one call is forbidden (concede)');
    assert.equal(readLog(repoRoot).length, 2);
    // The NEXT caller rotates normally.
    appendFileLog({ repoRoot, record: record(3), maxBytes: 1 });
    assert.ok(fs.existsSync(`${logPath}.1`));
  });
});

// ---------------------------------------------------------------------------
// CLI contract — fail-closed silent (ADR-0035 §3 invariant 8 amendment)
// ---------------------------------------------------------------------------

describe('notify CLI (emit) fail-closed contract', () => {
  // spawnSync, not promisified execFile — execFile has no `input` option, so
  // a stdin-fed case would leave the child waiting on an open pipe forever.
  function runCli({ repoRoot, home, args = [], input = undefined }) {
    const result = spawnSync(process.execPath, [NOTIFY_CLI, ...args], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home },
      input,
      encoding: 'utf8',
      timeout: 15_000,
    });
    return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  it('dispatches via --event-file: exit 0, EMPTY stdout, silent stderr', async () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "file-log"'] });
    const home = makeHome();
    const eventFile = path.join(makeTempDir('notify-ev-'), 'event.json');
    fs.writeFileSync(eventFile, JSON.stringify(makeEvent()));
    const result = runCli({ repoRoot, home, args: ['emit', '--event-file', eventFile] });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(readLog(repoRoot).length, 1);
  });

  it('reads the event from stdin when no --event-file is given', async () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "file-log"'] });
    const result = runCli({ repoRoot, home: makeHome(), args: ['emit'], input: JSON.stringify(makeEvent()) });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(readLog(repoRoot).length, 1);
  });

  it('accepts an explicit --repo-root', async () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "file-log"'] });
    const elsewhere = makeTempDir('notify-cwd-');
    const eventFile = path.join(elsewhere, 'event.json');
    fs.writeFileSync(eventFile, JSON.stringify(makeEvent()));
    const result = runCli({
      repoRoot: elsewhere,
      home: makeHome(),
      args: ['emit', '--event-file', eventFile, '--repo-root', repoRoot],
    });
    assert.equal(result.code, 0);
    assert.equal(readLog(repoRoot).length, 1);
  });

  it('every emit failure exits 0 with EMPTY stdout and AT MOST one stderr line', async () => {
    const home = makeHome();
    const cases = [
      { repoRoot: makeRepo({ configLines: ['notify_channel = "file-log"'] }), input: '{not json' },
      { repoRoot: makeRepo({ configLines: ['notify_channel = "bogus"'] }), input: JSON.stringify(makeEvent()) },
      { repoRoot: makeTempDir('notify-noroot-'), input: JSON.stringify(makeEvent()) },
    ];
    for (const c of cases) {
      const result = runCli({ repoRoot: c.repoRoot, home, args: ['emit'], input: c.input });
      assert.equal(result.code, 0, `exit 0 always on the emit path (stderr: ${result.stderr})`);
      assert.equal(result.stdout, '', 'stdout is load-bearing on completion paths — never written');
      assert.ok(result.stderr.split('\n').filter(Boolean).length <= 1, `at most one stderr line, got: ${result.stderr}`);
    }
  });

  it('a suppressed outcome is FULLY silent (no stderr at all)', async () => {
    const repoRoot = makeRepo(); // channel defaults to none
    const result = runCli({ repoRoot, home: makeHome(), args: ['emit'], input: JSON.stringify(makeEvent()) });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  it('a non-emit invocation is developer-facing: usage on stderr, exit 1', async () => {
    const repoRoot = makeRepo();
    const result = runCli({ repoRoot, home: makeHome(), args: ['broadcast'] });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /usage/i);
  });

  it('a flag missing its value fails closed — never silent stdin/cwd fallback (Codex review MINOR)', () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "file-log"'] });
    const home = makeHome();
    for (const args of [
      ['emit', '--event-file'],
      ['emit', '--repo-root'],
      ['emit', '--event-file', '--repo-root', repoRoot],
    ]) {
      const result = runCli({ repoRoot, home, args, input: JSON.stringify(makeEvent()) });
      assert.equal(result.code, 0, `exit 0 on the emit path for: ${args.join(' ')}`);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /requires a value/);
      assert.ok(result.stderr.split('\n').filter(Boolean).length <= 1);
    }
    assert.equal(readLog(repoRoot).length, 0, 'no dispatch happened on malformed argv');
  });
});

// ---------------------------------------------------------------------------
// runEmit pipeline — telegram E1 egress channel (ADR-0041 §2b/§2c/§2f/§5/§6/§7)
// ---------------------------------------------------------------------------

describe('notify runEmit pipeline (telegram E1 egress)', () => {
  const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

  function egressEvent(overrides = {}) {
    // A host-woven event carrying the ADR-0041 §4 routing fields + a secret-
    // bearing local body that MUST NOT egress (§2f).
    return makeEvent({
      event_id: 'repo-abc123:approval:host-mba:session:s1:aaaa:fired',
      title: 'Approval needed',
      body: 'SENSITIVE local body text — never egressed',
      hostname: 'mba',
      topic: 'repo:main',
      session_hint: 'sess12',
      refs: { workflow_id: 'wf-1', path: '/secret/local/path' },
      ...overrides,
    });
  }

  async function egressEmit({
    repoRoot, home, event = egressEvent(), env = egressEnv(),
    calls = [], respond, spawnImpl, now = NOW,
  }) {
    return runEmit({
      eventText: JSON.stringify(event),
      repoRoot,
      homeDir: home ?? makeHome(),
      now,
      env,
      fetchImpl: fakeFetch(calls, respond),
      ...(spawnImpl ? { spawnImpl } : {}),
    });
  }

  it('§2b — an engaged+active egress issues the ONE pinned request (fake token, observed via fetchImpl)', async () => {
    const repoRoot = makeRepo();
    const calls = [];
    const result = await egressEmit({ repoRoot, calls });
    assert.deepEqual(
      { status: result.status, stage: result.stage, channel: result.channel },
      { status: 'dispatched', stage: 'egress', channel: 'telegram' },
    );
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, `https://api.telegram.org/bot${FAKE_TELEGRAM_TOKEN}/sendMessage`);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal && typeof init.signal === 'object' && 'aborted' in init.signal, 'a bounded AbortSignal');
    assert.equal(init.headers['content-type'], 'application/json');
  });

  it('§2f — the egress body carries ONLY enumerated §3 fields, never title/body/refs.path', async () => {
    const repoRoot = makeRepo();
    const calls = [];
    await egressEmit({ repoRoot, calls });
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(Object.keys(body).sort(), ['chat_id', 'text']);
    assert.equal(body.chat_id, FAKE_CHAT_ID);
    // The rendered text is built from enumerated fields only.
    assert.match(body.text, /approval/);
    assert.match(body.text, /@mba/);
    assert.match(body.text, /repo:main/);
    assert.ok(!body.text.includes('SENSITIVE'), 'local body text must never egress');
    assert.ok(!body.text.includes('Approval needed'), 'title must never egress');
    assert.ok(!body.text.includes('/secret/local/path'), 'refs.path must never egress');
  });

  it('§2b — no real/token-shaped value is ever written to the attempt-mirror', async () => {
    const repoRoot = makeRepo();
    await egressEmit({ repoRoot });
    const rows = readLog(repoRoot);
    assert.equal(rows.length, 1);
    const raw = JSON.stringify(rows[0]);
    assert.ok(!raw.includes(FAKE_TELEGRAM_TOKEN), 'the token must not appear in the mirror');
    assert.ok(!raw.includes('123456789'), 'no token fragment in the mirror');
    assert.equal(rows[0].egress_channel, 'telegram');
    assert.equal(rows[0].egress_status, 'dispatched');
    assert.equal(rows[0].egress_outcome, 'dispatched');
  });

  it('§2c — egress overrides the shipped notify_channel=none default (fires with no local channel set)', async () => {
    const repoRoot = makeRepo(); // no config.toml → notify_channel=none
    const calls = [];
    const result = await egressEmit({ repoRoot, calls });
    assert.equal(result.status, 'dispatched');
    assert.equal(calls.length, 1, 'the none-default did not suppress the engaged egress');
  });

  it('§2c — an engaged egress overrides a configured LOCAL channel (osascript is NOT spawned)', async () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "macos-osascript"'] });
    const calls = [];
    const spawnCalls = [];
    const result = await egressEmit({ repoRoot, calls, spawnImpl: fakeSpawn(spawnCalls) });
    assert.equal(result.channel, 'telegram');
    assert.equal(calls.length, 1, 'the pinned request ran');
    assert.equal(spawnCalls.length, 0, 'the local osascript channel did not also run');
  });

  it('§2c — a token alone never activates: missing the explicit channel key → NOT engaged (local path)', async () => {
    const repoRoot = makeRepo(); // none
    const calls = [];
    // Credential + recipient present, but no AGENTIC_NOTIFY_EGRESS_CHANNEL.
    const env = { TELEGRAM_BOT_TOKEN: FAKE_TELEGRAM_TOKEN, TELEGRAM_CHAT_ID: FAKE_CHAT_ID };
    const result = await egressEmit({ repoRoot, calls, env });
    assert.equal(result.reason, 'channel-none', 'token+recipient without the activation key is not egress');
    assert.equal(calls.length, 0, 'no request without explicit activation');
  });

  it('§7 — a missing token suppresses, RELEASES the claim (retry after fix), records the throttle, no request', async () => {
    const repoRoot = makeRepo();
    const calls = [];
    const env = egressEnv({ TELEGRAM_BOT_TOKEN: undefined });
    const result = await egressEmit({ repoRoot, calls, env });
    assert.deepEqual(
      { status: result.status, reason: result.reason },
      { status: 'suppressed', reason: 'egress-missing-token' },
    );
    assert.equal(calls.length, 0, 'no request attempted without a credential');
    assert.equal(dedupeClaimCount(repoRoot), 0, 'the pre-claim is released so a fixed config re-fires');
    assert.equal(throttleCount(repoRoot), 1, 'a failure throttle is recorded');
    // The suppression is mirrored for the dashboard.
    assert.equal(readLog(repoRoot)[0].egress_status, 'suppressed');
  });

  it('§7 — a missing recipient suppresses as missing-recipient', async () => {
    const repoRoot = makeRepo();
    const env = egressEnv({ TELEGRAM_CHAT_ID: undefined });
    const result = await egressEmit({ repoRoot, env });
    assert.equal(result.reason, 'egress-missing-recipient');
  });

  it('an unknown egress channel is engaged-but-invalid (mirrored, never a local fallback)', async () => {
    const repoRoot = makeRepo();
    const calls = [];
    const env = egressEnv({ AGENTIC_NOTIFY_EGRESS_CHANNEL: 'slack' });
    const result = await egressEmit({ repoRoot, calls, env });
    assert.equal(result.reason, 'egress-invalid-local-activation');
    assert.equal(calls.length, 0);
    assert.equal(readLog(repoRoot)[0].egress_status, 'suppressed');
  });

  it('§7 — a provider 5xx is a FAILED outcome that releases the claim (retryable)', async () => {
    const repoRoot = makeRepo();
    const calls = [];
    const result = await egressEmit({ repoRoot, calls, respond: () => ({ status: 500, ok: false }) });
    assert.deepEqual(
      { status: result.status, reason: result.reason },
      { status: 'failed', reason: 'egress-provider-error' },
    );
    assert.equal(dedupeClaimCount(repoRoot), 0, 'a failed dispatch does not burn the success TTL');
    assert.equal(readLog(repoRoot)[0].egress_status, 'failed');
  });

  it('a Telegram { ok:false } (200) is provider-rejected', async () => {
    const repoRoot = makeRepo();
    const result = await egressEmit({ repoRoot, respond: () => ({ status: 200, ok: false }) });
    assert.equal(result.reason, 'egress-provider-rejected');
    assert.equal(result.status, 'failed');
  });

  it('§2e — a timeout rejection is caught and classified (never thrown on the hook path)', async () => {
    const repoRoot = makeRepo();
    const result = await egressEmit({ repoRoot, respond: () => timeoutError() });
    assert.equal(result.reason, 'egress-timeout');
    assert.equal(result.status, 'failed');
  });

  it('§2b — a redirect rejection (redirect:error) is classified as redirect-error', async () => {
    const repoRoot = makeRepo();
    const result = await egressEmit({ repoRoot, respond: () => redirectError() });
    assert.equal(result.reason, 'egress-redirect-error');
  });

  it('§7 — success PROMOTES the claim: an identical event within TTL is deduped (one request total)', async () => {
    const repoRoot = makeRepo();
    const home = makeHome();
    const calls = [];
    const first = await egressEmit({ repoRoot, home, calls });
    assert.equal(first.status, 'dispatched');
    const second = await egressEmit({ repoRoot, home, calls, now: NOW + 1000 });
    assert.equal(second.status, 'suppressed');
    assert.equal(second.reason, 'dedupe-duplicate');
    assert.equal(calls.length, 1, 'the promoted claim suppressed the duplicate before any second request');
  });

  it('§7 — failure RELEASES the claim: the next identical event re-attempts', async () => {
    const repoRoot = makeRepo();
    const home = makeHome();
    const calls = [];
    // First fails (releases claim + records throttle); advance PAST the cooldown
    // so the throttle does not itself suppress the retry.
    await egressEmit({ repoRoot, home, calls, respond: () => ({ status: 500, ok: false }) });
    const retry = await egressEmit({ repoRoot, home, calls, now: NOW + 120_000, respond: () => ({ status: 200, ok: true }) });
    assert.equal(retry.status, 'dispatched');
    assert.equal(calls.length, 2, 'the released claim allowed a genuine retry');
  });

  it('§7 — a repeated failure ENGAGES the throttle: the next event within cooldown is suppressed with no request', async () => {
    const repoRoot = makeRepo();
    const home = makeHome();
    const calls = [];
    await egressEmit({ repoRoot, home, calls, respond: () => ({ status: 500, ok: false }) });
    // A NEW identical event 1s later: claim is free (released), but the throttle
    // cooldown gates the retry — no second request, no mirror spam.
    const logsBefore = readLog(repoRoot).length;
    const throttled = await egressEmit({ repoRoot, home, calls, now: NOW + 1000, respond: () => ({ status: 200, ok: true }) });
    assert.equal(throttled.status, 'suppressed');
    assert.equal(throttled.reason, 'egress-throttled');
    assert.equal(calls.length, 1, 'the throttle stopped a re-dispatch against a persistent failure');
    assert.equal(readLog(repoRoot).length, logsBefore, 'a per-event cooldown does not spam the file-log');
    assert.equal(dedupeClaimCount(repoRoot), 0, 'the throttled attempt releases its claim for the post-cooldown retry');
  });

  it('§7 — config-fix bypass: changing the credential mints a new fingerprint that bypasses the cooldown', async () => {
    const repoRoot = makeRepo();
    const home = makeHome();
    const calls = [];
    await egressEmit({ repoRoot, home, calls, respond: () => ({ status: 500, ok: false }) });
    // Same event, still within the cooldown, but the operator fixed the token:
    // the (event+service+fingerprint) key changes → not throttled → re-attempts.
    const fixedEnv = egressEnv({ TELEGRAM_BOT_TOKEN: '987654321:ZZZ_yyyXXXwwwVVVuuuTTTsssRRRqqqPPP' });
    const bypass = await egressEmit({ repoRoot, home, calls, now: NOW + 1000, env: fixedEnv, respond: () => ({ status: 200, ok: true }) });
    assert.equal(bypass.status, 'dispatched');
    assert.equal(calls.length, 2, 'a credential change bypassed the cooldown');
  });

  it('§7 — config-fix bypass on a CHANNEL fix: an unknown-channel typo, then fixed to telegram, is not throttled', async () => {
    const repoRoot = makeRepo();
    const home = makeHome();
    const calls = [];
    // A channel-key typo → engaged-but-invalid → throttle recorded under the
    // raw ('') channel fingerprint.
    const typo = await egressEmit({ repoRoot, home, calls, env: egressEnv({ AGENTIC_NOTIFY_EGRESS_CHANNEL: 'telegramm' }) });
    assert.equal(typo.reason, 'egress-invalid-local-activation');
    assert.equal(calls.length, 0);
    // Operator fixes the channel key within the cooldown: the fingerprint's
    // channel component changes ('' → 'telegram') → not throttled → attempts.
    const fixed = await egressEmit({ repoRoot, home, calls, now: NOW + 1000, respond: () => ({ status: 200, ok: true }) });
    assert.equal(fixed.status, 'dispatched');
    assert.equal(calls.length, 1, 'the channel fix bypassed the cooldown (fingerprint changed)');
  });

  it('§7 — quiet hours suppresses egress (promotes the claim, mirrors suppressed, no request)', async () => {
    const repoRoot = makeRepo({ configLines: [
      'notify_quiet_hours = "09:00-17:00"',
      'notify_quiet_hours_tz = "UTC"',
    ] });
    const calls = [];
    const result = await egressEmit({ repoRoot, calls, event: egressEvent({ urgency: 'normal' }) });
    assert.equal(result.status, 'suppressed');
    assert.equal(result.reason, 'egress-quiet-hours');
    assert.equal(calls.length, 0, 'no request during quiet hours');
    assert.equal(dedupeClaimCount(repoRoot), 1, 'quiet-hours still burns the slot (promote)');
    assert.equal(readLog(repoRoot)[0].egress_status, 'suppressed');
  });

  it('§5 — a secret-shaped value in an enumerated field is scrubbed from the egress body', async () => {
    const repoRoot = makeRepo();
    const calls = [];
    // A credential-URL fumbled into topic (an enumerated field). §3 keeps free
    // text out; §5 scrubs what slips into an enumerated field.
    const event = egressEvent({ topic: 'https://user:supersecretpw@host.example/x' });
    await egressEmit({ repoRoot, calls, event });
    const body = JSON.parse(calls[0].init.body);
    assert.ok(!body.text.includes('supersecretpw'), 'the credential is scrubbed');
    assert.match(body.text, /\[redacted\]/);
  });

  it('a not-engaged env leaves the LOCAL pipeline untouched (file-log dispatches, no request)', async () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "file-log"'] });
    const calls = [];
    const result = await egressEmit({ repoRoot, calls, env: {} });
    assert.equal(result.status, 'dispatched');
    assert.equal(result.channel, 'file-log');
    assert.equal(calls.length, 0, 'no egress request when E1 is not engaged');
    // The local file-log record is the ADR-0040 shape (no egress_* fields).
    assert.ok(!('egress_status' in readLog(repoRoot)[0]));
  });

  it('§2b/§5 — a token-shaped value in an event field is scrubbed from the attempt-mirror (not just the body)', async () => {
    const repoRoot = makeRepo();
    const calls = [];
    // A credential-URL in topic + an sk- key in the event_id subject: both are
    // event-derived fields the mirror record carries. They must not persist raw
    // into the egress artifact (log.ndjson).
    const event = egressEvent({
      event_id: 'repo-abc123:approval:sk-ant-0123456789abcdefghij:fired',
      topic: 'https://user:supersecretpw@host.example/x',
    });
    await egressEmit({ repoRoot, calls, event });
    const raw = JSON.stringify(readLog(repoRoot)[0]);
    assert.ok(!raw.includes('supersecretpw'), 'credential-URL secret must not land in the mirror');
    assert.ok(!raw.includes('sk-ant-0123456789abcdefghij'), 'sk- key must not land in the mirror');
    assert.match(raw, /\[redacted\]/);
  });

  it('§7 — a config error (missing token) surfaces even DURING quiet hours (not preempted; claim released)', async () => {
    const repoRoot = makeRepo({ configLines: [
      'notify_quiet_hours = "09:00-17:00"',
      'notify_quiet_hours_tz = "UTC"',
    ] });
    const calls = [];
    // Non-urgent so quiet hours would otherwise suppress; token missing.
    const result = await egressEmit({
      repoRoot, calls, env: egressEnv({ TELEGRAM_BOT_TOKEN: undefined }),
      event: egressEvent({ urgency: 'normal' }),
    });
    assert.equal(result.reason, 'egress-missing-token', 'config error is not masked by quiet hours');
    assert.equal(calls.length, 0);
    assert.equal(dedupeClaimCount(repoRoot), 0, 'the claim is released so a token fix re-fires (not promoted by quiet-hours)');
    assert.equal(throttleCount(repoRoot), 1);
  });

  it('§2b — a shape-invalid token (or chat-id) is invalid-local-activation, never interpolated', async () => {
    for (const badEnv of [
      egressEnv({ TELEGRAM_BOT_TOKEN: 'bad/slash-not-a-token' }),
      egressEnv({ TELEGRAM_CHAT_ID: 'bad chat id' }),
    ]) {
      const repoRoot = makeRepo();
      const calls = [];
      const result = await egressEmit({ repoRoot, calls, env: badEnv });
      assert.equal(result.reason, 'egress-invalid-local-activation');
      assert.equal(calls.length, 0, 'no request with a malformed credential/recipient');
    }
  });

  it('§2e — a body-read abort mid-response is classified as timeout, not provider-rejected', async () => {
    const repoRoot = makeRepo();
    // fetch resolves 200 headers, but response.json() aborts (AbortSignal.timeout
    // fired while reading the body).
    const result = await egressEmit({ repoRoot, respond: () => ({ status: 200, jsonError: abortError() }) });
    assert.equal(result.reason, 'egress-timeout');
    assert.equal(result.status, 'failed');
  });
});

// The socket path of the real node:https transport is not unit-testable (the guard
// requires an inline pinned URL, so it cannot be pointed at a local server), but the
// family/budget arithmetic IS — and a review found the original single-shared-deadline
// form starved the fallback on a first-family HANG. These pin the fix.
describe('ADR-0041 §2d telegramAttemptTimeoutMs (IPv4-preferred fallback budget)', () => {
  const half = Math.ceil(TELEGRAM_API_TIMEOUT_MS / 2);
  it('caps a non-final attempt so a first-family HANG leaves budget for the fallback', () => {
    // A single shared deadline would hand family:4 (index 0) the whole budget; a
    // connect HANG would then consume it all and the default family would never run.
    assert.equal(telegramAttemptTimeoutMs({ deadline: TELEGRAM_API_TIMEOUT_MS, now: 0, index: 0, familyCount: 2 }), half);
  });
  it('gives the final attempt all remaining budget (fallback runs even after a first-family hang)', () => {
    assert.equal(telegramAttemptTimeoutMs({ deadline: TELEGRAM_API_TIMEOUT_MS, now: half, index: 1, familyCount: 2 }), TELEGRAM_API_TIMEOUT_MS - half);
  });
  it('a FAST first-family failure leaves nearly the whole budget for the fallback', () => {
    assert.equal(telegramAttemptTimeoutMs({ deadline: TELEGRAM_API_TIMEOUT_MS, now: 10, index: 1, familyCount: 2 }), TELEGRAM_API_TIMEOUT_MS - 10);
  });
  it('returns 0 once the shared budget is spent (loop breaks, deadline never exceeded)', () => {
    assert.equal(telegramAttemptTimeoutMs({ deadline: TELEGRAM_API_TIMEOUT_MS, now: TELEGRAM_API_TIMEOUT_MS, index: 1, familyCount: 2 }), 0);
    assert.equal(telegramAttemptTimeoutMs({ deadline: TELEGRAM_API_TIMEOUT_MS, now: TELEGRAM_API_TIMEOUT_MS + 100, index: 1, familyCount: 2 }), 0);
  });
  it('a single-family list gets the full budget (the only attempt is final)', () => {
    assert.equal(telegramAttemptTimeoutMs({ deadline: TELEGRAM_API_TIMEOUT_MS, now: 0, index: 0, familyCount: 1 }), TELEGRAM_API_TIMEOUT_MS);
  });
});
