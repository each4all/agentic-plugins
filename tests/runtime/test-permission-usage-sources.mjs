import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PERMISSION_DIAGNOSIS_MAX_SCAN,
  collectUsageRecordSources,
} from '../../plugins/runtime/scripts/lib/permission-usage-sources.mjs';
import { collectUsageRecordSources as doctorReExport } from '../../plugins/runtime/scripts/doctor.mjs';

// machine-bootstrap-contract.md §1.3 — the usage-record enumerator was lifted out of
// scripts/doctor.mjs so a planner can reach the scan without importing the host-CLI
// diagnostic module. These tests pin the lift itself: doctor's public surface still
// resolves to the SAME function (a copy would drift), the enumerator still honors its
// hardening contract from its new home, and its closure never reaches back into doctor.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPTS = join(REPO_ROOT, 'plugins/runtime/scripts');
const SOURCES = join(SCRIPTS, 'lib/permission-usage-sources.mjs');

const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

// Semicolon-agnostic, mirroring test-consensus-probe-boundary.mjs — a semicolonless
// `import x from './y.mjs'` must not slip past the scan.
function parseImports(code) {
  const out = [];
  for (const m of code.matchAll(/^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm)) out.push(m[2]);
  for (const m of code.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1]);
  return out;
}

async function localClosure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const code = stripComments(await readFile(path, 'utf8'));
    for (const spec of parseImports(code)) {
      if (spec.startsWith('.')) queue.push(resolve(dirname(path), spec));
    }
  }
  return seen;
}

async function seedRecords(home, { claudeFiles = [], codexFiles = [], codexHome = null } = {}) {
  const claudeDir = join(home, '.claude', 'projects', 'proj-a');
  await mkdir(claudeDir, { recursive: true });
  for (const [name, body] of claudeFiles) await writeFile(join(claudeDir, name), body);

  const codexRoot = codexHome ?? join(home, '.codex');
  const codexDir = join(codexRoot, 'sessions', '2026', '07');
  await mkdir(codexDir, { recursive: true });
  for (const [name, body] of codexFiles) await writeFile(join(codexDir, name), body);
}

describe('permission usage sources §1.3: the lift itself', () => {
  it('doctor re-exports the SAME function object — not a drifting copy', () => {
    strictEqual(doctorReExport, collectUsageRecordSources);
  });

  it('exports the scan budget doctor renders in its operator-visible limits text', () => {
    strictEqual(PERMISSION_DIAGNOSIS_MAX_SCAN, 20000);
  });

  it('never reaches doctor.mjs or the host-CLI probe from its closure', async () => {
    const closure = await localClosure(SOURCES);
    for (const forbidden of ['doctor.mjs', 'machine-probe.mjs', 'settings.mjs']) {
      ok(
        ![...closure].some((p) => p.endsWith(`/${forbidden}`)),
        `${forbidden} must not be reachable from permission-usage-sources.mjs (§1.1) — closure: ${[...closure].map((p) => p.replace(SCRIPTS, '')).join(', ')}`,
      );
    }
  });

  it('spawns no subprocess — the enumerator is a filesystem read, never a host CLI call', async () => {
    const closure = await localClosure(SOURCES);
    for (const path of closure) {
      const code = stripComments(await readFile(path, 'utf8'));
      ok(!/from\s+['"]node:child_process['"]/.test(code), `${path} must not import node:child_process`);
    }
  });
});

describe('permission usage sources §1.3: enumeration contract survives the move', () => {
  it('enumerates both hosts most-recent-first and reports per-host scan counts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'usage-sources-'));
    await seedRecords(home, {
      claudeFiles: [['a.jsonl', '{}'], ['b.jsonl', '{}'], ['ignored.txt', 'x']],
      codexFiles: [['rollout-1.jsonl', '{}'], ['not-a-rollout.jsonl', '{}']],
    });

    const out = await collectUsageRecordSources({ homeDir: home, env: {}, maxFiles: 100, maxFileBytes: 1024 });

    strictEqual(out.scanned.claude.found, 2, 'only .jsonl transcripts count');
    strictEqual(out.scanned.codex.found, 1, 'only rollout-*.jsonl count');
    strictEqual(out.capped, false);
    deepStrictEqual(
      [...new Set(out.sources.map((s) => s.host))].sort(),
      ['claude', 'codex'],
    );
  });

  it('resolves $CODEX_HOME rather than hardcoding ~/.codex', async () => {
    const home = await mkdtemp(join(tmpdir(), 'usage-sources-env-'));
    const altCodex = await mkdtemp(join(tmpdir(), 'alt-codex-'));
    await seedRecords(home, { codexFiles: [['rollout-9.jsonl', '{}']], codexHome: altCodex });

    const viaEnv = await collectUsageRecordSources({ homeDir: home, env: { CODEX_HOME: altCodex }, maxFiles: 100, maxFileBytes: 1024 });
    strictEqual(viaEnv.scanned.codex.found, 1, 'the alternate CODEX_HOME is scanned');

    const viaDefault = await collectUsageRecordSources({ homeDir: home, env: {}, maxFiles: 100, maxFileBytes: 1024 });
    strictEqual(viaDefault.scanned.codex.found, 0, 'the default ~/.codex is empty — no cross-talk');
  });

  it('caps per host and reports the cap rather than truncating silently', async () => {
    const home = await mkdtemp(join(tmpdir(), 'usage-sources-cap-'));
    await seedRecords(home, { claudeFiles: [['a.jsonl', '{}'], ['b.jsonl', '{}'], ['c.jsonl', '{}']] });

    const out = await collectUsageRecordSources({ homeDir: home, env: {}, maxFiles: 2, maxFileBytes: 1024 });
    strictEqual(out.scanned.claude.found, 3);
    strictEqual(out.scanned.claude.used, 2);
    strictEqual(out.capped, true, 'a cap is never silent');
  });

  it('skips and counts oversized records instead of reading them', async () => {
    const home = await mkdtemp(join(tmpdir(), 'usage-sources-big-'));
    await seedRecords(home, { claudeFiles: [['small.jsonl', '{}'], ['huge.jsonl', 'x'.repeat(5000)]] });

    const out = await collectUsageRecordSources({ homeDir: home, env: {}, maxFiles: 100, maxFileBytes: 1024 });
    strictEqual(out.scanned.claude.found, 1, 'the oversized record is not enumerated');
    strictEqual(out.scanned.claude.skipped_too_large, 1, 'and it is counted, not dropped silently');
  });

  it('does not follow a symlinked record root', async () => {
    const home = await mkdtemp(join(tmpdir(), 'usage-sources-link-'));
    const real = await mkdtemp(join(tmpdir(), 'usage-sources-real-'));
    await mkdir(join(real, 'proj'), { recursive: true });
    await writeFile(join(real, 'proj', 'a.jsonl'), '{}');
    await mkdir(join(home, '.claude'), { recursive: true });
    await symlink(real, join(home, '.claude', 'projects'));

    const out = await collectUsageRecordSources({ homeDir: home, env: {}, maxFiles: 100, maxFileBytes: 1024 });
    strictEqual(out.scanned.claude.found, 0, 'a symlinked projects root is never followed');
  });

  it('degrades a missing record tree to an empty scan rather than throwing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'usage-sources-empty-'));
    const out = await collectUsageRecordSources({ homeDir: home, env: {}, maxFiles: 100, maxFileBytes: 1024 });
    strictEqual(out.scanned.claude.found, 0);
    strictEqual(out.scanned.codex.found, 0);
    deepStrictEqual(out.sources, []);
  });
});
