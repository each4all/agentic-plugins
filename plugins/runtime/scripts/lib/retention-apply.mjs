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

// A ceiling override may only LOWER the hard default, never raise it.
function clampCeiling(value, hardMax) {
  if (!Number.isFinite(value) || value < 0) return hardMax;
  return Math.min(Math.trunc(value), hardMax);
}

// The valid target states of a well-formed receipt. Any other state on an
// existing receipt is "unknown" and blocks a new apply (fail-closed).
const RECEIPT_TARGET_STATES = new Set(['planned', 'started', 'completed', 'failed']);

// Fail-closed receipt gate: returns a block reason string when an existing
// receipt must NOT be overwritten by a new apply, or null when it is a cleanly
// closed, current-schema receipt with every target terminal.
function receiptBlockReason(receipt) {
  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) return 'receipt-malformed';
  if (receipt.schema_version !== RETENTION_RECEIPT_SCHEMA_VERSION) return 'receipt-schema-mismatch';
  if (!Array.isArray(receipt.targets)) return 'receipt-malformed';
  for (const t of receipt.targets) {
    if (typeof t !== 'object' || t === null || !RECEIPT_TARGET_STATES.has(t.state)) return 'receipt-unknown-target-state';
    if (t.state === 'planned' || t.state === 'started') return 'open-receipt';
  }
  if (receipt.status !== 'closed') return 'open-receipt';
  return null;
}

// ── Containment + no-follow validation (RE-RUN at deletion time) ──
//
// A deletion target must be a run-id directory DIRECTLY under runs/<family>/,
// named by the family's validated run-id shape, and reachable COMPONENT-WISE
// without traversing a symlink at ANY level — repoRoot/.agentic-plugins, /runs,
// /<family>, and /<runId> are each lstat'd, and a symlink anywhere on that chain
// is refused (Codex review CRITICAL: path.resolve is lexical, so lstating only
// the family root and run dir let a symlink at `.agentic-plugins/runs` redirect
// the recursive removal outside the tree). Returns { ok, reason?, runDir? }.
export async function validateDeletionTarget({ repoRoot, family, runId }) {
  const registry = RETENTION_FAMILY_REGISTRY[family];
  if (!registry || !registry.runIdRe.test(runId)) {
    return { ok: false, reason: 'invalid-run-id' };
  }
  const familyRoot = runsFamilyRoot(repoRoot, family);
  const runDir = path.join(familyRoot, runId);
  // Component-wise containment: the run dir must be an immediate child of the
  // family root — no `..`, no absolute escape (lexical guard, first line).
  const rel = path.relative(path.resolve(familyRoot), path.resolve(runDir));
  if (rel !== runId || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, reason: 'containment-escape' };
  }
  // Every ANCESTOR component from repoRoot down must be a real directory, not a
  // symlink — this is the no-follow guarantee lexical resolution cannot give.
  const ancestors = [
    path.join(repoRoot, '.agentic-plugins'),
    path.join(repoRoot, '.agentic-plugins', 'runs'),
    familyRoot,
  ];
  for (const ancestor of ancestors) {
    let st;
    try {
      st = await fsp.lstat(ancestor);
    } catch (err) {
      return { ok: false, reason: `ancestor-unreadable:${err?.code ?? 'error'}` };
    }
    if (st.isSymbolicLink()) return { ok: false, reason: 'ancestor-symlink' };
    if (!st.isDirectory()) return { ok: false, reason: 'ancestor-not-dir' };
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

async function lstatNoThrow(targetPath) {
  try {
    return await fsp.lstat(targetPath);
  } catch {
    return null;
  }
}

const SETTINGS_NONTERMINAL_STATUSES = new Set(['planned', 'in-progress']);

// Fast per-target pin re-check immediately before deletion (Codex review
// CRITICAL): a writer that repoints latest.json to a candidate, or flips a
// settings run non-terminal / attested, AFTER the plan recompute must not lose
// that run. Reads only the FAST, per-target pin sources (the family latest.json
// and, for settings, the run's own execution artifact) — slow git-tracked
// citations rely on the recompute + plan-hash binding. Fail-closed: any read/
// parse anomaly is treated as "pinned" (concede) rather than proceed to delete.
async function isNowFastPinned({ repoRoot, family, runId }) {
  // latest pointer (all families)
  const latestPath = path.join(runsFamilyRoot(repoRoot, family), 'latest.json');
  const latest = await lstatNoThrow(latestPath);
  if (latest) {
    if (latest.isSymbolicLink() || !latest.isFile()) return true; // anomalous ⇒ concede
    try {
      const json = JSON.parse(await fsp.readFile(latestPath, 'utf8'));
      if (json?.run_id === runId) return true;
    } catch {
      return true; // unreadable/malformed latest ⇒ concede
    }
  }
  // settings live pins (non-terminal or attested) for the target run itself
  if (family === 'settings') {
    const artifactPath = path.join(runsFamilyRoot(repoRoot, family), runId, 'settings.json');
    const st = await lstatNoThrow(artifactPath);
    if (st) {
      if (st.isSymbolicLink() || !st.isFile()) return true;
      try {
        const json = JSON.parse(await fsp.readFile(artifactPath, 'utf8'));
        const status = typeof json?.status === 'string' ? json.status : null;
        const statusNonTerminal = status !== null && SETTINGS_NONTERMINAL_STATUSES.has(status);
        const confirmedTerminal = status !== null && !statusNonTerminal && json?.terminal !== false;
        const review = json?.codex_hook_review;
        const attested = review && review.attested === true && review.status === 'attested';
        if (!confirmedTerminal || attested) return true;
      } catch {
        return true; // can't confirm terminal ⇒ concede
      }
    } else {
      // A settings run whose artifact vanished mid-apply is uncertain ⇒ concede.
      return true;
    }
  }
  return false;
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

async function acquireFamilyLock({ repoRoot, family }) {
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
      // Staleness is judged against REAL wall-clock time, NEVER the caller's
      // injected logical `now` (Codex review CRITICAL): the injected clock is for
      // the plan/age logic; comparing it to the filesystem mtime made a live
      // peer's lock look "far future ⇒ stale" whenever the logical clock ran
      // behind real time, so two processes both took over and both deleted.
      const realNowMs = Date.now();
      const farFuture = st.mtimeMs - realNowMs > FUTURE_SKEW_TOLERANCE_MS;
      const age = farFuture ? Number.POSITIVE_INFINITY : Math.max(0, realNowMs - st.mtimeMs);
      if (age <= LOCK_STALE_AGE_MS) return { acquired: false, reason: 'lock-held' };
      // Stale takeover as a REAL mutex: CAPTURE the stale lock by atomic rename to
      // a unique name; exactly one contender wins the rename and removes the
      // captured file, every loser sees ENOENT and retries into a clean create.
      // A fresh lock a peer created after our staleness read is NOT destroyed:
      // the rename moves whatever is at lockPath, and if a peer already re-created
      // it fresh, our rename captures the STALE one it replaced or fails — either
      // way we then retry the exclusive create and lose to the live holder.
      const claim = `${lockPath}.${randomBytes(8).toString('hex')}.stale`;
      try {
        await fsp.rename(lockPath, claim);
        // Re-verify the captured lock is STILL stale before removing it — a live
        // peer's fresh lock captured by an ABA rename must be restored, not
        // deleted (mirrors the ADR-0047 §6 capture-verified removal).
        let claimStat = null;
        try {
          claimStat = await fsp.lstat(claim);
        } catch {
          claimStat = null;
        }
        const stillStale = claimStat
          && !(claimStat.mtimeMs - Date.now() > FUTURE_SKEW_TOLERANCE_MS)
          && Date.now() - claimStat.mtimeMs > LOCK_STALE_AGE_MS;
        if (stillStale) {
          await fsp.rm(claim, { force: true });
        } else if (claimStat) {
          // ABA: captured a fresh lock — restore it and concede.
          try {
            await fsp.rename(claim, lockPath);
          } catch {
            await fsp.rm(claim, { force: true }).catch(() => {});
          }
          return { acquired: false, reason: 'lock-held' };
        }
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
  // `execute` is a STRICT boolean gate (Codex review CRITICAL): any truthy
  // non-true value (a string, 1, {}) must NOT enter deletion mode.
  const doExecute = execute === true;
  // Deletion REQUIRES the operator's reviewed plan hash in the LIB itself — the
  // CLI guard does not protect direct callers of the exported executor (Codex
  // review CRITICAL). A bare execute with no reviewed hash would delete against
  // an unreviewed plan.
  if (doExecute && (typeof expectedPlanHash !== 'string' || expectedPlanHash.length === 0)) {
    throw new TypeError('execute:true requires expectedPlanHash (the operator-reviewed plan hash)');
  }
  // Ceilings can only be LOWERED from the hard defaults, never raised (Codex
  // review MAJOR): a caller must not be able to widen a deletion budget past the
  // ADR-0035 §3 finite-bounded-execution constants.
  const maxDeletions = clampCeiling(ceilings.maxDeletions, APPLY_MAX_DELETIONS);
  const maxBytes = clampCeiling(ceilings.maxBytes, APPLY_MAX_BYTES);
  const maxElapsedMs = clampCeiling(ceilings.maxElapsedMs, APPLY_MAX_ELAPSED_MS);
  const elapsedClock = typeof ceilings.elapsedClock === 'function' ? ceilings.elapsedClock : Date.now;
  const rmImpl = typeof ceilings.rmImpl === 'function' ? ceilings.rmImpl : defaultRecursiveRemove;
  // A REAL deletion always runs the full tracked-citation rescan — an injected
  // gitTrackedFiles (a test seam) must never weaken the pin scan a live deletion
  // depends on (Codex review MAJOR). Injection is honored only in dry-run.
  const effectiveGitTracked = doExecute ? null : gitTrackedFiles;

  // Acquire the family lock BEFORE recomputing the plan — the recompute and the
  // deletion must be one critical section against concurrent applies.
  const lock = await acquireFamilyLock({ repoRoot, family });
  if (!lock.acquired) {
    return { status: 'blocked', reason: `family-lock:${lock.reason}`, family };
  }
  try {
    // Any EXISTING receipt is fail-closed (Codex review MAJOR): the ONLY state
    // that permits a new apply is a cleanly-closed, current-schema receipt with
    // every target terminal. Anything else — unreadable, malformed, missing/
    // wrong schema, open, or carrying an unknown target state — BLOCKS, so an
    // uncertain half-applied prior run can never be overwritten and re-deleted.
    const existing = await readJsonIfExists(familyReceiptPath(repoRoot, family));
    if (existing.ok === false && existing.code && existing.code !== 'ENOENT') {
      return { status: 'blocked', reason: `receipt-unreadable:${existing.code}`, family };
    }
    if (existing.ok) {
      const block = receiptBlockReason(existing.json);
      if (block) return { status: 'blocked', reason: block, family, receipt_schema: existing.json?.schema_version ?? null };
    }

    // Recompute the plan under the lock (full pin re-scan; a real deletion never
    // honors an injected gitTrackedFiles).
    const plan = await planRetention({ repoRoot, now, caps, gitTrackedFiles: effectiveGitTracked });
    const recomputedHash = plan.plan_hash;
    if (!plan.scan_complete) {
      return { status: 'refused', reason: 'scan-incomplete', family, plan_hash: recomputedHash, scan_incomplete_reasons: plan.scan_incomplete_reasons };
    }
    const fam = plan.families[family];
    const candidates = fam ? fam.actionable_excess : [];
    // Per-run byte sizes from the recomputed plan — used to enforce the byte
    // ceiling deterministically (the plan already measured them under the lock).
    const runBytes = new Map((fam?.runs ?? []).map((r) => [r.run_id, r.bytes]));

    // Plan-hash binding: the reviewed hash (when supplied — always, for execute)
    // MUST match the recomputed hash. A mismatch means the plan drifted (new
    // citations/runs/pins/caps) and is a refusal with re-present. Normalize both
    // to the `sha256:` token form so a bare-hex reviewed hash still compares.
    const normalizedExpected = expectedPlanHash !== null ? computeExpectedHashHex(expectedPlanHash) : null;
    if (normalizedExpected !== null && normalizedExpected !== recomputedHash) {
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
    if (!doExecute) {
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
      const concede = async (reason) => {
        target.state = 'completed';
        target.outcome = `conceded:${reason}`;
        outcome.conceded.push({ run_id: runId, reason });
        await writeJsonAtomic(familyReceiptPath(repoRoot, family), receipt);
      };
      // RE-VALIDATE containment + no-follow at the destructive boundary (TOCTOU).
      const valid = await validateDeletionTarget({ repoRoot, family, runId });
      if (!valid.ok) { await concede(valid.reason); continue; }
      // Injection seam (tests only): simulate a concurrent writer acting AFTER
      // validation but BEFORE the pin/age re-checks (repointing latest.json,
      // touching a file). Placed before both re-checks so a test can exercise
      // either the pin race or the recency race.
      if (typeof ceilings.afterValidate === 'function') await ceilings.afterValidate(valid.runDir);
      // Per-target FRESH pin re-check (Codex review CRITICAL): a writer that
      // pins a candidate AFTER the plan recompute (repointing latest.json, or a
      // settings run going non-terminal / gaining an attestation) must not lose
      // its run. The fast pin sources are re-read immediately before deletion;
      // slow git-tracked citations rely on the recompute + plan-hash binding.
      if (await isNowFastPinned({ repoRoot, family, runId })) { await concede('now-pinned'); continue; }
      // Last-instant age re-check inside the lock: a run touched within the age
      // margin is a live writer's — concede rather than delete its data.
      let recentMtime;
      try {
        recentMtime = await newestMtimeMs(valid.runDir);
      } catch {
        recentMtime = nowMs; // unreadable ⇒ treat as recent ⇒ concede
      }
      if (nowMs - recentMtime < APPLY_AGE_MARGIN_MS) { await concede('too-recent'); continue; }
      // Byte ceiling: stop before a deletion that would exceed the budget (a
      // single run larger than the whole budget on the FIRST deletion is still
      // allowed, so a big run is never permanently un-deletable — but it ends
      // this invocation). maxBytes:0 admits nothing (the > comparison fires even
      // on the first target). Leftover targets stay `planned`, receipt stays open.
      const thisBytes = runBytes.get(runId) ?? 0;
      if ((outcome.deleted.length > 0 || maxBytes === 0) && outcome.bytes + thisBytes > maxBytes) break;
      // Transition to 'started' BEFORE the unlink so a crash brands it started.
      target.state = 'started';
      await writeJsonAtomic(familyReceiptPath(repoRoot, family), receipt);
      try {
        // CAPTURE-by-rename before removal (Codex review CRITICAL TOCTOU, mirrors
        // ADR-0047 §6): atomically rename the validated run dir to a nonce
        // tombstone within the family root, re-lstat the CAPTURED dir (a fresh
        // symlink an attacker swaps at runId after our capture cannot affect the
        // nonce name), then recursively remove the tombstone.
        const tombstone = `${valid.runDir}.gc-${randomBytes(8).toString('hex')}`;
        await fsp.rename(valid.runDir, tombstone);
        const captured = await lstatNoThrow(tombstone);
        if (!captured || captured.isSymbolicLink() || !captured.isDirectory()) {
          // Captured something that is not a real dir — do NOT recursively remove
          // it; restore if possible and concede.
          if (captured) { try { await fsp.rename(tombstone, valid.runDir); } catch { /* leave tombstone */ } }
          target.state = 'completed';
          target.outcome = 'conceded:capture-not-dir';
          outcome.conceded.push({ run_id: runId, reason: 'capture-not-dir' });
        } else {
          await rmImpl(tombstone);
          target.state = 'completed';
          target.outcome = 'deleted';
          outcome.deleted.push(runId);
          outcome.bytes += thisBytes;
        }
      } catch (err) {
        if (err?.code === 'ENOENT') {
          target.state = 'completed';
          target.outcome = 'conceded:vanished';
          outcome.conceded.push({ run_id: runId, reason: 'vanished' });
        } else {
          target.state = 'failed';
          target.outcome = `error:${err?.code ?? err?.message ?? 'unknown'}`;
          outcome.failed.push({ run_id: runId, reason: target.outcome });
        }
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
// complete); an absent one is marked completed. Closes the receipt. Never
// deletes. Acquires the SAME family lock apply takes (Codex review MAJOR) so it
// cannot race an in-flight apply and rewrite the receipt out from under it; an
// unreadable/malformed receipt is reported honestly, never silently closed.
export async function resolveOpenReceipt({ repoRoot, family, now = new Date() }) {
  assertFamily(family);
  const lock = await acquireFamilyLock({ repoRoot, family });
  if (!lock.acquired) return { status: 'blocked', reason: `family-lock:${lock.reason}`, family };
  try {
    const receiptPath = familyReceiptPath(repoRoot, family);
    const existing = await readJsonIfExists(receiptPath);
    if (!existing.ok) {
      // ENOENT is genuinely "no receipt"; any other read error is reported as
      // unreadable rather than pretended-absent.
      return { status: existing.code === 'ENOENT' ? 'no-receipt' : 'unreadable', family, code: existing.code ?? null };
    }
    const receipt = existing.json;
    if (typeof receipt !== 'object' || receipt === null || !Array.isArray(receipt.targets)) {
      return { status: 'malformed', family };
    }
    if (receipt.schema_version !== RETENTION_RECEIPT_SCHEMA_VERSION) {
      return { status: 'schema-mismatch', family, receipt_schema: receipt.schema_version ?? null };
    }
    if (!receiptIsOpen(receipt)) return { status: 'already-closed', family };
    for (const target of receipt.targets) {
      if (target.state === 'planned') {
        target.state = 'completed';
        target.outcome = 'not-started';
        continue;
      }
      if (target.state === 'started') {
        // A 'started' target whose run dir is GONE completed; one still present
        // is state-unknown and left for the next plan. Distinguish honestly: a
        // symlink/unreadable-but-present entry is NOT "deleted-or-vanished".
        const lst = await lstatNoThrow(path.join(runsFamilyRoot(repoRoot, family), target.run_id));
        target.state = 'completed';
        if (lst === null) target.outcome = 'deleted-or-vanished';
        else if (lst.isDirectory() && !lst.isSymbolicLink()) target.outcome = 'state-unknown-run-present';
        else target.outcome = 'state-unknown-nonconforming';
      }
    }
    receipt.status = 'closed';
    receipt.resolved_at = now.toISOString();
    await writeJsonAtomic(receiptPath, receipt);
    return { status: 'resolved', family, targets: receipt.targets };
  } finally {
    await releaseFamilyLock({ lockPath: lock.lockPath, token: lock.token });
  }
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
