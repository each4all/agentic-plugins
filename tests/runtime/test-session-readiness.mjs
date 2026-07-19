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
  SESSION_READINESS_STATES,
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
async function makeFixture({
  repoToml = 'session_capture = "stop-hook"\n',
  userToml = null,
  attentionVersions = [{ version: '0.5.0', floorsText: floorsDocument() }],
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
