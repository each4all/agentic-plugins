// plugins/orchestrator/adapters/claude/autopilot/budget.mjs
//
// ADR-0067 Decision 6, Budgets are reserved. Before a spawn the driver
// reserves one step and min(per-step cap, run cap − spent − reserved) dollars,
// and every way a step can end settles that reservation: an exit, an abort, a
// spawn error, a lane creation that halts before the spawn, a missing cost
// report. The reported cost is spent, or the whole reservation when no cost
// was reported (nothing when nothing was spawned), and the reservation is
// released.
//
// The run's budget is exhausted only when what is already spent or the steps
// already taken leave too little; a start blocked only by other steps'
// reservations waits for them to settle, then decides again. A serial run
// holds one reservation at a time, so for it these are the checks and the
// arithmetic the driver always made. No run clock bounds a step (ADR-0063 D1,
// amendment of 2026-10-13): each worker gets the whole per-step timeout,
// however late in the run it starts.

// A step with less than this left of the run's cost cap is not started.
export const MIN_STEP_BUDGET_USD = 0.5;

/**
 * @param o.maxSteps, o.maxCostUsd, o.stepBudgetUsd, o.stepTimeoutSec  the run's caps
 */
export function createBudget({ maxSteps, maxCostUsd, stepBudgetUsd, stepTimeoutSec }) {
  const open = new Map();
  let nextId = 1;
  const st = { spent: 0, taken: 0, costComplete: true, settled: new Set() };
  const reservedUsd = () => [...open.values()].reduce((a, r) => a + r.usd, 0);

  // What is spent or the steps taken leave too little: the detail, or null.
  const exhausted = () => {
    if (st.taken >= maxSteps) return `the run reached its step cap (${maxSteps})`;
    if (maxCostUsd - st.spent < MIN_STEP_BUDGET_USD) return `the run spent $${st.spent.toFixed(2)} of its $${maxCostUsd} cap`;
    return null;
  };

  return {
    /**
     * Reserve one step. { ok: true, reservation: {id, usd, timeoutSec} } |
     * { wait: true, why } (only other steps' reservations block it) |
     * { exhausted: true, detail }.
     */
    reserve() {
      const spentOut = exhausted();
      if (spentOut) return { exhausted: true, detail: spentOut };
      if (st.taken + open.size >= maxSteps) {
        return { wait: true, why: `${open.size} step(s) in flight hold the rest of the step cap (${maxSteps})` };
      }
      const left = maxCostUsd - st.spent - reservedUsd();
      if (left < MIN_STEP_BUDGET_USD) {
        return { wait: true, why: `steps in flight hold $${reservedUsd().toFixed(2)} of the $${(maxCostUsd - st.spent).toFixed(2)} left` };
      }
      const reservation = {
        id: nextId,
        usd: Math.min(stepBudgetUsd, left),
        timeoutSec: stepTimeoutSec,
      };
      nextId += 1;
      open.set(reservation.id, reservation);
      return { ok: true, reservation };
    },

    /**
     * Settle a reservation once, on every end: `spawned` false (a spawn that
     * never happened, a lane creation that halted first) charges nothing; a
     * spawned step is charged its reported cost, or the whole reservation when
     * it reported none. Returns what was charged (0 for a second settle).
     */
    settle(reservation, { spawned, costUsd = null }) {
      if (!reservation || st.settled.has(reservation.id) || !open.has(reservation.id)) return 0;
      open.delete(reservation.id);
      st.settled.add(reservation.id);
      if (!spawned) return 0;
      const reported = typeof costUsd === 'number' && Number.isFinite(costUsd);
      const charged = reported ? costUsd : reservation.usd;
      if (!reported) st.costComplete = false;
      st.spent += charged;
      st.taken += 1;
      return charged;
    },

    /** Whether the run is exhausted whatever settles: its detail, or null. Reserves nothing. */
    exhausted,

    get spent() { return st.spent; },
    get taken() { return st.taken; },
    get costComplete() { return st.costComplete; },
    get inFlight() { return open.size; },
    get reservedUsd() { return reservedUsd(); },
  };
}
