// tests/orchestrator/test-autopilot-critique-cap.mjs
//
// C176 (ADR-0063, amendment of 2026-11-09) — the critique cap's owner gate,
// `critique-cap`, end to end with no model (fixtures/autopilot-lanes-run.mjs:
// the fake claude, the scripted worker doing each step through the real state
// CLIs, real git worktrees). A critique that ends at its subtask's cap with
// findings still open records the gate on its workflow (engineer's
// finish-verb, tests/persona-pipeline/test-critique-convergence.mjs); here:
//
//   - the serial driver halts awaiting-owner:critique-cap, naming the subtask;
//   - with lanes, the gate parks only its lane while the other completes;
//   - the owner's grant of further rounds (the clear, with the next step
//     refine) picks the parked lane up again, and it steps on to its commit.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { AP, COMMIT, setup, stepsOf } from './fixtures/autopilot-lanes-run.mjs';

const P = await import(resolve(AP, 'policy.mjs'));
const GATE = 'critique-cap';
const REFINE = { kind: 'verb', verb: 'refine', confidence: 'HIGH' };
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });

// The owner grants one further round, as the critique-cap clear does: the
// clear, the grant and the next step refine in one write.
async function grant(t, id) {
  const workflowPath = readFileSync(join(t.dir, `child-${id}.path`), 'utf8');
  await t.fx.eng.clearAwaitingOwner({
    workflowPath, host: 'claude', gate: GATE, nextStep: REFINE, grantCritiqueRounds: 1,
    nextAction: 'Refine the open findings', resolution: 'the owner granted one more round', env: t.fx.env,
  });
}

describe('C176: the critique-cap gate', () => {
  it('is one of the engineer gates the policy knows', () => {
    ok(P.ENGINEER_OWNER_GATES.includes(GATE));
  });

  it('the serial driver halts awaiting-owner:critique-cap, naming the subtask', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT] }, actions: { 1: `gate:${GATE}` } } });
    try {
      strictEqual(await t.run({ lanes: 1 }), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual([r.halt.reason, r.halt.subtask_id], [`awaiting-owner:${GATE}`, 'A'], JSON.stringify(r.halt));
      deepStrictEqual(stepsOf(r).map((x) => [x[2], x[3], x[4]]), [['dispatch', 'A', 'ok']]);
    } finally {
      t.fx.cleanup();
    }
  });

  it('with lanes, it parks only its lane while the other completes', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 1: `gate:${GATE}` } } });
    try {
      strictEqual(await t.run({}, { wakeIntervalMs: 300 }), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2], x[4]]).sort(), [['A', 'dispatch', 'ok'], ['B', 'commit', 'ok'], ['B', 'dispatch', 'ok']]);
      deepStrictEqual([r.halt.reason, r.halt.subtask_id], [`awaiting-owner:${GATE}`, 'A']);
      deepStrictEqual(r.halt.lanes.map((l) => [l.subtask_id, l.state]), [['A', 'parked'], ['B', 'waiting-to-land']]);
    } finally {
      t.fx.cleanup();
    }
  });

  it('park, then the owner\'s grant: the lane is picked up again, refines, and commits', async () => {
    const t = await setup({
      scenario: {
        A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' },
        actions: { 1: `gate:${GATE}`, 2: ['mark-start:b-started', 'wait:a-resumed'], 3: 'mark-start:a-resumed' },
      },
    });
    const owner = (async () => {
      for (let i = 0; i < 1200; i += 1) {
        if (existsSync(join(t.dir, 'b-started')) && t.lines.some((l) => l.startsWith('■ lane A: '))) {
          await grant(t, 'A');
          return true;
        }
        await pause(50);
      }
      return false;
    })();
    try {
      strictEqual(await t.run({}, { wakeIntervalMs: 300 }), 2, t.lines.join('\n'));
      ok(await owner, 'the owner granted a round while B ran');
      const r = t.latest();
      const a = stepsOf(r).filter((x) => x[1] === 'A').map((x) => [x[2], x[4]]);
      deepStrictEqual(a, [['dispatch', 'ok'], ['verb', 'ok'], ['commit', 'ok']], t.lines.join('\n'));
      strictEqual(r.halt.reason, 'awaiting-landing', `${JSON.stringify(r.halt)}\n${t.lines.join('\n')}`);
    } finally {
      t.fx.cleanup();
    }
  });
});
