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

const SETTINGS_RUN_ID = 'settings-20260513T000000Z-abcdef';

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
    strictEqual(report.companion_settings.directions.claude_to_codex.effective.model.value, 'codex-new');
    strictEqual(report.companion_settings.directions.claude_to_codex.effective.model.source, 'repo config codex_model');
    strictEqual(report.companion_settings.directions.claude_to_codex.effective.model.status, 'effective');
    strictEqual(report.companion_settings.directions.codex_to_claude.proposed.model, 'claude-new');
    strictEqual(report.overall.setting_warnings, 0);
    strictEqual(await readFile(join(root, '.agentic-plugins', 'config.toml'), 'utf8'), 'codex_model = "old-codex"\n');
    ok(calls.every((call) => !/\binstall\b|\bupdate\b/.test(call)), 'settings must not execute plugin install/update commands');
    ok(formatText(report).includes(`runtime:settings ${RUNTIME_VERSION} (dry-run)`));
  });

  it('reports non-executable host CLI install plans when Claude or Codex is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-cli-install-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-cli-install-home-'));
    await seedRepo(root);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({}),
    });

    strictEqual(report.schema_version, 'runtime-settings-1.5');
    strictEqual(report.clis.claude.status, 'unavailable');
    strictEqual(report.clis.codex.status, 'unavailable');
    for (const host of ['claude', 'codex']) {
      strictEqual(report.clis[host].install_plan.status, 'manual_required');
      strictEqual(report.clis[host].install_plan.executable, false);
      strictEqual(report.clis[host].install_plan.command, null);
      ok(report.clis[host].install_plan.next_step.includes(host === 'claude' ? 'Claude Code' : 'Codex CLI'));
      ok(report.recommendations.some((rec) => rec.area === 'cli' && rec.host === host && rec.action === 'install-host-cli' && rec.executable === false));
    }
    ok(report.plugin_management.plans.some((plan) => plan.host === 'claude' && plan.status === 'blocked' && plan.reason.includes('CLI is not available')));
    ok(report.plugin_management.plans.some((plan) => plan.host === 'codex' && plan.status === 'blocked' && plan.reason.includes('CLI is not available')));
    ok(formatText(report).includes('install-plan: manual_required; executable=false'));
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

  it('warns when a selected lower-precedence config target is shadowed by repo config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-shadow-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-shadow-home-'));
    await seedRepo(root);
    await mkdir(join(root, '.agentic-plugins'), { recursive: true });
    await writeFile(join(root, '.agentic-plugins', 'config.toml'), 'codex_model = "repo-codex"\n');

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      target: 'user',
      desired: {
        codex_model: 'user-codex',
      },
      runner: fakeRunner(defaultCliMap()),
    });

    const direction = report.companion_settings.directions.claude_to_codex;
    strictEqual(direction.effective.model.value, 'repo-codex');
    strictEqual(direction.effective.model.source, 'repo config codex_model');
    strictEqual(direction.effective.model.status, 'shadowed');
    ok(direction.effective.model.warning.includes('codex_model request codex_model=user-codex is shadowed by repo config codex_model'));
    ok(report.recommendations.some((rec) => rec.area === 'config' && rec.detail.includes('shadowed by repo config codex_model')));
    ok(formatText(report).includes('warning: codex_model request codex_model=user-codex is shadowed by repo config codex_model'));
    strictEqual(report.overall.status, 'warning');
    strictEqual(report.overall.setting_warnings, 1);
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

    const codexRecommendation = report.plugins.runtime.recommendations.find((rec) => rec.host === 'codex');
    strictEqual(codexRecommendation.action, 'add-marketplace');
    strictEqual(codexRecommendation.command, 'codex plugin marketplace add each4all/agentic-plugins');
    deepStrictEqual(codexRecommendation.argv, {
      command: 'codex',
      args: ['plugin', 'marketplace', 'add', 'each4all/agentic-plugins'],
    });
    ok(codexRecommendation.detail.includes('not per-plugin install'));
    ok(report.recommendations.some((rec) => rec.area === 'plugin' && rec.executed === false));
    strictEqual(report.plugin_management.requested, false);
    ok(report.plugin_management.plans.some((plan) => plan.status === 'planned' && plan.command === 'codex plugin marketplace add each4all/agentic-plugins'));
    ok(report.plugin_management.plans.some((plan) => plan.status === 'deduplicated'));
    ok(report.limits.some((limit) => limit.includes('Plugin install/update execution is dry-run')));
  });

  it('does not retry Codex marketplace add when the temporary marketplace cache is already current', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-codex-tmp-current-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-codex-tmp-current-home-'));
    await seedRepo(root);
    await seedCodexTmpMarketplace(home, 'runtime', '0.1.0');

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner(defaultCliMap()),
    });

    strictEqual(report.schema_version, 'runtime-settings-1.5');
    strictEqual(report.plugins.runtime.installed.codex_cache, null);
    strictEqual(report.plugins.runtime.marketplace_cache.codex_tmp_marketplace.version, '0.1.0');
    const codexRecommendations = report.plugins.runtime.recommendations.filter((rec) => rec.host === 'codex');
    ok(codexRecommendations.every((rec) => rec.action !== 'add-marketplace'));
    const materialize = codexRecommendations.find((rec) => rec.action === 'materialize-plugin-cache');
    strictEqual(materialize.command, null);
    ok(materialize.detail.includes('rather than per-plugin install/list'));
    ok(materialize.next_step.includes('Do not repeat marketplace add'));
    strictEqual(materialize.evidence.command_surface, 'marketplace-only');
    ok(report.plugin_management.plans.some((plan) => plan.id === 'runtime:codex:materialize-plugin-cache' && plan.status === 'manual'));
    const materializePlan = report.plugin_management.plans.find((plan) => plan.id === 'runtime:codex:materialize-plugin-cache');
    ok(materializePlan.next_step.includes('verify host cache materialization'));
    strictEqual(report.plugin_command_surface.codex.materialization.status, 'manual_session_refresh');
    ok(formatText(report).includes('codex-marketplace-cache=0.1.0'));
    ok(formatText(report).includes('codex command surface: mode=marketplace-only'));
    ok(formatText(report).includes('materialization=manual_session_refresh'));
  });

  it('recommends Codex marketplace upgrade when the temporary marketplace cache is stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-codex-tmp-stale-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-codex-tmp-stale-home-'));
    await seedRepo(root);
    await seedCodexTmpMarketplace(home, 'runtime', '0.0.9');

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner(defaultCliMap()),
    });

    const codexRecommendation = report.plugins.runtime.recommendations.find((rec) => rec.host === 'codex');
    strictEqual(codexRecommendation.action, 'upgrade-marketplace');
    strictEqual(codexRecommendation.command, 'codex plugin marketplace upgrade agentic-plugins');
    ok(codexRecommendation.detail.includes('Codex marketplace cache has 0.0.9'));
    ok(report.plugin_management.plans.some((plan) => plan.status === 'planned' && plan.command === 'codex plugin marketplace upgrade agentic-plugins'));
  });

  it('executes only allowlisted plugin management commands behind an explicit flag', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-execute-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-execute-home-'));
    await seedRepo(root);

    const calls = [];
    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      executePluginManagement: true,
      pluginManagementHost: 'codex',
      runner: fakeRunner({
        ...defaultCliMap(),
        'codex plugin marketplace add each4all/agentic-plugins': okResult('RAW OUTPUT MUST NOT LEAK\n'),
      }, calls),
    });

    strictEqual(report.plugin_management.requested, true);
    strictEqual(report.plugin_management.mode, 'explicit-plugin-management-executor');
    strictEqual(report.plugin_management.host_filter, 'codex');
    strictEqual(report.plugin_management.summary.executed, 1);
    strictEqual(report.plugin_management.summary.failed, 0);
    ok(report.plugin_management.plans.some((plan) => plan.host === 'claude' && plan.status === 'skipped'));
    const executed = report.plugin_management.plans.find((plan) => plan.status === 'executed');
    strictEqual(executed.command, 'codex plugin marketplace add each4all/agentic-plugins');
    strictEqual(executed.result.ok, true);
    strictEqual(executed.result.stdout_bytes, 'RAW OUTPUT MUST NOT LEAK\n'.length);
    ok(calls.includes('codex plugin marketplace add each4all/agentic-plugins'));
    ok(!JSON.stringify(report).includes('RAW OUTPUT MUST NOT LEAK'), 'plugin management report must not include raw command output');
  });

  it('persists execution artifacts and classifies failed plugin-management retries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-artifact-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-artifact-home-'));
    await seedRepo(root);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-05-13T00:00:00.000Z'),
      runId: SETTINGS_RUN_ID,
      executePluginManagement: true,
      pluginManagementHost: 'codex',
      runner: fakeRunner({
        ...defaultCliMap(),
        'codex plugin marketplace add each4all/agentic-plugins': {
          ok: false,
          exit_code: null,
          stdout: 'RAW OUTPUT MUST NOT LEAK',
          stderr: 'ECONNRESET RAW ERROR MUST NOT LEAK',
          error_code: 'ECONNRESET',
          timed_out: false,
        },
      }),
    });

    strictEqual(report.artifacts.settings_execution.written, true);
    strictEqual(report.artifacts.settings_execution.run_id, SETTINGS_RUN_ID);
    strictEqual(report.artifacts.settings_execution.report_pointer, `.agentic-plugins/runs/settings/${SETTINGS_RUN_ID}/settings.json`);
    strictEqual(report.plugin_management.summary.failed, 1);
    strictEqual(report.plugin_management.summary.failed_retryable, 1);
    strictEqual(report.plugin_management.summary.failed_non_retryable, 0);
    const failed = report.plugin_management.plans.find((plan) => plan.status === 'failed');
    strictEqual(failed.result.failure_type, 'network');
    strictEqual(failed.result.retryable, true);
    ok(failed.result.retry_after.includes('network'));

    const artifact = await readJson(join(root, '.agentic-plugins', 'runs', 'settings', SETTINGS_RUN_ID, 'settings.json'));
    strictEqual(artifact.schema_version, 'runtime-settings-execution-artifact-1.0');
    strictEqual(artifact.run_id, SETTINGS_RUN_ID);
    strictEqual(artifact.status, 'failed');
    strictEqual(artifact.summary.failed_retryable, 1);
    strictEqual(artifact.failures[0].failure_type, 'network');
    strictEqual(artifact.failures[0].retryable, true);
    ok(artifact.doctor_integration.command.includes('runtime:doctor'));

    const latest = await readJson(join(root, '.agentic-plugins', 'runs', 'settings', 'latest.json'));
    strictEqual(latest.run_id, SETTINGS_RUN_ID);
    strictEqual(latest.status, 'failed');
    ok(!JSON.stringify(artifact).includes('RAW OUTPUT MUST NOT LEAK'), 'execution artifact must not include raw stdout');
    ok(!JSON.stringify(artifact).includes('RAW ERROR MUST NOT LEAK'), 'execution artifact must not include raw stderr');
    ok(formatText(report).includes('Execution Artifact'));
    ok(formatText(report).includes(`run-id=${SETTINGS_RUN_ID}`));
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
      '--execute-plugin-management',
      '--plugin-management-host',
      'codex',
      '--plugin-management-timeout-ms',
      '90000',
      '--run-id',
      SETTINGS_RUN_ID,
    ]);
    strictEqual(opts.repoRoot, '/tmp/repo');
    strictEqual(opts.format, 'json');
    strictEqual(opts.host, 'codex');
    strictEqual(opts.target, 'user');
    strictEqual(opts.apply, true);
    strictEqual(opts.executePluginManagement, true);
    strictEqual(opts.pluginManagementHost, 'codex');
    strictEqual(opts.pluginManagementTimeoutMs, 90000);
    strictEqual(opts.runId, SETTINGS_RUN_ID);
    deepStrictEqual(opts.desired, {
      model: 'shared',
      effort: 'medium',
      claude_model: 'claude-opus',
      codex_effort: 'high',
    });
    rejects(async () => parseArgs(['--model', 'bad\nvalue']), /single-line/);
    rejects(async () => parseArgs(['--target', 'host']), /--target must be repo, user, or both/);
    rejects(async () => parseArgs(['--plugin-management-host', 'host']), /--plugin-management-host must be all, claude, or codex/);
    rejects(async () => parseArgs(['--plugin-management-timeout-ms', '0']), /positive integer/);
    rejects(async () => parseArgs(['--run-id', '../bad']), /Invalid --run-id/);
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
    'codex features list': okResult('hooks stable true\nplugin_hooks under development false\nplugins stable true\nmulti_agent stable true\n'),
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

async function seedCodexTmpMarketplace(home, name, version) {
  await mkdir(join(home, '.codex', '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', name, '.codex-plugin'), { recursive: true });
  await writeJson(join(home, '.codex', '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', name, '.codex-plugin', 'plugin.json'), {
    name,
    version,
    description: `${name} plugin`,
  });
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
