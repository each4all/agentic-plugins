// A mutation-harness test run in a scope of its own (ADR-0023, amendments of
// 2026-11-22 and 2026-11-24, the mutation harness; C154), through runTests with
// its scope hooks replaced: the gate is a plain child, the handshake and the
// scope's end are fakes, so no systemd is needed. What it holds: the identity
// is on the run's entry before the supervisor's go line; a failure before the
// word marks the entry abandoned and the run starts as before; a scope not read
// gone at the run's end is no verdict, keeps the entry, and starts no further
// run in this harness. The last case leaves the harness refusing runs, so it
// comes last. A live scope is test-mutation-harness-scope-live.mjs's.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tmpDir } from '../_tmp.mjs';
import { MutationHarnessError, removeCopies, runTests } from '../../scripts/mutation-harness.mjs';
import { ownershipGroups } from '../../plugins/orchestrator/scripts/lib/heavy-lock.mjs';
import { scopeCollector } from '../../plugins/orchestrator/scripts/lib/heavy-scope.mjs';

const BOUNDED = { timeout: 90_000 };
const BOOT = '0123abcd-0000-4000-8000-00000000beef';
const CLOCK = `${BOOT}/-/pid:[4026531836]`;

function setUp(t) {
  const root = tmpDir(t, 'harness-scope-');
  const copy = join(root, 'copy');
  mkdirSync(join(copy, 'tests'), { recursive: true });
  writeFileSync(join(copy, 'tests', 'test-value.mjs'), "import { test } from 'node:test';\ntest('value', () => {});\n");
  const path = join(root, 'mutation-harness.lock');
  const token = randomUUID();
  mkdirSync(join(`${path}.groups`, token), { recursive: true });
  return { copy, ownership: { path, token, chain: [token] } };
}

const entries = ({ path }) => readdirSync(`${path}.groups`).flatMap((d) => readdirSync(join(`${path}.groups`, d))
  .filter((n) => n.endsWith('.json')).map((n) => ({ name: n, entry: JSON.parse(readFileSync(join(`${path}.groups`, d, n), 'utf8')) })));

function identityFor(owner, unit, pid) {
  return {
    owner,
    unit,
    invocation_id: 'b'.repeat(32),
    cgroup_path: `/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}`,
    cgroup_id: '777',
    boot_id: BOOT,
    gate: { pid, starttime: '10', clock: CLOCK },
    supervisor: { pid: process.pid, fingerprint: { kind: 'linux_proc_starttime', starttime: '5' }, clock: CLOCK, boot_id: BOOT },
    has_snapshot: false,
    association: null,
  };
}

// Hooks whose gate is the supervisor itself, spawned as runDirect spawns it;
// `answer` decides the handshake, `end` the scope's end. `log` keeps the order.
// In this process, a signal to a group (but the probe) is refused (EPERM)
// until the returned function is called, which also kills the group `pgid()`.
function holdGroupKills(pgid) {
  const kill = process.kill;
  process.kill = (pid, signal) => {
    if (pid < 0 && signal !== 0) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    return kill.call(process, pid, signal);
  };
  return () => {
    process.kill = kill;
    try { process.kill(-pgid(), 'SIGKILL'); } catch { /* gone */ }
  };
}

// A gate that runs nothing and leaves a second member in its group.
const GATE_WITH_MEMBER = "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000);";

function hooks({ answer = 'launch', end = { state: 'gone' }, gate = null } = {}) {
  const log = [];
  return {
    log,
    plan: () => ({ kind: 'gated' }),
    spawnGated: ({ command, args, options }) => {
      log.push('spawn');
      // For a failure before the word, a gate that waits and has run nothing.
      if (gate !== null) return spawn(process.execPath, ['-e', gate], options);
      return answer === 'launch' ? spawn(command, args, options) : spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
    },
    handshake: async (child, { unit, owner, record }) => {
      const identity = identityFor(owner, unit, child.pid);
      await record(identity);
      log.push('recorded');
      if (answer === 'launch') return { launched: true, identity };
      return { launched: false, check: 'clock-tick', recorded: true };
    },
    end: async () => {
      log.push('end');
      return end;
    },
  };
}

describe('a test run in a scope', () => {
  it('records the identity on its entry before the go line, ends the scope, and goes only on a reading of gone', BOUNDED, async (t) => {
    const { copy, ownership } = setUp(t);
    const scope = hooks();
    let atGo = null;
    const out = await runTests(copy, ['tests/test-value.mjs'], {
      ownership,
      scope,
      beforeGo: (child) => { atGo = { pid: child.pid, entries: entries(ownership) }; },
    });
    strictEqual(out.status, 0, out.stdout);
    strictEqual(atGo.entries.length, 1);
    const [{ name, entry }] = atGo.entries;
    strictEqual(entry.pgid, atGo.pid, 'the gate leads the run\'s group');
    strictEqual(entry.scope.state, 'scoped', 'the identity was recorded before the go line');
    deepStrictEqual(entry.scope.identity.owner, { kind: 'harness-launch', token: ownership.token, entry: name });
    strictEqual(entry.copy.path, copy);
    ok(/^[0-9]+$/.test(entry.copy.ino));
    deepStrictEqual(scope.log, ['spawn', 'recorded', 'end']);
    deepStrictEqual(entries(ownership), [], 'unregistered on gone');
  });

  it('a failure before the word marks the entry abandoned, drains the gate and starts the run as before', BOUNDED, async (t) => {
    const { copy, ownership } = setUp(t);
    const scope = hooks({ answer: 'fail' });
    const seen = [];
    const out = await runTests(copy, ['tests/test-value.mjs'], {
      ownership,
      scope,
      beforeGo: () => { seen.push(...entries(ownership)); },
    });
    strictEqual(out.status, 0, out.stdout);
    deepStrictEqual(scope.log, ['spawn', 'recorded'], 'no scope end: nothing ran in the scope');
    strictEqual(seen.length, 1, 'only the direct run\'s entry is left by its go line');
    deepStrictEqual(seen[0].entry.scope, { version: 1, state: 'none', reason: 'unavailable' }, 'the direct run says why it has no scope');
    deepStrictEqual(entries(ownership), []);
  });

  it('the abandoned mark is on the gate\'s entry before it goes: a gate whose group will not end keeps it, marked', BOUNDED, async (t) => {
    const { copy, ownership } = setUp(t);
    let gatePid = null;
    const scope = hooks({ answer: 'fail', gate: GATE_WITH_MEMBER });
    const spawnGated = scope.spawnGated;
    scope.spawnGated = (o) => { const c = spawnGated(o); gatePid = c.pid; return c; };
    // The handshake fails once the gate's second member runs.
    const handshake = scope.handshake;
    scope.handshake = async (...args) => { await new Promise((wake) => { setTimeout(wake, 1000); }); return handshake(...args); };
    const restore = holdGroupKills(() => gatePid);
    try {
      await rejects(runTests(copy, ['tests/test-value.mjs'], { ownership, scope }),
        (err) => err instanceof MutationHarnessError && /gate still runs 5 s after its launch failed/.test(err.message));
      const kept = entries(ownership);
      strictEqual(kept.length, 1);
      strictEqual(kept[0].entry.scope.state, 'abandoned', 'marked before the drain, and never left carrying a live identity');
    } finally {
      restore();
    }
  });

  it('a supervisor that does not exit after its group\'s SIGKILL still has its scope ended, and is no verdict', BOUNDED, async (t) => {
    const { copy, ownership } = setUp(t);
    let gatePid = null;
    const scope = hooks({ gate: 'setInterval(() => {}, 1000);' });
    const spawnGated = scope.spawnGated;
    scope.spawnGated = (o) => { const c = spawnGated(o); gatePid = c.pid; return c; };
    const restore = holdGroupKills(() => gatePid);
    try {
      await rejects(runTests(copy, ['tests/test-value.mjs'], { ownership, scope, timeoutSeconds: 1 }),
        (err) => err instanceof MutationHarnessError && /still runs 5 s after its runner ended/.test(err.message));
      deepStrictEqual(scope.log, ['spawn', 'recorded', 'end'], 'the scope was ended though no exit came');
      strictEqual(entries(ownership).length, 1, 'the entry stays while the group runs');
    } finally {
      restore();
    }
  });

  it('a scope not read gone fails the run as no verdict, keeps its entry and copies, and starts no further run', BOUNDED, async (t) => {
    const { copy, ownership } = setUp(t);
    // The run's group outlives its end too (its kills refused), so both the
    // scope and the group keep the copies.
    let gatePid = null;
    const scope = hooks({ end: { state: 'unproven' }, gate: GATE_WITH_MEMBER });
    const spawnGated = scope.spawnGated;
    scope.spawnGated = (o) => { const c = spawnGated(o); gatePid = c.pid; return c; };
    const restore = holdGroupKills(() => gatePid);
    const work = tmpDir(t, 'harness-scope-work-');
    const quiet = () => {};
    try {
      await rejects(runTests(copy, ['tests/test-value.mjs'], { ownership, scope, timeoutSeconds: 1 }),
        (err) => err instanceof MutationHarnessError && /is unproven after the run ended; .*no verdict.*systemctl --user stop agentic-launch-harness-/.test(err.message));
      const kept = entries(ownership);
      strictEqual(kept.length, 1, 'the entry stays');
      strictEqual(kept[0].entry.scope.teardown.state, 'unproven', 'with its teardown');
      const unproven = scopeCollector({ proveGone: () => ({ gone: false }), killScope: () => ({ state: 'written' }), readScope: () => ({ state: 'unproven' }) });
      strictEqual(ownershipGroups(ownership.path, ownership.token, { scopes: unproven }).length, 1, 'a reader counts it running');
      strictEqual(removeCopies(work, { read: () => ({ state: 'gone' }), log: quiet }), 'stuck',
        'a scope read gone later does not let the copies go while the group runs');
    } finally {
      restore();
    }
    for (let end = Date.now() + 5000; Date.now() < end;) {
      try { process.kill(-gatePid, 0); } catch { break; }
      await new Promise((wake) => { setTimeout(wake, 20); });
    }
    strictEqual(removeCopies(work, { read: () => ({ state: 'unproven' }), log: quiet }), 'kept-scope', 'the scope not read gone keeps the copies');
    ok(existsSync(work));
    strictEqual(removeCopies(work, { read: () => ({ state: 'gone' }), log: quiet }), 'removed', 'gone, with the group ended, lets them go');
    ok(!existsSync(work));
    await rejects(runTests(copy, ['tests/test-value.mjs'], { ownership, scope: hooks() }),
      (err) => err instanceof MutationHarnessError && /no further test run starts in this harness/.test(err.message));
  });
});
