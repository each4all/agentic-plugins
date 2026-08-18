#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, loadSchema, validateAgainstSchema } from './lib/schema-validate.mjs';
import { FUTURE_SKEW_TOLERANCE_MS } from './lib/clock.mjs';
import { loadEntryBriefConfig, loadSessionConfig } from './lib/runtime-config.mjs';
import {
  NOTE_CONTENT_MAX_BYTES,
  SESSION_CAPTURE_FILE_FAMILIES,
  SESSION_CAPTURE_SEGMENTS,
  inspectSessionCaptureFileCore,
  sanitizeValidationReason,
  semanticCaptureViolation,
  sessionCaptureDir,
  truncateReason,
} from './lib/session-capture-inspect.mjs';

// Re-export for existing consumers — the value moved to the session-capture
// inspection leaf (ADR-0045 S7a) so entry-brief-readers can share the gate
// sequence without importing context.mjs back (cycle).
export { NOTE_CONTENT_MAX_BYTES };
import { resolveRepoRoot } from './notify.mjs';
import { buildSourceFreshness, formatSourceFreshness, observeCurrentBranch, observeSessionGitFacts, observeWorktreeDirtyCount, resolveGitTopLevel, resolveSourceSnapshot } from './source-snapshot.mjs';
import { collectEntrySources } from './lib/entry-brief-readers.mjs';
import { ENTRY_BRIEF_SCHEMA_ID, arbitrateEntryBrief, semanticEntryBriefViolation } from './lib/entry-brief-arbiter.mjs';
import { RUNTIME_VERSION } from './version.mjs';

const VERSION = RUNTIME_VERSION;
const ARTIFACT_SCHEMA = 'runtime-context-artifact-1.0';
const VALID_COMMANDS = new Set(['capture', 'status', 'check', 'note', 'publish-session', 'entry-brief']);
const RISK_LEVELS = new Set(['green', 'yellow', 'red']);
// ADR-0044 session-capture staging surface (S3a executors). The normative
// field tables, caps, and temp naming live in the packaged contract doc
// (docs/session-capture-contract.md §2-§4); slot.json/entry.json are produced
// by the S3b publisher — this slice ships only the explicit `note` staging
// write and the read-only `status --slot` inspection.
const NOTE_SCHEMA_ID = 'runtime-session-note-1.0';
export const NOTE_FOLD_WINDOW_MS = 24 * 60 * 60 * 1000; // contract §4 — reported here as a diagnostic; enforced by the publisher
// contract §4's uniform bound, now single-sourced in lib/clock.mjs so the three
// age computations ST5 measured cannot drift from the one that was already right.
const NOTE_HOSTS = new Set(['claude', 'codex']);
// ADR-0031 bounded workflow projection (session-level continue-vs-fresh
// preflight). The owning plugin (engineer/founder/designer L3 /
// orchestrator L2) computes these generic-semantic fields from its OWN
// state and passes them IN; runtime never shell-reads higher-layer state.
// ADR-0043 §1 widened the seam to all four personas (additive); any other
// kind still degrades honestly through the unsupported-kind path.
const VALID_WORKFLOW_KINDS = new Set(['engineer', 'orchestrator', 'founder', 'designer']);
const VALID_ARCHIVE_GATES = new Set(['ready_to_archive', 'blocked', 'not_terminal']);
// The bounded projection carries ONLY these fields (ADR-0031 §schema);
// `checkpoint` is the only optional one — every other field is required.
const PROJECTION_FIELDS = new Set([
  'workflow_kind', 'workflow_id', 'workflow_path', 'phase',
  'next_action', 'checkpoint', 'archive_gate', 'routing_recommendation',
]);
const PROJECTION_REQUIRED_STRINGS = ['workflow_id', 'workflow_path', 'phase', 'next_action', 'routing_recommendation'];
const RUN_ID_RE = /^context-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const ARTIFACT_KIND_RE = /^[A-Za-z0-9._-]+$/;
const REPORT_PREVIEW_LIMIT = 1200;
const CONTEXT_BUDGET_THRESHOLDS = {
  yellowAt: 0.7,
  redAt: 0.9,
};
const DEFAULT_HANDOFF_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export async function runContext(options = {}) {
  const command = options.command ?? 'capture';
  if (!VALID_COMMANDS.has(command)) {
    throw new Error(`Unsupported context command: ${command}`);
  }
  if (command === 'note') {
    // note resolves its own repo root (git-scoped walk-up): session-capture is
    // repo-scoped by contract §1, so a non-git invocation directory is an
    // honest error (operator) / silent no-op (hook-grade), never an implicit
    // cwd write root.
    return noteContext(options);
  }
  if (command === 'publish-session') {
    // publish-session resolves its own repo root through the contract §6
    // probe (`git rev-parse --show-toplevel`) — never the generic cwd
    // resolution below; a non-git start dir is a silent no-op.
    return publishSessionCapture(options);
  }
  if (command === 'entry-brief') {
    // entry-brief resolves its own repo root through the same §6 probe —
    // a non-git start dir is an honest skip (silent on the hook surface,
    // ADR-0045 §3).
    return entryBriefContext(options);
  }
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  if (command === 'capture') {
    return captureContext({ ...options, repoRoot });
  }
  if (command === 'status') {
    return options.slot === true ? readSlotStatus(options) : readStatus({ ...options, repoRoot });
  }
  return checkContext({ ...options, repoRoot });
}

export async function captureContext(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const now = options.now ?? new Date();
  const createdAt = toIso(now);
  const runId = options.runId ? validateRunId(options.runId) : makeRunId(now);
  const runDir = contextRunDir(repoRoot, runId);
  await assertInside(contextRoot(repoRoot), runDir);
  await mkdir(runDir, { recursive: true });

  const summary = await resolveSummary(options);
  const riskLevel = validateRiskLevel(options.risk ?? 'yellow');
  const riskReason = options.riskReason
    ? requireSingleLine(options.riskReason, '--risk-reason')
    : defaultRiskReason(options.risk);
  const artifactPointers = normalizeArtifacts(repoRoot, options.artifacts ?? []);
  const recommendedAction = options.nextAction
    ? requireSingleLine(options.nextAction, '--next-action')
    : defaultNextAction(riskLevel);
  const hostCommands = hostHandoffCommands(runId);

  const contextPointer = pointer(repoRoot, resolve(runDir, 'context.json'));
  const prompt = await resolveNextSessionPrompt({
    ...options,
    summary,
    riskLevel,
    recommendedAction,
    contextPointer,
    hostCommands,
  });
  const promptPath = resolve(runDir, 'next-session-prompt.md');
  await writeFile(promptPath, ensureTrailingNewline(prompt));

  const summaryPath = resolve(runDir, 'summary.md');
  await writeFile(summaryPath, ensureTrailingNewline(summary));
  const sourceSnapshot = await resolveSourceSnapshot({
    repoRoot,
    snapshot: options.sourceSnapshot,
    observedAt: createdAt,
  });

  const artifact = {
    schema_version: ARTIFACT_SCHEMA,
    runtime_version: VERSION,
    run_id: runId,
    status: 'captured',
    created_at: createdAt,
    updated_at: createdAt,
    repo_root_pointer: '.',
    context: {
      summary: summary.trim(),
      risk_level: riskLevel,
      risk_reason: riskReason,
    },
    artifacts: [
      { kind: 'context-summary', pointer: pointer(repoRoot, summaryPath) },
      ...artifactPointers,
    ],
    next_session: {
      recommended_action: recommendedAction,
      prompt_pointer: pointer(repoRoot, promptPath),
      commands: hostCommands,
    },
    source_snapshot: sourceSnapshot,
    limits: contextLimits(),
  };

  const contextPath = resolve(runDir, 'context.json');
  await writeJson(contextPath, artifact);

  return buildReport({ command: 'capture', repoRoot, artifact, contextPath, prompt });
}

export async function readStatus(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const latest = options.latest === true;
  if (options.runId && latest) {
    throw new Error('Use either --run-id or --latest, not both');
  }
  if (!options.runId && !latest) {
    throw new Error('status requires --run-id or --latest');
  }
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_HANDOFF_STALE_AFTER_MS;
  const lookup = latest
    ? await findLatestContextArtifact(repoRoot)
    : {
        runId: validateRunId(required(options.runId, '--run-id')),
        contextPath: contextFile(repoRoot, options.runId),
        skippedInvalid: 0,
      };
  const contextPath = lookup.contextPath;
  const artifact = await readJson(contextPath);
  const now = options.now ?? new Date();
  const currentSourceSnapshot = await resolveSourceSnapshot({
    repoRoot,
    snapshot: options.currentSourceSnapshot,
    observedAt: toIso(now),
  });
  // ADR-0031 — an optional workflow projection folds the session-level
  // continue-vs-fresh decision into the stored artifact's handoff guidance,
  // using the artifact's own risk_level as the budget input. Opt-in only: with
  // no --workflow-projection-file the status handoff is unchanged (rollback-safe).
  const projectionRequested = options.workflowProjectionFile != null;
  const { projection, error: projectionError, unsupportedKind, unsupportedRouting } = projectionRequested
    ? await loadWorkflowProjection(options)
    : { projection: null, error: null };
  const sessionHandoff = projectionRequested
    ? evaluateSessionHandoff({
        riskLevel: artifact.context?.risk_level ?? null,
        projection,
        // runtime-unsupported-kind: prefer the rejected projection's own routing
        // (persona ok-case wiring supplies routing only via the file) before any
        // standalone --routing-recommendation, so the fresh handoff keeps a
        // next_command.
        routing: unsupportedRouting ?? options.routingRecommendation ?? null,
        unsupportedKind: unsupportedKind ?? null,
      })
    : null;
  const handoff = buildHandoffLookup({
    artifact,
    runId: lookup.runId,
    latest,
    now,
    staleAfterMs,
    skippedInvalid: lookup.skippedInvalid,
    currentSourceSnapshot,
    sessionHandoff,
  });
  let prompt = null;
  if (artifact.next_session?.prompt_pointer) {
    prompt = await readFile(resolve(repoRoot, artifact.next_session.prompt_pointer), 'utf8');
  }
  const report = buildReport({ command: 'status', repoRoot, artifact, contextPath, prompt, handoff });
  if (projectionError) report.projection_error = projectionError;
  return report;
}

export async function checkContext(options = {}) {
  const budgetCheck = buildBudgetCheck(options);
  const riskReason = options.riskReason
    ? requireSingleLine(options.riskReason, '--risk-reason')
    : budgetCheck.riskReason;
  // ADR-0031 — check is the session-level continue-vs-fresh preflight surface.
  // The preflight is surfaced when a bounded projection is supplied OR the
  // (caller-supplied) budget risk is yellow/red (the contract's risk firing
  // rule). A green check with no projection stays exactly as before
  // (backward-compatible): no session_handoff, default next action.
  const projectionRequested = options.workflowProjectionFile != null;
  const { projection, error: projectionError, unsupportedKind, unsupportedRouting } = projectionRequested
    ? await loadWorkflowProjection(options)
    : { projection: null, error: null };
  const includeSession = projectionRequested || budgetCheck.riskLevel !== 'green';
  const sessionHandoff = includeSession
    ? evaluateSessionHandoff({
        riskLevel: budgetCheck.riskLevel,
        projection,
        // runtime-unsupported-kind: prefer the rejected projection's own routing
        // before any standalone --routing-recommendation (see statusContext).
        routing: unsupportedRouting ?? options.routingRecommendation ?? null,
        unsupportedKind: unsupportedKind ?? null,
      })
    : null;
  const report = {
    command: 'check',
    version: VERSION,
    status: 'checked',
    read_only: true,
    risk_level: budgetCheck.riskLevel,
    risk_reason: riskReason,
    context_budget: budgetCheck.contextBudget,
    artifacts: [],
    next_session: {
      recommended_action: defaultCheckNextAction(budgetCheck.riskLevel),
      prompt_pointer: null,
      prompt_preview: null,
    },
    limits: checkLimits(),
  };
  if (sessionHandoff) report.session_handoff = sessionHandoff;
  if (projectionError) report.projection_error = projectionError;
  return report;
}

// ---------------------------------------------------------------------------
// ADR-0044 S3a — `note` staging executor (contract §3.3/§6) and
// `status --slot` inspection (contract §7/§10)
// ---------------------------------------------------------------------------

export async function noteContext(options = {}) {
  const hookGrade = options.hookGrade === true;
  const chosen = [
    options.text !== undefined ? '--text' : null,
    options.file !== undefined ? '--file' : null,
    options.clear === true ? '--clear' : null,
  ].filter(Boolean);
  if (chosen.length !== 1) {
    throw new Error('note requires exactly one of --text, --file, or --clear');
  }
  if (options.clear === true && options.host !== undefined) {
    throw new Error('--host does not combine with --clear');
  }
  const host = options.host === undefined ? null : validateNoteHost(options.host);

  // Repo scoping (contract §1): walk up to the nearest .git marker from the
  // explicit --repo-root (which may be a subdirectory) or the cwd. The
  // pure-fs walk-up is notify.mjs's resolveRepoRoot — one copy, no spawn.
  const startDir = options.repoRoot ? resolve(options.repoRoot) : resolve(options.cwd ?? process.cwd());
  const repoRoot = resolveRepoRoot({ cwd: startDir });
  if (!repoRoot) {
    if (hookGrade) {
      // Contract §1: non-git cwd ⇒ silent no-op on the hook/sidecar path —
      // a skip, not a failure (zero stderr, exit 0 at the CLI layer).
      return { command: 'note', version: VERSION, status: 'skipped', reason: 'no-repo-root', limits: noteLimits() };
    }
    throw new Error('note is repo-scoped: no git repository found from the invocation directory (contract §1 — the staging slot lives under <repo>/.agentic-plugins/state/runtime/session-capture/)');
  }

  if (options.clear === true) {
    // Clearing never creates directories: only the containment chain is
    // asserted (no mkdir), and a missing staging area simply reports
    // removed=false (peer edge-case: --clear must not mutate an empty repo).
    const { dir } = await assertSessionCaptureChain(repoRoot);
    const notePath = resolve(dir, 'note.json');
    let removed = false;
    try {
      await rm(notePath);
      removed = true;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
    return {
      command: 'note',
      version: VERSION,
      status: 'cleared',
      removed,
      note_pointer: pointer(repoRoot, notePath),
      limits: noteLimits(),
    };
  }

  const content = options.file !== undefined
    ? await readNoteSourceFile(options.file)
    : String(options.text);
  if (content.length === 0) {
    throw new Error('note content must not be empty — use --clear to empty the staging slot');
  }
  const contentBytes = Buffer.byteLength(content, 'utf8');
  if (contentBytes > NOTE_CONTENT_MAX_BYTES) {
    throw new Error(`note content is ${contentBytes} UTF-8 bytes, over the ${NOTE_CONTENT_MAX_BYTES}-byte cap — refused, not truncated`);
  }

  const dir = await ensureSessionCaptureDir(repoRoot);
  const notePath = resolve(dir, 'note.json');
  const now = options.now ?? new Date();
  const staging = await observeStagingGitContext(repoRoot, toIso(now));
  const document = {
    schema: NOTE_SCHEMA_ID,
    staged_at: toIsoSeconds(now),
    host,
    branch: staging.branch,
    head_short: staging.headShort,
    content,
    content_hash: `sha256:${createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')}`,
  };
  const schema = await loadSchema('runtime-session-note');
  const verdict = validateAgainstSchema(document, schema, { readerVersion: NOTE_SCHEMA_ID });
  if (!verdict.ok) {
    // Validate-before-rename (contract §3): a document this writer assembled
    // that fails its own schema is a writer bug — refuse, never stage.
    throw new Error(`staged note failed schema validation before rename: ${verdict.errors.join('; ')}`);
  }
  await atomicWriteSessionCaptureFile({ dir, fileName: 'note.json', document, schema });

  return {
    command: 'note',
    version: VERSION,
    status: 'staged',
    note_pointer: pointer(repoRoot, notePath),
    staged_at: document.staged_at,
    host: document.host,
    branch: document.branch,
    head_short: document.head_short,
    content_bytes: contentBytes,
    content_hash: document.content_hash,
    limits: noteLimits(),
  };
}

export async function readSlotStatus(options = {}) {
  // Same repo scoping as note, so a subdirectory invocation inspects the same
  // staging area note writes to. Read-only: when no repo root exists the
  // explicit/cwd directory is inspected as-is and everything honestly reports
  // absent — inspection never needs a write root.
  const startDir = options.repoRoot ? resolve(options.repoRoot) : resolve(options.cwd ?? process.cwd());
  const repoRoot = resolveRepoRoot({ cwd: startDir }) ?? startDir;
  const dir = sessionCaptureDir(repoRoot);
  const now = options.now ?? new Date();

  const inspected = {};
  for (const [fileName, family] of Object.entries(SESSION_CAPTURE_FILE_FAMILIES)) {
    inspected[fileName.replace(/\.json$/, '')] = await inspectSessionCaptureFile({ repoRoot, dir, fileName, family, now });
  }

  const slotDoc = inspected.slot.document;
  const entryDoc = inspected.entry.document;
  let generation;
  if (slotDoc && entryDoc && slotDoc.fingerprint === entryDoc.fingerprint
    && slotDoc.captured_at === entryDoc.captured_at) {
    generation = 'committed';
  } else if (inspected.slot.state === 'absent' && inspected.entry.state === 'absent') {
    generation = 'absent';
  } else {
    // Contract §7.2 — any half-published, half-valid, or fingerprint-divergent
    // slot/entry pair is one mixed (incomplete) generation: never load-bearing,
    // republished by the next publisher run.
    generation = 'mixed';
  }

  return {
    command: 'status',
    mode: 'slot',
    version: VERSION,
    status: 'inspected',
    read_only: true,
    capture_dir_pointer: pointer(repoRoot, dir),
    generation,
    files: {
      slot: publicCaptureFileEntry(inspected.slot),
      entry: publicCaptureFileEntry(inspected.entry),
      note: publicCaptureFileEntry(inspected.note),
    },
    limits: slotStatusLimits(),
  };
}

// ---------------------------------------------------------------------------
// ADR-0044 S3b — `publish-session` publisher executor (contract §5-§8, §10)
// ---------------------------------------------------------------------------

// Contract §4 policy numbers. The normative home is the packaged
// docs/session-capture-contract.md — changing a value there is a contract
// change, and these constants must follow it.
export const PUBLISH_REFRESH_TTL_MS = 300 * 1000;
export const LOCK_STALE_AGE_MS = 60 * 1000;
export const SWEEP_MAX_AGE_MS = 10 * 60 * 1000;
export const SWEEP_MAX_REMOVALS = 8;
const SLOT_SCHEMA_ID = 'runtime-session-capture-1.0';
const ENTRY_SCHEMA_ID = 'runtime-session-entry-1.0';
const SESSION_ID_MAX_CHARS = 128;
const ENTRY_SUMMARY_LINE_MAX_CHARS = 160;
const SESSION_EVIDENCE_VALUES = new Set(['none', 'fresh']);
// §2 temp naming: `<final-name>.tmp-<pid>-<random-hex>`. The sweep matches
// ONLY this pattern, so slot/entry/note.json and .lock are never candidates.
const CAPTURE_TEMP_RE = /\.tmp-\d+-[0-9a-f]+$/;
const CONTROL_RE_G = /[\u0000-\u001f\u007f]/g;

// The hook-fired slot publisher (ADR-0044 §10). Transaction order is
// contract-fixed: config gate → canonical write-root containment → O_EXCL
// slot lock (owner token, stale takeover, bounded future skew) → committed
// entry.json read (§7.2) → bounded structural + note inputs → fingerprint →
// no-op or slot-then-entry publish → own-staging sweep → release in finally.
// This function throws for hostile/invalid inputs; the hook-grade CLI layer
// (main) converts every throw into exit-0 + at most one stderr line (§9) —
// a capture failure must never break a turn, hook, or commit.
export async function publishSessionCapture(options = {}) {
  // Sensor-relayed argv is validated and clamped, never trusted as a
  // publisher observation (ADR-0044 §1): --host is required (the sensor
  // always passes it), the session id is CLAMPED rather than rejected (§2),
  // and an absent evidence flag is recorded as none (§5.3).
  const host = validateNoteHost(required(options.host, '--host'));
  const sessionId = options.sessionId === undefined ? null : clampSessionId(options.sessionId);
  const workflowEvidence = options.workflowEvidence === undefined
    ? 'none'
    : validateWorkflowEvidence(options.workflowEvidence);
  const now = options.now ?? new Date();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();

  // Repo scoping via the contract §6 root probe: non-git start dir ⇒ silent
  // no-op — v1 is repo-scoped and produces nothing. ONLY the root probe
  // precedes the config gate (the gate itself is repo-scoped), so the
  // gate-off path costs exactly one spawn per turn (ADR-0044 Consequences);
  // the remaining structural probes run inside the lock, in their §10
  // transaction position.
  const startDir = options.repoRoot ? resolve(options.repoRoot) : resolve(options.cwd ?? process.cwd());
  const repoRoot = await resolveGitTopLevel(startDir);
  if (!repoRoot) {
    return publishSkipReport('no-repo-root');
  }

  // Config gate (contract §1), evaluated INSIDE the publisher — the
  // notify_channel shape: shipped default off, fail-closed loader, so a
  // broken config never turns capture on. Gate-off mutates NOTHING — no
  // mkdir, no lock, no sweep.
  const gate = loadSessionConfig({ repoRoot, ...(options.homeDir ? { homeDir: options.homeDir } : {}) });
  if (!gate.ok) return publishSkipReport('config-fail-closed');
  if (gate.config.sessionCapture !== 'stop-hook') return publishSkipReport('gate-off');

  // Canonicalized write-root containment (ADR-0044 §10): realpath'd ancestor
  // chain, symlinked parents refused — BEFORE any mutation.
  const dir = await ensureSessionCaptureDir(repoRoot);

  // A real mutex (contract §8), not a dedupe claim.
  const lock = await acquireSlotLock({ dir, nowMs });
  if (!lock.acquired) return publishSkipReport(lock.reason);
  try {
    // Committed-generation read (§7.2): the refresh no-op decision reads the
    // committed entry.json — never the possibly-newer slot.json. slot.json
    // participates only through the fingerprint-equality check that detects
    // a mixed (incomplete) generation; note.json is the §6 semantic inlet.
    // Each file reads fail-closed independently.
    const entry = await inspectSessionCaptureFile({ repoRoot, dir, fileName: 'entry.json', family: 'runtime-session-entry', now });
    const slot = await inspectSessionCaptureFile({ repoRoot, dir, fileName: 'slot.json', family: 'runtime-session-capture', now });
    const note = await inspectSessionCaptureFile({ repoRoot, dir, fileName: 'note.json', family: 'runtime-session-note', now });
    // Bounded structural observation in its §10 position: after the
    // committed-generation read, inside the lock, before the fingerprint.
    const gitFacts = await observeSessionGitFacts(repoRoot);
    // Decision clock, re-sampled AFTER the bounded probes when the caller
    // did not inject one (plan-verify peer): up to three ~3s probes elapse
    // above, and the fold/TTL/sweep decisions plus captured_at should
    // reflect the actual publication instant. An injected options.now stays
    // authoritative so tests remain deterministic.
    const decisionNow = options.now ?? new Date();
    const decisionMs = decisionNow.getTime();
    const folded = foldableNote(note, decisionMs);

    const fingerprint = computeSessionFingerprint({
      branch: gitFacts.branch,
      headShort: gitFacts.headShort,
      statusDigest: gitFacts.statusDigest,
      sessionId,
      note: folded,
      workflowEvidence,
    });

    // §5.1 no-op: committed entry valid, fingerprint-matched with slot,
    // unchanged from the computed value, and younger than the refresh TTL.
    // Any mixed or malformed generation fails this check and republishes.
    // §7.2 same-generation identity is fingerprint AND captured_at: a crash
    // between a refreshed slot rename and its entry rename leaves a
    // same-fingerprint pair with diverging timestamps, which must republish
    // (plan-verify peer, reproduced by editing slot.captured_at alone).
    const fresh = entry.state === 'valid'
      && slot.state === 'valid'
      && slot.document.fingerprint === entry.document.fingerprint
      && slot.document.captured_at === entry.document.captured_at
      && entry.document.fingerprint === fingerprint
      && withinRefreshTtl(entry.document.captured_at, decisionMs);
    if (fresh) {
      const swept = await sweepOwnStaging({ dir, nowMs: decisionMs }); // §7.3 — a no-op publication still sweeps
      return { ...publishSkipReport('fresh-no-op'), fingerprint, swept_temps: swept };
    }

    const capturedAt = toIsoSeconds(decisionNow);
    const summarySource = folded ? 'staged-note' : 'structural';
    const slotSchema = await loadSchema('runtime-session-capture');
    const entrySchema = await loadSchema('runtime-session-entry');
    const slotDocument = {
      schema: SLOT_SCHEMA_ID,
      captured_at: capturedAt,
      origin: 'stop-hook',
      summary_source: summarySource,
      host,
      session_id: sessionId,
      repo_recent_terminal_evidence: workflowEvidence,
      repo_root: repoRoot,
      branch: gitFacts.branch,
      head_short: gitFacts.headShort,
      dirty_count: gitFacts.dirtyCount,
      status_digest: gitFacts.statusDigest,
      note: folded,
      fingerprint,
    };
    assertOwnDocumentValid(slotDocument, slotSchema, SLOT_SCHEMA_ID, 'slot.json');
    const entryDocument = {
      schema: ENTRY_SCHEMA_ID,
      captured_at: capturedAt,
      origin: 'stop-hook',
      summary_source: summarySource,
      host,
      branch: gitFacts.branch,
      head_short: gitFacts.headShort,
      dirty_count: gitFacts.dirtyCount,
      repo_recent_terminal_evidence: workflowEvidence,
      summary_line: folded ? clampEntrySummaryLine(folded.content) : null,
      note_staged_at: folded ? folded.staged_at : null,
      fingerprint,
    };
    assertOwnDocumentValid(entryDocument, entrySchema, ENTRY_SCHEMA_ID, 'entry.json');
    // §7.2 publication order: slot.json FIRST, then entry.json (the commit
    // record) — both documents fully assembled and validated BEFORE the
    // first rename, so a deterministic assembly/validation failure cannot
    // manufacture a mixed generation (plan-verify peer); only the
    // unavoidable crash window between the two renames remains.
    await atomicWriteSessionCaptureFile({ dir, fileName: 'slot.json', document: slotDocument, schema: slotSchema });
    await atomicWriteSessionCaptureFile({ dir, fileName: 'entry.json', document: entryDocument, schema: entrySchema });

    const swept = await sweepOwnStaging({ dir, nowMs: decisionMs });
    return {
      command: 'publish-session',
      version: VERSION,
      status: 'published',
      summary_source: summarySource,
      fingerprint,
      captured_at: capturedAt,
      slot_pointer: pointer(repoRoot, resolve(dir, 'slot.json')),
      entry_pointer: pointer(repoRoot, resolve(dir, 'entry.json')),
      note_folded: folded !== null,
      lock_takeover: lock.takeover,
      swept_temps: swept,
      limits: publishLimits(),
    };
  } finally {
    await releaseSlotLock({ dir, token: lock.token });
  }
}

// Contract §5.1 — the fingerprint recipe: EXACTLY these six keys in EXACTLY
// this insertion order, serialized by plain compact JSON.stringify and hashed
// over the UTF-8 bytes; null for every absent component. This is deliberately
// NOT lib/schema-validate's canonicalJson() — that helper pretty-prints with
// a trailing newline for artifact writing and must never be reused as the
// fingerprint encoding. Any change to the key set, order, or serialization
// is fp2:.
export function computeSessionFingerprint({ branch, headShort, statusDigest, sessionId, note, workflowEvidence }) {
  const input = JSON.stringify({
    branch: branch ?? null,
    head_short: headShort ?? null,
    status_digest: statusDigest ?? null,
    session_id: sessionId ?? null,
    note: note ? { content_hash: note.content_hash, staged_at: note.staged_at } : null,
    workflow_evidence: workflowEvidence,
  });
  return `fp1:${createHash('sha256').update(Buffer.from(input, 'utf8')).digest('hex')}`;
}

function publishSkipReport(reason) {
  return { command: 'publish-session', version: VERSION, status: 'skipped', reason, limits: publishLimits() };
}

function publishLimits() {
  return [
    'Hook-grade executor: at the CLI it exits 0 always, writes nothing to stdout, and emits at most one stderr line (contract §1).',
    'Gated by session_capture (shipped default off, fail-closed loader) — evaluated inside this executor, never in the sensor.',
    'Writes only the repo-local session-capture slot; deletion authority is limited to its own lock and staging temps (ADR-0044 §3).',
    'The slot is a durable last-writer-wins advisory; consumers are read-only and recompute staleness themselves (contract §10).',
  ];
}


// ---------------------------------------------------------------------------
// ADR-0045 S7b — `entry-brief` arbiter executor (contract §14-§17)
// ---------------------------------------------------------------------------

export const ENTRY_BRIEF_SURFACES = new Set(['session-start-hook', 'cli', 'dashboard']);
// Contract §15.3 — the single marker-paired line's byte cap; enforced by
// deterministic tail-row shrink, never truncation.
export const ENTRY_BRIEF_LINE_MAX_BYTES = 4096;
const ENTRY_BRIEF_MARKER_OPEN = '[agentic-entry-brief]';
const ENTRY_BRIEF_MARKER_CLOSE = '[/agentic-entry-brief]';

// The ADR-0045 §1 arbiter executor: R0 (reads only, writes nothing, consumes
// nothing). The pure lattice lives in lib/entry-brief-arbiter.mjs; this layer
// owns the probes (repo root, dirty count, branch — the S7a reader is
// spawn-free by contract), the config gate, the double validation (packaged
// schema + semantic invariants), and the per-surface output split (§7): the
// gate binds the session-start-hook emission path ONLY; cli/dashboard always
// compute (invoking a read-only CLI by hand IS the opt-in).
export async function entryBriefContext(options = {}) {
  const surface = options.surface ?? 'cli';
  if (!ENTRY_BRIEF_SURFACES.has(surface)) {
    throw new Error('--surface must be session-start-hook, cli, or dashboard');
  }
  // Explicit trusted render host (ADR-0045 §10) — no default: the sensor
  // passes claude; the invoking wrapper passes its own host for cli/dashboard.
  const host = validateNoteHost(required(options.host, '--host'));
  const now = options.now ?? new Date();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const startDir = options.repoRoot ? resolve(options.repoRoot) : resolve(options.cwd ?? process.cwd());
  const repoRoot = await resolveGitTopLevel(startDir);
  if (!repoRoot) {
    return {
      command: 'entry-brief',
      version: VERSION,
      status: 'skipped',
      reason: 'no-repo-root',
      surface,
      host,
      gate: null,
      brief: null,
      emitted_line: null,
      limits: entryBriefLimits(),
    };
  }
  const gate = loadEntryBriefConfig({
    repoRoot,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  const gateMode = gate.ok ? gate.config.entryBrief : 'off';
  const emptyMode = gate.ok ? gate.config.entryBriefEmpty : 'silent';
  const gateReport = {
    entry_brief: gateMode,
    entry_brief_empty: emptyMode,
    config_ok: gate.ok,
    config_errors: gate.errors ?? [],
    ignored_repo_keys: gate.ignoredRepoKeys ?? [],
    repo_layer: gate.repoLayer ?? 'unknown',
  };
  // Early hook gate (contract §17 latency budget; plan-verify peer): a
  // disabled hook invocation resolves the repo root and the gate, then
  // returns BEFORE any bounded read or further git probe — the disabled-state
  // cost is one spawn plus two config-file reads. cli/dashboard fall through:
  // the gate is informational there, never a short-circuit.
  if (surface === 'session-start-hook' && gateMode !== 'startup') {
    return {
      command: 'entry-brief',
      version: VERSION,
      status: 'skipped',
      reason: gate.ok ? 'gate-off' : 'config-fail-closed',
      surface,
      host,
      gate: gateReport,
      brief: null,
      emitted_line: null,
      limits: entryBriefLimits(),
    };
  }
  // Observation bracket (contract §14.4; plan-verify + review peers): the
  // dirty probe runs FIRST, then the collector's initial→reads→final branch
  // bracket, then the dirty probe AGAIN — a branch switch inside the bracket
  // surfaces as the unstable snapshot, and any dirty-count movement across
  // it (an A→B→A round trip, a clean→dirty mutation mid-scan) degrades the
  // count to null: unknown, never clean, so a stale 0 can never synthesize
  // the clean-tree-gated orchestrator:next.
  const dirtyBefore = await observeWorktreeDirtyCount(repoRoot);
  const collected = await collectEntrySources({ repoRoot, branchProbe: observeCurrentBranch, now: nowMs });
  const dirtyAfter = await observeWorktreeDirtyCount(repoRoot);
  const brief = arbitrateEntryBrief({ collected, dirtyCount: reconcileDirtyBracket(dirtyBefore, dirtyAfter), host, nowMs });
  const schema = await loadSchema('runtime-entry-brief');
  // Load-bearing double validation (the S3b assertOwnDocumentValid pattern
  // plus the semantic invariants the structural schema cannot express): a
  // drift throws here and the hook-grade CLI layer converts it to exit-0 +
  // one stderr line — a malformed brief is never injected.
  assertEntryBriefDocument(brief, schema);

  // Emit policy (contract §17): `lead` emits whenever the gate is on;
  // `owner-choice-required` emits only under entry_brief_empty = "report"
  // (ADR-0045 §6 binds the switch to exactly that disposition);
  // `no-branch-context` (the explicit non-firing case) and `indeterminate`
  // stay hook-silent — visible on the cli/dashboard surfaces.
  const emitted = surface === 'session-start-hook'
    && (brief.disposition === 'lead'
      || (brief.disposition === 'owner-choice-required' && emptyMode === 'report'));
  const rendered = emitted ? renderEntryBriefLine(brief, schema) : null;
  return {
    command: 'entry-brief',
    version: VERSION,
    status: 'computed',
    surface,
    host,
    gate: gateReport,
    // The report carries the document the line carries (codex review MINOR):
    // when the line-cap shrink dropped rows, the shrunk document IS the
    // brief — a report/line disagreement would be two truths.
    brief: rendered ? rendered.brief : brief,
    emitted_line: rendered ? rendered.line : null,
    limits: entryBriefLimits(),
  };
}

// The §14.4 dirty-bracket reconciliation, exported for its unit tests: only
// a probe pair that AGREES on a known count survives; any movement across
// the bracket, or a failed probe on either side, is unknown — never clean.
export function reconcileDirtyBracket(before, after) {
  return before !== null && before === after ? before : null;
}

function assertEntryBriefDocument(brief, schema) {
  assertOwnDocumentValid(brief, schema, ENTRY_BRIEF_SCHEMA_ID, 'entry-brief');
  const violation = semanticEntryBriefViolation(brief);
  if (violation) {
    throw new Error(`entry-brief semantic violation: ${violation}`);
  }
}

// Deterministic tail-row shrink under the §15.3 line cap: drop rows from the
// tail (rows_dropped counts each) and re-serialize until the marker-paired
// line fits; if even the row-free brief exceeds the cap the line is withheld
// entirely — no emission is safer than a truncated one. The FINAL emitted
// document is re-validated (schema + semantic); intermediate oversized
// candidates are never emitted anywhere. Returns { line, brief } so the
// caller reports the exact document the line carries, or null when the
// line is withheld. Exported for the shrink-determinism tests.
export function renderEntryBriefLine(brief, schema) {
  let candidate = brief;
  for (;;) {
    const payload = JSON.stringify(candidate).replace(CONTROL_RE_G, '');
    const line = `${ENTRY_BRIEF_MARKER_OPEN} ${payload} ${ENTRY_BRIEF_MARKER_CLOSE}`;
    if (Buffer.byteLength(line, 'utf8') <= ENTRY_BRIEF_LINE_MAX_BYTES) {
      assertEntryBriefDocument(candidate, schema);
      return { line, brief: candidate };
    }
    if (candidate.rows.length === 0) return null;
    candidate = {
      ...candidate,
      rows: candidate.rows.slice(0, -1),
      rows_dropped: candidate.rows_dropped + 1,
    };
  }
}

function entryBriefLimits() {
  return [
    'R0 arbiter: reads persona/orchestrator state, handoff slots, the session-capture entry.json, and runtime ledgers; writes nothing, consumes nothing (ADR-0045 §2).',
    'Pointer-only brief: closed enums, per-family validated ids, ages, counts, safe-alphabet derived pointers; commands are synthesized from the contract state table and host-localized — stored free text never crosses (contract §15).',
    'The entry_brief gate binds the session-start-hook surface only (user-scope-only key: env > user-global > default; a tracked repo value is ignored and reported); cli/dashboard surfaces always compute (ADR-0045 §7).',
    'Hook surface is hook-grade: exit 0 always, at most one marker-paired stdout line, at most one stderr line; a disabled gate returns before any read or probe beyond the repo-root resolution (contract §17).',
  ];
}

// Sensor-relayed and CLAMPED, never rejected (ADR-0044 §2): strip the C0
// range and DEL (the schema pattern excludes them), cap at 128 chars; an
// empty result is recorded as null (omitted-when-absent equivalence).
function clampSessionId(value) {
  const text = String(value).replace(CONTROL_RE_G, '').slice(0, SESSION_ID_MAX_CHARS);
  return text === '' ? null : text;
}

function validateWorkflowEvidence(value) {
  if (!SESSION_EVIDENCE_VALUES.has(value)) {
    throw new Error('--workflow-evidence must be none or fresh');
  }
  return value;
}

// Contract §3.2 — the clamped FIRST line of the folded note: C0/DEL stripped
// (the clampReinjectField discipline), ≤160 chars. Untrusted quoted data for
// every consumer downstream.
function clampEntrySummaryLine(content) {
  // CR|LF|CRLF all end the first line — a bare CR would otherwise merge
  // two lines after control stripping (plan-verify peer).
  const firstLine = String(content).split(/\r\n|[\r\n]/, 1)[0] ?? '';
  return firstLine.replace(CONTROL_RE_G, '').slice(0, ENTRY_SUMMARY_LINE_MAX_CHARS);
}

// Contract §4 fold window: a valid staged note whose staged_at is within
// 24 h of the publication instant. Future skew ≤ 60 s reads as age 0; beyond
// the bound the note must NOT read as fresh. Expired or future-skewed notes
// are ignored, never deleted. Returns the §3.1 slot mirror (note.json minus
// the schema id) or null.
function foldableNote(noteInspection, nowMs) {
  if (noteInspection.state !== 'valid') return null;
  const doc = noteInspection.document;
  const stagedMs = Date.parse(doc.staged_at);
  if (!Number.isFinite(stagedMs)) return null;
  if (stagedMs - nowMs > FUTURE_SKEW_TOLERANCE_MS) return null;
  if (Math.max(0, nowMs - stagedMs) > NOTE_FOLD_WINDOW_MS) return null;
  return {
    staged_at: doc.staged_at,
    host: doc.host,
    branch: doc.branch,
    head_short: doc.head_short,
    content: doc.content,
    content_hash: doc.content_hash,
  };
}

function withinRefreshTtl(capturedAt, nowMs) {
  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs)) return false;
  // A committed timestamp more than the skew bound in the future cannot be
  // trusted as fresh (contract §4) — republish is the conservative side.
  if (capturedMs - nowMs > FUTURE_SKEW_TOLERANCE_MS) return false;
  // strictly YOUNGER than the TTL (contract §4 wording; plan-verify peer)
  return Math.max(0, nowMs - capturedMs) < PUBLISH_REFRESH_TTL_MS;
}

// A document THIS writer assembled that fails its own schema or a §11
// semantic invariant is a writer bug — refuse before rename, never publish
// (contract §3 validate-before-rename).
function assertOwnDocumentValid(document, schema, readerVersion, fileName) {
  const verdict = validateAgainstSchema(document, schema, { readerVersion });
  if (!verdict.ok) {
    throw new Error(`assembled ${fileName} failed its own schema before rename: ${sanitizeValidationReason(verdict.errors)}`);
  }
  const semantic = semanticCaptureViolation(fileName, document);
  if (semantic) {
    throw new Error(`assembled ${fileName} violates a semantic invariant before rename: ${semantic}`);
  }
}

// Contract §8 — a real mutex, not a dedupe claim: `.lock` created O_EXCL
// with an owner token (`<pid>:<random-hex>` as the content), stale takeover
// by age with the future-skew bound applied FIRST, token-checked release. A
// losing publisher exits silently — another publisher is doing this turn's
// work.
async function acquireSlotLock({ dir, nowMs }) {
  const lockPath = resolve(dir, '.lock');
  const token = `${process.pid}:${randomBytes(8).toString('hex')}`;
  let tookOver = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle = null;
    try {
      handle = await open(lockPath, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let entryStat;
      try {
        entryStat = await lstat(lockPath);
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue; // released between EEXIST and stat — one retry
        return { acquired: false, reason: 'lock-unreadable', token: null };
      }
      if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
        // A planted non-regular .lock is hostile input, not a peer publisher:
        // refuse — never write through or take over a symlink.
        return { acquired: false, reason: 'lock-not-regular', token: null };
      }
      // Future-skew bound first (contract §4/§8): a lock mtime within the
      // bound reads as age 0 (held); BEYOND the bound the timestamp is
      // untrustworthy and the lock is treated as stale — takeover is the
      // self-healing side, since holding forever would wedge capture
      // permanently on a crash or clock artifact.
      const farFuture = entryStat.mtimeMs - nowMs > FUTURE_SKEW_TOLERANCE_MS;
      const age = farFuture ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - entryStat.mtimeMs);
      if (age <= LOCK_STALE_AGE_MS) {
        return { acquired: false, reason: 'lock-held', token: null };
      }
      // Stale takeover as a REAL mutual exclusion (contract §8 — the
      // plan-verify peer reproduced two last-rename-wins takeovers both
      // acquiring): CLAIM the stale lock by atomically renaming it away to
      // a unique temp name. rename succeeds for exactly one contender;
      // every loser sees ENOENT and exits silently. The winner removes its
      // claimed file (own-lock deletion, the ADR-0044 §3 grant — a leftover
      // matches the temp pattern and falls to the sweep) and loops back to
      // the O_EXCL create; a third publisher that slips in between wins the
      // create and this one exits lock-held at the next EEXIST. The
      // displaced owner's release no-ops on the token check either way.
      const claimPath = resolve(dir, `.lock.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
      try {
        await rename(lockPath, claimPath);
      } catch {
        return { acquired: false, reason: 'lock-takeover-race', token: null };
      }
      try {
        await rm(claimPath, { force: true });
      } catch {
        // best effort — the claim matches the sweep's temp pattern
      }
      tookOver = true;
      continue;
    }
    try {
      await handle.writeFile(token, 'utf8');
    } catch {
      // The wx create succeeded but the token write failed — remove the
      // half-created lock so it cannot wedge publishers until stale
      // takeover (plan-verify peer).
      await handle.close().catch(() => {});
      try {
        await rm(lockPath, { force: true });
      } catch {
        // best effort
      }
      return { acquired: false, reason: 'lock-write-failed', token: null };
    }
    await handle.close();
    return { acquired: true, reason: null, token, takeover: tookOver };
  }
  return { acquired: false, reason: 'lock-vanished-race', token: null };
}

// Token-checked release (contract §8): delete ONLY a lock still carrying our
// token, so a displaced owner cannot delete a successor's lock. The
// read-compare-delete window is the documented residual (no compare-and-
// unlink primitive exists); best-effort — a vanished or foreign lock is left
// alone.
async function releaseSlotLock({ dir, token }) {
  if (!token) return;
  const lockPath = resolve(dir, '.lock');
  try {
    const entryStat = await lstat(lockPath);
    if (entryStat.isSymbolicLink() || !entryStat.isFile() || entryStat.size > 256) return;
    const current = await readFile(lockPath, 'utf8');
    if (current !== token) return;
    await rm(lockPath, { force: true });
  } catch {
    // ENOENT (swept / taken over) or unreadable — release is best-effort.
  }
}

// Contract §7.3 — bounded sweep of the publisher's OWN staging area only:
// files matching the §2 temp pattern, older than the max writer lifetime,
// at most SWEEP_MAX_REMOVALS per run. Deletion authority is the narrow
// ADR-0044 §3 grant; nothing else in the directory is ever a candidate. A
// far-future mtime cannot prove age, so it is skipped (same skew bound).
async function sweepOwnStaging({ dir, nowMs }) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (removed >= SWEEP_MAX_REMOVALS) break;
    if (!CAPTURE_TEMP_RE.test(name)) continue;
    const tempPath = resolve(dir, name);
    try {
      const entryStat = await lstat(tempPath);
      if (entryStat.isSymbolicLink() || !entryStat.isFile()) continue;
      if (entryStat.mtimeMs - nowMs > FUTURE_SKEW_TOLERANCE_MS) continue;
      if (Math.max(0, nowMs - entryStat.mtimeMs) <= SWEEP_MAX_AGE_MS) continue;
      await rm(tempPath, { force: true });
      removed += 1;
    } catch {
      // a vanished or unremovable temp is not a publish failure
    }
  }
  return removed;
}

// sessionCaptureDir moved to lib/session-capture-inspect.mjs (ADR-0045 S7a).

// ADR-0044 §10 containment hardening, checked BEFORE any mutation: walk the
// ancestor chain with lstat (no-follow) and refuse on any symlinked or
// non-directory segment, so a hostile symlinked parent cannot make the mkdir
// below create directories outside the repo before the check fires
// (plan-verify peer blocker, live-reproduced against the draft). A missing
// segment ends the walk — nothing below it can be a symlink yet. Node has no
// openat, so a swap racing between this check and the mkdir cannot be fully
// excluded; the realpath re-verification refuses to USE anything that
// escaped, which is the documented residual boundary.
async function assertSessionCaptureChain(repoRoot) {
  const realRoot = await realpath(resolve(repoRoot));
  const segments = ['.agentic-plugins', ...SESSION_CAPTURE_SEGMENTS];
  const dir = resolve(realRoot, ...segments);
  let current = realRoot;
  for (const segment of segments) {
    current = resolve(current, segment);
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if (error?.code === 'ENOENT') return { realRoot, dir };
      throw new Error(`session-capture write root is unreadable at ${pointer(realRoot, current)}: ${error?.code ?? error?.message ?? 'unknown'}`);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`session-capture write root resolves outside the repo (symlinked parent refused): ${pointer(realRoot, current)}`);
    }
  }
  return { realRoot, dir };
}

async function ensureSessionCaptureDir(repoRoot) {
  const { dir } = await assertSessionCaptureChain(repoRoot);
  await mkdir(dir, { recursive: true });
  const realDir = await realpath(dir);
  if (realDir !== dir) {
    throw new Error(`session-capture write root resolves outside the repo (symlinked parent refused): ${dir}`);
  }
  return realDir;
}

function validateNoteHost(value) {
  if (!NOTE_HOSTS.has(value)) {
    throw new Error('--host must be claude or codex');
  }
  return value;
}

// note --file source gates (contract §3.3): lstat no-follow first (fast, and
// names the rejection honestly), then an O_NOFOLLOW|O_NONBLOCK open + fstat
// re-check so a swap between lstat and open (TOCTOU) cannot smuggle a
// symlink/FIFO/oversize source past the gate. O_NONBLOCK keeps a FIFO open
// from blocking; it is a no-op for regular files.
async function readNoteSourceFile(filePath) {
  const source = resolve(filePath);
  let linkStat;
  try {
    linkStat = await lstat(source);
  } catch (error) {
    throw new Error(`--file is unreadable: ${error?.code ?? error?.message ?? 'unknown'}`);
  }
  if (linkStat.isSymbolicLink()) {
    throw new Error('--file must be a regular file (symlinked source rejected — lstat no-follow)');
  }
  if (!linkStat.isFile()) {
    throw new Error('--file must be a regular file (FIFO/device/directory sources are rejected)');
  }
  if (linkStat.size > NOTE_CONTENT_MAX_BYTES) {
    throw new Error(`--file is ${linkStat.size} bytes, over the ${NOTE_CONTENT_MAX_BYTES}-byte note cap — refused, not truncated`);
  }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  let handle;
  try {
    handle = await open(source, flags);
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw new Error('--file must be a regular file (symlinked source rejected — lstat no-follow)');
    }
    throw new Error(`--file is unreadable: ${error?.code ?? error?.message ?? 'unknown'}`);
  }
  try {
    const openStat = await handle.stat();
    if (!openStat.isFile()) {
      throw new Error('--file must be a regular file (FIFO/device/directory sources are rejected)');
    }
    if (openStat.size > NOTE_CONTENT_MAX_BYTES) {
      throw new Error(`--file is ${openStat.size} bytes, over the ${NOTE_CONTENT_MAX_BYTES}-byte note cap — refused, not truncated`);
    }
    // Bounded read LOOP on the open handle: a single read() may legally
    // return short, and the earlier fstat size cannot see post-stat growth —
    // the loop itself is the cap (cap+1 buffer; crossing the cap refuses).
    const buffer = Buffer.alloc(NOTE_CONTENT_MAX_BYTES + 1);
    let filled = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
      if (filled > NOTE_CONTENT_MAX_BYTES) {
        throw new Error(`--file grew past the ${NOTE_CONTENT_MAX_BYTES}-byte note cap during read — refused, not truncated`);
      }
    }
    // Fatal UTF-8 decode: replacement decoding would silently rewrite the
    // source bytes, breaking both "content verbatim" (§3.3) and the
    // exact-content-bytes hash.
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, filled));
    } catch {
      throw new Error('--file is not valid UTF-8 — refused, never replacement-decoded');
    }
  } finally {
    await handle.close();
  }
}

// Staging-time git context (contract §6 discipline via the registered
// source-snapshot probes — no new child_process import here). Per-field honest
// degradation: a failed probe nulls its own fields and staging proceeds.
async function observeStagingGitContext(repoRoot, observedAt) {
  const snapshot = await resolveSourceSnapshot({ repoRoot, observedAt });
  if (snapshot.status !== 'observed') return { branch: null, headShort: null };
  const branch = typeof snapshot.branch === 'string'
    && snapshot.branch.length > 0
    && snapshot.branch.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(snapshot.branch)
    ? snapshot.branch
    : null;
  const commit = typeof snapshot.commit === 'string' ? snapshot.commit : '';
  const headShort = /^[0-9a-f]{7,64}$/.test(commit) ? commit.slice(0, 12) : null;
  return { branch, headShort };
}

// Atomic staging write (contract §7.1): uniquely named sibling temp
// (`<final-name>.tmp-<pid>-<random-hex>`, §2 naming) then same-directory
// rename. The document was validated before this is called; bytes on disk are
// the schema-canonical serialization so re-reads are deterministic.
async function atomicWriteSessionCaptureFile({ dir, fileName, document, schema }) {
  const finalPath = resolve(dir, fileName);
  const tempPath = resolve(dir, `${fileName}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    // 'wx' (O_CREAT|O_EXCL): never follow or overwrite anything pre-planted
    // at the unique temp name — an existing entry (even a symlink) is EEXIST.
    await writeFile(tempPath, canonicalJson(document, schema), { flag: 'wx' });
    await rename(tempPath, finalPath);
  } catch (error) {
    // Cleanup covers write, serialization, and rename failures alike; the
    // previous note.json is preserved because only rename replaces it. A
    // leftover temp (e.g. a crash before this line) is the publisher's
    // bounded §7.3 sweep's job — ordinary failures clean up here.
    try {
      await rm(tempPath, { force: true });
    } catch {
      // Best effort — never mask the original failure with cleanup noise.
    }
    throw error;
  }
  return finalPath;
}

// Read one session-capture file for `status --slot`: absent | valid | invalid.
// The fail-closed gate sequence lives in lib/session-capture-inspect.mjs
// (shared with the ADR-0045 entry-brief readers — one gate, no mirrors);
// this wrapper layers the report-facing pointer and summary on top.
async function inspectSessionCaptureFile({ repoRoot, dir, fileName, family, now }) {
  const core = await inspectSessionCaptureFileCore({ dir, fileName, family });
  return {
    pointer: pointer(repoRoot, resolve(dir, fileName)),
    state: core.state,
    reason: core.reason,
    summary: core.state === 'valid' ? summarizeSessionCaptureFile({ fileName, document: core.document, now }) : null,
    document: core.document,
  };
}

function summarizeSessionCaptureFile({ fileName, document, now }) {
  if (fileName === 'slot.json') {
    return {
      captured_at: document.captured_at,
      origin: document.origin,
      summary_source: document.summary_source,
      host: document.host,
      session_id: document.session_id,
      branch: document.branch,
      head_short: document.head_short,
      dirty_count: document.dirty_count,
      repo_recent_terminal_evidence: document.repo_recent_terminal_evidence,
      note_folded: document.note !== null,
      fingerprint: document.fingerprint,
    };
  }
  if (fileName === 'entry.json') {
    return {
      captured_at: document.captured_at,
      summary_source: document.summary_source,
      host: document.host,
      branch: document.branch,
      head_short: document.head_short,
      dirty_count: document.dirty_count,
      summary_line: document.summary_line,
      note_staged_at: document.note_staged_at,
      fingerprint: document.fingerprint,
    };
  }
  // Fold-window arithmetic under the contract §4 future-skew bound: a
  // slightly-future staged_at (clock drift ≤ 60 s) is tolerated as age 0; a
  // far-future one must NOT read as fresh — it is reported as future-skewed
  // and outside the fold window.
  const stagedMs = Date.parse(document.staged_at);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  let ageMs = null;
  let clockState = null;
  if (Number.isFinite(stagedMs)) {
    if (stagedMs - nowMs > FUTURE_SKEW_TOLERANCE_MS) {
      clockState = 'future-skewed';
    } else {
      clockState = 'ok';
      ageMs = Math.max(0, nowMs - stagedMs);
    }
  }
  return {
    staged_at: document.staged_at,
    host: document.host,
    branch: document.branch,
    head_short: document.head_short,
    content_bytes: Buffer.byteLength(document.content, 'utf8'),
    content_hash: document.content_hash,
    clock_state: clockState,
    age_hours: ageMs === null ? null : roundOne(ageMs / 3600000),
    within_fold_window: clockState === 'future-skewed' ? false : ageMs === null ? null : ageMs <= NOTE_FOLD_WINDOW_MS,
  };
}

function publicCaptureFileEntry({ pointer: filePointer, state, reason, summary }) {
  return { pointer: filePointer, state, reason, summary };
}

// truncateReason moved to lib/session-capture-inspect.mjs (ADR-0045 S7a).

function noteLimits() {
  return [
    'Explicit staging write only — this invocation is the ADR-0035 invariant-1 opt-in; nothing stages notes automatically.',
    `Note content is capped at ${NOTE_CONTENT_MAX_BYTES} UTF-8 bytes and stays repo-local under .agentic-plugins/state/runtime/session-capture/.`,
    'The staged note reaches the auto slot only through the publish-session publisher, and only within the 24h fold window; --clear empties the staging slot explicitly.',
    'Note content is untrusted quoted data for every consumer — never instructions, never a command source.',
  ];
}

function slotStatusLimits() {
  return [
    'Read-only inspection; malformed files are skipped fail-closed and are never repaired or deleted on read.',
    'Note and summary content are untrusted quoted data; this report exposes structural metadata and clamped fields only.',
    'Ages shown are advisory diagnostics; consumers recompute staleness from captured_at / note_staged_at themselves.',
    'This surface does not mutate host session context.',
  ];
}

export function parseArgs(argv) {
  const args = [...argv];
  let command = null;
  if (args[0] && !args[0].startsWith('-')) {
    command = args.shift();
    if (!VALID_COMMANDS.has(command)) {
      throw new Error(`Command must be one of: ${[...VALID_COMMANDS].join(', ')}`);
    }
  }

  const options = { artifacts: [] };
  while (args.length > 0) {
    const arg = args.shift();
    if (!arg.startsWith('-')) {
      if (!command && VALID_COMMANDS.has(arg)) {
        command = arg;
        continue;
      }
      throw new Error(`Command must be one of: ${[...VALID_COMMANDS].join(', ')}`);
    }
    switch (arg) {
      case '--repo-root':
        options.repoRoot = requireValue(args, arg);
        break;
      case '--format': {
        const format = requireValue(args, arg);
        if (!['text', 'json'].includes(format)) throw new Error('--format must be text or json');
        options.format = format;
        break;
      }
      case '--run-id':
        options.runId = validateRunId(requireValue(args, arg));
        break;
      case '--latest':
        options.latest = true;
        break;
      case '--stale-after-hours':
        options.staleAfterMs = parseNonNegativeInteger(requireValue(args, arg), arg) * 60 * 60 * 1000;
        break;
      case '--summary':
        options.summary = requireValue(args, arg);
        break;
      case '--summary-file':
        options.summaryFile = requireValue(args, arg);
        break;
      case '--risk':
        options.risk = validateRiskLevel(requireValue(args, arg));
        break;
      case '--token-budget':
        options.tokenBudget = parsePositiveInteger(requireValue(args, arg), arg);
        break;
      case '--used-tokens':
        options.usedTokens = parseNonNegativeInteger(requireValue(args, arg), arg);
        break;
      case '--remaining-tokens':
        options.remainingTokens = parseNonNegativeInteger(requireValue(args, arg), arg);
        break;
      case '--risk-reason':
        options.riskReason = requireSingleLine(requireValue(args, arg), arg);
        break;
      case '--artifact':
        options.artifacts.push(requireSingleLine(requireValue(args, arg), arg));
        break;
      case '--next-action':
        options.nextAction = requireSingleLine(requireValue(args, arg), arg);
        break;
      case '--next-session-prompt':
        options.nextSessionPrompt = requireValue(args, arg);
        break;
      case '--next-session-prompt-file':
        options.nextSessionPromptFile = requireValue(args, arg);
        break;
      case '--workflow-projection-file':
        options.workflowProjectionFile = requireValue(args, arg);
        break;
      case '--routing-recommendation':
        options.routingRecommendation = requireSingleLine(requireValue(args, arg), arg);
        break;
      case '--slot':
        options.slot = true;
        break;
      case '--text':
        options.text = requireValue(args, arg);
        break;
      case '--file':
        options.file = requireValue(args, arg);
        break;
      case '--clear':
        options.clear = true;
        break;
      case '--host':
        options.host = requireValue(args, arg);
        break;
      case '--session-id':
        options.sessionId = requireValue(args, arg);
        break;
      case '--workflow-evidence':
        options.workflowEvidence = requireValue(args, arg);
        break;
      case '--hook-grade':
        options.hookGrade = true;
        break;
      case '--surface': {
        const surface = requireValue(args, arg);
        if (!ENTRY_BRIEF_SURFACES.has(surface)) {
          throw new Error('--surface must be session-start-hook, cli, or dashboard');
        }
        options.surface = surface;
        break;
      }
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  options.command = command ?? 'capture';
  assertFlagCombination(options);
  return options;
}

// The new S3a flags are command-scoped explicitly — the output-mode split and
// the slot/ledger selector split are contract boundaries (ADR-0044 §7/§9), so
// a wrong combination is refused rather than silently ignored.
function assertFlagCombination(options) {
  const command = options.command;
  if (options.hookGrade === true && command !== 'note') {
    throw new Error('--hook-grade applies only to note (the hook/sidecar-invoked staging mode; publish-session is hook-grade by definition and needs no flag)');
  }
  if (options.hookGrade === true && options.format !== undefined) {
    throw new Error('--hook-grade writes nothing to stdout; it does not combine with --format');
  }
  if (options.hookGrade === true && options.help === true) {
    throw new Error('--hook-grade writes nothing to stdout; it does not combine with --help');
  }
  if (command !== 'note') {
    if (options.text !== undefined) throw new Error('--text applies only to note');
    if (options.file !== undefined) throw new Error('--file applies only to note');
    if (options.clear === true) throw new Error('--clear applies only to note');
  }
  if (command !== 'note' && command !== 'publish-session' && command !== 'entry-brief') {
    if (options.host !== undefined) throw new Error('--host applies only to note, publish-session, and entry-brief');
  }
  if (options.surface !== undefined && command !== 'entry-brief') {
    throw new Error('--surface applies only to entry-brief');
  }
  if (command === 'entry-brief') {
    // The arbiter surface takes no selector, staging, or projection flags —
    // its inputs are the probes and the config gate (contract §14). The
    // note/publish/hook-grade scoping above already refuses those families.
    for (const [flag, present] of [
      ...captureAndLedgerFlagPresence(options),
      ['--run-id', options.runId !== undefined],
      ['--latest', options.latest === true],
      ['--stale-after-hours', options.staleAfterMs !== undefined],
      ['--workflow-projection-file', options.workflowProjectionFile !== undefined],
      ['--routing-recommendation', options.routingRecommendation !== undefined],
      ['--slot', options.slot === true],
    ]) {
      if (present) throw new Error(`${flag} does not apply to entry-brief`);
    }
    if (options.surface === 'session-start-hook' && options.format !== undefined) {
      throw new Error('--format does not combine with --surface session-start-hook (hook-grade surface, contract §17)');
    }
    if (options.surface === 'session-start-hook' && options.help === true) {
      throw new Error('--help does not combine with --surface session-start-hook (hook-grade surface)');
    }
  }
  if (command !== 'publish-session') {
    if (options.sessionId !== undefined) throw new Error('--session-id applies only to publish-session');
    if (options.workflowEvidence !== undefined) throw new Error('--workflow-evidence applies only to publish-session');
  }
  if (command === 'publish-session') {
    // Hook-grade by command (contract §1): nothing may reach stdout, so the
    // reporter/help flags are refused outright, alongside every selector or
    // staging flag from the other command families.
    for (const [flag, present] of [
      ...captureAndLedgerFlagPresence(options),
      ['--run-id', options.runId !== undefined],
      ['--latest', options.latest === true],
      ['--stale-after-hours', options.staleAfterMs !== undefined],
      ['--workflow-projection-file', options.workflowProjectionFile !== undefined],
      ['--routing-recommendation', options.routingRecommendation !== undefined],
      ['--slot', options.slot === true],
      ['--format', options.format !== undefined],
      ['--help', options.help === true],
    ]) {
      if (present) throw new Error(`${flag} does not apply to publish-session (hook-grade executor, contract §1)`);
    }
  }
  if (command === 'note') {
    for (const [flag, present] of [
      ...captureAndLedgerFlagPresence(options),
      ['--run-id', options.runId !== undefined],
      ['--latest', options.latest === true],
      ['--stale-after-hours', options.staleAfterMs !== undefined],
      ['--workflow-projection-file', options.workflowProjectionFile !== undefined],
      ['--routing-recommendation', options.routingRecommendation !== undefined],
      ['--slot', options.slot === true],
    ]) {
      if (present) throw new Error(`${flag} does not apply to note`);
    }
  }
  if (options.slot === true) {
    if (command !== 'status') throw new Error('--slot applies only to status');
    if (options.runId || options.latest) {
      throw new Error('Use --slot or the run-ledger selectors (--run-id/--latest), not both');
    }
    if (options.staleAfterMs !== undefined) {
      throw new Error('--stale-after-hours applies to the run-ledger selectors, not --slot');
    }
    if (options.workflowProjectionFile !== undefined || options.routingRecommendation !== undefined) {
      throw new Error('the ADR-0031 projection flags apply to the run-ledger status, not --slot');
    }
    for (const [flag, present] of captureAndLedgerFlagPresence(options)) {
      if (present) throw new Error(`${flag} does not combine with --slot`);
    }
  }
}

// The capture/check flag families, as presence pairs — shared by the note and
// --slot scoping checks so the two refusal lists cannot drift apart.
function captureAndLedgerFlagPresence(options) {
  return [
    ['--summary', options.summary !== undefined],
    ['--summary-file', options.summaryFile !== undefined],
    ['--risk', options.risk !== undefined],
    ['--risk-reason', options.riskReason !== undefined],
    ['--token-budget', options.tokenBudget !== undefined],
    ['--used-tokens', options.usedTokens !== undefined],
    ['--remaining-tokens', options.remainingTokens !== undefined],
    ['--artifact', Array.isArray(options.artifacts) && options.artifacts.length > 0],
    ['--next-action', options.nextAction !== undefined],
    ['--next-session-prompt', options.nextSessionPrompt !== undefined],
    ['--next-session-prompt-file', options.nextSessionPromptFile !== undefined],
  ];
}

export function formatText(report) {
  if (report.help) return helpText();
  const lines = [`runtime:context ${report.version ?? VERSION} (${report.command})`];
  if (report.command === 'entry-brief') {
    lines.push(`status: ${report.status}`);
    if (report.reason) lines.push(`reason: ${report.reason}`);
    lines.push(`surface: ${report.surface}`);
    if (report.gate) {
      lines.push(`gate: entry_brief=${report.gate.entry_brief} entry_brief_empty=${report.gate.entry_brief_empty}${report.gate.config_ok ? '' : ' (config fail-closed)'}`);
      for (const key of report.gate.ignored_repo_keys ?? []) {
        lines.push(`- ignored repo value: ${key} (user-scope-only, ADR-0045 §7)`);
      }
      for (const err of report.gate.config_errors ?? []) {
        lines.push(`- config error: ${err}`);
      }
    }
    if (report.brief) {
      lines.push('', `disposition: ${report.brief.disposition}`);
      if (report.brief.leading) {
        const lead = report.brief.leading;
        lines.push(`leading: ${lead.source}${lead.kind ? `/${lead.kind}` : ''}${lead.id ? ` ${lead.id}` : ''} state=${lead.state} → ${lead.command}`);
      }
      if (report.brief.rows.length > 0) {
        lines.push('rows:');
        for (const entry of report.brief.rows) {
          lines.push(`- ${entry.source}${entry.kind ? `/${entry.kind}` : ''} state=${entry.state}${entry.id ? ` id=${entry.id}` : ''}${entry.age_seconds === null ? '' : ` age=${entry.age_seconds}s`}${entry.pointer ? ` → ${entry.pointer}` : ''}`);
        }
      }
      lines.push(`dirty_count: ${report.brief.dirty_count === null ? 'null' : report.brief.dirty_count}; sources_skipped: ${report.brief.sources_skipped}; rows_dropped: ${report.brief.rows_dropped}`);
      lines.push(`note: ${report.brief.note}`);
    }
    if (report.emitted_line) lines.push('', `emitted line: ${report.emitted_line}`);
    pushLimits(lines, report.limits);
    return lines.join('\n');
  }
  if (report.command === 'note') {
    lines.push(`status: ${report.status}`);
    if (report.status === 'cleared') lines.push(`removed: ${report.removed}`);
    if (report.reason) lines.push(`reason: ${report.reason}`);
    if (report.note_pointer) lines.push(`note: ${report.note_pointer}`);
    if (report.status === 'staged') {
      lines.push(`staged_at: ${report.staged_at}`);
      lines.push(`host: ${report.host ?? 'null'}`);
      lines.push(`branch: ${report.branch ?? 'null'}`);
      lines.push(`head_short: ${report.head_short ?? 'null'}`);
      lines.push(`content: ${report.content_bytes} bytes, ${report.content_hash}`);
    }
    pushLimits(lines, report.limits);
    return lines.join('\n');
  }
  if (report.command === 'status' && report.mode === 'slot') {
    lines.push('mode: slot');
    lines.push(`capture dir: ${report.capture_dir_pointer}`);
    lines.push(`generation: ${report.generation}`);
    for (const key of ['slot', 'entry', 'note']) {
      const entry = report.files[key];
      lines.push('', `${key}.json (${entry.state}): ${entry.pointer}`);
      if (entry.state === 'invalid') lines.push(`- skipped fail-closed: ${entry.reason}`);
      if (entry.summary) {
        for (const [field, value] of Object.entries(entry.summary)) {
          if (field === 'summary_line' && value !== null) {
            // Untrusted quoted data (contract §10) — labeled and JSON-quoted
            // so it can never read as part of the report's own structure.
            lines.push(`- summary_line (untrusted, quoted): ${JSON.stringify(value)}`);
            continue;
          }
          lines.push(`- ${field}: ${value === null ? 'null' : value}`);
        }
      }
    }
    pushLimits(lines, report.limits);
    return lines.join('\n');
  }
  if (report.run_id) lines.push(`run: ${report.run_id}`);
  if (report.risk_level) lines.push(`risk: ${report.risk_level}`);
  if (report.context_pointer) lines.push(`context artifact: ${report.context_pointer}`);
  if (report.next_session?.prompt_pointer) lines.push(`next-session prompt: ${report.next_session.prompt_pointer}`);
  if (report.next_session?.commands) {
    lines.push('next-session commands:');
    for (const [host, command] of Object.entries(report.next_session.commands)) {
      lines.push(`- ${host}: ${command}`);
    }
  }

  if (report.context_summary) {
    lines.push('', 'context summary:', report.context_summary);
  }
  if (report.risk_reason) {
    lines.push('', `risk reason: ${report.risk_reason}`);
  }
  if (report.context_budget) {
    lines.push('', 'context budget:');
    lines.push(formatContextBudget(report.context_budget));
  }
  if (report.session_handoff) {
    pushSessionHandoff(lines, report.session_handoff);
  }
  if (report.projection_error) {
    lines.push('', `workflow projection rejected (degraded to context-risk only): ${report.projection_error}`);
  }
  if (report.handoff) {
    lines.push('', 'handoff lookup:');
    lines.push(formatHandoffLookup(report.handoff));
    // status folds the session decision into the handoff guidance; surface it
    // in text too so the archive-gate report is visible (ADR-0031).
    if (report.handoff.guidance?.session_handoff) {
      pushSessionHandoff(lines, report.handoff.guidance.session_handoff);
    }
  }
  if (report.artifacts?.length) {
    lines.push('', 'artifact pointers:');
    for (const artifact of report.artifacts) {
      lines.push(`- ${artifact.kind}: ${artifact.pointer}`);
    }
  }
  if (report.next_session?.recommended_action) {
    lines.push('', `recommended next action: ${report.next_session.recommended_action}`);
  }
  if (report.next_session?.prompt_preview) {
    lines.push('', 'recommended next-session prompt:', report.next_session.prompt_preview);
  }
  pushLimits(lines, report.limits);
  return lines.join('\n');
}

function pushLimits(lines, limits) {
  if (limits?.length) {
    lines.push('', 'limits:');
    for (const limit of limits) lines.push(`- ${limit}`);
  }
}

function pushSessionHandoff(lines, sessionHandoff) {
  lines.push('', 'session handoff (continue-vs-fresh):');
  lines.push(`- recommended session: ${sessionHandoff.recommended_session}`);
  lines.push(`- reason: ${sessionHandoff.reason}`);
  lines.push(`- archive gate: ${sessionHandoff.archive_gate} — ${sessionHandoff.archive_gate_report}`);
  if (sessionHandoff.unsupported_workflow_kind) {
    lines.push(`- unsupported workflow kind: ${sessionHandoff.unsupported_workflow_kind} (runtime cannot model it; enablement out of scope)`);
  }
  if (sessionHandoff.routing_recommendation) {
    lines.push(`- routing: ${sessionHandoff.routing_recommendation}`);
  }
  if (sessionHandoff.next_command) {
    lines.push(`- next command: ${sessionHandoff.next_command}`);
  }
}

function buildReport({ command, repoRoot, artifact, contextPath, prompt, handoff = null }) {
  const report = {
    command,
    version: VERSION,
    run_id: artifact.run_id,
    status: artifact.status,
    context_pointer: pointer(repoRoot, contextPath),
    context_summary: preview(artifact.context.summary),
    risk_level: artifact.context.risk_level,
    risk_reason: artifact.context.risk_reason,
    artifacts: [
      { kind: 'context-artifact', pointer: pointer(repoRoot, contextPath) },
      ...(artifact.artifacts ?? []),
    ],
    next_session: {
      recommended_action: artifact.next_session.recommended_action,
      prompt_pointer: artifact.next_session.prompt_pointer,
      prompt_preview: prompt ? preview(prompt) : null,
      commands: artifact.next_session.commands ?? hostHandoffCommands(artifact.run_id),
    },
    source_snapshot: artifact.source_snapshot ?? null,
    limits: artifact.limits,
  };
  if (handoff) report.handoff = handoff;
  return report;
}

function buildBudgetCheck(options) {
  const hasRisk = options.risk !== undefined && options.risk !== null;
  const hasBudget = options.tokenBudget !== undefined && options.tokenBudget !== null;
  const hasUsed = options.usedTokens !== undefined && options.usedTokens !== null;
  const hasRemaining = options.remainingTokens !== undefined && options.remainingTokens !== null;
  if (hasRisk && (hasBudget || hasUsed || hasRemaining)) {
    throw new Error('Use budget metrics or --risk, not both');
  }
  if (hasRisk) {
    const riskLevel = validateRiskLevel(options.risk);
    return {
      riskLevel,
      riskReason: 'Risk level was supplied by the caller; no automatic host-context measurement is performed.',
      contextBudget: {
        status: 'not_provided',
        token_budget: null,
        used_tokens: null,
        remaining_tokens: null,
        used_ratio: null,
        used_percent: null,
        thresholds: contextBudgetThresholds(),
      },
    };
  }
  if (!hasBudget || (!hasUsed && !hasRemaining)) {
    throw new Error('check requires --token-budget with either --used-tokens or --remaining-tokens, or --risk');
  }
  if (hasUsed && hasRemaining) {
    throw new Error('Use either --used-tokens or --remaining-tokens, not both');
  }

  const tokenBudget = parsePositiveInteger(options.tokenBudget, '--token-budget');
  const usedTokens = hasUsed
    ? parseNonNegativeInteger(options.usedTokens, '--used-tokens')
    : tokenBudget - parseRemainingTokens(options.remainingTokens, tokenBudget);
  const remainingTokens = hasUsed
    ? Math.max(0, tokenBudget - usedTokens)
    : parseRemainingTokens(options.remainingTokens, tokenBudget);
  const usedRatio = usedTokens / tokenBudget;
  const usedPercent = roundOne(usedRatio * 100);
  const riskLevel = usedRatio >= CONTEXT_BUDGET_THRESHOLDS.redAt
    ? 'red'
    : usedRatio >= CONTEXT_BUDGET_THRESHOLDS.yellowAt
      ? 'yellow'
      : 'green';
  return {
    riskLevel,
    riskReason: `Context budget check used ${usedPercent}% of the supplied token budget.`,
    contextBudget: {
      status: 'observed',
      token_budget: tokenBudget,
      used_tokens: usedTokens,
      remaining_tokens: remainingTokens,
      over_budget_tokens: Math.max(0, usedTokens - tokenBudget),
      used_ratio: roundFour(usedRatio),
      used_percent: usedPercent,
      thresholds: contextBudgetThresholds(),
    },
  };
}

async function resolveSummary(options) {
  if (options.summary && options.summaryFile) {
    throw new Error('Use either --summary or --summary-file, not both');
  }
  if (options.summary) {
    if (!options.summary.trim()) throw new Error('--summary must not be empty');
    return options.summary.trim();
  }
  if (options.summaryFile) {
    const text = await readFile(resolve(options.summaryFile), 'utf8');
    if (!text.trim()) throw new Error('--summary-file must not be empty');
    return text.trim();
  }
  throw new Error('capture requires --summary or --summary-file');
}

async function resolveNextSessionPrompt(options) {
  if (options.nextSessionPrompt && options.nextSessionPromptFile) {
    throw new Error('Use either --next-session-prompt or --next-session-prompt-file, not both');
  }
  if (options.nextSessionPrompt) {
    if (!options.nextSessionPrompt.trim()) throw new Error('--next-session-prompt must not be empty');
    return options.nextSessionPrompt.trim();
  }
  if (options.nextSessionPromptFile) {
    const text = await readFile(resolve(options.nextSessionPromptFile), 'utf8');
    if (!text.trim()) throw new Error('--next-session-prompt-file must not be empty');
    return text.trim();
  }
  return `Continue agentic-plugins work from runtime context artifact ${options.contextPointer}.

Context summary:
${options.summary.trim()}

Risk level: ${options.riskLevel}
Recommended next action: ${options.recommendedAction}

Host handoff commands:
- Claude: ${options.hostCommands.claude}
- Codex: ${options.hostCommands.codex}
- Neutral shell: ${options.hostCommands.neutral}`;
}

// ADR-0031 — read + normalize an optional bounded workflow projection file.
// Fail-closed: an unreadable file or invalid JSON degrades to no projection
// with a reported error, never a thrown exception, so the session preflight
// falls back to context-risk + routing only.
export async function loadWorkflowProjection(options) {
  if (!options.workflowProjectionFile) return { projection: null, error: null };
  let raw;
  try {
    const text = await readFile(resolve(options.workflowProjectionFile), 'utf8');
    raw = JSON.parse(text);
  } catch (err) {
    return { projection: null, error: `workflow projection file unreadable or invalid JSON: ${err.message}` };
  }
  return normalizeProjection(raw);
}

function hostHandoffCommands(runId) {
  return {
    claude: `/runtime:context status --run-id ${runId}`,
    codex: `$runtime:context status --run-id ${runId}`,
    neutral: `runtime:context status --run-id ${runId}`,
  };
}

function normalizeArtifacts(repoRoot, values) {
  const inputs = Array.isArray(values) ? values : [values];
  return inputs.map((value) => {
    const { kind, path } = parseArtifactSpec(value);
    return { kind, pointer: normalizeRepoPointer(repoRoot, path) };
  });
}

function parseArtifactSpec(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error('--artifact must not be empty');
  const colon = text.indexOf(':');
  if (colon > 0) {
    const kind = text.slice(0, colon);
    const path = text.slice(colon + 1);
    if (ARTIFACT_KIND_RE.test(kind) && path) return { kind, path };
  }
  return { kind: 'artifact', path: text };
}

function normalizeRepoPointer(repoRoot, value) {
  if (/[\u0000-\u001F]/.test(value)) {
    throw new Error('artifact pointers must not contain control characters');
  }
  const candidate = isAbsolute(value) ? resolve(value) : resolve(repoRoot, value);
  assertInsideSync(repoRoot, candidate, 'Artifact path escapes repo root');
  return pointer(repoRoot, candidate);
}

function validateRiskLevel(value) {
  if (!RISK_LEVELS.has(value)) {
    throw new Error('--risk must be green, yellow, or red');
  }
  return value;
}

function defaultRiskReason(riskProvided) {
  return riskProvided
    ? 'Risk level was supplied by the caller.'
    : 'No automatic host-context measurement is performed; context capture defaults to yellow unless --risk is supplied.';
}

function defaultNextAction(riskLevel) {
  if (riskLevel === 'green') {
    return 'Continue in the current session only for small follow-up work; keep the context artifact pointer available.';
  }
  if (riskLevel === 'red') {
    return 'Start a fresh session with the next-session prompt before continuing substantial work.';
  }
  return 'Prefer a fresh or resumed session with the next-session prompt before substantial follow-up work.';
}

function defaultCheckNextAction(riskLevel) {
  if (riskLevel === 'green') {
    return 'Continue in the current session only for small follow-up work; keep artifact pointers available.';
  }
  if (riskLevel === 'red') {
    return 'Start a fresh or resumed session before continuing substantial work; run runtime:context capture first if no handoff artifact exists.';
  }
  return 'Prefer a fresh or resumed session before substantial follow-up work; run runtime:context capture first if no handoff artifact exists.';
}

function contextLimits() {
  return [
    'This scaffold writes runtime-owned context artifacts only; it does not mutate host session context.',
    'Main-session output is limited to context summary, risk level, artifact pointers, and recommended next-session action/prompt.',
    'Persona workflow state stays in its existing storage; no migration is performed.',
    'Consensus or peer raw output should be referenced by artifact pointer only, not pasted into the context summary.',
    'Codex plugin-hook feature/trust state and permission limits are not represented as host parity.',
  ];
}

function checkLimits() {
  return [
    'Read-only check only; no context artifact is created.',
    'This check does not mutate, compact, trim, or rewrite host session context.',
    'No automatic context capture, host switch, new workflow, or new session is started.',
    'Persona workflow state stays in its existing storage; no migration is performed.',
    'Codex plugin-hook feature/trust state and permission limits are not represented as host parity.',
  ];
}

function helpText() {
  return `runtime:context ${VERSION}

Usage:
  runtime:context capture --summary <text> [--risk green|yellow|red]
  runtime:context capture --summary-file <path> [--artifact kind:<repo-path>] [--next-action <text>]
  runtime:context status (--run-id <id>|--latest) [--stale-after-hours <n>]
  runtime:context check --token-budget <n> (--used-tokens <n>|--remaining-tokens <n>)
  runtime:context check --risk green|yellow|red [--workflow-projection-file <path>]
  runtime:context status (--run-id <id>|--latest) [--workflow-projection-file <path>]
  runtime:context note (--text <text>|--file <path>|--clear) [--host claude|codex] [--hook-grade]
  runtime:context status --slot
  runtime:context publish-session --host claude|codex [--repo-root <dir>] [--session-id <id>] [--workflow-evidence none|fresh]
  runtime:context entry-brief --host claude|codex [--surface session-start-hook|cli|dashboard] [--repo-root <dir>]

This MVP writes repo-local context artifacts under .agentic-plugins/runs/context/ for capture/status, including a read-only git source snapshot when available. Status reports age-based stale metadata plus source-freshness metadata. The check command is read-only and does not create artifacts or mutate host session context. When a bounded --workflow-projection-file is supplied (ADR-0031), check/status also compose the session-level continue-vs-fresh preflight from the caller-supplied risk and the projection's archive_gate; a malformed projection is reported and degraded, never interpreted.

The ADR-0044 session-capture surface: note stages a semantic handoff note (repo-global, 4096 UTF-8 bytes max, atomic temp+rename, staging-time git context) under .agentic-plugins/state/runtime/session-capture/; --clear empties the staging slot. Operator invocations report on stdout and exit 1 on error; --hook-grade is note's hook/sidecar mode — exit 0 always, nothing on stdout, at most one stderr line. status --slot is a read-only inspection of the validated slot/entry/note files with per-file fail-closed skip. publish-session is the hook-fired slot publisher (hook-grade by definition — no reporter mode): gated by the session_capture config key (default off), it serializes through an O_EXCL owner-token lock, reads the committed entry.json for the fingerprint no-op decision, folds a staged note within the 24h window, publishes slot.json then entry.json via temp+rename, and sweeps only its own stale temps.

The ADR-0045 entry-brief surface: entry-brief is the R0 entry arbiter — it reads the four persona/orchestrator state homes, the macro bridge, the persona handoff slots, the session-capture entry.json, and the context/consensus ledgers (all bounded, consuming nothing), applies the contract §16 precedence lattice, and renders one pointer-only brief (schema runtime-entry-brief-1.0; no stored free text, commands synthesized from the state table only, double-validated against the packaged schema plus the semantic invariants). --surface cli (default) and --surface dashboard always compute and report; --surface session-start-hook is hook-grade (exit 0 always) and emits at most one marker-paired stdout line, gated by the user-scope-only entry_brief key (env > user-global > default; default off) with a disabled gate returning before any read — entry_brief_empty decides whether owner-choice-required emits (no-branch-context and indeterminate stay hook-silent). --host names the trusted render host for command localization.`;
}

function requireValue(args, flag) {
  if (args.length === 0 || args[0].startsWith('-')) {
    throw new Error(`${flag} requires a value`);
  }
  return args.shift();
}

function requireSingleLine(value, flag) {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${flag} must be a single-line value`);
  }
  return value;
}

function required(value, flag) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${flag} is required`);
  }
  return value;
}

function parsePositiveInteger(value, flag) {
  const parsed = parseNonNegativeInteger(value, flag);
  if (parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseNonNegativeInteger(value, flag) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw new Error(`${flag} must be a non-negative integer`);
  return Number.parseInt(text, 10);
}

function parseRemainingTokens(value, tokenBudget) {
  const remaining = parseNonNegativeInteger(value, '--remaining-tokens');
  if (remaining > tokenBudget) {
    throw new Error('--remaining-tokens must be less than or equal to --token-budget');
  }
  return remaining;
}

async function findLatestContextArtifact(repoRoot) {
  const root = contextRoot(repoRoot);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    throw new Error(`No context artifacts found under ${pointer(repoRoot, root)}: ${error.code ?? error.message}`);
  }

  const candidates = [];
  let skippedInvalid = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_ID_RE.test(entry.name)) continue;
    const contextPath = contextFile(repoRoot, entry.name);
    try {
      const artifact = await readJson(contextPath);
      const selectedAt = artifactTimestampMs(artifact, entry.name);
      if (selectedAt === null) {
        skippedInvalid++;
        continue;
      }
      candidates.push({
        runId: entry.name,
        contextPath,
        selectedAt,
      });
    } catch {
      skippedInvalid++;
    }
  }

  if (candidates.length === 0) {
    throw new Error(`No readable context artifacts found under ${pointer(repoRoot, root)}`);
  }

  candidates.sort((a, b) => b.selectedAt - a.selectedAt || b.runId.localeCompare(a.runId));
  return { ...candidates[0], skippedInvalid };
}

function buildHandoffLookup({
  artifact,
  runId,
  latest,
  now,
  staleAfterMs,
  skippedInvalid,
  currentSourceSnapshot,
  sessionHandoff = null,
}) {
  const selectedAt = artifactTimestampMs(artifact, runId);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const ageMs = selectedAt === null ? null : Math.max(0, nowMs - selectedAt);
  const stale = ageMs === null ? null : ageMs > staleAfterMs;
  const sourceFreshness = buildSourceFreshness({
    artifactSnapshot: artifact.source_snapshot,
    currentSnapshot: currentSourceSnapshot,
  });
  return {
    mode: latest ? 'latest' : 'run-id',
    latest,
    selected_at: selectedAt === null ? null : new Date(selectedAt).toISOString(),
    age_ms: ageMs,
    age_minutes: ageMs === null ? null : roundOne(ageMs / 60000),
    stale_after_ms: staleAfterMs,
    stale,
    skipped_invalid: skippedInvalid,
    source_freshness: sourceFreshness,
    guidance: buildHandoffGuidance({ runId, stale, sourceFreshness, sessionHandoff }),
  };
}

// ADR-0031 — extends the existing freshness-based handoff guidance with the
// optional session-level continue-vs-fresh decision. When `sessionHandoff`
// (the matrix result from evaluateSessionHandoff) is supplied, the combined
// recommended_session is the more conservative of the two layers: the stored
// artifact's freshness AND the session's budget/archive-gate state. When it is
// absent the function behaves exactly as before (backward-compatible).
export function buildHandoffGuidance({ runId, stale, sourceFreshness, sessionHandoff = null }) {
  const freshness = freshnessHandoffGuidance({ runId, stale, sourceFreshness });
  if (!sessionHandoff) return freshness;
  const sessionFresh = sessionHandoff.recommended_session === 'fresh_or_resumed';
  const freshnessFresh = freshness.recommended_session === 'fresh_or_resumed';
  // When the SESSION layer is what forces a fresh handoff (the stored artifact
  // is itself reusable), keep the merged guidance coherent — the state, reason,
  // and recommended_action must reflect the session decision, not the stale
  // "reuse_handoff" copy from the freshness layer.
  if (sessionFresh && !freshnessFresh) {
    const tail = sessionHandoff.next_command ? ` Next: ${sessionHandoff.next_command}.` : '';
    return {
      ...freshness,
      state: 'session_handoff_fresh',
      recommended_session: 'fresh_or_resumed',
      reason: sessionHandoff.reason,
      recommended_action: `Hand off to a fresh session — ${sessionHandoff.reason}.${tail}`,
      session_handoff: sessionHandoff,
    };
  }
  return {
    ...freshness,
    recommended_session: freshnessFresh || sessionFresh ? 'fresh_or_resumed' : 'current_or_resumed',
    session_handoff: sessionHandoff,
  };
}

// ADR-0031 § Decision policy — the session-level continue-vs-fresh matrix.
// Pure (never throws): composes caller-supplied context-budget risk (a) with
// the bounded workflow projection's archive_gate (b); the routing
// recommendation (c) is always available (from the projection when present,
// else the standalone `routing` arg) and shapes the next-session command, not
// the binary decision. Returns null only when none of the three inputs is
// present (nothing to decide).
export function evaluateSessionHandoff({ riskLevel = null, projection = null, routing = null, unsupportedKind = null } = {}) {
  // ADR-0031 (runtime-unsupported-kind) — an active workflow whose kind runtime
  // cannot model (e.g. image, or a typo) reaches the seam as projection=null +
  // unsupportedKind=<name>. The honest path fires only for a real, named-but-
  // unsupported kind; a malformed projection (missing/empty kind) leaves
  // unsupported=null and keeps the prior absent behavior.
  const unsupported = stringOrNull(unsupportedKind);
  if (riskLevel === null && projection === null && routing === null && unsupported === null) return null;
  // (a) Context-budget risk is caller-supplied, not host-measured (ADR-0031
  // §7). Absent OR unrecognized → yellow, the conservative default that FIRES
  // the preflight rather than silently assuming green (fail-soft, no throw).
  const riskSupplied = RISK_LEVELS.has(riskLevel);
  const risk = riskSupplied ? riskLevel : 'yellow';
  // (b) archive_gate: the real projected gate when we have one; otherwise a
  // synthesized sentinel — 'unsupported_kind' when an unmodelable workflow was
  // supplied (honest), 'absent' when nothing was. Runtime genuinely cannot read
  // an unsupported workflow's archive readiness, so the DECISION still falls
  // back to budget + routing; only the REPORT distinguishes the two
  // non-projection states.
  const archiveGate = projection && projection.archive_gate
    ? projection.archive_gate
    : unsupported
      ? 'unsupported_kind'
      : 'absent';
  // (c) Routing is always available — in the projection when present, standalone otherwise.
  const routingRecommendation = (projection && projection.routing_recommendation) || stringOrNull(routing) || null;
  let recommendedSession;
  let reason;
  if (risk === 'red') {
    recommendedSession = 'fresh_or_resumed';
    reason = 'context budget risk is red — hand off to a fresh session regardless of archive-gate state';
  } else if (risk === 'green') {
    recommendedSession = 'current_or_resumed';
    reason = 'context budget risk is green — continue in the current session';
  } else if (archiveGate === 'ready_to_archive') {
    recommendedSession = 'fresh_or_resumed';
    reason = 'context budget risk is yellow and the active workflow is ready to archive — a clean session seam';
  } else {
    recommendedSession = 'current_or_resumed';
    if (archiveGate === 'unsupported_kind') {
      reason = `context budget risk is yellow and an active workflow projection of unsupported kind '${unsupported}' was supplied — runtime models only ${[...VALID_WORKFLOW_KINDS].join(', ')} and cannot read its archive readiness; continue from context budget + routing`;
    } else if (archiveGate === 'absent') {
      reason = 'context budget risk is yellow with no active workflow projection — continue, watching the budget';
    } else {
      reason = 'context budget risk is yellow and the active workflow is mid-flight — continue rather than fragment it';
    }
  }
  const result = {
    state: 'session_preflight',
    recommended_session: recommendedSession,
    reason,
    context_risk: risk,
    context_risk_supplied: riskSupplied,
    archive_gate: archiveGate,
    archive_gate_report: archiveGateReport(archiveGate, unsupported),
    routing_recommendation: routingRecommendation,
    // Concrete next command when handing off — the routing recommendation IS
    // the command to start/resume the next session's work (ADR-0031 output).
    next_command: recommendedSession === 'fresh_or_resumed' ? routingRecommendation : null,
    workflow: projection
      ? {
          kind: projection.workflow_kind,
          id: projection.workflow_id,
          path: projection.workflow_path,
          phase: projection.phase,
          next_action: projection.next_action,
          checkpoint: projection.checkpoint,
        }
      : null,
    limits: [
      'Context budget risk is caller-supplied, not host-measured (ADR-0031 §7); an absent or unrecognized risk is treated as yellow.',
      'Archive readiness is a pure-evaluator REPORT, not an archive action — runtime is non-mutating (ADR-0024).',
    ],
  };
  // ADR-0031 (runtime-unsupported-kind) — name the unmodelable kind explicitly
  // and record the boundary (modeling new kinds is a separate enablement
  // change) rather than silently presenting it as no-active-workflow.
  if (unsupported) {
    result.unsupported_workflow_kind = unsupported;
    result.limits.push(
      `An active workflow projection of kind '${unsupported}' was supplied, but runtime models only ${[...VALID_WORKFLOW_KINDS].join(', ')}; the continue-vs-fresh decision falls back to context budget + routing. Modeling new kinds (enablement) is a separate change, out of scope here.`,
    );
  }
  return result;
}

function archiveGateReport(gate, unsupportedKind = null) {
  switch (gate) {
    case 'ready_to_archive':
      return 'The active workflow reports ready_to_archive (all hard gates pass); it archives via the Stop hook after the terminal commit.';
    case 'blocked':
      return 'The active workflow is terminal-marked but blocked from archiving (a commit or an active child is still pending).';
    case 'not_terminal':
      return 'The active workflow has not reached its terminal marker yet (work in progress).';
    case 'unsupported_kind':
      return `An active workflow projection of unsupported kind${unsupportedKind ? ` '${unsupportedKind}'` : ''} was supplied; runtime models only ${[...VALID_WORKFLOW_KINDS].join(', ')} and cannot read this workflow's archive readiness.`;
    default:
      return 'No active workflow projection was supplied; archive readiness is not reported.';
  }
}

// ADR-0031 — normalize a raw bounded workflow projection. Fail-closed: returns
// { projection: null, error } when the input cannot be trusted, so the seam
// degrades to caller fields rather than interpreting a half-trusted projection.
// The schema is bounded: unknown keys are rejected, and every field except
// `checkpoint` is required and non-empty. `workflow_path` must be a
// repo-relative pointer (no POSIX/Windows absolute, drive-letter, UNC, or `..`).
export function normalizeProjection(raw) {
  if (raw === null || raw === undefined) return { projection: null, error: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { projection: null, error: 'workflow projection must be a JSON object' };
  }
  const unknown = Object.keys(raw).filter((key) => !PROJECTION_FIELDS.has(key));
  if (unknown.length > 0) {
    return { projection: null, error: `workflow projection has unknown field(s): ${unknown.join(', ')}` };
  }
  if (!VALID_WORKFLOW_KINDS.has(raw.workflow_kind)) {
    // ADR-0031 (runtime-unsupported-kind) — surface the rejected kind as a
    // typed signal so the session preflight can report an HONEST "active
    // workflow of unsupported kind" instead of silently degrading to the
    // no-active-workflow path. Only a real, non-empty kind name qualifies; a
    // missing/empty/non-string kind is a malformed projection, not an
    // unsupported one, so it leaves unsupportedKind null and keeps the prior
    // absent behavior.
    const trimmedKind =
      typeof raw.workflow_kind === 'string' && raw.workflow_kind.trim() !== ''
        ? raw.workflow_kind.trim()
        : null;
    // A whitespace-padded SUPPORTED kind stays a plain malformed projection
    // (the bounded schema does not trim-and-accept), and it must not surface
    // as an unsupported kind — that report would contradict its own
    // supported-kind list ("unsupported kind 'founder'" next to a list
    // naming founder).
    const rejectedKind =
      trimmedKind && !VALID_WORKFLOW_KINDS.has(trimmedKind) ? trimmedKind : null;
    return {
      projection: null,
      error: `workflow projection workflow_kind must be one of ${[...VALID_WORKFLOW_KINDS].join(', ')}`,
      unsupportedKind: rejectedKind,
      // Preserve the rejected projection's own routing so the honest fallback
      // ('continue from context budget + routing') is literal. Persona ok-case
      // wiring carries routing only inside the projection file (it does not
      // also pass --routing-recommendation standalone), so dropping it here
      // would leave a fresh handoff with no next_command.
      unsupportedRouting: stringOrNull(raw.routing_recommendation),
    };
  }
  if (!VALID_ARCHIVE_GATES.has(raw.archive_gate)) {
    return {
      projection: null,
      error: `workflow projection archive_gate must be one of ${[...VALID_ARCHIVE_GATES].join(', ')}`,
    };
  }
  const out = { workflow_kind: raw.workflow_kind, archive_gate: raw.archive_gate };
  for (const field of PROJECTION_REQUIRED_STRINGS) {
    const value = stringOrNull(raw[field]);
    if (!value) {
      return { projection: null, error: `workflow projection ${field} must be a non-empty string` };
    }
    out[field] = value;
  }
  if (isOutOfRepoPointer(out.workflow_path)) {
    return {
      projection: null,
      error: 'workflow projection workflow_path must be a repo-relative pointer (no absolute path, drive letter, UNC, or ..)',
    };
  }
  out.checkpoint = stringOrNull(raw.checkpoint); // the only optional field
  return { projection: out, error: null };
}

function isOutOfRepoPointer(value) {
  if (isAbsolute(value)) return true; // POSIX /x and the platform-native form
  if (/^[a-zA-Z]:/.test(value)) return true; // Windows drive letter (C:\ / C:/)
  if (/^[\\/]/.test(value)) return true; // leading slash/backslash incl. UNC \\server
  if (value.split(/[\\/]/).includes('..')) return true; // traversal, either separator
  return false;
}

function stringOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function freshnessHandoffGuidance({ runId, stale, sourceFreshness }) {
  if (sourceFreshness.status === 'stale') {
    return {
      state: 'capture_new_context',
      recommended_session: 'fresh_or_resumed',
      reason: sourceFreshness.reason,
      recommended_action: 'Capture a new runtime:context artifact from the current checkout before relying on this handoff.',
      commands: [
        'runtime:context capture --summary "<current state>" --risk yellow --next-action "<next step>"',
        'runtime:context status --latest',
      ],
    };
  }
  if (stale === true) {
    return {
      state: 'capture_new_context',
      recommended_session: 'fresh_or_resumed',
      reason: 'handoff artifact age exceeds the configured stale threshold',
      recommended_action: 'Capture a new runtime:context artifact before substantial follow-up work.',
      commands: [
        'runtime:context capture --summary "<current state>" --risk yellow --next-action "<next step>"',
        'runtime:context status --latest',
      ],
    };
  }
  if (sourceFreshness.status === 'dirty_artifact') {
    return {
      state: 'capture_after_source_settled',
      recommended_session: 'fresh_or_resumed',
      reason: sourceFreshness.reason,
      recommended_action: 'Capture a new runtime:context artifact from a clean or intentionally documented source state before relying on this handoff.',
      commands: [
        'runtime:context capture --summary "<current state>" --risk yellow --next-action "<next step>"',
        'runtime:context status --latest',
      ],
    };
  }
  if (sourceFreshness.status === 'unknown') {
    return {
      state: 'inspect_context',
      recommended_session: 'fresh_or_resumed',
      reason: sourceFreshness.reason,
      recommended_action: 'Inspect the current checkout and capture a fresh runtime:context artifact if the source state cannot be verified.',
      commands: [
        'runtime:context capture --summary "<current state>" --risk yellow --next-action "<next step>"',
      ],
    };
  }
  if (sourceFreshness.current_dirty === true) {
    return {
      state: 'capture_after_source_settled',
      recommended_session: 'fresh_or_resumed',
      reason: 'current git commit matches the handoff, but the current worktree has uncommitted changes',
      recommended_action: 'Finish, commit, or intentionally document the dirty worktree before using this handoff as the next-session source of truth.',
      commands: [
        'runtime:context capture --summary "<current state>" --risk yellow --next-action "<next step>"',
      ],
    };
  }
  return {
    state: 'reuse_handoff',
    recommended_session: 'current_or_resumed',
    reason: 'handoff source and age are within the configured freshness checks',
    recommended_action: 'Reuse this handoff for small follow-up work, or start a resumed session with the stored next-session prompt for larger work.',
    commands: [
      `runtime:context status --run-id ${runId}`,
    ],
  };
}

function artifactTimestampMs(artifact, fallbackRunId) {
  for (const value of [artifact.updated_at, artifact.created_at]) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return runIdTimestampMs(fallbackRunId);
}

function runIdTimestampMs(runId) {
  const match = String(runId ?? '').match(/^context-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{6}$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatHandoffLookup(handoff) {
  const selected = handoff.selected_at ?? 'unknown';
  const age = handoff.age_minutes === null ? 'unknown' : `${handoff.age_minutes} minutes`;
  const lines = [
    `- mode: ${handoff.mode}`,
    `- latest: ${handoff.latest}`,
    `- selected_at: ${selected}`,
    `- age: ${age}`,
    `- stale: ${handoff.stale}`,
    `- stale_after_ms: ${handoff.stale_after_ms}`,
    `- skipped_invalid: ${handoff.skipped_invalid}`,
  ];
  if (handoff.source_freshness) {
    lines.push(...formatSourceFreshness(handoff.source_freshness));
  }
  if (handoff.guidance) {
    lines.push(
      `handoff guidance: ${handoff.guidance.state}`,
      `- recommended_session: ${handoff.guidance.recommended_session}`,
      `- reason: ${handoff.guidance.reason}`,
      `- recommended_action: ${handoff.guidance.recommended_action}`,
    );
    if (handoff.guidance.commands?.length) {
      lines.push('- commands:');
      for (const command of handoff.guidance.commands) lines.push(`  - ${command}`);
    }
  }
  return lines.join('\n');
}

function contextBudgetThresholds() {
  return {
    green_below_percent: CONTEXT_BUDGET_THRESHOLDS.yellowAt * 100,
    yellow_from_percent: CONTEXT_BUDGET_THRESHOLDS.yellowAt * 100,
    red_from_percent: CONTEXT_BUDGET_THRESHOLDS.redAt * 100,
  };
}

function formatContextBudget(budget) {
  if (budget.status !== 'observed') {
    return `- status: ${budget.status}`;
  }
  const overBudget = budget.over_budget_tokens > 0
    ? `, over budget ${budget.over_budget_tokens}`
    : '';
  return `- ${budget.used_percent}% used (${budget.used_tokens}/${budget.token_budget} tokens, remaining ${budget.remaining_tokens}${overBudget})`;
}

function roundOne(value) {
  return Math.round(value * 10) / 10;
}

function roundFour(value) {
  return Math.round(value * 10000) / 10000;
}

function validateRunId(runId) {
  if (!RUN_ID_RE.test(runId)) {
    throw new Error('Invalid --run-id; expected context-YYYYMMDDTHHMMSSZ-abcdef');
  }
  return runId;
}

function makeRunId(now) {
  const stamp = toIso(now).replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `context-${stamp}-${randomBytes(3).toString('hex')}`;
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// Second-precision UTC instant — the session-capture schema timestamp patterns
// (contract §3) carry no milliseconds, so the staging writer must not emit them.
function toIsoSeconds(value) {
  return toIso(value).replace(/\.\d{3}Z$/, 'Z');
}

function contextRoot(repoRoot) {
  return resolve(repoRoot, '.agentic-plugins', 'runs', 'context');
}

function contextRunDir(repoRoot, runId) {
  return resolve(contextRoot(repoRoot), validateRunId(runId));
}

function contextFile(repoRoot, runId) {
  return resolve(contextRunDir(repoRoot, runId), 'context.json');
}

function pointer(repoRoot, path) {
  const rel = relative(repoRoot, path).split(sep).join('/');
  return rel || basename(path);
}

async function assertInside(root, candidate) {
  assertInsideSync(root, candidate, `Artifact path escapes context root: ${candidate}`);
}

function assertInsideSync(root, candidate, message) {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const rel = relative(rootPath, candidatePath);
  if (rel.startsWith('..') || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(message);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureTrailingNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function preview(text) {
  const trimmed = text.trim();
  if (trimmed.length <= REPORT_PREVIEW_LIMIT) return trimmed;
  return `${trimmed.slice(0, REPORT_PREVIEW_LIMIT)}...`;
}

// Raw-argv hook-grade classification, shared by main()'s parse-failure path
// and the outer .catch backstop (plan-verify peer: two classification sites
// must not drift). A flag VALUE colliding with these tokens misclassifies
// toward silent-exit-0 — the conservative side for a hook path.
function isHookGradeArgv(argv) {
  return argv.includes('--hook-grade')
    || argv.includes('publish-session')
    || (argv.includes('entry-brief') && argv.includes('session-start-hook'));
}

async function main() {
  const argv = process.argv.slice(2);
  // ADR-0044 §9 output-mode split, made explicit: operator invocations stay on
  // the reporter path (stdout report, exit 1 on error) while the hook/sidecar
  // modes are fail-closed silent: exit 0 always, nothing on stdout, at most
  // ONE stderr line (the notify.mjs emit discipline). note opts in via
  // --hook-grade; publish-session is hook-grade BY COMMAND (the publisher
  // path has no operator reporter mode, contract §1). Both are detected on
  // the RAW argv too, so even a parseArgs failure cannot make a hook
  // invocation exit non-zero or print a report.
  // Scan the WHOLE argv: parseArgs accepts options before the command, so
  // `--repo-root X publish-session` must still classify as hook-grade
  // (plan-verify peer reproduced it exiting 1). A flag VALUE that happens to
  // equal 'publish-session' misclassifies toward silent-exit-0 — the
  // conservative side for a hook path.
  const publisherInvocation = argv.includes('publish-session');
  const entryHookInvocation = argv.includes('entry-brief') && argv.includes('session-start-hook');
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (isHookGradeArgv(argv)) {
      const label = publisherInvocation ? 'publish-session' : entryHookInvocation ? 'entry-brief' : 'note';
      process.stderr.write(`runtime:context: ${label} failed at args: ${truncateReason(error?.message)}\n`);
      return;
    }
    throw error;
  }
  // Hook-grade is classified BEFORE --help: `note --hook-grade --help` must
  // not print help to stdout (parse already refuses the combination; this
  // ordering is the belt for any future flag that slips past it).
  if (options.hookGrade === true || options.command === 'publish-session'
    || (options.command === 'entry-brief' && options.surface === 'session-start-hook')) {
    try {
      const report = await runContext(options);
      // A skip is silent — the single stderr line is reserved for failures.
      // ADR-0045 §2.2 sensor-output exception: the entry brief's single
      // marker-paired line is the hook surface's deliberate stdout channel;
      // a gated-off, empty-silent, or skipped run prints nothing.
      if (report?.emitted_line) process.stdout.write(`${report.emitted_line}\n`);
    } catch (error) {
      process.stderr.write(`runtime:context: ${options.command} failed: ${truncateReason(error?.message)}\n`);
    }
    return;
  }
  if (options.help) {
    console.log(helpText());
    return;
  }
  const report = await runContext(options);
  if (options.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatText(report));
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    // Backstop for the hook-grade contract: a failure that escapes main()
    // must still exit 0 with no report when --hook-grade was requested or
    // the command is the intrinsically hook-grade publish-session.
    if (isHookGradeArgv(process.argv)) {
      process.exitCode = 0;
      return;
    }
    console.error(`runtime:context: ${error.message}`);
    process.exitCode = 1;
  });
}
