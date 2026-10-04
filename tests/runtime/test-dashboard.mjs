// tests/runtime/test-dashboard.mjs
//
// ADR-0040 §6 runtime:dashboard tests: R0 read-only Tier 1 + Tier 2
// aggregation, macro subtask parsing (CRLF-tolerant), the doctor-artifact
// matched-pair gate, text/json rendering, and the bounded --watch CLI path.
// ADR-0064 removed the notify-state and recent-notification rows; the cases
// below prove leftover notify state no longer reaches the report. All
// fixtures are minted per-test with mkdtemp — no committed fixture state.

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
  buildEntryAdvisory,
  inspectLatestDoctorRun,
  inspectSettingsRecency,
  parseDashboardArgs,
  parseMacroSubtasks,
  renderDashboardText,
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
  it('degrades every section to missing/empty and keeps the three-persona contract', async () => {
    const root = makeRepo();
    const report = await buildDashboardReport({ repoRoot: root, now: NOW, homeDir: makeHome() });

    assert.equal(report.schema_version, DASHBOARD_SCHEMA_VERSION);
    assert.equal(report.runtime_version, RUNTIME_VERSION);
    assert.equal(report.generated_at, NOW.toISOString());

    // ADR-0040 §6: all three personas, founder included, from day one.
    assert.deepEqual(Object.keys(report.tier1.personas).sort(), ['engineer', 'founder', 'orchestrator']);
    assert.deepEqual(DASHBOARD_PERSONAS.map((persona) => persona.plugin), ['engineer', 'orchestrator', 'founder']);
    // ADR-0043 §3 re-grounding: the Tier-1 persona set is an ADR-0040 §6
    // decision INDEPENDENT of the workflow_kind projection enum — founder
    // proves it (in Tier-1 before the enum modeled it), and the dashboard
    // reads workflow namespaces directly, never projections. So the ADR-0043
    // §1 four-persona enum expansion does NOT pull designer in; inclusion is
    // a demand-gated follow-up (designer production dogfood surfacing a real
    // aggregate-view need).
    assert.ok(!DASHBOARD_PERSONAS.some((persona) => persona.plugin === 'designer'),
      'designer must stay out of the dashboard Tier-1 personas (ADR-0040 §6 scoping; ADR-0043 §3 defers inclusion behind a demand trigger)');
    for (const persona of Object.values(report.tier1.personas)) {
      assert.equal(persona.workflows.count, 0);
      assert.equal(persona.peer_runs.count, 0);
      assert.deepEqual(persona.peer_runs.attention, []);
    }
    assert.equal(report.tier1.macros.count, 0);
    assert.equal(report.tier1.consensus.latest, null);

    assert.equal(report.tier2.doctor.status, 'missing');
    assert.equal(report.tier2.settings.status, 'missing');
    // ADR-0060 — host-version tracking is gone, and so are both Tier 2 rows.
    assert.equal(Object.hasOwn(report.tier2, 'baseline'), false);
    assert.equal(Object.hasOwn(report.tier2, 'compat'), false);
    // ADR-0064 — notification and egress are gone, and so is the notify row.
    assert.equal(Object.hasOwn(report.tier2, 'notify'), false);

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
        status: 'completed',
        terminal: true,
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
    // it while the attestation falls back to the older attested run. Terminal, so
    // the recency view treats it as a healthy latest (§1.5).
    writeFileDeep(
      path.join(root, '.agentic-plugins', 'runs', 'settings', 'settings-20260701T000000Z-bbbbbb', 'settings.json'),
      JSON.stringify({ run_id: 'settings-20260701T000000Z-bbbbbb', status: 'completed', terminal: true, created_at: '2026-07-01T00:00:00Z' }),
    );
    // An orphaned compat run (ADR-0060 §Decision 6). Nothing reads it any
    // more; it is seeded so the rows below prove it reaches no Tier 2 row.
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
    // The terminal latest is not an interrupted run (machine-bootstrap-contract.md §1.5).
    assert.equal(report.tier2.settings.interrupted, false);
    assert.equal(report.tier2.settings.latest.terminal, true);
    assert.equal(report.tier2.settings.hook_attestation.run_id, 'settings-20260620T000000Z-aaaaaa');
    assert.equal(report.tier2.settings.hook_attestation.attested_at, '2026-06-20T00:00:00Z');
    assert.deepEqual(report.tier2.settings.hook_attestation.bundled_plugins, ['engineer']);
    // Recency-only scope is part of the output contract: the R0 dashboard
    // never re-judges doctor's currency (plugin drift, hook state).
    assert.match(report.tier2.settings.hook_attestation.scope, /recency only/);

    assert.equal(Object.hasOwn(report.tier2, 'compat'), false, 'the orphaned compat run reaches no Tier 2 row');
    assert.equal(Object.hasOwn(report.tier2, 'baseline'), false);
    assert.equal(report.schema_version, 'runtime-dashboard-4.0');

    const text = renderDashboardText(report);
    assert.match(text, /engineer: 1 active workflow/);
    assert.match(text, /! peer-run plan-verify-20260704T115000Z-abcdef status=running STALE/);
    assert.match(text, /macro macro-plan-20260701T000000Z-aaaaaa: 1\/2 completed; open: two=in_progress/);
    assert.match(text, /doctor: doctor-20260601T000000Z-aaaaaa .*0\.0\.1 ≠ current .* STALE/);
    assert.doesNotMatch(text, /- (compat|baseline):/);
  });
});

// ADR-0064 §Decision 1 + §Decision 9 — notification and egress were removed,
// and leftover state under `.agentic-plugins/state/runtime/notify/` is inert:
// the dashboard reads none of it. Before the removal, each fixture seeded below
// moved the notify row (expired claims and stale locks to needs_attention, the
// log to the recent-notification list, the throttle record to the egress
// rollup, the config key to the channel).
describe('runtime dashboard without notification (ADR-0064)', () => {
  function seedLeftoverNotifyState(root) {
    const notifyDir = path.join(root, '.agentic-plugins', 'state', 'runtime', 'notify');
    const dedupeDir = path.join(notifyDir, 'dedupe');
    fs.mkdirSync(dedupeDir, { recursive: true });
    const past = new Date(NOW.getTime() - 60 * 60000);
    const expiredClaim = path.join(dedupeDir, `${'a'.repeat(32)}.claim`);
    fs.writeFileSync(expiredClaim, 'x');
    fs.utimesSync(expiredClaim, past, past);
    const staleReclaimLock = path.join(dedupeDir, `${'a'.repeat(32)}.claim.reclaim.lock`);
    fs.mkdirSync(staleReclaimLock);
    fs.utimesSync(staleReclaimLock, past, past);
    fs.writeFileSync(
      path.join(notifyDir, 'log.ndjson'),
      '{"ts":"2026-07-04T11:01:00Z","kind":"approval","urgency":"urgent","title":"leftover","event_id":"b","egress_channel":"telegram","egress_status":"failed","egress_outcome":"timeout"}\n',
    );
    const rotateLock = path.join(notifyDir, 'log.ndjson.rotate.lock');
    fs.mkdirSync(rotateLock);
    fs.utimesSync(rotateLock, past, past);
    writeFileDeep(path.join(notifyDir, 'egress-throttle', 'leftover.json'), '{"failures":3}\n');
    writeFileDeep(path.join(root, '.agentic-plugins', 'config.toml'), 'notify_channel = "file-log"\n');
    return notifyDir;
  }

  it('the report carries no tier2.notify member, and its text no notify row', async () => {
    const report = await buildDashboardReport({ repoRoot: makeRepo(), now: NOW, homeDir: makeHome() });
    // The watch-shaped Tier 2 (no snapshot retention) is exactly these three rows.
    assert.deepEqual(Object.keys(report.tier2).sort(), ['artifacts', 'doctor', 'settings']);
    const text = renderDashboardText(report);
    assert.doesNotMatch(text.slice(text.indexOf('## Tier 2')), /notif|egress/i);
  });

  it('leftover notify state changes nothing in the report or its rendering', async () => {
    const root = makeRepo();
    const home = makeHome();
    const before = await buildDashboardReport({ repoRoot: root, now: NOW, homeDir: home });
    const notifyDir = seedLeftoverNotifyState(root);
    assert.ok(fs.existsSync(path.join(notifyDir, 'log.ndjson')), 'control: the leftover state is on disk');
    const after = await buildDashboardReport({ repoRoot: root, now: NOW, homeDir: home });
    assert.deepEqual(after, before);
    assert.equal(renderDashboardText(after), renderDashboardText(before));
  });
});

// ADR-0047 §7 — the dashboard adopts the retention projection in the SNAPSHOT
// only (the citation scan spawns git; the --watch loop stays filesystem-only,
// contract §17).
describe('runtime dashboard retention projection (ADR-0047 §7)', () => {
  it('carries the retention section (with the actionable/pinned split) in a snapshot', async () => {
    const root = makeAdvisoryRepo(); // git-inited so the citation scan can enumerate
    // settings is the registry family with deletable runs since ADR-0060
    // removed compat; a terminal artifact keeps the uncited run unpinned.
    const settingsA = 'settings-20260101T000000Z-000001';
    const settingsB = 'settings-20260102T000000Z-000002';
    for (const runId of [settingsA, settingsB]) {
      writeFileDeep(path.join(root, '.agentic-plugins', 'runs', 'settings', runId, 'settings.json'), JSON.stringify({ status: 'completed', terminal: true }));
    }
    // A tracked doc citing one run → that run is pinned; the other is not.
    fs.writeFileSync(path.join(root, 'CITES.md'), `pinned: ${settingsA}\n`);
    gitAdv(root, ['add', 'CITES.md']);

    const report = await buildDashboardReport({ repoRoot: root, now: NOW, homeDir: makeHome(), entryAdvisory: { host: 'claude' } });
    assert.ok(report.tier2.retention, 'snapshot must carry tier2.retention');
    assert.equal(report.tier2.retention.scan_complete, true);
    assert.ok(report.tier2.retention.projection.settings, 'settings projected');
    assert.equal(Object.hasOwn(report.tier2.retention.projection, 'compat'), false, 'compat is no longer a registry family');
    assert.ok(report.tier2.retention.plan_hash.startsWith('sha256:'));
    const text = renderDashboardText(report);
    assert.match(text, /- retention:/);
  });

  it('omits the retention section entirely in a watch iteration (no git spawn, §17)', async () => {
    const root = makeAdvisoryRepo();
    // entryAdvisory omitted ⇒ watch-shaped build ⇒ no retention, no git.
    const report = await buildDashboardReport({ repoRoot: root, now: NOW, homeDir: makeHome() });
    assert.ok(!('retention' in report.tier2), 'watch report must not carry tier2.retention');
  });
});

// ADR-0064 §Decision 7 — the doctor pair moves to 1.4/1.4 in one release, and
// this reader extends its matched-pair list alongside doctor's (ADR-0057 D11).
describe('runtime dashboard doctor artifact pairs (ADR-0064 §Decision 7)', () => {
  function seedDoctorArtifact(root, { artifact, report }) {
    writeFileDeep(
      path.join(root, '.agentic-plugins', 'runs', 'doctor', 'doctor-20260701T000000Z-aaaaaa', 'doctor.json'),
      JSON.stringify({
        schema_version: artifact,
        run_id: 'doctor-20260701T000000Z-aaaaaa',
        status: 'recorded',
        runtime_version: RUNTIME_VERSION,
        created_at: '2026-07-01T00:00:00Z',
        report: { schema_version: report },
      }),
    );
  }

  it('reads a 1.4 doctor artifact carrying a 1.4 report', async () => {
    const root = makeRepo();
    seedDoctorArtifact(root, { artifact: 'runtime-doctor-artifact-1.4', report: 'runtime-doctor-1.4' });
    const doctor = await inspectLatestDoctorRun({ repoRoot: root });
    assert.equal(doctor.status, 'available');
    assert.equal(doctor.latest.run_id, 'doctor-20260701T000000Z-aaaaaa');
    assert.equal(doctor.latest.runtime_version_current, true);
  });

  it('refuses a mixed 1.3/1.4 tuple in either direction — no producer writes one', async () => {
    for (const [artifact, report] of [
      ['runtime-doctor-artifact-1.4', 'runtime-doctor-1.3'],
      ['runtime-doctor-artifact-1.3', 'runtime-doctor-1.4'],
    ]) {
      const root = makeRepo();
      seedDoctorArtifact(root, { artifact, report });
      const doctor = await inspectLatestDoctorRun({ repoRoot: root });
      assert.equal(doctor.status, 'blocked', `${artifact} + ${report} must be refused`);
      assert.equal(doctor.latest.reason, 'invalid doctor artifact schema');
    }
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

  it('flags a nonterminal (in-progress) settings latest as interrupted (§1.5)', async () => {
    const root = makeRepo();
    writeFileDeep(
      path.join(root, '.agentic-plugins', 'runs', 'settings', 'settings-20260702T000000Z-cccccc', 'settings.json'),
      JSON.stringify({ run_id: 'settings-20260702T000000Z-cccccc', status: 'in-progress', terminal: false, created_at: '2026-07-02T00:00:00Z' }),
    );
    const settings = await inspectSettingsRecency({ repoRoot: root });
    assert.equal(settings.interrupted, true);
    assert.equal(settings.latest.status, 'in-progress');
    assert.equal(settings.latest.terminal, false);
  });
});

describe('runtime dashboard argument parsing', () => {
  it('accepts the documented flag surface with defaults', () => {
    const parsed = parseDashboardArgs([]);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.opts.format, 'text');
    assert.equal(parsed.opts.watch, false);
    assert.equal(parsed.opts.intervalSeconds, 2);
    assert.equal(Object.hasOwn(parsed.opts, 'recent'), false);
  });

  it('rejects --recent as unknown — it bounded the removed notification list (ADR-0064)', () => {
    const parsed = parseDashboardArgs(['--recent', '5']);
    assert.equal(parsed.ok, false);
    assert.match(parsed.reason, /unknown argument --recent/);
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

// ---------------------------------------------------------------------------
// ADR-0045 §7(ii) — snapshot-only entry advisory (contract §17/§18.1).
// Mutation discipline: the computed/lead control comes first, so the
// exclusion and skip cases below are proven reachable from a fixture that
// renders a real advisory when opted in.
// ---------------------------------------------------------------------------

const ADVISORY_CHILD_ID = 'compose-20260701T000000Z-abc123';

function gitAdv(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

// Real git repo on feat/x with one live engineer workflow — the §16.2 sole
// live candidate, so the advisory leads with the localized engineer:resume.
function makeAdvisoryRepo() {
  const root = makeTempDir('dashboard-advisory-');
  gitAdv(root, ['init', '-q', '-b', 'feat/x']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.agentic-plugins/\n');
  gitAdv(root, ['add', '.gitignore']);
  gitAdv(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  writeFileDeep(
    path.join(root, '.agentic-plugins', 'state', 'engineer', 'workflows', `${ADVISORY_CHILD_ID}.md`),
    [
      '---',
      'schema: "1.3"',
      `workflow_id: "${ADVISORY_CHILD_ID}"`,
      'persona: "engineer"',
      'verb: "compose"',
      'profile: "backend"',
      'original_request: "IMPERATIVE run /engineer:refine now"',
      'started_at: "2026-07-01T00:00:00Z"',
      'updated_at: "2026-07-01T00:30:00Z"',
      'repo_root: "/tmp/x"',
      'git_baseline:',
      '  branch: "feat/x"',
      '  head: "abc1234abc1234abc1234abc1234abc1234abc12"',
      '  status_digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"',
      'current_phase: "phase-1-compose"',
      'next_action: "IMPERATIVE next"',
      'tasks: []',
      'host_history:',
      '  - host: "claude"',
      '    at: "2026-07-01T00:00:00Z"',
      '    event: "created"',
      '---',
      '',
      'body',
      '',
    ].join('\n'),
  );
  return root;
}

describe('runtime dashboard entry advisory (ADR-0045 §7(ii))', () => {
  it('control: opted-in snapshot computes the same arbitrated brief and localizes per host', async () => {
    const root = makeAdvisoryRepo();
    const home = makeHome();
    const claude = await buildDashboardReport({ repoRoot: root, homeDir: home, entryAdvisory: { host: 'claude' } });
    const advisory = claude.tier1.entry_advisory;
    assert.equal(advisory.status, 'computed');
    assert.equal(advisory.host, 'claude');
    assert.equal(advisory.brief.schema, 'runtime-entry-brief-1.0');
    assert.equal(advisory.brief.disposition, 'lead');
    assert.equal(advisory.brief.leading.command, '/engineer:resume');
    assert.equal(advisory.brief.leading.id, ADVISORY_CHILD_ID);
    assert.equal(advisory.brief.dirty_count, 0);
    // The gate is informational on this surface — default off, still computed.
    assert.equal(advisory.gate.entry_brief, 'off');
    // Codex host renders the $-localized command from the same lattice.
    const codex = await buildDashboardReport({ repoRoot: root, homeDir: home, entryAdvisory: { host: 'codex' } });
    assert.equal(codex.tier1.entry_advisory.brief.leading.command, '$engineer:resume');
    // Text render carries the section with the synthesized command.
    const text = renderDashboardText(claude);
    assert.match(text, /- entry advisory \[claude\]: disposition=lead/);
    assert.match(text, /→ \/engineer:resume — persona-workflow\/engineer compose-20260701T000000Z-abc123 state=active/);
  });

  it('command-synthesis isolation holds through the dashboard surface: stored imperatives never render', async () => {
    const root = makeAdvisoryRepo();
    const home = makeHome();
    const report = await buildDashboardReport({ repoRoot: root, homeDir: home, entryAdvisory: { host: 'claude' } });
    const rendered = renderDashboardText(report);
    const advisoryText = rendered.slice(rendered.indexOf('- entry advisory'));
    assert.ok(!advisoryText.includes('IMPERATIVE'), 'stored free text must not reach the advisory section');
    assert.ok(!JSON.stringify(report.tier1.entry_advisory).includes('IMPERATIVE'), 'stored free text must not reach the advisory report');
  });

  it('report builder without the opt-in carries NO entry_advisory key at all', async () => {
    const root = makeAdvisoryRepo();
    const home = makeHome();
    const report = await buildDashboardReport({ repoRoot: root, homeDir: home });
    assert.ok(!('entry_advisory' in report.tier1), 'advisory key must be absent, not null');
  });

  it('snapshot without --host reports the honest host-not-threaded skip', async () => {
    const root = makeAdvisoryRepo();
    const home = makeHome();
    const report = await buildDashboardReport({ repoRoot: root, homeDir: home, entryAdvisory: { host: null } });
    assert.deepEqual(report.tier1.entry_advisory, {
      status: 'skipped',
      reason: 'host-not-threaded',
      host: null,
      gate: null,
      brief: null,
    });
    assert.match(renderDashboardText(report), /- entry advisory: skipped — pass --host claude\|codex/);
  });

  it('a non-git repo root degrades to the executor skip, not an error', async () => {
    const root = makeRepo(); // bare .git DIRECTORY — not a real repository
    const advisory = await buildEntryAdvisory({ repoRoot: root, host: 'claude' });
    assert.equal(advisory.status, 'skipped');
    assert.equal(advisory.reason, 'no-repo-root');
  });

  it('an executor failure degrades to an error section instead of failing the dashboard', async () => {
    const advisory = await buildEntryAdvisory({ repoRoot: 42, host: 'claude' });
    assert.equal(advisory.status, 'error');
    assert.equal(advisory.brief, null);
    assert.ok(typeof advisory.reason === 'string' && advisory.reason.length > 0);
  });

  it('parseDashboardArgs validates --host and rejects a conflicting duplicate', () => {
    assert.equal(parseDashboardArgs(['--host', 'claude']).opts.host, 'claude');
    assert.equal(parseDashboardArgs(['--host', 'codex']).opts.host, 'codex');
    assert.equal(parseDashboardArgs([]).opts.host, null);
    assert.equal(parseDashboardArgs(['--host', 'gemini']).ok, false);
    assert.equal(parseDashboardArgs(['--host']).ok, false);
    // The wrappers thread the trusted host FIRST; appended arguments must
    // not silently override it (review peer) — conflicting duplicate is an
    // error, an idempotent repeat is not.
    assert.equal(parseDashboardArgs(['--host', 'claude', '--host', 'codex']).ok, false);
    assert.equal(parseDashboardArgs(['--host', 'claude', '--host', 'claude']).opts.host, 'claude');
  });

  it('threads the injected homeDir into the advisory gate read (hermetic user-scope resolution)', async () => {
    const root = makeAdvisoryRepo();
    const home = makeHome();
    // The gate must read the INJECTED home, not the developer's real one:
    // a fixture-home activation must be visible in the advisory's gate.
    writeFileDeep(path.join(home, '.agentic-plugins', 'config.toml'), 'entry_brief = "startup"\n');
    const report = await buildDashboardReport({ repoRoot: root, homeDir: home, entryAdvisory: { host: 'claude' } });
    assert.equal(report.tier1.entry_advisory.gate.entry_brief, 'startup');
  });

  it('the watch loop spawns no git while the snapshot advisory does (PATH spy)', () => {
    const root = makeAdvisoryRepo();
    const home = makeHome();
    const shimDir = makeTempDir('dashboard-git-shim-');
    const spyLog = path.join(shimDir, 'git-calls.log');
    fs.writeFileSync(
      path.join(shimDir, 'git'),
      `#!/bin/sh\necho "$@" >> "${spyLog}"\nexit 1\n`,
      { mode: 0o755 },
    );
    const env = { ...process.env, HOME: home, PATH: `${shimDir}:${process.env.PATH}` };

    // Control first: the opted-in snapshot DOES reach git through the
    // executor (the shim fails it, degrading the advisory — but the spy
    // must observe calls, proving the shim intercepts).
    const snapshot = spawnSync(
      process.execPath,
      [DASHBOARD_CLI, '--repo-root', root, '--format', 'json', '--host', 'claude'],
      { encoding: 'utf8', env, timeout: 30000 },
    );
    assert.equal(snapshot.status, 0, snapshot.stderr);
    assert.ok(fs.existsSync(spyLog) && fs.readFileSync(spyLog, 'utf8').length > 0,
      'snapshot advisory must reach the git spy (control)');

    // The invariant: a bounded watch run makes ZERO git calls.
    fs.rmSync(spyLog, { force: true });
    const watch = spawnSync(
      process.execPath,
      [DASHBOARD_CLI, '--repo-root', root, '--watch', '--format', 'json', '--watch-count', '2', '--interval-seconds', '1', '--host', 'claude'],
      { encoding: 'utf8', env, timeout: 30000 },
    );
    assert.equal(watch.status, 0, watch.stderr);
    assert.ok(!fs.existsSync(spyLog), `watch must never spawn git (contract §17); observed: ${fs.existsSync(spyLog) ? fs.readFileSync(spyLog, 'utf8') : ''}`);
  });

  it('snapshot CLI carries the advisory; --watch CLI never does (contract §18.1)', () => {
    const root = makeAdvisoryRepo();
    const home = makeHome();
    const snapshot = spawnSync(
      process.execPath,
      [DASHBOARD_CLI, '--repo-root', root, '--format', 'json', '--host', 'claude'],
      { encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 30000 },
    );
    assert.equal(snapshot.status, 0, snapshot.stderr);
    const snapshotReport = JSON.parse(snapshot.stdout);
    assert.equal(snapshotReport.tier1.entry_advisory.status, 'computed');
    assert.equal(snapshotReport.tier1.entry_advisory.brief.leading.command, '/engineer:resume');

    // --host accepted alongside --watch (uniform wrapper threading), but the
    // watch report must not carry the advisory key at all.
    const watch = spawnSync(
      process.execPath,
      [DASHBOARD_CLI, '--repo-root', root, '--watch', '--format', 'json', '--watch-count', '2', '--interval-seconds', '1', '--host', 'claude'],
      { encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 30000 },
    );
    assert.equal(watch.status, 0, watch.stderr);
    const lines = watch.stdout.split('\n').filter((line) => line.trim().length > 0);
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const report = JSON.parse(line);
      assert.ok(!('entry_advisory' in report.tier1), 'watch report must not carry entry_advisory');
    }
  });
});
