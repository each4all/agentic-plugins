// The consumer-side companion bootstraps: the four persona/orchestrator
// `dispatch-peer.mjs` copies (`resolveCompanion`) and image's
// `compose-dispatch.mjs` (`findCompanionsScriptsDir`).
//
// ADR-0061 §Decision 3, as S1 of its implementation manifest applies it:
//   - the Codex candidate is the versioned install cache under $CODEX_HOME;
//     the marketplace clone (`.tmp/marketplaces`) is never a candidate, not
//     even as a last resort;
//   - a caller running from a Codex install tries the Codex cache first and
//     uses the Claude cache only when Codex has no companions installed, and
//     it says so (`crossHostFallback`); a Claude-installed caller mirrors that;
//   - which install the caller runs from is decided against the resolved
//     cache roots, so a custom CODEX_HOME counts and a stray '/.codex/' path
//     segment does not;
//   - an installed companions plugin that cannot serve (no discovery
//     library, or no companion passing preflight) fails closed rather than
//     crossing hosts;
//   - there is no implicit repository rung: a checkout's companions take an
//     explicit AGENTIC_COMPANIONS_ROOT.
//
// The four dispatch-peer copies are deliberate copies (ADR-0010 §5), so each
// one is exercised rather than one standing in for the rest.

import { describe, it, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, rm, symlink, realpath } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const LIBRARY = join(REPO_ROOT, 'companions', 'discover-peer.mjs');

const COMPANION_BODY = "const CONTRACT_VERSION = '0.1.1';\nconst FLAGS = ['prompt-file'];\n";
const INCOMPATIBLE_BODY = "const CONTRACT_VERSION = '1.0.0';\nconst FLAGS = ['prompt-file'];\n";
const CODEX_MANIFEST = join('.codex-plugin', 'plugin.json');
const CLAUDE_MANIFEST = join('.claude-plugin', 'plugin.json');

// Each consumer's repository-sibling rung, relative to its own scripts/ dir.
const DISPATCHERS = [
  { plugin: 'engineer', devRel: ['..', '..', 'companions'] },
  { plugin: 'founder', devRel: ['..', '..', 'companions'] },
  { plugin: 'designer', devRel: ['..', '..', 'companions'] },
  { plugin: 'orchestrator', devRel: ['..', '..', '..', 'plugins', 'companions'] },
];

const claudeCacheRoot = (home) => join(home, '.claude', 'plugins', 'cache');
const codexCacheRoot = (codexHome) => join(codexHome, 'plugins', 'cache');
const companionsIn = (cacheRoot) => join(cacheRoot, 'agentic-plugins', 'companions');

async function plantCompanions(base, version, {
  manifestRel,
  name = 'companions',
  body = COMPANION_BODY,
} = {}) {
  const root = join(base, version);
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(dirname(join(root, manifestRel)), { recursive: true });
  await writeFile(join(root, manifestRel), JSON.stringify({ name, version }));
  await copyFile(LIBRARY, join(root, 'scripts', 'discover-peer.mjs'));
  for (const file of ['claude-companion.mjs', 'codex-companion.mjs']) {
    await writeFile(join(root, 'scripts', file), body);
  }
  return root;
}

async function plantClone(codexHome) {
  const clone = join(codexHome, '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'companions');
  await mkdir(join(clone, 'scripts'), { recursive: true });
  await mkdir(join(clone, '.codex-plugin'), { recursive: true });
  await writeFile(join(clone, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'companions', version: '99.0.0' }));
  await copyFile(LIBRARY, join(clone, 'scripts', 'discover-peer.mjs'));
  for (const file of ['claude-companion.mjs', 'codex-companion.mjs']) {
    await writeFile(join(clone, 'scripts', file), COMPANION_BODY);
  }
  return clone;
}

// Where an installed copy of `plugin` would live, for the `selfPath` seam.
const installedSelf = (cacheRoot, plugin, file) =>
  join(cacheRoot, 'agentic-plugins', plugin, '9.9.9', 'scripts', file);

let scratch;
let seq = 0;
async function freshHomes() {
  seq += 1;
  const home = join(scratch, `home-${seq}`);
  const codexHome = join(scratch, `codex-home-${seq}`);
  await mkdir(home, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  return { home, codexHome, env: { CODEX_HOME: codexHome } };
}

before(async () => {
  // Canonical, so a planted path equals the canonical path a bootstrap returns
  // (macOS tmpdir sits behind /var -> /private/var).
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'companion-bootstrap-')));
});
after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

for (const { plugin, devRel } of DISPATCHERS) {
  describe(`plugins/${plugin}/scripts/dispatch-peer.mjs — resolveCompanion (ADR-0061 S1)`, () => {
    let resolveCompanion;
    let resolveCompanionPath;
    let dispatchPeer;
    before(async () => {
      ({ resolveCompanion, resolveCompanionPath, dispatchPeer } = await import(
        join(REPO_ROOT, 'plugins', plugin, 'scripts', 'dispatch-peer.mjs')
      ));
    });

    it('a Codex-installed caller resolves from the Codex cache under a custom CODEX_HOME, over a newer Claude copy', async () => {
      const { home, codexHome, env } = await freshHomes();
      const codexRoot = await plantCompanions(companionsIn(codexCacheRoot(codexHome)), '0.5.0', { manifestRel: CODEX_MANIFEST });
      await plantCompanions(companionsIn(claudeCacheRoot(home)), '0.9.0', { manifestRel: CLAUDE_MANIFEST });
      const selfPath = installedSelf(codexCacheRoot(codexHome), plugin, 'dispatch-peer.mjs');
      const got = await resolveCompanion('claude', { env, home, selfPath });
      strictEqual(got.path, join(codexRoot, 'scripts', 'claude-companion.mjs'));
      strictEqual(got.host, 'codex');
      strictEqual(got.callerHost, 'codex');
      strictEqual(got.crossHostFallback, false);
      strictEqual(got.source, 'codex-cache');
    });

    it('a Claude-installed caller resolves from the Claude cache, over a newer Codex copy', async () => {
      const { home, codexHome, env } = await freshHomes();
      await plantCompanions(companionsIn(codexCacheRoot(codexHome)), '0.9.0', { manifestRel: CODEX_MANIFEST });
      const claudeRoot = await plantCompanions(companionsIn(claudeCacheRoot(home)), '0.4.1', { manifestRel: CLAUDE_MANIFEST });
      const selfPath = installedSelf(claudeCacheRoot(home), plugin, 'dispatch-peer.mjs');
      const got = await resolveCompanion('codex', { env, home, selfPath });
      strictEqual(got.path, join(claudeRoot, 'scripts', 'codex-companion.mjs'));
      strictEqual(got.host, 'claude');
      strictEqual(got.callerHost, 'claude');
      strictEqual(got.crossHostFallback, false);
    });

    it("a CODEX_HOME path containing '#' still resolves (the library is imported by file URL)", async () => {
      const { home } = await freshHomes();
      const codexHome = join(scratch, `codex#home-${seq}`);
      const codexRoot = await plantCompanions(companionsIn(codexCacheRoot(codexHome)), '0.5.0', { manifestRel: CODEX_MANIFEST });
      const selfPath = installedSelf(codexCacheRoot(codexHome), plugin, 'dispatch-peer.mjs');
      const got = await resolveCompanion('claude', { env: { CODEX_HOME: codexHome }, home, selfPath });
      strictEqual(got.path, join(codexRoot, 'scripts', 'claude-companion.mjs'));
    });

    it('takes the newest manifest-verified version among several retained Codex versions', async () => {
      const { home, codexHome, env } = await freshHomes();
      const base = companionsIn(codexCacheRoot(codexHome));
      await plantCompanions(base, '0.4.0', { manifestRel: CODEX_MANIFEST });
      const newest = await plantCompanions(base, '0.4.2', { manifestRel: CODEX_MANIFEST });
      await plantCompanions(base, '0.7.0', { manifestRel: CODEX_MANIFEST, name: 'runtime' });
      const selfPath = installedSelf(codexCacheRoot(codexHome), plugin, 'dispatch-peer.mjs');
      const got = await resolveCompanion('claude', { env, home, selfPath });
      strictEqual(got.path, join(newest, 'scripts', 'claude-companion.mjs'));
    });

    it('falls back to the Claude cache only when Codex has no companions installed, and reports it — never the clone', async () => {
      const { home, codexHome, env } = await freshHomes();
      await plantClone(codexHome);
      const claudeRoot = await plantCompanions(companionsIn(claudeCacheRoot(home)), '0.4.1', { manifestRel: CLAUDE_MANIFEST });
      const selfPath = installedSelf(codexCacheRoot(codexHome), plugin, 'dispatch-peer.mjs');
      const got = await resolveCompanion('claude', { env, home, selfPath });
      strictEqual(got.path, join(claudeRoot, 'scripts', 'claude-companion.mjs'));
      strictEqual(got.host, 'claude');
      strictEqual(got.callerHost, 'codex');
      strictEqual(got.crossHostFallback, true);
    });

    it('resolves nothing when the marketplace clone is the only copy', async () => {
      const { home, codexHome, env } = await freshHomes();
      await plantClone(codexHome);
      const selfPath = installedSelf(codexCacheRoot(codexHome), plugin, 'dispatch-peer.mjs');
      const got = await resolveCompanion('claude', { env, home, selfPath });
      strictEqual(got.path, null);
      strictEqual(await resolveCompanionPath('claude', { env, home, selfPath }), null);
    });

    it('an installed but unusable Codex companion fails closed instead of crossing to the Claude cache', async () => {
      const { home, codexHome, env } = await freshHomes();
      await plantCompanions(companionsIn(codexCacheRoot(codexHome)), '0.5.0', {
        manifestRel: CODEX_MANIFEST,
        body: INCOMPATIBLE_BODY,
      });
      await plantCompanions(companionsIn(claudeCacheRoot(home)), '0.4.1', { manifestRel: CLAUDE_MANIFEST });
      const selfPath = installedSelf(codexCacheRoot(codexHome), plugin, 'dispatch-peer.mjs');
      const got = await resolveCompanion('claude', { env, home, selfPath });
      strictEqual(got.path, null);
      strictEqual(got.host, 'codex');
      ok(got.reason, 'a failure carries its reason');
    });

    it('an installed caller never takes the repository-sibling rung (the caller may be run from inside a checkout)', async () => {
      const { home, codexHome, env } = await freshHomes();
      const selfPath = installedSelf(codexCacheRoot(codexHome), plugin, 'dispatch-peer.mjs');
      // No host cache has companions, so the ladder reaches the point where a
      // checkout caller would try its repository rung. The trap sits exactly
      // where this module's repository rung looks.
      const trap = resolve(dirname(selfPath), ...devRel);
      await plantCompanions(dirname(trap), 'companions', { manifestRel: CODEX_MANIFEST });
      const got = await resolveCompanion('claude', { env, home, selfPath });
      strictEqual(got.source, null, `an installed caller took the ${got.source} rung`);
      strictEqual(got.path, null);
      strictEqual(got.callerHost, 'codex');
    });

    it('a symlinked CODEX_HOME still identifies a Codex-installed caller', async () => {
      const { home, codexHome } = await freshHomes();
      const link = join(scratch, `codex-link-${seq}`);
      await symlink(codexHome, link);
      const codexRoot = await plantCompanions(companionsIn(codexCacheRoot(codexHome)), '0.5.0', { manifestRel: CODEX_MANIFEST });
      await plantCompanions(companionsIn(claudeCacheRoot(home)), '0.9.0', { manifestRel: CLAUDE_MANIFEST });
      // Node reports a module's real path; CODEX_HOME names the link.
      const selfPath = installedSelf(codexCacheRoot(await realpath(codexHome)), plugin, 'dispatch-peer.mjs');
      const got = await resolveCompanion('claude', { env: { CODEX_HOME: link }, home, selfPath });
      strictEqual(got.callerHost, 'codex');
      strictEqual(got.host, 'codex');
      // Canonical, not the link spelling: the companion's CLI entry guard
      // compares argv[1] with Node's canonical module path and silently does
      // nothing through a symlink.
      strictEqual(got.path, join(codexRoot, 'scripts', 'claude-companion.mjs'));
    });

    it('a checkout caller has no implicit repository rung, even when the checkout holds an older library', async () => {
      const { home, codexHome, env } = await freshHomes();
      const clone = await plantClone(codexHome);
      const selfPath = join(scratch, `checkout-${plugin}-${seq}`, 'plugins', plugin, 'scripts', 'dispatch-peer.mjs');
      // A pre-ADR-0061 library resolves peer=claude from the clone by default.
      const devRoot = resolve(dirname(selfPath), ...devRel);
      await mkdir(join(devRoot, 'scripts'), { recursive: true });
      await writeFile(
        join(devRoot, 'scripts', 'discover-peer.mjs'),
        `export async function discoverPeerCompanion() {\n  return { ok: true, path: ${JSON.stringify(join(clone, 'scripts', 'claude-companion.mjs'))} };\n}\n`,
      );
      const got = await resolveCompanion('claude', { env, home, selfPath });
      strictEqual(got.callerHost, 'checkout');
      strictEqual(got.source, null);
      strictEqual(got.path, null);
    });

    it('an installed companions plugin without a discovery library fails closed instead of crossing hosts', async () => {
      const { home, codexHome, env } = await freshHomes();
      const base = companionsIn(codexCacheRoot(codexHome));
      await mkdir(join(base, '0.2.0', '.codex-plugin'), { recursive: true });
      await writeFile(join(base, '0.2.0', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'companions', version: '0.2.0' }));
      await plantCompanions(companionsIn(claudeCacheRoot(home)), '0.4.1', { manifestRel: CLAUDE_MANIFEST });
      const selfPath = installedSelf(codexCacheRoot(codexHome), plugin, 'dispatch-peer.mjs');
      const got = await resolveCompanion('claude', { env, home, selfPath });
      strictEqual(got.path, null);
      strictEqual(got.host, 'codex');
      ok(/discover-peer\.mjs/.test(got.reason), got.reason);
    });

    it('a raw dispatch reports a cross-host fallback on stderr', async () => {
      const { home, codexHome, env } = await freshHomes();
      await plantCompanions(companionsIn(claudeCacheRoot(home)), '0.4.1', { manifestRel: CLAUDE_MANIFEST });
      const selfPath = installedSelf(codexCacheRoot(codexHome), plugin, 'dispatch-peer.mjs');
      const lines = [];
      const write = process.stderr.write;
      process.stderr.write = function capture(chunk, ...rest) {
        if (String(chunk).startsWith('dispatch-peer:')) {
          lines.push(String(chunk));
          return true;
        }
        return write.call(this, chunk, ...rest);
      };
      try {
        // The fake companion only declares constants, so the spawn is inert.
        await dispatchPeer({
          peer: 'claude',
          promptText: '<task>x</task>',
          env: { ...env, PATH: process.env.PATH },
          home,
          selfPath,
          cwd: scratch,
        });
      } finally {
        process.stderr.write = write;
      }
      ok(lines.some((l) => /resolved from the claude plugin cache because the codex cache has no companions installed/.test(l)), lines.join(''));
    });

    it('decides the caller host from the resolved CODEX_HOME, not from a /.codex/ path segment', async () => {
      const { home, codexHome, env } = await freshHomes();
      await plantCompanions(companionsIn(codexCacheRoot(codexHome)), '0.9.0', { manifestRel: CODEX_MANIFEST });
      const claudeRoot = await plantCompanions(companionsIn(claudeCacheRoot(home)), '0.4.1', { manifestRel: CLAUDE_MANIFEST });
      // Under ~/.codex/plugins/cache, but CODEX_HOME points elsewhere.
      const selfPath = installedSelf(codexCacheRoot(join(home, '.codex')), plugin, 'dispatch-peer.mjs');
      const got = await resolveCompanion('codex', { env, home, selfPath });
      strictEqual(got.callerHost, 'checkout');
      strictEqual(got.path, join(claudeRoot, 'scripts', 'codex-companion.mjs'));
    });
  });
}

describe('plugins/image/scripts/compose-dispatch.mjs — companion lookup (ADR-0061 S1)', () => {
  let findCompanionsScriptsDir;
  let findCodexCompanion;
  before(async () => {
    ({ findCompanionsScriptsDir, findCodexCompanion } = await import(
      join(REPO_ROOT, 'plugins', 'image', 'scripts', 'compose-dispatch.mjs')
    ));
  });

  it('a Codex-installed caller takes the Codex cache under a custom CODEX_HOME first', async () => {
    const { home, codexHome, env } = await freshHomes();
    const codexRoot = await plantCompanions(companionsIn(codexCacheRoot(codexHome)), '0.5.0', { manifestRel: CODEX_MANIFEST });
    await plantCompanions(companionsIn(claudeCacheRoot(home)), '0.9.0', { manifestRel: CLAUDE_MANIFEST });
    const selfPath = installedSelf(codexCacheRoot(codexHome), 'image', 'compose-dispatch.mjs');
    strictEqual(findCompanionsScriptsDir(env, { home, selfPath }), join(codexRoot, 'scripts'));
    // The companion comes from the same cache as the library, not from the
    // library's own default for peer=codex (the Claude cache).
    strictEqual(await findCodexCompanion(env, { home, selfPath }), join(codexRoot, 'scripts', 'codex-companion.mjs'));
  });

  it('resolves the companion when only the Codex cache has companions installed', async () => {
    const { home, codexHome, env } = await freshHomes();
    const codexRoot = await plantCompanions(companionsIn(codexCacheRoot(codexHome)), '0.5.0', { manifestRel: CODEX_MANIFEST });
    const selfPath = installedSelf(codexCacheRoot(codexHome), 'image', 'compose-dispatch.mjs');
    strictEqual(await findCodexCompanion(env, { home, selfPath }), join(codexRoot, 'scripts', 'codex-companion.mjs'));
  });

  it('reports a cross-host fallback on stderr', async () => {
    const { home, codexHome, env } = await freshHomes();
    const claudeRoot = await plantCompanions(companionsIn(claudeCacheRoot(home)), '0.4.1', { manifestRel: CLAUDE_MANIFEST });
    const selfPath = installedSelf(codexCacheRoot(codexHome), 'image', 'compose-dispatch.mjs');
    const lines = [];
    const write = process.stderr.write;
    process.stderr.write = function capture(chunk, ...rest) {
      if (String(chunk).startsWith('image:')) {
        lines.push(String(chunk));
        return true;
      }
      return write.call(this, chunk, ...rest);
    };
    let got;
    try {
      got = await findCodexCompanion(env, { home, selfPath });
    } finally {
      process.stderr.write = write;
    }
    strictEqual(got, join(claudeRoot, 'scripts', 'codex-companion.mjs'));
    ok(lines.some((l) => /resolved from the claude plugin cache because the codex cache has no companions installed/.test(l)), lines.join(''));
  });

  it('a symlinked CODEX_HOME still identifies a Codex-installed caller', async () => {
    const { home, codexHome } = await freshHomes();
    const link = join(scratch, `image-codex-link-${seq}`);
    await symlink(codexHome, link);
    const codexRoot = await plantCompanions(companionsIn(codexCacheRoot(codexHome)), '0.5.0', { manifestRel: CODEX_MANIFEST });
    await plantCompanions(companionsIn(claudeCacheRoot(home)), '0.9.0', { manifestRel: CLAUDE_MANIFEST });
    const selfPath = installedSelf(codexCacheRoot(await realpath(codexHome)), 'image', 'compose-dispatch.mjs');
    const got = await findCodexCompanion({ CODEX_HOME: link }, { home, selfPath });
    // Canonical, not the link spelling (the companion's entry guard).
    strictEqual(got, join(codexRoot, 'scripts', 'codex-companion.mjs'));
  });

  it('a Claude-installed caller takes the Claude cache first, skipping a directory whose manifest is not companions', async () => {
    const { home, codexHome, env } = await freshHomes();
    await plantCompanions(companionsIn(codexCacheRoot(codexHome)), '0.9.0', { manifestRel: CODEX_MANIFEST });
    const base = companionsIn(claudeCacheRoot(home));
    const claudeRoot = await plantCompanions(base, '0.4.1', { manifestRel: CLAUDE_MANIFEST });
    await plantCompanions(base, '0.8.0', { manifestRel: CLAUDE_MANIFEST, name: 'image' });
    const selfPath = installedSelf(claudeCacheRoot(home), 'image', 'compose-dispatch.mjs');
    strictEqual(findCompanionsScriptsDir(env, { home, selfPath }), join(claudeRoot, 'scripts'));
  });

  it('an installed companions plugin without a discovery library fails closed instead of crossing hosts', async () => {
    const { home, codexHome, env } = await freshHomes();
    const base = companionsIn(codexCacheRoot(codexHome));
    await mkdir(join(base, '0.2.0', '.codex-plugin'), { recursive: true });
    await writeFile(join(base, '0.2.0', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'companions', version: '0.2.0' }));
    await plantCompanions(companionsIn(claudeCacheRoot(home)), '0.4.1', { manifestRel: CLAUDE_MANIFEST });
    const selfPath = installedSelf(codexCacheRoot(codexHome), 'image', 'compose-dispatch.mjs');
    strictEqual(findCompanionsScriptsDir(env, { home, selfPath }), null);
    strictEqual(await findCodexCompanion(env, { home, selfPath }), null);
  });

  it('never returns the marketplace clone', async () => {
    const { home, codexHome, env } = await freshHomes();
    await plantClone(codexHome);
    const selfPath = installedSelf(codexCacheRoot(codexHome), 'image', 'compose-dispatch.mjs');
    strictEqual(findCompanionsScriptsDir(env, { home, selfPath }), null);
    strictEqual(await findCodexCompanion(env, { home, selfPath }), null);
  });
});
