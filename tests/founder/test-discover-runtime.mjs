// ADR-0043 §2/§4 — founder dual-consumer discoverRuntimePluginRoot tests.
//
// founder's resolver serves TWO consumers with independent floors and
// independent gating capability files (the ADR-0043 §2 requirement — copying
// engineer's footer-gated resolver wholesale would have silently changed
// notify discovery from "notify exists" to "footer exists"):
//   - FOOTER pair (default): MIN_RUNTIME_VERSION, gates on scripts/footer.mjs
//   - NOTIFY pair (explicit): NOTIFY_MIN_RUNTIME_VERSION, gates on scripts/notify.mjs
// Proves each ladder rung, the fail-closed "missing / too-old" contract (no
// stale-cache fallback), and the capability independence of the two ladders.
// Host-free + deterministic: every case injects env/home/selfUrl and builds
// throwaway fixtures. Run via `node --test tests/founder/test-discover-runtime.mjs`.

import { describe, it } from 'node:test';
import { strictEqual } from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  discoverRuntimePluginRoot,
  resolveRuntimePluginRoot,
  runtimeVersionAtLeast,
  FOOTER_CAPABILITY,
  NOTIFY_CAPABILITY,
  MIN_RUNTIME_VERSION,
  NOTIFY_MIN_RUNTIME_VERSION,
} from '../../plugins/founder/scripts/discover-runtime.mjs';

const NOTIFY_PAIR = { minVersion: NOTIFY_MIN_RUNTIME_VERSION, capability: NOTIFY_CAPABILITY };

// Build a runtime plugin root at `root` with a manifest + capability stubs.
async function mkRuntimeRoot(root, {
  version = '0.80.0',
  name = 'runtime',
  withFooter = true,
  withNotify = true,
} = {}) {
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version }));
  await mkdir(join(root, 'scripts'), { recursive: true });
  if (withFooter) await writeFile(join(root, 'scripts', 'footer.mjs'), '// stub footer\n');
  if (withNotify) await writeFile(join(root, 'scripts', 'notify.mjs'), '// stub notify\n');
  return root;
}

// Build the Claude cache layout `<home>/.claude/plugins/cache/agentic-plugins/runtime/<version>/`.
async function mkClaudeCache(home, entries) {
  const base = join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'runtime');
  for (const entry of entries) {
    const spec = typeof entry === 'string' ? { version: entry } : entry;
    await mkRuntimeRoot(join(base, spec.version), spec);
  }
  return base;
}

// Build the Codex fixed cache `<home>/.codex/.tmp/marketplaces/agentic-plugins/plugins/runtime/`.
async function mkCodexCache(home, spec = {}) {
  const root = join(home, '.codex', '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'runtime');
  await mkRuntimeRoot(root, spec);
  return root;
}

async function tmp(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

const NO_HOME = () => tmp('frt-emptyhome-'); // a home with no caches
const NEUTRAL_SELF = 'file:///nowhere/scripts/discover-runtime.mjs'; // no /.claude/ or /.codex/, no sibling

describe('founder discoverRuntimePluginRoot — dual-consumer floors (ADR-0043 §2/§4)', () => {
  it('exports the documented floor + capability constants', () => {
    // The footer floor is the first RELEASED runtime containing the ADR-0043
    // S2 enum expansion (plugin-runtime-v0.79.0); the notify floor is the
    // ADR-0040 release-gate pin, unchanged by the footer onboarding.
    strictEqual(MIN_RUNTIME_VERSION, '0.79.0');
    strictEqual(NOTIFY_MIN_RUNTIME_VERSION, '0.71.0');
    strictEqual(FOOTER_CAPABILITY, 'footer.mjs');
    strictEqual(NOTIFY_CAPABILITY, 'notify.mjs');
  });

  it('env override (valid) → returns the root for both pairs', async () => {
    const root = await mkRuntimeRoot(await tmp('frt-env-ok-'));
    const home = await NO_HOME();
    strictEqual(
      await discoverRuntimePluginRoot({ env: { AGENTIC_RUNTIME_ROOT: root }, home, selfUrl: NEUTRAL_SELF }),
      root,
    );
    strictEqual(
      await discoverRuntimePluginRoot({ env: { AGENTIC_RUNTIME_ROOT: root }, home, selfUrl: NEUTRAL_SELF, ...NOTIFY_PAIR }),
      root,
    );
  });

  it('env override (invalid — non-absolute) → null', async () => {
    const home = await NO_HOME();
    strictEqual(
      await discoverRuntimePluginRoot({ env: { AGENTIC_RUNTIME_ROOT: 'relative/runtime' }, home, selfUrl: NEUTRAL_SELF }),
      null,
    );
  });

  it('capability independence: a notify-only runtime serves the notify ladder, never the footer ladder', async () => {
    const root = await mkRuntimeRoot(await tmp('frt-notifyonly-'), { withFooter: false });
    const home = await NO_HOME();
    const env = { AGENTIC_RUNTIME_ROOT: root };
    strictEqual(
      await discoverRuntimePluginRoot({ env, home, selfUrl: NEUTRAL_SELF, ...NOTIFY_PAIR }),
      root,
      'the notify pair gates on notify.mjs only',
    );
    strictEqual(
      await discoverRuntimePluginRoot({ env, home, selfUrl: NEUTRAL_SELF }),
      null,
      'the footer pair must not resolve a runtime without footer.mjs',
    );
  });

  it('capability independence: a footer-only runtime serves the footer ladder, never the notify ladder', async () => {
    const root = await mkRuntimeRoot(await tmp('frt-footeronly-'), { withNotify: false });
    const home = await NO_HOME();
    const env = { AGENTIC_RUNTIME_ROOT: root };
    strictEqual(await discoverRuntimePluginRoot({ env, home, selfUrl: NEUTRAL_SELF }), root);
    strictEqual(
      await discoverRuntimePluginRoot({ env, home, selfUrl: NEUTRAL_SELF, ...NOTIFY_PAIR }),
      null,
      'the notify pair must not resolve a runtime without notify.mjs',
    );
  });

  it('independent floors: a 0.78.x runtime satisfies the notify floor but NOT the footer floor', async () => {
    // The exact half-open window the dual floors exist for: notify keeps
    // emitting against a pre-S2 runtime while the footer fail-closes (a
    // pre-S2 runtime would render the unsupported-kind degradation text).
    const root = await mkRuntimeRoot(await tmp('frt-window-'), { version: '0.78.1' });
    const home = await NO_HOME();
    const env = { AGENTIC_RUNTIME_ROOT: root };
    strictEqual(await discoverRuntimePluginRoot({ env, home, selfUrl: NEUTRAL_SELF, ...NOTIFY_PAIR }), root);
    strictEqual(await discoverRuntimePluginRoot({ env, home, selfUrl: NEUTRAL_SELF }), null);
    strictEqual(await runtimeVersionAtLeast(root, NOTIFY_MIN_RUNTIME_VERSION), true);
    strictEqual(await runtimeVersionAtLeast(root, MIN_RUNTIME_VERSION), false);
  });

  it('Claude cache → picks the latest SemVer PER CAPABILITY (a newer footer-less entry is skipped)', async () => {
    const home = await tmp('frt-claude-semver-');
    const base = await mkClaudeCache(home, [
      { version: '0.80.0', withFooter: false }, // newer but footer-less
      { version: '0.79.0' },
      { version: '0.9.0' },
    ]);
    strictEqual(
      await discoverRuntimePluginRoot({ env: {}, home, selfUrl: NEUTRAL_SELF }),
      join(base, '0.79.0'),
      'the footer ladder must skip the newer footer-less entry',
    );
    strictEqual(
      await discoverRuntimePluginRoot({ env: {}, home, selfUrl: NEUTRAL_SELF, ...NOTIFY_PAIR }),
      join(base, '0.80.0'),
      'the notify ladder still sees the newer entry (it carries notify.mjs)',
    );
  });

  it('Codex fixed cache → returns it when no Claude cache exists', async () => {
    const home = await tmp('frt-codex-');
    const codexRoot = await mkCodexCache(home);
    strictEqual(
      await discoverRuntimePluginRoot({ env: {}, home, selfUrl: NEUTRAL_SELF }),
      codexRoot,
    );
  });

  it('same-host preference: Codex selfUrl prefers the Codex cache over a Claude cache', async () => {
    const home = await tmp('frt-samehost-codex-');
    await mkClaudeCache(home, [{ version: '0.80.0' }]);
    const codexRoot = await mkCodexCache(home);
    const got = await discoverRuntimePluginRoot({
      env: {},
      home,
      selfUrl: 'file:///Users/x/.codex/.tmp/marketplaces/agentic-plugins/plugins/founder/scripts/discover-runtime.mjs',
    });
    strictEqual(got, codexRoot, 'Codex-host self should prefer the Codex cache');
  });

  it('sibling monorepo fallback → resolves <founder>/../runtime when no env/cache', async () => {
    const mono = await tmp('frt-sibling-');
    const founderScripts = join(mono, 'plugins', 'founder', 'scripts');
    await mkdir(founderScripts, { recursive: true });
    const selfFile = join(founderScripts, 'discover-runtime.mjs');
    await writeFile(selfFile, '// self\n');
    const runtimeRoot = await mkRuntimeRoot(join(mono, 'plugins', 'runtime'));
    const home = await NO_HOME();
    strictEqual(
      await discoverRuntimePluginRoot({ env: {}, home, selfUrl: pathToFileURL(selfFile).href }),
      runtimeRoot,
    );
  });

  it('missing runtime (no env, empty home, no sibling) → null (fail-closed)', async () => {
    const home = await NO_HOME();
    strictEqual(
      await discoverRuntimePluginRoot({ env: {}, home, selfUrl: NEUTRAL_SELF }),
      null,
    );
  });

  it('too-old runtime → null (gated), even though resolve() finds it (no stale-cache fallback)', async () => {
    const oldRoot = await mkRuntimeRoot(await tmp('frt-old-'), { version: '0.10.0' });
    const home = await NO_HOME();
    const env = { AGENTIC_RUNTIME_ROOT: oldRoot };
    strictEqual(await resolveRuntimePluginRoot({ env, home, selfUrl: NEUTRAL_SELF }), oldRoot);
    strictEqual(await discoverRuntimePluginRoot({ env, home, selfUrl: NEUTRAL_SELF }), null);
    strictEqual(await discoverRuntimePluginRoot({ env, home, selfUrl: NEUTRAL_SELF, ...NOTIFY_PAIR }), null);
  });

  it('a prerelease of the footer floor (0.79.0-beta.1) does NOT satisfy the gate', async () => {
    const preRoot = await mkRuntimeRoot(await tmp('frt-pre-'), { version: '0.79.0-beta.1' });
    const home = await NO_HOME();
    const env = { AGENTIC_RUNTIME_ROOT: preRoot };
    strictEqual(await resolveRuntimePluginRoot({ env, home, selfUrl: NEUTRAL_SELF }), preRoot, 'resolve() (ungated) finds it');
    strictEqual(await discoverRuntimePluginRoot({ env, home, selfUrl: NEUTRAL_SELF }), null, 'gate rejects a prerelease of the floor');
    // a prerelease ABOVE the floor is still fine.
    const preAbove = await mkRuntimeRoot(await tmp('frt-pre2-'), { version: '0.80.0-rc.1' });
    strictEqual(await runtimeVersionAtLeast(preAbove, MIN_RUNTIME_VERSION), true);
  });

  it('exactly at each floor passes its own gate', async () => {
    const home = await NO_HOME();
    const atFooterFloor = await mkRuntimeRoot(await tmp('frt-floor-'), { version: MIN_RUNTIME_VERSION });
    strictEqual(
      await discoverRuntimePluginRoot({ env: { AGENTIC_RUNTIME_ROOT: atFooterFloor }, home, selfUrl: NEUTRAL_SELF }),
      atFooterFloor,
    );
    const atNotifyFloor = await mkRuntimeRoot(await tmp('frt-floor2-'), { version: NOTIFY_MIN_RUNTIME_VERSION });
    strictEqual(
      await discoverRuntimePluginRoot({ env: { AGENTIC_RUNTIME_ROOT: atNotifyFloor }, home, selfUrl: NEUTRAL_SELF, ...NOTIFY_PAIR }),
      atNotifyFloor,
    );
  });
});
