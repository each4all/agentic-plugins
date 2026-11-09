// tests/orchestrator/test-autopilot-offloop-interrupt.mjs
//
// ADR-0067 Decision 6 — the run's interrupt of the tasks a run with lanes
// runs off its loop (plugins/orchestrator/adapters/claude/autopilot/
// offloop.mjs createTaskRunner): a task that only reads is stopped at once,
// one that changes what the next run finds gets the bound, counted from the
// interrupt. A large-tier test (scripts/data/test-tiers.json): it bounds real
// elapsed time to within 200 ms and 450 ms, which a pool that keeps every CPU
// busy can stretch, so it runs in npm test's low-concurrency pass. The rest
// of offloop.mjs: tests/orchestrator/test-autopilot-offloop.mjs.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const { createTaskRunner } = await import(resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/offloop.mjs'));

const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });

describe('createTaskRunner: the run\'s interrupt', () => {
  it('stops a look, a fetch and the landing report in flight at once, gives a lane\'s creation or removal and a peer cancellation the bound, and the bound holds for a task started after it', { timeout: 20_000 }, async () => {
    // Each fake task waits until it is stopped, and says when.
    const fake = async (task, args, o) => {
      await o.hold({ pid: 40000 + task.length, pgid: 40000 + task.length, fingerprint: null, task });
      return new Promise((res) => {
        o.signal.addEventListener('abort', () => res({ error: String(o.signal.reason) }), { once: true });
      });
    };
    const runner = createTaskRunner({ offLoop: fake, boundMs: 1000 });
    const reads = ['observe', 'fetchBaseline', 'reportLanding'].map((t) => runner.run(t, {}));
    const changes = ['createLane', 'removeLane', 'cancelPeerRuns'].map((t) => runner.run(t, {}));
    await pause(20);
    strictEqual(runner.groups().length, 6, 'every task in flight lists its group');
    const at = Date.now();
    runner.interrupt();
    for (const r of await Promise.all(reads)) strictEqual(r.error, 'the run was interrupted');
    ok(Date.now() - at < 200, 'the tasks that only read are stopped at once');
    await pause(600);
    const later = runner.run('observe', {});
    for (const r of await Promise.all(changes)) match(r.error, /did not finish within 1 s of the interrupt/);
    ok(Date.now() - at >= 950, 'the tasks that change what the next run finds got the bound');
    match((await later).error, /did not finish within 1 s of the interrupt/);
    ok(Date.now() - at < 1450, 'a task started after the interrupt gets what is left of the bound, counted from the interrupt');
    deepStrictEqual(runner.groups(), []);
  });
});
