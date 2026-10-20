// plugins/orchestrator/adapters/claude/autopilot/driver.mjs
//
// ADR-0063 D1/D3/D4/D8 — the run: observe → decide → act → verify, one fresh
// worker per step, until the macro completes or the policy halts.
//
// The driver is stateless across runs: every iteration re-derives the view
// from durable state, so relaunching after a halt continues where the state
// says. It is bounded (steps, total cost, per-step budget and wall clock; no
// run clock, ADR-0063 D1 amendment of 2026-10-13), foreground, and exits on
// completion (0), on a halt (2), or on
// an error that prevented a run (1). It never pushes, opens or merges a pull
// request, never switches branches itself, never archives, and never resumes,
// forks or compacts a session (D1). After each look under its locks it reports
// every subtask committed and not landed whose commit, integration tip or
// readiness (ready, needing a sync with the integration branch, or unknown)
// changed since its last report (landing-ready.mjs, ADR-0067 Decision 7), and
// goes on.
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
import { mergeOrderRecord, orderText, overlapText, reportLandingReady, syncText } from './landing-ready.mjs';
import { lanesHoldingWork, lanesRequirements } from './lanes.mjs';
import { launchProposals, mainCheckoutProposal, proposalLines } from './launch-proposals.mjs';
import { observe as defaultObserve } from './observe.mjs';
import {
  afterUnread, decide, fingerprint, modelFor, peersOnlyProgress, proposalLines as haltProposalLines, renderStep, verifyStep, STEP_KINDS,
} from './policy.mjs';
import {
  appendStep, acquireLock, createRunDir, LockHeldError, macroLockPath, mainWorktreeRoot, newRunId,
  processFingerprint, relaunchCommand, releaseCommand, removeOpenRun, workerStreamPath, worktreeLockPath, writeHalt, writeOpenRun, writeRun,
} from './ledger.mjs';
import {
  capabilityProblems, driftOf, frozenInputProblems, lanesCapabilityProblems, PLUGINS, resolveRoots,
} from './roots.mjs';
import { observeInChild, offLoop as defaultOffLoop } from './offloop.mjs';
import { readParks, retiring } from './parks.mjs';
import {
  abandonedText, endedUnlooked, foundWaiting, laneBlock, ownChildOnly, peerCancellationOutcome, peerRunnerCommand, peerSettlementOutcome, peersUnlisted,
  reconcileWaiting, reportClosePeersUnlisted, runLanes,
} from './scheduler.mjs';
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
      step_timeout_sec: options.stepTimeoutSec,
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

/**
 * The pending rows behind newPendingRuns, each with what `peer-runner settle`
 * needs: { run_id, phase, workflow_path, workflow_id } (C127). A run two
 * workflows list differently, or one listed without a phase or a path, is a
 * conflict, named and never settled: the run halts on it instead.
 */
export function newPendingTargets(before, after, subtaskId) {
  const fresh = new Set(newPendingRuns(before, after, subtaskId));
  const rows = [];
  const add = (wf, pathOf, idOf) => {
    for (const r of wf?.pending_rows ?? []) rows.push({ run_id: r.run_id, phase: r.phase ?? null, workflow_path: pathOf ?? null, workflow_id: idOf ?? null });
  };
  if (subtaskId) {
    const child = after?.children?.[subtaskId];
    if (child) add(child, child.path, child.workflow_id);
    for (const c of after?.claims ?? []) if (c?.originating_subtask === subtaskId) add(c, c.path, c.id);
  }
  const byRun = new Map();
  const conflicts = [];
  const bad = new Set();
  const label = (t) => `${t.workflow_id ?? t.workflow_path ?? 'no workflow'} (phase ${t.phase ?? 'none'})`;
  for (const t of rows) {
    if (!fresh.has(t.run_id) || bad.has(t.run_id)) continue;
    if (!t.phase || !t.workflow_path) {
      bad.add(t.run_id);
      conflicts.push(`peer run ${t.run_id} is pending on ${label(t)} with no ${t.phase ? 'workflow path' : 'phase'} to settle it by`);
      continue;
    }
    const key = `${canonical(t.workflow_path)}\0${t.workflow_id}\0${t.phase}`;
    const seen = byRun.get(t.run_id);
    if (!seen) byRun.set(t.run_id, { key, t });
    else if (seen.key !== key) {
      bad.add(t.run_id);
      conflicts.push(`peer run ${t.run_id} is pending on both ${label(seen.t)} and ${label(t)}`);
    }
  }
  for (const id of fresh) {
    if (!byRun.has(id) && !bad.has(id)) conflicts.push(`peer run ${id} is pending, but no workflow's pending row names its phase`);
  }
  return { targets: [...byRun.values()].filter(({ t }) => !bad.has(t.run_id)).map(({ t }) => t), conflicts };
}

const peerRunner = (roots, args, checkout, env) => {
  const cli = join(roots.engineer, 'scripts', 'peer-runner.mjs');
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: checkout, env, encoding: 'utf8', timeout: 60_000 });
  let out = null;
  try { out = JSON.parse((r.stdout ?? '').trim()); } catch { /* not JSON */ }
  return { exit: r.status, result: out ?? (r.stderr ?? '').trim().slice(-300), command: peerRunnerCommand(roots, args) };
};

// A peer runs detached from the worker's process group, so killing the worker
// leaves it running. Cancel it through engineer's supervisor, which verifies
// the process fingerprint before it signals anything, from the checkout the
// step ran in: its read set holds the workflow's home, where the run's ledger
// is (ADR-0067 Decision 4, item 2).
export function cancelPeerRuns(runIds, { roots, checkout, env }) {
  return runIds.map((runId) => {
    const { exit, result } = peerRunner(roots, ['cancel', '--run-id', runId, '--repo-root', checkout], checkout, env);
    return { run_id: runId, exit, result };
  });
}

/**
 * C127 — the peer runs a step left pending when it finished on its report
 * with background tasks pending: each is cancelled (a run already ended is
 * left as it is), then settled from its ledger by engineer's `peer-runner
 * settle`, with no verdict: a run that failed, was cancelled or was abandoned
 * is recorded `failed`, one that completed with no usable answer `degraded`,
 * and one that completed with an answer is refused — no synthesis is
 * invented for it, and the step halts naming it. Each entry is the target
 * with { cancel, settle, command } — `command` the one to run by hand when
 * a part did not go through.
 */
export function settleAbandonedPeers(targets, { roots, checkout, env }) {
  return targets.map((t) => {
    const cancel = peerRunner(roots, ['cancel', '--run-id', t.run_id, '--repo-root', checkout], checkout, env);
    if (cancel.exit !== 0) return { ...t, cancel: { exit: cancel.exit, result: cancel.result }, settle: null, command: cancel.command };
    const settle = peerRunner(roots, ['settle', '--workflow-path', t.workflow_path, '--phase', t.phase, '--run-id', t.run_id, '--repo-root', checkout], checkout, env);
    return { ...t, cancel: { exit: cancel.exit, result: cancel.result }, settle: { exit: settle.exit, result: settle.result }, command: settle.exit === 0 ? null : settle.command };
  });
}

function haltRecord({ runId, d, lastSessionId, repoRoot, macroId, lanes }) {
  const resume = [];
  if (lastSessionId) resume.push(`claude --resume ${lastSessionId}   # inspect the last step interactively`);
  resume.push(d.reason === 'awaiting-landing'
    ? `Bring each branch that needs a sync up to date with ${d.integration ? `origin/${d.integration}` : 'the integration branch'} (merge or rebase, then push), push the others, open and review each pull request, merge it once its CI passes on the merged tree, then relaunch:`
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
    // Snake case, as landing.jsonl keeps it (C123).
    merge_order: d.mergeOrder ? mergeOrderRecord(d.mergeOrder) : null,
    // ADR-0067 Decision 8, item 5 — display only, never acted on: each
    // {kind, command, pointer}, built by the policy from checked parts.
    proposals: d.proposals ?? [],
    last_session_id: lastSessionId,
    resume,
    // A run with lanes: the other halts it met and the open parks beside the
    // reason, a parked lane's resolution, and one entry per lane (ADR-0068
    // Decision 1, item 9).
    ...(d.also ? { also: d.also } : {}),
    ...(d.resolution ? { resolution: d.resolution } : {}),
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
    if (w.sync) out(`      ${syncText(w.sync, d.integration ? `refs/remotes/origin/${d.integration}` : null)}`);
    if (w.overlap) out(`      at ${w.commit ?? 'no commit'} · overlap: ${overlapText(w.overlap)}`);
    for (const c of [...(w.sync?.commands ?? []), ...(w.commands ?? [])]) out(`      ${c}`);
    for (const n of [w.sync?.note, w.note]) if (n) out(`      ${n}`);
  }
  if (d.mergeOrder) out(`  merge order: ${orderText(d.mergeOrder)}`);
  for (const line of haltProposalLines(d.proposals)) out(line);
}

// A halt's list of what waits to land is the run's list (C128, scheduler.mjs
// `reconcileWaiting`), reconciled by the end that builds it: each branch's
// commit, freshness (with its sync commands) and overlap as the latest look
// that judged it found them, unknown where no look could, never the list of
// the decision's own look. The policy's push commands and notes stay, and the
// last report's integration branch and merge order. An awaiting-landing halt
// carries the list even when it is empty (every branch landed while the run
// ended); a halt for any other reason carries it when something waits. A
// serial run's `finish` and a run with lanes' `end` (for its awaiting-landing
// halt; each lane's report lists the rest) are the only callers.
export function withLanding(d, report, waiting) {
  if (d.reason !== 'awaiting-landing' && waiting.length === 0) return d;
  const facts = report ? { integration: report.integration, mergeOrder: report.mergeOrder } : {};
  return { ...d, waiting, ...facts };
}

// ADR-0067 Decision 6: a serial run does not reconcile lanes, and would halt
// on their active children or ask for a switch to a branch git will not check
// out twice; it refuses while a lane of the macro holds unfinished work.
// ADR-0068 Decision 2, item 2: nor does it start beside a kept park, which
// only a run with lanes honours (parks.mjs); one that no longer applies (its
// subtask completed or gone) does not count.
function serialRefusal({ repoRoot, macroId, view, env }) {
  if (!macroId) return [];
  const problems = [];
  const held = lanesHoldingWork({ checkout: repoRoot, macroId, view, env });
  if (held.problem) problems.push(held.problem);
  else if (held.lanes.length > 0) {
    problems.push(`a lane of macro ${macroId} holds work that is not completed (${held.lanes.map((l) => `${l.subtaskId}=${l.status} at ${l.path}`).join(', ')}): ` +
      `a serial run does not drive lanes. Run it with lanes: ${relaunchCommand({ macroId, lanes: 2, repoRoot })}`);
  }
  const kept = readParks(mainWorktreeRoot(repoRoot), macroId);
  if (kept.problem) {
    problems.push(`whether macro ${macroId} keeps a parked lane cannot be told (${kept.problem}): a serial run does not start beside a kept park`);
  } else {
    const gone = new Set(retiring(kept.records, view));
    const open = kept.records.filter((r) => !gone.has(r.subtaskId));
    if (open.length > 0) {
      problems.push(`macro ${macroId} keeps ${open.length} parked lane${open.length === 1 ? '' : 's'} (${open.map((r) => `${r.subtaskId}: ${r.state === 'ok' ? `${r.record.reason} — ${r.record.detail}` : `an unreadable record, ${r.error}`}`).join('; ')}): ` +
        `a serial run does not start beside a kept park. Release each (${open.map((r) => releaseCommand({ subtaskId: r.subtaskId, macroId, repoRoot })).join('; ')}), or run with lanes: ${relaunchCommand({ macroId, lanes: 2, repoRoot })}`);
    }
  }
  return problems;
}

/**
 * Start a run. Resolves to the exit code: 0 completed, 2 halted, 1 error.
 *
 * @param a.repoRoot  the worktree toplevel the run drives
 * @param a.options   parsed CLI options (budgets, models, macro, forced, notifyLocal)
 * @param a.env       the environment (workers inherit it, scrubbed)
 * @param a.out, a.err  line printers
 * @param a.deps      test seams: { observe, observeAsync, offLoop, startWorker, cancelPeerRuns, settleAbandonedPeers, now, signals,
 *                    checkClaude, terminateGroupsSync, resolveRoots (the drift check between steps), createBudget,
 *                    wakeIntervalMs, quietMs and laneBusy (a run with lanes: scheduler.mjs) }
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

  // What the run's looks found waiting to land (C128, scheduler.mjs
  // `reconcileWaiting`). Every look of the serial run goes through `look`,
  // which feeds the list as the look returns, before its report and whether
  // or not it failed: a later look, a retry or an end can then no longer keep
  // what it found from the list. A look's report feeds it again with the
  // report's facts (`reportLanding`); until then what a look newly found is
  // unknown, so a halt before the first report (the locks are held) still
  // names it.
  let waiting = [];
  const look = (id) => {
    const v = observe({ repoRoot, roots, macroId: id, fetch: true, env });
    waiting = reconcileWaiting(waiting, v, foundWaiting(v, false, null));
    return v;
  };

  let view = look(options.macro ?? null);
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
      step_timeout_sec: options.stepTimeoutSec,
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
  // A run whose look after a step failed, or could not read the macro, its
  // readiness or the step's child, keeps its open-run record: that step's
  // peers are unknown, and the next run's cleanup cancels the ones that name
  // it (scheduler.mjs, and the serial loop below).
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
  // The last landing-ready report.
  let landing = null;
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
    // A run with lanes reports what waits per lane, and its end builds its
    // halt's list (scheduler.mjs). A serial run's halt is built here and
    // nowhere else, whatever ended it (C128): from the run's list, which every
    // look has fed as it returned, and, when the owner interrupted the run,
    // with nothing on it confirmed.
    if (d && !laneReport) {
      if (interrupted) waiting = endedUnlooked(waiting, 'the owner interrupted the run');
      d = withLanding(d, landing, waiting);
    }
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
    // keeps the lock entries, and so does a step whose peers the run could
    // not account for (keepRecord).
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
    view = look(macroId);
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
    // committed and not landed whose observation changed is reported, a
    // waiting one found at the start included. The report is never a gate: a
    // failure is printed, and the next look reports what it missed.
    const mergeChecks = new Map();
    // C123: a failure to record or make the report is printed once, until a
    // report is recorded in full (landing-ready.mjs `reportLandingReady`).
    const notice = { warned: false };
    const reportFailed = (why) => {
      landing = null;
      if (!notice.warned) out(`⚠ landing-ready: the report failed (${why}); the run goes on, the next look reports it, and this is not printed again until a report is recorded`);
      notice.warned = true;
    };
    const reportLanding = (v, seq) => {
      try {
        landing = reportLandingReady({ repoRoot, mainRoot, runDir, runId, seq, view: v, out, now, cache: mergeChecks, env, notice });
      } catch (e) {
        reportFailed(e?.message ?? e);
      }
      waiting = reconcileWaiting(waiting, v, foundWaiting(v, true, landing));
    };
    reportLanding(view, 0);

    if (lanes >= 2) {
      // With lanes the report runs in a child (offloop.mjs), through the
      // scheduler's task runner (on the run's locks): its overlap checks would
      // stop the supervision of every worker in flight. Its answers per commit
      // pair come back with it, for the next look.
      const offLoop = deps.offLoop ?? defaultOffLoop;
      const reportLandingOffLoop = async (v, seq, runTask = offLoop) => {
        const r = await runTask('reportLanding', { repoRoot, mainRoot, runDir, runId, seq, view: v, nowMs: now(), cache: [...mergeChecks], warned: notice.warned }, { env, cwd: repoRoot });
        for (const line of r.value?.lines ?? []) out(line);
        if (r.error) {
          reportFailed(r.error);
          return;
        }
        // The child's notice comes back: a failure it printed, or a report it recorded.
        notice.warned = r.value.warned === true;
        mergeChecks.clear();
        for (const [k, a] of r.value.cache) mergeChecks.set(k, a);
        landing = r.value.report;
      };
      return await runLanes({
        repoRoot, options: { ...options, lanes }, env, out, now, roots, pinned, remotes, stateRoot, token, record,
        runId, runDir, run, mainRoot, macroId, view, locks, driverLock: locks[0], macroLock: locks[1],
        finish, reportLanding: reportLandingOffLoop, landing: () => landing, withLanding: (d, w) => withLanding(d, landing, w),
        waiting: () => waiting,
        markLingering: () => { lingering = true; },
        keepOpenRecord: () => { keepRecord = true; },
        setLastSessionId: (id) => { lastSessionId = id ?? lastSessionId; },
        interrupted: () => interrupted,
        onInterrupt: (fn) => { onInterrupt = fn; },
        groupsInFlight: (fn) => { groupsInFlight = fn; },
        observeAsync: deps.observeAsync ?? (deps.observe ? async (a) => deps.observe(a) : observeInChild),
        offLoop, startWorker, terminateGroup: deps.terminateGroup ?? null,
        helpers: { provenanceProblem, newPendingRuns, newPendingTargets },
        wakeIntervalMs: deps.wakeIntervalMs ?? null, quietMs: deps.quietMs ?? null, laneBusy: deps.laneBusy ?? null,
        resolveRoots: deps.resolveRoots ?? null,
      });
    }

    const loaded = {};
    const ctx = { runId, macroId, forced: options.forced ?? null, finalizeAttempted: false };
    const budget = (deps.createBudget ?? createBudget)({
      maxSteps: options.maxSteps, maxCostUsd: options.maxCostUsd, stepBudgetUsd: options.stepBudgetUsd,
      stepTimeoutSec: options.stepTimeoutSec,
    });
    const resolveRootsNow = deps.resolveRoots ?? resolveRoots;
    for (let seq = 1; ; seq += 1) {
      if (interrupted) return finish('halted', { reason: 'interrupted', detail: 'the owner interrupted the run' });
      // What the state says comes first: completion on the last step the
      // budget allowed is completion, and a halt is the halt it is.
      const d = decide(view, ctx);
      if (d.outcome === 'completed') {
        out(`[${seq}] ${d.detail}`);
        return finish('completed');
      }
      if (d.outcome === 'halt') return finish('halted', d);

      // ADR-0067 Decision 6, Budgets: the step is reserved before it spawns,
      // and every end settles it. One reservation at a time: what is spent
      // and the steps taken decide.
      const r = budget.reserve();
      if (!r.ok) return finish('halted', { reason: 'budget', detail: r.detail ?? r.why });
      reservation = r.reservation;
      const drift = seq > 1 ? driftOf(pinned, await resolveRootsNow({ env })) : [];
      // C123: a signal that came during the await above finds no worker to
      // abort; the check at the loop's top has passed. Nothing awaits from
      // here to the spawn, so this is the last point to see it (a run with
      // lanes yields at the same point, scheduler.mjs mustYield). It comes
      // before the drift the same await found: the owner stopped the run.
      if (interrupted) {
        budget.settle(reservation, { spawned: false });
        reservation = null;
        return finish('halted', { reason: 'interrupted', detail: 'the owner interrupted the run' });
      }
      if (drift.length > 0) {
        budget.settle(reservation, { spawned: false });
        reservation = null;
        return finish('halted', { reason: 'version-drift', detail: drift.join('; ') });
      }

      const s = d.step;
      if (!STEP_KINDS.includes(s.kind)) throw new Error(`policy returned an unknown step kind ${s.kind}`);
      const command = renderStep(s, { macroId: view.macro.id, runId });
      const { model, effort } = modelFor(s, { plan: options.models, override: { model: options.model, effort: options.effort } });
      // The run's cost cap bounds the step too: the step may spend only what
      // is left. It runs for the whole per-step timeout, however late it starts.
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
      const id = s.subtaskId ?? null;
      view = look(view.macro.id);
      // A look that could not read the step's peers, once more: a child
      // archived between the scan and its read is a legitimate transition (as
      // in a lane, scheduler.mjs).
      if (peersUnlisted(view, id)) view = look(before.macro.id);
      let verdict = interrupted && !w.aborted
        ? { outcome: 'halt', reason: 'interrupted', detail: 'the owner interrupted the run' }
        : verifyStep({ step: s, worker: w, before, after: view });
      // Whether this step's peers are unaccounted for: the run keeps its
      // open-run record, and the step's finished line says so, so the next
      // run's cleanup searches this step for them (dead-runs.mjs).
      let unaccounted = afterUnread(view, id) !== null;
      let cancelled = [];
      if (verdict && (w.aborted || verdict.reason === 'worker-failed' || verdict.reason === 'interrupted')) {
        // The step's own peers only: a workflow read in place of its child is
        // not the step's (ownChildOnly). A peer whose cancellation did not go
        // through, or that the look could not list, may still run, as in a
        // lane (scheduler.mjs).
        cancelled = (deps.cancelPeerRuns ?? cancelPeerRuns)(newPendingRuns(ownChildOnly(before, id), ownChildOnly(view, id), id), { roots, checkout: repoRoot, env });
        const settled = peerCancellationOutcome(verdict, cancelled, peersUnlisted(view, id));
        if (settled.keep) unaccounted = true;
        verdict = settled.verdict;
      }
      // C127: a step that passed after the host closed stdin on its finished
      // report (whatever came after) may have left peer runs among the tasks it abandoned. Judged
      // first, on the look the verdict read; then each is cancelled and
      // settled from its ledger, and the next decision reads the state that
      // left (the policy halts on a pending row, and a cleanup must neither
      // erase a halt nor make progress of its own).
      let settlements = [];
      if (!verdict && w.reportEof === true) {
        const unlisted = peersUnlisted(view, id);
        if (unlisted) {
          unaccounted = true;
          verdict = reportClosePeersUnlisted(unlisted, id);
        } else {
          const { targets, conflicts } = newPendingTargets(ownChildOnly(before, id), ownChildOnly(view, id), id);
          if (targets.length > 0 || conflicts.length > 0) {
            settlements = (deps.settleAbandonedPeers ?? settleAbandonedPeers)(targets, { roots, checkout: repoRoot, env });
            const o = peerSettlementOutcome(settlements, conflicts);
            if (o.keep) unaccounted = true;
            if (o.verdict) verdict = { ...o.verdict, subtaskId: id };
            // A step whose only change was the peer it left: no progress.
            else if (targets.length > 0) verdict = peersOnlyProgress({ step: s, before, after: view });
            view = look(before.macro.id);
          }
        }
      }
      if (unaccounted) keepRecord = true;
      appendStep(runDir, {
        event: 'finished', seq, ended_at: new Date(now()).toISOString(),
        exit: w.exitCode, signal: w.signal, aborted: w.aborted, abort_detail: w.abortDetail ?? null,
        spawn_error: w.spawnError, is_error: w.lastResult?.is_error ?? null, result_subtype: w.lastResult?.subtype ?? null,
        turns: w.turns, cost_usd: w.costUsd, cost_charged_usd: cost, peak_ctx: w.peakCtx, peak_pct: w.peakPct,
        context_window: w.contextWindow, permission_denials: w.denials, report: w.report, raw_truncated: w.rawTruncated,
        group_teardown: w.groupTeardown,
        report_eof: w.reportEof === true, closed_on_report: w.closedOnReport === true, abandoned_background: w.abandonedBackground ?? [], report_teardown: w.reportTeardown ?? null,
        peer_cancellations: cancelled, peer_settlements: settlements, peers_unaccounted: unaccounted,
        fingerprint_after: fingerprint(view), outcome: verdict ? verdict.reason : 'ok',
      });
      writeRun(runDir, run);
      const pct = w.peakPct == null ? '?' : `${(w.peakPct * 100).toFixed(1)}%`;
      out(`    exit=${w.exitCode ?? w.signal} cost=$${(w.costUsd ?? cost).toFixed(2)}${w.costUsd === null ? ' (unreported; budget charged)' : ''} peak=${w.peakCtx} (${pct}) denials=${w.denials.length}${abandonedText(w)}`);
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
    // C128 — an error after the halt was recorded (while it was printed, for
    // one): the run ended without confirming what the halt lists, so each
    // branch it lists waiting is unknown, and halt.json is written again. Its
    // lanes are the run's own lane entries, which the scheduler's error path
    // has already left unknown.
    const why = `the run stopped on an error: ${run.error}`;
    if (run.halt) {
      if (run.halt.waiting) run.halt = { ...run.halt, waiting: endedUnlooked(run.halt.waiting, why) };
      try {
        writeHalt(runDir, run.halt);
      } catch { /* run.json carries it */ }
    } else if (!run.lanes && waiting.length > 0) {
      // An error before any halt (and before a run with lanes' scheduler
      // reported its lanes): the run's list is recorded nowhere else, so
      // run.json carries it, every entry unknown, for status to show (C128).
      run.waiting = endedUnlooked(waiting, why);
    }
    writeRun(runDir, run);
    release();
    detach();
    throw e;
  }
}
