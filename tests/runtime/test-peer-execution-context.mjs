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
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

async function seedFixture() {
  const repoRoot = await mkdtemp(join(tmpdir(), 'peer-ctx-repo-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'peer-ctx-home-'));

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
});
