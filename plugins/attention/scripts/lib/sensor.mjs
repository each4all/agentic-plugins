// plugins/attention/scripts/lib/sensor.mjs
//
// Shared sensor library for the attention hook sensors (Stop, ADR-0044, and
// SessionStart, ADR-0045). Three responsibilities:
//
//   1. The freshness-checked `last-session-handoff.json` projection read
//      (workflow-id consistency + mtime bound + the per-persona
//      `.footer-rendered` marker). Its verdict is the Stop sensor's
//      `--workflow-evidence` relay to the capture publisher. Sensors are
//      self-contained observers — Claude fires all plugins' Stop hooks with no
//      ordering guarantee, so a sensor never assumes a persona Stop hook ran
//      first; a stale or missing projection is simply not evidence.
//
//   2. The capture spawn seam: resolve the runtime root by manifest identity
//      via the copied discover-runtime.mjs (ADR-0039 §5 ladder) and spawn
//      `context.mjs publish-session` behind the publisher floor.
//
//   3. The entry-brief seam: the same resolution, behind the entry-brief
//      floor, spawning `context.mjs entry-brief` and relaying at most one
//      validated line.
//
// ADR-0064 removed the notification group this library used to carry (event
// building, the Stop finality classifier, and the `notify.mjs emit` seam).
//
// Fail-closed contract (ADR-0040 §7): every function here returns null /
// a result object instead of surfacing failures; nothing in this module
// writes to stdout (only the SessionStart hook relays the one validated
// entry-brief line) or throws for environmental conditions.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  ENTRY_BRIEF_MIN_RUNTIME_VERSION,
  PUBLISH_SESSION_MIN_RUNTIME_VERSION,
  resolveNewestRuntimePluginRoot,
  runtimeVersionAtLeast,
} from '../discover-runtime.mjs';

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
// identical to the runtime's own resolveRepoRoot (lib/repo-root.mjs), so the
// root the sensor passes as --repo-root is the one the executors would find.
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

// ── Freshness-checked projection read (ADR-0044 §5.3 workflow evidence) ──

// The personas whose ADR-0031/0039 sidecars the Stop sensor reads.
// The ADR-0043 §3 follow-up landed once its trigger fired: founder (S3,
// plugin-founder-v0.4.0) and designer (S4, plugin-designer-v0.3.0) sidecars
// emit projections + footer-rendered markers in the wild, and those two
// document their marker shape as a cross-package contract in their own
// `core/skills/_shared/references/session-handoff.md` (ADR-0043 §2); this
// sensor encodes that contract for them. For engineer and orchestrator the
// sensor copies the shapes from their session-handoff scripts (see
// MARKER_SHAPE_BY_PERSONA). Rollback note: attention owns no durable state
// of its own; its sensors can cause runtime-owned writes. Rolling back
// attention does not remove durable session-capture files (ADR-0044 §10
// covers their cleanup), and ADRs such as ADR-0044 §10 and ADR-0045 §12
// order it against config and runtime.
export const SENSOR_PERSONAS = Object.freeze(['engineer', 'orchestrator', 'founder', 'designer']);

// Freshness bound for "this projection describes the terminal transition the
// CURRENT Stop is observing", applied to BOTH signals readFreshProjection
// gates on: the projection file's mtime AND the rendered marker's `at`
// timestamp (the render moment — the transition anchor). The dual anchor
// matters for the manually-published personas (founder/designer): their
// publish-needed workflows stay active-terminal and their persona Stop
// backstop rewrites the projection every turn (fresh mtime indefinitely),
// but the rendered marker's `at` is written once per terminal transition —
// so the evidence holds near the transition and later turns stop relaying
// it, instead of reporting fresh terminal evidence for as long as the
// workflow stays active-terminal. A primary re-terminalization rewrites the
// marker (new `at`) and re-arms the evidence for the new transition.
// Stale on either anchor ⇒ no fresh evidence.
export const HANDOFF_FRESHNESS_MS = 10 * 60 * 1000;

// Maximum tolerated FUTURE skew on either freshness anchor. `now` is captured
// once before the per-persona reads, so a legitimately-concurrent persona
// write can postdate it by milliseconds — but a far-future mtime or marker
// `at` is malformed state, and malformed must degrade, never count (a
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
// candidate fail-closes to no evidence rather than trusting the
// shadowed second home (never a wrong workflow claim). founder/designer are
// canonical-home-only — no legacy home ever existed for them (ADR-0036 SD5 /
// ADR-0042 SD7) — so their candidate list deliberately models only the path
// their writers can produce.
// The candidates are this checkout's homes only, never the shared state root
// workflow records are read from in a linked worktree (ADR-0067 Decision 1(a),
// W9): the slot is this checkout's last terminal handoff, and read from the
// main worktree it would relay another session's completion as this one's.
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
// no evidence) until its shape is deliberately added here. Copied
// shapes, canonical sources (founder/designer document theirs as the
// ADR-0043 §2 cross-package contract):
//   engineer:     `${projectionFile}.footer-rendered`
//                 (plugins/engineer/scripts/session-handoff.mjs)
//   orchestrator: `${projectionFile}.${safeWorkflowId}.footer-rendered`
//                 (plugins/orchestrator/scripts/session-handoff.mjs)
//   founder:      `${projectionFile}.footer-rendered`
//                 (plugins/founder/core/skills/_shared/references/session-handoff.md)
//   designer:     `${projectionFile}.footer-rendered`
//                 (plugins/designer/core/skills/_shared/references/session-handoff.md)
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

// Projection/marker reads go through a regular-file gate
// (readRegularFileSync): an unbounded readFileSync on a repo-controlled
// FIFO/device at a projection path would block the WHOLE Stop sensor before
// capture — outside every timeout, so
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
 *     never count,
 *   - the per-persona footer-rendered marker exists with the SAME workflow_id,
 *     status 'rendered' (a bare 'claimed' marker is a render in flight or one
 *     that crashed — not a completed terminal presentation), AND an `at`
 *     render timestamp within HANDOFF_FRESHNESS_MS — the transition anchor
 *     (persona Stop backstops refresh the projection mtime but never a
 *     rendered marker's `at`, so this is what ties the evidence to the
 *     terminal TRANSITION rather than to a persisting active-terminal state).
 * Any gate failing returns null and the caller relays no workflow evidence —
 * never a wrong claim. Best-effort/last-observed: Claude fires Stop hooks with
 * no cross-plugin ordering, so the projection read here is the persona's
 * last-observed terminal state, not necessarily this instant's.
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

// ── ADR-0044 §2 Stop hot-path budget (contract values) ──

// The Stop hook's worst-case latency is a CONTRACT, not an accident of local
// defaults. The capture spawn is the hook's only child, bounded by one slot,
// so the aggregate is that slot (12s), reached only when the publisher runs
// to its kill bound. Changing either value is a contract change (README
// § Stop hot-path budget); the plugin-shape test pins both.
export const PUBLISH_SESSION_TIMEOUT_MS = 12_000;
export const STOP_HOT_PATH_BUDGET_MS = PUBLISH_SESSION_TIMEOUT_MS;

// ── ADR-0045 §11 SessionStart latency budget (contract values) ──

// The entry-brief executor spawn's kill bound: one 12 s slot. This
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
 * ADR-0045 §7 requires: the capture seam discards child stdout, while this
 * seam's captured single line IS the payload (the scoped ADR-0040 §2.2
 * sensor-output exception).
 *
 * Capability-specific DISCOVERY, not just gating (Codex Plan-verify HIGH):
 * the root comes from resolveNewestRuntimePluginRoot — manifest identity
 * alone, no capability-file filter — so the rung matches the §18 readiness
 * diagnosis (newest installed build, then the executor stat).
 *
 * Own capability floor (ADR-0045 §12 floor rule): the resolved runtime root
 * must satisfy ENTRY_BRIEF_MIN_RUNTIME_VERSION — never the publisher floor.
 * The ladder resolves ONE newest root (ADR-0039
 * §5, no stale-cache fallback), then that root is gated twice on this path:
 * version below the entry floor ⇒ silent skip; version passes but
 * `scripts/context.mjs` is absent at the root (capability drift) ⇒ silent
 * skip — never a re-descent to an older-but-capable build; in both cases
 * capture is entirely unaffected, and the §18 readiness diagnosis mirrors
 * exactly this executor-existence probe.
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
// AND the entry-brief arbiter, which runs git probes of its own.
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
 * Discovery by manifest identity (ADR-0064 Decision 1): the root comes from
 * resolveNewestRuntimePluginRoot, the resolver the entry-brief seam uses —
 * no capability-file filter, so the newest installed runtime is found
 * whatever other executors it ships. Own capability floor (ADR-0044 §2):
 * that root must satisfy PUBLISH_SESSION_MIN_RUNTIME_VERSION — never the
 * entry-brief floor. The ladder resolves ONE newest root (ADR-0039 §5, no
 * stale-cache fallback), then that root is gated twice on this path: version
 * below the publisher floor ⇒ silent skip; version passes but
 * `scripts/context.mjs` is absent at the root (capability drift) ⇒ silent
 * skip — never a re-descent to an older-but-capable build, and in both cases
 * the entry brief is entirely unaffected.
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
 * takeover — the previous turn's slot remains the handoff (the
 * rolling-checkpoint limit; ADR-0040 §7 fail-closed
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
    const runtimeRoot = await resolveNewestRuntimePluginRoot({ env, home });
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

// Read a path ONLY if it is a regular file under the size cap, via a
// single fd — open(O_NOFOLLOW|O_NONBLOCK) → fstat → read — so the check
// and the read judge the SAME inode. The previous stat-then-read pair had
// two holes the Codex review reproduced: statSync FOLLOWS symlinks (a
// symlinked target outside the repo read as valid state), and a target
// swapped between the stat and the read (regular file → FIFO) would block
// the hook past every budget. O_NOFOLLOW refuses a symlink at open
// (ELOOP → the caller's catch); O_NONBLOCK keeps a writer-less FIFO open
// from blocking, and the fstat gate then rejects any non-regular or
// oversized target with null (ADR-0040 §7 never-block contract). Every
// projection/marker read above goes through it.
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
