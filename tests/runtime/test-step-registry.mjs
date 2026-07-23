// tests/runtime/test-step-registry.mjs — machine-bootstrap-contract.md §6.1, §11.1.
//
// §11.1: "Tests MUST ... assert the prose tables in §9 and §6 agree with
// plugin-set.json and the step registry." So the contract's own §6.1 table is PARSED
// out of the document and compared against what the registry derives. A test that
// only checked the code would let the table drift into fiction while CI stayed green
// — which is the precise failure §11 opens by naming.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { hardRequiredClosure, loadPluginSet, resolveBundle } from '../../plugins/runtime/scripts/lib/plugin-set.mjs';
import {
  CONFIG_STAGES,
  PROOF_STAGES,
  RESOLVED_STEP_STATUSES,
  deriveExpectedSteps,
  expectedStepIds,
  stepIds,
  validateStepGraph,
} from '../../plugins/runtime/scripts/lib/step-registry.mjs';

const CONTRACT = resolve(new URL('../../plugins/runtime/docs/machine-bootstrap-contract.md', import.meta.url).pathname);

async function loadSet() {
  return loadPluginSet();
}

async function derive(bundle, extra = {}) {
  const pluginSet = await loadSet();
  return deriveExpectedSteps({ pluginSet, selection: { plugins: resolveBundle(pluginSet, bundle) }, ...extra });
}

// The ONE §6.1 table parser. Shared so the three agreement tests cannot drift into
// parsing the table three slightly different ways, and it throws rather than returning
// [] — a vacuous parse passes every downstream assertion while proving nothing.
async function parseStepTable() {
  const doc = await readFile(CONTRACT, 'utf8');
  const start = doc.indexOf('### 6.1 The expected-step registry');
  const end = doc.indexOf('**`blocked_by` edges**');
  if (start < 0 || end < 0 || end <= start) throw new Error('could not locate the §6.1 step table in the contract');
  const rows = [...doc.slice(start, end).matchAll(/^\|\s*`([^`]+)`\s*\|\s*(\d)\s*\|([^|]*)\|([^|]*)\|/gm)]
    .map(([, id, stage, applicability, declinable]) => ({ id, stage: Number(stage), applicability: applicability.trim(), declinable: declinable.trim() }));
  if (rows.length < 18) throw new Error(`§6.1 table parsed only ${rows.length} rows — the parser has drifted from the table`);
  return rows;
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

  // §5/§8.1: the permission proof is required IFF a fragment was applied — so a
  // machine whose permissions already matched does not trip a proof it never needed.
  // (§6.1's table said "iff permission.*.applied is satisfied", a looser restatement
  // that would demand the proof for a config this run never touched; corrected in C4.)
  it('proof.permission is applicable iff a fragment was actually applied, not merely satisfied', async () => {
    strictEqual((await derive('base')).find((s) => s.id === 'proof.permission').applicable, false);
    const applied = await derive('base', { permissionFragmentApplied: { claude: true, codex: false } });
    strictEqual(applied.find((s) => s.id === 'proof.permission').applicable, true);
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

  it('notify, egress, the permission fragments, and every proof are declinable', async () => {
    const steps = await derive('engineering');
    const by = new Map(steps.map((s) => [s.id, s]));
    for (const id of [
      'notify.configured', 'egress.configured', 'permission.claude.applied', 'permission.codex.applied',
      'proof.deep-peer-smoke', 'proof.workflow-continuation', 'proof.permission',
    ]) {
      strictEqual(by.get(id).declinable, true, `${id} is declinable`);
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

describe('runtime step registry — the §6.1 prose table agrees with the code (§11.1)', () => {
  // Parse the contract's own table and hold the registry to it. Prose tokens are a
  // floor (§11.3); THIS is the enforcement.
  it('every step id in the §6.1 table is derivable, and every derived id is in the table', async () => {
    const rows = await parseStepTable();
    const steps = await derive('full', { permissionFragmentApplied: { claude: true, codex: true } });
    const derived = new Set(steps.map((s) => s.id));

    for (const row of rows) {
      // Templated rows (`plugin.<name>.claude.installed`) expand per selected plugin.
      if (row.id.includes('<name>')) {
        const re = new RegExp(`^${row.id.replace('<name>', '[a-z-]+').replace(/\./g, '\\.')}$`);
        ok([...derived].some((id) => re.test(id)), `${row.id} expands to at least one derived step`);
        for (const id of [...derived].filter((d) => re.test(d))) {
          strictEqual(steps.find((s) => s.id === id).stage, row.stage, `${id} stage matches the table`);
        }
        continue;
      }
      ok(derived.has(row.id), `${row.id} from the §6.1 table is derived`);
      strictEqual(steps.find((s) => s.id === row.id).stage, row.stage, `${row.id} stage matches the table`);
    }

    // And the other direction: nothing the code invents is missing from the table.
    const templates = rows.map((r) => new RegExp(`^${r.id.replace('<name>', '[a-z-]+').replace(/\./g, '\\.')}$`));
    for (const id of derived) {
      ok(templates.some((re) => re.test(id)), `derived step ${id} appears in the §6.1 table`);
    }
  });

  it("the table's declinable column agrees with the registry", async () => {
    const rows = await parseStepTable();
    const steps = await derive('full', { permissionFragmentApplied: { claude: true, codex: true } });
    const by = new Map(steps.map((s) => [s.id, s]));

    for (const row of rows) {
      if (row.id.includes('<name>')) continue; // per-plugin, covered by the declinability suite
      const step = by.get(row.id);
      if (!step) continue;
      // The column is prose ("**yes**", "no (but `not-applicable` when ...)"), so read
      // its LEAD token rather than pattern-matching the whole sentence.
      const saysYes = /^\*\*yes\*\*/.test(row.declinable);
      strictEqual(step.declinable, saysYes, `${row.id}: table says "${row.declinable}", registry says declinable=${step.declinable}`);
    }
  });

  // The APPLICABILITY column, actually compared. Parsing a column and never asserting
  // on it is how a table drifts into fiction with the test still green — the exact
  // failure §11 opens by naming.
  it("the table's applicability column agrees with the registry", async () => {
    const rows = (await parseStepTable()).filter((r) => !r.id.includes('<name>'));
    const pluginSet = await loadSet();

    // Each prose phrasing is turned into a PREDICATE over a selection, then checked on
    // bundles that make it true and false. "always" that is really conditional, or a
    // condition naming the wrong plugin, fails here.
    const cases = [
      { bundle: 'base', fragmentApplied: {}, egressProofRequested: false },
      { bundle: 'engineering', fragmentApplied: {}, egressProofRequested: false },
      // The full bundle exercises BOTH manifest-legitimate opt-in seams true.
      { bundle: 'full', fragmentApplied: { claude: true }, egressProofRequested: true },
    ];
    for (const { bundle, fragmentApplied, egressProofRequested } of cases) {
      const plugins = resolveBundle(pluginSet, bundle);
      const steps = deriveExpectedSteps({ pluginSet, selection: { plugins }, permissionFragmentApplied: fragmentApplied, egressProofRequested });
      const by = new Map(steps.map((s) => [s.id, s]));
      for (const row of rows) {
        const step = by.get(row.id);
        if (!step) continue;
        const prose = row.applicability;
        let expected;
        if (/^always$/i.test(prose)) expected = true;
        else if (/iff any selected plugin has `hook_bearing.codex`/.test(prose)) expected = plugins.some((n) => pluginSet.plugins[n].hook_bearing.codex);
        else if (/iff `engineer` ∈ selection/.test(prose)) expected = plugins.includes('engineer');
        else if (/iff a `permission\.\*\.applied` step carries `fragment_applied: true`/.test(prose)) expected = Object.values(fragmentApplied).some(Boolean);
        else if (/iff the operator opted in/.test(prose)) expected = egressProofRequested === true;
        else throw new Error(`unrecognized applicability prose for ${row.id}: "${prose}" — teach this test the phrasing rather than letting it pass unchecked`);
        strictEqual(step.applicable, expected, `${bundle}/${row.id}: table says "${prose}", registry says applicable=${step.applicable}`);
      }
    }
  });

  it('the §6.1 blocked_by table is PARSED and every documented edge is derived', async () => {
    const doc = await readFile(CONTRACT, 'utf8');
    ok(/An empty `blocked_by` is written \*\*explicitly\*\*/.test(doc), 'the explicit-empty rule is stated');
    ok(/the registry — not `run\.steps\[\]` — is the authority/.test(doc), 'the forgery boundary is stated');

    const start = doc.indexOf('**`blocked_by` edges**');
    ok(start > 0, 'the contract defines the blocked_by edges §5 references');
    const section = doc.slice(start, doc.indexOf('An empty `blocked_by` is written'));
    const rows = [...section.matchAll(/^\|\s*`([^`]+)`(?:,\s*`([^`]+)`)?\s*\|\s*(.+?)\s*\|$/gm)]
      .map(([, id, id2, edges]) => ({ ids: [id, id2].filter(Boolean), edges: edges.trim() }));
    ok(rows.length >= 10, `parsed the blocked_by table (${rows.length} rows) — a vacuous parse would pass every assertion below`);

    const steps = await derive('full', { permissionFragmentApplied: { claude: true, codex: true } });
    const by = new Map(steps.map((s) => [s.id, s]));
    const expand = (id) => (id.includes('<h>') ? ['claude', 'codex'].map((h) => id.replace('<h>', h)) : [id]);

    let checked = 0;
    for (const row of rows) {
      for (const templated of row.ids.flatMap(expand)) {
        if (templated.includes('<name>')) continue; // per-plugin rows: covered above
        const step = by.get(templated);
        if (!step) continue;
        checked += 1;
        if (row.edges.startsWith('—')) {
          deepStrictEqual(step.blocked_by, [], `${templated}: the table says no predecessors, so the registry must write []`);
          continue;
        }
        // Every step-id the row names in backticks must be an actual edge.
        for (const named of [...row.edges.matchAll(/`([^`]+)`/g)].map((m) => m[1])) {
          for (const edge of expand(named.replace('<h>', templated.split('.')[1]))) {
            if (edge.includes('<name>') || !by.has(edge)) continue;
            ok(step.blocked_by.includes(edge), `${templated}: the table names '${edge}' as a blocker; the registry derives [${step.blocked_by}]`);
          }
        }
      }
    }
    ok(checked >= 6, `compared ${checked} documented rows against the registry`);

    // And the specific edges the prose pins by name, in both directions.
    deepStrictEqual(by.get('host.claude.authenticated').blocked_by, ['host.claude.present']);
    deepStrictEqual(by.get('permission.claude.applied').blocked_by, ['host.claude.present']);
    deepStrictEqual(by.get('proof.permission').blocked_by, ['permission.claude.applied', 'permission.codex.applied']);
    ok(by.get('proof.deep-peer-smoke').blocked_by.includes('host.codex.authenticated'));
    ok(by.get('proof.deep-peer-smoke').blocked_by.includes(stepIds.pluginInstalled('companions', 'claude')));
    ok(by.get('hooks.codex.attested').blocked_by.every((id) => id.startsWith('plugin.')));
  });
});
