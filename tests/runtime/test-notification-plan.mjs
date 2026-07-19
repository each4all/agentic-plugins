// ADR-0040 §4 — runtime:settings --notification-plan (Codex M1 fragments).
//
// Covers the acceptance criteria from the design record:
//   - MANDATORY read-check of the user-layer notify value, both branches
//     (absent / present, incl. $CODEX_HOME override) — notify is a single-key
//     FULL REPLACE, so a present value must produce the wrapper-chaining plan
//     (chaining is an acceptance criterion, not an optional note);
//   - clobber warning when an existing notifier would be replaced;
//   - receiver shuttle content: discovery-ladder re-resolution (never a
//     version-pinned plugin cache path), /usr/bin/env node invocation,
//     payload-as-last-argv kebab-case contract, fail-closed posture;
//   - plan artifact schema under .agentic-plugins/runs/notification/;
//   - byte-identical host config after every mode (M1: never writes).

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  CHAIN_BASENAME,
  NOTIFICATION_PLAN_LATEST_SCHEMA_VERSION,
  NOTIFICATION_PLAN_SCHEMA_VERSION,
  SHUTTLE_BASENAME,
  isValidNotificationRunId,
  makeNotificationRunId,
  parseCodexNotifyConfigToml,
  renderCodexNotifyChainScript,
  renderCodexNotifyFragmentToml,
  renderCodexNotifyShuttleScript,
  renderCodexTuiNotificationsFragmentToml,
  writeNotificationPlanArtifact,
} from '../../plugins/runtime/scripts/lib/notification-plan.mjs';
import { formatText, parseArgs, runSettings } from '../../plugins/runtime/scripts/settings.mjs';
import { RUNTIME_VERSION } from '../../plugins/runtime/scripts/version.mjs';

// Module-load egress-triple scrub (mirrors test-cross-machine-egress-acceptance.mjs,
// test-notify.mjs, test-operator-observability-acceptance.mjs). The Codex-shuttle
// end-to-end test runs the real notify.mjs emit and expects the file-log channel; on
// a machine where the operator has ACTIVATED egress (the owner's ADR-0041 launcher
// exports the triple), that ambient activation would engage the §2c egress override
// and flip the expected channel to telegram. Deleting the triple keeps the suite
// hermetic against an operator-activated shell.
for (const k of ['AGENTIC_NOTIFY_EGRESS_CHANNEL', 'TELEGRAM_CHAT_ID', 'TELEGRAM_BOT_TOKEN']) {
  delete process.env[k];
}

const execFileAsync = promisify(execFile);

describe('notification plan: notify read-check parser', () => {
  it('reports an absent notify key', () => {
    const parsed = parseCodexNotifyConfigToml('model = "gpt-5"\n[tools]\nweb_search = true\n');
    strictEqual(parsed.notify.present, false);
    strictEqual(parsed.notify.raw, null);
    strictEqual(parsed.notify.values, null);
    strictEqual(parsed.tuiNotifications.present, false);
  });

  it('parses a single-line array, keeping # and ] inside strings and dropping a trailing comment', () => {
    const parsed = parseCodexNotifyConfigToml(
      'notify = ["notify-send", "msg # not-a-comment", "a]b"] # trailing "quoted" comment\n',
    );
    strictEqual(parsed.notify.present, true);
    deepStrictEqual(parsed.notify.values, ['notify-send', 'msg # not-a-comment', 'a]b']);
    ok(!parsed.notify.raw.includes('trailing'), 'comment after the closing bracket is not captured');
  });

  it('parses a multi-line array with per-line comments and escaped quotes', () => {
    const parsed = parseCodexNotifyConfigToml([
      'notify = [',
      '  "python3", # interpreter',
      '  "/home/me/my notify.py",',
      '  "say \\"done\\"",',
      "  'literal\"quote',",
      ']',
      '',
    ].join('\n'));
    deepStrictEqual(parsed.notify.values, ['python3', '/home/me/my notify.py', 'say "done"', 'literal"quote']);
  });

  it('flags a non-array notify value as present but not parseable', () => {
    const parsed = parseCodexNotifyConfigToml('notify = "python3 notify.py"\n');
    strictEqual(parsed.notify.present, true);
    strictEqual(parsed.notify.values, null);
  });

  it('flags an array with non-string elements as not parseable', () => {
    const parsed = parseCodexNotifyConfigToml('notify = ["python3", 42]\n');
    strictEqual(parsed.notify.present, true);
    strictEqual(parsed.notify.values, null);
  });

  it('decodes the full TOML escape set faithfully and fail-safes on forms it cannot decode', () => {
    // n must decode to 'n' — passing it through as 'u006e' would chain a
    // DIFFERENT command than the configured one (Plan-verify peer MAJOR).
    const unicode = parseCodexNotifyConfigToml('notify = ["\\u006eotify-send", "tab\\there", "\\U0001F514"]\n');
    deepStrictEqual(unicode.notify.values, ['notify-send', 'tab\there', '\u{1F514}']);
    // An escape outside the TOML set cannot be decoded faithfully → null.
    const unknownEscape = parseCodexNotifyConfigToml('notify = ["bad\\qescape"]\n');
    strictEqual(unknownEscape.notify.present, true);
    strictEqual(unknownEscape.notify.values, null);
    // Truncated/invalid unicode escapes → null.
    strictEqual(parseCodexNotifyConfigToml('notify = ["\\u00"]\n').notify.values, null);
    // Triple-quoted (multi-line) string forms → null, both flavors.
    strictEqual(parseCodexNotifyConfigToml('notify = ["""python3"""]\n').notify.values, null);
    strictEqual(parseCodexNotifyConfigToml("notify = ['''python3''']\n").notify.values, null);
  });

  it('honors notify only at the top level (before the first section) and takes the last assignment', () => {
    const sectioned = parseCodexNotifyConfigToml('[tools]\nnotify = ["hidden"]\n');
    strictEqual(sectioned.notify.present, false, 'notify inside a section is not the top-level key');
    const duplicated = parseCodexNotifyConfigToml('notify = ["first"]\nnotify = ["second"]\n');
    deepStrictEqual(duplicated.notify.values, ['second'], 'last top-level assignment wins');
  });

  it('reads [tui] notifications (array and boolean shapes)', () => {
    const arrayShape = parseCodexNotifyConfigToml('[tui]\nnotifications = ["agent-turn-complete"]\n');
    strictEqual(arrayShape.tuiNotifications.present, true);
    ok(arrayShape.tuiNotifications.raw.includes('agent-turn-complete'));
    const boolShape = parseCodexNotifyConfigToml('[tui]\nnotifications = true\n');
    strictEqual(boolShape.tuiNotifications.present, true);
    strictEqual(boolShape.tuiNotifications.raw, 'true');
    const otherSection = parseCodexNotifyConfigToml('[tools]\nnotifications = true\n');
    strictEqual(otherSection.tuiNotifications.present, false);
  });

  it('reads the dotted top-level tui.notifications form', () => {
    const dotted = parseCodexNotifyConfigToml('tui.notifications = ["approval-requested"]\nnotify = ["x"]\n');
    strictEqual(dotted.tuiNotifications.present, true);
    ok(dotted.tuiNotifications.raw.includes('approval-requested'));
    deepStrictEqual(dotted.notify.values, ['x']);
    // The dotted form is only a TOP-LEVEL key; inside a section it is a
    // different table and must not be misread.
    const sectioned = parseCodexNotifyConfigToml('[other]\ntui.notifications = ["approval-requested"]\n');
    strictEqual(sectioned.tuiNotifications.present, false);
  });
});

describe('notification plan: fragment + receiver script renderers', () => {
  it('renders the notify= fragment as /usr/bin/env node <receiver> with TOML escaping', () => {
    const fragment = renderCodexNotifyFragmentToml({ receiverPath: '/home/a"b\\c/shuttle.mjs' });
    strictEqual(fragment, 'notify = ["/usr/bin/env", "node", "/home/a\\"b\\\\c/shuttle.mjs"]\n');
  });

  it('renders the tui.notifications fragment with approval-requested first', () => {
    strictEqual(
      renderCodexTuiNotificationsFragmentToml(),
      '[tui]\nnotifications = ["approval-requested", "agent-turn-complete"]\n',
    );
  });

  it('renders a shuttle that re-resolves the runtime root and never pins a cache version', () => {
    const script = renderCodexNotifyShuttleScript({ minRuntimeVersion: '0.71.0' });
    ok(script.includes("const MIN_RUNTIME_VERSION = \"0.71.0\";"), 'version floor is rendered');
    ok(script.includes('AGENTIC_RUNTIME_ROOT'), 'env override rung');
    ok(script.includes("'.claude', 'plugins', 'cache', 'agentic-plugins', 'runtime'"), 'Claude cache rung');
    ok(script.includes("'.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'runtime'"), 'Codex cache rung');
    ok(script.includes('CODEX_HOME'), 'Codex cache rung honors $CODEX_HOME like the planner');
    // Same-host preference: a CODEX receiver probes the Codex cache BEFORE
    // the Claude cache, so a stale Claude copy cannot shadow a current Codex
    // install (Plan-verify peer MAJOR).
    ok(
      script.indexOf("'.tmp', 'marketplaces'") < script.indexOf("'.claude', 'plugins', 'cache'"),
      'Codex cache rung precedes the Claude cache rung',
    );
    ok(script.includes("'scripts', 'notify.mjs'"), 'delegates to notify.mjs');
    ok(script.includes('process.argv[process.argv.length - 1]'), 'payload is the LAST argv argument');
    ok(script.includes("'turn-id'"), 'kebab-case turn-id field');
    ok(script.includes("'last-assistant-message'"), 'nullable last-assistant-message field');
    ok(script.includes('agent-turn-complete'), 'single payload variant');
    ok(script.includes('client'), 'undocumented client field tolerance is documented');
    ok(script.includes('process.exitCode = 0'), 'fail-closed exit posture');
    ok(!/runtime[/\\]\d/.test(script), 'no version-pinned runtime cache path literal');
    ok(script.includes(":turn-complete:' + subject + ':fired'"), '§1 event_id composition with the default status token');
  });

  it('rejects a non-SemVer version floor (rendered-literal guard)', () => {
    throws(() => renderCodexNotifyShuttleScript({ minRuntimeVersion: 'evil";\nrequire(' }), /SemVer/);
  });

  it('renders a chain that preserves the prior notifier argv and forwards the payload to both', () => {
    const script = renderCodexNotifyChainScript({
      priorNotify: ['python3', '/home/me/my notify.py', 'say "done"'],
      shuttleInstallPath: '/home/me/.agentic-plugins/bin/codex-notify-shuttle.mjs',
    });
    ok(script.includes('const PRIOR_NOTIFY = ["python3", "/home/me/my notify.py", "say \\"done\\""];'));
    ok(script.includes('const SHUTTLE_PATH = "/home/me/.agentic-plugins/bin/codex-notify-shuttle.mjs";'));
    ok(script.includes('PRIOR_NOTIFY[0], withPayload(PRIOR_NOTIFY.slice(1))'), 'prior notifier invoked with payload appended');
    ok(script.includes('process.execPath, withPayload([SHUTTLE_PATH])'), 'shuttle invoked with payload appended');
    ok(script.includes('process.exitCode = 0'), 'fail-closed exit posture');
  });

  it('refuses to render a chain for an empty or non-string prior argv', () => {
    throws(() => renderCodexNotifyChainScript({ priorNotify: [], shuttleInstallPath: '/x' }), /non-empty/);
    throws(() => renderCodexNotifyChainScript({ priorNotify: ['a', 42], shuttleInstallPath: '/x' }), /array of strings/);
  });

  it('renders syntactically valid ESM for both receiver scripts (node --check)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-notification-scripts-'));
    const shuttlePath = join(dir, SHUTTLE_BASENAME);
    const chainPath = join(dir, CHAIN_BASENAME);
    await writeFile(shuttlePath, renderCodexNotifyShuttleScript());
    await writeFile(chainPath, renderCodexNotifyChainScript({
      priorNotify: ['notify-send', 'done'],
      shuttleInstallPath: shuttlePath,
    }));
    await execFileAsync(process.execPath, ['--check', shuttlePath]);
    await execFileAsync(process.execPath, ['--check', chainPath]);
  });

  it('shuttle ladder prefers the Codex cache (same-host) over a stale Claude cache and honors CODEX_HOME', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-notification-ladder-'));
    const repo = join(dir, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    const home = join(dir, 'home');
    const invokedLog = join(dir, 'invoked.log');
    const stubNotify = (label) => `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(invokedLog)}, ${JSON.stringify(label)} + '\\n');\n`;
    // Stale Claude cache: notify.mjs present but the version is below the floor.
    const claudeRoot = join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'runtime', '0.0.1');
    await mkdir(join(claudeRoot, '.claude-plugin'), { recursive: true });
    await mkdir(join(claudeRoot, 'scripts'), { recursive: true });
    await writeFile(join(claudeRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'runtime', version: '0.0.1' }));
    await writeFile(join(claudeRoot, 'scripts', 'notify.mjs'), stubNotify('claude-cache'));
    // Current Codex cache under a NON-DEFAULT $CODEX_HOME.
    const codexHome = join(dir, 'codex-home');
    const codexRoot = join(codexHome, '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'runtime');
    await mkdir(join(codexRoot, '.codex-plugin'), { recursive: true });
    await mkdir(join(codexRoot, 'scripts'), { recursive: true });
    await writeFile(join(codexRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'runtime', version: RUNTIME_VERSION }));
    await writeFile(join(codexRoot, 'scripts', 'notify.mjs'), stubNotify('codex-cache'));
    const bin = join(dir, 'bin');
    await mkdir(bin, { recursive: true });
    const shuttlePath = join(bin, SHUTTLE_BASENAME);
    await writeFile(shuttlePath, renderCodexNotifyShuttleScript());
    const payload = JSON.stringify({ type: 'agent-turn-complete', 'turn-id': 'ladder-1', 'last-assistant-message': null });
    const env = { ...process.env, HOME: home, CODEX_HOME: codexHome };
    delete env.AGENTIC_RUNTIME_ROOT;
    await execFileAsync(process.execPath, [shuttlePath, payload], { cwd: repo, env });
    let text = '';
    for (let i = 0; i < 100; i += 1) {
      try {
        text = await readFile(invokedLog, 'utf8');
        if (text.trim()) break;
      } catch {}
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    strictEqual(text.trim(), 'codex-cache', 'the $CODEX_HOME cache rung wins over the stale Claude cache');
  });

  it('delivers a real Codex payload end-to-end: rendered shuttle → notify.mjs emit → file-log channel', async () => {
    // The receiver must not merely render — it must actually run. Simulate
    // the user install: write the rendered shuttle to a stable location,
    // point AGENTIC_RUNTIME_ROOT at this checkout (the ladder's env rung),
    // and invoke it exactly as Codex would (payload = last argv argument).
    const dir = await mkdtemp(join(tmpdir(), 'runtime-notification-e2e-'));
    const repo = join(dir, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true }); // repo-root marker
    await mkdir(join(repo, '.agentic-plugins'), { recursive: true });
    await writeFile(
      join(repo, '.agentic-plugins', 'config.toml'),
      'notify_channel = "file-log"\nnotify_dedupe_ttl_seconds = "300"\n',
    );
    const bin = join(dir, 'bin');
    await mkdir(bin, { recursive: true });
    const shuttlePath = join(bin, SHUTTLE_BASENAME);
    await writeFile(shuttlePath, renderCodexNotifyShuttleScript());
    const runtimeRoot = fileURLToPath(new URL('../../plugins/runtime', import.meta.url));
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'turn-id': 'turn-e2e-1',
      'input-messages': ['do the thing'],
      'last-assistant-message': 'All done',
      client: { name: 'codex', version: '0.142.5' }, // undocumented field — tolerated
    });
    const { stdout } = await execFileAsync(process.execPath, [shuttlePath, payload], {
      cwd: repo,
      // HOME points at the empty temp dir so the user config layer and the
      // cache rungs of the ladder are hermetic; the env override rung wins.
      env: { ...process.env, AGENTIC_RUNTIME_ROOT: runtimeRoot, HOME: dir },
    });
    strictEqual(stdout, '', 'the shuttle never writes stdout');

    // The emit child is detached fire-and-forget — poll for the log record.
    const logPath = join(repo, '.agentic-plugins', 'state', 'runtime', 'notify', 'log.ndjson');
    let text = '';
    for (let i = 0; i < 100; i += 1) {
      try {
        text = await readFile(logPath, 'utf8');
        if (text.trim()) break;
      } catch {}
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    ok(text.trim(), 'file-log record appears within the poll budget');
    const record = JSON.parse(text.trim().split('\n')[0]);
    strictEqual(record.kind, 'turn-complete');
    strictEqual(record.source, 'codex-notify');
    strictEqual(record.title, 'Codex turn complete');
    strictEqual(record.body, 'All done');
    ok(record.event_id.endsWith(':turn-complete:codex-turn:turn-e2e-1:fired'), record.event_id);
  });
});

describe('notification plan: artifact validation', () => {
  it('validates run ids and rejects malformed artifacts before writing', async () => {
    ok(isValidNotificationRunId(makeNotificationRunId(new Date('2026-07-03T00:00:00.000Z'))));
    ok(!isValidNotificationRunId('notification-nope'));
    const root = await mkdtemp(join(tmpdir(), 'runtime-notification-artifact-'));
    await rejects(
      writeNotificationPlanArtifact({
        repoRoot: root,
        artifact: { schema_version: NOTIFICATION_PLAN_SCHEMA_VERSION, kind: 'notification-plan' },
      }),
      /failed validation/,
    );
    await rejects(stat(join(root, '.agentic-plugins', 'runs', 'notification')), 'rejected artifact writes nothing');
  });
});

describe('settings: notification plan (ADR-0040 §4, M1)', () => {
  it('plans the direct mode when no user notifier exists, records the artifact, writes no host config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-notifplan-absent-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-notifplan-home-'));
    await seedRepo(root);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      env: { ...process.env, CODEX_HOME: join(home, '.codex') },
      notificationPlan: true,
      now: new Date('2026-07-03T12:00:00.000Z'),
      runner: fakeRunner(defaultCliMap()),
    });

    strictEqual(report.schema_version, 'runtime-settings-1.22');
    strictEqual(report.dry_run, true, 'the notification plan never flips dry-run');
    const np = report.notification_plan;
    ok(np.requested && np.executed);
    strictEqual(np.status, 'planned');
    strictEqual(np.host, 'codex');
    strictEqual(np.host_config.codex_home_source, 'CODEX_HOME env override');
    strictEqual(np.read_check.performed, true);
    strictEqual(np.read_check.notify_present, false);
    strictEqual(np.recommended.mode, 'direct');
    strictEqual(np.recommended.chain_install_path, null);
    strictEqual(np.warning, null);
    const shuttlePath = join(home, '.agentic-plugins', 'bin', SHUTTLE_BASENAME);
    strictEqual(np.recommended.shuttle_install_path, shuttlePath);
    ok(np.fragments.notify_toml.includes('"/usr/bin/env", "node"'), 'fragment invokes via /usr/bin/env node');
    ok(np.fragments.notify_toml.includes(SHUTTLE_BASENAME));
    strictEqual(np.fragments.tui_notifications_toml, '[tui]\nnotifications = ["approval-requested", "agent-turn-complete"]\n');
    ok(np.scripts.shuttle.content.includes('MIN_RUNTIME_VERSION'));
    strictEqual(np.scripts.chain, null);

    // Artifact: per-run plan.json + latest.json singleton, schema-stamped.
    strictEqual(np.artifact.written, true);
    const plan = await readJson(join(root, np.artifact.report_pointer));
    strictEqual(plan.schema_version, NOTIFICATION_PLAN_SCHEMA_VERSION);
    strictEqual(plan.runtime_version, RUNTIME_VERSION);
    strictEqual(plan.kind, 'notification-plan');
    strictEqual(plan.surface, 'settings');
    strictEqual(plan.host, 'codex');
    strictEqual(plan.repo_root_pointer, '.');
    strictEqual(plan.boundary.writes_host_config, false);
    strictEqual(plan.boundary.installs_receiver, false);
    ok(plan.scripts.shuttle.content.includes('codex-notify-shuttle'));
    const latest = await readJson(join(root, np.artifact.latest_pointer));
    strictEqual(latest.schema_version, NOTIFICATION_PLAN_LATEST_SCHEMA_VERSION);
    strictEqual(latest.run_id, plan.run_id);
    strictEqual(latest.mode, 'direct');

    // M1: host config stays byte-absent; the receiver home is never created.
    await rejects(stat(join(home, '.codex', 'config.toml')), 'no user config.toml is created');
    await rejects(stat(join(home, '.agentic-plugins')), 'the receiver install dir is never created');

    const text = formatText(report);
    ok(text.includes('Notification Plan (Codex, dry-run — ADR-0040 §4)'));
    ok(text.includes('notify = ['));
    ok(text.includes('notifications = ["approval-requested", "agent-turn-complete"]'));
  });

  it('preserves an existing notifier via the wrapper chain and warns about the full replace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-notifplan-present-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-notifplan-home-'));
    await seedRepo(root);
    await mkdir(join(home, '.codex'), { recursive: true });
    const originalConfig = 'model = "gpt-5"\nnotify = ["python3", "/Users/me/notify.py"]\n\n[tui]\nnotifications = ["agent-turn-complete"]\n';
    await writeFile(join(home, '.codex', 'config.toml'), originalConfig);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      env: { ...process.env, CODEX_HOME: join(home, '.codex') },
      notificationPlan: true,
      now: new Date('2026-07-03T12:00:00.000Z'),
      runner: fakeRunner(defaultCliMap()),
    });

    const np = report.notification_plan;
    strictEqual(np.read_check.notify_present, true);
    strictEqual(np.read_check.notify_parseable, true);
    deepStrictEqual(np.read_check.notify_values, ['python3', '/Users/me/notify.py']);
    strictEqual(np.recommended.mode, 'wrapper-chain');
    match(np.warning, /FULL REPLACE/, 'clobber warning names the single-key replace semantics');
    const chainPath = join(home, '.agentic-plugins', 'bin', CHAIN_BASENAME);
    strictEqual(np.recommended.chain_install_path, chainPath);
    ok(np.fragments.notify_toml.includes(CHAIN_BASENAME), 'fragment points at the chain, not the shuttle');
    ok(np.scripts.chain.content.includes('"python3", "/Users/me/notify.py"'), 'prior argv embedded in the chain');
    ok(np.scripts.chain.content.includes(SHUTTLE_BASENAME), 'chain delegates to the shuttle');

    // tui.notifications is also a full-replace key — existing value surfaced.
    strictEqual(np.read_check.tui_notifications_present, true);
    match(np.tui_warning, /full-replace/);

    // The chain + prior argv are recorded in the plan artifact.
    const plan = await readJson(join(root, np.artifact.report_pointer));
    strictEqual(plan.recommended.mode, 'wrapper-chain');
    ok(plan.scripts.chain.content.includes('/Users/me/notify.py'));
    ok(plan.limits.some((limit) => limit.includes('Wrapper chaining')));

    // Byte-identical host config after the plan.
    strictEqual(await readFile(join(home, '.codex', 'config.toml'), 'utf8'), originalConfig);
    strictEqual(report.dry_run, true);

    const text = formatText(report);
    ok(text.includes('wrapper chain (preserves the existing notifier)'));
  });

  it('falls back to manual-merge when the existing notify value is not a flat string argv', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-notifplan-manual-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-notifplan-home-'));
    await seedRepo(root);
    await mkdir(join(home, '.codex'), { recursive: true });
    const originalConfig = 'notify = "python3 notify.py"\n';
    await writeFile(join(home, '.codex', 'config.toml'), originalConfig);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      env: { ...process.env, CODEX_HOME: join(home, '.codex') },
      notificationPlan: true,
      runner: fakeRunner(defaultCliMap()),
    });

    const np = report.notification_plan;
    strictEqual(np.read_check.notify_present, true);
    strictEqual(np.read_check.notify_parseable, false);
    strictEqual(np.recommended.mode, 'manual-merge');
    match(np.warning, /merge manually/);
    strictEqual(np.scripts.chain, null, 'no chain can be rendered from an unparseable argv');
    strictEqual(await readFile(join(home, '.codex', 'config.toml'), 'utf8'), originalConfig);
  });

  it('chains (not already-configured) when an unrelated notifier merely shares the receiver basename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-notifplan-basename-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-notifplan-home-'));
    await seedRepo(root);
    await mkdir(join(home, '.codex'), { recursive: true });
    // Same basename, DIFFERENT path — this is somebody's notifier, not ours;
    // misclassifying it as already-configured would silently drop it.
    const originalConfig = `notify = ["/usr/bin/env", "node", "/somewhere/else/${SHUTTLE_BASENAME}"]\n`;
    await writeFile(join(home, '.codex', 'config.toml'), originalConfig);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      env: { ...process.env, CODEX_HOME: join(home, '.codex') },
      notificationPlan: true,
      runner: fakeRunner(defaultCliMap()),
    });

    const np = report.notification_plan;
    strictEqual(np.recommended.mode, 'wrapper-chain', 'exact install-path match only');
    ok(np.scripts.chain.content.includes(`/somewhere/else/${SHUTTLE_BASENAME}`), 'the same-named notifier is preserved via the chain');
    strictEqual(await readFile(join(home, '.codex', 'config.toml'), 'utf8'), originalConfig);
  });

  it('recognizes a notify value that already points at the agentic-plugins receiver', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-notifplan-already-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-notifplan-home-'));
    await seedRepo(root);
    await mkdir(join(home, '.codex'), { recursive: true });
    const shuttlePath = join(home, '.agentic-plugins', 'bin', SHUTTLE_BASENAME);
    const originalConfig = `notify = ["/usr/bin/env", "node", "${shuttlePath}"]\n`;
    await writeFile(join(home, '.codex', 'config.toml'), originalConfig);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      env: { ...process.env, CODEX_HOME: join(home, '.codex') },
      notificationPlan: true,
      runner: fakeRunner(defaultCliMap()),
    });

    const np = report.notification_plan;
    strictEqual(np.recommended.mode, 'already-configured');
    strictEqual(np.scripts.chain, null, 'never chain the receiver to itself');
    match(np.warning, /idempotent/);
    strictEqual(await readFile(join(home, '.codex', 'config.toml'), 'utf8'), originalConfig);
  });

  it('fail-closes to blocked when the user config exists but cannot be read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-notifplan-blocked-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-notifplan-home-'));
    await seedRepo(root);
    // A DIRECTORY at the config.toml path makes readFile fail with EISDIR —
    // not ENOENT/ENOTDIR, so the mandatory read-check cannot run.
    await mkdir(join(home, '.codex', 'config.toml'), { recursive: true });

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      env: { ...process.env, CODEX_HOME: join(home, '.codex') },
      notificationPlan: true,
      runner: fakeRunner(defaultCliMap()),
    });

    const np = report.notification_plan;
    strictEqual(np.status, 'blocked');
    match(np.error, /read-check/);
    strictEqual(np.fragments, null, 'no fragment is recommended without the read-check');
    strictEqual(np.artifact.written, false);
    await rejects(stat(join(root, '.agentic-plugins', 'runs', 'notification')), 'no artifact family dir on blocked');
  });

  it('omits the notification plan unless requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-notifplan-omit-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-notifplan-home-'));
    await seedRepo(root);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner(defaultCliMap()),
    });

    strictEqual(report.notification_plan.requested, false);
    strictEqual(report.notification_plan.status, 'not_requested');
    ok(!formatText(report).includes('Notification Plan (Codex'));
    await rejects(stat(join(root, '.agentic-plugins', 'runs', 'notification')));
  });

  it('parses the --notification-plan flag', () => {
    const opts = parseArgs(['--notification-plan']);
    strictEqual(opts.notificationPlan, true);
    strictEqual(parseArgs([]).notificationPlan, false);
  });
});

// --- local fixtures (per-file copies, mirroring tests/runtime/test-settings.mjs) ---

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

const PORTABLE_HOOK_COMMAND = '/bin/sh "${PLUGIN_ROOT}/adapters/codex/hooks/run-node-hook.sh" "${PLUGIN_ROOT}/adapters/codex/hooks/hook.mjs"';

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

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
