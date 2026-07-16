import { describe, it } from 'node:test';
import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'node:assert/strict';

import {
  EXECUTABLE_PLUGIN_ACTIONS,
  EXECUTABLE_PLUGIN_CLEANUP_ACTIONS,
  buildPluginPlans,
  buildPluginManagementPlan,
  buildPluginCleanupPlans,
  collectMutationActions,
  computeMutationPlanHash,
} from '../../plugins/runtime/scripts/lib/plugin-management-plan.mjs';
import { PLUGIN_NAMES } from '../../plugins/runtime/scripts/lib/machine-probe.mjs';

// C2 (machine-bootstrap-contract.md §1.3 extraction 5 + §1.6 drift guard). The
// plan half is now a pure lib so bootstrap can recompute the SAME executor hash
// from the same probe facts WITHOUT a source checkout. These tests pin exactly
// that: identical facts → identical hash, and the byte-exact serialization the
// §1.6 guard depends on. `deepFreeze` the inputs so any accidental input mutation
// (a future non-pure edit) throws instead of silently drifting the hash.

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// A recommendation in the buildPluginPlans-output shape that buildPluginManagementPlan consumes.
function rec({ host, action, args, command }) {
  return { host, action, command: command ?? `${host} ${args.join(' ')}`, argv: { command: host, args } };
}

const CLIS_UP = deepFreeze({
  claude: { status: 'available', plugin: { status: 'available' }, feature_surface: { plugin_install_command: true, plugin_uninstall_command: true } },
  codex: { status: 'available' },
});
const CLIS_CODEX_DOWN = deepFreeze({
  claude: { status: 'available', plugin: { status: 'available' }, feature_surface: { plugin_install_command: true, plugin_uninstall_command: true } },
  codex: { status: 'unavailable' },
});

// Two plugins each recommend the byte-identical codex marketplace command — the
// dedup hazard Area C flagged. Plus one claude install (distinct per plugin).
const PLUGINS = deepFreeze({
  runtime: { recommendations: [rec({ host: 'claude', action: 'install-plugin', args: ['plugin', 'install', 'runtime@agentic-plugins'] })] },
  engineer: { recommendations: [rec({ host: 'codex', action: 'add-marketplace', args: ['plugin', 'marketplace', 'add', 'each4all/agentic-plugins'] })] },
  founder: { recommendations: [rec({ host: 'codex', action: 'add-marketplace', args: ['plugin', 'marketplace', 'add', 'each4all/agentic-plugins'] })] },
});

const HOST_PARITY_ISSUES = deepFreeze([
  { id: 'claude_retired_or_unknown_plugin', host: 'claude', plugin: 'research', severity: 'warning', summary: 'research is retired', evidence: { probed: true }, next_step: 'uninstall it' },
]);

function planHash({ plugins = PLUGINS, clis = CLIS_UP, hostParityIssues = HOST_PARITY_ISSUES, hostFilter = 'all', execute = false } = {}) {
  const pluginManagement = buildPluginManagementPlan({ plugins, clis, execute, hostFilter, timeoutMs: 120000 });
  const pluginCleanup = buildPluginCleanupPlans({ hostParityIssues, clis, execute, timeoutMs: 120000 });
  const actions = collectMutationActions({ pluginManagement, pluginCleanup });
  return { hash: computeMutationPlanHash(actions), actions, pluginManagement, pluginCleanup };
}

describe('plugin-management-plan: shared §1.6 plan hash', () => {
  it('identical facts → identical hash, recomputed without a source checkout', () => {
    // Both runs build the plan from literal fixture facts only — no runDoctor, no
    // fs, no ./plugins read. That is exactly what bootstrap does to present the hash.
    const a = planHash();
    const b = planHash();
    ok(/^[0-9a-f]{64}$/.test(a.hash), 'hash is 64-hex sha256');
    strictEqual(a.hash, b.hash, 'deterministic across runs');
  });

  it('is content-addressed: a fresh deep-clone of the same facts hashes identically', () => {
    const clone = JSON.parse(JSON.stringify({ plugins: PLUGINS, clis: CLIS_UP, hostParityIssues: HOST_PARITY_ISSUES }));
    strictEqual(planHash().hash, planHash({ plugins: clone.plugins, clis: clone.clis, hostParityIssues: clone.hostParityIssues }).hash);
  });

  it('is mode-invariant: execute vs dry-run produce the same hash (§1.6 executor revalidates the dry-run hash)', () => {
    strictEqual(planHash({ execute: false }).hash, planHash({ execute: true }).hash);
  });

  it('CLI availability IS a hash input via dedup (the Area C hazard is preserved, not smoothed over)', () => {
    // codex available: the two identical marketplace commands dedup to ONE action.
    // codex unavailable: both survive as distinct `blocked` actions (distinct plugin).
    const up = planHash({ clis: CLIS_UP });
    const down = planHash({ clis: CLIS_CODEX_DOWN });
    const codexActionsUp = up.actions.filter((a) => a.host === 'codex');
    const codexActionsDown = down.actions.filter((a) => a.host === 'codex');
    strictEqual(codexActionsUp.length, 1, 'CLI available → duplicate marketplace command deduped to 1');
    strictEqual(codexActionsDown.length, 2, 'CLI unavailable → both blocked commands survive (distinct plugin)');
    notStrictEqual(up.hash, down.hash, 'a bootstrap blind to CLI availability would NOT reproduce this hash');
  });

  it('serializes actions with the byte-exact key order + sort the §1.6 guard depends on', () => {
    const { actions } = planHash({ clis: CLIS_CODEX_DOWN });
    for (const action of actions) {
      deepStrictEqual(Object.keys(action), ['area', 'host', 'plugin', 'action', 'command', 'args'], 'fixed key insertion order');
    }
    const sortKey = (a) => JSON.stringify([a.area, a.command, a.args, a.host, a.plugin ?? '']);
    const keys = actions.map(sortKey);
    deepStrictEqual(keys, [...keys].sort(), 'actions are sorted by the canonical sort key');
  });

  it('drops skipped + deduplicated but keeps blocked (mgmt); keeps every cleanup with argv', () => {
    const { actions } = planHash({ clis: CLIS_CODEX_DOWN });
    // claude install (planned) + 2 codex blocked + 1 cleanup (manual_required, dry-run) with argv.
    const areas = actions.map((a) => `${a.area}:${a.host}:${a.plugin}`).sort();
    deepStrictEqual(areas, [
      'plugin-cleanup:claude:research',
      'plugin-management:claude:runtime',
      'plugin-management:codex:engineer',
      'plugin-management:codex:founder',
    ]);
  });

  it('host filter changes the hash (filtered plans become `skipped` and drop out)', () => {
    notStrictEqual(planHash({ hostFilter: 'all' }).hash, planHash({ hostFilter: 'claude' }).hash);
  });
});

describe('plugin-management-plan: recommendation computer composes purely (full chain, no source checkout)', () => {
  // buildPluginPlans iterates PLUGIN_NAMES and reads plugins[name].* — a machine
  // profile hands it probe facts, never a ./plugins read. A minimal all-names fixture
  // proves the chain runs pure + deterministic end to end.
  function doctorPluginsFixture() {
    const plugins = {};
    for (const name of PLUGIN_NAMES) {
      plugins[name] = { status: 'ok', source: { present: false }, installed: {}, cache: {}, marketplace: { claude: true, codex: true } };
    }
    // One plugin missing its codex marketplace registration → a real recommendation.
    plugins.engineer.marketplace = { claude: true, codex: false };
    plugins.engineer.source = { present: true, claude_manifest: { version: '0.7.0' } };
    return plugins;
  }

  it('buildPluginPlans → hash is deterministic across two independent runs', () => {
    const facts = deepFreeze(doctorPluginsFixture());
    const run = () => {
      const plugins = buildPluginPlans(facts, { codexPerPluginVerbList: ['add'], marketplaceRegistration: null });
      const pluginManagement = buildPluginManagementPlan({ plugins, clis: CLIS_UP, execute: false, hostFilter: 'all', timeoutMs: 120000 });
      const pluginCleanup = buildPluginCleanupPlans({ hostParityIssues: [], clis: CLIS_UP, execute: false, timeoutMs: 120000 });
      return computeMutationPlanHash(collectMutationActions({ pluginManagement, pluginCleanup }));
    };
    strictEqual(run(), run());
  });

  it('exports the executable-action allowlists as the single authority', () => {
    ok(EXECUTABLE_PLUGIN_ACTIONS.has('install-plugin'));
    ok(EXECUTABLE_PLUGIN_ACTIONS.has('add-marketplace'));
    ok(EXECUTABLE_PLUGIN_CLEANUP_ACTIONS.has('uninstall-retired-plugin'));
  });
});
