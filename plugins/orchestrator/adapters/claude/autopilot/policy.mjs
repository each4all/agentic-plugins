// plugins/orchestrator/adapters/claude/autopilot/policy.mjs
//
// ADR-0063 D4 — the autopilot gate policy. `decide(view, ctx)` turns the view
// the observer assembled (observe.mjs) into exactly one of: a step to run in a
// fresh worker, a halt with a reason from the closed set, or completion.
// `verifyStep` judges a step after it ran, and `fingerprint` is the semantic
// state hash the no-progress rule compares. All three are pure: no I/O, no
// clock, no environment — what they read is in their arguments, so the tests
// drive every reason code and every step without a repository or a worker.
//
// R5 (deterministic control): a step is one of six kinds, rendered from a
// fixed template. The only values spliced into a worker's prompt are
// identifiers read from state, each checked against a closed alphabet first;
// a plan whose subtask id carries anything else halts instead of reaching a
// prompt. Free text in state (`next_action`, phase notes) is never read here.
//
// Engineer's enums are copied below, not imported (ADR-0010 §5);
// tests/plugin-shape/test-autopilot-enum-parity.mjs holds the copies equal.

import { createHash } from 'node:crypto';
import { subtaskReadiness, VALID_MACRO_OWNER_GATES } from '../../../scripts/state.mjs';

export const VERBS = Object.freeze(['investigate', 'frame', 'decide', 'compose', 'critique', 'refine']);
export const NEXT_STEP_KINDS = Object.freeze(['verb', 'commit', 'owner-decision', 'done']);
export const CONFIDENCES = Object.freeze(['HIGH', 'MEDIUM', 'LOW']);
export const ENGINEER_OWNER_GATES = Object.freeze([
  'scope-routing', 'decide-conflict', 'recurring-finding', 'staging-set', 'pr-handling',
]);
// Engineer's TERMINAL_PHASES. commit-complete and close-complete are written
// only by /engineer:commit, so they are outcomes; summary-complete and
// fix-complete are an interactive verb's end and still carry a live next step.
export const ENGINEER_TERMINAL_PHASES = Object.freeze([
  'commit-complete', 'summary-complete', 'fix-complete', 'close-complete',
]);
const COMMIT_SURFACE_PHASES = new Set(['commit-complete', 'close-complete']);
export const MACRO_OWNER_GATES = Object.freeze([...VALID_MACRO_OWNER_GATES]);
// `duplicate-workflow` is never stored (no single file owns it); it reaches
// the driver as an entry-brief owner-choice-required and halts owner-choice.
export const OWNER_GATES = Object.freeze([...MACRO_OWNER_GATES, ...ENGINEER_OWNER_GATES]);

// DESIGN §6.2 / ADR-0063 D4. `awaiting-owner` is reported as
// `awaiting-owner:<gate>`.
export const HALT_REASONS = Object.freeze([
  'owner-choice', 'awaiting-owner', 'low-confidence', 'owner-decision', 'plan-unapproved',
  'awaiting-landing', 'dirty-tree', 'no-progress', 'worker-failed', 'permission-denied',
  'compaction-imminent', 'step-oversized', 'budget', 'version-drift', 'interrupted',
]);

export const STEP_KINDS = Object.freeze(['dispatch', 'verb', 'commit', 'done', 'done-no-commit', 'finalize']);

// The entry-brief leads a step-table position may legitimately show between
// steps. Any other lead (orchestrator:plan, a founder or designer workflow)
// names work this driver does not run.
export const ALLOWED_LEAD_COMMANDS = Object.freeze([
  '/engineer:resume', '/orchestrator:resume', '/orchestrator:next', '/orchestrator:finalize',
  '/runtime:context status --slot',
]);

// Identifiers that may enter a worker prompt or a printed command.
const SUBTASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MACRO_ID_RE = /^macro-[a-z][a-z0-9-]*-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const ENGINEER_ID_RE = /^(?!macro-)[a-z][a-z0-9-]*-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const RUN_ID_RE = /^autopilot-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
// A branch the owner is told to push: a git ref name in a closed alphabet.
const SAFE_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export const isSafeSubtaskId = (id) => typeof id === 'string' && SUBTASK_ID_RE.test(id);
export const isSafeMacroId = (id) => typeof id === 'string' && MACRO_ID_RE.test(id);
export function isSafeBranch(branch) {
  return typeof branch === 'string' && SAFE_BRANCH_RE.test(branch) && !branch.includes('..')
    && !branch.includes('//') && !branch.endsWith('/') && !branch.endsWith('.')
    && !branch.split('/').some((c) => c.startsWith('.') || c.endsWith('.lock'));
}

const halt = (reason, detail, extra = {}) => ({ outcome: 'halt', reason, detail, ...extra });
const step = (kind, fields = {}) => ({ outcome: 'step', step: { kind, ...fields } });

// ---------------------------------------------------------------------------
// Step grammar

/**
 * The exact text a worker receives for a step. Throws when an identifier
 * fails its alphabet — decide never returns such a step, so a throw here is a
 * caller bug, not a halt.
 */
export function renderStep(s, { macroId, runId }) {
  if (!isSafeMacroId(macroId)) throw new Error(`renderStep: unsafe macro id ${JSON.stringify(macroId)}`);
  const needId = () => {
    if (!isSafeSubtaskId(s.subtaskId)) throw new Error(`renderStep: unsafe subtask id ${JSON.stringify(s.subtaskId)}`);
    return s.subtaskId;
  };
  switch (s.kind) {
    case 'dispatch':
      return `/orchestrator:next ${needId()} --workflow=${macroId}`;
    case 'verb':
      if (!VERBS.includes(s.verb)) throw new Error(`renderStep: unknown verb ${JSON.stringify(s.verb)}`);
      return `/engineer:${s.verb}`;
    case 'commit':
      return '/engineer:commit';
    case 'done':
      return `/orchestrator:done ${needId()} --workflow=${macroId}`;
    case 'done-no-commit': {
      const id = needId();
      if (!RUN_ID_RE.test(runId ?? '')) throw new Error(`renderStep: unsafe run id ${JSON.stringify(runId)}`);
      if (!ENGINEER_ID_RE.test(s.engineerWorkflowId ?? '')) {
        throw new Error(`renderStep: unsafe engineer workflow id ${JSON.stringify(s.engineerWorkflowId)}`);
      }
      return `/orchestrator:done ${id} --no-commit --workflow=${macroId} Autopilot run ${runId}: engineer ` +
        `workflow ${s.engineerWorkflowId} closed without a commit (close-complete), so there is nothing to land.`;
    }
    case 'finalize':
      return `/orchestrator:finalize --workflow=${macroId}`;
    default:
      throw new Error(`renderStep: unknown step kind ${JSON.stringify(s.kind)}`);
  }
}

/**
 * `--next "<command>"`: the owner names the first step of a relaunch. Only the
 * step grammar is accepted, so the owner cannot hand a worker free text
 * through the driver either. Returns {kind, verb?, subtaskId?} or throws.
 *
 * It covers the steps whose automatic choice a judgment halt can stop: a verb
 * or the commit (low confidence, an owner decision, no next step) and a
 * dispatch of a particular ready subtask. `/orchestrator:done` and
 * `/orchestrator:finalize` are not in it: the driver runs them exactly when
 * their prerequisites hold (a merged pull request, a close-complete workflow,
 * every subtask completed), so forcing one could only skip a prerequisite.
 */
export function parseForcedStep(text) {
  if (typeof text !== 'string') throw new Error('--next needs a step command');
  const words = text.trim().split(/\s+/);
  const [cmd, ...rest] = words;
  const bad = () => new Error(
    `--next ${JSON.stringify(text)} is not a step command. Accepted: /engineer:<verb>, /engineer:commit, ` +
      '/orchestrator:next [<subtask>].',
  );
  const verb = /^\/engineer:([a-z]+)$/.exec(cmd ?? '');
  if (verb && rest.length === 0) {
    if (verb[1] === 'commit') return { kind: 'commit' };
    if (VERBS.includes(verb[1])) return { kind: 'verb', verb: verb[1] };
    throw bad();
  }
  if (cmd === '/orchestrator:next') {
    if (rest.length === 0) return { kind: 'dispatch', subtaskId: null };
    if (rest.length === 1 && isSafeSubtaskId(rest[0])) return { kind: 'dispatch', subtaskId: rest[0] };
    throw bad();
  }
  throw bad();
}

// ---------------------------------------------------------------------------
// Model plans (owner decision D5, 2026-10-01: asked before each start)

export const MODEL_PLANS = Object.freeze(['owner-default', 'mixed', 'sonnet']);
// `mixed`: the judgment verbs keep the owner's default; composing and
// refining run on sonnet/medium; the mechanical steps on sonnet/low.
const MIXED_BY_VERB = Object.freeze({
  investigate: null, frame: null, decide: null, critique: null,
  compose: { model: 'sonnet', effort: 'medium' },
  refine: { model: 'sonnet', effort: 'medium' },
});
const MECHANICAL = Object.freeze({ model: 'sonnet', effort: 'low' });

/**
 * {model, effort} for a step, either of them null for "the owner's Claude
 * Code setting". `override` ({model, effort} from --model/--effort) applies
 * to every step and wins field by field.
 */
export function modelFor(s, { plan = 'owner-default', override = {} } = {}) {
  if (!MODEL_PLANS.includes(plan)) throw new Error(`unknown model plan ${JSON.stringify(plan)}`);
  let base = null;
  if (plan === 'sonnet') base = { model: 'sonnet', effort: 'medium' };
  if (plan === 'mixed') {
    if (s.kind === 'verb' || s.kind === 'dispatch') base = MIXED_BY_VERB[s.verb] ?? null;
    else base = MECHANICAL;
  }
  return {
    model: override.model ?? base?.model ?? null,
    effort: override.effort ?? base?.effort ?? null,
  };
}

// ---------------------------------------------------------------------------
// Fingerprint

function progressEvents(history) {
  return Array.isArray(history) ? history.filter((h) => h && h.event && h.event !== 'snapshot').length : 0;
}

// The fields of an engineer child a step is meant to move.
function childTuple(id, c) {
  return [id, c.location, c.workflow_id ?? null, c.current_phase ?? null, c.terminal_marker === true,
    c.next_step ? [c.next_step.kind, c.next_step.verb ?? null, c.next_step.confidence] : null,
    c.awaiting_owner?.gate ?? null, c.pending_ensemble ?? 0, c.ensemble_results ?? 0,
    c.commit_manifest ?? 0, c.progress ?? 0];
}

/**
 * ADR-0067 Decision 6 — the per-lane fingerprint: the lane's git (branch,
 * HEAD, porcelain; `view.git` is the lane's), its engineer child, and only its
 * own subtask's fields (status, engineer_workflow_id, commit, pr_url,
 * closed_at). Another lane's progress, and the macro's own bookkeeping, never
 * satisfy this lane's no-progress check. Steps outside a lane keep
 * `fingerprint`.
 */
export function laneFingerprint(view, subtaskId) {
  const s = (view?.macro?.fm?.plan?.subtasks ?? []).find((x) => x?.id === subtaskId) ?? null;
  const c = view?.children?.[subtaskId] ?? null;
  return createHash('sha256').update(JSON.stringify({
    git: [view?.git?.branch ?? null, view?.git?.head ?? null, view?.git?.porcelain ?? null],
    subtask: s ? [s.id, s.status ?? null, s.engineer_workflow_id ?? null, s.commit ?? null, s.pr_url ?? null, s.closed_at ?? null] : null,
    child: c ? childTuple(subtaskId, c) : null,
  })).digest('hex');
}

/**
 * The semantic state the no-progress rule compares. Stop hooks snapshot every
 * turn end, so raw bytes and `updated_at` change without progress; only the
 * fields a step is meant to move are hashed. Landing results are left out:
 * they come from the network, not from state.
 */
export function fingerprint(view) {
  const m = view?.macro;
  const macro = m
    ? {
      id: m.id,
      archived: m.archived === true,
      phase: m.fm?.current_phase ?? null,
      marker: m.fm?.terminal_marker === true,
      approval: [m.fm?.plan_approval_status ?? null, m.fm?.plan_approval_plan_hash ?? null],
      gate: m.fm?.awaiting_owner_gate ?? null,
      subtasks: (m.fm?.plan?.subtasks ?? []).map((s) => [
        s?.id, s?.status, s?.engineer_workflow_id ?? null, s?.commit ?? null, s?.pr_url ?? null, s?.closed_at ?? null,
      ]),
      events: progressEvents(m.fm?.host_history),
    }
    : null;
  const children = Object.keys(view?.children ?? {}).sort().map((id) => childTuple(id, view.children[id]));
  return createHash('sha256').update(JSON.stringify({
    git: [view?.git?.branch ?? null, view?.git?.head ?? null, view?.git?.porcelain ?? null],
    macro,
    children,
    foreign: view?.foreign?.id ?? null,
  })).digest('hex');
}

// ---------------------------------------------------------------------------
// decide

const subtasksOf = (view) => (Array.isArray(view?.macro?.fm?.plan?.subtasks) ? view.macro.fm.plan.subtasks : []);
const gateReason = (gate) => (OWNER_GATES.includes(gate) ? `awaiting-owner:${gate}` : null);

// The entry-brief guard (ADR-0063 D4 owner-choice row). Entry-brief 1.0
// carries no next_step rows (S7 has not shipped), so the driver composes the
// step itself (D8 = a) and uses the brief only to refuse a branch whose
// sources are uncertain or competing.
function briefGuard(view) {
  if (view.briefError) return `entry-brief failed (${view.briefError}); refusing to run without it`;
  const brief = view.brief;
  if (!brief) return 'entry-brief returned no brief';
  if (brief.disposition === 'indeterminate') return 'entry-brief is indeterminate (the branch moved while it read, or a source it could not read could outrank the rest)';
  if (brief.disposition === 'no-branch-context') return 'entry-brief reports no branch context (detached HEAD)';
  if (brief.disposition === 'owner-choice-required') {
    const live = (brief.rows ?? []).filter((r) =>
      (r?.source === 'persona-workflow' || r?.source === 'macro-active') && r?.state === 'active');
    if (live.length >= 2) {
      return `entry-brief: ${live.length} live workflows compete on this branch (${live.map((r) => r.id ?? '<invalid id>').join(', ')})`;
    }
    if (live.some((r) => r.id === null)) return 'entry-brief: a live workflow on this branch has an invalid id';
    return null;
  }
  if (brief.disposition === 'lead') {
    const cmd = brief.leading?.command;
    if (!ALLOWED_LEAD_COMMANDS.includes(cmd)) {
      return `entry-brief leads ${JSON.stringify(cmd ?? null)}, which is not a step this run takes`;
    }
    return null;
  }
  return `entry-brief disposition ${JSON.stringify(brief.disposition)} is not one this driver knows`;
}

/**
 * Classify one in_progress subtask from its engineer child. Returns
 * { kind: 'active' | 'done' | 'done-no-commit' | 'waiting' | 'halt', ... }.
 * `active` carries either a step or a judgment halt (`judgment: true`), which
 * an owner's --next may replace; any other halt stands.
 */
function classify(subtask, child, landing) {
  const id = subtask.id;
  const stop = (reason, detail, extra = {}) => ({ kind: 'halt', halt: halt(reason, detail, { subtaskId: id, ...extra }) });
  if (!child) return stop('owner-choice', `subtask ${id} is in_progress but was not observed`);
  const rel = child.relPath ?? child.path ?? null;
  const where = rel ? ` (${rel})` : '';
  switch (child.location) {
    case 'error':
      return stop('owner-choice', `subtask ${id}: its engineer workflow could not be read: ${child.detail}`);
    case 'unrecorded':
      return stop('owner-choice', `subtask ${id} is in_progress with no engineer workflow recorded or active on ${subtask.branch}`);
    case 'missing':
      return stop('owner-choice', `subtask ${id} records engineer workflow ${child.workflow_id}, which is neither active nor archived`);
    case 'ambiguous':
      return stop('owner-choice', `subtask ${id}: more than one archived file holds engineer workflow ${child.workflow_id}`);
    case 'linkage-mismatch':
      return stop('owner-choice', `subtask ${id}: the engineer workflow${where} does not belong to this attempt: ${child.detail}`, { pointer: rel });
    case 'active':
    case 'archived':
      break;
    default:
      return stop('owner-choice', `subtask ${id}: unknown engineer workflow location ${child.location}`);
  }

  const pointerOf = (anchor) => (rel ? `${rel}#${anchor}` : null);
  if (child.location === 'active') {
    if (child.awaiting_owner?.gate) {
      const reason = gateReason(child.awaiting_owner.gate);
      if (!reason) return stop('owner-choice', `subtask ${id}: unknown owner gate ${child.awaiting_owner.gate}`);
      return stop(reason, `subtask ${id} waits for the owner (${child.awaiting_owner.gate})`, { pointer: child.awaiting_owner.pointer ?? pointerOf('next_step') });
    }
    if (child.workflow_type === 'start') {
      return stop('owner-choice', `subtask ${id}: ${child.workflow_id} is an /engineer:start workflow, which stays interactive (ADR-0063 D3)`, { pointer: rel });
    }
    if (child.parent_detached === true) {
      return stop('owner-choice', `subtask ${id}: ${child.workflow_id} was detached from its macro (finalize or abort stopped before archiving it)`, { pointer: rel });
    }
    if ((child.pending_ensemble ?? 0) > 0) {
      return stop('owner-choice', `subtask ${id}: a peer ensemble is still pending (${(child.pending_runs ?? []).join(', ') || 'unknown run'}); let it finish, or settle it with ensemble-commit --verdict aborted`, { pointer: pointerOf('pending_ensemble') });
    }
    // The outcome table (ADR-0063 S3+S4 note): a live file in a commit phase
    // is an interrupted commit (beginCommit leaves phase-7-commit and keeps the
    // old next step) or a commit whose archive did not run. /engineer:commit
    // recovers both, so neither follows the stale next step.
    if (child.current_phase === 'phase-7-commit'
      || (child.terminal_marker === true && COMMIT_SURFACE_PHASES.has(child.current_phase))) {
      return { kind: 'active', step: { kind: 'commit', subtaskId: id, branch: child.branch, recovery: true } };
    }
    const ns = child.next_step;
    if (!ns) {
      return { kind: 'active', judgment: true, halt: halt('owner-choice', `subtask ${id}: no next step is recorded — the last verb did not finish (its Phase 0 clears next_step)`, { subtaskId: id, pointer: pointerOf('next_step') }) };
    }
    if (!NEXT_STEP_KINDS.includes(ns.kind) || !CONFIDENCES.includes(ns.confidence)
      || (ns.kind === 'verb' && !VERBS.includes(ns.verb))) {
      return stop('owner-choice', `subtask ${id}: next step ${JSON.stringify(ns)} is outside the closed enums`);
    }
    const label = `${ns.kind}${ns.verb ? `:${ns.verb}` : ''} @ ${ns.confidence}`;
    if (ns.kind === 'owner-decision') {
      return { kind: 'active', judgment: true, halt: halt('owner-decision', `subtask ${id}: the last verb asks the owner to decide (${label})`, { subtaskId: id, pointer: pointerOf('next_step') }) };
    }
    if (ns.confidence !== 'HIGH') {
      return { kind: 'active', judgment: true, halt: halt('low-confidence', `subtask ${id}: ${label}`, { subtaskId: id, pointer: pointerOf('next_step') }) };
    }
    if (ns.kind === 'verb') return { kind: 'active', step: { kind: 'verb', verb: ns.verb, subtaskId: id, branch: child.branch } };
    return { kind: 'active', step: { kind: 'commit', subtaskId: id, branch: child.branch } };
  }

  // Archived.
  if (child.terminal_marker !== true || !ENGINEER_TERMINAL_PHASES.includes(child.current_phase)) {
    return stop('owner-choice', `subtask ${id}: engineer workflow ${child.workflow_id} was archived without finishing (phase ${child.current_phase ?? 'unknown'}) — detached or archived by hand`, { pointer: rel });
  }
  if (child.current_phase === 'close-complete') {
    return { kind: 'done-no-commit', step: { kind: 'done-no-commit', subtaskId: id, engineerWorkflowId: child.workflow_id } };
  }
  // commit-complete is /engineer:commit's outcome. summary- and fix-complete
  // are an interactive verb's end that a Stop archived after HEAD moved: work
  // committed outside /engineer:commit. Either way the merged pull request is
  // what completes the subtask, so both go through the landing check.
  const viaStop = child.current_phase !== 'commit-complete';
  if (!landing) return stop('owner-choice', `subtask ${id}: its landing was not checked`);
  if (landing.error) return stop('owner-choice', `subtask ${id}: resolve-landing failed: ${landing.error}`);
  if (landing.ok === true) return { kind: 'done', step: { kind: 'done', subtaskId: id } };
  if (landing.reason === 'no_pr' || landing.reason === 'not_merged') {
    return {
      kind: 'waiting',
      waiting: {
        subtaskId: id, branch: subtask.branch, reason: landing.reason, detail: landing.detail ?? '',
        engineerWorkflowId: child.workflow_id ?? null,
        ...(viaStop ? { note: `${child.workflow_id} was archived by a Stop hook after an interactive ${child.current_phase}; check that ${subtask.branch} carries the work` } : {}),
      },
    };
  }
  return stop('owner-choice', `subtask ${id}: landing refused (${landing.reason}): ${landing.detail ?? ''}`);
}

function landingList(waiting, integrationBranch) {
  return waiting.map((w) => {
    const safe = isSafeBranch(w.branch) && isSafeBranch(integrationBranch);
    const commands = !safe
      ? []
      : w.reason === 'no_pr'
        ? [`git push -u origin ${w.branch}`, `gh pr create --base ${integrationBranch} --head ${w.branch} --fill`]
        : [];
    const notes = [w.note, safe ? null : 'the branch name holds characters outside [A-Za-z0-9._/-]; push it by hand'].filter(Boolean);
    return { ...w, commands, note: notes.length ? notes.join('; ') : null };
  });
}

/**
 * ADR-0067 Decision 7 — the subtasks committed and not landed, as the
 * `awaiting-landing` halt lists them: each in_progress subtask whose engineer
 * workflow is archived terminal, not close-complete, and whose landing check
 * answered `no_pr` or `not_merged`. The driver's landing-ready event
 * (landing-ready.mjs) reads this list, so the event and the halt never
 * disagree about what waits.
 */
export function waitingToLand(view) {
  const waiting = subtasksOf(view).filter((s) => s?.status === 'in_progress')
    .map((s) => classify(s, view.children?.[s.id], view.landing?.[s.id]))
    .filter((c) => c.kind === 'waiting')
    .map((c) => c.waiting);
  return landingList(waiting, view?.macro?.fm?.git_baseline?.branch ?? null);
}

// Every live engineer workflow that claims the macro must be the active child
// of an in_progress subtask. A dispatch interrupted between creating the
// child and recording in_progress leaves a claim behind a pending subtask;
// dispatching anything then would run beside it.
function claimProblem(view, subtasks) {
  if (view.claimsError) return `the engineer workflows claiming this macro could not be listed: ${view.claimsError}`;
  for (const c of view.claims ?? []) {
    const s = subtasks.find((x) => x?.id === c.originating_subtask);
    const child = s ? view.children?.[s.id] : null;
    if (!s) return `engineer workflow ${c.id} (${c.relPath}) claims subtask ${c.originating_subtask ?? '?'}, which is not in the plan`;
    if (s.status !== 'in_progress') {
      return `engineer workflow ${c.id} (${c.relPath}) claims subtask ${s.id}, which is ${s.status}: a dispatch stopped before it recorded the subtask in progress, or the workflow outlived its subtask; ` +
        `re-attach it with /orchestrator:next ${s.id}, or archive it with /engineer:resume on ${c.branch}`;
    }
    if (child?.path !== c.path) {
      return `engineer workflow ${c.id} (${c.relPath}) claims subtask ${s.id}, whose active child is ${child?.workflow_id ?? 'none'}`;
    }
  }
  return null;
}

/**
 * ADR-0063 D4 — decide the next step.
 *
 * @param view  the observer's view (observe.mjs)
 * @param ctx   { runId, macroId (pinned), forced ({kind,…} from parseForcedStep, the first step only),
 *               finalizeAttempted }
 * @returns {{outcome:'step', step} | {outcome:'halt', reason, detail, pointer?, subtaskId?, waiting?}
 *          | {outcome:'completed', detail}}
 */
export function decide(view, ctx = {}) {
  if (view.macroLookupError) return halt('owner-choice', `macro lookup failed: ${view.macroLookupError}`);
  const macro = view.macro;
  if (!macro) {
    const where = view.git?.branch ? `on, or referenced by a subtask of, branch ${view.git.branch}` : 'here';
    return halt('owner-choice', `no active macro is ${where}: name one with --macro <id>, or plan one with /orchestrator:plan, review it, approve it with /orchestrator:approve, then relaunch`);
  }
  if (!isSafeMacroId(macro.id)) return halt('owner-choice', `macro id ${JSON.stringify(macro.id)} is not a macro workflow id`);
  const subtasks = subtasksOf(view);
  const macroPlan = `${macro.relPath ?? macro.path}#macro-plan`;
  const approval = view.ready?.approval;
  const unapproved = () => {
    const state = !approval ? 'no approval facts were read'
      : approval.status === 'pending' ? `the plan is pending approval (${macro.fm?.awaiting_owner_gate ?? 'no gate'})`
        : approval.status === 'approved' ? 'the plan changed since it was approved'
          : 'the plan has no approval recorded';
    return halt('plan-unapproved', `${state}; review it and approve it with /orchestrator:approve --workflow=${macro.id}`,
      { pointer: macro.fm?.awaiting_owner_pointer ?? macroPlan });
  };
  const approved = approval?.status === 'approved' && approval?.hash_ok === true;

  if (macro.archived) {
    // Success is the archived macro (the last /orchestrator:done
    // auto-terminalizes it, and that worker's Stop archives it) — but only for
    // the plan the owner approved: a plan edited during the last step is
    // archived all the same.
    const open = subtasks.filter((s) => s?.status !== 'completed');
    if (macro.fm?.terminal_marker !== true || subtasks.length === 0 || open.length > 0) {
      return halt('owner-choice', `macro ${macro.id} was archived (phase ${macro.fm?.current_phase ?? 'unknown'}) with ` +
        `${open.length ? open.map((s) => `${s?.id}=${s?.status}`).join(', ') : 'no subtasks'} not completed`, { pointer: macro.relPath ?? macro.path });
    }
    if (view.readyError) return halt('owner-choice', `next-ready failed on the archived macro: ${view.readyError}`);
    if (!approved) {
      const h = unapproved();
      return { ...h, detail: `macro ${macro.id} completed and was archived, but ${h.detail}` };
    }
    if (macro.fm?.awaiting_owner_gate) {
      return halt(gateReason(macro.fm.awaiting_owner_gate) ?? 'owner-choice', `macro ${macro.id} completed and was archived with an owner gate set (${macro.fm.awaiting_owner_gate})`, { pointer: macro.fm.awaiting_owner_pointer ?? macroPlan });
    }
    return { outcome: 'completed', detail: `macro ${macro.id} is archived with every subtask completed` };
  }

  const guard = briefGuard(view);
  if (guard) return halt('owner-choice', guard);
  if (view.git?.detached || !view.git?.branch) return halt('owner-choice', 'HEAD is detached; switch to a branch');
  if (view.readyError) return halt('owner-choice', `next-ready failed: ${view.readyError}`);
  if (!approved) return unapproved();
  if (macro.fm?.awaiting_owner_gate) {
    const reason = gateReason(macro.fm.awaiting_owner_gate) ?? 'owner-choice';
    return halt(reason, `the macro waits for the owner (${macro.fm.awaiting_owner_gate})`, { pointer: macro.fm.awaiting_owner_pointer ?? macroPlan });
  }
  if (macro.fm?.terminal_marker === true) {
    return halt('owner-choice', `macro ${macro.id} is terminal but still active: a Stop archive gate kept it (for example an active engineer child); the driver never archives`, { pointer: macro.relPath ?? macro.path });
  }
  const claim = claimProblem(view, subtasks);
  if (claim) return halt('owner-choice', claim);
  if (view.foreign) {
    return halt('owner-choice', `the engineer workflow active on ${view.git.branch} (${view.foreign.id}) does not belong to this macro's run (${view.foreign.detail})`, { pointer: view.foreign.relPath ?? view.foreign.path });
  }

  // Classify every in_progress subtask.
  const classified = subtasks.filter((s) => s?.status === 'in_progress').map((s) => ({
    subtask: s, ...classify(s, view.children?.[s.id], view.landing?.[s.id]),
  }));
  const active = classified.filter((c) => c.kind === 'active');
  if (active.length > 1) {
    return halt('owner-choice', `more than one subtask has an active engineer workflow (${active.map((c) => c.subtask.id).join(', ')})`);
  }

  // Gates, errors and landing refusals stand whatever the owner's --next says.
  for (const c of classified) {
    if (c.kind === 'halt') return c.halt;
  }

  // The owner's --next (consumed by the first step of a run) replaces the
  // policy's choice of step and the judgment halts of the subtask it names —
  // nothing else: every guard above, every gate or error, and the step's own
  // prerequisites still apply.
  const forced = ctx.forced ?? null;
  let forcedTarget = null;
  if (forced) {
    const applies = forcedApplies(forced, { view, subtasks, classified, active });
    if (applies.halt) return applies.halt;
    forcedTarget = applies;
  }
  const bypassed = (c) => forcedTarget !== null && c.subtask.id === forcedTarget.subtaskId && c.judgment === true;

  for (const c of active) {
    if (c.halt && !bypassed(c)) return c.halt;
  }

  if (forcedTarget) return finishForced(forcedTarget, view);

  for (const c of classified) {
    if (c.kind === 'done' || c.kind === 'done-no-commit') return step(c.step.kind, { ...c.step });
  }
  if (active.length === 1) {
    const s = active[0].step;
    if (s.branch !== view.git.branch) {
      return halt('owner-choice', `subtask ${s.subtaskId}'s engineer workflow is on ${s.branch}, but ${view.git.branch} is checked out; switch to ${s.branch} and relaunch (the driver never switches branches itself)`, { subtaskId: s.subtaskId });
    }
    return step(s.kind, { ...s });
  }

  const ready = view.ready?.ready;
  if (ready) {
    if (!isSafeSubtaskId(ready.id)) {
      return halt('owner-choice', `the next ready subtask id ${JSON.stringify(ready.id)} holds characters outside [A-Za-z0-9._-]`);
    }
    if (!view.git.clean) return dirtyTree(view, ready.id);
    return step('dispatch', { subtaskId: ready.id, verb: ready.verb ?? null });
  }

  if (view.ready?.reason === 'all_terminal') {
    const open = subtasks.filter((s) => s?.status !== 'completed');
    if (open.length > 0) {
      return halt('owner-choice', `every subtask is terminal, but not all completed: ${open.map((s) => `${s.id}=${s.status}`).join(', ')}`);
    }
    if (ctx.finalizeAttempted) return halt('owner-choice', `/orchestrator:finalize ran, but macro ${macro.id} is still active`, { pointer: macro.relPath ?? macro.path });
    return step('finalize', {});
  }

  const waiting = waitingToLand(view);
  if (waiting.length > 0) {
    const integration = macro.fm?.git_baseline?.branch ?? null;
    return halt('awaiting-landing',
      `${waiting.length} subtask(s) wait for their pull request to merge into ${integration}: ` +
        `${waiting.map((w) => `${w.subtaskId} (${w.branch}, ${w.reason})`).join(', ')}`,
      { waiting });
  }

  if (view.ready?.reason === 'empty_plan') return halt('owner-choice', `macro ${macro.id} has no subtasks`);
  const facts = (view.ready?.readiness ?? []).map((r) => `${r.id}=${r.status}${r.waiting_on?.length ? ` waiting on ${r.waiting_on.join(',')}` : ''}`);
  return halt('owner-choice', `nothing is dispatchable (${view.ready?.reason ?? 'unknown'}): ${facts.join('; ') || 'no facts'}`);
}

function dirtyTree(view, id) {
  const lines = String(view.git.porcelain ?? '').split('\n').filter(Boolean);
  return halt('dirty-tree', `the working tree is not clean before dispatching ${id}: ${lines.slice(0, 5).join('; ')}${lines.length > 5 ? ` (+${lines.length - 5})` : ''}`, { subtaskId: id });
}

// A forced step goes through the prerequisites its automatic twin has.
function forcedApplies(forced, { view, subtasks, classified, active }) {
  const nope = (why) => ({ halt: halt('owner-choice', `--next does not apply: ${why}`) });
  switch (forced.kind) {
    case 'verb':
    case 'commit': {
      if (active.length !== 1) return nope(`/engineer:${forced.kind === 'commit' ? 'commit' : forced.verb} needs exactly one active engineer workflow; there are ${active.length}`);
      const child = view.children?.[active[0].subtask.id];
      return { kind: forced.kind, verb: forced.verb, subtaskId: active[0].subtask.id, branch: child?.branch ?? active[0].subtask.branch };
    }
    case 'dispatch': {
      if (active.length > 0) return nope(`subtask ${active[0].subtask.id} still has an active engineer workflow`);
      const id = forced.subtaskId ?? view.ready?.ready?.id ?? null;
      if (!id) return nope('no subtask is ready and none was named');
      const s = subtasks.find((x) => x?.id === id);
      if (!s) return nope(`subtask ${id} is not in the plan`);
      if (s.status !== 'pending') return nope(`subtask ${id} is ${s.status}, not pending`);
      const done = new Set(subtasks.filter((x) => x?.status === 'completed').map((x) => x.id));
      const waitingOn = (Array.isArray(s.blocked_by) ? s.blocked_by : []).filter((d) => !done.has(d));
      if (waitingOn.length) return nope(`subtask ${id} waits on ${waitingOn.join(', ')}, which have not landed`);
      return { kind: 'dispatch', subtaskId: id, verb: s.verb ?? null };
    }
    default:
      return nope(`unknown step kind ${forced.kind}`);
  }
}

function finishForced(t, view) {
  if (t.kind === 'dispatch' && !view.git.clean) return dirtyTree(view, t.subtaskId);
  if ((t.kind === 'verb' || t.kind === 'commit') && t.branch !== view.git.branch) {
    return halt('owner-choice', `subtask ${t.subtaskId}'s engineer workflow is on ${t.branch}, but ${view.git.branch} is checked out`, { subtaskId: t.subtaskId });
  }
  const { kind, ...rest } = t;
  return step(kind, { ...rest, forced: true });
}

// ---------------------------------------------------------------------------
// Lanes (ADR-0067 Decision 6)

/**
 * The checks that read a checkout, run on the checkout a step runs in: the
 * entry-brief guard, the detached-HEAD halt and the foreign-workflow check.
 * With lanes, a lane's view before each of its steps, and the driver's
 * checkout's before each done or finalize, which run there. A halt, or null.
 */
export function checkoutProblem(view) {
  const guard = briefGuard(view);
  if (guard) return halt('owner-choice', `${view.repoRoot ? `${view.repoRoot}: ` : ''}${guard}`);
  if (view.git?.detached || !view.git?.branch) return halt('owner-choice', `HEAD is detached${view.repoRoot ? ` in ${view.repoRoot}` : ''}; switch to a branch`);
  if (view.foreign) {
    return halt('owner-choice', `the engineer workflow active on ${view.git.branch} (${view.foreign.id}) does not belong to this macro's run (${view.foreign.detail})`, { pointer: view.foreign.relPath ?? view.foreign.path });
  }
  return null;
}

const activeChildren = (view, subtasks) => subtasks
  .filter((s) => s?.status === 'in_progress' && view.children?.[s.id]?.location === 'active')
  .map((s) => s.id);

/**
 * `--next` with lanes (Forced resume): each pair `{lane, step}` — `lane` the
 * subtask id `--lane` named, or null — is judged on its lane alone. A verb or
 * the commit needs that lane's child active; a dispatch needs no active child
 * on that subtask, which is pending with every predecessor completed. With
 * more than one active child, a pair without `--lane` is refused. Returns
 * { forced: Map<subtaskId, step> } or { halt }.
 */
export function forcedForLanes(pairs, view) {
  const subtasks = subtasksOf(view);
  const active = activeChildren(view, subtasks);
  const forced = new Map();
  const nope = (why) => ({ halt: halt('owner-choice', `--next does not apply: ${why}`) });
  for (const p of pairs ?? []) {
    const f = p?.step;
    let id = p?.lane ?? null;
    if (id === null) {
      if (active.length > 1) return nope(`${active.length} engineer workflows are active (${active.join(', ')}); name the lane with --lane <subtask-id>`);
      if (f?.kind === 'dispatch') {
        id = f.subtaskId ?? subtaskReadiness(subtasks).find((r) => r.ready)?.id ?? null;
        if (!id) return nope('no subtask is ready and none was named');
      } else {
        if (active.length === 0) return nope(`/engineer:${f?.kind === 'commit' ? 'commit' : f?.verb} needs an active engineer workflow; there is none`);
        id = active[0];
      }
    }
    if (f?.kind === 'dispatch' && f.subtaskId && f.subtaskId !== id) return nope(`--lane ${id} and /orchestrator:next ${f.subtaskId} name different subtasks`);
    if (forced.has(id)) return nope(`more than one --next names the lane ${id}`);
    const s = subtasks.find((x) => x?.id === id);
    if (!s) return nope(`subtask ${id} is not in the plan`);
    switch (f?.kind) {
      case 'verb':
      case 'commit':
        if (!active.includes(id)) return nope(`subtask ${id} has no active engineer workflow`);
        forced.set(id, { kind: f.kind, ...(f.kind === 'verb' ? { verb: f.verb } : {}), subtaskId: id, branch: view.children[id].branch ?? s.branch });
        break;
      case 'dispatch': {
        if (active.includes(id)) return nope(`subtask ${id} still has an active engineer workflow`);
        if (s.status !== 'pending') return nope(`subtask ${id} is ${s.status}, not pending`);
        const waitingOn = subtaskReadiness(subtasks).find((r) => r.id === id)?.waiting_on ?? [];
        if (waitingOn.length) return nope(`subtask ${id} waits on ${waitingOn.join(', ')}, which have not landed`);
        forced.set(id, { kind: 'dispatch', subtaskId: id, verb: s.verb ?? null });
        break;
      }
      default:
        return nope(`unknown step kind ${f?.kind}`);
    }
  }
  return { forced };
}

/**
 * ADR-0067 Decision 6 — what a run with lanes may start now, judged from the
 * run-wide view (the macro, its children, claims and landing). The checks
 * that read a checkout are the caller's (`checkoutProblem`, on the checkout
 * each step runs in).
 *
 * ctx: { inFlight: Set<subtaskId> with a step in flight, a done's own
 *        included (left alone until it ends: excluded from classification,
 *        readiness and the claim check), driverBusy (a done or finalize in
 *        flight: the macro's terminal marker waits for it), lanes: Map<subtaskId, lane>
 *        the run holds, started: Set<subtaskId> whose lane stepped in this
 *        run, forced: Map<subtaskId, step> (forcedForLanes), finalizeAttempted }
 *
 * Returns { outcome: 'completed' } | a run-wide halt (approval, a macro gate,
 * the terminal marker, a claim, the plan) | { outcome: 'lanes', driverStep,
 * laneSteps, laneHalts, waiting, idle }:
 *   driverStep — a done, done-no-commit or finalize, in the driver's checkout, or null;
 *   laneSteps  — dispatch, verb and commit steps, forced first, then in plan
 *                order, each with `lane: true`, `newLane` (the lane's first
 *                step in this run: the throttle gates it) and `needsLane` (no
 *                lane is held for it: one is created once the step is admitted);
 *   laneHalts  — one subtask's halt each (a gate, an error, a judgment halt):
 *                each drains the run;
 *   waiting    — the subtasks committed and waiting to land, which hold no capacity;
 *   idle       — the halt to record when nothing can start and nothing is in flight.
 */
export function decideLanes(view, ctx = {}) {
  if (view.macroLookupError) return halt('owner-choice', `macro lookup failed: ${view.macroLookupError}`);
  const macro = view.macro;
  if (!macro) return halt('owner-choice', 'no macro was found: a run with lanes needs --macro <id>');
  if (!isSafeMacroId(macro.id)) return halt('owner-choice', `macro id ${JSON.stringify(macro.id)} is not a macro workflow id`);
  // An archived macro is judged as a serial run judges it; decide() reads no
  // checkout before that.
  if (macro.archived) return decide(view, { finalizeAttempted: ctx.finalizeAttempted });
  const inFlight = ctx.inFlight ?? new Set();
  const lanes = ctx.lanes ?? new Map();
  const started = ctx.started ?? new Set();
  const forced = ctx.forced ?? new Map();
  const subtasks = subtasksOf(view);
  const macroPlan = `${macro.relPath ?? macro.path}#macro-plan`;

  // Run-wide, before any lane's step.
  if (view.readyError) return halt('owner-choice', `next-ready failed: ${view.readyError}`);
  const approval = view.ready?.approval;
  if (!(approval?.status === 'approved' && approval?.hash_ok === true)) {
    const state = !approval ? 'no approval facts were read'
      : approval.status === 'pending' ? `the plan is pending approval (${macro.fm?.awaiting_owner_gate ?? 'no gate'})`
        : approval.status === 'approved' ? 'the plan changed since it was approved'
          : 'the plan has no approval recorded';
    return halt('plan-unapproved', `${state}; review it and approve it with /orchestrator:approve --workflow=${macro.id}`, { pointer: macro.fm?.awaiting_owner_pointer ?? macroPlan });
  }
  if (macro.fm?.awaiting_owner_gate) {
    return halt(gateReason(macro.fm.awaiting_owner_gate) ?? 'owner-choice', `the macro waits for the owner (${macro.fm.awaiting_owner_gate})`, { pointer: macro.fm.awaiting_owner_pointer ?? macroPlan });
  }
  // The last done marks the macro terminal before its worker's Stop hook
  // archives it: while a done or finalize is in flight the marker is that
  // step's transient state, judged once the step has ended.
  if (macro.fm?.terminal_marker === true && !ctx.driverBusy) {
    return halt('owner-choice', `macro ${macro.id} is terminal but still active: a Stop archive gate kept it (for example an active engineer child); the driver never archives`, { pointer: macro.relPath ?? macro.path });
  }
  const claim = claimProblem({ ...view, claims: (view.claims ?? []).filter((c) => !inFlight.has(c?.originating_subtask)) }, subtasks);
  if (claim) return halt('owner-choice', claim);

  const order = new Map(subtasks.map((s, i) => [s?.id, i]));
  const out = { outcome: 'lanes', driverStep: null, laneSteps: [], laneHalts: [], waiting: [], idle: null };
  const laneStep = (st, id) => ({ ...st, lane: true, newLane: !started.has(id), needsLane: !lanes.has(id) });
  const done = [];
  const waiting = [];
  for (const s of subtasks) {
    if (s?.status !== 'in_progress' || inFlight.has(s.id)) continue;
    const c = classify(s, view.children?.[s.id], view.landing?.[s.id]);
    if (c.kind === 'halt') { out.laneHalts.push(c.halt); continue; }
    if (c.kind === 'done' || c.kind === 'done-no-commit') { done.push(c.step); continue; }
    if (c.kind === 'waiting') { waiting.push(c.waiting); continue; }
    const f = forced.get(s.id);
    if (f && f.kind !== 'dispatch') { out.laneSteps.push(laneStep({ ...f, forced: true }, s.id)); continue; }
    if (c.halt) { out.laneHalts.push(c.halt); continue; }
    const lane = lanes.get(s.id);
    if (lane && c.step.branch !== lane.branch) {
      out.laneHalts.push(halt('owner-choice', `subtask ${s.id}'s engineer workflow is on ${c.step.branch}, but its lane ${lane.path} holds ${lane.branch}`, { subtaskId: s.id }));
      continue;
    }
    out.laneSteps.push(laneStep(c.step, s.id));
  }
  for (const r of subtaskReadiness(subtasks)) {
    if (!r.ready || inFlight.has(r.id)) continue;
    if (!isSafeSubtaskId(r.id)) {
      out.laneHalts.push(halt('owner-choice', `the ready subtask id ${JSON.stringify(r.id)} holds characters outside [A-Za-z0-9._-]`));
      continue;
    }
    const s = subtasks.find((x) => x?.id === r.id);
    out.laneSteps.push(laneStep({ kind: 'dispatch', subtaskId: r.id, verb: s?.verb ?? null, ...(forced.get(r.id)?.kind === 'dispatch' ? { forced: true } : {}) }, r.id));
  }
  out.laneSteps.sort((a, b) => (a.forced === true ? 0 : 1) - (b.forced === true ? 0 : 1) || (order.get(a.subtaskId) ?? 0) - (order.get(b.subtaskId) ?? 0));
  out.waiting = landingList(waiting, macro.fm?.git_baseline?.branch ?? null);

  const quiet = inFlight.size === 0 && !ctx.driverBusy;
  if (!ctx.driverBusy && done.length > 0) {
    out.driverStep = done[0];
  } else if (quiet && view.ready?.reason === 'all_terminal') {
    const open = subtasks.filter((s) => s?.status !== 'completed');
    if (open.length > 0) {
      out.laneHalts.push(halt('owner-choice', `every subtask is terminal, but not all completed: ${open.map((s) => `${s.id}=${s.status}`).join(', ')}`));
    } else if (ctx.finalizeAttempted) {
      out.laneHalts.push(halt('owner-choice', `/orchestrator:finalize ran, but macro ${macro.id} is still active`, { pointer: macro.relPath ?? macro.path }));
    } else {
      out.driverStep = { kind: 'finalize' };
    }
  }

  if (out.waiting.length > 0) {
    const integration = macro.fm?.git_baseline?.branch ?? null;
    out.idle = halt('awaiting-landing',
      `${out.waiting.length} subtask(s) wait for their pull request to merge into ${integration}: ` +
        `${out.waiting.map((w) => `${w.subtaskId} (${w.branch}, ${w.reason})`).join(', ')}`,
      { waiting: out.waiting });
  } else if (view.ready?.reason === 'empty_plan' || subtasks.length === 0) {
    out.idle = halt('owner-choice', `macro ${macro.id} has no subtasks`);
  } else {
    const facts = subtaskReadiness(subtasks).map((r) => `${r.id}=${r.status}${r.waiting_on?.length ? ` waiting on ${r.waiting_on.join(',')}` : ''}`);
    out.idle = halt('owner-choice', `nothing is dispatchable: ${facts.join('; ') || 'no facts'}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// verifyStep

const STEP_REPORT_OUTCOMES = Object.freeze(['completed', 'needs_owner', 'failed']);

/**
 * The --json-schema each worker answers with (owner decision D11: a
 * cross-check). `workflow` names the engineer workflow whose state the report
 * echoes, so a verb step's report is compared with that workflow's
 * `next_step_*` — never with the macro-level proposal /orchestrator:next
 * prints when it ends.
 */
export const STEP_REPORT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: [...STEP_REPORT_OUTCOMES] },
    workflow: { type: ['string', 'null'] },
    next_step: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...NEXT_STEP_KINDS] },
            verb: { enum: [...VERBS, null] },
            confidence: { type: 'string', enum: [...CONFIDENCES] },
          },
          required: ['kind', 'verb', 'confidence'],
          additionalProperties: false,
        },
      ],
    },
    awaiting_owner: { enum: [...OWNER_GATES, 'duplicate-workflow', null] },
    summary: { type: 'string', maxLength: 400 },
  },
  required: ['outcome', 'workflow', 'next_step', 'awaiting_owner', 'summary'],
  additionalProperties: false,
});

const RUNS_A_VERB = new Set(['dispatch', 'verb']);

function stateGates(view) {
  const gates = new Set();
  if (view?.macro?.fm?.awaiting_owner_gate) gates.add(view.macro.fm.awaiting_owner_gate);
  for (const c of Object.values(view?.children ?? {})) if (c?.awaiting_owner?.gate) gates.add(c.awaiting_owner.gate);
  return gates;
}

function laneGates(view, subtaskId) {
  const gates = new Set();
  if (view?.macro?.fm?.awaiting_owner_gate) gates.add(view.macro.fm.awaiting_owner_gate);
  const gate = view?.children?.[subtaskId]?.awaiting_owner?.gate;
  if (gate) gates.add(gate);
  return gates;
}

const nsLabel = (ns) => (ns ? `${ns.kind}${ns.verb ? `:${ns.verb}` : ''} @ ${ns.confidence}` : 'none');
const subtaskIn = (view, id) => subtasksOf(view).find((s) => s?.id === id) ?? null;

// What each step must leave behind (beyond "something changed"). A step that
// changes bookkeeping but not its outcome would otherwise pass the
// fingerprint and repeat — an archive the Stop hook keeps refusing, say.
function postcondition(s, before, after) {
  const id = s.subtaskId ?? null;
  const child = id ? after?.children?.[id] : null;
  switch (s.kind) {
    case 'dispatch': {
      const st = subtaskIn(after, id);
      if (st?.status === 'in_progress' && child?.location === 'active') return null;
      return `the dispatch left subtask ${id} ${st?.status ?? 'missing'} with ${child ? `a ${child.location}` : 'no'} engineer workflow`;
    }
    case 'commit': {
      if (!child || child.location !== 'active') return null;
      if (child.awaiting_owner?.gate) return null;
      if (after?.git?.head && after.git.head !== before?.git?.head) return null;
      return `the commit step left subtask ${id}'s workflow active (${child.current_phase}) with no new commit and no owner gate${s.recovery ? ' — the archive the Stop hook should run did not run; its archive_gate line in the worker stream names why' : ''}`;
    }
    case 'done':
    case 'done-no-commit': {
      if (after?.macro?.archived) return null;
      const st = subtaskIn(after, id);
      return st?.status === 'completed' ? null : `/orchestrator:done left subtask ${id} ${st?.status ?? 'missing'}`;
    }
    case 'finalize':
      return after?.macro?.archived ? null : `/orchestrator:finalize left macro ${after?.macro?.id ?? '?'} active`;
    default:
      return null;
  }
}

/**
 * Judge a step that ran. Returns null to continue, or a halt.
 *
 * @param args.step     the step that ran
 * @param args.worker   the worker's result (worker.mjs)
 * @param args.before   the view the step was decided from
 * @param args.after    the view observed after it
 * @param args.oversizePct  the step-oversized threshold (fraction of the window)
 */
export function verifyStep({ step: s, worker: w, before, after, oversizePct }) {
  // Before anything else: the run cannot go on beside what is left.
  if (w.groupTeardown === 'lingering') {
    return halt('worker-failed', `a process in the step's process group (${w.pgid ?? '?'}) is still there after SIGKILL; the run keeps its locks until that group is empty (ps -g ${w.pgid ?? '<pgid>'})`);
  }
  if (w.aborted === 'interrupted') return halt('interrupted', 'the owner interrupted the run');
  if (w.aborted === 'compaction-imminent') return halt('compaction-imminent', 'a PreCompact hook event appeared in the worker stream; the step was aborted');
  if (w.aborted === 'timeout') return halt('worker-failed', `the step exceeded its wall clock (${w.timeoutSec ?? '?'} s) and its process group was killed`);
  if (w.aborted === 'provenance') return halt(w.abortReason ?? 'version-drift', w.abortDetail ?? 'the worker loaded plugins other than the ones this run pinned');
  if (w.aborted) return halt('worker-failed', `the step was aborted (${w.aborted})`);
  if (w.spawnError) return halt('worker-failed', `the worker could not start: ${w.spawnError}`);
  if (!w.lastResult) return halt('worker-failed', `the worker exited ${w.exitCode ?? w.signal ?? '?'} without a result${w.stderrTail ? `: ${w.stderrTail.slice(-200)}` : ''}`);
  if (w.exitCode !== 0 || w.lastResult.is_error === true) {
    return halt('worker-failed', `exit=${w.exitCode ?? w.signal} result=${w.lastResult.subtype ?? 'error'}${w.stderrTail ? ` ${w.stderrTail.slice(-200)}` : ''}`);
  }

  // Owner decision D11: the worker's own report can only stop the run.
  const r = w.report;
  const summary = String(r?.summary ?? '').slice(0, 300);
  if (!r || typeof r !== 'object') return halt('owner-choice', 'the worker returned no step report, so its result cannot be cross-checked');
  if (r.outcome === 'failed') return halt('worker-failed', `the worker reports failure: ${summary}`);
  // A step in a lane answers for its lane: the macro's gate and its own
  // child's, never another lane's (ADR-0067 Decision 6).
  const gates = s.lane ? laneGates(after, s.subtaskId) : stateGates(after);
  if (r.awaiting_owner && !gates.has(r.awaiting_owner)) {
    return halt('owner-choice', `the worker reports ${r.awaiting_owner}, but the state records ${gates.size ? [...gates].join(', ') : 'no owner gate'}: ${summary}`, { subtaskId: s.subtaskId ?? null });
  }
  const child = s.subtaskId ? after?.children?.[s.subtaskId] : null;
  if (r.outcome === 'needs_owner' && !r.awaiting_owner && child?.next_step?.kind !== 'owner-decision') {
    return halt('owner-choice', `the worker reports that it needs the owner, but the state records no owner decision: ${summary}`, { subtaskId: s.subtaskId ?? null });
  }
  if (RUNS_A_VERB.has(s.kind) && child?.location === 'active') {
    const a = child.next_step;
    const b = r.next_step;
    const same = (a === null && b === null)
      || (a && b && a.kind === b.kind && (a.verb ?? null) === (b.verb ?? null) && a.confidence === b.confidence);
    if (r.workflow !== child.workflow_id || !same) {
      return halt('owner-choice', `the worker reports ${r.workflow ?? 'no workflow'} at next step ${nsLabel(b)}, but ${child.workflow_id} records ${nsLabel(a)}: ${summary}`, { subtaskId: s.subtaskId });
    }
  }

  const post = postcondition(s, before, after);
  if (post) return halt('owner-choice', post, { subtaskId: s.subtaskId ?? null });

  // A step in a lane is judged by its lane's fingerprint, the views' `git`
  // being the lane's (ADR-0067 Decision 6); any other by the run-wide one.
  const unchanged = s.lane
    ? laneFingerprint(before, s.subtaskId) === laneFingerprint(after, s.subtaskId)
    : fingerprint(before) === fingerprint(after);
  if (unchanged) {
    return w.denials?.length
      ? halt('permission-denied', `no state changed, and the worker was denied: ${[...new Set(w.denials.map((d) => d.tool))].join(', ')}`, { subtaskId: s.subtaskId ?? null })
      : halt('no-progress', 'the step exited 0 and changed no state', { subtaskId: s.subtaskId ?? null });
  }
  if (typeof w.peakPct === 'number' && typeof oversizePct === 'number' && w.peakPct > oversizePct) {
    return halt('step-oversized', `peak context ${(w.peakPct * 100).toFixed(1)}% exceeded ${(oversizePct * 100).toFixed(0)}%; split the step or the verb`, { subtaskId: s.subtaskId ?? null });
  }
  return null;
}
