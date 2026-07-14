// ADR-0040 - operator situational awareness: BLACK-BOX ACCEPTANCE.
//
// The holistic, cross-surface AND cross-host acceptance gate for the ADR-0040
// series (notify-schema -> settings-keys -> emitter -> reader-lib -> dashboard
// -> notification-plan -> release-gate -> attention -> self-sensor -> THIS gate).
// The per-component suites (tests/runtime/test-notify*.mjs, test-dashboard.mjs,
// test-notification-plan.mjs, tests/plugin-shape/test-attention-plugin.mjs) prove
// each path's mechanics in depth; THIS suite proves the load-bearing acceptance
// criteria hold END-TO-END through the REAL entry points an operator or host
// lifecycle actually drives:
//
//   (a) the emit pipeline, exercised through the REAL `notify.mjs emit` CLI and
//       -- for the two properties that inherently need injection -- the runtime's
//       own PUBLIC `runEmit` API:
//         - source-excluded dedupe key (source is display metadata, never the key)
//         - default-status-token stability + approval content-hash NON-suppression,
//           proven through the REAL attention sensor -> REAL emitter chain (no unit
//           test wires the producer to the real emitter: the attention suite stubs
//           notify.mjs; the notify suite stubs the producer)
//         - kinds-filter-before-dedupe: a filtered kind must NOT burn a TTL slot
//         - quiet-hours + urgent bypass; redaction caps; channel none/file-log
//         - dedupe atomicity + bounded rotation under CONCURRENT racing producers
//         - osascript argv-only (payload rides as argv, never the -e program)
//   (b) sensor fail-closed: missing runtime / TOO-OLD runtime (below the
//       release-gate pin, through the version gate) / malformed payload / dead
//       channel binary -> exit 0, EMPTY stdout, the calling flow proceeds.
//   (c) `runtime:dashboard` aggregate over fixture state -- all three personas
//       incl. the founder namespace, Tier 2 freshness, notify-state health.
//   (d) `runtime:settings --notification-plan` M1 no-host-write -- the Codex
//       config.toml is byte-identical after every plan mode (dry-run + --apply).
//   (e) the ADR-0010 sec.5 subprocess-only boundary: no attention sensor and no
//       persona self-sensor STATICALLY/DYNAMICALLY/re-export imports the runtime
//       emit substrate (notify.mjs / notify-schema.mjs) -- it is reached only by
//       subprocess (the emitter) or copy (the sec.1 contract lib).
//
// Two properties cannot be observed through the fire-and-forget CLI and use the
// runtime's OWN public `notify.mjs` API instead (documented, deliberate -- NOT a
// cross-plugin reach; the ADR-0010 sec.5 ban is on PLUGINS importing across the
// seam, and a test is not a plugin):
//   - quiet-hours needs a deterministic clock -- `runEmit({ now })`;
//   - osascript argv-only needs to observe the spawned argv -- `runEmit({ spawnImpl })`
//     (the channel calls `/usr/bin/osascript` by ABSOLUTE path under a pinned
//     PATH, so a fixture binary on PATH cannot shim it; the ADR itself specifies
//     this assertion is "mocked").
// Every other property is proven fully black-box through the real subprocess CLIs.
//
// Host-free + deterministic: throwaway git repos + state homes + a fixture HOME
// so no real user config leaks in; the runtime is pinned via AGENTIC_RUNTIME_ROOT
// so sensor discovery never depends on the host's plugin cache. Run via
// `node --test tests/acceptance/test-operator-observability-acceptance.mjs`.

import { describe, it, before, after } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runtime PUBLIC API -- used ONLY for the two injection-dependent (a) properties
// above. No persona/attention PLUGIN is imported anywhere in this file.
import { runEmit, REDACT_FIELD_CAPS } from '../../plugins/runtime/scripts/notify.mjs';

import { runGit, runNode, runNodeAsync, runNodeOk, scrubAmbientEgressEnv } from './_helpers.mjs';

// Module-load egress scrub. `hermeticEnv` covers the child processes, but this
// suite ALSO calls `runEmit` in process, and `runEmit` defaults `env = process.env`.
// On a machine where the operator has ACTIVATED egress (the owner's ADR-0041
// launcher exports the triple), that ambient activation would engage the §2c
// egress override and flip the local emit-pipeline expectations to
// channel=telegram / dispatched. Both layers are required.
scrubAmbientEgressEnv();

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const RUNTIME_ROOT = resolve(REPO_ROOT, 'plugins/runtime');
const NOTIFY_CLI = resolve(RUNTIME_ROOT, 'scripts/notify.mjs');
const DASHBOARD_CLI = resolve(RUNTIME_ROOT, 'scripts/dashboard.mjs');
const SETTINGS_CLI = resolve(RUNTIME_ROOT, 'scripts/settings.mjs');
const ATTENTION_ROOT = resolve(REPO_ROOT, 'plugins/attention');
const SENSORS = Object.freeze({
  notification: resolve(ATTENTION_ROOT, 'adapters/claude/hooks/notification.mjs'),
  stop: resolve(ATTENTION_ROOT, 'adapters/claude/hooks/stop.mjs'),
  subagentStop: resolve(ATTENTION_ROOT, 'adapters/claude/hooks/subagent-stop.mjs'),
});

// The notify state layout (ADR-0040 sec.1; canonical: notify-schema.mjs
// notifyStateDir). Hardcoded here -- a black-box observer reads the documented
// path rather than importing the producer's layout helper.
const NOTIFY_DIR_REL = join('.agentic-plugins', 'state', 'runtime', 'notify');
const LOG_REL = join(NOTIFY_DIR_REL, 'log.ndjson');
const DEDUPE_REL = join(NOTIFY_DIR_REL, 'dedupe');
// notify.mjs NOTIFY_LOG_MAX_BYTES -- the rotation threshold (1 MiB). Mirrored so
// the concurrent-rotation fixture can seed just under it.
const LOG_MAX_BYTES = 1024 * 1024;

// A regex matching C0 + DEL + C1 control characters (what redaction strips),
// written entirely with \u escapes so no literal control byte lives in source.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

// ---------------------------------------------------------------------------
// Fixtures + drivers
// ---------------------------------------------------------------------------

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `adr0040-${prefix}-`));
}

// A minimal repo: the emitter's resolveRepoRoot only needs a .git marker when
// no explicit --repo-root is given; the sensors always resolve by walking to
// .git. A bare directory is enough -- no real git history required.
async function markerRepo(prefix) {
  const root = tmp(prefix);
  await mkdir(join(root, '.git'), { recursive: true });
  return root;
}

// A real git repo for the dashboard fixture -- the persona `state.mjs create`
// CLIs stamp a git baseline, so they want a repo with at least one commit.
function realGitRepo(prefix, branch = 'feat/x') {
  const root = tmp(prefix);
  runGit(['init', '-q', '-b', branch], { cwd: root });
  runGit(['config', 'user.name', 'adr0040-accept'], { cwd: root });
  runGit(['config', 'user.email', 'adr0040-accept@example.invalid'], { cwd: root });
  runGit(['config', 'commit.gpgsign', 'false'], { cwd: root });
  runGit(['commit', '-q', '--allow-empty', '-m', 'baseline', '--no-verify'], { cwd: root });
  return { root, branch };
}

// An empty fixture HOME so the emitter's user config layer
// (<HOME>/.agentic-plugins/config.toml) is always absent -- the real developer's
// ~/.agentic-plugins config must never leak into an acceptance assertion.
function fixtureHome() {
  return tmp('home');
}

async function writeConfig(root, kv) {
  const dir = join(root, '.agentic-plugins');
  await mkdir(dir, { recursive: true });
  const body = Object.entries(kv).map(([k, v]) => `${k} = "${v}"`).join('\n');
  await writeFile(join(dir, 'config.toml'), `${body}\n`);
}

// Compose a valid sec.1 event_id directly (no producer import): the emitter
// validates shape (>= 4 segments, kind segment matches, non-empty subject +
// status) and uses it verbatim as the dedupe subject -- it never recomputes the
// repo-ident, so a fixture-chosen colon-free repo-ident segment is legitimate.
function buildId(repoIdent, kind, subject, status) {
  return `${repoIdent}:${kind}:${subject}:${status}`;
}

function event(overrides = {}) {
  return {
    event_id: buildId('accept', 'workflow-terminal', 'wf-1', 'terminal'),
    source: 'attention-claude',
    kind: 'workflow-terminal',
    title: 'title',
    body: 'body',
    urgency: 'normal',
    ...overrides,
  };
}

// Synchronous real-CLI emit (sequential cases). Fail-closed contract: exit 0
// always, stdout empty always.
function emit(root, ev, home) {
  return runNode([NOTIFY_CLI, 'emit', '--repo-root', root], {
    input: `${JSON.stringify(ev)}\n`,
    env: { HOME: home },
  });
}

// Async real-CLI emit for CONCURRENT racing (the dedupe/rotation properties):
// each is a genuinely separate OS process contending on the O_EXCL claim / the
// mkdir rotation lock.
function emitAsync(root, ev, home) {
  return runNodeAsync([NOTIFY_CLI, 'emit', '--repo-root', root], {
    input: `${JSON.stringify(ev)}\n`,
    env: { HOME: home },
  });
}

async function readLog(root) {
  let text = '';
  try {
    text = await readFile(join(root, LOG_REL), 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

async function readLogRaw(root, rel = LOG_REL) {
  try {
    return await readFile(join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

async function listClaims(root) {
  try {
    return (await readdir(join(root, DEDUPE_REL))).filter((n) => n.endsWith('.claim'));
  } catch {
    return [];
  }
}

function runSensor(sensorPath, payload, { runtimeRoot, home }) {
  return runNode([sensorPath], {
    input: JSON.stringify(payload),
    env: { HOME: home, AGENTIC_RUNTIME_ROOT: runtimeRoot },
  });
}

// A runtime stub the version gate can reject/accept: manifest version + a
// notify.mjs presence marker are all discover-runtime inspects. Crucially, the
// stub's notify.mjs writes a `<root>/INVOKED` marker WHEN RUN -- so a too-old
// test can prove the version gate rejected the runtime BEFORE spawning it
// (marker absent), not merely that a no-op stub emitted nothing (which would
// pass even if the gate were removed -- the Codex-caught hollow-test trap).
async function makeRuntimeStub(version) {
  const root = tmp(`runtime-stub-${version.replace(/[^0-9a-z]/gi, '')}`);
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'runtime', version }));
  const marker = join(root, 'INVOKED');
  await writeFile(
    join(root, 'scripts/notify.mjs'),
    `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'invoked');\n`,
  );
  return { root, marker };
}

// ===========================================================================
// (a1) Emit pipeline -- dedupe key, kinds filter, channels, redaction, fail-closed
//      (fully black-box, real `notify.mjs emit`)
// ===========================================================================

describe('ADR-0040 acceptance (a1) -- emit pipeline through the real notify.mjs CLI', () => {
  it('source is EXCLUDED from the dedupe key: two sources, same subject moment -> one notification', async () => {
    const root = await markerRepo('src-excl');
    const home = fixtureHome();
    await writeConfig(root, { notify_channel: 'file-log' });
    const id = buildId('accept', 'peer-run-terminal', 'run-9', 'completed');
    // Same event_id, DIFFERENT source -- the peer-runner live path and a later
    // sweep observing the same terminal moment (ADR-0040 sec.1 concrete case).
    const a = emit(root, event({ event_id: id, kind: 'peer-run-terminal', source: 'peer-runner-engineer', body: 'S-A' }), home);
    const b = emit(root, event({ event_id: id, kind: 'peer-run-terminal', source: 'peer-runner-orchestrator', body: 'S-B' }), home);
    strictEqual(a.status, 0);
    strictEqual(b.status, 0);
    strictEqual(a.stdout, '');
    strictEqual(b.stdout, '');
    const log = await readLog(root);
    strictEqual(log.length, 1, 'differing source must NOT defeat dedupe -- exactly one line');
  });

  it('kinds-filter runs BEFORE dedupe: a filtered kind burns NO TTL slot', async () => {
    const root = await markerRepo('kinds');
    const home = fixtureHome();
    // Only approval enabled -- turn-complete is filtered out.
    await writeConfig(root, { notify_channel: 'file-log', notify_kinds: 'approval' });
    const tc = event({
      event_id: buildId('accept', 'turn-complete', 'session:s1:p1', 'fired'),
      kind: 'turn-complete',
      body: 'TC',
    });
    const first = emit(root, tc, home);
    strictEqual(first.status, 0);
    strictEqual(first.stdout, '');
    strictEqual((await readLog(root)).length, 0, 'filtered event must not dispatch');
    deepStrictEqual(await listClaims(root), [], 'filtered event must NOT write a dedupe claim (no TTL slot burned)');

    // Now enable turn-complete and re-emit the SAME event: if the filtered emit
    // had burned a slot, this would wrongly dedupe. It must dispatch.
    await writeConfig(root, { notify_channel: 'file-log', notify_kinds: 'approval,turn-complete' });
    const second = emit(root, tc, home);
    strictEqual(second.status, 0);
    strictEqual((await readLog(root)).length, 1, 'the previously filtered subject must dispatch once enabled (slot was never consumed)');
  });

  it('channel "none" is a true no-op -- no notify state is written at all', async () => {
    const root = await markerRepo('none');
    const home = fixtureHome();
    await writeConfig(root, { notify_channel: 'none' });
    const res = emit(root, event({ body: 'NONE' }), home);
    strictEqual(res.status, 0);
    strictEqual(res.stdout, '');
    // The system gate precedes dedupe: an off channel must not even create the
    // dedupe dir (else enabling a channel would suppress the first real event).
    await stat(join(root, NOTIFY_DIR_REL)).then(
      () => { throw new Error('channel=none must leave no notify state dir'); },
      (err) => strictEqual(err.code, 'ENOENT'),
    );
  });

  it('redaction caps + control-character stripping are applied to the persisted record', async () => {
    const root = await markerRepo('redact');
    const home = fixtureHome();
    await writeConfig(root, { notify_channel: 'file-log' });
    // TITLE proves the CAP + actual TRUNCATION: 500 chars all 'T', so the
    // persisted title must be EXACTLY cap chars of 'T' -- not merely
    // "<= whatever the code says" (the Codex-caught hollow form). A raised or
    // removed cap would leave 500 chars and fail this.
    const longTitle = 'T'.repeat(500);
    // BODY proves the CONTROL strip + whitespace collapse concretely: BEL, NUL
    // and a newline sit WITHIN the cap, so the exact sanitized string is
    // observable (not merely truncated away past the cap).
    const rawBody = 'alpha\u0007beta\u0000gamma\ndelta';
    const res = emit(root, event({ title: longTitle, body: rawBody }), home);
    strictEqual(res.status, 0);
    const [rec] = await readLog(root);
    ok(rec, 'a record was written');
    strictEqual(rec.title, 'T'.repeat(REDACT_FIELD_CAPS.title), 'title truncated to EXACTLY the cap');
    ok(rec.title.length < longTitle.length, 'truncation actually occurred (input exceeded the cap)');
    strictEqual(rec.body, 'alpha beta gamma delta', 'control chars replaced + whitespace collapsed to the exact expected string');
    ok(!CONTROL_CHARS.test(rec.body), 'no control character survives in body');
    ok(!CONTROL_CHARS.test(rec.title), 'no control character survives in title');
  });

  it('fail-closed silent: malformed / invalid / no-repo inputs -> exit 0, EMPTY stdout', async () => {
    const root = await markerRepo('failclosed');
    const home = fixtureHome();
    await writeConfig(root, { notify_channel: 'file-log' });

    // Not JSON.
    const bad = runNode([NOTIFY_CLI, 'emit', '--repo-root', root], {
      input: 'this is not json', env: { HOME: home },
    });
    strictEqual(bad.status, 0, 'malformed input still exits 0');
    strictEqual(bad.stdout, '', 'no stdout on the fail-closed path');

    // Valid JSON, invalid event (missing title).
    const invalid = emit(root, { event_id: buildId('accept', 'idle', 'session:s1', 'fired'), source: 's', kind: 'idle', urgency: 'normal' }, home);
    strictEqual(invalid.status, 0);
    strictEqual(invalid.stdout, '');

    // No --repo-root and a cwd with no .git -> repo-root failure, still exit 0.
    const noRepoCwd = tmp('norepo');
    const noRepo = runNode([NOTIFY_CLI, 'emit'], {
      input: JSON.stringify(event()), cwd: noRepoCwd, env: { HOME: home },
    });
    strictEqual(noRepo.status, 0);
    strictEqual(noRepo.stdout, '');

    strictEqual((await readLog(root)).length, 0, 'no invalid input produced a notification');
  });
});

// ===========================================================================
// (a2) Producer -> emitter END-TO-END (real attention sensor -> real notify.mjs)
//      The integration proof no unit test provides: the sensor BUILDS the id and
//      the REAL emitter dedupes it. Covers the default-status-token stability and
//      the approval content-hash NON-suppression producer contracts, at the system level.
// ===========================================================================

describe('ADR-0040 acceptance (a2) -- sensor -> real emitter chain (file-log observable)', () => {
  let root;
  let home;
  before(async () => {
    root = await markerRepo('e2e');
    home = fixtureHome();
    await writeConfig(root, { notify_channel: 'file-log' });
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('approval content-hash: two DIFFERENT prompts both fire; the SAME prompt dedupes', async () => {
    // Distinct messages -> distinct content-hash subjects -> both dispatch.
    const bash = runSensor(SENSORS.notification, {
      cwd: root, session_id: 's-appr', notification_type: 'permission_prompt', message: 'Allow Bash?',
    }, { runtimeRoot: RUNTIME_ROOT, home });
    const edit = runSensor(SENSORS.notification, {
      cwd: root, session_id: 's-appr', notification_type: 'permission_prompt', message: 'Allow Edit?',
    }, { runtimeRoot: RUNTIME_ROOT, home });
    // Re-fire of the FIRST prompt -> same subject -> dedupes (no third line).
    const bashAgain = runSensor(SENSORS.notification, {
      cwd: root, session_id: 's-appr', notification_type: 'permission_prompt', message: 'Allow Bash?',
    }, { runtimeRoot: RUNTIME_ROOT, home });
    for (const r of [bash, edit, bashAgain]) {
      strictEqual(r.status, 0);
      strictEqual(r.stdout, '');
    }
    const approvals = (await readLog(root)).filter((rec) => rec.kind === 'approval');
    strictEqual(approvals.length, 2, 'two distinct prompts fire; the repeat is suppressed');
    strictEqual(approvals.every((rec) => rec.urgency === 'urgent'), true, 'approval events are urgent');
    strictEqual(new Set(approvals.map((rec) => rec.event_id)).size, 2, 'the two live approvals carry distinct ids');
  });

  it('turn-complete default status token is stable: same subject dedupes, distinct prompt fires', async () => {
    // Same session+prompt observed twice -> same fixed "fired" token -> one line.
    const a = runSensor(SENSORS.stop, { cwd: root, session_id: 's-turn', prompt_id: 'p1' }, { runtimeRoot: RUNTIME_ROOT, home });
    const b = runSensor(SENSORS.stop, { cwd: root, session_id: 's-turn', prompt_id: 'p1' }, { runtimeRoot: RUNTIME_ROOT, home });
    // A different prompt -> different subject -> a second line.
    const c = runSensor(SENSORS.stop, { cwd: root, session_id: 's-turn', prompt_id: 'p2' }, { runtimeRoot: RUNTIME_ROOT, home });
    for (const r of [a, b, c]) {
      strictEqual(r.status, 0);
      strictEqual(r.stdout, '');
    }
    const turns = (await readLog(root)).filter((rec) => rec.kind === 'turn-complete');
    strictEqual(turns.length, 2, 'the re-observed subject dedupes to one; the distinct prompt adds a second');
    // The default status token is CONCRETELY the ':fired' suffix (ADR-0040 §1),
    // and each id carries the turn-complete kind segment -- so stability here is
    // the fixed token, not an accident of some other status value.
    strictEqual(
      turns.every((rec) => rec.event_id.includes(':turn-complete:') && rec.event_id.endsWith(':fired')),
      true,
      'turn-complete ids carry the fixed default status token :fired',
    );
  });
});

// ===========================================================================
// (a3) Quiet hours + urgent bypass, and osascript argv-only.
//      Uses the runtime's OWN public runEmit (injected clock / spawn) -- the only
//      way to observe these two properties (see the file header).
// ===========================================================================

describe('ADR-0040 acceptance (a3) -- quiet hours + urgent bypass (runEmit public seam, injected clock)', () => {
  const IN_WINDOW = Date.UTC(2026, 0, 1, 23, 0, 0);   // 23:00 UTC -- inside 22:00-08:00
  const OUT_WINDOW = Date.UTC(2026, 0, 1, 12, 0, 0);   // 12:00 UTC -- outside

  async function fixture(kv) {
    const root = await markerRepo('quiet');
    const home = fixtureHome();
    await writeConfig(root, { notify_channel: 'file-log', notify_quiet_hours: '22:00-08:00', notify_quiet_hours_tz: 'UTC', ...kv });
    return { root, home };
  }

  it('a NORMAL event inside the window is suppressed; outside it dispatches', async () => {
    const { root, home } = await fixture();
    const ev = event({ urgency: 'normal' });
    const suppressed = await runEmit({ eventText: JSON.stringify(ev), repoRoot: root, homeDir: home, now: IN_WINDOW });
    strictEqual(suppressed.status, 'suppressed');
    strictEqual(suppressed.stage, 'quiet-hours');

    const dispatched = await runEmit({
      eventText: JSON.stringify(event({ urgency: 'normal', event_id: buildId('accept', 'workflow-terminal', 'wf-out', 'terminal') })),
      repoRoot: root, homeDir: home, now: OUT_WINDOW,
    });
    strictEqual(dispatched.status, 'dispatched');
    strictEqual((await readLog(root)).length, 1, 'only the out-of-window event reached the channel');
  });

  it('an URGENT event bypasses quiet hours by default, and is suppressed when bypass is disabled', async () => {
    const bypassOn = await fixture();
    const urgent = event({ urgency: 'urgent', event_id: buildId('accept', 'approval', 'session:s:h', 'fired'), kind: 'approval' });
    strictEqual(
      (await runEmit({ eventText: JSON.stringify(urgent), repoRoot: bypassOn.root, homeDir: bypassOn.home, now: IN_WINDOW })).status,
      'dispatched',
      'urgent bypasses quiet hours by default -- approval attention is never silently dropped',
    );

    const bypassOff = await fixture({ notify_urgent_bypass_quiet_hours: 'false' });
    strictEqual(
      (await runEmit({ eventText: JSON.stringify(urgent), repoRoot: bypassOff.root, homeDir: bypassOff.home, now: IN_WINDOW })).status,
      'suppressed',
      'the bypass is configurable off',
    );
  });
});

describe('ADR-0040 acceptance (a3) -- macos-osascript is argv-only (runEmit public seam, mocked spawn)', () => {
  const FIXED_PROGRAM = ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run'];

  async function dispatchCapture(ev) {
    const root = await markerRepo('osa');
    const home = fixtureHome();
    await writeConfig(root, { notify_channel: 'macos-osascript' });
    const calls = [];
    const spawnImpl = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { on() {}, unref() {} }; // fire-and-forget child stub
    };
    const res = await runEmit({ eventText: JSON.stringify(ev), repoRoot: root, homeDir: home, spawnImpl });
    return { res, calls };
  }

  // The spawn-hardening allowlist (notify.mjs SPAWN_ENV_ALLOWLIST + PATH).
  const ENV_ALLOWLIST = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'LOGNAME', 'TMPDIR', 'USER']);

  it('the AppleScript program is FIXED and payload rides ONLY as trailing argv', async () => {
    const { res, calls } = await dispatchCapture(event({ title: 'Approval', body: 'Allow Bash?' }));
    strictEqual(res.status, 'dispatched');
    strictEqual(calls.length, 1);
    const { cmd, args } = calls[0];
    strictEqual(cmd, '/usr/bin/osascript', 'the binary is the fixed absolute path');
    deepStrictEqual(args.slice(0, 6), FIXED_PROGRAM, 'the -e program is byte-identical and payload-free');
    strictEqual(args.length, 8, 'exactly the fixed program + two payload argv items');
    strictEqual(args[6], 'Approval', 'title rides as argv item 1');
    strictEqual(args[7], 'Allow Bash?', 'body rides as argv item 2');
  });

  it('an injection-laden payload stays DATA in argv -- it never enters the -e program', async () => {
    const evil = 'x" & (do shell script "touch /tmp/pwned") & "';
    const { calls } = await dispatchCapture(event({ title: 'T', body: evil }));
    const { args } = calls[0];
    // The program strings are unchanged; the payload appears only as the trailing
    // argv item (redaction preserves quotes as data, strips controls).
    deepStrictEqual(args.slice(0, 6), FIXED_PROGRAM, 'no payload interpolation into the program');
    ok(args[7].includes('do shell script'), 'the payload is carried verbatim as an argv value');
    ok(!FIXED_PROGRAM.join('|').includes('do shell script'), 'the program never contains payload text');
  });

  it('the spawn is hardened: no shell, stdio ignored, detached, minimal pinned env', async () => {
    // Codex-caught: argv placement alone does not prove the ADR-0040 §2 spawn
    // contract. A regression to shell:true or a full inherited env would defeat
    // the "payload is data, never command material" guarantee even with correct
    // argv. Assert the third spawn argument (options) directly.
    const { calls } = await dispatchCapture(event({ title: 'T', body: 'B' }));
    const { opts } = calls[0];
    ok(opts, 'spawn options were passed');
    ok(!opts.shell, 'NO shell (a shell would re-interpret the payload argv)');
    strictEqual(opts.stdio, 'ignore', 'stdio ignored (fire-and-forget)');
    strictEqual(opts.detached, true, 'detached child');
    strictEqual(opts.env.PATH, '/usr/bin:/bin', 'PATH pinned to the system dirs');
    // The env is the MINIMAL allowlist, not the caller's full environment.
    for (const key of Object.keys(opts.env)) {
      ok(ENV_ALLOWLIST.has(key), `spawn env leaks a non-allowlisted key: ${key}`);
    }
  });
});

// ===========================================================================
// (a) Concurrency -- dedupe atomicity + bounded rotation under racing producers
// ===========================================================================

describe('ADR-0040 acceptance (a) -- concurrent racing producers', () => {
  it('dedupe is ATOMIC: N processes racing the SAME event_id -> exactly one notification', async () => {
    // Honest scope (Codex-noted): this proves the OBSERVABLE outcome under real
    // multi-process contention on the O_EXCL claim, not a formal atomicity proof
    // -- a serializing scheduler could let a hypothetically non-atomic impl pass.
    // It is a genuine cross-process race (16 real OS processes on one claim file),
    // and pairs with the notify-schema unit tests that drive the claim primitive
    // directly. The load-bearing guarantee is "exactly one winner writes".
    const root = await markerRepo('race-dedupe');
    const home = fixtureHome();
    await writeConfig(root, { notify_channel: 'file-log' });
    const id = buildId('accept', 'workflow-terminal', 'wf-race', 'terminal');
    const N = 16;
    const results = await Promise.all(
      Array.from({ length: N }, () => emitAsync(root, event({ event_id: id, body: 'RACE' }), home)),
    );
    for (const r of results) {
      strictEqual(r.status, 0, `each racer exits 0; stderr:\n${r.stderr}`);
      strictEqual(r.stdout, '');
    }
    strictEqual((await readLog(root)).length, 1, 'the O_EXCL claim admits exactly one winner');
    strictEqual((await listClaims(root)).length, 1, 'exactly one claim file exists');
  });

  it('rotation stays bounded and lossless under concurrent writers crossing the threshold', async () => {
    const root = await markerRepo('race-rotate');
    const home = fixtureHome();
    await writeConfig(root, { notify_channel: 'file-log' });
    // Seed log.ndjson to sit just ~50 bytes under the 1 MiB threshold, as ONE
    // valid-NDJSON line. This is the load-bearing detail: each racer's append is
    // ~160 bytes, so EACH one individually observes size+incoming > maxBytes and
    // decides to rotate -> they contend on the mkdir rotation lock (the scenario
    // under test). A seed far below the threshold would let every racer append
    // without any one deciding to rotate, and nothing would contend.
    const dir = join(root, NOTIFY_DIR_REL);
    await mkdir(dir, { recursive: true });
    // JSON.stringify({seed:'x'.repeat(K)}) is K+11 bytes; +1 newline = K+12.
    const seedContent = `${JSON.stringify({ seed: 'x'.repeat(LOG_MAX_BYTES - 62) })}\n`;
    await writeFile(join(root, LOG_REL), seedContent);

    // N concurrent DISTINCT events -- each dispatches, each append crosses the
    // threshold, so they race on the mkdir rotation lock.
    const N = 12;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => emitAsync(root, event({
        event_id: buildId('accept', 'subagent-complete', `agent-${i}`, 'done'),
        kind: 'subagent-complete',
        body: `ROT-${i}`,
      }), home)),
    );
    for (const r of results) strictEqual(r.status, 0, `racer exits 0; stderr:\n${r.stderr}`);

    // Invariants: exactly two generations, every line valid JSON, every ROT
    // record present exactly once (no loss, no duplication), no third gen.
    const current = (await readLogRaw(root, LOG_REL)) ?? '';
    const rotated = await readLogRaw(root, `${LOG_REL}.1`);
    ok(rotated !== null, 'rotation produced the .1 generation');
    await stat(join(root, `${LOG_REL}.2`)).then(
      () => { throw new Error('a third generation must never exist (retention bounded at ~2x maxBytes)'); },
      (err) => strictEqual(err.code, 'ENOENT'),
    );
    const allLines = [...current.split('\n'), ...rotated.split('\n')].filter((l) => l.trim().length > 0);
    for (const line of allLines) JSON.parse(line); // every line is valid NDJSON
    const rotMarkers = allLines
      .map((l) => JSON.parse(l))
      .filter((rec) => typeof rec.body === 'string' && rec.body.startsWith('ROT-'))
      .map((rec) => rec.body);
    strictEqual(rotMarkers.length, N, 'no emitted record was lost across the rotation');
    strictEqual(new Set(rotMarkers).size, N, 'no emitted record was duplicated across the rotation');
  });
});

// ===========================================================================
// (b) Sensor fail-closed -- missing / too-old / malformed / dead-channel
// ===========================================================================

describe('ADR-0040 acceptance (b) -- sensors fail closed, the calling flow proceeds', () => {
  const ALL = Object.values(SENSORS);
  const payload = (root) => ({
    cwd: root,
    session_id: 's-b',
    prompt_id: 'p-b',
    notification_type: 'permission_prompt',
    message: 'Allow?',
    agent_id: 'agent-b',
  });

  it('MISSING runtime -> every sensor exits 0, EMPTY stdout, emits nothing', async () => {
    const root = await markerRepo('b-missing');
    const home = fixtureHome();
    await writeConfig(root, { notify_channel: 'file-log' });
    for (const sensor of ALL) {
      const r = runSensor(sensor, payload(root), { runtimeRoot: join(root, 'no-such-runtime'), home });
      strictEqual(r.status, 0);
      strictEqual(r.stdout, '');
    }
    strictEqual((await readLog(root)).length, 0, 'an unresolvable runtime emits nothing');
  });

  it('TOO-OLD runtime (below the release-gate pin) -> version gate rejects; nothing emits', async () => {
    const root = await markerRepo('b-tooold');
    const home = fixtureHome();
    await writeConfig(root, { notify_channel: 'file-log' });
    // A runtime declaring a version below the release-gate pin (0.71.0). The
    // sensor's discover-runtime version-gates even the AGENTIC_RUNTIME_ROOT
    // override, so this exercises the gate against the RELEASED floor -- not
    // merely the source tree, which passes.
    const stale = await makeRuntimeStub('0.0.1');
    for (const sensor of ALL) {
      const r = runSensor(sensor, payload(root), { runtimeRoot: stale.root, home });
      strictEqual(r.status, 0, 'a too-old runtime never breaks the hook lifecycle');
      strictEqual(r.stdout, '');
    }
    strictEqual((await readLog(root)).length, 0, 'the version gate suppressed every emit');
    // The load-bearing assertion (Codex-caught): the stale stub's notify.mjs
    // writes an INVOKED marker if ever executed. Its ABSENCE proves the gate
    // rejected the runtime BEFORE spawning -- if the gate were removed, the
    // no-op-vs-rejected outcomes would be indistinguishable by log count alone.
    await stat(stale.marker).then(
      () => { throw new Error('the too-old runtime was SPAWNED -- the version gate did not reject it'); },
      (err) => strictEqual(err.code, 'ENOENT', `unexpected stat error: ${err.code}`),
    );
  });

  it('CONTRAST: a runtime AT the pin resolves and the sensor DOES emit (the gate discriminates)', async () => {
    const root = await markerRepo('b-ok');
    const home = fixtureHome();
    await writeConfig(root, { notify_channel: 'file-log' });
    // The real runtime (source tree) is >= the pin; a bare Stop dispatches.
    const r = runSensor(SENSORS.stop, { cwd: root, session_id: 's-ok', prompt_id: 'p-ok' }, { runtimeRoot: RUNTIME_ROOT, home });
    strictEqual(r.status, 0);
    strictEqual(r.stdout, '');
    strictEqual((await readLog(root)).length, 1, 'a pin-satisfying runtime lets the sensor emit -- proving the too-old case was the gate, not a dead path');
  });

  it('MALFORMED payload -> every sensor exits 0 with EMPTY stdout', async () => {
    const home = fixtureHome();
    for (const sensor of ALL) {
      for (const input of ['', '{not json', 'null', '[]']) {
        const r = runNode([sensor], {
          input, env: { HOME: home, AGENTIC_RUNTIME_ROOT: RUNTIME_ROOT },
        });
        strictEqual(r.status, 0, `${sensor} on ${JSON.stringify(input)}`);
        strictEqual(r.stdout, '');
      }
    }
  });

  it('DEAD channel binary -> the emitter catches the dispatch failure (exit 0), never throws', async () => {
    const root = await markerRepo('b-dead');
    const home = fixtureHome();
    await writeConfig(root, { notify_channel: 'macos-osascript' });
    // A spawn that throws synchronously models a dead/unavailable channel binary;
    // runEmit must classify it as a failed dispatch, not propagate.
    const result = await runEmit({
      eventText: JSON.stringify(event()),
      repoRoot: root,
      homeDir: home,
      spawnImpl: () => { throw new Error('ENOENT: osascript vanished'); },
    });
    strictEqual(result.status, 'failed');
    strictEqual(result.stage, 'dispatch', 'the failure is contained at the dispatch stage');
  });

  it('a dispatch failure through the REAL CLI is fail-closed: exit 0, EMPTY stdout', async () => {
    // Codex-caught: the runEmit-level test above does not prove the CLI honors
    // exit 0 + empty stdout for a dispatch-stage failure. Force one through the
    // real `notify.mjs emit` by making log.ndjson a DIRECTORY (appendFileSync
    // then fails EISDIR at the dispatch stage) -- the load-bearing completion
    // contract (never break the caller) must still hold.
    const root = await markerRepo('b-dead-cli');
    const home = fixtureHome();
    await writeConfig(root, { notify_channel: 'file-log' });
    await mkdir(join(root, NOTIFY_DIR_REL), { recursive: true });
    await mkdir(join(root, LOG_REL)); // log.ndjson is now a directory -> EISDIR on append
    const res = emit(root, event({ body: 'DEADCLI' }), home);
    strictEqual(res.status, 0, 'a dispatch failure must not break the calling flow');
    strictEqual(res.stdout, '', 'no stdout on the fail-closed dispatch path');
  });
});

// ===========================================================================
// (a/e) Persona peer-run self-sensor END-TO-END -- the §5 emit point FIRES
//       through the real emitter (not just proven un-imported by the scan).
// ===========================================================================

describe('ADR-0040 acceptance (a/e) -- persona peer-run self-sensor fires end-to-end', () => {
  it('the engineer peer-runner missing-companion path emits peer-run-terminal via the real emitter', async () => {
    // Codex-caught gap: the (e) source scan proves the self-sensor does not
    // IMPORT the emitter, but not that its emit point actually FIRES. Drive the
    // REAL engineer peer-runner into its missing-companion early return (an
    // ADR-0040 §5 terminal emit point) by pointing companion discovery at a stub
    // that resolves nothing, and assert a peer-run-terminal notification lands in
    // the real file-log through the real notify.mjs -- the full producer chain.
    const repo = await markerRepo('selfsensor');
    const home = fixtureHome();
    await writeConfig(repo, { notify_channel: 'file-log' });
    // A companions root whose discover-peer.mjs resolves NO companion, forcing
    // the peer_cli_not_found early return that self-sensors (ADR-0040 §5).
    const fakeCompanions = tmp('fake-companions');
    await writeFile(
      join(fakeCompanions, 'discover-peer.mjs'),
      'export async function discoverPeerCompanion() { return { ok: false }; }\n',
    );
    const res = runNode([
      resolve(REPO_ROOT, 'plugins/engineer/scripts/peer-runner.mjs'), 'run',
      '--peer', 'codex', '--kind', 'peer-now', '--prompt-text', 'ping',
      '--repo-root', repo, '--host', 'claude', '--output-format', 'json', '--cwd', repo,
    ], {
      env: { HOME: home, AGENTIC_RUNTIME_ROOT: RUNTIME_ROOT, AGENTIC_COMPANIONS_ROOT: fakeCompanions },
    });
    // The run reports the missing companion (a non-zero exit is expected); the
    // acceptance criterion is that the self-sensor notification fired, not the
    // run's own exit status. A liveness overrun would raise SpawnInfraError from
    // runNode rather than surfacing here as "the notification never fired".
    const peerRunTerminals = (await readLog(repo)).filter((rec) => rec.kind === 'peer-run-terminal');
    ok(peerRunTerminals.length >= 1, `a peer-run-terminal notification was emitted; run stderr:\n${res.stderr}`);
    ok(
      peerRunTerminals[0].event_id.includes(':peer-run-terminal:'),
      'the emitted event carries the peer-run-terminal kind segment',
    );
  });
});

// ===========================================================================
// (c) runtime:dashboard aggregate -- 3 personas incl. founder, Tier 2, notify health
// ===========================================================================

describe('ADR-0040 acceptance (c) -- dashboard aggregate over fixture state', () => {
  let root;
  let home;
  before(async () => {
    const repo = realGitRepo('dash');
    root = repo.root;
    home = fixtureHome();
    const branch = repo.branch;
    const head = runGit(['rev-parse', 'HEAD'], { cwd: root });

    // Seed one workflow in EACH persona namespace via the real create CLIs, so
    // Tier 1 aggregates genuine fixture state (founder proves the direct
    // namespace scan the ADR sec.6 added on top of doctor's engineer+orchestrator).
    const create = (persona, extra) => runNodeOk([
      resolve(REPO_ROOT, `plugins/${persona}/scripts/state.mjs`), 'create',
      '--repo-root', root, '--host', 'claude',
      '--git-baseline-branch', branch, '--git-baseline-head', head,
      '--status-digest', 'deadbeef', ...extra,
    ]);
    create('engineer', ['--verb', 'compose', '--persona', 'engineer', '--profile', 'backend', '--original-request', 'acc', '--current-phase', 'phase-0', '--next-action', 'go']);
    create('orchestrator', ['--verb', 'plan', '--original-request', 'acc macro']);
    create('founder', ['--verb', 'compose', '--persona', 'founder', '--original-request', 'acc venture']);

    // Seed notify config + a file-log so Tier 2 notify health has something to
    // surface (recent notifications are read only when channel=file-log).
    await writeConfig(root, { notify_channel: 'file-log' });
    const dir = join(root, NOTIFY_DIR_REL);
    await mkdir(dir, { recursive: true });
    await writeFile(join(root, LOG_REL), `${JSON.stringify({ ts: '2026-07-04T00:00:00.000Z', event_id: 'accept:approval:session:s:h:fired', kind: 'approval', title: 't', body: 'b' })}\n`);
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function dashboardJson() {
    const res = runNode([DASHBOARD_CLI, '--repo-root', root, '--format', 'json'], { env: { HOME: home } });
    strictEqual(res.status, 0, res.stderr);
    return JSON.parse(res.stdout);
  }

  it('reports all three persona namespaces, with the founder workflow surfaced', () => {
    const report = dashboardJson();
    deepStrictEqual(Object.keys(report.tier1.personas).sort(), ['engineer', 'founder', 'orchestrator']);
    // Founder is scanned as a first-class namespace (not merely a static key).
    ok(report.tier1.personas.founder.workflows.count >= 1, 'the seeded founder workflow is aggregated');
    ok(report.tier1.personas.engineer.workflows.count >= 1, 'the seeded engineer workflow is aggregated');
  });

  it('surfaces Tier 2 freshness + notify-state health with CONCRETE reader output', () => {
    const report = dashboardJson();
    // Codex-caught: key presence is hollow (buildReport always emits these
    // keys). Assert the freshness readers actually RAN and CLASSIFIED the
    // fixture: no doctor/compat/baseline artifacts were seeded, so each must
    // report the concrete 'missing' status -- an inert `{}` would have an
    // undefined status and fail.
    strictEqual(report.tier2.doctor.status, 'missing', 'the doctor-freshness reader ran and classified absence');
    strictEqual(report.tier2.compat.status, 'missing', 'the compat-freshness reader ran and classified absence');
    strictEqual(report.tier2.baseline.status, 'missing', 'the baseline-freshness reader ran and classified absence');
    // Notify Tier 2: channel + the SEEDED history record surfaced by content
    // (proving the reader parsed the seeded log, not just that a key exists).
    strictEqual(report.tier2.notify.config.channel, 'file-log');
    strictEqual(report.tier2.notify.state.log.present, true, 'the notify-state reader detected the seeded log');
    ok(
      report.tier2.notify.recent.entries.some(
        (e) => e.event_id === 'accept:approval:session:s:h:fired' && e.kind === 'approval',
      ),
      'the seeded file-log notification is surfaced by content',
    );
  });
});

// ===========================================================================
// (d) runtime:settings --notification-plan -- M1 never writes host config
// ===========================================================================

describe('ADR-0040 acceptance (d) -- --notification-plan is M1 no-host-write', () => {
  // settings.mjs calls runDoctor unconditionally (settings.mjs:109), and doctor
  // probes each host CLI up to 8 times at 5s apiece (doctor.mjs:40,102-127). With
  // the real binaries on PATH that is ~40s inside a child this suite used to bound
  // at 30s -- a guaranteed timeout on any machine slow enough to hit the probe
  // caps, with zero machine load required. A hermetic PATH removes the fan-out.
  function runPlan(repoRoot, { home, codexHome, apply }) {
    const args = [SETTINGS_CLI, '--repo-root', repoRoot, '--notification-plan', '--format', 'json'];
    if (apply) args.push('--apply');
    return runNode(args, { env: { HOME: home, CODEX_HOME: codexHome } });
  }

  it('an ABSENT Codex config.toml is never created -- by dry-run or --apply', async () => {
    const root = await markerRepo('d-absent');
    const home = fixtureHome();
    const codexHome = join(home, '.codex');
    const cfg = join(codexHome, 'config.toml');

    for (const apply of [false, true]) {
      const res = runPlan(root, { home, codexHome, apply });
      strictEqual(res.status, 0, res.stderr);
      await stat(cfg).then(
        () => { throw new Error(`config.toml must never be created (apply=${apply})`); },
        (err) => strictEqual(err.code, 'ENOENT'),
      );
    }
    // The plan DID run (it produced an agentic-plugins-owned artifact) -- proving
    // "no host write" is a real boundary, not an inert no-op.
    const plan = JSON.parse(runPlan(root, { home, codexHome, apply: false }).stdout);
    strictEqual(plan.notification_plan.requested, true);
    strictEqual(plan.notification_plan.executed, true);
  });

  it('a PRESENT Codex config.toml is byte-identical after every plan mode (wrapper-chain path)', async () => {
    const root = await markerRepo('d-present');
    const home = fixtureHome();
    const codexHome = join(home, '.codex');
    await mkdir(codexHome, { recursive: true });
    const original = 'model = "gpt-5"\nnotify = ["python3", "/Users/me/notify.py"]\n\n[tui]\nnotifications = ["agent-turn-complete"]\n';
    const cfg = join(codexHome, 'config.toml');
    await writeFile(cfg, original);

    for (const apply of [false, true]) {
      const res = runPlan(root, { home, codexHome, apply });
      strictEqual(res.status, 0, res.stderr);
      strictEqual(await readFile(cfg, 'utf8'), original, `host config must be byte-identical (apply=${apply})`);
    }
    // Codex-caught: the "wrapper-chain" title must be earned, not just asserted
    // by byte-identity. Prove the plan RECOGNIZED the existing notifier and
    // preserved it in a wrapper chain (a plan that clobbered it would still be
    // byte-identical on disk but wrong).
    const np = JSON.parse(runPlan(root, { home, codexHome, apply: false }).stdout).notification_plan;
    strictEqual(np.recommended.mode, 'wrapper-chain', 'an existing notifier triggers the wrapper-chain mode');
    ok(
      np.scripts.chain.content.includes('/Users/me/notify.py'),
      'the prior notifier is preserved (embedded) in the rendered chain script',
    );
  });
});

// ===========================================================================
// (e) ADR-0010 sec.5 subprocess-only boundary -- the emit substrate is never imported
// ===========================================================================

describe('ADR-0040 acceptance (e) -- attention + persona self-sensors reach notify.mjs only by subprocess', () => {
  // The runtime emit substrate (notify.mjs emitter, notify-schema.mjs contract
  // lib) is L1 runtime; attention is a separate L1 plugin and the personas are
  // L2/L3 -- none may import across the seam (ADR-0010 sec.5). They reach the
  // emitter by SUBPROCESS and hold the sec.1 contract by COPY (behavioral parity
  // is enforced by tests/plugin-shape/test-attention-plugin.mjs). This scan is the
  // boundary gate, mirroring the ADR-0039 footer.mjs precedent.
  //
  // STATIC-ANALYSIS LIMIT (same as the footer gate): a fully computed dynamic
  // import (specifier assembled at runtime) cannot be caught by a source scan.
  // The subprocess-only convention + code review + the per-plugin tests are the
  // backstop for that residual. This catches every LITERAL import/require/export
  // form, including re-exports and template-literal specifiers. Statements are
  // anchored at line start so a subprocess string arg -- join(runtimeRoot,
  // 'scripts', 'notify.mjs') -- or a prose mention is NOT flagged; only a real
  // import statement or an import()/require() call is.
  const SCANNED_DIRS = ['plugins/attention', 'plugins/designer', 'plugins/engineer', 'plugins/founder', 'plugins/orchestrator'];
  // Regex-escaped module basenames of the runtime emit substrate.
  const TARGETS = ['notify\\.mjs', 'notify-schema\\.mjs'];
  // A specifier's opening quote (', ", or backtick) and its body (no quote, no
  // newline). Single-quoted JS strings carry the literal backtick safely.
  const SPEC_OPEN = '[`\'"]';
  const SPEC_BODY = '[^`\'"\\n]';
  const patternsFor = (mod) => [
    new RegExp(`^\\s*import\\b[^\\n]*\\bfrom\\s*${SPEC_OPEN}${SPEC_BODY}*${mod}`, 'm'),
    new RegExp(`^\\s*import\\s*${SPEC_OPEN}${SPEC_BODY}*${mod}`, 'm'),
    new RegExp(`^\\s*export\\b[^\\n]*\\bfrom\\s*${SPEC_OPEN}${SPEC_BODY}*${mod}`, 'm'),
    // MULTILINE import/export (Codex-caught false-negative): a common
    //   import {
    //     runEmit
    //   } from '../../runtime/scripts/notify.mjs';
    // puts `from` on a CONTINUATION line, which the single-line `import ... from`
    // patterns miss. Match a line whose leading token is `from '<spec>'` or
    // `} from '<spec>'`. A prose line (`// from '...'`) starts with `//`, not
    // this shape, so it is not flagged; a subprocess arg has no `from '<spec>'`.
    new RegExp(`^\\s*\\}?\\s*from\\s*${SPEC_OPEN}${SPEC_BODY}*${mod}`, 'm'),
    new RegExp(`\\bimport\\s*\\(\\s*${SPEC_OPEN}${SPEC_BODY}*${mod}`),
    new RegExp(`\\brequire\\s*\\(\\s*${SPEC_OPEN}${SPEC_BODY}*${mod}`),
  ];

  async function collectFiles(dir) {
    const out = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...await collectFiles(p));
      else if (/\.(mjs|js|cjs|md)$/.test(e.name)) out.push(p);
    }
    return out;
  }

  for (const rel of SCANNED_DIRS) {
    it(`${rel} imports neither runtime notify.mjs nor notify-schema.mjs`, async () => {
      const files = await collectFiles(resolve(REPO_ROOT, rel));
      ok(files.length > 0, `expected to scan files under ${rel}`);
      for (const file of files) {
        const text = await readFile(file, 'utf8');
        for (const mod of TARGETS) {
          for (const pattern of patternsFor(mod)) {
            ok(
              !pattern.test(text),
              `${file} imports the L1 runtime emit substrate (${pattern}) -- ADR-0010 sec.5 forbids the cross-plugin import; reach notify.mjs by subprocess and hold the sec.1 contract by copy`,
            );
          }
        }
      }
    });
  }
});
