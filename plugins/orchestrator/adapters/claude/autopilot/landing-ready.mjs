// plugins/orchestrator/adapters/claude/autopilot/landing-ready.mjs
//
// ADR-0067 Decision 7 (docket C118) — the landing-ready event. When a look at
// the state shows a subtask committed and not landed (policy.mjs
// `waitingToLand`: its engineer workflow archived terminal, not
// close-complete, and resolve-landing answering no_pr or not_merged), the
// driver reports it once, and the run keeps dispatching:
//
//   - a terminal line;
//   - a `landing-ready` record in the run's ledger (`landing.jsonl` in the run
//     directory, ledger.mjs);
//   - a line appended to
//     `<main>/.agentic-plugins/runs/autopilot/landing/<macro-id>.jsonl`,
//     beside the macro lock: the deduplication has to outlive a run, and a
//     watcher tails one path across relaunches.
//
// The key is (subtask id, engineer workflow id, captured commit). A waiting
// subtask found unreported when a run starts is reported then, a reported one
// is not repeated, and a new commit on the branch, or a new attempt, is a new
// event. The log line is written last: a driver that dies before it reports
// the event again at its next start, so the log holds each event once while
// the terminal and the run ledgers may repeat one across runs. A torn last
// line is ended before the next append, so it never swallows a record.
//
// The commit is read from refs/heads/<branch> when the event is emitted: from
// git, never from a note (ADR-0063 R5). A branch git cannot resolve here
// emits no event (there is no commit to name); the halt still lists it. The
// overlap check is `git merge-tree --write-tree`, against
// refs/remotes/origin/<integration branch> and pairwise against every other
// waiting subtask's commit; each answer is clean, conflict (with the paths)
// or unavailable. Answers are kept for the run per commit pair and shallow
// boundary (which a deepening fetch moves), but not an unavailable one, which
// the next look tries again; and one look spends at most a bounded time on
// the checks.
//
// merge-tree does not run here, in the repository. There it would run any
// merge driver the config defines and an attribute selects, which can write
// refs and the worktree, and it would read the checkout's attributes, so the
// answer would depend on more than the two commits (measured on git 2.54). It
// runs in a scratch bare repository instead (`scratchRepo`), which borrows the
// repository's objects and its shallow boundary and nothing else: no config,
// no attributes, no refs, and no GIT_* variable of the caller's. No driver
// runs, the answer is git's own merge of the two commits, and the objects
// merge-tree writes stay in the scratch, which the look removes. Nothing here
// pushes, opens a pull request, or writes a ref, an object, the index or the
// worktree of the repository, and nothing here is a gate: the driver prints a
// failure and goes on.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AUTOPILOT_DIR_REL, appendLanding } from './ledger.mjs';
import { isSafeMacroId, waitingToLand } from './policy.mjs';

export const LANDING_DIR_REL = `${AUTOPILOT_DIR_REL}/landing`;

const GIT_TIMEOUT_MS = 30_000;
// What one look may spend on merge-tree, all pairs together.
export const CHECK_BUDGET_MS = 120_000;
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The macro's landing log, under the main worktree (ledger.mjs `mainWorktreeRoot`). */
export function landingLogPath(mainRoot, macroId) {
  if (!isSafeMacroId(macroId)) throw new Error(`invalid macro id for the landing log: ${macroId}`);
  return path.join(mainRoot, LANDING_DIR_REL, `${macroId}.jsonl`);
}

/** The records in a landing log, oldest first. A line that does not parse (a torn write) is skipped. */
export function readLandingLog(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* torn */ }
  }
  return records;
}

// Append one line, ending a torn last line first so the two never join.
function appendLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a+');
  try {
    const { size } = fs.fstatSync(fd);
    let lead = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) lead = '\n';
    }
    fs.writeSync(fd, `${lead}${line}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

export const eventKey = (r) => JSON.stringify([r?.subtask_id ?? null, r?.engineer_workflow_id ?? null, r?.commit ?? null]);

function runGit(argv, { cwd, env, timeout = GIT_TIMEOUT_MS } = {}) {
  const r = spawnSync('git', argv, {
    encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, ...(cwd ? { cwd } : {}), ...(env ? { env } : {}),
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '').trim() || (r.error ? r.error.message : '') };
}

const git = (repoRoot, args, o) => runGit(['-C', repoRoot, ...args], o);
const exitText = (r) => `exited ${r.code ?? 'on a signal or timeout'}${r.stderr ? `: ${r.stderr.split('\n')[0]}` : ''}`;

// The scratch's environment: the caller's without a single GIT_* variable (one
// can inject config, GIT_CONFIG_COUNT for instance), with HOME and
// XDG_CONFIG_HOME at the empty scratch, which hides the global config and
// attributes, and the system ones switched off.
function scratchEnv(base, dir) {
  const out = {};
  for (const [k, v] of Object.entries(base ?? process.env)) if (!k.startsWith('GIT_')) out[k] = v;
  return {
    ...out, HOME: dir, XDG_CONFIG_HOME: dir,
    GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1',
  };
}

// A scratch that cannot be removed stays in the temp directory; the report stands.
function remove(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* left behind */ }
}

/**
 * Where the repository keeps its objects, and its shallow boundary ('' when
 * the clone is not shallow), read once per look. The boundary decides which
 * merge base a shallow clone can see: an answer depends on it as well as on
 * the two commits, and a deepening fetch moves it (measured).
 */
export function repoLayout(repoRoot, env) {
  const where = git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'objects', '--git-path', 'shallow'], { env });
  const [objects, shallowFile] = where.stdout.split('\n');
  if (where.code !== 0 || !path.isAbsolute(objects ?? '')) {
    return { error: `could not locate the repository's objects (git rev-parse ${exitText(where)})` };
  }
  let shallow = '';
  try {
    shallow = fs.readFileSync(shallowFile, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') return { error: `could not read the shallow boundary (${e.message})` };
  }
  return { objects, shallow };
}

/**
 * A scratch bare repository for one look's overlap checks. It borrows the
 * repository's objects (objects/info/alternates) and the shallow boundary the
 * look read, without which a shallow clone's merge base cannot be read
 * (measured), and nothing else. `dispose()` removes it. { error } when it
 * cannot be made.
 */
export function scratchRepo(layout, { env, objectFormat = 'sha1' } = {}) {
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-landing-'));
    const gitDir = path.join(dir, 'repo.git');
    const senv = scratchEnv(env, dir);
    const init = runGit(['init', '-q', '--bare', '--template=', `--object-format=${objectFormat}`, gitDir], { cwd: dir, env: senv });
    if (init.code !== 0) throw new Error(`git init ${exitText(init)}`);
    fs.mkdirSync(path.join(gitDir, 'objects', 'info'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'objects', 'info', 'alternates'), `${layout.objects}\n`);
    if (layout.shallow) fs.writeFileSync(path.join(gitDir, 'shallow'), layout.shallow);
    const made = dir;
    return { dir, gitDir, env: senv, dispose: () => remove(made) };
  } catch (e) {
    if (dir) remove(dir);
    return { error: `could not make a scratch repository for the checks (${e?.message ?? e})` };
  }
}

/**
 * The commit a full ref name points at now, or null. `show-ref --verify`
 * takes the name exactly — no revision syntax, no pattern — and the argv
 * reaches git without a shell, so any name git accepts resolves.
 */
export function resolveCommit(repoRoot, ref, env) {
  if (typeof ref !== 'string' || ref.length === 0) return null;
  const r = git(repoRoot, ['show-ref', '--verify', '--hash', '--', ref], { env });
  const oid = r.stdout.trim();
  return r.code === 0 && OID_RE.test(oid) ? oid : null;
}

/**
 * Whether two commits merge cleanly, checked in a `scratchRepo`. `git
 * merge-tree --write-tree` exits 0 on a clean merge and 1 with the conflicted
 * paths, a tree on the first line either way. Git also exits 1 when it refuses
 * (an unknown commit), with no tree; that, any other exit, a timeout, or a git
 * older than 2.38 (no --write-tree) is unavailable.
 */
export function mergeCheck(scratch, a, b, { timeout } = {}) {
  const r = runGit(['--git-dir', scratch.gitDir, 'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', a, b], { cwd: scratch.dir, env: scratch.env, timeout });
  const fields = r.stdout.split('\0');
  if ((r.code === 0 || r.code === 1) && OID_RE.test(fields[0])) {
    if (r.code === 0) return { result: 'clean' };
    return { result: 'conflict', paths: [...new Set(fields.slice(1).filter(Boolean))] };
  }
  return { result: 'unavailable', detail: `git merge-tree ${exitText(r)}` };
}

/**
 * Plan order: dependency order, then position — at each turn the earliest
 * subtask whose predecessors are placed. A cycle (which the plan validator
 * refuses) leaves the rest in position order.
 */
export function planOrder(subtasks) {
  const list = (Array.isArray(subtasks) ? subtasks : []).filter((s) => typeof s?.id === 'string');
  const ids = new Set(list.map((s) => s.id));
  const placed = new Set();
  const order = [];
  const ready = (s) => (Array.isArray(s.blocked_by) ? s.blocked_by : []).every((d) => placed.has(d) || !ids.has(d));
  while (order.length < list.length) {
    const next = list.find((s) => !placed.has(s.id) && ready(s)) ?? list.find((s) => !placed.has(s.id));
    placed.add(next.id);
    order.push(next.id);
  }
  return order;
}

/**
 * Every waiting subtask with its commit and its overlap — with the integration
 * branch and with each other waiting subtask — and the advisory merge order;
 * null when nothing waits. `cache` (a Map) keeps the clean and conflict
 * answers across a run's looks, by commit pair and shallow boundary: checked
 * in a scratch, they depend on those only. `budgetMs` bounds the time this
 * look spends on merge-tree; a check past it is unavailable, and the next look
 * tries it again.
 */
export function landingReport({ repoRoot, view, cache = new Map(), env, budgetMs = CHECK_BUDGET_MS }) {
  const macro = view?.macro;
  if (!macro || macro.archived) return null;
  const waiting = waitingToLand(view);
  if (waiting.length === 0) return null;

  const integration = macro.fm?.git_baseline?.branch ?? null;
  const baseRef = typeof integration === 'string' && integration ? `refs/remotes/origin/${integration}` : null;
  const baseCommit = resolveCommit(repoRoot, baseRef, env);
  const order = planOrder(macro.fm?.plan?.subtasks).filter((id) => waiting.some((w) => w.subtaskId === id));
  const position = new Map(order.map((id, i) => [id, i]));
  const entries = waiting
    .map((w) => ({ ...w, commit: resolveCommit(repoRoot, typeof w.branch === 'string' && w.branch ? `refs/heads/${w.branch}` : null, env) }))
    .sort((x, y) => position.get(x.subtaskId) - position.get(y.subtaskId));

  const deadline = Date.now() + budgetMs;
  let layout = null;
  let scratch = null;
  const check = (a, b, missing) => {
    if (!a || !b) return { result: 'unavailable', detail: missing };
    layout ??= repoLayout(repoRoot, env);
    if (layout.error) return { result: 'unavailable', detail: layout.error };
    const boundary = layout.shallow ? createHash('sha256').update(layout.shallow).digest('hex') : 'full';
    const key = `${boundary}:${[a, b].sort().join('..')}`;
    if (cache.has(key)) return cache.get(key);
    const left = deadline - Date.now();
    if (left <= 0) return { result: 'unavailable', detail: `this look's ${Math.round(budgetMs / 1000)} s for overlap checks ran out` };
    scratch ??= scratchRepo(layout, { env, objectFormat: a.length === 64 ? 'sha256' : 'sha1' });
    if (scratch.error) return { result: 'unavailable', detail: scratch.error };
    const answer = mergeCheck(scratch, a, b, { timeout: Math.min(GIT_TIMEOUT_MS, left) });
    if (answer.result !== 'unavailable') cache.set(key, answer);
    return answer;
  };
  const noCommit = (e) => `refs/heads/${e.branch} does not resolve here`;
  const baseMissing = `${baseRef ?? 'the integration branch'} does not resolve here`;
  try {
    for (const e of entries) {
      e.overlap = {
        base: { ref: baseRef, commit: baseCommit, ...check(baseCommit, e.commit, e.commit ? baseMissing : noCommit(e)) },
        pairs: entries.filter((o) => o !== e).map((o) => ({
          subtaskId: o.subtaskId, branch: o.branch, commit: o.commit,
          ...check(e.commit, o.commit, noCommit(e.commit ? o : e)),
        })),
      };
    }
  } finally {
    scratch?.dispose?.();
  }
  // Each conflicting pair: the later one rebases once the first lands.
  const mergeOrder = entries.map((e) => ({
    subtaskId: e.subtaskId,
    branch: e.branch,
    rebaseAfter: e.overlap.pairs
      .filter((p) => p.result === 'conflict' && position.get(p.subtaskId) < position.get(e.subtaskId))
      .map((p) => p.subtaskId),
  }));
  return { integration, base: { ref: baseRef, commit: baseCommit }, entries, mergeOrder };
}

const short = (oid) => (oid ? oid.slice(0, 10) : 'no commit');
const remoteName = (ref) => (ref ? ref.replace(/^refs\/remotes\//, '') : 'the integration branch');

function answer(a) {
  if (a.result === 'conflict') return `conflict${a.paths?.length ? `: ${a.paths.join(', ')}` : ''}`;
  if (a.result === 'unavailable') return `unavailable (${a.detail})`;
  return a.result;
}

/** One line: the overlap with the integration branch, then with each other waiting subtask. */
export function overlapText(overlap) {
  return [
    `${remoteName(overlap.base.ref)} ${answer(overlap.base)}`,
    ...overlap.pairs.map((p) => `${p.subtaskId} (${p.branch}) ${answer(p)}`),
  ].join('; ');
}

/** One line: the merge order, and which branch rebases after which. */
export function orderText(mergeOrder) {
  const rebases = mergeOrder.filter((m) => m.rebaseAfter.length > 0)
    .map((m) => `${m.subtaskId} rebases once ${m.rebaseAfter.join(' and ')} land${m.rebaseAfter.length > 1 ? '' : 's'}`);
  return `${mergeOrder.map((m) => m.subtaskId).join(' → ')}${rebases.length ? ` (advisory; ${rebases.join('; ')})` : ' (advisory)'}`;
}

function snake(a) {
  const out = {};
  for (const [k, v] of Object.entries(a)) out[k === 'subtaskId' ? 'subtask_id' : k] = v;
  return out;
}

function eventRecord({ entry, report, runId, macroId, seq, at }) {
  return {
    event: 'landing-ready',
    at,
    run_id: runId,
    after_seq: seq,
    macro_id: macroId,
    subtask_id: entry.subtaskId,
    engineer_workflow_id: entry.engineerWorkflowId ?? null,
    branch: entry.branch,
    commit: entry.commit,
    integration_branch: report.integration,
    reason: entry.reason,
    detail: entry.detail || null,
    commands: entry.commands,
    note: entry.note ?? null,
    overlap: { base: entry.overlap.base, pairs: entry.overlap.pairs.map(snake) },
    merge_order: report.mergeOrder.map((m) => ({ subtask_id: m.subtaskId, branch: m.branch, rebase_after: m.rebaseAfter })),
  };
}

/**
 * Report each waiting subtask not reported yet, and return the report on
 * every waiting subtask (the awaiting-landing halt lists the same), or null
 * when nothing waits. Run it under the macro lock: the log is the macro's. A
 * failure to read or write the logs is printed and recorded on the report
 * (`publishError`); the report itself still stands.
 *
 * @param a.mainRoot  the main worktree (ledger.mjs `mainWorktreeRoot`)
 * @param a.runDir    this run's ledger directory
 * @param a.seq       the step the look followed (0: the run's start)
 */
export function reportLandingReady({ repoRoot, mainRoot, runDir, runId, seq, view, out, now = () => Date.now(), cache, env, budgetMs }) {
  const report = landingReport({ repoRoot, view, cache, env, budgetMs });
  if (!report) return null;
  report.reported = [];
  try {
    const log = landingLogPath(mainRoot, view.macro.id);
    const reported = new Set(readLandingLog(log).map(eventKey));
    for (const entry of report.entries) {
      if (!entry.commit) continue;
      const record = eventRecord({ entry, report, runId, macroId: view.macro.id, seq, at: new Date(now()).toISOString() });
      const key = eventKey(record);
      if (reported.has(key)) continue;
      out(`◆ landing-ready: ${entry.subtaskId} on ${entry.branch} at ${short(entry.commit)} (${entry.reason === 'no_pr' ? 'no pull request yet' : 'its pull request is not merged'}); the run goes on`);
      out(`    overlap: ${overlapText(entry.overlap)}`);
      out(`    merge order: ${orderText(report.mergeOrder)}`);
      for (const c of entry.commands) out(`    ${c}`);
      if (entry.note) out(`    ${entry.note}`);
      appendLanding(runDir, record);
      // Last: the line in the log is what marks the event reported.
      appendLine(log, JSON.stringify(record));
      reported.add(key);
      report.reported.push(entry.subtaskId);
    }
  } catch (e) {
    report.publishError = e?.message ?? String(e);
    out(`⚠ landing-ready: could not record the report (${report.publishError}); the run goes on, and the next look reports what this one missed`);
  }
  return report;
}
