// tests/orchestrator/test-autopilot-budget.mjs
//
// ADR-0067 Decision 6, Budgets are reserved — the run's budget
// (plugins/orchestrator/adapters/claude/autopilot/budget.mjs): a step reserves
// one step and min(per-step cap, run cap − spent − reserved) dollars before it
// spawns, every end settles it once (the reported cost, the whole reservation
// when none was reported, nothing when nothing spawned), a start blocked only
// by other steps' reservations waits instead of halting, and no run clock
// clips a step's timeout or exhausts the run (ADR-0063 D1, amendment of
// 2026-10-13).

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const B = await import(resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/budget.mjs'));

const caps = (over = {}) => {
  const budget = B.createBudget({ maxSteps: 10, maxCostUsd: 25, stepBudgetUsd: 25, stepTimeoutSec: 3600, ...over });
  return { budget };
};

describe('exhaustion, asked without reserving', () => {
  it('exhausted() names what is spent or taken, reserves nothing, and is null while only reservations block a start', () => {
    const { budget } = caps({ maxSteps: 2 });
    strictEqual(budget.exhausted(), null);
    const a = budget.reserve();
    strictEqual(budget.exhausted(), null, 'a reservation alone exhausts nothing');
    strictEqual(budget.inFlight, 1, 'asking reserved nothing');
    budget.settle(a.reservation, { spawned: true, costUsd: 1 });
    budget.settle(budget.reserve().reservation, { spawned: true, costUsd: 1 });
    strictEqual(budget.exhausted(), 'the run reached its step cap (2)');
  });
});

describe('reservations under concurrent launches', () => {
  it('a $25 run whose first step reserved $25 is not exhausted: a second start waits, and may go once that step spends $1', () => {
    const { budget } = caps();
    const a = budget.reserve();
    strictEqual(a.ok, true);
    strictEqual(a.reservation.usd, 25);
    const b = budget.reserve();
    strictEqual(b.wait, true, 'blocked only by the reservation');
    strictEqual(b.exhausted, undefined);
    strictEqual(budget.settle(a.reservation, { spawned: true, costUsd: 1 }), 1);
    const c = budget.reserve();
    strictEqual(c.ok, true);
    strictEqual(c.reservation.usd, 24, 'what is left after what was spent');
  });

  it('each reservation is min(per-step cap, run cap − spent − reserved)', () => {
    const { budget } = caps({ maxCostUsd: 20, stepBudgetUsd: 8 });
    const usd = [budget.reserve(), budget.reserve(), budget.reserve()].map((r) => r.reservation?.usd ?? r);
    deepStrictEqual(usd, [8, 8, 4]);
    strictEqual(budget.reservedUsd, 20);
    strictEqual(budget.reserve().wait, true);
  });

  it('the step cap counts reserved steps: a start past it waits while steps are in flight, and is exhausted once they are taken', () => {
    const { budget } = caps({ maxSteps: 2, stepBudgetUsd: 1 });
    const a = budget.reserve().reservation;
    const b = budget.reserve().reservation;
    strictEqual(budget.reserve().wait, true);
    budget.settle(a, { spawned: true, costUsd: 0.1 });
    strictEqual(budget.reserve().wait, true, 'one taken, one in flight');
    budget.settle(b, { spawned: true, costUsd: 0.1 });
    const c = budget.reserve();
    strictEqual(c.exhausted, true);
    ok(/step cap \(2\)/.test(c.detail));
  });
});

describe('settlement on every end', () => {
  it('a missing cost report charges the whole reservation and marks the cost incomplete', () => {
    const { budget } = caps({ stepBudgetUsd: 5 });
    const r = budget.reserve().reservation;
    strictEqual(budget.settle(r, { spawned: true, costUsd: null }), 5);
    strictEqual(budget.spent, 5);
    strictEqual(budget.costComplete, false);
    strictEqual(budget.taken, 1);
  });

  it('a lane creation that halted before the spawn charges nothing, takes no step, and releases the reservation', () => {
    const { budget } = caps({ stepBudgetUsd: 5 });
    const r = budget.reserve().reservation;
    strictEqual(budget.settle(r, { spawned: false }), 0);
    deepStrictEqual([budget.spent, budget.taken, budget.inFlight, budget.reservedUsd, budget.costComplete], [0, 0, 0, 0, true]);
  });

  it('a reservation is settled once', () => {
    const { budget } = caps({ stepBudgetUsd: 5 });
    const r = budget.reserve().reservation;
    strictEqual(budget.settle(r, { spawned: true, costUsd: 2 }), 2);
    strictEqual(budget.settle(r, { spawned: true, costUsd: 2 }), 0);
    strictEqual(budget.spent, 2);
    strictEqual(budget.taken, 1);
  });

  it('a reported zero cost is spent as zero, not as the reservation', () => {
    const { budget } = caps({ stepBudgetUsd: 5 });
    strictEqual(budget.settle(budget.reserve().reservation, { spawned: true, costUsd: 0 }), 0);
    strictEqual(budget.costComplete, true);
  });
});

describe('exhaustion, and no run clock', () => {
  it('the run is exhausted when what is spent leaves less than the minimum step', () => {
    const { budget } = caps({ maxCostUsd: 1, stepBudgetUsd: 1 });
    budget.settle(budget.reserve().reservation, { spawned: true, costUsd: 0.6 });
    const r = budget.reserve();
    strictEqual(r.exhausted, true);
    ok(/spent \$0\.60 of its \$1 cap/.test(r.detail));
  });

  it('each reservation carries the whole per-step timeout, however long the run has gone on: no run clock clips it', () => {
    const { budget } = caps({ stepTimeoutSec: 3 * 86_400, stepBudgetUsd: 1 });
    for (let i = 0; i < 3; i += 1) {
      const r = budget.reserve().reservation;
      strictEqual(r.timeoutSec, 3 * 86_400);
      budget.settle(r, { spawned: true, costUsd: 0.1 });
    }
    strictEqual(budget.exhausted(), null, 'steps and cost decide, nothing else');
    // The run clock's API is gone with it.
    deepStrictEqual(['timeoutSecNow', 'deadlineSec'].filter((k) => k in budget), []);
  });
});
