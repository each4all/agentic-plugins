// tests/orchestrator/test-autopilot-consensus.mjs
//
// ADR-0067 Decision 8, items 1 and 5 — the consensus proposal a conflict halt
// carries (plugins/orchestrator/adapters/claude/autopilot/policy.mjs): built
// from closed parts only, naming the subtask and gate it is for, and only
// while the task file is current; display only. Then, with no model (the fake
// `claude` and the scripted worker, fixtures/autopilot-lanes-run.mjs): a run
// with lanes reports every lane's proposal once, a lane that met its gate
// while the run drained included, and judges each again as it ends; and the
// preview's JSON and text carry the proposals, serial and with lanes. The
// serial driver's halt record and text are in test-autopilot-driver.mjs; the
// observer's facts, from real records, in test-autopilot-observe.mjs.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRepo, ORCH, ENG, RUNTIME } from './fixtures/autopilot-repo.mjs';
import { AP, bySubtask, COMMIT, markOn, setup, stepsOf } from './fixtures/autopilot-lanes-run.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const P = await import(resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/policy.mjs'));
const { decide, decideLanes, consensusProposals, proposalLines, proposalsAtEnd, ENGINEER_OWNER_GATES } = P;
const C = await import(resolve(AP, 'cli.mjs'));
const FAKE = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-fake-claude.mjs');

const MACRO = 'macro-plan-20261001T000000Z-abcdef';
const RUN = 'autopilot-20261001T000000Z-123456';
const ENG_A = 'critique-20261001T000100Z-aaaaaa';
// The run id the scripted worker's conflict-gate action records.
const PEER_RUN = 'review-20261001T000000Z-c0ffee';
const PLAN_RUN = 'macro-plan-20261001T000000Z-0ff1ce';
const ENG_HOME = '/r/.agentic-plugins/state/engineer';
const ORCH_HOME = '/r/.agentic-plugins/state/orchestrator';

const facts = (home, id, runId, over = {}) => ({
  run_id: runId,
  conflict_runs: [runId],
  task: { path: `${home}/consensus/${id}.${runId}.md`, relPath: `${home.slice('/r/'.length)}/consensus/${id}.${runId}.md`, exists: true },
  ...over,
});

const sub = (id, status, extra = {}) => ({ id, label: id, verb: 'critique', branch: `feat/${id.toLowerCase()}`, blocked_by: [], status, ...extra });

function child(over = {}) {
  return {
    location: 'active', path: `${ENG_HOME}/workflows/${ENG_A}.md`, relPath: `.agentic-plugins/state/engineer/workflows/${ENG_A}.md`,
    workflow_id: ENG_A, branch: 'feat/a', current_phase: 'phase-2-presented', terminal_marker: false,
    next_step: { kind: 'owner-decision', verb: null, confidence: 'HIGH' },
    awaiting_owner: { gate: 'peer-conflict', pointer: `.agentic-plugins/state/engineer/workflows/${ENG_A}.md#ensemble-synthesis`, since: '2026-10-01T00:00:00Z' },
    consensus: facts(ENG_HOME, ENG_A, PEER_RUN),
    workflow_type: 'verb-chain', parent_detached: false, pending_ensemble: 0, pending_runs: [], ensemble_results: 1,
    commit_manifest: 0, progress: 3, parent_workflow: MACRO, originating_subtask: 'A',
    ...over,
  };
}

function view({ childOver = {}, fm = {}, approval = { status: 'approved', hash_ok: true }, macroConsensus = null, subtasks } = {}) {
  const plan = subtasks ?? [sub('A', 'in_progress', { engineer_workflow_id: ENG_A }), sub('B', 'blocked', { blocked_by: ['A'] })];
  const c = child(childOver);
  return {
    repoRoot: '/r',
    git: { branch: 'feat/a', head: 'h0', porcelain: '', clean: true, detached: false },
    brief: { disposition: 'lead', leading: { command: '/engineer:resume' }, rows: [] }, briefError: null,
    macro: {
      id: MACRO, path: `${ORCH_HOME}/workflows/${MACRO}.md`, relPath: `.agentic-plugins/state/orchestrator/workflows/${MACRO}.md`, archived: false,
      fm: {
        workflow_id: MACRO, current_phase: 'phase-2-presented', terminal_marker: false,
        plan_approval_status: 'approved', plan_approval_plan_hash: 'f'.repeat(64),
        git_baseline: { branch: 'main' }, plan: { subtasks: plan }, host_history: [], ...fm,
      },
      consensus: macroConsensus,
    },
    macroLookupError: null,
    ready: { ready: null, reason: 'in_progress_or_blocked', readiness: [], approval },
    readyError: null,
    children: subtasks ? {} : { A: c },
    foreign: null,
    claims: subtasks ? [] : [{ id: ENG_A, path: c.path, relPath: c.relPath, originating_subtask: 'A', branch: 'feat/a' }],
    claimsError: null,
    landing: {},
  };
}
const ctx = { runId: RUN, macroId: MACRO, forced: null, finalizeAttempted: false };
const round = (path) => `/runtime:consensus plan --task-file ${path} --peers claude,codex --max-rounds 2`;
const line = (p) => `  proposed for ${p.subtask_id ? `subtask ${p.subtask_id}` : 'the macro'} (${p.gate}), for the owner to run before deciding: a bounded consensus round, ${p.command}`;

describe('the consensus proposal on a conflict halt (ADR-0067 Decision 8)', () => {
  it('peer-conflict is an engineer gate the driver reads', () => {
    strictEqual(ENGINEER_OWNER_GATES.includes('peer-conflict'), true);
  });

  for (const gate of ['peer-conflict', 'decide-conflict']) {
    it(`a child on ${gate} with a current task file: the halt carries the bounded round, with its absolute path and its pointer`, () => {
      const d = decide(view({ childOver: { awaiting_owner: { gate, pointer: 'p#ensemble-synthesis', since: '2026-10-01T00:00:00Z' } } }), ctx);
      strictEqual(d.reason, `awaiting-owner:${gate}`);
      deepStrictEqual(d.proposals, [{
        kind: 'consensus',
        command: round(`${ENG_HOME}/consensus/${ENG_A}.${PEER_RUN}.md`),
        pointer: `.agentic-plugins/state/engineer/consensus/${ENG_A}.${PEER_RUN}.md`,
        subtask_id: 'A',
        gate,
      }]);
    });
  }

  it('no proposal unless the task file is current, and none for another gate', () => {
    const cases = {
      'no run id': { consensus: facts(ENG_HOME, ENG_A, PEER_RUN, { run_id: null }) },
      'the run is not recorded as a conflict': { consensus: facts(ENG_HOME, ENG_A, PEER_RUN, { conflict_runs: ['review-other'] }) },
      'no task file': { consensus: facts(ENG_HOME, ENG_A, PEER_RUN, { task: { path: `${ENG_HOME}/consensus/${ENG_A}.${PEER_RUN}.md`, relPath: 'x', exists: false } }) },
      'a task file outside an engineer home': { consensus: facts('/r/elsewhere', ENG_A, PEER_RUN) },
      'a task file of another workflow': { consensus: facts(ENG_HOME, 'critique-20261001T000100Z-bbbbbb', PEER_RUN) },
      'a run id outside the alphabet': { consensus: facts(ENG_HOME, ENG_A, 'r.resolved') },
      'no facts at all': { consensus: undefined },
      'scope-routing': { awaiting_owner: { gate: 'scope-routing', pointer: 'p#routing-recommendation', since: '2026-10-01T00:00:00Z' } },
      'recurring-finding': { awaiting_owner: { gate: 'recurring-finding', pointer: 'p#recurring-finding', since: '2026-10-01T00:00:00Z' } },
    };
    for (const [why, childOver] of Object.entries(cases)) {
      const d = decide(view({ childOver }), ctx);
      strictEqual(d.outcome, 'halt', why);
      strictEqual(d.proposals, undefined, `${why}: no proposal`);
    }
  });

  it('a path that needs quoting is one shell word', () => {
    const home = '/r r/.agentic-plugins/state/engineer';
    const d = decide(view({ childOver: { consensus: facts(home, ENG_A, PEER_RUN) } }), ctx);
    strictEqual(d.proposals[0].command, round(`'${home}/consensus/${ENG_A}.${PEER_RUN}.md'`));
  });

  it('the macro on plan-conflict halts plan-unapproved with the round; plan-approval and an approved plan carry none', () => {
    const pending = { plan_approval_status: 'pending', plan_approval_plan_hash: undefined, awaiting_owner_gate: 'plan-conflict', awaiting_owner_pointer: `.agentic-plugins/state/orchestrator/workflows/${MACRO}.md#ensemble-synthesis` };
    const subtasks = [sub('A', 'pending')];
    const conflict = decide(view({ subtasks, fm: pending, approval: { status: 'pending', hash_ok: false }, macroConsensus: facts(ORCH_HOME, MACRO, PLAN_RUN) }), ctx);
    strictEqual(conflict.reason, 'plan-unapproved');
    deepStrictEqual(conflict.proposals, [{
      kind: 'consensus',
      command: round(`${ORCH_HOME}/consensus/${MACRO}.${PLAN_RUN}.md`),
      pointer: `.agentic-plugins/state/orchestrator/consensus/${MACRO}.${PLAN_RUN}.md`,
      subtask_id: null,
      gate: 'plan-conflict',
    }]);
    const approval = decide(view({ subtasks, fm: { ...pending, awaiting_owner_gate: 'plan-approval' }, approval: { status: 'pending', hash_ok: false }, macroConsensus: facts(ORCH_HOME, MACRO, PLAN_RUN) }), ctx);
    strictEqual(approval.reason, 'plan-unapproved');
    strictEqual(approval.proposals, undefined, 'plan-approval proposes no consensus round');
    const engineerHome = decide(view({ subtasks, fm: pending, approval: { status: 'pending', hash_ok: false }, macroConsensus: facts(ENG_HOME, MACRO, PLAN_RUN) }), ctx);
    strictEqual(engineerHome.proposals, undefined, 'the macro\'s task file is an orchestrator one');
  });

  it('with lanes, the lane halt on the gate carries the round', () => {
    const d = decideLanes(view(), { lanes: new Map(), started: new Set(), inFlight: new Set(), forced: new Map() });
    strictEqual(d.outcome, 'lanes');
    const h = d.laneHalts.find((x) => x.subtaskId === 'A');
    strictEqual(h.reason, 'awaiting-owner:peer-conflict');
    strictEqual(h.proposals[0].command, round(`${ENG_HOME}/consensus/${ENG_A}.${PEER_RUN}.md`));
  });

  it('consensusProposals reads only halts; proposalLines words the proposal for the owner, naming its subtask or the macro, and its gate', () => {
    // The same facts on a halt and on a step: only the halt proposes.
    const onGate = { reason: 'awaiting-owner:peer-conflict', subtaskId: 'A' };
    strictEqual(consensusProposals(view(), { outcome: 'halt', ...onGate }).length, 1, 'control: the halt proposes the round');
    deepStrictEqual(consensusProposals(view(), { outcome: 'step', ...onGate }), []);
    const [p] = decide(view(), ctx).proposals;
    deepStrictEqual(proposalLines([p]), [
      `  proposed for subtask A (peer-conflict), for the owner to run before deciding: a bounded consensus round, ${p.command}`,
      `    pointer: ${p.pointer}`,
    ]);
    deepStrictEqual(proposalLines([{ ...p, subtask_id: null, gate: 'plan-conflict' }])[0],
      `  proposed for the macro (plan-conflict), for the owner to run before deciding: a bounded consensus round, ${p.command}`);
    deepStrictEqual(proposalLines(undefined), []);
  });

  it('proposalsAtEnd judges every proposal a run met again as it ends, whether it halts or completes, from one look taken only when one is held', async () => {
    const [p] = decide(view(), ctx).proposals;
    // The owner cleared A's gate while the run went on.
    const cleared = view({ childOver: { awaiting_owner: null, next_step: { kind: 'commit', verb: null, confidence: 'HIGH' } } });
    let looks = 0;
    const at = (v) => () => { looks += 1; return v; };
    // A run that completes has no halt: its lanes' proposals are judged all the same.
    const gone = [{ subtask_id: 'A', proposals: [p] }];
    strictEqual(await proposalsAtEnd(at(cleared), null, gone), null);
    deepStrictEqual(gone[0].proposals, [], 'a gate cleared before the run completed proposes nothing');
    const kept = [{ subtask_id: 'A', proposals: [p] }];
    await proposalsAtEnd(at(view()), null, kept);
    deepStrictEqual(kept[0].proposals, [p], 'control: a current one stays');
    // A halt: its own and every lane's, once each; a failed look confirms nothing.
    const halted = await proposalsAtEnd(at(view()), { outcome: 'halt', reason: 'awaiting-owner:peer-conflict', proposals: [p] }, [{ subtask_id: 'A', proposals: [p] }]);
    deepStrictEqual(halted.proposals, [p]);
    const blind = [{ subtask_id: 'A', proposals: [p] }];
    deepStrictEqual((await proposalsAtEnd(at({ lookError: 'unreadable' }), { outcome: 'halt', proposals: [p] }, blind)).proposals, []);
    deepStrictEqual(blind[0].proposals, []);
    // Nothing held, no look.
    looks = 0;
    strictEqual(await proposalsAtEnd(at(view()), null, [{ subtask_id: 'B', proposals: [] }]), null);
    strictEqual(looks, 0);
  });
});

// The round a lane's child proposes once the scripted worker's conflict-gate
// action has recorded it: the child's task file in the default state root.
async function laneProposal(t, id) {
  const wf = (await t.fx.subtask(id)).engineer_workflow_id;
  const rel = `.agentic-plugins/state/engineer/consensus/${wf}.${PEER_RUN}.md`;
  return { kind: 'consensus', command: round(join(t.work, rel)), pointer: rel, subtask_id: id, gate: 'peer-conflict' };
}

async function previewOf(t, ...args) {
  const out = [];
  const code = await C.main(['preview', ...args, '--repo', t.work], { env: t.env, out: (x) => out.push(x), err: (x) => out.push(`ERR ${x}`) });
  return { code, out };
}

// A ends on its conflict gate first and halts the run; B, in flight, ends on
// its own while the run drains.
const BOTH_ON_GATES = {
  A: { next: [COMMIT] }, B: { next: [COMMIT] },
  actions: { 1: ['wait:b-started', 'conflict-gate'], 2: ['mark-start:b-started', 'wait:drained', 'conflict-gate'] },
};
const DRAIN_STARTS = /^■ lane A: awaiting-owner:peer-conflict/;

describe('a run with lanes reports the proposals it met (ADR-0067 Decision 8, item 5)', () => {
  it('a lane whose step ends on its conflict gate while the run drains keeps its proposal into the report; every lane\'s is reported once, naming its subtask and gate; the preview and the relaunch report both', async () => {
    const t = await setup({ scenario: BOTH_ON_GATES });
    markOn(t, DRAIN_STARTS, 'drained');
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      for (const n of ['b-started', 'drained']) ok(!existsSync(join(t.dir, `${n}.timeout`)), `${n}: the steps ran in the order the test set`);
      let r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2], x[4]]).sort(), [['A', 'dispatch', 'ok'], ['B', 'dispatch', 'ok']]);
      deepStrictEqual([r.halt.reason, r.halt.subtask_id, r.halt.also], ['awaiting-owner:peer-conflict', 'A', undefined],
        'B met its gate in the drain: no halt of its own');
      const pa = await laneProposal(t, 'A');
      const pb = await laneProposal(t, 'B');
      deepStrictEqual(r.halt.proposals, [pa, pb], 'every lane\'s, the halt\'s own once');
      const lanes = bySubtask(r);
      deepStrictEqual([lanes.A.proposals, lanes.B.proposals, lanes.B.halt], [[pa], [pb], null]);
      for (const p of [pa, pb]) strictEqual(t.lines.filter((l) => l === line(p)).length, 1, t.lines.join('\n'));

      // The preview: every lane halt's proposal, in its JSON and its text.
      const json = await previewOf(t, '--lanes', '2', '--macro', t.fx.macroId, '--json');
      const report = JSON.parse(json.out.join('\n'));
      strictEqual(report.lanes.halt.reason, 'awaiting-owner:peer-conflict', json.out.join('\n'));
      deepStrictEqual(report.proposals, [pa, pb]);
      const text = await previewOf(t, '--lanes', '2', '--macro', t.fx.macroId);
      for (const p of [pa, pb]) ok(text.out.includes(line(p)), text.out.join('\n'));

      // The relaunch halts on both gates before any step: the first is the
      // run's halt, the other is kept beside it, and each carries its round.
      t.lines.length = 0;
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      r = t.latest();
      strictEqual(r.steps.length, 0, t.lines.join('\n'));
      deepStrictEqual([r.halt.subtask_id, r.halt.also?.map((h) => [h.reason, h.subtask_id])], ['A', [['awaiting-owner:peer-conflict', 'B']]]);
      deepStrictEqual(r.halt.proposals, [pa, pb]);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a task file retired while the run drains is not reported: the run judges every proposal it met again as it ends', async () => {
    const t = await setup({ scenario: BOTH_ON_GATES });
    markOn(t, DRAIN_STARTS, 'drained');
    const dir = join(t.work, '.agentic-plugins/state/engineer/consensus');
    const live = () => readdirSync(dir).filter((n) => !n.endsWith('.resolved.md'));
    let kept = null;
    const retired = [];
    const push = t.lines.push.bind(t.lines);
    t.lines.push = (l) => {
      // When the drain starts only A's file exists. B's step then writes its
      // own and ends on its gate; once that step is settled (its look taken),
      // B's file is retired, as the owner's clear retires it, before the end.
      if (DRAIN_STARTS.test(l)) [kept] = live();
      if (/^ {4}\[\d+\] lane B exit=/.test(l)) {
        for (const n of live().filter((x) => x !== kept)) {
          renameSync(join(dir, n), join(dir, n.replace(/\.md$/, '.resolved.md')));
          retired.push(n);
        }
      }
      return push(l);
    };
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      ok(!existsSync(join(t.dir, 'drained.timeout')), 'B ran while the run drained');
      const r = t.latest();
      const pa = await laneProposal(t, 'A');
      const pb = await laneProposal(t, 'B');
      deepStrictEqual(retired, [pb.pointer.split('/').at(-1)], 'B\'s file was retired after its step was settled');
      deepStrictEqual(r.halt.proposals, [pa], 'A\'s file is current; B\'s is not');
      const lanes = bySubtask(r);
      deepStrictEqual([lanes.A.proposals, lanes.B.proposals], [[pa], []]);
      ok(t.lines.includes(line(pa)), t.lines.join('\n'));
      ok(!t.lines.some((l) => l.includes(pb.command)), t.lines.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('the preview carries the proposals (ADR-0067 Decision 8, item 5)', () => {
  it('serial: a child on its conflict gate, in the preview\'s JSON and text', async () => {
    const fx = await makeRepo();
    fx.env.HOME = join(fx.dir, 'home');
    mkdirSync(fx.env.HOME);
    try {
      const c = await fx.dispatch('A');
      await fx.eng.commitEnsemble({ workflowPath: c.path, run_id: PEER_RUN, phase: 'critique', ensemble_type: 'review', verdict: 'conflict', summary: 'C1 contested' });
      await fx.eng.writeConsensusTask({ workflowPath: c.path, runId: PEER_RUN, text: 'C1: A or B?' });
      await fx.finish(c.path, { kind: 'owner-decision', verb: null, confidence: 'HIGH' }, { ownerGate: { gate: 'peer-conflict', anchor: 'ensemble-synthesis', runId: PEER_RUN } });
      const t = {
        work: realpathSync(fx.work),
        env: { ...fx.env, AUTOPILOT_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: join(fx.dir, 'claude.log'), AGENTIC_ORCHESTRATOR_ROOT: ORCH, AGENTIC_ENGINEER_ROOT: ENG, AGENTIC_RUNTIME_ROOT: RUNTIME },
      };
      const rel = `.agentic-plugins/state/engineer/consensus/${c.id}.${PEER_RUN}.md`;
      const p = { kind: 'consensus', command: round(join(t.work, rel)), pointer: rel, subtask_id: 'A', gate: 'peer-conflict' };
      const json = await previewOf(t, '--json');
      const report = JSON.parse(json.out.join('\n'));
      strictEqual(report.decision.reason, 'awaiting-owner:peer-conflict', json.out.join('\n'));
      deepStrictEqual(report.proposals, [p]);
      const text = await previewOf(t);
      ok(text.out.includes(line(p)), text.out.join('\n'));
      ok(text.out.includes(`    pointer: ${rel}`), text.out.join('\n'));
    } finally {
      fx.cleanup();
    }
  });

  it('with lanes: a macro on plan-conflict halts the preview plan-unapproved, and its JSON and text carry the macro\'s round', async () => {
    const t = await setup({ scenario: {} });
    try {
      const subtasks = (await t.fx.readMacro()).plan.subtasks;
      await t.fx.orch.setPlan({ workflowPath: t.fx.macroPath, host: 'claude', subtasks, verdict: 'conflict', runId: PLAN_RUN });
      await t.fx.orch.commitEnsemble({ workflowPath: t.fx.macroPath, run_id: PLAN_RUN, phase: 'plan', ensemble_type: 'plan-verify', verdict: 'conflict', summary: 'C1 contested' });
      await t.fx.orch.writeConsensusTask({ workflowPath: t.fx.macroPath, runId: PLAN_RUN, text: 'C1: split A?' });
      const rel = `.agentic-plugins/state/orchestrator/consensus/${t.fx.macroId}.${PLAN_RUN}.md`;
      const p = { kind: 'consensus', command: round(join(t.work, rel)), pointer: rel, subtask_id: null, gate: 'plan-conflict' };
      const json = await previewOf(t, '--lanes', '2', '--macro', t.fx.macroId, '--json');
      const report = JSON.parse(json.out.join('\n'));
      strictEqual(report.lanes.halt.reason, 'plan-unapproved', json.out.join('\n'));
      deepStrictEqual(report.proposals, [p]);
      const text = await previewOf(t, '--lanes', '2', '--macro', t.fx.macroId);
      ok(text.out.includes(line(p)), text.out.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });
});
