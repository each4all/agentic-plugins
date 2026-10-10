// plugins/orchestrator/adapters/claude/autopilot/scheduler.mjs
//
// ADR-0067 Decision 6 — the scheduler of a run with lanes (`--lanes N`, N of
// 2 or more). driver.mjs starts the run as it starts a serial one (preflight,
// locks, the dead-run cleanup, the open-run record, the first landing report)
// and hands it here; a serial run never comes here.
//
// One turn: settle every step that ended (each is observed, verified and
// recorded before anything new starts, so a halt that came with a success in
// the same turn drains the run first); look at the macro from the driver's
// checkout; decide with `decideLanes`; start what may start — forced steps,
// then the driver's step (done, finalize), then the steps of lanes already
// started, then new lanes — up to N workers in flight; then wait for the
// next event: a step's end, a rate-limit event that changes the throttle, the
// throttle's reset, a signal.
//
// Before each spawn a step reserves its budget (budget.mjs), a new lane passes
// the throttle (throttle.mjs), a lane is created once its first step is
// admitted (lanes.mjs), and the checks that read a checkout run on the
// checkout the step runs in, from a fresh look at it. A lane step is judged
// by its lane's fingerprint and its own gates (policy.mjs).
//
// A halt in any lane, an invalidated plan approval, version drift or an
// exhausted budget drains the run (W2): nothing new starts, the steps in
// flight end and are recorded (a commit still reports landing-ready), then
// halt.json records the first halt and one entry per lane, and the run exits
// 2. SIGINT, SIGTERM and SIGHUP abort every worker group instead, during a
// drain too.
//
// What runs where: the loop itself, the policy, the budget, the throttle, the
// locks and the ledger run here, in process. Everything synchronous that
// reads or writes outside the driver runs in a child process (offloop.mjs),
// so that while it runs every worker's stream, timeout and abort, and every
// signal, are still served: a look, a lane's creation and removal, a prepared
// lane's baseline check, the landing-ready report and a peer run's
// cancellation. A lane-layer failure there is that lane's, never the run's:
// a creation that fails is the lane's halt (it drains), a removal that fails
// keeps the lane. The reconciliation before the loop runs in process, with no
// worker in flight.
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
// step used is removed. An interrupted run keeps its lanes.

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { createBudget } from './budget.mjs';
import { holdLane, laneHome, lanePath, reconcileLanes, stepPlacement } from './lanes.mjs';
import { appendStep, LockHeldError, processFingerprint, workerStreamPath, writeRun } from './ledger.mjs';
import { createTaskRunner, offLoop as defaultOffLoop } from './offloop.mjs';
import {
  checkoutProblem, decideLanes, fingerprint, forcedForLanes, laneFingerprint, modelFor, renderStep, STEP_KINDS, verifyStep,
} from './policy.mjs';
import { driftOf, PLUGINS, resolveRoots } from './roots.mjs';
import {
  applyRateLimitEvent, createThrottleState, gateNewLane, judgeThrottle, throttleSnapshot, throttleText,
} from './throttle.mjs';

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
 *           startWorker, terminateGroup, helpers: { provenanceProblem, newPendingRuns } }
 */
export async function runLanes(c) {
  const { repoRoot, options, env, out, now, roots, pinned, stateRoot, runId, runDir, run, macroId, record } = c;
  const N = options.lanes;
  const home = laneHome(repoRoot);
  const baseline = c.view.macro?.fm?.git_baseline?.branch ?? null;
  // No removal takes what the run needs (Decision 2).
  const protect = [repoRoot, runDir, stateRoot.root];
  const budget = createBudget({
    maxSteps: options.maxSteps, maxCostUsd: options.maxCostUsd, stepBudgetUsd: options.stepBudgetUsd,
    stepTimeoutSec: options.stepTimeoutSec, maxTimeSec: options.maxTimeSec, startedAt: Date.parse(run.started_at), now,
  });
  const throttle = createThrottleState();
  const lanes = new Map(); // subtask id → { path, laneId, branch, subtaskId, state, lock }
  const report = new Map(); // subtask id → what the final report says of its lane
  const started = new Set(); // the lanes that stepped in this run (the throttle gates their first step only)
  const unused = new Set(); // the lanes this run created that no step has used yet (Decision 5)
  const inflight = new Map(); // seq → the step in flight
  const ended = []; // steps whose worker ended, not yet settled here
  const halts = [];
  const loaded = {};
  let forced = new Map();
  let draining = null;
  let seq = 0;
  let finalizeAttempted = false;
  let waiting = [];
  let throttleNote = null;
  let resetTimer = null;

  // Wake-ups: a step's end, a rate-limit event that changes the throttle,
  // the throttle's reset, a signal. One pending wake-up is kept, so an event
  // during a look is not lost.
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
  const tasks = createTaskRunner({ offLoop: c.offLoop ?? defaultOffLoop, onLingering: () => c.markLingering() });
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
  // After an interrupt a look reads what is here, without the fetch.
  const look = (checkout, fetch) => c.observeAsync({ repoRoot: checkout, roots, macroId, fetch: fetch && !c.interrupted(), env }, { offLoop: runAt(checkout) });
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
    const v = await look(repoRoot, true);
    return v.claimsError ? look(repoRoot, true) : v;
  };

  const lane = (id) => {
    if (!report.has(id)) report.set(id, { subtask_id: id, path: null, branch: null, state: null, last_step: null, halt: null, removal: null });
    return report.get(id);
  };
  const halted = (h) => {
    const hh = asHalt(h);
    halts.push(hh);
    if (hh.subtaskId) lane(hh.subtaskId).halt = { reason: hh.reason, detail: hh.detail };
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

  const driftNow = async () => (seq > 0 ? driftOf(pinned, await resolveRoots({ env })) : []);
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
  const gate = (refreshable = false) => gateNewLane(throttle, { nowSec: now() / 1000, deadlineSec: budget.deadlineSec(), inFlight: inflight.size, refreshable });
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
      // A lane this admission created and then did not use goes at once
      // (Decision 5: a yield, a throttle, a drain leaves no lane without its
      // step); an interrupted run keeps it, as it keeps every lane.
      if (!r.admitted && s.subtaskId && unused.has(s.subtaskId) && !c.interrupted()) await removeUnused(s.subtaskId);
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
    let createdNow = false;
    if (inLane && !lanes.has(id)) {
      if (mustYield() || (s.newLane && !gate().start)) return refuse(null);
      const subtask = (view.macro?.fm?.plan?.subtasks ?? []).find((x) => x?.id === id);
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
          state: made.failed ? 'creation failed' : (made.lane ? 'created, not used' : 'never created'),
        });
        return refuse({ ...made.halt, subtaskId: id });
      }
      let lock;
      try {
        lock = await holdFor(made.lane);
      } catch (e) {
        Object.assign(lane(id), { path: made.lane.path, branch: made.lane.branch, state: 'created, not used' });
        return refuse({ reason: 'owner-choice', detail: `the lane ${made.lane.path}: ${e instanceof LockHeldError ? e.message : `its worktree lock could not be taken (${e?.message ?? e})`}`, subtaskId: id });
      }
      lanes.set(id, { ...made.lane, state: 'created', lock });
      createdNow = true;
      Object.assign(lane(id), { path: made.lane.path, branch: made.lane.branch, state: 'created' });
      out(`  lane ${id}: created ${made.lane.path} on ${made.lane.branch} (${made.lane.form})`);
    }
    const held = inLane ? lanes.get(id) : null;
    const cwd = inLane ? held.path : repoRoot;

    // The checks that read a checkout, on the checkout the step runs in, from
    // a fresh look at it; a lane step is judged against that look.
    const before = inLane ? await look(cwd, false) : view;
    if (mustYield()) return refuse(null);
    if (before.lookError) return refuse({ reason: 'owner-choice', detail: `the look at ${cwd} failed: ${before.lookError}`, subtaskId: id });
    const problem = checkoutProblem(before);
    if (problem) return refuse({ ...problem, subtaskId: id });
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
      const fetched = await task('fetchBaseline', { checkout: repoRoot, baseline });
      if (mustYield()) return refuse(null);
      if (fetched.error) return refuse({ reason: 'owner-choice', detail: `the baseline of the prepared lane ${cwd} could not be read: ${fetched.error}`, subtaskId: id });
      const f = fetched.value;
      if (!f.ok) return refuse({ ...f.halt, subtaskId: id });
      if (before.git.head !== f.tip) {
        return refuse({ reason: 'owner-choice', detail: `the prepared lane ${cwd} (subtask ${id}, branch ${held.branch}) is at ${before.git.head?.slice(0, 12) ?? '?'}, but ${f.ref} is at ${f.tip.slice(0, 12)}: the baseline moved since the lane was cut; remove the lane and its branch, then relaunch`, subtaskId: id });
      }
    }
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
    const timeoutSec = budget.timeoutSecNow(reservation);
    if (timeoutSec < 1) return refuse({ reason: 'budget', detail: `the run reached its wall clock (${options.maxTimeSec} s)` });

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
    if (after.lookError) {
      // Unverified, and its peers unknown: the run halts, and keeps its
      // open-run record, so the next run's cleanup cancels the peers that name
      // it (dead-runs.mjs).
      c.keepOpenRecord();
      verdict = asHalt({ reason: 'owner-choice', detail: `the look at ${entry.cwd} after step ${entry.seq} failed (${after.lookError}); the step's result could not be verified` });
    } else {
      verdict = c.interrupted() && !w.aborted
        ? asHalt({ reason: 'interrupted', detail: 'the owner interrupted the run' })
        : verifyStep({ step: s, worker: w, before: entry.before, after, oversizePct: options.oversizePct });
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
      const done = cancelled.filter((x) => x.exit === 0).map((x) => x.run_id);
      const open = cancelled.filter((x) => x.exit !== 0).map((x) => x.run_id);
      const unlisted = after.lookError ? null : peersUnlisted(after, id);
      if (open.length || unlisted) c.keepOpenRecord();
      if (done.length) verdict = { ...verdict, detail: `${verdict.detail}; cancelled the step's pending peer run(s) ${done.join(', ')}` };
      if (open.length) verdict = { ...verdict, detail: `${verdict.detail}; could not cancel the step's pending peer run(s) ${open.join(', ')}, so the run keeps its open-run record for the next run's cleanup` };
      if (unlisted) verdict = { ...verdict, detail: `${verdict.detail}; the step's pending peer runs could not be listed (${unlisted}), so the run keeps its open-run record for the next run's cleanup` };
    }
    appendStep(runDir, {
      event: 'finished', seq: entry.seq, lane: entry.lane, ended_at: new Date(now()).toISOString(),
      exit: w.exitCode, signal: w.signal, aborted: w.aborted, abort_detail: w.abortDetail ?? null,
      spawn_error: w.spawnError, is_error: w.lastResult?.is_error ?? null, result_subtype: w.lastResult?.subtype ?? null,
      turns: w.turns, cost_usd: w.costUsd, cost_charged_usd: cost, peak_ctx: w.peakCtx, peak_pct: w.peakPct,
      context_window: w.contextWindow, permission_denials: w.denials, report: w.report, raw_truncated: w.rawTruncated,
      group_teardown: w.groupTeardown, rate_limit: w.rateLimit ?? null,
      peer_cancellations: cancelled, fingerprint_after: entry.lane ? laneFingerprint(after, id) : fingerprint(after),
      outcome: verdict ? verdict.reason : 'ok',
    });
    writeRun(runDir, run);
    const pct = w.peakPct == null ? '?' : `${(w.peakPct * 100).toFixed(1)}%`;
    out(`    [${entry.seq}]${entry.lane ? ` lane ${id}` : ''} exit=${w.exitCode ?? w.signal} cost=$${(w.costUsd ?? cost).toFixed(2)}${w.costUsd === null ? ' (unreported; budget charged)' : ''} peak=${w.peakCtx} (${pct}) denials=${w.denials.length}${verdict ? ` → ${verdict.reason}` : ''}`);
    if (id && report.get(id)?.last_step?.seq === entry.seq) report.get(id).last_step.outcome = verdict ? verdict.reason : 'ok';
    // A commit stands whatever the verdict on its step, and is reported; after
    // an interrupt the next run's first look reports it (Decision 7).
    if (!c.interrupted()) await c.reportLanding(after, entry.seq, runAt(repoRoot));
    if (verdict) {
      halted({ ...verdict, subtaskId: verdict.subtaskId ?? id });
      return;
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
    lane(id).state = r.outcome === 'removed' ? (unusedLane ? 'removed (no step used it)' : 'removed') : `kept (${r.outcome})`;
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
    const tryOne = async (s) => {
      const r = await admit(s, view);
      if (r.halt) { halted(r.halt); return false; }
      if (r.stop) { if (r.again) res.again = true; return false; }
      return true;
    };
    // What may run this turn, beside the workers in flight, and bring a newer
    // rate-limit event: a step of a lane already started, or the driver's
    // step. While a lane's halt drains the run only the forced steps start.
    const refreshable = d.laneHalts.length > 0
      ? d.laneSteps.some((x) => x.forced && !x.newLane)
      : d.laneSteps.some((x) => !x.newLane) || d.driverStep !== null;
    // A new lane — a lane's first step in this run, forced or not — starts
    // only through the throttle. false: it may not start now.
    const passes = () => {
      const g = gate(refreshable);
      if (g.start) { throttleNote = null; return true; }
      // Exhausted is exhausted: no wait for a reset that could not spend.
      const spentOut = budget.exhausted();
      if (spentOut && inflight.size === 0) { halted({ reason: 'budget', detail: spentOut }); return false; }
      if (g.halt) { halted(g.halt); return false; }
      if (g.waitUntilSec) res.waitUntilSec = g.waitUntilSec;
      noteThrottle(g.why);
      return false;
    };
    // The forced steps start first, and a forced new lane the throttle holds
    // back leaves the others to start; a judgment halt that persists in
    // another lane then drains the run while they run. Before each admission
    // the turn asks again what changed while the last one awaited.
    for (const s of d.laneSteps.filter((x) => x.forced)) {
      if (room() <= 0 || mustYield()) break;
      if (s.newLane && !passes()) continue;
      if (!(await tryOne(s))) break;
    }
    if (d.laneHalts.length > 0) {
      for (const h of d.laneHalts) halted(h);
      return res;
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
    resetTimer = setTimeout(wake, Math.max(0, sec * 1000 - now()) + 1000);
  };

  function lanesSummary() {
    for (const [id, l] of lanes) {
      const r = lane(id);
      if (!r.path) Object.assign(r, { path: l.path, branch: l.branch, state: l.state });
    }
    for (const w of waiting) lane(w.subtaskId).waiting = { branch: w.branch, reason: w.reason, commit: w.commit ?? null };
    return [...report.values()].sort((a, b) => String(a.subtask_id).localeCompare(String(b.subtask_id)));
  }

  async function end(status, d = null) {
    clearTimeout(resetTimer);
    // Before the run ends, any end but an interrupt, every lane it created
    // that no step used is removed (Decision 5): the backstop for an
    // admission's own removal (every refusal goes through admit today, so
    // nothing is left here unless a later path bypasses it). No removal
    // starts after an interrupt.
    for (const id of [...unused]) {
      if (c.interrupted()) break;
      await removeUnused(id);
    }
    const nowSec = now() / 1000;
    run.lanes = { n: N, lanes: lanesSummary() };
    run.rate_limit = throttleSnapshot(throttle, nowSec);
    if (d && halts.length > 1) d = { ...d, also: halts.filter((h) => h !== d).map((h) => ({ reason: h.reason, detail: h.detail, subtask_id: h.subtaskId ?? null })) };
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
    // Reconciliation (Decision 5), under the macro lock, from the look taken
    // under it. Each lane the run drives is held with its worktree lock.
    const rec = await reconcileLanes({ home, checkout: repoRoot, macroId, view: c.view, baseline, runId, runDir, now, env, out: (x) => out(`  ${x}`), protect });
    for (const line of rec.reports) out(`  ${line}`);
    for (const e of rec.plan?.lanes ?? []) {
      Object.assign(lane(e.subtaskId), { path: e.lane.path, branch: e.lane.branch, state: { adopt: 'adopted', prepared: 'prepared', keep: 'kept', remove: 'removed', halt: 'halted' }[e.action] ?? e.action });
    }
    for (const [id, l] of rec.lanes) {
      try {
        lanes.set(id, { ...l, state: l.state === 'adopt' ? 'adopted' : l.state, lock: await holdFor(l) });
      } catch (e) {
        halted({ reason: 'owner-choice', detail: `the lane ${l.path}: ${e instanceof LockHeldError ? e.message : `its worktree lock could not be taken (${e?.message ?? e})`}`, subtaskId: id });
      }
    }
    for (const h of rec.halts ?? (rec.halt ? [rec.halt] : [])) halted(h);

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
        return await end('halted', draining);
      }

      const view = await lookGlobal();
      if (c.interrupted() || ended.length > 0) continue;
      // While a done or finalize is in flight the macro is that step's to
      // change: its Stop hook moves it to the archive, and a look whose read
      // of the macro or of its readiness met the move is judged once the step
      // has ended (transient states are not halts).
      if ((view.macroLookupError || view.readyError) && driverBusy()) { await nextEvent(); continue; }
      await c.reportLanding(view, seq, runAt(repoRoot));
      const drift = await driftNow();
      if (drift.length > 0) { halted({ reason: 'version-drift', detail: drift.join('; ') }); continue; }
      const d = decideLanes(view, { inFlight: subtasksInFlight(), driverBusy: driverBusy(), lanes, started, forced, finalizeAttempted });
      if (d.outcome === 'completed') {
        if (inflight.size > 0) { await nextEvent(); continue; }
        out(`[${seq + 1}] ${d.detail}`);
        return await end('completed');
      }
      if (d.outcome === 'halt') { halted(d); continue; }
      waiting = (c.landing() && d.waiting.length) ? d.waiting.map((w) => ({ ...w, commit: c.landing().entries.find((e) => e.subtaskId === w.subtaskId)?.commit ?? null })) : d.waiting;

      const r = await startWhatMay(d, view);
      if (draining || c.interrupted()) continue;
      if (inflight.size > 0 || ended.length > 0) { await nextEvent(); continue; }
      if (r.waitUntilSec) {
        armReset(r.waitUntilSec);
        await nextEvent();
        continue;
      }
      if (r.again) continue;
      // Nothing runs and nothing can start.
      return await end('halted', c.withLanding ? c.withLanding(d.idle) : d.idle);
    }
  } catch (e) {
    // The run cannot go on: every step in flight is torn down and settled,
    // every group's entry released (a group that outlived SIGKILL keeps its
    // entries and the run's locks), and the driver records the error.
    clearTimeout(resetTimer);
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
    run.lanes = { n: N, lanes: lanesSummary() };
    throw e;
  }
}

/** The lines of the final report for one lane. */
export function laneBlock(l) {
  const lines = [`  lane ${l.subtask_id}${l.branch ? ` · ${l.branch}` : ''}${l.path ? ` · ${l.path}` : ''} · ${l.state ?? 'not created'}`];
  if (l.last_step) lines.push(`      last [${l.last_step.seq}] ${l.last_step.command} → ${l.last_step.outcome}`);
  if (l.waiting) lines.push(`      waiting to land: ${l.waiting.branch} (${l.waiting.reason})${l.waiting.commit ? ` at ${l.waiting.commit}` : ''}`);
  if (l.halt) lines.push(`      halted: ${l.halt.reason} — ${l.halt.detail}`);
  if (l.removal) lines.push(`      ${l.removal}`);
  return lines;
}

/** The path a lane of the macro has, for a preview. */
export const plannedLanePath = (checkout, macroId, subtaskId) => {
  const home = laneHome(checkout);
  return home.problem ? null : lanePath(home, macroId, subtaskId);
};
