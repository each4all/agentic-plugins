// ADR-0047 §7 retention-apply — the M1 DELETING executor over the read-only
// planner (retention-planner.mjs). This is the ONE named runtime executor with
// an enumerated grant to delete agentic-plugins-owned state: unpinned, over-cap,
// age-cleared runs of the three v1 families (doctor / compat / settings), under
// a reviewed plan hash, behind write-ahead receipts, an explicit --execute flag,
// and containment + no-follow validation re-run at the destructive boundary.
//
// It NEVER deletes host config, never anything outside `.agentic-plugins/runs/`,
// never a pinned/young/unreadable run, and never latest.json.
//
// Safety layers (ADR-0047 §7, none load-bearing alone):
//   1. dry-run default; deletion requires execute:true (ADR-0035 §3 invariant 1).
//   2. plan-hash binding: apply recomputes the plan under the family lock and
//      REFUSES on any mismatch with the operator-reviewed hash (re-present).
//   3. scan_complete gate: an incomplete pin scan withholds ALL deletion.
//   4. family lock: a real O_EXCL mutex serializes applies; an OPEN receipt
//      blocks new applies until resolved.
//   5. containment + symlink refusal, RE-RUN at deletion time (TOCTOU): every
//      target resolves inside runs/<family>/ component-wise, no-follow.
//   6. last-instant age re-check: lstat inside the lock immediately before
//      deletion; any mtime inside the age margin ⇒ concede (a live writer wins).
//   7. write-ahead receipts: planned → started → completed|failed per target,
//      atomic temp+rename, so a crash brands the in-flight target `started`
//      (recoverable) rather than lying. Receipts live OUTSIDE runs/.
//   8. per-invocation ceilings on deletions, bytes, wall-clock.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  RETENTION_FAMILIES,
  RETENTION_FAMILY_REGISTRY,
  RETENTION_PLANNER_VERSION,
  RETENTION_SCANNER_VERSION,
  planRetention,
} from './retention-planner.mjs';

export const RETENTION_RECEIPT_SCHEMA_VERSION = 'runtime-retention-receipt-1.0';

// Per-invocation ceilings (ADR-0035 §3 finite-bounded execution) — implementation
// constants pinned by test. Excess work waits for the next explicit invocation.
export const APPLY_MAX_DELETIONS = 50;
export const APPLY_MAX_BYTES = 500 * 1024 * 1024; // 500 MiB per apply run
export const APPLY_MAX_ELAPSED_MS = 30_000;

// Last-instant age margin: a run whose newest mtime is within this window of
// `now` is conceded even if the plan listed it — a live writer (doctor/compat/
// settings creating/resuming a run) must never lose data to the janitor. Wider
// than the planner's min-age guard is unnecessary; equal is the floor.
export const APPLY_AGE_MARGIN_MS = 15 * 60 * 1000; // 15 minutes

const LOCK_STALE_AGE_MS = 60_000;
const FUTURE_SKEW_TOLERANCE_MS = 60_000;

// ── Paths (receipts + lock live OUTSIDE runs/, so the receipt home is
// structurally out of candidate scope) ──

export function retentionStateRoot(repoRoot) {
  return path.join(repoRoot, '.agentic-plugins', 'state', 'runtime', 'retention');
}

function familyStateDir(repoRoot, family) {
  return path.join(retentionStateRoot(repoRoot), family);
}

function familyLockPath(repoRoot, family) {
  return path.join(familyStateDir(repoRoot, family), '.lock');
}

function familyReceiptPath(repoRoot, family) {
  return path.join(familyStateDir(repoRoot, family), 'receipt.json');
}

function runsFamilyRoot(repoRoot, family) {
  return path.join(repoRoot, '.agentic-plugins', 'runs', family);
}

function assertFamily(family) {
  if (!RETENTION_FAMILIES.includes(family)) {
    throw new TypeError(`unknown retention family "${family}" (v1: ${RETENTION_FAMILIES.join(', ')})`);
  }
}

// ── Containment + no-follow validation (RE-RUN at deletion time) ──
//
// A deletion target must be a run-id directory DIRECTLY under runs/<family>/,
// named by the family's validated run-id shape, and reachable component-wise
// without traversing a symlink. Returns { ok, reason?, runDir? }. Pure fs read.
export async function validateDeletionTarget({ repoRoot, family, runId }) {
  const registry = RETENTION_FAMILY_REGISTRY[family];
  if (!registry || !registry.runIdRe.test(runId)) {
    return { ok: false, reason: 'invalid-run-id' };
  }
  const familyRoot = runsFamilyRoot(repoRoot, family);
  const runDir = path.join(familyRoot, runId);
  // Component-wise containment: the resolved run dir must be an immediate child
  // of the resolved family root — no `..`, no absolute escape.
  const rel = path.relative(path.resolve(familyRoot), path.resolve(runDir));
  if (rel !== runId || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, reason: 'containment-escape' };
  }
  // No-follow at the target AND at the family root: an lstat that reveals a
  // symlink anywhere on the final component is refused (a symlink swapped in
  // after planning must not redirect the recursive removal).
  let familyStat;
  try {
    familyStat = await fsp.lstat(familyRoot);
  } catch (err) {
    return { ok: false, reason: `family-root-unreadable:${err?.code ?? 'error'}` };
  }
  if (familyStat.isSymbolicLink() || !familyStat.isDirectory()) {
    return { ok: false, reason: 'family-root-not-dir' };
  }
  let runStat;
  try {
    runStat = await fsp.lstat(runDir);
  } catch (err) {
    return { ok: false, reason: err?.code === 'ENOENT' ? 'vanished' : `unreadable:${err?.code ?? 'error'}` };
  }
  if (runStat.isSymbolicLink()) return { ok: false, reason: 'symlink-refused' };
  if (!runStat.isDirectory()) return { ok: false, reason: 'not-a-directory' };
  return { ok: true, runDir, mtimeMs: runStat.mtimeMs };
}

// Newest mtime across a run dir (last-instant recency re-check). Bounded by the
// same walk shape as the planner; a walk error is treated as "recent" (concede).
async function newestMtimeMs(runDir) {
  let newest = 0;
  async function walk(dir) {
    const stat = await fsp.lstat(dir);
    if (Number.isFinite(stat.mtimeMs)) newest = Math.max(newest, stat.mtimeMs);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      const info = await fsp.lstat(p);
      if (Number.isFinite(info.mtimeMs)) newest = Math.max(newest, info.mtimeMs);
      if (info.isDirectory() && !info.isSymbolicLink()) await walk(p);
    }
  }
  await walk(runDir);
  return newest;
}

// ── Atomic writes ──

async function writeJsonAtomic(targetPath, value) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.${randomBytes(6).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, targetPath);
}

async function readJsonIfExists(targetPath) {
  try {
    return { ok: true, json: JSON.parse(await fsp.readFile(targetPath, 'utf8')) };
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, code: 'ENOENT' };
    return { ok: false, code: err?.code ?? 'error', error: err };
  }
}

// ── Family lock (real O_EXCL mutex, stale takeover by age — modeled on
// context.mjs acquireSlotLock) ──

async function acquireFamilyLock({ repoRoot, family, nowMs }) {
  const lockPath = familyLockPath(repoRoot, family);
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  const token = `${process.pid}:${randomBytes(8).toString('hex')}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle = null;
    try {
      handle = await fsp.open(lockPath, 'wx');
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      let st;
      try {
        st = await fsp.lstat(lockPath);
      } catch (statErr) {
        if (statErr?.code === 'ENOENT') continue; // released between EEXIST and stat
        return { acquired: false, reason: 'lock-unreadable' };
      }
      if (st.isSymbolicLink() || !st.isFile()) return { acquired: false, reason: 'lock-not-regular' };
      const farFuture = st.mtimeMs - nowMs > FUTURE_SKEW_TOLERANCE_MS;
      const age = farFuture ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - st.mtimeMs);
      if (age <= LOCK_STALE_AGE_MS) return { acquired: false, reason: 'lock-held' };
      // Stale takeover as a REAL mutex: claim by atomic rename-away; exactly one
      // contender wins, losers see ENOENT and retry into a clean create.
      const claim = `${lockPath}.${randomBytes(8).toString('hex')}.stale`;
      try {
        await fsp.rename(lockPath, claim);
        await fsp.rm(claim, { force: true });
      } catch {
        // lost the takeover race — retry
      }
      continue;
    }
    try {
      await handle.writeFile(token);
    } finally {
      await handle.close();
    }
    return { acquired: true, token, lockPath };
  }
  return { acquired: false, reason: 'lock-contended' };
}

async function releaseFamilyLock({ lockPath, token }) {
  // Token-checked release: only remove the lock if it is still ours.
  try {
    const current = await fsp.readFile(lockPath, 'utf8');
    if (current === token) await fsp.rm(lockPath, { force: true });
  } catch {
    // best effort — a stale lock is taken over by age
  }
}

// ── Receipts ──

function receiptIsOpen(receipt) {
  if (!receipt || receipt.schema_version !== RETENTION_RECEIPT_SCHEMA_VERSION) return false;
  if (receipt.status !== 'open') return false;
  return Array.isArray(receipt.targets) && receipt.targets.some((t) => t.state === 'planned' || t.state === 'started');
}

// ── The apply flow ──
//
// Returns a result object (never throws for operational outcomes — bad args do):
//   { status: 'refused'|'dry-run'|'applied'|'blocked', reason?, ... }
export async function applyRetention({
  repoRoot,
  family,
  expectedPlanHash = null,
  execute = false,
  now = new Date(),
  caps = {},
  gitTrackedFiles = null,
  ceilings = {},
} = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new TypeError('repoRoot must be a non-empty string');
  }
  assertFamily(family);
  const nowMs = now.getTime();
  const maxDeletions = Number.isFinite(ceilings.maxDeletions) && ceilings.maxDeletions >= 0 ? ceilings.maxDeletions : APPLY_MAX_DELETIONS;
  const maxBytes = Number.isFinite(ceilings.maxBytes) && ceilings.maxBytes >= 0 ? ceilings.maxBytes : APPLY_MAX_BYTES;
  const maxElapsedMs = Number.isFinite(ceilings.maxElapsedMs) && ceilings.maxElapsedMs >= 0 ? ceilings.maxElapsedMs : APPLY_MAX_ELAPSED_MS;
  const elapsedClock = typeof ceilings.elapsedClock === 'function' ? ceilings.elapsedClock : Date.now;
  const rmImpl = typeof ceilings.rmImpl === 'function' ? ceilings.rmImpl : defaultRecursiveRemove;

  // Acquire the family lock BEFORE recomputing the plan — the recompute and the
  // deletion must be one critical section against concurrent applies.
  const lock = await acquireFamilyLock({ repoRoot, family, nowMs });
  if (!lock.acquired) {
    return { status: 'blocked', reason: `family-lock:${lock.reason}`, family };
  }
  try {
    // An OPEN receipt blocks new applies until it is resolved.
    const existing = await readJsonIfExists(familyReceiptPath(repoRoot, family));
    if (existing.ok && receiptIsOpen(existing.json)) {
      return { status: 'blocked', reason: 'open-receipt', family, receipt: existing.json };
    }
    if (existing.ok === false && existing.code && existing.code !== 'ENOENT') {
      // An unreadable receipt is potentially open — refuse rather than risk a
      // double-delete of a half-applied plan.
      return { status: 'blocked', reason: `receipt-unreadable:${existing.code}`, family };
    }
    // A receipt from a NEWER schema means a downgrade met a newer open receipt —
    // refuse deletion-capable operation instead of misreading it.
    if (existing.ok && existing.json?.schema_version && existing.json.schema_version !== RETENTION_RECEIPT_SCHEMA_VERSION) {
      return { status: 'blocked', reason: 'receipt-schema-mismatch', family, receipt_schema: existing.json.schema_version };
    }

    // Recompute the plan under the lock (full pin re-scan).
    const plan = await planRetention({ repoRoot, now, caps, gitTrackedFiles });
    const recomputedHash = plan.plan_hash;
    if (!plan.scan_complete) {
      return { status: 'refused', reason: 'scan-incomplete', family, plan_hash: recomputedHash, scan_incomplete_reasons: plan.scan_incomplete_reasons };
    }
    const fam = plan.families[family];
    const candidates = fam ? fam.actionable_excess : [];
    // Per-run byte sizes from the recomputed plan — used to enforce the byte
    // ceiling deterministically (the plan already measured them under the lock).
    const runBytes = new Map((fam?.runs ?? []).map((r) => [r.run_id, r.bytes]));

    // Plan-hash binding: if the operator supplied the reviewed hash, it MUST
    // match the recomputed hash — a mismatch means the plan drifted (new
    // citations/runs/pins/caps) and is a refusal with re-present.
    if (expectedPlanHash !== null && expectedPlanHash !== recomputedHash) {
      return {
        status: 'refused',
        reason: 'plan-hash-mismatch',
        family,
        expected_plan_hash: expectedPlanHash,
        recomputed_plan_hash: recomputedHash,
        candidates,
      };
    }

    // Dry-run (default): report what WOULD be deleted, delete nothing.
    if (!execute) {
      return {
        status: 'dry-run',
        family,
        plan_hash: recomputedHash,
        would_delete: candidates.slice(0, maxDeletions),
        candidate_count: candidates.length,
        ceilings: { maxDeletions, maxBytes, maxElapsedMs },
      };
    }

    // ── Execute ──
    const started = elapsedClock();
    // Write-ahead receipt with all targets 'planned' BEFORE the first unlink.
    const receipt = {
      schema_version: RETENTION_RECEIPT_SCHEMA_VERSION,
      family,
      plan_hash: recomputedHash,
      created_at: now.toISOString(),
      status: 'open',
      owner_token: lock.token,
      targets: candidates.slice(0, maxDeletions).map((runId) => ({ run_id: runId, state: 'planned' })),
    };
    await writeJsonAtomic(familyReceiptPath(repoRoot, family), receipt);

    const outcome = { deleted: [], conceded: [], failed: [], bytes: 0 };
    // The deletion-count ceiling is enforced by slicing receipt.targets to
    // maxDeletions at receipt-creation time (above) — the loop never sees more
    // targets than the cap, so no redundant in-loop count break is needed.
    for (const target of receipt.targets) {
      if (elapsedClock() - started >= maxElapsedMs) break;
      const runId = target.run_id;
      // RE-VALIDATE containment + no-follow at the destructive boundary (TOCTOU).
      const valid = await validateDeletionTarget({ repoRoot, family, runId });
      if (!valid.ok) {
        // vanished (a concurrent writer/other apply) or refused — concede.
        target.state = 'completed';
        target.outcome = `conceded:${valid.reason}`;
        outcome.conceded.push({ run_id: runId, reason: valid.reason });
        await writeJsonAtomic(familyReceiptPath(repoRoot, family), receipt);
        continue;
      }
      // Injection seam (tests only): simulate a concurrent writer touching the
      // run AFTER validation but BEFORE the age re-check, so the last-instant
      // re-check can be exercised in isolation from the plan recompute.
      if (typeof ceilings.afterValidate === 'function') await ceilings.afterValidate(valid.runDir);
      // Last-instant age re-check inside the lock: a run touched within the age
      // margin is a live writer's — concede rather than delete its data.
      let recentMtime;
      try {
        recentMtime = await newestMtimeMs(valid.runDir);
      } catch {
        recentMtime = nowMs; // unreadable ⇒ treat as recent ⇒ concede
      }
      if (nowMs - recentMtime < APPLY_AGE_MARGIN_MS) {
        target.state = 'completed';
        target.outcome = 'conceded:too-recent';
        outcome.conceded.push({ run_id: runId, reason: 'too-recent' });
        await writeJsonAtomic(familyReceiptPath(repoRoot, family), receipt);
        continue;
      }
      // Byte ceiling: stop before a deletion that would exceed the budget (a
      // single run larger than the whole budget on the FIRST deletion is still
      // allowed, so a big run is never permanently un-deletable — but it ends
      // this invocation). Leftover targets stay `planned` and the receipt stays
      // open for a resolve/next invocation.
      const thisBytes = runBytes.get(runId) ?? 0;
      if (outcome.deleted.length > 0 && outcome.bytes + thisBytes > maxBytes) break;
      // Transition to 'started' BEFORE the unlink so a crash brands it started.
      target.state = 'started';
      await writeJsonAtomic(familyReceiptPath(repoRoot, family), receipt);
      try {
        await rmImpl(valid.runDir);
        target.state = 'completed';
        target.outcome = 'deleted';
        outcome.deleted.push(runId);
        outcome.bytes += thisBytes;
      } catch (err) {
        target.state = 'failed';
        target.outcome = `error:${err?.code ?? err?.message ?? 'unknown'}`;
        outcome.failed.push({ run_id: runId, reason: target.outcome });
      }
      await writeJsonAtomic(familyReceiptPath(repoRoot, family), receipt);
    }

    // Close the receipt when every target reached a terminal state; leftover
    // planned/started targets (ceiling/cutoff hit) keep it open for a resolve.
    const anyOpen = receipt.targets.some((t) => t.state === 'planned' || t.state === 'started');
    receipt.status = anyOpen ? 'open' : 'closed';
    receipt.closed_at = anyOpen ? null : now.toISOString();
    await writeJsonAtomic(familyReceiptPath(repoRoot, family), receipt);

    return {
      status: 'applied',
      family,
      plan_hash: recomputedHash,
      deleted: outcome.deleted,
      conceded: outcome.conceded,
      failed: outcome.failed,
      receipt_open: anyOpen,
    };
  } finally {
    await releaseFamilyLock({ lockPath: lock.lockPath, token: lock.token });
  }
}

// The ONE recursive-removal capability of this executor (ADR-0047 §7). Registered
// in the ADR-0035 §4 executor-registry static scan by callee + first-arg
// identity (`rmSync` + `runDir`); containment + no-follow are proven by the
// behavioral/mutation tests, not the static scan. force:true tolerates a
// concurrent vanish; recursive:true removes the whole run directory.
function defaultRecursiveRemove(runDir) {
  fs.rmSync(runDir, { recursive: true, force: true });
}

// Resolve an open receipt: re-inventory its 'started' (state-unknown) targets —
// a run dir still present is left for the next plan (its deletion did not
// complete); an absent one is marked completed. Closes the receipt. Read-only
// except the receipt rewrite; never deletes.
export async function resolveOpenReceipt({ repoRoot, family, now = new Date() }) {
  assertFamily(family);
  const receiptPath = familyReceiptPath(repoRoot, family);
  const existing = await readJsonIfExists(receiptPath);
  if (!existing.ok) return { status: 'no-receipt', family };
  const receipt = existing.json;
  if (receipt.schema_version !== RETENTION_RECEIPT_SCHEMA_VERSION) {
    return { status: 'schema-mismatch', family, receipt_schema: receipt.schema_version };
  }
  if (!receiptIsOpen(receipt)) return { status: 'already-closed', family };
  for (const target of receipt.targets) {
    if (target.state === 'planned') {
      target.state = 'completed';
      target.outcome = 'not-started';
      continue;
    }
    if (target.state === 'started') {
      const valid = await validateDeletionTarget({ repoRoot, family, runId: target.run_id });
      // A 'started' target whose run dir is gone completed; one still present is
      // recorded as state-unknown and left for the next plan to re-evaluate.
      target.state = 'completed';
      target.outcome = valid.ok ? 'state-unknown-run-present' : 'deleted-or-vanished';
    }
  }
  receipt.status = 'closed';
  receipt.resolved_at = now.toISOString();
  await writeJsonAtomic(receiptPath, receipt);
  return { status: 'resolved', family, targets: receipt.targets };
}

export function computeExpectedHashHex(planHash) {
  // The planner emits `sha256:<hex>`; the CLI accepts either the full token or
  // the bare hex. Normalize to the planner's token form for comparison.
  if (typeof planHash !== 'string') return null;
  if (planHash.startsWith('sha256:')) return planHash;
  if (/^[0-9a-f]{64}$/.test(planHash)) return `sha256:${planHash}`;
  return null;
}

export const RETENTION_APPLY_VERSIONS = Object.freeze({
  planner: RETENTION_PLANNER_VERSION,
  scanner: RETENTION_SCANNER_VERSION,
  receipt: RETENTION_RECEIPT_SCHEMA_VERSION,
});
