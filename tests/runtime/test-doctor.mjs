import { describe, it } from 'node:test';
import { strictEqual, notStrictEqual, ok, rejects, deepStrictEqual, match, throws } from 'node:assert/strict';
import { cp, mkdtemp, mkdir, writeFile, readdir, readFile, realpath, rm, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { evaluateCodexHookStateGate, formatText, parseArgs, projectCodexHookStateForProbe, runDoctor, RUNTIME_VERSION, PLUGIN_NAMES, resolveInstalledEngineerRoot } from '../../plugins/runtime/scripts/doctor.mjs';
import { recomputeHookAttestation } from '../../plugins/runtime/scripts/lib/completion-reducer.mjs';
import { makeDefValidator } from '../../plugins/runtime/scripts/lib/schema-validate.mjs';
import { buildClone, installFromClone, pinned, writeCatalog } from './_codex-pinned-fixture.mjs';

// Module-load scrub. Most tests run
// doctor with the default env = process.env; an ambient AGENTIC_COMPANIONS_ROOT or
// AGENTIC_ENGINEER_ROOT (development overrides, ADR-0061 §Decision 3) would replace
// the fixture caches, and an ambient CODEX_HOME would move the Codex cache off the
// fixture home.
for (const k of ['AGENTIC_COMPANIONS_ROOT', 'AGENTIC_ENGINEER_ROOT', 'CODEX_HOME']) {
  delete process.env[k];
}


const PORTABLE_HOOK_COMMAND = '/bin/sh "${PLUGIN_ROOT}/adapters/codex/hooks/run-node-hook.sh" "${PLUGIN_ROOT}/adapters/codex/hooks/hook.mjs"';

describe('runtime doctor', () => {
  // ADR-0064 Decision 9: the probes run in the environment doctor was given. Until
  // that ADR, doctor scrubbed the egress credential from it here (ADR-0041 §2b/§2c);
  // the scrub went with egress (Decision 1), and nothing else filters the probe env.
  it('hands every host-CLI probe the environment doctor was given', async () => {
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
      env: { ...process.env, AGENTIC_DOCTOR_PROBE_ENV_SENTINEL: 'sentinel-value', PATH: '/usr/bin:/bin' },
    });

    const claudeProbes = seen.filter((call) => call.command === 'claude');
    const codexProbes = seen.filter((call) => call.command === 'codex');
    strictEqual(claudeProbes.length, 7, 'every claude probe must be inspected, not just --version');
    strictEqual(codexProbes.length, 9, 'every codex probe must be inspected, not just --version');
    const probes = [...claudeProbes, ...codexProbes];
    for (const probe of probes) {
      strictEqual(probe.env?.AGENTIC_DOCTOR_PROBE_ENV_SENTINEL, 'sentinel-value', `${probe.command} probe lost a variable doctor was given`);
      strictEqual(probe.env?.PATH, '/usr/bin:/bin', `${probe.command} probe did not receive the given PATH`);
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
    await seedCompanionCaches(home);
    await seedHome(home);
    await installSourcePluginsOnCodex(root, home);
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
    // ADR-0056 §Decision 8 — the family bumped because the DENOMINATOR moved:
    // `host_compatibility_assurance` carried weight 15 and sat in `totalWeight`,
    // so removing it changes the criterion count, the total weight and the
    // score. A field deletion would not have needed a bump; a scoring change
    // does.
    strictEqual(report.experience_parity.schema_version, 'runtime-experience-parity-1.2');
    strictEqual(report.experience_parity.criteria.length, 8, 'the ninth criterion was removed, and the count is what the denominator is built from');
    strictEqual(report.experience_parity.weight.total, 115);
    strictEqual(
      report.experience_parity.criteria.some((item) => item.id === 'host_compatibility_assurance'),
      false,
      'the removed criterion must not reappear',
    );
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
    await installSourcePluginsOnCodex(root, home);
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
    await installSourcePluginsOnCodex(root, home);
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

    await installSourcePluginsOnCodex(root, home);
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
    await installSourcePluginsOnCodex(root, home, ['engineer', 'orchestrator', 'attention']);
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
    // Attention is INSTALLED on Codex with the relocated layout: Codex reads hooks
    // from the installed package (ADR-0061 §Decision 4), so an uninstalled attention
    // would be absent from every set whatever its layout, and prove nothing.
    await installSourcePluginsOnCodex(root, home, ['engineer', 'orchestrator', 'attention']);
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
    // Pin that doctor actually SAW the relocated attention as a Codex install, and
    // read its hooks from that install.
    strictEqual(report.plugins.attention.cache.codex.status, 'available', 'premise pin: attention is installed on Codex');
    strictEqual(report.plugins.attention.cache.codex.latest.version_dir, '0.4.1', 'premise pin: the relocated build is the one installed');
    strictEqual(report.codex_plugin_hooks.plugin_entries.attention.effective.origin, 'codex_cache', 'premise pin: its hooks were read from the install');
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

    await installSourcePluginsOnCodex(root, home);
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

    await installSourcePluginsOnCodex(root, home, ['engineer', 'orchestrator', 'designer']);
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
    await installSourcePluginsOnCodex(root, home);
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
    // The INSTALLED package's hooks file (ADR-0061 §Decision 4), not the source tree's.
    ok(engineerTarget.hooks_path.endsWith(join('agentic-plugins', 'engineer', '1.0.0', 'hooks', 'hooks.json')), engineerTarget.hooks_path);
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

    await installSourcePluginsOnCodex(root, home);
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

      await installSourcePluginsOnCodex(root, home);
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

    await installSourcePluginsOnCodex(root, home);
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

    await installSourcePluginsOnCodex(root, home);
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

    await installSourcePluginsOnCodex(root, home);
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

    await installSourcePluginsOnCodex(root, home, ['engineer', 'orchestrator'], { engineer: '0.7.0', orchestrator: '0.7.0' });
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

    await installSourcePluginsOnCodex(root, home);
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

    await installSourcePluginsOnCodex(root, home);
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

    await installSourcePluginsOnCodex(root, home);
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

  // ADR-0061 §Decision 4: "an installed package with no hooks is authoritative, and lookup
  // does not fall through to snapshot or source hooks." The source tree AND the marketplace
  // clone both carry engineer hooks here; the installed package carries none.
  it('reads Codex hooks from the installed package alone: a hookless install is authoritative over source and clone hooks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-hookless-install-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root); // engineer + orchestrator SOURCE carry Codex hooks
    await installSourcePluginsOnCodex(root, home, ['orchestrator']);
    // engineer installed WITHOUT hooks.
    await seedCodexInstallCache(home, 'engineer', '1.0.0');
    // The marketplace clone carries engineer hooks too.
    const clone = join(home, '.codex', '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'engineer');
    await cp(join(root, 'plugins', 'engineer'), clone, { recursive: true });
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
      }),
    });
    const engineer = report.codex_plugin_hooks.plugin_entries.engineer;
    strictEqual(engineer.effective.origin, 'codex_cache');
    strictEqual(engineer.effective.status, 'not_packaged', 'the installed package has no hooks, and that is final');
    ok(!('source' in engineer) && !('codex_tmp_marketplace' in engineer), 'no source or clone hook location is consulted');
    deepStrictEqual(report.codex_plugin_hooks.summary.bundled_plugins, ['orchestrator'], 'CONTROL: the installed orchestrator still bundles its hooks');
    deepStrictEqual(report.codex_plugin_hooks.review_targets.map((target) => target.plugin), ['orchestrator']);
  });

  it('names the INSTALLED package version on a hook review target, never the source version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-version-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root); // source engineer 1.0.0
    await installSourcePluginsOnCodex(root, home, ['engineer', 'orchestrator'], { engineer: '0.9.0' });
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
      }),
    });
    const engineerTarget = report.codex_plugin_hooks.review_targets.find((target) => target.plugin === 'engineer');
    strictEqual(engineerTarget.version, '0.9.0');
    ok(engineerTarget.hooks_path.endsWith(join('engineer', '0.9.0', 'hooks', 'hooks.json')), engineerTarget.hooks_path);
  });

  it('never borrows another version\'s hooks when no cache directory holds the listed version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-no-borrowed-hooks-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    // Codex lists engineer 0.3.0; the only engineer cache is a hook-bearing 0.2.0.
    await installSourcePluginsOnCodex(root, home, ['engineer', 'orchestrator'], { engineer: '0.2.0' });
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'codex --version': okResult('codex-cli 0.137.0\n'),
        'codex plugin --help': okResult('Commands:\n  add\n  list\n  marketplace\n  remove\n'),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
        'codex plugin list --json': okResult(JSON.stringify({ installed: [
          { name: 'engineer', marketplaceName: 'agentic-plugins', version: '0.3.0', installed: true, enabled: true },
          { name: 'orchestrator', marketplaceName: 'agentic-plugins', version: '1.0.0', installed: true, enabled: true },
        ] })),
      }),
    });
    strictEqual(report.codex_plugin_hooks.schema_version, 'runtime-codex-plugin-hooks-1.1');
    strictEqual(report.codex_plugin_hooks.plugin_entries.engineer.effective.origin, 'install_cache_unavailable');
    ok(!report.codex_plugin_hooks.review_targets.some((target) => target.plugin === 'engineer'), 'no review target labelled 0.3.0 pointing at 0.2.0 hooks');
    deepStrictEqual(report.codex_plugin_hooks.review_targets.map((target) => target.plugin), ['orchestrator'], 'CONTROL: the matching install still bundles');
    // Unreadable is UNKNOWN, not "no hooks": the surface is not ready, a remedy is named,
    // and lifecycle continuity cannot score satisfied on the readable remainder.
    strictEqual(report.codex_plugin_hooks.plugin_entries.engineer.effective.status, 'install_unreadable');
    deepStrictEqual(report.codex_plugin_hooks.summary.install_unreadable_plugins, ['engineer']);
    strictEqual(report.codex_plugin_hooks.status, 'install_unreadable');
    ok(report.codex_plugin_hooks.recommendations.some((rec) => rec.action === 'restore-codex-install-cache'));
    const lifecycle = report.experience_parity.criteria.find((entry) => entry.id === 'lifecycle_hook_continuity');
    notStrictEqual(lifecycle.status, 'satisfied');
  });

  it('gives a plugin Codex has not installed no hooks, whatever its source carries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-uninstalled-hooks-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    // A stale engineer cache lingers, but the list authoritatively says not installed.
    await installSourcePluginsOnCodex(root, home);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'codex --version': okResult('codex-cli 0.137.0\n'),
        'codex plugin --help': okResult('Commands:\n  add\n  list\n  marketplace\n  remove\n'),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
        'codex plugin list --json': okResult(JSON.stringify({ installed: [
          { name: 'orchestrator', marketplaceName: 'agentic-plugins', version: '1.0.0', installed: true, enabled: true },
        ] })),
      }),
    });
    strictEqual(report.codex_plugin_hooks.plugin_entries.engineer.effective.origin, 'not_installed');
    deepStrictEqual(report.codex_plugin_hooks.summary.bundled_plugins, ['orchestrator']);
  });

  // ADR-0061 §Decision 4: "Where a Codex-hosted caller resolved a sibling from the Claude
  // cache, diagnostics say so." Doctor predicts it from the two install caches.
  it('predicts a Codex-installed caller resolving a sibling from the Claude cache, and says it is a prediction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-sibling-fallback-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    // engineer installed on Codex; runtime only in the CLAUDE cache.
    await seedCodexInstallCache(home, 'engineer', '1.0.0');
    const claudeRuntime = join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'runtime', '0.1.0', '.claude-plugin');
    await mkdir(claudeRuntime, { recursive: true });
    await writeJson(join(claudeRuntime, 'plugin.json'), { name: 'runtime', version: '0.1.0' });
    const report = await runDoctor({ repoRoot: root, homeDir: home, runner: fakeRunner(defaultRuntimeProbeMap()) });
    const siblings = report.codex_install_identity.sibling_resolution;
    match(siblings.basis, /^predicted from the Claude and Codex install caches/);
    const edge = siblings.edges.find((entry) => entry.caller === 'engineer' && entry.sibling === 'runtime');
    strictEqual(edge.predicted_source, 'claude-cache');
    ok(siblings.cross_host.some((entry) => entry.caller === 'engineer' && entry.sibling === 'runtime'));
    const issue = report.host_parity.issues.find((entry) => entry.id === 'codex_sibling_cross_host_fallback');
    ok(issue, 'the cross-host fallback is a parity warning');
    match(issue.evidence, /engineer->runtime/);
    match(formatText(report), /sibling: engineer -> runtime predicted from the Claude cache/);

    // CONTROL: install runtime on Codex too, and the same edge resolves same-host.
    await seedCodexInstallCache(home, 'runtime', '0.1.0');
    const again = await runDoctor({ repoRoot: root, homeDir: home, runner: fakeRunner(defaultRuntimeProbeMap()) });
    strictEqual(again.codex_install_identity.sibling_resolution.edges.find((entry) => entry.caller === 'engineer' && entry.sibling === 'runtime').predicted_source, 'codex-cache');
    ok(!again.host_parity.issues.some((entry) => entry.id === 'codex_sibling_cross_host_fallback' && entry.evidence.includes('engineer->runtime')));
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

    await installSourcePluginsOnCodex(root, home);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
      }),
    });

    strictEqual(report.codex_plugin_hooks.plugin_entries.engineer.effective.origin, 'codex_cache');
    strictEqual(report.codex_plugin_hooks.plugin_entries.engineer.effective.status, 'exposed');
    ok(report.codex_plugin_hooks.plugin_entries.engineer.effective.hooks_file.path.endsWith(join('engineer', '1.0.0', 'adapters', 'codex', 'hooks', 'hooks.json')));
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

    await installSourcePluginsOnCodex(root, home);
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

  // Round 2 (Codex review): an attestation that matches every READABLE hook plugin is not
  // current while another installed plugin's hooks cannot be read — the covered set is
  // unknown. (Without the check, orchestrator-only would read current here.)
  it('stales a /hooks attestation while an installed plugin\'s hooks cannot be read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-hook-review-unreadable-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    await writeTrustedCodexHookStateConfig(home);
    const runId = 'settings-20260925T000000Z-abcdef';
    await mkdir(join(root, '.agentic-plugins', 'runs', 'settings', runId), { recursive: true });
    await writeJson(join(root, '.agentic-plugins', 'runs', 'settings', runId, 'settings.json'), {
      schema_version: 'runtime-settings-execution-artifact-1.0',
      runtime_version: RUNTIME_VERSION,
      run_id: runId,
      status: 'completed',
      created_at: '2026-09-25T00:00:00.000Z',
      updated_at: '2026-09-25T00:00:05.000Z',
      plugin_management: { mode: 'dry-run-plan', requested: false, executed: false, host_filter: 'all', summary: { executed: 0, failed: 0, failed_retryable: 0, failed_non_retryable: 0 } },
      plugin_cleanup: { mode: 'dry-run-plan', requested: false, executed: false, summary: { executed: 0, failed: 0, blocked: 0, failed_retryable: 0, failed_non_retryable: 0 } },
      codex_hook_review: {
        mode: 'operator-attestation',
        requested: true,
        attested: true,
        status: 'attested',
        host: 'codex',
        command: '/hooks',
        attested_at: '2026-09-25T00:00:05.000Z',
        bundled_plugins: ['orchestrator'],
        manifest_exposed_plugins: ['orchestrator'],
        attested_plugins: ['orchestrator'],
        plugin_versions: { orchestrator: '1.0.0' },
        bound_versions: { codex: '0.137.0', plugins: { codex: { orchestrator: '1.0.0' } } },
        plugin_hooks_enabled: true,
        plugin_hooks_stage: 'under development',
      },
      failures: [],
    });
    // engineer listed at 0.3.0; only a 0.2.0 cache exists. orchestrator matches.
    await installSourcePluginsOnCodex(root, home, ['engineer', 'orchestrator'], { engineer: '0.2.0' });
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'codex --version': okResult('codex-cli 0.137.0\n'),
        'codex plugin --help': okResult('Commands:\n  add\n  list\n  marketplace\n  remove\n'),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development true\nplugins stable true\nmulti_agent stable true\n'),
        'codex plugin list --json': okResult(JSON.stringify({ installed: [
          { name: 'engineer', marketplaceName: 'agentic-plugins', version: '0.3.0', installed: true, enabled: true },
          { name: 'orchestrator', marketplaceName: 'agentic-plugins', version: '1.0.0', installed: true, enabled: true },
        ] })),
      }),
    });
    deepStrictEqual(report.codex_plugin_hooks.summary.bundled_plugins, ['orchestrator'], 'the premise: the attested set equals the readable bundled set');
    strictEqual(report.settings_runs.codex_hook_review.current, false);
    strictEqual(report.settings_runs.codex_hook_review.currency_reason, 'installed_hooks_unreadable');
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

    await installSourcePluginsOnCodex(root, home);
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

    await installSourcePluginsOnCodex(root, home);
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

  // ADR-0060 §Decision 3 — `runtime_handoff_artifacts` is recomposed from
  // settings + consensus + compat to settings + consensus, at weight 15. The
  // cases below pin the three rows of the matrix the criterion now states, and
  // that a compat collection on disk no longer reaches it at all.
  it('recomposes runtime_handoff_artifacts from settings and consensus only (ADR-0060)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-handoff-recomposed-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    // A MALFORMED compat run. Before ADR-0060 this blocked the criterion; now
    // nothing reads the collection, so it must not reach the verdict.
    const orphan = join(root, '.agentic-plugins', 'runs', 'compat', 'compat-20260828T000000Z-abcdef');
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, 'snapshot.json'), '{ not json');

    const report = await runDoctor({ repoRoot: root, homeDir: home, runner: fakeRunner(defaultRuntimeProbeMap()) });
    strictEqual(Object.hasOwn(report, 'compat_runs'), false, 'the report no longer carries a compat collection');
    strictEqual(Object.hasOwn(report, 'host_parity_baseline'), false, 'nor a baseline verdict');
    strictEqual(report.settings_runs.status, 'missing');
    const handoff = report.experience_parity.criteria.find((entry) => entry.id === 'runtime_handoff_artifacts');
    strictEqual(handoff.weight, 15, 'recomposed at unchanged weight');
    strictEqual(handoff.status, 'partial', 'a missing collection is partial — and the malformed compat run is not a block');
    strictEqual(handoff.next_step, 'Run settings/consensus flows when needed so future host handoffs have artifact evidence.');
    ok(!/compat/i.test(`${handoff.label} ${handoff.evidence} ${handoff.next_step}`), `${handoff.label} | ${handoff.evidence} | ${handoff.next_step}`);
    ok(!/runtime:compat|baseline-freshness|Compatibility Artifacts/.test(formatText(report)), 'the text output names no compatibility surface');
  });

  it('blocks runtime_handoff_artifacts on a malformed settings artifact, and is satisfied when both collections read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-handoff-matrix-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const settingsDir = join(root, '.agentic-plugins', 'runs', 'settings', 'settings-20260828T000000Z-abcdef');
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, 'settings.json'), '{ not json');
    await mkdir(join(root, '.agentic-plugins', 'runs', 'consensus'), { recursive: true });

    const blocked = await runDoctor({ repoRoot: root, homeDir: home, runner: fakeRunner(defaultRuntimeProbeMap()) });
    const blockedCriterion = blocked.experience_parity.criteria.find((entry) => entry.id === 'runtime_handoff_artifacts');
    strictEqual(blocked.settings_runs.status, 'blocked');
    strictEqual(blockedCriterion.status, 'blocked');
    strictEqual(blockedCriterion.next_step, 'Repair malformed runtime artifacts before relying on handoff and consensus history.');

    // CONTROL: a readable settings artifact and an existing (empty) consensus
    // collection satisfy the criterion — `empty` is readable.
    await writeFile(join(settingsDir, 'settings.json'), JSON.stringify({ status: 'completed', terminal: true }));
    const satisfied = await runDoctor({ repoRoot: root, homeDir: home, runner: fakeRunner(defaultRuntimeProbeMap()) });
    const satisfiedCriterion = satisfied.experience_parity.criteria.find((entry) => entry.id === 'runtime_handoff_artifacts');
    strictEqual(satisfied.consensus_runs.status, 'empty');
    strictEqual(satisfiedCriterion.status, 'satisfied');
    strictEqual(satisfiedCriterion.next_step, null);
  });

  // The two halves the cases above leave open, both found in review: each case
  // there moves the settings collection, so a criterion that ignored a blocked
  // CONSENSUS collection, or needed BOTH collections missing before reading
  // partial, still passed them. Before ADR-0060 the compat collection's presence
  // happened to cover the second half.
  it('blocks runtime_handoff_artifacts on a blocked consensus collection alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-handoff-consensus-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const settingsDir = join(root, '.agentic-plugins', 'runs', 'settings', 'settings-20260828T000000Z-abcdef');
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, 'settings.json'), JSON.stringify({ status: 'completed', terminal: true }));
    // Readable JSON with no status string: the consensus reader counts it
    // malformed and blocks the collection.
    const consensusDir = join(root, '.agentic-plugins', 'runs', 'consensus', 'consensus-20260828T000000Z-abcdef');
    await mkdir(consensusDir, { recursive: true });
    await writeFile(join(consensusDir, 'execution.json'), JSON.stringify({ summary: {} }));

    const report = await runDoctor({ repoRoot: root, homeDir: home, runner: fakeRunner(defaultRuntimeProbeMap()) });
    const criterion = report.experience_parity.criteria.find((entry) => entry.id === 'runtime_handoff_artifacts');
    strictEqual(report.settings_runs.status, 'available', 'the settings half is readable, so only consensus can block');
    strictEqual(report.consensus_runs.status, 'blocked');
    strictEqual(criterion.status, 'blocked');
  });

  it('reads runtime_handoff_artifacts as partial when exactly one collection is missing, in either direction', async () => {
    for (const present of ['settings', 'consensus']) {
      const root = await mkdtemp(join(tmpdir(), `runtime-doctor-handoff-only-${present}-`));
      const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
      await seedRepo(root);
      if (present === 'settings') {
        const settingsDir = join(root, '.agentic-plugins', 'runs', 'settings', 'settings-20260828T000000Z-abcdef');
        await mkdir(settingsDir, { recursive: true });
        await writeFile(join(settingsDir, 'settings.json'), JSON.stringify({ status: 'completed', terminal: true }));
      } else {
        await mkdir(join(root, '.agentic-plugins', 'runs', 'consensus'), { recursive: true });
      }

      const report = await runDoctor({ repoRoot: root, homeDir: home, runner: fakeRunner(defaultRuntimeProbeMap()) });
      const criterion = report.experience_parity.criteria.find((entry) => entry.id === 'runtime_handoff_artifacts');
      const other = present === 'settings' ? report.consensus_runs : report.settings_runs;
      const own = present === 'settings' ? report.settings_runs : report.consensus_runs;
      strictEqual(other.status, 'missing', `only ${present} exists`);
      ok(own.status !== 'missing' && own.status !== 'blocked', `${present} reads: ${own.status}`);
      strictEqual(criterion.status, 'partial', `one missing collection is partial (${present} present)`);
    }
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

  // ADR-0047 §7 — doctor adopts the retention actionable/pinned split: a
  // registry family over cap ONLY because its runs are pinned is informational,
  // not a fault.
  it('demotes a pinned-only over-cap registry family out of the retention-guidance warning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-retention-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    // A real git repo so the citation scan's `git ls-files` succeeds.
    execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'ignore' });
    // settings is the one deletable registry family since ADR-0060 removed
    // compat, which was this case's specimen. Each run carries a TERMINAL
    // artifact, so the citation is the only thing pinning it.
    const settingsA = 'settings-20260101T000000Z-000001';
    const settingsB = 'settings-20260102T000000Z-000002';
    for (const runId of [settingsA, settingsB]) {
      await mkdir(join(root, '.agentic-plugins', 'runs', 'settings', runId), { recursive: true });
      await writeFile(join(root, '.agentic-plugins', 'runs', 'settings', runId, 'settings.json'), JSON.stringify({ status: 'completed', terminal: true }));
    }
    // A TRACKED doc citing BOTH runs → both pinned → the whole overage is pinned.
    await writeFile(join(root, 'CITES.md'), `pinned: ${settingsA} ${settingsB}\n`);
    execFileSync('git', ['-C', root, 'add', 'CITES.md'], { stdio: 'ignore' });

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      artifactInventory: true,
      artifactRetentionCap: 1, // 2 runs over a cap of 1
      now: new Date('2026-07-21T00:00:00.000Z'),
      runner: fakeRunner(defaultRuntimeProbeMap()),
    });

    strictEqual(report.retention.executed, true);
    strictEqual(report.retention.scan_complete, true);
    strictEqual(report.retention.projection.settings.over_cap, true);
    strictEqual(report.retention.projection.settings.actionable, 0);
    strictEqual(report.retention.projection.settings.pinned_overage, 2);
    ok(report.retention.reconciled.demoted.some((d) => d.family === 'settings'));
    // The fault warning must NOT fire — the overage is entirely pinned.
    ok(!report.overall.warnings.includes('runtime artifact inventory exceeds retention guidance'),
      `pinned-only overage must not raise a fault; warnings=${JSON.stringify(report.overall.warnings)}`);
    const text = formatText(report);
    ok(text.includes('Runtime Retention Plan'));
    ok(text.includes('retention-informational: settings/pinned_overage'));
    // The raw inventory block must NOT also render the demoted overage as a
    // fault-with-removal-recommendation (Codex review MAJOR — the double render
    // would tell the operator to delete pinned evidence).
    ok(!text.includes('retention-attention: settings/run_count_exceeds_cap'),
      'a demoted pinned-only overage must not also render as a raw removal fault');
  });

  it('keeps the retention-guidance warning when a registry family has genuine actionable overage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-retention-actionable-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'ignore' });
    // Two OLD settings runs, NEITHER pinned → both actionable over a cap of 1.
    // Each carries a TERMINAL artifact; without it a settings run is pinned.
    // Backdate their mtime well before the injected `now` so they clear the
    // minimum-age guard (a fresh run is never a candidate).
    const oldStamp = new Date('2026-07-01T00:00:00.000Z');
    for (const runId of ['settings-20260101T000000Z-000001', 'settings-20260102T000000Z-000002']) {
      const dir = join(root, '.agentic-plugins', 'runs', 'settings', runId);
      await mkdir(dir, { recursive: true });
      const f = join(dir, 'settings.json');
      await writeFile(f, JSON.stringify({ status: 'completed', terminal: true }));
      await utimes(f, oldStamp, oldStamp);
      await utimes(dir, oldStamp, oldStamp);
    }
    await writeFile(join(root, 'README.md'), 'no citations here\n');
    execFileSync('git', ['-C', root, 'add', 'README.md'], { stdio: 'ignore' });

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      artifactInventory: true,
      artifactRetentionCap: 1,
      now: new Date('2026-07-21T00:00:00.000Z'),
      runner: fakeRunner(defaultRuntimeProbeMap()),
    });
    strictEqual(report.retention.executed, true);
    ok(report.retention.projection.settings.actionable >= 1);
    ok(report.overall.warnings.includes('runtime artifact inventory exceeds retention guidance'),
      `actionable overage must raise the fault; warnings=${JSON.stringify(report.overall.warnings)}`);
  });

  it('still inventories the RETIRED permission advisory family (ADR-0057 §Decision 7) and excludes its latest.json singleton from run counts', async () => {
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

    // ⚠ MEASURED AS INSUFFICIENT ON ITS OWN (cross-host review of this removal):
    // everything above still passes if `permission` is dropped from the explicit
    // registry, because `inspectRuntimeArtifactInventory` runs with
    // `discoverUnknownFamilies: true` and gives a discovered family the same cap.
    // That is exactly what ADR-0057 §Decision 7 says — the registration is
    // DOCUMENTATION, not behaviour — so the declaration needs its own assertion or
    // the decision is unpinned. Read from the source, since the list is module-private.
    const stateReaders = await readFile(new URL('../../plugins/runtime/scripts/lib/state-readers.mjs', import.meta.url), 'utf-8');
    const declared = stateReaders.match(/^const RUNTIME_ARTIFACT_FAMILIES = \[(.+?)\];$/m);
    ok(declared, 'the family registry is a single literal array (the shape this assertion reads)');
    ok(/'permission'/.test(declared[1]),
      'the retired permission family stays DECLARED rather than being silently discovered (ADR-0057 §Decision 7)');
    // The whole registry, so a removal is a visible edit here: ADR-0064 Decision 1
    // took the `notification` and `egress-launcher` families out with their
    // producers, and their retained runs are discovered like any unlisted family.
    deepStrictEqual(
      declared[1].split(',').map((entry) => entry.trim().replace(/^'|'$/g, '')),
      ['compat', 'consensus', 'context', 'settings', 'doctor', 'permission'],
    );
  });

  // ADR-0064 Decision 4 removed `--sandbox-permission-probe`. The report keeps no
  // `sandbox_permission_probe` section and no per-direction `sandbox_permission`
  // member; companion permission evidence comes only from the permission proof's
  // preflight, which reads `unknown` until --permission-proof is requested.
  it('reports no sandbox probe and leaves permission readiness to the explicit permission proof', async () => {
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
    strictEqual(Object.hasOwn(report, 'sandbox_permission_probe'), false);
    for (const key of ['claude_to_codex', 'codex_to_claude']) {
      strictEqual(Object.hasOwn(report.readiness[key], 'sandbox_permission'), false, `readiness.${key}`);
      strictEqual(Object.hasOwn(report.readiness_matrix.directions[key], 'sandbox_permission'), false, `readiness_matrix.directions.${key}`);
      strictEqual(report.permission_proof.directions[key].preflight.status, 'unknown', key);
      ok(report.readiness[key].warnings.includes('companion permission readiness is not checked until --permission-proof is requested'), key);
    }
    strictEqual(report.permission_proof.requested, false);
    strictEqual(report.permission_proof.executed, false);
    const text = formatText(report);
    ok(!text.includes('Sandbox Permission Probe'));
    ok(!/sandbox-permission/.test(text), 'the text report names no sandbox-permission status');
  });

  it('plans permission proof as an explicit preflight without executing peers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-permission-proof-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    await seedCompanionCaches(home);
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
    await seedCompanionCaches(home);
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
    await seedCompanionCaches(home);
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
    await seedCompanionCaches(home);
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
    await seedCompanionCaches(home);
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
    await seedCompanionCaches(home);
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
    // Canonical: the resolver returns canonical roots (ADR-0061 S2).
    const home = await realpath(await mkdtemp(join(tmpdir(), 'runtime-doctor-consumer-home-')));
    await seedRepo(root);
    await seedCompanionCaches(home);
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

  it('reads BOTH doctor schema eras — the retained corpus does not become a fault', async () => {
    // ADR-0056 §Decision 5 + §Consequences. ⚠ THE ONE SEQUENCING RULE THAT
    // CANNOT BE DEFERRED: `inspectDoctorRuns` scans EVERY retained
    // `doctor.json`, a rejected artifact increments `malformed`, and
    // `status: malformed > 0 ? 'blocked' : …` means no fresh proof ever clears
    // it. A producer bumped without a reader for the OLD version turns the whole
    // corpus into a fault with no operator path back — measured at
    // `blocked malformed=70` on the real corpus when this was last considered.
    //
    // Driven through `runDoctor` rather than the private reader, because that is
    // the caller the rule is about.
    const root = await mkdtemp(join(tmpdir(), 'doctor-dual-'));
    const home = await mkdtemp(join(tmpdir(), 'doctor-dual-home-'));
    const seedRun = async (runId, artifactSchema, reportSchema) => {
      const dir = join(root, '.agentic-plugins', 'runs', 'doctor', runId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'doctor.json'), JSON.stringify({
        schema_version: artifactSchema,
        run_id: runId,
        runtime_version: RUNTIME_VERSION,
        status: 'recorded',
        generated_at: '2026-08-20T00:00:00.000Z',
        report: { schema_version: reportSchema },
      }));
    };
    // A MIXED corpus: a machine that upgraded mid-corpus keeps both versions in
    // one directory, and that is the cell a reader taught only the new version
    // measures as `malformed=1 count=2`.
    await seedRun('doctor-20260820T000000Z-aaaaaa', 'runtime-doctor-artifact-1.0', 'runtime-doctor-1.0');
    await seedRun('doctor-20260821T000000Z-bbbbbb', 'runtime-doctor-artifact-1.1', 'runtime-doctor-1.1');
    // Every era this reader has to read, not only the two the ADR-0056 case
    // started with: 1.2 (ADR-0057), 1.3 (ADR-0060) and 1.4 (ADR-0064) each
    // dropped report sections, and a retained artifact of any must not turn
    // malformed.
    await seedRun('doctor-20260821T010000Z-eeeeee', 'runtime-doctor-artifact-1.2', 'runtime-doctor-1.2');
    await seedRun('doctor-20260821T020000Z-ffffff', 'runtime-doctor-artifact-1.3', 'runtime-doctor-1.3');
    await seedRun('doctor-20260821T030000Z-a1b2c3', 'runtime-doctor-artifact-1.4', 'runtime-doctor-1.4');

    const report = await runDoctor({ repoRoot: root, homeDir: home, runner: fakeRunner(defaultRuntimeProbeMap()) });
    strictEqual(report.doctor_runs.count, 5);
    strictEqual(report.doctor_runs.malformed, 0, 'neither era may be counted malformed');
    strictEqual(report.doctor_runs.status, 'available');

    // ⚠ A MIXED TUPLE IS REFUSED, and it needed its own case: replacing the
    // matched-pair predicate with two independent allowlists turned no test red
    // until this one existed. Outer and inner bump together, so `(artifact-1.1,
    // report-1.0)` is a shape no producer writes — corrupt or hand-edited, and
    // refusing it is the predicate's job.
    await seedRun('doctor-20260822T000000Z-cccccc', 'runtime-doctor-artifact-1.1', 'runtime-doctor-1.0');
    const withMixed = await runDoctor({ repoRoot: root, homeDir: home, runner: fakeRunner(defaultRuntimeProbeMap()) });
    strictEqual(withMixed.doctor_runs.malformed, 1, 'a mixed tuple must count as malformed');
    strictEqual(withMixed.doctor_runs.status, 'blocked');

    // CONTROL: a genuinely unknown version IS malformed and DOES block. Without
    // it, the assertions above would pass against a reader that accepts
    // anything — the opposite defect, and the one the exact-pin rule prevents.
    await seedRun('doctor-20260823T000000Z-dddddd', 'runtime-doctor-artifact-9.9', 'runtime-doctor-9.9');
    const withUnknown = await runDoctor({ repoRoot: root, homeDir: home, runner: fakeRunner(defaultRuntimeProbeMap()) });
    ok(withUnknown.doctor_runs.malformed > 0, 'an unread version must count as malformed');
    strictEqual(withUnknown.doctor_runs.status, 'blocked');
  });

  it('records reusable doctor proof artifacts and reuses them when current versions match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-recorded-proof-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    await seedCompanionCaches(home);
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
    await seedCompanionCaches(home);
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

  // ADR-0061 §Decision 4: a version is not content identity. A proof recorded against the
  // pinned bytes is not reused once the installed bytes diverge under the same version.
  it('invalidates a recorded doctor proof when the installed bytes stop matching the pin, and keeps it when they do not', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-proof-identity-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-proof-identity-home-'));
    await seedRepo(root);
    await seedCompanionCaches(home);
    const { clone, c1 } = await buildClone();
    await writeCatalog(clone, [pinned('runtime', '0.1.0', c1)]);
    const installed = await installFromClone(clone, c1, join(home, '.codex'), '0.1.0');
    const list = okResult(JSON.stringify({ installed: [{ name: 'runtime', marketplaceName: 'agentic-plugins', version: '0.1.0', installed: true, enabled: true }] }));
    const base = proofRunnerWithCodexList(list);
    const registration = okResult(JSON.stringify([
      { name: 'agentic-plugins', marketplaceSource: { sourceType: 'git', source: 'https://github.com/each4all/agentic-plugins.git' }, installLocation: clone },
    ]));
    const runner = async (command, args, options = {}) => {
      if (command === 'git' && args.includes('ls-tree')) {
        try {
          return okResult(execFileSync('git', args, { cwd: options.cwd, env: options.env, encoding: 'utf8' }));
        } catch (err) {
          return { ok: false, exit_code: err.status ?? 1, stdout: '', stderr: '', error_code: null };
        }
      }
      if (`${command} ${args.join(' ')}` === 'codex plugin marketplace list --json') return registration;
      return base(command, args, options);
    };
    const runId = 'doctor-20260925T000000Z-1d0001';
    const first = await runDoctor({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-09-25T00:00:00.000Z'),
      permissionProof: true,
      executePermissionProof: true,
      deepPeerSmoke: true,
      executeDeepPeerSmoke: true,
      workflowContinuationProof: true,
      executeWorkflowContinuationProof: true,
      recordArtifact: true,
      runId,
      runner,
    });
    strictEqual(first.permission_proof.status, 'passed');
    strictEqual(first.plugins.runtime.codex_install.currentness, 'current', 'the premise: the recorded run saw the pinned bytes');

    // CONTROL: nothing changed, so the recorded proof is reusable.
    const same = await runDoctor({ repoRoot: root, homeDir: home, now: new Date('2026-09-25T00:05:00.000Z'), runner });
    strictEqual(same.recorded_doctor_proof.status, 'reusable', same.recorded_doctor_proof.reasons.join('; '));

    // Same version, one file changed.
    await writeFile(join(installed, 'scripts', 'a.mjs'), 'export const v = "main";\n');
    const diverged = await runDoctor({ repoRoot: root, homeDir: home, now: new Date('2026-09-25T00:10:00.000Z'), runner });
    strictEqual(diverged.plugins.runtime.installed.codex_resolved.version, '0.1.0', 'the version did not move');
    strictEqual(diverged.recorded_doctor_proof.status, 'not_reusable');
    ok(diverged.recorded_doctor_proof.reasons.some((reason) => reason.includes('runtime codex install does not match the tree its catalog pins')), diverged.recorded_doctor_proof.reasons.join('; '));
    ok(diverged.recorded_doctor_proof.reasons.some((reason) => reason.includes('runtime codex_content mismatch')));
  });

  // Round 2 (Codex review): two unverified reads agree on nothing. A pinned install whose
  // bytes cannot be checked must not keep a proof reusable just because both runs were null.
  for (const [label, sha, listRow] of [
    ['the pinned commit is missing from the clone', 'b'.repeat(40), { version: '0.1.0' }],
    // Round 3 (Codex review): a list row that carries no version is no exemption.
    ['the Codex list gives no installed version', null, {}],
  ]) {
  it(`does not reuse a recorded proof for a pinned install whose bytes cannot be verified: ${label}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-proof-unverified-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-proof-unverified-home-'));
    await seedRepo(root);
    await seedCompanionCaches(home);
    const { clone, c1 } = await buildClone();
    await writeCatalog(clone, [pinned('runtime', '0.1.0', sha ?? c1)]);
    await installFromClone(clone, c1, join(home, '.codex'), '0.1.0');
    const list = okResult(JSON.stringify({ installed: [{ name: 'runtime', marketplaceName: 'agentic-plugins', ...listRow, installed: true, enabled: true }] }));
    const base = proofRunnerWithCodexList(list);
    const registration = okResult(JSON.stringify([
      { name: 'agentic-plugins', marketplaceSource: { sourceType: 'git', source: 'https://github.com/each4all/agentic-plugins.git' }, installLocation: clone },
    ]));
    const runner = async (command, args, options = {}) => {
      if (command === 'git' && args.includes('ls-tree')) {
        try {
          return okResult(execFileSync('git', args, { cwd: options.cwd, env: options.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
        } catch (err) {
          return { ok: false, exit_code: err.status ?? 1, stdout: '', stderr: '', error_code: null };
        }
      }
      if (`${command} ${args.join(' ')}` === 'codex plugin marketplace list --json') return registration;
      return base(command, args, options);
    };
    const first = await runDoctor({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-09-25T00:00:00.000Z'),
      permissionProof: true,
      executePermissionProof: true,
      deepPeerSmoke: true,
      executeDeepPeerSmoke: true,
      workflowContinuationProof: true,
      executeWorkflowContinuationProof: true,
      recordArtifact: true,
      runId: `doctor-20260925T000000Z-1d000${sha ? 2 : 3}`,
      runner,
    });
    strictEqual(first.plugins.runtime.codex_install.content_identity.verified, false, 'the premise');
    const second = await runDoctor({ repoRoot: root, homeDir: home, now: new Date('2026-09-25T00:05:00.000Z'), runner });
    strictEqual(second.recorded_doctor_proof.status, 'not_reusable');
    ok(second.recorded_doctor_proof.reasons.some((reason) => reason.includes('runtime codex install is not verified against its catalog pin')), second.recorded_doctor_proof.reasons.join('; '));
  });
  }

  it('keeps a cache-recorded proof reusable when a list-capable codex later reports the same version (ADR-0034)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-proof-legacy-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-proof-legacy-home-'));
    await seedRepo(root);
    await seedCompanionCaches(home);
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
    // companions is listed too: seedCompanionCaches put 1.0.0 in the Codex cache,
    // so the first run recorded it from there.
    const sameVersionList = okResult(JSON.stringify({ installed: [
      { name: 'runtime', marketplaceName: 'agentic-plugins', version: '0.1.0', installed: true, enabled: true },
      { name: 'companions', marketplaceName: 'agentic-plugins', version: '1.0.0', installed: true, enabled: true },
    ] }));
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
    await seedCompanionCaches(home);
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
    await seedCompanionCaches(home);
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
    await seedCompanionCaches(home);
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
    const opts = parseArgs(['--repo-root', '/tmp/repo', '--format', 'json', '--host', 'codex', '--model', 'm', '--effort', 'high', '--deep-peer-smoke', '--execute-deep-peer-smoke', '--deep-peer-smoke-timeout-ms', '90000', '--permission-proof', '--execute-permission-proof', '--permission-proof-timeout-ms', '45000', '--workflow-continuation-proof', '--execute-workflow-continuation-proof', '--workflow-continuation-proof-timeout-ms', '60000', '--artifact-inventory', '--artifact-retention-cap', '30', '--artifact-max-bytes', '1024', '--record', '--run-id', 'doctor-20260513T000000Z-abc123']);
    strictEqual(opts.repoRoot, '/tmp/repo');
    strictEqual(opts.format, 'json');
    strictEqual(opts.host, 'codex');
    strictEqual(opts.explicitModel, 'm');
    strictEqual(opts.explicitEffort, 'high');
    strictEqual(opts.deepPeerSmoke, true);
    strictEqual(opts.executeDeepPeerSmoke, true);
    strictEqual(opts.deepPeerSmokeTimeoutMs, 90000);
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

  // ADR-0064 Decision 1 removed the egress ack proof, and Decision 4 the sandbox
  // permission probe. Their three flags are now unknown arguments: refused at parse
  // time, before a single probe runs, so an old invocation cannot pass as a plain
  // diagnosis. The fake host CLIs on PATH record every call, and the CONTROL run
  // proves they would have seen a doctor that ran.
  it('refuses the removed egress ack proof and sandbox probe flags as unknown arguments, before any probe runs', async () => {
    for (const flag of ['--egress-ack-proof', '--execute-egress-ack-proof', '--sandbox-permission-probe']) {
      throws(() => parseArgs([flag]), new RegExp(`^Error: Unknown argument: ${flag}$`));
    }
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-removed-flags-'));
    const repo = join(root, 'repo');
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const marker = join(root, 'host-cli-calls.log');
    await mkdir(repo, { recursive: true });
    await mkdir(home, { recursive: true });
    await mkdir(bin, { recursive: true });
    for (const cli of ['claude', 'codex']) {
      await writeFile(join(bin, cli), `#!/bin/sh\necho "${cli} $*" >> "${marker}"\n`, { mode: 0o755 });
    }
    const doctorScript = fileURLToPath(new URL('../../plugins/runtime/scripts/doctor.mjs', import.meta.url));
    const runCli = (args) => spawnSync(process.execPath, [doctorScript, '--repo-root', repo, '--format', 'json', ...args], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
      encoding: 'utf8',
      timeout: 60000,
    });
    for (const args of [['--egress-ack-proof'], ['--egress-ack-proof', '--execute-egress-ack-proof'], ['--sandbox-permission-probe']]) {
      const result = runCli(args);
      strictEqual(result.status, 2, `${args.join(' ')} exits invalid-usage: ${result.stderr}`);
      match(result.stderr, new RegExp(`Unknown argument: ${args[0]}`));
      strictEqual(result.stdout, '', 'no report is written');
      strictEqual(existsSync(marker), false, `${args.join(' ')} ran a host-CLI probe`);
    }
    // CONTROL: the same harness without the removed flag runs doctor, and the marker
    // records its probes. Without it, an absent marker would prove nothing.
    const control = runCli([]);
    ok([0, 10].includes(control.status), `control doctor run finished with a report: ${control.status} ${control.stderr}`);
    strictEqual(JSON.parse(control.stdout).schema_version, 'runtime-doctor-1.4');
    match(await readFile(marker, 'utf8'), /^claude --version$/m);
  });

  it('records an atomic 1.4 artifact whose artifact_sha256 matches the bytes on disk, with no egress_ack_proof section', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-record-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      format: 'json',
      recordArtifact: true,
      runner: fakeRunner(defaultRuntimeProbeMap()),
    });
    strictEqual(report.schema_version, 'runtime-doctor-1.4');
    strictEqual(Object.hasOwn(report, 'egress_ack_proof'), false, 'ADR-0064 Decision 1 removed the section');
    deepStrictEqual(report.effects, { host_config_mutated: false, network_request_performed: false });
    const artifact = report.doctor_artifact;
    strictEqual(artifact.written, true);
    ok(/^[0-9a-f]{64}$/.test(artifact.artifact_sha256), 'artifact_sha256 is returned');
    const bytes = await readFile(join(root, artifact.artifact_pointer));
    strictEqual(createHash('sha256').update(bytes).digest('hex'), artifact.artifact_sha256, 'the hash is over the EXACT bytes on disk');
    const stored = JSON.parse(bytes.toString('utf8'));
    strictEqual(stored.schema_version, 'runtime-doctor-artifact-1.4');
    strictEqual(stored.report.schema_version, 'runtime-doctor-1.4');
    strictEqual(Object.hasOwn(stored.report, 'egress_ack_proof'), false);
    // No stray temp file left behind by the atomic write.
    const runDirEntries = await readdir(join(root, '.agentic-plugins', 'runs', 'doctor', artifact.run_id));
    deepStrictEqual(runDirEntries.filter((n) => n.endsWith('.tmp')), []);
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

  // The fallback decision used to explain itself with ONE label, `list_probe_status`,
  // and that label inferred `unsupported` for every list command failure except ENOENT.
  // doctor-20260912T223726Z-a4b168 recorded `plugin_list_command_status`
  // blocked/ETIMEDOUT beside `list_probe_status` `unsupported`, so a timed-out read
  // looked like a Codex without the subcommand. What the command did and what parsing
  // its output found are different facts, so each now has its own field and neither is
  // inferred (ADR-0034, Amendment 2026-09-15).
  const assertFallback = (report, { command, parse }) => {
    for (const name of PLUGIN_NAMES) {
      const resolved = report.plugins[name].installed.codex_resolved;
      strictEqual(resolved.decision, 'fallback', `${name}: a list that is not authoritative falls back to the cache`);
      deepStrictEqual(resolved.list_command_status, command, `${name}: the list command outcome is recorded as observed`);
      strictEqual(resolved.list_parse_status, parse, `${name}: the parse outcome is recorded in its own field`);
      ok(!('list_probe_status' in resolved), `${name}: the inferred single label is no longer written`);
    }
    // One vocabulary, not two: the decision's copy is the triple the redacted command
    // record already carries.
    deepStrictEqual(report.clis.codex.plugin_list_command_status, command);
  };

  const commandFailures = [
    {
      title: 'a timed-out list command is recorded as blocked/ETIMEDOUT, not as unsupported',
      // The partial stdout is a complete list naming runtime as enabled. A command that
      // did not succeed is never parsed, so its output cannot become list authority.
      result: { ok: false, exit_code: null, stdout: listJson([codexEntry('runtime')]), stderr: '', error_code: 'ETIMEDOUT', timed_out: true },
      command: { status: 'blocked', exit_code: null, error_code: 'ETIMEDOUT' },
    },
    {
      title: 'a list command that exits nonzero is recorded with its exit code, not as unsupported',
      result: { ok: false, exit_code: 2, stdout: '', stderr: 'error: unrecognized subcommand \'list\'', error_code: null, timed_out: false },
      command: { status: 'unknown', exit_code: 2, error_code: null },
    },
    {
      title: 'a list command whose binary is missing is recorded as unavailable/ENOENT',
      result: enoent('codex'),
      command: { status: 'unavailable', exit_code: null, error_code: 'ENOENT' },
    },
  ];
  for (const { title, result, command } of commandFailures) {
    it(title, async () => {
      const { root, home } = await mkdirs();
      await seedRepo(root);
      await seedHome(home);
      const report = await runDoctor({ repoRoot: root, homeDir: home, runner: fakeRunner(codex137(result)) });
      assertFallback(report, { command, parse: null });
      // Consumer behaviour is unchanged: the readiness row still resolves from the cache.
      strictEqual(report.readiness_matrix.hosts.codex.installed.status, 'installed');
      strictEqual(report.readiness_matrix.hosts.codex.installed.evidence, 'codex plugin cache contains runtime');
    });
  }

  it('a list command that never ran (Codex CLI unavailable) is recorded as skipped', async () => {
    const { root, home } = await mkdirs();
    await seedRepo(root);
    await seedHome(home);
    const report = await runDoctor({
      repoRoot: root, homeDir: home,
      runner: fakeRunner({ ...codex137(okResult(listJson([codexEntry('runtime')]))), 'codex --version': enoent('codex') }),
    });
    assertFallback(report, { command: { status: 'unknown', exit_code: null, error_code: 'skipped' }, parse: null });
  });

  // On a command that succeeded, the parse outcome is what explains the fallback, and
  // the command outcome says the command itself was fine.
  const parseFailures = [
    { output: 'empty', stdout: '', parse: 'empty' },
    { output: 'not JSON', stdout: 'this is not json{', parse: 'parse_error' },
    { output: 'JSON without an installed array', stdout: JSON.stringify({ plugins: [] }), parse: 'malformed' },
  ];
  for (const { output, stdout, parse } of parseFailures) {
    it(`a successful list command whose output is ${output} records parse outcome ${parse}`, async () => {
      const { root, home } = await mkdirs();
      await seedRepo(root);
      await seedHome(home);
      const report = await runDoctor({ repoRoot: root, homeDir: home, runner: fakeRunner(codex137(okResult(stdout))) });
      assertFallback(report, { command: { status: 'available', exit_code: 0, error_code: null }, parse });
    });
  }

  it('CONTROL: an authoritative list decides from the list and carries neither fallback field', async () => {
    const { root, home } = await mkdirs();
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root, homeDir: home,
      runner: fakeRunner(codex137(okResult(listJson([codexEntry('runtime')])))),
    });
    const resolved = report.plugins.runtime.installed.codex_resolved;
    strictEqual(resolved.decision, 'installed');
    strictEqual(resolved.source, 'list');
    ok(!('list_command_status' in resolved) && !('list_parse_status' in resolved), 'the fallback fields describe only a fallback');
    deepStrictEqual(report.clis.codex.plugin_list_command_status, { status: 'available', exit_code: 0, error_code: null });
  });

  // ADR-0034 §Decision 5, over the RECORDED bytes rather than one report section:
  // every fallback decision now carries a copy of the command outcome, which is a new
  // place raw list output could ride along.
  it('the recorded artifact carries list codes only, never raw list stdout or stderr', async () => {
    const LIST_SENTINEL = 'C11-RAW-LIST-OUTPUT-SENTINEL';
    const CONTROL_SENTINEL = 'C11-RETAINED-VERSION-TEXT';
    const cases = [
      ['failed', 'doctor-20260915T000000Z-c11a01', { ok: false, exit_code: null, stdout: `{"installed":[{"name":"runtime","note":"${LIST_SENTINEL}"`, stderr: `warning: ${LIST_SENTINEL}`, error_code: 'ETIMEDOUT', timed_out: true }],
      ['succeeded', 'doctor-20260915T000100Z-c11a02', okResult(listJson([{ ...codexEntry('runtime'), source: { source: 'local', path: `/x/${LIST_SENTINEL}/runtime` } }]), `warning: ${LIST_SENTINEL}`)],
    ];
    for (const [label, runId, listResult] of cases) {
      const { root, home } = await mkdirs();
      await seedRepo(root);
      const report = await runDoctor({
        repoRoot: root, homeDir: home, now: new Date('2026-09-15T00:00:00.000Z'), recordArtifact: true, runId,
        runner: fakeRunner({ ...codex137(listResult), 'codex --version': okResult(`codex-cli 0.137.0 ${CONTROL_SENTINEL}\n`) }),
      });
      strictEqual(report.doctor_artifact.written, true, `${label}: the artifact is recorded`);
      const recorded = await readFile(join(root, '.agentic-plugins', 'runs', 'doctor', runId, 'doctor.json'), 'utf8');
      // CONTROL: probe text the report does keep reaches these bytes, so the absence
      // below is a scrub and not a reader that cannot see runner output.
      ok(recorded.includes(CONTROL_SENTINEL), `${label}: retained probe text must reach the recorded artifact`);
      ok(!recorded.includes(LIST_SENTINEL), `${label}: raw codex plugin list output must never reach the recorded artifact`);
    }
  });
});

// ADR-0061 §Decision 3: doctor threads AGENTIC_COMPANIONS_ROOT into the env-free
// peer-execution seam, the development path that replaced its repository rung.
describe('runtime doctor — companion candidates (ADR-0061)', () => {
  it('reports the AGENTIC_COMPANIONS_ROOT development override and selects from it', async () => {
    // Canonical: the peer context returns canonical companion paths (ADR-0061 S2).
    const root = await realpath(await mkdtemp(join(tmpdir(), 'runtime-doctor-companions-override-')));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-companions-override-home-'));
    await seedRepo(root);
    await seedCompanionCaches(home);
    const override = join(root, 'companions');
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      env: { AGENTIC_COMPANIONS_ROOT: override },
      runner: async (command, args) => fakeRuntimeProbeRunner(command, args),
    });
    deepStrictEqual(report.companions.override, { variable: 'AGENTIC_COMPANIONS_ROOT', path: override });
    strictEqual(report.companions.directions.claude_to_codex.selected.path, join(override, 'codex-companion.mjs'));
    strictEqual(report.companions.directions.codex_to_claude.selected.path, join(override, 'claude-companion.mjs'));
    strictEqual(report.companions.directions.codex_to_claude.selected.source, 'env-override');
  });

  it('does not select the repository source tree when no override is set and the caches are empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-companions-source-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-companions-source-home-'));
    await seedRepo(root); // plants companions/*.mjs and plugins/companions/scripts/*.mjs
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      env: {},
      runner: async (command, args) => fakeRuntimeProbeRunner(command, args),
    });
    strictEqual(report.companions.override, null);
    strictEqual(report.companions.directions.claude_to_codex.status, 'not_installed');
    strictEqual(report.companions.directions.codex_to_claude.status, 'not_installed');
  });
});

describe('runtime doctor — installed engineer root resolver (§8.2 C5)', () => {
  it('env override wins when absolute and scripts/state.mjs exists', async () => {
    // Canonical: the resolver returns canonical roots (ADR-0061 S2).
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'engineer-root-env-')));
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(join(dir, 'scripts', 'state.mjs'), '// x\n');
    const res = await resolveInstalledEngineerRoot({ env: { AGENTIC_ENGINEER_ROOT: dir }, home: '/nonexistent-home-xyz', selfUrl: 'file:///nope/x.mjs' });
    deepStrictEqual(res, { root: dir, source: 'env-override', host: null, callerHost: 'checkout', crossHostFallback: false });
  });

  it('a relative or unreadable env override resolves to null (no silent fallback)', async () => {
    strictEqual(await resolveInstalledEngineerRoot({ env: { AGENTIC_ENGINEER_ROOT: 'relative/path' }, home: '/nonexistent-home-xyz', selfUrl: 'file:///nope/x.mjs' }), null);
    strictEqual(await resolveInstalledEngineerRoot({ env: { AGENTIC_ENGINEER_ROOT: '/absolute/but/missing' }, home: '/nonexistent-home-xyz', selfUrl: 'file:///nope/x.mjs' }), null);
  });

  it('picks the SemVer-max Claude cache install whose manifest name is engineer', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'engineer-root-cache-')));
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
    const base = await realpath(await mkdtemp(join(tmpdir(), 'engineer-root-sibling-')));
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

// ADR-0044 S4 (session-capture-contract.md §13 / §11 S4): the doctor surface
// of the shared readiness assessment — section shape, text rendering, and
// the overall-warning gate (blocked warns; off and ready stay silent).
describe('runtime doctor — session capture readiness (ADR-0044 S4)', () => {
  it('reports the shipped default off silently and renders the section header', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doctor-session-off-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'doctor-session-off-home-'));
    await seedRepo(root);
    const report = await runDoctor({ repoRoot: root, homeDir: home, format: 'json', runner: fakeRunner({}), env: {} });
    strictEqual(report.session_capture.status, 'off');
    deepStrictEqual(report.session_capture.states, []);
    ok(
      !report.overall.warnings.some((warning) => warning.includes('session capture')),
      'off must not warn — it is a chosen state, not a half-enabled one',
    );
    const text = formatText(report);
    ok(text.includes('Session Capture Readiness (off)'));
    ok(text.includes('- gate: session_capture=off'));
  });

  it('surfaces a gate-on half-enabled chain as an overall warning with rendered states', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doctor-session-blocked-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'doctor-session-blocked-home-'));
    await seedRepo(root);
    await mkdir(join(root, '.agentic-plugins'), { recursive: true });
    await writeFile(join(root, '.agentic-plugins', 'config.toml'), 'session_capture = "stop-hook"\n');
    const report = await runDoctor({ repoRoot: root, homeDir: home, format: 'json', runner: fakeRunner({}), env: {} });
    strictEqual(report.session_capture.status, 'blocked');
    deepStrictEqual(report.session_capture.states, ['attention-missing']);
    strictEqual(report.session_capture.attention.enablement, 'unverified');
    ok(
      report.overall.warnings.includes('session capture blocked (attention-missing)'),
      `expected the blocked warning, got: ${JSON.stringify(report.overall.warnings)}`,
    );
    const text = formatText(report);
    ok(text.includes('Session Capture Readiness (blocked)'));
    ok(text.includes('attention-missing'));
  });

  it('reads a satisfied dynamically-declared publisher floor as ready (no warning)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doctor-session-ready-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'doctor-session-ready-home-'));
    await seedRepo(root);
    await mkdir(join(root, '.agentic-plugins'), { recursive: true });
    await writeFile(join(root, '.agentic-plugins', 'config.toml'), 'session_capture = "stop-hook"\n');
    const attentionRoot = join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'attention', '0.5.0');
    await mkdir(join(attentionRoot, '.claude-plugin'), { recursive: true });
    await writeJson(join(attentionRoot, '.claude-plugin', 'plugin.json'), { name: 'attention', version: '0.5.0' });
    await mkdir(join(attentionRoot, 'data'), { recursive: true });
    await writeJson(join(attentionRoot, 'data', 'runtime-floors.json'), {
      schema: 'attention-runtime-floors-1.0',
      floors: { publish_session: '0.1.0' },
    });
    const report = await runDoctor({ repoRoot: root, homeDir: home, format: 'json', runner: fakeRunner({}), env: {} });
    strictEqual(report.session_capture.status, 'ready');
    strictEqual(report.session_capture.publisher_floor.declared, true);
    strictEqual(report.session_capture.publisher_floor.floor, '0.1.0');
    strictEqual(report.session_capture.publisher_floor.satisfied, true);
    strictEqual(report.session_capture.publisher_floor.runtime_version, RUNTIME_VERSION);
    ok(!report.overall.warnings.some((warning) => warning.includes('session capture')));
    strictEqual(report.session_capture.attention.enablement, 'unverified', 'no plugin-list row for attention -> unverified');
  });

  // ADR-0045 S8 (session-capture-contract.md §18): the entry-side mirror on
  // the doctor surface — gate scope, floor sibling key, executor probe.
  it('reports entry-brief readiness: off silently, repo value ignored, user-scope gate-on chain warns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doctor-entry-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'doctor-entry-home-'));
    await seedRepo(root);

    // Control: shipped default off — section present, header rendered, silent.
    const offReport = await runDoctor({ repoRoot: root, homeDir: home, format: 'json', runner: fakeRunner({}), env: {} });
    strictEqual(offReport.entry_brief.status, 'off');
    deepStrictEqual(offReport.entry_brief.states, []);
    ok(!offReport.overall.warnings.some((warning) => warning.includes('entry brief')));
    const offText = formatText(offReport);
    ok(offText.includes('Entry Brief Readiness (off)'));
    ok(offText.includes('- gate: entry_brief=off'));

    // A tracked repo value never activates the user-scope-only key.
    await mkdir(join(root, '.agentic-plugins'), { recursive: true });
    await writeFile(join(root, '.agentic-plugins', 'config.toml'), 'entry_brief = "startup"\n');
    const repoAttempt = await runDoctor({ repoRoot: root, homeDir: home, format: 'json', runner: fakeRunner({}), env: {} });
    strictEqual(repoAttempt.entry_brief.status, 'off');
    deepStrictEqual(repoAttempt.entry_brief.gate.ignored_repo_keys, ['entry_brief']);
    ok(formatText(repoAttempt).includes('ignored-repo-keys=entry_brief'));

    // User-scope gate on with nothing installed: blocked + overall warning.
    await mkdir(join(home, '.agentic-plugins'), { recursive: true });
    await writeFile(join(home, '.agentic-plugins', 'config.toml'), 'entry_brief = "startup"\n');
    const blocked = await runDoctor({ repoRoot: root, homeDir: home, format: 'json', runner: fakeRunner({}), env: {} });
    strictEqual(blocked.entry_brief.status, 'blocked');
    deepStrictEqual(blocked.entry_brief.states, ['attention-missing']);
    ok(
      blocked.overall.warnings.includes('entry brief hook chain blocked (attention-missing)'),
      `expected the blocked warning, got: ${JSON.stringify(blocked.overall.warnings)}`,
    );
    ok(formatText(blocked).includes('Entry Brief Readiness (blocked)'));
  });

  it('entry floor satisfied + executor present is ready; executor absent at a passing floor blocks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doctor-entry-exec-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'doctor-entry-exec-home-'));
    await seedRepo(root);
    await mkdir(join(home, '.agentic-plugins'), { recursive: true });
    await writeFile(join(home, '.agentic-plugins', 'config.toml'), 'entry_brief = "startup"\n');
    const attentionRoot = join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'attention', '0.6.0');
    await mkdir(join(attentionRoot, '.claude-plugin'), { recursive: true });
    await writeJson(join(attentionRoot, '.claude-plugin', 'plugin.json'), { name: 'attention', version: '0.6.0' });
    await mkdir(join(attentionRoot, 'data'), { recursive: true });
    await writeJson(join(attentionRoot, 'data', 'runtime-floors.json'), {
      schema: 'attention-runtime-floors-1.0',
      floors: { publish_session: '0.1.0', entry_brief: '0.1.0' },
    });
    const runtimeRoot = join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'runtime', '0.90.0');
    await mkdir(join(runtimeRoot, '.claude-plugin'), { recursive: true });
    await writeJson(join(runtimeRoot, '.claude-plugin', 'plugin.json'), { name: 'runtime', version: '0.90.0' });

    // Executor absent at a passing floor: the ADR-0045 §10 blocked state.
    const missing = await runDoctor({ repoRoot: root, homeDir: home, format: 'json', runner: fakeRunner({}), env: {} });
    strictEqual(missing.entry_brief.entry_floor.satisfied, true);
    deepStrictEqual(missing.entry_brief.states, ['entry-executor-missing']);
    deepStrictEqual(missing.entry_brief.entry_executor, { probed: true, present: false, runtime_version: '0.90.0' });
    ok(missing.overall.warnings.includes('entry brief hook chain blocked (entry-executor-missing)'));

    // Ship the executor: ready, no warning.
    await mkdir(join(runtimeRoot, 'scripts'), { recursive: true });
    await writeFile(join(runtimeRoot, 'scripts', 'context.mjs'), '// stub\n');
    const ready = await runDoctor({ repoRoot: root, homeDir: home, format: 'json', runner: fakeRunner({}), env: {} });
    strictEqual(ready.entry_brief.status, 'ready');
    deepStrictEqual(ready.entry_brief.entry_executor, { probed: true, present: true, runtime_version: '0.90.0' });
    ok(!ready.overall.warnings.some((warning) => warning.includes('entry brief')));
  });

  it('feeds real `claude plugin list` text through the status→enablement adapter', async () => {
    // Peer finding: integration coverage must exercise the actual list-text
    // path (parseClaudePluginList → claudePluginListEnablement), not only
    // unit tests injecting a pre-built {enabled} object.
    const root = await mkdtemp(join(tmpdir(), 'doctor-session-list-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'doctor-session-list-home-'));
    await seedRepo(root);
    await mkdir(join(root, '.agentic-plugins'), { recursive: true });
    await writeFile(join(root, '.agentic-plugins', 'config.toml'), 'session_capture = "stop-hook"\n');
    const attentionRoot = join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'attention', '0.4.0');
    await mkdir(join(attentionRoot, '.claude-plugin'), { recursive: true });
    await writeJson(join(attentionRoot, '.claude-plugin', 'plugin.json'), { name: 'attention', version: '0.4.0' });
    await mkdir(join(attentionRoot, 'data'), { recursive: true });
    await writeJson(join(attentionRoot, 'data', 'runtime-floors.json'), {
      schema: 'attention-runtime-floors-1.0',
      floors: { publish_session: '0.1.0' },
    });
    const listText = 'Installed plugins:\n\n  > attention@agentic-plugins\n    Version: 0.4.0\n    Scope: user\n    Status: enabled\n';
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      format: 'json',
      runner: fakeRunner({
        'claude --version': okResult('2.1.140 (Claude Code)\n'),
        'claude --help': okResult('Usage: claude --print\nCommands:\n  auth status\n  plugin list\n'),
        'claude plugin --help': okResult('Commands:\n  install\n  list\n  update\n  uninstall\n'),
        'claude plugin list': okResult(listText),
        'claude /plugin list': okResult(listText),
      }),
      env: {},
    });
    strictEqual(report.session_capture.attention.enablement, 'enabled');
    strictEqual(report.session_capture.attention.version, '0.4.0', 'declaration bound to the list-named build');
    strictEqual(report.session_capture.status, 'ready');
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

// Installed companions in both host caches under `home` — where the peer
// execution context looks (ADR-0061 §Decision 3). seedRepo's source-tree
// companions are not candidates: an installed runtime reaches them only through
// AGENTIC_COMPANIONS_ROOT.
async function seedCompanionCaches(home) {
  for (const [host, manifestDir, script] of [
    ['.claude', '.claude-plugin', 'codex-companion.mjs'],
    ['.codex', '.codex-plugin', 'claude-companion.mjs'],
  ]) {
    const versionRoot = join(home, host, 'plugins', 'cache', 'agentic-plugins', 'companions', '1.0.0');
    await mkdir(join(versionRoot, manifestDir), { recursive: true });
    await mkdir(join(versionRoot, 'scripts'), { recursive: true });
    await writeJson(join(versionRoot, manifestDir, 'plugin.json'), { name: 'companions', version: '1.0.0' });
    await writeFile(join(versionRoot, 'scripts', script), "const CONTRACT_VERSION = '0.1.1'; // --prompt-file\n");
  }
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

// ADR-0061 §Decision 4: Codex's effective hooks come from the INSTALLED package, never
// the repository source. Tests about hook packaging therefore install the fixture's
// hook-bearing plugins into the Codex install cache — a verbatim copy of each plugin
// directory under <version>/, the way Codex materializes an install — so the hooks
// they assert on are hooks Codex would actually load. `versions` installs a plugin
// under a version other than its source manifest's (the copied manifest is rewritten
// to match). Call it after the last edit to the fixture's plugin directories.
async function installSourcePluginsOnCodex(root, home, names = ['engineer', 'orchestrator'], versions = {}) {
  for (const name of names) {
    const source = join(root, 'plugins', name);
    const manifest = JSON.parse(await readFile(join(source, '.codex-plugin', 'plugin.json'), 'utf8'));
    const version = versions[name] ?? manifest.version;
    const installed = join(home, '.codex', 'plugins', 'cache', 'agentic-plugins', name, version);
    await rm(installed, { recursive: true, force: true });
    await cp(source, installed, { recursive: true });
    await writeJson(join(installed, '.codex-plugin', 'plugin.json'), { ...manifest, version });
  }
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
