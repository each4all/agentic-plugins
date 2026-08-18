#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { runCommand } from './doctor.mjs';
import {
  COMPAT_GAP_SCHEMA,
  COMPAT_SNAPSHOT_SCHEMA,
  projectGapFamily,
} from './lib/compat-artifacts.mjs';
import {
  ASSURANCE_RESULT_SCHEMA_VERSION,
  ASSURANCE_RESULT_STATUSES,
  isGrantId,
} from './lib/assurance-result.mjs';
import {
  buildAssuranceProbe,
  observeMachinePackages,
  resolveHostAssuranceFacts,
} from './lib/host-assurance-facts.mjs';
import {
  extractBaselineVersions,
  normalizeVersion,
  resolveHostParityBaseline,
  scanVersionTokens,
} from './lib/host-parity-baseline.mjs';
import { probeMachineHostState } from './lib/machine-probe.mjs';
import { RUNTIME_VERSION } from './version.mjs';

const VERSION = RUNTIME_VERSION;
// ADR-0053 §Decision 4 — the vocabulary lives in `lib/compat-artifacts.mjs`
// because the consumer needs it too and cannot import this file: state-readers
// -> compat -> doctor -> state-readers is a cycle.
const SNAPSHOT_SCHEMA = COMPAT_SNAPSHOT_SCHEMA;
// Families that PREDATE the assurance section. Enumerated rather than derived as
// "anything that is not current", because those are two different answers: a known
// older family is history (`legacy`), an unknown one is unread (`unreadable`).
const KNOWN_LEGACY_SNAPSHOT_SCHEMAS = Object.freeze(['runtime-compat-snapshot-1.0']);
const GAP_SCHEMA = COMPAT_GAP_SCHEMA;
const RELEASE_NOTES_SCHEMA = 'runtime-compat-release-notes-1.0';
const PLAN_SCHEMA = 'runtime-compat-plan-1.1';
const LATEST_SCHEMA = 'runtime-compat-latest-1.0';
const POLICY_SCHEMA = 'runtime-compat-policy-1.0';
const POLICY_ADR = 'ADR-0026';
const POLICY_ADR_POINTER = 'docs/adr/0026-runtime-compatibility-drift-and-release-notes.md';
const NOTIFICATION_WATCH_ADR = 'ADR-0047';
const NOTIFICATION_WATCH_ADR_POINTER = 'docs/adr/0047-notify-attention-gating-gc.md';
// ADR-0047 §5 — seeded standing notification watch. Standing means these rows
// are emitted on every plan run whether or not versions drifted — unlike the
// generic surface classifier, which only fires on newly ingested text — so the
// recorded notification gaps stay visible until resolved. A signal hit
// annotates the row and adds a review step; it never wires a mapping. Wiring a
// newly observed variant requires a source-verified payload and a dedicated
// follow-up decision (ADR-0030 discipline); until then the Codex shuttle's
// unknown-variant silent no-op is contractual.
const NOTIFICATION_WATCH_ROWS = [
  {
    id: 'codex-notify-payload-variants',
    host: 'codex',
    subject: 'Codex notify= payload variants beyond agent-turn-complete (especially approval/permission shapes)',
    baseline_behavior: 'receivers/codex-notify-shuttle.mjs silently no-ops on any payload type other than agent-turn-complete; no approval payload reaches notify= at the recorded baseline.',
    resolution_requires: 'A source-verified payload shape recorded in the host-parity baseline plus a dedicated follow-up decision before any shuttle mapping (ADR-0030).',
    signal_patterns: [
      /\bnotify\s*=/i,
      /\bnotif\w*\b[\s\S]{0,200}?\b(?:payload|variant|approval|permission|type)\b/i,
      /\b(?:payload|variant|approval|permission|type)\b[\s\S]{0,200}?\bnotif\w*\b/i,
    ],
  },
  {
    id: 'claude-notification-agent-types',
    host: 'claude',
    subject: 'Claude Notification hook agent_needs_input / agent_completed notification types (observed at 2.1.198)',
    baseline_behavior: 'The attention Notification sensor matches permission_prompt/idle_prompt and ignores the 2.1.198 agent_needs_input/agent_completed types; recorded in host-parity-baseline.md Version History (2026-07-04).',
    resolution_requires: 'A source-verified payload shape for the new notification types plus a dedicated follow-up decision before any sensor mapping (ADR-0030).',
    signal_patterns: [
      /\bagent_needs_input\b/i,
      /\bagent_completed\b/i,
      /\bnotification_type\b/i,
    ],
  },
];
const VALID_COMMANDS = new Set(['snapshot', 'check', 'ingest-release-notes', 'plan']);
const RUN_ID_RE = /^compat-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 60000;
const MAX_RELEASE_NOTES_BYTES = 1024 * 1024;
const MAX_RELEASE_NOTES_REDIRECTS = 3;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(SCRIPT_DIR);

export async function runCompat(options = {}) {
  const command = options.command ?? 'snapshot';
  if (!VALID_COMMANDS.has(command)) {
    throw new Error(`Unsupported compat command: ${command}`);
  }
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  if (command === 'snapshot') return createSnapshot({ ...options, repoRoot });
  if (command === 'check') return checkSnapshot({ ...options, repoRoot });
  if (command === 'ingest-release-notes') return ingestReleaseNotes({ ...options, repoRoot });
  return planCompatibility({ ...options, repoRoot });
}

export async function createSnapshot(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const now = options.now ?? new Date();
  const observedAt = toIso(now);
  const runId = options.runId ? validateRunId(options.runId) : makeRunId(now);
  const runDir = compatRunDir(repoRoot, runId);

  const runner = options.runner ?? runCommand;
  const timeoutMs = positiveInt(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, '--timeout-ms', MAX_TIMEOUT_MS);
  // GATHER BEFORE CREATING THE DIRECTORY (cross-host review). The run directory
  // used to be created first, so a runner that rejected — or a packaged read
  // that threw — left an EMPTY run behind. `inspectCompatRuns` counts a run
  // whose `snapshot.json` will not parse as malformed, and `malformed > 0`
  // blocks the WHOLE collection, so one failed probe poisoned every compat
  // consumer until an operator deleted the directory by hand.
  const [claude, codex] = await Promise.all([
    observeHost('claude', { repoRoot, runner, timeoutMs }),
    observeHost('codex', { repoRoot, runner, timeoutMs }),
  ]);
  const baseline = options.baseline ?? await loadBaselineVersions();
  const pluginVersions = await readPluginVersions(repoRoot);
  const assurance = await observeAssurance({ repoRoot, claude, codex, runner, timeoutMs, now, options });

  const snapshot = {
    schema_version: SNAPSHOT_SCHEMA,
    runtime_version: VERSION,
    run_id: runId,
    created_at: observedAt,
    updated_at: observedAt,
    repo_root_pointer: '.',
    hosts: { claude, codex },
    remembered_baseline: baseline,
    plugin_versions: pluginVersions,
    // ADR-0053 §Decision 4 — FROZEN HERE, and this is the whole point of putting
    // the evaluation in `snapshot` rather than in `check`.
    //
    // A remembered snapshot is never retroactively granted assurance. If `check`
    // evaluated against the THEN-INSTALLED record, re-running it on a six-week-old
    // snapshot after a release shipped a grant would turn that old observation
    // into `covered` — coverage awarded to a machine state nobody reviewed,
    // arriving through the one command an operator runs casually.
    //
    // It also keeps ONE moment in one artifact: drift is computed from the host
    // versions recorded here, so an assurance verdict computed at a different
    // moment would put two observations of two machines into one file. `doctor`
    // states the same rule for its own two sections and computes the observed
    // pair once for both.
    host_assurance: assurance,
    policy: compatibilityPolicy(),
    artifacts: [],
    limits: compatLimits(),
  };
  await mkdir(resolve(runDir, 'release-notes'), { recursive: true });
  const snapshotPath = resolve(runDir, 'snapshot.json');
  await writeJson(snapshotPath, snapshot);
  await writeLatest(repoRoot, {
    run_id: runId,
    snapshot_pointer: pointer(repoRoot, snapshotPath),
    updated_at: observedAt,
  });

  return {
    command: 'snapshot',
    version: VERSION,
    run_id: runId,
    status: 'snapshotted',
    snapshot_pointer: pointer(repoRoot, snapshotPath),
    hosts: hostSummary(snapshot.hosts),
    remembered_baseline: baseline,
    plugin_versions: pluginVersions,
    policy: snapshot.policy,
    next_steps: [
      `runtime:compat check --run-id ${runId}`,
      `runtime:compat ingest-release-notes --run-id ${runId} --release-notes-file <path>`,
    ],
    limits: snapshot.limits,
  };
}

/**
 * OBSERVE the machine's assurance and freeze it into the snapshot.
 *
 * ⚠ THIS GRANTS NOTHING, and the boundary is ADR-0053 §Decision 2: `runtime:compat`
 * may assemble evidence; it may not grant acceptance. Every positive verdict here
 * comes from `matchAssurance` matching a HUMAN-authored grant that named this host
 * pair, reached only through the shared `evaluateAssurance` ladder. There is no
 * branch in this file that produces `covered`, and none that promotes a candidate
 * into an active grant — ADR-0054 §Decision 9 keeps the candidate-assembly half of
 * §Decision 2 a `may` and out of scope, so it is deliberately not built.
 *
 * WHY THE MACHINE PROBE AND NOT COMPAT'S OWN SIX COMMANDS. Membership needs the
 * installed-plugin listings, and `observePackages` reports a missing listing as
 * NON-authoritative. Measured on the shipped ladder: with no listing at all and a
 * grant that names the pair, the result is `blocked` carrying "Repair the
 * installed-plugin listing on claude and codex" — an instruction to repair a probe
 * compat never ran, and it would fire on exactly the day a grant first ships.
 *
 * ⚠ EVERY ENVIRONMENT INPUT IS THREADED, not defaulted (cross-host review).
 * `probeMachineHostState` otherwise reads the real home directory, the real
 * `process.env` and the real `CODEX_HOME`, so a test that injects only a runner
 * would still inspect the developer's own caches — hermetic by accident, and only
 * until someone's machine differs.
 *
 * The probe is skipped entirely when `assuranceProbe: false` is passed, which is
 * how a caller that already knows the answer (or a test pinning the ladder) avoids
 * paying for 16 host commands.
 */
async function observeAssurance({ repoRoot, claude, codex, runner, timeoutMs, now, options = {} }) {
  // The explicit override wins, and `null` is a legitimate override meaning "do
  // not observe" — distinguished from "not supplied" so a caller can suppress the
  // probe without the value being laundered into a default.
  if (options.hostAssurance !== undefined) return options.hostAssurance;

  const probe = buildAssuranceProbe({
    // compat's own probe statuses, expressed in the vocabulary the shared builder
    // expects. `observeHost` reports `available` when the command RAN at all, so
    // a version it could not parse is `null` here and step 6 of the ladder refuses
    // it rather than letting it arrive as a membership miss.
    // THE COMMAND RESULT DECIDES, never the presence of a parsed version.
    // `observeHost` fills `.version` from stdout OR stderr regardless of exit
    // status, so a `claude --version` that exits non-zero — or times out — after
    // printing version-shaped text used to arrive here as `available`, and the
    // ladder then permitted coverage from a probe that FAILED. ADR-0053
    // §Decision 3 puts an unreadable host probe in the integrity layer; a probe
    // that did not succeed is not a reading of the host (measured, ST5; doctor's
    // symmetric path already preserved the command status).
    claudeProbe: claude?.probes?.version?.ok ? 'available' : null,
    codexProbe: codex?.probes?.version?.ok ? 'available' : null,
    // RAW text, never `observed.version`. `extractSemver` has already dropped the
    // trailing components of a four-component version, and the ladder's truncation
    // guard is the thing that stops `1.2.3.4` reaching `covered` against a grant
    // for `1.2.3`.
    // NOT withheld here on failure, deliberately. `buildAssuranceProbe` already
    // drops the observed text when either probe is not `available`, and its own
    // note says why — "a failed `--version` carries stderr or an error message in
    // its text, so normalizing it would manufacture an observed version out of a
    // diagnostic". A second copy of that rule at this call site was written and
    // then removed during ST5: it made the two lines JOINTLY load-bearing, so
    // either could be deleted with a green suite, which is the shape of defect
    // this subtask exists to find rather than to add.
    claudeText: claude?.version_text ?? null,
    codexText: codex?.version_text ?? null,
  });

  let machine = null;
  let probeFault = null;
  if (options.assuranceProbe !== false) {
    try {
      machine = await probeMachineHostState({
        // NEUTRAL cwd — never the caller's repository (machine-bootstrap-contract §1.1).
        // `repoRoot` was passed here, which is the ONE call site of three that broke the
        // seam's stated invariant: `doctor.mjs` and `bootstrap.mjs` both pass `tmpdir()`.
        // A repo-local project-scoped plugin install would otherwise enter compat's
        // package facts and therefore its frozen assurance, so compat could describe a
        // machine state that doctor and cutover — the two that gate — cannot see.
        cwd: tmpdir(),
        runner,
        timeoutMs,
        ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
        ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
        ...(options.env === undefined ? {} : { env: options.env }),
      });
    } catch (error) {
      // A failed listing is NON-coverage, never a thrown snapshot. The ladder
      // already knows what to do with a missing observation; losing the whole
      // snapshot to it would be the atomicity defect this function was moved
      // above `mkdir` to avoid.
      probeFault = sanitizeLine(error?.message) ?? 'unknown error';
    }
  }

  const facts = await resolveHostAssuranceFacts({
    pluginRoot: options.pluginRoot ?? PLUGIN_ROOT,
    probe,
    packageObservation: machine === null ? null : observeMachinePackages(machine),
    // INJECTED. `assuranceRecordIssues` rejects a `reviewed_at` in the future, so
    // reading the clock here would let one artifact carry a `created_at` and a
    // coverage verdict decided on different days.
    today: (now instanceof Date ? now : new Date()).toISOString().slice(0, 10),
  });

  return {
    ...facts.assurance,
    // Recorded so a reader can tell "no grant named this pair" from "the listing
    // could not be taken", which have different operator actions even though both
    // are non-coverage.
    probe_fault: probeFault,
  };
}

export async function checkSnapshot(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const selected = await selectRun(repoRoot, options);
  const snapshot = await readJson(resolve(repoRoot, selected.snapshotPointer));
  const baseline = options.baseline ?? snapshot.remembered_baseline ?? await loadBaselineVersions();
  const releaseNotes = await readReleaseNoteBodies(repoRoot, selected.runId);
  const gap = buildGapAnalysis({ snapshot, baseline, releaseNotes, now: options.now ?? new Date() });
  const gapPath = resolve(compatRunDir(repoRoot, selected.runId), 'gap-analysis.json');
  await writeJson(gapPath, gap);

  return {
    command: 'check',
    version: VERSION,
    run_id: selected.runId,
    status: gap.overall.status,
    drift_class: gap.overall.drift_class,
    release_notes_required: gap.overall.release_notes_required,
    gap_pointer: pointer(repoRoot, gapPath),
    host_gaps: gap.host_gaps,
    release_notes: gap.release_notes,
    release_note_coverage: gap.release_note_coverage,
    policy: gap.policy,
    next_steps: gap.next_steps,
    limits: compatLimits(),
  };
}

export async function ingestReleaseNotes(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const selected = await selectRun(repoRoot, options);
  const files = normalizeList(options.releaseNotesFiles);
  const urls = normalizeList(options.releaseNotesUrls);
  if (files.length === 0 && urls.length === 0) {
    throw new Error('ingest-release-notes requires --release-notes-file or --release-notes-url');
  }
  const fetchUrls = Boolean(options.fetchReleaseNotesUrls);
  if (fetchUrls && urls.length === 0) {
    throw new Error('--fetch-release-notes-url requires --release-notes-url');
  }
  const timeoutMs = positiveInt(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, '--timeout-ms', MAX_TIMEOUT_MS);
  const runDir = compatRunDir(repoRoot, selected.runId);
  const notesDir = resolve(runDir, 'release-notes');
  await mkdir(notesDir, { recursive: true });
  const now = toIso(options.now ?? new Date());
  const entries = [];
  const urlFetcher = options.urlFetcher ?? fetchReleaseNotesUrl;
  // Load the existing index BEFORE assigning ids: the id sequence must
  // continue across invocations, or a second ingest of a same-named file
  // (e.g. CHANGELOG.md twice) reuses the same id and silently overwrites
  // the first stored body (Review ensemble finding).
  const indexPath = resolve(notesDir, 'index.json');
  const previous = await readJsonIfExists(indexPath, {
    schema_version: RELEASE_NOTES_SCHEMA,
    run_id: selected.runId,
    notes: [],
  });
  const previousNotes = previous.notes ?? [];
  const idOffset = previousNotes.length;

  for (const file of files) {
    const sourcePath = resolve(file);
    // The mirror of the baseline's hash defect, in the one place it also
    // bites: `copyFile` stores the ORIGINAL bytes while `sha256(sourceText)`
    // hashed a UTF-8 re-encoding of them, so the recorded digest did not
    // identify the stored file whenever the source was not valid UTF-8 — and
    // `Buffer.byteLength(sourceText)` reported the re-encoded length for the
    // same reason. (The URL branch below is NOT this shape and is left alone:
    // it writes `fetched.body` itself, so the digest and the stored bytes come
    // from the same string.)
    const sourceBytes = await readFile(sourcePath);
    const sourceText = sourceBytes.toString('utf8');
    if (!sourceText.trim()) throw new Error(`release notes file is empty: ${file}`);
    const id = noteId(sourcePath, idOffset + entries.length + 1);
    const target = resolve(notesDir, `${id}.md`);
    // Write the buffer that was HASHED, rather than re-reading the source.
    // `copyFile` opened the path a second time, so a source replaced between
    // the two reads recorded one file's digest beside another file's bytes —
    // 8 of 11 ingests under a deterministic swap fixture (cross-host review).
    // The bytes are already in hand; reopening bought nothing.
    await writeFile(target, sourceBytes);
    entries.push({
      id,
      kind: 'file',
      source: sourcePath,
      pointer: pointer(repoRoot, target),
      bytes: sourceBytes.byteLength,
      sha256: sha256(sourceBytes),
      status: 'stored',
    });
  }

  for (const url of urls) {
    if (!/^https?:\/\//i.test(url)) throw new Error('--release-notes-url must be http(s)');
    const id = noteId(url, idOffset + entries.length + 1);
    const metadataTarget = resolve(notesDir, `${id}.json`);
    if (fetchUrls) {
      const fetched = await urlFetcher(url, { timeoutMs });
      const contentTarget = resolve(notesDir, `${id}.md`);
      await writeFile(contentTarget, fetched.body);
      const metadata = {
        schema_version: RELEASE_NOTES_SCHEMA,
        id,
        kind: 'url',
        url,
        final_url: fetched.finalUrl,
        status: 'stored',
        fetched_at: now,
        content_type: fetched.contentType,
        content_pointer: pointer(repoRoot, contentTarget),
        bytes: Buffer.byteLength(fetched.body, 'utf8'),
        sha256: sha256(fetched.body),
      };
      await writeJson(metadataTarget, metadata);
      entries.push({
        id,
        kind: 'url',
        source: url,
        pointer: pointer(repoRoot, metadataTarget),
        content_pointer: pointer(repoRoot, contentTarget),
        bytes: metadata.bytes,
        sha256: metadata.sha256,
        status: 'stored',
        final_url: fetched.finalUrl,
      });
      continue;
    }
    const metadata = {
      schema_version: RELEASE_NOTES_SCHEMA,
      id,
      kind: 'url',
      url,
      status: 'not_fetched',
      reason: 'Network fetch is explicit follow-up scope; provide --release-notes-file for content-backed planning.',
      recorded_at: now,
    };
    await writeJson(metadataTarget, metadata);
    entries.push({
      id,
      kind: 'url',
      source: url,
      pointer: pointer(repoRoot, metadataTarget),
      bytes: 0,
      sha256: null,
      status: 'not_fetched',
    });
  }

  const index = {
    schema_version: RELEASE_NOTES_SCHEMA,
    run_id: selected.runId,
    updated_at: now,
    policy: compatibilityPolicy(),
    notes: [...previousNotes, ...entries],
    limits: [
      'Release note ingestion stores explicit files, URL pointers, or explicitly fetched URL content.',
      'Network fetching is not automatic; --fetch-release-notes-url is required for URL content.',
      'Raw release-note text is stored as an artifact and not printed into the main report.',
    ],
  };
  await writeJson(indexPath, index);

  return {
    command: 'ingest-release-notes',
    version: VERSION,
    run_id: selected.runId,
    status: 'ingested',
    release_notes_pointer: pointer(repoRoot, indexPath),
    policy: index.policy,
    notes: entries.map(({ id, kind, source, pointer: notePointer, content_pointer: contentPointer, status }) => ({
      id,
      kind,
      source,
      pointer: notePointer,
      content_pointer: contentPointer ?? null,
      status,
    })),
    next_steps: [
      `runtime:compat check --run-id ${selected.runId}`,
      `runtime:compat plan --run-id ${selected.runId}`,
    ],
    limits: index.limits,
  };
}

export async function planCompatibility(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const selected = await selectRun(repoRoot, options);
  const gapPath = resolve(compatRunDir(repoRoot, selected.runId), 'gap-analysis.json');
  const snapshot = await readJson(resolve(repoRoot, selected.snapshotPointer));
  const releaseNotes = await readReleaseNoteBodies(repoRoot, selected.runId);
  const gap = buildGapAnalysis({
    snapshot,
    baseline: options.baseline ?? snapshot.remembered_baseline ?? await loadBaselineVersions(),
    releaseNotes,
    now: options.now ?? new Date(),
  });
  await writeJson(gapPath, gap);
  const surfaces = classifySurfaces({ gap, releaseNotes });
  const notificationWatch = buildNotificationWatch(releaseNotes);
  // Actionability is explicit so shared readers can distinguish an
  // informational standing-watch plan (no drift, no surfaces, no signals)
  // from a plan that carries real update work — without it, running plan on
  // a current host pair would flip doctor/cutover compat state to
  // plan_ready/needs_attention forever (Review ensemble finding).
  // A baseline that could not be resolved is terminal for planning too. `check`
  // already refuses to call it drift; `plan` went on to emit `status: planned`,
  // `actionable: true`, and compatibility work steps for a comparison that
  // never happened (cross-host review, reproduced). Making the status terminal
  // in one command and not the next is how the reader one layer up ended up
  // with `plan_ready` over a broken package.
  const baselineUnusable = gap.overall.status === 'baseline_unusable';
  // The assurance-integrity states are terminal for planning for exactly the
  // reason `baseline_unusable` is: a compatibility plan is work to do about a
  // comparison, and when the comparison could not be made or its verdict cannot
  // be read, emitting `planned` with update steps hands the operator work that
  // cannot fix what is wrong. `legacy_unassured` joins them because its only
  // honest next step is a FRESH snapshot — planning off a remembered one is how
  // a stale observation would keep producing current-looking work.
  const assuranceTerminal = gap.overall.status === 'assurance_blocked'
    ? 'blocked_assurance'
    : gap.overall.status === 'legacy_unassured'
      ? 'blocked_legacy_unassured'
      : null;
  const terminal = baselineUnusable || assuranceTerminal !== null;
  // ⚠ A REVIEWED DRIFT IS NOT OUTSTANDING WORK, and this is where that belongs
  // rather than in the reader. An `assured` gap is drift a human examined and
  // accepted, and the release-note requirement exists to make an operator
  // justify drift — a grant naming this pair already did both. Leaving them in
  // the actionability test made every assured host emit an actionable plan, so
  // its first `compat plan` run demoted it permanently.
  //
  // `surfaces` and a detected notification-watch signal are NOT dropped: a grant
  // covers the host pair a reviewer looked at, not a payload variant observed
  // afterwards, so those stay outstanding work on a covered host.
  const driftReviewed = gap.overall.status === 'assured';
  // `classifySurfaces` derives `host-version-baseline` from `drift_class` alone,
  // so on a reviewed drift that entry is the SAME fact the grant covers. It stays
  // in `affected_surfaces` — it is genuinely an affected surface and the plan
  // should say so — but it must not be what makes the plan actionable, or the
  // drift re-enters actionability through the surface list after being removed
  // from the drift test directly. Measured: without this the assured host still
  // emitted `actionable: true`.
  const unreviewedSurfaces = driftReviewed
    ? surfaces.filter((surface) => surface !== 'host-version-baseline')
    : surfaces;
  const actionable = !terminal
    && ((!driftReviewed && gap.overall.release_notes_required)
      || (!driftReviewed && gap.overall.drift_class !== 'none')
      || unreviewedSurfaces.length > 0
      || notificationWatch.some((row) => row.signal_detected));
  const plan = {
    schema_version: PLAN_SCHEMA,
    runtime_version: VERSION,
    run_id: selected.runId,
    created_at: toIso(options.now ?? new Date()),
    status: baselineUnusable
      ? 'blocked_baseline_unusable'
      : assuranceTerminal !== null
        ? assuranceTerminal
        // Same rule as `actionable` above, and it has to be here too: the plan's
        // STATUS is what the reader projects, so narrowing only actionability
        // left an assured host reporting `blocked_release_notes_required` — told
        // to go fetch notes justifying a drift a reviewer had already accepted.
        : (!driftReviewed && gap.overall.release_notes_required)
          ? 'blocked_release_notes_required'
          : 'planned',
    actionable,
    gap_pointer: pointer(repoRoot, gapPath),
    affected_surfaces: surfaces,
    notification_watch: notificationWatch,
    recommended_sequence: buildRecommendedSequence({ gap, surfaces, releaseNotes, notificationWatch }),
    policy: compatibilityPolicy(),
    limits: [
      'Compatibility plans are advisory and do not mutate host CLIs, host config, or plugin artifacts.',
      'Release-note URLs without ingested file content are pointers only and cannot support detailed gap planning.',
      'Doctor should consume compatibility status later; this command owns durable compat artifacts.',
    ],
  };
  const planPath = resolve(compatRunDir(repoRoot, selected.runId), 'update-plan.md');
  await writeFile(planPath, renderPlanMarkdown(plan));
  await writeJson(resolve(compatRunDir(repoRoot, selected.runId), 'plan.json'), plan);

  return {
    command: 'plan',
    version: VERSION,
    run_id: selected.runId,
    status: plan.status,
    actionable,
    plan_pointer: pointer(repoRoot, planPath),
    affected_surfaces: surfaces,
    notification_watch: notificationWatch,
    recommended_sequence: plan.recommended_sequence,
    policy: plan.policy,
    next_steps: nextStepsForPlan(plan),
    limits: plan.limits,
  };
}

async function observeHost(host, { repoRoot, runner, timeoutMs }) {
  const version = await runner(host, ['--version'], { cwd: repoRoot, timeoutMs });
  const help = await runner(host, ['--help'], { cwd: repoRoot, timeoutMs });
  const pluginHelp = await runner(host, ['plugin', '--help'], { cwd: repoRoot, timeoutMs });
  const versionText = firstLine(version.stdout) || firstLine(version.stderr);
  return {
    host,
    available: version.ok || version.exit_code !== null,
    version: extractSemver(versionText),
    version_text: sanitizeLine(versionText),
    probes: {
      version: summarizeCommand(version),
      help: summarizeCommand(help),
      plugin_help: summarizeCommand(pluginHelp),
    },
  };
}

function buildGapAnalysis({ snapshot, baseline, releaseNotes, now }) {
  // ADR-0051 §Decision 4 — a baseline that could not be read or parsed is a
  // hard stop, not an input to release-note planning. Folding it into
  // `no_baseline` produced `release_notes_required` and told the operator to
  // go fetch release notes, which cannot repair a broken package.
  //
  // DERIVED, not enumerated. Listing the failure statuses here made this the
  // third copy of the vocabulary, and a status the list had not learned yet
  // would have fallen through to the drift comparison as though a version had
  // been read. `null` is kept distinct on purpose: ADR-0051 §Decision 5 reads
  // pre-provenance snapshots as legacy rather than retro-filling them, so an
  // absent status is "unknown provenance", not "unusable".
  const baselineStatus = baseline?.provenance?.status ?? null;
  const baselineUnusable = baselineStatus !== null && baselineStatus !== 'resolved';
  const hostGaps = ['claude', 'codex'].map((host) => {
    const observed = snapshot.hosts?.[host] ?? {};
    const baselineVersion = baseline?.[host]?.version ?? null;
    const observedVersion = observed.version ?? null;
    let status = 'matches';
    if (baselineUnusable) status = `baseline_${baselineStatus}`;
    else if (!observed.available) status = 'host_unavailable';
    else if (!baselineVersion) status = 'no_baseline';
    else if (!observedVersion) status = 'version_unknown';
    else if (observedVersion !== baselineVersion) status = 'version_changed';
    return {
      host,
      status,
      observed_version: observedVersion,
      baseline_version: baselineVersion,
      version_text: observed.version_text ?? null,
    };
  });
  const driftClass = classifyDrift(hostGaps, { baselineStatus });
  const releaseNoteCoverage = buildReleaseNoteCoverage({ hostGaps, releaseNotes });
  // The same fact, not a re-derivation from the string it produced. Round-
  // tripping through `drift_class` meant every new failure status needed a
  // matching entry in a second list — and `baseline-incomplete` shows why a
  // prefix test could not stand in for one: it starts with `baseline-` and is
  // NOT a broken baseline.
  const baselineBroken = baselineUnusable;
  const releaseNotesRequired = !baselineBroken
    && driftClass !== 'none'
    && (releaseNotes.content_backed_count === 0 || releaseNoteCoverage.missing_required_hosts.length > 0);
  // PROJECTED, never re-evaluated. The verdict was frozen when the snapshot was
  // taken; reading the installed record again here is the retroactive-assurance
  // path §Decision 4 forbids.
  const assurance = projectSnapshotAssurance(snapshot);
  const overallStatus = readinessStatus({ baselineBroken, assurance, releaseNotesRequired, driftClass });
  return {
    schema_version: GAP_SCHEMA,
    runtime_version: VERSION,
    run_id: snapshot.run_id,
    created_at: toIso(now),
    updated_at: toIso(now),
    overall: {
      status: overallStatus,
      drift_class: driftClass,
      release_notes_required: releaseNotesRequired,
      // The WHOLE evidence object, not four scalars (cross-host review). Dropping
      // `next_action` would strip `assurance_blocked` of the only line saying how
      // to repair it — the same defect §Decision 4 removed from the baseline
      // status itself — and a consumer that must later gate on this fact needs the
      // recorded evidence, not a status string it would have to re-derive.
      assurance: assurance.state === 'legacy'
        ? null
        : assurance.evidence,
      assurance_state: assurance.state,
    },
    host_gaps: hostGaps,
    release_notes: summarizeReleaseNotes(releaseNotes),
    release_note_coverage: releaseNoteCoverage,
    policy: compatibilityPolicy(),
    // A broken baseline gets a repair step, not a planning step. `overall`
    // already refuses to call this drift; leaving the next step as
    // `runtime:compat plan` handed the operator an action that cannot fix
    // what is wrong, which is the same misdirection §Decision 4 removed from
    // the status itself.
    next_steps: gapNextSteps({ overallStatus, baselineStatus, assurance, runId: snapshot.run_id }),
  };
}

function summarizeReleaseNotes(releaseNotes) {
  return {
    pointer: releaseNotes.pointer,
    count: releaseNotes.count,
    content_backed_count: releaseNotes.content_backed_count ?? 0,
    notes: (releaseNotes.notes ?? []).map((note) => ({
      id: note.id,
      kind: note.kind,
      source: note.source,
      pointer: note.pointer,
      content_pointer: note.content_pointer ?? null,
      status: note.status,
      bytes: note.bytes ?? 0,
      sha256: note.sha256 ?? null,
    })),
  };
}

function buildReleaseNoteCoverage({ hostGaps, releaseNotes }) {
  const noteAnalyses = releaseNotes.note_analyses ?? [];
  const hosts = {};
  for (const gap of hostGaps) {
    const required = gap.status === 'version_changed';
    // Exact match, and that is now CORRECT rather than accidental: both sides
    // speak one grammar. The scanner used to strip prerelease suffixes while
    // the observed version kept them, so a note naming `0.147.0-rc.1` did not
    // cover an install running it — an unsatisfiable demand, not a safe
    // refusal.
    //
    // A looser release-form comparison (a `0.147.0` note covering a
    // `0.147.0-rc.1` install) was written and then REMOVED: a mutation run
    // showed nothing exercised it, and there is no measurement saying hosts
    // publish that way. Failing closed on a genuinely different string is a
    // defensible refusal; relaxing it without evidence is not a fix.
    const coveringNotes = required
      ? noteAnalyses
        .filter((note) => note.hosts.includes(gap.host) && note.versions.includes(gap.observed_version))
        .map((note) => note.id)
      : [];
    hosts[gap.host] = {
      required,
      covered: !required || coveringNotes.length > 0,
      observed_version: gap.observed_version,
      baseline_version: gap.baseline_version,
      covering_notes: coveringNotes,
    };
  }
  const missingRequiredHosts = Object.entries(hosts)
    .filter(([, coverage]) => coverage.required && !coverage.covered)
    .map(([host]) => host);
  return {
    required: missingRequiredHosts.length > 0 || Object.values(hosts).some((coverage) => coverage.required),
    content_backed_count: releaseNotes.content_backed_count ?? 0,
    missing_required_hosts: missingRequiredHosts,
    hosts,
    rule: 'Changed host versions require content-backed release notes mentioning both the changed host and observed version, unless the accepted baseline has already been refreshed.',
  };
}

/**
 * The stored next step, per readiness state.
 *
 * Every state gets one. Silence is the wrong answer here for the same reason it
 * is wrong in the reader: a run with no next step reads as a run with nothing to
 * do, and three of these states are exactly the ones an operator must act on.
 */
function gapNextSteps({ overallStatus, baselineStatus, assurance, runId }) {
  if (overallStatus === 'baseline_unusable') {
    return [`Repair the packaged host-parity baseline (${baselineStatus}) — reinstall or update the runtime plugin; compat cannot compare host versions until it resolves.`];
  }
  if (overallStatus === 'assurance_blocked') {
    // The EVALUATOR's own instruction wherever it exists. It names the specific
    // repair — a corrupt package, a straddled read, an unreadable host probe —
    // and re-deriving a generic line here would discard the one field whose job
    // is telling those apart.
    const recorded = typeof assurance.evidence?.next_action === 'string' ? assurance.evidence.next_action : null;
    return [recorded ?? 'Re-run runtime:doctor and reinstall the runtime plugin — the recorded compatibility assurance result could not be read.'];
  }
  if (overallStatus === 'legacy_unassured') {
    return [`runtime:compat snapshot — this run predates the compatibility assurance record, and a remembered snapshot is never retroactively granted assurance (ADR-0053 §Decision 4). Take a fresh snapshot, then runtime:compat check.`];
  }
  if (overallStatus === 'release_notes_required') {
    return [`runtime:compat ingest-release-notes --run-id ${runId} --release-notes-file <path> or --release-notes-url <url> --fetch-release-notes-url`];
  }
  if (overallStatus === 'unassured') {
    return ['Assurance is granted by human review of this host pair against this installed code — not by a version match, an upgrade, or elapsed time. Until a release carries a grant naming this pair, readiness stays ungranted (ADR-0053 §Decision 5).'];
  }
  return [`runtime:compat plan --run-id ${runId}`];
}

/**
 * Read the assurance verdict the SNAPSHOT froze. FAIL-CLOSED.
 *
 * Four outcomes, and none of them re-runs the ladder:
 *
 *   no section          -> `legacy_unassured` — a snapshot taken before the
 *                          decision. It can never become covered; the operator
 *                          takes a FRESH snapshot, they do not re-check this one.
 *   unreadable section  -> `blocked` — a result this runtime does not read.
 *                          Upgrade; re-running check rewrites the same bytes.
 *   `covered` w/o grant  -> `blocked` — the producer cannot emit it, so the
 *                          artifact is corrupt or from a producer this reader
 *                          does not understand. Both are non-coverage.
 *   a producer status   -> carried verbatim.
 */
function projectSnapshotAssurance(snapshot) {
  // ⚠ THE SNAPSHOT FAMILY DECIDES FIRST, NEVER THE SECTION'S PRESENCE — the
  // exact rule `lib/compat-artifacts.mjs` already applies to the GAP artifact,
  // whose comment records why: "a `1.0` artifact carrying a hand-added assurance
  // block read as `readable`, so an edited legacy file could inject a `covered`
  // verdict into a plane whose whole purpose is that only a human grant produces
  // one". The READER side was fixed there and the PRODUCER side here was not, so
  // re-running `check` over a doctored snapshot minted a fresh, protected-looking
  // `1.1` gap saying `current` (measured, ST5).
  //
  // A pre-decision snapshot is history and history is `legacy` regardless of what
  // has been written into it (ADR-0053 §Decision 4 — remembered snapshots are
  // never retroactively granted assurance). An UNKNOWN future family is
  // `unreadable`, not legacy: a narrowing field this reader does not understand
  // is how absence of evidence becomes coverage.
  const family = snapshot?.schema_version ?? null;
  if (family !== SNAPSHOT_SCHEMA) {
    return KNOWN_LEGACY_SNAPSHOT_SCHEMAS.includes(family)
      ? { state: 'legacy', status: null, grant_id: null, evidence: null }
      : { state: 'unreadable', status: null, grant_id: null, evidence: { schema_version: family } };
  }
  const section = snapshot?.host_assurance;
  if (section === undefined || section === null) {
    return { state: 'legacy', status: null, grant_id: null, evidence: null };
  }
  const readable = section.schema_version === ASSURANCE_RESULT_SCHEMA_VERSION
    && ASSURANCE_RESULT_STATUSES.includes(section.status)
    && !(section.status === 'covered' && !isGrantId(section.evidence?.grant_id));
  if (!readable) {
    return { state: 'unreadable', status: null, grant_id: null, evidence: section };
  }
  return {
    state: 'readable',
    status: section.status,
    grant_id: section.evidence?.grant_id ?? null,
    evidence: section,
  };
}

/**
 * The readiness ladder (ADR-0053 §Decision 4). ORDERED, and the order is the
 * decision rather than a style.
 *
 * Integrity first (§Decision 3: negative and unknown beat positive at every
 * layer), then history, then coverage, then the planning states.
 *
 * ⚠ `current` NOW REQUIRES COVERAGE, and it is the one narrowing here. ADR-0053
 * §Decision 11 says it in one line — "a new reader against an old baseline or an
 * old recorded artifact yields unassured, and unassured blocks" — and ADR-0054
 * §Decision 6 names the consequence as the POINT of the rollout: R1 ships with
 * `grants: []`, so every host reads `unassured` and readiness blocks, which is
 * how the negative path gets exercised by the real gate on real machines instead
 * of by a simulation of it.
 *
 * ⚠ COVERAGE OUTRANKS THE RELEASE-NOTE REQUIREMENT, deliberately. The
 * requirement exists to make an operator justify drift with content-backed
 * evidence; a human grant naming this exact pair IS that justification, already
 * reviewed. Ordering it below would hand the operator homework a reviewer has
 * already done.
 *
 * DRIFT IS UNTOUCHED. `classifyDrift` keeps its whole vocabulary and a non-exact
 * host stays visibly `drifted` — §Decision 4 keeps drift as evidence and moves
 * only the readiness classification.
 */
function readinessStatus({ baselineBroken, assurance, releaseNotesRequired, driftClass }) {
  // Nothing was compared. Neither a readiness verdict nor a gap verdict is honest.
  if (baselineBroken) return 'baseline_unusable';
  // An unreadable frozen result is an integrity failure of THIS artifact, and it
  // is ordered above history because a snapshot that carries a section this
  // runtime cannot read is not a snapshot that predates the section.
  if (assurance.state === 'unreadable') return 'assurance_blocked';
  if (assurance.status === 'blocked') return 'assurance_blocked';
  // Readable, and it predates the decision. Never retroactively granted.
  if (assurance.state === 'legacy') return 'legacy_unassured';
  if (assurance.status === 'covered') return driftClass === 'none' ? 'current' : 'assured';
  if (releaseNotesRequired) return 'release_notes_required';
  // Reviewed by nobody. `gap_analysis_ready` keeps its meaning — there is drift
  // and a plan can be built — while a machine with no drift and no grant gets its
  // own state rather than borrowing `current`, which would be exactness standing
  // in for assurance.
  return driftClass === 'none' ? 'unassured' : 'gap_analysis_ready';
}

function classifyDrift(hostGaps, { baselineStatus = null } = {}) {
  // Ordered first: a baseline that could not be resolved is not a drift verdict
  // at all — nothing was compared — and it must not be describable as one.
  //
  // The class is DERIVED from the resolver's status rather than matched
  // against a list of two. The two it used to match were also mis-named:
  // `baseline_missing` produced `baseline-unreadable`, which is now a distinct
  // and different failure. Legacy artifacts keep whatever string they were
  // written with; nothing re-derives a stored drift class.
  if (baselineStatus !== null && baselineStatus !== 'resolved') return `baseline-${baselineStatus}`;
  if (hostGaps.some((gap) => gap.status === 'version_changed')) return 'host-version-changed';
  if (hostGaps.some((gap) => gap.status === 'host_unavailable')) return 'host-unavailable';
  if (hostGaps.some((gap) => gap.status === 'version_unknown' || gap.status === 'no_baseline')) return 'baseline-incomplete';
  return 'none';
}

function classifySurfaces({ gap, releaseNotes }) {
  const text = releaseNotes.combined_text.toLowerCase();
  const surfaces = new Set();
  if (gap.overall.drift_class !== 'none') surfaces.add('host-version-baseline');
  for (const surface of classifyReleaseNoteSurfaces(text)) surfaces.add(surface);
  return [...surfaces].sort();
}

function buildRecommendedSequence({ gap, surfaces, releaseNotes, notificationWatch }) {
  const sequence = [];
  sequence.push({
    step: 'refresh-baseline',
    reason: 'Update host parity/capability baselines from observed versions and official docs before changing runtime behavior.',
    required: gap.overall.drift_class !== 'none',
  });
  if (releaseNotes.content_backed_count === 0 && gap.overall.drift_class !== 'none') {
    sequence.push({
      step: 'ingest-release-notes',
      reason: 'Host versions changed but no content-backed release notes were ingested.',
      required: true,
    });
  }
  for (const surface of surfaces) {
    sequence.push({
      step: `review-${surface}`,
      reason: `Release-note or version drift may affect ${surface}.`,
      required: true,
    });
  }
  for (const row of notificationWatch ?? []) {
    if (!row.signal_detected) continue;
    sequence.push({
      step: `review-notification-watch-${row.id}`,
      reason: `Ingested release notes signal the standing notification watch row ${row.id}; verify the payload at the source before any mapping (${NOTIFICATION_WATCH_ADR} §5, ADR-0030).`,
      required: true,
    });
  }
  sequence.push({
    step: 'run-validation',
    reason: 'Run marketplace/version/artifact validation and relevant runtime tests after any compatibility update.',
    required: true,
  });
  return sequence;
}

function buildNotificationWatch(releaseNotes) {
  const noteAnalyses = releaseNotes.note_analyses ?? [];
  return NOTIFICATION_WATCH_ROWS.map((row) => {
    const signalNotes = noteAnalyses
      .filter((note) => (note.notification_watch ?? []).includes(row.id))
      .map((note) => note.id);
    return {
      id: row.id,
      host: row.host,
      subject: row.subject,
      status: 'open',
      standing: true,
      signal_detected: signalNotes.length > 0,
      signal_notes: signalNotes,
      baseline_behavior: row.baseline_behavior,
      resolution_requires: row.resolution_requires,
      policy: {
        adr: NOTIFICATION_WATCH_ADR,
        adr_pointer: NOTIFICATION_WATCH_ADR_POINTER,
        rule: 'Standing planning row evaluated on every plan run — never an automatic mapping; a source-verified payload and a dedicated follow-up decision are required before wiring a newly observed variant (ADR-0030).',
      },
    };
  });
}

function renderPlanMarkdown(plan) {
  const lines = [
    '# Runtime Compatibility Update Plan',
    '',
    `Run: ${plan.run_id}`,
    `Status: ${plan.status}`,
    `Actionable: ${plan.actionable ? 'yes' : 'no (informational — standing watch only)'}`,
    `Gap analysis: ${plan.gap_pointer}`,
    '',
    '## Affected Surfaces',
    '',
  ];
  if (plan.affected_surfaces.length === 0) {
    lines.push('- none detected');
  } else {
    for (const surface of plan.affected_surfaces) lines.push(`- ${surface}`);
  }
  lines.push('', `## Notification Watch (standing — ${NOTIFICATION_WATCH_ADR} §5)`, '');
  for (const row of plan.notification_watch ?? []) {
    lines.push(`- ${row.id} [${row.host}] ${row.signal_detected ? 'signal detected' : 'no new signal'}: ${row.subject}`);
    lines.push(`  - baseline behavior: ${row.baseline_behavior}`);
    lines.push(`  - resolution requires: ${row.resolution_requires}`);
    if (row.signal_detected) lines.push(`  - signal notes: ${row.signal_notes.join(', ')}`);
  }
  lines.push('', '## Recommended Sequence', '');
  for (const item of plan.recommended_sequence) {
    lines.push(`- ${item.step}: ${item.reason}`);
  }
  lines.push('', '## Limits', '');
  for (const limit of plan.limits) lines.push(`- ${limit}`);
  return `${lines.join('\n')}\n`;
}

function nextStepsForPlan(plan) {
  if (plan.status === 'blocked_baseline_unusable') {
    return ['Repair the packaged host-parity baseline — reinstall or update the runtime plugin; compat cannot compare host versions until it resolves.'];
  }
  if (plan.status === 'blocked_release_notes_required') {
    return [`runtime:compat ingest-release-notes --run-id ${plan.run_id} --release-notes-file <path>`];
  }
  return [
    'Review the compatibility update plan before implementation.',
    'Start non-trivial compatibility work with /engineer:start, $engineer:start, or /orchestrator:plan depending on scope.',
  ];
}

async function selectRun(repoRoot, options) {
  if (options.runId && options.latest) throw new Error('Use either --run-id or --latest, not both');
  if (options.runId) {
    const runId = validateRunId(options.runId);
    return {
      runId,
      snapshotPointer: pointer(repoRoot, resolve(compatRunDir(repoRoot, runId), 'snapshot.json')),
    };
  }
  if (options.latest) {
    const latest = await readJson(latestFile(repoRoot));
    return {
      runId: validateRunId(latest.run_id),
      snapshotPointer: latest.snapshot_pointer,
    };
  }
  throw new Error('command requires --run-id or --latest');
}

async function listReleaseNotes(repoRoot, runId) {
  const indexPath = resolve(compatRunDir(repoRoot, runId), 'release-notes', 'index.json');
  const index = await readJsonIfExists(indexPath, { notes: [] });
  return {
    pointer: pointer(repoRoot, indexPath),
    count: (index.notes ?? []).length,
    notes: index.notes ?? [],
  };
}

async function readReleaseNoteBodies(repoRoot, runId) {
  const releaseNotes = await listReleaseNotes(repoRoot, runId);
  const texts = [];
  const noteAnalyses = [];
  let contentBacked = 0;
  for (const note of releaseNotes.notes) {
    if (!isContentBackedReleaseNote(note)) continue;
    const bodyPointer = note.kind === 'url' ? note.content_pointer : note.pointer;
    if (!bodyPointer) continue;
    try {
      const text = await readFile(resolve(repoRoot, bodyPointer), 'utf8');
      texts.push(text);
      noteAnalyses.push(analyzeReleaseNote({ note, text }));
      contentBacked++;
    } catch {
      // Missing release-note bodies are treated as absent content.
    }
  }
  return {
    ...releaseNotes,
    content_backed_count: contentBacked,
    note_analyses: noteAnalyses,
    combined_text: texts.join('\n\n'),
  };
}

export function analyzeReleaseNote({ note, text }) {
  const body = String(text ?? '');
  const lower = body.toLowerCase();
  const hosts = [];
  if (/\bclaude(?:\s+code)?\b/i.test(body)) hosts.push('claude');
  if (/\bcodex(?:\s+cli)?\b/i.test(body)) hosts.push('codex');
  const versions = scanVersionTokens(body);
  const surfaces = classifyReleaseNoteSurfaces(lower);
  // Host-scoped signal detection: a note that names a host can only signal
  // that host's watch rows (a Claude note about notification_type must not
  // flag the Codex notify= row). A note naming no host stays conservative
  // and may signal any row — a hit is an annotation, never a mapping.
  const notificationWatch = NOTIFICATION_WATCH_ROWS
    .filter((row) => (hosts.length === 0 || hosts.includes(row.host))
      && row.signal_patterns.some((pattern) => pattern.test(body)))
    .map((row) => row.id);
  return {
    id: note.id,
    kind: note.kind,
    hosts: [...new Set(hosts)],
    versions,
    surfaces,
    notification_watch: notificationWatch,
  };
}

function classifyReleaseNoteSurfaces(lowerText) {
  const rules = [
    ['companions', /\b(companion|claude -p|codex exec|prompt-file|json envelope|stdout)\b/],
    ['hooks', /\b(hook|plugin_hooks|precompact|postcompact|sessionstart|stop)\b/],
    ['skills', /\b(skill|agent skill|skill\.md)\b/],
    ['subagents', /\b(subagents?|agent team|team mode|agents\.max_threads)\b/],
    ['plugin-management', /\b(plugin|marketplace|install|upgrade|update|uninstall)\b/],
    ['model-effort', /\b(model|effort|reasoning)\b/],
    ['sandbox-permissions', /\b(sandbox|approval|permission|network)\b/],
    ['auth', /\b(auth|login|credential|token)\b/],
    ['mcp', /\bmcp\b/],
    ['config', /\b(config|settings|toml|json)\b/],
  ];
  return rules
    .filter(([, pattern]) => pattern.test(lowerText))
    .map(([surface]) => surface);
}

function isContentBackedReleaseNote(note) {
  if (!note || note.status !== 'stored') return false;
  if (note.kind === 'file') return Boolean(note.pointer);
  if (note.kind === 'url') return Boolean(note.content_pointer);
  return false;
}

async function fetchReleaseNotesUrl(url, options = {}) {
  return fetchReleaseNotesUrlInternal(url, {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    redirectsRemaining: MAX_RELEASE_NOTES_REDIRECTS,
  });
}

async function fetchReleaseNotesUrlInternal(url, { timeoutMs, redirectsRemaining }) {
  const parsed = new URL(url);
  const client = parsed.protocol === 'http:' ? http : https;
  return new Promise((resolveFetch, rejectFetch) => {
    const request = client.get(parsed, {
      timeout: timeoutMs,
      headers: {
        'user-agent': `agentic-plugins-runtime-compat/${VERSION}`,
        accept: 'text/markdown,text/plain,text/html,application/json,*/*;q=0.5',
      },
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
        response.resume();
        if (redirectsRemaining <= 0) {
          rejectFetch(new Error(`release notes URL redirected too many times: ${url}`));
          return;
        }
        const nextUrl = new URL(location, parsed).toString();
        fetchReleaseNotesUrlInternal(nextUrl, { timeoutMs, redirectsRemaining: redirectsRemaining - 1 })
          .then(resolveFetch, rejectFetch);
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        rejectFetch(new Error(`release notes URL fetch failed with HTTP ${statusCode}: ${url}`));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RELEASE_NOTES_BYTES) {
          request.destroy(new Error(`release notes URL body exceeds ${MAX_RELEASE_NOTES_BYTES} bytes: ${url}`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (!body.trim()) {
          rejectFetch(new Error(`release notes URL returned an empty body: ${url}`));
          return;
        }
        resolveFetch({
          body,
          finalUrl: response.url ?? url,
          contentType: Array.isArray(response.headers['content-type'])
            ? response.headers['content-type'].join(', ')
            : response.headers['content-type'] ?? null,
        });
      });
    });
    request.on('timeout', () => {
      request.destroy(new Error(`release notes URL fetch timed out after ${timeoutMs}ms: ${url}`));
    });
    request.on('error', rejectFetch);
  });
}

async function readPluginVersions(repoRoot) {
  const manifestPath = resolve(repoRoot, '.release-please-manifest.json');
  try {
    const manifest = await readJson(manifestPath);
    return manifest;
  } catch {
    return {};
  }
}

// ADR-0051 — the packaged copy is the sole authority and the resolver owns the
// grammar. `baselineProvenance` travels with the value so a recorded snapshot
// says WHICH bytes produced it, not merely which path: two installs of the same
// runtime version carried different baselines in the incident behind ADR-0051.
async function loadBaselineVersions() {
  const resolved = await resolveHostParityBaseline({ pluginRoot: PLUGIN_ROOT });
  if (resolved.status !== 'resolved') {
    return {
      claude: { version: null },
      codex: { version: null },
      provenance: { ...resolved.provenance, status: resolved.status },
    };
  }
  return {
    ...resolved.versions,
    provenance: { ...resolved.provenance, status: resolved.status },
  };
}

export { extractBaselineVersions };

function summarizeCommand(result) {
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  return {
    ok: Boolean(result.ok),
    exit_code: result.exit_code ?? null,
    timed_out: Boolean(result.timed_out),
    error_code: result.error_code ?? null,
    stdout_bytes: Buffer.byteLength(stdout, 'utf8'),
    stderr_bytes: Buffer.byteLength(stderr, 'utf8'),
    stdout_sha256: stdout ? sha256(stdout) : null,
    stderr_sha256: stderr ? sha256(stderr) : null,
  };
}

function hostSummary(hosts) {
  return Object.fromEntries(Object.entries(hosts).map(([host, value]) => [
    host,
    {
      available: value.available,
      version: value.version,
      version_text: value.version_text,
    },
  ]));
}

function compatLimits() {
  return [
    'runtime:compat records host-version, release-note, and compatibility-assurance observation artifacts only; it does not install, update, authenticate, or mutate host CLIs.',
    'Compatibility assurance is GRANTED BY HUMAN REVIEW recorded in the packaged host-parity baseline (ADR-0053 §Decision 2). runtime:compat evaluates whether this machine is a member of an existing grant; it never creates, widens, or promotes one.',
    'The assurance verdict is frozen when the snapshot is taken. Re-running check on a remembered snapshot projects that frozen verdict and never re-evaluates it, so a snapshot is never retroactively granted assurance (ADR-0053 §Decision 4).',
    'Release-note URL fetch is not automatic. Provide --release-notes-file or explicit --release-notes-url with --fetch-release-notes-url for content-backed planning.',
    'Raw command help output and release-note bodies stay in artifacts; main-session output is limited to metadata, hashes, gaps, and pointers.',
  ];
}

function compatibilityPolicy() {
  return {
    schema_version: POLICY_SCHEMA,
    adr: POLICY_ADR,
    adr_pointer: POLICY_ADR_POINTER,
    evidence_model: 'explicit-file-or-url-pointer',
    fetch_boundary: 'Release-note URLs are not fetched unless --fetch-release-notes-url is supplied.',
    changed_version_rule: 'A changed host version requires content-backed release notes mentioning both the changed host and observed version unless the accepted baseline is intentionally refreshed.',
    mutation_boundary: 'runtime:compat is artifact-only and must not install, update, authenticate, mutate host config, or relax host permissions.',
  };
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
  const options = { releaseNotesFiles: [], releaseNotesUrls: [] };
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
      case '--timeout-ms':
        options.timeoutMs = positiveInt(requireValue(args, arg), arg, MAX_TIMEOUT_MS);
        break;
      case '--release-notes-file':
        options.releaseNotesFiles.push(requireValue(args, arg));
        break;
      case '--release-notes-url':
        options.releaseNotesUrls.push(requireValue(args, arg));
        break;
      case '--fetch-release-notes-url':
        options.fetchReleaseNotesUrls = true;
        break;
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  options.command = command ?? 'snapshot';
  return options;
}

export function formatText(report) {
  if (report.help) return helpText();
  const lines = [`runtime:compat ${report.version ?? VERSION} (${report.command})`];
  if (report.run_id) lines.push(`run: ${report.run_id}`);
  if (report.status) lines.push(`status: ${report.status}`);
  if (typeof report.actionable === 'boolean') lines.push(`actionable: ${report.actionable}`);
  if (report.drift_class) lines.push(`drift: ${report.drift_class}`);
  if (report.snapshot_pointer) lines.push(`snapshot: ${report.snapshot_pointer}`);
  if (report.gap_pointer) lines.push(`gap analysis: ${report.gap_pointer}`);
  if (report.release_notes_pointer) lines.push(`release notes: ${report.release_notes_pointer}`);
  if (report.plan_pointer) lines.push(`plan: ${report.plan_pointer}`);
  if (report.policy) {
    lines.push(`policy: ${report.policy.adr} (${report.policy.adr_pointer})`);
  }
  if (report.hosts) {
    lines.push('', 'hosts:');
    for (const [host, value] of Object.entries(report.hosts)) {
      lines.push(`- ${host}: available=${value.available}; version=${value.version ?? 'unknown'}; text=${value.version_text ?? ''}`);
    }
  }
  if (report.host_gaps?.length) {
    lines.push('', 'host gaps:');
    for (const gap of report.host_gaps) {
      lines.push(`- ${gap.host}: ${gap.status}; observed=${gap.observed_version ?? 'unknown'}; baseline=${gap.baseline_version ?? 'unknown'}`);
    }
  }
  if (report.release_note_coverage) {
    const coverage = report.release_note_coverage;
    lines.push('', 'release-note coverage:');
    lines.push(`- content-backed=${coverage.content_backed_count}; missing-required-hosts=${coverage.missing_required_hosts.join(',') || 'none'}`);
    for (const [host, hostCoverage] of Object.entries(coverage.hosts ?? {})) {
      lines.push(`- ${host}: required=${hostCoverage.required}; covered=${hostCoverage.covered}; observed=${hostCoverage.observed_version ?? 'unknown'}; notes=${hostCoverage.covering_notes.join(',') || 'none'}`);
    }
  }
  if (report.affected_surfaces?.length) {
    lines.push('', 'affected surfaces:');
    for (const surface of report.affected_surfaces) lines.push(`- ${surface}`);
  }
  if (report.notification_watch?.length) {
    lines.push('', 'notification watch (standing):');
    for (const row of report.notification_watch) {
      lines.push(`- ${row.id} [${row.host}]: ${row.signal_detected ? `signal detected (${row.signal_notes.join(',')})` : 'no new signal'}; ${row.subject}`);
    }
  }
  if (report.recommended_sequence?.length) {
    lines.push('', 'recommended sequence:');
    for (const item of report.recommended_sequence) lines.push(`- ${item.step}: ${item.reason}`);
  }
  if (report.next_steps?.length) {
    lines.push('', 'next steps:');
    for (const step of report.next_steps) lines.push(`- ${step}`);
  }
  if (report.limits?.length) {
    lines.push('', 'limits:');
    for (const limit of report.limits) lines.push(`- ${limit}`);
  }
  return lines.join('\n');
}

function helpText() {
  return `runtime:compat ${VERSION}

Usage:
  runtime:compat snapshot [--format text|json] [--timeout-ms <n>]
  runtime:compat check (--run-id <id>|--latest) [--format text|json]
  runtime:compat ingest-release-notes (--run-id <id>|--latest) --release-notes-file <path>
  runtime:compat ingest-release-notes (--run-id <id>|--latest) --release-notes-url <url> [--fetch-release-notes-url] [--timeout-ms <n>]
  runtime:compat plan (--run-id <id>|--latest) [--format text|json]

Records Claude Code and Codex CLI version snapshots under ${POLICY_ADR}, compares them to the remembered host-parity baseline, stores explicit release-note artifacts, and emits compatibility update plans. It does not fetch URLs by default; URL fetch requires --fetch-release-notes-url and never mutates host config or plugin state.`;
}

function validateRunId(value) {
  const text = String(value ?? '').trim();
  if (!RUN_ID_RE.test(text)) throw new Error('Invalid --run-id; expected compat-YYYYMMDDTHHMMSSZ-abcdef');
  return text;
}

function makeRunId(now = new Date()) {
  const stamp = toIso(now).replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `compat-${stamp}-${randomBytes(3).toString('hex')}`;
}

function compatRoot(repoRoot) {
  return resolve(repoRoot, '.agentic-plugins', 'runs', 'compat');
}

function compatRunDir(repoRoot, runId) {
  return resolve(compatRoot(repoRoot), validateRunId(runId));
}

function latestFile(repoRoot) {
  return resolve(compatRoot(repoRoot), 'latest.json');
}

async function writeLatest(repoRoot, metadata) {
  await mkdir(compatRoot(repoRoot), { recursive: true });
  await writeJson(latestFile(repoRoot), {
    schema_version: LATEST_SCHEMA,
    ...metadata,
  });
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readJsonIfExists(path, fallback) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function pointer(repoRoot, path) {
  const rel = path.startsWith(repoRoot) ? path.slice(repoRoot.length).replace(/^\/+/, '') : path;
  return rel || '.';
}

function firstLine(text) {
  return String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? '';
}

// `extractSemver` used to live here with its own regex. It stripped prerelease
// suffixes while the baseline resolver preserved them, and `buildGapAnalysis`
// compares the two against each other — so an install running EXACTLY the
// baselined `0.147.0-rc.1` reported `version_changed`. One normalizer, from
// the module that owns the grammar, is what removes that class of false drift.
function extractSemver(value) {
  return normalizeVersion(value);
}

function sanitizeLine(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
}

// Buffers hash as bytes; everything else keeps the previous string behavior.
// A caller that HAS the bytes must be able to hash them — coercing a Buffer
// through `String()` was what made a file's digest depend on a decode.
function sha256(value) {
  return createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid date');
  return date.toISOString();
}

function normalizeList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function noteId(value, index) {
  const slug = basename(String(value))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '') || `note-${index}`;
  return `${String(index).padStart(2, '0')}-${slug}`;
}

function positiveInt(value, label, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`);
  if (number > max) throw new Error(`${label} must be <= ${max}`);
  return number;
}

function requireValue(args, flag) {
  if (args.length === 0 || args[0].startsWith('-')) throw new Error(`${flag} requires a value`);
  return args.shift();
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(helpText());
      return;
    }
    const report = await runCompat(options);
    if (options.format === 'json') console.log(JSON.stringify(report, null, 2));
    else console.log(formatText(report));
  } catch (error) {
    console.error(`runtime:compat: ${error.message}`);
    process.exitCode = 1;
  }
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  await main();
}
