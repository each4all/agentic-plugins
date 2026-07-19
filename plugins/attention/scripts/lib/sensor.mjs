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
  PUBLISH_SESSION_MIN_RUNTIME_VERSION,
  discoverRuntimePluginRoot,
  resolveRuntimePluginRoot,
  runtimeVersionAtLeast,
} from '../discover-runtime.mjs';

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

// ADR-0041 §3a Guard 1 (producer map-or-omit). Maps the STRUCTURED signals the
// Stop sensor already holds — the event `kind` + the projection `archive_gate`
// (the real values the persona mapArchiveGate copies emit: ready_to_archive /
// not_terminal / blocked) — to a closed-vocabulary headline token, or null (OMIT).
// It NEVER guesses: an unknown/absent archive_gate or a non-workflow-terminal kind
// yields null so buildEvent omits headline entirely (never a wrong token). At v1
// only the workflow-terminal kind carries a fresh projection; the bare turn-complete
// deliberately produces no token (a kind-only token would overstate a single turn as
// session status — ADR-0041 §3a "Claude-Stop-only", Codex-shuttle-omits). The final
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
 * spawnSync bounded by ONE budget slot (PUBLISH_SESSION_TIMEOUT_MS): the
 * publisher runs bounded git probes (root, branch, head, porcelain — each
 * under its own ~3s cap, sequential) plus local file IO — no network. The
 * probes' theoretical sum can graze the slot, and the accepted degradation
 * for a killed publisher is bounded: it may die holding the capture `.lock`,
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

// Read a path ONLY if it is a regular file under the size cap. statSync
// returns metadata without blocking (even on a FIFO); readFileSync on a
// FIFO/device WOULD block the hook path indefinitely — the isFile() gate is
// what keeps a malicious or broken target (a FIFO, directory, or device
// node) from hanging the sensor (ADR-0040 §7 never-block contract). Shared
// by the `.git/HEAD` reads AND the projection/marker reads above; the size
// cap bounds a pathological regular file on the same hot path. Returns null
// for any non-regular or oversized target.
const REGULAR_FILE_MAX_BYTES = 1024 * 1024;
function readRegularFileSync(filePath) {
  const st = fs.statSync(filePath);
  if (!st.isFile() || st.size > REGULAR_FILE_MAX_BYTES) return null;
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
  // KIND-AGNOSTIC by design: the vocab carries tokens for non-terminal kinds
  // (needs-approval / your-turn) reserved for future producers, so the v1
  // "workflow-terminal-only" rule is enforced UPSTREAM (deriveHeadlineToken + the
  // Stop call site passing headline only on the workflow-terminal path), not baked
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
 * spawnSync (bounded by `timeoutMs`) rather than fire-and-forget: a synchronous
 * bound keeps the hook's lifetime deterministic. A timeout kills the child and
 * loses the notification — acceptable by the ADR-0040 §7 fail-closed contract.
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
      env: sanitizeSpawnEnv(env),
      timeout: timeoutMs,
    });
    return { emitted: true };
  } catch {
    return { emitted: false, reason: 'spawn-failed' };
  }
}
