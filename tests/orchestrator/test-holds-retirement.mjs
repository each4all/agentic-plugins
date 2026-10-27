// ADR-0068 Decision 2, item 8 (impl-hold Task 12): every hold has an exit.
// Retirement — /orchestrator:done retires every record of the subtask it
// completes (the hold, a release, a kept park), waiting while a persona
// operation is open in the lane or a process of a run lives there; a macro
// that ends retires all of its records, after its terminal write. Orphaning —
// a hold applies to nothing once its subtask leaves the plan, its branch
// differs, or it has a different lane or child; once orphaned or retired it
// never applies again. /orchestrator:abort and finalize check the holds
// before their first bulk status write. Each crash state of I3's retirement
// rows is resumed. The library (scripts/lib/hold-ops.mjs), the CLI
// (state.mjs subtask-update, holds-retire, holds-preflight), the runbooks of
// both hosts and the Stop sweep.

import { describe, it, before, after, beforeEach } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withArgs } from './_command-args-file.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ORCH_ROOT = join(REPO_ROOT, 'plugins/orchestrator');
const ENGINEER_ROOT = join(REPO_ROOT, 'plugins/engineer');
const ORCH_STATE = join(ORCH_ROOT, 'scripts/state.mjs');
const LIB = join(ORCH_ROOT, 'scripts/lib');
const H = await import(pathToFileURL(join(LIB, 'holds.mjs')).href);
const O = await import(pathToFileURL(join(LIB, 'hold-ops.mjs')).href);
const RL = await import(pathToFileURL(join(LIB, 'run-locks.mjs')).href);
const { createWorkflow, setPlan, readWorkflow, retireEndedMacroHolds, setMacroTerminal } = await import(pathToFileURL(ORCH_STATE).href);
const SHELLS = ['bash', 'zsh'].filter((s) => spawnSync(s, ['-c', 'exit 0']).status === 0);

const MACRO = 'macro-plan-20261026T000000Z-abcdef';
const RUN = 'autopilot-20261026T000000Z-123456';
const SELF = { pid: process.pid, fingerprint: await RL.processFingerprint(process.pid) };
const BASIS = { fingerprint_version: 3, fingerprint: 'f', tree_digest: 't', content_digest: 'c', child: null };
const OP = 'op-20261026T000000Z-0000aaaa';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
// The operator's agentic session stays out (C88).
const cleanEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_') && k !== 'CLAUDE_PLUGIN_ROOT' && k !== 'CLAUDE_CODE_SESSION_ID')),
  ...GIT_ENV,
  ...extra,
});
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A main checkout (a plain directory: the library needs no git) and a lane directory. */
async function withDirs(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'holds-retire-')));
  const main = join(dir, 'main');
  const lane = join(dir, 'lane');
  mkdirSync(main);
  mkdirSync(lane);
  try { return await fn({ main, lane, dir }); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const activate = (main, macro = MACRO) => H.writeProtocol(main, macro, { writtenBy: 'test' });
const hold = (main, over = {}) => O.setHold({ mainRoot: main, macroId: MACRO, subtaskId: 'T1', branch: 'feat/t1', ...over });
const handOver = (main) => O.completeHandoff({ mainRoot: main, macroId: MACRO, subtaskId: 'T1', stateRoots: [main] });
const retire = (main, over = {}) => O.retireSubtaskHolds({ mainRoot: main, macroId: MACRO, subtaskId: 'T1', branch: 'feat/t1', stateRoots: [main], ...over });
const gate = (main) => O.holdGate({ mainRoot: main, macroId: MACRO, subtaskId: 'T1' });
const keepPark = (main, macro = MACRO, id = 'T1') => {
  const file = H.recordPath(main, macro, 'parks', id);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ schema: 'agentic-autopilot-park-1.0', record_id: 'a'.repeat(16), subtask_id: id, state: 'parked' })}\n`);
  return file;
};
const opRecord = (main, id = OP, macro = MACRO, subtask = 'T1') => H.publishOpRecord(main, macro, subtask, {
  operation_id: id, kind: 'verb', subtask_id: subtask, workflow_id: null, persona: 'engineer', host: 'claude', opened_at: '2026-10-26T00:00:00Z',
});
let n = 0;
/** A worker group of run RUN, alive (this process), naming `subtask`. */
function workerEntry(main, subtask, macro = MACRO) {
  const lock = RL.macroLockPath(main, macro);
  mkdirSync(lock, { recursive: true });
  n += 1;
  writeFileSync(join(lock, `h-${process.pid}-${String(n).padStart(6, '0')}abcd.json`), `${JSON.stringify({
    kind: 'run', run_id: RUN, ...SELF, worker: { pid: process.pid, pgid: null, fingerprint: SELF.fingerprint, subtask_id: subtask },
  })}\n`);
}
const events = (main) => H.readHoldEvents(main, MACRO).map((e) => e.event);

describe('retirement of a completed subtask (Decision 2, item 8; I3)', () => {
  it('retires every record: the owner record retired, its release and handoff removed, its kept park ended; the gate is open; again it is none', () => withDirs(async ({ main, lane }) => {
    activate(main);
    const h = await hold(main, { lane });
    strictEqual((await handOver(main)).state, 'held');
    await O.releaseHold({ mainRoot: main, macroId: MACRO, subtaskId: 'T1', holdId: h.hold_id, stateRoots: [main], basisOf: async () => BASIS, keptParkId: () => 'a'.repeat(16) });
    const park = keepPark(main);
    ok(gate(main), 'an uncompared release keeps the lane');
    const r = await retire(main);
    deepStrictEqual([r.state, r.holdId, r.left], ['retired', h.hold_id, []]);
    const owner = H.readOwnerHold(main, MACRO, 'T1');
    deepStrictEqual([owner.record.state, typeof owner.record.retired_at], ['retired', 'string']);
    strictEqual(H.readRecord(main, MACRO, 'releases', 'T1').state, 'absent');
    strictEqual(H.readRecord(main, MACRO, 'handoffs', 'T1').state, 'absent');
    strictEqual(existsSync(park), false, 'the kept park ended');
    match(readFileSync(join(main, '.agentic-plugins/runs/autopilot/holds', MACRO, 'parks/events.jsonl'), 'utf8'), /"event":"retired","subtask_id":"T1","record_id":"a{16}"/);
    strictEqual(gate(main), null);
    strictEqual(H.holdApplies(owner, { branch: 'feat/t1' }).applies, false);
    ok(events(main).includes('retired'));
    strictEqual((await retire(main)).state, 'none', 'idempotent');
  }));

  it("a held hold's fence is removed with it", () => withDirs(async ({ main, lane }) => {
    activate(main);
    const h = await hold(main, { lane });
    strictEqual((await handOver(main)).state, 'held');
    strictEqual(RL.fenceState(lane, h.hold_id), 'present');
    strictEqual((await retire(main)).state, 'retired');
    strictEqual(RL.fenceState(lane, h.hold_id), 'absent');
  }));

  it('waits while a persona operation is open in the lane, the hold applying until then; once cleared it retires', () => withDirs(async ({ main }) => {
    activate(main);
    await hold(main);
    opRecord(main);
    const r = await retire(main);
    strictEqual(r.state, 'waiting');
    match(r.why, new RegExp(`a persona operation is open in the lane: ${OP} \\(verb\\)`));
    strictEqual(H.readOwnerHold(main, MACRO, 'T1').record.state, 'held', 'nothing written');
    ok(gate(main), 'the hold applies');
    H.clearOperation(main, MACRO, 'T1', OP, { by: 'owner' });
    strictEqual((await retire(main)).state, 'retired');
  }));

  it('waits while a worker of a run lives in the lane, but not for the caller\'s own run (a worker of it recording done)', () => withDirs(async ({ main }) => {
    activate(main);
    await hold(main);
    workerEntry(main, 'T1');
    const r = await retire(main);
    strictEqual(r.state, 'waiting');
    match(r.why, /still runs in the lane/);
    strictEqual((await retire(main, { exceptRun: RUN })).state, 'retired');
  }));

  it('a kept park alone (no hold) of a completed subtask is retired too', () => withDirs(async ({ main }) => {
    activate(main);
    const park = keepPark(main);
    deepStrictEqual((await retire(main)).state, 'retired');
    strictEqual(existsSync(park), false);
  }));

  it('I3: a crash after the owner record turned retired leaves its release; the retry removes it, and the gate was open meanwhile', () => withDirs(async ({ main }) => {
    activate(main);
    const h = await hold(main);
    const release = H.recordPath(main, MACRO, 'releases', 'T1');
    H.writeWhole(release, { schema: H.RELEASE_SCHEMA, release_id: 'b'.repeat(16), hold_id: h.hold_id, subtask_id: 'T1', state: 'uncompared', basis: BASIS, park_record_id: null, park_ended: false, released_at: 'x', compared_at: null });
    H.writeWhole(H.recordPath(main, MACRO, 'holds', 'T1'), { ...h, state: 'retired', retired_at: 'x' });
    strictEqual(gate(main), null, 'retired never applies');
    strictEqual((await retire(main)).state, 'retired');
    strictEqual(existsSync(release), false);
    strictEqual((await retire(main)).state, 'none');
  }));

  it('a hold record that cannot be read is not retired: the owner discards it; a release that cannot be read is left and named', () => withDirs(async ({ main }) => {
    activate(main);
    mkdirSync(join(H.holdsDir(main, MACRO), 'holds'), { recursive: true });
    writeFileSync(H.recordPath(main, MACRO, 'holds', 'T1'), '{');
    const r = await retire(main);
    strictEqual(r.state, 'unreadable');
    match(r.why, /--discard-unreadable/);
    strictEqual(readFileSync(H.recordPath(main, MACRO, 'holds', 'T1'), 'utf8'), '{', 'left as it was');
    rmSync(H.recordPath(main, MACRO, 'holds', 'T1'));
    await hold(main);
    mkdirSync(join(H.holdsDir(main, MACRO), 'releases'), { recursive: true });
    writeFileSync(H.recordPath(main, MACRO, 'releases', 'T1'), 'nope');
    const left = await retire(main);
    deepStrictEqual([left.state, left.left], ['retired', [H.recordPath(main, MACRO, 'releases', 'T1')]]);
    strictEqual(gate(main), null, 'the owner record is retired: the unreadable release no longer holds the lane');
  }));

  it('no holds directory: none, and none is made', () => withDirs(async ({ main }) => {
    strictEqual((await retire(main)).state, 'none');
    strictEqual(existsSync(H.holdsDir(main, MACRO)), false);
  }));
});

describe('orphaning (Decision 2, item 8)', () => {
  it('orphanReason: the plan, the branch, the lane and the child; an absent or unknown lane or child never orphans', () => {
    const h = { subtask_id: 'T1', branch: 'feat/t1', lane: '/x/lane', child: 'compose-20261026T000000Z-aaaaaa' };
    const s = { id: 'T1', branch: 'feat/t1' };
    match(O.orphanReason(h, { subtask: null }), /left the plan/);
    match(O.orphanReason(h, { subtask: { ...s, branch: 'feat/other' } }), /branch for subtask T1 is feat\/other, not feat\/t1/);
    match(O.orphanReason(h, { subtask: s, laneNow: '/x/other' }), /lane is \/x\/other now, not \/x\/lane/);
    match(O.orphanReason(h, { subtask: s, childNow: 'compose-20261026T000000Z-bbbbbb' }), /child is compose-20261026T000000Z-bbbbbb now/);
    for (const now of [{}, { laneNow: null, childNow: null }, { laneNow: '/x/lane', childNow: h.child }]) {
      strictEqual(O.orphanReason(h, { subtask: s, ...now }), null, JSON.stringify(now));
    }
    strictEqual(O.orphanReason({ ...h, lane: null, child: null }, { subtask: s, laneNow: '/x/other', childNow: 'compose-20261026T000000Z-bbbbbb' }), null, 'set on none: nothing to differ from');
  });

  it('a subtask that left the plan orphans its hold: fence removed, gate open; it never applies again, even when the plan takes the id and branch back', () => withDirs(async ({ main, lane }) => {
    activate(main);
    const h = await hold(main, { lane });
    strictEqual((await handOver(main)).state, 'held');
    const orphaned = await O.orphanStale({ mainRoot: main, macroId: MACRO, subtasks: [{ id: 'T2', branch: 'feat/t2' }], stateRoots: [main] });
    deepStrictEqual(orphaned.map((o) => [o.subtaskId, o.holdId]), [['T1', h.hold_id]]);
    const owner = H.readOwnerHold(main, MACRO, 'T1').record;
    deepStrictEqual([owner.state, owner.orphaned.why], ['held', 'subtask T1 left the plan']);
    strictEqual(RL.fenceState(lane, h.hold_id), 'absent');
    strictEqual(gate(main), null);
    ok(events(main).includes('orphaned'));
    deepStrictEqual(await O.orphanStale({ mainRoot: main, macroId: MACRO, subtasks: [{ id: 'T1', branch: 'feat/t1' }], stateRoots: [main] }), [], 'nothing more');
    strictEqual(H.holdApplies(H.readOwnerHold(main, MACRO, 'T1'), { branch: 'feat/t1' }).applies, false, 'reused id and branch: still orphaned');
    strictEqual(gate(main), null);
    const again = await hold(main, { lane });
    ok(again.hold_id !== h.hold_id && gate(main), 'a new hold applies');
  }));

  it("a plan revision that changes the subtask's branch orphans its hold; a matching plan does not", () => withDirs(async ({ main }) => {
    activate(main);
    await hold(main);
    deepStrictEqual(await O.orphanStale({ mainRoot: main, macroId: MACRO, subtasks: [{ id: 'T1', branch: 'feat/t1' }], stateRoots: [main] }), []);
    const o = await O.orphanStale({ mainRoot: main, macroId: MACRO, subtasks: [{ id: 'T1', branch: 'feat/renamed' }], stateRoots: [main] });
    match(o[0].why, /is feat\/renamed, not feat\/t1/);
  }));

  it('a different linked child orphans; a different lane (laneOf) orphans; the child archived (none linked) does not', () => withDirs(async ({ main, lane, dir }) => {
    activate(main);
    await hold(main, { child: 'compose-20261026T000000Z-aaaaaa' });
    const home = join(main, '.agentic-plugins/state/engineer/workflows');
    mkdirSync(home, { recursive: true });
    deepStrictEqual(await O.orphanStale({ mainRoot: main, macroId: MACRO, subtasks: [{ id: 'T1', branch: 'feat/t1' }], stateRoots: [main] }), [], 'no linked child: never orphans');
    writeFileSync(join(home, 'compose-20261026T000001Z-bbbbbb.md'), [
      '---', 'workflow_id: "compose-20261026T000001Z-bbbbbb"', 'git_baseline:', '  branch: "feat/t1"', `parent_workflow: "${MACRO}"`, 'originating_subtask: "T1"', '---', '',
    ].join('\n'));
    const o = await O.orphanStale({ mainRoot: main, macroId: MACRO, subtasks: [{ id: 'T1', branch: 'feat/t1' }], stateRoots: [main] });
    match(o[0]?.why ?? '', /child is compose-20261026T000001Z-bbbbbb now, not compose-20261026T000000Z-aaaaaa/);
    rmSync(H.recordPath(main, MACRO, 'holds', 'T1'));
    await hold(main, { lane });
    const other = join(dir, 'other');
    mkdirSync(other);
    deepStrictEqual(await O.orphanStale({ mainRoot: main, macroId: MACRO, subtasks: [{ id: 'T1', branch: 'feat/t1' }], stateRoots: [main], laneOf: () => lane }), []);
    const l = await O.orphanStale({ mainRoot: main, macroId: MACRO, subtasks: [{ id: 'T1', branch: 'feat/t1' }], stateRoots: [main], laneOf: () => other });
    match(l[0]?.why ?? '', /lane is .*other now/);
  }));

  it('I3: any reader removes what a retired or orphaned hold left — its handoff, its release, its fence', () => withDirs(async ({ main, lane }) => {
    activate(main);
    const h = await hold(main, { lane });
    strictEqual((await handOver(main)).state, 'held');
    H.writeWhole(H.recordPath(main, MACRO, 'holds', 'T1'), { ...h, state: 'retired', retired_at: 'x' });
    ok(existsSync(H.recordPath(main, MACRO, 'handoffs', 'T1')) && RL.fenceState(lane, h.hold_id) === 'present');
    deepStrictEqual(await O.orphanStale({ mainRoot: main, macroId: MACRO, subtasks: [{ id: 'T1', branch: 'feat/t1' }], stateRoots: [main] }), []);
    strictEqual(existsSync(H.recordPath(main, MACRO, 'handoffs', 'T1')), false);
    strictEqual(RL.fenceState(lane, h.hold_id), 'absent');
  }));
});

describe("a macro's end (Decision 2, item 8; I3)", () => {
  it('retires the whole holds directory and every fence; waits while an operation is open or a run lives (not the caller\'s own)', () => withDirs(async ({ main, lane }) => {
    activate(main);
    const h = await hold(main, { lane });
    strictEqual((await handOver(main)).state, 'held');
    keepPark(main, MACRO, 'T2');
    opRecord(main, OP, MACRO, 'T3');
    let r = await O.retireMacroHolds({ mainRoot: main, macroId: MACRO });
    strictEqual(r.state, 'waiting');
    match(r.why, /subtask T3's lane/);
    H.clearOperation(main, MACRO, 'T3', OP, { by: 'owner' });
    const lock = RL.macroLockPath(main, MACRO);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, `h-${process.pid}-999999abcd.json`), JSON.stringify({ kind: 'run', run_id: RUN, ...SELF, worker: null }));
    r = await O.retireMacroHolds({ mainRoot: main, macroId: MACRO });
    deepStrictEqual([r.state, /is live/.test(r.why)], ['waiting', true]);
    ok(existsSync(H.holdsDir(main, MACRO)), 'left while it waits');
    r = await O.retireMacroHolds({ mainRoot: main, macroId: MACRO, exceptRun: RUN });
    strictEqual(r.state, 'retired');
    strictEqual(existsSync(H.holdsDir(main, MACRO)), false);
    strictEqual(RL.fenceState(lane, h.hold_id), 'absent');
    deepStrictEqual(readdirSync(H.holdsRoot(main)), [], 'nothing renamed aside is left');
    strictEqual((await O.retireMacroHolds({ mainRoot: main, macroId: MACRO })).state, 'none');
  }));

  it('endedMacroHolds names the macros whose holds outlived them, and never a directory renamed aside', () => withDirs(async ({ main }) => {
    activate(main);
    activate(main, 'macro-plan-20261026T000000Z-bbbbbb');
    mkdirSync(join(H.holdsRoot(main), `.retired-${MACRO}-0000`), { recursive: true });
    deepStrictEqual(O.endedMacroHolds(main, (id) => id === MACRO), [MACRO]);
  }));
});

describe("the orchestrator's own writers of a child, and abort/finalize's check (Decision 2, items 7 and 8)", () => {
  const childFile = (main, over = {}) => {
    const home = join(main, '.agentic-plugins/state/engineer/workflows');
    mkdirSync(home, { recursive: true });
    const f = join(home, 'compose-20261026T000000Z-aaaaaa.md');
    const fields = { workflow_id: 'compose-20261026T000000Z-aaaaaa', parent_workflow: MACRO, originating_subtask: 'T1', ...over };
    writeFileSync(f, ['---', ...Object.entries(fields).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${JSON.stringify(v)}`), 'git_baseline:', '  branch: "feat/t1"', '---', ''].join('\n'));
    return f;
  };

  it('childWriteRefusal: off, nothing; held or an operation open, refused; a child of no macro never', () => withDirs(async ({ main }) => {
    const f = childFile(main);
    strictEqual(O.childWriteRefusal({ mainRoot: main, childPath: f }), null, 'holds off');
    activate(main);
    strictEqual(O.childWriteRefusal({ mainRoot: main, childPath: f }), null);
    await hold(main);
    match(O.childWriteRefusal({ mainRoot: main, childPath: f }), /is the child of subtask T1 of .*, which is held/);
    rmSync(H.recordPath(main, MACRO, 'holds', 'T1'));
    opRecord(main);
    match(O.childWriteRefusal({ mainRoot: main, childPath: f }), new RegExp(`a persona operation is open on .*${OP}`));
    strictEqual(O.childWriteRefusal({ mainRoot: main, childPath: childFile(main, { parent_workflow: null, originating_subtask: null }) }), null);
    writeFileSync(H.protocolPath(main, MACRO), '{');
    match(O.childWriteRefusal({ mainRoot: main, childPath: childFile(main) }), /cannot be read/);
  }));

  it('closeRefusals: off is not active; an open operation, a busy lane and an unreadable hold refuse; a held lane with neither does not', () => withDirs(async ({ main, lane }) => {
    const plan = [{ id: 'T1', branch: 'feat/t1', status: 'in_progress' }, { id: 'T2', branch: 'feat/t2', status: 'pending' }];
    const refusals = () => O.closeRefusals({ mainRoot: main, macroId: MACRO, subtasks: plan, stateRoots: [main] });
    deepStrictEqual(await refusals(), { active: false, why: [] });
    activate(main);
    await hold(main, { lane });
    strictEqual((await handOver(main)).state, 'held');
    deepStrictEqual(await refusals(), { active: true, why: [] }, 'a held lane alone does not stop the close: its child is archived');
    opRecord(main, OP, MACRO, 'T2');
    let r = await refusals();
    strictEqual(r.why.length, 1);
    match(r.why[0], new RegExp(`a persona operation is open in subtask T2's lane: ${OP} \\(verb\\).*writer-clear T2`));
    H.clearOperation(main, MACRO, 'T2', OP, { by: 'owner' });
    workerEntry(main, 'T2');
    r = await refusals();
    match(r.why.join('\n'), /subtask T2's lane is busy/);
    rmSync(RL.macroLockPath(main, MACRO), { recursive: true, force: true });
    mkdirSync(join(H.holdsDir(main, MACRO), 'holds'), { recursive: true });
    writeFileSync(H.recordPath(main, MACRO, 'holds', 'T2'), '{');
    r = await refusals();
    match(r.why.join('\n'), /subtask T2's hold record cannot be read/);
  }));
});

// --- the commands, in real repositories -----------------------------------------

describe('done, abort, finalize and the Stop sweep beside holds (CLI and runbooks)', () => {
  let dir;
  let main;
  let lane;
  let macroPath;
  let macroId;
  let fakeEngineer;
  const T1 = (over = {}) => ({ id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'pending', ...over });
  const orch = (args, env = {}) => spawnSync(process.execPath, [ORCH_STATE, ...args], { encoding: 'utf8', env: cleanEnv(env), cwd: lane });
  const subtask = async (id = 'T1') => (await readWorkflow(macroPath)).frontmatter.plan.subtasks.find((s) => s.id === id);
  const engId = 'compose-20261026T000000Z-aaaaaa';
  const setStatus = (status, extra = []) => orch(['subtask-update', `--workflow-path=${macroPath}`, '--host=claude', '--subtask-id=T1', `--status=${status}`, `--engineer-workflow-id=${engId}`, ...extra]);
  const complete = () => setStatus('completed', [`--commit=${git(main, 'rev-parse', 'HEAD')}`, '--closed-at=2026-10-26T00:00:00Z']);
  const holdT1 = () => O.setHold({ mainRoot: main, macroId, subtaskId: 'T1', branch: 'feat/t1', lane });
  const handOverT1 = () => O.completeHandoff({ mainRoot: main, macroId, subtaskId: 'T1', stateRoots: [main, lane] });
  const runIn = (shell, script) => spawnSync(shell, ['-c', script], {
    cwd: lane, encoding: 'utf8', env: cleanEnv({ HOME: dir, AGENTIC_ORCHESTRATOR_ROOT: ORCH_ROOT, AGENTIC_ENGINEER_ROOT: ENGINEER_ROOT }),
  });
  /** The bash blocks of commands/<name>.md from `## Phase 0` up to `until`, as one script. */
  function phases(name, until) {
    const text = readFileSync(join(ORCH_ROOT, 'commands', `${name}.md`), 'utf8');
    const from = text.indexOf('## Phase 0');
    const to = text.indexOf(until);
    ok(from >= 0 && to > from, `${name}.md carries Phase 0 through ${until}`);
    return [...text.slice(from, to).matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1]).join('\n');
  }
  const typed = (script, text) => withArgs(script, text, { line: "ARGS_DIR='<directory from step 1>'" });

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'holds-retire-cli-')));
    main = join(dir, 'main');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    writeFileSync(join(main, '.gitignore'), '.agentic-plugins/\n');
    git(main, 'add', '.gitignore');
    git(main, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'feat/t1', join(dir, 'lane'));
    main = realpathSync(main);
    lane = realpathSync(join(dir, 'lane'));
    fakeEngineer = join(dir, 'old-engineer');
    mkdirSync(join(fakeEngineer, 'scripts'), { recursive: true });
    writeFileSync(join(fakeEngineer, 'scripts', 'state.mjs'), "process.exit(process.argv[2] === 'hold-capability' ? 2 : 0);\n");
  });
  beforeEach(async () => {
    for (const root of [main, lane]) rmSync(join(root, '.agentic-plugins'), { recursive: true, force: true });
    ({ filePath: macroPath } = await createWorkflow({
      repoRoot: main, verb: 'plan', host: 'claude',
      gitBaseline: { branch: 'main', head: git(main, 'rev-parse', 'HEAD'), status_digest: '' },
      originalRequest: 'holds retirement fixture',
    }));
    await setPlan({ workflowPath: macroPath, host: 'claude', subtasks: [T1(), { id: 'T2', verb: 'compose', branch: 'feat/t2', blocked_by: [], status: 'pending' }] });
    macroId = macroPath.split('/').pop().replace(/\.md$/, '');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('a lane held, committed, released, then recorded done with no run live completes, retires every record and never parks', async () => {
    H.writeProtocol(main, macroId, { writtenBy: 'test' });
    strictEqual(setStatus('in_progress').status, 0);
    const h = await holdT1();
    strictEqual((await handOverT1()).state, 'held');
    await O.releaseHold({ mainRoot: main, macroId, subtaskId: 'T1', holdId: h.hold_id, stateRoots: [main, lane], basisOf: async () => BASIS });
    strictEqual(H.holdStateOf(main, macroId, 'T1').state, 'released-uncompared');
    const r = complete();
    strictEqual(r.status, 0, r.stderr);
    match(r.stderr, new RegExp(`retired the hold records of subtask T1 \\(hold ${h.hold_id}\\)`));
    strictEqual((await subtask()).status, 'completed');
    strictEqual(H.readOwnerHold(main, macroId, 'T1').record.state, 'retired');
    strictEqual(H.readRecord(main, macroId, 'releases', 'T1').state, 'absent', 'no release left to compare, so no park on it');
    strictEqual(H.readKeptPark(main, macroId, 'T1').kept, false);
    strictEqual(O.holdGate({ mainRoot: main, macroId, subtaskId: 'T1' }), null);
  });

  it("done's write completes beside an open operation, its retirement waits and says so; done's no-op path finishes it once the operation ends", async () => {
    H.writeProtocol(main, macroId, { writtenBy: 'test' });
    strictEqual(setStatus('in_progress').status, 0);
    await holdT1();
    opRecord(main, OP, macroId, 'T1');
    const r = complete();
    strictEqual(r.status, 0, r.stderr);
    match(r.stderr, new RegExp(`the hold records of subtask T1 are not retired yet: a persona operation is open in the lane: ${OP}.*The hold applies until they are`));
    strictEqual((await subtask()).status, 'completed');
    strictEqual(H.readOwnerHold(main, macroId, 'T1').record.state, 'held');
    H.clearOperation(main, macroId, 'T1', OP, { by: 'owner' });
    // done.md's already-completed branch.
    const done = runIn(SHELLS[0], typed(readFileSync(join(ORCH_ROOT, 'commands/done.md'), 'utf8').match(/^```bash\n(ARGS_DIR=[\s\S]*?)^```$/m)[1], `T1 --workflow=${macroId}`));
    strictEqual(done.status, 0, done.stderr);
    match(done.stderr, /already completed/);
    match(done.stderr, /retired the hold records of subtask T1/);
    strictEqual(H.readOwnerHold(main, macroId, 'T1').record.state, 'retired');
  });

  it("the Codex done mirror's no-op path retires too", async () => {
    const skill = readFileSync(join(ORCH_ROOT, 'core/skills/done/SKILL.md'), 'utf8');
    const block = [...skill.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1]).filter((b) => b.includes('already completed'));
    strictEqual(block.length, 1);
    ok(/already completed[\s\S]*holds-retire \\\n\s+--workflow-path "\$MACRO_PATH" --subtask-id "\$SUBTASK_ID" \|\| true\n\s+exit 0/.test(block[0]), 'holds-retire before the no-op exit');
  });

  it('the write that completes the last subtask ends the macro and retires its holds directory', async () => {
    H.writeProtocol(main, macroId, { writtenBy: 'test' });
    strictEqual(orch(['subtask-update', `--workflow-path=${macroPath}`, '--host=claude', '--subtask-id=T2', '--status=completed', '--engineer-workflow-id=compose-20261026T000000Z-bbbbbb',
      `--commit=${git(main, 'rev-parse', 'HEAD')}`, '--closed-at=2026-10-26T00:00:00Z']).status, 0);
    ok(existsSync(H.holdsDir(main, macroId)), 'the macro lives: its directory stays');
    strictEqual(setStatus('in_progress').status, 0);
    const r = complete();
    strictEqual(r.status, 0, r.stderr);
    match(r.stderr, new RegExp(`retired the holds directory of ${macroId}: the macro ended`));
    strictEqual(existsSync(H.holdsDir(main, macroId)), false);
  });

  it('holds-retire: --macro-end before the terminal write and --subtask-id of a subtask not completed are refused; with neither it orphans and retires', async () => {
    H.writeProtocol(main, macroId, { writtenBy: 'test' });
    let r = orch(['holds-retire', '--workflow-path', macroPath, '--macro-end', 'true']);
    strictEqual(r.status, 1);
    match(r.stderr, /has made no terminal write: its holds retire only after it/);
    r = orch(['holds-retire', '--workflow-path', macroPath, '--subtask-id', 'T2']);
    strictEqual(r.status, 1);
    match(r.stderr, /subtask T2 is pending: only a completed subtask's hold records retire/);
    await O.setHold({ mainRoot: main, macroId, subtaskId: 'T9', branch: 'feat/t9' });
    r = orch(['holds-retire', '--workflow-path', macroPath]);
    strictEqual(r.status, 0, r.stderr);
    match(r.stderr, /orphaned the hold [0-9a-f]{16} of subtask T9: subtask T9 left the plan/);
  });

  it('holds-preflight: silent when off; refuses an open operation and an engineer that is not hold-aware; passes the real engineer', () => {
    const pre = (...extra) => orch(['holds-preflight', '--workflow-path', macroPath, ...extra]);
    deepStrictEqual([pre().status, pre().stderr], [0, ''], 'off');
    H.writeProtocol(main, macroId, { writtenBy: 'test' });
    strictEqual(pre('--engineer-root', ENGINEER_ROOT).status, 0, pre('--engineer-root', ENGINEER_ROOT).stderr);
    let r = pre('--engineer-root', fakeEngineer);
    strictEqual(r.status, 1);
    match(r.stderr, /the holds of .* are on, and .*hold-persona-1/);
    match(r.stderr, /Nothing was written\./);
    strictEqual(pre('--engineer-root', '').status, 1, 'no engineer to check');
    opRecord(main, OP, macroId, 'T2');
    r = pre('--engineer-root', ENGINEER_ROOT);
    strictEqual(r.status, 1);
    match(r.stderr, new RegExp(`is not closed while its lanes may still be written[\\s\\S]*a persona operation is open in subtask T2's lane: ${OP}`));
  });

  it('holds-preflight under an autopilot run: the run\'s own finalize worker, which names no lane, is the caller, not a busy lane', () => {
    const pre = (env = {}) => orch(['holds-preflight', '--workflow-path', macroPath, '--engineer-root', ENGINEER_ROOT], env);
    H.writeProtocol(main, macroId, { writtenBy: 'test' });
    workerEntry(main, null, macroId);
    let r = pre();
    strictEqual(r.status, 1, 'outside the run, a live worker group naming no lane makes every lane busy');
    match(r.stderr, /subtask T1's lane is busy: a worker group of run .* names no lane/);
    r = pre({ AGENTIC_AUTOPILOT: RUN });
    deepStrictEqual([r.status, r.stderr], [0, ''], 'its own run passes');
    r = pre({ AGENTIC_AUTOPILOT: 'autopilot-20261026T000000Z-999999' });
    strictEqual(r.status, 1, 'another run\'s worker is still busy');
  });

  for (const [name, status, phase] of [['abort', 'abandoned', 'aborted'], ['finalize', 'deferred', 'finalized']]) {
    for (const shell of SHELLS) {
      it(`${name}.md (${shell}): an open operation stops it before the first write; a held lane alone closes, its holds retired after the terminal write`, async () => {
        H.writeProtocol(main, macroId, { writtenBy: 'test' });
        opRecord(main, OP, macroId, 'T2');
        const script = phases(name, '## Phase 4');
        const refused = runIn(shell, typed(script, `--workflow=${macroId}`));
        strictEqual(refused.status, 1, refused.stdout);
        match(refused.stderr, new RegExp(`a persona operation is open in subtask T2's lane: ${OP}`));
        const fm = (await readWorkflow(macroPath)).frontmatter;
        deepStrictEqual([fm.plan.subtasks.map((s) => s.status), fm.terminal_marker ?? null], [['pending', 'pending'], null], 'nothing written');
        deepStrictEqual(readdirSync(RL.macroLockPath(main, macroId)).filter((x) => x.startsWith('s-')), [], 'the admission released');
        H.clearOperation(main, macroId, 'T2', OP, { by: 'owner' });
        const h = await holdT1();
        strictEqual((await handOverT1()).state, 'held');
        const closed = runIn(shell, typed(script, `--workflow=${macroId}`));
        strictEqual(closed.status, 0, closed.stderr);
        const after_ = (await readWorkflow(macroPath)).frontmatter;
        deepStrictEqual([after_.plan.subtasks[0].status, after_.current_phase, after_.terminal_marker], [status, phase, true]);
        match(closed.stderr, new RegExp(`retired the holds directory of ${macroId}: the macro ended`));
        strictEqual(existsSync(H.holdsDir(main, macroId)), false);
        strictEqual(RL.fenceState(lane, h.hold_id), 'absent', 'the fence went with it');
      });
    }

    it(`${name} (Codex mirror): the check runs before the bulk write and releases the admission; the holds retire after set-terminal`, async () => {
      const skill = readFileSync(join(ORCH_ROOT, 'core/skills', name, 'SKILL.md'), 'utf8');
      const blocks = [...skill.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1].replaceAll('<orchestrator-plugin-root>', ORCH_ROOT));
      const [phase1] = blocks.filter((b) => b.includes('admission join'));
      const [phase3] = blocks.filter((b) => b.includes('set-terminal'));
      const vars = `MACRO_ID='${macroId}'\nMACRO_PATH='${macroPath}'\n`;
      H.writeProtocol(main, macroId, { writtenBy: 'test' });
      opRecord(main, OP, macroId, 'T2');
      const refused = runIn(SHELLS[0], vars + phase1);
      strictEqual(refused.status, 1, refused.stdout);
      match(refused.stderr, /a persona operation is open in subtask T2's lane/);
      strictEqual((await subtask('T2')).status, 'pending', 'nothing written');
      deepStrictEqual(readdirSync(RL.macroLockPath(main, macroId)).filter((x) => x.startsWith('s-')), [], 'the admission released');
      H.clearOperation(main, macroId, 'T2', OP, { by: 'owner' });
      const joined = runIn(SHELLS[0], `${vars}${phase1}\necho "ADMISSION=$ADMISSION"`);
      strictEqual(joined.status, 0, joined.stderr);
      const id = joined.stdout.match(/^ADMISSION=([0-9a-f]{32})$/m)[1];
      const closed = runIn(SHELLS[0], `${vars}ADMISSION='${id}'\nREPO_ROOT='${lane}'\n${phase3}`);
      strictEqual(closed.status, 0, closed.stderr);
      strictEqual(existsSync(H.holdsDir(main, macroId)), false, 'retired after the terminal write');
    });

    // Phase 2 of the Codex mirror is the agent's to run: it routes every
    // `archived: false` answer of stop-archive to detach-archive, as the
    // Claude runbook's code does, `held-lane` included (the engineer's answer
    // for a terminal child in a held lane: test-hold-writer-inventory.mjs).
    it(`${name} (Codex mirror): Phase 2 routes any archived: false from stop-archive, held-lane included, to detach-archive, as ${name}.md does`, () => {
      const phase2 = (text) => text.slice(text.indexOf('## Phase 2'), text.indexOf('## Phase 3'));
      // Prose, judged with its line breaks folded.
      const skill = phase2(readFileSync(join(ORCH_ROOT, 'core/skills', name, 'SKILL.md'), 'utf8')).replace(/\s+/g, ' ');
      ok(skill.length > 0, `the ${name} skill has a Phase 2`);
      ok(/`state\.mjs detach-archive`[^;]*`archived: false`, whatever its `reason` \(`gate-not-met`, or `held-lane`|`archived: false`, whatever its `reason` \(`gate-not-met`, or `held-lane`[^;]*`state\.mjs detach-archive`/.test(skill), skill);
      ok(/that answer is not a failure/.test(skill), skill);
      const runbook = phase2(readFileSync(join(ORCH_ROOT, 'commands', `${name}.md`), 'utf8'));
      ok(/if \(envelope\.archived\) \{[\s\S]*?\} else \{\s*\n\s*process\.stdout\.write\(`  · child \$\{name\} not archivable[^\n]*\n\s*await detachArchive\(childPath\);|if \(envelope\.archived\) \{[\s\S]*?continue;\s*\n\s*\}[\s\S]*?not archivable[^\n]*\n\s*await detachArchive\(childPath\);/.test(runbook),
        `${name}.md sends every envelope that did not archive to detach-archive`);
    });
  }

  it("the Stop sweep finishes a done retirement that waited, once the operation ended; status retires an ended macro's directory", async () => {
    H.writeProtocol(main, macroId, { writtenBy: 'test' });
    strictEqual(setStatus('in_progress').status, 0);
    await holdT1();
    opRecord(main, OP, macroId, 'T1');
    strictEqual(complete().status, 0);
    strictEqual(H.readOwnerHold(main, macroId, 'T1').record.state, 'held', 'waited');
    H.clearOperation(main, macroId, 'T1', OP, { by: 'owner' });
    await retireEndedMacroHolds({ checkout: lane });
    strictEqual(H.readOwnerHold(main, macroId, 'T1').record.state, 'retired', 'the Stop finished it');
    await setMacroTerminal({ workflowPath: macroPath, host: 'claude', terminalPhase: 'finalized', terminalMarker: true, nextAction: 'archive' });
    const HC = await import(pathToFileURL(join(ORCH_ROOT, 'adapters/claude/autopilot/holds-cli.mjs')).href);
    deepStrictEqual(await HC.holdsStatusLines(main, macroId), [`holds of ${macroId}: retired (the macro has ended)`]);
    strictEqual(existsSync(H.holdsDir(main, macroId)), false);
  });

  it('the Stop sweep retires nothing while a workflow home of the macro cannot be looked at', { skip: process.getuid?.() === 0 && 'root reads any directory' }, async () => {
    H.writeProtocol(main, macroId, { writtenBy: 'test' });
    const archive = join(main, '.agentic-plugins/state/orchestrator/archive');
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, `${macroId}.md`), readFileSync(macroPath, 'utf8'));
    const home = join(main, '.agentic-plugins/state/orchestrator/workflows');
    execFileSync('chmod', ['000', home]);
    try {
      deepStrictEqual(await retireEndedMacroHolds({ checkout: lane }), []);
    } finally {
      execFileSync('chmod', ['755', home]);
    }
    ok(existsSync(H.holdsDir(main, macroId)), 'the live macro keeps its holds');
  });

  it('the Stop sweep retires the holds directory of an archived macro a crash left, and never a live macro\'s', async () => {
    H.writeProtocol(main, macroId, { writtenBy: 'test' });
    // An archived copy beside the live file (a copy restored by hand): live wins.
    const archive = join(main, '.agentic-plugins/state/orchestrator/archive');
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, `${macroId}.md`), readFileSync(macroPath, 'utf8'));
    deepStrictEqual(await retireEndedMacroHolds({ checkout: lane }), [], 'the macro is live');
    ok(existsSync(H.holdsDir(main, macroId)));
    execFileSync('mv', [macroPath, join(archive, `${macroId}.md`)]);
    deepStrictEqual(await retireEndedMacroHolds({ checkout: lane }), [macroId]);
    strictEqual(existsSync(H.holdsDir(main, macroId)), false);
  });
});

// The Task 12 review's findings, each pinned (plan-verify-20261026T150349Z-8192a2).
describe('retirement beside writers, stale looks and crash leftovers (the review of Task 12)', () => {
  /** An archived child of T1 carrying an entry-only operation (begun before the holds turned on: no record). */
  const archivedChildWithEntry = (main, id = 'op-20261026T000000Z-0000bbbb') => {
    const dir = join(main, '.agentic-plugins/state/engineer/archive');
    mkdirSync(dir, { recursive: true });
    const ops = JSON.stringify(JSON.stringify({ v: 1, ops: [{ id, kind: 'commit', opened_at: '2026-10-26T00:00:00Z', ext: false }] }));
    writeFileSync(join(dir, 'compose-20261026T000000Z-cccccc.md'), [
      '---', 'workflow_id: "compose-20261026T000000Z-cccccc"', 'git_baseline:', '  branch: "feat/t1"', `parent_workflow: "${MACRO}"`,
      'originating_subtask: "T1"', `persona_operations: ${ops}`, '---', '',
    ].join('\n'));
    return id;
  };

  it('a persona first write that publishes between the first look and the exclusion keeps the retirement waiting', () => withDirs(async ({ main }) => {
    activate(main);
    await hold(main);
    const r = await retire(main, { hooks: { beforeExclusion: () => { opRecord(main); } } });
    strictEqual(r.state, 'waiting');
    match(r.why, new RegExp(OP));
    strictEqual(H.readOwnerHold(main, MACRO, 'T1').record.state, 'held', 'nothing retired');
    deepStrictEqual(H.readOps(main, MACRO, 'T1').ops.map((o) => o.id), [OP], 'its own exclusion record withdrawn');
  }));

  it("an archived child's entry-only operation keeps the subtask's retirement and the macro's end waiting", () => withDirs(async ({ main }) => {
    activate(main);
    await hold(main);
    const id = archivedChildWithEntry(main);
    const r = await retire(main);
    strictEqual(r.state, 'waiting');
    match(r.why, new RegExp(id));
    const m = await O.retireMacroHolds({ mainRoot: main, macroId: MACRO, subtasks: [{ id: 'T1', branch: 'feat/t1' }] });
    strictEqual(m.state, 'waiting');
    match(m.why, new RegExp(`subtask T1's lane: ${id}`));
    ok(existsSync(H.holdsDir(main, MACRO)));
  }));

  it("a stale look at the plan retires nothing: stillCompleted and planNow are read under the lock", () => withDirs(async ({ main }) => {
    activate(main);
    const h = await hold(main);
    strictEqual((await retire(main, { stillCompleted: async () => false })).state, 'none');
    strictEqual(H.readOwnerHold(main, MACRO, 'T1').record.hold_id, h.hold_id);
    strictEqual(H.readOwnerHold(main, MACRO, 'T1').record.state, 'held');
    const o = await O.orphanStale({ mainRoot: main, macroId: MACRO, subtasks: [], planNow: () => [{ id: 'T1', branch: 'feat/t1' }], stateRoots: [main] });
    deepStrictEqual(o, [], 'the plan read now has T1: nothing orphaned');
    deepStrictEqual(await O.orphanStale({ mainRoot: main, macroId: MACRO, planNow: () => null, stateRoots: [main] }), [], 'a plan that cannot be read orphans nothing');
  }));

  it("a macro's end waits while a hold's record cannot be read: its fence and its bytes would go with the directory", () => withDirs(async ({ main, lane }) => {
    activate(main);
    const h = await hold(main, { lane });
    strictEqual((await handOver(main)).state, 'held');
    writeFileSync(H.recordPath(main, MACRO, 'holds', 'T1'), '{');
    const m = await O.retireMacroHolds({ mainRoot: main, macroId: MACRO });
    strictEqual(m.state, 'waiting');
    match(m.why, /cannot be read .*--discard-unreadable` keeps a copy first/);
    strictEqual(RL.fenceState(lane, h.hold_id), 'present');
    strictEqual(readFileSync(H.recordPath(main, MACRO, 'holds', 'T1'), 'utf8'), '{');
  }));

  it("a persona first write that publishes between the macro end's first look and its lock keeps it waiting; its exclusion records go", () => withDirs(async ({ main }) => {
    activate(main);
    keepPark(main);
    const m = await O.retireMacroHolds({ mainRoot: main, macroId: MACRO, subtasks: [{ id: 'T1', branch: 'feat/t1' }], hooks: { beforeLock: () => { opRecord(main); } } });
    strictEqual(m.state, 'waiting');
    deepStrictEqual(H.readOps(main, MACRO, 'T1').ops.map((o) => o.id), [OP], 'only the persona record is left');
  }));

  it('I3: a retirement a crash stopped before its fence went is finished by the retry', () => withDirs(async ({ main, lane }) => {
    activate(main);
    const h = await hold(main, { lane });
    strictEqual((await handOver(main)).state, 'held');
    H.writeWhole(H.recordPath(main, MACRO, 'holds', 'T1'), { ...h, state: 'retired', retired_at: 'x' });
    rmSync(H.recordPath(main, MACRO, 'handoffs', 'T1'));
    strictEqual(RL.fenceState(lane, h.hold_id), 'present');
    strictEqual((await retire(main)).state, 'none');
    strictEqual(RL.fenceState(lane, h.hold_id), 'absent');
  }));

  it("an exclusion a dead release left does not keep the retirement waiting: it is swept", () => withDirs(async ({ main }) => {
    activate(main);
    await hold(main);
    const DEAD = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid;
    H.publishOpRecord(main, MACRO, 'T1', {
      operation_id: 'op-20261026T000000Z-0000dead', kind: 'release', subtask_id: 'T1', workflow_id: null, persona: 'orchestrator',
      host: null, opened_at: '2026-10-26T00:00:00Z', pid: DEAD, fingerprint: { kind: 'none' },
    });
    strictEqual((await retire(main)).state, 'retired');
    deepStrictEqual(H.readOps(main, MACRO, 'T1').ops, []);
  }));

  it('excludeChildWriters: refuses a held child, publishes a record a persona first write refuses beside, and withdraws it', () => withDirs(async ({ main }) => {
    const home = join(main, '.agentic-plugins/state/engineer/workflows');
    mkdirSync(home, { recursive: true });
    const f = join(home, 'compose-20261026T000000Z-aaaaaa.md');
    writeFileSync(f, ['---', 'workflow_id: "compose-20261026T000000Z-aaaaaa"', `parent_workflow: "${MACRO}"`, 'originating_subtask: "T1"', 'git_baseline:', '  branch: "feat/t1"', '---', ''].join('\n'));
    strictEqual(typeof await O.excludeChildWriters({ mainRoot: main, childPath: f }), 'function', 'holds off: nothing to exclude');
    activate(main);
    const withdraw = await O.excludeChildWriters({ mainRoot: main, childPath: f });
    const open = H.openOperations({ mainRoot: main, macroId: MACRO, subtaskId: 'T1', childPath: f }).open;
    deepStrictEqual(open.map((o) => o.kind), ['cutover'], 'a persona first write sees it open');
    withdraw();
    deepStrictEqual(H.openOperations({ mainRoot: main, macroId: MACRO, subtaskId: 'T1', childPath: f }).open, []);
    await hold(main);
    await O.excludeChildWriters({ mainRoot: main, childPath: f }).then(() => ok(false, 'refused'), (e) => match(e.message, /which is held/));
  }));
});
