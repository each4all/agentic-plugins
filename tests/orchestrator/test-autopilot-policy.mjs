// tests/orchestrator/test-autopilot-policy.mjs
//
// ADR-0063 D3/D4 — the autopilot's pure gate policy (plugins/orchestrator/
// adapters/claude/autopilot/policy.mjs): `decide` over every step of the D3
// table and every halt reason of D4, the order its rules apply in, the owner's
// `--next`, `verifyStep` (worker failure, the D11 report cross-check, the
// per-step postconditions, no-progress, oversize) and the fingerprint.
//
// Views are built by hand here; tests/orchestrator/test-autopilot-observe.mjs
// checks that the observer builds the same shapes from real state files.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const P = await import(resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/policy.mjs'));
const { decide, verifyStep, fingerprint, renderStep, parseForcedStep, modelFor, HALT_REASONS, STEP_KINDS } = P;

const MACRO = 'macro-plan-20261001T000000Z-abcdef';
const RUN = 'autopilot-20261001T000000Z-123456';
const ENG_A = 'compose-20261001T000100Z-aaaaaa';
const ENG_B = 'compose-20261001T000200Z-bbbbbb';

// Every halt reason any test below produced, for the coverage check at the end.
const SEEN = new Set();
const reasonOf = (d) => {
  if (d?.outcome === 'halt') SEEN.add(d.reason.startsWith('awaiting-owner:') ? 'awaiting-owner' : d.reason);
  return d?.reason;
};

function sub(id, status, extra = {}) {
  return { id, label: id, verb: 'compose', profile: 'backend', branch: `feat/${id.toLowerCase()}`, blocked_by: [], status, ...extra };
}

function child(id, over = {}) {
  return {
    location: 'active',
    path: `/r/.agentic-plugins/state/engineer/workflows/${id}.md`,
    relPath: `.agentic-plugins/state/engineer/workflows/${id}.md`,
    workflow_id: id,
    branch: 'feat/a',
    current_phase: 'phase-2-presented',
    terminal_marker: false,
    next_step: { kind: 'verb', verb: 'critique', confidence: 'HIGH' },
    awaiting_owner: null,
    workflow_type: 'verb-chain',
    parent_detached: false,
    pending_ensemble: 0,
    pending_runs: [],
    ensemble_results: 1,
    commit_manifest: 1,
    progress: 3,
    parent_workflow: MACRO,
    originating_subtask: 'A',
    ...over,
  };
}

/** A view: A and B, B blocked by A, approved, clean, on main, nothing dispatched. */
function view(over = {}) {
  const subtasks = over.subtasks ?? [sub('A', 'pending'), sub('B', 'blocked', { blocked_by: ['A'] })];
  const ready = over.ready !== undefined ? over.ready : { ready: subtasks.find((s) => s.status === 'pending') ?? null, approval: { status: 'approved', hash_ok: true } };
  return {
    repoRoot: '/r',
    git: { branch: 'main', head: 'h0', porcelain: '', clean: true, detached: false, ...(over.git ?? {}) },
    brief: over.brief !== undefined ? over.brief : { disposition: 'lead', leading: { command: '/orchestrator:resume' }, rows: [] },
    briefError: over.briefError ?? null,
    macro: over.macro !== undefined ? over.macro : {
      id: MACRO,
      path: `/r/.agentic-plugins/state/orchestrator/workflows/${MACRO}.md`,
      relPath: `.agentic-plugins/state/orchestrator/workflows/${MACRO}.md`,
      archived: false,
      fm: {
        workflow_id: MACRO, current_phase: 'phase-2-presented', terminal_marker: false,
        plan_approval_status: 'approved', plan_approval_plan_hash: 'f'.repeat(64),
        git_baseline: { branch: 'main' }, plan: { subtasks }, host_history: [],
        ...(over.fm ?? {}),
      },
    },
    macroLookupError: over.macroLookupError ?? null,
    ready,
    readyError: over.readyError ?? null,
    children: over.children ?? {},
    foreign: over.foreign ?? null,
    claims: over.claims ?? Object.entries(over.children ?? {})
      .filter(([, c]) => c.location === 'active')
      .map(([id, c]) => ({ id: c.workflow_id, path: c.path, relPath: c.relPath, originating_subtask: id, branch: c.branch })),
    claimsError: over.claimsError ?? null,
    landing: over.landing ?? {},
  };
}

/** A in progress with an active child, on its branch. */
const inProgressA = (childOver = {}, over = {}) => view({
  subtasks: [sub('A', 'in_progress', { engineer_workflow_id: ENG_A }), sub('B', 'blocked', { blocked_by: ['A'] })],
  ready: { ready: null, reason: 'in_progress_or_blocked', readiness: [], approval: { status: 'approved', hash_ok: true } },
  git: { branch: 'feat/a' },
  children: { A: child(ENG_A, childOver) },
  ...over,
});

/** A committed and archived (commit-complete), waiting on its landing. */
const archivedA = (landing, childOver = {}, over = {}) => view({
  subtasks: [sub('A', 'in_progress', { engineer_workflow_id: ENG_A }), sub('B', 'blocked', { blocked_by: ['A'] })],
  ready: { ready: null, reason: 'in_progress_or_blocked', readiness: [], approval: { status: 'approved', hash_ok: true } },
  git: { branch: 'feat/a' },
  children: {
    A: child(ENG_A, {
      location: 'archived', path: `/r/.agentic-plugins/state/engineer/archive/${ENG_A}.md`,
      relPath: `.agentic-plugins/state/engineer/archive/${ENG_A}.md`,
      current_phase: 'commit-complete', terminal_marker: true, ...childOver,
    }),
  },
  claims: [],
  landing: { A: landing },
  ...over,
});

const ctx = (over = {}) => ({ runId: RUN, macroId: MACRO, forced: null, finalizeAttempted: false, ...over });

describe('decide — the D3 step table', () => {
  it('dispatches the ready subtask of an approved plan on a clean tree', () => {
    const d = decide(view(), ctx());
    deepStrictEqual([d.outcome, d.step.kind, d.step.subtaskId], ['step', 'dispatch', 'A']);
    strictEqual(renderStep(d.step, { macroId: MACRO, runId: RUN }), `/orchestrator:next A --workflow=${MACRO}`);
  });

  it('runs the next verb an active child recorded at HIGH confidence', () => {
    const d = decide(inProgressA(), ctx());
    deepStrictEqual([d.step.kind, d.step.verb, d.step.subtaskId], ['verb', 'critique', 'A']);
    strictEqual(renderStep(d.step, { macroId: MACRO, runId: RUN }), '/engineer:critique');
  });

  it('routes next step commit and done to /engineer:commit', () => {
    for (const kind of ['commit', 'done']) {
      const d = decide(inProgressA({ next_step: { kind, verb: null, confidence: 'HIGH' } }), ctx());
      deepStrictEqual([d.step.kind, renderStep(d.step, { macroId: MACRO, runId: RUN })], ['commit', '/engineer:commit'], kind);
    }
  });

  it('records a landed subtask with /orchestrator:done', () => {
    const d = decide(archivedA({ ok: true, commit: 'c'.repeat(40) }), ctx());
    deepStrictEqual([d.step.kind, renderStep(d.step, { macroId: MACRO, runId: RUN })], ['done', `/orchestrator:done A --workflow=${MACRO}`]);
  });

  it('closes a subtask that landed nothing with /orchestrator:done --no-commit and a fixed reason', () => {
    const d = decide(archivedA(undefined, { current_phase: 'close-complete' }), ctx());
    strictEqual(d.step.kind, 'done-no-commit');
    const cmd = renderStep(d.step, { macroId: MACRO, runId: RUN });
    ok(cmd.startsWith(`/orchestrator:done A --no-commit --workflow=${MACRO} Autopilot run ${RUN}: engineer workflow ${ENG_A} closed without a commit`), cmd);
  });

  it('finalizes when every subtask completed and the macro is still active', () => {
    const v = view({ subtasks: [sub('A', 'completed'), sub('B', 'completed')], ready: { ready: null, reason: 'all_terminal', approval: { status: 'approved', hash_ok: true } } });
    const d = decide(v, ctx());
    deepStrictEqual([d.step.kind, renderStep(d.step, { macroId: MACRO, runId: RUN })], ['finalize', `/orchestrator:finalize --workflow=${MACRO}`]);
  });

  it('reports completion from the archived macro, not from a finalize step', () => {
    const v = view({ subtasks: [sub('A', 'completed'), sub('B', 'completed')], ready: { ready: null, reason: 'all_terminal', approval: { status: 'approved', hash_ok: true } } });
    v.macro.archived = true;
    v.macro.fm.terminal_marker = true;
    v.macro.fm.current_phase = 'commit-complete';
    strictEqual(decide(v, ctx()).outcome, 'completed');
  });

  it('dispatches beside a subtask that waits to land (D23: several may be in progress)', () => {
    const v = archivedA({ ok: false, reason: 'no_pr', detail: 'no PR' }, {}, {
      subtasks: [sub('A', 'in_progress', { engineer_workflow_id: ENG_A }), sub('C', 'pending')],
    });
    v.ready = { ready: sub('C', 'pending'), approval: { status: 'approved', hash_ok: true } };
    deepStrictEqual([decide(v, ctx()).step.kind, decide(v, ctx()).step.subtaskId], ['dispatch', 'C']);
  });

  it('every step kind is produced by some view and renders', () => {
    const produced = new Set();
    for (const v of [view(), inProgressA(), inProgressA({ next_step: { kind: 'commit', verb: null, confidence: 'HIGH' } }),
      archivedA({ ok: true }), archivedA(undefined, { current_phase: 'close-complete' }),
      view({ subtasks: [sub('A', 'completed')], ready: { ready: null, reason: 'all_terminal', approval: { status: 'approved', hash_ok: true } } })]) {
      const d = decide(v, ctx());
      produced.add(d.step.kind);
      ok(renderStep(d.step, { macroId: MACRO, runId: RUN }).startsWith('/'));
    }
    deepStrictEqual([...produced].sort(), [...STEP_KINDS].sort());
  });
});

describe('decide — the D4 halts', () => {
  const cases = [
    ['no macro', view({ macro: null, ready: null }), 'owner-choice', /no active macro/],
    ['a macro lookup error', view({ macroLookupError: 'ambiguous' }), 'owner-choice', /macro lookup failed: ambiguous/],
    ['entry-brief failure (fail closed)', view({ briefError: 'boom' }), 'owner-choice', /entry-brief failed/],
    ['entry-brief indeterminate', view({ brief: { disposition: 'indeterminate', leading: null, rows: [] } }), 'owner-choice', /indeterminate/],
    ['entry-brief no-branch-context', view({ brief: { disposition: 'no-branch-context', leading: null, rows: [] } }), 'owner-choice', /no branch context/],
    ['two live workflows compete (duplicate-workflow)', view({ brief: { disposition: 'owner-choice-required', leading: null, rows: [
      { source: 'persona-workflow', id: 'x', state: 'active' }, { source: 'macro-active', id: MACRO, state: 'active' }] } }), 'owner-choice', /2 live workflows compete/],
    ['a lead outside the step table', view({ brief: { disposition: 'lead', leading: { command: '/orchestrator:plan' }, rows: [] } }), 'owner-choice', /not a step this run takes/],
    ['detached HEAD', view({ git: { branch: '', detached: true } }), 'owner-choice', /detached/],
    ['next-ready failed', view({ ready: null, readyError: 'exit 1' }), 'owner-choice', /next-ready failed/],
    ['no approval recorded', view({ ready: { ready: sub('A', 'pending'), approval: { status: 'absent', hash_ok: null } } }), 'plan-unapproved', /no approval recorded/],
    ['pending approval', view({ ready: { ready: sub('A', 'pending'), approval: { status: 'pending', hash_ok: null } }, fm: { awaiting_owner_gate: 'plan-approval' } }), 'plan-unapproved', /pending approval \(plan-approval\)/],
    ['plan edited after approval', view({ ready: { ready: sub('A', 'pending'), approval: { status: 'approved', hash_ok: false } } }), 'plan-unapproved', /changed since it was approved/],
    ['dirty tree before a dispatch', view({ git: { porcelain: '?? x', clean: false } }), 'dirty-tree', /not clean before dispatching A: \?\? x/],
    ['a child owner gate', inProgressA({ awaiting_owner: { gate: 'decide-conflict', pointer: 'p#ensemble-synthesis' } }), 'awaiting-owner:decide-conflict', /waits for the owner/],
    ['low confidence', inProgressA({ next_step: { kind: 'verb', verb: 'refine', confidence: 'MEDIUM' } }), 'low-confidence', /verb:refine @ MEDIUM/],
    ['owner decision', inProgressA({ next_step: { kind: 'owner-decision', verb: null, confidence: 'HIGH' } }), 'owner-decision', /asks the owner to decide/],
    ['no next step recorded', inProgressA({ next_step: null }), 'owner-choice', /no next step is recorded/],
    ['a next step outside the enums', inProgressA({ next_step: { kind: 'verb', verb: 'deploy', confidence: 'HIGH' } }), 'owner-choice', /outside the closed enums/],
    ['an /engineer:start workflow', inProgressA({ workflow_type: 'start' }), 'owner-choice', /stays interactive/],
    ['a detached child', inProgressA({ parent_detached: true }), 'owner-choice', /detached from its macro/],
    ['a pending peer ensemble', inProgressA({ pending_ensemble: 1, pending_runs: ['plan-verify-x'] }), 'owner-choice', /peer ensemble is still pending \(plan-verify-x\)/],
    ['the child on another branch', inProgressA({}, { git: { branch: 'main' } }), 'owner-choice', /never switches branches/],
    ['a child that belongs to another attempt', inProgressA({ location: 'linkage-mismatch', detail: 'branch=feat/z' }), 'owner-choice', /does not belong to this attempt: branch=feat\/z/],
    ['an unreadable child', inProgressA({ location: 'error', detail: 'EACCES' }), 'owner-choice', /could not be read: EACCES/],
    ['a recorded child that is gone', inProgressA({ location: 'missing' }), 'owner-choice', /neither active nor archived/],
    ['in progress with no child at all', inProgressA({ location: 'unrecorded' }), 'owner-choice', /no engineer workflow recorded/],
    ['a child archived without finishing', archivedA(undefined, { current_phase: 'phase-1-compose', terminal_marker: false }), 'owner-choice', /archived without finishing/],
    ['a landing refusal other than waiting', archivedA({ ok: false, reason: 'base_mismatch', detail: 'merged into dev' }), 'owner-choice', /landing refused \(base_mismatch\): merged into dev/],
    ['resolve-landing failing outright', archivedA({ error: 'exit 2' }), 'owner-choice', /resolve-landing failed: exit 2/],
    ['a foreign workflow on the branch', view({ foreign: { id: 'investigate-x', path: '/r/x.md', relPath: 'x.md', detail: 'its parent is none' } }), 'owner-choice', /does not belong to this macro/],
    ['a terminal macro still active', view({ fm: { terminal_marker: true } }), 'owner-choice', /terminal but still active/],
    ['a deferred subtask at the end', view({ subtasks: [sub('A', 'completed'), sub('B', 'deferred')], ready: { ready: null, reason: 'all_terminal', approval: { status: 'approved', hash_ok: true } } }), 'owner-choice', /not all completed: B=deferred/],
    ['an empty plan', view({ subtasks: [], ready: { ready: null, reason: 'empty_plan', approval: { status: 'approved', hash_ok: true } } }), 'owner-choice', /has no subtasks/],
    ['a ready id that could carry text into a prompt', view({ subtasks: [sub('A x; rm', 'pending')] }), 'owner-choice', /outside \[A-Za-z0-9._-\]/],
  ];
  for (const [name, v, reason, detail] of cases) {
    it(name, () => {
      const d = decide(v, ctx());
      strictEqual(reasonOf(d), reason, JSON.stringify(d));
      ok(detail.test(d.detail), d.detail);
    });
  }

  it('awaiting-landing lists each waiting branch with the push and pull-request commands', () => {
    const d = decide(archivedA({ ok: false, reason: 'no_pr', detail: 'No pull request' }), ctx());
    strictEqual(reasonOf(d), 'awaiting-landing');
    deepStrictEqual(d.waiting[0].commands, ['git push -u origin feat/a', 'gh pr create --base main --head feat/a --fill']);
    const open = decide(archivedA({ ok: false, reason: 'not_merged', detail: 'Pull request #7 is open' }), ctx());
    strictEqual(reasonOf(open), 'awaiting-landing');
    deepStrictEqual(open.waiting[0].commands, [], 'an open pull request needs a merge, not a push');
  });

  it('awaiting-landing never prints a command for a branch outside the safe alphabet', () => {
    const v = archivedA({ ok: false, reason: 'no_pr', detail: '' });
    v.macro.fm.plan.subtasks[0].branch = 'feat/$(id)';
    v.children.A.branch = 'feat/$(id)';
    const d = decide(v, ctx());
    deepStrictEqual(d.waiting[0].commands, []);
    ok(/push it by hand/.test(d.waiting[0].note));
  });

  it('an archived summary-complete child (an interactive Stop archive) still waits to land, with a note', () => {
    const d = decide(archivedA({ ok: false, reason: 'no_pr', detail: '' }, { current_phase: 'summary-complete' }), ctx());
    strictEqual(reasonOf(d), 'awaiting-landing');
    ok(/archived by a Stop hook after an interactive summary-complete/.test(d.waiting[0].note));
  });

  it('a pointer is repo-relative and names the field that blocks', () => {
    const d = decide(inProgressA({ next_step: { kind: 'verb', verb: 'refine', confidence: 'LOW' } }), ctx());
    strictEqual(d.pointer, `.agentic-plugins/state/engineer/workflows/${ENG_A}.md#next_step`);
    const u = decide(view({ ready: { ready: sub('A', 'pending'), approval: { status: 'approved', hash_ok: false } } }), ctx());
    strictEqual(u.pointer, `.agentic-plugins/state/orchestrator/workflows/${MACRO}.md#macro-plan`);
  });
});

describe('decide — the order its rules apply in', () => {
  it('approval is checked before the macro gate a pending plan carries (V1: an edit halts plan-unapproved)', () => {
    const v = view({ ready: { ready: sub('A', 'pending'), approval: { status: 'pending', hash_ok: null } }, fm: { awaiting_owner_gate: 'plan-approval', awaiting_owner_pointer: 'm.md#macro-plan' } });
    const d = decide(v, ctx());
    strictEqual(reasonOf(d), 'plan-unapproved');
    strictEqual(d.pointer, 'm.md#macro-plan');
  });

  it('a macro gate on an approved plan still halts (defensive)', () => {
    const d = decide(view({ fm: { awaiting_owner_gate: 'plan-conflict' } }), ctx());
    strictEqual(reasonOf(d), 'awaiting-owner:plan-conflict');
  });

  it('an archived macro whose plan was edited during the last step is not completed', () => {
    const v = view({ subtasks: [sub('A', 'completed')], ready: { ready: null, reason: 'all_terminal', approval: { status: 'pending', hash_ok: null } } });
    v.macro.archived = true;
    v.macro.fm.terminal_marker = true;
    const d = decide(v, ctx());
    strictEqual(reasonOf(d), 'plan-unapproved');
    ok(/completed and was archived, but the plan is pending approval/.test(d.detail), d.detail);
  });

  it('an archived macro with work left open is an owner choice, not completion', () => {
    const v = view({ subtasks: [sub('A', 'completed'), sub('B', 'deferred')] });
    v.macro.archived = true;
    v.macro.fm.terminal_marker = true;
    v.macro.fm.current_phase = 'finalized';
    strictEqual(reasonOf(decide(v, ctx())), 'owner-choice');
  });

  it('a gate wins over the commit recovery a commit phase would pick', () => {
    const d = decide(inProgressA({ current_phase: 'commit-complete', terminal_marker: false, awaiting_owner: { gate: 'staging-set', pointer: 'w.md#phase7-plan' } }), ctx());
    strictEqual(reasonOf(d), 'awaiting-owner:staging-set');
  });

  it('an interrupted commit (phase-7-commit) recovers through /engineer:commit, not the stale next step', () => {
    const d = decide(inProgressA({ current_phase: 'phase-7-commit', next_step: { kind: 'verb', verb: 'critique', confidence: 'HIGH' } }), ctx());
    deepStrictEqual([d.step.kind, d.step.recovery], ['commit', true]);
  });

  it('a live commit-complete workflow (its archive did not run) recovers through /engineer:commit', () => {
    const d = decide(inProgressA({ current_phase: 'commit-complete', terminal_marker: true, next_step: { kind: 'commit', verb: null, confidence: 'LOW' } }), ctx());
    deepStrictEqual([d.step.kind, d.step.recovery], ['commit', true]);
  });

  it('commit-complete with the marker off follows the next step (an owner resolution cleared the gate)', () => {
    const d = decide(inProgressA({ current_phase: 'commit-complete', terminal_marker: false }), ctx());
    deepStrictEqual([d.step.kind, d.step.verb], ['verb', 'critique']);
  });

  it('an interactive summary-complete child continues from its live next step', () => {
    const d = decide(inProgressA({ current_phase: 'summary-complete', terminal_marker: true }), ctx());
    deepStrictEqual([d.step.kind, d.step.verb], ['verb', 'critique']);
  });

  it('records landings before it continues the active child', () => {
    const v = archivedA({ ok: true }, {}, {
      subtasks: [sub('A', 'in_progress', { engineer_workflow_id: ENG_A }), sub('C', 'in_progress', { engineer_workflow_id: ENG_B, branch: 'feat/a' })],
    });
    v.children.C = child(ENG_B, { originating_subtask: 'C' });
    v.claims = [{ id: ENG_B, path: v.children.C.path, relPath: v.children.C.relPath, originating_subtask: 'C', branch: 'feat/a' }];
    strictEqual(decide(v, ctx()).step.kind, 'done');
  });

  it('a judgment halt of the active child halts even when a landing could be recorded (R2)', () => {
    const v = archivedA({ ok: true }, {}, {
      subtasks: [sub('A', 'in_progress', { engineer_workflow_id: ENG_A }), sub('C', 'in_progress', { engineer_workflow_id: ENG_B, branch: 'feat/a' })],
    });
    v.children.C = child(ENG_B, { originating_subtask: 'C', next_step: { kind: 'verb', verb: 'refine', confidence: 'LOW' } });
    v.claims = [{ id: ENG_B, path: v.children.C.path, relPath: v.children.C.relPath, originating_subtask: 'C', branch: 'feat/a' }];
    strictEqual(reasonOf(decide(v, ctx())), 'low-confidence');
  });

  it('two active children halt rather than pick one', () => {
    const v = inProgressA({}, { subtasks: [sub('A', 'in_progress', { engineer_workflow_id: ENG_A }), sub('C', 'in_progress', { engineer_workflow_id: ENG_B, branch: 'feat/a' })] });
    v.children.C = child(ENG_B, { originating_subtask: 'C' });
    v.claims.push({ id: ENG_B, path: v.children.C.path, relPath: v.children.C.relPath, originating_subtask: 'C', branch: 'feat/a' });
    ok(/more than one subtask has an active engineer workflow/.test(decide(v, ctx()).detail));
  });

  it('an interrupted dispatch (a child claims a subtask still pending) halts instead of dispatching again', () => {
    const v = view();
    v.claims = [{ id: ENG_A, path: '/r/w.md', relPath: 'w.md', originating_subtask: 'A', branch: 'feat/a' }];
    const d = decide(v, ctx());
    strictEqual(reasonOf(d), 'owner-choice');
    ok(/claims subtask A, which is pending: a dispatch stopped before it recorded/.test(d.detail), d.detail);
  });

  it('a claim the plan does not know, and a claim that is not the subtask\'s child, both halt', () => {
    const v = view();
    v.claims = [{ id: ENG_A, path: '/r/w.md', relPath: 'w.md', originating_subtask: 'Z', branch: 'feat/z' }];
    ok(/not in the plan/.test(decide(v, ctx()).detail));
    const w = inProgressA();
    w.claims.push({ id: ENG_B, path: '/r/other.md', relPath: 'other.md', originating_subtask: 'A', branch: 'feat/a' });
    ok(/whose active child is/.test(decide(w, ctx()).detail));
    strictEqual(reasonOf(decide(view({ claimsError: 'EACCES' }), ctx())), 'owner-choice');
  });

  it('finalize runs once per run', () => {
    const v = view({ subtasks: [sub('A', 'completed')], ready: { ready: null, reason: 'all_terminal', approval: { status: 'approved', hash_ok: true } } });
    ok(/finalize ran, but macro/.test(decide(v, ctx({ finalizeAttempted: true })).detail));
  });

  it('the entry-capture lead and a leaderless owner-choice-required are normal between steps', () => {
    strictEqual(decide(view({ brief: { disposition: 'lead', leading: { command: '/runtime:context status --slot' }, rows: [] } }), ctx()).outcome, 'step');
    strictEqual(decide(view({ brief: { disposition: 'owner-choice-required', leading: null, rows: [{ source: 'macro-bridge', state: 'in_progress_or_blocked' }] } }), ctx()).outcome, 'step');
  });
});

describe('decide — the owner\'s --next', () => {
  it('replaces a low-confidence halt of the child it names', () => {
    const d = decide(inProgressA({ next_step: { kind: 'verb', verb: 'refine', confidence: 'LOW' } }), ctx({ forced: parseForcedStep('/engineer:refine') }));
    deepStrictEqual([d.step.kind, d.step.verb, d.step.forced], ['verb', 'refine', true]);
  });

  it('never replaces a gate, the approval, or a dirty tree', () => {
    strictEqual(reasonOf(decide(inProgressA({ awaiting_owner: { gate: 'pr-handling', pointer: 'x#y' } }), ctx({ forced: parseForcedStep('/engineer:commit') }))), 'awaiting-owner:pr-handling');
    strictEqual(reasonOf(decide(view({ ready: { ready: sub('A', 'pending'), approval: { status: 'pending', hash_ok: null } } }), ctx({ forced: parseForcedStep('/orchestrator:next A') }))), 'plan-unapproved');
    strictEqual(reasonOf(decide(view({ git: { porcelain: ' M f', clean: false } }), ctx({ forced: parseForcedStep('/orchestrator:next') }))), 'dirty-tree');
  });

  it('goes through its step\'s prerequisites', () => {
    const blocked = decide(view(), ctx({ forced: parseForcedStep('/orchestrator:next B') }));
    ok(/B is blocked, not pending|waits on A/.test(blocked.detail), blocked.detail);
    const waits = view({ subtasks: [sub('A', 'pending'), sub('B', 'pending', { blocked_by: ['A'] })] });
    ok(/waits on A, which have not landed/.test(decide(waits, ctx({ forced: parseForcedStep('/orchestrator:next B') })).detail));
    ok(/needs exactly one active engineer workflow; there are 0/.test(decide(view(), ctx({ forced: parseForcedStep('/engineer:commit') })).detail));
    const elsewhere = decide(inProgressA({ next_step: null }, { git: { branch: 'main' } }), ctx({ forced: parseForcedStep('/engineer:commit') }));
    ok(/is on feat\/a, but main is checked out/.test(elsewhere.detail), 'a forced commit runs on the child\'s branch only');
  });

  it('never replaces a landing wait or a landing refusal (round 2: a forced --no-commit completed unlanded work)', () => {
    // A committed child whose pull request has not merged: no forced step gets
    // past the wait, and /orchestrator:done is not a step --next can name.
    const waiting = archivedA({ ok: false, reason: 'not_merged', detail: '' });
    ok(/--next does not apply: no subtask is ready/.test(decide(waiting, ctx({ forced: parseForcedStep('/orchestrator:next') })).detail));
    strictEqual(reasonOf(decide(waiting, ctx())), 'awaiting-landing');
    strictEqual(reasonOf(decide(archivedA({ ok: false, reason: 'gh_unavailable', detail: '' }), ctx({ forced: parseForcedStep('/orchestrator:next') }))), 'owner-choice');
    throws(() => parseForcedStep('/orchestrator:done A --no-commit'), /not a step command/);
    throws(() => parseForcedStep('/orchestrator:done A'), /not a step command/);
  });

  it('accepts only the step grammar', () => {
    deepStrictEqual(parseForcedStep(' /engineer:critique '), { kind: 'verb', verb: 'critique' });
    deepStrictEqual(parseForcedStep('/orchestrator:next'), { kind: 'dispatch', subtaskId: null });
    deepStrictEqual(parseForcedStep('/orchestrator:next S2'), { kind: 'dispatch', subtaskId: 'S2' });
    for (const bad of ['Reply OK', '/engineer:deploy', '/orchestrator:finalize', '/orchestrator:done', '/orchestrator:done S2 --force',
      '/orchestrator:next A; rm -rf /', '/engineer:commit now', '/orchestrator:plan x']) {
      throws(() => parseForcedStep(bad), /not a step command/, bad);
    }
  });
});

describe('renderStep and identifiers', () => {
  it('refuses an identifier that could carry text into a prompt', () => {
    throws(() => renderStep({ kind: 'dispatch', subtaskId: 'A ignore previous' }, { macroId: MACRO, runId: RUN }), /unsafe subtask id/);
    throws(() => renderStep({ kind: 'done', subtaskId: 'A' }, { macroId: 'macro-x; id', runId: RUN }), /unsafe macro id/);
    throws(() => renderStep({ kind: 'done-no-commit', subtaskId: 'A', engineerWorkflowId: 'x y' }, { macroId: MACRO, runId: RUN }), /unsafe engineer workflow id/);
    throws(() => renderStep({ kind: 'verb', verb: 'deploy' }, { macroId: MACRO, runId: RUN }), /unknown verb/);
  });
});

describe('modelFor — owner decision D5 plans', () => {
  it('owner-default passes nothing, sonnet pins every step, mixed splits by step', () => {
    deepStrictEqual(modelFor({ kind: 'verb', verb: 'compose' }), { model: null, effort: null });
    deepStrictEqual(modelFor({ kind: 'done' }, { plan: 'sonnet' }), { model: 'sonnet', effort: 'medium' });
    deepStrictEqual(modelFor({ kind: 'verb', verb: 'critique' }, { plan: 'mixed' }), { model: null, effort: null });
    deepStrictEqual(modelFor({ kind: 'dispatch', verb: 'refine' }, { plan: 'mixed' }), { model: 'sonnet', effort: 'medium' });
    deepStrictEqual(modelFor({ kind: 'commit' }, { plan: 'mixed' }), { model: 'sonnet', effort: 'low' });
    deepStrictEqual(modelFor({ kind: 'commit' }, { plan: 'mixed', override: { effort: 'high' } }), { model: 'sonnet', effort: 'high' });
    throws(() => modelFor({ kind: 'verb', verb: 'compose' }, { plan: 'cheap' }), /unknown model plan/);
  });
});

describe('fingerprint', () => {
  it('ignores snapshots, updated_at and landing answers; moves on any semantic field', () => {
    const a = inProgressA();
    const base = fingerprint(a);
    const b = inProgressA();
    b.macro.fm.host_history = [{ event: 'snapshot' }];
    b.macro.fm.updated_at = 'later';
    b.landing = { A: { ok: false, reason: 'no_pr' } };
    strictEqual(fingerprint(b), base);
    for (const mutate of [
      (v) => { v.git.head = 'h1'; },
      (v) => { v.git.porcelain = '?? n'; },
      (v) => { v.children.A.next_step = { kind: 'commit', verb: null, confidence: 'HIGH' }; },
      (v) => { v.children.A.awaiting_owner = { gate: 'staging-set' }; },
      (v) => { v.children.A.location = 'archived'; },
      (v) => { v.macro.fm.plan.subtasks[0].status = 'completed'; },
      (v) => { v.macro.fm.plan_approval_plan_hash = 'e'.repeat(64); },
      (v) => { v.macro.fm.host_history = [{ event: 'updated' }]; },
    ]) {
      const c = inProgressA();
      mutate(c);
      ok(fingerprint(c) !== base, String(mutate));
    }
  });
});

describe('verifyStep', () => {
  const okWorker = (over = {}) => ({
    exitCode: 0, signal: null, aborted: null, spawnError: null,
    lastResult: { is_error: false, subtype: 'success' },
    report: { outcome: 'completed', workflow: ENG_A, next_step: { kind: 'commit', verb: null, confidence: 'HIGH' }, awaiting_owner: null, summary: 's' },
    denials: [], peakPct: 0.05, ...over,
  });
  const verbStep = { kind: 'verb', verb: 'critique', subtaskId: 'A', branch: 'feat/a' };
  const before = inProgressA();
  const after = inProgressA({ next_step: { kind: 'commit', verb: null, confidence: 'HIGH' }, progress: 4 });
  const verify = (over = {}) => verifyStep({ step: verbStep, worker: okWorker(over.worker), before: over.before ?? before, after: over.after ?? after, oversizePct: 0.25 });

  it('continues after a verb whose report matches the state it changed', () => {
    strictEqual(verify(), null);
  });

  it('halts a step whose process group outlived SIGKILL, however well it went otherwise (round 4)', () => {
    const d = verify({ worker: { groupTeardown: 'lingering', pgid: 4242 } });
    strictEqual(d.reason, 'worker-failed');
    ok(/process group \(4242\) is still there after SIGKILL; the run keeps its locks/.test(d.detail), d.detail);
    for (const g of ['empty', 'terminated', 'killed']) strictEqual(verify({ worker: { groupTeardown: g } }), null, g);
  });

  const cases = [
    ['an interrupt', { worker: { aborted: 'interrupted' } }, 'interrupted'],
    ['a PreCompact event', { worker: { aborted: 'compaction-imminent' } }, 'compaction-imminent'],
    ['a timeout', { worker: { aborted: 'timeout', timeoutSec: 5 } }, 'worker-failed'],
    ['plugins loaded from elsewhere', { worker: { aborted: 'provenance', abortReason: 'version-drift', abortDetail: 'engineer 0.23.0' } }, 'version-drift'],
    ['a spawn failure', { worker: { spawnError: 'ENOENT', lastResult: null } }, 'worker-failed'],
    ['no result', { worker: { lastResult: null, exitCode: 1 } }, 'worker-failed'],
    ['a non-zero exit', { worker: { exitCode: 1 } }, 'worker-failed'],
    ['an error result (budget exhausted)', { worker: { lastResult: { is_error: true, subtype: 'error_max_budget_usd' } } }, 'worker-failed'],
    ['no report', { worker: { report: null } }, 'owner-choice'],
    ['a report of failure', { worker: { report: { outcome: 'failed', workflow: ENG_A, next_step: null, awaiting_owner: null, summary: 'x' } } }, 'worker-failed'],
    ['a reported gate the state does not hold', { worker: { report: { outcome: 'needs_owner', workflow: ENG_A, next_step: null, awaiting_owner: 'scope-routing', summary: 'x' } } }, 'owner-choice'],
    ['needs_owner with no owner decision recorded', { worker: { report: { outcome: 'needs_owner', workflow: ENG_A, next_step: { kind: 'commit', verb: null, confidence: 'HIGH' }, awaiting_owner: null, summary: 'x' } } }, 'owner-choice'],
    ['a next step the state does not record', { worker: { report: { outcome: 'completed', workflow: ENG_A, next_step: { kind: 'verb', verb: 'refine', confidence: 'HIGH' }, awaiting_owner: null, summary: 'x' } } }, 'owner-choice'],
    ['a report about another workflow (the macro proposal)', { worker: { report: { outcome: 'completed', workflow: null, next_step: { kind: 'commit', verb: null, confidence: 'HIGH' }, awaiting_owner: null, summary: 'x' } } }, 'owner-choice'],
    ['no state change', { after: inProgressA(), worker: { report: { outcome: 'completed', workflow: ENG_A, next_step: { kind: 'verb', verb: 'critique', confidence: 'HIGH' }, awaiting_owner: null, summary: 'x' } } }, 'no-progress'],
    ['no state change with denials', { after: inProgressA(), worker: { denials: [{ tool: 'Bash' }], report: { outcome: 'completed', workflow: ENG_A, next_step: { kind: 'verb', verb: 'critique', confidence: 'HIGH' }, awaiting_owner: null, summary: 'x' } } }, 'permission-denied'],
    ['an oversized step', { worker: { peakPct: 0.4 } }, 'step-oversized'],
  ];
  for (const [name, over, reason] of cases) {
    it(name, () => {
      const d = verify(over);
      strictEqual(reasonOf(d), reason, JSON.stringify(d));
    });
  }

  it('a reported gate the state does hold is consistent', () => {
    const gated = inProgressA({ next_step: { kind: 'owner-decision', verb: null, confidence: 'HIGH' }, awaiting_owner: { gate: 'decide-conflict', pointer: 'w#x' } });
    strictEqual(verifyStep({ step: verbStep, before, after: gated, oversizePct: 0.25, worker: okWorker({ report: { outcome: 'needs_owner', workflow: ENG_A, next_step: { kind: 'owner-decision', verb: null, confidence: 'HIGH' }, awaiting_owner: 'decide-conflict', summary: 'x' } }) }), null);
  });

  describe('postconditions', () => {
    const report = { outcome: 'completed', workflow: null, next_step: null, awaiting_owner: null, summary: 's' };
    it('a dispatch must leave the subtask in progress with an active child', () => {
      const s = { kind: 'dispatch', subtaskId: 'A' };
      const dispatched = inProgressA();
      strictEqual(verifyStep({ step: s, before: view(), after: dispatched, oversizePct: 0.25, worker: okWorker({ report: { ...report, workflow: ENG_A, next_step: dispatched.children.A.next_step } }) }), null);
      const notRecorded = view({ git: { branch: 'feat/a' } });
      ok(/left subtask A pending/.test(verifyStep({ step: s, before: view(), after: notRecorded, oversizePct: 0.25, worker: okWorker({ report }) }).detail));
    });
    it('a commit must archive, commit or set a gate — a recovery that changed only bookkeeping halts', () => {
      const s = { kind: 'commit', subtaskId: 'A', recovery: true };
      const stuckBefore = inProgressA({ current_phase: 'commit-complete', terminal_marker: true });
      const stuckAfter = inProgressA({ current_phase: 'commit-complete', terminal_marker: true, progress: 9 });
      const d = verifyStep({ step: s, before: stuckBefore, after: stuckAfter, oversizePct: 0.25, worker: okWorker({ report }) });
      strictEqual(reasonOf(d), 'owner-choice');
      ok(/archive the Stop hook should run did not run/.test(d.detail), d.detail);
      strictEqual(verifyStep({ step: s, before: stuckBefore, after: archivedA({ ok: false, reason: 'no_pr' }), oversizePct: 0.25, worker: okWorker({ report }) }), null);
      const moved = inProgressA({ current_phase: 'phase-7-commit', progress: 9 }, { git: { branch: 'feat/a', head: 'h9' } });
      strictEqual(verifyStep({ step: s, before: stuckBefore, after: moved, oversizePct: 0.25, worker: okWorker({ report }) }), null);
    });
    it('a done must complete the subtask; a finalize must archive the macro', () => {
      const done = { kind: 'done', subtaskId: 'A' };
      ok(/left subtask A in_progress/.test(verifyStep({ step: done, before: archivedA({ ok: true }), after: archivedA({ ok: true }, { progress: 9 }), oversizePct: 0.25, worker: okWorker({ report }) }).detail));
      const fin = { kind: 'finalize' };
      const active = view({ subtasks: [sub('A', 'completed')], fm: { host_history: [{ event: 'updated' }] } });
      ok(/left macro .* active/.test(verifyStep({ step: fin, before: view({ subtasks: [sub('A', 'completed')] }), after: active, oversizePct: 0.25, worker: okWorker({ report }) }).detail));
    });
  });
});

describe('the closed reason set', () => {
  it('every D4 halt reason but the driver\'s budget is produced by the policy above', () => {
    const expected = HALT_REASONS.filter((r) => r !== 'budget');
    deepStrictEqual([...SEEN].sort(), [...expected].sort());
  });
});
