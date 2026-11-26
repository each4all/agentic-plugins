// C154 (ADR-0023 §6, amendments of 2026-11-22 and 2026-11-24, the mutation
// harness) — a test run's descendant that leaves the run's process group (a
// detached spawn, in a session of its own) outlived every harness before the
// scope: no group signal reaches it. With the scope, the harness's own end of
// the run ends it before the run's entry goes; and when the harness is killed
// with SIGKILL, the next acquirer of the lock proves the harness gone, ends the
// scope through the entry's identity and takes the lock only once it reads the
// scope gone, while a user process outside the run survives.
//
// Large tier (scripts/data/test-tiers.json): it runs the harness on this
// machine's systemd user manager, kills it, and waits on real time for the
// scope's end. It skips, with the reason, where no scope can be made (no user
// manager, or this process runs inside another launcher's scope). It checks
// only the pids it planted, never the whole process table.

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { acquireRunLock, runTests } from '../../scripts/mutation-harness.mjs';
import { ownershipGroups } from '../../plugins/orchestrator/scripts/lib/heavy-lock.mjs';
import { planHarnessScope } from '../../plugins/orchestrator/scripts/lib/heavy-scope.mjs';
import {
  BOUNDED, HARNESS, lockOf, makeRepo, running, spawnNode, testEnv, tracker, until, write,
} from '../orchestrator/_heavy-lock-fixtures.mjs';

const plan = planHarnessScope();
const skip = plan.kind === 'gated' ? false : `no scope can be made here (${plan.record?.reason}${plan.why ? `: ${plan.why}` : ''})`;

// A repository whose one test leaves a process in a session of its own, notes
// its pid in `leftover`, and passes; with `hang`, it then waits for ever.
function repo(t, leftover, { hang = false } = {}) {
  const root = t.dir(makeRepo());
  t.lock(lockOf(root));
  write(root, 'tests/test-left.mjs', [
    "import { test } from 'node:test';",
    "import { appendFileSync } from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "const s = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
    's.unref();',
    `appendFileSync(${JSON.stringify(leftover)}, s.pid + '\\n');`,
    hang ? 'await new Promise(() => setInterval(() => {}, 1000));' : '',
    "test('left', () => {});",
    '',
  ].join('\n'));
  write(root, 'spec.mjs', [
    "export const TESTS = ['tests/test-left.mjs'];",
    "export const MUTATIONS = [{ id: 'K', file: 'tests/test-left.mjs', from: \"test('left'\", to: \"test('right'\", why: 'renames it', expect: 'SURVIVED' }];",
    '',
  ].join('\n'));
  return root;
}

// A user process outside any run, which must survive.
function outsider(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  return t.pid(child.pid);
}

describe('a test run\'s descendant that left its group', { skip }, () => {
  it('ends with the run: the harness ends the run\'s scope before its entry goes', BOUNDED, async () => {
    const t = tracker();
    try {
      const S = t.scratch();
      const leftover = join(S, 'left');
      const root = repo(t, leftover);
      const outside = outsider(t);
      const lock = await acquireRunLock(root, { log: () => {} });
      try {
        const out = await runTests(root, ['tests/test-left.mjs'], { ownership: lock.ownership });
        strictEqual(out.status, 0, out.stdout);
        const [left] = t.pidFile(leftover);
        ok(Number.isInteger(left), 'the test noted its leftover');
        ok(!running(left), `pid ${left}, in a session of its own, was gone when the run settled`);
        strictEqual(ownershipGroups(lock.path, lock.ownership.token).length, 0, 'and the entry went');
      } finally {
        lock.release();
      }
      ok(running(outside), 'a process outside the run survives');
    } finally {
      t.cleanUp();
    }
  });

  it('a harness killed with SIGKILL: the next acquirer ends the scope before it takes the lock', BOUNDED, async () => {
    const t = tracker();
    try {
      const S = t.scratch();
      const leftover = join(S, 'left');
      const root = repo(t, leftover, { hang: true });
      const outside = outsider(t);
      // A harness killed with SIGKILL never removes its work directory: make
      // it in the scratch directory, which cleanUp removes.
      const cli = spawnNode([HARNESS, 'spec.mjs', '--repo-root', root, '--timeout', '600'], { cwd: root, env: testEnv({ TMPDIR: S }), track: t });
      ok(await until(() => t.pidFile(leftover).length === 1, 30_000), cli.output());
      const [left] = t.pidFile(leftover);
      cli.child.kill('SIGKILL');
      await cli.exited;
      // The supervisor stops the run's group when its lifeline ends; the
      // leftover, in a session of its own, is not in it.
      await new Promise((wake) => { setTimeout(wake, 500); });
      ok(running(left), 'the leftover outlived the harness and its supervisor');
      const said = [];
      const lock = await acquireRunLock(root, { log: (l) => said.push(l), pollMs: 20 });
      try {
        ok(!running(left), `pid ${left} was ended before the lock was taken\n${said.join('\n')}`);
        ok(said.some((l) => l.includes('removed a stale run lock')), said.join('\n'));
      } finally {
        lock.release();
      }
      ok(running(outside), 'a process outside the run survives');
    } finally {
      t.cleanUp();
    }
  });
});
