// ADR-0045 §2.1/§3 — the entry arbiter's bounded read layer (macro S7a).
//
// R0: reads only, consumes nothing — never touches projection lifecycles,
// markers, or any write path. A versioned, tolerant parser layer over the
// persona/orchestrator state homes plus the generic runtime sources. On any
// schema drift, parse failure, ambiguity (same-home duplicates, dual-home
// conflicts, ambiguous macro bridge), overflow, or unreadable directory it
// degrades to `indeterminate` instead of interpreting — mirroring the owners'
// fail-closed throws (engineer/orchestrator per-branch lookups) without
// throwing. ENOENT alone is the fail-open "no state" case; ENOTDIR (an
// ancestor that is a regular file) is corruption, not absence.
//
// Command-synthesis isolation starts HERE, not at the brief: no stored free
// text (original_request, next_action, current_phase, routing, checkpoint,
// topic, label, summary_line, branch strings from generic artifacts, raw
// status strings, …) ever crosses this reader's return values, and `reason`
// strings are fixed codes that never quote file content or file names. Only
// closed enums, pattern-validated identifiers, collision-resistant linkage
// tokens, booleans, timestamps, counts, and derived repo-relative pointers
// leave this module.
//
// Runtime-internal import only — the ADR-0010 §5 import ban is cross-plugin.
// This module must never import a `scripts/*.mjs` sibling (context.mjs will
// import it for the S7b arbiter — a reverse import is a cycle) and is
// spawn-free (the ADR-0035 executor guard's import-gate enforces it); lib→lib
// imports only.

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import {
  inspectSessionCaptureFileCore,
  sessionCaptureDir,
} from './session-capture-inspect.mjs';

export const ENTRY_READER_CAPS = Object.freeze({
  MAX_DIR_ENTRIES: 128,
  MAX_FILE_BYTES: 256 * 1024,
  MAX_HOME_TOTAL_BYTES: 2 * 1024 * 1024,
  HANDOFF_FRESHNESS_MS: 10 * 60 * 1000,
  FUTURE_SKEW_MS: 60 * 1000,
});

// Identifier families (ADR-0045 §4): one validator cannot cover both — the
// persona family is `<verb>-<timestamp>-<hex>`, macros are `macro-<verb>-…`.
export const PERSONA_WORKFLOW_ID_RE = /^(?!macro-)[a-z][a-z0-9-]*-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
export const MACRO_WORKFLOW_ID_RE = /^macro-[a-z][a-z0-9-]*-\d{8}T\d{6}Z-[0-9a-f]{6}$/;

// Schema tolerance mirrors the owners' own gates: persona state accepts the
// legacy UNQUOTED numeric 1 plus any "1.x" string (engineer state.mjs
// isSupportedSchema distinguishes the YAML number from the string '1', which
// it rejects); orchestrator accepts "1.x" strings only. Macro schema "1.0"
// parses but is NOT dispatch-actionable (the owner's next-ready refuses it) —
// the bridge carries that as a closed boolean.
const PERSONA_SCHEMA_STRING_RE = /^1\.(0|[1-9]\d*)$/;
const MACRO_SCHEMA_RE = /^1\.(0|[1-9]\d*)$/;
const SUBTASK_STATUSES = new Set(['pending', 'blocked', 'in_progress', 'completed', 'deferred', 'abandoned']);
const SUBTASK_TERMINAL_STATUSES = new Set(['completed', 'deferred', 'abandoned']);
const CONTEXT_RUN_ID_RE = /^context-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const CONSENSUS_RUN_ID_RE = /^consensus-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const CONSENSUS_TERMINAL_STATUSES = new Set(['cancelled', 'converged', 'owner-decided']);
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9._-]{1,128}$/;

// Storage homes (state-schema facts): engineer/orchestrator have a pre-ADR-0025
// legacy home under .claude/; founder (ADR-0036 SD5) and designer (ADR-0042
// SD7) are canonical-only — probing a legacy path their writers can never
// produce would invent a source that cannot exist.
const LEGACY_HOME_PERSONAS = new Set(['engineer', 'orchestrator']);

function personaHomes(repoRoot, persona) {
  const homes = [{ home: 'canonical', root: join(repoRoot, '.agentic-plugins', 'state', persona) }];
  if (LEGACY_HOME_PERSONAS.has(persona)) {
    homes.push({ home: 'legacy', root: join(repoRoot, '.claude', `agentic-${persona}`) });
  }
  return homes;
}

function toPointer(repoRoot, path) {
  return relative(repoRoot, path).split(sep).join('/');
}

// Linkage token for free-string identifiers (macro subtask ids, originating
// subtask): equality-preserving and collision-resistant. A value already in
// the safe-identifier alphabet passes through verbatim; anything else becomes
// a sha256-derived token. Distinct owner-valid ids can NEVER collide (a lossy
// character-replacement sanitizer could — codex review MAJOR), and hostile
// free text can never ride through as prose. Matching consumers apply the
// same function to both sides.
export function linkageToken(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (SAFE_IDENTIFIER_RE.test(value)) return value;
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function parseIsoMs(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Fixed-code reasons only: a reason never quotes file content, scalar values,
// or file names — the reader's isolation boundary covers its own diagnostics
// (codex review MAJOR: schema text was previously copied into reasons).
function indeterminate(extra, reason) {
  return { ...extra, status: 'indeterminate', reason };
}

// --- bounded low-level reads -----------------------------------------------

// Handle-based atomic read (codex review MAJOR — the previous lstat→readFile
// pair was TOCTOU-prone): O_NOFOLLOW refuses a symlinked FINAL component at
// open time, O_NONBLOCK keeps a repo-controlled FIFO from blocking the open,
// fstat on the handle re-checks type/size on the same inode, and the read is
// capped through the same handle. Ancestor symlinks remain accepted, matching
// the session-capture read-path contract (only its WRITE path walks the
// ancestor chain).
async function readBoundedFile(filePath, maxBytes) {
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    const code = error?.code ?? 'unknown';
    if (code === 'ENOENT') return { state: 'absent' };
    if (code === 'ELOOP' || code === 'EMLINK') return { state: 'refused', reason: 'symlink-refused' };
    if (code === 'ENOTDIR') return { state: 'refused', reason: 'ancestor-not-a-directory' };
    return { state: 'refused', reason: 'open-failed' };
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { state: 'refused', reason: 'not-a-regular-file' };
    if (st.size > maxBytes) return { state: 'refused', reason: 'over-read-bound' };
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) return { state: 'refused', reason: 'grew-past-read-bound' };
    return { state: 'ok', text: buffer.subarray(0, bytesRead).toString('utf8'), mtimeMs: st.mtimeMs, bytes: bytesRead };
  } catch {
    return { state: 'refused', reason: 'read-failed' };
  } finally {
    await handle.close().catch(() => {});
  }
}

// Early-terminating directory scan (codex review MAJOR — a plain readdir
// materializes the whole listing before the cap can judge it).
async function listBoundedDir(dir, caps) {
  let handle;
  try {
    handle = await opendir(dir);
  } catch (error) {
    const code = error?.code ?? 'unknown';
    if (code === 'ENOENT') return { state: 'absent', entries: [] };
    if (code === 'ENOTDIR') return { state: 'refused', reason: 'not-a-directory' };
    return { state: 'refused', reason: 'unreadable-directory' };
  }
  const entries = [];
  try {
    for await (const entry of handle) {
      entries.push(entry);
      if (entries.length > caps.MAX_DIR_ENTRIES) return { state: 'overflow', reason: 'scan-overflow' };
    }
  } catch {
    return { state: 'refused', reason: 'directory-iteration-failed' };
  }
  return { state: 'ok', entries };
}

// --- tolerant frontmatter parsing ------------------------------------------

// CRLF-tolerant by construction (state files may be Windows-edited): split on
// \r?\n and scan lines. Returns null when no frontmatter block terminates.
function splitFrontmatterLines(text) {
  const lines = String(text).split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  return lines.slice(1, end);
}

// Scalar token: { value, quoted } — or null when the raw text cannot be
// decoded. Owner writers serialize strings via JSON.stringify, so a
// double-quoted scalar is JSON-decoded (escaped quotes round-trip — codex
// review MAJOR: naive quote-stripping missed `feat/"q"` branches). Quoting is
// preserved so type-sensitive fields (legacy numeric schema 1, boolean
// terminal_marker) can tell the YAML string "true" from the YAML boolean.
function decodeScalar(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    try {
      const value = JSON.parse(trimmed);
      return typeof value === 'string' ? { value, quoted: true } : null;
    } catch {
      return null;
    }
  }
  const single = /^'(.*)'$/.exec(trimmed);
  if (single) return { value: single[1].replace(/''/g, "'"), quoted: true };
  return { value: trimmed, quoted: false };
}

// null = key absent; { invalid: true } = present but undecodable.
function topLevelScalar(lines, key) {
  for (const line of lines) {
    if (!line.startsWith(`${key}:`)) continue;
    const token = decodeScalar(line.slice(key.length + 1));
    return token ?? { invalid: true };
  }
  return null;
}

function gitBaselineBranch(lines) {
  const start = lines.findIndex((line) => /^git_baseline:\s*$/.test(line));
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s{2}/.test(line)) break;
    const m = /^\s{2}branch:\s*(.*)$/.exec(line);
    if (m) {
      const token = decodeScalar(m[1]);
      return token ?? { invalid: true };
    }
  }
  return null;
}

// Tri-state boolean scalar: true/false only when UNQUOTED (the owners emit
// YAML booleans and throw on non-boolean values); absent → null; anything
// else (quoted "true", junk) → { invalid: true } so callers degrade.
function booleanScalar(lines, key) {
  const token = topLevelScalar(lines, key);
  if (token === null) return { value: null };
  if (token.invalid || token.quoted) return { invalid: true };
  if (token.value === 'true') return { value: true };
  if (token.value === 'false') return { value: false };
  return { invalid: true };
}

function personaSchemaSupported(token) {
  if (!token || token.invalid) return false;
  if (!token.quoted && token.value === '1') return true; // legacy YAML number
  return PERSONA_SCHEMA_STRING_RE.test(token.value);
}

// Line-oriented macro subtask scanner (dashboard parseMacroSubtasks shape,
// extended): extracts only linkage/ordering facts — id, branch, status,
// blocked_by, engineer_workflow_id — and fails closed ({ ok: false }) on any
// malformed field instead of defaulting it (codex review MAJOR: a malformed
// blocked_by previously became [] and could misreport readiness=ready).
// Free-text fields (label, topic, …) are deliberately never read.
function parseMacroSubtasks(lines) {
  const planStart = lines.findIndex((line) => /^plan:\s*$/.test(line));
  if (planStart < 0) return { ok: true, subtasks: [] };
  const subtasks = [];
  let inSubtasks = false;
  let current = null;
  for (let i = planStart + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // next top-level key ends the plan block
    if (/^\s{2}subtasks:\s*$/.test(line)) {
      inSubtasks = true;
      continue;
    }
    if (!inSubtasks) continue;
    const idM = /^\s{4}-\s+id:\s*(.*)$/.exec(line);
    if (idM) {
      const token = decodeScalar(idM[1]);
      if (!token || token.value.length === 0) return { ok: false };
      current = { id: token.value, branch: null, status: null, blocked_by: null, engineer_workflow_id: null };
      subtasks.push(current);
      continue;
    }
    if (!current) continue;
    const fieldM = /^\s{6}([a-z_]+):\s*(.*)$/.exec(line);
    if (!fieldM) continue;
    const [, key, rawValue] = fieldM;
    if (key === 'branch' || key === 'status' || key === 'engineer_workflow_id') {
      const token = decodeScalar(rawValue);
      if (!token) return { ok: false };
      current[key] = token.value;
    } else if (key === 'blocked_by') {
      const listM = /^\[(.*)\]$/.exec(rawValue.trim());
      if (!listM) return { ok: false };
      const deps = [];
      const inner = listM[1].trim();
      if (inner.length > 0) {
        for (const part of inner.split(',')) {
          const token = decodeScalar(part);
          if (!token || token.value.length === 0) return { ok: false };
          deps.push(token.value);
        }
      }
      current.blocked_by = deps;
    }
  }
  for (const st of subtasks) {
    if (st.status === null || !SUBTASK_STATUSES.has(st.status)) return { ok: false };
    if (st.blocked_by === null) return { ok: false };
    if (st.branch === null) return { ok: false };
  }
  return { ok: true, subtasks };
}

// --- persona workflow source (engineer / founder / designer) ---------------

export async function readPersonaWorkflowSource({ repoRoot, persona, branch, caps = ENTRY_READER_CAPS }) {
  const base = { source: 'persona-workflow', persona };
  const matchesByHome = [];
  for (const { home, root } of personaHomes(repoRoot, persona)) {
    const dir = join(root, 'workflows');
    const listing = await listBoundedDir(dir, caps);
    if (listing.state === 'absent') {
      matchesByHome.push({ home, matches: [] });
      continue;
    }
    if (listing.state !== 'ok') return indeterminate(base, listing.reason);
    const matches = [];
    let homeBytes = 0;
    for (const entry of listing.entries) {
      if (!entry.name.endsWith('.md')) continue;
      const path = join(dir, entry.name);
      const file = await readBoundedFile(path, caps.MAX_FILE_BYTES);
      if (file.state !== 'ok') {
        // A workflow file we cannot read might be the active one on this
        // branch — the owners throw here; we degrade (fail-closed mirror).
        return indeterminate(base, file.reason ?? 'workflow-file-vanished');
      }
      homeBytes += file.bytes;
      if (homeBytes > caps.MAX_HOME_TOTAL_BYTES) return indeterminate(base, 'read-budget-exceeded');
      const lines = splitFrontmatterLines(file.text);
      if (!lines) return indeterminate(base, 'unparseable-workflow-frontmatter');
      // Branch classification FIRST (owner parity — codex review MINOR): a
      // cross-branch file with schema drift must not poison this branch's
      // source; only a file whose branch cannot be established degrades.
      const branchToken = gitBaselineBranch(lines);
      if (branchToken === null || branchToken.invalid) return indeterminate(base, 'missing-workflow-branch');
      if (branchToken.value !== branch) continue;
      const schemaToken = topLevelScalar(lines, 'schema');
      if (!personaSchemaSupported(schemaToken)) return indeterminate(base, 'unsupported-workflow-schema');
      const terminal = booleanScalar(lines, 'terminal_marker');
      if (terminal.invalid) return indeterminate(base, 'invalid-terminal-marker');
      const detached = booleanScalar(lines, 'parent_detached');
      if (detached.invalid) return indeterminate(base, 'invalid-parent-detached');
      const idToken = topLevelScalar(lines, 'workflow_id');
      const idValue = idToken && !idToken.invalid ? idToken.value : null;
      const idValid = idValue !== null && PERSONA_WORKFLOW_ID_RE.test(idValue);
      const parentToken = topLevelScalar(lines, 'parent_workflow');
      const parentValue = parentToken && !parentToken.invalid ? parentToken.value : null;
      const subToken = topLevelScalar(lines, 'originating_subtask');
      const updatedToken = topLevelScalar(lines, 'updated_at');
      matches.push({
        workflow_id: idValid ? idValue : null,
        workflow_id_valid: idValid,
        branch: branchToken.value,
        terminal_marker: terminal.value,
        parent_workflow: parentValue !== null && MACRO_WORKFLOW_ID_RE.test(parentValue) ? parentValue : null,
        // Closed boolean the §5.1 linked-child validation needs (codex review
        // MAJOR): a detached child must be distinguishable from a linked one.
        parent_detached: detached.value,
        originating_subtask: subToken && !subToken.invalid ? linkageToken(subToken.value) : null,
        updated_at_ms: updatedToken && !updatedToken.invalid ? parseIsoMs(updatedToken.value) : null,
        pointer: toPointer(repoRoot, path),
      });
    }
    matchesByHome.push({ home, matches });
  }
  for (const { matches } of matchesByHome) {
    if (matches.length > 1) return indeterminate(base, 'duplicate-active-workflows');
  }
  const nonEmpty = matchesByHome.filter(({ matches }) => matches.length > 0);
  if (nonEmpty.length > 1) return indeterminate(base, 'dual-home-ambiguity');
  return { ...base, status: 'ok', reason: null, active: nonEmpty.length === 1 ? nonEmpty[0].matches[0] : null };
}

// --- orchestrator macro sources (own-branch active + subtask-branch bridge) --

export function deriveMacroReadiness(subtasks) {
  if (!Array.isArray(subtasks) || subtasks.length === 0) return 'empty_plan';
  const completed = new Set(subtasks.filter((st) => st.status === 'completed').map((st) => st.id));
  if (subtasks.every((st) => SUBTASK_TERMINAL_STATUSES.has(st.status))) return 'all_terminal';
  const anyReady = subtasks.some(
    (st) => st.status === 'pending' && st.blocked_by.every((dep) => completed.has(dep)),
  );
  return anyReady ? 'ready' : 'in_progress_or_blocked';
}

export async function readMacroSources({ repoRoot, branch, caps = ENTRY_READER_CAPS }) {
  const base = { source: 'macro' };
  const activeMatches = [];
  const bridgeMatches = [];
  for (const { root } of personaHomes(repoRoot, 'orchestrator')) {
    const dir = join(root, 'workflows'); // archive/ is deliberately not scanned (owner parity)
    const listing = await listBoundedDir(dir, caps);
    if (listing.state === 'absent') continue;
    if (listing.state !== 'ok') return indeterminate(base, listing.reason);
    let homeBytes = 0;
    for (const entry of listing.entries) {
      if (!entry.name.endsWith('.md')) continue;
      const path = join(dir, entry.name);
      const file = await readBoundedFile(path, caps.MAX_FILE_BYTES);
      if (file.state !== 'ok') return indeterminate(base, file.reason ?? 'workflow-file-vanished');
      homeBytes += file.bytes;
      if (homeBytes > caps.MAX_HOME_TOTAL_BYTES) return indeterminate(base, 'read-budget-exceeded');
      const lines = splitFrontmatterLines(file.text);
      // A corrupt file in the macro home could BE the matching macro — the
      // owner's findMacroBySubtaskBranch throws here (fail-closed); mirror it.
      if (!lines) return indeterminate(base, 'unparseable-workflow-frontmatter');
      const typeToken = topLevelScalar(lines, 'workflow_type');
      if (typeToken === null) continue; // persona-shaped file — not a macro
      if (typeToken.invalid) return indeterminate(base, 'invalid-workflow-type');
      if (typeToken.value !== 'macro') continue;
      const schemaToken = topLevelScalar(lines, 'schema');
      if (!schemaToken || schemaToken.invalid || !MACRO_SCHEMA_RE.test(schemaToken.value)) {
        return indeterminate(base, 'unsupported-macro-schema');
      }
      // Schema "1.0" parses but the owner's next-ready refuses to dispatch it
      // (codex review MAJOR): carry actionability as a closed boolean so the
      // arbiter never synthesizes a command guaranteed to fail.
      const schemaActionable = schemaToken.value !== '1.0';
      const terminal = booleanScalar(lines, 'terminal_marker');
      if (terminal.invalid) return indeterminate(base, 'invalid-terminal-marker');
      const idToken = topLevelScalar(lines, 'workflow_id');
      const idValue = idToken && !idToken.invalid ? idToken.value : null;
      const idValid = idValue !== null && MACRO_WORKFLOW_ID_RE.test(idValue);
      const parsed = parseMacroSubtasks(lines);
      if (!parsed.ok) return indeterminate(base, 'malformed-macro-subtasks');
      const updatedToken = topLevelScalar(lines, 'updated_at');
      const summary = {
        workflow_id: idValid ? idValue : null,
        workflow_id_valid: idValid,
        terminal_marker: terminal.value,
        updated_at_ms: updatedToken && !updatedToken.invalid ? parseIsoMs(updatedToken.value) : null,
        pointer: toPointer(repoRoot, path),
      };
      const branchToken = gitBaselineBranch(lines);
      if (branchToken === null || branchToken.invalid) return indeterminate(base, 'missing-workflow-branch');
      if (branchToken.value === branch) activeMatches.push(summary);
      const matchingSubtasks = parsed.subtasks.filter((st) => st.branch === branch);
      if (matchingSubtasks.length > 0) {
        bridgeMatches.push({
          macro_id: summary.workflow_id,
          macro_id_valid: summary.workflow_id_valid,
          pointer: summary.pointer,
          readiness: deriveMacroReadiness(parsed.subtasks),
          schema_actionable: schemaActionable,
          subtask_matches: matchingSubtasks,
        });
      }
    }
  }
  if (activeMatches.length > 1) return indeterminate(base, 'duplicate-active-macros');
  if (bridgeMatches.length > 1) return indeterminate(base, 'ambiguous-macro-bridge');
  let bridge = null;
  if (bridgeMatches.length === 1) {
    const match = bridgeMatches[0];
    if (match.subtask_matches.length > 1) return indeterminate(base, 'ambiguous-macro-bridge');
    const st = match.subtask_matches[0];
    bridge = {
      macro_id: match.macro_id,
      macro_id_valid: match.macro_id_valid,
      pointer: match.pointer,
      readiness: match.readiness,
      schema_actionable: match.schema_actionable,
      subtask: {
        id: linkageToken(st.id),
        status: st.status,
        engineer_workflow_id: st.engineer_workflow_id !== null && PERSONA_WORKFLOW_ID_RE.test(st.engineer_workflow_id)
          ? st.engineer_workflow_id
          : null,
      },
    };
  }
  return {
    ...base,
    status: 'ok',
    reason: null,
    active_on_branch: activeMatches.length === 1 ? activeMatches[0] : null,
    bridge,
  };
}

// --- persona handoff slots (dual-anchor, marker matrix) ---------------------

// Marker filename shape per persona — the ADR-0043 §2 cross-package contract
// (attention's sensor mirrors the same table): engineer/founder/designer key
// one marker per slot; orchestrator bakes the workflow id into the filename.
function markerFileFor(persona, projectionPath, workflowId) {
  if (persona === 'orchestrator') {
    const safe = String(workflowId ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'unknown';
    return `${projectionPath}.${safe}.footer-rendered`;
  }
  return `${projectionPath}.footer-rendered`;
}

function withinFreshClass(ageMs, caps) {
  return ageMs <= caps.HANDOFF_FRESHNESS_MS && ageMs >= -caps.FUTURE_SKEW_MS;
}

export async function readHandoffSlotSource({ repoRoot, persona, nowMs, caps = ENTRY_READER_CAPS }) {
  const base = { source: 'handoff-slot', persona };
  // First existing candidate wins (sensor parity): when both homes hold a
  // slot the repo is already inconsistent — never trust the shadowed second.
  let projectionPath = null;
  let file = null;
  for (const { root } of personaHomes(repoRoot, persona)) {
    const candidate = join(root, 'last-session-handoff.json');
    const read = await readBoundedFile(candidate, caps.MAX_FILE_BYTES);
    if (read.state === 'absent') continue;
    projectionPath = candidate;
    file = read;
    break;
  }
  if (!file) return { ...base, status: 'absent', reason: null };
  if (file.state !== 'ok') return indeterminate(base, file.reason);
  let projection;
  try {
    projection = JSON.parse(file.text);
  } catch {
    return indeterminate(base, 'slot-not-json');
  }
  if (!isPlainObject(projection)) return indeterminate(base, 'slot-not-an-object');
  // The slot in a persona's home must belong to that persona (codex review
  // MINOR: an engineer-home slot claiming workflow_kind founder is corrupt,
  // not a founder handoff).
  if (projection.workflow_kind !== persona) return indeterminate(base, 'slot-kind-mismatch');
  const idRe = persona === 'orchestrator' ? MACRO_WORKFLOW_ID_RE : PERSONA_WORKFLOW_ID_RE;
  const rawId = projection.workflow_id;
  const workflowId = typeof rawId === 'string' && idRe.test(rawId) ? rawId : null;

  const mtimeAge = nowMs - file.mtimeMs;
  const mtimeFresh = withinFreshClass(mtimeAge, caps);

  // Marker matrix (ADR-0045 §3.3): rendered(matching) → surfaced; absent /
  // claimed / mismatched → pending. A marker we cannot read or cannot
  // interpret is corruption → indeterminate (fail-closed), never "pending".
  let marker = 'absent';
  let markerAtMs = null;
  const markerRead = await readBoundedFile(markerFileFor(persona, projectionPath, rawId), caps.MAX_FILE_BYTES);
  if (markerRead.state === 'refused') return indeterminate(base, 'marker-unreadable');
  if (markerRead.state === 'ok') {
    let parsed;
    try {
      parsed = JSON.parse(markerRead.text);
    } catch {
      return indeterminate(base, 'marker-malformed');
    }
    if (!isPlainObject(parsed)) return indeterminate(base, 'marker-malformed');
    if (parsed.workflow_id !== rawId) marker = 'mismatched';
    else if (parsed.status === 'claimed') marker = 'claimed';
    else if (parsed.status === 'rendered') {
      // Sensor parity: the render instant must be strict ISO-UTC — a
      // permissive Date.parse would accept locale junk as an anchor.
      if (typeof parsed.at !== 'string' || !ISO_UTC_RE.test(parsed.at)) return indeterminate(base, 'marker-malformed');
      marker = 'rendered';
      markerAtMs = Date.parse(parsed.at);
    } else {
      return indeterminate(base, 'marker-malformed');
    }
  }

  // Dual-anchor freshness (sensor parity): the projection mtime always
  // anchors; a rendered marker adds its `at` as the second anchor because
  // Stop-path snapshots keep refreshing mtime while `at` moves once per
  // terminal transition. Non-rendered markers leave the slot on the single
  // mtime anchor — a pending handoff has no render instant yet (deliberate
  // divergence from the sensor, which returns null on a missing marker: its
  // job is transition-edge enrichment, this reader's is row visibility).
  let fresh = mtimeFresh;
  if (marker === 'rendered') {
    fresh = fresh && markerAtMs !== null && withinFreshClass(nowMs - markerAtMs, caps);
  }

  return {
    ...base,
    status: 'ok',
    reason: null,
    fresh,
    label: marker === 'rendered' ? 'surfaced' : 'pending',
    marker,
    marker_at_ms: markerAtMs,
    projection_mtime_ms: file.mtimeMs,
    workflow_id: workflowId,
    workflow_kind: persona,
    pointer: toPointer(repoRoot, projectionPath),
  };
}

// --- ADR-0044 entry.json (validate-or-skip, branch-checkable) ---------------

export async function readEntryCaptureSource({ repoRoot, branch }) {
  const base = { source: 'entry-capture' };
  const core = await inspectSessionCaptureFileCore({
    dir: sessionCaptureDir(repoRoot),
    fileName: 'entry.json',
    family: 'runtime-session-entry',
  });
  if (core.state === 'absent') return { ...base, status: 'absent', reason: null };
  if (core.state !== 'valid') return { ...base, status: 'invalid', reason: 'entry-validation-failed' };
  const doc = core.document;
  // branch_matches only — the stored branch string itself is free text and
  // never crosses the reader (codex review MAJOR); summary_source and host
  // are schema-enforced closed enums.
  return {
    ...base,
    status: 'ok',
    reason: null,
    branch_matches: typeof branch === 'string' && branch.length > 0 && doc.branch !== null ? doc.branch === branch : null,
    captured_at_ms: parseIsoMs(doc.captured_at),
    note_staged_at_ms: parseIsoMs(doc.note_staged_at),
    summary_source: doc.summary_source,
    host: doc.host,
  };
}

// --- row-only ledgers (latest context artifact, latest open consensus) ------

async function selectLatestRun({ repoRoot, family, runIdRe, fileName, nowMs, caps, classify }) {
  const root = join(repoRoot, '.agentic-plugins', 'runs', family);
  const listing = await listBoundedDir(root, caps);
  if (listing.state === 'absent') return { state: 'absent' };
  if (listing.state !== 'ok') return { state: 'refused', reason: listing.reason };
  let selected = null;
  let skippedInvalid = 0;
  let skippedTerminal = 0;
  let sawRun = false;
  for (const entry of listing.entries) {
    if (!entry.isDirectory() || !runIdRe.test(entry.name)) continue;
    sawRun = true;
    const read = await readBoundedFile(join(root, entry.name, fileName), caps.MAX_FILE_BYTES);
    if (read.state !== 'ok') {
      skippedInvalid++;
      continue;
    }
    let doc;
    try {
      doc = JSON.parse(read.text);
    } catch {
      skippedInvalid++;
      continue;
    }
    // Plain-object gate inside the per-entry failure boundary (codex review
    // MAJOR: a literal-null document previously threw and aborted the whole
    // collection).
    if (!isPlainObject(doc)) {
      skippedInvalid++;
      continue;
    }
    const verdict = classify(entry.name, doc);
    if (verdict === 'invalid') {
      skippedInvalid++;
      continue;
    }
    if (verdict === 'terminal') {
      skippedTerminal++;
      continue;
    }
    const timestampMs = runTimestampMs(doc, entry.name);
    if (timestampMs === null) {
      skippedInvalid++;
      continue;
    }
    // Uniform future-skew bound (ADR-0045 §3): a far-future timestamp must
    // not win the latest slot and shadow the real latest row.
    if (timestampMs - nowMs > ENTRY_READER_CAPS.FUTURE_SKEW_MS) {
      skippedInvalid++;
      continue;
    }
    // Deterministic selection (ADR-0045 §11): newest timestamp wins; equal
    // timestamps resolve by lexicographic run-id — unlike the existing
    // latest-open selector, enumeration order never decides.
    if (!selected || timestampMs > selected.timestampMs
      || (timestampMs === selected.timestampMs && entry.name > selected.runId)) {
      selected = { runId: entry.name, timestampMs };
    }
  }
  if (!sawRun && skippedInvalid === 0) return { state: 'absent' };
  return { state: 'ok', selected, skippedInvalid, skippedTerminal };
}

function runTimestampMs(doc, runId) {
  for (const value of [doc.updated_at, doc.created_at]) {
    const ms = parseIsoMs(value);
    if (ms !== null) return ms;
  }
  const m = /^(?:context|consensus)-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{6}$/.exec(runId);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  return Number.isFinite(ms) ? ms : null;
}

export async function readContextLedgerSource({ repoRoot, nowMs = Date.now(), caps = ENTRY_READER_CAPS }) {
  const base = { source: 'context-ledger' };
  const result = await selectLatestRun({
    repoRoot,
    family: 'context',
    runIdRe: CONTEXT_RUN_ID_RE,
    fileName: 'context.json',
    nowMs,
    caps,
    classify: () => 'open',
  });
  if (result.state === 'absent') return { ...base, status: 'absent', reason: null };
  if (result.state !== 'ok') return indeterminate(base, result.reason);
  return {
    ...base,
    status: 'ok',
    reason: null,
    latest: result.selected ? { run_id: result.selected.runId, updated_at_ms: result.selected.timestampMs } : null,
    skipped_invalid: result.skippedInvalid,
  };
}

export async function readOpenConsensusSource({ repoRoot, nowMs = Date.now(), caps = ENTRY_READER_CAPS }) {
  const base = { source: 'consensus-open' };
  const result = await selectLatestRun({
    repoRoot,
    family: 'consensus',
    runIdRe: CONSENSUS_RUN_ID_RE,
    fileName: 'manifest.json',
    nowMs,
    caps,
    classify: (runId, manifest) => {
      if (manifest.run_id !== runId) return 'invalid';
      if (typeof manifest.status !== 'string') return 'invalid';
      // Open = no terminal pointer recorded AND status outside the terminal
      // set (consensus.mjs isOpenConsensusManifest parity — pointer
      // truthiness, not presence).
      if (manifest.cancellation_pointer || manifest.owner_decision_pointer || manifest.ratification_pointer) return 'terminal';
      if (CONSENSUS_TERMINAL_STATUSES.has(manifest.status)) return 'terminal';
      return 'open';
    },
  });
  if (result.state === 'absent') return { ...base, status: 'absent', reason: null };
  if (result.state !== 'ok') return indeterminate(base, result.reason);
  // run_id + age only — a non-terminal manifest status is an open free-string
  // set and never crosses the reader (codex review MAJOR).
  return {
    ...base,
    status: 'ok',
    reason: null,
    latest_open: result.selected ? { run_id: result.selected.runId, updated_at_ms: result.selected.timestampMs } : null,
    skipped_invalid: result.skippedInvalid,
    skipped_terminal: result.skippedTerminal,
  };
}

// --- orchestration ----------------------------------------------------------

const PERSONA_SOURCES = Object.freeze(['engineer', 'founder', 'designer']);
const SLOT_PERSONAS = Object.freeze(['engineer', 'orchestrator', 'founder', 'designer']);

// `branchProbe` is REQUIRED, never defaulted: this reader is a spawn-free R0
// filesystem leaf (the ADR-0035 executor guard's import-gate enforces that no
// unregistered lib module reaches for node:child_process). The consuming
// surface owns the git observation — the S7b arbiter threads its existing
// bounded probe (source-snapshot's git facts) in, exactly like the sensor
// threads `--host claude`. Contract: resolve a branch name string, '' for
// detached HEAD, or null when git is unavailable; a rejection is treated as
// null (degrade, never escape). A missing probe is a wiring bug and throws.
export async function collectEntrySources({ repoRoot, branchProbe, now = Date.now(), caps = ENTRY_READER_CAPS }) {
  if (typeof branchProbe !== 'function') {
    throw new TypeError('collectEntrySources requires an explicit branchProbe function (spawn-free reader — the caller owns git observation)');
  }
  const nowMs = now instanceof Date ? now.getTime() : now;
  const probe = async () => {
    try {
      const value = await branchProbe(repoRoot);
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  };
  const initial = await probe();
  const branch = typeof initial === 'string' && initial.length > 0 ? initial : null;

  const personas = {};
  for (const persona of PERSONA_SOURCES) {
    personas[persona] = branch
      ? await readPersonaWorkflowSource({ repoRoot, persona, branch, caps })
      : { source: 'persona-workflow', persona, status: 'no-branch', reason: null };
  }
  const macro = branch
    ? await readMacroSources({ repoRoot, branch, caps })
    : { source: 'macro', status: 'no-branch', reason: null };

  const handoffSlots = {};
  for (const persona of SLOT_PERSONAS) {
    handoffSlots[persona] = await readHandoffSlotSource({ repoRoot, persona, nowMs, caps });
  }
  const entryCapture = await readEntryCaptureSource({ repoRoot, branch });
  const contextLedger = await readContextLedgerSource({ repoRoot, nowMs, caps });
  const consensusOpen = await readOpenConsensusSource({ repoRoot, nowMs, caps });

  // Branch re-check after reads (ADR-0045 §3): a branch switch mid-scan makes
  // every per-branch fact unattributable — report the instability instead of
  // letting the arbiter emit cross-branch guidance.
  const final = await probe();
  const sources = {
    personas,
    macro,
    handoff_slots: handoffSlots,
    entry_capture: entryCapture,
    context_ledger: contextLedger,
    consensus_open: consensusOpen,
  };
  let skipped = 0;
  for (const value of [...Object.values(personas), macro, ...Object.values(handoffSlots), entryCapture, contextLedger, consensusOpen]) {
    if (value.status === 'indeterminate' || value.status === 'invalid') skipped++;
  }
  return {
    branch: {
      initial: branch,
      final: typeof final === 'string' && final.length > 0 ? final : null,
      stable: initial === final,
      state: initial === null ? 'unavailable' : initial === '' ? 'detached' : 'branch',
    },
    git_available: initial !== null,
    now_ms: nowMs,
    sources,
    sources_skipped: skipped,
  };
}
