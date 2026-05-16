import { describe, it } from 'node:test';
import { ok, strictEqual, throws } from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatText,
  parseArgs,
  recordCutoverEvidence,
  runCutoverAudit,
} from '../../plugins/runtime/scripts/cutover-audit.mjs';

const NOW = new Date('2026-05-16T08:00:00.000Z');

describe('runtime cutover audit', () => {
  it('reports cutover-ready-candidate only when every evidence check is satisfied', async () => {
    const root = await seedRepo({
      scorecardStatus: 'satisfied',
      conditionStatus: 'satisfied',
      contextCreatedAt: '2026-05-16T07:30:00.000Z',
      cutoverEvidenceDates: oneWeekDogfoodDates(),
    });
    const report = await runCutoverAudit({
      repoRoot: root,
      now: NOW,
      doctorReport: doctorReport(),
      footerState: 'closed',
      footerReason: 'All PR, release, cleanup, and follow-up evidence is closed.',
      omccDevActive: 'no',
    });

    strictEqual(report.status, 'cutover-ready-candidate');
    strictEqual(report.ready_candidate, true);
    ok(report.checks.every((check) => ['satisfied', 'current', 'fresh', 'not-active'].includes(check.status)));
    ok(formatText(report).includes('ready-candidate: true'));
  });

  it('blocks readiness on partial ADR/scorecard status, stale context, missing dogfood window, missing footer, and unknown omcc activity', async () => {
    const root = await seedRepo({
      scorecardStatus: 'partial',
      conditionStatus: 'partial',
      contextCreatedAt: '2026-05-14T07:30:00.000Z',
    });
    const report = await runCutoverAudit({
      repoRoot: root,
      now: NOW,
      doctorReport: doctorReport(),
    });

    strictEqual(report.status, 'not-ready');
    strictEqual(report.ready_candidate, false);
    strictEqual(report.checks.find((check) => check.id === 'adr0012_conditions').status, 'partial');
    strictEqual(report.checks.find((check) => check.id === 'omcc_replacement_scorecard').status, 'partial');
    strictEqual(report.checks.find((check) => check.id === 'legacy_omcc_pattern_map').status, 'satisfied');
    strictEqual(report.checks.find((check) => check.id === 'latest_consensus_context_artifacts').status, 'stale');
    strictEqual(report.checks.find((check) => check.id === 'dogfood_evidence_window').status, 'not-verified');
    strictEqual(report.checks.find((check) => check.id === 'latest_completion_footer_state').status, 'not-verified');
    strictEqual(report.checks.find((check) => check.id === 'omcc_dev_daily_workflow').status, 'not-verified');
    ok(report.next_actions.some((entry) => entry.id === 'omcc_dev_daily_workflow'));
    const text = formatText(report);
    ok(text.includes('gate: ADR-0012 conditions 1-4 satisfied'));
    ok(text.includes('conditions: 1:partial, 2:partial, 3:partial, 4:partial'));
    ok(text.includes('unresolved: 1:partial, 2:partial, 3:partial, 4:partial'));
    ok(text.includes('scorecard: satisfied=0/12; unresolved=R1:partial'));
    ok(text.includes('legacy map: patterns=20; improved=14; retained=1; rejected=2; deferred=3'));
    ok(text.includes('dogfood window: covered=0/7; latest=<none>; records=0'));
  });

  it('blocks readiness when the legacy omcc pattern map is incomplete or load-bearing', async () => {
    const root = await seedRepo({
      scorecardStatus: 'satisfied',
      conditionStatus: 'satisfied',
      contextCreatedAt: '2026-05-16T07:30:00.000Z',
      legacyPatternMap: incompleteLegacyPatternMap(),
      cutoverEvidenceDates: oneWeekDogfoodDates(),
    });
    const report = await runCutoverAudit({
      repoRoot: root,
      now: NOW,
      doctorReport: doctorReport(),
      footerState: 'closed',
      omccDevActive: 'no',
    });

    const mapCheck = report.checks.find((check) => check.id === 'legacy_omcc_pattern_map');
    strictEqual(report.status, 'not-ready');
    strictEqual(mapCheck.status, 'partial');
    ok(mapCheck.evidence.missing_patterns.includes('D3'));
    strictEqual(mapCheck.evidence.active_dependency_blockers[0].id, 'D2');
    const text = formatText(report);
    ok(text.includes('missing patterns: D3'));
    ok(text.includes('active dependency blockers: D2'));
  });

  it('reports plugin version drift as blocked', async () => {
    const root = await seedRepo({
      scorecardStatus: 'satisfied',
      conditionStatus: 'satisfied',
      contextCreatedAt: '2026-05-16T07:30:00.000Z',
      cutoverEvidenceDates: oneWeekDogfoodDates(),
    });
    const doctor = doctorReport();
    doctor.plugins.runtime.cache.codex.latest.manifest_version = '0.34.0';

    const report = await runCutoverAudit({
      repoRoot: root,
      now: NOW,
      doctorReport: doctor,
      footerState: 'closed',
      omccDevActive: 'no',
    });

    const versionCheck = report.checks.find((check) => check.id === 'installed_plugin_versions');
    strictEqual(versionCheck.status, 'blocked');
    strictEqual(versionCheck.evidence.entries.find((entry) => entry.plugin === 'runtime').codex_cache, '0.34.0');
  });

  it('parses CLI arguments and rejects invalid explicit evidence', () => {
    const opts = parseArgs([
      '--repo-root',
      '/tmp/repo',
      'record',
      '--format',
      'json',
      '--footer-state',
      'closed',
      '--omcc-dev-active',
      'no',
      '--dogfood-date',
      '2026-05-16',
      '--artifact',
      'audit=docs/assurance/omcc-cutover-scorecard.md',
      '--max-artifact-age-hours',
      '6',
    ]);
    strictEqual(opts.command, 'record');
    strictEqual(opts.repoRoot, '/tmp/repo');
    strictEqual(opts.format, 'json');
    strictEqual(opts.footerState, 'closed');
    strictEqual(opts.omccDevActive, 'no');
    strictEqual(opts.dogfoodDate, '2026-05-16');
    strictEqual(opts.artifacts[0], 'audit=docs/assurance/omcc-cutover-scorecard.md');
    strictEqual(opts.maxArtifactAgeHours, 6);
    throws(() => parseArgs(['--footer-state', 'done-ish']), /--footer-state is invalid/);
    throws(() => parseArgs(['--omcc-dev-active', 'maybe']), /yes, no, or unknown/);
    throws(() => parseArgs(['--dogfood-window-days', '0']), /positive integer/);
  });

  it('records cutover evidence and lets audit consume latest footer and omcc activity', async () => {
    const root = await seedRepo({
      scorecardStatus: 'satisfied',
      conditionStatus: 'satisfied',
      contextCreatedAt: '2026-05-16T07:30:00.000Z',
    });
    const result = await recordCutoverEvidence({
      repoRoot: root,
      now: new Date('2026-05-16T07:45:00.000Z'),
      runId: 'cutover-20260516T074500Z-abcdef',
      footerState: 'closed',
      footerReason: 'all closeout work is done',
      omccDevActive: 'no',
      omccDevNote: 'runtime-only workflow',
      dogfoodDate: '2026-05-16',
      summary: 'record one day',
      artifacts: ['audit=docs/assurance/omcc-cutover-scorecard.md'],
    });

    strictEqual(result.status, 'recorded');
    strictEqual(result.evidence_pointer, '.agentic-plugins/runs/cutover/cutover-20260516T074500Z-abcdef/evidence.json');

    const report = await runCutoverAudit({
      repoRoot: root,
      now: NOW,
      doctorReport: doctorReport(),
      dogfoodWindowDays: 1,
    });
    strictEqual(report.checks.find((check) => check.id === 'dogfood_evidence_window').status, 'satisfied');
    strictEqual(report.checks.find((check) => check.id === 'latest_completion_footer_state').status, 'satisfied');
    strictEqual(report.checks.find((check) => check.id === 'omcc_dev_daily_workflow').status, 'not-active');
  });

  it('counts explicit current-run evidence without writing a dogfood artifact', async () => {
    const root = await seedRepo({
      scorecardStatus: 'satisfied',
      conditionStatus: 'satisfied',
      contextCreatedAt: '2026-05-16T07:30:00.000Z',
    });
    const report = await runCutoverAudit({
      repoRoot: root,
      now: NOW,
      doctorReport: doctorReport(),
      dogfoodWindowDays: 1,
      footerState: 'next-work-available',
      footerReason: 'follow-up remains open',
      omccDevActive: 'no',
      omccDevNote: 'current run avoided omcc-dev',
      dogfoodDate: '2026-05-16',
    });

    strictEqual(report.checks.find((check) => check.id === 'dogfood_evidence_window').status, 'satisfied');
    strictEqual(report.checks.find((check) => check.id === 'latest_completion_footer_state').status, 'partial');
    strictEqual(report.checks.find((check) => check.id === 'omcc_dev_daily_workflow').status, 'not-active');
  });
});

async function seedRepo({
  scorecardStatus,
  conditionStatus,
  contextCreatedAt,
  legacyPatternMap = completeLegacyPatternMap(),
  cutoverEvidenceDates = [],
}) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-cutover-audit-'));
  await mkdir(join(root, 'docs', 'assurance'), { recursive: true });
  await mkdir(join(root, 'plugins', 'runtime', 'docs'), { recursive: true });
  await mkdir(join(root, 'plugins', 'runtime', '.claude-plugin'), { recursive: true });
  await mkdir(join(root, 'plugins', 'runtime', '.codex-plugin'), { recursive: true });
  await mkdir(join(root, 'plugins', 'companions', '.claude-plugin'), { recursive: true });
  await mkdir(join(root, 'plugins', 'engineer', '.claude-plugin'), { recursive: true });
  await mkdir(join(root, 'plugins', 'orchestrator', '.claude-plugin'), { recursive: true });
  await writeFile(join(root, 'docs', 'DEVELOPMENT.md'), conditionRows(conditionStatus));
  await writeFile(join(root, 'docs', 'assurance', 'omcc-cutover-scorecard.md'), scorecardRows(scorecardStatus));
  await writeFile(join(root, 'docs', 'assurance', 'omcc-legacy-pattern-map.md'), legacyPatternMap);
  await writeFile(join(root, 'plugins', 'runtime', 'docs', 'host-parity-baseline.md'), 'Observed on 2026-05-16 with Claude Code `2.1.143`, Codex CLI\n`0.130.0`, official docs.\n');
  await writeFile(join(root, '.release-please-manifest.json'), JSON.stringify({
    'plugins/companions': '0.4.0',
    'plugins/engineer': '0.10.2',
    'plugins/orchestrator': '0.7.2',
    'plugins/runtime': '0.35.0',
  }));
  const contextDir = join(root, '.agentic-plugins', 'runs', 'context', 'context-20260516T073000Z-abc123');
  await mkdir(contextDir, { recursive: true });
  await writeFile(join(contextDir, 'context.json'), JSON.stringify({
    run_id: 'context-20260516T073000Z-abc123',
    created_at: contextCreatedAt,
  }));
  for (const [index, date] of cutoverEvidenceDates.entries()) {
    const isLatest = index === cutoverEvidenceDates.length - 1;
    await recordCutoverEvidence({
      repoRoot: root,
      now: new Date(`${date}T07:45:00.000Z`),
      runId: `cutover-${date.replace(/-/g, '')}T074500Z-${String(index).padStart(6, '0')}`,
      footerState: isLatest ? 'closed' : 'next-work-available',
      footerReason: isLatest ? 'all closeout work is done' : 'dogfood day still in progress',
      omccDevActive: 'no',
      omccDevNote: 'seeded test dogfood without omcc-dev',
      dogfoodDate: date,
    });
  }
  return root;
}

function oneWeekDogfoodDates() {
  return [
    '2026-05-10',
    '2026-05-11',
    '2026-05-12',
    '2026-05-13',
    '2026-05-14',
    '2026-05-15',
    '2026-05-16',
  ];
}

function completeLegacyPatternMap() {
  const rows = [
    ['D1', 'improved', 'Active daily workflow has a replacement.'],
    ['D2', 'improved', 'Active daily workflow has a replacement.'],
    ['D3', 'improved', 'Active daily workflow has a replacement.'],
    ['D4', 'improved', 'Active daily workflow has a replacement.'],
    ['D5', 'retained', 'Active daily workflow has a replacement.'],
    ['D6', 'improved', 'Active daily workflow has a replacement.'],
    ['D7', 'improved', 'Active daily workflow has a replacement.'],
    ['D8', 'improved', 'Active daily workflow has a replacement.'],
    ['D9', 'improved', 'Active daily workflow has a replacement.'],
    ['D10', 'improved', 'Active daily workflow has a replacement.'],
    ['D11', 'improved', 'Active daily workflow has a replacement.'],
    ['D12', 'improved', 'Active daily workflow has a replacement.'],
    ['D13', 'improved', 'Active daily workflow has a replacement.'],
    ['D14', 'improved', 'Active daily workflow has a replacement.'],
    ['D15', 'improved', 'Active daily workflow has a replacement.'],
    ['D16', 'rejected', 'No active daily dependency; explicit peer surfaces replace it.'],
    ['D17', 'deferred', 'No active daily dependency; future typed intake can revisit it.'],
    ['D18', 'deferred', 'No active daily dependency; cited brief is available through engineer.'],
    ['D19', 'deferred', 'No active daily dependency; designer remains future domain scope.'],
    ['D20', 'rejected', 'No active daily dependency; artifact pointers replace raw peer output.'],
  ];
  return legacyPatternRows(rows);
}

function incompleteLegacyPatternMap() {
  return legacyPatternRows([
    ['D1', 'improved', 'Active daily workflow has a replacement.'],
    ['D2', 'deferred', 'Active daily dependency remains for typed intake.'],
  ]);
}

function legacyPatternRows(rows) {
  return `| ID | Legacy surface | Legacy evidence | Agentic-plugins disposition | Replacement evidence | Status | Cutover impact |
|---|---|---|---|---|---|---|
${rows.map(([id, status, impact]) => `| ${id} | legacy | evidence | disposition | replacement | ${status} | ${impact} |`).join('\n')}
`;
}

function conditionRows(status) {
  return `| # | Condition | Status | Notes |
|---|---|---|---|
| 1 | parity | ${status} | ok |
| 2 | switching | ${status} | ok |
| 3 | dogfood | ${status} | ok |
| 4 | scaffolding | ${status} | ok |
`;
}

function scorecardRows(status) {
  return `| ID | Requirement | Evidence | Status | Exit |
|---|---|---|---|---|
| R1 | superior compatible | evidence | ${status} | ok |
| R2 | remove overbuild | evidence | ${status} | ok |
| R3 | tool switching | evidence | ${status} | ok |
| R4 | same UX | evidence | ${status} | ok |
| R5 | best result | evidence | ${status} | ok |
| R6 | context decisions | evidence | ${status} | ok |
| R7a | quality | evidence | ${status} | ok |
| R7b | completion | evidence | ${status} | ok |
| R8 | entry routing | evidence | ${status} | ok |
| R9 | compat | evidence | ${status} | ok |
| R10 | dual perspective | evidence | ${status} | ok |
| R11 | convergence | evidence | ${status} | ok |
`;
}

function doctorReport() {
  const pluginVersions = {
    companions: '0.4.0',
    engineer: '0.10.2',
    orchestrator: '0.7.2',
    runtime: '0.35.0',
  };
  return {
    clis: {
      claude: { version: { text: '2.1.143 (Claude Code)' } },
      codex: { version: { text: 'codex-cli 0.130.0' } },
    },
    plugins: Object.fromEntries(Object.entries(pluginVersions).map(([name, version]) => [name, {
      source: { claude_manifest: { version } },
      cache: {
        claude: { latest: { manifest_version: version } },
        codex: { latest: { manifest_version: version } },
      },
    }])),
    compat_runs: {
      latest: {
        run_id: 'compat-20260516T073000Z-abc123',
        status: 'current',
        drift_class: 'none',
        selected_at: '2026-05-16T07:30:00.000Z',
      },
    },
    consensus_runs: {
      latest: {
        run_id: 'consensus-20260516T073000Z-abc123',
        status: 'passed',
        selected_at: '2026-05-16T07:30:00.000Z',
        artifact_pointer: '.agentic-plugins/runs/consensus/consensus-20260516T073000Z-abc123/execution.json',
      },
    },
  };
}
