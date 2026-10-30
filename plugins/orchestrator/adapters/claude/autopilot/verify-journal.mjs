// plugins/orchestrator/adapters/claude/autopilot/verify-journal.mjs
//
// ADR-0068 Decision 5, items 5 to 7 (verify-exec) — the driver's own ledger of
// the verification writes it makes, and the trust it takes from it.
//
// THE JOURNAL. One file per engineer workflow, repository-wide: under the
// orchestrator's state home of the main checkout
// (`.agentic-plugins/state/orchestrator/verify-journal/<workflow_id>.jsonl`),
// so a run in any checkout of the repository reads what an earlier run in
// another wrote, after that run's open-run record is gone. Each line is one
// write the driver is about to make through the persona's CLI, with its exact
// payload, appended and synced BEFORE the write (write-ahead): a driver that
// dies between the two leaves an intent the record may or may not hold, and
// never a record the journal does not hold. A start also keeps what the
// persona's record does not: the requesting verb, the selection base, and the
// subtask.
//
// TRUST. The persona's record is no trust boundary (its lib/verify.mjs header):
// the worker whose step recorded the request can write any batch, result, end
// or pass into it. The driver trusts a stored batch, result, end or answer only
// when the journal holds a write of exactly that payload (canonical JSON, key
// order aside) for that request and batch; a carried result only when the
// journal holds that result for the batch it names, a start of that batch by
// the run it names. Anything else in the request's record is no evidence, and
// the whole record is set aside with `verify-batch-restart` (untrustedProblem).
// An intent the record does not hold is a write that may not have landed: the
// write is made again (the persona takes an identical replay as a no-op), or,
// for a result, the check runs again: a result is never assumed.
//
// WHAT IT DOES NOT STOP (a documented limit, ADR-0068 verify-exec note V2).
// The journal lives in state the worker's process can write, as the record
// does: it tells the driver's writes from a record edited alone (a worker
// that wrote a result by hand, a confused step), not from a worker that
// forges the journal's lines to match. Nothing a worker of the run cannot
// write holds the driver's provenance; a forger with write access to the
// main checkout's state is outside this trust model.

import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson, sha256 } from './verify-decl.mjs';

export const JOURNAL_DIR_REL = '.agentic-plugins/state/orchestrator/verify-journal';
export const JOURNAL_VERSION = 1;
const WORKFLOW_ID_RE = /^[a-z][a-z0-9-]*-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
// `resume` is the driver's own decision, no persona write: the request's
// latest batch, its record trusted whole (untrustedProblem), ended without an
// answer on this tree, and its requesting verb follows (resumeFact).
export const OPS = Object.freeze(['start', 'restart', 'result', 'end', 'pass', 'resume']);

/** The journal of one workflow, under the main checkout. */
export function journalPath(mainRoot, workflowId) {
  if (typeof workflowId !== 'string' || !WORKFLOW_ID_RE.test(workflowId)) throw new Error(`verify journal: ${JSON.stringify(workflowId)} is not an engineer workflow id`);
  return path.join(mainRoot, JOURNAL_DIR_REL, `${workflowId}.jsonl`);
}

const TAIL_CHUNK = 64 * 1024;

function endsInNewline(fd, size) {
  const last = Buffer.alloc(1);
  fs.readSync(fd, last, 0, 1, size - 1);
  return last[0] === 0x0a;
}

// The offset just past the last newline before `size`, or 0.
function lastLineStart(fd, size) {
  const chunk = Buffer.alloc(TAIL_CHUNK);
  for (let end = size; end > 0; ) {
    const len = Math.min(TAIL_CHUNK, end);
    fs.readSync(fd, chunk, 0, len, end - len);
    const nl = chunk.subarray(0, len).lastIndexOf(0x0a);
    if (nl !== -1) return end - len + nl + 1;
    end -= len;
  }
  return 0;
}

/** Append one entry, whole, and sync it before returning. Throws when it cannot. */
export function appendJournal(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = `${JSON.stringify({ v: JOURNAL_VERSION, ...entry })}\n`;
  const fd = fs.openSync(file, 'a+');
  try {
    // A line a write that died left cut short is taken back first, never
    // joined by this one (readJournal skips it only while it is the last).
    // Its start is found however long it is (a start line can run to the
    // persona's 192 KiB cap): back from the end, a chunk at a time, to the
    // last newline, or the file's start when it holds none.
    let before = fs.fstatSync(fd).size;
    if (before > 0 && !endsInNewline(fd, before)) {
      before = lastLineStart(fd, before);
      fs.ftruncateSync(fd, before);
    }
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } catch (e) {
      // A line cut short is taken back, never left for the next to join.
      try { fs.ftruncateSync(fd, before); } catch { /* the reader skips a torn last line */ }
      throw e;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The journal's entries, in the order they were written: `{ entries }`, or
 * `{ entries, problem }` when a line other than the last does not parse (a
 * torn last line, a write that died, is skipped). A missing file is none.
 */
export function readJournal(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { entries: [] };
    return { entries: [], problem: `the verify journal ${file} cannot be read (${e.code ?? e.message})` };
  }
  const lines = text.split('\n');
  const entries = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === '') continue;
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      if (i >= lines.length - 2) break;
      return { entries, problem: `line ${i + 1} of the verify journal ${file} does not parse` };
    }
    if (e && typeof e === 'object' && e.v === JOURNAL_VERSION && OPS.includes(e.op)) entries.push(e);
  }
  return { entries };
}

// ---------------------------------------------------------------------------
// The payloads, as the persona normalizes and stores them (its lib/verify.mjs
// parseBatchStart, parseResult, parseEnd): what the driver writes is what the
// record then holds, byte for byte once canonical.

export const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function startPayload({ batchId, runId, continues = null, treeStart, declarationCommit, declarationDigest, checks, checksDigest, startedAt }) {
  return {
    batch_id: batchId, run_id: runId, continues, tree_start: treeStart,
    declaration_commit: declarationCommit, declaration_digest: declarationDigest,
    checks: checks.map((c, i) => ({ index: i, kind: c.kind, origin: c.origin, argv: [...c.argv] })),
    checks_digest: checksDigest, started_at: startedAt,
  };
}

export function resultPayload({ index, outcome, exit = null, signal = null, durationMs, failingTests = [], failingMore = 0, log = null, endedAt }) {
  return {
    index, outcome, exit, signal, duration_ms: durationMs, failing_tests: failingTests, failing_tests_more: failingMore, log, ended_at: endedAt,
  };
}

export function endPayload({ treeEnd, end, cause = null, endedAt }) {
  return { tree_end: treeEnd, end, cause, ended_at: endedAt };
}

const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const START_KEYS = ['batch_id', 'run_id', 'continues', 'tree_start', 'declaration_commit', 'declaration_digest', 'checks', 'checks_digest', 'started_at'];
const startOf = (b) => Object.fromEntries(START_KEYS.map((k) => [k, b[k]]));
const endOf = (b) => ({ tree_end: b.tree_end, end: b.end, cause: b.cause, ended_at: b.ended_at });
const withoutCarry = (r) => {
  const { carried_from: _c, ...rest } = r;
  return rest;
};

function find(entries, requestId, op, batchId, extra = () => true) {
  return entries.filter((e) => e.op === op && e.request_id === requestId && e.batch_id === batchId && extra(e));
}

/** The journal's start (or restart) of a batch of the request, or null. */
export function startEntry(entries, requestId, batchId) {
  return entries.find((e) => (e.op === 'start' || e.op === 'restart') && e.request_id === requestId && e.batch_id === batchId) ?? null;
}

// Whether the batch `from` is reached from `continues` through the batches the
// journal started for the request, each continuing the one before (a restart
// continues nothing, so no carry crosses it), every one of them, `from`
// included, on `tree` and with `digest`: the persona carries a pass only into
// a batch on its tree with its commands, so a hop on another tree ends the
// carry, whatever the batch after it returns to.
function carriedThrough(entries, requestId, { continues, from, tree, digest }) {
  const seen = new Set();
  for (let cur = continues; typeof cur === 'string' && !seen.has(cur); ) {
    const hop = startEntry(entries, requestId, cur)?.payload ?? null;
    if (!hop || hop.tree_start !== tree || hop.checks_digest !== digest) return false;
    if (cur === from) return true;
    seen.add(cur);
    cur = hop.continues ?? null;
  }
  return false;
}

/**
 * Whether the journal holds every record of the request's stored results and
 * its answer: null, or what it does not hold. `results` is the stored
 * `verify_results` (or undefined), `request` the stored `verify_request`.
 */
export function untrustedProblem({ request, results, entries }) {
  const id = request?.id;
  if (typeof id !== 'string') return 'the request has no id';
  if (request.answered_by !== undefined && request.answered_by !== null
    && find(entries, id, 'pass', request.answered_by).length === 0) {
    return `the request's answer (batch ${request.answered_by}) is not one this driver wrote`;
  }
  if (!results || results.request_id !== id) return null;
  for (const b of results.batches ?? []) {
    const starts = [...find(entries, id, 'start', b.batch_id), ...find(entries, id, 'restart', b.batch_id)];
    if (!starts.some((e) => same(e.payload, startOf(b)))) return `batch ${b.batch_id} is not one this driver started`;
    for (const r of b.results ?? []) {
      if (r.carried_from) {
        const from = r.carried_from;
        const origin = startEntry(entries, id, from.batch_id);
        const held = find(entries, id, 'result', from.batch_id, (e) => e.index === r.index).some((e) => same(e.payload, withoutCarry(r)));
        if (!origin || origin.payload?.run_id !== from.run_id || !held) {
          return `check ${r.index} of batch ${b.batch_id} carries a result from batch ${from.batch_id} this driver did not record`;
        }
        // The carry itself (the persona's carryOver): a pass, into a batch that
        // continues, through the journal's starts, the batch it came from, each
        // hop on the tree and with the commands it ran on. A result the driver
        // did record, set into another batch, is no evidence there.
        if (r.outcome !== 'passed'
          || !carriedThrough(entries, id, { continues: b.continues, from: from.batch_id, tree: b.tree_start, digest: b.checks_digest })) {
          return `check ${r.index} of batch ${b.batch_id} carries a result from batch ${from.batch_id} that is no pass of a batch it continues, on its tree and commands`;
        }
        continue;
      }
      if (!find(entries, id, 'result', b.batch_id, (e) => e.index === r.index).some((e) => same(e.payload, r))) {
        return `check ${r.index} of batch ${b.batch_id} has a result this driver did not record`;
      }
    }
    if (b.end !== undefined && !find(entries, id, 'end', b.batch_id).some((e) => same(e.payload, endOf(b)))) {
      return `batch ${b.batch_id}'s end is not one this driver wrote`;
    }
  }
  return null;
}

/**
 * The latest batch the journal ended for this workflow, other than the
 * request's own (`excludeRequest`): what a repeat is judged against (item 7).
 * `{ request_id, batch_id, end, checks_digest, tree_start }`, or null.
 */
export function lastEnded(entries, { excludeRequest = null } = {}) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e.op !== 'end' || e.request_id === excludeRequest) continue;
    const start = startEntry(entries, e.request_id, e.batch_id);
    if (!start) continue;
    return { request_id: e.request_id, batch_id: e.batch_id, end: e.payload?.end ?? null, checks_digest: start.meta?.checks_digest ?? start.payload?.checks_digest ?? null, tree_start: start.payload?.tree_start ?? null };
  }
  return null;
}

/** The pass the journal holds for a batch of the request, with its start, or null. */
export function passOf(entries, requestId, batchId) {
  const pass = find(entries, requestId, 'pass', batchId)[0] ?? null;
  if (!pass) return null;
  const start = startEntry(entries, requestId, batchId);
  return start ? { pass, start } : null;
}

/**
 * The digest of a request's record as the workflow stores it (its
 * `verify_request`, and its `verify_results` when they are the request's):
 * what a `resume` line was decided on, which the policy compares with the
 * child's record now (observe.mjs verifySummary).
 */
export function recordDigest(request, results) {
  const own = results && typeof results === 'object' && results.request_id === request?.id ? results : null;
  return sha256(canonicalJson({ request: request ?? null, results: own }));
}

/**
 * ADR-0068 Decision 5, item 6 — what the policy takes from the journal for a
 * child whose request is pending: the requesting verb to resume, once a
 * verification step decided so (a `resume` line, written only after the
 * request's whole record passed untrustedProblem) for the request's latest
 * batch as the record still names it, on the record that line was decided on
 * (its `record_digest`). The policy never judges the record itself: a record
 * edited since has another digest, and is the next verification step's to
 * set aside. `summary` is the child's verify summary (observe.mjs
 * verifySummary). Null otherwise.
 */
export function resumeFact({ summary, entries, latestBatchId }) {
  if (!summary || typeof summary.request_id !== 'string' || typeof latestBatchId !== 'string') return null;
  if (!['failed', 'no-evidence', 'passed'].includes(summary.last_end)) return null;
  const r = find(entries, summary.request_id, 'resume', latestBatchId).at(-1) ?? null;
  if (!r || typeof r.payload?.verb !== 'string') return null;
  // The record the step judged whole, and no other: one edited since (a
  // result's failing tests, under the same batch id and end) is the next
  // verification step's to set aside, never the requesting verb's to read.
  if (typeof summary.record_digest !== 'string' || r.payload.record_digest !== summary.record_digest) return null;
  return { request_id: summary.request_id, batch_id: latestBatchId, end: summary.last_end, verb: r.payload.verb };
}
