// Permission advisory ARTIFACT slice (ADR-0038 §5/§7).
//
// The sanitized plan/evidence artifact ENVELOPE for the runtime permission
// advisor, plus its latest pointer, retention/inventory family registration,
// and pointer-only (text/json) output. Both operator surfaces write through
// this module: `runtime:doctor` (R0 diagnosis -> surface='doctor') and
// `runtime:settings` (M1 plan -> surface='settings'). They render/diagnose;
// THIS module owns persistence and the on-disk shape.
//
// DESIGN DECISION — "run-family vs settings-artifact reuse" (the macro plan's
// open question for this slice): the artifact reuses the SETTINGS-ARTIFACT
// shape, NOT the consensus run-family state machine. A permission advisory is
// a point-in-time snapshot (diagnose -> recommend), so it wants settings'
// fresh-per-run directory + an overwritten `latest.json` singleton pointer —
// not consensus's multi-round mutable manifest, terminal-gated mutation, and
// scan-and-sort `--latest-open` selection (machinery for a deliberation
// lifecycle this artifact does not have). Layout, mirroring
// `runs/settings/<runId>/settings.json`:
//
//   .agentic-plugins/runs/permission/
//   ├── latest.json                      # overwritten singleton pointer
//   └── permission-<stamp>-<hex>/
//       └── advisory.json                # one run's sanitized plan+evidence
//
// A directory-per-run keeps doctor's subdirectory-counting inventory honest
// (doctor counts `entries.filter(isDirectory)` as runs, so the latest.json
// file is correctly NOT counted as a run).
//
// RETENTION: this module does NOT prune. It registers the `permission` family
// with doctor's inventory (see RUNTIME_ARTIFACT_FAMILIES in doctor.mjs), whose
// uniform retention cap reports pressure advisorily. Deletion stays a manual /
// explicit operator action — matching every other runtime artifact family and
// ADR-0035's no-silent-destructive posture; doctor itself never deletes.
//
// BOUNDARY (ADR-0038 §3/§5, ADR-0035 §4/§6): writes ONLY agentic-plugins-owned
// `.agentic-plugins/**` artifacts (M1) — never host config (H2/H3), never a
// permission-relaxing hook. Every retained value is sanitized; raw transcript
// SOURCE PATHS are dropped entirely (not merely sanitized) so a local
// username / private path never lands in an artifact. Secret redaction and
// command generalization are delegated to the sanitize util; grade/rule/
// fragment shaping to advisor-core. The artifact is stamped with both the
// envelope schema version and advisor-core's schema version so a stale on-disk
// shape is rejected rather than mis-rendered.

import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { resolve, relative, sep, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { RUNTIME_VERSION } from '../version.mjs';
import {
  ADVISOR_SCHEMA_VERSION,
  ADVISOR_INVARIANTS,
  isAdvisorHost,
  isPromptCause,
  isValidRule,
  isValidFragmentContract,
} from './permission-advisor-core.mjs';
import { singleLine, sanitizeValue } from './permission-sanitize.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PERMISSION_ARTIFACT_SCHEMA_VERSION = 'runtime-permission-advisory-1.0';
export const PERMISSION_LATEST_SCHEMA_VERSION = 'runtime-permission-advisory-latest-1.0';
export const PERMISSION_ARTIFACT_KIND = 'permission-advisory';

// The on-disk family segment under .agentic-plugins/runs/. Must be added to
// doctor.mjs RUNTIME_ARTIFACT_FAMILIES so the inventory + retention reporting
// covers it (the "inventory integration" deliverable).
export const PERMISSION_ARTIFACT_FAMILY = 'permission';

// Which operator surface produced a run. A closed enum so an artifact can be
// attributed to doctor (R0 diagnosis) or settings (M1 plan) and nothing else.
export const PERMISSION_ARTIFACT_SURFACES = Object.freeze(['doctor', 'settings']);

// 'analyzed'  -> recommendations grounded in observed usage evidence.
// 'baseline'  -> no usable usage record; conservative known-safe baseline
//                (ADR-0038 §2 fallback, labelled as such).
export const PERMISSION_ARTIFACT_STATUSES = Object.freeze(['analyzed', 'baseline']);

// permission-YYYYMMDDTHHMMSSZ-<6hex> (mirrors the consensus/settings run-id
// shape so all families validate identically).
export const PERMISSION_RUN_ID_RE = /^permission-\d{8}T\d{6}Z-[0-9a-f]{6}$/;

// ---------------------------------------------------------------------------
// Run id
// ---------------------------------------------------------------------------

// Build a run id from an injected clock (a Date or ms). The clock is a
// parameter — never read internally — so callers stay deterministic in tests.
export function makePermissionRunId(now) {
  const d = now instanceof Date ? now : new Date(now);
  const stamp = d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `permission-${stamp}-${randomBytes(3).toString('hex')}`;
}

export function isValidPermissionRunId(runId) {
  return typeof runId === 'string' && PERMISSION_RUN_ID_RE.test(runId);
}

// Throwing guard used at every path-construction boundary so a traversal-shaped
// or malformed id can never escape runs/permission/ (mirrors consensus/settings
// validateRunId).
export function validatePermissionRunId(runId) {
  if (!isValidPermissionRunId(runId)) {
    throw new Error(
      `invalid permission run id '${runId}' (expected permission-YYYYMMDDTHHMMSSZ-<6hex>)`,
    );
  }
  return runId;
}

// ---------------------------------------------------------------------------
// Path resolution (settings-artifact layout)
// ---------------------------------------------------------------------------

export function permissionRunRoot(repoRoot) {
  return resolve(repoRoot, '.agentic-plugins', 'runs', PERMISSION_ARTIFACT_FAMILY);
}

export function permissionRunDir(repoRoot, runId) {
  return resolve(permissionRunRoot(repoRoot), validatePermissionRunId(runId));
}

export function permissionArtifactFile(repoRoot, runId) {
  return resolve(permissionRunDir(repoRoot, runId), 'advisory.json');
}

export function permissionLatestFile(repoRoot) {
  return resolve(permissionRunRoot(repoRoot), 'latest.json');
}

// Repo-relative, posix-separated pointer (never an absolute path in output).
function pointer(repoRoot, path) {
  return relative(repoRoot, path).split(sep).join('/');
}

// ---------------------------------------------------------------------------
// Envelope construction
// ---------------------------------------------------------------------------

function toCount(value) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

// Normalize a usage-learner learnFromSources() summary into the sanitized
// evidence sub-record, scoped to the artifact's host set. Critical steps:
//   - source PATHS are dropped entirely (ADR-0038 §5 / ADR-0035 §6 — no
//     source-path dumps), keeping only host + status + counts;
//   - every rule / source / mode-evidence row whose host is outside the
//     artifact's host set is dropped, so a Claude-only artifact can never carry
//     Codex evidence (Plan-verify peer MINOR #4);
//   - rule free-text (reason, evidence note) is re-sanitized as defense-in-depth
//     against a hand-built rule that slipped past isValidRule, which checks
//     structure but not sanitization (Plan-verify peer MAJOR #1).
function normalizeEvidence(evidence, hostList) {
  if (!evidence || typeof evidence !== 'object') return null;
  const inHosts = (h) => isAdvisorHost(h) && hostList.includes(h);
  const sources = (Array.isArray(evidence.sources) ? evidence.sources : [])
    .map((s) => ({
      host: isAdvisorHost(s?.host) ? s.host : null,
      status: typeof s?.status === 'string' ? sanitizeValue(s.status) : null,
      observation_count: toCount(s?.observationCount ?? s?.observation_count),
      malformed_lines: toCount(s?.malformedLines ?? s?.malformed_lines),
      // Intentionally NO `path`: a raw transcript path may embed a local
      // username or secret; it must never survive into the artifact.
    }))
    .filter((s) => inHosts(s.host));
  const rules = (Array.isArray(evidence.rules) ? evidence.rules : [])
    .filter((r) => isValidRule(r) && inHosts(r.host))
    .map((r) => Object.freeze({
      ...r,
      reason: r.reason === null || r.reason === undefined ? null : sanitizeValue(r.reason),
      evidence: Object.freeze({
        ...r.evidence,
        note: r.evidence?.note === null || r.evidence?.note === undefined ? null : sanitizeValue(r.evidence.note),
      }),
    }));
  const modeEvidence = (Array.isArray(evidence.modeEvidence ?? evidence.mode_evidence)
    ? (evidence.modeEvidence ?? evidence.mode_evidence)
    : [])
    .map((m) => ({
      host: isAdvisorHost(m?.host) ? m.host : null,
      cause: isPromptCause(m?.cause) ? m.cause : null,
      count: toCount(m?.count),
    }))
    .filter((m) => inHosts(m.host) && m.cause);
  return Object.freeze({
    status: typeof evidence.status === 'string' ? sanitizeValue(evidence.status) : 'unknown',
    source_count: sources.length,
    sources: Object.freeze(sources.map((s) => Object.freeze(s))),
    rules: Object.freeze(rules),
    mode_evidence: Object.freeze(modeEvidence.map((m) => Object.freeze(m))),
    baseline_count: toCount(evidence.baselineCount ?? evidence.baseline_count),
    baseline_used: Boolean(evidence.baselineUsed ?? evidence.baseline_used),
  });
}

function deriveStatus(evidenceRecord) {
  if (!evidenceRecord) return 'baseline';
  return evidenceRecord.baseline_used ? 'baseline' : 'analyzed';
}

function normalizeCreatedAt(createdAt) {
  if (createdAt === null || createdAt === undefined) return new Date().toISOString();
  if (createdAt instanceof Date) return createdAt.toISOString();
  return singleLine(String(createdAt));
}

// Build a validated, frozen permission advisory artifact. The plan is an array
// of advisor-core fragment contracts (one per host) or null for an R0 doctor
// run that only diagnoses; the evidence is a usage-learner summary or null.
// Throws on an unknown surface, an empty/unknown host set, or a plan fragment
// that is invalid or targets a host outside the artifact's host set — so a
// malformed artifact never reaches disk.
export function makePermissionAdvisoryArtifact({
  runId,
  surface,
  hosts = [],
  plan = null,
  evidence = null,
  notes = [],
  runtimeVersion = RUNTIME_VERSION,
  createdAt,
} = {}) {
  validatePermissionRunId(runId);
  if (!PERMISSION_ARTIFACT_SURFACES.includes(surface)) {
    throw new Error(
      `makePermissionAdvisoryArtifact: unknown surface '${surface}' (expected ${PERMISSION_ARTIFACT_SURFACES.join(', ')})`,
    );
  }
  const hostList = [...new Set((Array.isArray(hosts) ? hosts : []).filter(isAdvisorHost))];
  if (hostList.length === 0) {
    throw new Error('makePermissionAdvisoryArtifact: at least one valid host is required');
  }

  let planList = null;
  if (plan !== null && plan !== undefined) {
    if (!Array.isArray(plan)) {
      throw new Error('makePermissionAdvisoryArtifact: plan must be an array of fragment contracts or null');
    }
    planList = plan.map((fragment) => {
      if (!isValidFragmentContract(fragment)) {
        throw new Error('makePermissionAdvisoryArtifact: plan[] contains an invalid fragment contract');
      }
      if (!hostList.includes(fragment.host)) {
        throw new Error(
          `makePermissionAdvisoryArtifact: plan fragment host '${fragment.host}' is not in artifact hosts [${hostList.join(', ')}]`,
        );
      }
      return fragment;
    });
  }

  const evidenceRecord = normalizeEvidence(evidence, hostList);
  const noteList = (Array.isArray(notes) ? notes : [])
    .map((note) => sanitizeValue(note))
    .filter(Boolean);

  return Object.freeze({
    schema_version: PERMISSION_ARTIFACT_SCHEMA_VERSION,
    advisor_schema_version: ADVISOR_SCHEMA_VERSION,
    runtime_version: typeof runtimeVersion === 'string' && runtimeVersion ? runtimeVersion : RUNTIME_VERSION,
    kind: PERMISSION_ARTIFACT_KIND,
    run_id: runId,
    surface,
    status: deriveStatus(evidenceRecord),
    created_at: normalizeCreatedAt(createdAt),
    repo_root_pointer: '.',
    hosts: Object.freeze(hostList),
    plan: planList ? Object.freeze(planList) : null,
    evidence: evidenceRecord,
    notes: Object.freeze(noteList),
    boundary: Object.freeze({
      writes_host_config: ADVISOR_INVARIANTS.writesHostConfig,
      ships_guard_hook: ADVISOR_INVARIANTS.shipsGuardHook,
      recommends_bypass_by_default: ADVISOR_INVARIANTS.recommendsBypassByDefault,
    }),
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Exact key whitelists. The structural validator rejects ANY unknown key at
// each level, so a hand-built artifact cannot smuggle a leak-shaped field
// (`source_path`, an extra top-level dump, a raw `path`) past the writer — the
// privacy gate is closed by construction, not by enumerating known-bad keys
// (Plan-verify peer MAJOR #1).
const ARTIFACT_KEYS = new Set([
  'schema_version', 'advisor_schema_version', 'runtime_version', 'kind', 'run_id',
  'surface', 'status', 'created_at', 'repo_root_pointer', 'hosts', 'plan', 'evidence',
  'notes', 'boundary',
]);
const EVIDENCE_KEYS = new Set([
  'status', 'source_count', 'sources', 'rules', 'mode_evidence', 'baseline_count', 'baseline_used',
]);
const EVIDENCE_SOURCE_KEYS = new Set(['host', 'status', 'observation_count', 'malformed_lines']);
const MODE_EVIDENCE_KEYS = new Set(['host', 'cause', 'count']);
const BOUNDARY_KEYS = new Set(['writes_host_config', 'ships_guard_hook', 'recommends_bypass_by_default']);
const LATEST_POINTER_KEYS = new Set([
  'schema_version', 'kind', 'run_id', 'surface', 'status', 'hosts', 'updated_at',
  'report_pointer', 'run_pointer',
]);

function onlyKnownKeys(obj, allowed) {
  return Boolean(obj) && typeof obj === 'object' && Object.keys(obj).every((k) => allowed.has(k));
}

// Schema-currency gate: the on-disk shape matches THIS runtime's envelope +
// advisor-core schema versions. A stale artifact is rejected by the loader
// rather than mis-rendered (ADR-0038 §5 / advisor-core comment).
export function isCurrentPermissionAdvisoryArtifact(artifact) {
  return (
    Boolean(artifact) &&
    typeof artifact === 'object' &&
    artifact.schema_version === PERMISSION_ARTIFACT_SCHEMA_VERSION &&
    artifact.advisor_schema_version === ADVISOR_SCHEMA_VERSION
  );
}

// Structural validator. Mirrors the constructor's guarantees AND enforces the
// privacy + boundary invariants on a possibly-hand-edited on-disk artifact:
// no source-path leak, and the boundary flags stamped to their only legal
// (false) values.
export function isValidPermissionAdvisoryArtifact(artifact) {
  if (!onlyKnownKeys(artifact, ARTIFACT_KEYS)) return false;
  if (artifact.kind !== PERMISSION_ARTIFACT_KIND) return false;
  if (artifact.schema_version !== PERMISSION_ARTIFACT_SCHEMA_VERSION) return false;
  if (artifact.advisor_schema_version !== ADVISOR_SCHEMA_VERSION) return false;
  if (!isValidPermissionRunId(artifact.run_id)) return false;
  if (!PERMISSION_ARTIFACT_SURFACES.includes(artifact.surface)) return false;
  if (!PERMISSION_ARTIFACT_STATUSES.includes(artifact.status)) return false;
  if (typeof artifact.created_at !== 'string' || !artifact.created_at) return false;
  if (artifact.repo_root_pointer !== '.') return false;
  if (
    !Array.isArray(artifact.hosts) ||
    artifact.hosts.length === 0 ||
    !artifact.hosts.every(isAdvisorHost)
  ) {
    return false;
  }
  if (!Array.isArray(artifact.notes) || !artifact.notes.every((n) => typeof n === 'string')) return false;
  if (artifact.plan !== null) {
    if (!Array.isArray(artifact.plan)) return false;
    if (!artifact.plan.every((f) => isValidFragmentContract(f) && artifact.hosts.includes(f.host))) {
      return false;
    }
  }
  if (artifact.evidence !== null) {
    const ev = artifact.evidence;
    if (!onlyKnownKeys(ev, EVIDENCE_KEYS)) return false;
    if (!Array.isArray(ev.rules) || !ev.rules.every((r) => isValidRule(r) && artifact.hosts.includes(r.host))) {
      return false;
    }
    if (!Array.isArray(ev.sources)) return false;
    for (const s of ev.sources) {
      // Exact key set rejects a raw `path` / `source_path` leak; host-scope
      // rejects foreign-host evidence (Plan-verify peer MAJOR #1 + MINOR #4).
      if (!onlyKnownKeys(s, EVIDENCE_SOURCE_KEYS)) return false;
      if (s.host !== null && !artifact.hosts.includes(s.host)) return false;
    }
    if (!Array.isArray(ev.mode_evidence)) return false;
    for (const m of ev.mode_evidence) {
      if (!onlyKnownKeys(m, MODE_EVIDENCE_KEYS)) return false;
      if (!artifact.hosts.includes(m.host)) return false;
    }
  }
  if (!onlyKnownKeys(artifact.boundary, BOUNDARY_KEYS)) return false;
  if (artifact.boundary.writes_host_config !== false) return false;
  if (artifact.boundary.ships_guard_hook !== false) return false;
  if (artifact.boundary.recommends_bypass_by_default !== false) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

// Atomic write: serialize to a sibling temp file then rename, so a crash or a
// concurrent doctor+settings write can never leave a half-written advisory.json
// / latest.json on disk (Plan-verify peer MINOR #3). rename(2) within the same
// directory is atomic on POSIX. This is stricter than the consensus/settings
// precedent (plain writeFile) — a deliberate root-cause improvement for an
// artifact two operator surfaces write.
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

// Read + parse, classifying the three outcomes the gated loaders need: a
// missing file, a truncated/corrupt body (invalid_json — surfaced as data, not
// thrown at the caller), and a clean parse (Plan-verify peer MINOR #3).
async function readJsonSafe(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { status: 'missing', value: null };
    throw err;
  }
  try {
    return { status: 'ok', value: JSON.parse(text) };
  } catch {
    return { status: 'invalid_json', value: null };
  }
}

// Write a run's advisory.json under its per-run directory and overwrite the
// family-root latest.json singleton pointer. Refuses to write a structurally
// invalid artifact. Returns the repo-relative pointer set.
export async function writePermissionAdvisoryArtifact({ repoRoot, artifact }) {
  if (!isValidPermissionAdvisoryArtifact(artifact)) {
    throw new Error(
      'writePermissionAdvisoryArtifact: artifact failed validation (refusing to write a malformed permission advisory)',
    );
  }
  const runId = artifact.run_id;
  const reportPath = permissionArtifactFile(repoRoot, runId);
  await writeJson(reportPath, artifact);

  const latestPath = permissionLatestFile(repoRoot);
  await writeJson(latestPath, {
    schema_version: PERMISSION_LATEST_SCHEMA_VERSION,
    kind: PERMISSION_ARTIFACT_KIND,
    run_id: runId,
    surface: artifact.surface,
    status: artifact.status,
    hosts: artifact.hosts,
    updated_at: artifact.created_at,
    report_pointer: pointer(repoRoot, reportPath),
    run_pointer: pointer(repoRoot, dirname(reportPath)),
  });

  return permissionArtifactPointers({ repoRoot, runId });
}

// Build (through the sanitizing constructor) AND persist in one call — the
// SUPPORTED entry point for the doctor/settings sibling slices, so they never
// hand-assemble an artifact object and risk slipping an unsanitized / leak-keyed
// field past the writer (Plan-verify peer MAJOR #1). Returns the artifact + its
// pointer set.
export async function recordPermissionAdvisoryArtifact({ repoRoot, ...artifactInput }) {
  const artifact = makePermissionAdvisoryArtifact(artifactInput);
  const pointers = await writePermissionAdvisoryArtifact({ repoRoot, artifact });
  return { artifact, pointers };
}

// Read a run's raw artifact (or null when absent / unparseable). Callers that
// need the schema-currency + structural gate should use
// loadPermissionAdvisoryArtifact.
export async function readPermissionAdvisoryArtifact({ repoRoot, runId }) {
  const { value } = await readJsonSafe(permissionArtifactFile(repoRoot, runId));
  return value;
}

export async function readLatestPermissionPointer({ repoRoot }) {
  const { value } = await readJsonSafe(permissionLatestFile(repoRoot));
  return value;
}

// Gated read: classifies the on-disk artifact as ok / missing / stale /
// invalid so a caller renders the current one and rejects a stale, corrupt, or
// malformed shape instead of mis-rendering it.
export async function loadPermissionAdvisoryArtifact({ repoRoot, runId }) {
  const read = await readJsonSafe(permissionArtifactFile(repoRoot, runId));
  if (read.status === 'missing') {
    return { status: 'missing', artifact: null, reason: 'no permission advisory artifact at run id' };
  }
  if (read.status === 'invalid_json') {
    return { status: 'invalid', artifact: null, reason: 'artifact body is not valid JSON' };
  }
  const artifact = read.value;
  if (!isCurrentPermissionAdvisoryArtifact(artifact)) {
    return {
      status: 'stale',
      artifact,
      reason:
        `schema mismatch (found ${artifact?.schema_version}/${artifact?.advisor_schema_version}, ` +
        `expected ${PERMISSION_ARTIFACT_SCHEMA_VERSION}/${ADVISOR_SCHEMA_VERSION})`,
    };
  }
  if (!isValidPermissionAdvisoryArtifact(artifact)) {
    return { status: 'invalid', artifact, reason: 'artifact failed structural validation' };
  }
  return { status: 'ok', artifact, reason: null };
}

// The latest.json pointer is schema-stamped on write, so it gets the same
// currency + structural gate on read — a stale or corrupt pointer is rejected
// rather than consumed (Plan-verify peer MAJOR #2: the body loader gated, the
// pointer reader did not).
export function isCurrentPermissionLatestPointer(latest) {
  return (
    Boolean(latest) &&
    typeof latest === 'object' &&
    latest.schema_version === PERMISSION_LATEST_SCHEMA_VERSION
  );
}

export function isValidPermissionLatestPointer(latest) {
  if (!onlyKnownKeys(latest, LATEST_POINTER_KEYS)) return false;
  if (latest.schema_version !== PERMISSION_LATEST_SCHEMA_VERSION) return false;
  if (latest.kind !== PERMISSION_ARTIFACT_KIND) return false;
  if (!isValidPermissionRunId(latest.run_id)) return false;
  if (!PERMISSION_ARTIFACT_SURFACES.includes(latest.surface)) return false;
  if (!PERMISSION_ARTIFACT_STATUSES.includes(latest.status)) return false;
  if (typeof latest.updated_at !== 'string' || !latest.updated_at) return false;
  if (typeof latest.report_pointer !== 'string' || !latest.report_pointer) return false;
  if (typeof latest.run_pointer !== 'string' || !latest.run_pointer) return false;
  if (
    !Array.isArray(latest.hosts) ||
    latest.hosts.length === 0 ||
    !latest.hosts.every(isAdvisorHost)
  ) {
    return false;
  }
  return true;
}

export async function loadLatestPermissionPointer({ repoRoot }) {
  const read = await readJsonSafe(permissionLatestFile(repoRoot));
  if (read.status === 'missing') {
    return { status: 'missing', pointer: null, reason: 'no latest permission advisory pointer' };
  }
  if (read.status === 'invalid_json') {
    return { status: 'invalid', pointer: null, reason: 'latest pointer is not valid JSON' };
  }
  const latest = read.value;
  if (!isCurrentPermissionLatestPointer(latest)) {
    return {
      status: 'stale',
      pointer: latest,
      reason: `schema mismatch (found ${latest?.schema_version}, expected ${PERMISSION_LATEST_SCHEMA_VERSION})`,
    };
  }
  if (!isValidPermissionLatestPointer(latest)) {
    return { status: 'invalid', pointer: latest, reason: 'latest pointer failed structural validation' };
  }
  return { status: 'ok', pointer: latest, reason: null };
}

// ---------------------------------------------------------------------------
// Pointer output (text/json)
// ---------------------------------------------------------------------------

// The json pointer set for a run — repo-relative, pointer-only (no bodies).
export function permissionArtifactPointers({ repoRoot, runId }) {
  validatePermissionRunId(runId);
  return {
    run_id: runId,
    family: PERMISSION_ARTIFACT_FAMILY,
    run_pointer: pointer(repoRoot, permissionRunDir(repoRoot, runId)),
    report_pointer: pointer(repoRoot, permissionArtifactFile(repoRoot, runId)),
    latest_pointer: pointer(repoRoot, permissionLatestFile(repoRoot)),
  };
}

// `kind:path` specs for the runtime completion footer (`--artifact`), so the
// permission advisory surfaces as a pointer in the footer — never its body.
export function permissionFooterArtifacts({ repoRoot, runId }) {
  const p = permissionArtifactPointers({ repoRoot, runId });
  return [
    `permission-advisory:${p.report_pointer}`,
    `permission-advisory-latest:${p.latest_pointer}`,
  ];
}
