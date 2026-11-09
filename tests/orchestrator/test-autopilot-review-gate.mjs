// tests/orchestrator/test-autopilot-review-gate.mjs
//
// C163 A1b (ADR-0063, implementation note of 2026-11-07) — the autopilot's
// review gate: a lane whose latest review outcome is failed, degraded,
// unavailable, malformed or unknown does not reach /engineer:commit (its
// commit, done and recovery steps halt `awaiting-owner:review-outcome`, a gate
// derived from state and never stored); the owner's `--next <verb>` replaces
// the halt with a new review, `--next commit` does not; the owner's
// acceptance of that attempt lets the commit go on, a later review makes it
// stale; the landing report and the halt report name each outcome, say when
// the history is incomplete, and a new outcome at unchanged commits is a
// change. The rule itself is the persona library's (byte copy in
// plugins/orchestrator/scripts/lib/review-attempts.mjs), read through the
// observer's reviewSummary, so these views hold what a real file gives.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRepo } from './fixtures/autopilot-repo.mjs';
import { bySubtask, COMMIT, setup as setupLanes } from './fixtures/autopilot-lanes-run.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const P = await import(resolve(AP, 'policy.mjs'));
const C = await import(resolve(AP, 'codes.mjs'));
const O = await import(resolve(AP, 'observe.mjs'));
const LR = await import(resolve(AP, 'landing-ready.mjs'));
const E = await import(resolve(AP, 'events.mjs'));
const L = await import(resolve(REPO_ROOT, 'plugins/orchestrator/scripts/lib/review-attempts.mjs'));
const ENG_STATE = await import(resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs'));

const { decide, decideLanes, forcedForLanes, parseForcedStep, laneFingerprint, parkFingerprint, compareKept, PARK_FINGERPRINT_VERSION, stepReportProblem, verifyStep } = P;

const MACRO = 'macro-plan-20261001T000000Z-abcdef';
const RUN = 'autopilot-20261001T000000Z-123456';
const ENG_A = 'compose-20261001T000100Z-aaaaaa';
const ENG_B = 'compose-20261001T000200Z-bbbbbb';
const AT = '2026-11-07T00:00:00Z';
const TREE = 'a'.repeat(40);

// ---------------------------------------------------------------------------
// Frontmatter fixtures: the review record as a workflow file holds it.

const closed = (id, outcome, extra = {}) => ({
  id, phase: 'critique', type: 'review', state: 'closed', outcome, run_id: id, recorded_at: AT,
  tree: null, tree_reason: 'no-snapshot',
  ...(outcome === 'skipped' ? { reason: 'local-only' } : {}),
  ...extra,
});
const open = (id) => ({ id, phase: 'critique', type: 'review', state: 'open', run_id: id, registered_at: AT });
// An acceptance that names no `listed` is given as of this record: the last
// attempt listed and the coverage reasons it holds, as review-accept records
// them; one that names it is kept as written.
function fm(attempts, { acceptance = undefined, results = [], coverage = { history_incomplete: false, reasons: [] } } = {}) {
  const out = { ensemble_results: results };
  if (attempts !== null) out.review_attempts = JSON.stringify({ v: 1, attempts, coverage });
  if (acceptance !== undefined) {
    let doc = null;
    try { doc = JSON.parse(acceptance); } catch { /* kept as written */ }
    if (doc && typeof doc === 'object' && doc.v === 1 && !('listed' in doc)) {
      const last = attempts?.at(-1);
      doc = { ...doc, listed: last ? { id: last.id, at: last.recorded_at ?? last.registered_at } : null, gaps: [...coverage.reasons] };
      out.review_acceptance = JSON.stringify(doc);
    } else out.review_acceptance = acceptance;
  }
  return out;
}
const acceptance = (attemptId, extra = {}) => JSON.stringify({ v: 1, attempt_id: attemptId, outcome: 'failed', tree: TREE, accepted_at: AT, ...extra });

// ---------------------------------------------------------------------------
// View fixtures, as tests/orchestrator/test-autopilot-policy.mjs builds them.

function sub(id, status, extra = {}) {
  return { id, label: id, verb: 'compose', profile: 'backend', branch: `feat/${id.toLowerCase()}`, blocked_by: [], status, ...extra };
}
function child(id, over = {}) {
  return {
    location: 'active',
    path: `/r/.agentic-plugins/state/engineer/workflows/${id}.md`,
    relPath: `.agentic-plugins/state/engineer/workflows/${id}.md`,
    workflow_id: id, branch: 'feat/a', current_phase: 'phase-2-presented', terminal_marker: false,
    next_step: { kind: 'commit', verb: null, confidence: 'HIGH' },
    awaiting_owner: null, workflow_type: 'verb-chain', parent_detached: false,
    pending_ensemble: 0, pending_runs: [], ensemble_results: 1, commit_manifest: 1, progress: 3,
    parent_workflow: MACRO, originating_subtask: 'A',
    ...over,
  };
}
function view(over = {}) {
  const subtasks = over.subtasks ?? [sub('A', 'in_progress', { engineer_workflow_id: ENG_A }), sub('B', 'blocked', { blocked_by: ['A'] })];
  return {
    repoRoot: '/r',
    git: { branch: 'feat/a', head: 'h0', porcelain: '', clean: true, detached: false, ...(over.git ?? {}) },
    brief: { disposition: 'lead', leading: { command: '/orchestrator:resume' }, rows: [] },
    briefError: null,
    macro: {
      id: MACRO, path: `/r/.agentic-plugins/state/orchestrator/workflows/${MACRO}.md`,
      relPath: `.agentic-plugins/state/orchestrator/workflows/${MACRO}.md`, archived: false,
      fm: {
        workflow_id: MACRO, current_phase: 'phase-2-presented', terminal_marker: false,
        plan_approval_status: 'approved', plan_approval_plan_hash: 'f'.repeat(64),
        git_baseline: { branch: 'main' }, plan: { subtasks }, host_history: [],
      },
    },
    macroLookupError: null,
    ready: over.ready ?? { ready: null, reason: 'in_progress_or_blocked', readiness: [], approval: { status: 'approved', hash_ok: true } },
    readyError: null,
    children: over.children ?? {},
    foreign: null,
    claims: Object.entries(over.children ?? {}).filter(([, c]) => c.location === 'active')
      .map(([id, c]) => ({ id: c.workflow_id, path: c.path, relPath: c.relPath, originating_subtask: id, branch: c.branch })),
    claimsError: null,
    landing: over.landing ?? {},
  };
}
const ctx = (over = {}) => ({ runId: RUN, macroId: MACRO, forced: null, finalizeAttempted: false, ...over });
const withReview = (frontmatter, over = {}) => view({ children: { A: child(ENG_A, { review: O.reviewSummary(frontmatter), ...over }) } });

const FAILED = fm([closed('review-1', 'passed'), closed('review-2', 'failed', { error_kind: 'peer_timeout', status: 'failed' })]);

// ---------------------------------------------------------------------------

describe('reviewGate — which latest outcome holds the commit back (C163 A1b)', () => {
  it('failed, degraded, unavailable, malformed and unknown hold it; passed, concerns, conflict and skipped do not', () => {
    deepStrictEqual([...L.REVIEW_BLOCKING_OUTCOMES], ['failed', 'degraded', 'unavailable', 'malformed', 'unknown']);
    for (const outcome of ['failed', 'degraded', 'unavailable', 'malformed']) {
      const g = L.reviewGate(fm([closed('r1', 'passed'), closed('r2', outcome)]));
      deepStrictEqual([g.latest.id, g.latest.outcome, g.blocking, g.held], ['r2', outcome, true, true], outcome);
    }
    for (const outcome of ['passed', 'concerns', 'conflict']) {
      const g = L.reviewGate(fm([closed('r1', 'failed'), closed('r2', outcome)]));
      deepStrictEqual([g.latest.id, g.blocking, g.held], ['r2', false, false], outcome);
    }
    // A skip clears no earlier failure (below); after a usable review it holds nothing.
    const skipped = L.reviewGate(fm([closed('r1', 'passed'), closed('r2', 'skipped')]));
    deepStrictEqual([skipped.latest.id, skipped.blocking, skipped.held], ['r2', false, false], 'skipped');
  });

  it('the latest is the last attempt listed, whatever an earlier one was: an open one reads unknown', () => {
    const g = L.reviewGate(fm([closed('r1', 'passed'), open('r2')]));
    deepStrictEqual([g.latest.id, g.latest.outcome, g.held], ['r2', 'unknown', true]);
    strictEqual(L.reviewGate(fm([closed('r1', 'failed'), closed('r2', 'passed')])).held, false, 'a later usable review clears an earlier failure');
  });

  it('a superseded attempt listed last is unknown: its replacement registers after it, so is read as the latest itself', () => {
    const sup = (id, by) => closed(id, 'superseded', { superseded_by: by, tree_reason: 'superseded' });
    const replaced = L.reviewGate(fm([closed('r1', 'passed'), sup('r2', 'r3'), closed('r3', 'failed')]));
    deepStrictEqual([replaced.latest.id, replaced.latest.outcome, replaced.held], ['r3', 'failed', true]);
    const passedReplacement = L.reviewGate(fm([closed('r1', 'failed'), sup('r2', 'r3'), closed('r3', 'passed')]));
    deepStrictEqual([passedReplacement.latest.id, passedReplacement.held], ['r3', false]);
    const missing = L.reviewGate(fm([closed('r1', 'passed'), sup('r2', 'r9')]));
    deepStrictEqual([missing.latest.id, missing.latest.outcome, missing.latest.reason, missing.held], ['r2', 'unknown', 'replacement-missing', true]);
  });

  it('a legacy review row an older writer added after the latest attempt, or one that cannot be ordered, is the latest: unknown', () => {
    const row = (at) => ({ phase: 'critique', ensemble_type: 'review', run_id: 'old-9', verdict: 'agreed', ...(at ? { completed_at: at } : {}) });
    const newer = L.reviewGate(fm([closed('r1', 'passed', { recorded_at: '2026-11-07T00:00:00Z' })], { results: [row('2026-11-07T01:00:00Z')] }));
    deepStrictEqual([newer.latest.id, newer.latest.outcome, newer.latest.legacy, newer.held], ['old-9', 'unknown', true, true]);
    const older = L.reviewGate(fm([closed('r1', 'passed', { recorded_at: '2026-11-07T02:00:00Z' })], { results: [row('2026-11-07T01:00:00Z')] }));
    deepStrictEqual([older.latest.id, older.held], ['r1', false], 'a pre-instrumentation row before the attempt (control)');
    const untimed = L.reviewGate(fm([closed('r1', 'passed', { recorded_at: '2026-11-07T02:00:00Z' })], { results: [row(null)] }));
    deepStrictEqual([untimed.latest.id, untimed.held], ['old-9', true]);
  });

  it('no review at all holds nothing; a legacy review row with no attempt, or a record that cannot be read, is unknown and holds it', () => {
    const none = L.reviewGate({});
    deepStrictEqual([none.latest, none.blocking, none.held], [null, false, false]);
    const legacy = L.reviewGate(fm(null, { results: [{ phase: 'critique', ensemble_type: 'review', run_id: 'old-1', verdict: 'agreed' }] }));
    deepStrictEqual([legacy.latest.id, legacy.latest.outcome, legacy.latest.legacy, legacy.held], ['old-1', 'unknown', true, true]);
    const unreadable = L.reviewGate({ review_attempts: '{not json' });
    deepStrictEqual([unreadable.latest.id, unreadable.latest.outcome, unreadable.held], [null, 'unknown', true]);
  });

  it('an acceptance naming the latest attempt lets it; one naming an earlier attempt is stale; one that cannot be read lets nothing', () => {
    const ok1 = L.reviewGate(fm([closed('r1', 'failed')], { acceptance: acceptance('r1') }));
    deepStrictEqual([ok1.blocking, ok1.acceptance.state, ok1.held], [true, 'matches', false]);
    const stale = L.reviewGate(fm([closed('r1', 'failed'), closed('r2', 'degraded')], { acceptance: acceptance('r1') }));
    deepStrictEqual([stale.acceptance.state, stale.held], ['stale', true]);
    const bad = L.reviewGate(fm([closed('r1', 'failed')], { acceptance: '{"v":1}' }));
    deepStrictEqual([bad.acceptance.state, bad.held], ['unreadable', true]);
  });

  // Critique MAJOR 1 (refine of 2026-11-07): an acceptance is bound to the
  // outcome it was given for, not to the attempt id alone.
  it('an acceptance given while the attempt read one outcome is stale once it reads another (open, then failed)', () => {
    const whileOpen = acceptance('r1', { outcome: 'unknown' });
    const stillOpen = L.reviewGate(fm([open('r1')], { acceptance: whileOpen }));
    deepStrictEqual([stillOpen.acceptance.state, stillOpen.held], ['matches', false], 'the outcome it was given for (control)');
    const settled = L.reviewGate(fm([closed('r1', 'failed', { error_kind: 'peer_timeout' })], { acceptance: whileOpen }));
    deepStrictEqual([settled.latest.outcome, settled.acceptance.state, settled.acceptance.reason, settled.held], ['failed', 'stale', 'outcome-changed', true]);
    const otherOutcome = L.reviewGate(fm([closed('r1', 'failed')], { acceptance: acceptance('r1', { outcome: 'degraded' }) }));
    deepStrictEqual([otherOutcome.acceptance.state, otherOutcome.acceptance.reason, otherOutcome.held], ['stale', 'outcome-changed', true], 'another outcome alone');
    const otherKind = L.reviewGate(fm([closed('r1', 'failed', { error_kind: 'peer_timeout' })], { acceptance: acceptance('r1', { error_kind: 'peer_exit_nonzero' }) }));
    deepStrictEqual([otherKind.acceptance.state, otherKind.held], ['stale', true], 'another error kind');
    const otherReason = L.reviewGate(fm([closed('r1', 'degraded', { reason: 'answer-empty' })], { acceptance: acceptance('r1', { outcome: 'degraded', reason: 'answer-unreadable' }) }));
    deepStrictEqual([otherReason.acceptance.state, otherReason.held], ['stale', true], 'another reason');
    const later = L.reviewGate(fm([closed('r1', 'failed'), closed('r2', 'failed')], { acceptance: acceptance('r1') }));
    deepStrictEqual([later.acceptance.state, later.acceptance.reason], ['stale', 'other-attempt']);
    const d = decide(withReview(fm([closed('r1', 'failed', { error_kind: 'peer_timeout' })], { acceptance: whileOpen })), ctx());
    strictEqual(d.reason, 'awaiting-owner:review-outcome');
    match(d.detail, /the owner accepted r1 when it read unknown, and it reads another outcome now/);
  });

  // Critique of 2026-11-07, MAJOR 2 (the refine's own MAJOR 3 fix followed
  // the link wherever it pointed): a link back to an earlier attempt is never
  // followed, so it revives neither a pass nor a stale acceptance.
  it('a supersession link back to an earlier attempt revives nothing: neither a pass, a failure listed before a pass, nor a stale acceptance', () => {
    const sup = (id, by) => closed(id, 'superseded', { superseded_by: by, tree_reason: 'superseded' });
    const pass = L.reviewGate(fm([closed('r1', 'passed'), sup('r2', 'r1')]));
    deepStrictEqual([pass.latest.id, pass.latest.outcome, pass.latest.reason, pass.held], ['r2', 'unknown', 'replacement-backward', true], 'a pass listed before');
    const back = L.reviewGate(fm([closed('r1', 'failed'), closed('r2', 'passed'), sup('r3', 'r1')]));
    deepStrictEqual([back.latest.id, back.latest.outcome, back.latest.reason, back.held], ['r3', 'unknown', 'replacement-backward', true]);
    // The owner accepted r1; a later registration (r2) made that stale, and a
    // link from r2 back to r1 does not make it match again.
    const revived = L.reviewGate(fm([closed('r1', 'failed'), sup('r2', 'r1')], { acceptance: acceptance('r1') }));
    deepStrictEqual([revived.latest.id, revived.acceptance.state, revived.acceptance.reason, revived.held], ['r2', 'stale', 'other-attempt', true]);
    const forward = L.reviewGate(fm([closed('r1', 'failed'), sup('r2', 'r3'), closed('r3', 'failed')], { acceptance: acceptance('r3') }));
    deepStrictEqual([forward.latest.id, forward.acceptance.state, forward.held], ['r3', 'matches', false], 'the replacement listed after it (control)');
  });

  // Critique MAJOR 4: times compare as instants.
  it('a legacy row is ordered against the latest attempt by instant, whatever the precision; an unparseable time cannot be ordered', () => {
    const row = (at) => ({ phase: 'critique', ensemble_type: 'review', run_id: 'old-9', verdict: 'agreed', completed_at: at });
    const finer = L.reviewGate(fm([closed('r1', 'passed', { recorded_at: '2026-11-07T00:00:00Z' })], { results: [row('2026-11-07T00:00:00.500Z')] }));
    deepStrictEqual([finer.latest.id, finer.latest.outcome, finer.held], ['old-9', 'unknown', true], 'a row half a second after the attempt');
    const coarser = L.reviewGate(fm([closed('r1', 'passed', { recorded_at: '2026-11-07T00:00:00.500Z' })], { results: [row('2026-11-07T00:00:00Z')] }));
    deepStrictEqual([coarser.latest.id, coarser.held], ['r1', false], 'a row half a second before it (control)');
    const garbled = L.reviewGate(fm([closed('r1', 'passed', { recorded_at: '2026-11-07T02:00:00Z' })], { results: [row('yesterday')] }));
    deepStrictEqual([garbled.latest.id, garbled.held], ['old-9', true]);
    // Two legacy rows: the newer instant wins, whatever its precision.
    const two = L.reviewGate(fm(null, { results: [
      { phase: 'critique', ensemble_type: 'review', run_id: 'old-b', verdict: 'agreed', completed_at: '2026-11-07T00:00:00.500Z' },
      { phase: 'critique', ensemble_type: 'review', run_id: 'old-a', verdict: 'agreed', completed_at: '2026-11-07T00:00:00Z' },
    ] }));
    strictEqual(two.latest.id, 'old-b');
  });

  // Critique MAJOR 5: a review that never ran, with no recorded choice the
  // gate can trust, holds the commit as unknown does.
  it('skipped with no reason, an unspecified one or owner-skip holds the commit; local-only and privacy-gate do not', () => {
    deepStrictEqual([...L.REVIEW_BLOCKING_SKIP_REASONS], ['unspecified', 'owner-skip']);
    for (const reason of ['unspecified', 'owner-skip']) {
      const g = L.reviewGate(fm([closed('r1', 'passed'), closed('r2', 'skipped', { reason })]));
      deepStrictEqual([g.latest.outcome, g.latest.reason, g.blocking, g.held], ['skipped', reason, true, true], reason);
      strictEqual(decide(withReview(fm([closed('r1', 'skipped', { reason })])), ctx()).reason, 'awaiting-owner:review-outcome', reason);
      const ok2 = L.reviewGate(fm([closed('r1', 'skipped', { reason })], { acceptance: acceptance('r1', { outcome: 'skipped', reason }) }));
      strictEqual(ok2.held, false, `${reason}: the owner's acceptance lets it`);
    }
    for (const reason of ['local-only', 'privacy-gate']) {
      const g = L.reviewGate(fm([closed('r1', 'passed'), closed('r2', 'skipped', { reason })]));
      deepStrictEqual([g.latest.id, g.blocking, g.held], ['r2', false, false], reason);
    }
    strictEqual(L.reviewOutcomeBlocks({ outcome: 'skipped' }), true, 'no reason reads unspecified');
  });

  // Critique of 2026-11-07, MAJOR 3: the reason is the worker's claim, which
  // settle never checks, so a skip clears nothing (conservative until A2).
  it('a review that never ran clears no earlier outcome that holds the commit: the latest that ran is read in its place', () => {
    for (const reason of ['local-only', 'privacy-gate']) {
      const g = L.reviewGate(fm([closed('r1', 'failed', { error_kind: 'peer_timeout' }), closed('r2', 'skipped', { reason })]));
      deepStrictEqual([g.latest.id, g.latest.outcome, g.latest.later_skip, g.blocking, g.held], ['r1', 'failed', 'r2', true, true], reason);
      match(L.latestOutcomeText(g), /^r1 \(critique review\): failed, peer_timeout \(the later review r2 was skipped, which clears nothing\)$/);
      const d = decide(withReview(fm([closed('r1', 'failed'), closed('r2', 'skipped', { reason })])), ctx());
      strictEqual(d.reason, 'awaiting-owner:review-outcome', reason);
    }
    // Several skips, an earlier unspecified one, a superseded attempt between, and an open one.
    const many = L.reviewGate(fm([closed('r1', 'unavailable'), closed('r2', 'skipped'), closed('r3', 'skipped', { reason: 'privacy-gate' })]));
    deepStrictEqual([many.latest.id, many.held], ['r1', true], 'over two skips');
    const unspecified = L.reviewGate(fm([closed('r1', 'passed'), closed('r2', 'skipped', { reason: 'unspecified' }), closed('r3', 'skipped')]));
    deepStrictEqual([unspecified.latest.id, unspecified.latest.reason, unspecified.held], ['r2', 'unspecified', true], 'a skip that holds, before a usable one');
    const between = L.reviewGate(fm([closed('r1', 'degraded'), closed('r2', 'superseded', { superseded_by: 'r3', tree_reason: 'superseded' }), closed('r3', 'skipped')]));
    deepStrictEqual([between.latest.id, between.held], ['r1', true], 'a superseded attempt is passed over');
    const stillOpen = L.reviewGate(fm([open('r1'), closed('r2', 'skipped')]));
    deepStrictEqual([stillOpen.latest.id, stillOpen.latest.outcome, stillOpen.held], ['r1', 'unknown', true], 'an open attempt before the skip');
    // A legacy row (unknown) is ordered against the attempt that ran, never the skip.
    const row = { phase: 'critique', ensemble_type: 'review', run_id: 'old-9', verdict: 'agreed', completed_at: '2026-11-07T01:00:00Z' };
    const legacy = L.reviewGate(fm([closed('r1', 'passed', { recorded_at: '2026-11-07T00:00:00Z' }), closed('r2', 'skipped', { recorded_at: '2026-11-07T02:00:00Z' })], { results: [row] }));
    deepStrictEqual([legacy.latest.id, legacy.held], ['old-9', true], 'a legacy row between the pass and the skip');
    // The owner accepts the attempt read; a new review that runs clears it.
    const accepted = L.reviewGate(fm([closed('r1', 'failed'), closed('r2', 'skipped')], { acceptance: acceptance('r1') }));
    deepStrictEqual([accepted.acceptance.state, accepted.held], ['matches', false]);
    const after = L.reviewGate(fm([closed('r1', 'failed'), closed('r2', 'skipped'), closed('r3', 'passed')]));
    deepStrictEqual([after.latest.id, after.held], ['r3', false], 'a later review that ran (control)');
    const firstSkip = L.reviewGate(fm([closed('r1', 'skipped')]));
    deepStrictEqual([firstSkip.latest.id, firstSkip.held], ['r1', false], 'a skip with no review before it keeps today\'s rule');
  });

  // Critique of 2026-11-07, fourth pass, MAJOR 2: the lookback starts from a
  // skip that holds as well, and passes over one on its way, so accepting a
  // skip never clears a failure it does not name.
  it('a skip that holds hides no failure behind it, and only the failure can be accepted', () => {
    const r1 = closed('r1', 'failed', { error_kind: 'peer_timeout' });
    for (const reason of ['owner-skip', 'unspecified']) {
      const r2 = closed('r2', 'skipped', { reason });
      const g = L.reviewGate(fm([r1, r2]));
      deepStrictEqual([g.latest.id, g.latest.outcome, g.latest.error_kind, g.latest.later_skip, g.held], ['r1', 'failed', 'peer_timeout', 'r2', true], reason);
      match(L.latestOutcomeText(g), /^r1 \(critique review\): failed, peer_timeout \(the later review r2 was skipped, which clears nothing\)$/);
      strictEqual(decide(withReview(fm([r1, r2])), ctx()).reason, 'awaiting-owner:review-outcome', reason);
      const ofSkip = L.reviewGate(fm([r1, r2], { acceptance: acceptance('r2', { outcome: 'skipped', reason }) }));
      deepStrictEqual([ofSkip.acceptance.state, ofSkip.held], ['stale', true], `${reason}: accepting the skip clears nothing`);
      const ofFailure = L.reviewGate(fm([r1, r2], { acceptance: acceptance('r1', { error_kind: 'peer_timeout' }) }));
      deepStrictEqual([ofFailure.acceptance.state, ofFailure.held], ['matches', false], `${reason}: accepting the failure`);
    }
    const hold = closed('r2', 'skipped', { reason: 'owner-skip' });
    const middle = L.reviewGate(fm([r1, hold, closed('r3', 'skipped')]));
    deepStrictEqual([middle.latest.id, middle.latest.outcome, middle.latest.later_skip, middle.held], ['r1', 'failed', 'r3', true], 'past a skip that holds, in the middle');
    // Nothing that holds behind it: the skip that holds is what is read.
    const afterPass = L.reviewGate(fm([closed('r1', 'passed'), hold, closed('r3', 'skipped')]));
    deepStrictEqual([afterPass.latest.id, afterPass.latest.reason, afterPass.latest.later_skip, afterPass.held], ['r2', 'owner-skip', 'r3', true], 'a usable skip after one that holds');
    const noRun = L.reviewGate(fm([hold, closed('r3', 'skipped')]));
    deepStrictEqual([noRun.latest.id, noRun.latest.later_skip, noRun.held], ['r2', 'r3', true], 'with no review before them');
    const lastHolds = L.reviewGate(fm([closed('r1', 'passed'), closed('r2', 'skipped'), closed('r3', 'skipped', { reason: 'owner-skip' })]));
    deepStrictEqual([lastHolds.latest.id, lastHolds.latest.later_skip, lastHolds.held], ['r3', undefined, true], 'the last skip holds: no later skip to name');
    const pastPass = L.reviewGate(fm([r1, closed('r2', 'passed'), closed('r3', 'skipped', { reason: 'owner-skip' })]));
    deepStrictEqual([pastPass.latest.id, pastPass.latest.reason, pastPass.held], ['r3', 'owner-skip', true], 'a review that ran after the failure ends the lookback');
    const answered = L.reviewGate(fm([closed('r1', 'skipped', { reason: 'owner-skip' }), closed('r2', 'passed'), closed('r3', 'skipped')]));
    deepStrictEqual([answered.latest.id, answered.held], ['r3', false], 'a review that ran answers a skip that holds before it');
    const truncated = L.reviewGate(fm([hold], { coverage: { history_incomplete: true, reasons: ['truncation'], truncated: 1 } }));
    deepStrictEqual([truncated.latest.id, truncated.latest.outcome, truncated.latest.reason, truncated.held], ['r2', 'unknown', 'history-truncated', true], 'what ran before cannot be told');
    const usable = L.reviewGate(fm([closed('r1', 'passed'), closed('r2', 'skipped'), closed('r3', 'skipped', { reason: 'privacy-gate' })]));
    deepStrictEqual([usable.latest.id, usable.latest.later_skip, usable.held], ['r3', undefined, false], 'usable skips after a pass (control)');
  });

  // Critique of 2026-11-07, fourth pass, MAJOR 5: when every older attempt is
  // still open, the attempt just recorded is the first closed one.
  it('compaction never drops the last attempt listed, the one the gate reads', () => {
    let raw;
    for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) raw = L.applyReviewAttempt(raw, open(id)).raw;
    const maxBytes = Buffer.byteLength(raw, 'utf8');
    raw = L.applyReviewAttempt(raw, closed('r6', 'failed', { error_kind: 'peer_timeout' }), { maxBytes }).raw;
    const read = () => L.reviewGate({ ensemble_results: [], review_attempts: raw });
    const just = read();
    deepStrictEqual([just.latest.id, just.latest.outcome, just.held, just.coverage.reasons], ['r6', 'failed', true, ['truncation']]);
    deepStrictEqual([just.outcomes.some((a) => a.id === 'r1'), just.outcomes.some((a) => a.id === 'r5')], [false, true], 'the oldest open attempt went instead');
    // An attempt left open then passes, in place: r6 is still the last listed.
    raw = L.applyReviewAttempt(raw, closed('r5', 'passed'), { maxBytes }).raw;
    deepStrictEqual([read().latest.id, read().latest.outcome, read().held], ['r6', 'failed', true]);
    // One attempt alone is never dropped, however little fits.
    const alone = L.applyReviewAttempt(undefined, closed('r1', 'failed'), { maxBytes: 1 });
    strictEqual(L.reviewGate({ ensemble_results: [], review_attempts: alone.raw }).latest.id, 'r1');
  });

  // Refine-verify of 2026-11-07, F1 and F3: the lookback a skip makes reads a
  // superseded attempt as latestAttempt does, and what truncation dropped as
  // unknown.
  it('a skip clears no unresolved supersession, and none of the history truncation dropped', () => {
    const sup = (id, by) => closed(id, 'superseded', { superseded_by: by, tree_reason: 'superseded' });
    const missing = L.reviewGate(fm([closed('r1', 'passed'), sup('r2', 'r9'), closed('r3', 'skipped')]));
    deepStrictEqual([missing.latest.id, missing.latest.outcome, missing.latest.reason, missing.latest.later_skip, missing.held], ['r2', 'unknown', 'replacement-missing', 'r3', true]);
    const backward = L.reviewGate(fm([closed('r1', 'passed'), sup('r2', 'r1'), closed('r3', 'skipped')]));
    deepStrictEqual([backward.latest.id, backward.latest.reason, backward.held], ['r2', 'replacement-backward', true]);
    const forward = L.reviewGate(fm([closed('r1', 'passed'), sup('r2', 'r3'), closed('r3', 'skipped')]));
    deepStrictEqual([forward.latest.id, forward.held], ['r3', false], 'replaced by the skip itself (control)');
    const truncated = L.reviewGate(fm([closed('r7', 'skipped'), closed('r8', 'skipped')], { coverage: { history_incomplete: true, reasons: ['truncation'], truncated: 1 } }));
    deepStrictEqual([truncated.latest.id, truncated.latest.outcome, truncated.latest.reason, truncated.held], ['r8', 'unknown', 'history-truncated', true]);
    const kept = L.reviewGate(fm([closed('r6', 'passed'), closed('r7', 'skipped')], { coverage: { history_incomplete: true, reasons: ['truncation'], truncated: 1 } }));
    deepStrictEqual([kept.latest.id, kept.held], ['r7', false], 'a review that ran is still listed: what was dropped is older (control)');
  });

  // Refine-verify of 2026-11-07, F1 and F2: an acceptance a later
  // registration or a gap found since made stale never matches again.
  it('an acceptance is bound to the record the owner saw: a later registration, an id recorded again after compaction, or a gap found since keeps it stale', () => {
    const acc = acceptance('r1', { outcome: 'unavailable', listed: { id: 'r1', at: AT }, gaps: [] });
    const asSeen = L.reviewGate(fm([closed('r1', 'unavailable')], { acceptance: acc }));
    deepStrictEqual([asSeen.acceptance.state, asSeen.held], ['matches', false], 'the record as the owner saw it (control)');
    // A later attempt registered and superseded, then a skip: the lookback reads r1, but not as the owner saw it.
    const sup = closed('r2', 'superseded', { superseded_by: 'r3', tree_reason: 'superseded' });
    const later = L.reviewGate(fm([closed('r1', 'unavailable'), sup, closed('r3', 'skipped')], { acceptance: acc }));
    deepStrictEqual([later.latest.id, later.acceptance.state, later.acceptance.reason, later.held], ['r1', 'stale', 'other-attempt', true]);
    // r1 dropped by compaction and its id recorded again: listed with a new time.
    const replayed = L.reviewGate(fm([closed('r1', 'unavailable', { recorded_at: '2026-11-07T05:00:00Z' })], { acceptance: acc, coverage: { history_incomplete: true, reasons: ['truncation'], truncated: 1 } }));
    deepStrictEqual([replayed.acceptance.state, replayed.held], ['stale', true]);
    const replayedSameGaps = L.reviewGate(fm([closed('r1', 'unavailable', { recorded_at: '2026-11-07T05:00:00Z' })], { acceptance: acc }));
    deepStrictEqual([replayedSameGaps.acceptance.reason, replayedSameGaps.held], ['other-attempt', true], 'the new time alone');
    // A gap found since (a newer legacy row an older writer added, then pruned).
    const gap = L.reviewGate(fm([closed('r1', 'unavailable')], { acceptance: acc, coverage: { history_incomplete: true, reasons: ['pruned-unseen'] } }));
    deepStrictEqual([gap.acceptance.state, gap.acceptance.reason, gap.held], ['stale', 'history-changed', true]);
    match(decide(withReview(fm([closed('r1', 'unavailable')], { acceptance: acc, coverage: { history_incomplete: true, reasons: ['pruned-unseen'] } })), ctx()).detail, /the owner accepted r1, and a gap in the review history was found since/);
    const known = L.reviewGate(fm([closed('r1', 'unavailable')], { acceptance: acceptance('r1', { outcome: 'unavailable', listed: { id: 'r1', at: AT }, gaps: ['pre-instrumentation'] }), coverage: { history_incomplete: true, reasons: ['pre-instrumentation'] } }));
    strictEqual(known.acceptance.state, 'matches', 'a gap the owner saw (control)');
    // An acceptance that does not say what it saw cannot be read, and lets nothing.
    const unbound = { ...fm([closed('r1', 'unavailable')]), review_acceptance: JSON.stringify({ v: 1, attempt_id: 'r1', outcome: 'unavailable', tree: TREE, accepted_at: AT }) };
    deepStrictEqual([L.reviewGate(unbound).acceptance.state, L.reviewGate(unbound).held], ['unreadable', true]);
  });

  it('the derived gate is the one codes.mjs adds, and a stored gate list never holds it', () => {
    strictEqual(L.REVIEW_OUTCOME_GATE, 'review-outcome');
    deepStrictEqual([...C.DERIVED_OWNER_GATES], [L.REVIEW_OUTCOME_GATE]);
    ok(C.OWNER_GATES.includes('review-outcome'));
    ok(!C.STORED_OWNER_GATES.includes('review-outcome'));
  });
});

describe('decide — the review gate holds every way to the commit', () => {
  it('a commit step over a failed review halts awaiting-owner:review-outcome, naming the attempt, its error kind and both ways on', () => {
    const d = decide(withReview(FAILED), ctx());
    deepStrictEqual([d.outcome, d.reason, d.subtaskId], ['halt', 'awaiting-owner:review-outcome', 'A']);
    match(d.detail, /review-2 \(critique review\): failed, peer_timeout/);
    match(d.detail, /Run the review again \(relaunch with `--next \/engineer:critique` or, in a run with lanes, `--lane A --next \/engineer:critique`; a new outcome replaces it\)/);
    match(d.detail, /state\.mjs review-accept --workflow-path \/r\/\.agentic-plugins\/state\/engineer\/workflows\/compose-20261001T000100Z-aaaaaa\.md --attempt-id review-2 --note-file <file>/);
    strictEqual(d.pointer, `.agentic-plugins/state/engineer/workflows/${ENG_A}.md#review_attempts`);
    deepStrictEqual(d.review.outcomes.map((o) => [o.id, o.outcome]), [['review-1', 'passed'], ['review-2', 'failed']]);
    strictEqual(d.review.held, true);
  });

  it('each blocking outcome class halts the commit; each usable one lets it', () => {
    for (const outcome of ['failed', 'degraded', 'unavailable', 'malformed']) {
      strictEqual(decide(withReview(fm([closed('r1', outcome)])), ctx()).reason, 'awaiting-owner:review-outcome', outcome);
    }
    strictEqual(decide(withReview(fm([open('r1')])), ctx()).reason, 'awaiting-owner:review-outcome', 'unknown (open)');
    for (const outcome of ['passed', 'concerns', 'skipped']) {
      const d = decide(withReview(fm([closed('r1', outcome)])), ctx());
      deepStrictEqual([d.outcome, d.step?.kind], ['step', 'commit'], outcome);
    }
    const none = decide(withReview({}), ctx());
    deepStrictEqual([none.outcome, none.step?.kind], ['step', 'commit'], 'no review at all');
  });

  it('the done step and the recovery of a commit begun are held too', () => {
    strictEqual(decide(withReview(FAILED, { next_step: { kind: 'done', verb: null, confidence: 'HIGH' } }), ctx()).reason, 'awaiting-owner:review-outcome');
    strictEqual(decide(withReview(FAILED, { current_phase: 'phase-7-commit' }), ctx()).reason, 'awaiting-owner:review-outcome');
    const recovered = decide(withReview(fm([closed('r1', 'passed')]), { current_phase: 'phase-7-commit' }), ctx());
    deepStrictEqual([recovered.step?.kind, recovered.step?.recovery], ['commit', true], 'a usable review recovers (control)');
    // Each is a judgment halt, so the owner's new review replaces it.
    for (const over of [{ next_step: { kind: 'done', verb: null, confidence: 'HIGH' } }, { current_phase: 'phase-7-commit' }]) {
      const replaced = decide(withReview(FAILED, over), ctx({ forced: parseForcedStep('/engineer:critique') }));
      deepStrictEqual([replaced.step?.kind, replaced.step?.verb], ['verb', 'critique'], JSON.stringify(over));
    }
  });

  it('a verb next step is not held: the lane can review again', () => {
    const d = decide(withReview(FAILED, { next_step: { kind: 'verb', verb: 'critique', confidence: 'HIGH' } }), ctx());
    deepStrictEqual([d.step?.kind, d.step?.verb], ['verb', 'critique']);
  });

  it("the owner's --next <verb> replaces the halt; --next commit does not", () => {
    const viaVerb = decide(withReview(FAILED), ctx({ forced: parseForcedStep('/engineer:critique') }));
    deepStrictEqual([viaVerb.step?.kind, viaVerb.step?.verb, viaVerb.step?.forced], ['verb', 'critique', true]);
    const viaCommit = decide(withReview(FAILED), ctx({ forced: parseForcedStep('/engineer:commit') }));
    deepStrictEqual([viaCommit.outcome, viaCommit.reason], ['halt', 'owner-choice']);
    match(viaCommit.detail, /--next does not apply: subtask A: its latest review outcome holds the commit back: review-2/);
    // A commit forced while the next step is a verb is refused as well.
    const early = decide(withReview(FAILED, { next_step: { kind: 'verb', verb: 'refine', confidence: 'HIGH' } }), ctx({ forced: parseForcedStep('/engineer:commit') }));
    match(early.detail, /--next does not apply: subtask A: its latest review outcome holds the commit back/);
  });

  it("resolution, restart and invalidation: the owner's acceptance lets the relaunched run commit; a later review makes it stale", () => {
    // The owner accepts review-2; the relaunch decides from a fresh look.
    const accepted = fm([closed('review-1', 'passed'), closed('review-2', 'failed', { error_kind: 'peer_timeout' })], { acceptance: acceptance('review-2', { error_kind: 'peer_timeout' }) });
    const d = decide(withReview(accepted), ctx());
    deepStrictEqual([d.outcome, d.step?.kind], ['step', 'commit']);
    // A forced commit is let too, once accepted.
    strictEqual(decide(withReview(accepted), ctx({ forced: parseForcedStep('/engineer:commit') })).step?.kind, 'commit');
    // A later review that fails again replaces the attempt the owner accepted.
    const later = fm([closed('review-2', 'failed'), closed('review-3', 'unavailable', { error_kind: 'peer_cli_not_found' })], { acceptance: acceptance('review-2') });
    const again = decide(withReview(later), ctx());
    strictEqual(again.reason, 'awaiting-owner:review-outcome');
    match(again.detail, /review-3 \(critique review\): unavailable, peer_cli_not_found; the owner's acceptance names review-2, which a later review replaced/);
  });

  // Critique of 2026-11-07, MAJOR 4: the accept command is the owner's only
  // way on but a new review; a path that needs quoting is quoted, not dropped.
  it('a workflow path with a space, a non-ASCII character or a quote is quoted into the accept command, never dropped', () => {
    const cases = [
      ['/Users/x/My Projects/r/.agentic-plugins/state/engineer/workflows/c.md', "'/Users/x/My Projects/r/.agentic-plugins/state/engineer/workflows/c.md'"],
      ['/r/프로젝트/.agentic-plugins/state/engineer/workflows/c.md', "'/r/프로젝트/.agentic-plugins/state/engineer/workflows/c.md'"],
      ["/r/it's/c.md", "'/r/it'\\''s/c.md'"],
    ];
    for (const [path, word] of cases) {
      const d = decide(withReview(FAILED, { path }), ctx());
      strictEqual(d.reason, 'awaiting-owner:review-outcome', path);
      ok(d.detail.includes(`review-accept --workflow-path ${word} --attempt-id review-2 --note-file <file>`), `${path}: ${d.detail}`);
      ok(!/names no attempt that can be accepted/.test(d.detail), path);
    }
    // A path no line can print still names the attempt and the command.
    const unprintable = decide(withReview(FAILED, { path: '/r/a\nb.md' }), ctx());
    match(unprintable.detail, /review-accept --attempt-id review-2 with --workflow-path naming the subtask's workflow file \(its path cannot be printed here\)/);
    ok(!unprintable.detail.includes('\n'), 'no line break in the halt');
  });

  // Critique of 2026-11-07, third pass, MAJOR 3: every way on the halt prints
  // is one the command it names takes.
  it('the --next the halt prints parses, and a run with lanes takes the --lane it prints', () => {
    const { detail } = decide(withReview(FAILED), ctx());
    const printed = [...detail.matchAll(/--next ([^\s`]+)/g)].map((m) => m[1]);
    ok(printed.length >= 2, detail);
    for (const step of printed) deepStrictEqual(parseForcedStep(step), { kind: 'verb', verb: 'critique' }, step);
    const lane = /--lane (\S+) --next/.exec(detail)?.[1];
    strictEqual(lane, 'A', detail);
    const v = view({ subtasks: [sub('A', 'in_progress', { engineer_workflow_id: ENG_A }), sub('B', 'in_progress', { engineer_workflow_id: ENG_B })], children: {
      A: child(ENG_A, { review: O.reviewSummary(FAILED) }), B: child(ENG_B, { branch: 'feat/b', originating_subtask: 'B' }),
    } });
    deepStrictEqual(forcedForLanes([{ lane, step: parseForcedStep(printed[0]) }], v).forced?.get('A')?.verb, 'critique');
    // A subtask id its alphabet refuses is not printed into the command.
    match(decide(withReview(FAILED, { originating_subtask: 'a b' }), ctx()).detail, /--lane <subtask> --next/);
  });

  it('a record this reader cannot use offers neither a new review nor an acceptance: only a repair, or an upgrade', () => {
    const cases = [
      [{ review_attempts: '{not json' }, /the review record cannot be read, so neither a new review nor an acceptance can be recorded over it: repair the workflow file's review_attempts by hand/],
      [{ review_attempts: JSON.stringify({ v: 99, attempts: [] }) }, /the review record was written by a later version than this one reads, so neither a new review nor an acceptance can be recorded over it: upgrade the plugins/],
    ];
    for (const [f, text] of cases) {
      const d = decide(withReview(f), ctx());
      strictEqual(d.reason, 'awaiting-owner:review-outcome');
      match(d.detail, text);
      ok(!/Run the review again|review-accept|--next/.test(d.detail), d.detail);
    }
  });

  it('an attempt still open offers a new review, never the acceptance review-accept refuses', () => {
    const d = decide(withReview(fm([closed('r1', 'failed'), open('r2')])), ctx());
    strictEqual(d.reason, 'awaiting-owner:review-outcome');
    match(d.detail, /Run the review again .*; r2 is still open, so it cannot be accepted until its run is settled/);
    ok(!/review-accept/.test(d.detail), d.detail);
    // A closed attempt takes it (control).
    match(decide(withReview(FAILED), ctx()).detail, /review-accept --workflow-path/);
  });

  it('the history found incomplete is said in the halt', () => {
    const f = fm([closed('r1', 'failed')], { coverage: { history_incomplete: true, reasons: ['pre-instrumentation'] } });
    match(decide(withReview(f), ctx()).detail, /the review history is incomplete: pre-instrumentation/);
  });
});

describe('lanes — the review gate is a lane halt, and an acceptance picks a parked lane up', () => {
  const approved = { status: 'approved', hash_ok: true };
  const two = () => [sub('A', 'in_progress', { engineer_workflow_id: ENG_A }), sub('B', 'in_progress', { engineer_workflow_id: ENG_B })];
  const lanes = (a, b = child(ENG_B, { branch: 'feat/b', originating_subtask: 'B', next_step: { kind: 'verb', verb: 'critique', confidence: 'HIGH' } })) => view({
    subtasks: two(), ready: { ready: null, reason: 'in_progress_or_blocked', readiness: [], approval: approved }, children: { A: a, B: b },
  });

  it('a held lane halts on its own; the other lane steps', () => {
    const d = decideLanes(lanes(child(ENG_A, { review: O.reviewSummary(FAILED) })), { lanes: new Map(), started: new Set(), inFlight: new Set(), forced: new Map() });
    deepStrictEqual(d.laneHalts.map((h) => [h.subtaskId, h.reason]), [['A', 'awaiting-owner:review-outcome']]);
    deepStrictEqual(d.laneSteps.map((s) => [s.subtaskId, s.kind]), [['B', 'verb']]);
  });

  it('--lane A /engineer:commit is refused while the lane is held; --lane A /engineer:critique is taken', () => {
    const v = lanes(child(ENG_A, { review: O.reviewSummary(FAILED) }));
    const refused = forcedForLanes([{ lane: 'A', step: parseForcedStep('/engineer:commit') }], v);
    match(refused.halt?.detail ?? '', /--next does not apply: subtask A: its latest review outcome holds the commit back/);
    const taken = forcedForLanes([{ lane: 'A', step: parseForcedStep('/engineer:critique') }], v);
    deepStrictEqual(taken.forced?.get('A'), { kind: 'verb', verb: 'critique', subtaskId: 'A', branch: 'feat/a' });
  });

  it("the owner's acceptance, a re-acceptance for another tree and a new outcome each move a held lane's fingerprint, so a parked lane is reconsidered", () => {
    const at = (f) => lanes(child(ENG_A, { review: O.reviewSummary(f) }));
    const changed = (a, b) => compareKept(
      { fingerprint_version: PARK_FINGERPRINT_VERSION, form: 'lane', fingerprint: parkFingerprint(a, 'A', { form: 'lane' }) },
      { fingerprint: parkFingerprint(b, 'A', { form: 'lane' }), form: 'lane' },
    );
    const failed = [closed('review-1', 'passed'), closed('review-2', 'failed')];
    strictEqual(changed(at(fm(failed)), at(fm(failed))), 'unchanged', 'the same record (control)');
    strictEqual(changed(at(fm(failed)), at(fm(failed, { acceptance: acceptance('review-2') }))), 'changed', 'an acceptance');
    strictEqual(changed(at(fm(failed, { acceptance: acceptance('review-2') })), at(fm(failed, { acceptance: acceptance('review-2', { tree: 'b'.repeat(40) }) }))), 'changed', 'a re-acceptance for another tree');
    strictEqual(changed(at(fm(failed)), at(fm([...failed, closed('review-3', 'degraded')]))), 'changed', 'a new outcome');
    // A skip after the failure clears nothing, so it leaves the hold, and the park, as they were.
    strictEqual(changed(at(fm(failed)), at(fm([...failed, closed('review-3', 'skipped')]))), 'unchanged', 'a skip');
  });

  // Critique MAJOR 2: the review facts changed parkFingerprint's input, so
  // its version moved with them.
  it('a park kept before the review facts (fingerprint version 3) is never compared, so it does not resume by itself', () => {
    strictEqual(PARK_FINGERPRINT_VERSION, 4);
    const held = lanes(child(ENG_A, { review: O.reviewSummary(FAILED) }));
    const plain = lanes(child(ENG_A));
    // A park an earlier release kept on the same lane, before it read a review record.
    const kept = { fingerprint_version: 3, form: 'lane', fingerprint: parkFingerprint(plain, 'A', { form: 'lane' }) };
    strictEqual(compareKept(kept, { fingerprint: parkFingerprint(held, 'A', { form: 'lane' }), form: 'lane' }), 'incomparable');
    strictEqual(compareKept({ ...kept, fingerprint_version: PARK_FINGERPRINT_VERSION }, { fingerprint: parkFingerprint(held, 'A', { form: 'lane' }), form: 'lane' }), 'changed', 'compared at this version, the review facts differ (control)');
  });

  // Refine-verify MAJOR (refine of 2026-11-07): the acceptance's state is a
  // fact of the fingerprint.
  it('accepting the same attempt for the same tree again, after it settled with another outcome, moves the fingerprint', () => {
    const attempts = [closed('r1', 'failed', { error_kind: 'peer_timeout' })];
    const staleView = lanes(child(ENG_A, { review: O.reviewSummary(fm(attempts, { acceptance: acceptance('r1', { outcome: 'unknown' }) })) }));
    const reView = lanes(child(ENG_A, { review: O.reviewSummary(fm(attempts, { acceptance: acceptance('r1', { error_kind: 'peer_timeout' }) })) }));
    deepStrictEqual([staleView.children.A.review.held, reView.children.A.review.held], [true, false], 'the owner resolved it (control)');
    const kept = { fingerprint_version: PARK_FINGERPRINT_VERSION, form: 'lane', fingerprint: parkFingerprint(staleView, 'A', { form: 'lane' }) };
    strictEqual(compareKept(kept, { fingerprint: parkFingerprint(reView, 'A', { form: 'lane' }), form: 'lane' }), 'changed');
    notStrictEqual(laneFingerprint(staleView, 'A', { withoutPeers: true }), laneFingerprint(reView, 'A', { withoutPeers: true }), 'without peers too');
  });

  // Critique of 2026-11-07, third pass, MAJOR 2: accepted for T1, refused at
  // T2, accepted for T1 again moves nothing but the acceptance's time, and the
  // kept park must still be reconsidered.
  it('a re-acceptance of the same attempt and tree moves the fingerprint: an act of the owner is always reconsidered', () => {
    const at = (when) => lanes(child(ENG_A, { review: O.reviewSummary(fm([closed('r1', 'failed', { error_kind: 'peer_timeout' })], { acceptance: acceptance('r1', { error_kind: 'peer_timeout', accepted_at: when }) })) }));
    const first = at('2026-11-07T00:00:00Z');
    const again = at('2026-11-07T01:00:00Z');
    deepStrictEqual([first.children.A.review.acceptance.tree, first.children.A.review.acceptance.state], [again.children.A.review.acceptance.tree, again.children.A.review.acceptance.state], 'nothing else moved');
    const kept = { fingerprint_version: PARK_FINGERPRINT_VERSION, form: 'lane', fingerprint: parkFingerprint(first, 'A', { form: 'lane' }) };
    strictEqual(compareKept(kept, { fingerprint: parkFingerprint(first, 'A', { form: 'lane' }), form: 'lane' }), 'unchanged', 'the same acceptance (control)');
    strictEqual(compareKept(kept, { fingerprint: parkFingerprint(again, 'A', { form: 'lane' }), form: 'lane' }), 'changed');
    notStrictEqual(laneFingerprint(first, 'A', { withoutPeers: true }), laneFingerprint(again, 'A', { withoutPeers: true }), 'without peers too');
  });

  it('a child whose latest outcome does not block, with no acceptance, keeps the fingerprint of one with no review record', () => {
    strictEqual(laneFingerprint(lanes(child(ENG_A, { review: O.reviewSummary(fm([closed('r1', 'passed')])) })), 'A'), laneFingerprint(lanes(child(ENG_A)), 'A'));
  });

  it('a forced commit judged when the run began meets the gate again at each decision', () => {
    const forced = new Map([['A', { kind: 'commit', subtaskId: 'A', branch: 'feat/a' }]]);
    const d = decideLanes(lanes(child(ENG_A, { review: O.reviewSummary(FAILED) })), { lanes: new Map(), started: new Set(), inFlight: new Set(), forced });
    deepStrictEqual(d.laneHalts.map((h) => [h.subtaskId, h.reason]), [['A', 'awaiting-owner:review-outcome']]);
    ok(!d.laneSteps.some((s) => s.subtaskId === 'A'));
    const usable = decideLanes(lanes(child(ENG_A, { review: O.reviewSummary(fm([closed('r1', 'passed')])) })), { lanes: new Map(), started: new Set(), inFlight: new Set(), forced });
    deepStrictEqual(usable.laneSteps.filter((s) => s.subtaskId === 'A').map((s) => [s.kind, s.forced]), [['commit', true]], 'control');
  });
});

// Critique of 2026-11-07, third pass, MAJOR 1 — the working tree moved past the
// acceptance: the observer reads it (`change`, compareAcceptedTree), so the
// gate holds the step, and a step Phase 7 refuses is the gate's halt. No new
// commit alone says nothing of the review: only the record held does.
describe('the review gate over a tree the acceptance does not cover', () => {
  const STEP = { kind: 'commit', subtaskId: 'A', branch: 'feat/a' };
  const worker = (report = {}) => ({
    exitCode: 0, lastResult: { is_error: false },
    report: { outcome: 'completed', workflow: ENG_A, next_step: null, awaiting_owner: null, summary: 'Phase 7 refused with exit 10', waiting_on_background: false, ...report },
  });
  const ACCEPTED = fm([closed('r1', 'failed', { error_kind: 'peer_timeout' })], { acceptance: acceptance('r1', { error_kind: 'peer_timeout' }) });
  const compared = (state, reason = null, over = {}) => withReview(ACCEPTED, { review: { ...O.reviewSummary(ACCEPTED), held: true, change: { state, reason } }, ...over });
  const same = () => withReview(ACCEPTED);

  it('decide holds the step: a moved tree, or one that cannot be compared, halts on the gate with no worker spent', () => {
    const moved = decide(compared('moved'), ctx());
    deepStrictEqual([moved.outcome, moved.reason, moved.subtaskId], ['halt', 'awaiting-owner:review-outcome', 'A']);
    match(moved.detail, /r1 \(critique review\): failed, peer_timeout; the owner accepted r1 for another working tree, so Phase 7 refuses the commit \(exit 10\)/);
    match(moved.detail, /review-accept --workflow-path \S+ --attempt-id r1 --note-file <file>/);
    deepStrictEqual([moved.review.held, moved.review.accepted], [true, null], 'an acceptance the tree moved past covers nothing');
    const unreadable = decide(compared('unreadable', 'checkout-unreadable:index-flags'), ctx());
    strictEqual(unreadable.reason, 'awaiting-owner:review-outcome');
    match(unreadable.detail, /the working tree cannot be compared \(checkout-unreadable:index-flags\)/);
    deepStrictEqual([decide(same(), ctx()).step?.kind, P.reviewRecord(same().children.A.review).accepted], ['commit', 'r1'], 'the tree it was given for (control)');
    match(decide(compared('moved'), ctx({ forced: parseForcedStep('/engineer:commit') })).detail, /--next does not apply: subtask A: .*for another working tree/);
  });

  it('verifyStep: a commit step that leaves the gate holding, with no new commit, is the gate\'s halt, and names what the worker reported', () => {
    const before = same();
    for (const report of [{}, { outcome: 'needs_owner' }]) {
      const d = verifyStep({ step: STEP, worker: worker(report), before, after: compared('moved') });
      deepStrictEqual([d.outcome, d.reason, d.subtaskId], ['halt', 'awaiting-owner:review-outcome', 'A'], JSON.stringify(report));
      strictEqual(d.pointer, `.agentic-plugins/state/engineer/workflows/${ENG_A}.md#review_attempts`);
      match(d.detail, /for another working tree.*--next \/engineer:critique.*review-accept --workflow-path .*The worker reported: Phase 7 refused with exit 10$/);
      deepStrictEqual([d.review.held, d.review.accepted, d.review.outcomes.map((o) => o.id)], [true, null, ['r1']]);
    }
    // An outcome recorded while the step ran reads the same way.
    const during = verifyStep({ step: STEP, worker: worker(), before: withReview(fm([closed('r1', 'passed')])), after: withReview(FAILED) });
    strictEqual(during.reason, 'awaiting-owner:review-outcome');
    match(during.detail, /review-2 \(critique review\): failed, peer_timeout; the owner has not accepted it\./);
  });

  it('a step the gate did not stop is judged as any other: an accepted outcome over its own tree is no review halt', () => {
    const v = same();
    const noCommit = verifyStep({ step: STEP, worker: worker({ summary: 'exit 9: the subject was refused' }), before: v, after: v });
    strictEqual(noCommit.reason, 'owner-choice');
    match(noCommit.detail, /the commit step left subtask A's workflow active/);
    strictEqual(noCommit.review, undefined);
    const recovery = verifyStep({ step: { ...STEP, recovery: true }, worker: worker(), before: v, after: v });
    match(recovery.detail, /the archive the Stop hook should run did not run/);
    const failed = verifyStep({ step: STEP, worker: worker({ outcome: 'failed', summary: 'scripted failure' }), before: v, after: v });
    deepStrictEqual([failed.reason, failed.detail, failed.review], ['worker-failed', 'the worker reports failure: scripted failure', undefined]);
  });

  it('a failed report stays worker-failed, so the run cancels its peers, and carries the record; a report still waiting keeps its own halt', () => {
    const failed = verifyStep({ step: STEP, worker: worker({ outcome: 'failed' }), before: same(), after: compared('moved') });
    strictEqual(failed.reason, 'worker-failed');
    match(failed.detail, /^the worker reports failure: Phase 7 refused with exit 10; subtask A: its latest review outcome holds the commit back/);
    deepStrictEqual([failed.subtaskId, failed.review?.held, failed.review?.outcomes.map((o) => o.id)], ['A', true, ['r1']]);
    const waiting = verifyStep({ step: STEP, worker: worker({ waiting_on_background: true }), before: same(), after: compared('moved') });
    strictEqual(waiting.reason, 'owner-choice');
    match(waiting.detail, /still waits on background work/);
  });

  it('a commit made, a stored gate recorded, or a worker that crashed is not this halt (controls)', () => {
    const before = same();
    const landed = compared('moved');
    landed.git = { ...landed.git, head: 'h1' };
    strictEqual(verifyStep({ step: STEP, worker: worker(), before, after: landed }), null, 'a new commit');
    const gated = compared('moved', null, { awaiting_owner: { gate: 'staging-set', pointer: null, since: null }, progress: 4 });
    strictEqual(verifyStep({ step: STEP, worker: worker(), before, after: gated }), null, 'the staging-set gate');
    strictEqual(verifyStep({ step: STEP, worker: { exitCode: 1, lastResult: null, report: null }, before, after: compared('moved') }).reason, 'worker-failed', 'a crash');
    notStrictEqual(verifyStep({ step: { kind: 'verb', verb: 'critique', subtaskId: 'A', branch: 'feat/a' }, worker: worker(), before, after: compared('moved') })?.reason, 'awaiting-owner:review-outcome', 'another step');
  });

  it('the --next this halt prints parses too', () => {
    const { detail } = decide(compared('moved'), ctx());
    const printed = [...detail.matchAll(/--next ([^\s`]+)/g)].map((m) => m[1]);
    ok(printed.length >= 2, detail);
    for (const step of printed) deepStrictEqual(parseForcedStep(step), { kind: 'verb', verb: 'critique' }, step);
  });

  it("a parked lane's resolution names only what its record takes", () => {
    const rec = (f) => P.reviewRecord(O.reviewSummary(f));
    const plain = P.reviewResolutionText(rec(FAILED), 'A');
    match(plain, /review-accept .*--lane A --next \/engineer:critique/);
    const unreadable = P.reviewResolutionText(rec({ review_attempts: '{not json' }), 'A');
    match(unreadable, /repair the workflow file's review_attempts by hand/);
    ok(!/review-accept|--next/.test(unreadable), unreadable);
    const later = P.reviewResolutionText(rec({ review_attempts: JSON.stringify({ v: 99, attempts: [] }) }), 'A');
    match(later, /upgrade the plugins/);
    ok(!/review-accept|--next/.test(later), later);
    const opened = P.reviewResolutionText(rec(fm([closed('r1', 'failed'), open('r2')])), 'A');
    match(opened, /--lane A --next \/engineer:critique .*r2 is still open, so it cannot be accepted until its run is settled/);
    ok(!/review-accept/.test(opened), opened);
  });
});

describe('reports — the landing report and the halts name each outcome', () => {
  const archived = (frontmatter) => view({
    children: {
      A: child(ENG_A, {
        location: 'archived', path: `/r/.agentic-plugins/state/engineer/archive/${ENG_A}.md`,
        relPath: `.agentic-plugins/state/engineer/archive/${ENG_A}.md`, current_phase: 'commit-complete', terminal_marker: true,
        review: O.reviewSummary(frontmatter),
      }),
    },
    claims: [],
    landing: { A: { ok: false, reason: 'no_pr', detail: 'no pull request' } },
  });

  it('a subtask waiting to land carries its review outcomes and whether its history is incomplete', () => {
    const f = fm([closed('r1', 'failed', { error_kind: 'peer_timeout' }), closed('r2', 'passed')], { coverage: { history_incomplete: true, reasons: ['truncation'] } });
    const [w] = P.waitingToLand(archived(f));
    deepStrictEqual(w.review.outcomes.map((o) => [o.id, o.outcome]), [['r1', 'failed'], ['r2', 'passed']]);
    deepStrictEqual([w.review.held, w.review.history_incomplete, w.review.reasons], [false, true, ['truncation']]);
    strictEqual(P.reviewOutcomesText(w.review), 'review outcomes: r1 critique review: failed (peer_timeout); r2 critique review: passed; history incomplete (truncation)');
    strictEqual(P.reviewOutcomesText(null), 'review outcomes: not observed');
  });

  it('a new outcome, an acceptance or a history found incomplete at unchanged commits is a new observation; the same record is not', () => {
    const rec = (f) => ({ commit: 'c1', integration_branch: 'main', sync: { base_commit: 'b1', state: 'ready' }, review: P.reviewRecord(O.reviewSummary(f)) });
    const one = fm([closed('r1', 'failed')]);
    strictEqual(LR.observationKey(rec(one)), LR.observationKey(rec(fm([closed('r1', 'failed')]))), 'the same record (control)');
    ok(LR.observationKey(rec(one)) !== LR.observationKey(rec(fm([closed('r1', 'failed'), closed('r2', 'passed')]))), 'a new outcome');
    ok(LR.observationKey(rec(one)) !== LR.observationKey(rec(fm([closed('r1', 'failed')], { acceptance: acceptance('r1') }))), 'an acceptance');
    ok(LR.observationKey(rec(one)) !== LR.observationKey(rec(fm([closed('r1', 'failed')], { coverage: { history_incomplete: true, reasons: ['truncation'] } }))), 'history incomplete');
    // A record logged before the review outcomes observed none: reported once more.
    const { review: _drop, ...older } = rec(one);
    ok(LR.observationKey(older) !== LR.observationKey(rec(one)));
  });

  // Critique of 2026-11-07, MAJOR 6: the event the log keeps carries the
  // record, driven through reportLandingReady, not hand-built.
  it('the landing event carries the review record, so a new outcome at unchanged commits is reported again (reportLandingReady)', async () => {
    const fx = await makeRepo();
    const runDir = mkdtempSync(join(tmpdir(), 'review-landing-run-'));
    try {
      fx.git('switch', '-q', '--no-track', '-c', 'feat/a', 'refs/remotes/origin/main');
      writeFileSync(join(fx.work, 'a.txt'), 'A\n');
      fx.git('add', 'a.txt');
      fx.git('commit', '-q', '-m', 'feat: a');
      const sha = fx.git('rev-parse', 'HEAD');
      const waiting = (f) => ({
        macro: { id: fx.macroId, archived: false, fm: { git_baseline: { branch: 'main' }, plan: { subtasks: [{ id: 'A', status: 'in_progress', branch: 'feat/a', blocked_by: [], engineer_workflow_id: ENG_A }] } } },
        children: { A: { location: 'archived', terminal_marker: true, current_phase: 'commit-complete', workflow_id: ENG_A, branch: 'feat/a', review: O.reviewSummary(f) } },
        landing: { A: { ok: false, reason: 'no_pr', detail: '' } },
        fetch: { attempted: true, ok: true, detail: null },
      });
      const lines = [];
      const report = (f) => LR.reportLandingReady({ repoRoot: fx.work, mainRoot: fx.work, runDir, runId: RUN, seq: 0, view: waiting(f), out: (x) => lines.push(x) });
      const log = () => LR.readLandingLog(LR.landingLogPath(fx.work, fx.macroId));
      report(fm([closed('r1', 'failed', { error_kind: 'peer_timeout' })]));
      report(fm([closed('r1', 'failed', { error_kind: 'peer_timeout' })]));
      strictEqual(log().length, 1, 'the same observation is not reported again (control)');
      report(fm([closed('r1', 'failed', { error_kind: 'peer_timeout' }), closed('r2', 'passed')]));
      deepStrictEqual(log().map((x) => [x.commit, x.review?.outcomes.map((o) => o.outcome)]), [[sha, ['failed']], [sha, ['failed', 'passed']]]);
      ok(lines.includes('    review outcomes: r1 critique review: failed (peer_timeout); r2 critique review: passed'), lines.join('\n'));
    } finally {
      fx.cleanup();
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('the halt reason is one the event file takes, and a worker cannot report the derived gate', () => {
    strictEqual(E.isHaltCode('awaiting-owner:review-outcome'), true);
    const report = { outcome: 'needs_owner', workflow: ENG_A, next_step: null, awaiting_owner: 'scope-routing', summary: 's', waiting_on_background: false };
    strictEqual(stepReportProblem(report), null, 'a stored gate (control)');
    strictEqual(stepReportProblem({ ...report, awaiting_owner: 'review-outcome' }), 'awaiting_owner');
  });
});

describe('observe — reviewSummary reads the record a workflow file holds', () => {
  it('keeps the latest, the hold, the acceptance, each outcome and the coverage', () => {
    const s = O.reviewSummary(fm([closed('r1', 'failed', { error_kind: 'peer_timeout' })], { acceptance: acceptance('r1', { error_kind: 'peer_timeout' }) }));
    deepStrictEqual(Object.keys(s).sort(), ['acceptance', 'blocking', 'held', 'history_incomplete', 'latest', 'outcomes', 'reasons']);
    deepStrictEqual([s.blocking, s.held, s.acceptance], [true, false, { state: 'matches', attempt_id: 'r1', tree: TREE, accepted_at: AT }]);
    deepStrictEqual(s.outcomes, [{ id: 'r1', phase: 'critique', type: 'review', outcome: 'failed', error_kind: 'peer_timeout' }]);
  });

  it("reads the record from an older engineer's forward-compat carrier, where its read lists the scalars it does not know", () => {
    const f = fm([closed('r1', 'unavailable', { error_kind: 'peer_cli_not_found' })]);
    const carried = { ensemble_results: [], _forward_compat_unknowns: [{ key: 'review_attempts', value: f.review_attempts, raw: JSON.stringify(f.review_attempts) }] };
    const s = O.reviewSummary(carried);
    deepStrictEqual([s.latest?.id, s.latest?.outcome, s.held], ['r1', 'unavailable', true]);
    deepStrictEqual([O.reviewSummary({ ensemble_results: [] }).latest, O.reviewSummary({ ensemble_results: [] }).held], [null, false], 'no record (control)');
  });
});

describe('roots — the driver needs an engineer with the review gate', () => {
  it('the capability floor probes review-accept, which the engineer in this tree carries', async () => {
    const R = await import(resolve(AP, 'roots.mjs'));
    const roots = { orchestrator: resolve(REPO_ROOT, 'plugins/orchestrator'), engineer: resolve(REPO_ROOT, 'plugins/engineer'), runtime: resolve(REPO_ROOT, 'plugins/runtime') };
    deepStrictEqual(await R.capabilityProblems(roots), []);
  });

  // Critique of 2026-11-07, third pass, MAJOR 4: the green test above held
  // with the probe deleted, so it did not bite for its stated reason.
  it('an engineer with no review-accept is below the floor', async () => {
    const R = await import(resolve(AP, 'roots.mjs'));
    const dir = mkdtempSync(join(tmpdir(), 'review-floor-'));
    try {
      const engineer = join(dir, 'engineer');
      cpSync(resolve(REPO_ROOT, 'plugins/engineer'), engineer, { recursive: true });
      const file = join(engineer, 'scripts', 'state.mjs');
      const text = readFileSync(file, 'utf8');
      ok(text.includes("case 'review-accept'"), 'the copy carries it, until the line below');
      writeFileSync(file, text.split("case 'review-accept'").join("case 'review-accept-gone'"));
      const problems = await R.capabilityProblems({ engineer });
      ok(problems.some((p) => /lacks the review gate, with the owner's review-accept and Phase 7's refusal/.test(p)), problems.join('\n'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Critique of 2026-11-07, MAJOR 5 — a run with lanes, with no model (the fake
// `claude` and the scripted worker): each lane held on the gate keeps its
// review record in its park, its lane report and the run's halt, the first
// lane's as the halt's own and the other's in its `also`.
describe('lanes, run — each held lane carries its review record into the halt and its lane report', () => {
  it("two lanes held on the review gate: the halt names A's outcomes, its also B's, and each lane's report keeps its own", async () => {
    const t = await setupLanes({ scenario: { A: { next: [COMMIT], file: true, review: 'failed' }, B: { next: [COMMIT], file: true, review: 'failed' } } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      const ids = (rec) => rec?.outcomes?.map((o) => [o.id, o.outcome, o.error_kind]) ?? null;
      const A = [['review-20261001T000000Z-fa11ea', 'failed', 'peer_timeout']];
      const B = [['review-20261001T000000Z-fa11eb', 'failed', 'peer_timeout']];
      deepStrictEqual([r.halt.reason, r.halt.subtask_id, ids(r.halt.review)], ['awaiting-owner:review-outcome', 'A', A], t.lines.join('\n'));
      deepStrictEqual(r.halt.also.map((h) => [h.reason, h.subtask_id, ids(h.review)]), [['awaiting-owner:review-outcome', 'B', B]]);
      const lanes = bySubtask(r);
      deepStrictEqual([ids(lanes.A.halt?.review), ids(lanes.B.halt?.review)], [A, B]);
      for (const id of ['fa11ea', 'fa11eb']) {
        ok(t.lines.some((l) => l === `  review outcomes: review-20261001T000000Z-${id} critique review: failed (peer_timeout); the latest holds the commit back`), t.lines.join('\n'));
      }
    } finally {
      t.fx.cleanup();
    }
  });
});

// The owner's acceptance, as `state.mjs review-accept` records it, at a time
// the test names: two acceptances in one second would otherwise read alike.
const ownerEnv = (t) => { const e = { ...t.env }; delete e.AGENTIC_AUTOPILOT; return e; };
const ownerAccepts = (t, workflowPath, repoRoot, attemptId, now) => ENG_STATE.acceptReviewAttempt({ workflowPath, repoRoot, attemptId, note: 'the owner read the change', env: ownerEnv(t), now: new Date(now) });
const FAILED_A = 'review-20261001T000000Z-fa11ea';

// Critique of 2026-11-07, third pass, MAJOR 1, end to end: the real review
// gate, the real `review-accept`, the real observer and the real Phase 7, in a
// serial run.
describe('a run, the tree moved after the acceptance', () => {
  it('moved before the step, the run halts with no worker; moved during it, Phase 7 refuses and the run halts on the gate; the owner accepts the tree as it is, and the relaunch commits', async () => {
    const t = await setupLanes({ scenario: { A: { next: [COMMIT], file: true, review: 'failed' } }, subtasks: [{ id: 'A' }] });
    const serial = { lanes: 1 };
    const scenario = (change) => writeFileSync(t.scen, JSON.stringify(change(JSON.parse(readFileSync(t.scen, 'utf8')))));
    const phase7 = () => readdirSync(t.dir).filter((f) => /^phase7-.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(t.dir, f), 'utf8')));
    try {
      strictEqual(await t.run(serial), 2, t.lines.join('\n'));
      let r = t.latest();
      deepStrictEqual([r.halt.reason, r.halt.subtask_id], ['awaiting-owner:review-outcome', 'A'], t.lines.join('\n'));
      deepStrictEqual(r.halt.review.outcomes.map((o) => [o.id, o.outcome]), [[FAILED_A, 'failed']]);
      const line = `  review outcomes: ${FAILED_A} critique review: failed (peer_timeout); the latest holds the commit back`;
      ok(t.lines.includes(line), t.lines.join('\n'));
      const wf = join(t.work, r.halt.pointer.replace(/#.*$/, ''));

      // The owner accepts, then the tree moves: the look reads it, and no step runs.
      await ownerAccepts(t, wf, t.work, FAILED_A, '2026-11-07T01:00:00Z');
      writeFileSync(join(t.work, 'a.txt'), 'edited after the acceptance\n');
      t.lines.length = 0;
      strictEqual(await t.run(serial), 2, t.lines.join('\n'));
      r = t.latest();
      deepStrictEqual([r.steps.length, phase7().length], [0, 0], t.lines.join('\n'));
      strictEqual(r.halt.reason, 'awaiting-owner:review-outcome');
      match(r.halt.detail, /for another working tree, so Phase 7 refuses the commit/);
      ok(t.lines.includes(line), t.lines.join('\n'));

      // Accepted as it is, then edited during the step: the real Phase 7 refuses.
      await ownerAccepts(t, wf, t.work, FAILED_A, '2026-11-07T02:00:00Z');
      scenario((x) => ({ ...x, actions: { 'commit:A': ['edit-before-commit:a.txt'] } }));
      t.lines.length = 0;
      strictEqual(await t.run(serial), 2, t.lines.join('\n'));
      r = t.latest();
      deepStrictEqual(r.steps.map((s) => s.kind), ['commit'], t.lines.join('\n'));
      deepStrictEqual(phase7().map((x) => x.status), [10], 'the real Phase 7 refused it');
      match(phase7()[0].stderr, /the owner accepted it for another change/);
      deepStrictEqual([r.halt.reason, r.halt.subtask_id], ['awaiting-owner:review-outcome', 'A'], t.lines.join('\n'));
      match(r.halt.detail, /for another working tree.*The worker reported: scripted step$/);
      match(r.halt.detail, new RegExp(`review-accept --workflow-path \\S+ --attempt-id ${FAILED_A}`));
      deepStrictEqual([r.halt.review.held, r.halt.review.accepted, r.halt.review.outcomes.map((o) => o.id)], [true, null, [FAILED_A]]);
      ok(t.lines.includes(line), t.lines.join('\n'));

      // The owner accepts the tree as it is: the relaunch commits, and the record reaches the landing halt.
      scenario(({ actions: _gone, ...x }) => x);
      await ownerAccepts(t, wf, t.work, FAILED_A, '2026-11-07T03:00:00Z');
      t.lines.length = 0;
      strictEqual(await t.run(serial), 2, t.lines.join('\n'));
      r = t.latest();
      deepStrictEqual(r.steps.map((s) => [s.kind, s.outcome]), [['commit', 'ok']], t.lines.join('\n'));
      strictEqual(r.halt.reason, 'awaiting-landing');
      strictEqual(r.halt.waiting[0].review.accepted, FAILED_A);
      ok(t.lines.includes(`      review outcomes: ${FAILED_A} critique review: failed (peer_timeout); accepted by the owner: ${FAILED_A}`), t.lines.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });
});

// Critique of 2026-11-07, third pass, MAJOR 1, 2 and 4, end to end in a run
// with lanes: the kept park keeps its record, the refusal parks the lane on
// the gate, and a re-acceptance of the first tree picks it up. Two tests, each
// from its own setup: one test of all five runs came within seconds of the
// suite's 120-second timeout under the load of the whole suite, and past it.
describe('lanes, runs — a kept park, a refused commit and a re-acceptance', () => {
  const SCENARIO = { A: { next: [COMMIT], file: true, review: 'failed' }, B: { next: [COMMIT], file: true, review: 'failed' } };

  it('a kept park reports its record', async () => {
    const t = await setupLanes({ scenario: SCENARIO });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      let lanes = bySubtask(t.latest());
      match(lanes.A.park.resolution.change, /review-accept .*--lane A --next \/engineer:critique/);
      ok(!/clear its gate/.test(lanes.A.park.resolution.change), lanes.A.park.resolution.change);

      // Nothing changed: each park is kept, with its record.
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      lanes = bySubtask(t.latest());
      deepStrictEqual(lanes.A.halt?.review?.outcomes.map((o) => o.id), [FAILED_A], 'a park kept by an earlier run');
      strictEqual(lanes.A.park.kept, true);
    } finally {
      t.fx.cleanup();
    }
  });

  it('an edit after the acceptance holds the lane on the gate; the first tree accepted again is picked up and commits', async () => {
    // Lane A alone: this test asserts only A, and each run of a second lane
    // would only add its time.
    const t = await setupLanes({ scenario: { A: SCENARIO.A }, subtasks: [{ id: 'A' }] });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      let lanes = bySubtask(t.latest());
      ok(lanes.A.park?.pointer, t.lines.join('\n'));
      const wf = join(t.work, lanes.A.park.pointer.replace(/#.*$/, ''));

      // Accepted for the tree as it is, then edited: Phase 7 refuses, and the lane parks on the gate.
      const file = join(t.lane('A'), 'a.txt');
      const accepted = readFileSync(file, 'utf8');
      await ownerAccepts(t, wf, t.lane('A'), FAILED_A, '2026-11-07T01:00:00Z');
      writeFileSync(file, 'edited after the acceptance\n');
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      let r = t.latest();
      lanes = bySubtask(r);
      strictEqual(lanes.A.halt?.reason, 'awaiting-owner:review-outcome', t.lines.join('\n'));
      match(lanes.A.halt.detail, /for another working tree, so Phase 7 refuses the commit/);
      deepStrictEqual(r.steps.filter((x) => x.subtask_id === 'A').map((x) => x.kind), ['commit'], 'decided from the main checkout, which reads no lane\'s tree');
      deepStrictEqual(lanes.A.halt.review.outcomes.map((o) => o.id), [FAILED_A]);

      // The first tree back, accepted again: only the acceptance's time moved, and the lane is picked up.
      writeFileSync(file, accepted);
      await ownerAccepts(t, wf, t.lane('A'), FAILED_A, '2026-11-07T02:00:00Z');
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      r = t.latest();
      deepStrictEqual(r.steps.filter((s) => s.subtask_id === 'A').map((s) => [s.kind, s.outcome]), [['commit', 'ok']], t.lines.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });
});
