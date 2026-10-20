// plugins/orchestrator/adapters/claude/autopilot/scheduler.mjs
//
// ADR-0067 Decision 6 — the scheduler of a run with lanes (`--lanes N`, N of
// 2 or more). driver.mjs starts the run as it starts a serial one (preflight,
// locks, the dead-run cleanup, the open-run record, the first landing report)
// and hands it here; a serial run never comes here.
//
// One turn: settle every step that ended (each is observed, verified and
// recorded before anything new starts, so a halt that came with a success in
// the same turn is handled first); pick up the parked lanes whose record
// changed or that the owner released; look at the macro from the driver's
// checkout; decide with `decideLanes`; park each lane the decision halts;
// start what may start — forced steps, then the driver's step (done,
// finalize), then the steps of lanes already started, then new lanes — up to
// N workers in flight; then wait for the next event: a step's end, a
// rate-limit event that changes the throttle, the throttle's reset, a signal,
// or the wake-up tick.
//
// Before each spawn a step reserves its budget (budget.mjs), a new lane passes
// the throttle (throttle.mjs), a lane is created once its first step is
// admitted (lanes.mjs), and the checks that read a checkout run on the
// checkout the step runs in, from a fresh look at it. A lane step is judged
// by its lane's fingerprint and its own gates (policy.mjs).
//
// ADR-0068 Decision 1 — a halt has a scope (policy.mjs `haltScope`). A lane
// halt (a gate, a judgment halt, a failed step or creation of that lane)
// parks its lane: it starts no new step, holds no capacity, and the other
// lanes go on. Each park is kept in the macro's records (parks.mjs) with the
// lane's fingerprint, so a relaunch or a crash never loses it, and a step
// that wrote nothing is never retried on an unchanged record. A parked lane
// is picked up again once its fingerprint changes (the owner cleared the
// gate, recorded a next step, moved the branch) or the owner releases it.
// Every 30 s a tick reads a cheap digest of what resolves a park (the
// lane's records, its child, its git HEAD, ref and index, the macro file)
// and wakes the loop once one changed and has stayed so for a whole interval
// (a gate resolution writes twice, seconds apart), so a lane is picked up
// without waiting for another lane's worker to end.
//
// A run-wide halt — version drift, an exhausted budget, an invalidated plan
// approval, a gate on the macro, a halt that names no lane, the run's
// footing, a step outside every lane, a worker group that outlived SIGKILL —
// drains the run (W2): nothing new starts, the steps in flight end and are
// recorded (a commit still reports landing-ready), then halt.json records the
// halt, the open parks beside it, and one entry per lane, and the run exits 2.
// The run also ends, exit 2, when nothing is in flight and nothing can start:
// every remaining lane parked, waiting to land, or behind one of those; it
// first takes each parked lane's fingerprint again. SIGINT, SIGTERM and SIGHUP
// abort every worker group instead, during a drain too.
//
// What runs where: the loop itself, the policy, the budget, the throttle, the
// locks and the ledger run here, in process. Everything synchronous that
// reads or writes outside the driver runs in a child process (offloop.mjs),
// so that while it runs every worker's stream, timeout and abort, and every
// signal, are still served: a look, a lane's creation and removal, a prepared
// lane's baseline check, the landing-ready report and a peer run's
// cancellation. A lane-layer failure there is that lane's, never the run's:
// a creation that fails is the lane's halt (it parks, and the worktree it may
// have left stays, part of the lane's fingerprint), unless the run's footing
// failed in it; a removal that fails keeps the lane. The reconciliation
// before the loop runs in process, with no worker in flight.
//
// A task's group is held as a worker's is: it goes on the macro lock and on
// the lock of the checkout it acts in before it has its input, it is emptied
// and confirmed empty before its entries and the caller's locks go, and one
// that outlives SIGKILL keeps the run's locks. On an interrupt the tasks that
// only read (a look, a baseline fetch, the landing report) are killed at once;
// a lane's creation or removal or a peer cancellation already under way gets
// a short bound to finish (offloop.mjs, INTERRUPT_BOUND_MS); after it no lane
// is created or removed, no landing report runs, and the look that settles a
// step runs without its fetch.
//
// No lane is left without its step (Decision 5): an admission that refuses
// after it created its lane removes that lane at once, and before the run
// ends — any end but an interrupt or a crash — every lane it created that no
// step used is removed, except a parked one (ADR-0068 Decision 1, item 5). An
// interrupted run keeps its lanes.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createBudget } from './budget.mjs';
import { holdLane, laneGitDir, laneHome, lanePath, reconcileLanes, refTip, stepPlacement } from './lanes.mjs';
import {
  appendLaneEvent, appendStep, LockHeldError, processFingerprint, relaunchCommand, releaseCommand, workerStreamPath, writeRun,
} from './ledger.mjs';
import { createTaskRunner, offLoop as defaultOffLoop } from './offloop.mjs';
import {
  deletePark, newRecordId, PARK_SCHEMA, readPark, readParks, retiring, stepVerdict, writePark,
} from './parks.mjs';
import {
  afterUnread, checkoutProblem, compareKept, consensusProposals, decideLanes, fingerprint, forcedForLanes, haltScope,
  laneFingerprint, modelFor, PARK_FINGERPRINT_VERSION, parkFingerprint, peersOnlyProgress, proposalsAtEnd, renderStep,
  RUN_WIDE_REASONS, STEP_KINDS, verifyStep, waitingToLand,
} from './policy.mjs';
import { driftOf, PLUGINS, resolveRoots } from './roots.mjs';
import {
  applyRateLimitEvent, createThrottleState, gateNewLane, judgeThrottle, throttleSnapshot, throttleText,
} from './throttle.mjs';

// How long a wait for the throttle's reset at `sec` (Unix seconds) sleeps
// before the run decides again: a second past the reset, and never past the
// longest delay setTimeout holds (a longer one fires at once). A reset may be
// days off (a seven-day window), and a run has no deadline: the wait is slept
// in pieces, each wake-up deciding again.
const MAX_TIMER_MS = 2 ** 31 - 1;
export const resetDelayMs = (sec, nowMs) => Math.min(Math.max(0, sec * 1000 - nowMs) + 1000, MAX_TIMER_MS);

// ADR-0068 Decision 1, item 6 — how often a run with lanes reads its wake
// sources. A parked lane is picked up once what changed has stayed unchanged
// for one whole interval: a gate's resolution clears the gate, then records
// the next step, seconds apart, and the driver must not step a lane between
// the two.
export const WAKE_INTERVAL_MS = 30_000;

/**
 * ADR-0068 Decision 1, item 9 — the closed vocabulary of a lane's `state` in
 * halt.json, run.json and the final report; `note` keeps the detail.
 */
export const LANE_STATES = Object.freeze(['active', 'parked', 'waiting-to-land', 'removed', 'kept', 'creation-failed', 'not-created', 'halted']);
const NOTE_STATES = Object.freeze({
  created: 'active', adopted: 'active', prepared: 'active', resumed: 'active', 'created, not used': 'active',
  removed: 'removed', 'removed (no step used it)': 'removed', 'creation failed': 'creation-failed', 'never created': 'not-created',
  halted: 'halted',
});
export function laneState(entry, { parked = false } = {}) {
  if (parked) return 'parked';
  if (entry.waiting) return 'waiting-to-land';
  const note = entry.note ?? null;
  if (note === null) return entry.path ? 'active' : 'not-created';
  if (note.startsWith('kept')) return 'kept';
  return NOTE_STATES[note] ?? 'active';
}

// A file's identity and size and time, for the wake digest: no content is read.
const statKey = (f) => {
  if (typeof f !== 'string') return '-';
  try {
    const s = statSync(f);
    return `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch (e) {
    return e?.code ?? 'error';
  }
};
const textOf = (f) => {
  try { return readFileSync(f, 'utf8').trim(); } catch { return '-'; }
};

const canonical = (p) => {
  try { return realpathSync(p); } catch { return resolve(p); }
};

// A spawn that threw: the step ends there, and is charged as a spawn error is
// (its whole reservation, since it reported no cost).
function spawnFailure(e, sessionId) {
  return {
    sessionId, exitCode: null, signal: null, spawnError: e?.message ?? String(e), aborted: null, abortReason: null,
    abortDetail: null, timeoutSec: null, lastResult: null, report: null, costUsd: null, turns: 0, model: null,
    plugins: null, peakCtx: 0, contextWindow: null, peakPct: null, denials: [], stderrTail: '', rawTruncated: false,
    rateLimit: null, groupTeardown: 'empty', pgid: null,
  };
}

// A halt from the policy ({outcome, reason, …}), the lane layer ({reason,
// detail, subtaskId}) or the throttle, in one shape.
const asHalt = (h, extra = {}) => ({ outcome: 'halt', ...h, ...extra });
const DONE_KINDS = new Set(['done', 'done-no-commit']);

// Why a look cannot list the peer runs a step on subtask `id` left pending,
// or null: the macro or the claims could not be read, or the subtask's child
// was not read as the child it records. Only a child read as itself lists its
// peers — active or archived with its linkage, or none recorded yet (the
// claims then hold any workflow of the subtask) — so every other state is
// unlisted, a new one included: a child that could not be read, two archived
// files, a recorded child in no home the run reads (`missing`), another
// workflow on its branch (`linkage-mismatch`). newPendingRuns finds nothing in
// what was not read, and nothing found is not nothing pending.
const LISTED_CHILD = new Set(['active', 'archived', 'unrecorded']);
export function peersUnlisted(view, id) {
  if (!id) return null;
  if (view.lookError) return `the look failed: ${view.lookError}`;
  if (view.macroLookupError) return `the macro could not be read: ${view.macroLookupError}`;
  if (view.claimsError) return `the engineer workflows that claim the macro could not be listed: ${view.claimsError}`;
  const child = view.children?.[id];
  if (child && !LISTED_CHILD.has(child.location)) {
    const why = child.location === 'missing' ? `${child.workflow_id ?? 'the workflow it records'} is in no home the run reads`
      : child.location === 'linkage-mismatch' ? `the workflow read for it is not the child it records (${child.detail ?? 'its linkage differs'})`
        : child.detail ?? child.location;
    return `subtask ${id}'s engineer workflow could not be read: ${why}`;
  }
  return null;
}

// Why a look that does not list a subtask that waited cannot say it stopped
// waiting, or null when it reads that it did: the subtask is no longer in
// progress, its engineer workflow is active again (a new attempt) or closed
// with no commit, or its pull request merged. Anything else — a workflow that
// could not be read, a landing check that failed or refused (gh unavailable,
// for one) — is no answer, and the subtask keeps its place.
function waitingUnread(view, id) {
  const s = (view.macro?.fm?.plan?.subtasks ?? []).find((x) => x?.id === id);
  if (s?.status !== 'in_progress') return null;
  const child = view.children?.[id];
  if (child?.location === 'active') return null;
  if (child?.location !== 'archived') return `subtask ${id}'s engineer workflow could not be read${child?.detail ? ` (${child.detail})` : ''}`;
  if (child.current_phase === 'close-complete') return null;
  const landing = view.landing?.[id];
  if (landing?.ok === true) return null;
  if (!landing || landing.error) return `subtask ${id}'s landing could not be checked${landing?.error ? ` (${landing.error})` : ''}`;
  return `subtask ${id}'s landing check answered ${landing.reason ?? 'no reason'}${landing.detail ? ` (${landing.detail})` : ''}`;
}

// The subtasks a look reads as landed since a lane it keeps was judged: any
// whose pull request merged and that is not yet recorded completed, listed
// before or not (its landing check may have failed until now), and one that
// waited (`departed`) and leaves recorded completed with its commit. The
// integration branch has moved past the tip an earlier look judged a branch
// against. A completion with no commit lands nothing.
function landingsSeen(view, departed) {
  return (view.macro?.fm?.plan?.subtasks ?? []).filter((s) => s?.id != null && (
    (s.status === 'in_progress' && view.landing?.[s.id]?.ok === true)
    || (departed.has(s.id) && s.status === 'completed' && typeof s.commit === 'string' && s.commit !== '')
  )).map((s) => s.id);
}

// A waiting subtask whose freshness the run cannot confirm: the tip it was
// judged against stays, its commands go.
const unknownSync = (w, detail) => ({ ...w, sync: { state: 'unknown', base_commit: w.sync?.base_commit ?? null, detail, commands: [], note: null } });

/**
 * The waiting subtasks a look lists, with the commit, freshness and overlap
 * `report` (the landing-ready report, or null) found for each: `withheld`
 * marks one an unfetched look could not call ready. One the report does not
 * list keeps no freshness.
 */
export function landingFactsOf(list, report) {
  if (!report || list.length === 0) return list;
  return list.map((w) => {
    const e = report.entries.find((x) => x.subtaskId === w.subtaskId);
    return { ...w, commit: e?.commit ?? null, sync: e?.sync ?? null, ...(e?.overlap ? { overlap: e.overlap } : {}), ...(e?.withheld ? { withheld: true } : {}) };
  });
}

/**
 * What a look lists waiting, for `reconcileWaiting` (C128): nothing when it
 * failed or could not read the macro; with `report`'s facts when that report
 * was made from this look (`reported`); otherwise marked `unreported`, since
 * another look's report does not speak for it.
 */
export function foundWaiting(view, reported, report) {
  const found = view.lookError || view.macroLookupError ? [] : waitingToLand(view);
  return reported ? landingFactsOf(found, report) : found.map((w) => ({ ...w, unreported: true }));
}

/**
 * The subtasks waiting to land after a look (docket C128), each with a
 * freshness: the report the run ends with lists them, and the owner acts on
 * it. Every look the run takes goes through here — the first look's report,
 * each look of the run's loop, each step's look as it settles, a drain's last
 * look, the look the run's end takes for its proposals — so the list is
 * always the latest observation the run holds, and a subtask once known to
 * wait is never dropped by a look that could not read it. `found` is what the
 * look lists waiting, with the report's facts (empty when the look failed). A
 * subtask that waited before leaves only when the look reads that it stopped
 * waiting (`waitingUnread`); otherwise — the whole look failed, the macro,
 * its engineer workflow or its landing check could not be read — it keeps
 * its place, `unknown`. One the look found with no freshness (its report
 * failed) is `unknown` too. A look adds nothing to what it could not judge:
 * one its report withheld (not fetched in that look) keeps the freshness it
 * had at the same commit, and a look that had no report of its own
 * (`unreported`: the end's look for its proposals, a look an interrupt or an
 * error cut off before its report) keeps every entry as it was listed, and
 * lists what it newly found waiting `unknown` — another look's report never
 * speaks for it. Neither keeps a `ready` past a landing it saw itself
 * (`landingsSeen`: a merged pull request not yet recorded completed, or a
 * subtask that waited and leaves completed with its commit): the integration
 * branch has moved past the tip that `ready` was judged against, so each
 * `ready` such a look would keep is `unknown` instead, and a look that fetches
 * judges it again; a `needs-sync` stands, since a branch behind the old tip is
 * behind the new one too. A failure to read the macro's readiness is none of these:
 * the look still reads every subtask.
 */
export function reconcileWaiting(previous, view, found) {
  const whole = view.lookError ?? (view.macroLookupError ? `the macro could not be read: ${view.macroLookupError}` : null);
  const failed = (w, why) => unknownSync(w, `the run's last look failed (${why})`);
  const before = new Map(previous.map((w) => [w.subtaskId, w]));
  const listed = new Set(found.map((w) => w.subtaskId));
  const kept = [];
  const departed = new Set();
  for (const w of previous) {
    if (listed.has(w.subtaskId)) continue;
    const why = whole ?? waitingUnread(view, w.subtaskId);
    if (why) kept.push(failed(w, why));
    else departed.add(w.subtaskId);
  }
  const landed = landingsSeen(view, departed);
  // What this look keeps from an earlier one (it judged nothing new itself).
  const keep = (w) => (landed.length && w.sync?.state === 'ready'
    ? unknownSync(w, `subtask${landed.length > 1 ? 's' : ''} ${landed.join(', ')} landed after the look that judged it ready, and this look did not fetch`)
    : w);
  const now = found.map(({ withheld, unreported, ...w }) => {
    const p = before.get(w.subtaskId);
    if (unreported) return p ? keep(p) : unknownSync(w, 'no report was made for the look that found it');
    if (withheld && p?.sync && w.commit && p.commit === w.commit) return keep({ ...w, sync: p.sync });
    return w.sync ? w : failed(w, 'its landing report did not complete');
  });
  return [...now, ...kept];
}

/**
 * C128 — the list a run ends with when it ends without its last look (an
 * interrupt, an error): nothing it lists can be confirmed, so every entry is
 * `unknown`, and the next run's first look reports each again.
 */
export function endedUnlooked(waiting, why) {
  return waiting.map((w) => unknownSync(w, `the run ended before its last look (${why})`));
}

// The look's view with the subtask's child kept only when it was read as the
// child the subtask records: a workflow read in its place (linkage-mismatch)
// is not the step's, so the step's peer cancellation never takes its runs.
// The claims still give every workflow that names the subtask, and what is
// left unlisted keeps the open-run record for the cleanup, which cancels
// only the peers that name the run.
export function ownChildOnly(view, id) {
  const child = id ? view?.children?.[id] : null;
  if (!child || LISTED_CHILD.has(child.location)) return view;
  const { [id]: _notTheStep, ...children } = view.children;
  return { ...view, children };
}

// What a failed step's peer cancellation leaves, in the serial run and in a
// lane alike: the verdict's detail names the peers cancelled, those whose
// cancellation did not go through, and why the step's pending runs could not
// be listed (`unlisted`, peersUnlisted's answer). `keep` is true when any of
// them may still run: the run then keeps its open-run record, so the next
// run's cleanup (or stop) cancels the peers that name it.
export function peerCancellationOutcome(verdict, cancelled, unlisted) {
  const done = cancelled.filter((x) => x.exit === 0).map((x) => x.run_id);
  const open = cancelled.filter((x) => x.exit !== 0).map((x) => x.run_id);
  let { detail } = verdict;
  if (done.length) detail = `${detail}; cancelled the step's pending peer run(s) ${done.join(', ')}`;
  if (open.length) detail = `${detail}; could not cancel the step's pending peer run(s) ${open.join(', ')}, so the run keeps its open-run record for the next run's cleanup`;
  if (unlisted) detail = `${detail}; the step's pending peer runs could not be listed (${unlisted}), so the run keeps its open-run record for the next run's cleanup`;
  return { verdict: { ...verdict, detail }, keep: open.length > 0 || Boolean(unlisted) };
}

// C127 — what settling a step's abandoned peers leaves (driver.mjs
// settleAbandonedPeers), in the serial run and in a lane alike. Settled runs
// pass. A run whose cancellation did not go through may still run: the run
// keeps its open-run record (`keep`), as on the failure path. A run that was
// not settled (a completed answer no synthesis took, a refusal) keeps its
// pending row, which the policy halts on until it is settled. Either halts
// the step for the owner, with the command to run; so does a run the look
// listed twice (`conflicts`), which was neither cancelled nor settled.
// The engineer peer-runner command a halt names for the owner to run by hand.
const shellWord = (x) => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${String(x).replace(/'/g, "'\\''")}'`);
export function peerRunnerCommand(roots, args) {
  return ['node', join(roots.engineer, 'scripts', 'peer-runner.mjs'), ...args].map(shellWord).join(' ');
}

const resultText = (r) => (r && typeof r === 'object' ? (r.reason ?? r.status ?? JSON.stringify(r)) : String(r ?? 'no answer'));
export function peerSettlementOutcome(settlements, conflicts = []) {
  const parts = [];
  let keep = conflicts.length > 0;
  for (const x of settlements) {
    if (x.cancel?.exit !== 0) {
      keep = true;
      parts.push(`peer run ${x.run_id} could not be cancelled (${resultText(x.cancel?.result)}), so the run keeps its open-run record for the next run's cleanup${x.command ? `: ${x.command}` : ''}`);
    } else if (x.settle?.exit !== 0) {
      parts.push(`peer run ${x.run_id} on ${x.workflow_id ?? x.workflow_path} was not settled (${resultText(x.settle?.result)}); its pending row stays, and the run halts on it until it is settled${x.command ? `: ${x.command}` : ''}`);
    }
  }
  if (conflicts.length) parts.push(`${conflicts.join('; ')}, so it was neither cancelled nor settled and the run keeps its open-run record`);
  const verdict = parts.length
    ? { outcome: 'halt', reason: 'owner-choice', detail: `the step finished on its report and left peer runs it had not collected: ${parts.join('; ')}` }
    : null;
  return { verdict, keep };
}

// A step closed on its report whose look cannot list its peers: they may be
// among the tasks it abandoned, so the run halts and keeps its record.
export function reportClosePeersUnlisted(unlisted, id) {
  return {
    outcome: 'halt', reason: 'owner-choice', subtaskId: id ?? null,
    detail: `the step finished on its report with background tasks pending, and its peer runs could not be listed (${unlisted}), so the run keeps its open-run record for the next run's cleanup`,
  };
}

// The step line's note of a close on a report: the tasks it abandoned.
export function abandonedText(w) {
  if (w.reportEof !== true) return '';
  const names = (w.abandonedBackground ?? []).map((t) => t.task_id ?? '?');
  return ` closed-on-report${names.length ? ` abandoned=${names.join(',')}` : ''}${w.reportTeardown ? ` (${w.reportTeardown})` : ''}`;
}

/**
 * Run the macro with lanes until it completes, halts or is interrupted.
 * Resolves to the exit code `c.finish` returns.
 *
 * @param c  what driver.mjs's start resolved: { repoRoot, options, env, out, now, roots, pinned, remotes,
 *           stateRoot, token, record, runId, runDir, run, mainRoot, macroId, view (observed under the locks),
 *           driverLock, macroLock, locks (the run's lock handles: a lane's lock joins them while it is held),
 *           finish(status, d, lanes), markLingering(), keepOpenRecord(), setLastSessionId(id),
 *           reportLanding(view, seq, runTask) (a promise: the report runs in a child, through runTask),
 *           landing(), interrupted(), onInterrupt(fn), groupsInFlight(fn) (fn lists the groups the
 *           driver's exit kills), observeAsync(args, { offLoop }), offLoop (offloop.mjs's, a test seam),
 *           startWorker, terminateGroup, helpers: { provenanceProblem, newPendingRuns, newPendingTargets },
 *           test seams: wakeIntervalMs (WAKE_INTERVAL_MS), quietMs (how long a parked lane's digest stays
 *           unchanged before it is judged; the wake interval by default), laneBusy(id, view) (whether a
 *           persona operation is open in the lane; by default, its engineer record written outside the run
 *           less than the quiet period ago), resolveRoots (the drift check) }
 */
export async function runLanes(c) {
  const { repoRoot, options, env, out, now, roots, pinned, stateRoot, runId, runDir, run, macroId, record, mainRoot } = c;
  // No look the run takes refreshes an index (ADR-0068 Decision 1, item 6):
  // the wake digest reads a parked lane's index, and the run's own looks must
  // not wake it.
  const lookEnv = { ...env, GIT_OPTIONAL_LOCKS: '0' };
  const N = options.lanes;
  const home = laneHome(repoRoot);
  const commonDir = home.problem ? null : join(home.mainRoot, '.git');
  const baseline = c.view.macro?.fm?.git_baseline?.branch ?? null;
  const wakeMs = c.wakeIntervalMs ?? WAKE_INTERVAL_MS;
  const quietMs = c.quietMs ?? wakeMs;
  const laneBusy = c.laneBusy ?? ((id, view) => childWrittenOutside(id, view));
  const resolveRootsNow = c.resolveRoots ?? resolveRoots;
  // No removal takes what the run needs (Decision 2).
  const protect = [repoRoot, runDir, stateRoot.root];
  const budget = createBudget({
    maxSteps: options.maxSteps, maxCostUsd: options.maxCostUsd, stepBudgetUsd: options.stepBudgetUsd,
    stepTimeoutSec: options.stepTimeoutSec,
  });
  const throttle = createThrottleState();
  const lanes = new Map(); // subtask id → { path, laneId, branch, subtaskId, state, lock }
  const report = new Map(); // subtask id → what the final report says of its lane
  const started = new Set(); // the lanes that stepped in this run (the throttle gates their first step only)
  const unused = new Set(); // the lanes this run created that no step has used yet (Decision 5)
  const inflight = new Map(); // seq → the step in flight
  const ended = []; // steps whose worker ended, not yet settled here
  const halts = []; // the run-wide halts the run met (the first drains it)
  // ADR-0068 Decision 1 — the parked lanes: subtask id → the park record the
  // run keeps (parks.mjs), `kept` false when the macro's records could not
  // take it. The markers the run wrote before a lane's creation or spawn:
  // subtask id → record id. The lanes laneBusy held back until the next tick.
  const parked = new Map();
  const markers = new Map();
  const busy = new Set();
  let busyDue = false;
  // Per parked lane, its wake digest as the tick last read it, since when,
  // and the digest it was last judged at (the park's own, at first).
  const seen = new Map();
  // Parked lanes to judge again before the next decision: a release, or a
  // digest that changed and has stayed so for a whole interval.
  const candidates = new Set();
  // ADR-0068 Decision 1, item 6 — a persona operation open in a lane, as far
  // as the run can tell before the persona records its operations (Decision
  // 2, item 9): the lane's engineer record was written by someone other than
  // the run, after the run started and after its last step in that lane was
  // settled, less than the quiet period ago. An owner's gate resolution (its
  // clear, then its finish-verb, seconds apart) is then left to finish before
  // a worker spawns there. An operation that writes nothing for longer than
  // the quiet period is not seen: that is the persona's record of its open
  // operations, which this run does not have yet. File times are wall-clock.
  const runStartedMs = Date.now();
  const ownWrites = new Map(); // subtask id → when the run settled its lane's last step (wall clock)
  const childWrittenOutside = (id, view) => {
    const p = view?.children?.[id]?.path ?? lastGlobal?.children?.[id]?.path ?? null;
    if (!p) return false;
    let mtime;
    try { mtime = statSync(p).mtimeMs; } catch { return false; }
    return mtime > Math.max(runStartedMs, ownWrites.get(id) ?? 0) && Date.now() - mtime < quietMs;
  };
  let tickTimer = null;
  let quietTimer = null;
  // The last look of the driver's checkout that read the macro: what a halt's
  // scope, a lane with no worktree and the wake digest are judged from.
  let lastGlobal = c.view;
  const loaded = {};
  let forced = new Map();
  let draining = null;
  let seq = 0;
  let finalizeAttempted = false;
  // C128 — the run's one list of waiting subtasks: the driver's, which its
  // looks before the scheduler (before the locks, under them, and the first
  // report) have fed, so nothing they found is lost here.
  let waiting = c.waiting?.() ?? [];
  let throttleNote = null;
  let resetTimer = null;

  // Wake-ups: a step's end, a rate-limit event that changes the throttle,
  // the throttle's reset, a signal, and the tick that found a parked lane to
  // judge again (ADR-0068 Decision 1, item 6). One pending wake-up is kept,
  // so an event during a look is not lost.
  let woken = false;
  let waiter = null;
  const wake = () => {
    woken = true;
    if (waiter) { const w = waiter; waiter = null; w(); }
  };
  const nextEvent = async () => {
    if (!woken) await new Promise((r) => { waiter = r; });
    woken = false;
  };
  const onRateLimit = (info) => {
    const nowSec = now() / 1000;
    const was = judgeThrottle(throttle, nowSec).state;
    applyRateLimitEvent(throttle, info);
    if (judgeThrottle(throttle, nowSec).state !== was) wake();
  };

  // The synchronous lane and peer work, in a child (offloop.mjs): { value } or
  // { error }. Each task's group goes on the locks it acts under, as a
  // worker's does: the macro lock, and the lock of the checkout it acts in —
  // a lane's while the run holds it, otherwise the driver's.
  // A task group that outlived SIGKILL keeps the run's locks, and nothing
  // more starts beside it: it drains the run (ADR-0068 Decision 1, item 1).
  const tasks = createTaskRunner({
    offLoop: c.offLoop ?? defaultOffLoop,
    onLingering: () => {
      c.markLingering();
      drain({ reason: 'worker-failed', detail: 'a process of an off-loop task\'s group is still there after SIGKILL; the run keeps its locks until that group is empty', scope: 'run' });
    },
  });
  const lockAt = (at) => {
    const where = canonical(at);
    for (const [id, l] of lanes) if (l.lock && canonical(l.path) === where) return { lock: l.lock, lane: id };
    return { lock: c.driverLock, lane: null };
  };
  const holdAt = (at) => async (group) => {
    const { lock, lane: laneId } = lockAt(at);
    const added = [];
    try {
      for (const l of [c.macroLock, lock]) added.push(l.addWorkerGroup({ ...group, lane: laneId, cwd: at }));
    } catch (e) {
      for (const a of added) a.release();
      throw e;
    }
    return added;
  };
  const runAt = (at) => (name, args, o = {}) => tasks.run(name, args, { ...o, hold: holdAt(at) });
  const task = (name, args, at = repoRoot) => runAt(at)(name, args, { env, cwd: at });
  // After an interrupt a look reads what is here, without the fetch. Every
  // look feeds the run's list of waiting subtasks as it returns, before its
  // report (C128): an interrupt, an error or a later look can then no longer
  // keep what it found from the list, and one that failed leaves what the
  // list holds unknown (`reconcileWaiting`).
  const look = async (checkout, fetch) => {
    const v = await c.observeAsync({ repoRoot: checkout, roots, macroId, fetch: fetch && !c.interrupted(), env: lookEnv }, { offLoop: runAt(checkout) });
    feed(v, false);
    return v;
  };
  // A worker whose host has returned its result (`e.w`) has had its group
  // emptied, and the loop has not settled it yet: nothing signals that group
  // id again, which may be another process's group by then. One that outlived
  // SIGKILL (`lingering`) is still the run's.
  const running = (e) => !e.w;
  c.onInterrupt(() => {
    for (const e of inflight.values()) if (running(e)) e.worker?.abort('interrupted');
    tasks.interrupt();
    wake();
  });
  // What the driver's exit kills when the run could not unwind: every worker
  // and task group in flight.
  c.groupsInFlight?.(() => [...[...inflight.values()].filter((e) => running(e) || e.w.groupTeardown === 'lingering').map((e) => e.worker?.pid), ...tasks.groups()].filter(Number.isInteger));
  const pathOf = (id) => {
    try { return home.problem ? null : lanePath(home, macroId, id); } catch { return null; }
  };
  // A look that could not list the claims, once more: a child archived
  // between the scan and its read is a legitimate transition.
  const lookGlobal = async () => {
    let v = await look(repoRoot, true);
    if (v.claimsError) v = await look(repoRoot, true);
    if (!v.lookError && !v.macroLookupError && v.macro) lastGlobal = v;
    return v;
  };

  const lane = (id) => {
    if (!report.has(id)) report.set(id, { subtask_id: id, path: null, branch: null, state: null, note: null, last_step: null, halt: null, park: null, removal: null });
    return report.get(id);
  };
  // A run-wide halt (an interrupt too): the first one drains the run; the
  // marker of its lane's step, if it has one, is settled.
  const drain = (h) => {
    const hh = asHalt(h);
    halts.push(hh);
    if (hh.subtaskId) {
      unmark(hh.subtaskId);
      if (report.has(hh.subtaskId) || lanes.has(hh.subtaskId)) {
        lane(hh.subtaskId).halt = { reason: hh.reason, detail: hh.detail };
        if (hh.proposals?.length) lane(hh.subtaskId).proposals = hh.proposals;
      }
    }
    if (!draining) {
      draining = hh;
      run.status = 'draining';
      writeRun(runDir, run);
      out(`■ ${hh.subtaskId ? `lane ${hh.subtaskId}: ` : ''}${hh.reason} — ${hh.detail}`);
      if (inflight.size > 0) out(`  draining: ${inflight.size} step(s) in flight run to their end; nothing new starts`);
    } else {
      out(`  also ${hh.subtaskId ? `lane ${hh.subtaskId}: ` : ''}${hh.reason} — ${hh.detail}`);
    }
  };
  // ADR-0068 Decision 1, item 1 — a halt by its scope: a lane halt parks its
  // lane, any other drains the run. `hint` is a look of the lane the halt
  // was judged from, which the park's fingerprint reuses; `facts` the
  // decision's look, whose macro and child the fingerprint takes.
  const halted = async (h, hint = null, facts = null) => {
    const hh = asHalt(h);
    if (haltScope(hh, lastGlobal) === 'lane') return park(hh, hint, facts);
    return drain(hh);
  };

  // -------------------------------------------------------------------
  // Kept parks (ADR-0068 Decision 1, items 2 to 5; parks.mjs).

  const at = () => new Date(now()).toISOString();
  const subtaskOf = (id) => (lastGlobal?.macro?.fm?.plan?.subtasks ?? []).find((s) => s?.id === id) ?? null;
  const parkRecord = (id, fields) => ({
    schema: PARK_SCHEMA, record_id: newRecordId(), macro_id: macroId, subtask_id: id, run_id: runId, run_dir: runDir, at: at(), ...fields,
  });
  // The run's changes to its kept parks, one at a time and in the order the
  // run made them (parks.mjs's lock orders them against other processes): a
  // settlement a drain started is done before any later write of that lane,
  // and the run's end awaits the last one.
  let parkOps = Promise.resolve();
  const parkOp = (fn) => {
    const p = parkOps.then(fn);
    parkOps = p.then(() => {}, () => {});
    return p;
  };
  // A marker before a lane's creation or its step's spawn: a run that dies
  // after it leaves the lane for the next run to judge from the ledger.
  const mark = async (id, state, fields = {}) => {
    const rec = parkRecord(id, { state, ...fields });
    const w = await parkOp(() => writePark(mainRoot, macroId, rec, { expect: markers.get(id) ?? null }));
    if (!w.ok) throw new Error(`subtask ${id}'s park record changed under the run (${w.current.state === 'ok' ? `record ${w.current.record.record_id}, ${w.current.record.state}` : w.current.error ?? w.current.state})`);
    markers.set(id, rec.record_id);
  };
  const unmark = (id) => {
    const rid = markers.get(id);
    if (!rid) return Promise.resolve();
    markers.delete(id);
    return parkOp(() => deletePark(mainRoot, macroId, id, { expect: rid, event: 'settled', fields: { run_id: runId } })).catch((e) => {
      out(`⚠ lane ${id}: its step's marker could not be removed (${e?.message ?? e}); the next run judges it from this run's ledger`);
    });
  };
  // A look that could not read what a park's fingerprint hashes (the look,
  // the macro, the subtask's child): its facts are never the owner's change.
  const unreadable = (v, id) => !v || Boolean(v.lookError || v.macroLookupError) || !v.macro || v.children?.[id]?.location === 'error';
  // The lane's fingerprint now, with the form it was taken in: its own look
  // while a worktree is at its path, else the driver's checkout's with the
  // branch tip in the main repository. With `facts` (the look a halt was
  // decided from) the macro and the child are that look's, so a gate the
  // owner clears while the park is recorded is a change after the park, never
  // part of it. None (`unread`) when what it hashes could not be read.
  // `fresh` when every fact it hashes was read by this call, so a digest read
  // before it is one it has judged (`watch`); `fresh` names a look the
  // caller took for it as this call's own.
  const fingerprintNow = async (id, hint = null, facts = null, { fresh: hintFresh = false } = {}) => {
    const p = pathOf(id);
    const same = (v, where) => v && !v.lookError && v.repoRoot && canonical(v.repoRoot) === canonical(where);
    const usable = facts && !unreadable(facts, id) ? facts : null;
    if (p && existsSync(p)) {
      const reused = same(hint, p);
      const look1 = reused ? hint : await look(p, false);
      const v = usable && !look1.lookError ? { ...look1, macro: usable.macro, children: usable.children } : look1;
      if (unreadable(v, id)) return { form: 'lane', fingerprint: null, unread: true, fresh: false };
      return { form: 'lane', fingerprint: parkFingerprint(v, id, { form: 'lane' }), fresh: !usable && (!reused || hintFresh) };
    }
    const fromHint = same(hint, repoRoot) && hint.macro;
    const g = usable ?? (fromHint ? hint : lastGlobal);
    if (unreadable(g, id)) return { form: 'no-worktree', fingerprint: null, unread: true, fresh: false };
    const branch = (g.macro.fm?.plan?.subtasks ?? []).find((s) => s?.id === id)?.branch ?? null;
    return { form: 'no-worktree', fingerprint: parkFingerprint(g, id, { form: 'no-worktree', branch, branchTip: refTip(commonDir, branch) }), fresh: !usable && Boolean(fromHint) && hintFresh };
  };
  // What resolves a park, for halt.json: the pointer, the record change or
  // the release, then the relaunch.
  // A claim problem's repair, /orchestrator:next, is refused beside a live
  // run, and the claiming workflow lies outside the lane's record (Decision 1,
  // items 3 and 4).
  const resolutionOf = (h, id, releaseOnly) => ({
    pointer: h.pointer ?? null,
    change: h.claim ? `stop the run, re-attach the claiming workflow with /orchestrator:next ${id} or archive it with /engineer:resume on its branch`
      : releaseOnly ? null : 'a change to the lane\'s record picks it up again: clear its gate, record a next step, commit, or move its branch',
    release: releaseCommand({ subtaskId: id, macroId, repoRoot }),
    relaunch: relaunchCommand({ macroId, lanes: N, repoRoot }),
    release_only: releaseOnly,
  });
  const showPark = (rec) => ({
    reason: rec.reason, detail: rec.detail, pointer: rec.pointer ?? null, since: rec.since ?? rec.at ?? null,
    run_id: rec.run_id ?? null, release_only: rec.release_only === true, resolution: rec.resolution ?? null, kept: rec.kept !== false,
  });
  // The wake digest of a parked lane (Decision 1, item 6): files only, no
  // content but HEAD's, and the status of a lane parked dirty-tree.
  const digestOf = (id, reason = parked.get(id)?.reason) => {
    const p = pathOf(id);
    const gd = p && existsSync(p) ? laneGitDir(p) : null;
    const branch = subtaskOf(id)?.branch ?? null;
    // A lane parked dirty-tree is resolved by cleaning its tree, which none of
    // the files above may show: its status, then, with no optional lock.
    const status = gd && reason === 'dirty-tree'
      ? (spawnSync('git', ['-C', p, 'status', '--porcelain', '--untracked-files=normal'], { env: lookEnv, encoding: 'utf8', timeout: 10_000 }).stdout ?? '-')
      : '';
    return [
      statKey(lastGlobal?.macro?.path), statKey(lastGlobal?.children?.[id]?.path),
      ...(gd ? [textOf(join(gd, 'HEAD')), statKey(join(gd, 'index'))] : ['no worktree']),
      refTip(commonDir, branch) ?? '-', status,
    ].join('|');
  };
  // A parked lane watched from now: `judged` the digest read before the facts
  // its fingerprint was taken from, or null when those facts came from a look
  // before the park (the decision's): a change made between that look and
  // this digest is then not taken as judged, and the tick has the lane judged
  // once its digest has been quiet for a whole interval. `base` is what a
  // change is told from until it is judged.
  const watch = (id, judged = null) => {
    const d = digestOf(id);
    seen.set(id, { digest: d, at: now(), judged, base: judged ?? d });
  };

  async function park(h, hint = null, facts = null) {
    const id = h.subtaskId;
    // A second halt of a lane already parked: the first stands.
    if (parked.has(id)) { await unmark(id); return; }
    // The digest before the fingerprint's facts, judged only when those facts
    // are read now; one read after facts taken earlier would count a change
    // between them as judged (`watch`).
    const d0 = digestOf(id, h.reason);
    const fp = await fingerprintNow(id, hint, facts);
    const before = fp.fresh ? d0 : null;
    const releaseOnly = h.releaseOnly === true || fp.fingerprint === null;
    const rec = parkRecord(id, {
      state: 'parked', reason: h.reason, detail: h.detail, pointer: h.pointer ?? null, proposals: h.proposals ?? [],
      release_only: releaseOnly, form: fp.form, fingerprint: fp.fingerprint, fingerprint_version: PARK_FINGERPRINT_VERSION,
      lane_path: pathOf(id), branch: subtaskOf(id)?.branch ?? null, seq: h.seq ?? null, step_kind: h.stepKind ?? null,
      since: at(), resolution: resolutionOf(h, id, releaseOnly),
    });
    let kept = true;
    const expect = markers.get(id) ?? null;
    try {
      const w = await parkOp(() => writePark(mainRoot, macroId, rec, { expect }));
      if (!w.ok && expect !== null && w.current.state === 'absent') {
        // The owner released the marker (a dead run's) while the park was
        // recorded: the release stands, and the lane is judged afresh.
        markers.delete(id);
        appendLaneEvent(runDir, { event: 'resumed', subtask_id: id, why: 'released before its park was recorded', record_id: expect, run_id: runId, at: at() });
        out(`  lane ${id}: released while its park was recorded; it is judged afresh`);
        return;
      }
      if (!w.ok) {
        kept = false;
        out(`⚠ lane ${id}: its park could not be kept in the macro's records (${w.current.state === 'ok' ? `record ${w.current.record.record_id} is there` : w.current.error ?? w.current.state})`);
      }
    } catch (e) {
      kept = false;
      out(`⚠ lane ${id}: its park could not be kept in the macro's records (${e?.message ?? e})`);
    }
    markers.delete(id);
    parked.set(id, { ...rec, kept });
    watch(id, before);
    Object.assign(lane(id), { halt: { reason: h.reason, detail: h.detail }, park: showPark({ ...rec, kept }) });
    if (h.proposals?.length) lane(id).proposals = h.proposals;
    appendLaneEvent(runDir, { event: 'parked', subtask_id: id, reason: h.reason, detail: h.detail, record_id: rec.record_id, form: fp.form, fingerprint: fp.fingerprint, release_only: releaseOnly, run_id: runId, at: rec.since });
    out(`■ lane ${id}: ${h.reason} — ${h.detail}`);
    out(`  other lanes continue${releaseOnly ? `; this lane waits for the owner's release: ${rec.resolution.release}` : ''}`);
    publish();
  }

  // A parked lane picked up again: its kept park ends, it is a new lane for
  // the throttle, and a lane whose worktree is there is reconciled first,
  // whether the run holds it or not: its rows (Decision 5: its ownership
  // lock, its identity, its branch) are judged again before its next step, as
  // at a run's start. Resolves to false when it parked again, or the run
  // drains.
  async function resume(id, why) {
    const rec = parked.get(id);
    if (why !== 'released' && rec?.kept && rec.record_id) {
      try {
        await parkOp(() => deletePark(mainRoot, macroId, id, { expect: rec.record_id, event: 'resumed', fields: { run_id: runId, why } }));
      } catch (e) {
        out(`⚠ lane ${id}: its kept park could not be removed (${e?.message ?? e})`);
      }
    }
    parked.delete(id);
    seen.delete(id);
    started.delete(id);
    appendLaneEvent(runDir, { event: 'resumed', subtask_id: id, why, record_id: rec?.record_id ?? null, run_id: runId, at: at() });
    out(`  lane ${id}: picked up again (${why})`);
    Object.assign(lane(id), { park: null, halt: null, resumed_at: at() });
    const p = pathOf(id);
    // A lane the run holds whose worktree went while it was parked: let it
    // go, so its next step creates it again (or its rows say why not).
    const was = lanes.get(id);
    if (was && !existsSync(was.path)) {
      letGo(was);
      lanes.delete(id);
    }
    if (p && existsSync(p)) {
      const r = await task('reconcileLane', { home, checkout: repoRoot, macroId, view: lastGlobal, baseline, subtaskId: id, runId, runDir, nowMs: now() });
      if (r.error) {
        await halted({ reason: 'owner-choice', detail: `subtask ${id}'s lane ${p} could not be reconciled: ${r.error}`, subtaskId: id });
        return false;
      }
      for (const line of r.value.reports ?? []) out(`  ${line}`);
      const held = lanes.get(id) ?? null;
      const same = held && r.value.lane && canonical(held.path) === canonical(r.value.lane.path);
      // A held lane its rows no longer give the run, or give at another
      // path, is let go: the run steps only a lane its rows hold.
      if (held && !same) {
        letGo(held);
        lanes.delete(id);
      }
      if (same) {
        // Held, and still the run's: its lock stays the one it holds.
        lanes.set(id, { ...held, ...r.value.lane, state: r.value.lane.state === 'adopt' ? 'adopted' : r.value.lane.state, lock: held.lock });
        Object.assign(lane(id), { path: r.value.lane.path, branch: r.value.lane.branch, note: 'resumed' });
      } else if (r.value.lane) {
        try {
          lanes.set(id, { ...r.value.lane, state: r.value.lane.state === 'adopt' ? 'adopted' : r.value.lane.state, lock: await holdFor(r.value.lane) });
          Object.assign(lane(id), { path: r.value.lane.path, branch: r.value.lane.branch, note: 'resumed' });
        } catch (e) {
          await halted({ reason: 'owner-choice', detail: `the lane ${p}: ${e instanceof LockHeldError ? e.message : `its worktree lock could not be taken (${e?.message ?? e})`}`, subtaskId: id, releaseOnly: true });
          return false;
        }
      }
      for (const h of r.value.halts ?? []) await halted(h);
      if (parked.has(id) || draining) return false;
    }
    publish();
    return true;
  }

  // Judge parked lanes again (R9: only in the loop's body, every ended step
  // settled, before the decision): the tick's candidates, or, as the run
  // would end, every one. A lane whose record the owner released, or whose
  // fingerprint changed, is picked up. Resolves to whether one was.
  async function reconsider(all = false) {
    const ids = all ? [...parked.keys()] : [...candidates].filter((id) => parked.has(id));
    candidates.clear();
    let resumed = false;
    // Every digest before any look: what each look judged is at least that,
    // and a change after it shows at a later tick.
    const digests = new Map(ids.map((id) => [id, digestOf(id)]));
    // A lane with no worktree is judged from a fresh look of the driver's
    // checkout (its subtask's fields), taken once for all of them.
    let global = null;
    const hintFor = async (id) => {
      const p = pathOf(id);
      if (p && existsSync(p)) return null;
      if (!global) {
        global = await look(repoRoot, false);
        if (!global.lookError && !global.macroLookupError && global.macro) lastGlobal = global;
      }
      return global;
    };
    for (const id of ids) {
      if (c.interrupted() || draining || ended.length > 0) break;
      const rec = parked.get(id);
      if (!rec) continue;
      let why = null;
      if (rec.kept) {
        let cur;
        try { cur = readPark(mainRoot, macroId, id); } catch { cur = null; }
        if (cur && (cur.state === 'absent' || (cur.state === 'ok' && cur.record.record_id !== rec.record_id))) why = 'released';
      }
      if (!why && rec.state === 'parked') {
        // Judged at the digest read before the look, from before the look: a
        // tick during it that reads a later digest makes the lane a candidate
        // only once that digest has been quiet for a whole interval, never
        // for the digest this look judges. A look that could not be read
        // judged nothing, and is not asked again until the digest changes
        // either: the end's last pass, or a later change, judges the lane
        // again (a look asked at every tick would keep the run from ever
        // reaching its end).
        const s = seen.get(id);
        if (s) s.judged = digests.get(id);
        const fp = await fingerprintNow(id, await hintFor(id), null, { fresh: true });
        if (compareKept(rec, fp) === 'changed') why = 'its record changed';
      }
      if (why && await resume(id, why)) resumed = true;
    }
    return resumed;
  }

  // The tick (Decision 1, item 6): a release, a parked lane quiet for a whole
  // interval since its digest changed, or a lane laneBusy held back, wakes
  // the loop. It reads files only, and never judges: the loop's look does.
  const pollWake = () => {
    // A lane laneBusy held back is due again once a tick has passed; the loop
    // lets it go at its next decision. The tick never clears it itself: one
    // during the busy refusal's own cleanup would leave nothing to retry it,
    // and the run would end beside it.
    let found = busy.size > 0;
    if (found) busyDue = true;
    const t = now();
    for (const [id, rec] of parked) {
      if (rec.kept) {
        const cur = readPark(mainRoot, macroId, id);
        if (cur.state === 'absent' || (cur.state === 'ok' && cur.record.record_id !== rec.record_id)) {
          candidates.add(id);
          found = true;
          continue;
        }
      }
      const s = seen.get(id);
      if (!s) continue;
      const d = digestOf(id);
      if (d !== s.digest) { s.digest = d; s.at = t; continue; }
      if ((s.judged === null || d !== s.judged) && t - s.at >= quietMs) { candidates.add(id); found = true; }
    }
    return found;
  };
  const tick = () => {
    tickTimer = null;
    try {
      if (pollWake()) wake();
    } catch { /* the next tick, or the run's end, reads it again */ }
    tickTimer = setTimeout(tick, wakeMs);
  };
  const stopTick = () => {
    clearTimeout(tickTimer);
    tickTimer = null;
    clearTimeout(quietTimer);
    quietTimer = null;
  };
  // How long the run must wait before it ends, in ms, or 0: a parked lane
  // whose digest changed less than the quiet period ago may be in the middle
  // of its resolution. The wait wakes the loop by itself, whatever the tick.
  const quietLeft = () => {
    const t = now();
    let left = 0;
    for (const [id, s] of seen) {
      if (!parked.has(id)) continue;
      const d = digestOf(id);
      if (d !== s.digest) { s.digest = d; s.at = t; }
      // A lane not judged since its park waits only on a change since then:
      // the end's last pass judges it.
      if (d !== (s.judged ?? s.base) && t - s.at < quietMs) {
        const r = quietMs - (t - s.at);
        left = left === 0 ? r : Math.min(left, r);
      }
    }
    return left;
  };
  // The run's lane entries in run.json while it lives, for `status`.
  const publish = () => {
    run.lanes = { n: N, lanes: lanesSummary() };
    writeRun(runDir, run);
  };

  // A park a dead run left (`creating`, `in-flight`), judged from its ledger
  // before the run acts on the lane: a verdict that drains, an interrupt, an
  // error or a pass ends it; a lane verdict, or none, parks the lane.
  async function recover(rec) {
    const id = rec.subtask_id;
    const fin = rec.state === 'in-flight' ? stepVerdict(rec.run_dir, rec.seq) : null;
    const outcome = fin?.outcome ?? null;
    // The scope the run judged the verdict in, recorded on its finished line;
    // a line from before it has its reason and teardown only.
    const scope = fin?.halt_scope ?? null;
    const runWide = scope ? scope !== 'lane' : (RUN_WIDE_REASONS.includes(outcome) || fin?.group_teardown === 'lingering');
    if (outcome === 'ok' || outcome === 'interrupted' || outcome === 'error' || runWide) {
      await parkOp(() => deletePark(mainRoot, macroId, id, { expect: rec.record_id, event: 'settled', fields: { run_id: runId, recovered_from: rec.run_id, outcome } }));
      return;
    }
    markers.set(id, rec.record_id);
    const what = rec.state === 'creating' ? `the creation of its lane in run ${rec.run_id}` : `step ${rec.seq} of run ${rec.run_id} (${rec.step_kind ?? '?'})`;
    await park({
      reason: outcome ?? 'owner-choice', subtaskId: id, seq: rec.seq ?? null, stepKind: rec.step_kind ?? null,
      detail: outcome
        ? `${what} ended ${outcome}, and that run stopped before it recorded the park`
        : `${what} ended with no verdict: that run stopped before it judged it, so what it did is not known`,
    });
  }

  // At a run's start (Decision 1, item 3), before reconciliation: every park
  // the macro keeps. One that no longer applies retires; one the owner's
  // `--lane <id> --next` names ends; a marker a dead run left is judged from
  // its ledger; a park whose fingerprint is unchanged, or cannot be compared,
  // parks its lane again at once, and one whose record changed is picked up.
  async function loadKept() {
    const r = readParks(mainRoot, macroId);
    if (r.problem) {
      drain({ reason: 'owner-choice', detail: `the macro's kept parks cannot be read (${r.problem})`, scope: 'run' });
      return;
    }
    const retire = new Set(retiring(r.records, c.view));
    for (const e of r.records) {
      const id = e.subtaskId;
      // What this run read there: a record id, or the bytes of one that
      // cannot be read; either is all that this run ends.
      const read = e.state === 'ok' ? { expect: e.record.record_id } : { expectDigest: e.digest ?? null };
      const rid = read.expect;
      if (retire.has(id)) {
        await parkOp(() => deletePark(mainRoot, macroId, id, { ...read, event: 'retired', fields: { run_id: runId } }));
        continue;
      }
      if (forced.has(id)) {
        await parkOp(() => deletePark(mainRoot, macroId, id, { ...read, event: 'forced', fields: { run_id: runId } }));
        appendLaneEvent(runDir, { event: 'resumed', subtask_id: id, why: 'forced', record_id: rid ?? null, run_id: runId, at: at() });
        out(`  lane ${id}: its kept park ends: --lane ${id} --next names it`);
        continue;
      }
      if (e.state !== 'ok') {
        const rec = {
          subtask_id: id, state: 'unreadable', record_id: null, kept: true, release_only: true, reason: 'owner-choice',
          detail: `its park record ${e.file} cannot be read (${e.error}); release it to drop the record`, pointer: e.file, since: at(),
          resolution: resolutionOf({ pointer: e.file }, id, true),
        };
        parked.set(id, rec);
        Object.assign(lane(id), { park: showPark(rec), halt: { reason: rec.reason, detail: rec.detail } });
        out(`■ lane ${id}: ${rec.reason} — ${rec.detail}`);
        continue;
      }
      const rec = e.record;
      if (rec.state !== 'parked') { await recover(rec); continue; }
      // The digest before the look the fingerprint is taken from (`watch`).
      const before = digestOf(id, rec.reason);
      const fp = await fingerprintNow(id);
      // A look that could not be read keeps the park as it is.
      const cmp = fp.unread ? 'unchanged' : compareKept(rec, fp);
      if (cmp === 'changed') {
        await parkOp(() => deletePark(mainRoot, macroId, id, { expect: rec.record_id, event: 'resumed', fields: { run_id: runId, why: 'its record changed' } }));
        appendLaneEvent(runDir, { event: 'resumed', subtask_id: id, why: `its record changed since run ${rec.run_id} parked it`, record_id: rec.record_id, run_id: runId, at: at() });
        out(`  lane ${id}: picked up again (its record changed since run ${rec.run_id} parked it)`);
        continue;
      }
      parked.set(id, { ...rec, kept: true });
      watch(id, fp.fresh ? before : null);
      Object.assign(lane(id), { park: showPark(rec), halt: { reason: rec.reason, detail: rec.detail }, ...(rec.proposals?.length ? { proposals: rec.proposals } : {}) });
      out(`■ lane ${id}: ${rec.reason} — ${rec.detail} (kept since run ${rec.run_id}${cmp === 'incomparable' ? `; release it to pick it up: ${rec.resolution?.release ?? releaseCommand({ subtaskId: id, macroId, repoRoot })}` : ''})`);
    }
  }
  const holdFor = async (l) => {
    const lock = await holdLane(l, { record, now });
    c.locks.push(lock);
    return lock;
  };
  const letGo = (l) => {
    if (!l?.lock) return;
    const i = c.locks.indexOf(l.lock);
    if (i !== -1) c.locks.splice(i, 1);
    l.lock.release();
    l.lock = null;
  };

  // Every subtask with a step in flight, the done's own included (Decision 6:
  // left alone until that step ends).
  const subtasksInFlight = () => new Set([...inflight.values()].filter((e) => e.subtaskId).map((e) => e.subtaskId));
  const driverBusy = () => [...inflight.values()].some((e) => !e.lane);

  const driftNow = async () => (seq > 0 ? driftOf(pinned, await resolveRootsNow({ env })) : []);
  // The plugin code the first worker loaded is pinned at its init, not at its
  // end: workers run at once, and a second one must load the same paths.
  const checkInit = (cwd) => (plugins) => {
    const problem = c.helpers.provenanceProblem(plugins, { pinned, repoRoot, loaded })
      ?? (cwd === repoRoot ? null : c.helpers.provenanceProblem(plugins, { pinned, repoRoot: cwd, loaded }));
    if (problem) return problem;
    for (const name of PLUGINS) {
      const p = (plugins ?? []).find((x) => x?.name === name && /@agentic-plugins$/.test(x?.source ?? '')) ?? (plugins ?? []).find((x) => x?.name === name);
      if (p?.path && !loaded[name]) loaded[name] = canonical(p.path);
    }
    return null;
  };
  // Every step that ended is settled before anything new starts, and an
  // admission that awaited (a look, a lock, the roots) asks again.
  const mustYield = () => c.interrupted() || draining || ended.length > 0;
  // The throttle's answer for a new lane now, with the workers in flight now:
  // the turn asks it, and an admission asks it again before it creates the
  // lane and before it spawns.
  const gate = (refreshable = false) => gateNewLane(throttle, { nowSec: now() / 1000, inFlight: inflight.size, refreshable });
  // Why a new lane waits, printed when it changes.
  const noteThrottle = (why) => {
    if (why && why !== throttleNote) out(`  ${why}`);
    throttleNote = why ?? null;
  };

  // ---------------------------------------------------------------------
  // One step: admitted, placed, checked, spawned.

  async function admit(s, view) {
    if (!STEP_KINDS.includes(s.kind)) throw new Error(`policy returned an unknown step kind ${s.kind}`);
    const r = budget.reserve();
    if (r.exhausted) return { halt: asHalt({ reason: 'budget', detail: r.detail }) };
    if (r.wait) return { stop: true, why: r.why };
    const reservation = r.reservation;
    // A refusal with no halt is a yield: something changed while the step was
    // admitted, and the run decides again.
    const refuse = (h) => {
      budget.settle(reservation, { spawned: false });
      return h ? { halt: asHalt(h) } : { stop: true, again: true };
    };
    try {
      const r = await launch(s, view, reservation, refuse);
      if (!r.admitted && s.subtaskId) {
        // A refusal that parks the lane keeps its marker, which the park
        // takes over, and the worktree a failed creation may have left, part
        // of the lane's fingerprint (ADR-0068 Decision 1, item 5); any other
        // settles the marker.
        const parks = Boolean(r.halt) && haltScope(r.halt, view) === 'lane';
        if (!parks) await unmark(s.subtaskId);
        // A lane this admission created and then did not use goes at once
        // (Decision 5: a yield, a throttle, a drain leaves no lane without its
        // step); an interrupted run keeps it, as it keeps every lane.
        if (!parks && unused.has(s.subtaskId) && !c.interrupted()) await removeUnused(s.subtaskId);
      }
      return r;
    } catch (e) {
      // An error before the step was in flight releases its reservation; one
      // after is the unwind's (every step in flight is settled there).
      if (!inflight.has(seq) || inflight.get(seq).reservation !== reservation) budget.settle(reservation, { spawned: false });
      throw e;
    }
  }

  async function launch(s, view, reservation, refuse) {
    const id = s.subtaskId ?? null;
    const inLane = s.lane === true;

    // A lane is created once its first step is admitted (Decision 5), and
    // only while that step may still start: a draining or throttled run
    // creates no lane. What the lane layer fails at is this lane's halt.
    // ADR-0068 Decision 1, item 6: no worker spawns into a lane with a persona
    // operation open, and no lane is created for one; the lane waits for the
    // next tick. Asked again after the creation's marker, which awaits a
    // lock, and right before the spawn.
    if (inLane && laneBusy(id, view)) {
      busy.add(id);
      return { ...refuse(null), again: false, busy: true };
    }
    let createdNow = false;
    if (inLane && !lanes.has(id)) {
      if (mustYield() || (s.newLane && !gate().start)) return refuse(null);
      const subtask = (view.macro?.fm?.plan?.subtasks ?? []).find((x) => x?.id === id);
      // The marker goes up before the creation (ADR-0068 Decision 1, item 3).
      // It awaits the park records' lock: what changed meanwhile is asked
      // again before the creation, and a refusal settles it (`admit`).
      await mark(id, 'creating', { step_kind: s.kind });
      if (mustYield() || (s.newLane && !gate().start)) return refuse(null);
      if (laneBusy(id, view)) {
        busy.add(id);
        return { ...refuse(null), again: false, busy: true };
      }
      const created = await task('createLane', { home, checkout: repoRoot, macroId, subtask, view, baseline, runId, runDir, nowMs: now() });
      const made = created.error
        ? { ok: false, failed: true, halt: { reason: 'owner-choice', detail: `subtask ${id}'s lane could not be created: ${created.error}` } }
        : created.value;
      for (const line of made.lines ?? []) out(`  ${line}`);
      // A lane exists, or may (a creation that failed part way): this run
      // created it, and no step has used it yet.
      if (made.ok || made.lane || made.failed) unused.add(id);
      if (!made.ok) {
        Object.assign(lane(id), {
          path: made.lane?.path ?? (made.failed ? pathOf(id) : null), branch: subtask?.branch ?? null,
          note: made.failed ? 'creation failed' : (made.lane ? 'created, not used' : 'never created'),
        });
        return refuse({ ...made.halt, subtaskId: id });
      }
      let lock;
      try {
        lock = await holdFor(made.lane);
      } catch (e) {
        Object.assign(lane(id), { path: made.lane.path, branch: made.lane.branch, note: 'created, not used' });
        // Another participant in the lane's lock lies outside its fingerprint.
        return refuse({ reason: 'owner-choice', detail: `the lane ${made.lane.path}: ${e instanceof LockHeldError ? e.message : `its worktree lock could not be taken (${e?.message ?? e})`}`, subtaskId: id, releaseOnly: true });
      }
      lanes.set(id, { ...made.lane, state: 'created', lock });
      createdNow = true;
      Object.assign(lane(id), { path: made.lane.path, branch: made.lane.branch, note: 'created' });
      out(`  lane ${id}: created ${made.lane.path} on ${made.lane.branch} (${made.lane.form})`);
    }
    const held = inLane ? lanes.get(id) : null;
    const cwd = inLane ? held.path : repoRoot;

    // The checks that read a checkout, on the checkout the step runs in, from
    // a fresh look at it; a lane step is judged against that look.
    // The driver's own checkout is every lane's (each done runs there): what
    // it fails drains the run (ADR-0068 Decision 1, item 1).
    const before = inLane ? await look(cwd, false) : view;
    if (mustYield()) return refuse(null);
    const own = inLane ? {} : { scope: 'run' };
    if (before.lookError) return refuse({ reason: 'owner-choice', detail: `the look at ${cwd} failed: ${before.lookError}`, subtaskId: id, ...own });
    const problem = checkoutProblem(before);
    if (problem) return refuse({ ...problem, subtaskId: id, ...own });
    if (inLane) {
      const approval = before.ready?.approval;
      if (!(approval?.status === 'approved' && approval?.hash_ok === true)) {
        return refuse({ reason: 'plan-unapproved', detail: `the plan's approval no longer holds (${approval?.status ?? 'no approval facts were read'}${approval?.status === 'approved' ? ', the plan changed since' : ''}); review it and approve it with /orchestrator:approve --workflow=${macroId}` });
      }
    }
    // A lane this admission did not create — a prepared one (row 4) — was
    // cut from the baseline as it was then: its dispatch is checked against
    // the baseline as it is now. A lane created by this admission was cut
    // from it just now, and one an admission created and did not use is gone.
    if (inLane && s.kind === 'dispatch' && !createdNow) {
      // The baseline is the run's footing, not the lane's (Decision 1, item 1).
      const fetched = await task('fetchBaseline', { checkout: repoRoot, baseline });
      if (mustYield()) return refuse(null);
      if (fetched.error) return refuse({ reason: 'owner-choice', detail: `the baseline of the prepared lane ${cwd} could not be read: ${fetched.error}`, subtaskId: id, scope: 'run' });
      const f = fetched.value;
      if (!f.ok) return refuse({ ...f.halt, subtaskId: id, scope: 'run' });
      if (before.git.head !== f.tip) {
        return refuse({ reason: 'owner-choice', detail: `the prepared lane ${cwd} (subtask ${id}, branch ${held.branch}) is at ${before.git.head?.slice(0, 12) ?? '?'}, but ${f.ref} is at ${f.tip.slice(0, 12)}: the baseline moved since the lane was cut; remove the lane and its branch, then relaunch`, subtaskId: id });
      }
    }
    // The lane's marker names this step before its worker exists (ADR-0068
    // Decision 1, item 3): a run that dies before it records the step's
    // verdict leaves the lane for the next run to judge from this ledger.
    // A done's too: a done whose worker could not spawn parks its lane. It
    // is written before the admission's last await, so every check below
    // runs after it, with nothing awaited between them and the spawn; a
    // refusal settles it (`admit`).
    if (id && (inLane || DONE_KINDS.has(s.kind))) await mark(id, 'in-flight', { seq: seq + 1, step_kind: s.kind });
    const drift = await driftNow();
    if (drift.length > 0) return refuse({ reason: 'version-drift', detail: drift.join('; ') });
    // What changed while this admission awaited: a step ended (settled
    // first), a signal, a drain, or the throttle's answer for a new lane (an
    // event, or a part that expired: a five-hour utilization dropped at its
    // reset is unknown, and holds a new lane back beside a worker in flight).
    if (mustYield()) return refuse(null);
    if (s.newLane) {
      const g = gate();
      if (!g.start) { noteThrottle(g.why); return refuse(null); }
    }
    const place = stepPlacement(s, { lanes, checkout: repoRoot, stateRoot });
    if (place.problem) return refuse({ reason: 'owner-choice', detail: place.problem, subtaskId: id });
    if (inLane && laneBusy(id, before)) {
      busy.add(id);
      return { ...refuse(null), again: false, busy: true };
    }
    // The whole per-step timeout, however long the lane took to prepare: no
    // run clock takes from it (ADR-0063 D1, amendment of 2026-10-13).
    const timeoutSec = reservation.timeoutSec;

    // Admitted.
    seq += 1;
    const mine = seq;
    if (s.forced && id) forced.delete(id);
    if (inLane) {
      started.add(id);
      unused.delete(id);
    }
    const command = renderStep(s, { macroId, runId });
    const { model, effort } = modelFor(s, { plan: options.models, override: { model: options.model, effort: options.effort } });
    const sessionId = randomUUID();
    appendStep(runDir, {
      event: 'started', seq: mine, lane: inLane ? id : null, kind: s.kind, command, subtask_id: id, forced: s.forced === true,
      session_id: sessionId, model, effort, step_budget_usd: reservation.usd, step_timeout_sec: timeoutSec, cwd,
      started_at: new Date(now()).toISOString(), fingerprint_before: inLane ? laneFingerprint(before, id) : fingerprint(before),
    });
    out(`[${mine}] ${inLane ? `lane ${id}: ` : ''}${command}${!inLane && id ? ` (subtask ${id})` : ''}${model || effort ? ` · ${model ?? 'default'}/${effort ?? 'default'}` : ''}`);
    // The lane's report names its last step, the done in the driver's checkout included.
    if (id && (inLane || report.has(id))) lane(id).last_step = { seq: mine, kind: s.kind, verb: s.verb ?? null, command, outcome: 'running' };
    const entry = { seq: mine, step: s, subtaskId: id, lane: inLane ? id : null, cwd, before, reservation, groups: [], worker: null, w: null, done: null };
    inflight.set(mine, entry);
    try {
      entry.worker = c.startWorker({
        cwd, prompt: command, stepKind: s.kind, runId, seq: mine, roots, sessionId,
        stepBudgetUsd: reservation.usd, stepTimeoutSec: timeoutSec, model, effort, rawPath: workerStreamPath(runDir, mine), env,
        remotes: c.remotes, stateBase: place.stateBase, autopilotToken: c.token, onRateLimit,
        checkInit: checkInit(cwd),
        ...(c.terminateGroup ? { terminateGroup: c.terminateGroup } : {}),
      });
    } catch (e) {
      entry.w = spawnFailure(e, sessionId);
      entry.done = Promise.resolve();
      ended.push(entry);
      wake();
      return { admitted: true };
    }
    entry.done = entry.worker.done.then((w) => { entry.w = w; ended.push(entry); wake(); });
    // The group is on the locks before it has anything to do: the macro lock
    // and the lock of the checkout it runs in, never another lane's.
    const w = entry.worker;
    if (Number.isInteger(w.pid)) {
      const group = {
        pid: w.pid, pgid: process.platform === 'win32' ? null : w.pid, fingerprint: await processFingerprint(w.pid),
        session_id: sessionId, lane: inLane ? id : null, cwd,
      };
      for (const l of [c.macroLock, inLane ? held.lock : c.driverLock]) entry.groups.push(l.addWorkerGroup(group));
    }
    w.begin();
    return { admitted: true };
  }

  // ---------------------------------------------------------------------
  // One step's end: settled, observed, verified, recorded.

  async function settle(entry) {
    const { step: s, subtaskId: id } = entry;
    const w = entry.w;
    inflight.delete(entry.seq);
    if (w.groupTeardown === 'lingering') c.markLingering();
    else for (const g of entry.groups) g.release();
    entry.groups = [];
    c.setLastSessionId(w.sessionId);
    if (s.kind === 'finalize') finalizeAttempted = true;
    if (!w.aborted && Array.isArray(w.plugins)) {
      for (const name of PLUGINS) {
        const p = w.plugins.find((x) => x?.name === name);
        if (p?.path && !loaded[name]) loaded[name] = canonical(p.path);
      }
      if (!run.loaded_plugins && Object.keys(loaded).length) run.loaded_plugins = { ...loaded };
    }
    // A step that reported no cost (killed, or a spawn error) is charged its
    // whole reservation.
    const cost = budget.settle(entry.reservation, { spawned: true, costUsd: w.costUsd });
    run.steps = budget.taken;
    run.cost_usd = budget.spent;
    run.cost_complete = budget.costComplete;
    run.accounted_seqs.push(entry.seq);

    // A look that failed, or that could not read the step's peers, once more:
    // a child archived between the scan and its read is a legitimate
    // transition (lookGlobal's rule).
    let after = await look(entry.cwd, !entry.lane);
    if (after.lookError || peersUnlisted(after, id)) after = await look(entry.cwd, !entry.lane);
    let verdict;
    // Whether this step's peers are unaccounted for: the run keeps its
    // open-run record, and the step's finished line says so, so the next
    // run's cleanup searches this step for them (dead-runs.mjs).
    let unaccounted = false;
    const keep = () => { unaccounted = true; c.keepOpenRecord(); };
    // The owner's interrupt is judged first, before a look that failed: an
    // owner stop never parks a lane (ADR-0068 Decision 1, item 1).
    if (after.lookError) keep();
    if ((c.interrupted() && !w.aborted) || w.aborted === 'interrupted') {
      verdict = asHalt({ reason: 'interrupted', detail: 'the owner interrupted the run' });
    } else if (after.lookError && w.groupTeardown !== 'lingering') {
      // A group that outlived SIGKILL is judged by verifyStep below, whatever
      // the look: it drains the run (ADR-0068 Decision 1, item 1).
      // Unverified, and its peers unknown: the run halts, and keeps its
      // open-run record, so the next run's cleanup cancels the peers that name
      // it (dead-runs.mjs).
      verdict = asHalt({ reason: 'owner-choice', detail: `the look at ${entry.cwd} after step ${entry.seq} failed (${after.lookError}); the step's result could not be verified` });
    } else {
      verdict = verifyStep({ step: s, worker: w, before: entry.before, after });
      // A look that could not read the macro, its readiness or the step's
      // child cannot account for the step's peers: the run keeps its open-run
      // record, as on a failed look, whatever the verdict says.
      if (afterUnread(after, id)) keep();
    }
    let cancelled = [];
    if (verdict && (w.aborted || verdict.reason === 'worker-failed' || verdict.reason === 'interrupted')) {
      const runIds = c.helpers.newPendingRuns(ownChildOnly(entry.before, id), ownChildOnly(after, id), id);
      if (runIds.length > 0) {
        const r = await task('cancelPeerRuns', { runIds, roots, checkout: entry.cwd }, entry.cwd);
        cancelled = r.error ? runIds.map((runId) => ({ run_id: runId, exit: null, result: r.error })) : r.value;
      }
      // A peer whose cancellation did not go through, or that the look could
      // not list, may still run: the run keeps its open-run record, so the
      // next run's cleanup (or stop) cancels it.
      const settled = peerCancellationOutcome(verdict, cancelled, after.lookError ? null : peersUnlisted(after, id));
      if (settled.keep) keep();
      verdict = settled.verdict;
    }
    // C127: a step that passed after its host closed stdin on its finished
    // report (whatever came after): the peer runs it left on its own subtask's workflows are
    // cancelled and settled, in the checkout it ran in (driver.mjs, as in the
    // serial run). The loop's next look reads what that left.
    let settlements = [];
    if (!verdict && w.reportEof === true) {
      const unlisted = peersUnlisted(after, id);
      if (unlisted) {
        keep();
        verdict = asHalt(reportClosePeersUnlisted(unlisted, id));
      } else {
        const { targets, conflicts } = c.helpers.newPendingTargets(ownChildOnly(entry.before, id), ownChildOnly(after, id), id);
        if (targets.length > 0) {
          const r = await task('settlePeerRuns', { targets, roots, checkout: entry.cwd }, entry.cwd);
          settlements = r.error
            ? targets.map((t) => ({ ...t, cancel: { exit: null, result: r.error }, settle: null, command: peerRunnerCommand(roots, ['cancel', '--run-id', t.run_id, '--repo-root', entry.cwd]) }))
            : r.value;
        }
        const o = peerSettlementOutcome(settlements, conflicts);
        if (o.keep) keep();
        if (o.verdict) verdict = asHalt({ ...o.verdict, subtaskId: id });
        // A step whose only change was the peer it left: no progress.
        else if (targets.length > 0) verdict = peersOnlyProgress({ step: s, before: entry.before, after });
      }
    }
    // The verdict as the run judges it, and its scope, recorded on the
    // finished line so the next run recovers a marker in that scope. A step
    // outside every lane (finalize, a done) is the run's; a done whose worker
    // could not spawn ran nothing, and parks its subtask's lane, waiting to
    // land (ADR-0068 Decision 1, item 1).
    const v = verdict ? { ...verdict, subtaskId: verdict.subtaskId ?? id, seq: entry.seq, stepKind: s.kind } : null;
    if (v && !entry.lane && !(DONE_KINDS.has(s.kind) && w.spawnError)) v.scope = 'run';
    const scope = v ? haltScope(asHalt(v), lastGlobal) : null;
    appendStep(runDir, {
      event: 'finished', seq: entry.seq, lane: entry.lane, ended_at: new Date(now()).toISOString(),
      exit: w.exitCode, signal: w.signal, aborted: w.aborted, abort_detail: w.abortDetail ?? null,
      spawn_error: w.spawnError, is_error: w.lastResult?.is_error ?? null, result_subtype: w.lastResult?.subtype ?? null,
      turns: w.turns, cost_usd: w.costUsd, cost_charged_usd: cost, peak_ctx: w.peakCtx, peak_pct: w.peakPct,
      context_window: w.contextWindow, permission_denials: w.denials, report: w.report, raw_truncated: w.rawTruncated,
      group_teardown: w.groupTeardown, rate_limit: w.rateLimit ?? null,
      report_eof: w.reportEof === true, closed_on_report: w.closedOnReport === true, abandoned_background: w.abandonedBackground ?? [], report_teardown: w.reportTeardown ?? null,
      peer_cancellations: cancelled, peer_settlements: settlements, peers_unaccounted: unaccounted,
      fingerprint_after: entry.lane ? laneFingerprint(after, id) : fingerprint(after),
      outcome: verdict ? verdict.reason : 'ok', halt_scope: scope,
    });
    writeRun(runDir, run);
    // What the step and its settlement wrote to the lane's record is the
    // run's own (`childWrittenOutside`).
    if (id) ownWrites.set(id, Date.now());
    const pct = w.peakPct == null ? '?' : `${(w.peakPct * 100).toFixed(1)}%`;
    out(`    [${entry.seq}]${entry.lane ? ` lane ${id}` : ''} exit=${w.exitCode ?? w.signal} cost=$${(w.costUsd ?? cost).toFixed(2)}${w.costUsd === null ? ' (unreported; budget charged)' : ''} peak=${w.peakCtx} (${pct}) denials=${w.denials.length}${abandonedText(w)}${verdict ? ` → ${verdict.reason}` : ''}`);
    if (id && report.get(id)?.last_step?.seq === entry.seq) report.get(id).last_step.outcome = verdict ? verdict.reason : 'ok';
    // A commit stands whatever the verdict on its step, and is reported; after
    // an interrupt the next run's first look reports it (Decision 7).
    const reported = !c.interrupted();
    if (reported) await c.reportLanding(after, entry.seq, runAt(repoRoot));
    // This look feeds the run's list as every look does, after an interrupt
    // too: a lane that committed while the run drains joins it, and one
    // already listed takes what this look found (C128, `reconcileWaiting`).
    feed(after, reported);
    if (v) {
      await halted(v, after);
      return;
    }
    if (id) await unmark(id);
    // ADR-0067 Decision 8 — a step that ended on its conflict gate passed;
    // the next look halts the lane on it, but a drain takes no next look, so
    // the lane keeps the proposal now, and the run's end judges it again.
    const ownerGate = id ? after.children?.[id]?.awaiting_owner?.gate : null;
    if (ownerGate) {
      const proposals = consensusProposals(after, { outcome: 'halt', reason: `awaiting-owner:${ownerGate}`, subtaskId: id });
      if (proposals.length) lane(id).proposals = proposals;
    }
    // An interrupted run keeps its lanes (Decision 6): the next one removes it.
    if (DONE_KINDS.has(s.kind) && lanes.has(id) && !c.interrupted()) await retire(id);
  }

  // A lane is removed once /orchestrator:done has recorded its subtask
  // completed, or once the run that created it ends or yields without
  // using it (`unusedLane`); the run lets go of its lock either way.
  async function retire(id, { unusedLane = false } = {}) {
    const l = lanes.get(id) ?? null;
    lanes.delete(id);
    const where = l?.path ?? lane(id).path ?? pathOf(id);
    const removed = await task('removeLane', { home, macroId, subtaskId: id, runId, runDir, nowMs: now(), ownLaneLock: l?.lock?.entry ?? null, protect });
    letGo(l);
    // A removal that failed keeps the lane: the next reconciliation judges it.
    const r = removed.error ? { outcome: 'kept', why: `its removal failed (${removed.error})` } : removed.value;
    // A creation that failed before the worktree existed left nothing.
    if (unusedLane && r.outcome === 'absent') return;
    lane(id).note = r.outcome === 'removed' ? (unusedLane ? 'removed (no step used it)' : 'removed') : `kept (${r.outcome})`;
    lane(id).removal = r.why ?? null;
    out(`  lane ${id}: ${r.outcome === 'removed' ? `removed ${where}${unusedLane ? ': no step of this run used it' : ''}` : `kept ${where}${r.why ? `: ${r.why}` : ''}`}`);
  }
  const removeUnused = (id) => {
    unused.delete(id);
    return retire(id, { unusedLane: true });
  };

  // ---------------------------------------------------------------------
  // What a turn may start.

  async function startWhatMay(d, view) {
    const res = { waitUntilSec: null, again: false };
    const room = () => N - inflight.size;
    // A refusal that parks its lane leaves the wave going (ADR-0068
    // Decision 1, item 2); one that drains the run ends it.
    const tryOne = async (s) => {
      const r = await admit(s, view);
      if (r.halt) { await halted(r.halt, null, view); return !draining && !c.interrupted(); }
      // A lane laneBusy holds back waits for the tick; the others go on.
      if (r.busy) return true;
      if (r.stop) { if (r.again) res.again = true; return false; }
      return true;
    };
    // Each lane the decision halts parks first; an aggregate halt, which
    // names no lane, drains the run, and nothing then starts.
    for (const h of d.laneHalts) {
      await halted(h, null, view);
      if (draining || c.interrupted()) return res;
    }
    // What may run this turn, beside the workers in flight, and bring a newer
    // rate-limit event: a step of a lane already started, or the driver's
    // step.
    const refreshable = d.laneSteps.some((x) => !x.newLane) || d.driverStep !== null;
    // A new lane — a lane's first step in this run, forced or not — starts
    // only through the throttle. false: it may not start now.
    const passes = () => {
      const g = gate(refreshable);
      if (g.start) { throttleNote = null; return true; }
      // Exhausted is exhausted: no wait for a reset that could not spend.
      const spentOut = budget.exhausted();
      if (spentOut && inflight.size === 0) { drain({ reason: 'budget', detail: spentOut }); return false; }
      if (g.halt) { drain({ ...g.halt, scope: 'run' }); return false; }
      if (g.waitUntilSec) res.waitUntilSec = g.waitUntilSec;
      noteThrottle(g.why);
      return false;
    };
    // The forced steps start first, and a forced new lane the throttle holds
    // back leaves the others to start; a judgment halt that persists in
    // another lane parked it above (Decision 1, item 8). Before each admission
    // the turn asks again what changed while the last one awaited.
    for (const s of d.laneSteps.filter((x) => x.forced)) {
      if (room() <= 0 || mustYield()) break;
      if (s.newLane && !passes()) continue;
      if (!(await tryOne(s))) break;
    }
    if (mustYield()) return res;
    if (d.driverStep && room() > 0) {
      const ok = await tryOne(d.driverStep);
      if (!ok || mustYield()) return res;
    }
    const steps = d.laneSteps.filter((x) => !x.forced);
    for (const s of steps.filter((x) => !x.newLane)) {
      if (room() <= 0 || mustYield()) return res;
      if (!(await tryOne(s))) return res;
    }
    for (const s of steps.filter((x) => x.newLane)) {
      if (room() <= 0 || mustYield()) return res;
      if (!passes() || !(await tryOne(s))) return res;
    }
    return res;
  }

  const armReset = (sec) => {
    clearTimeout(resetTimer);
    resetTimer = setTimeout(wake, resetDelayMs(sec, now()));
  };

  // A look's observation feeds the run's list (C128, `reconcileWaiting`,
  // `foundWaiting`): with the facts of its own report when one just ran
  // (`reported`), and otherwise with none.
  function feed(v, reported) {
    waiting = reconcileWaiting(waiting, v, foundWaiting(v, reported, c.landing()));
  }

  // The lane report, from the run's list as it stands: a lane the list no
  // longer holds waits no more.
  // Each entry's `state` is one of LANE_STATES (ADR-0068 Decision 1, item 9),
  // `note` its detail, and a parked lane's `park` its reason, since when and
  // its resolution.
  function lanesSummary() {
    for (const [id, l] of lanes) {
      const r = lane(id);
      if (!r.path) Object.assign(r, { path: l.path, branch: l.branch, note: l.state });
    }
    for (const r of report.values()) delete r.waiting;
    for (const w of waiting) lane(w.subtaskId).waiting = { branch: w.branch, reason: w.reason, commit: w.commit ?? null, sync: w.sync ?? null };
    for (const [id, r] of report) {
      if (!parked.has(id)) r.park = null;
      r.state = laneState(r, { parked: parked.has(id) });
    }
    return [...report.values()].sort((a, b) => String(a.subtask_id).localeCompare(String(b.subtask_id)));
  }

  // The halt of the first lane still parked, in plan order (Decision 1, item 9).
  const firstParked = () => {
    const order = (lastGlobal?.macro?.fm?.plan?.subtasks ?? []).map((x) => x?.id);
    const ids = [...parked.keys()].sort((a, b) => (order.indexOf(a) === -1 ? 1e9 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 1e9 : order.indexOf(b)));
    if (ids.length === 0) return null;
    const p = parked.get(ids[0]);
    return {
      outcome: 'halt', reason: p.reason, detail: p.detail, subtaskId: ids[0], ...(p.pointer ? { pointer: p.pointer } : {}),
      ...(p.proposals?.length ? { proposals: p.proposals } : {}), resolution: p.resolution ?? null,
    };
  };

  async function end(status, d = null) {
    clearTimeout(resetTimer);
    stopTick();
    // Before the run ends, any end but an interrupt, every lane it created
    // that no step used is removed (Decision 5): the backstop for an
    // admission's own removal (every refusal goes through admit today, so
    // nothing is left here unless a later path bypasses it). A parked lane's
    // worktree stays: it is part of its fingerprint (ADR-0068 Decision 1,
    // item 5). No removal starts after an interrupt.
    for (const id of [...unused]) {
      if (c.interrupted()) break;
      if (parked.has(id)) continue;
      await removeUnused(id);
    }
    const nowSec = now() / 1000;
    // `also`: the other run-wide halts the run met, then every open park
    // beside the reason (Decision 1, item 9).
    if (d) {
      const also = [
        ...halts.filter((h) => h !== d).map((h) => ({ reason: h.reason, detail: h.detail, subtask_id: h.subtaskId ?? null })),
        ...[...parked.values()].filter((p) => p.subtask_id !== d.subtaskId).map((p) => ({ reason: p.reason, detail: p.detail, subtask_id: p.subtask_id, parked: true, release_only: p.release_only === true })),
      ];
      if (also.length) d = { ...d, also };
    }
    // ADR-0067 Decision 8, items 1 and 5 — every proposal the run met, its
    // lanes' included, once each, in the halt record and its report, each
    // naming its subtask and gate. A proposal is printed only while its task
    // file is current, and a gate may be cleared, or its file retired, while
    // the run drains or goes on to complete: what the run met is judged again
    // from one look (no fetch) as it ends, halted or not, and what that look
    // cannot confirm is dropped.
    // C128 — every end, before its report is built: the run's list holds the
    // latest observation (every look feeds it as it returns, that one
    // included), and an interrupted run, which took no last look of its own,
    // confirms nothing. The halt's list is built here, from it, and nowhere
    // else: an awaiting-landing halt lists what the run's list holds, not what
    // its decision's look found.
    d = await proposalsAtEnd(() => look(repoRoot, false), d, [...report.values()]);
    if (c.interrupted()) waiting = endedUnlooked(waiting, 'the owner interrupted the run');
    if (d?.reason === 'awaiting-landing' && c.withLanding) d = c.withLanding(d, waiting);
    run.lanes = { n: N, lanes: lanesSummary() };
    run.rate_limit = throttleSnapshot(throttle, nowSec);
    // Every change to the kept parks this run started is done before its locks go.
    await parkOps;
    return c.finish(status, d, { lanes: run.lanes.lanes, rateLimit: throttleText(throttle, nowSec) });
  }

  // ---------------------------------------------------------------------
  // The run.

  try {
    out(`  lanes: up to ${N} at a time · ${throttleText(throttle, now() / 1000)}`);
    // --next with lanes is judged per lane (Forced resume).
    if (options.forcedPairs?.length) {
      const f = forcedForLanes(options.forcedPairs, c.view);
      if (f.halt) return await end('halted', f.halt);
      forced = f.forced;
    }
    // ADR-0068 Decision 1, item 3 — the kept parks, before the lanes: a
    // relaunch parks again at once each lane whose record is unchanged, and a
    // step a dead run left without its verdict parks its lane.
    if (!home.problem) {
      await loadKept();
      publish();
    }
    // Reconciliation (Decision 5), under the macro lock, from the look taken
    // under it. Each lane the run drives is held with its worktree lock. A
    // parked lane is held as any other, and its rows' halts pass it by: it
    // already waits on its kept park. A row's halt of another lane parks it.
    const rec = await reconcileLanes({ home, checkout: repoRoot, macroId, view: c.view, baseline, runId, runDir, now, env, out: (x) => out(`  ${x}`), protect });
    for (const line of rec.reports) out(`  ${line}`);
    for (const e of rec.plan?.lanes ?? []) {
      Object.assign(lane(e.subtaskId), { path: e.lane.path, branch: e.lane.branch, note: { adopt: 'adopted', prepared: 'prepared', keep: 'kept', remove: 'removed', halt: 'halted' }[e.action] ?? e.action });
    }
    for (const [id, l] of rec.lanes) {
      try {
        lanes.set(id, { ...l, state: l.state === 'adopt' ? 'adopted' : l.state, lock: await holdFor(l) });
      } catch (e) {
        if (!parked.has(id)) await halted({ reason: 'owner-choice', detail: `the lane ${l.path}: ${e instanceof LockHeldError ? e.message : `its worktree lock could not be taken (${e?.message ?? e})`}`, subtaskId: id, releaseOnly: true });
      }
    }
    for (const h of rec.halts ?? []) {
      if (h.subtaskId && parked.has(h.subtaskId)) continue;
      await halted(h);
    }
    // The wake-up tick, for the whole run (Decision 1, item 6).
    tickTimer = setTimeout(tick, wakeMs);

    for (;;) {
      // Every step that ended is settled before anything new starts.
      while (ended.length > 0) await settle(ended.shift());
      if (c.interrupted()) {
        if (inflight.size > 0) { await nextEvent(); continue; }
        return await end('halted', asHalt({
          reason: 'interrupted',
          detail: draining ? `the owner interrupted the run while it drained after ${draining.reason}: ${draining.detail}` : 'the owner interrupted the run',
          ...(draining?.subtaskId ? { subtaskId: draining.subtaskId } : {}),
        }));
      }
      if (draining) {
        if (inflight.size > 0) { await nextEvent(); continue; }
        // A lane's look after its step does not fetch, so the report holds
        // back a commit the stale tip calls ready (landing-ready.mjs), for a
        // later look that fetches; a drain takes no later look, so it takes
        // one here and reports before the run ends (C128), and the lanes it
        // reports wait as that look found them. Not after an interrupt (the
        // loop's top ends the run on it; the next run's first look reports).
        // What that look could not read leaves no freshness standing
        // (`reconcileWaiting`); an interrupt during it still leaves the run's
        // list as the look found it, for the interrupted end to judge.
        const v = await lookGlobal();
        const reported = !c.interrupted() && !v.lookError && !v.macroLookupError;
        if (reported) await c.reportLanding(v, seq, runAt(repoRoot));
        feed(v, reported);
        if (c.interrupted()) continue;
        return await end('halted', draining);
      }

      // A look the loop sets aside here (an interrupt, a step that ended) has
      // already fed the run's list, as every look does when it returns.
      // The parked lanes the tick found released, or changed and quiet since,
      // are judged before the decision (R9).
      if (candidates.size > 0) {
        await reconsider();
        if (c.interrupted() || draining || ended.length > 0) continue;
      }
      const view = await lookGlobal();
      if (c.interrupted() || ended.length > 0) continue;
      // While a done or finalize is in flight the macro is that step's to
      // change: its Stop hook moves it to the archive, and a look whose read
      // of the macro or of its readiness met the move is judged once the step
      // has ended (transient states are not halts).
      if ((view.macroLookupError || view.readyError) && driverBusy()) { await nextEvent(); continue; }
      await c.reportLanding(view, seq, runAt(repoRoot));
      // What this look reported waiting, before any branch below can halt or
      // end the run: what waits is the look's to say, not the decision's,
      // which leaves out a subtask whose step is still in flight (C128).
      feed(view, true);
      const drift = await driftNow();
      if (drift.length > 0) { drain({ reason: 'version-drift', detail: drift.join('; ') }); continue; }
      // The lanes laneBusy held back, once a tick has passed since, are
      // decided again (`pollWake`).
      if (busyDue) { busy.clear(); busyDue = false; }
      const d = decideLanes(view, {
        inFlight: subtasksInFlight(), parked: new Set([...parked.keys(), ...busy]), driverBusy: driverBusy(), lanes, started, forced, finalizeAttempted,
      });
      if (d.outcome === 'completed') {
        if (inflight.size > 0) { await nextEvent(); continue; }
        out(`[${seq + 1}] ${d.detail}`);
        return await end('completed');
      }
      if (d.outcome === 'halt') { await halted(d); continue; }

      const r = await startWhatMay(d, view);
      if (draining || c.interrupted()) continue;
      if (inflight.size > 0 || ended.length > 0) { await nextEvent(); continue; }
      if (r.waitUntilSec) {
        armReset(r.waitUntilSec);
        await nextEvent();
        continue;
      }
      if (r.again || candidates.size > 0) continue;
      // Nothing runs and nothing can start (Decision 1, item 7). A parked lane
      // in the middle of its resolution, or one laneBusy holds back, is waited
      // for; then every pending release is consumed and each parked lane's
      // fingerprint taken again, so a lane fixed without a wake-up is picked
      // up. The end lists what waits: the first lane still parked, in plan
      // order, before the idle halt.
      if (busy.size > 0) { await nextEvent(); continue; }
      const left = quietLeft();
      if (left > 0) {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(wake, left + 5);
        await nextEvent();
        continue;
      }
      if (await reconsider(true)) continue;
      if (draining || c.interrupted()) continue;
      return await end('halted', firstParked() ?? d.idle);
    }
  } catch (e) {
    // The run cannot go on: every step in flight is torn down and settled,
    // every group's entry released (a group that outlived SIGKILL keeps its
    // entries and the run's locks), and the driver records the error. The
    // markers of the steps in flight stay: their `error` verdict ends them at
    // the next run.
    clearTimeout(resetTimer);
    stopTick();
    const open = [...inflight.values()];
    for (const entry of open) if (running(entry)) entry.worker?.abort('interrupted');
    await Promise.all(open.map((entry) => entry.done ?? Promise.resolve()));
    for (const entry of open) {
      try {
        if (entry.w?.groupTeardown === 'lingering') c.markLingering();
        else for (const g of entry.groups) g.release();
        const charged = budget.settle(entry.reservation, { spawned: true, costUsd: entry.w?.costUsd ?? null });
        run.accounted_seqs.push(entry.seq);
        appendStep(runDir, { event: 'finished', seq: entry.seq, lane: entry.lane, ended_at: new Date(now()).toISOString(), aborted: entry.w?.aborted ?? 'error', cost_usd: entry.w?.costUsd ?? null, cost_charged_usd: charged, group_teardown: entry.w?.groupTeardown ?? null, outcome: 'error' });
      } catch { /* the dead-run cleanup counts what was not written */ }
    }
    run.steps = budget.taken;
    run.cost_usd = budget.spent;
    run.cost_complete = budget.costComplete;
    // C128 — the run ends without its last look: what it lists is unknown.
    waiting = endedUnlooked(waiting, `the run stopped on an error: ${e?.message ?? e}`);
    run.lanes = { n: N, lanes: lanesSummary() };
    await parkOps;
    throw e;
  }
}

/** The lines of the final report for one lane. */
export function laneBlock(l) {
  const lines = [`  lane ${l.subtask_id}${l.branch ? ` · ${l.branch}` : ''}${l.path ? ` · ${l.path}` : ''} · ${l.state ?? 'not-created'}${l.note && l.note !== l.state ? ` (${l.note})` : ''}`];
  if (l.last_step) lines.push(`      last [${l.last_step.seq}] ${l.last_step.command} → ${l.last_step.outcome}`);
  if (l.waiting) {
    const state = { ready: 'ready', 'needs-sync': 'needs a sync with the integration branch', unknown: 'freshness unknown' }[l.waiting.sync?.state];
    lines.push(`      waiting to land: ${l.waiting.branch} (${l.waiting.reason})${l.waiting.commit ? ` at ${l.waiting.commit}` : ''}${state ? ` · ${state}` : ''}`);
  }
  if (l.park) {
    // A parked lane: since when, why, and what picks it up (ADR-0068 Decision 1, item 9).
    lines.push(`      parked since ${l.park.since ?? '?'}: ${l.park.reason} — ${l.park.detail}`);
    if (l.park.pointer) lines.push(`      pointer: ${l.park.pointer}`);
    const r = l.park.resolution;
    if (r?.change && !r.release_only) lines.push(`      ${r.change}, or release it: ${r.release}`);
    else {
      if (r?.change) lines.push(`      ${r.change}`);
      if (r?.release) lines.push(`      its cause lies outside its record: release it: ${r.release}`);
    }
    if (r?.relaunch) lines.push(`      then relaunch: ${r.relaunch}`);
  } else if (l.halt) {
    lines.push(`      halted: ${l.halt.reason} — ${l.halt.detail}`);
  }
  if (l.removal) lines.push(`      ${l.removal}`);
  return lines;
}

/** The path a lane of the macro has, for a preview. */
export const plannedLanePath = (checkout, macroId, subtaskId) => {
  const home = laneHome(checkout);
  return home.problem ? null : lanePath(home, macroId, subtaskId);
};
