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
  parseMarketplaceRegistration,
  readRegisteredMarketplaceCatalog,
  CANONICAL_MARKETPLACE,
} from '../../plugins/runtime/scripts/lib/machine-probe.mjs';

const MODULE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../plugins/runtime/scripts/lib/machine-probe.mjs');

function okResult(stdout = '', stderr = '') {
  return { ok: true, exit_code: 0, stdout, stderr, error_code: null, timed_out: false };
}
function enoent(command) {
  return { ok: false, exit_code: null, stdout: '', stderr: '', error_code: 'ENOENT', error_message: `spawn ${command} ENOENT`, timed_out: false };
}
// A present CLI whose SUBCOMMAND failed (nonzero exit, no error_code) — an older host
// that lacks `marketplace list` / rejects `--json`. Distinct from ENOENT (whole CLI absent).
function nonzero(stderr = '', exit_code = 1) {
  return { ok: false, exit_code, stdout: '', stderr, error_code: null, timed_out: false };
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
      // The machine probe must not reach the repo-scoped readers doctor keeps.
      for (const forbidden of ['inspectCatalogs', 'inspectSourcePluginState', 'buildPluginMatrix']) {
        ok(!src.includes(forbidden), `machine probe must not reference repo-scoped ${forbidden}`);
      }
      // §1.4.1 legitimately reads a marketplace.json — but ONLY the one AT the registered
      // installLocation (machine-scoped, resolved from the operator's own registration),
      // NEVER a repo/cwd catalog. So the string `marketplace.json` is now allowed, but
      // (a) the catalog reader must be keyed on installLocation, not repoRoot/cwd, and
      // (b) no marketplace.json path may be rooted at a repo/cwd token. This replaces the
      // old blanket `marketplace.json`/`.agents` ban, which conflated the required
      // installLocation read with the forbidden repo read.
      const catalogSig = src.match(/export async function readRegisteredMarketplaceCatalog\(\{([\s\S]*?)\}\s*[=)]/);
      ok(catalogSig, 'readRegisteredMarketplaceCatalog must be exported with a destructured options object');
      ok(/\binstallLocation\b/.test(catalogSig[1]), 'the catalog read must be keyed on installLocation (§1.4.1 machine-scoped authority)');
      ok(!/\brepoRoot\b/.test(catalogSig[1]), 'the catalog read must not accept repoRoot — currentness comes from the registered catalog, not a repo checkout');
      for (const line of src.split(/\r?\n/)) {
        if (!line.includes('marketplace.json')) continue;
        for (const rootToken of ['repoRoot', 'process.cwd', 'probeCwd', 'resolvedRepoRoot']) {
          ok(!line.includes(rootToken), `a marketplace.json read must not be rooted at ${rootToken} — it must be installLocation-scoped (§1.4.1)`);
        }
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
    it('normalizes Claude text rows and Codex json rows to the same {id,version,scope,enabled,ambiguous,observations} shape', async () => {
      const home = await mkdtemp(join(tmpdir(), 'mp-home-'));
      const result = await probeMachineHostState({ homeDir: home, env: {}, runner: fakeRunner(baseProbeMap()) });
      ok(result.installed.claude.length > 0 && result.installed.codex.length > 0, 'both hosts report an installed row');
      // `ambiguous`/`observations` joined the contract shape deliberately: the raw
      // parsers detect a duplicate install and this is the layer bootstrap reads,
      // so dropping them here destroyed the fact before any consumer could see it.
      // They do NOT reach a serialized artifact — `bootstrap.mjs`'s
      // `pluginStatesFor` projects each row down to `{version, state}` — so the
      // addition cannot invalidate a bootstrap-run record.
      const KEYS = ['ambiguous', 'enabled', 'id', 'observations', 'scope', 'version'];
      for (const row of result.installed.claude) deepStrictEqual(Object.keys(row).sort(), KEYS, 'claude rows carry the contract shape');
      for (const row of result.installed.codex) deepStrictEqual(Object.keys(row).sort(), KEYS, 'codex rows carry the same shape');
      deepStrictEqual(
        result.installed.claude.find((r) => r.id === 'engineer'),
        { id: 'engineer', version: '1.2.3', scope: 'user', enabled: true, ambiguous: false, observations: 1 },
      );
      const codexRow = result.installed.codex.find((r) => r.id === 'engineer');
      strictEqual(codexRow.enabled, true);
      strictEqual(codexRow.version, '1.2.3');
    });

    it('carries duplicate-install ambiguity into the normalized rows', async () => {
      // The reason the two fields are in the shape at all, driven rather than
      // asserted structurally. Without this the addition above would be a shape
      // change no test connects to a behaviour.
      const home = await mkdtemp(join(tmpdir(), 'mp-home-'));
      const result = await probeMachineHostState({
        homeDir: home,
        env: {},
        runner: fakeRunner(baseProbeMap({
          'codex plugin list --json': okResult(JSON.stringify({
            installed: [
              { name: 'engineer', marketplaceName: 'agentic-plugins', installed: true, enabled: true, version: '1.2.3' },
              { name: 'engineer', marketplaceName: 'agentic-plugins', installed: true, enabled: false, version: '1.2.3' },
            ],
          })),
        })),
      });
      const row = result.installed.codex.find((r) => r.id === 'engineer');
      strictEqual(row.ambiguous, true, 'the normalized row keeps the ambiguity the parser found');
      strictEqual(row.observations, 2);
      // CONTROL: the Claude side of the same probe saw one install, so the flag is
      // per-row rather than a global switch.
      strictEqual(result.installed.claude.find((r) => r.id === 'engineer').ambiguous, false);
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
          // Marketplace raw stdout must be scrubbed like the plugin lists — a sentinel in
          // a description/source blob must never survive into the facts.
          'claude plugin marketplace list --json': okResult(`[{"name":"agentic-plugins","source":"github","repo":"each4all/agentic-plugins","installLocation":"/x","note":"${SENTINEL}"}]`),
        })),
      });
      const serialized = JSON.stringify(result);
      ok(!serialized.includes(SENTINEL), 'raw CLI stdout/stderr must not appear anywhere in the probe output');
      // The scrubbed cli facts expose status, never the raw stdout blob.
      strictEqual(result.claude.plugin.stdout, undefined, 'raw claude plugin stdout is scrubbed');
      strictEqual(result.claude.plugin.status, 'available');
      strictEqual(result.codex.plugin_list.stdout, undefined, 'raw codex plugin_list stdout is scrubbed');
      strictEqual(result.claude.marketplace.stdout, undefined, 'raw claude marketplace stdout is scrubbed');
      strictEqual(result.claude.marketplace.status, 'available');
    });
  });

  // ---------------------------------------------------------------------------
  // Marketplace-registration probe (machine-bootstrap-contract.md §1.2 / §1.4.1)
  // ---------------------------------------------------------------------------
  describe('marketplace-registration probe', () => {
    const claudeJson = (entries) => okResult(JSON.stringify(entries));

    it('canonical github source → registered + satisfied (source identity, not name)', async () => {
      const home = await mkdtemp(join(tmpdir(), 'mp-home-'));
      const result = await probeMachineHostState({
        homeDir: home,
        env: {},
        runner: fakeRunner(baseProbeMap({
          'claude plugin marketplace list --json': claudeJson([
            { name: 'agentic-plugins', source: 'github', repo: 'each4all/agentic-plugins', installLocation: '/nonexistent/loc' },
          ]),
        })),
      });
      const reg = result.marketplaceRegistration.claude;
      strictEqual(reg.status, 'registered');
      strictEqual(reg.canonical, true);
      strictEqual(reg.source_kind, 'github');
      deepStrictEqual(reg.source_identity, { source: 'github', repo: 'each4all/agentic-plugins' });
      strictEqual(reg.flagged, null);
    });

    it('a github FORK named agentic-plugins → unknown + not satisfied (name proves nothing)', async () => {
      const home = await mkdtemp(join(tmpdir(), 'mp-home-'));
      const result = await probeMachineHostState({
        homeDir: home,
        env: {},
        runner: fakeRunner(baseProbeMap({
          'claude plugin marketplace list --json': claudeJson([
            { name: 'agentic-plugins', source: 'github', repo: 'somefork/agentic-plugins', installLocation: '/x' },
          ]),
        })),
      });
      const reg = result.marketplaceRegistration.claude;
      strictEqual(reg.status, 'unknown');
      strictEqual(reg.canonical, false);
      strictEqual(reg.flagged, 'fork-repo');
    });

    it('a substring near-miss (each4all/agentic-plugins-fork) does NOT match canonical', () => {
      const reg = parseMarketplaceRegistration({
        host: 'claude',
        result: { status: 'available', format: 'json', stdout: JSON.stringify([
          { name: 'agentic-plugins', source: 'github', repo: 'each4all/agentic-plugins-fork', installLocation: '/x' },
        ]) },
      });
      strictEqual(reg.canonical, false, 'anchored slug match rejects the -fork suffix');
      strictEqual(reg.flagged, 'fork-repo');
    });

    it('a directory source named agentic-plugins → registered but flagged (contributor checkout)', async () => {
      const home = await mkdtemp(join(tmpdir(), 'mp-home-'));
      const result = await probeMachineHostState({
        homeDir: home,
        env: {},
        runner: fakeRunner(baseProbeMap({
          'claude plugin marketplace list --json': claudeJson([
            { name: 'agentic-plugins', source: 'directory', path: '/home/dev/agentic-plugins', installLocation: '/home/dev/agentic-plugins' },
          ]),
        })),
      });
      const reg = result.marketplaceRegistration.claude;
      strictEqual(reg.status, 'registered');
      strictEqual(reg.canonical, false);
      strictEqual(reg.source_kind, 'directory');
      strictEqual(reg.flagged, 'directory-source');
    });

    it('subcommand unavailable/failed → unknown (absence of evidence is not registration)', async () => {
      const home = await mkdtemp(join(tmpdir(), 'mp-home-'));
      const result = await probeMachineHostState({
        homeDir: home,
        env: {},
        runner: fakeRunner(baseProbeMap({
          'claude plugin marketplace list --json': nonzero('error: unknown subcommand "marketplace"'),
        })),
      });
      strictEqual(result.marketplaceRegistration.claude.status, 'unknown');
    });

    it('empty registered list → missing (definite absence), not unknown', async () => {
      const home = await mkdtemp(join(tmpdir(), 'mp-home-'));
      const result = await probeMachineHostState({
        homeDir: home,
        env: {},
        runner: fakeRunner(baseProbeMap({
          'claude plugin marketplace list --json': claudeJson([]),
        })),
      });
      strictEqual(result.marketplaceRegistration.claude.status, 'missing');
    });

    it('malformed json → unknown, never a throw', () => {
      const reg = parseMarketplaceRegistration({ host: 'claude', result: { status: 'available', format: 'json', stdout: '{not json' } });
      strictEqual(reg.status, 'unknown');
    });

    describe('catalog read (§1.4.1 currentness authority)', () => {
      it('reads per-plugin versions from the catalog AT installLocation', async () => {
        const home = await mkdtemp(join(tmpdir(), 'mp-home-'));
        const loc = await mkdtemp(join(tmpdir(), 'mp-mploc-'));
        await mkdir(join(loc, '.claude-plugin'), { recursive: true });
        await writeFile(join(loc, '.claude-plugin', 'marketplace.json'), JSON.stringify({
          plugins: [{ name: 'runtime', version: '0.80.1' }, { name: 'engineer', version: '0.21.0' }],
        }));
        const result = await probeMachineHostState({
          homeDir: home,
          env: {},
          runner: fakeRunner(baseProbeMap({
            'claude plugin marketplace list --json': claudeJson([
              { name: 'agentic-plugins', source: 'github', repo: 'each4all/agentic-plugins', installLocation: loc },
            ]),
          })),
        });
        const catalog = result.marketplaceRegistration.claude.catalog;
        strictEqual(catalog.read_status, 'read');
        strictEqual(catalog.versions.runtime, '0.80.1');
        strictEqual(catalog.versions.engineer, '0.21.0');
        strictEqual(catalog.path, join(loc, '.claude-plugin', 'marketplace.json'));
      });

      it('canonical registration + UNREADABLE catalog → still registered, currentness unknown, NO repo fallback', async () => {
        const home = await mkdtemp(join(tmpdir(), 'mp-home-'));
        const result = await probeMachineHostState({
          homeDir: home,
          env: {},
          runner: fakeRunner(baseProbeMap({
            'claude plugin marketplace list --json': claudeJson([
              { name: 'agentic-plugins', source: 'github', repo: 'each4all/agentic-plugins', installLocation: '/nonexistent/loc' },
            ]),
          })),
        });
        const reg = result.marketplaceRegistration.claude;
        strictEqual(reg.status, 'registered', 'registration is independent of catalog readability');
        strictEqual(reg.catalog.read_status, 'unreadable');
        deepStrictEqual(reg.catalog.versions, {}, 'no repo-checkout fallback for versions');
      });

      it('is installLocation-scoped, never cwd/repo (poisoned-catalog)', async () => {
        const home = await mkdtemp(join(tmpdir(), 'mp-home-'));
        // A poison catalog at the caller cwd claims 9.9.9; the probe must ignore it.
        const poisonCwd = await mkdtemp(join(tmpdir(), 'mp-poison-cwd-'));
        await mkdir(join(poisonCwd, '.claude-plugin'), { recursive: true });
        await writeFile(join(poisonCwd, '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'runtime', version: '9.9.9' }] }));
        // The REAL registered installLocation claims 1.0.0.
        const loc = await mkdtemp(join(tmpdir(), 'mp-mploc-'));
        await mkdir(join(loc, '.claude-plugin'), { recursive: true });
        await writeFile(join(loc, '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'runtime', version: '1.0.0' }] }));
        const result = await probeMachineHostState({
          homeDir: home,
          cwd: poisonCwd,
          env: {},
          runner: fakeRunner(baseProbeMap({
            'claude plugin marketplace list --json': claudeJson([
              { name: 'agentic-plugins', source: 'github', repo: 'each4all/agentic-plugins', installLocation: loc },
            ]),
          })),
        });
        strictEqual(result.marketplaceRegistration.claude.catalog.versions.runtime, '1.0.0', 'versions come from installLocation, not the cwd poison catalog');
      });

      it('readRegisteredMarketplaceCatalog: no installLocation → unknown', async () => {
        const catalog = await readRegisteredMarketplaceCatalog({ host: 'claude', installLocation: null });
        strictEqual(catalog.read_status, 'unknown');
        deepStrictEqual(catalog.versions, {});
      });

      it('readRegisteredMarketplaceCatalog: a versionless (Codex) catalog → versionless', async () => {
        const catalog = await readRegisteredMarketplaceCatalog({
          host: 'codex',
          installLocation: '/x',
          readJson: async () => ({ ok: true, json: { plugins: [{ name: 'runtime', source: { path: './plugins/runtime' } }] } }),
        });
        strictEqual(catalog.read_status, 'versionless');
        strictEqual(catalog.versions.runtime, null);
      });
    });

    describe('codex --json and text fallback', () => {
      it('codex --json with a source-backed canonical marketplace → registered', async () => {
        const home = await mkdtemp(join(tmpdir(), 'mp-home-'));
        const result = await probeMachineHostState({
          homeDir: home,
          env: {},
          runner: fakeRunner(baseProbeMap({
            'codex plugin marketplace list --json': okResult(JSON.stringify([
              { name: 'agentic-plugins', source: { sourceType: 'github', source: 'each4all/agentic-plugins' }, root: '/x' },
            ])),
          })),
        });
        const reg = result.marketplaceRegistration.codex;
        strictEqual(reg.status, 'registered');
        strictEqual(reg.canonical, true);
        strictEqual(reg.format, 'json');
      });

      it('a codex local-path source under a .../each4all/agentic-plugins dir is NOT canonical (peer #5)', () => {
        // A local checkout that happens to live under an each4all/agentic-plugins directory
        // must never be read as the canonical github remote — identity ≠ local root.
        const reg = parseMarketplaceRegistration({
          host: 'codex',
          result: { status: 'available', format: 'json', stdout: JSON.stringify([
            { name: 'agentic-plugins', source: { sourceType: 'local', path: '/home/dev/each4all/agentic-plugins' } },
          ]) },
        });
        strictEqual(reg.canonical, false);
        strictEqual(reg.status, 'unknown', 'a local root is not a resolvable canonical identity');
      });

      it('codex non-empty list with no resolvable canonical source → unknown, not missing', () => {
        const reg = parseMarketplaceRegistration({
          host: 'codex',
          result: { status: 'available', format: 'json', stdout: JSON.stringify([
            { name: 'some-other-marketplace', source: { sourceType: 'github', source: 'acme/widgets' } },
          ]) },
        });
        strictEqual(reg.status, 'unknown');
      });

      it('text fallback (no --json) WITH an explicit canonical slug → registered', async () => {
        const home = await mkdtemp(join(tmpdir(), 'mp-home-'));
        const result = await probeMachineHostState({
          homeDir: home,
          env: {},
          runner: fakeRunner(baseProbeMap({
            'codex plugin marketplace list --json': nonzero('error: unexpected argument --json'),
            'codex plugin marketplace list': okResult('agentic-plugins  github:each4all/agentic-plugins  (registered)\n'),
          })),
        });
        const reg = result.marketplaceRegistration.codex;
        strictEqual(reg.status, 'registered');
        strictEqual(reg.canonical, true);
        strictEqual(reg.format, 'text');
      });

      it('text fallback with only a NAME / local root → unknown (name is not identity)', async () => {
        const home = await mkdtemp(join(tmpdir(), 'mp-home-'));
        const result = await probeMachineHostState({
          homeDir: home,
          env: {},
          runner: fakeRunner(baseProbeMap({
            'codex plugin marketplace list --json': nonzero('error: unexpected argument --json'),
            'codex plugin marketplace list': okResult('agentic-plugins  (local)\n/home/u/agentic-plugins\n'),
          })),
        });
        strictEqual(result.marketplaceRegistration.codex.status, 'unknown');
      });
    });

    it('CANONICAL_MARKETPLACE is exported as the github each4all/agentic-plugins identity', () => {
      deepStrictEqual(CANONICAL_MARKETPLACE, { source: 'github', repo: 'each4all/agentic-plugins' });
    });
  });

  // -------------------------------------------------------------------------
  // Duplicate-install ambiguity (ADR-0053 §Decision 5, via ADR-0054's matcher)
  // -------------------------------------------------------------------------
  //
  // Both parsers used to COLLAPSE a repeated plugin name — Claude's by
  // overwriting the map entry, Codex's by keeping the "strongest" install
  // state. One defect in two places, and the pair is tested together for that
  // reason: fixing one and leaving the mirror is exactly how a repaired hole
  // stays open somewhere else.
  //
  // These drive the whole probe rather than the parsers directly, because the
  // parsers are private and the fields have to survive the trip out.
  describe('duplicate-install ambiguity is preserved, not collapsed', () => {
    const claudeDuplicate = (a, b) => 'Installed plugins:\n\n'
      + `  > runtime@agentic-plugins\n    Version: ${a.version}\n    Scope: user\n    Status: ${a.status}\n`
      + `  > runtime@agentic-plugins\n    Version: ${b.version}\n    Scope: project\n    Status: ${b.status}\n`;

    const codexDuplicate = (a, b) => JSON.stringify({
      installed: [
        { name: 'runtime', marketplaceName: 'agentic-plugins', installed: true, enabled: a.enabled, version: a.version },
        { name: 'runtime', marketplaceName: 'agentic-plugins', installed: true, enabled: b.enabled, version: b.version },
      ],
    });

    async function probe(overrides) {
      const home = await mkdtemp(join(tmpdir(), 'mp-home-'));
      return probeMachineHostState({ homeDir: home, env: {}, runner: fakeRunner(baseProbeMap(overrides)) });
    }

    it('CONTROL: a single install is one observation and is not ambiguous', async () => {
      // Without this the ambiguity assertions below could pass against a parser
      // that marks everything ambiguous, which would block every machine.
      const result = await probe({});
      strictEqual(result.claudePluginList.engineer.observations, 1);
      strictEqual(result.claudePluginList.engineer.ambiguous, false);
      strictEqual(result.codexPluginList.entries.engineer.observations, 1);
      strictEqual(result.codexPluginList.entries.engineer.ambiguous, false);
    });

    it('Claude: two scopes at DIFFERENT versions is ambiguous', async () => {
      const result = await probe({
        'claude plugin list': okResult(claudeDuplicate({ version: '0.91.0', status: 'enabled' }, { version: '0.90.3', status: 'enabled' })),
      });
      strictEqual(result.claudePluginList.runtime.observations, 2);
      strictEqual(result.claudePluginList.runtime.ambiguous, true);
      // Last-wins is PRESERVED for the primary entry, so every existing
      // consumer reads exactly what it read before the ambiguity field existed.
      strictEqual(result.claudePluginList.runtime.version, '0.90.3');
      strictEqual(result.claudePluginList.runtime.scope, 'project');
    });

    it('Claude: two scopes AGREEING is two observations and not ambiguous', async () => {
      // Ambiguity is about the ANSWER, not the row count. Two rows agreeing
      // leave "which version is active" with one answer, and over-blocking is a
      // defect too.
      const result = await probe({
        'claude plugin list': okResult(claudeDuplicate({ version: '0.91.0', status: 'enabled' }, { version: '0.91.0', status: 'enabled' })),
      });
      strictEqual(result.claudePluginList.runtime.observations, 2);
      strictEqual(result.claudePluginList.runtime.ambiguous, false);
    });

    it('Claude: same version, DISAGREEING status is ambiguous', async () => {
      const result = await probe({
        'claude plugin list': okResult(claudeDuplicate({ version: '0.91.0', status: 'enabled' }, { version: '0.91.0', status: 'failed' })),
      });
      strictEqual(result.claudePluginList.runtime.ambiguous, true);
    });

    it('Codex: the MIRROR — a duplicate whose enabled state differs is ambiguous', async () => {
      // The Codex side resolved a disagreement OPTIMISTICALLY (an `enabled` row
      // outranks the `disabled` row beside it), which is worse than last-wins
      // for a coverage decision: ADR-0053 §Decision 8 makes "is disabled" an
      // invalidation, so ranking it away discards the fact the matcher needs.
      const result = await probe({
        'codex plugin list --json': okResult(codexDuplicate({ version: '0.91.0', enabled: true }, { version: '0.91.0', enabled: false })),
      });
      strictEqual(result.codexPluginList.entries.runtime.observations, 2);
      strictEqual(result.codexPluginList.entries.runtime.ambiguous, true);
      // The pre-existing behaviour is untouched: the strongest state is still
      // the kept entry, and the warning is still emitted.
      strictEqual(result.codexPluginList.entries.runtime.status, 'enabled');
      ok(
        result.codexPluginList.warnings.some((warning) => /duplicate agentic-plugins entry for runtime/.test(warning)),
        'the existing duplicate warning still fires',
      );
    });

    it('Codex: a duplicate in full AGREEMENT is not ambiguous', async () => {
      const result = await probe({
        'codex plugin list --json': okResult(codexDuplicate({ version: '0.91.0', enabled: true }, { version: '0.91.0', enabled: true })),
      });
      strictEqual(result.codexPluginList.entries.runtime.observations, 2);
      strictEqual(result.codexPluginList.entries.runtime.ambiguous, false);
    });

    it('a DISAGREEING duplicate is reported ambiguous — the fact a consumer must refuse on', async () => {
      // ⚠ THIS TEST USED TO RUN END TO END THROUGH `matchAssurance`, and that
      // consumer was removed with the assurance plane (ADR-0056 §Decision 1).
      // The producer property it existed to protect is unchanged and still has
      // exactly one job — telling a reader that the host reported two different
      // answers for one package — so the assertion moved DOWN to the producer
      // rather than being deleted along with its consumer. The ONLY difference
      // between the two cases below is whether the two observed rows agree.
      const disagreeing = await probe({
        'claude plugin list': okResult(claudeDuplicate({ version: '0.91.0', status: 'enabled' }, { version: '0.90.3', status: 'enabled' })),
        'codex plugin list --json': okResult(codexDuplicate({ version: '0.91.0', enabled: true }, { version: '0.90.3', enabled: true })),
      });
      // ⚠ THE TWO READERS HAVE DIFFERENT SHAPES — Claude's entries hang off the
      // list object directly, Codex's off `.entries`. Writing `.entries` for
      // both was a real slip here and it threw rather than passing, which is the
      // only reason it is worth a note: a shape mismatch that reads `undefined`
      // into a falsy assertion would have passed silently.
      strictEqual(disagreeing.claudePluginList.runtime.observations, 2);
      strictEqual(disagreeing.claudePluginList.runtime.ambiguous, true);
      strictEqual(disagreeing.codexPluginList.entries.runtime.observations, 2);
      strictEqual(disagreeing.codexPluginList.entries.runtime.ambiguous, true);
    });
  });
});

// A cache directory's manifest must NAME the plugin the directory claims.
// Cross-host review found `manifest_name` recorded and never checked: a
// .../agentic-plugins/runtime/<v>/ whose manifest says `{"name":"engineer"}` was
// admitted as a runtime install, and with the Codex list unavailable a cutover
// version row could be satisfied from it. `session-readiness.mjs`'s sibling
// scanner already refused exactly this and says why, so the two now agree.
describe('cache scan binds a manifest to the plugin it was asked about', () => {
  async function homeWithClaudeCache(plugin, manifest) {
    const home = await mkdtemp(join(tmpdir(), 'mp-home-'));
    const dir = join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', plugin, '0.90.3', '.claude-plugin');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest));
    return home;
  }

  it('CONTROL: a matching manifest is admitted', async () => {
    const home = await homeWithClaudeCache('runtime', { name: 'runtime', version: '0.90.3' });
    const result = await probeMachineHostState({ homeDir: home, env: {}, runner: fakeRunner(baseProbeMap()) });
    strictEqual(result.caches.claude.runtime.status, 'available');
    strictEqual(result.caches.claude.runtime.latest.manifest_version, '0.90.3');
  });

  it('a manifest naming a DIFFERENT plugin is not an install of this one', async () => {
    const home = await homeWithClaudeCache('runtime', { name: 'engineer', version: '0.90.3' });
    const result = await probeMachineHostState({ homeDir: home, env: {}, runner: fakeRunner(baseProbeMap()) });
    strictEqual(result.caches.claude.runtime.status, 'not_installed', 'a mis-named manifest is not a runtime install');
    deepStrictEqual(result.caches.claude.runtime.versions, []);
    strictEqual(result.caches.claude.runtime.latest, null);
  });

  it('a manifest with no name at all is likewise not an install', async () => {
    const home = await homeWithClaudeCache('runtime', { version: '0.90.3' });
    const result = await probeMachineHostState({ homeDir: home, env: {}, runner: fakeRunner(baseProbeMap()) });
    strictEqual(result.caches.claude.runtime.status, 'not_installed');
  });
});
