import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  aggregate,
  compareSemver,
  driftSeverity,
  fetchGithubLatest,
  fetchHostLatest,
  fetchNpmLatest,
  normalizeVersion,
  parseObservedDate,
  runCheck,
} from '../../scripts/check-host-version-drift.mjs';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../../scripts/check-host-version-drift.mjs');

// Baseline header shaped like plugins/runtime/docs/host-parity-baseline.md so
// compat.extractBaselineVersions + parseObservedDate read it the same way.
const baselineFixture = (claude, codex, date) =>
  `# Host Parity Baseline\n\nObserved on ${date} with Claude Code \`${claude}\`, Codex CLI\n\`${codex}\`, official docs.\n\n## Sources\n...\n`;

async function withBaseline(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'drift-test-'));
  const path = join(dir, 'host-parity-baseline.md');
  await writeFile(path, content);
  try {
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── normalizeVersion ─────────────────────────────────────────────────────────
test('normalizeVersion strips host-specific prefixes', () => {
  assert.equal(normalizeVersion('2.1.163'), '2.1.163');
  assert.equal(normalizeVersion('rust-v0.137.0'), '0.137.0');
  assert.equal(normalizeVersion('codex-cli 0.136.0'), '0.136.0');
  assert.equal(normalizeVersion('v2.1.0'), '2.1.0');
  assert.equal(normalizeVersion('0.137.0-rc.1'), '0.137.0'); // prerelease → base release
  assert.equal(normalizeVersion('not-a-version'), null);
  assert.equal(normalizeVersion(null), null);
});

// ── compareSemver ────────────────────────────────────────────────────────────
test('compareSemver orders versions', () => {
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('1.0.0', '1.0.1'), -1);
  assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
  assert.equal(compareSemver('v2.1.0', '2.1.0'), 0);
  assert.equal(compareSemver('rust-v0.137.0', '0.136.0'), 1);
  assert.equal(compareSemver('garbage', '1.0.0'), null);
});

// ── driftSeverity ────────────────────────────────────────────────────────────
test('driftSeverity classifies by differing position', () => {
  assert.equal(driftSeverity('2.1.161', '2.1.161'), 'current');
  assert.equal(driftSeverity('2.1.161', '2.1.163'), 'patch');
  assert.equal(driftSeverity('0.136.0', '0.137.0'), 'minor');
  assert.equal(driftSeverity('2.1.161', '3.0.0'), 'major');
  assert.equal(driftSeverity('bad', '1.0.0'), 'unknown');
});

// ── parseObservedDate ────────────────────────────────────────────────────────
test('parseObservedDate reads the date as UTC', () => {
  const d = parseObservedDate('Observed on 2026-06-03 with Claude Code `2.1.161`');
  assert.equal(d.getTime(), Date.UTC(2026, 5, 3));
});
test('parseObservedDate prefers the first occurrence (header over history)', () => {
  const text = 'Observed on 2026-06-03 with ...\n\n## Version History\n- Observed on 2025-01-01\n';
  const d = parseObservedDate(text);
  assert.equal(d.getUTCFullYear(), 2026);
  assert.equal(d.getUTCMonth(), 5);
});
test('parseObservedDate rejects malformed/missing dates', () => {
  assert.equal(parseObservedDate('Observed on 2026-13-40 with'), null);
  assert.equal(parseObservedDate('no observed date here'), null);
});

// ── aggregate (status / exit-code matrix) ────────────────────────────────────
const fresh = { staleDays: 14, observedDate: new Date(Date.UTC(2026, 5, 3)), now: new Date(Date.UTC(2026, 5, 5)) };
const stale = { ...fresh, now: new Date(Date.UTC(2026, 5, 30)) };

test('aggregate: current when versions match and baseline is fresh', () => {
  const r = aggregate(
    [
      { host: 'claude', baseline: '2.1.161', latest: '2.1.161', source: 'npm' },
      { host: 'codex', baseline: '0.136.0', latest: '0.136.0', source: 'npm' },
    ],
    fresh,
  );
  assert.equal(r.status, 'current');
  assert.equal(r.exitCode, 0);
  assert.equal(r.all_available, true);
});
test('aggregate: patch diff is informational, not failing', () => {
  const r = aggregate(
    [
      { host: 'claude', baseline: '2.1.161', latest: '2.1.163', source: 'npm' },
      { host: 'codex', baseline: '0.136.0', latest: '0.136.0', source: 'npm' },
    ],
    fresh,
  );
  assert.equal(r.status, 'current');
  assert.equal(r.exitCode, 0);
  assert.equal(r.patches.length, 1);
});
test('aggregate: minor drift fails', () => {
  const r = aggregate(
    [
      { host: 'claude', baseline: '2.1.161', latest: '2.1.161', source: 'npm' },
      { host: 'codex', baseline: '0.136.0', latest: '0.137.0', source: 'npm' },
    ],
    fresh,
  );
  assert.equal(r.status, 'drift');
  assert.equal(r.exitCode, 1);
});
test('aggregate: major drift fails', () => {
  const r = aggregate([{ host: 'claude', baseline: '2.1.161', latest: '3.0.0', source: 'npm' }], fresh);
  assert.equal(r.status, 'drift');
  assert.equal(r.exitCode, 1);
});
test('aggregate: stale baseline fails', () => {
  const r = aggregate(
    [
      { host: 'claude', baseline: '2.1.161', latest: '2.1.161', source: 'npm' },
      { host: 'codex', baseline: '0.136.0', latest: '0.136.0', source: 'npm' },
    ],
    stale,
  );
  assert.equal(r.status, 'stale');
  assert.equal(r.exitCode, 1);
});
test('aggregate: drift + stale combine', () => {
  const r = aggregate([{ host: 'codex', baseline: '0.136.0', latest: '0.137.0', source: 'npm' }], stale);
  assert.equal(r.status, 'drift+stale');
  assert.equal(r.exitCode, 1);
});
test('aggregate: all sources unavailable + fresh → source-unavailable, exit 0', () => {
  const r = aggregate(
    [
      { host: 'claude', baseline: '2.1.161', latest: null, error: 'npm fail; github fail' },
      { host: 'codex', baseline: '0.136.0', latest: null, error: 'npm fail; github fail' },
    ],
    fresh,
  );
  assert.equal(r.status, 'source-unavailable');
  assert.equal(r.exitCode, 0);
  assert.equal(r.all_available, false);
});
test('aggregate: partial unavailable (one down, other current) → exit 0 but NOT current', () => {
  const r = aggregate(
    [
      { host: 'claude', baseline: '2.1.161', latest: null, error: 'fail' },
      { host: 'codex', baseline: '0.136.0', latest: '0.136.0', source: 'npm' },
    ],
    fresh,
  );
  assert.equal(r.status, 'partial-unavailable');
  assert.equal(r.exitCode, 0);
  assert.equal(r.all_available, false);
});
test('aggregate: one source unavailable but other drifts → drift, exit 1 (no masking)', () => {
  const r = aggregate(
    [
      { host: 'claude', baseline: '2.1.161', latest: null, error: 'fail' },
      { host: 'codex', baseline: '0.136.0', latest: '0.137.0', source: 'npm' },
    ],
    fresh,
  );
  assert.equal(r.status, 'drift');
  assert.equal(r.exitCode, 1);
});
test('aggregate: all unavailable but stale → still fails (staleness is fetch-independent)', () => {
  const r = aggregate([{ host: 'claude', baseline: '2.1.161', latest: null, error: 'fail' }], stale);
  assert.equal(r.exitCode, 1);
  assert.ok(r.status.includes('stale'));
});

// ── fetchers (mock httpGet) ──────────────────────────────────────────────────
test('fetchNpmLatest reads latest from the dist-tags endpoint', async () => {
  const httpGet = async (url) => {
    assert.ok(url.endsWith('/dist-tags'), 'uses the small dist-tags endpoint, not the full packument');
    return JSON.stringify({ latest: '2.1.163', stable: '2.1.153' });
  };
  assert.equal(await fetchNpmLatest('@anthropic-ai/claude-code', { httpGet }), '2.1.163');
});
test('fetchNpmLatest throws SCHEMA when latest is missing', async () => {
  const httpGet = async () => JSON.stringify({ beta: '0.1.0' });
  await assert.rejects(fetchNpmLatest('@x/y', { httpGet }), { code: 'SCHEMA' });
});
test('fetchNpmLatest throws SCHEMA on invalid JSON', async () => {
  const httpGet = async () => 'not json at all';
  await assert.rejects(fetchNpmLatest('@x/y', { httpGet }), { code: 'SCHEMA' });
});
test('fetchNpmLatest throws SCHEMA on unparseable latest', async () => {
  const httpGet = async () => JSON.stringify({ latest: 'banana' });
  await assert.rejects(fetchNpmLatest('@x/y', { httpGet }), { code: 'SCHEMA' });
});
test('fetchGithubLatest prefers release.name over tag_name', async () => {
  const httpGet = async () => JSON.stringify({ name: '0.137.0', tag_name: 'rust-v0.137.0' });
  assert.equal(await fetchGithubLatest('openai/codex', { httpGet }), '0.137.0');
});
test('fetchHostLatest falls back to GitHub on a transient npm failure', async () => {
  const httpGet = async (url) => {
    if (url.includes('registry.npmjs.org')) {
      throw Object.assign(new Error('HTTP 500'), { code: 'HTTP', status: 500 });
    }
    return JSON.stringify({ name: '0.137.0', tag_name: 'rust-v0.137.0' });
  };
  const r = await fetchHostLatest({ host: 'codex', npmPkg: '@openai/codex', githubRepo: 'openai/codex' }, { httpGet });
  assert.equal(r.latest, '0.137.0');
  assert.equal(r.source, 'github');
});
test('fetchHostLatest: fatal npm error (404) short-circuits, NO GitHub fallback', async () => {
  let githubCalled = false;
  const httpGet = async (url) => {
    if (url.includes('registry.npmjs.org')) {
      throw Object.assign(new Error('HTTP 404'), { code: 'HTTP', status: 404 });
    }
    githubCalled = true;
    return JSON.stringify({ name: '0.137.0' });
  };
  const r = await fetchHostLatest({ host: 'codex', npmPkg: '@x/y', githubRepo: 'o/r' }, { httpGet });
  assert.equal(r.fatal, true);
  assert.equal(r.latest, null);
  assert.equal(githubCalled, false); // a config/schema error must not fall back
});
test('fetchHostLatest: fatal npm SCHEMA error short-circuits', async () => {
  const httpGet = async (url) => (url.includes('registry.npmjs.org') ? JSON.stringify({}) : JSON.stringify({ name: '0.137.0' }));
  const r = await fetchHostLatest({ host: 'codex', npmPkg: '@x/y', githubRepo: 'o/r' }, { httpGet });
  assert.equal(r.fatal, true);
});
test('fetchHostLatest: both transient failures → unavailable (fatal false)', async () => {
  const httpGet = async () => {
    throw Object.assign(new Error('request timeout'), { code: 'TIMEOUT' });
  };
  const r = await fetchHostLatest({ host: 'codex', npmPkg: 'a', githubRepo: 'b' }, { httpGet });
  assert.equal(r.latest, null);
  assert.equal(r.fatal, false);
  assert.ok(r.error);
});

// ── runCheck (integration: mock httpGet + temp baseline) ─────────────────────
test('runCheck: missing baseline version → error, exit 2', async () => {
  await withBaseline('# Baseline\nObserved on 2026-06-03 with nothing parseable.\n', async (path) => {
    const r = await runCheck({ baselinePath: path, httpGet: async () => '{}', now: new Date(Date.UTC(2026, 5, 5)) });
    assert.equal(r.status, 'error');
    assert.equal(r.exitCode, 2);
  });
});
test('runCheck: malformed observed date → error, exit 2', async () => {
  await withBaseline(baselineFixture('2.1.161', '0.136.0', '2026-13-40'), async (path) => {
    const r = await runCheck({ baselinePath: path, httpGet: async () => '{}', now: new Date(Date.UTC(2026, 5, 5)) });
    assert.equal(r.exitCode, 2);
  });
});
test('runCheck: unreadable baseline path → error, exit 2', async () => {
  const r = await runCheck({ baselinePath: '/nonexistent/no-such-baseline.md', httpGet: async () => '{}', now: new Date() });
  assert.equal(r.exitCode, 2);
});
test('runCheck: fatal upstream (schema) → error, exit 2 (gate fails loudly)', async () => {
  await withBaseline(baselineFixture('2.1.161', '0.136.0', '2026-06-03'), async (path) => {
    const httpGet = async () => JSON.stringify({}); // missing latest → SCHEMA → fatal
    const r = await runCheck({ baselinePath: path, httpGet, now: new Date(Date.UTC(2026, 5, 5)) });
    assert.equal(r.status, 'error');
    assert.equal(r.exitCode, 2);
  });
});
test('runCheck: drift detected end-to-end', async () => {
  await withBaseline(baselineFixture('2.1.161', '0.136.0', '2026-06-03'), async (path) => {
    const httpGet = async (url) =>
      url.includes('claude-code')
        ? JSON.stringify({ latest: '2.1.161' })
        : JSON.stringify({ latest: '0.137.0' });
    const r = await runCheck({ baselinePath: path, httpGet, now: new Date(Date.UTC(2026, 5, 5)) });
    assert.equal(r.status, 'drift');
    assert.equal(r.exitCode, 1);
  });
});

// ── real baseline smoke (guards against header-format drift) ─────────────────
test('the committed baseline header is parseable by both parsers', async () => {
  const realPath = resolve(HERE, '../../plugins/runtime/docs/host-parity-baseline.md');
  const text = await readFile(realPath, 'utf8');
  assert.ok(parseObservedDate(text), 'observed-on date parses from the real baseline');
  const { extractBaselineVersions } = await import('../../plugins/runtime/scripts/compat.mjs');
  const versions = extractBaselineVersions(text);
  assert.ok(versions.claude.version, 'claude baseline version parses');
  assert.ok(versions.codex.version, 'codex baseline version parses');
});

// ── CLI subprocess smoke (exit-code mapping, no network: parse-error path) ───
test('CLI: --format json maps the error verdict to exit code 2', async () => {
  await withBaseline('# Baseline\nObserved on 2026-06-03 with nothing parseable.\n', async (path) => {
    let stdout = '';
    let code = 0;
    try {
      ({ stdout } = await execFileAsync('node', [SCRIPT, '--format', 'json', '--baseline-path', path]));
    } catch (err) {
      stdout = err.stdout ?? '';
      code = err.code;
    }
    assert.equal(code, 2);
    const json = JSON.parse(stdout);
    assert.equal(json.status, 'error');
    assert.equal(json.exitCode, 2);
  });
});
