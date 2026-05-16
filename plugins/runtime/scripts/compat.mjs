#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCommand } from './doctor.mjs';
import { RUNTIME_VERSION } from './version.mjs';

const VERSION = RUNTIME_VERSION;
const SNAPSHOT_SCHEMA = 'runtime-compat-snapshot-1.0';
const GAP_SCHEMA = 'runtime-compat-gap-1.0';
const RELEASE_NOTES_SCHEMA = 'runtime-compat-release-notes-1.0';
const PLAN_SCHEMA = 'runtime-compat-plan-1.0';
const LATEST_SCHEMA = 'runtime-compat-latest-1.0';
const VALID_COMMANDS = new Set(['snapshot', 'check', 'ingest-release-notes', 'plan']);
const RUN_ID_RE = /^compat-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 60000;
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
  await mkdir(resolve(runDir, 'release-notes'), { recursive: true });

  const runner = options.runner ?? runCommand;
  const timeoutMs = positiveInt(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, '--timeout-ms', MAX_TIMEOUT_MS);
  const [claude, codex] = await Promise.all([
    observeHost('claude', { repoRoot, runner, timeoutMs }),
    observeHost('codex', { repoRoot, runner, timeoutMs }),
  ]);
  const baseline = options.baseline ?? await loadBaselineVersions();
  const pluginVersions = await readPluginVersions(repoRoot);

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
    artifacts: [],
    limits: compatLimits(),
  };
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
    next_steps: [
      `runtime:compat check --run-id ${runId}`,
      `runtime:compat ingest-release-notes --run-id ${runId} --release-notes-file <path>`,
    ],
    limits: snapshot.limits,
  };
}

export async function checkSnapshot(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const selected = await selectRun(repoRoot, options);
  const snapshot = await readJson(resolve(repoRoot, selected.snapshotPointer));
  const baseline = options.baseline ?? snapshot.remembered_baseline ?? await loadBaselineVersions();
  const releaseNotes = await listReleaseNotes(repoRoot, selected.runId);
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
  const runDir = compatRunDir(repoRoot, selected.runId);
  const notesDir = resolve(runDir, 'release-notes');
  await mkdir(notesDir, { recursive: true });
  const now = toIso(options.now ?? new Date());
  const entries = [];

  for (const file of files) {
    const sourcePath = resolve(file);
    const sourceText = await readFile(sourcePath, 'utf8');
    if (!sourceText.trim()) throw new Error(`release notes file is empty: ${file}`);
    const id = noteId(sourcePath, entries.length + 1);
    const target = resolve(notesDir, `${id}.md`);
    await copyFile(sourcePath, target);
    entries.push({
      id,
      kind: 'file',
      source: sourcePath,
      pointer: pointer(repoRoot, target),
      bytes: Buffer.byteLength(sourceText, 'utf8'),
      sha256: sha256(sourceText),
      status: 'stored',
    });
  }

  for (const url of urls) {
    if (!/^https?:\/\//i.test(url)) throw new Error('--release-notes-url must be http(s)');
    const id = noteId(url, entries.length + 1);
    const target = resolve(notesDir, `${id}.json`);
    const metadata = {
      schema_version: RELEASE_NOTES_SCHEMA,
      id,
      kind: 'url',
      url,
      status: 'not_fetched',
      reason: 'Network fetch is explicit follow-up scope; provide --release-notes-file for content-backed planning.',
      recorded_at: now,
    };
    await writeJson(target, metadata);
    entries.push({
      id,
      kind: 'url',
      source: url,
      pointer: pointer(repoRoot, target),
      bytes: 0,
      sha256: null,
      status: 'not_fetched',
    });
  }

  const indexPath = resolve(notesDir, 'index.json');
  const previous = await readJsonIfExists(indexPath, {
    schema_version: RELEASE_NOTES_SCHEMA,
    run_id: selected.runId,
    notes: [],
  });
  const index = {
    schema_version: RELEASE_NOTES_SCHEMA,
    run_id: selected.runId,
    updated_at: now,
    notes: [...(previous.notes ?? []), ...entries],
    limits: [
      'Release note ingestion stores explicit files or URL pointers only.',
      'Network fetching is not automatic.',
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
    notes: entries.map(({ id, kind, source, pointer: notePointer, status }) => ({ id, kind, source, pointer: notePointer, status })),
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
  const gap = buildGapAnalysis({
    snapshot,
    baseline: options.baseline ?? snapshot.remembered_baseline ?? await loadBaselineVersions(),
    releaseNotes: await listReleaseNotes(repoRoot, selected.runId),
    now: options.now ?? new Date(),
  });
  await writeJson(gapPath, gap);
  const releaseNotes = await readReleaseNoteBodies(repoRoot, selected.runId);
  const surfaces = classifySurfaces({ gap, releaseNotes });
  const plan = {
    schema_version: PLAN_SCHEMA,
    runtime_version: VERSION,
    run_id: selected.runId,
    created_at: toIso(options.now ?? new Date()),
    status: gap.overall.release_notes_required && releaseNotes.content_backed_count === 0
      ? 'blocked_release_notes_required'
      : 'planned',
    gap_pointer: pointer(repoRoot, gapPath),
    affected_surfaces: surfaces,
    recommended_sequence: buildRecommendedSequence({ gap, surfaces, releaseNotes }),
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
    plan_pointer: pointer(repoRoot, planPath),
    affected_surfaces: surfaces,
    recommended_sequence: plan.recommended_sequence,
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
  const hostGaps = ['claude', 'codex'].map((host) => {
    const observed = snapshot.hosts?.[host] ?? {};
    const baselineVersion = baseline?.[host]?.version ?? null;
    const observedVersion = observed.version ?? null;
    let status = 'matches';
    if (!observed.available) status = 'host_unavailable';
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
  const driftClass = classifyDrift(hostGaps);
  const hasContentBackedNotes = releaseNotes.notes.some((note) => note.kind === 'file' && note.status === 'stored');
  const releaseNotesRequired = driftClass !== 'none' && !hasContentBackedNotes;
  const overallStatus = releaseNotesRequired
    ? 'release_notes_required'
    : driftClass === 'none'
      ? 'current'
      : 'gap_analysis_ready';
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
    },
    host_gaps: hostGaps,
    release_notes: releaseNotes,
    next_steps: releaseNotesRequired
      ? [`runtime:compat ingest-release-notes --run-id ${snapshot.run_id} --release-notes-file <path>`]
      : [`runtime:compat plan --run-id ${snapshot.run_id}`],
  };
}

function classifyDrift(hostGaps) {
  if (hostGaps.some((gap) => gap.status === 'version_changed')) return 'host-version-changed';
  if (hostGaps.some((gap) => gap.status === 'host_unavailable')) return 'host-unavailable';
  if (hostGaps.some((gap) => gap.status === 'version_unknown' || gap.status === 'no_baseline')) return 'baseline-incomplete';
  return 'none';
}

function classifySurfaces({ gap, releaseNotes }) {
  const text = releaseNotes.combined_text.toLowerCase();
  const surfaces = new Set();
  if (gap.overall.drift_class !== 'none') surfaces.add('host-version-baseline');
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
  for (const [surface, pattern] of rules) {
    if (pattern.test(text)) surfaces.add(surface);
  }
  return [...surfaces].sort();
}

function buildRecommendedSequence({ gap, surfaces, releaseNotes }) {
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
  sequence.push({
    step: 'run-validation',
    reason: 'Run marketplace/version/artifact validation and relevant runtime tests after any compatibility update.',
    required: true,
  });
  return sequence;
}

function renderPlanMarkdown(plan) {
  const lines = [
    '# Runtime Compatibility Update Plan',
    '',
    `Run: ${plan.run_id}`,
    `Status: ${plan.status}`,
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
  lines.push('', '## Recommended Sequence', '');
  for (const item of plan.recommended_sequence) {
    lines.push(`- ${item.step}: ${item.reason}`);
  }
  lines.push('', '## Limits', '');
  for (const limit of plan.limits) lines.push(`- ${limit}`);
  return `${lines.join('\n')}\n`;
}

function nextStepsForPlan(plan) {
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
  let contentBacked = 0;
  for (const note of releaseNotes.notes) {
    if (note.kind !== 'file' || note.status !== 'stored' || !note.pointer) continue;
    try {
      const text = await readFile(resolve(repoRoot, note.pointer), 'utf8');
      texts.push(text);
      contentBacked++;
    } catch {
      // Missing release-note bodies are treated as absent content.
    }
  }
  return {
    ...releaseNotes,
    content_backed_count: contentBacked,
    combined_text: texts.join('\n\n'),
  };
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

async function loadBaselineVersions() {
  try {
    const text = await readFile(resolve(PLUGIN_ROOT, 'docs/host-parity-baseline.md'), 'utf8');
    return extractBaselineVersions(text);
  } catch {
    return { claude: { version: null }, codex: { version: null } };
  }
}

export function extractBaselineVersions(text) {
  const body = String(text ?? '');
  const claude = body.match(/Claude Code [`\s]*([0-9]+(?:\.[0-9]+)+)/i)
    ?? body.match(/claude --version` -> `([^`]+)`/i);
  const codex = body.match(/Codex CLI\s*`?([0-9]+(?:\.[0-9]+)+)/i)
    ?? body.match(/codex --version` -> `([^`]+)`/i);
  return {
    claude: { version: extractSemver(claude?.[1] ?? null) },
    codex: { version: extractSemver(codex?.[1] ?? null) },
  };
}

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
    'runtime:compat records host-version and release-note artifacts only; it does not install, update, authenticate, or mutate host CLIs.',
    'Release-note URL fetch is not automatic. Provide --release-notes-file for content-backed planning.',
    'Raw command help output and release-note bodies stay in artifacts; main-session output is limited to metadata, hashes, gaps, and pointers.',
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
  if (report.drift_class) lines.push(`drift: ${report.drift_class}`);
  if (report.snapshot_pointer) lines.push(`snapshot: ${report.snapshot_pointer}`);
  if (report.gap_pointer) lines.push(`gap analysis: ${report.gap_pointer}`);
  if (report.release_notes_pointer) lines.push(`release notes: ${report.release_notes_pointer}`);
  if (report.plan_pointer) lines.push(`plan: ${report.plan_pointer}`);
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
  if (report.affected_surfaces?.length) {
    lines.push('', 'affected surfaces:');
    for (const surface of report.affected_surfaces) lines.push(`- ${surface}`);
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
  runtime:compat ingest-release-notes (--run-id <id>|--latest) --release-notes-url <url>
  runtime:compat plan (--run-id <id>|--latest) [--format text|json]

Records Claude Code and Codex CLI version snapshots, compares them to the remembered host-parity baseline, stores explicit release-note artifacts, and emits compatibility update plans. It does not fetch URLs by default and never mutates host config or plugin state.`;
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

function extractSemver(value) {
  const match = String(value ?? '').match(/[0-9]+(?:\.[0-9]+){1,3}/);
  return match ? match[0] : null;
}

function sanitizeLine(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
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
