#!/usr/bin/env node
// scripts/state.mjs
//
// Host-shared canonical state I/O for a persona plugin per ADR-0011, one copy
// for every persona that enrolls it (generated from persona-pipeline/,
// ADR-0066; cross-plugin imports forbidden per ADR-0010 §5). The persona is
// read from its own persona.json when the code runs, never at import
// (scripts/lib/persona.mjs).
//
// Three capabilities change what it does (ADR-0066 Decision 3), each read
// from the declaration when it runs:
//   - legacy_homes: on, the ADR-0025 pre-migration `.claude/agentic-<persona>`
//     home is read and written beside the canonical one (dual-home reads, the
//     write block while both hold state). Off: canonical home only.
//   - dispatch_target: on, the ADR-0019 parent linkage (the create flags, the
//     parent_workflow / originating_subtask / parent_detached /
//     parent_writeback_at keys, ADR-0067's parent_workflow_path, the
//     detach-archive and set/clear-parent-writeback-marker subcommands) and
//     the ADR-0063
//     autopilot mode on Claude. Off: the keys stay opaque data the
//     forward-compat carrier keeps, the flags and subcommands are refused,
//     and an inherited AGENTIC_AUTOPILOT is ignored.
//   - commit_surface: on, the Phase 7 commit surface's state (close-complete,
//     beginCommit, the staging-set gate, autopilot-preflight --surface
//     commit). Off: the owner publishes.
//
// Used by:
//   - plugins/<persona>/commands/<verb>.md (thin-shim Phase 0 + state finalize)
//   - plugins/<persona>/adapters/{claude,codex}/hooks/* (snapshot writes)
//
// Storage location:
//   canonical: <repo_root>/.agentic-plugins/state/<persona>/workflows/<workflow_id>.md
//   legacy (legacy_homes on): <repo_root>/.claude/agentic-<persona>/workflows/<workflow_id>.md
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
import { join, dirname, basename, isAbsolute, resolve as resolvePath } from 'node:path';
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
import { isCliEntry } from './lib/cli-entry.mjs';
import { capabilityOn, commandPrefix, personaName, personaOrRefuse, stateDirRel } from './lib/persona.mjs';
import { fileURLToPath } from 'node:url';

// -----------------------------------------------------------------------------
// Constants — ADR-0011 §1, §2, §3 + ADR-0017 schema 1.1

// SCHEMA_VERSION names the version that `createWorkflow` emits today.
// The checkpoint meta surface (first sub-decision-2 frontmatter write)
// flipped emit to the string '1.1' per ADR-0017 §"Schema versioning policy";
// ADR-0028 §Layer-2 bumps the emit to '1.2' for the additive `commit_manifest`
// field. String form is required because the YAML parser (`parseScalar`) does
// not emit a JS Number for `1.1` / `1.2` — bare `1.2` round-trips through
// Number, which loses precision and changes type. ADR-0063 D6 / ADR-0066
// Decision 7 bump it to '1.4' for the flat `next_step_*` and
// `awaiting_owner_*` scalars (`finish-verb`, the owner gates); an older file
// keeps its schema through every writer.
export const SCHEMA_VERSION = '1.4';

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
export const SUPPORTED_SCHEMA_VERSIONS = new Set([1, '1.1', '1.2', '1.3', '1.4']);

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

// The persona's state home, derived from its declared name (ADR-0066 V1) and
// read when called, never at import: `.agentic-plugins/state/<persona>`.
export { stateDirRel };
export function workflowDirRel() {
  return `${stateDirRel()}/workflows`;
}
export function creationLockRel() {
  return `${stateDirRel()}/.creation-lock`;
}
// ADR-0017 §sub-decision 5 — auto-archive destination.
export function archiveDirRel() {
  return `${stateDirRel()}/archive`;
}
// legacy_homes (ADR-0025): the pre-migration `.claude/agentic-<persona>` home,
// read and written beside the canonical one only by a persona that declares
// the capability on.
export function legacyStateDirRel() {
  return `.claude/agentic-${personaName()}`;
}

// ADR-0017 §sub-decision 5 — terminal phase whitelist that gates Stop
// auto-archive. The whitelist is intentionally small + explicit so an
// intermediate phase write cannot trip auto-archive.
export const TERMINAL_PHASES = new Set([
  'commit-complete',
  'summary-complete',
  'fix-complete',
]);

// commit_surface (ADR-0063): `close-complete` records a workflow that the
// persona's /commit closed without a commit (the no-changes close), so the
// archived record stays distinct from `commit-complete`. That close archives
// the file itself: HEAD never moved, so the Stop hook's HEAD-moved gate would
// not. TERMINAL_PHASES is the set every persona shares; terminalPhases() is
// the persona's, read when it runs.
export function terminalPhases() {
  return capabilityOn('commit_surface') ? new Set([...TERMINAL_PHASES, 'close-complete']) : TERMINAL_PHASES;
}

// A capability's programmatic entry points refuse when it is off, as its CLI
// subcommands do (ADR-0066 Decision 3).
function requireCapability(capability, what) {
  if (!capabilityOn(capability)) {
    throw new Error(`${what} belongs to ${capability}, which ${personaName()} has off (ADR-0066 Decision 3)`);
  }
}

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
// the lifecycle macro shape (the persona's `start` macro).
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

// ADR-0063 D6 schema 1.4 — closed enums for the flat `next_step_*` and
// `awaiting_owner_*` scalars. `next_step_*` is the closed-enum durable
// projection of the end-of-verb Active Next-Action Proposal (`next_action`
// stays the free-text form for humans). The owner gates read here are the
// workflow-file subset of ADR-0063 D4, the same five engineer stores
// (`plan-approval` and `plan-conflict` live on the orchestrator macro, and
// `duplicate-workflow` has no single workflow file to live in). Which of them
// a persona can set depends on its capabilities (ADR-0066 Decision 3); a
// reader accepts all five, so a file is read the same by every persona.
export const VALID_NEXT_STEP_KINDS = new Set(['verb', 'commit', 'owner-decision', 'done']);
export const VALID_CONFIDENCE = new Set(['HIGH', 'MEDIUM', 'LOW']);
export const VALID_WORKFLOW_OWNER_GATES = new Set([
  'scope-routing',
  'decide-conflict',
  'recurring-finding',
  'staging-set',
  'pr-handling',
]);
// A pointer is a repo-relative `path#anchor`, never free text: this fixes the
// charset (no whitespace) and the shape. validateAwaitingOwnerPointer also
// refuses a leading `/` and any `..`.
const AWAITING_OWNER_POINTER_RE = /^[A-Za-z0-9._/-]+#[A-Za-z0-9._/-]+$/;

// ADR-0063 §0.2 env contract — AGENTIC_AUTOPILOT names an autopilot run only
// when it holds a well-formed run id, so an empty or accidental global export
// cannot flip a gate. Each plugin carries its own copy of this predicate (no
// cross-plugin import, ADR-0010 §5), held equal by
// tests/plugin-shape/test-autopilot-enum-parity.mjs. Here it only tells a
// command that the variable is ignored (autopilotMode).
export function isAutopilotRun(env = process.env) {
  return /^autopilot-\d{8}T\d{6}Z-[0-9a-f]{6}$/.test(env?.AGENTIC_AUTOPILOT ?? '');
}

/**
 * ADR-0066 Decision 3's activation rule: autopilot behavior only when
 * AGENTIC_AUTOPILOT names a run AND the persona has dispatch_target on AND the
 * host is Claude (autopilot is Claude-only, ADR-0063 D9). Otherwise a named
 * run is reported as ignored and every surface runs interactively: with
 * dispatch_target off the persona is no autopilot subject, and on Codex the
 * autopilot rules do not apply. The variable is still inherited by the
 * processes this one starts (the peer runner's companion, the handoff
 * sidecar); none of them acts on it.
 */
export function autopilotMode({ env = process.env, host = 'claude' } = {}) {
  const named = isAutopilotRun(env);
  if (named && capabilityOn('dispatch_target') && host === 'claude') {
    return { active: true, host, ignored: false, reason: null };
  }
  let why = null;
  if (named) {
    why = capabilityOn('dispatch_target')
      ? `autopilot mode is Claude-only (ADR-0063 D9), and this command runs on ${host}`
      : `${personaName()} is not an autopilot dispatch target (dispatch_target off, ADR-0066 Decision 3)`;
  }
  return {
    active: false,
    host,
    ignored: named,
    reason: named ? `AGENTIC_AUTOPILOT=${env.AGENTIC_AUTOPILOT} is ignored: ${why}; this command runs interactively.` : null,
  };
}

// The owner gates a persona can set (ADR-0066 Decision 3, PC2b DD2): the three
// whose resolving surface every persona has, and the two that belong to a
// capability — staging-set to commit_surface (the commit confirms the staging
// set), pr-handling to dispatch_target (an autopilot step stops before an
// outward action). A reader accepts all five; a setter accepts only these.
const CAPABILITY_OWNER_GATES = Object.freeze({
  'staging-set': 'commit_surface',
  'pr-handling': 'dispatch_target',
});

export function settableOwnerGates() {
  return new Set([...VALID_WORKFLOW_OWNER_GATES].filter(
    (gate) => !Object.hasOwn(CAPABILITY_OWNER_GATES, gate) || capabilityOn(CAPABILITY_OWNER_GATES[gate]),
  ));
}

// Every setter calls this, the programmatic path included (PC2b RV6).
function assertSettableOwnerGate(gate) {
  validateEnumScalar('awaiting_owner_gate', gate, VALID_WORKFLOW_OWNER_GATES);
  if (!settableOwnerGates().has(gate)) {
    throw new Error(
      `${personaName()} cannot set the owner gate ${gate}: it belongs to ${CAPABILITY_OWNER_GATES[gate]}, ` +
        `which ${personaName()} has off (ADR-0066 Decision 3)`,
    );
  }
}

// -----------------------------------------------------------------------------
// Path helpers

// The state homes: the canonical one, and with legacy_homes on the ADR-0025
// pre-migration home beside it.
function stateHomes() {
  const homes = {
    canonical: {
      home: 'canonical',
      stateDirRel: stateDirRel(),
      workflowDirRel: workflowDirRel(),
      archiveDirRel: archiveDirRel(),
      creationLockRel: creationLockRel(),
      peerRunsDirRel: `${stateDirRel()}/peer-runs`,
    },
  };
  if (capabilityOn('legacy_homes')) {
    const legacy = legacyStateDirRel();
    homes.legacy = {
      home: 'legacy',
      stateDirRel: legacy,
      workflowDirRel: `${legacy}/workflows`,
      archiveDirRel: `${legacy}/archive`,
      creationLockRel: `${legacy}/.creation-lock`,
      peerRunsDirRel: `${legacy}/peer-runs`,
    };
  }
  return homes;
}

function assertAbsoluteRepoRoot(repoRoot, fnName = 'repoRoot') {
  if (!isAbsolute(repoRoot)) {
    throw new Error(`${fnName} must be absolute: ${repoRoot}`);
  }
}

function statePaths(repoRoot, home = 'canonical') {
  assertAbsoluteRepoRoot(repoRoot);
  const homes = stateHomes();
  const spec = Object.hasOwn(homes, home) ? homes[home] : undefined;
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

// With legacy_homes off, `mode` has no effect: with a single canonical home
// there is no dual-home write conflict to block. With it on (ADR-0025), the
// home that holds state is used (canonical first), and a write is refused
// while both hold state.
export async function resolveWorkflowStorage(repoRoot, { mode = 'read' } = {}) {
  assertAbsoluteRepoRoot(repoRoot);
  const canonicalHasState = await stateHomeHasState(repoRoot, 'canonical');
  if (!capabilityOn('legacy_homes')) {
    return {
      ...statePaths(repoRoot, 'canonical'),
      canonicalHasState,
    };
  }
  const legacyHasState = await stateHomeHasState(repoRoot, 'legacy');
  if (mode === 'write' && canonicalHasState && legacyHasState) {
    throw new Error(
      `Workflow storage migration blocked: both ${stateDirRel()} and ` +
        `${legacyStateDirRel()} contain ${personaName()} state. Migrate or reconcile ` +
        `the legacy home before ordinary workflow writes.`,
    );
  }
  const home = canonicalHasState ? 'canonical' : (legacyHasState ? 'legacy' : 'canonical');
  return {
    ...statePaths(repoRoot, home),
    canonicalHasState,
    legacyHasState,
  };
}

function inferStorageFromWorkflowPath(workflowPath) {
  const text = String(workflowPath);
  const canonicalNeedle = `/${stateDirRel()}/`;
  const canonicalIndex = text.indexOf(canonicalNeedle);
  if (canonicalIndex >= 0) {
    return { home: 'canonical', repoRoot: text.slice(0, canonicalIndex) };
  }
  if (capabilityOn('legacy_homes')) {
    const legacyIndex = text.indexOf(`/${legacyStateDirRel()}/`);
    if (legacyIndex >= 0) {
      return { home: 'legacy', repoRoot: text.slice(0, legacyIndex) };
    }
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
 * deletion must be visible regardless of the current branch. With
 * legacy_homes off only the canonical home exists, so this walks a
 * single directory; the AllHomes name is kept for sibling API parity.
 * ENOENT is a clean skip.
 */
export async function listWorkflowFilesAllHomes(repoRoot) {
  const dirs = [
    workflowDir(repoRoot, { home: 'canonical' }),
    ...(capabilityOn('legacy_homes') ? [workflowDir(repoRoot, { home: 'legacy' })] : []),
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
 * The orphan sweep archives a terminal workflow on an `'absent'` branch (the
 * branch was deleted, so there is no tip to judge), and judges one on a
 * `'present'` branch that is not checked out against that branch's tip
 * (`branchTip`). A probe failure (`'unknown'`) is treated conservatively —
 * leave the workflow — so a transient git error can never falsely archive a
 * workflow whose branch may still exist.
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
 * Resolve a local branch's tip commit and its subject, or `null` when the ref
 * does not name a readable commit.
 *
 * The orphan sweep judges a terminal workflow on a branch that is not checked
 * out against this tip, never against HEAD (which belongs to another branch).
 * Call it only after `branchRefState` returned `'present'`; `null` here is the
 * conservative "leave it" answer, not "deleted".
 */
export function branchTip(repoRoot, branch) {
  if (typeof branch !== 'string' || branch.length === 0) return null;
  try {
    const sha = String(execFileSync(
      'git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] },
    )).trim();
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) return null;
    const subject = String(execFileSync(
      'git', ['log', '-1', '--format=%s', sha],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] },
    )).replace(/\n$/, '');
    return { sha, subject };
  } catch {
    return null;
  }
}

/**
 * The checkout as the orphan sweep needs it: `{ state: 'branch', branch }`,
 * `{ state: 'detached' }` (confirmed: HEAD names no branch), or
 * `{ state: 'unknown' }` when git cannot say. `currentGitBranch` folds the last
 * two into `''`; the sweep must not, because without the checkout it cannot
 * tell which workflow the per-branch Stop path owns.
 *
 * `git symbolic-ref --quiet HEAD` exits 0 with `refs/heads/<branch>` (also on
 * an unborn branch), 1 when HEAD is detached, and 128 on failure.
 */
export function checkedOutBranch(repoRoot) {
  try {
    const ref = String(execFileSync('git', ['symbolic-ref', '--quiet', 'HEAD'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })).replace(/\n$/, '');
    return ref.startsWith('refs/heads/')
      ? { state: 'branch', branch: ref.slice('refs/heads/'.length) }
      : { state: 'unknown' };
  } catch (err) {
    return err && err.status === 1 ? { state: 'detached' } : { state: 'unknown' };
  }
}

/**
 * `true` only when `tip` is a strict descendant of `baseline` — the branch
 * moved forward from where the workflow started. A branch reset below its
 * baseline, or rebased onto unrelated history, also differs from the baseline
 * but carries no evidence of the workflow's work, so it is `false`; so is any
 * probe failure.
 */
export function descendsFrom(repoRoot, baseline, tip) {
  if (typeof baseline !== 'string' || typeof tip !== 'string') return false;
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(baseline) || baseline === tip) return false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', baseline, tip], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
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
  // With legacy_homes off, the canonical home only; no legacy probe, no
  // dual-home ambiguity error.
  const canonical = await findActiveWorkflowByBranchInDir(
    workflowDir(repoRoot, { home: 'canonical' }),
    branch,
  );
  if (!capabilityOn('legacy_homes')) return canonical;
  const legacy = await findActiveWorkflowByBranchInDir(
    workflowDir(repoRoot, { home: 'legacy' }),
    branch,
  );
  if (canonical && legacy) {
    throw new Error(
      `Ambiguous ${personaName()} workflow storage: both ${workflowDirRel()} and ` +
        `${legacyStateDirRel()}/workflows contain an active workflow on branch ` +
        `${JSON.stringify(branch)}. Reconcile or migrate before continuing.`,
    );
  }
  return canonical ?? legacy;
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
  // The ADR-0019 cross-plugin parent-linkage keys (parent_workflow /
  // originating_subtask / parent_detached) belong to dispatch_target and sit
  // here only when it is on (frontmatterKeyOrder below). With it off, a file
  // carrying them is an unknown-additive-key case for the forward-compat
  // carrier (ADR-0066 Decision 3).
  // ADR-0020 schema 1.1 workflow-shape discriminator (PR 2, additive).
  // Always-written at create-time with 'verb-chain' default; lifecycle
  // macro workflows (the persona's `start` macro) write 'start'.
  'workflow_type',
  // ADR-0028 §Layer-2 schema 1.2 commit_manifest (additive optional).
  // Written by recordComposedFile / recordRefineFile; consumed by
  // Phase 7 staging (Layer 3) to intersect against `git_changes`.
  'commit_manifest',
  // ADR-0028 §P10 parent_writeback_at (dispatch_target) sits here only when
  // the capability is on (frontmatterKeyOrder below).
  // ADR-0063 D6 schema 1.4 (additive optional, ADR-0066 Decision 7). Flat
  // top-level scalars, not a nested block, so that a 1.3 reader carries them
  // through its forward-compat carrier instead of rejecting the file. An
  // absent key means null. They stay at the tail so that carrier re-emits
  // them in place, byte for byte.
  'next_step_kind',
  'next_step_verb',
  'next_step_confidence',
  'awaiting_owner_gate',
  'awaiting_owner_since',
  'awaiting_owner_pointer',
];

// dispatch_target's frontmatter keys (ADR-0019 PR-A, ADR-0028 §P10, ADR-0067
// Decision 3): known, ordered and validated only for a persona that declares
// the capability on. parent_workflow + originating_subtask, and
// parent_workflow_path when recorded, are immutable once set at create-time
// (ADR-0019 §3); parent_detached is set by the orchestrator's /finalize·/abort
// detach pass (§5); parent_writeback_at is the P10 write-ahead marker.
const PARENT_LINKAGE_KEYS = Object.freeze(['parent_workflow', 'originating_subtask', 'parent_detached']);
let keyOrderCache = null;
function frontmatterKeyOrder() {
  if (keyOrderCache !== null) return keyOrderCache;
  const order = [...FRONTMATTER_KEY_ORDER];
  if (capabilityOn('dispatch_target')) {
    order.splice(order.indexOf('workflow_type'), 0, ...PARENT_LINKAGE_KEYS);
    order.splice(order.indexOf('next_step_kind'), 0, 'parent_writeback_at');
    // ADR-0067 Decision 3 — the macro file's path, an optional flat scalar
    // that needs no schema version. It is last, where a reader that does not
    // know it writes it back through its forward-compat carrier (after every
    // key it knows), so that reader's write leaves it byte for byte (the
    // ADR-0063 S1 note).
    order.push('parent_workflow_path');
  }
  keyOrderCache = Object.freeze(order);
  return keyOrderCache;
}

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

  for (const key of frontmatterKeyOrder()) {
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
    if (!frontmatterKeyOrder().includes(key)) {
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
    if (!frontmatterKeyOrder().includes(key)) {
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
    if (!frontmatterKeyOrder().includes(key)) {
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
  // dispatch_target's keys are schema keys only with the capability on
  // (frontmatterKeyOrder); with it off they fall through to the
  // forward-compat unknown-key carrier and are not validated here
  // (ADR-0066 Decision 3).
  if (capabilityOn('dispatch_target')) {
    // ADR-0028 §P10 schema 1.3 — parent_writeback_at write-ahead marker.
    // Optional scalar; non-empty string when present.
    if ('parent_writeback_at' in fm) {
      if (typeof fm.parent_writeback_at !== 'string' || fm.parent_writeback_at.length === 0) {
        throw new Error('parent_writeback_at must be a non-empty string when present');
      }
    }
    // ADR-0019 PR-A — the three cross-plugin parent-linkage scalars.
    if ('parent_workflow' in fm) {
      if (typeof fm.parent_workflow !== 'string' || fm.parent_workflow.length === 0) {
        throw new Error('parent_workflow must be a non-empty string');
      }
    }
    if ('originating_subtask' in fm) {
      if (typeof fm.originating_subtask !== 'string' || fm.originating_subtask.length === 0) {
        throw new Error('originating_subtask must be a non-empty string');
      }
    }
    if ('parent_detached' in fm) {
      if (typeof fm.parent_detached !== 'boolean') {
        throw new Error('parent_detached must be a boolean');
      }
    }
    // ADR-0067 Decision 3 — a hint checked where it is used (create and the
    // writeback); the file it names may have moved since, so a read checks
    // only its type.
    if ('parent_workflow_path' in fm) {
      if (typeof fm.parent_workflow_path !== 'string' || fm.parent_workflow_path.length === 0) {
        throw new Error('parent_workflow_path must be a non-empty string when present');
      }
    }
  }

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

  validateSchema14Fields(fm);
}

/**
 * ADR-0063 D6 schema 1.4 — the flat `next_step_*` and `awaiting_owner_*`
 * scalars. Validation is per key (ADR-0066 Decision 7), so a file on an older
 * disk schema may carry them (mutation helpers never promote the schema).
 * Beyond each value's enum or format, the keys hold together:
 * - `next_step_kind` and `next_step_confidence` appear together or not at all;
 * - `next_step_verb` appears iff `next_step_kind` is `verb`;
 * - the three `awaiting_owner_*` keys appear all or none.
 */
function validateSchema14Fields(fm) {
  if ('next_step_kind' in fm) {
    validateEnumScalar('next_step_kind', fm.next_step_kind, VALID_NEXT_STEP_KINDS);
  }
  if ('next_step_confidence' in fm) {
    validateEnumScalar('next_step_confidence', fm.next_step_confidence, VALID_CONFIDENCE);
  }
  if ('next_step_verb' in fm) {
    validateEnumScalar('next_step_verb', fm.next_step_verb, VALID_VERBS);
  }
  if (('next_step_kind' in fm) !== ('next_step_confidence' in fm)) {
    throw new Error(
      'next_step_kind and next_step_confidence must be present together or both absent (ADR-0063 D6)',
    );
  }
  if (('next_step_verb' in fm) !== (fm.next_step_kind === 'verb')) {
    throw new Error(
      'next_step_verb must be present exactly when next_step_kind is verb ' +
        `(got next_step_kind=${JSON.stringify(fm.next_step_kind ?? null)}, ` +
        `next_step_verb=${JSON.stringify(fm.next_step_verb ?? null)}) (ADR-0063 D6)`,
    );
  }

  const awaiting = ['awaiting_owner_gate', 'awaiting_owner_since', 'awaiting_owner_pointer'];
  const present = awaiting.filter((k) => k in fm);
  if (present.length > 0 && present.length < awaiting.length) {
    throw new Error(
      `awaiting_owner_gate, awaiting_owner_since and awaiting_owner_pointer must be present all or none (got ${present.join(', ')}) (ADR-0063 D6)`,
    );
  }
  if (present.length === awaiting.length) {
    validateEnumScalar('awaiting_owner_gate', fm.awaiting_owner_gate, VALID_WORKFLOW_OWNER_GATES);
    validateIsoUtc('awaiting_owner_since', fm.awaiting_owner_since);
    validateAwaitingOwnerPointer(fm.awaiting_owner_pointer);
  }
}

function validateEnumScalar(key, value, allowed) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(
      `${key} must be one of ${[...allowed].join(', ')} (got ${JSON.stringify(value)})`,
    );
  }
}

// The canonical form `isoUtc` writes: whole seconds, `Z`. The round trip
// rejects a well-shaped but impossible date, which Date.parse would otherwise
// roll forward (2026-02-30 → 2026-03-02).
function validateIsoUtc(key, value) {
  const ok =
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    isoUtc(Date.parse(value)) === value;
  if (!ok) {
    throw new Error(
      `${key} must be an ISO-8601 UTC timestamp of the form YYYY-MM-DDTHH:MM:SSZ (got ${JSON.stringify(value)})`,
    );
  }
}

function validateAwaitingOwnerPointer(value) {
  const ok =
    typeof value === 'string' &&
    AWAITING_OWNER_POINTER_RE.test(value) &&
    !value.startsWith('/') &&
    !value.includes('..');
  if (!ok) {
    throw new Error(
      'awaiting_owner_pointer must be a repo-relative path#anchor using only ' +
        `[A-Za-z0-9._/#-], not absolute and without '..' (got ${JSON.stringify(value)})`,
    );
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
  persona = personaName(),
  profile = '',
  originalRequest,
  gitBaseline,
  host,
  currentPhase = 'phase-0',
  nextAction = '',
  bodyTitle,
  // ADR-0019 PR-A — optional parent-linkage at create-time, dispatch_target
  // only (ADR-0066 Decision 3; refused when it is off). Both fields are
  // immutable thereafter (§3). /orchestrator:next sets them through the verb
  // command's Phase 0 (AGENTIC_PARENT_WORKFLOW / AGENTIC_ORIGINATING_SUBTASK,
  // forwarded as CLI flags).
  parentWorkflow,
  originatingSubtask,
  // ADR-0067 Decision 3 — the macro file's absolute path, recorded beside
  // the two ids (AGENTIC_PARENT_WORKFLOW_PATH, forwarded as a CLI flag).
  // Optional: an older orchestrator exports none. Valid only with both ids.
  parentWorkflowPath,
  // ADR-0020 PR 2 — workflow-shape discriminator. Always-written at
  // create-time (default 'verb-chain') so every new workflow is
  // self-describing. workflow_type is a primary discriminator, not a
  // presence flag; the persona's `start` macro passes 'start'.
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
        `Resume with ${commandPrefix()}resume on this branch, or archive the existing workflow first.`,
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
    // verb commands; the persona's `start` macro overrides with 'start'.
    workflow_type: workflowType,
  };

  // ADR-0019 PR-A — write parent-linkage fields when supplied. Validate
  // shape eagerly so callers get a clear error before the file lands.
  // Only `undefined` / `null` mean omitted; an empty string is
  // explicitly-provided-but-invalid (a CLI shim that expands an unset env var
  // to `--flag ''` would otherwise silently drop the parent association).
  // With dispatch_target off the options are dropped here, as the trimmed
  // copy dropped them; its CLI refuses the flags loudly (ADR-0066 Decision 3).
  if (!capabilityOn('dispatch_target')) {
    parentWorkflow = undefined;
    originatingSubtask = undefined;
    parentWorkflowPath = undefined;
  }
  if (parentWorkflow !== undefined && parentWorkflow !== null) {
    if (typeof parentWorkflow !== 'string' || parentWorkflow.length === 0) {
      throw new Error('parentWorkflow must be a non-empty string when provided');
    }
    frontmatter.parent_workflow = parentWorkflow;
  }
  if (originatingSubtask !== undefined && originatingSubtask !== null) {
    if (typeof originatingSubtask !== 'string' || originatingSubtask.length === 0) {
      throw new Error('originatingSubtask must be a non-empty string when provided');
    }
    frontmatter.originating_subtask = originatingSubtask;
  }
  // Both set together or both omitted: a parent without a subtask cannot
  // anchor the writeback (ADR-0019 §4).
  if (('parent_workflow' in frontmatter) !== ('originating_subtask' in frontmatter)) {
    throw new Error(
      'parent_workflow and originating_subtask must be set together or both omitted (ADR-0019 §3 parent-child linkage)',
    );
  }
  // ADR-0067 Decision 3 — the path names the macro the ids name: an existing
  // orchestrator macro file, in a workflows/ home, whose workflow_id is
  // parent_workflow. The path alone is refused; the ids alone stay valid
  // (an older orchestrator).
  if (parentWorkflowPath !== undefined && parentWorkflowPath !== null) {
    if (typeof parentWorkflowPath !== 'string' || parentWorkflowPath.length === 0) {
      throw new Error('parentWorkflowPath must be a non-empty string when provided');
    }
    if (!('parent_workflow' in frontmatter)) {
      throw new Error(
        'parent_workflow_path is valid only with parent_workflow and originating_subtask (ADR-0067 Decision 3)',
      );
    }
    const { checkParentWorkflowPath } = await import('./parent-writeback.mjs');
    const problem = await checkParentWorkflowPath(parentWorkflowPath, frontmatter.parent_workflow);
    if (problem) {
      throw new Error(
        `parent_workflow_path ${JSON.stringify(parentWorkflowPath)} is not macro ` +
          `${frontmatter.parent_workflow}'s file: ${problem} (ADR-0067 Decision 3)`,
      );
    }
    frontmatter.parent_workflow_path = parentWorkflowPath;
  }

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
// ADR-0063 D6 — next_step write support
//
// A write replaces all three `next_step_*` keys at once, so a stale
// `next_step_verb` never outlives a change of kind. The input is checked with
// the same validator the parser runs, before the file lock is taken.

const NEXT_STEP_KEYS = ['next_step_kind', 'next_step_verb', 'next_step_confidence'];

function normalizeNextStep(nextStep) {
  if (typeof nextStep !== 'object' || nextStep === null || Array.isArray(nextStep)) {
    throw new Error('nextStep must be an object { kind, verb?, confidence }');
  }
  // null is the logical shape's "no value" (a non-verb kind has verb null),
  // and on disk that is an absent key.
  const fields = {};
  if (nextStep.kind != null) fields.next_step_kind = nextStep.kind;
  if (nextStep.verb != null) fields.next_step_verb = nextStep.verb;
  if (nextStep.confidence != null) fields.next_step_confidence = nextStep.confidence;
  if (!('next_step_kind' in fields)) {
    throw new Error('next step kind is required when writing a next step (ADR-0063 D6)');
  }
  validateSchema14Fields(fields);
  return fields;
}

// Resolve the `nextStep` / `clearNextStep` pair a mutation helper received
// into the key set to write: `null` leaves next_step untouched, `{}` clears
// it, otherwise the replacement keys.
function resolveNextStepWrite(nextStep, clearNextStep) {
  if (typeof clearNextStep !== 'boolean') {
    throw new Error(
      `clearNextStep must be a boolean (got ${typeof clearNextStep} ${JSON.stringify(clearNextStep)})`,
    );
  }
  if (clearNextStep && nextStep !== undefined) {
    throw new Error('clearing the next step and writing one are mutually exclusive');
  }
  if (clearNextStep) return {};
  if (nextStep === undefined) return null;
  return normalizeNextStep(nextStep);
}

function applyNextStepWrite(frontmatter, write) {
  if (write === null) return;
  for (const k of NEXT_STEP_KEYS) delete frontmatter[k];
  Object.assign(frontmatter, write);
  validateSchema14Fields(frontmatter);
}

// A phase note must start on its own line. A body parsed from a hand-edited
// file can end without a newline; every body this script writes ends with one,
// so for those this adds nothing.
function appendToBody(body, text) {
  const sep = body.length === 0 || body.endsWith('\n') ? '' : '\n';
  return `${body}${sep}${text}`;
}

// -----------------------------------------------------------------------------
// Public API: appendPhase
//
// Append a new phase note to an existing workflow's body. Updates
// frontmatter `verb`, `current_phase`, `next_action`, `updated_at`,
// optionally `profile` and the ADR-0063 `next_step_*` keys, and appends a
// `host_history` entry.

export async function appendPhase({
  workflowPath,
  host,
  verb,
  profile,
  phaseLabel,
  phaseNote,
  currentPhase,
  nextAction,
  // ADR-0063 D6 — `{ kind, verb?, confidence }` replaces all three
  // next_step_* keys; `clearNextStep: true` deletes them (Phase 0
  // append-on-resume, so a verb that dies after Phase 0 leaves no stale
  // next step behind). Omitting both leaves next_step as it is.
  nextStep,
  clearNextStep = false,
  // ADR-0063 — `{ gate, pointer? | anchor? }` records an owner gate in the
  // same write, so a step that stops for the owner never leaves its note,
  // next step and gate half-written. The different-gate refusal of
  // setAwaitingOwner and the capability filter (settableOwnerGates) apply.
  ownerGate,
  // `true` turns an inherited terminal marker off: the workflow is not
  // complete (it waits on its owner, or a lifecycle continues it).
  clearTerminalMarker = false,
  event = 'resumed',
  now = new Date(),
}) {
  validateHost(host);
  validateHookEvent(event);
  if (verb !== undefined) validateVerb(verb);
  if (typeof clearTerminalMarker !== 'boolean') {
    throw new Error(`clearTerminalMarker must be a boolean (got ${typeof clearTerminalMarker})`);
  }
  const nextStepWrite = resolveNextStepWrite(nextStep, clearNextStep);
  const gateFields = ownerGate === undefined ? null : resolveOwnerGateFields({ workflowPath, ownerGate, now });

  return withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    const nowIso = isoUtc(now);

    if (verb !== undefined) frontmatter.verb = verb;
    if (profile !== undefined) frontmatter.profile = profile;
    if (currentPhase !== undefined) frontmatter.current_phase = currentPhase;
    if (nextAction !== undefined) frontmatter.next_action = nextAction;
    applyNextStepWrite(frontmatter, nextStepWrite);
    if (gateFields) applyOwnerGate(frontmatter, gateFields);
    if (clearTerminalMarker && frontmatter.terminal_marker === true) frontmatter.terminal_marker = false;
    frontmatter.updated_at = nowIso;
    frontmatter.host_history = [
      ...(frontmatter.host_history ?? []),
      { host, at: nowIso, event },
    ];

    const heading = phaseLabel ? `### ${phaseLabel}\n\n` : '';
    const note = phaseNote ? `${phaseNote}\n\n` : '';
    const newBody = appendToBody(body, `${heading}${note}`);

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
    // `kept`: the entry already recorded for this run id, read under the lock.
    const kept = alreadyCommitted ? existing.find((e) => e.run_id === run_id) : null;
    return { frontmatter, workflowPath, idempotentSkip: alreadyCommitted, kept };
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
// (a Phase 7 commit driver; commit_surface is off here). Until one lands,
// `frontmatter.commit_manifest` will be empty on every workflow, and
// Phase 7 Layer 3's `manifest_paths = []` branch will trigger the
// "ASK the user to approve all of git_changes" fallback path. This split
// is intentional per ADR-0028 §Layer-3 PR sequencing: Layer 2 helpers
// land first so the schema migration is non-breaking; Layer 3 ships the
// staging logic and the command-side Write/Edit hooks atomically together.
//
// Command-mode boundary (per `core/skills/compose/SKILL.md` line 148 +
// `core/skills/refine/SKILL.md` line 156): the workflow file is mutated only
// when the verb skill is invoked as a sub-step of a persona workflow
// command. The helpers respect that boundary by no-op'ing when
// `workflowPath` is falsy — the CLI shim passes `--workflow-path "$ACTIVE"`
// verbatim, and `$ACTIVE` is empty when no workflow of this persona is on the
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
// `scripts/validate-commit.mjs` so the WRITE boundary
// here and the Layer 3 READ-side gate in `phase7-commit.mjs` share a
// single source of truth (PR1 N1 deferral closure, ADR-0028 §Layer-3).
//
// READ-side defense — Layer 3 re-validation contract: the parser
// (`parseWorkflowFile` + `validateListOfObjectsField`) does NOT re-run
// the four pathspec checks on entries READ BACK from disk. A workflow
// file that is hand-edited or originated outside the helper code path
// can therefore carry a malicious `path` value. Layer 3's Phase 7
// staging code (a Phase 7 commit driver, when one exists) MUST
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

// The ADR-0028 §P10 setParentWritebackMarker / clearParentWritebackMarker
// pair belongs to dispatch_target; it sits with the other capability-only
// writers before archiveWorkflow.

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
  // ADR-0063 D6 — `{ kind, verb?, confidence }` replaces all three
  // next_step_* keys with the terminal write; omitted leaves them as they are.
  nextStep,
  event = 'updated',
  now = new Date(),
  // ADR-0031 amendment (decision 1) / ADR-0043 — fire the session-handoff
  // sidecar from this must-run completion mutation. Opt-in by the production
  // completion entry point (the CLI `set-terminal` case), so direct helper
  // calls (tests, internal state setup) never emit. Default off keeps the
  // low-level helper side-effect-free for non-completion callers.
  emitHandoff = false,
}) {
  validateHost(host);
  validateHookEvent(event);
  if (!terminalPhases().has(terminalPhase)) {
    const allowed = [...terminalPhases()].join(', ');
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
  const nextStepWrite = resolveNextStepWrite(nextStep, false);
  const result = await withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    const nowIso = isoUtc(now);
    frontmatter.current_phase = terminalPhase;
    if (nextAction !== undefined) frontmatter.next_action = nextAction;
    applyNextStepWrite(frontmatter, nextStepWrite);
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
  // ADR-0031 amendment (decisions 1, 2, 3, 6) / ADR-0043 §2 — fire the
  // activation sidecar AFTER the terminal mutation succeeded AND the file lock
  // was released (the `withFileLock` above has resolved). Fail-closed +
  // non-fatal: any error is swallowed here so a completion can never fail
  // because of the handoff, and the sidecar itself writes only stderr + a
  // projection file, never stdout. Gated on `terminalMarker === true`
  // (orchestrator parity, Codex Plan-verify): un-marking a workflow
  // (`--terminal-marker false`) is not a terminal transition and must not
  // emit a terminal handoff.
  if (emitHandoff && terminalMarker === true) {
    try {
      // Resolve a relative --workflow-path before home inference — the
      // canonical-needle match requires an absolute spelling, and a relative
      // path would otherwise mutate successfully but silently skip the
      // sidecar (Codex Plan-verify edge case).
      const absWorkflowPath = isAbsolute(workflowPath) ? workflowPath : resolvePath(workflowPath);
      const inferred = inferStorageFromWorkflowPath(absWorkflowPath);
      if (inferred) {
        const { repoRoot, home } = inferred;
        const projectionFile = join(statePaths(repoRoot, home).root, 'last-session-handoff.json');
        // Lazy dynamic import inside this async fn — a static
        // `state.mjs -> session-handoff.mjs` import would cycle
        // (session-handoff -> state + stop-archive -> state). Top-level await
        // of a back-importing module can deadlock settlement, so the import
        // stays here, never at module top level (mirrors the stop-archive
        // dynamic-import precedent).
        const { emitTerminalHandoffSidecar } = await import('./session-handoff.mjs');
        // Project the EXACT workflow just terminalized (by path), not whatever
        // is active on the current checkout branch — set-terminal can be
        // invoked cross-branch on an explicit workflowPath (ADR-0043 §2
        // path-targeted baseline).
        await emitTerminalHandoffSidecar({
          repoRoot,
          workflowPath: absWorkflowPath,
          projectionFile,
          // ADR-0039 — thread host so the code-synthesized footer localizes its
          // commands (claude|codex); this call site already carries it.
          host,
          // This is the must-run completion mutation — a NEW terminal
          // transition. `primary` lets a re-terminalized workflow re-render
          // over its own prior 'rendered' tombstone (see claimFooterRender).
          origin: 'primary',
        });
      }
    } catch {
      // non-fatal: the terminal write already landed; the sidecar must never
      // break a completion (ADR-0031 amendment decision 6).
    }
  }
  return result;
}

const AWAITING_OWNER_KEYS = ['awaiting_owner_gate', 'awaiting_owner_since', 'awaiting_owner_pointer'];

// ADR-0063 — the pointer of an owner gate a runbook sets names a section of
// the workflow file itself, so the script derives it from the file's path
// rather than having the runbook spell a repo-relative path. The result is
// checked by the same validator as a pointer given outright.
function resolveAwaitingOwnerPointer({ workflowPath, pointer, anchor }) {
  if (anchor === undefined) return pointer;
  if (pointer !== undefined) {
    throw new Error('pass either a pointer or an anchor, not both');
  }
  const absolute = resolvePath(String(workflowPath));
  const inferred = inferStorageFromWorkflowPath(absolute);
  if (!inferred || inferred.repoRoot.length === 0) {
    throw new Error(
      `cannot derive a pointer: ${JSON.stringify(workflowPath)} is not under the ${personaName()} state home; pass --pointer instead`,
    );
  }
  return `${absolute.slice(inferred.repoRoot.length + 1)}#${anchor}`;
}

// The three awaiting_owner_* keys for a gate, checked before any lock is
// taken: a gate this persona cannot set is refused here (PC2b DD2).
function resolveOwnerGateFields({ workflowPath, ownerGate, now }) {
  if (typeof ownerGate !== 'object' || ownerGate === null || Array.isArray(ownerGate)) {
    throw new Error('ownerGate must be an object { gate, pointer | anchor, since? }');
  }
  assertSettableOwnerGate(ownerGate.gate);
  const fields = {
    awaiting_owner_gate: ownerGate.gate,
    awaiting_owner_since: ownerGate.since ?? isoUtc(now),
    awaiting_owner_pointer: resolveAwaitingOwnerPointer({
      workflowPath, pointer: ownerGate.pointer, anchor: ownerGate.anchor,
    }),
  };
  validateSchema14Fields(fields);
  return fields;
}

// Under the file lock: one gate at a time. Setting the gate that is already
// set replaces its pointer and since; a different gate is refused. A
// workflow waiting on its owner is not complete, so an inherited terminal
// marker is turned off in the same write: otherwise the Stop hook could
// archive it once HEAD moved, burying the gate (gate 5 refuses that too).
function applyOwnerGate(frontmatter, fields) {
  const current = frontmatter.awaiting_owner_gate;
  if (current !== undefined && current !== fields.awaiting_owner_gate) {
    throw new Error(
      `owner gate ${current} is already set on this workflow; it must be cleared before ${fields.awaiting_owner_gate} can be set`,
    );
  }
  Object.assign(frontmatter, fields);
  if (frontmatter.terminal_marker === true) frontmatter.terminal_marker = false;
  validateSchema14Fields(frontmatter);
}

/**
 * ADR-0063 D6 — record that this workflow waits on an owner judgment. The
 * surface that pauses sets the gate. Only one gate is modelled at a time:
 * setting a gate while a different one is set is refused; setting the gate
 * that is already set replaces its pointer and since. Only the gates this
 * persona can set are accepted (settableOwnerGates).
 */
export async function setAwaitingOwner({
  workflowPath,
  host,
  gate,
  pointer,
  // `anchor` (exclusive with `pointer`) derives the pointer from the
  // workflow's own path: `<path relative to its repo root>#<anchor>`.
  anchor,
  since,
  now = new Date(),
}) {
  validateHost(host);
  const fields = resolveOwnerGateFields({ workflowPath, ownerGate: { gate, pointer, anchor, since }, now });
  return withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    const nowIso = isoUtc(now);
    applyOwnerGate(frontmatter, fields);
    frontmatter.updated_at = nowIso;
    frontmatter.host_history = [
      ...(frontmatter.host_history ?? []),
      { host, at: nowIso, event: 'updated' },
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
 * ADR-0063 D6 / Q2 — the resolving surface clears the owner gate once the
 * owner has decided. The gate named must be the one that is set. The keys are
 * deleted, so the phase note appended here is where the resolution, and the
 * pointer and since that were cleared, remain on record. Under autopilot
 * (autopilotMode active) it refuses: only the owner resolves an owner gate.
 */
export async function clearAwaitingOwner({
  workflowPath,
  host,
  gate,
  // The next step the owner chose, written with the clear, so the
  // `owner-decision` next step the gate left behind does not linger.
  nextStep,
  // Or no next step at all: inside a /start lifecycle the lifecycle owns its
  // phase order, and its resume clears a recorded next step anyway.
  clearNextStep = false,
  // The next action that replaces the gate's "Owner: …" one, in the same
  // write, so a block that stops after the clear leaves no stale instruction.
  nextAction,
  // The owner's decision in words (the direction chosen, a deferral and its
  // reason). It lands in the resolved note of the same write.
  resolution,
  env = process.env,
  now = new Date(),
}) {
  validateHost(host);
  const nextStepWrite = resolveNextStepWrite(nextStep, clearNextStep);
  if (resolution !== undefined && (typeof resolution !== 'string' || resolution.trim().length === 0)) {
    throw new Error('resolution must be non-empty text when given');
  }
  if (autopilotMode({ env, host }).active) {
    throw new Error(
      `refused under autopilot (AGENTIC_AUTOPILOT=${env.AGENTIC_AUTOPILOT}): only the owner resolves an owner gate (ADR-0063 Q2)`,
    );
  }
  validateEnumScalar('awaiting_owner_gate', gate, VALID_WORKFLOW_OWNER_GATES);
  return withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    const current = frontmatter.awaiting_owner_gate;
    if (current === undefined) {
      throw new Error(`no owner gate is set on this workflow (asked to clear ${gate})`);
    }
    if (current !== gate) {
      throw new Error(`the owner gate set on this workflow is ${current}, not ${gate}`);
    }
    const nowIso = isoUtc(now);
    const note =
      `### Owner gate resolved: ${gate} at ${nowIso}\n\n` +
      (resolution !== undefined ? `${resolution.trim()}\n\n` : '') +
      `Cleared awaiting_owner (since ${frontmatter.awaiting_owner_since}, ` +
      `pointer ${frontmatter.awaiting_owner_pointer}).\n\n`;
    for (const k of AWAITING_OWNER_KEYS) delete frontmatter[k];
    applyNextStepWrite(frontmatter, nextStepWrite);
    if (nextAction !== undefined) frontmatter.next_action = nextAction;
    frontmatter.updated_at = nowIso;
    frontmatter.host_history = [
      ...(frontmatter.host_history ?? []),
      { host, at: nowIso, event: 'updated' },
    ];
    await atomicWrite(
      workflowPath,
      assembleWorkflowFile(frontmatter, appendToBody(body, note)),
      { lockPath, token },
    );
    return { frontmatter, workflowPath };
  });
}

// How each gate this persona can set is resolved, named with the host's
// command sigil. The resolving surface clears the gate.
const OWNER_GATE_RESOLUTION = Object.freeze({
  'decide-conflict': (p) => `the owner selects a direction in ${p}decide, whose Owner selection step clears the gate`,
  'recurring-finding': (p) => `the owner decides to fix the finding now or defer it in ${p}refine, whose Owner decision step clears the gate`,
  // commit_surface and dispatch_target gates, settable only with those on.
  'staging-set': (p) => `the owner confirms the staging set in ${p}commit, which clears the gate and then commits`,
  'pr-handling': () => 'the owner takes or declines the outward action (push, pull request), then clears the gate',
  'scope-routing': () => 'the owner chooses the route the phase note recommends, then clears the gate',
});

// The rules an autopilot step follows (dispatch_target on, ADR-0063 D4),
// printed by autopilotPreflight's banner: one set for the verbs, one for the
// commit surface (commit_surface), the one step that commits or closes.
const AUTOPILOT_COMMIT_RULES =
  'this command is the one step that commits or closes the workflow. Run its ' +
  'Autopilot block — phase7-commit.mjs --mode autopilot — and nothing else: it ' +
  'commits with the suggested subjects, closes a done workflow without a commit, ' +
  'or stops at the staging-set owner gate. Never pass a confirm or bypass flag, ' +
  'push, or open a pull request: landing is the owner\'s. ' +
  'Rules: core/skills/_shared/references/autopilot-mode.md.';
const AUTOPILOT_RULES =
  'ceremony gates auto-pass. Do not offer a presentation mode (present in batch); ' +
  'proceed with the recommended option instead of asking; carry only CRITICAL and ' +
  'MAJOR findings into refine; end the verb with finish-verb, which records ' +
  'next_step and leaves the terminal marker unset; never run git commit, push, or ' +
  'open a pull request; when a genuine owner judgment is needed, record the owner ' +
  'gate and stop. Rules: core/skills/_shared/references/autopilot-mode.md.';

/**
 * A verb's (or the commit surface's) Phase 0 check, before any write: the run
 * mode and any owner gate set on the workflow. Pure apart from reading the
 * workflow file.
 *
 * - autopilot (autopilotMode active), no gate: the rules banner;
 * - autopilot, a gate: refuse — an autopilot step never resolves an owner gate;
 * - AGENTIC_AUTOPILOT naming a run that autopilotMode ignores: one line on
 *   stderr saying so; the command runs interactively;
 * - interactive, a gate: a notice naming the gate, its pointer and how it is
 *   resolved, for the command to put to the owner before it continues;
 * - interactive, no gate: nothing (interactive output is unchanged).
 */
export async function autopilotPreflight({
  workflowPath,
  host = 'claude',
  // `verb` for the verbs, `commit` for the commit surface (commit_surface),
  // whose rules differ: it is the one surface that commits and closes.
  surface = 'verb',
  env = process.env,
  scriptPath = fileURLToPath(import.meta.url),
}) {
  validateHost(host);
  if (surface !== 'verb' && surface !== 'commit') {
    throw new Error(`surface must be verb or commit (got ${JSON.stringify(surface)})`);
  }
  if (surface === 'commit') requireCapability('commit_surface', 'autopilot-preflight --surface commit');
  const mode = autopilotMode({ env, host });
  let gate = null;
  if (typeof workflowPath === 'string' && workflowPath.length > 0) {
    const { frontmatter } = await readWorkflow(workflowPath);
    if (frontmatter.awaiting_owner_gate !== undefined) {
      gate = {
        gate: frontmatter.awaiting_owner_gate,
        since: frontmatter.awaiting_owner_since,
        pointer: frontmatter.awaiting_owner_pointer,
        lifecycle: frontmatter.workflow_type === 'start',
      };
    }
  }
  if (mode.active && gate) {
    return {
      mode: 'autopilot',
      gate,
      refuse: true,
      stdout: '',
      stderr:
        `✗ owner gate ${gate.gate} is set on this workflow since ${gate.since} ` +
        `(${gate.pointer}); an autopilot step never resolves an owner gate ` +
        '(ADR-0063 Q2). Stop here: the owner resolves it.\n',
    };
  }
  if (mode.active) {
    return {
      mode: 'autopilot',
      gate: null,
      refuse: false,
      stdout: `Autopilot run ${env.AGENTIC_AUTOPILOT} (ADR-0063 D4): ${surface === 'commit' ? AUTOPILOT_COMMIT_RULES : AUTOPILOT_RULES}\n`,
      stderr: '',
    };
  }
  const stderr = mode.ignored ? `${mode.reason}\n` : '';
  if (!gate) return { mode: 'interactive', ignored: mode.ignored, gate: null, refuse: false, stdout: '', stderr };
  const prefix = host === 'codex' ? `$${personaName()}:` : commandPrefix();
  // A gate met inside a start lifecycle is resolved there, never through a
  // verb's own resolver, whose finish-verb would close the lifecycle early
  // (PC2b Review of code step 6).
  const how = gate.lifecycle
    ? `the owner resolves it, then ${prefix}start resumes the lifecycle, clearing the gate with the phase it continues at`
    : OWNER_GATE_RESOLUTION[gate.gate]?.(prefix) ?? 'the owner resolves it, then clears the gate';
  return {
    mode: 'interactive',
    ignored: mode.ignored,
    gate,
    refuse: false,
    stdout:
      `Owner gate ${gate.gate} is pending since ${gate.since}: ${gate.pointer}.\n` +
      `Put it to the user before this command continues: ${how}.\n` +
      `Clearing it by hand once it is resolved, with the next step the owner chose ` +
      `and its action, which replaces the gate's (PC3b): ` +
      `node "${scriptPath}" awaiting-owner-clear --workflow-path "${workflowPath}" ` +
      `--host ${host} --gate ${gate.gate} --next-step-kind <verb|commit|done> ` +
      `--next-step-confidence HIGH [--next-step-verb <verb>] --resolution "<the owner's decision>" ` +
      `--next-action "<the next step's action>"\n`,
    stderr,
  };
}

/**
 * ADR-0063 D3 — a verb's final state write. With commit_surface off (PC2b
 * DD3) the kinds read: `verb` a next verb; `commit` the owner publishes (saves
 * and commits the deliverable by hand — nothing here runs it); `done` nothing
 * remains; `owner-decision` the owner decides what comes next. Without an
 * owner gate every kind closes the workflow as set-terminal does:
 * `summary-complete` with the terminal marker, archived by the Stop hook once
 * HEAD moves.
 *
 * With an owner gate (ADR-0063 D4, D6) the verb stopped on a judgment only the
 * owner makes: the gate is recorded with the next step `owner-decision` in one
 * write, an inherited terminal marker is turned off, and the workflow stays
 * open until the owner resolves the gate. Under autopilot (autopilotMode
 * active) the verb records its next step without closing (below).
 */
export async function finishVerb({
  workflowPath,
  host,
  nextAction,
  nextStep,
  // `{ gate, anchor | pointer }`: the owner judgment this verb stops on.
  ownerGate,
  env = process.env,
  now = new Date(),
  emitHandoff = false,
}) {
  if (nextStep === undefined || nextStep === null) {
    throw new Error('finish-verb records the next step: the kind and the confidence are required (ADR-0063 D6)');
  }
  if (ownerGate !== undefined && nextStep.kind !== 'owner-decision') {
    throw new Error(
      `an owner gate goes with the next step owner-decision (got ${JSON.stringify(nextStep.kind)}) (ADR-0063 D4)`,
    );
  }
  // Under autopilot (dispatch_target on, ADR-0063 D3) a verb records its next
  // step and leaves the terminal marker for the commit surface; a pending peer
  // is refused, so a next step is published only once the step is settled (D5).
  const autopilot = autopilotMode({ env, host }).active;
  if (autopilot) {
    const { frontmatter } = await readWorkflow(workflowPath);
    if (!noPendingEnsembleCheck(frontmatter)) {
      throw new Error(
        'refused under autopilot: a peer ensemble is still pending ' +
          `(${frontmatter.pending_ensemble.map((e) => e.run_id).join(', ')}); collect it and ` +
          'run ensemble-commit first — the next step is published only once the step is settled (ADR-0063 D5)',
      );
    }
  }
  if (autopilot || ownerGate !== undefined) {
    const result = await appendPhase({
      workflowPath, host, nextAction, nextStep, ownerGate,
      clearTerminalMarker: true, event: 'updated', now,
    });
    return { ...result, mode: autopilot ? 'autopilot' : 'interactive', terminal: false };
  }
  const result = await setTerminal({
    workflowPath,
    host,
    terminalPhase: 'summary-complete',
    terminalMarker: true,
    nextAction,
    nextStep,
    event: 'updated',
    now,
    emitHandoff,
  });
  return { ...result, mode: 'interactive', terminal: true };
}

// ---- capability-only writers (ADR-0066 Decision 3) ---------------------------
// dispatch_target: the P10 write-ahead marker and the mid-flight detach.
// commit_surface: entering the commit. Each refuses when its capability is
// off; the CLI cases refuse first.

/**
 * ADR-0028 §P10 — set the parent_writeback_at write-ahead marker.
 *
 * Phase 7 invokes this immediately BEFORE calling writebackParent so
 * that a crash between writeback and set-terminal leaves a durable
 * "writeback attempted" record. It does not gate later calls: the
 * orchestrator writes its engineer-terminal note once per engineer
 * workflow and commit and does nothing on a repeat, so the Stop hook
 * calls again whether or not the marker is present (ADR-0062 §Decision 2).
 */
export async function setParentWritebackMarker({
  workflowPath, host, at, now = new Date(),
}) {
  requireCapability('dispatch_target', 'setParentWritebackMarker');
  validateHost(host);
  if (typeof at !== 'string' || at.length === 0) {
    throw new Error('setParentWritebackMarker: at must be a non-empty string');
  }
  return withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    const nowIso = isoUtc(now);
    frontmatter.parent_writeback_at = at;
    frontmatter.updated_at = nowIso;
    frontmatter.host_history = [
      ...(frontmatter.host_history ?? []),
      { host, at: nowIso, event: 'updated' },
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
 * ADR-0028 §P10 — clear the parent_writeback_at write-ahead marker on
 * writeback failure. Idempotent: a missing marker leaves the file
 * unchanged. Phase 7 calls this when writebackParent returns a
 * failure, so the record says the writeback did not happen; the Stop
 * hook's call is the retry.
 */
export async function clearParentWritebackMarker({
  workflowPath, host, now = new Date(),
}) {
  requireCapability('dispatch_target', 'clearParentWritebackMarker');
  validateHost(host);
  return withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    if (!('parent_writeback_at' in frontmatter)) {
      // Idempotent — nothing to clear, no host_history churn.
      return { frontmatter, workflowPath, skipped: true };
    }
    const nowIso = isoUtc(now);
    delete frontmatter.parent_writeback_at;
    frontmatter.updated_at = nowIso;
    frontmatter.host_history = [
      ...(frontmatter.host_history ?? []),
      { host, at: nowIso, event: 'updated' },
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
 * ADR-0063 G1 — enter the commit: the workflow is not terminal while
 * `/engineer:commit` (or /engineer:start Phase 7) is committing it. A verb
 * chain run interactively ends each verb terminal (`summary-complete` + the
 * marker), and a split whose second commit fails would otherwise leave that
 * inherited marker in front of the Stop hook with HEAD moved, which archives
 * the half-committed workflow and notes its commit on the parent. Phase 7's
 * own terminal write, after every post-commit gate, turns it back on.
 */
export async function beginCommit({ workflowPath, host, now = new Date() }) {
  requireCapability('commit_surface', 'beginCommit');
  validateHost(host);
  return withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    const nowIso = isoUtc(now);
    frontmatter.current_phase = 'phase-7-commit';
    if (frontmatter.terminal_marker === true) frontmatter.terminal_marker = false;
    frontmatter.updated_at = nowIso;
    frontmatter.host_history = [
      ...(frontmatter.host_history ?? []),
      { host, at: nowIso, event: 'updated' },
    ];
    await atomicWrite(workflowPath, assembleWorkflowFile(frontmatter, body), { lockPath, token });
    return { frontmatter, workflowPath };
  });
}

/**
 * ADR-0019 §5 PR-E — mid-flight detach path invoked by orchestrator
 * /finalize / /abort step 2 when a child engineer workflow has NOT
 * reached a terminal commit. Two operations in one logical action:
 *
 *   1. Set `parent_detached: true` + `terminal_marker: false` on the
 *      child frontmatter (atomic under the per-file lock). The
 *      `parent_detached` field is closed-set per ADR-0019 PR-A — the
 *      schema already accepts it.
 *   2. Archive the workflow file (dir lock → file lock under
 *      `archiveWorkflow`).
 *
 * No parent writeback fires: the orchestrator already marked the
 * subtask `deferred` / `abandoned` in step 1, so there is no
 * `completed` semantic to propagate. ADR-0019 §6 lock-order is
 * naturally satisfied — this helper acquires only engineer-side
 * locks (per-file for the frontmatter mutation, dir+per-file inside
 * `archiveWorkflow`), all released before the orchestrator
 * re-acquires its own parent lock in step 3.
 *
 * @param {object} args
 * @param {string} args.workflowPath
 * @param {string} args.host
 * @param {string} args.repoRoot
 * @param {Date}   [args.now]
 * @returns {Promise<{detached: true, to: string, host: string} | {detached: false, reason: string}>}
 */
export async function detachArchive({
  workflowPath,
  host,
  repoRoot,
  now = new Date(),
}) {
  requireCapability('dispatch_target', 'detachArchive');
  validateHost(host);
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new Error('detachArchive: repoRoot is required (non-empty string)');
  }

  // Step 1 — mark `parent_detached: true` + `terminal_marker: false`
  // under the per-file lock. The `parent_detached` field is already
  // in FRONTMATTER_KEY_ORDER + validateSchema11Fields (PR-A); we just
  // set the boolean and let the serializer preserve key order.
  await withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    const nowIso = isoUtc(now);
    frontmatter.parent_detached = true;
    // Explicitly set `false` (not absent) so a stop-archive evaluation
    // post-detach reads the gate as "did not pass" rather than "missing
    // — defaults to false". Same boolean-strict treatment as PR-C0's
    // §4 auto-terminal pass.
    frontmatter.terminal_marker = false;
    frontmatter.updated_at = nowIso;
    frontmatter.host_history = [
      ...(frontmatter.host_history ?? []),
      { host, at: nowIso, event: 'updated' },
    ];
    await atomicWrite(
      workflowPath,
      assembleWorkflowFile(frontmatter, body),
      { lockPath, token },
    );
  });

  // Step 2 — archive. archiveWorkflow's withDirectoryLock + withFileLock
  // are acquired+released within its own scope; the step-1 file lock
  // above has already been released by the time we reach here. Both
  // engineer-side lock windows are independent, satisfying ADR-0019
  // §6 child-locks-released-before-parent rule for any subsequent
  // orchestrator parent acquire.
  const result = await archiveWorkflow({
    workflowPath,
    host,
    repoRoot,
    now,
  });
  if (!result.archived) {
    return { detached: false, reason: result.reason ?? 'archive-no-op' };
  }
  return { detached: true, to: result.to, host };
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
 * Gates (PC2b review): a caller that decided to archive from an
 * earlier read passes `recheck`, which is evaluated on the bytes read under
 * the file lock, the ones about to move. It returns the gates that fail; any
 * failure leaves the workflow where it is, unwritten, with `reason:
 * 'gate-not-met-under-lock'`. So a gate written between the caller's read and
 * the lock — an owner gate above all — keeps the workflow live.
 *
 * @param {object}  args
 * @param {string}  args.workflowPath
 * @param {string}  args.host
 * @param {string}  [args.repoRoot] — required if `archiveDirectory` is omitted
 * @param {string}  [args.archiveDirectory]
 * @param {(frontmatter: object) => string[]} [args.recheck]
 * @param {Date}    [args.now]
 * @returns {Promise<{archived: boolean, from?: string, to?: string, host?: string, reason?: string, gateFailures?: string[], workflowPath?: string}>}
 */
export async function archiveWorkflow({
  workflowPath,
  host,
  repoRoot,
  archiveDirectory,
  recheck,
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
      if (recheck) {
        const gateFailures = recheck(frontmatter);
        if (gateFailures.length > 0) {
          return { archived: false, reason: 'gate-not-met-under-lock', gateFailures, workflowPath };
        }
      }
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
  return terminalPhases().has(currentPhase);
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

// The ADR-0019 §5 detachArchive mid-flight detach (dispatch_target) sits with
// the other capability-only writers before archiveWorkflow.

// -----------------------------------------------------------------------------
// Public API: diagnoseRedundancy (ADR-0020 §Sub-decision 7)

/**
 * Probe the current branch for evidence of work overlapping the user's
 * request. Used by the persona's `start` Phase 0 BEFORE bootstrap to flag
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
// persona plugin itself writes during normal operation).
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
      // counts as the persona's own bookkeeping movement.
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
      // Exclude entries entirely — these are the persona's own bookkeeping
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
 * CLI wrapper: run `git status --porcelain=v1 --untracked-files=normal` under `repoRoot`, then
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
    // drift-digest: --untracked-files=normal so untracked files are seen even under a
    // user's status.showUntrackedFiles=no (without it such a tree hashes/classifies as
    // CLEAN). `normal` — not `all` — is deliberate and measured: it overrides the config
    // exactly the same way, but keeps git's directory collapsing, so the output bytes are
    // IDENTICAL to the historical default-config behaviour (`?? sub/`). `all` would expand
    // each untracked dir into its files, changing every digest and dirty_count (measured:
    // an untracked dir of 3 files counts 1 under normal, 3 under all) and paying a full
    // recursive walk on huge untracked trees.
    // Pinning the mode also makes the digest MACHINE-INDEPENDENT: a user configured
    // `all` previously produced per-file entries, so the same tree digested
    // differently per machine. Dirty/clean is unaffected either way (both
    // non-empty); only listing granularity narrows for those users.
    statusPorcelain = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], {
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

function cliNextStep(flags) {
  const present = ['next-step-kind', 'next-step-verb', 'next-step-confidence']
    .some((n) => n in flags);
  if (!present) return undefined;
  return {
    kind: flags['next-step-kind'],
    verb: flags['next-step-verb'],
    confidence: flags['next-step-confidence'],
  };
}

// Every flag takes a value in this CLI, so a boolean flag is spelled
// `--name true|false`, parsed strictly (a typo must not read as false).
function cliBoolean(flags, name, fallback) {
  const v = flags[name];
  if (v === undefined) return fallback;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`--${name} must be 'true' or 'false' (got '${v}')`);
}

function cliRequire(flags, names) {
  const missing = names.filter((n) => !(n in flags));
  if (missing.length > 0) {
    throw new Error(`Missing required flags: ${missing.map((n) => `--${n}`).join(', ')}`);
  }
}

// An unknown subcommand, or one whose capability is off (ADR-0066 Decision 3).
function unknownSubcommand(subcommand) {
  process.stderr.write(`state.mjs: unknown subcommand: ${subcommand}\n`);
  return 2;
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
      `         [--persona ${personaName()}] [--profile <name>] [--status-digest <hex>]`,
      '         [--current-phase <label>] [--next-action <text>]',
      '         [--original-request <text>] [--body-title <text>]',
      '         [--workflow-type verb-chain|start]',
      '    Create a new workflow under the directory-level lock. Print the new',
      '    workflow path on stdout.',
      ...(capabilityOn('dispatch_target')
        ? [
          '    [--parent-workflow <id> --originating-subtask <id>] (dispatch_target):',
          '    ADR-0019 §3 — when invoked by orchestrator dispatch, they record the',
          '    cross-plugin parent linkage. Both flags together or both omitted.',
          '    [--parent-workflow-path <abs path>] (dispatch_target): ADR-0067',
          '    Decision 3 — the macro file, recorded beside the two ids and only',
          '    with them; it must name an existing orchestrator macro whose',
          '    workflow_id is --parent-workflow.',
        ]
        : [
          '    dispatch_target off — no --parent-workflow / --originating-subtask /',
          '    --parent-workflow-path flags (ADR-0066 Decision 3).',
        ]),
      '    ADR-0020 §Sub-decision 5 — --workflow-type discriminates the',
      '    workflow shape. Omit (or pass verb-chain) for single-verb workflows',
      `    produced by the six ${personaName()} verb commands. The`,
      `    \`${commandPrefix()}start\` macro passes start. Default: verb-chain.`,
      '',
      '  append --workflow-path <path> --host <host>',
      '         [--verb <verb>] [--profile <name>]',
      '         [--phase-label <text>] [--phase-note <text>]',
      '         [--current-phase <label>] [--next-action <text>]',
      '         [--next-step-kind verb|commit|owner-decision|done',
      '          --next-step-confidence HIGH|MEDIUM|LOW [--next-step-verb <verb>]]',
      '         [--clear-next-step true|false] [--clear-terminal-marker true|false]',
      '         [--event created|updated|snapshot|resumed]',
      '    Append a phase note to an existing workflow. Default event=resumed.',
      '    ADR-0063 D6 — the --next-step-* flags replace all three next_step_*',
      '    keys at once (--next-step-verb exactly when the kind is verb);',
      '    --clear-next-step true deletes them and cannot be combined with them.',
      '    --clear-next-step false is the default and changes nothing.',
      '    --clear-terminal-marker true turns off a terminal marker an earlier',
      '    verb left, in the same write: a refine or start that did not converge',
      '    is not complete, so the Stop hook must not archive it (PC2b).',
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
      `               --terminal-phase ${[...terminalPhases()].join('|')}`,
      '               [--terminal-marker true|false] [--next-action <text>]',
      '               [--next-step-kind <kind> --next-step-confidence <c>',
      '                [--next-step-verb <verb>]]',
      '               [--event updated|resumed]',
      '    ADR-0017 sub-5 — atomic terminal-phase write (current_phase + terminal_marker).',
      '    Default --terminal-marker=true. The --next-step-* flags are as for append.',
      ...(capabilityOn('dispatch_target')
        ? ['    ADR-0063 D3 — --terminal-marker true exits 1 under an autopilot run:', '    a verb ends with finish-verb instead.']
        : []),
      '',
      '  finish-verb --workflow-path <path> --host <host> --next-action <text>',
      '              --next-step-kind verb|commit|owner-decision|done',
      '              --next-step-confidence HIGH|MEDIUM|LOW [--next-step-verb <verb>]',
      '              [--owner-gate <gate> --owner-gate-anchor <label>]',
      "    ADR-0063 D3 — a verb's final write: set-terminal summary-complete with",
      '    the terminal marker, plus the next step (commit_surface off: kind commit',
      '    means the owner publishes). --owner-gate needs --next-step-kind',
      '    owner-decision; it is recorded with the next step in one write and the',
      '    workflow stays open until the owner resolves it.',
      ...(capabilityOn('dispatch_target')
        ? ['    Under an autopilot run: the next step only, terminal marker unset, and', '    a pending peer ensemble is refused.']
        : []),
      '',
      ...(capabilityOn('dispatch_target')
        ? [
          `  autopilot-preflight [--workflow-path <path>] [--host <host>]${capabilityOn('commit_surface') ? ' [--surface verb|commit]' : ''}`,
          '    ADR-0063 D4 — print the autopilot rules when AGENTIC_AUTOPILOT names an',
          '    autopilot run on Claude, and nothing otherwise. With an owner gate set',
          '    on the workflow: exit 1 under autopilot; otherwise print the gate and',
          '    how the owner resolves it.',
        ]
        : [
          '  autopilot-preflight [--workflow-path <path>] [--host <host>]',
          "    A verb's Phase 0 check: one line when AGENTIC_AUTOPILOT names a run,",
          '    which is ignored here (dispatch_target off, ADR-0066 Decision 3); with',
          '    an owner gate set, the gate and how the owner resolves it. Exit 0.',
        ]),
      '',
      `  awaiting-owner-set --workflow-path <path> --host <host>`,
      `                     --gate ${[...VALID_WORKFLOW_OWNER_GATES].join('|')}`,
      '                     (--pointer <repo-relative path#anchor> | --anchor <label>)',
      '                     [--since <YYYY-MM-DDTHH:MM:SSZ>]',
      '    ADR-0063 D6 — record the owner gate this workflow waits on. Default',
      "    --since is now. --anchor derives the pointer from the workflow's own",
      '    path. Exit 1 when a different gate is already set, or for a gate whose',
      `    capability is off (settable here: ${[...settableOwnerGates()].join(', ')}).`,
      '',
      '  awaiting-owner-clear --workflow-path <path> --host <host> --gate <gate>',
      '                       [--next-step-kind <kind> --next-step-confidence <c>',
      '                        [--next-step-verb <verb>] | --clear-next-step true]',
      '                       [--next-action <text>] [--resolution <text>]',
      '    ADR-0063 D6 — clear the owner gate once the owner has decided, and',
      '    append an "Owner gate resolved" phase note, with the next step the',
      '    owner chose (or none, --clear-next-step true), the next action that',
      '    replaces the gate\'s, and the decision in words in the same write. Exit 1 when',
      `    the gate is not the one set${capabilityOn('dispatch_target') ? ', or under an autopilot run' : ''}.`,
      '',
      '  archive --workflow-path <path> --host <host> --repo-root <path>',
      '    ADR-0017 sub-5 — move workflow file from workflows/ to archive/.',
      '    Collision-safe (timestamp-suffix). Idempotent if source is already absent.',
      '',
      ...(capabilityOn('dispatch_target')
        ? [
          '  detach-archive --workflow-path <path> --host <host> --repo-root <path>',
          '    ADR-0019 PR-E — atomic mid-flight detach: write parent_detached:true +',
          '    terminal_marker:false, then archive. Invoked by orchestrator',
          '    /finalize·/abort step 2 when the child has NOT reached a terminal',
          '    commit. Does NOT fire parent writeback. Emits JSON:',
          '      {detached: true, to: <archive-path>, host} on success',
          '      {detached: false, reason: <string>} on archive no-op',
        ]
        : [
          '  (dispatch_target off — no detach-archive subcommand: the ADR-0019 PR-E',
          '   mid-flight detach exists only for orchestrator dispatch, which is',
          '   off here; ADR-0066 Decision 3.)',
        ]),
      '',
      '  diagnose-redundancy --repo-root <path> [--base-branch <ref>]',
      '    ADR-0020 §Sub-decision 7 — probe the current branch for evidence of work',
      '    overlapping the user request (commits ahead of merge-base, open PRs). Invoked',
      `    by ${commandPrefix()}start Phase 0 BEFORE bootstrap. Default --base-branch=origin/main.`,
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
      ...(capabilityOn('dispatch_target')
        ? [
          '  set-parent-writeback-marker --workflow-path <path> --host <host> --at <iso>',
          '    ADR-0028 §P10 (PR3 M3) — the write-ahead marker the Phase 7 driver sets',
          '    BEFORE writebackParent fires: a record that P10 tried.',
          '',
          '  clear-parent-writeback-marker --workflow-path <path> --host <host>',
          '    ADR-0028 §P10 (PR3 M3) — clear the marker on writeback failure.',
          '    Idempotent: missing marker is a no-op.',
        ]
        : [
          '  (dispatch_target off — no set/clear-parent-writeback-marker subcommands:',
          '   the ADR-0028 §P10 write-ahead marker exists only for parent',
          '   writeback, which is off here; ADR-0066 Decision 3.)',
        ]),
      '',
      '  stop-archive --workflow-path <path> --host <host> --repo-root <path>',
      '               [--head-sha <sha>] [--head-subject <text>] [--status-digest <hex>]',
      '    Wraps runStopArchive with explicit head info so the A3 head_moved gate',
      '    is evaluated against an explicitly-supplied SHA rather than the',
      '    current-process git HEAD. With dispatch_target on, orchestrator',
      '    /finalize·/abort step 2 invokes it when the child HAS reached a terminal',
      '    commit (probing the child branch HEAD and passing it as --head-sha).',
      '    Emits the runStopArchive return as JSON:',
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
        // With dispatch_target off, fail loud on parent-linkage flags instead
        // of silently ignoring them: a dispatcher exporting the
        // AGENTIC_PARENT_WORKFLOW contract at this persona is misconfigured
        // (it is no orchestrator dispatch target, ADR-0066 Decision 3), and a
        // silently-unlinked workflow would mask that bug.
        if (!capabilityOn('dispatch_target') && (flags['parent-workflow'] !== undefined || flags['originating-subtask'] !== undefined)) {
          throw new Error(
            `${personaName()} state.mjs create does not accept --parent-workflow/--originating-subtask: ` +
              `${personaName()} is no orchestrator dispatch target (dispatch_target off, ADR-0066 Decision 3)`,
          );
        }
        // ADR-0067 Decision 3's macro path, refused the same way.
        if (!capabilityOn('dispatch_target') && flags['parent-workflow-path'] !== undefined) {
          throw new Error(
            `${personaName()} state.mjs create does not accept --parent-workflow-path: ` +
              `${personaName()} is no orchestrator dispatch target (dispatch_target off, ADR-0066 Decision 3)`,
          );
        }
        // The persona is canonical: another persona's --persona landing in
        // this persona's state home would cross persona boundaries silently
        // (read-side stays tolerant for fixtures).
        if (flags.persona !== undefined && flags.persona !== personaName()) {
          throw new Error(
            `${personaName()} state.mjs create only writes persona '${personaName()}' (got '${flags.persona}')`,
          );
        }
        const result = await createWorkflow({
          repoRoot: flags['repo-root'],
          verb: flags.verb,
          host: flags.host,
          persona: flags.persona ?? personaName(),
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
          // ADR-0019 §3 — dispatch_target's parent linkage (refused above
          // when it is off).
          parentWorkflow: flags['parent-workflow'],
          originatingSubtask: flags['originating-subtask'],
          parentWorkflowPath: flags['parent-workflow-path'],
          // ADR-0020 PR 2 — workflow-shape discriminator. Omitting the
          // flag defaults to 'verb-chain' inside createWorkflowUnderLock;
          // the persona's `start` macro passes 'start'. cliParseFlags
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
          nextStep: cliNextStep(flags),
          clearNextStep: cliBoolean(flags, 'clear-next-step', false),
          clearTerminalMarker: cliBoolean(flags, 'clear-terminal-marker', false),
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

      // dispatch_target — the ADR-0028 §P10 write-ahead marker; an unknown
      // subcommand when the capability is off.
      case 'set-parent-writeback-marker': {
        if (!capabilityOn('dispatch_target')) return unknownSubcommand(subcommand);
        cliRequire(flags, ['workflow-path', 'host', 'at']);
        await setParentWritebackMarker({
          workflowPath: flags['workflow-path'],
          host: flags.host,
          at: flags.at,
        });
        process.stdout.write(`${flags['workflow-path']}\n`);
        return 0;
      }

      case 'clear-parent-writeback-marker': {
        if (!capabilityOn('dispatch_target')) return unknownSubcommand(subcommand);
        cliRequire(flags, ['workflow-path', 'host']);
        await clearParentWritebackMarker({
          workflowPath: flags['workflow-path'],
          host: flags.host,
        });
        process.stdout.write(`${flags['workflow-path']}\n`);
        return 0;
      }

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
        // ADR-0063 D3 — under autopilot a verb ends with finish-verb, and only
        // the commit surface sets the terminal marker.
        if (terminalMarker && autopilotMode({ env: process.env, host: flags.host }).active) {
          throw new Error(
            `refused under autopilot (AGENTIC_AUTOPILOT=${process.env.AGENTIC_AUTOPILOT}): ` +
              `a verb ends with finish-verb, and only ${commandPrefix()}commit sets the terminal marker (ADR-0063 D3)`,
          );
        }
        await setTerminal({
          workflowPath: flags['workflow-path'],
          host: flags.host,
          terminalPhase: flags['terminal-phase'],
          terminalMarker,
          nextAction: flags['next-action'],
          nextStep: cliNextStep(flags),
          event: flags.event ?? 'updated',
          // ADR-0031 amendment / ADR-0043 — this CLI case is the persona's
          // production completion entry point (verb Phase 2 finalize + the
          // start macro's terminal step); fire the sidecar.
          emitHandoff: true,
        });
        process.stdout.write(`${flags['workflow-path']}\n`);
        return 0;
      }

      // ADR-0063 D6 — owner gates. Both refuse with exit 1: set when a
      // different gate is already set or the gate's capability is off; clear
      // when the gate named is not the one set.
      case 'awaiting-owner-set': {
        cliRequire(flags, ['workflow-path', 'host', 'gate']);
        if (!('pointer' in flags) && !('anchor' in flags)) {
          throw new Error('Missing required flags: --pointer or --anchor');
        }
        await setAwaitingOwner({
          workflowPath: flags['workflow-path'],
          host: flags.host,
          gate: flags.gate,
          pointer: flags.pointer,
          anchor: flags.anchor,
          since: flags.since,
        });
        process.stdout.write(`${flags['workflow-path']}\n`);
        return 0;
      }

      case 'awaiting-owner-clear': {
        cliRequire(flags, ['workflow-path', 'host', 'gate']);
        await clearAwaitingOwner({
          workflowPath: flags['workflow-path'],
          host: flags.host,
          gate: flags.gate,
          nextStep: cliNextStep(flags),
          clearNextStep: cliBoolean(flags, 'clear-next-step', false),
          nextAction: flags['next-action'],
          resolution: flags.resolution,
        });
        process.stdout.write(`${flags['workflow-path']}\n`);
        return 0;
      }

      // A verb's Phase 0 check (ADR-0063 D4; ADR-0066 Decision 3's activation rule).
      case 'autopilot-preflight': {
        const result = await autopilotPreflight({
          workflowPath: flags['workflow-path'],
          host: flags.host ?? 'claude',
          surface: flags.surface ?? 'verb',
        });
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        return result.refuse ? 1 : 0;
      }

      // ADR-0063 D3 — a verb's final write.
      case 'finish-verb': {
        cliRequire(flags, [
          'workflow-path', 'host', 'next-action', 'next-step-kind', 'next-step-confidence',
        ]);
        if (('owner-gate' in flags) !== ('owner-gate-anchor' in flags)) {
          throw new Error('--owner-gate and --owner-gate-anchor go together');
        }
        const result = await finishVerb({
          workflowPath: flags['workflow-path'],
          host: flags.host,
          nextAction: flags['next-action'],
          nextStep: cliNextStep(flags),
          ownerGate: 'owner-gate' in flags
            ? { gate: flags['owner-gate'], anchor: flags['owner-gate-anchor'] }
            : undefined,
          // As for set-terminal: a verb completion fires the ADR-0031
          // session-handoff sidecar.
          emitHandoff: true,
        });
        if (result.mode === 'autopilot') {
          process.stderr.write(
            `autopilot: next step recorded; the terminal marker is left for ${commandPrefix()}commit (ADR-0063 D3)\n`,
          );
        } else if (result.terminal === false) {
          process.stderr.write(
            `owner gate ${flags['owner-gate']} recorded; the workflow stays open until the owner resolves it (ADR-0063 D6)\n`,
          );
        }
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

      // dispatch_target — ADR-0019 PR-E mid-flight detach; an unknown
      // subcommand when the capability is off.
      case 'detach-archive': {
        if (!capabilityOn('dispatch_target')) return unknownSubcommand(subcommand);
        cliRequire(flags, ['workflow-path', 'host', 'repo-root']);
        const result = await detachArchive({
          workflowPath: flags['workflow-path'],
          host: flags.host,
          repoRoot: flags['repo-root'],
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return 0;
      }

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
        return unknownSubcommand(subcommand);
    }
  } catch (err) {
    process.stderr.write(`state.mjs ${subcommand}: ${err.message}\n`);
    return 1;
  }
}

// Run as a CLI only when this file is the entry point (ADR-0066 D1): both
// sides are compared canonical and as paths, so an install reached through a
// symlink, or under a directory whose name needs URL escaping, still runs.
if (isCliEntry(import.meta.url)) {
  // Wrap cliMain in an async IIFE rather than awaiting it at top level.
  // Top-level await blocks circular dynamic imports performed inside
  // cliMain (the `stop-archive` subcommand dynamically imports
  // stop-archive.mjs, which re-imports from this file): with top-level
  // await pending, the inner dynamic import resolves to a Module record
  // whose state never settles, and Node emits "Detected unsettled
  // top-level await" before exiting with code 13. The IIFE keeps the
  // dispatch asynchronous without making it top-level.
  (async () => {
    // Set the exit code and let the process end on its own: process.exit()
    // drops whatever a piped stdout has not flushed, and a reader then got
    // exactly 65,536 bytes of a longer document (C70; Node's process.exit docs).
    // The persona declaration is validated first, before any subcommand runs:
    // a broken or foreign declaration refuses every write before a lock is
    // taken or a byte changes (ADR-0066 Decision 2).
    if (!personaOrRefuse('state.mjs')) {
      process.exitCode = 1;
      return;
    }
    process.exitCode = await cliMain(process.argv.slice(2));
  })();
}
