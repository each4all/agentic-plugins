// tests/runtime/test-step-registry.mjs — machine-bootstrap-contract.md §6.1, §11.1.
//
// The step registry is tested as code: what it derives, per bundle, with each
// step's stage and edges pinned literally at the end of this file. The
// contract's §6.1 prose tables follow it; no program reads them, so no test
// holds them to it (E1, owner-approved 2026-10-05).

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';

import { hardRequiredClosure, loadPluginSet, resolveBundle } from '../../plugins/runtime/scripts/lib/plugin-set.mjs';
import {
  CONFIG_STAGES,
  PROOF_STAGES,
  RETIRED_STEP_IDS,
  RESOLVED_STEP_STATUSES,
  deriveExpectedSteps,
  expectedStepIds,
  stepIds,
  validateStepGraph,
} from '../../plugins/runtime/scripts/lib/step-registry.mjs';

async function loadSet() {
  return loadPluginSet();
}

async function derive(bundle, extra = {}) {
  const pluginSet = await loadSet();
  return deriveExpectedSteps({ pluginSet, selection: { plugins: resolveBundle(pluginSet, bundle) }, ...extra });
}

describe('runtime step registry — graph shape', () => {
  it('every bundle derives an acyclic graph whose every edge resolves', async () => {
    for (const bundle of ['base', 'engineering', 'business', 'design', 'full']) {
      const steps = await derive(bundle);
      const graph = validateStepGraph(steps);
      strictEqual(graph.ok, true, `${bundle}: ${graph.errors.join('; ')}`);
    }
  });

  it('blocked_by is ALWAYS an explicit array — [] is written, never omitted', async () => {
    const steps = await derive('full');
    for (const step of steps) {
      ok(Array.isArray(step.blocked_by), `${step.id} carries an explicit blocked_by`);
    }
    // The roots genuinely have none, and say so.
    deepStrictEqual(steps.find((s) => s.id === 'host.claude.present').blocked_by, []);
    deepStrictEqual(steps.find((s) => s.id === 'config.model_effort').blocked_by, []);
  });

  it('a cycle is REPORTED, not left to hang two steps forever', () => {
    const cyclic = [
      { id: 'a.x.present', stage: 1, applicable: true, declinable: false, blocked_by: ['b.x.present'] },
      { id: 'b.x.present', stage: 1, applicable: true, declinable: false, blocked_by: ['a.x.present'] },
    ];
    const graph = validateStepGraph(cyclic);
    strictEqual(graph.ok, false);
    match(graph.errors.join(' '), /cycle in blocked_by/);
  });

  it('an edge to a step outside the selection is reported', () => {
    const orphan = [{ id: 'a.x.present', stage: 1, applicable: true, declinable: false, blocked_by: ['nope.y.present'] }];
    const graph = validateStepGraph(orphan);
    strictEqual(graph.ok, false);
    match(graph.errors.join(' '), /is not an expected step for this selection/);
  });

  it('the structural edges hold: auth needs the CLI, install needs the marketplace, enabled follows installed', async () => {
    const steps = await derive('engineering');
    const by = new Map(steps.map((s) => [s.id, s]));
    deepStrictEqual(by.get('host.codex.authenticated').blocked_by, ['host.codex.present']);
    deepStrictEqual(by.get('marketplace.codex.registered').blocked_by, ['host.codex.present']);
    deepStrictEqual(by.get(stepIds.pluginInstalled('engineer', 'codex')).blocked_by, ['marketplace.codex.registered']);
    deepStrictEqual(by.get(stepIds.pluginEnabled('engineer')).blocked_by, [stepIds.pluginInstalled('engineer', 'codex')]);
  });

  it('Claude has no enabled step — only Codex carries a disabled state (#31)', async () => {
    const steps = await derive('full');
    strictEqual(steps.some((s) => s.id.endsWith('.claude.enabled')), false);
    ok(steps.some((s) => s.id === stepIds.pluginEnabled('engineer')));
  });
});

describe('runtime step registry — applicability is derived, never claimed', () => {
  it('hooks.codex.attested is applicable for persona bundles and not-applicable for base', async () => {
    // This is the C0 correction, mechanically: `base` (runtime+companions+attention)
    // carries no Codex-hook-bearing plugin; every persona bundle does. The values come
    // from the plugin-set, not from a second list here.
    const pluginSet = await loadSet();
    for (const [bundle, expected] of [['base', false], ['engineering', true], ['business', true], ['design', true], ['full', true]]) {
      const steps = await derive(bundle);
      const step = steps.find((s) => s.id === 'hooks.codex.attested');
      strictEqual(step.applicable, expected, `${bundle}: hooks.codex.attested applicable=${expected}`);

      const codexHookPlugins = resolveBundle(pluginSet, bundle).filter((n) => pluginSet.plugins[n].hook_bearing.codex);
      strictEqual(step.applicable, codexHookPlugins.length > 0, `${bundle}: applicability tracks the plugin-set, not a hardcoded list`);
    }
  });

  it('hooks.codex.attested keys off the CODEX value — a Claude-only hook plugin does not trip it', async () => {
    const pluginSet = await loadSet();
    // `attention` is Claude-hook-bearing and Codex-hook-free (the C0 finding).
    strictEqual(pluginSet.plugins.attention.hook_bearing.claude, true);
    strictEqual(pluginSet.plugins.attention.hook_bearing.codex, false);
    const steps = deriveExpectedSteps({ pluginSet, selection: { plugins: ['runtime', 'companions', 'attention'] } });
    strictEqual(steps.find((s) => s.id === 'hooks.codex.attested').applicable, false);
  });

  it('proof.workflow-continuation is applicable iff engineer is selected', async () => {
    strictEqual((await derive('base')).find((s) => s.id === 'proof.workflow-continuation').applicable, false);
    strictEqual((await derive('engineering')).find((s) => s.id === 'proof.workflow-continuation').applicable, true);
  });

  it('proof.deep-peer-smoke is ALWAYS applicable — companions is mandatory to keep it reachable', async () => {
    for (const bundle of ['base', 'engineering', 'full']) {
      strictEqual((await derive(bundle)).find((s) => s.id === 'proof.deep-peer-smoke').applicable, true);
    }
  });

  // ADR-0057 §Decision 5 — the proof was decoupled from the removed Stage-6 advisory
  // fragment on BOTH edges. Applicability first: it is now unconditional, matching
  // `proof.deep-peer-smoke`. Merely DELETING the old gate (rather than replacing it)
  // would have left it permanently non-applicable, so this asserts `true` on every
  // bundle rather than on one.
  it('proof.permission is ALWAYS applicable — the ADR-0035 §4 boundary evidence is never gated on an advisory', async () => {
    for (const bundle of ['base', 'engineering', 'full']) {
      strictEqual((await derive(bundle)).find((s) => s.id === 'proof.permission').applicable, true, bundle);
    }
  });

  // The second edge, which the first draft of the decoupling would have left broken:
  // the step used to block on the two Stage-6 rows. Emptying the array is the other
  // half of the same mistake — a live companion proof that depends on nothing would
  // be reported reachable on a machine with no authenticated host and no companions.
  it('proof.permission blocks on the SAME edges as its sibling proof.deep-peer-smoke, not on nothing', async () => {
    const by = new Map((await derive('full')).map((step) => [step.id, step]));
    const permission = by.get('proof.permission');
    const smoke = by.get('proof.deep-peer-smoke');
    ok(permission.blocked_by.length > 0, 'the removed Stage-6 edges were replaced, not emptied');
    deepStrictEqual(
      [...permission.blocked_by].sort(),
      [...smoke.blocked_by].sort(),
      'both proofs make the same live companion invocation, so they carry the same edges',
    );
    ok(!permission.blocked_by.some((id) => id.startsWith('permission.')), 'no edge survives to a deleted Stage-6 step');
  });
});

describe('runtime step registry — declinability (§6.2)', () => {
  it('host presence/auth, marketplace, runtime and companions are never declinable', async () => {
    const steps = await derive('full');
    const by = new Map(steps.map((s) => [s.id, s]));
    for (const id of [
      'host.claude.present', 'host.claude.authenticated', 'host.codex.present', 'host.codex.authenticated',
      'marketplace.claude.registered', 'marketplace.codex.registered', 'config.model_effort', 'hooks.codex.attested',
    ]) {
      strictEqual(by.get(id).declinable, false, `${id} is not declinable`);
    }
    for (const name of ['runtime', 'companions']) {
      for (const step of steps.filter((s) => s.id.startsWith(`plugin.${name}.`))) {
        strictEqual(step.declinable, false, `${step.id} is mandatory in every selection`);
      }
    }
  });

  // §6.2's hard-edge rule, DERIVED. This is the realistic call — a caller who did not
  // hand-compute the closure — and it used to offer an illegal decline: `engineering`
  // retains `orchestrator`, which hard-requires `engineer`, so `engineer` came back
  // declinable and the operator was invited to break their own selection.
  it('a plugin reached by a HARD edge from a retained plugin is not declinable, without the caller saying so', async () => {
    const pluginSet = await loadSet();
    strictEqual(pluginSet.plugins.orchestrator.hard_requires.some((e) => e.name === 'engineer'), true, 'the fixture-free premise: orchestrator hard-requires engineer');

    const steps = deriveExpectedSteps({ pluginSet, selection: { plugins: resolveBundle(pluginSet, 'engineering') } });
    for (const step of steps.filter((s) => s.id.startsWith('plugin.engineer.'))) {
      strictEqual(step.declinable, false, `${step.id} is protected by orchestrator's hard edge`);
    }
    // A plugin nothing hard-requires stays declinable.
    ok(steps.filter((s) => s.id.startsWith('plugin.attention.')).every((s) => s.declinable === true));
  });

  it('the hard-edge closure is TRANSITIVE — a second-rank dependency is protected too', async () => {
    const pluginSet = await loadSet();
    const synthetic = structuredClone(pluginSet);
    synthetic.plugins.alpha = { bundles: [], hosts: ['claude'], hard_requires: [{ name: 'beta', hosts: ['claude'] }], soft_requires: [], hook_bearing: { claude: false, codex: false }, minimum_version: null };
    synthetic.plugins.beta = { bundles: [], hosts: ['claude'], hard_requires: [{ name: 'gamma', hosts: ['claude'] }], soft_requires: [], hook_bearing: { claude: false, codex: false }, minimum_version: null };
    synthetic.plugins.gamma = { bundles: [], hosts: ['claude'], hard_requires: [], soft_requires: [], hook_bearing: { claude: false, codex: false }, minimum_version: null };

    const steps = deriveExpectedSteps({ pluginSet: synthetic, selection: { plugins: ['runtime', 'companions', 'alpha', 'beta', 'gamma'] } });
    // A one-hop walk would protect beta and abandon gamma.
    strictEqual(steps.find((s) => s.id === 'plugin.beta.claude.installed').declinable, false);
    strictEqual(steps.find((s) => s.id === 'plugin.gamma.claude.installed').declinable, false, 'the second rank is reached transitively');
  });

  it('hardRequiredClosure walks the real graph and is cycle-safe', async () => {
    const pluginSet = await loadSet();
    // orchestrator → engineer, and engineer hard-requires nothing further.
    deepStrictEqual([...hardRequiredClosure(pluginSet, ['orchestrator'])].sort(), ['engineer']);
    deepStrictEqual([...hardRequiredClosure(pluginSet, ['runtime'])], []);

    const cyclic = structuredClone(pluginSet);
    cyclic.plugins.a = { bundles: [], hosts: ['claude'], hard_requires: [{ name: 'b', hosts: ['claude'] }], soft_requires: [], hook_bearing: { claude: false, codex: false }, minimum_version: null };
    cyclic.plugins.b = { bundles: [], hosts: ['claude'], hard_requires: [{ name: 'a', hosts: ['claude'] }], soft_requires: [], hook_bearing: { claude: false, codex: false }, minimum_version: null };
    // validatePluginSet rejects a cyclic hard graph, but the closure must not hang if
    // one ever reaches it.
    deepStrictEqual([...hardRequiredClosure(cyclic, ['a'])].sort(), ['a', 'b']);
  });

  it('statusline and every proof are declinable', async () => {
    const steps = await derive('engineering');
    const by = new Map(steps.map((s) => [s.id, s]));
    for (const id of [
      'statusline.claude.configured', 'statusline.codex.configured',
      'proof.deep-peer-smoke', 'proof.workflow-continuation', 'proof.permission',
    ]) {
      strictEqual(by.get(id).declinable, true, `${id} is declinable`);
    }
  });
});

describe('runtime step registry — retired steps (ADR-0057, ADR-0064)', () => {
  it('no retired step id is derived for any bundle, and each names the ADR that retired it', async () => {
    const ids = Object.keys(RETIRED_STEP_IDS);
    ok(ids.length >= 7, 'the retired-id map is not vacuous');
    for (const id of ids) {
      ok(['ADR-0057', 'ADR-0064'].includes(RETIRED_STEP_IDS[id]), `${id} maps to a known ADR, got ${RETIRED_STEP_IDS[id]}`);
    }
    for (const bundle of ['base', 'engineering', 'business', 'design', 'full']) {
      const derived = new Set((await derive(bundle)).map((s) => s.id));
      for (const id of ids) strictEqual(derived.has(id), false, `${bundle}: retired step ${id} is not derived`);
    }
  });
});

describe('runtime step registry — reducer partition (§8)', () => {
  it('CONFIG is stages 1-7 and PROOF is stage 8, with nothing outside', async () => {
    deepStrictEqual([...CONFIG_STAGES], [1, 2, 3, 4, 5, 6, 7]);
    deepStrictEqual([...PROOF_STAGES], [8]);
    const steps = await derive('full');
    for (const step of steps) {
      ok(CONFIG_STAGES.includes(step.stage) || PROOF_STAGES.includes(step.stage), `${step.id} stage ${step.stage} is in the taxonomy`);
    }
    // The partition is what makes `configured-not-verified` reachable at all: every
    // proof lives in stage 8, so "CONFIG resolved, PROOF not" is expressible.
    const proofs = steps.filter((s) => s.id.startsWith('proof.'));
    ok(proofs.length >= 2 && proofs.every((s) => s.stage === 8));
  });

  it('`unknown` is not a resolved status — unknown is never satisfied (§6)', () => {
    deepStrictEqual([...RESOLVED_STEP_STATUSES], ['satisfied', 'declined', 'not-applicable']);
    ok(!RESOLVED_STEP_STATUSES.includes('unknown'));
    ok(!RESOLVED_STEP_STATUSES.includes('pending'));
  });

  it('expectedStepIds counts only APPLICABLE steps', async () => {
    const steps = await derive('base');
    const expected = expectedStepIds(steps);
    ok(!expected.has('hooks.codex.attested'), 'a not-applicable step is enumerated but not owed');
    ok(expected.has('proof.deep-peer-smoke'));
  });
});

describe('runtime step registry — stages and blocked_by edges', () => {
  // Contract: bootstrap takes each step's stage and edges from the registry.
  // The stage picks the step's applied_by (operator, h2-executor,
  // agentic-config; a run-schema enum) and its [stage N] line, and an
  // unresolved predecessor reports the step blocked — so a moved stage, or a
  // dropped or invented edge, changes who applies a step and what the operator
  // is told to do first. Until E1 retired it, the §6.1 table was the only
  // oracle for these values; the oracle is now this literal.
  it('derives every step of the full bundle at its stage, with exactly its edges', async () => {
    const pluginSet = await loadSet();
    const plugins = resolveBundle(pluginSet, 'full');
    const proofPredecessors = [
      'host.claude.authenticated', 'host.codex.authenticated',
      'plugin.companions.claude.installed', 'plugin.companions.codex.installed', 'plugin.companions.codex.enabled',
    ];
    const expected = [
      { id: 'host.claude.present', stage: 1, blocked_by: [] },
      { id: 'host.claude.authenticated', stage: 1, blocked_by: ['host.claude.present'] },
      { id: 'host.codex.present', stage: 1, blocked_by: [] },
      { id: 'host.codex.authenticated', stage: 1, blocked_by: ['host.codex.present'] },
      { id: 'marketplace.claude.registered', stage: 2, blocked_by: ['host.claude.present'] },
      { id: 'marketplace.codex.registered', stage: 2, blocked_by: ['host.codex.present'] },
      ...plugins.flatMap((name) => [
        { id: `plugin.${name}.claude.installed`, stage: 3, blocked_by: ['marketplace.claude.registered'] },
        { id: `plugin.${name}.codex.installed`, stage: 3, blocked_by: ['marketplace.codex.registered'] },
        { id: `plugin.${name}.codex.enabled`, stage: 3, blocked_by: [`plugin.${name}.codex.installed`] },
      ]),
      { id: 'config.model_effort', stage: 4, blocked_by: [] },
      { id: 'config.session', stage: 4, blocked_by: [] },
      { id: 'statusline.claude.configured', stage: 5, blocked_by: ['host.claude.present'] },
      { id: 'statusline.codex.configured', stage: 5, blocked_by: ['host.codex.present'] },
      // The Codex-hook-bearing plugins: their hooks are what the operator reviews.
      {
        id: 'hooks.codex.attested',
        stage: 7,
        blocked_by: ['designer', 'engineer', 'founder', 'orchestrator']
          .flatMap((name) => [`plugin.${name}.codex.installed`, `plugin.${name}.codex.enabled`]),
      },
      { id: 'proof.deep-peer-smoke', stage: 8, blocked_by: proofPredecessors },
      { id: 'proof.permission', stage: 8, blocked_by: proofPredecessors },
      {
        id: 'proof.workflow-continuation',
        stage: 8,
        blocked_by: ['plugin.engineer.claude.installed', 'plugin.engineer.codex.installed', 'plugin.engineer.codex.enabled'],
      },
    ];
    const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const derived = (await derive('full')).map(({ id, stage, blocked_by }) => ({ id, stage, blocked_by }));
    deepStrictEqual(derived.sort(byId), expected.sort(byId));
  });
});
