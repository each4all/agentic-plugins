// ADR-0047 §7 citation-aware retention planner — the READ-ONLY half (M1 split).
//
// This module computes, per runtime-owned artifact family, which runs under
// `.agentic-plugins/runs/<family>/` are safe to delete versus pinned — and it
// DELETES NOTHING. It is the planner the separate `retention-apply` executor
// (a later slice) recomputes-and-binds against a reviewed plan hash before it
// removes anything, and the projection doctor/dashboard adopt so "over cap
// because cited" stops reading as a fault.
//
// Load-bearing contract (ADR-0047 §7):
//   - CLOSED family registry: v1 is exactly doctor / compat / settings —
//     runtime-owned, latest.json-bearing. Widening it is a follow-up decision,
//     never a config knob. Only VALIDATED run-id directories are candidates;
//     malformed names, temp files, and lock dirs are non-candidates.
//   - FAIL-CLOSED pin scanning: every pin source degrades the same way. If any
//     source cannot be fully evaluated (enumeration failure, cap exhaustion,
//     an unreadable/malformed citation or artifact source), the plan records
//     scan_complete:false with the reason, and an unscannable source is treated
//     as potentially citing everything — apply refuses to run against such a
//     plan.
//   - Caps are TOTAL runs/bytes per family, pins included. When pins alone
//     exceed a cap, everything over is `pinned_overage` (informational) and
//     nothing is actionable.
//   - Deletion candidates are oldest-first by run-id timestamp AND must clear a
//     minimum-age guard — a recently-written run is never a candidate (the first
//     half of the writer-coordination story completed by retention-apply's
//     in-lock last-instant re-check).
//
// Purity: the planner reads the filesystem (like state-readers.mjs) but injects
// `now`, the caps, and the git-tracked-file provider, so every branch is
// deterministically testable. It never writes, never spawns a deleter, and
// never mutates host or runtime state.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── Versions (part of the plan hash — a change here invalidates every prior
// reviewed plan, which is the point) ──
export const RETENTION_PLANNER_VERSION = 'runtime-retention-planner-1.0';
export const RETENTION_SCANNER_VERSION = 'runtime-retention-scanner-1.0';

// ── Bounds — implementation constants pinned by test (ADR-0047 §7). The
// citation scan rides no hot path but still bounds itself so a pathological
// working tree cannot make planning unbounded; hitting a bound is fail-closed
// (scan_complete:false), never silent narrowing. ──
export const CITATION_SCAN_MAX_FILES = 5000;
export const CITATION_SCAN_MAX_FILE_BYTES = 1024 * 1024; // 1 MiB per tracked file
export const CITATION_SCAN_MAX_TOTAL_BYTES = 64 * 1024 * 1024; // 64 MiB across the scan
export const CROSS_ARTIFACT_MAX_FILES = 4000;
export const CROSS_ARTIFACT_MAX_FILE_BYTES = 1024 * 1024; // 1 MiB per artifact file

// Minimum-age guard: a run whose newest mtime is younger than this is NEVER a
// deletion candidate regardless of cap pressure. Closes the window against the
// family's own writers (doctor/compat/settings creating or resuming a run) that
// do not take the retention lock; retention-apply adds the in-lock last-instant
// re-check on top.
export const RETENTION_MIN_AGE_MS = 15 * 60 * 1000; // 15 minutes

// The registry families. run-id shape is `<family>-YYYYMMDDTHHMMSSZ-<6hex>`
// (identical discipline to state-readers.mjs / the family scripts). `latestFile`
// is the family's latest.json pointer; `livePins` names the per-family reader-
// selected pin sources (pin 3). compat has no v1 live pin beyond latest.
export const RETENTION_FAMILY_REGISTRY = Object.freeze({
  doctor: Object.freeze({
    family: 'doctor',
    runIdRe: /^doctor-\d{8}T\d{6}Z-[0-9a-f]{6}$/,
    livePins: ['reusable-proof'],
  }),
  compat: Object.freeze({
    family: 'compat',
    runIdRe: /^compat-\d{8}T\d{6}Z-[0-9a-f]{6}$/,
    livePins: [],
  }),
  settings: Object.freeze({
    family: 'settings',
    runIdRe: /^settings-\d{8}T\d{6}Z-[0-9a-f]{6}$/,
    livePins: ['non-terminal-execution', 'attestation'],
  }),
});

export const RETENTION_FAMILIES = Object.freeze(Object.keys(RETENTION_FAMILY_REGISTRY));

// A run-id token of ANY registry family. Both citation shapes the ADR names —
// bare/backticked run-id tokens AND `.agentic-plugins/runs/<family>/<run-id>`
// path strings — CONTAIN this token, so one token scan catches both (a path
// string is the token with a directory prefix). Global + case-sensitive:
// run-ids are lowercase-hex by construction.
const RUN_ID_TOKEN_RE = /\b(?:doctor|compat|settings)-\d{8}T\d{6}Z-[0-9a-f]{6}\b/g;

// Families whose recorded artifacts are scanned for cross-artifact references
// (pin 4). doctor.json report snapshots embed other families' evidence ids;
// cutover evidence artifacts carry operator-supplied artifact-pointer lists.
// The in-memory cutover checklist is not persisted and is not scanned.
const CROSS_ARTIFACT_SOURCES = Object.freeze([
  Object.freeze({ family: 'doctor', runIdRe: RETENTION_FAMILY_REGISTRY.doctor.runIdRe, artifactFile: 'doctor.json' }),
  Object.freeze({ family: 'cutover', runIdRe: /^cutover-\d{8}T\d{6}Z-[0-9a-f]{6}$/, artifactFile: null }),
]);

const SETTINGS_NONTERMINAL_STATUSES = new Set(['planned', 'in-progress']);

function runsRoot(repoRoot) {
  return path.join(repoRoot, '.agentic-plugins', 'runs');
}

function familyRoot(repoRoot, family) {
  return path.join(runsRoot(repoRoot), family);
}

// Extract the sortable timestamp from a run-id. Deterministic and total:
// a malformed id (never a candidate anyway) yields 0 so ordering stays defined.
export function runIdTimestamp(runId) {
  const m = /^[a-z]+-(\d{8})T(\d{6})Z-[0-9a-f]{6}$/.exec(runId ?? '');
  if (!m) return 0;
  const [, d, t] = m;
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

// Decode a Buffer as UTF-8 text, refusing binary/undecodable content. A NUL
// byte or an invalid UTF-8 sequence marks a non-text file: it is recorded and
// skipped (not a citation doc), which — deliberately — does NOT flip
// scan_complete. Treating every image/binary as "might cite everything" would
// make scan_complete unachievable in any real repo and defeat the pin scanner;
// the fail-closed triggers are enumeration failure, cap exhaustion, and
// UNREADABLE (fs-error) or oversized text sources, not "is binary".
function decodeText(buffer) {
  if (buffer.includes(0)) return null; // NUL byte ⇒ binary
  const text = buffer.toString('utf8');
  // A U+FFFD replacement char only appears from invalid UTF-8 when the source
  // did not itself contain one; treat any as undecodable (conservative but
  // still text-oriented — a real doc citing a run-id is clean UTF-8).
  if (text.includes('�')) return null;
  return text;
}

// Default git-tracked-file provider: `git ls-files -z` from the repo root.
// Injectable so tests are deterministic and hermetic. Returns null on any
// failure (not-a-repo, git missing) — the caller treats a null list as an
// enumeration failure (scan_complete:false).
async function defaultGitTrackedFiles(repoRoot) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'ls-files', '-z'], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.split('\0').filter((name) => name.length > 0);
  } catch {
    return null;
  }
}

// ── Pin 1: tracked-doc citations ──
//
// Scan git-tracked text files for run-id tokens of the registry families. Any
// match pins that run-id. Bounded: file-count and total-byte caps, per-file
// byte cap, tracked-files-only. Fail-closed on enumeration failure, cap
// exhaustion, an unreadable file, or an oversized text file (its citations past
// the cap would be missed).
export async function scanTrackedDocCitations({ repoRoot, gitTrackedFiles = null }) {
  const pinned = new Map(RETENTION_FAMILIES.map((f) => [f, new Set()]));
  const incomplete = [];
  let files = gitTrackedFiles;
  if (files === null) {
    files = await defaultGitTrackedFiles(repoRoot);
  }
  if (!Array.isArray(files)) {
    incomplete.push({ source: 'tracked-doc-citations', reason: 'git-tracked-file enumeration failed' });
    return { pinned, scanComplete: false, incomplete, files_scanned: 0, files_skipped_binary: 0 };
  }
  if (files.length > CITATION_SCAN_MAX_FILES) {
    incomplete.push({
      source: 'tracked-doc-citations',
      reason: `tracked file count ${files.length} exceeds scan cap ${CITATION_SCAN_MAX_FILES}`,
    });
    // Still scan the prefix (best-effort pinning) but the plan is already
    // fail-closed — apply refuses, so partial pins only ever over-protect.
    files = files.slice(0, CITATION_SCAN_MAX_FILES);
  }

  let totalBytes = 0;
  let scanned = 0;
  let skippedBinary = 0;
  for (const rel of files) {
    if (totalBytes >= CITATION_SCAN_MAX_TOTAL_BYTES) {
      incomplete.push({
        source: 'tracked-doc-citations',
        reason: `total scan bytes reached cap ${CITATION_SCAN_MAX_TOTAL_BYTES} before all files were read`,
      });
      break;
    }
    const abs = path.join(repoRoot, rel);
    let stat;
    try {
      stat = await fsp.lstat(abs);
    } catch (err) {
      if (String(err?.code ?? '') === 'ENOENT') continue; // tracked-but-deleted: not a source
      incomplete.push({ source: 'tracked-doc-citations', reason: `unreadable tracked file (${err?.code ?? 'error'})` });
      continue;
    }
    if (!stat.isFile()) continue; // symlink/dir — not a citation source
    if (stat.size > CITATION_SCAN_MAX_FILE_BYTES) {
      incomplete.push({
        source: 'tracked-doc-citations',
        reason: `tracked file exceeds per-file cap ${CITATION_SCAN_MAX_FILE_BYTES} bytes`,
      });
      continue; // cannot fully scan ⇒ fail-closed, skip
    }
    let buffer;
    try {
      buffer = await fsp.readFile(abs);
    } catch (err) {
      incomplete.push({ source: 'tracked-doc-citations', reason: `unreadable tracked file (${err?.code ?? 'error'})` });
      continue;
    }
    totalBytes += buffer.length;
    const text = decodeText(buffer);
    if (text === null) {
      skippedBinary += 1;
      continue; // binary/undecodable — recorded, not a citation source, no flip
    }
    scanned += 1;
    harvestRunIdTokens(text, pinned);
  }

  return {
    pinned,
    scanComplete: incomplete.length === 0,
    incomplete,
    files_scanned: scanned,
    files_skipped_binary: skippedBinary,
  };
}

function harvestRunIdTokens(text, pinned) {
  RUN_ID_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = RUN_ID_TOKEN_RE.exec(text)) !== null) {
    const token = match[0];
    const dash = token.indexOf('-');
    const family = token.slice(0, dash);
    const bucket = pinned.get(family);
    if (bucket) bucket.add(token);
  }
}

// ── Pin 2: latest pointers ──
//
// Read each family's latest.json and pin its run_id. An ABSENT latest.json is
// not an error (a fresh family has no latest) — no pin, scan_complete stays
// true. A PRESENT-but-unreadable/malformed latest.json is fail-closed.
export async function resolveLatestPins({ repoRoot }) {
  const pinned = new Map(RETENTION_FAMILIES.map((f) => [f, new Set()]));
  const incomplete = [];
  for (const family of RETENTION_FAMILIES) {
    const latestPath = path.join(familyRoot(repoRoot, family), 'latest.json');
    let raw;
    try {
      raw = await fsp.readFile(latestPath, 'utf8');
    } catch (err) {
      if (String(err?.code ?? '') === 'ENOENT') continue; // absent ⇒ no latest pin
      incomplete.push({ source: 'latest-pointer', family, reason: `latest.json unreadable (${err?.code ?? 'error'})` });
      continue;
    }
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      incomplete.push({ source: 'latest-pointer', family, reason: 'latest.json malformed (invalid JSON)' });
      continue;
    }
    const runId = json?.run_id;
    if (typeof runId === 'string' && RETENTION_FAMILY_REGISTRY[family].runIdRe.test(runId)) {
      pinned.get(family).add(runId);
    } else {
      // A latest.json referencing a run-id that does not validate is a
      // corrupt pointer — fail-closed (it "references" something we cannot pin).
      incomplete.push({ source: 'latest-pointer', family, reason: 'latest.json run_id missing or malformed' });
    }
  }
  return { pinned, scanComplete: incomplete.length === 0, incomplete };
}

// ── Pin 3: live / reader-selected runs ──
//
// Per-family reader selections that must survive:
//   - settings: non-terminal execution artifacts (interrupted runs a reader
//     still shows as in-flight) AND the run carrying the resolved attestation.
//   - doctor: the reusable doctor-proof selection. Its reader falls back to the
//     LATEST run when no older run is reusable; evaluating "reusable" requires
//     live host state the planner deliberately does not gather, so v1 pins the
//     latest doctor run (already covered by pin 2) as the reader's deterministic
//     floor. The residual — an older reusable run deleted while a newer latest
//     survives — is bounded: the reader falls back to the (pinned) latest and
//     recomputes proof rather than dangling. Documented, not vacuous overall
//     (settings carries the genuinely-additional live pins).
//   - compat: no v1 live pin beyond latest.
export async function resolveLivePins({ repoRoot }) {
  const pinned = new Map(RETENTION_FAMILIES.map((f) => [f, new Set()]));
  const incomplete = [];

  // settings live pins
  const settingsFamily = RETENTION_FAMILY_REGISTRY.settings;
  const settingsRoot = familyRoot(repoRoot, 'settings');
  let settingsEntries = null;
  try {
    settingsEntries = await fsp.readdir(settingsRoot, { withFileTypes: true });
  } catch (err) {
    if (String(err?.code ?? '') !== 'ENOENT') {
      incomplete.push({ source: 'live-settings', family: 'settings', reason: `settings runs unreadable (${err?.code ?? 'error'})` });
    }
  }
  if (Array.isArray(settingsEntries)) {
    for (const entry of settingsEntries) {
      if (!entry.isDirectory() || !settingsFamily.runIdRe.test(entry.name)) continue;
      const artifactPath = path.join(settingsRoot, entry.name, 'settings.json');
      let json;
      try {
        json = JSON.parse(await fsp.readFile(artifactPath, 'utf8'));
      } catch (err) {
        if (String(err?.code ?? '') === 'ENOENT') continue; // no execution artifact ⇒ nothing to pin here
        incomplete.push({ source: 'live-settings', family: 'settings', reason: `settings artifact unreadable/malformed (${err?.code ?? 'error'})` });
        continue;
      }
      const status = typeof json?.status === 'string' ? json.status : null;
      const terminal = typeof json?.terminal === 'boolean'
        ? json.terminal
        : status !== null
          ? !SETTINGS_NONTERMINAL_STATUSES.has(status)
          : true;
      if (!terminal) pinned.get('settings').add(entry.name);
      const review = json?.codex_hook_review;
      if (review && review.attested === true && review.status === 'attested') {
        pinned.get('settings').add(entry.name);
      }
    }
  }

  // doctor live pin — the reader's latest-fallback floor (see block comment).
  const doctorLatestPath = path.join(familyRoot(repoRoot, 'doctor'), 'latest.json');
  try {
    const json = JSON.parse(await fsp.readFile(doctorLatestPath, 'utf8'));
    const runId = json?.run_id;
    if (typeof runId === 'string' && RETENTION_FAMILY_REGISTRY.doctor.runIdRe.test(runId)) {
      pinned.get('doctor').add(runId);
    }
    // A malformed doctor latest is already fail-closed by resolveLatestPins;
    // do not double-count the reason here.
  } catch (err) {
    if (String(err?.code ?? '') !== 'ENOENT') {
      incomplete.push({ source: 'live-doctor', family: 'doctor', reason: `doctor latest unreadable (${err?.code ?? 'error'})` });
    }
  }

  return { pinned, scanComplete: incomplete.length === 0, incomplete };
}

// ── Pin 4: cross-artifact references ──
//
// Run ids embedded in OTHER runtime artifacts that outlive them: doctor.json
// report snapshots (which embed other families' evidence ids) and cutover
// evidence artifacts (operator-supplied artifact-pointer lists). Scanned as
// data — read each source artifact (bounded), harvest registry run-id tokens,
// pin the matches. Fail-closed on an unreadable/malformed source artifact or
// cap exhaustion.
export async function scanCrossArtifactReferences({ repoRoot }) {
  const pinned = new Map(RETENTION_FAMILIES.map((f) => [f, new Set()]));
  const incomplete = [];
  let filesRead = 0;

  for (const source of CROSS_ARTIFACT_SOURCES) {
    const root = familyRoot(repoRoot, source.family);
    let entries = null;
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch (err) {
      if (String(err?.code ?? '') !== 'ENOENT') {
        incomplete.push({ source: 'cross-artifact', family: source.family, reason: `source runs unreadable (${err?.code ?? 'error'})` });
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !source.runIdRe.test(entry.name)) continue;
      const runDir = path.join(root, entry.name);
      const artifactFiles = source.artifactFile
        ? [path.join(runDir, source.artifactFile)]
        : await listRunArtifactFiles(runDir, incomplete, source.family);
      for (const artifactPath of artifactFiles) {
        if (filesRead >= CROSS_ARTIFACT_MAX_FILES) {
          incomplete.push({ source: 'cross-artifact', family: source.family, reason: `cross-artifact file count reached cap ${CROSS_ARTIFACT_MAX_FILES}` });
          return { pinned, scanComplete: false, incomplete, files_read: filesRead };
        }
        let stat;
        try {
          stat = await fsp.lstat(artifactPath);
        } catch (err) {
          if (String(err?.code ?? '') === 'ENOENT') continue;
          incomplete.push({ source: 'cross-artifact', family: source.family, reason: `artifact unreadable (${err?.code ?? 'error'})` });
          continue;
        }
        if (!stat.isFile()) continue;
        if (stat.size > CROSS_ARTIFACT_MAX_FILE_BYTES) {
          incomplete.push({ source: 'cross-artifact', family: source.family, reason: `artifact exceeds per-file cap ${CROSS_ARTIFACT_MAX_FILE_BYTES} bytes` });
          continue;
        }
        let buffer;
        try {
          buffer = await fsp.readFile(artifactPath);
        } catch (err) {
          incomplete.push({ source: 'cross-artifact', family: source.family, reason: `artifact unreadable (${err?.code ?? 'error'})` });
          continue;
        }
        filesRead += 1;
        const text = decodeText(buffer);
        if (text === null) {
          // A binary artifact where JSON was expected is a corrupt source —
          // fail-closed (it could reference anything).
          incomplete.push({ source: 'cross-artifact', family: source.family, reason: 'artifact undecodable (expected JSON text)' });
          continue;
        }
        harvestRunIdTokens(text, pinned);
      }
    }
  }

  return { pinned, scanComplete: incomplete.length === 0, incomplete, files_read: filesRead };
}

async function listRunArtifactFiles(runDir, incomplete, family) {
  let names;
  try {
    names = await fsp.readdir(runDir);
  } catch (err) {
    incomplete.push({ source: 'cross-artifact', family, reason: `run dir unreadable (${err?.code ?? 'error'})` });
    return [];
  }
  return names.filter((n) => n.endsWith('.json')).map((n) => path.join(runDir, n));
}

// ── Family inventory (validated run-ids only) ──

async function inventoryFamily({ repoRoot, family, now }) {
  const root = familyRoot(repoRoot, family);
  const registry = RETENTION_FAMILY_REGISTRY[family];
  const runs = [];
  let unreadable = 0;
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (err) {
    const missing = String(err?.code ?? '') === 'ENOENT';
    return { family, root, runs, unreadable: missing ? 0 : 1, missing };
  }
  for (const entry of entries) {
    // Only VALIDATED run-id directories are candidates — malformed names, temp
    // files, latest.json, and lock dirs are non-candidates (never counted, never
    // deletable).
    if (!entry.isDirectory() || !registry.runIdRe.test(entry.name)) continue;
    const runDir = path.join(root, entry.name);
    const usage = { bytes: 0, newestMtimeMs: 0 };
    try {
      await walkRunDir(runDir, usage);
    } catch {
      unreadable += 1;
    }
    runs.push({
      run_id: entry.name,
      ts_ms: runIdTimestamp(entry.name),
      bytes: usage.bytes,
      newest_mtime_ms: usage.newestMtimeMs,
      age_ms: Math.max(0, now.getTime() - usage.newestMtimeMs),
    });
  }
  runs.sort((a, b) => a.ts_ms - b.ts_ms || (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0));
  return { family, root, runs, unreadable, missing: false };
}

async function walkRunDir(dir, usage) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    const info = await fsp.lstat(p);
    if (info.isSymbolicLink()) {
      usage.bytes += Number.isFinite(info.size) ? info.size : 0;
      if (Number.isFinite(info.mtimeMs)) usage.newestMtimeMs = Math.max(usage.newestMtimeMs, info.mtimeMs);
      continue;
    }
    if (info.isDirectory()) {
      await walkRunDir(p, usage);
      continue;
    }
    usage.bytes += Number.isFinite(info.size) ? info.size : 0;
    if (Number.isFinite(info.mtimeMs)) usage.newestMtimeMs = Math.max(usage.newestMtimeMs, info.mtimeMs);
  }
}

// ── The planner ──

export async function planRetention({
  repoRoot,
  now = new Date(),
  caps = {},
  gitTrackedFiles = null,
  minAgeMs = RETENTION_MIN_AGE_MS,
} = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new TypeError('repoRoot must be a non-empty string');
  }
  const runCap = Number.isFinite(caps.runCap) && caps.runCap >= 0 ? Math.trunc(caps.runCap) : 20;
  const maxBytes = Number.isFinite(caps.maxBytes) && caps.maxBytes >= 0 ? Math.trunc(caps.maxBytes) : 50 * 1024 * 1024;

  // Run every pin source. Each returns its own scanComplete + incomplete
  // reasons; the plan's scan_complete is the AND of all of them.
  const [citations, latest, live, cross] = await Promise.all([
    scanTrackedDocCitations({ repoRoot, gitTrackedFiles }),
    resolveLatestPins({ repoRoot }),
    resolveLivePins({ repoRoot }),
    scanCrossArtifactReferences({ repoRoot }),
  ]);

  const scanIncomplete = [
    ...citations.incomplete,
    ...latest.incomplete,
    ...live.incomplete,
    ...cross.incomplete,
  ];
  const scanComplete = scanIncomplete.length === 0;

  // Merge per-family pins with their reasons.
  const pinReasonSources = [
    { key: 'tracked-doc-citation', pinned: citations.pinned },
    { key: 'latest-pointer', pinned: latest.pinned },
    { key: 'live-reader-selected', pinned: live.pinned },
    { key: 'cross-artifact-reference', pinned: cross.pinned },
  ];

  const families = {};
  for (const family of RETENTION_FAMILIES) {
    const inv = await inventoryFamily({ repoRoot, family, now });
    // Pins are recorded ONLY for run-ids that actually exist in this family's
    // inventory. A citation to an already-deleted run protects nothing and would
    // otherwise inflate pinned_count past run_count and churn the plan hash on
    // doc edits unrelated to any live run — the hash must reflect the DECISION
    // over the runs that exist, not every historical mention.
    const inventoryIds = new Set(inv.runs.map((r) => r.run_id));
    const pins = {}; // run_id -> [reason,...]
    for (const { key, pinned } of pinReasonSources) {
      for (const runId of pinned.get(family)) {
        if (!inventoryIds.has(runId)) continue;
        if (!pins[runId]) pins[runId] = [];
        if (!pins[runId].includes(key)) pins[runId].push(key);
      }
    }
    families[family] = classifyFamily({
      inv, pins, runCap, maxBytes, minAgeMs, scanComplete, now,
    });
  }

  const plan = {
    planner_version: RETENTION_PLANNER_VERSION,
    scanner_version: RETENTION_SCANNER_VERSION,
    generated_at: now.toISOString(),
    caps: { run_cap: runCap, max_bytes: maxBytes, min_age_ms: minAgeMs },
    scan_complete: scanComplete,
    scan_incomplete_reasons: scanIncomplete,
    scan_stats: {
      tracked_files_scanned: citations.files_scanned,
      tracked_files_skipped_binary: citations.files_skipped_binary,
      cross_artifact_files_read: cross.files_read,
    },
    families,
  };
  plan.plan_hash = computeRetentionPlanHash(plan);
  return plan;
}

// Split one family's runs into pinned / actionable-excess / pinned-overage.
// Caps count TOTAL runs (pins included). Actionable candidates are the unpinned
// runs beyond the cap that additionally clear the minimum-age guard, ordered
// oldest-first. When pins alone exceed a cap, everything over is pinned_overage
// (informational) and nothing is actionable.
function classifyFamily({ inv, pins, runCap, maxBytes, minAgeMs, scanComplete, now }) {
  const runs = inv.runs;
  const pinnedRunIds = new Set(Object.keys(pins));
  const overCapByCount = runs.length > runCap;
  const totalBytes = runs.reduce((acc, r) => acc + r.bytes, 0);
  const overCapByBytes = totalBytes > maxBytes;
  const overCap = overCapByCount || overCapByBytes;

  // Unpinned runs, oldest-first, are the deletion-candidate pool.
  const unpinnedOldestFirst = runs.filter((r) => !pinnedRunIds.has(r.run_id));

  // How many runs must go to bring the family within the count cap. Pins count
  // toward the total, so a family that is over cap purely because of pins yields
  // zero actionable removals.
  const excessCount = Math.max(0, runs.length - runCap);

  const actionable = [];
  const tooYoung = [];
  const pinnedOverage = [];
  if (overCap) {
    // Byte-driven pressure: keep deleting oldest unpinned age-cleared runs until
    // both the count excess is covered and bytes are back under the cap.
    let remainingBytes = totalBytes;
    let removedForCount = 0;
    for (const run of unpinnedOldestFirst) {
      const needCount = removedForCount < excessCount;
      const needBytes = remainingBytes > maxBytes;
      if (!needCount && !needBytes) break;
      if (run.age_ms < minAgeMs) {
        tooYoung.push(run.run_id);
        // A too-young run blocks nothing older behind it from being counted —
        // continue scanning older-to-newer; younger runs are simply skipped.
        continue;
      }
      actionable.push(run.run_id);
      removedForCount += 1;
      remainingBytes -= run.bytes;
    }
    // Pinned runs contributing to overage are informational only.
    for (const run of runs) {
      if (pinnedRunIds.has(run.run_id)) pinnedOverage.push(run.run_id);
    }
  }

  const deletableBytes = actionable.reduce((acc, id) => {
    const run = runs.find((r) => r.run_id === id);
    return acc + (run ? run.bytes : 0);
  }, 0);

  return {
    family: inv.family,
    missing: inv.missing,
    unreadable: inv.unreadable,
    run_count: runs.length,
    total_bytes: totalBytes,
    over_cap: overCap,
    over_cap_by_count: overCapByCount,
    over_cap_by_bytes: overCapByBytes,
    runs: runs.map((r) => ({ run_id: r.run_id, ts_ms: r.ts_ms, bytes: r.bytes, age_ms: r.age_ms })),
    pins,
    pinned_count: pinnedRunIds.size,
    // actionable is empty whenever the plan is not scan_complete: an unscannable
    // source is treated as citing everything, so nothing is safe to delete.
    actionable_excess: scanComplete ? actionable : [],
    actionable_withheld_scan_incomplete: !scanComplete && actionable.length > 0 ? actionable : [],
    withheld_too_young: tooYoung,
    pinned_overage: pinnedOverage,
    deletable_bytes: scanComplete ? deletableBytes : 0,
  };
}

// Canonical plan hash: covers registry+scanner versions, effective caps, the
// per-family pin set (run-id → sorted reasons), and the ordered deletion list.
// Stable across runs with identical inputs; any change to a pin, a cap, a
// version, or the deletion order changes the hash — the binding retention-apply
// recomputes against. Excludes volatile fields (generated_at, byte totals,
// ages) so the hash reflects the DECISION, not the wall clock.
export function computeRetentionPlanHash(plan) {
  const canonical = {
    planner_version: plan.planner_version,
    scanner_version: plan.scanner_version,
    caps: { run_cap: plan.caps.run_cap, max_bytes: plan.caps.max_bytes, min_age_ms: plan.caps.min_age_ms },
    scan_complete: plan.scan_complete,
    families: {},
  };
  for (const family of RETENTION_FAMILIES) {
    const f = plan.families[family];
    if (!f) continue;
    const pins = {};
    for (const [runId, reasons] of Object.entries(f.pins)) {
      pins[runId] = [...reasons].sort();
    }
    canonical.families[family] = {
      pins,
      actionable_excess: [...f.actionable_excess],
    };
  }
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

// ── Doctor/dashboard projection ──
//
// The actionable/pinned split doctor and dashboard adopt so "over cap because
// cited" stops reading as a fault. Per registry family: how many runs are
// actionable (deletable), how many are pinned overage (over cap but cited /
// live / latest — informational, never a warning that asks the operator to act
// against a pin), and whether the pin scan was complete.
export function projectRetentionAttention(plan) {
  const families = {};
  for (const family of RETENTION_FAMILIES) {
    const f = plan.families[family];
    if (!f) continue;
    families[family] = {
      family,
      over_cap: f.over_cap,
      run_count: f.run_count,
      pinned_count: f.pinned_count,
      actionable: f.actionable_excess.length,
      pinned_overage: f.pinned_overage.length,
      scan_complete: plan.scan_complete,
    };
  }
  return {
    scan_complete: plan.scan_complete,
    plan_hash: plan.plan_hash,
    families,
  };
}

// The doctor/dashboard adoption of the actionable/pinned split. Given the raw
// artifact-inventory `attention` array (which flags a registry family's over-cap
// as a fault by run count/bytes alone, blind to pins) and the retention
// projection, reconcile the two: a registry family whose over-cap is EXPLAINED
// entirely by pins — over_cap, zero actionable, and the pin scan complete — is
// DEMOTED from a fault to an informational `pinned_overage` note ("over cap
// because cited stops reading as a fault"). Non-registry families and genuine
// actionable/scan-incomplete overage keep their fault attention untouched.
// Pure and total: shared by doctor and dashboard so the split is defined once.
export function reconcileRetentionAttention(inventoryAttention, projection) {
  const attention = [];
  const demoted = [];
  const overageKinds = new Set(['run_count_exceeds_cap', 'bytes_exceed_cap']);
  const scanComplete = projection?.scan_complete === true;
  for (const item of Array.isArray(inventoryAttention) ? inventoryAttention : []) {
    const projFamily = projection?.families?.[item?.family];
    const pinnedOnly = scanComplete
      && projFamily
      && projFamily.over_cap === true
      && projFamily.actionable === 0
      && overageKinds.has(item?.kind);
    if (pinnedOnly) {
      demoted.push({
        family: item.family,
        kind: 'pinned_overage',
        observed: item.observed,
        limit: item.limit,
        pinned_overage: projFamily.pinned_overage,
        note: 'over cap only because runs are pinned (cited / live / latest); not a fault — informational',
      });
    } else {
      attention.push(item);
    }
  }
  // Genuine registry faults the raw inventory cannot see: an incomplete pin scan
  // means an unscannable source could cite anything, so the operator should know
  // even when the family is within count/byte caps.
  if (projection && projection.scan_complete === false) {
    attention.push({
      family: 'retention',
      kind: 'pin_scan_incomplete',
      observed: 'scan_complete=false',
      limit: 'complete pin scan',
      recommendation: 'A pin source could not be fully evaluated; retention deletion is withheld until the scan completes. Inspect scan_incomplete_reasons.',
    });
  }
  return { attention, demoted };
}
