import { describe, it } from 'node:test';
import { strictEqual, ok, rejects, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { evaluateCodexHookStateGate, formatText, parseArgs, projectCodexHookStateForProbe, runDoctor, RUNTIME_VERSION, PLUGIN_NAMES, resolveInstalledEngineerRoot } from '../../plugins/runtime/scripts/doctor.mjs';
import { recomputeHookAttestation } from '../../plugins/runtime/scripts/lib/completion-reducer.mjs';
import { makeDefValidator } from '../../plugins/runtime/scripts/lib/schema-validate.mjs';

const PORTABLE_HOOK_COMMAND = '/bin/sh "${PLUGIN_ROOT}/adapters/codex/hooks/run-node-hook.sh" "${PLUGIN_ROOT}/adapters/codex/hooks/hook.mjs"';

describe('runtime doctor', () => {
  // ADR-0041 §2b/§2c. This used to be every caller's job, and only settings.mjs did it,
  // so a direct `runtime:doctor` run and cutover-audit handed TELEGRAM_BOT_TOKEN to all
  // 14 `claude`/`codex` probe processes. The scrub now lives at the point of use.
  it('never hands the egress credential to a host-CLI probe', async () => {
    const seen = [];
    // A SUCCEEDING runner, so `available` is true and inspectCli walks the whole probe
    // chain (7 claude + 9 codex, incl. the §1.2 marketplace-registration read; the codex
    // marketplace text fallback does NOT run because the json probe succeeds here). An
    // ENOENT stub would short-circuit after `--version` and this gate would only ever
    // inspect 2 of the 16 envs.
    const runner = async (command, args = [], options = {}) => {
      seen.push({ command, args, env: options.env });
      return { ok: true, exit_code: 0, stdout: '', stderr: '', error_code: null, error_message: null };
    };
    await runDoctor({
      repoRoot: process.cwd(),
      format: 'json',
      runner,
      env: { ...process.env, TELEGRAM_BOT_TOKEN: 'sentinel-token', PATH: '/usr/bin:/bin' },
    });

    const claudeProbes = seen.filter((call) => call.command === 'claude');
    const codexProbes = seen.filter((call) => call.command === 'codex');
    strictEqual(claudeProbes.length, 7, 'every claude probe must be inspected, not just --version');
    strictEqual(codexProbes.length, 9, 'every codex probe must be inspected, not just --version');
    const probes = [...claudeProbes, ...codexProbes];
    for (const probe of probes) {
      strictEqual(probe.env?.TELEGRAM_BOT_TOKEN, undefined, `${probe.command} probe received the egress credential`);
      strictEqual(probe.env?.PATH, '/usr/bin:/bin', 'the rest of the env must survive the scrub');
    }
  });

  it('recognizes founder, attention and designer in the hardcoded plugin inventory (ADR-0036 / ADR-0040 §3 / ADR-0042 RT)', () => {
    // RT (ADR-0036): runtime:doctor / runtime:settings must recognize
    // founder as an installable agentic-plugins plugin — install / cache /
    // catalog inventory recognition. The founder workflow-ledger health
    // check and hook-readiness gating are deliberate non-goals here
    // (they would couple runtime to founder's state schema / hook exposure).
    // ADR-0040 §3: the hook-only attention plugin joins the same
    // install/cache/catalog inventory (readiness reporting only — its hook
    // semantics stay attention-owned).
    // RT (ADR-0042): designer joins on the same terms. Inventory recognition
    // ONLY — the dashboard Tier-1 persona set stays deliberately narrower
    // (ADR-0040 §6; ADR-0043 §3). The workflow_kind projection enum, once the
    // other deliberate non-extension here, was widened to all four personas
    // by ADR-0043 S2.
    deepStrictEqual(PLUGIN_NAMES, ['attention', 'companions', 'designer', 'engineer', 'founder', 'image', 'orchestrator', 'runtime']);
    // Alphabetical, so the inventory reads deterministically in every report.
    deepStrictEqual([...PLUGIN_NAMES], [...PLUGIN_NAMES].sort());
  });

  it('builds a sanitized read-only report from source, CLI, companion, config, and ledger probes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    await seedHome(home);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-05-13T00:00:00.000Z'),
      explicitModel: 'gpt-5.4',
      explicitEffort: 'high',
      runner: fakeRunner({
        'claude --version': okResult('2.1.140 (Claude Code)\n'),
        'claude --help': okResult('Usage: claude --print --output-format --no-session-persistence --model --effort --permission-mode --plugin-dir\nCommands:\n  auth status\n  plugin list\n'),
        'claude auth status': okResult(JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
          email: 'person@example.com',
          orgId: '11111111-2222-3333-4444-555555555555',
          orgName: 'private org',
          subscriptionType: 'max',
        })),
        'claude plugin --help': okResult('Commands:\n  install\n  list\n  update\n  uninstall\n'),
        'claude plugin list': okResult('Installed plugins:\n\n  > runtime@agentic-plugins\n    Version: 0.1.0\n    Scope: user\n    Status: enabled\n'),
        'claude /plugin list': okResult('Installed plugins:\n\n  > runtime@agentic-plugins\n    Version: 0.1.0\n    Scope: user\n    Status: enabled\n'),
        'codex --version': okResult('codex-cli 0.130.0\n'),
        'codex --help': okResult('Commands:\n  exec Run Codex non-interactively\n  login status\n  plugin marketplace\nOptions:\n  --model\n  --config\n  --cd\n  --sandbox\n  --ask-for-approval\n'),
        'codex exec --help': okResult('Usage: codex exec --cd <DIR> --model <MODEL> --config model_reasoning_effort=\"high\"\n'),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development false\nplugins stable true\nmulti_agent stable true\n'),
        'codex login status': okResult('Logged in using sk-proj-abcdefghijklmnopqrstuvwxyz1234567890\n'),
        'codex plugin marketplace --help': okResult('Commands:\n  add\n  upgrade\n  remove\n'),
      }),
    });

    strictEqual(report.read_only, true);
    strictEqual(report.runtime_version, RUNTIME_VERSION);
    strictEqual(report.clis.claude.auth.status, 'available');
    strictEqual(report.clis.claude.auth.method, 'claude.ai');
    strictEqual(report.clis.claude.auth.provider, 'firstParty');
    strictEqual(report.clis.claude.auth.subscription, 'max');
    strictEqual(report.clis.claude.plugin_surface.status, 'available');
    strictEqual(report.model_effort.directions.claude_to_codex.model.source, 'explicit command flags');
    strictEqual(report.model_effort.directions.codex_to_claude.effort.value, 'high');
    strictEqual(report.companions.directions.claude_to_codex.status, 'available');
    strictEqual(report.companions.directions.codex_to_claude.status, 'available');
    strictEqual(report.ledgers.engineer.peer_runs.stale_non_terminal, 1);
    strictEqual(report.ledgers.engineer.storage.status, 'migration_blocked');
    strictEqual(report.ledgers.engineer.storage.selected_home, 'legacy');
    strictEqual(report.ledgers.engineer.storage.legacy_has_state, true);
    strictEqual(report.ledgers.engineer.storage.canonical_has_state, false);
    strictEqual(report.ledgers.orchestrator.storage.status, 'empty');
    strictEqual(report.plugins.runtime.status, 'available');
    strictEqual(report.clis.codex.feature_surface.codex_global_hooks, true);
    strictEqual(report.clis.codex.feature_surface.codex_global_hooks_stage, 'stable');
    strictEqual(report.clis.codex.feature_surface.codex_plugin_hooks, false);
    strictEqual(report.clis.codex.feature_surface.codex_plugin_hooks_stage, 'under development');
    strictEqual(report.clis.codex.feature_surface.automatic_plugin_hooks, false);
    strictEqual(report.plugin_command_surface.schema_version, 'runtime-plugin-command-surface-1.4');
    strictEqual(report.plugin_command_surface.claude.mode, 'per-plugin-command');
    strictEqual(report.plugin_command_surface.claude.supports.update_plugin, true);
    strictEqual(report.plugin_command_surface.claude.supports.uninstall_plugin, true);
    strictEqual(report.plugin_command_surface.claude.materialization.status, 'host-native-plugin-command');
    strictEqual(report.plugin_command_surface.claude.observed_surfaces.cli_plugin, 'available');
    deepStrictEqual(report.plugin_command_surface.manual_followups, []);
    strictEqual(report.plugin_command_surface.codex.mode, 'marketplace-only');
    strictEqual(report.plugin_command_surface.codex.supports.marketplace_add, true);
    strictEqual(report.plugin_command_surface.codex.supports.marketplace_upgrade, true);
    strictEqual(report.plugin_command_surface.codex.supports.install_plugin, false);
    strictEqual(report.plugin_command_surface.codex.materialization.status, 'materialized');
    strictEqual(report.codex_plugin_hooks.status, 'feature_disabled');
    deepStrictEqual(report.codex_plugin_hooks.summary.bundled_plugins, ['engineer', 'orchestrator']);
    deepStrictEqual(report.codex_plugin_hooks.summary.manifest_exposed_plugins, ['engineer', 'orchestrator']);
    // ADR-0035 §6: the legacy-stage enable-codex-plugin-hooks recommendation is
    // removed (it fed the deleted settings write executor); the disabled gate is
    // still diagnosed read-only via the host-parity difference below.
    ok(!report.codex_plugin_hooks.recommendations.some((rec) => rec.action === 'enable-codex-plugin-hooks'));
    ok(report.host_parity.differences.some((issue) => issue.id === 'codex_plugin_hooks_feature_disabled'));
    ok(report.host_parity.differences.some((issue) => issue.id === 'codex_plugin_hooks_feature_disabled' && issue.evidence.includes('global_hooks=true/stable')));
    ok(report.host_parity.differences.some((issue) => issue.id === 'codex_plugin_hooks_feature_disabled' && issue.next_step.includes('manually')));
    strictEqual(report.readiness_matrix.schema_version, 'runtime-readiness-matrix-1.0');
    strictEqual(report.readiness_matrix.hosts.claude.available.status, 'available');
    strictEqual(report.readiness_matrix.hosts.claude.installed.status, 'installed');
    strictEqual(report.readiness_matrix.hosts.claude.installed.evidence, 'claude plugin list reports enabled');
    strictEqual(report.readiness_matrix.hosts.claude.authenticated.status, 'available');
    strictEqual(report.readiness_matrix.hosts.claude.model_when_peer.value, 'gpt-5.4');
    strictEqual(report.readiness_matrix.hosts.codex.available.status, 'available');
    strictEqual(report.readiness_matrix.hosts.codex.installed.status, 'installed');
    strictEqual(report.readiness_matrix.hosts.codex.installed.evidence, 'codex plugin cache contains runtime');
    strictEqual(report.readiness_matrix.hosts.codex.authenticated.status, 'available');
    strictEqual(report.readiness_matrix.hosts.codex.hooks.global_hooks, true);
    strictEqual(report.readiness_matrix.hosts.codex.hooks.plugin_local_hooks, false);
    strictEqual(report.readiness_matrix.hosts.codex.hooks.packaging_status, 'feature_disabled');
    strictEqual(report.readiness_matrix.directions.claude_to_codex.companion.status, 'available');
    strictEqual(report.readiness_matrix.directions.claude_to_codex.model.value, 'gpt-5.4');
    strictEqual(report.readiness_matrix.directions.codex_to_claude.effort.value, 'high');
    strictEqual(report.experience_parity.schema_version, 'runtime-experience-parity-1.0');
    strictEqual(report.experience_parity.status, 'blocked');
    ok(report.experience_parity.score_percent > 0);
    ok(report.experience_parity.criteria.some((item) => item.id === 'workflow_continuity_storage' && item.status === 'blocked'));
    ok(report.experience_parity.criteria.some((item) => item.id === 'bidirectional_companion_contract' && item.status === 'satisfied'));

    const serialized = JSON.stringify(report);
    ok(!serialized.includes('person@example.com'), 'email must be redacted');
    ok(!serialized.includes('11111111-2222-3333-4444-555555555555'), 'org id must be redacted');
    ok(!serialized.includes('sk-proj-abcdefghijklmnopqrstuvwxyz1234567890'), 'hyphenated provider token must be redacted');
    ok(formatText(report).includes(`runtime:doctor ${RUNTIME_VERSION}`));
    ok(formatText(report).includes('Readiness Matrix'));
    ok(formatText(report).includes('Experience Parity'));
    ok(formatText(report).includes('workflow_continuity_storage'));
    ok(formatText(report).includes('claude: available=available; installed=installed; authenticated=available'));
    ok(formatText(report).includes('codex: available=available; installed=installed; authenticated=available'));
    ok(formatText(report).includes('Plugin Command Surface'));
    ok(formatText(report).includes('Codex Plugin Hooks'));
    ok(formatText(report).includes('status=feature_disabled'));
    ok(formatText(report).includes('claude: mode=per-plugin-command'));
    ok(formatText(report).includes('codex: mode=marketplace-only'));
    ok(formatText(report).includes('Host Parity'));
    ok(formatText(report).includes('non-interactive hook trust query'));
  });

  it('recognizes the Codex per-plugin command surface on 0.137.0 (ADR-0032)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-perplugin-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-perplugin-home-'));
    await seedRepo(root);
    await seedHome(home);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-06-07T00:00:00.000Z'),
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'codex --version': okResult('codex-cli 0.137.0\n'),
        'codex --help': okResult('Commands:\n  exec Run Codex non-interactively\n  login status\n  plugin  Manage Codex plugins\nOptions:\n  --model\n  --config\n  --cd\n  --sandbox\n  --ask-for-approval\n'),
        'codex plugin --help': okResult('Manage Codex plugins\n\nUsage: codex plugin <COMMAND>\n\nCommands:\n  add          Install a plugin from a configured marketplace snapshot\n  list         List plugins available from configured marketplace snapshots\n  marketplace  Add, list, upgrade, or remove configured plugin marketplaces\n  remove       Remove an installed plugin from local config and cache\n'),
        'codex plugin marketplace --help': okResult('Add, list, upgrade, or remove configured plugin marketplaces\n\nUsage: codex plugin marketplace <COMMAND>\n\nCommands:\n  add\n  list\n  upgrade\n  remove\n'),
      }),
    });

    // Per-plugin surface is detected precisely from `codex plugin --help`, not the version.
    const featureSurface = report.clis.codex.feature_surface;
    strictEqual(featureSurface.plugin_install_command, true);
    strictEqual(featureSurface.plugin_list_command, true);
    strictEqual(featureSurface.plugin_remove_command, true);

    const codex = report.plugin_command_surface.codex;
    strictEqual(report.plugin_command_surface.schema_version, 'runtime-plugin-command-surface-1.4');
    strictEqual(codex.mode, 'per-plugin-and-marketplace');
    strictEqual(codex.supports.install_plugin, true);
    strictEqual(codex.supports.list_plugin, true);
    strictEqual(codex.supports.remove_plugin, true);
    strictEqual(codex.supports.update_plugin, false);
    strictEqual(codex.supports.marketplace_add, true);
    strictEqual(codex.supports.marketplace_list, true);
    ok(codex.limits.some((line) => line.includes('not full Claude plugin parity')));
    ok(codex.limits.some((line) => line.includes('does not auto-execute codex plugin add')));
    ok(codex.limits.some((line) => line.includes('per-plugin add/list/remove')));

    // Partial-parity info note replaces the marketplace-only warning on 0.137+.
    ok(report.host_parity.differences.some((d) => d.id === 'codex_plugin_command_partial_parity'));
    ok(!report.host_parity.differences.some((d) => d.id === 'codex_marketplace_command_shape'));

    const text = formatText(report);
    ok(text.includes('codex: mode=per-plugin-and-marketplace'));
    ok(text.includes('plugin-add=true'));
    ok(text.includes('plugin-remove=true'));
    ok(text.includes('marketplace-list=true'));
  });

  it('enumerates only the detected per-plugin verbs and does not overclaim (ADR-0032)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-perplugin-partial-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-perplugin-partial-home-'));
    await seedRepo(root);
    await seedHome(home);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-06-07T00:00:00.000Z'),
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'codex --version': okResult('codex-cli 0.137.0\n'),
        // Hypothetical host exposing only per-plugin `add` (install), without list/remove.
        'codex plugin --help': okResult('Manage Codex plugins\n\nUsage: codex plugin <COMMAND>\n\nCommands:\n  add          Install a plugin from a configured marketplace snapshot\n  marketplace  Add, list, upgrade, or remove configured plugin marketplaces\n'),
        'codex plugin marketplace --help': okResult('Add, list, upgrade, or remove configured plugin marketplaces\n\nUsage: codex plugin marketplace <COMMAND>\n\nCommands:\n  add\n  list\n  upgrade\n  remove\n'),
      }),
    });

    const codex = report.plugin_command_surface.codex;
    strictEqual(codex.mode, 'per-plugin-and-marketplace');
    strictEqual(codex.supports.install_plugin, true);
    strictEqual(codex.supports.list_plugin, false);
    strictEqual(codex.supports.remove_plugin, false);
    // Must enumerate only the detected verb ("add"), never claim the undetected list/remove.
    ok(codex.limits.some((line) => line.includes('per-plugin add plus marketplace')));
    ok(!codex.limits.some((line) => line.includes('per-plugin add/list/remove')));
    const partial = report.host_parity.differences.find((d) => d.id === 'codex_plugin_command_partial_parity');
    ok(partial);
    ok(partial.summary.includes('per-plugin add plus marketplace'));
    ok(!partial.summary.includes('add/list/remove'));
  });

  it('treats removed plugin_hooks as ready on the generic hooks gate (Codex >= ~0.134)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    await seedHome(home);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-06-03T00:00:00.000Z'),
      runner: fakeRunner({
        'claude --version': okResult('2.1.161 (Claude Code)\n'),
        'claude --help': okResult('Usage: claude --print --output-format --no-session-persistence --model --effort --permission-mode --plugin-dir\nCommands:\n  auth status\n  plugin list\n'),
        'claude auth status': okResult(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })),
        'claude plugin --help': okResult('Commands:\n  install\n  list\n  update\n  uninstall\n'),
        'claude plugin list': okResult('Installed plugins:\n\n  > runtime@agentic-plugins\n    Version: 0.1.0\n    Scope: user\n    Status: enabled\n'),
        'codex --version': okResult('codex-cli 0.136.0\n'),
        'codex --help': okResult('Commands:\n  exec Run Codex non-interactively\n  login status\n  plugin marketplace\nOptions:\n  --model\n  --config\n  --cd\n  --sandbox\n  --ask-for-approval\n'),
        'codex features list': okResult('hooks stable true\nplugin_hooks removed false\nplugins stable true\nmulti_agent stable true\n'),
        'codex plugin marketplace --help': okResult('Commands:\n  add\n  upgrade\n  remove\n'),
      }),
    });

    strictEqual(report.clis.codex.feature_surface.codex_plugin_hooks_stage, 'removed');
    strictEqual(report.clis.codex.feature_surface.codex_global_hooks, true);
    // plugin_hooks removed + generic hooks on => ready on the generic gate, no dead-flag advice.
    strictEqual(report.codex_plugin_hooks.status, 'ready');
    ok(!report.codex_plugin_hooks.recommendations.some((rec) => rec.action === 'enable-codex-plugin-hooks'));
    ok(!report.codex_plugin_hooks.recommendations.some((rec) => rec.action === 'enable-codex-hooks'));
    ok(!report.host_parity.differences.some((issue) => issue.id === 'codex_plugin_hooks_feature_disabled'));
    ok(!report.host_parity.differences.some((issue) => issue.id === 'codex_generic_hooks_disabled'));
    ok(formatText(report).includes('status=ready'));
    // ADR-0030 stage gate also applies to the Codex-caller direction readiness
    // warning: with plugin_hooks removed + generic hooks on, the readiness lane
    // must report the hooks-enabled (review/trust) message and MUST NOT tell the
    // operator to set the removed [features].plugin_hooks=true flag.
    const codexCallerWarnings = report.readiness.codex_to_claude.warnings;
    ok(codexCallerWarnings.some((w) => w.includes('Codex plugin hooks are enabled; bundled lifecycle hooks still require hook review/trust')),
      'codex-caller readiness reports the stage-aware hooks-enabled message');
    ok(!codexCallerWarnings.some((w) => w.includes('plugin_hooks=true')),
      'codex-caller readiness no longer advises the removed [features].plugin_hooks=true flag on current Codex');
  });

  it('recommends generic hooks (not plugin_hooks) when plugin_hooks is removed and generic hooks is off', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    await seedHome(home);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-06-03T00:00:00.000Z'),
      runner: fakeRunner({
        'claude --version': okResult('2.1.161 (Claude Code)\n'),
        'claude --help': okResult('Usage: claude --print --output-format --no-session-persistence --model --effort --permission-mode --plugin-dir\nCommands:\n  auth status\n  plugin list\n'),
        'claude auth status': okResult(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })),
        'claude plugin --help': okResult('Commands:\n  install\n  list\n  update\n  uninstall\n'),
        'claude plugin list': okResult('Installed plugins:\n\n  > runtime@agentic-plugins\n    Version: 0.1.0\n    Scope: user\n    Status: enabled\n'),
        'codex --version': okResult('codex-cli 0.136.0\n'),
        'codex --help': okResult('Commands:\n  exec Run Codex non-interactively\n  login status\n  plugin marketplace\nOptions:\n  --model\n  --config\n  --cd\n  --sandbox\n  --ask-for-approval\n'),
        'codex features list': okResult('hooks stable false\nplugin_hooks removed false\nplugins stable true\nmulti_agent stable true\n'),
        'codex plugin marketplace --help': okResult('Commands:\n  add\n  upgrade\n  remove\n'),
      }),
    });

    strictEqual(report.clis.codex.feature_surface.codex_plugin_hooks_stage, 'removed');
    strictEqual(report.clis.codex.feature_surface.codex_global_hooks, false);
    // plugin_hooks removed + generic hooks off => recommend enabling generic hooks, not the removed flag.
    strictEqual(report.codex_plugin_hooks.status, 'feature_disabled');
    ok(report.codex_plugin_hooks.recommendations.some((rec) => rec.action === 'enable-codex-hooks'));
    ok(!report.codex_plugin_hooks.recommendations.some((rec) => rec.action === 'enable-codex-plugin-hooks'));
    ok(report.host_parity.differences.some((issue) => issue.id === 'codex_generic_hooks_disabled'));
    ok(!report.host_parity.differences.some((issue) => issue.id === 'codex_plugin_hooks_feature_disabled'));
  });

  it('reports unavailable Claude slash plugin surface without blocking Claude plugin CLI management', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-claude-plugin-surface-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'claude /plugin list': okResult("/plugin isn't available in this environment.\n"),
      }),
    });

    strictEqual(report.clis.claude.plugin_surface.status, 'unavailable');
    strictEqual(report.clis.claude.plugin_surface.error_code, 'HOST_PLUGIN_SURFACE_UNAVAILABLE');
    strictEqual(report.plugin_command_surface.claude.status, 'available');
    strictEqual(report.plugin_command_surface.claude.mode, 'per-plugin-command');
    strictEqual(report.plugin_command_surface.claude.supports.install_plugin, true);
    strictEqual(report.plugin_command_surface.claude.supports.update_plugin, true);
    strictEqual(report.plugin_command_surface.claude.supports.uninstall_plugin, true);
    strictEqual(report.plugin_command_surface.claude.supports.list_plugin, true);
    strictEqual(report.plugin_command_surface.claude.observed_surfaces.slash_plugin, 'unavailable');
    strictEqual(report.plugin_command_surface.claude.materialization.status, 'host-native-plugin-command');
    strictEqual(report.plugin_command_surface.claude.materialization.executable_by_settings, true);
    deepStrictEqual(report.plugin_command_surface.manual_followups, []);
    ok(formatText(report).includes('claude: mode=per-plugin-command'));
    ok(formatText(report).includes('observed: cli-plugin=available; slash-plugin=unavailable'));
  });

  it('flags hook-bearing Codex plugins that do not expose hooks in their manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-gap-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    await writeJson(join(root, 'plugins', 'engineer', '.codex-plugin', 'plugin.json'), {
      name: 'engineer',
      version: '1.0.0',
      description: 'engineer plugin',
    });

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner(defaultRuntimeProbeMap()),
    });

    strictEqual(report.codex_plugin_hooks.status, 'packaging_gap');
    deepStrictEqual(report.codex_plugin_hooks.summary.default_file_only_plugins, ['engineer']);
    ok(report.codex_plugin_hooks.recommendations.some((rec) => rec.action === 'expose-bundled-hooks-in-manifest'));
    ok(report.host_parity.differences.some((issue) => issue.id === 'codex_plugin_hooks_packaging_gap'));
  });

  it('folds a claude_adapter_only plugin into the Codex bundled/review/expected sets (host loads default-file hooks regardless of command shape)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-claude-only-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    // LEGACY-LAYOUT SYNTHETIC (kept deliberately after the posture
    // resolution relocated the real attention registration): a root
    // hooks/hooks.json whose commands ALL target adapters/claude, and NO
    // Codex hooks in the manifest — attention's pre-relocation 0.4.x shape.
    // The old model excluded such a plugin from the Codex sets on the
    // premise that Codex ignores those hooks; host truth disproved that —
    // Codex 0.144.1's default-file discovery is command-shape-blind (it
    // surfaced attention's stop/subagent_stop in /hooks and let the
    // operator trust them). The classification survives as a diagnosis;
    // the exclusion does not, and this regression must never be inverted.
    await mkdir(join(root, 'plugins', 'attention', '.claude-plugin'), { recursive: true });
    await mkdir(join(root, 'plugins', 'attention', '.codex-plugin'), { recursive: true });
    await writeJson(join(root, 'plugins', 'attention', '.claude-plugin', 'plugin.json'), { name: 'attention', version: '0.2.0', description: 'attention' });
    await writeJson(join(root, 'plugins', 'attention', '.codex-plugin', 'plugin.json'), { name: 'attention', version: '0.2.0', description: 'attention' });
    await mkdir(join(root, 'plugins', 'attention', 'hooks'), { recursive: true });
    await writeJson(join(root, 'plugins', 'attention', 'hooks', 'hooks.json'), {
      hooks: {
        Notification: [{ matcher: 'permission_prompt', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/adapters/claude/hooks/notification.mjs"' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/adapters/claude/hooks/stop.mjs"' }] }],
        SubagentStop: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/adapters/claude/hooks/subagent-stop.mjs"' }] }],
      },
    });
    // Seed a CURRENT matching attestation (bundled set + canonical bound versions)
    // so the missing-attestation follow-up cannot confound the lifecycle
    // assertion below — `partial` must be caused by command-portability
    // warnings ALONE (refine-verify causal-isolation finding). Currency is now
    // list-authoritative (S8a4 §SCOPE-2), so the three plugins must be Codex-installed
    // at the bound versions and the record must carry bound_versions matching the pinned
    // codex-cli 0.144.1 — a source-only match no longer reads as current.
    await seedCodexInstallCache(home, 'attention', '0.2.0');
    await seedCodexInstallCache(home, 'engineer', '1.0.0');
    await seedCodexInstallCache(home, 'orchestrator', '1.0.0');
    // The attestation below claims reviewed/trusted hooks, and currency now demands the
    // hook-state config that trust writes actually EXISTS (S8a5 hook_state_unavailable
    // gate) — so the fixture machine carries the trusted engineer/orchestrator rows.
    // Attention's rows stay deliberately absent: expected-but-missing rows do not stale
    // an attestation, which the assertions below pin.
    await writeTrustedCodexHookStateConfig(home);
    const attestRunId = 'settings-20260711T000000Z-ca0501';
    await mkdir(join(root, '.agentic-plugins', 'runs', 'settings', attestRunId), { recursive: true });
    await writeJson(join(root, '.agentic-plugins', 'runs', 'settings', attestRunId, 'settings.json'), {
      schema_version: 'runtime-settings-execution-artifact-1.3',
      run_id: attestRunId,
      status: 'recorded',
      created_at: '2026-07-11T00:00:00.000Z',
      codex_hook_review: {
        mode: 'operator-attestation',
        requested: true,
        attested: true,
        status: 'attested',
        host: 'codex',
        command: '/hooks',
        attested_at: '2026-07-11T00:00:00.000Z',
        bundled_plugins: ['attention', 'engineer', 'orchestrator'],
        attested_plugins: ['attention', 'engineer', 'orchestrator'],
        plugin_versions: { attention: '0.2.0', engineer: '1.0.0', orchestrator: '1.0.0' },
        bound_versions: { codex: '0.144.1', plugins: { codex: { attention: '0.2.0', engineer: '1.0.0', orchestrator: '1.0.0' } } },
      },
    });

    // Pin the fake host to the version the observation was made on —
    // codex-cli 0.144.1, generic hooks stable, plugin_hooks removed — so
    // this absence-era regression states its premise instead of riding the
    // generic 0.130 fixture.
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'codex --version': okResult('codex-cli 0.144.1\n'),
        'codex features list': okResult('hooks stable true\nplugin_hooks removed false\nplugins stable true\nmulti_agent stable true\n'),
      }),
    });
    strictEqual(report.codex_plugin_hooks.status, 'ready', 'premise pin: hook surface must be ready on the pinned host');

    // Diagnosis retained; deliberate non-declaration stays out of the
    // default_file_only packaging-gap bucket (the posture decision belongs
    // to the attention package, tracked in follow-ups.md).
    deepStrictEqual(report.codex_plugin_hooks.summary.claude_adapter_only_plugins, ['attention']);
    ok(!report.codex_plugin_hooks.summary.default_file_only_plugins.includes('attention'), 'attention is not a default_file_only Codex gap');
    ok(report.codex_plugin_hooks.status !== 'packaging_gap', `status must not be packaging_gap (got ${report.codex_plugin_hooks.status})`);
    ok(!report.codex_plugin_hooks.recommendations.some((rec) => rec.action === 'expose-bundled-hooks-in-manifest' && (rec.detail ?? '').includes('attention')));
    ok(!report.host_parity.differences.some((issue) => issue.id === 'codex_plugin_hooks_packaging_gap'), 'a deliberately Claude-only plugin does not raise a Codex packaging-gap parity difference');

    // Host-truth inclusion: bundled + review target + expected hook state.
    ok(report.codex_plugin_hooks.summary.bundled_plugins.includes('attention'), 'attention joins the Codex bundled set — Codex loads its default-file hooks');
    const target = report.codex_plugin_hooks.review_targets.find((entry) => entry.plugin === 'attention');
    ok(target, 'attention has a /hooks review target');
    deepStrictEqual(target.events, ['Notification', 'Stop', 'SubagentStop']);
    strictEqual(target.manifest_exposed, false);
    // Command-portability warnings apply like any other bundler (bare `node`
    // + Claude-adapter references are host truth once Codex surfaces the
    // hooks) — the same pressure that moved the siblings to portable
    // /bin/sh wrappers.
    ok(report.codex_plugin_hooks.summary.command_warning_plugins.includes('attention'), 'claude-adapter command shape now raises the portability warning');
    // Positive twin of the relocated test's negative lifecycle assertion
    // (refine-verify F4): the command-warnings evidence key must actually
    // appear while a Claude-shaped bundler is Codex-visible — otherwise the
    // negative check over there could pass on a renamed evidence key. The
    // seeded current attestation above isolates causality: with
    // manual-hook-review=false, command warnings are the ONLY thing that
    // can hold this criterion at partial.
    const legacyLifecycle = report.experience_parity.criteria.find((criterion) => criterion.id === 'lifecycle_hook_continuity');
    strictEqual(legacyLifecycle.status, 'partial', 'command-portability warnings keep lifecycle continuity partial');
    ok(legacyLifecycle.evidence.includes('manual-hook-review=false'), 'causal isolation: the attestation follow-up must not be the cause');
    ok(legacyLifecycle.evidence.includes('command-warnings=attention'), 'lifecycle evidence names the warning plugin');

    // Expected hook-state entries exist for the events Codex materializes
    // (stop, subagent_stop); Claude's Notification is not a Codex event, so
    // it surfaces as unmapped instead of a permanently-missing expectation.
    const attentionExpected = report.codex_plugin_hooks.hook_state.expected.filter((entry) => entry.plugin === 'attention');
    deepStrictEqual(attentionExpected.map((entry) => entry.event).sort(), ['stop', 'subagent_stop']);
    for (const entry of attentionExpected) strictEqual(entry.state, 'missing', 'attention rows absent from hooks.state: expected but not yet reviewed/trusted');
    deepStrictEqual(report.codex_plugin_hooks.hook_state.unmapped_events, [
      { plugin: 'attention', hooks_path: 'hooks/hooks.json', event: 'Notification', normalized_event: 'notification' },
    ]);
    strictEqual(report.codex_plugin_hooks.hook_state.summary.unmapped_events, 1);
    // Doctor's own text renderer must surface the nonzero unmapped counter
    // (refine-verify F3 — settings has a separate renderer copy; this is the
    // only pin of doctor's line with unmapped > 0).
    ok(formatText(report).includes('unmapped=1'));
  });

  it('drops a relocated attention from every Codex hook set and reads its stale trust rows as unexpected (display-only)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-attention-relocated-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-attention-relocated-home-'));
    await seedRepo(root);
    // POST-RELOCATION layout (posture resolution, ADR-0040 §3 amendment):
    // the Claude registration is manifest-scoped at adapters/claude/hooks/
    // hooks.json, the Codex manifest declares no hooks, and NO root default
    // hooks/hooks.json exists. Codex therefore has neither discovery input.
    await mkdir(join(root, 'plugins', 'attention', '.claude-plugin'), { recursive: true });
    await mkdir(join(root, 'plugins', 'attention', '.codex-plugin'), { recursive: true });
    await writeJson(join(root, 'plugins', 'attention', '.claude-plugin', 'plugin.json'), {
      name: 'attention', version: '0.4.1', description: 'attention', hooks: './adapters/claude/hooks/hooks.json',
    });
    await writeJson(join(root, 'plugins', 'attention', '.codex-plugin', 'plugin.json'), { name: 'attention', version: '0.4.1', description: 'attention' });
    await mkdir(join(root, 'plugins', 'attention', 'adapters', 'claude', 'hooks'), { recursive: true });
    await writeJson(join(root, 'plugins', 'attention', 'adapters', 'claude', 'hooks', 'hooks.json'), {
      hooks: {
        Notification: [{ matcher: 'permission_prompt', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/adapters/claude/hooks/notification.mjs"' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/adapters/claude/hooks/stop.mjs"' }] }],
        SubagentStop: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/adapters/claude/hooks/subagent-stop.mjs"' }] }],
      },
    });
    // The rows this machine's Codex wrote when it trusted the PRE-relocation
    // hooks: they survive the relocation in the operator's config and must
    // surface as display-only unexpected entries — never expected, never a
    // gate, and never mutated by runtime.
    await mkdir(join(home, '.codex'), { recursive: true });
    const configPath = join(home, '.codex', 'config.toml');
    const configBefore = [
      '[hooks.state]',
      '',
      '[hooks.state."attention@agentic-plugins:hooks/hooks.json:stop:0:0"]',
      'trusted_hash = "sha256:abc123"',
      '',
      '[hooks.state."attention@agentic-plugins:hooks/hooks.json:subagent_stop:0:0"]',
      'trusted_hash = "sha256:def456"',
      '',
    ].join('\n');
    await writeFile(configPath, configBefore);

    // Same premise pin as the legacy-layout regression above: the relocated
    // absence claim is only meaningful on the observed host generation.
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'codex --version': okResult('codex-cli 0.144.1\n'),
        'codex features list': okResult('hooks stable true\nplugin_hooks removed false\nplugins stable true\nmulti_agent stable true\n'),
      }),
    });
    strictEqual(report.codex_plugin_hooks.status, 'ready', 'premise pin: the sibling hook surface stays ready without attention');
    // Fixture-presence pin (refine-verify F1): every absence assertion below
    // is vacuous if the attention seeding rots — doctor's Codex hook scan
    // never reads the Claude manifest, so "relocated attention" and "no
    // attention directory at all" are indistinguishable to the hook report.
    // Pin that doctor actually SAW the synthetic attention source.
    strictEqual(report.plugins.attention.status, 'source_available', 'premise pin: the relocated attention source must be visible to doctor');
    strictEqual(report.plugins.attention.source.present, true, 'premise pin: attention source directory present');
    strictEqual(report.codex_plugin_hooks.hook_state.schema_version, 'runtime-codex-hook-state-1.2');

    // Absent from EVERY Codex hook surface set.
    const summary = report.codex_plugin_hooks.summary;
    ok(!summary.bundled_plugins.includes('attention'), 'not bundled');
    ok(!summary.manifest_exposed_plugins.includes('attention'), 'not manifest-exposed');
    ok(!summary.default_file_only_plugins.includes('attention'), 'not default-file-only');
    ok(!summary.claude_adapter_only_plugins.includes('attention'), 'not claude-adapter-only (no Codex-visible hooks file at all)');
    ok(!summary.command_warning_plugins.includes('attention'), 'no command-portability warning without a Codex-visible hooks file');
    ok(!report.codex_plugin_hooks.review_targets.some((entry) => entry.plugin === 'attention'), 'no /hooks review target');
    ok(!report.codex_plugin_hooks.hook_state.expected.some((entry) => entry.plugin === 'attention'), 'no expected hook-state rows');
    ok(!report.codex_plugin_hooks.hook_state.unmapped_events.some((entry) => entry.plugin === 'attention'), 'no unmapped events');

    // The stale trust rows read as exactly two display-only unexpected
    // entries, and doctor leaves the operator's config bytes untouched.
    const hookState = report.codex_plugin_hooks.hook_state;
    strictEqual(hookState.summary.unexpected_agentic_entries, 2, 'both stale rows surface as unexpected');
    deepStrictEqual(
      hookState.unexpected_agentic_entries.map((entry) => `${entry.plugin}:${entry.hooks_path}:${entry.event}`).sort(),
      ['attention:hooks/hooks.json:stop', 'attention:hooks/hooks.json:subagent_stop'],
    );
    strictEqual(await readFile(configPath, 'utf8'), configBefore, 'doctor never rewrites the operator Codex config');
    // Without attention's Claude-shaped commands the lifecycle gate no
    // longer carries a command-warnings hold from attention.
    const lifecycle = report.experience_parity.criteria.find((criterion) => criterion.id === 'lifecycle_hook_continuity');
    ok(!(lifecycle.evidence ?? '').includes('command-warnings=attention'), 'lifecycle evidence carries no attention command warning');
  });

  // Refine-verify blocker: in a cache-only consumer repo (no plugins/ source)
  // the hooks file path is the ABSOLUTE versioned install-cache path, while
  // Codex writes hooks.state paths relative to the plugin root. Without the
  // versioned-cache marker in normalizeCodexHookStatePath nothing matched —
  // every expected entry read `missing`, every trusted row read unexpected,
  // and the attestation disabled-gate was unreachable.
  //
  // LEGACY attention 0.4.0 CACHE VISIBILITY (kept after the relocation): an
  // installed pre-relocation cache legitimately still exposes the root
  // hooks/hooks.json to Codex until the upgrade lands — cache scanning
  // intentionally survives the source-tree relocation.
  it('matches hooks.state rows against versioned install-cache hook paths in a cache-only consumer repo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-cache-only-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-cache-only-home-'));
    // NO seedRepo: the consumer repo has no plugins/ source at all.
    const cacheRoot = join(home, '.codex', 'plugins', 'cache', 'agentic-plugins', 'attention', '0.4.0');
    await mkdir(join(cacheRoot, '.codex-plugin'), { recursive: true });
    await writeJson(join(cacheRoot, '.codex-plugin', 'plugin.json'), { name: 'attention', version: '0.4.0', description: 'attention' });
    await mkdir(join(cacheRoot, 'hooks'), { recursive: true });
    await writeJson(join(cacheRoot, 'hooks', 'hooks.json'), {
      hooks: {
        Notification: [{ matcher: 'permission_prompt', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/adapters/claude/hooks/notification.mjs"' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/adapters/claude/hooks/stop.mjs"' }] }],
        SubagentStop: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/adapters/claude/hooks/subagent-stop.mjs"' }] }],
      },
    });
    await writeFile(join(home, '.codex', 'config.toml'), [
      '[hooks.state]',
      '',
      '[hooks.state."attention@agentic-plugins:hooks/hooks.json:stop:0:0"]',
      'trusted_hash = "sha256:abc123"',
      '',
      '[hooks.state."attention@agentic-plugins:hooks/hooks.json:subagent_stop:0:0"]',
      'enabled = false',
      'trusted_hash = "sha256:def456"',
      '',
    ].join('\n'));

    const report = await runDoctor({ repoRoot: root, homeDir: home, runner: fakeRunner(defaultRuntimeProbeMap()) });

    const target = report.codex_plugin_hooks.review_targets.find((entry) => entry.plugin === 'attention');
    ok(target, 'cache-only attention still has a review target');
    strictEqual(target.version, '0.4.0', 'version resolves from the install cache when no source manifest exists');
    const summary = report.codex_plugin_hooks.hook_state.summary;
    strictEqual(summary.expected_configured, 2, 'absolute versioned cache paths normalize to the relative hooks.state shape');
    strictEqual(summary.unexpected_agentic_entries, 0, 'no trusted row is misread as unexpected in a cache-only repo');
    strictEqual(summary.expected_missing, 0);
    strictEqual(summary.expected_disabled, 1, 'the explicit enabled=false row is visible again — the attestation disabled-gate is reachable');
    const states = Object.fromEntries(report.codex_plugin_hooks.hook_state.expected.filter((entry) => entry.plugin === 'attention').map((entry) => [entry.event, entry.state]));
    deepStrictEqual(states, { stop: 'enabled_trusted', subagent_stop: 'disabled' });
  });

  it('invalidates a recorded /hooks attestation when the install-cache version moves (cache-only repo)', async () => {
    // Generic cache-version currency machinery — retargeted onto engineer
    // (a manifest-declared Codex adapter hooks path like the shipped plugin)
    // after the attention relocation removed attention's Codex surface; a
    // fictional post-relocation attention layout here would be misleading.
    for (const { cacheVersion, expectFollowup, label } of [
      { cacheVersion: '0.20.0', expectFollowup: false, label: 'matching cache version keeps the attestation current' },
      { cacheVersion: '0.21.0', expectFollowup: true, label: 'a cache upgrade flips the attestation to plugin_version_changed' },
    ]) {
      const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-attest-cache-'));
      const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-attest-cache-home-'));
      const cacheRoot = join(home, '.codex', 'plugins', 'cache', 'agentic-plugins', 'engineer', cacheVersion);
      await mkdir(join(cacheRoot, '.codex-plugin'), { recursive: true });
      await writeJson(join(cacheRoot, '.codex-plugin', 'plugin.json'), { name: 'engineer', version: cacheVersion, description: 'engineer', hooks: './adapters/codex/hooks/hooks.json' });
      await mkdir(join(cacheRoot, 'adapters', 'codex', 'hooks'), { recursive: true });
      await writeJson(join(cacheRoot, 'adapters', 'codex', 'hooks', 'hooks.json'), {
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: PORTABLE_HOOK_COMMAND }] }],
          PreCompact: [{ hooks: [{ type: 'command', command: PORTABLE_HOOK_COMMAND }] }],
        },
      });
      await writeFile(join(home, '.codex', 'config.toml'), [
        '[hooks.state]',
        '',
        '[hooks.state."engineer@agentic-plugins:adapters/codex/hooks/hooks.json:stop:0:0"]',
        'trusted_hash = "sha256:abc123"',
        '',
        '[hooks.state."engineer@agentic-plugins:adapters/codex/hooks/hooks.json:pre_compact:0:0"]',
        'trusted_hash = "sha256:def456"',
        '',
      ].join('\n'));
      // Recorded attestation covering engineer@0.20.0.
      const runId = 'settings-20260710T120000Z-abc123';
      await mkdir(join(root, '.agentic-plugins', 'runs', 'settings', runId), { recursive: true });
      await writeJson(join(root, '.agentic-plugins', 'runs', 'settings', runId, 'settings.json'), {
        schema_version: 'runtime-settings-execution-artifact-1.3',
        run_id: runId,
        status: 'recorded',
        created_at: '2026-07-10T12:00:00.000Z',
        codex_hook_review: {
          mode: 'attest',
          requested: true,
          attested: true,
          status: 'attested',
          host: 'codex',
          command: '/hooks',
          attested_at: '2026-07-10T12:00:00.000Z',
          bundled_plugins: ['engineer'],
          attested_plugins: ['engineer'],
          // Canonical binding: attested against engineer@0.20.0 on codex-cli 0.130.0 (the
          // default probe). The cache-version move drives the ONLY plugin-version drift;
          // the codex-cli binding matches both cases so it is never the drift signal.
          plugin_versions: { engineer: '0.20.0' },
          bound_versions: { codex: '0.130.0', plugins: { codex: { engineer: '0.20.0' } } },
        },
      });

      const report = await runDoctor({
        repoRoot: root,
        homeDir: home,
        runner: fakeRunner({
          ...defaultRuntimeProbeMap(),
          'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
        }),
      });
      // Guard against a vacuous pass: the follow-up generator early-returns
      // unless the hook surface is ready, so pin the precondition.
      strictEqual(report.codex_plugin_hooks.status, 'ready', `${label}: hook surface must be ready`);
      // Bind the adapters-path × versioned-cache hooks.state rows to the
      // report (refine-verify F5): without these, the seeded rows are
      // decoration — attestation currency never consults row matching, and
      // the adapters-cache normalization shape (the shipped consumer
      // reality for engineer/orchestrator/designer) would be bound nowhere.
      strictEqual(report.codex_plugin_hooks.hook_state.summary.expected_configured, 2, `${label}: adapters-path cache rows normalize and match`);
      strictEqual(report.codex_plugin_hooks.hook_state.summary.unexpected_agentic_entries, 0, `${label}: no row misreads as unexpected`);
      const followup = (report.plugin_command_surface.manual_followups ?? []).find((item) => item.id === 'codex-hook-review');
      strictEqual(Boolean(followup), expectFollowup, label);
    }
  });

  it('keeps observed-but-unknown hook-state events expected (vocabulary mirror self-heals)', async () => {
    // Generic vocabulary self-healing — retargeted onto engineer's seeded
    // manifest-declared hooks file after the attention relocation (this
    // tests the mirror, not any attention-specific packaging).
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-unknown-event-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-unknown-event-home-'));
    await seedRepo(root);
    await writeJson(join(root, 'plugins', 'engineer', 'hooks', 'hooks.json'), {
      hooks: {
        // An event outside CODEX_HOOK_STATE_EVENTS that a future Codex has
        // started materializing: because a matching hooks.state row EXISTS,
        // it must stay expected (self-heal), not unmapped.
        SessionEnd: [{ hooks: [{ type: 'command', command: PORTABLE_HOOK_COMMAND }] }],
      },
    });
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(join(home, '.codex', 'config.toml'), [
      '[hooks.state]',
      '',
      '[hooks.state."engineer@agentic-plugins:hooks/hooks.json:session_end:0:0"]',
      'trusted_hash = "sha256:abc123"',
      '',
    ].join('\n'));

    const report = await runDoctor({ repoRoot: root, homeDir: home, runner: fakeRunner(defaultRuntimeProbeMap()) });
    const engineerExpected = report.codex_plugin_hooks.hook_state.expected.filter((entry) => entry.plugin === 'engineer');
    deepStrictEqual(engineerExpected.map((entry) => `${entry.event}:${entry.state}`), ['session_end:enabled_trusted']);
    strictEqual(report.codex_plugin_hooks.hook_state.summary.unmapped_events, 0, 'an observed event is never unmapped, even outside the mirror vocabulary');
  });

  // ADR-0042 RT: designer is hook-bearing (it ships a Codex hooks manifest since
  // designer PR2), so the inventory addition surfaces it in the Codex
  // hook-readiness report. The boundary the RT topic fixes: assert INVENTORY
  // MEMBERSHIP (packaged), never trusted/active state — runtime treats `/hooks`
  // review as a MANUAL attestation it cannot observe.
  // Codex Plan-verify MINOR: the synthetic seed below uses `./hooks/hooks.json`,
  // but the shipped designer manifest exposes `./adapters/codex/hooks/hooks.json`.
  // Ground the hook-readiness premise on the REAL plugin, so a manifest-path
  // regression in plugins/designer cannot pass the synthetic test.
  it('the shipped designer plugin really is hook-bearing (the premise of the RT hook-readiness signal)', async () => {
    const repoRoot = resolve(fileURLToPath(import.meta.url), '../../..');
    const manifest = JSON.parse(await readFile(join(repoRoot, 'plugins', 'designer', '.codex-plugin', 'plugin.json'), 'utf8'));
    strictEqual(typeof manifest.hooks, 'string', 'the designer Codex manifest must expose a hooks path');
    ok(existsSync(join(repoRoot, 'plugins', 'designer', manifest.hooks)),
      `the designer Codex manifest hooks path must resolve: ${manifest.hooks}`);
    ok(PLUGIN_NAMES.includes('designer'),
      'a hook-bearing designer must be in the runtime inventory for the hook-readiness report to see it');
  });

  // Real-tree premise pin for the relocated-attention absence regression
  // above (same non-vacuity pattern as the designer premise test): if the
  // shipped attention layout regresses — the root default returns, a Codex
  // manifest hooks key appears, or the declared Claude path stops resolving
  // — this fails even though every synthetic fixture would keep passing.
  it('the shipped attention plugin really has no Codex hook surface (relocated Claude registration)', async () => {
    const repoRoot = resolve(fileURLToPath(import.meta.url), '../../..');
    const claude = JSON.parse(await readFile(join(repoRoot, 'plugins', 'attention', '.claude-plugin', 'plugin.json'), 'utf8'));
    strictEqual(claude.hooks, './adapters/claude/hooks/hooks.json', 'the Claude manifest must declare the relocated adapters path');
    ok(existsSync(join(repoRoot, 'plugins', 'attention', claude.hooks)),
      `the declared Claude hooks path must resolve: ${claude.hooks}`);
    const codex = JSON.parse(await readFile(join(repoRoot, 'plugins', 'attention', '.codex-plugin', 'plugin.json'), 'utf8'));
    ok(!Object.hasOwn(codex, 'hooks'), 'the Codex manifest must not declare hooks');
    ok(!existsSync(join(repoRoot, 'plugins', 'attention', 'hooks')),
      'no root hooks/ directory — Codex default-file discovery must find nothing');
    ok(PLUGIN_NAMES.includes('attention'),
      'attention must stay in the runtime inventory so its absence from hook sets is a diagnosis, not an inventory gap');
  });

  it('a hook-bearing designer is reported as PACKAGED and review-required, never as trusted/active (ADR-0042 RT)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-designer-hooks-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    // Seed designer the way the plugin actually ships: a Codex manifest that
    // exposes hooks + a bundled hooks.json with the portable command shape.
    await mkdir(join(root, 'plugins', 'designer', '.claude-plugin'), { recursive: true });
    await mkdir(join(root, 'plugins', 'designer', '.codex-plugin'), { recursive: true });
    await mkdir(join(root, 'plugins', 'designer', 'hooks'), { recursive: true });
    await writeJson(join(root, 'plugins', 'designer', '.claude-plugin', 'plugin.json'), {
      name: 'designer', version: '1.0.0', description: 'designer plugin',
    });
    await writeJson(join(root, 'plugins', 'designer', '.codex-plugin', 'plugin.json'), {
      name: 'designer', version: '1.0.0', description: 'designer plugin', hooks: './hooks/hooks.json',
    });
    await writeJson(join(root, 'plugins', 'designer', 'hooks', 'hooks.json'), {
      hooks: {
        SessionStart: [{ matcher: 'compact', hooks: [{ type: 'command', command: PORTABLE_HOOK_COMMAND }] }],
        PreCompact: [{ hooks: [{ type: 'command', command: PORTABLE_HOOK_COMMAND }] }],
        Stop: [{ hooks: [{ type: 'command', command: PORTABLE_HOOK_COMMAND }] }],
      },
    });

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
      }),
    });

    // PACKAGED: designer joins the bundled set and the review targets.
    ok(report.codex_plugin_hooks.summary.bundled_plugins.includes('designer'),
      'a hook-bearing designer must appear in the Codex bundled set');
    const target = report.codex_plugin_hooks.review_targets.find((entry) => entry.plugin === 'designer');
    ok(target, 'designer must appear as a Codex hook review target');
    strictEqual(target.manifest_exposed, true);
    deepStrictEqual(target.events, ['PreCompact', 'SessionStart', 'Stop']);
    // No packaging gap, and no command-portability warning: the seeded command
    // is the portable ${PLUGIN_ROOT} + run-node-hook.sh shape.
    ok(!report.codex_plugin_hooks.summary.missing_hooks_file_plugins.includes('designer'));
    ok(!report.codex_plugin_hooks.summary.command_warning_plugins.includes('designer'));
    ok(!report.codex_plugin_hooks.summary.bare_node_command_plugins.includes('designer'));

    // NOT trusted/active: review stays a manual `/hooks` follow-up that names
    // designer, and doctor never claims the hooks are trusted or active.
    const followup = report.plugin_command_surface.manual_followups.find((entry) => entry.id === 'codex-hook-review');
    strictEqual(followup.status, 'manual_check');
    deepStrictEqual(followup.commands, ['/hooks']);
    ok(followup.verify.includes('designer'), 'the manual /hooks follow-up must name designer');
    ok(followup.verify.includes('New hook - review required'));
    ok(followup.verify.includes('Active=0'));
    // Codex Plan-verify MINOR: `x === undefined` also passes when the key exists
    // with an undefined value. Assert ABSENCE of the key, and that nothing in the
    // serialized review-target payload claims trust/activity — runtime cannot
    // observe either (that is what the /hooks manual attestation is for).
    ok(!Object.hasOwn(target, 'trusted'), 'doctor must not synthesize a trusted key it cannot observe');
    ok(!Object.hasOwn(target, 'active'), 'doctor must not synthesize an active key it cannot observe');
    ok(!/"(trusted|active)"\s*:/.test(JSON.stringify(report.codex_plugin_hooks.review_targets)),
      'no review target may serialize a trusted/active claim');
  });

  it('reports Codex hook review as a manual follow-up when plugin hooks are ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-review-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
      }),
    });

    const followup = report.plugin_command_surface.manual_followups.find((entry) => entry.id === 'codex-hook-review');
    strictEqual(followup.status, 'manual_check');
    strictEqual(followup.host, 'codex');
    deepStrictEqual(followup.commands, ['/hooks']);
    ok(followup.verify.includes('engineer, orchestrator'));
    ok(followup.verify.includes('2 review target(s)'));
    ok(followup.verify.includes('New hook - review required'));
    ok(followup.verify.includes('Installed counts alone'));
    ok(followup.verify.includes('Active=0'));
    ok(followup.verify.includes('runtime:settings --attest-codex-hook-review'));
    strictEqual(report.codex_plugin_hooks.review_targets.length, 2);
    const engineerTarget = report.codex_plugin_hooks.review_targets.find((target) => target.plugin === 'engineer');
    strictEqual(engineerTarget.version, '1.0.0');
    strictEqual(engineerTarget.manifest_exposed, true);
    ok(engineerTarget.hooks_path.endsWith(join('plugins', 'engineer', 'hooks', 'hooks.json')));
    deepStrictEqual(engineerTarget.events, ['PreCompact', 'SessionStart', 'Stop']);
    strictEqual(engineerTarget.handler_count, 3);
    strictEqual(engineerTarget.command_count, 1);
    deepStrictEqual(engineerTarget.commands, [PORTABLE_HOOK_COMMAND]);
    deepStrictEqual(followup.review_targets, report.codex_plugin_hooks.review_targets);
    strictEqual(report.experience_parity.status, 'blocked');
    ok(report.experience_parity.criteria.some((entry) => entry.id === 'plugin_management_followups' && entry.status === 'partial' && entry.next_step.includes('runtime:settings --attest-codex-hook-review')));
    ok(report.experience_parity.criteria.some((entry) => entry.id === 'lifecycle_hook_continuity' && entry.status === 'partial' && entry.next_step.includes('New hook - review required')));
    ok(report.experience_parity.next_actions.some((entry) => entry.id === 'codex-hook-review' && entry.reason.includes('runtime:settings --attest-codex-hook-review')));
    ok(formatText(report).includes('command: /hooks'));
    ok(formatText(report).includes('review-target: engineer@1.0.0'));
    ok(formatText(report).includes(`path=${engineerTarget.hooks_path}`));
    ok(formatText(report).includes(`hook-command: ${PORTABLE_HOOK_COMMAND}`));
  });

  it('reports disabled Codex hook state for bundled hooks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-state-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-state-home-'));
    await seedRepo(root);
    await writeDisabledCodexHookStateConfig(home);

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
      }),
    });

    strictEqual(report.codex_plugin_hooks.status, 'ready');
    strictEqual(report.codex_plugin_hooks.hook_state.summary.expected, 6);
    strictEqual(report.codex_plugin_hooks.hook_state.summary.expected_enabled, 0);
    strictEqual(report.codex_plugin_hooks.hook_state.summary.expected_disabled, 6);
    // Fully disabled groups also surface at the per-handler grain (S8a5): the handler
    // count is a strict superset of the handlers behind the group count.
    strictEqual(report.codex_plugin_hooks.hook_state.summary.disabled_handlers, 6);
    ok(report.codex_plugin_hooks.recommendations.some((rec) => rec.action === 'enable-codex-hook-state'));
    const followup = report.plugin_command_surface.manual_followups.find((entry) => entry.id === 'codex-hook-review');
    ok(followup.verify.includes('6 explicitly disabled hook handler(s) across 6 expected bundled hook entries'));
    const text = formatText(report);
    ok(text.includes('hook-state: config=available; expected=6; enabled=0; disabled=6; disabled-handlers=6'));
    ok(text.includes('disabled-hook-handler: engineer; event=pre_compact; path=hooks/hooks.json; group=0; hook=0; group-state=disabled'));
    ok(text.includes('enable-codex-hook-state'));
  });

  // Regression: a hook entry Codex wrote on trust carries `trusted_hash` and NO
  // `enabled` key. Reading the absent key as `disabled` made every hook trusted
  // by a current Codex look disabled, which in turn made
  // `runtime:settings --attest-codex-hook-review` block permanently (it refuses
  // while any expected entry is disabled). Observed on codex-cli 0.142.5 when
  // designer became the first hook-bearing plugin trusted after the ADR-0035 §6
  // host-config writer was removed; the designer Stop hook demonstrably fired
  // and archived a terminal workflow while doctor called it `disabled`.
  for (const explicitEnabled of [false, true]) {
    const label = explicitEnabled
      ? 'an explicit `enabled = true` (older Codex residue)'
      : 'no `enabled` key (what a current Codex writes on trust)';
    it(`treats a trusted Codex hook entry with ${label} as enabled`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-trusted-repo-'));
      const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-trusted-home-'));
      await seedRepo(root);
      await writeTrustedCodexHookStateConfig(home, 'hooks/hooks.json', { explicitEnabled });

      const report = await runDoctor({
        repoRoot: root,
        homeDir: home,
        runner: fakeRunner({
          ...defaultRuntimeProbeMap(),
          'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
        }),
      });

      const summary = report.codex_plugin_hooks.hook_state.summary;
      strictEqual(summary.expected, 6);
      strictEqual(summary.expected_enabled, 6, 'a trusted entry is enabled unless `enabled = false` says otherwise');
      strictEqual(summary.expected_disabled, 0, 'an absent `enabled` key must not be reported as disabled');
      strictEqual(summary.expected_untrusted, 0);
      strictEqual(summary.expected_missing, 0);
      for (const entry of report.codex_plugin_hooks.hook_state.expected) {
        strictEqual(entry.state, 'enabled_trusted', `${entry.plugin}:${entry.event}`);
      }
      // The blocking follow-up hint must not fire: there is nothing to enable.
      const followup = report.plugin_command_surface.manual_followups.find((e) => e.id === 'codex-hook-review');
      ok(!followup.verify.includes('expected bundled hook entries disabled'),
        'no "enable them in /hooks" hint when nothing is disabled — /hooks has no enable toggle to act on');
      ok(!report.codex_plugin_hooks.recommendations.some((rec) => rec.action === 'enable-codex-hook-state'));
      ok(formatText(report).includes('hook-state: config=available; expected=6; enabled=6; disabled=0'));
    });
  }

  it('still reports disabled when Codex wrote an explicit `enabled = false`', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-explicit-off-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-explicit-off-home-'));
    await seedRepo(root);
    await writeDisabledCodexHookStateConfig(home);

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
      }),
    });

    strictEqual(report.codex_plugin_hooks.hook_state.summary.expected_disabled, 6,
      'the widening must not swallow a deliberate opt-out');
  });

  // THE S8a5 FALSE-PASS PIN. Group state is derived enabled-wins, so a handler
  // explicitly `enabled = false` beside an enabled sibling for the SAME
  // (plugin, path, event) left `expected_disabled` at 0 — doctor called a recorded
  // attestation current, settings let a new one through, and the machine-bootstrap
  // schema's "stales on a disabled expected hook" claim was unenforced. Every
  // assertion here targets the sibling-masked grain specifically; a fixture that
  // disabled the whole group (like test #24's plugin-level twin) passes even
  // without the per-handler derivation, which is exactly how this shipped.
  it('surfaces a disabled handler masked by an enabled sibling, and stales attestation currency on it (S8a5)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-sibling-mask-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-sibling-mask-home-'));
    await seedRepo(root);
    // TWO real Stop handlers (peer finding: with the default single-handler fixture
    // the 0:1 row below would model a STALE index, not a live sibling — the
    // aggregation treats both alike today, but this test's name promises the sibling
    // case, so the fixture delivers it; the orphan-index case has its own test).
    await writeJson(join(root, 'plugins', 'engineer', 'hooks', 'hooks.json'), {
      hooks: {
        SessionStart: [{ matcher: 'compact', hooks: [{ type: 'command', command: PORTABLE_HOOK_COMMAND }] }],
        PreCompact: [{ hooks: [{ type: 'command', command: PORTABLE_HOOK_COMMAND }] }],
        Stop: [{ hooks: [{ type: 'command', command: PORTABLE_HOOK_COMMAND }, { type: 'command', command: PORTABLE_HOOK_COMMAND }] }],
      },
    });
    await seedCodexInstallCache(home, 'engineer', '1.0.0');
    await seedCodexInstallCache(home, 'orchestrator', '1.0.0');
    // All six expected entries trusted — plus a SECOND handler row for engineer:stop
    // (hook index 1) that Codex recorded explicitly disabled.
    await writeTrustedCodexHookStateConfig(home, 'hooks/hooks.json', {
      extraLines: [
        '[hooks.state."engineer@agentic-plugins:hooks/hooks.json:stop:0:1"]',
        'enabled = false',
        'trusted_hash = "sha256:sibling"',
        '',
      ],
    });
    // An otherwise-CURRENT attestation (matching plugin set, versions, and the pinned
    // codex-cli 0.130.0), so the disabled handler is the only thing that can stale it.
    const runId = 'settings-20260718T000000Z-a5f001';
    await mkdir(join(root, '.agentic-plugins', 'runs', 'settings', runId), { recursive: true });
    await writeJson(join(root, '.agentic-plugins', 'runs', 'settings', runId, 'settings.json'), {
      schema_version: 'runtime-settings-execution-artifact-1.3',
      run_id: runId,
      status: 'recorded',
      created_at: '2026-07-18T00:00:00.000Z',
      codex_hook_review: {
        mode: 'operator-attestation',
        requested: true,
        attested: true,
        status: 'attested',
        host: 'codex',
        command: '/hooks',
        attested_at: '2026-07-18T00:00:00.000Z',
        bundled_plugins: ['engineer', 'orchestrator'],
        attested_plugins: ['engineer', 'orchestrator'],
        plugin_versions: { engineer: '1.0.0', orchestrator: '1.0.0' },
        bound_versions: { codex: '0.130.0', plugins: { codex: { engineer: '1.0.0', orchestrator: '1.0.0' } } },
      },
    });

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
      }),
    });

    // The group taxonomy is PRESERVED: enabled-wins still reads engineer:stop as
    // enabled_trusted, and the old group grain still sees nothing disabled. These two
    // pins prove this is the masked case, not a fully-disabled group re-test.
    const hookState = report.codex_plugin_hooks.hook_state;
    const stopGroup = hookState.expected.find((entry) => entry.plugin === 'engineer' && entry.event === 'stop');
    strictEqual(stopGroup.state, 'enabled_trusted', 'the sibling keeps the group enabled');
    strictEqual(stopGroup.configured, 2);
    strictEqual(stopGroup.disabled, 1);
    strictEqual(hookState.summary.expected_disabled, 0, 'the group grain cannot see the disabled handler');
    // The per-handler grain CAN.
    strictEqual(hookState.summary.disabled_handlers, 1);
    deepStrictEqual(hookState.disabled_handlers, [{
      plugin: 'engineer',
      hooks_path: 'hooks/hooks.json',
      event: 'stop',
      group_index: '0',
      hook_index: '1',
      id: 'engineer@agentic-plugins:hooks/hooks.json:stop:0:1',
      group_state: 'enabled_trusted',
    }]);
    ok(report.codex_plugin_hooks.recommendations.some((rec) => rec.action === 'enable-codex-hook-state'),
      'the enable recommendation fires on per-handler evidence');

    // Currency: the otherwise-current attestation is NOT current while the handler is
    // disabled — the exact verdict that false-passed before the per-handler derivation.
    strictEqual(report.settings_runs.codex_hook_review.current, false);
    strictEqual(report.settings_runs.codex_hook_review.currency_reason, 'disabled_hook_state');
    strictEqual(report.settings_runs.codex_hook_review.status, 'stale');
    const followup = report.plugin_command_surface.manual_followups.find((entry) => entry.id === 'codex-hook-review');
    ok(followup, 'the re-review follow-up re-opens');
    ok(followup.verify.includes('1 explicitly disabled hook handler(s)'), 'the hint names the handler count');
    ok(formatText(report).includes('disabled-hook-handler: engineer; event=stop; path=hooks/hooks.json; group=0; hook=1; group-state=enabled_trusted'));

    // Producer→schema→reducer parity: the probe projection of THIS report validates
    // against the packaged 1.1 $defs shape, and the completion reducer reaches the
    // SAME stale verdict on it for the same reason.
    const projected = projectCodexHookStateForProbe(hookState);
    deepStrictEqual(projected, {
      observation: 'available',
      disabled_expected: [{ plugin: 'engineer', hooks_path: 'hooks/hooks.json', event: 'stop', group_index: '0', hook_index: '1' }],
    });
    const validateHookState = await makeDefValidator('runtime-bootstrap-run', 'codexHookStateProbe');
    const validated = validateHookState(projected);
    strictEqual(validated.ok, true, `the projection conforms to the persisted probe shape: ${validated.errors.join('; ')}`);
    const verdict = recomputeHookAttestation({
      status: 'attested',
      attested_plugins: ['engineer', 'orchestrator'],
      bound_versions: { codex: '0.130.0', plugins: { codex: { engineer: '1.0.0', orchestrator: '1.0.0' } } },
      artifact_pointer: null,
      artifact_hash: null,
      attested_at: '2026-07-18T00:00:00.000Z',
    }, {
      current: { runtime: RUNTIME_VERSION, claude: '2.1.208', codex: '0.130.0', plugins: { claude: {}, codex: { engineer: '1.0.0', orchestrator: '1.0.0' } } },
      expectedPlugins: ['engineer', 'orchestrator'],
      probe: {
        hosts: {
          claude: { cli_version: '2.1.208', auth: 'available', marketplace: 'registered', plugins: {} },
          codex: {
            cli_version: '0.130.0',
            auth: 'available',
            marketplace: 'registered',
            plugins: { engineer: { version: '1.0.0', state: 'installed' }, orchestrator: { version: '1.0.0', state: 'installed' } },
            hook_state: projected,
          },
        },
      },
      applicable: true,
    });
    strictEqual(verdict.status, 'stale', 'the reducer agrees with the mirror on the same evidence');
    ok(verdict.reasons.some((reason) => reason.includes('engineer has an explicitly disabled hook handler (hooks/hooks.json:stop:0:1)')),
      `the stale reason names the handler: ${verdict.reasons.join(' | ')}`);
    ok(!verdict.reasons.some((reason) => reason.includes('is disabled on Codex')),
      'the plugin-level check is NOT the cause — the plugin is installed; only the handler is off');
  });

  // The probe projection carries the read-site verdict VERBATIM — the three-way
  // available/missing/unreadable classification lives in machine-probe's
  // readObservedCodexHookConfig (refine-verify: an earlier draft re-split the errno
  // here and disagreed with the live report about the same EACCES machine). A null
  // report projects to NULL (omit the optional field — nothing was observed), never
  // to a fabricated 'unreadable' read failure.
  it('projects the hook-state observation verbatim, and null input to null (S8a5)', () => {
    deepStrictEqual(
      projectCodexHookStateForProbe({ config_status: 'available', disabled_handlers: [] }),
      { observation: 'available', disabled_expected: [] },
    );
    deepStrictEqual(
      projectCodexHookStateForProbe({ config_status: 'missing', disabled_handlers: [] }),
      { observation: 'missing', disabled_expected: [] },
    );
    deepStrictEqual(
      projectCodexHookStateForProbe({ config_status: 'unreadable', disabled_handlers: [] }),
      { observation: 'unreadable', disabled_expected: [] },
    );
    // An unknown legacy status maps to the conservative "state unknown" verdict.
    deepStrictEqual(
      projectCodexHookStateForProbe({ config_status: 'weird', disabled_handlers: [] }).observation,
      'unreadable',
    );
    strictEqual(projectCodexHookStateForProbe(null), null);
    strictEqual(projectCodexHookStateForProbe(undefined), null);
    // The shared gate treats an ABSENT report as an unavailable trust store — zero
    // evidence must gate exactly like an unobservable config, never pass (the
    // truthiness-guard form skipped both gates on null and returned current).
    strictEqual(evaluateCodexHookStateGate(null).blocked, true);
    strictEqual(evaluateCodexHookStateGate(null).reason, 'hook_state_unavailable');
    strictEqual(evaluateCodexHookStateGate({ config_status: 'available', summary: { disabled_handlers: 0, expected: 6 } }).blocked, false);
  });

  // Stale `[hooks.state]` rows whose coordinates no longer exist in the current hooks
  // file (the plugin removed a handler after the operator disabled it) COUNT as
  // disabled evidence — deliberately fail-closed: the aggregation matches on
  // (plugin, path, event) and does not confirm group/hook indexes against the file,
  // because runtime cannot query which coordinates current Codex still honors
  // (ADR-0030 — trust state is not queryable non-interactively). The operator
  // recovery is /hooks review, which rewrites the plugin's rows. Quarantining orphan
  // coordinates instead needs empirical evidence of Codex's stale-row cleanup
  // behavior — recorded as a follow-up trigger, not guessed here.
  it('counts a disabled row for a REMOVED handler coordinate (orphan index) as disabled evidence — fail-closed (S8a5)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-orphan-index-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-orphan-index-home-'));
    await seedRepo(root); // engineer Stop has exactly ONE handler (0:0)
    await writeTrustedCodexHookStateConfig(home, 'hooks/hooks.json', {
      extraLines: [
        // A row for a handler index the current hooks.json does not define.
        '[hooks.state."engineer@agentic-plugins:hooks/hooks.json:stop:0:9"]',
        'enabled = false',
        'trusted_hash = "sha256:orphan"',
        '',
      ],
    });

    const report = await runDoctor({ repoRoot: root, homeDir: home, runner: fakeRunner(defaultRuntimeProbeMap()) });
    const hookState = report.codex_plugin_hooks.hook_state;
    strictEqual(hookState.summary.disabled_handlers, 1, 'the orphan row still surfaces as disabled evidence');
    deepStrictEqual(hookState.disabled_handlers[0].hook_index, '9');
    ok(report.codex_plugin_hooks.recommendations.some((rec) => rec.action === 'enable-codex-hook-state'),
      'the operator is pointed at /hooks, whose review rewrites the stale rows');
  });

  // The plugin-grain twin of the per-handler gate (S8a5 refine-verify, peer finding):
  // the S8a4 version authority says a Codex-DISABLED plugin is not attestable, but the
  // mirror consumed only its `.version` — so a disabled plugin with a matching version
  // read `current` here while the completion reducer staled the same machine on plugin
  // state. The attestable verdict is now consumed.
  it('stales attestation currency for a Codex-DISABLED bundled hook plugin (plugin_not_attestable, S8a5)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-attest-disabled-plugin-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-attest-disabled-plugin-home-'));
    await seedRepo(root);
    await writeTrustedCodexHookStateConfig(home);
    const runId = 'settings-20260718T020000Z-a5f003';
    await mkdir(join(root, '.agentic-plugins', 'runs', 'settings', runId), { recursive: true });
    await writeJson(join(root, '.agentic-plugins', 'runs', 'settings', runId, 'settings.json'), {
      schema_version: 'runtime-settings-execution-artifact-1.3',
      run_id: runId,
      status: 'recorded',
      created_at: '2026-07-18T02:00:00.000Z',
      codex_hook_review: {
        mode: 'operator-attestation',
        requested: true,
        attested: true,
        status: 'attested',
        host: 'codex',
        command: '/hooks',
        attested_at: '2026-07-18T02:00:00.000Z',
        bundled_plugins: ['engineer', 'orchestrator'],
        attested_plugins: ['engineer', 'orchestrator'],
        plugin_versions: { engineer: '0.7.0', orchestrator: '0.7.0' },
        bound_versions: { codex: '0.130.0', plugins: { codex: { engineer: '0.7.0', orchestrator: '0.7.0' } } },
      },
    });

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
        // The Codex list — the S8a4 authority — reports engineer installed at the
        // attested version but DISABLED; orchestrator enabled at the attested version.
        'codex plugin list --json': okResult(JSON.stringify({ installed: [
          { name: 'engineer', marketplaceName: 'agentic-plugins', version: '0.7.0', installed: true, enabled: false },
          { name: 'orchestrator', marketplaceName: 'agentic-plugins', version: '0.7.0', installed: true, enabled: true },
        ] })),
      }),
    });

    strictEqual(report.settings_runs.codex_hook_review.current, false);
    strictEqual(report.settings_runs.codex_hook_review.currency_reason, 'plugin_not_attestable');
    ok(report.plugin_command_surface.manual_followups.some((entry) => entry.id === 'codex-hook-review'),
      'a disabled hook plugin re-opens the re-review follow-up');
  });

  // The machine-probe read-site classification: a config.toml that EXISTS but cannot
  // be read as text (here: it is a directory — EISDIR) is `unreadable`, not `missing`
  // — the operator recovery is "fix the file", not "trust hooks for the first time".
  it('classifies an unreadable Codex config as config=unreadable and stales currency on it (S8a5)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-state-unreadable-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-state-unreadable-home-'));
    await seedRepo(root);
    await mkdir(join(home, '.codex', 'config.toml'), { recursive: true }); // a DIRECTORY at the config path

    const report = await runDoctor({ repoRoot: root, homeDir: home, runner: fakeRunner(defaultRuntimeProbeMap()) });
    strictEqual(report.codex_plugin_hooks.hook_state.config_status, 'unreadable');
    ok(formatText(report).includes('hook-state: config=unreadable'));
    deepStrictEqual(
      projectCodexHookStateForProbe(report.codex_plugin_hooks.hook_state).observation,
      'unreadable',
      'the persisted observation carries the same read-site verdict the live report shows',
    );
  });

  it('stales an otherwise-current attestation when no hook-state config exists — trust is recorded there (S8a5)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-state-absent-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-state-absent-home-'));
    await seedRepo(root);
    await seedCodexInstallCache(home, 'engineer', '1.0.0');
    await seedCodexInstallCache(home, 'orchestrator', '1.0.0');
    // NO ~/.codex/config.toml at all: the machine carries an attestation claiming
    // reviewed/trusted hooks, but the config trust writes to does not exist.
    const runId = 'settings-20260718T010000Z-a5f002';
    await mkdir(join(root, '.agentic-plugins', 'runs', 'settings', runId), { recursive: true });
    await writeJson(join(root, '.agentic-plugins', 'runs', 'settings', runId, 'settings.json'), {
      schema_version: 'runtime-settings-execution-artifact-1.3',
      run_id: runId,
      status: 'recorded',
      created_at: '2026-07-18T01:00:00.000Z',
      codex_hook_review: {
        mode: 'operator-attestation',
        requested: true,
        attested: true,
        status: 'attested',
        host: 'codex',
        command: '/hooks',
        attested_at: '2026-07-18T01:00:00.000Z',
        bundled_plugins: ['engineer', 'orchestrator'],
        attested_plugins: ['engineer', 'orchestrator'],
        plugin_versions: { engineer: '1.0.0', orchestrator: '1.0.0' },
        bound_versions: { codex: '0.130.0', plugins: { codex: { engineer: '1.0.0', orchestrator: '1.0.0' } } },
      },
    });

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
      }),
    });

    strictEqual(report.codex_plugin_hooks.hook_state.config_status, 'missing', 'premise: no config observed');
    strictEqual(report.settings_runs.codex_hook_review.current, false);
    strictEqual(report.settings_runs.codex_hook_review.currency_reason, 'hook_state_unavailable');
    ok(report.plugin_command_surface.manual_followups.some((entry) => entry.id === 'codex-hook-review'),
      'the re-review follow-up re-opens when the trust store is gone');
  });

  it('reports Codex hook command portability warnings when hook commands still point at Claude adapter paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-command-warning-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    await writeJson(join(root, 'plugins', 'engineer', 'hooks', 'hooks.json'), {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/adapters/claude/hooks/stop.mjs"' }] }],
      },
    });

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
      }),
    });

    deepStrictEqual(report.codex_plugin_hooks.summary.command_warning_plugins, ['engineer']);
    deepStrictEqual(report.codex_plugin_hooks.summary.bare_node_command_plugins, ['engineer']);
    deepStrictEqual(report.codex_plugin_hooks.summary.claude_root_command_plugins, ['engineer']);
    deepStrictEqual(report.codex_plugin_hooks.summary.claude_adapter_command_plugins, ['engineer']);
    ok(report.codex_plugin_hooks.recommendations.some((rec) => rec.action === 'verify-codex-hook-command-portability'));
    ok(report.host_parity.differences.some((issue) => issue.id === 'codex_plugin_hooks_command_portability_unverified'));
    ok(formatText(report).includes('command-warnings=engineer'));
  });

  it('does not warn when Codex hook commands use compatibility root aliases with Codex adapter paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-command-alias-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    await writeJson(join(root, 'plugins', 'engineer', 'hooks', 'hooks.json'), {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '/bin/sh "${CLAUDE_PLUGIN_ROOT}/adapters/codex/hooks/run-node-hook.sh" "${CLAUDE_PLUGIN_ROOT}/adapters/codex/hooks/stop.mjs"' }] }],
      },
    });

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
      }),
    });

    deepStrictEqual(report.codex_plugin_hooks.summary.claude_root_command_plugins, ['engineer']);
    ok(!report.codex_plugin_hooks.summary.command_warning_plugins.includes('engineer'));
    ok(!report.codex_plugin_hooks.recommendations.some((rec) => rec.action === 'verify-codex-hook-command-portability'));
    ok(!report.host_parity.differences.some((issue) => issue.id === 'codex_plugin_hooks_command_portability_unverified'));
  });

  it('checks the manifest-declared Codex hook file instead of the Claude default hooks file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-manifest-path-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    await writeJson(join(root, 'plugins', 'engineer', '.codex-plugin', 'plugin.json'), {
      name: 'engineer',
      version: '1.0.0',
      description: 'engineer plugin',
      hooks: './adapters/codex/hooks/hooks.json',
    });
    await writeJson(join(root, 'plugins', 'engineer', 'hooks', 'hooks.json'), {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/adapters/claude/hooks/stop.mjs"' }] }],
      },
    });
    await mkdir(join(root, 'plugins', 'engineer', 'adapters', 'codex', 'hooks'), { recursive: true });
    await writeJson(join(root, 'plugins', 'engineer', 'adapters', 'codex', 'hooks', 'hooks.json'), {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '/bin/sh "${PLUGIN_ROOT}/adapters/codex/hooks/run-node-hook.sh" "${PLUGIN_ROOT}/adapters/codex/hooks/stop.mjs"' }] }],
      },
    });

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
      }),
    });

    strictEqual(report.codex_plugin_hooks.plugin_entries.engineer.source.status, 'exposed');
    ok(report.codex_plugin_hooks.plugin_entries.engineer.source.hooks_file.path.endsWith('adapters/codex/hooks/hooks.json'));
    ok(!report.codex_plugin_hooks.summary.command_warning_plugins.includes('engineer'));
    ok(!report.host_parity.differences.some((issue) => issue.id === 'codex_plugin_hooks_command_portability_unverified'));
  });

  it('accepts a current Codex hook review attestation artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-review-attested-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    // The plugins must be Codex-installed at the attested versions for the currency mirror
    // to read them current (list-authoritative, S8a4 §SCOPE-2) — a source-only match no longer counts.
    await seedCodexInstallCache(home, 'engineer', '1.0.0');
    await seedCodexInstallCache(home, 'orchestrator', '1.0.0');
    // A current attestation also requires the hook-state config trust writes to exist
    // (S8a5 hook_state_unavailable gate) with no explicitly disabled handler.
    await writeTrustedCodexHookStateConfig(home);
    const runId = 'settings-20260513T000000Z-abcdef';
    await mkdir(join(root, '.agentic-plugins', 'runs', 'settings', runId), { recursive: true });
    await writeJson(join(root, '.agentic-plugins', 'runs', 'settings', runId, 'settings.json'), {
      schema_version: 'runtime-settings-execution-artifact-1.0',
      runtime_version: RUNTIME_VERSION,
      run_id: runId,
      status: 'completed',
      created_at: '2026-05-13T00:00:00.000Z',
      updated_at: '2026-05-13T00:00:05.000Z',
      plugin_management: {
        mode: 'dry-run-plan',
        requested: false,
        executed: false,
        host_filter: 'all',
        summary: {
          executed: 0,
          failed: 0,
          failed_retryable: 0,
          failed_non_retryable: 0,
        },
      },
      plugin_cleanup: {
        mode: 'dry-run-plan',
        requested: false,
        executed: false,
        summary: {
          executed: 0,
          failed: 0,
          blocked: 0,
          failed_retryable: 0,
          failed_non_retryable: 0,
        },
      },
      codex_hook_review: {
        mode: 'operator-attestation',
        requested: true,
        attested: true,
        status: 'attested',
        host: 'codex',
        command: '/hooks',
        attested_at: '2026-05-13T00:00:05.000Z',
        bundled_plugins: ['engineer', 'orchestrator'],
        manifest_exposed_plugins: ['engineer', 'orchestrator'],
        attested_plugins: ['engineer', 'orchestrator'],
        plugin_versions: {
          engineer: '1.0.0',
          orchestrator: '1.0.0',
        },
        // Canonical binding matching the default probe (codex-cli 0.130.0) and the
        // Codex-installed caches seeded below — currency is now list-authoritative.
        bound_versions: { codex: '0.130.0', plugins: { codex: { engineer: '1.0.0', orchestrator: '1.0.0' } } },
        plugin_hooks_enabled: true,
        plugin_hooks_stage: 'under development',
      },
      failures: [],
    });

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
      }),
    });

    strictEqual(report.plugin_command_surface.manual_followups.find((entry) => entry.id === 'codex-hook-review'), undefined);
    strictEqual(report.settings_runs.codex_hook_review.status, 'attested');
    strictEqual(report.settings_runs.codex_hook_review.current, true);
    strictEqual(report.settings_runs.codex_hook_review.currency_reason, null);
    strictEqual(report.settings_runs.codex_hook_review.latest.run_id, runId);
    // Canonical fields survive the summary projection (S8a4-3): the mirror reads them.
    deepStrictEqual(report.settings_runs.codex_hook_review.latest.attested_plugins, ['engineer', 'orchestrator']);
    strictEqual(report.settings_runs.codex_hook_review.latest.bound_versions.codex, '0.130.0');
    deepStrictEqual(report.settings_runs.codex_hook_review.latest.bound_versions.plugins.codex, { engineer: '1.0.0', orchestrator: '1.0.0' });
    // artifact_hash is the sha256 of the EXACT settings.json bytes, not a reconstruction.
    const rawArtifactBytes = await readFile(join(root, '.agentic-plugins', 'runs', 'settings', runId, 'settings.json'), 'utf8');
    strictEqual(report.settings_runs.codex_hook_review.latest.artifact_hash, createHash('sha256').update(rawArtifactBytes).digest('hex'));
    ok(report.experience_parity.criteria.some((entry) => entry.id === 'lifecycle_hook_continuity' && entry.status === 'satisfied'));
    ok(formatText(report).includes('latest-codex-hook-review: status=attested'));
  });

  it('stales a /hooks attestation when only the Codex CLI version moves (version-bound trust, S8a4-3)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-cli-drift-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-cli-drift-home-'));
    await seedRepo(root);
    // Plugins ARE installed and match; ONLY the Codex CLI version differs from the bound
    // one — the dimension the pre-S8a4 mirror was blind to (the dead pipe). The trusted
    // hook-state config exists so the S8a5 evidence gates cannot be the cause either.
    await seedCodexInstallCache(home, 'engineer', '1.0.0');
    await seedCodexInstallCache(home, 'orchestrator', '1.0.0');
    await writeTrustedCodexHookStateConfig(home);
    const runId = 'settings-20260713T000000Z-c11001';
    await mkdir(join(root, '.agentic-plugins', 'runs', 'settings', runId), { recursive: true });
    await writeJson(join(root, '.agentic-plugins', 'runs', 'settings', runId, 'settings.json'), {
      schema_version: 'runtime-settings-execution-artifact-1.3',
      run_id: runId,
      status: 'recorded',
      created_at: '2026-07-13T00:00:00.000Z',
      codex_hook_review: {
        mode: 'operator-attestation',
        requested: true,
        attested: true,
        status: 'attested',
        host: 'codex',
        command: '/hooks',
        attested_at: '2026-07-13T00:00:00.000Z',
        bundled_plugins: ['engineer', 'orchestrator'],
        attested_plugins: ['engineer', 'orchestrator'],
        plugin_versions: { engineer: '1.0.0', orchestrator: '1.0.0' },
        // Attested against codex-cli 0.99.0; the machine below reports 0.130.0.
        bound_versions: { codex: '0.99.0', plugins: { codex: { engineer: '1.0.0', orchestrator: '1.0.0' } } },
      },
    });

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(), // codex-cli 0.130.0
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
      }),
    });

    strictEqual(report.codex_plugin_hooks.status, 'ready', 'precondition: hook surface ready');
    strictEqual(report.settings_runs.codex_hook_review.status, 'stale');
    strictEqual(report.settings_runs.codex_hook_review.current, false);
    strictEqual(report.settings_runs.codex_hook_review.currency_reason, 'codex_cli_version_changed');
    // The operator is told to re-review — and the two doctor surfaces AGREE (§SCOPE-3).
    ok(report.plugin_command_surface.manual_followups.some((entry) => entry.id === 'codex-hook-review'), 'a Codex CLI upgrade re-opens the re-review follow-up');
    ok(formatText(report).includes('currency-reason=codex_cli_version_changed'));
    ok(!formatText(report).includes('latest-codex-hook-review: status=attested'), 'a stale attestation must never render as attested');
  });

  it('stales a legacy attestation carrying no bound_versions (never silently current, S8a4-3)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-legacy-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-legacy-home-'));
    await seedRepo(root);
    await seedCodexInstallCache(home, 'engineer', '1.0.0');
    await seedCodexInstallCache(home, 'orchestrator', '1.0.0');
    // Trusted hook-state config present, so the legacy record's missing bound_versions —
    // not an S8a5 evidence gate — is what stales it.
    await writeTrustedCodexHookStateConfig(home);
    const runId = 'settings-20260713T010000Z-1e6ac0';
    await mkdir(join(root, '.agentic-plugins', 'runs', 'settings', runId), { recursive: true });
    await writeJson(join(root, '.agentic-plugins', 'runs', 'settings', runId, 'settings.json'), {
      schema_version: 'runtime-settings-execution-artifact-1.2', // pre-S8a4 artifact
      run_id: runId,
      status: 'recorded',
      created_at: '2026-07-13T01:00:00.000Z',
      codex_hook_review: {
        mode: 'attest',
        requested: true,
        attested: true,
        status: 'attested',
        host: 'codex',
        command: '/hooks',
        attested_at: '2026-07-13T01:00:00.000Z',
        bundled_plugins: ['engineer', 'orchestrator'],
        plugin_versions: { engineer: '1.0.0', orchestrator: '1.0.0' },
        // NO bound_versions / attested_plugins — the pre-S8a4 dead-pipe shape.
      },
    });

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
      }),
    });

    strictEqual(report.settings_runs.codex_hook_review.status, 'stale');
    strictEqual(report.settings_runs.codex_hook_review.currency_reason, 'codex_cli_version_changed');
    ok(report.plugin_command_surface.manual_followups.some((entry) => entry.id === 'codex-hook-review'), 'a legacy attestation is re-review-required until re-recorded');
  });

  it('classifies nonzero Claude auth JSON as unauthenticated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-claude-auth-json-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      env: {},
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'claude auth status': {
          ok: false,
          exit_code: 1,
          stdout: JSON.stringify({
            loggedIn: false,
            authMethod: 'none',
            apiProvider: 'firstParty',
            email: 'person@example.com',
            orgId: '11111111-2222-3333-4444-555555555555',
            orgName: 'private org',
          }),
          stderr: '',
          error_code: null,
          timed_out: false,
        },
      }),
    });

    strictEqual(report.clis.claude.auth.status, 'unauthenticated');
    strictEqual(report.clis.claude.auth.logged_in, false);
    strictEqual(report.readiness_matrix.hosts.claude.authenticated.status, 'unauthenticated');
    ok(formatText(report).includes('authenticated=unauthenticated'));
    const serialized = JSON.stringify(report);
    ok(!serialized.includes('person@example.com'), 'email must be redacted from nonzero auth JSON');
    ok(!serialized.includes('11111111-2222-3333-4444-555555555555'), 'org id must be redacted from nonzero auth JSON');
  });

  it('classifies Claude auth false inside Codex sandbox as sandbox-limited', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-claude-auth-sandbox-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      env: { CODEX_SANDBOX: 'seatbelt' },
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'claude auth status': {
          ok: false,
          exit_code: 1,
          stdout: JSON.stringify({
            loggedIn: false,
            authMethod: 'none',
            apiProvider: 'firstParty',
            email: 'person@example.com',
            orgId: '11111111-2222-3333-4444-555555555555',
            orgName: 'private org',
          }),
          stderr: '',
          error_code: null,
          timed_out: false,
        },
      }),
    });

    strictEqual(report.clis.claude.auth.status, 'sandbox_limited');
    strictEqual(report.clis.claude.auth.logged_in, null);
    strictEqual(report.readiness_matrix.hosts.claude.authenticated.status, 'sandbox_limited');
    ok(report.readiness.codex_to_claude.blockers.some((blocker) => blocker.includes('sandbox-limited')));
    ok(formatText(report).includes('auth=sandbox_limited'));
    const serialized = JSON.stringify(report);
    ok(!serialized.includes('person@example.com'), 'email must be redacted from sandbox-limited auth JSON');
    ok(!serialized.includes('11111111-2222-3333-4444-555555555555'), 'org id must be redacted from sandbox-limited auth JSON');
  });

  it('reports stale retired Claude plugin entries as host parity issues', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-retired-plugin-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'claude plugin list': okResult([
          'Installed plugins:',
          '',
          '  > research@agentic-plugins',
          '    Version: 0.1.0',
          '    Scope: user',
          '    Status: failed',
          '    Error: retired plugin failed to load',
          '',
        ].join('\n')),
      }),
    });

    ok(report.host_parity.issues.some((issue) => issue.id === 'claude_retired_or_unknown_plugin' && issue.plugin === 'research'));
    ok(report.plugin_command_surface.manual_followups.some((followup) => (
      followup.id === 'claude-retired-plugin-cleanup'
        && followup.commands.includes('claude plugin uninstall research@agentic-plugins')
    )));
    strictEqual(report.host_parity.status, 'warning');
    ok(formatText(report).includes('command: claude plugin uninstall research@agentic-plugins'));
    ok(formatText(report).includes('claude_retired_or_unknown_plugin'));
  });

  it('distinguishes missing CLIs as unavailable and fails overall', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-missing-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({}),
    });
    strictEqual(report.clis.claude.status, 'unavailable');
    strictEqual(report.clis.codex.status, 'unavailable');
    strictEqual(report.overall.status, 'fail');
  });

  it('recognizes installed cache state even when a consumer repo has no plugin source tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-consumer-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedHome(home);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({}),
    });
    strictEqual(report.plugins.runtime.source.present, false);
    strictEqual(report.plugins.runtime.cache.codex.status, 'available');
    strictEqual(report.plugins.runtime.status, 'available');
  });

  it('does not treat Codex temporary marketplace cache as plugin installation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-marketplace-only-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedCodexTmpMarketplace(home);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({}),
    });
    strictEqual(report.plugins.runtime.source.present, false);
    strictEqual(report.plugins.runtime.cache.codex.status, 'missing');
    strictEqual(report.plugins.runtime.cache.codex_tmp_marketplace.status, 'available');
    strictEqual(report.plugins.runtime.status, 'not_installed');
    strictEqual(report.readiness_matrix.hosts.codex.installed.status, 'marketplace_cache_only');
    strictEqual(report.readiness_matrix.hosts.codex.installed.materialization.status, 'manual_session_refresh');
    strictEqual(report.plugin_command_surface.codex.materialization.status, 'manual_session_refresh');
    ok(/not installation evidence/i.test(report.readiness_matrix.hosts.codex.installed.evidence));
    ok(report.host_parity.differences.some((issue) => issue.id === 'codex_plugin_cache_materialization_manual'));
  });

  it('surfaces Codex marketplace-cache-only materialization even when repo source is available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-source-plus-marketplace-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    await seedCodexTmpMarketplace(home);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner(defaultRuntimeProbeMap()),
    });

    strictEqual(report.readiness_matrix.hosts.codex.installed.status, 'source_available');
    strictEqual(report.readiness_matrix.hosts.codex.installed.materialization.status, 'manual_session_refresh');
    strictEqual(report.readiness_matrix.hosts.codex.installed.materialization.marketplace_cache_version, '0.1.0');
    ok(report.host_parity.differences.some((issue) => issue.id === 'codex_plugin_cache_materialization_manual'));
  });

  it('flags malformed non-terminal peer-run handles as blocked ledger health', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-bad-ledger-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await mkdir(join(root, '.claude', 'agentic-engineer', 'peer-runs', 'bad-run'), { recursive: true });
    await writeJson(join(root, '.claude', 'agentic-engineer', 'peer-runs', 'bad-run', 'handle.json'), {
      run_id: 'bad-run',
      plugin: 'engineer',
      status: 'running',
    });
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({}),
    });
    strictEqual(report.ledgers.engineer.peer_runs.status, 'blocked');
    strictEqual(report.ledgers.engineer.peer_runs.malformed, 1);
    ok(report.ledgers.engineer.peer_runs.runs[0].issues.includes('non-terminal run missing valid updated_at'));
  });

  it('reports canonical workflow storage when state already lives under .agentic-plugins/state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-canonical-ledger-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await mkdir(join(root, '.agentic-plugins', 'state', 'engineer', 'workflows'), { recursive: true });
    await writeWorkflow(join(root, '.agentic-plugins', 'state', 'engineer', 'workflows', 'compose-20260513T000000Z-abcdef.md'), 'feat/canonical');

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({}),
    });

    strictEqual(report.ledgers.engineer.storage.status, 'canonical');
    strictEqual(report.ledgers.engineer.storage.selected_home, 'canonical');
    strictEqual(report.ledgers.engineer.workflows.count, 1);
    strictEqual(report.ledgers.engineer.homes.legacy.workflows.count, 0);
    ok(formatText(report).includes('storage=canonical'));
  });

  it('reports ambiguous storage when canonical and legacy homes share a workflow branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-ambiguous-ledger-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await mkdir(join(root, '.agentic-plugins', 'state', 'engineer', 'workflows'), { recursive: true });
    await mkdir(join(root, '.claude', 'agentic-engineer', 'workflows'), { recursive: true });
    await writeWorkflow(join(root, '.agentic-plugins', 'state', 'engineer', 'workflows', 'compose-20260513T000000Z-aaaaaa.md'), 'feat/shared');
    await writeWorkflow(join(root, '.claude', 'agentic-engineer', 'workflows', 'compose-20260513T000001Z-bbbbbb.md'), 'feat/shared');

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({}),
    });

    strictEqual(report.ledgers.engineer.storage.status, 'ambiguous');
    strictEqual(report.ledgers.engineer.storage.selected_home, 'canonical');
    deepStrictEqual(report.ledgers.engineer.storage.overlapping_branches, ['feat/shared']);
  });

  it('summarizes latest settings execution artifact failures with retry classification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-settings-artifact-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const runId = 'settings-20260513T000000Z-abcdef';
    await mkdir(join(root, '.agentic-plugins', 'runs', 'settings', runId), { recursive: true });
    await writeJson(join(root, '.agentic-plugins', 'runs', 'settings', runId, 'settings.json'), {
      schema_version: 'runtime-settings-execution-artifact-1.0',
      runtime_version: RUNTIME_VERSION,
      run_id: runId,
      status: 'failed',
      created_at: '2026-05-13T00:00:00.000Z',
      updated_at: '2026-05-13T00:00:05.000Z',
      plugin_management: {
        mode: 'explicit-plugin-management-executor',
        requested: true,
        executed: true,
        host_filter: 'codex',
        summary: {
          executed: 0,
          failed: 1,
          failed_retryable: 1,
          failed_non_retryable: 0,
        },
      },
      failures: [{
        id: 'runtime:codex:add-marketplace',
        plugin: 'runtime',
        host: 'codex',
        action: 'add-marketplace',
        failure_type: 'network',
        retryable: true,
        retry_after: 'retry after network or registry connectivity recovers',
        doctor_hint: 'runtime:doctor can re-check host CLI and plugin surface availability',
      }],
    });

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner(defaultRuntimeProbeMap()),
    });

    strictEqual(report.settings_runs.status, 'needs_attention');
    strictEqual(report.settings_runs.latest.run_id, runId);
    strictEqual(report.settings_runs.latest.plugin_management.failed, 1);
    strictEqual(report.settings_runs.latest.plugin_management.summary.failed_retryable, 1);
    strictEqual(report.settings_runs.latest.plugin_management.failures[0].failure_type, 'network');
    strictEqual(report.settings_runs.latest.plugin_management.failures[0].retryable, true);
    ok(report.overall.warnings.includes('latest settings plugin-management execution has failures'));
    ok(formatText(report).includes('Settings Execution Artifacts'));
    ok(formatText(report).includes('retryable-failed=1'));
  });

  it('treats a nonterminal (in-progress) settings execution record as NOT available (§1.5 #27)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-settings-nonterminal-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-settings-nonterminal-home-'));
    const runId = 'settings-20260513T000000Z-abcdef';
    await mkdir(join(root, '.agentic-plugins', 'runs', 'settings', runId), { recursive: true });
    // A write-ahead record interrupted mid-run: ZERO failures precisely because it
    // has not finished. Pre-migration a zero-failure record read as 'available' —
    // this pin stops the write-ahead fix from becoming a false-success bug.
    await writeJson(join(root, '.agentic-plugins', 'runs', 'settings', runId, 'settings.json'), {
      schema_version: 'runtime-settings-execution-artifact-1.2',
      runtime_version: RUNTIME_VERSION,
      run_id: runId,
      status: 'in-progress',
      terminal: false,
      plan_hash: 'b'.repeat(64),
      planned_actions: [{ area: 'plugin-management', host: 'codex', action: 'add-marketplace', command: 'codex', args: ['plugin', 'marketplace', 'add', 'each4all/agentic-plugins'] }],
      journal: [],
      created_at: '2026-05-13T00:00:00.000Z',
      updated_at: '2026-05-13T00:00:01.000Z',
      plugin_management: { mode: 'explicit-plugin-management-executor', requested: true, executed: true, host_filter: 'codex', summary: { executed: 0, failed: 0, blocked: 0, failed_retryable: 0, failed_non_retryable: 0 } },
      plugin_cleanup: { mode: null, requested: false, executed: false, summary: { executed: 0, failed: 0, blocked: 0, failed_retryable: 0, failed_non_retryable: 0 } },
      codex_hook_review: { requested: false, attested: false, status: 'not_recorded' },
      failures: [],
    });

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner(defaultRuntimeProbeMap()),
    });

    strictEqual(report.settings_runs.status, 'needs_attention');
    strictEqual(report.settings_runs.interrupted, true);
    strictEqual(report.settings_runs.latest.status, 'in-progress');
    strictEqual(report.settings_runs.latest.terminal, false);
    ok(report.settings_runs.recovery && report.settings_runs.recovery.includes('interrupted'));
    ok(report.overall.warnings.includes('latest settings execution is a nonterminal/refused write-ahead record (interrupted run)'));
    ok(formatText(report).includes('interrupted'));
  });

  it('summarizes latest settings cleanup artifact failures separately', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-settings-cleanup-artifact-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const runId = 'settings-20260513T000000Z-abcdef';
    await mkdir(join(root, '.agentic-plugins', 'runs', 'settings', runId), { recursive: true });
    await writeJson(join(root, '.agentic-plugins', 'runs', 'settings', runId, 'settings.json'), {
      schema_version: 'runtime-settings-execution-artifact-1.0',
      runtime_version: RUNTIME_VERSION,
      run_id: runId,
      status: 'failed',
      created_at: '2026-05-13T00:00:00.000Z',
      updated_at: '2026-05-13T00:00:05.000Z',
      plugin_management: {
        mode: 'dry-run-plan',
        requested: false,
        executed: false,
        host_filter: 'all',
        summary: {
          executed: 0,
          failed: 0,
          failed_retryable: 0,
          failed_non_retryable: 0,
        },
      },
      plugin_cleanup: {
        mode: 'explicit-plugin-cleanup-executor',
        requested: true,
        executed: true,
        summary: {
          executed: 0,
          failed: 1,
          blocked: 0,
          failed_retryable: 0,
          failed_non_retryable: 1,
        },
      },
      failures: [{
        id: 'research:claude:uninstall-retired-plugin',
        area: 'plugin-cleanup',
        plugin: 'research',
        host: 'claude',
        action: 'uninstall-retired-plugin',
        failure_type: 'host_command_failed',
        retryable: false,
        retry_after: 'inspect the host-native plugin command outside runtime:settings before retrying',
        doctor_hint: 'runtime:doctor reports retired or unknown plugin cleanup follow-ups',
      }],
    });

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner(defaultRuntimeProbeMap()),
    });

    strictEqual(report.settings_runs.status, 'needs_attention');
    strictEqual(report.settings_runs.latest.plugin_management.failed, 0);
    strictEqual(report.settings_runs.latest.plugin_cleanup.failed, 1);
    strictEqual(report.settings_runs.latest.plugin_cleanup.summary.failed_non_retryable, 1);
    strictEqual(report.settings_runs.latest.plugin_cleanup.failures[0].failure_type, 'host_command_failed');
    strictEqual(report.settings_runs.latest.plugin_cleanup.failures[0].retryable, false);
    ok(report.overall.warnings.includes('latest settings plugin-cleanup execution has failures'));
    ok(formatText(report).includes('plugin-cleanup: mode=explicit-plugin-cleanup-executor'));
    ok(formatText(report).includes('cleanup-failure: research/claude uninstall-retired-plugin'));
  });

  it('summarizes latest consensus execution artifact without raw peer output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-consensus-artifact-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const runId = 'consensus-20260513T000000Z-abcdef';
    await mkdir(join(root, '.agentic-plugins', 'runs', 'consensus', runId), { recursive: true });
    await writeJson(join(root, '.agentic-plugins', 'runs', 'consensus', runId, 'execution.json'), {
      schema_version: 'runtime-consensus-execution-1.0',
      runtime_version: RUNTIME_VERSION,
      run_id: runId,
      status: 'failed',
      updated_at: '2026-05-13T00:00:05.000Z',
      round: 1,
      peer_execution: true,
      summary: {
        executed: 1,
        passed: 0,
        failed: 1,
        failed_retryable: 0,
        failed_non_retryable: 1,
      },
      failures: [{
        peer: 'claude',
        status: 'permission_failed',
        failure_type: 'permission_denied',
        retryable: false,
        retry_after: 'retry only after resolving host permission or sandbox policy outside runtime:consensus',
        raw_output: {
          pointer: '.agentic-plugins/runs/consensus/consensus-20260513T000000Z-abcdef/rounds/round-1/raw/claude.txt',
          bytes: 24,
          sha256: 'abc123',
        },
      }],
    });
    await writeJson(join(root, '.agentic-plugins', 'runs', 'consensus', 'latest.json'), {
      schema_version: 'runtime-consensus-execution-latest-1.0',
      runtime_version: RUNTIME_VERSION,
      run_id: runId,
      status: 'failed',
      updated_at: '2026-05-13T00:00:05.000Z',
      round: 1,
      execution_pointer: `.agentic-plugins/runs/consensus/${runId}/execution.json`,
      summary: {
        executed: 1,
        passed: 0,
        failed: 1,
        failed_retryable: 0,
        failed_non_retryable: 1,
      },
    });

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner(defaultRuntimeProbeMap()),
    });

    strictEqual(report.consensus_runs.status, 'needs_attention');
    strictEqual(report.consensus_runs.latest.run_id, runId);
    strictEqual(report.consensus_runs.latest.summary.failed_non_retryable, 1);
    strictEqual(report.consensus_runs.latest.failures[0].failure_type, 'permission_denied');
    ok(report.overall.warnings.includes('latest consensus execution has failures'));
    ok(formatText(report).includes('Consensus Execution Artifacts'));
    ok(formatText(report).includes('non-retryable-failed=1'));
    ok(!JSON.stringify(report).includes('RAW PEER OUTPUT'), 'doctor must not read or print raw peer output');
  });

  it('warns specifically when the latest consensus execution timed out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-consensus-timeout-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const runId = 'consensus-20260513T000000Z-abcdef';
    await mkdir(join(root, '.agentic-plugins', 'runs', 'consensus', runId), { recursive: true });
    await writeJson(join(root, '.agentic-plugins', 'runs', 'consensus', runId, 'execution.json'), {
      schema_version: 'runtime-consensus-execution-1.0',
      runtime_version: RUNTIME_VERSION,
      run_id: runId,
      status: 'failed',
      updated_at: '2026-05-13T00:00:05.000Z',
      round: 1,
      peer_execution: true,
      progress_pointer: `.agentic-plugins/runs/consensus/${runId}/execution-progress.json`,
      summary: {
        executed: 2,
        passed: 0,
        failed: 2,
        skipped: 0,
        failed_retryable: 2,
        failed_non_retryable: 0,
      },
      failures: ['claude', 'codex'].map((peer) => ({
        peer,
        status: 'timed_out',
        failure_type: 'timeout',
        retryable: true,
        retry_after: 'retry with a larger --timeout-ms within the policy cap; run runtime:doctor --deep-peer-smoke --execute-deep-peer-smoke when prompt startup latency is unclear',
        raw_output: {
          pointer: `.agentic-plugins/runs/consensus/${runId}/rounds/round-1/raw/${peer}.txt`,
          bytes: 0,
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
      })),
    });

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner(defaultRuntimeProbeMap()),
    });

    strictEqual(report.consensus_runs.latest.failure_summary.timeout, 2);
    ok(report.overall.warnings.includes('latest consensus execution timed out for 2 peer(s); retryable-failed=2'));
    ok(formatText(report).includes('failure-summary: timeout=2'));
    ok(formatText(report).includes('warning: latest consensus execution timed out for 2 peer(s); retryable-failed=2'));
    ok(formatText(report).includes('progress='));
    ok(!JSON.stringify(report).includes('TIMED OUT RAW OUTPUT'), 'doctor must not read raw timeout output');
  });

  it('summarizes latest compatibility drift artifacts without reading release-note bodies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-compat-artifact-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const runId = 'compat-20260516T000000Z-abcdef';
    await mkdir(join(root, '.agentic-plugins', 'runs', 'compat', runId, 'release-notes'), { recursive: true });
    await writeJson(join(root, '.agentic-plugins', 'runs', 'compat', runId, 'snapshot.json'), {
      schema_version: 'runtime-compat-snapshot-1.0',
      runtime_version: RUNTIME_VERSION,
      run_id: runId,
      created_at: '2026-05-16T00:00:00.000Z',
      updated_at: '2026-05-16T00:00:00.000Z',
      hosts: {
        claude: { available: true, version: '2.1.150', version_text: '2.1.150 (Claude Code)' },
        codex: { available: true, version: '0.130.0', version_text: 'codex-cli 0.130.0' },
      },
      remembered_baseline: {
        claude: { version: '2.1.141' },
        codex: { version: '0.130.0' },
      },
    });
    await writeJson(join(root, '.agentic-plugins', 'runs', 'compat', runId, 'gap-analysis.json'), {
      schema_version: 'runtime-compat-gap-1.0',
      runtime_version: RUNTIME_VERSION,
      run_id: runId,
      created_at: '2026-05-16T00:01:00.000Z',
      updated_at: '2026-05-16T00:01:00.000Z',
      overall: {
        status: 'release_notes_required',
        drift_class: 'host-version-changed',
        release_notes_required: true,
      },
      host_gaps: [
        { host: 'claude', status: 'version_changed', observed_version: '2.1.150', baseline_version: '2.1.141' },
        { host: 'codex', status: 'matches', observed_version: '0.130.0', baseline_version: '0.130.0' },
      ],
      next_steps: [`runtime:compat ingest-release-notes --run-id ${runId} --release-notes-file <path>`],
    });
    await writeJson(join(root, '.agentic-plugins', 'runs', 'compat', runId, 'release-notes', 'index.json'), {
      schema_version: 'runtime-compat-release-notes-1.0',
      run_id: runId,
      notes: [{
        id: 'claude-notes',
        kind: 'url',
        source: 'https://example.test/notes',
        pointer: `.agentic-plugins/runs/compat/${runId}/release-notes/claude-notes.json`,
        status: 'not_fetched',
      }],
    });
    await writeFile(join(root, '.agentic-plugins', 'runs', 'compat', runId, 'release-notes', 'raw.md'), 'RAW RELEASE NOTES MUST NOT LEAK\n');

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner(defaultRuntimeProbeMap()),
    });

    strictEqual(report.compat_runs.status, 'release_notes_required');
    strictEqual(report.compat_runs.latest.run_id, runId);
    strictEqual(report.compat_runs.latest.drift_class, 'host-version-changed');
    strictEqual(report.compat_runs.latest.release_notes.url_pointers, 1);
    ok(report.experience_parity.criteria.some((entry) => entry.id === 'runtime_handoff_artifacts' && entry.status === 'blocked' && entry.evidence.includes('compat=release_notes_required')));
    ok(report.overall.warnings.includes('latest compatibility check requires release notes'));

    const text = formatText(report);
    ok(text.includes('Compatibility Artifacts'));
    ok(text.includes('host-gap: claude; status=version_changed'));
    ok(text.includes(`runtime:compat ingest-release-notes --run-id ${runId}`));
    ok(!JSON.stringify(report).includes('RAW RELEASE NOTES MUST NOT LEAK'), 'doctor must not read raw compatibility release-note bodies');
    ok(!text.includes('RAW RELEASE NOTES'), 'doctor must not print raw compatibility release-note bodies');
  });

  it('reports runtime artifact inventory pressure without reading artifact bodies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-artifact-inventory-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    for (let i = 0; i < 21; i++) {
      const seconds = String(i).padStart(2, '0');
      const suffix = String(i).padStart(6, '0');
      const runId = `consensus-20260513T0000${seconds}Z-${suffix}`;
      await mkdir(join(root, '.agentic-plugins', 'runs', 'consensus', runId, 'rounds', 'round-1', 'raw'), { recursive: true });
      await writeFile(join(root, '.agentic-plugins', 'runs', 'consensus', runId, 'rounds', 'round-1', 'raw', 'claude.txt'), 'RAW PEER OUTPUT MUST NOT LEAK\n');
    }
    await mkdir(join(root, '.agentic-plugins', 'runs', 'context', 'context-20260513T000000Z-abcdef'), { recursive: true });
    await writeFile(join(root, '.agentic-plugins', 'runs', 'context', 'context-20260513T000000Z-abcdef', 'context.json'), 'RAW CONTEXT SUMMARY MUST NOT LEAK\n');

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      artifactInventory: true,
      now: new Date('2026-05-14T00:00:00.000Z'),
      runner: fakeRunner(defaultRuntimeProbeMap()),
    });

    strictEqual(report.artifact_inventory.requested, true);
    strictEqual(report.artifact_inventory.executed, true);
    strictEqual(report.artifact_inventory.status, 'needs_attention');
    strictEqual(report.artifact_inventory.families.consensus.run_count, 21);
    strictEqual(report.artifact_inventory.families.context.run_count, 1);
    ok(report.artifact_inventory.attention.some((entry) => entry.family === 'consensus' && entry.kind === 'run_count_exceeds_cap'));
    ok(report.overall.warnings.includes('runtime artifact inventory exceeds retention guidance'));

    const text = formatText(report);
    ok(text.includes('Runtime Artifact Inventory'));
    ok(text.includes('retention-attention: consensus/run_count_exceeds_cap'));
    ok(!JSON.stringify(report).includes('RAW PEER OUTPUT'), 'doctor must not read raw peer artifacts');
    ok(!text.includes('RAW CONTEXT SUMMARY'), 'doctor must not print context artifact bodies');
  });

  it('inventories the ADR-0038 permission advisory family and excludes its latest.json singleton from run counts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-permission-inventory-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    for (const runId of ['permission-20260629T080000Z-000001', 'permission-20260629T090000Z-000002']) {
      await mkdir(join(root, '.agentic-plugins', 'runs', 'permission', runId), { recursive: true });
      await writeFile(
        join(root, '.agentic-plugins', 'runs', 'permission', runId, 'advisory.json'),
        '{"kind":"permission-advisory","SANITIZED":"pointer-only"}\n',
      );
    }
    // The overwritten latest.json singleton is a FILE at the family root — it
    // must count toward file_count but never toward run_count.
    await writeFile(
      join(root, '.agentic-plugins', 'runs', 'permission', 'latest.json'),
      '{"kind":"permission-advisory","run_id":"permission-20260629T090000Z-000002"}\n',
    );

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      artifactInventory: true,
      now: new Date('2026-06-29T10:00:00.000Z'),
      runner: fakeRunner(defaultRuntimeProbeMap()),
    });

    const permission = report.artifact_inventory.families.permission;
    ok(permission, 'permission family is present in the inventory');
    strictEqual(permission.run_count, 2);
    ok(permission.file_count >= 1, 'latest.json is counted as a file');
    strictEqual(permission.status, 'available');
    strictEqual(permission.attention.length, 0, 'two runs are under the retention cap');
  });

  it('runs the ADR-0038 R0 permission diagnosis read-only: classifies prompt causes by host x mechanism without leaking secrets or source paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-permission-diagnosis-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);

    // SECRETPROJECTSLUG is the project dir name — a stand-in for a local path
    // segment that must never reach the report. The bearer token is a synthetic
    // secret that must be generalized out of the stored pattern.
    const claudeLines = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm run test' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'git push --force origin main' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true }] }, toolUseResult: { interrupted: true } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: "curl -H 'Authorization: Bearer sk-ant-EXAMPLEONLYSECRET1234567890' https://api.example.com" } }] } },
    ].map((o) => JSON.stringify(o)).join('\n') + '\n';
    await mkdir(join(home, '.claude', 'projects', 'SECRETPROJECTSLUG'), { recursive: true });
    await writeFile(join(home, '.claude', 'projects', 'SECRETPROJECTSLUG', 'session-uuid.jsonl'), claudeLines);

    const codexLines = [
      { type: 'response_item', payload: { type: 'local_shell_call', call_id: 'c1', action: { type: 'exec', command: ['bash', '-lc', 'docker ps'] } } },
      { type: 'event_msg', payload: { type: 'exec_approval_request', call_id: 'c1', command: ['bash', '-lc', 'docker ps'] } },
    ].map((o) => JSON.stringify(o)).join('\n') + '\n';
    await mkdir(join(home, '.codex', 'sessions', '2026', '06', '30'), { recursive: true });
    await writeFile(join(home, '.codex', 'sessions', '2026', '06', '30', 'rollout-2026-06-30T05-00-00-abc.jsonl'), codexLines);

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      env: { ...process.env, CODEX_HOME: join(home, '.codex') },
      permissionDiagnosis: true,
      now: new Date('2026-06-30T06:00:00.000Z'),
      runner: fakeRunner(defaultRuntimeProbeMap()),
    });

    const pd = report.permission_diagnosis;
    ok(pd.requested && pd.executed, 'requested + executed');
    strictEqual(pd.status, 'analyzed');
    ok(pd.hosts.includes('claude') && pd.hosts.includes('codex'), 'both hosts diagnosed');

    const bashCause = pd.by_cause.find((c) => c.cause === 'claude.bash-not-allowlisted');
    ok(bashCause, 'claude bash cause present');
    strictEqual(bashCause.mechanism, 'bash');
    strictEqual(bashCause.rule_count, 3); // npm run *, git push *, curl *
    const approvalCause = pd.by_cause.find((c) => c.cause === 'codex.approval-requested');
    ok(approvalCause, 'codex approval cause present');

    ok(pd.top_patterns.some((p) => p.pattern === 'npm run *' && p.host === 'claude'), 'npm pattern surfaced');
    ok(pd.top_patterns.some((p) => p.pattern === 'docker ps' && p.host === 'codex'), 'docker pattern surfaced');
    ok(pd.mode_postures.some((m) => m.host === 'codex' && m.cause === 'codex.approval-requested'), 'codex approval posture');
    ok(pd.sources_scanned.claude.used >= 1 && pd.sources_scanned.codex.used >= 1, 'records scanned per host');

    // user-rejected (the git push --force interrupt) is the definite-prompt
    // signal, surfaced structurally — not an over-claim that every call prompted.
    strictEqual(bashCause.rejected_total, 1);
    const gitPattern = pd.top_patterns.find((p) => p.pattern === 'git push *');
    ok(gitPattern && gitPattern.rejected === 1, 'user-rejected count surfaced on the pattern');
    ok(formatText(report).includes('user-rejected='), 'text surfaces the definite-prompt count');

    // Privacy (ADR-0038 §5): no raw secret, no raw source path, no raw command args.
    const serialized = JSON.stringify(report);
    ok(!serialized.includes('EXAMPLEONLYSECRET'), 'secret in a command arg must not leak');
    ok(!serialized.includes('SECRETPROJECTSLUG'), 'raw transcript source path must not leak');
    ok(!serialized.includes('git push --force origin main'), 'raw command must be generalized, not stored verbatim');

    const text = formatText(report);
    ok(text.includes('Permission Diagnosis'), 'text section rendered');
    // R0: doctor must not write a permission run artifact.
    ok(!existsSync(join(root, '.agentic-plugins', 'runs', 'permission')), 'doctor permission diagnosis writes no artifact');
  });

  it('permission diagnosis degrades to no_records on an empty home (baseline)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-permission-empty-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      env: { ...process.env, CODEX_HOME: join(home, '.codex') },
      permissionDiagnosis: true,
      now: new Date('2026-06-30T06:00:00.000Z'),
      runner: fakeRunner(defaultRuntimeProbeMap()),
    });
    const pd = report.permission_diagnosis;
    strictEqual(pd.status, 'no_records');
    strictEqual(pd.baseline_used, true);
    deepStrictEqual(pd.by_cause, []);
    strictEqual(report.overall.status === 'fail', false, 'no_records is not a hard failure');
  });

  it('omits the permission diagnosis unless explicitly requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-permission-off-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-06-30T06:00:00.000Z'),
      runner: fakeRunner(defaultRuntimeProbeMap()),
    });
    strictEqual(report.permission_diagnosis.requested, false);
    strictEqual(report.permission_diagnosis.status, 'not_requested');
    ok(!formatText(report).includes('Permission Diagnosis'));
  });

  it('parses the --permission-diagnosis flags', () => {
    const opts = parseArgs(['--permission-diagnosis', '--permission-diagnosis-max-files', '5', '--permission-diagnosis-max-file-bytes', '4096']);
    strictEqual(opts.permissionDiagnosis, true);
    strictEqual(opts.permissionDiagnosisMaxFiles, 5);
    strictEqual(opts.permissionDiagnosisMaxFileBytes, 4096);
    strictEqual(parseArgs([]).permissionDiagnosis, false);
  });

  it('permission diagnosis does not follow a symlinked record root (no-follow)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-permission-symlink-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    const real = await mkdtemp(join(tmpdir(), 'runtime-doctor-realrecords-'));
    await seedRepo(root);
    // Real Claude records live outside the home; ~/.claude/projects is a symlink
    // to them. A no-follow walk must NOT pick them up.
    await mkdir(join(real, 'proj'), { recursive: true });
    await writeFile(
      join(real, 'proj', 'x.jsonl'),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm run test' } }] } }) + '\n',
    );
    await mkdir(join(home, '.claude'), { recursive: true });
    await symlink(real, join(home, '.claude', 'projects'));

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      env: { ...process.env, CODEX_HOME: join(home, '.codex') },
      permissionDiagnosis: true,
      now: new Date('2026-06-30T06:00:00.000Z'),
      runner: fakeRunner(defaultRuntimeProbeMap()),
    });
    const pd = report.permission_diagnosis;
    strictEqual(pd.sources_scanned.claude.found, 0, 'symlinked record root is not followed');
    strictEqual(pd.status, 'no_records');
  });

  it('permission diagnosis skips oversized records above the per-file byte cap and reports it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-permission-bytecap-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    await mkdir(join(home, '.claude', 'projects', 'p'), { recursive: true });
    await writeFile(
      join(home, '.claude', 'projects', 'p', 'small.jsonl'),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm run test' } }] } }) + '\n',
    );
    await writeFile(join(home, '.claude', 'projects', 'p', 'huge.jsonl'), `${'x'.repeat(2000)}\n`);

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      env: { ...process.env, CODEX_HOME: join(home, '.codex') },
      permissionDiagnosis: true,
      permissionDiagnosisMaxFileBytes: 1000,
      now: new Date('2026-06-30T06:00:00.000Z'),
      runner: fakeRunner(defaultRuntimeProbeMap()),
    });
    const pd = report.permission_diagnosis;
    strictEqual(pd.sources_scanned.claude.skipped_too_large, 1, 'oversized record skipped');
    strictEqual(pd.sources_scanned.claude.used, 1, 'only the small record was analyzed');
    ok(pd.limits.some((l) => l.includes('oversized') || l.includes('byte cap')), 'cap is reported, not silent');
  });

  it('reports sandbox and permission readiness as unknown without an explicit peer smoke', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-readiness-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        'claude --version': okResult('2.1.140 (Claude Code)\n'),
        'claude --help': okResult('Usage: claude --print --no-session-persistence --model --effort --permission-mode --plugin-dir\nCommands:\n  auth status\n  plugin list\n'),
        'claude auth status': okResult(JSON.stringify({ loggedIn: true })),
        'claude plugin list': okResult(''),
        'codex --version': okResult('codex-cli 0.130.0\n'),
        'codex --help': okResult('Commands:\n  exec Run Codex non-interactively\n  login status\n  plugin marketplace\nOptions:\n  --model\n  --config\n  --cd\n  --sandbox\n  --ask-for-approval\n'),
        'codex exec --help': okResult('Usage: codex exec --cd <DIR> --model <MODEL> --config model_reasoning_effort=\"high\"\n'),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development false\n'),
        'codex login status': okResult('Logged in using ChatGPT\n'),
        'codex plugin marketplace --help': okResult(''),
      }),
    });
    strictEqual(report.readiness.claude_to_codex.sandbox_permission.status, 'unknown');
    strictEqual(report.readiness.codex_to_claude.sandbox_permission.status, 'unknown');
    strictEqual(report.sandbox_permission_probe.requested, false);
    strictEqual(report.sandbox_permission_probe.executed, false);
    strictEqual(report.permission_proof.requested, false);
    strictEqual(report.permission_proof.executed, false);
  });

  it('runs sandbox permission proof as an explicit read-only probe without peer execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-sandbox-probe-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      sandboxPermissionProbe: true,
      runner: fakeRunner({
        'claude --version': okResult('2.1.140 (Claude Code)\n'),
        'claude --help': okResult('Usage: claude --print --no-session-persistence --model --effort --permission-mode --plugin-dir\nCommands:\n  auth status\n  plugin list\n'),
        'claude auth status': okResult(JSON.stringify({ loggedIn: true })),
        'claude plugin list': okResult(''),
        'codex --version': okResult('codex-cli 0.130.0\n'),
        'codex --help': okResult('Commands:\n  exec Run Codex non-interactively\n  login status\n  plugin marketplace\nOptions:\n  --model\n  --config\n  --cd\n  --sandbox\n  --ask-for-approval\n'),
        'codex exec --help': okResult('Usage: codex exec --cd <DIR> --model <MODEL> --config model_reasoning_effort=\"high\"\n'),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development false\n'),
        'codex login status': okResult('Logged in using ChatGPT\n'),
        'codex plugin marketplace --help': okResult(''),
      }),
    });

    strictEqual(report.sandbox_permission_probe.requested, true);
    strictEqual(report.sandbox_permission_probe.executed, true);
    strictEqual(report.sandbox_permission_probe.peer_execution, false);
    strictEqual(report.sandbox_permission_probe.status, 'read_only_probe_passed');
    strictEqual(report.sandbox_permission_probe.directions.claude_to_codex.status, 'read_only_probe_passed');
    strictEqual(report.sandbox_permission_probe.directions.codex_to_claude.status, 'read_only_probe_passed');
    strictEqual(report.readiness.claude_to_codex.sandbox_permission.status, 'read_only_probe_passed');
    strictEqual(report.readiness.codex_to_claude.sandbox_permission.peer_execution, false);
    ok(report.sandbox_permission_probe.directions.codex_to_claude.probes.some((probe) => probe.name === 'peer_permission_surface' && probe.status === 'passed'));
    ok(report.sandbox_permission_probe.limits.some((limit) => /does not execute peer agents/i.test(limit)));
    ok(formatText(report).includes('Sandbox Permission Probe'));
    ok(formatText(report).includes('peer-execution=false'));
  });

  it('plans permission proof as an explicit preflight without executing peers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-permission-proof-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      explicitModel: 'gpt-5.4',
      explicitEffort: 'high',
      permissionProof: true,
      runner: fakeRunner(defaultRuntimeProbeMap()),
    });

    strictEqual(report.permission_proof.mode, 'plan_only_preflight');
    strictEqual(report.permission_proof.requested, true);
    strictEqual(report.permission_proof.executed, false);
    strictEqual(report.permission_proof.peer_execution, false);
    strictEqual(report.permission_proof.status, 'ready_with_warnings');
    strictEqual(report.permission_proof.directions.claude_to_codex.execution, 'not_executed');
    strictEqual(report.permission_proof.directions.claude_to_codex.preflight.status, 'read_only_probe_passed');
    strictEqual(report.permission_proof.directions.codex_to_claude.permission_policy.relaxed_by_doctor, false);
    ok(report.permission_proof.directions.codex_to_claude.warnings.some((warning) => /does not add sandbox/i.test(warning)));
    ok(report.permission_proof.limits.some((limit) => /does not execute peer agents/i.test(limit)));
    ok(formatText(report).includes('Permission Proof'));
    ok(formatText(report).includes('permission-policy: host-default=true; relaxed-by-doctor=false; injected-flags=0'));
  });

  it('executes permission proof only behind the explicit executor boundary and classifies permission failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-permission-proof-execute-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const calls = [];
    const permissionFailureEnvelope = {
      status: 'peer_error',
      peer_host: 'claude',
      peer_model: null,
      stdout: 'RUNTIME_DOCTOR_PERMISSION_RAW_DETAILS_MUST_NOT_LEAK',
      exit_code: 1,
      error: {
        kind: 'peer_permission_denied',
        message: 'Permission denied: sandbox approval required',
      },
      metadata: {
        duration_ms: 777,
        started_at: '2026-05-13T00:00:00.000Z',
        completed_at: '2026-05-13T00:00:01.000Z',
      },
    };
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      explicitModel: 'gpt-5.4',
      explicitEffort: 'high',
      permissionProof: true,
      executePermissionProof: true,
      permissionProofTimeoutMs: 45000,
      runner: async (command, args, options = {}) => {
        calls.push({ command, args, options });
        if (args[0]?.endsWith('codex-companion.mjs')) {
          strictEqual(options.timeoutMs, 45000);
          return okResult(JSON.stringify(smokeEnvelope('codex', 'RUNTIME_DOCTOR_PERMISSION_OK codex\nRAW DETAILS MUST NOT LEAK', 321)));
        }
        if (args[0]?.endsWith('claude-companion.mjs')) {
          strictEqual(options.timeoutMs, 45000);
          return {
            ok: false,
            exit_code: 1,
            stdout: JSON.stringify(permissionFailureEnvelope),
            stderr: 'EACCES',
            error_code: null,
            timed_out: false,
          };
        }
        return fakeRuntimeProbeRunner(command, args);
      },
    });

    strictEqual(report.permission_proof.mode, 'explicit_permission_executor');
    strictEqual(report.permission_proof.executed, true);
    strictEqual(report.permission_proof.peer_execution, true);
    strictEqual(report.permission_proof.status, 'operator_action_required');
    strictEqual(report.overall.status, 'warning');
    strictEqual(report.permission_proof.directions.claude_to_codex.execution, 'executed');
    strictEqual(report.permission_proof.directions.claude_to_codex.result.status, 'passed');
    strictEqual(report.permission_proof.directions.codex_to_claude.result.status, 'operator_action_required');
    strictEqual(report.permission_proof.directions.codex_to_claude.result.operator_action_required, true);
    strictEqual(report.permission_proof.directions.codex_to_claude.result.operator_action_kind, 'permission_required');
    strictEqual(report.permission_proof.directions.codex_to_claude.next_step, 'operator must satisfy host permission or auth preconditions outside runtime:doctor, then rerun the explicit proof');
    strictEqual(report.readiness_matrix.directions.codex_to_claude.execution_readiness.permission_proof.status, 'operator_action_required');
    strictEqual(report.readiness_matrix.directions.codex_to_claude.execution_readiness.permission_proof.operator_action_kind, 'permission_required');
    ok(calls.some((call) => call.args[0]?.endsWith('codex-companion.mjs') && call.args.includes('--output-format') && call.args.includes('json')));
    ok(calls.some((call) => call.args[0]?.endsWith('claude-companion.mjs')));
    for (const call of calls.filter((entry) => entry.args[0]?.endsWith('codex-companion.mjs') || entry.args[0]?.endsWith('claude-companion.mjs'))) {
      ok(!call.args.includes('--sandbox'));
      ok(!call.args.includes('--ask-for-approval'));
      ok(!call.args.includes('--permission-mode'));
    }

    const serialized = JSON.stringify(report);
    ok(!serialized.includes('RAW DETAILS MUST NOT LEAK'), 'doctor report must not include raw peer stdout');
    ok(!serialized.includes('RUNTIME_DOCTOR_PERMISSION_RAW_DETAILS_MUST_NOT_LEAK'), 'doctor report must not include raw failed peer stdout');
    ok(formatText(report).includes('operator-action-required=true'));
    ok(formatText(report).includes('operator-action-kind: permission_required'));
  });

  it('plans deep peer smoke as a structured read-only doctor section without executing peers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-deep-smoke-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      explicitModel: 'gpt-5.4',
      explicitEffort: 'high',
      deepPeerSmoke: true,
      runner: fakeRunner({
        'claude --version': okResult('2.1.140 (Claude Code)\n'),
        'claude --help': okResult('Usage: claude --print --no-session-persistence --model --effort --permission-mode --plugin-dir\nCommands:\n  auth status\n  plugin list\n'),
        'claude auth status': okResult(JSON.stringify({ loggedIn: true })),
        'claude plugin list': okResult(''),
        'codex --version': okResult('codex-cli 0.130.0\n'),
        'codex --help': okResult('Commands:\n  exec Run Codex non-interactively\n  login status\n  plugin marketplace\nOptions:\n  --model\n  --config\n  --cd\n  --sandbox\n  --ask-for-approval\n'),
        'codex exec --help': okResult('Usage: codex exec --cd <DIR> --model <MODEL> --config model_reasoning_effort=\"high\"\n'),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development false\n'),
        'codex login status': okResult('Logged in using ChatGPT\n'),
        'codex plugin marketplace --help': okResult(''),
      }),
    });

    strictEqual(report.deep_peer_smoke.mode, 'plan_only_preflight');
    strictEqual(report.deep_peer_smoke.requested, true);
    strictEqual(report.deep_peer_smoke.executed, false);
    strictEqual(report.deep_peer_smoke.status, 'ready_with_warnings');
    strictEqual(report.deep_peer_smoke.directions.claude_to_codex.execution, 'not_executed');
    strictEqual(report.deep_peer_smoke.directions.claude_to_codex.model.value, 'gpt-5.4');
    strictEqual(report.deep_peer_smoke.directions.codex_to_claude.effort.value, 'high');
    ok(report.deep_peer_smoke.limits.some((limit) => /does not execute peer agents/i.test(limit)));
    ok(formatText(report).includes('Deep Peer Smoke'));
    ok(formatText(report).includes('plan-only preflight'));
  });

  it('executes deep peer smoke only behind the explicit executor boundary and omits raw peer output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-deep-smoke-execute-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const peerOutputs = {
      codex: 'RUNTIME_DOCTOR_SMOKE_OK codex\nRAW DETAILS MUST NOT LEAK',
      claude: 'RUNTIME_DOCTOR_SMOKE_OK claude\nRAW DETAILS MUST NOT LEAK',
    };
    const calls = [];
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      explicitModel: 'gpt-5.4',
      explicitEffort: 'high',
      deepPeerSmoke: true,
      executeDeepPeerSmoke: true,
      deepPeerSmokeTimeoutMs: 90000,
      runner: async (command, args, options = {}) => {
        calls.push({ command, args, options });
        if (args[0]?.endsWith('codex-companion.mjs')) {
          strictEqual(options.timeoutMs, 90000);
          return okResult(JSON.stringify(smokeEnvelope('codex', peerOutputs.codex, 321)));
        }
        if (args[0]?.endsWith('claude-companion.mjs')) {
          strictEqual(options.timeoutMs, 90000);
          return okResult(JSON.stringify(smokeEnvelope('claude', peerOutputs.claude, 654)));
        }
        return fakeRuntimeProbeRunner(command, args);
      },
    });

    strictEqual(report.deep_peer_smoke.mode, 'explicit_executor');
    strictEqual(report.deep_peer_smoke.executed, true);
    strictEqual(report.deep_peer_smoke.peer_execution, true);
    strictEqual(report.deep_peer_smoke.status, 'passed');
    strictEqual(report.overall.status, 'warning');
    strictEqual(report.deep_peer_smoke.directions.claude_to_codex.execution, 'executed');
    strictEqual(report.deep_peer_smoke.directions.claude_to_codex.result.peer_host, 'codex');
    strictEqual(report.deep_peer_smoke.directions.claude_to_codex.result.expected_token_present, true);
    strictEqual(report.deep_peer_smoke.directions.claude_to_codex.result.stdout_bytes, Buffer.byteLength(peerOutputs.codex));
    ok(report.deep_peer_smoke.directions.claude_to_codex.result.stdout_sha256);
    strictEqual(report.readiness_matrix.directions.claude_to_codex.execution_readiness.status, 'passed');
    strictEqual(report.readiness_matrix.directions.claude_to_codex.execution_readiness.deep_peer_smoke.status, 'passed');
    strictEqual(report.readiness_matrix.directions.codex_to_claude.execution_readiness.deep_peer_smoke.status, 'passed');
    ok(calls.some((call) => call.args[0]?.endsWith('codex-companion.mjs') && call.args.includes('--output-format') && call.args.includes('json')));
    ok(calls.some((call) => call.args[0]?.endsWith('claude-companion.mjs')));

    const serialized = JSON.stringify(report);
    ok(!serialized.includes('RAW DETAILS MUST NOT LEAK'), 'doctor report must not include raw peer stdout');
    ok(!formatText(report).includes('RAW DETAILS MUST NOT LEAK'), 'text report must not include raw peer stdout');
    ok(formatText(report).includes('peer-execution=true'));
    ok(formatText(report).includes('execution-readiness=passed'));
  });

  it('plans workflow continuation proof without executing peers or mutating workflow state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-workflow-proof-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      explicitModel: 'gpt-5.4',
      explicitEffort: 'high',
      workflowContinuationProof: true,
      runner: fakeRunner(defaultRuntimeProbeMap()),
    });

    strictEqual(report.workflow_continuation_proof.mode, 'plan_only_preflight');
    strictEqual(report.workflow_continuation_proof.requested, true);
    strictEqual(report.workflow_continuation_proof.executed, false);
    strictEqual(report.workflow_continuation_proof.peer_execution, false);
    strictEqual(report.workflow_continuation_proof.workflow_state, 'none');
    strictEqual(report.workflow_continuation_proof.status, 'ready_with_warnings');
    strictEqual(report.workflow_continuation_proof.directions.claude_to_codex.execution, 'not_executed');
    ok(report.workflow_continuation_proof.limits.some((limit) => /does not execute peer agents or mutate workflow state/i.test(limit)));
    ok(report.experience_parity.criteria.some((entry) => entry.id === 'engineer_workflow_continuation_execution' && entry.status === 'not_verified'));
    ok(formatText(report).includes('Workflow Continuation Proof'));
    ok(formatText(report).includes('workflow-state=none'));
  });

  it('executes workflow continuation proof through engineer dispatch and state bookkeeping', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-workflow-proof-execute-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const calls = [];
    const readCounts = new Map();
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      explicitModel: 'gpt-5.4',
      explicitEffort: 'high',
      workflowContinuationProof: true,
      executeWorkflowContinuationProof: true,
      workflowContinuationProofTimeoutMs: 60000,
      runner: async (command, args, options = {}) => {
        calls.push({ command, args, options });
        if (command === 'git' && args[0] === 'init') {
          strictEqual(options.timeoutMs, 60000);
          return okResult('');
        }
        if (args[0]?.endsWith('state.mjs') && args[1] === 'create') {
          strictEqual(options.timeoutMs, 60000);
          const host = args[args.indexOf('--host') + 1];
          return okResult(`${options.cwd}/.agentic-plugins/state/engineer/workflows/compose-${host}.md\n`);
        }
        if (args[0]?.endsWith('dispatch-peer.mjs')) {
          strictEqual(options.timeoutMs, 60000);
          const peer = args[args.indexOf('--peer') + 1];
          const workflowPath = args[args.indexOf('--workflow-path') + 1];
          const runId = args[args.indexOf('--run-id') + 1];
          strictEqual(args[args.indexOf('--ensemble-type') + 1], 'workflow-continuation-proof');
          strictEqual(runId, peer === 'codex' ? 'workflow-proof-claude_to_codex' : 'workflow-proof-codex_to_claude');
          ok(workflowPath.includes('/.agentic-plugins/state/engineer/workflows/'));
          return okResult(JSON.stringify(smokeEnvelope(peer, `RUNTIME_WORKFLOW_CONTINUATION_OK ${peer}\nRAW DETAILS MUST NOT LEAK`, 222)));
        }
        if (args[0]?.endsWith('state.mjs') && args[1] === 'read') {
          strictEqual(options.timeoutMs, 60000);
          const workflowPath = args[args.indexOf('--workflow-path') + 1];
          const count = (readCounts.get(workflowPath) ?? 0) + 1;
          readCounts.set(workflowPath, count);
          const runId = workflowPath.endsWith('compose-claude.md')
            ? 'workflow-proof-claude_to_codex'
            : 'workflow-proof-codex_to_claude';
          if (count === 1) {
            return okResult(JSON.stringify({
              workflow_id: workflowPath.split('/').at(-1).replace(/\.md$/, ''),
              pending_ensemble: [{ phase: 'compose', ensemble_type: 'workflow-continuation-proof', run_id: runId }],
            }));
          }
          return okResult(JSON.stringify({
            workflow_id: workflowPath.split('/').at(-1).replace(/\.md$/, ''),
            pending_ensemble: [],
            ensemble_results: [{ phase: 'compose', ensemble_type: 'workflow-continuation-proof', run_id: runId, verdict: 'passed' }],
          }));
        }
        if (args[0]?.endsWith('state.mjs') && args[1] === 'ensemble-commit') {
          strictEqual(options.timeoutMs, 60000);
          return okResult(`${args[args.indexOf('--workflow-path') + 1]}\n`);
        }
        return fakeRuntimeProbeRunner(command, args);
      },
    });

    strictEqual(report.workflow_continuation_proof.mode, 'explicit_engineer_workflow_executor');
    strictEqual(report.workflow_continuation_proof.executed, true);
    strictEqual(report.workflow_continuation_proof.peer_execution, true);
    strictEqual(report.workflow_continuation_proof.workflow_state, 'ephemeral_temp_repo');
    strictEqual(report.workflow_continuation_proof.status, 'passed');
    strictEqual(report.workflow_continuation_proof.directions.claude_to_codex.result.status, 'passed');
    strictEqual(report.workflow_continuation_proof.directions.claude_to_codex.result.state_checks.pending_recorded, true);
    strictEqual(report.workflow_continuation_proof.directions.claude_to_codex.result.state_checks.pending_cleared, true);
    strictEqual(report.workflow_continuation_proof.directions.claude_to_codex.result.state_checks.commit_recorded, true);
    strictEqual(report.readiness_matrix.directions.claude_to_codex.execution_readiness.workflow_continuation_proof.status, 'passed');
    ok(report.experience_parity.criteria.some((entry) => entry.id === 'engineer_workflow_continuation_execution' && entry.status === 'satisfied'));
    ok(calls.some((call) => call.args[0]?.endsWith('dispatch-peer.mjs') && call.args.includes('--workflow-path')));
    ok(calls.some((call) => call.args[0]?.endsWith('state.mjs') && call.args[1] === 'ensemble-commit'));

    const serialized = JSON.stringify(report);
    ok(!serialized.includes('RAW DETAILS MUST NOT LEAK'), 'doctor report must not include raw peer stdout');
    ok(formatText(report).includes('Workflow Continuation Proof'));
    ok(formatText(report).includes('state-checks: workflow-created=true; pending-recorded=true; pending-cleared=true; commit-recorded=true'));
    ok(!formatText(report).includes('RAW DETAILS MUST NOT LEAK'), 'text report must not include raw peer stdout');
  });

  it('resolves the workflow-proof engineer tool-root from the host cache, separate from the ephemeral workspace (§8.2 C5)', async () => {
    // Consumer-machine shape: engineer is installed in the host plugin cache, and
    // the repo has NO plugins/engineer. Pre-C5 the proof looked under
    // repoRoot/plugins/engineer and would block here.
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-consumer-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-consumer-home-'));
    await seedRepo(root);
    await rm(join(root, 'plugins', 'engineer'), { recursive: true, force: true });
    const cacheRoot = join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'engineer', '0.9.0');
    await mkdir(join(cacheRoot, '.claude-plugin'), { recursive: true });
    await mkdir(join(cacheRoot, 'scripts'), { recursive: true });
    await writeFile(join(cacheRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'engineer', version: '0.9.0' }));
    await writeFile(join(cacheRoot, 'scripts', 'state.mjs'), '// cache state script\n');
    await writeFile(join(cacheRoot, 'scripts', 'dispatch-peer.mjs'), '// cache dispatch script\n');

    const calls = [];
    const readCounts = new Map();
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      workflowContinuationProof: true,
      executeWorkflowContinuationProof: true,
      workflowContinuationProofTimeoutMs: 60000,
      runner: async (command, args, options = {}) => {
        calls.push({ command, args, options });
        if (command === 'git' && args[0] === 'init') return okResult('');
        if (args[0]?.endsWith('state.mjs') && args[1] === 'create') {
          const host = args[args.indexOf('--host') + 1];
          return okResult(`${options.cwd}/.agentic-plugins/state/engineer/workflows/compose-${host}.md\n`);
        }
        if (args[0]?.endsWith('dispatch-peer.mjs')) {
          const peer = args[args.indexOf('--peer') + 1];
          return okResult(JSON.stringify(smokeEnvelope(peer, `RUNTIME_WORKFLOW_CONTINUATION_OK ${peer}`, 222)));
        }
        if (args[0]?.endsWith('state.mjs') && args[1] === 'read') {
          const workflowPath = args[args.indexOf('--workflow-path') + 1];
          const count = (readCounts.get(workflowPath) ?? 0) + 1;
          readCounts.set(workflowPath, count);
          const runId = workflowPath.endsWith('compose-claude.md') ? 'workflow-proof-claude_to_codex' : 'workflow-proof-codex_to_claude';
          if (count === 1) {
            return okResult(JSON.stringify({ workflow_id: workflowPath.split('/').at(-1).replace(/\.md$/, ''), pending_ensemble: [{ phase: 'compose', ensemble_type: 'workflow-continuation-proof', run_id: runId }] }));
          }
          return okResult(JSON.stringify({ workflow_id: workflowPath.split('/').at(-1).replace(/\.md$/, ''), pending_ensemble: [], ensemble_results: [{ phase: 'compose', ensemble_type: 'workflow-continuation-proof', run_id: runId, verdict: 'passed' }] }));
        }
        if (args[0]?.endsWith('state.mjs') && args[1] === 'ensemble-commit') {
          return okResult(`${args[args.indexOf('--workflow-path') + 1]}\n`);
        }
        return fakeRuntimeProbeRunner(command, args);
      },
    });

    strictEqual(report.workflow_continuation_proof.status, 'passed');
    // The tool-root is the host cache, NOT repoRoot/plugins/engineer (which is gone).
    const result = report.workflow_continuation_proof.directions.claude_to_codex.result;
    strictEqual(result.tool_root_source, 'claude-cache');
    strictEqual(result.installed_tool_root, cacheRoot);
    // The proof workspace stays ephemeral and distinct from the tool-root.
    strictEqual(report.workflow_continuation_proof.workflow_state, 'ephemeral_temp_repo');
    // The engineer scripts the executor invoked came from the CACHE, never repoRoot.
    const stateCalls = calls.filter((c) => c.args[0]?.endsWith('state.mjs'));
    ok(stateCalls.length > 0 && stateCalls.every((c) => c.args[0].startsWith(cacheRoot)), 'executor invoked the cache-resolved state.mjs, not repoRoot/plugins/engineer');
    ok(!calls.some((c) => c.args[0]?.includes(join(root, 'plugins', 'engineer'))), 'never touches repoRoot/plugins/engineer');
  });

  it('records reusable doctor proof artifacts and reuses them when current versions match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-recorded-proof-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    await seedHome(home);
    const runId = 'doctor-20260513T000000Z-abc123';
    const first = await runDoctor({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-05-13T00:00:00.000Z'),
      permissionProof: true,
      executePermissionProof: true,
      deepPeerSmoke: true,
      executeDeepPeerSmoke: true,
      workflowContinuationProof: true,
      executeWorkflowContinuationProof: true,
      recordArtifact: true,
      runId,
      runner: successfulProofRunner(),
    });

    strictEqual(first.doctor_artifact.written, true);
    strictEqual(first.doctor_artifact.run_id, runId);
    strictEqual(first.permission_proof.status, 'passed');
    strictEqual(first.deep_peer_smoke.status, 'passed');
    strictEqual(first.workflow_continuation_proof.status, 'passed');
    ok(formatText(first).includes('doctor-artifact: .agentic-plugins/runs/doctor/doctor-20260513T000000Z-abc123/doctor.json'));

    const failedRunId = 'doctor-20260513T000100Z-def456';
    const failedLatest = await runDoctor({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-05-13T00:01:00.000Z'),
      recordArtifact: true,
      runId: failedRunId,
      runner: fakeRunner(defaultRuntimeProbeMap()),
    });
    strictEqual(failedLatest.doctor_artifact.written, true);
    strictEqual(failedLatest.recorded_doctor_proof.status, 'reusable');
    strictEqual(failedLatest.recorded_doctor_proof.run_id, runId);

    const second = await runDoctor({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-05-13T00:05:00.000Z'),
      runner: fakeRunner(defaultRuntimeProbeMap()),
    });

    strictEqual(second.permission_proof.executed, false);
    strictEqual(second.deep_peer_smoke.executed, false);
    strictEqual(second.workflow_continuation_proof.executed, false);
    strictEqual(second.doctor_runs.latest.run_id, failedRunId);
    strictEqual(second.recorded_doctor_proof.status, 'reusable');
    strictEqual(second.recorded_doctor_proof.run_id, runId);
    ok(second.experience_parity.criteria.some((entry) => entry.id === 'bidirectional_peer_execution' && entry.status === 'satisfied' && entry.evidence.includes(`recorded-doctor=${runId}`)));
    ok(second.experience_parity.criteria.some((entry) => entry.id === 'engineer_workflow_continuation_execution' && entry.status === 'satisfied' && entry.evidence.includes(`recorded-doctor=${runId}`)));
    ok(formatText(second).includes(`recorded-doctor-proof: reusable; run=${runId}`));
  });

  it('invalidates a recorded doctor proof when the list-authoritative codex installed version changes (ADR-0034)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-proof-codexlist-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-proof-codexlist-home-'));
    await seedRepo(root);
    await seedHome(home);
    const runId = 'doctor-20260608T000000Z-c0de01';
    const installedList = okResult(JSON.stringify({ installed: [{ name: 'runtime', marketplaceName: 'agentic-plugins', version: '0.1.0', installed: true, enabled: true }] }));

    // Record a reusable proof while the list reports runtime installed @ 0.1.0.
    const first = await runDoctor({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-06-08T00:00:00.000Z'),
      permissionProof: true,
      executePermissionProof: true,
      deepPeerSmoke: true,
      executeDeepPeerSmoke: true,
      workflowContinuationProof: true,
      executeWorkflowContinuationProof: true,
      recordArtifact: true,
      runId,
      runner: proofRunnerWithCodexList(installedList),
    });
    strictEqual(first.permission_proof.status, 'passed');
    strictEqual(first.plugins.runtime.installed.codex_resolved.decision, 'installed');
    strictEqual(first.plugins.runtime.installed.codex_resolved.version, '0.1.0');

    // Rerun with the list now reporting runtime NOT installed: the list-authoritative
    // codex installed version changes 0.1.0 -> null, so the recorded proof — keyed on
    // codex_installed, not the stale filesystem cache — must no longer be reusable.
    const notInstalledList = okResult(JSON.stringify({ installed: [{ name: 'runtime', marketplaceName: 'agentic-plugins', version: '0.1.0', installed: false, enabled: false }] }));
    const second = await runDoctor({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-06-08T00:05:00.000Z'),
      runner: proofRunnerWithCodexList(notInstalledList),
    });
    strictEqual(second.plugins.runtime.installed.codex_resolved.decision, 'not_installed');
    strictEqual(second.recorded_doctor_proof.status, 'not_reusable');
    ok(second.recorded_doctor_proof.reasons.some((reason) => reason.includes('runtime codex_installed mismatch')));
  });

  it('keeps a cache-recorded proof reusable when a list-capable codex later reports the same version (ADR-0034)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-proof-legacy-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-proof-legacy-home-'));
    await seedRepo(root);
    await seedHome(home); // ~/.codex install cache seeds runtime @ 0.1.0
    const runId = 'doctor-20260608T010000Z-ca11ed';

    // Record while `codex plugin list --json` is unavailable (parse error) -> the
    // recorded codex_installed derives from the filesystem cache (0.1.0), the same
    // derivation branch a pre-codex_resolved legacy report takes. Codex CLI stays
    // 0.137 across both runs so the rerun does not trip the separate CLI-version check.
    const first = await runDoctor({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-06-08T01:00:00.000Z'),
      permissionProof: true,
      executePermissionProof: true,
      deepPeerSmoke: true,
      executeDeepPeerSmoke: true,
      workflowContinuationProof: true,
      executeWorkflowContinuationProof: true,
      recordArtifact: true,
      runId,
      runner: proofRunnerWithCodexList(okResult('not json{')),
    });
    strictEqual(first.permission_proof.status, 'passed');
    strictEqual(first.plugins.runtime.installed.codex_resolved.decision, 'fallback');

    // Rerun once the list is authoritative and reports the SAME version 0.1.0:
    // current codex_installed (list) == recorded codex_installed (cache) -> the
    // recorded proof must stay reusable (no spurious codex_installed mismatch).
    const sameVersionList = okResult(JSON.stringify({ installed: [{ name: 'runtime', marketplaceName: 'agentic-plugins', version: '0.1.0', installed: true, enabled: true }] }));
    const second = await runDoctor({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-06-08T01:05:00.000Z'),
      runner: proofRunnerWithCodexList(sameVersionList),
    });
    strictEqual(second.plugins.runtime.installed.codex_resolved.decision, 'installed');
    strictEqual(second.plugins.runtime.installed.codex_resolved.version, '0.1.0');
    strictEqual(second.recorded_doctor_proof.status, 'reusable');
    ok(!second.recorded_doctor_proof.reasons.some((reason) => reason.includes('codex_installed')));
  });

  it('keeps host auth separate from child companion auth failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-child-auth-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      deepPeerSmoke: true,
      executeDeepPeerSmoke: true,
      runner: async (command, args) => {
        if (args[0]?.endsWith('codex-companion.mjs')) {
          return okResult(JSON.stringify(smokeEnvelope('codex', 'RUNTIME_DOCTOR_SMOKE_OK codex\n', 12)));
        }
        if (args[0]?.endsWith('claude-companion.mjs')) {
          return {
            ok: false,
            exit_code: 1,
            stdout: JSON.stringify({
              status: 'peer_error',
              peer_host: 'claude',
              stdout: 'AUTH RAW DETAILS MUST NOT LEAK',
              exit_code: 1,
              error: { kind: 'peer_unauthenticated', message: 'child process login required' },
            }),
            stderr: 'login required',
            error_code: null,
            timed_out: false,
          };
        }
        return fakeRuntimeProbeRunner(command, args);
      },
    });

    strictEqual(report.clis.claude.auth.status, 'available');
    strictEqual(report.readiness_matrix.hosts.claude.authenticated.status, 'available');
    strictEqual(report.deep_peer_smoke.directions.codex_to_claude.result.status, 'operator_action_required');
    strictEqual(report.deep_peer_smoke.directions.codex_to_claude.result.operator_action_kind, 'auth_required');
    strictEqual(report.readiness_matrix.directions.codex_to_claude.execution_readiness.status, 'operator_action_required');
    strictEqual(report.readiness_matrix.directions.codex_to_claude.execution_readiness.deep_peer_smoke.operator_action_kind, 'auth_required');
    ok(!JSON.stringify(report).includes('AUTH RAW DETAILS'), 'doctor must not include raw auth failure stdout');
    ok(formatText(report).includes('authenticated=available'));
    ok(formatText(report).includes('operator-action-kind: auth_required'));
  });

  it('classifies auth wording in failed peer stdout without leaking raw output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-child-auth-stdout-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const rawAuthOutput = 'Not logged in. Please run /login. AUTH RAW DETAILS MUST NOT LEAK';
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      deepPeerSmoke: true,
      executeDeepPeerSmoke: true,
      runner: async (command, args) => {
        if (args[0]?.endsWith('codex-companion.mjs')) {
          return okResult(JSON.stringify(smokeEnvelope('codex', 'RUNTIME_DOCTOR_SMOKE_OK codex\n', 12)));
        }
        if (args[0]?.endsWith('claude-companion.mjs')) {
          return {
            ok: false,
            exit_code: 1,
            stdout: JSON.stringify({
              status: 'peer_error',
              peer_host: 'claude',
              stdout: rawAuthOutput,
              exit_code: 1,
              error: { kind: 'peer_run_error', message: 'peer exited with code 1' },
            }),
            stderr: 'peer exited with code 1',
            error_code: null,
            timed_out: false,
          };
        }
        return fakeRuntimeProbeRunner(command, args);
      },
    });

    const result = report.deep_peer_smoke.directions.codex_to_claude.result;
    strictEqual(result.status, 'operator_action_required');
    strictEqual(result.operator_action_kind, 'auth_required');
    strictEqual(result.peer_stdout_operator_action_kind, 'auth_required');
    strictEqual(report.readiness_matrix.directions.codex_to_claude.execution_readiness.deep_peer_smoke.operator_action_kind, 'auth_required');
    ok(!JSON.stringify(report).includes('AUTH RAW DETAILS'), 'doctor must not include raw auth failure stdout');
    ok(!formatText(report).includes('AUTH RAW DETAILS'), 'text report must not include raw auth failure stdout');
  });

  it('classifies child companion sandbox detail without leaking raw peer stderr', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-child-sandbox-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const rawDetail = [
      'WARNING: proceeding, even though we could not update PATH: Operation not permitted (os error 1)',
      'Reading prompt from stdin...',
      'Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)',
    ].join('\n');
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      deepPeerSmoke: true,
      executeDeepPeerSmoke: true,
      runner: async (command, args) => {
        if (args[0]?.endsWith('codex-companion.mjs')) {
          return {
            ok: false,
            exit_code: 1,
            stdout: JSON.stringify({
              status: 'peer_error',
              peer_host: 'codex',
              stdout: '',
              exit_code: 1,
              error: {
                kind: 'peer_run_error',
                message: 'peer exited with code 1',
                detail: rawDetail,
              },
            }),
            stderr: '',
            error_code: null,
            timed_out: false,
          };
        }
        if (args[0]?.endsWith('claude-companion.mjs')) {
          return okResult(JSON.stringify(smokeEnvelope('claude', 'RUNTIME_DOCTOR_SMOKE_OK claude\n', 12)));
        }
        return fakeRuntimeProbeRunner(command, args);
      },
    });

    strictEqual(report.deep_peer_smoke.status, 'operator_action_required');
    strictEqual(report.deep_peer_smoke.directions.claude_to_codex.result.status, 'operator_action_required');
    strictEqual(report.deep_peer_smoke.directions.claude_to_codex.result.operator_action_kind, 'sandbox_blocked');
    strictEqual(report.deep_peer_smoke.directions.claude_to_codex.result.error.detail_kind, 'sandbox_blocked');
    strictEqual(report.readiness_matrix.directions.claude_to_codex.execution_readiness.deep_peer_smoke.operator_action_kind, 'sandbox_blocked');
    const serialized = JSON.stringify(report);
    ok(!serialized.includes('failed to initialize in-process app-server client'), 'doctor report must not leak raw peer stderr detail');
    ok(!serialized.includes('Reading prompt from stdin'), 'doctor report must not leak raw prompt transport detail');
    ok(formatText(report).includes('operator-action-kind: sandbox_blocked'));
  });

  it('parses CLI arguments and rejects unknown or malformed flags', () => {
    const opts = parseArgs(['--repo-root', '/tmp/repo', '--format', 'json', '--host', 'codex', '--model', 'm', '--effort', 'high', '--deep-peer-smoke', '--execute-deep-peer-smoke', '--deep-peer-smoke-timeout-ms', '90000', '--sandbox-permission-probe', '--permission-proof', '--execute-permission-proof', '--permission-proof-timeout-ms', '45000', '--workflow-continuation-proof', '--execute-workflow-continuation-proof', '--workflow-continuation-proof-timeout-ms', '60000', '--artifact-inventory', '--artifact-retention-cap', '30', '--artifact-max-bytes', '1024', '--record', '--run-id', 'doctor-20260513T000000Z-abc123']);
    strictEqual(opts.repoRoot, '/tmp/repo');
    strictEqual(opts.format, 'json');
    strictEqual(opts.host, 'codex');
    strictEqual(opts.explicitModel, 'm');
    strictEqual(opts.explicitEffort, 'high');
    strictEqual(opts.deepPeerSmoke, true);
    strictEqual(opts.executeDeepPeerSmoke, true);
    strictEqual(opts.deepPeerSmokeTimeoutMs, 90000);
    strictEqual(opts.sandboxPermissionProbe, true);
    strictEqual(opts.permissionProof, true);
    strictEqual(opts.executePermissionProof, true);
    strictEqual(opts.permissionProofTimeoutMs, 45000);
    strictEqual(opts.workflowContinuationProof, true);
    strictEqual(opts.executeWorkflowContinuationProof, true);
    strictEqual(opts.workflowContinuationProofTimeoutMs, 60000);
    strictEqual(opts.artifactInventory, true);
    strictEqual(opts.artifactRetentionCap, 30);
    strictEqual(opts.artifactMaxBytes, 1024);
    strictEqual(opts.recordArtifact, true);
    strictEqual(opts.runId, 'doctor-20260513T000000Z-abc123');
    rejects(async () => parseArgs(['--format', 'xml']), /--format must be text or json/);
    rejects(async () => parseArgs(['--execute-deep-peer-smoke']), /requires --deep-peer-smoke/);
    rejects(async () => parseArgs(['--execute-permission-proof']), /requires --permission-proof/);
    rejects(async () => parseArgs(['--execute-workflow-continuation-proof']), /requires --workflow-continuation-proof/);
    rejects(async () => parseArgs(['--deep-peer-smoke', '--deep-peer-smoke-timeout-ms', '0']), /positive integer/);
    rejects(async () => parseArgs(['--permission-proof', '--permission-proof-timeout-ms', '0']), /positive integer/);
    rejects(async () => parseArgs(['--workflow-continuation-proof', '--workflow-continuation-proof-timeout-ms', '0']), /positive integer/);
    rejects(async () => parseArgs(['--artifact-retention-cap', '0']), /positive integer/);
    rejects(async () => parseArgs(['--artifact-max-bytes', '0']), /positive integer/);
    rejects(async () => parseArgs(['--run-id', 'doctor-20260513T000000Z-abc123']), /requires --record/);
    rejects(async () => parseArgs(['--record', '--run-id', 'bad']), /Invalid doctor run id/);
  });

  it('reports host_parity_baseline freshness (current / stale / missing / unknown)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-baseline-home-'));
    const defaultProbes = {
      'claude --version': okResult('2.1.161 (Claude Code)\n'),
      'claude --help': okResult('Commands:\n  auth status\n  plugin list\n'),
      'codex --version': okResult('codex-cli 0.136.0\n'),
      'codex --help': okResult('Commands:\n  exec\n  plugin marketplace\n'),
      'codex features list': okResult('hooks stable true\nplugin_hooks removed false\nplugins stable true\n'),
    };
    const runWith = async (baselineLine, probes = defaultProbes) => {
      const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-baseline-'));
      await seedRepo(root);
      if (baselineLine !== null) {
        await mkdir(join(root, 'plugins', 'runtime', 'docs'), { recursive: true });
        await writeFile(join(root, 'plugins', 'runtime', 'docs', 'host-parity-baseline.md'), baselineLine);
      }
      return runDoctor({ repoRoot: root, homeDir: home, runner: fakeRunner(probes) });
    };
    // current: baseline Observed versions match installed
    const current = await runWith('Observed on 2026-06-03 with Claude Code `2.1.161`, Codex CLI\n`0.136.0`, docs.\n');
    strictEqual(current.host_parity_baseline.status, 'current');
    strictEqual(current.host_parity_baseline.next_action, null);
    // normalize tolerates a v-prefix / trailing label on either side
    const prefixed = await runWith('Observed on 2026-06-03 with Claude Code `v2.1.161`, Codex CLI\n`0.136.0`, docs.\n');
    strictEqual(prefixed.host_parity_baseline.status, 'current');
    // stale: baseline older than installed
    const stale = await runWith('Observed on 2026-05-16 with Claude Code `2.1.143`, Codex CLI\n`0.130.0`, docs.\n');
    strictEqual(stale.host_parity_baseline.status, 'stale');
    ok(stale.host_parity_baseline.next_action.includes('runtime:compat'));
    ok(formatText(stale).includes('baseline-freshness: stale'));
    // missing: no baseline.md (seedRepo does not create it)
    const missing = await runWith(null);
    strictEqual(missing.host_parity_baseline.status, 'missing');
    // unknown: version probe failed (claude --version omitted → ENOENT). A
    // matching baseline must NOT be misreported current when the probe failed
    // (version.text would otherwise carry stderr/error text).
    const probeFailed = { ...defaultProbes };
    delete probeFailed['claude --version'];
    const unknown = await runWith('Observed on 2026-06-03 with Claude Code `2.1.161`, Codex CLI\n`0.136.0`, docs.\n', probeFailed);
    strictEqual(unknown.host_parity_baseline.status, 'unknown');
    ok(unknown.host_parity_baseline.next_action.includes('Probe host CLIs'));
    strictEqual(unknown.host_parity_baseline.evidence.observed.claude, null);
    strictEqual(unknown.host_parity_baseline.evidence.probes.claude, 'unavailable');
  });
});

// ADR-0034 — doctor uses `codex plugin list --json` as a host-native Codex
// installed-state read signal, with list-authoritative-then-cache precedence.
describe('runtime doctor — codex plugin list read signal (ADR-0034)', () => {
  const codexEntry = (name, { version = '0.1.0', installed = true, enabled = true, marketplaceName = 'agentic-plugins' } = {}) => ({
    pluginId: `${name}@${marketplaceName}`,
    name,
    marketplaceName,
    version,
    installed,
    enabled,
    source: { source: 'local', path: `/Users/x/.codex/.tmp/marketplaces/${marketplaceName}/plugins/${name}` },
    installPolicy: 'AVAILABLE',
    authPolicy: 'ON_USE',
  });
  const listJson = (installed) => JSON.stringify({ installed });
  // Codex 0.137 base map (per-plugin surface present); pass the `codex plugin
  // list --json` runner result to exercise each list state.
  const codex137 = (pluginListResult) => ({
    ...defaultRuntimeProbeMap(),
    'codex --version': okResult('codex-cli 0.137.0\n'),
    'codex --help': okResult('Commands:\n  exec\n  login status\n  plugin  Manage Codex plugins\nOptions:\n  --model\n  --sandbox\n  --ask-for-approval\n'),
    'codex plugin --help': okResult('Manage Codex plugins\n\nUsage: codex plugin <COMMAND>\n\nCommands:\n  add\n  list\n  marketplace\n  remove\n'),
    'codex plugin marketplace --help': okResult('Commands:\n  add\n  list\n  upgrade\n  remove\n'),
    'codex plugin list --json': pluginListResult,
  });
  const mkdirs = async () => ({
    root: await mkdtemp(join(tmpdir(), 'runtime-doctor-codexlist-')),
    home: await mkdtemp(join(tmpdir(), 'runtime-doctor-codexlist-home-')),
  });

  // The founder RT slice (ADR-0036) recorded a deferred generic-name fix: the
  // not-installed evidence string hardcoded "runtime", so a not-installed
  // `designer` reported "codex plugin list does not report runtime as
  // installed". The designer RT slice (ADR-0042) closes it — adding designer to
  // the inventory is exactly what surfaces the wrong name to an operator.
  it('the not-installed evidence names the plugin it is about, not "runtime" (ADR-0042 RT)', async () => {
    const { root, home } = await mkdirs();
    await seedRepo(root);
    await seedHome(home);
    // List probe succeeds and reports NOTHING from our marketplace -> every
    // plugin takes the list-authoritative not-installed branch.
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-05-13T00:00:00.000Z'),
      runner: fakeRunner(codex137(okResult(listJson([])))),
    });
    const checked = [];
    for (const name of PLUGIN_NAMES) {
      const evidence = report.plugins?.[name]?.installed?.codex_resolved?.evidence;
      if (typeof evidence !== 'string' || !evidence.includes('does not report')) continue;
      checked.push(name);
      ok(evidence.includes(name),
        `the not-installed evidence for "${name}" must name "${name}", got: ${evidence}`);
    }
    // Non-vacuous: the not-installed branch must actually have been exercised
    // for the whole inventory, designer included.
    deepStrictEqual(checked, [...PLUGIN_NAMES],
      `every inventory plugin must take the not-installed branch (checked: ${JSON.stringify(checked)})`);
  });

  it('uses codex plugin list --json (enabled) as installed evidence without a filesystem cache', async () => {
    const { root, home } = await mkdirs();
    await seedRepo(root); // source present, but no ~/.codex install cache (no seedHome)
    const report = await runDoctor({
      repoRoot: root, homeDir: home,
      runner: fakeRunner(codex137(okResult(listJson([codexEntry('runtime')])))),
    });
    strictEqual(report.plugins.runtime.cache.codex.status, 'missing');
    strictEqual(report.plugins.runtime.installed.codex_plugin_list.status, 'enabled');
    strictEqual(report.plugins.runtime.installed.codex_resolved.decision, 'installed');
    strictEqual(report.plugins.runtime.installed.codex_resolved.source, 'list');
    strictEqual(report.readiness_matrix.hosts.codex.installed.status, 'installed');
    strictEqual(report.readiness_matrix.hosts.codex.installed.evidence, 'codex plugin list reports enabled');
  });

  it('reports an installed-but-disabled codex plugin as blocked', async () => {
    const { root, home } = await mkdirs();
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root, homeDir: home,
      runner: fakeRunner(codex137(okResult(listJson([codexEntry('runtime', { enabled: false })])))),
    });
    strictEqual(report.plugins.runtime.installed.codex_resolved.decision, 'disabled');
    strictEqual(report.readiness_matrix.hosts.codex.installed.status, 'blocked');
    ok(/disabled/i.test(report.readiness_matrix.hosts.codex.installed.evidence));
  });

  it('does not let a stale codex cache claim an install the list omits (precedence)', async () => {
    const { root, home } = await mkdirs();
    await seedRepo(root);
    await seedHome(home); // ~/.codex install cache for runtime IS present
    // ...but the authoritative list does NOT include runtime.
    const report = await runDoctor({
      repoRoot: root, homeDir: home,
      runner: fakeRunner(codex137(okResult(listJson([codexEntry('companions')])))),
    });
    strictEqual(report.plugins.runtime.cache.codex.status, 'available'); // cache present
    strictEqual(report.plugins.runtime.installed.codex_resolved.decision, 'not_installed');
    strictEqual(report.readiness_matrix.hosts.codex.installed.status, 'not_installed');
    ok(/does not report/i.test(report.readiness_matrix.hosts.codex.installed.evidence));
    // A list-confirmed absence must not let the stale runtime cache version
    // manufacture a false Codex INSTALLED-version-drift parity issue for runtime
    // (ADR-0034). (Other plugins that the list DOES report installed, and
    // marketplace catalog-version drift, are separate legitimate signals.)
    ok(!report.host_parity.issues.some((issue) => issue.host === 'codex' && issue.plugin === 'runtime'
      && (issue.id === 'installed_plugin_stale' || issue.id === 'installed_plugin_version_ahead')));
  });

  it('treats a list entry reporting installed:false as not installed (defensive)', async () => {
    const { root, home } = await mkdirs();
    await seedRepo(root);
    await seedHome(home); // cache present, but list authoritatively says not installed
    const report = await runDoctor({
      repoRoot: root, homeDir: home,
      runner: fakeRunner(codex137(okResult(listJson([codexEntry('runtime', { installed: false, enabled: false })])))),
    });
    strictEqual(report.plugins.runtime.installed.codex_plugin_list.status, 'not_installed');
    strictEqual(report.plugins.runtime.installed.codex_resolved.decision, 'not_installed');
    strictEqual(report.readiness_matrix.hosts.codex.installed.status, 'not_installed');
  });

  it('falls back to codex cache when the list output is malformed', async () => {
    const { root, home } = await mkdirs();
    await seedRepo(root);
    await seedHome(home);
    const report = await runDoctor({
      repoRoot: root, homeDir: home,
      runner: fakeRunner(codex137(okResult('this is not json{'))),
    });
    strictEqual(report.plugins.runtime.installed.codex_resolved.decision, 'fallback');
    strictEqual(report.readiness_matrix.hosts.codex.installed.status, 'installed');
    strictEqual(report.readiness_matrix.hosts.codex.installed.evidence, 'codex plugin cache contains runtime');
  });

  it('falls back to codex cache when codex plugin list is unsupported (older codex)', async () => {
    const { root, home } = await mkdirs();
    await seedRepo(root);
    await seedHome(home);
    const unsupported = { ok: false, exit_code: 2, stdout: '', stderr: 'error: unrecognized subcommand \'list\'', error_code: null, timed_out: false };
    const report = await runDoctor({
      repoRoot: root, homeDir: home,
      runner: fakeRunner(codex137(unsupported)),
    });
    strictEqual(report.plugins.runtime.installed.codex_resolved.decision, 'fallback');
    strictEqual(report.readiness_matrix.hosts.codex.installed.status, 'installed');
    strictEqual(report.readiness_matrix.hosts.codex.installed.evidence, 'codex plugin cache contains runtime');
  });

  it('ignores codex plugin list entries from other marketplaces', async () => {
    const { root, home } = await mkdirs();
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root, homeDir: home,
      runner: fakeRunner(codex137(okResult(listJson([
        codexEntry('runtime'),
        codexEntry('runtime', { marketplaceName: 'other-marketplace', version: '9.9.9' }),
      ])))),
    });
    strictEqual(report.plugins.runtime.installed.codex_plugin_list.marketplace, 'agentic-plugins');
    strictEqual(report.plugins.runtime.installed.codex_plugin_list.version, '0.1.0');
    ok(!report.host_parity.issues.some((issue) => issue.id === 'codex_retired_or_unknown_plugin'));
  });

  it('flags a codex agentic-plugins entry not in the runtime plugin set as retired/unknown', async () => {
    const { root, home } = await mkdirs();
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root, homeDir: home,
      runner: fakeRunner(codex137(okResult(listJson([codexEntry('runtime'), codexEntry('research')])))),
    });
    ok(report.host_parity.issues.some((issue) => issue.id === 'codex_retired_or_unknown_plugin' && issue.plugin === 'research'));
  });

  // The concrete operator-facing value of the ADR-0042 RT slice: BEFORE designer
  // joined PLUGIN_NAMES, an installed `designer@agentic-plugins` was reported as
  // a retired/unknown plugin (the same bucket `research` — an actually-archived
  // plugin — lands in). Recognition means designer must NOT be flagged, while a
  // genuinely retired plugin still is. Asserting both directions in one probe
  // keeps the test from passing on a blanket "never flag anything" regression.
  it('an installed designer is recognized, not flagged retired/unknown; an actually-retired plugin still is (ADR-0042 RT)', async () => {
    const { root, home } = await mkdirs();
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root, homeDir: home,
      runner: fakeRunner(codex137(okResult(listJson([codexEntry('designer'), codexEntry('research')])))),
    });
    const retired = report.host_parity.issues.filter((issue) => issue.id === 'codex_retired_or_unknown_plugin');
    ok(!retired.some((issue) => issue.plugin === 'designer'),
      'designer is in the runtime plugin set and must not be reported as retired/unknown');
    ok(retired.some((issue) => issue.plugin === 'research'),
      'an actually-retired plugin must still be flagged (the guard is not a blanket suppression)');
  });

  it('redacts raw codex plugin list stdout from the report (status only, no source paths)', async () => {
    const { root, home } = await mkdirs();
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root, homeDir: home,
      runner: fakeRunner(codex137(okResult(listJson([codexEntry('runtime')])))),
    });
    ok(report.clis.codex.plugin_list_command_status, 'plugin_list_command_status present in redacted clis');
    strictEqual(report.clis.codex.plugin_list, undefined); // raw probe object not persisted
    ok(!JSON.stringify(report.clis.codex).includes('/.tmp/marketplaces/'), 'no raw source path leaked into clis');
  });
});

describe('runtime doctor — installed engineer root resolver (§8.2 C5)', () => {
  it('env override wins when absolute and scripts/state.mjs exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'engineer-root-env-'));
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(join(dir, 'scripts', 'state.mjs'), '// x\n');
    const res = await resolveInstalledEngineerRoot({ env: { AGENTIC_ENGINEER_ROOT: dir }, home: '/nonexistent-home-xyz', selfUrl: 'file:///nope/x.mjs' });
    deepStrictEqual(res, { root: dir, source: 'env-override' });
  });

  it('a relative or unreadable env override resolves to null (no silent fallback)', async () => {
    strictEqual(await resolveInstalledEngineerRoot({ env: { AGENTIC_ENGINEER_ROOT: 'relative/path' }, home: '/nonexistent-home-xyz', selfUrl: 'file:///nope/x.mjs' }), null);
    strictEqual(await resolveInstalledEngineerRoot({ env: { AGENTIC_ENGINEER_ROOT: '/absolute/but/missing' }, home: '/nonexistent-home-xyz', selfUrl: 'file:///nope/x.mjs' }), null);
  });

  it('picks the SemVer-max Claude cache install whose manifest name is engineer', async () => {
    const home = await mkdtemp(join(tmpdir(), 'engineer-root-cache-'));
    const base = join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'engineer');
    for (const [version, name] of [['0.9.0', 'engineer'], ['0.21.0', 'engineer'], ['9.9.9', 'notengineer']]) {
      const r = join(base, version);
      await mkdir(join(r, '.claude-plugin'), { recursive: true });
      await mkdir(join(r, 'scripts'), { recursive: true });
      await writeFile(join(r, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version }));
      await writeFile(join(r, 'scripts', 'state.mjs'), '// x\n');
    }
    const res = await resolveInstalledEngineerRoot({ env: {}, home, selfUrl: 'file:///nope/x.mjs' });
    strictEqual(res.source, 'claude-cache');
    strictEqual(res.root, join(base, '0.21.0')); // 9.9.9 is not-engineer -> skipped; 0.21.0 > 0.9.0
  });

  it('falls back to the sibling monorepo checkout when no cache exists', async () => {
    const base = await mkdtemp(join(tmpdir(), 'engineer-root-sibling-'));
    await mkdir(join(base, 'plugins', 'runtime', 'scripts'), { recursive: true });
    await mkdir(join(base, 'plugins', 'engineer', 'scripts'), { recursive: true });
    await writeFile(join(base, 'plugins', 'engineer', 'scripts', 'state.mjs'), '// x\n');
    const selfUrl = pathToFileURL(join(base, 'plugins', 'runtime', 'scripts', 'doctor.mjs')).href;
    const res = await resolveInstalledEngineerRoot({ env: {}, home: '/nonexistent-home-xyz', selfUrl });
    strictEqual(res.source, 'sibling-monorepo');
    strictEqual(res.root, join(base, 'plugins', 'engineer'));
  });

  it('returns null when engineer is installed nowhere (uninstalled consumer machine)', async () => {
    const res = await resolveInstalledEngineerRoot({ env: {}, home: '/nonexistent-home-xyz', selfUrl: 'file:///nowhere/plugins/runtime/scripts/doctor.mjs' });
    strictEqual(res, null);
  });
});

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

function fakeRunner(map) {
  return async (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    return map[key] ?? enoent(command);
  };
}

function defaultRuntimeProbeMap() {
  return {
    'claude --version': okResult('2.1.140 (Claude Code)\n'),
    'claude --help': okResult('Usage: claude --print --no-session-persistence --model --effort --permission-mode --plugin-dir\nCommands:\n  auth status\n  plugin list\n'),
    'claude auth status': okResult(JSON.stringify({ loggedIn: true })),
    'claude plugin --help': okResult('Commands:\n  install\n  list\n  update\n  uninstall\n'),
    'claude plugin list': okResult(''),
    'claude /plugin list': okResult('Installed plugins:\n'),
    'codex --version': okResult('codex-cli 0.130.0\n'),
    'codex --help': okResult('Commands:\n  exec Run Codex non-interactively\n  login status\n  plugin marketplace\nOptions:\n  --model\n  --config\n  --cd\n  --sandbox\n  --ask-for-approval\n'),
    'codex exec --help': okResult('Usage: codex exec --cd <DIR> --model <MODEL> --config model_reasoning_effort="high"\n'),
    'codex features list': okResult('hooks stable true\nplugin_hooks under development false\nplugins stable true\nmulti_agent stable true\n'),
    'codex login status': okResult('Logged in using ChatGPT\n'),
    'codex plugin marketplace --help': okResult(''),
  };
}

function fakeRuntimeProbeRunner(command, args) {
  return fakeRunner(defaultRuntimeProbeMap())(command, args);
}

function successfulProofRunner() {
  const readCounts = new Map();
  return async (command, args, options = {}) => {
    if (command === 'git' && args[0] === 'init') return okResult('');
    if (args[0]?.endsWith('codex-companion.mjs') || args[0]?.endsWith('claude-companion.mjs')) {
      const peer = args[0].endsWith('codex-companion.mjs') ? 'codex' : 'claude';
      const prompt = args.at(-1) ?? '';
      const expected = prompt.match(/RUNTIME_DOCTOR_PERMISSION_OK (claude|codex)/)?.[0]
        ?? prompt.match(/RUNTIME_DOCTOR_SMOKE_OK (claude|codex)/)?.[0];
      if (expected) return okResult(JSON.stringify(smokeEnvelope(peer, `${expected}\nRAW DETAILS MUST NOT LEAK`, 123)));
    }
    if (args[0]?.endsWith('state.mjs') && args[1] === 'create') {
      const host = args[args.indexOf('--host') + 1];
      return okResult(`${options.cwd}/.agentic-plugins/state/engineer/workflows/compose-${host}.md\n`);
    }
    if (args[0]?.endsWith('dispatch-peer.mjs')) {
      const peer = args[args.indexOf('--peer') + 1];
      return okResult(JSON.stringify(smokeEnvelope(peer, `RUNTIME_WORKFLOW_CONTINUATION_OK ${peer}\nRAW DETAILS MUST NOT LEAK`, 222)));
    }
    if (args[0]?.endsWith('state.mjs') && args[1] === 'read') {
      const workflowPath = args[args.indexOf('--workflow-path') + 1];
      const count = (readCounts.get(workflowPath) ?? 0) + 1;
      readCounts.set(workflowPath, count);
      const runId = workflowPath.endsWith('compose-claude.md')
        ? 'workflow-proof-claude_to_codex'
        : 'workflow-proof-codex_to_claude';
      if (count === 1) {
        return okResult(JSON.stringify({
          workflow_id: workflowPath.split('/').at(-1).replace(/\.md$/, ''),
          pending_ensemble: [{ phase: 'compose', ensemble_type: 'workflow-continuation-proof', run_id: runId }],
        }));
      }
      return okResult(JSON.stringify({
        workflow_id: workflowPath.split('/').at(-1).replace(/\.md$/, ''),
        pending_ensemble: [],
        ensemble_results: [{ phase: 'compose', ensemble_type: 'workflow-continuation-proof', run_id: runId, verdict: 'passed' }],
      }));
    }
    if (args[0]?.endsWith('state.mjs') && args[1] === 'ensemble-commit') {
      return okResult(`${args[args.indexOf('--workflow-path') + 1]}\n`);
    }
    return fakeRuntimeProbeRunner(command, args);
  };
}

// ADR-0034 proof-reuse: a proof runner (companion/state dispatch via
// successfulProofRunner) whose codex probes report a 0.137 per-plugin surface and
// an authoritative `codex plugin list --json` result, so the recorded and current
// reports resolve codex installed-state from the list rather than the cache.
function proofRunnerWithCodexList(listResult) {
  const base = successfulProofRunner();
  const codexOverrides = {
    'codex --version': okResult('codex-cli 0.137.0\n'),
    'codex --help': okResult('Commands:\n  exec Run Codex non-interactively\n  login status\n  plugin  Manage Codex plugins\nOptions:\n  --model\n  --config\n  --cd\n  --sandbox\n  --ask-for-approval\n'),
    'codex plugin --help': okResult('Manage Codex plugins\n\nUsage: codex plugin <COMMAND>\n\nCommands:\n  add\n  list\n  marketplace\n  remove\n'),
    'codex plugin marketplace --help': okResult('Commands:\n  add\n  list\n  upgrade\n  remove\n'),
    'codex plugin list --json': listResult,
  };
  return async (command, args, options = {}) => {
    const key = `${command} ${args.join(' ')}`;
    if (key in codexOverrides) return codexOverrides[key];
    return base(command, args, options);
  };
}

function smokeEnvelope(peer, stdout, durationMs) {
  return {
    status: 'success',
    peer_host: peer,
    peer_model: null,
    stdout,
    exit_code: 0,
    metadata: {
      duration_ms: durationMs,
      started_at: '2026-05-13T00:00:00.000Z',
      completed_at: '2026-05-13T00:00:01.000Z',
    },
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
  await mkdir(join(root, 'plugins', 'engineer', 'scripts'), { recursive: true });
  await writeFile(join(root, 'plugins', 'engineer', 'scripts', 'state.mjs'), '// test state script\n');
  await writeFile(join(root, 'plugins', 'engineer', 'scripts', 'dispatch-peer.mjs'), '// test dispatch script\n');
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
  await mkdir(join(root, '.agentic-plugins'), { recursive: true });
  await writeFile(join(root, '.agentic-plugins', 'config.toml'), 'codex_model = "repo-codex"\nclaude_effort = "medium"\n');
  await mkdir(join(root, '.claude', 'agentic-engineer', 'workflows'), { recursive: true });
  await writeFile(join(root, '.claude', 'agentic-engineer', 'workflows', 'compose-20260513T000000Z-abcdef.md'), [
    '---',
    'workflow_id: compose-20260513T000000Z-abcdef',
    'current_phase: phase-4',
    'git_baseline:',
    '  branch: feat/runtime-doctor',
    '---',
    '',
  ].join('\n'));
  await mkdir(join(root, '.claude', 'agentic-engineer', 'peer-runs', 'run-1'), { recursive: true });
  await writeJson(join(root, '.claude', 'agentic-engineer', 'peer-runs', 'run-1', 'handle.json'), {
    run_id: 'run-1',
    plugin: 'engineer',
    status: 'running',
    kind: 'ensemble',
    peer_host: 'claude',
    model: 'm',
    effort: 'high',
    updated_at: '2026-05-12T23:00:00.000Z',
  });
}

async function writeDisabledCodexHookStateConfig(home, hooksPath = 'hooks/hooks.json') {
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
      lines.push('enabled = false');
      lines.push('trusted_hash = "sha256:abc123"');
      lines.push('');
    }
  }
  await writeFile(join(home, '.codex', 'config.toml'), lines.join('\n'));
}

// The shape a CURRENT Codex writes when the operator trusts a hook in `/hooks`:
// a `trusted_hash` and NO `enabled` key. `/hooks` exposes no enable toggle, so
// this is the only reachable trusted state for a newly-installed hook-bearing
// plugin. `enabled = true` appears in older configs as residue from an earlier
// Codex; both must read as ENABLED.
async function writeTrustedCodexHookStateConfig(home, hooksPath = 'hooks/hooks.json', { explicitEnabled = false, extraLines = [] } = {}) {
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
      if (explicitEnabled) lines.push('enabled = true');
      lines.push('trusted_hash = "sha256:abc123"');
      lines.push('');
    }
  }
  lines.push(...extraLines);
  await writeFile(join(home, '.codex', 'config.toml'), lines.join('\n'));
}

async function seedHome(home) {
  await mkdir(join(home, '.codex', 'plugins', 'cache', 'agentic-plugins', 'runtime', '0.1.0', '.codex-plugin'), { recursive: true });
  await writeJson(join(home, '.codex', 'plugins', 'cache', 'agentic-plugins', 'runtime', '0.1.0', '.codex-plugin', 'plugin.json'), {
    name: 'runtime',
    version: '0.1.0',
  });
}

// Seed the per-plugin Codex install cache doctor reads at
// ~/.codex/plugins/cache/agentic-plugins/<name>/<version>/.codex-plugin/plugin.json.
// With no `codex plugin list` probe the install decision is 'fallback', so this cache
// version is what the currency mirror resolves (S8a4 §SCOPE-2).
async function seedCodexInstallCache(home, name, version) {
  const dir = join(home, '.codex', 'plugins', 'cache', 'agentic-plugins', name, version, '.codex-plugin');
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, 'plugin.json'), { name, version, description: `${name} plugin` });
}

async function seedCodexTmpMarketplace(home) {
  await mkdir(join(home, '.codex', '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'runtime', '.codex-plugin'), { recursive: true });
  await writeJson(join(home, '.codex', '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'runtime', '.codex-plugin', 'plugin.json'), {
    name: 'runtime',
    version: '0.1.0',
  });
}

async function writeWorkflow(path, branch) {
  await writeFile(path, [
    '---',
    `workflow_id: ${path.split('/').at(-1).replace(/\.md$/, '')}`,
    'current_phase: phase-4',
    'git_baseline:',
    `  branch: ${branch}`,
    '---',
    '',
  ].join('\n'));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
