#!/usr/bin/env node
// plugins/orchestrator/adapters/claude/autopilot/cli.mjs
//
// ADR-0063 D2 — the entry of `/orchestrator:autopilot` and of the optional
// `~/.agentic-plugins/bin/agentic-autopilot` launcher.
//
//   preview (default)   observe, decide, print the posture; spawns nothing
//   start               the same as preview, plus how to execute
//   start --execute     run the autopilot (driver.mjs)
//   status              the latest run's ledger (or --run <id>), and its lock
//   stop                SIGTERM the run that holds a macro's lock; for a run
//                       whose driver died, empty its worker groups and clean
//                       up after it (dead-runs.mjs)
//
// Dry-run by default (ADR-0035 §3 invariant 1 style): only `start --execute`
// starts anything, and it needs a model plan (owner decision D5, 2026-10-01:
// asked before each start). The command runbook asks the owner and passes
// `--models`; a terminal start asks on the TTY; anything else must pass it.
//
// Typed arguments arrive through an ADR-0059 args file (`--args-file`) from
// the runbook, or as argv from a terminal.
//
// Claude-only (D9): refused on any other host.

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { expandArgsFile } from '../../../scripts/lib/args-file.mjs';
import { describeAdmission } from '../../../scripts/lib/run-locks.mjs';
import { isAutopilotRun } from '../../../scripts/state.mjs';
import { MIN_STEP_BUDGET_USD } from './budget.mjs';
import { cleanupDeadRuns } from './dead-runs.mjs';
import { DEFAULTS, posture, preflight, startRun } from './driver.mjs';
import { gatherLaneFacts, laneHome, lanePath, lanesRequirements, planReconciliation } from './lanes.mjs';
import { holderAlive, listLocks, listRuns, mainWorktreeRoot, provablySame, readOpenRun, readRun } from './ledger.mjs';
import { resolveRoots } from './roots.mjs';
import { observe } from './observe.mjs';
import { INTERRUPT_BOUND_MS } from './offloop.mjs';
import {
  decide, decideLanes, fingerprint, forcedForLanes, isSafeSubtaskId, MODEL_PLANS, parseForcedStep, renderStep,
} from './policy.mjs';
import { terminateGroup } from './worker.mjs';

const SELF = fileURLToPath(import.meta.url);
const SUBCOMMANDS = ['preview', 'start', 'status', 'stop'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;

export const USAGE = `Usage: autopilot [preview|start|status|stop] [options]

  preview                 observe, decide and print the posture; spawns nothing (default)
  start                   preview, plus how to execute
  start --execute         run the autopilot until the macro completes or a halt
  status [--run <id>]     the latest run (or that run) and whether it still holds its lock
  stop [--macro <id>]     stop the run that drives a macro (SIGTERM; it records an interrupted halt), or
                          clean up after one whose driver died (its peers, its unfinished step, its halt)

Options:
  --repo <dir>            repository to drive (default: the current one)
  --macro <id>            the macro to drive (default: the one active on, or referencing, the current branch)
  --models <plan>         owner-default | mixed | sonnet (start --execute asks when omitted)
  --model <m> --effort <e>  one model / effort for every step (effort: ${EFFORTS.join(', ')})
  --max-steps <n>         default ${DEFAULTS.maxSteps}
  --max-cost <usd>        default ${DEFAULTS.maxCostUsd}
  --step-budget <usd>     default ${DEFAULTS.stepBudgetUsd}
  --step-timeout <s>      default ${DEFAULTS.stepTimeoutSec} (at least 60)
  --max-time <s>          default ${DEFAULTS.maxTimeSec} (at least 60)
  --oversize-pct <p>      default ${DEFAULTS.oversizePct} (a fraction of the context window)
  --lanes <n>             run up to n subtasks at once, each in its own git worktree (a lane); 1 or absent:
                          one subtask at a time in this checkout. The owner's default with lanes is 2
                          (ADR-0067 Decision 6); a larger n spends the rate limit faster
  --next "<step>"         the first step after resolving a halt: /engineer:<verb>, /engineer:commit,
                          /orchestrator:next [<subtask>]
  --lane <subtask> --next "<step>"
                          with lanes, the first step of that subtask's lane; one pair per lane, and
                          needed when more than one subtask has an active engineer workflow
  --notify-local          one macOS notification when the run ends (driver-local, no plugin channel)
  --json                  preview and status as JSON
  --args-file <path>      read the arguments from an ADR-0059 args file

Exit: 0 completed / preview would proceed · 2 halted / preview would halt · 1 error`;

class UsageError extends Error {}

const positive = (name, raw, { integer = false, max = Infinity } = {}) => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > max || (integer && !Number.isInteger(n))) {
    throw new UsageError(`${name} must be a positive ${integer ? 'integer' : 'number'}${max < Infinity ? ` up to ${max}` : ''} (got ${JSON.stringify(raw)})`);
  }
  return n;
};

// A step needs time to start a session and run a runbook; a bound below this
// is refused rather than quietly raised.
const MIN_SECONDS = 60;
const atLeast = (name, raw, min) => {
  const n = positive(name, raw, { integer: true });
  if (n < min) throw new UsageError(`${name} must be at least ${min} seconds (got ${n})`);
  return n;
};

/** Parse the command line (after any --args-file expansion). */
export function parseCli(argv) {
  const words = expandArgsFile(argv);
  const o = {
    sub: 'preview', execute: false, repo: null, macro: null, run: null,
    models: null, model: null, effort: null,
    maxSteps: DEFAULTS.maxSteps, maxCostUsd: DEFAULTS.maxCostUsd, stepBudgetUsd: DEFAULTS.stepBudgetUsd,
    stepTimeoutSec: DEFAULTS.stepTimeoutSec, maxTimeSec: DEFAULTS.maxTimeSec, oversizePct: DEFAULTS.oversizePct,
    forced: null, forcedText: null, forcedPairs: null, lanes: 1, notifyLocal: false, json: false, help: false,
  };
  // --lane <id> --next "<step>" pairs, in order; a --next with no --lane
  // before it names no lane.
  const pairs = [];
  let pendingLane = null;
  let i = 0;
  if (words[0] !== undefined && !words[0].startsWith('-')) {
    if (!SUBCOMMANDS.includes(words[0])) throw new UsageError(`unknown subcommand ${JSON.stringify(words[0])}`);
    o.sub = words[0];
    i = 1;
  }
  for (; i < words.length; i += 1) {
    const word = words[i];
    const eq = word.startsWith('--') ? word.indexOf('=') : -1;
    const name = eq > 0 ? word.slice(0, eq) : word;
    const inline = eq > 0 ? word.slice(eq + 1) : undefined;
    const value = () => {
      if (inline !== undefined) return inline;
      const v = words[i + 1];
      if (v === undefined) throw new UsageError(`${name} needs a value`);
      i += 1;
      return v;
    };
    const flag = () => {
      if (inline !== undefined) throw new UsageError(`${name} takes no value`);
      return true;
    };
    switch (name) {
      case '--execute': o.execute = flag(); break;
      case '--repo': o.repo = value(); break;
      case '--macro': o.macro = value(); break;
      case '--run': o.run = value(); break;
      case '--models': o.models = value(); break;
      case '--model': o.model = value(); break;
      case '--effort': o.effort = value(); break;
      case '--max-steps': o.maxSteps = positive(name, value(), { integer: true }); break;
      case '--max-cost': o.maxCostUsd = positive(name, value()); break;
      case '--step-budget':
        o.stepBudgetUsd = positive(name, value());
        // ADR-0067 Decision 6, Budgets: a step reserved below the minimum is
        // never spawned, so a per-step cap below it could never run one.
        if (o.stepBudgetUsd < MIN_STEP_BUDGET_USD) throw new UsageError(`${name} must be at least ${MIN_STEP_BUDGET_USD} (got ${o.stepBudgetUsd})`);
        break;
      case '--step-timeout': o.stepTimeoutSec = atLeast(name, value(), MIN_SECONDS); break;
      case '--max-time': o.maxTimeSec = atLeast(name, value(), MIN_SECONDS); break;
      case '--oversize-pct': o.oversizePct = positive(name, value(), { max: 1 }); break;
      case '--lanes': o.lanes = positive(name, value(), { integer: true }); break;
      case '--lane': {
        const id = value();
        if (pendingLane !== null) throw new UsageError(`--lane ${pendingLane} needs a --next after it`);
        if (!isSafeSubtaskId(id)) throw new UsageError(`--lane ${JSON.stringify(id)} is not a subtask id`);
        pendingLane = id;
        break;
      }
      case '--next': pairs.push({ lane: pendingLane, text: value() }); pendingLane = null; break;
      case '--notify-local': o.notifyLocal = flag(); break;
      case '--json': o.json = flag(); break;
      case '--help': case '-h': o.help = true; break;
      default: throw new UsageError(`unknown option ${JSON.stringify(word)}`);
    }
  }
  if (o.execute && o.sub !== 'start') throw new UsageError('--execute applies only to start');
  if (o.run !== null && o.sub !== 'status') throw new UsageError('--run applies only to status');
  if (o.models !== null && !MODEL_PLANS.includes(o.models)) throw new UsageError(`--models must be one of ${MODEL_PLANS.join(', ')}`);
  if (o.model !== null && !MODEL_RE.test(o.model)) throw new UsageError(`--model ${JSON.stringify(o.model)} is not a model name`);
  if (o.effort !== null && !EFFORTS.includes(o.effort)) throw new UsageError(`--effort must be one of ${EFFORTS.join(', ')}`);
  if (o.macro !== null && !/^macro-[a-z][a-z0-9-]*-\d{8}T\d{6}Z-[0-9a-f]{6}$/.test(o.macro)) {
    throw new UsageError(`--macro ${JSON.stringify(o.macro)} is not a macro workflow id`);
  }
  if (pendingLane !== null) throw new UsageError(`--lane ${pendingLane} needs a --next after it`);
  if (pairs.length > 0) {
    if (o.lanes < 2) {
      if (pairs.some((p) => p.lane !== null)) throw new UsageError('--lane applies only with --lanes 2 or more');
      if (pairs.length > 1) throw new UsageError('--next is given once without lanes');
    }
    try {
      o.forcedPairs = pairs.map((p) => ({ lane: p.lane, step: parseForcedStep(p.text) }));
    } catch (e) {
      throw new UsageError(e.message);
    }
    o.forcedText = pairs.map((p) => (p.lane ? `--lane ${p.lane} --next ${p.text}` : p.text)).join(' ');
    if (o.lanes < 2) o.forced = o.forcedPairs[0].step;
  }
  return o;
}

// D9: the driver hosts Claude Code workers only.
export function hostRefusal(env = process.env, self = SELF, home = homedir()) {
  if (env.AGENTIC_HOST && env.AGENTIC_HOST !== 'claude') {
    return `AGENTIC_HOST=${env.AGENTIC_HOST}: the autopilot is a Claude Code adapter (ADR-0063 D9); on Codex the steps stay manual`;
  }
  const codexHome = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(home, '.codex');
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const rel = relative(real(codexHome), real(self));
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
    return `this copy runs from a Codex install (${self}); the autopilot is a Claude Code adapter (ADR-0063 D9)`;
  }
  return null;
}

function repoRootOf(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) return null;
  const top = r.stdout.trim();
  try { return realpathSync(top); } catch { return top; }
}

function summarizeView(view) {
  const m = view.macro;
  const subtasks = Array.isArray(m?.fm?.plan?.subtasks) ? m.fm.plan.subtasks : [];
  return {
    branch: view.git.branch || null,
    head: view.git.head,
    clean: view.git.clean,
    entry_brief: view.brief ? { disposition: view.brief.disposition, leading: view.brief.leading?.command ?? null } : { error: view.briefError },
    macro: m ? { id: m.id, path: m.relPath ?? m.path, archived: m.archived } : (view.macroLookupError ? { error: view.macroLookupError } : null),
    approval: view.ready?.approval ?? null,
    subtasks: subtasks.map((s) => ({ id: s?.id, status: s?.status, branch: s?.branch })),
    children: Object.fromEntries(Object.entries(view.children).map(([id, c]) => [id, {
      location: c.location, workflow: c.workflow_id ?? null, phase: c.current_phase ?? null,
      next_step: c.next_step, awaiting_owner: c.awaiting_owner?.gate ?? null,
    }])),
    landing: view.landing,
    fingerprint: fingerprint(view),
  };
}

function launcherInstall(roots) {
  const template = join(roots.orchestrator, 'adapters', 'claude', 'autopilot', 'launcher.template.mjs');
  if (!existsSync(template)) return null;
  return `mkdir -p ~/.agentic-plugins/bin && install -m 755 '${template}' ~/.agentic-plugins/bin/agentic-autopilot`;
}

// The text a preview shows for a step: a done-no-commit's reason names the
// run, which a preview has none of.
const previewCommand = (step, macroId) => (step.kind === 'done-no-commit'
  ? `/orchestrator:done ${step.subtaskId} --no-commit --workflow=${macroId} <reason naming this run>`
  : renderStep(step, { macroId, runId: null }));

/**
 * ADR-0067 Decision 6 — what a run with lanes would do first, read-only: the
 * start conditions lanes add, the reconciliation plan from the facts as they
 * are (no fetch, no write: a prepared lane is judged against the last fetched
 * baseline), and the first wave decideLanes gives, up to N steps, each with
 * the lane it runs in.
 */
export function previewLanes(o, repoRoot, view, pre, env = process.env) {
  const n = o.lanes;
  const macroId = view.macro?.id ?? null;
  const problems = macroId
    ? lanesRequirements({ checkout: repoRoot, stateRoot: pre.stateRoot, macroPath: view.macro.path, view })
    : [`a run with lanes needs its macro${view.macroLookupError ? ` (${view.macroLookupError})` : ''}: name it with --macro <id>`];
  const result = { n, problems, plan: null, first_wave: [], halt: null, idle: null };
  const home = laneHome(repoRoot);
  if (home.problem || !macroId || view.macro.archived) return result;
  let facts;
  try {
    facts = gatherLaneFacts({ home, checkout: repoRoot, macroId, view, baseline: view.macro.fm?.git_baseline?.branch ?? null, env });
  } catch (e) {
    result.problems = [...problems, e.message];
    return result;
  }
  const plan = planReconciliation(facts);
  result.plan = {
    lanes: plan.lanes.map((e) => ({ subtask_id: e.subtaskId, path: e.lane.path, row: e.row, action: e.action })),
    create: plan.subtasks.filter((x) => x.action !== 'halt').map((x) => ({ subtask_id: x.subtaskId, row: x.row, action: x.action, path: lanePath(home, macroId, x.subtaskId) })),
    halts: plan.halts.map((h) => ({ row: h.row, reason: h.reason, detail: h.detail, subtask_id: h.subtaskId ?? null })),
    others: plan.others.map((x) => x.report),
  };
  const held = new Map(plan.lanes.filter((e) => e.action === 'adopt' || e.action === 'prepared')
    .map((e) => [e.subtaskId, { path: e.lane.path, branch: e.lane.branch, subtaskId: e.subtaskId, state: e.action }]));
  let forced = new Map();
  if (plan.halts.length > 0) result.halt = { reason: plan.halts[0].reason, detail: plan.halts[0].detail };
  if (o.forcedPairs?.length) {
    const f = forcedForLanes(o.forcedPairs, view);
    if (f.halt) result.halt ??= f.halt;
    else forced = f.forced;
  }
  const d = decideLanes(view, { lanes: held, forced });
  if (d.outcome === 'halt') {
    result.halt ??= d;
    return result;
  }
  if (d.outcome === 'completed') return result;
  // As the run admits them: forced steps first; a lane's halt then drains the
  // run, so nothing else starts.
  const steps = d.laneHalts.length > 0
    ? d.laneSteps.filter((x) => x.forced)
    : [...d.laneSteps.filter((x) => x.forced), ...(d.driverStep ? [d.driverStep] : []),
      ...d.laneSteps.filter((x) => !x.forced && !x.newLane), ...d.laneSteps.filter((x) => !x.forced && x.newLane)];
  for (const st of steps.slice(0, n)) {
    const id = st.subtaskId ?? null;
    result.first_wave.push({
      kind: st.kind, subtask_id: id, command: previewCommand(st, macroId), forced: st.forced === true,
      checkout: st.lane ? (held.get(id)?.path ?? lanePath(home, macroId, id)) : repoRoot,
      creates_lane: st.lane === true && !held.has(id),
      // Before the first rate-limit event the throttle is unknown: a new lane
      // waits while any worker runs, a driver step's included (Throttle, rule 2).
      waits_for_rate_limit_event: st.newLane === true && result.first_wave.length > 0,
    });
  }
  if (d.laneHalts.length > 0) result.halt ??= d.laneHalts[0];
  if (result.first_wave.length === 0) result.idle = d.idle;
  return result;
}

function printLanesPreview(lp, out) {
  out(`lanes (--lanes ${lp.n}):`);
  if (lp.n > 2) out(`  ⚠ ${lp.n} lanes: each is a worker drawing on the same rate limit at once; the owner's default is 2 (the throttle still gates each new lane)`);
  if (lp.problems.length) {
    out('  ✗ lanes cannot run:');
    for (const x of lp.problems) out(`    - ${x}`);
  }
  if (lp.plan) {
    out('  reconciliation (read-only; origin is not fetched):');
    for (const l of lp.plan.lanes) out(`    lane ${l.subtask_id} · ${l.path} · row ${l.row ?? '-'} · ${l.action}`);
    for (const l of lp.plan.create) out(`    lane ${l.subtask_id} · ${l.path} · ${l.action}${l.row ? ` (row ${l.row})` : ''} · created when its first step is admitted`);
    for (const x of lp.plan.others) out(`    ${x}`);
    for (const h of lp.plan.halts) out(`    ✗ ${h.subtask_id ? `${h.subtask_id}: ` : ''}${h.detail}`);
  }
  if (lp.first_wave.length) {
    out('  first wave:');
    for (const w of lp.first_wave) {
      out(`    ${w.subtask_id ? `${w.subtask_id}: ` : ''}${w.command}${w.forced ? ' (forced)' : ''} · in ${w.checkout}${w.creates_lane ? ' (a new lane)' : ''}${w.waits_for_rate_limit_event ? ' · starts once the first worker\'s rate-limit event opens the throttle' : ''}`);
    }
  }
  if (lp.halt) out(`  would halt: ${lp.halt.reason} — ${lp.halt.detail}`);
  else if (lp.idle) out(`  would halt: ${lp.idle.reason} — ${lp.idle.detail}`);
}

async function previewCmd(o, repoRoot, env, out) {
  const pre = await preflight({ repoRoot, env, lanes: o.lanes });
  const p = posture(o);
  let view = null;
  let decision = null;
  let lanesPreview = null;
  if (pre.roots && pre.roots.problems.length === 0) {
    view = observe({ repoRoot, roots: pre.roots.roots, macroId: o.macro, fetch: false, env });
    if (o.lanes >= 2) lanesPreview = previewLanes(o, repoRoot, view, pre, env);
    else decision = decide(view, { runId: 'autopilot-00000000T000000Z-000000', macroId: view.macro?.id ?? null, forced: o.forced });
  }
  let command = null;
  if (decision?.outcome === 'step') command = previewCommand(decision.step, view.macro.id);
  const report = {
    dry_run: true,
    repo: repoRoot,
    start_conditions: { ok: pre.problems.length === 0, problems: pre.problems, warnings: pre.warnings, claude: pre.claude ?? null },
    plugins: pre.roots ? Object.fromEntries(Object.keys(pre.roots.roots).map((k) => [k, { version: pre.roots.versions[k], root: pre.roots.roots[k], source: pre.roots.sources[k] }])) : null,
    view: view ? summarizeView(view) : null,
    decision: decision ? { ...decision, command } : null,
    lanes: lanesPreview,
    posture: p,
    launcher_install: pre.roots?.roots?.orchestrator ? launcherInstall(pre.roots.roots) : null,
  };
  if (o.json) {
    out(JSON.stringify(report, null, 2));
  } else {
    out('autopilot preview — a dry run: nothing is spawned, and origin is not fetched (landing is judged against the last fetch)');
    out(`  repo ${repoRoot}${view ? ` · branch ${view.git.branch || '(detached)'} · ${view.git.clean ? 'clean' : 'dirty'}` : ''}`);
    if (report.plugins) out(`  plugins: ${Object.entries(report.plugins).map(([k, v]) => `${k} ${v.version} (${v.source})`).join(', ')}`);
    if (pre.claude) out(`  claude: ${pre.claude}`);
    if (pre.problems.length) {
      out('  ✗ start conditions:');
      for (const x of pre.problems) out(`    - ${x}`);
    } else {
      out('  ✓ start conditions hold');
    }
    if (view) {
      const s = summarizeView(view);
      if (s.macro?.id) out(`  macro ${s.macro.id}: ${s.subtasks.map((x) => `${x.id}=${x.status}`).join(', ')} · approval ${s.approval ? `${s.approval.status}${s.approval.hash_ok === false ? ' (hash changed)' : ''}` : 'unknown'}`);
      out(`  entry-brief: ${s.entry_brief.disposition ?? `error: ${s.entry_brief.error}`}${s.entry_brief.leading ? ` → ${s.entry_brief.leading}` : ''}`);
    }
    if (decision?.outcome === 'step') out(`next step: ${command}${decision.step.subtaskId ? ` (subtask ${decision.step.subtaskId})` : ''}`);
    else if (decision?.outcome === 'completed') out(`next: nothing — ${decision.detail}`);
    else if (decision) {
      out(`would halt: ${decision.reason} — ${decision.detail}`);
      if (decision.pointer) out(`  pointer: ${decision.pointer}`);
      for (const w of decision.waiting ?? []) {
        out(`  · ${w.subtaskId} on ${w.branch} (${w.reason})`);
        for (const c of w.commands) out(`      ${c}`);
      }
    }
    if (lanesPreview) printLanesPreview(lanesPreview, out);
    out(`posture: --permission-mode manual · --permission-prompts none · model plan ${p.model_plan ?? '(asked at start)'}${p.model_override.model || p.model_override.effort ? ` · override ${p.model_override.model ?? '-'}/${p.model_override.effort ?? '-'}` : ''}`);
    out(`  budgets: ${o.maxSteps} steps · $${o.maxCostUsd} per run · $${o.stepBudgetUsd} and ${o.stepTimeoutSec} s per step · ${o.maxTimeSec} s per run · oversize ${o.oversizePct}${o.lanes >= 2 ? ` · each step's budget reserved before it spawns, up to ${o.lanes} at once` : ''}`);
    out(`  allowed: ${p.allowed_tools.join(' ')}`);
    out(`  denied: ${p.denied_tools.join(' ')} (+ ${p.denied_on_non_commit_steps.join(' ')} except on /engineer:commit)`);
    for (const w of pre.warnings) out(`⚠ ${w}`);
    out(o.lanes >= 2
      ? '⚠ Run lanes from a checkout no one works in: a done or finalize runs there, and work in it halts the run (ADR-0067 Decision 6).'
      : '⚠ A dedicated worktree is recommended (the runtime:worktree planner): the run switches branches in this checkout.');
    if (report.launcher_install) out(`launcher (optional, for runs longer than a session's 2-hour background limit): ${report.launcher_install}`);
    const lanesArg = o.lanes >= 2 ? `${view?.macro?.id ? ` --macro ${view.macro.id}` : ''} --lanes ${o.lanes}` : '';
    out(`to start: /orchestrator:autopilot start --execute${lanesArg}   (terminal: agentic-autopilot start --execute${lanesArg} --repo ${repoRoot})`);
  }
  if (pre.problems.length || lanesPreview?.problems.length) return 1;
  if (lanesPreview) return lanesPreview.halt || lanesPreview.idle ? 2 : 0;
  return decision?.outcome === 'halt' ? 2 : 0;
}

async function askModelPlan(input, output) {
  const rl = readline.createInterface({ input, output });
  try {
    output.write([
      'Model plan for this run\'s workers (owner decision D5):',
      '  1) owner-default — every step on your Claude Code default model and effort',
      '  2) mixed — decide/critique/investigate/frame on your default; compose/refine on sonnet/medium;',
      '             commit/done/finalize on sonnet/low',
      '  3) sonnet — every step on sonnet/medium',
      '',
    ].join('\n'));
    for (let tries = 0; tries < 3; tries += 1) {
      const a = (await rl.question('Choose 1-3: ')).trim();
      const plan = { 1: 'owner-default', 2: 'mixed', 3: 'sonnet' }[a] ?? (MODEL_PLANS.includes(a) ? a : null);
      if (plan) return plan;
    }
    return null;
  } finally {
    rl.close();
  }
}

async function startCmd(o, repoRoot, env, out, err, io) {
  if (!o.execute) {
    const code = await previewCmd(o, repoRoot, env, out);
    out('This was a preview. Add --execute to run.');
    return code;
  }
  if (o.models === null) {
    if (o.model !== null || o.effort !== null) {
      o.models = 'owner-default';
    } else if (io.stdin.isTTY) {
      o.models = await askModelPlan(io.stdin, io.stderr);
      if (!o.models) { err('✗ No model plan chosen.'); return 1; }
    } else {
      err(`✗ start --execute needs a model plan: --models ${MODEL_PLANS.join('|')} (or --model/--effort). /orchestrator:autopilot asks for it before it launches.`);
      return 1;
    }
  }
  if (o.lanes > 2) out(`⚠ --lanes ${o.lanes}: each lane is a worker drawing on the same rate limit at once; the owner's default is 2 (the throttle still gates each new lane)`);
  return startRun({ repoRoot, options: o, env, out, err });
}

// ADR-0067 Decision 4, item 5 — the interactive sessions admitted in the locks
// this checkout's runs take (the macro locks under the main worktree and this
// checkout's worktree lock), one row per admission, so the owner sees the id a
// refusal names and can release a session they know is gone.
function sessionAdmissions(repoRoot) {
  const seen = new Map();
  for (const l of listLocks(mainWorktreeRoot(repoRoot), repoRoot)) {
    if (!l.session) continue;
    const id = l.holder?.admission_id ?? l.entry;
    if (!seen.has(id)) seen.set(id, { holder: l.holder, locks: [] });
    seen.get(id).locks.push(l.lock);
  }
  return [...seen.values()];
}

function printAdmissions(admissions, out) {
  if (admissions.length === 0) return;
  out(`session admissions (${admissions.length}):`);
  for (const a of admissions) out(`  ${a.holder ? describeAdmission(a.holder) : `an unreadable admission entry in ${a.locks.join(', ')}`}`);
}

async function statusCmd(o, repoRoot, out, err) {
  const runs = listRuns(repoRoot);
  const admissions = sessionAdmissions(repoRoot);
  if (runs.length === 0) {
    if (o.json) out(JSON.stringify({ runs: [], admissions }));
    else {
      out(`no autopilot runs in ${repoRoot}`);
      printAdmissions(admissions, out);
    }
    return 0;
  }
  const id = o.run ?? runs.at(-1);
  if (!runs.includes(id)) { err(`✗ no run ${id} in ${repoRoot}`); return 1; }
  const r = readRun(repoRoot, id);
  if (!r) { err(`✗ run ${id} has no readable run.json`); return 1; }
  const locks = listLocks(mainWorktreeRoot(repoRoot), repoRoot).filter((l) => l.holder?.run_id === id);
  let live = false;
  const liveEntries = [];
  for (const l of locks) if (await holderAlive(l.holder)) { live = true; liveEntries.push(l.holder); }
  // Every worker group the run's live entries record, so a dead driver's
  // surviving groups are shown, and `stop` can be told to empty them.
  const groups = workerGroups(liveEntries).map((w) => ({ pid: w.pid, task: w.task ?? null, lane: w.lane ?? null, cwd: w.cwd ?? null, session_id: w.session_id ?? null }));
  const driverAlive = liveEntries.length > 0 && await provablySame(liveEntries[0].pid, liveEntries[0].fingerprint);
  // A run that is not live but keeps its open-run record has not been
  // cleaned up after yet (ADR-0067 Decision 6, Locks).
  let cleanupPending = false;
  try { cleanupPending = !live && readOpenRun(mainWorktreeRoot(repoRoot), id) !== null; } catch { /* no record */ }
  // An error, or a group that outlived SIGKILL, leaves the record too.
  const pendingText = cleanupPending ? '; its cleanup is pending: /orchestrator:autopilot stop, or the next run of its macro, cleans up after it' : '';
  const liveness = r.run.status === 'running'
    ? (live
      ? (driverAlive || groups.length === 0 ? 'running' : `its driver is gone, but ${groups.length} worker group${groups.length === 1 ? '' : 's'} still run${groups.length === 1 ? 's' : ''}: /orchestrator:autopilot stop empties them`)
      : `gone (the driver exited without recording an end: it crashed or was killed)${pendingText}`)
    : `${r.run.status}${pendingText}`;
  if (o.json) {
    out(JSON.stringify({ run: r.run, steps: r.steps, landing: r.landing, lanes: r.lanes, halt: r.halt, live, worker_groups: groups, cleanup_pending: cleanupPending, admissions }, null, 2));
    return 0;
  }
  out(`${r.run.run_id} · ${liveness} · macro ${r.run.macro_id ?? '-'} · steps ${r.run.steps} · $${Number(r.run.cost_usd ?? 0).toFixed(2)}`);
  out(`  started ${r.run.started_at}${r.run.ended_at ? ` · ended ${r.run.ended_at}` : ''} · ledger ${r.dir}`);
  for (const g of groups) out(`  worker group ${groupLabel(g)}${g.session_id ? ` · session ${g.session_id}` : ''}`);
  const c = r.run.dead_run_cleanup;
  if (c) {
    out(`  cleaned up after its dead driver by ${c.by ?? '?'} at ${c.at}${c.complete ? '' : ' (not finished: its record is kept)'}: ` +
      `cancelled ${c.cancelled?.length ? c.cancelled.join(', ') : 'no peer run'} · steps counted as spent ${c.settled?.length ? c.settled.map((s) => `[${s.seq}]`).join(' ') : 'none'}` +
      `${c.reported?.length ? ` · reported, not cancelled (they name no run): ${c.reported.join(', ')}` : ''}${c.unresolved?.length ? ` · not cancelled: ${c.unresolved.join(', ')}` : ''}`);
  }
  for (const s of r.steps) {
    const pct = typeof s.peak_pct === 'number' ? ` ${(s.peak_pct * 100).toFixed(1)}%` : '';
    out(`  [${s.seq}] ${s.lane ? `lane ${s.lane}: ` : ''}${s.command} → ${s.outcome ?? (s.event === 'started' ? 'running or interrupted' : '?')}${typeof s.cost_usd === 'number' ? ` · $${s.cost_usd.toFixed(2)}` : ''}${pct} · session ${s.session_id}`);
  }
  for (const l of r.landing) {
    out(`  ◆ landing-ready after [${l.after_seq}]: ${l.subtask_id} on ${l.branch} at ${l.commit ?? 'no commit'} (${l.reason})`);
  }
  if (r.halt) {
    out(`  halt: ${r.halt.reason} — ${r.halt.detail}`);
    if (r.halt.pointer) out(`    pointer: ${r.halt.pointer}`);
    for (const line of r.halt.resume ?? []) out(`    ${line}`);
  }
  // A run with lanes: one line per lane it met (ADR-0067 Decision 6).
  for (const l of r.run.lanes?.lanes ?? []) {
    out(`  lane ${l.subtask_id} · ${l.state ?? '?'}${l.path ? ` · ${l.path}` : ''}${l.last_step ? ` · last [${l.last_step.seq}] ${l.last_step.outcome}` : ''}${l.halt ? ` · halted: ${l.halt.reason}` : ''}`);
  }
  if (r.run.error) out(`  error: ${r.run.error}`);
  printAdmissions(admissions, out);
  return 0;
}

// A run's worker groups, once each, from every entry it holds: a serial run's
// one worker on its own entry, and a run with lanes' one entry per group
// (ADR-0067 Decision 6, Locks).
function workerGroups(entries) {
  const groups = new Map();
  for (const h of entries) if (Number.isInteger(h?.worker?.pid) && !groups.has(h.worker.pid)) groups.set(h.worker.pid, h.worker);
  return [...groups.values()];
}

// A worker's group, or an off-loop task's (offloop.mjs: `task` names it).
const groupLabel = (w) => {
  const where = [w.task ? `task ${w.task}` : null, w.lane ? `lane ${w.lane}${w.cwd ? `, ${w.cwd}` : ''}` : null].filter(Boolean);
  return `${w.pid}${where.length ? ` (${where.join(', ')})` : ''}`;
};

async function stopCmd(o, repoRoot, out, err, { wait = 30_000, env = process.env } = {}) {
  const mainRoot = mainWorktreeRoot(repoRoot);
  // ADR-0067 Decision 6, Locks: once no worker group of a dead driver runs,
  // stop cleans up after it from its open-run record (dead-runs.mjs): it
  // cancels the peers its steps started, counts its unfinished steps as
  // spent, records its halt, and only then reports it stopped. A record the
  // cleanup has to keep fails the stop, and so does a run part of which still
  // runs (its cleanup says `live`): the run stop was asked to stop
  // (`target`), or, when stop found none in the locks, any run in its scope
  // (a lock it could not read hides a live run from the listing, never from
  // its record).
  const cleanUp = async (macroId, target = null) => {
    const pinned = await resolveRoots({ env }).catch(() => null);
    const results = await cleanupDeadRuns({
      mainRoot, macroId: macroId ?? null, engineerRoot: pinned?.roots?.engineer ?? null, by: { run_id: null, label: 'stop' },
      env, out: (s) => (/^\s*✗/.test(s) ? err(s) : out(s)),
    });
    const running = results.filter((r) => r.outcome === 'live' && (target === null || r.run_id === target));
    for (const r of running) err(`✗ run ${r.run_id} is not stopped: ${r.detail}`);
    // A record kept for the owner, or one another process is still cleaning
    // up after, is not a run stop can report stopped.
    const unfinished = results.some((r) => r.outcome === 'kept' || r.outcome === 'busy');
    return { results, code: unfinished || running.length > 0 ? 1 : 0 };
  };
  // A run's live entries in every lock here, read now: a run holds one entry
  // in each of its locks and, with lanes, one more per worker group in
  // flight, and a dead driver with any group alive still holds the lock.
  const liveEntriesOf = async (runId) => {
    const live = [];
    for (const l of listLocks(mainRoot, repoRoot)) {
      if (l.holder?.run_id === runId && await holderAlive(l.holder)) live.push(l.holder);
    }
    return live;
  };
  // A driver that died leaves its workers, process-group leaders the run
  // started; with no driver to finish the job, every group the run recorded
  // is emptied here — SIGTERM, then SIGKILL — before anything is reported,
  // and then stop cleans up after the run.
  const stopDeadDriver = async (holder, entries) => {
    const groups = workerGroups(entries);
    const provable = [];
    const unproven = [];
    for (const w of groups) (await provablySame(w.pid, w.fingerprint) ? provable : unproven).push(w);
    if (provable.length === 0) {
      err(`✗ run ${holder.run_id} looks alive, but neither its driver (pid ${holder.pid}) nor its worker can be proven to be the process the lock recorded; nothing was signalled.`);
      return 1;
    }
    out(`run ${holder.run_id}'s driver is gone; stopping its worker group${provable.length === 1 ? '' : 's'} (pid ${provable.map(groupLabel).join(', ')})`);
    const lingering = [];
    for (const w of provable) {
      const outcome = await terminateGroup(w.pid);
      if (outcome === 'lingering') lingering.push(w);
      else out(`  the worker ${groupLabel(w)}: its process group is empty (${outcome})`);
    }
    if (lingering.length > 0) {
      for (const w of lingering) err(`✗ a process in the worker's group (${w.pid}) is still there after SIGKILL; check it with ps -g ${w.pid}`);
      return 1;
    }
    if (unproven.length > 0) {
      err(`✗ the run's other worker group${unproven.length === 1 ? '' : 's'} (pid ${unproven.map(groupLabel).join(', ')}) cannot be proven to be the process the lock recorded; ${unproven.length === 1 ? 'it was' : 'they were'} not signalled.`);
      return 1;
    }
    out(`the worker's process group is empty${provable.length === 1 ? '' : ', for each of its groups'}; cleaning up after its dead driver`);
    const { results, code } = await cleanUp(holder.macro_id ?? o.macro, holder.run_id);
    if (!results.some((r) => r.run_id === holder.run_id)) {
      out(`no open-run record names run ${holder.run_id} (a driver from before them): no halt was recorded, and its peers were not looked for — status shows the run as gone`);
    }
    // Record or none, the run is stopped only once none of its entries lives:
    // a driver whose fingerprint does not read is alive to the lock, though no
    // signal could be proven for it.
    if (code === 0 && (await liveEntriesOf(holder.run_id)).length > 0) {
      err(`✗ run ${holder.run_id} is not stopped: an entry of it still lives (its driver, pid ${holder.pid}, may run on, but cannot be proven the process the lock recorded); nothing more was signalled`);
      return 1;
    }
    return code;
  };
  // The runs that hold a lock here: every macro lock under the main worktree
  // and this worktree's lock. Each live entry is kept, grouped by run id.
  const runs = new Map();
  for (const l of listLocks(mainRoot, repoRoot)) {
    if (!l.holder?.run_id || (o.macro && l.holder.macro_id !== o.macro)) continue;
    if (!(await holderAlive(l.holder))) continue;
    if (!runs.has(l.holder.run_id)) runs.set(l.holder.run_id, []);
    runs.get(l.holder.run_id).push(l.holder);
  }
  if (runs.size === 0) {
    out('no autopilot run is active');
    return (await cleanUp(o.macro)).code;
  }
  if (runs.size > 1) {
    err(`✗ ${runs.size} runs are active (${[...runs.values()].map(([h]) => `${h.run_id} on ${h.macro_id ?? '?'}`).join(', ')}); name one with --macro <id>`);
    return 1;
  }
  const [entries] = runs.values();
  const holder = entries[0];
  // A signal needs proof that the pid is still the process the lock names
  // (liveness errs toward "held"; this must not). The driver is stopped when
  // it is provably there: it empties its worker groups, cancels the steps'
  // peers and records the halt itself.
  if (!(await provablySame(holder.pid, holder.fingerprint))) return stopDeadDriver(holder, entries);
  process.kill(holder.pid, 'SIGTERM');
  out(`sent SIGTERM to run ${holder.run_id} (pid ${holder.pid}) driving ${holder.macro_id ?? '(no macro)'}`);
  const deadline = Date.now() + wait;
  while (Date.now() < deadline) {
    // Read again each time: a worker group the run registered after stop
    // listed its entries counts as much as one listed before.
    const live = await liveEntriesOf(holder.run_id);
    if (live.length === 0) {
      // A driver that died instead of recording its end (a crash on the way
      // out) leaves its open-run record: clean up after it now.
      let left = null;
      try { left = readOpenRun(mainRoot, holder.run_id); } catch { /* none */ }
      if (left === null) { out('it stopped; its halt is recorded as interrupted'); return 0; }
      out('its driver exited without recording its end; cleaning up after it');
      return (await cleanUp(holder.macro_id ?? o.macro, holder.run_id)).code;
    }
    // Its driver gone and a group of it left: no driver will empty that group.
    // An entry read while the driver still ran may be only its own, ended
    // since: with no group among them, the next read decides.
    if (!(await holderAlive({ pid: holder.pid, fingerprint: holder.fingerprint, worker: null }))) {
      const n = workerGroups(live).length;
      if (n > 0) {
        out(`its driver exited, but ${n === 1 ? 'a worker group' : `${n} worker groups`} of it still run${n === 1 ? 's' : ''}`);
        return stopDeadDriver(holder, live);
      }
    }
    await new Promise((r) => { setTimeout(r, 200); });
  }
  err(`✗ it is still running; it stops once every worker and task group of it is empty (SIGKILL follows SIGTERM after 5 s; a lane's creation or removal under way gets ${INTERRUPT_BOUND_MS / 1000} s to finish)`);
  return 1;
}

export async function main(argv = process.argv.slice(2), { env = process.env, io = process, out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`) } = {}) {
  let o;
  try {
    o = parseCli(argv);
  } catch (e) {
    err(`autopilot: ${e.message}`);
    err('Run with --help for usage.');
    return 1;
  }
  if (o.help) { out(USAGE); return 0; }
  const refusal = hostRefusal(env);
  if (refusal) { err(`✗ ${refusal}`); return 1; }
  // A worker of a run never starts another one (D1: owner-invoked only).
  if (o.sub === 'start' && o.execute && isAutopilotRun(env)) {
    err(`✗ AGENTIC_AUTOPILOT=${env.AGENTIC_AUTOPILOT}: this is a step of an autopilot run, which never starts another run`);
    return 1;
  }
  const repoRoot = repoRootOf(o.repo ? resolve(o.repo) : process.cwd());
  if (!repoRoot) { err(`✗ ${o.repo ?? process.cwd()} is not inside a git repository`); return 1; }
  switch (o.sub) {
    case 'preview': return previewCmd(o, repoRoot, env, out);
    case 'start': return startCmd(o, repoRoot, env, out, err, io);
    case 'status': return statusCmd(o, repoRoot, out, err);
    case 'stop': return stopCmd(o, repoRoot, out, err, { env });
    default: return 1;
  }
}

// Run only as the entry script, compared canonically (an install reached
// through a symlink, or a path that needs URL escaping, still runs).
function invokedAsCli() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(SELF); } catch { return false; }
}

if (invokedAsCli()) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`autopilot: ${e?.stack ?? e}\n`);
    process.exitCode = 1;
  });
}

