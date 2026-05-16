#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDoctor } from './doctor.mjs';
import { RUNTIME_VERSION } from './version.mjs';

const VERSION = RUNTIME_VERSION;
const DEFAULT_MAX_ARTIFACT_AGE_HOURS = 24;
const CHECK_PASS = new Set(['satisfied', 'current', 'fresh', 'not-active']);
const CHECK_UNREADY = new Set(['partial', 'blocked', 'stale', 'not-verified', 'missing']);
const OMCC_ACTIVITY = new Set(['yes', 'no', 'unknown']);
const FOOTER_STATES = new Set([
  'review-needed',
  'publish-needed',
  'cleanup-needed',
  'next-work-available',
  'blocked',
  'closed',
]);

export async function runCutoverAudit(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const now = options.now ?? new Date();
  const maxArtifactAgeHours = options.maxArtifactAgeHours ?? DEFAULT_MAX_ARTIFACT_AGE_HOURS;
  const doctor = options.doctorReport ?? await runDoctor({
    repoRoot,
    homeDir: resolve(options.homeDir ?? homedir()),
    env: options.env ?? process.env,
    now,
    format: 'json',
  });
  const [scorecardText, developmentText, hostParityText, manifest] = await Promise.all([
    readOptionalText(resolve(repoRoot, 'docs/assurance/omcc-cutover-scorecard.md')),
    readOptionalText(resolve(repoRoot, 'docs/DEVELOPMENT.md')),
    readOptionalText(resolve(repoRoot, 'plugins/runtime/docs/host-parity-baseline.md')),
    readOptionalJson(resolve(repoRoot, '.release-please-manifest.json')),
  ]);

  const checks = [
    checkAdr0012Conditions(developmentText),
    checkScorecardRequirements(scorecardText),
    checkHostParityBaseline(hostParityText, doctor),
    checkPluginVersions({ repoRoot, manifest, doctor }),
    checkCompatFreshness({ doctor, now, maxArtifactAgeHours }),
    await checkConsensusAndContext({ repoRoot, doctor, now, maxArtifactAgeHours }),
    checkFooterState(options),
    checkOmccActivity(options),
  ];
  const readyCandidate = checks.every((check) => CHECK_PASS.has(check.status));
  return {
    command: 'cutover-audit',
    version: VERSION,
    status: readyCandidate ? 'cutover-ready-candidate' : 'not-ready',
    ready_candidate: readyCandidate,
    generated_at: now.toISOString(),
    repo_root: repoRoot,
    checks,
    next_actions: checks
      .filter((check) => CHECK_UNREADY.has(check.status))
      .map((check) => ({ id: check.id, next_action: check.next_action }))
      .filter((entry) => entry.next_action),
    limits: [
      'This audit is read-only and does not install, uninstall, update, authenticate, mutate host config, mutate git state, or delete artifacts.',
      'cutover-ready-candidate is not final cutover; ADR-0007 still requires explicit user declaration.',
      'Unknown dogfood or omcc-dev usage evidence blocks readiness rather than being inferred.',
    ],
  };
}

function checkAdr0012Conditions(text) {
  const rows = parseMarkdownRows(text).filter((row) => /^[1-4]$/.test(row[0]));
  const statuses = rows.map((row) => ({ condition: row[0], status: normalizeStatus(row[2]) }));
  const missing = [1, 2, 3, 4].filter((condition) => !statuses.some((row) => row.condition === String(condition)));
  const notSatisfied = statuses.filter((row) => row.status !== 'satisfied');
  return {
    id: 'adr0012_conditions',
    label: 'ADR-0012 condition statuses',
    status: missing.length > 0 ? 'missing' : notSatisfied.length === 0 ? 'satisfied' : 'partial',
    evidence: {
      statuses,
      missing_conditions: missing,
    },
    next_action: missing.length > 0
      ? 'Restore the ADR-0012 condition matrix in docs/DEVELOPMENT.md.'
      : notSatisfied.length > 0
        ? 'Continue dogfood and verification until all four ADR-0012 conditions are fully satisfied.'
        : null,
  };
}

function checkScorecardRequirements(text) {
  const rows = parseMarkdownRows(text).filter((row) => /^R\d+[a-z]?$/.test(row[0]));
  const statuses = rows.map((row) => ({ requirement: row[0], status: normalizeStatus(row[3]) }));
  const unresolved = statuses.filter((row) => row.status !== 'satisfied');
  return {
    id: 'omcc_replacement_scorecard',
    label: 'omcc replacement requirement scorecard',
    status: rows.length === 0 ? 'missing' : unresolved.length === 0 ? 'satisfied' : 'partial',
    evidence: {
      total: rows.length,
      satisfied: statuses.filter((row) => row.status === 'satisfied').length,
      unresolved,
    },
    next_action: unresolved.length > 0
      ? 'Resolve remaining scorecard rows before declaring cutover readiness.'
      : null,
  };
}

function checkHostParityBaseline(text, doctor) {
  const match = text.match(/Observed on ([0-9-]+) with Claude Code `([^`]+)`, Codex CLI\s*`([^`]+)`/m);
  const observedClaude = observedVersionText(doctor.clis?.claude?.version);
  const observedCodex = observedVersionText(doctor.clis?.codex?.version);
  const normalizedObserved = {
    claude: normalizeHostVersion(observedClaude),
    codex: normalizeHostVersion(observedCodex),
  };
  const baseline = match
    ? { date: match[1], claude: match[2], codex: match[3] }
    : null;
  const current = baseline
    && normalizedObserved.claude === baseline.claude
    && normalizedObserved.codex === baseline.codex;
  return {
    id: 'host_parity_baseline',
    label: 'Host parity baseline freshness',
    status: baseline ? current ? 'current' : 'stale' : 'missing',
    evidence: {
      baseline,
      observed: { claude: observedClaude, codex: observedCodex },
      normalized_observed: normalizedObserved,
    },
    next_action: baseline
      ? current ? null : 'Refresh host parity baseline and runtime:compat evidence for the current host versions.'
      : 'Restore plugins/runtime/docs/host-parity-baseline.md.',
  };
}

function observedVersionText(value) {
  if (value && typeof value === 'object' && 'text' in value) return value.text;
  return value ?? null;
}

function normalizeHostVersion(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = text.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return match?.[0] ?? text;
}

function checkPluginVersions({ repoRoot, manifest, doctor }) {
  const packages = {
    'plugins/companions': 'companions',
    'plugins/engineer': 'engineer',
    'plugins/orchestrator': 'orchestrator',
    'plugins/runtime': 'runtime',
  };
  const entries = Object.entries(packages).map(([packagePath, pluginName]) => {
    const expected = manifest?.[packagePath] ?? null;
    const plugin = doctor.plugins?.[pluginName] ?? {};
    const source = plugin.source?.claude_manifest?.version ?? null;
    const claudeCache = plugin.cache?.claude?.latest?.manifest_version ?? null;
    const codexCache = plugin.cache?.codex?.latest?.manifest_version ?? null;
    return {
      package: packagePath,
      plugin: pluginName,
      expected,
      source,
      claude_cache: claudeCache,
      codex_cache: codexCache,
      status: expected && source === expected && claudeCache === expected && codexCache === expected
        ? 'satisfied'
        : 'blocked',
    };
  });
  const blocked = entries.filter((entry) => entry.status !== 'satisfied');
  return {
    id: 'installed_plugin_versions',
    label: 'Installed/cache plugin versions match release manifest',
    status: blocked.length === 0 ? 'satisfied' : 'blocked',
    evidence: {
      manifest_pointer: relativePointer(repoRoot, resolve(repoRoot, '.release-please-manifest.json')),
      entries,
    },
    next_action: blocked.length > 0
      ? 'Run runtime:settings --execute-plugin-management, then rerun this audit.'
      : null,
  };
}

function checkCompatFreshness({ doctor, now, maxArtifactAgeHours }) {
  const latest = doctor.compat_runs?.latest ?? null;
  const ageHours = latest?.selected_at ? ageHoursSince(latest.selected_at, now) : null;
  const fresh = ageHours !== null && ageHours <= maxArtifactAgeHours;
  const current = latest?.status === 'current' && latest?.drift_class === 'none';
  return {
    id: 'latest_compat_snapshot',
    label: 'Latest compatibility snapshot freshness',
    status: latest ? current && fresh ? 'fresh' : current ? 'stale' : 'blocked' : 'missing',
    evidence: {
      run_id: latest?.run_id ?? null,
      status: latest?.status ?? null,
      drift_class: latest?.drift_class ?? null,
      selected_at: latest?.selected_at ?? null,
      age_hours: ageHours,
      max_age_hours: maxArtifactAgeHours,
    },
    next_action: latest && current && fresh
      ? null
      : 'Run runtime:compat snapshot and runtime:compat check, ingest release notes if drift appears.',
  };
}

async function checkConsensusAndContext({ repoRoot, doctor, now, maxArtifactAgeHours }) {
  const consensus = doctor.consensus_runs?.latest ?? null;
  const context = await findLatestContext(repoRoot);
  const contextAge = context?.selected_at ? ageHoursSince(context.selected_at, now) : null;
  const consensusOk = consensus?.status === 'passed' || consensus?.status === 'synthesized';
  const contextFresh = contextAge !== null && contextAge <= maxArtifactAgeHours;
  return {
    id: 'latest_consensus_context_artifacts',
    label: 'Latest consensus and context artifact state',
    status: consensusOk && contextFresh ? 'fresh' : consensus && context ? 'stale' : 'not-verified',
    evidence: {
      consensus: consensus ? {
        run_id: consensus.run_id,
        status: consensus.status,
        selected_at: consensus.selected_at,
        pointer: consensus.artifact_pointer,
      } : null,
      context: context ? {
        run_id: context.run_id,
        selected_at: context.selected_at,
        age_hours: contextAge,
        pointer: context.pointer,
      } : null,
      max_age_hours: maxArtifactAgeHours,
    },
    next_action: consensusOk && contextFresh
      ? null
      : 'Refresh consensus/context evidence before cutover evaluation.',
  };
}

function checkFooterState(options) {
  const footerState = options.footerState ?? null;
  return {
    id: 'latest_completion_footer_state',
    label: 'Latest completion footer state',
    status: footerState ? footerState === 'closed' ? 'satisfied' : 'partial' : 'not-verified',
    evidence: {
      footer_state: footerState,
      reason: options.footerReason ?? null,
    },
    next_action: footerState
      ? footerState === 'closed'
        ? null
        : 'Close or continue the outstanding completion footer action before declaring cutover readiness.'
      : 'Provide explicit --footer-state evidence from the latest completion surface.',
  };
}

function checkOmccActivity(options) {
  const active = options.omccDevActive ?? 'unknown';
  return {
    id: 'omcc_dev_daily_workflow',
    label: 'Daily workflow still depends on omcc-dev',
    status: active === 'no' ? 'not-active' : active === 'yes' ? 'blocked' : 'not-verified',
    evidence: {
      omcc_dev_active: active,
      note: options.omccDevNote ?? null,
    },
    next_action: active === 'no'
      ? null
      : active === 'yes'
        ? 'Continue agentic-plugins dogfood until daily workflow no longer depends on omcc-dev.'
        : 'Record explicit --omcc-dev-active yes|no evidence for the current dogfood period.',
  };
}

async function findLatestContext(repoRoot) {
  const root = resolve(repoRoot, '.agentic-plugins/runs/context');
  try {
    await access(root, fsConstants.R_OK);
  } catch {
    return null;
  }
  const entries = await readdir(root, { withFileTypes: true });
  const contexts = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('context-')) continue;
    const contextPath = resolve(root, entry.name, 'context.json');
    const context = await readOptionalJson(contextPath);
    if (!context) continue;
    contexts.push({
      run_id: context.run_id ?? entry.name,
      selected_at: context.created_at ?? null,
      selected_at_ms: Date.parse(context.created_at ?? ''),
      pointer: relativePointer(repoRoot, contextPath),
    });
  }
  return contexts
    .filter((entry) => Number.isFinite(entry.selected_at_ms))
    .sort((a, b) => b.selected_at_ms - a.selected_at_ms)[0] ?? null;
}

function parseMarkdownRows(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'))
    .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()))
    .filter((row) => row.length >= 3 && !row.every((cell) => /^-+$/.test(cell)));
}

function normalizeStatus(value) {
  const normalized = String(value ?? '').toLowerCase().replace(/`/g, '').trim();
  if (normalized === 'satisfied') return 'satisfied';
  if (normalized.includes('functional satisfied')) return 'partial';
  if (normalized.includes('partial')) return 'partial';
  if (normalized.includes('missing')) return 'missing';
  if (normalized.includes('blocked')) return 'blocked';
  return normalized || 'not-verified';
}

function ageHoursSince(iso, now) {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, (now.getTime() - timestamp) / 3600000);
}

function relativePointer(repoRoot, path) {
  const relative = path.startsWith(repoRoot) ? path.slice(repoRoot.length).replace(/^\/+/, '') : path;
  return relative || '.';
}

async function readOptionalText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export function formatText(report) {
  if (report.help) return helpText();
  const lines = [
    `runtime:cutover-audit ${report.version} (${report.status})`,
    `repo: ${report.repo_root}`,
    `ready-candidate: ${report.ready_candidate}`,
  ];
  for (const check of report.checks ?? []) {
    lines.push(`- ${check.id}: ${check.status}; ${check.label}`);
    if (check.next_action) lines.push(`  next: ${check.next_action}`);
  }
  if (report.next_actions?.length) {
    lines.push('', 'next actions:');
    for (const action of report.next_actions) lines.push(`- ${action.id}: ${action.next_action}`);
  }
  if (report.limits?.length) {
    lines.push('', 'limits:');
    for (const limit of report.limits) lines.push(`- ${limit}`);
  }
  return lines.join('\n');
}

export function parseArgs(argv) {
  const args = [...argv];
  const options = {};
  if (args[0] === 'audit' || args[0] === 'cutover-audit') args.shift();
  while (args.length > 0) {
    const arg = args.shift();
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
      case '--max-artifact-age-hours':
        options.maxArtifactAgeHours = positiveNumber(requireValue(args, arg), arg);
        break;
      case '--footer-state': {
        const value = requireValue(args, arg);
        if (!FOOTER_STATES.has(value)) throw new Error('--footer-state is invalid');
        options.footerState = value;
        break;
      }
      case '--footer-reason':
        options.footerReason = requireValue(args, arg);
        break;
      case '--omcc-dev-active': {
        const value = requireValue(args, arg);
        if (!OMCC_ACTIVITY.has(value)) throw new Error('--omcc-dev-active must be yes, no, or unknown');
        options.omccDevActive = value;
        break;
      }
      case '--omcc-dev-note':
        options.omccDevNote = requireValue(args, arg);
        break;
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function requireValue(args, flag) {
  if (args.length === 0 || args[0].startsWith('-')) throw new Error(`${flag} requires a value`);
  return args.shift();
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number`);
  return number;
}

function helpText() {
  return `runtime:cutover-audit ${VERSION}

Usage:
  runtime:cutover-audit [--format text|json] [--max-artifact-age-hours N]
  runtime:cutover-audit --footer-state <state> --omcc-dev-active yes|no|unknown

Builds a read-only omcc cutover readiness report. The report can only emit
cutover-ready-candidate; final cutover still requires explicit user declaration.`;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = options.help ? { help: true, version: VERSION } : await runCutoverAudit(options);
    const format = options.format ?? 'text';
    process.stdout.write(format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : `${formatText(report)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}
