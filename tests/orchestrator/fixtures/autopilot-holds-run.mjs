// tests/orchestrator/fixtures/autopilot-holds-run.mjs
//
// What the release tests of a run with lanes share
// (test-autopilot-scheduler-releases*.mjs, ADR-0068 Decision 2, item 7): a
// held lane set up before the run, a release with a given basis, the driver's
// basis seam counting its comparisons, and a kept park record.

import { strictEqual } from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AP, COMMIT } from './autopilot-lanes-run.mjs';

const LIB = resolve(AP, '../../../scripts/lib');
export const H = await import(pathToFileURL(join(LIB, 'holds.mjs')).href);
export const OPS = await import(pathToFileURL(join(LIB, 'hold-ops.mjs')).href);
export const RL = await import(pathToFileURL(join(LIB, 'run-locks.mjs')).href);
export const P = await import(pathToFileURL(join(AP, 'parks.mjs')).href);
export const OL = await import(pathToFileURL(join(AP, 'offloop.mjs')).href);
export const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });

export const BASIS = Object.freeze({ fingerprint_version: 3, fingerprint: 'f', tree_digest: 't', content_digest: 'c', child: null });
export const scenario = () => ({ A: { next: [COMMIT], file: 'a.txt' }, B: { next: [COMMIT], file: 'b.txt' } });

// A held lane: the hold set and its handoff acked, before the run.
export async function held(t, id = 'A', { lane = null } = {}) {
  const h = await OPS.setHold({ mainRoot: t.work, macroId: t.fx.macroId, subtaskId: id, branch: `feat/${id.toLowerCase()}`, lane, child: null });
  const r = await OPS.completeHandoff({ mainRoot: t.work, macroId: t.fx.macroId, subtaskId: id, stateRoots: [t.work] });
  strictEqual(r.state, 'held');
  return h;
}
export const release = (t, h, basisOf, id = 'A') => OPS.releaseHold({
  mainRoot: t.work, macroId: t.fx.macroId, subtaskId: id, holdId: h.hold_id, stateRoots: [t.work], basisOf,
  keptParkId: (x) => { const p = P.readPark(t.work, t.fx.macroId, x); return p.state === 'ok' ? p.record.record_id : null; },
});
export const releaseOf = (t, id = 'A') => H.readRecord(t.work, t.fx.macroId, 'releases', id).record;
export const laneEvents = (t, r) => {
  const file = join(r.dir, 'lanes.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
// The driver's basis seam, counting the comparisons of each subtask.
export function basisSeam(value) {
  const calls = [];
  return { calls, fn: async (id, a) => { calls.push(id); return typeof value === 'function' ? value(id, a) : value; } };
}
export const parkRecord = (t, fields = {}) => ({
  schema: P.PARK_SCHEMA, record_id: P.newRecordId(), macro_id: t.fx.macroId, subtask_id: 'A', run_id: 'autopilot-20261026T000000Z-000000',
  run_dir: null, at: new Date().toISOString(), state: 'parked', reason: 'owner-choice', detail: 'parked by the test', pointer: null,
  proposals: [], release_only: true, form: 'no-worktree', fingerprint: null, fingerprint_version: 3, lane_path: null, branch: 'feat/a',
  seq: null, step_kind: null, since: new Date().toISOString(), resolution: null, ...fields,
});
// A run that must end: one still going after `ms` is stopped through the
// test's signals (SIGTERM) and fails the test. A defect that keeps a lane
// waiting forever then fails in bounded time, never hangs the file (a
// node:test timeout fails the test but leaves the run going, so the file
// never exits). Below the suite's --test-timeout (120 s), so it fires first.
export async function bounded(t, opts = {}, deps = {}, ms = 90_000) {
  let timer;
  let late = false;
  const running = t.run(opts, deps);
  try {
    await Promise.race([running, new Promise((r) => { timer = setTimeout(() => { late = true; r(); }, ms); })]);
  } finally {
    clearTimeout(timer);
  }
  if (!late) return running;
  t.signals.emit('SIGTERM');
  await running;
  throw new Error(`the run did not end within ${ms} ms (stopped):\n${t.lines.join('\n')}`);
}
// Wait until `cond()` holds, up to 30 s.
export async function until(cond) {
  for (let i = 0; i < 600 && !cond(); i += 1) await pause(50);
  return cond();
}
