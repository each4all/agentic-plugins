// plugins/orchestrator/adapters/claude/autopilot/worker.mjs
//
// ADR-0063 D5 — the worker host: one fresh `claude -p` process per step,
// hosted over stream-json, and the context sensor of D7.
//
// Why stream-json and not `-p "<prompt>"`: a `-p` prompt run ends at its turn
// end and kills the background tasks the turn started (probe D), and peer
// ensembles run as background tasks. With `--input-format stream-json` and
// stdin held open, a finished background task re-invokes the model (probe D2),
// so the host closes stdin only once a result has arrived, no background task
// is pending, and no task notification still waits for its follow-up turn.
//
// Posture (D5): argv only, never a shell string; `manual` mode with an exact
// allowlist and denylist and `--permission-prompts none`, so nothing can wait
// on a prompt; nothing the driver passes escalates (`assertNoEscalation`).
// The worker's environment is the driver's minus the launching session's
// identity, the dispatch contract variables and the notification channel,
// plus the run id and the plugin roots.
//
// On timeout or abort the driver kills only the process group it spawned (the
// ADR-0035 §4 child-only rule, the peer-runner pattern).

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';

import { STEP_REPORT_SCHEMA } from './policy.mjs';

export const claudeBin = (env = process.env) => env.AUTOPILOT_CLAUDE_BIN || 'claude';

// ADR-0063 D5. `Task` is the subagent tool's name in a `-p` worker (2.1.281);
// interactive sessions call it `Agent`. `Monitor` lets a worker wait on its
// own peer run.
export const ALLOWED_TOOLS = Object.freeze([
  'Bash', 'Read', 'Edit', 'Write', 'NotebookEdit', 'Task', 'Skill',
  'WebFetch', 'WebSearch', 'TaskStop', 'Monitor',
]);
// Outward-facing or scope-escaping. Deny rules beat the owner's broad
// user-level allows, which reach every worker because workers must load user
// settings (enabledPlugins lives there, probe R1).
export const DENIED_TOOLS = Object.freeze([
  'Bash(git push:*)', 'Bash(gh pr:*)', 'Bash(gh release:*)', 'Bash(gh repo:*)',
  'Bash(gh api:*)', 'Bash(gh issue:*)', 'Bash(osascript:*)', 'Bash(open:*)',
  'Bash(npm publish:*)', 'Bash(git remote:*)',
  'PushNotification', 'RemoteTrigger', 'CronCreate', 'ScheduleWakeup', 'SendMessage',
  'EnterWorktree', 'Workflow',
]);
// Commit discipline: only /engineer:commit commits.
export const COMMIT_DENY = 'Bash(git commit:*)';

// The launching session's identity (D5) and the session-scoped state Claude
// Code reads from the environment: a background (`--bg`) session's permission
// rules and add-dirs travel in CLAUDE_BG_* / CLAUDE_CODE_SESSION_KIND /
// CLAUDE_RELAUNCH_* (2.1.286 binary), and would otherwise reach a worker
// started from inside one. A plain terminal has none of them (probe A2).
const SCRUB_EXACT = Object.freeze([
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
  // No per-step notification (D15/D9); kept until the owner's shell wrapper goes (R6).
  'AGENTIC_NOTIFY_EGRESS_CHANNEL',
  // A worker is not a companion: an inherited depth makes its peer ensembles refuse.
  'AGENTIC_COMPANION_DEPTH',
  // The ADR-0019 §1 dispatch contract. /orchestrator:next sets these inside
  // the worker; inherited from an outer session they would give the worker's
  // engineer workflow a foreign parent.
  'AGENTIC_PARENT_WORKFLOW', 'AGENTIC_ORIGINATING_SUBTASK', 'AGENTIC_PROFILE', 'AGENTIC_TOPIC',
  'AGENTIC_HOST',
  // The macro file's path, exported beside the ids (ADR-0067 Decision 3);
  // inherited, it would point the worker's child at a foreign macro file.
  'AGENTIC_PARENT_WORKFLOW_PATH',
  // The dispatch selection, exported beside them (ADR-0067 Decision 4, item
  // 5); inherited, it would record a foreign selection on the worker's child.
  'AGENTIC_DISPATCH_SELECTION',
  // ADR-0067 Decision 2: where records are created, and a run's admission
  // secret. Inherited from an outer session they would name another
  // checkout's homes or another run: only the driver may supply them.
  'AGENTIC_STATE_BASE', 'AGENTIC_AUTOPILOT_TOKEN',
  // Runbooks resolve their root from AGENTIC_<PLUGIN>_ROOT first; a stale
  // inherited value must not stand in for it.
  'CLAUDE_PLUGIN_ROOT',
]);
const SCRUB_PREFIXES = Object.freeze([
  'CLAUDE_CODE_SESSION_', 'CLAUDE_CODE_MESSAGING_', 'CLAUDE_CODE_CHILD_', 'CLAUDE_BG_', 'CLAUDE_RELAUNCH_',
]);

// Network pushes are blocked at the git level too. The denylist matches a
// command's leading words, so `git -C <dir> push` passes `Bash(git push:*)`
// (measured on Claude Code 2.1.286, 2026-10-01). Every git a worker runs
// inherits this environment, so a push to a network URL is rewritten to a
// scheme no remote helper serves and fails at once; local pushes (a test's
// bare repository) and every fetch are untouched. Measured with git 2.x:
//   - `pushInsteadOf` on https://, http://, ssh://, git://, on `git@`
//     (the scp-style form, git@host:path, of every common host) and on each
//     remote's own URL covers a remote without an explicit pushurl, whatever
//     the invocation (`git -C`, `sh -c`, a script);
//   - git ignores pushInsteadOf for a remote with an explicit pushurl, so
//     each such pushurl gets an `insteadOf`. A pushurl that is also a fetch
//     URL cannot get one without breaking the fetch, so the driver refuses to
//     start on such a repository (driver.mjs preflight);
//   - left open: an scp-style URL with another user (`me@host:path`) that
//     is no remote's URL.
export const PUSH_BLOCKED_SCHEME = 'autopilot-push-blocked://';
const NETWORK_URL_PREFIXES = Object.freeze(['https://', 'http://', 'ssh://', 'git://', 'git@']);

export function pushBlockConfig(base, { fetchUrls = [], pushUrls = [] } = {}) {
  const existing = Number.parseInt(base.GIT_CONFIG_COUNT ?? '0', 10);
  let n = Number.isInteger(existing) && existing > 0 ? existing : 0;
  const out = {};
  const add = (key, value) => {
    out[`GIT_CONFIG_KEY_${n}`] = key;
    out[`GIT_CONFIG_VALUE_${n}`] = value;
    n += 1;
  };
  const urls = (xs) => [...new Set(xs.filter((u) => typeof u === 'string' && u.length > 0))];
  for (const prefix of urls([...NETWORK_URL_PREFIXES, ...fetchUrls])) add(`url.${PUSH_BLOCKED_SCHEME}.pushInsteadOf`, prefix);
  const fetchSet = new Set(fetchUrls);
  for (const url of urls(pushUrls)) if (!fetchSet.has(url)) add(`url.${PUSH_BLOCKED_SCHEME}.insteadOf`, url);
  out.GIT_CONFIG_COUNT = String(n);
  return out;
}

export function workerEnv(base, { runId, roots, remotes = {}, stateBase = null, autopilotToken = null }) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (SCRUB_EXACT.includes(k) || SCRUB_PREFIXES.some((p) => k.startsWith(p))) continue;
    env[k] = v;
  }
  Object.assign(env, pushBlockConfig(base, remotes));
  env.AGENTIC_AUTOPILOT = runId;
  env.AGENTIC_ORCHESTRATOR_ROOT = roots.orchestrator;
  env.AGENTIC_ENGINEER_ROOT = roots.engineer;
  env.AGENTIC_RUNTIME_ROOT = roots.runtime;
  // ADR-0067 Decision 2 — the run's effective state root, which the driver
  // resolved once at start; never the inherited value scrubbed above.
  if (typeof stateBase === 'string' && stateBase !== '') env.AGENTIC_STATE_BASE = stateBase;
  // ADR-0067 Decision 4, item 5 — the run's secret, which admits its workers
  // to the locks it holds; never an inherited one.
  if (typeof autopilotToken === 'string' && autopilotToken !== '') env.AGENTIC_AUTOPILOT_TOKEN = autopilotToken;
  return env;
}

// The rules each worker gets on top of its runbook. No plugin roots: the
// runbooks resolve AGENTIC_<PLUGIN>_ROOT themselves since S0, and the
// capability floor (roots.mjs) requires releases that carry it.
export function systemAppend({ runId, seq, stepKind }) {
  const commit = stepKind === 'commit'
    ? 'This is the /engineer:commit step: commit through it as its runbook says.'
    : 'Do not commit: only the /engineer:commit step commits (git commit is denied on this step).';
  return [
    `[agentic-autopilot run=${runId} step=${seq}]`,
    'You are one headless step of an owner-launched autopilot run (ADR-0063). No human is present during this step.',
    '1. Run exactly the requested command for this one step, then stop. Do not start the next verb or command yourself.',
    '2. Never ask the user or wait for an answer. When the runbook needs an owner judgment, record it the way the runbook says (an owner gate, or next step owner-decision) and report it.',
    '3. Ceremony prompts resolve by default: take the recommendation, present in batch, use the suggested conventional subject.',
    '4. Run peer ensembles and other long work as host background tasks, wait for their notifications, and collect them before you finish. Never sleep-poll.',
    `5. ${commit} Never push, open, update or merge pull requests, and take no other outward action.`,
    '6. End with the structured step report. A report the host takes when you end a turn to wait for a background task is provisional: when its notification re-invokes you, carry on with the runbook to its end and file a new report. Only the last report counts. workflow = the id of the engineer workflow this step worked in (null when it ran no engineer verb). next_step = that workflow\'s next_step_kind / next_step_verb / next_step_confidence exactly as the verb wrote them with finish-verb (null when it ran no verb) — not the macro-level proposal /orchestrator:next prints at its end. awaiting_owner = the owner gate this step recorded, or null. summary = one line.',
  ].join('\n');
}

// ADR-0035 §3 invariant 8 by reference (the runtime executor guard's shape):
// the driver never escalates the posture it declared.
const ESCALATION = [/^--dangerously/, /^--allow-dangerously/, /^--resume$/, /^-r$/, /^--continue$/, /^-c$/, /^--fork-session$/];
export function assertNoEscalation(args) {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (ESCALATION.some((re) => re.test(a))) throw new Error(`autopilot worker argv carries an escalation flag: ${a}`);
    if (a === '--permission-mode' && args[i + 1] !== 'manual') throw new Error(`autopilot worker permission mode must be manual, got ${args[i + 1]}`);
    if (a === '--permission-prompts' && args[i + 1] !== 'none') throw new Error(`autopilot worker permission prompts must be none, got ${args[i + 1]}`);
    if (/bypassPermissions/.test(a)) throw new Error('autopilot worker argv names bypassPermissions');
  }
}

export function workerArgs({ sessionId, stepKind, runId, seq, stepBudgetUsd, model, effort }) {
  // One space-joined string per list: Claude Code splits a tool list on
  // commas and spaces outside parentheses (2.1.286), so `Bash(gh pr:*)` stays
  // one rule.
  const denied = stepKind === 'commit' ? DENIED_TOOLS : [...DENIED_TOOLS, COMMIT_DENY];
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-hook-events', '--session-id', sessionId,
    '--permission-mode', 'manual', '--permission-prompts', 'none',
    '--allowedTools', ALLOWED_TOOLS.join(' '),
    '--disallowedTools', denied.join(' '),
    '--append-system-prompt', systemAppend({ runId, seq, stepKind }),
    '--json-schema', JSON.stringify(STEP_REPORT_SCHEMA),
    '--max-budget-usd', String(stepBudgetUsd),
  ];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  assertNoEscalation(args);
  return args;
}

export const RAW_STREAM_MAX_BYTES = 64 * 1024 * 1024;
const CLOSE_DEBOUNCE_MS = 2000;
const KILL_GRACE_MS = 5000;
// After the worker itself has exited, how long its output may stay open. A
// descendant that inherited the pipes (and left the process group) would
// otherwise hold the step open forever.
const DRAIN_AFTER_EXIT_MS = 3000;

const parseJson = (line) => {
  try { return JSON.parse(line); } catch { return null; }
};

const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });

function targetAlive(target) {
  try {
    process.kill(target, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Empty a process group the run started: SIGTERM (unless `signalled` says it
 * already went), wait up to the grace for the group to empty, then SIGKILL and
 * wait briefly again. Resolves to 'empty' (nothing was left), 'terminated',
 * 'killed', or 'lingering' (something survived SIGKILL — a process the kernel
 * cannot stop yet). Awaited before a step is reported finished, so neither the
 * driver's exit nor its lock release can outrun the escalation.
 */
export async function terminateGroup(pgid, { graceMs = KILL_GRACE_MS, signalled = false, signalledAt = Date.now() } = {}) {
  if (!Number.isInteger(pgid) || pgid <= 0) return 'empty';
  // Windows has no process groups: there, the worker itself.
  const target = process.platform === 'win32' ? pgid : -pgid;
  if (!targetAlive(target)) return 'empty';
  if (!signalled) {
    try { process.kill(target, 'SIGTERM'); } catch { /* emptied meanwhile */ }
    signalledAt = Date.now();
  }
  while (Date.now() - signalledAt < graceMs) {
    await pause(100);
    if (!targetAlive(target)) return 'terminated';
  }
  try { process.kill(target, 'SIGKILL'); } catch { /* emptied meanwhile */ }
  for (let i = 0; i < 20; i += 1) {
    await pause(100);
    if (!targetAlive(target)) return 'killed';
  }
  return 'lingering';
}

/**
 * Start one worker. Returns { sessionId, pid, begin(), abort(reason), done }.
 * The worker gets its prompt only from `begin()`: the driver records the
 * worker in its locks first, so a driver that dies in between leaves a worker
 * with nothing to do, which exits when the driver's end of stdin closes.
 *
 * @param o.cwd            the repository root the step runs in
 * @param o.prompt         the step command (policy.renderStep)
 * @param o.stepKind       policy step kind
 * @param o.runId, o.seq   ledger identity
 * @param o.roots          {orchestrator, engineer, runtime}
 * @param o.stepBudgetUsd  --max-budget-usd
 * @param o.stepTimeoutSec wall clock for the step
 * @param o.model, o.effort  null = the owner's Claude Code setting
 * @param o.rawPath        where the raw stream goes (ledger worker-<seq>.jsonl)
 * @param o.env            the driver's environment (defaults to process.env)
 * @param o.remotes        {fetchUrls, pushUrls} of the repository's remotes (pushBlockConfig)
 * @param o.checkInit      (plugins) => null | {reason, detail}: refuse the loaded plugins
 */
export function startWorker(o) {
  const env = o.env ?? process.env;
  const sessionId = o.sessionId ?? randomUUID();
  const args = workerArgs({
    sessionId, stepKind: o.stepKind, runId: o.runId, seq: o.seq,
    stepBudgetUsd: o.stepBudgetUsd, model: o.model, effort: o.effort,
  });
  // Everything that can fail before the worker runs is done before it starts.
  const raw = fs.openSync(o.rawPath, 'a');
  const workerEnvironment = workerEnv(env, { runId: o.runId, roots: o.roots, remotes: o.remotes ?? {}, stateBase: o.stateBase ?? null, autopilotToken: o.autopilotToken ?? null });
  let child;
  try {
    child = spawn(claudeBin(env), args, {
      cwd: o.cwd, env: workerEnvironment, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
  } catch (err) {
    try { fs.closeSync(raw); } catch { /* closed */ }
    throw err;
  }

  const rawMax = o.rawMaxBytes ?? RAW_STREAM_MAX_BYTES;
  let rawBytes = 0;
  let rawCapped = false;
  const writeRaw = (line) => {
    if (rawCapped) return;
    const bytes = Buffer.byteLength(line) + 1;
    try {
      if (rawBytes + bytes > rawMax) {
        rawCapped = true;
        fs.writeSync(raw, `${JSON.stringify({ type: 'autopilot', subtype: 'raw_stream_truncated', max_bytes: rawMax })}\n`);
        return;
      }
      rawBytes += bytes;
      fs.writeSync(raw, `${line}\n`);
    } catch {
      rawCapped = true; // the ledger cannot take more; the step goes on
    }
  };

  const st = {
    pending: 0, awaitingFollowUp: false, results: [], model: null, plugins: null,
    peakByModel: new Map(), denialEvents: [], aborted: null, abortReason: null, abortDetail: null,
    closeTimer: null, stdinClosed: false, stderrTail: '', exit: null, abortedAt: null,
  };

  const killGroup = (signal) => {
    try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
  };
  const abort = (reason, detail = null) => {
    if (st.aborted) return;
    st.aborted = reason;
    st.abortedAt = Date.now();
    if (detail) { st.abortReason = detail.reason ?? null; st.abortDetail = detail.detail ?? null; }
    killGroup('SIGTERM');
    // A worker that does not exit on SIGTERM is killed; what the group still
    // holds after the worker exits is emptied before the step finishes
    // (terminateGroup, awaited below).
    setTimeout(() => { if (st.exit === null) killGroup('SIGKILL'); }, KILL_GRACE_MS).unref?.();
  };
  const closeStdin = () => {
    if (st.stdinClosed) return;
    st.stdinClosed = true;
    try { child.stdin.end(); } catch { /* already closed */ }
  };
  const maybeClose = () => {
    clearTimeout(st.closeTimer);
    if (st.results.length > 0 && st.pending === 0 && !st.awaitingFollowUp) {
      st.closeTimer = setTimeout(closeStdin, CLOSE_DEBOUNCE_MS);
    }
  };

  const timer = setTimeout(() => abort('timeout'), o.stepTimeoutSec * 1000);
  child.stdin.on('error', () => {});

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    writeRaw(line);
    const ev = parseJson(line);
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'assistant') {
      // A subagent's messages carry its own context, not the step's.
      if (!ev.parent_tool_use_id) {
        const u = ev.message?.usage ?? {};
        const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        const model = typeof ev.message?.model === 'string' ? ev.message.model : (st.model ?? '');
        if (ctx > (st.peakByModel.get(model) ?? 0)) st.peakByModel.set(model, ctx);
      }
    } else if (ev.type === 'system') {
      if (ev.subtype === 'init') {
        if (typeof ev.model === 'string') st.model = ev.model;
        st.plugins = Array.isArray(ev.plugins) ? ev.plugins : [];
        // Which plugin code this worker actually loaded (its commands, skills
        // and hooks); the driver refuses a step that would run code other than
        // what the run pinned. Init precedes the model's first turn.
        const problem = o.checkInit ? o.checkInit(st.plugins) : null;
        if (problem) abort('provenance', problem);
      }
      if (ev.subtype === 'background_tasks_changed') st.pending = Array.isArray(ev.tasks) ? ev.tasks.length : 0;
      if (ev.subtype === 'task_notification') st.awaitingFollowUp = true;
      if (ev.subtype === 'permission_denied') st.denialEvents.push({ tool: ev.tool_name ?? null, reason: ev.decision_reason ?? null });
      const hookEvent = ev.hook_event ?? ev.hook_event_name ?? null;
      if ((ev.subtype === 'hook_started' || ev.subtype === 'hook_response') && hookEvent === 'PreCompact') {
        abort('compaction-imminent');
      }
    } else if (ev.type === 'result') {
      st.results.push(ev);
      st.awaitingFollowUp = false;
    }
    maybeClose();
  });
  child.stderr.on('data', (d) => { st.stderrTail = (st.stderrTail + d.toString()).slice(-2000); });

  const done = new Promise((resolve) => {
    let settled = false;
    const finish = async (code, signal, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(st.closeTimer);
      try { fs.closeSync(raw); } catch { /* already closed */ }
      // Output a descendant still holds is abandoned, not waited on.
      child.stdout.destroy();
      child.stderr.destroy();
      const last = st.results.at(-1) ?? null;
      const usage = last?.modelUsage && typeof last.modelUsage === 'object' ? last.modelUsage : {};
      // Each main-thread sample against its own model's window.
      let peakCtx = 0;
      let peakPct = null;
      let contextWindow = null;
      for (const [model, ctx] of st.peakByModel) {
        if (ctx > peakCtx) peakCtx = ctx;
        const win = usage[model]?.contextWindow ?? (model === '' && st.model ? usage[st.model]?.contextWindow : undefined);
        if (typeof win === 'number' && win > 0 && (peakPct === null || ctx / win > peakPct)) {
          peakPct = ctx / win;
          contextWindow = win;
        }
      }
      const resultDenials = Array.isArray(last?.permission_denials)
        ? last.permission_denials.map((d) => ({ tool: d?.tool_name ?? null, reason: null }))
        : null;
      // Nothing the step started outlives it in its process group.
      const groupTeardown = spawnError
        ? 'empty'
        : await (o.terminateGroup ?? terminateGroup)(child.pid, { signalled: st.aborted !== null, signalledAt: st.abortedAt ?? Date.now() });
      resolve({
        sessionId,
        exitCode: code,
        signal,
        spawnError: spawnError ?? null,
        aborted: st.aborted,
        abortReason: st.abortReason,
        abortDetail: st.abortDetail,
        timeoutSec: o.stepTimeoutSec,
        lastResult: last
          ? { is_error: last.is_error === true, subtype: last.subtype ?? null, num_turns: last.num_turns ?? null }
          : null,
        report: last?.structured_output ?? null,
        // null when no result reported a cost (a killed worker): the driver
        // then charges the step's whole budget rather than nothing.
        costUsd: typeof last?.total_cost_usd === 'number' ? last.total_cost_usd : null,
        turns: st.results.length,
        model: st.model,
        plugins: st.plugins,
        peakCtx,
        contextWindow,
        peakPct,
        denials: resultDenials ?? st.denialEvents,
        stderrTail: st.stderrTail,
        rawTruncated: rawCapped,
        groupTeardown,
        pgid: spawnError || process.platform === 'win32' ? null : child.pid,
      });
    };
    child.on('error', (err) => finish(null, null, err.message));
    child.on('exit', (code, signal) => {
      st.exit = { code, signal };
      setTimeout(() => finish(code, signal), DRAIN_AFTER_EXIT_MS).unref?.();
    });
    child.on('close', (code, signal) => finish(st.exit?.code ?? code, st.exit?.signal ?? signal));
  });

  let begun = false;
  const begin = () => {
    if (begun) return;
    begun = true;
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: o.prompt }] } })}\n`);
  };
  return { sessionId, pid: child.pid, begin, abort, done };
}
