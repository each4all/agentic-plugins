import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatText,
  parseArgs,
  runSettings,
  upsertRuntimeConfigToml,
} from '../../plugins/runtime/scripts/settings.mjs';
import { RUNTIME_VERSION } from '../../plugins/runtime/scripts/version.mjs';

describe('runtime settings', () => {
  it('builds a dry-run settings plan without mutating config or running install commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-home-'));
    await seedRepo(root);
    await mkdir(join(root, '.agentic-plugins'), { recursive: true });
    await writeFile(join(root, '.agentic-plugins', 'config.toml'), 'codex_model = "old-codex"\n');

    const calls = [];
    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-05-13T00:00:00.000Z'),
      desired: {
        model: 'shared-model',
        codex_model: 'codex-new',
        codex_effort: 'high',
        claude_model: 'claude-new',
      },
      runner: fakeRunner(defaultCliMap(), calls),
    });

    strictEqual(report.dry_run, true);
    strictEqual(report.apply, false);
    strictEqual(report.config.targets[0].kind, 'repo');
    ok(report.config.targets[0].planned_writes.some((write) => write.key === 'codex_model' && write.op === 'update'));
    ok(report.config.targets[0].planned_writes.some((write) => write.key === 'model' && write.op === 'add'));
    strictEqual(report.companion_settings.directions.claude_to_codex.proposed.model, 'codex-new');
    strictEqual(report.companion_settings.directions.claude_to_codex.proposed.effort, 'high');
    strictEqual(report.companion_settings.directions.codex_to_claude.proposed.model, 'claude-new');
    strictEqual(await readFile(join(root, '.agentic-plugins', 'config.toml'), 'utf8'), 'codex_model = "old-codex"\n');
    ok(calls.every((call) => !/\binstall\b|\bupdate\b/.test(call)), 'settings must not execute plugin install/update commands');
    ok(formatText(report).includes(`runtime:settings ${RUNTIME_VERSION} (dry-run)`));
  });

  it('applies only selected agentic-plugins-owned config writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-apply-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-apply-home-'));
    await seedRepo(root);
    await mkdir(join(root, '.agentic-plugins'), { recursive: true });
    await writeFile(join(root, '.agentic-plugins', 'config.toml'), 'codex_model = "old-codex" # keep comment\n');
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(join(home, '.codex', 'config.toml'), 'model = "host-native"\n');

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      target: 'repo',
      apply: true,
      desired: {
        codex_model: 'codex-new',
        codex_effort: 'high',
      },
      runner: fakeRunner(defaultCliMap()),
    });

    strictEqual(report.dry_run, false);
    strictEqual(report.config.targets.find((target) => target.kind === 'repo').applied, true);
    strictEqual(report.config.targets.find((target) => target.kind === 'user').applied, false);
    const repoConfig = await readFile(join(root, '.agentic-plugins', 'config.toml'), 'utf8');
    ok(repoConfig.includes('codex_model = "codex-new" # keep comment'));
    ok(repoConfig.includes('codex_effort = "high"'));
    await rejects(() => stat(join(home, '.agentic-plugins', 'config.toml')), /ENOENT/);
    strictEqual(await readFile(join(home, '.codex', 'config.toml'), 'utf8'), 'model = "host-native"\n');
  });

  it('reports plugin installation recommendations without treating them as executed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-install-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-install-home-'));
    await seedRepo(root);
    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner(defaultCliMap()),
    });

    ok(report.plugins.runtime.recommendations.some((rec) => rec.action === 'install-plugin' && rec.host === 'codex'));
    ok(report.recommendations.some((rec) => rec.area === 'plugin' && rec.executed === false));
    ok(report.limits.some((limit) => limit.includes('Plugin install/update is recommendation-only')));
  });

  it('parses CLI arguments and rejects unsafe config values', () => {
    const opts = parseArgs([
      '--repo-root',
      '/tmp/repo',
      '--format',
      'json',
      '--host',
      'codex',
      '--target',
      'user',
      '--model',
      'shared',
      '--effort',
      'medium',
      '--claude-model',
      'claude-opus',
      '--codex-effort',
      'high',
      '--apply',
    ]);
    strictEqual(opts.repoRoot, '/tmp/repo');
    strictEqual(opts.format, 'json');
    strictEqual(opts.host, 'codex');
    strictEqual(opts.target, 'user');
    strictEqual(opts.apply, true);
    deepStrictEqual(opts.desired, {
      model: 'shared',
      effort: 'medium',
      claude_model: 'claude-opus',
      codex_effort: 'high',
    });
    rejects(async () => parseArgs(['--model', 'bad\nvalue']), /single-line/);
    rejects(async () => parseArgs(['--target', 'host']), /--target must be repo, user, or both/);
  });

  it('upserts flat TOML keys while preserving unrelated config', () => {
    const next = upsertRuntimeConfigToml('other = "keep"\nclaude-effort = "low"\n', {
      claude_effort: 'high',
      model: 'shared',
    });
    ok(next.includes('other = "keep"'));
    ok(next.includes('claude-effort = "high"'));
    ok(next.includes('model = "shared"'));
  });
});

function defaultCliMap() {
  return {
    'claude --version': okResult('2.1.140 (Claude Code)\n'),
    'claude --help': okResult('Usage: claude --print --output-format --no-session-persistence --model --effort --permission-mode --plugin-dir\nCommands:\n  auth status\n  plugin list\n'),
    'claude auth status': okResult(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })),
    'claude plugin list': okResult('Installed plugins:\n\n  > runtime@agentic-plugins\n    Version: 0.1.0\n    Scope: user\n    Status: enabled\n'),
    'codex --version': okResult('codex-cli 0.130.0\n'),
    'codex --help': okResult('Commands:\n  exec Run Codex non-interactively\n  login status\n  plugin marketplace\nOptions:\n  --model\n  --config\n  --cd\n  --sandbox\n  --ask-for-approval\n'),
    'codex exec --help': okResult('Usage: codex exec --cd <DIR> --model <MODEL> --config model_reasoning_effort="high"\n'),
    'codex login status': okResult('Logged in using ChatGPT\n'),
    'codex plugin marketplace --help': okResult('Commands:\n  add\n  upgrade\n  remove\n'),
  };
}

function okResult(stdout = '', stderr = '') {
  return { ok: true, exit_code: 0, stdout, stderr, error_code: null, timed_out: false };
}

function enoent(command) {
  return {
    ok: false,
    exit_code: null,
    stdout: '',
    stderr: '',
    error_code: 'ENOENT',
    error_message: `spawn ${command} ENOENT`,
    timed_out: false,
  };
}

function fakeRunner(map, calls = []) {
  return async (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    calls.push(key);
    return map[key] ?? enoent(command);
  };
}

async function seedRepo(root) {
  for (const name of ['companions', 'engineer', 'orchestrator', 'runtime']) {
    await mkdir(join(root, 'plugins', name, '.claude-plugin'), { recursive: true });
    await mkdir(join(root, 'plugins', name, '.codex-plugin'), { recursive: true });
    await writeJson(join(root, 'plugins', name, '.claude-plugin', 'plugin.json'), {
      name,
      version: name === 'runtime' ? '0.1.0' : '1.0.0',
      description: `${name} plugin`,
    });
    await writeJson(join(root, 'plugins', name, '.codex-plugin', 'plugin.json'), {
      name,
      version: name === 'runtime' ? '0.1.0' : '1.0.0',
      description: `${name} plugin`,
    });
  }
  await mkdir(join(root, 'companions'), { recursive: true });
  await writeFile(join(root, 'companions', 'contract.md'), '**Version**: `v0.1.1`\n');
  await writeFile(join(root, 'companions', 'codex-companion.mjs'), "const CONTRACT_VERSION = '0.1.1'; // --prompt-file\n");
  await writeFile(join(root, 'companions', 'claude-companion.mjs'), "const CONTRACT_VERSION = '0.1.1'; // --prompt-file\n");
  await mkdir(join(root, 'plugins', 'companions', 'scripts'), { recursive: true });
  await writeFile(join(root, 'plugins', 'companions', 'scripts', 'codex-companion.mjs'), "const CONTRACT_VERSION = '0.1.1'; // --prompt-file\n");
  await writeFile(join(root, 'plugins', 'companions', 'scripts', 'claude-companion.mjs'), "const CONTRACT_VERSION = '0.1.1'; // --prompt-file\n");
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeJson(join(root, '.claude-plugin', 'marketplace.json'), {
    name: 'agentic-plugins',
    description: 'test',
    plugins: ['companions', 'engineer', 'orchestrator', 'runtime'].map((name) => ({
      name,
      source: `./plugins/${name}`,
      version: name === 'runtime' ? '0.1.0' : '1.0.0',
      category: 'Productivity',
    })),
  });
  await mkdir(join(root, '.agents', 'plugins'), { recursive: true });
  await writeJson(join(root, '.agents', 'plugins', 'marketplace.json'), {
    name: 'agentic-plugins',
    description: 'test',
    plugins: ['companions', 'engineer', 'orchestrator', 'runtime'].map((name) => ({
      name,
      source: { source: 'local', path: `./plugins/${name}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
      category: 'Productivity',
    })),
  });
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
