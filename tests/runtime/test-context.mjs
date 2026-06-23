import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws, rejects } from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  buildHandoffGuidance,
  evaluateSessionHandoff,
  formatText,
  normalizeProjection,
  parseArgs,
  runContext,
} from '../../plugins/runtime/scripts/context.mjs';

const RUN_ID = 'context-20260513T000000Z-abcdef';
const LATER_RUN_ID = 'context-20260513T020000Z-fedcba';

describe('runtime context', () => {
  it('captures a bounded context artifact without mutating host session state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-context-capture-'));
    const report = await runContext({
      command: 'capture',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T00:00:00.000Z'),
      summary: 'Context summary for the runtime context hygiene MVP.',
      risk: 'yellow',
      riskReason: 'Large follow-up work should start from an artifact pointer.',
      artifacts: ['readiness:.agentic-plugins/runs/doctor/latest.json'],
      nextAction: 'Start a fresh session before expanding runtime automation.',
      nextSessionPrompt: 'Continue from the runtime context artifact and keep scope bounded.',
    });

    strictEqual(report.command, 'capture');
    strictEqual(report.run_id, RUN_ID);
    strictEqual(report.risk_level, 'yellow');
    strictEqual(report.context_summary, 'Context summary for the runtime context hygiene MVP.');
    strictEqual(report.next_session.recommended_action, 'Start a fresh session before expanding runtime automation.');
    strictEqual(report.next_session.commands.claude, `/runtime:context status --run-id ${RUN_ID}`);
    strictEqual(report.next_session.commands.codex, `$runtime:context status --run-id ${RUN_ID}`);
    strictEqual(report.next_session.commands.neutral, `runtime:context status --run-id ${RUN_ID}`);
    ok(report.artifacts.some((artifact) => artifact.kind === 'readiness' && artifact.pointer === '.agentic-plugins/runs/doctor/latest.json'));
    ok(report.limits.some((limit) => /does not mutate host session context/i.test(limit)));

    const artifact = await readJson(join(root, '.agentic-plugins', 'runs', 'context', RUN_ID, 'context.json'));
    strictEqual(artifact.schema_version, 'runtime-context-artifact-1.0');
    strictEqual(artifact.context.risk_level, 'yellow');
    strictEqual(artifact.next_session.prompt_pointer, `.agentic-plugins/runs/context/${RUN_ID}/next-session-prompt.md`);
    strictEqual(artifact.next_session.commands.claude, `/runtime:context status --run-id ${RUN_ID}`);
    strictEqual(artifact.next_session.commands.codex, `$runtime:context status --run-id ${RUN_ID}`);

    const prompt = await readFile(join(root, artifact.next_session.prompt_pointer), 'utf8');
    strictEqual(prompt, 'Continue from the runtime context artifact and keep scope bounded.\n');
    ok(formatText(report).includes('context summary:'));
    ok(formatText(report).includes('recommended next action: Start a fresh session'));
    ok(formatText(report).includes(`- codex: $runtime:context status --run-id ${RUN_ID}`));
  });

  it('generates a next-session prompt and status report from the stored artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-context-status-'));
    await runContext({
      command: 'capture',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T00:00:00.000Z'),
      summary: 'Use this context artifact for the next runtime PR.',
      risk: 'red',
      artifacts: ['consensus:.agentic-plugins/runs/consensus/run/consensus.json'],
    });

    const report = await runContext({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
    });

    strictEqual(report.command, 'status');
    strictEqual(report.risk_level, 'red');
    strictEqual(report.next_session.commands.claude, `/runtime:context status --run-id ${RUN_ID}`);
    strictEqual(report.next_session.commands.codex, `$runtime:context status --run-id ${RUN_ID}`);
    ok(report.next_session.prompt_preview.includes('Use this context artifact for the next runtime PR.'));
    ok(report.next_session.prompt_preview.includes('Host handoff commands:'));
    ok(report.next_session.prompt_preview.includes(`Codex: $runtime:context status --run-id ${RUN_ID}`));
    ok(report.artifacts.some((artifact) => artifact.kind === 'consensus'));
    ok(!JSON.stringify(report).includes('RAW PEER OUTPUT'));
  });

  it('finds the latest context artifact and reports stale handoff status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-context-latest-'));
    await runContext({
      command: 'capture',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T00:00:00.000Z'),
      summary: 'Older runtime handoff.',
      risk: 'green',
    });
    await runContext({
      command: 'capture',
      repoRoot: root,
      runId: LATER_RUN_ID,
      now: new Date('2026-05-13T02:00:00.000Z'),
      summary: 'Latest runtime handoff.',
      risk: 'yellow',
    });

    const report = await runContext({
      command: 'status',
      repoRoot: root,
      latest: true,
      now: new Date('2026-05-13T04:00:00.000Z'),
      staleAfterMs: 60 * 60 * 1000,
    });

    strictEqual(report.run_id, LATER_RUN_ID);
    strictEqual(report.context_summary, 'Latest runtime handoff.');
    strictEqual(report.handoff.mode, 'latest');
    strictEqual(report.handoff.latest, true);
    strictEqual(report.handoff.age_minutes, 120);
    strictEqual(report.handoff.stale, true);
    strictEqual(report.handoff.guidance.state, 'capture_new_context');
    strictEqual(report.handoff.guidance.reason, 'handoff artifact age exceeds the configured stale threshold');
    ok(report.handoff.guidance.recommended_action.includes('Capture a new runtime:context artifact'));
    ok(formatText(report).includes('handoff lookup:'));
    ok(formatText(report).includes('handoff guidance: capture_new_context'));
  });

  it('reports source-stale handoffs when the current git commit moved after capture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-context-source-stale-'));
    await runContext({
      command: 'capture',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T00:00:00.000Z'),
      summary: 'Context from the previous runtime release.',
      risk: 'yellow',
      sourceSnapshot: {
        status: 'observed',
        kind: 'git',
        commit: '1111111111111111111111111111111111111111',
        branch: 'main',
        dirty: false,
      },
    });

    const report = await runContext({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T00:30:00.000Z'),
      currentSourceSnapshot: {
        status: 'observed',
        kind: 'git',
        commit: '2222222222222222222222222222222222222222',
        branch: 'main',
        dirty: false,
      },
    });

    strictEqual(report.source_snapshot.commit, '1111111111111111111111111111111111111111');
    strictEqual(report.handoff.source_freshness.status, 'stale');
    strictEqual(report.handoff.source_freshness.artifact_commit, '1111111111111111111111111111111111111111');
    strictEqual(report.handoff.source_freshness.current_commit, '2222222222222222222222222222222222222222');
    strictEqual(report.handoff.source_freshness.reason, 'current git commit differs from the context artifact commit');
    strictEqual(report.handoff.guidance.state, 'capture_new_context');
    strictEqual(report.handoff.guidance.recommended_session, 'fresh_or_resumed');
    ok(report.handoff.guidance.recommended_action.includes('Capture a new runtime:context artifact'));
    ok(report.handoff.guidance.commands.some((command) => command.includes('runtime:context capture')));
    ok(formatText(report).includes('source freshness:'));
    ok(formatText(report).includes('- source status: stale'));
    ok(formatText(report).includes('handoff guidance: capture_new_context'));
  });

  it('does not treat dirty-captured handoffs as source-verified when the commit still matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-context-dirty-artifact-'));
    await runContext({
      command: 'capture',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T00:00:00.000Z'),
      summary: 'Context captured while source had uncommitted runtime edits.',
      risk: 'yellow',
      sourceSnapshot: {
        status: 'observed',
        kind: 'git',
        commit: '3333333333333333333333333333333333333333',
        branch: 'main',
        dirty: true,
      },
    });

    const report = await runContext({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T00:15:00.000Z'),
      currentSourceSnapshot: {
        status: 'observed',
        kind: 'git',
        commit: '3333333333333333333333333333333333333333',
        branch: 'main',
        dirty: false,
      },
    });

    strictEqual(report.handoff.source_freshness.status, 'dirty_artifact');
    strictEqual(report.handoff.source_freshness.artifact_dirty, true);
    strictEqual(report.handoff.source_freshness.current_dirty, false);
    strictEqual(report.handoff.guidance.state, 'capture_after_source_settled');
    strictEqual(report.handoff.guidance.recommended_session, 'fresh_or_resumed');
    ok(report.handoff.guidance.reason.includes('captured from a dirty worktree'));
    ok(report.handoff.guidance.recommended_action.includes('Capture a new runtime:context artifact'));
    ok(formatText(report).includes('- source status: dirty_artifact'));
    ok(formatText(report).includes('handoff guidance: capture_after_source_settled'));
  });

  it('checks explicit context budget without creating artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-context-check-'));
    const report = await runContext({
      command: 'check',
      repoRoot: root,
      tokenBudget: 100000,
      usedTokens: 82000,
    });

    strictEqual(report.command, 'check');
    strictEqual(report.read_only, true);
    strictEqual(report.risk_level, 'yellow');
    strictEqual(report.context_budget.status, 'observed');
    strictEqual(report.context_budget.used_percent, 82);
    strictEqual(report.context_budget.remaining_tokens, 18000);
    ok(report.next_session.recommended_action.includes('Prefer a fresh or resumed session'));
    ok(report.limits.some((limit) => /no context artifact is created/i.test(limit)));
    ok(formatText(report).includes('context budget:'));
    await rejects(stat(join(root, '.agentic-plugins')), /ENOENT/);
  });

  it('classifies green and red context checks from explicit inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-context-check-risk-'));
    const green = await runContext({
      command: 'check',
      repoRoot: root,
      tokenBudget: 100000,
      remainingTokens: 40000,
    });
    const red = await runContext({
      command: 'check',
      repoRoot: root,
      tokenBudget: 100000,
      usedTokens: 95000,
    });

    strictEqual(green.risk_level, 'green');
    strictEqual(green.context_budget.used_tokens, 60000);
    strictEqual(red.risk_level, 'red');
    strictEqual(red.context_budget.used_ratio, 0.95);
  });

  it('accepts caller-supplied check risk without pretending to measure host context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-context-check-manual-'));
    const report = await runContext({
      command: 'check',
      repoRoot: root,
      risk: 'red',
      riskReason: 'Long implementation session.',
    });

    strictEqual(report.risk_level, 'red');
    strictEqual(report.context_budget.status, 'not_provided');
    strictEqual(report.risk_reason, 'Long implementation session.');
  });

  it('normalizes absolute artifact pointers only when they stay inside the repo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-context-artifacts-'));
    const report = await runContext({
      command: 'capture',
      repoRoot: root,
      runId: RUN_ID,
      summary: 'Absolute artifact pointers are normalized to repo-relative pointers.',
      artifacts: [`note:${resolve(root, 'notes', 'handoff.md')}`],
    });

    ok(report.artifacts.some((artifact) => artifact.kind === 'note' && artifact.pointer === 'notes/handoff.md'));
    await rejectsAsync(
      runContext({
        command: 'capture',
        repoRoot: root,
        runId: 'context-20260513T000001Z-abcdef',
        summary: 'bad',
        artifacts: [`bad:${resolve(root, '..', 'outside.md')}`],
      }),
      /escapes repo root/,
    );
  });

  it('parses CLI arguments and rejects unsafe ids or ambiguous text inputs', () => {
    const opts = parseArgs([
      'capture',
      '--repo-root',
      '/tmp/repo',
      '--format',
      'json',
      '--summary',
      'Context is getting large.',
      '--risk',
      'green',
      '--artifact',
      'workflow:.claude/agentic-engineer/workflows/id.md',
      '--next-action',
      'Continue carefully.',
    ]);
    strictEqual(opts.command, 'capture');
    strictEqual(opts.format, 'json');
    strictEqual(opts.risk, 'green');
    deepStrictEqual(opts.artifacts, ['workflow:.claude/agentic-engineer/workflows/id.md']);

    const commandStyle = parseArgs(['--repo-root', '/tmp/repo', 'status', '--run-id', RUN_ID]);
    strictEqual(commandStyle.command, 'status');
    strictEqual(commandStyle.runId, RUN_ID);

    const latestStatus = parseArgs(['status', '--latest', '--stale-after-hours', '6']);
    strictEqual(latestStatus.command, 'status');
    strictEqual(latestStatus.latest, true);
    strictEqual(latestStatus.staleAfterMs, 6 * 60 * 60 * 1000);

    const check = parseArgs(['check', '--repo-root', '/tmp/repo', '--token-budget', '100000', '--used-tokens', '71000']);
    strictEqual(check.command, 'check');
    strictEqual(check.tokenBudget, 100000);
    strictEqual(check.usedTokens, 71000);

    throws(() => parseArgs(['status', '--run-id', '../bad']), /Invalid --run-id/);
    throws(() => parseArgs(['capture', '--risk', 'orange']), /green, yellow, or red/);
    throws(() => parseArgs(['capture', '--artifact', 'bad\npath']), /single-line/);
    throws(() => parseArgs(['check', '--token-budget', '0', '--used-tokens', '1']), /positive integer/);
    throws(() => parseArgs(['check', '--used-tokens', 'abc']), /non-negative integer/);
  });

  it('rejects ambiguous or incomplete context budget checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-context-check-invalid-'));
    await rejectsAsync(
      runContext({
        command: 'check',
        repoRoot: root,
        tokenBudget: 100000,
      }),
      /check requires --token-budget/,
    );
    await rejectsAsync(
      runContext({
        command: 'check',
        repoRoot: root,
        tokenBudget: 100000,
        usedTokens: 1000,
        remainingTokens: 99000,
      }),
      /Use either --used-tokens or --remaining-tokens/,
    );
    await rejectsAsync(
      runContext({
        command: 'check',
        repoRoot: root,
        tokenBudget: 100000,
        usedTokens: 1000,
        risk: 'green',
      }),
      /Use budget metrics or --risk/,
    );
  });

  it('rejects missing or ambiguous context status lookup inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-context-status-invalid-'));
    await rejectsAsync(
      runContext({
        command: 'status',
        repoRoot: root,
      }),
      /status requires --run-id or --latest/,
    );
    await rejectsAsync(
      runContext({
        command: 'status',
        repoRoot: root,
        runId: RUN_ID,
        latest: true,
      }),
      /Use either --run-id or --latest/,
    );
    await rejectsAsync(
      runContext({
        command: 'status',
        repoRoot: root,
        latest: true,
      }),
      /No context artifacts found/,
    );
  });
});

describe('runtime session handoff (ADR-0031)', () => {
  const fullProjection = (overrides = {}) => ({
    workflow_kind: 'engineer',
    workflow_id: 'w1',
    workflow_path: '.agentic-plugins/state/engineer/workflows/w1.md',
    phase: 'phase-2-presented',
    next_action: 'commit',
    archive_gate: 'ready_to_archive',
    routing_recommendation: 'commit then /orchestrator:next',
    ...overrides,
  });
  // evaluateSessionHandoff reads only archive_gate / routing_recommendation, so
  // its matrix tests can pass a minimal projection (it does not run normalizeProjection).
  const READY = { archive_gate: 'ready_to_archive' };
  const BLOCKED = { archive_gate: 'blocked' };

  it('applies the continue-vs-fresh decision-policy matrix', () => {
    const matrix = [
      ['green', READY, 'current_or_resumed'],
      ['green', BLOCKED, 'current_or_resumed'],
      ['yellow', READY, 'fresh_or_resumed'],
      ['yellow', BLOCKED, 'current_or_resumed'],
      ['yellow', null, 'current_or_resumed'],
      ['red', READY, 'fresh_or_resumed'],
      ['red', null, 'fresh_or_resumed'],
    ];
    for (const [risk, projection, expected] of matrix) {
      const result = evaluateSessionHandoff({ riskLevel: risk, projection });
      strictEqual(
        result.recommended_session,
        expected,
        `${risk} x ${projection?.archive_gate ?? 'absent'}`,
      );
    }
  });

  it('treats an absent or unrecognized caller risk as yellow (fail-soft, never throws)', () => {
    const absent = evaluateSessionHandoff({ projection: BLOCKED });
    strictEqual(absent.context_risk, 'yellow');
    strictEqual(absent.context_risk_supplied, false);
    // an unusual stored risk must degrade, not throw (the status path reads stored values).
    const weird = evaluateSessionHandoff({ riskLevel: 'orange', projection: READY });
    strictEqual(weird.context_risk, 'yellow');
    strictEqual(weird.context_risk_supplied, false);
    ok(absent.limits.some((limit) => /caller-supplied, not host-measured/i.test(limit)));
  });

  it('returns null only when risk, projection, and routing are all absent', () => {
    strictEqual(evaluateSessionHandoff({}), null);
    ok(evaluateSessionHandoff({ routing: '/orchestrator:next' }));
  });

  it('keeps routing available standalone when no projection is present and emits a fresh next_command', () => {
    const result = evaluateSessionHandoff({ riskLevel: 'red', routing: '/orchestrator:next' });
    strictEqual(result.recommended_session, 'fresh_or_resumed');
    strictEqual(result.routing_recommendation, '/orchestrator:next');
    strictEqual(result.next_command, '/orchestrator:next');
    // no next_command when staying in the current session.
    const stay = evaluateSessionHandoff({ riskLevel: 'green', projection: fullProjection() });
    strictEqual(stay.recommended_session, 'current_or_resumed');
    strictEqual(stay.next_command, null);
  });

  it('reports the archive gate without acting on it (runtime non-mutating)', () => {
    const result = evaluateSessionHandoff({ riskLevel: 'yellow', projection: READY });
    strictEqual(result.archive_gate, 'ready_to_archive');
    ok(/ready_to_archive/.test(result.archive_gate_report));
    ok(result.limits.some((limit) => /non-mutating/i.test(limit)));
  });

  it('reports an honest unsupported workflow_kind instead of degrading to no-active-workflow (runtime-unsupported-kind)', () => {
    // An active workflow whose kind runtime cannot model (e.g. founder) reaches
    // the seam as projection=null + unsupportedKind=<name>. The seam MUST
    // distinguish it from a genuinely absent projection.
    const handoff = evaluateSessionHandoff({
      riskLevel: 'yellow',
      projection: null,
      unsupportedKind: 'founder',
      routing: '/founder:resume',
    });
    strictEqual(handoff.archive_gate, 'unsupported_kind');
    strictEqual(handoff.unsupported_workflow_kind, 'founder');
    ok(handoff.archive_gate !== 'absent', 'must NOT claim no-active-workflow/absent');
    ok(/founder/.test(handoff.reason), 'reason names the unsupported kind');
    ok(/founder/.test(handoff.archive_gate_report), 'report names the unsupported kind');
    ok(/engineer, orchestrator/.test(handoff.archive_gate_report), 'report names the supported kinds');
    ok(handoff.limits.some((l) => /out of scope/i.test(l)), 'enablement boundary recorded');
    // runtime cannot read an unsupported workflow's archive readiness, so under
    // yellow the conservative decision still continues (no projected gate to act on).
    strictEqual(handoff.recommended_session, 'current_or_resumed');
    strictEqual(handoff.workflow, null);

    // Under red budget the handoff goes fresh, but the report stays honest about
    // the unsupported kind and the routing command flows through.
    const red = evaluateSessionHandoff({ riskLevel: 'red', unsupportedKind: 'founder', routing: '/founder:resume' });
    strictEqual(red.recommended_session, 'fresh_or_resumed');
    strictEqual(red.archive_gate, 'unsupported_kind');
    strictEqual(red.next_command, '/founder:resume');

    // A malformed projection (empty/whitespace kind) is NOT an unsupported kind:
    // it stays the legacy absent path with no false unsupported_kind report.
    const malformed = evaluateSessionHandoff({ riskLevel: 'yellow', unsupportedKind: '   ' });
    strictEqual(malformed.archive_gate, 'absent');
    strictEqual('unsupported_workflow_kind' in malformed, false);
  });

  it('fail-closes a malformed projection and accepts a complete one (bounded schema)', () => {
    const rejected = [
      { workflow_kind: 'designer' },
      fullProjection({ archive_gate: 'nope' }),
      fullProjection({ workflow_id: '' }),
      fullProjection({ phase: '' }),
      (() => { const p = fullProjection(); delete p.routing_recommendation; return p; })(),
      fullProjection({ workflow_path: '/etc/x' }),
      fullProjection({ workflow_path: 'C:\\Users\\me\\w.md' }),
      fullProjection({ workflow_path: '\\\\server\\share\\w.md' }),
      fullProjection({ workflow_path: '../x' }),
      { ...fullProjection(), unexpected_key: 1 },
      [1, 2],
    ];
    for (const raw of rejected) {
      const { projection, error } = normalizeProjection(raw);
      strictEqual(projection, null, `should reject ${JSON.stringify(raw).slice(0, 50)}`);
      ok(error, 'a rejection must carry an error message');
    }
    // runtime-unsupported-kind: a real, named-but-unsupported kind is surfaced as
    // a typed unsupportedKind signal (so the seam can report it honestly); a
    // malformed projection (empty/non-string kind) does NOT set it.
    strictEqual(normalizeProjection({ workflow_kind: 'designer' }).unsupportedKind, 'designer');
    strictEqual(normalizeProjection(fullProjection({ workflow_kind: 'founder' })).unsupportedKind, 'founder');
    strictEqual(normalizeProjection({ workflow_kind: '' }).unsupportedKind ?? null, null);
    strictEqual(normalizeProjection({ workflow_kind: 42 }).unsupportedKind ?? null, null);
    // the rejected projection's own routing is preserved so the honest fallback
    // keeps a routing-shaped next command (founder's ok-case supplies routing
    // only inside the projection file, never standalone).
    strictEqual(normalizeProjection(fullProjection({ workflow_kind: 'founder' })).unsupportedRouting, 'commit then /orchestrator:next');
    strictEqual(normalizeProjection({ workflow_kind: 'designer' }).unsupportedRouting ?? null, null);
    deepStrictEqual(normalizeProjection(null), { projection: null, error: null });
    const accepted = normalizeProjection(fullProjection({ workflow_kind: 'orchestrator', archive_gate: 'not_terminal' }));
    strictEqual(accepted.error, null);
    strictEqual(accepted.projection.workflow_kind, 'orchestrator');
    strictEqual(accepted.projection.routing_recommendation, 'commit then /orchestrator:next');
    strictEqual(accepted.projection.checkpoint, null); // the only optional field
  });

  it('composes the session decision into a check report and degrades on a bad projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-check-projection-'));
    const projPath = join(root, 'proj.json');
    await writeFile(projPath, JSON.stringify(fullProjection({ archive_gate: 'ready_to_archive' })));
    const report = await runContext({ command: 'check', repoRoot: root, risk: 'yellow', workflowProjectionFile: projPath });
    strictEqual(report.session_handoff.recommended_session, 'fresh_or_resumed');
    strictEqual(report.session_handoff.archive_gate, 'ready_to_archive');
    strictEqual(report.session_handoff.next_command, 'commit then /orchestrator:next');
    strictEqual(report.projection_error, undefined);
    ok(formatText(report).includes('session handoff (continue-vs-fresh):'));

    const badPath = join(root, 'bad.json');
    await writeFile(badPath, JSON.stringify({ workflow_kind: 'designer', archive_gate: 'ready_to_archive' }));
    const degraded = await runContext({ command: 'check', repoRoot: root, risk: 'green', workflowProjectionFile: badPath });
    // runtime-unsupported-kind: a real-but-unmodelable kind degrades HONESTLY to
    // 'unsupported_kind' (naming the kind), NOT silently to 'absent' /
    // no-active-workflow. The decision still continues (green), the projection
    // error is still surfaced — only the report is now honest.
    strictEqual(degraded.session_handoff.archive_gate, 'unsupported_kind');
    strictEqual(degraded.session_handoff.unsupported_workflow_kind, 'designer');
    strictEqual(degraded.session_handoff.recommended_session, 'current_or_resumed');
    ok(/workflow_kind|unknown/.test(degraded.projection_error));
  });

  it('leaves a green check with no projection unchanged but fires the preflight at yellow/red risk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-check-green-'));
    const green = await runContext({ command: 'check', repoRoot: root, risk: 'green' });
    strictEqual('session_handoff' in green, false);
    strictEqual('projection_error' in green, false);
    const yellow = await runContext({ command: 'check', repoRoot: root, risk: 'yellow' });
    ok(yellow.session_handoff);
    strictEqual(yellow.session_handoff.archive_gate, 'absent');
  });

  it('folds the session decision into a status handoff only when a projection is supplied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-status-projection-'));
    await runContext({
      command: 'capture',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T00:00:00.000Z'),
      summary: 'Status projection test artifact.',
      risk: 'red',
      nextSessionPrompt: 'Continue from the artifact.',
    });
    const projPath = join(root, 'proj.json');
    await writeFile(projPath, JSON.stringify(fullProjection({ archive_gate: 'not_terminal' })));
    const withProjection = await runContext({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T00:05:00.000Z'),
      workflowProjectionFile: projPath,
    });
    ok(withProjection.handoff.guidance.session_handoff);
    strictEqual(withProjection.handoff.guidance.session_handoff.recommended_session, 'fresh_or_resumed');
    strictEqual(withProjection.handoff.guidance.session_handoff.archive_gate, 'not_terminal');
    // C3 — the nested session handoff is surfaced in text output too.
    ok(formatText(withProjection).includes('session handoff (continue-vs-fresh):'));

    const withoutProjection = await runContext({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T00:05:00.000Z'),
    });
    strictEqual('session_handoff' in withoutProjection.handoff.guidance, false);
  });

  it('surfaces an honest unsupported workflow_kind with preserved routing through the status handoff (runtime-unsupported-kind)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-status-unsupported-'));
    await runContext({
      command: 'capture',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T00:00:00.000Z'),
      summary: 'Unsupported-kind status handoff test artifact.',
      risk: 'red',
      nextSessionPrompt: 'Continue from the artifact.',
    });
    const projPath = join(root, 'founder.json');
    // A founder projection: runtime does not model 'founder', and founder's
    // ok-case wiring passes routing INSIDE the projection file, not standalone.
    await writeFile(projPath, JSON.stringify(fullProjection({ workflow_kind: 'founder', routing_recommendation: '/founder:resume' })));
    const report = await runContext({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T00:05:00.000Z'),
      workflowProjectionFile: projPath,
    });
    const sh = report.handoff.guidance.session_handoff;
    ok(sh, 'the status handoff carries the session decision');
    strictEqual(sh.archive_gate, 'unsupported_kind');
    strictEqual(sh.unsupported_workflow_kind, 'founder');
    // the projection's own routing survives unsupported-kind rejection, so a
    // red-risk fresh handoff still names the founder resume command.
    strictEqual(sh.recommended_session, 'fresh_or_resumed');
    strictEqual(sh.routing_recommendation, '/founder:resume');
    strictEqual(sh.next_command, '/founder:resume');
    ok(report.projection_error, 'the projection rejection is still surfaced');
    ok(formatText(report).includes('unsupported workflow kind: founder'));
  });

  it('keeps the merged handoff guidance coherent when the session forces fresh over a reusable artifact', () => {
    // freshness alone says reuse_handoff (verified source, not stale); the session
    // layer (red risk) must flip it to fresh AND carry a coherent reason/action.
    const sourceFreshness = { status: 'verified', current_dirty: false };
    const sessionHandoff = evaluateSessionHandoff({ riskLevel: 'red', projection: fullProjection({ archive_gate: 'blocked' }) });
    const guidance = buildHandoffGuidance({ runId: RUN_ID, stale: false, sourceFreshness, sessionHandoff });
    strictEqual(guidance.recommended_session, 'fresh_or_resumed');
    strictEqual(guidance.state, 'session_handoff_fresh');
    ok(/red/i.test(guidance.reason));
    ok(/fresh session/i.test(guidance.recommended_action));
    ok(guidance.session_handoff);
    // with no sessionHandoff the guidance is byte-for-byte the legacy freshness result.
    const legacy = buildHandoffGuidance({ runId: RUN_ID, stale: false, sourceFreshness });
    strictEqual(legacy.recommended_session, 'current_or_resumed');
    strictEqual('session_handoff' in legacy, false);
  });

  it('parses --workflow-projection-file and --routing-recommendation', () => {
    const options = parseArgs([
      'check', '--risk', 'yellow',
      '--workflow-projection-file', '/tmp/p.json',
      '--routing-recommendation', '/orchestrator:next',
    ]);
    strictEqual(options.workflowProjectionFile, '/tmp/p.json');
    strictEqual(options.routingRecommendation, '/orchestrator:next');
  });
});

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function rejectsAsync(promise, pattern) {
  try {
    await promise;
  } catch (error) {
    ok(pattern.test(error.message), `expected ${error.message} to match ${pattern}`);
    return;
  }
  throw new Error('Expected promise to reject');
}
