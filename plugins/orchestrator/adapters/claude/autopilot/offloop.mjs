// plugins/orchestrator/adapters/claude/autopilot/offloop.mjs
//
// ADR-0067 Decision 6 — the synchronous work a run with lanes runs in a child
// process. The scheduler supervises several workers at once, all on its event
// loop: each worker's stream, its step timeout and SIGKILL escalation, its
// init-time provenance check, a PreCompact abort, the rate-limit events, and
// the owner's SIGINT and SIGTERM. The work below is synchronous: a look
// (observe() and its CLIs, a network call up to 120 s), a lane's creation (a
// baseline fetch up to 120 s, then git per plan subtask), a prepared lane's
// baseline check, a lane's removal, the landing-ready report (merge-tree
// checks up to 120 s) and a peer run's cancellation (peer-runner, up to 60 s
// each). Run in process while a worker is in flight, any of it would stop that
// supervision for as long as it ran; the serial driver never had the problem,
// since it does such work only between steps. So during the scheduler's loop
// each one runs here, in a child, while the loop goes on serving its workers.
// What runs before the loop, with no worker in flight (the reconciliation, the
// first look and landing report), and all of the serial driver, stay in
// process.
//
// A task takes JSON and answers JSON. One that throws, exits, prints no answer,
// runs out of time or is stopped answers { error }; offLoop never rejects. The
// caller turns an error into what its own rules name: a lane's halt, a kept
// lane, a printed warning, a failed look.
//
// A task's processes have the discipline a worker's have (ADR-0067 Decision
// 6, Locks). Each task runs in its own process group, which goes on the locks
// the task acts under (`hold`: the macro lock and its checkout's lock) before
// the task gets its input, so a driver that dies leaves a task that does
// nothing, or one whose group still holds the run's exclusion until it ends
// or `stop` empties it. However the task ends (an answer, a timeout, a stop),
// its group is emptied — SIGTERM, a grace, SIGKILL — and confirmed empty
// before its entries go and before offLoop answers, so nothing a task began
// (git, a hook, a transport) outlives the answer and the locks the caller then
// lets go. A group that outlives SIGKILL keeps its entries, as a worker's does
// (`onLingering`). createTaskRunner applies the run's interrupt to its tasks.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { reportLandingReady } from './landing-ready.mjs';
import { createLane, fetchBaseline, removeLane } from './lanes.mjs';
import { processFingerprint } from './ledger.mjs';
import { observe } from './observe.mjs';
import { terminateGroup } from './worker.mjs';

const SELF = pathToFileURL(fileURLToPath(import.meta.url)).href;
const DRIVER = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'driver.mjs')).href;
// A task that takes longer than this has failed: its git calls time out at
// 30 s each, a fetch or a network call at 120 s, a peer cancellation at 60 s.
export const TASK_TIMEOUT_MS = 15 * 60 * 1000;
const OUTPUT_MAX_BYTES = 256 * 1024 * 1024;
// A process group per task, where the platform has them.
const GROUPS = process.platform !== 'win32';
// After the task itself has exited, how long its output may stay open: a
// descendant that inherited the pipe would otherwise hold the answer back
// (worker.mjs's rule).
const DRAIN_AFTER_EXIT_MS = 3000;

/**
 * The tasks, run in the child with its environment (the run's, which the
 * caller passes). `nowMs` stands for the driver's clock where a task writes a
 * time; `out` lines come back as `lines`, for the caller to print.
 */
export const TASKS = {
  observe: (a, env) => observe({ repoRoot: a.repoRoot, roots: a.roots, macroId: a.macroId, fetch: a.fetch, env }),
  createLane: (a, env) => {
    const lines = [];
    const r = createLane({
      home: a.home, checkout: a.checkout, macroId: a.macroId, subtask: a.subtask, view: a.view, baseline: a.baseline,
      runId: a.runId, runDir: a.runDir, now: () => a.nowMs, env, out: (x) => lines.push(String(x)),
    });
    return { ...r, lines };
  },
  fetchBaseline: (a, env) => fetchBaseline({ checkout: a.checkout, baseline: a.baseline, env }),
  removeLane: (a, env) => removeLane({
    home: a.home, macroId: a.macroId, subtaskId: a.subtaskId, runId: a.runId, runDir: a.runDir,
    now: () => a.nowMs, env, ownLaneLock: a.ownLaneLock, protect: a.protect,
  }),
  reportLanding: (a, env) => {
    const lines = [];
    const cache = new Map(a.cache ?? []);
    const report = reportLandingReady({
      repoRoot: a.repoRoot, mainRoot: a.mainRoot, runDir: a.runDir, runId: a.runId, seq: a.seq, view: a.view,
      out: (x) => lines.push(String(x)), now: () => a.nowMs, cache, env,
    });
    return { report, lines, cache: [...cache] };
  },
  cancelPeerRuns: async (a, env) => {
    // driver.mjs imports the scheduler, which imports this module: loaded
    // here, in the child only, the cycle never runs at import.
    const { cancelPeerRuns } = await import(DRIVER);
    return cancelPeerRuns(a.runIds, { roots: a.roots, checkout: a.checkout, env });
  },
};

const CHILD_SOURCE = [
  'const chunks = [];',
  'for await (const c of process.stdin) chunks.push(c);',
  'const a = JSON.parse(Buffer.concat(chunks).toString("utf8"));',
  'const { TASKS } = await import(a.module);',
  'let answer;',
  'try { answer = { ok: true, value: await TASKS[a.task](a.args, process.env) }; }',
  'catch (e) { answer = { ok: false, error: String(e?.message ?? e) }; }',
  'process.stdout.write(JSON.stringify(answer));',
].join('\n');

const stopReason = (signal) => (typeof signal?.reason === 'string' ? signal.reason : (signal?.reason?.message ?? 'it was stopped'));

// The child's output, and its end: { error } or its answer, once it has closed
// (or exited and its output stayed open past the drain).
function collect(child, label) {
  const out = [];
  let bytes = 0;
  let errTail = '';
  child.stdout.on('data', (d) => {
    bytes += d.length;
    if (bytes <= OUTPUT_MAX_BYTES) out.push(d);
  });
  child.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-600); });
  child.stdin.on('error', () => {});
  const ended = new Promise((resolveEnd) => {
    let settled = false;
    let drain = null;
    let exit = null;
    const settle = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(drain);
      resolveEnd(answer);
    };
    const judge = (code, signal) => {
      if (code !== 0 || bytes > OUTPUT_MAX_BYTES) {
        settle({ error: `${label} exited ${code ?? signal}${errTail ? `: ${errTail.trim().split('\n').slice(-3).join(' ')}` : ''}` });
        return;
      }
      let answer;
      try {
        answer = JSON.parse(Buffer.concat(out).toString('utf8'));
      } catch (e) {
        settle({ error: `${label} printed no answer (${e.message})` });
        return;
      }
      settle(answer?.ok === true ? { value: answer.value } : { error: answer?.error ?? `${label} answered nothing` });
    };
    child.on('error', (e) => settle({ error: `${label} could not run: ${e.message}` }));
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      drain = setTimeout(() => judge(code, signal), DRAIN_AFTER_EXIT_MS);
    });
    child.on('close', (code, signal) => judge(exit?.code ?? code, exit?.signal ?? signal));
  });
  return {
    ended,
    close: () => {
      child.stdout.destroy();
      child.stderr.destroy();
    },
  };
}

// The task's end, its time running out, or a stop: whichever comes first.
function until(ended, { timeoutMs, signal, label }) {
  return new Promise((resolveFirst) => {
    let done = false;
    let timer = null;
    const onAbort = () => first({ error: `${label} was stopped: ${stopReason(signal)}` });
    function first(answer) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolveFirst(answer);
    }
    timer = setTimeout(() => first({ error: `${label} did not finish in ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    ended.then(first);
  });
}

/**
 * Run one task in a child process. Resolves to { value } or { error }; never
 * rejects. It resolves only once the task's group is empty (or outlived
 * SIGKILL), and its entries on the locks are released.
 *
 * @param task  a key of TASKS
 * @param args  its JSON arguments
 * @param o.env the child's environment (the run's)
 * @param o.cwd where the child runs
 * @param o.label what an error calls it ("the <task> task")
 * @param o.hold async ({pid, pgid, fingerprint, task}) => [{ release }]: put the
 *        task's group on the locks it acts under; called before the task has
 *        its input, and a throw answers { error } with nothing run
 * @param o.signal an AbortSignal: a stop tears the task down and answers { error }
 * @param o.onLingering () => void: a process of the group outlived SIGKILL,
 *        so its entries stay
 * @param o.terminate the group teardown (worker.mjs terminateGroup; a test seam)
 */
export async function offLoop(task, args, {
  env = process.env, cwd = process.cwd(), timeoutMs = TASK_TIMEOUT_MS, label = `the ${task} task`,
  hold = null, signal = null, onLingering = null, terminate = terminateGroup,
} = {}) {
  if (!Object.hasOwn(TASKS, task)) return { error: `no task ${task}` };
  if (signal?.aborted) return { error: `${label} was not started: ${stopReason(signal)}` };
  let input;
  try {
    input = JSON.stringify({ module: SELF, task, args });
  } catch (e) {
    return { error: `${label} could not be given its arguments (${e.message})` };
  }
  let child;
  try {
    child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SOURCE], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: GROUPS });
  } catch (e) {
    return { error: `${label} could not start: ${e.message}` };
  }
  const io = collect(child, label);
  const pid = Number.isInteger(child.pid) ? child.pid : null;
  let entries = [];
  let answer = null;
  try {
    // On the locks before it has anything to do: the task waits for its input.
    if (hold && pid !== null) entries = await hold({ pid, pgid: GROUPS ? pid : null, fingerprint: await processFingerprint(pid), task });
  } catch (e) {
    answer = { error: `${label} could not be put on the run's locks (${e?.message ?? e})` };
  }
  if (!answer && signal?.aborted) answer = { error: `${label} was stopped before it began: ${stopReason(signal)}` };
  if (!answer) {
    child.stdin.end(input);
    answer = await until(io.ended, { timeoutMs, signal, label });
  } else {
    child.stdin.destroy();
  }
  // Nothing the task began outlives its answer.
  let teardown = 'empty';
  if (pid !== null) {
    try { teardown = await terminate(pid); } catch { teardown = 'lingering'; }
  }
  io.close();
  if (teardown === 'lingering') {
    onLingering?.();
  } else {
    for (const e of entries) {
      try { e.release(); } catch { /* released meanwhile */ }
    }
  }
  return answer;
}

// What an interrupt does to a task in flight (ADR-0067 Decision 6: SIGINT and
// SIGTERM do not drain, and every group in flight is aborted). A look, a
// baseline fetch and the landing report only read, so one in flight is
// killed at once: the next run reads again. A lane's creation or removal, and
// a peer run's cancellation, change what the next run finds, so one already
// under way gets INTERRUPT_BOUND_MS to finish, then is torn down, and the next
// run's reconciliation and cleanup judge what it left. A task started after
// the interrupt gets the same bound; the scheduler starts no lane's creation
// or removal and no landing report then, and looks without the fetch.
export const KILLED_AT_INTERRUPT = Object.freeze(['observe', 'fetchBaseline', 'reportLanding']);
export const INTERRUPT_BOUND_MS = 15_000;

/**
 * The tasks of one run. `run` is offLoop with the run's interrupt applied;
 * `interrupt()` applies it to the tasks in flight; `groups()` lists their
 * process groups, for the driver's exit backstop.
 *
 * @param o.offLoop      the task runner (offLoop; a test seam)
 * @param o.onLingering  a task's group outlived SIGKILL (the run keeps its locks)
 * @param o.boundMs      INTERRUPT_BOUND_MS
 */
export function createTaskRunner({ offLoop: runTask = offLoop, onLingering = () => {}, boundMs = INTERRUPT_BOUND_MS } = {}) {
  const inFlight = new Set();
  let interruptedAt = null;
  const arm = (t, atInterrupt) => {
    if (atInterrupt && KILLED_AT_INTERRUPT.includes(t.task)) {
      t.controller.abort('the run was interrupted');
      return;
    }
    const left = Math.max(0, interruptedAt + boundMs - Date.now());
    t.timer = setTimeout(() => t.controller.abort(`the run was interrupted, and it did not finish within ${Math.round(boundMs / 1000)} s of the interrupt`), left);
  };
  return {
    run(task, args, o = {}) {
      const t = { task, controller: new AbortController(), pgid: null, timer: null };
      inFlight.add(t);
      if (interruptedAt !== null) arm(t, false);
      const hold = async (group) => {
        t.pgid = group.pgid ?? group.pid;
        return o.hold ? o.hold(group) : [];
      };
      return Promise.resolve(runTask(task, args, { ...o, hold, signal: t.controller.signal, onLingering }))
        .finally(() => {
          clearTimeout(t.timer);
          inFlight.delete(t);
        });
    },
    interrupt() {
      if (interruptedAt !== null) return;
      interruptedAt = Date.now();
      for (const t of inFlight) arm(t, true);
    },
    groups: () => [...inFlight].map((t) => t.pgid).filter(Number.isInteger),
  };
}

// The view of a look that failed: every guard halts on it (the macro lookup,
// the entry brief, a detached HEAD), so no step is decided from it.
export function failedView(repoRoot, detail) {
  return {
    repoRoot, lookError: detail,
    git: { branch: '', head: null, porcelain: null, detached: true, clean: false, error: detail },
    brief: null, briefError: detail,
    macro: null, macroLookupError: detail,
    ready: null, readyError: null,
    children: {}, foreign: null, claims: [], claimsError: null,
    landing: {}, fetch: { attempted: false, ok: null, detail: null },
  };
}

/**
 * observe() in a child process. Resolves to the view, or to a view every
 * guard halts on when the look failed; never rejects. `o.offLoop` runs it (a
 * run's createTaskRunner, which puts it on the run's locks).
 */
export async function observeInChild({ repoRoot, roots, macroId = null, fetch = true, env = process.env }, { timeoutMs = TASK_TIMEOUT_MS, offLoop: runTask = offLoop } = {}) {
  const r = await runTask('observe', { repoRoot, roots, macroId, fetch }, { env, cwd: repoRoot, timeoutMs, label: 'the look' });
  return r.error ? failedView(repoRoot, r.error) : r.value;
}
