// plugins/orchestrator/adapters/claude/autopilot/stall-sampler.mjs
//
// ADR-0068 Decision 3, items 4 and 6 — the run's one sampler of the process
// table: one read every 10 s for the whole run (§Consequences, slice 2), each
// snapshot handed to every worker registered when its read began, with the
// monotonic and the wall time it completed at. Each worker's detector judges
// the snapshot for its own tree (stall.mjs): one worker's busy child keeps
// that worker active and no other, and a counter that went back is that
// worker's unknown. A pid the read could not read is every worker's unknown
// (no pid can be ruled out of a tree without its identity).
//
// The cadence is fixed and never waits on a read: a read still running at a
// tick makes that tick `slow`, unknown for every worker, and no second read
// starts; a read past its deadline is `timeout`, and its late answer, should it
// come, is dropped. A worker registers at its spawn and unregisters at the
// watch's end; the sampler stops when none is registered. Nothing it does
// throws into a worker: a listener that throws is passed over.

import { performance } from 'node:perf_hooks';

import { PROBE_DEADLINE_MS, readProcessTable } from './procs.mjs';
import { SAMPLE_INTERVAL_MS } from './stall.mjs';

export const monoNow = () => performance.now();

/**
 * @param a.readTable   ({deadlineMs}) => Promise<snapshot> (procs.mjs readProcessTable)
 * @param a.intervalMs  the cadence
 * @param a.deadlineMs  one read's bound
 * @param a.mono, a.wall  the clocks (ms)
 * @returns { clock: {mono, wall}, register(listener) => { unregister() }, get size, get scans, stop() }
 *   listener(snapshot, mono, wall)
 */
export function createStallSampler({
  readTable = readProcessTable, intervalMs = SAMPLE_INTERVAL_MS, deadlineMs = PROBE_DEADLINE_MS,
  mono = monoNow, wall = () => Date.now(),
} = {}) {
  const listeners = new Set();
  let timer = null;
  let inFlight = false;
  let scans = 0;

  const deliver = (to, snapshot) => {
    const m = mono();
    const w = wall();
    for (const l of to) {
      if (!listeners.has(l)) continue;
      try { l(snapshot, m, w); } catch { /* the worker's, not the run's */ }
    }
  };

  const tick = () => {
    const to = [...listeners];
    if (inFlight) {
      deliver(to, { ok: false, why: 'slow' });
      return;
    }
    inFlight = true;
    scans += 1;
    let settled = false;
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      deliver(to, { ok: false, why: 'timeout' });
    }, deadlineMs);
    deadline.unref?.();
    let read;
    try {
      read = Promise.resolve(readTable({ deadlineMs }));
    } catch {
      read = Promise.resolve({ ok: false, why: 'failed' });
    }
    read.then((s) => s, () => ({ ok: false, why: 'failed' })).then((snapshot) => {
      inFlight = false;
      clearTimeout(deadline);
      if (settled) return; // late: its tick was already judged unknown
      settled = true;
      deliver(to, snapshot && typeof snapshot === 'object' ? snapshot : { ok: false, why: 'failed' });
    });
  };

  const start = () => {
    if (timer !== null) return;
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
  };
  const stop = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  return {
    // The clocks the snapshots are stamped with, which each worker's stream
    // events are stamped with too.
    clock: { mono, wall },
    get size() { return listeners.size; },
    get scans() { return scans; },
    register(listener) {
      listeners.add(listener);
      start();
      return {
        unregister() {
          listeners.delete(listener);
          if (listeners.size === 0) stop();
        },
      };
    },
    stop() {
      listeners.clear();
      stop();
    },
  };
}
