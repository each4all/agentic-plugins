// ADR-0068 Decision 2, item 10 — the takeover acceptance against
// plugins/orchestrator (impl-hold plan, Task 14). The prototype beside this file
// (test-hold-takeover.mjs) drove the released persona against a scratch
// orchestrator half; here the orchestrator half is the real one: the owner's
// `hold`, `status` and `release` through `agentic-autopilot` (cli.mjs), and the
// driver's scheduler with lanes and a fake worker (the scripted worker the
// scheduler's own tests use). The person's session runs the generated blocks of
// the released engineer's runbooks (_runbook.mjs), its caches installed on both
// hosts, so holds turn on.
//
// The driver path runs with shared creation on (P12: real lanes need it); the
// command interoperability case, with it off, runs the commands and the
// persona alone. No `claude` is spawned: `claude --resume` itself stays
// [unverified]; the test pins the session id and the cwd `hold` prints for it.
// The persona-side cases the prototype holds (an operation begun before
// activation, a delayed cleared writer, a commit whose archive failed, the Stop
// orphan sweep) are mapped in README.md to the persona tests that hold them.

import { after, describe, it } from 'node:test';
import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The blocks and the Stop hook below run in this process's environment: no
// AGENTIC_* (this session's run) and no GIT_* (an inherited GIT_INDEX_FILE or
// GIT_DIR would point the fixture's git at another repository).
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AGENTIC_') || k.startsWith('GIT_')) delete process.env[k];
}

const { AP, COMMIT, CRITIQUE, LN, ROOTS, setup } = await import('../../orchestrator/fixtures/autopilot-lanes-run.mjs');
const { makeRepo } = await import('../../orchestrator/fixtures/autopilot-repo.mjs');
const { H, laneEvents, P, RL } = await import('../../orchestrator/fixtures/autopilot-holds-run.mjs');
const orchestrator = await import(pathToFileURL(join(ROOTS.orchestrator, 'scripts/state.mjs')).href);
const RB = await import('./_runbook.mjs');

const { E, finalize, opDirOf, resumeVerb } = RB;
const C = await import(pathToFileURL(join(AP, 'cli.mjs')).href);
const STATE_BIN = E.path('scripts/state.mjs');
const engineer = await import(pathToFileURL(STATE_BIN).href);

after(() => RB.cleanupScratch());

// The released engineer on both hosts' caches, as an install leaves it: what
// holds need to turn on (N2, N8).
function installEngineer(home) {
  const version = JSON.parse(readFileSync(E.path('.claude-plugin/plugin.json'), 'utf8')).version;
  for (const base of ['.claude/plugins/cache/agentic-plugins/engineer', '.codex/plugins/cache/agentic-plugins/engineer']) {
    mkdirSync(join(home, base), { recursive: true });
    symlinkSync(ROOTS.engineer, join(home, base, version));
  }
}

// A run the test started and has not awaited yet: stopped (its waits opened,
// then SIGTERM) and awaited before the fixture goes, so a test that failed
// early never leaves a driver writing into a removed directory.
function startDriver(t) {
  const running = t.run();
  t.running = running;
  running.then(() => { if (t.running === running) t.running = null; }, () => {});
  return running;
}
async function withRun(opts, fn) {
  const t = await setup(opts);
  // The person's shell blocks make their directories here (TMPDIR), removed
  // with the test's own.
  t.tmp = RB.tempDir('hold-tmp-');
  try {
    installEngineer(t.env.HOME);
    return await fn(t);
  } finally {
    if (t.running) {
      writeFileSync(join(t.dir, 'hold-set'), '1');
      t.signals.emit('SIGTERM');
      await t.running.catch(() => {});
    }
    await RB.cleanupScratch();
    t.fx.cleanup();
  }
}

// The owner's commands, from the driver's checkout, as `agentic-autopilot`.
async function cli(t, argv) {
  const out = [];
  const err = [];
  const env = { ...t.env };
  delete env.AGENTIC_AUTOPILOT;
  const code = await C.main([...argv, '--macro', t.fx.macroId, '--repo', t.work], { env, io: { stdin: { isTTY: false } }, out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const holdIdOf = (text) => /hold ([0-9a-f]{16})/.exec(text)?.[1];

// The person's session in the lane: interactive, no run named, the released
// engineer and the repository's orchestrator.
const personEnv = (t) => {
  const env = { ...t.env, AGENTIC_ENGINEER_ROOT: ROOTS.engineer, AGENTIC_ORCHESTRATOR_ROOT: ROOTS.orchestrator, ...(t.tmp ? { TMPDIR: t.tmp } : {}) };
  for (const k of ['AGENTIC_AUTOPILOT', 'AGENTIC_AUTOPILOT_STEP', 'AGENTIC_STATE_BASE']) delete env[k];
  return env;
};

const fm = (p) => engineer.parseWorkflowFile(readFileSync(p, 'utf8')).frontmatter;
const opsOf = (p) => fm(p).persona_operations?.ops ?? [];
const activeChild = (lane, env) => execFileSync(process.execPath, [STATE_BIN, 'find-active', '--repo-root', lane], { cwd: lane, encoding: 'utf8', env }).trim();
const stepLines = (t) => t.latest().steps.map((s) => [s.subtask_id, s.kind, s.command, s.outcome]);
// The Stop hook's write at a turn end of a workflow left open: a snapshot. A
// later turn's is `later` minutes on, with another status digest, so it
// rewrites last_snapshot even when the test runs within one second.
const snapshotAtStop = (p, later = 0) => engineer.snapshot({
  workflowPath: p, host: 'claude', trigger: 'stop', env: process.env,
  now: new Date(Date.now() + later * 60_000), statusDigest: later === 0 ? undefined : 'f'.repeat(64),
});

/**
 * Run 1: the driver dispatches A in its lane; the owner holds A through
 * `agentic-autopilot hold` while the step is still running; the step runs to
 * its end, the run hands the lane over and ends, every lane held. Returns the
 * hold id, the lane, the child and the step's session.
 */
async function heldMidStep(t) {
  const running = startDriver(t);
  // The step has recorded its child's next step and waits before its turn
  // ends (its Stop hooks): it is still running when the owner holds A.
  const lane = t.lane('A');
  let child = '';
  for (const until = Date.now() + 30_000; Date.now() < until;) {
    child = existsSync(lane) ? activeChild(lane, personEnv(t)) : '';
    if (child && fm(child).next_step_kind) break;
    await new Promise((r) => { setTimeout(r, 50); });
  }
  ok(child && fm(child).next_step_kind, `the step recorded its next step:\n${t.lines.join('\n')}`);
  const h = await cli(t, ['hold', 'A']);
  strictEqual(h.code, 0, h.err);
  const holdId = holdIdOf(h.out);
  ok(/\(pending\)/.test(h.out) && /completes the handoff/.test(h.out), h.out);
  writeFileSync(join(t.dir, 'hold-set'), '1');
  strictEqual(await running, 2, t.lines.join('\n'));
  const started = t.latest().steps.find((s) => s.subtask_id === 'A');
  deepStrictEqual(stepLines(t), [['A', 'dispatch', `/orchestrator:next A --workflow=${t.fx.macroId}`, 'ok']], 'the step in flight ran to its end, and nothing after it');
  strictEqual(H.holdStateOf(t.work, t.fx.macroId, 'A').state, 'held', t.lines.join('\n'));
  strictEqual(activeChild(lane, personEnv(t)), child);
  // Item 5: what the person resumes, `claude --resume` of the lane's last
  // session, from the lane. The resume itself stays [unverified].
  strictEqual(started.cwd, lane);
  ok(h.out.includes(`lane: ${lane}`) && h.out.includes(`its last session: claude --resume ${started.session_id} (worked in ${lane})`), h.out);
  return { holdId, lane, child };
}

const oneLane = (next, extra = {}) => ({
  subtasks: [{ id: 'A' }],
  scenario: { A: { next, file: true }, actions: { 1: ['stop-wait:hold-set'] }, ...extra },
});

describe('the takeover against the orchestrator (Decision 2, item 10): the driver, hold, status and release', () => {
  it("a person's verb in the held lane, its ensemble a barrier: the release refuses until it settles, then is consumed, and the driver's next step runs the person's verb", () => withRun(oneLane([CRITIQUE, COMMIT]), async (t) => {
    const { holdId, lane, child } = await heldMidStep(t);
    const env = personEnv(t);

    const resumed = resumeVerb(lane, env);
    strictEqual(resumed.status, 0, resumed.stderr);
    const opDir = opDirOf(resumed);
    const [open] = opsOf(child);
    strictEqual(open.kind, 'verb');
    const barrier = RB.newBarrier();
    const ensemble = RB.dispatchEnsemble(lane, { ...env, AGENTIC_COMPANIONS_ROOT: RB.fakeCompanions({ barrier }) });
    await RB.waitFor(`${barrier}.started`);
    let r = await cli(t, ['release', 'A', '--hold', holdId]);
    strictEqual(r.code, 1, r.out);
    ok(r.err.includes(open.id) && /has a pending peer ensemble/.test(r.err), r.err);
    const status = await cli(t, ['status']);
    ok(status.out.includes(`A: held (hold ${holdId})`) && status.out.includes(open.id), status.out);
    writeFileSync(barrier, '');
    const ran = await ensemble.done;
    strictEqual(ran.status, 0, ran.stderr);
    r = await cli(t, ['release', 'A', '--hold', holdId]);
    ok(r.code === 1 && /has a pending peer ensemble/.test(r.err), `ended, the peer is still pending until the finalize settles it: ${r.err}`);

    const fin = finalize(lane, env, opDir, { verb: 'refine' }, ensemble.dir);
    strictEqual(fin.status, 0, fin.stderr);
    match(fin.stderr, /stays open \(ADR-0068 Decision 2, item 6\): subtask A is held/);
    const f = fm(child);
    deepStrictEqual([f.next_step_kind, f.next_step_verb, f.terminal_marker, f.persona_operations, f.pending_ensemble ?? []], ['verb', 'refine', undefined, undefined, []]);
    await snapshotAtStop(child);

    r = await cli(t, ['release', 'A', '--hold', holdId]);
    strictEqual(r.code, 0, r.err);
    await snapshotAtStop(child, 1);
    strictEqual(H.holdStateOf(t.work, t.fx.macroId, 'A').state, 'released-uncompared');

    t.lines.length = 0;
    strictEqual(await t.run(), 2, t.lines.join('\n'));
    const rel = H.readRecord(t.work, t.fx.macroId, 'releases', 'A').record;
    strictEqual(rel.state, 'consumed', t.lines.join('\n'));
    deepStrictEqual(laneEvents(t, t.latest()).filter((e) => e.event === 'released').map((e) => [e.subtask_id, e.verdict]), [['A', 'consumed']]);
    const steps = stepLines(t);
    deepStrictEqual(steps[0], ['A', 'verb', '/engineer:refine', 'ok'], JSON.stringify(steps));
  }));

  // The person's verb in the held lane: Phase 0 resume, optionally a file
  // written and recorded in the commit manifest, and the finalize recording
  // `next`.
  function personVerb(t, lane, child, next, file = null) {
    const env = personEnv(t);
    const resumed = resumeVerb(lane, env);
    strictEqual(resumed.status, 0, resumed.stderr);
    if (file) {
      writeFileSync(join(lane, file), 'by the person\n');
      const rec = spawnSync(process.execPath, [STATE_BIN, 'record-composed-file', '--workflow-path', child, '--path', file, '--op', 'create'], { cwd: lane, encoding: 'utf8', env });
      strictEqual(rec.status, 0, rec.stderr);
    }
    const fin = finalize(lane, env, opDirOf(resumed), next);
    strictEqual(fin.status, 0, fin.stderr);
    return env;
  }
  const releaseOk = async (t, holdId) => {
    const r = await cli(t, ['release', 'A', '--hold', holdId]);
    strictEqual(r.code, 0, r.err);
  };

  it("the person's next step commit: the driver's commit step commits what the person's verb recorded", () => withRun(oneLane([CRITIQUE]), async (t) => {
    const { holdId, lane, child } = await heldMidStep(t);
    personVerb(t, lane, child, { commit: true }, 'person.txt');
    deepStrictEqual([fm(child).next_step_kind, fm(child).terminal_marker], ['commit', undefined]);
    strictEqual(RL.fenceState(lane, holdId), 'present', 'the held lane is fenced');
    await releaseOk(t, holdId);
    strictEqual(RL.fenceState(lane, holdId), 'absent', 'the release itself removes its fence');
    const base = t.git(lane, 'rev-parse', 'HEAD');
    t.lines.length = 0;
    strictEqual(await t.run(), 2, t.lines.join('\n'));
    strictEqual(H.readRecord(t.work, t.fx.macroId, 'releases', 'A').record.state, 'consumed');
    deepStrictEqual(stepLines(t)[0], ['A', 'commit', '/engineer:commit', 'ok'], JSON.stringify(stepLines(t)));
    notStrictEqual(t.git(lane, 'rev-parse', 'refs/heads/feat/a'), base, 'committed');
    strictEqual(t.git(lane, 'show', 'refs/heads/feat/a:person.txt'), 'by the person');
    strictEqual(t.git(lane, 'show', 'refs/heads/feat/a:a.txt'), 'A', "the worker's own file rides with it");
  }));

  it("the person's owner decision: the gate stays on the open workflow, the release is consumed, and the driver parks the lane", () => withRun(oneLane([CRITIQUE]), async (t) => {
    const { holdId, lane, child } = await heldMidStep(t);
    personVerb(t, lane, child, { gate: true });
    const f = fm(child);
    deepStrictEqual([f.next_step_kind, f.awaiting_owner_gate, f.terminal_marker], ['owner-decision', 'scope-routing', undefined]);
    // A file where the runtime's session capture writes, in the lane's own
    // ignored state root (synthetic: the runtime's writer does not run), and
    // written again after the release, as the session's last turn would.
    const capture = join(lane, '.agentic-plugins/state/runtime/session-capture');
    mkdirSync(capture, { recursive: true });
    writeFileSync(join(capture, 'note.json'), '{"schema":"runtime-session-note"}\n');
    await releaseOk(t, holdId);
    writeFileSync(join(capture, 'note.json'), '{"schema":"runtime-session-note","later":true}\n');
    t.lines.length = 0;
    strictEqual(await t.run(), 2, t.lines.join('\n'));
    strictEqual(H.readRecord(t.work, t.fx.macroId, 'releases', 'A').record.state, 'consumed');
    deepStrictEqual(stepLines(t), [], 'nothing stepped');
    const park = P.readPark(t.work, t.fx.macroId, 'A');
    strictEqual(park.state, 'ok', t.lines.join('\n'));
    ok(/scope-routing/.test(JSON.stringify(park.record)), JSON.stringify(park.record));
  }));

  it("the person's commit: an operation through its archive and the real parent writeback; then the release is compared and the lane waits to land", () => withRun(oneLane([CRITIQUE]), async (t) => {
    const { holdId, lane, child } = await heldMidStep(t);
    const env = personVerb(t, lane, child, { commit: true }, 'person.txt');
    const base = t.git(lane, 'rev-parse', 'HEAD');
    const commit = RB.runBlock(lane, RB.regionBlock('commands/commit.md', 'commit-execute'), env);
    strictEqual(commit.status, 0, `${commit.stdout}\n${commit.stderr}`);
    notStrictEqual(t.git(lane, 'rev-parse', 'HEAD'), base, 'the person committed');
    const [op] = opsOf(child);
    strictEqual(op?.kind, 'commit', 'the commit is open until its archive');
    const refused = await cli(t, ['release', 'A', '--hold', holdId]);
    ok(refused.code === 1 && refused.err.includes(op.id), refused.err);
    // The turn's end: the engineer's real Stop hook archives the child, then
    // writes the parent's note through the orchestrator's writer, which waits
    // here on the macro's file lock. Inside that slot the archived child still
    // carries the commit's operation, and the release refuses it.
    const archived = join(resolve(child, '../../archive'), child.split('/').at(-1));
    let stop;
    await orchestrator.withFileLock(t.fx.macroPath, async () => {
      stop = RB.startBlock(lane, `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(E.path('adapters/claude/hooks/stop.mjs'))} <<< ${JSON.stringify(JSON.stringify({ cwd: lane }))}`, env);
      for (const until = Date.now() + 30_000; Date.now() < until && !(existsSync(archived) && !existsSync(child));) await new Promise((r) => { setTimeout(r, 50); });
      ok(existsSync(archived) && !existsSync(child), 'the Stop hook archived the child before its parent note');
      deepStrictEqual(opsOf(archived).map((o) => o.id), [op.id], 'the archived child still carries the commit');
      const inSlot = await cli(t, ['release', 'A', '--hold', holdId]);
      ok(inSlot.code === 1 && inSlot.err.includes(op.id), `refused inside the parent note's slot: ${inSlot.err}`);
    });
    const stopped = await stop;
    strictEqual(stopped.status, 0, stopped.stderr);
    deepStrictEqual([fm(archived).persona_operations, H.openOperations({ mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', childPath: archived }).open], [undefined, []], 'the note done, the operation ended');
    // The parent's note of the terminal commit (ADR-0062 Decision 2), by the
    // orchestrator's own writer.
    const wf = (await t.fx.subtask('A')).engineer_workflow_id;
    const head = t.git(lane, 'rev-parse', 'HEAD');
    ok(readFileSync(t.fx.macroPath, 'utf8').includes(`### engineer terminal: "A" @ ${wf} ${head}`), stopped.stderr);
    await releaseOk(t, holdId);
    t.lines.length = 0;
    strictEqual(await t.run(), 2, t.lines.join('\n'));
    strictEqual(H.readRecord(t.work, t.fx.macroId, 'releases', 'A').record.state, 'consumed', t.lines.join('\n'));
    deepStrictEqual(stepLines(t), [], `the lane waits to land:\n${t.lines.join('\n')}`);
    const r = t.latest();
    strictEqual(r.halt?.reason, 'awaiting-landing', JSON.stringify(r.halt));
    const a = r.run.lanes?.lanes?.find((l) => l.subtask_id === 'A');
    deepStrictEqual([a?.state, a?.waiting?.commit], ['waiting-to-land', head], JSON.stringify(a));
    deepStrictEqual(P.readPark(t.work, t.fx.macroId, 'A'), { state: 'absent' }, 'no park: the lane waits to land');
  }));

  it('a hand edit after the release rejects it: the lane parks owner-choice, status says so, and only a new hold and release give it back', () => withRun(oneLane([CRITIQUE, COMMIT]), async (t) => {
    const { holdId, lane } = await heldMidStep(t);
    await releaseOk(t, holdId);
    writeFileSync(join(lane, 'a.txt'), 'edited after the release\n');
    t.lines.length = 0;
    strictEqual(await t.run(), 2, t.lines.join('\n'));
    strictEqual(H.readRecord(t.work, t.fx.macroId, 'releases', 'A').record.state, 'rejected');
    deepStrictEqual(stepLines(t), []);
    const park = P.readPark(t.work, t.fx.macroId, 'A');
    deepStrictEqual([park.state, park.record?.reason], ['ok', 'owner-choice']);
    ok((await cli(t, ['status'])).out.includes(`A: release rejected (hold ${holdId})`));
    // Put back: nothing given back. A relaunch compares it no more, keeps
    // its park and steps nothing.
    writeFileSync(join(lane, 'a.txt'), 'A\n');
    const rejected = H.readRecord(t.work, t.fx.macroId, 'releases', 'A').record;
    t.lines.length = 0;
    strictEqual(await t.run(), 2, t.lines.join('\n'));
    deepStrictEqual(H.readRecord(t.work, t.fx.macroId, 'releases', 'A').record, rejected, 'the same rejection, never compared again');
    strictEqual(P.readPark(t.work, t.fx.macroId, 'A').record?.record_id, park.record.record_id);
    deepStrictEqual(stepLines(t), []);
    // A new hold and release, consumed, end the park.
    const again = await cli(t, ['hold', 'A']);
    strictEqual(again.code, 0, again.err);
    await releaseOk(t, holdIdOf(again.out));
    t.lines.length = 0;
    strictEqual(await t.run(), 2, t.lines.join('\n'));
    strictEqual(H.readRecord(t.work, t.fx.macroId, 'releases', 'A').record.state, 'consumed');
    ok(stepLines(t).some((s) => s[0] === 'A'), t.lines.join('\n'));
  }));

  it("a hand edit in no manifest is compared in; the resumed worker's commit stops at the staging-set gate, and the lane parks", () => withRun(oneLane([CRITIQUE, COMMIT]), async (t) => {
    const { holdId, lane } = await heldMidStep(t);
    writeFileSync(join(lane, '.gitignore'), `${readFileSync(join(lane, '.gitignore'), 'utf8')}# by hand\n`);
    await releaseOk(t, holdId);
    const base = t.git(lane, 'rev-parse', 'HEAD');
    t.lines.length = 0;
    strictEqual(await t.run(), 2, t.lines.join('\n'));
    strictEqual(H.readRecord(t.work, t.fx.macroId, 'releases', 'A').record.state, 'consumed');
    deepStrictEqual(stepLines(t).map((s) => s.slice(0, 3)), [['A', 'verb', '/engineer:critique'], ['A', 'commit', '/engineer:commit']], t.lines.join('\n'));
    strictEqual(t.git(lane, 'rev-parse', 'HEAD'), base, 'nothing was committed');
    const park = P.readPark(t.work, t.fx.macroId, 'A');
    strictEqual(park.state, 'ok', t.lines.join('\n'));
    ok(/staging-set/.test(JSON.stringify(park.record)), JSON.stringify(park.record));
  }));

  it("a peer run the session started itself (/engineer:peer-now): the release waits for its note; the run's ledger names no workflow, and the driver goes on beside it", () => withRun(oneLane([CRITIQUE, COMMIT]), async (t) => {
    const { holdId, lane, child } = await heldMidStep(t);
    const dispatchDir = RB.textDir({ 'prompt.xml': '<task>x</task>' });
    const barrier = RB.newBarrier();
    const env = { ...personEnv(t), AGENTIC_COMPANIONS_ROOT: RB.fakeCompanions({ barrier }) };
    const running = RB.startBlock(lane, RB.fill(RB.regionBlock('commands/peer-now.md', 'peer-now-dispatch'), [
      ["TEXT_DIR='<directory from step 1>'", `TEXT_DIR='${dispatchDir}'`], ["PEER='<claude|codex, from --peer>'", "PEER='codex'"],
    ]), env);
    await RB.waitFor(`${barrier}.started`);
    const [op] = opsOf(child);
    strictEqual(op?.kind, 'peer');
    let r = await cli(t, ['release', 'A', '--hold', holdId]);
    ok(r.code === 1 && r.err.includes(op.id), `refused while the peer runs: ${r.err}`);
    writeFileSync(barrier, '');
    strictEqual((await running).status, 0);
    r = await cli(t, ['release', 'A', '--hold', holdId]);
    ok(r.code === 1 && r.err.includes(op.id), `ended, it waits for its note: ${r.err}`);
    const n = RB.runBlock(lane, RB.fill(RB.regionBlock('commands/peer-now.md', 'peer-now-note'), [["DISPATCH_DIR='<the directory the dispatch ran with>'", `DISPATCH_DIR='${dispatchDir}'`]]), env);
    strictEqual(n.status, 0, n.stderr);
    strictEqual(fm(child).persona_operations, undefined);
    await releaseOk(t, holdId);
    const runId = readFileSync(join(dispatchDir, 'prompt.xml.run-id'), 'utf8').trim();
    const handle = JSON.parse(readFileSync(join(resolve(child, '../..'), 'peer-runs', runId, 'handle.json'), 'utf8'));
    deepStrictEqual([handle.status, handle.workflow_path ?? null], ['completed', null], 'the consultation names no workflow');
    t.lines.length = 0;
    strictEqual(await t.run(), 2, t.lines.join('\n'));
    strictEqual(H.readRecord(t.work, t.fx.macroId, 'releases', 'A').record.state, 'consumed', t.lines.join('\n'));
    deepStrictEqual(stepLines(t).map((x) => x.slice(0, 4)), [['A', 'verb', '/engineer:critique', 'ok'], ['A', 'commit', '/engineer:commit', 'ok']], t.lines.join('\n'));
  }));

  // Critique round 6, M3: the person commits on the branch before the
  // release, so the run creates the lane at the handed-back tip (row 12, ADR-0062
  // Decision 2, amendment of 2026-10-27) and must dispatch there.
  it('no child: a hold set before the run keeps A undispatched; a bootstrap on its branch is refused; the release is consumed and the driver dispatches on the person\'s commit', () => withRun({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT], file: true } } }, async (t) => {
    const h = await cli(t, ['hold', 'A']);
    strictEqual(h.code, 0, h.err);
    const holdId = holdIdOf(h.out);
    ok(/\(held\)/.test(h.out) && /has no lane yet/.test(h.out), h.out);
    strictEqual(await t.run(), 2, t.lines.join('\n'));
    deepStrictEqual(stepLines(t), []);
    ok(t.lines.some((l) => l.includes(`lane A: held (hold ${holdId})`)), t.lines.join('\n'));
    // The person's checkout of the branch: an unlinked bootstrap there is refused (item 5).
    const mine = join(t.dir, 'mine');
    t.git(t.work, 'worktree', 'add', '-q', '-b', 'feat/a', mine, 'refs/remotes/origin/main');
    const refused = RB.bootstrap(mine, personEnv(t));
    notStrictEqual(refused.status, 0);
    match(refused.stderr, /held lane of .*\(subtask A: hold [0-9a-f]{16} is held\).*Decision 2, item 5/);
    strictEqual(activeChild(mine, personEnv(t)), '', 'no workflow was created');
    writeFileSync(join(mine, 'person-work.txt'), 'handed back\n');
    t.git(mine, 'add', 'person-work.txt');
    t.git(mine, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'person work');
    const personTip = t.git(mine, 'rev-parse', 'HEAD');
    t.git(t.work, 'worktree', 'remove', mine);
    await releaseOk(t, holdId);
    t.lines.length = 0;
    strictEqual(await t.run(), 2, t.lines.join('\n'));
    strictEqual(H.readRecord(t.work, t.fx.macroId, 'releases', 'A').record.state, 'consumed', t.lines.join('\n'));
    deepStrictEqual(stepLines(t)[0]?.slice(0, 2), ['A', 'dispatch'], t.lines.join('\n'));
    t.git(t.work, 'merge-base', '--is-ancestor', personTip, 'refs/heads/feat/a');
  }));
});

// Shared creation off: the workflows live in the lane's own checkout. No run
// with lanes works so (P12); the owner's commands and the persona must still
// agree on the lane: a dispatch made by hand in a worktree at the lane's path.
describe('command interoperability, shared creation off (the workflows in the lane\'s checkout)', () => {
  it("hold waits on the dispatched verb's operation, status completes the handoff once it closes, the release refuses beside the person's operation and records the digest of the child in the lane's checkout", async () => {
    const fx = await makeRepo({ subtasks: [{ id: 'A' }] });
    const home = join(fx.dir, 'home');
    mkdirSync(home);
    installEngineer(home);
    const env = { ...fx.env, HOME: home, AGENTIC_ENGINEER_ROOT: ROOTS.engineer, AGENTIC_ORCHESTRATOR_ROOT: ROOTS.orchestrator, AGENTIC_RUNTIME_ROOT: ROOTS.runtime };
    const t = { env, work: fx.work, fx, tmp: RB.tempDir('hold-tmp-') };
    try {
      const lane = LN.lanePath(LN.laneHome(fx.work), fx.macroId, 'A');
      mkdirSync(resolve(lane, '..'), { recursive: true });
      fx.git('worktree', 'add', '-q', '-b', 'feat/a', lane, 'refs/remotes/origin/main');
      // Locked with the run's reason, as a run's lane is: a release judges
      // whose lane a worktree is by that lock, as reconciliation does, and
      // refuses a worktree no run's lock names (critique round 5, L1).
      fx.git('worktree', 'lock', '--reason', LN.lockReason(fx.macroId, 'A'), lane);
      // The dispatch, as /orchestrator:next runs it in the lane: the bootstrap,
      // then the subtask in progress (its Phase 5).
      const boot = RB.bootstrap(lane, { ...personEnv(t), AGENTIC_PARENT_WORKFLOW: fx.macroId, AGENTIC_ORIGINATING_SUBTASK: 'A', AGENTIC_TOPIC: 'do A' });
      strictEqual(boot.status, 0, boot.stderr);
      const child = activeChild(lane, personEnv(t));
      strictEqual(resolve(child, '..'), join(lane, '.agentic-plugins/state/engineer/workflows'), "the child is in the lane's checkout");
      await fx.orch.updateSubtask({ workflowPath: fx.macroPath, subtaskId: 'A', host: 'claude', status: 'in_progress', engineerWorkflowId: fm(child).workflow_id });
      const [entry] = opsOf(child);

      const h = await cli(t, ['hold', 'A']);
      strictEqual(h.code, 0, h.err);
      const holdId = holdIdOf(h.out);
      ok(/\(pending\)/.test(h.out) && h.out.includes(entry.id), h.out);
      const fin = finalize(lane, personEnv(t), opDirOf(boot));
      strictEqual(fin.status, 0, fin.stderr);
      ok((await cli(t, ['status'])).out.includes(`A: held (hold ${holdId})`), 'status completed the handoff');

      const resumed = resumeVerb(lane, personEnv(t));
      strictEqual(resumed.status, 0, resumed.stderr);
      const [open] = opsOf(child);
      const refused = await cli(t, ['release', 'A', '--hold', holdId]);
      ok(refused.code === 1 && refused.err.includes(open.id), refused.err);
      strictEqual(finalize(lane, personEnv(t), opDirOf(resumed), { verb: 'refine' }).status, 0);
      const r = await cli(t, ['release', 'A', '--hold', holdId]);
      strictEqual(r.code, 0, r.err);
      const digest = JSON.parse(execFileSync(process.execPath, [STATE_BIN, 'content-digest', '--workflow-path', child], { encoding: 'utf8', env: personEnv(t) })).digest;
      const basis = H.readRecord(fx.work, fx.macroId, 'releases', 'A').record.basis;
      ok(basis.content_digest.endsWith(digest), JSON.stringify(basis));
      ok(/^\S+:[0-9a-f]{64}$/.test(basis.tree_digest), JSON.stringify(basis));
    } finally {
      await RB.cleanupScratch();
      fx.cleanup();
    }
  });
});
