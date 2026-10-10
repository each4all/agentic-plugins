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
//   canonical: <repo_root>/.agentic-plugins/state/orchestrator/workflows/<workflow_id>.md
//   legacy:    <repo_root>/.claude/agentic-orchestrator/workflows/<workflow_id>.md
//
// Lock files:
//   <state-home>/.creation-lock             (directory-level)
//   <state-home>/workflows/<id>.md.lock     (per-file)
//
// File modes:
//   directories: 0o700
//   files:       0o600 (workflows + locks)
//
// File format: YAML frontmatter (emit schema='1.2', current) + Markdown body.
//
// Schema acceptance per ADR-0028 §Forward-compat (PR5 ported from engineer
// #356): the validateFrontmatter gate is `isSupportedSchema(s)`, a string-
// only `1.x` predicate (orchestrator never had a legacy number form; every
// orchestrator workflow since ADR-0018 has been a '1.y' string). Explicit
// known minors are documented in `SUPPORTED_SCHEMA_VERSIONS` for telemetry.
// Unknown scalar additive top-level keys are silent-skipped on read and
// surfaced via the `FORWARD_COMPAT_UNKNOWNS` Symbol carrier so round-trip
// writes preserve them.
//
// Schema divergence from plugins/engineer (intentional):
//   engineer     accepts legacy number `1` plus any `1.y` string
//   orchestrator accepts any `1.y` string only (no legacy number form)
//   Namespace separation is enforced downstream by orchestrator's required-
//   key set (workflow_type 'macro', plan.subtasks block); an engineer file
//   carrying matching schema would still fail at those gates.

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
import { join, dirname, basename, isAbsolute, resolve as resolvePath } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { hrtime, pid } from 'node:process';
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveLanding, dispatchTimeFromWorkflowId } from './landing.mjs';
import {
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
import { LockHeldError, checkAdmission, joinAdmission, releaseAdmission } from './lib/run-locks.mjs';
import { moveCutover, moveRollback, planCutover, planRollback, verifyCutover } from './lib/cutover.mjs';
import { laneAdvice, laneAdviceLine } from './lib/lane-advice.mjs';
import { macroInDefaultRoot, nextWorktreeProposal, worktreeProposalText } from './lib/worktree-proposal.mjs';

// -----------------------------------------------------------------------------
// Constants — ADR-0018 §sub-decision-1 + §sub-decision-2

// ADR-0019 PR-B — schema bump 1.0 → 1.1. New workflows emit '1.1';
// existing '1.0' files read OK but mutations are refused (legacy
// archive + re-plan required). Engineer schema 1 / '1.1' / 2 still
// rejected — orchestrator and engineer namespaces stay separate.
//
// ADR-0063 D6 bumps the emit to '1.2' for the flat `plan_approval_*` and
// `awaiting_owner_*` scalars. Mutation helpers keep the disk-recorded schema:
// a '1.1' file that gains the new keys stays '1.1' (validation is per key).
//
// This Set documents the minors this build explicitly knows about. It is no
// longer the validateFrontmatter accept gate — that uses `isSupportedSchema`
// below (ADR-0028 §Forward-compat) so a 1.x reader meeting a 1.y file with
// y > x can still parse via the predicate's open-ended 1.x match.
export const SCHEMA_VERSION = '1.2';
export const SUPPORTED_SCHEMA_VERSIONS = new Set(['1.0', '1.1', '1.2']);

// ADR-0028 §Forward-compat (PR5 #356 ported from engineer) read-tolerance
// predicate. Accepts any `1.y` minor as a string (y ≥ 0, no leading
// zeros). Rejects unknown majors (`'2.0'`), the bare `'1'` (no minor
// digit), the number form of any value (orchestrator has emitted only
// the string form since '1.0'), and malformed strings.
//
// Difference from engineer's predicate (plugins/engineer/scripts/state.mjs
// `isSupportedSchema`): engineer accepts the legacy number `1` for
// pre-ADR-0017 files; orchestrator has no such legacy — every workflow
// since orchestrator's introduction at ADR-0018 has been schema `'1.0'`
// or `'1.1'` (string form). The predicate is therefore string-only.
export function isSupportedSchema(s) {
  if (typeof s !== 'string') return false;
  return /^1\.(0|[1-9]\d*)$/.test(s);
}

export const STATE_DIR_REL = '.agentic-plugins/state/orchestrator';
export const LEGACY_STATE_DIR_REL = '.claude/agentic-orchestrator';
export const WORKFLOW_DIR_REL = `${STATE_DIR_REL}/workflows`;
export const LEGACY_WORKFLOW_DIR_REL = `${LEGACY_STATE_DIR_REL}/workflows`;
export const CREATION_LOCK_REL = `${STATE_DIR_REL}/.creation-lock`;
export const LEGACY_CREATION_LOCK_REL = `${LEGACY_STATE_DIR_REL}/.creation-lock`;
// ADR-0019 PR-E §5 — auto-archive destination + macro terminal-phase
// whitelist. The phase set diverges from engineer's
// {commit-complete, summary-complete, fix-complete}: macro plans use
// {commit-complete (happy path via auto-terminal pass), finalized
// (/orchestrator:finalize), aborted (/orchestrator:abort)}.
export const ARCHIVE_DIR_REL = `${STATE_DIR_REL}/archive`;
export const LEGACY_ARCHIVE_DIR_REL = `${LEGACY_STATE_DIR_REL}/archive`;
export const MACRO_TERMINAL_PHASES = new Set([
  'commit-complete',
  'finalized',
  'aborted',
]);

// Retention cap on `ensemble_results` (mirrors engineer ADR-0017 §sub-4).
// Macro Plan-verify ensembles are typically fewer-but-higher-value, but
// we keep the same cap for cross-plugin operational consistency.
export const ENSEMBLE_RESULTS_RETENTION_CAP = 20;

const STALE_THRESHOLD_MS = 60_000;        // ADR-0011 §3 — lock staleness window
const RETRY_BACKOFF_MAX_MS = 5_000;       // ADR-0011 §3 step 2 — acquireLock budget

// orchestrator state supports a single macro verb. /orchestrator:next
// and /orchestrator:done are dispatch commands over plan.subtasks[],
// not additional state verbs.
const VALID_VERBS = new Set(['plan']);
const VALID_HOSTS = new Set(['claude', 'codex']);
// Auto-archive event was deferred from the orchestrator MVP; ADR-0019
// PR-E ships /orchestrator:finalize + /orchestrator:abort + macro
// auto-archive A1-A4, so 'archived' is now a recognized event. The
// orchestrator meta-command parity follow-up adds 'checkpointed' for
// /orchestrator:checkpoint while preserving macro schema boundaries.
const VALID_HOOK_EVENTS = new Set([
  'created',
  'updated',
  'snapshot',
  'resumed',
  'archived',
  'checkpointed',
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
  // ADR-0063 D6 — 1.2 adds top-level scalars only; the subtask shape is 1.1's.
  '1.2': new Set(['id', 'blocked_by', 'status', 'verb', 'branch']),
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

// ADR-0063 D6 schema 1.2 — the flat `plan_approval_*` and `awaiting_owner_*`
// scalars. The owner gates here are the macro's subset of ADR-0063 D4; the
// engineer workflow stores the others. Both macro gates are about the plan's
// approval, so either one exists only while the plan is pending approval.
export const VALID_PLAN_APPROVAL_STATUSES = new Set(['pending', 'approved']);
export const VALID_MACRO_OWNER_GATES = new Set(['plan-approval', 'plan-conflict']);
// A pointer is a repo-relative `path#anchor`, never free text: this fixes the
// charset (no whitespace) and the shape. validateAwaitingOwnerPointer also
// refuses a leading `/` and any `..`. Same form as the engineer's pointer.
const AWAITING_OWNER_POINTER_RE = /^[A-Za-z0-9._/-]+#[A-Za-z0-9._/-]+$/;
const AWAITING_OWNER_KEYS = ['awaiting_owner_gate', 'awaiting_owner_since', 'awaiting_owner_pointer'];
// ADR-0067 Decision 8 — plan-conflict records the run id of the Plan-verify
// synthesis that set it, `awaiting_owner_run_id`, which binds the macro's
// consensus task file to its gate. Optional, outside the all-or-none triple:
// plan-approval, and a plan-conflict raised by hand, carry none.
const AWAITING_OWNER_RUN_ID = 'awaiting_owner_run_id';
// A run id as the gate records it and a task file's name carries it: no `.`,
// so a live name never equals a retired `<id>.<run>.resolved.md` one.
const CONSENSUS_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export function isSafeConsensusRunId(runId) {
  return typeof runId === 'string' && CONSENSUS_RUN_ID_RE.test(runId);
}
const CONSENSUS_WORKFLOW_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// sha256, lowercase hex — what computePlanHash returns.
const PLAN_HASH_RE = /^[0-9a-f]{64}$/;
// The subtask fields the plan hash covers: SUBTASK_KEYS minus the ones that
// change while the plan executes (status, engineer_workflow_id, commit,
// pr_url, closed_at). Approving a plan approves these.
const PLAN_HASH_SUBTASK_KEYS = ['id', 'label', 'branch', 'blocked_by', 'verb', 'profile', 'topic'];
// Anchors of the pointers this script writes into its own macro file.
const MACRO_PLAN_ANCHOR = 'macro-plan';
const ENSEMBLE_SYNTHESIS_ANCHOR = 'ensemble-synthesis';
// The Plan-verify verdicts /orchestrator:plan records (commands/plan.md).
const PLAN_VERIFY_VERDICTS = new Set(['pass', 'concerns', 'conflict']);

// ADR-0063 §0.2 env contract — autopilot mode is on only when
// AGENTIC_AUTOPILOT holds a well-formed run id, so an empty or accidental
// global export cannot flip a gate. Each plugin carries its own copy of this
// predicate (no cross-plugin import, ADR-0010 §5);
// tests/plugin-shape/test-autopilot-enum-parity.mjs keeps the copies equal.
export function isAutopilotRun(env = process.env) {
  return /^autopilot-\d{8}T\d{6}Z-[0-9a-f]{6}$/.test(env?.AGENTIC_AUTOPILOT ?? '');
}

// JSON with object keys sorted at every level and no whitespace, so the text
// of a value does not depend on the order its keys were written in.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * ADR-0063 D6 — the hash an approval binds to: sha256 over the canonical JSON
 * of `plan.subtasks[]` in array order, each subtask projected to the fields
 * the plan decides (PLAN_HASH_SUBTASK_KEYS). A field that is absent or null
 * is left out, because the serializer drops a null optional field, so the
 * hash of a plan is the same before and after it is written. Reordering the
 * subtasks changes the hash; progress (status and the recorded provenance)
 * does not. The orchestrator is the only implementation; other plugins ask
 * this CLI (`plan-hash`, `next-ready`) rather than recompute it.
 */
export function computePlanHash(subtasks) {
  return createHash('sha256').update(canonicalJson(planHashProjection(subtasks)), 'utf8').digest('hex');
}

// What computePlanHash hashes, in the order it hashes it. `plan-hash` prints
// it, so the owner approves the fields the hash covers.
function planHashProjection(subtasks) {
  if (!Array.isArray(subtasks)) {
    throw new Error('computePlanHash: subtasks must be an array');
  }
  return subtasks.map((s, idx) => {
    if (typeof s !== 'object' || s === null || Array.isArray(s)) {
      throw new Error(`computePlanHash: subtasks[${idx}] must be an object`);
    }
    const out = {};
    for (const k of PLAN_HASH_SUBTASK_KEYS) {
      if (s[k] !== undefined && s[k] !== null) out[k] = s[k];
    }
    return out;
  });
}

/**
 * ADR-0063 D6 — the approval facts a dispatcher needs, without recomputing
 * the hash itself: `status` is `approved`, `pending`, or `absent` (a macro no
 * 1.2 writer has planned or approved), and `hash_ok` says whether the approved
 * hash still matches the plan (null unless approved).
 */
export function planApprovalState(frontmatter) {
  const status = frontmatter?.plan_approval_status;
  if (status !== 'approved' && status !== 'pending') return { status: 'absent', hash_ok: null };
  if (status === 'pending') return { status, hash_ok: null };
  const subtasks = Array.isArray(frontmatter?.plan?.subtasks) ? frontmatter.plan.subtasks : [];
  return { status, hash_ok: frontmatter.plan_approval_plan_hash === computePlanHash(subtasks) };
}

/**
 * ADR-0063 D4 rule 3 — the approval gate of /orchestrator:next, decided from
 * planApprovalState so no dispatcher compares hashes itself. Under an
 * autopilot run (isAutopilotRun) only a plan approved at its current hash is
 * dispatched; any other plan, one with no approval recorded included, is
 * refused with the halt reason `plan-unapproved`. An interactive dispatch is
 * never refused (owner decision D3): it warns, in one line, when the plan is
 * pending approval or has changed since it was approved, and says nothing for
 * an approved plan or for a macro no 1.2 writer has planned, which dispatches
 * as it did before approvals existed. `lines` are for the caller's stderr;
 * `pointer` is where the owner acts.
 *
 * `selected` is the subtask the caller is about to dispatch, as it read it
 * before this check. The approval covers the plan read here, so under
 * autopilot the selected subtask must also match this plan's entry for its id
 * in every field the hash covers: a plan rewritten and approved between the
 * selection and this check would otherwise pass, and the caller would
 * dispatch fields the owner never approved.
 */
export function planApprovalGate({ frontmatter, workflowPath, host, selected, env = process.env }) {
  validateHost(host);
  if (typeof selected !== 'object' || selected === null || Array.isArray(selected) || typeof selected.id !== 'string') {
    throw new Error('approval-gate: the selected subtask must be a JSON object with a string id');
  }
  const approval = planApprovalState(frontmatter);
  const autopilot = isAutopilotRun(env);
  const pointer = frontmatter?.awaiting_owner_pointer ?? macroPointer(workflowPath, MACRO_PLAN_ANCHOR);
  const approved = approval.status === 'approved' && approval.hash_ok === true;
  const subtasks = Array.isArray(frontmatter?.plan?.subtasks) ? frontmatter.plan.subtasks : [];
  const current = subtasks.find((s) => s?.id === selected.id);
  const selectedInPlan = current !== undefined
    && canonicalJson(planHashProjection([current])) === canonicalJson(planHashProjection([selected]));
  if ((approved && (selectedInPlan || !autopilot)) || (!autopilot && approval.status === 'absent')) {
    return { verdict: 'proceed', reason: null, autopilot, approval, pointer, lines: [] };
  }
  const sigil = host === 'codex' ? '$' : '/';
  if (approved) {
    // Only an autopilot run gets here: the plan is approved, but not with the
    // subtask as it was selected.
    return {
      verdict: 'refuse', reason: 'plan-unapproved', autopilot, approval, pointer,
      lines: [
        `✗ plan-unapproved — an autopilot run (AGENTIC_AUTOPILOT=${env.AGENTIC_AUTOPILOT}) dispatches only ` +
          `a subtask of the plan the owner approved, and subtask ${selected.id} as selected is not in it: ` +
          'the plan changed after the subtask was selected (ADR-0063 D4).',
        `  Pointer: ${pointer}. Run ${sigil}orchestrator:next again; it selects from the plan as approved.`,
      ],
    };
  }
  const approve = `${sigil}orchestrator:approve --workflow=${basename(workflowPath, '.md')}`;
  let state;
  if (approval.status === 'pending') {
    state = `is pending approval (awaiting_owner_gate=${frontmatter.awaiting_owner_gate})`;
  } else if (approval.status === 'approved') {
    state = `has changed since it was approved at ${frontmatter.plan_approval_approved_at}`;
  } else {
    state = 'has no approval recorded';
  }
  const owner = frontmatter?.awaiting_owner_gate === 'plan-conflict'
    ? `settles the Plan-verify conflict (revises the plan with ${sigil}orchestrator:plan, or clears ` +
      `the conflict with state.mjs awaiting-owner-clear --gate plan-conflict), then approves the plan with ${approve}`
    : `reviews the plan and approves it with ${approve}`;
  if (autopilot) {
    return {
      verdict: 'refuse', reason: 'plan-unapproved', autopilot, approval, pointer,
      lines: [
        `✗ plan-unapproved — an autopilot run (AGENTIC_AUTOPILOT=${env.AGENTIC_AUTOPILOT}) dispatches only ` +
          `a plan the owner approved at its current hash, and this plan ${state} (ADR-0063 D4).`,
        `  Pointer: ${pointer}. The owner ${owner}; the run can then resume.`,
      ],
    };
  }
  return {
    verdict: 'warn', reason: 'plan-unapproved', autopilot, approval, pointer,
    lines: [
      `⚠ This plan ${state}; dispatching anyway, which an autopilot run would refuse (${pointer}). ` +
        `The owner ${owner}.`,
    ],
  };
}

// -----------------------------------------------------------------------------
// Path helpers

const STATE_HOMES = Object.freeze({
  canonical: {
    home: 'canonical',
    stateDirRel: STATE_DIR_REL,
    workflowDirRel: WORKFLOW_DIR_REL,
    archiveDirRel: ARCHIVE_DIR_REL,
    creationLockRel: CREATION_LOCK_REL,
    peerRunsDirRel: `${STATE_DIR_REL}/peer-runs`,
    // ADR-0067 Decision 8 — the consensus task files of a plan-conflict.
    consensusDirRel: `${STATE_DIR_REL}/consensus`,
  },
  legacy: {
    home: 'legacy',
    stateDirRel: LEGACY_STATE_DIR_REL,
    workflowDirRel: LEGACY_WORKFLOW_DIR_REL,
    archiveDirRel: LEGACY_ARCHIVE_DIR_REL,
    creationLockRel: LEGACY_CREATION_LOCK_REL,
    peerRunsDirRel: `${LEGACY_STATE_DIR_REL}/peer-runs`,
    consensusDirRel: `${LEGACY_STATE_DIR_REL}/consensus`,
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

export async function resolveWorkflowStorage(repoRoot, { mode = 'read' } = {}) {
  assertAbsoluteRepoRoot(repoRoot);
  const canonicalHasState = await stateHomeHasState(repoRoot, 'canonical');
  const legacyHasState = await stateHomeHasState(repoRoot, 'legacy');
  if (mode === 'write' && canonicalHasState && legacyHasState) {
    throw new Error(
      `Workflow storage migration blocked: both ${STATE_DIR_REL} and ` +
        `${LEGACY_STATE_DIR_REL} contain orchestrator state. Migrate or ` +
        `reconcile the legacy home before ordinary workflow writes.`,
    );
  }
  const home = canonicalHasState ? 'canonical' : (legacyHasState ? 'legacy' : 'canonical');
  return {
    ...statePaths(repoRoot, home),
    canonicalHasState,
    legacyHasState,
  };
}

// The home a macro file sits in and the state root that holds it (ADR-0067
// Decision 1(b)): the root its archive, locks and peer runs derive from. It is
// never a checkout: git facts come from the checkout a command runs in.
function inferStorageFromWorkflowPath(workflowPath) {
  const text = String(workflowPath);
  const canonicalNeedle = '/.agentic-plugins/state/orchestrator/';
  const legacyNeedle = '/.claude/agentic-orchestrator/';
  const canonicalIndex = text.indexOf(canonicalNeedle);
  if (canonicalIndex >= 0) {
    return { home: 'canonical', stateRoot: text.slice(0, canonicalIndex) };
  }
  const legacyIndex = text.indexOf(legacyNeedle);
  if (legacyIndex >= 0) {
    return { home: 'legacy', stateRoot: text.slice(0, legacyIndex) };
  }
  return null;
}

// The home a macro file sits in and the state root holding it,
// `{ home, stateRoot }`, or null when the path is under no state home: the
// home its archive, locks and peer runs derive from (ADR-0067 Decision 4,
// item 2).
export function workflowStorage(workflowPath) {
  const inferred = inferStorageFromWorkflowPath(resolvePath(String(workflowPath)));
  return inferred && inferred.stateRoot.length > 0 ? inferred : null;
}

// The state root holding a macro file (ADR-0067 Decision 1(c)): a pointer
// into the record is spelled relative to it. Null when the path is under no
// state home.
export function workflowStateRoot(workflowPath) {
  return workflowStorage(workflowPath)?.stateRoot ?? null;
}

// ADR-0067 Decision 1(a) — the checkout a command runs in, or null when it
// cannot be told (lib/state-root.mjs).
export { commandCheckout };

// -----------------------------------------------------------------------------
// ADR-0067 — the read set, one writable copy, and the creation locks

// Where existing records are found: the default state root first, then the
// checkout when it is another directory (Decision 1(a)). AGENTIC_STATE_BASE
// and the shared-creation switch never narrow it.
function lookupRoots(repoRoot) {
  assertAbsoluteRepoRoot(repoRoot);
  return readSet(repoRoot);
}

/**
 * ADR-0067 Decision 4, item 2 — one writable copy. Every write to an existing
 * macro goes through `withFileLock`, which, holding the file's lock, refuses a
 * path whose last component is a symbolic link (the atomic replace would turn
 * the alias into a second copy); a macro in a `workflows/` home whose workflow
 * id is also held by a second file, under its name or another, in any home of
 * any root of the repository (the read set and every worktree's own homes);
 * and a macro whose integration branch has a second active macro in the read
 * set of the root holding it or of the checkout the command runs in
 * (Decision 2; Decision 4, item 1). A directory or a file that cannot be read,
 * or worktrees git cannot list, refuse too: the copy may be there.
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
        'the alias into a second copy of the macro. Write the file it names (ADR-0067 Decision 4, item 2).',
    );
  }
  if (basename(dirname(absolute)) !== 'workflows') return;
  const inferred = inferStorageFromWorkflowPath(absolute);
  if (!inferred || inferred.stateRoot.length === 0) return;
  // The frontmatter only, from a regular file opened without blocking: a FIFO
  // in the macro's place is refused, never waited on.
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
    dirs: repositoryRoots(inferred.stateRoot).flatMap((root) =>
      Object.keys(STATE_HOMES).map((home) => workflowDir(root, { home }))),
  });
  if (copies.length === 0) {
    const branch = extractFrontmatterBranch(text);
    // Throws, naming both files, when the integration branch has a second one.
    if (branch) await findActiveWorkflowByBranchInRoots(writerRoots(inferred.stateRoot), branch);
  }
  if (copies.length > 0) {
    throw new Error(
      `Ambiguous orchestrator workflow storage: ${name} is held by ${copies.length + 1} files: ` +
        `${[absolute, ...copies].map((f) => JSON.stringify(f)).join(', ')}. One macro has one writable copy ` +
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
  return withDirectoryLock(defaultRoot, () => withDirectoryLock(storage.stateRoot, fn, { storage }), { storage: repoStorage });
}

/**
 * ADR-0031 amendment — fire the orchestrator activation sidecar for a macro
 * whose must-run completion mutation just landed (the file lock has released).
 * Lazy dynamic import: a static `state.mjs -> session-handoff.mjs` import would
 * cycle (session-handoff imports state), and a top-level await of a
 * back-importing module can deadlock settlement, so the import stays inside this
 * async fn. Fail-closed + non-fatal: never throws; the sidecar writes only
 * stderr + a projection file, never stdout (the completion scripts' stdout
 * contracts are load-bearing). Shared by setMacroTerminal + updateSubtask so the
 * two macro terminal surfaces fire identically.
 */
async function fireMacroHandoffSidecar(workflowPath, host) {
  try {
    const inferred = inferStorageFromWorkflowPath(workflowPath);
    if (!inferred) return;
    // ADR-0067 Decision 1(a) — the slot belongs to the checkout the command
    // runs in, not to the root that holds the macro.
    const { stateRoot, home } = inferred;
    const repoRoot = commandCheckout(stateRoot);
    // A checkout that cannot be told writes no slot: the storage root's
    // would be another checkout's.
    if (repoRoot === null) {
      process.stderr.write(
        'orchestrator: handoff slot not written: the checkout this command runs in cannot be told ' +
          '(git failed); the terminal write has landed (ADR-0067 Decision 1(a)).\n',
      );
      return;
    }
    const projectionFile = join(statePaths(repoRoot, home).root, 'last-session-handoff.json');
    const { emitTerminalHandoffSidecar } = await import('./session-handoff.mjs');
    // Project the EXACT macro just terminalized (by path), not whatever is
    // active on the current checkout branch — these mutations can be invoked
    // cross-branch on an explicit workflowPath.
    // ADR-0039 — thread host so the code-synthesized footer localizes its
    // commands (claude|codex); both macro terminal surfaces carry it.
    await emitTerminalHandoffSidecar({ repoRoot, workflowPath, projectionFile, host });
  } catch {
    // non-fatal: the terminal write already landed; the sidecar must never
    // break a macro completion (ADR-0031 amendment).
  }
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
    // ADR-0067 Decision 4, item 2 — checked holding the lock, so a copy that
    // appears while this writer waits for it is seen.
    await assertSingleCopy(workflowPath);
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
  // ADR-0067 Decision 1(a): both homes of every root of the read set, not the
  // home resolveWorkflowStorage selects: an active macro in the legacy home
  // stays listed while the canonical home holds only archive or peer state.
  return listWorkflowFilesAllHomes(repoRoot);
}

// The files of `dirs` whose names `keep` accepts, in that order, each
// directory's sorted, one entry per physical file, under the name that is not
// a link, else the first: the read set's default state root comes first, so
// of two plain names (a symlinked home) that one is kept (ADR-0067 Decision 4,
// items 1 and 2).
async function workflowFilesIn(dirs, keep = (name) => name.endsWith('.md') && !name.endsWith('.md.tmp')) {
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
      if (!keep(name)) continue;
      const file = join(dir, name);
      // A FIFO, a device or a directory under a workflow name is refused, as
      // runtime's readers refuse it (ADR-0067 Decision 4, item 1): the Stop's
      // sweep would otherwise wait on it.
      const problem = workflowEntryProblem(file);
      if (problem === 'gone') continue;
      if (problem !== null) {
        throw new Error(
          `orchestrator workflow home ${safeFilename(dir)}: ${name} is ${problem}. Remove it, or replace it with the workflow file (ADR-0067 Decision 4, item 1).`,
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
 * List workflow files (`.md` only) across BOTH the canonical and legacy
 * workflow homes. Unlike `listWorkflowFiles` (which resolves a single home via
 * `resolveWorkflowStorage`, preferring canonical in read mode), this is the
 * fail-closed-across-homes lister used by `findMacroBySubtaskBranch`: a macro
 * referenced by a subtask branch can live in either home, and a canonical+legacy
 * split must surface as an ambiguity rather than silently preferring canonical
 * (mirrors `findActiveWorkflowByBranch`'s both-homes scan; the ADR-0031
 * session-handoff projection depends on this lookup being fail-closed across
 * homes). ENOENT on either home is a clean skip.
 */
async function listWorkflowFilesAllHomes(repoRoot) {
  // ADR-0067 Decision 1(a): both homes of every root of the read set.
  return workflowFilesIn(lookupRoots(repoRoot).flatMap((root) => [
    workflowDir(root, { home: 'canonical' }),
    workflowDir(root, { home: 'legacy' }),
  ]));
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
// One file reached through two names in a directory (a symlink to it) is one
// macro; the name that is not a link is kept, so a writer is handed the file
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

// The active macro on `branch` across `roots`. One physical file reached twice
// counts once, under the name that is not a link, as within a home; two
// distinct files are an error naming both, never a choice (ADR-0067 Decision
// 1(a): one active macro per integration branch per repository).
async function findActiveWorkflowByBranchInRoots(roots, branch) {
  const found = [];
  for (const root of roots) {
    const file = await findActiveWorkflowByBranchInRoot(root, branch);
    if (file) addPhysicalMatch(found, file);
  }
  if (found.length <= 1) return found[0] ?? null;
  throw new Error(
    `Ambiguous orchestrator workflow storage: ${found.length} active workflows on branch ` +
      `${JSON.stringify(branch)}: ${found.map((f) => JSON.stringify(f)).join(', ')}. One active macro per ` +
      'integration branch holds across the state root and every checkout (ADR-0018 §sub-2, ADR-0067 ' +
      'Decision 1(a)): finish, finalize or archive one of them (docs/runbooks/state-root-cutover.md).',
  );
}

export async function findActiveWorkflowByBranch(repoRoot, branch) {
  if (!branch) return null;
  return findActiveWorkflowByBranchInRoots(lookupRoots(repoRoot), branch);
}

async function findActiveWorkflowByBranchInRoot(repoRoot, branch) {
  const canonical = await findActiveWorkflowByBranchInDir(
    workflowDir(repoRoot, { home: 'canonical' }),
    branch,
  );
  const legacy = await findActiveWorkflowByBranchInDir(
    workflowDir(repoRoot, { home: 'legacy' }),
    branch,
  );
  // Both homes holding it is the dual-home ambiguity even when one home links
  // to the other: writes there are refused (resolveWorkflowStorage), and the
  // runtime readers report it the same way (ADR-0067 Decision 4, item 1).
  if (canonical && legacy) {
    throw new Error(
      `Ambiguous orchestrator workflow storage: both ${WORKFLOW_DIR_REL} and ` +
        `${LEGACY_WORKFLOW_DIR_REL} contain an active workflow on branch ` +
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

/**
 * ADR-0019 §1 lines 187-213 — branch-agnostic macro lookup. Scans
 * every active orchestrator workflow file under BOTH workflow homes
 * (canonical + legacy) for the one whose `plan.subtasks[i].branch`
 * matches the supplied branch. Both homes are scanned so a canonical+legacy
 * split surfaces as an ambiguity (fail-closed) instead of silently
 * preferring one home.
 *
 * Used by `/orchestrator:next` and `/orchestrator:done` AFTER the user
 * has been switched to a subtask branch: `findActiveWorkflowByBranch`
 * keys on the macro's own `git_baseline.branch`, which no longer
 * matches the current branch once the runbook has switched. This
 * function bridges the gap by indexing into the macro plan's
 * subtasks[] table instead.
 *
 * Fail-closed uniqueness rule (ADR-0019 §1):
 *   - 0 match → returns null. Callers should surface "no macro
 *     workflow references this branch — use `--workflow <id>` to
 *     specify".
 *   - 1 match → returns the absolute path.
 *   - 2+ match → throws "ambiguous: branch <name> appears in macro
 *     workflows <id-A>, <id-B>; use `--workflow <id>` to specify".
 *     This prevents writes from landing on the wrong parent when the
 *     same branch name happens to appear in two separate non-archived
 *     macro plans.
 *
 * Archived workflows under `archive/` are NOT scanned — by design,
 * archived macros are frozen and do not participate in active dispatch.
 *
 * Empty / null / non-string branch returns null (defensive: callers
 * that probe with an empty branch get a clean miss rather than a
 * sentinel error).
 *
 * @param {string} repoRoot
 * @param {?string} branch
 * @returns {Promise<?string>}
 */
export async function findMacroBySubtaskBranch(repoRoot, branch) {
  if (typeof branch !== 'string' || branch.length === 0) return null;
  // Scan BOTH workflow homes (canonical + legacy). A single-home scan would
  // silently prefer canonical and miss a legacy macro, or pick a canonical
  // match while a legacy duplicate exists — breaking the fail-closed
  // uniqueness rule the ADR-0031 projection relies on.
  const files = await listWorkflowFilesAllHomes(repoRoot);
  const matching = [];
  for (const file of files) {
    let fm;
    try {
      // Through the frontmatter only, and regular files only: a FIFO is
      // refused, never waited on, and a long body is never read (ADR-0067
      // Decision 4, items 1 and 2).
      const text = readFrontmatterText(file);
      if (text === null) throw new Error('not a regular file');
      fm = parseWorkflowFile(text).frontmatter;
    } catch (err) {
      // Gone since the listing: an archive moved it, so it is not active.
      if (err?.code === 'ENOENT') continue;
      // Fail-closed on parse failure (Codex P2 finding): a corrupt or
      // unreadable workflow file COULD be the matching macro, or one of
      // two ambiguous macros referencing this branch. Silently skipping
      // it would let a different file win the lookup and produce a
      // wrong-parent writeback. Surface the corruption to the user so
      // they can reconcile (repair the file or archive it).
      throw new Error(
        `findMacroBySubtaskBranch: cannot parse workflow file ${safeFilename(file)} ` +
          `(${err?.message ?? err}). Branch-agnostic macro lookup must fail-closed ` +
          `on corruption (ADR-0019 §1 fail-closed uniqueness). Repair or archive ` +
          `the corrupt workflow file before re-running /orchestrator:next or /done.`,
      );
    }
    const subtasks = fm?.plan?.subtasks;
    if (!Array.isArray(subtasks)) continue;
    for (const s of subtasks) {
      if (s && typeof s === 'object' && s.branch === branch) {
        matching.push(file);
        break;
      }
    }
  }
  if (matching.length === 0) return null;
  if (matching.length === 1) return matching[0];
  // 2+ match — ambiguous. List the involved workflow ids in the
  // diagnostic so the user can pick the right `--workflow <id>`.
  const ids = matching.map((f) => f.split('/').pop().replace(/\.md$/, ''));
  throw new Error(
    `findMacroBySubtaskBranch: ambiguous — branch ${JSON.stringify(branch)} ` +
      `appears in macro workflows ${ids.map((i) => JSON.stringify(i)).join(', ')}; ` +
      `use \`--workflow <id>\` to specify which macro the dispatch should target.`,
  );
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
  // Orchestrator meta-command parity — same additive checkpoint shape
  // as engineer ADR-0017 §sub-decision-2, scoped to macro workflows.
  'latest_checkpoint',
  'pending_ensemble',
  'ensemble_results',
  // ADR-0019 PR-B (1.1) — optional top-level boolean. Set by
  // /orchestrator:finalize / /orchestrator:abort (PR-E) or
  // auto-set when all subtasks become terminal (parent-writeback
  // auto-terminal pass per ADR-0019 §4 step 7). Required by §5 A1
  // gate for orchestrator stop-archive.
  'terminal_marker',
  // ADR-0063 D6 (1.2) — optional flat scalars, absent = null. They sit at
  // the tail, after terminal_marker, which is where a 1.1 reader's
  // forward-compat carrier writes keys it does not know, so a 1.1 reader's
  // write leaves them in place.
  'plan_approval_status',
  'plan_approval_approved_at',
  'plan_approval_plan_hash',
  'awaiting_owner_gate',
  'awaiting_owner_since',
  'awaiting_owner_pointer',
  // ADR-0067 Decision 8 — the run id plan-conflict records. Last, for the
  // same carrier reason: a reader that does not know it re-emits it after
  // every key it knows, in place.
  'awaiting_owner_run_id',
];

// ADR-0028 §Forward-compat (PR5 #356 ported from engineer) — invisible
// carrier for unknown additive scalar frontmatter keys observed when a
// 1.x reader meets a 1.y file with y > x. The parser stashes
// `[{key, value, raw}]` in file-encounter order; the serializer re-emits
// them at the tail (after all known FRONTMATTER_KEY_ORDER entries, before
// the closing `---`). Symbol-keyed so `Object.keys(fm)` and `key in fm`
// checks remain blind to it — existing closed-schema gates keep rejecting
// truly-malformed non-additive deviations without false-positives.
//
// Carrier entry shape: `{key, value, raw}`. `value` is the parsed scalar
// for consumer-side typed access (e.g. diagnostic CLI `read` JSON output
// surfaces it as `_forward_compat_unknowns`). `raw` is the original post-
// colon line tail (verbatim YAML scalar literal) — the serializer emits
// `${key}: ${raw}` to round-trip byte-identical for inline forms the
// parseScalar/yamlScalar pipeline does not preserve (notably bare `[]`
// and `{}` which permissive-fallback to strings then re-emit as quoted).
//
// Scope: scalar inline values only. Block-style unknown keys (list-of-
// objects, nested object) remain rejected at parse time with a forward-
// compat-aware error.
//
// Position fidelity: tail-emit. All current orchestrator additives
// (ADR-0017 sub-decisions ported per orchestrator parity, plus ADR-0019
// PR-B `terminal_marker`) cluster at the end of FRONTMATTER_KEY_ORDER,
// so tail-emit matches the disk shape for every realistic 1.x → 1.y pair.
export const FORWARD_COMPAT_UNKNOWNS = Symbol('forward_compat_unknowns');

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

    if (key === 'latest_checkpoint') {
      lines.push(`${key}:`);
      lines.push(`  at: ${yamlScalar(value.at)}`);
      lines.push(`  summary: ${yamlScalar(value.summary)}`);
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

  // ADR-0028 §Forward-compat (PR5 ported) — re-emit unknown additive
  // scalar keys stashed by parseWorkflowFile. Tail position matches the
  // disk shape for every realistic 1.x → 1.y pair. Emit prefers `raw`
  // (verbatim line tail) over re-serializing `value` — this keeps inline
  // `[]`, `{}`, and any future YAML scalar literal that parseScalar/
  // yamlScalar do not round-trip byte-identical. When carrier entries
  // are constructed programmatically (no parser-side `raw`), fall back
  // to yamlScalar(value).
  const unknowns = fm[FORWARD_COMPAT_UNKNOWNS];
  if (Array.isArray(unknowns)) {
    for (const entry of unknowns) {
      const { key, value, raw } = entry;
      const lineTail = typeof raw === 'string' ? raw : yamlScalar(value);
      lines.push(`${key}: ${lineTail}`);
    }
  }

  for (const key of Object.keys(fm)) {
    if (!FRONTMATTER_KEY_ORDER.includes(key)) {
      throw new Error(
        `Unknown frontmatter key: ${key}. orchestrator schema '1.y' is closed; ADR-0028 §Forward-compat (PR5 ported) routes scalar unknowns to FORWARD_COMPAT_UNKNOWNS Symbol carrier.`,
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
      if (
        key === 'git_baseline' ||
        key === 'last_snapshot' ||
        key === 'latest_checkpoint'
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
      // ADR-0028 §Forward-compat (PR5 ported) — block-style unknown keys
      // remain rejected. The current parser is line-oriented (split on
      // `\n`, no comment handling), so verbatim raw-line preservation
      // for a block value requires structural changes outside this PR's
      // scope.
      throw new Error(
        `Empty value for unrecognized block key: ${key}. ADR-0028 §Forward-compat read-tolerance supports scalar additive keys only; block-style unknown keys remain a closed-schema rejection.`,
      );
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
    // ADR-0028 §Forward-compat (PR5 ported) — unknown scalar additive
    // keys are stashed under the Symbol carrier so the post-loop closed-
    // schema gate doesn't false-positive. Schema-version acceptance
    // happens later in validateFrontmatter via isSupportedSchema();
    // closed-schema rejection still applies to non-additive deviations
    // and unknown majors per ADR-0028 §Forward-compat rule 3.
    //
    // Empty key gate — `: value` produces `key === ''`; reject explicitly
    // so a malformed line cannot smuggle a nameless entry into the
    // carrier and round-trip out as invalid YAML.
    if (key === '') {
      throw new Error(
        `Empty frontmatter key (line ${i}). orchestrator schema closed-rejection still applies to nameless keys; ADR-0028 §Forward-compat does not relax this.`,
      );
    }
    if (!FRONTMATTER_KEY_ORDER.includes(key)) {
      const carrier = fm[FORWARD_COMPAT_UNKNOWNS] ??= [];
      // Preserve the raw post-colon line tail so round-trip emit matches
      // the original byte-for-byte (parseScalar('[]') would coerce an
      // inline empty-list additive to the string '[]' which yamlScalar
      // then re-emits as '"[]"' — a semantic type change).
      carrier.push({ key, value: parseScalar(rest), raw: rest });
      i += 1;
      continue;
    }
    fm[key] = parseScalar(rest);
    i += 1;
  }

  for (const key of Object.keys(fm)) {
    if (!FRONTMATTER_KEY_ORDER.includes(key)) {
      throw new Error(
        `Unknown frontmatter key: ${key}. orchestrator schema '1.y' is closed; ADR-0028 §Forward-compat (PR5 ported) routes scalar unknowns to FORWARD_COMPAT_UNKNOWNS Symbol carrier.`,
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
  // ADR-0028 §Forward-compat (PR5 ported) — accept via predicate, not
  // closed Set. The Set continues to enumerate explicitly-known minors
  // for telemetry / diagnostic purposes (and existing tests assert its
  // contents); the gate that the parser actually runs is the open-ended
  // 1.x predicate.
  if (!isSupportedSchema(fm.schema)) {
    const knownMinors = [...SUPPORTED_SCHEMA_VERSIONS]
      .map((v) => JSON.stringify(v))
      .join(', ');
    throw new Error(
      `Unsupported schema version: ${JSON.stringify(fm.schema)}. ` +
      `ADR-0028 §Forward-compat accepts any "1.y" minor string; unknown majors ` +
      `(e.g., "2.0"), the bare string "1", the number form of any value, and ` +
      `malformed minors are rejected. Engineer schema 1 (legacy number form) ` +
      `is rejected at this gate; engineer 1.x string forms pass the schema ` +
      `predicate but are then rejected downstream by orchestrator's required-` +
      `key set (workflow_type 'macro', plan.subtasks block). Explicitly-known ` +
      `minors as of this build: ${knownMinors}.`,
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
  // Read boundary — `persisted: true` switches the cycle diagnostic to
  // on-disk repair/retire guidance (the plan cannot be fixed by re-sending
  // a payload; the file itself has to change).
  validateSubtasks(fm.plan.subtasks, fm.schema, fm.git_baseline?.branch ?? null, { persisted: true });

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

  if ('latest_checkpoint' in fm) {
    validateNestedShape(fm, 'latest_checkpoint', ['at', 'summary']);
    if (typeof fm.latest_checkpoint.at !== 'string') {
      throw new Error('latest_checkpoint.at must be a string');
    }
    if (typeof fm.latest_checkpoint.summary !== 'string') {
      throw new Error('latest_checkpoint.summary must be a string');
    }
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

  validateSchema12Fields(fm);
}

/**
 * ADR-0063 D6 schema 1.2 — the flat `plan_approval_*` and `awaiting_owner_*`
 * scalars. Validation is per key, so a file on disk schema 1.1 may carry them
 * (mutation helpers never promote the schema). Beyond each value's enum or
 * format, the keys hold together:
 * - `plan_approval_approved_at` and `plan_approval_plan_hash` are present
 *   exactly when `plan_approval_status` is `approved`;
 * - the three `awaiting_owner_*` keys appear all or none;
 * - a pending plan waits on a macro gate, and a macro gate is set only on a
 *   pending plan (both gates are about its approval).
 * Mutation helpers run this on the frontmatter they are about to write, so an
 * inconsistent combination never reaches disk.
 */
function validateSchema12Fields(fm) {
  if ('plan_approval_status' in fm) {
    validateEnumScalar('plan_approval_status', fm.plan_approval_status, VALID_PLAN_APPROVAL_STATUSES);
  }
  if ('plan_approval_approved_at' in fm) {
    validateIsoUtc('plan_approval_approved_at', fm.plan_approval_approved_at);
  }
  if ('plan_approval_plan_hash' in fm) {
    validatePlanHash('plan_approval_plan_hash', fm.plan_approval_plan_hash);
  }
  const approved = fm.plan_approval_status === 'approved';
  for (const key of ['plan_approval_approved_at', 'plan_approval_plan_hash']) {
    if ((key in fm) !== approved) {
      throw new Error(
        `${key} must be present exactly when plan_approval_status is approved ` +
          `(got plan_approval_status=${JSON.stringify(fm.plan_approval_status ?? null)}, ` +
          `${key}=${JSON.stringify(fm[key] ?? null)}) (ADR-0063 D6)`,
      );
    }
  }

  const present = AWAITING_OWNER_KEYS.filter((k) => k in fm);
  if (present.length > 0 && present.length < AWAITING_OWNER_KEYS.length) {
    throw new Error(
      `awaiting_owner_gate, awaiting_owner_since and awaiting_owner_pointer must be present all or none (got ${present.join(', ')}) (ADR-0063 D6)`,
    );
  }
  if (present.length === AWAITING_OWNER_KEYS.length) {
    validateEnumScalar('awaiting_owner_gate', fm.awaiting_owner_gate, VALID_MACRO_OWNER_GATES);
    validateIsoUtc('awaiting_owner_since', fm.awaiting_owner_since);
    validateAwaitingOwnerPointer(fm.awaiting_owner_pointer);
  }
  // ADR-0067 Decision 8 — only the run id's form is a read error. That it
  // sits with plan-conflict is a writer's rule and decides whether the task
  // file is current: a pre-CP script carries the key through its
  // forward-compat carrier while it re-sets or clears the gate, and such a
  // file must still read.
  if (AWAITING_OWNER_RUN_ID in fm && !isSafeConsensusRunId(fm[AWAITING_OWNER_RUN_ID])) {
    throw new Error(
      'awaiting_owner_run_id must be a run id of [A-Za-z0-9_-] starting with a letter or digit, ' +
        `at most 128 characters (got ${JSON.stringify(fm[AWAITING_OWNER_RUN_ID])}) (ADR-0067 Decision 8)`,
    );
  }

  const pending = fm.plan_approval_status === 'pending';
  const gated = VALID_MACRO_OWNER_GATES.has(fm.awaiting_owner_gate);
  if (pending !== gated) {
    throw new Error(
      'a pending plan waits on awaiting_owner_gate plan-approval or plan-conflict, and those gates ' +
        'are set only while the plan is pending approval ' +
        `(got plan_approval_status=${JSON.stringify(fm.plan_approval_status ?? null)}, ` +
        `awaiting_owner_gate=${JSON.stringify(fm.awaiting_owner_gate ?? null)}) (ADR-0063 D6)`,
    );
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

function validatePlanHash(key, value) {
  if (typeof value !== 'string' || !PLAN_HASH_RE.test(value)) {
    throw new Error(`${key} must be a sha256 digest in 64 lowercase hex characters (got ${JSON.stringify(value)})`);
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

// Kahn / topological walk over `plan.subtasks[*].blocked_by`, edges
// deduplicated first. Returns `null` when the dependency graph is acyclic;
// otherwise `{ cycle, residue }` where `cycle` is one concrete cycle as an
// id chain with the first id repeated at the end (X followed by Y reads
// "X is blocked_by Y") and `residue` is every subtask the walk could not
// retire — the cycle members plus everything transitively blocked_by them,
// i.e. exactly the subtasks that can never become ready.
//
// Duplicate edges are collapsed before counting: a repeated blocked_by entry
// (`['A', 'A']`) is the same dependency stated twice, not a second one.
// Deduplicating up front keeps the in-degree and the adjacency list derived
// from one edge set, so a duplicate can never inflate one side without the
// other (an in-degree of 2 against a single retire signal would leave `B`
// stuck above zero after `A` retires and false-positive an acyclic plan).
// Unknown dependency ids are ignored here (validateSubtasks rejects them
// before this walk runs), so the helper is total on any id/blocked_by list.
// Exported for tests; validateSubtasks is the only production caller.
export function findBlockedByCycle(subtasks) {
  const deps = new Map(); // id → Set<dep id> (deduplicated, known ids only)
  for (const e of subtasks) {
    deps.set(e.id, new Set(Array.isArray(e.blocked_by) ? e.blocked_by : []));
  }
  const indegree = new Map(); // id → number of distinct known deps
  const dependents = new Map(); // dep id → ids that are blocked_by it
  for (const [id, set] of deps) {
    let n = 0;
    for (const dep of set) {
      if (!deps.has(dep)) continue;
      n += 1;
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep).push(id);
    }
    indegree.set(id, n);
  }
  const queue = [];
  for (const [id, n] of indegree) if (n === 0) queue.push(id);
  let retired = 0;
  for (let qi = 0; qi < queue.length; qi += 1) {
    retired += 1;
    for (const dependent of dependents.get(queue[qi]) ?? []) {
      const n = indegree.get(dependent) - 1;
      indegree.set(dependent, n);
      if (n === 0) queue.push(dependent);
    }
  }
  if (retired === deps.size) return null;
  const residue = [];
  for (const [id, n] of indegree) if (n > 0) residue.push(id);
  // Extract one explicit cycle without recursion. Every residue node keeps
  // at least one dependency inside the residue (that is exactly why Kahn
  // could not retire it), so following the first in-residue dependency from
  // any residue node must revisit some node within |residue| steps, and the
  // path from that node's first visit back to it is a cycle. Iterative,
  // O(|residue|), deterministic (insertion order) — and bounded for a plan
  // of any size: a recursive DFS here overflowed the call stack on a
  // ~5,000-subtask ring (peer finding), which would have replaced the
  // actionable diagnostic with a RangeError. The `undefined` guard keeps the
  // helper total if it is ever handed an inconsistent graph; the formatter
  // then falls back to listing the residue.
  const residueSet = new Set(residue);
  const firstVisit = new Map(); // id → index in `path`
  const path = [];
  let cur = residue[0];
  while (cur !== undefined && !firstVisit.has(cur)) {
    firstVisit.set(cur, path.length);
    path.push(cur);
    let next;
    for (const dep of deps.get(cur)) {
      if (residueSet.has(dep)) { next = dep; break; }
    }
    cur = next;
  }
  const cycle = cur === undefined ? null : [...path.slice(firstVisit.get(cur)), cur];
  return { cycle, residue };
}

// Diagnostic for a cyclic plan. `persisted` selects the remedy: at the
// write boundary (plan-set) the caller can simply fix the payload; on the
// read boundary the cycle is already on disk, and because every reader
// validates on parse (ADR-0018 §sub-1 closed schema), the file has to be
// repaired or retired by hand before any command — including the archive
// CLI, which parses first — will touch it again.
//
// Every id is rendered through JSON.stringify: validateSubtasks only requires
// ids to be non-empty strings, and this text reaches CLI stderr verbatim, so
// a newline or ANSI/OSC byte in an id must arrive escaped, not interpreted
// (peer finding). The stuck-subtask listing is capped so a pathological plan
// cannot turn the diagnostic into a dump; the cap is stated, not silent.
const CYCLE_RESIDUE_LIST_CAP = 24;

function formatBlockedByCycleError({ cycle, residue }, { persisted = false } = {}) {
  const q = (id) => JSON.stringify(id);
  const chainIds = cycle ?? [...residue, residue[0]];
  const chain = chainIds.map(q).join(' -> ');
  const selfReference = chainIds.length === 2 && chainIds[0] === chainIds[1];
  const shown = residue.slice(0, CYCLE_RESIDUE_LIST_CAP).map(q).join(', ');
  const more = residue.length > CYCLE_RESIDUE_LIST_CAP
    ? ` (+${residue.length - CYCLE_RESIDUE_LIST_CAP} more)`
    : '';
  const head =
    `plan.subtasks blocked_by cycle detected: ${chain} ` +
    (selfReference
      ? `(self-reference: ${q(chainIds[0])} is blocked_by itself). `
      : `(X -> Y reads "X is blocked_by Y"). `) +
    `blocked_by must be acyclic — a cycle has no member that can be dispatched first, so ` +
    `dispatch can never reach any of its members (before this check the symptom was ` +
    `next-ready answering in_progress_or_blocked forever). Subtasks on or behind a cycle ` +
    `(none dispatchable until it is broken): ${shown}${more}. `;
  if (!persisted) {
    return (
      head +
      `Break the cycle by removing one blocked_by edge among the cycle members, then re-run plan-set.`
    );
  }
  return (
    head +
    `This plan is already persisted (written before cycle validation existed, or edited by hand), ` +
    `and every reader of this file — next-ready, resume, subtask-update, archive — fails closed on ` +
    `it until it is repaired. Repair: edit the workflow file's blocked_by entries to remove one edge ` +
    `among the cycle members. Or retire it: move the file out of the active workflows/ home into its ` +
    `sibling archive/ directory by hand (the archive CLI parses, and therefore rejects, this file too) ` +
    `and run /orchestrator:plan afresh.`
  );
}

// ADR-0018 §sub-1 + ADR-0019 §2 plan.subtasks[*] validation:
//   - id non-empty unique
//   - blocked_by → existing id, acyclic (no self-, mutual, or longer cycle)
//   - status enum (1.1 adds deferred / abandoned)
//   - optional fields are string-or-null
//   - 1.1: verb (canonical 6-verb whitelist) + branch (git ref-format) REQUIRED
//
// `schemaVersion` selects the required-key set: 1.0 retains the legacy
// invariants (id / blocked_by / status); 1.1 enforces verb + branch
// per ADR-0019 §1 branch precondition. The default `'1.1'` is for
// callers that don't have schema context (e.g., setPlan when emitting
// a fresh plan); validateFrontmatter passes the actual fm.schema.
//
// `persisted` marks the read boundary (validateFrontmatter on parse): the
// same invariants run there, but a violation means the bad plan is already
// on disk, so the cycle diagnostic switches from "fix the payload" to
// repair/retire guidance for the file.
function validateSubtasks(
  subtasks,
  schemaVersion = SCHEMA_VERSION,
  macroBranch = null,
  { persisted = false } = {},
) {
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
      if (!ids.has(dep)) {
        throw new Error(
          `plan.subtasks[${idx}].blocked_by references unknown subtask id ${JSON.stringify(dep)}`,
        );
      }
    }
  }
  // blocked_by must be a DAG. Unknown ids are rejected first (graph identity
  // has to be closed before the graph is walked); the walk then rejects every
  // cycle — self-reference (a 1-cycle, reported with that word so the
  // diagnostic stays recognisable), mutual A<->B, and longer. Measured
  // 2026-08-22: before it, only the 1-cycle was caught; a mutual and a
  // 3-cycle both passed plan-set and `next-ready` then answered
  // in_progress_or_blocked on every call — a silent deadlock, because a
  // cycle has no member that can be dispatched first. The walk runs on the
  // read boundary too, so a cyclic plan that is already on disk surfaces on
  // its first read (with repair/retire guidance for every cycle length,
  // 1-cycles included) instead of wedging dispatch forever.
  const cycle = findBlockedByCycle(subtasks);
  if (cycle) {
    throw new Error(formatBlockedByCycleError(cycle, { persisted }));
  }
}

// ADR-0019 PR-B — refuse mutations on legacy 1.0 files. Reads pass
// validateFrontmatter (1.0 supported), but writes back via setPlan /
// appendPhase / snapshot / ensemble helpers must abort with a
// diagnostic so legacy plans don't get half-migrated. Users either
// archive the legacy workflow or run /orchestrator:plan to start
// fresh under 1.1.
// ADR-0062 §Decision 7 — an archived macro is a frozen record. The subtask
// writers (plan-set, subtask-update including --correct, the engineer
// terminal note) refuse a path inside an `archive/` home, so a correction
// cannot be applied to history by naming the archived file directly.
function ensureNotArchived(workflowPath, writer) {
  if (basename(dirname(workflowPath)) === 'archive') {
    throw new Error(
      `${writer}: ${workflowPath} is an archived macro; archived macros are frozen records ` +
        `and are not changed in place (ADR-0062 §Decision 7).`,
    );
  }
}

function ensureMutable(fm) {
  if (fm.schema === '1.0') {
    throw new Error(
        `Cannot mutate schema 1.0 file (legacy ADR-0018 §sub-1 shape). ` +
        `Per ADR-0019 PR-B schema bump, /orchestrator:plan now emits 1.1 workflows. ` +
        `Archive this legacy workflow through /orchestrator:resume archive ` +
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

  // ADR-0067 Decision 2: across the repository — the read set, the root the
  // macro goes to, and the own homes of every other worktree.
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

  const filePath = join(storage.workflows, `${workflowId}.md`);
  await ensureDir(storage.workflows, 0o700);
  await atomicWrite(filePath, assembleWorkflowFile(frontmatter, body), ownership);

  return { workflowId, filePath, frontmatter, body };
}

// ADR-0067 Decision 1(a): a macro is created in the checkout while shared
// creation is off; once it is on, under AGENTIC_STATE_BASE, else the default
// state root. Throws on an unreadable switch or a refused AGENTIC_STATE_BASE.
export async function createWorkflow(args) {
  assertAbsoluteRepoRoot(args.repoRoot);
  const placement = creationRoot(args.repoRoot, { env: args.env ?? process.env });
  const storage = await resolveWorkflowStorage(placement.root, { mode: 'write' });
  return withCreationLocks(storage, ({ lockPath, token }) =>
    createWorkflowUnderLock(args, { lockPath, token, storage }),
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
  // ADR-0062 §Decision 4 — refuse, under this write's own lock, when the
  // macro is terminal. /orchestrator:plan passes it on both of its phase
  // appends, so a macro finalized by another session between a check and
  // the append cannot be left with terminal_marker and a non-terminal phase.
  requireOpen = false,
}) {
  validateHost(host);
  validateHookEvent(event);
  if (verb !== undefined) validateVerb(verb);

  return withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    ensureMutable(frontmatter);
    if (requireOpen && frontmatter.terminal_marker === true) {
      throw new Error(
        `append: this terminal macro is not revised (current_phase ` +
          `${JSON.stringify(frontmatter.current_phase)}, ADR-0062 §Decision 4). ` +
          `Archive it (/orchestrator:resume archive) and start a new /orchestrator:plan.`,
      );
    }
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
// Public API: setCheckpoint — orchestrator meta-command parity.

/**
 * Set `latest_checkpoint` on a macro workflow and append a `checkpointed`
 * host_history entry under the per-file lock. This mirrors engineer's
 * ADR-0017 §sub-decision-2 surface, but the workflow namespace remains
 * orchestrator-specific (`workflow_type: macro`, plan/subtasks schema).
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
    ensureMutable(frontmatter);
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
// id uniqueness, blocked_by → existing id + acyclic (self-, mutual, and
// longer cycles all rejected), and status enum.

// ADR-0062 §Decision 5 — the unblock pass both plan writers run. A `blocked`
// subtask whose `blocked_by` entries are all `completed` becomes `pending`;
// an empty `blocked_by` counts as satisfied (a revision that removed the last
// dependency). Mutates `subtasks` in place and returns the promoted ids.
function applyUnblockPass(subtasks) {
  const completedIds = new Set(
    subtasks.filter((s) => s.status === 'completed').map((s) => s.id),
  );
  const promoted = [];
  for (let i = 0; i < subtasks.length; i++) {
    const s = subtasks[i];
    if (s.status !== 'blocked') continue;
    const deps = Array.isArray(s.blocked_by) ? s.blocked_by : [];
    if (deps.every((depId) => completedIds.has(depId))) {
      subtasks[i] = { ...s, status: 'pending' };
      promoted.push(s.id);
    }
  }
  return promoted;
}

// ADR-0062 §Decision 5 — readiness facts for /orchestrator:next, taken from
// the plan rather than inferred from a status. `waiting_on` lists the
// `blocked_by` entries not yet completed; `stale_blocked` marks a `blocked`
// subtask with nothing left to wait on (a file written before the shared
// unblock pass); `ready` is what next-ready would dispatch.
export function subtaskReadiness(subtasks) {
  const completedIds = new Set(
    subtasks.filter((s) => s?.status === 'completed').map((s) => s.id),
  );
  return subtasks.map((s) => {
    const blockedBy = Array.isArray(s?.blocked_by) ? s.blocked_by : [];
    const waitingOn = blockedBy.filter((d) => !completedIds.has(d));
    return {
      id: s?.id,
      status: s?.status,
      blocked_by: blockedBy,
      waiting_on: waitingOn,
      stale_blocked: s?.status === 'blocked' && waitingOn.length === 0,
      ready: s?.status === 'pending' && waitingOn.length === 0,
    };
  });
}

// ADR-0062 §Decision 3 — a completed subtask survives a plan revision
// unchanged: the work it names (verb, branch, topic, …) and the record of its
// completion alike. A field the revision omits is carried forward; changing
// or dropping one, changing the status, or removing the subtask needs
// `correct`. A field the record never had may be added. Returns the merged
// list (new objects; the caller's array is not mutated) and the changes a
// correction made, for the audit note.
function carryCompletedSubtasks(previous, revised, { correct }) {
  const merged = revised.map((s) => (s && typeof s === 'object' ? { ...s } : s));
  const changes = [];
  const refuse = (message) => {
    throw new Error(
      `setPlan: ${message}. A completed subtask is kept as recorded (ADR-0062 §Decision 3); ` +
        `to change it deliberately, pass --correct with a reason.`,
    );
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const prev of previous) {
    if (!prev || prev.status !== 'completed') continue;
    const next = merged.find((s) => s && s.id === prev.id);
    if (!next) {
      if (!correct) refuse(`completed subtask ${JSON.stringify(prev.id)} is missing from the revision`);
      changes.push(`removed completed subtask ${JSON.stringify(prev.id)}`);
      continue;
    }
    for (const key of Object.keys(prev)) {
      if (!(key in next)) {
        next[key] = prev[key];
        continue;
      }
      if (same(next[key], prev[key])) continue;
      if (!correct) {
        refuse(`completed subtask ${JSON.stringify(prev.id)} would change ${key} from ${JSON.stringify(prev[key])} to ${JSON.stringify(next[key])}`);
      }
      changes.push(`${prev.id}.${key}: ${JSON.stringify(prev[key])} -> ${JSON.stringify(next[key])}`);
    }
  }
  return { merged, changes };
}

export async function setPlan({
  workflowPath,
  decision = null,
  architecture = null,
  subtasks,
  host,
  event = 'updated',
  now = new Date(),
  correct = false,
  reason,
  // ADR-0063 D6 — the Plan-verify verdict of the plan being written. A
  // conflict opens the plan-conflict gate in this same write, so there is no
  // moment at which a disputed plan is approvable. Optional: a plan written
  // without a verdict opens plan-approval.
  verdict,
  // ADR-0067 Decision 8 — with the verdict conflict, the run id of the
  // Plan-verify synthesis, which the plan-conflict gate records.
  runId,
}) {
  validateHost(host);
  validateHookEvent(event);
  if (!Array.isArray(subtasks)) {
    throw new Error('setPlan: subtasks must be an array');
  }
  if (verdict !== undefined && !PLAN_VERIFY_VERDICTS.has(verdict)) {
    throw new Error(
      `setPlan: verdict must be one of ${[...PLAN_VERIFY_VERDICTS].join(', ')} (got ${JSON.stringify(verdict)})`,
    );
  }
  if (runId !== undefined) {
    if (verdict !== 'conflict') {
      throw new Error('setPlan: a run id goes with the verdict conflict, which plan-conflict records it with (ADR-0067 Decision 8)');
    }
    if (!isSafeConsensusRunId(runId)) {
      throw new Error(`setPlan: ${JSON.stringify(runId)} is not a run id of [A-Za-z0-9_-] (ADR-0067 Decision 8)`);
    }
  }
  if (typeof correct !== 'boolean') {
    throw new Error('setPlan: correct must be a boolean');
  }
  if (reason !== undefined && typeof reason !== 'string') {
    throw new Error('setPlan: reason must be a string');
  }
  const reasonText = typeof reason === 'string' ? scrubSecrets(reason).trim() : '';
  if (correct && reasonText.length === 0) {
    throw new Error(
      'setPlan: --correct requires a non-empty reason (ADR-0062 §Decision 3: ' +
        'a correction records why the recorded value was wrong).',
    );
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

  ensureNotArchived(workflowPath, 'setPlan');
  return withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    // Per ADR-0019 PR-B: refuse mutation on 1.0 files BEFORE running
    // validateSubtasks so legacy plans get the archive/re-plan
    // diagnostic instead of a confusing "Missing required verb"
    // (which would mislead users who haven't realized their file
    // is the legacy shape).
    ensureMutable(frontmatter);
    // ADR-0062 §Decision 4 — a terminal macro is not revised. The /plan
    // runbook rewrites current_phase around plan-set, so revising a macro
    // whose terminal_marker is set would leave the marker with a
    // non-terminal phase (archive gate A2 then rejects it forever), and it
    // would reopen a file the Stop hook may be archiving.
    if (frontmatter.terminal_marker === true) {
      throw new Error(
        `setPlan: this terminal macro is not revised (current_phase ` +
          `${JSON.stringify(frontmatter.current_phase)}, ADR-0062 §Decision 4). ` +
          `Archive it (/orchestrator:resume archive) and start a new /orchestrator:plan.`,
      );
    }
    const previous = Array.isArray(frontmatter.plan?.subtasks) ? frontmatter.plan.subtasks : [];
    const { merged, changes } = carryCompletedSubtasks(previous, subtasks, { correct });
    // Pass macro branch for the §1 prefix-collision gate so a subtask
    // branch cannot path-collide with the parent macro branch.
    validateSubtasks(merged, frontmatter.schema, frontmatter.git_baseline?.branch ?? null);
    const promoted = applyUnblockPass(merged);
    // setPlan never auto-terminals (ADR-0062 §Decision 5): the runbook would
    // overwrite the terminal phase right after, and closing a macro is
    // /orchestrator:finalize's decision. The caller reports it instead.
    const allTerminal = merged.length > 0
      && merged.every((s) => TERMINAL_SUBTASK_STATUSES.has(s.status));
    const nowIso = isoUtc(now);

    const plan = { subtasks: merged };
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

    // ADR-0063 D6 — any plan write revokes an approval: the plan goes back to
    // pending and waits on the owner's approval of what was just written. A
    // plan-conflict gate on the previous plan goes with it; the revision was
    // verified again, and its own verdict decides which gate it opens.
    const conflict = verdict === 'conflict';
    const approvalNote = describeApprovalReset(frontmatter, { conflict });
    resetPlanApproval(frontmatter, workflowPath, nowIso, { conflict, runId });
    validateSchema12Fields(frontmatter);
    // ADR-0067 Decision 8 — a re-plan replaces the gate without a clear, so
    // every task file of the macro is retired before the write, once the new
    // plan has passed every check: the previous plan's proposal is never
    // current beside the new one. A write that fails after this leaves the
    // previous gate with no current proposal, never a stale one.
    const retired = [];
    for (const old of await liveConsensusRuns(workflowPath, frontmatter.workflow_id)) {
      retired.push(await retireConsensusTask(workflowPath, frontmatter.workflow_id, old, { lockPath, token }));
    }

    const noteHeading = `### plan-set @ ${nowIso}\n\n`;
    const noteSummary =
      `${merged.length} subtask${merged.length === 1 ? '' : 's'}` +
      `${decision ? ', decision recorded' : ''}` +
      `${architecture ? ', architecture recorded' : ''}` +
      `${promoted.length > 0 ? `; unblocked: ${promoted.join(', ')}` : ''}.\n\n`;
    const correctionNote = changes.length > 0
      ? `Correction (--correct): ${changes.join('; ')}.\n\n`
      : '';
    const reasonNote = reasonText.length > 0 ? `Reason: ${reasonText}\n\n` : '';
    const newBody = `${body}${noteHeading}${noteSummary}${approvalNote}${correctionNote}${reasonNote}`;

    await atomicWrite(
      workflowPath,
      assembleWorkflowFile(frontmatter, newBody),
      { lockPath, token },
    );
    return {
      frontmatter, workflowPath, promoted, allTerminal,
      retiredConsensus: retired.map((r) => r.retired).filter(Boolean),
      warnings: retired.map((r) => r.warning).filter(Boolean),
    };
  });
}

// -----------------------------------------------------------------------------
// Public API: plan approval and the macro owner gates (ADR-0063 D6)
//
// The macro's approval moves through four states, each change one write under
// the macro's lock that leaves the §0.1 invariants holding:
//
//   (any)  ──plan-set──►  pending, gate plan-approval
//   (any)  ──plan-set --verdict conflict──►  pending, gate plan-conflict
//   pending, gate plan-approval  ──awaiting-owner-set plan-conflict──►  pending, gate plan-conflict
//   pending, gate plan-conflict  ──awaiting-owner-clear plan-conflict──►  pending, gate plan-approval
//   pending, gate plan-approval | absent | approved  ──plan-approve──►  approved (no gate)
//
// plan-approve refuses while plan-conflict is set, and plan-approval is never
// cleared except by approving: a pending plan always has a gate to halt on.
// Only the owner leaves a gate — clearing and approving are refused under an
// autopilot run.

// Repo-relative path of a macro file, from the state home it lives in rather
// than from repo_root (which records where the repository was when the macro
// was created).
function macroPointer(workflowPath, anchor) {
  const home = inferStorageFromWorkflowPath(workflowPath)?.home ?? 'canonical';
  return `${STATE_HOMES[home].workflowDirRel}/${basename(workflowPath)}#${anchor}`;
}

// ADR-0067 Decision 8 — every write that sets a gate sets the run id or
// deletes it; it returns the run id it replaced, whose task file the caller
// retires once the write has landed.
function setMacroGate(frontmatter, gate, { since, pointer, runId }) {
  const replaced = frontmatter[AWAITING_OWNER_RUN_ID];
  frontmatter.awaiting_owner_gate = gate;
  frontmatter.awaiting_owner_since = since;
  frontmatter.awaiting_owner_pointer = pointer;
  if (runId === undefined) delete frontmatter[AWAITING_OWNER_RUN_ID];
  else frontmatter[AWAITING_OWNER_RUN_ID] = runId;
  return replaced !== undefined && replaced !== runId ? replaced : null;
}

function clearMacroGate(frontmatter) {
  for (const k of AWAITING_OWNER_KEYS) delete frontmatter[k];
  delete frontmatter[AWAITING_OWNER_RUN_ID];
}

function resetPlanApproval(frontmatter, workflowPath, nowIso, { conflict = false, runId } = {}) {
  frontmatter.plan_approval_status = 'pending';
  delete frontmatter.plan_approval_approved_at;
  delete frontmatter.plan_approval_plan_hash;
  return setMacroGate(frontmatter, conflict ? 'plan-conflict' : 'plan-approval', {
    since: nowIso,
    pointer: macroPointer(workflowPath, conflict ? ENSEMBLE_SYNTHESIS_ANCHOR : MACRO_PLAN_ANCHOR),
    runId: conflict ? runId : undefined,
  });
}

// -----------------------------------------------------------------------------
// ADR-0067 Decision 8 — the macro's consensus task file
//
// A Plan-verify verdict of conflict sets plan-conflict with the run id of that
// synthesis, and the plan runbook writes the contested items to
// `<home>/consensus/<macro-id>.<run-id>.md`, in the macro's own home, where
// `runtime:consensus plan --task-file` reads them. The file is current only
// while plan-conflict names the run, ensemble_results holds the run with the
// verdict conflict, and the file exists. Every way the gate leaves retires the
// file (renamed `<macro-id>.<run-id>.resolved.md`, kept as evidence); plan-set
// retires every task file of the macro before it writes. Nothing here runs the
// consensus round: the owner does.

function consensusTaskPaths(workflowPath, workflowId, runId) {
  if (!isSafeConsensusRunId(runId) || typeof workflowId !== 'string' || !CONSENSUS_WORKFLOW_ID_RE.test(workflowId)) {
    return null;
  }
  const storage = workflowStorage(workflowPath);
  if (!storage) return null;
  const { consensus, consensusDirRel } = statePaths(storage.stateRoot, storage.home);
  const name = `${workflowId}.${runId}`;
  if (dirname(join(consensus, `${name}.md`)) !== consensus) return null;
  return {
    dir: consensus,
    file: join(consensus, `${name}.md`),
    resolved: join(consensus, `${name}.resolved.md`),
    pointer: `${consensusDirRel}/${name}.md`,
  };
}

// Whether the macro's lock still holds this writer's token, read again just
// before a task file is moved, as atomicWrite does before its commit: a writer
// whose lock was reclaimed as stale never retires a file the new owner made
// current.
async function holdsLock({ lockPath, token }) {
  return (await readFile(lockPath, 'utf8').catch(() => null)) === token;
}

// Rename a task file to its `.resolved.md` name, holding the macro's lock
// (`ownership`, as withFileLock gives it). Absent is nothing to retire; a lost
// lock or any other failure is a warning, since a file whose run the gate no
// longer names is not current, whatever its name.
export async function retireConsensusTask(workflowPath, workflowId, runId, ownership) {
  const paths = consensusTaskPaths(workflowPath, workflowId, runId);
  if (!paths) return { retired: null, warning: null };
  if (!(await holdsLock(ownership))) {
    return {
      retired: null,
      warning: `the consensus task file ${paths.file} was not retired: another writer reclaimed the lock on the macro`,
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

// Every live task file of a macro, by run id: `<macro-id>.<run-id>.md`, not
// the retired `.resolved.md` ones. The run-id alphabet has no `.`, so a name
// splits one way only.
async function liveConsensusRuns(workflowPath, workflowId) {
  const storage = workflowStorage(workflowPath);
  if (!storage || typeof workflowId !== 'string' || !CONSENSUS_WORKFLOW_ID_RE.test(workflowId)) return [];
  let names;
  try {
    names = await readdir(statePaths(storage.stateRoot, storage.home).consensus);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const prefix = `${workflowId}.`;
  return names
    .filter((n) => n.startsWith(prefix) && n.endsWith('.md') && !n.endsWith('.resolved.md'))
    .map((n) => n.slice(prefix.length, -'.md'.length))
    .filter(isSafeConsensusRunId)
    .sort();
}

const consensusPathWord = (text) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`);
// The bounded round ADR-0067 Decision 8 proposes, with the task file's
// absolute path (consensus.mjs resolves a relative one against its cwd).
function consensusCommand(taskFile, host) {
  return `${host === 'codex' ? '$' : '/'}runtime:consensus plan --task-file ${consensusPathWord(taskFile)} --peers claude,codex --max-rounds 2`;
}

/**
 * ADR-0067 Decision 8 — write the contested items of a Plan-verify conflict as
 * the macro's consensus task file for that run, and return the round it
 * proposes. Under the macro's lock, the run must be recorded in
 * ensemble_results with the verdict conflict (ensemble-commit came first).
 */
export async function writeConsensusTask(args) {
  ensureNotArchived(args.workflowPath, 'consensus-task');
  return withFileLock(args.workflowPath, (ownership) => writeConsensusTaskUnderLock(args, ownership));
}

// writeConsensusTask's body, for a caller already holding the macro's lock:
// the file is published with atomicWrite and the lock's token, so a writer
// whose lock was reclaimed never overwrites the new owner's task file.
export async function writeConsensusTaskUnderLock({ workflowPath, runId, text, host = 'claude' }, ownership) {
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
    throw new Error(`consensus-task: run ${runId} has no ensemble result on this macro; commit it first (ensemble-commit) (ADR-0067 Decision 8)`);
  }
  if (result.verdict !== 'conflict') {
    throw new Error(
      `consensus-task: run ${runId} is recorded with verdict ${JSON.stringify(result.verdict)}, not conflict; only a conflict is put to a consensus round (ADR-0067 Decision 8)`,
    );
  }
  const paths = consensusTaskPaths(workflowPath, frontmatter.workflow_id, runId);
  if (!paths) throw new Error(`consensus-task: ${JSON.stringify(workflowPath)} is not a macro file under an orchestrator state home`);
  await ensureDir(paths.dir, 0o700);
  await atomicWrite(paths.file, `${scrubSecrets(text).trim()}\n`, ownership);
  return { path: paths.file, pointer: paths.pointer, runId, command: consensusCommand(paths.file, host) };
}

/**
 * ADR-0067 Decision 8 — the macro's consensus proposal, read-only: current
 * only while plan-conflict names a run, ensemble_results holds that run with
 * the verdict conflict, and its task file exists.
 */
export async function consensusProposal({ workflowPath, host = 'claude' }) {
  validateHost(host);
  const { frontmatter } = parseWorkflowFile(await readFile(workflowPath, 'utf8'));
  const gate = frontmatter.awaiting_owner_gate ?? null;
  const runId = frontmatter[AWAITING_OWNER_RUN_ID] ?? null;
  const not = (reason) => ({ current: false, reason, gate, run_id: runId });
  if (gate !== 'plan-conflict') return not(gate === null ? 'no owner gate is set' : `the owner gate ${gate} is not plan-conflict`);
  if (runId === null) return not('the plan-conflict gate records no run id (raised by hand, or set before ADR-0067)');
  const result = (frontmatter.ensemble_results ?? []).find((e) => e?.run_id === runId);
  if (!result) return not(`run ${runId} has no ensemble result on this macro`);
  if (result.verdict !== 'conflict') return not(`run ${runId} is recorded with verdict ${result.verdict}`);
  const paths = consensusTaskPaths(workflowPath, frontmatter.workflow_id, runId);
  if (!paths) return not('the macro file is under no state home');
  if (!(await pathStat(paths.file))) return not(`the task file ${paths.pointer} does not exist`);
  return { current: true, gate, run_id: runId, task_file: paths.file, pointer: paths.pointer, command: consensusCommand(paths.file, host) };
}

// The plan-set note's approval line, from the state before the reset.
function describeApprovalReset(frontmatter, { conflict = false } = {}) {
  const gate = conflict
    ? 'plan-conflict: the Plan-verify ensemble reported a conflict'
    : 'plan-approval';
  let was = '';
  if (frontmatter.plan_approval_status === 'approved') {
    was = ` Revoked the approval of ${frontmatter.plan_approval_approved_at} ` +
      `(hash ${frontmatter.plan_approval_plan_hash.slice(0, 12)}).`;
  } else if (frontmatter.awaiting_owner_gate === 'plan-conflict') {
    was = ` Replaced the plan-conflict gate set at ${frontmatter.awaiting_owner_since}.`;
  }
  return `Plan approval: pending (awaiting_owner_gate=${gate}).${was}\n\n`;
}

function refuseUnderAutopilot(env, what) {
  if (isAutopilotRun(env)) {
    throw new Error(
      `${what} refused under autopilot (AGENTIC_AUTOPILOT=${env.AGENTIC_AUTOPILOT}): ` +
        'only the owner resolves an owner gate or approves a plan (ADR-0063 Q2)',
    );
  }
}

/**
 * ADR-0063 D6 — record that the macro waits on an owner judgment, with the
 * same contract as the engineer's awaiting-owner-set, on the macro gates.
 * Both gates concern a plan pending approval, so this is refused unless
 * plan-set has put the plan there. Setting the gate that is already set
 * replaces its pointer and since; a different gate is refused, except the one
 * transition the conflict path needs: plan-approval → plan-conflict.
 */
export async function setAwaitingOwner({
  workflowPath,
  host,
  gate,
  pointer,
  since,
  now = new Date(),
}) {
  validateHost(host);
  const fields = {
    awaiting_owner_gate: gate,
    awaiting_owner_since: since ?? isoUtc(now),
    awaiting_owner_pointer: pointer,
  };
  validateEnumScalar('awaiting_owner_gate', fields.awaiting_owner_gate, VALID_MACRO_OWNER_GATES);
  validateIsoUtc('awaiting_owner_since', fields.awaiting_owner_since);
  validateAwaitingOwnerPointer(fields.awaiting_owner_pointer);
  ensureNotArchived(workflowPath, 'awaiting-owner-set');
  return withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    ensureMutable(frontmatter);
    if (frontmatter.plan_approval_status !== 'pending') {
      throw new Error(
        `awaiting-owner-set: ${gate} is set only on a plan pending approval, and this macro's ` +
          `plan_approval_status is ${frontmatter.plan_approval_status ?? 'absent'}. ` +
          'plan-set puts a written plan there (ADR-0063 D6).',
      );
    }
    const current = frontmatter.awaiting_owner_gate;
    if (current !== gate && !(current === 'plan-approval' && gate === 'plan-conflict')) {
      throw new Error(
        `awaiting-owner-set: owner gate ${current} is set on this macro; ${gate} is not set over it. ` +
          'Clearing plan-conflict (awaiting-owner-clear --gate plan-conflict) returns the plan to plan-approval.',
      );
    }
    const nowIso = isoUtc(now);
    // A gate set here records no run id (ADR-0067 Decision 8): the key is
    // deleted, and the task file of the run it named is retired.
    const replacedRunId = setMacroGate(frontmatter, gate, {
      since: fields.awaiting_owner_since,
      pointer: fields.awaiting_owner_pointer,
    });
    validateSchema12Fields(frontmatter);
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
    const retired = replacedRunId === null
      ? { retired: null, warning: null }
      : await retireConsensusTask(workflowPath, frontmatter.workflow_id, replacedRunId, { lockPath, token });
    return { frontmatter, workflowPath, retired };
  });
}

/**
 * ADR-0063 D6 / Q2 — the owner resolves a macro gate. The gate named must be
 * the one set. Clearing plan-conflict returns the plan to plan-approval (it
 * is still pending approval); plan-approval itself is resolved only by
 * approving the plan. Refused under an autopilot run. The resolution is
 * recorded as a phase note, with the since and pointer it replaced.
 */
export async function clearAwaitingOwner({
  workflowPath,
  host,
  gate,
  env = process.env,
  now = new Date(),
}) {
  validateHost(host);
  refuseUnderAutopilot(env, 'awaiting-owner-clear');
  validateEnumScalar('awaiting_owner_gate', gate, VALID_MACRO_OWNER_GATES);
  ensureNotArchived(workflowPath, 'awaiting-owner-clear');
  return withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    ensureMutable(frontmatter);
    const current = frontmatter.awaiting_owner_gate;
    if (current === undefined) {
      throw new Error(`awaiting-owner-clear: no owner gate is set on this macro (asked to clear ${gate})`);
    }
    if (current !== gate) {
      throw new Error(`awaiting-owner-clear: the owner gate set on this macro is ${current}, not ${gate}`);
    }
    if (gate === 'plan-approval') {
      throw new Error(
        'awaiting-owner-clear: plan-approval is resolved by approving the plan ' +
          '(plan-approve, /orchestrator:approve), not cleared (ADR-0063 D6)',
      );
    }
    const nowIso = isoUtc(now);
    const runId = frontmatter[AWAITING_OWNER_RUN_ID];
    const note =
      `### Owner gate resolved: ${gate} at ${nowIso}\n\n` +
      `Cleared awaiting_owner (since ${frontmatter.awaiting_owner_since}, ` +
      `pointer ${frontmatter.awaiting_owner_pointer}${runId !== undefined ? `, run ${runId}` : ''}). ` +
      'The plan is still pending approval (awaiting_owner_gate=plan-approval).\n\n';
    // ADR-0067 Decision 8 — the run id goes with plan-conflict, and its task
    // file is retired once this write has landed.
    setMacroGate(frontmatter, 'plan-approval', {
      since: nowIso,
      pointer: macroPointer(workflowPath, MACRO_PLAN_ANCHOR),
    });
    validateSchema12Fields(frontmatter);
    frontmatter.updated_at = nowIso;
    frontmatter.host_history = [
      ...(frontmatter.host_history ?? []),
      { host, at: nowIso, event: 'updated' },
    ];
    await atomicWrite(
      workflowPath,
      assembleWorkflowFile(frontmatter, `${body}${note}`),
      { lockPath, token },
    );
    const retired = runId === undefined
      ? { retired: null, warning: null }
      : await retireConsensusTask(workflowPath, frontmatter.workflow_id, runId, { lockPath, token });
    return { frontmatter, workflowPath, retired };
  });
}

/**
 * ADR-0063 D6 — the owner approves the macro plan as it stands. Records
 * `approved`, the time, and computePlanHash of the plan read under the lock,
 * and removes the plan-approval gate. `expectHash` binds the approval to the
 * plan the owner was shown: a different current hash is refused. Refused
 * under an autopilot run, while plan-conflict is set, on an empty plan, and on
 * a terminal macro. Approving a plan already approved at the same hash writes
 * nothing. A macro no 1.2 writer planned (no approval keys) can be approved.
 */
export async function approvePlan({
  workflowPath,
  host,
  expectHash,
  env = process.env,
  now = new Date(),
}) {
  validateHost(host);
  refuseUnderAutopilot(env, 'plan-approve');
  if (expectHash !== undefined) validatePlanHash('--expect-hash', expectHash);
  ensureNotArchived(workflowPath, 'plan-approve');
  return withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    ensureMutable(frontmatter);
    if (frontmatter.terminal_marker === true) {
      throw new Error(
        `plan-approve: this macro is terminal (current_phase ${JSON.stringify(frontmatter.current_phase)}); ` +
          'there is nothing left to approve (ADR-0062 §Decision 4).',
      );
    }
    const subtasks = Array.isArray(frontmatter.plan?.subtasks) ? frontmatter.plan.subtasks : [];
    if (subtasks.length === 0) {
      throw new Error('plan-approve: the macro plan has no subtasks to approve; write a plan first (/orchestrator:plan)');
    }
    if (frontmatter.awaiting_owner_gate === 'plan-conflict') {
      throw new Error(
        `plan-approve: the plan's Plan-verify ensemble reported a conflict (${frontmatter.awaiting_owner_pointer}). ` +
          'Revise the plan (/orchestrator:plan), or, having decided the conflict, clear it with ' +
          'awaiting-owner-clear --gate plan-conflict and approve again (ADR-0063 D6).',
      );
    }
    const planHash = computePlanHash(subtasks);
    if (expectHash !== undefined && expectHash !== planHash) {
      throw new Error(
        `plan-approve: the plan changed since it was shown (shown ${expectHash.slice(0, 12)}, ` +
          `now ${planHash.slice(0, 12)}); review it again before approving`,
      );
    }
    if (
      frontmatter.plan_approval_status === 'approved'
      && frontmatter.plan_approval_plan_hash === planHash
    ) {
      return {
        frontmatter,
        workflowPath,
        planHash,
        approvedAt: frontmatter.plan_approval_approved_at,
        noop: true,
      };
    }
    const nowIso = isoUtc(now);
    let replaced = '';
    if (frontmatter.plan_approval_status === 'approved') {
      replaced = ` Replaces the approval of ${frontmatter.plan_approval_approved_at} ` +
        `(hash ${frontmatter.plan_approval_plan_hash.slice(0, 12)}), which no longer matched the plan.`;
    } else if (frontmatter.awaiting_owner_gate === 'plan-approval') {
      replaced = ` Cleared awaiting_owner plan-approval (since ${frontmatter.awaiting_owner_since}).`;
    }
    const note =
      `### Plan approved at ${nowIso} (hash ${planHash.slice(0, 12)})\n\n` +
      `${subtasks.length} subtask${subtasks.length === 1 ? '' : 's'}: ` +
      `${subtasks.map((s) => s.id).join(', ')}.${replaced}\n\n`;
    frontmatter.plan_approval_status = 'approved';
    frontmatter.plan_approval_approved_at = nowIso;
    frontmatter.plan_approval_plan_hash = planHash;
    if (frontmatter.awaiting_owner_gate === 'plan-approval') clearMacroGate(frontmatter);
    validateSchema12Fields(frontmatter);
    frontmatter.updated_at = nowIso;
    frontmatter.host_history = [
      ...(frontmatter.host_history ?? []),
      { host, at: nowIso, event: 'updated' },
    ];
    await atomicWrite(
      workflowPath,
      assembleWorkflowFile(frontmatter, `${body}${note}`),
      { lockPath, token },
    );
    return { frontmatter, workflowPath, planHash, approvedAt: nowIso, noop: false };
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
  // ADR-0031 amendment — behavioral opt-in for the activation sidecar (NOT a
  // subtask field; never enters the update payload). Production CLI passes true.
  'emitHandoff',
  // ADR-0062 §Decision 3 — write controls, not subtask fields. `correct`
  // (with a `reason`) is the only way to replace a recorded commit / pr_url /
  // closed_at; `reason` alone is noted with the write; `expectBranch` refuses
  // the write when the plan changed after the caller resolved the landing.
  'correct', 'reason', 'expectBranch',
  // ADR-0067 Decision 4, item 5 — /orchestrator:next's writeback binds the
  // child it dispatched only to the subtask it dispatched: these, with
  // `expectBranch`, refuse the write when a plan revision changed what the
  // dispatch read.
  'expectVerb', 'expectProfile', 'expectTopic',
  // The dispatch the child records at its creation, which every binding of a
  // child compares (below). `waiveDispatch` (with a `reason`) is the operator's
  // override when that record cannot be read: the write is not compared, and
  // the macro body records why.
  'expectDispatch', 'waiveDispatch',
]);

// The plan-time fields a caller may expect unchanged, by option name. An empty
// expected profile or topic stands for an absent one, and trailing newlines
// are not compared: a runbook reads each field through a command
// substitution, which drops them.
const EXPECTED_SUBTASK_FIELDS = [
  ['expectVerb', 'verb'],
  ['expectProfile', 'profile'],
  ['expectTopic', 'topic'],
];

// ADR-0067 Decision 4, item 5 — the dispatch a child records when
// /orchestrator:next creates it (the engineer's `dispatch-selection`): the
// macro and subtask it was dispatched for and, recorded at its creation, the
// branch, verb, profile and topic Phase 1 selected. A child created before the
// record carries only the branch it was created on. Every path that binds a
// child to a subtask, or moves a subtask on a child's behalf, passes it, and
// the write is refused under the macro's file lock when the subtask no longer
// matches: the child was dispatched for the subtask as it was then.
const DISPATCH_KEYS = ['macro', 'subtask', 'branch', 'verb', 'profile', 'topic'];

export function parseExpectDispatch(value, caller) {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (err) {
      throw new Error(`${caller}: expectDispatch is not JSON: ${err.message}`);
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${caller}: expectDispatch must be an object`);
  }
  for (const [key, field] of Object.entries(parsed)) {
    if (!DISPATCH_KEYS.includes(key)) {
      throw new Error(`${caller}: expectDispatch has unknown key ${JSON.stringify(key)} (allowed: ${DISPATCH_KEYS.join(', ')})`);
    }
    if (typeof field !== 'string') {
      throw new Error(`${caller}: expectDispatch.${key} must be a string`);
    }
  }
  for (const key of ['macro', 'subtask', 'branch']) {
    if (!parsed[key]) throw new Error(`${caller}: expectDispatch.${key} must be a non-empty string`);
  }
  if ('verb' in parsed && parsed.verb.length === 0) {
    throw new Error(`${caller}: expectDispatch.verb must be a non-empty string when present`);
  }
  return parsed;
}

// What differs between the subtask as the locked read has it and the dispatch
// the child records, or null. An empty profile or topic stands for an absent
// one, and trailing newlines are not compared (EXPECTED_SUBTASK_FIELDS).
function dispatchMismatch({ frontmatter, subtaskId, current, expectDispatch }) {
  if (expectDispatch.macro !== frontmatter.workflow_id) {
    return `the child was dispatched by macro ${JSON.stringify(expectDispatch.macro)}, not ${JSON.stringify(frontmatter.workflow_id)}`;
  }
  if (expectDispatch.subtask !== subtaskId) {
    return `the child was dispatched for subtask ${JSON.stringify(expectDispatch.subtask)}, not ${JSON.stringify(subtaskId)}`;
  }
  if (current.branch !== expectDispatch.branch) {
    return `branch is ${JSON.stringify(current.branch)}; the child was dispatched for ${JSON.stringify(expectDispatch.branch)}`;
  }
  for (const field of ['verb', 'profile', 'topic']) {
    if (!(field in expectDispatch)) continue;
    const now = String(current[field] || '').replace(/\n+$/, '');
    const dispatched = expectDispatch[field].replace(/\n+$/, '');
    if (now !== dispatched) {
      return `${field} is ${JSON.stringify(now)}; the child was dispatched for ${JSON.stringify(dispatched)}`;
    }
  }
  return null;
}

function dispatchRefusal(caller, subtaskId, mismatch) {
  return new Error(
    `${caller}: subtask ${JSON.stringify(subtaskId)} changed after its child was dispatched ` +
      `(dispatch-changed): ${mismatch}. Nothing was written (ADR-0067 Decision 4, item 5): ` +
      `archive the child and dispatch the subtask again, or revise the plan back.`,
  );
}

// ADR-0062 §Decision 3 — provenance fields a later write may fill but never
// replace without `correct`. `closed_at` differs on every re-run (a fresh
// timestamp), so a differing value is dropped rather than refused.
const RECORDED_PROVENANCE_KEYS = ['commit', 'pr_url'];

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
    // ADR-0031 amendment — opt-in (production CLI subtask-update sets true).
    // Fires the activation sidecar ONLY when this call's auto-terminal pass
    // actually promotes the macro to terminal; default off keeps the helper
    // side-effect-free for tests / internal callers.
    emitHandoff = false,
    correct = false,
    reason,
    expectBranch,
    waiveDispatch = false,
  } = opts;
  const expectDispatch = opts.expectDispatch === undefined
    ? undefined
    : parseExpectDispatch(opts.expectDispatch, 'updateSubtask');
  validateHost(host);
  validateHookEvent(event);
  if (typeof subtaskId !== 'string' || subtaskId.length === 0) {
    throw new Error('updateSubtask: subtaskId must be a non-empty string');
  }
  if (typeof correct !== 'boolean') {
    throw new Error('updateSubtask: correct must be a boolean');
  }
  if (typeof waiveDispatch !== 'boolean') {
    throw new Error('updateSubtask: waiveDispatch must be a boolean');
  }
  if (reason !== undefined && typeof reason !== 'string') {
    throw new Error('updateSubtask: reason must be a string');
  }
  const reasonText = typeof reason === 'string' ? scrubSecrets(reason).trim() : '';
  if (correct && reasonText.length === 0) {
    throw new Error(
      'updateSubtask: --correct requires a non-empty reason (ADR-0062 §Decision 3: ' +
        'a correction records why the recorded value was wrong).',
    );
  }
  // ADR-0067 Decision 4, item 5 — a write in an owner's name compares the
  // dispatch that owner records. When the record cannot be read, the operator
  // may complete without it, saying why; the reason goes into the macro body.
  if (waiveDispatch) {
    if (reasonText.length === 0) {
      throw new Error(
        'updateSubtask: --waive-dispatch requires a non-empty reason (ADR-0067 Decision 4, item 5: ' +
          'a write not compared with its owner\'s dispatch records why).',
      );
    }
    if (expectDispatch !== undefined) {
      throw new Error('updateSubtask: pass --expect-dispatch or --waive-dispatch, not both');
    }
    if (typeof engineerWorkflowId !== 'string' || engineerWorkflowId.length === 0) {
      throw new Error('updateSubtask: --waive-dispatch names no owner; pass --engineer-workflow-id');
    }
  }
  if (expectBranch !== undefined && (typeof expectBranch !== 'string' || expectBranch.length === 0)) {
    throw new Error('updateSubtask: expectBranch must be a non-empty string');
  }
  for (const [option] of EXPECTED_SUBTASK_FIELDS) {
    const expected = opts[option];
    if (expected === undefined) continue;
    if (typeof expected !== 'string' || (option === 'expectVerb' && expected.length === 0)) {
      throw new Error(`updateSubtask: ${option} must be a ${option === 'expectVerb' ? 'non-empty ' : ''}string`);
    }
  }
  ensureNotArchived(workflowPath, 'updateSubtask');

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

  const result = await withFileLock(workflowPath, async ({ lockPath, token }) => {
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

    // ADR-0062 §Decision 3 — the caller resolved the landing against this
    // branch; a plan revision in between must not let that result complete
    // different work.
    if (expectBranch !== undefined && current.branch !== expectBranch) {
      throw new Error(
        `updateSubtask: subtask ${JSON.stringify(subtaskId)} branch is ` +
          `${JSON.stringify(current.branch)}, not the expected ${JSON.stringify(expectBranch)}; ` +
          `the plan changed after the caller read the subtask (a landing resolved, or a dispatch). Read it again.`,
      );
    }
    for (const [option, field] of EXPECTED_SUBTASK_FIELDS) {
      if (opts[option] === undefined) continue;
      const now = String(current[field] || '').replace(/\n+$/, '');
      const expected = opts[option].replace(/\n+$/, '');
      if (now !== expected) {
        throw new Error(
          `updateSubtask: subtask ${JSON.stringify(subtaskId)} ${field} is ` +
            `${JSON.stringify(now)}, not the expected ${JSON.stringify(expected)}; ` +
            `the plan changed after the caller read the subtask (a dispatch). Read it again.`,
        );
      }
    }
    if (expectDispatch !== undefined) {
      const mismatch = dispatchMismatch({ frontmatter, subtaskId, current, expectDispatch });
      if (mismatch) throw dispatchRefusal('updateSubtask', subtaskId, mismatch);
    }

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

    // ADR-0062 §Decision 3 — a recorded value is not replaced silently. The
    // engineer Stop hook used to re-send the branch tip after Phase 7 had
    // recorded it, and the merge below replaced the record (docket C14).
    const corrections = [];
    for (const key of RECORDED_PROVENANCE_KEYS) {
      if (!(key in payload)) continue;
      const recorded = current[key];
      if (typeof recorded !== 'string' || recorded.length === 0 || recorded === payload[key]) continue;
      if (!correct) {
        throw new Error(
          `updateSubtask: subtask ${JSON.stringify(subtaskId)} already records ${key} ` +
            `${JSON.stringify(recorded)}; refusing ${JSON.stringify(payload[key])}. ` +
            `Automatic writes never replace a recorded value (ADR-0062 §Decision 3). ` +
            `To correct it deliberately, pass --correct with a reason.`,
        );
      }
      corrections.push({ key, from: recorded, to: payload[key] });
    }
    if (
      'closed_at' in payload
      && typeof current.closed_at === 'string'
      && current.closed_at.length > 0
      && current.closed_at !== payload.closed_at
    ) {
      if (correct) {
        corrections.push({ key: 'closed_at', from: current.closed_at, to: payload.closed_at });
      } else {
        // A re-run carries a fresh timestamp; the recorded completion time stays.
        delete payload.closed_at;
      }
    }

    const changedKeys = Object.keys(payload).filter((k) => current[k] !== payload[k]);
    if (changedKeys.length === 0) {
      return {
        frontmatter,
        workflowPath,
        updatedSubtask: current,
        autoTerminal: false,
        skipped: true,
        noop: true,
        skipReason: `subtask ${JSON.stringify(subtaskId)} already records these values; nothing written.`,
      };
    }

    // Apply primary mutation.
    const updated = { ...current, ...payload };
    subtasks[targetIdx] = updated;

    // Unblock pass — shared with setPlan (ADR-0062 §Decision 5).
    applyUnblockPass(subtasks);

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
      // Completion-output contract: the pre-terminal next_action (e.g.
      // "Dispatch the first ready subtask") is stale the moment the last
      // subtask lands — the sidecar footer would otherwise recommend it as
      // next work. Rewrite it to the auto-terminal reality in the same pass.
      frontmatter.next_action = 'All subtasks are terminal; the macro will auto-archive on the next Stop. Review the landed subtasks, then plan or dispatch the next work item.';
    } else if (payload.status === 'completed' && current.status !== 'completed') {
      // ADR-0062 — the engineer terminal note pointed next_action at
      // /orchestrator:done for this subtask; once that is recorded, say what
      // comes next instead of leaving the stale instruction for the footer.
      const prefix = host === 'codex' ? '$' : '/';
      const readyIds = subtaskReadiness(subtasks).filter((r) => r.ready).map((r) => r.id);
      const inFlight = subtasks.filter((s) => s.status === 'in_progress').map((s) => s.id);
      frontmatter.next_action = readyIds.length > 0
        ? `${subtaskId} is recorded; dispatch ${readyIds[0]} with ${prefix}orchestrator:next`
        : inFlight.length > 0
          ? `${subtaskId} is recorded; record ${inFlight.join(', ')} with ${prefix}orchestrator:done once each pull request merges`
          : `${subtaskId} is recorded; no subtask is ready — review the plan`;
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
      `Fields updated: ${changedKeys.join(', ')}` +
      (autoTerminalSetThisCall ? '. Auto-terminal: all subtasks terminal; terminal_marker + current_phase set.' : '.') +
      '\n\n';
    const correctionNote = corrections.length > 0
      ? `Correction (--correct): ${corrections
        .map((c) => `${c.key}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`)
        .join('; ')}.\n\n`
      : '';
    const waiverNote = waiveDispatch
      ? `Dispatch not compared (--waive-dispatch): the dispatch recorded by ${JSON.stringify(engineerWorkflowId)} ` +
        'could not be read, so this write was not checked against it.\n\n'
      : '';
    const reasonNote = reasonText.length > 0 ? `Reason: ${reasonText}\n\n` : '';
    const newBody = `${body}${noteHeading}${noteSummary}${correctionNote}${waiverNote}${reasonNote}`;

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
  // ADR-0031 amendment — fire the activation sidecar AFTER the file lock
  // released, but ONLY when this call's auto-terminal pass actually promoted the
  // macro to terminal (the happy-path /done landing the last subtask). The skip
  // paths above return autoTerminal=false, so a no-op / mid-flight update never
  // fires. NOT a blind engineer mirror: engineer fires on every set-terminal;
  // the orchestrator's updateSubtask fires only on the auto-terminal transition.
  if (emitHandoff && result.autoTerminal) {
    await fireMacroHandoffSidecar(workflowPath, host);
  }
  return result;
}

// -----------------------------------------------------------------------------
// Public API: recordEngineerTerminal (ADR-0062 §Decision 2)
//
// What an engineer workflow tells its macro when it reaches its terminal
// commit. It does not complete the subtask: that commit is on the subtask
// branch, and this repository squash- or rebase-merges, so what lands is a
// different commit that /orchestrator:done records after the merge.
//
// Under the macro's lock it:
//   - skips a subtask that is already completed / deferred / abandoned, or
//     blocked (nothing was dispatched for it), writing nothing;
//   - binds the engineer workflow as owner when none is recorded (the
//     recovery the old completion writeback gave when /next's post-create
//     update was missed) and refuses a different owner;
//   - moves a pending subtask to in_progress (same recovery);
//   - appends one note per engineer workflow and branch commit, and points
//     next_action at /orchestrator:done. A repeated call — Phase 7's P10 and
//     then the Stop hook — finds its note and writes nothing.
//
// `expectWorkflowId` (ADR-0067 Decision 3) is the macro id the engineer's
// writeback resolved this path for; the file read under the lock must carry
// it, or nothing is written. The engineer checks the same before calling, but
// with its own reader and before the lock: this read is the one the write
// is made from.
//
// `expectDispatch` (ADR-0067 Decision 4, item 5) is the dispatch the engineer
// workflow records (parseExpectDispatch): when the subtask, on that same
// locked read, no longer matches it, nothing is written. A child bound to a
// subtask a plan revision changed after its dispatch would otherwise be bound
// here, at its terminal commit, after /orchestrator:next refused it.
export async function recordEngineerTerminal({
  workflowPath,
  host,
  subtaskId,
  engineerWorkflowId,
  branchCommit,
  expectWorkflowId,
  expectDispatch: expectDispatchOption,
  event = 'updated',
  now = new Date(),
}) {
  validateHost(host);
  validateHookEvent(event);
  for (const [name, value] of [['subtaskId', subtaskId], ['engineerWorkflowId', engineerWorkflowId], ['branchCommit', branchCommit]]) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`recordEngineerTerminal: ${name} must be a non-empty string`);
    }
  }
  if (expectWorkflowId !== undefined && (typeof expectWorkflowId !== 'string' || expectWorkflowId.length === 0)) {
    throw new Error('recordEngineerTerminal: expectWorkflowId must be a non-empty string when provided');
  }
  const expectDispatch = expectDispatchOption === undefined
    ? undefined
    : parseExpectDispatch(expectDispatchOption, 'recordEngineerTerminal');
  ensureNotArchived(workflowPath, 'recordEngineerTerminal');
  return withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    if (expectWorkflowId !== undefined && frontmatter.workflow_id !== expectWorkflowId) {
      throw new Error(
        `recordEngineerTerminal: ${workflowPath} holds macro ${JSON.stringify(frontmatter.workflow_id)}, ` +
          `not ${JSON.stringify(expectWorkflowId)}; nothing was written (ADR-0067 Decision 3).`,
      );
    }
    ensureMutable(frontmatter);
    const subtasks = Array.isArray(frontmatter.plan?.subtasks) ? frontmatter.plan.subtasks : [];
    const idx = subtasks.findIndex((s) => s.id === subtaskId);
    if (idx === -1) {
      throw new Error(
        `recordEngineerTerminal: subtask id ${JSON.stringify(subtaskId)} not found in plan.subtasks[]`,
      );
    }
    const current = subtasks[idx];
    if (TERMINAL_SUBTASK_STATUSES.has(current.status) || current.status === 'blocked') {
      return {
        workflowPath,
        subtask: current,
        skipped: true,
        skipReason: `subtask ${JSON.stringify(subtaskId)} is ${current.status}; the engineer terminal note is not written.`,
      };
    }
    if (expectDispatch !== undefined) {
      const mismatch = dispatchMismatch({ frontmatter, subtaskId, current, expectDispatch });
      if (mismatch) throw dispatchRefusal('recordEngineerTerminal', subtaskId, mismatch);
    }
    const recordedOwner = current.engineer_workflow_id;
    if (typeof recordedOwner === 'string' && recordedOwner.length > 0 && recordedOwner !== engineerWorkflowId) {
      throw new Error(
        `recordEngineerTerminal: engineer_workflow_id mismatch on subtask ${JSON.stringify(subtaskId)}. ` +
          `Existing: ${JSON.stringify(recordedOwner)}, incoming: ${JSON.stringify(engineerWorkflowId)}.`,
      );
    }
    const boundOwner = recordedOwner !== engineerWorkflowId;
    const promotedToInProgress = current.status === 'pending';
    const heading = `### engineer terminal: ${JSON.stringify(subtaskId)} @ ${engineerWorkflowId} ${branchCommit}\n`;
    if (!boundOwner && !promotedToInProgress && body.includes(heading)) {
      return { workflowPath, subtask: current, noop: true };
    }

    const updated = { ...current, engineer_workflow_id: engineerWorkflowId };
    if (promotedToInProgress) updated.status = 'in_progress';
    subtasks[idx] = updated;
    const doneCommand = `${host === 'codex' ? '$' : '/'}orchestrator:done ${subtaskId}`;
    const nowIso = isoUtc(now);
    frontmatter.next_action = `After ${subtaskId}'s pull request merges, run ${doneCommand}`;
    frontmatter.updated_at = nowIso;
    frontmatter.host_history = [...(frontmatter.host_history ?? []), { host, at: nowIso, event }];
    const note = body.includes(heading)
      ? ''
      : `${heading}\nEngineer workflow ${engineerWorkflowId} reached its terminal commit ${branchCommit} ` +
        `on ${current.branch}. The subtask stays in_progress until the work lands (ADR-0062): ` +
        `after the pull request merges, run ${doneCommand}.\n\n`;
    await atomicWrite(
      workflowPath,
      assembleWorkflowFile(frontmatter, `${body}${note}`),
      { lockPath, token },
    );
    return { workflowPath, subtask: updated, noted: note.length > 0, boundOwner, promotedToInProgress };
  });
}

// -----------------------------------------------------------------------------
// ADR-0019 PR-E §5 — macro lifecycle primitives, archive infrastructure,
// predicates, and macro-A4 scan helpers. Used by:
//   - plugins/orchestrator/commands/{finalize,abort}.md (slash-command
//     runbooks orchestrating the §5 3-step protocol)
//   - plugins/orchestrator/scripts/stop-archive.mjs (macro auto-archive
//     A1-A4 evaluation)
//   - plugins/orchestrator/adapters/{claude,codex}/hooks/stop.mjs (host
//     Stop event integration)
//
// Mirrors engineer's archive surface (engineer/scripts/state.mjs:1851-2100)
// — same lock-order, same collision-safe rename, same idempotency. The
// orchestrator-specific divergence is the macro terminal-phase whitelist
// (MACRO_TERMINAL_PHASES, NOT TERMINAL_PHASES) and the A4 gate semantics
// (cross-plugin engineer workflows directory scan, NOT engineer's own
// child_completions array check).

export function archiveDir(repoRoot, { home = 'canonical' } = {}) {
  return statePaths(repoRoot, home).archive;
}

/**
 * ADR-0019 §5 / engineer-archiveWorkflow mirror — move a macro workflow
 * file out of `workflows/` into `archive/`. Dir lock → file lock; durable
 * write to destination + unlink source.
 *
 * Collision policy: when `<archiveDir>/<basename>` already exists,
 * append a sub-second-precision suffix and probe again until a free
 * name is found: `<basename-without-ext>-<isoCompact>-<6-hex>.md`.
 *
 * Idempotency: if `workflowPath` is already absent at directory-lock
 * acquire (or vanishes before the inner file lock), the helper resolves
 * cleanly with `{archived: false, reason: 'source-missing'}`.
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
  // ADR-0067 Decision 4, item 2 — the record's own home wins over the
  // caller's checkout: a macro under the default state root, archived by a
  // Stop in a linked worktree, goes to its own home's archive. The home is
  // read from the resolved path: a relative path names a file under this
  // process's directory, whatever repoRoot names.
  const inferred = workflowStorage(workflowPath);
  const effectiveRepoRoot = inferred?.stateRoot ?? repoRoot;
  const sourceHome = inferred?.home ?? 'canonical';
  const targetDir = archiveDirectory ?? archiveDir(effectiveRepoRoot, { home: sourceHome });
  const baseName = basename(workflowPath);

  // Derive dir-lock root from canonical four-deep layout when only
  // `archiveDirectory` is supplied — mirrors engineer's M-1 fix.
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

    return withFileLock(workflowPath, async ({ lockPath, token }) => {
      const sourceStatLocked = await pathStat(workflowPath);
      if (!sourceStatLocked) {
        return { archived: false, reason: 'source-missing-after-lock', workflowPath };
      }
      const text = await readFile(workflowPath, 'utf8');
      const { frontmatter, body } = parseWorkflowFile(text);
      const nowIso = isoUtc(now);
      frontmatter.updated_at = nowIso;
      frontmatter.host_history = [
        ...(frontmatter.host_history ?? []),
        { host, at: nowIso, event: 'archived' },
      ];
      const archivedBytes = assembleWorkflowFile(frontmatter, body);
      const destination = await archiveCandidateWithRaceRetry({
        targetDir,
        baseName,
        now,
        archivedBytes,
      });
      try {
        await unlink(workflowPath);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      void lockPath; void token;
      return {
        archived: true,
        from: workflowPath,
        to: destination,
        host,
      };
    });
  });
}

async function resolveArchiveDestination({ targetDir, baseName, now }) {
  const stem = baseName.endsWith('.md') ? baseName.slice(0, -3) : baseName;
  const canonical = join(targetDir, baseName);
  if (!(await pathStat(canonical))) return canonical;

  const isoCompact = isoUtc(now).replace(/[-:]/g, '').replace(/Z$/, 'Z');
  for (let attempt = 0; attempt < 8; attempt++) {
    const rand = randomBytes(3).toString('hex');
    const candidate = join(targetDir, `${stem}-${isoCompact}-${rand}.md`);
    if (!(await pathStat(candidate))) return candidate;
  }
  throw new Error(
    `archiveWorkflow: could not find a non-colliding destination under ${targetDir} (8 attempts)`,
  );
}

async function archiveCandidateWithRaceRetry({
  targetDir,
  baseName,
  now,
  archivedBytes,
}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = await resolveArchiveDestination({ targetDir, baseName, now });
    let won = false;
    await withFileLock(candidate, async ({ lockPath, token }) => {
      const existing = await pathStat(candidate);
      if (existing) return; // Race lost — outer loop picks a fresh candidate.
      await atomicWrite(candidate, archivedBytes, { lockPath, token });
      won = true;
    });
    if (won) return candidate;
  }
  throw new Error(
    `archiveWorkflow: lost candidate race after 8 retries under ${targetDir}`,
  );
}

/**
 * ADR-0019 §5 step 1 — bulk subtask status transition under the parent's
 * per-file lock. Used by /orchestrator:finalize (toStatus=deferred) and
 * /orchestrator:abort (toStatus=abandoned) to atomically transition every
 * non-terminal subtask before step 2 (child-detach pass).
 *
 * Domain constraints (Codex CONCERN #1 in plan-verify):
 *   - fromStatuses elements MUST be subset of {pending, blocked, in_progress}
 *   - toStatus MUST be one of {deferred, abandoned}
 * These restrictions keep the primitive narrow: it can ONLY perform the
 * /finalize / /abort step-1 transition. Other state transitions go through
 * `updateSubtask` (single-row) or `setPlan` (full re-plan).
 *
 * @param {object}   args
 * @param {string}   args.workflowPath
 * @param {string}   args.host
 * @param {string[]} args.fromStatuses — subset of {pending, blocked, in_progress}
 * @param {string}   args.toStatus     — 'deferred' or 'abandoned'
 * @param {string}   [args.event='updated']
 * @param {Date}     [args.now]
 * @returns {Promise<{workflowPath: string, transitionedIds: string[]}>}
 */
export async function bulkSubtaskStatus({
  workflowPath,
  host,
  fromStatuses,
  toStatus,
  event = 'updated',
  now = new Date(),
}) {
  validateHost(host);
  validateHookEvent(event);
  const FROM_ALLOWED = new Set(['pending', 'blocked', 'in_progress']);
  const TO_ALLOWED = new Set(['deferred', 'abandoned']);
  if (!Array.isArray(fromStatuses) || fromStatuses.length === 0) {
    throw new Error('bulkSubtaskStatus: fromStatuses must be a non-empty array');
  }
  for (const s of fromStatuses) {
    if (!FROM_ALLOWED.has(s)) {
      throw new Error(
        `bulkSubtaskStatus: fromStatuses element ${JSON.stringify(s)} not in ` +
          `{pending, blocked, in_progress} — this primitive only handles the ` +
          `/finalize·/abort step-1 transition.`,
      );
    }
  }
  if (!TO_ALLOWED.has(toStatus)) {
    throw new Error(
      `bulkSubtaskStatus: toStatus ${JSON.stringify(toStatus)} not in ` +
        `{deferred, abandoned} — terminal-partial states are owned by ` +
        `/orchestrator:finalize (deferred) and /orchestrator:abort (abandoned).`,
    );
  }
  const fromSet = new Set(fromStatuses);
  return withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    if (frontmatter?.schema === '1.0') {
      throw new Error(
        `bulkSubtaskStatus: schema 1.0 plan refused (archive legacy + re-plan ` +
          `under 1.1 first).`,
      );
    }
    const nowIso = isoUtc(now);
    const subtasks = Array.isArray(frontmatter?.plan?.subtasks)
      ? frontmatter.plan.subtasks
      : [];
    const transitionedIds = [];
    for (const s of subtasks) {
      if (!s || typeof s !== 'object') continue;
      if (fromSet.has(s.status)) {
        s.status = toStatus;
        s.closed_at = nowIso;
        transitionedIds.push(s.id);
      }
    }
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
    return { workflowPath, transitionedIds };
  });
}

/**
 * ADR-0019 §5 step 3 — atomic terminal-marker + current_phase write under
 * the parent's per-file lock. Used by /orchestrator:finalize
 * (terminalPhase='finalized') and /orchestrator:abort (terminalPhase='aborted').
 * Also callable for the explicit 'commit-complete' label, though the
 * §4 step-7 auto-terminal pass inside `updateSubtask` already covers that
 * happy-path case.
 *
 * Mirrors engineer's `setTerminal` shape (engineer/scripts/state.mjs:1806)
 * — same atomicity, same boolean-strict gate, same host_history append.
 * Diverges on `terminalPhase` whitelist (macro vs engineer phase set).
 */
export async function setMacroTerminal({
  workflowPath,
  host,
  terminalPhase,
  terminalMarker = true,
  nextAction,
  event = 'updated',
  now = new Date(),
  // ADR-0031 amendment — opt-in (production CLI set-terminal, the /finalize +
  // /abort surface, sets true). Fires the activation sidecar after the mutation
  // when the macro is marked terminal; default off for tests / internal callers.
  emitHandoff = false,
}) {
  validateHost(host);
  validateHookEvent(event);
  if (!MACRO_TERMINAL_PHASES.has(terminalPhase)) {
    const allowed = [...MACRO_TERMINAL_PHASES].join(', ');
    throw new Error(
      `setMacroTerminal: terminalPhase ${JSON.stringify(terminalPhase)} not in ` +
        `macro whitelist (${allowed})`,
    );
  }
  if (typeof terminalMarker !== 'boolean') {
    throw new Error(
      `setMacroTerminal: terminalMarker must be a boolean (got ${typeof terminalMarker} ${JSON.stringify(terminalMarker)})`,
    );
  }
  const result = await withFileLock(workflowPath, async ({ lockPath, token }) => {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    if (frontmatter?.schema === '1.0') {
      throw new Error(
        `setMacroTerminal: schema 1.0 plan refused (archive legacy + re-plan ` +
          `under 1.1 first).`,
      );
    }
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
    return { workflowPath, frontmatter };
  });
  // ADR-0031 amendment — fire the activation sidecar AFTER the lock released,
  // but ONLY when the macro was actually marked terminal (the /finalize +
  // /abort surface). A `--terminal-marker false` un-mark never fires.
  if (emitHandoff && terminalMarker === true) {
    await fireMacroHandoffSidecar(workflowPath, host);
  }
  return result;
}

/**
 * ADR-0019 §5 A1 gate — `terminal_marker === true`. Strict identity check
 * (Codex M5 precedent: `Boolean("false")` silently flipped the engineer-side
 * gate). Mirror of engineer's `terminalMarkerCheck`.
 */
export function terminalMarkerCheck(frontmatter) {
  return frontmatter?.terminal_marker === true;
}

/**
 * ADR-0019 §5 A2 gate — macro terminal-phase whitelist. Set membership.
 */
export function macroTerminalPhaseCheck(currentPhase) {
  return MACRO_TERMINAL_PHASES.has(currentPhase);
}

/**
 * ADR-0019 §5 A3 gate — every entry in `plan.subtasks[]` must be in a
 * terminal-status set (completed | deferred | abandoned). Empty / absent
 * plan is vacuously true (a macro with zero subtasks is trivially "all
 * subtasks terminal").
 */
export function allSubtasksTerminalCheck(frontmatter) {
  const subtasks = frontmatter?.plan?.subtasks;
  if (!Array.isArray(subtasks) || subtasks.length === 0) return true;
  for (const s of subtasks) {
    if (!s || typeof s !== 'object') return false;
    if (!TERMINAL_SUBTASK_STATUSES.has(s.status)) return false;
  }
  return true;
}

/**
 * List all non-archived macro workflow files under the selected
 * canonical or legacy orchestrator workflow home. Returns absolute paths.
 * Used by branch-agnostic macro auto-archive iteration in PR-E's
 * `runMacroStopArchiveAll`.
 *
 * The macro workflow-id regex is `^macro-[a-z]+-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$`
 * (per ADR-0018 §sub-1 generateWorkflowId). The filter rejects non-
 * matching filenames (README.md, lock files, accidental edits) so the
 * iteration only touches genuine macro files.
 */
export async function listAllMacros(repoRoot) {
  // ADR-0067 Decision 1(a): both homes of every root of the read set, in
  // read-set order (stable, so iteration is deterministic), one entry per
  // physical file, spelled as the default state root has it.
  const MACRO_ID_RE = /^macro-[a-z]+-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}\.md$/;
  return workflowFilesIn(
    lookupRoots(repoRoot).flatMap((root) => Object.keys(STATE_HOMES).map((home) => workflowDir(root, { home }))),
    (name) => MACRO_ID_RE.test(name),
  );
}

// ADR-0067 Decision 4, item 2 — the explicit `--workflow=<id>` resolvers of
// the runbooks: the macro file `<id>.md` in the orchestrator workflows homes
// of the checkout's read set, under the name that is not a link. Null when
// none holds it; two distinct files are an error naming both, never a choice;
// a name that is no regular file (a FIFO) is refused, as runtime's readers
// refuse it (Decision 4, item 1).
export async function resolveMacroById(repoRoot, workflowId) {
  if (typeof workflowId !== 'string' || !/^macro-[a-z]+-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/.test(workflowId)) {
    throw new Error(`not a macro workflow id: ${JSON.stringify(workflowId)}`);
  }
  const found = [];
  for (const root of lookupRoots(repoRoot)) {
    for (const home of Object.keys(STATE_HOMES)) {
      const candidate = join(workflowDir(root, { home }), `${workflowId}.md`);
      const problem = workflowEntryProblem(candidate);
      if (problem === 'gone') continue;
      if (problem !== null) {
        throw new Error(`orchestrator workflow storage: ${JSON.stringify(candidate)} is ${problem} (ADR-0067 Decision 4, item 1).`);
      }
      addPhysicalMatch(found, candidate);
    }
  }
  if (found.length > 1) {
    throw new Error(
      `Ambiguous orchestrator workflow storage: macro ${workflowId} is held by ${found.length} files: ` +
        `${found.map((f) => JSON.stringify(f)).join(', ')} (ADR-0067 Decision 4, item 2).`,
    );
  }
  return found[0] ?? null;
}

/**
 * ADR-0019 §5 A4 gate — scan the engineer workflows directory and count
 * non-archived engineer workflow files whose `parent_workflow` references
 * this orchestrator macro id.
 *
 * Single-level scan: engineer is L3 leaf (no further nesting in ADR-0019
 * scope), so a directory readdir + parent_workflow filter is sufficient.
 * The transitive walk used by engineer's own A4 (child_completions array
 * check) is orthogonal — that gate evaluates engineer-side parent linkage,
 * not the orchestrator-engineer cross-plugin linkage this scan covers.
 *
 * ENOENT on the engineer workflows directory returns 0 (no children).
 * Files whose name does not match the engineer workflow-id regex are
 * silently skipped (README.md, lock files, etc.). Files that fail to
 * parse as valid YAML frontmatter are skipped with a stderr warning —
 * a corrupt engineer workflow file should not block the orchestrator
 * macro auto-archive evaluation. The fail-open default mirrors the
 * "hook absence is non-fatal" contract per ADR-0011 §4.
 *
 * @param {string} repoRoot
 * @param {string} macroId — orchestrator workflow_id to match against
 *   engineer frontmatter `parent_workflow` field.
 * @returns {Promise<number>} count of engineer workflow files
 *   referencing this macroId.
 */
export async function noActiveEngineerChildrenScan(repoRoot, macroId) {
  if (!isAbsolute(repoRoot)) {
    throw new Error(`noActiveEngineerChildrenScan: repoRoot must be absolute: ${repoRoot}`);
  }
  // ADR-0067 Decision 1(b): the read set and the own homes of every other
  // worktree, so a child an older persona left in a checkout's own home still
  // blocks the archive. One file reached twice counts once.
  const dirs = repositoryRoots(repoRoot).flatMap((root) => [
    join(root, '.agentic-plugins/state/engineer/workflows'),
    join(root, '.claude/agentic-engineer/workflows'),
  ]);
  const counted = new Set();
  // Engineer workflow-id regex per engineer state.mjs generateWorkflowId.
  const ENG_ID_RE = /^[a-z]+-[0-9]{8}T[0-9]{6}Z-[0-9a-f]+\.md$/;
  let count = 0;
  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    for (const name of entries) {
      if (!ENG_ID_RE.test(name)) continue;
      const path = join(dir, name);
      let identity = path;
      try {
        identity = realpathSync(path);
      } catch {
        /* unreadable below; its path stands in */
      }
      if (counted.has(identity)) continue;
      counted.add(identity);
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        process.stderr.write(
          `noActiveEngineerChildrenScan: failed to read ${name}: ${err.message}\n`,
        );
        continue;
      }
      // Avoid invoking engineer's parseWorkflowFile (cross-plugin import
      // forbidden per ADR-0010 §5). Use a minimal frontmatter regex scan
      // instead — we only need the `parent_workflow` scalar value.
      //
      // CRLF tolerance: while engineer's state.mjs writes LF-only, a
      // workflow file manually edited on a Windows-style tool could carry
      // CRLF line endings. A CRLF-saved child would silently miscount as
      // "not a child," letting A4 pass while the child is actually live.
      // Defend against this with `\r?\n` in the frontmatter-delimiter
      // pattern; the per-line scalar regex already uses /m which is
      // CR-tolerant.
      const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!fmMatch) continue;
      const fmText = fmMatch[1];
      const parentMatch = fmText.match(/^parent_workflow:\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s*\r?$/m);
      if (!parentMatch) continue;
      const parentValue = parentMatch[1] ?? parentMatch[2] ?? parentMatch[3];
      if (parentValue === macroId) count++;
    }
  }
  return count;
}

// -----------------------------------------------------------------------------
// The engineer workflows that claim a subtask (ADR-0067 Decision 4, item 5)
//
// /orchestrator:done completes a subtask in its owner's name, and binds the
// owner it finds, so its write compares the dispatch that owner records. These
// read every engineer workflow file in the homes of every root of the
// repository and parse the frontmatter values they need, never matching
// serialized text: the engineer writes each scalar as a JSON string (a bare
// value is taken as written), so an id holding a quote, or a topic holding a
// line separator, is read as the engineer wrote it. No engineer code is
// imported (ADR-0010 §5).

const ENGINEER_HOMES = [['.agentic-plugins', 'state', 'engineer'], ['.claude', 'agentic-engineer']];
const CLAIM_KEYS = new Set([
  'workflow_id', 'parent_workflow', 'originating_subtask',
  'dispatched_branch', 'dispatched_verb', 'dispatched_profile', 'dispatched_topic',
]);

function claimScalar(raw, key, file) {
  if (!raw.startsWith('"')) return raw.trim();
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    value = undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${file}: ${key} is not a readable value (${JSON.stringify(raw)})`);
  }
  return value;
}

// The CLAIM_KEYS values of an engineer frontmatter, and its git_baseline
// branch under `git_baseline.branch`; null when the text opens no frontmatter
// or never closes it (no engineer reader takes such a file as a workflow).
function claimValues(text, file) {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  if (lines[0] !== '---') return null;
  const values = {};
  let block = null;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '---') return values;
    if (line.startsWith(' ')) {
      const branch = block === 'git_baseline' ? line.match(/^ {2}branch:(?: (.*))?$/) : null;
      if (branch) values['git_baseline.branch'] = claimScalar(branch[1] ?? '', 'git_baseline.branch', file);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon === -1) {
      block = null;
      continue;
    }
    const key = line.slice(0, colon);
    const rest = line.slice(colon + 1).replace(/^ /, '');
    block = rest === '' ? key : null;
    if (rest !== '' && CLAIM_KEYS.has(key)) values[key] = claimScalar(rest, key, file);
  }
  return null;
}

// Every engineer workflow file in the homes of every root of the repository
// (ADR-0067 Decision 1(b)), each physical file once: [{ path, active, values }].
// Only a missing home or file is "nothing there"; anything else that cannot
// be read throws, a non-regular entry included, since it could hide a claimant.
function engineerWorkflowFiles(repoRoot, { activeOnly = false } = {}) {
  const files = [];
  const seen = new Set();
  for (const root of repositoryRoots(repoRoot)) {
    for (const home of ENGINEER_HOMES) {
      for (const sub of activeOnly ? ['workflows'] : ['workflows', 'archive']) {
        const dir = join(root, ...home, sub);
        let names;
        try {
          names = readdirSync(dir);
        } catch (err) {
          if (err.code === 'ENOENT') continue;
          throw err;
        }
        for (const name of names.filter((n) => n.endsWith('.md'))) {
          const path = join(dir, name);
          let identity;
          let text;
          try {
            identity = realpathSync(path);
            if (seen.has(identity)) continue;
            text = readFrontmatterText(path);
          } catch (err) {
            if (err.code === 'ENOENT') continue;
            throw err;
          }
          seen.add(identity);
          if (text === null) throw new Error(`${path} is not a regular file`);
          const values = claimValues(text, path);
          if (values) files.push({ path, active: sub === 'workflows', values });
        }
      }
    }
  }
  return files;
}

// The dispatch a claimant records, in the form --expect-dispatch takes: the
// selection recorded at its creation, or, for a child created before that
// record, the branch it was created on.
function claimDispatch({ values, path }, macroId, subtaskId) {
  const dispatch = { macro: macroId, subtask: subtaskId };
  if ('dispatched_branch' in values) {
    for (const key of ['branch', 'verb', 'profile', 'topic']) {
      if (!(`dispatched_${key}` in values)) {
        throw new Error(`${path} records a partial dispatch (no dispatched_${key})`);
      }
      dispatch[key] = values[`dispatched_${key}`];
    }
    if (!dispatch.branch || !dispatch.verb) {
      throw new Error(`${path} records a dispatch with an empty branch or verb`);
    }
    return dispatch;
  }
  if (!values['git_baseline.branch']) {
    throw new Error(`${path} records neither a dispatch nor the branch it was created on (git_baseline)`);
  }
  dispatch.branch = values['git_baseline.branch'];
  return dispatch;
}

/**
 * The engineer workflows that claim `subtaskId` of `macroId` (both
 * `parent_workflow` and `originating_subtask` equal), by workflow id, with the
 * dispatch each records: Map id → { id, paths, active, dispatch }. Two files
 * of one id that record different dispatches throw; so does any entry that
 * cannot be read. `others` maps the ids of the files that claim something else.
 */
export function subtaskClaims({ repoRoot, macroId, subtaskId, activeOnly = false }) {
  const claims = new Map();
  const others = new Map();
  for (const file of engineerWorkflowFiles(repoRoot, { activeOnly })) {
    const { values, path } = file;
    const claimant = values.parent_workflow === macroId && values.originating_subtask === subtaskId;
    if (!claimant) {
      if (values.workflow_id) others.set(values.workflow_id, [...(others.get(values.workflow_id) ?? []), file]);
      continue;
    }
    if (!values.workflow_id) throw new Error(`${path} claims subtask ${JSON.stringify(subtaskId)} but records no workflow_id`);
    const dispatch = claimDispatch(file, macroId, subtaskId);
    const known = claims.get(values.workflow_id);
    if (known) {
      if (JSON.stringify(known.dispatch) !== JSON.stringify(dispatch)) {
        throw new Error(
          `two files of ${values.workflow_id} record different dispatches: ${known.paths[0]} and ${path}`,
        );
      }
      known.paths.push(path);
      known.active ||= file.active;
      continue;
    }
    claims.set(values.workflow_id, { id: values.workflow_id, paths: [path], active: file.active, dispatch });
  }
  return { claims, others };
}

/**
 * The owner /orchestrator:done completes `subtaskId` in the name of, and the
 * dispatch it records (ADR-0067 Decision 4, item 5). With `owner` (the
 * subtask's recorded engineer_workflow_id): { status: 'found', claim } when a
 * file of that workflow claims the subtask; 'elsewhere' when its files claim
 * something else; 'owner-missing' when no file of it is left anywhere in the
 * repository. Without: 'found' for the one claimant, 'none', or 'ambiguous'
 * with every claimant. Throws when an entry cannot be read.
 */
export function ownerDispatch({ repoRoot, macroId, subtaskId, owner = null }) {
  const { claims, others } = subtaskClaims({ repoRoot, macroId, subtaskId });
  if (owner !== null) {
    if (claims.has(owner)) return { status: 'found', claim: claims.get(owner) };
    if (others.has(owner)) return { status: 'elsewhere', files: others.get(owner) };
    return { status: 'owner-missing' };
  }
  if (claims.size === 0) return { status: 'none' };
  if (claims.size > 1) return { status: 'ambiguous', claims: [...claims.values()] };
  return { status: 'found', claim: [...claims.values()][0] };
}

// A word the POSIX shells (bash, zsh) read back as `value`, quotes and all.
const shellWord = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

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

// A boolean flag given without a value (`--correct`) or as `--correct=true`.
// cliParseFlags would hand a following bare token to the flag as its value,
// so anything other than '', 'true' or 'false' is refused instead of read as
// true.
function cliPresenceFlag(flags, name) {
  if (!(name in flags)) return false;
  const value = flags[name];
  if (value === '' || value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`--${name} takes no value (got ${JSON.stringify(value)})`);
}

// ADR-0062 — `--reason-file <path>` (what runbooks use, so prose never passes
// through the shell) or `--reason <text>`. A trailing newline from the file is
// dropped; the text is otherwise kept as written. `--reason-file -` reads
// standard input, so a runbook can pipe a note it assembles from files without
// writing (and later removing) a temporary file of its own.
async function cliReasonFlag(flags) {
  if ('reason-file' in flags && 'reason' in flags) {
    throw new Error('pass --reason or --reason-file, not both');
  }
  if ('reason-file' in flags) {
    if (flags['reason-file'].length === 0) throw new Error('--reason-file needs a path');
    const text = flags['reason-file'] === '-'
      ? await readStandardInput()
      : await readFile(flags['reason-file'], 'utf8');
    return text.replace(/\r?\n$/, '');
  }
  return flags.reason;
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function cliPrintHelp() {
  process.stdout.write(
    [
      'plugins/orchestrator/scripts/state.mjs — orchestrator schema 1.2 state CLI (1.0 read-only)',
      '',
      'Usage:',
      '',
      '  find-active --repo-root <path> [--branch <branch>]',
      '    Print absolute path of active workflow on the given branch (or current branch).',
      '    Empty stdout + exit 0 if no active workflow on this branch.',
      '',
      '  find-macro --repo-root <path> --subtask-branch <branch>',
      '    ADR-0019 PR-D — branch-agnostic macro lookup. Scans active',
      '    orchestrator workflows for any whose plan.subtasks[].branch',
      '    matches <branch>. Used by /orchestrator:next + /orchestrator:done',
      '    AFTER the user has been switched to a subtask branch.',
      '    Empty stdout + exit 0 if no match; exit 1 + stderr on 2+ ambiguous.',
      '',
      '  read-subtask --workflow-path <path> --subtask-id <id>',
      '    ADR-0019 PR-D — emit one plan.subtasks[i] entry as JSON. Used',
      '    by /orchestrator:next + /orchestrator:done to extract verb /',
      '    branch / status / engineer_workflow_id / etc. without inline',
      '    YAML scans. Exit 1 + stderr on subtask id not found.',
      '',
      '  next-ready --workflow-path <path>',
      '    ADR-0019 PR-D — emit the first plan.subtasks[i] entry with',
      '    status=pending AND all blocked_by predecessors completed. JSON:',
      '    {ready: <subtask>} on success or',
      '    {ready: null, reason: empty_plan|all_terminal|in_progress_or_blocked,',
      '     summary?: {...}, readiness?: [...]} when no candidate is ready.',
      '    readiness lists each open subtask as {id, status, blocked_by,',
      '    waiting_on, stale_blocked, ready} (ADR-0062 §Decision 5).',
      '    Every shape also carries approval: {status: approved|pending|absent,',
      '    hash_ok: true|false|null} (ADR-0063 D6; hash_ok is null unless approved).',
      '',
      '  plan-hash --workflow-path <path>',
      '    ADR-0063 D6 — print {plan_hash, subtasks, approval, approved_at,',
      '    awaiting_owner_gate, awaiting_owner_pointer}. plan_hash is sha256 over the',
      '    canonical JSON of subtasks, the plan projected to id, label, branch,',
      '    blocked_by, verb, profile and topic (progress fields are not covered).',
      '',
      '  approval-gate --workflow-path <path> --host claude|codex --subtask-json <json>',
      '    ADR-0063 D4 rule 3 — the approval gate of /orchestrator:next, for the',
      '    subtask it selected (--subtask-json, as read-subtask or next-ready gave it).',
      '    When AGENTIC_AUTOPILOT names an autopilot run, a plan not approved at its',
      '    current hash (pending, changed since approval, or never approved), or a',
      '    selected subtask that differs from that plan\'s entry in a hashed field, is',
      '    refused: "✗ plan-unapproved" and a pointer on stderr, exit 1. Otherwise',
      '    exit 0; an interactive dispatch of a plan pending approval or changed',
      '    since approval gets one warning line on stderr (owner decision D3), and',
      '    a macro with no approval keys none. JSON {verdict: proceed|warn|refuse,',
      '    reason, autopilot, approval, pointer}.',
      '',
      '  plan-approve --workflow-path <path> --host claude|codex [--expect-hash <hex>]',
      '    ADR-0063 D6 — record the owner\'s approval of the plan as it stands:',
      '    plan_approval_status=approved, approved_at, plan_hash; removes the',
      '    plan-approval gate. Exit 1 when --expect-hash differs from the current',
      '    hash, while plan-conflict is set, on an empty plan, on a terminal macro,',
      '    and when AGENTIC_AUTOPILOT names an autopilot run. The same hash approved',
      '    again writes nothing ({noop: true}). JSON {workflowPath, plan_hash, approved_at}.',
      '',
      '  awaiting-owner-set --workflow-path <path> --host claude|codex',
      '                     --gate plan-approval|plan-conflict',
      '                     --pointer <repo-relative path#anchor> [--since <YYYY-MM-DDTHH:MM:SSZ>]',
      '    ADR-0063 D6 — set a macro owner gate on a plan pending approval. --since',
      '    defaults to now. The same gate again replaces pointer and since;',
      '    plan-approval may be raised to plan-conflict; anything else is exit 1.',
      '',
      '  awaiting-owner-clear --workflow-path <path> --host claude|codex --gate plan-conflict',
      '    ADR-0063 D6 — the owner resolves plan-conflict; the plan returns to the',
      '    plan-approval gate and a phase note records the resolution. Exit 1 when',
      '    the gate named is not the one set, for plan-approval (approve instead),',
      '    and when AGENTIC_AUTOPILOT names an autopilot run. The run id goes with',
      '    plan-conflict, and its task file is retired (ADR-0067 Decision 8).',
      '',
      '  consensus-task --workflow-path <path> --run-id <run id> [--host claude|codex]',
      '                 (--text <contested items> | --text-file <path>)',
      '    ADR-0067 Decision 8 — write the contested items of a Plan-verify conflict',
      '    as <home>/consensus/<macro id>.<run id>.md and print the runtime:consensus',
      '    command the proposal selects, with its absolute path. Exit 1 unless',
      '    ensemble_results holds the run with the verdict conflict.',
      '',
      '  consensus-proposal --workflow-path <path> [--host claude|codex]',
      '    Read-only. Whether plan-conflict has a current task file, and the command',
      '    it proposes, as JSON {current, gate, run_id, task_file?, pointer?, command? | reason}.',
      '',
      '  subtask-engineer-terminal --workflow-path <path> --host claude|codex --subtask-id <id>',
      '                            --engineer-workflow-id <id> --branch-commit <sha>',
      '                            [--expect-workflow-id <macro id>] [--expect-dispatch <json>]',
      '    ADR-0062 §Decision 2 — called by the engineer Phase 7 and Stop hook when its',
      '    workflow reaches its terminal commit. Does not complete the subtask: binds an',
      '    unrecorded owner (refuses a different one), moves pending to in_progress, notes',
      '    the branch commit once and points next_action at /orchestrator:done. Skips',
      '    completed / deferred / abandoned / blocked subtasks. JSON envelope on stdout.',
      '    ADR-0067 Decision 3 — with --expect-workflow-id, a file whose workflow_id',
      '    differs on the locked read is refused and nothing is written.',
      '    ADR-0067 Decision 4, item 5 — --expect-dispatch=<json> is the dispatch the',
      '    engineer workflow records (engineer state.mjs dispatch-selection: macro,',
      '    subtask, branch, and verb, profile, topic when recorded); a subtask that no',
      '    longer matches it on the locked read is refused (dispatch-changed), nothing',
      '    written. subtask-update takes it too.',
      '',
      '  resolve-landing --repo-root <path> --workflow-path <path> --subtask-id <id>',
      '                  [--integration-branch <branch>] [--commit <sha>] [--pr <number>]',
      '                  [--engineer-workflow-id <id>]',
      '    ADR-0062 — the merge commit that landed the subtask: the merged pull request',
      '    whose head is the subtask branch, opened after the engineer workflow was',
      '    dispatched, based on the integration branch (default: the macro baseline',
      '    branch), its merge commit reachable from refs/remotes/origin/<branch>.',
      '    --commit must equal that merge commit; without a working gh it is',
      '    verified by ancestry only. JSON {ok, commit, pr_url, pr_number,',
      '    verification, integration_ref} or {ok: false, reason, detail} (exit 1).',
      '',
      '  subtask-readiness --workflow-path <path> --subtask-id <id>',
      '    ADR-0062 §Decision 5 — the same readiness object for one subtask',
      '    (the explicit-id path of /orchestrator:next). Exit 1 on unknown id.',
      '',
      '  lane-advice --workflow-path <macro> --repo-root <checkout> [--format line]',
      '    ADR-0067 Decision 8, item 2 — read-only: whether running the macro\'s',
      '    subtasks two at a time shortens it (a simulation from blocked_by, each',
      '    subtask one step), as JSON; with --format line, the `- lane_advice:` line',
      '    /orchestrator:plan and /orchestrator:approve show, or nothing. Its command',
      '    names the macro, and is given only with shared creation on and the macro',
      '    in a home of the default state root; otherwise the line names the cutover.',
      '',
      '  worktree-proposal --workflow-path <macro> --repo-root <checkout> --subtask-id <id>',
      '                    [--host claude|codex] [--format text]',
      '    ADR-0067 Decision 8, item 3 — read-only: the git worktree add command',
      '    /orchestrator:next proposes first when a dirty tree stops its dispatch,',
      '    from a fixed template (runtime:worktree\'s path rule), as JSON; with',
      '    --format text, the lines the runbook prints. Proposed only when the macro',
      '    lies in a home of the default state root, which a new worktree reads.',
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
      '         [--event created|updated|snapshot|resumed|checkpointed] [--require-open]',
      '    Append a phase note to an existing workflow. Default event=resumed.',
      '    --require-open refuses, under the write lock, a macro whose terminal_marker',
      '    is set (ADR-0062 §Decision 4).',
      '',
      '  snapshot --workflow-path <path> --host <host> --trigger pre-compact|stop',
      '           [--status-digest <hex>]',
      '    Update last_snapshot + append host_history snapshot entry. Used by hooks.',
      '',
      '  checkpoint-set --workflow-path <path> --host claude|codex --summary <text>',
      '    Set latest_checkpoint and append host_history checkpointed.',
      '    Used by /orchestrator:checkpoint and $orchestrator:checkpoint.',
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
      '           [--event updated|resumed] [--verdict pass|concerns|conflict [--run-id <run id>]]',
      '           [--correct (--reason-file <path> | --reason <text>)]',
      '    ADR-0018 §sub-1 + ADR-0019 §2 — atomic write of plan.{decision?, architecture?, subtasks[]}.',
      '    ADR-0062: refused on a terminal macro; runs the unblock pass; never',
      '    auto-terminals (an all-terminal revision prints a /orchestrator:finalize',
      '    hint on stderr); a completed subtask is carried unchanged (omitted',
      '    provenance carried forward) unless --correct with a reason.',
      '    ADR-0063 D6: every plan-set returns the plan to pending approval,',
      '    revoking an earlier approval. --verdict pass|concerns|conflict is the',
      '    plan\'s Plan-verify verdict: conflict opens awaiting_owner_gate=plan-conflict',
      '    in the same write; otherwise (or without --verdict) plan-approval.',
      '    ADR-0067 Decision 8: --run-id (with --verdict conflict) is the Plan-verify',
      '    run plan-conflict records; every live consensus task file of the macro is',
      '    retired (renamed <id>.<run>.resolved.md) before the write.',
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
      '                 [--event updated|resumed] [--expect-branch <branch>]',
      '                 [--expect-verb <verb>] [--expect-profile <profile>]',
      '                 [--expect-topic <topic>] [--expect-dispatch <json> | --waive-dispatch]',
      '                 [--correct] [--reason-file <path>|- | --reason <text>]',
      '    ADR-0019 PR-C0 — atomic single-subtask mutation. Updates one',
      '    plan.subtasks[i] entry by id without rewriting the whole plan.',
      '    At least one mutable field must be supplied. Immutable fields',
      '    (id / verb / branch / blocked_by / profile / topic / label) are rejected;',
      '    use plan-set for full re-planning.',
      '    Side effects (atomic): unblock pass (§4 step 6) + auto-terminal pass',
      '    (§4 step 7 — sets terminal_marker + current_phase when all subtasks',
      '    are terminal). Prints JSON {workflowPath, updatedSubtask, autoTerminal}.',
      '    Status guard: deferred/abandoned are rejected — those terminal-partial',
      '    states are owned by /orchestrator:finalize and /orchestrator:abort',
      '    (via bulk-subtask-status + set-terminal below).',
      '    ADR-0062 §Decision 3: a recorded commit / pr_url is never replaced',
      '    and a recorded closed_at is kept unless --correct (reason required);',
      '    a call that changes nothing writes nothing ({skipped, noop: true});',
      '    --expect-branch refuses the write if the subtask branch changed;',
      '    --expect-verb, --expect-profile and --expect-topic likewise (an empty',
      '    profile or topic expects none; trailing newlines are not compared).',
      '    Pass a topic as --expect-topic=<topic>, so one starting with -- is',
      '    not read as a flag. --expect-dispatch=<json> is the dispatch an engineer',
      '    workflow records (see subtask-engineer-terminal, owner-dispatch); each',
      '    expectation given is compared on its own. --waive-dispatch (reason',
      '    required, with --engineer-workflow-id) writes without that comparison when',
      '    the record cannot be read; the macro body records the waiver and the reason.',
      '',
      '  bulk-subtask-status --workflow-path <path> --host claude|codex',
      '                      --from-statuses <csv> --to-status deferred|abandoned',
      '                      [--event updated|resumed]',
      '    ADR-0019 PR-E §5 step 1 — atomic bulk subtask status transition.',
      '    Domain-constrained: fromStatuses must be subset of',
      '    {pending, blocked, in_progress}; toStatus must be one of',
      '    {deferred, abandoned}. Used by /orchestrator:finalize (deferred)',
      '    and /orchestrator:abort (abandoned) before the child-detach pass.',
      '    Prints JSON {workflowPath, transitionedIds[]}.',
      '',
      '  set-terminal --workflow-path <path> --host claude|codex',
      '               --terminal-phase commit-complete|finalized|aborted',
      '               [--terminal-marker true|false] [--next-action <text>]',
      '               [--event updated|resumed]',
      '    ADR-0019 PR-E §5 step 3 — atomic terminal-marker + current_phase',
      '    write. Default --terminal-marker=true. Used after the child-detach',
      '    pass to mark the macro plan terminal so the next host Stop hook can',
      '    auto-archive the workflow file.',
      '',
      '  archive --workflow-path <path> --host claude|codex --repo-root <path>',
      '    ADR-0019 PR-E §5 — move macro workflow file from workflows/ to',
      '    archive/. Collision-safe (timestamp-suffix). Idempotent if source is',
      '    already absent. Engineer-pattern mirror.',
      '',
      '  resolve-workflow --repo-root <checkout> --workflow-id <macro id>',
      '    Print the macro file <id>.md found in the orchestrator workflows homes',
      "    of the checkout's read set (ADR-0067 Decision 4, item 2). Exit 3 when",
      '    none holds it; exit 1 on an error (two files hold it, or a root cannot',
      '    be read).',
      '',
      '  admission join --macro <id> --checkout <path> --command next|done|finalize|abort|resume',
      '                 --host claude|codex [--session-id <id>]',
      '  admission check --macro <id> --checkout <path> --admission <admission id>',
      '  admission release --macro <id> --checkout <path> --admission <admission id>',
      '    ADR-0067 Decision 4, item 5: an interactive command takes part in the',
      "    locks an autopilot run takes. join writes one entry under a new id in",
      "    the macro lock (and, for next, the checkout's worktree lock first),",
      '    prints the id and proceeds only when no other live entry is there; exit 1',
      "    names the holder. A worker of the run holding them passes with no entry",
      "    (it prints an empty id). check: exit 1 when any entry of the id is gone.",
      '    release removes them (an owner may release a gone session the same way).',
      '',
      '  scan-roots --repo-root <checkout>',
      "    Print the repository-wide scan set as a JSON array: the checkout's read",
      "    set, then every other worktree's toplevel (ADR-0067 Decision 1(b)). Exit 1",
      '    when git cannot list the worktrees.',
      '',
      '  owner-dispatch --repo-root <checkout> --macro-id <id> --workflow-path <macro>',
      '                 --subtask-id <id> --host claude|codex [--engineer-workflow-id <owner>]',
      "    ADR-0067 Decision 4, item 5 — /orchestrator:done's owner and the dispatch",
      '    it records, from the engineer workflow files in every root of the repository',
      '    (their frontmatter values parsed, never matched as text). With the recorded',
      '    owner: its file that claims the subtask. Without: the one claimant. Exit 0,',
      '    JSON {engineer_workflow_id, dispatch, path} (dispatch is --expect-dispatch\'s',
      '    JSON); exit 3 when the recorded owner has no file left (done may then',
      '    --waive-dispatch); exit 1 otherwise: no claimant, more than one (each with a',
      '    binding line that carries its dispatch), an owner dispatched for something',
      '    else, or an entry that cannot be read. The path goes only into those lines.',
      '',
      '  active-child --repo-root <checkout> --macro-id <id> --subtask-id <id>',
      '    The path of an active engineer workflow claiming the subtask, or nothing',
      '    (same reading as owner-dispatch). Exit 1 when an entry cannot be read.',
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
      '  cutover --repo-root <main checkout> --plan | --move | --verify',
      '    The operator cutover (ADR-0067 Decision 4, item 4, steps 3, 4 and 6;',
      "    docs/runbooks/state-root-cutover.md). --plan (read-only) prints the set: each",
      "    macro in a linked worktree's own home, every engineer workflow there of a",
      '    macro moved or under the default state root, and their peer-run ledgers,',
      '    with every refusal. --move writes the manifest under',
      '    .agentic-plugins/runs/cutover/ first, then renames each pair under the',
      '    writers\' locks; a rerun continues an interrupted move, and otherwise plans',
      '    again. --verify checks the result after shared-creation --enable. Exit 1',
      '    on a refusal or a failed check.',
      '',
      '  cutover --repo-root <main checkout> --rollback --plan | --move',
      '    The rollback, until lanes first run (ADR-0067 Decision 4, item 4,',
      '    Rollback). --plan (read-only) finds each record under the default state',
      "    root and where it goes back: a moved record to the checkout the cutover's",
      "    manifests name, one created after the switch in a linked worktree to that",
      '    checkout (its repo_root); the rest stay. --move writes its own manifest,',
      '    turns shared creation off and moves; a rerun continues it.',
      '',
      'Verbs: plan (orchestrator MVP).',
      'Hosts: claude, codex.',
      '',
    ].join('\n'),
  );
}

async function cliMain(argv) {
  const [subcommand, ...args] = argv;
  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    cliPrintHelp();
    return 0;
  }
  // `admission <join|check|release>` takes its action as a word.
  const action = subcommand === 'admission' && args.length > 0 && !args[0].startsWith('--') ? args[0] : undefined;
  const rest = action === undefined ? args : args.slice(1);

  let flags;
  try {
    flags = cliParseFlags(rest);
  } catch (err) {
    process.stderr.write(`state.mjs: ${err.message}\n`);
    return 2;
  }
  if (action !== undefined) flags['admission-action'] = action;

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
        const path =
          'branch' in flags
            ? await findActiveWorkflowByBranch(flags['repo-root'], flags.branch)
            : await findActiveWorkflow(flags['repo-root']);
        if (path) process.stdout.write(`${path}\n`);
        return 0;
      }

      case 'find-macro': {
        // ADR-0019 §1 lines 187-213 — branch-agnostic macro lookup
        // used by /orchestrator:next + /orchestrator:done after the
        // user has switched to a subtask branch.
        cliRequire(flags, ['repo-root', 'subtask-branch']);
        const path = await findMacroBySubtaskBranch(
          flags['repo-root'],
          flags['subtask-branch'],
        );
        if (path) process.stdout.write(`${path}\n`);
        return 0;
      }

      // ADR-0067 Decision 4, item 2 — the runbooks' `--workflow=<id>`
      // resolver: the macro file in the checkout's read set; exit 1 when no
      // root holds it, an error when two files do.
      case 'resolve-workflow': {
        cliRequire(flags, ['repo-root', 'workflow-id']);
        const path = await resolveMacroById(flags['repo-root'], flags['workflow-id']);
        if (!path) {
          process.stderr.write(
            `state.mjs: no macro ${JSON.stringify(flags['workflow-id'])} in the orchestrator workflows homes ` +
              `of the read set of ${flags['repo-root']}\n`,
          );
          // 3, not 1: the autopilot observer then looks in the archive, which
          // it must not do when the lookup failed (exit 1).
          return 3;
        }
        process.stdout.write(`${path}\n`);
        return 0;
      }

      // ADR-0067 Decision 4, item 5 — the interactive commands' admission
      // entries in the locks a run takes (scripts/lib/run-locks.mjs).
      case 'admission': {
        const admissionAction = flags['admission-action'];
        cliRequire(flags, ['macro', 'checkout']);
        if (admissionAction === 'join') {
          cliRequire(flags, ['command', 'host']);
          let joined;
          try {
            joined = await joinAdmission({
              command: flags.command, checkout: flags.checkout, macroId: flags.macro,
              host: flags.host, sessionId: flags['session-id'] || null,
            });
          } catch (err) {
            if (!(err instanceof LockHeldError)) throw err;
            process.stderr.write(`state.mjs admission join: refused: ${err.message}\n`);
            return 1;
          }
          process.stderr.write(joined.admissionId === ''
            ? `admitted as a worker of the holding run ${joined.workerOf}\n`
            : `admitted: ${joined.admissionId} (${joined.locks.join(', ')})\n`);
          process.stdout.write(`${joined.admissionId}\n`);
          return 0;
        }
        if (admissionAction === 'check' || admissionAction === 'release') cliRequire(flags, ['admission']);
        if (admissionAction === 'check') {
          const checked = await checkAdmission({ checkout: flags.checkout, macroId: flags.macro, admissionId: flags.admission });
          if (checked.ok) return 0;
          process.stderr.write(
            `state.mjs admission check: ${checked.why}. Stop before acting: another session or run may hold ` +
              'the checkout or the macro now.\n',
          );
          return 1;
        }
        if (admissionAction === 'release') {
          const removed = releaseAdmission({ checkout: flags.checkout, macroId: flags.macro, admissionId: flags.admission });
          process.stderr.write(`released ${removed.length} admission entr${removed.length === 1 ? 'y' : 'ies'}\n`);
          return 0;
        }
        throw new Error(`admission takes join, check or release (got ${JSON.stringify(admissionAction ?? '')})`);
      }

      // ADR-0067 Decision 1(b) — the repository-wide scan set the runbooks'
      // engineer scans read: the read set, then every other worktree's
      // toplevel, each directory once, as a JSON array. Fails (exit 1) when
      // the worktrees cannot be listed: a scan that skipped one could miss a
      // child.
      case 'scan-roots': {
        cliRequire(flags, ['repo-root']);
        process.stdout.write(`${JSON.stringify(repositoryRoots(flags['repo-root']))}\n`);
        return 0;
      }

      // ADR-0067 Decision 4, item 5 — /orchestrator:done's owner, and the
      // dispatch it records, which done's write compares (ownerDispatch); the
      // macro path only goes into the binding lines it prints. Exit 0
      // with JSON {engineer_workflow_id, dispatch, path}, dispatch in the form
      // --expect-dispatch takes; exit 3 when the recorded owner has no file left
      // in the repository (only then may done waive the comparison); exit 1,
      // the reason on stderr, otherwise.
      case 'owner-dispatch': {
        cliRequire(flags, ['repo-root', 'macro-id', 'workflow-path', 'subtask-id', 'host']);
        validateHost(flags.host);
        const subtaskId = flags['subtask-id'];
        const macroPath = flags['workflow-path'];
        const macroId = flags['macro-id'];
        const owner = flags['engineer-workflow-id'] || null;
        let found;
        try {
          found = ownerDispatch({ repoRoot: flags['repo-root'], macroId, subtaskId, owner });
        } catch (err) {
          process.stderr.write(
            `✗ Could not scan the engineer workflow homes for ${subtaskId}'s owner: ${err.message}; refusing to guess.\n`,
          );
          return 1;
        }
        if (found.status === 'found') {
          process.stdout.write(`${JSON.stringify({
            engineer_workflow_id: found.claim.id,
            dispatch: JSON.stringify(found.claim.dispatch),
            path: found.claim.paths[0],
          })}\n`);
          return 0;
        }
        if (found.status === 'owner-missing') {
          process.stderr.write(
            `✗ ${subtaskId}'s recorded owner ${owner} has no workflow file left in any engineer home of the repository, ` +
              `so the dispatch it records cannot be read and this completion cannot be compared with it ` +
              `(ADR-0067 Decision 4, item 5). To complete it anyway, rerun with --waive-dispatch and a reason; ` +
              `the macro records both.\n`,
          );
          return 3;
        }
        if (found.status === 'elsewhere') {
          const claims = found.files.map((f) => `parent_workflow=${f.values.parent_workflow ?? '<none>'}, ` +
            `originating_subtask=${f.values.originating_subtask ?? '<none>'} (${f.path})`);
          process.stderr.write(
            `✗ ${subtaskId}'s recorded owner ${owner} was not dispatched for it: its workflow claims ` +
              `${claims.join('; ')}, not parent_workflow=${macroId}, originating_subtask=${subtaskId}.\n`,
          );
          return 1;
        }
        if (found.status === 'none') {
          process.stderr.write(
            `✗ No engineer workflow found with parent_workflow=${macroId} AND originating_subtask=${subtaskId} (active or archived).\n` +
              `  This subtask was likely never dispatched — run ${flags.host === 'codex' ? '$' : '/'}orchestrator:next ${subtaskId} first.\n`,
          );
          return 1;
        }
        // Ambiguous: the operator names the owner with a binding that compares
        // the chosen child's dispatch, as every binding does.
        const script = fileURLToPath(import.meta.url);
        const lines = [`✗ More than one engineer workflow claims ${subtaskId} in ${macroId}:`];
        for (const claim of found.claims) lines.push(`  ${claim.id} (${claim.paths[0]})`);
        lines.push(
          '  Record the owner explicitly first, with the line of the workflow that did the work; it binds',
          `  that workflow only while ${subtaskId} is still the subtask it was dispatched for:`,
        );
        for (const claim of found.claims) {
          lines.push(`    node ${shellWord(script)} subtask-update --workflow-path=${shellWord(macroPath)} ` +
            `--host=${flags.host} --subtask-id=${shellWord(subtaskId)} --engineer-workflow-id=${shellWord(claim.id)} ` +
            `--expect-dispatch=${shellWord(JSON.stringify(claim.dispatch))}`);
        }
        process.stderr.write(`${lines.join('\n')}\n`);
        return 1;
      }

      // ADR-0067 Decision 4, item 5 — an active engineer workflow claiming the
      // subtask (done --no-commit refuses one): its path, or nothing. Exit 1,
      // the reason on stderr, when an entry cannot be read.
      case 'active-child': {
        cliRequire(flags, ['repo-root', 'macro-id', 'subtask-id']);
        const { claims } = subtaskClaims({
          repoRoot: flags['repo-root'], macroId: flags['macro-id'], subtaskId: flags['subtask-id'], activeOnly: true,
        });
        const [active] = claims.values();
        if (active) process.stdout.write(active.paths[0]);
        return 0;
      }

      case 'read-subtask': {
        // ADR-0019 PR-D — emit one plan.subtasks[i] entry as JSON so
        // /orchestrator:next + /orchestrator:done runbook bash blocks can
        // extract fields (verb / branch / status / engineer_workflow_id /
        // commit / closed_at / profile / topic) without inline YAML scan
        // shims. Exit 0 + JSON on stdout; exit 1 + stderr on not-found
        // or on a legacy schema 1.0 file (dispatch requires verb+branch).
        cliRequire(flags, ['workflow-path', 'subtask-id']);
        const text = await readFile(flags['workflow-path'], 'utf8');
        const { frontmatter } = parseWorkflowFile(text);
        if (frontmatter?.schema === '1.0') {
          process.stderr.write(
            `read-subtask: schema 1.0 plan does not carry the required verb/branch fields ` +
              `for /orchestrator:next dispatch — archive this legacy plan and run ` +
              `/orchestrator:plan to generate a fresh schema 1.1 plan (ADR-0019 §2 PR-B).\n`,
          );
          return 1;
        }
        const subtasks = frontmatter?.plan?.subtasks;
        if (!Array.isArray(subtasks)) {
          process.stderr.write(`read-subtask: workflow has no plan.subtasks[]\n`);
          return 1;
        }
        const found = subtasks.find((s) => s && s.id === flags['subtask-id']);
        if (!found) {
          process.stderr.write(
            `read-subtask: subtask id ${JSON.stringify(flags['subtask-id'])} not found in plan.subtasks[]\n`,
          );
          return 1;
        }
        process.stdout.write(`${JSON.stringify(found)}\n`);
        return 0;
      }

      case 'next-ready': {
        // ADR-0019 PR-D + Codex P2 deterministic-selection policy —
        // emit the first subtask that is `pending` AND has all
        // `blocked_by` predecessors `completed`. When no such candidate
        // exists, emit a structured diagnostic JSON `{reason, summary}`
        // distinguishing the three actionable states:
        //   - all_terminal   → all subtasks are completed/deferred/abandoned
        //                      (recommend /orchestrator:finalize)
        //   - in_progress_or_blocked → at least one is in_progress (waiting)
        //                              or blocked (waiting on predecessor)
        //   - empty_plan     → plan.subtasks[] is empty
        // Schema 1.0 legacy plans are rejected here — they lack the
        // verb/branch fields the dispatch path requires.
        cliRequire(flags, ['workflow-path']);
        const text = await readFile(flags['workflow-path'], 'utf8');
        const { frontmatter } = parseWorkflowFile(text);
        if (frontmatter?.schema === '1.0') {
          process.stderr.write(
            `next-ready: schema 1.0 plan does not carry the required verb/branch fields ` +
              `for /orchestrator:next dispatch — archive this legacy plan and run ` +
              `/orchestrator:plan to generate a fresh schema 1.1 plan (ADR-0019 §2 PR-B).\n`,
          );
          return 1;
        }
        const subtasks = Array.isArray(frontmatter?.plan?.subtasks)
          ? frontmatter.plan.subtasks
          : [];
        // ADR-0063 D6 — additive on every shape, so a dispatcher gets
        // readiness and approval from one call and never recomputes the hash.
        const approval = planApprovalState(frontmatter);
        if (subtasks.length === 0) {
          process.stdout.write(`${JSON.stringify({ ready: null, reason: 'empty_plan', approval })}\n`);
          return 0;
        }
        const readiness = subtaskReadiness(subtasks);
        const readyIdx = readiness.findIndex((r) => r.ready);
        if (readyIdx !== -1) {
          process.stdout.write(`${JSON.stringify({ ready: subtasks[readyIdx], approval })}\n`);
          return 0;
        }
        const allTerminal = subtasks.every((s) => TERMINAL_SUBTASK_STATUSES.has(s?.status));
        const summary = {
          total: subtasks.length,
          completed: subtasks.filter((s) => s?.status === 'completed').length,
          in_progress: subtasks.filter((s) => s?.status === 'in_progress').length,
          blocked: subtasks.filter((s) => s?.status === 'blocked').length,
          pending_unready: subtasks.filter((s) => s?.status === 'pending').length,
          deferred: subtasks.filter((s) => s?.status === 'deferred').length,
          abandoned: subtasks.filter((s) => s?.status === 'abandoned').length,
        };
        process.stdout.write(
          `${JSON.stringify({
            ready: null,
            reason: allTerminal ? 'all_terminal' : 'in_progress_or_blocked',
            summary,
            // ADR-0062 §Decision 5 — the facts behind the diagnosis, for the
            // subtasks that are still open.
            readiness: readiness.filter((r) => !TERMINAL_SUBTASK_STATUSES.has(r.status)),
            approval,
          })}\n`,
        );
        return 0;
      }

      case 'plan-hash': {
        // ADR-0063 D6 — what an approval would bind to, for
        // /orchestrator:approve to show before it approves. Read-only.
        cliRequire(flags, ['workflow-path']);
        const { frontmatter } = await readWorkflow(flags['workflow-path']);
        const subtasks = Array.isArray(frontmatter?.plan?.subtasks) ? frontmatter.plan.subtasks : [];
        process.stdout.write(`${JSON.stringify({
          plan_hash: computePlanHash(subtasks),
          subtasks: planHashProjection(subtasks),
          approval: planApprovalState(frontmatter),
          approved_at: frontmatter.plan_approval_approved_at ?? null,
          awaiting_owner_gate: frontmatter.awaiting_owner_gate ?? null,
          awaiting_owner_pointer: frontmatter.awaiting_owner_pointer ?? null,
        })}\n`);
        return 0;
      }

      case 'approval-gate': {
        // ADR-0063 D4 rule 3, owner decision D3 — the approval gate of
        // /orchestrator:next. Read-only: the verdict as JSON on stdout, the
        // warning or refusal on stderr, and exit 1 on a refusal.
        cliRequire(flags, ['workflow-path', 'host', 'subtask-json']);
        let selected;
        try {
          selected = JSON.parse(flags['subtask-json']);
        } catch (err) {
          throw new Error(`approval-gate: --subtask-json is not JSON (${err.message})`);
        }
        const { frontmatter } = await readWorkflow(flags['workflow-path']);
        const { lines, ...gate } = planApprovalGate({
          frontmatter, workflowPath: flags['workflow-path'], host: flags.host, selected,
        });
        for (const line of lines) process.stderr.write(`${line}\n`);
        process.stdout.write(`${JSON.stringify(gate)}\n`);
        return gate.verdict === 'refuse' ? 1 : 0;
      }

      case 'plan-approve': {
        cliRequire(flags, ['workflow-path', 'host']);
        if ('expect-hash' in flags && flags['expect-hash'].length === 0) {
          throw new Error('--expect-hash needs a value');
        }
        const result = await approvePlan({
          workflowPath: flags['workflow-path'],
          host: flags.host,
          expectHash: flags['expect-hash'],
        });
        const envelope = {
          workflowPath: result.workflowPath,
          plan_hash: result.planHash,
          approved_at: result.approvedAt,
        };
        if (result.noop) envelope.noop = true;
        process.stdout.write(`${JSON.stringify(envelope)}\n`);
        return 0;
      }

      // ADR-0063 D6 — the macro owner gates. Both refuse with exit 1; see
      // setAwaitingOwner / clearAwaitingOwner for the transitions allowed.
      case 'awaiting-owner-set': {
        cliRequire(flags, ['workflow-path', 'host', 'gate', 'pointer']);
        const set = await setAwaitingOwner({
          workflowPath: flags['workflow-path'],
          host: flags.host,
          gate: flags.gate,
          pointer: flags.pointer,
          since: flags.since,
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
        });
        if (cleared.retired.warning) process.stderr.write(`warning: ${cleared.retired.warning}\n`);
        process.stdout.write(`${flags['workflow-path']}\n`);
        return 0;
      }

      // ADR-0067 Decision 8 — the macro's consensus task file, once the
      // Plan-verify conflict is committed; it prints the round it proposes.
      case 'consensus-task': {
        cliRequire(flags, ['workflow-path', 'run-id']);
        if (('text' in flags) === ('text-file' in flags)) {
          throw new Error('consensus-task takes the contested items as --text <items> or --text-file <path>, one of them');
        }
        const written = await writeConsensusTask({
          workflowPath: flags['workflow-path'],
          runId: flags['run-id'],
          text: 'text' in flags ? flags.text : await readFile(flags['text-file'], 'utf8'),
          host: flags.host ?? 'claude',
        });
        process.stdout.write(`${written.command}\n`);
        return 0;
      }

      // Read-only: whether plan-conflict has a current task file (JSON).
      case 'consensus-proposal': {
        cliRequire(flags, ['workflow-path']);
        const proposal = await consensusProposal({ workflowPath: flags['workflow-path'], host: flags.host ?? 'claude' });
        process.stdout.write(`${JSON.stringify(proposal)}\n`);
        return 0;
      }

      case 'resolve-landing': {
        // ADR-0062 §Decisions 1-2 — the commit that landed a subtask, for
        // /orchestrator:done. JSON on stdout either way; exit 1 on a refusal.
        cliRequire(flags, ['repo-root', 'workflow-path', 'subtask-id']);
        const text = await readFile(flags['workflow-path'], 'utf8');
        const { frontmatter } = parseWorkflowFile(text);
        const subtasks = Array.isArray(frontmatter?.plan?.subtasks) ? frontmatter.plan.subtasks : [];
        const subtask = subtasks.find((s) => s.id === flags['subtask-id']);
        if (!subtask) {
          throw new Error(`subtask id ${JSON.stringify(flags['subtask-id'])} not found in plan.subtasks[]`);
        }
        const integrationBranch = flags['integration-branch'] || frontmatter?.git_baseline?.branch;
        if (!integrationBranch) {
          throw new Error('the macro records no git_baseline.branch; pass --integration-branch');
        }
        // The owner comes from the macro, or from the caller when /done
        // recovered it from the engineer archive (the macro never recorded it).
        const owner = flags['engineer-workflow-id'] || subtask.engineer_workflow_id;
        const result = await resolveLanding({
          repoRoot: flags['repo-root'],
          subtaskBranch: subtask.branch,
          integrationBranch,
          dispatchedAt: dispatchTimeFromWorkflowId(owner),
          explicitCommit: flags.commit || null,
          explicitPr: flags.pr || null,
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return result.ok ? 0 : 1;
      }

      case 'subtask-engineer-terminal': {
        // ADR-0062 §Decision 2 — the engineer's Phase 7 and Stop hook call
        // this instead of completing the subtask. JSON envelope on stdout.
        cliRequire(flags, ['workflow-path', 'host', 'subtask-id', 'engineer-workflow-id', 'branch-commit']);
        const result = await recordEngineerTerminal({
          workflowPath: flags['workflow-path'],
          host: flags.host,
          subtaskId: flags['subtask-id'],
          engineerWorkflowId: flags['engineer-workflow-id'],
          branchCommit: flags['branch-commit'],
          expectWorkflowId: flags['expect-workflow-id'],
          expectDispatch: flags['expect-dispatch'],
          event: flags.event ?? 'updated',
        });
        if (result.skipped) process.stderr.write(`state.mjs subtask-engineer-terminal: ${result.skipReason}\n`);
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return 0;
      }

      case 'subtask-readiness': {
        // ADR-0062 §Decision 5 — readiness of one subtask, for the explicit-id
        // path of /orchestrator:next (next-ready only reports when nothing is
        // dispatchable).
        cliRequire(flags, ['workflow-path', 'subtask-id']);
        const text = await readFile(flags['workflow-path'], 'utf8');
        const { frontmatter } = parseWorkflowFile(text);
        const subtasks = Array.isArray(frontmatter?.plan?.subtasks) ? frontmatter.plan.subtasks : [];
        const entry = subtaskReadiness(subtasks).find((r) => r.id === flags['subtask-id']);
        if (!entry) {
          throw new Error(`subtask id ${JSON.stringify(flags['subtask-id'])} not found in plan.subtasks[]`);
        }
        process.stdout.write(`${JSON.stringify(entry)}\n`);
        return 0;
      }

      // ADR-0067 Decision 8, item 2 — the lane advice plan and approve show
      // beside their proposal. Read-only; computed each time, never stored.
      case 'lane-advice': {
        cliRequire(flags, ['workflow-path', 'repo-root']);
        const { frontmatter } = await readWorkflow(flags['workflow-path']);
        const advice = laneAdvice({
          subtasks: Array.isArray(frontmatter?.plan?.subtasks) ? frontmatter.plan.subtasks : [],
          macroId: basename(flags['workflow-path'], '.md'),
          sharedCreation: readSharedCreation(flags['repo-root']).state,
          macroUnderDefaultRoot: macroInDefaultRoot(flags['repo-root'], flags['workflow-path']),
        });
        if (flags.format === 'line') {
          const line = laneAdviceLine(advice);
          if (line) process.stdout.write(`${line}\n`);
          return 0;
        }
        if (flags.format !== undefined) throw new Error(`--format takes line (got ${JSON.stringify(flags.format)})`);
        process.stdout.write(`${JSON.stringify(advice)}\n`);
        return 0;
      }

      // ADR-0067 Decision 8, item 3 — the worktree /orchestrator:next selects
      // first when a dirty tree stops its dispatch. Read-only.
      case 'worktree-proposal': {
        cliRequire(flags, ['workflow-path', 'repo-root', 'subtask-id']);
        const host = flags.host ?? 'claude';
        validateHost(host);
        const { frontmatter } = await readWorkflow(flags['workflow-path']);
        const subtask = (Array.isArray(frontmatter?.plan?.subtasks) ? frontmatter.plan.subtasks : [])
          .find((s) => s?.id === flags['subtask-id']);
        if (!subtask) throw new Error(`subtask id ${JSON.stringify(flags['subtask-id'])} not found in plan.subtasks[]`);
        const proposal = nextWorktreeProposal({
          repoRoot: flags['repo-root'], macroPath: flags['workflow-path'], macroId: basename(flags['workflow-path'], '.md'),
          subtaskId: subtask.id, branch: subtask.branch, baseline: frontmatter?.git_baseline?.branch, status: subtask.status, host,
        });
        if (flags.format === 'text') {
          process.stdout.write(`${worktreeProposalText(proposal)}\n`);
          return 0;
        }
        if (flags.format !== undefined) throw new Error(`--format takes text (got ${JSON.stringify(flags.format)})`);
        process.stdout.write(`${JSON.stringify(proposal)}\n`);
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
          requireOpen: cliPresenceFlag(flags, 'require-open'),
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

      case 'read': {
        cliRequire(flags, ['workflow-path']);
        const { frontmatter } = await readWorkflow(flags['workflow-path']);
        // ADR-0028 §Forward-compat (PR5 ported) — Symbol-keyed unknown
        // additive keys are invisible to JSON.stringify. The CLI `read`
        // output is a diagnostic projection (not a canonical round-trip
        // artifact; round-trip MUST go through parseWorkflowFile +
        // assembleWorkflowFile to preserve the Symbol carrier). Surface
        // the carrier under an underscored sibling key so an operator
        // inspecting the JSON sees future-minor unknowns without having
        // to import the Symbol.
        const unknowns = frontmatter[FORWARD_COMPAT_UNKNOWNS];
        const projection = Array.isArray(unknowns) && unknowns.length > 0
          ? { ...frontmatter, _forward_compat_unknowns: unknowns }
          : frontmatter;
        process.stdout.write(`${JSON.stringify(projection, null, 2)}\n`);
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
        const planResult = await setPlan({
          workflowPath: flags['workflow-path'],
          decision: flags.decision ?? null,
          architecture: flags.architecture ?? null,
          subtasks,
          host: flags.host,
          event: flags.event ?? 'updated',
          correct: cliPresenceFlag(flags, 'correct'),
          reason: await cliReasonFlag(flags),
          verdict: flags.verdict,
          // An empty --run-id is none: the runbook passes one on every verdict.
          runId: flags['run-id'] === '' ? undefined : flags['run-id'],
        });
        // stdout stays the workflow path (the runbooks read it); the
        // advisory goes to stderr.
        for (const w of planResult.warnings) process.stderr.write(`warning: ${w}\n`);
        if (planResult.allTerminal) {
          process.stderr.write(
            'plan-set: every subtask in the revised plan is terminal. setPlan does not close ' +
              'the macro; run /orchestrator:finalize to close it (ADR-0062 §Decision 5).\n',
          );
        }
        process.stdout.write(`${flags['workflow-path']}\n`);
        return 0;
      }

      // ADR-0019 PR-E §5 — macro lifecycle primitives. The three CLI
      // subcommands below are invoked by /orchestrator:finalize and
      // /orchestrator:abort runbooks via execFile spawn against this
      // state.mjs file. JSON envelope on stdout is the contract.

      case 'bulk-subtask-status': {
        cliRequire(flags, ['workflow-path', 'host', 'from-statuses', 'to-status']);
        const fromStatuses = flags['from-statuses']
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const result = await bulkSubtaskStatus({
          workflowPath: flags['workflow-path'],
          host: flags.host,
          fromStatuses,
          toStatus: flags['to-status'],
          event: flags.event ?? 'updated',
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return 0;
      }

      case 'set-terminal': {
        cliRequire(flags, ['workflow-path', 'host', 'terminal-phase']);
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
        await setMacroTerminal({
          workflowPath: flags['workflow-path'],
          host: flags.host,
          terminalPhase: flags['terminal-phase'],
          terminalMarker,
          nextAction: flags['next-action'],
          event: flags.event ?? 'updated',
          // ADR-0031 amendment — this is the /finalize + /abort production
          // completion surface; fire the activation sidecar.
          emitHandoff: true,
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
          // ADR-0031 amendment — this is the /done + /next production surface;
          // opt in. The sidecar fires only when this call's auto-terminal pass
          // promotes the macro to terminal (guarded inside updateSubtask).
          emitHandoff: true,
          // ADR-0062 §Decision 3. `--correct` is a presence flag. The reason is
          // prose, so runbooks pass it as a file (ADR-0059's direction) rather
          // than splicing it into argv.
          correct: cliPresenceFlag(flags, 'correct'),
          reason: await cliReasonFlag(flags),
          expectBranch: flags['expect-branch'],
          expectVerb: flags['expect-verb'],
          expectProfile: flags['expect-profile'],
          expectTopic: flags['expect-topic'],
          expectDispatch: flags['expect-dispatch'],
          waiveDispatch: cliPresenceFlag(flags, 'waive-dispatch'),
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
          if (result.noop) envelope.noop = true;
          envelope.skipReason = result.skipReason;
          // Also surface the diagnostic on stderr so shell callers
          // that don't parse JSON still see the suppression.
          process.stderr.write(`state.mjs subtask-update: ${result.skipReason}\n`);
        }
        process.stdout.write(`${JSON.stringify(envelope)}\n`);
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
        const enable = cliPresenceFlag(flags, 'enable');
        const disable = cliPresenceFlag(flags, 'disable');
        if (enable === disable) throw new Error('pass exactly one of --enable and --disable');
        let result;
        if (enable) {
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

      // ADR-0067 Decision 4, item 4 — the operator cutover's plan, move and
      // verify (scripts/lib/cutover.mjs).
      case 'cutover': {
        cliRequire(flags, ['repo-root']);
        const modes = ['plan', 'move', 'verify'].filter((m) => cliPresenceFlag(flags, m));
        if (modes.length !== 1) throw new Error('pass exactly one of --plan, --move and --verify');
        // A --repo-root left without its value would resolve to the working
        // directory and move records from there.
        if (flags['repo-root'] === '') throw new Error('--repo-root needs a value: the main checkout');
        const checkout = resolvePath(flags['repo-root']);
        const rollback = cliPresenceFlag(flags, 'rollback');
        if (rollback && modes[0] === 'verify') throw new Error('--rollback takes --plan or --move');
        let result;
        if (rollback && modes[0] === 'plan') result = await planRollback(checkout, { readWorkflow });
        else if (rollback) result = await moveRollback(checkout, { withFileLock, withDirectoryLock, readWorkflow });
        else if (modes[0] === 'plan') result = planCutover(checkout);
        else if (modes[0] === 'move') result = await moveCutover(checkout, { withFileLock, withDirectoryLock });
        else result = await verifyCutover(checkout, { resolveMacroById, findMacroBySubtaskBranch, readWorkflow, subtaskReadiness });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        if (!result.ok) {
          for (const r of result.refusals ?? []) process.stderr.write(`state.mjs cutover: ${r.code}: ${r.detail}\n`);
          for (const c of (result.checks ?? []).filter((x) => !x.ok)) process.stderr.write(`state.mjs cutover: ${c.id}: ${c.detail}\n`);
          return 1;
        }
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

// Run as a CLI only when this file is the entry point. Both sides are compared
// canonical and as paths, so an install reached through a symlink (with or
// without --preserve-symlinks-main), or under a directory whose name needs URL
// escaping (a space, '#', non-ASCII), still runs (ADR-0061 S2).
function invokedAsCli() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsCli()) {
  // Wrap cliMain in an async IIFE rather than awaiting it at top level.
  // Top-level await blocks circular dynamic imports performed inside cliMain
  // (the ADR-0031 activation sidecar in setMacroTerminal / updateSubtask
  // dynamically imports session-handoff.mjs, which re-imports from this file):
  // with top-level await pending, the inner dynamic import resolves to a Module
  // record whose state never settles, and Node emits "Detected unsettled
  // top-level await" before exiting with code 13. The IIFE keeps the dispatch
  // asynchronous without making it top-level.
  (async () => {
    // Set the exit code and let the process end on its own: process.exit()
    // drops whatever a piped stdout has not flushed, and a reader then got
    // exactly 65,536 bytes of a longer document (C70; Node's process.exit docs).
    process.exitCode = await cliMain(process.argv.slice(2));
  })();
}
