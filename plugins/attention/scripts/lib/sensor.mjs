// plugins/attention/scripts/lib/sensor.mjs
//
// Shared sensor library for the ADR-0040 §3 attention hook sensors
// (Notification / Stop / SubagentStop). Three responsibilities:
//
//   1. The ADR-0040 §1 event-contract derivations the sensors need to BUILD
//      events — repo-ident, event_id composition, kind/subject mapping. These
//      are COPY-NOT-IMPORT siblings of the canonical runtime contract lib
//      (plugins/runtime/scripts/lib/notify-schema.mjs, ADR-0010 §5 — attention
//      cannot import a runtime module without breaking SemVer independence).
//      The copies must stay behaviorally identical: two producers observing
//      the same subject moment must build byte-identical event_ids, and the
//      emitter's validateEvent cross-checks the id segments against the same
//      composition rules. tests/plugin-shape/test-attention-plugin.mjs holds
//      the parity gate against the canonical lib.
//
//   2. The §3 state-enrichment read: a freshness-checked
//      `last-session-handoff.json` projection read (workflow-id consistency +
//      mtime bound + the per-persona `.footer-rendered` marker). Sensors are
//      self-contained observers — Claude fires all plugins' Stop hooks with no
//      ordering guarantee, so a sensor never assumes a persona Stop hook ran
//      first; a stale or missing projection degrades to a bare notification,
//      never a wrong one.
//
//   3. The emit seam: resolve the runtime root via the copied
//      discover-runtime.mjs (ADR-0039 §5 ladder, MIN_RUNTIME_VERSION-gated)
//      and shell out to `notify.mjs emit` with the event JSON on stdin.
//
// Fail-closed contract (ADR-0040 §7): every function here returns null /
// a result object instead of surfacing failures; nothing in this module
// writes to stdout (hook stdout is a decision channel the sensors must
// never touch) or throws for environmental conditions. Throws are reserved
// for producer programming errors (bad kind, missing status on a
// status-bearing kind) and are caught by each hook's outer try/catch.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { discoverRuntimePluginRoot } from '../discover-runtime.mjs';

// ── ADR-0040 §1 contract copies (canonical: runtime lib/notify-schema.mjs) ──

// The §1 kind enum. Order is contractual documentation, not priority.
export const NOTIFY_KINDS = Object.freeze([
  'approval',
  'idle',
  'turn-complete',
  'subagent-complete',
  'workflow-terminal',
  'peer-run-terminal',
  'health',
]);

// Fixed status token for kinds without a natural terminal status.
export const DEFAULT_STATUS_TOKEN = 'fired';

// The ONLY kinds the default token applies to (ADR-0040 §1). Every other kind
// carries a real status moment; an absent status there is a producer bug.
export const KINDS_WITH_DEFAULT_STATUS = Object.freeze([
  'approval',
  'idle',
  'turn-complete',
]);

// ADR-0041 §4 cross-machine routing/display fields — OPTIONAL, backward-
// compatible schema extensions. COPY-NOT-IMPORT siblings of the canonical
// runtime lib (parity-gated). Caps bound what a later egress channel may
// transmit; sensor events are born capped in buildEvent.
export const OPTIONAL_ROUTING_FIELDS = Object.freeze(['hostname', 'topic', 'session_hint']);
export const ROUTING_FIELD_CAPS = Object.freeze({
  hostname: 64,
  topic: 120,
  session_hint: 32,
});

// Attention's fixed status tokens for its status-bearing kinds. The sensor
// observes exactly one status moment per kind — the workflow reached terminal,
// the subagent stopped — so a deterministic fixed token keeps the dedupe key
// stable across re-observations of the same moment (attention is the only
// producer of these kinds; self-consistency is the contract requirement).
export const WORKFLOW_TERMINAL_STATUS = 'terminal';
export const SUBAGENT_COMPLETE_STATUS = 'completed';

// §1 event schema `source` for every event this plugin emits (display/filter
// metadata only — deliberately excluded from the dedupe key).
export const EVENT_SOURCE = 'attention-claude';

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function shortHash(text, length) {
  return createHash('sha256').update(text).digest('hex').slice(0, length);
}

// Repo identity for the event_id's first segment. Deterministic per repo:
// realpath-normalized so symlinked/trailing-slash spellings of one repo
// converge, hashed so two repos with the same basename cannot collide, and
// colon-free so the segment boundary stays parseable.
export function deriveRepoIdent(repoRoot) {
  requireNonEmptyString(repoRoot, 'repoRoot');
  const resolved = path.resolve(repoRoot);
  let real = resolved;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    // Nonexistent path (fixtures, dry planning) — resolve-only is still
    // deterministic for a given spelling.
  }
  const base = path.basename(real).replace(/[^A-Za-z0-9._-]/g, '-') || 'repo';
  return `${base}-${shortHash(real, 16)}`;
}

// ADR-0041 §4 — derive a FIXED-LENGTH, colon-free host-hash token for weaving
// into the event_id/dedupe key. COPY-NOT-IMPORT sibling of the canonical lib;
// must stay behaviorally identical (parity-gated). The short hash bounds the id
// growth to ~21 chars regardless of hostname length (a long hostname can never
// overflow the emitter's 256-char cap); the readable hostname rides in the
// top-level event.hostname field. Returns null when hostname is absent or
// sanitizes to empty — the id then stays byte-identical to the pre-ADR-0041
// format.
function hostSegment(hostname) {
  if (typeof hostname !== 'string') return null;
  const sanitized = hostname.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, ROUTING_FIELD_CAPS.hostname);
  return sanitized.length > 0 ? `host-${shortHash(sanitized, 16)}` : null;
}

// Compose <repo-ident>:<kind>:<subject>:<status>. There is deliberately no
// source parameter — accepting one here is how dedupe would break. subject may
// contain colons (session:<id>:<hash>); repoIdent and status may not, so the
// first two and the last segment stay stable. ADR-0041 §4 — an OPTIONAL
// hostname weaves a colon-free host token into the subject region so the dedupe
// key is per-machine distinct (multi-device → one-chat). Absent hostname ⇒
// subject unchanged ⇒ id byte-identical to the pre-ADR-0041 format.
export function buildEventId({ repoIdent, kind, subject, status, hostname } = {}) {
  requireNonEmptyString(repoIdent, 'repoIdent');
  requireNonEmptyString(subject, 'subject');
  if (!NOTIFY_KINDS.includes(kind)) {
    throw new TypeError(`kind must be one of ${NOTIFY_KINDS.join(', ')}`);
  }
  let effectiveStatus;
  if (status === undefined || status === null || status === '') {
    if (!KINDS_WITH_DEFAULT_STATUS.includes(kind)) {
      throw new TypeError(
        `status is required for kind "${kind}" — the default token applies only to ${KINDS_WITH_DEFAULT_STATUS.join(', ')}`,
      );
    }
    effectiveStatus = DEFAULT_STATUS_TOKEN;
  } else {
    effectiveStatus = requireNonEmptyString(status, 'status');
  }
  if (repoIdent.includes(':')) {
    throw new TypeError('repoIdent must not contain a colon');
  }
  if (effectiveStatus.includes(':')) {
    throw new TypeError('status must not contain a colon');
  }
  const hostToken = hostSegment(hostname);
  const effectiveSubject = hostToken ? `${hostToken}:${subject}` : subject;
  return `${repoIdent}:${kind}:${effectiveSubject}:${effectiveStatus}`;
}

// Notification/permission_prompt → approval. The content hash keeps two
// DIFFERENT approval prompts in one session from deduping against each other;
// only a re-fire of the same prompt text dedupes.
export function approvalSubject({ sessionId, message } = {}) {
  requireNonEmptyString(sessionId, 'sessionId');
  if (typeof message !== 'string') {
    throw new TypeError('message must be a string');
  }
  return `session:${sessionId}:${shortHash(message, 12)}`;
}

// Notification/idle_prompt → idle. Session-only subject: one idle nudge per
// session per TTL window is the desired behavior.
export function idleSubject({ sessionId } = {}) {
  requireNonEmptyString(sessionId, 'sessionId');
  return `session:${sessionId}`;
}

// Bare Stop → turn-complete. session_id and prompt_id are documented common
// input fields on every hook event, so this subject never relies on a
// Stop-specific payload field.
export function turnCompleteSubject({ sessionId, promptId } = {}) {
  requireNonEmptyString(sessionId, 'sessionId');
  requireNonEmptyString(promptId, 'promptId');
  return `session:${sessionId}:${promptId}`;
}

// Stop with a fresh terminal workflow projection → workflow-terminal.
export function workflowTerminalSubject({ workflowId } = {}) {
  return requireNonEmptyString(workflowId, 'workflowId');
}

// SubagentStop → subagent-complete.
export function subagentCompleteSubject({ agentId } = {}) {
  return requireNonEmptyString(agentId, 'agentId');
}

// ── Hook payload + repo-root helpers ──

// Read the hook's stdin JSON payload. Malformed/empty input degrades to {}
// (fail-closed: the sensor then finds no usable fields and no-ops).
export async function readStdinJson(stream = process.stdin) {
  try {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// Walk up from cwd to the nearest .git marker (dir, or file for worktrees)
// with pure fs — the sensor spawns nothing to find the repo. Behaviorally
// identical to the emitter's own resolveRepoRoot (notify.mjs), so the sensor's
// repo-ident and the emitter's state home derive from the same root.
export function resolveRepoRoot(cwd = process.cwd()) {
  let current = path.resolve(cwd);
  try {
    current = fs.realpathSync(current);
  } catch {
    return null;
  }
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// ── §3 state enrichment: freshness-checked projection read ──

// The personas whose ADR-0031/0039 sidecars the Stop sensor may enrich from.
// Founder deliberately stays bare-Stop-only at v1: it computes a projection
// but writes no sidecar, and the runtime seam rejects workflow_kind 'founder'
// (context.mjs VALID_WORKFLOW_KINDS) — adding founder projection acceptance
// is ADR-0039 §7's separate recipe, not this sensor's call.
export const SENSOR_PERSONAS = Object.freeze(['engineer', 'orchestrator']);

// Mtime bound for "this projection describes the terminal transition the
// CURRENT Stop is observing". Wide enough to cover a long tail between the
// primary set-terminal write and the turn's Stop event; narrow enough that a
// lingering one-shot projection (no new session consumed it yet) stops
// re-classifying later turns as workflow-terminal once the TTL dedupe window
// has lapsed. Stale ⇒ the Stop degrades to a bare turn-complete notification.
export const HANDOFF_FRESHNESS_MS = 10 * 60 * 1000;

// The candidate one-shot files, canonical home first, then the legacy
// (pre-ADR-0025) home — a repo holds EITHER canonical or legacy persona state
// (the personas' resolveWorkflowStorage blocks both for writes), so the first
// EXISTING file is that persona's projection home (mirrors the personas' own
// pendingHandoffCandidates preference order). DELIBERATELY stricter than a
// keep-scanning reader: when both homes hold a file the repo is already in an
// inconsistent state, so a stale/invalid first candidate fail-closes to a bare
// notification rather than trusting the shadowed second home (never a wrong
// workflow claim).
function projectionCandidates(repoRoot, persona) {
  return [
    path.join(repoRoot, '.agentic-plugins', 'state', persona, 'last-session-handoff.json'),
    path.join(repoRoot, '.claude', `agentic-${persona}`, 'last-session-handoff.json'),
  ];
}

// The ADR-0039 footer-rendered marker is PER-PERSONA in shape — engineer keys
// one marker per projection slot, orchestrator bakes the workflow id into the
// filename (its Stop backstop scans every terminal macro against one shared
// slot). Copied shapes, canonical sources:
//   engineer:     `${projectionFile}.footer-rendered`
//                 (plugins/engineer/scripts/session-handoff.mjs)
//   orchestrator: `${projectionFile}.${safeWorkflowId}.footer-rendered`
//                 (plugins/orchestrator/scripts/session-handoff.mjs)
export function footerMarkerFileFor(persona, projectionFile, workflowId) {
  if (persona === 'orchestrator') {
    const safe = String(workflowId ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'unknown';
    return `${projectionFile}.${safe}.footer-rendered`;
  }
  return `${projectionFile}.footer-rendered`;
}

function readJsonIfObject(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read one persona's `last-session-handoff.json` and accept it ONLY when every
 * freshness gate passes:
 *   - the projection file exists (canonical home first, then legacy),
 *   - its mtime is within HANDOFF_FRESHNESS_MS of `now`,
 *   - it parses to an object whose workflow_id is a non-empty string,
 *   - its workflow_kind (when present) matches the persona directory,
 *   - the per-persona footer-rendered marker exists with the SAME workflow_id
 *     and status 'rendered' (a bare 'claimed' marker is a render in flight or
 *     one that crashed — not a completed terminal presentation).
 * Any gate failing returns null and the caller degrades to a bare
 * notification — never a wrong one.
 *
 * @returns {?{workflowId: string, projection: object, projectionFile: string}}
 */
export function readFreshProjection({ repoRoot, persona, now = Date.now() } = {}) {
  try {
    if (typeof repoRoot !== 'string' || repoRoot.length === 0) return null;
    if (!SENSOR_PERSONAS.includes(persona)) return null;
    let projectionFile = null;
    for (const candidate of projectionCandidates(repoRoot, persona)) {
      if (fs.existsSync(candidate)) {
        projectionFile = candidate;
        break;
      }
    }
    if (!projectionFile) return null;
    const st = fs.statSync(projectionFile);
    if (now - st.mtimeMs > HANDOFF_FRESHNESS_MS) return null;
    const projection = readJsonIfObject(projectionFile);
    if (!projection) return null;
    const workflowId = projection.workflow_id;
    if (typeof workflowId !== 'string' || workflowId.length === 0) return null;
    if (typeof projection.workflow_kind === 'string' && projection.workflow_kind !== persona) {
      return null;
    }
    const marker = readJsonIfObject(footerMarkerFileFor(persona, projectionFile, workflowId));
    if (!marker || marker.workflow_id !== workflowId || marker.status !== 'rendered') {
      return null;
    }
    return { workflowId, projection, projectionFile };
  } catch {
    return null;
  }
}

// ── Event assembly + emit seam ──

// ── ADR-0041 §4 cross-machine routing/display field resolution ──

// The machine label woven into every attention event_id (per-machine dedupe
// distinctness) and egressed as the `hostname` field. An operator override
// (AGENTIC_NOTIFY_HOSTNAME) wins over os.hostname() for machines whose kernel
// hostname is unhelpful; sanitized + capped so it is a safe id segment and a
// bounded egress field. Never throws (fail-closed): a resolution failure
// degrades to '' and the event simply carries no hostname.
export function resolveHostname({ env = process.env } = {}) {
  let raw = '';
  try {
    const override = env && typeof env.AGENTIC_NOTIFY_HOSTNAME === 'string'
      ? env.AGENTIC_NOTIFY_HOSTNAME.trim()
      : '';
    raw = override.length > 0 ? override : os.hostname();
  } catch {
    raw = '';
  }
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, ROUTING_FIELD_CAPS.hostname);
}

// Read a path ONLY if it is a regular file. statSync returns metadata without
// blocking (even on a FIFO); readFileSync on a FIFO/device WOULD block the hook
// path indefinitely — the isFile() gate is what keeps a malicious or broken
// `.git/HEAD` (a FIFO, directory, or device node) from hanging the sensor
// (ADR-0040 §7 never-block contract). Returns null for any non-regular target.
function readRegularFileSync(filePath) {
  const st = fs.statSync(filePath);
  if (!st.isFile()) return null;
  return fs.readFileSync(filePath, 'utf8');
}

// Resolve the current git branch by a pure fs read of .git/HEAD — NEVER a git
// subprocess (ADR-0041 §3: no hidden git exec on the hot path). Handles the
// worktree/submodule case where .git is a FILE pointing at the real gitdir.
// Every read goes through readRegularFileSync, so a special-file `.git/HEAD`
// can never block the hook. Returns the branch name, or null on detached HEAD /
// any read failure.
export function resolveGitBranch(repoRoot) {
  try {
    if (typeof repoRoot !== 'string' || repoRoot.length === 0) return null;
    let gitDir = path.join(repoRoot, '.git');
    const st = fs.statSync(gitDir);
    if (st.isFile()) {
      const pointer = readRegularFileSync(gitDir);
      if (pointer === null) return null;
      const m = pointer.trim().match(/^gitdir:\s*(.+)$/);
      if (!m) return null;
      gitDir = path.isAbsolute(m[1]) ? m[1] : path.resolve(repoRoot, m[1]);
    }
    const headRaw = readRegularFileSync(path.join(gitDir, 'HEAD'));
    if (headRaw === null) return null;
    const ref = headRaw.trim().match(/^ref:\s*refs\/heads\/(.+)$/);
    return ref ? ref[1] : null;
  } catch {
    return null;
  }
}

// The §3 `topic` egress field: `repo:branch` from event-build-time values (no
// git subprocess). Falls back to the repo label alone when the branch cannot be
// resolved (detached HEAD, worktree edge). Capped for egress.
export function resolveTopic({ repoRoot, repoLabel } = {}) {
  const label = typeof repoLabel === 'string' && repoLabel.length > 0
    ? repoLabel
    : (typeof repoRoot === 'string' && repoRoot.length > 0 ? path.basename(repoRoot) : '');
  if (label.length === 0) return '';
  const branch = resolveGitBranch(repoRoot);
  const topic = branch ? `${label}:${branch}` : label;
  return topic.slice(0, ROUTING_FIELD_CAPS.topic);
}

// The §4 `session_hint` egress field: a short, non-reversible hash of the
// session id (stable per session so same-host ssh+tmux sessions stay distinct
// in the egress display, without exposing the raw id). Prompt id is the
// fallback seed. Returns '' when no id is available.
export function buildSessionHint({ sessionId, promptId } = {}) {
  const seed = typeof sessionId === 'string' && sessionId.length > 0
    ? sessionId
    : (typeof promptId === 'string' && promptId.length > 0 ? promptId : '');
  if (seed.length === 0) return '';
  return shortHash(seed, 12).slice(0, ROUTING_FIELD_CAPS.session_hint);
}

// ── Event assembly ──

// Control-strip + whitespace-collapse + cap a routing/display field at the BUILD
// boundary, so every caller — the hooks today and any future producer — emits
// clean, bounded egress-bound fields, not only callers that pre-sanitize their
// input (peer review: centralize routing-field sanitization here). Mirrors the
// emitter's own field hardening; the egress-only secret-scrub is a later slice.
function sanitizeRoutingField(value, cap) {
  return String(value)
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
}

// Assemble a full §1 event object around a composed event_id. ADR-0041 §4 —
// OPTIONAL hostname/topic/sessionHint are woven into the event_id (hostname)
// and set as sanitized + born-capped routing/display fields; omitting them
// yields the pre-ADR-0041 event shape (backward-compat + parity).
export function buildEvent({
  repoIdent, kind, subject, status, title, body, urgency, refs,
  hostname, topic, sessionHint,
} = {}) {
  const event = {
    event_id: buildEventId({ repoIdent, kind, subject, status, hostname }),
    source: EVENT_SOURCE,
    kind,
    title,
    body: typeof body === 'string' ? body : '',
    urgency,
  };
  for (const [key, value] of [
    ['hostname', hostname],
    ['topic', topic],
    ['session_hint', sessionHint],
  ]) {
    if (typeof value !== 'string' || value.length === 0) continue;
    const clean = sanitizeRoutingField(value, ROUTING_FIELD_CAPS[key]);
    if (clean.length > 0) event[key] = clean;
  }
  if (refs && typeof refs === 'object' && !Array.isArray(refs)) {
    event.refs = refs;
  }
  return event;
}

/**
 * Resolve the runtime root (version-gated per the copied discover-runtime
 * ladder) and hand ONE event to `notify.mjs emit` — stdin JSON, explicit
 * `--repo-root` so the emitter's state home matches the sensor's repo. The
 * child's stdout/stderr are discarded: the sensor owns the "never stdout"
 * contract and the emitter is fail-closed silent on its own.
 *
 * spawnSync (bounded by `timeoutMs`) rather than fire-and-forget: the emitter
 * is local fs work that returns promptly, and a synchronous bound keeps the
 * hook's lifetime deterministic. A timeout kills the child and loses the
 * notification — acceptable by the ADR-0040 §7 fail-closed contract.
 *
 * @returns {Promise<{emitted: boolean, reason?: string}>}
 */
export async function emitEvent({
  repoRoot,
  event,
  env = process.env,
  home = undefined,
  timeoutMs = 5000,
} = {}) {
  try {
    if (typeof repoRoot !== 'string' || repoRoot.length === 0 || !event) {
      return { emitted: false, reason: 'bad-args' };
    }
    const runtimeRoot = await discoverRuntimePluginRoot({ env, home });
    if (!runtimeRoot) return { emitted: false, reason: 'runtime-unresolved' };
    const notifyPath = path.join(runtimeRoot, 'scripts', 'notify.mjs');
    spawnSync(process.execPath, [notifyPath, 'emit', '--repo-root', repoRoot], {
      input: `${JSON.stringify(event)}\n`,
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: timeoutMs,
    });
    return { emitted: true };
  } catch {
    return { emitted: false, reason: 'spawn-failed' };
  }
}
