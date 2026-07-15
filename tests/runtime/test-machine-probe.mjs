// Gate for the machine-only host probe seam (lib/machine-probe.mjs).
//
// `runDoctor` used to inline every machine-only host read (host CLI presence/auth/
// feature-surface, installed rows, plugin cache, observed Codex hook config) alongside
// its repo-scoped enrichment (source manifests, catalogs, host parity, proofs). The
// machine-bootstrap contract (machine-bootstrap-contract.md §1.1) requires ONE pure
// machine probe so bootstrap can reason about the operator's machine WITHOUT ever
// touching the agentic-plugins source tree, and so runDoctor sources its machine half
// from that one implementation rather than a drifting second copy.
//
// These assertions pin the four peer-verified correctness requirements the seam exists
// to enforce: no repo read, $CODEX_HOME honored (every former hardcode), neutral cwd,
// one normalized installed-row shape, and no raw CLI stdout leaking into the facts.

import { describe, it } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  probeMachineHostState,
  resolveCodexHome,
} from '../../plugins/runtime/scripts/lib/machine-probe.mjs';

const MODULE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../plugins/runtime/scripts/lib/machine-probe.mjs');

function okResult(stdout = '', stderr = '') {
  return { ok: true, exit_code: 0, stdout, stderr, error_code: null, timed_out: false };
}
function enoent(command) {
  return { ok: false, exit_code: null, stdout: '', stderr: '', error_code: 'ENOENT', error_message: `spawn ${command} ENOENT`, timed_out: false };
}
function fakeRunner(map) {
  return async (command, args) => map[`${command} ${args.join(' ')}`] ?? enoent(command);
}

// A source scan must read CODE, not prose — this module's header legitimately NAMES the
// repo-scoped readers it deliberately does NOT reach (the peer-execution-context test does
// the same). Scanning the raw text would match those explanatory mentions.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const CLAUDE_LIST = 'Installed plugins:\n\n  > engineer@agentic-plugins\n    Version: 1.2.3\n    Scope: user\n    Status: enabled\n';
const CODEX_LIST_JSON = JSON.stringify({
  installed: [{ name: 'engineer', marketplaceName: 'agentic-plugins', installed: true, enabled: true, version: '1.2.3' }],
});

function baseProbeMap(overrides = {}) {
  return {
    'claude --version': okResult('2.1.140 (Claude Code)\n'),
    'claude --help': okResult('Usage: claude\nCommands:\n  auth status\n  plugin list\n'),
    'claude auth status': okResult(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })),
    'claude plugin --help': okResult('Commands:\n  install\n  list\n  update\n  uninstall\n'),
    'claude plugin list': okResult(CLAUDE_LIST),
    'claude /plugin list': okResult('Installed plugins:\n'),
    'codex --version': okResult('codex-cli 0.137.0\n'),
    'codex --help': okResult('Commands:\n  exec Run Codex non-interactively\n  login status\n  plugin\nOptions:\n  --model\n  --config\n  --cd\n  --sandbox\n  --ask-for-approval\n'),
    'codex exec --help': okResult('Usage: codex exec\n'),
    'codex features list': okResult('hooks stable true\nplugins stable true\n'),
    'codex login status': okResult('Logged in using ChatGPT\n'),
    'codex plugin marketplace --help': okResult('Commands:\n  add\n  list\n'),
    'codex plugin --help': okResult('Commands:\n  add\n  list\n  remove\n'),
    'codex plugin list --json': okResult(CODEX_LIST_JSON),
    ...overrides,
  };
}

describe('machine host probe (machine-only seam)', () => {
  describe('probe-does-not-read-repo', () => {
    it('has no repoRoot seam and never references the repo catalog/source readers (structural)', async () => {
      const src = stripComments(await readFile(MODULE_PATH, 'utf8'));
      const sig = src.match(/export async function probeMachineHostState\(\{([\s\S]*?)\}\s*=/);
      ok(sig, 'probeMachineHostState must be exported with a destructured options object');
      ok(!/\brepoRoot\b/.test(sig[1]), 'the probe must not accept repoRoot — a machine answer must not depend on which repo invoked it');
      // The machine probe must not reach the repo-scoped readers/catalogs doctor keeps.
      for (const forbidden of ['inspectCatalogs', 'inspectSourcePluginState', 'marketplace.json', "'.agents'", 'buildPluginMatrix']) {
        ok(!src.includes(forbidden), `machine probe must not reference repo-scoped ${forbidden}`);
      }
    });

    it('produces machine facts from home + runner alone, with no repo input (seam)', async () => {
      const home = await mkdtemp(join(tmpdir(), 'mp-home-'));
      const seen = [];
      const runner = async (command, args, options = {}) => { seen.push({ command, cwd: options.cwd }); return fakeRunner(baseProbeMap())(command, args); };
      const result = await probeMachineHostState({ homeDir: home, env: {}, runner });
      ok(result.claude && result.codex, 'the probe returns both host CLI facts from home + runner alone');
      ok(seen.some((c) => c.command === 'claude') && seen.some((c) => c.command === 'codex'), 'the probe ran both host CLIs');
      ok(Array.isArray(result.installed.claude) && Array.isArray(result.installed.codex), 'the probe returns normalized installed rows');
    });
  });

  describe('codex-home-honored', () => {
    it('reads $CODEX_HOME config.toml and caches, not ~/.codex, covering the former hardcodes', async () => {
      const home = await mkdtemp(join(tmpdir(), 'mp-home-'));
      const codexHome = await mkdtemp(join(tmpdir(), 'mp-codexhome-'));

      // Poison ~/.codex so any residual `join(homeDir, '.codex', …)` hardcode would surface it.
      await mkdir(join(home, '.codex'), { recursive: true });
      await writeFile(join(home, '.codex', 'config.toml'), [
        '[hooks.state]', '',
        '[hooks.state."poison@agentic-plugins:hooks/hooks.json:stop:0:0"]', 'trusted_hash = "sha256:poison"', '',
      ].join('\n'));
      const poisonCache = join(home, '.codex', 'plugins', 'cache', 'agentic-plugins', 'engineer', '9.9.9', '.codex-plugin');
      await mkdir(poisonCache, { recursive: true });
      await writeFile(join(poisonCache, 'plugin.json'), JSON.stringify({ name: 'engineer', version: '9.9.9' }));

      // The REAL $CODEX_HOME the probe must honor.
      await writeFile(join(codexHome, 'config.toml'), [
        '[hooks.state]', '',
        '[hooks.state."engineer@agentic-plugins:hooks/hooks.json:stop:0:0"]', 'trusted_hash = "sha256:real"', '',
      ].join('\n'));
      const realCache = join(codexHome, 'plugins', 'cache', 'agentic-plugins', 'engineer', '1.0.0', '.codex-plugin');
      await mkdir(realCache, { recursive: true });
      await writeFile(join(realCache, 'plugin.json'), JSON.stringify({ name: 'engineer', version: '1.0.0' }));

      const result = await probeMachineHostState({ homeDir: home, codexHome, env: {}, runner: fakeRunner(baseProbeMap()) });

      // Former hardcode #1 (config.toml, doctor.mjs buildCodexHookStateReport).
      strictEqual(result.codexHookConfig.config_path, join(codexHome, 'config.toml'));
      ok(result.codexHookConfig.entries.some((e) => e.plugin === 'engineer'), 'reads the engineer hook row from $CODEX_HOME');
      ok(!result.codexHookConfig.entries.some((e) => e.plugin === 'poison'), 'must not read the ~/.codex poison config');
      // Former hardcode #2 (plugin cache, doctor.mjs inspectPluginCaches).
      strictEqual(result.caches.codex.engineer.latest.manifest_version, '1.0.0', 'cache scan honors $CODEX_HOME, not ~/.codex');
    });

    it('resolves $CODEX_HOME from env when codexHome is not passed', async () => {
      const home = await mkdtemp(join(tmpdir(), 'mp-home-'));
      const codexHome = await mkdtemp(join(tmpdir(), 'mp-codexhome-'));
      await writeFile(join(codexHome, 'config.toml'), '[hooks.state]\n\n[hooks.state."engineer@agentic-plugins:hooks/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:real"\n');
      const result = await probeMachineHostState({ homeDir: home, env: { CODEX_HOME: codexHome }, runner: fakeRunner(baseProbeMap()) });
      strictEqual(result.codexHookConfig.config_path, join(codexHome, 'config.toml'));
    });

    it('resolveCodexHome honors env.CODEX_HOME, else ~/.codex', () => {
      strictEqual(resolveCodexHome({ CODEX_HOME: '/x/codex' }, '/home/u'), resolve('/x/codex'));
      strictEqual(resolveCodexHome({}, '/home/u'), join('/home/u', '.codex'));
    });
  });

  describe('neutral-cwd', () => {
    it('runs host CLIs in a neutral cwd (never the caller repo / process.cwd)', async () => {
      const home = await mkdtemp(join(tmpdir(), 'mp-home-'));
      const seen = [];
      const runner = async (command, args, options = {}) => { seen.push({ command, cwd: options.cwd }); return fakeRunner(baseProbeMap())(command, args); };
      await probeMachineHostState({ homeDir: home, env: {}, runner });
      const hostCalls = seen.filter((c) => c.command === 'claude' || c.command === 'codex');
      ok(hostCalls.length > 0, 'the probe invoked the host CLIs');
      for (const c of hostCalls) {
        ok(c.cwd !== process.cwd(), `host CLI must not run in the caller repo (got ${c.cwd})`);
        strictEqual(c.cwd, tmpdir(), 'the neutral default cwd is os.tmpdir()');
      }
    });

    it('threads an explicit neutral cwd through to the runner', async () => {
      const home = await mkdtemp(join(tmpdir(), 'mp-home-'));
      const neutral = await mkdtemp(join(tmpdir(), 'mp-neutral-'));
      const seen = [];
      const runner = async (command, args, options = {}) => { seen.push({ command, cwd: options.cwd }); return fakeRunner(baseProbeMap())(command, args); };
      await probeMachineHostState({ homeDir: home, cwd: neutral, env: {}, runner });
      for (const c of seen.filter((c) => c.command === 'claude' || c.command === 'codex')) strictEqual(c.cwd, neutral);
    });
  });

  describe('normalized-shape', () => {
    it('normalizes Claude text rows and Codex json rows to the same {id,version,scope,enabled} shape', async () => {
      const home = await mkdtemp(join(tmpdir(), 'mp-home-'));
      const result = await probeMachineHostState({ homeDir: home, env: {}, runner: fakeRunner(baseProbeMap()) });
      ok(result.installed.claude.length > 0 && result.installed.codex.length > 0, 'both hosts report an installed row');
      const KEYS = ['enabled', 'id', 'scope', 'version'];
      for (const row of result.installed.claude) deepStrictEqual(Object.keys(row).sort(), KEYS, 'claude rows carry the contract shape');
      for (const row of result.installed.codex) deepStrictEqual(Object.keys(row).sort(), KEYS, 'codex rows carry the same shape');
      deepStrictEqual(
        result.installed.claude.find((r) => r.id === 'engineer'),
        { id: 'engineer', version: '1.2.3', scope: 'user', enabled: true },
      );
      const codexRow = result.installed.codex.find((r) => r.id === 'engineer');
      strictEqual(codexRow.enabled, true);
      strictEqual(codexRow.version, '1.2.3');
    });
  });

  describe('no-raw-leak', () => {
    it('keeps raw CLI stdout internal — no multi-line blobs in the returned facts', async () => {
      const home = await mkdtemp(join(tmpdir(), 'mp-home-'));
      const SENTINEL = 'RAW-MULTILINE-SENTINEL-DO-NOT-LEAK';
      const claudeListRaw = `Installed plugins:\n\n  > engineer@agentic-plugins\n    Version: 1.2.3\n    Scope: user\n    Status: enabled\n    ${SENTINEL}\n`;
      const codexListRaw = `${CODEX_LIST_JSON}\nwarning: ${SENTINEL} on stderr echoed to stdout\n`;
      const result = await probeMachineHostState({
        homeDir: home,
        env: {},
        runner: fakeRunner(baseProbeMap({
          'claude plugin list': okResult(claudeListRaw),
          'codex plugin list --json': okResult(CODEX_LIST_JSON, `noise ${SENTINEL}`),
        })),
      });
      const serialized = JSON.stringify(result);
      ok(!serialized.includes(SENTINEL), 'raw CLI stdout/stderr must not appear anywhere in the probe output');
      // The scrubbed cli facts expose status, never the raw stdout blob.
      strictEqual(result.claude.plugin.stdout, undefined, 'raw claude plugin stdout is scrubbed');
      strictEqual(result.claude.plugin.status, 'available');
      strictEqual(result.codex.plugin_list.stdout, undefined, 'raw codex plugin_list stdout is scrubbed');
    });
  });
});
