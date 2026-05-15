import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatText,
  parseArgs,
  parseCodexFeaturesConfigToml,
  runSettings,
  upsertCodexPluginHooksConfigToml,
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
    strictEqual(report.overall.hook_warnings, 1);
    strictEqual(report.hook_settings.status, 'feature_disabled');
    ok(report.hook_settings.recommendations.some((rec) => rec.action === 'enable-codex-plugin-hooks'));
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

    strictEqual(report.schema_version, 'runtime-settings-1.9');
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

  it('reports non-executable host auth remediation plans', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-auth-plan-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-auth-plan-home-'));
    await seedRepo(root);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      env: {},
      runner: fakeRunner({
        ...defaultCliMap(),
        'claude auth status': {
          ok: false,
          exit_code: 1,
          stdout: JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }),
          stderr: '',
          error_code: null,
          timed_out: false,
        },
      }),
    });

    strictEqual(report.clis.claude.auth.status, 'unauthenticated');
    strictEqual(report.clis.claude.auth_plan.status, 'manual_required');
    strictEqual(report.clis.claude.auth_plan.executable, false);
    strictEqual(report.clis.claude.auth_plan.command, 'claude auth login');
    strictEqual(report.overall.auth_warnings, 1);
    ok(report.recommendations.some((rec) => rec.area === 'auth' && rec.host === 'claude' && rec.action === 'authenticate-host-cli'));
    ok(formatText(report).includes('auth=unauthenticated'));
    ok(formatText(report).includes('auth-plan: manual_required; executable=false; command=claude auth login'));
  });

  it('plans host auth verification instead of login when Claude auth is sandbox-limited', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-auth-sandbox-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-auth-sandbox-home-'));
    await seedRepo(root);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      env: { CODEX_SANDBOX: 'seatbelt' },
      runner: fakeRunner({
        ...defaultCliMap(),
        'claude auth status': {
          ok: false,
          exit_code: 1,
          stdout: JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }),
          stderr: '',
          error_code: null,
          timed_out: false,
        },
      }),
    });

    strictEqual(report.clis.claude.auth.status, 'sandbox_limited');
    strictEqual(report.clis.claude.auth_plan.status, 'manual_check');
    strictEqual(report.clis.claude.auth_plan.command, 'claude auth status');
    ok(report.clis.claude.auth_plan.next_step.includes('outside the current sandbox'));
    ok(report.recommendations.some((rec) => rec.area === 'auth' && rec.host === 'claude' && rec.action === 'verify-host-auth'));
    ok(formatText(report).includes('auth=sandbox_limited'));
    ok(formatText(report).includes('auth-plan: manual_check; executable=false; command=claude auth status'));
  });

  it('plans retired Claude plugin cleanup without executing uninstall', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-plugin-cleanup-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-plugin-cleanup-home-'));
    await seedRepo(root);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      env: {},
      runner: fakeRunner({
        ...defaultCliMap(),
        'claude plugin list': okResult([
          'Installed plugins:',
          '',
          '  > research@agentic-plugins',
          '    Version: 0.1.0',
          '    Scope: user',
          '    Status: failed',
          '    Error: Plugin research not found in marketplace agentic-plugins',
        ].join('\n')),
      }),
    });

    strictEqual(report.plugin_cleanup.status, 'manual_required');
    strictEqual(report.plugin_cleanup.summary.planned, 1);
    strictEqual(report.plugin_cleanup.summary.manual_required, 1);
    const plan = report.plugin_cleanup.plans[0];
    strictEqual(plan.action, 'uninstall-retired-plugin');
    strictEqual(plan.executable, false);
    strictEqual(plan.executed, false);
    strictEqual(plan.command, 'claude plugin uninstall research@agentic-plugins');
    strictEqual(report.plugin_management.manual_followups.length, 1);
    strictEqual(report.plugin_management.manual_followups[0].id, 'claude-retired-plugin-cleanup');
    deepStrictEqual(report.plugin_management.manual_followups[0].commands, [
      'claude plugin uninstall research@agentic-plugins',
    ]);
    ok(report.recommendations.some((rec) => rec.area === 'plugin-cleanup' && rec.plugin === 'research' && rec.executable === false));
    ok(formatText(report).includes('Manual Follow-ups'));
    ok(formatText(report).includes('command: claude plugin uninstall research@agentic-plugins'));
    ok(formatText(report).includes('Plugin Cleanup'));
    ok(formatText(report).includes('research/claude: uninstall-retired-plugin'));
  });

  it('executes retired Claude plugin cleanup behind an explicit flag', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-plugin-cleanup-execute-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-plugin-cleanup-execute-home-'));
    await seedRepo(root);

    const calls = [];
    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runId: SETTINGS_RUN_ID,
      executePluginCleanup: true,
      runner: fakeRunner({
        ...defaultCliMap(),
        'claude plugin list': okResult([
          'Installed plugins:',
          '',
          '  > research@agentic-plugins',
          '    Version: 0.1.0',
          '    Scope: user',
          '    Status: failed',
          '    Error: Plugin research not found in marketplace agentic-plugins',
        ].join('\n')),
        'claude plugin uninstall research@agentic-plugins': okResult('RAW CLEANUP OUTPUT MUST NOT LEAK\n'),
      }, calls),
    });

    strictEqual(report.dry_run, false);
    strictEqual(report.execute_plugin_cleanup, true);
    ok(report.mutation_boundary.writes_allowed.includes('plugin cleanup commands'));
    deepStrictEqual(report.mutation_boundary.allowed_plugin_cleanup_actions, ['uninstall-retired-plugin']);
    strictEqual(report.plugin_cleanup.status, 'executed');
    strictEqual(report.plugin_cleanup.mode, 'explicit-plugin-cleanup-executor');
    strictEqual(report.plugin_cleanup.summary.planned, 1);
    strictEqual(report.plugin_cleanup.summary.executable, 1);
    strictEqual(report.plugin_cleanup.summary.executed, 1);
    strictEqual(report.plugin_cleanup.summary.failed, 0);
    strictEqual(report.plugin_cleanup.summary.manual_required, 0);
    const plan = report.plugin_cleanup.plans[0];
    strictEqual(plan.status, 'executed');
    strictEqual(plan.executable, true);
    strictEqual(plan.executed, true);
    strictEqual(plan.command, 'claude plugin uninstall research@agentic-plugins');
    strictEqual(plan.result.ok, true);
    strictEqual(plan.result.stdout_bytes, 'RAW CLEANUP OUTPUT MUST NOT LEAK\n'.length);
    strictEqual(report.plugin_management.manual_followups.find((entry) => entry.id === 'claude-retired-plugin-cleanup'), undefined);
    strictEqual(report.artifacts.settings_execution.written, true);
    ok(calls.includes('claude plugin uninstall research@agentic-plugins'));
    ok(!JSON.stringify(report).includes('RAW CLEANUP OUTPUT MUST NOT LEAK'), 'cleanup report must not include raw command output');
    const artifact = await readJson(join(root, '.agentic-plugins', 'runs', 'settings', SETTINGS_RUN_ID, 'settings.json'));
    strictEqual(artifact.command.execute_plugin_cleanup, true);
    strictEqual(artifact.plugin_cleanup.summary.executed, 1);
    strictEqual(artifact.summary.plugin_cleanup_executed, 1);
    ok(!JSON.stringify(artifact).includes('RAW CLEANUP OUTPUT MUST NOT LEAK'), 'cleanup artifact must not include raw command output');
    ok(formatText(report).includes(`runtime:settings ${RUNTIME_VERSION} (plugin-cleanup)`));
    ok(formatText(report).includes('result: ok=true'));
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

  it('plans Codex plugin_hooks enablement without mutating host-native config by default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-hooks-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-hooks-home-'));
    await seedRepo(root);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner(defaultCliMap()),
    });

    strictEqual(report.hook_settings.status, 'feature_disabled');
    deepStrictEqual(report.hook_settings.packaged_plugins.manifest_exposed, ['engineer', 'orchestrator']);
    const rec = report.hook_settings.recommendations.find((item) => item.action === 'enable-codex-plugin-hooks');
    strictEqual(rec.executable, true);
    strictEqual(rec.executed, false);
    strictEqual(rec.command, 'codex --enable plugin_hooks');
    strictEqual(rec.config_snippet, '[features]\nplugin_hooks = true\n');
    strictEqual(report.hook_settings.host_config.status, 'planned');
    strictEqual(report.hook_settings.host_config.applied, false);
    strictEqual(report.hook_settings.host_config.planned_writes[0].key, 'plugin_hooks');
    ok(report.recommendations.some((item) => item.area === 'hooks' && item.action === 'enable-codex-plugin-hooks'));
    ok(formatText(report).includes('Codex Plugin Hooks'));
    ok(formatText(report).includes('session-command: codex --enable plugin_hooks'));
    ok(formatText(report).includes('apply-command: runtime:settings --apply-codex-plugin-hooks'));
    await rejects(readFile(join(home, '.codex', 'config.toml'), 'utf8'), /ENOENT/);
  });

  it('reports Codex hook review as a manual follow-up when plugin hooks are ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-hook-review-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-hook-review-home-'));
    await seedRepo(root);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultCliMap(),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
      }),
    });

    strictEqual(report.hook_settings.status, 'ready');
    const followup = report.plugin_management.manual_followups.find((entry) => entry.id === 'codex-hook-review');
    strictEqual(followup.status, 'manual_check');
    strictEqual(followup.host, 'codex');
    deepStrictEqual(followup.commands, ['/hooks']);
    ok(followup.verify.includes('engineer, orchestrator'));
    ok(followup.verify.includes('runtime:settings --attest-codex-hook-review'));
    ok(formatText(report).includes('command: /hooks'));
  });

  it('records Codex hook review attestation behind an explicit flag', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-hook-review-attest-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-hook-review-attest-home-'));
    await seedRepo(root);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runId: SETTINGS_RUN_ID,
      attestCodexHookReview: true,
      runner: fakeRunner({
        ...defaultCliMap(),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
      }),
    });

    strictEqual(report.dry_run, false);
    strictEqual(report.attest_codex_hook_review, true);
    strictEqual(report.codex_hook_review.status, 'attested');
    strictEqual(report.codex_hook_review.attested, true);
    deepStrictEqual(report.codex_hook_review.bundled_plugins, ['engineer', 'orchestrator']);
    strictEqual(report.plugin_management.manual_followups.find((entry) => entry.id === 'codex-hook-review'), undefined);
    strictEqual(report.artifacts.settings_execution.written, true);

    const artifact = JSON.parse(await readFile(join(root, '.agentic-plugins', 'runs', 'settings', SETTINGS_RUN_ID, 'settings.json'), 'utf8'));
    strictEqual(artifact.command.attest_codex_hook_review, true);
    strictEqual(artifact.codex_hook_review.status, 'attested');
    strictEqual(artifact.summary.codex_hook_review_attested, true);
    ok(formatText(report).includes('Codex Hook Review'));
    ok(formatText(report).includes(`runtime:settings ${RUNTIME_VERSION} (codex-hook-review)`));
  });

  it('applies Codex plugin_hooks to user config only behind the explicit flag', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-hooks-apply-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-hooks-apply-home-'));
    await seedRepo(root);
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(join(home, '.codex', 'config.toml'), [
      'model = "gpt-5.5"',
      '',
      '[features]',
      'hooks = true',
      '',
      '[notice]',
      'hide_full_access_warning = true',
      '',
    ].join('\n'));

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runId: SETTINGS_RUN_ID,
      applyCodexPluginHooks: true,
      runner: fakeRunner(defaultCliMap()),
    });

    strictEqual(report.dry_run, false);
    strictEqual(report.apply_codex_plugin_hooks, true);
    strictEqual(report.hook_settings.host_config.status, 'applied');
    strictEqual(report.hook_settings.host_config.applied, true);
    strictEqual(report.hook_settings.host_config.current.plugin_hooks, true);
    const rec = report.hook_settings.recommendations.find((item) => item.action === 'enable-codex-plugin-hooks');
    strictEqual(rec.executed, true);
    strictEqual(report.artifacts.settings_execution.written, true);
    strictEqual(report.artifacts.settings_execution.run_id, SETTINGS_RUN_ID);
    const config = await readFile(join(home, '.codex', 'config.toml'), 'utf8');
    ok(config.includes('[features]\nhooks = true\nplugin_hooks = true\n'));
    ok(config.includes('[notice]\nhide_full_access_warning = true'));
    const artifact = JSON.parse(await readFile(join(root, '.agentic-plugins', 'runs', 'settings', SETTINGS_RUN_ID, 'settings.json'), 'utf8'));
    strictEqual(artifact.command.apply_codex_plugin_hooks, true);
    strictEqual(artifact.codex_plugin_hooks.applied, true);
    strictEqual(artifact.summary.codex_plugin_hooks_applied, true);
    ok(formatText(report).includes(`runtime:settings ${RUNTIME_VERSION} (codex-plugin-hooks)`));
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

    strictEqual(report.schema_version, 'runtime-settings-1.9');
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

  it('fails zero-exit Claude plugin commands when the plugin CLI reports unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-claude-plugin-unavailable-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-claude-plugin-unavailable-home-'));
    await seedRepo(root);

    const unavailable = okResult("RAW plugin isn't available in this environment.\n");
    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      executePluginManagement: true,
      pluginManagementHost: 'claude',
      runner: fakeRunner({
        ...defaultCliMap(),
        'claude plugin install companions@agentic-plugins': unavailable,
        'claude plugin install engineer@agentic-plugins': unavailable,
        'claude plugin install orchestrator@agentic-plugins': unavailable,
        'claude plugin install runtime@agentic-plugins': unavailable,
        'claude plugin update companions@agentic-plugins': unavailable,
        'claude plugin update engineer@agentic-plugins': unavailable,
        'claude plugin update orchestrator@agentic-plugins': unavailable,
        'claude plugin update runtime@agentic-plugins': unavailable,
      }),
    });

    const failed = report.plugin_management.plans.filter((plan) => plan.host === 'claude' && plan.status === 'failed');
    ok(failed.length > 0);
    strictEqual(report.plugin_management.summary.executed, 0);
    strictEqual(report.plugin_management.summary.failed, failed.length);
    for (const plan of failed) {
      strictEqual(plan.executed, true);
      strictEqual(plan.result.ok, false);
      strictEqual(plan.result.exit_code, 0);
      strictEqual(plan.result.failure_type, 'host_plugin_surface_unavailable');
      strictEqual(plan.result.retryable, false);
    }
    ok(!JSON.stringify(report).includes('RAW plugin'), 'plugin management report must not include raw command output');
  });

  it('executes Claude plugin management when only the slash plugin surface is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-claude-plugin-preflight-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-claude-plugin-preflight-home-'));
    await seedRepo(root);

    const calls = [];
    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      executePluginManagement: true,
      pluginManagementHost: 'claude',
      runner: fakeRunner({
        ...defaultCliMap(),
        'claude /plugin list': okResult("/plugin isn't available in this environment.\n"),
        'claude plugin install companions@agentic-plugins': okResult('installed companions\n'),
        'claude plugin install engineer@agentic-plugins': okResult('installed engineer\n'),
        'claude plugin install orchestrator@agentic-plugins': okResult('installed orchestrator\n'),
      }, calls),
    });

    const claudePlans = report.plugin_management.plans.filter((plan) => plan.host === 'claude');
    ok(claudePlans.length > 0);
    strictEqual(report.plugin_command_surface.claude.mode, 'per-plugin-command');
    strictEqual(report.plugin_command_surface.claude.observed_surfaces.slash_plugin, 'unavailable');
    strictEqual(report.plugin_management.summary.blocked, 0);
    strictEqual(report.plugin_management.summary.executed, 3);
    strictEqual(report.plugin_management.summary.failed, 0);
    ok(claudePlans.some((plan) => plan.status === 'executed' && plan.command === 'claude plugin install companions@agentic-plugins'));
    strictEqual(report.plugin_management.manual_followups.length, 0);
    ok(calls.includes('claude /plugin list'));
    ok(calls.includes('claude plugin install companions@agentic-plugins'));
    ok(!calls.some((call) => call.startsWith('claude /plugin install') || call.startsWith('claude /plugin update')));
    ok(formatText(report).includes('claude command surface: mode=per-plugin-command'));
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
      '--apply-codex-plugin-hooks',
      '--attest-codex-hook-review',
      '--execute-plugin-management',
      '--execute-plugin-cleanup',
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
    strictEqual(opts.applyCodexPluginHooks, true);
    strictEqual(opts.attestCodexHookReview, true);
    strictEqual(opts.executePluginManagement, true);
    strictEqual(opts.executePluginCleanup, true);
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

  it('upserts Codex plugin_hooks under [features] while preserving unrelated host config', () => {
    strictEqual(parseCodexFeaturesConfigToml('[features]\nplugin_hooks = false\n').plugin_hooks, false);
    const next = upsertCodexPluginHooksConfigToml([
      'model = "gpt-5.5"',
      '',
      '[features]',
      'hooks = true',
      'plugin_hooks = false # keep comment',
      '',
      '[notice]',
      'hide_full_access_warning = true',
      '',
    ].join('\n'));
    ok(next.includes('model = "gpt-5.5"'));
    ok(next.includes('hooks = true\nplugin_hooks = true # keep comment'));
    ok(next.includes('[notice]\nhide_full_access_warning = true'));

    const inserted = upsertCodexPluginHooksConfigToml('model = "gpt-5.5"\n');
    ok(inserted.includes('[features]\nplugin_hooks = true'));
  });
});

function defaultCliMap() {
  return {
    'claude --version': okResult('2.1.140 (Claude Code)\n'),
    'claude --help': okResult('Usage: claude --print --output-format --no-session-persistence --model --effort --permission-mode --plugin-dir\nCommands:\n  auth status\n  plugin list\n'),
    'claude auth status': okResult(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })),
    'claude plugin --help': okResult('Commands:\n  install\n  list\n  update\n  uninstall\n'),
    'claude plugin list': okResult('Installed plugins:\n\n  > runtime@agentic-plugins\n    Version: 0.1.0\n    Scope: user\n    Status: enabled\n'),
    'claude /plugin list': okResult('Installed plugins:\n\n  > runtime@agentic-plugins\n    Version: 0.1.0\n    Scope: user\n    Status: enabled\n'),
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
    const codexManifest = {
      name,
      version: name === 'runtime' ? '0.1.0' : '1.0.0',
      description: `${name} plugin`,
    };
    if (['engineer', 'orchestrator'].includes(name)) codexManifest.hooks = './hooks/hooks.json';
    await writeJson(join(root, 'plugins', name, '.codex-plugin', 'plugin.json'), codexManifest);
    if (['engineer', 'orchestrator'].includes(name)) {
      await mkdir(join(root, 'plugins', name, 'hooks'), { recursive: true });
      await writeJson(join(root, 'plugins', name, 'hooks', 'hooks.json'), {
        hooks: {
          SessionStart: [{ matcher: 'compact', hooks: [{ type: 'command', command: 'node hook.mjs' }] }],
          PreCompact: [{ hooks: [{ type: 'command', command: 'node hook.mjs' }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'node hook.mjs' }] }],
        },
      });
    }
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
