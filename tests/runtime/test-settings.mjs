import { describe, it } from 'node:test';
import { deepStrictEqual, notStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatText,
  parseArgs,
  runSettings,
  upsertRuntimeConfigToml,
  removeRuntimeConfigKeys,
} from '../../plugins/runtime/scripts/settings.mjs';
import { RUNTIME_VERSION } from '../../plugins/runtime/scripts/version.mjs';

const SETTINGS_RUN_ID = 'settings-20260513T000000Z-abcdef';
const PORTABLE_HOOK_COMMAND = '/bin/sh "${PLUGIN_ROOT}/adapters/codex/hooks/run-node-hook.sh" "${PLUGIN_ROOT}/adapters/codex/hooks/hook.mjs"';

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
    strictEqual(report.overall.hook_warnings, 0);
    strictEqual(report.hook_settings.status, 'feature_disabled');
    ok(!report.hook_settings.recommendations.some((rec) => rec.action === 'enable-codex-plugin-hooks'));
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

    strictEqual(report.schema_version, 'runtime-settings-1.26');
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

  // ── Write-ahead durability cluster (machine-bootstrap-contract.md §1.5/§1.6) ──
  // The H2 plugin-management + cleanup executors persist a `planned` record with a
  // plan hash BEFORE any action, journal after each, and finalize terminal. These
  // tests assert at the SEAM (the record is on disk when the action runs / survives
  // an interrupted run) — not by filtering output.

  const MARKETPLACE_ADD = 'codex plugin marketplace add each4all/agentic-plugins';

  it('write-ahead: persists the planned record + plan hash BEFORE the H2 action runs (§1.5 #10)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-writeahead-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-writeahead-home-'));
    await seedRepo(root);
    const artifactPath = join(root, '.agentic-plugins', 'runs', 'settings', SETTINGS_RUN_ID, 'settings.json');

    const calls = [];
    const base = fakeRunner({ ...defaultCliMap(), [MARKETPLACE_ADD]: okResult('marketplace ok\n') }, calls);
    let recordAtActionTime = null;
    const spy = async (command, args) => {
      const key = `${command} ${args.join(' ')}`;
      if (key === MARKETPLACE_ADD && recordAtActionTime === null) {
        // The durable record MUST already be on disk when the mutating action runs.
        recordAtActionTime = JSON.parse(await readFile(artifactPath, 'utf8'));
      }
      return base(command, args);
    };

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runId: SETTINGS_RUN_ID,
      executePluginManagement: true,
      pluginManagementHost: 'codex',
      runner: spy,
    });

    ok(recordAtActionTime, 'a planned record existed on disk before the action ran');
    strictEqual(recordAtActionTime.status, 'planned');
    strictEqual(recordAtActionTime.terminal, false);
    ok(/^[0-9a-f]{64}$/.test(recordAtActionTime.plan_hash), 'planned record carries the plan hash');
    ok(
      recordAtActionTime.planned_actions.some((a) => a.args.join(' ') === 'plugin marketplace add each4all/agentic-plugins'),
      'planned_actions names the action BEFORE it runs',
    );
    strictEqual(recordAtActionTime.journal.length, 0, 'journal is empty before the first action');
    // Finalize rewrote it terminal, with a journal entry for the executed action.
    const final = await readJson(artifactPath);
    strictEqual(final.status, 'completed');
    strictEqual(final.terminal, true);
    strictEqual(final.plan_hash, recordAtActionTime.plan_hash);
    strictEqual(final.journal.length, 1);
    strictEqual(final.journal[0].status, 'executed');
    strictEqual(final.journal[0].action, 'add-marketplace');
    strictEqual(report.plugin_management.plan_hash, recordAtActionTime.plan_hash);
  });

  it('write-ahead: an interrupted H2 run leaves a durable record naming the landed action (§1.5 #10)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-writeahead-kill-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-writeahead-kill-home-'));
    await seedRepo(root);
    const artifactPath = join(root, '.agentic-plugins', 'runs', 'settings', SETTINGS_RUN_ID, 'settings.json');

    const base = fakeRunner({ ...defaultCliMap(), [MARKETPLACE_ADD]: okResult('marketplace ok\n') });
    const crashing = async (command, args) => {
      const key = `${command} ${args.join(' ')}`;
      if (key === MARKETPLACE_ADD) throw new Error('simulated crash mid-action');
      return base(command, args);
    };

    await rejects(
      runSettings({
        repoRoot: root,
        homeDir: home,
        runId: SETTINGS_RUN_ID,
        executePluginManagement: true,
        pluginManagementHost: 'codex',
        runner: crashing,
      }),
      /simulated crash/,
    );

    // The write-ahead planned record — written before the action — survives the
    // crash and names the intended action. Today (pre-write-ahead) it would not.
    const survived = await readJson(artifactPath);
    strictEqual(survived.status, 'planned');
    strictEqual(survived.terminal, false);
    ok(/^[0-9a-f]{64}$/.test(survived.plan_hash));
    ok(survived.planned_actions.some((a) => a.args.join(' ') === 'plugin marketplace add each4all/agentic-plugins'));
  });

  it('write-ahead: the retired-plugin cleanup executor journals its action (§1.5 #26)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-cleanup-writeahead-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-cleanup-writeahead-home-'));
    await seedRepo(root);
    const artifactPath = join(root, '.agentic-plugins', 'runs', 'settings', SETTINGS_RUN_ID, 'settings.json');
    const CLEANUP = 'claude plugin uninstall research@agentic-plugins';

    const calls = [];
    const base = fakeRunner({
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
      [CLEANUP]: okResult('cleanup ok\n'),
    }, calls);
    let recordAtActionTime = null;
    const spy = async (command, args) => {
      const key = `${command} ${args.join(' ')}`;
      if (key === CLEANUP && recordAtActionTime === null) {
        recordAtActionTime = JSON.parse(await readFile(artifactPath, 'utf8'));
      }
      return base(command, args);
    };

    await runSettings({
      repoRoot: root,
      homeDir: home,
      runId: SETTINGS_RUN_ID,
      executePluginCleanup: true,
      runner: spy,
    });

    ok(recordAtActionTime, 'planned record existed before the cleanup action ran');
    strictEqual(recordAtActionTime.status, 'planned');
    ok(recordAtActionTime.planned_actions.some((a) => a.area === 'plugin-cleanup' && a.args.join(' ') === 'plugin uninstall research@agentic-plugins'));
    const final = await readJson(artifactPath);
    strictEqual(final.terminal, true);
    const cleanupEntry = final.journal.find((entry) => entry.area === 'plugin-cleanup');
    ok(cleanupEntry, 'journal records the cleanup action');
    strictEqual(cleanupEntry.status, 'executed');
    strictEqual(cleanupEntry.action, 'uninstall-retired-plugin');
  });

  it('plan-hash: refuses to execute when the expected hash diverges from the fresh plan (§1.6 #25)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-planhash-refuse-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-planhash-refuse-home-'));
    await seedRepo(root);

    const calls = [];
    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runId: SETTINGS_RUN_ID,
      executePluginManagement: true,
      pluginManagementHost: 'codex',
      expectedPlanHash: 'a'.repeat(64),
      runner: fakeRunner({ ...defaultCliMap(), [MARKETPLACE_ADD]: okResult('marketplace ok\n') }, calls),
    });

    strictEqual(report.plugin_management.plan_hash_status, 'mismatch');
    strictEqual(report.plugin_management.plan_hash_expected, 'a'.repeat(64));
    ok(!calls.includes(MARKETPLACE_ADD), 'the divergent plan is NOT executed');
    // The freshly recomputed hash is re-presented, not the stale one.
    ok(/^[0-9a-f]{64}$/.test(report.plugin_management.plan_hash));
    notStrictEqual(report.plugin_management.plan_hash, 'a'.repeat(64));
    const artifact = await readJson(join(root, '.agentic-plugins', 'runs', 'settings', SETTINGS_RUN_ID, 'settings.json'));
    strictEqual(artifact.status, 'refused');
    strictEqual(artifact.terminal, true);
    strictEqual(artifact.journal.length, 0, 'a refused run runs no actions');
  });

  it('plan-hash: a matching expected hash validates and executes (§1.6)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-planhash-ok-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-planhash-ok-home-'));
    await seedRepo(root);

    // Learn the plan hash from a dry-run (what bootstrap would present).
    const dry = await runSettings({
      repoRoot: root,
      homeDir: home,
      pluginManagementHost: 'codex',
      runner: fakeRunner({ ...defaultCliMap(), [MARKETPLACE_ADD]: okResult('marketplace ok\n') }),
    });
    const hash = dry.plugin_management.plan_hash;
    ok(/^[0-9a-f]{64}$/.test(hash), 'dry-run exposes the plan hash for the operator to carry');

    const calls = [];
    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runId: SETTINGS_RUN_ID,
      executePluginManagement: true,
      pluginManagementHost: 'codex',
      expectedPlanHash: hash,
      runner: fakeRunner({ ...defaultCliMap(), [MARKETPLACE_ADD]: okResult('marketplace ok\n') }, calls),
    });

    strictEqual(report.plugin_management.plan_hash_status, 'validated');
    strictEqual(report.plugin_management.plan_hash, hash);
    ok(calls.includes(MARKETPLACE_ADD), 'the validated plan executes');
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

  it('reports the legacy plugin_hooks gate read-only without planning a host-config write', async () => {
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
    // ADR-0035 §6 hard-remove: no executable hook recommendation, no host-config
    // write plan, no hook-level mutation boundary; the gate state stays readable.
    ok(!report.hook_settings.recommendations.some((item) => item.action === 'enable-codex-plugin-hooks'));
    ok(report.hook_settings.recommendations.every((item) => item.executable === false));
    strictEqual(report.hook_settings.host_config, undefined);
    strictEqual(report.hook_settings.mutation_boundary, undefined);
    ok(!report.recommendations.some((item) => item.area === 'hooks' && item.action === 'enable-codex-plugin-hooks'));
    const text = formatText(report);
    ok(text.includes('Codex Plugin Hooks'));
    ok(text.includes('plugin-hooks: legacy gate [features].plugin_hooks=false'));
    ok(text.includes('does not write Codex host config'));
    ok(!text.includes('apply-command: runtime:settings --apply-codex-plugin-hooks'));
    ok(!text.includes('session-command: codex --enable plugin_hooks'));
    await rejects(readFile(join(home, '.codex', 'config.toml'), 'utf8'), /ENOENT/);
  });

  it('skips the removed plugin_hooks write and surfaces generic hooks when Codex removed the flag', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-hooks-removed-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-hooks-removed-home-'));
    await seedRepo(root);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultCliMap(),
        'codex features list': okResult('hooks stable true\nplugin_hooks removed false\nplugins stable true\nmulti_agent stable true\n'),
      }),
    });

    // plugin_hooks removed + generic hooks on => ready via the generic gate;
    // ADR-0035 §6: no host-config plan or hook-level mutation boundary exists.
    strictEqual(report.hook_settings.status, 'ready');
    strictEqual(report.hook_settings.host_config, undefined);
    strictEqual(report.hook_settings.mutation_boundary, undefined);
    ok(!report.hook_settings.recommendations.some((item) => item.action === 'enable-codex-plugin-hooks'));
    ok(!report.recommendations.some((item) => item.area === 'hooks' && item.action === 'enable-codex-plugin-hooks'));
    ok(formatText(report).includes('plugin-hooks: removed on this Codex'));
    ok(!formatText(report).includes('session-command: codex --enable plugin_hooks'));
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
    ok(followup.verify.includes('2 review target(s)'));
    ok(followup.verify.includes('New hook - review required'));
    ok(followup.verify.includes('Installed counts alone'));
    ok(followup.verify.includes('Active=0'));
    ok(followup.verify.includes('runtime:settings --attest-codex-hook-review'));
    strictEqual(followup.review_targets.length, 2);
    const engineerTarget = followup.review_targets.find((target) => target.plugin === 'engineer');
    strictEqual(engineerTarget.version, '1.0.0');
    strictEqual(engineerTarget.manifest_exposed, true);
    ok(engineerTarget.hooks_path.endsWith(join('plugins', 'engineer', 'hooks', 'hooks.json')));
    deepStrictEqual(engineerTarget.events, ['PreCompact', 'SessionStart', 'Stop']);
    strictEqual(engineerTarget.handler_count, 3);
    strictEqual(engineerTarget.command_count, 1);
    deepStrictEqual(engineerTarget.commands, [PORTABLE_HOOK_COMMAND]);
    ok(formatText(report).includes('command: /hooks'));
    ok(formatText(report).includes('review-target: engineer@1.0.0'));
    ok(formatText(report).includes(`path=${engineerTarget.hooks_path}`));
    ok(formatText(report).includes(`hook-command: ${PORTABLE_HOOK_COMMAND}`));
  });

  it('carries Codex hook command portability warnings into settings output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-hook-command-warning-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-hook-command-warning-home-'));
    await seedRepo(root);
    await writeJson(join(root, 'plugins', 'engineer', 'hooks', 'hooks.json'), {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/adapters/claude/hooks/stop.mjs"' }] }],
      },
    });

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultCliMap(),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
      }),
    });

    deepStrictEqual(report.hook_settings.packaged_plugins.command_warnings, ['engineer']);
    ok(report.hook_settings.recommendations.some((rec) => rec.action === 'verify-codex-hook-command-portability'));
    ok(formatText(report).includes('command-warnings=engineer'));
  });

  it('does not warn when Codex hook commands use compatibility root aliases with Codex adapter paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-hook-command-alias-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-hook-command-alias-home-'));
    await seedRepo(root);
    await writeJson(join(root, 'plugins', 'engineer', 'hooks', 'hooks.json'), {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '/bin/sh "${CLAUDE_PLUGIN_ROOT}/adapters/codex/hooks/run-node-hook.sh" "${CLAUDE_PLUGIN_ROOT}/adapters/codex/hooks/stop.mjs"' }] }],
      },
    });

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultCliMap(),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
      }),
    });

    deepStrictEqual(report.hook_settings.packaged_plugins.command_warnings, []);
    ok(!report.hook_settings.recommendations.some((rec) => rec.action === 'verify-codex-hook-command-portability'));
    ok(formatText(report).includes('command-warnings=none'));
  });

  it('records Codex hook review attestation behind an explicit flag', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-hook-review-attest-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-hook-review-attest-home-'));
    await seedRepo(root);
    // An attestable machine (S8a5): the hooks are actually reviewable/trusted there —
    // Codex-installed plugin evidence + the trusted hook-state rows /hooks records.
    // The pre-S8a5 version of this test attested against an EMPTY home, which pinned
    // the exact born-stale artifact the producer gate now refuses.
    await seedCodexInstallCache(home, 'engineer', '1.0.0');
    await seedCodexInstallCache(home, 'orchestrator', '1.0.0');
    await writeTrustedCodexHookStateConfig(home);

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
    ok(artifact.codex_hook_review.assertion.includes('/hooks was opened'));
    ok(artifact.codex_hook_review.assertion.includes('all listed'));
    strictEqual(artifact.codex_hook_review.review_targets.length, 2);
    const artifactEngineerTarget = artifact.codex_hook_review.review_targets.find((target) => target.plugin === 'engineer');
    strictEqual(artifactEngineerTarget.version, '1.0.0');
    deepStrictEqual(artifactEngineerTarget.events, ['PreCompact', 'SessionStart', 'Stop']);
    strictEqual(artifactEngineerTarget.command_count, 1);
    deepStrictEqual(artifactEngineerTarget.command_warnings, []);
    ok(artifact.codex_hook_review.limits.some((limit) => limit.includes('not host-native proof')));
    ok(artifact.codex_hook_review.limits.some((limit) => limit.includes('Active=0')));
    strictEqual(artifact.summary.codex_hook_review_attested, true);
    ok(formatText(report).includes('Codex Hook Review'));
    ok(formatText(report).includes(`runtime:settings ${RUNTIME_VERSION} (codex-hook-review)`));
    ok(formatText(report).includes('operator confirms /hooks was opened'));
    ok(formatText(report).includes('not host-native proof'));
  });

  it('emits canonical bound_versions (list-authoritative) + attested_plugins, keeping the legacy map (S8a4-2)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-bound-versions-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-bound-versions-home-'));
    await seedRepo(root); // source: engineer + orchestrator 1.0.0, both codex-hook-bearing
    await writeTrustedCodexHookStateConfig(home);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runId: SETTINGS_RUN_ID,
      attestCodexHookReview: true,
      runner: fakeRunner(codex0137Map({
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
        // Codex list is AUTHORITATIVE: engineer AND orchestrator installed at 0.7.0 —
        // distinct from the 1.0.0 source manifests, so a resolver → installed_version
        // swap (which falls through to source) is what these pins bite.
        'codex plugin list --json': codexListJson([
          { name: 'engineer', marketplaceName: 'agentic-plugins', version: '0.7.0', installed: true, enabled: true },
          { name: 'orchestrator', marketplaceName: 'agentic-plugins', version: '0.7.0', installed: true, enabled: true },
        ]),
      })),
    });

    const review = report.codex_hook_review;
    strictEqual(review.status, 'attested');
    // (a) Codex CLI version is bound from the probe text (codex0137Map → 0.137.0).
    strictEqual(review.bound_versions.codex, '0.137.0');
    // (b) plugins.codex is LIST-authoritative: both bound at the list version 0.7.0,
    // never the 1.0.0 the generic installed_version fallback would report.
    deepStrictEqual(review.bound_versions.plugins.codex, { engineer: '0.7.0', orchestrator: '0.7.0' });
    // (c) attested_plugins is the full bundled hook set (importer projects to selection later).
    deepStrictEqual(review.attested_plugins, ['engineer', 'orchestrator']);
    // (d) the legacy flat map is retained through the compat window.
    strictEqual(review.plugin_versions.engineer, '0.7.0');

    const artifact = JSON.parse(await readFile(join(root, '.agentic-plugins', 'runs', 'settings', SETTINGS_RUN_ID, 'settings.json'), 'utf8'));
    deepStrictEqual(artifact.codex_hook_review.bound_versions.plugins.codex, { engineer: '0.7.0', orchestrator: '0.7.0' });
    strictEqual(artifact.codex_hook_review.bound_versions.codex, '0.137.0');
    deepStrictEqual(artifact.codex_hook_review.attested_plugins, ['engineer', 'orchestrator']);
  });

  // The pre-S8a5 twin of the test above deliberately attested a machine where
  // orchestrator was NOT Codex-installed, pinning "a codex-not-installed plugin binds
  // no canonical version". That artifact was born stale: doctor's mirror resolves the
  // missing plugin to a null version, which never counts as current — so the producer
  // was minting claims its own mirror rejected on arrival. The attestable verdict from
  // the S8a4 version authority (attestable:false for not_installed AND disabled) is
  // now CONSUMED, and the same fixture pins the refusal instead. The resolver →
  // installed_version swap this used to bite still bites: the generic fallback would
  // resolve orchestrator from source (1.0.0), flip it attestable, and fail the
  // blocked assertion below.
  it('blocks attestation when a bundled hook plugin is not Codex-installed (attestable:false, S8a5)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-attest-not-installed-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-attest-not-installed-home-'));
    await seedRepo(root);
    await writeTrustedCodexHookStateConfig(home);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runId: SETTINGS_RUN_ID,
      attestCodexHookReview: true,
      runner: fakeRunner(codex0137Map({
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
        'codex plugin list --json': codexListJson([
          { name: 'engineer', marketplaceName: 'agentic-plugins', version: '0.7.0', installed: true, enabled: true },
        ]),
      })),
    });

    const review = report.codex_hook_review;
    strictEqual(review.status, 'blocked');
    ok(review.reason.includes('orchestrator (plugin is not installed on Codex (list-authoritative))'), review.reason);
    deepStrictEqual(review.attested_plugins, [], 'a blocked attestation covers nothing');
    // Diagnostics still emitted on the blocked record: canonical map omits the
    // not-installed plugin while the legacy map carries its source fallback —
    // canonical ≠ legacy is exactly the list-authority distinction.
    deepStrictEqual(review.bound_versions.plugins.codex, { engineer: '0.7.0' });
    strictEqual(review.plugin_versions.orchestrator, '1.0.0');
  });

  it('blocks attestation for a Codex-DISABLED bundled hook plugin (a disabled plugin loads no hooks, S8a5)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-attest-disabled-plugin-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-attest-disabled-plugin-home-'));
    await seedRepo(root);
    // Hook-state rows all trusted and enabled — the PLUGIN, not any handler, is what
    // is off, so only the attestable verdict can catch it (the peer-found gap: both
    // producer and mirror consumed only `.version` from the authority and let a
    // disabled plugin with a matching version attest and read current).
    await writeTrustedCodexHookStateConfig(home);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runId: SETTINGS_RUN_ID,
      attestCodexHookReview: true,
      runner: fakeRunner(codex0137Map({
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
        'codex plugin list --json': codexListJson([
          { name: 'engineer', marketplaceName: 'agentic-plugins', version: '0.7.0', installed: true, enabled: false },
          { name: 'orchestrator', marketplaceName: 'agentic-plugins', version: '0.7.0', installed: true, enabled: true },
        ]),
      })),
    });

    const review = report.codex_hook_review;
    strictEqual(review.status, 'blocked');
    ok(review.reason.includes('engineer (plugin is installed but disabled on Codex — a disabled plugin loads no hooks)'), review.reason);
    deepStrictEqual(review.attested_plugins, []);
  });

  it('blocks attestation when the Codex hook-state config is missing — trust is recorded there (S8a5)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-attest-no-config-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-attest-no-config-home-'));
    await seedRepo(root);
    // Codex-installed evidence present; ONLY the trust store is absent. Pre-S8a5 this
    // attested (disabled_handlers is necessarily 0 over an empty entry list) and the
    // very next doctor called the fresh artifact hook_state_unavailable — the
    // born-stale producer/mirror disagreement the shared gate closes.
    await seedCodexInstallCache(home, 'engineer', '1.0.0');
    await seedCodexInstallCache(home, 'orchestrator', '1.0.0');

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

    const review = report.codex_hook_review;
    strictEqual(review.status, 'blocked');
    ok(review.reason.includes('the Codex hook-state config (where /hooks records trust) is missing'), review.reason);
    deepStrictEqual(review.attested_plugins, []);
    const artifact = JSON.parse(await readFile(join(root, '.agentic-plugins', 'runs', 'settings', SETTINGS_RUN_ID, 'settings.json'), 'utf8'));
    strictEqual(artifact.codex_hook_review.status, 'blocked', 'the blocked verdict is what persists');
  });

  it('threads the OBSERVED Codex CLI version into bound_versions.codex, not a constant (S8a4-2)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-bound-cli-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-bound-cli-home-'));
    await seedRepo(root);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runId: SETTINGS_RUN_ID,
      attestCodexHookReview: true,
      runner: fakeRunner({
        ...defaultCliMap(),
        // A version DISTINCT from every other version in the harness — a hardcoded or
        // wrong-field binding cannot coincidentally match it.
        'codex --version': okResult('codex-cli 0.144.1\n'),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
      }),
    });

    strictEqual(report.codex_hook_review.bound_versions.codex, '0.144.1');
  });

  it('binds a null Codex CLI version when --version is unparseable, never a guess (S8a4-2)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-bound-cli-null-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-bound-cli-null-home-'));
    await seedRepo(root);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runId: SETTINGS_RUN_ID,
      attestCodexHookReview: true,
      runner: fakeRunner({
        ...defaultCliMap(),
        // The command succeeds (Codex is available) but the text carries no parseable
        // semver — the attestation must record the CLI version as unbound (null), never
        // fabricate one, so the reducer reads it as never-current until re-recorded.
        'codex --version': okResult('codex-cli\n'),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
      }),
    });

    strictEqual(report.codex_hook_review.bound_versions.codex, null);
  });

  it('leaves attested_plugins empty when the attestation is blocked (S8a4-2)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-attested-empty-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-attested-empty-home-'));
    await seedRepo(root);
    await writeDisabledCodexHookStateConfig(home); // forces status=blocked

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

    strictEqual(report.codex_hook_review.status, 'blocked');
    deepStrictEqual(report.codex_hook_review.attested_plugins, [], 'a blocked attestation covers nothing');
    // bound_versions is still emitted for diagnostics — only attested_plugins gates on success.
    strictEqual(report.codex_hook_review.bound_versions.codex, '0.130.0');
  });

  it('refuses --attest-codex-hook-review combined with an execution flag (stale pre-exec snapshot, S8a4-2)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-attest-combo-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-attest-combo-home-'));
    await seedRepo(root);

    await rejects(
      () => runSettings({
        repoRoot: root,
        homeDir: home,
        attestCodexHookReview: true,
        executePluginManagement: true,
        runner: fakeRunner(defaultCliMap()),
      }),
      /attest-codex-hook-review cannot be combined with --execute-plugin-management/,
    );

    await rejects(
      () => runSettings({
        repoRoot: root,
        homeDir: home,
        attestCodexHookReview: true,
        executePluginCleanup: true,
        runner: fakeRunner(defaultCliMap()),
      }),
      /attest-codex-hook-review cannot be combined with --execute-plugin-cleanup/,
    );
  });

  it('blocks Codex hook review attestation while expected hook states are disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-hook-state-disabled-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-hook-state-disabled-home-'));
    await seedRepo(root);
    await writeDisabledCodexHookStateConfig(home);

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

    strictEqual(report.codex_hook_review.status, 'blocked');
    // The gate blocks on the PER-HANDLER count (S8a5) — the group count false-passed a
    // disabled handler beside an enabled sibling.
    ok(report.codex_hook_review.reason.includes('6 expected bundled hook handler(s) across 6 expected entries are explicitly disabled'));
    strictEqual(report.hook_settings.hook_state.summary.expected_disabled, 6);
    strictEqual(report.hook_settings.hook_state.summary.disabled_handlers, 6);
    ok(report.hook_settings.recommendations.some((rec) => rec.action === 'enable-codex-hook-state'));
    const followup = report.plugin_management.manual_followups.find((entry) => entry.id === 'codex-hook-review');
    ok(followup.verify.includes('6 explicitly disabled hook handler(s) across 6 expected bundled hook entries'));
    const artifact = JSON.parse(await readFile(join(root, '.agentic-plugins', 'runs', 'settings', SETTINGS_RUN_ID, 'settings.json'), 'utf8'));
    strictEqual(artifact.codex_hook_review.status, 'blocked');
    ok(formatText(report).includes('hook-state: config=available; expected=6; enabled=0; disabled=6; disabled-handlers=6'));
    ok(/hook-state: [^\n]*unmapped=0/.test(formatText(report)), 'settings renders the hook-state unmapped counter');
    ok(formatText(report).includes('disabled-hook-handler: engineer; event=pre_compact; path=hooks/hooks.json; group=0; hook=0; group-state=disabled'));
  });

  // THE S8a5 FALSE-PASS PIN, producer side. The group grain reads this machine as
  // nothing-disabled (every expected entry has an enabled trusted row), so the
  // pre-S8a5 gate attested straight through it — and doctor's mirror then called the
  // fresh attestation stale on the same evidence. The per-handler gate blocks first.
  it('blocks attestation on a disabled handler masked by an enabled sibling (S8a5)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-hook-sibling-mask-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-hook-sibling-mask-home-'));
    await seedRepo(root);
    // TWO real Stop handlers (peer finding: with the default single-handler fixture
    // the 0:1 row below would model a STALE index, not a live sibling — the
    // aggregation treats both alike today, but this test's name promises the sibling
    // case, so the fixture delivers it).
    await writeJson(join(root, 'plugins', 'engineer', 'hooks', 'hooks.json'), {
      hooks: {
        SessionStart: [{ matcher: 'compact', hooks: [{ type: 'command', command: PORTABLE_HOOK_COMMAND }] }],
        PreCompact: [{ hooks: [{ type: 'command', command: PORTABLE_HOOK_COMMAND }] }],
        Stop: [{ hooks: [{ type: 'command', command: PORTABLE_HOOK_COMMAND }, { type: 'command', command: PORTABLE_HOOK_COMMAND }] }],
      },
    });
    await writeSiblingMaskedCodexHookStateConfig(home);

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

    // Premise pins: this IS the masked case — the group grain sees nothing.
    strictEqual(report.hook_settings.hook_state.summary.expected_disabled, 0, 'no group is fully disabled');
    strictEqual(report.hook_settings.hook_state.summary.disabled_handlers, 1, 'the handler grain sees the disabled sibling');

    strictEqual(report.codex_hook_review.status, 'blocked');
    ok(report.codex_hook_review.reason.includes('1 expected bundled hook handler(s)'), report.codex_hook_review.reason);
    strictEqual(report.codex_hook_review.attested, false);
    const artifact = JSON.parse(await readFile(join(root, '.agentic-plugins', 'runs', 'settings', SETTINGS_RUN_ID, 'settings.json'), 'utf8'));
    strictEqual(artifact.codex_hook_review.status, 'blocked', 'the blocked verdict is what persists');
    ok(formatText(report).includes('disabled-hook-handler: engineer; event=stop; path=hooks/hooks.json; group=0; hook=1; group-state=enabled_trusted'));
  });

  it('never writes Codex host config: the removed --apply-codex-plugin-hooks executor stays gone', async () => {
    // ADR-0035 §6 hard-remove regression gate: the flag is no longer a CLI
    // argument, and a default runSettings run leaves ~/.codex untouched.
    await rejects(async () => parseArgs(['--apply-codex-plugin-hooks']), /Unknown argument: --apply-codex-plugin-hooks/);

    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-hooks-apply-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-hooks-apply-home-'));
    await seedRepo(root);
    await mkdir(join(home, '.codex'), { recursive: true });
    const originalConfig = [
      'model = "gpt-5.5"',
      '',
      '[features]',
      'hooks = true',
      '',
      '[notice]',
      'hide_full_access_warning = true',
      '',
    ].join('\n');
    await writeFile(join(home, '.codex', 'config.toml'), originalConfig);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner(defaultCliMap()),
    });

    strictEqual(report.dry_run, true);
    strictEqual(report.apply_codex_plugin_hooks, undefined);
    strictEqual(report.hook_settings.host_config, undefined);
    ok(report.mutation_boundary.forbidden.includes('host-native Codex CLI config'));
    strictEqual(await readFile(join(home, '.codex', 'config.toml'), 'utf8'), originalConfig);
    // The codex-plugin-hooks execution mode no longer exists; default runs render dry-run.
    ok(formatText(report).includes(`runtime:settings ${RUNTIME_VERSION} (dry-run)`));
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

    strictEqual(report.schema_version, 'runtime-settings-1.26');
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

  it('recognizes the Codex per-plugin surface in cache materialization on 0.137.0 (ADR-0032)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-codex-perplugin-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-codex-perplugin-home-'));
    await seedRepo(root);
    await seedCodexTmpMarketplace(home, 'runtime', '0.1.0');

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultCliMap(),
        'codex --version': okResult('codex-cli 0.137.0\n'),
        'codex --help': okResult('Commands:\n  exec Run Codex non-interactively\n  login status\n  plugin  Manage Codex plugins\nOptions:\n  --model\n  --config\n  --cd\n  --sandbox\n  --ask-for-approval\n'),
        'codex plugin --help': okResult('Manage Codex plugins\n\nUsage: codex plugin <COMMAND>\n\nCommands:\n  add          Install a plugin from a configured marketplace snapshot\n  list         List plugins available from configured marketplace snapshots\n  marketplace  Add, list, upgrade, or remove configured plugin marketplaces\n  remove       Remove an installed plugin from local config and cache\n'),
        'codex plugin marketplace --help': okResult('Add, list, upgrade, or remove configured plugin marketplaces\n\nUsage: codex plugin marketplace <COMMAND>\n\nCommands:\n  add\n  list\n  upgrade\n  remove\n'),
      }),
    });

    const materialize = report.plugins.runtime.recommendations.find((rec) => rec.host === 'codex' && rec.action === 'materialize-plugin-cache');
    ok(materialize.detail.includes('does not auto-execute codex plugin add'));
    ok(materialize.detail.includes('per-plugin add/list/remove'));
    ok(!materialize.detail.includes('rather than per-plugin install/list'));
    strictEqual(materialize.evidence.command_surface, 'per-plugin-and-marketplace');
    ok(materialize.next_step.includes('codex plugin add runtime@agentic-plugins'));
    strictEqual(report.plugin_command_surface.codex.mode, 'per-plugin-and-marketplace');
    strictEqual(report.plugin_command_surface.codex.supports.remove_plugin, true);
    strictEqual(report.plugin_command_surface.codex.supports.marketplace_list, true);
    ok(formatText(report).includes('codex command surface: mode=per-plugin-and-marketplace'));
    ok(formatText(report).includes('plugin-add=true'));
    ok(formatText(report).includes('marketplace-list=true'));
  });

  it('does not overclaim per-plugin verbs in settings on an add-only Codex host (ADR-0032)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-codex-addonly-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-codex-addonly-home-'));
    await seedRepo(root);
    await seedCodexTmpMarketplace(home, 'runtime', '0.1.0');

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultCliMap(),
        'codex --version': okResult('codex-cli 0.137.0\n'),
        'codex --help': okResult('Commands:\n  exec Run Codex non-interactively\n  login status\n  plugin  Manage Codex plugins\nOptions:\n  --model\n  --config\n  --cd\n  --sandbox\n  --ask-for-approval\n'),
        // Hypothetical add-only host: install verb present, no list/remove.
        'codex plugin --help': okResult('Manage Codex plugins\n\nUsage: codex plugin <COMMAND>\n\nCommands:\n  add          Install a plugin from a configured marketplace snapshot\n  marketplace  Add, list, upgrade, or remove configured plugin marketplaces\n'),
        'codex plugin marketplace --help': okResult('Add, list, upgrade, or remove configured plugin marketplaces\n\nUsage: codex plugin marketplace <COMMAND>\n\nCommands:\n  add\n  list\n  upgrade\n  remove\n'),
      }),
    });

    const materialize = report.plugins.runtime.recommendations.find((rec) => rec.host === 'codex' && rec.action === 'materialize-plugin-cache');
    ok(materialize.detail.includes('Codex exposes per-plugin add;'));
    ok(!materialize.detail.includes('add/list/remove'));
    strictEqual(report.plugin_command_surface.codex.supports.list_plugin, false);
    strictEqual(report.plugin_command_surface.codex.supports.remove_plugin, false);
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

  it('does not recommend installing Codex when the list authoritatively reports installed; only reworded materialization (ADR-0034)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-codexlist-installed-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-codexlist-installed-home-'));
    await seedRepo(root);
    await seedCodexTmpMarketplace(home, 'runtime', '0.1.0');

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner(codex0137Map({
        'codex plugin list --json': codexListJson([{ name: 'runtime', marketplaceName: 'agentic-plugins', version: '0.1.0', installed: true, enabled: true }]),
      })),
    });

    const codexRecommendations = report.plugins.runtime.recommendations.filter((rec) => rec.host === 'codex');
    // List authoritatively reports installed -> never imply "install it".
    ok(codexRecommendations.every((rec) => rec.action !== 'add-marketplace'));
    const materialize = codexRecommendations.find((rec) => rec.action === 'materialize-plugin-cache');
    ok(materialize, 'expected a reworded materialize recommendation');
    ok(materialize.detail.includes('installed, but runtime did not find a materialized'));
    strictEqual(materialize.evidence.list_decision, 'installed');
    strictEqual(materialize.evidence.list_version, '0.1.0');
    strictEqual(materialize.evidence.install_cache_status, 'missing');
  });

  it('recommends enabling a Codex plugin the list reports installed-but-disabled, not materialization (ADR-0034)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-codexlist-disabled-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-codexlist-disabled-home-'));
    await seedRepo(root);
    await seedCodexTmpMarketplace(home, 'runtime', '0.1.0');

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner(codex0137Map({
        'codex plugin list --json': codexListJson([{ name: 'runtime', marketplaceName: 'agentic-plugins', version: '0.1.0', installed: true, enabled: false }]),
      })),
    });

    const codexRecommendations = report.plugins.runtime.recommendations.filter((rec) => rec.host === 'codex');
    const enable = codexRecommendations.find((rec) => rec.action === 'enable-plugin');
    ok(enable, 'expected an enable-plugin follow-up');
    ok(enable.detail.includes('installed but disabled'));
    strictEqual(enable.evidence.list_decision, 'disabled');
    // A disabled install is not a cache-materialization or marketplace-add problem.
    ok(codexRecommendations.every((rec) => rec.action !== 'materialize-plugin-cache'));
    ok(codexRecommendations.every((rec) => rec.action !== 'add-marketplace'));
  });

  it('offers an executable codex plugin add for a not-installed plugin on the per-plugin surface (ADR-0035 §5/§6)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-codexlist-absent-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-codexlist-absent-home-'));
    await seedRepo(root);
    await seedCodexTmpMarketplace(home, 'runtime', '0.1.0');

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner(codex0137Map({
        'codex plugin list --json': codexListJson([{ name: 'runtime', marketplaceName: 'agentic-plugins', version: '0.1.0', installed: false, enabled: false }]),
      })),
    });

    const codexRecommendations = report.plugins.runtime.recommendations.filter((rec) => rec.host === 'codex');
    // Per-plugin surface (codex0137Map exposes `add`) → executable C executor, policy-gated at execute time.
    const rec = codexRecommendations.find((r) => r.action === 'install-plugin');
    ok(rec, 'expected an executable codex install recommendation');
    strictEqual(rec.executable, true);
    strictEqual(rec.command, 'codex plugin add runtime@agentic-plugins');
    deepStrictEqual(rec.argv, { command: 'codex', args: ['plugin', 'add', 'runtime@agentic-plugins'] });
    ok(rec.detail.includes('policy-gated'));
    ok(rec.detail.includes('never trusts hooks'));
    strictEqual(rec.evidence.list_decision, 'not_installed');
    ok(codexRecommendations.every((r) => r.action !== 'materialize-plugin-cache'));
    ok(codexRecommendations.every((r) => r.action !== 'install-plugin-manual'));
  });

  it('recommends a Codex marketplace upgrade when the list reports installed but older than source (ADR-0034)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-codexlist-older-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-codexlist-older-home-'));
    await seedRepo(root);
    await seedCodexTmpMarketplace(home, 'runtime', '0.1.0');

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner(codex0137Map({
        // Installed per list, but at 0.0.5 — older than the 0.1.0 source/catalog.
        'codex plugin list --json': codexListJson([{ name: 'runtime', marketplaceName: 'agentic-plugins', version: '0.0.5', installed: true, enabled: true }]),
      })),
    });

    const codexRecommendations = report.plugins.runtime.recommendations.filter((rec) => rec.host === 'codex');
    const upgrade = codexRecommendations.find((rec) => rec.action === 'upgrade-marketplace');
    ok(upgrade, 'expected an upgrade-marketplace recommendation from the list version');
    ok(upgrade.detail.includes('reports runtime 0.0.5 installed'));
    strictEqual(upgrade.evidence.list_decision, 'installed');
    strictEqual(upgrade.evidence.list_version, '0.0.5');
    ok(codexRecommendations.every((rec) => rec.action !== 'add-marketplace'));
  });

  it('ignores a stale codex install cache when the list reports not installed (ADR-0034)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-codexlist-stalecache-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-codexlist-stalecache-home-'));
    await seedRepo(root);
    await seedCodexTmpMarketplace(home, 'runtime', '0.1.0');
    // A stale per-plugin install cache lingers at 0.0.5, but the authoritative list
    // says runtime is not installed — the stale cache must not drive an upgrade.
    await seedCodexInstallCache(home, 'runtime', '0.0.5');

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner(codex0137Map({
        'codex plugin list --json': codexListJson([{ name: 'runtime', marketplaceName: 'agentic-plugins', version: '0.1.0', installed: false, enabled: false }]),
      })),
    });

    const codexRecommendations = report.plugins.runtime.recommendations.filter((rec) => rec.host === 'codex');
    // The stale install cache must NOT surface as an upgrade or materialization.
    ok(codexRecommendations.every((rec) => rec.action !== 'upgrade-marketplace'));
    ok(codexRecommendations.every((rec) => rec.action !== 'materialize-plugin-cache'));
    const install = codexRecommendations.find((rec) => rec.action === 'install-plugin');
    ok(install, 'expected an executable codex install recommendation, not a cache-derived upgrade');
    strictEqual(install.executable, true);
    strictEqual(install.command, 'codex plugin add runtime@agentic-plugins');
    strictEqual(install.evidence.list_decision, 'not_installed');
    strictEqual(install.evidence.install_cache_status, 'present');
  });

  // machine-bootstrap-contract.md §1.1/§1.4.1 (S8a1 C3): on a CONSUMER machine there is no
  // `./plugins/<name>` checkout, so the old branch turned doctor's honest `marketplace: null`
  // into sixteen meaningless "add <name> to .claude-plugin/marketplace.json" remediations,
  // and its `sourceVersion` (a repo manifest read) was null so a stale install was never
  // flagged. This is the direct consumer-repo regression the contract pins.
  it('consumer repo (no source): registered-catalog currentness flags a stale install AND emits zero false register-marketplace-entry', async () => {
    // NO seedRepo — this repo is not an agentic-plugins checkout.
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-consumer-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-consumer-home-'));
    // The operator's registered marketplace catalog (machine-scoped, resolved from the C2
    // registration probe's installLocation), NOT a repo checkout. It carries runtime 0.1.0.
    const installLoc = await mkdtemp(join(tmpdir(), 'runtime-settings-consumer-mp-'));
    await mkdir(join(installLoc, '.claude-plugin'), { recursive: true });
    await writeJson(join(installLoc, '.claude-plugin', 'marketplace.json'), {
      name: 'agentic-plugins',
      plugins: [{ name: 'runtime', source: 'each4all/agentic-plugins', version: '0.1.0', category: 'Productivity' }],
    });

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultCliMap(),
        // runtime installed at 0.0.5 — older than the registered catalog's 0.1.0.
        'claude plugin list': okResult('Installed plugins:\n\n  > runtime@agentic-plugins\n    Version: 0.0.5\n    Scope: user\n    Status: enabled\n'),
        'claude /plugin list': okResult('Installed plugins:\n\n  > runtime@agentic-plugins\n    Version: 0.0.5\n    Scope: user\n    Status: enabled\n'),
        'claude plugin marketplace list --json': okResult(JSON.stringify([
          { name: 'agentic-plugins', source: 'github', repo: 'each4all/agentic-plugins', installLocation: installLoc },
        ])),
      }),
    });

    // (1) ZERO false remediations: no `./plugins/<name>` checkout → no register-marketplace-entry
    // for ANY plugin on ANY host (the sixteen false remediations disappear).
    for (const name of Object.keys(report.plugins)) {
      ok(
        report.plugins[name].recommendations.every((rec) => rec.action !== 'register-marketplace-entry'),
        `${name} must not get a repo-catalog register-marketplace-entry on a consumer machine`,
      );
    }
    // (2) Stale-update detected via the REGISTERED-CATALOG installLocation, not a repo source.
    const update = report.plugins.runtime.recommendations.find((rec) => rec.action === 'update-plugin' && rec.host === 'claude');
    ok(update, 'expected a claude update-plugin driven by the registered-catalog currentness target');
    ok(update.detail.includes('registered catalog 0.1.0'), `detail must cite the registered catalog, got: ${update.detail}`);
  });

  // peer #8 (S8a1 C3): the `sourceVersion` that drives currentness ALSO fed Codex hook
  // attestation + review targets. Sourcing currentness from the registered catalog must NOT
  // leak a catalog-latest version into the attestation — an operator attests the INSTALLED
  // hooks, never a version that may not be installed. This is the 3-way split, exercised with
  // three DISTINCT versions: source 1.0.0, installed 0.0.5, registered catalog 0.9.9.
  it('binds Codex hook attestation/review-targets to the INSTALLED version, never source or registered catalog (peer #8)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-3way-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-3way-home-'));
    await seedRepo(root); // source: engineer 1.0.0 + codex hooks (bundled)
    await seedCodexInstallCache(home, 'engineer', '0.0.5'); // INSTALLED (codex cache) 0.0.5
    // Registered catalog carries engineer 0.9.9 — distinct from BOTH source and installed.
    const installLoc = await mkdtemp(join(tmpdir(), 'runtime-settings-3way-mp-'));
    await mkdir(join(installLoc, '.claude-plugin'), { recursive: true });
    await writeJson(join(installLoc, '.claude-plugin', 'marketplace.json'), {
      name: 'agentic-plugins',
      plugins: [{ name: 'engineer', source: 'each4all/agentic-plugins', version: '0.9.9', category: 'Productivity' }],
    });

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runId: SETTINGS_RUN_ID,
      attestCodexHookReview: true,
      runner: fakeRunner({
        ...defaultCliMap(),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
        'claude plugin marketplace list --json': okResult(JSON.stringify([
          { name: 'agentic-plugins', source: 'github', repo: 'each4all/agentic-plugins', installLocation: installLoc },
        ])),
      }),
    });

    const engineerTarget = report.codex_hook_review.review_targets.find((target) => target.plugin === 'engineer');
    ok(engineerTarget, 'engineer is a bundled codex-hook plugin');
    strictEqual(engineerTarget.version, '0.0.5', 'review target binds the codex-installed version');
    ok(engineerTarget.version !== '0.9.9', 'must NOT bind the registered-catalog version');
    ok(engineerTarget.version !== '1.0.0', 'must NOT bind the source version');
    const artifact = JSON.parse(await readFile(join(root, '.agentic-plugins', 'runs', 'settings', SETTINGS_RUN_ID, 'settings.json'), 'utf8'));
    strictEqual(artifact.codex_hook_review.plugin_versions.engineer, '0.0.5', 'attestation binds the installed version, not the registered catalog');
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

  it('executes codex plugin add after a passing installPolicy/authPolicy pre-flight and post-verifies (ADR-0035 §6)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-codexinstall-ok-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-codexinstall-ok-home-'));
    await seedRepo(root);
    await seedCodexTmpMarketplace(home, 'runtime', '0.1.0');
    const others = ['companions', 'engineer', 'orchestrator'].map((n) => ({ name: n, marketplaceName: 'agentic-plugins', version: '9.9.9', installed: true, enabled: true }));
    const installed = { name: 'runtime', marketplaceName: 'agentic-plugins', version: '0.1.0', installed: true, enabled: true };
    const notInstalled = { name: 'runtime', marketplaceName: 'agentic-plugins', version: '0.1.0', installed: false, enabled: false };
    const calls = [];
    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      executePluginManagement: true,
      pluginManagementHost: 'codex',
      runner: fakeRunnerSeq(codex0137Map({
        // recommendation read: runtime not installed; post-verify read: installed.
        'codex plugin list --json': [codexListJson([...others, notInstalled]), codexListJson([...others, installed])],
        'codex plugin list --available --json': codexAvailableJson([{ name: 'runtime', marketplaceName: 'agentic-plugins', version: '0.1.0', installed: false, installPolicy: 'AVAILABLE', authPolicy: 'ON_USE' }]),
        'codex plugin add runtime@agentic-plugins': okResult('RAW INSTALL OUTPUT MUST NOT LEAK\n'),
        'codex plugin marketplace add each4all/agentic-plugins': okResult('marketplace ok\n'),
      }), calls),
    });
    const plan = report.plugin_management.plans.find((p) => p.host === 'codex' && p.action === 'install-plugin');
    ok(plan, 'expected an install-plugin plan');
    strictEqual(plan.status, 'executed');
    strictEqual(plan.command, 'codex plugin add runtime@agentic-plugins');
    strictEqual(plan.preflight.install_policy, 'AVAILABLE');
    strictEqual(plan.preflight.auth_policy, 'ON_USE');
    strictEqual(plan.post_verify.installed, true);
    ok(calls.includes('codex plugin list --available --json'), 'pre-flight policy list read');
    ok(calls.includes('codex plugin add runtime@agentic-plugins'), 'install ran');
    ok(calls.filter((c) => c === 'codex plugin list --json').length >= 2, 'recommendation + post-verify list reads');
    ok(!JSON.stringify(report).includes('RAW INSTALL OUTPUT MUST NOT LEAK'), 'raw stdout must not leak');
  });

  it('blocks codex plugin add when authPolicy is ON_INSTALL (ADR-0035 §6 block-or-manual)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-codexinstall-oninstall-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-codexinstall-oninstall-home-'));
    await seedRepo(root);
    await seedCodexTmpMarketplace(home, 'runtime', '0.1.0');
    const others = ['companions', 'engineer', 'orchestrator'].map((n) => ({ name: n, marketplaceName: 'agentic-plugins', version: '9.9.9', installed: true, enabled: true }));
    const calls = [];
    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      executePluginManagement: true,
      pluginManagementHost: 'codex',
      runner: fakeRunner(codex0137Map({
        'codex plugin list --json': codexListJson([...others, { name: 'runtime', marketplaceName: 'agentic-plugins', version: '0.1.0', installed: false, enabled: false }]),
        'codex plugin list --available --json': codexAvailableJson([{ name: 'runtime', marketplaceName: 'agentic-plugins', version: '0.1.0', installed: false, installPolicy: 'AVAILABLE', authPolicy: 'ON_INSTALL' }]),
        'codex plugin add runtime@agentic-plugins': okResult('SHOULD NOT RUN\n'),
        'codex plugin marketplace add each4all/agentic-plugins': okResult('marketplace ok\n'),
      }, calls)),
    });
    const plan = report.plugin_management.plans.find((p) => p.host === 'codex' && p.action === 'install-plugin');
    ok(plan, 'expected an install-plugin plan');
    strictEqual(plan.status, 'blocked');
    strictEqual(plan.block_reason, 'auth-required-on-install');
    strictEqual(plan.preflight.auth_policy, 'ON_INSTALL');
    ok(!calls.includes('codex plugin add runtime@agentic-plugins'), 'add must NOT run when blocked');
    // §3 invariant 8 — explicit manual recovery guidance for the blocked install.
    const followup = report.plugin_management.manual_followups.find((f) => f.id === 'codex-install-policy-blocked');
    ok(followup, 'expected a manual recovery followup for the blocked install');
    ok(followup.reasons.includes('auth-required-on-install'));
    ok(followup.commands.includes('codex plugin add runtime@agentic-plugins'));
  });

  it('blocks codex plugin add when installPolicy is not AVAILABLE (ADR-0035 §6)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-codexinstall-policy-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-codexinstall-policy-home-'));
    await seedRepo(root);
    await seedCodexTmpMarketplace(home, 'runtime', '0.1.0');
    const others = ['companions', 'engineer', 'orchestrator'].map((n) => ({ name: n, marketplaceName: 'agentic-plugins', version: '9.9.9', installed: true, enabled: true }));
    const calls = [];
    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      executePluginManagement: true,
      pluginManagementHost: 'codex',
      runner: fakeRunner(codex0137Map({
        'codex plugin list --json': codexListJson([...others, { name: 'runtime', marketplaceName: 'agentic-plugins', version: '0.1.0', installed: false, enabled: false }]),
        'codex plugin list --available --json': codexAvailableJson([{ name: 'runtime', marketplaceName: 'agentic-plugins', version: '0.1.0', installed: false, installPolicy: 'RESTRICTED', authPolicy: 'ON_USE' }]),
        'codex plugin add runtime@agentic-plugins': okResult('SHOULD NOT RUN\n'),
        'codex plugin marketplace add each4all/agentic-plugins': okResult('marketplace ok\n'),
      }, calls)),
    });
    const plan = report.plugin_management.plans.find((p) => p.host === 'codex' && p.action === 'install-plugin');
    ok(plan, 'expected an install-plugin plan');
    strictEqual(plan.status, 'blocked');
    strictEqual(plan.block_reason, 'install-policy-not-available');
    ok(!calls.includes('codex plugin add runtime@agentic-plugins'), 'add must NOT run when blocked');
  });

  it('flags CODEX_INSTALL_NOT_VERIFIED when post-verify does not report the plugin installed (ADR-0035 §6)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-codexinstall-unverified-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-codexinstall-unverified-home-'));
    await seedRepo(root);
    await seedCodexTmpMarketplace(home, 'runtime', '0.1.0');
    const others = ['companions', 'engineer', 'orchestrator'].map((n) => ({ name: n, marketplaceName: 'agentic-plugins', version: '9.9.9', installed: true, enabled: true }));
    const calls = [];
    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      executePluginManagement: true,
      pluginManagementHost: 'codex',
      // The plain list NEVER shows runtime installed — so the post-verify (read
      // after `add` returns ok) disagrees with the command's exit code.
      runner: fakeRunner(codex0137Map({
        'codex plugin list --json': codexListJson([...others, { name: 'runtime', marketplaceName: 'agentic-plugins', version: '0.1.0', installed: false, enabled: false }]),
        'codex plugin list --available --json': codexAvailableJson([{ name: 'runtime', marketplaceName: 'agentic-plugins', version: '0.1.0', installed: false, installPolicy: 'AVAILABLE', authPolicy: 'ON_USE' }]),
        'codex plugin add runtime@agentic-plugins': okResult('claims success but list disagrees\n'),
        'codex plugin marketplace add each4all/agentic-plugins': okResult('marketplace ok\n'),
      }, calls)),
    });
    const plan = report.plugin_management.plans.find((p) => p.host === 'codex' && p.action === 'install-plugin');
    ok(plan, 'expected an install-plugin plan');
    strictEqual(plan.status, 'failed');
    strictEqual(plan.result.error_code, 'CODEX_INSTALL_NOT_VERIFIED');
    strictEqual(plan.post_verify.installed, false);
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
        'claude plugin install attention@agentic-plugins': unavailable,
        'claude plugin install companions@agentic-plugins': unavailable,
        'claude plugin install designer@agentic-plugins': unavailable,
        'claude plugin install engineer@agentic-plugins': unavailable,
        'claude plugin install founder@agentic-plugins': unavailable,
        'claude plugin install image@agentic-plugins': unavailable,
        'claude plugin install orchestrator@agentic-plugins': unavailable,
        'claude plugin install runtime@agentic-plugins': unavailable,
        'claude plugin update attention@agentic-plugins': unavailable,
        'claude plugin update companions@agentic-plugins': unavailable,
        'claude plugin update designer@agentic-plugins': unavailable,
        'claude plugin update engineer@agentic-plugins': unavailable,
        'claude plugin update founder@agentic-plugins': unavailable,
        'claude plugin update image@agentic-plugins': unavailable,
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
        'claude plugin install attention@agentic-plugins': okResult('installed attention\n'),
        'claude plugin install companions@agentic-plugins': okResult('installed companions\n'),
        'claude plugin install designer@agentic-plugins': okResult('installed designer\n'),
        'claude plugin install engineer@agentic-plugins': okResult('installed engineer\n'),
        'claude plugin install founder@agentic-plugins': okResult('installed founder\n'),
        'claude plugin install image@agentic-plugins': okResult('installed image\n'),
        'claude plugin install orchestrator@agentic-plugins': okResult('installed orchestrator\n'),
      }, calls),
    });

    const claudePlans = report.plugin_management.plans.filter((plan) => plan.host === 'claude');
    ok(claudePlans.length > 0);
    strictEqual(report.plugin_command_surface.claude.mode, 'per-plugin-command');
    strictEqual(report.plugin_command_surface.claude.observed_surfaces.slash_plugin, 'unavailable');
    strictEqual(report.plugin_management.summary.blocked, 0);
    strictEqual(report.plugin_management.summary.executed, 7);
    strictEqual(report.plugin_management.summary.failed, 0);
    ok(claudePlans.some((plan) => plan.status === 'executed' && plan.command === 'claude plugin install companions@agentic-plugins'));
    // ADR-0042 RT + Codex Plan-verify MINOR: a count-preserving regression that
    // dropped designer from the plans would still satisfy `executed === 7`.
    // Assert the designer plan and its actual invocation directly.
    ok(claudePlans.some((plan) => plan.status === 'executed' && plan.command === 'claude plugin install designer@agentic-plugins'),
      'designer must have an executed Claude plugin-management plan (runtime inventory recognition)');
    ok(calls.includes('claude plugin install designer@agentic-plugins'),
      'the designer install command must actually be invoked');
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
    strictEqual(artifact.schema_version, 'runtime-settings-execution-artifact-1.3');
    strictEqual(artifact.run_id, SETTINGS_RUN_ID);
    strictEqual(artifact.status, 'failed');
    strictEqual(artifact.terminal, true);
    // Write-ahead record (machine-bootstrap-contract.md §1.5): the failed run still
    // carries the plan hash, the durable planned-action list, and a per-action journal.
    ok(/^[0-9a-f]{64}$/.test(artifact.plan_hash), 'terminal artifact carries the plan hash');
    ok(Array.isArray(artifact.planned_actions) && artifact.planned_actions.length >= 1, 'planned_actions names the intended action');
    ok(Array.isArray(artifact.journal) && artifact.journal.length >= 1, 'journal records the executed action');
    strictEqual(artifact.journal[0].status, 'failed');
    strictEqual(artifact.summary.failed_retryable, 1);
    strictEqual(artifact.failures[0].failure_type, 'network');
    strictEqual(artifact.failures[0].retryable, true);
    ok(artifact.doctor_integration.command.includes('runtime:doctor'));

    const latest = await readJson(join(root, '.agentic-plugins', 'runs', 'settings', 'latest.json'));
    strictEqual(latest.run_id, SETTINGS_RUN_ID);
    strictEqual(latest.status, 'failed');
    strictEqual(latest.terminal, true);
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
    rejects(async () => parseArgs(['--apply-codex-plugin-hooks']), /Unknown argument/);
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

  it('every config flag is advertised on ALL THREE public surfaces — cross-host parity', async () => {
    // DERIVED from CONFIG_KEYS, never a hand-listed set: the flag surface is
    // auto-generated from that array, so a key added there gets a working flag
    // immediately and can be missing from the docs indefinitely. Measured when
    // this test was written: `--unset` was absent from the command
    // argument-hint and the Codex skill (cross-host review, MINOR), and
    // `--model-effort-fallback` had been absent from all three since it shipped.
    //
    // The Codex SKILL is the load-bearing one: a Codex operator reads the skill's
    // invocation line, so a flag documented only in the Claude-oriented prose is
    // a host-parity gap, not a typo.
    const { CONFIG_KEYS } = await import('../../plugins/runtime/scripts/lib/runtime-config.mjs');
    const flags = [...CONFIG_KEYS.map((key) => `--${key.replace(/_/g, '-')}`), '--unset'];
    const surfaces = {
      'commands/settings.md': 'plugins/runtime/commands/settings.md',
      'skills/settings/SKILL.md': 'plugins/runtime/skills/settings/SKILL.md',
      'scripts/settings.mjs usage()': 'plugins/runtime/scripts/settings.mjs',
    };
    for (const [label, path] of Object.entries(surfaces)) {
      const text = await readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
      const missing = flags.filter((flag) => !text.includes(flag));
      deepStrictEqual(missing, [], `${label} does not advertise: ${missing.join(', ')}`);
    }
    // Non-vacuous: the sweep must actually have a population to check.
    ok(flags.length >= 12, `the flag set is real (${flags.length} flags)`);
  });

  it('removeRuntimeConfigKeys deletes EVERY assignment line and reports the count', () => {
    // Every line, not the first: the read parser is last-value-wins, so a
    // surviving duplicate would resurrect the key the operator just removed —
    // the same reasoning the upsert gives, in the direction that loses data.
    const { text, removed } = removeRuntimeConfigKeys(
      '# header\nnotify_kinds = "approval"\nmodel = "keep"\nnotify_kinds = "idle"\n',
      ['notify_kinds'],
    );
    strictEqual(removed, 2, 'both duplicates went');
    ok(!text.includes('notify_kinds'), 'no assignment survives');
    ok(text.includes('model = "keep"'), 'unrelated keys are preserved byte-for-byte');
    ok(text.includes('# header'), 'and so is prose this writer did not author');
  });

  it('removeRuntimeConfigKeys deletes ONLY what the reader reads — table scope, byte preservation, key aliases', () => {
    // The writer must match `parseRuntimeConfigToml` exactly, and the asymmetry
    // is why: a reader that misses a line mis-reports, a writer that matches a
    // line the reader ignores DESTROYS data the runtime never owned. All four
    // shapes below were reproduced as data loss against the private line regex
    // this replaces (both review lanes; the table case was found first).
    const table = removeRuntimeConfigKeys(
      'notify_kinds = "approval"\nmodel = "keep"\n\n[foo]\nnotify_kinds = "someone-elses"\nother = "keep"\n',
      ['notify_kinds'],
    );
    strictEqual(table.removed, 1, 'the key under [foo] is NOT a runtime key — the reader stops at the first table header');
    ok(table.text.includes('notify_kinds = "someone-elses"'), 'so the foreign table keeps its line');
    ok(table.text.includes('other = "keep"'));

    const crlf = removeRuntimeConfigKeys('notify_kinds = "a"\r\nmodel = "keep"\r\n', ['notify_kinds']);
    strictEqual(crlf.text, 'model = "keep"\r\n', 'CRLF endings survive — the writer no longer re-synthesizes terminators');

    const noTrailing = removeRuntimeConfigKeys('model = "keep"\nnotify_kinds = "a"', ['notify_kinds']);
    strictEqual(noTrailing.text, 'model = "keep"\n', 'and a missing final newline is not invented back');

    // `normalizeConfigKey` maps `.` and `-` to `_`, so the READER genuinely takes
    // these as notify_kinds — removing them is the writer agreeing with it.
    const aliases = removeRuntimeConfigKeys('notify.kinds = "a"\nnotify-kinds = "b"\nmodel = "keep"\n', ['notify_kinds']);
    strictEqual(aliases.removed, 2, 'dotted and dashed spellings ARE the same key to the reader');

    // A quoted key is NOT accepted by the reader's key regex, so it is not a
    // runtime key and must survive.
    const quoted = removeRuntimeConfigKeys('"notify_kinds" = "x"\nmodel = "keep"\n', ['notify_kinds']);
    strictEqual(quoted.removed, 0, 'a quoted key the reader ignores is not the writer\'s to delete');
  });

  it('--apply writes ATOMICALLY and DISCLOSES a symlinked target', async () => {
    // A symlinked config is a legitimate dotfiles layout and is followed
    // deliberately — but the write then lands somewhere `mutation_boundary`
    // never named (cross-host review, MAJOR). The symlink itself must survive:
    // rename goes to the RESOLVED target, never over the link.
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-symlink-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-symlink-home-'));
    const external = await mkdtemp(join(tmpdir(), 'runtime-settings-symlink-ext-'));
    await seedRepo(root);
    await mkdir(join(home, '.agentic-plugins'), { recursive: true });
    const realTarget = join(external, 'real.toml');
    await writeFile(realTarget, 'notify_kinds = "approval"\nmodel = "keep"\n');
    await symlink(realTarget, join(home, '.agentic-plugins', 'config.toml'));

    const report = await runSettings({ repoRoot: root, homeDir: home, skipHostCliProbes: true, target: 'user', unset: ['notify_kinds'], apply: true });
    const plan = report.config.targets.find((t) => t.kind === 'user');
    strictEqual(plan.applied, true);
    ok(plan.resolved_path, 'the plan records where the bytes actually went');
    ok(report.mutation_boundary.allowed_paths.includes(plan.resolved_path), 'and the boundary names it too');
    ok((await lstat(join(home, '.agentic-plugins', 'config.toml'))).isSymbolicLink(), 'the symlink is followed, never replaced');
    ok(!(await readFile(realTarget, 'utf8')).includes('notify_kinds'), 'and the write landed through it');
    // No staging litter left behind.
    const leftovers = (await readdir(external)).filter((name) => name.includes('agentic-tmp'));
    deepStrictEqual(leftovers, [], 'the temp file is published or removed, never abandoned');
  });

  it('removeRuntimeConfigKeys on an absent key is a no-op that says so', () => {
    const { text, removed } = removeRuntimeConfigKeys('model = "keep"\n', ['notify_kinds']);
    strictEqual(removed, 0, '"removed 0" and "removed 3 duplicates" are different facts');
    strictEqual(text, 'model = "keep"\n');
  });

  it('--unset plans a remove op, applies it, and distinguishes absent from present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-unset-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-unset-home-'));
    await seedRepo(root);
    await mkdir(join(home, '.agentic-plugins'), { recursive: true });
    const userConfig = join(home, '.agentic-plugins', 'config.toml');
    await writeFile(userConfig, 'notify_kinds = "approval"\nmodel = "keep"\n');

    const planned = await runSettings({ repoRoot: root, homeDir: home, skipHostCliProbes: true, target: 'user', unset: ['notify_kinds'] });
    const userPlan = planned.config.targets.find((t) => t.kind === 'user');
    deepStrictEqual(userPlan.planned_writes, [{ op: 'remove', key: 'notify_kinds', before: 'approval', after: null }]);
    strictEqual(userPlan.applied, false, 'a dry run applies nothing');
    strictEqual(await readFile(userConfig, 'utf8'), 'notify_kinds = "approval"\nmodel = "keep"\n', 'and writes nothing');
    ok(!Object.hasOwn(userPlan.projected_config, 'notify_kinds'), 'the projection shows the key GONE, not blanked');

    const applied = await runSettings({ repoRoot: root, homeDir: home, skipHostCliProbes: true, target: 'user', unset: ['notify_kinds'], apply: true });
    const appliedPlan = applied.config.targets.find((t) => t.kind === 'user');
    strictEqual(appliedPlan.applied, true);
    const after = await readFile(userConfig, 'utf8');
    ok(!after.includes('notify_kinds'), 'the key is removed from the file');
    ok(after.includes('model = "keep"'));

    // A second apply is a no-op the plan reports as `keep`, not `remove`.
    const again = await runSettings({ repoRoot: root, homeDir: home, skipHostCliProbes: true, target: 'user', unset: ['notify_kinds'] });
    deepStrictEqual(again.config.targets.find((t) => t.kind === 'user').planned_writes, [], 'an already-absent key stages no write');
  });

  it('--unset is NOT user-scope-filtered — removal can never activate a session-shaping key', async () => {
    // ADR-0045 §7 forbids a tracked repo value from ACTIVATING entry_brief.
    // Refusing to REMOVE one would leave the exact byte the ADR exists to
    // prevent sitting in the repo file with no tool able to take it out.
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-unset-repo2-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-unset-home2-'));
    await seedRepo(root);
    await mkdir(join(root, '.agentic-plugins'), { recursive: true });
    const repoConfig = join(root, '.agentic-plugins', 'config.toml');
    await writeFile(repoConfig, 'entry_brief = "startup"\n');

    // The WRITE direction is still refused for the same key, in the same call.
    const writeAttempt = await runSettings({ repoRoot: root, homeDir: home, skipHostCliProbes: true, target: 'repo', desired: { entry_brief: 'startup' } });
    const repoWritePlan = writeAttempt.config.targets.find((t) => t.kind === 'repo');
    deepStrictEqual(repoWritePlan.refused_user_scope_only, ['entry_brief'], 'CONTROL: activation stays refused repo-side');
    deepStrictEqual(repoWritePlan.planned_writes, [], 'and stages nothing');

    const removal = await runSettings({ repoRoot: root, homeDir: home, skipHostCliProbes: true, target: 'repo', unset: ['entry_brief'], apply: true });
    strictEqual(removal.config.targets.find((t) => t.kind === 'repo').applied, true);
    ok(!(await readFile(repoConfig, 'utf8')).includes('entry_brief'), 'deactivation is allowed where activation is not');
  });

  it('a key cannot be written and removed in one invocation, on either surface', async () => {
    // Letting one win would make the outcome depend on which stage ran last.
    rejects(async () => parseArgs(['--notify-kinds', 'approval', '--unset', 'notify_kinds']), /never both in one invocation/);
    await rejects(
      runSettings({ repoRoot: '.', homeDir: '.', skipHostCliProbes: true, desired: { notify_kinds: 'approval' }, unset: ['notify_kinds'] }),
      /never both in one invocation/,
    );
  });

  it('--unset refuses a key that is not a runtime config key, on either surface', async () => {
    rejects(async () => parseArgs(['--unset', 'not_a_key']), /is not a runtime config key/);
    await rejects(
      runSettings({ repoRoot: '.', homeDir: '.', skipHostCliProbes: true, unset: ['not_a_key'] }),
      /is not a runtime config key/,
    );
  });

  it('rewrites EVERY duplicate line of a desired key (read parser is last-value-wins)', () => {
    // Leaving a later duplicate stale would make apply report an update the
    // last-value-wins read parser (and the notify emitter) never sees.
    const next = upsertRuntimeConfigToml(
      'notify_channel = "none"\nother = "keep"\nnotify_channel = "file-log"\n',
      { notify_channel: 'macos-osascript' },
    );
    strictEqual((next.match(/notify_channel = "macos-osascript"/g) ?? []).length, 2);
    ok(!next.includes('"none"'));
    ok(!next.includes('"file-log"'));
    ok(next.includes('other = "keep"'));
  });

});

describe('settings: notify config keys (ADR-0040 §2)', () => {
  it('plans notify_* config writes with effective projection, shipped defaults, and a text section', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-notify-plan-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-notify-plan-home-'));
    await seedRepo(root);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      desired: {
        notify_channel: 'macos-osascript',
        notify_dedupe_ttl_seconds: '600',
        notify_kinds: 'approval,peer-run-terminal',
      },
      runner: fakeRunner(defaultCliMap()),
    });

    strictEqual(report.dry_run, true);
    const repoTarget = report.config.targets.find((target) => target.kind === 'repo');
    ok(repoTarget.planned_writes.some((write) => write.key === 'notify_channel' && write.op === 'add' && write.after === 'macos-osascript'));
    ok(repoTarget.planned_writes.some((write) => write.key === 'notify_dedupe_ttl_seconds' && write.after === '600'));
    ok(repoTarget.planned_writes.some((write) => write.key === 'notify_kinds' && write.after === 'approval,peer-run-terminal'));

    const notify = report.notify_settings;
    strictEqual(notify.effective_mode, 'projected');
    deepStrictEqual(notify.config_keys, [
      'notify_channel',
      'notify_quiet_hours',
      'notify_quiet_hours_tz',
      'notify_dedupe_ttl_seconds',
      'notify_urgent_bypass_quiet_hours',
      'notify_kinds',
    ]);
    strictEqual(notify.keys.notify_channel.value, 'macos-osascript');
    strictEqual(notify.keys.notify_channel.effective_value, 'macos-osascript');
    strictEqual(notify.keys.notify_channel.source, 'repo config notify_channel');
    strictEqual(notify.keys.notify_channel.status, 'effective');
    strictEqual(notify.keys.notify_channel.default, 'none');
    strictEqual(notify.keys.notify_urgent_bypass_quiet_hours.value, null);
    strictEqual(notify.keys.notify_urgent_bypass_quiet_hours.effective_value, 'true');
    strictEqual(notify.keys.notify_urgent_bypass_quiet_hours.default, 'true');
    strictEqual(notify.keys.notify_urgent_bypass_quiet_hours.status, 'unchanged');
    strictEqual(notify.keys.notify_urgent_bypass_quiet_hours.source, 'shipped default');
    strictEqual(notify.keys.notify_dedupe_ttl_seconds.effective_value, '600');
    strictEqual(notify.keys.notify_quiet_hours.default, null);
    strictEqual(notify.keys.notify_quiet_hours.effective_value, null);
    deepStrictEqual(notify.warnings, []);
    strictEqual(report.overall.notify_warnings, 0);

    const text = formatText(report);
    ok(text.includes('Notify (ADR-0040'));
    ok(text.includes('notify_channel: macos-osascript (repo config notify_channel)'));
    ok(text.includes('notify_urgent_bypass_quiet_hours'));
  });

  it('reads existing notify keys from config.toml as current state and keeps unchanged values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-notify-current-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-notify-current-home-'));
    await seedRepo(root);
    await mkdir(join(root, '.agentic-plugins'), { recursive: true });
    await writeFile(join(root, '.agentic-plugins', 'config.toml'), 'notify_channel = "file-log"\nunknown_key = "still-dropped"\n');

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      desired: { notify_channel: 'file-log' },
      runner: fakeRunner(defaultCliMap()),
    });

    const repoTarget = report.config.targets.find((target) => target.kind === 'repo');
    deepStrictEqual(repoTarget.current_keys, ['notify_channel']);
    strictEqual(repoTarget.planned_writes.length, 0);
    ok(repoTarget.unchanged.some((action) => action.key === 'notify_channel' && action.op === 'keep'));
    strictEqual(report.notify_settings.keys.notify_channel.current_value, 'file-log');
  });

  // ADR-0044 §3 — the session family rides the same generic family-plan core
  // as notify: projection, shadow warnings, per-target validation, defaults.
  it('plans the session_capture key with the shipped default off and renders the section', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-session-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-session-home-'));
    await seedRepo(root);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      desired: { session_capture: 'stop-hook' },
      runner: fakeRunner(defaultCliMap()),
    });

    strictEqual(report.dry_run, true);
    const repoTarget = report.config.targets.find((target) => target.kind === 'repo');
    ok(repoTarget.planned_writes.some((write) => write.key === 'session_capture' && write.op === 'add' && write.after === 'stop-hook'));

    const session = report.session_settings;
    deepStrictEqual(session.config_keys, ['session_capture', 'entry_brief', 'entry_brief_empty']);
    strictEqual(session.effective_mode, 'projected');
    strictEqual(session.keys.session_capture.value, 'stop-hook');
    strictEqual(session.keys.session_capture.status, 'effective');
    strictEqual(session.keys.session_capture.default, 'off');
    deepStrictEqual(session.warnings, []);
    strictEqual(report.section_presence.session_settings, 'evaluated');

    const text = formatText(report);
    ok(text.includes('Session capture (ADR-0044'));
    ok(text.includes('session_capture: stop-hook (repo config session_capture)'));

    // Default projection when nothing is requested: the shipped default off.
    const defaulted = await runSettings({ repoRoot: root, homeDir: home, runner: fakeRunner(defaultCliMap()) });
    strictEqual(defaulted.session_settings.keys.session_capture.value, null);
    strictEqual(defaulted.session_settings.keys.session_capture.effective_value, 'off');
    strictEqual(defaulted.session_settings.keys.session_capture.source, 'shipped default');
  });

  // ADR-0045 §7 — the user-scope-only pair lands atomically with its
  // registration: repo-write prevention is structural (stripped before the
  // repo plan), and a tracked repo value is reported as ignored, never
  // shadowing.
  it('refuses to plan the user-scope-only entry-brief keys repo-side and routes them to the user target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-entrybrief-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-entrybrief-home-'));
    await seedRepo(root);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      desired: { entry_brief: 'startup', entry_brief_empty: 'report' },
      runner: fakeRunner(defaultCliMap()),
    });
    const repoTarget = report.config.targets.find((target) => target.kind === 'repo');
    const userTarget = report.config.targets.find((target) => target.kind === 'user');
    // Control first: the USER target does plan both writes — proving the keys
    // flowed through planning and only the repo strip removed them there.
    ok(userTarget.planned_writes.some((write) => write.key === 'entry_brief' && write.after === 'startup'));
    ok(userTarget.planned_writes.some((write) => write.key === 'entry_brief_empty' && write.after === 'report'));
    deepStrictEqual(userTarget.refused_user_scope_only, []);
    deepStrictEqual(repoTarget.refused_user_scope_only, ['entry_brief', 'entry_brief_empty']);
    ok(!repoTarget.planned_writes.some((write) => write.key === 'entry_brief' || write.key === 'entry_brief_empty'),
      'repo target never stages a user-scope-only key');
    ok(/user-scope-only/i.test(repoTarget.message), 'repo plan names the refusal');

    const session = report.session_settings;
    strictEqual(session.keys.entry_brief.user_scope_only, true);
    strictEqual(session.keys.entry_brief.env_override, 'AGENTIC_ENTRY_BRIEF');
    strictEqual(session.keys.entry_brief_empty.env_override, 'AGENTIC_ENTRY_BRIEF_EMPTY');
    strictEqual(session.keys.session_capture.user_scope_only, false);
    strictEqual(session.keys.session_capture.env_override, null);
    deepStrictEqual(session.user_scope_only_keys, ['entry_brief', 'entry_brief_empty']);
    ok(Array.isArray(session.user_scope_resolution_order), 'user-scope resolution order is stated');
  });

  it('apply with --target repo keeps the repo file byte-identical when only user-scope-only keys are requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-entrybrief-apply-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-entrybrief-apply-home-'));
    await seedRepo(root);
    await mkdir(join(root, '.agentic-plugins'), { recursive: true });
    const repoConfigPath = join(root, '.agentic-plugins', 'config.toml');
    const before = 'model = "opus"\n';
    await writeFile(repoConfigPath, before);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      target: 'repo',
      apply: true,
      desired: { entry_brief: 'startup' },
      runner: fakeRunner(defaultCliMap()),
    });
    const repoTarget = report.config.targets.find((target) => target.kind === 'repo');
    deepStrictEqual(repoTarget.refused_user_scope_only, ['entry_brief']);
    deepStrictEqual(repoTarget.planned_writes, []);
    strictEqual(repoTarget.applied, false, 'nothing to apply repo-side');
    const after = await readFile(repoConfigPath, 'utf-8');
    strictEqual(after, before, 'the repo config file is byte-identical');
  });

  it('a user config path aliasing the repo file is refused the user-scope-only keys too', async () => {
    // repoRoot === homeDir: the "user" file IS the repo-trackable file
    // (codex review MAJOR, reproduced) — both targets must strip the keys.
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-entrybrief-alias-'));
    await seedRepo(root);
    await mkdir(join(root, '.agentic-plugins'), { recursive: true });
    const configPath = join(root, '.agentic-plugins', 'config.toml');
    const before = 'model = "opus"\n';
    await writeFile(configPath, before);

    const report = await runSettings({
      repoRoot: root,
      homeDir: root,
      apply: true,
      desired: { entry_brief: 'startup', entry_brief_empty: 'report' },
      runner: fakeRunner(defaultCliMap()),
    });
    for (const target of report.config.targets) {
      deepStrictEqual(target.refused_user_scope_only, ['entry_brief', 'entry_brief_empty'], `${target.kind} refuses under aliasing`);
      ok(!target.planned_writes.some((write) => write.key === 'entry_brief' || write.key === 'entry_brief_empty'));
    }
    const after = await readFile(configPath, 'utf-8');
    strictEqual(after, before, 'the aliased file is byte-identical');
  });

  it('surfaces the observed loader-effective value when an env override is active', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-entrybrief-env-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-entrybrief-env-home-'));
    await seedRepo(root);
    await mkdir(join(home, '.agentic-plugins'), { recursive: true });
    await writeFile(join(home, '.agentic-plugins', 'config.toml'), 'entry_brief = "off"\n');

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      env: { ...process.env, AGENTIC_ENTRY_BRIEF: 'startup' },
      runner: fakeRunner(defaultCliMap()),
    });
    const entry = report.session_settings.keys.entry_brief;
    strictEqual(entry.observed_effective_value, 'startup', 'the loader-observed winner is surfaced');
    strictEqual(entry.observed_source, 'env AGENTIC_ENTRY_BRIEF');
    const text = formatText(report);
    ok(text.includes('observed effective (loader): startup (env AGENTIC_ENTRY_BRIEF)'), 'text names the env winner');
  });

  it('reports a tracked repo entry_brief value as ignored (user-scope-only), never shadowing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-entrybrief-ignored-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-entrybrief-ignored-home-'));
    await seedRepo(root);
    await mkdir(join(root, '.agentic-plugins'), { recursive: true });
    await writeFile(join(root, '.agentic-plugins', 'config.toml'), 'entry_brief = "startup"\n');

    const report = await runSettings({ repoRoot: root, homeDir: home, runner: fakeRunner(defaultCliMap()) });
    const session = report.session_settings;
    strictEqual(session.keys.entry_brief.value, null, 'a repo value is never effective for a user-scope-only key');
    strictEqual(session.keys.entry_brief.effective_value, 'off');
    ok(
      session.warnings.some((warning) => /entry_brief/.test(warning) && /ignored/.test(warning) && /user-scope-only/.test(warning)),
      `expected an ignored-repo-value warning, got: ${JSON.stringify(session.warnings)}`,
    );
  });

  it('surfaces an invalid stored session_capture value as a fail-closed warning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-session-bad-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-session-bad-home-'));
    await seedRepo(root);
    await mkdir(join(root, '.agentic-plugins'), { recursive: true });
    await writeFile(join(root, '.agentic-plugins', 'config.toml'), 'session_capture = "always"\n');

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner(defaultCliMap()),
    });
    ok(
      report.session_settings.warnings.some((w) => /session_capture/.test(w) && /session-capture publisher will fail closed/.test(w)),
      `expected a publisher fail-closed warning, got: ${JSON.stringify(report.session_settings.warnings)}`,
    );
    strictEqual(report.overall.session_warnings, 1, 'session warnings carry their own overall counter');
    strictEqual(report.overall.status, 'warning', 'a session warning degrades overall status');
  });

  // ADR-0044 S4 (session-capture-contract.md §13): the readiness section —
  // off stays informational; a half-enabled chain warns, recommends, renders.
  it('reports session-capture readiness: off is informational, a gate-on half-enabled chain warns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-readiness-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-readiness-home-'));
    await seedRepo(root);

    // Control: shipped default off — evaluated, zero warnings, no states.
    const offReport = await runSettings({ repoRoot: root, homeDir: home, runner: fakeRunner(defaultCliMap()) });
    strictEqual(offReport.session_readiness.status, 'off');
    deepStrictEqual(offReport.session_readiness.states, []);
    strictEqual(offReport.section_presence.session_readiness, 'evaluated');
    strictEqual(offReport.overall.session_readiness_warnings, 0);
    ok(formatText(offReport).includes('Session capture readiness (session-capture-contract.md §13, observed-current, off)'));

    // Gate on with no attention install anywhere in this home: blocked,
    // counted in overall, surfaced in recommendations, rendered in text.
    await mkdir(join(root, '.agentic-plugins'), { recursive: true });
    await writeFile(join(root, '.agentic-plugins', 'config.toml'), 'session_capture = "stop-hook"\n');
    const blocked = await runSettings({ repoRoot: root, homeDir: home, runner: fakeRunner(defaultCliMap()) });
    strictEqual(blocked.session_readiness.status, 'blocked');
    deepStrictEqual(blocked.session_readiness.states, ['attention-missing']);
    strictEqual(blocked.overall.session_readiness_warnings, 1);
    strictEqual(blocked.overall.status, 'warning', 'a half-enabled chain degrades overall status');
    ok(
      blocked.recommendations.some((rec) => rec.area === 'session-capture' && rec.state === 'attention-missing' && rec.next_step),
      `expected a session-capture recommendation, got: ${JSON.stringify(blocked.recommendations)}`,
    );
    const text = formatText(blocked);
    ok(text.includes('Session capture readiness (session-capture-contract.md §13, observed-current, blocked)'));
    ok(text.includes('attention-missing'));
  });

  it('evaluates session-capture readiness in local_plan scope with honestly-unverified enablement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-readiness-local-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-readiness-local-home-'));
    await seedRepo(root);
    await mkdir(join(root, '.agentic-plugins'), { recursive: true });
    await writeFile(join(root, '.agentic-plugins', 'config.toml'), 'session_capture = "stop-hook"\n');
    // A ready chain: installed attention declaring a satisfied publisher floor.
    const attentionRoot = join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'attention', '0.5.0');
    await mkdir(join(attentionRoot, '.claude-plugin'), { recursive: true });
    await writeFile(join(attentionRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'attention', version: '0.5.0' }));
    await mkdir(join(attentionRoot, 'data'), { recursive: true });
    await writeFile(
      join(attentionRoot, 'data', 'runtime-floors.json'),
      JSON.stringify({ schema: 'attention-runtime-floors-1.0', floors: { publish_session: '0.1.0' } }),
    );

    const narrowed = await runSettings({ repoRoot: root, homeDir: home, skipHostCliProbes: true, runner: fakeRunner(defaultCliMap()) });
    strictEqual(narrowed.report_scope, 'local_plan');
    strictEqual(narrowed.section_presence.session_readiness, 'evaluated', 'filesystem+env assessment runs in local_plan too');
    strictEqual(narrowed.session_readiness.status, 'ready');
    strictEqual(narrowed.session_readiness.attention.enablement, 'unverified', 'no host-CLI probe means enablement is never guessed');
    strictEqual(narrowed.session_readiness.publisher_floor.satisfied, true);
    strictEqual(narrowed.overall.session_readiness_warnings, 0, 'evaluated counter stays numeric in local_plan');
  });

  // ADR-0045 S8 (session-capture-contract.md §18): the entry-side mirror —
  // off informational; the user-scope-only gate on with a half-enabled hook
  // chain warns; a tracked repo value never activates.
  it('reports entry-brief readiness: off informational, user-scope gate-on chain warns, repo value ignored', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-entry-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-entry-home-'));
    await seedRepo(root);

    // Control: shipped default off — evaluated, zero warnings.
    const offReport = await runSettings({ repoRoot: root, homeDir: home, runner: fakeRunner(defaultCliMap()) });
    strictEqual(offReport.entry_readiness.status, 'off');
    deepStrictEqual(offReport.entry_readiness.states, []);
    strictEqual(offReport.section_presence.entry_readiness, 'evaluated');
    strictEqual(offReport.overall.entry_readiness_warnings, 0);
    ok(formatText(offReport).includes('Entry brief readiness (session-capture-contract.md §18, observed-current, off)'));

    // A tracked REPO value never activates (user-scope-only key): still off,
    // reported as ignored — and no warning.
    await mkdir(join(root, '.agentic-plugins'), { recursive: true });
    await writeFile(join(root, '.agentic-plugins', 'config.toml'), 'entry_brief = "startup"\n');
    const repoAttempt = await runSettings({ repoRoot: root, homeDir: home, runner: fakeRunner(defaultCliMap()) });
    strictEqual(repoAttempt.entry_readiness.status, 'off');
    deepStrictEqual(repoAttempt.entry_readiness.gate.ignored_repo_keys, ['entry_brief']);
    strictEqual(repoAttempt.overall.entry_readiness_warnings, 0);

    // USER-scope gate on with no attention install: blocked, counted,
    // recommended, rendered.
    await mkdir(join(home, '.agentic-plugins'), { recursive: true });
    await writeFile(join(home, '.agentic-plugins', 'config.toml'), 'entry_brief = "startup"\n');
    const blocked = await runSettings({ repoRoot: root, homeDir: home, runner: fakeRunner(defaultCliMap()) });
    strictEqual(blocked.entry_readiness.status, 'blocked');
    deepStrictEqual(blocked.entry_readiness.states, ['attention-missing']);
    strictEqual(blocked.overall.entry_readiness_warnings, 1);
    strictEqual(blocked.overall.status, 'warning', 'a half-enabled entry chain degrades overall status');
    ok(
      blocked.recommendations.some((rec) => rec.area === 'entry-brief' && rec.state === 'attention-missing' && rec.next_step),
      `expected an entry-brief recommendation, got: ${JSON.stringify(blocked.recommendations)}`,
    );
    const text = formatText(blocked);
    ok(text.includes('Entry brief readiness (session-capture-contract.md §18, observed-current, blocked)'));
  });

  it('evaluates entry-brief readiness in local_plan scope, executor probe included', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-entry-local-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-entry-local-home-'));
    await seedRepo(root);
    await mkdir(join(home, '.agentic-plugins'), { recursive: true });
    await writeFile(join(home, '.agentic-plugins', 'config.toml'), 'entry_brief = "startup"\n');
    // Ready entry chain: attention declaring the additive entry_brief floor
    // plus a cached runtime build shipping the executor.
    const attentionRoot = join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'attention', '0.6.0');
    await mkdir(join(attentionRoot, '.claude-plugin'), { recursive: true });
    await writeFile(join(attentionRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'attention', version: '0.6.0' }));
    await mkdir(join(attentionRoot, 'data'), { recursive: true });
    await writeFile(
      join(attentionRoot, 'data', 'runtime-floors.json'),
      JSON.stringify({ schema: 'attention-runtime-floors-1.0', floors: { publish_session: '0.1.0', entry_brief: '0.1.0' } }),
    );
    const runtimeRoot = join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'runtime', '0.90.0');
    await mkdir(join(runtimeRoot, '.claude-plugin'), { recursive: true });
    await writeFile(join(runtimeRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'runtime', version: '0.90.0' }));
    await mkdir(join(runtimeRoot, 'scripts'), { recursive: true });
    await writeFile(join(runtimeRoot, 'scripts', 'context.mjs'), '// stub\n');

    const narrowed = await runSettings({ repoRoot: root, homeDir: home, skipHostCliProbes: true, runner: fakeRunner(defaultCliMap()) });
    strictEqual(narrowed.report_scope, 'local_plan');
    strictEqual(narrowed.section_presence.entry_readiness, 'evaluated', 'filesystem+env assessment runs in local_plan too');
    strictEqual(narrowed.entry_readiness.status, 'ready');
    strictEqual(narrowed.entry_readiness.entry_floor.satisfied, true);
    deepStrictEqual(narrowed.entry_readiness.entry_executor, { probed: true, present: true, runtime_version: '0.90.0' });
    strictEqual(narrowed.overall.entry_readiness_warnings, 0, 'evaluated counter stays numeric in local_plan');
  });

  it('a blocked entry chain degrades the local_plan overall too (review-peer mutation coverage)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-entry-local-blocked-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-entry-local-blocked-home-'));
    await seedRepo(root);
    await mkdir(join(home, '.agentic-plugins'), { recursive: true });
    await writeFile(join(home, '.agentic-plugins', 'config.toml'), 'entry_brief = "startup"\n');

    const narrowed = await runSettings({ repoRoot: root, homeDir: home, skipHostCliProbes: true, runner: fakeRunner(defaultCliMap()) });
    strictEqual(narrowed.report_scope, 'local_plan');
    strictEqual(narrowed.entry_readiness.status, 'blocked');
    deepStrictEqual(narrowed.entry_readiness.states, ['attention-missing']);
    strictEqual(narrowed.overall.entry_readiness_warnings, 1);
    strictEqual(narrowed.overall.status, 'warning', 'local_plan overall must degrade on a blocked entry chain');
    ok(
      narrowed.recommendations.some((rec) => rec.area === 'entry-brief' && rec.state === 'attention-missing'),
      'local_plan recommendations rebuild from evaluated inputs — the entry chain is one',
    );
    ok(formatText(narrowed).includes('Entry brief readiness (session-capture-contract.md §18, observed-current, blocked)'));
  });

  // S2 plan-verify fail-closed hardening: an unreadable (not absent) config
  // layer must plan nothing and refuse apply — never be rebuilt from an
  // empty base.
  it('refuses to plan or apply against an unreadable config target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-unreadable-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-unreadable-home-'));
    await seedRepo(root);
    await mkdir(join(root, '.agentic-plugins', 'config.toml'), { recursive: true }); // a DIRECTORY: present but unreadable (EISDIR)

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      desired: { session_capture: 'stop-hook' },
      apply: true,
      runner: fakeRunner(defaultCliMap()),
    });

    const repoTarget = report.config.targets.find((target) => target.kind === 'repo');
    strictEqual(repoTarget.status, 'unreadable');
    ok(/EISDIR/.test(repoTarget.read_error ?? ''), `read_error carries the code: ${repoTarget.read_error}`);
    deepStrictEqual(repoTarget.planned_writes, [], 'an unreadable target plans no writes');
    strictEqual(repoTarget.applied, false, 'apply is refused for the unreadable target');
    ok(/fail-closed/.test(repoTarget.message), repoTarget.message);
    const { stat: statDir } = await import('node:fs/promises');
    ok((await statDir(join(root, '.agentic-plugins', 'config.toml'))).isDirectory(), 'the unreadable path is preserved, not rebuilt');

    // The user target stays independently plannable and applies (absent →
    // plannable): the unreadable repo layer must not block the healthy layer.
    const userTarget = report.config.targets.find((target) => target.kind === 'user');
    strictEqual(userTarget.applied, true, 'absent user layer applies normally');
    strictEqual(userTarget.status, 'available');
    ok(userTarget.planned_writes.some((w) => w.key === 'session_capture'));
    const userToml = await readFile(join(home, '.agentic-plugins', 'config.toml'), 'utf8');
    ok(userToml.includes('session_capture = "stop-hook"'), 'the applied user layer carries the key');
  });

  it('rejects invalid notify values at parse/normalize time per key', () => {
    const cases = [
      [['--notify-channel', 'growl'], /notify_channel/],
      [['--notify-quiet-hours', '25:00-08:00'], /notify_quiet_hours/],
      [['--notify-quiet-hours', '2200-0800'], /notify_quiet_hours/],
      [['--notify-quiet-hours-tz', 'Not/AZone'], /notify_quiet_hours_tz/],
      [['--notify-dedupe-ttl-seconds', '0'], /notify_dedupe_ttl_seconds/],
      [['--notify-dedupe-ttl-seconds', 'abc'], /notify_dedupe_ttl_seconds/],
      [['--notify-urgent-bypass-quiet-hours', 'yes'], /notify_urgent_bypass_quiet_hours/],
      [['--notify-kinds', 'approval,bogus-kind'], /bogus-kind/],
      [['--session-capture', 'always'], /session_capture must be one of off, stop-hook/],
      [['--session-capture', 'on'], /session_capture/],
      [['--entry-brief', 'always'], /entry_brief must be one of off, startup/],
      [['--entry-brief-empty', 'loud'], /entry_brief_empty must be one of silent, report/],
    ];
    for (const [argv, expected] of cases) {
      throws(() => parseArgs(argv), expected, `expected parse rejection for ${argv.join(' ')}`);
    }
  });

  it('rejects invalid notify values on the programmatic path before any planning', async () => {
    await rejects(
      () => runSettings({
        repoRoot: '/nonexistent-root-never-read',
        desired: { notify_channel: 'growl' },
        runner: fakeRunner({}),
      }),
      /notify_channel must be one of none, macos-osascript, file-log/,
    );
  });

  it('accepts --notify-* flags via the generic config flag mapping alongside model/effort flags', () => {
    const opts = parseArgs([
      '--notify-channel', 'file-log',
      '--notify-quiet-hours', '22:00-08:00',
      '--notify-quiet-hours-tz', 'Asia/Seoul',
      '--notify-dedupe-ttl-seconds', '300',
      '--notify-urgent-bypass-quiet-hours', 'false',
      '--notify-kinds', 'approval',
      '--codex-model', 'still-works',
    ]);
    deepStrictEqual(opts.desired, {
      codex_model: 'still-works',
      notify_channel: 'file-log',
      notify_quiet_hours: '22:00-08:00',
      notify_quiet_hours_tz: 'Asia/Seoul',
      notify_dedupe_ttl_seconds: '300',
      notify_urgent_bypass_quiet_hours: 'false',
      notify_kinds: 'approval',
    });
  });

  it('applies notify config writes to the selected agentic-plugins-owned target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-notify-apply-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-notify-apply-home-'));
    await seedRepo(root);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      target: 'repo',
      apply: true,
      desired: { notify_channel: 'macos-osascript', notify_quiet_hours: '23:30-07:15' },
      runner: fakeRunner(defaultCliMap()),
    });

    strictEqual(report.config.targets.find((target) => target.kind === 'repo').applied, true);
    const repoConfig = await readFile(join(root, '.agentic-plugins', 'config.toml'), 'utf8');
    ok(repoConfig.includes('notify_channel = "macos-osascript"'));
    ok(repoConfig.includes('notify_quiet_hours = "23:30-07:15"'));
    strictEqual(report.notify_settings.effective_mode, 'applied');
    strictEqual(report.notify_settings.keys.notify_channel.value, 'macos-osascript');
  });

  it('warns when a requested notify key is shadowed by repo config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-notify-shadow-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-notify-shadow-home-'));
    await seedRepo(root);
    await mkdir(join(root, '.agentic-plugins'), { recursive: true });
    await writeFile(join(root, '.agentic-plugins', 'config.toml'), 'notify_channel = "none"\n');

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      target: 'user',
      desired: { notify_channel: 'file-log' },
      runner: fakeRunner(defaultCliMap()),
    });

    const entry = report.notify_settings.keys.notify_channel;
    strictEqual(entry.value, 'none');
    strictEqual(entry.status, 'shadowed');
    ok(entry.warning.includes('shadowed by repo config notify_channel'));
    strictEqual(report.overall.notify_warnings, 1);
    strictEqual(report.overall.status, 'warning');
    ok(report.recommendations.some((rec) => rec.area === 'config' && rec.detail.includes('shadowed')));
    ok(formatText(report).includes('warning: notify_channel'));
  });

  it('warns when an existing config value for a notify key is invalid without blocking the plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-notify-invalid-current-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-notify-invalid-current-home-'));
    await seedRepo(root);
    await mkdir(join(root, '.agentic-plugins'), { recursive: true });
    await writeFile(join(root, '.agentic-plugins', 'config.toml'), 'notify_channel = "growl"\n');

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner(defaultCliMap()),
    });

    const entry = report.notify_settings.keys.notify_channel;
    strictEqual(entry.value, 'growl');
    ok(entry.warning.includes('invalid'));
    strictEqual(report.overall.notify_warnings, 1);
    strictEqual(report.overall.status, 'warning');
  });

  it('warns about an invalid lower-precedence notify value shadowed by a valid repo value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-notify-invalid-lower-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-notify-invalid-lower-home-'));
    await seedRepo(root);
    await mkdir(join(root, '.agentic-plugins'), { recursive: true });
    await writeFile(join(root, '.agentic-plugins', 'config.toml'), 'notify_channel = "file-log"\n');
    await mkdir(join(home, '.agentic-plugins'), { recursive: true });
    await writeFile(join(home, '.agentic-plugins', 'config.toml'), 'notify_channel = "growl"\n');

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner(defaultCliMap()),
    });

    const entry = report.notify_settings.keys.notify_channel;
    strictEqual(entry.value, 'file-log');
    strictEqual(entry.effective_value, 'file-log');
    ok(entry.warning.includes('user config value "growl" is invalid'));
    strictEqual(report.overall.notify_warnings, 1);
  });

  it('locks the blank/raw notify_kinds contract: blank is dropped, raw CSV is stored as written', async () => {
    // Blank means "no filter" to the notify-schema lib; the settings differ
    // has no key-removal semantics, so a blank desired value is dropped (the
    // operator clears a filter by deleting the config line).
    const blank = parseArgs(['--notify-channel', 'none']);
    deepStrictEqual(blank.desired, { notify_channel: 'none' });
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-notify-kinds-raw-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-notify-kinds-raw-home-'));
    await seedRepo(root);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      desired: { notify_kinds: 'idle,,idle,', notify_quiet_hours: '' },
      runner: fakeRunner(defaultCliMap()),
    });

    const repoTarget = report.config.targets.find((target) => target.kind === 'repo');
    // Raw CSV is stored as written; the notify-schema lib normalizes at
    // evaluation time (dupes/empty tokens are its concern, not the differ's).
    ok(repoTarget.planned_writes.some((write) => write.key === 'notify_kinds' && write.after === 'idle,,idle,'));
    ok(!repoTarget.planned_writes.some((write) => write.key === 'notify_quiet_hours'), 'blank desired value is dropped, not planned');
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

// ADR-0034: a Codex 0.137 CLI map whose `codex plugin --help` exposes per-plugin
// add/list/remove so doctor probes `codex plugin list --json`. Supply the list
// result via `extra` to make install-state authoritative; without it the probe is
// absent and install-state degrades to the filesystem cache (decision 'fallback').
function codex0137Map(extra = {}) {
  return {
    ...defaultCliMap(),
    'codex --version': okResult('codex-cli 0.137.0\n'),
    'codex --help': okResult('Commands:\n  exec Run Codex non-interactively\n  login status\n  plugin  Manage Codex plugins\nOptions:\n  --model\n  --config\n  --cd\n  --sandbox\n  --ask-for-approval\n'),
    'codex plugin --help': okResult('Manage Codex plugins\n\nUsage: codex plugin <COMMAND>\n\nCommands:\n  add          Install a plugin from a configured marketplace snapshot\n  list         List plugins available from configured marketplace snapshots\n  marketplace  Add, list, upgrade, or remove configured plugin marketplaces\n  remove       Remove an installed plugin from local config and cache\n'),
    'codex plugin marketplace --help': okResult('Add, list, upgrade, or remove configured plugin marketplaces\n\nUsage: codex plugin marketplace <COMMAND>\n\nCommands:\n  add\n  list\n  upgrade\n  remove\n'),
    ...extra,
  };
}

function codexListJson(entries) {
  return okResult(JSON.stringify({ installed: entries }));
}

// `codex plugin list --available --json` shape: uninstalled marketplace plugins
// (with installPolicy/authPolicy) live under `available`.
function codexAvailableJson(entries) {
  return okResult(JSON.stringify({ installed: [], available: entries }));
}

// Sequence-aware runner: a map value may be an ARRAY of results returned in call
// order (last element repeats), so `codex plugin list --json` can read
// not-installed first (recommendation) then installed (post-verify).
function fakeRunnerSeq(map, calls = []) {
  const counts = {};
  return async (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    calls.push(key);
    const entry = map[key];
    if (Array.isArray(entry)) {
      const i = counts[key] ?? 0;
      counts[key] = i + 1;
      return entry[Math.min(i, entry.length - 1)] ?? enoent(command);
    }
    return entry ?? enoent(command);
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
          SessionStart: [{ matcher: 'compact', hooks: [{ type: 'command', command: PORTABLE_HOOK_COMMAND }] }],
          PreCompact: [{ hooks: [{ type: 'command', command: PORTABLE_HOOK_COMMAND }] }],
          Stop: [{ hooks: [{ type: 'command', command: PORTABLE_HOOK_COMMAND }] }],
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

// ONE base TOML builder for the Codex `[hooks.state]` fixture shape. The id format
// (`plugin@marketplace:path:event:group:hook`) is regression-critical — the S8a5
// false-pass pins depend on it matching what the machine-probe parser reads — so it
// is encoded here exactly once; the named builders below only vary the row body.
async function writeCodexHookStateConfig(home, hooksPath, { rowLines, extraLines = [] }) {
  await mkdir(join(home, '.codex'), { recursive: true });
  const lines = [
    '[features]',
    'plugin_hooks = true',
    '',
    '[hooks.state]',
    '',
  ];
  for (const plugin of ['engineer', 'orchestrator']) {
    for (const event of ['pre_compact', 'session_start', 'stop']) {
      lines.push(`[hooks.state."${plugin}@agentic-plugins:${hooksPath}:${event}:0:0"]`);
      lines.push(...rowLines);
      lines.push('');
    }
  }
  lines.push(...extraLines);
  await writeFile(join(home, '.codex', 'config.toml'), lines.join('\n'));
}

async function writeDisabledCodexHookStateConfig(home, hooksPath = 'hooks/hooks.json') {
  await writeCodexHookStateConfig(home, hooksPath, { rowLines: ['enabled = false', 'trusted_hash = "sha256:abc123"'] });
}

async function writeTrustedCodexHookStateConfig(home, hooksPath = 'hooks/hooks.json', { extraLines = [] } = {}) {
  await writeCodexHookStateConfig(home, hooksPath, { rowLines: ['trusted_hash = "sha256:abc123"'], extraLines });
}

// The S8a5 sibling-masked shape: every expected entry trusted+enabled, plus ONE extra
// handler row for engineer:stop (hook index 1) explicitly disabled. The group grain
// reads nothing disabled; only the per-handler grain sees it.
async function writeSiblingMaskedCodexHookStateConfig(home, hooksPath = 'hooks/hooks.json') {
  await writeTrustedCodexHookStateConfig(home, hooksPath, {
    extraLines: [
      `[hooks.state."engineer@agentic-plugins:${hooksPath}:stop:0:1"]`,
      'enabled = false',
      'trusted_hash = "sha256:sibling"',
      '',
    ],
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

// The per-plugin install cache doctor reads at
// ~/.codex/plugins/cache/agentic-plugins/<name>/<version>/.codex-plugin/plugin.json.
async function seedCodexInstallCache(home, name, version) {
  const dir = join(home, '.codex', 'plugins', 'cache', 'agentic-plugins', name, version, '.codex-plugin');
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, 'plugin.json'), { name, version, description: `${name} plugin` });
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
