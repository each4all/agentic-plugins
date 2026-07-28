// tests/runtime/test-effective-selection.mjs
//
// machine-bootstrap-contract.md §6.2 — the EFFECTIVE selection. `plan`/`resume`
// exercise this end to end in test-bootstrap-cli.mjs; this file pins the derivation
// itself, where the rules are stated: which declines narrow the selection, which are
// refused, what a HOST-scoped refusal does that a whole-plugin one does not, and why
// the closure is recomputed to a fixpoint rather than once.

import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  declinedPluginRows,
  effectiveSelection,
  hostPluginsOf,
  narrowSelectionByDeclines,
  narrowSelectionToEffective,
} from '../../plugins/runtime/scripts/lib/effective-selection.mjs';
import { codexHookBearingPlugins, loadPluginSet, resolveBundle } from '../../plugins/runtime/scripts/lib/plugin-set.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const PLUGIN_ROOT = join(REPO_ROOT, 'plugins', 'runtime');

const loadSet = () => loadPluginSet({ pluginRoot: PLUGIN_ROOT });

const declined = (id) => ({ id, status: 'declined' });
const selectionOf = (desired, bundle = 'custom') => ({ bundle, desired: [...desired].sort(), excluded: [] });

describe('runtime effective selection — which declines narrow it (§6.2)', () => {
  it('a plugin declined on EVERY host it targets leaves the selection', async () => {
    const pluginSet = await loadSet();
    const eff = effectiveSelection({
      pluginSet,
      selection: selectionOf(['runtime', 'companions', 'image']),
      steps: [declined('plugin.image.claude.installed'), declined('plugin.image.codex.installed')],
    });
    deepStrictEqual(eff.plugins, ['companions', 'runtime']);
    deepStrictEqual(eff.dropped, ['image']);
    deepStrictEqual(eff.refusedButRetained, []);
  });

  it('a plugin declined on ONE host keeps its place, and narrows that host only', async () => {
    const pluginSet = await loadSet();
    const eff = effectiveSelection({
      pluginSet,
      selection: selectionOf(['runtime', 'companions', 'image']),
      steps: [declined('plugin.image.claude.installed')],
    });
    // `desired` is a flat name list — it cannot say "on Codex but not Claude", so
    // dropping the plugin would refuse more than the operator did.
    deepStrictEqual(eff.plugins, ['companions', 'image', 'runtime']);
    deepStrictEqual(eff.byHost.claude, ['companions', 'runtime']);
    deepStrictEqual(eff.byHost.codex, ['companions', 'image', 'runtime']);
    deepStrictEqual(eff.dropped, []);
  });

  it('a Codex ENABLE decline drops the Codex binding — an un-enabled plugin runs nothing', async () => {
    const pluginSet = await loadSet();
    const eff = effectiveSelection({
      pluginSet,
      selection: selectionOf(['runtime', 'companions', 'image']),
      steps: [declined('plugin.image.codex.enabled')],
    });
    deepStrictEqual(eff.plugins, ['companions', 'image', 'runtime'], 'the plugin is still installed on Claude');
    deepStrictEqual(eff.byHost.codex, ['companions', 'runtime'], 'but it binds nothing on the host it will not run on');
    deepStrictEqual(eff.byHost.claude, ['companions', 'image', 'runtime']);
  });

  it('an `.enabled` decline alone never drops the PLUGIN — only `.installed` refusals do', async () => {
    const pluginSet = await loadSet();
    const eff = effectiveSelection({
      pluginSet,
      selection: selectionOf(['runtime', 'companions', 'image']),
      // Both host rows refused at the ENABLE grain (Claude has no such step; this is
      // a deliberately impossible pair, to prove the rule is keyed on `.installed`).
      steps: [declined('plugin.image.codex.enabled'), { id: 'plugin.image.claude.enabled', status: 'declined' }],
    });
    ok(eff.plugins.includes('image'));
  });

  it('only the exact step grammar counts — a lookalike id is not a decline', async () => {
    const pluginSet = await loadSet();
    const rows = declinedPluginRows([
      declined('plugin.image.claude.installed'),
      declined('plugin.image.codex.somethingelse'),
      declined('plugin.image.solaris.installed'),
      declined('plugins.image.codex.installed'),
      declined('permission.claude.applied'),
      { id: 'plugin.image.codex.installed', status: 'pending' },
    ]);
    strictEqual(rows.size, 1, 'exactly one plugin has a parsed decline row');
    deepStrictEqual([...(rows.get('image')?.installed ?? [])], ['claude'], 'one row parsed, four rejected, one not declined');
    // The unknown KIND must not be filed under the other bucket. A grammar loose
    // enough to accept `plugin.<name>.<host>.<anything>` still leaves `installed`
    // looking right while quietly booking every unrecognized suffix as an enable
    // refusal — a decline of a step that does not exist, narrowing a host.
    deepStrictEqual([...(rows.get('image')?.enabled ?? [])], [], 'an unknown suffix is not silently filed as an enable decline');

    const eff = effectiveSelection({
      pluginSet,
      selection: selectionOf(['runtime', 'companions', 'image']),
      steps: [declined('plugin.image.claude.installed'), declined('plugin.image.codex.somethingelse')],
    });
    ok(eff.plugins.includes('image'), 'an unparsed row cannot complete a whole-plugin refusal');
    deepStrictEqual(eff.byHost.codex, ['companions', 'image', 'runtime'], 'and it cannot narrow the host either');
  });

  it('a non-declined row is never read as one, whatever else it carries', async () => {
    const pluginSet = await loadSet();
    for (const status of ['satisfied', 'pending', 'blocked', 'manual-follow-up', 'unknown', 'not-applicable']) {
      const eff = effectiveSelection({
        pluginSet,
        selection: selectionOf(['runtime', 'companions', 'image']),
        steps: [{ id: 'plugin.image.claude.installed', status }, { id: 'plugin.image.codex.installed', status }],
      });
      deepStrictEqual(eff.dropped, [], `status ${status} is not a refusal`);
    }
  });
});

describe('runtime effective selection — what it refuses to narrow (§6.2)', () => {
  it('a mandatory plugin is retained and REPORTED, never silently dropped', async () => {
    const pluginSet = await loadSet();
    const eff = effectiveSelection({
      pluginSet,
      selection: selectionOf(['runtime', 'companions', 'image']),
      steps: [declined('plugin.companions.claude.installed'), declined('plugin.companions.codex.installed')],
    });
    ok(eff.plugins.includes('companions'), 'companions is mandatory in every selection');
    deepStrictEqual(eff.dropped, []);
    strictEqual(eff.refusedButRetained.length, 1);
    ok(/mandatory in every selection/.test(eff.refusedButRetained[0].reason));
  });

  it('a plugin a RETAINED plugin hard-requires is retained and reported', async () => {
    const pluginSet = await loadSet();
    // `orchestrator` hard-requires `engineer`.
    const eff = effectiveSelection({
      pluginSet,
      selection: selectionOf(['runtime', 'companions', 'engineer', 'orchestrator']),
      steps: [declined('plugin.engineer.claude.installed'), declined('plugin.engineer.codex.installed')],
    });
    ok(eff.plugins.includes('engineer'));
    ok(/hard edge from a retained plugin/.test(eff.refusedButRetained[0].reason));
  });

  it('the closure is recomputed to a FIXPOINT — declining the requirer frees its target', async () => {
    const pluginSet = await loadSet();
    const eff = effectiveSelection({
      pluginSet,
      selection: selectionOf(['runtime', 'companions', 'engineer', 'orchestrator']),
      steps: [
        declined('plugin.orchestrator.claude.installed'), declined('plugin.orchestrator.codex.installed'),
        declined('plugin.engineer.claude.installed'), declined('plugin.engineer.codex.installed'),
      ],
    });
    // A SINGLE pass drops `orchestrator` (declinable) and keeps `engineer` (still
    // hard-required by the orchestrator it just removed) — honouring one decline and
    // silently discarding the other. The fixpoint recomputes and takes both.
    deepStrictEqual(eff.plugins, ['companions', 'runtime']);
    deepStrictEqual(eff.dropped, ['engineer', 'orchestrator']);
    deepStrictEqual(eff.refusedButRetained, []);
  });

  it('the fixpoint is order-independent — the same declines in any row order reduce alike', async () => {
    const pluginSet = await loadSet();
    const rows = [
      declined('plugin.orchestrator.claude.installed'), declined('plugin.orchestrator.codex.installed'),
      declined('plugin.engineer.claude.installed'), declined('plugin.engineer.codex.installed'),
    ];
    const forward = effectiveSelection({ pluginSet, selection: selectionOf(['runtime', 'companions', 'engineer', 'orchestrator']), steps: rows });
    const reversed = effectiveSelection({ pluginSet, selection: selectionOf(['runtime', 'companions', 'engineer', 'orchestrator']), steps: [...rows].reverse() });
    deepStrictEqual(forward.plugins, reversed.plugins);
  });

  it('a plugin the plugin-set gives no hosts is not "fully declined" by vacuous truth', async () => {
    const pluginSet = await loadSet();
    const hostless = { ...pluginSet, plugins: { ...pluginSet.plugins, image: { ...pluginSet.plugins.image, hosts: [] } } };
    const eff = effectiveSelection({
      pluginSet: hostless,
      selection: selectionOf(['runtime', 'companions', 'image']),
      steps: [declined('plugin.image.claude.installed')],
    });
    ok(eff.plugins.includes('image'), 'every([]) is true — a vacuous refusal would drop a plugin nobody declined');
  });
});

describe('runtime effective selection — the persisted narrowing', () => {
  it('narrowing rewrites the bundle to `custom` and recomputes excluded', async () => {
    const pluginSet = await loadSet();
    const selection = { bundle: 'design', desired: resolveBundle(pluginSet, 'design'), excluded: [] };
    const narrowed = narrowSelectionByDeclines({
      pluginSet,
      selection,
      steps: [declined('plugin.image.claude.installed'), declined('plugin.image.codex.installed')],
    });
    strictEqual(narrowed.changed, true);
    // The bundle rewrite is load-bearing: `resolveSelection` re-expands a NAMED
    // bundle from the plugin-set, so a narrowed `desired` left under `design` would
    // be silently re-widened when the selection is seeded into a new run.
    strictEqual(narrowed.selection.bundle, 'custom');
    ok(!narrowed.selection.desired.includes('image'));
    ok(narrowed.selection.excluded.includes('image'), 'the refused plugin joins excluded');
    ok(narrowed.selection.excluded.includes('founder'), 'and so does everything else the selection never had');
    deepStrictEqual(
      [...narrowed.selection.desired, ...narrowed.selection.excluded].sort(),
      Object.keys(pluginSet.plugins).sort(),
      'desired and excluded partition the known plugin set',
    );
  });

  it('an unchanged selection is returned AS-IS, so nothing is rewritten for nothing', async () => {
    const pluginSet = await loadSet();
    const selection = { bundle: 'base', desired: resolveBundle(pluginSet, 'base'), excluded: [] };
    const narrowed = narrowSelectionByDeclines({ pluginSet, selection, steps: [] });
    strictEqual(narrowed.changed, false);
    strictEqual(narrowed.selection, selection, 'the same object — a `base` run keeps its bundle name');
  });

  it('narrowSelectionToEffective works from an ALREADY-resolved retained set', async () => {
    const pluginSet = await loadSet();
    const selection = { bundle: 'design', desired: resolveBundle(pluginSet, 'design'), excluded: [] };
    // The rows that justified this narrowing are GONE — which is exactly the state a
    // re-judged resume is in, and why re-deriving from steps[] there reverts it.
    const effective = { plugins: ['companions', 'runtime'], byHost: { claude: ['companions', 'runtime'], codex: ['companions', 'runtime'] }, dropped: [], refusedButRetained: [] };
    const narrowed = narrowSelectionToEffective({ pluginSet, selection, effective });
    strictEqual(narrowed.changed, true);
    deepStrictEqual(narrowed.selection.desired, ['companions', 'runtime']);
    deepStrictEqual(narrowed.dropped, ['attention', 'designer', 'image'], 'dropped is computed against the STORED selection, not the effective one');
  });
});

describe('runtime effective selection — hostPluginsOf and the shared hook predicate', () => {
  it('hostPluginsOf prefers byHost and falls back to the plugin list', () => {
    const withHosts = { plugins: ['a', 'b'], byHost: { claude: ['a'], codex: [] } };
    deepStrictEqual(hostPluginsOf(withHosts, 'claude'), ['a']);
    deepStrictEqual(hostPluginsOf(withHosts, 'codex'), []);
    // A caller that never resolved an effective selection must not silently bind
    // NOTHING — the fallback is the pre-§6.2 behaviour, not an empty set.
    deepStrictEqual(hostPluginsOf({ plugins: ['b', 'a'] }, 'claude'), ['a', 'b']);
    deepStrictEqual(hostPluginsOf({}, 'claude'), []);
  });

  it('the Codex-hook-bearing predicate is keyed on the CODEX value and sorted', async () => {
    const pluginSet = await loadSet();
    deepStrictEqual(codexHookBearingPlugins(pluginSet, ['orchestrator', 'engineer', 'companions']), ['engineer', 'orchestrator']);
    // `attention` bears Claude hooks and no Codex ones — Claude trusts plugin hooks
    // by install and has no /hooks review flow, so it is not this question.
    deepStrictEqual(codexHookBearingPlugins(pluginSet, ['attention', 'runtime']), []);
    deepStrictEqual(codexHookBearingPlugins(pluginSet, ['designer', 'designer']), ['designer'], 'de-duplicated');
    deepStrictEqual(codexHookBearingPlugins(pluginSet, ['nonexistent']), []);
    deepStrictEqual(codexHookBearingPlugins(pluginSet, undefined), []);
  });
});
