// Gate for the filesystem-only peer-execution seam (lib/peer-execution-context.mjs).
//
// `consensus.mjs` used to call `runDoctor` to obtain two filesystem-derived values —
// the companion script to spawn, and the model/effort to hand it. That cost ~3.1s of
// host-CLI probing consensus never read, and handed the ambient egress credential to all
// 14 probe processes, the very thing settings.mjs strips before its own runDoctor call.
//
// The seam takes no `env`, no `runner` and no `now`, so it cannot spawn anything. A
// `child_process` source scan is NOT enough to hold that line: the module could import
// doctor's exported `runCommand`/`runDoctor` and probe through them while never naming
// `child_process`. So the import surface itself is pinned.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONTRACT_COMPATIBLE_MAJOR,
  resolvePeerExecutionContext,
} from '../../plugins/runtime/scripts/lib/peer-execution-context.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MODULE_PATH = join(REPO_ROOT, 'plugins/runtime/scripts/lib/peer-execution-context.mjs');

// The seam may reach node builtins and sibling LEAF libs only. Anything else — most of
// all `./doctor.mjs` — would let a probe back in.
const ALLOWED_IMPORTS = new Set([
  'node:fs/promises',
  'node:path',
  './state-readers.mjs',
  './semver.mjs',
]);

// A source scan must read CODE, not prose. This file's own header names both
// `doctor.mjs` and `child_process` in comments; scanning the raw text would match them.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1');  // line comments (leave `https://` alone)
}

function immediateImports(source) {
  const specs = [];
  // `import … from '<spec>';` and bare `import '<spec>';`
  for (const match of source.matchAll(/^\s*import\s[\s\S]*?from\s+['"]([^'"]+)['"];/gm)) specs.push(match[1]);
  for (const match of source.matchAll(/^\s*import\s+['"]([^'"]+)['"];/gm)) specs.push(match[1]);
  return specs;
}

// Canonical temp dirs: the seam returns canonical companion paths, and macOS
// tmpdir sits behind /var -> /private/var.
const canonicalTmp = async (prefix) => realpath(await mkdtemp(join(tmpdir(), prefix)));

async function seedFixture() {
  const repoRoot = await canonicalTmp('peer-ctx-repo-');
  const homeDir = await canonicalTmp('peer-ctx-home-');

  await mkdir(join(repoRoot, 'companions'), { recursive: true });
  await writeFile(join(repoRoot, 'companions', 'contract.md'), '# Companion contract\n\n**Version**: `0.1.1`\n');

  for (const [host, script] of [['.claude', 'codex-companion.mjs'], ['.codex', 'claude-companion.mjs']]) {
    const manifestDir = host === '.claude' ? '.claude-plugin' : '.codex-plugin';
    const base = join(homeDir, host, 'plugins', 'cache', 'agentic-plugins', 'companions', '0.1.0');
    await mkdir(join(base, manifestDir), { recursive: true });
    await mkdir(join(base, 'scripts'), { recursive: true });
    await writeFile(join(base, manifestDir, 'plugin.json'), JSON.stringify({ name: 'companions', version: '0.1.0' }));
    await writeFile(join(base, 'scripts', script), "const CONTRACT_VERSION = '0.1.1'; // --prompt-file\n");
  }
  return { repoRoot, homeDir };
}

describe('peer execution context (filesystem-only seam)', () => {
  describe('import surface', () => {
    it('reaches node builtins and sibling leaf libs only — never doctor.mjs', async () => {
      const code = stripComments(await readFile(MODULE_PATH, 'utf8'));
      const specs = immediateImports(code);
      ok(specs.length > 0, 'the scan must actually find imports');
      for (const spec of specs) {
        ok(
          ALLOWED_IMPORTS.has(spec),
          `disallowed import '${spec}'. The seam must not reach doctor.mjs — importing its `
            + `exported runCommand/runDoctor would re-introduce host-CLI probing while a `
            + `child_process scan stayed green.`,
        );
      }
      ok(!/\bdoctor\.mjs\b/.test(code), 'doctor.mjs must not be referenced in code');
    });

    it('never spawns: no child_process, no dynamic import', async () => {
      const code = stripComments(await readFile(MODULE_PATH, 'utf8'));
      ok(!/child_process/.test(code), 'the seam must not reach child_process');
      ok(!/\bimport\s*\(/.test(code), 'a dynamic import would defeat the static allowlist');
      ok(!/\brequire\s*\(/.test(code), 'no CJS escape hatch');
    });

    it('takes no env, no runner and no now — it structurally cannot probe', async () => {
      const code = stripComments(await readFile(MODULE_PATH, 'utf8'));
      const signature = code.match(/export async function resolvePeerExecutionContext\(\{([\s\S]*?)\}\)/);
      ok(signature, 'resolvePeerExecutionContext must be exported');
      const params = signature[1];
      for (const forbidden of ['env', 'runner', 'now']) {
        ok(!new RegExp(`\\b${forbidden}\\b`).test(params), `resolvePeerExecutionContext must not accept \`${forbidden}\``);
      }
    });
  });

  describe('resolution', () => {
    it('resolves both directions from seeded files, with the exact doctor shape', async () => {
      const { repoRoot, homeDir } = await seedFixture();
      const context = await resolvePeerExecutionContext({ repoRoot, homeDir });

      deepStrictEqual(Object.keys(context).sort(), ['companions', 'model_effort']);

      const { companions } = context;
      strictEqual(companions.contract_version, '0.1.1');
      strictEqual(companions.compatible_major, CONTRACT_COMPATIBLE_MAJOR);
      deepStrictEqual(Object.keys(companions.directions).sort(), ['claude_to_codex', 'codex_to_claude']);

      const claudeToCodex = companions.directions.claude_to_codex;
      strictEqual(claudeToCodex.status, 'available');
      strictEqual(claudeToCodex.peer, 'codex');
      strictEqual(claudeToCodex.filename, 'codex-companion.mjs');
      ok(claudeToCodex.selected.path.endsWith('codex-companion.mjs'), 'the selected companion is the one consensus spawns');
      strictEqual(claudeToCodex.selected.compatible, true);
      strictEqual(companions.directions.codex_to_claude.status, 'available');
      ok(companions.directions.codex_to_claude.selected.path.endsWith('claude-companion.mjs'));

      const { model_effort: modelEffort } = context;
      deepStrictEqual(modelEffort.explicit, { model: null, effort: null });
      deepStrictEqual(modelEffort.directions.claude_to_codex, {
        model: { value: null, source: 'host-native default' },
        effort: { value: null, source: 'host-native default' },
      });
      strictEqual(modelEffort.resolution_order[0], 'explicit command flags');
      strictEqual(modelEffort.repo_config.status, 'missing');
      strictEqual(modelEffort.user_config.status, 'missing');
    });

    it('honours explicit model/effort over config resolution', async () => {
      const { repoRoot, homeDir } = await seedFixture();
      const { model_effort: modelEffort } = await resolvePeerExecutionContext({
        repoRoot, homeDir, explicitModel: 'gpt-5.4', explicitEffort: 'high',
      });
      deepStrictEqual(modelEffort.directions.claude_to_codex.model, { value: 'gpt-5.4', source: 'explicit command flags' });
      deepStrictEqual(modelEffort.directions.codex_to_claude.effort, { value: 'high', source: 'explicit command flags' });
    });

    it('the Stage-4 POSTURE key never resolves as a model or effort (§6.1.1)', async () => {
      const { repoRoot, homeDir } = await seedFixture();
      await mkdir(join(homeDir, '.agentic-plugins'), { recursive: true });
      await writeFile(join(homeDir, '.agentic-plugins', 'config.toml'), 'model_effort_fallback = "host-native"\n');

      const { model_effort: modelEffort } = await resolvePeerExecutionContext({ repoRoot, homeDir });

      // This is the reason the posture is a SEPARATE key rather than a sentinel
      // value in `model`: the resolver reads a closed key list, so a declaration
      // can never be handed to a companion as a model name. A sentinel would be
      // passed verbatim — the peer review's grounds for rejecting that shape.
      for (const direction of ['claude_to_codex', 'codex_to_claude']) {
        deepStrictEqual(modelEffort.directions[direction], {
          model: { value: null, source: 'host-native default' },
          effort: { value: null, source: 'host-native default' },
        }, `${direction} still resolves to the host, with no trace of the declaration`);
      }
      // The key IS visible as user config — it is read, just never resolved into
      // a coordinate. Asserting its absence from `keys` would pin the wrong thing.
      ok(modelEffort.user_config.keys.includes('model_effort_fallback'), 'the resolver sees the key');
    });

    it('reports a missing companion cache as not_installed rather than throwing', async () => {
      const repoRoot = await mkdtemp(join(tmpdir(), 'peer-ctx-bare-'));
      const homeDir = await mkdtemp(join(tmpdir(), 'peer-ctx-bare-home-'));
      const { companions } = await resolvePeerExecutionContext({ repoRoot, homeDir });
      strictEqual(companions.contract_path, null);
      strictEqual(companions.directions.claude_to_codex.status, 'not_installed');
      strictEqual(companions.directions.claude_to_codex.selected, null);
    });
  });

  // ADR-0061 §Decision 3: installed caches only, the development path behind an
  // explicit override, and the Codex marketplace clone never a candidate.
  describe('candidates (ADR-0061 §Decision 3)', () => {
    const COMPANION = "const CONTRACT_VERSION = '0.1.1'; // --prompt-file\n";

    async function plantSourceTree(repoRoot) {
      for (const dir of [join(repoRoot, 'companions'), join(repoRoot, 'plugins', 'companions', 'scripts')]) {
        await mkdir(dir, { recursive: true });
        for (const script of ['codex-companion.mjs', 'claude-companion.mjs']) await writeFile(join(dir, script), COMPANION);
      }
    }

    async function plantCache(base, version, { manifestDir, script, name = 'companions' }) {
      const root = join(base, version);
      await mkdir(join(root, manifestDir), { recursive: true });
      await mkdir(join(root, 'scripts'), { recursive: true });
      await writeFile(join(root, manifestDir, 'plugin.json'), JSON.stringify({ name, version }));
      await writeFile(join(root, 'scripts', script), COMPANION);
      return root;
    }

    it('an installed runtime with empty caches does not fall through to the repository source tree', async () => {
      const repoRoot = await mkdtemp(join(tmpdir(), 'peer-ctx-source-'));
      const homeDir = await mkdtemp(join(tmpdir(), 'peer-ctx-source-home-'));
      await plantSourceTree(repoRoot);
      const { companions } = await resolvePeerExecutionContext({ repoRoot, homeDir });
      for (const key of ['claude_to_codex', 'codex_to_claude']) {
        strictEqual(companions.directions[key].status, 'not_installed', `${key} must not select repository code`);
        deepStrictEqual(companions.directions[key].candidates, [], `${key} lists no repository candidate`);
      }
      strictEqual(companions.override, null);
    });

    it('the explicit override replaces the caches, and says so', async () => {
      const { repoRoot, homeDir } = await seedFixture();
      await plantSourceTree(repoRoot);
      const override = join(repoRoot, 'companions');
      const { companions } = await resolvePeerExecutionContext({ repoRoot, homeDir, companionsOverride: override });
      deepStrictEqual(companions.override, { variable: 'AGENTIC_COMPANIONS_ROOT', path: override });
      for (const [key, script] of [['claude_to_codex', 'codex-companion.mjs'], ['codex_to_claude', 'claude-companion.mjs']]) {
        const direction = companions.directions[key];
        strictEqual(direction.selected.path, join(override, script));
        strictEqual(direction.selected.source, 'env-override');
        strictEqual(direction.candidates.length, 1, `${key}: the seeded caches are not candidates while the override is set`);
      }
    });

    it('a relative override is blocked, never resolved against the working directory', async () => {
      const { repoRoot, homeDir } = await seedFixture();
      const { companions } = await resolvePeerExecutionContext({ repoRoot, homeDir, companionsOverride: 'companions' });
      strictEqual(companions.directions.claude_to_codex.status, 'blocked');
      strictEqual(companions.directions.claude_to_codex.selected, null);
      ok(/absolute/.test(companions.directions.claude_to_codex.candidates[0].reason));
    });

    it('reads the Codex cache under CODEX_HOME, newest manifest-verified version first, and never the marketplace clone', async () => {
      const repoRoot = await mkdtemp(join(tmpdir(), 'peer-ctx-codexhome-'));
      const homeDir = await mkdtemp(join(tmpdir(), 'peer-ctx-codexhome-home-'));
      const codexHome = await canonicalTmp('peer-ctx-codexhome-custom-');
      const base = join(codexHome, 'plugins', 'cache', 'agentic-plugins', 'companions');
      await plantCache(base, '0.4.0', { manifestDir: '.codex-plugin', script: 'claude-companion.mjs' });
      const newest = await plantCache(base, '0.5.0', { manifestDir: '.codex-plugin', script: 'claude-companion.mjs' });
      await plantCache(base, '9.0.0', { manifestDir: '.codex-plugin', script: 'claude-companion.mjs', name: 'not-companions' });
      // A newer marketplace clone (the plugin directory itself, unversioned),
      // and a ~/.codex cache that the custom CODEX_HOME replaces.
      await plantCache(join(codexHome, '.tmp', 'marketplaces', 'agentic-plugins', 'plugins'), 'companions', { manifestDir: '.codex-plugin', script: 'claude-companion.mjs' });
      await plantCache(join(homeDir, '.codex', 'plugins', 'cache', 'agentic-plugins', 'companions'), '8.0.0', { manifestDir: '.codex-plugin', script: 'claude-companion.mjs' });

      const { companions } = await resolvePeerExecutionContext({ repoRoot, homeDir, codexHome });
      const direction = companions.directions.codex_to_claude;
      strictEqual(direction.selected.path, join(newest, 'scripts', 'claude-companion.mjs'));
      strictEqual(direction.selected.source, 'codex-cache');
      deepStrictEqual(
        direction.candidates.map((c) => c.path),
        [join(newest, 'scripts', 'claude-companion.mjs'), join(base, '0.4.0', 'scripts', 'claude-companion.mjs')],
        'only the manifest-verified versions under CODEX_HOME are candidates, newest first',
      );
    });

    // The companion's CLI entry guard compares argv[1] with Node's canonical
    // module path, so a path spelled through a symlink runs nothing. Each case
    // runs the selected companion with no subcommand: the real CLI answers with
    // a usage error (exit 2), the silent no-op exits 0 with no output.
    const REAL_COMPANION = join(REPO_ROOT, 'companions', 'claude-companion.mjs');
    const runs = (script) => spawnSync(process.execPath, [script], { encoding: 'utf8' });

    it('under a symlinked CODEX_HOME the selected companion is canonical and actually runs', async () => {
      const repoRoot = await canonicalTmp('peer-ctx-link-');
      const homeDir = await canonicalTmp('peer-ctx-link-home-');
      const realCodex = await canonicalTmp('peer-ctx-link-codex-');
      const link = join(homeDir, 'codex-link');
      await symlink(realCodex, link);
      const versionRoot = join(link, 'plugins', 'cache', 'agentic-plugins', 'companions', '0.5.0');
      await mkdir(join(versionRoot, '.codex-plugin'), { recursive: true });
      await mkdir(join(versionRoot, 'scripts'), { recursive: true });
      await writeFile(join(versionRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'companions', version: '0.5.0' }));
      await copyFile(REAL_COMPANION, join(versionRoot, 'scripts', 'claude-companion.mjs'));

      const { companions } = await resolvePeerExecutionContext({ repoRoot, homeDir, codexHome: link });
      const selected = companions.directions.codex_to_claude.selected.path;
      strictEqual(selected, join(realCodex, 'plugins', 'cache', 'agentic-plugins', 'companions', '0.5.0', 'scripts', 'claude-companion.mjs'));
      const run = runs(selected);
      strictEqual(run.status, 2, 'the canonical path reaches the companion CLI');
      ok(/subcommand/.test(run.stderr), run.stderr);
      // Control (docket C48): the link spelling of the same file runs nothing.
      const viaLink = runs(join(versionRoot, 'scripts', 'claude-companion.mjs'));
      deepStrictEqual([viaLink.status, viaLink.stdout, viaLink.stderr], [0, '', '']);
    });

    it('an override that names a symlink selects the canonical companion, which runs', async () => {
      const { repoRoot, homeDir } = await seedFixture();
      const realDir = await canonicalTmp('peer-ctx-override-real-');
      await copyFile(REAL_COMPANION, join(realDir, 'claude-companion.mjs'));
      const link = join(homeDir, 'companions-link');
      await symlink(realDir, link);
      const { companions } = await resolvePeerExecutionContext({ repoRoot, homeDir, companionsOverride: link });
      const selected = companions.directions.codex_to_claude.selected.path;
      strictEqual(selected, join(realDir, 'claude-companion.mjs'));
      strictEqual(runs(selected).status, 2);
    });
  });
});
