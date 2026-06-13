#!/usr/bin/env node
// plugins/founder/scripts/state.mjs
//
// Host-shared canonical state I/O for the founder plugin per ADR-0011,
// copy-trimmed from plugins/engineer/scripts/state.mjs per ADR-0036 SD7
// (sibling-copy pattern; cross-plugin imports forbidden per ADR-0010 §5).
//
// founder state contract — trim deltas vs the engineer sibling
// (ADR-0036 SD5/SD7):
//   - canonical-only home: founder is new, so there is NO legacy
//     `.claude/agentic-*` fallback, no dual-home reads, and no
//     migration surface (ADR-0025 §1).
//   - no cross-plugin parent linkage: parent_workflow /
//     originating_subtask / parent_detached / parent_writeback_at
//     fields, their validation, create flags, and CLI subcommands are
//     removed — orchestrator→founder dispatch is ADR-0036 Non-Goal 3.
//
// Used by:
//   - plugins/founder/commands/<verb>.md (PR3+; thin-shim Phase 0 + state finalize)
//   - plugins/founder/adapters/{claude,codex}/hooks/* (snapshot writes)
//
// Storage location:
//   canonical: <repo_root>/.agentic-plugins/state/founder/workflows/<workflow_id>.md
//
// Lock files:
//   <state-home>/.creation-lock             (directory-level)
//   <state-home>/workflows/<id>.md.lock     (per-file)
//
// File modes:
//   directories: 0o700
//   files:       0o600 (workflows + locks)
//
// File format: YAML frontmatter (schema=1) + Markdown body per ADR-0011 §2.
//
// Lock ownership protocol per ADR-0011 §3 — each acquire writes a token
// `<PID>:<monotonic-nanoseconds>:<8-byte-random-hex>` and release verifies
// the token before unlinking. Stale detection re-reads the lock file
// twice across a 60-second window to confirm no progress.

import {
  readFile,
  writeFile,
  rename,
  unlink,
  readdir,
  stat,
  mkdir,
  open,
} from 'node:fs/promises';
import { join, dirname, basename, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hrtime, pid } from 'node:process';
// ADR-0018 §sub-2 — `currentGitBranch` shells out to `git branch
// --show-current` for branch-keyed active workflow lookup. This is
// the only `child_process` use in state.mjs; all other modules
// continue to inject the branch via `gitBaseline.branch`.
import { execFileSync } from 'node:child_process';
// ADR-0028 N1 — shared pathspec injection defense for Layer 2 write-side
// (recordManifestEntry) and Layer 3 read-side (phase7-commit.mjs
// pre-stage re-validation). Single source of truth in validate-commit.mjs
// per PR1 deferral.
import { assertSafePath } from './validate-commit.mjs';

// -----------------------------------------------------------------------------
// Constants — ADR-0011 §1, §2, §3 + ADR-0017 schema 1.1

// SCHEMA_VERSION names the version that `createWorkflow` emits today.
// The checkpoint meta surface (first sub-decision-2 frontmatter write)
// flipped emit to the string '1.1' per ADR-0017 §"Schema versioning policy";
// ADR-0028 §Layer-2 bumps the emit to '1.2' for the additive `commit_manifest`
// field. String form is required because the YAML parser (`parseScalar`) does
// not emit a JS Number for `1.1` / `1.2` — bare `1.2` round-trips through
// Number, which loses precision and changes type.
export const SCHEMA_VERSION = '1.3';

// Versions accepted on read. ADR-0017 §"Schema versioning policy" mandates
// schema-1.0 readers tolerantly accept 1.1 frontmatter; 1.1 readers must
// continue to read legacy schema-1 files; ADR-0028 §Layer-2 extends the same
// rule across the 1.1 → 1.2 boundary so legacy 1.1 readers and writers keep
// working. Mutation helpers (`setCheckpoint`, `setTerminal`, `appendPhaseNote`,
// …) preserve the disk-recorded schema — no silent promotion of legacy `1` or
// `'1.1'` files, no silent downgrade of `'1.2'` files.
//
// This Set documents the minors this build explicitly knows about. It is no
// longer the validateFrontmatter accept gate — that uses `isSupportedSchema`
// below (ADR-0028 §Forward-compat) so a 1.x reader meeting a 1.y file with
// y > x can still parse via the predicate's open-ended 1.x match.
export const SUPPORTED_SCHEMA_VERSIONS = new Set([1, '1.1', '1.2', '1.3']);

// ADR-0028 §Forward-compat read-tolerance predicate. Accepts legacy schema=1
// (number form per ADR-0017 backward-compat) and any future-minor `1.y`
// string (y ≥ 0, no leading zeros). Rejects unknown majors (`2`, `'2.0'`),
// the bare `'1'` (no minor digit — canonical legacy is the number `1`), the
// number form of any minor (`1.5` — the YAML parser emits strings for `1.x`
// per state.mjs:60-62), and malformed strings (leading-zero minor, missing
// minor, junk).
export function isSupportedSchema(s) {
  if (s === 1) return true;
  if (typeof s !== 'string') return false;
  return /^1\.(0|[1-9]\d*)$/.test(s);
}

export const STATE_DIR_REL = '.agentic-plugins/state/founder';
export const WORKFLOW_DIR_REL = `${STATE_DIR_REL}/workflows`;
export const CREATION_LOCK_REL = `${STATE_DIR_REL}/.creation-lock`;
// ADR-0017 §sub-decision 5 — auto-archive destination.
export const ARCHIVE_DIR_REL = `${STATE_DIR_REL}/archive`;

// ADR-0017 §sub-decision 5 — terminal phase whitelist that gates Stop
// auto-archive. The whitelist is intentionally small + explicit so an
// intermediate phase write cannot trip auto-archive.
export const TERMINAL_PHASES = new Set([
  'commit-complete',
  'summary-complete',
  'fix-complete',
]);

// ADR-0017 §sub-decision 4 — global retention cap on `ensemble_results`.
// Oldest entries (by `completed_at`) are evicted on append.
export const ENSEMBLE_RESULTS_RETENTION_CAP = 20;

const STALE_THRESHOLD_MS = 60_000;        // ADR-0011 §3
const RETRY_BACKOFF_MAX_MS = 5_000;       // ADR-0011 §3 step 2

const VALID_VERBS = new Set([
  'investigate',
  'frame',
  'decide',
  'compose',
  'critique',
  'refine',
]);
// ADR-0020 §Sub-decision 5 — workflow-shape discriminator. Schema 1.1-additive
// (no SCHEMA_VERSION bump per ADR-0017/0019 precedent; Alternative E rejected).
// `verb-chain` is the historical single-verb workflow shape (default on absence
// for legacy 1.1 files); `start` is the lifecycle macro shape introduced by
// the lifecycle macro shape (future `/founder:start`, ADR-0036 PR6).
const VALID_WORKFLOW_TYPES = new Set(['verb-chain', 'start']);
const VALID_HOSTS = new Set(['claude', 'codex']);
// `archived` and `checkpointed` are added for ADR-0017 sub-decisions 1/5
// (resume archive flow) and 2 (checkpoint meta surface) respectively.
const VALID_HOOK_EVENTS = new Set([
  'created',
  'updated',
  'snapshot',
  'resumed',
  'archived',
  'checkpointed',
]);
const VALID_SNAPSHOT_TRIGGERS = new Set(['pre-compact', 'stop']);

// -----------------------------------------------------------------------------
// Path helpers

// founder trim — canonical home only (ADR-0036 SD5: no legacy dual-home).
const STATE_HOMES = Object.freeze({
  canonical: {
    home: 'canonical',
    stateDirRel: STATE_DIR_REL,
    workflowDirRel: WORKFLOW_DIR_REL,
    archiveDirRel: ARCHIVE_DIR_REL,
    creationLockRel: CREATION_LOCK_REL,
    peerRunsDirRel: `${STATE_DIR_REL}/peer-runs`,
  },
});

function assertAbsoluteRepoRoot(repoRoot, fnName = 'repoRoot') {
  if (!isAbsolute(repoRoot)) {
    throw new Error(`${fnName} must be absolute: ${repoRoot}`);
  }
}

function statePaths(repoRoot, home = 'canonical') {
  assertAbsoluteRepoRoot(repoRoot);
  const spec = STATE_HOMES[home];
  if (!spec) throw new Error(`unknown workflow state home: ${home}`);
  return {
    ...spec,
    root: join(repoRoot, spec.stateDirRel),
    workflows: join(repoRoot, spec.workflowDirRel),
    archive: join(repoRoot, spec.archiveDirRel),
    creationLock: join(repoRoot, spec.creationLockRel),
    peerRuns: join(repoRoot, spec.peerRunsDirRel),
  };
}

export function workflowDir(repoRoot, { home = 'canonical' } = {}) {
  return statePaths(repoRoot, home).workflows;
}

export function creationLockPath(repoRoot, { home = 'canonical' } = {}) {
  return statePaths(repoRoot, home).creationLock;
}

export function workflowFilePath(repoRoot, workflowId, { home = 'canonical' } = {}) {
  return join(workflowDir(repoRoot, { home }), `${workflowId}.md`);
}

function fileLockPath(workflowFilePath_) {
  return `${workflowFilePath_}.lock`;
}

async function directoryHasEntries(dir) {
  try {
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function stateHomeHasState(repoRoot, home) {
  const paths = statePaths(repoRoot, home);
  if (await pathStat(paths.creationLock)) return true;
  return (
    await directoryHasEntries(paths.workflows) ||
    await directoryHasEntries(paths.archive) ||
    await directoryHasEntries(paths.peerRuns)
  );
}

// founder trim — `mode` is accepted for caller-signature parity with the
// engineer sibling but has no effect: with a single canonical home there
// is no dual-home write conflict to block (ADR-0036 SD5).
export async function resolveWorkflowStorage(repoRoot, { mode = 'read' } = {}) {
  assertAbsoluteRepoRoot(repoRoot);
  void mode;
  const canonicalHasState = await stateHomeHasState(repoRoot, 'canonical');
  return {
    ...statePaths(repoRoot, 'canonical'),
    canonicalHasState,
  };
}

function inferStorageFromWorkflowPath(workflowPath) {
  const text = String(workflowPath);
  const canonicalNeedle = '/.agentic-plugins/state/founder/';
  const canonicalIndex = text.indexOf(canonicalNeedle);
  if (canonicalIndex >= 0) {
    return { home: 'canonical', repoRoot: text.slice(0, canonicalIndex) };
  }
  return null;
}

// -----------------------------------------------------------------------------
// ID generation per ADR-0011 §1

export function generateWorkflowId(verb, { now = new Date(), randomSource = randomBytes } = {}) {
  if (!VALID_VERBS.has(verb)) {
    throw new Error(`Invalid verb: ${verb}. Must be one of ${[...VALID_VERBS].join(', ')}`);
  }
  // ISO-8601 compact: YYYYMMDDTHHMMSSZ (ADR-0011 §1 examples)
  const iso = now.toISOString();                          // 2026-05-05T21:41:52.123Z
  const compact = iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const shortid = randomSource(3).toString('hex');
  return `${verb}-${compact}-${shortid}`;
}

// -----------------------------------------------------------------------------
// Lock ownership protocol per ADR-0011 §3

function generateOwnerToken({ randomSource = randomBytes } = {}) {
  const ns = hrtime.bigint().toString();
  const rand = randomSource(8).toString('hex');
  return `${pid}:${ns}:${rand}`;
}

async function pathStat(path) {
  try {
    return await stat(path);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Acquire a lock with O_EXCL fresh path, falling through to atomic
 * rename-based stale reclaim per ADR-0011 §3 (revised). Returns the
 * owner token written to the lock file on success.
 *
 * Stale reclaim: when the existing lock is confirmed stale (token
 * unchanged across a full STALE_THRESHOLD_MS window), the reclaimer
 * writes its own token to a uniquely-named tmp file in the same
 * directory and POSIX-renames it onto the lock path. POSIX rename(2)
 * atomically replaces the destination, so two concurrent reclaimers
 * are sequenced by the kernel — the last rename's token is what's on
 * disk. Each reclaimer reads back the lock contents: the winner sees
 * its own token and returns; the loser sees a different token and
 * loops to retry-wait. This avoids the unlink-then-acquire race where
 * a paused reclaimer would unlink the new owner's lock.
 *
 * @returns {Promise<string>} owner token written into the lock file
 */
async function acquireLock(lockPath, opts = {}) {
  const { now = Date.now, sleep = sleepMs, randomSource = randomBytes } = opts;
  const myToken = generateOwnerToken({ randomSource });

  const startedAt = now();
  let backoffMs = 50;

  while (true) {
    // 1. Fresh acquire path — O_EXCL on a non-existent lock.
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      handle = null;
    }
    if (handle) {
      try {
        await handle.writeFile(myToken, { encoding: 'utf8' });
        await handle.sync();
      } finally {
        await handle.close();
      }
      return myToken;
    }

    // 2. Lock exists — classify it.
    const status = await checkLockStaleness(lockPath, { now, sleep });
    if (status === 'gone') continue;                              // disappeared, retry fresh path
    if (status === 'stale') {
      // 3. Stale confirmed — atomic reclaim via tmpfile + rename.
      const reclaimed = await tryReclaimByRename(lockPath, myToken, { randomSource });
      if (reclaimed) return myToken;
      // Lost the rename race; treat as contention and back off.
    }

    if (now() - startedAt > RETRY_BACKOFF_MAX_MS) {
      throw new Error(
        `acquireLock: timeout after ${RETRY_BACKOFF_MAX_MS}ms holding lock ${lockPath}`,
      );
    }
    await sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 800);
  }
}

/**
 * Classify an existing lock as 'fresh' (recent mtime), 'stale' (token
 * unchanged across a full STALE_THRESHOLD_MS window — holder genuinely
 * crashed), 'progress' (token mutated mid-window — someone is alive),
 * or 'gone' (lock vanished while inspecting).
 */
async function checkLockStaleness(lockPath, { now, sleep }) {
  const st = await pathStat(lockPath);
  if (!st) return 'gone';
  const ageMs = now() - st.mtimeMs;
  if (ageMs < STALE_THRESHOLD_MS) return 'fresh';
  const t1 = await readFile(lockPath, 'utf8').catch(() => null);
  if (t1 === null) return 'gone';
  await sleep(STALE_THRESHOLD_MS);
  const t2 = await readFile(lockPath, 'utf8').catch(() => null);
  if (t2 === null) return 'gone';
  if (t1 !== t2) return 'progress';
  return 'stale';
}

/**
 * Try to atomically reclaim a stale lock by tmpfile + rename. Returns
 * true if the rename's resulting on-disk token matches our token (we
 * are now the lock holder); false if another reclaimer beat us in the
 * kernel's rename sequencing.
 *
 * Concurrent reclaimers are safe: rename(2) atomically replaces the
 * destination so neither unlinks the other's lock; the rename ordering
 * picks one winner deterministically.
 */
async function tryReclaimByRename(lockPath, myToken, { randomSource }) {
  const dir = dirname(lockPath);
  const reclaimTmp = join(
    dir,
    `.${basename(lockPath)}.${pid}.${randomSource(4).toString('hex')}.reclaim`,
  );
  try {
    await writeFile(reclaimTmp, myToken, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    process.stderr.write(`tryReclaimByRename: write tmp failed: ${err.message}\n`);
    return false;
  }
  try {
    await rename(reclaimTmp, lockPath);
  } catch (err) {
    try { await unlink(reclaimTmp); } catch {}
    process.stderr.write(`tryReclaimByRename: rename failed: ${err.message}\n`);
    return false;
  }
  let onDisk;
  try {
    onDisk = await readFile(lockPath, 'utf8');
  } catch {
    return false;
  }
  return onDisk === myToken;
}

/**
 * Release a lock. If the on-disk token does not match the acquirer's
 * token (another writer reclaimed the lock as stale), DO NOT unlink —
 * abort the in-flight operation per ADR-0011 §3. Returns true on clean
 * release, false on ownership mismatch.
 */
async function releaseLock(lockPath, ownerToken) {
  let onDisk;
  try {
    onDisk = await readFile(lockPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return true;                      // already gone — nothing to release
    throw err;
  }
  if (onDisk !== ownerToken) {
    process.stderr.write(
      `state.mjs: releaseLock detected ownership mismatch on ${lockPath} ` +
        `(expected ${ownerToken.slice(0, 16)}..., found ${onDisk.slice(0, 16)}...) — ` +
        `another writer reclaimed the lock as stale. In-flight write must NOT be committed.\n`,
    );
    return false;
  }
  try {
    await unlink(lockPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return true;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -----------------------------------------------------------------------------
// Atomic write — temp file + fsync + rename per ADR-0011 §3 step 3-5
//
// Uses a uniquely-named tmp file (per-PID + random) opened with O_EXCL
// to defeat both stale-tmp reuse and a crafted-symlink redirect through
// a fixed `<target>.tmp` slot.
//
// When `ownership` ({ lockPath, token }) is provided, re-verifies the
// on-disk lock token immediately before commit. A mismatch means the
// lock we acquired was reclaimed mid-write by another writer; we discard
// our tmp file and abort rather than overwrite the new owner's state.
// This closes the race where a paused writer's atomicWrite would otherwise
// rename in stale contents (CRITICAL #2 from Codex review of Stage 2 D).

async function atomicWrite(targetPath, contents, ownership = null) {
  const tmpPath = `${targetPath}.${pid}.${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(tmpPath, 'wx', 0o600);
  try {
    await handle.writeFile(contents, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (ownership) {
    const { lockPath, token } = ownership;
    const onDisk = await readFile(lockPath, 'utf8').catch(() => null);
    if (onDisk !== token) {
      try { await unlink(tmpPath); } catch {}
      throw new Error(
        `atomicWrite: ownership mismatch on ${lockPath} immediately before commit ` +
        `(expected token "${token.slice(0, 16)}...", found "${(onDisk ?? 'NONE').slice(0, 16)}..."). ` +
        `In-flight write to ${targetPath} discarded — another writer reclaimed the lock as stale.`,
      );
    }
  }
  await rename(tmpPath, targetPath);
}

// -----------------------------------------------------------------------------
// Directory + per-file lock wrappers

async function ensureDir(path, mode) {
  await mkdir(path, { recursive: true, mode });
}

/**
 * Run `fn` while holding the directory-level creation lock per ADR-0011 §3.
 * `fn` receives `{ lockPath, token }` so callers can pass ownership
 * info into `atomicWrite()` for the pre-commit recheck. The release
 * path is in finally — runs on every exit, including throws.
 */
export async function withDirectoryLock(repoRoot, fn, opts = {}) {
  const storage = opts.storage ?? await resolveWorkflowStorage(repoRoot, { mode: 'write' });
  await ensureDir(storage.workflows, 0o700);
  await ensureDir(dirname(storage.creationLock), 0o700);
  const lockPath = storage.creationLock;
  const token = await acquireLock(lockPath);
  let releaseOk = false;
  try {
    const result = await fn({ lockPath, token, storage });
    releaseOk = true;
    return result;
  } finally {
    const ownershipOk = await releaseLock(lockPath, token);
    if (releaseOk && !ownershipOk) {
      throw new Error(
        `withDirectoryLock: in-flight directory operation suspect — ` +
        `creation-lock was reclaimed as stale by another writer.`,
      );
    }
  }
}

/**
 * Run `fn` while holding the per-file lock for a workflow. `fn` receives
 * `{ lockPath, token }` so it can pass ownership into `atomicWrite()`
 * for pre-commit recheck. Used for appends / snapshot updates /
 * frontmatter edits to an existing workflow file.
 */
export async function withFileLock(workflowPath, fn) {
  const lockPath = fileLockPath(workflowPath);
  const token = await acquireLock(lockPath);
  let releaseOk = false;
  try {
    const result = await fn({ lockPath, token });
    releaseOk = true;
    return result;
  } finally {
    const ownershipOk = await releaseLock(lockPath, token);
    if (releaseOk && !ownershipOk) {
      throw new Error(
        `withFileLock: in-flight write to ${workflowPath} is suspect — ` +
          `lock was reclaimed as stale by another writer.`,
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Discovery — per-branch single-active invariant per ADR-0018 §sub-2
// (cascade of ADR-0011 §1; the directory-wide Stage 2 baseline is
// generalized to "exactly one workflow per branch").

/**
 * List workflow files (just `.md`, not `.md.lock` or `.md.tmp`) under
 * the workflows directory. Caller is responsible for holding the
 * directory-level lock if exclusivity matters.
 */
export async function listWorkflowFiles(repoRoot) {
  const storage = await resolveWorkflowStorage(repoRoot);
  const st = await pathStat(storage.workflows);
  if (!st) return [];
  let entries;
  try {
    entries = await readdir(storage.workflows);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((name) => name.endsWith('.md') && !name.endsWith('.md.tmp'))
    .map((name) => join(storage.workflows, name))
    .sort();
}

/**
 * List workflow files (`.md` only) branch-agnostically for the ADR-0031
 * Stop-archive orphan sweep: a terminal workflow orphaned by branch
 * deletion must be visible regardless of the current branch. founder
 * trim — only the canonical home exists (ADR-0036 SD5), so this walks a
 * single directory; the AllHomes name is kept for sibling API parity.
 * ENOENT is a clean skip.
 */
export async function listWorkflowFilesAllHomes(repoRoot) {
  const dirs = [
    workflowDir(repoRoot, { home: 'canonical' }),
  ];
  const files = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    for (const name of entries) {
      if (name.endsWith('.md') && !name.endsWith('.md.tmp')) files.push(join(dir, name));
    }
  }
  return files.sort();
}

/**
 * Classify a local branch ref: `'present'` | `'absent'` | `'unknown'`.
 *
 * `git show-ref --verify --quiet refs/heads/<branch>` exits 0 when the ref
 * exists and 1 when it is confirmed absent (clean miss). Any other failure
 * (git not on PATH → ENOENT, not a repo → 128, etc.) is `'unknown'`.
 *
 * The orphan sweep archives ONLY on `'absent'` (the branch was deleted, so the
 * terminal workflow can never archive via the branch-keyed Stop hook). A probe
 * failure (`'unknown'`) is treated conservatively — leave the workflow — so a
 * transient git error can never falsely archive a workflow whose branch may
 * still exist.
 */
export function branchRefState(repoRoot, branch) {
  if (typeof branch !== 'string' || branch.length === 0) return 'unknown';
  // Guard against malformed ref names FIRST: `git show-ref --verify --quiet`
  // exits 1 for BOTH a valid-but-missing ref AND an INVALID refname (spaces,
  // `..`, trailing `/`, `.lock`, etc.). Without this guard a corrupt stored
  // `git_baseline.branch` would misclassify as 'absent' and be swept.
  // `check-ref-format --branch` exits non-zero (128) for an invalid name and 0
  // for a valid one, isolating "invalid name" (→ unknown) from "valid + missing"
  // (the real 'absent' case). (Codex review P2.)
  try {
    execFileSync('git', ['check-ref-format', '--branch', branch], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    return 'unknown'; // invalid refname OR git probe failure → conservative
  }
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return 'present';
  } catch (err) {
    // The name is valid (guard above), so exit 1 here == ref confirmed absent.
    // Everything else (ENOENT no-git, 128 not-a-repo) stays unknown → conservative.
    return err && err.status === 1 ? 'absent' : 'unknown';
  }
}

/**
 * Probe the current git branch via `git branch --show-current`.
 *
 * Returns the branch name with only the transport `\n` trimmed —
 * ADR-0018 §sub-2 mandates byte-exact comparison, so any leading
 * or trailing whitespace inside the value is preserved verbatim.
 * Returns the empty string `''` when the repo is in detached-HEAD
 * state (git's documented behavior for `--show-current`) OR when
 * the probe fails for any reason (no git, not a repo, permission
 * error). Callers treat empty as "no branch context" and resolve to
 * null active workflow.
 */
export function currentGitBranch(repoRoot) {
  try {
    const buf = execFileSync('git', ['branch', '--show-current'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return String(buf).replace(/\n$/, '');
  } catch {
    return '';
  }
}

/**
 * Lightweight `git_baseline.branch` extractor — scans the YAML
 * frontmatter without invoking the full `parseWorkflowFile` so that
 * `findActiveWorkflowByBranch` can still classify a file as
 * cross-branch even when the frontmatter has unrelated structural
 * problems. Returns the unquoted branch string, or `null` if the
 * extractor cannot locate a `git_baseline:` block followed by a
 * `  branch:` line. The caller MUST treat `null` as "branch unknown"
 * — never as "different branch".
 */
function extractFrontmatterBranch(text) {
  const lines = String(text).split('\n');
  let inFm = false;
  let inGitBaseline = false;
  for (const line of lines) {
    if (line === '---') {
      if (!inFm) {
        inFm = true;
        continue;
      }
      // Frontmatter close — stop scanning even if branch not yet found.
      return null;
    }
    if (!inFm) continue;
    if (line === 'git_baseline:') {
      inGitBaseline = true;
      continue;
    }
    if (inGitBaseline) {
      const m = line.match(/^ {2}branch:\s*(.+)$/);
      if (m) {
        const raw = m[1].trim();
        // Frontmatter writers JSON-stringify all scalars (yamlScalar);
        // bare values are tolerated for hand-written test fixtures.
        if (raw.startsWith('"') && raw.endsWith('"')) {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        }
        return raw;
      }
      // Encountered a top-level (non-indented) key — out of the
      // git_baseline nested block.
      if (line && !line.startsWith('  ')) inGitBaseline = false;
    }
  }
  return null;
}

/**
 * Sanitize a path for inclusion in user-visible error messages.
 * Returns the basename in JSON-stringified form, which escapes
 * control characters / terminal escape sequences so an attacker-
 * controlled workflow filename cannot inject ANSI codes into hook
 * stderr or `cat "$FIND_ERR" >&2` output.
 */
function safeFilename(file) {
  return JSON.stringify(basename(file));
}

/**
 * Resolve the active workflow on a specific branch. Pure / no-lock —
 * MUST NOT acquire any lock so it is safe to call from inside
 * `createWorkflowUnderLock`, which already holds the directory lock.
 *
 * Behavior:
 *  - `branch` empty / null / undefined → return null (detached-HEAD
 *    equivalent; no branch context to anchor to).
 *  - 0 same-branch workflow files → return null.
 *  - 1 same-branch workflow file → return its absolute path.
 *  - ≥ 2 same-branch workflow files → throw.
 *
 * Malformed-file policy (sub-2 brainstorm decision: skip-malformed
 * with same-branch fail-closed):
 *  - Files whose lightweight branch extractor returns a value that
 *    does NOT match the queried branch are *cross-branch* (or have a
 *    different branch name) and are skipped silently — they cannot
 *    affect this branch's invariant.
 *  - Files whose lightweight extractor returns `null` are
 *    *branch-unknown*. The full `parseWorkflowFile` is then tried as
 *    a fallback. If that also throws, the function THROWS (fail
 *    closed) rather than skipping — a same-branch malformed file
 *    would otherwise let `createWorkflow` write a duplicate,
 *    bypassing the per-branch single-active invariant (Codex review
 *    P2).
 *  - `readFile` failure (permissions, FIFO, etc.) is also fail-closed
 *    for the same reason — branch identity is undeterminable.
 */
async function findActiveWorkflowByBranchInDir(dir, branch) {
  if (!branch) return null;
  const st = await pathStat(dir);
  if (!st) return null;
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const files = entries
    .filter((name) => name.endsWith('.md') && !name.endsWith('.md.tmp'))
    .map((name) => join(dir, name))
    .sort();
  const matching = [];
  for (const file of files) {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      throw new Error(
        `findActiveWorkflowByBranch: failed to read workflow file ${safeFilename(file)} ` +
          `(${err.code || err.message}). Cannot determine its branch — per-branch ` +
          `single-active invariant at risk (ADR-0018 §sub-2). Reconcile manually.`,
      );
    }
    const fmBranch = extractFrontmatterBranch(text);
    if (fmBranch !== null) {
      if (fmBranch === branch) matching.push(file);
      continue;
    }
    let fm;
    try {
      fm = parseWorkflowFile(text).frontmatter;
    } catch (err) {
      throw new Error(
        `findActiveWorkflowByBranch: cannot parse workflow file ${safeFilename(file)} ` +
          `(${err.message}). Branch identity is undeterminable — per-branch ` +
          `single-active invariant at risk (ADR-0018 §sub-2). Reconcile manually ` +
          `(repair or archive the file).`,
      );
    }
    if (
      fm &&
      fm.git_baseline &&
      typeof fm.git_baseline.branch === 'string' &&
      fm.git_baseline.branch === branch
    ) {
      matching.push(file);
    }
  }
  if (matching.length === 0) return null;
  if (matching.length === 1) return matching[0];
  throw new Error(
    `Per-branch single-active invariant violated: ${matching.length} workflow files on branch '${branch}'. ` +
      `ADR-0018 §sub-2 requires exactly one workflow per branch. ` +
      `Reconcile manually — keep one file, archive the rest.`,
  );
}

export async function findActiveWorkflowByBranch(repoRoot, branch) {
  if (!branch) return null;
  // founder trim — canonical home only; no legacy probe, no dual-home
  // ambiguity error (ADR-0036 SD5).
  return findActiveWorkflowByBranchInDir(
    workflowDir(repoRoot, { home: 'canonical' }),
    branch,
  );
}

/**
 * Find the active workflow file on the current git branch, or null.
 *
 * Auto-probes the branch via `currentGitBranch(repoRoot)` and
 * delegates to `findActiveWorkflowByBranch`. Detached HEAD or
 * unreadable git state both produce a null return (no active
 * workflow).
 *
 * ADR-0018 §sub-2 — branch identity is the source of truth for
 * "active". `git checkout <branch>` swaps the active workflow
 * automatically; `git stash` is tree-only and leaves the active
 * workflow unchanged because branch is unchanged.
 */
export async function findActiveWorkflow(repoRoot) {
  const branch = currentGitBranch(repoRoot);
  return findActiveWorkflowByBranch(repoRoot, branch);
}

// -----------------------------------------------------------------------------
// Frontmatter parse / serialize (schema=1)
//
// ADR-0011 §2 keys (in canonical order):
//   schema, workflow_id, persona, verb, profile, original_request,
//   started_at, updated_at, repo_root, git_baseline (branch/head/status_digest),
//   current_phase, next_action, tasks, host_history (list of {host, at, event}),
//   last_snapshot (at/trigger/status_digest, optional)

const FRONTMATTER_KEY_ORDER = [
  'schema',
  'workflow_id',
  'persona',
  'verb',
  'profile',
  'original_request',
  'started_at',
  'updated_at',
  'repo_root',
  'git_baseline',
  'current_phase',
  'next_action',
  'tasks',
  'host_history',
  'last_snapshot',
  // ADR-0017 schema 1.1 additions — all optional, additive.
  'latest_checkpoint',     // sub-decision 2
  'pending_ensemble',      // sub-decision 4 (paired with ensemble_results)
  'ensemble_results',      // sub-decision 4
  'terminal_marker',       // sub-decision 5
  'child_completions',     // sub-decision 5 (A4 transitive)
  // founder trim — the ADR-0019 cross-plugin parent-linkage keys
  // (parent_workflow / originating_subtask / parent_detached) are
  // intentionally absent: orchestrator→founder dispatch is ADR-0036
  // Non-Goal 3. A founder workflow file carrying those keys is treated
  // as an unknown-additive-key case by the forward-compat carrier.
  // ADR-0020 schema 1.1 workflow-shape discriminator (PR 2, additive).
  // Always-written at create-time with 'verb-chain' default; lifecycle
  // macro workflows (future `/founder:start`, ADR-0036 PR6) write 'start'.
  'workflow_type',
  // ADR-0028 §Layer-2 schema 1.2 commit_manifest (additive optional).
  // Written by recordComposedFile / recordRefineFile; consumed by
  // Phase 7 staging (Layer 3) to intersect against `git_changes`.
  'commit_manifest',
  // founder trim — ADR-0028 §P10 parent_writeback_at is absent (no
  // parent to write back to; ADR-0036 Non-Goal 3).
];

// ADR-0028 §Forward-compat (PR5) — invisible carrier for unknown additive
// frontmatter keys observed when a 1.x reader meets a 1.y file with y > x.
// The parser stashes `[{key, value, raw}]` in file-encounter order; the
// serializer re-emits them at the tail (after all known FRONTMATTER_KEY_ORDER
// entries, before the closing `---`). Symbol-keyed so `Object.keys(fm)`
// and `key in fm` checks remain blind to it — existing closed-schema gates
// (parseWorkflowFile post-loop and serializeFrontmatter trailing check) keep
// rejecting truly-malformed non-additive deviations without false-positives.
//
// Carrier entry shape: `{key, value, raw}`. `value` is the parsed scalar
// for consumer-side typed access (e.g., diagnostic `state.mjs read` JSON
// surfaces it as `_forward_compat_unknowns`). `raw` is the original
// post-colon line tail (verbatim YAML scalar literal) — the serializer
// emits `${key}: ${raw}` to round-trip byte-identical for inline forms
// the parseScalar/yamlScalar pipeline does not preserve (notably bare `[]`
// and `{}` which permissive-fallback to strings then re-emit as quoted).
//
// Scope: scalar inline values only. Block-style unknown keys (list-of-
// objects, nested object) remain rejected at parse time with a forward-
// compat-aware error message — the present additive precedents
// (`workflow_type`, `commit_manifest`, `parent_writeback_at`, …) are all
// scalars, and raw block-line preservation requires comment/indent fidelity
// outside the current parser's design (line-split-on-`\n`, no comment
// support).
//
// Position fidelity: tail-emit. The ADR §Forward-compat text describes
// "ideally in their original key-order position" as soft — all current
// known additive keys cluster at the end of FRONTMATTER_KEY_ORDER, so
// tail-emit matches the disk shape for every realistic 1.x → 1.y pair.
// A future midstream additive that breaks this assumption can revisit.
export const FORWARD_COMPAT_UNKNOWNS = Symbol('forward_compat_unknowns');

// The optional-key set across schemas 1.1 (ADR-0017 + ADR-0019 + ADR-0020)
// and 1.2 (ADR-0028 §Layer-2 `commit_manifest`) is enforced implicitly by
// `FRONTMATTER_KEY_ORDER` (closed-schema gate) + the per-field validators in
// `validateSchema11Fields`. A separately maintained "optional keys" set
// previously lived here as `SCHEMA_1_1_OPTIONAL_KEYS` but was unreferenced
// dead code (Codex peer review G4); deleting it removes a stale parallel
// source of truth.

// Per-entry field order for list-of-objects schema 1.1 frontmatter keys.
// The first field name doubles as the discriminator that opens a `- ` list
// item in the YAML emit; remaining fields are continuation lines.
// `host_history` is structurally similar but lives in schema 1; its key
// order stays inline in `serializeFrontmatter` for readability.
const ENTRY_KEYS_BY_LIST_KEY = Object.freeze({
  pending_ensemble: ['phase', 'ensemble_type', 'run_id', 'started_at'],
  ensemble_results: [
    'phase',
    'ensemble_type',
    'run_id',
    'verdict',
    'summary',
    'completed_at',
    'codex_session_id',
  ],
  child_completions: ['child_id', 'spawned_at', 'commit', 'closed_at'],
  // ADR-0028 §Layer-2 schema 1.2 — commit_manifest entries record which
  // verb sub-step touched each file so Phase 7 staging can intersect the
  // manifest against `git_changes`. All four keys are required at write
  // time (no optional subkeys); see OPTIONAL_ENTRY_KEYS_BY_LIST_KEY below.
  commit_manifest: ['path', 'phase', 'op', 'recorded_at'],
});

// Subkeys that may legitimately be missing per ADR-0017 + ADR-0028:
// - `child_completions[*].commit` and `.closed_at` — present only after
//   the child workflow terminates.
// - `ensemble_results[*].codex_session_id` — best-effort surface; nullable.
// - `commit_manifest[*]` — all keys required (no optional subkeys); the
//   record helpers fill all four at write time.
// Co-located with ENTRY_KEYS_BY_LIST_KEY so the two pieces of the spec
// stay together (Codex review M2 — schema-correctness perspective).
const OPTIONAL_ENTRY_KEYS_BY_LIST_KEY = Object.freeze({
  pending_ensemble: new Set(),
  ensemble_results: new Set(['codex_session_id']),
  child_completions: new Set(['commit', 'closed_at']),
  commit_manifest: new Set(),
});

function yamlScalar(value) {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot serialize non-finite number: ${value}`);
    }
    return String(value);
  }
  const s = String(value);
  // Force double-quoted scalar for safety — handles colons, hash, leading/trailing
  // whitespace, escape chars, multiline, anchors, tags, etc.
  // JSON string output is a valid YAML 1.2 double-quoted scalar.
  return JSON.stringify(s);
}

function serializeFrontmatter(fm) {
  const lines = ['---'];

  for (const key of FRONTMATTER_KEY_ORDER) {
    if (!(key in fm)) continue;
    const value = fm[key];

    if (key === 'git_baseline') {
      lines.push(`${key}:`);
      lines.push(`  branch: ${yamlScalar(value.branch)}`);
      lines.push(`  head: ${yamlScalar(value.head)}`);
      lines.push(`  status_digest: ${yamlScalar(value.status_digest)}`);
      continue;
    }

    if (key === 'last_snapshot') {
      lines.push(`${key}:`);
      lines.push(`  at: ${yamlScalar(value.at)}`);
      lines.push(`  trigger: ${yamlScalar(value.trigger)}`);
      lines.push(`  status_digest: ${yamlScalar(value.status_digest)}`);
      continue;
    }

    if (key === 'latest_checkpoint') {
      // ADR-0017 sub-decision 2 — block-style {at, summary} (last_snapshot pattern).
      lines.push(`${key}:`);
      lines.push(`  at: ${yamlScalar(value.at)}`);
      lines.push(`  summary: ${yamlScalar(value.summary)}`);
      continue;
    }

    if (key === 'terminal_marker') {
      // ADR-0017 sub-decision 5 — scalar boolean. Default off; gates auto-archive.
      // Refuse silent type coercion at the write boundary (Codex/Schema
      // review M5/M6) — a stringy "false" must NOT round-trip as `true`.
      if (typeof value !== 'boolean') {
        throw new Error(
          `terminal_marker must be a boolean (got ${typeof value} ${JSON.stringify(value)})`,
        );
      }
      lines.push(`${key}: ${yamlScalar(value)}`);
      continue;
    }

    if (
      key === 'pending_ensemble' ||
      key === 'ensemble_results' ||
      key === 'child_completions' ||
      key === 'commit_manifest'                                       // ADR-0028 §Layer-2
    ) {
      // ADR-0017 sub-decisions 4/5 + ADR-0028 §Layer-2 — list-of-objects
      // (host_history pattern).
      // Field order per entry is fixed below. Optional subkeys (per
      // OPTIONAL_ENTRY_KEYS_BY_LIST_KEY) whose value is `null` /
      // `undefined` are omitted from emit so the parsed shape preserves
      // the "absent vs explicitly null" distinction (Codex review MINOR
      // on yamlScalar(null) → empty string).
      if (!Array.isArray(value)) {
        throw new Error(`${key} must be an array, got ${typeof value}`);
      }
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        const entryKeys = ENTRY_KEYS_BY_LIST_KEY[key];
        const optional = OPTIONAL_ENTRY_KEYS_BY_LIST_KEY[key] ?? new Set();
        for (const entry of value) {
          // Determine the first field that has a non-null value — that
          // is the line that opens the list item with `- key: val`.
          // (Required keys must be present per validateFrontmatter, so
          // `entryKeys[0]` is always emittable in practice; the
          // null-skip rule only ever drops optional keys mid-entry.)
          let opened = false;
          for (const k of entryKeys) {
            const v = entry[k];
            if (v === null || v === undefined) {
              if (optional.has(k)) continue;
              // Required key missing — surface immediately rather than
              // emitting an empty placeholder that would silently pass
              // round-trip (Codex MAJOR M3/M4 — required field gate at
              // write boundary).
              throw new Error(
                `Missing required entry key ${key}[*].${k} ` +
                `(required by ADR-0017 / ADR-0028 §Layer-2)`,
              );
            }
            if (!opened) {
              lines.push(`  - ${k}: ${yamlScalar(v)}`);
              opened = true;
            } else {
              lines.push(`    ${k}: ${yamlScalar(v)}`);
            }
          }
        }
      }
      continue;
    }

    if (key === 'tasks') {
      // ADR-0011 §2 example shows `tasks: []` empty list at bootstrap.
      // Tasks-as-objects layout deferred — Stage 2 minimal stores task IDs only
      // as a flat string array. If non-empty, render as a YAML flow sequence.
      if (!Array.isArray(value)) {
        throw new Error(`tasks must be an array, got ${typeof value}`);
      }
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const t of value) {
          lines.push(`  - ${yamlScalar(t)}`);
        }
      }
      continue;
    }

    if (key === 'host_history') {
      if (!Array.isArray(value)) {
        throw new Error(`host_history must be an array, got ${typeof value}`);
      }
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const entry of value) {
          lines.push(`  - host: ${yamlScalar(entry.host)}`);
          lines.push(`    at: ${yamlScalar(entry.at)}`);
          lines.push(`    event: ${yamlScalar(entry.event)}`);
        }
      }
      continue;
    }

    lines.push(`${key}: ${yamlScalar(value)}`);
  }

  // ADR-0028 §Forward-compat (PR5) — re-emit unknown additive scalar keys
  // stashed by parseWorkflowFile. Tail position matches the disk shape for
  // every realistic 1.x → 1.y pair (all current known additives cluster at
  // the end of FRONTMATTER_KEY_ORDER); see the FORWARD_COMPAT_UNKNOWNS
  // declaration above for the position-fidelity rationale.
  //
  // Emit prefers `raw` (verbatim line tail from the parser) over re-
  // serializing `value` — this keeps inline `[]`, `{}`, and any future
  // YAML scalar literal that parseScalar/yamlScalar do not round-trip
  // byte-identical (Codex local review M2). When carrier entries are
  // constructed programmatically (no parser-side `raw`), fall back to
  // yamlScalar(value) — the value-type assumption is the same as for
  // known scalar keys (string/number/boolean).
  const unknowns = fm[FORWARD_COMPAT_UNKNOWNS];
  if (Array.isArray(unknowns)) {
    for (const entry of unknowns) {
      const { key, value, raw } = entry;
      const lineTail = typeof raw === 'string' ? raw : yamlScalar(value);
      lines.push(`${key}: ${lineTail}`);
    }
  }

  // Drop frontmatter keys not in canonical order — schemas 1, 1.1, 1.2, and
  // 1.3 are all closed (ADR-0011 §2 + ADR-0017 + ADR-0028). Unknown keys
  // that arrived through the structured carrier above are already emitted;
  // any remaining string-keyed unknowns indicate a hand-rolled caller error.
  for (const key of Object.keys(fm)) {
    if (!FRONTMATTER_KEY_ORDER.includes(key)) {
      throw new Error(
        `Unknown frontmatter key: ${key}. ADR-0011 §2 schema=1 / ADR-0017 schema=1.1 / ADR-0028 schema=1.2 / ADR-0028 PR3 schema=1.3 are closed; ADR-0028 §Forward-compat (PR5) routes scalar unknowns to FORWARD_COMPAT_UNKNOWNS Symbol carrier.`,
      );
    }
  }

  lines.push('---');
  return lines.join('\n');
}

/**
 * Parse the frontmatter block at the start of a workflow file. Returns
 * { frontmatter, body, frontmatterRaw }. Throws on malformed structure.
 *
 * The parser accepts only the shape produced by serializeFrontmatter
 * above — unknown keys throw, mis-indented blocks throw. This is a
 * round-trip parser, not a general YAML parser.
 */
export function parseWorkflowFile(text) {
  if (!text.startsWith('---\n')) {
    throw new Error('Missing frontmatter open delimiter (expected "---\\n" at file start).');
  }
  const after = text.slice(4);
  const closeIdx = after.indexOf('\n---\n');
  if (closeIdx === -1) {
    throw new Error('Missing frontmatter close delimiter (expected "\\n---\\n").');
  }
  const fmText = after.slice(0, closeIdx);
  const body = after.slice(closeIdx + 5);                          // skip "\n---\n"

  const fm = {};
  const lines = fmText.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line === '') {
      i += 1;
      continue;
    }
    if (line.startsWith('  ')) {
      throw new Error(`Unexpected indented line at top level: ${JSON.stringify(line)}`);
    }
    const colon = line.indexOf(':');
    if (colon === -1) {
      throw new Error(`Malformed frontmatter line: ${JSON.stringify(line)}`);
    }
    const key = line.slice(0, colon);
    let rest = line.slice(colon + 1);
    if (rest.startsWith(' ')) rest = rest.slice(1);

    if (rest === '') {
      // Block-style nested value
      if (
        key === 'git_baseline' ||
        key === 'last_snapshot' ||
        key === 'latest_checkpoint'                                  // ADR-0017 sub-2
      ) {
        const sub = {};
        i += 1;
        while (i < lines.length && lines[i].startsWith('  ') && !lines[i].startsWith('    ')) {
          const subLine = lines[i].slice(2);
          const subColon = subLine.indexOf(':');
          if (subColon === -1) {
            throw new Error(`Malformed nested frontmatter line: ${JSON.stringify(lines[i])}`);
          }
          const subKey = subLine.slice(0, subColon);
          let subVal = subLine.slice(subColon + 1);
          if (subVal.startsWith(' ')) subVal = subVal.slice(1);
          sub[subKey] = parseScalar(subVal);
          i += 1;
        }
        fm[key] = sub;
        continue;
      }
      if (
        key === 'host_history' ||
        key === 'tasks' ||
        key === 'pending_ensemble' ||                                // ADR-0017 sub-4
        key === 'ensemble_results' ||                                // ADR-0017 sub-4
        key === 'child_completions' ||                               // ADR-0017 sub-5
        key === 'commit_manifest'                                    // ADR-0028 §Layer-2
      ) {
        // Block-style list
        const list = [];
        i += 1;
        while (i < lines.length && lines[i].startsWith('  - ')) {
          const firstItemLine = lines[i].slice(4);
          if (firstItemLine.includes(': ')) {
            // Object item — collect contiguous indented lines
            const item = {};
            const fcolon = firstItemLine.indexOf(':');
            const fkey = firstItemLine.slice(0, fcolon);
            let fval = firstItemLine.slice(fcolon + 1);
            if (fval.startsWith(' ')) fval = fval.slice(1);
            item[fkey] = parseScalar(fval);
            i += 1;
            while (
              i < lines.length &&
              lines[i].startsWith('    ') &&
              !lines[i].startsWith('  - ')
            ) {
              const cont = lines[i].slice(4);
              const ccolon = cont.indexOf(':');
              if (ccolon === -1) {
                throw new Error(`Malformed list-item continuation: ${JSON.stringify(lines[i])}`);
              }
              const ck = cont.slice(0, ccolon);
              let cv = cont.slice(ccolon + 1);
              if (cv.startsWith(' ')) cv = cv.slice(1);
              item[ck] = parseScalar(cv);
              i += 1;
            }
            list.push(item);
          } else {
            // Scalar item
            list.push(parseScalar(firstItemLine));
            i += 1;
          }
        }
        fm[key] = list;
        continue;
      }
      // ADR-0028 §Forward-compat (PR5) — block-style unknown keys remain
      // rejected. The current parser is line-oriented (split on `\n`, no
      // comment handling), so verbatim raw-line preservation for a block
      // value requires structural changes outside this PR's scope.
      throw new Error(
        `Empty value for unrecognized block key: ${key}. ADR-0028 §Forward-compat read-tolerance supports scalar additive keys only; block-style unknown keys remain a closed-schema rejection.`,
      );
    }

    // Inline scalar
    if (
      rest === '[]' &&
      (key === 'tasks' ||
        key === 'host_history' ||
        key === 'pending_ensemble' ||                                // ADR-0017 sub-4
        key === 'ensemble_results' ||                                // ADR-0017 sub-4
        key === 'child_completions' ||                               // ADR-0017 sub-5
        key === 'commit_manifest')                                   // ADR-0028 §Layer-2
    ) {
      fm[key] = [];
      i += 1;
      continue;
    }
    // ADR-0028 §Forward-compat (PR5) — unknown scalar additive keys are
    // stashed under the Symbol carrier so the post-loop closed-schema gate
    // doesn't false-positive. Schema-version acceptance happens later in
    // validateFrontmatter via isSupportedSchema(); stashing here is
    // unconditional because we don't yet know fm.schema (the field may
    // appear after another key in file order). validateFrontmatter rejects
    // the entire file if the schema is non-1.x, which is the correct
    // boundary — closed-schema rejection still applies to non-additive
    // deviations and unknown majors per ADR-0028 §Forward-compat rule 3.
    //
    // Empty key gate (Codex local review m1) — `: value` produces
    // `key === ''`; reject explicitly so a malformed line cannot smuggle
    // a nameless entry into the carrier and round-trip out as invalid YAML.
    if (key === '') {
      throw new Error(
        `Empty frontmatter key (line ${i}). ADR-0011 §2 forbids nameless keys; ADR-0028 §Forward-compat (PR5) does not relax this.`,
      );
    }
    if (!FRONTMATTER_KEY_ORDER.includes(key)) {
      const carrier = fm[FORWARD_COMPAT_UNKNOWNS] ??= [];
      // Preserve the raw post-colon line tail so round-trip emit matches
      // the original byte-for-byte. parseScalar's permissive fallback
      // returns the string `'[]'` for an inline empty list, which would
      // re-emit as `"[]"` (quoted) and silently change a future minor's
      // list-typed additive into a string. The `raw` field bypasses that
      // round-trip; `value` retains the parsed form for consumer ergonomics.
      carrier.push({ key, value: parseScalar(rest), raw: rest });
      i += 1;
      continue;
    }
    fm[key] = parseScalar(rest);
    i += 1;
  }

  // Surface unknown keys per closed-schema rule. Schema 1.1 (ADR-0017) and
  // 1.2 (ADR-0028 §Layer-2 `commit_manifest`) expand the known set additively;
  // ADR-0028 §Forward-compat (PR5) routes scalar unknowns to the Symbol
  // carrier above so this gate only catches non-Symbol shape violations
  // (e.g., a directly-set fm['foo'] from a hand-rolled caller).
  for (const key of Object.keys(fm)) {
    if (!FRONTMATTER_KEY_ORDER.includes(key)) {
      throw new Error(
        `Unknown frontmatter key: ${key}. ADR-0011 §2 schema=1 / ADR-0017 schema=1.1 / ADR-0028 schema=1.2 / ADR-0028 PR3 schema=1.3 are closed; ADR-0028 §Forward-compat (PR5) routes scalar unknowns to FORWARD_COMPAT_UNKNOWNS Symbol carrier.`,
      );
    }
  }

  // Schema + required-field + nested-key validation per ADR-0011 §2.
  // Without this, future-schema or hand-edited workflow files could be
  // mutated and rewritten as if they were valid schema=1 (Codex Round 1
  // MAJOR #9 + #10).
  validateFrontmatter(fm);

  return { frontmatter: fm, body };
}

/**
 * Strict ADR-0011 §2 schema=1 / ADR-0017 schema=1.1 / ADR-0028 schema=1.2/1.3
 * validation. Called at parse-before-mutate boundaries. Throws on any
 * deviation from the closed schema set. Schemas 1.1 and 1.2 are additive;
 * the schema-1 required key set is unchanged, and 1.1/1.2 keys are all
 * optional.
 */
function validateFrontmatter(fm) {
  // ADR-0028 §Forward-compat (PR5) — accept via predicate, not closed Set.
  // The Set continues to enumerate explicitly-known minors for telemetry /
  // diagnostic purposes (and existing tests assert its contents); the
  // gate that the parser actually runs is the open-ended 1.x predicate.
  if (!isSupportedSchema(fm.schema)) {
    const knownMinors = [...SUPPORTED_SCHEMA_VERSIONS]
      .map((v) => JSON.stringify(v))
      .join(', ');
    throw new Error(
      `Unsupported schema version: ${JSON.stringify(fm.schema)}. ` +
      `ADR-0028 §Forward-compat accepts the number 1 (legacy) and any "1.y" minor; ` +
      `unknown majors (e.g., "2.0"), the bare string "1", and malformed minors are rejected. ` +
      `Explicitly-known minors as of this build: ${knownMinors}.`,
    );
  }
  const REQUIRED = [
    'schema', 'workflow_id', 'persona', 'verb', 'profile',
    'original_request', 'started_at', 'updated_at', 'repo_root',
    'git_baseline', 'current_phase', 'next_action', 'tasks', 'host_history',
  ];
  for (const k of REQUIRED) {
    if (!(k in fm)) {
      throw new Error(`Missing required frontmatter field: ${k}`);
    }
  }
  if (typeof fm.workflow_id !== 'string' || fm.workflow_id.length === 0) {
    throw new Error('workflow_id must be a non-empty string');
  }
  validateVerb(fm.verb);
  if (typeof fm.persona !== 'string') {
    throw new Error('persona must be a string');
  }

  // git_baseline nested keys
  validateNestedShape(fm, 'git_baseline', ['branch', 'head', 'status_digest']);

  // tasks
  if (!Array.isArray(fm.tasks)) {
    throw new Error('tasks must be an array');
  }

  // host_history list-of-objects
  if (!Array.isArray(fm.host_history)) {
    throw new Error('host_history must be an array');
  }
  const HH_KEYS = ['host', 'at', 'event'];
  for (let i = 0; i < fm.host_history.length; i++) {
    const entry = fm.host_history[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`host_history[${i}] must be an object`);
    }
    for (const k of Object.keys(entry)) {
      if (!HH_KEYS.includes(k)) {
        throw new Error(
          `Unknown nested key host_history[${i}].${k}. Expected: ${HH_KEYS.join(', ')}.`,
        );
      }
    }
    for (const k of HH_KEYS) {
      if (!(k in entry)) {
        throw new Error(`Missing nested key host_history[${i}].${k}`);
      }
    }
    validateHost(entry.host);
    validateHookEvent(entry.event);
  }

  // last_snapshot (optional)
  if ('last_snapshot' in fm) {
    validateNestedShape(fm, 'last_snapshot', ['at', 'trigger', 'status_digest']);
    validateSnapshotTrigger(fm.last_snapshot.trigger);
  }

  // ADR-0017 schema 1.1 optional fields. All gates are independent — a
  // schema-1 file with no ADR-0017 keys passes validation unchanged.
  validateSchema11Fields(fm);
}

/**
 * Validate the ADR-0017 schema-1.1 optional fields. Each field's nested
 * shape and value-types are checked when present. The function is silent
 * when a field is absent; ADR-0017 makes 1.1 keys optional.
 */
function validateSchema11Fields(fm) {
  if ('latest_checkpoint' in fm) {
    validateNestedShape(fm, 'latest_checkpoint', ['at', 'summary']);
    if (typeof fm.latest_checkpoint.at !== 'string') {
      throw new Error('latest_checkpoint.at must be a string');
    }
    if (typeof fm.latest_checkpoint.summary !== 'string') {
      throw new Error('latest_checkpoint.summary must be a string');
    }
  }

  if ('terminal_marker' in fm) {
    if (typeof fm.terminal_marker !== 'boolean') {
      throw new Error('terminal_marker must be a boolean');
    }
  }

  validateListOfObjectsField(fm, 'pending_ensemble');
  validateListOfObjectsField(fm, 'ensemble_results');
  validateListOfObjectsField(fm, 'child_completions');
  // ADR-0028 §Layer-2 schema 1.2
  validateListOfObjectsField(fm, 'commit_manifest');
  // founder trim — parent_writeback_at and the ADR-0019 parent-linkage
  // scalars (parent_workflow / originating_subtask / parent_detached)
  // are not founder schema keys (ADR-0036 Non-Goal 3); when present on
  // disk they fall through to the forward-compat unknown-key carrier
  // rather than validating here.

  // ADR-0020 PR 2 — workflow_type enum discriminator. Absence is
  // tolerant (read-time default 'verb-chain' applied by callers, e.g.,
  // resume.md drift report). When present, the value must match
  // VALID_WORKFLOW_TYPES.
  if ('workflow_type' in fm) {
    if (typeof fm.workflow_type !== 'string') {
      throw new Error('workflow_type must be a string');
    }
    if (!VALID_WORKFLOW_TYPES.has(fm.workflow_type)) {
      throw new Error(
        `workflow_type must be one of ${[...VALID_WORKFLOW_TYPES].join(', ')} (got ${JSON.stringify(fm.workflow_type)})`,
      );
    }
  }
}

/**
 * Per-list-key value-type checks. All schema 1.1 list-of-objects entries
 * carry string-shaped values (ISO timestamps, identifiers, free-form
 * summaries). Codex / schema review (Codex MINOR + Schema MAJOR) flagged
 * the absence of value-type validation: hand-edited or programmatic
 * callers could write numeric `run_id` or boolean `completed_at` and
 * still pass the shape gate.
 *
 * Each value gate accepts either `string` (the canonical case) or — for
 * subkeys explicitly nullable per ADR-0017 — `null` / `undefined`. The
 * function throws with a precise field path on type violation.
 */
function validateListOfObjectsValueTypes(key, idx, entry) {
  const optional = OPTIONAL_ENTRY_KEYS_BY_LIST_KEY[key] ?? new Set();
  for (const k of ENTRY_KEYS_BY_LIST_KEY[key]) {
    const v = entry[k];
    if (v === undefined || v === null) {
      // Optional subkeys may legitimately be absent or null.
      if (optional.has(k)) continue;
      // Required-key absence is caught by the presence loop in
      // `validateListOfObjectsField`; nothing to do here.
      continue;
    }
    if (typeof v !== 'string') {
      throw new Error(
        `${key}[${idx}].${k} must be a string (got ${typeof v} ${JSON.stringify(v)})`,
      );
    }
  }
}

/**
 * Validate a schema-1.1 list-of-objects optional field. The field's per-
 * entry key set is `ENTRY_KEYS_BY_LIST_KEY[key]`, which doubles as the
 * known-set check (no unknown subkeys; missing subkeys allowed only for
 * those marked optional below).
 *
 * Optional subkeys per ADR-0017:
 * - `child_completions[*].commit` and `.closed_at` — present only after
 *   the child workflow terminates.
 * - `ensemble_results[*].codex_session_id` — best-effort surface; nullable.
 */
function validateListOfObjectsField(fm, key) {
  if (!(key in fm)) return;
  const value = fm[key];
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array, got ${typeof value}`);
  }
  const expected = ENTRY_KEYS_BY_LIST_KEY[key];
  if (!expected) {
    throw new Error(`No entry-key spec for list-of-objects field ${key}`);
  }
  const expectedSet = new Set(expected);
  const optional = OPTIONAL_ENTRY_KEYS_BY_LIST_KEY[key] ?? new Set();
  for (let idx = 0; idx < value.length; idx++) {
    const entry = value[idx];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${key}[${idx}] must be an object`);
    }
    for (const k of Object.keys(entry)) {
      if (!expectedSet.has(k)) {
        throw new Error(
          `Unknown nested key ${key}[${idx}].${k}. Expected: ${expected.join(', ')}.`,
        );
      }
    }
    for (const k of expected) {
      if (optional.has(k)) continue;
      if (!(k in entry)) {
        throw new Error(`Missing nested key ${key}[${idx}].${k}`);
      }
    }
    validateListOfObjectsValueTypes(key, idx, entry);
  }
}

function validateNestedShape(fm, key, expectedKeys) {
  const value = fm[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }
  for (const k of Object.keys(value)) {
    if (!expectedKeys.includes(k)) {
      throw new Error(
        `Unknown nested key ${key}.${k}. Expected: ${expectedKeys.join(', ')}.`,
      );
    }
  }
  for (const k of expectedKeys) {
    if (!(k in value)) {
      throw new Error(`Missing nested key ${key}.${k}`);
    }
  }
}

function parseScalar(text) {
  if (text === '') return '';
  if (text.startsWith('"')) {
    // JSON-string-shaped double-quoted scalar (matches what yamlScalar produces).
    return JSON.parse(text);
  }
  // Bare integer (used for `schema: 1`)
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (text === 'true') return true;
  if (text === 'false') return false;
  // Permissive plain scalar — return as-is (used for `[]`, etc., handled by caller).
  return text;
}

// -----------------------------------------------------------------------------
// File assembly

export function assembleWorkflowFile(frontmatter, body) {
  const fmText = serializeFrontmatter(frontmatter);
  const trailingBody = body.endsWith('\n') ? body : `${body}\n`;
  return `${fmText}\n\n${trailingBody}`;
}

// -----------------------------------------------------------------------------
// Validation helpers

function validateHost(host) {
  if (!VALID_HOSTS.has(host)) {
    throw new Error(`Invalid host: ${host}. Must be one of ${[...VALID_HOSTS].join(', ')}`);
  }
}

function validateHookEvent(event) {
  if (!VALID_HOOK_EVENTS.has(event)) {
    throw new Error(`Invalid host_history event: ${event}.`);
  }
}

function validateSnapshotTrigger(trigger) {
  if (!VALID_SNAPSHOT_TRIGGERS.has(trigger)) {
    throw new Error(`Invalid snapshot trigger: ${trigger}.`);
  }
}

function validateVerb(verb) {
  if (!VALID_VERBS.has(verb)) {
    throw new Error(`Invalid verb: ${verb}.`);
  }
}

function isoUtc(now = new Date()) {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// -----------------------------------------------------------------------------
// Secret scrubbing per ADR-0011 §2 field rules

const SECRET_PATTERNS = [
  // AWS access keys (AKIA / ASIA + 16 alphanum)
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  // GitHub classic tokens (ghp_ / gho_ / ghu_ / ghs_ / ghr_ + 36+ alphanum)
  /\bgh[poushr]_[A-Za-z0-9]{36,}\b/g,
  // GitHub fine-grained PAT (github_pat_ + 22 + _ + 59 chars)
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  // OpenAI / Anthropic / generic prefixed API keys (sk-, sk-ant-, sk-proj-)
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  // Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-)
  /\bxox[bpar]-[A-Za-z0-9-]{10,}\b/g,
  // Generic 32+ hex bearer tokens (heuristic — long pure-hex strings)
  /\b[a-fA-F0-9]{32,}\b/g,
];

export function scrubSecrets(text) {
  let out = String(text);
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '<redacted>');
  }
  return out;
}

export function singleLine(text) {
  return String(text).replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

// -----------------------------------------------------------------------------
// Public API: createWorkflow

/**
 * Create a new workflow under the directory-level lock per ADR-0011 §3.
 * Throws if any workflow already exists (single-active invariant).
 *
 * Caller is expected to hold the directory lock. Use createWorkflow()
 * for the lock-wrapped variant. The `ownership` object (when provided)
 * carries the directory-lock token and is forwarded to `atomicWrite()`
 * for pre-commit recheck.
 */
export async function createWorkflowUnderLock({
  repoRoot,
  verb,
  persona = 'founder',
  profile = '',
  originalRequest,
  gitBaseline,
  host,
  currentPhase = 'phase-0',
  nextAction = '',
  bodyTitle,
  // founder trim — no parentWorkflow / originatingSubtask create
  // options: orchestrator→founder dispatch is ADR-0036 Non-Goal 3.
  // ADR-0020 PR 2 — workflow-shape discriminator. Always-written at
  // create-time (default 'verb-chain') so every new workflow is
  // self-describing. workflow_type is a primary discriminator, not a
  // presence flag; the future `/founder:start` macro passes 'start'.
  workflowType = 'verb-chain',
  now = new Date(),
}, ownership = null) {
  validateVerb(verb);
  validateHost(host);
  // ADR-0020 PR 2 — eager workflow_type enum check so CLI callers get a
  // clear error before the file lands. validateSchema11Fields re-checks
  // on the parse round-trip; this is the create-time guard.
  if (typeof workflowType !== 'string' || !VALID_WORKFLOW_TYPES.has(workflowType)) {
    throw new Error(
      `workflow_type must be one of ${[...VALID_WORKFLOW_TYPES].join(', ')} (got ${JSON.stringify(workflowType)})`,
    );
  }
  if (!gitBaseline || !gitBaseline.branch || !gitBaseline.head) {
    throw new Error('gitBaseline must have { branch, head, status_digest }');
  }
  if (typeof gitBaseline.branch !== 'string') {
    throw new Error(
      `gitBaseline.branch must be a string (got ${typeof gitBaseline.branch} ${JSON.stringify(gitBaseline.branch)})`,
    );
  }
  // ADR-0018 §sub-2 — same-branch single-active invariant. Caller is
  // expected to be inside `withDirectoryLock`, so use the no-lock
  // resolver variant to avoid deadlock against ourselves.
  const existing = await findActiveWorkflowByBranch(repoRoot, gitBaseline.branch);
  if (existing) {
    throw new Error(
      `Cannot create workflow — a workflow already exists on branch '${gitBaseline.branch}' (${existing}). ` +
        `Per-branch single-active invariant (ADR-0018 §sub-2). ` +
        `Resume with /founder:resume on this branch, or archive the existing workflow first.`,
    );
  }

  const workflowId = generateWorkflowId(verb, { now });
  const nowIso = isoUtc(now);
  const scrubbedRequest = singleLine(scrubSecrets(originalRequest ?? ''));

  const frontmatter = {
    schema: SCHEMA_VERSION,
    workflow_id: workflowId,
    persona,
    verb,
    profile,
    original_request: scrubbedRequest,
    started_at: nowIso,
    updated_at: nowIso,
    repo_root: repoRoot,
    git_baseline: {
      branch: gitBaseline.branch,
      head: gitBaseline.head,
      status_digest: gitBaseline.status_digest ?? '',
    },
    current_phase: currentPhase,
    next_action: nextAction,
    tasks: [],
    host_history: [
      { host, at: nowIso, event: 'created' },
    ],
    // ADR-0020 PR 2 — always-write the workflow_type discriminator so
    // every new workflow is self-describing. Default 'verb-chain' for
    // verb commands; the future `/founder:start` macro overrides with 'start'.
    workflow_type: workflowType,
  };

  const title = bodyTitle ?? `${persona}:${verb}`;
  const body =
    `# ${title}\n\n` +
    `## Original Request\n\n` +
    `${scrubbedRequest || '(no original request recorded)'}\n\n` +
    `## Phase notes\n\n` +
    `### ${currentPhase}\n\n`;

  const storage = ownership?.storage ?? await resolveWorkflowStorage(repoRoot, { mode: 'write' });
  const filePath = workflowFilePath(repoRoot, workflowId, { home: storage.home });
  await ensureDir(storage.workflows, 0o700);
  await atomicWrite(filePath, assembleWorkflowFile(frontmatter, body), ownership);

  return { workflowId, filePath, frontmatter, body };
}

export async function createWorkflow(args) {
  return withDirectoryLock(args.repoRoot, ({ lockPath, token, storage }) =>
    createWorkflowUnderLock(args, { lockPath, token, storage }),
  );
}

// -----------------------------------------------------------------------------
// Public API: appendPhase
//
// Append a new phase note to an existing workflow's body. Updates
// frontmatter `verb`, `current_phase`, `next_action`, `updated_at`,
// optionally `profile`, and appends a `host_history` entry.

export async function appendPhase({
  workflowPath,
  host,
  verb,
  profile,
  phaseLabel,
  phaseNote,
  currentPhase,
  nextAction,
  event = 'resumed',
  now = new Date(),
}) {
  validateHost(host);
  validateHookEvent(event);
  if (verb !== undefined) validateVerb(verb);

  return withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    const nowIso = isoUtc(now);

    if (verb !== undefined) frontmatter.verb = verb;
    if (profile !== undefined) frontmatter.profile = profile;
    if (currentPhase !== undefined) frontmatter.current_phase = currentPhase;
    if (nextAction !== undefined) frontmatter.next_action = nextAction;
    frontmatter.updated_at = nowIso;
    frontmatter.host_history = [
      ...(frontmatter.host_history ?? []),
      { host, at: nowIso, event },
    ];

    const heading = phaseLabel ? `### ${phaseLabel}\n\n` : '';
    const note = phaseNote ? `${phaseNote}\n\n` : '';
    const newBody = `${body}${heading}${note}`;

    await atomicWrite(
      workflowPath,
      assembleWorkflowFile(frontmatter, newBody),
      { lockPath, token },
    );
    return { frontmatter, workflowPath };
  });
}

// -----------------------------------------------------------------------------
// Public API: snapshot — used by hooks per ADR-0011 §4

export async function snapshot({
  workflowPath,
  host,
  trigger,
  statusDigest,
  now = new Date(),
}) {
  validateHost(host);
  validateSnapshotTrigger(trigger);

  return withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    const nowIso = isoUtc(now);

    frontmatter.updated_at = nowIso;
    frontmatter.last_snapshot = {
      at: nowIso,
      trigger,
      status_digest: statusDigest ?? '',
    };
    frontmatter.host_history = [
      ...(frontmatter.host_history ?? []),
      { host, at: nowIso, event: 'snapshot' },
    ];

    await atomicWrite(
      workflowPath,
      assembleWorkflowFile(frontmatter, body),
      { lockPath, token },
    );
    return { frontmatter, workflowPath };
  });
}

// -----------------------------------------------------------------------------
// Public API: read

export async function readWorkflow(workflowPath) {
  const text = await readFile(workflowPath, 'utf8');
  return parseWorkflowFile(text);
}

// -----------------------------------------------------------------------------
// ADR-0017 schema 1.1 helpers — checkpoint, ensemble bookkeeping, archive
//
// All mutation helpers acquire `withFileLock` for the workflow file and
// route every disk write through `atomicWrite` so the ownership-token
// recheck (Phase 6 fix #2) still applies.

/**
 * Apply the ADR-0017 §sub-decision-4 retention cap to an `ensemble_results`
 * list. Sorts oldest→newest by `completed_at` and trims to `cap`. The
 * input array is **not** mutated; a new array is returned.
 *
 * @param {Array<object>} entries
 * @param {number} cap
 * @returns {Array<object>}
 */
export function pruneEnsembleResults(entries, cap = ENSEMBLE_RESULTS_RETENTION_CAP) {
  if (!Array.isArray(entries)) {
    throw new Error('pruneEnsembleResults: entries must be an array');
  }
  if (!Number.isInteger(cap) || cap < 0) {
    throw new Error(`pruneEnsembleResults: cap must be a non-negative integer (got ${cap})`);
  }
  if (entries.length <= cap) return [...entries];
  const sorted = [...entries].sort((a, b) => {
    const ka = a?.completed_at ?? '';
    const kb = b?.completed_at ?? '';
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
  return sorted.slice(sorted.length - cap);
}

/**
 * ADR-0017 §sub-decision 4 — record a pending ensemble dispatch.
 *
 * Idempotency: if an entry with the same `run_id` already exists in
 * `pending_ensemble`, it is replaced (not duplicated). This keeps
 * dispatch-side retries safe and prevents the pending list from growing
 * unboundedly under restart loops.
 *
 * Required fields are validated at the call boundary (Codex review M3 —
 * partial entries with empty phase / ensemble_type would otherwise pass
 * silently and corrupt drift / retrospection queries).
 */
export async function recordPendingEnsemble({
  workflowPath,
  phase,
  ensemble_type,
  run_id,
  started_at,
  now = new Date(),
}) {
  for (const [name, val] of [
    ['phase', phase],
    ['ensemble_type', ensemble_type],
    ['run_id', run_id],
  ]) {
    if (typeof val !== 'string' || val.length === 0) {
      throw new Error(
        `recordPendingEnsemble: ${name} must be a non-empty string (got ${JSON.stringify(val)})`,
      );
    }
  }
  // Codex re-review M-3: reject non-string `started_at` so the writer
  // does not produce a file the next reader will reject (yamlScalar
  // would happily emit a number, but validateListOfObjectsValueTypes
  // requires string on read).
  if (started_at !== undefined && typeof started_at !== 'string') {
    throw new Error(
      `recordPendingEnsemble: started_at must be a string (got ${typeof started_at})`,
    );
  }
  return withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    const nowIso = isoUtc(now);
    const entry = {
      phase,
      ensemble_type,
      run_id,
      started_at: started_at ?? nowIso,
    };
    const existing = Array.isArray(frontmatter.pending_ensemble)
      ? frontmatter.pending_ensemble.filter((e) => e.run_id !== run_id)
      : [];
    frontmatter.pending_ensemble = [...existing, entry];
    frontmatter.updated_at = nowIso;
    await atomicWrite(
      workflowPath,
      assembleWorkflowFile(frontmatter, body),
      { lockPath, token },
    );
    return { frontmatter, workflowPath };
  });
}

/**
 * ADR-0017 §sub-decision 4 — commit an ensemble result via the prescribed
 * three-step atomic mutation in a single `withFileLock` window:
 *
 *   1. Pop the matching `pending_ensemble` entry (by `run_id`).
 *   2. Append `result` to `ensemble_results`.
 *   3. Prune `ensemble_results` to `ENSEMBLE_RESULTS_RETENTION_CAP`.
 *
 * Idempotency: if an `ensemble_results` entry with the same `run_id`
 * already exists, the second commit is a no-op for the results list (the
 * matching pending entry is still removed if present).
 */
export async function commitEnsemble({
  workflowPath,
  run_id,
  phase,
  ensemble_type,
  verdict,
  summary,
  completed_at,
  codex_session_id = null,
  cap = ENSEMBLE_RESULTS_RETENTION_CAP,
  now = new Date(),
}) {
  // Required field validation at the call boundary (Codex review M4 —
  // partial commits with empty verdict / summary would otherwise corrupt
  // retrospective ensemble-quality queries).
  for (const [name, val] of [
    ['run_id', run_id],
    ['phase', phase],
    ['ensemble_type', ensemble_type],
    ['verdict', verdict],
    ['summary', summary],
  ]) {
    if (typeof val !== 'string' || val.length === 0) {
      throw new Error(
        `commitEnsemble: ${name} must be a non-empty string (got ${JSON.stringify(val)})`,
      );
    }
  }
  if (
    codex_session_id !== null &&
    codex_session_id !== undefined &&
    typeof codex_session_id !== 'string'
  ) {
    throw new Error(
      `commitEnsemble: codex_session_id must be string|null (got ${typeof codex_session_id})`,
    );
  }
  // Codex re-review M-3: reject non-string `completed_at` for the same
  // reason as recordPendingEnsemble's started_at gate.
  if (completed_at !== undefined && typeof completed_at !== 'string') {
    throw new Error(
      `commitEnsemble: completed_at must be a string (got ${typeof completed_at})`,
    );
  }
  return withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    const nowIso = isoUtc(now);

    // Step 1: pop matching pending (no-op if missing).
    const pending = Array.isArray(frontmatter.pending_ensemble)
      ? frontmatter.pending_ensemble
      : [];
    frontmatter.pending_ensemble = pending.filter((e) => e.run_id !== run_id);

    // Step 2: append result idempotently.
    const existing = Array.isArray(frontmatter.ensemble_results)
      ? frontmatter.ensemble_results
      : [];
    const alreadyCommitted = existing.some((e) => e.run_id === run_id);
    let next;
    if (alreadyCommitted) {
      next = existing;
    } else {
      const entry = {
        phase,
        ensemble_type,
        run_id,
        verdict,
        summary,
        completed_at: completed_at ?? nowIso,
        codex_session_id,
      };
      next = [...existing, entry];
    }

    // Step 3: prune.
    frontmatter.ensemble_results = pruneEnsembleResults(next, cap);
    frontmatter.updated_at = nowIso;

    await atomicWrite(
      workflowPath,
      assembleWorkflowFile(frontmatter, body),
      { lockPath, token },
    );
    return { frontmatter, workflowPath, idempotentSkip: alreadyCommitted };
  });
}

// -----------------------------------------------------------------------------
// ADR-0028 §Layer-2 — commit_manifest record helpers (T3b)
//
// SCOPE — wiring-pending notice (Codex critique M1):
// These helpers ship the WRITE primitive for `commit_manifest`. The
// compose/refine command flows (`commands/compose.md` + `commands/refine.md`)
// do NOT yet invoke them — that wiring is the responsibility of a follow-up
// PR co-landing with the ADR-0028 §Layer-3 Phase 7 driver
// (the future founder phase7-commit driver, ADR-0036 PR6). Until that PR lands,
// `frontmatter.commit_manifest` will be empty on every workflow, and
// Phase 7 Layer 3's `manifest_paths = []` branch will trigger the
// "ASK the user to approve all of git_changes" fallback path. This split
// is intentional per ADR-0028 §Layer-3 PR sequencing: Layer 2 helpers
// land first so the schema migration is non-breaking; Layer 3 ships the
// staging logic and the command-side Write/Edit hooks atomically together.
//
// Command-mode boundary (per `skills/compose/SKILL.md` line 148 +
// `skills/refine/SKILL.md` line 156): the workflow file is mutated only
// when the verb skill is invoked as a sub-step of a founder workflow
// command. The helpers respect that boundary by no-op'ing when
// `workflowPath` is falsy — the CLI shim passes `--workflow-path "$ACTIVE"`
// verbatim, and `$ACTIVE` is empty when no founder workflow is on the
// current branch. Standalone invocations therefore do not mutate.
//
// Append-only and non-deduplicating: a path may legitimately be touched
// in compose, edited in refine, and then re-edited in another refine
// sub-step. The Phase 7 staging gate (Layer 3) reads the union of
// `commit_manifest` paths via `frontmatter.commit_manifest.map(e => e.path)`
// and intersects with `git_changes`, so duplicate entries are harmless
// and accurately reflect provenance.
//
// Pathspec injection defense (Codex critique M2 + Refine-verify N1):
// `path` is stored verbatim for Phase 7 Layer 3 to consume via
// `git add <path>`. The four checks (leading `-` / `:` / `/`, `..`
// traversal) live in the shared `assertSafePath` helper at
// `plugins/founder/scripts/validate-commit.mjs` so the WRITE boundary
// here and the Layer 3 READ-side gate in `phase7-commit.mjs` share a
// single source of truth (PR1 N1 deferral closure, ADR-0028 §Layer-3).
//
// READ-side defense — Layer 3 re-validation contract: the parser
// (`parseWorkflowFile` + `validateListOfObjectsField`) does NOT re-run
// the four pathspec checks on entries READ BACK from disk. A workflow
// file that is hand-edited or originated outside the helper code path
// can therefore carry a malicious `path` value. Layer 3's Phase 7
// staging code (the future founder phase7-commit driver) MUST
// re-validate each `commit_manifest[*].path` (via the same
// `assertSafePath`) before passing to `git add`. The read-side parser
// stays permissive so legitimate user edits (e.g., fixing a typo in
// `path`) keep working; write-side hardening + Layer 3 re-validation
// is the two-layer defense.
//
// Legacy-schema policy (Codex compose-time review G2): a workflow file on
// the disk-recorded schema `"1.1"` is permitted to receive a
// `commit_manifest` entry without bumping the schema marker. ADR-0017
// §"Schema versioning policy" mandates that mutation helpers preserve the
// disk-recorded schema (no silent promotion); the parser tolerantly accepts
// the 1.2-only key on a 1.1 file because `FRONTMATTER_KEY_ORDER` is the
// single closed-schema gate (not the schema-version field). This preserves
// in-flight workflow UX — a 1.1 workflow bootstrapped before the emit bump
// (a5cbace) can still call into Phase 7 helpers without an explicit upgrade
// step. Tools that key on the literal `schema === "1.2"` marker to detect
// feature availability should instead probe `'commit_manifest' in frontmatter`.
// -----------------------------------------------------------------------------

const VALID_MANIFEST_OPS = new Set(['create', 'edit']);

async function recordManifestEntry({
  workflowPath,
  path: filePath,
  op,
  phase,
  recorded_at,
  now,
}) {
  // Command-mode boundary — see helper-section header above.
  if (workflowPath === undefined || workflowPath === null || workflowPath === '') {
    return { skipped: true, reason: 'no-active-workflow' };
  }
  // Pathspec injection defense — shared helper covers the four checks
  // (leading `-`, leading `:`, absolute, `..` traversal). The same helper
  // is re-used by phase7-commit.mjs's read-side pre-stage gate so the
  // hardening lives in one place (ADR-0028 N1 — PR1 deferral promoted to
  // shared via validate-commit.mjs#assertSafePath).
  try {
    assertSafePath(filePath);
  } catch (err) {
    // Preserve the original recordManifestEntry-prefixed error surface
    // (test assertions and external callers key on this).
    throw new Error(
      `recordManifestEntry: ${err.message.replace(/^assertSafePath:\s*/, '')}`,
    );
  }
  if (!VALID_MANIFEST_OPS.has(op)) {
    throw new Error(
      `recordManifestEntry: op must be one of ${[...VALID_MANIFEST_OPS].join(', ')} (got ${JSON.stringify(op)})`,
    );
  }
  if (recorded_at !== undefined && typeof recorded_at !== 'string') {
    throw new Error(
      `recordManifestEntry: recorded_at must be a string (got ${typeof recorded_at})`,
    );
  }
  return withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    const nowIso = isoUtc(now ?? new Date());
    const entry = {
      path: filePath,
      phase,
      op,
      recorded_at: recorded_at ?? nowIso,
    };
    const existing = Array.isArray(frontmatter.commit_manifest)
      ? frontmatter.commit_manifest
      : [];
    frontmatter.commit_manifest = [...existing, entry];
    frontmatter.updated_at = nowIso;
    await atomicWrite(
      workflowPath,
      assembleWorkflowFile(frontmatter, body),
      { lockPath, token },
    );
    return { frontmatter, workflowPath, entry };
  });
}

/**
 * ADR-0028 §Layer-2 — append a `{path, phase: 'compose', op, recorded_at}`
 * entry to `commit_manifest`. Called by `commands/compose.md` after a
 * Write/Edit during a workflow-command sub-step; no-ops when
 * `workflowPath` is empty (standalone-invocation boundary).
 */
export async function recordComposedFile({ workflowPath, path, op, recorded_at, now } = {}) {
  return recordManifestEntry({
    workflowPath,
    path,
    op,
    phase: 'compose',
    recorded_at,
    now,
  });
}

/**
 * ADR-0028 §Layer-2 — append a `{path, phase: 'refine', op, recorded_at}`
 * entry to `commit_manifest`. Called by `commands/refine.md` after a
 * Write/Edit during a workflow-command sub-step; no-ops when
 * `workflowPath` is empty (standalone-invocation boundary).
 */
export async function recordRefineFile({ workflowPath, path, op, recorded_at, now } = {}) {
  return recordManifestEntry({
    workflowPath,
    path,
    op,
    phase: 'refine',
    recorded_at,
    now,
  });
}

// founder trim — the ADR-0028 §P10 setParentWritebackMarker /
// clearParentWritebackMarker pair is removed: founder workflows have no
// parent to write back to (ADR-0036 Non-Goal 3).

/**
 * ADR-0017 §sub-decision 2 — set `latest_checkpoint` and append a
 * `checkpointed` `host_history` entry under the per-file lock.
 */
export async function setCheckpoint({
  workflowPath,
  host,
  summary,
  now = new Date(),
}) {
  validateHost(host);
  if (typeof summary !== 'string' || summary.length === 0) {
    throw new Error('setCheckpoint: summary must be a non-empty string');
  }
  return withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    const nowIso = isoUtc(now);
    frontmatter.latest_checkpoint = { at: nowIso, summary };
    frontmatter.updated_at = nowIso;
    frontmatter.host_history = [
      ...(frontmatter.host_history ?? []),
      { host, at: nowIso, event: 'checkpointed' },
    ];
    await atomicWrite(
      workflowPath,
      assembleWorkflowFile(frontmatter, body),
      { lockPath, token },
    );
    return { frontmatter, workflowPath };
  });
}

/**
 * ADR-0017 §sub-decision 5 — atomic terminal-phase write.
 *
 * Sets `current_phase`, optionally `next_action`, optionally
 * `terminal_marker`, and appends a `host_history` entry — all under one
 * file-lock window. This avoids the Stop-vs-finalization race where Stop
 * could fire between a `current_phase = "commit-complete"` write and a
 * separate `terminal_marker = true` write.
 */
export async function setTerminal({
  workflowPath,
  host,
  terminalPhase,
  terminalMarker = true,
  nextAction,
  event = 'updated',
  now = new Date(),
}) {
  validateHost(host);
  validateHookEvent(event);
  if (!TERMINAL_PHASES.has(terminalPhase)) {
    const allowed = [...TERMINAL_PHASES].join(', ');
    throw new Error(
      `setTerminal: terminalPhase ${JSON.stringify(terminalPhase)} not in whitelist (${allowed})`,
    );
  }
  // Boolean-strict at the JS API boundary too — Codex review M5 flagged
  // that `Boolean("false")` silently flipped the auto-archive gate.
  if (typeof terminalMarker !== 'boolean') {
    throw new Error(
      `setTerminal: terminalMarker must be a boolean (got ${typeof terminalMarker} ${JSON.stringify(terminalMarker)})`,
    );
  }
  return withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    const nowIso = isoUtc(now);
    frontmatter.current_phase = terminalPhase;
    if (nextAction !== undefined) frontmatter.next_action = nextAction;
    frontmatter.terminal_marker = terminalMarker;
    frontmatter.updated_at = nowIso;
    frontmatter.host_history = [
      ...(frontmatter.host_history ?? []),
      { host, at: nowIso, event },
    ];
    await atomicWrite(
      workflowPath,
      assembleWorkflowFile(frontmatter, body),
      { lockPath, token },
    );
    return { frontmatter, workflowPath };
  });
}

/**
 * ADR-0017 §sub-decision 5 — move a workflow file out of the live
 * `workflows/` directory into `archive/`. Acquires the directory lock
 * first, then the per-file lock (creation precedent: dir → file).
 *
 * Collision policy: when the canonical destination
 * `<archiveDir>/<basename>` already exists, append a sub-second-precision
 * suffix and probe again until a free name is found:
 * `<basename-without-ext>-<isoCompact>-<6-hex>.md`. The hex randomizer
 * defeats two concurrent archives that land on the same iso-second.
 *
 * Idempotency: if `workflowPath` is already absent at directory-lock
 * acquire (or vanishes before the inner file lock), the helper resolves
 * cleanly with `{archived: false, reason: 'source-missing'|...}`.
 *
 * Durability: the move uses `atomicWrite` to the **destination** path
 * (with a fresh ownership lock on the destination), then `unlink`s the
 * source. This avoids the failure mode where a `rename` after the source
 * was already history-mutated leaves a stale `archived` event in the
 * source (Codex review M3, Concurrency review M3). It also closes the
 * Codex CRITICAL race window where a stalled rename could cross-rename a
 * reclaimed peer's active workflow into archive — the destination write
 * goes through its own lock, and the source is removed only after the
 * destination is durably committed.
 *
 * @param {object}  args
 * @param {string}  args.workflowPath
 * @param {string}  args.host
 * @param {string}  [args.repoRoot] — required if `archiveDirectory` is omitted
 * @param {string}  [args.archiveDirectory]
 * @param {Date}    [args.now]
 * @returns {Promise<{archived: boolean, from?: string, to?: string, host?: string, reason?: string, workflowPath?: string}>}
 */
export async function archiveWorkflow({
  workflowPath,
  host,
  repoRoot,
  archiveDirectory,
  now = new Date(),
}) {
  validateHost(host);
  if (!repoRoot && !archiveDirectory) {
    throw new Error('archiveWorkflow: repoRoot or archiveDirectory is required');
  }
  const inferred = inferStorageFromWorkflowPath(workflowPath);
  const effectiveRepoRoot = repoRoot ?? inferred?.repoRoot;
  const sourceHome = inferred?.home ?? 'canonical';
  const sourceStorage = effectiveRepoRoot ? statePaths(effectiveRepoRoot, sourceHome) : null;
  const targetDir = archiveDirectory ?? archiveDir(effectiveRepoRoot, { home: sourceHome });
  const baseName = basename(workflowPath);

  // The directory lock must hash to the same `.creation-lock` path
  // `withDirectoryLock`/`createWorkflow` use for the source state home.
  // When the caller provided only `archiveDirectory`, derive the repoRoot
  // from the four-deep workflow layout
  // (`<repoRoot>/<state-home>/workflows/<id>.md`). Codex re-review M-1
  // caught the previous two-deep derivation that double-appended the
  // state home, producing a different lock path and breaking
  // serialization with createWorkflow / archive.
  const dirLockRoot =
    effectiveRepoRoot ??
    dirname(dirname(dirname(dirname(workflowPath))));

  return withDirectoryLock(dirLockRoot, async () => {
    const sourceStat = await pathStat(workflowPath);
    if (!sourceStat) {
      return { archived: false, reason: 'source-missing', workflowPath };
    }
    if (!sourceStat.isFile()) {
      throw new Error(`archiveWorkflow: source is not a regular file: ${workflowPath}`);
    }

    await ensureDir(targetDir, 0o700);

    return withFileLock(workflowPath, async ({ lockPath, token }) => {
      // Re-stat under the inner lock — defends against the source being
      // unlinked between the directory-lock pathStat and the file-lock
      // acquire (e.g., a non-cooperating actor or a parallel resume
      // archive).
      const sourceStatLocked = await pathStat(workflowPath);
      if (!sourceStatLocked) {
        return { archived: false, reason: 'source-missing-after-lock', workflowPath };
      }

      // Read under the file lock so the parsed frontmatter matches the
      // exact bytes we are about to relocate.
      const text = await readFile(workflowPath, 'utf8');
      const { frontmatter, body } = parseWorkflowFile(text);
      const nowIso = isoUtc(now);
      frontmatter.updated_at = nowIso;
      frontmatter.host_history = [
        ...(frontmatter.host_history ?? []),
        { host, at: nowIso, event: 'archived' },
      ];
      const archivedBytes = assembleWorkflowFile(frontmatter, body);

      // Resolve + write the destination under a retry loop. Codex
      // re-review M-2 flagged that pre-lock pathStat + post-lock
      // atomicWrite leaves a lost-candidate race: two archive runs from
      // different repoRoots writing to the same custom archive dir can
      // both choose the same absent candidate before either takes its
      // destination lock. The retry loop closes that window: under the
      // destination lock we re-stat the path and bail to a fresh
      // candidate if someone won the race.
      const destination = await archiveCandidateWithRaceRetry({
        targetDir,
        baseName,
        now,
        archivedBytes,
      });
      // Source-remove is best-effort durable: if it fails after a
      // successful destination write, the workflow is duplicated rather
      // than lost. Caller can re-archive (idempotent — second run sees
      // source-missing-after-lock).
      try {
        await unlink(workflowPath);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      // Release the original source lock cleanly.
      // (`atomicWrite` with the source lockPath would have rechecked the
      // token — but we deliberately wrote to a different file. The outer
      // `withFileLock` finally-block releases this lock; we just ensure
      // its lockPath/token were never used to commit a stale source
      // write.)
      // Note: we intentionally do NOT atomicWrite to `workflowPath`
      // here; the source is being deleted. The lockPath/token returned
      // from this withFileLock callback are only used to satisfy the
      // outer scope contract, not to commit anything.
      void lockPath; void token;

      return {
        archived: true,
        from: workflowPath,
        to: destination,
        host,
      };
    });
  }, sourceStorage ? { storage: sourceStorage } : {});
}

/**
 * Resolve a non-colliding archive destination by probing successive
 * suffixed candidates. The first candidate is the canonical
 * `<targetDir>/<baseName>`; on collision, we append
 * `-<isoCompact>-<6-hex>` and re-check. Sub-second random hex prevents
 * two concurrent archivers from generating the same suffix at the same
 * iso-second.
 *
 * NOTE: The pre-lock check here is best-effort — the call site MUST
 * also re-check under the destination lock and retry on race (see
 * `archiveCandidateWithRaceRetry`).
 */
async function resolveArchiveDestination({ targetDir, baseName, now }) {
  const stem = baseName.endsWith('.md') ? baseName.slice(0, -3) : baseName;
  const canonical = join(targetDir, baseName);
  if (!(await pathStat(canonical))) return canonical;

  const isoCompact = isoUtc(now).replace(/[-:]/g, '').replace(/Z$/, 'Z');
  // Probe up to a few suffixed candidates; collision past 8 attempts is
  // implausible under realistic load.
  for (let attempt = 0; attempt < 8; attempt++) {
    const rand = randomBytes(3).toString('hex');
    const candidate = join(targetDir, `${stem}-${isoCompact}-${rand}.md`);
    if (!(await pathStat(candidate))) return candidate;
  }
  throw new Error(
    `archiveWorkflow: could not resolve a non-colliding destination under ${targetDir}`,
  );
}

/**
 * Pick a non-colliding destination AND commit `archivedBytes` to it
 * under a per-file lock. Codex re-review M-2 surfaced a lost-candidate
 * race: between `resolveArchiveDestination`'s pathStat and
 * `atomicWrite`'s rename, another archiver in a different lock domain
 * (e.g., custom `archiveDirectory` shared across repoRoots) could win
 * the destination first. This wrapper re-checks existence inside the
 * destination lock and retries with a fresh candidate on race; the
 * loop bound is small because each fresh attempt re-randomizes the
 * suffix.
 *
 * Returns the chosen `destination` path on success.
 */
async function archiveCandidateWithRaceRetry({
  targetDir,
  baseName,
  now,
  archivedBytes,
}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = await resolveArchiveDestination({ targetDir, baseName, now });
    let won = false;
    try {
      await withFileLock(candidate, async ({ lockPath, token }) => {
        const existing = await pathStat(candidate);
        if (existing) {
          // Race lost — release the lock and let the outer loop pick a
          // fresh candidate. We do NOT throw here so the lock release
          // path runs cleanly.
          return;
        }
        await atomicWrite(candidate, archivedBytes, { lockPath, token });
        won = true;
      });
    } catch (err) {
      throw err;
    }
    if (won) return candidate;
  }
  throw new Error(
    `archiveWorkflow: lost candidate race after 8 retries under ${targetDir}`,
  );
}

export function archiveDir(repoRoot, { home = 'canonical' } = {}) {
  return statePaths(repoRoot, home).archive;
}

/**
 * ADR-0017 §sub-decision 5 false-positive defense — the gate is `true`
 * only if `terminal_marker === true`. Default off; absent → false.
 */
export function terminalMarkerCheck(frontmatter) {
  return frontmatter?.terminal_marker === true;
}

/**
 * ADR-0017 §sub-decision 5 terminal-phase whitelist gate.
 */
export function terminalPhaseCheck(currentPhase) {
  return TERMINAL_PHASES.has(currentPhase);
}

/**
 * ADR-0017 §sub-decision 5 transitive A4 gate — every entry in
 * `child_completions` must carry both `commit` (non-empty string) and
 * `closed_at` (non-empty string). An empty / absent list is treated as
 * "no children", which passes the gate.
 */
export function noActiveChildrenCheck(frontmatter) {
  const list = frontmatter?.child_completions;
  if (!Array.isArray(list) || list.length === 0) return true;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') return false;
    if (typeof entry.commit !== 'string' || entry.commit.length === 0) return false;
    if (typeof entry.closed_at !== 'string' || entry.closed_at.length === 0) return false;
  }
  return true;
}

/**
 * ADR-0028 §P11 — pending_ensemble gate (phase7-commit.mjs uses this
 * before set-terminal). A workflow may simultaneously hold
 * `pending_ensemble: [...]` AND `terminal_marker: true` while a peer is
 * still running; the four Stop hook gates do NOT detect that race. This
 * check closes the gap. Returns true when `pending_ensemble` is absent
 * or empty, false otherwise.
 */
export function noPendingEnsembleCheck(frontmatter) {
  const list = frontmatter?.pending_ensemble;
  return !Array.isArray(list) || list.length === 0;
}

// founder trim — the ADR-0019 §5 detachArchive mid-flight detach helper
// is removed: it exists solely for orchestrator /finalize·/abort to
// detach a dispatched child, and orchestrator→founder dispatch is
// ADR-0036 Non-Goal 3.

// -----------------------------------------------------------------------------
// Public API: diagnoseRedundancy (ADR-0020 §Sub-decision 7)

/**
 * Probe the current branch for evidence of work overlapping the user's
 * request. Used by the future `/founder:start` Phase 0 BEFORE bootstrap to flag
 * possible redundancy with recently-merged or in-flight changes.
 *
 * Probes reuse `commands/resume.md:168-198` git introspection plus
 * optional `gh pr list`. Per ADR-0020 §Sub-decision 7 the caller
 * surfaces the result and asks the user proceed/abort — this helper
 * NEVER auto-archives.
 *
 * status rule: `redundancy` iff (commits ahead of merge-base with
 * `baseBranch`) OR (open PR exists on current branch). `no-redundancy`
 * otherwise.
 */
export async function diagnoseRedundancy({
  repoRoot,
  baseBranch = 'origin/main',
} = {}) {
  if (!repoRoot || typeof repoRoot !== 'string') {
    throw new Error('repoRoot must be a non-empty string');
  }

  // Track git executable availability across probes. If `git` itself
  // is absent from PATH the first ENOENT cascades — we surface this
  // explicitly in `scanned.git_present` so callers can distinguish
  // "no overlap" from "git missing → all probes blind" (Codex Phase 5
  // MAJOR + Correctness review MAJOR #2).
  let gitPresent = true;
  const runGit = (args) => {
    try {
      const stdout = execFileSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, stdout: stdout.trimEnd() };
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        gitPresent = false;
      }
      return { ok: false, stdout: err.stdout ? String(err.stdout).trimEnd() : '' };
    }
  };

  // Resolve baseline. `merge-base baseBranch HEAD` yields the most
  // useful divergence point; fall back to baseBranch itself when
  // merge-base fails (e.g., disjoint histories or missing remote).
  // `base_resolution_failed` distinguishes "baseBranch unreachable
  // (origin/main not fetched, typo)" from "git itself absent" so
  // the start macro can route the user differently in each case.
  let baseHead = null;
  let baseResolutionFailed = false;
  const mergeBaseResult = runGit(['merge-base', baseBranch, 'HEAD']);
  if (mergeBaseResult.ok && mergeBaseResult.stdout) {
    baseHead = mergeBaseResult.stdout;
  } else {
    const revParseResult = runGit(['rev-parse', baseBranch]);
    if (revParseResult.ok && revParseResult.stdout) {
      baseHead = revParseResult.stdout;
    } else if (gitPresent) {
      baseResolutionFailed = true;
    }
  }

  const currentHeadResult = runGit(['rev-parse', 'HEAD']);
  const currentHead = currentHeadResult.ok ? currentHeadResult.stdout : null;
  const currentBranchResult = runGit(['branch', '--show-current']);
  const currentBranch = currentBranchResult.ok ? currentBranchResult.stdout : '';

  // Range probes require a valid baseHead. When absent, emit ok=false
  // per probe so the caller can distinguish "probe skipped" from
  // "probe succeeded with empty output." `diff --stat HEAD` is the
  // exception — it operates on the working tree, not the range.
  const commitsAhead = baseHead
    ? runGit(['log', `${baseHead}..HEAD`, '--oneline'])
    : { ok: false, stdout: '' };
  const workingTreeDiffStat = runGit(['diff', '--stat', 'HEAD']);
  const renames = baseHead
    ? runGit(['log', '--diff-filter=R', '--name-status', `${baseHead}..HEAD`])
    : { ok: false, stdout: '' };
  const deletes = baseHead
    ? runGit(['log', '--diff-filter=D', '--name-status', `${baseHead}..HEAD`])
    : { ok: false, stdout: '' };

  // Optional `gh pr list --state open --head <current-branch>`. Absent
  // gh / non-zero exit → open_prs = null (graceful fallback per ADR).
  let openPrs = null;
  if (currentBranch) {
    try {
      const ghStdout = execFileSync(
        'gh',
        [
          'pr',
          'list',
          '--state', 'open',
          '--head', currentBranch,
          '--json', 'number,title,headRefName',
        ],
        { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const parsed = JSON.parse(ghStdout);
      if (Array.isArray(parsed)) {
        openPrs = parsed.map((entry) => ({
          number: entry.number,
          title: entry.title,
          head_ref: entry.headRefName,
        }));
      }
    } catch {
      // ENOENT (gh absent), non-zero exit (auth missing, network),
      // JSON parse error — all map to null. The helper never throws.
      openPrs = null;
    }
  }

  const hasCommitsAhead = commitsAhead.ok && commitsAhead.stdout.trim().length > 0;
  const hasOpenPr = Array.isArray(openPrs) && openPrs.length > 0;

  const scanned = {
    base_branch: baseBranch,
    base_head: baseHead,
    current_head: currentHead,
    current_branch: currentBranch,
    git_present: gitPresent,
    base_resolution_failed: baseResolutionFailed,
    commits_ahead: commitsAhead,
    working_tree_diff_stat: workingTreeDiffStat,
    renames,
    deletes,
    open_prs: openPrs,
  };

  if (hasCommitsAhead || hasOpenPr) {
    // Prefer open_pr as evidence (more concrete than a raw SHA).
    const evidence = hasOpenPr
      ? { kind: 'open_pr', ref: `#${openPrs[0].number}` }
      : {
          kind: 'commit',
          // First line of `log --oneline` is the most recent commit.
          ref: commitsAhead.stdout.split('\n', 1)[0].split(' ', 1)[0],
        };
    return {
      status: 'redundancy',
      scanned,
      evidence,
      recommended_action: 'archive',
    };
  }

  return {
    status: 'no-redundancy',
    scanned,
    evidence: null,
    recommended_action: null,
  };
}

// -----------------------------------------------------------------------------
// Public API: evaluateCleanBaseline + runCleanBaselineCheck (ADR-0028 §Layer-1)
//
// Phase 0 clean-baseline gate. Inspects the working tree at workflow
// START — before `state.mjs create` — and refuses to bootstrap when the
// tree carries tracked modifications, staged changes, or untracked files
// (excluding the `.agentic-plugins/state/**` workflow storage, which the
// founder plugin itself writes during normal operation).
//
// The pure decision function is `evaluateCleanBaseline({statusPorcelain,
// acceptCurrentTree})`; the CLI wrapper `runCleanBaselineCheck` shells
// out to `git status --porcelain=v1` and forwards the parsed result. The
// `ACCEPT_CURRENT_TREE=1` env-var (or `--accept-current-tree` CLI flag)
// flips the status to `'accepted'` — the workflow's commit will sweep
// whatever was in the tree; the user acknowledges that.

const WORKFLOW_STORAGE_PREFIX = '.agentic-plugins/state/';

/**
 * Pure decision: classify a `git status --porcelain=v1 -z` blob
 * (ADR-0028 PR4 N4-quoted — NUL-separated wire format).
 *
 * The `-z` mode delivers paths as raw bytes (no C-quoting around
 * special characters like spaces or quotes), and uses NUL terminators
 * between entries. Rename and copy rows occupy TWO NUL chunks: the
 * `R  <new>` row carries the new path, and the immediately following
 * chunk is the old path (newpath first under -z, opposite of the
 * plain-v1 `R  <old> -> <new>` form). This makes the workflow-storage
 * exclusion prefix check robust against paths with spaces / quotes /
 * tabs that would otherwise come back quoted under plain v1.
 *
 * @param {object}  args
 * @param {string}  args.statusPorcelain — verbatim porcelain v1 -z output
 * @param {boolean} [args.acceptCurrentTree=false] — accept-current-tree bypass
 * @returns {{
 *   status: 'clean' | 'dirty' | 'accepted',
 *   categories: { modified: string[], staged: string[], untracked: string[] },
 * }}
 */
export function evaluateCleanBaseline({
  statusPorcelain = '',
  acceptCurrentTree = false,
} = {}) {
  const categories = { modified: [], staged: [], untracked: [] };

  if (typeof statusPorcelain === 'string' && statusPorcelain.length > 0) {
    // -z splits on NUL. A trailing NUL produces an empty tail chunk we
    // drop. Empty middle chunks are skipped defensively.
    const chunks = statusPorcelain.split('\0');
    if (chunks.length > 0 && chunks[chunks.length - 1] === '') chunks.pop();

    for (let i = 0; i < chunks.length; i++) {
      const cur = chunks[i];
      // Each entry is "XY <path>" — needs at least the two status
      // columns plus a separator and one byte of path.
      if (typeof cur !== 'string' || cur.length < 3) continue;

      const indexCh = cur[0];
      const workCh = cur[1];
      const rawPath = cur.slice(3);

      // ADR-0028 PR3 N4 + PR4 N4-quoted — rename/copy rows carry both
      // OLD and NEW paths across two consecutive NUL chunks. Under -z
      // the NEW path is on the `R` / `C` row and the OLD path is the
      // NEXT chunk (opposite of plain-v1's `R  <old> -> <new>`). The
      // workflow-storage exclusion must check BOTH endpoints; only a
      // rename that stays entirely inside the workflow-storage tree
      // counts as founder's own bookkeeping movement.
      let pathForReport;
      let bothInsideWorkflowStorage;
      if (indexCh === 'R' || indexCh === 'C') {
        const newPath = rawPath;
        const oldPath = chunks[i + 1] ?? '';
        i += 1; // consume the old-path chunk so it is not re-parsed as an entry
        const oldInside = oldPath.startsWith(WORKFLOW_STORAGE_PREFIX);
        const newInside = newPath.startsWith(WORKFLOW_STORAGE_PREFIX);
        bothInsideWorkflowStorage = oldInside && newInside;
        // PR3 N4: surface the OUTSIDE endpoint when exactly one side
        // crosses the workflow-storage boundary; otherwise default to
        // the NEW path (PR2-compatible normal-rename behavior).
        if (oldInside && !newInside) pathForReport = newPath;
        else if (!oldInside && newInside) pathForReport = oldPath;
        else pathForReport = newPath;
      } else {
        bothInsideWorkflowStorage = rawPath.startsWith(WORKFLOW_STORAGE_PREFIX);
        pathForReport = rawPath;
      }
      // Exclude entries entirely — these are founder's own bookkeeping
      // and never belong on the dirty list. Non-rename rows fall back
      // to the simple startsWith check via bothInsideWorkflowStorage.
      if (bothInsideWorkflowStorage) continue;
      if (indexCh === '?' && workCh === '?') {
        categories.untracked.push(pathForReport);
        continue;
      }
      if (indexCh !== ' ' && indexCh !== '?') {
        categories.staged.push(pathForReport);
      }
      if (workCh !== ' ' && workCh !== '?') {
        categories.modified.push(pathForReport);
      }
    }
  }

  const isDirty =
    categories.modified.length > 0 ||
    categories.staged.length > 0 ||
    categories.untracked.length > 0;

  let status;
  if (!isDirty) status = 'clean';
  else if (acceptCurrentTree) status = 'accepted';
  else status = 'dirty';

  return { status, categories };
}

/**
 * CLI wrapper: run `git status --porcelain=v1` under `repoRoot`, then
 * delegate to `evaluateCleanBaseline`. Returns the same shape as the
 * pure function plus a `git_present` flag so the bash caller can
 * distinguish "no overlap" from "git missing → probe blind".
 */
export function runCleanBaselineCheck({ repoRoot, acceptCurrentTree = false } = {}) {
  if (!repoRoot || typeof repoRoot !== 'string') {
    throw new Error('runCleanBaselineCheck: repoRoot must be a non-empty string');
  }
  let statusPorcelain = '';
  let gitPresent = true;
  try {
    // ADR-0028 PR4 N4-quoted — `-z` returns paths verbatim (no quoting
    // around spaces / quotes / tabs) and separates entries with NUL.
    // The parser in evaluateCleanBaseline consumes that wire format.
    statusPorcelain = execFileSync('git', ['status', '--porcelain=v1', '-z'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      gitPresent = false;
    } else {
      // Any other `git status` failure is reported back to the caller
      // so the gate prose can surface it rather than masquerading as
      // a clean tree.
      throw new Error(
        `runCleanBaselineCheck: git status failed (${err && err.message ? err.message : 'unknown error'})`,
      );
    }
  }
  const decision = evaluateCleanBaseline({ statusPorcelain, acceptCurrentTree });
  return { ...decision, git_present: gitPresent };
}

// -----------------------------------------------------------------------------
// CLI mode

function cliParseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${a}`);
    }
    const name = a.slice(2);
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) {
      throw new Error(`Missing value for flag --${name}`);
    }
    flags[name] = val;
    i += 1;
  }
  return flags;
}

function cliRequire(flags, names) {
  const missing = names.filter((n) => !(n in flags));
  if (missing.length > 0) {
    throw new Error(`Missing required flags: ${missing.map((n) => `--${n}`).join(', ')}`);
  }
}

function cliPrintHelp() {
  process.stdout.write(
    [
      'Usage: state.mjs <subcommand> [flags]',
      '',
      'Subcommands:',
      '  find-active --repo-root <path> [--branch <name>]',
      '    Print the active workflow path on the current git branch (empty if',
      '    none). Branch is probed via `git branch --show-current`; supply',
      '    --branch <name> to override (or to test detached-HEAD via empty).',
      '    Exit 0 on success (including null active); exit 1 if two or more',
      '    workflow files are on the same branch (per-branch single-active',
      '    invariant per ADR-0018 §sub-2).',
      '',
      '  create --repo-root <path> --verb <verb> --host <host>',
      '         --git-baseline-branch <name> --git-baseline-head <sha>',
      '         [--persona founder] [--profile <name>] [--status-digest <hex>]',
      '         [--current-phase <label>] [--next-action <text>]',
      '         [--original-request <text>] [--body-title <text>]',
      '         [--workflow-type verb-chain|start]',
      '    Create a new workflow under the directory-level lock. Print the new',
      '    workflow path on stdout.',
      '    founder trim — no --parent-workflow / --originating-subtask flags:',
      '    orchestrator→founder dispatch is ADR-0036 Non-Goal 3.',
      '    ADR-0020 §Sub-decision 5 — --workflow-type discriminates the',
      '    workflow shape. Omit (or pass verb-chain) for single-verb workflows',
      '    produced by the six founder verb commands. The future',
      '    `/founder:start` macro passes start. Default: verb-chain.',
      '',
      '  append --workflow-path <path> --host <host>',
      '         [--verb <verb>] [--profile <name>]',
      '         [--phase-label <text>] [--phase-note <text>]',
      '         [--current-phase <label>] [--next-action <text>]',
      '         [--event created|updated|snapshot|resumed]',
      '    Append a phase note to an existing workflow. Default event=resumed.',
      '',
      '  snapshot --workflow-path <path> --host <host> --trigger pre-compact|stop',
      '           [--status-digest <hex>]',
      '    Update last_snapshot + append host_history snapshot entry. Used by hooks.',
      '',
      '  read --workflow-path <path>',
      '    Print the parsed frontmatter as JSON on stdout (informational).',
      '',
      '  ensemble-pending --workflow-path <path> --phase <name>',
      '                   --ensemble-type <name> --run-id <id> [--started-at <iso>]',
      '    ADR-0017 sub-4 — record a pending ensemble dispatch. Idempotent on run-id.',
      '',
      '  ensemble-commit --workflow-path <path> --run-id <id> --phase <name>',
      '                  --ensemble-type <name> --verdict <text> --summary <text>',
      '                  [--completed-at <iso>] [--codex-session-id <id>]',
      '                  [--cap <n>]',
      '    ADR-0017 sub-4 — three-step atomic commit: pop pending → append result → prune.',
      '    Idempotent on run-id (second commit is a no-op for the results list).',
      '',
      '  checkpoint-set --workflow-path <path> --host <host> --summary <text>',
      '    ADR-0017 sub-2 — set latest_checkpoint and append host_history checkpointed.',
      '',
      '  record-composed-file --workflow-path <path> --path <p> --op create|edit',
      '                       [--recorded-at <iso>]',
      '    ADR-0028 §Layer-2 — append a {path, phase: "compose", op, recorded_at}',
      '    entry to commit_manifest. Command-mode boundary: --workflow-path ""',
      '    no-ops and exits 0 (standalone invocation does not mutate).',
      '',
      '  record-refine-file --workflow-path <path> --path <p> --op create|edit',
      '                     [--recorded-at <iso>]',
      '    ADR-0028 §Layer-2 — append a {path, phase: "refine", op, recorded_at}',
      '    entry to commit_manifest. Command-mode boundary: --workflow-path ""',
      '    no-ops and exits 0 (standalone invocation does not mutate).',
      '',
      '  set-terminal --workflow-path <path> --host <host>',
      '               --terminal-phase commit-complete|summary-complete|fix-complete',
      '               [--terminal-marker true|false] [--next-action <text>]',
      '               [--event updated|resumed]',
      '    ADR-0017 sub-5 — atomic terminal-phase write (current_phase + terminal_marker).',
      '    Default --terminal-marker=true.',
      '',
      '  archive --workflow-path <path> --host <host> --repo-root <path>',
      '    ADR-0017 sub-5 — move workflow file from workflows/ to archive/.',
      '    Collision-safe (timestamp-suffix). Idempotent if source is already absent.',
      '',
      '  (founder trim — no detach-archive subcommand: the ADR-0019 PR-E',
      '   mid-flight detach exists only for orchestrator dispatch, which is',
      '   ADR-0036 Non-Goal 3 for founder.)',
      '',
      '  diagnose-redundancy --repo-root <path> [--base-branch <ref>]',
      '    ADR-0020 §Sub-decision 7 — probe the current branch for evidence of work',
      '    overlapping the user request (commits ahead of merge-base, open PRs). Invoked',
      '    by the future /founder:start Phase 0 BEFORE bootstrap. Default --base-branch=origin/main.',
      '    Emits JSON: { status: "no-redundancy" | "redundancy", scanned: {...},',
      '    evidence: {kind, ref} | null, recommended_action: "archive" | null }. Caller',
      '    surfaces evidence; user decides proceed/abort. Never auto-archives.',
      '',
      '  check-clean-baseline --repo-root <path> [--accept-current-tree true|false]',
      '    ADR-0028 §Layer-1 — Phase 0 clean-baseline gate. Runs `git status',
      '    --porcelain=v1` and classifies the tree as clean / dirty / accepted',
      '    (excluding .agentic-plugins/state/** workflow storage). Bash callers also',
      '    honor ACCEPT_CURRENT_TREE=1 in the environment for the same bypass. Emits',
      '    JSON: { status, categories: {modified, staged, untracked}, git_present }.',
      '',
      '  (founder trim — no set/clear-parent-writeback-marker subcommands:',
      '   the ADR-0028 §P10 write-ahead marker exists only for parent',
      '   writeback, which is ADR-0036 Non-Goal 3 for founder.)',
      '',
      '  stop-archive --workflow-path <path> --host <host> --repo-root <path>',
      '               [--head-sha <sha>] [--head-subject <text>] [--status-digest <hex>]',
      '    Wraps runStopArchive with explicit head info so the A3 head_moved gate',
      '    is evaluated against an explicitly-supplied SHA rather than the',
      '    current-process git HEAD. founder note: retained as a general',
      '    remote-archive surface; no external cross-plugin caller exists',
      '    (orchestrator dispatch is ADR-0036 Non-Goal 3). Emits the',
      '    runStopArchive return as JSON:',
      '      {archived: true, to: <archive-path>} on archive success',
      '      {archived: false, reason: <reason>, gateFailures?: [...]} otherwise',
      '',
      'Verbs: investigate, frame, decide, compose, critique, refine.',
      'Hosts: claude, codex.',
      'Workflow types: verb-chain, start.',
      '',
    ].join('\n'),
  );
}

async function cliMain(argv) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    cliPrintHelp();
    return 0;
  }

  let flags;
  try {
    flags = cliParseFlags(rest);
  } catch (err) {
    process.stderr.write(`state.mjs: ${err.message}\n`);
    return 2;
  }

  try {
    switch (subcommand) {
      case 'find-active': {
        cliRequire(flags, ['repo-root']);
        // ADR-0018 §sub-2 — `--branch` overrides the auto-probe so
        // callers (tests, scripts that already know the branch) skip
        // the `git branch --show-current` shell-out.
        const path =
          'branch' in flags
            ? await findActiveWorkflowByBranch(flags['repo-root'], flags.branch)
            : await findActiveWorkflow(flags['repo-root']);
        if (path) process.stdout.write(`${path}\n`);
        return 0;
      }

      case 'create': {
        cliRequire(flags, ['repo-root', 'verb', 'host', 'git-baseline-branch', 'git-baseline-head']);
        // founder guard — fail loud on parent-linkage flags instead of
        // silently ignoring them: a dispatcher exporting the
        // AGENTIC_PARENT_WORKFLOW contract at founder is misconfigured
        // (orchestrator→founder dispatch is ADR-0036 Non-Goal 3), and a
        // silently-unlinked workflow would mask that bug.
        if (flags['parent-workflow'] !== undefined || flags['originating-subtask'] !== undefined) {
          throw new Error(
            'founder state.mjs create does not accept --parent-workflow/--originating-subtask: ' +
              'orchestrator→founder dispatch is ADR-0036 Non-Goal 3',
          );
        }
        // founder guard — persona is canonical: a non-founder --persona
        // landing in the founder state home would cross persona
        // boundaries silently (read-side stays tolerant for fixtures).
        if (flags.persona !== undefined && flags.persona !== 'founder') {
          throw new Error(
            `founder state.mjs create only writes persona 'founder' (got '${flags.persona}')`,
          );
        }
        const result = await createWorkflow({
          repoRoot: flags['repo-root'],
          verb: flags.verb,
          host: flags.host,
          persona: flags.persona ?? 'founder',
          profile: flags.profile ?? '',
          originalRequest: flags['original-request'] ?? '',
          gitBaseline: {
            branch: flags['git-baseline-branch'],
            head: flags['git-baseline-head'],
            status_digest: flags['status-digest'] ?? '',
          },
          currentPhase: flags['current-phase'] ?? 'phase-0',
          nextAction: flags['next-action'] ?? '',
          bodyTitle: flags['body-title'],
          // founder trim — no parent-linkage flags (ADR-0036 Non-Goal 3).
          // ADR-0020 PR 2 — workflow-shape discriminator. Omitting the
          // flag defaults to 'verb-chain' inside createWorkflowUnderLock;
          // the future `/founder:start` macro passes 'start'. cliParseFlags
          // can only collect string values, so the enum gate fires inside
          // createWorkflowUnderLock for invalid values.
          workflowType: flags['workflow-type'],
        });
        process.stdout.write(`${result.filePath}\n`);
        return 0;
      }

      case 'append': {
        cliRequire(flags, ['workflow-path', 'host']);
        await appendPhase({
          workflowPath: flags['workflow-path'],
          host: flags.host,
          verb: flags.verb,
          profile: flags.profile,
          phaseLabel: flags['phase-label'],
          phaseNote: flags['phase-note'],
          currentPhase: flags['current-phase'],
          nextAction: flags['next-action'],
          event: flags.event ?? 'resumed',
        });
        process.stdout.write(`${flags['workflow-path']}\n`);
        return 0;
      }

      case 'snapshot': {
        cliRequire(flags, ['workflow-path', 'host', 'trigger']);
        await snapshot({
          workflowPath: flags['workflow-path'],
          host: flags.host,
          trigger: flags.trigger,
          statusDigest: flags['status-digest'],
        });
        process.stdout.write(`${flags['workflow-path']}\n`);
        return 0;
      }

      case 'read': {
        cliRequire(flags, ['workflow-path']);
        const { frontmatter } = await readWorkflow(flags['workflow-path']);
        // ADR-0028 §Forward-compat (PR5) — Symbol-keyed unknown additive
        // keys are invisible to JSON.stringify. The CLI `read` output is a
        // diagnostic projection (not a canonical round-trip artifact;
        // round-trip MUST go through parseWorkflowFile + assembleWorkflowFile
        // to preserve the Symbol carrier). Surface the carrier under an
        // underscored sibling key so an operator inspecting the JSON sees
        // future-minor unknowns without having to import the Symbol.
        const unknowns = frontmatter[FORWARD_COMPAT_UNKNOWNS];
        const projection = Array.isArray(unknowns) && unknowns.length > 0
          ? { ...frontmatter, _forward_compat_unknowns: unknowns }
          : frontmatter;
        process.stdout.write(`${JSON.stringify(projection, null, 2)}\n`);
        return 0;
      }

      // ADR-0017 schema 1.1 subcommands ------------------------------

      case 'ensemble-pending': {
        cliRequire(flags, ['workflow-path', 'phase', 'ensemble-type', 'run-id']);
        await recordPendingEnsemble({
          workflowPath: flags['workflow-path'],
          phase: flags.phase,
          ensemble_type: flags['ensemble-type'],
          run_id: flags['run-id'],
          started_at: flags['started-at'],
        });
        process.stdout.write(`${flags['workflow-path']}\n`);
        return 0;
      }

      case 'ensemble-commit': {
        cliRequire(flags, [
          'workflow-path', 'run-id', 'phase', 'ensemble-type', 'verdict', 'summary',
        ]);
        const cap = flags.cap !== undefined
          ? Number.parseInt(flags.cap, 10)
          : ENSEMBLE_RESULTS_RETENTION_CAP;
        if (!Number.isInteger(cap) || cap < 0) {
          throw new Error(`--cap must be a non-negative integer (got ${flags.cap})`);
        }
        await commitEnsemble({
          workflowPath: flags['workflow-path'],
          run_id: flags['run-id'],
          phase: flags.phase,
          ensemble_type: flags['ensemble-type'],
          verdict: flags.verdict,
          summary: flags.summary,
          completed_at: flags['completed-at'],
          codex_session_id: flags['codex-session-id'] ?? null,
          cap,
        });
        process.stdout.write(`${flags['workflow-path']}\n`);
        return 0;
      }

      case 'checkpoint-set': {
        cliRequire(flags, ['workflow-path', 'host', 'summary']);
        await setCheckpoint({
          workflowPath: flags['workflow-path'],
          host: flags.host,
          summary: flags.summary,
        });
        process.stdout.write(`${flags['workflow-path']}\n`);
        return 0;
      }

      // ADR-0028 §Layer-2 — commit_manifest record subcommands (T3b).
      // Command-mode boundary: --workflow-path "" → no-op exit 0 (the
      // helper short-circuits). The flag MUST be present (cliRequire
      // checks key presence in flags, not non-empty value) so a caller
      // that forgets the flag entirely fails loudly — silent no-op on
      // missing flag would hide broken callers (Codex peer review G1).
      case 'record-composed-file': {
        cliRequire(flags, ['workflow-path', 'path', 'op']);
        const result = await recordComposedFile({
          workflowPath: flags['workflow-path'],
          path: flags.path,
          op: flags.op,
          recorded_at: flags['recorded-at'],
        });
        if (!result.skipped) {
          process.stdout.write(`${flags['workflow-path']}\n`);
        }
        return 0;
      }

      case 'record-refine-file': {
        cliRequire(flags, ['workflow-path', 'path', 'op']);
        const result = await recordRefineFile({
          workflowPath: flags['workflow-path'],
          path: flags.path,
          op: flags.op,
          recorded_at: flags['recorded-at'],
        });
        if (!result.skipped) {
          process.stdout.write(`${flags['workflow-path']}\n`);
        }
        return 0;
      }

      // founder trim — no set/clear-parent-writeback-marker subcommands
      // (ADR-0028 §P10 markers serve only parent writeback; ADR-0036
      // Non-Goal 3).

      case 'set-terminal': {
        cliRequire(flags, ['workflow-path', 'host', 'terminal-phase']);
        // Strict --terminal-marker parsing (Codex review MINOR — typos
        // like `--terminal-marker tru` previously fell through to false
        // silently, masking a misconfigured auto-archive gate).
        const tm = flags['terminal-marker'];
        let terminalMarker;
        if (tm === undefined) {
          terminalMarker = true;
        } else if (tm === 'true') {
          terminalMarker = true;
        } else if (tm === 'false') {
          terminalMarker = false;
        } else {
          throw new Error(
            `--terminal-marker must be 'true' or 'false' (got '${tm}')`,
          );
        }
        await setTerminal({
          workflowPath: flags['workflow-path'],
          host: flags.host,
          terminalPhase: flags['terminal-phase'],
          terminalMarker,
          nextAction: flags['next-action'],
          event: flags.event ?? 'updated',
        });
        process.stdout.write(`${flags['workflow-path']}\n`);
        return 0;
      }

      case 'archive': {
        cliRequire(flags, ['workflow-path', 'host', 'repo-root']);
        const result = await archiveWorkflow({
          workflowPath: flags['workflow-path'],
          host: flags.host,
          repoRoot: flags['repo-root'],
        });
        if (result.archived) {
          process.stdout.write(`${result.to}\n`);
        } else {
          process.stderr.write(
            `state.mjs archive: ${result.reason ?? 'no-op'} for ${flags['workflow-path']}\n`,
          );
        }
        return 0;
      }

      // founder trim — no detach-archive subcommand (ADR-0019 PR-E is
      // orchestrator-dispatch machinery; ADR-0036 Non-Goal 3).

      case 'diagnose-redundancy': {
        cliRequire(flags, ['repo-root']);
        const result = await diagnoseRedundancy({
          repoRoot: flags['repo-root'],
          baseBranch: flags['base-branch'] ?? 'origin/main',
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      }

      // ADR-0028 §Layer-1 — Phase 0 clean-baseline gate. Shells out to
      // `git status --porcelain=v1` and classifies dirty/clean/accepted
      // with workflow-storage entries excluded. JSON-only stdout so the
      // bash caller in commands/start.md can parse via jq.
      case 'check-clean-baseline': {
        cliRequire(flags, ['repo-root']);
        const acceptCurrentTree =
          flags['accept-current-tree'] === true ||
          flags['accept-current-tree'] === 'true' ||
          process.env.ACCEPT_CURRENT_TREE === '1';
        const result = runCleanBaselineCheck({
          repoRoot: flags['repo-root'],
          acceptCurrentTree,
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      }

      case 'stop-archive': {
        cliRequire(flags, ['workflow-path', 'host', 'repo-root']);
        // Dynamic import: stop-archive.mjs imports back from this
        // module, so a top-level static import would be a circular
        // edge resolved by Node's module loader. Dynamic import keeps
        // the dependency edge contained to this single invocation.
        const { runStopArchive } = await import('./stop-archive.mjs');
        const result = await runStopArchive({
          workflowPath: flags['workflow-path'],
          host: flags.host,
          repoRoot: flags['repo-root'],
          statusDigest: flags['status-digest'] ?? '',
          headSha: flags['head-sha'] ?? null,
          headSubject: flags['head-subject'] ?? null,
          stderr: process.stderr,
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return 0;
      }

      default:
        process.stderr.write(`state.mjs: unknown subcommand: ${subcommand}\n`);
        return 2;
    }
  } catch (err) {
    process.stderr.write(`state.mjs ${subcommand}: ${err.message}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Wrap cliMain in an async IIFE rather than awaiting it at top level.
  // Top-level await blocks circular dynamic imports performed inside
  // cliMain (the `stop-archive` subcommand dynamically imports
  // stop-archive.mjs, which re-imports from this file): with top-level
  // await pending, the inner dynamic import resolves to a Module record
  // whose state never settles, and Node emits "Detected unsettled
  // top-level await" before exiting with code 13. The IIFE keeps the
  // dispatch asynchronous without making it top-level.
  (async () => {
    const code = await cliMain(process.argv.slice(2));
    process.exit(code);
  })();
}
