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
} from '../../plugins/runtime/scripts/notify.mjs';
import { NOTIFY_KEY_DEFAULTS } from '../../plugins/runtime/scripts/lib/runtime-config.mjs';
import { notifyDedupeDir, notifyStateDir } from '../../plugins/runtime/scripts/lib/notify-schema.mjs';

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

  it('an UNREADABLE higher-precedence layer fail-closes instead of falling through (Codex review MAJOR)', () => {
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
    const emitted = runEmit(emitArgs({ repoRoot, home, overrides: { spawnImpl: fakeSpawn(calls) } }));
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
  it('dispatches: appends one redacted NDJSON record and burns one TTL slot', () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "file-log"'] });
    const result = runEmit(emitArgs({ repoRoot }));
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

  it('ADR-0041 §4 — an event carrying the OPTIONAL routing fields validates + dispatches (forward-compat)', () => {
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
    const result = runEmit(emitArgs({ repoRoot, event }));
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

  it('channel=none (shipped default) is a system-off no-op that burns NO TTL slot', () => {
    // ADR-0040 §2 / ADR-0035 §3 invariant 1 amendment: the action-specific
    // gate is the notify_channel CONFIG KEY, whose shipped default is none.
    assert.equal(NOTIFY_KEY_DEFAULTS.notify_channel, 'none');
    const repoRoot = makeRepo();
    const result = runEmit(emitArgs({ repoRoot }));
    assert.equal(result.status, 'suppressed');
    assert.equal(result.reason, 'channel-none');
    assert.equal(dedupeClaimCount(repoRoot), 0);
    assert.equal(readLog(repoRoot).length, 0);
  });

  it('a kinds-disabled event never consumes a TTL slot (filter runs BEFORE dedupe)', () => {
    const repoRoot = makeRepo({ configLines: [
      'notify_channel = "file-log"',
      'notify_kinds = "peer-run-terminal"',
    ] });
    const result = runEmit(emitArgs({ repoRoot }));
    assert.equal(result.status, 'suppressed');
    assert.equal(result.reason, 'kinds-filter');
    assert.equal(dedupeClaimCount(repoRoot), 0);
  });

  it('a duplicate within the TTL window is suppressed (one log line total)', () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "file-log"'] });
    const home = makeHome();
    assert.equal(runEmit(emitArgs({ repoRoot, home })).status, 'dispatched');
    const second = runEmit(emitArgs({ repoRoot, home }));
    assert.equal(second.status, 'suppressed');
    assert.equal(second.reason, 'dedupe-duplicate');
    assert.equal(readLog(repoRoot).length, 1);
  });

  it('a quiet-hours-suppressed event still burns its TTL slot (dedupe BEFORE quiet-hours)', () => {
    const repoRoot = makeRepo({ configLines: [
      'notify_channel = "file-log"',
      'notify_quiet_hours = "09:00-17:00"',
      'notify_quiet_hours_tz = "UTC"',
    ] });
    const result = runEmit(emitArgs({ repoRoot, event: makeEvent({ urgency: 'normal' }) }));
    assert.equal(result.status, 'suppressed');
    assert.equal(result.reason, 'quiet-hours');
    assert.equal(readLog(repoRoot).length, 0);
    assert.equal(dedupeClaimCount(repoRoot), 1);
  });

  it('an urgent event bypasses quiet hours by default', () => {
    const repoRoot = makeRepo({ configLines: [
      'notify_channel = "file-log"',
      'notify_quiet_hours = "09:00-17:00"',
      'notify_quiet_hours_tz = "UTC"',
    ] });
    assert.equal(runEmit(emitArgs({ repoRoot })).status, 'dispatched');
  });

  it('fail-closes on malformed JSON / invalid event / invalid config / missing repo root', () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "file-log"'] });
    const malformed = runEmit(emitArgs({ repoRoot, overrides: { eventText: '{not json' } }));
    assert.deepEqual({ status: malformed.status, stage: malformed.stage }, { status: 'failed', stage: 'parse' });

    const invalidEvent = runEmit(emitArgs({ repoRoot, event: makeEvent({ kind: 'party' }) }));
    assert.deepEqual({ status: invalidEvent.status, stage: invalidEvent.stage }, { status: 'failed', stage: 'validate' });

    const badConfigRoot = makeRepo({ configLines: ['notify_channel = "bogus"'] });
    const invalidConfig = runEmit(emitArgs({ repoRoot: badConfigRoot }));
    assert.deepEqual({ status: invalidConfig.status, stage: invalidConfig.stage }, { status: 'failed', stage: 'config' });

    const loose = makeTempDir('notify-noroot-');
    const noRoot = runEmit(emitArgs({ repoRoot: null, overrides: { cwd: loose } }));
    assert.deepEqual({ status: noRoot.status, stage: noRoot.stage }, { status: 'failed', stage: 'repo-root' });
  });

  it('caps event_id at the validate stage BEFORE any dedupe state is written (Codex review MAJOR)', () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "file-log"'] });
    const longSubject = 's'.repeat(REDACT_FIELD_CAPS.event_id + 50);
    const event = makeEvent({ event_id: `repo-abc123:approval:${longSubject}:fired` });
    const result = runEmit(emitArgs({ repoRoot, event }));
    assert.deepEqual({ status: result.status, stage: result.stage }, { status: 'failed', stage: 'validate' });
    assert.match(result.reason, /event_id exceeds/);
    assert.equal(dedupeClaimCount(repoRoot), 0, 'no oversized subject material parked in notify state');
  });

  it('fail-closes (never throws) when the dedupe state dir is unwritable', () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "file-log"'] });
    // Occupy the notify state dir path with a FILE so mkdir fails.
    fs.mkdirSync(path.dirname(notifyStateDir(repoRoot)), { recursive: true });
    fs.writeFileSync(notifyStateDir(repoRoot), 'not a dir');
    const result = runEmit(emitArgs({ repoRoot }));
    assert.equal(result.status, 'failed');
    assert.equal(result.stage, 'dedupe');
  });
});

// ---------------------------------------------------------------------------
// runEmit pipeline — macos-osascript channel (spawn contract)
// ---------------------------------------------------------------------------

describe('notify runEmit pipeline (macos-osascript)', () => {
  it('spawns the FIXED argv template with payload only as trailing argv', () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "macos-osascript"'] });
    const calls = [];
    const result = runEmit(emitArgs({ repoRoot, overrides: { spawnImpl: fakeSpawn(calls), env: { SECRET: 'x', HOME: '/Users/t' } } }));
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

  it('spawn contract: no shell, stdio ignore, detached, unref, sanitized minimal env (ADR-0035 §3 invariant 5 amendment)', () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "macos-osascript"'] });
    const calls = [];
    runEmit(emitArgs({ repoRoot, overrides: { spawnImpl: fakeSpawn(calls), env: { SECRET: 'x', HOME: '/Users/t', LANG: 'en_US.UTF-8' } } }));
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

  it('payload with AppleScript-hostile text still never reaches the -e program (argv only)', () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "macos-osascript"'] });
    const calls = [];
    const hostile = 'end run" & (do shell script "id") & "';
    runEmit(emitArgs({
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

  it('a throwing spawn is fail-closed to status=failed (never propagates)', () => {
    const repoRoot = makeRepo({ configLines: ['notify_channel = "macos-osascript"'] });
    const result = runEmit(emitArgs({ repoRoot, overrides: { spawnImpl: () => { throw new Error('ENOENT'); } } }));
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
