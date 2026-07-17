#!/usr/bin/env node
// plugins/runtime/scripts/dashboard.mjs
//
// ADR-0040 Decision §6: runtime:dashboard — the aggregate operator view that
// collapses "re-run doctor + read ledger files" into one R0 read-only
// snapshot. Two tiers:
//   Tier 1 (agentic state): active workflows for ALL THREE personas —
//     engineer, orchestrator, AND founder via the persona-generic
//     inspectWorkflowNamespace reader (dashboard calls plugin:'founder'
//     directly; doctor's {engineer, orchestrator} inspectWorkflowLedgers
//     contract stays untouched) — peer runs with stale/non-terminal
//     emphasis, orchestrator macro subtask progress, consensus run states.
//   Tier 2 (operator health): doctor/compat/baseline freshness, settings +
//     Codex hook-attestation recency, artifact-inventory attention items,
//     notify-state health, and the file-log channel's recent notifications
//     when configured.
//
// R0 per ADR-0035: pure filesystem reads — no spawning, no host-CLI probing
// (that is doctor's job; the dashboard reports the RECORDED doctor/compat
// evidence and its age instead of re-probing), no mutation. `--watch`
// re-renders from filesystem reads only, with a bounded poll interval
// (default 2s, floor 1s) and an explicit exit (SIGINT/SIGTERM, or a bounded
// --watch-count) — never an unattended daemon.
//
// Notify state (.agentic-plugins/state/runtime/notify/) is read directly as
// the dashboard's own source: it lives under state/, not runs/, so the
// runs/-scanning artifact inventory needs no new family registration.

import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RUNTIME_VERSION } from './version.mjs';
import { sanitizeValue } from './lib/permission-sanitize.mjs';
import { notifyDedupeDir, notifyStateDir } from './lib/notify-schema.mjs';
import { egressThrottleDir, inspectEgressThrottles } from './lib/egress-semantics.mjs';
import { NOTIFY_KEY_DEFAULTS } from './lib/runtime-config.mjs';
import { loadNotifyConfig, resolveRepoRoot, NOTIFY_LOG_ROTATE_LOCK_STALE_MS } from './notify.mjs';
import {
  inspectCompatRuns,
  inspectConsensusRuns,
  inspectRuntimeArtifactInventory,
  inspectWorkflowNamespace,
  extractYamlScalar,
  pointer,
  readJsonIfExists,
  readTextIfExists,
  artifactTimestampMs,
} from './lib/state-readers.mjs';

export const DASHBOARD_SCHEMA_VERSION = 'runtime-dashboard-1.0';
export const DEFAULT_WATCH_INTERVAL_SECONDS = 2;
export const MIN_WATCH_INTERVAL_SECONDS = 1;
export const DEFAULT_RECENT_NOTIFICATIONS = 5;
export const MAX_LISTED_ROWS = 8;

// Same defaults doctor applies to its ledger scan and artifact inventory —
// the dashboard mirrors them so both surfaces judge "stale" identically.
const DEFAULT_STALE_GRACE_MS = 60000;
const DEFAULT_ARTIFACT_RETENTION_CAP = 20;
const DEFAULT_ARTIFACT_RETENTION_MAX_BYTES = 50 * 1024 * 1024;

const DOCTOR_RUN_ID_RE = /^doctor-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const SETTINGS_RUN_ID_RE = /^settings-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
// Nonterminal write-ahead settings-execution statuses (machine-bootstrap-contract.md
// §1.5) — an interrupted run the recency view must flag, never present as healthy.
const SETTINGS_EXECUTION_NONTERMINAL_STATUSES = new Set(['planned', 'in-progress']);
// Doctor's own recorded-artifact contract (doctor.mjs isDoctorArtifact):
// a parseable JSON blob is NOT doctor evidence unless it carries the doctor
// artifact schema and an embedded report — the dashboard must not report
// bogus recorded freshness (Codex review MAJOR).
const DOCTOR_ARTIFACT_SCHEMA_VERSION = 'runtime-doctor-artifact-1.0';
const DOCTOR_REPORT_SCHEMA_VERSION = 'runtime-doctor-1.0';
// ADR-0040 §6 scopes the dashboard to attestation RECENCY. Doctor's stricter
// CURRENCY judgment (plugin set/version drift, disabled hook state) needs
// live plugin-cache and hook-state evidence the R0 dashboard must not probe.
export const HOOK_ATTESTATION_RECENCY_NOTE =
  'recency only — currency (plugin set/version drift, hook state) is judged by runtime:doctor';

// All three personas from day one (ADR-0040 §6): founder has no pre-ADR-0025
// legacy home, so its legacy scan degrades to 'missing' — by design.
export const DASHBOARD_PERSONAS = Object.freeze([
  Object.freeze({ plugin: 'engineer', legacyNamespace: 'agentic-engineer' }),
  Object.freeze({ plugin: 'orchestrator', legacyNamespace: 'agentic-orchestrator' }),
  Object.freeze({ plugin: 'founder', legacyNamespace: 'agentic-founder' }),
]);

// ---------------------------------------------------------------------------
// Tier 1 — persona projections
// ---------------------------------------------------------------------------

function projectPersonaNamespace(plugin, namespace) {
  const workflows = namespace.workflows ?? {};
  const peerRuns = namespace.peer_runs ?? {};
  const files = Array.isArray(workflows.files) ? workflows.files : [];
  const runs = Array.isArray(peerRuns.runs) ? peerRuns.runs : [];
  return {
    plugin,
    storage_status: namespace.storage?.status ?? 'empty',
    selected_home: namespace.storage?.selected_home ?? 'canonical',
    workflows: {
      status: workflows.status ?? 'missing',
      count: workflows.count ?? 0,
      malformed: workflows.malformed ?? 0,
      active: files
        .filter((file) => file.status === 'available')
        .map((file) => ({
          workflow_id: file.workflow_id,
          current_phase: file.current_phase,
          branch: file.branch,
          file: file.file,
        })),
    },
    peer_runs: {
      status: peerRuns.status ?? 'missing',
      count: peerRuns.count ?? 0,
      non_terminal: peerRuns.non_terminal ?? 0,
      stale_non_terminal: peerRuns.stale_non_terminal ?? 0,
      malformed: peerRuns.malformed ?? 0,
      // Emphasis rows only (ADR-0040 §6): terminal, healthy runs stay counts.
      attention: runs
        .filter((run) => run.status === 'blocked' || !run.terminal || run.stale || (run.issues?.length ?? 0) > 0)
        .map((run) => ({
          run_id: run.run_id,
          status: run.status,
          stale: run.stale === true,
          kind: run.kind ?? null,
          peer_host: run.peer_host ?? null,
          updated_at: run.updated_at ?? null,
          issues: run.issues ?? [],
        })),
    },
  };
}

// CRLF-tolerant frontmatter extraction: the shared parseFrontmatterBlock is
// deliberately LF-only (changing it would change doctor's malformed-file
// verdicts, which this slice must not touch), so the macro scanner carries
// its own extractor — a Windows-edited macro file must not silently parse
// as "no subtasks".
function extractFrontmatterCrlfTolerant(text) {
  const match = String(text ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match ? match[1] : null;
}

// Line-oriented plan.subtasks scanner for macro workflow frontmatter. Regex
// inline (copy-not-import boundary is cross-plugin; this stays runtime-local)
// and CRLF-tolerant: frontmatter may carry \r\n from Windows-edited files.
export function parseMacroSubtasks(text) {
  const frontmatter = extractFrontmatterCrlfTolerant(text);
  if (!frontmatter) return null;
  if (extractYamlScalar(frontmatter, 'workflow_type') !== 'macro') return null;
  const subtasks = [];
  let inPlan = false;
  let inSubtasks = false;
  let current = null;
  for (const rawLine of frontmatter.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    if (/^[A-Za-z_]/.test(line)) {
      inPlan = /^plan:\s*$/.test(line);
      inSubtasks = false;
      current = null;
      continue;
    }
    if (!inPlan) continue;
    if (/^\s{2}subtasks:\s*$/.test(line)) {
      inSubtasks = true;
      current = null;
      continue;
    }
    if (/^\s{2}\S/.test(line)) {
      // Another plan-level key (decision:, architecture:) ends the list.
      inSubtasks = false;
      current = null;
      continue;
    }
    if (!inSubtasks) continue;
    // Any `- key:` line opens a new list item — YAML does not require `id`
    // to be the first mapping key (Codex review MINOR), so an item whose
    // serialization leads with another key must not be silently dropped.
    const itemMatch = line.match(/^\s+-\s+([A-Za-z_]+):\s*(.*)$/);
    if (itemMatch) {
      current = { id: null, label: null, status: 'unknown' };
      subtasks.push(current);
      applySubtaskField(current, itemMatch[1], itemMatch[2]);
      continue;
    }
    if (!current) continue;
    const fieldMatch = line.match(/^\s+([A-Za-z_]+):\s*(.*)$/);
    if (fieldMatch) applySubtaskField(current, fieldMatch[1], fieldMatch[2]);
  }
  return subtasks;
}

function applySubtaskField(subtask, key, rawValue) {
  if (!['id', 'label', 'status'].includes(key)) return;
  const value = sanitizeValue(rawValue.trim().replace(/^"(.*)"\s*$/, '$1'));
  if (key === 'id') subtask.id = value;
  else if (key === 'label') subtask.label = value;
  else subtask.status = value ?? 'unknown';
}

async function inspectMacroProgress({ repoRoot, orchestratorNamespace }) {
  const workflows = orchestratorNamespace.workflows ?? {};
  const dir = workflows.dir;
  const files = Array.isArray(workflows.files) ? workflows.files : [];
  const macros = [];
  for (const file of files) {
    if (file.status !== 'available' || !dir) continue;
    const filePath = path.join(dir, file.file);
    const text = await readTextIfExists(filePath);
    if (!text.ok) continue;
    const subtasks = parseMacroSubtasks(text.text);
    if (!subtasks) continue;
    const byStatus = {};
    for (const subtask of subtasks) {
      byStatus[subtask.status] = (byStatus[subtask.status] ?? 0) + 1;
    }
    macros.push({
      workflow_id: file.workflow_id,
      current_phase: file.current_phase,
      branch: file.branch,
      pointer: pointer(repoRoot, filePath),
      subtasks: {
        total: subtasks.length,
        by_status: byStatus,
        // Non-terminal rows are the operator-attention set.
        active: subtasks
          .filter((subtask) => !['completed', 'deferred', 'abandoned'].includes(subtask.status))
          .map((subtask) => ({ id: subtask.id, status: subtask.status })),
      },
    });
  }
  return { count: macros.length, macros };
}

// ---------------------------------------------------------------------------
// Tier 2 — recorded doctor / settings run recency (filesystem-only)
// ---------------------------------------------------------------------------

// The dashboard never re-probes host CLIs, so "doctor freshness" is the
// recency of the RECORDED doctor artifact: when it was recorded and whether
// it was recorded by the current runtime version.
export async function inspectLatestDoctorRun({ repoRoot }) {
  const root = path.join(repoRoot, '.agentic-plugins', 'runs', 'doctor');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    return { status: 'missing', root, count: 0, latest: null, error: err.code ?? err.message };
  }
  const runIds = entries
    .filter((entry) => entry.isDirectory() && DOCTOR_RUN_ID_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (runIds.length === 0) return { status: 'empty', root, count: 0, latest: null };
  // Run ids embed their UTC timestamp, so the lexicographic max is the
  // newest run — only that artifact is read (doctor.json embeds a full
  // report and is the largest runtime artifact).
  const latestId = runIds[runIds.length - 1];
  const artifactPath = path.join(root, latestId, 'doctor.json');
  const artifact = await readJsonIfExists(artifactPath);
  const validShape = artifact.ok
    && artifact.json.schema_version === DOCTOR_ARTIFACT_SCHEMA_VERSION
    && DOCTOR_RUN_ID_RE.test(artifact.json.run_id ?? '')
    && artifact.json.report?.schema_version === DOCTOR_REPORT_SCHEMA_VERSION;
  if (!validShape) {
    return {
      status: 'blocked',
      root,
      count: runIds.length,
      latest: {
        run_id: latestId,
        artifact_pointer: pointer(repoRoot, artifactPath),
        reason: artifact.ok ? 'invalid doctor artifact schema' : artifact.reason,
      },
    };
  }
  const selectedAtMs = artifactTimestampMs(artifact.json, latestId);
  const recordedRuntime = sanitizeValue(artifact.json.runtime_version);
  return {
    status: 'available',
    root,
    count: runIds.length,
    latest: {
      run_id: sanitizeValue(artifact.json.run_id) ?? latestId,
      status: sanitizeValue(artifact.json.status) ?? 'recorded',
      artifact_pointer: pointer(repoRoot, artifactPath),
      selected_at: selectedAtMs === null ? null : new Date(selectedAtMs).toISOString(),
      selected_at_ms: selectedAtMs ?? 0,
      runtime_version: recordedRuntime,
      runtime_version_current: recordedRuntime === RUNTIME_VERSION,
    },
  };
}

export async function inspectSettingsRecency({ repoRoot }) {
  const root = path.join(repoRoot, '.agentic-plugins', 'runs', 'settings');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    return { status: 'missing', root, count: 0, latest: null, hook_attestation: null, error: err.code ?? err.message };
  }
  const runIds = entries
    .filter((entry) => entry.isDirectory() && SETTINGS_RUN_ID_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse(); // newest first (run ids embed their UTC timestamp)
  if (runIds.length === 0) return { status: 'empty', root, count: 0, latest: null, hook_attestation: null };
  let latest = null;
  let attestation = null;
  let blocked = 0;
  for (const runId of runIds) {
    const artifactPath = path.join(root, runId, 'settings.json');
    const artifact = await readJsonIfExists(artifactPath);
    if (!artifact.ok) {
      blocked += 1;
      if (!latest) {
        latest = { run_id: runId, status: 'blocked', artifact_pointer: pointer(repoRoot, artifactPath), reason: artifact.reason };
      }
      continue;
    }
    const selectedAtMs = artifactTimestampMs(artifact.json, runId);
    if (!latest) {
      const runStatus = sanitizeValue(artifact.json.status) ?? 'recorded';
      latest = {
        run_id: sanitizeValue(artifact.json.run_id) ?? runId,
        status: runStatus,
        // A nonterminal write-ahead record is an interrupted run — flagged so the
        // recency view never presents it as a healthy latest (§1.5 part 3).
        terminal: typeof artifact.json.terminal === 'boolean'
          ? artifact.json.terminal
          : !SETTINGS_EXECUTION_NONTERMINAL_STATUSES.has(runStatus),
        artifact_pointer: pointer(repoRoot, artifactPath),
        selected_at: selectedAtMs === null ? null : new Date(selectedAtMs).toISOString(),
        selected_at_ms: selectedAtMs ?? 0,
      };
    }
    const review = artifact.json.codex_hook_review ?? {};
    if (!attestation && review.attested === true && review.status === 'attested') {
      attestation = {
        run_id: runId,
        scope: HOOK_ATTESTATION_RECENCY_NOTE,
        attested_at: sanitizeValue(review.attested_at),
        bundled_plugins: Array.isArray(review.bundled_plugins)
          ? review.bundled_plugins.map((value) => sanitizeValue(value)).filter(Boolean).sort()
          : [],
        plugin_versions: Object.fromEntries(
          Object.entries(review.plugin_versions ?? {})
            .filter(([, value]) => typeof value === 'string')
            .map(([key, value]) => [sanitizeValue(key), sanitizeValue(value)]),
        ),
        // Canonical S8a4 fields carried through so the recency view names the same
        // Codex-bound versions the attestation records (avoids a stale third mirror).
        attested_plugins: Array.isArray(review.attested_plugins)
          ? review.attested_plugins.map((value) => sanitizeValue(value)).filter(Boolean).sort()
          : [],
        bound_codex_cli: typeof review.bound_versions?.codex === 'string' ? sanitizeValue(review.bound_versions.codex) : null,
        artifact_pointer: pointer(repoRoot, artifactPath),
      };
    }
    if (latest && attestation) break;
  }
  const interrupted = latest ? latest.terminal === false : false;
  return {
    status: blocked > 0 && latest?.status === 'blocked' ? 'blocked' : 'available',
    root,
    count: runIds.length,
    latest,
    interrupted,
    hook_attestation: attestation,
  };
}

// Baseline header parse only — the same regex doctor's
// buildHostParityBaseline uses, minus its live host-version probes (the
// drift verdict against OBSERVED versions is compat's recorded job; the
// dashboard shows the recorded baseline next to the latest compat drift).
export async function readHostParityBaseline({ repoRoot }) {
  const baselinePath = path.join(repoRoot, 'plugins', 'runtime', 'docs', 'host-parity-baseline.md');
  const text = await readTextIfExists(baselinePath);
  if (!text.ok) {
    return { status: 'missing', pointer: pointer(repoRoot, baselinePath), baseline: null, reason: text.reason };
  }
  const match = text.text.match(/Observed on ([0-9-]+) with Claude Code `([^`]+)`, Codex CLI\s*`([^`]+)`/m);
  if (!match) {
    return { status: 'unparsed', pointer: pointer(repoRoot, baselinePath), baseline: null };
  }
  return {
    status: 'available',
    pointer: pointer(repoRoot, baselinePath),
    baseline: { date: match[1], claude: match[2], codex: match[3] },
  };
}

// ---------------------------------------------------------------------------
// Tier 2 — notify config, notify-state health, recent notifications
// ---------------------------------------------------------------------------

export function summarizeNotifyConfig({ repoRoot, homeDir }) {
  const loaded = loadNotifyConfig({ repoRoot, homeDir });
  if (!loaded.ok) {
    return { status: 'invalid', channel: null, errors: loaded.errors, config: null };
  }
  return {
    status: loaded.config.channel === 'none' ? 'off' : 'configured',
    channel: loaded.config.channel,
    errors: [],
    config: loaded.config,
  };
}

async function statIfExists(targetPath) {
  try {
    return { ok: true, stats: await stat(targetPath) };
  } catch (err) {
    return { ok: false, code: err.code ?? err.message };
  }
}

// Notify-state health (ADR-0040 §6): unreadable notify state, stale dedupe
// claim buildup (expired claims linger until the SAME event_id re-fires —
// a claim for a subject that never recurs is never reclaimed), and crashed
// rotation/reclaim lock leftovers.
export async function inspectNotifyState({
  repoRoot,
  now = Date.now(),
  ttlSeconds = Number.parseInt(NOTIFY_KEY_DEFAULTS.notify_dedupe_ttl_seconds, 10),
  lockStaleMs = NOTIFY_LOG_ROTATE_LOCK_STALE_MS,
} = {}) {
  const dir = notifyStateDir(repoRoot);
  const dedupeDir = notifyDedupeDir(repoRoot);
  const result = {
    status: 'missing',
    root: dir,
    dedupe: { claims: 0, expired_claims: 0, reclaim_locks: 0, stale_reclaim_locks: 0, unreadable: 0 },
    log: { present: false, bytes: 0, rotated_present: false, rotated_bytes: 0, rotate_lock_present: false, rotate_lock_stale: false },
    // ADR-0041 §6 egress attempt-visibility: active failure throttles are an
    // informational rollup (a provider hiccup in cooldown is expected, not a
    // runtime health fault), so they never flip `status`; only an unreadable
    // throttle dir raises an issue.
    egress: { throttles: 0, active_throttles: 0, next_retry_at: null },
    issues: [],
  };
  try {
    await readdir(dir);
  } catch (err) {
    if (String(err.code ?? '') === 'ENOENT') return result; // never notified — expected until a channel is configured
    result.status = 'blocked';
    result.issues.push(`notify state unreadable: ${err.code ?? err.message}`);
    return result;
  }

  let dedupeEntries = [];
  try {
    dedupeEntries = await readdir(dedupeDir, { withFileTypes: true });
  } catch (err) {
    if (String(err.code ?? '') !== 'ENOENT') {
      result.dedupe.unreadable += 1;
      result.issues.push(`dedupe dir unreadable: ${err.code ?? err.message}`);
    }
  }
  const ttlMs = (Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 300) * 1000;
  for (const entry of dedupeEntries) {
    const entryPath = path.join(dedupeDir, entry.name);
    const info = await statIfExists(entryPath);
    if (!info.ok) {
      result.dedupe.unreadable += 1;
      continue;
    }
    if (entry.isDirectory() && entry.name.endsWith('.reclaim.lock')) {
      result.dedupe.reclaim_locks += 1;
      if (now - info.stats.mtimeMs >= lockStaleMs) result.dedupe.stale_reclaim_locks += 1;
      continue;
    }
    if (entry.isFile()) {
      result.dedupe.claims += 1;
      if (now - info.stats.mtimeMs > ttlMs) result.dedupe.expired_claims += 1;
    }
  }

  const logPath = path.join(dir, 'log.ndjson');
  const logInfo = await statIfExists(logPath);
  if (logInfo.ok) {
    result.log.present = true;
    result.log.bytes = logInfo.stats.size;
  }
  const rotatedInfo = await statIfExists(`${logPath}.1`);
  if (rotatedInfo.ok) {
    result.log.rotated_present = true;
    result.log.rotated_bytes = rotatedInfo.stats.size;
  }
  const rotateLockInfo = await statIfExists(`${logPath}.rotate.lock`);
  if (rotateLockInfo.ok) {
    result.log.rotate_lock_present = true;
    result.log.rotate_lock_stale = now - rotateLockInfo.stats.mtimeMs >= lockStaleMs;
  }

  if (result.dedupe.expired_claims > 0) {
    result.issues.push(`stale claim buildup: ${result.dedupe.expired_claims} expired dedupe claim file(s) under ${pointer(repoRoot, dedupeDir)}`);
  }
  if (result.dedupe.stale_reclaim_locks > 0) {
    result.issues.push(`stale reclaim lock(s): ${result.dedupe.stale_reclaim_locks} — a dedupe reclaim did not complete (crashed process?)`);
  }
  if (result.log.rotate_lock_stale) {
    result.issues.push('stale log rotation lock — a log.ndjson rotation did not complete (crashed process?)');
  }

  // ADR-0041 §6 — egress failure-throttle rollup (active cooldowns + earliest
  // upcoming retry). Informational: an active throttle does not flip status;
  // only an unreadable throttle record raises an issue.
  const egress = inspectEgressThrottles({ throttleDir: egressThrottleDir(repoRoot), now });
  result.egress = {
    throttles: egress.total,
    active_throttles: egress.active,
    next_retry_at: egress.next_retry_at,
  };
  if (egress.unreadable > 0) {
    result.issues.push(`egress throttle state partially unreadable: ${egress.unreadable} record(s)`);
  }

  result.status = result.dedupe.unreadable > 0 || result.issues.some((issue) => issue.includes('unreadable'))
    ? 'blocked'
    : result.issues.length > 0
      ? 'needs_attention'
      : 'available';
  return result;
}

function tailLines(text, limit) {
  const lines = String(text ?? '').split('\n').filter((line) => line.trim().length > 0);
  return lines.slice(Math.max(0, lines.length - limit));
}

// Recent notification history from the file-log channel: the newest `limit`
// records across the two bounded generations (log.ndjson.1 then log.ndjson).
export async function readRecentNotifications({ repoRoot, limit = DEFAULT_RECENT_NOTIFICATIONS } = {}) {
  const logPath = path.join(notifyStateDir(repoRoot), 'log.ndjson');
  const current = await readTextIfExists(logPath);
  const rotated = await readTextIfExists(`${logPath}.1`);
  if (!current.ok && !rotated.ok) {
    return { status: 'missing', pointer: pointer(repoRoot, logPath), entries: [], malformed: 0 };
  }
  const rawLines = [
    ...(rotated.ok ? tailLines(rotated.text, limit) : []),
    ...(current.ok ? tailLines(current.text, limit) : []),
  ].slice(-limit);
  const entries = [];
  let malformed = 0;
  for (const line of rawLines) {
    try {
      const record = JSON.parse(line);
      const entry = {
        ts: sanitizeValue(record.ts),
        kind: sanitizeValue(record.kind),
        urgency: sanitizeValue(record.urgency),
        title: sanitizeValue(record.title),
        event_id: sanitizeValue(record.event_id),
      };
      // ADR-0041 §6 — surface the egress overlay ONLY on attempt-mirror rows;
      // local-channel records stay byte-identical (no new keys) so existing
      // consumers are unaffected.
      if (record.egress_status !== undefined) {
        entry.egress_channel = sanitizeValue(record.egress_channel);
        entry.egress_status = sanitizeValue(record.egress_status);
        entry.egress_outcome = sanitizeValue(record.egress_outcome);
      }
      entries.push(entry);
    } catch {
      malformed += 1;
    }
  }
  return { status: 'available', pointer: pointer(repoRoot, logPath), entries, malformed };
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

export async function buildDashboardReport({
  repoRoot,
  now = new Date(),
  homeDir = os.homedir(),
  staleGraceMs = DEFAULT_STALE_GRACE_MS,
  recentLimit = DEFAULT_RECENT_NOTIFICATIONS,
} = {}) {
  const personas = {};
  let orchestratorNamespace = null;
  for (const persona of DASHBOARD_PERSONAS) {
    const namespace = await inspectWorkflowNamespace({
      repoRoot,
      plugin: persona.plugin,
      legacyNamespace: persona.legacyNamespace,
      expectedPlugin: persona.plugin,
      now,
      staleGraceMs,
    });
    if (persona.plugin === 'orchestrator') orchestratorNamespace = namespace;
    personas[persona.plugin] = projectPersonaNamespace(persona.plugin, namespace);
  }

  const macros = await inspectMacroProgress({ repoRoot, orchestratorNamespace });
  const consensus = await inspectConsensusRuns({ repoRoot });

  const doctor = await inspectLatestDoctorRun({ repoRoot });
  const compat = await inspectCompatRuns({ repoRoot });
  const baseline = await readHostParityBaseline({ repoRoot });
  const settings = await inspectSettingsRecency({ repoRoot });
  const artifacts = await inspectRuntimeArtifactInventory({
    repoRoot,
    now,
    retentionCap: DEFAULT_ARTIFACT_RETENTION_CAP,
    maxBytes: DEFAULT_ARTIFACT_RETENTION_MAX_BYTES,
  });
  const notifyConfig = summarizeNotifyConfig({ repoRoot, homeDir });
  const notifyState = await inspectNotifyState({
    repoRoot,
    now: now.getTime(),
    ttlSeconds: notifyConfig.config ? notifyConfig.config.dedupeTtlSeconds : undefined,
  });
  // ADR-0041 §6 — egress attempt mirrors land in the file-log regardless of the
  // LOCAL notify_channel (E1 activation is separate, §2c), so surface recent
  // rows whenever the log EXISTS, not only when the local channel is file-log —
  // else a telegram-egress mirror written under notify_channel=none/osascript
  // would be hidden from the dashboard the ADR requires it to appear on.
  const recentNotifications = (notifyConfig.channel === 'file-log'
    || notifyState.log.present || notifyState.log.rotated_present)
    ? await readRecentNotifications({ repoRoot, limit: recentLimit })
    : { status: 'not_configured', pointer: null, entries: [], malformed: 0 };

  return {
    schema_version: DASHBOARD_SCHEMA_VERSION,
    generated_at: now.toISOString(),
    repo_root: repoRoot,
    runtime_version: RUNTIME_VERSION,
    tier1: {
      personas,
      macros,
      consensus: {
        status: consensus.status,
        count: consensus.count,
        malformed: consensus.malformed,
        latest: consensus.latest
          ? {
              run_id: consensus.latest.run_id,
              status: consensus.latest.status,
              round: consensus.latest.round,
              selected_at: consensus.latest.selected_at,
              failed: consensus.latest.summary?.failed ?? 0,
              artifact_pointer: consensus.latest.artifact_pointer,
            }
          : null,
      },
    },
    tier2: {
      doctor,
      compat: {
        status: compat.status,
        count: compat.count,
        malformed: compat.malformed,
        latest: compat.latest
          ? {
              run_id: compat.latest.run_id,
              status: compat.latest.status,
              drift_class: compat.latest.drift_class,
              selected_at: compat.latest.selected_at,
              release_notes_required: compat.latest.release_notes_required,
              host_gaps: compat.latest.host_gaps,
              artifact_pointer: compat.latest.artifact_pointer,
            }
          : null,
      },
      baseline,
      settings,
      artifacts: {
        status: artifacts.status,
        total: artifacts.total,
        attention: artifacts.attention,
        root: artifacts.root,
      },
      notify: {
        config: { status: notifyConfig.status, channel: notifyConfig.channel, errors: notifyConfig.errors },
        state: notifyState,
        recent: recentNotifications,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Text rendering
// ---------------------------------------------------------------------------

function ageMinutes(nowMs, isoOrMs) {
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs ?? '');
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.max(0, Math.floor((nowMs - ms) / 60000));
}

function formatAge(nowMs, isoOrMs) {
  const minutes = ageMinutes(nowMs, isoOrMs);
  if (minutes === null) return 'age unknown';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (60 * 24))}d ago`;
}

function listCapped(rows, renderRow, lines) {
  for (const row of rows.slice(0, MAX_LISTED_ROWS)) lines.push(renderRow(row));
  if (rows.length > MAX_LISTED_ROWS) lines.push(`    … and ${rows.length - MAX_LISTED_ROWS} more`);
}

export function renderDashboardText(report) {
  const nowMs = Date.parse(report.generated_at);
  const lines = [];
  lines.push(`runtime:dashboard — ${report.generated_at} (runtime ${report.runtime_version})`);
  lines.push(`repo: ${report.repo_root}`);
  lines.push('');
  lines.push('## Tier 1 — agentic state');
  for (const [plugin, persona] of Object.entries(report.tier1.personas)) {
    const wf = persona.workflows;
    const pr = persona.peer_runs;
    const wfNote = wf.malformed > 0 ? `, ${wf.malformed} malformed` : '';
    lines.push(`- ${plugin}: ${wf.active.length} active workflow(s)${wfNote}; peer-runs ${pr.count} (non-terminal ${pr.non_terminal}, stale ${pr.stale_non_terminal}, malformed ${pr.malformed})`);
    listCapped(wf.active, (row) => `    · ${row.workflow_id ?? row.file} phase=${row.current_phase ?? '?'} branch=${row.branch ?? '?'}`, lines);
    listCapped(pr.attention, (row) => `    ! peer-run ${row.run_id} status=${row.status}${row.stale ? ' STALE' : ''}${row.issues.length > 0 ? ` issues=${row.issues.length}` : ''}`, lines);
  }
  if (report.tier1.macros.count === 0) {
    lines.push('- macros: none active');
  } else {
    for (const macro of report.tier1.macros.macros) {
      const completed = macro.subtasks.by_status.completed ?? 0;
      const active = macro.subtasks.active.map((subtask) => `${subtask.id}=${subtask.status}`).join(', ');
      lines.push(`- macro ${macro.workflow_id}: ${completed}/${macro.subtasks.total} completed${active ? `; open: ${active}` : ''}`);
    }
  }
  const consensus = report.tier1.consensus;
  lines.push(consensus.latest
    ? `- consensus: ${consensus.count} run(s); latest ${consensus.latest.run_id} status=${consensus.latest.status} round=${consensus.latest.round}${consensus.latest.failed > 0 ? ` FAILED=${consensus.latest.failed}` : ''}`
    : `- consensus: ${consensus.status}`);
  lines.push('');
  lines.push('## Tier 2 — operator health');
  const doctor = report.tier2.doctor;
  if (doctor.latest) {
    const versionNote = doctor.latest.runtime_version_current
      ? `runtime ${doctor.latest.runtime_version}`
      : `runtime ${doctor.latest.runtime_version ?? '?'} ≠ current ${report.runtime_version} — STALE`;
    lines.push(`- doctor: ${doctor.latest.run_id} (${formatAge(nowMs, doctor.latest.selected_at)}; ${versionNote})`);
  } else {
    lines.push(`- doctor: ${doctor.status} — no recorded runtime:doctor artifact`);
  }
  const compat = report.tier2.compat;
  if (compat.latest) {
    const gaps = compat.latest.host_gaps
      .filter((gap) => gap.status && !['current', 'matches'].includes(gap.status) && gap.observed_version !== gap.baseline_version)
      .map((gap) => `${gap.host} ${gap.baseline_version ?? '?'}→${gap.observed_version ?? '?'}`)
      .join(', ');
    lines.push(`- compat: ${compat.latest.run_id} status=${compat.latest.status} drift=${compat.latest.drift_class} (${formatAge(nowMs, compat.latest.selected_at)})${gaps ? ` gaps: ${gaps}` : ''}`);
  } else {
    lines.push(`- compat: ${compat.status} — no recorded runtime:compat run`);
  }
  const baseline = report.tier2.baseline;
  lines.push(baseline.baseline
    ? `- baseline: observed ${baseline.baseline.date} — claude ${baseline.baseline.claude}, codex ${baseline.baseline.codex}`
    : `- baseline: ${baseline.status} (${baseline.pointer})`);
  const settings = report.tier2.settings;
  if (settings.latest) {
    const attestation = settings.hook_attestation
      ? `hook attestation ${settings.hook_attestation.attested_at ?? settings.hook_attestation.run_id} (${formatAge(nowMs, settings.hook_attestation.attested_at)}; recency only — doctor judges currency)`
      : 'no codex hook attestation recorded';
    // An interrupted write-ahead run (planned / in-progress) is an attention item,
    // never a healthy latest (machine-bootstrap-contract.md §1.5).
    const interruptedNote = settings.interrupted
      ? ` — ⚠ INTERRUPTED (${settings.latest.status}); journal names what landed, re-run runtime:settings to re-plan`
      : '';
    lines.push(`- settings: ${settings.latest.run_id} (${formatAge(nowMs, settings.latest.selected_at)}); ${attestation}${interruptedNote}`);
  } else {
    lines.push(`- settings: ${settings.status} — no recorded runtime:settings execution/attestation artifact (plan-only and probe-free runs record none by design)`);
  }
  const artifacts = report.tier2.artifacts;
  lines.push(`- artifacts: ${artifacts.status} (${artifacts.total.run_count} runs, ${artifacts.total.bytes} bytes)`);
  for (const item of artifacts.attention) {
    lines.push(`    ! ${item.family}: ${item.kind} observed=${item.observed} limit=${item.limit}`);
  }
  const notify = report.tier2.notify;
  if (notify.config.status === 'invalid') {
    lines.push(`- notify: INVALID config — ${notify.config.errors.join('; ')}`);
  } else {
    // ADR-0041 §6 — fold the active egress-throttle count into the state line
    // (informational; a cooldown is expected during a provider hiccup).
    const activeThrottles = notify.state.egress?.active_throttles ?? 0;
    const egressSummary = activeThrottles > 0
      ? `; egress: ${activeThrottles} throttled${notify.state.egress?.next_retry_at ? ` (next retry ${notify.state.egress.next_retry_at})` : ''}`
      : '';
    lines.push(`- notify: channel=${notify.config.channel}${notify.config.status === 'off' ? ' (off)' : ''}; state=${notify.state.status}${egressSummary}`);
  }
  for (const issue of notify.state.issues) {
    lines.push(`    ! ${issue}`);
  }
  if (notify.recent.status === 'available') {
    lines.push(`- recent notifications (${notify.recent.entries.length}${notify.recent.malformed > 0 ? `, ${notify.recent.malformed} malformed` : ''}):`);
    for (const entry of notify.recent.entries) {
      // ADR-0041 §6 — attempt-mirror rows carry the egress overlay; render it
      // inline so dispatched/suppressed/failed egress attempts are visible.
      const egress = entry.egress_status
        ? ` egress:${entry.egress_channel ?? '?'}=${entry.egress_status}${entry.egress_outcome && entry.egress_outcome !== entry.egress_status ? `(${entry.egress_outcome})` : ''}`
        : '';
      lines.push(`    · ${entry.ts ?? '?'} [${entry.kind ?? '?'}${entry.urgency === 'urgent' ? '/urgent' : ''}] ${entry.title ?? ''}${egress}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseDashboardArgs(argv) {
  const opts = {
    repoRoot: null,
    format: 'text',
    watch: false,
    intervalSeconds: DEFAULT_WATCH_INTERVAL_SECONDS,
    watchCount: null,
    recent: DEFAULT_RECENT_NOTIFICATIONS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const needsValue = ['--repo-root', '--format', '--interval-seconds', '--watch-count', '--recent'].includes(arg);
    if (needsValue) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, reason: `${arg} requires a value` };
      }
      i += 1;
      if (arg === '--repo-root') opts.repoRoot = value;
      else if (arg === '--format') {
        if (value !== 'text' && value !== 'json') return { ok: false, reason: '--format must be text or json' };
        opts.format = value;
      } else if (arg === '--interval-seconds') {
        // Whole-string numeric validation (Codex review MINOR): parseFloat
        // would silently accept trailing garbage like "1foo".
        if (!/^[0-9]+(\.[0-9]+)?$/.test(value) || Number.parseFloat(value) <= 0) {
          return { ok: false, reason: '--interval-seconds must be a positive number' };
        }
        // ADR-0040 §6 bounded poll: default 2s, floor 1s (clamped, not rejected).
        opts.intervalSeconds = Math.max(MIN_WATCH_INTERVAL_SECONDS, Number.parseFloat(value));
      } else if (arg === '--watch-count') {
        if (!/^[0-9]+$/.test(value) || Number.parseInt(value, 10) <= 0) {
          return { ok: false, reason: '--watch-count must be a positive integer' };
        }
        opts.watchCount = Number.parseInt(value, 10);
      } else if (arg === '--recent') {
        if (!/^[0-9]+$/.test(value) || Number.parseInt(value, 10) <= 0) {
          return { ok: false, reason: '--recent must be a positive integer' };
        }
        opts.recent = Number.parseInt(value, 10);
      }
    } else if (arg === '--watch') {
      opts.watch = true;
    } else {
      return { ok: false, reason: `unknown argument ${arg}` };
    }
  }
  return { ok: true, opts };
}

function sleep(ms, signalState) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    signalState.wake = () => {
      clearTimeout(timer);
      resolvePromise();
    };
  });
}

async function renderOnce(opts, repoRoot, { ndjson = false } = {}) {
  const report = await buildDashboardReport({ repoRoot, recentLimit: opts.recent });
  if (opts.format === 'json') {
    // Watch mode frames JSON as NDJSON — one report per line — so the
    // stream stays machine-parseable (Codex review MINOR); the one-shot
    // path keeps the pretty envelope other runtime CLIs emit.
    return ndjson ? `${JSON.stringify(report)}\n` : `${JSON.stringify(report, null, 2)}\n`;
  }
  return renderDashboardText(report);
}

async function main(argv) {
  const parsed = parseDashboardArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`dashboard: ${parsed.reason}\n`);
    process.stderr.write('usage: dashboard.mjs [--repo-root <path>] [--format text|json] [--watch] [--interval-seconds <n>] [--watch-count <n>] [--recent <n>]\n');
    process.exitCode = 1;
    return;
  }
  const opts = parsed.opts;
  const repoRoot = resolveRepoRoot({ explicit: opts.repoRoot });
  if (!repoRoot) {
    process.stderr.write('dashboard: no repository root (.git) found — pass --repo-root\n');
    process.exitCode = 1;
    return;
  }

  if (!opts.watch) {
    process.stdout.write(await renderOnce(opts, repoRoot));
    return;
  }

  // --watch: filesystem-only re-render loop with an explicit exit —
  // SIGINT/SIGTERM stops it, and --watch-count bounds it deterministically
  // (the test harness path). Never re-probes host CLIs; every iteration is
  // the same R0 filesystem read the one-shot path performs.
  const signalState = { stopped: false, wake: null };
  const stop = () => {
    signalState.stopped = true;
    if (signalState.wake) signalState.wake();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  let iterations = 0;
  for (;;) {
    const output = await renderOnce(opts, repoRoot, { ndjson: true });
    if (opts.format === 'text' && process.stdout.isTTY) {
      process.stdout.write(`\u001b[2J\u001b[H${output}`);
    } else {
      process.stdout.write(iterations > 0 && opts.format === 'text' ? `---\n${output}` : output);
    }
    iterations += 1;
    if (signalState.stopped) break;
    if (opts.watchCount !== null && iterations >= opts.watchCount) break;
    await sleep(opts.intervalSeconds * 1000, signalState);
    if (signalState.stopped) break;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    try {
      await main(process.argv.slice(2));
    } catch (error) {
      process.stderr.write(`dashboard: ${error?.message ?? 'unknown failure'}\n`);
      process.exitCode = 1;
    }
  })();
}
