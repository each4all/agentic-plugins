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
//   release <subtask>   end a lane's kept park (ADR-0068 Decision 1, item 4),
//                       with or without a live run (parks.mjs); with --hold,
//                       give a held lane back; with --discard-unreadable,
//                       discard a record that cannot be read (holds-cli.mjs)
//   hold <subtask>      hold a lane for a person (ADR-0068 Decision 2)
//   writer-clear <subtask> --operation <id>
//                       the owner's word that an operation's session is gone
//   events (--macro <id> | --checkout <dir>) --after <run-id>:<seq> [--follow]
//                       print a run's events after a cursor, and with --follow
//                       watch for more (ADR-0068 Decision 4, events-reader.mjs)
//   heavy -- <command>  run a command under the repository's heavy-work lock
//                       (ADR-0068 Decision 6, lib/heavy-run.mjs); exempt from
//                       the host refusal below, since the lock is host-neutral
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
import { existsSync, fstatSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { expandArgsFile } from '../../../scripts/lib/args-file.mjs';
import { absorbOutputErrors } from '../../../scripts/lib/cli-entry.mjs';
import { holderName, holderOf } from '../../../scripts/lib/heavy-lock.mjs';
import { HeavyUsageError, parseHeavy, runHeavy } from '../../../scripts/lib/heavy-run.mjs';
import { describeAdmission } from '../../../scripts/lib/run-locks.mjs';
import { holdStateOf, holdTransition, liveRuns } from '../../../scripts/lib/holds.mjs';
import { discardCmd, holdCmd, holdsStatusLines, releaseHoldCmd, writerClearCmd } from './holds-cli.mjs';
import { isAutopilotRun } from '../../../scripts/state.mjs';
import { MIN_STEP_BUDGET_USD } from './budget.mjs';
import { cleanupDeadRuns } from './dead-runs.mjs';
import { eventsPath } from './events.mjs';
import { parseCursor, readEvents } from './events-reader.mjs';
import { DEFAULTS, EMERGENCY_CAP_SEC, posture, preflight, startRun, STALL_DETECTOR_MODES } from './driver.mjs';
import { landingLabel } from './landing-ready.mjs';
import { gatherLaneFacts, laneHome, lanePath, lanesRequirements, planReconciliation } from './lanes.mjs';
import { launchProposals, proposalLines, reportEntries } from './launch-proposals.mjs';
import {
  autopilotDir, holderAlive, listLocks, listOpenRuns, listRuns, macroLockPath, mainWorktreeRoot, provablySame, readLockEntries, readOpenRun, readRun, relaunchCommand,
} from './ledger.mjs';
import { deletePark, readPark, readParks, retiring } from './parks.mjs';
import { resolveRoots } from './roots.mjs';
import { observe } from './observe.mjs';
import { INTERRUPT_BOUND_MS } from './offloop.mjs';
import {
  decide, decideLanes, fingerprint, forcedForLanes, haltScope, isSafeSubtaskId, MODEL_PLANS, parseForcedStep, proposalLines as haltProposalLines, proposalsOnce,
  renderStep, withProposals,
} from './policy.mjs';
import { verifyOfferFor } from './verify-run.mjs';

// What preview tells the policy of verification: the offer a start would make.
// The journal's facts are read only by a run, so a request whose batch ended
// previews as its verification step, which the run then follows.
function previewVerify(roots, repoRoot, view) {
  try {
    const o = verifyOfferFor({ roots, repoRoot, baseline: view?.git?.head ?? null });
    return { offered: o.offered === true, why: o.why ?? null, facts: {} };
  } catch {
    return null;
  }
}
import { MAX_STEP_TIMEOUT_SEC, terminateGroup } from './worker.mjs';

const SELF = fileURLToPath(import.meta.url);
const SUBCOMMANDS = ['preview', 'start', 'status', 'stop', 'release', 'hold', 'writer-clear', 'events'];
// The subcommands that name a subtask as their one positional argument.
const SUBTASK_SUBCOMMANDS = ['release', 'hold', 'writer-clear'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;

export const USAGE = `Usage: autopilot [preview|start|status|stop|release|hold|writer-clear|events] [options]
       autopilot heavy [--purpose <text>] [--repo <dir>] [--declaration-ref <rev>] -- <command> [args...]

  preview                 observe, decide and print the posture; spawns nothing (default)
  start                   preview, plus how to execute
  start --execute         run the autopilot until the macro completes or a halt
  status [--run <id>] [--macro <id>]
                          the latest run (or that run) and whether it still holds its lock; with --macro,
                          that macro's holds too, from any checkout, with or without a run
  stop [--macro <id>]     stop the run that drives a macro (SIGTERM; it records an interrupted halt), or
                          clean up after one whose driver died (its peers, its unfinished step, its halt)
  release <subtask> --macro <id>
                          end a parked lane's kept park, with or without a live run: a live run picks the
                          lane up at its next tick, the next run judges it afresh
  release <subtask> --macro <id> --hold <hold id>
                          give a held lane back: the driver compares it once before it steps
  release <subtask> --macro <id> --discard-unreadable
                          keep a copy of a hold record that cannot be read and replace it, never unguarded
  hold <subtask> --macro <id>
                          hold a lane for a person: the driver leaves it alone once it shows held
  writer-clear <subtask> --macro <id> --operation <operation id>
                          a persona operation whose session is gone no longer keeps the lane
  events (--macro <id> | --checkout <dir>) --after <run-id>:<seq> [--after ...] [--follow]
                          print the events of a macro's runs (or a verb chain's, in that checkout) after
                          the cursor, one JSON line each, and with --follow keep watching; <run-id>:0 is
                          from that run's first line, whenever it arrives (the Monitor recipe)
  heavy -- <command>      run a command under the repository's heavy-work lock, one heavy job at a time
                          across worktrees (heavy --help for its options and exit codes)

Options:
  --repo <dir>            repository to drive (default: the current one)
  --macro <id>            the macro to drive (default: the one active on, or referencing, the current branch)
  --models <plan>         owner-default | mixed | sonnet (start --execute asks when omitted)
  --model <m> --effort <e>  one model / effort for every step (effort: ${EFFORTS.join(', ')})
  --max-steps <n>         default ${DEFAULTS.maxSteps}
  --max-cost <usd>        default ${DEFAULTS.maxCostUsd}
  --step-budget <usd>     default ${DEFAULTS.stepBudgetUsd}
  --step-timeout <s>      default ${DEFAULTS.stepTimeoutSec} (at least 60, at most ${MAX_STEP_TIMEOUT_SEC}); the run itself has
                          no clock: steps, cost, this timeout, a halt or stop end it
  --stall-detector <mode> log (default): judge each step stalled, active or unknown and record each verdict
                          change, never stopping a step; on: a stalled step is aborted as a timed-out one is,
                          and the step clock's default becomes the emergency cap, ${EMERGENCY_CAP_SEC} s (an explicit
                          --step-timeout still wins). ADR-0068 Decision 3: switching it on is the owner's review
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
const atLeast = (name, raw, min, max = Infinity) => {
  const n = positive(name, raw, { integer: true });
  if (n < min) throw new UsageError(`${name} must be at least ${min} seconds (got ${n})`);
  if (n > max) throw new UsageError(`${name} must be at most ${max} seconds, the longest timer the worker host holds (got ${n})`);
  return n;
};

/** A step's stall summary, in one line (ADR-0068 Decision 3, item 7). */
export function stallSummaryText(sm) {
  const c = sm.verdict_counts ?? {};
  const sec = (ms) => (typeof ms === 'number' ? `${Math.round(ms / 1000)} s` : '?');
  return `last ${sm.last ?? '?'} · stalled ${c.stalled ?? 0}× · unknown ${c.unknown ?? 0}× (${sec(sm.unknown_ms)}) · longest quiet ${sec(sm.longest_quiet_ms)} · lowest 10-min CPU ${sm.lowest_window_cpu_ms === null || sm.lowest_window_cpu_ms === undefined ? '-' : `${(sm.lowest_window_cpu_ms / 1000).toFixed(2)} s`} · longest owed answer ${sec(sm.answer_owed_max_ms)}`;
}

/** Parse the command line (after any --args-file expansion). */
export function parseCli(argv) {
  const words = expandArgsFile(argv);
  const o = {
    sub: 'preview', execute: false, repo: null, macro: null, run: null,
    models: null, model: null, effort: null,
    maxSteps: DEFAULTS.maxSteps, maxCostUsd: DEFAULTS.maxCostUsd, stepBudgetUsd: DEFAULTS.stepBudgetUsd,
    stepTimeoutSec: DEFAULTS.stepTimeoutSec, stepTimeoutExplicit: false, stallDetector: DEFAULTS.stallDetector,
    forced: null, forcedText: null, forcedPairs: null, lanes: 1, notifyLocal: false, json: false, help: false,
    subtask: null, hold: null, operation: null, discardUnreadable: false,
    checkout: null, after: [], follow: false,
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
    // release, hold and writer-clear name their subtask as their one
    // positional argument.
    if (SUBTASK_SUBCOMMANDS.includes(o.sub) && o.subtask === null && !word.startsWith('-')) {
      if (!isSafeSubtaskId(word)) throw new UsageError(`${o.sub} ${JSON.stringify(word)}: not a subtask id`);
      o.subtask = word;
      continue;
    }
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
      case '--step-timeout':
        o.stepTimeoutSec = atLeast(name, value(), MIN_SECONDS, MAX_STEP_TIMEOUT_SEC);
        o.stepTimeoutExplicit = true;
        break;
      case '--stall-detector': {
        const mode = value();
        if (!STALL_DETECTOR_MODES.includes(mode)) throw new UsageError(`--stall-detector must be one of ${STALL_DETECTOR_MODES.join(', ')} (got ${JSON.stringify(mode)})`);
        o.stallDetector = mode;
        break;
      }
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
      case '--hold': o.hold = value(); break;
      case '--operation': o.operation = value(); break;
      case '--discard-unreadable': o.discardUnreadable = flag(); break;
      case '--checkout': o.checkout = value(); break;
      case '--after': {
        const raw = value();
        const c = parseCursor(raw);
        if (!c) throw new UsageError(`--after ${JSON.stringify(raw)} is not <run-id>:<seq>`);
        o.after.push(c);
        break;
      }
      case '--follow': o.follow = flag(); break;
      case '--help': case '-h': o.help = true; break;
      default: throw new UsageError(`unknown option ${JSON.stringify(word)}`);
    }
  }
  if (o.execute && o.sub !== 'start') throw new UsageError('--execute applies only to start');
  if (o.run !== null && o.sub !== 'status') throw new UsageError('--run applies only to status');
  if (o.hold !== null && o.sub !== 'release') throw new UsageError('--hold applies only to release');
  if (o.hold !== null && !/^[0-9a-f]{16}$/.test(o.hold)) throw new UsageError(`--hold ${JSON.stringify(o.hold)} is not a hold id`);
  if (o.operation !== null && o.sub !== 'writer-clear') throw new UsageError('--operation applies only to writer-clear');
  if (o.discardUnreadable && o.sub !== 'release') throw new UsageError('--discard-unreadable applies only to release');
  if (o.discardUnreadable && o.hold !== null) throw new UsageError('--discard-unreadable and --hold do not go together');
  if (o.sub === 'release' && o.subtask === null) throw new UsageError('release needs the subtask whose lane it releases');
  if (SUBTASK_SUBCOMMANDS.includes(o.sub) && o.subtask === null) throw new UsageError(`${o.sub} needs the subtask whose lane it acts on`);
  if (SUBTASK_SUBCOMMANDS.includes(o.sub) && o.macro === null) throw new UsageError(`${o.sub} needs --macro <id>`);
  if (o.sub === 'writer-clear' && o.operation === null) throw new UsageError('writer-clear needs --operation <operation id>');
  if (o.sub !== 'events' && (o.checkout !== null || o.after.length > 0 || o.follow)) throw new UsageError('--checkout, --after and --follow apply only to events');
  if (o.sub === 'events' && (o.macro === null) === (o.checkout === null)) throw new UsageError('events needs one of --macro <id> or --checkout <dir>');
  if (o.sub === 'events' && o.after.length === 0) throw new UsageError('events needs --after <run-id>:<seq> (<run-id>:0 for a run\'s first line)');
  if (o.models !== null && !MODEL_PLANS.includes(o.models)) throw new UsageError(`--models must be one of ${MODEL_PLANS.join(', ')}`);
  if (o.model !== null && !MODEL_RE.test(o.model)) throw new UsageError(`--model ${JSON.stringify(o.model)} is not a model name`);
  if (o.effort !== null && !EFFORTS.includes(o.effort)) throw new UsageError(`--effort must be one of ${EFFORTS.join(', ')}`);
  if (o.macro !== null && !/^macro-[a-z][a-z0-9-]*-\d{8}T\d{6}Z-[0-9a-f]{6}$/.test(o.macro)) {
    throw new UsageError(`--macro ${JSON.stringify(o.macro)} is not a macro workflow id`);
  }
  if (pendingLane !== null) throw new UsageError(`--lane ${pendingLane} needs a --next after it`);
  // ADR-0068 Decision 3, item 8 — with the detector on, the default step
  // clock is the emergency cap; a --step-timeout given, before or after it,
  // still wins.
  if (o.stallDetector === 'on' && !o.stepTimeoutExplicit) o.stepTimeoutSec = EMERGENCY_CAP_SEC;
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
      ...(c.verify ? { verify: c.verify } : {}),
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
 * the lane it runs in. `proposals` holds those of every halt decideLanes
 * gives, once each (ADR-0067 Decision 8, item 5). ADR-0068 Decision 1: the
 * macro's kept parks (`kept`) are left out of the decision, as the run leaves
 * them out until their record changes or the owner releases them, and each
 * lane the decision halts would park (`parks`) while the others start.
 */
export function previewLanes(o, repoRoot, view, pre, env = process.env) {
  const n = o.lanes;
  const macroId = view.macro?.id ?? null;
  const problems = macroId
    ? lanesRequirements({ checkout: repoRoot, stateRoot: pre.stateRoot, macroPath: view.macro.path, view })
    : [`a run with lanes needs its macro${view.macroLookupError ? ` (${view.macroLookupError})` : ''}: name it with --macro <id>`];
  const result = { n, problems, plan: null, first_wave: [], halt: null, idle: null, proposals: [], kept: [], parks: [] };
  const home = laneHome(repoRoot);
  if (home.problem || !macroId || view.macro.archived) return result;
  const parks = readParks(home.mainRoot, macroId);
  if (parks.problem) result.problems = [...problems, `the macro's kept parks cannot be read (${parks.problem})`];
  const gone = new Set(retiring(parks.records, view));
  result.kept = parks.records.filter((r) => !gone.has(r.subtaskId)).map((r) => ({
    subtask_id: r.subtaskId, state: r.state === 'ok' ? r.record.state : 'unreadable',
    reason: r.record?.reason ?? null, detail: r.record?.detail ?? r.error ?? null, since: r.record?.since ?? null,
  }));
  // A kept park's proposal, judged again from this look: only a current one.
  const keptHalts = parks.records.filter((r) => !gone.has(r.subtaskId) && r.state === 'ok' && r.record.state === 'parked')
    .map((r) => withProposals({ outcome: 'halt', reason: r.record.reason, detail: r.record.detail, subtaskId: r.subtaskId }, view));
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
  // A row's halt of a plan subtask parks its lane; one that names none drains.
  for (const h of plan.halts) {
    if (haltScope(h, view) === 'lane') result.parks.push({ subtask_id: h.subtaskId, reason: h.reason, detail: h.detail });
    else result.halt ??= { reason: h.reason, detail: h.detail };
  }
  if (o.forcedPairs?.length) {
    const f = forcedForLanes(o.forcedPairs, view);
    if (f.halt) result.halt ??= f.halt;
    else forced = f.forced;
  }
  // A forced lane's kept park ends at the start; every other one stays out.
  const parked = new Set([...result.kept.map((k) => k.subtask_id).filter((id) => !forced.has(id)), ...result.parks.map((p) => p.subtask_id)]);
  const d = decideLanes(view, { lanes: held, forced, parked, verify: previewVerify(pre.roots.roots, repoRoot, view) });
  if (d.outcome === 'halt') {
    result.halt ??= d;
    result.proposals = d.proposals ?? [];
    return result;
  }
  if (d.outcome === 'completed') return result;
  // A halt that names no lane drains the run, so nothing starts; each lane
  // halt parks its lane, and the rest start as the run admits them: forced
  // steps first.
  const drains = d.laneHalts.find((h) => haltScope(h, view) !== 'lane');
  if (drains) result.halt ??= drains;
  result.parks.push(...d.laneHalts.filter((h) => h !== drains).map((h) => ({ subtask_id: h.subtaskId, reason: h.reason, detail: h.detail })));
  const steps = drains ? [] : [...d.laneSteps.filter((x) => x.forced), ...(d.driverStep ? [d.driverStep] : []),
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
  if (result.first_wave.length === 0) result.idle = d.idle;
  result.proposals = proposalsOnce([...keptHalts, ...d.laneHalts, ...(result.idle ? [result.idle] : [])].flatMap((h) => h.proposals ?? []));
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
  for (const k of lp.kept ?? []) out(`  ■ lane ${k.subtask_id} is parked (${k.state}${k.since ? ` since ${k.since}` : ''}): ${k.reason ?? '?'} — ${k.detail ?? ''}`);
  for (const p of lp.parks ?? []) out(`  ■ lane ${p.subtask_id} would park: ${p.reason} — ${p.detail}`);
  if (lp.first_wave.length) {
    out('  first wave:');
    for (const w of lp.first_wave) {
      out(`    ${w.subtask_id ? `${w.subtask_id}: ` : ''}${w.command}${w.forced ? ' (forced)' : ''} · in ${w.checkout}${w.creates_lane ? ' (a new lane)' : ''}${w.waits_for_rate_limit_event ? ' · starts once the first worker\'s rate-limit event opens the throttle' : ''}`);
    }
  }
  if (lp.halt) out(`  would halt: ${lp.halt.reason} — ${lp.halt.detail}`);
  else if (lp.idle) out(`  would halt: ${lp.idle.reason} — ${lp.idle.detail}`);
  for (const line of haltProposalLines(lp.proposals)) out(line);
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
    else decision = decide(view, { runId: 'autopilot-00000000T000000Z-000000', macroId: view.macro?.id ?? null, forced: o.forced, verify: previewVerify(pre.roots.roots, repoRoot, view) });
  }
  let command = null;
  if (decision?.outcome === 'step') command = previewCommand(decision.step, view.macro.id);
  // ADR-0067 Decision 8, item 4: where to launch from, each trigger on its own.
  const proposals = pre.roots ? launchProposals({ repoRoot, view, options: o, roots: pre.roots.roots, env, home: env.HOME || homedir() }) : [];
  const report = {
    dry_run: true,
    repo: repoRoot,
    start_conditions: { ok: pre.problems.length === 0, problems: pre.problems, warnings: pre.warnings, claude: pre.claude ?? null },
    plugins: pre.roots ? Object.fromEntries(Object.keys(pre.roots.roots).map((k) => [k, { version: pre.roots.versions[k], root: pre.roots.roots[k], source: pre.roots.sources[k] }])) : null,
    view: view ? summarizeView(view) : null,
    decision: decision ? { ...decision, command } : null,
    lanes: lanesPreview,
    // ADR-0067 Decision 8, item 5 — display only: what the would-be halt's
    // owner is proposed to run before deciding (with lanes, every lane's).
    proposals: decision?.proposals ?? lanesPreview?.proposals ?? [],
    posture: p,
    launcher_install: pre.roots?.roots?.orchestrator ? launcherInstall(pre.roots.roots) : null,
  };
  // Item 4's launch proposals join item 5's list beside the halt's.
  report.proposals = [...report.proposals, ...reportEntries(proposals)];
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
      for (const line of haltProposalLines(decision.proposals)) out(line);
    }
    if (lanesPreview) printLanesPreview(lanesPreview, out);
    out(`posture: --permission-mode manual · --permission-prompts none · model plan ${p.model_plan ?? '(asked at start)'}${p.model_override.model || p.model_override.effort ? ` · override ${p.model_override.model ?? '-'}/${p.model_override.effort ?? '-'}` : ''}`);
    out(`  budgets: ${o.maxSteps} steps · $${o.maxCostUsd} per run · $${o.stepBudgetUsd} and ${o.stepTimeoutSec} s per step${o.lanes >= 2 ? ` · each step's budget reserved before it spawns, up to ${o.lanes} at once` : ''}`);
    out(`  stall detector: ${o.stallDetector === 'on' ? `on (a stalled step is aborted; the step clock is ${o.stepTimeoutSec} s${o.stepTimeoutExplicit ? '' : ', the emergency cap'})` : 'log (verdicts recorded, no step stopped; the step clock stops a step)'}`);
    out(`  allowed: ${p.allowed_tools.join(' ')}`);
    out(`  denied: ${p.denied_tools.join(' ')} (+ ${p.denied_on_non_commit_steps.join(' ')} except on /engineer:commit)`);
    for (const w of pre.warnings) out(`⚠ ${w}`);
    for (const line of proposalLines(proposals)) out(line);
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
  // ADR-0068 Decision 2, item 4 (P8) — the macro's holds, macro-scoped: from
  // any checkout, with or without a run here.
  const holds = o.macro ? await holdsStatusLines(mainWorktreeRoot(repoRoot), o.macro) : [];
  if (runs.length === 0) {
    if (o.json) out(JSON.stringify({ runs: [], admissions, holds }));
    else {
      out(`no autopilot runs in ${repoRoot}`);
      printAdmissions(admissions, out);
      for (const l of holds) out(l);
    }
    return 0;
  }
  if (!o.json) for (const l of holds) out(l);
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
  // A record whose own driver lives is a run ending (its locks released, its
  // last handoffs and run-ended under way), not one to clean up after.
  let cleanupPending = false;
  if (!live) {
    let left = null;
    try { left = readOpenRun(mainWorktreeRoot(repoRoot), id); } catch { /* no record */ }
    cleanupPending = left !== null && !(await recordDriverAlive(left));
  }
  // An error, or a group that outlived SIGKILL, leaves the record too.
  const pendingText = cleanupPending ? '; its cleanup is pending: /orchestrator:autopilot stop, or the next run of its macro, cleans up after it' : '';
  const liveness = r.run.status === 'running'
    ? (live
      ? (driverAlive || groups.length === 0 ? 'running' : `its driver is gone, but ${groups.length} worker group${groups.length === 1 ? '' : 's'} still run${groups.length === 1 ? 's' : ''}: /orchestrator:autopilot stop empties them`)
      : `gone (the driver exited without recording an end: it crashed or was killed)${pendingText}`)
    : `${r.run.status}${pendingText}`;
  if (o.json) {
    out(JSON.stringify({ run: r.run, steps: r.steps, landing: r.landing, lanes: r.lanes, halt: r.halt, live, worker_groups: groups, cleanup_pending: cleanupPending, admissions, holds }, null, 2));
    return 0;
  }
  out(`${r.run.run_id} · ${liveness} · macro ${r.run.macro_id ?? '-'} · steps ${r.run.steps} · $${Number(r.run.cost_usd ?? 0).toFixed(2)}`);
  out(`  started ${r.run.started_at}${r.run.ended_at ? ` · ended ${r.run.ended_at}` : ''} · ledger ${r.dir}`);
  if (r.run.verify) out(`  verification ${r.run.verify.offered ? `offered (declaration ${String(r.run.verify.declaration_digest).slice(0, 12)})` : `not offered (${r.run.verify.why})`}`);
  if (r.run.options?.stall_detector) out(`  stall detector ${r.run.options.stall_detector} · step clock ${r.run.options.step_timeout_sec ?? '?'} s${r.run.stall_record_failures ? ` · ${r.run.stall_record_failures} stall verdict${r.run.stall_record_failures === 1 ? '' : 's'} not recorded` : ''}`);
  for (const g of groups) out(`  worker group ${groupLabel(g)}${g.session_id ? ` · session ${g.session_id}` : ''}`);
  const c = r.run.dead_run_cleanup;
  if (c) {
    out(`  cleaned up after its dead driver by ${c.by ?? '?'} at ${c.at}${c.complete ? '' : ' (not finished: its record is kept)'}: ` +
      `cancelled ${c.cancelled?.length ? c.cancelled.join(', ') : 'no peer run'} · steps counted as spent ${c.settled?.length ? c.settled.map((s) => `[${s.seq}]`).join(' ') : 'none'}` +
      `${c.reported?.length ? ` · reported, not cancelled (they name no run): ${c.reported.join(', ')}` : ''}${c.unresolved?.length ? ` · not cancelled: ${c.unresolved.join(', ')}` : ''}`);
  }
  // ADR-0068 Decision 5, item 10 — a lane verifying, or waiting for the
  // heavy-work lock with its holder while the driver itself waits.
  const v = r.run.verifying;
  if (v && r.run.status === 'running') {
    out(`  [${v.seq}] ${v.subtask_id ? `lane ${v.subtask_id}: ` : ''}${v.state === 'waiting' ? `verification waits for the heavy-work lock, held by ${v.holder ?? 'another holder'}${v.holder_pid ? ` (pid ${v.holder_pid})` : ''}` : 'verifying'}`);
  }
  for (const s of r.steps) {
    // A verification batch: no worker, no session and no cost; its end and
    // how many of its checks ran, never a failing test's name or a log.
    if (s.kind === 'verify') {
      const b = s.verify?.batch;
      out(`  [${s.seq}] ${s.lane ? `lane ${s.lane}: ` : ''}verify → ${s.outcome ?? (s.event === 'started' ? 'running or interrupted' : '?')}${b ? ` · batch ${b.end ?? 'open'}${b.cause ? ` (${b.cause})` : ''}, ${(b.checks ?? []).length} of ${b.total ?? '?'} check(s) run` : s.verify?.outcome ? ` · ${s.verify.outcome}` : ''} · no cost`);
      continue;
    }
    const pct = typeof s.peak_pct === 'number' ? ` ${(s.peak_pct * 100).toFixed(1)}%` : '';
    out(`  [${s.seq}] ${s.lane ? `lane ${s.lane}: ` : ''}${s.command} → ${s.outcome ?? (s.event === 'started' ? 'running or interrupted' : '?')}${typeof s.cost_usd === 'number' ? ` · $${s.cost_usd.toFixed(2)}` : ''}${pct} · session ${s.session_id}`);
    // ADR-0068 Decision 3 — the step's last verdict, while it runs, or its summary.
    const lastStall = s.stalls?.at(-1);
    if (s.stall?.summary) out(`      stall: ${stallSummaryText(s.stall.summary)}`);
    else if (lastStall) out(`      stall: ${lastStall.verdict} since ${lastStall.at} (quiet ${Math.round(lastStall.quiet_ms / 1000)} s)`);
  }
  // A record from before freshness (no sync) reads as landing-ready, as it was written.
  for (const l of r.landing) {
    const base = l.sync?.base_commit ? ` · origin/${l.integration_branch ?? '?'} at ${l.sync.base_commit}` : '';
    out(`  ◆ ${landingLabel(l.sync)} after [${l.after_seq}]: ${l.subtask_id} on ${l.branch} at ${l.commit ?? 'no commit'} (${l.reason})${base}${l.sync?.detail ? `: ${l.sync.detail}` : ''}`);
  }
  if (r.halt) {
    out(`  halt: ${r.halt.reason} — ${r.halt.detail}`);
    if (r.halt.pointer) out(`    pointer: ${r.halt.pointer}`);
    // Each branch the halt lists with its readiness as the run last saw it,
    // published in this run or before it (a report is not repeated).
    for (const w of r.halt.waiting ?? []) {
      if (w.sync) out(`    · ${w.subtaskId} on ${w.branch}: ${landingLabel(w.sync)}${w.sync.detail ? ` (${w.sync.detail})` : ''}`);
    }
    for (const line of r.halt.resume ?? []) out(`    ${line}`);
  }
  // A run with lanes: one line per lane it met (ADR-0067 Decision 6), with
  // the readiness its last look left a waiting one in, which a halt for
  // another reason does not list (C128).
  for (const l of r.run.lanes?.lanes ?? []) {
    const sync = l.waiting?.sync;
    const why = l.park ? ` · parked since ${l.park.since ?? '?'}: ${l.park.reason} — ${l.park.detail}` : (l.halt ? ` · halted: ${l.halt.reason}` : '');
    out(`  lane ${l.subtask_id} · ${l.state ?? '?'}${l.path ? ` · ${l.path}` : ''}${l.last_step ? ` · last [${l.last_step.seq}] ${l.last_step.outcome}` : ''}${why}` +
      `${sync ? ` · ${landingLabel(sync)}${sync.detail ? ` (${sync.detail})` : ''}` : ''}`);
  }
  if (r.run.error) out(`  error: ${r.run.error}`);
  // A run that stopped on an error before any halt: what waited as it stopped,
  // none of it confirmed (C128).
  for (const w of r.run.waiting ?? []) {
    if (w.sync) out(`    · ${w.subtaskId} on ${w.branch}: ${landingLabel(w.sync)}${w.sync.detail ? ` (${w.sync.detail})` : ''}`);
  }
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

// Whether the process an open-run record names is still its driver (its pid
// and fingerprint, as the record has them).
const recordDriverAlive = (rec) => holderAlive({ pid: rec.pid, fingerprint: rec.fingerprint, worker: null });

// `hooks.listedEntries` is a test seam between a read's listing of the locks
// and its judgment of each entry (the race the wait loop's rereads close).
async function stopCmd(o, repoRoot, out, err, { wait = 30_000, env = process.env, hooks = {} } = {}) {
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
    const listed = listLocks(mainRoot, repoRoot);
    if (hooks.listedEntries) await hooks.listedEntries(runId);
    for (const l of listed) {
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
    // A run in scope past its locks whose run.json records its end and whose
    // record's own process is still its driver is ending (its last handoffs,
    // notification and run-ended), not dead: stop waits for its record to go,
    // within its bound, before it cleans up after anything (ADR-0068
    // Decision 4). One still running, its lock unread, is the cleanup's to
    // report live.
    const ended = (record) => {
      try {
        const run = JSON.parse(readFileSync(join(record.run_dir, 'run.json'), 'utf8'));
        return run?.run_id === record.run_id && !['running', 'draining'].includes(run.status);
      } catch {
        return false;
      }
    };
    const ending = async () => {
      const left = [];
      for (const { record } of listOpenRuns(mainRoot)) {
        if (!record || (o.macro && record.macro_id !== o.macro) || typeof record.run_dir !== 'string' || !ended(record)) continue;
        if (await recordDriverAlive(record)) left.push(record.run_id);
      }
      return left;
    };
    const deadline = Date.now() + wait;
    let left = await ending();
    if (left.length > 0) out(`run ${left.join(', ')} is ending; waiting for it`);
    while (left.length > 0 && Date.now() < deadline) {
      await new Promise((r) => { setTimeout(r, 200); });
      left = await ending();
    }
    if (left.length > 0) {
      err(`✗ run ${left.join(', ')} is still ending: its driver lives past its locks; run stop again once it has exited`);
      return 1;
    }
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
    // listed its entries counts as much as one listed before. A read lists
    // the entries before it judges each: a driver that adds a group's entry
    // and dies between the two leaves one the list missed and none alive.
    // Once none lives, the driver is dead and adds none: a second read is
    // complete.
    let live = await liveEntriesOf(holder.run_id);
    if (live.length === 0) live = await liveEntriesOf(holder.run_id);
    if (live.length === 0) {
      // A driver that died instead of recording its end (a crash on the way
      // out) leaves its open-run record: clean up after it now.
      let left = null;
      try { left = readOpenRun(mainRoot, holder.run_id); } catch { /* none */ }
      if (left === null) { out('it stopped; its halt is recorded as interrupted'); return 0; }
      // A driver that ends cleanly releases its locks first, then runs its
      // last handoffs, its notification and its run-ended, and only then
      // removes the record (ADR-0068 Decision 4): while the record's own
      // process lives, it is ending, not dead.
      if (await recordDriverAlive(left)) {
        await new Promise((r) => { setTimeout(r, 200); });
        continue;
      }
      out('its driver exited without recording its end; cleaning up after it');
      return (await cleanUp(holder.macro_id ?? o.macro, holder.run_id)).code;
    }
    // Its driver gone and a group of it left: no driver will empty that group.
    // An entry read while the driver still ran may be only its own, ended
    // since: with no group among them, the next read decides. The driver
    // dead, it adds no entry: read again, so a group it added after the read
    // above, beside one that read found, is stopped too.
    if (!(await holderAlive({ pid: holder.pid, fingerprint: holder.fingerprint, worker: null }))) {
      live = await liveEntriesOf(holder.run_id);
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

// The run that holds a macro's lock while its driver lives, or null. A lock
// or an entry that cannot be read counts as a live run (ADR-0068 Decision 2,
// N3), named for what could not be read.
async function liveRun(mainRoot, macroId) {
  const r = await liveRuns(mainRoot, macroId);
  if (!r.live) return null;
  return r.runs.find((x) => x.run_id)?.run_id ?? `a run that cannot be named (${r.why})`;
}

/**
 * ADR-0068 Decision 1, item 4 — a bare release: end the kept park of a
 * subtask's lane, with or without a live run. A worker never releases a lane
 * (Decision 2, item 2); a marker of a step a live run has under way is not a
 * park, and stays; one a dead run left is the owner's to end. `--hold`
 * names a hold, which this release does not build (ADR-0068 Decision 2).
 * `hooks.afterLiveRun` is a test seam after the live run is read.
 */
async function releaseCmd(o, repoRoot, env, out, err, hooks = {}) {
  if (isAutopilotRun(env)) {
    err(`✗ AGENTIC_AUTOPILOT=${env.AGENTIC_AUTOPILOT}: a step of an autopilot run never releases a lane, its own included`);
    return 1;
  }
  if (o.hold !== null) return releaseHoldCmd(o, repoRoot, { out, err, env, engineerRoot: await engineerRootOf(env) });
  if (o.discardUnreadable) return discardCmd(o, repoRoot, { out, err });
  const mainRoot = mainWorktreeRoot(repoRoot);
  // ADR-0068 Decision 2, item 7 — a bare release ends a kept park only: it
  // refuses on a held lane, and on one whose release is uncompared or was
  // rejected.
  const hs = holdStateOf(mainRoot, o.macro, o.subtask);
  const holdId = hs.hold?.record?.hold_id;
  if (hs.state === 'pending' || hs.state === 'held') {
    err(`✗ ${holdTransition('held', 'bare-release').refused}: give it back with agentic-autopilot release ${o.subtask} --macro ${o.macro} --hold ${holdId}`);
    return 1;
  }
  if (hs.state === 'unreadable') {
    err(`✗ the hold records of ${o.subtask} cannot be read: agentic-autopilot release ${o.subtask} --macro ${o.macro} --discard-unreadable`);
    return 1;
  }
  if (hs.state === 'released-uncompared') {
    err(`✗ ${holdTransition('released-uncompared', 'bare-release').refused}: the driver compares hold ${holdId}'s release before the lane steps`);
    return 1;
  }
  if (hs.state === 'rejected') {
    err(`✗ hold ${holdId}'s release was rejected: the lane changed after its release; stop editing, close the session, then hold and release it again`);
    return 1;
  }
  const cur = readPark(mainRoot, o.macro, o.subtask);
  if (cur.state === 'absent') {
    err(`✗ subtask ${o.subtask} of macro ${o.macro} is neither held nor parked: there is nothing to release`);
    return 1;
  }
  // A park that cannot be read is never deleted by a bare release: the owner
  // discards it, which keeps a copy (Decision 2, item 8).
  if (cur.state === 'unreadable') {
    err(`✗ subtask ${o.subtask}'s kept park cannot be read (${cur.error}); it is not deleted: agentic-autopilot release ${o.subtask} --macro ${o.macro} --discard-unreadable keeps a copy and ends it`);
    return 1;
  }
  const live = await liveRun(mainRoot, o.macro);
  if (hooks.afterLiveRun) await hooks.afterLiveRun();
  if (cur.record.state !== 'parked' && live && live === cur.record.run_id) {
    err(`✗ run ${live} has a step of subtask ${o.subtask} under way (${cur.record.state}): its lane is not parked; wait for the step to end`);
    return 1;
  }
  // Only the record read above, across the await, so a marker a relaunch
  // wrote meanwhile stays.
  const r = await deletePark(mainRoot, o.macro, o.subtask, { expect: cur.record.record_id, event: 'released', fields: { by: 'owner', live_run: live } });
  if (!r.ok) {
    err(`✗ subtask ${o.subtask}'s park changed while it was released (${r.current.state === 'ok' ? `now record ${r.current.record.record_id}, ${r.current.record.state}` : r.current.state}); run release again`);
    return 1;
  }
  const what = `${cur.record.reason} — ${cur.record.detail}`;
  out(`✓ released subtask ${o.subtask}'s lane of macro ${o.macro} (it was parked: ${what})`);
  out(live
    ? `  run ${live} picks it up at its next tick`
    : `  the next run judges it afresh: ${relaunchCommand({ macroId: o.macro, lanes: 2, repoRoot })}`);
  return 0;
}

// The process's own printer of one stream. A write that fails (EPIPE from a
// reader gone, EIO from a closed terminal) is no throw: the stream reports it
// later as an 'error' event, which would kill the driver wherever it stood,
// short of its run-ended or past it with another exit than its own.
// absorbOutputErrors keeps that error on the stream, and every later line is
// dropped: the run's outcome is its records', whatever its output met
// (ADR-0068 Decision 4). `failed` says whether a write has failed, and
// `stream` is the stream, for a command whose output is its whole work (the
// events reader, which stops once nobody reads it).
export function printerOf(stream) {
  absorbOutputErrors([stream]);
  let failed = false;
  stream.on('error', () => { failed = true; });
  const print = (s) => { if (!failed) stream.write(`${s}\n`); };
  print.stream = stream;
  Object.defineProperty(print, 'failed', { get: () => failed });
  return print;
}

export async function main(argv = process.argv.slice(2), { env = process.env, io = process, out = printerOf(process.stdout), err = printerOf(process.stderr), hooks = {} } = {}) {
  // The wrapper parses its own words, and nothing after its `--`; it is
  // exempt from the host and autopilot refusals below: the lock is
  // repository-level and host-neutral, and ADR-0063 D9 is about the driver.
  if (argv[0] === 'heavy') return runHeavy(argv.slice(1), { env, out, err });
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
  // ADR-0068 Decision 6, item 3: a driver inside a heavy-work lock holder's
  // ownership would hand its proof to every check and worker, and every lane's
  // heavy work would join that one holder at once.
  if (o.sub === 'start' && o.execute) {
    let holder = null;
    try { holder = holderOf(repoRoot, env); } catch { /* no lock to be inside */ }
    if (holder !== null) {
      err(`✗ this shell runs inside the heavy-work lock of ${holderName(holder)} (pid ${holder.pid}, ${holder.worktree}); `
        + 'start the autopilot outside `agentic-autopilot heavy`, whose ownership every lane would join');
      return 1;
    }
  }
  switch (o.sub) {
    case 'preview': return previewCmd(o, repoRoot, env, out);
    case 'start': return startCmd(o, repoRoot, env, out, err, io);
    case 'status': return statusCmd(o, repoRoot, out, err);
    case 'stop': return stopCmd(o, repoRoot, out, err, { env, hooks });
    case 'release': return releaseCmd(o, repoRoot, env, out, err, hooks);
    case 'events': return eventsCmd(o, repoRoot, out, hooks);
    case 'hold':
    case 'writer-clear': {
      if (isAutopilotRun(env)) {
        err(`✗ AGENTIC_AUTOPILOT=${env.AGENTIC_AUTOPILOT}: a step of an autopilot run never holds a lane or clears a writer, its own included`);
        return 1;
      }
      if (o.sub === 'writer-clear') return writerClearCmd(o, repoRoot, { out, err });
      return holdCmd(o, repoRoot, { out, err, env, engineerRoot: await engineerRootOf(env), runDirs: [autopilotDir(repoRoot), autopilotDir(mainWorktreeRoot(repoRoot))] });
    }
    default: return 1;
  }
}

/**
 * ADR-0068 Decision 4, item 6 — a macro's event file (or a verb chain's, in
 * its checkout), read after the cursors (events-reader.mjs). The reader finds
 * a run's records from its run-started line, its open-run record, or, for a
 * run with no line on file, the checkouts of the repository. `hooks.events`
 * are test seams (follow's signal and intervals).
 */
async function eventsCmd(o, repoRoot, out, hooks = {}) {
  const checkout = o.checkout === null ? null : (repoRootOf(resolve(o.checkout)) ?? resolve(o.checkout));
  const mainRoot = mainWorktreeRoot(checkout ?? repoRoot);
  const file = eventsPath({ mainRoot, macroId: o.macro, checkout });
  // A reader whose output is gone (Monitor stopped, a pipe's reader closed)
  // stops following at its next poll (outputProbe): its printer drops every
  // line, and polling on would only keep the process alive for nobody.
  const checkouts = checkoutsOf(mainRoot, checkout);
  return readEvents({
    file, cursors: o.after, follow: o.follow, out, runFacts: runFactsFor({ mainRoot, checkout, checkouts }),
    isRoot: checkouts.isRoot, outputOpen: outputProbe(out), ...(hooks.events ?? {}),
  });
}

// The repository's checkouts, as `git worktree list` names them (the main
// worktree, and --checkout, when it cannot list them), compared by their real
// paths: a path field of an event is printed only when it names a record
// under one of them, and null otherwise (events.mjs shownEvent), so no word
// of a path's own reaches the session. A directory not among them
// lists them again, once per directory, so a checkout added since the arm (a
// relaunch from a new worktree) is found.
function checkoutsOf(mainRoot, checkout) {
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  let list = null;
  let known = new Set();
  const misses = new Set();
  const read = () => {
    const r = spawnSync('git', ['-C', mainRoot, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: 30_000 });
    list = r.status === 0 ? r.stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length)) : [mainRoot];
    known = new Set([...list, mainRoot, ...(checkout ? [checkout] : [])].map(real));
  };
  return {
    list: () => { if (!list) read(); return list; },
    isRoot: (dir) => {
      if (!list) read();
      const r = real(dir);
      if (known.has(dir) || known.has(r)) return true;
      if (misses.has(r)) return false;
      read();
      if (known.has(r)) return true;
      misses.add(r);
      return false;
    },
  };
}

// A follow's probe of its output at each poll (ADR-0068 Decision 4): gone
// once a line's write failed (the printer's `failed`), and, while the file is
// idle, once a write of no bytes to a stdout that is a pipe or socket fails
// (EPIPE: its reader is gone), where the system checks the reader first
// (macOS); Linux takes a null write to a pipe as done, so there a follow
// notices a gone reader only at its next line. A terminal or a file is not
// written to.
export function outputProbe(print, fd = 1) {
  let probed = false;
  try { probed = print.stream === process.stdout && (fstatSync(fd).isFIFO() || fstatSync(fd).isSocket()); } catch { /* not probed */ }
  return () => {
    if (print.failed) return false;
    if (!probed) return true;
    try {
      writeSync(fd, Buffer.alloc(0));
      return true;
    } catch (e) {
      return !['EPIPE', 'EIO', 'ENOTCONN'].includes(e?.code);
    }
  };
}

// What the reader needs of a run: its run.json, whether its driver lives
// (its open-run record's process, or a lock entry of it: a run holds its
// locks before it writes the record), whether that record is there, whether
// a cleanup of it is under way.
function runFactsFor({ mainRoot, checkout, checkouts }) {
  return async (runId, { runDir }) => {
    let open = null;
    try { open = readOpenRun(mainRoot, runId); } catch { /* none */ }
    const dirs = [runDir, open?.run_dir, ...(checkout ? [checkout] : checkouts.list()).map((w) => join(autopilotDir(w), runId))];
    let found = null;
    for (const d of dirs.filter((x) => typeof x === 'string')) {
      const p = join(d, 'run.json');
      try {
        const run = JSON.parse(readFileSync(p, 'utf8'));
        if (run?.run_id === runId) { found = { runJsonPath: p, run }; break; }
      } catch { /* not there */ }
    }
    if (!found) return null;
    let live = open ? await holderAlive({ pid: open.pid, fingerprint: open.fingerprint, worker: null }) : false;
    if (!live) {
      try {
        for (const l of listLocks(mainRoot, checkout)) {
          if (l.holder?.run_id === runId && await holderAlive({ pid: l.holder.pid, fingerprint: l.holder.fingerprint, worker: null })) live = true;
        }
      } catch {
        live = true; // a lock that cannot be read may hide it: never judged dead
      }
    }
    // The record again, read after the locks: a driver writes it before it
    // releases them and removes it after its run-ended, so a record written
    // since the first read and locks released before the scan are not both
    // missed.
    if (!live) {
      let again = null;
      try { again = readOpenRun(mainRoot, runId); } catch { /* none */ }
      if (again) {
        open = again;
        live = await holderAlive({ pid: again.pid, fingerprint: again.fingerprint, worker: null });
      }
    }
    let cleaning = false;
    try {
      for (const e of readLockEntries(join(autopilotDir(mainRoot), 'open', `${runId}.cleanup.lock`))) if (await holderAlive(e.holder)) cleaning = true;
    } catch {
      cleaning = true;
    }
    return { ...found, live, open: Boolean(open), cleaning };
  };
}

// For tests: the wrapper's parser, reached through this entry.
export const heavyForTests = { parseHeavy, HeavyUsageError };

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


// The engineer the autopilot launcher pins (AGENTIC_ENGINEER_ROOT), else the
// one the roots resolve to: the engineer holds' activation requires.
async function engineerRootOf(env) {
  if (typeof env.AGENTIC_ENGINEER_ROOT === 'string' && env.AGENTIC_ENGINEER_ROOT !== '') return env.AGENTIC_ENGINEER_ROOT;
  try { return (await resolveRoots({ env })).roots.engineer ?? null; } catch { return null; }
}
