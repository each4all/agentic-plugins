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
  lstat,
} from 'node:fs/promises';
import { closeSync, constants as fsConstants, copyFileSync, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, isAbsolute, resolve as resolvePath } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
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
import { capabilityOn, commandPrefix, loadPersona, personaName, personaOrRefuse, stateDirRel } from './lib/persona.mjs';
import { captureWorkingTree } from './lib/peer-snapshot.mjs';
import {
  HOLD_PERSONA_CAPABILITY,
  HOLDS_PROTOCOL,
  OPERATION_ID_RE,
  heldLaneOfBranch,
  holdApplies,
  isSafeMacroId,
  isSafeSubtaskId,
  laneHoldFacts,
  mainWorktreeRoot as holdsMainRoot,
  newOperationId,
  operationCleared,
  opRecordState,
  publishOpRecord,
  readActivation,
  readOperationTransport,
  readOps,
  readOwnerHold,
  removeOpRecord,
  writeOperationTransport,
} from './lib/holds.mjs';
import {
  MAX_REQUEST_BYTES,
  MAX_RESULTS_BYTES,
  RECORD_VERSION as VERIFY_RECORD_VERSION,
  SLOT_TYPES,
  VERIFY_DECLARATION_PATH,
  VERIFY_RECORD_CAPABILITY,
  canonicalJson,
  carryOver,
  compareAttempts,
  endProblem,
  handoffDigest,
  handoffState,
  isNewerRecord,
  parseBatchStart,
  parseDeclaration,
  parseEnd,
  parseRequestInput,
  parseResult,
  previousOf,
  readResults,
  requestId as verifyRequestId,
  resolveCheck,
  resultProblem,
  resultsDigest,
  retainBatches,
  scalarBytes,
  stampHandoff,
  validateStoredAttempt,
  validateStoredHandoff,
  validateStoredRequest,
  validateStoredResults,
  workerChecksProblem,
  worstCaseBytes,
} from './lib/verify.mjs';
import {
  CRITIQUE_RUN_MARKER,
  ReviewScopeError,
  artifactChanges,
  baselineCommit,
  changedPassages,
  classifyDeliverable,
  closeGeneration,
  critiqueEntries,
  currentBranch,
  decideScope,
  emptyLedger,
  openGeneration,
  operationInProgress,
  recordRefine,
  reviewStatus,
  unclosedCritique,
  unrecordedCritique,
  validateLedger,
} from './lib/review-scope.mjs';
import {
  aliasedComponent,
  commandCheckout,
  creationRoot,
  defaultStateRoot,
  describeStateRoot,
  disableSharedCreation,
  enableSharedCreation,
  otherCopiesOf,
  otherWorktreeRoots,
  readFrontmatterText,
  readSet,
  readSharedCreation,
  repositoryRoots,
  runInCommandDirectory,
  sameDirectory,
  samePhysicalFile,
  workflowEntryProblem,
  workflowIdOfText,
  writerRoots,
} from './lib/state-root.mjs';
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
// workflow-file subset of ADR-0063 D4, the same six engineer stores
// (`plan-approval` and `plan-conflict` live on the orchestrator macro, and
// `duplicate-workflow` has no single workflow file to live in). Which of them
// a persona can set depends on its capabilities (ADR-0066 Decision 3); a
// reader accepts all six, so a file is read the same by every persona.
//
// ADR-0068 Decision 5 adds `verify`: the step asks the autopilot driver to run
// the checks its request names (verify_request) before the step that follows
// them. Every reader accepts it; the only writer is finish-verb
// --verify-request-file under a run that offers verification (verifyOffer).
export const VALID_NEXT_STEP_KINDS = new Set(['verb', 'commit', 'owner-decision', 'done', 'verify']);
// The kinds an agent maps an Active Next-Action Proposal's selected_next to
// (the reference contract's closed-enum table): every kind but `verify`, which
// is written only from a request file under the driver's offer.
export const PROPOSAL_NEXT_STEP_KINDS = new Set([...VALID_NEXT_STEP_KINDS].filter((k) => k !== 'verify'));
export const VALID_CONFIDENCE = new Set(['HIGH', 'MEDIUM', 'LOW']);
export const VALID_WORKFLOW_OWNER_GATES = new Set([
  'scope-routing',
  'decide-conflict',
  'peer-conflict',
  'recurring-finding',
  'staging-set',
  'pr-handling',
]);
// ADR-0067 Decision 8 — the conflict gates: a synthesis verdict of conflict
// in decide (decide-conflict) or in critique and investigate (peer-conflict).
// Only these record the run id of that synthesis, `awaiting_owner_run_id`,
// which binds the consensus task file the verb wrote to its gate.
export const CONFLICT_OWNER_GATES = new Set(['decide-conflict', 'peer-conflict']);
// A run id as a gate records it and a task file's name carries it: the
// peer-runner's alphabet without `:` and without `.`, so that the live name
// `<workflow-id>.<run-id>.md` and the retired `<workflow-id>.<run-id>.resolved.md`
// can never name the same file (a run id `r.resolved` would).
const AWAITING_OWNER_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export function isSafeConsensusRunId(runId) {
  return typeof runId === 'string' && AWAITING_OWNER_RUN_ID_RE.test(runId);
}
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

// The owner gates a persona can set (ADR-0066 Decision 3, PC2b DD2): the four
// whose resolving surface every persona has, and the two that belong to a
// capability — staging-set to commit_surface (the commit confirms the staging
// set), pr-handling to dispatch_target (an autopilot step stops before an
// outward action). A reader accepts all six; a setter accepts only these.
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
      // ADR-0067 Decision 8 — the consensus task files of a conflict gate.
      consensusDirRel: `${stateDirRel()}/consensus`,
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
      consensusDirRel: `${legacy}/consensus`,
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
    // The root this home sits under: a checkout's toplevel or the default
    // state root (ADR-0067 Decision 1(a)), never read as a checkout for git.
    stateRoot: repoRoot,
    root: join(repoRoot, spec.stateDirRel),
    workflows: join(repoRoot, spec.workflowDirRel),
    archive: join(repoRoot, spec.archiveDirRel),
    creationLock: join(repoRoot, spec.creationLockRel),
    peerRuns: join(repoRoot, spec.peerRunsDirRel),
    consensus: join(repoRoot, spec.consensusDirRel),
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

// The home a workflow file sits in and the state root that holds it (ADR-0067
// Decision 1(b)): the root its archive, locks and peer runs derive from. It is
// never a checkout: git facts come from the checkout a command runs in.
function inferStorageFromWorkflowPath(workflowPath) {
  const text = String(workflowPath);
  const canonicalNeedle = `/${stateDirRel()}/`;
  const canonicalIndex = text.indexOf(canonicalNeedle);
  if (canonicalIndex >= 0) {
    return { home: 'canonical', stateRoot: text.slice(0, canonicalIndex) };
  }
  if (capabilityOn('legacy_homes')) {
    const legacyIndex = text.indexOf(`/${legacyStateDirRel()}/`);
    if (legacyIndex >= 0) {
      return { home: 'legacy', stateRoot: text.slice(0, legacyIndex) };
    }
  }
  return null;
}

// The state root holding a workflow file (ADR-0067 Decision 1(c)): a pointer
// into the record is spelled relative to it. Null when the path is under no
// state home.
export function workflowStateRoot(workflowPath) {
  return workflowStorage(workflowPath)?.stateRoot ?? null;
}

// The home a workflow file sits in and the state root holding it,
// `{ home, stateRoot }`, or null when the path is under no state home: the
// home its archive, locks and peer runs derive from (ADR-0067 Decision 4,
// item 2).
export function workflowStorage(workflowPath) {
  const inferred = inferStorageFromWorkflowPath(resolvePath(String(workflowPath)));
  return inferred && inferred.stateRoot.length > 0 ? inferred : null;
}

// ADR-0067 Decision 1(a) — the checkout a command runs in, or null when it
// cannot be told (lib/state-root.mjs).
export { commandCheckout };

// -----------------------------------------------------------------------------
// ADR-0067 — the read set and the creation locks

function homeNames() {
  return capabilityOn('legacy_homes') ? ['canonical', 'legacy'] : ['canonical'];
}

// Where existing records are found: the default state root first, then the
// checkout when it is another directory (Decision 1(a)). AGENTIC_STATE_BASE
// and the shared-creation switch never narrow it.
function lookupRoots(repoRoot) {
  assertAbsoluteRepoRoot(repoRoot);
  return readSet(repoRoot);
}

/**
 * ADR-0067 Decision 4, item 2 — one writable copy. Every write to an existing
 * record goes through `withFileLock`, which, holding the file's lock, refuses:
 * - a path whose last component is a symbolic link: the atomic replace would
 *   turn the alias into a second copy;
 * - a record in a `workflows/` home whose workflow id is also held by a second
 *   file, under its name or another, in any home of any root of the
 *   repository (the read set and every worktree's own homes): two files at
 *   one relative path under two roots are the ambiguity the readers report,
 *   and a writer never picks one;
 * - a record whose branch key has a second active workflow in the read set of
 *   the root holding it or of the checkout the command runs in (Decision 2;
 *   Decision 4, item 1): the readers there report the ambiguity.
 * A directory or a file that cannot be read, or worktrees git cannot list,
 * refuse too: the copy may be there.
 */
async function assertSingleCopy(workflowPath) {
  const absolute = resolvePath(String(workflowPath));
  let st;
  try {
    st = await lstat(absolute);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new Error(
      `Refusing to write ${JSON.stringify(absolute)}: it is a symbolic link, and the atomic replace would turn ` +
        'the alias into a second copy of the workflow. Write the file it names (ADR-0067 Decision 4, item 2).',
    );
  }
  if (basename(dirname(absolute)) !== 'workflows') return;
  const inferred = inferStorageFromWorkflowPath(absolute);
  if (!inferred || inferred.stateRoot.length === 0) return;
  // The frontmatter only, from a regular file opened without blocking: a FIFO
  // in the record's place is refused, never waited on.
  let text;
  try {
    text = readFrontmatterText(absolute);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (text === null) {
    throw new Error(
      `Refusing to write ${JSON.stringify(absolute)}: it is not a regular file (ADR-0067 Decision 4, item 1).`,
    );
  }
  const name = basename(absolute);
  const copies = otherCopiesOf({
    file: absolute,
    workflowId: workflowIdOfText(text),
    dirs: repositoryRoots(inferred.stateRoot).flatMap((root) => homeNames().map((home) => workflowDir(root, { home }))),
  });
  if (copies.length === 0) {
    const branch = extractFrontmatterBranch(text);
    // Throws, naming both files, when the branch key has a second one.
    if (branch) await findActiveWorkflowByBranchInRoots(writerRoots(inferred.stateRoot), branch);
  }
  if (copies.length > 0) {
    throw new Error(
      `Ambiguous ${personaName()} workflow storage: ${name} is held by ${copies.length + 1} files: ` +
        `${[absolute, ...copies].map((f) => JSON.stringify(f)).join(', ')}. One workflow has one writable copy ` +
        '(ADR-0067 Decision 4, item 2): no write goes to either until one is removed ' +
        '(docs/runbooks/state-root-cutover.md).',
    );
  }
}

// The write guard of withFileLock, run without the lock: a caller about to
// start work that ends in a write to `workflowPath` (an ensemble run) asks it
// first, so a refusal comes before that work (ADR-0067 Decision 4, item 2).
// The write itself checks again, holding the lock.
export async function assertWorkflowWritable(workflowPath) {
  await assertSingleCopy(workflowPath);
}

/**
 * ADR-0067 Decision 2 — the creation locks a create or an archive takes on
 * the home it writes (`storage`): with shared creation on, the repository's
 * (the default state root's home) first, then the written home's when that is
 * another, always in that order, so an older script, which takes only the
 * lock of the home it writes, still meets this one; with it off, the written
 * home's alone, as before. An unreadable switch takes both.
 */
async function withCreationLocks(storage, fn) {
  const switchState = readSharedCreation(storage.stateRoot).state;
  if (switchState === 'off') return withDirectoryLock(storage.stateRoot, fn, { storage });
  const defaultRoot = defaultStateRoot(storage.stateRoot);
  const repoStorage = await resolveWorkflowStorage(defaultRoot, { mode: 'write' });
  if (samePhysicalFile(repoStorage.creationLock, storage.creationLock) ||
      (sameDirectory(defaultRoot, storage.stateRoot) && repoStorage.home === storage.home)) {
    return withDirectoryLock(storage.stateRoot, fn, { storage });
  }
  // `fn` holds both locks, so the write it commits checks both at its commit
  // (atomicWrite's `outer`): a writer whose repository lock was reclaimed
  // commits nothing, though it still holds the home's (ADR-0068 Decision 5,
  // item 7).
  return withDirectoryLock(defaultRoot, (outer) => withDirectoryLock(storage.stateRoot,
    (inner) => fn({ ...inner, outer: [{ lockPath: outer.lockPath, token: outer.token }] }), { storage }), { storage: repoStorage });
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
// `ownership.outer`, when given, lists the locks the writer took around that
// one ({ lockPath, token } each, the repository's creation lock under shared
// creation): each is re-verified the same way, so a write commits only while
// the writer still holds every lock it took.
//
// `precommit`, when given, is the caller's own condition, checked at the
// same commit boundary, after the token: a write that must commit only while
// another file still holds what the caller read (the archive's source lock
// and bytes) passes it here, never as a check made before the write. A
// condition that fails or throws discards the tmp file, and the error
// carries `code: 'EPRECOMMIT'`.

async function atomicWrite(targetPath, contents, ownership = null, { precommit = null } = {}) {
  const tmpPath = `${targetPath}.${pid}.${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(tmpPath, 'wx', 0o600);
  try {
    await handle.writeFile(contents, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Every lock the writer holds: the one it names, then the locks it took
  // around that one (`outer`, the repository's creation lock under shared
  // creation), each with the same check.
  for (const { lockPath, token } of ownership ? [ownership, ...(ownership.outer ?? [])] : []) {
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
  if (precommit) {
    let holds = false;
    try { holds = (await precommit()) === true; } catch {}
    if (!holds) {
      try { await unlink(tmpPath); } catch {}
      const err = new Error(
        `atomicWrite: the condition of the write to ${targetPath} no longer holds immediately before commit; ` +
          'the in-flight write is discarded',
      );
      err.code = 'EPRECOMMIT';
      throw err;
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
 * `{ lockPath, token, held }` so it can pass ownership into `atomicWrite()`
 * for pre-commit recheck, and into writeWorkflow. Used for appends / snapshot
 * updates / frontmatter edits to an existing workflow file, and for the files
 * kept beside it.
 *
 * ADR-0068 Decision 5, item 7 — every writer of a workflow takes this lock,
 * so the write is admitted here, holding it, to the attempt mark
 * (admitAttempt) when it is made under an autopilot run (the step's `env`,
 * on `host`): a stale attempt is refused before `fn` runs. `held` is null
 * outside any run, and for a file that does not exist yet. `hold: false` is
 * for a lock on a path that holds no workflow of this one (an archive
 * destination).
 *
 * `writer` names the write's class in the inventory of ADR-0068 Decision 2,
 * item 7 (LANE_WRITERS): holding the lock, a write of a macro's child outside
 * any persona operation is refused while its subtask is held (admitLaneWriter);
 * `runId` is the run a settlement settles.
 */
export async function withFileLock(workflowPath, fn, {
  env = process.env, host = env.AGENTIC_HOST || 'claude', hold = true, writer = LANE_WRITERS.plain, runId = null,
} = {}) {
  if (!LANE_WRITER_CLASSES.has(writer)) throw new Error(`withFileLock: ${JSON.stringify(writer)} is no writer class (LANE_WRITERS)`);
  const lockPath = fileLockPath(workflowPath);
  const token = await acquireLock(lockPath);
  let releaseOk = false;
  try {
    // ADR-0067 Decision 4, item 2 — checked holding the lock, so a copy that
    // appears while this writer waits for it is seen.
    await assertSingleCopy(workflowPath);
    // ADR-0068 Decision 2, item 7 — checked holding the lock, so a hold set
    // while this writer waits for it is seen.
    await admitLaneWriter(workflowPath, { writer, runId });
    const held = hold ? await admitWrite(workflowPath, { env, host }) : null;
    const result = await fn({ lockPath, token, held });
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
  // ADR-0067 Decision 1(a): every home of every root of the read set, not the
  // home resolveWorkflowStorage selects: an active workflow in the legacy home
  // stays listed while the canonical home holds only archive or peer state.
  return listWorkflowFilesAllHomes(repoRoot);
}

// The `.md` workflow files of `dirs`, in that order, each directory's sorted,
// one entry per physical file, under the name that is not a link, else the
// first: the read set's default state root comes first, so of two plain names
// that one is kept (ADR-0067 Decision 4, items 1 and 2).
async function workflowFilesIn(dirs) {
  const files = [];
  const seen = new Map();
  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir);
    } catch (err) {
      // Only absence is none: a file in the home's place (ENOTDIR) is a layout
      // runtime's readers refuse too (ADR-0067 Decision 4, item 1).
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    for (const name of entries.sort()) {
      if (!name.endsWith('.md') || name.endsWith('.md.tmp')) continue;
      const file = join(dir, name);
      // A FIFO, a device or a directory under a workflow name is refused, as
      // runtime's readers refuse it (ADR-0067 Decision 4, item 1): the Stop's
      // sweep would otherwise wait on it.
      const problem = workflowEntryProblem(file);
      if (problem === 'gone') continue;
      if (problem !== null) {
        throw new Error(
          `${personaName()} workflow home ${safeFilename(dir)}: ${name} is ${problem}. Remove it, or replace it with the workflow file (ADR-0067 Decision 4, item 1).`,
        );
      }
      let identity = file;
      try {
        identity = realpathSync(file);
      } catch {
        /* vanished or unreadable: its spelling stands in */
      }
      if (seen.has(identity)) {
        // The name that is not a link wins over a link kept first, as
        // addPhysicalMatch keeps it: a writer is handed the file itself.
        const index = seen.get(identity);
        try {
          if (lstatSync(files[index]).isSymbolicLink() && !lstatSync(file).isSymbolicLink()) files[index] = file;
        } catch {
          /* gone since the listing: keep the name already held */
        }
        continue;
      }
      seen.set(identity, files.length);
      files.push(file);
    }
  }
  return files;
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
  // ADR-0067 Decision 1(a): every home of every root of the read set.
  return workflowFilesIn(lookupRoots(repoRoot).flatMap((root) => homeNames().map((home) => workflowDir(root, { home }))));
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
// One file reached through two names in a directory (a symlink to it) is one
// workflow; the name that is not a link is kept, so a writer is handed the file
// itself (ADR-0067 Decision 4, item 2).
function addPhysicalMatch(matching, file) {
  const index = matching.findIndex((m) => samePhysicalFile(m, file));
  if (index < 0) {
    matching.push(file);
    return;
  }
  try {
    if (lstatSync(matching[index]).isSymbolicLink() && !lstatSync(file).isSymbolicLink()) matching[index] = file;
  } catch {
    /* gone since the listing: keep the name already held */
  }
}

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
      // Through the frontmatter only, and regular files only: the scan runs
      // under a writer's lock across every worktree, so a FIFO or a long body
      // must not stall it (ADR-0067 Decision 4, item 2).
      text = readFrontmatterText(file);
    } catch (err) {
      // Gone since the listing: an archive moved it, so it is not active
      // (ADR-0067: another worktree's archive may run between the two).
      if (err.code === 'ENOENT') continue;
      throw new Error(
        `findActiveWorkflowByBranch: failed to read workflow file ${safeFilename(file)} ` +
          `(${err.code || err.message}). Cannot determine its branch — per-branch ` +
          `single-active invariant at risk (ADR-0018 §sub-2). Reconcile manually.`,
      );
    }
    // Not a regular file (a FIFO, a device, a directory): its branch cannot
    // be read, and runtime's readers report it as not a regular file, so the
    // writers refuse too, without waiting on it (ADR-0067 Decision 4, item 1).
    if (text === null) {
      throw new Error(
        `findActiveWorkflowByBranch: workflow file ${safeFilename(file)} is not a regular file. ` +
          'Cannot determine its branch — per-branch single-active invariant at risk (ADR-0018 §sub-2). ' +
          'Remove it or replace it with the workflow file.',
      );
    }
    const fmBranch = extractFrontmatterBranch(text);
    if (fmBranch !== null) {
      if (fmBranch === branch) addPhysicalMatch(matching, file);
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
      addPhysicalMatch(matching, file);
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

// The active workflow on `branch` under one state root, both homes.
async function findActiveWorkflowByBranchInRoot(root, branch) {
  // With legacy_homes off, the canonical home only; no legacy probe, no
  // dual-home ambiguity error.
  const canonical = await findActiveWorkflowByBranchInDir(
    workflowDir(root, { home: 'canonical' }),
    branch,
  );
  if (!capabilityOn('legacy_homes')) return canonical;
  const legacy = await findActiveWorkflowByBranchInDir(
    workflowDir(root, { home: 'legacy' }),
    branch,
  );
  // Both homes holding it is the dual-home ambiguity even when one home links
  // to the other: writes there are refused (resolveWorkflowStorage), and the
  // runtime readers report it the same way (ADR-0067 Decision 4, item 1).
  if (canonical && legacy) {
    throw new Error(
      `Ambiguous ${personaName()} workflow storage: both ${workflowDirRel()} and ` +
        `${legacyStateDirRel()}/workflows contain an active workflow on branch ` +
        `${JSON.stringify(branch)}. Reconcile or migrate before continuing.`,
    );
  }
  return canonical ?? legacy;
}

// The active workflow on `branch` across `roots`. One physical file reached
// twice counts once, under the name that is not a link, as within a home; two
// distinct files are an error naming both, never a choice (ADR-0067 Decision
// 4, item 2).
async function findActiveWorkflowByBranchInRoots(roots, branch) {
  const found = [];
  for (const root of roots) {
    const file = await findActiveWorkflowByBranchInRoot(root, branch);
    if (file) addPhysicalMatch(found, file);
  }
  if (found.length <= 1) return found[0] ?? null;
  throw new Error(
    `Ambiguous ${personaName()} workflow storage: ${found.length} active workflows on branch ` +
      `${JSON.stringify(branch)}: ${found.map((f) => JSON.stringify(f)).join(', ')}. One active workflow per ` +
      'branch holds across the state root and every checkout (ADR-0018 §sub-2, ADR-0067 Decision 1(a)): ' +
      'finish, finalize or archive one of them (docs/runbooks/state-root-cutover.md).',
  );
}

export async function findActiveWorkflowByBranch(repoRoot, branch) {
  if (!branch) return null;
  return findActiveWorkflowByBranchInRoots(lookupRoots(repoRoot), branch);
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

// ADR-0067 Decision 4, item 2 — the workflow file `<id>.md` in the workflows
// homes of the checkout's read set, the default state root's first, or null
// when none holds it. Two files holding the id are an error naming both, never
// a choice; an entry in the id's place that is not a regular file refuses too.
export async function resolveWorkflowById(repoRoot, workflowId) {
  const shape = new RegExp(`^(${[...VALID_VERBS].join('|')})-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$`);
  if (typeof workflowId !== 'string' || !shape.test(workflowId)) {
    throw new Error(`not a ${personaName()} workflow id: ${JSON.stringify(workflowId)}`);
  }
  const found = [];
  for (const root of lookupRoots(repoRoot)) {
    for (const home of homeNames()) {
      const candidate = workflowFilePath(root, workflowId, { home });
      const problem = workflowEntryProblem(candidate);
      if (problem === 'gone') continue;
      if (problem !== null) {
        throw new Error(`${personaName()} workflow storage: ${JSON.stringify(candidate)} is ${problem} (ADR-0067 Decision 4, item 1).`);
      }
      addPhysicalMatch(found, candidate);
    }
  }
  if (found.length > 1) {
    throw new Error(
      `Ambiguous ${personaName()} workflow storage: workflow ${workflowId} is held by ${found.length} files: ` +
        `${found.map((f) => JSON.stringify(f)).join(', ')} (ADR-0067 Decision 4, item 2).`,
    );
  }
  return found[0] ?? null;
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
const DISPATCHED_KEYS = Object.freeze(['dispatched_branch', 'dispatched_verb', 'dispatched_profile', 'dispatched_topic']);
// `verify_attempt` binds the step that last wrote the workflow under an
// autopilot run to the handoff it left (admitAttempt), and outlives the
// request itself: a request and its results go when a verb ends with
// another next step, the mark does not.
const VERIFY_RECORD_KEYS = Object.freeze(['verify_request', 'verify_results']);
const VERIFY_KEYS = Object.freeze(['verify_attempt', 'verify_handoff', ...VERIFY_RECORD_KEYS]);
const PERSONA_OPERATIONS_KEY = 'persona_operations';
// The JSON-document scalars: decoded at parse, encoded at serialize.
const JSON_DOCUMENT_KEYS = Object.freeze([...VERIFY_KEYS, PERSONA_OPERATIONS_KEY]);
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
    // ADR-0067 Decision 4, item 5 — the selection /orchestrator:next's Phase 1
    // made, recorded at create beside the parent linkage and immutable: every
    // path that binds this workflow to its subtask compares it. Flat scalars
    // at the tail, as parent_workflow_path, for the same carrier reason.
    order.push(...DISPATCHED_KEYS);
  }
  // ADR-0067 Decision 8 — the run id a conflict gate records. Last of all,
  // for the same carrier reason: a reader that does not know it re-emits it
  // after every key it knows, so its write leaves it in place.
  order.push('awaiting_owner_run_id');
  // ADR-0068 Decision 5 — a step's request for checks and the driver's results
  // against it: one JSON document each, in a double-quoted scalar, after every
  // other key, so a reader that does not know them carries them through its
  // forward-compat carrier byte for byte once the next step is no longer
  // `verify` (lib/verify.mjs).
  order.push(...VERIFY_KEYS);
  // ADR-0068 Decision 2, item 9 (implementation note of 2026-10-25, N4) —
  // the persona operations open on a macro's child: one JSON document in a
  // double-quoted scalar, last of all, so a reader that does not know it
  // (an earlier release, or a persona with dispatch_target off) carries it
  // through its forward-compat carrier byte for byte.
  if (capabilityOn('dispatch_target')) order.push(PERSONA_OPERATIONS_KEY);
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

    if (JSON_DOCUMENT_KEYS.includes(key)) {
      // ADR-0068 Decisions 2 and 5 — a JSON document in one double-quoted scalar.
      lines.push(`${key}: ${yamlScalar(JSON.stringify(value))}`);
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

  // ADR-0068 Decisions 2 and 5 — the verify scalars and the persona
  // operations hold JSON documents; the validator below reads the decoded
  // objects. Only a key this persona knows is decoded: with dispatch_target
  // off, persona_operations stays in the carrier, opaque.
  for (const key of JSON_DOCUMENT_KEYS) {
    if (!(key in fm)) continue;
    if (typeof fm[key] !== 'string') throw new Error(`${key} must be a JSON document in a double-quoted scalar`);
    try {
      fm[key] = JSON.parse(fm[key]);
    } catch (err) {
      throw new Error(`${key} is not JSON (${err.message})`);
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
    // ADR-0067 Decision 4, item 5 — the four are recorded together, as
    // strings; the branch and verb are never empty (an empty profile or topic
    // is a subtask without one).
    const dispatched = DISPATCHED_KEYS.filter((key) => key in fm);
    if (dispatched.length > 0) {
      if (dispatched.length !== DISPATCHED_KEYS.length) {
        throw new Error(`${DISPATCHED_KEYS.join(', ')} are recorded together or not at all`);
      }
      for (const key of DISPATCHED_KEYS) {
        if (typeof fm[key] !== 'string') throw new Error(`${key} must be a string`);
      }
      if (fm.dispatched_branch.length === 0 || fm.dispatched_verb.length === 0) {
        throw new Error('dispatched_branch and dispatched_verb must be non-empty strings');
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
  validateNextStepFields(fm);
  validateAwaitingOwnerFields(fm);
  validateVerifyFields(fm);
  if (PERSONA_OPERATIONS_KEY in fm) validatePersonaOperations(fm[PERSONA_OPERATIONS_KEY]);
}

// ADR-0068 Decision 2 (implementation note of 2026-10-25, N4) — the open
// persona operations of a macro's child: `{v: 1, ops: [{id, kind, opened_at,
// ext}]}`. A document of a later version (`v` above 1) is carried as read,
// never interpreted: the operation commands refuse beside it.
export const PERSONA_OPERATIONS_VERSION = 1;
const PERSONA_OPERATION_KINDS = new Set(['verb', 'commit', 'checkpoint', 'gate', 'peer', 'resume', 'archive']);
function validatePersonaOperations(doc) {
  const where = PERSONA_OPERATIONS_KEY;
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc) || !Number.isInteger(doc.v) || doc.v < 1) {
    throw new Error(`${where} must be a document {v, ops} with a positive integer v`);
  }
  if (doc.v > PERSONA_OPERATIONS_VERSION) return;
  for (const k of Object.keys(doc)) {
    if (k !== 'v' && k !== 'ops') throw new Error(`${where}: unknown field ${JSON.stringify(k)} (expected v, ops)`);
  }
  if (!Array.isArray(doc.ops)) throw new Error(`${where}.ops must be a list`);
  const ids = new Set();
  for (const [i, op] of doc.ops.entries()) {
    const at = `${where}.ops[${i}]`;
    if (op === null || typeof op !== 'object' || Array.isArray(op)) throw new Error(`${at} must be an object`);
    for (const k of Object.keys(op)) {
      if (!['id', 'kind', 'opened_at', 'ext'].includes(k)) throw new Error(`${at}: unknown field ${JSON.stringify(k)}`);
    }
    if (typeof op.id !== 'string' || !OPERATION_ID_RE.test(op.id)) throw new Error(`${at}.id is not an operation id (op-<yyyymmddThhmmssZ>-<8 hex>)`);
    if (ids.has(op.id)) throw new Error(`${at}.id ${op.id} is listed twice`);
    ids.add(op.id);
    if (!PERSONA_OPERATION_KINDS.has(op.kind)) throw new Error(`${at}.kind must be one of ${[...PERSONA_OPERATION_KINDS].join(', ')}`);
    validateIsoUtc(`${at}.opened_at`, op.opened_at);
    if (typeof op.ext !== 'boolean') throw new Error(`${at}.ext must be true or false`);
  }
}

// The next step's own keys: each enum, and how they pair. A proposal is
// checked with this alone before a lock is taken; the whole record, the
// request a `verify` step needs included, is checked once it is assembled.
function validateNextStepFields(fm) {
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
}

function validateAwaitingOwnerFields(fm) {
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
  // ADR-0067 Decision 8 — the run id a conflict gate records. Only its form
  // is a read error. That it sits with a conflict gate is a writer's rule
  // and decides whether a consensus task file is current, never whether the
  // file reads: a pre-CP script carries the key through its forward-compat
  // carrier while it clears or re-sets the gate (ADR-0067 Decision 4,
  // item 3), and such a file must still read.
  if ('awaiting_owner_run_id' in fm && !isSafeConsensusRunId(fm.awaiting_owner_run_id)) {
    throw new Error(
      'awaiting_owner_run_id must be a run id of [A-Za-z0-9_-] starting with a letter or digit, ' +
        `at most 128 characters (got ${JSON.stringify(fm.awaiting_owner_run_id)}) (ADR-0067 Decision 8)`,
    );
  }
}

/**
 * ADR-0068 Decision 5 — the request and its results. Each holds its own
 * shape (lib/verify.mjs), and together with the next step:
 * - `next_step_kind: verify` needs `verify_request`, not yet answered, whose
 *   confidence is the next step's;
 * - `verify_request` is this workflow's: its `workflow_id` is the one holding
 *   it, so no record moved from another workflow reads as evidence here;
 * - `verify_results` are the results of `verify_request`, never of another;
 * - `verify_attempt` is never older than `verify_request`'s run and step (the
 *   mark moves on with each write of a later attempt, and stays after the
 *   request goes); while the request is pending and the mark names its step,
 *   it records that step as the one that recorded a request. A later step's
 *   write moves the mark on past a pending request (Phase 7 entered again, a
 *   gate set), so a late retry of the request is older than the mark.
 * A request left beside another next step stays readable: the verb the
 * driver resumes reads its results. A record a later release wrote (a higher
 * `v`, lib/verify.mjs header) is carried unchecked, and so is every rule that
 * reads it.
 */
function validateVerifyFields(fm) {
  const current = (key) => key in fm && !isNewerRecord(fm[key]);
  if (current('verify_attempt')) validateStoredAttempt(fm.verify_attempt);
  if (current('verify_handoff')) validateStoredHandoff(fm.verify_handoff);
  if (current('verify_request')) validateStoredRequest(fm.verify_request, { verbs: VALID_VERBS });
  if (current('verify_results')) validateStoredResults(fm.verify_results);
  if (current('verify_request') && fm.verify_request.workflow_id !== fm.workflow_id) {
    throw new Error(
      `verify_request is workflow ${fm.verify_request.workflow_id}'s, not ${fm.workflow_id}'s, the workflow holding it: ` +
        'a request and its results are read only in their own workflow (ADR-0068 Decision 5)',
    );
  }
  if (current('verify_request') && !isNewerRecord(fm.verify_attempt)) {
    const mark = fm.verify_attempt;
    const req = fm.verify_request;
    const order = mark ? compareAttempts(req, mark) : Number.NaN;
    const pending = fm.next_step_kind === 'verify';
    if (!(order <= 0) || (pending && order === 0 && mark.requested !== true)) {
      throw new Error(
        `verify_attempt (${mark ? `${mark.run_id} ${mark.step === undefined ? 'with no step' : `step ${mark.step}`}` : 'none'}) ${order === 0 ? 'names the step of' : 'is older than'} verify_request ` +
          `(${req.run_id} step ${req.step}) (ADR-0068 Decision 5)`,
      );
    }
  }
  if (fm.next_step_kind === 'verify') {
    if (!('verify_request' in fm)) {
      throw new Error('next_step_kind verify needs verify_request, the checks it asks for (ADR-0068 Decision 5)');
    }
    if (current('verify_request') && fm.verify_request.answered_by !== undefined) {
      throw new Error(`next_step_kind verify names request ${fm.verify_request.id}, which batch ${fm.verify_request.answered_by} already answered`);
    }
    if (current('verify_request') && fm.verify_request.confidence !== fm.next_step_confidence) {
      throw new Error(
        `next_step_confidence ${fm.next_step_confidence} is not the confidence of request ${fm.verify_request.id} ` +
          `(${fm.verify_request.confidence}): the next step verify is the request's (ADR-0068 Decision 5)`,
      );
    }
  }
  if (current('verify_results') && !isNewerRecord(fm.verify_request)) {
    if (!('verify_request' in fm) || fm.verify_results.request_id !== fm.verify_request.id) {
      throw new Error(
        `verify_results are for request ${fm.verify_results.request_id}, which is not this workflow's verify_request ` +
          `(${fm.verify_request?.id ?? 'none'}): results are never read as another request's (ADR-0068 Decision 5, item 5)`,
      );
    }
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
  // ADR-0068 Decision 5 — every workflow write turns its record into text
  // here, so the handoff generation moves on here, for every writer
  // (stampHandoff, lib/verify.mjs header).
  stampHandoff(frontmatter);
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

// The host, checked (validateHost), for a writer that takes it optionally.
const validHost = (host) => {
  validateHost(host);
  return host;
};

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
  // ADR-0067 Decision 4, item 5 — the selection /orchestrator:next's Phase 1
  // made ({subtask, branch, verb, profile, topic}; AGENTIC_DISPATCH_SELECTION,
  // forwarded as a CLI flag), recorded beside the two ids. Optional: an older
  // orchestrator exports none. Valid only with both ids.
  dispatchSelection,
  // ADR-0020 PR 2 — workflow-shape discriminator. Always-written at
  // create-time (default 'verb-chain') so every new workflow is
  // self-describing. workflow_type is a primary discriminator, not a
  // presence flag; the persona's `start` macro passes 'start'.
  workflowType = 'verb-chain',
  // ADR-0068 Decision 5, item 7 — the step's environment: a workflow created
  // under an autopilot run records the creating step's attempt mark with it.
  env = process.env,
  now = new Date(),
  // ADR-0068 Decision 2 (N4) — the operation the bootstrap opens, from
  // createWorkflow (prepareOperation): it joins the child in this write.
  operation = NO_OPERATION,
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
  // resolver variant to avoid deadlock against ourselves. ADR-0067
  // Decision 2: across the repository — the read set, the root the record
  // goes to, and the own homes of every other worktree.
  assertAbsoluteRepoRoot(repoRoot);
  const storage = ownership?.storage ?? await resolveWorkflowStorage(repoRoot, { mode: 'write' });
  const searched = [...lookupRoots(repoRoot)];
  for (const root of [storage.stateRoot, ...otherWorktreeRoots(repoRoot)]) {
    if (!searched.some((r) => sameDirectory(r, root))) searched.push(root);
  }
  const existing = await findActiveWorkflowByBranchInRoots(searched, gitBaseline.branch);
  if (existing) {
    throw new Error(
      `Cannot create workflow — a workflow already exists on branch '${gitBaseline.branch}' (${existing}). ` +
        `Per-branch single-active invariant (ADR-0018 §sub-2, across the repository: ADR-0067 Decision 2). ` +
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
    dispatchSelection = undefined;
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
  // ADR-0067 Decision 4, item 5 — the selection names the subtask the ids
  // name, the branch this workflow is created on and the verb it is created
  // by: a dispatcher that says otherwise is refused before the file lands.
  if (dispatchSelection !== undefined && dispatchSelection !== null) {
    if (!('parent_workflow' in frontmatter)) {
      throw new Error(
        'the dispatch selection is valid only with parent_workflow and originating_subtask (ADR-0067 Decision 4, item 5)',
      );
    }
    const problem = dispatchSelectionProblem(dispatchSelection, {
      subtask: frontmatter.originating_subtask, branch: gitBaseline.branch, verb,
    });
    if (problem) {
      throw new Error(`the dispatch selection ${problem} (ADR-0067 Decision 4, item 5)`);
    }
    frontmatter.dispatched_branch = dispatchSelection.branch;
    frontmatter.dispatched_verb = dispatchSelection.verb;
    frontmatter.dispatched_profile = dispatchSelection.profile ?? '';
    frontmatter.dispatched_topic = dispatchSelection.topic ?? '';
  }
  // ADR-0020 Sub-decision 6 — a /start lifecycle is engineer-internal and
  // never a dispatched child; in a macro a hold-aware orchestrator runs for
  // (N2), one made a child by hand would write it outside any persona
  // operation (ADR-0068 Decision 2, item 7), so it is refused there.
  if (workflowType === 'start' && 'parent_workflow' in frontmatter && isSafeMacroId(frontmatter.parent_workflow)) {
    const activation = readActivation(holdsMainRoot(repoRoot), frontmatter.parent_workflow);
    if (activation.state !== 'inactive') {
      throw new Error(
        `Cannot create workflow — a /start lifecycle is never a macro's child (ADR-0020 Sub-decision 6), and in ` +
          `${frontmatter.parent_workflow}, which a hold-aware orchestrator runs for (${activation.state}: ${activation.path}), ` +
          `it would write the child outside any persona operation (ADR-0068 Decision 2, item 7). Create it with no ` +
          `parent linkage, or as the verb the dispatch names. Nothing was written.`,
      );
    }
  }

  const title = bodyTitle ?? `${persona}:${verb}`;
  const body =
    `# ${title}\n\n` +
    `## Original Request\n\n` +
    `${scrubbedRequest || '(no original request recorded)'}\n\n` +
    `## Phase notes\n\n` +
    `### ${currentPhase}\n\n`;

  const filePath = join(storage.workflows, `${workflowId}.md`);
  await ensureDir(storage.workflows, 0o700);
  // A step's first write binds it (admitAttempt): the creation, a verb's
  // bootstrap Phase 0, records the mark in the same write, so a delayed write
  // of the creating step is held to the handoff it left like any other. It is
  // admitted first against the workflows archived on the branch (admitCreation).
  const attempt = verifyAttemptOf({ env, host });
  if (attempt !== null) await admitCreation(searched, gitBaseline.branch, attempt);
  if (attempt !== null) markAttempt(frontmatter, { attempt, before: handoffState(frontmatter), bound: false, mark: undefined });
  operation.inLock(frontmatter);
  // ADR-0068 Decision 2, item 5 — read again once the workflow is published,
  // holding its lock: a hold set after createWorkflow's first read and before
  // this one withdraws it, so a hold that misses the workflow is one set after
  // it was there to be seen.
  await withFileLock(filePath, async () => {
    await atomicWrite(filePath, assembleWorkflowFile(frontmatter, body), ownership);
    try {
      assertNotUnlinkedInHeldLane(repoRoot, gitBaseline.branch, frontmatter);
      // Item 7 — a linked bootstrap is its operation's first write: one with
      // none (an earlier runbook, a create by hand) is refused in a held lane.
      const refusal = laneWriterRefusal(filePath, frontmatter, { writer: writerOf(operation) });
      if (refusal !== null) throw laneWriterError(refusal);
    } catch (err) {
      await unlink(filePath);
      throw err;
    }
  }, { env, host, hold: false, writer: LANE_WRITERS.create });

  return { workflowId, filePath, frontmatter, body };
}

/**
 * Decision 2, item 5 — refuses a bootstrap of `branch` that carries no
 * dispatch linkage to the lane holding it (heldLaneOfBranch): every bootstrap
 * of designer and founder, and an engineer's with none or another lane's.
 * Inert where no hold-aware orchestrator runs (N2, item 9); refused while a
 * holds directory or record that may hold the branch cannot be read (item 8).
 */
function assertNotUnlinkedInHeldLane(repoRoot, branch, { parent_workflow: macroId, originating_subtask: subtaskId }) {
  const linked = capabilityOn('dispatch_target') && isSafeMacroId(macroId) && isSafeSubtaskId(subtaskId)
    ? { macroId, subtaskId }
    : null;
  const lane = heldLaneOfBranch(holdsMainRoot(repoRoot), branch, { linked });
  if (lane.state === 'held') {
    throw new Error(
      `Cannot create workflow — branch '${branch}' is a held lane of ${lane.macroId} (subtask ${lane.subtaskId}: ` +
        `${lane.why}), and a workflow begun there with no dispatch linkage is one the driver could not resume ` +
        `(ADR-0068 Decision 2, item 5). Work the lane's active child, when it has one; otherwise work the lane by ` +
        `hand (a commit, a push), or have the owner release it for the driver ` +
        `(release ${lane.subtaskId} --hold ${lane.holdId}). Nothing was written.`,
    );
  }
  if (lane.state === 'unreadable') {
    throw new Error(
      `Cannot create workflow on branch '${branch}' — ${lane.path} cannot be read (${lane.error}), so whether the ` +
        `branch is a held lane cannot be told (ADR-0068 Decision 2, items 5 and 8). Run it again once it reads; ` +
        `an owner's record that cannot be read is the owner's to discard ` +
        `(release <subtask-id> --discard-unreadable). Nothing was written.`,
    );
  }
}

// What is wrong with a dispatch selection for a workflow created for
// `expected` ({subtask, branch, verb}), or null.
function dispatchSelectionProblem(selection, expected) {
  if (typeof selection !== 'object' || selection === null || Array.isArray(selection)) {
    return 'must be an object';
  }
  const allowed = ['subtask', 'branch', 'verb', 'profile', 'topic'];
  for (const [key, value] of Object.entries(selection)) {
    if (!allowed.includes(key)) return `has unknown key ${JSON.stringify(key)} (allowed: ${allowed.join(', ')})`;
    if (typeof value !== 'string') return `has a ${key} that is not a string`;
  }
  for (const key of ['subtask', 'branch', 'verb']) {
    if (selection[key] !== expected[key]) {
      return `names ${key} ${JSON.stringify(selection[key] ?? null)}, but this workflow is created for ${JSON.stringify(expected[key])}`;
    }
  }
  return null;
}

// ADR-0067 Decision 3 — the state root holding the macro a dispatched child
// names: the recorded path's, or the first root of the read set whose
// orchestrator workflows home holds `<id>.md`; null when neither does.
function macroStateRoot(repoRoot, parentWorkflow, parentWorkflowPath) {
  const homes = ['.agentic-plugins/state/orchestrator/workflows', '.claude/agentic-orchestrator/workflows'];
  if (typeof parentWorkflowPath === 'string' && parentWorkflowPath.length > 0) {
    for (const rel of homes) {
      const suffix = `/${rel}/${basename(parentWorkflowPath)}`;
      if (parentWorkflowPath.endsWith(suffix)) return parentWorkflowPath.slice(0, -suffix.length);
    }
  }
  if (typeof parentWorkflow !== 'string' || parentWorkflow.length === 0) return null;
  for (const root of lookupRoots(repoRoot)) {
    for (const rel of homes) {
      try {
        if (statSync(join(root, rel, `${parentWorkflow}.md`)).isFile()) return root;
      } catch {
        /* absent here */
      }
    }
  }
  return null;
}

/**
 * Where `createWorkflow` puts a new record (ADR-0067 Decisions 1(a), 3): the
 * checkout while shared creation is off; once it is on, AGENTIC_STATE_BASE,
 * else the default state root — except a dispatched child, which goes beside
 * its macro. Throws on an unreadable switch or a refused AGENTIC_STATE_BASE.
 */
export function creationPlacement({ repoRoot, parentWorkflow, parentWorkflowPath, env = process.env }) {
  assertAbsoluteRepoRoot(repoRoot);
  const placement = creationRoot(repoRoot, { env });
  if (placement.sharedCreation === 'on' && capabilityOn('dispatch_target') && parentWorkflow) {
    const beside = macroStateRoot(repoRoot, parentWorkflow, parentWorkflowPath);
    if (beside) return { ...placement, root: beside };
  }
  return placement;
}

export async function createWorkflow({ operationDir, operationKind = 'verb', ...args }) {
  // ADR-0068 Decision 2, item 5 — a bootstrap with no dispatch linkage in a
  // held lane is refused before anything is published: the driver could not
  // resume a workflow it does not know. A linked bootstrap continues its own
  // lane's dispatch, admitted as its operation (N4). Read again once the
  // workflow is written (createWorkflowUnderLock).
  assertNotUnlinkedInHeldLane(args.repoRoot, args.gitBaseline?.branch, {
    parent_workflow: args.parentWorkflow, originating_subtask: args.originatingSubtask,
  });
  const placement = creationPlacement(args);
  const storage = await resolveWorkflowStorage(placement.root, { mode: 'write' });
  // ADR-0068 Decision 2 (N4, N5) — a bootstrap of a macro's child opens its
  // operation: its record is published before the creation locks are taken,
  // and withdrawn after they are released when the create is refused.
  const operation = await prepareOperation({
    point: 'open', kind: operationKind, operationDir, host: args.host, env: args.env ?? process.env, now: args.now ?? new Date(),
    create: {
      repoRoot: args.repoRoot, parentWorkflow: args.parentWorkflow, originatingSubtask: args.originatingSubtask, branch: args.gitBaseline?.branch,
    },
  });
  return withOperation(operation, () => withCreationLocks(storage, ({ lockPath, token, outer }) =>
    createWorkflowUnderLock({ ...args, operation }, { lockPath, token, outer, storage }),
  ));
}

// -----------------------------------------------------------------------------
// ADR-0063 D6 — next_step write support
//
// A write replaces all three `next_step_*` keys at once, so a stale
// `next_step_verb` never outlives a change of kind. The input is checked with
// the same validator the parser runs, before the file lock is taken.

const NEXT_STEP_KEYS = ['next_step_kind', 'next_step_verb', 'next_step_confidence'];

function normalizeNextStep(nextStep, { allowVerify = false } = {}) {
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
  validateNextStepFields(fields);
  // ADR-0068 Decision 5, item 11 — `verify` is written only with its request,
  // by finish-verb under a run that offers verification; no other writer
  // (append, set-terminal, awaiting-owner-clear) records it.
  if (fields.next_step_kind === 'verify' && !allowVerify) {
    throw new Error(
      'next step verify is written only by finish-verb --verify-request-file, in a step of an autopilot run that ' +
        'offers verification (ADR-0068 Decision 5, item 11)',
    );
  }
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

// `dropVerify` (finish-verb with a kind other than verify): the verb ends
// with no request, so the last request and its results go with the write
// (ADR-0068 Decision 5, item 7: a verb's own next step replaces them). The
// attempt mark stays: it is what refuses a late retry of the dropped request.
// The write is held to the mark at its lock and moves it on once the whole
// handoff it leaves is known (withFileLock, writeWorkflow).
function applyNextStepWrite(frontmatter, write, { dropVerify = false } = {}) {
  if (write === null) return;
  for (const k of NEXT_STEP_KEYS) delete frontmatter[k];
  Object.assign(frontmatter, write);
  if (dropVerify) for (const k of VERIFY_RECORD_KEYS) delete frontmatter[k];
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
  // finish-verb's: a verb that ends with another next step than verify drops
  // the last request and its results in the same write (ADR-0068 Decision 5).
  dropVerifyRequest = false,
  event = 'resumed',
  // ADR-0068 Decision 2 (N4) — the command's operation directory, and whether
  // this write opens its operation (`openOperation`, the kind) or closes it
  // (`closeOperation`). Without a directory the write is as before.
  operationDir,
  openOperation,
  closeOperation = false,
  // N4 — or a point of a child operation (`{ point, kind }`,
  // prepareChildOperation): the staging-set gate an autopilot commit records
  // is its operation's one write.
  childOperation,
  // The step's environment: under an autopilot run, every write of a
  // workflow is held to the attempt mark (withFileLock, ADR-0068 Decision 5).
  env = process.env,
  now = new Date(),
}) {
  validateHost(host);
  validateHookEvent(event);
  if (verb !== undefined) validateVerb(verb);
  if (openOperation !== undefined && closeOperation) {
    throw new Error('a write opens its operation or closes it, not both');
  }
  if (childOperation !== undefined && (openOperation !== undefined || closeOperation || operationDir !== undefined)) {
    throw new Error('a write takes an operation directory or a child operation, not both');
  }
  if (typeof clearTerminalMarker !== 'boolean') {
    throw new Error(`clearTerminalMarker must be a boolean (got ${typeof clearTerminalMarker})`);
  }
  const nextStepWrite = resolveNextStepWrite(nextStep, clearNextStep);
  const gateFields = ownerGate === undefined ? null : resolveOwnerGateFields({ workflowPath, ownerGate, now });
  const operation = childOperation !== undefined
    ? await prepareChildOperation({ ...childOperation, workflowPath, host, env, now })
    : openOperation !== undefined || closeOperation
      ? await prepareOperation({
        point: closeOperation ? 'close' : 'open', kind: openOperation, operationDir, workflowPath, host, env, now,
      })
      : NO_OPERATION;

  return withOperation(operation, () => withFileLock(workflowPath, async (ownership) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    const nowIso = isoUtc(now);
    operation.inLock(frontmatter);

    if (verb !== undefined) frontmatter.verb = verb;
    if (profile !== undefined) frontmatter.profile = profile;
    if (currentPhase !== undefined) frontmatter.current_phase = currentPhase;
    if (nextAction !== undefined) frontmatter.next_action = nextAction;
    applyNextStepWrite(frontmatter, nextStepWrite, { dropVerify: dropVerifyRequest });
    const replacedRunId = gateFields ? applyOwnerGate(frontmatter, gateFields) : null;
    if (clearTerminalMarker && frontmatter.terminal_marker === true) frontmatter.terminal_marker = false;
    frontmatter.updated_at = nowIso;
    frontmatter.host_history = [
      ...(frontmatter.host_history ?? []),
      { host, at: nowIso, event },
    ];

    const heading = phaseLabel ? `### ${phaseLabel}\n\n` : '';
    const note = phaseNote ? `${phaseNote}\n\n` : '';
    // C120 — a write that names the critique verb starts a critique run, and
    // the review ledger counts the runs from this line (lib/review-scope.mjs
    // critiqueEntries), whether or not the run reached critique-scope.
    const run = verb === 'critique' ? `${CRITIQUE_RUN_MARKER}\n${heading === '' && note === '' ? '\n' : ''}` : '';
    const newBody = appendToBody(body, `${run}${heading}${note}`);

    await writeWorkflow(workflowPath, frontmatter, newBody, ownership, { nextStep: nextStepWrite !== null });
    // ADR-0067 Decision 8 — a gate set again over itself that names another
    // run, or none, retires the task file of the run it replaced.
    const retired = replacedRunId === null
      ? { retired: null, warning: null }
      : await retireConsensusTask(workflowPath, frontmatter.workflow_id, replacedRunId, ownership);
    return { frontmatter, workflowPath, retired };
  }, { env, host, writer: writerOf(operation) }));
}

// -----------------------------------------------------------------------------
// Public API: snapshot — used by hooks per ADR-0011 §4

export async function snapshot({
  workflowPath,
  host,
  trigger,
  statusDigest,
  // As every writer's: the attempt mark (withFileLock, ADR-0068 Decision 5).
  env = process.env,
  now = new Date(),
}) {
  validateHost(host);
  validateSnapshotTrigger(trigger);

  return withFileLock(workflowPath, async (ownership) => {
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

    await writeWorkflow(workflowPath, frontmatter, body, ownership);
    return { frontmatter, workflowPath };
  }, { env, host, writer: LANE_WRITERS.snapshot });
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
  // A pending run is part of the handoff: under an autopilot run the write is
  // held to the attempt mark (withFileLock, ADR-0068 Decision 5).
  host = 'claude',
  env = process.env,
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
  return withFileLock(workflowPath, async (ownership) => {
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
    await writeWorkflow(workflowPath, frontmatter, body, ownership);
    return { frontmatter, workflowPath };
  }, { env, host, writer: LANE_WRITERS.plain });
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
  // As recordPendingEnsemble's: the attempt mark (withFileLock, ADR-0068
  // Decision 5).
  host = 'claude',
  env = process.env,
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
  return withFileLock(workflowPath, async (ownership) => {
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

    await writeWorkflow(workflowPath, frontmatter, body, ownership);
    // `kept`: the entry already recorded for this run id, read under the lock.
    const kept = alreadyCommitted ? existing.find((e) => e.run_id === run_id) : null;
    return { frontmatter, workflowPath, idempotentSkip: alreadyCommitted, kept };
  }, { env, host, writer: LANE_WRITERS.settlement, runId: run_id });
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
  // The staging set Phase 7 reads: under an autopilot run, held to the
  // attempt mark as every write is (withFileLock, ADR-0068 Decision 5), on
  // the caller's host.
  env = process.env,
  host,
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
  return withFileLock(workflowPath, async (ownership) => {
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
    await writeWorkflow(workflowPath, frontmatter, body, ownership);
    return { frontmatter, workflowPath, entry };
  }, { env, ...(host === undefined ? {} : { host: validHost(host) }), writer: LANE_WRITERS.plain });
}

/**
 * ADR-0028 §Layer-2 — append a `{path, phase: 'compose', op, recorded_at}`
 * entry to `commit_manifest`. Called by `commands/compose.md` after a
 * Write/Edit during a workflow-command sub-step; no-ops when
 * `workflowPath` is empty (standalone-invocation boundary).
 */
export async function recordComposedFile({ workflowPath, path, op, recorded_at, now, env, host } = {}) {
  return recordManifestEntry({
    workflowPath,
    path,
    op,
    phase: 'compose',
    recorded_at,
    now,
    env,
    host,
  });
}

/**
 * ADR-0028 §Layer-2 — append a `{path, phase: 'refine', op, recorded_at}`
 * entry to `commit_manifest`. Called by `commands/refine.md` after a
 * Write/Edit during a workflow-command sub-step; no-ops when
 * `workflowPath` is empty (standalone-invocation boundary).
 */
export async function recordRefineFile({ workflowPath, path, op, recorded_at, now, env, host } = {}) {
  return recordManifestEntry({
    workflowPath,
    path,
    op,
    phase: 'refine',
    recorded_at,
    now,
    env,
    host,
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
  // As every writer's: the attempt mark (withFileLock, ADR-0068 Decision 5).
  env = process.env,
  now = new Date(),
}) {
  validateHost(host);
  if (typeof summary !== 'string' || summary.length === 0) {
    throw new Error('setCheckpoint: summary must be a non-empty string');
  }
  // ADR-0068 Decision 2, item 7 — a checkpoint is an operation of one write:
  // admitted as any first write is (one operation at a time in a lane, and
  // none while the holds cannot be read), it leaves no entry.
  const operation = await prepareChildOperation({ point: 'once', kind: 'checkpoint', workflowPath, host, env, now });
  return withOperation(operation, () => withFileLock(workflowPath, async (ownership) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    const nowIso = isoUtc(now);
    operation.inLock(frontmatter);
    frontmatter.latest_checkpoint = { at: nowIso, summary };
    frontmatter.updated_at = nowIso;
    frontmatter.host_history = [
      ...(frontmatter.host_history ?? []),
      { host, at: nowIso, event: 'checkpointed' },
    ];
    await writeWorkflow(workflowPath, frontmatter, body, ownership);
    return { frontmatter, workflowPath };
  }, { env, host, writer: writerOf(operation) }));
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
  // finish-verb's, as appendPhase's (ADR-0068 Decision 5).
  dropVerifyRequest = false,
  event = 'updated',
  // As appendPhase's: the attempt mark (withFileLock, ADR-0068 Decision 5).
  env = process.env,
  now = new Date(),
  // ADR-0031 amendment (decision 1) / ADR-0043 — fire the session-handoff
  // sidecar from this must-run completion mutation. Opt-in by the production
  // completion entry point (the CLI `set-terminal` case), so direct helper
  // calls (tests, internal state setup) never emit. Default off keeps the
  // low-level helper side-effect-free for non-completion callers.
  emitHandoff = false,
  // ADR-0067 Decision 1(a) — the checkout the command runs in, where the
  // sidecar writes the handoff slot and runs git; derived from the working
  // directory when omitted (commandCheckout).
  checkout,
  // ADR-0068 Decision 2, item 6 — finish-verb's: decide, holding the
  // workflow's lock, whether a hold keeps the workflow open (holdKeepsOpen);
  // when it does, the write records the next step and leaves the workflow
  // open, and no terminal handoff is emitted.
  holdAware = false,
  // ADR-0068 Decision 2 (N4) — the command's operation directory: this
  // write, the command's last, closes the operation it names.
  operationDir,
  // N4 — or a point of the commit's operation (`{ point, kind }`,
  // prepareChildOperation): Phase 7's close opens it here, its first write.
  childOperation,
}) {
  validateHost(host);
  validateHookEvent(event);
  if (operationDir !== undefined && childOperation !== undefined) {
    throw new Error('setTerminal takes an operation directory or a child operation, not both');
  }
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
  const operation = childOperation !== undefined
    ? await prepareChildOperation({ ...childOperation, workflowPath, host, env, now })
    : await prepareOperation({ point: 'close', operationDir, workflowPath, host, env, now });
  const result = await withOperation(operation, () => withFileLock(workflowPath, async (ownership) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    const nowIso = isoUtc(now);
    operation.inLock(frontmatter);
    const held = holdAware ? holdKeepsOpenOf(workflowPath, frontmatter) : null;
    if (held === null) {
      frontmatter.current_phase = terminalPhase;
      frontmatter.terminal_marker = terminalMarker;
    } else if (frontmatter.terminal_marker === true) {
      frontmatter.terminal_marker = false;
    }
    if (nextAction !== undefined) frontmatter.next_action = nextAction;
    applyNextStepWrite(frontmatter, nextStepWrite, { dropVerify: dropVerifyRequest });
    frontmatter.updated_at = nowIso;
    frontmatter.host_history = [
      ...(frontmatter.host_history ?? []),
      { host, at: nowIso, event },
    ];
    await writeWorkflow(workflowPath, frontmatter, body, ownership, { nextStep: nextStepWrite !== null });
    return { frontmatter, workflowPath, held };
  }, { env, host, writer: writerOf(operation) }));
  // ADR-0031 amendment (decisions 1, 2, 3, 6) / ADR-0043 §2 — fire the
  // activation sidecar AFTER the terminal mutation succeeded AND the file lock
  // was released (the `withFileLock` above has resolved). Fail-closed +
  // non-fatal: any error is swallowed here so a completion can never fail
  // because of the handoff, and the sidecar itself writes only stderr + a
  // projection file, never stdout. Gated on `terminalMarker === true`
  // (orchestrator parity, Codex Plan-verify): un-marking a workflow
  // (`--terminal-marker false`) is not a terminal transition and must not
  // emit a terminal handoff.
  if (emitHandoff && terminalMarker === true && result.held === null) {
    try {
      // Resolve a relative --workflow-path before home inference — the
      // canonical-needle match requires an absolute spelling, and a relative
      // path would otherwise mutate successfully but silently skip the
      // sidecar (Codex Plan-verify edge case).
      const absWorkflowPath = isAbsolute(workflowPath) ? workflowPath : resolvePath(workflowPath);
      const inferred = inferStorageFromWorkflowPath(absWorkflowPath);
      if (inferred) {
        // ADR-0067 Decision 1(a), 4 item 2 — the slot belongs to the checkout
        // the command runs in, not to the root that holds the record: two
        // lanes sharing one state root would overwrite each other's. Git
        // facts come from that checkout too (Decision 1(b)).
        const { stateRoot, home } = inferred;
        const repoRoot = checkout ?? commandCheckout(stateRoot);
        // A checkout that cannot be told writes no slot: the storage root's
        // would be another checkout's (ADR-0067 Decision 1(a)).
        if (repoRoot === null) {
          process.stderr.write(
            `${personaName()}: handoff slot not written: the checkout this command runs in cannot be told ` +
              '(git failed); the terminal write has landed (ADR-0067 Decision 1(a)).\n',
          );
          return result;
        }
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

// The keys a gate's clear removes: the three ADR-0063 D6 keys and the run id
// a conflict gate records (ADR-0067 Decision 8).
const AWAITING_OWNER_KEYS = ['awaiting_owner_gate', 'awaiting_owner_since', 'awaiting_owner_pointer', 'awaiting_owner_run_id'];

// -----------------------------------------------------------------------------
// ADR-0067 Decision 8 — the consensus task file of a conflict gate
//
// A synthesis verdict of conflict in decide, critique or investigate ends the
// verb on its conflict gate with a bounded consensus round proposed before the
// owner decides. The verb writes the contested items to
// `<home>/consensus/<workflow-id>.<run-id>.md`, in the workflow's own home
// (never a lane's), where `runtime:consensus plan --task-file` reads them. The
// gate records the run id; the file is current only while the gate names that
// run, the workflow's ensemble_results holds the run with verdict conflict,
// and the file exists. Every way the gate leaves retires the file: it is
// renamed `<workflow-id>.<run-id>.resolved.md` and kept as evidence. Nothing
// here runs the consensus round: the owner does.

// A workflow id as a task file's name carries it: a plain name, no `/` and
// no `.` (generated ids hold neither), so the name stays in consensus/ and
// splits one way only.
const CONSENSUS_WORKFLOW_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// Where a workflow's task file for a run lives, from the home the workflow
// file sits in. Null when the path is under no state home or an id is not a
// plain name.
function consensusTaskPaths(workflowPath, workflowId, runId) {
  if (!isSafeConsensusRunId(runId) || typeof workflowId !== 'string' || !CONSENSUS_WORKFLOW_ID_RE.test(workflowId)) {
    return null;
  }
  const storage = inferStorageFromWorkflowPath(resolvePath(String(workflowPath)));
  if (!storage || storage.stateRoot.length === 0) return null;
  const { consensus, consensusDirRel } = statePaths(storage.stateRoot, storage.home);
  const name = `${workflowId}.${runId}`;
  // Containment, besides the alphabets: the file sits directly in consensus/.
  if (dirname(join(consensus, `${name}.md`)) !== consensus) return null;
  return {
    dir: consensus,
    file: join(consensus, `${name}.md`),
    resolved: join(consensus, `${name}.resolved.md`),
    // ADR-0067 Decision 1(c): a pointer is relative to the state root.
    pointer: `${consensusDirRel}/${name}.md`,
  };
}

// Whether the workflow's lock still holds this writer's token, read again just
// before a task file is moved, as atomicWrite does before its commit: a writer
// whose lock was reclaimed as stale never retires a file the new owner made
// current.
async function holdsLock({ lockPath, token }) {
  return (await readFile(lockPath, 'utf8').catch(() => null)) === token;
}

// A move of a file kept beside the workflow (its review ledger), made only
// while the workflow's lock is still this writer's: a writer whose lock was
// reclaimed as stale never moves away the file the new owner made current.
async function renameHeld(from, to, ownership) {
  if (!(await holdsLock(ownership))) {
    throw new Error(`the lock on the workflow was reclaimed as stale by another writer: ${from} is not moved`);
  }
  await rename(from, to);
}

// Rename a task file to its `.resolved.md` name, once the write that took its
// gate away has landed, holding the workflow's lock (`ownership`, as
// withFileLock gives it). Best effort: an absent file is nothing to retire,
// and a lost lock or a failed rename is a warning, never an error — the gate
// no longer names the run, so the file is no longer current whatever its name.
export async function retireConsensusTask(workflowPath, workflowId, runId, ownership) {
  const paths = consensusTaskPaths(workflowPath, workflowId, runId);
  if (!paths) return { retired: null, warning: null };
  if (!(await holdsLock(ownership))) {
    return {
      retired: null,
      warning: `the consensus task file ${paths.file} was not retired: another writer reclaimed the lock on the workflow`,
    };
  }
  try {
    await rename(paths.file, paths.resolved);
    return { retired: paths.resolved, warning: null };
  } catch (err) {
    if (err.code === 'ENOENT') return { retired: null, warning: null };
    return {
      retired: null,
      warning: `the consensus task file ${paths.file} could not be retired (${err.code ?? err.message}); its gate no longer names run ${runId}, so it is not current`,
    };
  }
}

/**
 * ADR-0067 Decision 8 — write the contested items of a conflict as the
 * workflow's consensus task file for that run, and return its absolute path.
 * Under the workflow's lock, the run must be recorded in `ensemble_results`
 * with the verdict `conflict` (the settle came first): a run that failed,
 * degraded or never launched has no conflict to put to a consensus round.
 * The text is scrubbed and written as given, atomically. `command` is the
 * consensus round the proposal selects, with the file's absolute path.
 */
export async function writeConsensusTask(args) {
  // A file kept beside the workflow, held to its attempt mark as every write
  // under its lock is (withFileLock, ADR-0068 Decision 5): the mark moves on
  // once the task is checked and before it is published (markBeside).
  return withFileLock(args.workflowPath, (ownership) => writeConsensusTaskUnderLock(args, ownership, {
    beforePublish: () => markBeside(args.workflowPath, ownership),
  }), {
    env: args.env ?? process.env, host: args.host ?? 'claude', writer: LANE_WRITERS.plain,
  });
}

// writeConsensusTask's body, for a caller already holding the workflow's lock:
// the file is published with atomicWrite and the lock's token, so a writer
// whose lock was reclaimed never overwrites the new owner's task file.
// `beforePublish` runs once the task is checked, just before it is published.
export async function writeConsensusTaskUnderLock({ workflowPath, runId, text, host = 'claude' }, ownership, { beforePublish } = {}) {
  validateHost(host);
  if (!isSafeConsensusRunId(runId)) {
    throw new Error(`consensus-task: ${JSON.stringify(runId)} is not a run id (ADR-0067 Decision 8)`);
  }
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('consensus-task: the contested items are empty');
  }
  const { frontmatter } = parseWorkflowFile(await readFile(workflowPath, 'utf8'));
  const result = (frontmatter.ensemble_results ?? []).find((e) => e?.run_id === runId);
  if (!result) {
    throw new Error(
      `consensus-task: run ${runId} has no ensemble result on this workflow; settle it first (peer-runner.mjs settle) (ADR-0067 Decision 8)`,
    );
  }
  if (result.verdict !== 'conflict') {
    throw new Error(
      `consensus-task: run ${runId} is recorded with verdict ${JSON.stringify(result.verdict)}, not conflict; only a conflict is put to a consensus round (ADR-0067 Decision 8)`,
    );
  }
  const paths = consensusTaskPaths(workflowPath, frontmatter.workflow_id, runId);
  if (!paths) {
    throw new Error(`consensus-task: ${JSON.stringify(workflowPath)} is not a workflow file under the ${personaName()} state home`);
  }
  if (beforePublish) await beforePublish();
  await ensureDir(paths.dir, 0o700);
  await atomicWrite(paths.file, `${scrubSecrets(text).trim()}\n`, ownership);
  return {
    path: paths.file,
    pointer: paths.pointer,
    workflowId: frontmatter.workflow_id,
    runId,
    command: consensusCommand(paths.file, host),
  };
}

// A path as one shell word: as written when it holds only safe characters,
// single-quoted otherwise.
function shellWord(text) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

// The bounded round ADR-0067 Decision 8 proposes: both peers, at most two
// rounds, the task file by its absolute path (consensus.mjs resolves a
// relative one against its working directory).
function consensusCommand(taskFile, host) {
  return `${host === 'codex' ? '$' : '/'}runtime:consensus plan --task-file ${shellWord(taskFile)} --peers claude,codex --max-rounds 2`;
}

/**
 * ADR-0067 Decision 8 — the consensus proposal of a workflow's conflict gate,
 * read-only. Current only while a conflict gate is set with a run id, the
 * workflow's ensemble_results holds that run with the verdict conflict, and
 * the task file for that run exists; judged from the frontmatter and the
 * file's existence, never its content. `command` is the next step the
 * proposal selects, with the file's absolute path; nothing runs it.
 */
export async function consensusProposal({ workflowPath, host = 'claude' }) {
  validateHost(host);
  const { frontmatter } = await readWorkflow(workflowPath);
  const gate = frontmatter.awaiting_owner_gate ?? null;
  const runId = frontmatter.awaiting_owner_run_id ?? null;
  const not = (reason) => ({ current: false, reason, gate, run_id: runId });
  if (gate === null) return not('no owner gate is set');
  if (!CONFLICT_OWNER_GATES.has(gate)) return not(`the owner gate ${gate} is not a conflict gate`);
  if (runId === null) return not(`the ${gate} gate records no run id (an owner selection, a veto, or a gate set before ADR-0067)`);
  const result = (frontmatter.ensemble_results ?? []).find((e) => e?.run_id === runId);
  if (!result) return not(`run ${runId} has no ensemble result on this workflow`);
  if (result.verdict !== 'conflict') return not(`run ${runId} is recorded with verdict ${result.verdict}`);
  const paths = consensusTaskPaths(workflowPath, frontmatter.workflow_id, runId);
  if (!paths) return not('the workflow file is under no state home');
  if (!(await pathStat(paths.file))) return not(`the task file ${paths.pointer} does not exist`);
  return {
    current: true,
    gate,
    run_id: runId,
    task_file: paths.file,
    pointer: paths.pointer,
    command: consensusCommand(paths.file, host),
  };
}

// -----------------------------------------------------------------------------
// C120 — the review ledger of a document deliverable (lib/review-scope.mjs;
// ADR-0063, amendment of 2026-10-14). One JSON file per workflow in the home
// the workflow file sits in, `<home>/reviews/<workflow id>.json`, written
// holding the workflow's lock. No frontmatter key points at it: its name
// derives from the workflow's, so an older release, which never reads it,
// carries nothing it could drop. It is never archived with the workflow, so a
// later workflow starts with a full critique.

function reviewLedgerPaths(workflowPath, workflowId) {
  if (typeof workflowId !== 'string' || !CONSENSUS_WORKFLOW_ID_RE.test(workflowId)) return null;
  const storage = inferStorageFromWorkflowPath(resolvePath(String(workflowPath)));
  if (!storage || storage.stateRoot.length === 0) return null;
  const dir = join(statePaths(storage.stateRoot, storage.home).root, 'reviews');
  return { dir, file: join(dir, `${workflowId}.json`) };
}

async function readReviewLedger(paths, workflowId) {
  let text;
  try {
    text = await readFile(paths.file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ReviewScopeError(`the review ledger ${paths.file} is not JSON`);
  }
  return validateLedger(parsed, workflowId);
}

async function writeReviewLedger(paths, ledger, ownership) {
  await ensureDir(dirname(paths.file), 0o700);
  await atomicWrite(paths.file, `${JSON.stringify(ledger, null, 2)}\n`, ownership);
}

// The workflow under its lock, the ledger's paths, and the critique runs its
// notes count; refuses a workflow file outside a state home.
async function reviewContext(workflowPath, what) {
  const { frontmatter, body } = parseWorkflowFile(await readFile(workflowPath, 'utf8'));
  const paths = reviewLedgerPaths(workflowPath, frontmatter.workflow_id);
  if (!paths) throw new Error(`${what}: ${JSON.stringify(workflowPath)} is not a workflow file under the ${personaName()} state home`);
  return { frontmatter, paths, entries: critiqueEntries(body) };
}

// The checkout a review is held to: its working tree as a tree object and
// HEAD, on the workflow's branch, or `{ ok: false, reason, message }` when it
// cannot be read (no checkout, a conflicted index, HEAD moving, an index entry
// marked assume-unchanged or skip-worktree, whose edits the tree leaves out) or is on
// another branch (`otherBranch`): a worktree sharing the state root never
// reads or writes another branch's ledger. It never throws for the checkout's
// state, so a critique or refine it cannot vouch for falls back to today's,
// never aborts.
async function workflowCheckout(repoRoot, frontmatter) {
  const expected = frontmatter.git_baseline?.branch;
  const onAnotherBranch = (top, branch) => ({
    ok: false,
    otherBranch: true,
    reason: `other-branch:${branch || 'detached-head'}`,
    message: `the checkout ${top} is on ${branch || 'a detached HEAD'}, not the workflow's branch ${expected}`,
  });
  // The branch first: a checkout of another branch is not this workflow's,
  // whatever state its working tree is in, so it never touches the ledger. A
  // branch git cannot name is no evidence either way; the capture decides.
  const bound = typeof expected === 'string' && expected !== '';
  const early = bound ? currentBranch(repoRoot) : null;
  if (early !== null && early !== expected) return onAnotherBranch(repoRoot, early);
  let captured;
  try {
    captured = await captureWorkingTree({ cwd: repoRoot });
  } catch (err) {
    return { ok: false, reason: `checkout-unreadable:${err?.reason ?? err?.code ?? 'error'}`, message: String(err?.message ?? err) };
  }
  if (captured === null) return { ok: false, reason: 'not-a-git-checkout', message: `${repoRoot} is not a git checkout` };
  if (captured.flagged.length > 0) {
    return {
      ok: false,
      reason: 'checkout-unreadable:index-flags',
      message: `${captured.flagged.length} index entr${captured.flagged.length === 1 ? 'y is' : 'ies are'} marked assume-unchanged or skip-worktree in ${captured.top} (${captured.flagged.slice(0, 3).join(', ')}${captured.flagged.length > 3 ? ', …' : ''}): an edit to such a file is not in the captured tree`,
    };
  }
  const branch = bound ? currentBranch(captured.top) : expected;
  if (branch === null) return { ok: false, reason: 'checkout-unreadable:branch', message: `git cannot name the branch ${captured.top} has checked out` };
  if (branch !== expected) return onAnotherBranch(captured.top, branch);
  return { ok: true, ...captured };
}

// The rest of what a review is held to: the workflow's baseline as a commit,
// the artifact set and whether it is a document. A baseline that names no
// commit, or a change git cannot read, is no document: the critique keeps
// today's full review.
function reviewFacts(checkout, frontmatter) {
  const facts = { top: checkout.top, tree: checkout.tree, head: checkout.head, base: null, artifact: [], document: false, operation: null };
  const base = baselineCommit(checkout.top, frontmatter.git_baseline?.head);
  if (base === null) return { ...facts, documentReason: 'no-baseline-commit' };
  try {
    const changes = artifactChanges(checkout.top, base, checkout.tree);
    const kind = classifyDeliverable(checkout.top, base, checkout.tree, changes);
    return {
      ...facts,
      base,
      artifact: changes.map((c) => c.path),
      document: kind.document,
      documentReason: kind.reason,
      operation: operationInProgress(checkout.top),
    };
  } catch (err) {
    return { ...facts, base, documentReason: `change-unreadable:${String(err?.message ?? err).split('\n')[0]}` };
  }
}

/**
 * Open the next critique of a document deliverable and return its scope:
 * `{ recorded, generation, mode, reason, document, tree, artifact, passages,
 * targets, findings }`. A deliverable that is not a document, or a checkout
 * this cannot read, records nothing (`recorded: false`, mode full): it keeps
 * today's critique, and a ledger an earlier critique left is moved aside. A
 * checkout on another branch records nothing and leaves the ledger alone. A
 * ledger that cannot be read is moved aside and a new one starts, with a full
 * critique.
 */
export async function openCritiqueScope({ workflowPath, repoRoot, profile = '', now = isoUtc(), env = process.env, host }) {
  // The review ledger, held to the workflow's attempt mark as every write
  // under its lock is (withFileLock, ADR-0068 Decision 5).
  return withFileLock(workflowPath, async (ownership) => {
    const { frontmatter, paths, entries } = await reviewContext(workflowPath, 'critique-scope');
    const checkout = await workflowCheckout(repoRoot, frontmatter);
    const facts = checkout.ok
      ? reviewFacts(checkout, frontmatter)
      : { tree: null, head: null, artifact: [], document: false, documentReason: checkout.reason };
    const declared = loadPersona().verbs?.critique?.default_profile;
    const defaultProfile = profile === '' || profile === declared;
    const summary = {
      document: facts.document,
      document_reason: facts.documentReason,
      tree: facts.tree,
      head: facts.head,
      artifact: facts.artifact,
      ...(checkout.ok ? {} : { detail: checkout.message }),
    };
    const unrecorded = { recorded: false, generation: null, mode: 'full', reason: facts.documentReason, ...summary, passages: [], targets: [], findings: [] };
    if (!checkout.ok && checkout.otherBranch) return unrecorded;
    // Every path below moves or writes the ledger: the mark moves on first, so
    // a step stopped between the two has already bound the attempt.
    await markBeside(workflowPath, ownership);
    if (!facts.document) {
      // A ledger a document critique left would hand refine findings this
      // critique, which records nothing, never judged: it is moved aside, and
      // the workflow is one with no ledger again.
      let superseded = null;
      try {
        superseded = `${paths.file}.superseded-${Date.now()}`;
        await renameHeld(paths.file, superseded, ownership);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        superseded = null;
      }
      return { ...unrecorded, ...(superseded === null ? {} : { ledger_moved_aside: superseded }) };
    }
    let ledger;
    let reset = null;
    let resetReason = null;
    try {
      ledger = (await readReviewLedger(paths, frontmatter.workflow_id)) ?? emptyLedger(frontmatter.workflow_id);
    } catch (err) {
      if (!(err instanceof ReviewScopeError)) throw err;
      reset = `${paths.file}.unreadable-${Date.now()}`;
      await renameHeld(paths.file, reset, ownership);
      ledger = emptyLedger(frontmatter.workflow_id);
    }
    // A critique ran that the ledger never recorded (its critique-scope
    // failed, an older state.mjs ran it, its checkout could not be vouched
    // for): its findings are only in the notes, so the ledger is moved aside
    // and this critique starts a new one, full.
    if (unrecordedCritique(ledger, entries, 1)) {
      reset = `${paths.file}.superseded-${Date.now()}`;
      await renameHeld(paths.file, reset, ownership);
      ledger = emptyLedger(frontmatter.workflow_id);
      resetReason = 'unrecorded-critique';
    }
    let decision = decideScope(ledger, { ...facts, defaultProfile });
    if (resetReason !== null && decision.mode === 'full') decision = { ...decision, reason: resetReason };
    let passages = [];
    if (decision.mode === 'scoped') {
      try {
        passages = changedPassages(facts.top, decision.from, facts.tree, facts.artifact);
      } catch (err) {
        // The tree the last critique reviewed is gone (`git gc` pruned it) or
        // unreadable: no passage can be shown, so the critique is full.
        decision = { mode: 'full', reason: `passages-unreadable:${String(err?.message ?? err).split('\n')[0]}`, from: null, targets: [] };
      }
    }
    const opened = openGeneration(ledger, { ...decision, ...facts, passages, critiqueEntries: entries }, now);
    await writeReviewLedger(paths, opened.ledger, ownership);
    const status = reviewStatus(opened.ledger);
    return {
      recorded: true,
      ledger: opened.ledger.ledger_id,
      generation: opened.generation,
      mode: decision.mode,
      reason: decision.reason,
      ...summary,
      passages,
      targets: decision.targets,
      // A resolved finding the refine targeted again is the critique's to
      // judge, so its entry goes with the rest.
      findings: status.findings.filter((f) => f.disposition !== 'resolved' || decision.targets.includes(f.id)),
      ...(reset === null ? {} : { ledger_moved_aside: reset }),
    };
  }, { env, ...(host === undefined ? {} : { host: validHost(host) }), writer: LANE_WRITERS.plain });
}

/**
 * Close the open critique `generation` of ledger `ledgerId` with the findings
 * the synthesis wrote (`input`, `{ findings: [...] }`) and return the
 * disposition. Refuses when the ledger is another than the critique opened in,
 * or the checkout no longer holds the tree the critique reviewed: the findings
 * would be held to text nobody reviewed.
 */
export async function closeCritiqueScope({ workflowPath, repoRoot, ledgerId, generation, input, now = isoUtc(), env = process.env, host }) {
  return withFileLock(workflowPath, async (ownership) => {
    const { frontmatter, paths } = await reviewContext(workflowPath, 'critique-close');
    const ledger = await readReviewLedger(paths, frontmatter.workflow_id);
    if (ledger === null) throw new ReviewScopeError('critique-close: this workflow has no review ledger; critique-scope opens one');
    // Generation and finding ids restart in a ledger that replaced another, so
    // a close names the ledger its critique opened in.
    if (ledger.ledger_id !== ledgerId) {
      throw new ReviewScopeError(
        `critique-close: ledger ${JSON.stringify(ledgerId)} is not this workflow's review ledger now (${ledger.ledger_id}); ` +
          'it was replaced since the critique opened: run critique-scope again',
      );
    }
    const gen = ledger.generations.find((g) => g.id === generation);
    if (!gen || gen.state !== 'open') {
      throw new ReviewScopeError(`critique-close: generation ${generation} is not the open critique of this workflow; run critique-scope again`);
    }
    const checkout = await workflowCheckout(repoRoot, frontmatter);
    if (!checkout.ok) throw new ReviewScopeError(`critique-close: ${checkout.message}`);
    if (checkout.tree !== gen.tree || checkout.head !== gen.head) {
      throw new ReviewScopeError(
        `critique-close: the checkout changed since generation ${generation} was opened (it reviewed tree ${gen.tree}); ` +
          'run critique-scope again and review what is there now',
      );
    }
    const closed = closeGeneration(ledger, generation, input, now);
    await markBeside(workflowPath, ownership);
    await writeReviewLedger(paths, closed.ledger, ownership);
    return closed.result;
  }, { env, ...(host === undefined ? {} : { host: validHost(host) }), writer: LANE_WRITERS.plain });
}

/**
 * Record what a refine targeted and the tree it left, after the fix and
 * before Refine-verify, and say how Refine-verify runs (`verify`: scoped only
 * when the next critique would be, on the tree just recorded). Nothing is
 * recorded when the workflow has no readable review ledger (its deliverable
 * was never critiqued as a document) or the checkout cannot be read or is on
 * another branch: the next critique is full.
 */
export async function recordRefineScope({ workflowPath, repoRoot, targets, now = isoUtc(), env = process.env, host }) {
  return withFileLock(workflowPath, async (ownership) => {
    const { frontmatter, paths, entries } = await reviewContext(workflowPath, 'refine-record');
    const unrecorded = (reason, extra = {}) => ({ recorded: false, reason, ...extra, verify: { mode: 'full', reason } });
    let ledger;
    try {
      ledger = await readReviewLedger(paths, frontmatter.workflow_id);
    } catch (err) {
      if (!(err instanceof ReviewScopeError)) throw err;
      return unrecorded('unreadable-ledger');
    }
    if (ledger === null) return unrecorded('no-review-ledger');
    if (unclosedCritique(ledger)) return unrecorded('unclosed-critique');
    if (unrecordedCritique(ledger, entries, 0)) return unrecorded('unrecorded-critique');
    const checkout = await workflowCheckout(repoRoot, frontmatter);
    if (!checkout.ok) return unrecorded(checkout.reason, { detail: checkout.message });
    const done = recordRefine(ledger, { targets, treeAfter: checkout.tree }, now);
    await markBeside(workflowPath, ownership);
    await writeReviewLedger(paths, done.ledger, ownership);
    const facts = reviewFacts(checkout, frontmatter);
    let verify = decideScope(done.ledger, { ...facts, defaultProfile: true });
    // The same passage check the next critique makes: a tree it cannot read
    // makes that critique full, so Refine-verify is full too.
    if (verify.mode === 'scoped') {
      try {
        changedPassages(facts.top, verify.from, facts.tree, facts.artifact);
      } catch (err) {
        verify = { mode: 'full', reason: `passages-unreadable:${String(err?.message ?? err).split('\n')[0]}` };
      }
    }
    return { recorded: true, ...done.attempt, verify: { mode: verify.mode, reason: verify.reason } };
  }, { env, ...(host === undefined ? {} : { host: validHost(host) }), writer: LANE_WRITERS.plain });
}

/** Read-only: what the review ledger says, or `{ ledger: false }`. */
export async function readReviewStatus({ workflowPath }) {
  const { frontmatter, paths, entries } = await reviewContext(workflowPath, 'review-status');
  let ledger;
  try {
    ledger = await readReviewLedger(paths, frontmatter.workflow_id);
  } catch (err) {
    if (!(err instanceof ReviewScopeError)) throw err;
    return { ledger: false, reason: 'unreadable-ledger' };
  }
  if (ledger === null) return { ledger: false };
  // A critique since the last close that never closed: its findings are only
  // in the notes, so refine works from those, as it always has.
  if (unclosedCritique(ledger)) return { ledger: false, reason: 'unclosed-critique' };
  // A critique ran that the ledger holds no generation for: the same.
  if (unrecordedCritique(ledger, entries, 0)) return { ledger: false, reason: 'unrecorded-critique' };
  return { ledger: true, ...reviewStatus(ledger) };
}

// A file of finding ids: a JSON array, or one id per line.
function readIdList(text) {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('the targets file is not a list');
    return parsed;
  }
  return trimmed.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
}

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
  if (!inferred || inferred.stateRoot.length === 0) {
    throw new Error(
      `cannot derive a pointer: ${JSON.stringify(workflowPath)} is not under the ${personaName()} state home; pass --pointer instead`,
    );
  }
  // ADR-0067 Decision 1(c): relative to the state root that holds the file.
  return `${absolute.slice(inferred.stateRoot.length + 1)}#${anchor}`;
}

// The awaiting_owner_* keys for a gate, checked before any lock is taken: a
// gate this persona cannot set is refused here (PC2b DD2), and so is a run id
// on a gate that is not a conflict gate (ADR-0067 Decision 8).
function resolveOwnerGateFields({ workflowPath, ownerGate, now }) {
  if (typeof ownerGate !== 'object' || ownerGate === null || Array.isArray(ownerGate)) {
    throw new Error('ownerGate must be an object { gate, pointer | anchor, since?, runId? }');
  }
  assertSettableOwnerGate(ownerGate.gate);
  const fields = {
    awaiting_owner_gate: ownerGate.gate,
    awaiting_owner_since: ownerGate.since ?? isoUtc(now),
    awaiting_owner_pointer: resolveAwaitingOwnerPointer({
      workflowPath, pointer: ownerGate.pointer, anchor: ownerGate.anchor,
    }),
  };
  if (ownerGate.runId !== undefined) {
    if (!CONFLICT_OWNER_GATES.has(ownerGate.gate)) {
      throw new Error(
        `only a conflict gate (${[...CONFLICT_OWNER_GATES].join(', ')}) records the run id of its synthesis; ` +
          `${ownerGate.gate} does not (ADR-0067 Decision 8)`,
      );
    }
    fields.awaiting_owner_run_id = ownerGate.runId;
  }
  validateSchema14Fields(fields);
  return fields;
}

// Under the file lock: one gate at a time. Setting the gate that is already
// set replaces its pointer and since; a different gate is refused. A
// workflow waiting on its owner is not complete, so an inherited terminal
// marker is turned off in the same write: otherwise the Stop hook could
// archive it once HEAD moved, burying the gate (gate 5 refuses that too).
// ADR-0067 Decision 8: every gate write sets the run id or deletes it, and
// returns the run id it replaced, whose task file the caller retires once the
// write has landed.
function applyOwnerGate(frontmatter, fields) {
  const current = frontmatter.awaiting_owner_gate;
  if (current !== undefined && current !== fields.awaiting_owner_gate) {
    throw new Error(
      `owner gate ${current} is already set on this workflow; it must be cleared before ${fields.awaiting_owner_gate} can be set`,
    );
  }
  const replaced = frontmatter.awaiting_owner_run_id;
  Object.assign(frontmatter, fields);
  if (!('awaiting_owner_run_id' in fields)) delete frontmatter.awaiting_owner_run_id;
  if (frontmatter.terminal_marker === true) frontmatter.terminal_marker = false;
  validateSchema14Fields(frontmatter);
  return replaced !== undefined && replaced !== fields.awaiting_owner_run_id ? replaced : null;
}

/**
 * ADR-0063 D6 — record that this workflow waits on an owner judgment. The
 * surface that pauses sets the gate. Only one gate is modelled at a time:
 * setting a gate while a different one is set is refused; setting the gate
 * that is already set replaces its pointer and since. Only the gates this
 * persona can set are accepted (settableOwnerGates). A conflict gate may name
 * the run whose synthesis set it (`runId`, ADR-0067 Decision 8: inside a
 * start lifecycle, which sets its gates this way); a gate set without one
 * deletes the key, and a re-set that names another run, or none, retires the
 * task file of the run it replaces.
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
  runId,
  // The gate turns an inherited terminal marker off, a write of the handoff
  // held to the attempt mark (withFileLock, ADR-0068 Decision 5).
  env = process.env,
  now = new Date(),
}) {
  validateHost(host);
  const fields = resolveOwnerGateFields({ workflowPath, ownerGate: { gate, pointer, anchor, since, runId }, now });
  return withFileLock(workflowPath, async (ownership) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    const nowIso = isoUtc(now);
    const replacedRunId = applyOwnerGate(frontmatter, fields);
    frontmatter.updated_at = nowIso;
    frontmatter.host_history = [
      ...(frontmatter.host_history ?? []),
      { host, at: nowIso, event: 'updated' },
    ];
    await writeWorkflow(workflowPath, frontmatter, body, ownership);
    const retired = replacedRunId === null
      ? { retired: null, warning: null }
      : await retireConsensusTask(workflowPath, frontmatter.workflow_id, replacedRunId, ownership);
    return { frontmatter, workflowPath, retired };
  }, { env, host, writer: LANE_WRITERS.plain });
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
  // ADR-0068 Decision 2, item 7 (N4) — a gate resolution is one operation
  // across its clear and the finish-verb after it: this clear opens it in an
  // operation directory (`openOperation`, the kind), or, given only the
  // directory, is a later write of the operation open there (the verb whose
  // Phase 0 opened it resolves the gate); the finish-verb, given the same
  // directory, closes it. With neither the clear is an operation of its own
  // one write. Inside a /start lifecycle, where no finish-verb follows, a clear
  // given Phase 0's directory is that operation's last write
  // (`closeOperation`).
  operationDir,
  openOperation,
  closeOperation = false,
  env = process.env,
  now = new Date(),
}) {
  validateHost(host);
  if ((openOperation !== undefined || closeOperation) && (operationDir === undefined || operationDir === '')) {
    throw new Error('a clear opens or closes its operation in an operation directory: --open-operation and --close-operation take --operation-dir');
  }
  if (openOperation !== undefined && closeOperation) {
    throw new Error('a clear opens its operation or closes it, not both');
  }
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
  const operation = operationDir !== undefined && operationDir !== ''
    ? await prepareOperation({
      point: openOperation !== undefined ? 'open' : closeOperation ? 'close' : 'carry', kind: openOperation, operationDir, workflowPath, host, env, now,
    })
    : await prepareChildOperation({ point: 'once', kind: 'gate', workflowPath, host, env, now });
  return withOperation(operation, () => withFileLock(workflowPath, async (ownership) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    const current = frontmatter.awaiting_owner_gate;
    if (current === undefined) {
      throw new Error(`no owner gate is set on this workflow (asked to clear ${gate})`);
    }
    if (current !== gate) {
      throw new Error(`the owner gate set on this workflow is ${current}, not ${gate}`);
    }
    operation.inLock(frontmatter);
    const nowIso = isoUtc(now);
    // ADR-0067 Decision 8 — the run id goes with the gate's other keys, and
    // the task file of that run is retired once this write has landed.
    const runId = frontmatter.awaiting_owner_run_id;
    const note =
      `### Owner gate resolved: ${gate} at ${nowIso}\n\n` +
      (resolution !== undefined ? `${resolution.trim()}\n\n` : '') +
      `Cleared awaiting_owner (since ${frontmatter.awaiting_owner_since}, ` +
      `pointer ${frontmatter.awaiting_owner_pointer}${runId !== undefined ? `, run ${runId}` : ''}).\n\n`;
    for (const k of AWAITING_OWNER_KEYS) delete frontmatter[k];
    applyNextStepWrite(frontmatter, nextStepWrite);
    if (nextAction !== undefined) frontmatter.next_action = nextAction;
    frontmatter.updated_at = nowIso;
    frontmatter.host_history = [
      ...(frontmatter.host_history ?? []),
      { host, at: nowIso, event: 'updated' },
    ];
    await writeWorkflow(workflowPath, frontmatter, appendToBody(body, note), ownership, { nextStep: nextStepWrite !== null });
    const retired = runId === undefined
      ? { retired: null, warning: null }
      : await retireConsensusTask(workflowPath, frontmatter.workflow_id, runId, ownership);
    return { frontmatter, workflowPath, retired };
  }, { env, host, writer: writerOf(operation) }));
}

// How each gate this persona can set is resolved, named with the host's
// command sigil. The resolving surface clears the gate.
const OWNER_GATE_RESOLUTION = Object.freeze({
  'decide-conflict': (p) => `the owner selects a direction in ${p}decide, whose Owner selection step clears the gate`,
  // ADR-0067 Decision 8: critique and investigate stop on it in either mode.
  'peer-conflict': () => 'the owner rules on the contested items in the phase note (after the bounded consensus round proposed there, when it is run), then clears the gate with the ruling and the next step',
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
// ADR-0068 Decision 5 — the verb banner's last sentence, the one signal a
// step's runbook names for which branch of its long-check guidance applies.
const AUTOPILOT_VERIFY_OFFERED =
  'This run offers verification: run only quick checks in this step, never wait ' +
  'for the heavy-work lock, and hand the long ones (the whole test suite, a broad ' +
  'npm test, mutation runs) to the driver with the finalize\'s verify form ' +
  '(verify-request.json).';
const AUTOPILOT_VERIFY_NOT_OFFERED =
  'This run does not offer verification: run the checks this step needs in it, ' +
  'and end with the verb form.';

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
  // The checkout the offer's declaration is read from (verifyOffer).
  cwd = process.cwd(),
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
    // ADR-0068 Decision 5 — a verb's banner says whether this run offers
    // verification, the signal its runbooks' long-check guidance and verify
    // form name; the commit surface hands no checks over.
    const offer = surface === 'verb' ? verifyOffer({ env, host, cwd }) : null;
    const verification = offer === null ? ''
      : offer.on ? ` ${AUTOPILOT_VERIFY_OFFERED}`
        : ` ${AUTOPILOT_VERIFY_NOT_OFFERED}`;
    return {
      mode: 'autopilot',
      gate: null,
      refuse: false,
      verify_offered: offer === null ? undefined : offer.on,
      stdout: `Autopilot run ${env.AGENTIC_AUTOPILOT} (ADR-0063 D4): ${surface === 'commit' ? AUTOPILOT_COMMIT_RULES : AUTOPILOT_RULES}${verification}\n`,
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
  // ADR-0067 Decision 8 — a conflict gate whose task file is current proposes
  // a bounded consensus round before the owner decides. The owner runs it.
  const proposal = CONFLICT_OWNER_GATES.has(gate.gate) ? await consensusProposal({ workflowPath, host }) : null;
  return {
    mode: 'interactive',
    ignored: mode.ignored,
    gate,
    refuse: false,
    stdout:
      `Owner gate ${gate.gate} is pending since ${gate.since}: ${gate.pointer}.\n` +
      `Put it to the user before this command continues: ${how}.\n` +
      (proposal?.current
        ? `Proposed first, for the owner to run: a bounded consensus round on the contested items, ${proposal.command}\n`
        : '') +
      `Clearing it by hand once it is resolved, with the next step the owner chose ` +
      `and its action, which replaces the gate's (PC3b); write the owner's decision ` +
      `and the next step's action each to a file with your file-writing tool, never ` +
      `on the command line (ADR-0059 amendment (j)): ` +
      `node "${scriptPath}" awaiting-owner-clear --workflow-path "${workflowPath}" ` +
      `--host ${host} --gate ${gate.gate} --next-step-kind <verb|commit|done> ` +
      `--next-step-confidence HIGH [--next-step-verb <verb>] --resolution-file <decision file> ` +
      `--next-action-file <action file>\n`,
    stderr,
  };
}

// -----------------------------------------------------------------------------
// ADR-0068 Decision 2 — the persona's half of hold and release (the
// implementation note of 2026-10-25). Every rule here is inert until a
// hold-aware orchestrator marks the macro's holds directory (N2): until then
// the persona writes as today and refuses nothing (item 9).

/**
 * The macro, subtask and holds directory a workflow is a child of, or null:
 * only with dispatch_target on, for a workflow that records the dispatch
 * linkage (parent_workflow, originating_subtask) in their forms.
 */
function macroChildOf(workflowPath, frontmatter) {
  if (!capabilityOn('dispatch_target')) return null;
  const macroId = frontmatter.parent_workflow;
  const subtaskId = frontmatter.originating_subtask;
  if (!isSafeMacroId(macroId) || !isSafeSubtaskId(subtaskId)) return null;
  const stateRoot = workflowStateRoot(workflowPath) ?? dirname(workflowPath);
  return { macroId, subtaskId, mainRoot: holdsMainRoot(stateRoot) };
}

/**
 * Decision 2, item 6 — why a verb's last write keeps a macro's child open, or
 * null when it closes it as today. Open while the subtask's hold applies, it
 * has a kept park, or a run of its macro is live (N3), and while the holds
 * directory cannot be read (whether it holds a hold cannot be told). Nothing
 * keeps it open before a hold-aware orchestrator ran for the macro (N2).
 */
export async function holdKeepsOpen(workflowPath, { probe } = {}) {
  const { frontmatter } = await readWorkflow(workflowPath);
  return holdKeepsOpenOf(workflowPath, frontmatter, { probe });
}

function holdKeepsOpenOf(workflowPath, frontmatter, { probe } = {}) {
  const child = macroChildOf(workflowPath, frontmatter);
  if (child === null) return null;
  const facts = laneHoldFacts({
    ...child, branch: frontmatter.git_baseline?.branch ?? '', workflowId: frontmatter.workflow_id, probe,
  });
  if (facts.activation.state === 'inactive') return null;
  if (facts.activation.state === 'unreadable') return { why: `the holds directory cannot be read (${facts.activation.error})` };
  if (facts.applies.applies) return { why: `subtask ${child.subtaskId} is held: ${facts.applies.why}` };
  if (facts.park.kept) return { why: `subtask ${child.subtaskId} has ${facts.park.why}` };
  if (facts.run.live) return { why: `a run of ${child.macroId} is live: ${facts.run.why}` };
  return null;
}

// The frontmatter fields a snapshot writes (snapshot(): updated_at,
// last_snapshot, a host_history entry of event snapshot; writeWorkflow:
// verify_handoff, verify_attempt), which the content digest leaves out.
export const CONTENT_DIGEST_SCHEMA = 'agentic-workflow-content-digest-1';

/**
 * N6 — the workflow part of a release's content digest: the sha256 of the
 * parsed frontmatter without the fields a snapshot writes, the forward-compat
 * carrier included (each unknown key with its raw scalar), and of the body as
 * stored, its leading blank lines left out. A snapshot leaves it unchanged, whoever re-serializes the file; any
 * other change moves it.
 */
export async function contentDigest(workflowPath) {
  const text = await readFile(workflowPath, 'utf8');
  const { frontmatter, body } = parseWorkflowFile(text);
  const fm = { ...frontmatter };
  delete fm.updated_at;
  delete fm.last_snapshot;
  // A snapshot is a write of the workflow (writeWorkflow), so it stamps the
  // handoff generation and, under an autopilot run, moves the attempt mark on
  // (markAttempt, stampHandoff): both are left out, as fields a snapshot writes.
  delete fm.verify_handoff;
  delete fm.verify_attempt;
  if (Array.isArray(fm.host_history)) fm.host_history = fm.host_history.filter((h) => h?.event !== 'snapshot');
  const unknowns = (frontmatter[FORWARD_COMPAT_UNKNOWNS] ?? []).map((u) => ({ key: u.key, raw: u.raw }));
  // Every write puts one more blank line between the frontmatter and the body
  // (assembleWorkflowFile), so the body's leading blank lines are left out.
  const digest = createHash('sha256').update(canonicalJson({ frontmatter: fm, unknowns, body: body.replace(/^\n+/, '') })).digest('hex');
  return { schema: CONTENT_DIGEST_SCHEMA, digest };
}

/** N8 — what the persona's half of the holds answers to the driver's floor. */
export function holdCapability() {
  return { capability: HOLD_PERSONA_CAPABILITY, protocol: HOLDS_PROTOCOL };
}

/**
 * Decision 2, item 7 — why the Stop hook's sweep, which archives a terminal
 * workflow of a branch no worktree has checked out, leaves a macro's child
 * alone, or null. Its open operation is another session's: once a hold-aware
 * orchestrator runs (N2), the sweep never archives beside it, nor while the
 * holds directory cannot be read; the operation's own session ends it, or
 * the owner clears it (`writer-clear`) and the next sweep archives the child.
 * Inactive, it archives as before.
 */
export function sweepLeavesChild(workflowPath, frontmatter) {
  const child = macroChildOf(workflowPath, frontmatter);
  if (child === null) return null;
  const activation = readActivation(child.mainRoot, child.macroId);
  if (activation.state === 'inactive') return null;
  if (activation.state === 'unreadable') return `the holds directory of ${child.macroId} cannot be read (${activation.error})`;
  // A document of a later version cannot be read for its operations: they
  // are taken as open.
  const doc = frontmatter[PERSONA_OPERATIONS_KEY];
  if (doc !== undefined && doc.v > PERSONA_OPERATIONS_VERSION) return `its ${PERSONA_OPERATIONS_KEY} is a later version (v ${doc.v})`;
  // An entry of the child, or a record of the lane with no .cleared beside it
  // (one published before its first write, or left by a crash), as the
  // orchestrator counts it.
  const open = otherOpenOperation(child, null, doc?.ops ?? []);
  if (open !== null) return `${open} is open in its lane`;
  // Nor, with none open, a child its owner holds: the sweep is no operation.
  return laneWriterRefusal(workflowPath, frontmatter);
}

/**
 * Decision 2, item 7 — the inventory of the writers of a workflow: every lock
 * of one names its class (withFileLock's `writer`), so a writer with no class
 * of its own is `plain`.
 *
 * - `plain`: refused in a held lane outside any persona operation
 *   (laneWriterRefusal).
 * - `operation`: a step of a persona operation, which admits it (N4).
 * - `snapshot`: the Stop and PreCompact snapshot, which writes only the fields
 *   the content digest leaves out (N6): not a writer the release excludes.
 * - `settlement`: the settlement of a run the child records pending or
 *   settled: a step running when the hold was set still settles (item 4), and
 *   the handoff waits for it. Of any other run it is `plain`.
 * - `machine`: a result, end or pass of the driver's verification batch, which
 *   started before the hold (item 4).
 * - `job`: a batch's start or restart, refused while the subtask's hold
 *   applies whatever operation is open: no machine job starts in a held lane
 *   (item 3).
 * - `create`: a bootstrap, judged once its workflow is written
 *   (createWorkflowUnderLock).
 * - `destination`: an archive's destination, which holds no live workflow.
 */
export const LANE_WRITERS = Object.freeze({
  plain: 'plain',
  operation: 'operation',
  snapshot: 'snapshot',
  settlement: 'settlement',
  machine: 'machine',
  job: 'job',
  create: 'create',
  destination: 'destination',
});
const LANE_WRITER_CLASSES = new Set(Object.values(LANE_WRITERS));
// The classes a held lane judges; the others are judged elsewhere or exempt.
const LANE_WRITERS_CHECKED = new Set([LANE_WRITERS.plain, LANE_WRITERS.settlement, LANE_WRITERS.job]);

// The class of a write an operation may step: `operation` when the command
// has one, else `plain`.
const writerOf = (operation) => (operation.id === null ? LANE_WRITERS.plain : LANE_WRITERS.operation);

/**
 * Decision 2, item 7 — why a write of class `writer` (LANE_WRITERS) of the
 * macro's child `frontmatter` is refused, or null. Every command that writes a
 * macro's child is a persona operation or refuses in a held lane: a `plain`
 * write is refused while the subtask's hold applies (N3) and no operation is
 * open on the child (an entry the owner has not cleared), and while the holds
 * directory cannot be read with none open (whether the subtask is held cannot
 * be told). Inert before a hold-aware orchestrator ran for the macro (N2).
 */
export function laneWriterRefusal(workflowPath, frontmatter, { writer = LANE_WRITERS.plain, runId = null } = {}) {
  if (!LANE_WRITERS_CHECKED.has(writer)) return null;
  const child = macroChildOf(workflowPath, frontmatter);
  if (child === null) return null;
  if (writer === LANE_WRITERS.settlement && typeof runId === 'string'
    && [frontmatter.pending_ensemble, frontmatter.ensemble_results].some((rows) => Array.isArray(rows) && rows.some((e) => e?.run_id === runId))) {
    return null;
  }
  const { mainRoot, macroId, subtaskId } = child;
  const activation = readActivation(mainRoot, macroId);
  if (activation.state === 'inactive') return null;
  // A write of an operation open on the child: the command that opened it,
  // or one it runs (a review ledger, a manifest entry, a peer's launch).
  const doc = frontmatter[PERSONA_OPERATIONS_KEY];
  const later = doc !== undefined && doc.v > PERSONA_OPERATIONS_VERSION;
  // No machine job starts in a held lane, whatever operation is open (item 3).
  const job = writer === LANE_WRITERS.job;
  if (!job && !later && (doc?.ops ?? []).some((o) => !operationCleared(mainRoot, macroId, subtaskId, o.id))) return null;
  if (activation.state === 'unreadable') {
    return `the holds directory of ${macroId} cannot be read (${activation.error}), so whether subtask ${subtaskId} is held cannot be told` +
      (job ? '' : `, and no persona operation is open on ${frontmatter.workflow_id}`);
  }
  const applies = holdApplies(readOwnerHold(mainRoot, macroId, subtaskId), {
    branch: frontmatter.git_baseline?.branch ?? '', workflowId: frontmatter.workflow_id ?? null,
  });
  if (!applies.applies) return null;
  if (job) return `subtask ${subtaskId} of ${macroId} is held (${applies.why}), and no machine job starts in a held lane (item 3)`;
  return later
    ? `subtask ${subtaskId} of ${macroId} is held (${applies.why}), and the operations of ${frontmatter.workflow_id} are a later ` +
      `version (v ${doc.v}) than this ${personaName()} reads`
    : `subtask ${subtaskId} of ${macroId} is held (${applies.why}), and no persona operation is open on ${frontmatter.workflow_id}`;
}

// withFileLock's check, holding the workflow's lock: a path with no workflow
// yet (a create's, an archive's destination) is no write of a child.
async function admitLaneWriter(workflowPath, { writer, runId }) {
  if (!LANE_WRITERS_CHECKED.has(writer)) return;
  if (!capabilityOn('dispatch_target')) return;
  let text;
  try {
    text = await readFile(workflowPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
  const refusal = laneWriterRefusal(workflowPath, parseWorkflowFile(text).frontmatter, { writer, runId });
  if (refusal !== null) throw laneWriterError(refusal);
}

// The code a launch helper reads to stop before it spawns anything.
export const LANE_WRITER_REFUSED = 'AGENTIC_LANE_WRITER_REFUSED';
const laneWriterError = (refusal) => Object.assign(operationRefusal(
  `${refusal}: a write of a held lane's child outside a persona operation is refused. Work the lane through its ` +
    `active child's verbs, /engineer:commit or a gate resolution, or have the owner release it; nothing was written`,
), { code: LANE_WRITER_REFUSED });

// --- persona operations (N4) --------------------------------------------------
//
// An operation runs from a command's first write of a macro's child to its
// last. Its id travels between the command's shell blocks in a transport file
// the first write leaves in the command's operation directory
// (`--operation-dir`), and stays on the child (persona_operations) while open.
// A command passes no directory, or works on no macro's child: no operation,
// and every write is as before.

const operationRefusal = (message) => new Error(`${message} (ADR-0068 Decision 2, item 7)`);

// The child's open operations, or a refusal for a document of a later
// version, which this persona carries but never rewrites.
function childOperations(frontmatter) {
  const doc = frontmatter[PERSONA_OPERATIONS_KEY];
  if (doc === undefined) return [];
  if (doc.v > PERSONA_OPERATIONS_VERSION) {
    throw operationRefusal(
      `${PERSONA_OPERATIONS_KEY} of ${frontmatter.workflow_id} is a later version (v ${doc.v}) than this ` +
        `${personaName()} writes: install the ${personaName()} release that wrote it; nothing was written`,
    );
  }
  return doc.ops;
}

// No operation left: the key goes, so a child no operation touched again
// reads as one that never had any.
function setChildOperations(frontmatter, ops) {
  if (ops.length === 0) delete frontmatter[PERSONA_OPERATIONS_KEY];
  else frontmatter[PERSONA_OPERATIONS_KEY] = { v: PERSONA_OPERATIONS_VERSION, ops };
}

// Another operation open in the lane than `ownId`: an entry of the child, or
// a record under ops/<subtask>/ with no `.cleared` beside it, whoever opened
// it (N4). A description of it, or null.
function otherOpenOperation({ mainRoot, macroId, subtaskId }, ownId, entries, { records = true } = {}) {
  if (records) {
    const read = readOps(mainRoot, macroId, subtaskId);
    if (read.state === 'unreadable') return `the operation records of subtask ${subtaskId} cannot be read (${read.error})`;
    for (const e of read.ops) {
      if (e.id === ownId || e.cleared) continue;
      return `operation ${e.id}${typeof e.record?.kind === 'string' ? ` (${e.record.kind})` : ''}`;
    }
  }
  for (const e of entries) {
    if (e.id === ownId || operationCleared(mainRoot, macroId, subtaskId, e.id)) continue;
    return `operation ${e.id} (${e.kind})`;
  }
  return null;
}

const NO_OPERATION = Object.freeze({ id: null, inLock() {}, async after() {} });

// What runs after the write: never fails the command, whose write has landed
// (or was refused); what it could not do is said.
function afterWrite(what, fn) {
  try {
    fn();
  } catch (err) {
    process.stderr.write(`${personaName()}: ${what}: ${err.message}\n`);
  }
}

/**
 * N4 — the operation a command's first write opens (`point: 'open'`) or its
 * last write closes (`'close'`), as a step of that write: `inLock(frontmatter)`
 * runs holding the workflow's lock, before the write, and throws to refuse
 * it; `after(ok)` runs once the lock is released. With no operation directory,
 * or for a workflow that is no macro's child (or a persona with
 * dispatch_target off), there is none and the write is as before.
 *
 * `create` ({ repoRoot, parentWorkflow, originatingSubtask }) for a bootstrap,
 * whose child does not exist yet; else `workflowPath`.
 */
export async function prepareOperation({
  point, kind = 'verb', operationDir, workflowPath, create = null, host = 'claude', env = process.env, now = new Date(),
}) {
  if (operationDir === undefined || operationDir === null || operationDir === '') return NO_OPERATION;
  if (typeof operationDir !== 'string' || !isAbsolute(operationDir)) {
    throw new Error(`the operation directory must be an absolute path (got ${JSON.stringify(operationDir)})`);
  }
  if (point !== 'open' && point !== 'close' && point !== 'carry') {
    throw new Error(`an operation point is open, carry or close (got ${JSON.stringify(point)})`);
  }
  // Only a macro's child has operations: for any other workflow, and with
  // dispatch_target off, the directory is not looked at and the write is as
  // before.
  let child = null;
  let frontmatter = null;
  if (create !== null) {
    if (capabilityOn('dispatch_target') && isSafeMacroId(create.parentWorkflow) && isSafeSubtaskId(create.originatingSubtask)) {
      child = { macroId: create.parentWorkflow, subtaskId: create.originatingSubtask, mainRoot: holdsMainRoot(create.repoRoot) };
    }
  } else {
    ({ frontmatter } = await readWorkflow(workflowPath));
    child = macroChildOf(workflowPath, frontmatter);
  }
  if (child === null) return NO_OPERATION;
  let dirStat = null;
  try { dirStat = statSync(operationDir); } catch { /* below */ }
  if (dirStat === null || !dirStat.isDirectory()) {
    throw new Error(
      `the operation directory ${operationDir} is not a directory; nothing was written` +
        (point === 'close'
          ? '. When it is lost, run the write with no operation directory: the operation it opened stays open on the workflow until the owner clears it'
          : ''),
    );
  }
  if (point === 'open' && !PERSONA_OPERATION_KINDS.has(kind)) {
    throw new Error(`an operation kind is one of ${[...PERSONA_OPERATION_KINDS].join(', ')} (got ${JSON.stringify(kind)})`);
  }
  const transport = readOperationTransport(operationDir);
  if (transport.error) throw operationRefusal(`the operation file cannot be used: ${transport.error}; nothing was written`);
  const store = dirStore(operationDir);
  if (point === 'carry') return carryOperation({ child, operationDir, transport, frontmatter });
  return point === 'open'
    ? openOperation({ child, kind, operationDir, store, transport, frontmatter, create, host, env, now })
    : closeOperation({ child, operationDir, store, transport, frontmatter, now });
}

// A later write of the operation the directory names (`point: 'carry'`): it
// must be open on this child, so a write that means to continue an operation
// never lands once that operation ended, or for another child.
function carryOperation({ child, operationDir, transport, frontmatter }) {
  const t = transport.value;
  if (t === undefined || t.state !== 'open') {
    throw operationRefusal(
      `no open operation in ${operationDir}${t === undefined ? '' : ` (operation ${t.operation_id} is ${t.state})`}: ` +
        'a write that continues an operation takes the directory of one still open; nothing was written',
    );
  }
  if (t.macro_id !== child.macroId || t.subtask_id !== child.subtaskId || t.branch !== frontmatter.git_baseline?.branch
    || t.workflow_id !== frontmatter.workflow_id) {
    throw operationRefusal(
      `the operation file in ${operationDir} is operation ${t.operation_id} of ${t.workflow_id ?? 'a bootstrap'} in ${t.macro_id}/${t.subtask_id}, ` +
        `not of ${frontmatter.workflow_id}; nothing was written`,
    );
  }
  return {
    id: t.operation_id,
    inLock(fm) {
      if (!childOperations(fm).some((o) => o.id === t.operation_id)) {
        throw operationRefusal(`operation ${t.operation_id} is no longer open on ${fm.workflow_id}: it ended, or the owner cleared it; nothing was written`);
      }
    },
    async after() {},
  };
}

// Where an operation's id is kept between the writes of its command: the
// transport file of an operation directory, or, for a commit (`childStore`),
// the child's own entry.
function dirStore(operationDir) {
  return { write: (value) => writeOperationTransport(operationDir, value), announce: true };
}

/**
 * N4 — the commit's operation (`kind` commit), whose id is its entry on the
 * child: Phase 7 runs as one program, and the Stop hook that archives the
 * commit and sends its parent note after it finds the entry there, with no
 * directory of the command's. `point` is `open` (the first write: always a
 * new operation, so a second commit beside a running one is refused, and one
 * a crash left open is the owner's to clear, item 7), `close` (the last: the
 * operation `id` names, or, for the Stop hook, which knows no id, the newest
 * entry of the kind the owner has not cleared), or `once`, a command whose
 * one write is both (the staging-set gate an autopilot commit records, a
 * checkpoint): admitted as a first write is and refused as a last write is,
 * it leaves no entry.
 */
export async function prepareChildOperation({ point, kind, id = null, workflowPath, host = 'claude', env = process.env, now = new Date() }) {
  if (point !== 'open' && point !== 'close' && point !== 'once') {
    throw new Error(`a child operation point is open, close or once (got ${JSON.stringify(point)})`);
  }
  if (!PERSONA_OPERATION_KINDS.has(kind)) {
    throw new Error(`an operation kind is one of ${[...PERSONA_OPERATION_KINDS].join(', ')} (got ${JSON.stringify(kind)})`);
  }
  const { frontmatter } = await readWorkflow(workflowPath);
  const child = macroChildOf(workflowPath, frontmatter);
  if (child === null) return NO_OPERATION;
  const label = `${frontmatter.workflow_id}'s ${kind} operation`;
  const store = { write() {}, announce: false, label };
  let entry;
  if (point === 'close') {
    const ofKind = childOperations(frontmatter).filter((o) => o.kind === kind && (id === null || o.id === id));
    entry = ofKind.filter((o) => !operationCleared(child.mainRoot, child.macroId, child.subtaskId, o.id)).at(-1) ?? ofKind.at(-1);
  }
  const transport = entry === undefined
    ? { absent: true }
    : {
      value: {
        operation_id: entry.id, kind, macro_id: child.macroId, subtask_id: child.subtaskId,
        branch: frontmatter.git_baseline?.branch, workflow_id: frontmatter.workflow_id, opened_at: entry.opened_at, state: 'open',
      },
    };
  if (point === 'close') {
    if (transport.absent) return NO_OPERATION;
    return closeOperation({ child, operationDir: label, store, transport, frontmatter, now });
  }
  const opened = openOperation({ child, kind, operationDir: label, store, transport, frontmatter, create: null, host, env, now });
  if (point === 'open') return opened;
  return {
    id: opened.id,
    inLock(fm) {
      opened.inLock(fm);
      // Its one write is its last as well: refused, as any last write is, once
      // the owner cleared it, or when its record is gone (N4).
      if (opened.ext && operationCleared(child.mainRoot, child.macroId, child.subtaskId, opened.id)) {
        throw operationRefusal(`operation ${opened.id} was cleared by the owner (writer-clear) while it waited for the workflow's lock; nothing was written`);
      }
      if (opened.ext && opRecordState(child.mainRoot, child.macroId, child.subtaskId, opened.id) === 'absent') {
        throw operationRefusal(`the record of operation ${opened.id} is gone from the holds of ${child.macroId}; nothing was written`);
      }
      setChildOperations(fm, childOperations(fm).filter((o) => o.id !== opened.id));
    },
    async after() {
      if (opened.ext) afterWrite('removing the operation record', () => removeOpRecord(child.mainRoot, child.macroId, child.subtaskId, opened.id));
    },
  };
}

function openOperation({ child, kind, operationDir, store, transport, frontmatter, create, host, env, now }) {
  const { mainRoot, macroId, subtaskId } = child;
  const workflowId = frontmatter?.workflow_id ?? null;
  const branch = create !== null ? create.branch : frontmatter.git_baseline?.branch;
  let id;
  let openedAt;
  const replay = transport.value !== undefined;
  const replayOpen = transport.value?.state === 'open';
  if (replay) {
    // The same command's first write again (a block run twice, or after a
    // crash): it continues its operation. Any other is refused: another
    // child's or kind's, and a bootstrap's once its create landed (the file
    // then names the child, and a create never runs again from it).
    const t = transport.value;
    if (t.state === 'closed') {
      throw operationRefusal(
        `operation ${t.operation_id} in ${operationDir} has ended: a command's first write takes a fresh operation directory; nothing was written`,
      );
    }
    if (t.macro_id !== macroId || t.subtask_id !== subtaskId || t.kind !== kind || t.branch !== branch
      || t.workflow_id !== workflowId) {
      throw operationRefusal(
        `the operation file in ${operationDir} is operation ${t.operation_id} (${t.kind}) of ${t.workflow_id ?? 'a bootstrap'} in ` +
          `${t.macro_id}/${t.subtask_id}, not this one; use a fresh operation directory; nothing was written`,
      );
    }
    id = t.operation_id;
    openedAt = t.opened_at;
  } else {
    // A dispatched bootstrap continues the operation /orchestrator:next's
    // dispatch began, under the id it exported.
    const dispatched = create !== null ? env.AGENTIC_OPERATION_ID : undefined;
    if (dispatched !== undefined && dispatched !== '') {
      if (!OPERATION_ID_RE.test(dispatched)) {
        throw operationRefusal(`AGENTIC_OPERATION_ID ${JSON.stringify(dispatched)} is not an operation id; nothing was written`);
      }
      id = dispatched;
    } else {
      id = newOperationId(now);
    }
    openedAt = isoUtc(now);
  }
  const binding = { operation_id: id, kind, macro_id: macroId, subtask_id: subtaskId, branch, workflow_id: workflowId, opened_at: openedAt };
  const activation = readActivation(mainRoot, macroId);
  if (activation.state === 'unreadable') {
    throw operationRefusal(
      `the holds directory of ${macroId} cannot be read, so whether subtask ${subtaskId} is held cannot be told: ` +
        `${activation.error}; nothing was written (ADR-0068 Decision 2, item 8)`,
    );
  }
  // The id is kept before anything names it: a crash from here on leaves a
  // first write the same command continues.
  store.write({ ...binding, state: transport.value?.state === 'open' ? 'open' : 'opening' });
  const ext = activation.state === 'active';
  let published = false;
  if (ext) {
    // Published before the write takes its locks, then the lane is looked at
    // again: two first writes at once may both refuse, never both proceed.
    const pub = publishOpRecord(mainRoot, macroId, subtaskId, { ...binding, host, pid: process.pid });
    // A record of the id already there is this operation's (its first write
    // run again, or the dispatch's own record a dispatched bootstrap
    // continues) only when it names this kind, lane and child, or no child yet.
    const ex = pub.existing;
    if (!pub.published && (ex === null || ex.kind !== kind || (ex.macro_id ?? macroId) !== macroId
      || (ex.subtask_id ?? subtaskId) !== subtaskId || (ex.workflow_id != null && ex.workflow_id !== workflowId))) {
      throw operationRefusal(`${pub.path} is not a record of this operation ${id} (${kind}); nothing was written`);
    }
    published = pub.published;
    const other = otherOpenOperation(child, id, frontmatter === null ? [] : childOperations(frontmatter));
    if (other !== null) {
      if (published) afterWrite('withdrawing the operation record', () => removeOpRecord(mainRoot, macroId, subtaskId, id));
      throw operationRefusal(
        `${other} is open in subtask ${subtaskId} of ${macroId}: one persona operation at a time in a lane; ` +
          'wait for it to end, or, when its session is gone, have the owner clear it (agentic-autopilot writer-clear); nothing was written',
      );
    }
  }
  let boundWorkflow = workflowId;
  return {
    id,
    ext,
    inLock(fm) {
      let ops = childOperations(fm);
      // Whether the macro's holds are active is read again holding the lock:
      // a first write that read them inactive, and meets them active (or
      // unreadable) here, would join a lane it never looked at.
      const atLock = readActivation(mainRoot, macroId);
      if (atLock.state !== activation.state) {
        throw operationRefusal(
          `the holds of ${macroId} turned ${atLock.state} while this write waited for the workflow's lock; run it again; nothing was written`,
        );
      }
      const own = ops.find((o) => o.id === id);
      // A first write run again after its operation ended (its last write ran,
      // or the owner cleared it) does not open it again.
      if (replayOpen && own === undefined) {
        throw operationRefusal(
          `operation ${id} in ${operationDir} is no longer open on ${fm.workflow_id}: it ended, or the owner cleared it; a command's first write takes a fresh operation directory; nothing was written`,
        );
      }
      if (ext) {
        const other = otherOpenOperation(child, id, ops, { records: false });
        if (other !== null) {
          throw operationRefusal(
            `${other} is open on ${fm.workflow_id}: one persona operation at a time in a lane; nothing was written`,
          );
        }
        // An entry the owner cleared is no longer open: it goes with this
        // write, its own last write being refused whatever it finds.
        ops = ops.filter((o) => o.id === id || !operationCleared(mainRoot, macroId, subtaskId, o.id));
      }
      // Run again across activation, the entry records the record this run
      // published, so its last write removes it.
      if (own === undefined) ops = [...ops, { id, kind, opened_at: openedAt, ext }];
      else if (ext && !own.ext) ops = ops.map((o) => (o === own ? { ...o, ext: true } : o));
      setChildOperations(fm, ops);
      boundWorkflow = fm.workflow_id;
    },
    async after(ok) {
      if (ok) {
        afterWrite('recording the operation', () => store.write({ ...binding, workflow_id: boundWorkflow, state: 'open' }));
        if (store.announce) process.stderr.write(`operation ${id} (${kind}) is open; its directory is ${operationDir}\n`);
      } else if (published) {
        afterWrite('withdrawing the operation record', () => removeOpRecord(mainRoot, macroId, subtaskId, id));
      }
    },
  };
}

function closeOperation({ child, operationDir, store, transport, frontmatter, now }) {
  const { mainRoot, macroId, subtaskId } = child;
  if (transport.absent) {
    // This command opened no operation here (an earlier runbook, or no
    // first write of its own): the write is as before, and an operation the
    // child keeps open stays open.
    const doc = frontmatter[PERSONA_OPERATIONS_KEY];
    const open = doc?.v === PERSONA_OPERATIONS_VERSION ? doc.ops : [];
    if (open.length > 0) {
      process.stderr.write(
        `${personaName()}: no operation file in ${operationDir}; ${open.map((o) => o.id).join(', ')} stays open on ${frontmatter.workflow_id}\n`,
      );
    }
    return NO_OPERATION;
  }
  const t = transport.value;
  const id = t.operation_id;
  if (t.macro_id !== macroId || t.subtask_id !== subtaskId || t.branch !== frontmatter.git_baseline?.branch
    || (t.workflow_id !== null && t.workflow_id !== frontmatter.workflow_id)) {
    throw operationRefusal(
      `the operation file in ${operationDir} is operation ${id} of ${t.workflow_id ?? 'a bootstrap'} in ${t.macro_id}/${t.subtask_id}, ` +
        `not of ${frontmatter.workflow_id}; nothing was written`,
    );
  }
  if (t.state === 'closed') {
    throw operationRefusal(`operation ${id} has ended: its last write already ran; nothing was written`);
  }
  let ext = false;
  return {
    id,
    inLock(fm) {
      const ops = childOperations(fm);
      // Read at the write, holding its lock: the owner's clear, and the
      // record's presence, as they are now.
      const activation = readActivation(mainRoot, macroId);
      if (activation.state === 'active' && operationCleared(mainRoot, macroId, subtaskId, id)) {
        throw operationRefusal(
          `operation ${id} was cleared by the owner (writer-clear), so its last write is refused: another command may ` +
            `be writing in the lane now; nothing was written`,
        );
      }
      const entry = ops.find((o) => o.id === id);
      if (entry === undefined) {
        throw operationRefusal(`operation ${id} is not open on ${fm.workflow_id}: its last write already ran; nothing was written`);
      }
      if (entry.kind !== t.kind) {
        throw operationRefusal(`operation ${id} is a ${entry.kind} operation on ${fm.workflow_id}, not the ${t.kind} its file names; nothing was written`);
      }
      if (activation.state === 'active') {
        if (entry.ext && opRecordState(mainRoot, macroId, subtaskId, id) === 'absent') {
          throw operationRefusal(`the record of operation ${id} is gone from the holds of ${macroId}, so its last write is refused; nothing was written`);
        }
      } else if (activation.state === 'inactive' && entry.ext) {
        throw operationRefusal(
          `operation ${id} registered with the holds of ${macroId}, whose marker is gone, so its last write is refused; nothing was written`,
        );
      }
      // Unreadable: a running operation finishes (N2).
      setChildOperations(fm, ops.filter((o) => o !== entry));
      ext = entry.ext;
    },
    async after(ok) {
      if (!ok) return;
      if (ext) afterWrite('removing the operation record', () => removeOpRecord(mainRoot, macroId, subtaskId, id));
      const { schema: _schema, ...kept } = t;
      afterWrite('recording the operation ended', () => store.write({
        ...kept, workflow_id: kept.workflow_id ?? frontmatter.workflow_id, state: 'closed', closed_at: isoUtc(now),
      }));
    },
  };
}

// The write `fn` with the operation's steps: after(true) once it landed,
// after(false) when it threw.
async function withOperation(operation, fn) {
  let result;
  try {
    result = await fn();
  } catch (err) {
    await operation.after(false);
    throw err;
  }
  await operation.after(true);
  return result;
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
  // `{ gate, anchor | pointer, runId? }`: the owner judgment this verb stops
  // on; a conflict gate names the run whose synthesis set it (ADR-0067
  // Decision 8).
  ownerGate,
  // ADR-0068 Decision 5 — with the next step `verify`, the request the step's
  // file holds ({checks, on_pass, confidence}, parsed JSON). Only that kind
  // takes one.
  verifyRequest,
  env = process.env,
  // The checkout the step runs in: the tested tree a request's paths name.
  cwd = process.cwd(),
  now = new Date(),
  emitHandoff = false,
  // ADR-0068 Decision 2 (N4) — the verb's operation directory: finish-verb is
  // its last write, and closes the operation its first write opened.
  operationDir,
}) {
  if (nextStep === undefined || nextStep === null) {
    throw new Error('finish-verb records the next step: the kind and the confidence are required (ADR-0063 D6)');
  }
  if (ownerGate !== undefined && nextStep.kind !== 'owner-decision') {
    throw new Error(
      `an owner gate goes with the next step owner-decision (got ${JSON.stringify(nextStep.kind)}) (ADR-0063 D4)`,
    );
  }
  if (nextStep.kind === 'verify') {
    if (verifyRequest === undefined) {
      throw new Error('finish-verb --next-step-kind verify takes the request as --verify-request-file (ADR-0068 Decision 5, item 2)');
    }
    const result = await recordVerifyRequest({ workflowPath, host, nextAction, nextStep, input: verifyRequest, env, cwd, now, operationDir });
    return { ...result, mode: 'autopilot', terminal: false };
  }
  if (verifyRequest !== undefined) {
    throw new Error(`a request file goes with the next step verify (got ${JSON.stringify(nextStep.kind)}) (ADR-0068 Decision 5)`);
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
      clearTerminalMarker: true, dropVerifyRequest: true, event: 'updated', env, now,
      operationDir, closeOperation: Boolean(operationDir),
    });
    return { ...result, mode: autopilot ? 'autopilot' : 'interactive', terminal: false };
  }
  // ADR-0068 Decision 2, item 6 — an interactive verb of a macro's child
  // leaves the terminal marker unset, as under autopilot, while its subtask is
  // held or has a kept park, or a run of its macro is live; only once a
  // hold-aware orchestrator runs for the macro. Decided holding the lock, in
  // the write itself (setTerminal holdAware).
  const result = await setTerminal({
    workflowPath,
    host,
    terminalPhase: 'summary-complete',
    terminalMarker: true,
    nextAction,
    nextStep,
    dropVerifyRequest: true,
    event: 'updated',
    env,
    now,
    emitHandoff,
    holdAware: true,
    operationDir,
  });
  if (result.held !== null) return { ...result, mode: 'interactive', terminal: false };
  const { held: _none, ...closed } = result;
  return { ...closed, mode: 'interactive', terminal: true };
}

// -----------------------------------------------------------------------------
// ADR-0068 Decision 5 — the checks a step requests and the driver's results
// (`verify-record-cli`). The forms are lib/verify.mjs's; this section binds
// them to a workflow under its lock. Every write records host_history
// `updated`: the event enum is closed (VALID_HOOK_EVENTS), and an older reader
// must read the file again once the next step is no longer `verify`.

const STEP_RE = /^[1-9][0-9]{0,8}$/;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

// git as the verify section reads it: no replace ref stands in for an object
// (`--no-replace-objects`), and no inherited GIT_* variable (GIT_DIR,
// GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_CONFIG_*, ...) points it at another
// repository, object store or configuration than the checkout's own. What it
// reads is still the step's own claim (lib/verify.mjs header): the driver
// reads the declaration itself.
function gitOut(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  try {
    return execFileSync('git', ['--no-replace-objects', '-C', cwd, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024 });
  } catch {
    return null;
  }
}

// The declaration at a commit of the repository `dir` is a checkout of, or
// `{ problem }`.
function declarationAt(dir, commit) {
  const text = gitOut(dir, ['show', `${commit}:${VERIFY_DECLARATION_PATH}`]);
  if (text === null) return { problem: `the repository's declaration (${VERIFY_DECLARATION_PATH}) at ${commit}` };
  try {
    return { declaration: parseDeclaration(text) };
  } catch (err) {
    return { problem: `a readable declaration at ${commit} (${err.message})` };
  }
}

/**
 * ADR-0068 Decision 5, item 11 — whether this step may write `verify`: an
 * autopilot run (autopilotMode active: Claude, dispatch_target on, a run
 * named) whose driver offers verification, telling the step the commit the
 * run started from (AGENTIC_AUTOPILOT_VERIFY) and its step number
 * (AGENTIC_AUTOPILOT_STEP), with the repository's declaration at that
 * commit. `{ on: true, commit, step, declaration }`, or `{ on: false,
 * missing }` naming the first part missing. The driver numbers each step and,
 * when it offers verification, sets AGENTIC_AUTOPILOT_VERIFY to the commit the
 * run started from (worker.mjs); its workers' environment scrubs an inherited
 * one, so only the driver's offer reaches a step.
 */
export function verifyOffer({ env = process.env, host = 'claude', cwd = process.cwd() } = {}) {
  const mode = autopilotMode({ env, host });
  if (!mode.active) {
    return { on: false, missing: mode.ignored ? mode.reason : 'an autopilot run (AGENTIC_AUTOPILOT names none): an interactive step has no driver to run its checks' };
  }
  const commit = env.AGENTIC_AUTOPILOT_VERIFY ?? '';
  if (!COMMIT_SHA_RE.test(commit)) {
    return { on: false, missing: 'the run\'s offer (AGENTIC_AUTOPILOT_VERIFY, the 40-hex commit the run started from): this run does not offer verification' };
  }
  const stepText = env.AGENTIC_AUTOPILOT_STEP ?? '';
  if (!STEP_RE.test(stepText)) {
    return { on: false, missing: 'the step number (AGENTIC_AUTOPILOT_STEP, a positive integer)' };
  }
  const read = declarationAt(cwd, commit);
  if (read.problem) return { on: false, missing: read.problem };
  return { on: true, commit, step: Number(stepText), runId: env.AGENTIC_AUTOPILOT, declaration: read.declaration };
}

/**
 * The attempt a write is made in, under an autopilot run (autopilotMode
 * active): `{run_id, step}` when the driver numbers its steps (the step's
 * number, AGENTIC_AUTOPILOT_STEP, well formed), whether or not the run offers
 * verification: the driver of this release numbers every step it starts. A
 * driver of an earlier release numbers none, and its steps write `{run_id}`.
 * Null outside any run (an owner's write, an interactive session's). The
 * offer and the declaration are not read: a verb ending with another next
 * step needs neither.
 */
export function verifyAttemptOf({ env = process.env, host = 'claude' } = {}) {
  if (!autopilotMode({ env, host }).active) return null;
  const run = { run_id: env.AGENTIC_AUTOPILOT };
  const stepText = env.AGENTIC_AUTOPILOT_STEP ?? '';
  if (!STEP_RE.test(stepText)) return run;
  return { ...run, step: Number(stepText) };
}

const attemptLabel = (a, other) => {
  const step = a.step === undefined ? 'a step' : `step ${a.step}`;
  return a.run_id === other.run_id ? step : `${step} of ${a.run_id}`;
};

/**
 * ADR-0068 Decision 5, item 7 — a stale attempt never moves the record back.
 * The attempt mark binds the step that last wrote the workflow under an
 * autopilot run to the handoff that write left and its generation
 * (handoffDigest, stampHandoff, lib/verify.mjs header). Every write of a
 * workflow is held to it at the one point every writer passes, its file lock
 * (withFileLock): the lock admits the write or refuses it before the writer
 * reads the record (this function), and the record's write moves the mark on
 * (markAttempt, writeWorkflow; markBeside for a file kept beside it). No
 * writer is listed: a checkpoint, a snapshot, a manifest entry, an archive,
 * the review ledger and a consensus task are held as a next step is, the
 * files beside the workflow moved on before they are written (markBeside). A
 * workflow created under a run is admitted against the marks of the workflows
 * archived on its branch (admitCreation) and records the creating step's mark
 * in the same write (createWorkflowUnderLock).
 *
 * Refused, for a write under an autopilot run (`attempt`), whatever it
 * changes: when the mark names a later attempt (a later step of the same
 * run, or a later run: run ids carry their start), or a run started in the
 * same second, whose order cannot be told; from the step the mark names, when
 * the record no longer holds the handoff that step last left at the
 * generation it left it, so any change of the handoff since, whoever made it,
 * makes the step's attempt stale, even one undone since; and beside a mark or
 * a generation a later release wrote, which this release does not read.
 *
 * A step starts at its first write: every verb's Phase 0 writes the workflow
 * before anything else, and the driver numbers each step it starts
 * (AGENTIC_AUTOPILOT_STEP), whether or not the run offers verification. So a
 * step started after a change is not held to it: an owner who clears a gate
 * while the run is live leaves the run's next step free to write, and only
 * the step before it stale. A note alone changes no handoff (handoffDigest),
 * so it stales no step.
 *
 * Not held: a write outside any run (`attempt` null), which leaves the mark
 * as it is, so a change it makes stales the step the mark names.
 *
 * Earlier releases (lib/verify.mjs header): a writer that keeps no
 * generation moves none, so an A to B and back to A in which it takes part is
 * not seen; and a driver that numbers no step starts steps that carry only
 * their run, which order runs only: such a step is taken in the mark's own
 * run while the mark names no step either, and refused beside a step of its
 * run, which it cannot be ordered against. The limit ends once both hosts run
 * this release.
 */
function admitAttempt(frontmatter, before, attempt) {
  const mark = frontmatter.verify_attempt;
  if ((mark !== undefined && isNewerRecord(mark)) || before.generation === null) {
    const newer = mark !== undefined && isNewerRecord(mark) ? `verify_attempt (v ${mark.v})` : `verify_handoff (v ${frontmatter.verify_handoff.v})`;
    throw new Error(
      `${newer} was written by a later release; this release writes no workflow under an autopilot run beside it ` +
        '(lib/verify.mjs header)',
    );
  }
  if (mark === undefined) return { bound: false };
  const order = orderAgainstMark(attempt, mark, 'which last wrote the handoff');
  if (order === null) return { bound: false };
  const bound = order === 0;
  if (bound && (before.digest !== mark.handoff || before.generation !== mark.generation)) {
    throw new Error(
      `the handoff changed since step ${attempt.step} last wrote it (the next step, the phase, the verb, the terminal ` +
        'marker, the owner gate, the pending peer runs, or the request and its results), even if it was changed back: ' +
        'a late write of that step records nothing, and a later step writes the handoff',
    );
  }
  return { bound };
}

// The order of `attempt` against `mark` (`what` names the write the mark
// records): 0 for the step the mark names, positive for a later attempt, null
// for a step with no number beside a mark of its own run that names none
// either (it binds nothing). Refused when the attempt is older, or cannot be
// ordered against the mark.
function orderAgainstMark(attempt, mark, what) {
  if (attempt.step === undefined && attempt.run_id === mark.run_id) {
    if (mark.step === undefined) return null;
    throw new Error(
      `a step of ${attempt.run_id} that carries no number cannot be ordered against step ${mark.step} of its own run, ` +
        `${what}, so nothing is written`,
    );
  }
  // A mark a step with no number moved on orders runs only: every numbered
  // step of that run comes after it.
  const order = mark.step === undefined && attempt.run_id === mark.run_id ? 1 : compareAttempts(attempt, mark);
  if (Number.isNaN(order)) {
    throw new Error(`${attempt.run_id} and ${mark.run_id}, ${what}, started in the same second: their order cannot be told, so nothing is written`);
  }
  if (order < 0) {
    throw new Error(`${attemptLabel(attempt, mark)} is older than ${attemptLabel(mark, attempt)}, ${what}: a stale attempt records nothing`);
  }
  return order;
}

// The whole text of `file`, or null when it is not a regular file: opened
// without blocking, so a FIFO is seen, never waited on.
function readRegularText(file) {
  const fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(fd).isFile()) return null;
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * A creation under an autopilot run (`attempt`), admitted against the marks
 * of the workflows archived on its branch (`roots`, the roots the creation
 * searches for an active one): a workflow archived by a later step stands, so
 * a delayed creation of an earlier step, or of an earlier run, is refused
 * before the file lands (orderAgainstMark), and the branch never holds a
 * fresh workflow carrying the stale step's request. The step the mark names is
 * held to the handoff it left (admitAttempt's equal-attempt check), so its late
 * creation is refused once the handoff changed. A record without a mark is
 * passed over; one with a mark that cannot be read, or that a later release
 * wrote, refuses the creation.
 */
async function admitCreation(roots, branch, attempt) {
  for (const root of roots) {
    for (const home of homeNames()) {
      const dir = statePaths(root, home).archive;
      let names;
      try {
        names = await readdir(dir);
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      for (const name of names.sort()) {
        if (!name.endsWith('.md')) continue;
        const file = join(dir, name);
        // The frontmatter only, from a regular file opened without blocking,
        // as the workflows home's reader reads it: a FIFO in the archive is
        // refused, never waited on, and the long body of a record that opens
        // an LF frontmatter is never read whole.
        let text;
        try {
          text = readFrontmatterText(file);
          // A record that opens no LF frontmatter (a CRLF one, a note) gives
          // the head reader no end to stop at, so it is read whole, from a
          // descriptor of its own, and judged on that text alone, as every
          // record was before the head reader: whether a read was complete is
          // never rebuilt from decoded text or a second lookup.
          if (text !== null && !text.startsWith('---\n')) text = readRegularText(file);
        } catch (err) {
          if (err.code === 'ENOENT' || err.code === 'EISDIR') continue;
          throw err;
        }
        // A directory holds no mark, and is passed over, as before.
        if (text === null && statSync(file, { throwIfNoEntry: false })?.isDirectory()) continue;
        if (text === null) {
          throw new Error(
            `the archived workflow ${safeFilename(file)} is not a regular file, so its attempt mark cannot be read; ` +
              'a creation under an autopilot run is not admitted beside it. Remove it or replace it with the workflow file.',
          );
        }
        // The mark is sought in the frontmatter the parser reads, up to its
        // close delimiter ("\n---\n", parseWorkflowFile's), never at a line
        // that merely opens with "---". A record that opens no LF frontmatter
        // has none the parser reads, so a mark anywhere in it counts. A line
        // starts after "\n" only, as the parser splits lines: never after a
        // U+2028 or U+2029 a request holds, which the `m` flag would take.
        const end = text.startsWith('---\n') ? text.indexOf('\n---\n', 4) : -1;
        if (!/(?:^|\n)verify_attempt:/.test(end < 0 ? text : text.slice(0, end))) continue;
        // The branch exempts a record only from a frontmatter the parser
        // reads: in one that opens none (a BOM, a preamble), the extractor
        // would take a branch named in the body, so it is unknown, and the
        // parse below refuses.
        const fmBranch = text.startsWith('---\n') ? extractFrontmatterBranch(text) : null;
        if (fmBranch !== null && fmBranch !== branch) continue;
        let fm;
        try {
          fm = parseWorkflowFile(text).frontmatter;
        } catch (err) {
          throw new Error(
            `the archived workflow ${safeFilename(file)} records an attempt mark that cannot be read (${err.message}); ` +
              'a creation under an autopilot run is not admitted beside it',
          );
        }
        if (fm.git_baseline?.branch !== branch) continue;
        const mark = fm.verify_attempt;
        // The parser is the judge of what the record holds: a record it reads
        // with no mark is passed over.
        if (mark === undefined) continue;
        if (isNewerRecord(mark)) {
          throw new Error(
            `the archived workflow ${fm.workflow_id} records verify_attempt (v ${mark.v}), written by a later release; ` +
              'this release creates no workflow under an autopilot run beside it (lib/verify.mjs header)',
          );
        }
        // The step the mark names is held to the handoff it left, as
        // admitAttempt holds it: once the owner changed it before archiving,
        // that step's late creation records nothing.
        const order = orderAgainstMark(attempt, mark, `which last wrote ${fm.workflow_id}, archived on branch ${branch}`);
        const left = handoffState(fm);
        if (order === 0 && (left.digest !== mark.handoff || left.generation !== mark.generation)) {
          throw new Error(
            `the handoff of ${fm.workflow_id}, archived on branch ${branch}, changed since step ${attempt.step} last wrote it: ` +
              'a late creation of that step records nothing',
          );
        }
      }
    }
  }
}

/**
 * The write half of the hold (admitAttempt): once the record a write admitted
 * under an autopilot run is whole, move the mark on to its attempt and the
 * handoff it leaves, when it writes a next step (`nextStep`) or a request,
 * changes the handoff, or is a later attempt than the mark's, or the first
 * (whether or not it changes the handoff, so a step of an earlier run is
 * stale against it). A step with no number moves a mark of its own run that
 * names none on to the same run, which binds no step. A request is refused from the step that already
 * recorded one once that request is no longer pending (`since` says what took
 * it). `held` is what the lock admitted: the attempt, the handoff as found,
 * whether the mark names this step, and the mark.
 */
function markAttempt(frontmatter, held, { nextStep = false, request = false, since = null } = {}) {
  const { attempt, before, bound, mark } = held;
  if (bound && request && mark.requested === true && since !== null) {
    throw new Error(`step ${attempt.step}'s request was ${since} since; a later step records a request of its own`);
  }
  if (mark !== undefined) {
    const changed = nextStep || request || handoffDigest(frontmatter) !== before.digest;
    if (bound && !changed) return;
  }
  stampHandoff(frontmatter, before);
  frontmatter.verify_attempt = {
    v: VERIFY_RECORD_VERSION, run_id: attempt.run_id, ...(attempt.step !== undefined ? { step: attempt.step } : {}),
    requested: request || (bound && mark.requested === true),
    handoff: frontmatter.verify_handoff.handoff, generation: frontmatter.verify_handoff.generation,
  };
  validateSchema14Fields(frontmatter);
}

/**
 * Admit a write of `workflowPath` under an autopilot run (admitAttempt),
 * holding its lock: null outside any run, or for a file that does not exist
 * yet, else what markAttempt moves the mark on from.
 */
async function admitWrite(workflowPath, { env, host }) {
  const attempt = verifyAttemptOf({ env, host });
  if (attempt === null) return null;
  let text;
  try {
    text = await readFile(workflowPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  const { frontmatter } = parseWorkflowFile(text);
  const before = handoffState(frontmatter);
  const { bound } = admitAttempt(frontmatter, before, attempt);
  return { attempt, before, bound, mark: frontmatter.verify_attempt };
}

/**
 * The text a write of a workflow record leaves: when its lock admitted it
 * under an autopilot run (`ownership.held`), held to the attempt mark
 * (markAttempt) first; the handoff stamped in every case
 * (assembleWorkflowFile).
 */
function workflowText(frontmatter, body, ownership, flags) {
  if (ownership?.held) markAttempt(frontmatter, ownership.held, flags);
  return assembleWorkflowFile(frontmatter, body);
}

// Write a workflow record under its lock (`ownership`, as withFileLock gives
// it): the attempt mark moved on (workflowText), then the atomic write.
async function writeWorkflow(workflowPath, frontmatter, body, ownership, flags) {
  await atomicWrite(workflowPath, workflowText(frontmatter, body, ownership, flags), ownership);
}

// Before a write beside the workflow (its review ledger, a consensus task
// file, a move of either) that its lock admitted under an autopilot run: the
// mark moves on as a write of the workflow that changes nothing would, so a
// step whose first write is one beside the workflow is bound like any other.
// It comes first, an admitted write of the workflow itself: a failure or a
// kill before the side write leaves the mark on this step, and the step it
// replaced stays refused. A step the mark already names (`bound`) leaves it as
// it is.
async function markBeside(workflowPath, ownership) {
  if (!ownership?.held || ownership.held.bound) return;
  const { frontmatter, body } = parseWorkflowFile(await readFile(workflowPath, 'utf8'));
  await writeWorkflow(workflowPath, frontmatter, body, ownership);
}

// The verify commands read and write only records of this release's form; a
// record a later release wrote (a higher `v`) is carried, never interpreted
// (lib/verify.mjs header).
function refuseNewerRecords(frontmatter, what) {
  const newer = VERIFY_KEYS.filter((k) => isNewerRecord(frontmatter[k]));
  if (newer.length > 0) {
    throw new Error(
      `${newer.map((k) => `${k} (v ${frontmatter[k].v})`).join(', ')} was written by a later release than this one, ` +
        `which writes v ${VERIFY_RECORD_VERSION}; ${what} is left to that release (lib/verify.mjs header)`,
    );
  }
}

// The tested tree (item 5): the checkout this process runs in, which must be
// a checkout of the workflow's repository (one git common dir) on the
// workflow's branch. The stored repo_root is never taken for it.
function testedTree(cwd, workflowPath, frontmatter) {
  const top = gitOut(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  if (!top) throw new Error(`the tested tree cannot be told: ${cwd} is not in a git checkout`);
  const common = (dir) => {
    const out = gitOut(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])?.trim();
    if (!out) return null;
    try { return realpathSync(out); } catch { return out; }
  };
  const mine = common(top);
  const theirs = common(dirname(workflowPath));
  if (mine === null || theirs === null || mine !== theirs) {
    throw new Error(`the checkout ${top} is not a checkout of the repository that holds ${workflowPath}; a request is recorded from the workflow's own checkout`);
  }
  const branch = gitOut(top, ['branch', '--show-current'])?.trim() ?? '';
  if (branch !== frontmatter.git_baseline?.branch) {
    throw new Error(`the checkout ${top} is on ${JSON.stringify(branch)}, not the workflow's branch ${JSON.stringify(frontmatter.git_baseline?.branch)}`);
  }
  return top;
}

// The workflow's own state a request needs: active, waiting on nobody. The
// phase says whether it is terminal: a marker an interactive verb left on is
// not the state of a workflow a later verb resumed (its Phase 0 moves the
// phase on and keeps the marker), and the request turns that marker off.
// `settling` (verify-request-check only) names the peer run the finalize
// settles before its last write: that one pending entry is not counted.
function assertRequestable(frontmatter, { settling = null } = {}) {
  if (terminalPhases().has(frontmatter.current_phase)) {
    throw new Error(`the workflow is terminal (${frontmatter.current_phase}); a request is recorded only by an active workflow`);
  }
  const pending = (Array.isArray(frontmatter.pending_ensemble) ? frontmatter.pending_ensemble : [])
    .filter((e) => settling === null || settling === '' || e?.run_id !== settling);
  if (pending.length > 0) {
    throw new Error(
      `a peer ensemble is still pending (${pending.map((e) => e.run_id).join(', ')}); ` +
        'collect it and settle it first — the next step is published only once the step is settled (ADR-0063 D5)',
    );
  }
  if (frontmatter.awaiting_owner_gate !== undefined) {
    throw new Error(`owner gate ${frontmatter.awaiting_owner_gate} is set; a workflow waiting on its owner records no request`);
  }
}

function historyUpdated(frontmatter, host, nowIso) {
  frontmatter.updated_at = nowIso;
  frontmatter.host_history = [...(frontmatter.host_history ?? []), { host, at: nowIso, event: 'updated' }];
}

// The request's own rules, before any workflow is read: the next step is
// `verify` with no verb, the file parses as a request, and its confidence is
// the next step's. Shared by finish-verb and verify-request-check.
function verifyRequestInput(nextStep, input) {
  const fields = normalizeNextStep(nextStep, { allowVerify: true });
  if ('next_step_verb' in fields) throw new Error('next step verify names no verb: the step that follows a batch is the request\'s on_pass');
  const parsed = parseRequestInput(input, { verbs: VALID_VERBS });
  if (parsed.confidence !== fields.next_step_confidence) {
    throw new Error(`--next-step-confidence ${fields.next_step_confidence} is not the request's confidence ${parsed.confidence}`);
  }
  return { fields, parsed };
}

// The request bound to this step and this workflow, as finish-verb records
// it: the offer, the workflow's state, the tested tree, each check against the
// declaration at the offer's commit and each path argument against the tree.
// One function for the write and for verify-request-check, so the check a
// finalize runs before its first write refuses exactly what the last write
// would (`settling` aside: the peer run the finalize settles first). The
// record a new request becomes (`request`, null for a retry of the stored
// one) is built here too, so its size is held to the cap in both.
function bindVerifyRequest(frontmatter, { workflowPath, parsed, env, host, cwd, settling = null, now = new Date() }) {
  const offer = verifyOffer({ env, host, cwd });
  if (!offer.on) {
    throw new Error(`next step verify is refused: missing ${offer.missing} (ADR-0068 Decision 5, item 11)`);
  }
  refuseNewerRecords(frontmatter, 'recording a request');
  assertRequestable(frontmatter, { settling });
  const tree = testedTree(cwd, workflowPath, frontmatter);
  for (const check of parsed.checks) resolveCheck(offer.declaration, check, { tree });
  const bound = {
    workflow_id: frontmatter.workflow_id,
    run_id: offer.runId,
    step: offer.step,
    baseline: offer.commit,
    declaration_digest: offer.declaration.digest,
    checks: parsed.checks,
    on_pass: parsed.on_pass,
    confidence: parsed.confidence,
  };
  const id = verifyRequestId(bound);
  const stored = frontmatter.verify_request;
  if (stored?.id === id) return { bound, id, request: null };
  const request = {
    v: VERIFY_RECORD_VERSION, id, ...bound, recorded_at: isoUtc(now),
    previous: stored ? previousOf(stored, frontmatter.verify_results) : null,
  };
  if (scalarBytes('verify_request', request) > MAX_REQUEST_BYTES) {
    throw new Error(`the request takes more than ${MAX_REQUEST_BYTES} bytes; ask for fewer checks`);
  }
  // The record is held to its reader's rules here, the ones every later read
  // of the workflow applies, so no request passes the check that the stored
  // record would refuse.
  validateStoredRequest(request, { verbs: VALID_VERBS });
  return { bound, id, request };
}

/**
 * verify-request-check: whether finish-verb --next-step-kind verify would
 * take this request now, written nowhere. A finalize runs it before its first
 * write (the peer run's settle), so a request the last write would refuse
 * stops the block with the workflow as it was, never with half a handoff
 * written (ADR-0068 Decision 5, `verify-runbooks`). `settling` is the peer
 * run that settle pops first, the one pending entry not counted. Returns
 * `{ ok: true, request_id }`; throws finish-verb's message otherwise.
 */
export async function checkVerifyRequest({
  workflowPath, host, nextStep, input, env = process.env, cwd = process.cwd(), settling = null,
}) {
  validateHost(host);
  const { parsed } = verifyRequestInput(nextStep, input);
  const { frontmatter } = parseWorkflowFile(await readFile(workflowPath, 'utf8'));
  const { id } = bindVerifyRequest(frontmatter, { workflowPath, parsed, env, host, cwd, settling });
  return { ok: true, request_id: id };
}

/**
 * finish-verb --next-step-kind verify: record the step's request and the next
 * step `verify` in one locked write. Every check runs inside the lock: the
 * offer, the workflow's state, the tested tree, each check against the
 * declaration at the offer's commit and each path argument against the tree.
 * A retry of the same request (same id) leaves the stored one untouched,
 * recorded_at included; a new one replaces it, deletes the old results, and
 * keeps the old request's last ended batch as `previous`.
 */
export async function recordVerifyRequest({
  workflowPath, host, nextAction, nextStep, input, env = process.env, cwd = process.cwd(), now = new Date(),
  // ADR-0068 Decision 2 (N4) — as setTerminal's: the last write closes it.
  operationDir,
}) {
  validateHost(host);
  const { fields, parsed } = verifyRequestInput(nextStep, input);
  const operation = await prepareOperation({ point: 'close', operationDir, workflowPath, host, env, now });
  return withOperation(operation, () => withFileLock(workflowPath, async (ownership) => {
    const { frontmatter, body } = parseWorkflowFile(await readFile(workflowPath, 'utf8'));
    const { request } = bindVerifyRequest(frontmatter, { workflowPath, parsed, env, host, cwd, now });
    operation.inLock(frontmatter);
    const stored = frontmatter.verify_request;
    // A stale attempt never rolls the record back (admitAttempt, markAttempt):
    // the mark (`verify_attempt`) outlives the request and binds the step that
    // last wrote the handoff to what it left, so a late retry neither reopens
    // the driver's writes nor replaces a newer handoff.
    const pending = frontmatter.next_step_kind === 'verify' && stored !== undefined && stored.answered_by === undefined;
    const since = pending ? null
      : stored === undefined ? 'dropped by a verb that ended with another next step'
        : stored.answered_by !== undefined ? `answered by batch ${stored.answered_by}` : 'taken up by a verb';
    let unchanged = false;
    if (request === null) {
      unchanged = true;
    } else {
      frontmatter.verify_request = request;
      delete frontmatter.verify_results;
    }
    for (const k of NEXT_STEP_KEYS) delete frontmatter[k];
    Object.assign(frontmatter, fields);
    if (nextAction !== undefined) frontmatter.next_action = nextAction;
    if (frontmatter.terminal_marker === true) frontmatter.terminal_marker = false;
    historyUpdated(frontmatter, host, isoUtc(now));
    // The record is checked whole, the mark it moves on included.
    const text = workflowText(frontmatter, body, ownership, { request: true, since });
    validateSchema14Fields(frontmatter);
    await atomicWrite(workflowPath, text, ownership);
    return { frontmatter, workflowPath, request: frontmatter.verify_request, retried: unchanged };
  }, { env, host, writer: writerOf(operation) }));
}

// The request a driver write is for: still pending (the next step `verify`,
// the request named), so a write delayed past the requesting verb's Phase 0,
// or past a newer request, is refused.
function pendingRequest(frontmatter, requestId) {
  if (frontmatter.next_step_kind !== 'verify' || frontmatter.verify_request === undefined) {
    throw new Error('no request is pending on this workflow (its next step is not verify): a verb has taken it up since');
  }
  if (frontmatter.verify_request.id !== requestId) {
    throw new Error(`the pending request is ${frontmatter.verify_request.id}, not ${requestId}: a newer request replaced it`);
  }
  return frontmatter.verify_request;
}

// The request's own results (they are deleted with a replaced request).
function ownResults(frontmatter, requestId) {
  const res = frontmatter.verify_results;
  return res?.request_id === requestId ? res : null;
}

const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const startOf = (b) => ({
  batch_id: b.batch_id, run_id: b.run_id, continues: b.continues, tree_start: b.tree_start,
  declaration_commit: b.declaration_commit, declaration_digest: b.declaration_digest,
  checks: b.checks, checks_digest: b.checks_digest, started_at: b.started_at,
});

// One locked write for the driver's commands. `apply(frontmatter)` checks and
// changes the record in place and returns 'changed', or 'unchanged' for a
// replay identical to what is stored, which writes nothing: a record identical
// to the stored one is a no-op whatever the state since, and a different one
// for the same batch or index is refused, so a result is never overwritten.
// `writer` (LANE_WRITERS): a batch's start or restart is `job`, so none starts
// in a held lane (ADR-0068 Decision 2, item 3); its results, end and pass are
// `machine`, a job that was running when the hold was set (item 4).
async function verifyWrite({ workflowPath, host, now = new Date(), env = process.env, writer = LANE_WRITERS.job }, apply) {
  validateHost(host);
  // The driver runs outside any run, so its writes are an owner's to the mark
  // (withFileLock): one made from a step is held to it.
  return withFileLock(workflowPath, async (ownership) => {
    const { frontmatter, body } = parseWorkflowFile(await readFile(workflowPath, 'utf8'));
    refuseNewerRecords(frontmatter, 'a driver\'s write');
    if (apply(frontmatter) === 'unchanged') return { unchanged: true };
    historyUpdated(frontmatter, host, isoUtc(now));
    // The record is checked whole, the mark it moves on included.
    const text = workflowText(frontmatter, body, ownership);
    validateSchema14Fields(frontmatter);
    await atomicWrite(workflowPath, text, ownership);
    return { recorded: true };
  }, { env, host, writer });
}

// What a start and a restart both hold a batch to, none of it about earlier
// batches: the declaration at `declaration_commit`, read by the persona and
// held to `declaration_digest`; the request's worker checks, as it resolves
// them; and the batch's worst-case results beside `kept`, the batches the
// write keeps, within the budget, so no later write fails on size.
function admitStart(workflowPath, request, start, kept) {
  const read = declarationAt(dirname(workflowPath), start.declaration_commit);
  if (read.problem) throw new Error(`batch ${start.batch_id}: the persona cannot read ${read.problem}`);
  if (read.declaration.digest !== start.declaration_digest) {
    throw new Error(`batch ${start.batch_id}: the declaration at ${start.declaration_commit} has digest ${read.declaration.digest}, not the batch's ${start.declaration_digest}`);
  }
  const mismatch = workerChecksProblem(read.declaration, request, start);
  if (mismatch) throw new Error(mismatch);
  const worst = worstCaseBytes(kept, start);
  if (worst > MAX_RESULTS_BYTES) {
    throw new Error(`batch ${start.batch_id}'s results could take ${worst} bytes, more than the ${MAX_RESULTS_BYTES} a workflow keeps; split the checks`);
  }
}

/**
 * verify-batch-start: the driver starts a batch for the pending request. Its
 * digest is recomputed from its argv list; its worker checks are the
 * request's, in order, each with the argv the declaration it names
 * (read at `declaration_commit`, its digest held to `declaration_digest`)
 * resolves the request's check to; one batch is open at a time; and the
 * batch's worst-case results must fit the budget after retention, so no
 * later write fails on size.
 *
 * Item 7: a request's first batch continues nothing, and a later one only
 * the request's latest batch, ended cut short: a batch that passed, failed or
 * ended with no evidence is followed by on_pass or the verb, never by another
 * batch. Taken up on the same tree with the same commands, the continuation
 * starts with the latest batch's passed results carried into it, and goes on
 * from its first check that did not pass (`carryOver`). A record the driver
 * cannot trust is set aside whole with `verify-batch-restart` instead.
 */
export async function recordBatchStart({ workflowPath, host, requestId, input, now }) {
  const start = parseBatchStart(input);
  return verifyWrite({ workflowPath, host, now }, (fm) => {
    const known = ownResults(fm, requestId)?.batches.find((b) => b.batch_id === start.batch_id);
    if (known) {
      if (same(startOf(known), start)) return 'unchanged';
      throw new Error(`batch ${start.batch_id} is already recorded with another start; a record is never overwritten`);
    }
    const request = pendingRequest(fm, requestId);
    const batches = ownResults(fm, requestId)?.batches ?? [];
    const open = batches.find((b) => b.end === undefined);
    if (open) throw new Error(`batch ${open.batch_id} is still open; it ends before another starts`);
    const latest = batches.at(-1) ?? null;
    if (latest && start.started_at < latest.started_at) {
      throw new Error(`batch ${start.batch_id} starts before batch ${latest.batch_id}, the latest: a stale start`);
    }
    if (latest === null && start.continues !== null) {
      throw new Error(`batch ${start.batch_id} continues ${start.continues}, but request ${requestId} has no batch yet`);
    }
    if (latest !== null) {
      if (latest.end !== 'cut-short') {
        throw new Error(`batch ${latest.batch_id}, the request's latest, ended ${latest.end}: only a batch cut short is taken up again, and nothing else follows a batch that ended`);
      }
      if (start.continues !== latest.batch_id) {
        throw new Error(`batch ${start.batch_id} continues ${start.continues ?? 'nothing'}, not ${latest.batch_id}, the request's latest batch, cut short`);
      }
    }
    const carried = latest ? carryOver(latest, start) : [];
    const kept = { v: 1, request_id: requestId, batches: retainBatches(batches) };
    admitStart(workflowPath, request, start, kept);
    fm.verify_results = { ...kept, batches: [...kept.batches, { ...start, results: carried }] };
    return 'changed';
  });
}

/**
 * verify-batch-restart: the driver sets aside the pending request's whole
 * record (every batch, open or ended, with its results, ends and carried
 * results) and starts the request again whole, in one write (lib/verify.mjs
 * header: no untrusted record decides whether a check runs). The batch is a
 * start that continues nothing and carries nothing, held to every rule of an
 * ordinary start that is not about earlier batches (the declaration at
 * `declaration_commit`, the request's worker checks, the digest), its
 * worst-case results sized against an empty history. `replaces` names the
 * record the driver read: the sha256 of the stored `verify_results` text
 * (`results_digest` in verify-results), or null when there is none; any
 * other record is refused as stale, so a delayed replay never erases later
 * results. A replay identical to a recorded batch writes nothing.
 */
export async function recordBatchRestart({ workflowPath, host, requestId, replaces, input, now }) {
  const start = parseBatchStart(input);
  if (start.continues !== null) {
    throw new Error(`a restart continues nothing (batch ${start.batch_id} continues ${start.continues}): it sets every earlier batch aside`);
  }
  if (replaces !== null && !(typeof replaces === 'string' && /^[0-9a-f]{64}$/.test(replaces))) {
    throw new Error('replaces is not the 64-hex digest of the stored verify_results (results_digest), or null when there are none');
  }
  return verifyWrite({ workflowPath, host, now }, (fm) => {
    const known = ownResults(fm, requestId)?.batches.find((b) => b.batch_id === start.batch_id);
    if (known) {
      if (same(startOf(known), start)) return 'unchanged';
      throw new Error(`batch ${start.batch_id} is already recorded with another start; a record is never overwritten`);
    }
    const request = pendingRequest(fm, requestId);
    const stored = resultsDigest(fm.verify_results);
    if (replaces !== stored) {
      throw new Error(`the stored results are ${stored ?? 'none'}, not ${replaces ?? 'none'}, the record this restart sets aside: a stale restart records nothing`);
    }
    const empty = { v: 1, request_id: requestId, batches: [] };
    admitStart(workflowPath, request, start, empty);
    fm.verify_results = { ...empty, batches: [{ ...start, results: [] }] };
    return 'changed';
  });
}

/** verify-result: one check's result, in index order, never after a check that did not pass. */
export async function recordResult({ workflowPath, host, requestId, batchId, input, now }) {
  const result = parseResult(input);
  return verifyWrite({ workflowPath, host, now, writer: LANE_WRITERS.machine }, (fm) => {
    const known = ownResults(fm, requestId)?.batches.find((b) => b.batch_id === batchId);
    const stored = known?.results.find((r) => r.index === result.index);
    if (stored) {
      if (same(stored, result)) return 'unchanged';
      throw new Error(`check ${result.index} of batch ${batchId} already has a result; a result is never overwritten`);
    }
    pendingRequest(fm, requestId);
    if (!known) throw new Error(`no batch ${batchId} of request ${requestId} is recorded`);
    const problem = resultProblem(known, result);
    if (problem) throw new Error(problem);
    known.results.push(result);
    return 'changed';
  });
}

/** verify-batch-end: how the batch ended, consistent with its results and trees. */
export async function recordBatchEnd({ workflowPath, host, requestId, batchId, input, now }) {
  const end = parseEnd(input);
  return verifyWrite({ workflowPath, host, now, writer: LANE_WRITERS.machine }, (fm) => {
    const known = ownResults(fm, requestId)?.batches.find((b) => b.batch_id === batchId);
    if (known?.end !== undefined) {
      const stored = { tree_end: known.tree_end, end: known.end, cause: known.cause, ended_at: known.ended_at };
      if (same(stored, end)) return 'unchanged';
      throw new Error(`batch ${batchId} has already ended (${known.end}); an end is never overwritten`);
    }
    pendingRequest(fm, requestId);
    if (!known) throw new Error(`no batch ${batchId} of request ${requestId} is recorded`);
    const problem = endProblem(known, end);
    if (problem) throw new Error(`batch ${batchId}: ${problem}`);
    Object.assign(known, end);
    return 'changed';
  });
}

/**
 * verify-pass: the request's latest batch ended `passed`, so its `on_pass`
 * becomes the next step, and the request records the batch that answered it.
 * The request and its results stay readable for the step that follows.
 */
export async function recordPass({ workflowPath, host, requestId, batchId, now }) {
  return verifyWrite({ workflowPath, host, now, writer: LANE_WRITERS.machine }, (fm) => {
    if (fm.verify_request?.id === requestId && fm.verify_request.answered_by !== undefined) {
      if (fm.verify_request.answered_by === batchId) return 'unchanged';
      throw new Error(`request ${requestId} was answered by batch ${fm.verify_request.answered_by}, not ${batchId}`);
    }
    const request = pendingRequest(fm, requestId);
    const latest = ownResults(fm, requestId)?.batches.at(-1);
    if (!latest || latest.batch_id !== batchId) throw new Error(`batch ${batchId} is not request ${requestId}'s latest batch`);
    if (latest.end !== 'passed') throw new Error(`batch ${batchId} ended ${latest.end ?? 'not yet'}, not passed: only a passing batch takes on_pass`);
    for (const k of NEXT_STEP_KEYS) delete fm[k];
    fm.next_step_kind = request.on_pass.kind;
    if (request.on_pass.kind === 'verb') fm.next_step_verb = request.on_pass.verb;
    fm.next_step_confidence = request.on_pass.confidence;
    fm.verify_request = { ...request, answered_by: batchId };
    return 'changed';
  });
}

/**
 * verify-results: the request, its previous answer and its batches, each
 * check's evidence and whether it applies, and `results_digest`, the record a
 * restart names as the one it sets aside.
 */
export async function readVerifyResults({ workflowPath, treeDigest = null, currentTree = false, cwd = process.cwd() }) {
  if (treeDigest !== null && currentTree) throw new Error('--tree-digest and --current-tree are two answers to one question: give one');
  if (treeDigest !== null && !(typeof treeDigest === 'string' && /^[0-9a-f]{64}$/.test(treeDigest))) throw new Error('--tree-digest is not a 64-hex digest');
  const { frontmatter } = await readWorkflow(workflowPath);
  refuseNewerRecords(frontmatter, 'reading its results');
  // The tree is digested only when there is a result to judge: with no
  // request a resume prints nothing, and reads no tree for it.
  const digest = currentTree && frontmatter.verify_request !== undefined ? currentTreeDigest(testedTree(cwd, workflowPath, frontmatter)) : treeDigest;
  return {
    pending: frontmatter.next_step_kind === 'verify',
    results_digest: resultsDigest(frontmatter.verify_results),
    ...(currentTree ? { tree_digest: digest } : {}),
    ...readResults(frontmatter.verify_request ?? null, frontmatter.verify_results ?? null, { treeDigest: digest }),
  };
}

// The orchestrator's lock fence in a lane: its bookkeeping, not the lane's
// content (lane-digest.mjs).
const LANE_WORKTREE_LOCK_REL = '.agentic-plugins/runs/autopilot/worktree.lock';

/**
 * The tested tree's digest as the driver takes it at a batch's start and end
 * (Decision 2, item 7; the orchestrator's scripts/lib/lane-digest.mjs
 * treeDigest, version 1): sha256 over `git write-tree` of every non-ignored
 * file, through a temporary index seeded from a copy of the checkout's own
 * (its assume-unchanged and skip-worktree bits cleared, every entry racily
 * clean), the orchestrator's lock fence left out, HEAD, and each checked-out
 * submodule's own digest (an uninitialized one by its gitlink). The two are
 * held equal by tests/persona-pipeline/test-verify-runbooks.mjs: a result
 * `applies` now only when its batch's tree is this one. No inherited GIT_*
 * variable reaches git; the checkout's real index is never touched.
 */
export function currentTreeDigest(top) {
  const unscoped = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const git = (cwd, args, extra = {}) => execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...unscoped, ...extra }, maxBuffer: 256 * 1024 * 1024, timeout: 120_000,
  });
  const root = git(top, ['rev-parse', '--show-toplevel']).trim();
  const realIndex = resolvePath(root, git(root, ['rev-parse', '--git-path', 'index']).trim());
  const dir = mkdtempSync(join(tmpdir(), 'agentic-tree-digest-'));
  const index = join(dir, 'index');
  try {
    if (existsSync(realIndex)) {
      copyFileSync(realIndex, index);
      utimesSync(index, 1, 1);
    }
    const withIndex = { GIT_INDEX_FILE: index };
    const hidden = git(root, ['ls-files', '-v', '-z'], withIndex).split('\0').filter(Boolean)
      .filter((l) => /^[a-zS] /.test(l)).map((l) => l.slice(2));
    for (const flag of ['--no-assume-unchanged', '--no-skip-worktree']) {
      for (let i = 0; i < hidden.length; i += 500) git(root, ['update-index', flag, '--', ...hidden.slice(i, i + 500)], withIndex);
    }
    git(root, ['add', '-A', '--', '.'], withIndex);
    git(root, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', LANE_WORKTREE_LOCK_REL], withIndex);
    const tree = git(root, ['write-tree'], withIndex).trim();
    let head = null;
    try { head = git(root, ['rev-parse', '--verify', '-q', 'HEAD']).trim(); } catch { head = null; }
    const h = createHash('sha256').update(`tree ${tree}\nhead ${head ?? 'none'}\n`);
    const links = git(root, ['ls-files', '-s', '-z'], withIndex).split('\0').filter((l) => l.startsWith('160000 '));
    for (const l of links.sort()) {
      const rel = l.slice(l.indexOf('\t') + 1);
      const sub = join(root, rel);
      h.update(`submodule ${rel} ${existsSync(join(sub, '.git')) ? currentTreeDigest(sub) : `gitlink ${l.split(' ')[1]}`}\n`);
    }
    return h.digest('hex');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SUMMARY_FAILING_SHOWN = 5;

/**
 * The resume's summary of verify-results (`--format text`): a few lines a verb
 * reads before it acts, bounded (the latest batch only, at most five failing
 * tests a check, each as the driver cut it). Empty when the workflow holds no
 * request. It names, for each check, its kind and command, its outcome, whether
 * it is evidence (it ran to its end on an unchanged tree) and whether it
 * applies to the tree now, its failing tests, and its log under the run
 * directory of the run that recorded it.
 */
export function formatVerifySummary(read) {
  if (!read.request) return '';
  const q = read.request;
  const state = read.pending ? 'pending: the driver has not answered it yet'
    : read.answered_by ? `answered by batch ${read.answered_by}, which passed`
      : 'taken up: the driver resumed this verb with its results';
  const last = read.batches.at(-1);
  // The rows below list the last batch's checks: the request's, and those the
  // driver added (origin driver), counted apart.
  const added = last ? last.checks.filter((c) => c.origin === 'driver').length : 0;
  const counted = `${q.checks.length} check(s) requested${added > 0 ? `, ${added} added by the driver` : ''}`;
  const lines = [`Verification request ${q.id} (step ${q.step} of run ${q.run_id}; ${counted}; on_pass ${q.on_pass.kind}${q.on_pass.verb ? ` ${q.on_pass.verb}` : ''}): ${state}.`];
  if (!last) {
    lines.push('- No batch has run yet.');
  } else {
    const tree = last.tree_end !== null && last.tree_end !== last.tree_start ? '; the tree changed during the batch, so none of it is evidence' : '';
    lines.push(`- Batch ${last.batch_id}: ${last.end === null ? 'still open (no end recorded)' : `ended ${last.end}${last.cause ? ` (${last.cause})` : ''}`}${tree}.`);
    for (const c of last.checks) {
      const r = c.result;
      const command = Array.isArray(c.argv) ? c.argv.join(' ') : c.kind;
      const outcome = r === null ? 'not run' : `${r.outcome}${r.exit !== null && r.exit !== undefined ? ` (exit ${r.exit})` : r.signal ? ` (${r.signal})` : ''}`;
      const applies = c.applies === null ? 'unknown' : c.applies ? 'yes' : 'no';
      lines.push(`  ${c.index + 1}. ${c.kind} [${c.origin}] ${command}: ${outcome}; evidence ${c.evidence ? 'yes' : 'no'}; applies to the tree now: ${applies}.`);
      if (r && r.failing_tests.length > 0) {
        const shown = r.failing_tests.slice(0, SUMMARY_FAILING_SHOWN);
        const more = r.failing_tests.length - shown.length + (r.failing_tests_more ?? 0);
        lines.push(`     failing: ${shown.join(' | ')}${more > 0 ? ` (and ${more} more)` : ''}`);
      }
      if (r && c.recorded_by) {
        lines.push(typeof r.log === 'string' && r.log !== ''
          ? `     log: .agentic-plugins/runs/autopilot/${c.recorded_by.run_id}/${r.log} (in the checkout the run was launched from)`
          : '     log: none was kept for this check');
      }
    }
  }
  if (read.previous) lines.push(`- The request before it ended ${read.previous.end}.`);
  return `${lines.join('\n')}\n`;
}

export { VERIFY_RECORD_CAPABILITY };

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
  // As every writer's: the attempt mark (withFileLock, ADR-0068 Decision 5).
  env = process.env,
}) {
  requireCapability('dispatch_target', 'setParentWritebackMarker');
  validateHost(host);
  if (typeof at !== 'string' || at.length === 0) {
    throw new Error('setParentWritebackMarker: at must be a non-empty string');
  }
  return withFileLock(workflowPath, async (ownership) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    const nowIso = isoUtc(now);
    frontmatter.parent_writeback_at = at;
    frontmatter.updated_at = nowIso;
    frontmatter.host_history = [
      ...(frontmatter.host_history ?? []),
      { host, at: nowIso, event: 'updated' },
    ];
    await writeWorkflow(workflowPath, frontmatter, body, ownership);
    return { frontmatter, workflowPath };
  }, { env, host, writer: LANE_WRITERS.plain });
}

/**
 * ADR-0028 §P10 — clear the parent_writeback_at write-ahead marker on
 * writeback failure. Idempotent: a missing marker leaves the file
 * unchanged. Phase 7 calls this when writebackParent returns a
 * failure, so the record says the writeback did not happen; the Stop
 * hook's call is the retry.
 */
export async function clearParentWritebackMarker({
  workflowPath, host, now = new Date(), env = process.env,
}) {
  requireCapability('dispatch_target', 'clearParentWritebackMarker');
  validateHost(host);
  return withFileLock(workflowPath, async (ownership) => {
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
    await writeWorkflow(workflowPath, frontmatter, body, ownership);
    return { frontmatter, workflowPath };
  }, { env, host, writer: LANE_WRITERS.plain });
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
export async function beginCommit({ workflowPath, host, env = process.env, now = new Date() }) {
  requireCapability('commit_surface', 'beginCommit');
  validateHost(host);
  // ADR-0068 Decision 2, item 7 (N4) — the commit's first write opens its
  // operation, which runs through the archive and the parent note after it
  // (closeArchivedCommit), or ends where the commit stops (endChildOperation).
  const operation = await prepareChildOperation({ point: 'open', kind: 'commit', workflowPath, host, env, now });
  // A write of the handoff (the phase, the marker), held to the attempt mark
  // (withFileLock, ADR-0068 Decision 5).
  return withOperation(operation, () => withFileLock(workflowPath, async (ownership) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    const nowIso = isoUtc(now);
    operation.inLock(frontmatter);
    frontmatter.current_phase = 'phase-7-commit';
    if (frontmatter.terminal_marker === true) frontmatter.terminal_marker = false;
    frontmatter.updated_at = nowIso;
    frontmatter.host_history = [
      ...(frontmatter.host_history ?? []),
      { host, at: nowIso, event: 'updated' },
    ];
    await writeWorkflow(workflowPath, frontmatter, body, ownership);
    return { frontmatter, workflowPath, operation: operation.id };
  }, { env, host, writer: writerOf(operation) }));
}

/**
 * N4 — end the child's open operation of `kind` with a write of its own, the
 * operation's last: only the entry goes (no `host_history` event, no
 * `updated_at`), so it is no progress (`policy.mjs` `childTuple`). Phase 7
 * calls it where a commit stops before its terminal write, and the Stop hook
 * after an archived commit's parent note (closeArchivedCommit); an archived
 * workflow (`archived`) holds no workflow of a run, so its lock admits no
 * attempt. `{ closed: true, id }`, or `{ closed: false }` when the child keeps
 * no such operation; a refused close (cleared by the owner, or its record
 * gone) throws, leaving the entry.
 */
export async function endChildOperation({ workflowPath, kind, id = null, host, env = process.env, now = new Date(), archived = false }) {
  validateHost(host);
  const operation = await prepareChildOperation({ point: 'close', kind, id, workflowPath, host, env, now });
  if (operation.id === null) return { closed: false };
  await withOperation(operation, () => withFileLock(workflowPath, async (ownership) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    operation.inLock(frontmatter);
    await writeWorkflow(workflowPath, frontmatter, body, ownership);
  }, archived ? { hold: false, writer: writerOf(operation) } : { env, host, writer: writerOf(operation) }));
  return { closed: true, id: operation.id };
}

/**
 * N4 — open (`openOperation`, the kind) or close (`closeOperation`) the
 * command's operation in its operation directory with a write of its own that
 * moves only the child's entry (no `host_history` event, no `updated_at`), so
 * it is no progress (`policy.mjs` `childTuple`): /peer-now registers its
 * consultation before the launch, since nothing it does before writes the
 * workflow, and ends it so when no note follows. A workflow that is no
 * macro's child is not written. `{ written, id }`.
 */
export async function bookkeepOperation({
  workflowPath, host, operationDir, openOperation, closeOperation = false, env = process.env, now = new Date(),
}) {
  validateHost(host);
  if ((openOperation !== undefined) === closeOperation) {
    throw new Error('an operation write opens its operation (--open-operation <kind>) or closes it (--close-operation true)');
  }
  if (operationDir === undefined || operationDir === null || operationDir === '') {
    throw new Error('an operation write takes the command\'s operation directory (--operation-dir)');
  }
  const operation = await prepareOperation({
    point: closeOperation ? 'close' : 'open', kind: openOperation, operationDir, workflowPath, host, env, now,
  });
  if (operation.id === null) return { written: false, id: null };
  await withOperation(operation, () => withFileLock(workflowPath, async (ownership) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    operation.inLock(frontmatter);
    await writeWorkflow(workflowPath, frontmatter, body, ownership);
  }, { env, host, writer: writerOf(operation) }));
  return { written: true, id: operation.id };
}

/**
 * ADR-0068 Decision 2, item 7 — the commit's operation runs through its
 * archive and the parent note after it: the Stop hook calls this once both
 * ran, on the archived file. A refusal (the owner cleared the operation, or
 * its record is gone) is reported and leaves the entry; it never fails the
 * hook.
 */
export async function closeArchivedCommit({ archivedPath, host, stderr = process.stderr, now = new Date() }) {
  try {
    return await endChildOperation({ workflowPath: archivedPath, kind: 'commit', host, now, archived: true });
  } catch (err) {
    stderr.write(`${personaName()}: the commit's operation on ${archivedPath} stays open: ${err.message}\n`);
    return { closed: false, error: err.message };
  }
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
  // Both writes, the mark and the archive, held to the attempt mark
  // (withFileLock, ADR-0068 Decision 5).
  env = process.env,
}) {
  requireCapability('dispatch_target', 'detachArchive');
  validateHost(host);
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new Error('detachArchive: repoRoot is required (non-empty string)');
  }

  // ADR-0068 Decision 2, items 7 and 8 — the orchestrator's lifecycle archive
  // (abort, finalize) is a persona operation (kind `archive`) from the mark to
  // the archive, which ends it: admitted as a first write is (one at a time in
  // the lane, none while the holds cannot be read), so abort and finalize
  // archive a held lane's child, and a crash between the two leaves it open
  // for the owner (item 7).
  const operation = await prepareChildOperation({ point: 'open', kind: 'archive', workflowPath, host, env, now });

  // Step 1 — mark `parent_detached: true` + `terminal_marker: false`
  // under the per-file lock. The `parent_detached` field is already
  // in FRONTMATTER_KEY_ORDER + validateSchema11Fields (PR-A); we just
  // set the boolean and let the serializer preserve key order.
  await withOperation(operation, () => withFileLock(workflowPath, async (ownership) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    const nowIso = isoUtc(now);
    operation.inLock(frontmatter);
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
    await writeWorkflow(workflowPath, frontmatter, body, ownership);
  }, { env, host, writer: writerOf(operation) }));

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
    env,
    // Its last write: the entry leaves with the archived bytes.
    ...(operation.id === null ? {} : { closeOperationKind: 'archive', closeOperationId: operation.id }),
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
  // As every writer's: the attempt mark (withFileLock, ADR-0068 Decision 5).
  env = process.env,
  // ADR-0068 Decision 2 (N4) — the kind of the child's operation this archive
  // ends, as its last write (Phase 7's close: `commit`): its entry leaves
  // with the archived bytes, and its record goes once the archive's locks are
  // released.
  closeOperationKind,
  // N4 — or the kind of the operation this archive is the one write of
  // (/resume archive: `archive`): admitted as a first write, refused as a last.
  onceOperationKind,
  // That operation's step holding the source's lock (the call above passes it).
  inLock = () => {},
  // The id of the operation `closeOperationKind` ends, when the caller knows it
  // (detachArchive); else the newest of the kind the owner has not cleared.
  closeOperationId = null,
  // ADR-0068 Decision 2, item 7 — the source lock's writer class
  // (LANE_WRITERS): `operation` when the call above steps one, else `plain`,
  // so an archive of a held lane's child outside any operation is refused.
  writer = LANE_WRITERS.plain,
}) {
  validateHost(host);
  if (!repoRoot && !archiveDirectory) {
    throw new Error('archiveWorkflow: repoRoot or archiveDirectory is required');
  }
  if (closeOperationKind !== undefined && onceOperationKind !== undefined) {
    throw new Error('archiveWorkflow: an archive closes an operation or is one, not both');
  }
  if (closeOperationKind !== undefined || onceOperationKind !== undefined) {
    // A source already gone is no write: no operation is opened for it.
    if (onceOperationKind !== undefined && !(await pathStat(workflowPath))) {
      return { archived: false, reason: 'source-missing', workflowPath };
    }
    const operation = await prepareChildOperation(closeOperationKind !== undefined
      ? { point: 'close', kind: closeOperationKind, id: closeOperationId, workflowPath, host, env, now }
      : { point: 'once', kind: onceOperationKind, workflowPath, host, env, now });
    // The operation the caller names ends here or the archive does not run:
    // gone (cleared, and a later first write took its entry away), it is no
    // longer the caller's to end, and an archive outside it could ride
    // another operation's entry.
    if (closeOperationId !== null && operation.id === null) {
      throw operationRefusal(
        `operation ${closeOperationId} (${closeOperationKind}) is no longer open on ${workflowPath}: the owner cleared it, or it ended; nothing was archived`,
      );
    }
    let result;
    try {
      result = await archiveWorkflow({
        workflowPath, host, repoRoot, archiveDirectory, recheck, now, env, inLock: operation.inLock, writer: writerOf(operation),
      });
    } catch (err) {
      await operation.after(false);
      throw err;
    }
    await operation.after(result.archived === true);
    return result;
  }
  // ADR-0067 Decision 4, item 2 — the record's own home wins over the
  // caller's checkout: a workflow under the default state root, archived by
  // a Stop in a linked worktree, goes to its own home's archive, not that
  // checkout's. The home is read from the resolved path: a relative path
  // names a file under this process's directory, whatever repoRoot names.
  const inferred = workflowStorage(workflowPath);
  const effectiveRepoRoot = inferred?.stateRoot ?? repoRoot;
  const sourceHome = inferred?.home ?? 'canonical';
  const targetDir = archiveDirectory ?? archiveDir(effectiveRepoRoot, { home: sourceHome });
  const baseName = basename(workflowPath);

  // The directory lock must hash to the same `.creation-lock` path
  // `withDirectoryLock`/`createWorkflow` use for the source state home.
  // When the caller provided only `archiveDirectory`, derive the root
  // from the four-deep workflow layout
  // (`<root>/<state-home>/workflows/<id>.md`). Codex re-review M-1
  // caught the previous two-deep derivation that double-appended the
  // state home, producing a different lock path and breaking
  // serialization with createWorkflow / archive.
  const dirLockRoot =
    effectiveRepoRoot ??
    dirname(dirname(dirname(dirname(workflowPath))));
  const sourceStorage = effectiveRepoRoot
    ? statePaths(dirLockRoot, sourceHome)
    : await resolveWorkflowStorage(dirLockRoot, { mode: 'write' });

  return withCreationLocks(sourceStorage, async () => {
    const sourceStat = await pathStat(workflowPath);
    if (!sourceStat) {
      return { archived: false, reason: 'source-missing', workflowPath };
    }
    if (!sourceStat.isFile()) {
      throw new Error(`archiveWorkflow: source is not a regular file: ${workflowPath}`);
    }

    await ensureDir(targetDir, 0o700);

    return withFileLock(workflowPath, async (ownership) => {
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
      inLock(frontmatter);
      const nowIso = isoUtc(now);
      frontmatter.updated_at = nowIso;
      frontmatter.host_history = [
        ...(frontmatter.host_history ?? []),
        { host, at: nowIso, event: 'archived' },
      ];
      const archivedBytes = workflowText(frontmatter, body, ownership);
      let current = text;
      // The source lock is still this archive's and the active file still
      // holds the bytes it read: checked first, at the commit of each write
      // the archive makes (the mark below and the destination, as their
      // `precommit`), and again before the source is removed. A writer that
      // reclaimed the aged lock, or changed the file under the same token,
      // may have written newer state, so a stale archive refuses and leaves
      // the active file as it is, never overwriting or archiving away the
      // newer bytes. A reclaim between that check and the rename is the
      // window atomicWrite's own token check has at every write.
      const stillHeld = async () =>
        (await holdsLock(ownership)) && (await readFile(workflowPath, 'utf8').catch(() => null)) === current;
      const reclaimed = () =>
        new Error(
          `archiveWorkflow: the lock on ${workflowPath} was reclaimed as stale by another writer, or the file changed ` +
            'since this archive read it: nothing is archived, and the active workflow is left as it is',
        );
      // A write whose `precommit` no longer held is this archive's refusal,
      // reported as the reclaim it is.
      const precommitted = async (write) => {
        try {
          return await write();
        } catch (err) {
          if (err?.code === 'EPRECOMMIT') throw reclaimed();
          throw err;
        }
      };
      if (!(await stillHeld())) throw reclaimed();
      // Under an autopilot run the archive moves the mark on in the active
      // file before the destination is published, as markBeside does for a
      // write beside the workflow: a failure or a kill before the source is
      // removed leaves this step's mark there, and the step before it
      // refused. Only the mark moves, so an archive that fails leaves no
      // `archived` event in a workflow still active.
      if (ownership?.held && !ownership.held.bound) {
        const marked = parseWorkflowFile(text);
        const marking = workflowText(marked.frontmatter, marked.body, ownership);
        // The mark commits only over the bytes this archive read.
        await precommitted(() => atomicWrite(workflowPath, marking, ownership, { precommit: stillHeld }));
        current = marking;
      }

      // Resolve + write the destination under a retry loop. Codex
      // re-review M-2 flagged that pre-lock pathStat + post-lock
      // atomicWrite leaves a lost-candidate race: two archive runs from
      // different repoRoots writing to the same custom archive dir can
      // both choose the same absent candidate before either takes its
      // destination lock. The retry loop closes that window: under the
      // destination lock we re-stat the path and bail to a fresh
      // candidate if someone won the race.
      // The destination is published only while the source's lock and bytes
      // are still this archive's, at the commit itself.
      const destination = await precommitted(() => archiveCandidateWithRaceRetry({
        targetDir,
        baseName,
        now,
        archivedBytes,
        precommit: stillHeld,
      }));
      // Source-remove is best-effort durable: if it fails after a
      // successful destination write, the workflow is duplicated rather
      // than lost. Caller can re-archive (idempotent — second run sees
      // source-missing-after-lock). A lock lost while the destination was
      // written takes the destination back.
      if (!(await stillHeld())) {
        await unlink(destination).catch(() => {});
        throw reclaimed();
      }
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
      // Note: we intentionally do NOT atomicWrite the archived bytes to
      // `workflowPath`; the source is being deleted. The ownership this
      // withFileLock callback gets admitted the archive (its attempt mark),
      // and its only write of the source is that mark, before the
      // destination.

      return {
        archived: true,
        from: workflowPath,
        to: destination,
        host,
      };
    }, { env, host, writer });
  });
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
  precommit = null,
}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = await resolveArchiveDestination({ targetDir, baseName, now });
    let won = false;
    try {
      // The destination holds no workflow of this one: the archive was
      // admitted under the source's lock.
      await withFileLock(candidate, async ({ lockPath, token }) => {
        const existing = await pathStat(candidate);
        if (existing) {
          // Race lost — release the lock and let the outer loop pick a
          // fresh candidate. We do NOT throw here so the lock release
          // path runs cleanly.
          return;
        }
        await atomicWrite(candidate, archivedBytes, { lockPath, token }, { precommit });
        won = true;
      }, { hold: false, writer: LANE_WRITERS.destination });
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

// ADR-0059 amendment (j) — text an agent authors, or copies from a peer or the
// user, reaches a CLI as a file the agent wrote with its file-writing tool,
// never as shell source. The file is read as written: strict UTF-8 (a BOM is
// content), no NUL byte, and exactly one trailing LF or CRLF removed, the
// file's own line end; nothing else is trimmed. A missing or unreadable file,
// standard input ('-') and an empty value are refused. The file is never
// deleted: one next-action file can feed both append and finish-verb.
// peer-runner.mjs and phase7-commit.mjs read their text files with it too.
export function readTextArgumentFile(path, flag) {
  if (typeof path !== 'string' || path.length === 0) throw new Error(`${flag} needs a path`);
  if (path === '-') throw new Error(`${flag} takes a file path; standard input (-) is not read`);
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    throw new Error(`${flag}: cannot read ${JSON.stringify(path)} (${err.code ?? err.message})`);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${flag}: ${JSON.stringify(path)} is not valid UTF-8`);
  }
  if (text.includes('\0')) throw new Error(`${flag}: ${JSON.stringify(path)} holds a NUL byte`);
  const value = text.replace(/\r?\n$/, '');
  if (value.length === 0) throw new Error(`${flag}: ${JSON.stringify(path)} is empty`);
  return value;
}

// A JSON file a command reads its machine data from (ADR-0068 Decision 5):
// the same reader as a text file, then JSON.
function readJsonArgumentFile(path, flag) {
  const text = readTextArgumentFile(path, flag);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${flag}: ${JSON.stringify(path)} is not JSON (${err.message})`);
  }
}

// The flags that take a --<name>-file <path> twin: the free-text ones, and
// --workflow-id, a workflow id the user typed (C134(a)). Other *-file flags
// (--text-file, --args-file) keep their own readers.
const TEXT_FILE_FLAGS = ['original-request', 'next-action', 'phase-note', 'summary', 'resolution', 'workflow-id'];

// Every --<name>-file is read into --<name> before a subcommand runs, so a bad
// file refuses before anything is written, and a required flag is met by
// either form. Passing both forms is refused, even with an empty inline value.
// This parser takes each value as the next argument: a `--<name>=…` spelling
// of these flags is refused rather than ignored.
function cliResolveTextFiles(flags) {
  const out = { ...flags };
  for (const name of TEXT_FILE_FLAGS) {
    const fileFlag = `${name}-file`;
    const glued = Object.keys(flags).find((key) => key.startsWith(`${name}=`) || key.startsWith(`${fileFlag}=`));
    if (glued !== undefined) {
      throw new Error(`--${glued.slice(0, glued.indexOf('='))} takes its value as the next argument, not after '='`);
    }
    if (!(fileFlag in flags)) continue;
    if (name in flags) throw new Error(`pass --${name} or --${fileFlag}, not both`);
    out[name] = readTextArgumentFile(flags[fileFlag], `--${fileFlag}`);
    delete out[fileFlag];
  }
  return out;
}

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
    // A text file given twice would leave the first one unread (the last
    // value wins): every file named is read, or the command refuses.
    if (name in flags && TEXT_FILE_FLAGS.some((text) => name === `${text}-file`)) {
      throw new Error(`--${name} is given more than once`);
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

// ADR-0067 Decision 4, item 5 — --dispatch-selection carries JSON; the
// object's shape is checked by create.
function cliDispatchSelection(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(`--dispatch-selection is not JSON: ${err.message}`);
  }
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
      '  resolve-workflow --repo-root <checkout> (--workflow-id <id> | --workflow-id-file <path>)',
      '    Print the workflow file <id>.md found in the workflows homes of the',
      "    checkout's read set (ADR-0067 Decision 4, item 2). Exit 3 when none",
      '    holds it; exit 1 on an error (two files hold it, a root cannot be',
      '    read, or the id is no workflow id). --workflow-id-file reads the id',
      '    from a file, as the text files below are read (C134(a)).',
      '',
      '  list-workflows --repo-root <checkout>',
      '    Print every workflow file in the workflows homes of the checkout\'s',
      '    read set, one per line, the default state root\'s first (ADR-0067',
      '    Decision 1(a)).',
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
          '    [--dispatch-selection <json>] (dispatch_target): ADR-0067 Decision 4,',
          '    item 5 — {subtask, branch, verb, profile, topic} as the dispatch',
          '    selected them, recorded as dispatched_* beside the ids and only with',
          '    them; subtask, branch and verb must be this workflow\'s.',
        ]
        : [
          '    dispatch_target off — no --parent-workflow / --originating-subtask /',
          '    --parent-workflow-path / --dispatch-selection flags (ADR-0066 Decision 3).',
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
      ...(capabilityOn('dispatch_target')
        ? [
          '  dispatch-selection --workflow-path <path> (dispatch_target)',
          '    ADR-0067 Decision 4, item 5 — the dispatch the workflow records, as the',
          '    orchestrator\'s --expect-dispatch takes it: {macro, subtask, branch, verb,',
          '    profile, topic}, or {macro, subtask, branch} (its git_baseline branch)',
          '    for a workflow created before the record. Exit 1 when no macro',
          '    dispatched it.',
          '',
        ]
        : []),
      '  ensemble-pending --workflow-path <path> --phase <name>',
      '                   --ensemble-type <name> --run-id <id> [--started-at <iso>]',
      '                   [--host claude|codex]',
      '    ADR-0017 sub-4 — record a pending ensemble dispatch. Idempotent on run-id.',
      '    Under an autopilot run (Claude) held to the attempt mark (ADR-0068 Decision 5).',
      '',
      '  ensemble-commit --workflow-path <path> --run-id <id> --phase <name>',
      '                  --ensemble-type <name> --verdict <text> --summary <text>',
      '                  [--completed-at <iso>] [--codex-session-id <id>]',
      '                  [--cap <n>] [--host claude|codex]',
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
      '              --next-step-kind verb|commit|owner-decision|done|verify',
      '              --next-step-confidence HIGH|MEDIUM|LOW [--next-step-verb <verb>]',
      '              [--owner-gate <gate> --owner-gate-anchor <label>',
      '               [--owner-gate-run-id <run id>]]',
      '              [--verify-request-file <path>]',
      "    ADR-0063 D3 — a verb's final write: set-terminal summary-complete with",
      '    the terminal marker, plus the next step (commit_surface off: kind commit',
      '    means the owner publishes). --owner-gate needs --next-step-kind',
      '    owner-decision; it is recorded with the next step in one write and the',
      '    workflow stays open until the owner resolves it. A conflict gate',
      `    (${[...CONFLICT_OWNER_GATES].join(', ')}) records the run whose synthesis set it`,
      '    with --owner-gate-run-id (ADR-0067 Decision 8).',
      ...(capabilityOn('dispatch_target')
        ? ['    Under an autopilot run: the next step only, terminal marker unset, and', '    a pending peer ensemble is refused.']
        : []),
      '    --next-step-kind verify (ADR-0068 Decision 5) takes --verify-request-file,',
      '    JSON {checks: [{kind, args}], on_pass: {kind, verb?, confidence}, confidence},',
      '    and is refused unless the step runs in an autopilot run that offers',
      '    verification (AGENTIC_AUTOPILOT_VERIFY, AGENTIC_AUTOPILOT_STEP, and the',
      `    declaration ${VERIFY_DECLARATION_PATH} at that commit). Any other kind`,
      '    drops the last request and its results.',
      '',
      '  verify-request-check --workflow-path <p> --host <h> --request-file <path>',
      '              --next-step-confidence HIGH|MEDIUM|LOW [--settling-run-id <id>]',
      '    Whether finish-verb --next-step-kind verify would take the request now,',
      '    writing nothing: the same checks, with the same messages. A finalize runs',
      '    it before its first write; --settling-run-id names the peer run it',
      '    settles first, whose pending entry is not counted.',
      '',
      '  verify-batch-start   --workflow-path <p> --host <h> --request-id <id> --input-file <json>',
      '  verify-batch-restart --workflow-path <p> --host <h> --request-id <id> --replaces <hex|none> --input-file <json>',
      '  verify-result        --workflow-path <p> --host <h> --request-id <id> --batch-id <id> --input-file <json>',
      '  verify-batch-end     --workflow-path <p> --host <h> --request-id <id> --batch-id <id> --input-file <json>',
      '  verify-pass          --workflow-path <p> --host <h> --request-id <id> --batch-id <id>',
      "    ADR-0068 Decision 5 — the driver's records of the pending request's",
      '    batches, under the workflow lock; an identical replay is a no-op',
      '    ({"unchanged":true}), a different record for the same batch or check is',
      '    refused. verify-batch-restart sets the request\'s whole record aside and',
      '    starts it again whole, only over the record --replaces names (the',
      '    results_digest verify-results prints). verify-pass sets the next step to',
      '    the request\'s on_pass.',
      '  verify-results --workflow-path <p> [--tree-digest <hex> | --current-tree true] [--format json|text]',
      '    The request, its previous answer and its batches (JSON), each check',
      '    marked evidence (historical) and, with --tree-digest, whether it applies,',
      '    and results_digest, the record a restart sets aside. --current-tree takes',
      '    the digest of the checkout it runs in, as the driver takes a batch\'s;',
      '    --format text prints a few lines instead, nothing when there is no request.',
      '  verify-capability',
      `    Print the capability marker (${VERIFY_RECORD_CAPABILITY}) a driver probes.`,
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
      '                     [--since <YYYY-MM-DDTHH:MM:SSZ>] [--run-id <run id>]',
      '    ADR-0063 D6 — record the owner gate this workflow waits on. Default',
      "    --since is now. --anchor derives the pointer from the workflow's own",
      '    path. Exit 1 when a different gate is already set, or for a gate whose',
      `    capability is off (settable here: ${[...settableOwnerGates()].join(', ')}).`,
      '    --run-id: a conflict gate names the run whose synthesis set it; a gate',
      '    set without one deletes it, and a re-set that names another run, or',
      '    none, retires the task file of the run it replaces (ADR-0067 Decision 8).',
      '',
      '  awaiting-owner-clear --workflow-path <path> --host <host> --gate <gate>',
      '                       [--next-step-kind <kind> --next-step-confidence <c>',
      '                        [--next-step-verb <verb>] | --clear-next-step true]',
      '                       [--next-action <text>] [--resolution <text>]',
      '    ADR-0063 D6 — clear the owner gate once the owner has decided, and',
      '    append an "Owner gate resolved" phase note, with the next step the',
      '    owner chose (or none, --clear-next-step true), the next action that',
      '    replaces the gate\'s, and the decision in words in the same write. Exit 1 when',
      `    the gate is not the one set${capabilityOn('dispatch_target') ? ', or under an autopilot run' : ''}. The run id goes with the`,
      '    gate, and the task file of that run is retired (ADR-0067 Decision 8).',
      '',
      '  consensus-task --workflow-path <path> --run-id <run id> [--host <host>]',
      '                 (--text <contested items> | --text-file <path>)',
      '    ADR-0067 Decision 8 — write the contested items of a conflict as the',
      "    workflow's consensus task file, <home>/consensus/<workflow id>.<run id>.md,",
      '    and print the runtime:consensus command the proposal selects, with the',
      "    file's absolute path. Exit 1 unless ensemble_results holds the run with",
      '    the verdict conflict.',
      '',
      '  critique-scope --workflow-path <path> --repo-root <path> [--profile <name>]',
      '    C120 — for a document deliverable, open the next critique in the',
      '    review ledger (<home>/reviews/<workflow id>.json) and print its scope',
      '    as JSON {recorded, ledger, generation, mode, reason, document, tree,',
      '    artifact,',
      '    passages, targets, findings}. mode is scoped only after a full critique',
      '    and a recorded refine whose tree the checkout still holds; any doubt is',
      '    full, and a profile other than the default is partial. A deliverable',
      '    that is not a document, or a checkout it cannot read, records nothing.',
      '',
      '  critique-close --workflow-path <path> --repo-root <path> --ledger <id>',
      '                 --generation <n> --findings-file <path>',
      '    C120 — close the open critique with the synthesis\'s findings',
      '    ({"findings": [{id, severity, location, text, verdict, scope}]}) and',
      '    print the disposition {converged, carry, left_open, recurring, ...}.',
      '    Exit 1 when the ledger is not the one critique-scope named, or the',
      '    checkout no longer holds the tree it reviewed.',
      '',
      '  refine-record --workflow-path <path> --repo-root <path> --targets-file <path>',
      '    C120 — record the ledger findings a refine targeted and the tree it',
      '    left, before Refine-verify, and print verify {mode, reason}: scoped',
      '    only when the next critique would be. Records nothing without a',
      '    readable review ledger or a readable checkout on the workflow\'s branch.',
      '',
      '  review-status --workflow-path <path>',
      '    Read-only (C120). The review ledger as JSON {ledger, carry, recurring,',
      '    left_open, findings, ...}, or {ledger: false}.',
      '',
      '  ensemble-verdict --workflow-path <path> --run-id <run id>',
      '    Read-only (ADR-0067 Decision 8). Print the verdict ensemble_results',
      '    records for the run, an empty line when it records none.',
      '',
      '  consensus-proposal --workflow-path <path> [--host <host>]',
      "    Read-only (ADR-0067 Decision 8). Whether the workflow's conflict gate has",
      '    a current task file, and the runtime:consensus command it proposes, as',
      '    JSON {current, gate, run_id, task_file?, pointer?, command? | reason}.',
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
      '  hold-capability',
      '    Read-only (ADR-0068 Decision 2, item 9). Print the hold-aware persona\'s',
      '    capability token and the holds protocol it reads, as JSON.',
      '',
      '  content-digest --workflow-path <p>',
      '    Read-only (ADR-0068 Decision 2, item 7). Print the digest of the',
      '    workflow without the fields a snapshot writes, as JSON.',
      '',
      '  Persona operations (ADR-0068 Decision 2, item 7; N4): create, append,',
      '  set-terminal and finish-verb take [--operation-dir <absolute dir>], the',
      '  command\'s operation directory. create [--operation-kind <kind>, default',
      '  verb] and append --open-operation <kind> open the operation there;',
      '  append --close-operation true, set-terminal and finish-verb close it.',
      '  operation --workflow-path <p> --host <host> --operation-dir <dir>',
      '  (--open-operation <kind> | --close-operation true) opens or closes it with',
      '  a write of the entry alone (peer-now). append --once-operation <kind> is',
      '  a command whose one write it is (the resume marker), as an archive is.',
      '  Only a macro\'s child has operations: on any other workflow, and with no',
      '  directory, the write is as before.',
      '',
      '  state-root --repo-root <checkout>',
      '    Read-only (ADR-0067 Decision 6). Print the default state root, the read',
      '    set, the shared-creation switch, where a record would be created (or why',
      '    not), and in the main checkout the attestation checks, as JSON.',
      '',
      '  shared-creation --repo-root <main checkout> --enable --versions <json>',
      '  shared-creation --repo-root <checkout> --disable',
      '    The operator cutover switch (ADR-0067 Decision 4, items 4 and 5;',
      '    docs/runbooks/state-root-cutover.md). --enable runs the main-checkout',
      '    checks, appends the inventory to the cutover manifest and turns shared',
      '    creation on; --disable (rollback) is refused once lanes have run.',
      '',
      'Text files (ADR-0059 amendment (j)): --original-request, --next-action,',
      '--phase-note, --summary, --resolution and --workflow-id each have a',
      '--<name>-file <path> twin, read as UTF-8 with one trailing newline removed (an empty value, a NUL',
      'byte and standard input are refused; the file is kept). Pass one form or the',
      'other. A runbook passes text an agent wrote this way, never on a command',
      'line; the inline form is for programs.',
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
    const { rest: valued, presence } = cliPresenceFlags(subcommand, rest);
    flags = { ...cliParseFlags(valued), ...presence };
  } catch (err) {
    process.stderr.write(`state.mjs: ${err.message}\n`);
    return 2;
  }
  // ADR-0059 amendment (j) — the text files, read before any subcommand runs
  // (and before --repo-root changes where the command acts, so a relative path
  // names a file where the caller is).
  try {
    flags = cliResolveTextFiles(flags);
  } catch (err) {
    process.stderr.write(`state.mjs ${subcommand}: ${err.message}\n`);
    return 1;
  }

  // ADR-0067 Decision 1(a) — a subcommand given --repo-root acts in that
  // checkout: its writes judge it (the write guard's read set, the handoff
  // slot), not this process's working directory.
  if (typeof flags['repo-root'] === 'string' && flags['repo-root'] !== '') {
    return runInCommandDirectory(flags['repo-root'], () => cliRun(subcommand, flags));
  }
  return cliRun(subcommand, flags);
}

async function cliRun(subcommand, flags) {
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

      // ADR-0067 Decision 4, item 2 — resume's `archive <id>` resolver: the
      // workflow file in the checkout's read set; exit 3 when no root holds
      // it, an error (exit 1) when two files do.
      case 'resolve-workflow': {
        cliRequire(flags, ['repo-root', 'workflow-id']);
        const path = await resolveWorkflowById(flags['repo-root'], flags['workflow-id']);
        if (!path) {
          process.stderr.write(
            `state.mjs: no workflow ${JSON.stringify(flags['workflow-id'])} in the ${personaName()} workflows homes ` +
              `of the read set of ${flags['repo-root']}\n`,
          );
          return 3;
        }
        process.stdout.write(`${path}\n`);
        return 0;
      }

      // ADR-0067 Decision 1(a) — every workflow file in the workflows homes of
      // the checkout's read set, one per line, the default state root's first.
      case 'list-workflows': {
        cliRequire(flags, ['repo-root']);
        assertAbsoluteRepoRoot(flags['repo-root'], '--repo-root');
        for (const file of await listWorkflowFiles(flags['repo-root'])) process.stdout.write(`${file}\n`);
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
        if (!capabilityOn('dispatch_target') && flags['dispatch-selection'] !== undefined) {
          throw new Error(
            `${personaName()} state.mjs create does not accept --dispatch-selection: ` +
              `${personaName()} is no orchestrator dispatch target (dispatch_target off, ADR-0066 Decision 3)`,
          );
        }
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
          // ADR-0067 Decision 4, item 5 — JSON, as the dispatcher exports it.
          dispatchSelection: cliDispatchSelection(flags['dispatch-selection']),
          // ADR-0020 PR 2 — workflow-shape discriminator. Omitting the
          // flag defaults to 'verb-chain' inside createWorkflowUnderLock;
          // the persona's `start` macro passes 'start'. cliParseFlags
          // can only collect string values, so the enum gate fires inside
          // createWorkflowUnderLock for invalid values.
          workflowType: flags['workflow-type'],
          // ADR-0068 Decision 2 (N4) — the bootstrap opens the command's
          // operation when it creates a macro's child.
          operationDir: flags['operation-dir'],
          operationKind: flags['operation-kind'],
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
          // ADR-0068 Decision 2 (N4).
          operationDir: flags['operation-dir'],
          openOperation: flags['open-operation'],
          closeOperation: cliBoolean(flags, 'close-operation', false),
          // N4 — a command whose one write this is (the resume marker).
          childOperation: flags['once-operation'] === undefined ? undefined : { point: 'once', kind: flags['once-operation'] },
        });
        process.stdout.write(`${flags['workflow-path']}\n`);
        return 0;
      }

      case 'operation': {
        cliRequire(flags, ['workflow-path', 'host', 'operation-dir']);
        const result = await bookkeepOperation({
          workflowPath: flags['workflow-path'],
          host: flags.host,
          operationDir: flags['operation-dir'],
          openOperation: flags['open-operation'],
          closeOperation: cliBoolean(flags, 'close-operation', false),
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
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

      case 'dispatch-selection': {
        // ADR-0067 Decision 4, item 5 — the dispatch this workflow records, as
        // the orchestrator's --expect-dispatch takes it. Exit 1 when the
        // workflow was not dispatched by a macro.
        if (!capabilityOn('dispatch_target')) return unknownSubcommand(subcommand);
        cliRequire(flags, ['workflow-path']);
        const { frontmatter } = await readWorkflow(flags['workflow-path']);
        const { dispatchExpectation } = await import('./parent-writeback.mjs');
        const expectation = dispatchExpectation(frontmatter);
        if (expectation === null) {
          process.stderr.write(`${flags['workflow-path']} was not dispatched by an orchestrator macro (no parent linkage).\n`);
          return 1;
        }
        process.stdout.write(`${JSON.stringify(expectation)}\n`);
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
        if (flags.host !== undefined) validateHost(flags.host);
        await recordPendingEnsemble({
          workflowPath: flags['workflow-path'],
          phase: flags.phase,
          ensemble_type: flags['ensemble-type'],
          run_id: flags['run-id'],
          started_at: flags['started-at'],
          host: flags.host,
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
        if (flags.host !== undefined) validateHost(flags.host);
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
          host: flags.host,
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
          host: flags.host,
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
          host: flags.host,
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
          // ADR-0068 Decision 2 (N4) — a terminal write is its command's last.
          operationDir: flags['operation-dir'],
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
        const set = await setAwaitingOwner({
          workflowPath: flags['workflow-path'],
          host: flags.host,
          gate: flags.gate,
          pointer: flags.pointer,
          anchor: flags.anchor,
          since: flags.since,
          runId: flags['run-id'],
        });
        if (set.retired.warning) process.stderr.write(`warning: ${set.retired.warning}\n`);
        process.stdout.write(`${flags['workflow-path']}\n`);
        return 0;
      }

      case 'awaiting-owner-clear': {
        cliRequire(flags, ['workflow-path', 'host', 'gate']);
        const cleared = await clearAwaitingOwner({
          workflowPath: flags['workflow-path'],
          host: flags.host,
          gate: flags.gate,
          nextStep: cliNextStep(flags),
          clearNextStep: cliBoolean(flags, 'clear-next-step', false),
          nextAction: flags['next-action'],
          resolution: flags.resolution,
          operationDir: flags['operation-dir'],
          openOperation: flags['open-operation'],
          closeOperation: cliBoolean(flags, 'close-operation', false),
        });
        if (cleared.retired.warning) process.stderr.write(`warning: ${cleared.retired.warning}\n`);
        process.stdout.write(`${flags['workflow-path']}\n`);
        return 0;
      }

      // ADR-0067 Decision 8 — the consensus task file of a conflict: written
      // once the run's conflict is settled, before the gate names it.
      case 'consensus-task': {
        cliRequire(flags, ['workflow-path', 'run-id']);
        if (('text' in flags) === ('text-file' in flags)) {
          throw new Error('consensus-task takes the contested items as --text <items> or --text-file <path>, one of them');
        }
        const text = 'text' in flags ? flags.text : await readFile(flags['text-file'], 'utf8');
        const written = await writeConsensusTask({
          workflowPath: flags['workflow-path'],
          runId: flags['run-id'],
          text,
          host: flags.host ?? 'claude',
        });
        process.stdout.write(`${written.command}\n`);
        return 0;
      }

      // C120 — the review ledger of a document deliverable: open a critique
      // and print its scope, close it with the synthesis's findings, record
      // what a refine targeted, and read the ledger.
      case 'critique-scope': {
        cliRequire(flags, ['workflow-path', 'repo-root']);
        const scope = await openCritiqueScope({
          workflowPath: flags['workflow-path'],
          repoRoot: flags['repo-root'],
          profile: flags.profile ?? '',
          host: flags.host,
        });
        process.stdout.write(`${JSON.stringify(scope, null, 2)}\n`);
        return 0;
      }

      case 'critique-close': {
        cliRequire(flags, ['workflow-path', 'repo-root', 'ledger', 'generation', 'findings-file']);
        const generation = Number(flags.generation);
        if (!Number.isInteger(generation) || generation < 1) throw new Error(`--generation must be a generation id (got '${flags.generation}')`);
        let input;
        try {
          input = JSON.parse(await readFile(flags['findings-file'], 'utf8'));
        } catch (err) {
          throw new Error(`--findings-file ${flags['findings-file']} is not a readable JSON file (${err.code ?? err.message})`);
        }
        const result = await closeCritiqueScope({
          workflowPath: flags['workflow-path'],
          repoRoot: flags['repo-root'],
          ledgerId: flags.ledger,
          generation,
          input,
          host: flags.host,
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      }

      case 'refine-record': {
        cliRequire(flags, ['workflow-path', 'repo-root', 'targets-file']);
        const targets = readIdList(await readFile(flags['targets-file'], 'utf8'));
        const attempt = await recordRefineScope({
          workflowPath: flags['workflow-path'],
          repoRoot: flags['repo-root'],
          targets,
          host: flags.host,
        });
        process.stdout.write(`${JSON.stringify(attempt, null, 2)}\n`);
        return 0;
      }

      case 'review-status': {
        cliRequire(flags, ['workflow-path']);
        const status = await readReviewStatus({ workflowPath: flags['workflow-path'] });
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
        return 0;
      }

      // Read-only (ADR-0067 Decision 8): the verdict ensemble_results records
      // for a run, empty when it records none (or no run launched). A verb's
      // finalize branches on it, the settled verdict, not on the agent's own.
      case 'ensemble-verdict': {
        cliRequire(flags, ['workflow-path']);
        const runId = flags['run-id'] ?? '';
        const { frontmatter } = await readWorkflow(flags['workflow-path']);
        const result = runId === ''
          ? null
          : (frontmatter.ensemble_results ?? []).find((e) => e?.run_id === runId) ?? null;
        process.stdout.write(`${result?.verdict ?? ''}\n`);
        return 0;
      }

      // Read-only: whether the workflow's conflict gate has a current task
      // file, and the consensus command it proposes (JSON, exit 0 either way).
      case 'consensus-proposal': {
        cliRequire(flags, ['workflow-path']);
        const proposal = await consensusProposal({
          workflowPath: flags['workflow-path'],
          host: flags.host ?? 'claude',
        });
        process.stdout.write(`${JSON.stringify(proposal)}\n`);
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
        if ('owner-gate-run-id' in flags && !('owner-gate' in flags)) {
          throw new Error('--owner-gate-run-id goes with --owner-gate (ADR-0067 Decision 8)');
        }
        // ADR-0068 Decision 5 — the request of a verify step, read from the
        // file the step wrote (arguments as data, never on a command line).
        const verifyRequest = 'verify-request-file' in flags
          ? readJsonArgumentFile(flags['verify-request-file'], '--verify-request-file')
          : undefined;
        const result = await finishVerb({
          workflowPath: flags['workflow-path'],
          host: flags.host,
          nextAction: flags['next-action'],
          nextStep: cliNextStep(flags),
          ownerGate: 'owner-gate' in flags
            ? { gate: flags['owner-gate'], anchor: flags['owner-gate-anchor'], runId: flags['owner-gate-run-id'] }
            : undefined,
          verifyRequest,
          // As for set-terminal: a verb completion fires the ADR-0031
          // session-handoff sidecar.
          emitHandoff: true,
          // ADR-0068 Decision 2 (N4) — the verb's last write closes its operation.
          operationDir: flags['operation-dir'],
        });
        if (result.mode === 'autopilot') {
          process.stderr.write(
            `autopilot: next step recorded; the terminal marker is left for ${commandPrefix()}commit (ADR-0063 D3)\n`,
          );
        } else if (result.held) {
          process.stderr.write(
            `next step recorded; the workflow stays open (ADR-0068 Decision 2, item 6): ${result.held.why}\n`,
          );
        } else if (result.terminal === false) {
          process.stderr.write(
            `owner gate ${flags['owner-gate']} recorded; the workflow stays open until the owner resolves it (ADR-0063 D6)\n`,
          );
        }
        process.stdout.write(`${flags['workflow-path']}\n`);
        return 0;
      }

      // ADR-0068 Decision 5 — the driver's records of a request's batches. Each
      // reads its JSON from the file the driver wrote, writes under the
      // workflow lock, and prints {"recorded":true} or, for a replay identical
      // to what is stored, {"unchanged":true}.
      case 'verify-batch-start':
      case 'verify-batch-restart':
      case 'verify-result':
      case 'verify-batch-end':
      case 'verify-pass': {
        const starts = subcommand === 'verify-batch-start' || subcommand === 'verify-batch-restart';
        const needs = ['workflow-path', 'host', 'request-id'];
        if (!starts) needs.push('batch-id');
        if (subcommand !== 'verify-pass') needs.push('input-file');
        // A restart names the record it sets aside, `none` when there is none.
        if (subcommand === 'verify-batch-restart') needs.push('replaces');
        cliRequire(flags, needs);
        const input = subcommand === 'verify-pass' ? undefined : readJsonArgumentFile(flags['input-file'], '--input-file');
        const common = { workflowPath: flags['workflow-path'], host: flags.host, requestId: flags['request-id'] };
        const written = subcommand === 'verify-batch-start' ? await recordBatchStart({ ...common, input })
          : subcommand === 'verify-batch-restart' ? await recordBatchRestart({ ...common, replaces: flags.replaces === 'none' ? null : flags.replaces, input })
            : subcommand === 'verify-result' ? await recordResult({ ...common, batchId: flags['batch-id'], input })
              : subcommand === 'verify-batch-end' ? await recordBatchEnd({ ...common, batchId: flags['batch-id'], input })
                : await recordPass({ ...common, batchId: flags['batch-id'] });
        process.stdout.write(`${JSON.stringify(written)}\n`);
        return 0;
      }

      // ADR-0068 Decision 5 (`verify-runbooks`) — the finalize's check, before
      // its first write, that finish-verb would take the request: writes
      // nothing, and refuses with finish-verb's own message.
      case 'verify-request-check': {
        cliRequire(flags, ['workflow-path', 'host', 'request-file', 'next-step-confidence']);
        const checked = await checkVerifyRequest({
          workflowPath: flags['workflow-path'],
          host: flags.host,
          nextStep: { kind: 'verify', confidence: flags['next-step-confidence'] },
          input: readJsonArgumentFile(flags['request-file'], '--request-file'),
          settling: flags['settling-run-id'] ?? null,
        });
        process.stdout.write(`${JSON.stringify(checked)}\n`);
        return 0;
      }

      case 'verify-results': {
        cliRequire(flags, ['workflow-path']);
        if ('format' in flags && flags.format !== 'json' && flags.format !== 'text') throw new Error('--format is json or text');
        // `--current-tree` is true or false: any other word (yes, 1, TRUE) is
        // refused, never read as false.
        if ('current-tree' in flags && flags['current-tree'] !== 'true' && flags['current-tree'] !== 'false') throw new Error('--current-tree is true or false');
        const read = await readVerifyResults({ workflowPath: flags['workflow-path'], treeDigest: flags['tree-digest'] ?? null, currentTree: flags['current-tree'] === 'true' });
        // `--format text`: the few lines a verb's resume prints (verify-runbooks).
        process.stdout.write(flags.format === 'text' ? formatVerifySummary(read) : `${JSON.stringify(read, null, 2)}\n`);
        return 0;
      }

      // The capability marker a driver probes before it offers verification
      // (ADR-0068 Decision 5, item 11).
      case 'verify-capability': {
        process.stdout.write(`${JSON.stringify({ capability: VERIFY_RECORD_CAPABILITY, slot_types: SLOT_TYPES, declaration: VERIFY_DECLARATION_PATH })}\n`);
        return 0;
      }

      // ADR-0068 Decision 2 (implementation note of 2026-10-25, N6 and N8).
      case 'hold-capability': {
        process.stdout.write(`${JSON.stringify(holdCapability())}\n`);
        return 0;
      }

      case 'content-digest': {
        cliRequire(flags, ['workflow-path']);
        process.stdout.write(`${JSON.stringify(await contentDigest(flags['workflow-path']))}\n`);
        return 0;
      }

      case 'archive': {
        cliRequire(flags, ['workflow-path', 'host', 'repo-root']);
        // N4 — /resume archive's one write: a macro's child is archived as an
        // operation of one write (kind archive), so never beside another
        // operation open in its lane.
        const result = await archiveWorkflow({
          workflowPath: flags['workflow-path'],
          host: flags.host,
          repoRoot: flags['repo-root'],
          onceOperationKind: 'archive',
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
        // The writes judge the checkout --repo-root names, the caller's
        // (finalize, abort): cliMain runs this case in it.
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

      // ADR-0067 Decision 6 — read-only: the state root, the read set, the
      // shared-creation switch and, in the main checkout, the attestation
      // checks. Runbooks resolve storage in shell from it.
      case 'state-root': {
        cliRequire(flags, ['repo-root']);
        process.stdout.write(`${JSON.stringify(describeStateRoot(flags['repo-root']))}\n`);
        return 0;
      }

      // ADR-0067 Decision 4, items 4 and 5 — the operator's switch.
      case 'shared-creation': {
        cliRequire(flags, ['repo-root']);
        if (flags.enable === flags.disable) throw new Error('Pass exactly one of --enable and --disable.');
        let result;
        if (flags.enable) {
          cliRequire(flags, ['versions']);
          let versions;
          try {
            versions = JSON.parse(flags.versions);
          } catch (err) {
            throw new Error(`--versions is not JSON (${err.message})`);
          }
          result = enableSharedCreation({ checkout: flags['repo-root'], versions });
        } else {
          result = disableSharedCreation({ checkout: flags['repo-root'] });
        }
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

// `shared-creation --enable` and `--disable` take no value; every other flag
// of this CLI does. They become `true` before the generic parse.
function cliPresenceFlags(subcommand, rest) {
  if (subcommand !== 'shared-creation') return { rest, presence: {} };
  const presence = {};
  const kept = [];
  for (const a of rest) {
    if (a === '--enable' || a === '--disable') presence[a.slice(2)] = true;
    else kept.push(a);
  }
  return { rest: kept, presence };
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
