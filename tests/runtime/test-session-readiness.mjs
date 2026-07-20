// ADR-0044 S4 shared readiness assessment tests
// (session-capture-contract.md §11 S4 / §13): the half-enabled capture
// states detected by lib/session-readiness.mjs, which doctor and settings
// both consume.
//
// Mutation discipline: the ready control case comes FIRST, proving every
// blocker asserted afterwards is reachable from a fixture that passes when
// intact — a green rejection case over an always-broken fixture proves
// nothing.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ATTENTION_RUNTIME_FLOORS_REL_PATH,
  ENTRY_BRIEF_READINESS_STATES,
  RUNTIME_ENTRY_EXECUTOR_REL_PATH,
  SESSION_READINESS_STATES,
  assessEntryBriefReadiness,
  assessSessionCaptureReadiness,
  claudePluginListEnablement,
} from '../../plugins/runtime/scripts/lib/session-readiness.mjs';

const READY_RUNTIME_VERSION = '0.90.0';
const READY_FLOOR = '0.90.0';

function floorsDocument({ schema = 'attention-runtime-floors-1.0', floors = { publish_session: READY_FLOOR } } = {}) {
  return JSON.stringify({ schema, floors }, null, 2);
}

// homeDir/.claude/plugins/cache/agentic-plugins/attention/<version>/ with a
// Claude manifest, plus an optional data/runtime-floors.json declaration.
// `runtimeVersions` mints cached runtime builds the same way for the
// entry-executor probe (`executor: false` omits scripts/context.mjs).
async function makeFixture({
  repoToml = 'session_capture = "stop-hook"\n',
  userToml = null,
  attentionVersions = [{ version: '0.5.0', floorsText: floorsDocument() }],
  runtimeVersions = [],
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'session-readiness-'));
  const repoRoot = join(root, 'repo');
  const homeDir = join(root, 'home');
  await mkdir(join(repoRoot, '.agentic-plugins'), { recursive: true });
  await mkdir(join(homeDir, '.agentic-plugins'), { recursive: true });
  if (repoToml !== null) await writeFile(join(repoRoot, '.agentic-plugins', 'config.toml'), repoToml);
  if (userToml !== null) await writeFile(join(homeDir, '.agentic-plugins', 'config.toml'), userToml);
  for (const entry of attentionVersions) {
    const pluginRoot = join(homeDir, '.claude', 'plugins', 'cache', 'agentic-plugins', 'attention', entry.version);
    await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'attention', version: entry.version }),
    );
    if (entry.floorsText !== undefined) {
      await mkdir(join(pluginRoot, 'data'), { recursive: true });
      await writeFile(join(pluginRoot, ATTENTION_RUNTIME_FLOORS_REL_PATH), entry.floorsText);
    }
  }
  for (const entry of runtimeVersions) {
    const pluginRoot = join(homeDir, '.claude', 'plugins', 'cache', 'agentic-plugins', 'runtime', entry.version);
    await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'runtime', version: entry.version }),
    );
    if (entry.executor !== false) {
      await mkdir(join(pluginRoot, 'scripts'), { recursive: true });
      await writeFile(join(pluginRoot, RUNTIME_ENTRY_EXECUTOR_REL_PATH), '// executor stub\n');
    }
  }
  return {
    repoRoot,
    homeDir,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function assess(fx, overrides = {}) {
  return assessSessionCaptureReadiness({
    repoRoot: fx.repoRoot,
    homeDir: fx.homeDir,
    env: {},
    runtimeVersion: READY_RUNTIME_VERSION,
    ...overrides,
  });
}

describe('assessSessionCaptureReadiness (contract §13)', () => {
  it('control: gate on + installed attention + satisfied declared floor => ready', async () => {
    const fx = await makeFixture();
    try {
      const result = await assess(fx);
      strictEqual(result.status, 'ready');
      deepStrictEqual(result.states, []);
      deepStrictEqual(result.recommendations, []);
      strictEqual(result.gate.value, 'stop-hook');
      strictEqual(result.safe_mode.active, false);
      strictEqual(result.attention.installed, true);
      strictEqual(result.attention.version, '0.5.0');
      strictEqual(result.attention.enablement, 'unverified');
      strictEqual(result.publisher_floor.declared, true);
      strictEqual(result.publisher_floor.floor, READY_FLOOR);
      strictEqual(result.publisher_floor.satisfied, true);
      strictEqual(result.publisher_floor.runtime_version, READY_RUNTIME_VERSION);
    } finally {
      await fx.cleanup();
    }
  });

  it('shipped default off is informational: no states, no recommendations, no chain checks', async () => {
    const fx = await makeFixture({ repoToml: null, attentionVersions: [] });
    try {
      const result = await assess(fx);
      strictEqual(result.status, 'off');
      strictEqual(result.gate.value, 'off');
      deepStrictEqual(result.states, []);
      deepStrictEqual(result.recommendations, []);
      // Chain facts stay at their unexamined defaults — off short-circuits.
      strictEqual(result.attention.installed, false);
      strictEqual(result.publisher_floor.declared, false);
    } finally {
      await fx.cleanup();
    }
  });

  it('invalid stored gate value fail-closes as config-fail-closed with a recommendation', async () => {
    const fx = await makeFixture({ repoToml: 'session_capture = "sometimes"\n' });
    try {
      const result = await assess(fx);
      strictEqual(result.status, 'config-fail-closed');
      strictEqual(result.gate.value, null);
      ok(result.gate.errors.length > 0, 'carries the loader errors');
      strictEqual(result.recommendations.length, 1);
      strictEqual(result.recommendations[0].state, 'config-fail-closed');
    } finally {
      await fx.cleanup();
    }
  });

  it('safe mode env blocks the chain (and inert values do not)', async () => {
    const fx = await makeFixture();
    try {
      for (const inert of [undefined, '', '0', 'false']) {
        const control = await assess(fx, { env: inert === undefined ? {} : { CLAUDE_CODE_SAFE_MODE: inert } });
        strictEqual(control.status, 'ready', `inert value ${JSON.stringify(inert)} must not trip safe mode`);
      }
      const result = await assess(fx, { env: { CLAUDE_CODE_SAFE_MODE: '1' } });
      strictEqual(result.status, 'blocked');
      deepStrictEqual(result.states, ['safe-mode-hooks-disabled']);
      strictEqual(result.safe_mode.active, true);
      strictEqual(result.safe_mode.source, 'CLAUDE_CODE_SAFE_MODE');
      strictEqual(result.recommendations.length, 1);
    } finally {
      await fx.cleanup();
    }
  });

  it('gate on with no attention install => attention-missing', async () => {
    const fx = await makeFixture({ attentionVersions: [] });
    try {
      const result = await assess(fx);
      strictEqual(result.status, 'blocked');
      deepStrictEqual(result.states, ['attention-missing']);
      strictEqual(result.attention.installed, false);
      strictEqual(result.recommendations[0].state, 'attention-missing');
    } finally {
      await fx.cleanup();
    }
  });

  it('installed attention without the declaration file => publisher-sensor-not-shipped', async () => {
    const fx = await makeFixture({ attentionVersions: [{ version: '0.5.0' }] });
    try {
      const result = await assess(fx);
      strictEqual(result.status, 'blocked');
      deepStrictEqual(result.states, ['publisher-sensor-not-shipped']);
      strictEqual(result.attention.installed, true);
      strictEqual(result.publisher_floor.declared, false);
      strictEqual(result.publisher_floor.satisfied, null);
    } finally {
      await fx.cleanup();
    }
  });

  it('each malformed declaration shape => floor-declaration-malformed (fail-closed)', async () => {
    const malformedTexts = [
      'not json at all',
      floorsDocument({ schema: 'attention-runtime-floors-2.0' }),
      JSON.stringify({ schema: 'attention-runtime-floors-1.0' }),
      floorsDocument({ floors: {} }),
      floorsDocument({ floors: { publish_session: 'soon' } }),
      floorsDocument({ floors: { publish_session: 42 } }),
      // Released-floor rule (contract §13): a prerelease/build-suffixed floor
      // is never a valid declaration — clean X.Y.Z only.
      floorsDocument({ floors: { publish_session: '0.90.0-rc.1' } }),
      floorsDocument({ floors: { publish_session: '0.90.0+build.5' } }),
    ];
    for (const floorsText of malformedTexts) {
      const fx = await makeFixture({ attentionVersions: [{ version: '0.5.0', floorsText }] });
      try {
        const result = await assess(fx);
        strictEqual(result.status, 'blocked', `blocked for ${JSON.stringify(floorsText).slice(0, 60)}`);
        deepStrictEqual(result.states, ['floor-declaration-malformed']);
        strictEqual(result.publisher_floor.declared, true);
        strictEqual(result.publisher_floor.floor, null);
        strictEqual(result.publisher_floor.satisfied, null);
      } finally {
        await fx.cleanup();
      }
    }
  });

  it('a 1.x minor schema id is accepted (cross-version declaration family)', async () => {
    const fx = await makeFixture({
      attentionVersions: [{ version: '0.5.0', floorsText: floorsDocument({ schema: 'attention-runtime-floors-1.3' }) }],
    });
    try {
      const result = await assess(fx);
      strictEqual(result.status, 'ready');
      strictEqual(result.publisher_floor.floor, READY_FLOOR);
    } finally {
      await fx.cleanup();
    }
  });

  it('declared floor above the installed runtime => runtime-below-publisher-floor', async () => {
    const fx = await makeFixture({
      attentionVersions: [{ version: '0.5.0', floorsText: floorsDocument({ floors: { publish_session: '0.99.0' } }) }],
    });
    try {
      const result = await assess(fx);
      strictEqual(result.status, 'blocked');
      deepStrictEqual(result.states, ['runtime-below-publisher-floor']);
      strictEqual(result.publisher_floor.floor, '0.99.0');
      strictEqual(result.publisher_floor.satisfied, false);
    } finally {
      await fx.cleanup();
    }
  });

  it('an equal-core prerelease install sits BELOW the declared publisher floor (strict prerelease semantics)', async () => {
    // The sensors' strict versionGte holds `X.Y.Z-pre` below floor `X.Y.Z`;
    // the diagnosis must agree, not report ready for a spawn the sensor skips.
    const fx = await makeFixture();
    try {
      const result = await assess(fx, { runtimeVersion: `${READY_FLOOR}-beta.1` });
      strictEqual(result.status, 'blocked');
      deepStrictEqual(result.states, ['runtime-below-publisher-floor']);
      strictEqual(result.publisher_floor.satisfied, false);
    } finally {
      await fx.cleanup();
    }
  });

  it('reads the declaration from the NEWEST installed attention (numeric semver order)', async () => {
    const fx = await makeFixture({
      attentionVersions: [
        { version: '0.9.0', floorsText: floorsDocument({ floors: { publish_session: '9.9.9' } }) },
        { version: '0.10.0', floorsText: floorsDocument() }, // newest despite lexicographic order
      ],
    });
    try {
      const result = await assess(fx);
      strictEqual(result.attention.version, '0.10.0');
      strictEqual(result.status, 'ready', 'the newest build\'s satisfied floor governs');
    } finally {
      await fx.cleanup();
    }
  });

  it('binds the declaration to the plugin-list-named version when that build is cached', async () => {
    // Peer edge case: an enabled OLDER attention plus a newer stale cache dir
    // whose declaration would (wrongly) claim readiness — the active build's
    // missing declaration must govern.
    const fx = await makeFixture({
      attentionVersions: [
        { version: '0.4.0' }, // the build the host actually activates: no declaration yet
        { version: '0.5.0', floorsText: floorsDocument() }, // stale newer cache dir
      ],
    });
    try {
      const bound = await assess(fx, { attentionEnablement: { enabled: true, version: '0.4.0' } });
      strictEqual(bound.attention.version, '0.4.0', 'plugin-list version wins over newest-cache');
      deepStrictEqual(bound.states, ['publisher-sensor-not-shipped']);
      // A named version NOT present in the cache falls back to newest.
      const fallback = await assess(fx, { attentionEnablement: { enabled: true, version: '9.9.9' } });
      strictEqual(fallback.attention.version, '0.5.0');
      strictEqual(fallback.status, 'ready');
    } finally {
      await fx.cleanup();
    }
  });

  it('ignores a cache dir whose manifest names a different plugin', async () => {
    const fx = await makeFixture({ attentionVersions: [{ version: '0.5.0', floorsText: floorsDocument() }] });
    try {
      const control = await assess(fx);
      strictEqual(control.status, 'ready', 'control: intact manifest counts as an install');
      const { writeFile: wf } = await import('node:fs/promises');
      const manifestPath = join(
        fx.homeDir, '.claude', 'plugins', 'cache', 'agentic-plugins', 'attention', '0.5.0', '.claude-plugin', 'plugin.json',
      );
      await wf(manifestPath, JSON.stringify({ name: 'not-attention', version: '0.5.0' }));
      const result = await assess(fx);
      strictEqual(result.attention.installed, false, 'a foreign manifest is not an attention install');
      deepStrictEqual(result.states, ['attention-missing']);
    } finally {
      await fx.cleanup();
    }
  });

  it('injected enablement refines the verdict: false blocks, true verifies, absent stays unverified', async () => {
    const fx = await makeFixture();
    try {
      const disabled = await assess(fx, { attentionEnablement: { enabled: false } });
      strictEqual(disabled.status, 'blocked');
      deepStrictEqual(disabled.states, ['attention-disabled']);
      strictEqual(disabled.attention.enablement, 'disabled');

      const enabled = await assess(fx, { attentionEnablement: { enabled: true } });
      strictEqual(enabled.status, 'ready');
      strictEqual(enabled.attention.enablement, 'enabled');

      const listNull = await assess(fx, { attentionEnablement: { enabled: null } });
      strictEqual(listNull.status, 'ready');
      strictEqual(listNull.attention.enablement, 'unverified');
    } finally {
      await fx.cleanup();
    }
  });

  it('states compose: safe mode + missing attention are both reported', async () => {
    const fx = await makeFixture({ attentionVersions: [] });
    try {
      const result = await assess(fx, { env: { CLAUDE_CODE_SAFE_MODE: 'true' } });
      strictEqual(result.status, 'blocked');
      deepStrictEqual(result.states, ['safe-mode-hooks-disabled', 'attention-missing']);
      strictEqual(result.recommendations.length, 2);
      for (const state of result.states) ok(SESSION_READINESS_STATES.includes(state));
    } finally {
      await fx.cleanup();
    }
  });

  it('maps Claude plugin-list rows to enablement evidence (status string, not a boolean)', () => {
    // The shared adapter both probe-owning surfaces (doctor, settings) use —
    // parseClaudePluginList rows carry status/version/scope, never `enabled`.
    deepStrictEqual(claudePluginListEnablement({ status: 'enabled', version: '0.4.0' }), { enabled: true, version: '0.4.0' });
    deepStrictEqual(claudePluginListEnablement({ status: 'failed', version: '0.4.0' }), { enabled: false, version: '0.4.0' });
    deepStrictEqual(claudePluginListEnablement({ status: 'disabled', version: null }), { enabled: false, version: null });
    deepStrictEqual(claudePluginListEnablement({ status: 'something else' }), { enabled: null, version: null });
    strictEqual(claudePluginListEnablement(null), null);
    strictEqual(claudePluginListEnablement(undefined), null);
  });

  it('every emitted state is a member of the exported state enum', async () => {
    // Guards the enum export against drifting from the emitter.
    const emitted = new Set();
    const scenarios = [
      { fixture: {}, overrides: { env: { CLAUDE_CODE_SAFE_MODE: '1' }, attentionEnablement: { enabled: false } } },
      { fixture: { attentionVersions: [] }, overrides: {} },
      { fixture: { attentionVersions: [{ version: '0.5.0' }] }, overrides: {} },
      { fixture: { attentionVersions: [{ version: '0.5.0', floorsText: 'broken' }] }, overrides: {} },
      { fixture: { attentionVersions: [{ version: '0.5.0', floorsText: floorsDocument({ floors: { publish_session: '9.9.9' } }) }] }, overrides: {} },
    ];
    for (const scenario of scenarios) {
      const fx = await makeFixture(scenario.fixture);
      try {
        const result = await assess(fx, scenario.overrides);
        for (const state of result.states) emitted.add(state);
      } finally {
        await fx.cleanup();
      }
    }
    deepStrictEqual([...emitted].sort(), [...SESSION_READINESS_STATES].sort());
  });
});

// ---------------------------------------------------------------------------
// ADR-0045 §10 entry-side assessment (contract §18): the same mutation
// discipline — the ready control first, every blocker reachable from a
// fixture that passes when intact.
// ---------------------------------------------------------------------------

const ENTRY_USER_TOML = 'entry_brief = "startup"\n';

function entryFloorsDocument({ entryFloor = READY_FLOOR, publishFloor = READY_FLOOR, omitEntry = false } = {}) {
  const floors = { publish_session: publishFloor };
  if (!omitEntry) floors.entry_brief = entryFloor;
  return floorsDocument({ floors });
}

async function makeEntryFixture(overrides = {}) {
  return makeFixture({
    repoToml: null,
    userToml: ENTRY_USER_TOML,
    attentionVersions: [{ version: '0.6.0', floorsText: entryFloorsDocument() }],
    runtimeVersions: [{ version: '0.90.0' }],
    ...overrides,
  });
}

function assessEntry(fx, overrides = {}) {
  return assessEntryBriefReadiness({
    repoRoot: fx.repoRoot,
    homeDir: fx.homeDir,
    env: {},
    runtimeVersion: READY_RUNTIME_VERSION,
    ...overrides,
  });
}

describe('assessEntryBriefReadiness (contract §18)', () => {
  it('control: gate on + installed attention + entry floor + executor present => ready', async () => {
    const fx = await makeEntryFixture();
    try {
      const result = await assessEntry(fx);
      strictEqual(result.status, 'ready');
      deepStrictEqual(result.states, []);
      deepStrictEqual(result.recommendations, []);
      strictEqual(result.gate.value, 'startup');
      strictEqual(result.gate.empty_value, 'silent');
      strictEqual(result.safe_mode.active, false);
      strictEqual(result.attention.installed, true);
      strictEqual(result.attention.version, '0.6.0');
      strictEqual(result.attention.enablement, 'unverified');
      strictEqual(result.entry_floor.declared, true);
      strictEqual(result.entry_floor.floor, READY_FLOOR);
      strictEqual(result.entry_floor.satisfied, true);
      strictEqual(result.entry_floor.runtime_version, READY_RUNTIME_VERSION);
      deepStrictEqual(result.entry_executor, { probed: true, present: true, runtime_version: '0.90.0' });
    } finally {
      await fx.cleanup();
    }
  });

  it('shipped default off is informational: no states, no chain checks, executor unprobed', async () => {
    const fx = await makeEntryFixture({ userToml: null });
    try {
      const result = await assessEntry(fx);
      strictEqual(result.status, 'off');
      strictEqual(result.gate.value, 'off');
      deepStrictEqual(result.states, []);
      deepStrictEqual(result.recommendations, []);
      strictEqual(result.attention.installed, false); // chain not evaluated
      deepStrictEqual(result.entry_executor, { probed: false, present: null, runtime_version: null });
    } finally {
      await fx.cleanup();
    }
  });

  it('a tracked repo value never activates: off, reported as ignored', async () => {
    const fx = await makeEntryFixture({ userToml: null, repoToml: 'entry_brief = "startup"\n' });
    try {
      const result = await assessEntry(fx);
      strictEqual(result.status, 'off');
      strictEqual(result.gate.value, 'off');
      ok(result.gate.ignored_repo_keys.includes('entry_brief'));
      strictEqual(result.gate.repo_layer, 'read');
    } finally {
      await fx.cleanup();
    }
  });

  it('the env channel activates without a user file (env > user-global > default)', async () => {
    const fx = await makeEntryFixture({ userToml: null });
    try {
      const result = await assessEntry(fx, { env: { AGENTIC_ENTRY_BRIEF: 'startup' } });
      strictEqual(result.status, 'ready');
      strictEqual(result.gate.value, 'startup');
    } finally {
      await fx.cleanup();
    }
  });

  it('an invalid user value fail-closes as config-fail-closed with a recommendation', async () => {
    const fx = await makeEntryFixture({ userToml: 'entry_brief = "always"\n' });
    try {
      const result = await assessEntry(fx);
      strictEqual(result.status, 'config-fail-closed');
      strictEqual(result.gate.value, null);
      strictEqual(result.recommendations.length, 1);
      strictEqual(result.recommendations[0].state, 'config-fail-closed');
    } finally {
      await fx.cleanup();
    }
  });

  it('safe mode env blocks the entry chain', async () => {
    const fx = await makeEntryFixture();
    try {
      const result = await assessEntry(fx, { env: { CLAUDE_CODE_SAFE_MODE: '1' } });
      strictEqual(result.status, 'blocked');
      deepStrictEqual(result.states, ['safe-mode-hooks-disabled']);
      strictEqual(result.safe_mode.active, true);
    } finally {
      await fx.cleanup();
    }
  });

  it('gate on with no attention install => attention-missing', async () => {
    const fx = await makeEntryFixture({ attentionVersions: [] });
    try {
      const result = await assessEntry(fx);
      strictEqual(result.status, 'blocked');
      deepStrictEqual(result.states, ['attention-missing']);
    } finally {
      await fx.cleanup();
    }
  });

  it('injected enablement refines the verdict: false blocks, true verifies, absent stays unverified', async () => {
    const fx = await makeEntryFixture();
    try {
      const disabled = await assessEntry(fx, { attentionEnablement: { enabled: false, version: '0.6.0' } });
      strictEqual(disabled.attention.enablement, 'disabled');
      ok(disabled.states.includes('attention-disabled'));
      const enabled = await assessEntry(fx, { attentionEnablement: { enabled: true, version: '0.6.0' } });
      strictEqual(enabled.attention.enablement, 'enabled');
      strictEqual(enabled.status, 'ready');
      const absent = await assessEntry(fx);
      strictEqual(absent.attention.enablement, 'unverified');
    } finally {
      await fx.cleanup();
    }
  });

  it('no floors file at all => entry-sensor-not-shipped', async () => {
    const fx = await makeEntryFixture({ attentionVersions: [{ version: '0.6.0' }] });
    try {
      const result = await assessEntry(fx);
      strictEqual(result.status, 'blocked');
      deepStrictEqual(result.states, ['entry-sensor-not-shipped']);
      strictEqual(result.entry_floor.declared, false);
    } finally {
      await fx.cleanup();
    }
  });

  it('a valid floors file WITHOUT the entry_brief sibling key => entry-sensor-not-shipped, never malformed', async () => {
    // The additive sibling-key rule (§13): the S5-era file legitimately
    // exists with publish_session only until the entry sensor ships.
    const fx = await makeEntryFixture({
      attentionVersions: [{ version: '0.6.0', floorsText: entryFloorsDocument({ omitEntry: true }) }],
    });
    try {
      const result = await assessEntry(fx);
      strictEqual(result.status, 'blocked');
      deepStrictEqual(result.states, ['entry-sensor-not-shipped']);
      strictEqual(result.entry_floor.declared, false);
    } finally {
      await fx.cleanup();
    }
  });

  it('each malformed entry-floor shape => floor-declaration-malformed (fail-closed)', async () => {
    for (const entryFloor of ['0.90', 1, '1.0.0-rc.1', '']) {
      const fx = await makeEntryFixture({
        attentionVersions: [{ version: '0.6.0', floorsText: entryFloorsDocument({ entryFloor }) }],
      });
      try {
        const result = await assessEntry(fx);
        strictEqual(result.status, 'blocked', `entry floor ${JSON.stringify(entryFloor)} must be malformed`);
        deepStrictEqual(result.states, ['floor-declaration-malformed']);
        strictEqual(result.entry_floor.floor, null);
      } finally {
        await fx.cleanup();
      }
    }
  });

  it('a present file missing the FOUNDING publish_session key is malformed — an additive sibling never validates out of a corrupt document', async () => {
    // Review-peer repro: {floors:{entry_brief:"0.90.0"}} must never read
    // as ready — §13 makes publish_session required by the 1.x family.
    const fx = await makeEntryFixture({
      attentionVersions: [{
        version: '0.6.0',
        floorsText: JSON.stringify({ schema: 'attention-runtime-floors-1.0', floors: { entry_brief: READY_FLOOR } }),
      }],
    });
    try {
      const result = await assessEntry(fx);
      strictEqual(result.status, 'blocked');
      deepStrictEqual(result.states, ['floor-declaration-malformed']);
    } finally {
      await fx.cleanup();
    }
  });

  it('an array-shaped floors value is malformed, never sibling-absent', async () => {
    const fx = await makeEntryFixture({
      attentionVersions: [{
        version: '0.6.0',
        floorsText: JSON.stringify({ schema: 'attention-runtime-floors-1.0', floors: [] }),
      }],
    });
    try {
      const result = await assessEntry(fx);
      strictEqual(result.status, 'blocked');
      deepStrictEqual(result.states, ['floor-declaration-malformed']);
    } finally {
      await fx.cleanup();
    }
  });

  it('config-fail-closed keeps the repo-layer observations visible (ignored keys, repo_layer)', async () => {
    const fx = await makeEntryFixture({
      userToml: 'entry_brief = "always"\n',
      repoToml: 'entry_brief = "startup"\n',
    });
    try {
      const result = await assessEntry(fx);
      strictEqual(result.status, 'config-fail-closed');
      deepStrictEqual(result.gate.ignored_repo_keys, ['entry_brief']);
      strictEqual(result.gate.repo_layer, 'read');
    } finally {
      await fx.cleanup();
    }
  });

  it('declared entry floor above the installed runtime => runtime-below-entry-floor', async () => {
    const fx = await makeEntryFixture({
      attentionVersions: [{ version: '0.6.0', floorsText: entryFloorsDocument({ entryFloor: '99.0.0' }) }],
    });
    try {
      const result = await assessEntry(fx);
      strictEqual(result.status, 'blocked');
      deepStrictEqual(result.states, ['runtime-below-entry-floor']);
      strictEqual(result.entry_floor.satisfied, false);
      // Below the floor the executor probe is moot — never reached.
      deepStrictEqual(result.entry_executor, { probed: false, present: null, runtime_version: null });
    } finally {
      await fx.cleanup();
    }
  });

  it('an equal-core prerelease install sits BELOW the declared entry floor (strict prerelease semantics)', async () => {
    const fx = await makeEntryFixture();
    try {
      const result = await assessEntry(fx, { runtimeVersion: `${READY_FLOOR}-beta.1` });
      strictEqual(result.status, 'blocked');
      deepStrictEqual(result.states, ['runtime-below-entry-floor']);
      strictEqual(result.entry_floor.satisfied, false);
      deepStrictEqual(result.entry_executor, { probed: false, present: null, runtime_version: null });
    } finally {
      await fx.cleanup();
    }
  });

  it('executor absent at a passing floor => entry-executor-missing (ADR-0045 §10)', async () => {
    const fx = await makeEntryFixture({ runtimeVersions: [{ version: '0.90.0', executor: false }] });
    try {
      const result = await assessEntry(fx);
      strictEqual(result.status, 'blocked');
      deepStrictEqual(result.states, ['entry-executor-missing']);
      strictEqual(result.entry_floor.satisfied, true);
      deepStrictEqual(result.entry_executor, { probed: true, present: false, runtime_version: '0.90.0' });
    } finally {
      await fx.cleanup();
    }
  });

  it('no cached runtime build => executor unverifiable (present null), not a blocking state', async () => {
    const fx = await makeEntryFixture({ runtimeVersions: [] });
    try {
      const result = await assessEntry(fx);
      strictEqual(result.status, 'ready');
      deepStrictEqual(result.entry_executor, { probed: true, present: null, runtime_version: null });
    } finally {
      await fx.cleanup();
    }
  });

  it('probes the NEWEST cached runtime build (numeric semver order)', async () => {
    const fx = await makeEntryFixture({
      runtimeVersions: [
        { version: '0.9.0', executor: true },
        { version: '0.100.0', executor: false },
      ],
    });
    try {
      const result = await assessEntry(fx);
      deepStrictEqual(result.entry_executor, { probed: true, present: false, runtime_version: '0.100.0' });
      deepStrictEqual(result.states, ['entry-executor-missing']);
    } finally {
      await fx.cleanup();
    }
  });

  it('states compose: safe mode + missing attention are both reported', async () => {
    const fx = await makeEntryFixture({ attentionVersions: [] });
    try {
      const result = await assessEntry(fx, { env: { CLAUDE_CODE_SAFE_MODE: '1' } });
      strictEqual(result.status, 'blocked');
      deepStrictEqual([...result.states].sort(), ['attention-missing', 'safe-mode-hooks-disabled']);
    } finally {
      await fx.cleanup();
    }
  });

  it('every emitted entry state is a member of the exported entry state enum', async () => {
    const emitted = new Set();
    const scenarios = [
      { overrides: { attentionVersions: [] }, env: { CLAUDE_CODE_SAFE_MODE: '1' } },
      { overrides: {}, enablement: { enabled: false, version: '0.6.0' } },
      { overrides: { attentionVersions: [{ version: '0.6.0', floorsText: entryFloorsDocument({ omitEntry: true }) }] } },
      { overrides: { attentionVersions: [{ version: '0.6.0', floorsText: entryFloorsDocument({ entryFloor: 'nope' }) }] } },
      { overrides: { attentionVersions: [{ version: '0.6.0', floorsText: entryFloorsDocument({ entryFloor: '99.0.0' }) }] } },
      { overrides: { runtimeVersions: [{ version: '0.90.0', executor: false }] } },
    ];
    for (const scenario of scenarios) {
      const fx = await makeEntryFixture(scenario.overrides);
      try {
        const result = await assessEntry(fx, {
          env: scenario.env ?? {},
          attentionEnablement: scenario.enablement ?? null,
        });
        for (const state of result.states) emitted.add(state);
      } finally {
        await fx.cleanup();
      }
    }
    deepStrictEqual([...emitted].sort(), [...ENTRY_BRIEF_READINESS_STATES].sort());
  });
});
