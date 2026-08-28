// Probe-free runtime:settings boundary suite (settings-report-contract.md §6).
//
// The consensus analogue (test-consensus-probe-boundary.mjs) is a STATIC
// closure gate and deliberately consensus-specific; settings legitimately
// imports runDoctor for full mode, so this suite asserts the boundary
// DYNAMICALLY instead: an injected runner must receive zero calls under
// --skip-host-cli-probes, and a black-box CLI run with claude/codex marker
// shims on PATH must leave the markers untouched. The black-box case carries
// a CONTROL group — the same shims ARE invoked by a full-mode run — so a
// green "no probes" assertion can never be hermetic by accident (shims
// unreachable would fail the control, not silently pass the probe-free leg).
//
// Artifact-family exclusion reduction: doctor sorts settings execution
// evidence by artifact timestamps while dashboard sorts by run id, but both
// are pure functions of the runs/settings directory content — asserting the
// directory (listing + bytes) unchanged therefore pins BOTH selections
// without comparing whole reports (whose generic artifact inventory
// legitimately changes when allowed plan families are written).

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  formatText,
  parseArgs,
  runSettings,
  SETTINGS_SCHEMA_VERSION,
  SETTINGS_EXECUTION_ARTIFACT_SCHEMA_VERSION,
} from '../../plugins/runtime/scripts/settings.mjs';

const execFileAsync = promisify(execFile);
const SETTINGS_CLI = resolve(import.meta.dirname, '../../plugins/runtime/scripts/settings.mjs');

const PROBE_SECTIONS = ['clis', 'plugins', 'plugin_command_surface', 'plugin_management', 'plugin_cleanup', 'hook_settings', 'codex_hook_review'];
const NULL_OVERALL_COUNTERS = ['plugin_recommendations', 'hook_warnings', 'hook_review_warnings', 'auth_warnings', 'plugin_cleanup_warnings', 'plugin_management_executed', 'plugin_management_failed'];
const PRESENCE_KEYS = [
  'clis', 'plugins', 'plugin_command_surface', 'plugin_management', 'plugin_cleanup', 'hook_settings', 'codex_hook_review',
  'config', 'companion_settings', 'notify_settings', 'session_settings', 'session_readiness', 'entry_readiness', 'mutation_boundary', 'artifacts', 'limits', 'overall',
  // Installed-receiver classification: a local filesystem read, so it is
  // evaluated in BOTH modes rather than being a probe section.
  'receivers', 'receiver_reinstall',
  'recommendations', 'notification_plan', 'egress_launcher_plan',
];

function enoent() {
  return { ok: false, exit_code: null, stdout: '', stderr: '', error_code: 'ENOENT', timed_out: false };
}

function recordingRunner(calls) {
  return async (command, args) => {
    calls.push(`${command} ${args.join(' ')}`);
    return enoent();
  };
}

async function makeFixture({ config = 'codex_model = "fixture-model"\n' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'settings-probe-repo-'));
  const home = await mkdtemp(join(tmpdir(), 'settings-probe-home-'));
  await mkdir(join(root, '.agentic-plugins'), { recursive: true });
  if (config !== null) await writeFile(join(root, '.agentic-plugins', 'config.toml'), config);
  return { root, home };
}

// Recursive directory snapshot: relative path -> file bytes (directories listed).
async function snapshotDir(dir) {
  const out = new Map();
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    const full = join(entry.parentPath ?? entry.path, entry.name);
    const rel = full.slice(dir.length + 1);
    if (entry.isDirectory()) {
      out.set(`${rel}/`, '<dir>');
    } else {
      out.set(rel, await readFile(full, 'utf8'));
    }
  }
  return out;
}

describe('runtime settings probe boundary (--skip-host-cli-probes)', () => {
  it('runs zero host-CLI probes and resolves model/effort from the filesystem', async () => {
    const { root, home } = await makeFixture();
    const calls = [];
    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-07-10T00:00:00.000Z'),
      skipHostCliProbes: true,
      runner: recordingRunner(calls),
    });
    deepStrictEqual(calls, [], 'injected runner must receive zero calls');
    // Resolver-derived values, not merely zero calls: the filesystem config
    // must actually surface as the current companion direction.
    strictEqual(report.companion_settings.directions.claude_to_codex.effective.model.value, 'fixture-model');
    strictEqual(report.companion_settings.directions.claude_to_codex.effective.model.source, 'repo config codex_model');
    strictEqual(report.config.resolution_order[0], 'explicit command flags');
    strictEqual(report.schema_version, 'runtime-settings-1.26');
    strictEqual(SETTINGS_SCHEMA_VERSION, 'runtime-settings-1.26');
  });

  it('emits the dual-mode discriminator with null (never empty) probe sections', async () => {
    const { root, home } = await makeFixture();
    const narrowed = await runSettings({ repoRoot: root, homeDir: home, skipHostCliProbes: true, runner: recordingRunner([]) });
    const full = await runSettings({ repoRoot: root, homeDir: home, runner: recordingRunner([]) });

    // Discriminator present in BOTH modes.
    strictEqual(narrowed.report_scope, 'local_plan');
    deepStrictEqual(narrowed.host_cli_probes, { status: 'skipped', flag: '--skip-host-cli-probes' });
    strictEqual(full.report_scope, 'full');
    deepStrictEqual(full.host_cli_probes, { status: 'run', flag: null });

    // Exact presence maps — PRESENCE_KEYS above is the contract, and the
    // deepStrictEqual is what makes a silently added or dropped section red.
    deepStrictEqual(Object.keys(narrowed.section_presence).sort(), [...PRESENCE_KEYS].sort());
    for (const key of PROBE_SECTIONS) strictEqual(narrowed.section_presence[key], 'not_evaluated', `presence[${key}]`);
    strictEqual(narrowed.section_presence.recommendations, 'local_only');
    strictEqual(narrowed.section_presence.notification_plan, 'not_requested');
    for (const key of PRESENCE_KEYS.filter((k) => !PROBE_SECTIONS.includes(k) && !['recommendations', 'notification_plan', 'egress_launcher_plan'].includes(k))) {
      strictEqual(narrowed.section_presence[key], 'evaluated', `presence[${key}]`);
    }
    for (const key of PRESENCE_KEYS.filter((k) => !['notification_plan', 'egress_launcher_plan'].includes(k))) {
      strictEqual(full.section_presence[key], 'evaluated', `full presence[${key}]`);
    }

    // Equal top-level key sets across modes (null, never omitted).
    deepStrictEqual(Object.keys(narrowed).sort(), Object.keys(full).sort());
    for (const key of PROBE_SECTIONS) strictEqual(narrowed[key], null, `narrowed.${key} must be null`);
    for (const key of NULL_OVERALL_COUNTERS) strictEqual(narrowed.overall[key], null, `overall.${key} must be null`);
    deepStrictEqual(Object.keys(narrowed.overall).sort(), Object.keys(full.overall).sort());
    strictEqual(narrowed.overall.scope, 'local_plan');
    strictEqual(full.overall.scope, 'full');
    strictEqual(typeof narrowed.overall.planned_config_writes, 'number');
    strictEqual(typeof narrowed.overall.setting_warnings, 'number');
    strictEqual(typeof narrowed.overall.notify_warnings, 'number');

    // local_only recommendations rebuild from evaluated inputs only — the
    // config-area hint keeps the section non-empty, so a hard-coded [] fails.
    ok(narrowed.recommendations.length > 0, 'local recommendations must not be empty in this fixture');
    ok(narrowed.recommendations.every((rec) => rec.area === 'config'), 'local recommendations derive from evaluated inputs only');

    // The execution-artifact schema is a separate contract; it moved 1.1 → 1.2 for
    // the write-ahead protocol (machine-bootstrap-contract.md §1.5).
    strictEqual(SETTINGS_EXECUTION_ARTIFACT_SCHEMA_VERSION, 'runtime-settings-execution-artifact-1.3');
  });

  it('keeps dry_run semantics on the mutation axis and snapshots current values before --apply', async () => {
    const { root, home } = await makeFixture({ config: 'codex_model = "pre-apply-model"\n' });
    const planOnly = await runSettings({ repoRoot: root, homeDir: home, skipHostCliProbes: true, runner: recordingRunner([]) });
    strictEqual(planOnly.dry_run, true);

    const calls = [];
    const applied = await runSettings({
      repoRoot: root,
      homeDir: home,
      skipHostCliProbes: true,
      apply: true,
      target: 'repo',
      desired: { codex_model: 'post-apply-model' },
      runner: recordingRunner(calls),
    });
    deepStrictEqual(calls, []);
    strictEqual(applied.dry_run, false, '--apply keeps its mutation-axis meaning under probe-free evidence');
    // Pre-apply snapshot: the peer-execution context is resolved at the
    // runDoctor position, BEFORE applyConfigPlans — the freshly written value
    // must not masquerade as "current" (`effective` legitimately projects the
    // applied value; `current` is the pre-write snapshot).
    strictEqual(applied.companion_settings.directions.claude_to_codex.current.model.value, 'pre-apply-model');
    strictEqual(applied.companion_settings.directions.claude_to_codex.effective.model.value, 'post-apply-model');
    strictEqual(applied.companion_settings.directions.claude_to_codex.effective.mode, 'applied');
    const written = await readFile(join(root, '.agentic-plugins', 'config.toml'), 'utf8');
    ok(written.includes('post-apply-model'), 'config apply must still write');
  });

  it('rejects evidence-consuming flags inside exported runSettings before any write', async () => {
    const rejected = [
      { name: '--execute-plugin-management', opts: { executePluginManagement: true } },
      { name: '--execute-plugin-cleanup', opts: { executePluginCleanup: true } },
      { name: '--attest-codex-hook-review', opts: { attestCodexHookReview: true } },
      { name: '--plugin-management-host (explicit default value still conflicts)', opts: { pluginManagementHost: 'all' } },
      { name: '--plugin-management-timeout-ms (explicit default value still conflicts)', opts: { pluginManagementTimeoutMs: 120000 } },
      { name: '--run-id (valid id)', opts: { runId: 'settings-20260710T000000Z-abcdef' } },
      { name: '--run-id (empty string presence)', opts: { runId: '' } },
    ];
    for (const { name, opts } of rejected) {
      const { root, home } = await makeFixture({ config: 'codex_model = "conflict-model"\n' });
      const before = await readFile(join(root, '.agentic-plugins', 'config.toml'), 'utf8');
      const calls = [];
      // Non-vacuous: pair the rejected flag with every ALLOWED effect so the
      // rejection provably precedes probes, config writes, and plan-artifact
      // writes — a rejected executor alone would not prove ordering.
      await rejects(
        runSettings({
          repoRoot: root,
          homeDir: home,
          skipHostCliProbes: true,
          apply: true,
          target: 'repo',
          desired: { codex_model: 'must-never-land' },
          notificationPlan: true,
          egressLauncherPlan: true,
          runner: recordingRunner(calls),
          ...opts,
        }),
        /--skip-host-cli-probes conflicts/,
        `${name} must reject`,
      );
      deepStrictEqual(calls, [], `${name}: zero probes before rejection`);
      strictEqual(await readFile(join(root, '.agentic-plugins', 'config.toml'), 'utf8'), before, `${name}: config byte-identical`);
      deepStrictEqual(await snapshotDir(join(root, '.agentic-plugins', 'runs')), new Map(), `${name}: no artifact family written`);
    }
  });

  it('never touches the runs/settings execution-evidence family across all 16 allowed combinations', async () => {
    for (const seeded of [false, true]) {
      const { root, home } = await makeFixture();
      const settingsRoot = join(root, '.agentic-plugins', 'runs', 'settings');
      if (seeded) {
        // Seed an EARLIER FAILED execution + latest pointer: an unevaluated
        // probe-free run recorded here would mask this failure for both
        // doctor (timestamp-sorted) and dashboard (run-id-sorted) readers.
        const seededRun = 'settings-20260701T000000Z-aaaaaa';
        await mkdir(join(settingsRoot, seededRun), { recursive: true });
        await writeFile(join(settingsRoot, seededRun, 'settings.json'), JSON.stringify({
          schema_version: SETTINGS_EXECUTION_ARTIFACT_SCHEMA_VERSION,
          run_id: seededRun,
          status: 'failed',
          summary: { overall_status: 'warning', executed: 1, failed: 1 },
        }, null, 2));
        await writeFile(join(settingsRoot, 'latest.json'), JSON.stringify({ run_id: seededRun }, null, 2));
      }
      const before = await snapshotDir(settingsRoot);
      const codexHome = join(home, '.codex');
      await mkdir(codexHome, { recursive: true });
      for (let mask = 0; mask < 8; mask++) {
        const opts = {
          apply: Boolean(mask & 1),
          notificationPlan: Boolean(mask & 2),
          egressLauncherPlan: Boolean(mask & 4),
        };
        const report = await runSettings({
          repoRoot: root,
          homeDir: home,
          env: { CODEX_HOME: codexHome },
          skipHostCliProbes: true,
          target: 'repo',
          desired: opts.apply ? { model: `combo-${mask}` } : {},
          runner: recordingRunner([]),
          ...opts,
        });
        strictEqual(report.report_scope, 'local_plan');
        strictEqual(report.artifacts.settings_execution.written, false, `mask=${mask}`);
        deepStrictEqual(await snapshotDir(settingsRoot), before, `mask=${mask} (seeded=${seeded}): runs/settings must be byte-identical`);
      }
    }
  });

  it('enumerates requested plan-artifact families in mutation_boundary.writes_allowed (both modes)', async () => {
    const { root, home } = await makeFixture();
    const codexHome = join(home, '.codex');
    await mkdir(codexHome, { recursive: true });
    const bare = await runSettings({ repoRoot: root, homeDir: home, skipHostCliProbes: true, runner: recordingRunner([]) });
    strictEqual(bare.mutation_boundary.writes_allowed, 'none; dry-run only');
    for (const skip of [true, false]) {
      const report = await runSettings({
        repoRoot: root,
        homeDir: home,
        env: { CODEX_HOME: codexHome },
        skipHostCliProbes: skip,
        notificationPlan: true,
        egressLauncherPlan: true,
        runner: recordingRunner([]),
      });
      strictEqual(report.dry_run, true, 'plan flags never flip dry_run');
      ok(report.mutation_boundary.writes_allowed.includes('runs/notification'), `skip=${skip}: notification family enumerated`);
      ok(report.mutation_boundary.writes_allowed.includes('runs/egress-launcher'), `skip=${skip}: egress-launcher family enumerated`);
      ok(!report.mutation_boundary.writes_allowed.includes('none; dry-run only'), `skip=${skip}: "dry run" must not render as "no writes"`);
    }
  });

  it('renders a qualified narrowed text report and guards both renderers', async () => {
    const { root, home } = await makeFixture();
    const narrowed = await runSettings({ repoRoot: root, homeDir: home, skipHostCliProbes: true, runner: recordingRunner([]) });
    const text = formatText(narrowed);
    ok(text.includes('(local-plan)'), 'header mode string carries the scope');
    ok(text.includes('report scope: local_plan'));
    ok(text.includes('host CLI probes: skipped by --skip-host-cli-probes'));
    ok(/^local plan: (pass|warning)$/m.test(text), 'overall line is qualified');
    for (const header of ['Host CLIs', 'Plugins', 'Plugin Management', 'Plugin Cleanup', 'Codex Plugin Hooks', 'Codex Hook Review']) {
      ok(new RegExp(`^${header}\\n- not evaluated \\(--skip-host-cli-probes\\)$`, 'm').test(text), `${header} renders an explicit not-evaluated line`);
    }
    ok(!/^local plan: pass$/m.test(text) || narrowed.overall.status === 'pass', 'qualified line matches overall');

    const full = await runSettings({ repoRoot: root, homeDir: home, runner: recordingRunner([]) });
    const fullText = formatText(full);
    ok(!fullText.includes('report scope:'), 'full-mode text stays free of narrowed lines');
    ok(!fullText.includes('not evaluated (--skip-host-cli-probes)'));
    ok(!fullText.includes('local plan:'));
    ok(fullText.includes('(dry-run)'));
  });

  it('downgrades a blocked requested plan section to local plan: warning', async () => {
    const { root, home } = await makeFixture({ config: null });
    const codexHome = join(home, '.codex');
    // config.toml as a DIRECTORY -> EISDIR (neither ENOENT nor ENOTDIR) ->
    // the notification plan's mandatory read-check blocks fail-closed.
    await mkdir(join(codexHome, 'config.toml'), { recursive: true });
    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      env: { CODEX_HOME: codexHome },
      skipHostCliProbes: true,
      notificationPlan: true,
      runner: recordingRunner([]),
    });
    strictEqual(report.notification_plan.status, 'blocked');
    strictEqual(report.overall.status, 'warning', 'a blocked evaluated plan must never read as a clean local pass');
    ok(/^local plan: warning$/m.test(formatText(report)));
  });

  it('parses the flag and rejects conflicts with a non-zero CLI exit', async () => {
    const opts = parseArgs(['--skip-host-cli-probes']);
    strictEqual(opts.skipHostCliProbes, true);
    strictEqual(opts.pluginManagementHost, undefined, 'modifier stays absent until passed');
    strictEqual(opts.pluginManagementTimeoutMs, undefined, 'modifier stays absent until passed');
    const withHost = parseArgs(['--plugin-management-host', 'all']);
    strictEqual(withHost.pluginManagementHost, 'all', 'explicit default value is still recorded as present');

    const { root } = await makeFixture();
    const env = { ...process.env };
    const help = await execFileAsync(process.execPath, [SETTINGS_CLI, '--help'], { env, timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 });
    ok(help.stdout.includes('--skip-host-cli-probes'), '--help documents the flag');

    await rejects(
      execFileAsync(process.execPath, [SETTINGS_CLI, '--repo-root', root, '--skip-host-cli-probes', '--run-id', 'settings-20260710T000000Z-abcdef'], { env, timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 }),
      (err) => {
        strictEqual(err.code, 1, 'conflict exits non-zero');
        ok(String(err.stderr).includes('--skip-host-cli-probes conflicts'));
        return true;
      },
    );
  });

  it('black-box: PATH shims prove full mode probes and probe-free mode does not (control group)', async () => {
    const { root, home } = await makeFixture();
    const shimDir = await mkdtemp(join(tmpdir(), 'settings-probe-shims-'));
    const codexHome = join(home, '.codex');
    await mkdir(codexHome, { recursive: true });
    const marker = join(shimDir, 'marker.log');
    for (const name of ['claude', 'codex']) {
      const shim = join(shimDir, name);
      await writeFile(shim, `#!/bin/sh\necho "${name} $@" >> "${marker}"\necho "shim-${name} 0.0.0"\nexit 0\n`);
      await chmod(shim, 0o755);
    }
    const env = {
      PATH: `${shimDir}:/usr/bin:/bin`,
      HOME: home,
      CODEX_HOME: codexHome,
    };
    const bounded = { env, timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 };

    // CONTROL: a full-mode run MUST reach the shims — proving the scrub leg
    // below cannot pass because the shims were unreachable all along.
    await execFileAsync(process.execPath, [SETTINGS_CLI, '--repo-root', root, '--format', 'json'], bounded);
    const controlMarker = await readFile(marker, 'utf8');
    ok(controlMarker.length > 0, 'control group: full mode must invoke the PATH shims');

    // Probe-free with the MAXIMAL allowed combination: marker must not grow.
    await writeFile(marker, '');
    const { stdout } = await execFileAsync(process.execPath, [
      SETTINGS_CLI, '--repo-root', root, '--format', 'json',
      '--skip-host-cli-probes', '--apply', '--target', 'repo', '--model', 'blackbox-model',
      '--notification-plan', '--egress-launcher-plan',
    ], bounded);
    strictEqual(await readFile(marker, 'utf8'), '', 'probe-free mode must not invoke any host CLI');
    const report = JSON.parse(stdout);
    strictEqual(report.report_scope, 'local_plan');
    strictEqual(report.host_cli_probes.status, 'skipped');
    strictEqual(report.clis, null);
    strictEqual(report.overall.scope, 'local_plan');
    let settingsFamily;
    try {
      settingsFamily = await readdir(join(root, '.agentic-plugins', 'runs', 'settings'));
    } catch (err) {
      settingsFamily = err.code;
    }
    strictEqual(settingsFamily, 'ENOENT', 'no settings execution family appears');
    const applied = await readFile(join(root, '.agentic-plugins', 'config.toml'), 'utf8');
    ok(applied.includes('blackbox-model'), '--apply still lands through the CLI');
  });
});
