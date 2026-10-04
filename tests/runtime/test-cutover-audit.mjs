import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual, throws } from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatText,
  parseArgs,
  recordCutoverEvidence,
  runCutoverAudit,
} from '../../plugins/runtime/scripts/cutover-audit.mjs';

const NOW = new Date('2026-05-16T08:00:00.000Z');
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');

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
    ok(report.cutover_gate.candidate_required.includes('ADR-0012 conditions 1-4 satisfied'));
    ok(report.cutover_gate.final_required.includes('explicit user cutover declaration per ADR-0007'));
    strictEqual(report.cutover_gate.details.find((detail) => detail.id === 'adr0012_condition_gate').status, 'satisfied');
    strictEqual(report.cutover_gate.details.find((detail) => detail.id === 'scorecard_gate').current, '12/12 satisfied');
    strictEqual(report.cutover_gate.details.find((detail) => detail.id === 'final_owner_declaration').status, 'manual');
    strictEqual(report.operator_verification.length, 1);
    strictEqual(report.operator_verification[0].id, 'final-owner-declaration');
    strictEqual(report.operator_verification[0].status, 'manual');
    ok(report.checks.every((check) => ['satisfied', 'current', 'fresh', 'not-active'].includes(check.status)));
    const text = formatText(report);
    ok(text.includes('ready-candidate: true'));
    ok(text.includes('candidate gate: ADR-0012 conditions 1-4 satisfied'));
    ok(text.includes('final gate: explicit user cutover declaration per ADR-0007'));
    ok(text.includes('gate details:'));
    ok(text.includes('candidate:scorecard_gate: satisfied; required=omcc replacement scorecard 100%'));
    ok(text.includes('final:final_owner_declaration: manual'));
    ok(text.includes('operator verification:'));
    ok(text.includes('- final-owner-declaration: manual; owner=owner'));
  });

  // ADR-0060 §Decision 3 — the compat freshness check went with `runtime:compat`,
  // and nothing replaces it. The audit must SAY that host-pair identity is not
  // verified: an absent check must not read as a passing one. It must also not
  // turn that statement into a blocker, because no operator action clears it.
  it('states that host-pair identity is NOT verified — never a check, never a blocker, never a pass (ADR-0060)', async () => {
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
      footerReason: 'closed',
      omccDevActive: 'no',
      completionAudit: true,
    });

    // Not a blocker: every gating check passes, so the audit is a candidate.
    strictEqual(report.ready_candidate, true);
    strictEqual(report.checks.some((check) => /compat|host_pair|baseline/.test(check.id)), false, 'no check gates on host versions');
    ok(!report.cutover_gate.candidate_required.some((line) => /compatib/i.test(line)), 'the gate list names no compatibility run');

    // Not a pass: the observation says `not_verified`, with the versions as facts.
    const identity = report.observations.find((entry) => entry.id === 'host_pair_identity');
    strictEqual(identity.status, 'not_verified');
    deepStrictEqual(identity.evidence.claude, { probe: 'available', version: '2.1.143 (Claude Code)' });
    deepStrictEqual(identity.evidence.codex, { probe: 'available', version: 'codex-cli 0.130.0' });
    ok(report.limits.some((limit) => /Host-pair identity is not verified \(ADR-0060\)/.test(limit)), 'the limit is stated');

    // The completion audit reports it apart from what an operator can fix.
    deepStrictEqual(report.completion_audit.unverified_scope.map((item) => item.id), ['host_pair_identity']);
    strictEqual(report.completion_audit.missing_or_weak.some((item) => item.id === 'host_pair_identity'), false);
    ok(!report.completion_audit.artifact_checklist.some((item) => ['host-parity-baseline', 'runtime-compat-freshness'].includes(item.id)));

    const text = formatText(report);
    ok(text.includes('- host_pair_identity: not_verified;'), text);
    ok(text.includes('observed claude=2.1.143 (Claude Code); codex=codex-cli 0.130.0 (facts, not compared against anything)'));
    ok(text.includes('not verified (scope limits, not blockers):'));
    ok(!/runtime:compat/.test(text), 'no remediation names the removed command');
  });

  it('never reports a failed version probe as an observed version', async () => {
    // A failed `--version` probe carries its stderr or error message in `text`.
    // Labelling that an observed version would invent one.
    const repoRoot = await mkdtemp(join(tmpdir(), 'cutover-identity-probe-'));
    const doctor = doctorReport();
    doctor.clis.claude = { version: { status: 'unavailable', text: 'spawn claude ENOENT' } };
    const report = await runCutoverAudit({ repoRoot, now: NOW, doctorReport: doctor });
    const identity = report.observations.find((entry) => entry.id === 'host_pair_identity');
    deepStrictEqual(identity.evidence.claude, { probe: 'unavailable', version: null });
    deepStrictEqual(identity.evidence.codex, { probe: 'available', version: 'codex-cli 0.130.0' });
    strictEqual(identity.status, 'not_verified');
    ok(formatText(report).includes('observed claude=<unavailable>; codex=codex-cli 0.130.0'));
  });

  // Relocated from test-baseline-consumer-contract.mjs, which ADR-0060 deleted
  // with the baseline it was named for. `next_actions` is the list an operator
  // works through, so these pin that every unready check reaches it — with its
  // own remediation when it has one — and that no passing check does.
  it('an unready check carries its OWN remediation into next_actions', async () => {
    // `checkUnready` is the COMPLEMENT of pass, which makes every status —
    // known or not — unready; this case drives a real unready status that
    // carries its own next action. (It used `latest_compat_snapshot` until
    // ADR-0060 removed that check.)
    const repoRoot = await mkdtemp(join(tmpdir(), 'cutover-remediation-'));
    const report = await runCutoverAudit({ repoRoot, doctorReport: {}, now: NOW });
    const footer = report.checks.find((entry) => entry.id === 'latest_completion_footer_state');
    strictEqual(footer.status, 'not-verified');
    ok(footer.next_action, 'CONTROL: this check must carry a remediation of its own, or the case proves nothing');
    const surfaced = report.next_actions.find((entry) => entry.id === 'latest_completion_footer_state');
    strictEqual(surfaced?.next_action, footer.next_action);
    strictEqual(report.ready_candidate, false);
  });

  it('a blocking check with NO remediation of its own is still named — no silent blocker', async () => {
    // `next_actions` used to drop any entry whose `next_action` was absent, so
    // the audit refused readiness and printed nothing to fix.
    // `omcc_replacement_scorecard` genuinely has no `next_action` of its own on a
    // bare repo (measured), so it drives the synthesized line without a seam.
    const repoRoot = await mkdtemp(join(tmpdir(), 'cutover-remediation-'));
    const report = await runCutoverAudit({ repoRoot, doctorReport: {}, now: NOW });
    const bare = report.checks.find((entry) => entry.id === 'omcc_replacement_scorecard');
    strictEqual(bare.next_action ?? null, null, 'CONTROL: this check must have no remediation of its own, or the case proves nothing');
    const surfaced = report.next_actions.find((entry) => entry.id === 'omcc_replacement_scorecard');
    ok(surfaced, 'a blocking check must appear in next_actions even with no next_action of its own');
    ok(/blocks readiness and reported no remediation/.test(surfaced.next_action), surfaced.next_action);
    strictEqual(report.ready_candidate, false);
  });

  it('cutover does NOT invent a remediation for a passing check — CONTROL', async () => {
    // Complement-of-pass must not swallow the pass set. The relocated form of
    // this case carried a sentinel on `host_parity_baseline` — an OBSERVATION,
    // not a check, so it could never reach `next_actions` whatever the predicate
    // did, and it passed vacuously from ADR-0053 on. A passing check is the only
    // shape that isolates the predicate: with `checkUnready` returning true for
    // everything, the synthesized fallback line names it, and this fails.
    const repoRoot = await mkdtemp(join(tmpdir(), 'cutover-remediation-'));
    const report = await runCutoverAudit({ repoRoot, doctorReport: {}, now: NOW, footerState: 'closed', omccDevActive: 'no' });
    strictEqual(report.checks.find((entry) => entry.id === 'latest_completion_footer_state').status, 'satisfied');
    strictEqual(report.checks.find((entry) => entry.id === 'omcc_dev_daily_workflow').status, 'not-active');
    strictEqual(report.next_actions.some((entry) => entry.id === 'latest_completion_footer_state'), false);
    strictEqual(report.next_actions.some((entry) => entry.id === 'omcc_dev_daily_workflow'), false);
  });

  it('builds a prompt-to-artifact completion audit checklist on request', async () => {
    const root = await seedRepo({
      scorecardStatus: 'satisfied',
      conditionStatus: 'partial',
      contextCreatedAt: '2026-05-16T07:30:00.000Z',
      cutoverEvidenceDates: ['2026-05-16'],
    });
    const report = await runCutoverAudit({
      repoRoot: root,
      now: NOW,
      doctorReport: doctorReport(),
      footerState: 'next-work-available',
      footerReason: 'follow-up remains open',
      omccDevActive: 'no',
      completionAudit: true,
    });

    strictEqual(report.status, 'not-ready');
    strictEqual(report.completion_audit.requirements.length, 12);
    strictEqual(report.completion_audit.requirements[0].id, 'R1');
    strictEqual(report.completion_audit.requirements[0].source, 'docs/assurance/omcc-cutover-scorecard.md');
    ok(report.completion_audit.adr0012_conditions.some((row) => (
      row.id === 'ADR-0012 condition 3' && row.status === 'partial'
    )));
    const condition3Advice = report.completion_audit.adr0012_transition_advice.find((row) => row.condition === '3');
    strictEqual(condition3Advice.status, 'partial');
    ok(condition3Advice.required.includes('agentic-plugins-only development sufficiency'));
    ok(condition3Advice.evidence.includes('covered=1/7; window=2026-05-16..2026-05-22'));
    ok(condition3Advice.blockers.some((blocker) => blocker.includes('dogfood remaining dates')));
    const condition4Advice = report.completion_audit.adr0012_transition_advice.find((row) => row.condition === '4');
    ok(condition4Advice.blockers.includes('ADR-0012 condition 3 is not satisfied yet'));
    ok(condition4Advice.blockers.includes('completion footer is next-work-available'));
    ok(report.completion_audit.artifact_checklist.some((item) => (
      item.id === 'runtime-doctor-proof'
        && item.kind === 'command'
        && item.source.includes('runtime:doctor --permission-proof')
    )));
    // ADR-0060 — the baseline and compat rows left the checklist with their subject.
    ok(!report.completion_audit.artifact_checklist.some((item) => ['host-parity-baseline', 'runtime-compat-freshness'].includes(item.id)));
    ok(report.completion_audit.artifact_checklist.some((item) => (
      item.id === 'runtime-cutover-dogfood-records'
        && item.evidence === 'covered=1/7; window=2026-05-16..2026-05-22'
    )));
    ok(report.completion_audit.gate_checklist.some((item) => item.id === 'final_owner_declaration'));
    ok(report.completion_audit.missing_or_weak.some((item) => item.id === 'ADR-0012 condition 3'));
    ok(report.completion_audit.missing_or_weak.some((item) => item.id === 'completion_footer_gate'));

    const text = formatText(report);
    ok(text.includes('completion audit:'));
    ok(text.includes('requirements:'));
    ok(text.includes('- R1: satisfied; source=docs/assurance/omcc-cutover-scorecard.md; requirement=superior compatible'));
    ok(text.includes('adr0012 transition advice:'));
    ok(text.includes('- condition 3: partial; required=agentic-plugins-only development sufficiency after sustained no-omcc-dev dogfood'));
    ok(text.includes('blockers=dogfood remaining dates: 2026-05-17'));
    ok(text.includes('artifact checklist:'));
    ok(text.includes('- runtime-doctor-proof: satisfied; kind=command; source=runtime:doctor --permission-proof'));
    ok(text.includes('missing or weak:'));
    ok(text.includes('- ADR-0012 condition 3: partial; source=docs/DEVELOPMENT.md'));
  });

  // A requirement withdrawn by an accepted decision (R9, by ADR-0060) is reported
  // apart from both counts: neither satisfied nor outstanding, and named
  // wherever the count is, so 100% never hides a shrunken denominator. The
  // decision must check out — an accepted ADR under docs/adr/ whose paragraph
  // names the row and withdraws it — or the row stays unresolved
  // (cross-host refine-verify: a bare `ADR-NNNN` mention used to be enough).
  const WITHDRAWING_ADR = `# ADR-0060: Remove host-version tracking

## Status

Accepted (2026-09-18).

## Amendment

**(h) Scorecard R9 is withdrawn, not satisfied.** The owner decided to record it as withdrawn.
`;
  async function auditScorecard({ overrides = {}, extraRows = [], adrFiles = { '0060-remove-host-version-tracking.md': WITHDRAWING_ADR } } = {}) {
    const root = await seedRepo({
      scorecardStatus: 'satisfied',
      scorecardOverrides: overrides,
      scorecardExtraRows: extraRows,
      adrFiles,
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
      completionAudit: true,
    });
    return { report, scorecard: report.checks.find((check) => check.id === 'omcc_replacement_scorecard') };
  }
  const R9_WITHDRAWN = { status: 'withdrawn', evidence: 'removed with host-version tracking', gate: 'Withdrawn by ADR-0060' };

  it('reports a verified withdrawn scorecard row apart from the count, and never as a blocker', async () => {
    const { report, scorecard } = await auditScorecard({ overrides: { R9: R9_WITHDRAWN } });
    strictEqual(scorecard.status, 'satisfied');
    strictEqual(scorecard.evidence.total, 11, 'the withdrawn row leaves the denominator');
    strictEqual(scorecard.evidence.satisfied, 11);
    deepStrictEqual(scorecard.evidence.withdrawn.map((row) => `${row.requirement}@${row.decision}`), ['R9@ADR-0060']);
    deepStrictEqual(scorecard.evidence.unresolved, []);
    strictEqual(report.ready_candidate, true, 'a withdrawn requirement does not hold readiness');
    const r9 = report.completion_audit.requirements.find((row) => row.id === 'R9');
    strictEqual(r9.status, 'withdrawn', 'the row stays visible, as withdrawn');
    strictEqual(r9.decision, 'ADR-0060');
    ok(!report.completion_audit.missing_or_weak.some((row) => row.id === 'R9'), 'a verified withdrawal is not a blocker');
    strictEqual(report.cutover_gate.details.find((detail) => detail.id === 'scorecard_gate').current, '11/11 satisfied; withdrawn=R9');
    const condition4 = report.completion_audit.adr0012_transition_advice.find((row) => row.condition === '4');
    ok(condition4.evidence.includes('scorecard=11/11; withdrawn=R9'), JSON.stringify(condition4.evidence));
    const text = formatText(report);
    ok(text.includes('scorecard: satisfied=11/11; withdrawn=R9'), 'the count names what left it');
    ok(text.includes('withdrawn scorecard detail: R9:withdrawn; decision=ADR-0060; requirement=compat; gate=Withdrawn by ADR-0060'));
  });

  it('keeps a withdrawn row unresolved unless its decision checks out', async () => {
    const cases = [
      {
        name: 'no citation',
        overrides: { R9: { status: 'withdrawn', evidence: 'no longer wanted', gate: 'none' } },
        expected: 'R9:withdrawn-uncited',
        problem: /cites no ADR/,
      },
      {
        name: 'an ADR that withdraws a DIFFERENT row',
        overrides: { R1: { status: 'withdrawn', evidence: 'ADR-0060 withdraws R9 only', gate: 'none' } },
        expected: 'R1:withdrawn-unverified',
        problem: /ADR-0060 does not say it withdraws R1/,
      },
      {
        name: 'an ADR that does not exist',
        overrides: { R9: { ...R9_WITHDRAWN, gate: 'Withdrawn by ADR-9999' } },
        adrFiles: {},
        expected: 'R9:withdrawn-unverified',
        problem: /ADR-9999 is not under docs\/adr\//,
      },
      {
        name: 'an ADR that is not Accepted',
        overrides: { R9: R9_WITHDRAWN },
        adrFiles: { '0060-remove-host-version-tracking.md': WITHDRAWING_ADR.replace('Accepted (2026-09-18).', 'Proposed') },
        expected: 'R9:withdrawn-unverified',
        problem: /ADR-0060 is not Accepted/,
      },
    ];
    for (const entry of cases) {
      const { report, scorecard } = await auditScorecard(entry);
      strictEqual(scorecard.status, 'partial', entry.name);
      deepStrictEqual(scorecard.evidence.unresolved.map((row) => `${row.requirement}:${row.status}`), [entry.expected], entry.name);
      match(scorecard.evidence.unresolved[0].problem, entry.problem, entry.name);
      deepStrictEqual(scorecard.evidence.withdrawn, [], entry.name);
      strictEqual(report.ready_candidate, false, entry.name);
      const blocker = report.completion_audit.missing_or_weak.find((row) => row.id === entry.expected.split(':')[0]);
      match(blocker?.blocker ?? '', entry.problem, `${entry.name}: the blocker says why`);
    }
  });

  it('refuses a requirement id that appears on more than one row', async () => {
    // A stale satisfied R9 left beside the withdrawn one would otherwise count
    // R9 as satisfied AND list it as withdrawn.
    const { report, scorecard } = await auditScorecard({
      overrides: { R9: R9_WITHDRAWN },
      extraRows: ['| R9 | compat (old row) | evidence | satisfied | ok |'],
    });
    strictEqual(scorecard.status, 'partial');
    deepStrictEqual(scorecard.evidence.unresolved.map((row) => `${row.requirement}:${row.status}`), ['R9:duplicate-id', 'R9:duplicate-id']);
    deepStrictEqual(scorecard.evidence.withdrawn, []);
    strictEqual(scorecard.evidence.satisfied, 11, 'neither copy counts as satisfied');
    strictEqual(report.ready_candidate, false);
  });

  it('reads a scorecard whose every row is withdrawn as missing, not satisfied', async () => {
    const ids = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7a', 'R7b', 'R8', 'R9', 'R10', 'R11'];
    const adr = WITHDRAWING_ADR.replace('**(h) Scorecard R9 is withdrawn, not satisfied.**', `**(h) Scorecard ${ids.join(', ')} are withdrawn.**`);
    const { report, scorecard } = await auditScorecard({
      overrides: Object.fromEntries(ids.map((id) => [id, R9_WITHDRAWN])),
      adrFiles: { '0060-remove-host-version-tracking.md': adr },
    });
    strictEqual(scorecard.evidence.withdrawn.length, 12, 'every withdrawal verified, so only the guard can refuse');
    strictEqual(scorecard.status, 'missing');
    strictEqual(report.ready_candidate, false);
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
    strictEqual(report.checks.find((check) => check.id === 'observed_experience_parity').status, 'satisfied');
    strictEqual(report.checks.find((check) => check.id === 'latest_consensus_context_artifacts').status, 'stale');
    strictEqual(report.checks.find((check) => check.id === 'dogfood_evidence_window').status, 'not-verified');
    strictEqual(report.checks.find((check) => check.id === 'latest_completion_footer_state').status, 'not-verified');
    strictEqual(report.checks.find((check) => check.id === 'omcc_dev_daily_workflow').status, 'not-verified');
    const scorecard = report.checks.find((check) => check.id === 'omcc_replacement_scorecard');
    strictEqual(scorecard.evidence.unresolved[0].summary, 'superior compatible');
    strictEqual(scorecard.evidence.unresolved[0].gate, 'ok');
    ok(report.next_actions.some((entry) => entry.id === 'omcc_dev_daily_workflow'));
    const text = formatText(report);
    ok(text.includes('candidate gate: ADR-0012 conditions 1-4 satisfied'));
    ok(text.includes('final gate: explicit user cutover declaration per ADR-0007'));
    ok(text.includes('candidate:adr0012_condition_gate: partial'));
    ok(text.includes('current=1:partial, 2:partial, 3:partial, 4:partial'));
    ok(text.includes('candidate:scorecard_gate: partial'));
    ok(text.includes('blocker=R1:partial'));
    ok(text.includes('conditions: 1:partial, 2:partial, 3:partial, 4:partial'));
    ok(text.includes('unresolved: 1:partial, 2:partial, 3:partial, 4:partial'));
    ok(text.includes('scorecard: satisfied=0/12; unresolved=R1:partial'));
    ok(text.includes('unresolved scorecard detail: R1:partial; requirement=superior compatible; gate=ok'));
    ok(text.includes('experience parity: status=ready; score=100%; manual-followups=0'));
    ok(text.includes('legacy map: patterns=20; improved=14; retained=1; rejected=2; deferred=3'));
    ok(text.includes('dogfood window: covered=0/7; latest=<none>; records=0'));
  });

  it('blocks readiness on partial observed experience parity even when docs and dogfood are otherwise ready', async () => {
    const root = await seedRepo({
      scorecardStatus: 'satisfied',
      conditionStatus: 'satisfied',
      contextCreatedAt: '2026-05-16T07:30:00.000Z',
      cutoverEvidenceDates: oneWeekDogfoodDates(),
    });
    const doctor = doctorReport({
      experienceParity: {
        status: 'partial',
        score_percent: 91,
        manual_followup_count: 1,
        counts: { satisfied: 6, partial: 2, not_verified: 0, blocked: 0 },
        criteria: [
          { id: 'plugin_management_followups', status: 'partial' },
          { id: 'lifecycle_hook_continuity', status: 'partial' },
        ],
        next_actions: [
          {
            id: 'codex-hook-review',
            host: 'codex',
            commands: ['/hooks'],
            reason: 'Review/trust bundled hooks with /hooks.',
          },
        ],
      },
    });
    const report = await runCutoverAudit({
      repoRoot: root,
      now: NOW,
      doctorReport: doctor,
      footerState: 'closed',
      omccDevActive: 'no',
    });

    const parity = report.checks.find((check) => check.id === 'observed_experience_parity');
    strictEqual(report.status, 'not-ready');
    strictEqual(parity.status, 'partial');
    strictEqual(parity.evidence.score_percent, 91);
    strictEqual(parity.evidence.manual_followup_count, 1);
    ok(parity.evidence.unresolved_criteria.some((entry) => entry.id === 'lifecycle_hook_continuity'));
    const hookCheck = report.operator_verification.find((entry) => entry.id === 'codex-hook-review');
    strictEqual(hookCheck.status, 'pending');
    strictEqual(hookCheck.command, '/hooks');
    ok(hookCheck.verify.includes('active Codex session'));
    // The checklist must never hardcode a plugin pair. With no doctor
    // hook-report to read, it degrades to a generic subject rather than naming
    // a stale "engineer and orchestrator" set.
    ok(!/engineer and orchestrator/.test(hookCheck.verify),
      'the hook-review checklist must not hardcode "engineer and orchestrator"');
    ok(hookCheck.verify.includes('every bundled agentic-plugins hook'),
      `expected the generic fallback subject, got: ${hookCheck.verify}`);
    ok(hookCheck.pass_condition.includes('score 100%'));
    ok(hookCheck.fail_condition.includes('old cache-version command path'));
    ok(hookCheck.after.includes('runtime:settings --attest-codex-hook-review'));
    const text = formatText(report);
    ok(text.includes('experience parity: status=partial; score=91%; manual-followups=1'));
    ok(text.includes('candidate:observed_experience_parity_gate: partial'));
    ok(text.includes('required=observed runtime experience parity ready, score 100%, and zero manual follow-ups'));
    ok(text.includes('current=status=partial; score=91%; manual-followups=1'));
    ok(text.includes('blocker=plugin_management_followups:partial, lifecycle_hook_continuity:partial; followups=codex-hook-review'));
    ok(text.includes('operator verification:'));
    ok(text.includes('- codex-hook-review: pending; owner=operator; command=/hooks'));
    ok(text.includes('pass=runtime:doctor reports observed experience parity ready, score 100%, and zero manual follow-ups.'));
    ok(text.includes('fail=Any bundled hook remains disabled, untrusted, inactive, or still points at an old cache-version command path.'));
    ok(text.includes('unresolved criteria: plugin_management_followups:partial, lifecycle_hook_continuity:partial'));
    ok(text.includes('manual next actions: codex-hook-review'));
    ok(text.includes('follow-up detail: codex-hook-review; host=codex; commands=/hooks'));
  });

  // ADR-0042 RT: once a fourth hook-bearing plugin (designer) joins the runtime
  // inventory, the operator hook-review checklist must name the plugins doctor
  // actually reports as review targets. The old text hardcoded "engineer and
  // orchestrator", so an operator would review the wrong set, leave designer's
  // hooks untrusted, and the cutover gate could never satisfy.
  it('the operator hook-review checklist names the doctor-reported review targets, not a hardcoded pair (ADR-0042 RT)', async () => {
    const root = await seedRepo({
      conditionStatus: 'satisfied',
      contextCreatedAt: '2026-05-16T07:30:00.000Z',
      cutoverEvidenceDates: oneWeekDogfoodDates(),
    });
    const doctor = doctorReport({
      experienceParity: {
        status: 'partial',
        score_percent: 91,
        manual_followup_count: 1,
        counts: { satisfied: 6, partial: 2, not_verified: 0, blocked: 0 },
        criteria: [
          { id: 'plugin_management_followups', status: 'partial' },
          { id: 'lifecycle_hook_continuity', status: 'partial' },
        ],
        next_actions: [
          { id: 'codex-hook-review', host: 'codex', commands: ['/hooks'], reason: 'Review/trust bundled hooks with /hooks.' },
        ],
      },
    });
    doctor.codex_plugin_hooks = {
      status: 'ready',
      summary: { bundled_plugins: ['designer', 'engineer', 'orchestrator'] },
      review_targets: [
        { plugin: 'designer', version: '0.1.0' },
        { plugin: 'engineer', version: '1.0.0' },
        { plugin: 'orchestrator', version: '1.0.0' },
      ],
    };

    const report = await runCutoverAudit({
      repoRoot: root, now: NOW, doctorReport: doctor, footerState: 'closed', omccDevActive: 'no',
    });

    const hookCheck = report.operator_verification.find((entry) => entry.id === 'codex-hook-review');
    ok(hookCheck.verify.includes('designer'), `the checklist must name designer, got: ${hookCheck.verify}`);
    ok(hookCheck.verify.includes('engineer'), 'the checklist must still name engineer');
    ok(hookCheck.verify.includes('orchestrator'), 'the checklist must still name orchestrator');
    ok(!/engineer and orchestrator/.test(hookCheck.verify),
      'the hardcoded pair must be gone, not merely extended');
  });

  it('applies reusable recorded doctor proof to proof-only parity criteria', async () => {
    const root = await seedRepo({
      scorecardStatus: 'satisfied',
      conditionStatus: 'satisfied',
      contextCreatedAt: '2026-05-16T07:30:00.000Z',
      cutoverEvidenceDates: oneWeekDogfoodDates(),
    });
    const doctor = doctorReport({
      experienceParity: blockedExperienceParity(),
      recordedDoctorProof: reusableRecordedDoctorProof(),
    });
    const report = await runCutoverAudit({
      repoRoot: root,
      now: NOW,
      doctorReport: doctor,
      footerState: 'closed',
      omccDevActive: 'no',
    });

    const parity = report.checks.find((check) => check.id === 'observed_experience_parity');
    strictEqual(report.status, 'not-ready');
    strictEqual(parity.status, 'partial');
    strictEqual(parity.evidence.status, 'partial');
    // 92, not 91: the ninth criterion ST5 restored to this fixture raises both
    // the numerator and the denominator (120/130 rather than 105/115).
    strictEqual(parity.evidence.score_percent, 92);
    strictEqual(parity.evidence.recorded_doctor_proof.status, 'reusable');
    strictEqual(
      parity.evidence.recorded_doctor_proof.applied_criteria.join(','),
      'bidirectional_peer_execution,engineer_workflow_continuation_execution',
    );
    ok(!parity.evidence.unresolved_criteria.some((entry) => entry.id === 'bidirectional_peer_execution'));
    ok(!parity.evidence.next_actions.some((entry) => entry.id === 'engineer_workflow_continuation_execution'));
    const text = formatText(report);
    ok(text.includes('experience parity: status=partial; score=92%; manual-followups=1'));
    ok(text.includes('recorded proof applied: bidirectional_peer_execution, engineer_workflow_continuation_execution; run=doctor-20260516T073000Z-abc123'));
  });

  it('reports dogfood windows forward from the first accepted no-omcc-dev day', async () => {
    const root = await seedRepo({
      scorecardStatus: 'satisfied',
      conditionStatus: 'satisfied',
      contextCreatedAt: '2026-05-16T07:30:00.000Z',
      cutoverEvidenceDates: ['2026-05-16'],
    });
    const report = await runCutoverAudit({
      repoRoot: root,
      now: NOW,
      doctorReport: doctorReport(),
      footerState: 'next-work-available',
      omccDevActive: 'no',
    });

    const dogfood = report.checks.find((check) => check.id === 'dogfood_evidence_window');
    strictEqual(dogfood.status, 'partial');
    strictEqual(dogfood.evidence.window_start_date, '2026-05-16');
    strictEqual(dogfood.evidence.window_end_date, '2026-05-22');
    strictEqual(dogfood.evidence.covered_days, 1);
    strictEqual(dogfood.evidence.missing_dates.length, 0);
    strictEqual(dogfood.evidence.remaining_dates.length, 6);
    strictEqual(dogfood.evidence.remaining_dates[0], '2026-05-17');

    const text = formatText(report);
    ok(text.includes('window: 2026-05-16..2026-05-22'));
    ok(text.includes('candidate:dogfood_window_gate: partial'));
    ok(text.includes('current=covered=1/7; window=2026-05-16..2026-05-22'));
    ok(text.includes('blocker=remaining=2026-05-17, 2026-05-18'));
    ok(text.includes('candidate:completion_footer_gate: partial'));
    ok(text.includes('current=state=next-work-available'));
    ok(text.includes('remaining dates: 2026-05-17, 2026-05-18, 2026-05-19, 2026-05-20, 2026-05-21, 2026-05-22'));
    ok(!text.includes('missing dates: 2026-05-10'));
  });

  it('reports elapsed gaps as missing once a forward dogfood window has started', async () => {
    const root = await seedRepo({
      scorecardStatus: 'satisfied',
      conditionStatus: 'satisfied',
      contextCreatedAt: '2026-05-18T07:30:00.000Z',
      cutoverEvidenceDates: ['2026-05-16', '2026-05-18'],
    });
    const report = await runCutoverAudit({
      repoRoot: root,
      now: new Date('2026-05-18T08:00:00.000Z'),
      doctorReport: doctorReport(),
      footerState: 'next-work-available',
      omccDevActive: 'no',
    });

    const dogfood = report.checks.find((check) => check.id === 'dogfood_evidence_window');
    strictEqual(dogfood.status, 'partial');
    strictEqual(dogfood.evidence.window_start_date, '2026-05-16');
    strictEqual(dogfood.evidence.window_end_date, '2026-05-22');
    strictEqual(dogfood.evidence.covered_days, 2);
    strictEqual(dogfood.evidence.missing_dates.join(','), '2026-05-17');
    strictEqual(dogfood.evidence.remaining_dates.at(-1), '2026-05-22');
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
    strictEqual(versionCheck.evidence.entries.find((entry) => entry.plugin === 'runtime').codex_installed, '0.34.0');
    // No codex_install facts (an unpinned catalog, or a pin that lags the release):
    // the catalog is what must move, so the marketplace needs a refresh.
    strictEqual(versionCheck.next_action, 'Refresh the Codex marketplace (`codex plugin marketplace upgrade agentic-plugins`) so Codex installs the expected release of runtime, then rerun this audit.');
  });

  it('puts the install-cache restore before the hook review while an installed plugin\'s hooks cannot be read (round 5)', async () => {
    const root = await seedRepo({
      scorecardStatus: 'satisfied',
      conditionStatus: 'satisfied',
      contextCreatedAt: '2026-05-16T07:30:00.000Z',
      cutoverEvidenceDates: oneWeekDogfoodDates(),
    });
    const doctor = doctorReport({
      experienceParity: {
        status: 'partial',
        score_percent: 91,
        manual_followup_count: 1,
        counts: { satisfied: 6, partial: 2, not_verified: 0, blocked: 0 },
        criteria: [{ id: 'lifecycle_hook_continuity', status: 'partial' }],
        next_actions: [{ id: 'codex-hook-review', host: 'codex', commands: ['/hooks'], reason: 'Review/trust bundled hooks with /hooks.' }],
      },
    });
    doctor.codex_plugin_hooks = {
      status: 'install_unreadable',
      summary: { bundled_plugins: ['orchestrator'], install_unreadable_plugins: ['engineer'] },
      review_targets: [{ plugin: 'orchestrator' }],
      recommendations: [{ action: 'restore-codex-install-cache', detail: 'Codex lists engineer installed, but no install cache directory holds the listed version.' }],
    };
    const report = await runCutoverAudit({ repoRoot: root, now: NOW, doctorReport: doctor, footerState: 'closed', omccDevActive: 'no' });
    const ids = report.operator_verification.map((entry) => entry.id);
    ok(ids.indexOf('codex-install-cache-restore') >= 0, ids.join(','));
    ok(ids.indexOf('codex-install-cache-restore') < ids.indexOf('codex-hook-review'), 'restore comes before the review it unblocks');
    const restore = report.operator_verification.find((entry) => entry.id === 'codex-install-cache-restore');
    strictEqual(restore.command, 'codex plugin remove engineer@agentic-plugins && codex plugin add engineer@agentic-plugins');
    ok(report.operator_verification.find((entry) => entry.id === 'codex-hook-review').after.startsWith('After the install-cache restore above'));
  });

  it('names a manual Codex reinstall only when the install is behind or divergent from its pin (ADR-0061)', async () => {
    const root = await seedRepo({
      scorecardStatus: 'satisfied',
      conditionStatus: 'satisfied',
      contextCreatedAt: '2026-05-16T07:30:00.000Z',
      cutoverEvidenceDates: oneWeekDogfoodDates(),
    });
    const REINSTALL = 'Reinstall runtime on Codex from the marketplace (`codex plugin remove`, then `codex plugin add`) so Codex materializes the release its catalog pins, then rerun this audit.';
    const REFRESH = 'Refresh the Codex marketplace (`codex plugin marketplace upgrade agentic-plugins`) so Codex installs the expected release of runtime, then rerun this audit.';
    // The release the audit expects (the release-please manifest), read from the audit.
    const probe = await runCutoverAudit({ repoRoot: root, now: NOW, doctorReport: doctorReport(), footerState: 'closed', omccDevActive: 'no' });
    const release = probe.checks.find((check) => check.id === 'installed_plugin_versions').evidence.entries.find((entry) => entry.plugin === 'runtime').expected;
    for (const [currentness, pin, expected] of [
      ['behind', release, REINSTALL],
      ['content-mismatch', release, REINSTALL],
      // The install IS its pin; the pin trails the release — refresh, never reinstall.
      ['current', '0.0.1', REFRESH],
      // Round 6 (Codex review): behind a pin that ALSO trails the release — reinstalling
      // would land the older pin, so the catalog must move first.
      ['behind', '0.0.1', REFRESH],
      // AHEAD of a pin that names the release (a local override): reinstalling returns
      // it to the pin, which is the release.
      ['ahead', release, REINSTALL],
    ]) {
      const doctor = doctorReport();
      doctor.plugins.runtime.cache.codex.latest.manifest_version = currentness === 'ahead' ? '9.9.9' : '0.34.0';
      doctor.plugins.runtime.codex_install = { currentness, catalog_target: { status: 'pinned', version: pin } };
      const report = await runCutoverAudit({ repoRoot: root, now: NOW, doctorReport: doctor, footerState: 'closed', omccDevActive: 'no' });
      const versionCheck = report.checks.find((check) => check.id === 'installed_plugin_versions');
      strictEqual(versionCheck.evidence.entries.find((entry) => entry.plugin === 'runtime').codex_currentness, currentness);
      strictEqual(versionCheck.next_action, expected, `${currentness} behind pin ${pin}`);
    }
  });

  it('treats a list-authoritative installed codex version as satisfied without a filesystem cache (ADR-0034)', async () => {
    const root = await seedRepo({
      scorecardStatus: 'satisfied',
      conditionStatus: 'satisfied',
      contextCreatedAt: '2026-05-16T07:30:00.000Z',
      cutoverEvidenceDates: oneWeekDogfoodDates(),
    });
    const doctor = doctorReport();
    const expected = doctor.plugins.runtime.source.claude_manifest.version;
    // List authoritative: installed at the expected version, but no materialized
    // filesystem cache. The pre-ADR-0034 cache-only check would have blocked this.
    doctor.plugins.runtime.cache.codex.latest = null;
    doctor.plugins.runtime.installed = {
      codex_resolved: { decision: 'installed', source: 'list', version: expected, enabled: true, evidence: 'codex plugin list reports enabled' },
    };

    const report = await runCutoverAudit({
      repoRoot: root,
      now: NOW,
      doctorReport: doctor,
      footerState: 'closed',
      omccDevActive: 'no',
    });

    const versionCheck = report.checks.find((check) => check.id === 'installed_plugin_versions');
    const runtimeEntry = versionCheck.evidence.entries.find((entry) => entry.plugin === 'runtime');
    strictEqual(runtimeEntry.codex_installed, expected);
    strictEqual(runtimeEntry.status, 'satisfied');
  });

  it('blocks when the codex list reports not installed despite a stale filesystem cache (ADR-0034)', async () => {
    const root = await seedRepo({
      scorecardStatus: 'satisfied',
      conditionStatus: 'satisfied',
      contextCreatedAt: '2026-05-16T07:30:00.000Z',
      cutoverEvidenceDates: oneWeekDogfoodDates(),
    });
    const doctor = doctorReport();
    const expected = doctor.plugins.runtime.source.claude_manifest.version;
    // Stale install cache still present at the expected version, but the
    // authoritative list says runtime is not installed — it must not satisfy.
    doctor.plugins.runtime.cache.codex.latest = { manifest_version: expected };
    doctor.plugins.runtime.installed = {
      codex_resolved: { decision: 'not_installed', source: 'list', version: null, enabled: false, evidence: 'codex plugin list does not report runtime as installed' },
    };

    const report = await runCutoverAudit({
      repoRoot: root,
      now: NOW,
      doctorReport: doctor,
      footerState: 'closed',
      omccDevActive: 'no',
    });

    const versionCheck = report.checks.find((check) => check.id === 'installed_plugin_versions');
    const runtimeEntry = versionCheck.evidence.entries.find((entry) => entry.plugin === 'runtime');
    strictEqual(runtimeEntry.codex_installed, null);
    strictEqual(runtimeEntry.status, 'blocked');
    strictEqual(versionCheck.status, 'blocked');
    // Not installed at all: settings can run the Codex install.
    strictEqual(versionCheck.next_action, 'Run runtime:settings --execute-plugin-management, then rerun this audit.');
  });

  it('falls back to the codex cache version when the list was unavailable (ADR-0034)', async () => {
    const root = await seedRepo({
      scorecardStatus: 'satisfied',
      conditionStatus: 'satisfied',
      contextCreatedAt: '2026-05-16T07:30:00.000Z',
      cutoverEvidenceDates: oneWeekDogfoodDates(),
    });
    const doctor = doctorReport();
    const expected = doctor.plugins.runtime.source.claude_manifest.version;
    // List unavailable (older codex / parse error) -> decision 'fallback' -> the
    // filesystem cache version is the evidence, preserving pre-ADR-0034 behavior.
    doctor.plugins.runtime.cache.codex.latest = { manifest_version: expected };
    doctor.plugins.runtime.installed = {
      codex_resolved: { decision: 'fallback', source: 'cache', version: null, enabled: null, evidence: null },
    };

    const report = await runCutoverAudit({
      repoRoot: root,
      now: NOW,
      doctorReport: doctor,
      footerState: 'closed',
      omccDevActive: 'no',
    });

    const versionCheck = report.checks.find((check) => check.id === 'installed_plugin_versions');
    const runtimeEntry = versionCheck.evidence.entries.find((entry) => entry.plugin === 'runtime');
    strictEqual(runtimeEntry.codex_installed, expected);
    strictEqual(runtimeEntry.status, 'satisfied');
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
      '--execute-permission-proof',
      '--permission-proof-timeout-ms',
      '60000',
      '--deep-peer-smoke',
      '--execute-deep-peer-smoke',
      '--deep-peer-smoke-timeout-ms',
      '60000',
      '--execute-workflow-continuation-proof',
      '--workflow-continuation-proof-timeout-ms',
      '60000',
    ]);
    strictEqual(opts.command, 'record');
    strictEqual(opts.repoRoot, '/tmp/repo');
    strictEqual(opts.format, 'json');
    strictEqual(opts.footerState, 'closed');
    strictEqual(opts.omccDevActive, 'no');
    strictEqual(opts.dogfoodDate, '2026-05-16');
    strictEqual(opts.artifacts[0], 'audit=docs/assurance/omcc-cutover-scorecard.md');
    strictEqual(opts.maxArtifactAgeHours, 6);
    strictEqual(opts.permissionProof, true);
    strictEqual(opts.executePermissionProof, true);
    strictEqual(opts.permissionProofTimeoutMs, 60000);
    strictEqual(opts.deepPeerSmoke, true);
    strictEqual(opts.executeDeepPeerSmoke, true);
    strictEqual(opts.deepPeerSmokeTimeoutMs, 60000);
    strictEqual(opts.workflowContinuationProof, true);
    strictEqual(opts.executeWorkflowContinuationProof, true);
    strictEqual(opts.workflowContinuationProofTimeoutMs, 60000);
    strictEqual(parseArgs(['--completion-audit']).completionAudit, true);
    throws(() => parseArgs(['--footer-state', 'done-ish']), /--footer-state is invalid/);
    throws(() => parseArgs(['--omcc-dev-active', 'maybe']), /yes, no, or unknown/);
    throws(() => parseArgs(['--dogfood-window-days', '0']), /positive integer/);
    throws(() => parseArgs(['--deep-peer-smoke-timeout-ms', '0']), /positive integer/);
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
    ok(formatText(report).includes('footer reason: all closeout work is done'));
  });

  it('uses runtime local dates for dogfood records and audit windows', async () => {
    const root = await seedRepo({
      scorecardStatus: 'satisfied',
      conditionStatus: 'satisfied',
      contextCreatedAt: '2026-05-16T17:30:00.000Z',
      cutoverEvidenceDates: ['2026-05-16'],
    });
    await recordCutoverEvidence({
      repoRoot: root,
      now: new Date('2026-05-16T17:45:00.000Z'),
      timeZone: 'Asia/Seoul',
      runId: 'cutover-20260516T174500Z-bbbbbb',
      footerState: 'closed',
      footerReason: 'KST date closeout is done',
      omccDevActive: 'no',
      omccDevNote: 'runtime-only workflow after KST midnight',
    });

    const report = await runCutoverAudit({
      repoRoot: root,
      now: new Date('2026-05-16T17:50:00.000Z'),
      timeZone: 'Asia/Seoul',
      doctorReport: doctorReport(),
      dogfoodWindowDays: 2,
    });

    const dogfood = report.checks.find((check) => check.id === 'dogfood_evidence_window');
    strictEqual(dogfood.status, 'satisfied');
    strictEqual(dogfood.evidence.covered_days, 2);
    strictEqual(dogfood.evidence.latest_date, '2026-05-17');
    strictEqual(dogfood.evidence.accepted_dates.join(','), '2026-05-16,2026-05-17');
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
    ok(formatText(report).includes('footer reason: follow-up remains open'));
  });
});

describe('runtime cutover audit against this repository', () => {
  // Every case above builds its own DEVELOPMENT.md, so none of them can see a
  // defect in the real one. docs/DEVELOPMENT.md keeps the ADR-0012 condition-2
  // row on one physical line, and until ADR-0065 each post-release recovery
  // rewrote that line's tail ("Latest installed proof: …"). The recovery in
  // 2c38052 (#736) dropped the row's closing `|`, which parseMarkdownRows
  // requires, so from 2026-08-25 the live audit reported condition 2 `missing`
  // while every case in this file stayed green. Reading the real file through
  // the real audit is the guard.
  it('parses all four ADR-0012 conditions from docs/DEVELOPMENT.md', async () => {
    const report = await runCutoverAudit({ repoRoot: REPO_ROOT, now: NOW, doctorReport: doctorReport() });
    const check = report.checks.find((entry) => entry.id === 'adr0012_conditions');
    deepStrictEqual(check.evidence.missing_conditions, []);
    deepStrictEqual(check.evidence.statuses.map((row) => row.condition).sort(), ['1', '2', '3', '4']);
  });
});

// ---------------------------------------------------------------------------
// ⚠ TWO ST5 DESCRIBES USED TO STAND HERE and were removed with their subjects
// (ADR-0056 §Decisions 1 and 4): the runtime-floor gate and the "live coverage
// must name its grant" case. Both tested `checkAssuranceRuntimeFloor` and
// `checkHostParityAssurance`, which no longer exist, and neither had a
// non-assurance half worth relocating — unlike `test-host-plane-hardening.mjs`,
// whose four surviving describes were kept for exactly that reason.
//
// The property they protected — a readiness clause that passes without having
// evaluated anything — did NOT go away, and its successor is the era case in
// the main describe above: `an ASSURANCE-ERA recorded run never satisfies the
// gate`. That is the mutation guard for the clause that replaced `liveCovered`.
// ---------------------------------------------------------------------------

async function seedRepo({
  scorecardStatus,
  scorecardOverrides = {},
  scorecardExtraRows = [],
  adrFiles = {},
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
  await writeFile(join(root, 'docs', 'assurance', 'omcc-cutover-scorecard.md'), scorecardRows(scorecardStatus, scorecardOverrides, scorecardExtraRows));
  if (Object.keys(adrFiles).length) {
    await mkdir(join(root, 'docs', 'adr'), { recursive: true });
    for (const [name, text] of Object.entries(adrFiles)) await writeFile(join(root, 'docs', 'adr', name), text);
  }
  await writeFile(join(root, 'docs', 'assurance', 'omcc-legacy-pattern-map.md'), legacyPatternMap);
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

// `overrides` replaces whole cells of named rows: { R9: { status, evidence, gate } }.
// `extraRows` appends raw table rows, for duplicate-id cases.
function scorecardRows(status, overrides = {}, extraRows = []) {
  const rows = [
    ['R1', 'superior compatible'], ['R2', 'remove overbuild'], ['R3', 'tool switching'],
    ['R4', 'same UX'], ['R5', 'best result'], ['R6', 'context decisions'],
    ['R7a', 'quality'], ['R7b', 'completion'], ['R8', 'entry routing'],
    ['R9', 'compat'], ['R10', 'dual perspective'], ['R11', 'convergence'],
  ];
  const body = rows.map(([id, requirement]) => {
    const row = { status, evidence: 'evidence', gate: 'ok', ...(overrides[id] ?? {}) };
    return `| ${id} | ${requirement} | ${row.evidence} | ${row.status} | ${row.gate} |`;
  }).concat(extraRows).join('\n');
  return `| ID | Requirement | Evidence | Status | Exit |
|---|---|---|---|---|
${body}
`;
}

function doctorReport(overrides = {}) {
  const pluginVersions = {
    companions: '0.4.0',
    engineer: '0.10.2',
    orchestrator: '0.7.2',
    runtime: '0.35.0',
  };
  // ⚠ EIGHT criteria and a 115 total, matching what `buildExperienceParity`
  // actually emits after ADR-0056 §Decision 8 removed the ninth. A fixture that
  // does not match the producer makes every `ready_candidate === true`
  // assertion in this file rest on an input no `runDoctor` can produce — which
  // is exactly what ST5's audit found here at the pre-`70e0461` shape, and
  // exactly what would happen again if this fixture kept the ninth row. The
  // producer-side pin lives at `test-doctor.mjs`.
  const experienceParity = overrides.experienceParity ?? {
    status: 'ready',
    score_percent: 100,
    manual_followup_count: 0,
    weight: { earned: 115, total: 115 },
    counts: { satisfied: 8, partial: 0, not_verified: 0, blocked: 0 },
    criteria: [
      { id: 'host_plugin_availability', status: 'satisfied' },
      { id: 'plugin_management_followups', status: 'satisfied' },
      { id: 'bidirectional_companion_contract', status: 'satisfied' },
      { id: 'bidirectional_peer_execution', status: 'satisfied' },
      { id: 'engineer_workflow_continuation_execution', status: 'satisfied' },
      { id: 'workflow_continuity_storage', status: 'satisfied' },
      { id: 'lifecycle_hook_continuity', status: 'satisfied' },
      { id: 'runtime_handoff_artifacts', status: 'satisfied' },
    ],
    next_actions: [],
  };
  return {
    clis: {
      claude: { version: { status: 'available', text: '2.1.143 (Claude Code)' } },
      codex: { version: { status: 'available', text: 'codex-cli 0.130.0' } },
    },
    plugins: Object.fromEntries(Object.entries(pluginVersions).map(([name, version]) => [name, {
      source: { claude_manifest: { version } },
      cache: {
        claude: { latest: { manifest_version: version } },
        codex: { latest: { manifest_version: version } },
      },
    }])),
    consensus_runs: {
      latest: {
        run_id: 'consensus-20260516T073000Z-abc123',
        status: 'passed',
        selected_at: '2026-05-16T07:30:00.000Z',
        artifact_pointer: '.agentic-plugins/runs/consensus/consensus-20260516T073000Z-abc123/execution.json',
      },
    },
    experience_parity: experienceParity,
    recorded_doctor_proof: overrides.recordedDoctorProof ?? null,
  };
}

function blockedExperienceParity() {
  return {
    status: 'blocked',
    score_percent: 69,
    manual_followup_count: 1,
    weight: { earned: 90, total: 130 },
    counts: { satisfied: 5, partial: 2, not_verified: 0, blocked: 2 },
    criteria: [
      // Satisfied here deliberately: this fixture exercises proof REUSE on the
      // two blocked proof criteria, so the ninth criterion is present for the
      // denominator's sake and is not what the case is about.
      { id: 'host_compatibility_assurance', status: 'satisfied', weight: 15, earned_weight: 15 },
      { id: 'host_plugin_availability', status: 'satisfied', weight: 15, earned_weight: 15 },
      { id: 'plugin_management_followups', status: 'partial', weight: 10, earned_weight: 6 },
      { id: 'bidirectional_companion_contract', status: 'satisfied', weight: 15, earned_weight: 15 },
      { id: 'bidirectional_peer_execution', status: 'blocked', weight: 15, earned_weight: 0 },
      { id: 'engineer_workflow_continuation_execution', status: 'blocked', weight: 15, earned_weight: 0 },
      { id: 'workflow_continuity_storage', status: 'satisfied', weight: 15, earned_weight: 15 },
      { id: 'lifecycle_hook_continuity', status: 'partial', weight: 15, earned_weight: 9 },
      { id: 'runtime_handoff_artifacts', status: 'satisfied', weight: 15, earned_weight: 15 },
    ],
    next_actions: [
      {
        id: 'codex-hook-review',
        source: 'manual_followup',
        host: 'codex',
        commands: ['/hooks'],
        reason: 'Review/trust bundled hooks with /hooks.',
      },
      {
        id: 'plugin_management_followups',
        source: 'criterion',
        host: 'codex',
        commands: ['/hooks'],
        reason: 'Review/trust bundled hooks with /hooks.',
      },
      { id: 'bidirectional_peer_execution', source: 'criterion', reason: 'Run explicit peer execution proof.' },
      { id: 'engineer_workflow_continuation_execution', source: 'criterion', reason: 'Run explicit workflow continuation proof.' },
      {
        id: 'lifecycle_hook_continuity',
        source: 'criterion',
        host: 'codex',
        commands: ['/hooks'],
        reason: 'Review/trust bundled hooks with /hooks.',
      },
    ],
  };
}

function reusableRecordedDoctorProof() {
  return {
    status: 'reusable',
    reusable: true,
    run_id: 'doctor-20260516T073000Z-abc123',
    artifact_pointer: '.agentic-plugins/runs/doctor/doctor-20260516T073000Z-abc123/doctor.json',
    permission_proof: { status: 'passed' },
    deep_peer_smoke: { status: 'passed' },
    workflow_continuation_proof: { status: 'passed' },
  };
}
