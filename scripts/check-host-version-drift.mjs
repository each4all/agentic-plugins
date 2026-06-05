#!/usr/bin/env node
// check-host-version-drift.mjs — repo-level CI helper (NOT a runtime plugin
// command; release-please exempt). Compares the runtime host-parity baseline
// against the latest *published* host versions on public registries and
// against a staleness window, then signals drift via exit code for a
// scheduled CI gate.
//
// Why a separate script (not compat.mjs): runtime:compat/doctor keep exit-0
// semantics for interactive use and probe the *installed* host CLI. CI runners
// have no claude/codex CLI, so this gate uses the *public latest* release as
// the drift reference and owns a CI-only hard-fail policy. The baseline parser
// (compat.extractBaselineVersions) is reused so there is one source of truth
// for reading the baseline header.
//
// Boundaries: read-only. It NEVER edits the baseline (ADR-0026 — baseline
// refresh stays a human-reviewed action); it only reports "re-observation
// needed".
//
// Exit codes: 0 = current OR a transient registry flake (source/partial
// unavailable — a flake must never be reported as drift); 1 = drift
// (minor/major) or stale; 2 = error (unreadable/malformed baseline, or a
// fatal upstream condition like a schema change / 404 / unparseable version —
// the gate fails loudly rather than going silently green).
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractBaselineVersions } from '../plugins/runtime/scripts/compat.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const BASELINE_PATH = resolve(REPO_ROOT, 'plugins/runtime/docs/host-parity-baseline.md');
const DEFAULT_STALE_DAYS = 14;
const USER_AGENT = 'agentic-plugins-host-drift-check';
const MAX_RESPONSE_BYTES = 1_000_000; // safety cap; dist-tags responses are ~600 bytes

const HOSTS = [
  { host: 'claude', npmPkg: '@anthropic-ai/claude-code', githubRepo: 'anthropics/claude-code' },
  { host: 'codex', npmPkg: '@openai/codex', githubRepo: 'openai/codex' },
];

// ── pure helpers ────────────────────────────────────────────────────────────

// Mirror of compat.extractSemver — keep CI-policy parsing independent of the
// runtime plugin while staying byte-identical so baseline and upstream
// versions normalize the same way (e.g. `rust-v0.137.0` → `0.137.0`).
export function normalizeVersion(value) {
  const match = String(value ?? '').match(/[0-9]+(?:\.[0-9]+){1,3}/);
  return match ? match[0] : null;
}

function semverParts(value) {
  const normalized = normalizeVersion(value);
  if (!normalized) return null;
  const parts = normalized.split('.').slice(0, 3).map((n) => Number.parseInt(n, 10));
  while (parts.length < 3) parts.push(0);
  return parts.some((n) => Number.isNaN(n)) ? null : parts;
}

// -1 if a<b, 0 if equal, 1 if a>b, null if either is unparseable.
export function compareSemver(a, b) {
  const pa = semverParts(a);
  const pb = semverParts(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// Severity of the difference by position: 'major' | 'minor' | 'patch' |
// 'current' | 'unknown'. Direction-agnostic (rollbacks classify by position).
export function driftSeverity(baseline, latest) {
  const pb = semverParts(baseline);
  const pl = semverParts(latest);
  if (!pb || !pl) return 'unknown';
  if (pb[0] !== pl[0]) return 'major';
  if (pb[1] !== pl[1]) return 'minor';
  if (pb[2] !== pl[2]) return 'patch';
  return 'current';
}

// First "Observed on YYYY-MM-DD" only (matches the baseline header; a later
// Version History entry must never win). Returns a UTC Date or null.
export function parseObservedDate(text) {
  const match = String(text ?? '').match(/Observed on\s+(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (Number.isNaN(date.getTime())) return null;
  // Reject calendar-invalid dates (e.g. 2026-13-40 rolls over).
  if (date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) return null;
  return date;
}

// Aggregate per-host results + staleness into one verdict.
//   - minor/major drift OR staleness → exit 1 (drift wins even if another host
//     is unavailable, so a flake never masks a real drift);
//   - patch diff is informational (exit 0);
//   - ALL sources unavailable (no drift/stale) → 'source-unavailable', exit 0;
//   - SOME unavailable + the rest current → 'partial-unavailable', exit 0 but
//     NOT 'current' (we could not confirm the unavailable host — do not let a
//     downstream consumer close a drift issue on a half-check).
export function aggregate(results, { staleDays, observedDate, now }) {
  const ageDays = Math.floor((now.getTime() - observedDate.getTime()) / 86_400_000);
  const stale = ageDays > staleDays;

  const hosts = results.map((r) => {
    if (r.latest == null) {
      return { host: r.host, baseline: r.baseline, latest: null, severity: 'unavailable', reason: r.error };
    }
    return {
      host: r.host,
      baseline: r.baseline,
      latest: r.latest,
      source: r.source,
      severity: driftSeverity(r.baseline, r.latest),
      direction: compareSemver(r.latest, r.baseline),
    };
  });

  const drifted = hosts.filter((h) => h.severity === 'minor' || h.severity === 'major');
  const patches = hosts.filter((h) => h.severity === 'patch');
  const unavailable = hosts.filter((h) => h.severity === 'unavailable');

  const reasons = [];
  let status;
  let exitCode = 0;

  if (drifted.length) {
    status = 'drift';
    exitCode = 1;
    for (const h of drifted) reasons.push(`${h.host} ${h.severity} drift ${h.baseline} → ${h.latest}`);
  }
  if (stale) {
    status = status ? 'drift+stale' : 'stale';
    exitCode = 1;
    reasons.push(`baseline observed ${ageDays}d ago (> ${staleDays}d window)`);
  }
  if (!status) {
    if (unavailable.length === hosts.length) {
      status = 'source-unavailable';
      reasons.push('all upstream sources unavailable (registry flake; not treated as drift)');
    } else if (unavailable.length) {
      status = 'partial-unavailable';
      reasons.push(
        `${unavailable.map((h) => h.host).join(', ')} unavailable; remaining hosts current `
          + '(not a full current confirmation)',
      );
    } else {
      status = 'current';
    }
  }

  return {
    status,
    exitCode,
    stale,
    age_days: ageDays,
    stale_after_days: staleDays,
    all_available: unavailable.length === 0,
    hosts,
    patches: patches.map((h) => `${h.host} ${h.baseline} → ${h.latest}`),
    reasons,
  };
}

// Distinguish transient failures (treat as unavailable, exit 0 — a registry
// flake must not be reported as drift) from fatal ones (config/schema/404/
// unparseable — exit 2 so the gate fails loudly instead of going silently
// green and quietly disabling itself).
function classifyError(err) {
  if (err.code === 'TIMEOUT') return 'transient';
  if (err.code === 'HTTP' && (err.status === 429 || err.status >= 500)) return 'transient';
  if (['ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE'].includes(err.code)) {
    return 'transient';
  }
  // SCHEMA, TOOBIG, HTTP 4xx (404 etc.), and anything unexpected → fatal.
  return 'fatal';
}

// ── I/O (injectable) ────────────────────────────────────────────────────────

function defaultHttpGet(url, { timeoutMs = 10_000, headers = {} } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': USER_AGENT, ...headers }, timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { code: 'HTTP', status: res.statusCode }));
          return;
        }
        let body = '';
        let bytes = 0;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_RESPONSE_BYTES) {
            res.destroy();
            reject(Object.assign(new Error('response exceeded byte cap'), { code: 'TOOBIG' }));
            return;
          }
          body += chunk;
        });
        res.on('end', () => resolvePromise(body));
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('request timeout'), { code: 'TIMEOUT' })));
    req.on('error', reject);
  });
}

// npm dist-tags-only endpoint (~600 bytes) rather than the full packument (~8 MB).
export async function fetchNpmLatest(pkg, { httpGet = defaultHttpGet, timeoutMs } = {}) {
  const body = await httpGet(`https://registry.npmjs.org/-/package/${pkg}/dist-tags`, { timeoutMs });
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw Object.assign(new Error('npm dist-tags: invalid JSON'), { code: 'SCHEMA' });
  }
  const latest = json && json.latest;
  if (!latest) throw Object.assign(new Error('npm dist-tags: missing "latest"'), { code: 'SCHEMA' });
  const normalized = normalizeVersion(latest);
  if (!normalized) throw Object.assign(new Error(`npm dist-tags: unparseable "${latest}"`), { code: 'SCHEMA' });
  return normalized;
}

export async function fetchGithubLatest(repo, { httpGet = defaultHttpGet, timeoutMs } = {}) {
  const body = await httpGet(`https://api.github.com/repos/${repo}/releases/latest`, {
    timeoutMs,
    headers: { Accept: 'application/vnd.github+json' },
  });
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw Object.assign(new Error('github releases: invalid JSON'), { code: 'SCHEMA' });
  }
  // Prefer release.name (normalized, e.g. "0.137.0") over tag_name ("rust-v0.137.0").
  const raw = json && (json.name || json.tag_name);
  if (!raw) throw Object.assign(new Error('github releases: missing name/tag_name'), { code: 'SCHEMA' });
  const normalized = normalizeVersion(raw);
  if (!normalized) throw Object.assign(new Error(`github releases: unparseable "${raw}"`), { code: 'SCHEMA' });
  return normalized;
}

// npm is primary; GitHub releases is a fallback only when npm fails *transiently*
// (never compared against each other — avoids npm/GitHub source-conflict). A
// fatal npm error (schema/404/unparseable) short-circuits to a fatal result so
// runCheck can exit 2 rather than silently masking it as unavailable.
export async function fetchHostLatest(host, { httpGet = defaultHttpGet, timeoutMs } = {}) {
  try {
    return { latest: await fetchNpmLatest(host.npmPkg, { httpGet, timeoutMs }), source: 'npm' };
  } catch (npmErr) {
    if (classifyError(npmErr) === 'fatal') {
      return { latest: null, fatal: true, error: `npm: ${npmErr.message}` };
    }
    try {
      return {
        latest: await fetchGithubLatest(host.githubRepo, { httpGet, timeoutMs }),
        source: 'github',
        npmError: npmErr.message,
      };
    } catch (ghErr) {
      if (classifyError(ghErr) === 'fatal') {
        return { latest: null, fatal: true, error: `github: ${ghErr.message}` };
      }
      return { latest: null, fatal: false, error: `npm: ${npmErr.message}; github: ${ghErr.message}` };
    }
  }
}

// ── orchestration ───────────────────────────────────────────────────────────

export async function runCheck({
  baselinePath = BASELINE_PATH,
  staleDays = DEFAULT_STALE_DAYS,
  now = new Date(),
  httpGet = defaultHttpGet,
  timeoutMs,
} = {}) {
  let baselineText;
  try {
    baselineText = await readFile(baselinePath, 'utf8');
  } catch (err) {
    return { status: 'error', exitCode: 2, reason: `baseline read failed: ${err.message}` };
  }

  const versions = extractBaselineVersions(baselineText);
  const observedDate = parseObservedDate(baselineText);
  const missing = [];
  if (!versions.claude.version) missing.push('claude baseline version');
  if (!versions.codex.version) missing.push('codex baseline version');
  if (!observedDate) missing.push('observed-on date');
  if (missing.length) {
    return { status: 'error', exitCode: 2, reason: `baseline parse failed: ${missing.join(', ')}` };
  }

  const baselineByHost = { claude: versions.claude.version, codex: versions.codex.version };
  const results = [];
  for (const host of HOSTS) {
    const fetched = await fetchHostLatest(host, { httpGet, timeoutMs });
    if (fetched.fatal) {
      return {
        status: 'error',
        exitCode: 2,
        reason: `${host.host} upstream check failed (config/schema, not a transient flake): ${fetched.error}`,
      };
    }
    results.push({ host: host.host, baseline: baselineByHost[host.host], ...fetched });
  }

  return aggregate(results, { staleDays, observedDate, now });
}

export function formatText(result) {
  const lines = [`host-version-drift: ${result.status} (exit ${result.exitCode})`];
  if (result.reason) lines.push(`  reason: ${result.reason}`);
  for (const h of result.hosts ?? []) {
    const latest = h.latest ?? '?';
    const via = h.source ? ` via ${h.source}` : '';
    const note = h.severity === 'unavailable' && h.reason ? ` — ${h.reason}` : '';
    lines.push(`  ${h.host}: baseline ${h.baseline} vs latest ${latest} [${h.severity}]${via}${note}`);
  }
  if (result.patches && result.patches.length) {
    lines.push(`  patch-level (informational, not failing): ${result.patches.join(', ')}`);
  }
  for (const reason of result.reasons ?? []) lines.push(`  signal: ${reason}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = { format: 'text', staleDays: DEFAULT_STALE_DAYS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--format') {
      options.format = argv[i + 1];
      i += 1;
    } else if (arg === '--stale-after-days') {
      const value = Number.parseInt(argv[i + 1], 10);
      if (!Number.isNaN(value) && value > 0) options.staleDays = value;
      i += 1;
    } else if (arg === '--baseline-path') {
      options.baselinePath = argv[i + 1];
      i += 1;
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runCheck({
    staleDays: options.staleDays,
    baselinePath: options.baselinePath,
    now: new Date(),
  });
  if (options.format === 'json') console.log(JSON.stringify(result, null, 2));
  else console.log(formatText(result));
  process.exitCode = result.exitCode;
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  (async () => {
    try {
      await main();
    } catch (err) {
      console.error(`check-host-version-drift: ${err.message}`);
      process.exitCode = 2;
    }
  })();
}
