#!/usr/bin/env node
// plugins/engineer/scripts/state.mjs
//
// Host-shared canonical state I/O for the engineer plugin per ADR-0011.
//
// Used by:
//   - plugins/engineer/commands/<verb>.md (thin-shim Phase 0 + state finalize)
//   - plugins/engineer/adapters/{claude,codex}/hooks/* (snapshot writes)
//
// Storage location:
//   <repo_root>/.claude/agentic-engineer/workflows/<workflow_id>.md
//
// Lock files:
//   <repo_root>/.claude/agentic-engineer/.creation-lock        (directory-level)
//   <repo_root>/.claude/agentic-engineer/workflows/<id>.md.lock (per-file)
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

// -----------------------------------------------------------------------------
// Constants — ADR-0011 §1, §2, §3

export const SCHEMA_VERSION = 1;
export const WORKFLOW_DIR_REL = '.claude/agentic-engineer/workflows';
export const CREATION_LOCK_REL = '.claude/agentic-engineer/.creation-lock';

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
const VALID_HOSTS = new Set(['claude', 'codex']);
const VALID_HOOK_EVENTS = new Set(['created', 'updated', 'snapshot', 'resumed']);
const VALID_SNAPSHOT_TRIGGERS = new Set(['pre-compact', 'stop']);

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
// Discovery — single-active invariant per ADR-0011 §1

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
 * Find the single active workflow file or return null. Throws if more
 * than one exists (single-active invariant per ADR-0011 §1).
 */
export async function findActiveWorkflow(repoRoot) {
  const files = await listWorkflowFiles(repoRoot);
  if (files.length === 0) return null;
  if (files.length === 1) return files[0];
  throw new Error(
    `Multi-active state detected: ${files.length} workflow files in ${workflowDir(repoRoot)}. ` +
      `Stage 2 enforces single-active invariant (ADR-0011 §1). ` +
      `Reconcile manually before continuing.`,
  );
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
];

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

  // Drop frontmatter keys not in canonical order — schema=1 is closed.
  // (Unknown keys would silently drop on round-trip, so we surface them.)
  for (const key of Object.keys(fm)) {
    if (!FRONTMATTER_KEY_ORDER.includes(key)) {
      throw new Error(`Unknown frontmatter key: ${key}. ADR-0011 §2 schema=1 is closed.`);
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
      if (key === 'host_history' || key === 'tasks') {
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
      throw new Error(`Empty value for unrecognized block key: ${key}`);
    }

    // Inline scalar
    if (rest === '[]' && (key === 'tasks' || key === 'host_history')) {
      fm[key] = [];
      i += 1;
      continue;
    }
    fm[key] = parseScalar(rest);
    i += 1;
  }

  // Surface unknown keys per closed-schema rule.
  for (const key of Object.keys(fm)) {
    if (!FRONTMATTER_KEY_ORDER.includes(key)) {
      throw new Error(`Unknown frontmatter key: ${key}. ADR-0011 §2 schema=1 is closed.`);
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
 * Strict ADR-0011 §2 schema=1 validation. Called at parse-before-mutate
 * boundaries. Throws on any deviation from the closed schema set.
 */
function validateFrontmatter(fm) {
  if (fm.schema !== SCHEMA_VERSION) {
    throw new Error(
      `Unsupported schema version: ${fm.schema} (expected ${SCHEMA_VERSION}). ` +
      `ADR-0011 §2 schema=1 is closed; cross-schema mutation is rejected.`,
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

function assembleWorkflowFile(frontmatter, body) {
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
  persona = 'engineer',
  profile = '',
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
  if (!gitBaseline || !gitBaseline.branch || !gitBaseline.head) {
    throw new Error('gitBaseline must have { branch, head, status_digest }');
  }
  const existing = await listWorkflowFiles(repoRoot);
  if (existing.length > 0) {
    throw new Error(
      `Cannot create workflow — ${existing.length} workflow file(s) already exist. ` +
        `Stage 2 enforces single-active invariant (ADR-0011 §1).`,
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
  };

  const title = bodyTitle ?? `${persona}:${verb}`;
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
      '  find-active --repo-root <path>',
      '    Print the single active workflow path (empty if none). Exit 0 on success;',
      '    exit 1 if multi-active state detected.',
      '',
      '  create --repo-root <path> --verb <verb> --host <host>',
      '         --git-baseline-branch <name> --git-baseline-head <sha>',
      '         [--persona engineer] [--profile <name>] [--status-digest <hex>]',
      '         [--current-phase <label>] [--next-action <text>]',
      '         [--original-request <text>] [--body-title <text>]',
      '    Create a new workflow under the directory-level lock. Print the new',
      '    workflow path on stdout.',
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
      'Verbs: investigate, frame, decide, compose, critique, refine.',
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
        const path = await findActiveWorkflow(flags['repo-root']);
        if (path) process.stdout.write(`${path}\n`);
        return 0;
      }

      case 'create': {
        cliRequire(flags, ['repo-root', 'verb', 'host', 'git-baseline-branch', 'git-baseline-head']);
        const result = await createWorkflow({
          repoRoot: flags['repo-root'],
          verb: flags.verb,
          host: flags.host,
          persona: flags.persona ?? 'engineer',
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
        process.stdout.write(`${JSON.stringify(frontmatter, null, 2)}\n`);
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
