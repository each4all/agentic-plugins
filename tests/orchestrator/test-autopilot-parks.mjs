// tests/orchestrator/test-autopilot-parks.mjs
//
// ADR-0068 Decision 1, item 3 — the kept parks
// (plugins/orchestrator/adapters/claude/autopilot/parks.mjs): one record per
// subtask in the macro's holds directory, every change conditional on the
// record its writer last read, an unreadable record never overwritten, the
// records that no longer apply retired, the directory's lock (run-locks.mjs's:
// a live holder waited for and never taken over, a dead one cleared, a wait
// that ends), and a step's verdict read from a dead run's ledger.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PK = await import(resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/parks.mjs'));
const RL = await import(resolve(REPO_ROOT, 'plugins/orchestrator/scripts/lib/run-locks.mjs'));

const MACRO = 'macro-plan-20261001T000000Z-abcdef';
const record = (id, over = {}) => ({
  schema: PK.PARK_SCHEMA, record_id: PK.newRecordId(), macro_id: MACRO, subtask_id: id, state: 'parked', reason: 'owner-choice',
  detail: 'x', run_id: 'autopilot-20261001T000000Z-123456', ...over,
});
const withDir = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'parks-'));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
const lockOf = (main) => join(PK.parksDir(main, MACRO), '.lock');

describe('kept parks', () => {
  it('a record round-trips in the macro\'s holds directory, one file per subtask, and each change is in the events file', () => withDir(async (main) => {
    const a = record('A.1');
    deepStrictEqual(await PK.writePark(main, MACRO, a), { ok: true, record: a });
    strictEqual(PK.parkPath(main, MACRO, 'A.1'), join(main, '.agentic-plugins/runs/autopilot/holds', MACRO, 'parks', 'A.1.json'));
    deepStrictEqual(PK.readPark(main, MACRO, 'A.1'), { state: 'ok', record: a });
    deepStrictEqual(PK.readParks(main, MACRO).records.map((r) => [r.subtaskId, r.state]), [['A.1', 'ok']]);
    ok((await PK.deletePark(main, MACRO, 'A.1', { expect: a.record_id, event: 'released' })).ok);
    deepStrictEqual(PK.readPark(main, MACRO, 'A.1'), { state: 'absent' });
    const events = readFileSync(join(PK.parksDir(main, MACRO), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).event);
    deepStrictEqual(events, ['parked', 'released']);
    deepStrictEqual(PK.readParks(main, 'macro-plan-20261001T000000Z-000000'), { records: [], problem: null }, 'a macro with none');
    deepStrictEqual(readdirSync(lockOf(main)), [], 'each writer left the lock');
  }));

  it('every change is conditional on the record id its writer last read', () => withDir(async (main) => {
    const marker = record('A', { state: 'in-flight', seq: 1 });
    ok((await PK.writePark(main, MACRO, marker, { expect: null })).ok);
    // A stale writer: it read no record, or another one.
    strictEqual((await PK.writePark(main, MACRO, record('A'), { expect: null })).ok, false);
    strictEqual((await PK.writePark(main, MACRO, record('A'), { expect: 'f'.repeat(16) })).ok, false);
    const parked = record('A');
    ok((await PK.writePark(main, MACRO, parked, { expect: marker.record_id })).ok, 'the park takes over its marker');
    // A settlement that read the marker no longer deletes the park.
    strictEqual((await PK.deletePark(main, MACRO, 'A', { expect: marker.record_id, event: 'settled' })).ok, false);
    strictEqual(PK.readPark(main, MACRO, 'A').record.record_id, parked.record_id);
    // A release of a record already gone does not recreate it either.
    ok((await PK.deletePark(main, MACRO, 'A', { expect: parked.record_id, event: 'released' })).ok);
    strictEqual((await PK.writePark(main, MACRO, record('A'), { expect: parked.record_id })).ok, false, 'a run never recreates a released park');
    deepStrictEqual(PK.readPark(main, MACRO, 'A'), { state: 'absent' });
  }));

  it('a record that cannot be read holds its subtask: it is never overwritten, and a release ends only the bytes it read', () => withDir(async (main) => {
    mkdirSync(PK.parksDir(main, MACRO), { recursive: true });
    writeFileSync(PK.parkPath(main, MACRO, 'A'), '{torn');
    const torn = PK.readPark(main, MACRO, 'A');
    strictEqual(torn.state, 'unreadable');
    strictEqual((await PK.writePark(main, MACRO, record('A'), { expect: null })).ok, false);
    strictEqual(readFileSync(PK.parkPath(main, MACRO, 'A'), 'utf8'), '{torn');
    // Other bytes since: not the record the release read.
    writeFileSync(PK.parkPath(main, MACRO, 'A'), '{torn, again');
    strictEqual((await PK.deletePark(main, MACRO, 'A', { expectDigest: torn.digest, event: 'released' })).ok, false);
    const marker = record('A', { state: 'in-flight', seq: 2 });
    writeFileSync(PK.parkPath(main, MACRO, 'A'), JSON.stringify(marker));
    strictEqual((await PK.deletePark(main, MACRO, 'A', { expectDigest: torn.digest, event: 'released' })).ok, false, 'nor a valid record written meanwhile');
    writeFileSync(PK.parkPath(main, MACRO, 'A'), '{torn');
    ok((await PK.deletePark(main, MACRO, 'A', { expectDigest: torn.digest, event: 'released' })).ok);
    deepStrictEqual(PK.readPark(main, MACRO, 'A'), { state: 'absent' });
    writeFileSync(PK.parkPath(main, MACRO, 'A'), '{torn');
    ok((await PK.deletePark(main, MACRO, 'A', { event: 'released' })).ok, 'with no expectation, whatever is there');
  }));

  it('the lock: a live holder is waited for until it lets go, never taken over; a holder that never does fails the wait; a dead one is cleared', () => withDir(async (main) => {
    mkdirSync(PK.parksDir(main, MACRO), { recursive: true });
    const held = await RL.acquireLock(lockOf(main), { record: { run_id: 'a live holder' } });
    const wrote = PK.writePark(main, MACRO, record('A'));
    await pause(300);
    strictEqual(PK.readPark(main, MACRO, 'A').state, 'absent', 'the writer waits while the holder lives');
    held.release();
    ok((await wrote).ok, 'and writes once it let go');
    const stuck = await RL.acquireLock(lockOf(main), { record: { run_id: 'a holder that never lets go' } });
    await rejects(PK.writePark(main, MACRO, record('B'), { waitMs: 300 }), /the park records' lock .* is held/);
    ok(readdirSync(lockOf(main)).includes(stuck.entry.split('/').pop()), 'the live holder\'s entry is left as it is');
    stuck.release();
    // An entry whose process is gone.
    const dead = await new Promise((r) => { const c = spawn(process.execPath, ['-e', '0']); c.on('exit', () => r(c.pid)); });
    writeFileSync(join(lockOf(main), `h-${dead}-abcdef.json`), JSON.stringify({ run_id: 'gone', pid: dead, fingerprint: { kind: 'none' }, worker: null }));
    ok((await PK.writePark(main, MACRO, record('C'), { waitMs: 300 })).ok, 'a dead holder is cleared');
  }));

  it('the lock: what is not a lock fails the writer at once, never retried until the wait ends', () => withDir(async (main) => {
    mkdirSync(PK.parksDir(main, MACRO), { recursive: true });
    writeFileSync(lockOf(main), 'not a lock directory');
    const t0 = Date.now();
    await rejects(PK.writePark(main, MACRO, record('A')), (e) => !/is held/.test(e.message));
    ok(Date.now() - t0 < 2000, `failed at once (${Date.now() - t0} ms)`);
  }));

  it('the records of subtasks that retire once their subtask completed or left the plan, or the macro was archived', () => {
    const records = [{ subtaskId: 'A' }, { subtaskId: 'B' }, { subtaskId: 'C' }];
    const view = (archived = false) => ({ macro: { archived, fm: { plan: { subtasks: [{ id: 'A', status: 'completed' }, { id: 'B', status: 'in_progress' }] } } } });
    deepStrictEqual(PK.retiring(records, view()), ['A', 'C']);
    deepStrictEqual(PK.retiring(records, view(true)), ['A', 'B', 'C']);
    deepStrictEqual(PK.retiring(records, { macro: null }), [], 'a look that read no macro retires nothing');
  });

  it('a step\'s verdict is read from its run\'s ledger, and a step with none has none', () => withDir((dir) => {
    writeFileSync(join(dir, 'steps.jsonl'), [
      JSON.stringify({ event: 'started', seq: 1 }), JSON.stringify({ event: 'finished', seq: 1, outcome: 'worker-failed' }),
      JSON.stringify({ event: 'started', seq: 2 }), '{torn',
    ].join('\n'));
    strictEqual(PK.stepVerdict(dir, 1).outcome, 'worker-failed');
    strictEqual(PK.stepVerdict(dir, 2), null);
    strictEqual(PK.stepVerdict(join(dir, 'gone'), 1), null);
  }));
});
