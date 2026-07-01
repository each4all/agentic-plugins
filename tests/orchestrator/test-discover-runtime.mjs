// ADR-0039 §5 — orchestrator discoverRuntimePluginRoot resolver tests.
//
// Mirrors the discover-engineer.mjs ladder (env → Claude-cache SemVer →
// Codex-fixed-cache → sibling-monorepo), inverted for the runtime peer and
// version-gated. Proves each rung + the fail-closed "missing / too-old"
// contract (no fall-back to a stale cache). Host-free + deterministic: every
// case injects env/home/selfUrl and builds throwaway fixtures. This is the
// per-plugin copy of the engineer resolver (ADR-0039 §5 copy-not-import), so the
// test matrix mirrors tests/engineer/test-discover-runtime.mjs. Run via
// `node --test tests/orchestrator/test-discover-runtime.mjs`.

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
  MIN_RUNTIME_VERSION,
} from '../../plugins/orchestrator/scripts/discover-runtime.mjs';

// Build a runtime plugin root at `root` with a manifest + a footer.mjs stub.
async function mkRuntimeRoot(root, { version = '0.70.0', name = 'runtime', withFooter = true } = {}) {
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version }));
  if (withFooter) {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts', 'footer.mjs'), '// stub footer\n');
  }
  return root;
}

// Build the Claude cache layout `<home>/.claude/plugins/cache/agentic-plugins/runtime/<version>/`.
async function mkClaudeCache(home, versions) {
  const base = join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'runtime');
  for (const v of versions) {
    await mkRuntimeRoot(join(base, v), { version: v });
  }
  return base;
}

// Build the Codex fixed cache `<home>/.codex/.tmp/marketplaces/agentic-plugins/plugins/runtime/`.
async function mkCodexCache(home, { version = '0.70.0' } = {}) {
  const root = join(home, '.codex', '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'runtime');
  await mkRuntimeRoot(root, { version });
  return root;
}

async function tmp(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

const NO_HOME = () => tmp('rt-emptyhome-'); // a home with no caches
const NEUTRAL_SELF = 'file:///nowhere/scripts/discover-runtime.mjs'; // no /.claude/ or /.codex/, no sibling

describe('discoverRuntimePluginRoot — orchestrator copy (ADR-0039 §5)', () => {
  it('env override (valid) → returns the root', async () => {
    const root = await mkRuntimeRoot(await tmp('rt-env-ok-'));
    const home = await NO_HOME();
    strictEqual(
      await discoverRuntimePluginRoot({ env: { AGENTIC_RUNTIME_ROOT: root }, home, selfUrl: NEUTRAL_SELF }),
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

  it('env override (invalid — no scripts/footer.mjs) → null', async () => {
    const root = await mkRuntimeRoot(await tmp('rt-env-nofooter-'), { withFooter: false });
    const home = await NO_HOME();
    strictEqual(
      await discoverRuntimePluginRoot({ env: { AGENTIC_RUNTIME_ROOT: root }, home, selfUrl: NEUTRAL_SELF }),
      null,
    );
  });

  it('Claude cache → picks the latest SemVer (not lexical)', async () => {
    const home = await tmp('rt-claude-semver-');
    const base = await mkClaudeCache(home, ['0.63.0', '0.9.0', '0.70.0', '0.64.0']);
    strictEqual(
      await discoverRuntimePluginRoot({ env: {}, home, selfUrl: NEUTRAL_SELF }),
      join(base, '0.70.0'),
    );
  });

  it('Codex fixed cache → returns it when no Claude cache exists', async () => {
    const home = await tmp('rt-codex-');
    const codexRoot = await mkCodexCache(home);
    strictEqual(
      await discoverRuntimePluginRoot({ env: {}, home, selfUrl: NEUTRAL_SELF }),
      codexRoot,
    );
  });

  it('same-host preference: Codex selfUrl prefers the Codex cache over a Claude cache', async () => {
    const home = await tmp('rt-samehost-codex-');
    const claudeBase = await mkClaudeCache(home, ['0.70.0']);
    const codexRoot = await mkCodexCache(home);
    const got = await discoverRuntimePluginRoot({
      env: {},
      home,
      selfUrl: 'file:///Users/x/.codex/.tmp/marketplaces/agentic-plugins/plugins/orchestrator/scripts/discover-runtime.mjs',
    });
    strictEqual(got, codexRoot, 'Codex-host self should prefer the Codex cache');
    // sanity: the Claude cache is present but not chosen
    strictEqual(got !== join(claudeBase, '0.70.0'), true);
  });

  it('same-host preference: Claude selfUrl prefers the Claude cache over a Codex cache', async () => {
    const home = await tmp('rt-samehost-claude-');
    const claudeBase = await mkClaudeCache(home, ['0.70.0']);
    await mkCodexCache(home);
    const got = await discoverRuntimePluginRoot({
      env: {},
      home,
      selfUrl: 'file:///Users/x/.claude/plugins/cache/agentic-plugins/orchestrator/0.10.0/scripts/discover-runtime.mjs',
    });
    strictEqual(got, join(claudeBase, '0.70.0'), 'Claude-host self should prefer the Claude cache');
  });

  it('sibling monorepo fallback → resolves <orchestrator>/../runtime when no env/cache', async () => {
    // Build <tmp>/plugins/orchestrator/scripts/discover-runtime.mjs (selfUrl) and
    // <tmp>/plugins/runtime/scripts/footer.mjs (the sibling target).
    const mono = await tmp('rt-sibling-');
    const orchScripts = join(mono, 'plugins', 'orchestrator', 'scripts');
    await mkdir(orchScripts, { recursive: true });
    const selfFile = join(orchScripts, 'discover-runtime.mjs');
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
    const oldRoot = await mkRuntimeRoot(await tmp('rt-old-'), { version: '0.10.0' });
    const home = await NO_HOME();
    const env = { AGENTIC_RUNTIME_ROOT: oldRoot };
    // resolve() (ungated) finds it; discover() (gated) rejects it.
    strictEqual(await resolveRuntimePluginRoot({ env, home, selfUrl: NEUTRAL_SELF }), oldRoot);
    strictEqual(await discoverRuntimePluginRoot({ env, home, selfUrl: NEUTRAL_SELF }), null);
    strictEqual(await runtimeVersionAtLeast(oldRoot), false);
  });

  it('too-old Claude cache → null (does not fall back to an older-but-present copy)', async () => {
    const home = await tmp('rt-old-cache-');
    await mkClaudeCache(home, ['0.10.0', '0.20.0']); // both below MIN
    strictEqual(
      await discoverRuntimePluginRoot({ env: {}, home, selfUrl: NEUTRAL_SELF }),
      null,
    );
  });

  it('a prerelease of the floor (0.63.0-beta.1) does NOT satisfy the gate → null (Codex Plan-verify MINOR)', async () => {
    const preRoot = await mkRuntimeRoot(await tmp('rt-pre-'), { version: '0.63.0-beta.1' });
    const home = await NO_HOME();
    const env = { AGENTIC_RUNTIME_ROOT: preRoot };
    strictEqual(await resolveRuntimePluginRoot({ env, home, selfUrl: NEUTRAL_SELF }), preRoot, 'resolve() (ungated) finds it');
    strictEqual(await discoverRuntimePluginRoot({ env, home, selfUrl: NEUTRAL_SELF }), null, 'gate rejects a prerelease of the floor');
    strictEqual(await runtimeVersionAtLeast(preRoot), false);
    // a prerelease ABOVE the floor is still fine.
    const preAbove = await mkRuntimeRoot(await tmp('rt-pre2-'), { version: '0.64.0-rc.1' });
    strictEqual(await runtimeVersionAtLeast(preAbove), true, '0.64.0-rc.1 core exceeds the 0.63.0 floor');
  });

  it('MIN_RUNTIME_VERSION is the ADR-0031 projection-file floor (0.63.0)', async () => {
    strictEqual(MIN_RUNTIME_VERSION, '0.63.0');
    const home = await NO_HOME();
    const atFloor = await mkRuntimeRoot(await tmp('rt-floor-'), { version: '0.63.0' });
    strictEqual(
      await discoverRuntimePluginRoot({ env: { AGENTIC_RUNTIME_ROOT: atFloor }, home, selfUrl: NEUTRAL_SELF }),
      atFloor,
      'exactly at the floor must pass',
    );
  });
});
