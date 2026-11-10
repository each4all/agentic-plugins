// plugins/orchestrator/adapters/claude/autopilot/verify-run.mjs
//
// ADR-0068 Decision 5 (verify-exec) — the verification step: the driver runs
// the checks a step requested, and the ones it adds, with no LLM, records each
// result in the workflow through the persona's CLI, and leaves the step that
// follows to the next decision. One batch is one step of the run's step
// ledger, of kind `verify`, with no cost: it takes no reservation, is charged
// nothing and is no step of --max-steps (item 9).
//
// WHAT IT DECIDES (planVerify, pure). From the request and its stored results
// as the persona's record holds them, the driver's own journal
// (verify-journal.mjs) and the lane's tree digest now:
//   - a record the journal does not hold whole: set aside with one
//     `verify-batch-restart`, and the request runs again whole;
//   - a batch the journal started and the record holds open (a driver that
//     died): ended from its trusted results, as the persona's endProblem
//     takes them (the last failed: failed; a timeout, a check that could not
//     start or was refused: no evidence; every check passed: passed; none yet,
//     or a check stopped: cut short by the driver's end), on the tree as it is
//     now (another tree, or one that cannot be read: no evidence);
//   - a batch cut short: taken up again, continuing it (the persona carries
//     its passed results when the tree and the commands are the same, and the
//     batch goes on from its first check that did not pass);
//   - a batch that passed, on the tree it started on: `verify-pass`, which
//     makes the request's `on_pass` the next step; on another tree, or after
//     a batch that failed or gave no evidence: the requesting verb resumes;
//   - a new request whose checks (the driver's additions included) are those
//     of the workflow's last batch the journal ended passed or failed, on the
//     same tree: a repeat, which halts the lane `no-progress` and runs nothing
//     (after a batch with no evidence it runs again whole; the owner's
//     explicit rerun, `--next verify`, runs it once). Amendment of 2026-11-10
//     (C178): when that batch passed whole (it continued none, replayed none,
//     and the journal holds a result for each of its checks) with the same
//     declaration and selection base, its pass is reused: the driver records
//     a batch for the new request whose results are that batch's, runs
//     nothing, and answers it. A pass already reused once is a repeat, and
//     halts; a pass that does not qualify runs again whole;
//   - a request below HIGH (C168): nothing, unless the owner's forced step
//     runs it (its batch's journal start says so, `meta.forced`) or the
//     record's latest batch continues such a batch; then everything above
//     applies as at HIGH, except a record set aside, which ends the owner's
//     authorization and runs nothing.
//
// HOW A CHECK RUNS (item 8). As an argv array, never a shell string: the
// declaration's words with the request's checked arguments, resolved again by
// the driver from its own copy of the declaration (verify-decl.mjs). In the
// lane's checkout, with the environment a worker gets minus the run's
// admission token, its autopilot flag, its step and offer, its state base and
// any heavy-work lock proof, so a check cannot act as a worker of the run. In
// a process group of its own, which only the driver kills: an idle supervisor
// (heavy-run.mjs SUPERVISOR) leads the group and starts the command only once
// the driver has put the group on the run's locks as a worker group of its
// lane (`register`), so a group no lock entry names never runs a check. A
// check whose command does not take the heavy-work lock itself runs through
// the wrapper (`agentic-autopilot heavy`, whose status file says when it holds
// the lock, when its command's own group is ready, and how the command
// ended): that group, too, goes on the run's locks, and the command starts
// only on the driver's go file, written once the holds and the drain are read
// again, so a stop that came while the check waited for the lock runs
// nothing. One that does take the lock itself runs directly and waits inside
// its own timeout. Timeouts: the declared one from the go, the driver's wait
// for the lock 8 hours, a batch 6 hours of running checks; a stop, a timeout
// or the driver's signal sends SIGTERM to the group (the wrapper passes it to
// its command's), then SIGKILL to both. A group that outlives SIGKILL is no
// result: the run halts run-wide, and keeps that group's lock entries.
//
// RECORDS. Every persona write is first a line of the journal, then the write,
// with an environment outside every autopilot run (the driver writes as the
// owner does, never as the step it follows). The batch stops at the first
// check that does not pass; a hold, a drain or the driver's end is read
// before each check, and stops the batch there (or ends the driver's wait for
// the lock), never during a running check, which only the driver's own
// signal stops. Read before the batch's start too, it starts none: the step
// yields (`stopped`) and the request waits. The tree digest is taken as the batch starts and as it ends.
// The failing tests' names are parsed from the check's log (node --test's
// TAP and spec lines), bounded, and reach only the workflow; each check's log
// is under the run's directory, `verify/<batch>/<index>.log`.
//
// TMPDIR (ADR-0068, amendment of 2026-11-10). Each check that runs gets a
// temporary directory of its own under the run's temporary root
// (`job.scratch`, scratch.mjs), outside the lane, made before its spawn and
// removed when it ends, whatever its outcome; one that cannot be made starts
// no check (`not-started`). A check whose group outlived SIGKILL keeps its
// directory, which the run then holds. A reused pass starts no process and
// makes none. The status and go files stay in the run's directory.

import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_BATCH_CHECKS, MAX_BATCH_MUTATE_CASES, MAX_FAILING_TEST_CHARS, MAX_FAILING_TESTS, MAX_RESULTS_BYTES, canonicalJson, caseCount, checksDigest, resolveCheck, sha256, worstCaseBytes,
} from './verify-decl.mjs';
import {
  appendJournal, endPayload, forcedAuthority, isoSeconds, journalPath, lastEnded, passOf, readJournal, recordDigest, resultPayload, resumeFact, startEntry, startPayload, suiteEvidence, untrustedProblem,
} from './verify-journal.mjs';
import { contentProjection } from '../../../scripts/lib/lane-digest.mjs';
import { SUPERVISOR, readSupervisorReport, supervisorEnd } from '../../../scripts/lib/heavy-run.mjs';
import { groupState, holderName, lockPath, readLock, signalGroup as signalLeader } from '../../../scripts/lib/heavy-lock.mjs';
import { verifyCapabilityProblem } from './roots.mjs';
import { VERIFY_DECLARATION_PATH, readDeclarationAt } from './verify-decl.mjs';

// The wrapper's own entry (the autopilot CLI's `heavy`, without the driver).
const HEAVY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'heavy-entry.mjs');

// Item 9: each check its declared timeout, a batch 6 hours of running checks,
// the driver's wait for the heavy-work lock 8 hours. `secondMs` scales a
// declared timeout (a test seam), `killGraceMs` the wait between SIGTERM and
// SIGKILL, `lingerMs` how long a group may take to empty after SIGKILL.
export const BOUNDS = Object.freeze({
  lockWaitMs: 8 * 3600 * 1000, batchMs: 6 * 3600 * 1000, secondMs: 1000, killGraceMs: 5000, lingerMs: 5000, pollMs: 200,
});

// The variables a check never inherits from the worker environment: what
// would make it act as a worker of the run (item 8), or join a holder's
// heavy-work ownership it does not belong to.
export const CHECK_SCRUB = Object.freeze([
  'AGENTIC_AUTOPILOT', 'AGENTIC_AUTOPILOT_TOKEN', 'AGENTIC_AUTOPILOT_STEP', 'AGENTIC_AUTOPILOT_VERIFY', 'AGENTIC_STATE_BASE',
  'AGENTIC_HEAVY_LOCK_PROOF', 'AGENTIC_HEAVY_LOCK_VIA',
]);

/** A worker's environment, scrubbed for a check (item 8). */
export function checkEnvOf(workerEnvironment) {
  const env = { ...workerEnvironment };
  for (const k of CHECK_SCRUB) delete env[k];
  return env;
}

/** The environment of the driver's persona writes: outside every autopilot run, as the owner writes. */
export function personaEnvOf(base) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith('AGENTIC_AUTOPILOT') && k !== 'AGENTIC_STATE_BASE') env[k] = v;
  return env;
}

/**
 * The commit the driver's additions are selected against (item 4, P4): a
 * lane's (and a serial macro child's) fork point from the integration branch,
 * `git merge-base HEAD refs/remotes/origin/<integration>` (the local branch
 * when there is no remote one), and a verb chain's, or one whose fork point
 * cannot be read, the commit its run started from. Computed when the batch is
 * prepared, never from a lane's recorded base, which an integration branch
 * that advanced leaves behind.
 */
export function selectionBase({ lane, integration = null, baseline }) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  if (typeof integration === 'string' && integration !== '') {
    for (const ref of [`refs/remotes/origin/${integration}`, `refs/heads/${integration}`]) {
      const r = spawnSync('git', ['-C', lane, 'merge-base', 'HEAD', ref], { encoding: 'utf8', env, timeout: 30_000 });
      const sha = (r.stdout ?? '').trim();
      if (r.status === 0 && /^[0-9a-f]{40}$/.test(sha)) return sha;
    }
  }
  return baseline;
}

/**
 * The run's offer of verification (item 11), made once at its start: the
 * pinned persona has the capability, and the repository's declaration at the
 * run's baseline parses. `{ offered: true, baseline, declaration }` or
 * `{ offered: false, why, baseline }`. A run that offers none tells its
 * workers nothing, and they check in their steps as before.
 */
export function verifyOfferFor({ roots, repoRoot, baseline }) {
  const cap = verifyCapabilityProblem(roots);
  if (cap) return { offered: false, why: cap, baseline: baseline ?? null };
  const read = readDeclarationAt(repoRoot, baseline);
  if (read.absent) return { offered: false, why: `the repository has no ${VERIFY_DECLARATION_PATH} at the run's baseline ${baseline}`, baseline };
  if (read.problem) return { offered: false, why: read.problem, baseline: baseline ?? null };
  return { offered: true, baseline, declaration: read.declaration };
}

// Every checkout of the repository `from` is in, as `git worktree list` names
// them (lanes.mjs listWorktrees reads the same; this module does not load the
// lanes module and the policy it brings). Throws when git cannot list them.
function worktreePaths(from) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const r = spawnSync('git', ['-C', from, 'worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8', env, timeout: 30_000 });
  if (r.status !== 0) throw new Error(`git worktree list failed in ${from}`);
  return r.stdout.split('\0').filter((f) => f.startsWith('worktree ')).map((f) => f.slice('worktree '.length));
}

/**
 * Whether a run of this repository recorded the step a request names, for
 * this subtask (lib/verify.mjs header: the driver takes the run and step from
 * its own ledger): a `started` line of that seq in that run's steps.jsonl,
 * under one of `roots` (the driver's checkout, the main one) or, when neither
 * holds it, under any checkout of the repository (`worktrees`, git worktree
 * list from the first root's repository): a run launched from a linked
 * checkout keeps its ledger there, and a relaunch from another reads it. A
 * request a worker wrote by hand, naming a step no run took, is refused; so is
 * one whose run's checkout is gone, its ledger with it.
 */
export function requestKnownIn(roots, subtaskId, { worktrees = worktreePaths } = {}) {
  const tried = new Set();
  const recorded = (root, request) => {
    tried.add(root);
    let text;
    try { text = fs.readFileSync(path.join(root, '.agentic-plugins', 'runs', 'autopilot', request.run_id, 'steps.jsonl'), 'utf8'); } catch { return false; }
    for (const line of text.split('\n')) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec?.event === 'started' && rec.seq === request.step && rec.subtask_id === subtaskId && rec.kind !== 'verify') return true;
    }
    return false;
  };
  return (request) => {
    if (typeof request?.run_id !== 'string' || !/^autopilot-\d{8}T\d{6}Z-[0-9a-f]{6}$/.test(request.run_id) || !Number.isInteger(request.step)) return false;
    const first = roots.filter(Boolean);
    if (first.some((root) => recorded(root, request))) return true;
    let all = [];
    try { all = first.length > 0 ? worktrees(first[0]) : []; } catch { all = []; }
    return all.filter((root) => !tried.has(root)).some((root) => recorded(root, request));
  };
}

/** The offer as run.json records it: no declaration text, its digest. */
export const offerRecord = (o) => (o.offered
  ? { offered: true, baseline: o.baseline, declaration_digest: o.declaration.digest, kinds: Object.keys(o.declaration.kinds) }
  : { offered: false, why: o.why, baseline: o.baseline ?? null });

/**
 * What the policy takes from the journal and the lanes' trees (policy.mjs
 * classify, ctx.verify.facts): per subtask, `resume` (the request's batch
 * ended failed or with no evidence, the record and the journal agreeing: the
 * requesting verb) or `guard` (an answered request whose tree changed since
 * the batch passed, or whose answer the journal does not hold: the requesting
 * verb before its on_pass), and, for a pending request, `forced` (C168: the
 * batch of the owner's forced step its latest batch continues, which lets the
 * policy follow a request below HIGH; verify-journal.mjs forcedAuthority).
 * `laneOf(id)` names a lane's checkout (null: the view's own), `treeOf`
 * digests one.
 *
 * Amendment of 2026-11-10 (C178), the commit gate — with `offer` (the run's,
 * offered, its declaration holding a suite kind that resolves) each active
 * child at a commit also gets `suite` (suiteFact): one whose next step is
 * the commit or done, one in a commit phase, and each the owner's forced
 * commit names (`forcedCommit`: a set of subtask ids, or true for every
 * active child). `baseOf(id)` is the lane's selection base now. `baseOf`,
 * `dirtyOf` and `contentOf` may each answer a promise: a run with lanes reads
 * them off its loop (offloop.mjs gateRead), as it does the tree digest, so
 * the workers in flight are supervised meanwhile. A base that cannot be read
 * is no evidence.
 */
export async function verifyFacts({ view, mainRoot, laneOf = () => null, treeOf, offer = null, baseOf = () => null, forcedCommit = null, dirtyOf = laneDirty, contentOf = contentProjection }) {
  const facts = {};
  const suiteArgv = suiteArgvOf(offer);
  const forcedHas = (id) => forcedCommit === true || (forcedCommit instanceof Set && forcedCommit.has(id));
  for (const [id, c] of Object.entries(view?.children ?? {})) {
    if (c?.location !== 'active' || typeof c.workflow_id !== 'string') continue;
    let entries = null;
    try {
      const r = readJournal(journalPath(mainRoot, c.workflow_id));
      if (!r.problem) entries = r.entries;
    } catch {
      entries = null;
    }
    const atCommit = c.next_step?.kind === 'commit' || c.next_step?.kind === 'done' || c.current_phase === 'phase-7-commit' || c.terminal_marker === true;
    if (suiteArgv !== null && (atCommit || forcedHas(id))) {
      let base = null;
      let baseRead = true;
      try { base = await baseOf(id); } catch { baseRead = false; }
      facts[id] = {
        suite: await suiteFact({ entries, root: laneOf(id) ?? view.repoRoot, treeOf, declarationDigest: offer.declaration.digest, base, baseRead, suiteArgv, dirtyOf, contentOf }),
      };
    }
    if (!c.verify) continue;
    // A journal that cannot be read answers nothing for a pending request
    // (the verification step halts on it) and guards an answered one: its
    // on_pass is not taken on a pass the driver cannot check.
    if (entries === null) {
      if (c.next_step && c.next_step.kind !== 'verify' && c.verify.answered_by) {
        facts[id] = { ...facts[id], guard: { batch_id: c.verify.answered_by, verb: c.verb ?? null, why: 'the verify journal cannot be read' } };
      }
      continue;
    }
    if (c.next_step?.kind === 'verify') {
      const r = resumeFact({ summary: c.verify, entries, latestBatchId: c.verify.last_batch ?? null });
      // C168 — the owner's forced step authorized this request's checks below
      // HIGH: the policy then follows its results as at HIGH.
      const f = forcedAuthority(entries, { requestId: c.verify.request_id, batchId: c.verify.last_batch ?? null, subtaskId: id });
      if (r || f) facts[id] = { ...facts[id], ...(r ? { resume: r } : {}), ...(f ? { forced: f } : {}) };
      continue;
    }
    if (!c.verify.answered_by || !c.next_step) continue;
    const p = passOf(entries, c.verify.request_id, c.verify.answered_by);
    const verb = p?.start?.meta?.verb ?? c.verb ?? null;
    if (!p) {
      facts[id] = { ...facts[id], guard: { batch_id: c.verify.answered_by, verb, why: 'its answer is not one this driver wrote' } };
      continue;
    }
    let tree = null;
    try { tree = await treeOf(laneOf(id) ?? view.repoRoot); } catch { tree = null; }
    if (tree !== p.start.payload?.tree_start) facts[id] = { ...facts[id], guard: { batch_id: c.verify.answered_by, verb, why: 'the tree changed after its batch passed' } };
  }
  return facts;
}

// ---------------------------------------------------------------------------
// The commit gate (ADR-0068 Decision 5, amendment of 2026-11-10, C178)

/**
 * The suite's command as the run's declaration resolves it, or null when the
 * run offers no verification, its declaration has no `test-suite` kind, or
 * that kind takes arguments nothing here can give: then there is no gate, and
 * no final suite.
 */
export function suiteArgvOf(offer) {
  if (offer?.offered !== true || !offer.declaration?.kinds?.['test-suite']) return null;
  try { return resolveCheck(offer.declaration, { kind: 'test-suite', args: {} }); } catch { return null; }
}

/**
 * Whether a checkout holds a change git status lists (untracked files
 * included). Throws when git cannot say. No optional lock: the read never
 * refreshes the index, so it takes no index.lock beside a commit worker of
 * that lane, and wakes no parked lane (ADR-0068 Decision 1, item 6).
 */
export function laneDirty(root) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0' };
  const r = spawnSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8', env, timeout: 60_000 });
  if (r.status !== 0) throw new Error(`git status failed in ${root}`);
  return r.stdout.trim() !== '';
}

/**
 * The three reads the gate makes of a lane besides its tree digest, in one
 * call: whether the checkout holds a change, its content without HEAD, and
 * its selection base. Each is null when it cannot be read (the base never
 * is: it falls back to the baseline). A run with lanes runs it off its loop
 * (offloop.mjs gateRead).
 */
export function gateRead({ lane, integration = null, baseline }) {
  let dirty = null;
  try { dirty = laneDirty(lane); } catch { dirty = null; }
  let content = null;
  try { content = contentProjection(lane); } catch { content = null; }
  return { dirty, content, base: selectionBase({ lane, integration, baseline }) };
}

/**
 * What the policy takes for a child at a commit:
 *   ok, batch_id  a batch of the workflow passed the whole suite on the
 *                 lane's tree as it is, with the run's declaration and the
 *                 lane's base (verify-journal.mjs suiteEvidence);
 *   why           what is missing, when it is not ok;
 *   dirty         the checkout holds a change (unreadable: taken as one);
 *   tree, content the lane's tree digest and its content without HEAD
 *                 (lane-digest.mjs contentProjection), null when unreadable;
 *   recovery      the last commit step the driver admitted for the workflow
 *                 was admitted on this content, and the suite's evidence
 *                 holds for the tree it was admitted on, with the run's
 *                 declaration and the lane's base as they are now: an
 *                 interrupted commit may be taken up, though its own commit
 *                 moved HEAD and the digest. Only the moved HEAD is let by:
 *                 a tree that cannot be read now, another declaration or
 *                 another base is no recovery;
 *   resumed       the driver already resumed a verb on this tree to end with
 *                 the final verification.
 */
export async function suiteFact({ entries, root, treeOf, declarationDigest, base, baseRead = true, suiteArgv, dirtyOf = laneDirty, contentOf = contentProjection }) {
  let tree = null;
  try { tree = await treeOf(root); } catch { tree = null; }
  let dirty = true;
  try { dirty = (await dirtyOf(root)) !== false; } catch { dirty = true; }
  let content = null;
  try { content = await contentOf(root); } catch { content = null; }
  if (typeof content !== 'string') content = null;
  const readable = entries !== null && tree !== null && baseRead;
  const ev = readable ? suiteEvidence(entries, { tree, declarationDigest, base, suiteArgv }) : null;
  const admitted = (entries ?? []).filter((e) => e.op === 'commit').at(-1) ?? null;
  // The evidence the commit was admitted with, judged again as it would be
  // now but for the tree: the one the driver recorded at the admission.
  const admittedEv = readable && typeof admitted?.payload?.tree === 'string'
    ? suiteEvidence(entries, { tree: admitted.payload.tree, declarationDigest, base, suiteArgv })
    : null;
  const why = ev ? null
    : entries === null ? 'the verify journal cannot be read'
      : tree === null ? 'the lane\'s tree cannot be read'
        : !baseRead ? 'the lane\'s base cannot be read'
          : 'no verification batch of this workflow passed the whole suite on the lane\'s tree as it is, with the run\'s declaration and the lane\'s base';
  return {
    ok: ev !== null, batch_id: ev?.batch_id ?? null, why, dirty, tree, content,
    recovery: admittedEv !== null && content !== null && typeof admitted?.payload?.content === 'string' && admitted.payload.content === content,
    resumed: (entries ?? []).some((e) => e.op === 'final-resume' && (e.payload?.tree ?? null) === tree),
  };
}

/**
 * The driver's line for a step the gate let through or asked for, written as
 * the step is admitted (before its worker starts): a commit step (`s.suite`,
 * the fact it was decided on) or a verb resumed to end with the final
 * verification (`s.resume === 'final-verify'`, `s.gate`). Any other step
 * writes nothing; nor does the recovery of an interrupted commit taken up on
 * the content of its admission (`s.suite.admitted`): that admission's line
 * stands, with the tree its evidence is for. Throws when the journal cannot be written: the step then
 * does not start.
 */
export function noteGateStep({ mainRoot, workflowId, step, runId, seq, at }) {
  const line = step?.kind === 'commit' && step.suite && step.suite.admitted !== true
    ? { op: 'commit', batch_id: step.suite.batch_id ?? null, payload: { content: step.suite.content ?? null, tree: step.suite.tree ?? null } }
    : step?.kind === 'verb' && step.resume === 'final-verify'
      ? { op: 'final-resume', payload: { tree: step.gate?.tree ?? null, verb: step.verb } }
      : null;
  if (line === null) return false;
  appendJournal(journalPath(mainRoot, workflowId), { ...line, run_id: runId, seq, at });
  return true;
}

// ---------------------------------------------------------------------------
// The decision (pure)

const own = (request, results) => (results?.request_id === request.id && Array.isArray(results.batches) ? results.batches : []);

/**
 * The end of a batch from its results and the tree now (the persona's
 * endProblem accepts exactly these): `cut` the cause that stopped it (stop,
 * hold, drain, driver-end), `bound` whether a batch bound cut its last check.
 */
export function endFor(batch, treeNow, { cut = null, bound = false } = {}) {
  if (treeNow === null) return { tree_end: null, end: 'no-evidence', cause: 'tree-unreadable' };
  if (treeNow !== batch.tree_start) return { tree_end: treeNow, end: 'no-evidence', cause: 'tree-changed' };
  const results = batch.results ?? [];
  const last = results.at(-1) ?? null;
  if (last?.outcome === 'failed') return { tree_end: treeNow, end: 'failed', cause: null };
  if (last?.outcome === 'timeout') return { tree_end: treeNow, end: 'no-evidence', cause: bound ? 'bound' : 'timeout' };
  if (last?.outcome === 'not-started' || last?.outcome === 'refused') return { tree_end: treeNow, end: 'no-evidence', cause: null };
  if (results.length === batch.checks.length && results.every((r) => r.outcome === 'passed')) return { tree_end: treeNow, end: 'passed', cause: null };
  if (bound && (last === null || last.outcome === 'passed')) return { tree_end: treeNow, end: 'no-evidence', cause: 'bound' };
  return { tree_end: treeNow, end: 'cut-short', cause: cut ?? 'driver-end' };
}

/**
 * What the step does (header, WHAT IT DECIDES). `facts`:
 *   pending      the workflow's next step is verify
 *   request      the stored verify_request, results the stored verify_results
 *   entries      the journal's entries for the workflow
 *   treeNow      the lane's tree digest now, or null when it cannot be read
 *   checksDigest the batch's checks digest as the driver resolves them now
 *   verb         the requesting verb as the child records it (for a request no batch has run)
 *   forcedRerun  the owner's explicit rerun (`--next verify`)
 *   declarationDigest, base  the declaration and the selection base a new batch would run with
 * Returns { action: 'none' | 'restart' | 'end' | 'pass' | 'resume' | 'halt' | 'start' | 'reuse', … };
 * `reuse` carries `source`, the passed batch whose results the new batch replays.
 */
export function planVerify({ pending, request, results, entries, treeNow, checksDigest: digest, verb = null, forcedRerun = false, declarationDigest = null, base = null }) {
  if (!pending || !request || typeof request.id !== 'string') return { action: 'none', why: 'no request is pending' };
  const problem = untrustedProblem({ request, results, entries });
  if (problem) return { action: 'restart', why: problem, replaces: results === undefined || results === null ? null : sha256(JSON.stringify(results)) };
  const batches = own(request, results);
  const latest = batches.at(-1) ?? null;
  const requester = (batch) => startEntry(entries, request.id, batch.batch_id)?.meta?.verb ?? verb;
  if (latest && latest.end === undefined) return { action: 'end', batch: latest, end: endFor(latest, treeNow) };
  // The owner's explicit rerun (item 7): a request whose batch ended runs
  // again whole, its record set aside (the persona takes no new batch after
  // one that ended, only a restart).
  if (forcedRerun && latest && latest.end !== 'cut-short') {
    if (treeNow === null) return { action: 'halt', reason: 'owner-choice', detail: 'the lane\'s tree cannot be read, so no batch can be bound to it' };
    return { action: 'restart', why: 'the owner\'s explicit rerun', replaces: sha256(JSON.stringify(results)), prior: latest };
  }
  if (latest) {
    switch (latest.end) {
      case 'passed':
        return treeNow === latest.tree_start
          ? { action: 'pass', batchId: latest.batch_id }
          : { action: 'resume', verb: requester(latest), why: `the tree changed after batch ${latest.batch_id} passed` };
      case 'failed':
      case 'no-evidence':
        return { action: 'resume', verb: requester(latest), why: `batch ${latest.batch_id} ended ${latest.end}` };
      case 'cut-short':
        if (treeNow === null) return { action: 'halt', reason: 'owner-choice', detail: 'the lane\'s tree cannot be read, so the batch cut short cannot be taken up' };
        return { action: 'start', continues: latest.batch_id, prior: latest };
      default:
        return { action: 'halt', reason: 'owner-choice', detail: `batch ${latest.batch_id} ended ${latest.end}, which this driver does not know` };
    }
  }
  if (treeNow === null) return { action: 'halt', reason: 'owner-choice', detail: 'the lane\'s tree cannot be read, so no batch can be bound to it' };
  const before = lastEnded(entries, { excludeRequest: request.id });
  if (!forcedRerun && before && before.checks_digest === digest && before.tree_start === treeNow && (before.end === 'passed' || before.end === 'failed')) {
    const repeat = (how) => ({
      action: 'halt', reason: 'no-progress',
      detail: `the step recorded the checks of batch ${before.batch_id} again (it ${how}) on the tree it ran on: nothing changed, so nothing runs; change the lane, or rerun them once with --next verify`,
    });
    if (before.end === 'failed') return repeat('failed');
    // Amendment of 2026-11-10 (C178) — a pass is evidence for the unchanged
    // tree: it is reused once, when it is whole and was run with the
    // declaration and the base a new batch would run with. A pass that was
    // itself a reuse is a repeat; one that does not qualify runs again.
    // Under another declaration or base the request is no repeat: it runs.
    const sameFooting = typeof declarationDigest === 'string' && before.declaration_digest === declarationDigest && (before.base ?? null) === (base ?? null);
    if (sameFooting && before.reused_from) return repeat('passed, on results already reused once');
    const whole = before.continues === null && before.checks > 0 && before.results.length === before.checks
      && Array.from({ length: before.checks }, (_, i) => before.results[i]).every((r) => r?.outcome === 'passed');
    if (whole && sameFooting && !before.reused_from) {
      return { action: 'reuse', continues: null, prior: null, source: before };
    }
  }
  return { action: 'start', continues: null, prior: null };
}

/**
 * The batch's checks in their order (item 4): the worker's, in its order, and
 * the driver's additions before the worker's first check whose command takes
 * the heavy-work lock itself (a mutation run), else after the last: no
 * mutation run before the tests.
 */
export function orderChecks(worker, additions, decl) {
  const firstSelfLocking = worker.findIndex((c) => decl.kinds[c.kind]?.locks_itself === true);
  if (firstSelfLocking === -1) return [...worker, ...additions];
  return [...worker.slice(0, firstSelfLocking), ...additions, ...worker.slice(firstSelfLocking)];
}

const NAME_LINES = [/^not ok \d+ - (.+?)(?:\s+#.*)?$/, /^\s*✖ (.+?) \(\d+(?:\.\d+)?m?s\)$/];
const SUMMARY = /^(?:failing tests:|tests \d+|suites \d+)$/;

// A name cut to the persona's bound in UTF-16 units, never inside a
// surrogate pair: the persona refuses a name that is not well formed.
function clip(name) {
  let out = '';
  for (const ch of name) {
    if (out.length + ch.length > MAX_FAILING_TEST_CHARS) break;
    out += ch;
  }
  return out;
}

/** The failing tests a check's log names (node --test TAP and spec), bounded: { names, more }. */
export function parseFailingTests(text) {
  const seen = new Set();
  for (const raw of String(text).split(/\r?\n/)) {
    for (const re of NAME_LINES) {
      const m = re.exec(raw);
      if (!m) continue;
      // eslint-disable-next-line no-control-regex
      const name = m[1].replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
      if (name && !SUMMARY.test(name)) seen.add(clip(name));
    }
  }
  const all = [...seen];
  return { names: all.slice(0, MAX_FAILING_TESTS), more: Math.max(0, all.length - MAX_FAILING_TESTS) };
}

// ---------------------------------------------------------------------------
// The persona's CLI

function runNode(script, args, { env, cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((done) => {
    execFile(process.execPath, [script, ...args], { env, cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      done({ code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

// The persona's refusal of a write in a held lane (engineer state.mjs
// laneWriterError, ADR-0068 Decision 2, item 7), as its CLI prints it: a
// batch's start refused for a hold, or for holds that cannot be read.
export const HELD_LANE_REFUSAL = /a write of a held lane's child outside a persona operation is refused/;

function personaCli({ engineerRoot, env, cwd }) {
  const state = path.join(engineerRoot, 'scripts', 'state.mjs');
  return {
    async read(workflowPath) {
      const r = await runNode(state, ['read', '--workflow-path', workflowPath], { env, cwd });
      if (r.code !== 0) throw new Error(`state.mjs read failed: ${r.stderr.trim().slice(-300)}`);
      return JSON.parse(r.stdout);
    },
    async write(command, args) {
      const r = await runNode(state, [command, ...args], { env, cwd });
      if (r.code !== 0) throw new Error(`state.mjs ${command} refused: ${r.stderr.trim().slice(-400)}`);
      return r;
    },
  };
}

// ---------------------------------------------------------------------------
// One check

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const groupAlive = (pgid) => {
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const signalGroup = (pgid, sig) => { try { process.kill(-pgid, sig); } catch { /* gone */ } };

function statusLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

/** The process group of `pid` on this machine, or null when it cannot be read. */
export function groupOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      // The fields after the command name (in parentheses, any byte): the
      // state, the parent, then the group.
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const g = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
      return Number.isInteger(g) && g > 0 ? g : null;
    } catch {
      return null;
    }
  }
  const r = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const g = r.status === 0 ? Number(r.stdout.trim()) : NaN;
  return Number.isInteger(g) && g > 0 ? g : null;
}

/**
 * The holder a check's lock wait names: the lock's record, or null when there
 * is none, or when it is the check's own wrapper (a process of its group
 * `pgid` on this machine). The wrapper writes its status line only after it
 * takes the lock, so a lock read after a status read that found no
 * acquisition can be its own.
 */
export function waitHolder(file, pgid) {
  let rec = null;
  try { rec = readLock(file)?.record ?? null; } catch { return null; }
  if (rec === null) return null;
  if (rec.host === os.hostname() && groupOf(rec.pid) === pgid) return null;
  return rec;
}

/**
 * Run one check to its end: resolves { outcome, exit, signal, durationMs,
 * runMs, lingering, bound }. `ctl` is the batch's control: `stopCause()` (a
 * hold, a drain or a stop ends the wait for the lock), `aborted()` (the
 * driver's signal: the group is killed), `register(group)` (puts the group on
 * the run's locks; a throw kills it, and nothing ran), `waiting(holder)`.
 */
async function runCheck({ check, lane, env, baseline, logFile, statusFile, goFile, label, deadlineMs, ctl, bounds }) {
  const viaWrapper = check.locks_itself !== true;
  const command = viaWrapper
    ? [process.execPath, HEAVY, '--repo', lane, '--declaration-ref', baseline, '--purpose', label, '--status-file', statusFile, '--go-file', goFile, '--', ...check.argv]
    : check.argv;
  const logFd = fs.openSync(logFile, 'a');
  let sup;
  const t0 = Date.now();
  try {
    sup = spawn(process.execPath, ['-e', SUPERVISOR, '--', JSON.stringify(command)], {
      cwd: lane, env, detached: true, stdio: ['pipe', logFd, logFd, 'pipe'],
    });
  } catch (e) {
    fs.closeSync(logFd);
    return { outcome: 'not-started', exit: null, signal: null, durationMs: 0, runMs: 0, detail: e.message };
  }
  fs.closeSync(logFd);
  let report = '';
  sup.stdio[3]?.setEncoding('utf8');
  sup.stdio[3]?.on('data', (c) => { report += c; });
  sup.stdin.on('error', () => {});
  let closeOf = null;
  const closed = new Promise((r) => { sup.on('close', (code, signal) => { closeOf = { code, signal }; r(); }); sup.on('error', () => r()); });
  if (!Number.isInteger(sup.pid)) {
    await closed;
    return { outcome: 'not-started', exit: null, signal: null, durationMs: 0, runMs: 0, detail: 'no pid' };
  }
  const pgid = sup.pid;
  let entries = [];
  try {
    entries = await ctl.register({ pid: sup.pid, pgid });
  } catch (e) {
    signalGroup(pgid, 'SIGKILL');
    await Promise.race([closed, sleep(bounds.lingerMs)]);
    return { outcome: 'not-started', exit: null, signal: null, durationMs: Date.now() - t0, runMs: 0, lingering: groupAlive(pgid), pgid, detail: `the check's group could not be put on the run's locks (${e?.message ?? e})` };
  }
  // A hold, a drain or the driver's signal that came while the group was put
  // on the locks stops it before its command starts.
  if (ctl.stopCause() || ctl.aborted()) {
    signalGroup(pgid, 'SIGKILL');
    await Promise.race([closed, sleep(bounds.lingerMs)]);
    const lingering = groupAlive(pgid);
    if (!lingering) for (const e of entries) { try { e.release(); } catch { /* released meanwhile */ } }
    return { outcome: 'stopped', exit: null, signal: null, durationMs: Date.now() - t0, runMs: 0, lingering, pgid };
  }
  sup.stdin.write('go\n');
  const goAt = Date.now();
  // When the command got its go: at once for one run directly; through the
  // wrapper, once it holds the lock and the driver has put the command's own
  // group (`inner`, from its ready line) on the run's locks and found no stop.
  let acquiredAt = viaWrapper ? null : goAt;
  let inner = null;
  let saidAcquired = false;
  let unregistered = null;
  let killed = null; // 'timeout' | 'bound' | 'stopped' | 'aborted' | 'unregistered'
  let killedAt = null; // when SIGKILL went
  let ended = false;
  closed.then(() => { ended = true; });
  // The command's own group is the wrapper's to stop; SIGKILL reaches it from
  // here too, so a wrapper that dies, or a supervisor that stopped, leaves no
  // check running. Its leader's start keeps a kill off a group that took its id.
  const innerAlive = () => inner !== null && groupState(inner.pgid, inner.started) === 'running';
  const killAll = () => {
    signalGroup(pgid, 'SIGKILL');
    if (inner !== null) signalLeader(inner.pgid, inner.started, 'SIGKILL');
  };
  const kill = async (why) => {
    if (killed !== null) return;
    killed = why;
    signalGroup(pgid, 'SIGTERM');
    const until = Date.now() + bounds.killGraceMs;
    while (!ended && Date.now() < until) await sleep(Math.min(bounds.pollMs, 50));
    killAll();
    killedAt = Date.now();
  };
  // The wrapper is ready: the driver reads its stops, puts the command's group
  // on the run's locks, reads them again, and only then gives the go (item 9:
  // a hold or a drain ends the wait for the lock, the acquisition included).
  const onReady = async (ready) => {
    if (!Number.isInteger(ready.pgid) || ready.pgid <= 1) {
      unregistered = 'the wrapper reported no group for its command';
      return kill('unregistered');
    }
    inner = { pgid: ready.pgid, started: typeof ready.started === 'string' ? ready.started : null };
    if (ctl.stopCause()) return kill('stopped');
    if (ctl.aborted()) return kill('aborted');
    try {
      entries = [...entries, ...await ctl.register({ pid: inner.pgid, pgid: inner.pgid })];
    } catch (e) {
      unregistered = `the check's command group could not be put on the run's locks (${e?.message ?? e})`;
      return kill('unregistered');
    }
    if (ctl.stopCause()) return kill('stopped');
    if (ctl.aborted()) return kill('aborted');
    fs.writeFileSync(goFile, 'go\n');
    acquiredAt = Date.now();
    return undefined;
  };
  let saidWaiting = false;
  // Any throw in the supervision below still kills the group and leaves the
  // run's locks to the check only while it lives: none is left unsupervised.
  try {
  while (!ended) {
    // A supervisor that outlives SIGKILL (uninterruptible I/O) ends the wait:
    // it is judged lingering below, never waited for without bound.
    if (killedAt !== null && Date.now() - killedAt >= bounds.lingerMs) break;
    if (acquiredAt === null && killed === null) {
      const st = statusLines(statusFile);
      if (!saidAcquired && st.some((x) => x.state === 'acquired')) {
        saidAcquired = true;
        ctl.waiting(null);
      }
      const ready = st.find((x) => x.state === 'ready');
      if (ready) await onReady(ready);
      else {
        if (!saidAcquired && !saidWaiting && Date.now() - goAt > 1000) {
          const rec = waitHolder(lockPath(lane), pgid);
          if (rec) { saidWaiting = true; ctl.waiting({ holder: holderName(rec), pid: rec.pid, worktree: rec.worktree ?? null }); }
        }
        // Item 9: a hold or a drain ends the driver's wait for the lock; the
        // bound holds the whole wait for the go, the wrapper's ready line
        // included, so a ready that never comes never waits without end.
        if (ctl.stopCause()) await kill('stopped');
        else if (Date.now() - goAt >= bounds.lockWaitMs) await kill('bound');
      }
    }
    if (ctl.aborted()) await kill('aborted');
    if (acquiredAt !== null && killed === null) {
      const ran = Date.now() - acquiredAt;
      if (ran >= deadlineMs.declared) await kill('timeout');
      else if (ran >= deadlineMs.batchLeft) await kill('bound');
    }
    if (!ended) await sleep(bounds.pollMs);
  }
  } catch (e) {
    killAll();
    await Promise.race([closed, sleep(bounds.lingerMs)]);
    const until = Date.now() + bounds.lingerMs;
    while ((groupAlive(pgid) || innerAlive()) && Date.now() < until) await sleep(20);
    if (!groupAlive(pgid) && !innerAlive()) for (const x of entries) { try { x.release(); } catch { /* released meanwhile */ } }
    // A group that outlived SIGKILL rides on the error: the run halts on it
    // run-wide and keeps its lock entries, as after a check that ended.
    else {
      const err = e instanceof Error ? e : new Error(String(e));
      err.lingering = groupAlive(pgid) ? pgid : inner.pgid;
      throw err;
    }
    throw e;
  }
  await Promise.race([closed, sleep(bounds.lingerMs)]);
  // What is left of the groups ends with the check, the command's own group
  // included; one that outlives SIGKILL is no result (header), and keeps the
  // run's lock entries.
  let lingering = false;
  let lingeringPgid = pgid;
  if (groupAlive(pgid) || innerAlive()) {
    killAll();
    const until = Date.now() + bounds.lingerMs;
    while ((groupAlive(pgid) || innerAlive()) && Date.now() < until) await sleep(20);
    lingering = groupAlive(pgid) || innerAlive();
    if (lingering && !groupAlive(pgid)) lingeringPgid = inner.pgid;
  }
  if (!lingering) for (const e of entries) { try { e.release(); } catch { /* released meanwhile */ } }
  const durationMs = Date.now() - t0;
  const runMs = acquiredAt === null ? 0 : Date.now() - acquiredAt;
  const base = { durationMs, runMs, lingering, pgid: lingeringPgid };
  // How the command's supervisor ended (C169), whatever ended the check: the
  // wrapper's ended line, or for a command run directly its own close and fd 3.
  // It rides beside the result, for the driver's journal only.
  const endLine = viaWrapper ? statusLines(statusFile).find((x) => x.state === 'ended') ?? null : null;
  const s = endLine?.supervisor;
  const supervisor = viaWrapper
    ? (s !== null && typeof s === 'object' && !Array.isArray(s) ? s : null)
    : (closeOf === null ? null : supervisorEnd(closeOf, report));
  if (supervisor !== null) base.supervisor = supervisor;
  if (killed === 'unregistered') return { ...base, outcome: 'not-started', exit: null, signal: null, detail: unregistered };
  if (killed === 'timeout') return { ...base, outcome: 'timeout', exit: null, signal: null };
  if (killed === 'bound') return { ...base, outcome: 'timeout', exit: null, signal: null, bound: true };
  if (killed === 'stopped' || killed === 'aborted') return { ...base, outcome: 'stopped', exit: null, signal: null };
  // How the command ended: the wrapper's status file, or the supervisor's
  // report for a command run directly.
  const end = viaWrapper ? endLine : readSupervisorReport(report).report;
  if (!end) return { ...base, outcome: 'not-started', exit: null, signal: null };
  if (end.refused !== undefined) return { ...base, outcome: 'refused', exit: null, signal: null, detail: end.refused };
  if (end.error !== undefined) return { ...base, outcome: 'not-started', exit: null, signal: null, detail: end.error };
  if (end.stopped !== undefined) return { ...base, outcome: 'stopped', exit: null, signal: null };
  if (Number.isInteger(end.code)) return { ...base, outcome: end.code === 0 ? 'passed' : 'failed', exit: Math.min(255, end.code), signal: null };
  if (typeof end.signal === 'string') return { ...base, outcome: 'failed', exit: null, signal: end.signal };
  return { ...base, outcome: 'not-started', exit: null, signal: null };
}

// ---------------------------------------------------------------------------
// The step

const idOf = (runId, seq) => `${runId}-s${seq}-${randomBytes(3).toString('hex')}`;

function readTail(file, max = 1024 * 1024) {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(st.size, max);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Run one verification step. Resolves (never rejects) to
 *   { outcome: 'ran' | 'resume' | 'passed-before' | 'none' | 'stopped' | 'halt' | 'error', … }
 * (`stopped`: a hold, a drain or the driver's end, its `cause`, came before
 * the batch started, and nothing ran; `refusal` true when only the persona's
 * held-lane refusal named it, no read of the driver's) with `batch` (id, end, cause, checks run), `follow` (what the next decision
 * takes: on_pass, the requesting verb, or nothing), `halt` ({reason, detail}),
 * `lingering` (a check group that outlived SIGKILL), `wrote` (whether any
 * persona write was made).
 *
 * @param o.job  { runId, seq, runDir, mainRoot, workflowPath, workflowId, lane, engineerRoot, offer: {baseline, declaration},
 *                 base (the selection base commit), verb (the child's active verb), forcedRerun, checkEnv, personaEnv }
 * @param o.register  async (group) => [{release}]: the group on the run's locks
 * @param o.stopCause () => null | 'stop' | 'hold' | 'drain'
 * @param o.onWait    (null | {holder, pid, worktree}) => void
 * @param o.ops       { treeDigest: async (lane) => hex, select: async ({lane, base, requested, declaration}) => selection }:
 *                    verify-ops.mjs's DEFAULT_OPS in a serial run, off the loop with lanes
 */
export function startVerify({ job, register, stopCause = () => null, onWait = () => {}, ops, bounds = BOUNDS, now = () => Date.now() }) {
  let abortedBy = null;
  const ctlBase = { stopCause, aborted: () => abortedBy !== null, register, waiting: onWait };
  const done = runStep({ job, ctl: ctlBase, ops, bounds: { ...BOUNDS, ...bounds }, now, abortedBy: () => abortedBy })
    .catch((e) => ({ outcome: 'error', detail: String(e?.message ?? e).slice(0, 500), wrote: true, ...(Number.isInteger(e?.lingering) ? { lingering: e.lingering } : {}) }));
  return {
    done,
    abort(why = 'interrupted') { abortedBy ??= why; },
  };
}

async function runStep({ job, ctl, ops, bounds, now, abortedBy }) {
  const persona = personaCli({ engineerRoot: job.engineerRoot, env: job.personaEnv, cwd: job.lane });
  const decl = job.offer.declaration;
  const journal = journalPath(job.mainRoot, job.workflowId);
  const iso = () => isoSeconds(now());
  const fm = await persona.read(job.workflowPath);
  const request = fm.verify_request;
  const pending = fm.next_step_kind === 'verify';
  if (!pending || !request) return { outcome: 'none', detail: 'no request is pending on the workflow', wrote: false };
  const read = readJournal(journal);
  if (read.problem) return { outcome: 'halt', halt: { reason: 'owner-choice', detail: read.problem }, wrote: false };
  let entries = read.entries;
  let treeNow = null;
  try { treeNow = await ops.treeDigest(job.lane); } catch { treeNow = null; }

  // The request's provenance (lib/verify.mjs header): the step it names is
  // one a run of this repository recorded for this subtask, as the driver's
  // own ledger says, never the record's word.
  if (typeof job.requestKnown === 'function' && !job.requestKnown(request)) {
    return { outcome: 'halt', halt: { reason: 'owner-choice', detail: `the request names step ${request.step} of run ${request.run_id}, which no run of this repository recorded for this subtask; nothing ran` }, wrote: false };
  }
  let wrote = false;
  const write = async (op, command, args, entry) => {
    appendJournal(journal, { op, request_id: request.id, run_id: job.runId, seq: job.seq, at: iso(), ...entry });
    entries = [...entries, { v: 1, op, request_id: request.id, ...entry }];
    wrote = true;
    await persona.write(command, ['--workflow-path', job.workflowPath, '--host', 'claude', '--request-id', request.id, ...args]);
  };
  // The driver's own decision that the requesting verb follows (no persona
  // write): what the policy's resumeFact reads, bound to the record it was
  // decided on (`stored`, the workflow's front matter as the step read it after
  // its last write), which the step has judged whole.
  const noteResume = (batchId, verb, stored) => {
    if (!batchId || !verb) return;
    const payload = { verb, record_digest: recordDigest(stored.verify_request, stored.verify_results) };
    appendJournal(journal, { op: 'resume', request_id: request.id, batch_id: batchId, payload, run_id: job.runId, seq: job.seq, at: iso() });
    entries = [...entries, { v: 1, op: 'resume', request_id: request.id, batch_id: batchId, payload }];
  };
  const inputFile = (dir, name, value) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, `${JSON.stringify(value)}\n`);
    return f;
  };
  // C168 (ADR-0068 implementation note 2026-11-03) — below HIGH, the checks
  // run only on the owner's word: the owner's forced step itself, or a step
  // its authorization covers (the record's latest batch continues, through
  // the journal's starts, a batch the forced step started). Any other step
  // runs nothing; the policy halts such a request before it gets here.
  const below = fm.next_step_confidence !== 'HIGH';
  const ownerForced = job.forced === true;
  if (below && !ownerForced) {
    const latest = own(request, fm.verify_results).at(-1)?.batch_id ?? null;
    if (forcedAuthority(entries, { requestId: request.id, batchId: latest, subtaskId: job.subtaskId ?? null }) === null) {
      return { outcome: 'halt', halt: { reason: 'low-confidence', detail: `the request is ${fm.next_step_confidence ?? 'not'} HIGH and the owner's forced step did not start a batch of it; nothing ran` }, wrote: false };
    }
  }

  // What the record and the journal say first, before any batch is prepared:
  // a batch a dead driver left open is ended, and one that ended is followed,
  // whatever a newer declaration or selection would make of a new batch.
  // Every plan, the one made after an open batch is ended included (the
  // record is read again there, and an edit that came meanwhile can make it a
  // restart), is held to the authorization's end: below HIGH, a step that is
  // not the owner's never sets the record aside (which ends the
  // authorization) and never starts a batch that continues none.
  const replan = (digest) => {
    const p = planVerify({ pending, request, results: fm.verify_results, entries, treeNow, checksDigest: digest, verb: job.verb, forcedRerun: job.forcedRerun === true, declarationDigest: decl.digest, base: job.base ?? null });
    if (!below || ownerForced) return p;
    if (p.action === 'restart') {
      return { action: 'halt', reason: 'low-confidence', detail: `the request's record is set aside (${p.why}), which ends the owner's authorization of it below HIGH; nothing ran. Rerun it with --next verify` };
    }
    if ((p.action === 'start' && !p.continues) || p.action === 'reuse') {
      return { action: 'halt', reason: 'low-confidence', detail: 'a new batch of a request below HIGH starts only on the owner\'s forced step; nothing ran. Run it with --next verify' };
    }
    return p;
  };
  let plan = replan(null);
  if (plan.action === 'end') {
    const dir = path.join(job.runDir, 'verify', plan.batch.batch_id);
    fs.mkdirSync(dir, { recursive: true });
    const payload = endPayload({ treeEnd: plan.end.tree_end, end: plan.end.end, cause: plan.end.cause, endedAt: iso() });
    await write('end', 'verify-batch-end', ['--batch-id', plan.batch.batch_id, '--input-file', inputFile(dir, 'end.json', payload)], { batch_id: plan.batch.batch_id, payload });
    const again = await persona.read(job.workflowPath);
    if (again.next_step_kind !== 'verify' || again.verify_request?.id !== request.id) return { outcome: 'none', detail: 'the request was replaced while its batch was ended', wrote };
    fm.verify_request = again.verify_request;
    fm.verify_results = again.verify_results;
    plan = replan(null);
    // ADR-0068 Decision 7, item 5 — the batch is ended, and what is left of
    // it is a request not running, which a pending instruction with a step
    // replaces: the step gives the lane back (its next boundary applies the
    // instruction) rather than continue the batch. A note alone leaves it,
    // and the batch continues.
    if (plan.action === 'start' && typeof job.yieldsToInstruction === 'function' && job.yieldsToInstruction()) {
      return {
        outcome: 'none', detail: `batch ${plan.continues} was ended ${payload.end}; a pending instruction with a next step replaces what is left of it (ADR-0068 Decision 7, item 5)`,
        batch: { batch_id: plan.continues, end: payload.end, cause: payload.cause, checks: [] }, wrote,
      };
    }
  }
  if (plan.action === 'none') return { outcome: 'none', detail: plan.why, wrote };
  if (plan.action === 'halt') return { outcome: 'halt', halt: { reason: plan.reason, detail: plan.detail }, wrote };
  if (plan.action === 'resume') {
    noteResume(own(request, fm.verify_results).at(-1)?.batch_id, plan.verb, fm);
    return { outcome: 'resume', follow: { kind: 'verb', verb: plan.verb }, detail: plan.why, wrote };
  }
  if (plan.action === 'pass') {
    await write('pass', 'verify-pass', ['--batch-id', plan.batchId], { batch_id: plan.batchId, payload: null });
    return { outcome: 'passed-before', follow: { kind: 'on_pass' }, batch: { batch_id: plan.batchId, end: 'passed' }, wrote };
  }

  // The batch's checks as the driver resolves them now (P15: what does not
  // resolve, or does not fit, refuses the batch before anything runs).
  let checks;
  let selection = null;
  try {
    const worker = request.checks.map((c) => ({ ...c, origin: 'worker' }));
    // Amendment of 2026-11-10 (C178) — a request whose on_pass is a verb is
    // intermediate: its batch leaves the large tests to the final run. One
    // whose on_pass is the commit (or done) is final: its batch holds the
    // whole suite once, the worker's or the driver's, in place of the test
    // files the driver would add, when the declaration has the suite kind.
    const final = request.on_pass?.kind !== 'verb';
    selection = await ops.select({ lane: job.lane, base: job.base, requested: request.checks, declaration: decl, deferLarge: !final });
    let additions = selection.additions.map((c) => ({ ...c, origin: 'driver' }));
    if (final && decl.kinds['test-suite']) {
      additions = additions.filter((c) => c.kind !== 'test' && c.kind !== 'test-suite');
      if (!worker.some((c) => c.kind === 'test-suite')) additions.push({ kind: 'test-suite', args: {}, origin: 'driver' });
    }
    // The batch's cap on mutation cases, the worker's and the driver's
    // together: a cost ceiling, refused before anything runs.
    const cases = caseCount(decl, [...worker, ...additions]);
    if (cases > MAX_BATCH_MUTATE_CASES) throw new Error(`the batch names ${cases} mutation case ids, more than the ${MAX_BATCH_MUTATE_CASES} one batch runs; ask for the cases of the gate or fail-closed code the change touches`);
    const resolveAll = (list) => list.map((c) => {
      const argv = resolveCheck(decl, { kind: c.kind, args: c.args ?? {} }, { tree: job.lane });
      const k = decl.kinds[c.kind];
      return { kind: c.kind, origin: c.origin, argv, timeout_s: k.timeout_s, locks_itself: k.locks_itself };
    });
    checks = resolveAll(orderChecks(worker, additions, decl));
    if (checks.length > MAX_BATCH_CHECKS && decl.kinds['test-suite']) {
      additions = [...additions.filter((c) => c.kind !== 'test'), ...(additions.some((c) => c.kind === 'test') ? [{ kind: 'test-suite', args: {}, origin: 'driver' }] : [])];
      checks = resolveAll(orderChecks(worker, additions, decl));
    }
    if (checks.length > MAX_BATCH_CHECKS) throw new Error(`the batch would run ${checks.length} checks, more than the ${MAX_BATCH_CHECKS} a batch runs`);
    const kept = { v: 1, request_id: request.id, batches: [] };
    const probe = startPayload({ batchId: 'x'.repeat(64), runId: job.runId, continues: 'x'.repeat(64), treeStart: 'f'.repeat(64), declarationCommit: job.offer.baseline, declarationDigest: decl.digest, checks, checksDigest: 'f'.repeat(64), startedAt: iso() });
    const ended = own(request, fm.verify_results).filter((b) => b.end !== undefined).slice(-1);
    if (worstCaseBytes({ ...kept, batches: ended }, probe) > MAX_RESULTS_BYTES && additions.some((c) => c.kind === 'test') && decl.kinds['test-suite']) {
      additions = [...additions.filter((c) => c.kind !== 'test'), { kind: 'test-suite', args: {}, origin: 'driver' }];
      checks = resolveAll(orderChecks(worker, additions, decl));
    }
    const sized = { ...probe, checks: checks.map((c, i) => ({ index: i, kind: c.kind, origin: c.origin, argv: c.argv })) };
    if (worstCaseBytes({ ...kept, batches: ended }, sized) > MAX_RESULTS_BYTES) {
      throw new Error(`the batch's results could take more than the ${MAX_RESULTS_BYTES} bytes a workflow keeps; ask for fewer checks`);
    }
  } catch (e) {
    return { outcome: 'halt', halt: { reason: 'owner-choice', detail: `the requested checks cannot be run (${String(e?.message ?? e).slice(0, 300)}); nothing ran` }, refused: true, wrote };
  }
  const digest = checksDigest(checks.map((c) => c.argv));
  // A new request is judged against the repeat rule with its checks known.
  if (plan.action === 'start' && plan.prior === null) {
    plan = replan(digest);
    if (plan.action === 'halt') return { outcome: 'halt', halt: { reason: plan.reason, detail: plan.detail }, wrote };
  }

  // A batch: started, restarted or continued.
  const batchId = idOf(job.runId, job.seq);
  const dir = path.join(job.runDir, 'verify', batchId);
  fs.mkdirSync(dir, { recursive: true });
  const restart = plan.action === 'restart';
  const continues = restart ? null : plan.continues ?? null;
  // A reuse (planVerify): the batch replays its source's passed results. A
  // batch that continues a replay cut short runs what is left, and keeps the
  // marker, so its pass is never reused in turn.
  const reuse = plan.action === 'reuse' ? plan.source : null;
  const reusedFrom = reuse
    ? { request_id: reuse.request_id, batch_id: reuse.batch_id }
    : (plan.prior ? startEntry(entries, request.id, plan.prior.batch_id)?.meta?.reused_from ?? null : null);
  const start = startPayload({
    batchId, runId: job.runId, continues, treeStart: treeNow, declarationCommit: job.offer.baseline, declarationDigest: decl.digest,
    checks, checksDigest: digest, startedAt: iso(),
  });
  if (restart && treeNow === null) return { outcome: 'halt', halt: { reason: 'owner-choice', detail: 'the lane\'s tree cannot be read, so no batch can be bound to it' }, wrote };
  // `forced`: the owner's forced step started this batch (C168), which
  // authorizes the request's checks below HIGH (forcedAuthority).
  const meta = {
    verb: (plan.prior ? startEntry(entries, request.id, plan.prior.batch_id)?.meta?.verb : null) ?? job.verb, base: job.base, checks_digest: digest, subtask_id: job.subtaskId ?? null,
    ...(ownerForced ? { forced: true } : {}),
    ...(reusedFrom ? { reused_from: reusedFrom } : {}),
  };
  // A hold, a drain or the driver's end that came while the batch was
  // prepared starts none: the step yields, writing nothing more, and the
  // request waits (the persona refuses a batch's start in a held lane). One
  // that comes between this read and the persona's own is read again after
  // the refusal, and taken from the refusal itself when the hold is gone by
  // then (withdrawn, or released). The cause rides on the result, so the
  // settle never parks the lane for it, whether or not the hold is still set.
  const stopNow = () => (abortedBy() ? 'driver-end' : ctl.stopCause());
  // `refusal`: only the persona's refusal named the hold, no read of the
  // driver's saw it (the settle bounds such yields; one the driver saw is the
  // owner's hold, however often it comes).
  const yielded = (cause, refusal = false) => ({ outcome: 'stopped', cause, refusal, detail: `a ${cause === 'driver-end' ? 'stop of the driver' : cause} came before the batch started; nothing ran`, wrote });
  const before = stopNow();
  if (before) return yielded(before);
  // ADR-0068 Decision 7, item 5 — a request not running is replaced by an
  // instruction's step, and a batch is running only once its start is
  // recorded (item 3). The admission's recheck (II16) came before this
  // preparation awaited the record, the tree and the selection: an
  // instruction with a step the owner wrote meanwhile starts no batch either
  // (impl-instruct critique 10 F1). The step writes nothing more and gives
  // the lane back, and the next pass applies the instruction, whose step
  // replaces the request. Nothing is awaited from here to the start's write.
  // The driver's hook answers each record once, so an instruction a pass
  // leaves pending costs one turn, never a loop; `instruction` tells the
  // settle so, which then counts no step that changed nothing (each such
  // yield takes an owner's write).
  if (typeof job.instructionWrittenSince === 'function' && job.instructionWrittenSince()) {
    return { outcome: 'none', instruction: true, detail: 'an instruction with a next step was written while the batch was prepared; its step replaces the request, and no batch started (ADR-0068 Decision 7, item 5)', wrote };
  }
  try {
    if (restart) {
      await write('restart', 'verify-batch-restart', ['--replaces', plan.replaces ?? 'none', '--input-file', inputFile(dir, 'start.json', start)], { batch_id: batchId, payload: start, replaces: plan.replaces, meta });
    } else {
      await write('start', 'verify-batch-start', ['--input-file', inputFile(dir, 'start.json', start)], { batch_id: batchId, payload: start, meta });
    }
  } catch (e) {
    const seen = stopNow();
    const cause = seen ?? (HELD_LANE_REFUSAL.test(String(e?.message ?? '')) ? 'hold' : null);
    if (cause) return yielded(cause, seen === null);
    throw e;
  }
  // What the persona carried into a continuation (the same tree and commands).
  const after = await persona.read(job.workflowPath);
  const stored = own(after.verify_request ?? request, after.verify_results).find((b) => b.batch_id === batchId);
  if (!stored) throw new Error(`batch ${batchId} is not recorded after its start`);
  const results = [...stored.results];
  if (results.some((r) => r.carried_from && untrustedProblem({ request, results: { request_id: request.id, batches: [{ ...stored, results }] }, entries }) !== null)) {
    throw new Error(`batch ${batchId} carries results this driver did not record`);
  }
  const ran = [];
  let cut = null;
  let bound = false;
  let lingering = null;
  let batchUsedMs = 0;
  for (let i = results.length; i < checks.length; i += 1) {
    const cause = abortedBy() ? 'driver-end' : ctl.stopCause();
    if (cause) { cut = cause; break; }
    if (batchUsedMs >= bounds.batchMs) { bound = true; break; }
    const check = checks[i];
    const logRel = `verify/${batchId}/${i}.log`;
    if (reuse) {
      // No process starts: the source's result, under this batch, its log a
      // pointer to the source's (a result's log is relative to its own run).
      const src = reuse.results[i];
      const srcLog = typeof reuse.run_id === 'string' && typeof src.log === 'string' ? path.join(path.dirname(job.runDir), reuse.run_id, src.log) : null;
      fs.writeFileSync(path.join(job.runDir, logRel), `reused: this check passed in batch ${reuse.batch_id} of request ${reuse.request_id}, on this tree, with this declaration and base; it did not run again.\nits log: ${srcLog ?? 'not recorded'}\n`);
      const payload = resultPayload({ index: i, outcome: 'passed', exit: 0, signal: null, durationMs: src.duration_ms ?? 0, log: logRel, endedAt: iso() });
      await write('result', 'verify-result', ['--batch-id', batchId, '--input-file', inputFile(dir, `result-${i}.json`, payload)], { batch_id: batchId, index: i, payload });
      results.push(payload);
      ran.push({ index: i, kind: check.kind, origin: check.origin, outcome: 'passed', duration_ms: 0, reused: true });
      continue;
    }
    // The check's own TMPDIR. A removal's failure is the run's to count,
    // never the check's result.
    const tmpDir = job.scratch ? job.scratch.checkDir(job.seq, i) : null;
    let r;
    let made = false;
    try {
      if (tmpDir) { job.scratch.make(tmpDir); made = true; }
    } catch (e) {
      r = { outcome: 'not-started', exit: null, signal: null, durationMs: 0, runMs: 0, detail: `the check's temporary directory could not be made (${e?.message ?? e})` };
    }
    try {
      r ??= await runCheck({
        check, lane: job.lane, env: tmpDir ? { ...job.checkEnv, TMPDIR: tmpDir } : job.checkEnv, baseline: job.offer.baseline,
        logFile: path.join(job.runDir, logRel), statusFile: path.join(dir, `${i}.status`), goFile: path.join(dir, `${i}.go`), label: `verify ${batchId} #${i} ${check.kind}`,
        deadlineMs: { declared: check.timeout_s * bounds.secondMs, batchLeft: bounds.batchMs - batchUsedMs }, ctl, bounds,
      });
    } catch (e) {
      // A supervision that threw: a group that outlived SIGKILL rides on the
      // error, and keeps the directory.
      if (made) { try { job.scratch.release(tmpDir, Number.isInteger(e?.lingering) ? 'the check\'s process group outlived SIGKILL' : null); } catch { /* counted by the run */ } }
      throw e;
    }
    if (made) { try { job.scratch.release(tmpDir, r.lingering ? 'the check\'s process group outlived SIGKILL' : null); } catch { /* counted by the run */ } }
    batchUsedMs += r.runMs;
    if (r.lingering) { lingering = r.pgid; }
    const failing = r.outcome === 'failed' ? parseFailingTests(readTail(path.join(job.runDir, logRel))) : { names: [], more: 0 };
    const payload = resultPayload({
      index: i, outcome: r.outcome, exit: r.outcome === 'passed' ? 0 : r.exit, signal: r.signal, durationMs: r.durationMs,
      failingTests: failing.names, failingMore: failing.more, log: logRel, endedAt: iso(),
    });
    // A check whose group outlived SIGKILL has no result (header).
    if (lingering !== null) break;
    // How the check's supervisor ended (C169) is the journal's alone, beside
    // the payload the persona records and the journal is compared on.
    await write('result', 'verify-result', ['--batch-id', batchId, '--input-file', inputFile(dir, `result-${i}.json`, payload)], { batch_id: batchId, index: i, payload, ...(r.supervisor ? { supervisor: r.supervisor } : {}) });
    results.push(payload);
    ran.push({ index: i, kind: check.kind, origin: check.origin, outcome: r.outcome, duration_ms: r.durationMs });
    if (r.bound) bound = true;
    if (r.outcome === 'stopped') cut = abortedBy() ? 'driver-end' : (ctl.stopCause() ?? 'driver-end');
    if (r.outcome !== 'passed') break;
  }
  if (lingering !== null) {
    return { outcome: 'ran', lingering, batch: { batch_id: batchId, end: null, checks: ran }, wrote };
  }
  let treeEnd = null;
  try { treeEnd = await ops.treeDigest(job.lane); } catch { treeEnd = null; }
  const e = endFor({ ...stored, results }, treeEnd, { cut, bound });
  const endP = endPayload({ treeEnd: e.tree_end, end: e.end, cause: e.cause, endedAt: iso() });
  await write('end', 'verify-batch-end', ['--batch-id', batchId, '--input-file', inputFile(dir, 'end.json', endP)], { batch_id: batchId, payload: endP });
  let follow = null;
  if (e.end === 'passed') {
    await write('pass', 'verify-pass', ['--batch-id', batchId], { batch_id: batchId, payload: null });
    follow = { kind: 'on_pass' };
  } else if (e.end !== 'cut-short') {
    follow = { kind: 'verb', verb: meta.verb };
    // The record as the end left it, judged whole again before the line
    // that lets the policy resume the verb: a record that is not (an edit
    // that came meanwhile) gets no line, and the next step sets it aside.
    const final = await persona.read(job.workflowPath);
    if (final.next_step_kind === 'verify' && final.verify_request?.id === request.id
      && untrustedProblem({ request: final.verify_request, results: final.verify_results, entries }) === null) {
      noteResume(batchId, meta.verb, final);
    }
  }
  return {
    outcome: 'ran', follow, wrote,
    batch: { batch_id: batchId, continues, restart, end: e.end, cause: e.cause, checks: ran, checks_digest: digest, tree_start: treeNow, tree_end: e.tree_end, total: checks.length, ...(reusedFrom ? { reused_from: reusedFrom.batch_id } : {}) },
    selection: selection ? { tests: selection.tests.suite ? 'suite' : (selection.tests.files ?? []).length, additions: selection.additions.length, deferred: (selection.deferred ?? []).length } : null,
  };
}

export { canonicalJson };
