// tests/orchestrator/test-holds-handoff.mjs
//
// ADR-0068 Decision 2, item 4 (impl-hold) — the handoff
// (scripts/lib/hold-ops.mjs `completeHandoff`): re-read the owner's record,
// judge the lane, write the fence, look again as an admission does, ack. The
// ADR's four cases (a release between the acknowledgement and the fence, a
// retried handoff that finds its own fence, an admission that writes between
// the two looks, the ack discarded after the handoff) and each blocker.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const LIB = join(REPO_ROOT, 'plugins/orchestrator/scripts/lib');
const H = await import(pathToFileURL(join(LIB, 'holds.mjs')).href);
const OPS = await import(pathToFileURL(join(LIB, 'hold-ops.mjs')).href);
const RL = await import(pathToFileURL(join(LIB, 'run-locks.mjs')).href);

const MACRO = 'macro-plan-20261026T000000Z-ab0001';
const S = 'S';
const BRANCH = 'feat/s';
const CHILD = 'compose-20261026T000000Z-c00001';
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

async function withLane(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'holds-handoff-')));
  const main = join(dir, 'main');
  const lane = join(dir, 'lane');
  mkdirSync(main);
  mkdirSync(lane);
  execFileSync('git', ['-C', main, 'init', '-q', '-b', 'main'], { env: cleanEnv() });
  const t = {
    main, lane,
    child(extra = '') {
      const d = join(main, '.agentic-plugins/state/engineer/workflows');
      mkdirSync(d, { recursive: true });
      const file = join(d, `${CHILD}.md`);
      writeFileSync(file, `---\nworkflow_id: "${CHILD}"\ngit_baseline:\n  branch: "${BRANCH}"\npending_ensemble: []\nparent_workflow: "${MACRO}"\noriginating_subtask: "${S}"\n${extra}---\n\n# x\n`);
      return file;
    },
    async hold(over = {}) {
      return OPS.setHold({ mainRoot: main, macroId: MACRO, subtaskId: S, branch: BRANCH, lane, child: CHILD, ...over });
    },
    handoff(o = {}) {
      return OPS.completeHandoff({ mainRoot: main, macroId: MACRO, subtaskId: S, stateRoots: [main], ...o });
    },
    state: () => H.holdStateOf(main, MACRO, S).state,
  };
  try { return await fn(t); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const basisOf = async () => ({ fingerprint_version: 1, fingerprint: 'f', tree_digest: 't', content_digest: 'c', child: CHILD });

describe('the handoff', () => {
  it('a lane with nothing in it is handed over: fenced first, then acked, and the event recorded', () => withLane(async (t) => {
    t.child();
    const h = await t.hold();
    strictEqual(t.state(), 'pending');
    const r = await t.handoff();
    deepStrictEqual([r.state, r.holdId], ['held', h.hold_id]);
    strictEqual(t.state(), 'held');
    strictEqual(RL.fenceState(t.lane, h.hold_id), 'present');
    strictEqual(H.readRecord(t.main, MACRO, 'handoffs', S).record.fence, RL.fencePath(t.lane, h.hold_id));
    deepStrictEqual(H.readHoldEvents(t.main, MACRO).map((e) => e.event), ['held']);
    deepStrictEqual(RL.readLockEntries(H.holdsLockPath(t.main, MACRO)), [], 'the holds lock is released');
  }));

  it('stays pending, with its blocker, while an operation is open, a peer is pending, the workflow lock is held, another workflow is on the branch, or the caller\'s lane is busy', () => withLane(async (t) => {
    const child = t.child();
    await t.hold();
    const cases = [
      [() => H.publishOpRecord(t.main, MACRO, S, { operation_id: 'op-20261026T000000Z-0000000a', kind: 'verb' }), () => rmSync(join(H.opsDir(t.main, MACRO, S), 'op-20261026T000000Z-0000000a.json')), /persona operation is open/],
      [() => t.child('pending_ensemble:\n  - phase: "compose"\n'), () => t.child(), /pending peer ensemble/],
      [() => writeFileSync(`${child}.lock`, 'x'), () => rmSync(`${child}.lock`), /workflow file lock is held/],
      [() => writeFileSync(join(child, '..', 'other.md'), `---\nworkflow_id: "other"\ngit_baseline:\n  branch: "${BRANCH}"\n---\n`), () => rmSync(join(child, '..', 'other.md')), /is not the lane's child/],
    ];
    for (const [make, undo, why] of cases) {
      make();
      const r = await t.handoff();
      strictEqual(r.state, 'pending');
      ok(why.test(r.blocker), r.blocker);
      strictEqual(RL.fenceState(t.lane, r.holdId), 'absent', 'no fence while pending');
      undo();
    }
    const busy = await t.handoff({ busy: () => 'step 3 of the lane is in flight' });
    deepStrictEqual([busy.state, busy.blocker], ['pending', 'step 3 of the lane is in flight']);
    strictEqual((await t.handoff()).state, 'held', 'once nothing blocks, it completes');
  }));

  it('a release that arrives between the fence and the acknowledgement waits for the ack, then releases the held lane and removes the fence', () => withLane(async (t) => {
    t.child();
    const h = await t.hold();
    let released;
    let waiting = false;
    const r = await t.handoff({
      hooks: {
        // Critique round 6, M4: the handoff goes on once the release is
        // waiting on the holds lock, or has finished without waiting: no timer
        // decides it, so a release that took no lock is seen under any load.
        afterFence: async () => {
          let wait;
          const waited = new Promise((res) => { wait = res; });
          released = OPS.releaseHold({ mainRoot: t.main, macroId: MACRO, subtaskId: S, holdId: h.hold_id, stateRoots: [t.main], basisOf, hooks: { onLockWait: () => { waiting = true; wait(); } } });
          await Promise.race([waited, released.catch(() => {})]);
        },
      },
    });
    ok(waiting, 'the release waited on the holds lock the handoff holds');
    strictEqual(r.state, 'held');
    const rel = await released;
    strictEqual(rel.state, 'released-uncompared', 'the release saw the lane held, not pending');
    strictEqual(t.state(), 'released-uncompared');
    strictEqual(RL.fenceState(t.lane, h.hold_id), 'absent', 'and its fence is gone');
  }));

  it('a retried handoff that finds its own fence redoes every check before it acks', () => withLane(async (t) => {
    t.child();
    const h = await t.hold();
    // A crash after the fence and before the ack.
    RL.writeFence({ laneRoot: t.lane, holdId: h.hold_id, subtaskId: S, macroId: MACRO });
    H.publishOpRecord(t.main, MACRO, S, { operation_id: 'op-20261026T000000Z-0000000b', kind: 'verb' });
    const r = await t.handoff();
    strictEqual(r.state, 'pending', 'never acked at once');
    strictEqual(RL.fenceState(t.lane, h.hold_id), 'absent', 'the fence that cannot be acked is withdrawn');
    rmSync(join(H.opsDir(t.main, MACRO, S), 'op-20261026T000000Z-0000000b.json'));
    RL.writeFence({ laneRoot: t.lane, holdId: h.hold_id, subtaskId: S, macroId: MACRO });
    strictEqual((await t.handoff()).state, 'held');
  }));

  it('an admission that writes between the two looks withdraws the fence, and the hold stays pending', () => withLane(async (t) => {
    t.child();
    const h = await t.hold();
    const lock = RL.worktreeLockPath(t.lane);
    const r = await t.handoff({
      hooks: { afterFence: () => writeFileSync(join(lock, `s-${'c'.repeat(32)}.json`), JSON.stringify({ kind: 'session', command: 'next', admission_id: 'c'.repeat(32) })) },
    });
    strictEqual(r.state, 'pending');
    ok(/a session's next/.test(r.blocker), r.blocker);
    strictEqual(RL.fenceState(t.lane, h.hold_id), 'absent');
  }));

  it('an ack discarded after the handoff makes the hold pending again; the next handoff finds its fence and acks after its checks', () => withLane(async (t) => {
    t.child();
    const h = await t.hold();
    await t.handoff();
    rmSync(H.recordPath(t.main, MACRO, 'handoffs', S));
    strictEqual(t.state(), 'pending');
    strictEqual((await t.handoff()).state, 'held');
    strictEqual(RL.fenceState(t.lane, h.hold_id), 'present');
  }));

  it('a held lane whose fence an older `admission release` removed gets it back from the next handoff', () => withLane(async (t) => {
    t.child();
    const h = await t.hold();
    await t.handoff();
    rmSync(RL.fencePath(t.lane, h.hold_id));
    strictEqual((await t.handoff()).state, 'held');
    strictEqual(RL.fenceState(t.lane, h.hold_id), 'present');
  }));

  it('a hold on a subtask with no lane is acked with no fence', () => withLane(async (t) => {
    await t.hold({ lane: null, child: null });
    const r = await t.handoff();
    deepStrictEqual([r.state, r.fence], ['held', null]);
  }));

  it('a hold set beside a live worker group of the lane stays pending', () => withLane(async (t) => {
    t.child();
    await t.hold();
    const lock = RL.macroLockPath(t.main, MACRO);
    mkdirSync(lock, { recursive: true });
    const self = { pid: process.pid, fingerprint: await RL.processFingerprint(process.pid) };
    writeFileSync(join(lock, `h-${process.pid}-aaaaaa.json`), JSON.stringify({ kind: 'run', run_id: 'autopilot-20261026T000000Z-000001', pid: 999999, fingerprint: { kind: 'none' }, worker: { ...self, subtask_id: S } }));
    const r = await t.handoff();
    strictEqual(r.state, 'pending');
    ok(/still runs in the lane/.test(r.blocker), r.blocker);
  }));
});

describe('the handoff beside the review\'s interleavings', () => {
  it('a status repair waits for a handoff between its fence and its ack, and never removes that fence', () => withLane(async (t) => {
    t.child();
    const h = await t.hold();
    let repaired;
    await t.handoff({ hooks: { afterFence: async () => { repaired = OPS.repairHoldFence({ mainRoot: t.main, macroId: MACRO, subtaskId: S }); await new Promise((r) => { setTimeout(r, 100); }); } } });
    await repaired;
    strictEqual(t.state(), 'held');
    strictEqual(RL.fenceState(t.lane, h.hold_id), 'present');
  }));

  it('an archived child\'s open operation keeps the handoff pending', () => withLane(async (t) => {
    const file = t.child(`persona_operations: ${JSON.stringify(JSON.stringify({ v: 1, ops: [{ id: 'op-20261026T000000Z-0000000e', kind: 'commit', opened_at: 'x', ext: false }] }))}\n`);
    const archive = join(file, '..', '..', 'archive');
    mkdirSync(archive, { recursive: true });
    const { renameSync } = await import('node:fs');
    renameSync(file, join(archive, `${CHILD}.md`));
    await t.hold();
    const r = await t.handoff();
    strictEqual(r.state, 'pending');
    ok(/op-20261026T000000Z-0000000e/.test(r.blocker), r.blocker);
  }));

  it('an unreadable handoff record is neither pending nor held: release refuses it instead of withdrawing the hold', () => withLane(async (t) => {
    t.child();
    const h = await t.hold();
    await t.handoff();
    writeFileSync(H.recordPath(t.main, MACRO, 'handoffs', S), '{');
    strictEqual(t.state(), 'unreadable');
    let err = null;
    try { await OPS.releaseHold({ mainRoot: t.main, macroId: MACRO, subtaskId: S, holdId: h.hold_id, stateRoots: [t.main], basisOf }); } catch (e) { err = e; }
    ok(err && /discard-unreadable/.test(err.message), String(err));
    strictEqual(RL.fenceState(t.lane, h.hold_id), 'present', 'the fence stays');
  }));

  it('a release stopped after its owner record moved strands no fence: a retry removes it, and a new hold removes it too', () => withLane(async (t) => {
    t.child();
    const h = await t.hold();
    await t.handoff();
    // The release's writes up to the owner record, then a crash before the fence's removal.
    H.writeWhole(H.recordPath(t.main, MACRO, 'releases', S), { schema: H.RELEASE_SCHEMA, release_id: 'c'.repeat(16), hold_id: h.hold_id, subtask_id: S, state: 'uncompared', basis: { fingerprint_version: 1, fingerprint: 'f', tree_digest: 't', content_digest: 'c', child: CHILD }, park_record_id: null, park_ended: false, released_at: 'x', compared_at: null });
    H.writeWhole(H.recordPath(t.main, MACRO, 'holds', S), { ...H.readOwnerHold(t.main, MACRO, S).record, state: 'released' });
    strictEqual(RL.fenceState(t.lane, h.hold_id), 'present');
    const second = await t.hold();
    strictEqual(RL.fenceState(t.lane, h.hold_id), 'absent', 'the old hold\'s fence went before its id was lost');
    strictEqual((await t.handoff()).state, 'held');
    strictEqual(RL.fenceState(t.lane, second.hold_id), 'present');
  }));
});

describe('the release of a hold', () => {
  it('a pending hold is withdrawn with nothing to compare; a held one records its basis behind the writer exclusion', () => withLane(async (t) => {
    t.child();
    let h = await t.hold();
    let r = await OPS.releaseHold({ mainRoot: t.main, macroId: MACRO, subtaskId: S, holdId: h.hold_id, stateRoots: [t.main], basisOf });
    deepStrictEqual([r.state, r.release.basis], ['withdrawn', null]);
    strictEqual(t.state(), 'withdrawn');
    h = await t.hold();
    await t.handoff();
    let seenOps = null;
    r = await OPS.releaseHold({
      mainRoot: t.main, macroId: MACRO, subtaskId: S, holdId: h.hold_id, stateRoots: [t.main],
      basisOf: async () => { seenOps = H.readOps(t.main, MACRO, S).ops.map((o) => o.record?.kind); return basisOf(); },
    });
    strictEqual(r.state, 'released-uncompared');
    deepStrictEqual(seenOps, ['release'], 'the digest ran with the exclusion record published');
    deepStrictEqual(H.readOps(t.main, MACRO, S).ops, [], 'and the record went after it');
  }));

  it('names the hold it ends, and refuses while a writer may be active', () => withLane(async (t) => {
    t.child();
    const h = await t.hold();
    await t.handoff();
    const refused = async (holdId, re) => {
      let err = null;
      try { await OPS.releaseHold({ mainRoot: t.main, macroId: MACRO, subtaskId: S, holdId, stateRoots: [t.main], basisOf }); } catch (e) { err = e; }
      ok(err instanceof OPS.HoldRefusal && re.test(err.message), String(err));
    };
    await refused('f'.repeat(16), /names the hold it ends/);
    H.publishOpRecord(t.main, MACRO, S, { operation_id: 'op-20261026T000000Z-0000000c', kind: 'verb' });
    await refused(h.hold_id, /refuses while a writer may still be active.*op-20261026T000000Z-0000000c/);
    strictEqual(t.state(), 'held', 'nothing changed');
  }));
});
