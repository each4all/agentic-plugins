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
//   stop                SIGTERM the run that holds a macro's lock
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
import { isAutopilotRun } from '../../../scripts/state.mjs';
import { DEFAULTS, posture, preflight, startRun } from './driver.mjs';
import { holderAlive, listLocks, listRuns, mainWorktreeRoot, provablySame, readRun } from './ledger.mjs';
import { observe } from './observe.mjs';
import { decide, fingerprint, MODEL_PLANS, parseForcedStep, renderStep } from './policy.mjs';
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
  stop [--macro <id>]     stop the run that drives a macro (SIGTERM; it records an interrupted halt)

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
  --next "<step>"         the first step after resolving a halt: /engineer:<verb>, /engineer:commit,
                          /orchestrator:next [<subtask>]
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
    forced: null, forcedText: null, notifyLocal: false, json: false, help: false,
  };
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
      case '--step-budget': o.stepBudgetUsd = positive(name, value()); break;
      case '--step-timeout': o.stepTimeoutSec = atLeast(name, value(), MIN_SECONDS); break;
      case '--max-time': o.maxTimeSec = atLeast(name, value(), MIN_SECONDS); break;
      case '--oversize-pct': o.oversizePct = positive(name, value(), { max: 1 }); break;
      case '--next': o.forcedText = value(); break;
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
  if (o.forcedText !== null) {
    try { o.forced = parseForcedStep(o.forcedText); } catch (e) { throw new UsageError(e.message); }
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

async function previewCmd(o, repoRoot, env, out) {
  const pre = await preflight({ repoRoot, env });
  const p = posture(o);
  let view = null;
  let decision = null;
  if (pre.roots && pre.roots.problems.length === 0) {
    view = observe({ repoRoot, roots: pre.roots.roots, macroId: o.macro, fetch: false, env });
    decision = decide(view, { runId: 'autopilot-00000000T000000Z-000000', macroId: view.macro?.id ?? null, forced: o.forced });
  }
  let command = null;
  if (decision?.outcome === 'step') {
    command = decision.step.kind === 'done-no-commit'
      ? `/orchestrator:done ${decision.step.subtaskId} --no-commit --workflow=${view.macro.id} <reason naming this run>`
      : renderStep(decision.step, { macroId: view.macro.id, runId: null });
  }
  const report = {
    dry_run: true,
    repo: repoRoot,
    start_conditions: { ok: pre.problems.length === 0, problems: pre.problems, warnings: pre.warnings, claude: pre.claude ?? null },
    plugins: pre.roots ? Object.fromEntries(Object.keys(pre.roots.roots).map((k) => [k, { version: pre.roots.versions[k], root: pre.roots.roots[k], source: pre.roots.sources[k] }])) : null,
    view: view ? summarizeView(view) : null,
    decision: decision ? { ...decision, command } : null,
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
    out(`posture: --permission-mode manual · --permission-prompts none · model plan ${p.model_plan ?? '(asked at start)'}${p.model_override.model || p.model_override.effort ? ` · override ${p.model_override.model ?? '-'}/${p.model_override.effort ?? '-'}` : ''}`);
    out(`  budgets: ${o.maxSteps} steps · $${o.maxCostUsd} per run · $${o.stepBudgetUsd} and ${o.stepTimeoutSec} s per step · ${o.maxTimeSec} s per run · oversize ${o.oversizePct}`);
    out(`  allowed: ${p.allowed_tools.join(' ')}`);
    out(`  denied: ${p.denied_tools.join(' ')} (+ ${p.denied_on_non_commit_steps.join(' ')} except on /engineer:commit)`);
    for (const w of pre.warnings) out(`⚠ ${w}`);
    out('⚠ A dedicated worktree is recommended (the runtime:worktree planner): the run switches branches in this checkout.');
    if (report.launcher_install) out(`launcher (optional, for runs longer than a session's 2-hour background limit): ${report.launcher_install}`);
    out(`to start: /orchestrator:autopilot start --execute   (terminal: agentic-autopilot start --execute --repo ${repoRoot})`);
  }
  if (pre.problems.length) return 1;
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
  return startRun({ repoRoot, options: o, env, out, err });
}

async function statusCmd(o, repoRoot, out, err) {
  const runs = listRuns(repoRoot);
  if (runs.length === 0) {
    if (o.json) out(JSON.stringify({ runs: [] }));
    else out(`no autopilot runs in ${repoRoot}`);
    return 0;
  }
  const id = o.run ?? runs.at(-1);
  if (!runs.includes(id)) { err(`✗ no run ${id} in ${repoRoot}`); return 1; }
  const r = readRun(repoRoot, id);
  if (!r) { err(`✗ run ${id} has no readable run.json`); return 1; }
  const locks = listLocks(mainWorktreeRoot(repoRoot), repoRoot).filter((l) => l.holder?.run_id === id);
  let live = false;
  for (const l of locks) if (await holderAlive(l.holder)) live = true;
  const liveness = r.run.status === 'running'
    ? (live ? 'running' : 'gone (the driver exited without recording an end: it crashed or was killed)')
    : r.run.status;
  if (o.json) {
    out(JSON.stringify({ run: r.run, steps: r.steps, halt: r.halt, live }, null, 2));
    return 0;
  }
  out(`${r.run.run_id} · ${liveness} · macro ${r.run.macro_id ?? '-'} · steps ${r.run.steps} · $${Number(r.run.cost_usd ?? 0).toFixed(2)}`);
  out(`  started ${r.run.started_at}${r.run.ended_at ? ` · ended ${r.run.ended_at}` : ''} · ledger ${r.dir}`);
  for (const s of r.steps) {
    const pct = typeof s.peak_pct === 'number' ? ` ${(s.peak_pct * 100).toFixed(1)}%` : '';
    out(`  [${s.seq}] ${s.command} → ${s.outcome ?? (s.event === 'started' ? 'running or interrupted' : '?')}${typeof s.cost_usd === 'number' ? ` · $${s.cost_usd.toFixed(2)}` : ''}${pct} · session ${s.session_id}`);
  }
  if (r.halt) {
    out(`  halt: ${r.halt.reason} — ${r.halt.detail}`);
    if (r.halt.pointer) out(`    pointer: ${r.halt.pointer}`);
    for (const line of r.halt.resume ?? []) out(`    ${line}`);
  }
  if (r.run.error) out(`  error: ${r.run.error}`);
  return 0;
}

async function stopCmd(o, repoRoot, out, err, { wait = 30_000 } = {}) {
  // The runs that hold a lock here: every macro lock under the main worktree
  // and this worktree's lock, one entry per run.
  const runs = new Map();
  for (const l of listLocks(mainWorktreeRoot(repoRoot), repoRoot)) {
    if (!l.holder?.run_id || (o.macro && l.holder.macro_id !== o.macro)) continue;
    if (!runs.has(l.holder.run_id) && await holderAlive(l.holder)) runs.set(l.holder.run_id, l.holder);
  }
  if (runs.size === 0) { out('no autopilot run is active'); return 0; }
  if (runs.size > 1) {
    err(`✗ ${runs.size} runs are active (${[...runs.values()].map((h) => `${h.run_id} on ${h.macro_id ?? '?'}`).join(', ')}); name one with --macro <id>`);
    return 1;
  }
  const [holder] = runs.values();
  // A signal needs proof that the pid is still the process the lock names
  // (liveness errs toward "held"; this must not). The driver is stopped when
  // it is provably there: it empties its worker's group, cancels the step's
  // peers and records the halt itself. A driver that died leaves its worker,
  // a process-group leader the run started; with no driver to finish the job,
  // the group is emptied here — SIGTERM, then SIGKILL — before anything is
  // reported.
  if (await provablySame(holder.pid, holder.fingerprint)) {
    process.kill(holder.pid, 'SIGTERM');
    out(`sent SIGTERM to run ${holder.run_id} (pid ${holder.pid}) driving ${holder.macro_id ?? '(no macro)'}`);
  } else if (await provablySame(holder.worker?.pid, holder.worker?.fingerprint)) {
    out(`run ${holder.run_id}'s driver is gone; stopping its worker's process group (pid ${holder.worker.pid})`);
    const outcome = await terminateGroup(holder.worker.pid);
    if (outcome === 'lingering') {
      err(`✗ a process in the worker's group (${holder.worker.pid}) is still there after SIGKILL; check it with ps -g ${holder.worker.pid}`);
      return 1;
    }
    out(`the worker's process group is empty (${outcome}); no halt was recorded, since its driver was gone — status shows the run as gone`);
    return 0;
  } else {
    err(`✗ run ${holder.run_id} looks alive, but neither its driver (pid ${holder.pid}) nor its worker can be proven to be the process the lock recorded; nothing was signalled.`);
    return 1;
  }
  const deadline = Date.now() + wait;
  while (Date.now() < deadline) {
    if (!(await holderAlive(holder))) { out('it stopped; its halt is recorded as interrupted'); return 0; }
    await new Promise((r) => { setTimeout(r, 200); });
  }
  err('✗ it is still running; it stops once its worker\'s process group is empty (SIGKILL follows SIGTERM after 5 s)');
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
    case 'stop': return stopCmd(o, repoRoot, out, err);
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

