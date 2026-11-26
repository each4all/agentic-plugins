// A signal's stop of the mutation harness while a test run's scope is being
// ended (ADR-0023, amendments of 2026-11-22 and 2026-11-24, the mutation
// harness; C154): `stopRuns`, which the CLI awaits on SIGTERM or SIGINT before
// it removes the copies and releases the lock, must not answer that every run
// has settled while a scoped run's end is still in progress, though its
// supervisor has exited and its group is gone. The scope hooks are fakes, as in
// test-mutation-harness-scope.mjs; a file of its own, since `stopRuns` leaves
// the harness refusing every further run.

import { describe, it } from 'node:test';
import { strictEqual } from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tmpDir } from '../_tmp.mjs';
import { runTests, stopRuns } from '../../scripts/mutation-harness.mjs';

const BOUNDED = { timeout: 60_000 };
const BOOT = '0123abcd-0000-4000-8000-00000000beef';
const CLOCK = `${BOOT}/-/pid:[4026531836]`;

describe('a signal\'s stop while a scoped run ends', () => {
  it('stopRuns does not answer settled while a scoped run\'s end is pending, and does once it settles', BOUNDED, async (t) => {
    const root = tmpDir(t, 'harness-scope-stop-');
    const copy = join(root, 'copy');
    mkdirSync(join(copy, 'tests'), { recursive: true });
    writeFileSync(join(copy, 'tests', 'test-value.mjs'), "import { test } from 'node:test';\ntest('value', () => {});\n");
    const path = join(root, 'mutation-harness.lock');
    const token = randomUUID();
    mkdirSync(join(`${path}.groups`, token), { recursive: true });
    const ownership = { path, token, chain: [token] };

    let endCalled;
    const ending = new Promise((wake) => { endCalled = wake; });
    let settleEnd;
    const endSettles = new Promise((wake) => { settleEnd = wake; });
    const scope = {
      plan: () => ({ kind: 'gated' }),
      spawnGated: ({ command, args, options }) => spawn(command, args, options),
      handshake: async (child, { unit, owner, record }) => {
        const identity = {
          owner,
          unit,
          invocation_id: 'c'.repeat(32),
          cgroup_path: `/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}`,
          cgroup_id: '778',
          boot_id: BOOT,
          gate: { pid: child.pid, starttime: '10', clock: CLOCK },
          supervisor: { pid: process.pid, fingerprint: { kind: 'linux_proc_starttime', starttime: '5' }, clock: CLOCK, boot_id: BOOT },
          has_snapshot: false,
          association: null,
        };
        await record(identity);
        return { launched: true, identity };
      },
      end: async () => {
        endCalled();
        return endSettles;
      },
    };
    const run = runTests(copy, ['tests/test-value.mjs'], { ownership, scope, timeoutSeconds: 30 }).catch((err) => err);
    try {
      // The supervisor has exited and its group has ended: the run is ending
      // its scope.
      await ending;
      strictEqual(await stopRuns(300), false, 'a scoped run\'s end in progress is not settled');
      const later = stopRuns(20_000);
      settleEnd({ state: 'gone' });
      strictEqual(await later, true, 'settled once its end is');
    } finally {
      // The run's end settles whatever was asserted, so the file never waits
      // on its timers.
      settleEnd({ state: 'gone' });
      await run;
    }
  });
});
