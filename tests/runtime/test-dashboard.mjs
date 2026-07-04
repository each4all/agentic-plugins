// tests/runtime/test-dashboard.mjs
//
// ADR-0040 §6 runtime:dashboard tests: R0 read-only Tier 1 + Tier 2
// aggregation, macro subtask parsing (CRLF-tolerant), notify-state health,
// recent file-log notifications, text/json rendering, and the bounded
// --watch CLI path. All fixtures are minted per-test with mkdtemp — no
// committed fixture state.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DASHBOARD_SCHEMA_VERSION,
  DASHBOARD_PERSONAS,
  buildDashboardReport,
  inspectLatestDoctorRun,
  inspectNotifyState,
  inspectSettingsRecency,
  parseDashboardArgs,
  parseMacroSubtasks,
  readHostParityBaseline,
  readRecentNotifications,
  renderDashboardText,
  summarizeNotifyConfig,
} from '../../plugins/runtime/scripts/dashboard.mjs';
import { RUNTIME_VERSION } from '../../plugins/runtime/scripts/version.mjs';

const DASHBOARD_CLI = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../plugins/runtime/scripts/dashboard.mjs',
);

const NOW = new Date('2026-07-04T12:00:00Z');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeRepo() {
  const root = makeTempDir('dashboard-repo-');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  return root;
}

function makeHome() {
  return makeTempDir('dashboard-home-');
}

function writeFileDeep(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function writeWorkflow({ root, plugin, file, workflowId, phase, branch, extraFrontmatter = '' }) {
  writeFileDeep(
    path.join(root, '.agentic-plugins', 'state', plugin, 'workflows', file),
    [
      '---',
      `workflow_id: "${workflowId}"`,
      `current_phase: "${phase}"`,
      'git_baseline:',
      `  branch: "${branch}"`,
      '  head: "abc123"',
      extraFrontmatter,
      '---',
      '',
      'body',
      '',
    ].filter((line) => line !== '').join('\n'),
  );
}

const MACRO_FRONTMATTER_LINES = [
  '---',
  'workflow_id: "macro-plan-20260701T000000Z-aaaaaa"',
  'workflow_type: "macro"',
  'current_phase: "phase-3-dispatch-loop"',
  'git_baseline:',
  '  branch: "main"',
  '  head: "abc123"',
  'plan:',
  '  decision: "two subtasks"',
  '  subtasks:',
  '    - id: "one"',
  '      label: "first slice"',
  '      branch: "feat/one"',
  '      blocked_by: []',
  '      status: "completed"',
  '      topic: "long topic text with status: decoy inside"',
  '    - id: "two"',
  '      label: "second slice"',
  '      blocked_by: ["one"]',
  '      status: "in_progress"',
  '  architecture: "chain"',
  'next_action: "dispatch"',
  '---',
  '',
  'body',
  '',
];

function writeMacroWorkflow(root, { crlf = false } = {}) {
  const text = MACRO_FRONTMATTER_LINES.join(crlf ? '\r\n' : '\n');
  writeFileDeep(
    path.join(root, '.agentic-plugins', 'state', 'orchestrator', 'workflows', 'macro-plan-20260701T000000Z-aaaaaa.md'),
    text,
  );
  return text;
}

function writePeerRun({ root, plugin, runId, status, updatedAt }) {
  writeFileDeep(
    path.join(root, '.agentic-plugins', 'state', plugin, 'peer-runs', runId, 'handle.json'),
    JSON.stringify({ run_id: runId, plugin, status, kind: 'ensemble', peer_host: 'codex', updated_at: updatedAt }),
  );
}

describe('runtime dashboard macro subtask parsing', () => {
  it('parses plan.subtasks from macro frontmatter (LF and CRLF byte-identically)', () => {
    for (const crlf of [false, true]) {
      const text = MACRO_FRONTMATTER_LINES.join(crlf ? '\r\n' : '\n');
      const subtasks = parseMacroSubtasks(text);
      assert.deepEqual(subtasks, [
        { id: 'one', label: 'first slice', status: 'completed' },
        { id: 'two', label: 'second slice', status: 'in_progress' },
      ]);
    }
  });

  it('returns null for non-macro workflows and missing frontmatter', () => {
    assert.equal(parseMacroSubtasks('no frontmatter'), null);
    const nonMacro = ['---', 'workflow_id: "x"', 'workflow_type: "single"', '---', ''].join('\n');
    assert.equal(parseMacroSubtasks(nonMacro), null);
  });

  it('stops the subtask list at the next plan-level or top-level key', () => {
    const text = [
      '---',
      'workflow_type: "macro"',
      'plan:',
      '  subtasks:',
      '    - id: "only"',
      '      status: "pending"',
      '  architecture: "after"',
      'other_top:',
      '    - id: "decoy"',
      '      status: "completed"',
      '---',
    ].join('\n');
    assert.deepEqual(parseMacroSubtasks(text), [{ id: 'only', label: null, status: 'pending' }]);
  });

  it('accepts list items whose first mapping key is not id', () => {
    const text = [
      '---',
      'workflow_type: "macro"',
      'plan:',
      '  subtasks:',
      '    - status: "pending"',
      '      id: "reordered"',
      '      label: "id not first"',
      '---',
    ].join('\n');
    assert.deepEqual(parseMacroSubtasks(text), [{ id: 'reordered', label: 'id not first', status: 'pending' }]);
  });
});

describe('runtime dashboard report — empty repository', () => {
  it('degrades every section to missing/empty/off and keeps the three-persona contract', async () => {
    const root = makeRepo();
    const report = await buildDashboardReport({ repoRoot: root, now: NOW, homeDir: makeHome() });

    assert.equal(report.schema_version, DASHBOARD_SCHEMA_VERSION);
    assert.equal(report.runtime_version, RUNTIME_VERSION);
    assert.equal(report.generated_at, NOW.toISOString());

    // ADR-0040 §6: all three personas, founder included, from day one.
    assert.deepEqual(Object.keys(report.tier1.personas).sort(), ['engineer', 'founder', 'orchestrator']);
    assert.deepEqual(DASHBOARD_PERSONAS.map((persona) => persona.plugin), ['engineer', 'orchestrator', 'founder']);
    for (const persona of Object.values(report.tier1.personas)) {
      assert.equal(persona.workflows.count, 0);
      assert.equal(persona.peer_runs.count, 0);
      assert.deepEqual(persona.peer_runs.attention, []);
    }
    assert.equal(report.tier1.macros.count, 0);
    assert.equal(report.tier1.consensus.latest, null);

    assert.equal(report.tier2.doctor.status, 'missing');
    assert.equal(report.tier2.settings.status, 'missing');
    assert.equal(report.tier2.baseline.status, 'missing');
    assert.equal(report.tier2.notify.config.status, 'off');
    assert.equal(report.tier2.notify.config.channel, 'none');
    assert.equal(report.tier2.notify.state.status, 'missing');
    assert.equal(report.tier2.notify.recent.status, 'not_configured');

    const text = renderDashboardText(report);
    assert.match(text, /runtime:dashboard — 2026-07-04T12:00:00\.000Z/);
    assert.match(text, /founder: 0 active workflow/);
    assert.match(text, /macros: none active/);
  });
});

describe('runtime dashboard report — populated repository', () => {
  function populateRepo(root) {
    writeWorkflow({
      root,
      plugin: 'engineer',
      file: 'compose-20260704T000000Z-bbbbbb.md',
      workflowId: 'compose-20260704T000000Z-bbbbbb',
      phase: 'phase-4-compose',
      branch: 'feat/runtime-dashboard',
    });
    writeWorkflow({
      root,
      plugin: 'founder',
      file: 'frame-20260704T000000Z-cccccc.md',
      workflowId: 'frame-20260704T000000Z-cccccc',
      phase: 'phase-1-frame',
      branch: 'feat/venture',
    });
    writeMacroWorkflow(root);
    // Stale non-terminal peer run: running, updated 10 minutes before NOW.
    writePeerRun({
      root,
      plugin: 'engineer',
      runId: 'plan-verify-20260704T115000Z-abcdef',
      status: 'running',
      updatedAt: new Date(NOW.getTime() - 10 * 60000).toISOString(),
    });
    // Healthy terminal peer run: must NOT appear in attention rows.
    writePeerRun({
      root,
      plugin: 'engineer',
      runId: 'plan-verify-20260704T110000Z-fedcba',
      status: 'completed',
      updatedAt: new Date(NOW.getTime() - 30 * 60000).toISOString(),
    });

    // Real recorded-doctor artifact shape: schema_version + embedded report
    // (the dashboard rejects anything else as invalid — Codex review MAJOR).
    writeFileDeep(
      path.join(root, '.agentic-plugins', 'runs', 'doctor', 'doctor-20260601T000000Z-aaaaaa', 'doctor.json'),
      JSON.stringify({
        schema_version: 'runtime-doctor-artifact-1.0',
        run_id: 'doctor-20260601T000000Z-aaaaaa',
        status: 'recorded',
        runtime_version: '0.0.1',
        created_at: '2026-06-01T00:00:00Z',
        report: { schema_version: 'runtime-doctor-1.0' },
      }),
    );
    writeFileDeep(
      path.join(root, '.agentic-plugins', 'runs', 'settings', 'settings-20260620T000000Z-aaaaaa', 'settings.json'),
      JSON.stringify({
        run_id: 'settings-20260620T000000Z-aaaaaa',
        status: 'planned',
        created_at: '2026-06-20T00:00:00Z',
        codex_hook_review: {
          requested: true,
          attested: true,
          status: 'attested',
          attested_at: '2026-06-20T00:00:00Z',
          bundled_plugins: ['engineer'],
          plugin_versions: { engineer: '0.19.0' },
        },
      }),
    );
    // A newer settings run WITHOUT an attestation: latest recency comes from
    // it while the attestation falls back to the older attested run.
    writeFileDeep(
      path.join(root, '.agentic-plugins', 'runs', 'settings', 'settings-20260701T000000Z-bbbbbb', 'settings.json'),
      JSON.stringify({ run_id: 'settings-20260701T000000Z-bbbbbb', status: 'planned', created_at: '2026-07-01T00:00:00Z' }),
    );
    writeFileDeep(
      path.join(root, '.agentic-plugins', 'runs', 'compat', 'compat-20260701T000000Z-aaaaaa', 'snapshot.json'),
      JSON.stringify({ run_id: 'compat-20260701T000000Z-aaaaaa', created_at: '2026-07-01T00:00:00Z' }),
    );
    writeFileDeep(
      path.join(root, '.agentic-plugins', 'runs', 'consensus', 'consensus-20260628T000000Z-aaaaaa', 'execution.json'),
      JSON.stringify({
        run_id: 'consensus-20260628T000000Z-aaaaaa',
        status: 'converged',
        round: 2,
        created_at: '2026-06-28T00:00:00Z',
        summary: { executed: 2, passed: 2, failed: 0, skipped: 0 },
      }),
    );
    writeFileDeep(
      path.join(root, 'plugins', 'runtime', 'docs', 'host-parity-baseline.md'),
      '# Host parity baseline\n\nObserved on 2026-07-01 with Claude Code `2.1.197 (Claude Code)`, Codex CLI `codex-cli 0.142.4`.\n',
    );
  }

  it('aggregates tier1 rows and tier2 recency with stale/attention emphasis', async () => {
    const root = makeRepo();
    populateRepo(root);
    const report = await buildDashboardReport({ repoRoot: root, now: NOW, homeDir: makeHome() });

    const engineer = report.tier1.personas.engineer;
    assert.equal(engineer.workflows.active.length, 1);
    assert.equal(engineer.workflows.active[0].workflow_id, 'compose-20260704T000000Z-bbbbbb');
    assert.equal(engineer.workflows.active[0].branch, 'feat/runtime-dashboard');
    assert.equal(engineer.peer_runs.count, 2);
    assert.equal(engineer.peer_runs.non_terminal, 1);
    assert.equal(engineer.peer_runs.stale_non_terminal, 1);
    assert.equal(engineer.peer_runs.attention.length, 1);
    assert.equal(engineer.peer_runs.attention[0].run_id, 'plan-verify-20260704T115000Z-abcdef');
    assert.equal(engineer.peer_runs.attention[0].stale, true);

    // Founder coverage is the §6 differentiator vs doctor's ledger contract.
    const founder = report.tier1.personas.founder;
    assert.equal(founder.workflows.active.length, 1);
    assert.equal(founder.workflows.active[0].workflow_id, 'frame-20260704T000000Z-cccccc');

    assert.equal(report.tier1.macros.count, 1);
    const macro = report.tier1.macros.macros[0];
    assert.equal(macro.workflow_id, 'macro-plan-20260701T000000Z-aaaaaa');
    assert.equal(macro.subtasks.total, 2);
    assert.deepEqual(macro.subtasks.by_status, { completed: 1, in_progress: 1 });
    assert.deepEqual(macro.subtasks.active, [{ id: 'two', status: 'in_progress' }]);

    assert.equal(report.tier1.consensus.latest.run_id, 'consensus-20260628T000000Z-aaaaaa');
    assert.equal(report.tier1.consensus.latest.status, 'converged');

    assert.equal(report.tier2.doctor.status, 'available');
    assert.equal(report.tier2.doctor.latest.runtime_version, '0.0.1');
    assert.equal(report.tier2.doctor.latest.runtime_version_current, false);

    assert.equal(report.tier2.settings.latest.run_id, 'settings-20260701T000000Z-bbbbbb');
    assert.equal(report.tier2.settings.hook_attestation.run_id, 'settings-20260620T000000Z-aaaaaa');
    assert.equal(report.tier2.settings.hook_attestation.attested_at, '2026-06-20T00:00:00Z');
    assert.deepEqual(report.tier2.settings.hook_attestation.bundled_plugins, ['engineer']);
    // Recency-only scope is part of the output contract: the R0 dashboard
    // never re-judges doctor's currency (plugin drift, hook state).
    assert.match(report.tier2.settings.hook_attestation.scope, /recency only/);

    assert.equal(report.tier2.compat.latest.run_id, 'compat-20260701T000000Z-aaaaaa');
    assert.equal(report.tier2.compat.latest.status, 'snapshot_only');

    assert.equal(report.tier2.baseline.status, 'available');
    assert.deepEqual(report.tier2.baseline.baseline, {
      date: '2026-07-01',
      claude: '2.1.197 (Claude Code)',
      codex: 'codex-cli 0.142.4',
    });

    const text = renderDashboardText(report);
    assert.match(text, /engineer: 1 active workflow/);
    assert.match(text, /! peer-run plan-verify-20260704T115000Z-abcdef status=running STALE/);
    assert.match(text, /macro macro-plan-20260701T000000Z-aaaaaa: 1\/2 completed; open: two=in_progress/);
    assert.match(text, /doctor: doctor-20260601T000000Z-aaaaaa .*0\.0\.1 ≠ current .* STALE/);
    assert.match(text, /baseline: observed 2026-07-01/);
  });
});

describe('runtime dashboard notify sections', () => {
  it('reports missing notify state as expected-until-configured', async () => {
    const root = makeRepo();
    const state = await inspectNotifyState({ repoRoot: root, now: NOW.getTime() });
    assert.equal(state.status, 'missing');
    assert.deepEqual(state.issues, []);
  });

  it('flags expired claim buildup, stale reclaim locks, and stale rotation locks', async () => {
    const root = makeRepo();
    const notifyDir = path.join(root, '.agentic-plugins', 'state', 'runtime', 'notify');
    const dedupeDir = path.join(notifyDir, 'dedupe');
    fs.mkdirSync(dedupeDir, { recursive: true });

    const past = new Date(NOW.getTime() - 60 * 60000);
    const expiredClaim = path.join(dedupeDir, 'claim-expired');
    fs.writeFileSync(expiredClaim, 'x');
    fs.utimesSync(expiredClaim, past, past);
    const freshClaim = path.join(dedupeDir, 'claim-fresh');
    fs.writeFileSync(freshClaim, 'x');
    fs.utimesSync(freshClaim, NOW, NOW);

    const staleReclaimLock = path.join(dedupeDir, 'claim-expired.reclaim.lock');
    fs.mkdirSync(staleReclaimLock);
    fs.utimesSync(staleReclaimLock, past, past);

    fs.writeFileSync(path.join(notifyDir, 'log.ndjson'), '{"ts":"2026-07-04T11:59:00Z"}\n');
    const rotateLock = path.join(notifyDir, 'log.ndjson.rotate.lock');
    fs.mkdirSync(rotateLock);
    fs.utimesSync(rotateLock, past, past);

    const state = await inspectNotifyState({ repoRoot: root, now: NOW.getTime(), ttlSeconds: 300 });
    assert.equal(state.status, 'needs_attention');
    assert.equal(state.dedupe.claims, 2);
    assert.equal(state.dedupe.expired_claims, 1);
    assert.equal(state.dedupe.reclaim_locks, 1);
    assert.equal(state.dedupe.stale_reclaim_locks, 1);
    assert.equal(state.log.present, true);
    assert.equal(state.log.rotate_lock_present, true);
    assert.equal(state.log.rotate_lock_stale, true);
    assert.equal(state.issues.length, 3);
    assert.match(state.issues[0], /stale claim buildup: 1 expired/);
  });

  it('reads recent notifications across both log generations, newest last', async () => {
    const root = makeRepo();
    const notifyDir = path.join(root, '.agentic-plugins', 'state', 'runtime', 'notify');
    fs.mkdirSync(notifyDir, { recursive: true });
    fs.writeFileSync(
      path.join(notifyDir, 'log.ndjson.1'),
      '{"ts":"2026-07-04T10:00:00Z","kind":"approval","urgency":"urgent","title":"old","event_id":"a"}\n',
    );
    fs.writeFileSync(
      path.join(notifyDir, 'log.ndjson'),
      [
        '{"ts":"2026-07-04T11:00:00Z","kind":"turn-complete","urgency":"normal","title":"newer","event_id":"b"}',
        'not-json',
      ].join('\n'),
    );
    const recent = await readRecentNotifications({ repoRoot: root, limit: 5 });
    assert.equal(recent.status, 'available');
    assert.equal(recent.malformed, 1);
    assert.deepEqual(recent.entries.map((entry) => entry.event_id), ['a', 'b']);
  });

  it('summarizes notify config: off by default, configured for file-log, invalid on bad values', () => {
    const root = makeRepo();
    const home = makeHome();
    assert.equal(summarizeNotifyConfig({ repoRoot: root, homeDir: home }).status, 'off');

    fs.mkdirSync(path.join(root, '.agentic-plugins'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agentic-plugins', 'config.toml'), 'notify_channel = "file-log"\n');
    const configured = summarizeNotifyConfig({ repoRoot: root, homeDir: home });
    assert.equal(configured.status, 'configured');
    assert.equal(configured.channel, 'file-log');

    fs.writeFileSync(path.join(root, '.agentic-plugins', 'config.toml'), 'notify_channel = "bogus"\n');
    const invalid = summarizeNotifyConfig({ repoRoot: root, homeDir: home });
    assert.equal(invalid.status, 'invalid');
    assert.ok(invalid.errors.length > 0);
  });

  it('includes recent notifications in the report only when file-log is configured', async () => {
    const root = makeRepo();
    fs.mkdirSync(path.join(root, '.agentic-plugins'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agentic-plugins', 'config.toml'), 'notify_channel = "file-log"\n');
    const notifyDir = path.join(root, '.agentic-plugins', 'state', 'runtime', 'notify');
    fs.mkdirSync(notifyDir, { recursive: true });
    fs.writeFileSync(
      path.join(notifyDir, 'log.ndjson'),
      '{"ts":"2026-07-04T11:00:00Z","kind":"workflow-terminal","urgency":"normal","title":"done","event_id":"w1"}\n',
    );
    const report = await buildDashboardReport({ repoRoot: root, now: NOW, homeDir: makeHome() });
    assert.equal(report.tier2.notify.config.channel, 'file-log');
    assert.equal(report.tier2.notify.recent.status, 'available');
    assert.equal(report.tier2.notify.recent.entries.length, 1);
    const text = renderDashboardText(report);
    assert.match(text, /recent notifications \(1\)/);
    assert.match(text, /\[workflow-terminal\] done/);
  });
});

describe('runtime dashboard tier2 readers — degraded shapes', () => {
  it('reports blocked latest doctor artifacts instead of throwing', async () => {
    const root = makeRepo();
    writeFileDeep(
      path.join(root, '.agentic-plugins', 'runs', 'doctor', 'doctor-20260601T000000Z-aaaaaa', 'doctor.json'),
      'not-json',
    );
    const doctor = await inspectLatestDoctorRun({ repoRoot: root });
    assert.equal(doctor.status, 'blocked');
    assert.equal(doctor.latest.run_id, 'doctor-20260601T000000Z-aaaaaa');
  });

  it('rejects parseable JSON that is not a doctor artifact (schema/report gate)', async () => {
    const root = makeRepo();
    writeFileDeep(
      path.join(root, '.agentic-plugins', 'runs', 'doctor', 'doctor-20260601T000000Z-aaaaaa', 'doctor.json'),
      JSON.stringify({ run_id: 'doctor-20260601T000000Z-aaaaaa', runtime_version: '9.9.9' }),
    );
    const doctor = await inspectLatestDoctorRun({ repoRoot: root });
    assert.equal(doctor.status, 'blocked');
    assert.equal(doctor.latest.reason, 'invalid doctor artifact schema');
  });

  it('reports settings recency as empty when the family directory has no runs', async () => {
    const root = makeRepo();
    fs.mkdirSync(path.join(root, '.agentic-plugins', 'runs', 'settings'), { recursive: true });
    const settings = await inspectSettingsRecency({ repoRoot: root });
    assert.equal(settings.status, 'empty');
    assert.equal(settings.hook_attestation, null);
  });

  it('reports an unparsed baseline file distinctly from a missing one', async () => {
    const root = makeRepo();
    writeFileDeep(path.join(root, 'plugins', 'runtime', 'docs', 'host-parity-baseline.md'), 'no header here\n');
    const baseline = await readHostParityBaseline({ repoRoot: root });
    assert.equal(baseline.status, 'unparsed');
    assert.equal(baseline.baseline, null);
  });
});

describe('runtime dashboard argument parsing', () => {
  it('accepts the documented flag surface with defaults', () => {
    const parsed = parseDashboardArgs([]);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.opts.format, 'text');
    assert.equal(parsed.opts.watch, false);
    assert.equal(parsed.opts.intervalSeconds, 2);
    assert.equal(parsed.opts.recent, 5);
  });

  it('clamps --interval-seconds to the 1s floor instead of rejecting', () => {
    const parsed = parseDashboardArgs(['--watch', '--interval-seconds', '0.2']);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.opts.intervalSeconds, 1);
  });

  it('rejects unknown arguments, bad formats, and non-positive counts', () => {
    assert.equal(parseDashboardArgs(['--bogus']).ok, false);
    assert.equal(parseDashboardArgs(['--format', 'yaml']).ok, false);
    assert.equal(parseDashboardArgs(['--watch-count', '0']).ok, false);
    assert.equal(parseDashboardArgs(['--interval-seconds', '-1']).ok, false);
    assert.equal(parseDashboardArgs(['--format']).ok, false);
  });

  it('rejects partial numeric strings instead of truncating them', () => {
    assert.equal(parseDashboardArgs(['--watch-count', '2abc']).ok, false);
    assert.equal(parseDashboardArgs(['--interval-seconds', '1foo']).ok, false);
    assert.equal(parseDashboardArgs(['--recent', '5x']).ok, false);
  });
});

describe('runtime dashboard CLI', () => {
  it('emits a parseable JSON report with exit 0 on an empty repo', () => {
    const root = makeRepo();
    const home = makeHome();
    const result = spawnSync(process.execPath, [DASHBOARD_CLI, '--repo-root', root, '--format', 'json'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schema_version, DASHBOARD_SCHEMA_VERSION);
    assert.deepEqual(Object.keys(report.tier1.personas).sort(), ['engineer', 'founder', 'orchestrator']);
  });

  it('exits 1 with usage on unknown arguments', () => {
    const result = spawnSync(process.execPath, [DASHBOARD_CLI, '--bogus'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown argument --bogus/);
    assert.match(result.stderr, /usage: dashboard\.mjs/);
  });

  it('bounded --watch renders exactly --watch-count snapshots then exits 0', () => {
    const root = makeRepo();
    const home = makeHome();
    const result = spawnSync(
      process.execPath,
      [DASHBOARD_CLI, '--repo-root', root, '--watch', '--watch-count', '2', '--interval-seconds', '1'],
      { encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 30000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const renders = result.stdout.split('runtime:dashboard — ').length - 1;
    assert.equal(renders, 2);
    // Non-TTY separator between successive text snapshots.
    assert.match(result.stdout, /\n---\nruntime:dashboard — /);
  });

  it('frames --watch --format json as NDJSON (one parseable report per line)', () => {
    const root = makeRepo();
    const home = makeHome();
    const result = spawnSync(
      process.execPath,
      [DASHBOARD_CLI, '--repo-root', root, '--watch', '--format', 'json', '--watch-count', '2', '--interval-seconds', '1'],
      { encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 30000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split('\n').filter((line) => line.trim().length > 0);
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.equal(JSON.parse(line).schema_version, DASHBOARD_SCHEMA_VERSION);
    }
  });
});
