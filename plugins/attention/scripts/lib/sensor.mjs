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

import {
  ENTRY_BRIEF_MIN_RUNTIME_VERSION,
  MIN_RUNTIME_VERSION,
  PUBLISH_SESSION_MIN_RUNTIME_VERSION,
  RESPONSE_SIGNAL_MIN_RUNTIME_VERSION,
  discoverRuntimePluginRoot,
  resolveNewestRuntimePluginRoot,
  resolveRuntimePluginRoot,
  runtimeVersionAtLeast,
} from '../discover-runtime.mjs';

// Re-exported so the Stop sensor can thread the ADR-0047 §9 floor into the
// emit seam (`emitEvent({ minVersion })`) without importing a second module —
// the hooks import everything through this lib.
export { RESPONSE_SIGNAL_MIN_RUNTIME_VERSION };

// ── ADR-0040 §1 contract copies (canonical: runtime lib/notify-schema.mjs) ──

// The §1 kind enum. Order is contractual documentation, not priority.
// `response-needed` (ADR-0047 §1) marks a FINAL turn — produced on the
// Claude limb by the §2 structural Stop classifier below
// (classifyStopFinality), behind its own released-runtime floor
// (RESPONSE_SIGNAL_MIN_RUNTIME_VERSION); below that floor the Stop sensor
// keeps emitting the bare `turn-complete` (§9 graceful degradation).
export const NOTIFY_KINDS = Object.freeze([
  'approval',
  'idle',
  'turn-complete',
  'subagent-complete',
  'workflow-terminal',
  'peer-run-terminal',
  'health',
  'response-needed',
]);

// Fixed status token for kinds without a natural terminal status.
export const DEFAULT_STATUS_TOKEN = 'fired';

// The ONLY kinds the default token applies to (ADR-0040 §1; response-needed
// added by ADR-0047 §1). Every other kind carries a real status moment; an
// absent status there is a producer bug.
export const KINDS_WITH_DEFAULT_STATUS = Object.freeze([
  'approval',
  'idle',
  'turn-complete',
  'response-needed',
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

// ADR-0041 §3a — the OPT-IN closed-vocabulary `headline` status token. COPY-NOT-
// IMPORT siblings of the canonical runtime lib (notify-schema.mjs, ADR-0010 §5 —
// parity-gated by tests/plugin-shape/test-attention-plugin.mjs). Attention is the
// PRODUCER (Guard 1: map-or-omit — deriveHeadlineToken below borns a token only for
// a recognized signal combination, never a guess); the runtime egress builders are
// the VALIDATOR (Guard 2: validate-or-drop against this same vocab). The field
// name + vocab + cap MUST stay byte-identical to the canonical lib, or a token this
// producer borns would be dropped runtime-side as out-of-vocab. Mirrors the
// hostname/session_hint copy-not-import precedent above.
export const OPTIONAL_HEADLINE_FIELD = 'headline';
export const HEADLINE_VOCAB = Object.freeze([
  'your-turn',
  'needs-approval',
  'in-progress',
  'blocked',
  'complete',
  'failed',
]);
// Defense-in-depth cap (a valid token is <= 14 chars; matched to the canonical
// bound). A closed-vocab token is secret-free and always under the cap, so capping
// is a uniform-treatment guard, not the leak control — vocab membership is.
export const HEADLINE_FIELD_CAP = 32;

// Guard 2's predicate, copied so the producer can self-check its own map output
// (belt-and-suspenders) with the exact membership test the runtime egress guard
// uses: true ONLY for an exact closed-vocab member — a non-string, whitespace-
// padded, or unknown value is not a token.
export function isHeadlineToken(value) {
  return typeof value === 'string' && HEADLINE_VOCAB.includes(value);
}

// ADR-0041 §3a Guard 1 (producer map-or-omit), producer-signal domain widened
// by the ADR-0047 §4 narrow amendment. Maps the STRUCTURED signals the sensors
// already hold to a closed-vocabulary headline token, or null (OMIT):
//   - workflow-terminal × the projection `archive_gate` (the real values the
//     persona mapArchiveGate copies emit: ready_to_archive / not_terminal /
//     blocked) — the original ADR-0041 §3a domain;
//   - response-needed ⇒ 'your-turn' (ADR-0047 §4): the kind itself already
//     encodes the §2 structural FINAL verdict, so the map is total for this
//     kind — map-or-omit is preserved because an uncertain classification
//     never produces the kind in the first place;
//   - approval ⇒ 'needs-approval' (ADR-0047 §4): the host's
//     `notification_type: permission_prompt` matcher IS the structural
//     signal (no inference), total by the same argument.
// It NEVER guesses: an unknown/absent archive_gate or an unmapped kind yields
// null so buildEvent omits headline entirely (never a wrong token). The bare
// turn-complete deliberately produces no token — doubly so after ADR-0047 §3
// narrowed it to interim turns (a kind-only token would overstate an interim
// turn as session status); the idle path stays headline-free too. The final
// isHeadlineToken re-check keeps the table honest: were a mapping value to drift out
// of vocab it would omit here (and the parity test would fail loudly), never egress.
//
// ADR-0043 §3 nuance: for the manually-published personas (founder/designer)
// an archive_gate of 'blocked' is USUALLY the completion-output contract §2
// publish-needed state (only head_moved unmet — explicitly "not blocked"),
// and the frozen 8-field projection carries no gate_failures to tell
// publish-needed from a genuine blocker — so their 'blocked' maps to NO token
// (map-or-omit: never a wrong token). ready_to_archive → complete and
// not_terminal → in-progress stay truthful for all four personas.
const HEADLINE_BY_ARCHIVE_GATE = Object.freeze({
  ready_to_archive: 'complete',
  not_terminal: 'in-progress',
  blocked: 'blocked',
});
const MANUALLY_PUBLISHED_PERSONAS = Object.freeze(['founder', 'designer']);
export function deriveHeadlineToken({ kind, archiveGate, persona } = {}) {
  // ADR-0047 §4 — the two end-state kinds whose kind IS the structural
  // verdict: total maps, re-checked against the vocab like every row.
  if (kind === 'response-needed') {
    return isHeadlineToken('your-turn') ? 'your-turn' : null;
  }
  if (kind === 'approval') {
    return isHeadlineToken('needs-approval') ? 'needs-approval' : null;
  }
  if (kind !== 'workflow-terminal') return null;
  // Own-key, STRING-ONLY lookup. archiveGate comes from a parsed projection JSON, so
  // it can be any JSON type — and a bracket lookup would COERCE a non-string key via
  // String(), which THROWS on a pathological object (e.g. { toString: 'ready_to_archive' }
  // shadows the method with a non-callable). That throw would escape to the Stop
  // sensor's outer catch and suppress the WHOLE notification, not just omit headline —
  // violating the fail-closed contract (a malformed projection is an environmental
  // condition, not a producer bug). Object.hasOwn also blocks an inherited key
  // ('constructor'/'toString'/'__proto__') from resolving to a prototype member
  // (Codex Plan-verify MAJOR).
  if (typeof archiveGate !== 'string' || !Object.hasOwn(HEADLINE_BY_ARCHIVE_GATE, archiveGate)) {
    return null;
  }
  if (archiveGate === 'blocked' && MANUALLY_PUBLISHED_PERSONAS.includes(persona)) {
    return null;
  }
  const token = HEADLINE_BY_ARCHIVE_GATE[archiveGate];
  return isHeadlineToken(token) ? token : null;
}

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
// The ADR-0043 §3 follow-up landed once its trigger fired: founder (S3,
// plugin-founder-v0.4.0) and designer (S4, plugin-designer-v0.3.0) sidecars
// emit projections + footer-rendered markers in the wild, and each persona's
// marker shape is a documented cross-package contract in that persona's
// `skills/_shared/references/session-handoff.md` (ADR-0043 §2) — this sensor
// consumes those documented contracts, never a reverse-engineered
// implementation detail. Rollback note: attention rolls back independently;
// it owns no durable state beyond the runtime notify-state TTL entries its
// emitted events produce.
export const SENSOR_PERSONAS = Object.freeze(['engineer', 'orchestrator', 'founder', 'designer']);

// Freshness bound for "this projection describes the terminal transition the
// CURRENT Stop is observing", applied to BOTH signals readFreshProjection
// gates on: the projection file's mtime AND the rendered marker's `at`
// timestamp (the render moment — the transition anchor). The dual anchor
// matters for the manually-published personas (founder/designer): their
// publish-needed workflows stay active-terminal and their persona Stop
// backstop rewrites the projection every turn (fresh mtime indefinitely),
// but the rendered marker's `at` is written once per terminal transition —
// so enrichment fires near the transition and later turns degrade back to a
// bare turn-complete instead of re-emitting workflow-terminal once per
// rolling dedupe-TTL window (the emitter accepts at most one attempt per
// event ID per rolling TTL, and quiet-hours suppression can prevent delivery
// entirely — neither queues a retry). A primary re-terminalization rewrites
// the marker (new `at`) and re-arms enrichment for the new transition.
// Stale on either anchor ⇒ the Stop degrades to a bare turn-complete.
export const HANDOFF_FRESHNESS_MS = 10 * 60 * 1000;

// Maximum tolerated FUTURE skew on either freshness anchor. `now` is captured
// once before the per-persona reads, so a legitimately-concurrent persona
// write can postdate it by milliseconds — but a far-future mtime or marker
// `at` is malformed state, and malformed must degrade, never enrich (a
// unidirectional age check would hold a future-dated anchor "fresh" for its
// entire lead PLUS the window — the Codex review reproduced exactly that
// bypass). Both anchors reject when age < -FUTURE_SKEW_MS (ADR-0040 §7).
export const FUTURE_SKEW_MS = 60 * 1000;

// The marker `at` contract is ISO-8601 UTC (the persona writers emit
// `new Date().toISOString()`). Date.parse would also accept RFC-2822, local
// times, and date-only strings — parseable but out of contract — so the
// lexical shape is validated BEFORE parsing (fail-closed on non-contract
// spellings).
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

// The candidate one-shot files, PER PERSONA. engineer/orchestrator predate
// ADR-0025, so their canonical home is probed first and the legacy
// (pre-ADR-0025) home second — a repo holds EITHER canonical or legacy
// persona state (the personas' resolveWorkflowStorage blocks both for
// writes), so the first EXISTING file is that persona's projection home
// (mirrors the personas' own pendingHandoffCandidates preference order).
// DELIBERATELY stricter than a keep-scanning reader: when both homes hold a
// file the repo is already in an inconsistent state, so a stale/invalid first
// candidate fail-closes to a bare notification rather than trusting the
// shadowed second home (never a wrong workflow claim). founder/designer are
// canonical-home-only — no legacy home ever existed for them (ADR-0036 SD5 /
// ADR-0042 SD7) — so their candidate list deliberately models only the path
// their writers can produce.
const LEGACY_HOME_PERSONAS = Object.freeze(['engineer', 'orchestrator']);
function projectionCandidates(repoRoot, persona) {
  const candidates = [
    path.join(repoRoot, '.agentic-plugins', 'state', persona, 'last-session-handoff.json'),
  ];
  if (LEGACY_HOME_PERSONAS.includes(persona)) {
    candidates.push(path.join(repoRoot, '.claude', `agentic-${persona}`, 'last-session-handoff.json'));
  }
  return candidates;
}

// The ADR-0039 footer-rendered marker is PER-PERSONA in shape — engineer,
// founder, and designer key one marker per projection slot; orchestrator
// bakes the workflow id into the filename (its Stop backstop scans every
// terminal macro against one shared slot). The shape table is EXPLICIT so a
// future SENSOR_PERSONAS addition fails closed (no marker contract → null →
// bare notification) until its shape is deliberately added here. Copied
// shapes, canonical sources (founder/designer document theirs as the
// ADR-0043 §2 cross-package contract):
//   engineer:     `${projectionFile}.footer-rendered`
//                 (plugins/engineer/scripts/session-handoff.mjs)
//   orchestrator: `${projectionFile}.${safeWorkflowId}.footer-rendered`
//                 (plugins/orchestrator/scripts/session-handoff.mjs)
//   founder:      `${projectionFile}.footer-rendered`
//                 (plugins/founder/skills/_shared/references/session-handoff.md)
//   designer:     `${projectionFile}.footer-rendered`
//                 (plugins/designer/skills/_shared/references/session-handoff.md)
const MARKER_SHAPE_BY_PERSONA = Object.freeze({
  engineer: 'slot',
  orchestrator: 'id-scoped',
  founder: 'slot',
  designer: 'slot',
});
export function footerMarkerFileFor(persona, projectionFile, workflowId) {
  const shape = MARKER_SHAPE_BY_PERSONA[persona];
  if (shape === 'id-scoped') {
    const safe = String(workflowId ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'unknown';
    return `${projectionFile}.${safe}.footer-rendered`;
  }
  if (shape === 'slot') {
    return `${projectionFile}.footer-rendered`;
  }
  return null; // unknown persona — no documented marker contract; caller fail-closes
}

// Projection/marker reads go through the SAME regular-file gate as the
// .git/HEAD reads below (readRegularFileSync): an unbounded readFileSync on
// a repo-controlled FIFO/device at a projection path would block the WHOLE
// Stop sensor before capture and notification — outside every timeout, so
// the budget constants would be arithmetic rather than an enforced ceiling
// (Codex review MAJOR). Non-regular or oversized targets degrade to null.
function readJsonIfObject(filePath) {
  try {
    const text = readRegularFileSync(filePath);
    if (text === null) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read one persona's `last-session-handoff.json` and accept it ONLY when every
 * freshness gate passes:
 *   - the projection file exists (per-persona candidate homes: canonical for
 *     all four; the pre-ADR-0025 legacy home only for engineer/orchestrator),
 *   - its mtime is within HANDOFF_FRESHNESS_MS of `now`,
 *   - it parses to an object whose workflow_id is a non-empty string,
 *   - its workflow_kind STRICTLY equals the persona directory — the canonical
 *     bounded schema requires the field (runtime context.mjs), so an absent or
 *     padded kind is a malformed projection and malformed must degrade,
 *     never enrich,
 *   - the per-persona footer-rendered marker exists with the SAME workflow_id,
 *     status 'rendered' (a bare 'claimed' marker is a render in flight or one
 *     that crashed — not a completed terminal presentation), AND an `at`
 *     render timestamp within HANDOFF_FRESHNESS_MS — the transition anchor
 *     (persona Stop backstops refresh the projection mtime but never a
 *     rendered marker's `at`, so this is what ties enrichment to the terminal
 *     TRANSITION rather than to a persisting active-terminal state).
 * Any gate failing returns null and the caller degrades to a bare
 * notification — never a wrong one. Best-effort/last-observed: Claude fires
 * Stop hooks with no cross-plugin ordering, so the projection read here is
 * the persona's last-observed terminal state, not necessarily this instant's
 * (the workflow-scoped dedupe key collapses gate-state flips of one
 * transition on the emitter side).
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
    const mtimeAge = now - st.mtimeMs;
    if (mtimeAge > HANDOFF_FRESHNESS_MS || mtimeAge < -FUTURE_SKEW_MS) return null;
    const projection = readJsonIfObject(projectionFile);
    if (!projection) return null;
    const workflowId = projection.workflow_id;
    if (typeof workflowId !== 'string' || workflowId.length === 0) return null;
    if (projection.workflow_kind !== persona) return null;
    const markerFile = footerMarkerFileFor(persona, projectionFile, workflowId);
    if (!markerFile) return null;
    const marker = readJsonIfObject(markerFile);
    if (!marker || marker.workflow_id !== workflowId || marker.status !== 'rendered') {
      return null;
    }
    const renderedAt = typeof marker.at === 'string' && ISO_UTC_RE.test(marker.at)
      ? Date.parse(marker.at)
      : NaN;
    const renderedAge = now - renderedAt;
    if (!Number.isFinite(renderedAt)
      || renderedAge > HANDOFF_FRESHNESS_MS
      || renderedAge < -FUTURE_SKEW_MS) {
      return null;
    }
    return { workflowId, projection, projectionFile };
  } catch {
    return null;
  }
}

// ── ADR-0047 §2 bounded structural Stop finality classifier ──

// Peer-run ledger homes per persona — COPY-NOT-IMPORT siblings of each
// persona plugin's own peer-runner.mjs `PEER_RUNS_DIR_RELS` (ADR-0010 §5;
// engineer/orchestrator carry the pre-ADR-0025 legacy home, founder/designer
// are canonical-only because no legacy home ever existed for them —
// ADR-0036 SD5 / ADR-0042 SD7, the same table projectionCandidates models).
// The classifier consults BOTH homes of a dual-home persona (the
// peer-runner's own dual-home read set); a persona presenting runs in BOTH
// homes at once is the peer-runner's own ambiguous state and fail-closes the
// scan below.
export const PEER_RUN_HOMES_BY_PERSONA = Object.freeze({
  engineer: Object.freeze([
    '.agentic-plugins/state/engineer/peer-runs',
    '.claude/agentic-engineer/peer-runs',
  ]),
  orchestrator: Object.freeze([
    '.agentic-plugins/state/orchestrator/peer-runs',
    '.claude/agentic-orchestrator/peer-runs',
  ]),
  founder: Object.freeze(['.agentic-plugins/state/founder/peer-runs']),
  designer: Object.freeze(['.agentic-plugins/state/designer/peer-runs']),
});

// The ledger status vocabulary — COPY-NOT-IMPORT sibling of the persona
// peer-runners' VALID_STATUSES / TERMINAL_STATUSES (ADR-0023). An unknown
// status token is a MALFORMED handle to this classifier (fail-closed:
// a future ledger vocabulary extension must be modeled here deliberately,
// never guessed live on the Stop hot path).
export const PEER_RUN_TERMINAL_STATUSES = Object.freeze([
  'completed',
  'failed',
  'cancelled',
  'orphaned',
  'pruned',
]);
export const PEER_RUN_NON_TERMINAL_STATUSES = Object.freeze([
  'queued',
  'spawning',
  'running',
  'cancel_requested',
]);

// The ledger's stale-grace window (peer-runner DEFAULT_STALE_GRACE_MS
// mirror, test-pinned): a PID-less `queued|spawning` handle is live only
// while its `updated_at` is inside this window (ADR-0047 §2 row 3; NOT an
// mtime-activity heuristic — it reads the ledger's own liveness field
// under the ledger's own contract, ADR-0047 Alt 4 note). Boundary matches
// the sweep's staleness test exactly: stale strictly-greater-than, so
// age == grace is still live. Scope honesty (Codex review): the sweep
// itself stale-reconciles spawning/running/cancel_requested but never
// `queued`; extending the window to queued is the §2 rule so an abandoned
// pre-spawn handle cannot suppress promotion for its whole retention
// lifetime. The sweep CLI's --stale-grace-ms override is a sweep tunable,
// not ledger contract — this constant pins the contract default.
export const PEER_RUN_STALE_GRACE_MS = 60_000;

// §2 scan bounds — implementation constants pinned by the plugin-shape test
// alongside the four Stop-budget constants. The cap must clear the ledgers'
// own retention cap (200 per persona, peer-runner DEFAULT_RETENTION_CAP)
// with headroom: a swept repo stays well under it, and only a pathological
// backlog exhausts it (⇒ scan incomplete ⇒ no promotion, never a false
// final). The budget is a wall-clock cutoff INSIDE the existing Stop
// emission slot — the classifier adds no slot to the 36 s
// STOP_HOT_PATH_BUDGET_MS contract and spawns nothing (the PID probe is
// `process.kill(pid, 0)`, ADR-0047 §2 no-fingerprinting rule).
export const PEER_SCAN_PER_PERSONA_CAP = 1024;
export const PEER_SCAN_BUDGET_MS = 1_000;

// Zero-cost PID liveness probe. EPERM proves an existing process owned by
// someone else (alive); ESRCH proves absence (dead). ONLY those two codes
// are proof — anything else (range errors, platform oddities) is thrown
// and the caller fail-closes the scan: an unproven death must never
// underwrite a final verdict (Codex review MINOR; ADR-0040 §7). A PID
// recycled by an unrelated process reads LIVE ⇒ interim — the accepted
// false-negative-direction error (ADR-0047 §2): the ledger's own sweep,
// not this hot path, is where fingerprint truth is enforced.
function defaultProbePid(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = err && err.code;
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    throw err;
  }
}

// Read ONE ledger handle and judge liveness. Returns
//   { ok: false, reason }        — malformed/unreadable handle (scan-incomplete)
//   { ok: true, live: boolean }  — a well-formed verdict.
// Handle reads go through the same regular-file/size gate as every other
// hot-path read here (readRegularFileSync) so a planted FIFO/device at a
// handle path can never stall Stop (ADR-0047 §2 bounded-read rule).
function readPeerRunHandleLiveness(handlePath, { nowMs, staleGraceMs, probePid }) {
  let text;
  try {
    text = readRegularFileSync(handlePath);
  } catch {
    return { ok: false, reason: 'handle-unreadable' };
  }
  if (text === null) return { ok: false, reason: 'handle-nonregular' };
  let handle;
  try {
    handle = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'handle-malformed' };
  }
  if (!handle || typeof handle !== 'object' || Array.isArray(handle)) {
    return { ok: false, reason: 'handle-malformed' };
  }
  // Ledger identity core (Codex review MAJOR, narrowed): every real handle
  // carries schema_version + run_id from birth (writeHandle refuses to
  // persist without them, and writes are atomic temp+rename, so their
  // absence proves a non-ledger artifact, not a torn write). The FULL
  // peer-runner schema is deliberately NOT mirrored here — a wide mirror
  // would turn every additive ledger evolution into a promotion blocker;
  // the liveness verdict needs identity + status + updated_at (+ pid).
  if (typeof handle.schema_version !== 'string' || handle.schema_version.length === 0
    || typeof handle.run_id !== 'string' || handle.run_id.length === 0) {
    return { ok: false, reason: 'handle-identity-missing' };
  }
  const status = handle.status;
  if (typeof status !== 'string'
    || (!PEER_RUN_TERMINAL_STATUSES.includes(status)
      && !PEER_RUN_NON_TERMINAL_STATUSES.includes(status))) {
    return { ok: false, reason: 'handle-status-unknown' };
  }
  // Every handle must carry a well-formed, non-future `updated_at` (the
  // ledger writes it on every transition): a future-skewed timestamp is
  // malformed state anywhere in the ledger and blocks promotion (§2
  // scan-completeness, same FUTURE_SKEW_MS tolerance as the projection
  // anchors).
  const updatedMs = typeof handle.updated_at === 'string' && ISO_UTC_RE.test(handle.updated_at)
    ? Date.parse(handle.updated_at)
    : NaN;
  if (!Number.isFinite(updatedMs)) return { ok: false, reason: 'handle-updated-at-malformed' };
  if (nowMs - updatedMs < -FUTURE_SKEW_MS) return { ok: false, reason: 'handle-future-skew' };
  if (PEER_RUN_TERMINAL_STATUSES.includes(status)) return { ok: true, live: false };
  if (status === 'running' || status === 'cancel_requested') {
    // Live requires the RECORDED pid to answer the zero-signal probe. A
    // running/cancel_requested handle with no recorded pid violates the
    // ledger lifecycle (pid is written at spawn, before running) — treat as
    // malformed, never guess (§2). A probe error beyond the two proof
    // codes (defaultProbePid throws) equally fail-closes: unproven death
    // must not underwrite promotion.
    const pid = handle.pid;
    if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: 'handle-pid-missing' };
    let alive;
    try {
      alive = probePid(pid) === true;
    } catch {
      return { ok: false, reason: 'pid-probe-failed' };
    }
    return { ok: true, live: alive };
  }
  // queued | spawning — PID-less BY DESIGN (peer-runner records the pid only
  // at spawn): live while updated_at sits inside the ledger's stale-grace
  // window (contract default 60s; boundary inclusive, matching the sweep's
  // strictly-greater staleness test). Precision note (Codex review): the
  // ledger's own sweep stale-reconciles only spawning/running/
  // cancel_requested — `queued` is never reconciled and would otherwise sit
  // non-terminal until retention TTL. Applying the grace window to queued
  // here is the ADR-0047 §2 row-3 rule, on purpose: without it one
  // abandoned pre-spawn handle would suppress response-needed for its
  // whole retention lifetime. The sweep CLI's operator-configurable
  // --stale-grace-ms is a sweep tunable, not ledger contract; this
  // classifier pins the contract default (test-pinned parity with
  // DEFAULT_STALE_GRACE_MS).
  return { ok: true, live: nowMs - updatedMs <= staleGraceMs };
}

/**
 * ADR-0047 §2 row 3 — the bounded peer-run ledger scan over both storage
 * homes of all four SENSOR_PERSONAS. Returns
 *   { live: true,  complete: false }          — a live handle was found (the
 *     verdict is already decided; completeness no longer matters), or
 *   { live: false, complete: true }           — every home was readable, every
 *     handle well-formed, no cap/budget exhaustion, nothing live, or
 *   { live: false, complete: false, reason }  — the scan could not COMPLETE:
 *     unreadable home, malformed handle, future skew, ambiguous dual-home
 *     state, cap or budget exhausted. An incomplete scan BLOCKS promotion
 *     (a live handle hiding beyond a cap must not produce a false final).
 * ENOENT on a home directory is zero runs (normal), not unreadable.
 * Injectables (`now`/`probePid`/caps) exist for deterministic tests only —
 * production callers use the pinned constants.
 */
export function scanPeerRunLedgers({
  repoRoot,
  personas = SENSOR_PERSONAS,
  perPersonaCap = PEER_SCAN_PER_PERSONA_CAP,
  budgetMs = PEER_SCAN_BUDGET_MS,
  staleGraceMs = PEER_RUN_STALE_GRACE_MS,
  now = Date.now,
  probePid = defaultProbePid,
} = {}) {
  try {
    if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
      return { live: false, complete: false, reason: 'bad-args' };
    }
    const deadline = now() + budgetMs;
    for (const persona of personas) {
      const homes = PEER_RUN_HOMES_BY_PERSONA[persona];
      if (!homes) return { live: false, complete: false, reason: `unknown-persona:${persona}` };
      const populatedHomes = [];
      const runDirs = [];
      for (const rel of homes) {
        if (now() > deadline) return { live: false, complete: false, reason: 'budget-exhausted' };
        const homeDir = path.join(repoRoot, rel);
        let entries;
        try {
          entries = fs.readdirSync(homeDir, { withFileTypes: true });
        } catch (err) {
          if (err && err.code === 'ENOENT') continue; // absent home = zero runs, normal
          return { live: false, complete: false, reason: `home-unreadable:${persona}` };
        }
        let sawEntry = false;
        for (const entry of entries) {
          // ANY entry marks the home populated — the peer-runner's own
          // dual-home detector (directoryHasEntries) counts every entry,
          // so a clutter-only canonical home + a populated legacy home is
          // ambiguous THERE and must be ambiguous here too (Codex review
          // MAJOR: a dir-only count read scanner-complete a state the
          // ledger itself refuses to touch).
          sawEntry = true;
          if (entry.isDirectory()) {
            runDirs.push(path.join(homeDir, entry.name));
            continue;
          }
          if (entry.isFile()) continue; // lock/temp files are non-candidates
          // Symlinks (and any other non-file/non-dir entry) cannot be
          // judged without following them — a symlinked run directory
          // hiding a live handle must not read as a complete scan (Codex
          // review MAJOR). No real ledger contains them; fail closed.
          return { live: false, complete: false, reason: `home-entry-unscannable:${persona}` };
        }
        if (sawEntry) populatedHomes.push(rel);
      }
      // The peer-runner's own ambiguous dual-home state (entries in BOTH
      // the canonical and legacy home) fail-closes its every read; mirror it.
      if (populatedHomes.length > 1) {
        return { live: false, complete: false, reason: `ambiguous-dual-home:${persona}` };
      }
      let scanDirs = runDirs;
      const capExceeded = runDirs.length > perPersonaCap;
      if (capExceeded) {
        // Newest-first (directory mtime) truncation: the truncated scan can
        // still DISCOVER a live handle (⇒ interim), but it can never prove
        // absence — cap exhaustion below blocks promotion regardless. The
        // stat pass is deadline-checked per entry: a pathological backlog
        // must hit the wall-clock bound here, not after materializing every
        // stat (Codex review MAJOR).
        const withMtime = [];
        for (const dir of runDirs) {
          if (now() > deadline) return { live: false, complete: false, reason: 'budget-exhausted' };
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(dir).mtimeMs;
          } catch {
            mtimeMs = 0;
          }
          withMtime.push({ dir, mtimeMs });
        }
        scanDirs = withMtime
          .sort((a, b) => b.mtimeMs - a.mtimeMs)
          .slice(0, perPersonaCap)
          .map((item) => item.dir);
      }
      for (const dir of scanDirs) {
        if (now() > deadline) return { live: false, complete: false, reason: 'budget-exhausted' };
        const verdictOne = readPeerRunHandleLiveness(path.join(dir, 'handle.json'), {
          nowMs: now(),
          staleGraceMs,
          probePid,
        });
        if (!verdictOne.ok) {
          return { live: false, complete: false, reason: `${verdictOne.reason}:${persona}` };
        }
        if (verdictOne.live) return { live: true, complete: false };
      }
      if (capExceeded) {
        return { live: false, complete: false, reason: `cap-exhausted:${persona}` };
      }
    }
    // Final deadline check — a scan that USED more than its budget must not
    // report complete just because each intermediate check slipped under
    // the wire (Codex review MAJOR: promotion after budget exhaustion).
    if (now() > deadline) return { live: false, complete: false, reason: 'budget-exhausted' };
    return { live: false, complete: true };
  } catch {
    return { live: false, complete: false, reason: 'scan-error' };
  }
}

// §2 rows 1/2 — one payload field's evidence. Probed contract
// (Claude Code 2.1.216, 2026-07-21 — host-parity-baseline.md § Claude
// Stop-payload matrix): on a supporting host BOTH fields are always present
// as arrays (empty when nothing is pending); `background_tasks` entries
// carry { id, type, status, … } with `status: "running"` observed live and
// COMPLETED tasks REMOVED from the list; `session_crons` entries carry
// { id, schedule, recurring, prompt }. The v1 predicate is therefore
// entry-shape-independent and maximally conservative: a well-formed array is
// observable, and ANY entry is interim evidence — no terminal-status token
// was ever observed surviving in the list, so treating residents as
// not-terminal errs only in the accepted false-negative direction (§2
// "never to a guess"; a host version that keeps terminal entries listed is
// a compat-watch trigger, not a live guess here). A present-but-null,
// scalar, or otherwise non-array field is UNOBSERVABLE — never "empty".
function readStopPayloadArrayEvidence(payload, field) {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload[field]
    : undefined;
  if (!Array.isArray(value)) return { observable: false, interim: false };
  return { observable: true, interim: value.length > 0 };
}

/**
 * ADR-0047 §2 — classify a BARE Stop (no fresh terminal projection; the
 * workflow-terminal branch never reaches this) as interim vs final from
 * structural evidence only. Returns { verdict, reason } where verdict is:
 *   'interim'      — positive interim evidence (row 1/2 entry, live handle):
 *                    the turn does not end the agent's work; emit
 *                    turn-complete.
 *   'final'        — at least one payload field observable and well-formed,
 *                    NO interim evidence from any row, and a COMPLETE row-3
 *                    ledger scan: the agent is waiting on the user; the
 *                    caller may emit response-needed.
 *   'unpromotable' — the evidence needed to prove finality is unobservable
 *                    or incomplete (payload surface absent/malformed, scan
 *                    incomplete, classifier error): emit the bare
 *                    turn-complete exactly as pre-ADR-0047 (conservative
 *                    false-negative policy; fail-closed observer, ADR-0040
 *                    §7).
 * When NEITHER payload field is observable the classifier returns
 * unpromotable WITHOUT running the ledger scan — absence of the primary
 * payload surface already blocks promotion regardless of row 3 (§2), and
 * skipping the scan keeps the unsupported-host hot path at its pre-ADR-0047
 * cost. Session-correlation limit, stated honestly: peer-run handles carry
 * no session identity, so row 3 is REPO-scoped — a live peer run from a
 * different session in the same repo reads interim (accepted, conservative
 * direction; documented, not "fixed" with heuristics). `scan` is injectable
 * for deterministic tests only. The classifier NEVER opens transcript_path
 * (ADR-0044 Alt E stands).
 */
export function classifyStopFinality({
  payload,
  repoRoot,
  now = Date.now,
  scan = scanPeerRunLedgers,
  scanOptions = undefined,
} = {}) {
  try {
    const backgroundTasks = readStopPayloadArrayEvidence(payload, 'background_tasks');
    const sessionCrons = readStopPayloadArrayEvidence(payload, 'session_crons');
    if (backgroundTasks.interim) return { verdict: 'interim', reason: 'background-tasks-pending' };
    if (sessionCrons.interim) return { verdict: 'interim', reason: 'session-crons-pending' };
    if (!backgroundTasks.observable && !sessionCrons.observable) {
      return { verdict: 'unpromotable', reason: 'payload-surface-unobservable' };
    }
    const ledger = scan({ repoRoot, now, ...(scanOptions ?? {}) });
    if (ledger && ledger.live === true) return { verdict: 'interim', reason: 'peer-run-live' };
    // Promotion demands the EXACT well-formed shape: complete === true AND
    // live === false. A malformed scan result ({complete:true} with live
    // missing, truthy-but-non-boolean fields) must degrade, never promote
    // (Codex review MINOR — the injectable seam makes the shape a contract).
    if (!ledger || ledger.complete !== true || ledger.live !== false) {
      const detail = ledger && typeof ledger.reason === 'string' ? ledger.reason : 'unknown';
      return { verdict: 'unpromotable', reason: `scan-incomplete:${detail}` };
    }
    return { verdict: 'final', reason: 'no-interim-evidence' };
  } catch {
    return { verdict: 'unpromotable', reason: 'classifier-error' };
  }
}

/**
 * ADR-0047 §9 — the dedicated released-runtime floor gate for the
 * response-needed classifier/producer path. True only when the SAME
 * notify-capable root the emit seam resolves (resolveRuntimePluginRoot —
 * one best root, no stale fallback, ADR-0039 §5) declares a version >=
 * RESPONSE_SIGNAL_MIN_RUNTIME_VERSION. Below the floor the Stop sensor
 * takes the pre-ADR-0047 bare path (turn-complete, no classifier, no
 * headline) — graceful degradation, not an error. The floor never shares a
 * constant with the notify/publisher/entry gates (ADR-0044 rule). Belt and
 * suspenders: the caller additionally threads the same floor into
 * emitEvent({ minVersion }) so a cache swap between this gate and the emit
 * spawn still cannot hand a response-needed event to a pre-contract
 * runtime's validateEvent (§8 enable-sequence failure 1).
 */
export async function responseSignalRuntimeReady({ env = process.env, home = undefined } = {}) {
  try {
    const root = await resolveRuntimePluginRoot({ env, home });
    if (!root) return false;
    return await runtimeVersionAtLeast(root, RESPONSE_SIGNAL_MIN_RUNTIME_VERSION);
  } catch {
    return false;
  }
}

// ── Event assembly + emit seam ──

// ── ADR-0044 §2 Stop hot-path budget (contract values) ──

// The Stop hook's worst-case latency is a CONTRACT, not an accident of local
// defaults. One emission slot must exceed the runtime emitter's own 8s network
// budget plus node-startup/preflight headroom (see the emitEvent timeout notes
// below); the terminal-notification batch may consume at most TWO full slots
// (ADR-0043 §3 full-slot-or-nothing batching); and the ADR-0044 capture spawn
// gets AT MOST one more slot, ordered AHEAD of the notification work. The
// aggregate is therefore three slots (36s) in the worst case — reached only
// when the capture publisher AND two egress dispatches all run to their kill
// bounds simultaneously. Changing any value here is a contract change
// (README § Stop hot-path budget); the plugin-shape test pins all four.
export const EMIT_SLOT_MS = 12_000;
export const TERMINAL_BATCH_DEADLINE_MS = 2 * EMIT_SLOT_MS;
export const PUBLISH_SESSION_TIMEOUT_MS = 12_000;
export const STOP_HOT_PATH_BUDGET_MS = PUBLISH_SESSION_TIMEOUT_MS + TERMINAL_BATCH_DEADLINE_MS;

// ── ADR-0045 §11 SessionStart latency budget (contract values) ──

// The entry-brief executor spawn's kill bound: one emission-sized slot. This
// is a KILL bound, not a completion guarantee — the enabled executor pays ≤5
// sequential bounded git spawns (each under the runtime's own ~3 s per-probe
// cap) plus the contract §14.1 bounded reads, so the theoretical worst-case
// probe sum alone can exceed this slot; in that regime the spawn is killed
// and the brief line is lost — the ADR-0040 §7 fail-closed choice (a lost
// brief, never a session entry delayed past the host-enforced hook timeout).
// The typical local path (disabled gate: 1 git spawn + 2 config reads;
// enabled: warm-cache git probes in milliseconds, §15.3) completes far
// inside the slot.
export const ENTRY_BRIEF_TIMEOUT_MS = 12_000;

// The host-side per-hook `timeout` (SECONDS — the Claude hooks.json unit,
// probed 2026-07-18 / re-validated 2026-07-20) registered on the SessionStart
// entry sensor. It must exceed ENTRY_BRIEF_TIMEOUT_MS plus node-startup +
// discovery-walk headroom so the host never kills a dispatcher whose child
// spawn is still inside its own bound. The registered hooks.json value must
// agree with this constant — the plugin-shape test pins the pair.
export const SESSION_START_HOOK_TIMEOUT_S = 15;

// Aggregate SessionStart budget: attention registers exactly ONE
// SessionStart hook (the entry sensor), so the aggregate equals the single
// host-enforced hook timeout. Synchronous SessionStart handlers delay
// session entry until they finish (probed matrix), which is why this is a
// stated contract, not an accident: worst case the operator waits 15 s for
// session entry, reached only when discovery + the executor both run to
// their kill bounds. Changing any value here is a contract change
// (README § SessionStart budget); the plugin-shape test pins all three.
export const SESSION_START_BUDGET_MS = SESSION_START_HOOK_TIMEOUT_S * 1000;

// ── ADR-0045 §7 entry-brief dispatch seam (stdout-capturing) ──

// Marker pair for the one permitted stdout line (contract §17; canonical:
// runtime context.mjs ENTRY_BRIEF_MARKER_OPEN/CLOSE — COPY-NOT-IMPORT,
// parity relied on by the validation boundary below), and the §15.1 schema
// id the wrapped document must self-declare (canonical: runtime
// entry-brief-arbiter.mjs ENTRY_BRIEF_SCHEMA_ID).
export const ENTRY_BRIEF_MARKER_OPEN = '[agentic-entry-brief]';
export const ENTRY_BRIEF_MARKER_CLOSE = '[/agentic-entry-brief]';
export const ENTRY_BRIEF_SCHEMA_ID = 'runtime-entry-brief-1.0';

// Contract §15.3 hook-line byte cap, mirrored as the dispatcher's own
// validation bound: the runtime enforces the cap by tail-row shrink before
// emitting; a line arriving here OVER the cap is therefore malformed output
// from a non-conforming executor and is suppressed, never relayed.
export const ENTRY_BRIEF_LINE_MAX_BYTES = 4096;

// spawnSync maxBuffer for the captured stdout — the "bounded buffer" of the
// validation boundary. A conforming executor emits ≤4096 bytes + newline;
// 64 KiB gives structural headroom while still killing a runaway child
// (spawnSync ENOBUFS ⇒ suppressed) long before an unbounded read.
export const ENTRY_BRIEF_MAX_BUFFER_BYTES = 64 * 1024;

// Any C0/C1 control character (including a bare CR — the line is split on
// LF only), the U+2028/U+2029 line/paragraph separators (line-shaped to a
// separator-honoring consumer), or U+FFFD (the utf8-decode replacement —
// proof of malformed executor bytes) makes the captured line malformed. The
// runtime control-strips before emitting, so any of these here proves a
// non-conforming producer; suppress rather than relay (ADR-0045 §12
// malformed suppression).
const ENTRY_BRIEF_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\uFFFD]/;

// Count non-overlapping occurrences of `needle` in `text` (marker
// singularity check below; the two markers are not substrings of each other).
function countOccurrences(text, needle) {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * The ADR-0045 §7 validation boundary over the captured executor stdout.
 * Accepts EXACTLY one of:
 *   - empty stdout — the gate-off / hook-silent-disposition no-op
 *     (`{ line: null, reason: 'no-line' }`), or
 *   - exactly one marker-paired line (one trailing LF permitted, nothing
 *     else before or after) whose markers each occur exactly once and whose
 *     wrapped payload parses as a plain JSON object self-declaring the
 *     §15.1 schema id — control-free (incl. the U+2028/U+2029 separators a
 *     line-splitting consumer may honor, and U+FFFD, the utf8-decode
 *     replacement that proves malformed executor bytes), within the §15.3
 *     byte cap — returned verbatim as `{ line }` for the hook to relay.
 * Everything else — extra lines, prefix/suffix bytes, an unmarked or
 * half-marked line, duplicate marker pairs on one line, a non-JSON or
 * non-object or wrong-schema payload, an oversized line — is suppressed
 * (`line: null` with a diagnostic reason), never trimmed and never relayed
 * (Codex Plan-verify: the relay must not become an arbitrary
 * context-injection channel for a nonconforming executor). The marker
 * requirement is also what keeps the relayed stdout from ever parsing as a
 * bare JSON hook response: a marker-paired line can never be a
 * `{"continue": false}` document, so the sensor cannot be steered into the
 * one structured output that halts Claude entirely (probed matrix,
 * failure-isolation row) — a marker-WRAPPED `{"continue": false}` is inert
 * data and additionally fails the schema check here.
 */
export function validateEntryBriefStdout(stdoutText) {
  if (typeof stdoutText !== 'string') return { line: null, reason: 'malformed-output' };
  if (stdoutText.length === 0) return { line: null, reason: 'no-line' };
  const body = stdoutText.endsWith('\n') ? stdoutText.slice(0, -1) : stdoutText;
  if (body.length === 0 || body.includes('\n')) {
    return { line: null, reason: 'malformed-output' };
  }
  if (ENTRY_BRIEF_CONTROL_RE.test(body)) {
    return { line: null, reason: 'malformed-output' };
  }
  if (!body.startsWith(`${ENTRY_BRIEF_MARKER_OPEN} `)
    || !body.endsWith(` ${ENTRY_BRIEF_MARKER_CLOSE}`)
    || body.length < ENTRY_BRIEF_MARKER_OPEN.length + ENTRY_BRIEF_MARKER_CLOSE.length + 3) {
    return { line: null, reason: 'malformed-output' };
  }
  if (countOccurrences(body, ENTRY_BRIEF_MARKER_OPEN) !== 1
    || countOccurrences(body, ENTRY_BRIEF_MARKER_CLOSE) !== 1) {
    return { line: null, reason: 'malformed-output' };
  }
  if (Buffer.byteLength(body, 'utf8') > ENTRY_BRIEF_LINE_MAX_BYTES) {
    return { line: null, reason: 'oversized-output' };
  }
  let parsed;
  try {
    parsed = JSON.parse(body.slice(
      ENTRY_BRIEF_MARKER_OPEN.length + 1,
      -(ENTRY_BRIEF_MARKER_CLOSE.length + 1),
    ));
  } catch {
    return { line: null, reason: 'malformed-output' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || parsed.schema !== ENTRY_BRIEF_SCHEMA_ID) {
    return { line: null, reason: 'malformed-output' };
  }
  return { line: body };
}

/**
 * Resolve the runtime root and spawn the ADR-0045 entry-brief arbiter
 * (`context.mjs entry-brief`) with the fixed argv — explicit `--repo-root`,
 * `--host claude`, `--surface session-start-hook` — capturing stdout through
 * the validation boundary above. This is the capability-specific dispatcher
 * ADR-0045 §7 requires as NEW machinery: the notify emit seam discards
 * stdout by contract, while this seam's captured single line IS the payload
 * (the scoped ADR-0040 §2.2 sensor-output exception).
 *
 * Capability-specific DISCOVERY, not just gating (Codex Plan-verify HIGH):
 * the root comes from resolveNewestRuntimePluginRoot — manifest identity
 * alone, no notify.mjs filter — so a runtime build carrying `context.mjs`
 * without `notify.mjs` is still discoverable, and the rung matches the §18
 * readiness diagnosis (newest installed build, then the executor stat).
 *
 * Own capability floor (ADR-0045 §12 triple-floor rule): the resolved
 * runtime root must satisfy ENTRY_BRIEF_MIN_RUNTIME_VERSION — never the
 * notify or publisher floor. The ladder resolves ONE newest root (ADR-0039
 * §5, no stale-cache fallback), then that root is gated twice on this path:
 * version below the entry floor ⇒ silent skip; version passes but
 * `scripts/context.mjs` is absent at the root (capability drift) ⇒ silent
 * skip — never a re-descent to an older-but-capable build; in both cases
 * the other attention capabilities (notifications, capture) are entirely
 * unaffected, and the §18 readiness diagnosis mirrors exactly this
 * executor-existence probe.
 *
 * The executor applies the user-scope-only `entry_brief` gate itself and is
 * hook-grade on its own (exit 0 always, at most the one marker-paired
 * stdout line, at most one stderr line — discarded here); the sensor stays
 * policy-free and relays only a line that survives the validation boundary.
 * spawnSync is bounded by ENTRY_BRIEF_TIMEOUT_MS and
 * ENTRY_BRIEF_MAX_BUFFER_BYTES, with `killSignal: 'SIGKILL'` — the default
 * SIGTERM is trappable, so a misbehaving child could ride past the deadline
 * until the host's own hook timeout (Codex Plan-verify reproduction);
 * SIGKILL makes the slot a real kill bound. A timeout/overflow kills the
 * child and the brief is lost (ADR-0040 §7 fail-closed, never a blocked
 * session entry). The child env is scrubbed of GIT_* (sanitizeSpawnEnv) —
 * the arbiter runs bounded git probes, and inherited GIT_DIR/GIT_WORK_TREE
 * would misdirect them to another repo exactly as on the publisher seam.
 *
 * @returns {Promise<{line: ?string, reason?: string}>}
 */
export async function spawnEntryBrief({
  repoRoot,
  env = process.env,
  home = undefined,
  timeoutMs = ENTRY_BRIEF_TIMEOUT_MS,
} = {}) {
  try {
    if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
      return { line: null, reason: 'bad-args' };
    }
    const runtimeRoot = await resolveNewestRuntimePluginRoot({ env, home });
    if (!runtimeRoot
      || !(await runtimeVersionAtLeast(runtimeRoot, ENTRY_BRIEF_MIN_RUNTIME_VERSION))) {
      return { line: null, reason: 'runtime-below-entry-floor' };
    }
    const contextPath = path.join(runtimeRoot, 'scripts', 'context.mjs');
    if (!fs.existsSync(contextPath)) {
      return { line: null, reason: 'entry-executor-absent' };
    }
    const child = spawnSync(process.execPath, [
      contextPath, 'entry-brief',
      '--repo-root', repoRoot,
      '--host', 'claude',
      '--surface', 'session-start-hook',
    ], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: sanitizeSpawnEnv(env),
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: ENTRY_BRIEF_MAX_BUFFER_BYTES,
      encoding: 'utf8',
    });
    // "Successful child exit" is all three signals at once: no spawn/kill
    // error (timeout and ENOBUFS surface here), no terminating signal, and
    // an exit status of exactly 0 (a conforming hook-grade executor exits 0
    // even for its no-line dispositions — nonzero proves non-conformance).
    if (child.error || child.signal || child.status !== 0) {
      return { line: null, reason: 'executor-failed' };
    }
    return validateEntryBriefStdout(child.stdout ?? '');
  } catch {
    return { line: null, reason: 'spawn-failed' };
  }
}

// ── ADR-0044 §2 capture spawn seam ──

// Publisher-mirror clamp for the relayed session id (session-capture-contract
// §3.1: C0/DEL stripped, 128-char cap, empty ⇒ null). COPY-NOT-IMPORT sibling
// of the runtime publisher's own clampSessionId (context.mjs) — the publisher
// clamps again on its side; mirroring here keeps the argv bounded even against
// a hostile hook payload, and an id that clamps to empty omits the flag
// entirely (matching the publisher's null).
const SESSION_ID_MAX_CHARS = 128;
const SESSION_ID_CONTROL_RE_G = /[\u0000-\u001f\u007f]/g;
export function clampSessionId(value) {
  const text = String(value).replace(SESSION_ID_CONTROL_RE_G, '').slice(0, SESSION_ID_MAX_CHARS);
  return text === '' ? null : text;
}

// Scrub GIT_* from a child spawn env (ADR-0044 §2 fixed-argv/no-inheritance).
// Inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE override git's own
// `-C <repo>` resolution inside the runtime executors, so a capture invoked
// for repo A could resolve configuration and write its slot under repo B
// (Codex review MAJOR). Applied to BOTH spawn seams — the capture publisher
// AND the notify emitter — so the two never diverge: notify.mjs runs no git
// subprocess today, but an emitter probe added later would silently re-open
// the same repo-misdirection hole.
function sanitizeSpawnEnv(env) {
  const clean = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (key.startsWith('GIT_')) continue;
    clean[key] = value;
  }
  return clean;
}

/**
 * Spawn the runtime session-capture publisher (`context.mjs publish-session`)
 * with the ADR-0044 §2 fixed argv — explicit `--repo-root`/`--host claude`,
 * optional clamped `--session-id`, `--workflow-evidence fresh` only when the
 * sensor's own projection read observed a fresh terminal projection (an
 * absent flag is recorded as `none` publisher-side, contract §5.3). No shell,
 * no behavior via inherited env — the child env is the caller's env scrubbed
 * of GIT_* (sanitizeSpawnEnv above).
 *
 * Own capability floor (ADR-0044 §2 dual-floor rule): the resolved runtime
 * root must satisfy PUBLISH_SESSION_MIN_RUNTIME_VERSION — never the notify
 * floor. The ladder resolves ONE best root (ADR-0039 §5, no stale-cache
 * fallback), then that root is gated twice on this path: version below the
 * publisher floor ⇒ silent skip; version passes but `scripts/context.mjs` is
 * absent at the root (capability drift) ⇒ silent skip — in both cases
 * notifications are entirely unaffected.
 *
 * The publisher is hook-grade on its own (exit 0 always, nothing on stdout,
 * at most one stderr line) and applies the `session_capture` config gate
 * itself — the sensor stays policy-free (ADR-0044 §3) and discards child
 * output entirely.
 *
 * spawnSync bounded by ONE budget slot (PUBLISH_SESSION_TIMEOUT_MS) with
 * `killSignal: 'SIGKILL'` — the default SIGTERM is trappable, so a trapped
 * publisher would ride past the slot to the host's own hook timeout (the
 * S9 peer reproduction on the entry-brief spawn; this seam mirrors that
 * bound). The publisher runs bounded git probes (root, branch, head,
 * porcelain — each under its own ~3s cap, sequential) plus local file IO —
 * no network. The probes' theoretical sum can graze the slot, and the
 * accepted degradation for a killed publisher is bounded: it may die
 * holding the capture `.lock`,
 * suppressing further captures until the contract stale-age (60s) allows
 * takeover — notifications are unaffected and the previous turn's slot
 * remains the handoff (the rolling-checkpoint limit; ADR-0040 §7 fail-closed
 * choice, never a blocked host).
 *
 * @returns {Promise<{spawned: boolean, reason?: string}>}
 */
export async function spawnPublishSession({
  repoRoot,
  sessionId = undefined,
  workflowEvidence = undefined,
  env = process.env,
  home = undefined,
  timeoutMs = PUBLISH_SESSION_TIMEOUT_MS,
} = {}) {
  try {
    if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
      return { spawned: false, reason: 'bad-args' };
    }
    const runtimeRoot = await resolveRuntimePluginRoot({ env, home });
    if (!runtimeRoot
      || !(await runtimeVersionAtLeast(runtimeRoot, PUBLISH_SESSION_MIN_RUNTIME_VERSION))) {
      return { spawned: false, reason: 'runtime-below-publisher-floor' };
    }
    const contextPath = path.join(runtimeRoot, 'scripts', 'context.mjs');
    if (!fs.existsSync(contextPath)) {
      return { spawned: false, reason: 'publisher-executor-absent' };
    }
    const argv = [contextPath, 'publish-session', '--repo-root', repoRoot, '--host', 'claude'];
    const clamped = sessionId === undefined || sessionId === null ? null : clampSessionId(sessionId);
    // Leading-hyphen ids are OMITTED, not relayed: the released 0.82.0
    // publisher's argv parser (requireValue) rejects any option value
    // starting with '-', which would silently lose the WHOLE capture.
    // Omitting keeps the structural capture; the root cause is the runtime
    // parser (a future runtime release may accept option-shaped values, but
    // this sensor must stay compatible with the already-released floor).
    if (clamped !== null && !clamped.startsWith('-')) argv.push('--session-id', clamped);
    if (workflowEvidence === 'fresh') argv.push('--workflow-evidence', 'fresh');
    spawnSync(process.execPath, argv, {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: sanitizeSpawnEnv(env),
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    return { spawned: true };
  } catch {
    return { spawned: false, reason: 'spawn-failed' };
  }
}

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

// Read a path ONLY if it is a regular file under the size cap, via a
// single fd — open(O_NOFOLLOW|O_NONBLOCK) → fstat → read — so the check
// and the read judge the SAME inode. The previous stat-then-read pair had
// two holes the Codex review reproduced: statSync FOLLOWS symlinks (a
// symlinked target outside the repo read as valid state), and a target
// swapped between the stat and the read (regular file → FIFO) would block
// the hook past every budget. O_NOFOLLOW refuses a symlink at open
// (ELOOP → the caller's catch); O_NONBLOCK keeps a writer-less FIFO open
// from blocking, and the fstat gate then rejects any non-regular or
// oversized target with null (ADR-0040 §7 never-block contract). Shared
// by the `.git/HEAD` reads, the projection/marker reads above, AND the
// ADR-0047 ledger-handle reads — one guard, every hot-path read.
const REGULAR_FILE_MAX_BYTES = 1024 * 1024;
function readRegularFileSync(filePath) {
  const fd = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > REGULAR_FILE_MAX_BYTES) return null;
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
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
  hostname, topic, sessionHint, headline,
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
  // ADR-0041 §3a Guard 1 — born the opt-in headline token ONLY when it is an exact
  // closed-vocab member (map-or-omit; the caller maps via deriveHeadlineToken). Set
  // verbatim: a valid token is clean and always under HEADLINE_FIELD_CAP, so there
  // is nothing to control-strip or truncate, and the runtime Guard 2 (isHeadlineToken)
  // validates the SAME full value — pre-truncating here could only break that match.
  // Emitting it is inert without the runtime opt-in; a non-token/omitted value simply
  // never sets the field, so the base notification is unaffected. buildEvent stays
  // KIND-AGNOSTIC by design: which kinds may born a token is enforced UPSTREAM
  // (deriveHeadlineToken's closed table — workflow-terminal × archive_gate per
  // ADR-0041 §3a, plus response-needed → your-turn and approval → needs-approval
  // per the ADR-0047 §4 narrow amendment — and each hook's call site), not baked
  // into this generic assembler — the invariant here is vocab membership alone.
  if (isHeadlineToken(headline)) {
    event[OPTIONAL_HEADLINE_FIELD] = headline;
  }
  if (refs && typeof refs === 'object' && !Array.isArray(refs)) {
    event.refs = refs;
  }
  return event;
}

/**
 * Emit a batch of terminal events under one monotonic deadline. Each emission
 * gets the FULL `minSlotMs` timeout or does not start at all — a partial slot
 * would kill an in-flight runtime egress dispatch before its own 8s network
 * deadline (see the emitEvent timeout contract below), which is worse than
 * dropping the event outright. `deadlineMs` bounds the host's Stop latency:
 * four fresh personas × the 12s per-emit bound could otherwise hold Stop for
 * ~48s during egress trouble; two full slots (24s) is the accepted worst
 * case, and every dropped remainder is the ADR-0040 §7 fail-closed choice
 * (a lost notification, never a blocked host or a truncated dispatch).
 * `emit`/`now` are injectable for deterministic tests only.
 *
 * @returns {Promise<{emitted: number, dropped: number}>}
 */
export async function emitTerminalEvents({
  repoRoot,
  events,
  deadlineMs = TERMINAL_BATCH_DEADLINE_MS,
  minSlotMs = EMIT_SLOT_MS,
  emit = emitEvent,
  now = Date.now,
} = {}) {
  const list = Array.isArray(events) ? events : [];
  const deadline = now() + deadlineMs;
  let emitted = 0;
  for (const event of list) {
    if (deadline - now() < minSlotMs) break;
    await emit({ repoRoot, event, timeoutMs: minSlotMs });
    emitted += 1;
  }
  return { emitted, dropped: list.length - emitted };
}

/**
 * Resolve the runtime root (version-gated per the copied discover-runtime
 * ladder) and hand ONE event to `notify.mjs emit` — stdin JSON, explicit
 * `--repo-root` so the emitter's state home matches the sensor's repo. The
 * child's stdout/stderr are discarded: the sensor owns the "never stdout"
 * contract and the emitter is fail-closed silent on its own.
 *
 * spawnSync (bounded by `timeoutMs`, `killSignal: 'SIGKILL'`) rather than
 * fire-and-forget: a synchronous bound keeps the hook's lifetime
 * deterministic. A timeout kills the child and loses the notification —
 * acceptable by the ADR-0040 §7 fail-closed contract. SIGKILL because the
 * default SIGTERM is trappable — a trapped emitter would ride past the slot
 * to the host's own hook timeout (the S9 peer reproduction on the
 * entry-brief spawn; this seam mirrors that bound).
 *
 * `timeoutMs` MUST exceed the runtime emitter's OWN network budget (notify.mjs
 * TELEGRAM_API_TIMEOUT_MS, currently 8s for the ADR-0041 §2d Telegram egress
 * channel) plus node-startup + emit-preflight overhead — otherwise this spawn kill
 * would pre-empt an in-flight egress dispatch before its 8s deadline, re-introducing
 * the intermittent notification loss the longer egress budget exists to fix. 12s =
 * the 8s network budget + ~4s headroom for node startup and the preflight. The
 * personal curl prototype used a 10s spawn bound over curl -m 8 (a 2s margin), but
 * node's startup is slower and more load-sensitive than curl's fast exec, so the
 * margin is widened here so a cold/loaded host cannot kill an otherwise-valid
 * full-budget dispatch (peer review MINOR). The local notify channels (file-log /
 * macos-osascript) still return promptly; only the egress channel approaches this
 * bound, and only during a network blip.
 *
 * @returns {Promise<{emitted: boolean, reason?: string}>}
 */
export async function emitEvent({
  repoRoot,
  event,
  env = process.env,
  home = undefined,
  timeoutMs = EMIT_SLOT_MS,
  // ADR-0047 §9 — a kind minted behind a HIGHER capability floor threads
  // that floor here so the ladder's version gate and the emit spawn judge
  // the SAME root against the SAME bound (a cache swap between the caller's
  // gate and this resolve cannot hand e.g. a response-needed event to a
  // pre-contract runtime whose validateEvent rejects it — silent loss, §8
  // failure 1). Default stays the notify floor for every pre-ADR-0047 kind.
  minVersion = MIN_RUNTIME_VERSION,
} = {}) {
  try {
    if (typeof repoRoot !== 'string' || repoRoot.length === 0 || !event) {
      return { emitted: false, reason: 'bad-args' };
    }
    const runtimeRoot = await discoverRuntimePluginRoot({ env, home, minVersion });
    if (!runtimeRoot) return { emitted: false, reason: 'runtime-unresolved' };
    const notifyPath = path.join(runtimeRoot, 'scripts', 'notify.mjs');
    spawnSync(process.execPath, [notifyPath, 'emit', '--repo-root', repoRoot], {
      input: `${JSON.stringify(event)}\n`,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: sanitizeSpawnEnv(env),
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    return { emitted: true };
  } catch {
    return { emitted: false, reason: 'spawn-failed' };
  }
}
