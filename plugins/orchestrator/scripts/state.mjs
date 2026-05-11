#!/usr/bin/env node
// plugins/orchestrator/scripts/state.mjs
//
// Host-shared canonical state I/O for the orchestrator plugin per
// ADR-0011 + ADR-0017 (mirror surface) + ADR-0018 §sub-decision-1
// (orchestrator-specific schema '1.0' + macro workflow_id +
// plan.subtasks[] + branch-keyed active per ADR-0018 §sub-2).
//
// Used by:
//   - plugins/orchestrator/commands/plan.md (Phase 0 find-active+create
//     + Phase 2 plan-set)
//   - plugins/orchestrator/adapters/{claude,codex}/hooks/* (snapshot writes)
//
// Storage location:
//   <repo_root>/.claude/agentic-orchestrator/workflows/<workflow_id>.md
//
// Lock files:
//   <repo_root>/.claude/agentic-orchestrator/.creation-lock        (directory-level)
//   <repo_root>/.claude/agentic-orchestrator/workflows/<id>.md.lock (per-file)
//
// File modes:
//   directories: 0o700
//   files:       0o600 (workflows + locks)
//
// File format: YAML frontmatter (schema='1.0') + Markdown body.
//
// Schema divergence from plugins/engineer (intentional):
//   engineer  schema='1.1', WORKFLOW_DIR_REL=.claude/agentic-engineer/workflows
//   orchestrator schema='1.0', WORKFLOW_DIR_REL=.claude/agentic-orchestrator/workflows
//   The two schema lines evolve independently; orchestrator rejects
//   engineer-shape files (schema 1 / '1.1' / 2) cleanly to keep namespaces
//   separate.

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
import { execFileSync } from 'node:child_process';

// -----------------------------------------------------------------------------
// Constants — ADR-0018 §sub-decision-1 + §sub-decision-2

// ADR-0019 PR-B — schema bump 1.0 → 1.1. New workflows emit '1.1';
// existing '1.0' files read OK but mutations are refused (legacy
// archive + re-plan required). Engineer schema 1 / '1.1' / 2 still
// rejected — orchestrator and engineer namespaces stay separate.
export const SCHEMA_VERSION = '1.1';
export const SUPPORTED_SCHEMA_VERSIONS = new Set(['1.0', '1.1']);

export const WORKFLOW_DIR_REL = '.claude/agentic-orchestrator/workflows';
export const CREATION_LOCK_REL = '.claude/agentic-orchestrator/.creation-lock';

// Retention cap on `ensemble_results` (mirrors engineer ADR-0017 §sub-4).
// Macro Plan-verify ensembles are typically fewer-but-higher-value, but
// we keep the same cap for cross-plugin operational consistency.
export const ENSEMBLE_RESULTS_RETENTION_CAP = 20;

const STALE_THRESHOLD_MS = 60_000;        // ADR-0011 §3 — lock staleness window
const RETRY_BACKOFF_MAX_MS = 5_000;       // ADR-0011 §3 step 2 — acquireLock budget

// orchestrator MVP supports a single verb. /orchestrator:next and
// /orchestrator:done verbs ship in follow-up PRs alongside the
// cross-plugin invocation contract (ADR-0018 §sub-1 follow-up ADR).
const VALID_VERBS = new Set(['plan']);
const VALID_HOSTS = new Set(['claude', 'codex']);
// Auto-archive (event 'archived') and checkpoint ('checkpointed') are
// engineer-only for now; orchestrator MVP defers both with `next/done`.
const VALID_HOOK_EVENTS = new Set([
  'created',
  'updated',
  'snapshot',
  'resumed',
]);
const VALID_SNAPSHOT_TRIGGERS = new Set(['pre-compact', 'stop']);

// ADR-0018 §sub-1 plan.subtasks[i].status enum, extended by ADR-0019 §2
// with two terminal-partial states (set by /orchestrator:finalize and
// /orchestrator:abort respectively in PR-E).
const VALID_SUBTASK_STATUSES = new Set([
  'pending',
  'blocked',
  'in_progress',
  'completed',
  // ADR-0019 PR-B
  'deferred',
  'abandoned',
]);

// ADR-0018 §sub-1 + ADR-0019 §2 plan.subtasks[i] field set. `verb`,
// `profile`, `topic` are 1.1-only fields; legacy 1.0 plans don't carry
// them (read-only path tolerates absence; the SCHEMA_VERSION-aware
// required check below enforces presence under 1.1).
const SUBTASK_KEYS = [
  'id',
  'label',
  'branch',
  'blocked_by',
  'status',
  'engineer_workflow_id',
  'commit',
  'pr_url',
  'closed_at',
  // ADR-0019 PR-B (1.1)
  'verb',
  'profile',
  'topic',
];
const SUBTASK_KEYS_SET = new Set(SUBTASK_KEYS);

// SUBTASK_REQUIRED_KEYS branch by schema version. Under 1.0 the legacy
// invariants (id / blocked_by / status) hold so existing files read
// without forced retroactive `verb`/`branch`. Under 1.1 the dispatch
// contract per ADR-0019 §1 needs `verb` (canonical 6-verb) and
// `branch` (git ref-format) at every subtask — those are REQUIRED.
const SUBTASK_REQUIRED_KEYS_BY_SCHEMA = Object.freeze({
  '1.0': new Set(['id', 'blocked_by', 'status']),
  '1.1': new Set(['id', 'blocked_by', 'status', 'verb', 'branch']),
});

// Optional string-or-null subtask keys. Each is permitted to be absent
// or null when the subtask has not yet acquired the corresponding
// downstream artifact (engineer_workflow_id appears after dispatch,
// commit + closed_at after `done`). Under 1.0 `branch` is optional;
// under 1.1 it is required (so it is excluded from this set when
// validating 1.1 files — the validator runs the required-key check
// first which catches the omission).
const SUBTASK_OPTIONAL_KEYS = new Set([
  'label',
  'branch',
  'engineer_workflow_id',
  'commit',
  'pr_url',
  'closed_at',
  // ADR-0019 PR-B (1.1)
  'profile',
  'topic',
]);

// ADR-0019 §1 git ref-format gate for subtask branch names. Mirrors the
// full set of `git check-ref-format --branch` rules so peer-emitted
// plans don't ship branches that pass plan-set but fail at /next's
// `git switch`. Implemented in-process (no shell-out) per the
// validator's self-contained boundary.
//
// Rules (per git-check-ref-format(1)):
//   1. No slash-separated component begins with '.' or ends with '.lock'
//   2. No '..' anywhere
//   3. No ASCII control chars (< \x20 or \x7f), space, '~', '^', ':'
//   4. No '?', '*', '['
//   5. Cannot begin/end with '/' or have consecutive '/'
//   6. Cannot end with '.'
//   7. Cannot contain '@{'
//   8. Cannot be the single character '@'
//   9. Cannot contain '\\'
//   10. Cannot begin with '-' (branch-specific rule)
//   11. Cannot be 'HEAD' (branch-specific rule)
const INVALID_BRANCH_CHARS = /[\x00-\x1f\x7f \s~^:?*\[\\]/;
function isValidGitBranchSegment(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  // Branch-specific: cannot be 'HEAD' or start with '-'
  if (name === 'HEAD') return false;
  if (name.startsWith('-')) return false;
  // Cannot begin/end with '/', cannot end with '.', cannot have '..'
  if (name.startsWith('/')) return false;
  if (name.endsWith('/')) return false;
  if (name.endsWith('.')) return false;
  if (name.includes('..')) return false;
  // Cannot have '@{' sequence or be lone '@'
  if (name === '@') return false;
  if (name.includes('@{')) return false;
  // Cannot have consecutive '/'
  if (name.includes('//')) return false;
  // Disallowed chars anywhere
  if (INVALID_BRANCH_CHARS.test(name)) return false;
  // Per-component checks: no segment begins with '.' or ends with '.lock'
  const components = name.split('/');
  for (const c of components) {
    if (c.length === 0) return false;            // catches empty segments
    if (c.startsWith('.')) return false;          // segment-level leading dot
    if (c.endsWith('.lock')) return false;        // segment-level .lock suffix
  }
  return true;
}

// ADR-0019 §2 — engineer canonical 6-verb whitelist. Subtask `verb`
// must be one of these under 1.1 so /orchestrator:next can dispatch
// against the matching engineer command (PR-D).
const VALID_SUBTASK_VERBS = new Set([
  'investigate',
  'frame',
  'decide',
  'compose',
  'critique',
  'refine',
]);

// -----------------------------------------------------------------------------
// Path helpers

export function workflowDir(repoRoot) {
  if (!isAbsolute(repoRoot)) {
    throw new Error(`repoRoot must be absolute: ${repoRoot}`);
  }
  return join(repoRoot, WORKFLOW_DIR_REL);
}

export function creationLockPath(repoRoot) {
  return join(repoRoot, CREATION_LOCK_REL);
}

export function workflowFilePath(repoRoot, workflowId) {
  return join(workflowDir(repoRoot), `${workflowId}.md`);
}

function fileLockPath(workflowFilePath_) {
  return `${workflowFilePath_}.lock`;
}

// -----------------------------------------------------------------------------
// ID generation per ADR-0018 §sub-1
//
// workflow_id format: `macro-<verb>-<isoCompact>-<6hex>`. The `macro-`
// prefix distinguishes orchestrator workflow_ids from engineer ones at
// a glance (engineer uses `<verb>-<isoCompact>-<6hex>`).

export function generateWorkflowId(verb, { now = new Date(), randomSource = randomBytes } = {}) {
  if (!VALID_VERBS.has(verb)) {
    throw new Error(
      `Invalid verb: ${verb}. Must be one of ${[...VALID_VERBS].join(', ')} (orchestrator MVP supports 'plan' only).`,
    );
  }
  const iso = now.toISOString();
  const compact = iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const shortid = randomSource(3).toString('hex');
  return `macro-${verb}-${compact}-${shortid}`;
}

// -----------------------------------------------------------------------------
// Lock ownership protocol per ADR-0011 §3 — verbatim mirror from
// plugins/engineer/scripts/state.mjs (no orchestrator-specific divergence).

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

    const status = await checkLockStaleness(lockPath, { now, sleep });
    if (status === 'gone') continue;
    if (status === 'stale') {
      const reclaimed = await tryReclaimByRename(lockPath, myToken, { randomSource });
      if (reclaimed) return myToken;
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
    if (err.code === 'ENOENT') return true;
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
// Atomic write — temp file + fsync + rename per ADR-0011 §3 step 3-5.

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
export async function withDirectoryLock(repoRoot, fn) {
  await ensureDir(workflowDir(repoRoot), 0o700);
  await ensureDir(dirname(creationLockPath(repoRoot)), 0o700);
  const lockPath = creationLockPath(repoRoot);
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
// Discovery — per-branch single-active invariant per ADR-0018 §sub-2.

/**
 * List workflow files (just `.md`, not `.md.lock` or `.md.tmp`) under
 * the workflows directory. Caller is responsible for holding the
 * directory-level lock if exclusivity matters.
 */
export async function listWorkflowFiles(repoRoot) {
  const dir = workflowDir(repoRoot);
  const st = await pathStat(dir);
  if (!st) return [];
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((name) => name.endsWith('.md') && !name.endsWith('.md.tmp'))
    .map((name) => join(dir, name))
    .sort();
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
        if (raw.startsWith('"') && raw.endsWith('"')) {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        }
        return raw;
      }
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
export async function findActiveWorkflowByBranch(repoRoot, branch) {
  if (!branch) return null;
  const files = await listWorkflowFiles(repoRoot);
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
// Frontmatter parse / serialize — orchestrator schema '1.0'

const FRONTMATTER_KEY_ORDER = [
  'schema',
  'workflow_id',
  'workflow_type',
  'original_request',
  'started_at',
  'updated_at',
  'repo_root',
  'git_baseline',
  'current_phase',
  'next_action',
  'plan',
  'host_history',
  'last_snapshot',
  'pending_ensemble',
  'ensemble_results',
  // ADR-0019 PR-B (1.1) — optional top-level boolean. Set by
  // /orchestrator:finalize / /orchestrator:abort (PR-E) or
  // auto-set when all subtasks become terminal (parent-writeback
  // auto-terminal pass per ADR-0019 §4 step 7). Required by §5 A1
  // gate for orchestrator stop-archive.
  'terminal_marker',
];

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
});

const OPTIONAL_ENTRY_KEYS_BY_LIST_KEY = Object.freeze({
  pending_ensemble: new Set(),
  ensemble_results: new Set(['codex_session_id']),
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

    if (key === 'plan') {
      // ADR-0018 §sub-1 nested plan block: { decision?, architecture?, subtasks: [...] }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`plan must be an object`);
      }
      // Unknown plan keys are rejected for closed-schema fidelity.
      for (const k of Object.keys(value)) {
        if (!['decision', 'architecture', 'subtasks'].includes(k)) {
          throw new Error(`Unknown plan key: ${k}. Expected: decision, architecture, subtasks.`);
        }
      }
      if (!Array.isArray(value.subtasks)) {
        throw new Error('plan.subtasks must be an array');
      }
      lines.push(`${key}:`);
      if (value.decision !== undefined && value.decision !== null) {
        lines.push(`  decision: ${yamlScalar(value.decision)}`);
      }
      if (value.architecture !== undefined && value.architecture !== null) {
        lines.push(`  architecture: ${yamlScalar(value.architecture)}`);
      }
      if (value.subtasks.length === 0) {
        lines.push(`  subtasks: []`);
      } else {
        lines.push(`  subtasks:`);
        // ADR-0019 PR-B — required-key set varies by schema version.
        // Under 1.0 only id/blocked_by/status are required (legacy);
        // under 1.1 verb+branch are also required. The serializer
        // mirrors validateSubtasks: any key NOT in the required set
        // for this schema is treated as optional on emit (absent
        // values dropped, present values written).
        const subtaskRequiredForSchema =
          SUBTASK_REQUIRED_KEYS_BY_SCHEMA[fm.schema]
          ?? SUBTASK_REQUIRED_KEYS_BY_SCHEMA['1.1'];
        for (const entry of value.subtasks) {
          let opened = false;
          for (const k of SUBTASK_KEYS) {
            const v = entry[k];
            if (v === null || v === undefined) {
              if (!subtaskRequiredForSchema.has(k)) continue;
              if (k === 'blocked_by') {
                // blocked_by must always be present (caller invariant);
                // empty list is the canonical "no deps" representation.
                throw new Error(
                  `Missing required subtask key plan.subtasks[*].blocked_by (must be array, even if empty)`,
                );
              }
              throw new Error(`Missing required subtask key plan.subtasks[*].${k}`);
            }
            if (k === 'blocked_by') {
              if (!Array.isArray(v)) {
                throw new Error(`plan.subtasks[*].blocked_by must be an array`);
              }
              const inline = v.length === 0 ? '[]' : `[${v.map((it) => yamlScalar(it)).join(', ')}]`;
              if (!opened) {
                lines.push(`    - ${k}: ${inline}`);
                opened = true;
              } else {
                lines.push(`      ${k}: ${inline}`);
              }
            } else {
              if (!opened) {
                lines.push(`    - ${k}: ${yamlScalar(v)}`);
                opened = true;
              } else {
                lines.push(`      ${k}: ${yamlScalar(v)}`);
              }
            }
          }
        }
      }
      continue;
    }

    if (key === 'pending_ensemble' || key === 'ensemble_results') {
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
          let opened = false;
          for (const k of entryKeys) {
            const v = entry[k];
            if (v === null || v === undefined) {
              if (optional.has(k)) continue;
              throw new Error(
                `Missing required entry key ${key}[*].${k} (required by ADR-0017 mirror)`,
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

  for (const key of Object.keys(fm)) {
    if (!FRONTMATTER_KEY_ORDER.includes(key)) {
      throw new Error(
        `Unknown frontmatter key: ${key}. orchestrator schema '1.0' is closed.`,
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
  const body = after.slice(closeIdx + 5);

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
      if (key === 'git_baseline' || key === 'last_snapshot') {
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

      if (key === 'plan') {
        // ADR-0018 §sub-1 nested plan block:
        //   plan:
        //     decision: "..."          (optional inline scalar — 2-space indent)
        //     architecture: "..."      (optional inline scalar — 2-space indent)
        //     subtasks: [] | block-of-list-items
        const planObj = { subtasks: [] };
        i += 1;
        while (i < lines.length && lines[i].startsWith('  ') && !lines[i].startsWith('    ')) {
          const subLine = lines[i].slice(2);
          const subColon = subLine.indexOf(':');
          if (subColon === -1) {
            throw new Error(`Malformed plan inner line: ${JSON.stringify(lines[i])}`);
          }
          const subKey = subLine.slice(0, subColon);
          let subVal = subLine.slice(subColon + 1);
          if (subVal.startsWith(' ')) subVal = subVal.slice(1);

          if (subKey === 'subtasks') {
            if (subVal === '[]') {
              planObj.subtasks = [];
              i += 1;
              continue;
            }
            if (subVal !== '') {
              throw new Error(
                `Malformed plan.subtasks header: expected '[]' or block (got ${JSON.stringify(subVal)})`,
              );
            }
            // Block list — entries indented 4 spaces with `- ` opener.
            i += 1;
            const list = [];
            while (i < lines.length && lines[i].startsWith('    - ')) {
              const firstItemLine = lines[i].slice(6);
              const fcolon = firstItemLine.indexOf(':');
              if (fcolon === -1) {
                throw new Error(
                  `Malformed subtask list-item header: ${JSON.stringify(lines[i])}`,
                );
              }
              const fkey = firstItemLine.slice(0, fcolon);
              let fval = firstItemLine.slice(fcolon + 1);
              if (fval.startsWith(' ')) fval = fval.slice(1);
              const item = {};
              item[fkey] = parseListInlineOrScalar(fkey, fval);
              i += 1;
              while (
                i < lines.length &&
                lines[i].startsWith('      ') &&
                !lines[i].startsWith('    - ')
              ) {
                const cont = lines[i].slice(6);
                const ccolon = cont.indexOf(':');
                if (ccolon === -1) {
                  throw new Error(
                    `Malformed subtask continuation: ${JSON.stringify(lines[i])}`,
                  );
                }
                const ck = cont.slice(0, ccolon);
                let cv = cont.slice(ccolon + 1);
                if (cv.startsWith(' ')) cv = cv.slice(1);
                item[ck] = parseListInlineOrScalar(ck, cv);
                i += 1;
              }
              list.push(item);
            }
            planObj.subtasks = list;
            continue;
          }

          // decision / architecture — inline scalar
          if (!['decision', 'architecture'].includes(subKey)) {
            throw new Error(
              `Unknown plan inner key: ${subKey}. Expected: decision, architecture, subtasks.`,
            );
          }
          planObj[subKey] = parseScalar(subVal);
          i += 1;
        }
        fm[key] = planObj;
        continue;
      }

      if (
        key === 'host_history' ||
        key === 'pending_ensemble' ||
        key === 'ensemble_results'
      ) {
        const list = [];
        i += 1;
        while (i < lines.length && lines[i].startsWith('  - ')) {
          const firstItemLine = lines[i].slice(4);
          if (firstItemLine.includes(': ')) {
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
            list.push(parseScalar(firstItemLine));
            i += 1;
          }
        }
        fm[key] = list;
        continue;
      }
      throw new Error(`Empty value for unrecognized block key: ${key}`);
    }

    // Inline scalar
    if (
      rest === '[]' &&
      (key === 'host_history' ||
        key === 'pending_ensemble' ||
        key === 'ensemble_results')
    ) {
      fm[key] = [];
      i += 1;
      continue;
    }
    fm[key] = parseScalar(rest);
    i += 1;
  }

  for (const key of Object.keys(fm)) {
    if (!FRONTMATTER_KEY_ORDER.includes(key)) {
      throw new Error(
        `Unknown frontmatter key: ${key}. orchestrator schema '1.0' is closed.`,
      );
    }
  }

  validateFrontmatter(fm);

  return { frontmatter: fm, body };
}

// Parse a subtask list-item inline value: blocked_by is a flow-style
// list `[a, b]` or `[]`, every other key is a scalar.
function parseListInlineOrScalar(key, raw) {
  if (key === 'blocked_by') {
    const trimmed = raw.trim();
    if (trimmed === '[]') return [];
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
      throw new Error(
        `subtask blocked_by must be inline flow list (got ${JSON.stringify(raw)})`,
      );
    }
    const inner = trimmed.slice(1, -1).trim();
    if (inner === '') return [];
    // Split on commas, but JSON-string scalars are double-quoted so
    // they won't contain unescaped commas (yamlScalar uses JSON.stringify).
    // For safety, walk char-by-char respecting JSON-string boundaries.
    const items = [];
    let buf = '';
    let inStr = false;
    let escape = false;
    for (const ch of inner) {
      if (escape) {
        buf += ch;
        escape = false;
        continue;
      }
      if (ch === '\\' && inStr) {
        buf += ch;
        escape = true;
        continue;
      }
      if (ch === '"') {
        inStr = !inStr;
        buf += ch;
        continue;
      }
      if (ch === ',' && !inStr) {
        items.push(parseScalar(buf.trim()));
        buf = '';
        continue;
      }
      buf += ch;
    }
    if (buf.trim() !== '') items.push(parseScalar(buf.trim()));
    return items;
  }
  return parseScalar(raw);
}

function parseScalar(text) {
  if (text === '') return '';
  if (text.startsWith('"')) {
    return JSON.parse(text);
  }
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (text === 'true') return true;
  if (text === 'false') return false;
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
// Frontmatter validation — orchestrator schema '1.0'

/**
 * Strict ADR-0011 §2 / ADR-0018 §sub-1 schema='1.0' validation. Called at
 * parse-before-mutate boundaries. Throws on any deviation from the closed
 * schema set. orchestrator schema '1.0' rejects engineer schema 1 / '1.1' /
 * 2 cleanly to keep namespaces separate.
 */
function validateFrontmatter(fm) {
  if (!SUPPORTED_SCHEMA_VERSIONS.has(fm.schema)) {
    const accepted = [...SUPPORTED_SCHEMA_VERSIONS]
      .map((v) => JSON.stringify(v))
      .join(', ');
    throw new Error(
      `Unsupported schema version: ${JSON.stringify(fm.schema)} ` +
      `(supported: ${accepted}). orchestrator schema '1.0'/'1.1' is closed; ` +
      `engineer schema 1 / '1.1' / 2 files must not be mutated by orchestrator.`,
    );
  }
  const REQUIRED = [
    'schema', 'workflow_id', 'workflow_type', 'original_request',
    'started_at', 'updated_at', 'repo_root', 'git_baseline',
    'current_phase', 'next_action', 'plan', 'host_history',
  ];
  for (const k of REQUIRED) {
    if (!(k in fm)) {
      throw new Error(`Missing required frontmatter field: ${k}`);
    }
  }
  if (typeof fm.workflow_id !== 'string' || fm.workflow_id.length === 0) {
    throw new Error('workflow_id must be a non-empty string');
  }
  if (fm.workflow_type !== 'macro') {
    throw new Error(
      `workflow_type must be 'macro' (got ${JSON.stringify(fm.workflow_type)}). orchestrator MVP only supports macro workflows.`,
    );
  }
  validateNestedShape(fm, 'git_baseline', ['branch', 'head', 'status_digest']);

  // plan
  if (typeof fm.plan !== 'object' || fm.plan === null || Array.isArray(fm.plan)) {
    throw new Error('plan must be an object');
  }
  for (const k of Object.keys(fm.plan)) {
    if (!['decision', 'architecture', 'subtasks'].includes(k)) {
      throw new Error(`Unknown plan key: ${k}`);
    }
  }
  if (!Array.isArray(fm.plan.subtasks)) {
    throw new Error('plan.subtasks must be an array');
  }
  validateSubtasks(fm.plan.subtasks, fm.schema, fm.git_baseline?.branch ?? null);

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

  if ('last_snapshot' in fm) {
    validateNestedShape(fm, 'last_snapshot', ['at', 'trigger', 'status_digest']);
    validateSnapshotTrigger(fm.last_snapshot.trigger);
  }

  validateListOfObjectsField(fm, 'pending_ensemble');
  validateListOfObjectsField(fm, 'ensemble_results');

  // ADR-0019 PR-B (1.1) — optional terminal_marker boolean. Mirrors
  // engineer 1.1 pattern (state.mjs:1109). Required by §5 A1 gate
  // for macro-adapted stop-archive (PR-E).
  if ('terminal_marker' in fm) {
    if (typeof fm.terminal_marker !== 'boolean') {
      throw new Error('terminal_marker must be a boolean');
    }
  }
}

/**
 * Validate a schema-'1.0' list-of-objects optional field. The field's per-
 * entry key set is `ENTRY_KEYS_BY_LIST_KEY[key]`, which doubles as the
 * known-set check (no unknown subkeys; missing subkeys allowed only for
 * those marked optional below).
 *
 * Optional subkeys per ADR-0017 mirror:
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

/**
 * Per-list-key value-type checks. All schema '1.0' list-of-objects entries
 * carry string-shaped values (ISO timestamps, identifiers, free-form
 * summaries). Mirror of engineer's ADR-0017 §sub-4 validation; the same
 * gate applies to orchestrator's `pending_ensemble` + `ensemble_results`.
 *
 * Each value gate accepts either `string` (the canonical case) or — for
 * subkeys explicitly nullable per the entry-key spec — `null` /
 * `undefined`. The function throws with a precise field path on type
 * violation.
 */
function validateListOfObjectsValueTypes(key, idx, entry) {
  const optional = OPTIONAL_ENTRY_KEYS_BY_LIST_KEY[key] ?? new Set();
  for (const k of ENTRY_KEYS_BY_LIST_KEY[key]) {
    const v = entry[k];
    if (v === undefined || v === null) {
      if (optional.has(k)) continue;
      continue;
    }
    if (typeof v !== 'string') {
      throw new Error(
        `${key}[${idx}].${k} must be a string (got ${typeof v} ${JSON.stringify(v)})`,
      );
    }
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

// ADR-0018 §sub-1 + ADR-0019 §2 plan.subtasks[*] validation:
//   - id non-empty unique
//   - blocked_by → existing id, no self-cycle
//   - status enum (1.1 adds deferred / abandoned)
//   - optional fields are string-or-null
//   - 1.1: verb (canonical 6-verb whitelist) + branch (git ref-format) REQUIRED
//
// `schemaVersion` selects the required-key set: 1.0 retains the legacy
// invariants (id / blocked_by / status); 1.1 enforces verb + branch
// per ADR-0019 §1 branch precondition. The default `'1.1'` is for
// callers that don't have schema context (e.g., setPlan when emitting
// a fresh plan); validateFrontmatter passes the actual fm.schema.
function validateSubtasks(subtasks, schemaVersion = SCHEMA_VERSION, macroBranch = null) {
  const requiredKeys =
    SUBTASK_REQUIRED_KEYS_BY_SCHEMA[schemaVersion]
    ?? SUBTASK_REQUIRED_KEYS_BY_SCHEMA['1.1'];
  const ids = new Set();
  // ADR-0019 §1 — branch uniqueness across subtasks (1.1 only). Two
  // subtasks on the same branch would race the per-branch single-active
  // invariant at /orchestrator:next dispatch time: the first creates an
  // engineer workflow keyed by branch, the second's ownership check
  // (different originating_subtask) would abort. Catch at plan-set so
  // the macro plan never lands in an unexecutable shape.
  //
  // The collision map is seeded with the macro workflow's own branch
  // (`git_baseline.branch`) when supplied so subtasks cannot collide
  // with the macro branch via either exact match or path-prefix
  // (e.g., macro on `feat/api` rejects subtask `feat/api/db`). When
  // macroBranch is null (legacy / unknown context), the macro-branch
  // gate is skipped — callers that have the frontmatter context (the
  // validateFrontmatter call) supply it; setPlan's pre-write call
  // does not.
  const branches = new Map(); // branch → idx of first occurrence (or 'macro')
  const enforceBranchUniqueness = schemaVersion !== '1.0';
  if (enforceBranchUniqueness && typeof macroBranch === 'string' && macroBranch.length > 0) {
    branches.set(macroBranch, 'macro (git_baseline.branch)');
  }
  for (let idx = 0; idx < subtasks.length; idx++) {
    const e = subtasks[idx];
    if (typeof e !== 'object' || e === null || Array.isArray(e)) {
      throw new Error(`plan.subtasks[${idx}] must be an object`);
    }
    for (const k of Object.keys(e)) {
      if (!SUBTASK_KEYS_SET.has(k)) {
        throw new Error(
          `Unknown subtask key plan.subtasks[${idx}].${k}. Expected: ${SUBTASK_KEYS.join(', ')}.`,
        );
      }
    }
    for (const k of requiredKeys) {
      if (!(k in e)) {
        throw new Error(`Missing required subtask key plan.subtasks[${idx}].${k}`);
      }
    }
    if (typeof e.id !== 'string' || e.id.length === 0) {
      throw new Error(`plan.subtasks[${idx}].id must be a non-empty string`);
    }
    if (ids.has(e.id)) {
      throw new Error(`Duplicate subtask id: ${JSON.stringify(e.id)} (plan.subtasks[${idx}])`);
    }
    ids.add(e.id);
    if (!VALID_SUBTASK_STATUSES.has(e.status)) {
      throw new Error(
        `plan.subtasks[${idx}].status invalid: ${JSON.stringify(e.status)}. ` +
          `Must be one of ${[...VALID_SUBTASK_STATUSES].join(', ')}.`,
      );
    }
    if (!Array.isArray(e.blocked_by)) {
      throw new Error(`plan.subtasks[${idx}].blocked_by must be an array`);
    }
    for (const dep of e.blocked_by) {
      if (typeof dep !== 'string') {
        throw new Error(
          `plan.subtasks[${idx}].blocked_by entries must be strings (got ${typeof dep})`,
        );
      }
    }
    for (const k of SUBTASK_OPTIONAL_KEYS) {
      const v = e[k];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string') {
        throw new Error(
          `plan.subtasks[${idx}].${k} must be string|null (got ${typeof v})`,
        );
      }
    }
    // ADR-0019 §2 — verb whitelist (1.1 only; 1.0 plans don't carry verb).
    if ('verb' in e && e.verb !== null && e.verb !== undefined) {
      if (typeof e.verb !== 'string' || !VALID_SUBTASK_VERBS.has(e.verb)) {
        throw new Error(
          `plan.subtasks[${idx}].verb invalid: ${JSON.stringify(e.verb)}. ` +
            `Must be one of ${[...VALID_SUBTASK_VERBS].join(', ')}.`,
        );
      }
    }
    // ADR-0019 §1 — branch git ref-format gate (applies to 1.1; 1.0
    // tolerates any string here for legacy compatibility).
    if (schemaVersion !== '1.0' && 'branch' in e && e.branch !== null && e.branch !== undefined) {
      if (!isValidGitBranchSegment(e.branch)) {
        throw new Error(
          `plan.subtasks[${idx}].branch invalid git ref-format: ${JSON.stringify(e.branch)}. ` +
            `Branch names must not contain spaces, '..', '~ ^ : ? * [ \\\\', or start with '.', or end with '/' or '.lock'.`,
        );
      }
      // Branch uniqueness (1.1) — see §1 dispatch contract.
      if (enforceBranchUniqueness) {
        if (branches.has(e.branch)) {
          throw new Error(
            `Duplicate subtask branch: ${JSON.stringify(e.branch)} ` +
              `(plan.subtasks[${idx}] collides with plan.subtasks[${branches.get(e.branch)}]). ` +
              `Each 1.1 subtask MUST have a unique branch — /orchestrator:next dispatch ` +
              `keys engineer workflows by branch, so duplicate branches cannot both execute.`,
          );
        }
        // Prefix collision check (per Codex review): git stores refs
        // as path components. `feat/api` (a leaf ref) cannot coexist
        // with `feat/api/db` (would require `feat/api` to be a
        // directory). Plan-set rejects so /orchestrator:next never
        // hits "cannot lock ref ... exists" mid-dispatch.
        for (const [existing, existingIdx] of branches) {
          if (
            e.branch.startsWith(`${existing}/`)
            || existing.startsWith(`${e.branch}/`)
          ) {
            throw new Error(
              `Subtask branch prefix collision: plan.subtasks[${idx}].branch=${JSON.stringify(e.branch)} ` +
                `conflicts with plan.subtasks[${existingIdx}].branch=${JSON.stringify(existing)} ` +
                `(git stores refs as path components — one cannot be a leaf and another a parent directory). ` +
                `Choose distinct branch names with no shared path-prefix relationship.`,
            );
          }
        }
        branches.set(e.branch, idx);
      }
    }
  }
  for (let idx = 0; idx < subtasks.length; idx++) {
    const e = subtasks[idx];
    for (const dep of e.blocked_by) {
      if (dep === e.id) {
        throw new Error(
          `plan.subtasks[${idx}] self-reference in blocked_by: ${JSON.stringify(e.id)} depends on itself`,
        );
      }
      if (!ids.has(dep)) {
        throw new Error(
          `plan.subtasks[${idx}].blocked_by references unknown subtask id ${JSON.stringify(dep)}`,
        );
      }
    }
  }
}

// ADR-0019 PR-B — refuse mutations on legacy 1.0 files. Reads pass
// validateFrontmatter (1.0 supported), but writes back via setPlan /
// appendPhase / snapshot / ensemble helpers must abort with a
// diagnostic so legacy plans don't get half-migrated. Users either
// archive the legacy workflow or run /orchestrator:plan to start
// fresh under 1.1.
function ensureMutable(fm) {
  if (fm.schema === '1.0') {
    throw new Error(
      `Cannot mutate schema 1.0 file (legacy ADR-0018 §sub-1 shape). ` +
        `Per ADR-0019 PR-B schema bump, /orchestrator:plan now emits 1.1 workflows. ` +
        `Archive this legacy workflow (move to .claude/agentic-orchestrator/archive/) ` +
        `and run /orchestrator:plan on this branch to start a fresh 1.1 plan.`,
    );
  }
}

function validateHost(host) {
  if (!VALID_HOSTS.has(host)) {
    throw new Error(`Invalid host: ${host}. Must be one of ${[...VALID_HOSTS].join(', ')}`);
  }
}

function validateHookEvent(event) {
  if (!VALID_HOOK_EVENTS.has(event)) {
    throw new Error(
      `Invalid host_history event: ${event}. orchestrator MVP supports ${[...VALID_HOOK_EVENTS].join(', ')}.`,
    );
  }
}

function validateSnapshotTrigger(trigger) {
  if (!VALID_SNAPSHOT_TRIGGERS.has(trigger)) {
    throw new Error(`Invalid snapshot trigger: ${trigger}.`);
  }
}

function validateVerb(verb) {
  if (!VALID_VERBS.has(verb)) {
    throw new Error(
      `Invalid verb: ${verb}. orchestrator MVP supports ${[...VALID_VERBS].join(', ')} only.`,
    );
  }
}

function isoUtc(now = new Date()) {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// -----------------------------------------------------------------------------
// Secret scrubbing per ADR-0011 §2 — verbatim mirror.

const SECRET_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\bgh[poushr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[bpar]-[A-Za-z0-9-]{10,}\b/g,
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
 * Throws if any workflow already exists on the same branch (per-branch
 * single-active invariant per ADR-0018 §sub-2).
 *
 * Caller is expected to hold the directory lock. Use createWorkflow()
 * for the lock-wrapped variant. The `ownership` object (when provided)
 * carries the directory-lock token and is forwarded to `atomicWrite()`
 * for pre-commit recheck.
 */
export async function createWorkflowUnderLock({
  repoRoot,
  verb,
  workflowType = 'macro',
  originalRequest,
  gitBaseline,
  host,
  currentPhase = 'phase-0',
  nextAction = '',
  bodyTitle,
  now = new Date(),
}, ownership = null) {
  validateVerb(verb);
  validateHost(host);
  if (workflowType !== 'macro') {
    throw new Error(
      `createWorkflow: workflowType must be 'macro' (got ${JSON.stringify(workflowType)})`,
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

  const existing = await findActiveWorkflowByBranch(repoRoot, gitBaseline.branch);
  if (existing) {
    throw new Error(
      `Cannot create workflow — a workflow already exists on branch '${gitBaseline.branch}' (${existing}). ` +
        `Per-branch single-active invariant (ADR-0018 §sub-2). ` +
        `Resume on this branch, or archive the existing workflow first.`,
    );
  }

  const workflowId = generateWorkflowId(verb, { now });
  const nowIso = isoUtc(now);
  const scrubbedRequest = singleLine(scrubSecrets(originalRequest ?? ''));

  const frontmatter = {
    schema: SCHEMA_VERSION,
    workflow_id: workflowId,
    workflow_type: workflowType,
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
    plan: { subtasks: [] },
    host_history: [
      { host, at: nowIso, event: 'created' },
    ],
  };

  const title = bodyTitle ?? `orchestrator:${verb}`;
  const body =
    `# ${title}\n\n` +
    `## Original Request\n\n` +
    `${scrubbedRequest || '(no original request recorded)'}\n\n` +
    `## Phase notes\n\n` +
    `### ${currentPhase}\n\n`;

  const filePath = workflowFilePath(repoRoot, workflowId);
  await ensureDir(workflowDir(repoRoot), 0o700);
  await atomicWrite(filePath, assembleWorkflowFile(frontmatter, body), ownership);

  return { workflowId, filePath, frontmatter, body };
}

export async function createWorkflow(args) {
  return withDirectoryLock(args.repoRoot, ({ lockPath, token }) =>
    createWorkflowUnderLock(args, { lockPath, token }),
  );
}

// -----------------------------------------------------------------------------
// Public API: appendPhase

export async function appendPhase({
  workflowPath,
  host,
  verb,
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
    ensureMutable(frontmatter);
    const nowIso = isoUtc(now);

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
// Public API: snapshot — used by hooks per ADR-0011 §4 + ADR-0018 §sub-1
// Stop-as-snapshot policy

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
    ensureMutable(frontmatter);
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
// Ensemble bookkeeping (ADR-0017 §sub-4 mirror)

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
  if (started_at !== undefined && typeof started_at !== 'string') {
    throw new Error(
      `recordPendingEnsemble: started_at must be a string (got ${typeof started_at})`,
    );
  }
  return withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    ensureMutable(frontmatter);
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
  if (completed_at !== undefined && typeof completed_at !== 'string') {
    throw new Error(
      `commitEnsemble: completed_at must be a string (got ${typeof completed_at})`,
    );
  }
  return withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    ensureMutable(frontmatter);
    const nowIso = isoUtc(now);

    const pending = Array.isArray(frontmatter.pending_ensemble)
      ? frontmatter.pending_ensemble
      : [];
    frontmatter.pending_ensemble = pending.filter((e) => e.run_id !== run_id);

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
// Public API: setPlan (ADR-0018 §sub-1 macro plan write)
//
// Atomic write of plan.{decision?, architecture?, subtasks[]} under the
// per-file lock + atomicWrite ownership-token recheck. Validates subtask
// id uniqueness, blocked_by → existing id (no self-cycle), and status enum.

export async function setPlan({
  workflowPath,
  decision = null,
  architecture = null,
  subtasks,
  host,
  event = 'updated',
  now = new Date(),
}) {
  validateHost(host);
  validateHookEvent(event);
  if (!Array.isArray(subtasks)) {
    throw new Error('setPlan: subtasks must be an array');
  }
  if (decision !== null && decision !== undefined && typeof decision !== 'string') {
    throw new Error(
      `setPlan: decision must be string|null (got ${typeof decision})`,
    );
  }
  if (architecture !== null && architecture !== undefined && typeof architecture !== 'string') {
    throw new Error(
      `setPlan: architecture must be string|null (got ${typeof architecture})`,
    );
  }

  return withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    // Per ADR-0019 PR-B: refuse mutation on 1.0 files BEFORE running
    // validateSubtasks so legacy plans get the archive/re-plan
    // diagnostic instead of a confusing "Missing required verb"
    // (which would mislead users who haven't realized their file
    // is the legacy shape).
    ensureMutable(frontmatter);
    // Pass macro branch for the §1 prefix-collision gate so a subtask
    // branch cannot path-collide with the parent macro branch.
    validateSubtasks(subtasks, frontmatter.schema, frontmatter.git_baseline?.branch ?? null);
    const nowIso = isoUtc(now);

    const plan = { subtasks };
    if (decision !== null && decision !== undefined) {
      plan.decision = decision;
    }
    if (architecture !== null && architecture !== undefined) {
      plan.architecture = architecture;
    }
    frontmatter.plan = plan;
    frontmatter.updated_at = nowIso;
    frontmatter.host_history = [
      ...(frontmatter.host_history ?? []),
      { host, at: nowIso, event },
    ];

    const noteHeading = `### plan-set @ ${nowIso}\n\n`;
    const noteSummary =
      `${subtasks.length} subtask${subtasks.length === 1 ? '' : 's'}` +
      `${decision ? ', decision recorded' : ''}` +
      `${architecture ? ', architecture recorded' : ''}.\n\n`;
    const newBody = `${body}${noteHeading}${noteSummary}`;

    await atomicWrite(
      workflowPath,
      assembleWorkflowFile(frontmatter, newBody),
      { lockPath, token },
    );
    return { frontmatter, workflowPath };
  });
}

// -----------------------------------------------------------------------------
// Public API: updateSubtask (ADR-0019 PR-C0)
//
// Atomic single-subtask mutation. Updates one `plan.subtasks[i]` entry
// by `id` without rewriting the entire plan. Required by PR-C
// (engineer-local parent-writeback helper) and PR-D
// (/orchestrator:next + /orchestrator:done) — those callers
// transition exactly one subtask's status / records the dispatched
// engineer_workflow_id / writes back commit + closed_at on completion.
//
// Side effects applied atomically with the primary mutation:
//   - Unblock pass (per ADR-0019 §4 step 6): any subtask with
//     `status: 'blocked'` whose `blocked_by` predecessors are now all
//     `completed` transitions to `'pending'`.
//   - Auto-terminal pass (per ADR-0019 §4 step 7): if this update
//     caused ALL subtasks to reach a terminal status
//     (`completed | deferred | abandoned`) AND the macro's
//     `terminal_marker` is not already set, also write
//     `terminal_marker: true` AND `current_phase: 'commit-complete'`.
//     This is the happy-path auto-promotion that lets the macro
//     stop-archive A1/A2 gates pass without an explicit /finalize call.
//
// Immutable fields (rejected if supplied): `id`, `verb`, `branch`,
// `blocked_by`, `profile`, `topic`, `label`. These are plan-time
// decisions; changing them requires `setPlan` (full re-plan).

const TERMINAL_SUBTASK_STATUSES = new Set(['completed', 'deferred', 'abandoned']);

const UPDATE_SUBTASK_ALLOWED_KEYS = new Set([
  'workflowPath', 'subtaskId', 'status', 'engineerWorkflowId',
  'commit', 'prUrl', 'closedAt', 'host', 'event', 'now',
]);

export async function updateSubtask(opts) {
  if (typeof opts !== 'object' || opts === null) {
    throw new Error('updateSubtask: opts must be an object');
  }
  // ADR-0019 PR-C0 — reject unknown keys at the API boundary so an
  // imported caller spreading a subtask object can't silently bypass
  // the immutable-field contract. Immutable plan-time fields
  // (id, verb, branch, blocked_by, profile, topic, label) must go
  // through setPlan, not updateSubtask.
  for (const key of Object.keys(opts)) {
    if (!UPDATE_SUBTASK_ALLOWED_KEYS.has(key)) {
      throw new Error(
        `updateSubtask: unknown option ${JSON.stringify(key)}. ` +
          `Allowed: ${[...UPDATE_SUBTASK_ALLOWED_KEYS].join(', ')}. ` +
          `Immutable plan-time fields (id, verb, branch, blocked_by, profile, topic, label) ` +
          `must be changed via setPlan (full re-plan).`,
      );
    }
  }
  const {
    workflowPath,
    subtaskId,
    status,
    engineerWorkflowId,
    commit,
    prUrl,
    closedAt,
    host,
    event = 'updated',
    now = new Date(),
  } = opts;
  validateHost(host);
  validateHookEvent(event);
  if (typeof subtaskId !== 'string' || subtaskId.length === 0) {
    throw new Error('updateSubtask: subtaskId must be a non-empty string');
  }

  // Build the update payload — only the mutation-allowed fields.
  // `undefined` means "leave existing value untouched"; explicit
  // `null` is rejected as ambiguous (callers should omit instead).
  const payload = {};
  const reject = (name, v) => {
    if (v === null) {
      throw new Error(
        `updateSubtask: ${name} must not be null (omit the argument to leave existing value untouched)`,
      );
    }
  };
  reject('status', status);
  reject('engineerWorkflowId', engineerWorkflowId);
  reject('commit', commit);
  reject('prUrl', prUrl);
  reject('closedAt', closedAt);
  if (status !== undefined) {
    if (!VALID_SUBTASK_STATUSES.has(status)) {
      throw new Error(
        `updateSubtask: status invalid: ${JSON.stringify(status)}. ` +
          `Must be one of ${[...VALID_SUBTASK_STATUSES].join(', ')}.`,
      );
    }
    // ADR-0019 §4 — terminal-partial statuses (deferred, abandoned)
    // are the /orchestrator:finalize and /orchestrator:abort decision
    // domains; they MUST come through setPlan (full re-plan), not
    // single-subtask update. Allowing them here would let a caller
    // bypass /finalize-/abort terminal_marker + current_phase labels
    // (the auto-terminal pass below would mislabel the macro as
    // commit-complete instead of finalized/aborted).
    if (status === 'deferred' || status === 'abandoned') {
      throw new Error(
        `updateSubtask: cannot set status to ${JSON.stringify(status)} ` +
          `via single-subtask update — those terminal-partial states ` +
          `are owned by /orchestrator:finalize / /orchestrator:abort ` +
          `(via setPlan), so terminal_marker + current_phase land on ` +
          `the correct finalize/abort labels rather than the happy-path ` +
          `'commit-complete'.`,
      );
    }
    payload.status = status;
  }
  if (engineerWorkflowId !== undefined) {
    if (typeof engineerWorkflowId !== 'string' || engineerWorkflowId.length === 0) {
      throw new Error('updateSubtask: engineerWorkflowId must be a non-empty string');
    }
    payload.engineer_workflow_id = engineerWorkflowId;
  }
  if (commit !== undefined) {
    if (typeof commit !== 'string' || commit.length === 0) {
      throw new Error('updateSubtask: commit must be a non-empty string');
    }
    payload.commit = commit;
  }
  if (prUrl !== undefined) {
    if (typeof prUrl !== 'string' || prUrl.length === 0) {
      throw new Error('updateSubtask: prUrl must be a non-empty string');
    }
    payload.pr_url = prUrl;
  }
  if (closedAt !== undefined) {
    if (typeof closedAt !== 'string' || closedAt.length === 0) {
      throw new Error('updateSubtask: closedAt must be a non-empty string');
    }
    payload.closed_at = closedAt;
  }
  if (Object.keys(payload).length === 0) {
    throw new Error(
      'updateSubtask: at least one mutable field must be supplied (status / engineerWorkflowId / commit / prUrl / closedAt)',
    );
  }

  return withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    ensureMutable(frontmatter);

    const subtasks = frontmatter.plan?.subtasks;
    if (!Array.isArray(subtasks)) {
      throw new Error(
        'updateSubtask: workflow has no plan.subtasks[]; run /orchestrator:plan first',
      );
    }
    const targetIdx = subtasks.findIndex((s) => s.id === subtaskId);
    if (targetIdx === -1) {
      throw new Error(
        `updateSubtask: subtask id ${JSON.stringify(subtaskId)} not found in plan.subtasks[]`,
      );
    }

    const nowIso = isoUtc(now);
    const current = subtasks[targetIdx];

    // ADR-0019 §4 precondition — terminal-partial states (deferred /
    // abandoned) are ABSORBING. Once `/orchestrator:finalize` or
    // `/orchestrator:abort` sets a subtask to deferred/abandoned, no
    // single-subtask update can transition it back — that would
    // resurrect a subtask whose terminal decision the user already
    // recorded, breaking the all-subtasks-terminal lifecycle invariant
    // §5 macro-archive depends on. Any update (completion writeback
    // OR non-completion mutation such as a delayed /next setting
    // status=in_progress + engineerWorkflowId) is skipped with a
    // diagnostic. Only setPlan (full re-plan) can change a
    // terminal-partial subtask's shape.
    if (current.status === 'deferred' || current.status === 'abandoned') {
      return {
        frontmatter,
        workflowPath,
        updatedSubtask: current,
        autoTerminal: false,
        skipped: true,
        skipReason: `subtask ${JSON.stringify(subtaskId)} already terminal as ${current.status}; ` +
          `single-subtask update ignored to preserve /finalize or /abort decision ` +
          `(ADR-0019 §4 precondition — terminal-partial states are absorbing). ` +
          `Use setPlan if a full re-plan is intended.`,
      };
    }

    // ADR-0019 §4 — `completed` is absorbing for status transitions.
    // A delayed /next post-dispatch writeback or any caller cannot
    // resurrect a subtask after engineer Stop or /done marked it
    // completed; that would leave terminal_marker / current_phase set
    // from the prior auto-terminal pass while plan.subtasks[] is no
    // longer all-terminal, breaking the macro stop-archive gates.
    // Idempotent metadata updates from the same owner (e.g., adding
    // pr_url after the initial commit writeback) are still allowed —
    // those don't touch status.
    if (current.status === 'completed' && 'status' in payload && payload.status !== 'completed') {
      return {
        frontmatter,
        workflowPath,
        updatedSubtask: current,
        autoTerminal: false,
        skipped: true,
        skipReason: `subtask ${JSON.stringify(subtaskId)} already completed; ` +
          `status downgrade to ${JSON.stringify(payload.status)} ignored — ` +
          `'completed' is absorbing for status transitions (ADR-0019 §4). ` +
          `Use setPlan if a full re-plan is intended.`,
      };
    }

    // ADR-0019 §4 ownership check — once an engineer_workflow_id is
    // recorded for a subtask, completion-side writebacks (status →
    // completed, commit, closed_at) MUST carry the matching owner id.
    // Stale or misrouted writebacks (missing id, or different id) are
    // rejected so the original child's writeback path stays the
    // single source of truth. Non-completion updates (e.g., reading
    // a status that already reflects the child's progress) don't
    // require the id.
    const hasCompletionFields =
      payload.status === 'completed'
      || 'commit' in payload
      || 'closed_at' in payload
      || 'pr_url' in payload;

    // ADR-0019 §4 — every completion writeback (status=completed,
    // commit, closed_at, pr_url) MUST supply engineer_workflow_id.
    // This covers BOTH the first-write case (current.engineer_workflow_id
    // absent — establishes owner) AND the subsequent-write case
    // (current.engineer_workflow_id present — must match). Without
    // this gate, a caller could write completion artifacts to an
    // unowned subtask, then a later misrouted writeback could
    // overwrite them with no single-writer enforcement available.
    if (hasCompletionFields && typeof payload.engineer_workflow_id !== 'string') {
      throw new Error(
        `updateSubtask: completion writeback (status=completed / commit / closed_at / pr_url) ` +
          `MUST supply --engineer-workflow-id so the subtask binds to its child workflow. ` +
          `Without an owner id, later writebacks cannot be verified against stale dispatches.`,
      );
    }

    if (typeof current.engineer_workflow_id === 'string' && current.engineer_workflow_id.length > 0) {
      if (hasCompletionFields) {
        // engineer_workflow_id must match (presence already guaranteed
        // by the gate above).
        if (payload.engineer_workflow_id !== current.engineer_workflow_id) {
          throw new Error(
            `updateSubtask: engineer_workflow_id mismatch on subtask ${JSON.stringify(subtaskId)}. ` +
              `Existing: ${JSON.stringify(current.engineer_workflow_id)}, ` +
              `incoming: ${JSON.stringify(payload.engineer_workflow_id)}. ` +
              `Ownership is single-writer once set; archive or reconcile the stale child workflow first.`,
          );
        }
      } else if (
        typeof payload.engineer_workflow_id === 'string'
        && payload.engineer_workflow_id !== current.engineer_workflow_id
      ) {
        // Non-completion path also rejects mismatched ids (so a
        // re-attach via /next can't accidentally overwrite the
        // owner record either).
        throw new Error(
          `updateSubtask: engineer_workflow_id mismatch on subtask ${JSON.stringify(subtaskId)}. ` +
            `Existing: ${JSON.stringify(current.engineer_workflow_id)}, ` +
            `incoming: ${JSON.stringify(payload.engineer_workflow_id)}. ` +
            `Ownership is single-writer once set; archive or reconcile the stale child workflow first.`,
        );
      }
    }

    // Apply primary mutation.
    const updated = { ...current, ...payload };
    subtasks[targetIdx] = updated;

    // Unblock pass — any blocked subtask whose blocked_by predecessors
    // are now all completed transitions to pending.
    const completedIds = new Set(
      subtasks.filter((s) => s.status === 'completed').map((s) => s.id),
    );
    for (let i = 0; i < subtasks.length; i++) {
      const s = subtasks[i];
      if (s.status !== 'blocked') continue;
      if (!Array.isArray(s.blocked_by) || s.blocked_by.length === 0) continue;
      const allComplete = s.blocked_by.every((depId) => completedIds.has(depId));
      if (allComplete) {
        subtasks[i] = { ...s, status: 'pending' };
      }
    }

    // Auto-terminal pass — if all subtasks are now terminal AND macro
    // has not already been marked terminal (by /finalize or /abort),
    // auto-promote macro to commit-complete. Track whether this
    // invocation actually performed the promotion so callers can
    // distinguish a fresh happy-path auto-terminal from a state
    // that was already terminal-marked by an earlier /finalize.
    const allTerminal = subtasks.every((s) => TERMINAL_SUBTASK_STATUSES.has(s.status));
    const autoTerminalSetThisCall = allTerminal && frontmatter.terminal_marker !== true;
    if (autoTerminalSetThisCall) {
      frontmatter.terminal_marker = true;
      frontmatter.current_phase = 'commit-complete';
    }

    // Re-validate the full plan against schema invariants (catches
    // any caller violations that slipped past payload guards).
    validateSubtasks(subtasks, frontmatter.schema, frontmatter.git_baseline?.branch ?? null);

    frontmatter.updated_at = nowIso;
    frontmatter.host_history = [
      ...(frontmatter.host_history ?? []),
      { host, at: nowIso, event },
    ];

    const noteHeading = `### subtask-update ${JSON.stringify(subtaskId)} @ ${nowIso}\n\n`;
    const noteSummary =
      `Fields updated: ${Object.keys(payload).join(', ')}` +
      (autoTerminalSetThisCall ? '. Auto-terminal: all subtasks terminal; terminal_marker + current_phase set.' : '.') +
      '\n\n';
    const newBody = `${body}${noteHeading}${noteSummary}`;

    await atomicWrite(
      workflowPath,
      assembleWorkflowFile(frontmatter, newBody),
      { lockPath, token },
    );
    return {
      frontmatter,
      workflowPath,
      updatedSubtask: subtasks[targetIdx],
      autoTerminal: autoTerminalSetThisCall,
    };
  });
}

// -----------------------------------------------------------------------------
// CLI

function cliParseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      throw new Error(`unexpected positional argument: ${token}`);
    }
    const eqIdx = token.indexOf('=');
    let name;
    let value;
    if (eqIdx !== -1) {
      name = token.slice(2, eqIdx);
      value = token.slice(eqIdx + 1);
    } else {
      name = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        // Flag with no following value — set to empty string. Caller
        // checks required-presence via cliRequire.
        value = '';
      } else {
        value = next;
        i += 1;
      }
    }
    flags[name] = value;
  }
  return flags;
}

function cliRequire(flags, names) {
  for (const n of names) {
    if (!(n in flags)) {
      throw new Error(`missing required flag --${n}`);
    }
  }
}

function cliPrintHelp() {
  process.stdout.write(
    [
      'plugins/orchestrator/scripts/state.mjs — orchestrator schema 1.1 state CLI (1.0 read-only)',
      '',
      'Usage:',
      '',
      '  find-active --repo-root <path> [--branch <branch>]',
      '    Print absolute path of active workflow on the given branch (or current branch).',
      '    Empty stdout + exit 0 if no active workflow on this branch.',
      '',
      '  create --repo-root <path> --verb plan --host claude|codex',
      '         --git-baseline-branch <name> --git-baseline-head <sha>',
      '         [--status-digest <hex>] [--original-request <text>]',
      '         [--current-phase <label>] [--next-action <text>]',
      '         [--body-title <title>]',
      '    Bootstrap a new orchestrator macro workflow for the verb.',
      '',
      '  append --workflow-path <path> --host <host>',
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
      '    Print the parsed frontmatter as JSON on stdout.',
      '',
      '  ensemble-pending --workflow-path <path> --phase <name>',
      '                   --ensemble-type <name> --run-id <id> [--started-at <iso>]',
      '    Record a pending ensemble dispatch. Idempotent on run-id.',
      '',
      '  ensemble-commit --workflow-path <path> --run-id <id> --phase <name>',
      '                  --ensemble-type <name> --verdict <text> --summary <text>',
      '                  [--completed-at <iso>] [--codex-session-id <id>]',
      '                  [--cap <n>]',
      '    Three-step atomic commit: pop pending → append result → prune.',
      '',
      '  plan-set --workflow-path <path> --host claude|codex',
      '           --subtasks-json-file <path>',
      '           [--decision <text>] [--architecture <text>]',
      '           [--event updated|resumed]',
      '    ADR-0018 §sub-1 + ADR-0019 §2 — atomic write of plan.{decision?, architecture?, subtasks[]}.',
      '    --subtasks-json-file points at a UTF-8 JSON file whose top-level value',
      '    is the subtasks array. Schema 1.1 subtask shape:',
      '      {id, verb, branch, blocked_by[], status,                      (REQUIRED)',
      '       label?, profile?, topic?,                                    (optional 1.1)',
      '       engineer_workflow_id?, commit?, pr_url?, closed_at?}         (optional, post-dispatch)',
      '    verb ∈ {investigate, frame, decide, compose, critique, refine}',
      '    status ∈ {pending, blocked, in_progress, completed, deferred, abandoned}',
      '    branch must pass git ref-format (ADR-0019 §1).',
      '    Note: 1.0 legacy files are READ-only — mutations refused with diagnostic.',
      '',
      '  subtask-update --workflow-path <path> --host claude|codex',
      '                 --subtask-id <id>',
      '                 [--status <status>] [--engineer-workflow-id <id>]',
      '                 [--commit <sha>] [--pr-url <url>] [--closed-at <iso>]',
      '                 [--event updated|resumed]',
      '    ADR-0019 PR-C0 — atomic single-subtask mutation. Updates one',
      '    plan.subtasks[i] entry by id without rewriting the whole plan.',
      '    At least one mutable field must be supplied. Immutable fields',
      '    (id / verb / branch / blocked_by / profile / topic / label) are rejected;',
      '    use plan-set for full re-planning.',
      '    Side effects (atomic): unblock pass (§4 step 6) + auto-terminal pass',
      '    (§4 step 7 — sets terminal_marker + current_phase when all subtasks',
      '    are terminal). Prints JSON {workflowPath, updatedSubtask, autoTerminal}.',
      '',
      'Verbs: plan (orchestrator MVP).',
      'Hosts: claude, codex.',
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
        const path =
          'branch' in flags
            ? await findActiveWorkflowByBranch(flags['repo-root'], flags.branch)
            : await findActiveWorkflow(flags['repo-root']);
        if (path) process.stdout.write(`${path}\n`);
        return 0;
      }

      case 'create': {
        cliRequire(flags, [
          'repo-root', 'verb', 'host',
          'git-baseline-branch', 'git-baseline-head',
        ]);
        const result = await createWorkflow({
          repoRoot: flags['repo-root'],
          verb: flags.verb,
          host: flags.host,
          originalRequest: flags['original-request'] ?? '',
          gitBaseline: {
            branch: flags['git-baseline-branch'],
            head: flags['git-baseline-head'],
            status_digest: flags['status-digest'] ?? '',
          },
          currentPhase: flags['current-phase'] ?? 'phase-0',
          nextAction: flags['next-action'] ?? '',
          bodyTitle: flags['body-title'],
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
        process.stdout.write(`${JSON.stringify(frontmatter, null, 2)}\n`);
        return 0;
      }

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

      case 'plan-set': {
        cliRequire(flags, ['workflow-path', 'host', 'subtasks-json-file']);
        const subtasksRaw = await readFile(flags['subtasks-json-file'], 'utf8');
        let subtasks;
        try {
          subtasks = JSON.parse(subtasksRaw);
        } catch (err) {
          throw new Error(
            `--subtasks-json-file is not valid JSON: ${err.message}`,
          );
        }
        if (!Array.isArray(subtasks)) {
          throw new Error(
            `--subtasks-json-file top-level must be an array (got ${typeof subtasks})`,
          );
        }
        await setPlan({
          workflowPath: flags['workflow-path'],
          decision: flags.decision ?? null,
          architecture: flags.architecture ?? null,
          subtasks,
          host: flags.host,
          event: flags.event ?? 'updated',
        });
        process.stdout.write(`${flags['workflow-path']}\n`);
        return 0;
      }

      case 'subtask-update': {
        cliRequire(flags, ['workflow-path', 'host', 'subtask-id']);
        // ADR-0019 PR-C0 — surface forbidden mutations instead of
        // silently dropping them. The API only accepts mutable fields
        // (status / engineer-workflow-id / commit / pr-url / closed-at);
        // any immutable-field flag is a caller bug worth flagging.
        const IMMUTABLE_FLAGS = [
          'id', 'verb', 'branch', 'blocked-by',
          'profile', 'topic', 'label',
        ];
        for (const f of IMMUTABLE_FLAGS) {
          if (f in flags) {
            throw new Error(
              `--${f} cannot be set via subtask-update (immutable plan-time field). ` +
                `Use plan-set for full re-planning if a plan-time field must change.`,
            );
          }
        }
        const result = await updateSubtask({
          workflowPath: flags['workflow-path'],
          subtaskId: flags['subtask-id'],
          host: flags.host,
          status: flags.status,
          engineerWorkflowId: flags['engineer-workflow-id'],
          commit: flags.commit,
          prUrl: flags['pr-url'],
          closedAt: flags['closed-at'],
          event: flags.event ?? 'updated',
        });
        // Emit JSON envelope so callers (PR-C engineer parent-writeback
        // helper, PR-D /next + /done runbooks) can parse the result
        // including the auto-terminal signal AND the skip signal
        // (deferred/abandoned precondition path returns skipped=true
        // with skipReason).
        const envelope = {
          workflowPath: result.workflowPath,
          updatedSubtask: result.updatedSubtask,
          autoTerminal: result.autoTerminal,
        };
        if (result.skipped) {
          envelope.skipped = true;
          envelope.skipReason = result.skipReason;
          // Also surface the diagnostic on stderr so shell callers
          // that don't parse JSON still see the suppression.
          process.stderr.write(`state.mjs subtask-update: ${result.skipReason}\n`);
        }
        process.stdout.write(`${JSON.stringify(envelope)}\n`);
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
  const code = await cliMain(process.argv.slice(2));
  process.exit(code);
}
