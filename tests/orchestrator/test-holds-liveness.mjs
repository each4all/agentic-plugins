// tests/orchestrator/test-holds-liveness.mjs
//
// ADR-0068 Decision 2, item 4 and N3 (impl-hold) — a live run and a busy lane,
// seen from outside any driver (scripts/lib/holds.mjs `liveRuns`, `laneBusy`):
// a run is live while its driver lives, and what cannot be read is live; a
// lane is busy while a worker or task group of a run lives and names its
// subtask, or names none; a run that died with a step of the lane unfinished
// leaves the lane busy until it is cleaned up. The CLI's live run no longer
// fails open on a lock it cannot read.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const LIB = join(REPO_ROOT, 'plugins/orchestrator/scripts/lib');
const H = await import(pathToFileURL(join(LIB, 'holds.mjs')).href);
const RL = await import(pathToFileURL(join(LIB, 'run-locks.mjs')).href);

const MACRO = 'macro-plan-20261026T000000Z-abcdef';
const RUN = 'autopilot-20261026T000000Z-123456';
const SELF = { pid: process.pid, fingerprint: await RL.processFingerprint(process.pid) };
// A pid whose process has exited.
const DEAD = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid;

async function withMain(fn) {
  const main = mkdtempSync(join(tmpdir(), 'holds-live-'));
  try { return await fn(main); } finally { rmSync(main, { recursive: true, force: true }); }
}
let n = 0;
function entry(main, holder) {
  const lock = RL.macroLockPath(main, MACRO);
  mkdirSync(lock, { recursive: true });
  n += 1;
  writeFileSync(join(lock, `h-${holder.pid ?? 1}-${String(n).padStart(6, '0')}abcd.json`), `${JSON.stringify(holder)}\n`);
}
const driver = (over = {}) => ({ kind: 'run', run_id: RUN, ...SELF, worker: null, ...over });
const group = (worker, over = {}) => driver({ worker: { pgid: null, ...worker }, ...over });

describe('holds: a live run (N3)', () => {
  it('no lock is no live run; a live driver\'s entry is a live run, with its capabilities', () => withMain(async (main) => {
    deepStrictEqual((await H.liveRuns(main, MACRO)).live, false);
    entry(main, driver({ capabilities: ['holds-1'] }));
    const r = await H.liveRuns(main, MACRO);
    strictEqual(r.live, true);
    deepStrictEqual(r.runs.map((x) => [x.run_id, x.capabilities]), [[RUN, ['holds-1']]]);
  }));

  it('a dead driver is no live run, even while a worker group of it lives', () => withMain(async (main) => {
    entry(main, driver({ pid: DEAD, fingerprint: { kind: 'none' } }));
    entry(main, group({ pid: process.pid, fingerprint: SELF.fingerprint, subtask_id: 'S' }, { pid: DEAD, fingerprint: { kind: 'none' } }));
    strictEqual((await H.liveRuns(main, MACRO)).live, false);
    strictEqual((await H.laneBusy(main, MACRO, 'S')).busy, true, 'its lane is busy instead');
  }));

  it('a lock entry that cannot be read counts as a live run, and its lanes busy', () => withMain(async (main) => {
    const lock = RL.macroLockPath(main, MACRO);
    mkdirSync(lock, { recursive: true });
    execFileSync('mkfifo', [join(lock, 'h-1-abcdef.json')]);
    const r = await H.liveRuns(main, MACRO);
    strictEqual(r.live, true);
    ok(/cannot be read/.test(r.why), r.why);
    strictEqual((await H.laneBusy(main, MACRO, 'S')).busy, true);
  }));

  it('a session\'s admission entry is no run', () => withMain(async (main) => {
    const lock = RL.macroLockPath(main, MACRO);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, `s-${'a'.repeat(32)}.json`), JSON.stringify({ kind: 'session', admission_id: 'a'.repeat(32) }));
    strictEqual((await H.liveRuns(main, MACRO)).live, false);
    strictEqual((await H.laneBusy(main, MACRO, 'S')).busy, false);
  }));
});

describe('holds: a serial run with its worker recorded', () => {
  it('is live while its driver lives, whatever worker its own entry records', () => withMain(async (main) => {
    entry(main, driver({ worker: { pid: DEAD, fingerprint: { kind: 'none' } } }));
    const r = await H.liveRuns(main, MACRO);
    deepStrictEqual([r.live, r.runs.map((x) => x.run_id)], [true, [RUN]]);
  }));
});

describe('holds: a busy lane (Decision 2, item 4)', () => {
  it('a live group naming the subtask makes that lane busy, not another', () => withMain(async (main) => {
    entry(main, group({ pid: process.pid, fingerprint: SELF.fingerprint, subtask_id: 'S', lane: null }));
    strictEqual((await H.laneBusy(main, MACRO, 'S')).busy, true);
    strictEqual((await H.laneBusy(main, MACRO, 'T')).busy, false);
  }));

  it('an older group that records only its lane names that lane', () => withMain(async (main) => {
    entry(main, group({ pid: process.pid, fingerprint: SELF.fingerprint, lane: 'S' }));
    strictEqual((await H.laneBusy(main, MACRO, 'S')).busy, true);
    strictEqual((await H.laneBusy(main, MACRO, 'T')).busy, false);
  }));

  it('a live group that names no subtask makes every lane busy', () => withMain(async (main) => {
    entry(main, group({ pid: process.pid, fingerprint: SELF.fingerprint, lane: null, subtask_id: null }));
    const r = await H.laneBusy(main, MACRO, 'T');
    strictEqual(r.busy, true);
    ok(/names no lane/.test(r.why), r.why);
  }));

  it('a dead group leaves the lane free', () => withMain(async (main) => {
    entry(main, group({ pid: DEAD, fingerprint: { kind: 'none' }, subtask_id: 'S' }, { pid: DEAD, fingerprint: { kind: 'none' } }));
    strictEqual((await H.laneBusy(main, MACRO, 'S')).busy, false);
  }));

  it('a dead run\'s unfinished step of the lane keeps it busy until cleaned up; a finished one does not', () => withMain(async (main) => {
    const runDir = join(main, 'ledger', RUN);
    mkdirSync(runDir, { recursive: true });
    const open = join(main, '.agentic-plugins/runs/autopilot/open');
    mkdirSync(open, { recursive: true });
    writeFileSync(join(open, `${RUN}.json`), JSON.stringify({ schema: 'x', run_id: RUN, macro_id: MACRO, run_dir: runDir, pid: DEAD, fingerprint: { kind: 'none' } }));
    writeFileSync(join(runDir, 'steps.jsonl'), `${JSON.stringify({ event: 'started', seq: 1, subtask_id: 'S' })}\n${JSON.stringify({ event: 'started', seq: 2, subtask_id: 'T' })}\n${JSON.stringify({ event: 'finished', seq: 2 })}\n`);
    const r = await H.laneBusy(main, MACRO, 'S');
    strictEqual(r.busy, true);
    ok(/ended uncleanly with step 1/.test(r.why), r.why);
    strictEqual((await H.laneBusy(main, MACRO, 'T')).busy, false);
    // A record of another macro, or of a live driver, is not this judgment's.
    writeFileSync(join(open, `${RUN}.json`), JSON.stringify({ run_id: RUN, macro_id: 'macro-plan-20261026T000000Z-000000', run_dir: runDir, pid: DEAD }));
    strictEqual((await H.laneBusy(main, MACRO, 'S')).busy, false);
    writeFileSync(join(open, `${RUN}.json`), JSON.stringify({ run_id: RUN, macro_id: MACRO, run_dir: runDir, ...SELF }));
    strictEqual((await H.laneBusy(main, MACRO, 'S')).busy, false);
  }));
});

describe('holds: the scheduler records the subtask on every group (Decision 2, item 4)', () => {
  it('worker groups and task groups name the subtask they act for', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/scheduler.mjs'), 'utf8');
    ok(/addWorkerGroup\(\{ \.\.\.group, lane: laneId, subtask_id: subtaskId \?\? laneId, cwd: at \}\)/.test(src), 'a task group');
    ok(/session_id: sessionId, lane: inLane \? id : null, subtask_id: id, cwd,/.test(src), 'a worker group');
    for (const name of ['reconcileLane', 'createLane', 'removeLane', 'cancelPeerRuns', 'settlePeerRuns']) {
      const call = new RegExp(`task\\('${name}', \\{[^\\n]*\\}, [^\\n]*?, (id|entry\\.subtaskId \\?\\? null)\\);`);
      ok(call.test(src), `${name} names its subtask`);
    }
  });
});
