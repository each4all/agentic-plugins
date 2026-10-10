// plugins/orchestrator/adapters/claude/autopilot/driver.mjs
//
// ADR-0063 D1/D3/D4/D8 — the run: observe → decide → act → verify, one fresh
// worker per step, until the macro completes or the policy halts.
//
// The driver is stateless across runs: every iteration re-derives the view
// from durable state, so relaunching after a halt continues where the state
// says. It is bounded (steps, total cost, run wall clock, per-step budget and
// wall clock), foreground, and exits on completion (0), on a halt (2), or on
// an error that prevented a run (1). It never pushes, opens or merges a pull
// request, never switches branches itself, never archives, and never resumes,
// forks or compacts a session (D1). After each look under its locks it reports
// every subtask newly committed and not landed (landing-ready.mjs, ADR-0067
// Decision 7), and goes on.
//
// What it kills is only what its steps started: a worker's process group on
// timeout or abort (with lanes, an off-loop task's too, offloop.mjs), and,
// through engineer's own `peer-runner cancel`, the peer runs that step left
// pending (a peer runs detached from the worker's group). SIGINT, SIGTERM and
// SIGHUP interrupt the run; an exit that did not unwind it empties every
// group still in flight.
// A run whose driver died cannot do that, so before its first spawn each run
// cleans up after the dead runs of its macro, from their open-run records
// (dead-runs.mjs), and keeps its own record until it ends.
//
// With `--lanes N` (N of 2 or more, ADR-0067 Decision 6) the start is the
// same, then scheduler.mjs runs the macro's subtasks in lanes, each in its
// own git worktree, up to N workers at a time. Without it, or with 1, the
// run is this serial loop, which refuses to start while a lane of the macro
// holds a subtask that is not completed.

import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { createBudget } from './budget.mjs';
import { cleanupDeadRuns, summary as cleanupSummary } from './dead-runs.mjs';
import { orderText, overlapText, reportLandingReady } from './landing-ready.mjs';
import { lanesHoldingWork, lanesRequirements } from './lanes.mjs';
import { launchProposals, mainCheckoutProposal, proposalLines } from './launch-proposals.mjs';
import { observe as defaultObserve } from './observe.mjs';
import {
  decide, fingerprint, modelFor, renderStep, verifyStep, STEP_KINDS,
} from './policy.mjs';
import {
  appendStep, acquireLock, createRunDir, LockHeldError, macroLockPath, mainWorktreeRoot, newRunId,
  processFingerprint, relaunchCommand, removeOpenRun, workerStreamPath, worktreeLockPath, writeHalt, writeOpenRun, writeRun,
} from './ledger.mjs';
import {
  capabilityProblems, driftOf, frozenInputProblems, lanesCapabilityProblems, PLUGINS, resolveRoots,
} from './roots.mjs';
import { observeInChild, offLoop as defaultOffLoop } from './offloop.mjs';
import { laneBlock, runLanes } from './scheduler.mjs';
import {
  ALLOWED_TOOLS, COMMIT_DENY, DENIED_TOOLS, claudeBin, startWorker as defaultStartWorker, terminateGroupsSync,
} from './worker.mjs';
import { checkStateBase, creationRoot, STATE_BASE_ENV } from '../../../scripts/lib/state-root.mjs';
import { tokenDigest } from '../../../scripts/lib/run-locks.mjs';

// Owner decision D10 (2026-10-01): "don't worry about the budget". ADR-0063 D1
// still requires bounds, so they are finite but out of the way.
export const DEFAULTS = Object.freeze({
  maxSteps: 60,
  maxCostUsd: 250,
  stepBudgetUsd: 25,
  stepTimeoutSec: 3600,
  maxTimeSec: 86400,
  oversizePct: 0.25,
});
// The Claude Code flags the worker host depends on (verified on 2.1.281 and
// 2.1.286).
const REQUIRED_CLAUDE_FLAGS = ['--input-format', '--permission-prompts', '--include-hook-events', '--max-budget-usd', '--json-schema'];
// D8: what a consumer repository must ignore.
const IGNORED_STATE = ['runs', 'state', 'tmp', 'cache'];

function git(repoRoot, args) {
  const r = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, stdout: (r.stdout ?? '').trim() };
}

const canonical = (p) => {
  try { return realpathSync(p); } catch { return resolve(p); }
};
const isWithin = (child, parent) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** The repository's remote URLs, for the worker's git-level push block. */
export function remoteUrls(repoRoot) {
  const r = git(repoRoot, ['config', '--get-regexp', '^remote\\..*\\.(url|pushurl)$']);
  const fetchUrls = [];
  const pushUrls = [];
  if (r.code !== 0) return { fetchUrls, pushUrls };
  for (const line of r.stdout.split('\n')) {
    const m = /^remote\..+\.(url|pushurl) (.+)$/.exec(line);
    if (!m) continue;
    (m[1] === 'url' ? fetchUrls : pushUrls).push(m[2]);
  }
  return { fetchUrls, pushUrls };
}

/**
 * The start conditions (plugin change spec §5): a git work tree that ignores
 * the agentic state, a Claude Code that has the flags the host needs, the
 * plugin roots with their capability floor, and no root inside the repository.
 * `problems` refuse a start; `warnings` are printed.
 */
export async function preflight({ repoRoot, env = process.env, checkClaude = true, lanes = 1 }) {
  const problems = [];
  const warnings = ['-p skips the workspace trust dialog: run the autopilot only in a repository you trust.'];
  if (git(repoRoot, ['rev-parse', '--is-inside-work-tree']).stdout !== 'true') {
    problems.push(`${repoRoot} is not a git work tree`);
    return { problems, warnings, roots: null };
  }
  const unignored = IGNORED_STATE.filter((d) => git(repoRoot, ['check-ignore', '-q', `.agentic-plugins/${d}/x`]).code !== 0);
  if (unignored.length > 0) {
    problems.push(`.agentic-plugins/{${unignored.join(',')}}/ is not gitignored: add .agentic-plugins/{runs,state,tmp,cache}/ to .gitignore (each worker writes there, and a dirty tree stops dispatch)`);
  }
  let claude = null;
  if (checkClaude) {
    const v = spawnSync(claudeBin(env), ['--version'], { encoding: 'utf8', timeout: 30_000, env });
    if (v.status !== 0) {
      problems.push(`the Claude Code CLI (${claudeBin(env)}) did not run: ${(v.stderr || v.error?.message || '').trim()}`);
    } else {
      claude = (v.stdout ?? '').trim();
      const h = spawnSync(claudeBin(env), ['--help'], { encoding: 'utf8', timeout: 30_000, env });
      const missing = REQUIRED_CLAUDE_FLAGS.filter((f) => !(h.stdout ?? '').includes(f));
      if (missing.length > 0) problems.push(`Claude Code ${claude} lacks ${missing.join(', ')}; update it`);
    }
  }
  const remotes = remoteUrls(repoRoot);
  const unguarded = remotes.pushUrls.filter((u) => remotes.fetchUrls.includes(u));
  if (unguarded.length > 0) {
    problems.push(`a remote's explicit pushurl equals a fetch URL (${unguarded.join(', ')}): git exempts it from pushInsteadOf, and an insteadOf on it would also break fetching, so the run could not keep workers from pushing to it. Remove the redundant pushurl (git config --unset remote.<name>.pushurl).`);
  }
  const resolved = await resolveRoots({ env });
  problems.push(...resolved.problems);
  problems.push(...(await capabilityProblems(resolved.roots)));
  problems.push(...frozenInputProblems(resolved.roots, repoRoot));
  if (lanes >= 2) problems.push(...lanesCapabilityProblems(resolved.roots, repoRoot, { env }));
  const { stateRoot, problem } = effectiveStateRoot(repoRoot, env);
  if (problem) problems.push(problem);
  return { problems, warnings, roots: resolved, claude, stateRoot };
}

/**
 * ADR-0067 Decision 2 — the run's effective state root, resolved once at
 * start: an operator's AGENTIC_STATE_BASE binds, checked for the driven
 * checkout; otherwise where the shared-creation switch says records are
 * created (the checkout while it is off). The run records it in run.json and
 * exports it to every worker, whose environment the scrub has cleared of an
 * inherited value, so no step creates a record anywhere else. A value a
 * worker's own scripts would refuse (a lane, say) refuses the start instead.
 */
export function effectiveStateRoot(repoRoot, env = process.env) {
  let where;
  try {
    where = creationRoot(repoRoot, { env });
  } catch (e) {
    return { stateRoot: null, problem: `the run's state root: ${e.message}` };
  }
  const exported = checkStateBase({ checkout: repoRoot, env: { [STATE_BASE_ENV]: where.root }, switchState: where.sharedCreation });
  if (!exported.ok) return { stateRoot: null, problem: `the run's state root: ${exported.error} (ADR-0067 Decision 2)` };
  const operator = typeof env[STATE_BASE_ENV] === 'string' && env[STATE_BASE_ENV] !== '';
  return {
    stateRoot: {
      root: where.root,
      source: operator ? 'operator' : (where.sharedCreation === 'on' ? 'default-state-root' : 'checkout'),
      shared_creation: where.sharedCreation,
      default_state_root: where.defaultRoot,
    },
    problem: null,
  };
}

export function posture(options) {
  return {
    permission_mode: 'manual',
    permission_prompts: 'none',
    allowed_tools: [...ALLOWED_TOOLS],
    denied_tools: [...DENIED_TOOLS],
    denied_on_non_commit_steps: [COMMIT_DENY],
    git_push_block: 'network pushes fail at the git level in every worker (pushInsteadOf)',
    model_plan: options.models ?? null,
    model_override: { model: options.model ?? null, effort: options.effort ?? null },
    budgets: {
      max_steps: options.maxSteps, max_cost_usd: options.maxCostUsd, step_budget_usd: options.stepBudgetUsd,
      step_timeout_sec: options.stepTimeoutSec, max_time_sec: options.maxTimeSec, oversize_pct: options.oversizePct,
    },
  };
}

/**
 * The plugin code a worker loaded (its init event) against what the run
 * pinned. Claude loads commands, skills and hooks from the installed plugin —
 * on a directory marketplace, from the marketplace checkout — while the
 * runbooks' scripts come from the pinned roots. Returns null, or
 * {reason, detail} to abort the step before its first turn.
 */
export function provenanceProblem(plugins, { pinned, repoRoot, loaded }) {
  for (const name of PLUGINS) {
    const entry = (plugins ?? []).find((p) => p?.name === name && /@agentic-plugins$/.test(p?.source ?? ''))
      ?? (plugins ?? []).find((p) => p?.name === name);
    if (!entry || typeof entry.path !== 'string') {
      return { reason: 'owner-choice', detail: `the worker did not load the ${name} plugin; install and enable it for Claude Code` };
    }
    const path = canonical(entry.path);
    if (isWithin(path, canonical(repoRoot))) {
      return {
        reason: 'owner-choice',
        detail: `the worker loads ${name} from ${entry.path}, inside the repository this run drives (a directory marketplace): ` +
          'a step switches its branch, and with it the commands and hooks every later step loads. Drive a separate worktree or clone.',
      };
    }
    if (entry.version && pinned.versions[name] && entry.version !== pinned.versions[name]) {
      return {
        reason: 'version-drift',
        detail: `the worker loads ${name} ${entry.version} from ${entry.path}, but the run pinned ${name} ${pinned.versions[name]} ` +
          `at ${pinned.roots[name]}: its commands and hooks would not match the scripts it runs`,
      };
    }
    if (loaded[name] && loaded[name] !== path) {
      return { reason: 'version-drift', detail: `the worker loads ${name} from ${entry.path}, but earlier steps loaded it from ${loaded[name]}` };
    }
  }
  return null;
}

// Every peer run pending on an engineer workflow of one subtask: its
// in-progress child, and any workflow that claims that subtask of the macro —
// a dispatch killed before it recorded its subtask in progress leaves one.
// Another subtask's workflows are another lane's (ADR-0067 Decision 6, Peer
// cancellation), and a step with no subtask has none.
function pendingRuns(view, subtaskId) {
  const ids = new Set();
  if (!subtaskId) return ids;
  for (const id of view?.children?.[subtaskId]?.pending_runs ?? []) ids.add(id);
  for (const c of view?.claims ?? []) {
    if (c?.originating_subtask !== subtaskId) continue;
    for (const id of c?.pending_runs ?? []) ids.add(id);
  }
  return ids;
}

/** Peer runs a step on `subtaskId` started and left pending on that subtask's workflows (engineer `pending_ensemble`). */
export function newPendingRuns(before, after, subtaskId) {
  const had = pendingRuns(before, subtaskId);
  return [...pendingRuns(after, subtaskId)].filter((id) => !had.has(id));
}

// A peer runs detached from the worker's process group, so killing the worker
// leaves it running. Cancel it through engineer's supervisor, which verifies
// the process fingerprint before it signals anything, from the checkout the
// step ran in: its read set holds the workflow's home, where the run's ledger
// is (ADR-0067 Decision 4, item 2).
export function cancelPeerRuns(runIds, { roots, checkout, env }) {
  const cli = join(roots.engineer, 'scripts', 'peer-runner.mjs');
  return runIds.map((runId) => {
    const r = spawnSync(process.execPath, [cli, 'cancel', '--run-id', runId, '--repo-root', checkout], {
      cwd: checkout, env, encoding: 'utf8', timeout: 60_000,
    });
    let out = null;
    try { out = JSON.parse((r.stdout ?? '').trim()); } catch { /* not JSON */ }
    return { run_id: runId, exit: r.status, result: out ?? (r.stderr ?? '').trim().slice(-300) };
  });
}

function haltRecord({ runId, d, lastSessionId, repoRoot, macroId, lanes }) {
  const resume = [];
  if (lastSessionId) resume.push(`claude --resume ${lastSessionId}   # inspect the last step interactively`);
  resume.push(d.reason === 'awaiting-landing'
    ? 'Push each branch listed, open and review its pull request, merge it, then relaunch:'
    : 'Resolve what the reason names, then relaunch:');
  // ADR-0067 Decision 6: the relaunch repeats the run's macro and lanes.
  resume.push(relaunchCommand({ macroId, lanes, repoRoot }));
  return {
    run_id: runId,
    reason: d.reason,
    detail: d.detail,
    pointer: d.pointer ?? null,
    subtask_id: d.subtaskId ?? null,
    waiting: d.waiting ?? null,
    merge_order: d.mergeOrder ?? null,
    last_session_id: lastSessionId,
    resume,
    // A run with lanes: the other halts its drain met, and one entry per lane.
    ...(d.also ? { also: d.also } : {}),
    ...(lanes >= 2 ? { lanes: d.lanes ?? [] } : {}),
  };
}

function notifyLocal(options, title, message) {
  if (!options.notifyLocal || process.platform !== 'darwin') return;
  // D9: driver-local only — a fixed AppleScript, the payload as argv, no egress.
  spawnSync('osascript', [
    '-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv)', '-e', 'end run',
    message.slice(0, 180), title,
  ], { stdio: 'ignore', timeout: 5000 });
}

function printHalt(out, d) {
  out(`■ halted: ${d.reason} — ${d.detail}`);
  if (d.pointer) out(`  pointer: ${d.pointer}`);
  for (const w of d.waiting ?? []) {
    out(`  · ${w.subtaskId} on ${w.branch} (${w.reason})${w.detail ? `: ${w.detail}` : ''}`);
    if (w.overlap) out(`      at ${w.commit ?? 'no commit'} · overlap: ${overlapText(w.overlap)}`);
    for (const c of w.commands ?? []) out(`      ${c}`);
    if (w.note) out(`      ${w.note}`);
  }
  if (d.mergeOrder) out(`  merge order: ${orderText(d.mergeOrder)}`);
}

// The awaiting-landing halt lists what the landing-ready report holds for the
// same look: each branch's commit and overlap, and the merge order.
function withLanding(d, report) {
  if (d.reason !== 'awaiting-landing' || !report) return d;
  const byId = new Map(report.entries.map((e) => [e.subtaskId, e]));
  return {
    ...d,
    waiting: (d.waiting ?? []).map((w) => {
      const e = byId.get(w.subtaskId);
      return e ? { ...w, commit: e.commit, overlap: e.overlap } : w;
    }),
    mergeOrder: report.mergeOrder,
  };
}

// ADR-0067 Decision 6: a serial run does not reconcile lanes, and would halt
// on their active children or ask for a switch to a branch git will not check
// out twice; it refuses while a lane of the macro holds unfinished work.
function serialRefusal({ repoRoot, macroId, view, env }) {
  if (!macroId) return [];
  const held = lanesHoldingWork({ checkout: repoRoot, macroId, view, env });
  if (held.problem) return [held.problem];
  if (held.lanes.length === 0) return [];
  return [
    `a lane of macro ${macroId} holds work that is not completed (${held.lanes.map((l) => `${l.subtaskId}=${l.status} at ${l.path}`).join(', ')}): ` +
      `a serial run does not drive lanes. Run it with lanes: ${relaunchCommand({ macroId, lanes: 2, repoRoot })}`,
  ];
}

/**
 * Start a run. Resolves to the exit code: 0 completed, 2 halted, 1 error.
 *
 * @param a.repoRoot  the worktree toplevel the run drives
 * @param a.options   parsed CLI options (budgets, models, macro, forced, notifyLocal)
 * @param a.env       the environment (workers inherit it, scrubbed)
 * @param a.out, a.err  line printers
 * @param a.deps      test seams: { observe, observeAsync, offLoop, startWorker, now, signals, checkClaude, terminateGroupsSync }
 */
export async function startRun({ repoRoot, options, env = process.env, out = console.log, err = console.error, deps = {} }) {
  const observe = deps.observe ?? defaultObserve;
  const startWorker = deps.startWorker ?? defaultStartWorker;
  const now = deps.now ?? (() => Date.now());
  // ADR-0067 Decision 6: absent or 1, the serial driver; 2 or more, lanes.
  const lanes = Number.isInteger(options.lanes) && options.lanes >= 2 ? options.lanes : 1;
  const pre = await preflight({ repoRoot, env, checkClaude: deps.checkClaude ?? true, lanes });
  for (const w of pre.warnings) out(`⚠ ${w}`);
  if (pre.problems.length > 0) {
    err('✗ The autopilot cannot start:');
    for (const p of pre.problems) err(`  - ${p}`);
    // ADR-0067 Decision 8, item 4: the refusal stays, with the concrete setup
    // for each launch trigger, judged on its own as preview judges it: the
    // pins for roots inside the repository, and, on the main checkout, the
    // home worktree, the one setup a directory marketplace here leaves runnable.
    // The macro is looked up read-only, as preview does, so the home command
    // names it: a home worktree on autopilot/home finds none by its branch.
    let refusedView = null;
    if (pre.roots && pre.roots.problems.length === 0) {
      try {
        refusedView = observe({ repoRoot, roots: pre.roots.roots, macroId: options.macro ?? null, fetch: false, env });
      } catch {
        refusedView = null;
      }
    }
    const proposals = pre.roots
      ? launchProposals({ repoRoot, view: refusedView, options: { ...options, lanes }, roots: pre.roots.roots, env, home: env.HOME || homedir() })
      : [];
    for (const line of proposalLines(proposals)) err(line);
    return 1;
  }
  const pinned = pre.roots;
  const roots = pinned.roots;
  const remotes = remoteUrls(repoRoot);
  const stateRoot = pre.stateRoot;

  let view = observe({ repoRoot, roots, macroId: options.macro ?? null, fetch: true, env });
  const macroId = view.macro?.id ?? null;
  // Lanes require shared creation, the default state root and the macro
  // there (Decision 2); a serial run refuses beside a lane of the macro that
  // holds a subtask not completed, and names the lanes command.
  const refusal = lanes >= 2
    ? (macroId
      ? lanesRequirements({ checkout: repoRoot, stateRoot, macroPath: view.macro.path, view })
      : [`a run with lanes needs its macro${view.macroLookupError ? ` (${view.macroLookupError})` : ''}: name it with --macro <id>`])
    : serialRefusal({ repoRoot, macroId, view, env });
  if (refusal.length > 0) {
    err(`✗ The autopilot cannot start${lanes >= 2 ? ` with --lanes ${lanes}` : ''}:`);
    for (const p of refusal) err(`  - ${p}`);
    return 1;
  }
  // ADR-0067 Decision 8, item 4: launched on the main checkout, the run goes
  // on, and proposes the home worktree to launch from next time.
  const onMain = mainCheckoutProposal({ repoRoot, view, options: { ...options, lanes }, roots, env, home: env.HOME || homedir() });
  for (const line of proposalLines(onMain ? [onMain] : [])) out(line);
  const runId = newRunId(new Date(now()));
  const runDir = createRunDir(repoRoot, runId);
  const startedAt = now();
  const run = {
    run_id: runId,
    repo: repoRoot,
    macro_id: macroId,
    started_at: new Date(startedAt).toISOString(),
    ended_at: null,
    status: 'running',
    options: {
      max_steps: options.maxSteps, max_cost_usd: options.maxCostUsd, step_budget_usd: options.stepBudgetUsd,
      step_timeout_sec: options.stepTimeoutSec, max_time_sec: options.maxTimeSec, oversize_pct: options.oversizePct,
      model_plan: options.models, model_override: { model: options.model ?? null, effort: options.effort ?? null },
      forced: options.forcedText ?? null, notify_local: options.notifyLocal === true, lanes,
    },
    claude_version: pre.claude,
    roots,
    versions: pinned.versions,
    sources: pinned.sources,
    loaded_plugins: null,
    state_root: stateRoot,
    git_baseline: { branch: view.git.branch, head: view.git.head },
    steps: 0,
    cost_usd: 0,
    cost_complete: true,
    // The seqs whose charge cost_usd holds: a dead run's cleanup settles
    // every other started step, once (ADR-0067 Decision 6, Budgets).
    accounted_seqs: [],
    halt: null,
  };
  writeRun(runDir, run);
  // Read once: the macro's landing log is kept beside its lock (ADR-0067
  // Decision 7), and so is the run's open-run record (Decision 6); a second
  // read that fell back to repoRoot would part them.
  const mainRoot = mainWorktreeRoot(repoRoot);

  const locks = [];
  // A step whose process group outlived SIGKILL leaves the run's entries in
  // place: they name the group, and holderAlive counts it while it has members.
  let lingering = false;
  // A run with lanes whose look after a step failed keeps its open-run
  // record: that step's peers are unknown, and the next run's cleanup
  // cancels the ones that name it (scheduler.mjs).
  let keepRecord = false;
  const release = () => {
    if (lingering) locks.length = 0;
    while (locks.length) locks.pop().release();
  };
  const setWorker = (worker) => { for (const l of locks) l.setWorker(worker); };
  let lastSessionId = null;
  let current = null;
  // The step's reservation while it is open (budget.mjs).
  let reservation = null;
  let interrupted = false;
  // A run with lanes aborts every worker group it has in flight, and lists
  // them with its tasks' groups (scheduler.mjs).
  let onInterrupt = null;
  let groupsInFlight = () => [];
  // SIGHUP too: a closed terminal (tmux kill-pane, an ssh drop) interrupts
  // the run as Ctrl-C does, rather than killing the driver and leaving its
  // groups to run on.
  const onSignal = () => {
    interrupted = true;
    current?.abort('interrupted');
    onInterrupt?.();
  };
  // The backstop for an exit that did not unwind the run (a crash, an output
  // that failed after SIGHUP): every group still in flight is emptied
  // (SIGTERM, a grace, SIGKILL). On every other end none is left.
  const onExit = () => {
    (deps.terminateGroupsSync ?? terminateGroupsSync)([...(Number.isInteger(current?.pid) ? [current.pid] : []), ...groupsInFlight()]);
  };
  const signals = deps.signals ?? process;
  signals.on('SIGINT', onSignal);
  signals.on('SIGTERM', onSignal);
  signals.on('SIGHUP', onSignal);
  signals.on('exit', onExit);
  const detach = () => {
    signals.off?.('SIGINT', onSignal);
    signals.off?.('SIGTERM', onSignal);
    signals.off?.('SIGHUP', onSignal);
    signals.off?.('exit', onExit);
  };

  // A run with lanes passes its lanes (one report block each) and its
  // rate-limit line (scheduler.mjs).
  const finish = (status, d = null, laneReport = null) => {
    run.status = status;
    run.ended_at = new Date(now()).toISOString();
    if (d) {
      run.halt = haltRecord({ runId, d: laneReport ? { ...d, lanes: laneReport.lanes } : d, lastSessionId, repoRoot, macroId, lanes });
      writeHalt(runDir, run.halt);
      printHalt(out, d);
      for (const line of run.halt.resume) out(`  ${line}`);
    } else {
      out(`■ ${status}`);
    }
    for (const l of laneReport?.lanes ?? []) for (const line of laneBlock(l)) out(line);
    if (laneReport?.rateLimit) out(`  ${laneReport.rateLimit}`);
    writeRun(runDir, run);
    release();
    // The run ended with every worker group empty, so nothing is left for a
    // cleanup to find. A group that outlived SIGKILL keeps the record, as it
    // keeps the lock entries.
    if (!lingering && !keepRecord) {
      try {
        removeOpenRun(mainRoot, runId);
      } catch (e) {
        out(`⚠ the run's open-run record could not be removed (${e?.message ?? e}); stop, or the next run of the macro, cleans it up`);
      }
    }
    detach();
    out(`  run ${runId} · steps=${run.steps} · cost=$${run.cost_usd.toFixed(2)}${run.cost_complete ? '' : ' (at least: a killed step reported no cost, so its budget was counted)'} · ledger ${runDir}`);
    notifyLocal(options, `autopilot: ${status}`, d ? `${d.reason} — ${d.detail}` : 'the macro completed');
    return status === 'completed' ? 0 : 2;
  };

  try {
    out(`autopilot ${runId}`);
    out(`  repo ${repoRoot} · macro ${macroId ?? '(none)'} · ${Object.entries(pinned.versions).map(([k, v]) => `${k} ${v}`).join(', ')}`);

    // ADR-0067 Decision 4, item 5 — the run's secret: its workers pass the
    // interactive commands' admission with it. Only its digest is written
    // (the lock files are readable); the secret goes to the workers' env.
    const token = deps.token ?? randomBytes(16).toString('hex');
    const record = { run_id: runId, repo: repoRoot, macro_id: macroId, started_at: run.started_at, token_digest: tokenDigest(token) };
    try {
      locks.push(await acquireLock(worktreeLockPath(repoRoot), { record, now }));
      if (macroId) locks.push(await acquireLock(macroLockPath(mainRoot, macroId), { record, now }));
    } catch (e) {
      if (!(e instanceof LockHeldError)) throw e;
      return finish('halted', { reason: 'owner-choice', detail: e.message });
    }

    // The view above was taken before the locks. Another run may have changed
    // the state and released its locks in between, so the first step is
    // decided from what the state says now, under the locks (round 6).
    view = observe({ repoRoot, roots, macroId, fetch: true, env });
    if ((view.macro?.id ?? null) !== macroId) {
      return finish('halted', { reason: 'owner-choice', detail: `the macro changed while the run took its locks (${macroId ?? 'none'} → ${view.macro?.id ?? 'none'})` });
    }

    // ADR-0067 Decision 6, Locks: before its first spawn the run cleans up
    // after every dead run of its macro (holding the macro lock, it finds none
    // of their worker groups alive), then puts its own open-run record beside
    // the lock. The cleanup never halts the run: what it cannot finish is
    // printed, kept for the owner, and recorded in run.json.
    if (macroId) {
      const dead = await cleanupDeadRuns({
        mainRoot, macroId, selfRunId: runId, engineerRoot: roots.engineer, by: { run_id: runId, label: `run ${runId}` },
        env, now, out: (s) => out(`  ${s}`), ...(deps.probe ? { probe: deps.probe } : {}),
      });
      if (dead.length > 0) {
        run.dead_runs = dead.map(cleanupSummary);
        writeRun(runDir, run);
      }
    }
    writeOpenRun(mainRoot, {
      runId, macroId, checkout: repoRoot, runDir, pid: process.pid, fingerprint: await processFingerprint(process.pid), startedAt: run.started_at,
    });

    // ADR-0067 Decision 7: after each look under the locks, every subtask
    // newly committed and not landed is reported, a waiting one found at the
    // start included. The report is never a gate: a failure is printed, and
    // the next look reports what it missed.
    const mergeChecks = new Map();
    let landing = null;
    const reportLanding = (v, seq) => {
      try {
        landing = reportLandingReady({ repoRoot, mainRoot, runDir, runId, seq, view: v, out, now, cache: mergeChecks, env });
      } catch (e) {
        landing = null;
        out(`⚠ landing-ready: the report failed (${e?.message ?? e}); the run goes on, and the next look reports it`);
      }
    };
    reportLanding(view, 0);

    if (lanes >= 2) {
      // With lanes the report runs in a child (offloop.mjs), through the
      // scheduler's task runner (on the run's locks): its overlap checks would
      // stop the supervision of every worker in flight. Its answers per commit
      // pair come back with it, for the next look.
      const offLoop = deps.offLoop ?? defaultOffLoop;
      const reportLandingOffLoop = async (v, seq, runTask = offLoop) => {
        const r = await runTask('reportLanding', { repoRoot, mainRoot, runDir, runId, seq, view: v, nowMs: now(), cache: [...mergeChecks] }, { env, cwd: repoRoot });
        for (const line of r.value?.lines ?? []) out(line);
        if (r.error) {
          landing = null;
          out(`⚠ landing-ready: the report failed (${r.error}); the run goes on, and the next look reports it`);
          return;
        }
        mergeChecks.clear();
        for (const [k, a] of r.value.cache) mergeChecks.set(k, a);
        landing = r.value.report;
      };
      return await runLanes({
        repoRoot, options: { ...options, lanes }, env, out, now, roots, pinned, remotes, stateRoot, token, record,
        runId, runDir, run, mainRoot, macroId, view, locks, driverLock: locks[0], macroLock: locks[1],
        finish, reportLanding: reportLandingOffLoop, landing: () => landing, withLanding: (d) => withLanding(d, landing),
        markLingering: () => { lingering = true; },
        keepOpenRecord: () => { keepRecord = true; },
        setLastSessionId: (id) => { lastSessionId = id ?? lastSessionId; },
        interrupted: () => interrupted,
        onInterrupt: (fn) => { onInterrupt = fn; },
        groupsInFlight: (fn) => { groupsInFlight = fn; },
        observeAsync: deps.observeAsync ?? (deps.observe ? async (a) => deps.observe(a) : observeInChild),
        offLoop, startWorker, terminateGroup: deps.terminateGroup ?? null,
        helpers: { provenanceProblem, newPendingRuns },
      });
    }

    const loaded = {};
    const ctx = { runId, macroId, forced: options.forced ?? null, finalizeAttempted: false };
    const budget = createBudget({
      maxSteps: options.maxSteps, maxCostUsd: options.maxCostUsd, stepBudgetUsd: options.stepBudgetUsd,
      stepTimeoutSec: options.stepTimeoutSec, maxTimeSec: options.maxTimeSec, startedAt, now,
    });
    for (let seq = 1; ; seq += 1) {
      if (interrupted) return finish('halted', { reason: 'interrupted', detail: 'the owner interrupted the run' });
      // What the state says comes first: completion on the last step the
      // budget allowed is completion, and a halt is the halt it is.
      const d = decide(view, ctx);
      if (d.outcome === 'completed') {
        out(`[${seq}] ${d.detail}`);
        return finish('completed');
      }
      if (d.outcome === 'halt') return finish('halted', withLanding(d, landing));

      // ADR-0067 Decision 6, Budgets: the step is reserved before it spawns,
      // and every end settles it. One reservation at a time: what is spent,
      // the steps taken and the time elapsed decide, as they always did.
      const r = budget.reserve();
      if (!r.ok) return finish('halted', { reason: 'budget', detail: r.detail ?? r.why });
      reservation = r.reservation;
      if (seq > 1) {
        const drift = driftOf(pinned, await resolveRoots({ env }));
        if (drift.length > 0) {
          budget.settle(reservation, { spawned: false });
          reservation = null;
          return finish('halted', { reason: 'version-drift', detail: drift.join('; ') });
        }
      }

      const s = d.step;
      if (!STEP_KINDS.includes(s.kind)) throw new Error(`policy returned an unknown step kind ${s.kind}`);
      const command = renderStep(s, { macroId: view.macro.id, runId });
      const { model, effort } = modelFor(s, { plan: options.models, override: { model: options.model, effort: options.effort } });
      // The run's caps bound the step too: the step may spend only what is
      // left, and may run only until the run's deadline.
      const stepBudgetUsd = reservation.usd;
      const stepTimeoutSec = reservation.timeoutSec;
      const sessionId = randomUUID();
      const fpBefore = fingerprint(view);
      // D1: the spawn is on record before it starts.
      appendStep(runDir, {
        event: 'started', seq, kind: s.kind, command, subtask_id: s.subtaskId ?? null, forced: s.forced === true,
        session_id: sessionId, model, effort, step_budget_usd: stepBudgetUsd, step_timeout_sec: stepTimeoutSec,
        started_at: new Date(now()).toISOString(), fingerprint_before: fpBefore,
      });
      out(`[${seq}] ${command}${s.subtaskId ? ` (subtask ${s.subtaskId})` : ''}${model || effort ? ` · ${model ?? 'default'}/${effort ?? 'default'}` : ''}`);

      current = startWorker({
        cwd: repoRoot, prompt: command, stepKind: s.kind, runId, seq, roots, sessionId,
        stepBudgetUsd, stepTimeoutSec, model, effort, rawPath: workerStreamPath(runDir, seq), env, remotes,
        stateBase: stateRoot.root,
        autopilotToken: token,
        checkInit: (plugins) => provenanceProblem(plugins, { pinned, repoRoot, loaded }),
        ...(deps.terminateGroup ? { terminateGroup: deps.terminateGroup } : {}),
      });
      // The worker is on the locks before it has anything to do: a driver
      // that dies here leaves a worker with no prompt, which exits when its
      // stdin closes, and a lock no second run reclaims while it lives.
      if (Number.isInteger(current.pid)) setWorker({ pid: current.pid, pgid: process.platform === 'win32' ? null : current.pid, fingerprint: await processFingerprint(current.pid), session_id: sessionId });
      current.begin();
      const w = await current.done;
      current = null;
      if (w.groupTeardown === 'lingering') lingering = true;
      else setWorker(null);
      lastSessionId = w.sessionId;
      ctx.forced = null;
      if (s.kind === 'finalize') ctx.finalizeAttempted = true;
      if (!w.aborted && Array.isArray(w.plugins)) {
        for (const name of PLUGINS) {
          const entry = w.plugins.find((p) => p?.name === name);
          if (entry?.path && !loaded[name]) loaded[name] = canonical(entry.path);
        }
        if (!run.loaded_plugins) run.loaded_plugins = { ...loaded };
      }
      run.steps = seq;
      // A step that reported no cost (killed, or a spawn error) is charged its
      // whole reservation.
      const cost = budget.settle(reservation, { spawned: true, costUsd: w.costUsd });
      reservation = null;
      run.cost_complete = budget.costComplete;
      run.cost_usd = budget.spent;
      run.accounted_seqs.push(seq);

      const before = view;
      view = observe({ repoRoot, roots, macroId: view.macro.id, fetch: true, env });
      let verdict = interrupted && !w.aborted
        ? { outcome: 'halt', reason: 'interrupted', detail: 'the owner interrupted the run' }
        : verifyStep({ step: s, worker: w, before, after: view, oversizePct: options.oversizePct });
      let cancelled = [];
      if (verdict && (w.aborted || verdict.reason === 'worker-failed' || verdict.reason === 'interrupted')) {
        cancelled = cancelPeerRuns(newPendingRuns(before, view, s.subtaskId), { roots, checkout: repoRoot, env });
        if (cancelled.length) {
          verdict = { ...verdict, detail: `${verdict.detail}; cancelled the step's pending peer run(s) ${cancelled.map((c) => c.run_id).join(', ')}` };
        }
      }
      appendStep(runDir, {
        event: 'finished', seq, ended_at: new Date(now()).toISOString(),
        exit: w.exitCode, signal: w.signal, aborted: w.aborted, abort_detail: w.abortDetail ?? null,
        spawn_error: w.spawnError, is_error: w.lastResult?.is_error ?? null, result_subtype: w.lastResult?.subtype ?? null,
        turns: w.turns, cost_usd: w.costUsd, cost_charged_usd: cost, peak_ctx: w.peakCtx, peak_pct: w.peakPct,
        context_window: w.contextWindow, permission_denials: w.denials, report: w.report, raw_truncated: w.rawTruncated,
        group_teardown: w.groupTeardown,
        peer_cancellations: cancelled, fingerprint_after: fingerprint(view), outcome: verdict ? verdict.reason : 'ok',
      });
      writeRun(runDir, run);
      const pct = w.peakPct == null ? '?' : `${(w.peakPct * 100).toFixed(1)}%`;
      out(`    exit=${w.exitCode ?? w.signal} cost=$${(w.costUsd ?? cost).toFixed(2)}${w.costUsd === null ? ' (unreported; budget charged)' : ''} peak=${w.peakCtx} (${pct}) denials=${w.denials.length}`);
      // A commit stands whatever the verdict on its step.
      reportLanding(view, seq);
      if (verdict) return finish('halted', verdict);
    }
  } catch (e) {
    // The run could not go on: record it, release the locks, and let the CLI
    // report the error (exit 1). A step in flight is torn down first, and a
    // group that outlived SIGKILL keeps the run's lock entries, as on every
    // other end. The open-run record stays, so stop, or the next run, cleans
    // up after the step (its peers, its budget).
    if (current) {
      current.abort('interrupted');
      const w = await current.done;
      if (w?.groupTeardown === 'lingering') lingering = true;
      current = null;
    }
    run.status = 'error';
    run.ended_at = new Date(now()).toISOString();
    run.error = e?.message ?? String(e);
    writeRun(runDir, run);
    release();
    detach();
    throw e;
  }
}
