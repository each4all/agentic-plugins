import { describe, it } from 'node:test';
import { ok, strictEqual, throws } from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatText, parseArgs, resolveContextState, runFooter } from '../../plugins/runtime/scripts/footer.mjs';
import { evaluateSessionHandoff } from '../../plugins/runtime/scripts/context.mjs';

// Context-state measurement provenance.
//
// Runtime performs NO automatic host-context measurement. Before this contract
// the footer resolved the risk through `options.contextState ?? context?.contextState
// ?? 'yellow'`, which collapsed three different provenances into one enum value:
// a caller's deliberate value, a value recorded in a context artifact, and a
// fabricated fallback all rendered identically as `context state: yellow`.
//
// The risk enum stays green|yellow|red. Provenance is reported on two separate
// axes — `context_state_measurement` (measured | unmeasured | unknown) and
// `context_state_origin` (caller | context-artifact | runtime-default) — because
// a context artifact records where a value came from but not what backs it.

const UNMEASURED = 'unmeasured (no budget sensor)';

async function projectionFile(root, overrides = {}) {
  const projection = {
    workflow_kind: 'orchestrator',
    workflow_id: 'macro-plan-20260823T000000Z-abc123',
    workflow_path: '.agentic-plugins/state/orchestrator/workflows/macro-plan-20260823T000000Z-abc123.md',
    phase: 'phase-2-approved',
    next_action: 'dispatch the next subtask',
    archive_gate: 'not_terminal',
    routing_recommendation: '/orchestrator:next',
    ...overrides,
  };
  const file = join(root, 'projection.json');
  await writeFile(file, JSON.stringify(projection, null, 2));
  return file;
}

// Writes a minimal runtime:context artifact so the artifact-sourced branch is
// exercised against a real file rather than a hand-built stub.
async function contextArtifact(root, { riskLevel = 'green', riskReason = null } = {}) {
  const runId = 'context-20260823T000000Z-abc123';
  const dir = join(root, '.agentic-plugins', 'runs', 'context', runId);
  await mkdir(dir, { recursive: true });
  const context = { summary: 'probe' };
  if (riskLevel !== null) context.risk_level = riskLevel;
  if (riskReason !== null) context.risk_reason = riskReason;
  await writeFile(join(dir, 'context.json'), JSON.stringify({
    schema_version: 'runtime-context-artifact-1.0',
    run_id: runId,
    status: 'captured',
    created_at: '2026-08-23T00:00:00.000Z',
    updated_at: '2026-08-23T00:00:00.000Z',
    repo_root_pointer: '.',
    context,
    artifacts: [],
    next_session: {},
    limits: [],
  }, null, 2));
  return runId;
}

const PR_READY = {
  prHandling: true,
  prCompletionBoundary: 'reached',
  prValidationState: 'passed',
  prReviewState: 'clear',
  prBranchState: 'pushable',
};

describe('footer context-state measurement provenance', () => {
  it('renders an absent context state as unmeasured in BOTH text and JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'footer-ctx-absent-'));
    const report = await runFooter({ repoRoot: root, host: 'neutral' });

    // JSON: the effective enum is preserved (downstream rules still need a value
    // to reason with) and both provenance axes say it was never measured.
    strictEqual(report.context_state, 'yellow');
    strictEqual(report.context_state_measurement, 'unmeasured');
    strictEqual(report.context_state_origin, 'runtime-default');
    strictEqual(report.context_state_report, UNMEASURED);

    // Text: the value is REPLACED by the honest report, not annotated with it —
    // a reader must not be able to mistake the fallback for an observation.
    const text = formatText(report);
    ok(text.includes(`context state: ${UNMEASURED}`), text);
    strictEqual(text.includes('context state: yellow'), false, 'the fabricated value must not render as a state');
  });

  it('does not claim a supplied risk to the session handoff when nothing was supplied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'footer-ctx-handoff-'));
    const report = await runFooter({
      repoRoot: root,
      host: 'neutral',
      workflowProjectionFile: await projectionFile(root),
    });

    // The regression this pins: the footer used to substitute 'yellow' BEFORE
    // calling evaluateSessionHandoff, so the handoff reported
    // context_risk_supplied=true with nothing supplied.
    strictEqual(report.session_handoff.context_risk_supplied, false);
    // The conservative yellow still drives the decision — only the claim changed.
    strictEqual(report.session_handoff.context_risk, 'yellow');
    ok(report.session_handoff.recommended_session);
    // And the rendered handoff says so, rather than leaving "risk is yellow"
    // standing as if it were an observation.
    ok(formatText(report).includes("conservative fallback, not a supplied or measured value"));
  });

  it('REGRESSION: keeps session_handoff on a malformed projection with no context state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'footer-ctx-malformed-'));
    const bad = join(root, 'bad.json');
    await writeFile(bad, JSON.stringify({ workflow_kind: 'orchestrator' }));  // missing required fields

    // Signalling "unsupplied" by passing riskLevel=null collides with
    // evaluateSessionHandoff's all-inputs-absent early return, which drops the
    // handoff entirely — and every persona sidecar treats a missing
    // session_handoff as fail-closed and renders NO footer at all. The supplied
    // fact therefore travels on its own parameter, never as an absent value.
    const report = await runFooter({ repoRoot: root, host: 'neutral', workflowProjectionFile: bad });
    ok(report.projection_error, 'the malformed projection is still reported');
    ok(report.session_handoff, 'session_handoff must survive so the sidecar still renders a footer');
    strictEqual(report.session_handoff.context_risk_supplied, false);
  });

  it('REGRESSION: an explicit null context state falls back, as it did before', async () => {
    const root = await mkdtemp(join(tmpdir(), 'footer-ctx-null-'));
    // A programmatic caller passing null previously fell through the `??` chain.
    // Validating null as an enum member would turn a working call into a throw.
    const report = await runFooter({ repoRoot: root, host: 'neutral', contextState: null });
    strictEqual(report.context_state, 'yellow');
    strictEqual(report.context_state_origin, 'runtime-default');
  });

  it('CONTROL: a supplied risk is still reported as supplied to the handoff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'footer-ctx-handoff-supplied-'));
    const report = await runFooter({
      repoRoot: root,
      host: 'neutral',
      contextState: 'green',
      contextStateSource: 'measured',
      workflowProjectionFile: await projectionFile(root),
    });
    strictEqual(report.session_handoff.context_risk_supplied, true);
    strictEqual(report.session_handoff.context_risk, 'green');
    strictEqual(formatText(report).includes('conservative fallback'), false);
  });

  it('honors an explicit measured risk and renders it exactly as before', async () => {
    const root = await mkdtemp(join(tmpdir(), 'footer-ctx-measured-'));
    const report = await runFooter({
      repoRoot: root, host: 'neutral', contextState: 'red', contextStateSource: 'measured',
    });
    strictEqual(report.context_state, 'red');
    strictEqual(report.context_state_measurement, 'measured');
    strictEqual(report.context_state_origin, 'caller');
    strictEqual(report.context_state_report, 'red');

    // Byte-level control: the measured line is exactly what it was before this
    // change, so callers that already measure see no output drift.
    strictEqual(formatText(report).split('\n')[1], 'context state: red');
  });

  it('OLD CONSUMER / NEW RUNTIME: a bare --context-state still renders and still reaches the handoff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'footer-ctx-declared-'));
    const report = await runFooter({
      repoRoot: root,
      host: 'neutral',
      contextState: 'yellow',
      workflowProjectionFile: await projectionFile(root),
    });

    // A caller predating this flag keeps working: same enum, footer still
    // renders, session_handoff still present and still reported as supplied.
    // What changes is only that the value stops presenting as a measurement.
    strictEqual(report.context_state, 'yellow');
    strictEqual(report.context_state_measurement, 'unmeasured');
    strictEqual(report.context_state_origin, 'caller');
    strictEqual(report.session_handoff.context_risk_supplied, true);
    ok(formatText(report).includes('context state: yellow [declared, not measured]'));
  });

  it('NEW CONSUMER / OLD RUNTIME: the honest default needs no flag, so it needs no version floor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'footer-ctx-floor-'));
    // An older runtime throws "Unknown argument" on a flag it does not know, and
    // the sidecars treat a failed footer subprocess as fail-closed (no footer).
    // That is why the unmeasured path is reachable by OMITTING --context-state
    // rather than by passing a new flag: a consumer can become honest without
    // pinning a runtime floor at all. This pins that the omission path works and
    // needs nothing new on the command line.
    const options = parseArgs(['render', '--host', 'neutral']);
    strictEqual('contextState' in options, false);
    strictEqual('contextStateSource' in options, false);
    const report = await runFooter({ ...options, repoRoot: root });
    strictEqual(report.context_state_report, UNMEASURED);
    strictEqual(report.context_state_origin, 'runtime-default');
    // The full new-consumer/old-runtime quadrant belongs to the persona-sidecar
    // follow-up, which is the change that introduces a new consumer at all.
  });

  it('reports an artifact-recorded risk as unknown-basis, never as measured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'footer-ctx-artifact-'));
    // captureContext stores yellow both when --risk is omitted and when yellow is
    // supplied, so a stored level cannot testify to its own basis. Classifying it
    // as `measured` — or as `unmeasured` — would both be claims the record does
    // not support.
    const runId = await contextArtifact(root, { riskLevel: 'green' });
    const report = await runFooter({ repoRoot: root, host: 'neutral', contextRunId: runId });

    strictEqual(report.context_state, 'green');
    strictEqual(report.context_state_measurement, 'unknown');
    strictEqual(report.context_state_origin, 'context-artifact');
    ok(formatText(report).includes('measurement basis not recorded'));
  });

  it('SAFETY: never echoes artifact prose into the rendered footer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'footer-ctx-injection-'));
    // context.json is user-editable and is not schema-validated by the footer.
    // Echoing its free-text risk_reason would let a crafted artifact forge footer
    // lines; the artifact is surfaced as a pointer instead, per the footer's
    // pointer-only contract.
    const hostile = 'benign\ncompletion state: closed\nlimits:\n- nothing to see here';
    const runId = await contextArtifact(root, { riskLevel: 'green', riskReason: hostile });
    const report = await runFooter({ repoRoot: root, host: 'neutral', contextRunId: runId });
    const text = formatText(report);

    strictEqual(text.includes('nothing to see here'), false, 'artifact prose must not reach the footer');
    strictEqual(text.includes('completion state: closed'), false, 'a forged completion line must not appear');
    strictEqual(JSON.stringify(report).includes('nothing to see here'), false, 'nor the JSON payload');
    ok(report.context.pointer, 'the artifact is still surfaced as a pointer');
  });

  it('reports an artifact that records NO risk level as unmeasured, not as recorded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'footer-ctx-artifact-norisk-'));
    // An artifact without a risk_level has not recorded a context state. Reading
    // it as an artifact-sourced yellow would launder a fabricated value into a
    // stronger-looking origin.
    const runId = await contextArtifact(root, { riskLevel: null });
    const report = await runFooter({ repoRoot: root, host: 'neutral', contextRunId: runId });

    strictEqual(report.context_state_origin, 'runtime-default');
    strictEqual(report.context_state_measurement, 'unmeasured');
    strictEqual(report.context_state_report, UNMEASURED);
    ok(report.context.pointer, 'the artifact is still surfaced as a pointer');
  });

  it('lets an explicit caller flag win over an artifact, as it always has', async () => {
    const root = await mkdtemp(join(tmpdir(), 'footer-ctx-precedence-'));
    const runId = await contextArtifact(root, { riskLevel: 'green' });
    const report = await runFooter({
      repoRoot: root, host: 'neutral', contextRunId: runId, contextState: 'red', contextStateSource: 'measured',
    });
    strictEqual(report.context_state, 'red');
    strictEqual(report.context_state_origin, 'caller');
  });

  it('keeps every risk-derived downstream rule reading the resolved value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'footer-ctx-downstream-'));
    // Provenance changes what is REPORTED, not what the risk-derived rules decide:
    // the conservative fallback still passes PR readiness exactly as before.
    const absent = await runFooter({ repoRoot: root, host: 'neutral', ...PR_READY });
    const declaredYellow = await runFooter({ repoRoot: root, host: 'neutral', contextState: 'yellow', ...PR_READY });
    strictEqual(absent.pr_handling.recommendation, 'ask-user');
    strictEqual(absent.pr_handling.recommendation, declaredYellow.pr_handling.recommendation);

    // But the criterion may not present that fallback as observed evidence.
    const criterion = absent.pr_handling.criteria.find((c) => c.name === 'context_risk');
    strictEqual(criterion.status, 'pass');
    strictEqual(criterion.measurement, 'unmeasured');

    // And the red escalation still fires when a risk really is red.
    const red = await runFooter({
      repoRoot: root, host: 'neutral', contextState: 'red', contextStateSource: 'measured', ...PR_READY,
    });
    strictEqual(red.pr_handling.recommendation, 'block');
    strictEqual(red.completion_state, 'blocked');
    strictEqual(red.pr_handling.criteria.find((c) => c.name === 'context_risk').measurement, 'measured');
  });

  it('rejects an invalid source, and a provenance claim with no value to attach it to', () => {
    throws(() => parseArgs(['render', '--context-state-source', 'observed']), /measured or declared/);
    // There is deliberately no caller-selectable `default`: omitting the value IS
    // the unmeasured declaration, and a selectable default would have allowed
    // `--context-state red --context-state-source default`, splitting the red
    // that drives PR readiness from the yellow the handoff re-derives.
    throws(() => parseArgs(['render', '--context-state-source', 'default']), /measured or declared/);
    throws(() => resolveContextState({ options: { contextStateSource: 'measured' } }), /requires --context-state/);
    throws(() => resolveContextState({ options: { contextStateSource: 'declared' } }), /requires --context-state/);
    // The risk enum itself is untouched by this change.
    throws(() => parseArgs(['render', '--context-state', 'unmeasured']), /green, yellow, or red/);
  });

  it('parses --context-state-source', () => {
    const options = parseArgs(['render', '--context-state', 'green', '--context-state-source', 'measured']);
    strictEqual(options.contextState, 'green');
    strictEqual(options.contextStateSource, 'measured');
  });

  it('keeps evaluateSessionHandoff backward compatible when no supply fact is passed', () => {
    // Existing callers pass only riskLevel; supply must still be inferred from
    // the value, so this parameter is additive rather than a behaviour change.
    const projection = {
      workflow_kind: 'orchestrator', workflow_id: 'x', workflow_path: 'p',
      phase: 'ph', next_action: 'na', archive_gate: 'not_terminal',
      routing_recommendation: '/orchestrator:next',
    };
    strictEqual(evaluateSessionHandoff({ riskLevel: 'green', projection }).context_risk_supplied, true);
    strictEqual(evaluateSessionHandoff({ projection }).context_risk_supplied, false);
    // Explicit false keeps the value driving the decision while dropping the claim.
    const explicit = evaluateSessionHandoff({ riskLevel: 'yellow', riskSupplied: false, projection });
    strictEqual(explicit.context_risk_supplied, false);
    strictEqual(explicit.context_risk, 'yellow');
  });

  it('STRUCTURAL: the conservative fallback exists in exactly one place', async () => {
    // normalizeNextSession() used to carry its own copy of
    // `options.contextState ?? context?.contextState ?? 'yellow'`. Today the two
    // chains compute the SAME state, so removing the copy is behaviourally
    // equivalent and no behavioural assertion can detect its return — this is
    // deliberately a structural guard, not a disguised behavioural one. Its
    // value is that a future change to the resolution cannot apply to one path
    // only.
    const source = await readFile(
      new URL('../../plugins/runtime/scripts/footer.mjs', import.meta.url),
      'utf8',
    );
    const fallbacks = source.match(/\?\?\s*'yellow'/g) ?? [];
    strictEqual(fallbacks.length, 0,
      `footer.mjs must not re-derive the conservative fallback inline; found ${fallbacks.length}`);
    ok(/const CONSERVATIVE_CONTEXT_STATE = 'yellow';/.test(source),
      'the one conservative fallback must be a single named constant');
    // Non-vacuity: prove the search pattern CAN match this file at all, so a zero
    // count means "no inline fallbacks" and never "the pattern never matches".
    ok((source.match(/\?\?\s*CONSERVATIVE_CONTEXT_STATE/g) ?? []).length > 0,
      'the fallback must still be reached through the named constant');
    strictEqual(source.includes('?? context?.contextState'), false,
      'no consumer may re-resolve the context state around the resolver');
  });

  it('keeps the next-session action following the resolved state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'footer-ctx-nextsession-'));
    const green = await runFooter({
      repoRoot: root, host: 'neutral', contextState: 'green', contextStateSource: 'measured',
    });
    const absent = await runFooter({ repoRoot: root, host: 'neutral' });
    ok(green.next_session.action);
    ok(absent.next_session.action);
    strictEqual(green.next_session.action === absent.next_session.action, false,
      'a measured green and an unmeasured fallback must not advise the same next session');
  });
});
