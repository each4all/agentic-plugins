// tests/orchestrator/test-autopilot-verify-refusal.mjs
//
// ADR-0068 Decision 5, items 10 and 11 — the orchestrator released beside the
// persona's `verify` names the kind and refuses it explicitly: this driver
// runs no verification step yet (verify-exec does).
//
// Covers:
//   - policy: a child whose next step is `verify` halts the run owner-choice,
//     naming what is missing, at any confidence, never routed to a commit; a
//     forced step does not get past it; with lanes the halt is run-wide
//     (scope 'run'), so a forced step of another lane is not admitted; an
//     owner gate and a pending peer of the child come first, as for any next
//     step, and the refusal comes before the recovery of a commit begun (or
//     not archived), which a verify child never reaches; a lane in flight is
//     left to its step;
//   - the fingerprint: a batch's recorded results move the lane child's
//     fingerprint, and a child with no request keeps the fingerprint it had;
//   - observe: the verify summary carries counts only, and only the
//     request's own results; read from a real child the persona wrote, it
//     reaches the view, the run halts on it, and a recorded result moves the
//     lane fingerprint;
//   - the worker environment scrubs a run's offer of verification, and numbers
//     the step (AGENTIC_AUTOPILOT_STEP, the driver's own sequence number);
//   - dead-run cleanup: a newer driver's batch lines are no step and no cost,
//     and no peer is taken for theirs (dead-runs' own suite holds the rest);
//   - no inherited AGENTIC_* variable reaches the fixtures, which write as the
//     owner: dropped at load (../persona-pipeline/_drop-session.mjs), checked
//     under a planted autopilot session.

import { runPlanted } from '../persona-pipeline/_drop-session.mjs';
import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const P = await import(join(AP, 'policy.mjs'));
const O = await import(join(AP, 'observe.mjs'));
const W = await import(join(AP, 'worker.mjs'));

const MACRO = 'macro-plan-20261001T000000Z-abcdef';
const ENG_A = 'compose-20261001T000100Z-aaaaaa';
const ENG_B = 'compose-20261001T000200Z-bbbbbb';
const approved = { status: 'approved', hash_ok: true };

const sub = (id, status, extra = {}) => ({ id, label: id, verb: 'compose', branch: `feat/${id.toLowerCase()}`, blocked_by: [], status, ...extra });
const child = (id, over = {}) => ({
  location: 'active', path: `/r/.agentic-plugins/state/engineer/workflows/${id}.md`, relPath: `.agentic-plugins/state/engineer/workflows/${id}.md`,
  workflow_id: id, branch: 'feat/a', current_phase: 'phase-2-presented', terminal_marker: false,
  next_step: { kind: 'verb', verb: 'critique', confidence: 'HIGH' }, awaiting_owner: null, workflow_type: 'verb-chain',
  parent_detached: false, pending_ensemble: 0, pending_runs: [], ensemble_results: 1, commit_manifest: 1, progress: 3,
  parent_workflow: MACRO, originating_subtask: 'A', ...over,
});
const verifyStep = (confidence = 'HIGH') => ({ kind: 'verify', verb: null, confidence });

function view({ subtasks, children, git = { branch: 'feat/a' } }) {
  return {
    repoRoot: '/r',
    git: { branch: 'main', head: 'h0', porcelain: '', clean: true, detached: false, ...git },
    brief: { disposition: 'lead', leading: { command: '/orchestrator:resume' }, rows: [] },
    briefError: null,
    macro: {
      id: MACRO, path: `/r/.agentic-plugins/state/orchestrator/workflows/${MACRO}.md`, relPath: `.agentic-plugins/state/orchestrator/workflows/${MACRO}.md`,
      archived: false,
      fm: { workflow_id: MACRO, current_phase: 'phase-2-presented', terminal_marker: false, plan_approval_status: 'approved', plan_approval_plan_hash: 'f'.repeat(64), git_baseline: { branch: 'main' }, plan: { subtasks }, host_history: [] },
    },
    macroLookupError: null,
    ready: { ready: null, reason: 'in_progress_or_blocked', readiness: [], approval: approved },
    readyError: null,
    children,
    foreign: null,
    claims: Object.entries(children).filter(([, c]) => c.location === 'active')
      .map(([id, c]) => ({ id: c.workflow_id, path: c.path, relPath: c.relPath, originating_subtask: id, branch: c.branch })),
    claimsError: null,
    landing: {},
  };
}

const serialA = (next) => view({
  subtasks: [sub('A', 'in_progress', { engineer_workflow_id: ENG_A }), sub('B', 'blocked', { blocked_by: ['A'] })],
  children: { A: child(ENG_A, { next_step: next }) },
});
const lanesAB = (nextA, nextB = { kind: 'verb', verb: 'refine', confidence: 'HIGH' }) => view({
  subtasks: [sub('A', 'in_progress', { engineer_workflow_id: ENG_A }), sub('B', 'in_progress', { engineer_workflow_id: ENG_B })],
  children: { A: child(ENG_A, { next_step: nextA }), B: child(ENG_B, { branch: 'feat/b', originating_subtask: 'B', next_step: nextB }) },
});

describe('the policy refuses a verify next step by name (ADR-0068 Decision 5, item 11)', () => {
  it('names verify among the next-step kinds, as the persona does', () => {
    ok(P.NEXT_STEP_KINDS.includes('verify'));
  });

  it('a serial run halts owner-choice naming the missing driver support, at any confidence, never a commit', () => {
    for (const confidence of ['HIGH', 'MEDIUM', 'LOW']) {
      const d = P.decide(serialA(verifyStep(confidence)), {});
      strictEqual(d.outcome, 'halt', JSON.stringify(d));
      strictEqual(d.reason, 'owner-choice');
      match(d.detail, /subtask A: its next step is verify @ (HIGH|MEDIUM|LOW).*this driver does not run a verification step \(ADR-0068 Decision 5, item 11; verify-exec\)/);
      strictEqual(d.subtaskId, 'A');
      strictEqual(d.pointer, `.agentic-plugins/state/engineer/workflows/${ENG_A}.md#next_step`);
    }
    // Control: the same child with a commit next step steps to the commit.
    strictEqual(P.decide(serialA({ kind: 'commit', verb: null, confidence: 'HIGH' }), {}).step?.kind, 'commit');
  });

  it('the owner\'s forced step does not get past it', () => {
    for (const forced of [{ kind: 'commit' }, { kind: 'verb', verb: 'refine' }]) {
      const d = P.decide(serialA(verifyStep()), { forced });
      strictEqual(d.outcome, 'halt', JSON.stringify(forced));
      match(d.detail, /its next step is verify/);
    }
  });

  it('with lanes the halt is run-wide: no lane steps, a forced step of another lane included', () => {
    const forced = P.forcedForLanes([{ lane: 'B', step: { kind: 'verb', verb: 'refine' } }], lanesAB(verifyStep()));
    ok(forced.forced, JSON.stringify(forced));
    const d = P.decideLanes(lanesAB(verifyStep()), { forced: forced.forced, started: new Set(['A', 'B']), lanes: new Map() });
    strictEqual(d.outcome, 'halt', JSON.stringify(d));
    match(d.detail, /subtask A: its next step is verify/);
    ok(!('laneSteps' in d), 'a run-wide halt starts nothing');
    // Control: with A's next step a verb, both lanes step, the forced one first.
    const c = P.decideLanes(lanesAB({ kind: 'verb', verb: 'critique', confidence: 'HIGH' }), { forced: forced.forced, started: new Set(['A', 'B']), lanes: new Map() });
    deepStrictEqual(c.laneSteps.map((s) => [s.subtaskId, s.forced === true]), [['B', true], ['A', false]]);
  });

  it('the halt is marked the run\'s', () => {
    strictEqual(P.decide(serialA(verifyStep()), {}).scope, 'run');
    strictEqual(P.decideLanes(lanesAB(verifyStep()), { started: new Set(['A', 'B']), lanes: new Map() }).scope, 'run');
  });

  it('it comes after what a child needs whatever its next step: an owner gate, a pending peer', () => {
    const gated = (next, over) => view({
      subtasks: [sub('A', 'in_progress', { engineer_workflow_id: ENG_A }), sub('B', 'blocked', { blocked_by: ['A'] })],
      children: { A: child(ENG_A, { next_step: next, ...over }) },
    });
    const states = [
      [{ awaiting_owner: { gate: 'peer-conflict', pointer: 'p#recurring' } }, (d) => deepStrictEqual([d.outcome, d.reason], ['halt', 'awaiting-owner:peer-conflict'])],
      [{ pending_ensemble: 1, pending_runs: ['r1'] }, (d) => match(d.detail, /a peer ensemble is still pending \(r1\)/)],
    ];
    for (const [over, check] of states) {
      const d = P.decide(gated(verifyStep(), over), {});
      check(d);
      ok(!String(d.detail ?? '').includes('its next step is verify'), JSON.stringify(d));
      // With lanes, the child's own state is its lane's, not the run's.
      const l = P.decideLanes(view({
        subtasks: [sub('A', 'in_progress', { engineer_workflow_id: ENG_A }), sub('B', 'in_progress', { engineer_workflow_id: ENG_B })],
        children: { A: child(ENG_A, { next_step: verifyStep(), ...over }), B: child(ENG_B, { branch: 'feat/b', originating_subtask: 'B', next_step: { kind: 'verb', verb: 'refine', confidence: 'HIGH' } }) },
      }), { started: new Set(['A', 'B']), lanes: new Map() });
      strictEqual(l.outcome, 'lanes', JSON.stringify(over));
      ok(!JSON.stringify(l).includes('its next step is verify'), JSON.stringify(over));
    }
  });

  it('it comes before the commit recovery: a commit begun, or one whose archive did not run, beside a pending request is refused, never committed', () => {
    const states = [{ current_phase: 'phase-7-commit' }, { current_phase: 'commit-complete', terminal_marker: true }];
    for (const over of states) {
      const serial = view({
        subtasks: [sub('A', 'in_progress', { engineer_workflow_id: ENG_A }), sub('B', 'blocked', { blocked_by: ['A'] })],
        children: { A: child(ENG_A, { next_step: verifyStep(), ...over }) },
      });
      const d = P.decide(serial, {});
      deepStrictEqual([d.outcome, d.reason, d.scope], ['halt', 'owner-choice', 'run'], JSON.stringify(over));
      match(d.detail, /subtask A: its next step is verify @ HIGH/);
      ok(d.step === undefined, `${JSON.stringify(over)}: no recovery commit`);
      const l = P.decideLanes(view({
        subtasks: [sub('A', 'in_progress', { engineer_workflow_id: ENG_A }), sub('B', 'in_progress', { engineer_workflow_id: ENG_B })],
        children: { A: child(ENG_A, { next_step: verifyStep(), ...over }), B: child(ENG_B, { branch: 'feat/b', originating_subtask: 'B', next_step: { kind: 'verb', verb: 'refine', confidence: 'HIGH' } }) },
      }), { started: new Set(['A', 'B']), lanes: new Map() });
      deepStrictEqual([l.outcome, l.scope], ['halt', 'run'], JSON.stringify(over));
      ok(!('laneSteps' in l), `${JSON.stringify(over)}: a run-wide halt starts nothing`);
      // Control: the same state with a verb's next step recovers the commit.
      const c = P.decide(view({
        subtasks: [sub('A', 'in_progress', { engineer_workflow_id: ENG_A }), sub('B', 'blocked', { blocked_by: ['A'] })],
        children: { A: child(ENG_A, { next_step: { kind: 'verb', verb: 'refine', confidence: 'HIGH' }, ...over }) },
      }), {});
      deepStrictEqual([c.outcome, c.step?.kind, c.step?.recovery], ['step', 'commit', true], JSON.stringify(over));
    }
  });

  it('a lane in flight is left to its step', () => {
    const d = P.decideLanes(lanesAB(verifyStep()), { inFlight: new Set(['A']), started: new Set(['A', 'B']), lanes: new Map() });
    strictEqual(d.outcome, 'lanes');
    deepStrictEqual(d.laneSteps.map((s) => s.subtaskId), ['B']);
  });

  it('a step report may name verify, and the report schema lists it', () => {
    strictEqual(P.stepReportProblem({ outcome: 'completed', workflow: ENG_A, next_step: verifyStep(), awaiting_owner: null, summary: 's', waiting_on_background: false }), null);
  });
});

describe('a batch\'s results are a change of the lane child (Decision 5, item 10)', () => {
  const lane = (verify) => view({
    subtasks: [sub('A', 'in_progress', { engineer_workflow_id: ENG_A })],
    children: { A: child(ENG_A, { next_step: verifyStep(), ...(verify === undefined ? {} : { verify }) }) },
    git: { branch: 'feat/a', head: 'a1' },
  });
  const summary = (over = {}) => ({ request_id: '0123456789abcdef', answered_by: null, batches: 1, results: 1, last_end: null, ...over });

  it('recording a result, an end or the answer moves the lane fingerprint, progress held fixed', () => {
    const base = P.laneFingerprint(lane(summary()), 'A');
    for (const over of [{ results: 2 }, { last_end: 'passed' }, { answered_by: 'b1' }, { batches: 2 }, { request_id: 'fedcba9876543210' }]) {
      ok(P.laneFingerprint(lane(summary(over)), 'A') !== base, JSON.stringify(over));
    }
    ok(P.fingerprint(lane(summary({ results: 2 }))) !== P.fingerprint(lane(summary())), 'the run-wide fingerprint too');
  });

  it('a child with no request keeps the fingerprint it had before the field existed', () => {
    const v = lane(undefined);
    const c = v.children.A;
    const old = createHash('sha256').update(JSON.stringify({
      git: ['feat/a', 'a1', ''],
      subtask: ['A', 'in_progress', ENG_A, null, null, null],
      child: ['A', c.location, c.workflow_id, c.current_phase, false, ['verify', null, 'HIGH'], null, 0, 1, 1, 3],
    })).digest('hex');
    strictEqual(P.laneFingerprint(v, 'A'), old);
    strictEqual(P.laneFingerprint(lane(null), 'A'), old, 'observe reports null for a child with no request');
  });
});

describe('observe: the verify summary', () => {
  const request = { id: '0123456789abcdef', answered_by: 'b2' };
  const batch = (id, results, end) => ({ batch_id: id, results: Array.from({ length: results }, (_, i) => ({ index: i, failing_tests: ['secret > name'], log: 'l' })), ...(end ? { end } : {}) });

  it('counts batches and results of the request\'s own results, never a name or a log', () => {
    const s = O.verifySummary({ verify_request: request, verify_results: { request_id: request.id, batches: [batch('b1', 2, 'cut-short'), batch('b2', 3, 'passed')] } });
    deepStrictEqual(s, { request_id: request.id, answered_by: 'b2', batches: 2, results: 5, last_end: 'passed' });
    ok(!JSON.stringify(s).includes('secret'));
  });

  it('null with no request; results of another request count for nothing', () => {
    strictEqual(O.verifySummary({}), null);
    strictEqual(O.verifySummary({ verify_request: 'carried text' }), null);
    deepStrictEqual(O.verifySummary({ verify_request: { id: request.id }, verify_results: { request_id: 'ffffffffffffffff', batches: [batch('b1', 2, 'passed')] } }),
      { request_id: request.id, answered_by: null, batches: 0, results: 0, last_end: null });
  });
});

describe('observe reads a real child\'s request and results into the view (Decision 5, item 10)', () => {
  it('the summary reaches the child, the run halts on it, and each recorded result moves the lane fingerprint', async () => {
    const { makeRepo } = await import('./fixtures/autopilot-repo.mjs');
    const V = await import(join(REPO_ROOT, 'plugins/engineer/scripts/lib/verify.mjs'));
    const fx = await makeRepo();
    fx.env.HOME = join(fx.dir, 'home');
    mkdirSync(fx.env.HOME);
    try {
      const look = () => O.observe({ repoRoot: fx.work, roots: fx.roots, fetch: false, env: fx.env });
      const c = await fx.dispatch('A');
      const text = readFileSync(join(REPO_ROOT, '.agentic-plugins/verify-checks.json'), 'utf8');
      mkdirSync(join(fx.work, '.agentic-plugins'), { recursive: true });
      writeFileSync(join(fx.work, '.agentic-plugins/verify-checks.json'), text);
      fx.git('add', '.agentic-plugins/verify-checks.json');
      fx.git('commit', '-q', '-m', 'chore: declare checks');
      const sha = fx.git('rev-parse', 'HEAD');
      const run = 'autopilot-20261001T000000Z-abcdef';
      await fx.eng.finishVerb({
        workflowPath: c.path, host: 'claude', nextAction: 'Verify',
        nextStep: { kind: 'verify', confidence: 'HIGH' },
        verifyRequest: { checks: [{ kind: 'lint-plugin-shape' }], on_pass: { kind: 'commit', confidence: 'HIGH' }, confidence: 'HIGH' },
        env: { AGENTIC_AUTOPILOT: run, AGENTIC_AUTOPILOT_VERIFY: sha, AGENTIC_AUTOPILOT_STEP: '2' }, cwd: fx.work,
      });
      const requestId = (await fx.eng.readWorkflow(c.path)).frontmatter.verify_request.id;
      let v = look();
      deepStrictEqual(v.children.A.verify, { request_id: requestId, answered_by: null, batches: 0, results: 0, last_end: null });
      const d = P.decide(v, { runId: run });
      deepStrictEqual([d.outcome, d.reason], ['halt', 'owner-choice']);
      match(d.detail, /subtask A: its next step is verify @ HIGH/);

      const argv = ['npm', 'run', 'lint:plugin-shape'];
      await fx.eng.recordBatchStart({
        workflowPath: c.path, host: 'claude', requestId,
        input: {
          batch_id: 'b1', run_id: run, continues: null, tree_start: 'a'.repeat(64), declaration_commit: sha,
          declaration_digest: V.parseDeclaration(text).digest, checks: [{ index: 0, kind: 'lint-plugin-shape', origin: 'worker', argv }],
          checks_digest: V.checksDigest([argv]), started_at: '2026-10-01T00:10:00Z',
        },
      });
      v = look();
      const started = P.laneFingerprint(v, 'A');
      deepStrictEqual([v.children.A.verify.batches, v.children.A.verify.results], [1, 0]);
      await fx.eng.recordResult({
        workflowPath: c.path, host: 'claude', requestId, batchId: 'b1',
        input: { index: 0, outcome: 'passed', exit: 0, signal: null, duration_ms: 9, failing_tests: [], failing_tests_more: 0, log: null, ended_at: '2026-10-01T00:11:00Z' },
      });
      v = look();
      strictEqual(v.children.A.verify.results, 1);
      ok(P.laneFingerprint(v, 'A') !== started, 'a recorded result is a change of the lane child');
    } finally {
      fx.cleanup();
    }
  });
});

describe('the worker environment scrubs a run\'s offer of verification, and numbers the step', () => {
  it('an inherited AGENTIC_AUTOPILOT_VERIFY and AGENTIC_AUTOPILOT_STEP never reach a worker of this driver', () => {
    const env = W.workerEnv({ AGENTIC_AUTOPILOT_VERIFY: 'a'.repeat(40), AGENTIC_AUTOPILOT_STEP: '3', KEEP_ME: 'yes' },
      { runId: 'autopilot-20261001T000000Z-123456', roots: { orchestrator: '/o', engineer: '/e', runtime: '/r' } });
    ok(!('AGENTIC_AUTOPILOT_VERIFY' in env));
    ok(!('AGENTIC_AUTOPILOT_STEP' in env));
    strictEqual(env.KEEP_ME, 'yes');
  });

  it('each step gets its own number, the driver\'s sequence number, and still no offer (ADR-0068 Decision 5, item 7)', () => {
    const env = W.workerEnv({ AGENTIC_AUTOPILOT_VERIFY: 'a'.repeat(40), AGENTIC_AUTOPILOT_STEP: '3' },
      { runId: 'autopilot-20261001T000000Z-123456', roots: { orchestrator: '/o', engineer: '/e', runtime: '/r' }, seq: 12 });
    strictEqual(env.AGENTIC_AUTOPILOT_STEP, '12', 'the driver\'s number replaces an inherited one');
    ok(!('AGENTIC_AUTOPILOT_VERIFY' in env), 'a numbered step is not offered verification');
    // startWorker hands its step's seq on: test-autopilot-worker.mjs reads it
    // in the spawned worker's environment.
  });
});

describe('the fixtures write as the owner: no inherited AGENTIC_* variable reaches them', () => {
  it('under a planted autopilot session the real-child probe passes, and fails without the drop (control)', () => {
    const file = fileURLToPath(import.meta.url);
    const probe = 'the summary reaches the child, the run halts on it';
    const planted = runPlanted(file, probe);
    strictEqual(planted.status, 0, planted.out);
    deepStrictEqual([planted.pass, planted.fail], [1, 0], planted.out);
    const control = runPlanted(file, probe, { control: true });
    strictEqual(control.status, 1, control.out);
    deepStrictEqual([control.pass, control.fail], [0, 1], control.out);
  });
});
