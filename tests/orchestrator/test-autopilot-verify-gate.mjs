// ADR-0068 Decision 5, amendment of 2026-11-10 (C178) — the commit gate: in a
// run that offers verification over a declaration with a suite kind, a commit
// needs a batch that passed the whole suite on the lane's tree as it is, with
// the run's declaration and the lane's base.
//
//   - the evidence is the journal's (verify-journal.mjs suiteEvidence): each
//     part of its identity, and each thing that is no evidence;
//   - the facts the policy takes (verify-run.mjs verifyFacts, suiteFact): for
//     a child at a commit, for the owner's forced commit, with no gate when
//     the declaration has no suite kind or the run offers nothing;
//   - the policy (policy.mjs): every route to the commit (the next step, done
//     over a changed tree, the owner's forced commit serial and with lanes,
//     the recovery of an interrupted commit), the resume it takes instead,
//     its bound, and the record the driver writes as the step is admitted.
//   - the gate's status read (verify-run.mjs laneDirty) leaves the lane's
//     index as it found it.
// Function calls and one temporary directory for the journal; the status
// read's case runs git in a temporary repository.

import { after, describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const P = await import(join(AP, 'policy.mjs'));
const VR = await import(join(AP, 'verify-run.mjs'));
const VJ = await import(join(AP, 'verify-journal.mjs'));
const VD = await import(join(AP, 'verify-decl.mjs'));

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const MACRO = 'macro-plan-20261001T000000Z-abcdef';
const ENG_A = 'compose-20261001T000100Z-aaaaaa';
const ENG_B = 'compose-20261001T000200Z-bbbbbb';
const RUN = 'autopilot-20261020T010203Z-abcdef';
const TREE = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const CONTENT = 'c'.repeat(64);
const BASE = '1'.repeat(40);
const SUITE = ['npm', 'test'];
const DECL = VD.parseDeclaration(JSON.stringify({
  schema: 'agentic-verify-checks-1.0',
  kinds: {
    'test-suite': { argv: SUITE, slots: [], timeout_s: 60, locks_itself: false, adds_on: [] },
    pass: { argv: ['true'], slots: [], timeout_s: 60, locks_itself: false, adds_on: [] },
  },
}));
const OFFER = { offered: true, baseline: BASE, declaration: DECL };

// A journal's lines for one batch of request `req`: started on `tree` with
// `checks` (argv lists), ended `end` on `treeEnd`.
function batch({ req = 'r1', id = 'b1', tree = TREE, treeEnd = tree, end = 'passed', checks = [['true'], SUITE], digest = DECL.digest, base = BASE, meta = {} } = {}) {
  const payload = {
    batch_id: id, run_id: RUN, continues: null, tree_start: tree, declaration_commit: BASE, declaration_digest: digest,
    checks: checks.map((argv, index) => ({ index, kind: 'k', origin: 'worker', argv })), checks_digest: VD.checksDigest(checks), started_at: '2026-11-10T00:00:00Z',
  };
  return [
    { v: 1, op: 'start', request_id: req, batch_id: id, payload, meta: { verb: 'critique', base, checks_digest: payload.checks_digest, subtask_id: 'A', ...meta } },
    { v: 1, op: 'end', request_id: req, batch_id: id, payload: { tree_end: treeEnd, end, cause: null, ended_at: '2026-11-10T00:01:00Z' } },
  ];
}
const want = { tree: TREE, declarationDigest: DECL.digest, base: BASE, suiteArgv: SUITE };

describe('the suite\'s evidence is a passed batch of the journal, on this tree, declaration and base', () => {
  it('holds for a batch that passed with the suite among its checks', () => {
    deepStrictEqual(VJ.suiteEvidence(batch(), want), { batch_id: 'b1', request_id: 'r1' });
  });

  for (const [name, entries, over] of [
    ['a batch on another tree', batch({ tree: OTHER }), {}],
    ['a batch that started on another tree', batch({ tree: OTHER, treeEnd: TREE }), {}],
    ['a batch that ended on another tree', batch({ treeEnd: OTHER }), {}],
    ['a batch that failed', batch({ end: 'failed' }), {}],
    ['a batch cut short', batch({ end: 'cut-short' }), {}],
    ['a batch with no evidence', batch({ end: 'no-evidence' }), {}],
    ['a batch without the suite', batch({ checks: [['true'], ['npm', 'test', '--', 'tests/a.mjs']] }), {}],
    ['a batch run with another declaration', batch({ digest: 'd'.repeat(64) }), {}],
    ['a batch run with another base', batch({ base: '2'.repeat(40) }), {}],
    ['a batch whose start the journal does not hold', batch().slice(1), {}],
    ['a batch still open', batch().slice(0, 1), {}],
    ['a tree that cannot be read', batch(), { tree: null }],
    ['no journal entry', [], {}],
  ]) {
    it(`${name} is no evidence`, () => {
      strictEqual(VJ.suiteEvidence(entries, { ...want, ...over }), null);
    });
  }

  it('takes the latest passed batch, of any request of the workflow', () => {
    const entries = [...batch({ req: 'r1', id: 'b1' }), ...batch({ req: 'r2', id: 'b2', tree: OTHER }), ...batch({ req: 'r3', id: 'b3' })];
    strictEqual(VJ.suiteEvidence(entries, want).batch_id, 'b3');
    strictEqual(VJ.suiteEvidence(entries, { ...want, tree: OTHER }).batch_id, 'b2');
  });
});

// ---------------------------------------------------------------------------

const sub = (id, status, extra = {}) => ({ id, label: id, verb: 'compose', branch: `feat/${id.toLowerCase()}`, blocked_by: [], status, ...extra });
const child = (id, over = {}) => ({
  location: 'active', path: `/r/.agentic-plugins/state/engineer/workflows/${id}.md`, relPath: `.agentic-plugins/state/engineer/workflows/${id}.md`,
  workflow_id: id, branch: 'feat/a', current_phase: 'phase-2-presented', terminal_marker: false, verb: 'critique',
  next_step: { kind: 'commit', verb: null, confidence: 'HIGH' }, awaiting_owner: null, workflow_type: 'verb-chain',
  parent_detached: false, pending_ensemble: 0, pending_runs: [], ensemble_results: 1, commit_manifest: 1, progress: 3,
  parent_workflow: MACRO, originating_subtask: 'A', ...over,
});
function view(children, { subtasks = null } = {}) {
  const subs = subtasks ?? Object.entries(children).map(([id, c]) => sub(id, 'in_progress', { engineer_workflow_id: c.workflow_id, branch: c.branch }));
  return {
    repoRoot: '/r',
    git: { branch: 'feat/a', head: 'h0', porcelain: '', clean: true, detached: false },
    brief: { disposition: 'lead', leading: { command: '/orchestrator:resume' }, rows: [] },
    briefError: null,
    macro: {
      id: MACRO, path: `/r/.agentic-plugins/state/orchestrator/workflows/${MACRO}.md`, relPath: `.agentic-plugins/state/orchestrator/workflows/${MACRO}.md`, archived: false,
      fm: { workflow_id: MACRO, current_phase: 'phase-2-presented', terminal_marker: false, plan_approval_status: 'approved', plan_approval_plan_hash: 'f'.repeat(64), git_baseline: { branch: 'main' }, plan: { subtasks: subs }, host_history: [] },
    },
    macroLookupError: null,
    ready: { ready: null, reason: 'in_progress_or_blocked', readiness: [], approval: { status: 'approved', hash_ok: true } },
    readyError: null, children, foreign: null,
    claims: Object.entries(children).map(([id, c]) => ({ id: c.workflow_id, path: c.path, relPath: c.relPath, originating_subtask: id, branch: c.branch })),
    claimsError: null, landing: {},
  };
}
const COMMIT = { kind: 'commit', verb: null, confidence: 'HIGH' };
const DONE = { kind: 'done', verb: null, confidence: 'HIGH' };
const fact = (over = {}) => ({ ok: false, batch_id: null, why: 'no verification batch of this workflow passed the whole suite', dirty: true, tree: TREE, content: CONTENT, recovery: false, resumed: false, ...over });
const HAS = fact({ ok: true, batch_id: 'b1', why: null });
const gate = (suite, extra = {}) => ({ offered: true, why: null, suite: true, facts: { A: { suite, ...extra } } });
const one = (over = {}) => view({ A: child(ENG_A, over) });
const stepOf = (d) => (d.outcome === 'step' ? [d.step.kind, d.step.verb ?? null, d.step.resume ?? null] : [d.outcome, d.reason]);

describe('the commit gate at the next step', () => {
  it('with the evidence the commit goes, and carries the fact it was decided on', () => {
    const d = P.decide(one(), { verify: gate(HAS) });
    deepStrictEqual(stepOf(d), ['commit', null, null]);
    deepStrictEqual(d.step.suite, { batch_id: 'b1', content: CONTENT, tree: TREE });
  });

  it('without it the lane\'s last verb is resumed to end with the final verification, the driver\'s fixed sentence after its command', () => {
    const d = P.decide(one(), { verify: gate(fact()) });
    deepStrictEqual(stepOf(d), ['verb', 'critique', 'final-verify']);
    deepStrictEqual(d.step.gate.tree, TREE);
    const text = P.renderStep(d.step, { macroId: MACRO, runId: RUN });
    strictEqual(text, `/engineer:critique ${P.FINAL_VERIFY_SENTENCE}`);
    match(P.FINAL_VERIFY_SENTENCE, /^[A-Za-z0-9 .,:'_-]+$/, 'fixed text in a closed alphabet');
    match(P.FINAL_VERIFY_SENTENCE, /verify form.*test-suite.*on_pass commit/);
    // Control: a verb step the gate did not ask for is the bare command.
    strictEqual(P.renderStep({ kind: 'verb', verb: 'critique', resume: 'verify' }, { macroId: MACRO, runId: RUN }), '/engineer:critique');
  });

  it('a fact that was never read is no evidence', () => {
    deepStrictEqual(stepOf(P.decide(one(), { verify: { offered: true, suite: true, facts: {} } })), ['verb', 'critique', 'final-verify']);
  });

  it('a second resume on the same tree is no progress; a workflow that names no verb halts for the owner', () => {
    const again = P.decide(one(), { verify: gate(fact({ resumed: true })) });
    deepStrictEqual(stepOf(again), ['halt', 'no-progress']);
    match(again.detail, /resumed a verb on this tree already/);
    deepStrictEqual(stepOf(P.decide(one({ verb: null }), { verify: gate(fact()) })), ['halt', 'owner-choice']);
  });

  it('done over a tree with no change only closes; over a changed tree it is held as the commit is', () => {
    deepStrictEqual(stepOf(P.decide(one({ next_step: DONE }), { verify: gate(fact({ dirty: false })) })), ['commit', null, null]);
    deepStrictEqual(stepOf(P.decide(one({ next_step: DONE }), { verify: gate(fact({ dirty: true })) })), ['verb', 'critique', 'final-verify']);
  });

  it('no gate without the run\'s offer, or without a suite kind in its declaration', () => {
    for (const verify of [{ offered: false, suite: false, facts: {} }, { offered: true, suite: false, facts: {} }, { offered: false, suite: true, facts: {} }, null]) {
      const d = P.decide(one(), verify ? { verify } : {});
      deepStrictEqual(stepOf(d), ['commit', null, null], JSON.stringify(verify));
      strictEqual(d.step.suite, undefined);
    }
  });

  it('a lower confidence still halts first: the gate adds a condition, and removes none', () => {
    deepStrictEqual(stepOf(P.decide(one({ next_step: { ...COMMIT, confidence: 'MEDIUM' } }), { verify: gate(HAS) })), ['halt', 'low-confidence']);
  });
});

describe('the commit gate at the owner\'s forced commit', () => {
  const REFINE = { kind: 'verb', verb: 'refine', confidence: 'HIGH' };
  it('a serial run refuses it without the evidence, naming the verb as the way; with the evidence it goes', () => {
    const no = P.decide(one({ next_step: REFINE }), { forced: { kind: 'commit' }, verify: gate(fact()) });
    deepStrictEqual(stepOf(no), ['halt', 'owner-choice']);
    match(no.detail, /--next does not apply: subtask A: the commit gate holds it.*Force the verb instead/);
    const yes = P.decide(one({ next_step: REFINE }), { forced: { kind: 'commit' }, verify: gate(HAS) });
    deepStrictEqual(stepOf(yes), ['commit', null, null]);
    strictEqual(yes.step.forced, true);
    deepStrictEqual(yes.step.suite, { batch_id: 'b1', content: CONTENT, tree: TREE });
    // The content of a commit admitted earlier stands in for the evidence only
    // while that commit is begun: at a verb it lets no forced commit through.
    const stale = P.decide(one({ next_step: REFINE }), { forced: { kind: 'commit' }, verify: gate(fact({ recovery: true })) });
    deepStrictEqual(stepOf(stale), ['halt', 'owner-choice']);
    const taken = P.decide(one({ current_phase: 'phase-7-commit' }), { forced: { kind: 'commit' }, verify: gate(fact({ recovery: true })) });
    deepStrictEqual(stepOf(taken), ['commit', null, null]);
    // Taken up on the earlier admission, whose record stands: interrupted
    // again, it is judged as it was.
    strictEqual(taken.step.suite.admitted, true);
    strictEqual(yes.step.suite.admitted, undefined);
    // The forced verb is the way past the gate's halts.
    deepStrictEqual(stepOf(P.decide(one(), { forced: { kind: 'verb', verb: 'refine' }, verify: gate(fact({ resumed: true })) })), ['verb', 'refine', null]);
  });

  it('with lanes it is refused when the pairs are judged, and again at each decision', () => {
    const v = one({ next_step: REFINE });
    const pairs = [{ lane: 'A', step: { kind: 'commit' } }];
    match(P.forcedForLanes(pairs, v, gate(fact())).halt.detail, /the commit gate holds it/);
    const f = P.forcedForLanes(pairs, v, gate(HAS));
    ok(f.forced);
    const ctx = (verify) => ({ forced: f.forced, started: new Set(['A']), lanes: new Map(), verify });
    const held = P.decideLanes(v, ctx(gate(fact())));
    deepStrictEqual(held.laneSteps, []);
    match(held.laneHalts[0].detail, /--next does not apply: subtask A: the commit gate holds it/);
    match(P.forcedForLanes(pairs, v, gate(fact({ recovery: true }))).halt.detail, /the commit gate holds it/);
    strictEqual(P.decideLanes(v, ctx(gate(fact({ recovery: true })))).laneSteps.length, 0, 'no begun commit: an earlier admission lets nothing through');
    const goes = P.decideLanes(v, ctx(gate(HAS)));
    deepStrictEqual(goes.laneSteps.map((s) => [s.kind, s.forced, s.suite?.batch_id, s.suite?.admitted]), [['commit', true, 'b1', undefined]]);
    const begun = one({ current_phase: 'phase-7-commit' });
    const again = P.decideLanes(begun, { forced: P.forcedForLanes(pairs, begun, gate(fact({ recovery: true }))).forced, started: new Set(['A']), lanes: new Map(), verify: gate(fact({ recovery: true })) });
    deepStrictEqual(again.laneSteps.map((s) => [s.kind, s.forced, s.suite?.admitted]), [['commit', true, true]], 'a begun commit forced on its admitted content keeps that admission');
  });
});

describe('the commit gate at the recovery of an interrupted commit', () => {
  const interrupted = () => one({ current_phase: 'phase-7-commit' });
  it('is taken up on the content the driver admitted the commit on, though its commit moved the tree digest', () => {
    const d = P.decide(interrupted(), { verify: gate(fact({ recovery: true })) });
    deepStrictEqual([d.step?.kind, d.step?.recovery], ['commit', true]);
    // The step carries the fact it was decided on, for the admission to
    // compare the lane with, marked as the earlier admission's.
    deepStrictEqual(d.step.suite, { batch_id: null, content: CONTENT, tree: TREE, admitted: true });
  });

  it('with the suite\'s evidence for the tree as it is, it is a commit admitted anew', () => {
    const d = P.decide(interrupted(), { verify: gate(HAS) });
    deepStrictEqual([d.step?.kind, d.step?.recovery], ['commit', true]);
    deepStrictEqual(d.step.suite, { batch_id: 'b1', content: CONTENT, tree: TREE });
  });

  it('on another content it halts for the owner, and the owner\'s forced verb replaces the halt', () => {
    const d = P.decide(interrupted(), { verify: gate(fact()) });
    deepStrictEqual(stepOf(d), ['halt', 'owner-choice']);
    match(d.detail, /its commit was interrupted, and the lane is not as the driver admitted that commit/);
    deepStrictEqual(stepOf(P.decide(interrupted(), { forced: { kind: 'verb', verb: 'refine' }, verify: gate(fact()) })), ['verb', 'refine', null]);
    // A lane with no change: the command only closes the workflow (a done
    // over a clean tree, or a commit made, whose archive did not run).
    const clean = P.decide(interrupted(), { verify: gate(fact({ dirty: false })) });
    deepStrictEqual([clean.step?.kind, clean.step?.recovery, clean.step?.suite?.admitted], ['commit', true, true]);
    const closed = P.decide(one({ current_phase: 'close-complete', terminal_marker: true }), { verify: gate(fact({ dirty: false })) });
    deepStrictEqual([closed.step?.kind, closed.step?.recovery], ['commit', true]);
    // No gate: recovery as before, with nothing for an admission to compare.
    deepStrictEqual(P.decide(interrupted(), {}).step, { kind: 'commit', subtaskId: 'A', branch: 'feat/a', recovery: true });
  });
});

// ---------------------------------------------------------------------------

describe('the facts and the driver\'s record', () => {
  const setUp = () => {
    const mainRoot = mkdtempSync(join(tmpdir(), 'verify-gate-'));
    dirs.push(mainRoot);
    const journal = VJ.journalPath(mainRoot, ENG_A);
    const write = (entries) => { for (const e of entries) VJ.appendJournal(journal, e); };
    const facts = (v, over = {}) => VR.verifyFacts({
      view: v, mainRoot, treeOf: async () => TREE, offer: OFFER, baseOf: () => BASE, dirtyOf: () => true, contentOf: () => CONTENT, ...over,
    });
    return { mainRoot, journal, write, facts };
  };

  it('a child at a commit gets the suite fact; one at a verb gets none, unless the owner\'s forced commit names it', async () => {
    const t = setUp();
    t.write(batch());
    deepStrictEqual((await t.facts(one())).A.suite, { ok: true, batch_id: 'b1', why: null, dirty: true, tree: TREE, content: CONTENT, recovery: false, resumed: false });
    const atVerb = one({ next_step: { kind: 'verb', verb: 'refine', confidence: 'HIGH' } });
    deepStrictEqual(await t.facts(atVerb), {});
    strictEqual((await t.facts(atVerb, { forcedCommit: true })).A.suite.ok, true);
    strictEqual((await t.facts(atVerb, { forcedCommit: new Set(['A']) })).A.suite.ok, true);
    deepStrictEqual(await t.facts(atVerb, { forcedCommit: new Set(['B']) }), {});
    strictEqual((await t.facts(one({ next_step: DONE }))).A.suite.ok, true);
    strictEqual((await t.facts(one({ next_step: null, current_phase: 'phase-7-commit' }))).A.suite.ok, true);
  });

  it('another tree, another base, or a tree, a status or a content that cannot be read is no evidence, and fails closed', async () => {
    const t = setUp();
    t.write(batch());
    strictEqual((await t.facts(one(), { treeOf: async () => OTHER })).A.suite.ok, false);
    strictEqual((await t.facts(one(), { baseOf: () => '2'.repeat(40) })).A.suite.ok, false);
    // A base that cannot be read is not "no base", which a batch selected
    // against none would match.
    t.write(batch({ req: 'r0', id: 'b0', base: null }));
    strictEqual((await t.facts(one(), { baseOf: () => null })).A.suite.batch_id, 'b0');
    const noBase = (await t.facts(one(), { baseOf: async () => { throw new Error('x'); } })).A.suite;
    deepStrictEqual([noBase.ok, noBase.batch_id], [false, null]);
    match(noBase.why, /base cannot be read/);
    const unread = (await t.facts(one(), { treeOf: async () => { throw new Error('x'); }, dirtyOf: () => { throw new Error('x'); }, contentOf: () => { throw new Error('x'); } })).A.suite;
    deepStrictEqual([unread.ok, unread.dirty, unread.tree, unread.content, unread.recovery], [false, true, null, null, false]);
    match(unread.why, /tree cannot be read/);
  });

  it('no fact without the offer, without a suite kind, or with a suite kind that takes arguments', async () => {
    const t = setUp();
    t.write(batch());
    const noSuite = { ...OFFER, declaration: { ...DECL, kinds: { pass: DECL.kinds.pass } } };
    const slotted = VD.parseDeclaration(JSON.stringify({ schema: 'agentic-verify-checks-1.0', kinds: { 'test-suite': { argv: ['npm', 'test', '{f}'], slots: [{ name: 'f', type: 'id', repeat: 'one' }], timeout_s: 60, locks_itself: false, adds_on: [] } } }));
    for (const offer of [null, { offered: false, why: 'x', baseline: BASE }, noSuite, { ...OFFER, declaration: slotted }]) {
      strictEqual(VR.suiteArgvOf(offer), null);
      deepStrictEqual(await t.facts(one(), { offer }), {});
    }
    deepStrictEqual(VR.suiteArgvOf(OFFER), SUITE);
  });

  it('the driver records a commit it admits and a verb it resumes, and the next facts read both; any other step records nothing', async () => {
    const t = setUp();
    const at = '2026-11-10T00:02:00Z';
    const note = (step) => VR.noteGateStep({ mainRoot: t.mainRoot, workflowId: ENG_A, step, runId: RUN, seq: 7, at });
    strictEqual(note({ kind: 'verb', verb: 'refine' }), false);
    strictEqual(note({ kind: 'verb', verb: 'refine', resume: 'verify' }), false);
    strictEqual(note({ kind: 'commit', recovery: true }), false);
    // An interrupted commit taken up on the content of its admission: that
    // admission's line stands.
    strictEqual(note({ kind: 'commit', recovery: true, suite: { batch_id: null, content: CONTENT, tree: OTHER, admitted: true } }), false);
    strictEqual(note({ kind: 'dispatch' }), false);
    deepStrictEqual(VJ.readJournal(t.journal).entries, []);
    t.write(batch());
    // A verb resumed for the final verification: resumed on that tree, and on no other.
    const resume = P.decide(one(), { verify: gate(fact()) }).step;
    strictEqual(note(resume), true);
    strictEqual((await t.facts(one())).A.suite.resumed, true);
    strictEqual((await t.facts(one(), { treeOf: async () => OTHER })).A.suite.resumed, false);
    // A commit admitted: recovery holds on that content, and on no other.
    strictEqual((await t.facts(one())).A.suite.recovery, false);
    strictEqual(note(P.decide(one(), { verify: gate(HAS) }).step), true);
    strictEqual((await t.facts(one())).A.suite.recovery, true);
    strictEqual((await t.facts(one(), { contentOf: () => 'd'.repeat(64) })).A.suite.recovery, false);
    deepStrictEqual(VJ.readJournal(t.journal).entries.filter((e) => e.op !== 'start' && e.op !== 'end').map((e) => [e.op, e.run_id, e.seq]), [['final-resume', RUN, 7], ['commit', RUN, 7]]);
    // Only the moved HEAD is let by: the commit's own commit moved the tree
    // digest, and the content still says the lane is the one admitted.
    deepStrictEqual(Object.values((await t.facts(one(), { treeOf: async () => OTHER })).A.suite).slice(0, 2).concat((await t.facts(one(), { treeOf: async () => OTHER })).A.suite.recovery), [false, null, true]);
    // A tree that cannot be read now, another base, a base that cannot be
    // read, or another declaration than the commit was admitted with: none.
    strictEqual((await t.facts(one(), { treeOf: async () => { throw new Error('x'); } })).A.suite.recovery, false);
    strictEqual((await t.facts(one(), { baseOf: () => '2'.repeat(40) })).A.suite.recovery, false);
    const noBase = (await t.facts(one(), { baseOf: async () => { throw new Error('x'); } })).A.suite;
    deepStrictEqual([noBase.ok, noBase.recovery], [false, false]);
    match(noBase.why, /base cannot be read/);
    const other = VD.parseDeclaration(JSON.stringify({ schema: 'agentic-verify-checks-1.0', kinds: { 'test-suite': { argv: SUITE, slots: [], timeout_s: 61, locks_itself: false, adds_on: [] } } }));
    strictEqual((await t.facts(one(), { offer: { ...OFFER, declaration: other } })).A.suite.recovery, false);
    // A later commit admitted on another content replaces the earlier one.
    note({ kind: 'commit', suite: { batch_id: 'b9', content: 'd'.repeat(64), tree: OTHER } });
    strictEqual((await t.facts(one())).A.suite.recovery, false);
    // Nor does a line whose tree no batch of the journal passed on, though
    // the content is the lane's.
    note({ kind: 'commit', suite: { batch_id: 'b9', content: CONTENT, tree: OTHER } });
    strictEqual((await t.facts(one())).A.suite.recovery, false);
  });

  it('the status, the content and the base may be read off the loop: the facts wait for them, and the loop runs meanwhile', async () => {
    const t = setUp();
    t.write(batch());
    let turns = 0;
    const later = (v) => new Promise((done) => { setTimeout(() => done(v), 20); });
    const tick = setInterval(() => { turns += 1; }, 1);
    try {
      const f = (await t.facts(one(), { baseOf: () => later(BASE), dirtyOf: () => later(false), contentOf: () => later(CONTENT) })).A.suite;
      deepStrictEqual([f.ok, f.dirty, f.content], [true, false, CONTENT]);
      ok(turns > 0, 'the loop turned while the reads were out');
    } finally {
      clearInterval(tick);
    }
    // A read that fails off the loop fails closed, as one that throws does.
    const failed = (await t.facts(one(), { dirtyOf: () => Promise.reject(new Error('x')), contentOf: () => Promise.reject(new Error('x')) })).A.suite;
    deepStrictEqual([failed.dirty, failed.content, failed.recovery], [true, null, false]);
    // The task a run with lanes runs for them is the one function.
    const OL = await import(join(AP, 'offloop.mjs'));
    strictEqual(typeof OL.TASKS.gateRead, 'function');
    deepStrictEqual(Object.keys(VR.gateRead({ lane: t.mainRoot, baseline: BASE })), ['dirty', 'content', 'base']);
    deepStrictEqual(VR.gateRead({ lane: t.mainRoot, baseline: BASE }), { dirty: null, content: null, base: BASE }, 'no repository: nothing read, the base the baseline');
  });

  it('the lines are the driver\'s alone: the record\'s trust and the repeat rule read past them', () => {
    const entries = [...batch(), { v: 1, op: 'final-resume', payload: { tree: TREE } }, { v: 1, op: 'commit', batch_id: 'b1', payload: { content: CONTENT, tree: TREE } }];
    strictEqual(VJ.lastEnded(entries).batch_id, 'b1');
    ok(VJ.OPS.includes('commit') && VJ.OPS.includes('final-resume'));
  });

  it('a child of another lane keeps its own fact', async () => {
    const t = setUp();
    t.write(batch());
    const v = view({ A: child(ENG_A), B: child(ENG_B, { branch: 'feat/b', originating_subtask: 'B' }) });
    const f = await t.facts(v);
    deepStrictEqual([f.A.suite.ok, f.B.suite.ok], [true, false], 'B has no journal of its own');
  });
});

describe('the gate\'s status read of a lane', () => {
  const dirs = [];
  after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  // A repository whose index is stale against the file it tracks (the file's
  // time moved, its content did not): a status read with optional locks
  // refreshes the entry and writes the index, under index.lock.
  const stale = () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-status-'));
    dirs.push(dir);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
    const git = (...args) => {
      const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env });
      strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout;
    };
    git('init', '-q');
    // The repository's own settings, over whatever the machine's say: with
    // another of these a status read may write no index, and the control fails.
    for (const [k, v] of [['core.ignoreStat', 'false'], ['core.fsmonitor', 'false'], ['core.untrackedCache', 'false'], ['core.splitIndex', 'false']]) git('config', k, v);
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'a');
    utimesSync(join(dir, 'a.txt'), new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'));
    const index = () => createHash('sha256').update(readFileSync(join(dir, '.git', 'index'))).digest('hex');
    return { dir, git, index };
  };

  it('takes no optional lock: the index it reads is the index it leaves, whatever the driver inherited', () => {
    const t = stale();
    const before = t.index();
    const inherited = process.env.GIT_OPTIONAL_LOCKS;
    process.env.GIT_OPTIONAL_LOCKS = '1';
    try {
      strictEqual(VR.laneDirty(t.dir), false, 'the same content is no change');
      strictEqual(t.index(), before, 'the status read wrote the lane\'s index: a commit worker beside it meets index.lock');
      writeFileSync(join(t.dir, 'new.txt'), 'n\n');
      strictEqual(VR.laneDirty(t.dir), true, 'an untracked file is a change');
      strictEqual(t.index(), before);
      rmSync(join(t.dir, 'new.txt'));
    } finally {
      if (inherited === undefined) delete process.env.GIT_OPTIONAL_LOCKS; else process.env.GIT_OPTIONAL_LOCKS = inherited;
    }
    // The control: on this very index, a status read with optional locks does
    // write it, so the equality above is the read's doing, not the fixture's.
    t.git('status', '--porcelain', '--untracked-files=normal');
    ok(t.index() !== before, 'the fixture\'s index is not stale: the case above proves nothing');
  });
});
