// plugins/runtime/scripts/lib/state-readers.mjs
//
// ADR-0040 Decision §6 prerequisite slice: doctor.mjs's private state readers,
// moved verbatim into a runtime-internal shared lib so the future
// runtime:dashboard can consume them without importing doctor.mjs.
// Runtime-internal import only — the ADR-0010 §5 import ban is cross-plugin.
// Doctor behavior is unchanged: doctor.mjs re-imports the subset it still
// uses and re-exports TERMINAL_PEER_RUN_STATUSES / VALID_PEER_RUN_STATUSES
// so its public surface is identical.
//
// Every reader is a read-only filesystem probe (ADR-0035 R0): no spawning,
// no host-CLI probing, no mutation, and every fs error degrades to a
// structured 'missing'/'blocked' result instead of throwing.
//
// Exported reader shapes (dashboard consumption contract):
//
// inspectWorkflowNamespace({ repoRoot, plugin, legacyNamespace, expectedPlugin, now, staleGraceMs })
//   → { root, workflows, peer_runs, storage, homes: { canonical, legacy } }
//   Persona-generic: a dashboard may call it with plugin:'founder' directly;
//   doctor's inspectWorkflowLedgers keeps its {engineer, orchestrator} contract.
//   - workflows (scanWorkflowFiles shape):
//     { status: 'missing'|'available'|'blocked', dir, count, malformed,
//       files: [{ file, status, workflow_id, current_phase, branch, reason? }], error? }
//   - peer_runs (scanPeerRuns shape):
//     { status: 'missing'|'available'|'blocked', dir, count, non_terminal,
//       stale_non_terminal, malformed, runs: [{ run_id, status, terminal, stale,
//       plugin, plugin_matches_namespace, kind, peer_host, model, effort,
//       updated_at, issues }], error? }
//   - storage (summarizeWorkflowStorage shape):
//     { status: 'empty'|'canonical'|'legacy'|'ambiguous'|'migration_blocked',
//       plugin, selected_home, canonical_root, legacy_root, canonical_has_state,
//       legacy_has_state, overlapping_branches, recommendation }
//
// scanOneWorkflowHome({ root, home, expectedPlugin, now, staleGraceMs })
//   → { home, root, workflows, peer_runs, has_state }
//
// scanWorkflowFiles(dir) / scanPeerRuns(dir, expectedPlugin, now, staleGraceMs)
//   → the workflows / peer_runs shapes above.
//
// inspectConsensusRuns({ repoRoot })
//   → { status: 'missing'|'empty'|'blocked'|'needs_attention'|'available',
//       root, count, malformed, latest, error? } where latest is
//     { run_id, status, artifact_pointer, progress_pointer, selected_at,
//       selected_at_ms, round, peer_execution,
//       summary: { executed, passed, failed, skipped, failed_retryable, failed_non_retryable },
//       failure_summary: { timeout, retryable, non_retryable, operator_action_required, by_type },
//       failures: [{ peer, status, failure_type, operator_action_required, retryable,
//                    retry_after, retry_command, raw_output }] } | null.
//
// inspectCompatRuns({ repoRoot })
//   → { status: 'missing'|'empty'|'blocked'|'needs_attention'|'release_notes_required'|'available',
//       root, count, malformed, latest, error? } where latest is
//     { run_id, status: 'blocked'|'snapshot_only'|'gap_analysis_ready'|'plan_ready'
//         |'release_notes_required'|'current', artifact_pointer, gap_pointer,
//       plan_pointer, selected_at, selected_at_ms, drift_class,
//       release_notes_required, host_gaps: [{ host, status, observed_version,
//       baseline_version }], release_notes, malformed_artifacts?, next_steps } | null.
//
// inspectRuntimeArtifactInventory({ repoRoot, now, retentionCap, maxBytes })
//   → { requested, executed, status: 'missing'|'blocked'|'needs_attention'|'available'|'empty',
//       root, policy: { run_count_cap, byte_cap }, total, families, attention, limits, error? }
//     with per-family { family, status, root, pointer, run_count, file_count,
//     directory_count, symlink_count, unreadable, bytes, oldest_mtime,
//     newest_mtime, oldest_age_minutes, attention }.
//
// Low-level helpers (readJsonIfExists / readOptionalJson / readTextIfExists /
// parseFrontmatterBlock / extractYamlScalar / extractNestedBranch / parseDateMs /
// artifactTimestampMs / runIdTimestampMs / safeCount / pointer) and the run-id
// regexes (CONSENSUS_RUN_ID_RE / COMPAT_RUN_ID_RE) are exported for the same
// consumers. Summary/aggregation helpers stay module-private, exactly as they
// were private to doctor.mjs.

import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { projectGapFamily, READY_COMPAT_STATUSES } from './compat-artifacts.mjs';
import { sanitizeValue } from './permission-sanitize.mjs';

// $CODEX_HOME resolution — the ONE canonical form (the `collectUsageRecordSources`
// precedent). `~/.codex` is the default, never a hardcode (machine-bootstrap-contract.md
// §10.2). Lives in this pure, host-CLI-free leaf so every caller (doctor, machine-probe,
// settings, consensus) resolves it identically without dragging the host-CLI probe into a
// spawn-sensitive import closure.
export function resolveCodexHome(env, homeDir) {
  return env && env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homeDir, '.codex');
}

// --- machine-global scope (ADR-0046 §4, machine-bootstrap-contract.md §10) ---
//
// The machine-global artifact home. Resolved from the operator's home directory,
// NEVER from repoRoot — that is the whole point of the scope (bootstrap state is
// per-machine, not per-repository). It lives beside resolveCodexHome for the same
// reason: one canonical path resolver every caller composes, so there is no second
// copy to drift. Path resolution ONLY; the security gates (symlink refusal,
// canonical containment, $HOME-is-the-repo refusal) belong to the writer that
// takes the risk — see lib/bootstrap-artifacts.mjs.
export function machineGlobalRoot(homeDir) {
  return join(homeDir, '.agentic-plugins');
}

// Home-relative pointer for a machine-global path — `~/.agentic-plugins/...`,
// never absolute (artifact-policy.md §Pointers). An absolute path carries the
// operator's home layout (typically their username) into every artifact and
// report that quotes it. Falls back to the absolute path only when `path` is not
// under `homeDir` at all, which callers should already have refused as an
// out-of-containment write.
export function machinePointer(homeDir, path) {
  const rel = relative(homeDir, path);
  // A path outside the home has no home-relative form. Return a REFUSAL TOKEN, not
  // the absolute path: the fallback is the one branch where "render it home-relative
  // so the operator's layout never lands in an artifact" would quietly render the
  // operator's layout. Every caller builds its paths from homeDir, so reaching this
  // is a caller bug — and a visible token is how it gets found.
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return '<outside-home>';
  return `~/${rel.split(sep).join('/')}`;
}

// The machine scope's inventory descriptor. Two families with DIFFERENT retention
// rules, which is why the scope cannot be folded into RUNTIME_ARTIFACT_FAMILIES'
// flat list (that list carries one uniform cap and one repo root):
//   - bootstrap: under runs/, capped at 10 (contract §10.2)
//   - profiles:  NOT under runs/, and exempt from retention entirely — a profile
//     is the operator's portable input, not a generated byproduct.
export const MACHINE_BOOTSTRAP_RETENTION_CAP = 10;
export const MACHINE_ARTIFACT_FAMILIES = Object.freeze([
  Object.freeze({ family: 'bootstrap', segments: ['runs', 'bootstrap'], retentionCap: MACHINE_BOOTSTRAP_RETENTION_CAP }),
  Object.freeze({ family: 'profiles', segments: ['profiles'], retentionCap: null }),
]);

export const TERMINAL_PEER_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'orphaned', 'pruned']);
export const VALID_PEER_RUN_STATUSES = new Set([
  'queued',
  'spawning',
  'running',
  'completed',
  'failed',
  'cancel_requested',
  'cancelled',
  'orphaned',
  'pruned',
]);

export const CONSENSUS_RUN_ID_RE = /^consensus-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
export const COMPAT_RUN_ID_RE = /^compat-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
// 'permission' is the ADR-0038 permission advisory family; its on-disk segment
// is owned by scripts/lib/permission-artifacts.mjs (PERMISSION_ARTIFACT_FAMILY),
// registered here so the inventory + uniform retention cap covers it.
// 'notification' is the ADR-0040 §4 notification plan family, owned by
// scripts/lib/notification-plan.mjs (NOTIFICATION_ARTIFACT_FAMILY).
// 'egress-launcher' is the ADR-0041 §12 first-class egress launcher plan family,
// owned by scripts/lib/egress-launcher-plan.mjs (EGRESS_LAUNCHER_ARTIFACT_FAMILY).
const RUNTIME_ARTIFACT_FAMILIES = ['compat', 'consensus', 'context', 'settings', 'doctor', 'permission', 'notification', 'egress-launcher'];

// --- low-level fs / frontmatter / timestamp helpers (moved from doctor.mjs) ---

export async function readJsonIfExists(path) {
  try {
    const text = await readFile(path, 'utf8');
    return { ok: true, path, json: JSON.parse(text) };
  } catch (err) {
    return { ok: false, path, reason: err.code ?? err.message };
  }
}

export async function readOptionalJson(path) {
  try {
    const text = await readFile(path, 'utf8');
    return { status: 'available', path, json: JSON.parse(text) };
  } catch (err) {
    if (err.code === 'ENOENT') return { status: 'missing', path, reason: err.code };
    return { status: 'malformed', path, reason: err.code ?? err.message };
  }
}

export async function readTextIfExists(path) {
  try {
    const text = await readFile(path, 'utf8');
    return { ok: true, path, text };
  } catch (err) {
    return { ok: false, path, reason: err.code ?? err.message };
  }
}

/**
 * Same shape, but the BYTES survive.
 *
 * A caller that hashes what it read cannot use `readTextIfExists`: the decode
 * maps every invalid byte sequence to U+FFFD, so two different files produce
 * one digest. `doctor`'s settings `artifact_hash` — whose comment says it
 * "binds the attestation to the EXACT settings.json bytes on disk" — did
 * exactly that, and two artifacts differing only by `0xff` versus `0xfe`
 * hashed the same (cross-host review). Text callers are unaffected and keep
 * the function above.
 */
export async function readBytesIfExists(path) {
  try {
    const bytes = await readFile(path);
    return { ok: true, path, bytes, text: bytes.toString('utf8') };
  } catch (err) {
    return { ok: false, path, reason: err.code ?? err.message };
  }
}

export function parseFrontmatterBlock(text) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) return null;
  return text.slice(4, end);
}

export function extractYamlScalar(frontmatter, key) {
  const re = new RegExp(`^${escapeRegExp(key)}:\\s*['"]?([^'"\\n]+)['"]?\\s*$`, 'm');
  return sanitizeValue(frontmatter.match(re)?.[1]?.trim() ?? null);
}

export function extractNestedBranch(frontmatter) {
  const match = frontmatter.match(/git_baseline:\s*\n(?:\s{2,}.+\n)*?\s{2,}branch:\s*['"]?([^'"\n]+)['"]?/m);
  return sanitizeValue(match?.[1]?.trim() ?? null);
}

export function parseDateMs(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function artifactTimestampMs(artifact, fallbackRunId) {
  for (const value of [artifact.updated_at, artifact.created_at, artifact.generated_at]) {
    const parsed = parseDateMs(value);
    if (parsed !== null) return parsed;
  }
  return runIdTimestampMs(fallbackRunId);
}

export function runIdTimestampMs(runId) {
  const match = String(runId ?? '').match(/^(?:settings|consensus|compat|doctor)-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{6}$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

export function safeCount(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function pointer(repoRoot, path) {
  const rel = relative(repoRoot, path).split(sep).join('/');
  return rel || basename(path);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- consensus / compat run readers (moved from doctor.mjs) ---

export async function inspectConsensusRuns({ repoRoot }) {
  const root = join(repoRoot, '.agentic-plugins', 'runs', 'consensus');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    return {
      status: 'missing',
      root,
      count: 0,
      malformed: 0,
      latest: null,
      error: err.code ?? err.message,
    };
  }

  const runs = [];
  let malformed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !CONSENSUS_RUN_ID_RE.test(entry.name)) continue;
    const artifactPath = join(root, entry.name, 'execution.json');
    const artifact = await readJsonIfExists(artifactPath);
    if (!artifact.ok) {
      continue;
    }
    const summary = summarizeConsensusArtifact({
      repoRoot,
      runId: entry.name,
      artifactPath,
      artifact: artifact.json,
    });
    if (summary.status === 'blocked') malformed++;
    runs.push(summary);
  }

  if (runs.length === 0) {
    return {
      status: malformed > 0 ? 'blocked' : 'empty',
      root,
      count: 0,
      malformed,
      latest: null,
    };
  }

  runs.sort((a, b) => b.selected_at_ms - a.selected_at_ms || b.run_id.localeCompare(a.run_id));
  const latest = runs[0];
  const status = malformed > 0
    ? 'blocked'
    : latest.summary.failed > 0
      ? 'needs_attention'
      : 'available';
  return {
    status,
    root,
    count: runs.length,
    malformed,
    latest,
  };
}

export async function inspectCompatRuns({ repoRoot }) {
  const root = join(repoRoot, '.agentic-plugins', 'runs', 'compat');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    return {
      status: 'missing',
      root,
      count: 0,
      malformed: 0,
      latest: null,
      error: err.code ?? err.message,
    };
  }

  const runs = [];
  let malformed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !COMPAT_RUN_ID_RE.test(entry.name)) continue;
    const snapshotPath = join(root, entry.name, 'snapshot.json');
    const snapshot = await readJsonIfExists(snapshotPath);
    if (!snapshot.ok) {
      malformed++;
      runs.push({
        run_id: entry.name,
        status: 'blocked',
        artifact_pointer: pointer(repoRoot, snapshotPath),
        selected_at: null,
        selected_at_ms: runIdTimestampMs(entry.name) ?? 0,
        drift_class: 'unknown',
        release_notes_required: false,
        host_gaps: [],
        release_notes: emptyCompatReleaseNotes(repoRoot, entry.name),
        reason: snapshot.reason,
        next_steps: ['Repair malformed runtime:compat snapshot artifacts before relying on compatibility drift checks.'],
      });
      continue;
    }
    const summary = await summarizeCompatArtifact({
      repoRoot,
      runId: entry.name,
      snapshotPath,
      snapshot: snapshot.json,
    });
    if (summary.status === 'blocked') malformed++;
    runs.push(summary);
  }

  if (runs.length === 0) {
    return {
      status: 'empty',
      root,
      count: 0,
      malformed,
      latest: null,
    };
  }

  runs.sort((a, b) => b.selected_at_ms - a.selected_at_ms || b.run_id.localeCompare(a.run_id));
  const latest = runs[0];
  // INVERTED so the fall-through is safe. This used to list the three
  // attention-worthy per-run statuses and call everything else `available`, so
  // a new per-run status — `baseline_unusable` is the one that arrived — would
  // have been reported as a healthy compat state. Only `current` earns
  // `available`; anything unrecognised needs attention.
  //
  // `assurance_blocked` joins the blocking set for the same reason
  // `baseline_unusable` did: it is an INTEGRITY failure, not a readiness answer,
  // and ADR-0053 §Decision 3 puts integrity above both other layers.
  //
  // `available` is decided from the SHARED ready list rather than from a literal,
  // so the producer's positive vocabulary and the consumer's cannot drift apart —
  // the failure this reader's own comment describes, repeated one release later
  // for a second status. `legacy_unassured` and `unassured` deliberately fall
  // through to `needs_attention`: they are not malformed and not broken, they are
  // simply not covered, and §Decision 11 says unassured blocks.
  const status = malformed > 0
    || latest.status === 'baseline_unusable'
    || latest.status === 'assurance_blocked'
    || latest.status === 'unrecognized'
    ? 'blocked'
    : latest.status === 'release_notes_required'
      ? 'release_notes_required'
      : READY_COMPAT_STATUSES.includes(latest.status)
        ? 'available'
        : 'needs_attention';
  return {
    status,
    root,
    count: runs.length,
    malformed,
    latest,
  };
}

async function summarizeCompatArtifact({ repoRoot, runId, snapshotPath, snapshot }) {
  const gapPath = join(dirname(snapshotPath), 'gap-analysis.json');
  const planPath = join(dirname(snapshotPath), 'plan.json');
  const releaseNotesPath = join(dirname(snapshotPath), 'release-notes', 'index.json');
  const [gap, plan, releaseNotes] = await Promise.all([
    readOptionalJson(gapPath),
    readOptionalJson(planPath),
    readOptionalJson(releaseNotesPath),
  ]);
  const selectedAt = artifactTimestampMs(snapshot, runId);
  const malformed = [gap, plan, releaseNotes].filter((item) => item.status === 'malformed');
  const gapOverall = gap.json?.overall ?? {};
  const planStatus = sanitizeValue(plan.json?.status);
  const releaseNotesSummary = summarizeCompatReleaseNotes({
    repoRoot,
    runId,
    releaseNotesPath,
    releaseNotes,
  });
  // A plan that declares itself non-actionable (runtime-compat-plan-1.1
  // `actionable: false` — no drift, no surfaces, no notification-watch
  // signal; the plan exists only to render the ADR-0047 standing watch)
  // must not outrank a current gap: without this, every routine standing-
  // watch plan run would flip doctor/dashboard/cutover compat state to
  // plan_ready/needs_attention. Older plans without the field keep today's
  // plan-presence-wins behavior.
  const planInformationalOnly = plan.status === 'available'
    && plan.json?.actionable === false
    && gapOverall.status === 'current';
  // Ordered ABOVE the plan and gap branches, because it outranks both.
  // `baseline_unusable` is compat's terminal marker for "nothing was
  // compared": the packaged baseline could not be read, parsed, or contained.
  // Without this it reached `gap_analysis_ready` — and, when a plan artifact
  // also existed, `plan_ready` — so a broken package was reported as analysis
  // that is ready to act on, carrying `runtime:compat plan` as its next step.
  // That is the same defect compat's own `buildGapAnalysis` fixed one layer
  // down, repeated by its reader. The single string is compat's; nothing is
  // re-derived here.
  const baselineUnusable = gap.status === 'available' && gapOverall.status === 'baseline_unusable';
  // ADR-0053 §Decision 4 — the FAMILY, checked before any persisted status is
  // read. Measured before it was written: a gap artifact declaring a schema this
  // runtime has never heard of read as `available / current`, because nothing
  // below validates the family and every branch switches on the stored string.
  // An unread narrowing field is how a restricted verdict becomes an
  // unrestricted one, so an unknown family is refused rather than consumed.
  const family = gap.status === 'available' ? projectGapFamily(gap.json) : null;
  const unrecognizedFamily = family?.kind === 'unrecognized';
  const legacyFamily = family?.kind === 'legacy';
  // The assurance-integrity states outrank the plan for the same reason
  // `baseline_unusable` does: a plan cannot be acted on when the verdict behind
  // it could not be read. Without this, an existing plan artifact turned a
  // blocked run into `plan_ready`.
  const assuranceBlocked = gap.status === 'available' && gapOverall.status === 'assurance_blocked';
  const status = malformed.length > 0
    ? 'blocked'
    : unrecognizedFamily
      ? 'unrecognized'
      : baselineUnusable
        ? 'baseline_unusable'
        : assuranceBlocked
          ? 'assurance_blocked'
          // History, and it cannot be planned away — the only honest next step is
          // a fresh snapshot, so a plan artifact must not mask it either.
          : legacyFamily
            ? 'legacy_unassured'
            : plan.status === 'available' && !planInformationalOnly
        ? planStatus === 'blocked_release_notes_required'
          ? 'release_notes_required'
          // A plan can also declare itself blocked on the baseline. The gap
          // branch above normally catches that first; this keeps the two
          // artifacts from disagreeing if only the plan carries the verdict.
          : planStatus === 'blocked_baseline_unusable'
            ? 'baseline_unusable'
            : 'plan_ready'
        : gap.status === 'available'
          ? gapOverall.status === 'release_notes_required' || gapOverall.release_notes_required === true
            ? 'release_notes_required'
            : gapOverall.status === 'current'
              ? 'current'
              // Only compat's own vocabulary reaches `gap_analysis_ready`.
              // This was the ELSE branch, so a persisted status this reader
              // has never heard of — the very case the collection mapping
              // below was hardened against — was projected as analysis ready
              // to act on, with `runtime:compat plan` as its next step. The
              // collection status stayed conservative and the per-run one did
              // not, which is worse than either being wrong consistently:
              // every surface that renders a run reads the per-run value.
              // Reading an unrecognised artifact is a reason to stop.
              //
              // Its OWN status, not `blocked`: that value already means "a
              // compat artifact on disk is malformed", and it feeds the
              // malformed counter and the `malformed_artifacts` pointer list.
              // A well-formed file carrying a verdict this runtime has never
              // heard of is a different fact, and reusing `blocked` reported a
              // malformed-artifact count with no artifact to point at.
              : gapOverall.status === 'gap_analysis_ready'
                ? 'gap_analysis_ready'
                // Reviewed by nobody — readable, drift-free, and covered by no
                // grant. ADR-0053 §Decision 11: "unassured blocks". Carried as
                // its own value rather than folded into `gap_analysis_ready`,
                // whose next step is a plan that would have nothing to plan.
                : gapOverall.status === 'unassured'
                  ? 'unassured'
                  // Drift a human reviewed and accepted. Positive for readiness,
                  // while `drift_class` keeps reporting the drift as evidence —
                  // §Decision 4 moves the classification, not the evidence.
                  : gapOverall.status === 'assured'
                    ? 'assured'
                    : 'unrecognized'
          : 'snapshot_only';
  return {
    run_id: sanitizeValue(snapshot.run_id) ?? runId,
    status,
    artifact_pointer: pointer(repoRoot, snapshotPath),
    gap_pointer: gap.status === 'available' || gap.status === 'malformed' ? pointer(repoRoot, gapPath) : null,
    plan_pointer: plan.status === 'available' || plan.status === 'malformed' ? pointer(repoRoot, planPath) : null,
    selected_at: selectedAt === null ? null : new Date(selectedAt).toISOString(),
    selected_at_ms: selectedAt ?? 0,
    drift_class: sanitizeValue(gapOverall.drift_class) ?? 'unchecked',
    release_notes_required: gapOverall.release_notes_required === true || status === 'release_notes_required',
    host_gaps: Array.isArray(gap.json?.host_gaps)
      ? gap.json.host_gaps.map((item) => ({
          host: sanitizeValue(item.host),
          status: sanitizeValue(item.status),
          observed_version: sanitizeValue(item.observed_version),
          baseline_version: sanitizeValue(item.baseline_version),
        }))
      : [],
    release_notes: releaseNotesSummary,
    malformed_artifacts: malformed.map((item) => pointer(repoRoot, item.path)),
    next_steps: compatNextSteps({ runId, status, gap, plan }),
  };
}

function summarizeCompatReleaseNotes({ repoRoot, runId, releaseNotesPath, releaseNotes }) {
  if (releaseNotes.status === 'missing') return emptyCompatReleaseNotes(repoRoot, runId);
  if (releaseNotes.status === 'malformed') {
    return {
      pointer: pointer(repoRoot, releaseNotesPath),
      status: 'malformed',
      count: 0,
      content_backed: 0,
      url_pointers: 0,
      stored: 0,
      not_fetched: 0,
    };
  }
  const notes = Array.isArray(releaseNotes.json?.notes) ? releaseNotes.json.notes : [];
  return {
    pointer: pointer(repoRoot, releaseNotesPath),
    status: 'available',
    count: notes.length,
    content_backed: notes.filter((note) => isContentBackedCompatReleaseNote(note)).length,
    url_pointers: notes.filter((note) => note.kind === 'url').length,
    stored: notes.filter((note) => note.status === 'stored').length,
    not_fetched: notes.filter((note) => note.status === 'not_fetched').length,
  };
}

function isContentBackedCompatReleaseNote(note) {
  if (!note || note.status !== 'stored') return false;
  if (note.kind === 'file') return Boolean(note.pointer);
  if (note.kind === 'url') return Boolean(note.content_pointer);
  return false;
}

function emptyCompatReleaseNotes(repoRoot, runId) {
  return {
    pointer: pointer(repoRoot, join(repoRoot, '.agentic-plugins', 'runs', 'compat', runId, 'release-notes', 'index.json')),
    status: 'missing',
    count: 0,
    content_backed: 0,
    url_pointers: 0,
    stored: 0,
    not_fetched: 0,
  };
}

function compatNextSteps({ runId, status, gap, plan }) {
  const storedGapSteps = Array.isArray(gap.json?.next_steps)
    ? gap.json.next_steps.map((step) => sanitizeValue(step)).filter(Boolean)
    : [];
  if (status === 'blocked') return ['Repair malformed runtime:compat artifacts, then rerun runtime:compat check.'];
  if (status === 'snapshot_only') return [`runtime:compat check --run-id ${runId}`];
  // A terminal baseline failure carries the repair instruction the gap already
  // stored. Falling through to the empty return dropped it — the reader made
  // the status terminal and then discarded the only line saying what to do,
  // which is exactly the defect just removed from cutover's next_actions.
  if (status === 'baseline_unusable') {
    return storedGapSteps.length > 0
      ? storedGapSteps
      : ['Repair the packaged host-parity baseline — reinstall or update the runtime plugin; compat cannot compare host versions until it resolves.'];
  }
  // The producer stores the EVALUATOR's own repair instruction for these, and it
  // names the specific failure — a corrupt package, a straddled read, an
  // unreadable host probe. Re-deriving a generic line would discard the one field
  // whose job is telling those apart, which is the defect this function already
  // fixed once for `baseline_unusable`.
  if (status === 'assurance_blocked') {
    return storedGapSteps.length > 0
      ? storedGapSteps
      : ['Re-run runtime:doctor and reinstall the runtime plugin — the recorded compatibility assurance result could not be read.'];
  }
  if (status === 'legacy_unassured') {
    return storedGapSteps.length > 0
      ? storedGapSteps
      : ['runtime:compat snapshot — this run predates the compatibility assurance record, and a remembered snapshot is never retroactively granted assurance (ADR-0053 §Decision 4).'];
  }
  if (status === 'unassured') {
    return storedGapSteps.length > 0
      ? storedGapSteps
      : ['Assurance is granted by human review of this host pair against this installed code (ADR-0053 §Decision 5); until a release carries a grant naming this pair, readiness stays ungranted.'];
  }
  // `assured` is drift a human accepted. There is nothing to do about it, but
  // silence is still wrong — the drift is real and stays worth seeing.
  if (status === 'assured') {
    return storedGapSteps.length > 0
      ? storedGapSteps
      : [`Host versions drifted from the reviewed baseline and a grant covers this pair; no action required. runtime:compat plan --run-id ${runId} for the advisory sequence.`];
  }
  if (status === 'release_notes_required') {
    return storedGapSteps.length > 0 ? storedGapSteps : [`runtime:compat ingest-release-notes --run-id ${runId} --release-notes-file <path>`];
  }
  if (status === 'gap_analysis_ready') return [`runtime:compat plan --run-id ${runId}`];
  if (status === 'plan_ready') {
    const steps = Array.isArray(plan.json?.recommended_sequence)
      ? plan.json.recommended_sequence.map((item) => sanitizeValue(item.step)).filter(Boolean)
      : [];
    return steps.length > 0 ? steps : ['Review the runtime:compat update plan before changing compatibility-sensitive surfaces.'];
  }
  // `unrecognized` and anything else land here. Silence is the wrong answer:
  // a run with no next step reads as a run with nothing to do.
  return [`runtime:compat check --run-id ${runId} — this run's recorded state (${status}) is not one this runtime recognises; re-run check with a runtime new enough to read it.`];
}

function summarizeConsensusArtifact({ repoRoot, runId, artifactPath, artifact }) {
  const summary = artifact.summary ?? {};
  const failures = Array.isArray(artifact.failures)
    ? artifact.failures.map((failure) => ({
        peer: sanitizeValue(failure.peer),
        status: sanitizeValue(failure.status),
        failure_type: sanitizeValue(failure.failure_type),
        operator_action_required: failure.operator_action_required === true,
        retryable: failure.retryable === true,
        retry_after: sanitizeValue(failure.retry_after),
        retry_command: sanitizeValue(failure.retry_command),
        raw_output: {
          pointer: sanitizeValue(failure.raw_output?.pointer),
          bytes: safeCount(failure.raw_output?.bytes),
          sha256: sanitizeValue(failure.raw_output?.sha256),
        },
      }))
    : [];
  const selectedAt = artifactTimestampMs(artifact, runId);
  return {
    run_id: sanitizeValue(artifact.run_id) ?? runId,
    status: typeof artifact.status === 'string' ? artifact.status : 'blocked',
    artifact_pointer: pointer(repoRoot, artifactPath),
    progress_pointer: sanitizeValue(artifact.progress_pointer),
    selected_at: selectedAt === null ? null : new Date(selectedAt).toISOString(),
    selected_at_ms: selectedAt ?? 0,
    round: safeCount(artifact.round),
    peer_execution: artifact.peer_execution === true,
    summary: {
      executed: safeCount(summary.executed),
      passed: safeCount(summary.passed),
      failed: safeCount(summary.failed),
      skipped: safeCount(summary.skipped),
      failed_retryable: safeCount(summary.failed_retryable),
      failed_non_retryable: safeCount(summary.failed_non_retryable),
    },
    failure_summary: summarizeConsensusFailures(failures),
    failures,
  };
}

function summarizeConsensusFailures(failures) {
  const result = {
    timeout: 0,
    retryable: 0,
    non_retryable: 0,
    operator_action_required: 0,
    by_type: {},
  };
  for (const failure of failures) {
    const type = failure.failure_type || 'unknown';
    result.by_type[type] = (result.by_type[type] ?? 0) + 1;
    if (type === 'timeout') result.timeout += 1;
    if (failure.operator_action_required) result.operator_action_required += 1;
    if (failure.retryable) result.retryable += 1;
    else result.non_retryable += 1;
  }
  return result;
}

// --- artifact inventory + workflow/peer-run readers (moved from doctor.mjs) ---

// SCOPE-AWARE (ADR-0046 §4). The repo scope keeps its exact shape and its exact
// top-level keys — every existing consumer reads those. The machine-global scope
// (contract §10) is ADDITIVE, under `machine`, and appears only when a homeDir is
// injected; the two are NOT merged. Merging them would be wrong twice over: the
// scopes have different roots (so each scope's families would be inspected against
// the other's root, inventing families that do not exist), and different retention
// (20 vs 10 vs profiles-exempt), which one flat cap cannot express.
//
// homeDir is INJECTED, never read from os.homedir() here — a reader that reached
// for the real home would make every caller's test read the developer's machine.
export async function inspectRuntimeArtifactInventory({ repoRoot, now, retentionCap, maxBytes, homeDir = null }) {
  const scope = await inspectArtifactScope({
    root: join(repoRoot, '.agentic-plugins', 'runs'),
    families: RUNTIME_ARTIFACT_FAMILIES.map((family) => ({ family, segments: [family], retentionCap })),
    discoverUnknownFamilies: true,
    pointerFor: (path) => pointer(repoRoot, path),
    nowMs: now.getTime(),
    maxBytes,
    policy: { run_count_cap: retentionCap, byte_cap: maxBytes },
  });

  return {
    requested: true,
    executed: true,
    ...scope,
    limits: artifactInventoryLimits(),
    ...(homeDir
      ? {
          machine: await inspectMachineArtifactScope({ homeDir, now, maxBytes }),
        }
      : {}),
  };
}

// The machine-global scope: `~/.agentic-plugins`, two fixed families at different
// depths (`runs/bootstrap`, `profiles`) with per-family caps. Unknown children are
// NOT discovered as families — unlike the repo scope, this home's membership is
// closed by contract §10, and `config.toml` / `.locks` living here are not run
// families.
export async function inspectMachineArtifactScope({ homeDir, now, maxBytes }) {
  const root = machineGlobalRoot(homeDir);
  const scope = await inspectArtifactScope({
    root,
    families: MACHINE_ARTIFACT_FAMILIES.map((entry) => ({ ...entry })),
    discoverUnknownFamilies: false,
    pointerFor: (path) => machinePointer(homeDir, path),
    nowMs: now.getTime(),
    maxBytes,
    policy: {
      run_count_cap: MACHINE_BOOTSTRAP_RETENTION_CAP,
      byte_cap: maxBytes,
      retention_exempt: MACHINE_ARTIFACT_FAMILIES.filter((f) => f.retentionCap === null).map((f) => f.family),
    },
  });

  // Home-relativize EVERY path field before it leaves, not just `pointer`. The scope
  // and per-family `root` are absolute, and doctor PERSISTS this report as an
  // artifact — so an unprojected `root` writes the operator's home (and username)
  // into a file they may well paste into an issue. Sanitizing only the field named
  // `pointer` would fix the one the reader looks at and leave the one the artifact
  // stores. The repo scope keeps its absolute root: it is repo-relative by
  // construction and its consumers already read it.
  return {
    scope: 'machine',
    ...scope,
    root: machinePointer(homeDir, scope.root),
    families: Object.fromEntries(
      Object.entries(scope.families).map(([name, family]) => [name, { ...family, root: machinePointer(homeDir, family.root) }]),
    ),
    limits: machineArtifactInventoryLimits(),
  };
}

async function inspectArtifactScope({ root, families, discoverUnknownFamilies, pointerFor, nowMs, maxBytes, policy }) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    const missing = String(err.code ?? '') === 'ENOENT';
    return {
      status: missing ? 'missing' : 'blocked',
      root,
      policy,
      total: emptyArtifactTotals(),
      families: Object.fromEntries(families.map((entry) => {
        const familyRoot = join(root, ...entry.segments);
        return [entry.family, missingArtifactFamily({ familyRoot, family: entry.family, pointerFor })];
      })),
      attention: [],
      error: err.code ?? err.message,
    };
  }

  const members = new Map(families.map((entry) => [entry.family, entry]));
  if (discoverUnknownFamilies) {
    for (const entry of entries) {
      if (entry.isDirectory() && !members.has(entry.name)) {
        members.set(entry.name, { family: entry.name, segments: [entry.name], retentionCap: policy.run_count_cap });
      }
    }
  }

  const summaries = {};
  const attention = [];
  for (const family of [...members.keys()].sort()) {
    const entry = members.get(family);
    const summary = await inspectArtifactFamily({
      pointerFor,
      root: join(root, ...entry.segments),
      family,
      nowMs,
      retentionCap: entry.retentionCap,
      maxBytes,
    });
    summaries[family] = summary;
    for (const reason of summary.attention) attention.push(reason);
  }

  const total = Object.values(summaries).reduce((acc, family) => ({
    run_count: acc.run_count + family.run_count,
    file_count: acc.file_count + family.file_count,
    directory_count: acc.directory_count + family.directory_count,
    symlink_count: acc.symlink_count + family.symlink_count,
    unreadable: acc.unreadable + family.unreadable,
    bytes: acc.bytes + family.bytes,
  }), emptyArtifactTotals());
  const statuses = Object.values(summaries).map((family) => family.status);
  const status = statuses.includes('blocked')
    ? 'blocked'
    : attention.length > 0
      ? 'needs_attention'
      : statuses.includes('available')
        ? 'available'
        : statuses.includes('empty')
          ? 'empty'
          : 'missing';

  return { status, root, policy, total, families: summaries, attention };
}

// retentionCap === null ⇒ the family is retention-EXEMPT (profiles): NO retention
// pressure of ANY kind, count or bytes. It is not "cap 0" and not "cap Infinity" —
// it is a family whose entries are operator inputs, so counting them is not a
// diagnosis runtime is entitled to make (artifact-policy.md §Retention). Exempting
// only the COUNT would leave the byte cap telling an operator with one large profile
// to "remove obsolete generated artifacts" — advice to delete the very input the
// exemption exists to protect.
async function inspectArtifactFamily({ pointerFor, root, family, nowMs, retentionCap, maxBytes }) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    const missing = String(err.code ?? '') === 'ENOENT';
    return {
      ...missingArtifactFamily({ familyRoot: root, family, pointerFor }),
      status: missing ? 'missing' : 'blocked',
      error: err.code ?? err.message,
    };
  }

  const runCount = entries.filter((entry) => entry.isDirectory()).length;
  const totals = await summarizeArtifactPath(root);
  const retentionExempt = retentionCap === null;
  const attention = [];
  if (!retentionExempt && runCount > retentionCap) {
    attention.push({
      family,
      kind: 'run_count_exceeds_cap',
      observed: runCount,
      limit: retentionCap,
      recommendation: `Review ${pointerFor(root)} and remove obsolete generated artifacts manually; runtime:doctor does not delete artifacts.`,
    });
  }
  if (!retentionExempt && totals.bytes > maxBytes) {
    attention.push({
      family,
      kind: 'bytes_exceed_cap',
      observed: totals.bytes,
      limit: maxBytes,
      recommendation: `Review ${pointerFor(root)} and remove obsolete generated artifacts manually; runtime:doctor does not delete artifacts.`,
    });
  }
  const status = totals.unreadable > 0
    ? 'blocked'
    : attention.length > 0
      ? 'needs_attention'
      : runCount > 0 || totals.file_count > 0
        ? 'available'
        : 'empty';

  return {
    family,
    status,
    root,
    pointer: pointerFor(root),
    run_count: runCount,
    file_count: totals.file_count,
    directory_count: totals.directory_count,
    symlink_count: totals.symlink_count,
    unreadable: totals.unreadable,
    bytes: totals.bytes,
    oldest_mtime: totals.oldest_mtime_ms === null ? null : new Date(totals.oldest_mtime_ms).toISOString(),
    newest_mtime: totals.newest_mtime_ms === null ? null : new Date(totals.newest_mtime_ms).toISOString(),
    oldest_age_minutes: totals.oldest_mtime_ms === null ? null : Math.max(0, Math.floor((nowMs - totals.oldest_mtime_ms) / 60000)),
    attention,
  };
}

async function summarizeArtifactPath(path) {
  const totals = {
    file_count: 0,
    directory_count: 0,
    symlink_count: 0,
    unreadable: 0,
    bytes: 0,
    oldest_mtime_ms: null,
    newest_mtime_ms: null,
  };
  await walkArtifactPath(path, totals);
  return totals;
}

async function walkArtifactPath(path, totals) {
  let info;
  try {
    info = await lstat(path);
  } catch {
    totals.unreadable += 1;
    return;
  }

  if (info.isSymbolicLink()) {
    totals.symlink_count += 1;
    totals.bytes += safeCount(info.size);
    updateArtifactMtime(totals, info.mtimeMs);
    return;
  }
  if (info.isDirectory()) {
    totals.directory_count += 1;
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      totals.unreadable += 1;
      return;
    }
    for (const entry of entries) {
      await walkArtifactPath(join(path, entry.name), totals);
    }
    return;
  }
  if (info.isFile()) {
    totals.file_count += 1;
    totals.bytes += safeCount(info.size);
    updateArtifactMtime(totals, info.mtimeMs);
  }
}

function updateArtifactMtime(totals, mtimeMs) {
  if (!Number.isFinite(mtimeMs)) return;
  totals.oldest_mtime_ms = totals.oldest_mtime_ms === null ? mtimeMs : Math.min(totals.oldest_mtime_ms, mtimeMs);
  totals.newest_mtime_ms = totals.newest_mtime_ms === null ? mtimeMs : Math.max(totals.newest_mtime_ms, mtimeMs);
}

function missingArtifactFamily({ familyRoot, family, pointerFor }) {
  return {
    family,
    status: 'missing',
    root: familyRoot,
    pointer: pointerFor(familyRoot),
    run_count: 0,
    file_count: 0,
    directory_count: 0,
    symlink_count: 0,
    unreadable: 0,
    bytes: 0,
    oldest_mtime: null,
    newest_mtime: null,
    oldest_age_minutes: null,
    attention: [],
  };
}

function emptyArtifactTotals() {
  return {
    run_count: 0,
    file_count: 0,
    directory_count: 0,
    symlink_count: 0,
    unreadable: 0,
    bytes: 0,
  };
}

function artifactInventoryLimits() {
  return [
    'Inventory uses filesystem metadata only and does not read raw artifact bodies.',
    'Inventory is advisory and read-only; no retention, cleanup, deletion, or compaction happens in runtime:doctor.',
    'Generated artifacts remain under .agentic-plugins/runs/ and stay gitignored by artifact policy.',
  ];
}

function machineArtifactInventoryLimits() {
  return [
    'Inventory uses filesystem metadata only and does not read raw artifact bodies.',
    'Inventory is advisory and read-only; no retention, cleanup, deletion, or compaction happens in runtime:doctor.',
    'Machine-global artifacts live outside every repository, so gitignore policy neither covers nor needs to cover them.',
    'Bootstrap runs report retention pressure past the cap; profiles are retention-exempt and never reported as pressure.',
  ];
}

export async function inspectWorkflowNamespace({ repoRoot, plugin, legacyNamespace, expectedPlugin, now, staleGraceMs }) {
  const canonicalRoot = join(repoRoot, '.agentic-plugins', 'state', plugin);
  const legacyRoot = join(repoRoot, '.claude', legacyNamespace);
  const canonical = await scanOneWorkflowHome({
    root: canonicalRoot,
    home: 'canonical',
    expectedPlugin,
    now,
    staleGraceMs,
  });
  const legacy = await scanOneWorkflowHome({
    root: legacyRoot,
    home: 'legacy',
    expectedPlugin,
    now,
    staleGraceMs,
  });
  const storage = summarizeWorkflowStorage({ canonical, legacy, plugin });
  const selected = storage.selected_home === 'canonical' ? canonical : legacy;
  return {
    root: selected.root,
    workflows: selected.workflows,
    peer_runs: selected.peer_runs,
    storage,
    homes: {
      canonical,
      legacy,
    },
  };
}

export async function scanOneWorkflowHome({ root, home, expectedPlugin, now, staleGraceMs }) {
  const workflowsDir = join(root, 'workflows');
  const peerRunsDir = join(root, 'peer-runs');
  const workflows = await scanWorkflowFiles(workflowsDir);
  const peerRuns = await scanPeerRuns(peerRunsDir, expectedPlugin, now, staleGraceMs);
  return {
    home,
    root,
    workflows,
    peer_runs: peerRuns,
    has_state: workflows.count > 0 || peerRuns.count > 0,
  };
}

function summarizeWorkflowStorage({ canonical, legacy, plugin }) {
  const canonicalHas = canonical.has_state;
  const legacyHas = legacy.has_state;
  const canonicalBranches = branchSet(canonical.workflows.files);
  const legacyBranches = branchSet(legacy.workflows.files);
  const overlappingBranches = [...canonicalBranches].filter((branch) => legacyBranches.has(branch)).sort();

  let status = 'empty';
  let selectedHome = 'canonical';
  let recommendation = 'No workflow state found; new state should use the canonical .agentic-plugins/state home.';
  if (canonicalHas && !legacyHas) {
    status = 'canonical';
    selectedHome = 'canonical';
    recommendation = 'Workflow state is already under the canonical .agentic-plugins/state home.';
  } else if (!canonicalHas && legacyHas) {
    status = 'legacy';
    selectedHome = 'legacy';
    recommendation = 'Legacy .claude workflow state is present; migrate explicitly before switching writes to .agentic-plugins/state.';
  } else if (canonicalHas && legacyHas) {
    status = overlappingBranches.length > 0 ? 'ambiguous' : 'migration_blocked';
    selectedHome = 'canonical';
    recommendation = overlappingBranches.length > 0
      ? 'Both canonical and legacy homes contain workflow state for the same branch; reconcile before migration.'
      : 'Both canonical and legacy homes contain state; inspect and migrate explicitly before ordinary workflow writes.';
  }

  if (
    (canonical.peer_runs.status === 'blocked' || legacy.peer_runs.status === 'blocked') &&
    status !== 'ambiguous'
  ) {
    status = 'migration_blocked';
    recommendation = 'Peer-run ledger health blocks safe migration; resolve non-terminal stale or malformed handles first.';
  }

  return {
    status,
    plugin,
    selected_home: selectedHome,
    canonical_root: canonical.root,
    legacy_root: legacy.root,
    canonical_has_state: canonicalHas,
    legacy_has_state: legacyHas,
    overlapping_branches: overlappingBranches,
    recommendation,
  };
}

function branchSet(files) {
  const result = new Set();
  for (const file of files ?? []) {
    if (typeof file.branch === 'string' && file.branch.length > 0) result.add(file.branch);
  }
  return result;
}

export async function scanWorkflowFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    return { status: 'missing', dir, count: 0, malformed: 0, files: [], error: err.code ?? err.message };
  }
  const files = [];
  let malformed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const path = join(dir, entry.name);
    const text = await readTextIfExists(path);
    const summary = { file: entry.name, status: 'unknown', workflow_id: null, current_phase: null, branch: null };
    if (!text.ok) {
      summary.status = 'blocked';
      summary.reason = text.reason;
      malformed++;
      files.push(summary);
      continue;
    }
    const fm = parseFrontmatterBlock(text.text);
    if (!fm) {
      summary.status = 'blocked';
      summary.reason = 'missing frontmatter block';
      malformed++;
      files.push(summary);
      continue;
    }
    summary.status = 'available';
    summary.workflow_id = extractYamlScalar(fm, 'workflow_id');
    summary.current_phase = extractYamlScalar(fm, 'current_phase');
    summary.branch = extractNestedBranch(fm);
    files.push(summary);
  }
  return {
    status: malformed > 0 ? 'blocked' : 'available',
    dir,
    count: files.length,
    malformed,
    files,
  };
}

export async function scanPeerRuns(dir, expectedPlugin, now, staleGraceMs) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    return {
      status: 'missing',
      dir,
      count: 0,
      non_terminal: 0,
      stale_non_terminal: 0,
      malformed: 0,
      error: err.code ?? err.message,
      runs: [],
    };
  }
  const runs = [];
  let malformed = 0;
  let nonTerminal = 0;
  let staleNonTerminal = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const handlePath = join(dir, entry.name, 'handle.json');
    const handle = await readJsonIfExists(handlePath);
    if (!handle.ok) {
      malformed++;
      runs.push({ run_id: entry.name, status: 'blocked', reason: handle.reason });
      continue;
    }
    const status = typeof handle.json.status === 'string' ? handle.json.status : 'unknown';
    const terminal = TERMINAL_PEER_RUN_STATUSES.has(status);
    const updatedAt = parseDateMs(handle.json.updated_at);
    const stale = !terminal && updatedAt !== null && now.getTime() - updatedAt > staleGraceMs;
    const issues = validatePeerRunHandle(handle.json, {
      expectedPlugin,
      status,
      updatedAt,
      terminal,
    });
    if (!terminal) nonTerminal++;
    if (stale) staleNonTerminal++;
    if (issues.length > 0) malformed++;
    runs.push({
      run_id: handle.json.run_id ?? entry.name,
      status,
      terminal,
      stale,
      plugin: sanitizeValue(handle.json.plugin),
      plugin_matches_namespace: handle.json.plugin === expectedPlugin,
      kind: sanitizeValue(handle.json.kind),
      peer_host: sanitizeValue(handle.json.peer_host),
      model: sanitizeValue(handle.json.model),
      effort: sanitizeValue(handle.json.effort),
      updated_at: sanitizeValue(handle.json.updated_at),
      issues,
    });
  }
  return {
    status: malformed > 0 || staleNonTerminal > 0 ? 'blocked' : 'available',
    dir,
    count: runs.length,
    non_terminal: nonTerminal,
    stale_non_terminal: staleNonTerminal,
    malformed,
    runs,
  };
}

function validatePeerRunHandle(handle, { expectedPlugin, status, updatedAt, terminal }) {
  const issues = [];
  if (typeof handle.run_id !== 'string' || handle.run_id.length === 0) {
    issues.push('missing run_id');
  }
  if (handle.plugin !== expectedPlugin) {
    issues.push(`plugin mismatch: expected ${expectedPlugin}`);
  }
  if (!VALID_PEER_RUN_STATUSES.has(status)) {
    issues.push(`invalid status: ${status}`);
  }
  if (!terminal && updatedAt === null) {
    issues.push('non-terminal run missing valid updated_at');
  }
  if (handle.kind !== undefined && typeof handle.kind !== 'string') {
    issues.push('kind must be a string when present');
  }
  if (handle.peer_host !== undefined && typeof handle.peer_host !== 'string') {
    issues.push('peer_host must be a string when present');
  }
  return issues;
}
