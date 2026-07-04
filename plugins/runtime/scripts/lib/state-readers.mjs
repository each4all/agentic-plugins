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
import { basename, dirname, join, relative, sep } from 'node:path';
import { sanitizeValue } from './permission-sanitize.mjs';

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
const RUNTIME_ARTIFACT_FAMILIES = ['compat', 'consensus', 'context', 'settings', 'doctor', 'permission', 'notification'];

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
  const status = malformed > 0
    ? 'blocked'
    : latest.status === 'release_notes_required'
      ? 'release_notes_required'
      : ['snapshot_only', 'gap_analysis_ready', 'plan_ready'].includes(latest.status)
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
  const status = malformed.length > 0
    ? 'blocked'
    : plan.status === 'available'
      ? planStatus === 'blocked_release_notes_required'
        ? 'release_notes_required'
        : 'plan_ready'
      : gap.status === 'available'
        ? gapOverall.status === 'release_notes_required' || gapOverall.release_notes_required === true
          ? 'release_notes_required'
          : gapOverall.status === 'current'
            ? 'current'
            : 'gap_analysis_ready'
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
  if (status === 'blocked') return ['Repair malformed runtime:compat artifacts, then rerun runtime:compat check.'];
  if (status === 'snapshot_only') return [`runtime:compat check --run-id ${runId}`];
  if (status === 'release_notes_required') {
    const steps = Array.isArray(gap.json?.next_steps) ? gap.json.next_steps : [];
    return steps.length > 0 ? steps.map((step) => sanitizeValue(step)).filter(Boolean) : [`runtime:compat ingest-release-notes --run-id ${runId} --release-notes-file <path>`];
  }
  if (status === 'gap_analysis_ready') return [`runtime:compat plan --run-id ${runId}`];
  if (status === 'plan_ready') {
    const steps = Array.isArray(plan.json?.recommended_sequence)
      ? plan.json.recommended_sequence.map((item) => sanitizeValue(item.step)).filter(Boolean)
      : [];
    return steps.length > 0 ? steps : ['Review the runtime:compat update plan before changing compatibility-sensitive surfaces.'];
  }
  return [];
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

export async function inspectRuntimeArtifactInventory({ repoRoot, now, retentionCap, maxBytes }) {
  const root = join(repoRoot, '.agentic-plugins', 'runs');
  const policy = {
    run_count_cap: retentionCap,
    byte_cap: maxBytes,
  };
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    const missing = String(err.code ?? '') === 'ENOENT';
    return {
      requested: true,
      executed: true,
      status: missing ? 'missing' : 'blocked',
      root,
      policy,
      total: emptyArtifactTotals(),
      families: Object.fromEntries(RUNTIME_ARTIFACT_FAMILIES.map((family) => [family, missingArtifactFamily(root, family)])),
      attention: [],
      error: err.code ?? err.message,
      limits: artifactInventoryLimits(),
    };
  }

  const familyNames = new Set(RUNTIME_ARTIFACT_FAMILIES);
  for (const entry of entries) {
    if (entry.isDirectory()) familyNames.add(entry.name);
  }

  const families = {};
  const attention = [];
  for (const family of [...familyNames].sort()) {
    const summary = await inspectArtifactFamily({
      repoRoot,
      root: join(root, family),
      family,
      nowMs: now.getTime(),
      retentionCap,
      maxBytes,
    });
    families[family] = summary;
    for (const reason of summary.attention) attention.push(reason);
  }

  const total = Object.values(families).reduce((acc, family) => ({
    run_count: acc.run_count + family.run_count,
    file_count: acc.file_count + family.file_count,
    directory_count: acc.directory_count + family.directory_count,
    symlink_count: acc.symlink_count + family.symlink_count,
    unreadable: acc.unreadable + family.unreadable,
    bytes: acc.bytes + family.bytes,
  }), emptyArtifactTotals());
  const statuses = Object.values(families).map((family) => family.status);
  const status = statuses.includes('blocked')
    ? 'blocked'
    : attention.length > 0
      ? 'needs_attention'
      : statuses.includes('available')
        ? 'available'
        : statuses.includes('empty')
          ? 'empty'
          : 'missing';

  return {
    requested: true,
    executed: true,
    status,
    root,
    policy,
    total,
    families,
    attention,
    limits: artifactInventoryLimits(),
  };
}

async function inspectArtifactFamily({ repoRoot, root, family, nowMs, retentionCap, maxBytes }) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    const missing = String(err.code ?? '') === 'ENOENT';
    return {
      ...missingArtifactFamily(dirname(root), family),
      status: missing ? 'missing' : 'blocked',
      error: err.code ?? err.message,
    };
  }

  const runCount = entries.filter((entry) => entry.isDirectory()).length;
  const totals = await summarizeArtifactPath(root);
  const attention = [];
  if (runCount > retentionCap) {
    attention.push({
      family,
      kind: 'run_count_exceeds_cap',
      observed: runCount,
      limit: retentionCap,
      recommendation: `Review ${pointer(repoRoot, root)} and remove obsolete generated artifacts manually; runtime:doctor does not delete artifacts.`,
    });
  }
  if (totals.bytes > maxBytes) {
    attention.push({
      family,
      kind: 'bytes_exceed_cap',
      observed: totals.bytes,
      limit: maxBytes,
      recommendation: `Review ${pointer(repoRoot, root)} and remove obsolete generated artifacts manually; runtime:doctor does not delete artifacts.`,
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
    pointer: pointer(repoRoot, root),
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

function missingArtifactFamily(root, family) {
  return {
    family,
    status: 'missing',
    root: join(root, family),
    pointer: `.agentic-plugins/runs/${family}`,
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
