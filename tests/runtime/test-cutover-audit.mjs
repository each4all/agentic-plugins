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

  it('passes through doctor host_parity_baseline freshness into observations, and the compat gate is what blocks', async () => {
    const root = await seedRepo({
      scorecardStatus: 'satisfied',
      conditionStatus: 'satisfied',
      contextCreatedAt: '2026-05-16T07:30:00.000Z',
      cutoverEvidenceDates: oneWeekDogfoodDates(),
    });
    // stale baseline from doctor → reused verbatim into `observations`
    const staleReport = await runCutoverAudit({
      repoRoot: root,
      now: NOW,
      doctorReport: doctorReport({
        hostParityBaseline: {
          id: 'host_parity_baseline',
          label: 'Host parity baseline freshness',
          status: 'stale',
          evidence: {
            normalized_observed: { claude: '2.1.143', codex: '0.130.0' },
          },
          next_action: 'Refresh plugins/runtime/docs/host-parity-baseline.md via runtime:compat snapshot→check→ingest-release-notes→plan for the current host versions.',
        },
      }),
      footerState: 'closed',
      footerReason: 'closed',
      omccDevActive: 'no',
    });
    // ⚠ EXACTNESS IS NOT ITS OWN CHECK, AND IT IS NOT NON-BLOCKING EITHER, and
    // the difference between those two statements is what this case pins.
    // ADR-0053 §Decision 4 moved exactness out of `checks` into `observations`,
    // and ADR-0056 kept it there — it is still not a check of its own. But the
    // compat check now READS the live baseline status, because `liveCovered`
    // used to supply the "is the recorded run's baseline still the installed
    // one" binding and its removal left nothing doing that (cross-host review).
    // So a stale baseline is visible as an observation AND blocks through
    // `latest_compat_snapshot` — which was `true` here before the binding
    // landed.
    const staleObservation = staleReport.observations.find((entry) => entry.id === 'host_parity_baseline');
    strictEqual(staleObservation.status, 'stale');
    strictEqual(staleReport.checks.some((check) => check.id === 'host_parity_baseline'), false);
    strictEqual(staleReport.ready_candidate, false, 'a stale installed baseline is no longer re-bound to the recorded run');
    const staleCompat = staleReport.checks.find((check) => check.id === 'latest_compat_snapshot');
    strictEqual(staleCompat.status, 'blocked');
    strictEqual(staleCompat.evidence.live_baseline_status, 'stale');
    ok(/not re-bound/.test(staleCompat.evidence.reason), staleCompat.evidence.reason);

    // older doctor shape (no host_parity_baseline) → observation falls back to
    // `missing` and points at re-running doctor, NOT at a deleted file. The
    // compat gate then blocks, because it has no live pair to bind against.
    const olderShape = doctorReport();
    delete olderShape.host_parity_baseline;
    const fallbackReport = await runCutoverAudit({
      repoRoot: root,
      now: NOW,
      doctorReport: olderShape,
      footerState: 'closed',
      footerReason: 'closed',
      omccDevActive: 'no',
    });
    strictEqual(fallbackReport.observations.find((entry) => entry.id === 'host_parity_baseline').status, 'missing');
    const compatCheck = fallbackReport.checks.find((check) => check.id === 'latest_compat_snapshot');
    strictEqual(compatCheck.status, 'blocked');
    strictEqual(compatCheck.evidence.identity_bound, false);
    strictEqual(fallbackReport.ready_candidate, false);
  });

  it('an ASSURANCE-ERA recorded run never satisfies the gate — the fail-open the removal had to close', async () => {
    // ⚠ ADDED BECAUSE THE REMOVAL CREATES THIS HOLE. `checkCompatFreshness` had
    // four clauses, and it was `liveCovered` — not exactness — that stopped a
    // STORED bit from passing on its own. Delete it without a replacement and an
    // old `runtime-compat-gap-1.1` run whose status was `current` or `assured`
    // satisfies CURRENT readiness: both tokens still parse, and its recorded
    // host pair can still equal the live one.
    //
    // The replacement is the ERA, and this case is the mutation guard for it:
    // reverting `isReadyCompatState` to a token-only test turns the two
    // assurance-era cases below green while the CONTROL stays green, which is
    // exactly the shape a token-only reader cannot distinguish.
    const root = await seedRepo({
      scorecardStatus: 'satisfied',
      conditionStatus: 'satisfied',
      contextCreatedAt: '2026-05-16T07:30:00.000Z',
      cutoverEvidenceDates: oneWeekDogfoodDates(),
    });
    const audit = async (latest) => runCutoverAudit({
      repoRoot: root, now: NOW,
      doctorReport: doctorReport({
        compatRuns: {
          status: 'available',
          malformed: 0,
          latest: {
            run_id: 'compat-20260516T073000Z-abc123',
            selected_at: '2026-05-16T07:30:00.000Z',
            drift_class: 'none',
            host_gaps: [
              { host: 'claude', observed_version: '2.1.143' },
              { host: 'codex', observed_version: '0.130.0' },
            ],
            ...latest,
          },
        },
      }),
      footerState: 'closed', footerReason: 'closed', omccDevActive: 'no',
    });
    const compatCheck = (report) => report.checks.find((check) => check.id === 'latest_compat_snapshot');

    // CONTROL — this era's `current` IS admitted, so the refusals below are
    // about the era and not about the fixture being rejected wholesale.
    const current = await audit({ status: 'current', schema_era: 'post-assurance' });
    strictEqual(compatCheck(current).status, 'fresh');
    strictEqual(current.ready_candidate, true);

    // The assurance era's `current` meant "covered AND drift-free". Reading the
    // token alone would silently re-interpret it as this era's weaker claim.
    const eraCurrent = await audit({ status: 'current', schema_era: 'assurance-era' });
    strictEqual(compatCheck(eraCurrent).status, 'blocked');
    ok(/assurance-era/.test(compatCheck(eraCurrent).evidence.reason), compatCheck(eraCurrent).evidence.reason);
    strictEqual(eraCurrent.ready_candidate, false);

    // `assured` is not in this era's vocabulary at all, and must not pass on the
    // strength of having been positive in its own.
    const eraAssured = await audit({ status: 'assured', schema_era: 'assurance-era' });
    strictEqual(compatCheck(eraAssured).status, 'blocked');
    strictEqual(eraAssured.ready_candidate, false);

    // A run with NO era at all — an older reader's projection — is refused too.
    // `null` never satisfies the predicate, which is the fail-closed direction.
    const noEra = await audit({ status: 'current', schema_era: null });
    strictEqual(compatCheck(noEra).status, 'blocked');
  });

  it('the compat gate refuses each condition independently — and admits a current run', async () => {
    // ⚠ ONE CASE PER CONDITION. Migrating the fixture so the suite goes green
    // proves the gate can PASS; it proves nothing about what it refuses, and a
    // condition nothing exercises is a condition that can be deleted without a
    // test turning red.
    const root = await seedRepo({
      scorecardStatus: 'satisfied',
      conditionStatus: 'satisfied',
      contextCreatedAt: '2026-05-16T07:30:00.000Z',
      cutoverEvidenceDates: oneWeekDogfoodDates(),
    });
    const audit = async (overrides) => runCutoverAudit({
      repoRoot: root, now: NOW, doctorReport: doctorReport(overrides),
      footerState: 'closed', footerReason: 'closed', omccDevActive: 'no',
    });
    const compatCheck = (report) => report.checks.find((check) => check.id === 'latest_compat_snapshot');
    const base = {
      status: 'available',
      malformed: 0,
      latest: {
        run_id: 'compat-20260516T073000Z-abc123',
        status: 'current',
        schema_era: 'post-assurance',
        drift_class: 'none',
        selected_at: '2026-05-16T07:30:00.000Z',
        host_gaps: [
          { host: 'claude', observed_version: '2.1.143' },
          { host: 'codex', observed_version: '0.130.0' },
        ],
      },
    };

    // CONTROL — an intact, bound, current run is ADMITTED. Without this, every
    // refusal below would pass against a gate hard-wired to block.
    const ok0 = await audit({ compatRuns: base });
    strictEqual(compatCheck(ok0).status, 'fresh');
    strictEqual(ok0.ready_candidate, true);

    // ⚠ DRIFT NOW REFUSES, AND THAT IS A DELIBERATE NARROWING. Under ADR-0053
    // §Decision 4 an `assured` run — drift a human reviewed — reached the gate.
    // With no reviewer, ADR-0056 §Decision 6 item 4 chose `current` as the only
    // ready status, openly restoring exactness as the gate rather than letting a
    // pair nobody reconciled read healthy.
    const drifted = await audit({
      compatRuns: { ...base, latest: { ...base.latest, status: 'gap_analysis_ready', drift_class: 'host-version-changed' } },
    });
    strictEqual(compatCheck(drifted).status, 'blocked');
    strictEqual(drifted.ready_candidate, false);

    // COLLECTION INTEGRITY — one malformed historical artifact blocks, even
    // though the NEWEST run is perfect.
    const corrupt = await audit({ compatRuns: { ...base, status: 'blocked', malformed: 1 } });
    strictEqual(compatCheck(corrupt).status, 'blocked');
    ok(/malformed/.test(compatCheck(corrupt).evidence.reason), compatCheck(corrupt).evidence.reason);

    // IDENTITY BINDING — a fresh, ready, intact run that observed a DIFFERENT
    // machine. Both facts are true; they are not about the same host pair.
    const otherMachine = await audit({
      compatRuns: {
        ...base,
        latest: { ...base.latest, host_gaps: [{ host: 'claude', observed_version: '9.9.9' }, { host: 'codex', observed_version: '0.130.0' }] },
      },
    });
    strictEqual(compatCheck(otherMachine).status, 'blocked');
    strictEqual(compatCheck(otherMachine).evidence.identity_bound, false);

    // DUPLICATE ROWS — the artifact cannot say which observation it made.
    const duplicated = await audit({
      compatRuns: {
        ...base,
        latest: {
          ...base.latest,
          host_gaps: [
            { host: 'claude', observed_version: '2.1.143' },
            { host: 'claude', observed_version: '2.1.144' },
            { host: 'codex', observed_version: '0.130.0' },
          ],
        },
      },
    });
    strictEqual(compatCheck(duplicated).status, 'blocked');
    ok(/exactly one is required/.test(compatCheck(duplicated).evidence.reason));
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
    ok(report.completion_audit.artifact_checklist.some((item) => (
      item.id === 'host-parity-baseline'
        && item.kind === 'file'
        && item.status === 'current'
    )));
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
  const hostParityBaseline = overrides.hostParityBaseline ?? {
    id: 'host_parity_baseline',
    label: 'Host parity baseline freshness',
    status: 'current',
    evidence: {
      baseline: { date: '2026-05-16', claude: '2.1.143', codex: '0.130.0' },
      observed: { claude: '2.1.143 (Claude Code)', codex: 'codex-cli 0.130.0' },
      normalized_observed: { claude: '2.1.143', codex: '0.130.0' },
    },
    next_action: null,
  };
  return {
    host_parity_baseline: hostParityBaseline,
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
    // ADR-0053 §Decision 4 — the compat gate requires collection integrity and
    // an identity binding between the RECORDED observation and the live host
    // pair, so the fixture carries both. Without the `host_gaps` rows a recorded
    // run cannot be bound to this machine and correctly blocks.
    //
    // ⚠ `schema_era` IS PART OF THE FIXTURE NOW (ADR-0056 §Decision 6 rules 1-2).
    // The live-coverage clause used to be what stopped a stored bit from passing
    // on its own; the era replaces it, so a fixture that omitted the field would
    // silently exercise the fail-open the replacement exists to close.
    compat_runs: overrides.compatRuns ?? {
      status: 'available',
      malformed: 0,
      latest: {
        run_id: 'compat-20260516T073000Z-abc123',
        status: 'current',
        schema_era: 'post-assurance',
        drift_class: 'none',
        selected_at: '2026-05-16T07:30:00.000Z',
        host_gaps: [
          { host: 'claude', status: 'matches', observed_version: '2.1.143', baseline_version: '2.1.143' },
          { host: 'codex', status: 'matches', observed_version: '0.130.0', baseline_version: '0.130.0' },
        ],
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
