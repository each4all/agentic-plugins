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
// timeout or abort, and, through engineer's own `peer-runner cancel`, the peer
// runs that step left pending (a peer runs detached from the worker's group).

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { orderText, overlapText, reportLandingReady } from './landing-ready.mjs';
import { observe as defaultObserve } from './observe.mjs';
import {
  decide, fingerprint, modelFor, renderStep, verifyStep, STEP_KINDS,
} from './policy.mjs';
import {
  appendStep, acquireLock, createRunDir, LockHeldError, macroLockPath, mainWorktreeRoot, newRunId,
  processFingerprint, workerStreamPath, worktreeLockPath, writeHalt, writeRun,
} from './ledger.mjs';
import {
  capabilityProblems, driftOf, frozenInputProblems, PLUGINS, resolveRoots,
} from './roots.mjs';
import {
  ALLOWED_TOOLS, COMMIT_DENY, DENIED_TOOLS, claudeBin, startWorker as defaultStartWorker,
} from './worker.mjs';

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
// A step with less than this left of the run's cost cap is not started.
const MIN_STEP_BUDGET_USD = 0.5;
const MIN_STEP_TIMEOUT_SEC = 60;
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
export async function preflight({ repoRoot, env = process.env, checkClaude = true }) {
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
  return { problems, warnings, roots: resolved, claude };
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

// Every peer run pending on an engineer workflow of this macro: the
// in-progress subtasks' children, and any workflow that claims the macro —
// a dispatch killed before it recorded its subtask in progress leaves one.
function pendingRuns(view) {
  const ids = new Set();
  for (const c of Object.values(view?.children ?? {})) for (const id of c?.pending_runs ?? []) ids.add(id);
  for (const c of view?.claims ?? []) for (const id of c?.pending_runs ?? []) ids.add(id);
  return ids;
}

/** Peer runs a step started and left pending (engineer `pending_ensemble`). */
export function newPendingRuns(before, after) {
  const had = pendingRuns(before);
  return [...pendingRuns(after)].filter((id) => !had.has(id));
}

// A peer runs detached from the worker's process group, so killing the worker
// leaves it running. Cancel it through engineer's supervisor, which verifies
// the process fingerprint before it signals anything.
function cancelPeerRuns(runIds, { roots, repoRoot, env }) {
  const cli = join(roots.engineer, 'scripts', 'peer-runner.mjs');
  return runIds.map((runId) => {
    const r = spawnSync(process.execPath, [cli, 'cancel', '--run-id', runId, '--repo-root', repoRoot], {
      cwd: repoRoot, env, encoding: 'utf8', timeout: 60_000,
    });
    let out = null;
    try { out = JSON.parse((r.stdout ?? '').trim()); } catch { /* not JSON */ }
    return { run_id: runId, exit: r.status, result: out ?? (r.stderr ?? '').trim().slice(-300) };
  });
}

function haltRecord({ runId, d, lastSessionId, repoRoot }) {
  const resume = [];
  if (lastSessionId) resume.push(`claude --resume ${lastSessionId}   # inspect the last step interactively`);
  resume.push(d.reason === 'awaiting-landing'
    ? 'Push each branch listed, open and review its pull request, merge it, then relaunch:'
    : 'Resolve what the reason names, then relaunch:');
  resume.push(`/orchestrator:autopilot start --execute   (or: agentic-autopilot start --execute --repo ${repoRoot})`);
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

/**
 * Start a run. Resolves to the exit code: 0 completed, 2 halted, 1 error.
 *
 * @param a.repoRoot  the worktree toplevel the run drives
 * @param a.options   parsed CLI options (budgets, models, macro, forced, notifyLocal)
 * @param a.env       the environment (workers inherit it, scrubbed)
 * @param a.out, a.err  line printers
 * @param a.deps      test seams: { observe, startWorker, now, signals, checkClaude }
 */
export async function startRun({ repoRoot, options, env = process.env, out = console.log, err = console.error, deps = {} }) {
  const observe = deps.observe ?? defaultObserve;
  const startWorker = deps.startWorker ?? defaultStartWorker;
  const now = deps.now ?? (() => Date.now());
  const pre = await preflight({ repoRoot, env, checkClaude: deps.checkClaude ?? true });
  for (const w of pre.warnings) out(`⚠ ${w}`);
  if (pre.problems.length > 0) {
    err('✗ The autopilot cannot start:');
    for (const p of pre.problems) err(`  - ${p}`);
    return 1;
  }
  const pinned = pre.roots;
  const roots = pinned.roots;
  const remotes = remoteUrls(repoRoot);

  let view = observe({ repoRoot, roots, macroId: options.macro ?? null, fetch: true, env });
  const macroId = view.macro?.id ?? null;
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
      forced: options.forcedText ?? null, notify_local: options.notifyLocal === true,
    },
    claude_version: pre.claude,
    roots,
    versions: pinned.versions,
    sources: pinned.sources,
    loaded_plugins: null,
    git_baseline: { branch: view.git.branch, head: view.git.head },
    steps: 0,
    cost_usd: 0,
    cost_complete: true,
    halt: null,
  };
  writeRun(runDir, run);

  const locks = [];
  // A step whose process group outlived SIGKILL leaves the run's entries in
  // place: they name the group, and holderAlive counts it while it has members.
  let lingering = false;
  const release = () => {
    if (lingering) locks.length = 0;
    while (locks.length) locks.pop().release();
  };
  const setWorker = (worker) => { for (const l of locks) l.setWorker(worker); };
  let lastSessionId = null;
  let current = null;
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    current?.abort('interrupted');
  };
  const signals = deps.signals ?? process;
  signals.on('SIGINT', onSignal);
  signals.on('SIGTERM', onSignal);
  const detach = () => {
    signals.off?.('SIGINT', onSignal);
    signals.off?.('SIGTERM', onSignal);
  };

  const finish = (status, d = null) => {
    run.status = status;
    run.ended_at = new Date(now()).toISOString();
    if (d) {
      run.halt = haltRecord({ runId, d, lastSessionId, repoRoot });
      writeHalt(runDir, run.halt);
      printHalt(out, d);
      for (const line of run.halt.resume) out(`  ${line}`);
    } else {
      out(`■ ${status}`);
    }
    writeRun(runDir, run);
    release();
    detach();
    out(`  run ${runId} · steps=${run.steps} · cost=$${run.cost_usd.toFixed(2)}${run.cost_complete ? '' : ' (at least: a killed step reported no cost, so its budget was counted)'} · ledger ${runDir}`);
    notifyLocal(options, `autopilot: ${status}`, d ? `${d.reason} — ${d.detail}` : 'the macro completed');
    return status === 'completed' ? 0 : 2;
  };

  try {
    out(`autopilot ${runId}`);
    out(`  repo ${repoRoot} · macro ${macroId ?? '(none)'} · ${Object.entries(pinned.versions).map(([k, v]) => `${k} ${v}`).join(', ')}`);

    const record = { run_id: runId, repo: repoRoot, macro_id: macroId, started_at: run.started_at };
    // Read once: the macro's landing log is kept beside its lock (ADR-0067
    // Decision 7), and a second read that fell back to repoRoot would part them.
    const mainRoot = mainWorktreeRoot(repoRoot);
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

    const loaded = {};
    const ctx = { runId, macroId, forced: options.forced ?? null, finalizeAttempted: false };
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

      const elapsed = (now() - startedAt) / 1000;
      if (seq > options.maxSteps) return finish('halted', { reason: 'budget', detail: `the run reached its step cap (${options.maxSteps})` });
      if (options.maxCostUsd - run.cost_usd < MIN_STEP_BUDGET_USD) {
        return finish('halted', { reason: 'budget', detail: `the run spent $${run.cost_usd.toFixed(2)} of its $${options.maxCostUsd} cap` });
      }
      if (options.maxTimeSec - elapsed < MIN_STEP_TIMEOUT_SEC) {
        return finish('halted', { reason: 'budget', detail: `the run reached its wall clock (${options.maxTimeSec} s)` });
      }
      if (seq > 1) {
        const drift = driftOf(pinned, await resolveRoots({ env }));
        if (drift.length > 0) return finish('halted', { reason: 'version-drift', detail: drift.join('; ') });
      }

      const s = d.step;
      if (!STEP_KINDS.includes(s.kind)) throw new Error(`policy returned an unknown step kind ${s.kind}`);
      const command = renderStep(s, { macroId: view.macro.id, runId });
      const { model, effort } = modelFor(s, { plan: options.models, override: { model: options.model, effort: options.effort } });
      // The run's caps bound the step too: the step may spend only what is
      // left, and may run only until the run's deadline.
      const stepBudgetUsd = Math.min(options.stepBudgetUsd, options.maxCostUsd - run.cost_usd);
      const stepTimeoutSec = Math.floor(Math.min(options.stepTimeoutSec, options.maxTimeSec - elapsed));
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
      const cost = w.costUsd ?? stepBudgetUsd;
      if (w.costUsd === null) run.cost_complete = false;
      run.cost_usd += cost;

      const before = view;
      view = observe({ repoRoot, roots, macroId: view.macro.id, fetch: true, env });
      let verdict = interrupted && !w.aborted
        ? { outcome: 'halt', reason: 'interrupted', detail: 'the owner interrupted the run' }
        : verifyStep({ step: s, worker: w, before, after: view, oversizePct: options.oversizePct });
      let cancelled = [];
      if (verdict && (w.aborted || verdict.reason === 'worker-failed' || verdict.reason === 'interrupted')) {
        cancelled = cancelPeerRuns(newPendingRuns(before, view), { roots, repoRoot, env });
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
    // report the error (exit 1).
    current?.abort('interrupted');
    run.status = 'error';
    run.ended_at = new Date(now()).toISOString();
    run.error = e?.message ?? String(e);
    writeRun(runDir, run);
    release();
    detach();
    throw e;
  }
}
