// tests/orchestrator/test-autopilot-verify-forced.mjs
//
// C168 (ADR-0068 implementation note 2026-11-03) — the owner's forced
// verification step (`--next verify`, or `--lane <subtask> --next verify`) on
// a request below HIGH authorizes that request's checks and the resume of its
// requesting verb; it is bound to the workflow, the request id and the
// batches the driver's journal started for it, and a pass's on_pass keeps its
// own confidence.
//
// Covers, on the journal, the policy and the verification step (real persona
// CLI, real journal; the serial driver and the scheduler end to end are
// test-autopilot-verify-forced-driver.mjs):
//   - forcedAuthority: the forced batch and every batch continuing it; a
//     journal written before this release (no meta.forced) reads as unforced;
//     a restart ends it unless the owner's own rerun made it; another request,
//     another subtask, a batch the journal never started, a loop of
//     continuations: none;
//   - the policy, serial and with lanes: an unforced request below HIGH halts
//     low-confidence before anything runs; a forced one whose batch failed or
//     gave no evidence resumes the requesting verb, one whose batch is open,
//     cut short or passed unanswered takes the verification step; a
//     replacement request never inherits it; a resume fact alone is no
//     authorization; after a pass, the on_pass is judged on its own confidence;
//   - the step: the forced step's start is journalled forced; a step that is
//     not the owner's, on a request below HIGH no forced batch covers, runs
//     nothing; a forced batch that fails, or ends with no evidence, resumes
//     the verb on the next look; one that passes dispatches a HIGH on_pass and
//     halts on a MEDIUM one; an interruption before the batch starts leaves no
//     authorization; a batch a dead driver left open, and a batch cut short,
//     are ended and continued with no confidence halt, and a continuation cut
//     short in turn is still covered through it; a crash between the
//     journal's pass and the record's answers it on the next look; a changed
//     tree after the pass resumes the verb; a record set aside ends the
//     authorization and runs nothing.

import { after, describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ENGINEER_ROOT, RUN, S, VD, VJ, VR, cleanup, digestOf, jobFor, makeRepo, ran, readWorkflow, runStep, workflowWithRequest,
} from './_verify-fixtures.mjs';

const P = await import('../../plugins/orchestrator/adapters/claude/autopilot/policy.mjs');
const { verifySummary } = await import('../../plugins/orchestrator/adapters/claude/autopilot/observe.mjs');

const dirs = [];
after(() => cleanup(dirs));
const BOUNDED = { timeout: 90_000 };

// ---------------------------------------------------------------------------
// The journal

const start = (batch, { continues = null, forced = false, subtask = 'A', op = 'start', request = 'r1' } = {}) => ({
  v: 1, op, request_id: request, batch_id: batch, payload: { batch_id: batch, continues },
  meta: { verb: 'compose', subtask_id: subtask, ...(forced ? { forced: true } : {}) },
});
const authority = (entries, batchId, { requestId = 'r1', subtaskId = 'A' } = {}) => VJ.forcedAuthority(entries, { requestId, batchId, subtaskId });

describe('verify-forced: the authorization the journal holds', () => {
  it('names the forced batch, for it and for every batch continuing it through the journal\'s starts', () => {
    deepStrictEqual(authority([start('b1', { forced: true })], 'b1'), { request_id: 'r1', batch_id: 'b1' });
    deepStrictEqual(authority([start('b1', { forced: true }), start('b2', { continues: 'b1' })], 'b2'), { request_id: 'r1', batch_id: 'b1' });
    const entries = [start('b1', { forced: true }), start('b2', { continues: 'b1' }), start('b3', { continues: 'b2' })];
    deepStrictEqual(authority(entries, 'b3'), { request_id: 'r1', batch_id: 'b1' });
  });

  it('holds only from the last batch the journal started for the request: a record put back to an earlier batch revives nothing', () => {
    const entries = [start('b1', { forced: true }), start('b2', { continues: 'b1' }), start('b3', { continues: 'b2' })];
    for (const b of ['b1', 'b2']) strictEqual(authority(entries, b), null, b);
    // Another request's later start does not count against this one.
    deepStrictEqual(authority([start('b1', { forced: true }), start('x1', { request: 'r2' })], 'b1'), { request_id: 'r1', batch_id: 'b1' });
  });

  it('reads a journal written before this release, which marks no start forced, as unforced', () => {
    strictEqual(authority([start('b1'), start('b2', { continues: 'b1' })], 'b2'), null);
    strictEqual(authority([{ ...start('b1'), meta: { verb: 'compose', subtask_id: 'A', forced: 'true' } }], 'b1'), null, 'only the boolean');
  });

  it('ends at a restart, which continues nothing, unless the owner\'s own rerun made it', () => {
    // The restart's continues is set here, which no restart the driver writes
    // carries: the walk stops at the restart itself, not at a missing link.
    strictEqual(authority([start('b1', { forced: true }), start('b2', { op: 'restart', continues: 'b1' })], 'b2'), null, 'a record set aside');
    deepStrictEqual(authority([start('b1'), start('b2', { op: 'restart', forced: true })], 'b2'), { request_id: 'r1', batch_id: 'b2' });
  });

  it('is never another request\'s, another subtask\'s, a batch the journal did not start, or a loop', () => {
    const entries = [start('b1', { forced: true })];
    strictEqual(authority(entries, 'b1', { requestId: 'r2' }), null, 'a replacement request');
    strictEqual(authority(entries, 'b1', { subtaskId: 'B' }), null, 'another lane');
    strictEqual(authority(entries, 'bx'), null, 'a batch the journal never started');
    strictEqual(authority(entries, null), null, 'a record with no batch');
    strictEqual(authority([start('b1', { continues: 'b2' }), start('b2', { continues: 'b1' })], 'b1'), null, 'a loop of continuations');
    strictEqual(authority([start('b1', { forced: true, subtask: 'B' }), start('b2', { continues: 'b1' })], 'b2'), null, 'a hop of another subtask');
  });
});

// ---------------------------------------------------------------------------
// The policy

const MACRO = 'macro-plan-20261001T000000Z-abcdef';
const ENG = (id) => `compose-20261001T000100Z-${id.toLowerCase().repeat(6)}`;
const sub = (id, status = 'in_progress') => ({ id, label: id, verb: 'compose', profile: 'backend', branch: `feat/${id.toLowerCase()}`, blocked_by: [], status, engineer_workflow_id: ENG(id) });
function child(id, { next = { kind: 'verify', verb: null, confidence: 'MEDIUM' }, verify = { request_id: 'r1', answered_by: null, last_end: 'failed', last_batch: 'b1' } } = {}) {
  return {
    location: 'active', path: `/r/.agentic-plugins/state/engineer/workflows/${ENG(id)}.md`, relPath: `.agentic-plugins/state/engineer/workflows/${ENG(id)}.md`,
    workflow_id: ENG(id), verb: 'compose', branch: `feat/${id.toLowerCase()}`, current_phase: 'phase-2-presented', terminal_marker: false, next_step: next,
    awaiting_owner: null, workflow_type: 'verb-chain', parent_detached: false, pending_ensemble: 0, pending_runs: [], ensemble_results: 1, commit_manifest: 1,
    progress: 3, parent_workflow: MACRO, originating_subtask: id, verify,
  };
}
function view(children, branch = 'feat/a') {
  const subtasks = Object.keys(children).map((id) => sub(id));
  return {
    repoRoot: '/r', git: { branch, head: 'h0', porcelain: '', clean: true, detached: false },
    brief: { disposition: 'lead', leading: { command: '/orchestrator:resume' }, rows: [] }, briefError: null,
    macro: { id: MACRO, path: `/r/m/${MACRO}.md`, relPath: `m/${MACRO}.md`, archived: false, fm: { workflow_id: MACRO, current_phase: 'phase-2-presented', terminal_marker: false, git_baseline: { branch: 'main' }, plan: { subtasks }, host_history: [] } },
    macroLookupError: null, ready: { ready: null, reason: 'in_progress_or_blocked', readiness: [], approval: { status: 'approved', hash_ok: true } }, readyError: null,
    children, foreign: null, claims: Object.entries(children).map(([id, c]) => ({ id: c.workflow_id, path: c.path, relPath: c.relPath, originating_subtask: id, branch: c.branch })),
    claimsError: null, landing: {},
  };
}
const ctx = (facts = {}) => ({ runId: 'autopilot-20261001T000000Z-123456', macroId: MACRO, forced: null, finalizeAttempted: false, verify: { offered: true, facts } });
const FORCED = { forced: { request_id: 'r1', batch_id: 'b1' } };
const RESUME = { resume: { request_id: 'r1', batch_id: 'b1', end: 'failed', verb: 'compose' } };
const stepOf = (d) => (d.outcome === 'step' ? [d.step.kind, d.step.verb ?? null, d.step.resume ?? null] : [d.outcome, d.reason]);

describe('verify-forced: the policy (serial)', () => {
  it('an unforced request below HIGH halts low-confidence before anything runs, a resume fact included', () => {
    for (const facts of [{}, { A: RESUME }]) {
      const d = P.decide(view({ A: child('A') }), ctx(facts));
      deepStrictEqual(stepOf(d), ['halt', 'low-confidence'], JSON.stringify(facts));
      match(d.detail, /verify @ MEDIUM: the requested checks are not run below HIGH/);
    }
  });

  it('a forced request whose batch failed or gave no evidence resumes the requesting verb, at MEDIUM and at LOW', () => {
    for (const confidence of ['MEDIUM', 'LOW']) {
      const d = P.decide(view({ A: child('A', { next: { kind: 'verify', verb: null, confidence } }) }), ctx({ A: { ...FORCED, ...RESUME } }));
      deepStrictEqual(stepOf(d), ['verb', 'compose', 'verify'], confidence);
    }
  });

  it('a forced request whose batch is open, cut short or passed unanswered takes the verification step', () => {
    for (const last_end of [null, 'cut-short', 'passed']) {
      const d = P.decide(view({ A: child('A', { verify: { request_id: 'r1', answered_by: null, last_end, last_batch: 'b2' } }) }), ctx({ A: FORCED }));
      deepStrictEqual(stepOf(d), ['verify', null, null], String(last_end));
    }
  });

  it('a replacement request never inherits the authorization of the one it replaced', () => {
    const d = P.decide(view({ A: child('A', { verify: { request_id: 'r2', answered_by: null, last_end: null, last_batch: null } }) }), ctx({ A: { forced: { request_id: 'r1', batch_id: 'b1' } } }));
    deepStrictEqual(stepOf(d), ['halt', 'low-confidence']);
  });

  it('after a pass the on_pass is judged on its own confidence: HIGH is dispatched, MEDIUM halts', () => {
    const answered = { request_id: 'r1', answered_by: 'b1', last_end: 'passed', last_batch: 'b1' };
    const high = P.decide(view({ A: child('A', { next: { kind: 'commit', verb: null, confidence: 'HIGH' }, verify: answered }) }), ctx({}));
    deepStrictEqual(stepOf(high), ['commit', null, null]);
    const medium = P.decide(view({ A: child('A', { next: { kind: 'verb', verb: 'critique', confidence: 'MEDIUM' }, verify: answered }) }), ctx({ A: FORCED }));
    deepStrictEqual(stepOf(medium), ['halt', 'low-confidence']);
    match(medium.detail, /verb:critique @ MEDIUM/);
  });
});

describe('verify-forced: the policy (lanes)', () => {
  const lanesCtx = (facts) => ({ ...ctx(facts), inFlight: new Set(), parked: new Set(), lanes: new Map(), started: new Set(), forced: new Map() });

  it('the forced lane resumes its verb while an unforced lane below HIGH halts, each on its own lane', () => {
    const v = view({ A: child('A'), B: child('B', { verify: { request_id: 'r9', answered_by: null, last_end: null, last_batch: null } }) }, 'main');
    const d = P.decideLanes(v, lanesCtx({ A: { ...FORCED, ...RESUME } }));
    strictEqual(d.outcome, 'lanes', JSON.stringify(d));
    deepStrictEqual(d.laneSteps.map((s) => [s.subtaskId, s.kind, s.verb ?? null, s.resume ?? null]), [['A', 'verb', 'compose', 'verify']]);
    deepStrictEqual(d.laneHalts.map((h) => [h.subtaskId, h.reason]), [['B', 'low-confidence']]);
  });

  it('another lane\'s authorization is not this lane\'s', () => {
    const v = view({ A: child('A'), B: child('B') }, 'main');
    const d = P.decideLanes(v, lanesCtx({ B: { ...FORCED, ...RESUME } }));
    deepStrictEqual(d.laneHalts.map((h) => [h.subtaskId, h.reason]), [['A', 'low-confidence']]);
    deepStrictEqual(d.laneSteps.map((s) => [s.subtaskId, s.kind]), [['B', 'verb']]);
  });
});

// ---------------------------------------------------------------------------
// The step, on a real persona record and journal

async function setUp(checks, { confidence = 'MEDIUM', onPass = { kind: 'commit', confidence: 'HIGH' } } = {}) {
  const { dir, sha } = makeRepo();
  const logs = mkdtempSync(join(tmpdir(), 'verify-forced-log-'));
  dirs.push(dir, logs);
  const log = join(logs, 'order.log');
  const wf = await workflowWithRequest(dir, sha, checks, { onPass });
  // The request again, at the confidence under test (the fixture records HIGH).
  await S.finishVerb({
    workflowPath: wf, host: 'claude', nextAction: 'Verify the change', nextStep: { kind: 'verify', confidence },
    verifyRequest: { checks, on_pass: onPass, confidence }, env: { AGENTIC_AUTOPILOT: RUN, AGENTIC_AUTOPILOT_VERIFY: sha, AGENTIC_AUTOPILOT_STEP: '3' }, cwd: dir,
  });
  const job = (over = {}) => jobFor({ dir, sha, wf, log, subtaskId: 'A', ...over });
  return { dir, sha, wf, log, job };
}
const journalOf = (t) => VJ.readJournal(VJ.journalPath(t.dir, /([^/]+)\.md$/.exec(t.wf)[1])).entries;
async function childOf(t) {
  const fm = await readWorkflow(t.wf);
  return {
    ...child('A'), path: t.wf, workflow_id: fm.workflow_id, verb: fm.verb, branch: 'feat/a',
    next_step: fm.next_step_kind ? { kind: fm.next_step_kind, verb: fm.next_step_verb ?? null, confidence: fm.next_step_confidence ?? null } : null,
    verify: verifySummary(fm),
  };
}
// What the next look decides: the facts from the journal, then the policy.
async function nextLook(t) {
  const c = await childOf(t);
  const facts = await VR.verifyFacts({ view: { repoRoot: t.dir, children: { A: c } }, mainRoot: t.dir, treeOf: digestOf });
  return { facts, d: P.decide(view({ A: c }), ctx(facts)) };
}
// A batch the forced step started, journal and record, that a dead driver
// left: open, or (with `pass`) passed and ended, before its answer.
async function deadForcedBatch(t, { pass = false } = {}) {
  const fm = await readWorkflow(t.wf);
  const decl = t.job().offer.declaration;
  const checks = fm.verify_request.checks.map((c) => ({ kind: c.kind, origin: 'worker', argv: VD.resolveCheck(decl, c) }));
  const tree = await digestOf(t.dir);
  const id = fm.verify_request.id;
  const file = VJ.journalPath(t.dir, fm.workflow_id);
  const st = VJ.startPayload({ batchId: 'f1', runId: RUN, treeStart: tree, declarationCommit: t.sha, declarationDigest: decl.digest, checks, checksDigest: VD.checksDigest(checks.map((c) => c.argv)), startedAt: '2026-11-03T01:00:00Z' });
  VJ.appendJournal(file, { op: 'start', request_id: id, batch_id: 'f1', payload: st, meta: { verb: 'compose', base: t.sha, checks_digest: st.checks_digest, subtask_id: 'A', forced: true } });
  await S.recordBatchStart({ workflowPath: t.wf, host: 'claude', requestId: id, input: st });
  if (!pass) return;
  for (let i = 0; i < checks.length; i += 1) {
    const r = VJ.resultPayload({ index: i, outcome: 'passed', exit: 0, durationMs: 1, endedAt: '2026-11-03T01:00:01Z' });
    VJ.appendJournal(file, { op: 'result', request_id: id, batch_id: 'f1', index: i, payload: r });
    await S.recordResult({ workflowPath: t.wf, host: 'claude', requestId: id, batchId: 'f1', input: r });
  }
  const end = VJ.endPayload({ treeEnd: tree, end: 'passed', endedAt: '2026-11-03T01:00:02Z' });
  VJ.appendJournal(file, { op: 'end', request_id: id, batch_id: 'f1', payload: end });
  await S.recordBatchEnd({ workflowPath: t.wf, host: 'claude', requestId: id, batchId: 'f1', input: end });
  // The pass the driver journalled, then died before the persona's answer.
  VJ.appendJournal(file, { op: 'pass', request_id: id, batch_id: 'f1', payload: null });
}

describe('verify-forced: the verification step', () => {
  it('a step that is not the owner\'s, on a request below HIGH no forced batch covers, runs nothing and writes nothing', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }]);
    const r = await runStep(t.job());
    deepStrictEqual([r.outcome, r.halt?.reason, r.wrote], ['halt', 'low-confidence', false], JSON.stringify(r));
    match(r.halt.detail, /the owner's forced step did not start a batch of it; nothing ran/);
    deepStrictEqual(ran(t.log), []);
    deepStrictEqual(journalOf(t), []);
    deepStrictEqual(stepOf((await nextLook(t)).d), ['halt', 'low-confidence']);
  });

  it('a forced MEDIUM batch that fails is journalled forced, and the next look resumes the requesting verb with no confidence halt', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }, { kind: 'fail' }]);
    const r = await runStep(t.job({ forced: true, forcedRerun: true }));
    strictEqual(r.batch.end, 'failed');
    deepStrictEqual(ran(t.log), ['pass', 'fail']);
    const entries = journalOf(t);
    deepStrictEqual(entries.map((e) => e.op), ['start', 'result', 'result', 'end', 'resume']);
    deepStrictEqual([entries[0].meta.forced, entries[0].meta.subtask_id], [true, 'A']);
    const { facts, d } = await nextLook(t);
    deepStrictEqual(facts.A.forced, { request_id: entries[0].request_id, batch_id: r.batch.batch_id });
    deepStrictEqual(stepOf(d), ['verb', 'compose', 'verify']);
    // An unforced step on it resumes too, running nothing.
    const again = await runStep(t.job({ seq: 5 }));
    deepStrictEqual([again.outcome, again.follow], ['resume', { kind: 'verb', verb: 'compose' }]);
    deepStrictEqual(ran(t.log), ['pass', 'fail']);
  });

  it('a forced MEDIUM batch that ends with no evidence resumes the verb by the existing rule, with no confidence halt', BOUNDED, async () => {
    const t = await setUp([{ kind: 'hang' }]);
    const r = await runStep(t.job({ forced: true, forcedRerun: true }));
    deepStrictEqual([r.batch.end, r.batch.cause], ['no-evidence', 'timeout']);
    deepStrictEqual(stepOf((await nextLook(t)).d), ['verb', 'compose', 'verify']);
  });

  it('a forced MEDIUM batch that passes dispatches a HIGH on_pass, and halts on a MEDIUM one', BOUNDED, async () => {
    const high = await setUp([{ kind: 'pass' }], { onPass: { kind: 'verb', verb: 'critique', confidence: 'HIGH' } });
    strictEqual((await runStep(high.job({ forced: true, forcedRerun: true }))).batch.end, 'passed');
    deepStrictEqual(stepOf((await nextLook(high)).d), ['verb', 'critique', null]);
    const medium = await setUp([{ kind: 'pass' }], { onPass: { kind: 'verb', verb: 'critique', confidence: 'MEDIUM' } });
    strictEqual((await runStep(medium.job({ forced: true, forcedRerun: true }))).batch.end, 'passed');
    const { d } = await nextLook(medium);
    deepStrictEqual(stepOf(d), ['halt', 'low-confidence']);
    match(d.detail, /verb:critique @ MEDIUM/);
  });

  it('an interruption before the batch starts journals nothing, so the next look halts low-confidence again', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }]);
    const r = await runStep(t.job({ forced: true, forcedRerun: true }), { stopCause: () => 'drain' });
    deepStrictEqual([r.outcome, r.cause], ['stopped', 'drain'], JSON.stringify(r));
    deepStrictEqual(ran(t.log), []);
    deepStrictEqual(journalOf(t), []);
    const { facts, d } = await nextLook(t);
    deepStrictEqual(facts, {});
    deepStrictEqual(stepOf(d), ['halt', 'low-confidence']);
  });

  it('a forced batch a dead driver left open is ended and continued by the next, unforced step, and its pass dispatches on_pass', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }, { kind: 'pass2' }]);
    await deadForcedBatch(t);
    deepStrictEqual(stepOf((await nextLook(t)).d), ['verify', null, null], 'the open batch is the driver\'s to end, with no confidence halt');
    const r = await runStep(t.job({ seq: 5 }));
    deepStrictEqual([r.batch.continues, r.batch.end], ['f1', 'passed'], JSON.stringify(r));
    deepStrictEqual(ran(t.log), ['pass', 'pass2']);
    const cont = journalOf(t).find((e) => e.op === 'start' && e.batch_id === r.batch.batch_id);
    strictEqual(cont.meta.forced, undefined, 'the continuation is not the owner\'s step; the forced batch it continues covers it');
    deepStrictEqual(stepOf((await nextLook(t)).d), ['commit', null, null]);
  });

  it('a forced batch cut short between its checks is taken up by the next look with no confidence halt', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }, { kind: 'pass2' }]);
    // Stopped before its second check: a hold between checks.
    const r = await runStep(t.job({ forced: true, forcedRerun: true }), { stopCause: () => (ran(t.log).length > 0 ? 'hold' : null) });
    deepStrictEqual([r.batch.end, r.batch.cause], ['cut-short', 'hold'], JSON.stringify(r));
    deepStrictEqual(stepOf((await nextLook(t)).d), ['verify', null, null]);
    const c = await runStep(t.job({ seq: 5 }));
    deepStrictEqual([c.batch.continues, c.batch.end], [r.batch.batch_id, 'passed']);
    deepStrictEqual(ran(t.log), ['pass', 'pass2'], 'the continuation carried the pass and ran from the check that did not');
  });

  it('a continuation of a forced batch, cut short in turn, is still covered: the walk reaches the forced batch through it', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }, { kind: 'pass2' }, { kind: 'fail' }]);
    // The owner's batch is cut short after its first check, and the unforced
    // step that continues it after its second: the record's latest batch is
    // then a continuation, which no forced mark of its own covers.
    const r = await runStep(t.job({ forced: true, forcedRerun: true }), { stopCause: () => (ran(t.log).length > 0 ? 'hold' : null) });
    strictEqual(r.batch.end, 'cut-short', JSON.stringify(r));
    const c1 = await runStep(t.job({ seq: 5 }), { stopCause: () => (ran(t.log).length > 1 ? 'hold' : null) });
    deepStrictEqual([c1.batch.continues, c1.batch.end], [r.batch.batch_id, 'cut-short'], JSON.stringify(c1));
    const look = await nextLook(t);
    const requestId = (await readWorkflow(t.wf)).verify_request.id;
    deepStrictEqual(look.facts.A?.forced, { request_id: requestId, batch_id: r.batch.batch_id }, JSON.stringify(look.facts));
    deepStrictEqual(stepOf(look.d), ['verify', null, null], 'the continuation cut short is taken up with no confidence halt');
    // The next unforced step continues the continuation, and its failure
    // resumes the requesting verb: two hops back to the owner's batch.
    const c2 = await runStep(t.job({ seq: 6 }));
    deepStrictEqual([c2.batch.continues, c2.batch.end], [c1.batch.batch_id, 'failed'], JSON.stringify(c2));
    deepStrictEqual(ran(t.log), ['pass', 'pass2', 'fail'], 'each continuation ran from the check the one before it did not');
    deepStrictEqual(stepOf((await nextLook(t)).d), ['verb', 'compose', 'verify']);
  });

  it('a crash between the journal\'s pass and the record\'s answer: the next look answers it, and on_pass follows', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }], { onPass: { kind: 'verb', verb: 'critique', confidence: 'HIGH' } });
    await deadForcedBatch(t, { pass: true });
    const before = await readWorkflow(t.wf);
    deepStrictEqual([before.next_step_kind, before.next_step_confidence, before.verify_request.answered_by ?? null], ['verify', 'MEDIUM', null]);
    deepStrictEqual(stepOf((await nextLook(t)).d), ['verify', null, null]);
    const r = await runStep(t.job({ seq: 5 }));
    deepStrictEqual([r.outcome, r.follow], ['passed-before', { kind: 'on_pass' }]);
    deepStrictEqual(ran(t.log), []);
    deepStrictEqual(stepOf((await nextLook(t)).d), ['verb', 'critique', null]);
  });

  it('a tree changed after a forced pass, before its answer, resumes the verb with no confidence halt', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }]);
    await deadForcedBatch(t, { pass: true });
    writeFileSync(join(t.dir, 'changed-after.txt'), 'x');
    const r = await runStep(t.job({ seq: 5 }));
    deepStrictEqual([r.outcome, r.follow], ['resume', { kind: 'verb', verb: 'compose' }]);
    deepStrictEqual(stepOf((await nextLook(t)).d), ['verb', 'compose', 'verify']);
  });

  it('a record set aside ends the authorization: the unforced step runs nothing, and the owner\'s rerun restarts it', BOUNDED, async () => {
    const t = await setUp([{ kind: 'fail' }]);
    await runStep(t.job({ forced: true, forcedRerun: true }));
    // A result edited by hand after the batch: the record is no longer the
    // one the journal holds, so its resume line no longer applies.
    const text = readFileSync(t.wf, 'utf8');
    const line = /^verify_results: (".*")$/m.exec(text);
    const res = JSON.parse(JSON.parse(line[1]));
    res.batches[0].results[0] = { ...res.batches[0].results[0], failing_tests: ['an unrelated test'] };
    writeFileSync(t.wf, text.replace(line[0], `verify_results: ${JSON.stringify(JSON.stringify(res))}`));
    const { facts, d } = await nextLook(t);
    strictEqual(facts.A.resume, undefined);
    deepStrictEqual(stepOf(d), ['verify', null, null], 'the authorization names the batch; the step judges the record');
    const r = await runStep(t.job({ seq: 5 }));
    deepStrictEqual([r.outcome, r.halt?.reason, r.wrote], ['halt', 'low-confidence', false], JSON.stringify(r));
    match(r.halt.detail, /set aside .* ends the owner's authorization of it below HIGH; nothing ran/);
    deepStrictEqual(ran(t.log), ['fail']);
    const forced = await runStep(t.job({ seq: 6, forced: true, forcedRerun: true }));
    deepStrictEqual([forced.batch.restart, forced.batch.end], [true, 'failed']);
    ok(journalOf(t).some((e) => e.op === 'restart' && e.meta?.forced === true));
    deepStrictEqual(stepOf((await nextLook(t)).d), ['verb', 'compose', 'verify']);
  });

  it('a record put back to an earlier batch after its continuation passed and was answered revives no authorization', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }, { kind: 'pass2' }]);
    const r = await runStep(t.job({ forced: true, forcedRerun: true }), { stopCause: () => (ran(t.log).length > 0 ? 'hold' : null) });
    strictEqual(r.batch.end, 'cut-short');
    const snapshot = readFileSync(t.wf, 'utf8');
    const c = await runStep(t.job({ seq: 5 }));
    strictEqual(c.batch.end, 'passed');
    strictEqual((await readWorkflow(t.wf)).next_step_kind, 'commit', 'answered');
    writeFileSync(t.wf, snapshot);
    const { facts, d } = await nextLook(t);
    strictEqual(facts.A?.forced, undefined, JSON.stringify(facts));
    deepStrictEqual(stepOf(d), ['halt', 'low-confidence']);
    const again = await runStep(t.job({ seq: 6 }));
    deepStrictEqual([again.outcome, again.halt?.reason, again.wrote], ['halt', 'low-confidence', false], JSON.stringify(again));
    deepStrictEqual(ran(t.log), ['pass', 'pass2']);
  });

  // The persona CLI, wrapped: once the step's end of a dead driver's open
  // batch has landed, the record is edited as a worker could, before the step
  // reads it again.
  function editingPersona(mode) {
    const root = mkdtempSync(join(tmpdir(), 'verify-forced-persona-'));
    dirs.push(root);
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts/state.mjs'), `import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const args = process.argv.slice(2);
const r = spawnSync(process.execPath, [process.env.C168_REAL_STATE, ...args], { stdio: 'inherit' });
if (r.status === 0 && args[0] === 'verify-batch-end') {
  const wf = args[args.indexOf('--workflow-path') + 1];
  const text = fs.readFileSync(wf, 'utf8');
  const line = /^verify_results: (".*")$/m.exec(text);
  const res = JSON.parse(JSON.parse(line[1]));
  if (process.env.C168_EDIT === 'cause') res.batches[0].cause = 'hold';
  else res.batches = [];
  fs.writeFileSync(wf, text.replace(line[0], 'verify_results: ' + JSON.stringify(JSON.stringify(res))));
}
process.exit(r.status ?? 1);
`);
    return { engineerRoot: root, extraEnv: { C168_REAL_STATE: join(ENGINEER_ROOT, 'scripts/state.mjs'), C168_EDIT: mode } };
  }

  for (const [mode, what, re] of [
    ['cause', 'an edit that makes the record one the journal does not hold (a restart)', /set aside .* ends the owner's authorization of it below HIGH; nothing ran/],
    ['batches', 'an edit that empties its batches (a new batch)', /a new batch of a request below HIGH starts only on the owner's forced step; nothing ran/],
  ]) {
    it(`after a dead driver's open forced batch is ended, ${what} runs nothing on an unforced step`, BOUNDED, async () => {
      const t = await setUp([{ kind: 'pass' }, { kind: 'pass2' }]);
      await deadForcedBatch(t);
      const p = editingPersona(mode);
      const r = await runStep({ ...t.job({ seq: 5, extraEnv: p.extraEnv }), engineerRoot: p.engineerRoot });
      deepStrictEqual([r.outcome, r.halt?.reason], ['halt', 'low-confidence'], JSON.stringify(r));
      match(r.halt.detail, re);
      deepStrictEqual(ran(t.log), [], 'no check ran');
      ok(!journalOf(t).some((e) => e.op === 'restart' || (e.op === 'start' && e.batch_id !== 'f1')), 'no batch was journalled after the end');
    });
  }
});
