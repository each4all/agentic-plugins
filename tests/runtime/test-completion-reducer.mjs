// tests/runtime/test-completion-reducer.mjs — machine-bootstrap-contract.md §7, §8,
// §8.1; §11.2 tests #11-#14, #22-#24.
//
// These are the FALSE-PASS pins. The reducer's whole reason to exist is that a
// manifest must not be able to talk its way to `complete` — by omitting a step, by
// storing an aggregate its own evidence contradicts, or by carrying a proof recorded
// against versions that are no longer installed. Each test below is one way a machine
// could have lied.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadPluginSet, resolveBundle } from '../../plugins/runtime/scripts/lib/plugin-set.mjs';
import { deriveExpectedSteps, expectedStepIds, stepIds } from '../../plugins/runtime/scripts/lib/step-registry.mjs';
import {
  boundVersionsFresh,
  currentBoundVersions,
  invalidateStaleSteps,
  recomputeHookAttestation,
  requiredBoundPlugins,
  importProofMetadata,
  importHookAttestation,
  recomputeProofStatus,
  recomputeReceiptAttestation,
  reduceCompletion,
} from '../../plugins/runtime/scripts/lib/completion-reducer.mjs';
import { makeDefValidator } from '../../plugins/runtime/scripts/lib/schema-validate.mjs';

const RUNTIME_VERSION = '0.80.1';
const AT = '2026-07-17T09:00:00Z';

function hostProbe({ cli = '2.1.208', auth = 'available', marketplace = 'registered', plugins = {} } = {}) {
  return { cli_version: cli, auth, marketplace, plugins };
}

function installed(names, version = '1.0.0') {
  return Object.fromEntries(names.map((n) => [n, { version, state: 'installed' }]));
}

function probeFor(plugins, over = {}) {
  return {
    probed_at: AT,
    runtime_version: RUNTIME_VERSION,
    hosts: {
      claude: hostProbe({ cli: '2.1.208', plugins: installed(plugins) }),
      // A COMPLETE machine's probe carries per-handler hook-state evidence (S8a5):
      // hook_state is semantically required for a current applicable attestation, so
      // the baseline fixture records an available observation with nothing disabled.
      codex: { ...hostProbe({ cli: '0.144.1', plugins: installed(plugins) }), hook_state: { observation: 'available', disabled_expected: [] } },
      ...over,
    },
  };
}

function passingProof(kind, current) {
  return {
    kind,
    status: 'passed',
    directions: {
      'claude->codex': { status: 'passed', ran_at: AT },
      'codex->claude': { status: 'passed', ran_at: AT },
    },
    artifact_pointer: `~/.agentic-plugins/runs/bootstrap/x/proof/${kind}.json`,
    artifact_hash: 'a'.repeat(64),
    bound_versions: current,
    ran_at: AT,
  };
}

// A machine where every CONFIG step is satisfied — the baseline the tests below break
// in exactly one way each.
async function completeMachine({ bundle = 'base' } = {}) {
  const pluginSet = await loadPluginSet();
  const selection = { plugins: resolveBundle(pluginSet, bundle) };
  const probe = probeFor(selection.plugins);
  const current = currentBoundVersions({ probe, selection, runtimeVersion: RUNTIME_VERSION });
  const expected = deriveExpectedSteps({ pluginSet, selection });
  const steps = expected
    .filter((s) => s.applicable && s.stage <= 7)
    .map((s) => ({ id: s.id, stage: s.stage, status: 'satisfied', declinable: s.declinable, blocked_by: s.blocked_by, fragment_applied: false }));
  const proofs = [passingProof('deep-peer-smoke', current)];
  if (expected.find((s) => s.id === 'proof.workflow-continuation')?.applicable) proofs.push(passingProof('workflow-continuation', current));
  return { pluginSet, selection, probe, current, steps, proofs, expected };
}

const reduce = (m, over = {}) => reduceCompletion({
  pluginSet: m.pluginSet,
  selection: m.selection,
  steps: m.steps,
  proofs: m.proofs,
  probe: m.probe,
  runtimeVersion: RUNTIME_VERSION,
  ...over,
});

describe('runtime completion reducer — the baseline actually reaches complete', () => {
  it('a fully satisfied machine with passing proofs is complete', async () => {
    const m = await completeMachine();
    const result = reduce(m);
    strictEqual(result.state, 'complete', `expected complete, got ${result.state}: unsatisfied=${result.unsatisfied} missing=${result.missing_steps} proofs=${JSON.stringify(result.proofs.map((p) => [p.kind, p.status, p.reasons]))}`);
    deepStrictEqual(result.missing_steps, []);
    deepStrictEqual(result.unsatisfied, []);
  });

  // Without a reachable `complete`, every "does not reach complete" test below would
  // pass for the wrong reason — they would pass against a reducer that never says yes.
  it('the persona bundle also reaches complete (the proof set is larger there)', async () => {
    const m = await completeMachine({ bundle: 'engineering' });
    // hooks.codex.attested is applicable for a persona bundle, so it needs an attestation.
    const result = reduce(m, {
      hookAttestation: {
        status: 'attested',
        attested_plugins: ['engineer', 'orchestrator'],
        bound_versions: { codex: '0.144.1', plugins: { codex: { engineer: '1.0.0', orchestrator: '1.0.0' } } },
        artifact_pointer: null,
        artifact_hash: null,
        attested_at: AT,
      },
    });
    strictEqual(result.state, 'complete', `got ${result.state}: ${JSON.stringify(result.proofs.map((p) => [p.kind, p.status]))}`);
    strictEqual(result.hook_attestation.status, 'attested');
  });
});

describe('runtime completion reducer — false-pass pins (#11)', () => {
  it('an OMITTED expected step blocks completion — the exact false-pass this command exists to prevent', async () => {
    const m = await completeMachine();
    const without = { ...m, steps: m.steps.filter((s) => s.id !== 'marketplace.codex.registered') };
    const result = reduce(without);
    strictEqual(result.state, 'incomplete');
    deepStrictEqual(result.missing_steps, ['marketplace.codex.registered']);
  });

  it('a BLOCKED step, an UNKNOWN marketplace, and a missing plugin each fail to reach complete', async () => {
    const m = await completeMachine();
    for (const [label, mutate] of [
      ['blocked plugin-management step', (s) => (s.id === stepIds.pluginInstalled('companions', 'codex') ? { ...s, status: 'blocked' } : s)],
      ['unknown marketplace state', (s) => (s.id === 'marketplace.claude.registered' ? { ...s, status: 'unknown' } : s)],
      ['missing plugin', (s) => (s.id === stepIds.pluginInstalled('attention', 'claude') ? { ...s, status: 'pending' } : s)],
      ['manual follow-up', (s) => (s.id === 'permission.claude.applied' ? { ...s, status: 'manual-follow-up' } : s)],
    ]) {
      const result = reduce({ ...m, steps: m.steps.map(mutate) });
      strictEqual(result.state, 'incomplete', `${label} must not reach complete`);
      ok(result.unsatisfied.length > 0, `${label} is named in unsatisfied`);
    }
  });

  it('`unknown` is never satisfied — a probe that could not tell is not a pass (§6)', async () => {
    const m = await completeMachine();
    const result = reduce({ ...m, steps: m.steps.map((s) => (s.id === 'host.codex.authenticated' ? { ...s, status: 'unknown' } : s)) });
    strictEqual(result.state, 'incomplete');
    ok(result.unsatisfied.includes('host.codex.authenticated'));
  });

  it('declined counts as resolved for a step the registry says is declinable (§6)', async () => {
    const m = await completeMachine();
    const result = reduce({
      ...m,
      steps: m.steps.map((s) => (['notify.configured', 'egress.configured'].includes(s.id) ? { ...s, status: 'declined' } : s)),
    });
    strictEqual(result.state, 'complete', 'an operator who declined notify and egress still has a complete machine');
  });

  // The registry-authority rule, applied where it actually bites. A manifest is
  // operator-editable data: without checking the status AGAINST the registry, writing
  // `declined` on a step §6.2 says can never be declined bought `complete` on a machine
  // with no Codex CLI at all.
  it('a NON-declinable step cannot forge `declined`', async () => {
    const m = await completeMachine();
    for (const id of ['host.codex.present', 'host.claude.authenticated', 'marketplace.claude.registered', 'config.model_effort']) {
      const result = reduce({ ...m, steps: m.steps.map((s) => (s.id === id ? { ...s, status: 'declined' } : s)) });
      strictEqual(result.state, 'incomplete', `${id} is not declinable, so a declined claim does not resolve it`);
      ok(result.unsatisfied.includes(id));
    }
  });

  it('an APPLICABLE step cannot forge `not-applicable`', async () => {
    const m = await completeMachine();
    for (const id of ['egress.configured', 'host.codex.present', 'permission.claude.applied']) {
      const result = reduce({ ...m, steps: m.steps.map((s) => (s.id === id ? { ...s, status: 'not-applicable' } : s)) });
      strictEqual(result.state, 'incomplete', `${id} applies to this selection, so it cannot exempt itself`);
      ok(result.unsatisfied.includes(id));
    }
  });

  // A mandatory plugin's steps are protected by the same rule (§6.2: runtime and
  // companions are never declinable, in any selection).
  it('a mandatory plugin cannot be declined', async () => {
    const m = await completeMachine();
    const result = reduce({ ...m, steps: m.steps.map((s) => (s.id === stepIds.pluginInstalled('companions', 'claude') ? { ...s, status: 'declined' } : s)) });
    strictEqual(result.state, 'incomplete');
  });
});

describe('runtime completion reducer — configured-not-verified is REACHABLE (#14)', () => {
  // The state the C0 errata exists for. An earlier formula required every expected
  // step — proof steps included — to be resolved for BOTH terminal states, so an
  // absent proof left its expected step unresolved and the reducer fell through to
  // `incomplete`. That made this state unreachable and this test impossible.
  it('an otherwise-complete machine with NO passing deep-peer-smoke is configured-not-verified', async () => {
    const m = await completeMachine();
    const result = reduce({ ...m, proofs: [] });
    strictEqual(result.state, 'configured-not-verified');
    deepStrictEqual(result.missing_steps, [], 'CONFIG is resolved — only the proof is not');
    strictEqual(result.proofs.find((p) => p.kind === 'deep-peer-smoke').status, 'absent');
  });

  it('a proof bound to older versions reports stale, and caps at configured-not-verified', async () => {
    const m = await completeMachine();
    const stale = passingProof('deep-peer-smoke', { ...m.current, codex: '0.140.0' });
    const result = reduce({ ...m, proofs: [stale] });
    strictEqual(result.state, 'configured-not-verified');
    const proof = result.proofs.find((p) => p.kind === 'deep-peer-smoke');
    strictEqual(proof.status, 'stale');
    match(proof.reasons.join(' '), /codex 0\.140\.0 → 0\.144\.1/);
  });

  it('a DECLINED proof caps at configured-not-verified — it never grants complete (§6.2)', async () => {
    const m = await completeMachine();
    const steps = [...m.steps, { id: 'proof.deep-peer-smoke', stage: 8, status: 'declined', declinable: true, blocked_by: [] }];
    const result = reduce({ ...m, steps, proofs: [] });
    strictEqual(result.state, 'configured-not-verified');
  });

  it('workflow-continuation is not-applicable with no engineer (#14)', async () => {
    const m = await completeMachine({ bundle: 'base' });
    const result = reduce(m);
    const proof = result.proofs.find((p) => p.kind === 'workflow-continuation');
    strictEqual(proof.status, 'not-applicable');
    strictEqual(proof.required, false, 'and it is not required, so it cannot block complete');
    strictEqual(result.state, 'complete');
  });

  it('a machine missing a host is INCOMPLETE, never configured-not-verified (§8.3)', async () => {
    const m = await completeMachine();
    const result = reduce({ ...m, steps: m.steps.map((s) => (s.id === 'host.codex.present' ? { ...s, status: 'pending' } : s)) });
    strictEqual(result.state, 'incomplete', 'a pending Stage-1 CONFIG step reduces to incomplete');
  });
});

describe('runtime completion reducer — the aggregate is recomputed, never trusted (#22)', () => {
  it('a smoke that passed one direction and failed the other is NOT a passing proof', async () => {
    const m = await completeMachine();
    const forged = {
      ...passingProof('deep-peer-smoke', m.current),
      status: 'passed', // the stored claim
      directions: {
        'claude->codex': { status: 'passed', ran_at: AT },
        'codex->claude': { status: 'failed', ran_at: AT },
      },
    };
    const result = reduce({ ...m, proofs: [forged] });
    strictEqual(result.state, 'configured-not-verified', 'the stored `passed` does not survive its own evidence');
    const proof = result.proofs.find((p) => p.kind === 'deep-peer-smoke');
    strictEqual(proof.status, 'failed');
    match(proof.reasons.join(' '), /codex->claude is failed/);
  });

  it('the stored status is not even an input — a `failed` claim over passing directions reads passed', async () => {
    const m = await completeMachine();
    const understated = { ...passingProof('deep-peer-smoke', m.current), status: 'failed' };
    const result = reduce({ ...m, proofs: [understated] });
    strictEqual(result.proofs.find((p) => p.kind === 'deep-peer-smoke').status, 'passed', 'evidence wins in both directions');
  });

  it('a blocked or absent direction is not a pass', async () => {
    for (const status of ['blocked', 'absent']) {
      const m = await completeMachine();
      const proof = { ...passingProof('deep-peer-smoke', m.current), directions: { 'claude->codex': { status: 'passed', ran_at: AT }, 'codex->claude': { status, ran_at: null } } };
      strictEqual(recomputeProofStatus(proof, { current: m.current }).status, 'failed', `a ${status} direction is not a pass`);
    }
  });

  it('a proof with no directions at all is absent, not passed', async () => {
    const m = await completeMachine();
    const empty = { ...passingProof('deep-peer-smoke', m.current), directions: {} };
    strictEqual(recomputeProofStatus(empty, { current: m.current }).status, 'absent');
  });
});

describe('runtime completion reducer — bound versions bind EVERY plugin (#23)', () => {
  it('a proof bound to an older companions version is stale after an upgrade', async () => {
    const m = await completeMachine();
    const old = passingProof('deep-peer-smoke', {
      ...m.current,
      plugins: { claude: { ...m.current.plugins.claude, companions: '0.3.0' }, codex: m.current.plugins.codex },
    });
    const verdict = recomputeProofStatus(old, { current: m.current });
    strictEqual(verdict.status, 'stale');
    match(verdict.reasons.join(' '), /claude companions 0\.3\.0 → 1\.0\.0/);
  });

  // The pathological forgery: an EMPTY map binds nothing, so without a key-set
  // comparison it would match every machine forever.
  it('a proof binding an EMPTY plugin map is stale, not eternally fresh', async () => {
    const m = await completeMachine();
    const unbound = passingProof('deep-peer-smoke', { ...m.current, plugins: { claude: {}, codex: {} } });
    const verdict = recomputeProofStatus(unbound, { current: m.current });
    strictEqual(verdict.status, 'stale');
    match(verdict.reasons.join(' '), /bound \{nothing\}/);
  });

  it('a null version never counts as current', () => {
    const bound = { runtime: RUNTIME_VERSION, claude: null, codex: '0.144.1', plugins: { claude: {}, codex: {} } };
    const current = { runtime: RUNTIME_VERSION, claude: '2.1.208', codex: '0.144.1', plugins: { claude: {}, codex: {} } };
    const fresh = boundVersionsFresh(bound, current);
    strictEqual(fresh.fresh, false);
    match(fresh.reasons.join(' '), /a null version never counts as current/);
  });

  it('currentBoundVersions binds only INSTALLED plugins, per host', async () => {
    const pluginSet = await loadPluginSet();
    const selection = { plugins: ['runtime', 'companions'] };
    const probe = {
      probed_at: AT,
      runtime_version: RUNTIME_VERSION,
      hosts: {
        claude: hostProbe({ plugins: { runtime: { version: '0.80.1', state: 'installed' }, companions: { version: null, state: 'missing' } } }),
        codex: hostProbe({ cli: '0.144.1', plugins: { runtime: { version: '0.80.1', state: 'installed' }, companions: { version: '0.3.0', state: 'disabled' } } }),
      },
    };
    const current = currentBoundVersions({ probe, selection, runtimeVersion: RUNTIME_VERSION });
    deepStrictEqual(current.plugins.claude, { runtime: '0.80.1' }, 'a missing plugin contributes no key');
    deepStrictEqual(current.plugins.codex, { runtime: '0.80.1' }, 'a DISABLED plugin is not installed evidence either');
    ok(pluginSet);
  });
});

describe('runtime completion reducer — hook attestation (#24)', () => {
  const attestation = (over = {}) => ({
    status: 'attested',
    attested_plugins: ['engineer', 'orchestrator'],
    bound_versions: { codex: '0.144.1', plugins: { codex: { engineer: '1.0.0', orchestrator: '1.0.0' } } },
    artifact_pointer: null,
    artifact_hash: null,
    attested_at: AT,
    ...over,
  });

  it('goes stale on a Codex CLI upgrade — trust is version-bound (ADR-0030)', async () => {
    const m = await completeMachine({ bundle: 'engineering' });
    const verdict = recomputeHookAttestation(attestation({ bound_versions: { codex: '0.137.0', plugins: { codex: { engineer: '1.0.0', orchestrator: '1.0.0' } } } }), {
      current: m.current,
      expectedPlugins: ['engineer', 'orchestrator'],
      probe: m.probe,
      applicable: true,
    });
    strictEqual(verdict.status, 'stale');
    match(verdict.reasons.join(' '), /attested against Codex 0\.137\.0 but the machine now reports 0\.144\.1/);
  });

  it('goes stale when a hook plugin is added, removed, or version-changed', async () => {
    const m = await completeMachine({ bundle: 'engineering' });
    const cases = [
      ['removed', attestation({ attested_plugins: ['engineer'] })],
      ['version changed', attestation({ bound_versions: { codex: '0.144.1', plugins: { codex: { engineer: '0.9.0', orchestrator: '1.0.0' } } } })],
    ];
    for (const [label, record] of cases) {
      const verdict = recomputeHookAttestation(record, { current: m.current, expectedPlugins: ['engineer', 'orchestrator'], probe: m.probe, applicable: true });
      strictEqual(verdict.status, 'stale', `${label} stales the attestation`);
    }
  });

  it('goes stale when an attested hook plugin is DISABLED — a disabled plugin bears no hooks', async () => {
    const m = await completeMachine({ bundle: 'engineering' });
    const probe = structuredClone(m.probe);
    probe.hosts.codex.plugins.engineer.state = 'disabled';
    const verdict = recomputeHookAttestation(attestation(), { current: m.current, expectedPlugins: ['engineer', 'orchestrator'], probe, applicable: true });
    strictEqual(verdict.status, 'stale');
    match(verdict.reasons.join(' '), /engineer is disabled on Codex/);
  });

  // THE S8a5 FALSE-PASS PIN, reducer side. The plugin-level twin above disables the
  // WHOLE plugin — which is exactly how the per-handler gap stayed masked: an
  // installed plugin with ONE explicitly disabled handler passed `state ===
  // 'installed'` and the pre-1.1 probe carried nothing finer. The disabled handler
  // here sits beside enabled siblings (the plugin stays installed), so only the
  // per-handler check can catch it.
  it('goes stale when an expected HANDLER is explicitly disabled while its plugin stays installed (S8a5)', async () => {
    const m = await completeMachine({ bundle: 'engineering' });
    const probe = structuredClone(m.probe);
    probe.hosts.codex.hook_state.disabled_expected = [
      { plugin: 'engineer', hooks_path: 'hooks/hooks.json', event: 'stop', group_index: '0', hook_index: '1' },
    ];
    const verdict = recomputeHookAttestation(attestation(), { current: m.current, expectedPlugins: ['engineer', 'orchestrator'], probe, applicable: true });
    strictEqual(verdict.status, 'stale');
    match(verdict.reasons.join(' '), /engineer has an explicitly disabled hook handler \(hooks\/hooks\.json:stop:0:1\)/);
    ok(!verdict.reasons.some((reason) => reason.includes('is disabled on Codex')),
      'the plugin-level check is NOT the cause — this is the handler grain');
  });

  it('a disabled handler for an UNSELECTED plugin does not stale the claim', async () => {
    const m = await completeMachine({ bundle: 'engineering' });
    const probe = structuredClone(m.probe);
    probe.hosts.codex.hook_state.disabled_expected = [
      { plugin: 'designer', hooks_path: 'hooks/hooks.json', event: 'stop', group_index: '0', hook_index: '0' },
    ];
    const verdict = recomputeHookAttestation(attestation(), { current: m.current, expectedPlugins: ['engineer', 'orchestrator'], probe, applicable: true });
    strictEqual(verdict.status, 'attested', `a plugin outside the selection is not this claim's evidence: ${verdict.reasons.join(' | ')}`);
  });

  // hook_state is SEMANTICALLY required for a current applicable attestation (S8a5):
  // structurally a 1.0 probe without it still validates, but "we could not observe the
  // hook state" is not evidence the hooks are on. Resume-means-re-probe (§7) supplies
  // the field on the next run.
  it('is never current without an available hook-state observation', async () => {
    const m = await completeMachine({ bundle: 'engineering' });

    const pre11 = structuredClone(m.probe);
    delete pre11.hosts.codex.hook_state;
    const absent = recomputeHookAttestation(attestation(), { current: m.current, expectedPlugins: ['engineer', 'orchestrator'], probe: pre11, applicable: true });
    strictEqual(absent.status, 'stale');
    match(absent.reasons.join(' '), /no Codex hook-state observation \(pre-1\.1 probe\)/);

    for (const [observation, reasonRe] of [['missing', /not found at probe time/], ['unreadable', /not readable at probe time/]]) {
      const probe = structuredClone(m.probe);
      probe.hosts.codex.hook_state = { observation, disabled_expected: [] };
      const verdict = recomputeHookAttestation(attestation(), { current: m.current, expectedPlugins: ['engineer', 'orchestrator'], probe, applicable: true });
      strictEqual(verdict.status, 'stale', `observation=${observation} never supports a current claim`);
      match(verdict.reasons.join(' '), reasonRe);
    }
  });

  // Malformed evidence FAILS CLOSED (peer finding): an `available` observation whose
  // disabled_expected is null/missing/not-an-array previously coerced to [] — the
  // exact fail-open shape (§7) everywhere else in this module refuses.
  it('goes stale on malformed hook-state evidence — an unparseable disabled_expected is never "nothing disabled"', async () => {
    const m = await completeMachine({ bundle: 'engineering' });
    for (const malformed of [null, undefined, 'not-an-array', { plugin: 'engineer' }]) {
      const probe = structuredClone(m.probe);
      probe.hosts.codex.hook_state = malformed === undefined
        ? { observation: 'available' }
        : { observation: 'available', disabled_expected: malformed };
      const verdict = recomputeHookAttestation(attestation(), { current: m.current, expectedPlugins: ['engineer', 'orchestrator'], probe, applicable: true });
      strictEqual(verdict.status, 'stale', `disabled_expected=${JSON.stringify(malformed)} must fail closed`);
      match(verdict.reasons.join(' '), /malformed/);
    }
  });

  it('is not-applicable for base and absent when never recorded', async () => {
    const base = await completeMachine({ bundle: 'base' });
    strictEqual(reduce(base).hook_attestation.status, 'not-applicable', 'base carries no Codex hook-bearing plugin');

    const eng = await completeMachine({ bundle: 'engineering' });
    strictEqual(reduce(eng).hook_attestation.status, 'absent');
  });
});

describe('runtime completion reducer — invalidation (#13)', () => {
  it('a satisfied step recorded against an older Codex is re-set to pending with a reason', async () => {
    const m = await completeMachine();
    const drifted = { ...m.current, codex: '0.140.0' };
    const { steps, invalidated, reasons } = invalidateStaleSteps({ steps: m.steps, probe: m.probe, current: drifted, at: AT });
    ok(invalidated.length > 0, 'the drift invalidates the observed steps');
    for (const step of steps.filter((s) => invalidated.includes(s.id))) {
      strictEqual(step.status, 'pending');
      deepStrictEqual(step.invalidated, { at: AT, reason: 'version-drift' });
      strictEqual(step.observed_at, null, 'the stale observation is cleared, not kept beside a pending status');
    }
    match(reasons.join(' '), /codex/);
  });

  it('no drift means no invalidation — the record is not churned for nothing', async () => {
    const m = await completeMachine();
    const { steps, invalidated } = invalidateStaleSteps({ steps: m.steps, probe: m.probe, current: m.current, at: AT });
    deepStrictEqual(invalidated, []);
    strictEqual(steps, m.steps);
  });

  it('only OBSERVED steps are invalidated — a pending step has nothing to invalidate', async () => {
    const m = await completeMachine();
    const withPending = m.steps.map((s) => (s.id === 'notify.configured' ? { ...s, status: 'pending' } : s));
    const { invalidated } = invalidateStaleSteps({ steps: withPending, probe: m.probe, current: { ...m.current, runtime: '0.99.0' }, at: AT });
    ok(!invalidated.includes('notify.configured'));
  });

  it('an invalidated step then blocks completion — it is pending, not satisfied', async () => {
    const m = await completeMachine();
    const drifted = { ...m.current, codex: '0.140.0' };
    const { steps } = invalidateStaleSteps({ steps: m.steps, probe: m.probe, current: drifted, at: AT });
    const result = reduce({ ...m, steps });
    strictEqual(result.state, 'incomplete', 'a re-probe is owed before this machine can claim anything');
  });
});

describe('runtime completion reducer — §7 traps are structurally avoided', () => {
  // §7 names two values the reducer must not read. Absence is the enforcement, so it
  // is asserted rather than assumed: a module that cannot see a value cannot trust it.
  it('the reducer never mentions settings.overall.status or plugin_management.summary.blocked', async () => {
    const src = await readFile(resolve(new URL('../../plugins/runtime/scripts/lib/completion-reducer.mjs', import.meta.url).pathname), 'utf8');
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    ok(!/overall\s*\.\s*status/.test(code), 'settings.overall.status is not inherited — it reports a pass while plugins are missing');
    ok(!/summary\s*\.\s*blocked/.test(code), 'plugin_management.summary.blocked is not consulted — it is omitted from completion upstream');
    ok(!/from '\.\/settings|require\(.*settings/.test(code), 'the reducer does not import the settings pipeline at all');
  });

  it('step stage/declinable/blocked_by come from the registry, not from the manifest', async () => {
    const m = await completeMachine();
    // A forged manifest: every step claims stage 8 (so no CONFIG would be owed) and
    // claims to be declinable. The registry must overrule all of it.
    const forged = m.steps.map((s) => ({ ...s, stage: 8, declinable: true }));
    const result = reduce({ ...m, steps: forged.filter((s) => s.id !== 'host.claude.present') });
    strictEqual(result.state, 'incomplete', 'the forged stages do not exempt a missing CONFIG step');
    deepStrictEqual(result.missing_steps, ['host.claude.present']);
  });

  it('expectedStepIds and the reducer agree on what is owed', async () => {
    const m = await completeMachine({ bundle: 'engineering' });
    const owed = expectedStepIds(deriveExpectedSteps({ pluginSet: m.pluginSet, selection: m.selection }));
    const result = reduce({ ...m, steps: [] });
    // Everything owed and CONFIG-staged shows up as missing when steps[] is empty.
    for (const id of result.missing_steps) ok(owed.has(id), `${id} is genuinely owed`);
    ok(result.missing_steps.length > 0);
    ok(!result.missing_steps.some((id) => id.startsWith('proof.')), 'proof steps are not missing_steps — that is what the proof clause is for');
  });
});

describe('runtime completion reducer — §8.2 proof importer (metadata only)', () => {
  // Doctor records proofs repo-relative; a machine bootstrap run from repo B cannot see
  // evidence recorded in repo A. The import carries METADATA into the machine-global
  // home — and raw peer output is never copied, so this projects onto an ALLOWLIST
  // rather than deleting the fields someone remembered to name.
  it('carries pointer/hash/bound_versions/directions and DROPS everything else', () => {
    const doctorProof = {
      kind: 'deep-peer-smoke',
      status: 'passed',
      directions: {
        'claude->codex': { status: 'passed', ran_at: AT, raw_stdout: 'SECRET PEER OUTPUT' },
        'codex->claude': { status: 'passed', ran_at: AT },
      },
      artifact_pointer: '.agentic-plugins/runs/doctor/x/proof.json',
      artifact_hash: 'b'.repeat(64),
      bound_versions: { runtime: RUNTIME_VERSION, claude: '2.1.208', codex: '0.144.1', plugins: { claude: {}, codex: {} } },
      ran_at: AT,
      // The fields that must not travel:
      raw_output: 'PEER SAID SOMETHING SENSITIVE',
      prompt: 'the prompt text',
      transcript_path: '/Users/someone/.claude/projects/x/transcript.jsonl',
    };
    const { ok: imported, record, dropped } = importProofMetadata(doctorProof);
    strictEqual(imported, true);
    deepStrictEqual(Object.keys(record).sort(), ['artifact_hash', 'artifact_pointer', 'bound_versions', 'directions', 'kind', 'ran_at', 'status']);

    const serialized = JSON.stringify(record);
    for (const leak of ['SECRET PEER OUTPUT', 'PEER SAID SOMETHING SENSITIVE', 'the prompt text', '/Users/someone']) {
      ok(!serialized.includes(leak), `${leak.slice(0, 20)} does not travel into the machine-global home`);
    }
    deepStrictEqual(dropped.sort(), ['prompt', 'raw_output', 'transcript_path']);
    deepStrictEqual(record.directions['claude->codex'], { status: 'passed', ran_at: AT }, 'a per-direction extra is dropped too');
  });

  // The allowlist was TOP-LEVEL only: it stopped a raw-output key at the door and then
  // waved through whatever was nested inside an ALLOWED one. A string is only metadata
  // if it is the shape the metadata is supposed to be.
  it('raw output nested INSIDE an allowed key does not travel', () => {
    const { record } = importProofMetadata({
      kind: 'deep-peer-smoke',
      status: 'passed',
      directions: { 'claude->codex': { status: 'passed', ran_at: AT }, 'codex->claude': { status: 'passed', ran_at: AT } },
      artifact_pointer: 'RAW PEER OUTPUT — the model said something sensitive',
      artifact_hash: 'not a hash, just prose',
      bound_versions: {
        runtime: RUNTIME_VERSION,
        claude: '2.1.208',
        codex: '0.144.1',
        plugins: { claude: { raw_output: 'SECRET', companions: '0.3.0' }, codex: { companions: 'not-a-version' } },
      },
      ran_at: AT,
    });
    const serialized = JSON.stringify(record);
    ok(!serialized.includes('RAW PEER OUTPUT'), 'a pointer that is not a pointer is dropped');
    ok(!serialized.includes('SECRET'), 'a version map entry that is not a version is dropped');
    ok(!serialized.includes('not a hash'), 'a hash that is not a hash is dropped');
    ok(!serialized.includes('not-a-version'));
    strictEqual(record.artifact_pointer, null);
    strictEqual(record.artifact_hash, null);
    deepStrictEqual(record.bound_versions.plugins.claude, { companions: '0.3.0' }, 'the genuine version survives');
    deepStrictEqual(record.bound_versions.plugins.codex, {});
  });

  it('a field that failed its grammar is REPORTED as dropped, not silently nulled', () => {
    const { ok: imported, dropped } = importProofMetadata({ kind: 'permission', artifact_pointer: 'prose', directions: {} });
    strictEqual(imported, true);
    ok(dropped.some((d) => d.startsWith('artifact_pointer')), 'the caller learns their pointer did not land');
  });

  // ADR-0048 §3 — an unknown kind is refused OUTRIGHT, not carried as a null:
  // the importer is a discriminator boundary now, and a record whose kind the
  // evidence contract does not know can never continue toward a writer that
  // would refuse it anyway.
  it('an unknown kind fails the import — it is never carried as a null-kind record', () => {
    const refused = importProofMetadata({ kind: 'not-a-kind', directions: {} });
    strictEqual(refused.ok, false);
    strictEqual(refused.record, null);
    ok(refused.errors.some((e) => e.includes('kind')));
  });

  it('an unknown future field is dropped by DEFAULT — the allowlist is the point', () => {
    const { record, dropped } = importProofMetadata({ kind: 'permission', status: 'passed', directions: {}, some_field_added_next_year: 'whatever it holds' });
    ok(!('some_field_added_next_year' in record), 'a field nobody enumerated cannot ride along');
    ok(dropped.includes('some_field_added_next_year'));
  });

  it('a direction that did not run is written as `absent`, never omitted', () => {
    const { record } = importProofMetadata({ kind: 'deep-peer-smoke', directions: { 'claude->codex': { status: 'passed', ran_at: AT } } });
    deepStrictEqual(record.directions['codex->claude'], { status: 'absent', ran_at: null });
    // And so it can never read as a pass.
    strictEqual(recomputeProofStatus(record, { current: { runtime: RUNTIME_VERSION, claude: null, codex: null, plugins: { claude: {}, codex: {} } } }).status, 'failed');
  });

  it('the imported record satisfies the packaged proof subschema', async () => {
    const validate = await makeDefValidator('runtime-bootstrap-run', 'proof');
    const m = await completeMachine();
    const { record } = importProofMetadata(passingProof('deep-peer-smoke', m.current));
    const result = validate(record);
    strictEqual(result.ok, true, `imported record is invalid:\n  ${result.errors.join('\n  ')}`);
  });

  it('a non-object is reported, not thrown', () => {
    strictEqual(importProofMetadata(null).ok, false);
    strictEqual(importProofMetadata('nope').ok, false);
  });
});

describe('runtime completion reducer — the hook attestation GATES its own step (#2)', () => {
  // The Stage-7 step is CONFIG, so its status feeds completion — but its EVIDENCE is
  // the attestation record. Judging the status alone let a manifest write
  // `hooks.codex.attested: satisfied` with no attestation at all and reach `complete`:
  // a step promoted by assertion, which §6 forbids in as many words.
  it('a `satisfied` hook step with NO attestation does not reach complete', async () => {
    const m = await completeMachine({ bundle: 'engineering' });
    const result = reduce(m, { hookAttestation: null });
    strictEqual(result.state, 'incomplete', 'the claim is not the evidence');
    ok(result.unsatisfied.includes('hooks.codex.attested'));
    strictEqual(result.hook_attestation.status, 'absent');
  });

  it('a `satisfied` hook step with a STALE attestation does not reach complete either', async () => {
    const m = await completeMachine({ bundle: 'engineering' });
    const result = reduce(m, {
      hookAttestation: {
        status: 'attested',
        attested_plugins: ['engineer', 'orchestrator'],
        bound_versions: { codex: '0.137.0', plugins: { codex: { engineer: '1.0.0', orchestrator: '1.0.0' } } },
        artifact_pointer: null, artifact_hash: null, attested_at: AT,
      },
    });
    strictEqual(result.state, 'incomplete');
    strictEqual(result.hook_attestation.status, 'stale');
  });

  it('base is unaffected — the step is not-applicable, so there is nothing to gate', async () => {
    const m = await completeMachine({ bundle: 'base' });
    strictEqual(reduce(m, { hookAttestation: null }).state, 'complete');
  });
});

describe('runtime completion reducer — freshness holds against unbound evidence (#3, #4)', () => {
  it('null-vs-null is NOT fresh — two unknowns agreeing is not evidence', () => {
    const nulls = { runtime: null, claude: null, codex: null, plugins: { claude: {}, codex: {} } };
    const result = boundVersionsFresh(nulls, nulls);
    strictEqual(result.fresh, false);
    match(result.reasons.join(' '), /a null version never counts as current/);
  });

  it('a proof binding NO selected plugin version is stale even when both maps are empty', async () => {
    const m = await completeMachine();
    const required = requiredBoundPlugins({ pluginSet: m.pluginSet, selection: m.selection });
    const unbound = { runtime: RUNTIME_VERSION, claude: '2.1.208', codex: '0.144.1', plugins: { claude: {}, codex: {} } };
    // `{}` equals `{}` on a key-set comparison — the expected set is what catches it.
    const result = boundVersionsFresh(unbound, unbound, { requiredPlugins: required });
    strictEqual(result.fresh, false);
    match(result.reasons.join(' '), /is in the selection but the proof binds no version for it/);
  });

  it('requiredBoundPlugins is per-host and derived from the plugin-set', async () => {
    const pluginSet = await loadPluginSet();
    const required = requiredBoundPlugins({ pluginSet, selection: { plugins: ['runtime', 'companions'] } });
    deepStrictEqual(required.claude, ['companions', 'runtime']);
    deepStrictEqual(required.codex, ['companions', 'runtime']);
  });

  it('an attestation binding NO version for an uninstalled hook plugin is stale, not attested', async () => {
    const m = await completeMachine({ bundle: 'engineering' });
    const probe = structuredClone(m.probe);
    probe.hosts.codex.plugins.engineer = { version: null, state: 'missing' };
    // Both bound and current maps lack `engineer`, so `undefined === undefined` used to
    // read as "unchanged" for a plugin that is not even there.
    const verdict = recomputeHookAttestation(
      { status: 'attested', attested_plugins: ['engineer'], bound_versions: { codex: '0.144.1', plugins: { codex: {} } }, artifact_pointer: null, artifact_hash: null, attested_at: AT },
      { current: { ...m.current, plugins: { claude: {}, codex: {} } }, expectedPlugins: ['engineer'], probe, applicable: true },
    );
    strictEqual(verdict.status, 'stale');
    match(verdict.reasons.join(' '), /never current|is missing on Codex/);
  });

  it('an attestation binding an EXTRA plugin is stale — it describes another machine shape', async () => {
    const m = await completeMachine({ bundle: 'engineering' });
    const verdict = recomputeHookAttestation(
      { status: 'attested', attested_plugins: ['engineer', 'orchestrator'], bound_versions: { codex: '0.144.1', plugins: { codex: { engineer: '1.0.0', orchestrator: '1.0.0', founder: '1.0.0' } } }, artifact_pointer: null, artifact_hash: null, attested_at: AT },
      { current: m.current, expectedPlugins: ['engineer', 'orchestrator'], probe: m.probe, applicable: true },
    );
    strictEqual(verdict.status, 'stale');
    match(verdict.reasons.join(' '), /binds founder, which is not in the selection/);
  });
});

describe('runtime completion reducer — invalidation is scoped to the selection (#5)', () => {
  // An unselected-but-installed plugin (a `designer` on a `base` machine) made the
  // stored probe's plugin map and the selected bound-version map differ FOREVER — so
  // every run reset every satisfied step and re-probed, with a drift reason naming a
  // plugin nobody selected.
  it('an unselected installed plugin does not cause perpetual invalidation', async () => {
    const m = await completeMachine({ bundle: 'base' });
    const probe = structuredClone(m.probe);
    for (const host of ['claude', 'codex']) probe.hosts[host].plugins.designer = { version: '0.4.0', state: 'installed' };

    const { invalidated } = invalidateStaleSteps({ steps: m.steps, probe, current: m.current, selection: m.selection, at: AT });
    deepStrictEqual(invalidated, [], 'a plugin outside the selection is not this run’s business');
  });

  it('a SELECTED plugin drifting still invalidates', async () => {
    const m = await completeMachine({ bundle: 'base' });
    const drifted = { ...m.current, plugins: { claude: { ...m.current.plugins.claude, companions: '9.9.9' }, codex: m.current.plugins.codex } };
    const { invalidated } = invalidateStaleSteps({ steps: m.steps, probe: m.probe, current: drifted, selection: m.selection, at: AT });
    ok(invalidated.length > 0);
  });

  // A rendered fragment is version-bound: showing an operator apply instructions
  // produced against a CLI they no longer run is its own failure.
  it('a manual-follow-up step is invalidated and its stale fragment cleared', async () => {
    const m = await completeMachine();
    const steps = m.steps.map((s) => (s.id === 'permission.claude.applied' ? { ...s, status: 'manual-follow-up', fragment_pointer: '~/x/fragment', apply_command: 'apply it' } : s));
    const { steps: next, invalidated } = invalidateStaleSteps({ steps, probe: m.probe, current: { ...m.current, claude: '2.2.0' }, selection: m.selection, at: AT });
    ok(invalidated.includes('permission.claude.applied'));
    const step = next.find((s) => s.id === 'permission.claude.applied');
    strictEqual(step.status, 'pending');
    strictEqual(step.fragment_pointer, null, 'the stale instructions are cleared, not left beside a pending status');
    strictEqual(step.apply_command, null);
  });

  it('a DECLINED step survives drift — it is an operator choice, not an observation', async () => {
    const m = await completeMachine();
    const steps = m.steps.map((s) => (s.id === 'notify.configured' ? { ...s, status: 'declined' } : s));
    const { steps: next, invalidated } = invalidateStaleSteps({ steps, probe: m.probe, current: { ...m.current, codex: '0.145.0' }, selection: m.selection, at: AT });
    ok(!invalidated.includes('notify.configured'), 're-asking because Codex shipped a patch would be noise');
    strictEqual(next.find((s) => s.id === 'notify.configured').status, 'declined');
  });
});

describe('runtime completion reducer — the reduced completion validates against the schema (S8a4-4)', () => {
  it('a stale hook_attestation carrying reasons conforms to $defs/completion (the reasons/directions repair)', async () => {
    const validateCompletion = await makeDefValidator('runtime-bootstrap-run', 'completion');
    const m = await completeMachine({ bundle: 'engineering' });
    // A STALE attestation carries `reasons` — the field the closed hookAttestation def rejected
    // before the repair (the codex bound version drifts 0.99.0 → the probe's 0.144.1). The
    // reduced proofs also carry aggregate status + reasons and NO directions, exercising the
    // evaluatedProof def; a whole reduceCompletion output must validate against the schema now.
    const result = reduce(m, {
      hookAttestation: {
        status: 'attested',
        attested_plugins: ['engineer', 'orchestrator'],
        bound_versions: { codex: '0.99.0', plugins: { codex: { engineer: '1.0.0', orchestrator: '1.0.0' } } },
        artifact_pointer: null,
        artifact_hash: null,
        attested_at: AT,
      },
    });
    strictEqual(result.hook_attestation.status, 'stale');
    ok(result.hook_attestation.reasons.length > 0, 'a stale verdict carries reasons — the field under repair');
    const verdict = validateCompletion(result);
    ok(verdict.ok, `reduced completion must validate against the schema; errors: ${JSON.stringify(verdict.errors)}`);
  });

  it('a complete run with passing proofs also conforms', async () => {
    const validateCompletion = await makeDefValidator('runtime-bootstrap-run', 'completion');
    const m = await completeMachine();
    const result = reduce(m);
    strictEqual(result.state, 'complete');
    const verdict = validateCompletion(result);
    ok(verdict.ok, `errors: ${JSON.stringify(verdict.errors)}`);
  });
});

describe('runtime completion reducer — importHookAttestation (§8.2, S8a4-4)', () => {
  const doctorAttestation = (over = {}) => ({
    attested: true,
    status: 'attested',
    // Machine-wide: MORE plugins than any one selection carries.
    attested_plugins: ['designer', 'engineer', 'orchestrator'],
    bundled_plugins: ['designer', 'engineer', 'orchestrator'],
    plugin_versions: { designer: '2.0.0', engineer: '1.0.0', orchestrator: '1.0.0' },
    bound_versions: { codex: '0.144.1', plugins: { codex: { designer: '2.0.0', engineer: '1.0.0', orchestrator: '1.0.0' } } },
    artifact_pointer: '~/.agentic-plugins/runs/settings/x/settings.json',
    artifact_hash: 'a'.repeat(64),
    attested_at: AT,
    ...over,
  });

  it('projects an EXACT subset to the selection (extra machine-wide plugins are not copied)', () => {
    const r = importHookAttestation(doctorAttestation(), { expectedPlugins: ['orchestrator', 'engineer'] });
    ok(r.ok, JSON.stringify(r.errors));
    deepStrictEqual(r.record.attested_plugins, ['engineer', 'orchestrator']);
    deepStrictEqual(r.record.bound_versions.plugins.codex, { engineer: '1.0.0', orchestrator: '1.0.0' });
    ok(!('designer' in r.record.bound_versions.plugins.codex), 'a machine-wide plugin outside the selection is not copied');
    strictEqual(r.record.bound_versions.codex, '0.144.1');
    strictEqual(r.record.artifact_hash, 'a'.repeat(64));
    strictEqual(r.record.artifact_pointer, '~/.agentic-plugins/runs/settings/x/settings.json');
  });

  it('rejects when the source does not cover a selected plugin', () => {
    const r = importHookAttestation(doctorAttestation(), { expectedPlugins: ['engineer', 'founder'] });
    strictEqual(r.ok, false);
    match(r.errors.join(' '), /does not cover selected hook plugin\(s\): founder/);
  });

  it('rejects a source that is not actually attested', () => {
    const r = importHookAttestation(doctorAttestation({ attested: false, status: 'blocked' }), { expectedPlugins: ['engineer'] });
    strictEqual(r.ok, false);
    match(r.errors.join(' '), /not attested/);
  });

  it('refuses conflicting legacy vs canonical version maps rather than pick a winner', () => {
    const r = importHookAttestation(doctorAttestation({
      plugin_versions: { engineer: '1.0.0', designer: '2.0.0', orchestrator: '1.0.0' },
      bound_versions: { codex: '0.144.1', plugins: { codex: { engineer: '9.9.9', designer: '2.0.0', orchestrator: '1.0.0' } } },
    }), { expectedPlugins: ['engineer'] });
    strictEqual(r.ok, false);
    match(r.errors.join(' '), /engineer has conflicting attested versions \(canonical 9\.9\.9 vs legacy 1\.0\.0\)/);
  });

  it('imports a legacy attestation (no bound_versions) with a NULL codex version — never rebound', () => {
    const r = importHookAttestation({
      attested: true,
      status: 'attested',
      bundled_plugins: ['engineer'],
      plugin_versions: { engineer: '1.0.0' },
      artifact_pointer: null,
      artifact_hash: null,
      attested_at: AT,
    }, { expectedPlugins: ['engineer'] });
    ok(r.ok, JSON.stringify(r.errors));
    strictEqual(r.record.bound_versions.codex, null, 'a legacy attestation is never silently rebound to the current Codex');
    deepStrictEqual(r.record.bound_versions.plugins.codex, { engineer: '1.0.0' });
  });

  it('the imported record validates against the recorded $defs/hookAttestation shape', async () => {
    const validate = await makeDefValidator('runtime-bootstrap-run', 'hookAttestation');
    const r = importHookAttestation(doctorAttestation(), { expectedPlugins: ['engineer', 'orchestrator'] });
    ok(r.ok, JSON.stringify(r.errors));
    const verdict = validate(r.record);
    ok(verdict.ok, `imported record must match the recorded hookAttestation def; errors: ${JSON.stringify(verdict.errors)}`);
  });
});

// ---------------------------------------------------------------------------
// ADR-0048 §3 — egress evidence: kind-discriminated aggregate, duplicate
// rejection, and the owner receipt verdict (D0.1)
// ---------------------------------------------------------------------------

describe('runtime completion reducer — egress-provider-ack aggregate (ADR-0048 §3)', () => {
  const FP = 'f'.repeat(64);
  const ATTEMPT = 'a'.repeat(64);
  // `mirror: null` omits the sibling seat entirely (the legacy-record shape);
  // true/false write it. The default is the fully-verified shape: ack +
  // mirror + a linkable artifact hash (the three §8 evidence legs).
  function ackProof(current, { result = 'acked', fingerprint = FP, mirror = true, artifactHash = 'b'.repeat(64) } = {}) {
    return {
      kind: 'egress-provider-ack',
      status: 'passed',
      provider_ack: { result, attempt_hash: ATTEMPT, activation_fingerprint: fingerprint, ran_at: AT },
      ...(mirror === null ? {} : { mirror_correlated: mirror }),
      artifact_pointer: null,
      artifact_hash: artifactHash,
      bound_versions: structuredClone(current),
      ran_at: AT,
    };
  }
  const current = { runtime: RUNTIME_VERSION, claude: '2.1.208', codex: '0.144.1', plugins: { claude: {}, codex: {} } };

  it('an acked, fresh, fingerprint-matching proof is passed', () => {
    const r = recomputeProofStatus(ackProof(current), { current, currentActivationFingerprint: FP });
    strictEqual(r.status, 'passed');
  });

  it('a failed ack result is failed — the stored status is never consulted', () => {
    const r = recomputeProofStatus(ackProof(current, { result: 'failed' }), { current, currentActivationFingerprint: FP });
    strictEqual(r.status, 'failed');
  });

  it('an acked-but-unmirrored proof is FAILED, not passed — the mirror seat is a required recompute input (Refine-verify round 2)', () => {
    const r = recomputeProofStatus(ackProof(current, { mirror: false }), { current, currentActivationFingerprint: FP });
    strictEqual(r.status, 'failed');
    match(r.reasons.join(' '), /not verifiably mirrored/);
  });

  it('a record WITHOUT the mirror seat (legacy shape) reduces fail-closed as not-verified — absence never reads as passed', () => {
    const r = recomputeProofStatus(ackProof(current, { mirror: null }), { current, currentActivationFingerprint: FP });
    strictEqual(r.status, 'failed');
    match(r.reasons.join(' '), /not verifiably mirrored/);
  });

  it('an acked+mirrored record with NO artifact link is FAILED — the at-rest aggregate enforces all three §8 legs (Refine-verify round 3)', () => {
    const r = recomputeProofStatus(ackProof(current, { artifactHash: null }), { current, currentActivationFingerprint: FP });
    strictEqual(r.status, 'failed');
    match(r.reasons.join(' '), /does not link its doctor artifact/);
  });

  it('a removed activation stales the proof — never not-applicable (peer E5)', () => {
    const r = recomputeProofStatus(ackProof(current), { current, currentActivationFingerprint: null });
    strictEqual(r.status, 'stale');
    match(r.reasons.join(' '), /no longer carries/);
  });

  it('a changed activation identity stales by EQUALITY, not presence', () => {
    const r = recomputeProofStatus(ackProof(current), { current, currentActivationFingerprint: 'e'.repeat(64) });
    strictEqual(r.status, 'stale');
    match(r.reasons.join(' '), /identity drift/);
  });

  it('the importer reconstructs provider_ack and refuses the other kind\'s member', () => {
    const good = importProofMetadata({
      kind: 'egress-provider-ack', status: 'passed',
      provider_ack: { result: 'acked', attempt_hash: ATTEMPT, activation_fingerprint: FP, ran_at: AT },
      artifact_pointer: null, artifact_hash: null, bound_versions: current, ran_at: AT,
    });
    ok(good.ok, JSON.stringify(good.errors));
    ok(!('directions' in good.record), 'an egress record carries no directions member');

    const smuggled = importProofMetadata({
      kind: 'deep-peer-smoke', status: 'passed',
      directions: { 'claude->codex': { status: 'passed', ran_at: AT }, 'codex->claude': { status: 'passed', ran_at: AT } },
      provider_ack: { result: 'acked', attempt_hash: ATTEMPT, activation_fingerprint: FP, ran_at: AT },
      artifact_pointer: null, artifact_hash: null, bound_versions: current, ran_at: AT,
    });
    ok(smuggled.ok);
    ok(!('provider_ack' in smuggled.record), 'a directional record cannot carry provider_ack through the importer');
    ok(smuggled.dropped.some((d) => d.startsWith('provider_ack')), 'and the drop is reported');
  });

  it('the mirror seat imports as strict boolean-or-absent, and directional kinds refuse it', () => {
    const base = {
      kind: 'egress-provider-ack', status: 'failed',
      provider_ack: { result: 'acked', attempt_hash: ATTEMPT, activation_fingerprint: FP, ran_at: AT },
      artifact_pointer: null, artifact_hash: null, bound_versions: current, ran_at: AT,
    };
    const mirrored = importProofMetadata({ ...base, mirror_correlated: true });
    ok(mirrored.ok, JSON.stringify(mirrored.errors));
    strictEqual(mirrored.record.mirror_correlated, true, 'a boolean seat survives the import');

    const nonBool = importProofMetadata({ ...base, mirror_correlated: 'yes' });
    ok(nonBool.ok, JSON.stringify(nonBool.errors));
    ok(!('mirror_correlated' in nonBool.record), 'a non-boolean claim is never coerced into evidence');
    ok(nonBool.dropped.some((d) => d.startsWith('mirror_correlated')), 'and the drop is reported');

    const onDirectional = importProofMetadata({
      kind: 'deep-peer-smoke', status: 'passed',
      directions: { 'claude->codex': { status: 'passed', ran_at: AT }, 'codex->claude': { status: 'passed', ran_at: AT } },
      mirror_correlated: true,
      artifact_pointer: null, artifact_hash: null, bound_versions: current, ran_at: AT,
    });
    ok(onDirectional.ok, JSON.stringify(onDirectional.errors));
    ok(!('mirror_correlated' in onDirectional.record), 'the mirror fact belongs to the egress shape only');
    ok(onDirectional.dropped.some((d) => d.startsWith('mirror_correlated')), 'and the drop is reported');
  });
});

describe('runtime completion reducer — duplicate evidence is rejected (ADR-0048 §3)', () => {
  it('two records of one kind reduce that proof to failed and cap the run at incomplete — required or not', async () => {
    const pluginSet = await loadPluginSet();
    const plugins = resolveBundle(pluginSet, 'base');
    const probe = probeFor(plugins);
    const current = currentBoundVersions({ probe, selection: { plugins }, runtimeVersion: RUNTIME_VERSION });
    const expected = deriveExpectedSteps({ pluginSet, selection: { plugins } });
    const steps = expected.filter((s) => s.applicable).map((s) => ({ id: s.id, status: 'satisfied' }));
    const smoke = () => passingProof('deep-peer-smoke', current);

    const control = reduceCompletion({ pluginSet, selection: { plugins }, steps, proofs: [smoke()], hookAttestation: null, probe, runtimeVersion: RUNTIME_VERSION });
    strictEqual(control.state, 'complete', `control must be complete: ${JSON.stringify({ unsat: control.unsatisfied, missing: control.missing_steps, proofs: control.proofs.filter((p) => p.required).map((p) => [p.kind, p.status, p.reasons]) })}`);

    const duplicated = reduceCompletion({ pluginSet, selection: { plugins }, steps, proofs: [smoke(), smoke()], hookAttestation: null, probe, runtimeVersion: RUNTIME_VERSION });
    strictEqual(duplicated.state, 'incomplete', 'duplicate evidence never reduces past incomplete');
    const evaluated = duplicated.proofs.find((p) => p.kind === 'deep-peer-smoke');
    strictEqual(evaluated.status, 'failed');
    match(evaluated.reasons.join(' '), /duplicate evidence is rejected/);
  });
});

describe('runtime completion reducer — receipt attestation verdict (ADR-0048 §3 / D0.1)', () => {
  const ACK_SHA = '1'.repeat(64);
  const ATTEMPT = 'a'.repeat(64);
  const receipt = (over = {}) => ({
    surface: 'owner-phone',
    attested_at: AT,
    attempt_hash: ATTEMPT,
    provider_proof_artifact_hash: ACK_SHA,
    ...over,
  });
  const args = (over = {}) => ({
    record: receipt(),
    providerAckSha256: ACK_SHA,
    providerAckAttemptHash: ATTEMPT,
    ackStatus: 'passed',
    applicable: true,
    ...over,
  });

  it('attested requires: ack currently passing + file-hash link + attempt equality', () => {
    strictEqual(recomputeReceiptAttestation(args()).status, 'attested');
  });

  it('an ack that no longer passes stales the testimony — it never stays attested past its evidence', () => {
    for (const ackStatus of ['failed', 'stale', 'absent']) {
      const v = recomputeReceiptAttestation(args({ ackStatus }));
      strictEqual(v.status, 'stale', `ackStatus=${ackStatus}`);
      match(v.reasons.join(' '), /no longer stands/);
    }
  });

  it('a replaced provider-proof file stales by hash inequality', () => {
    const v = recomputeReceiptAttestation(args({ providerAckSha256: '2'.repeat(64) }));
    strictEqual(v.status, 'stale');
    match(v.reasons.join(' '), /not the one on disk/);
  });

  it('a receipt naming a different attempt does not cover this one', () => {
    const v = recomputeReceiptAttestation(args({ providerAckAttemptHash: 'b'.repeat(64) }));
    strictEqual(v.status, 'stale');
    match(v.reasons.join(' '), /different synthetic attempt/);
  });

  it('no testimony is absent; a run that never opted in is not-applicable', () => {
    strictEqual(recomputeReceiptAttestation(args({ record: null })).status, 'absent');
    strictEqual(recomputeReceiptAttestation(args({ record: null, applicable: false })).status, 'not-applicable');
  });

  it('reduceCompletion carries the verdict as the OPTIONAL completion member — absent for a run outside the egress world', async () => {
    const pluginSet = await loadPluginSet();
    const plugins = resolveBundle(pluginSet, 'base');
    const probe = probeFor(plugins);
    const expected = deriveExpectedSteps({ pluginSet, selection: { plugins } });
    const steps = expected.filter((s) => s.applicable).map((s) => ({ id: s.id, status: 'satisfied' }));
    const without = reduceCompletion({ pluginSet, selection: { plugins }, steps, proofs: [], hookAttestation: null, probe, runtimeVersion: RUNTIME_VERSION });
    ok(!('egress_receipt_attestation' in without), 'a run that never opted in keeps the exact 1.1 completion shape');

    const withReceipt = reduceCompletion({
      pluginSet, selection: { plugins }, steps, proofs: [], hookAttestation: null, probe, runtimeVersion: RUNTIME_VERSION,
      receiptEvidence: { record: receipt(), providerAckSha256: ACK_SHA },
    });
    strictEqual(withReceipt.egress_receipt_attestation.status, 'stale', 'testimony with no passing ack behind it is stale, not silently dropped');
  });
});
