// ADR-0043 §2/§4 — discoverRuntimePluginRoot tests, run once for every persona
// the persona-pipeline manifest generates scripts/discover-runtime.mjs into
// (ADR-0066 Decision 5). Persona values come from personaInfo().
//
// The persona's resolver serves one consumer, the completion footer: the
// default pair is minRuntimeVersion() (the persona's declared
// runtime_footer_floor, ADR-0066 V18) and scripts/footer.mjs. (The ADR-0040 §5
// peer-run notification pair was removed by ADR-0064.)
// Proves each ladder rung, the fail-closed "missing / too-old" contract (no
// stale-cache fallback), and that the gate is scripts/footer.mjs.
// The ADR-0061 §Decision 3 rules every copy shares (custom CODEX_HOME, the
// clone never a candidate, cross-host fallback reported, no sibling for an
// installed caller) are pinned across all copies in
// tests/plugin-shape/test-installed-sibling-resolvers.mjs.
// Host-free + deterministic: every case injects env/home/selfUrl and builds
// throwaway fixtures. Run via `node --test tests/persona-pipeline/test-discover-runtime.mjs`.

import { describe, it } from 'node:test';
import { strictEqual } from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { personasFor, personaInfo } from './_personas.mjs';

// Build a runtime plugin root at `root` with a manifest + capability stubs.
async function mkRuntimeRoot(root, {
  version = '0.80.0',
  name = 'runtime',
  withFooter = true,
  manifestDir = '.claude-plugin',
} = {}) {
  await mkdir(join(root, manifestDir), { recursive: true });
  await writeFile(join(root, manifestDir, 'plugin.json'), JSON.stringify({ name, version }));
  await mkdir(join(root, 'scripts'), { recursive: true });
  if (withFooter) await writeFile(join(root, 'scripts', 'footer.mjs'), '// stub footer\n');
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

// Build the Codex install cache `<home>/.codex/plugins/cache/agentic-plugins/runtime/<version>/`.
async function mkCodexCache(home, spec = {}) {
  const version = spec.version ?? '0.80.0';
  const root = join(home, '.codex', 'plugins', 'cache', 'agentic-plugins', 'runtime', version);
  await mkRuntimeRoot(root, { ...spec, version, manifestDir: '.codex-plugin' });
  return root;
}

// Canonical: the resolvers return canonical roots (ADR-0061 S2), and macOS
// tmpdir sits behind /var -> /private/var.
async function tmp(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

const NEUTRAL_SELF = 'file:///nowhere/scripts/discover-runtime.mjs'; // no /.claude/ or /.codex/, no sibling

// Versions around a persona's footer floor, so each case holds for every
// declared floor (engineer 0.63.0, founder and designer 0.79.0): the patch
// release just below it, the next minor above it, and their prereleases.
function aroundFloor(floor) {
  const [major, minor] = floor.split('.').map(Number);
  if (minor === 0) throw new Error(`aroundFloor needs a floor with a minor above 0, got ${floor}`);
  return Object.freeze({
    justBelow: `${major}.${minor - 1}.1`,
    farBelow: '0.10.0',
    above: `${major}.${minor + 1}.0`,
    floorPrerelease: `${floor}-beta.1`,
    abovePrerelease: `${major}.${minor + 1}.0-rc.1`,
  });
}

for (const persona of personasFor('scripts/discover-runtime.mjs')) {
  const P = personaInfo(persona);
  const {
    discoverRuntimePluginRoot,
    resolveRuntimePluginRoot,
    runtimeVersionAtLeast,
    FOOTER_CAPABILITY,
    minRuntimeVersion,
  } = await import(pathToFileURL(P.path('scripts/discover-runtime.mjs')).href);

  const pfx = (label) => `${persona}-rt-${label}-`;
  const V = aroundFloor(P.runtimeFooterFloor);
  const NO_HOME = () => tmp(pfx('emptyhome')); // a home with no caches

  describe(`${persona}: discoverRuntimePluginRoot — footer floor (ADR-0043 §2/§4)`, () => {
    it('exports the documented floor + capability constants', () => {
      // The floor is the persona's declared runtime_footer_floor, read when
      // the resolver runs (ADR-0066 V18).
      strictEqual(minRuntimeVersion(), P.runtimeFooterFloor);
      // Today's literal for founder and designer: the footer floor is the
      // first RELEASED runtime containing the ADR-0043 S2 enum expansion
      // (plugin-runtime-v0.79.0). A persona enrolled later declares its own.
      if (persona === 'founder' || persona === 'designer') {
        strictEqual(minRuntimeVersion(), '0.79.0');
      }
      // engineer's floor is the ADR-0031 projection-file floor: runtime 0.63.0
      // added --workflow-projection-file, the newest render flag engineer
      // passes. No stage of ADR-0066 raises it (Decision 2).
      if (persona === 'engineer') {
        strictEqual(minRuntimeVersion(), '0.63.0');
      }
      strictEqual(FOOTER_CAPABILITY, 'footer.mjs');
    });

    it('env override (valid) → returns the root', async () => {
      const root = await mkRuntimeRoot(await tmp(pfx('env-ok')));
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

    it('a runtime without scripts/footer.mjs → null (the gate is footer.mjs)', async () => {
      const root = await mkRuntimeRoot(await tmp(pfx('nofooter')), { withFooter: false });
      const home = await NO_HOME();
      const env = { AGENTIC_RUNTIME_ROOT: root };
      strictEqual(
        await discoverRuntimePluginRoot({ env, home, selfUrl: NEUTRAL_SELF }),
        null,
        'the footer pair must not resolve a runtime without footer.mjs',
      );
    });

    it('a runtime just below the footer floor → null', async () => {
      // Below the floor the runtime cannot render this persona's footer: before
      // 0.79.0 it rejects founder's and designer's workflow kinds (ADR-0043 S2),
      // before 0.63.0 it lacks --workflow-projection-file.
      const root = await mkRuntimeRoot(await tmp(pfx('window')), { version: V.justBelow });
      const home = await NO_HOME();
      const env = { AGENTIC_RUNTIME_ROOT: root };
      strictEqual(await discoverRuntimePluginRoot({ env, home, selfUrl: NEUTRAL_SELF }), null);
      strictEqual(await runtimeVersionAtLeast(root, minRuntimeVersion()), false);
    });

    it('Claude cache → picks the latest SemVer carrying footer.mjs (a newer footer-less entry is skipped)', async () => {
      const home = await tmp(pfx('claude-semver'));
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
    });

    it('Codex install cache → returns it when no Claude cache exists', async () => {
      const home = await tmp(pfx('codex'));
      const codexRoot = await mkCodexCache(home);
      strictEqual(
        await discoverRuntimePluginRoot({ env: {}, home, selfUrl: NEUTRAL_SELF }),
        codexRoot,
      );
    });

    it('same-host preference: Codex selfUrl prefers the Codex cache over a Claude cache', async () => {
      const home = await tmp(pfx('samehost-codex'));
      await mkClaudeCache(home, [{ version: '0.80.0' }]);
      const codexRoot = await mkCodexCache(home);
      const got = await discoverRuntimePluginRoot({
        env: {},
        home,
        selfUrl: pathToFileURL(join(home, '.codex', 'plugins', 'cache', 'agentic-plugins', P.name, '0.18.0', 'scripts', 'discover-runtime.mjs')).href,
      });
      strictEqual(got, codexRoot, 'Codex-host self should prefer the Codex cache');
    });

    it('same-host preference: Claude selfUrl prefers the Claude cache over a Codex cache', async () => {
      const home = await tmp(pfx('samehost-claude'));
      const claudeBase = await mkClaudeCache(home, [{ version: '0.80.0' }]);
      await mkCodexCache(home, { version: '0.81.0' });
      const got = await discoverRuntimePluginRoot({
        env: {},
        home,
        selfUrl: pathToFileURL(join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', P.name, '0.18.0', 'scripts', 'discover-runtime.mjs')).href,
      });
      strictEqual(got, join(claudeBase, '0.80.0'), 'Claude-host self should prefer the Claude cache, even over a newer Codex one');
    });

    it('sibling monorepo fallback → resolves <persona>/../runtime when no env/cache', async () => {
      const mono = await tmp(pfx('sibling'));
      const personaScripts = join(mono, 'plugins', P.name, 'scripts');
      await mkdir(personaScripts, { recursive: true });
      const selfFile = join(personaScripts, 'discover-runtime.mjs');
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
      const oldRoot = await mkRuntimeRoot(await tmp(pfx('old')), { version: V.farBelow });
      const home = await NO_HOME();
      const env = { AGENTIC_RUNTIME_ROOT: oldRoot };
      strictEqual(await resolveRuntimePluginRoot({ env, home, selfUrl: NEUTRAL_SELF }), oldRoot);
      strictEqual(await discoverRuntimePluginRoot({ env, home, selfUrl: NEUTRAL_SELF }), null);
      // The gate's default floor is the declared one.
      strictEqual(await runtimeVersionAtLeast(oldRoot), false);
    });

    it('too-old Claude cache → null (does not fall back to an older-but-present copy)', async () => {
      const home = await tmp(pfx('old-cache'));
      await mkClaudeCache(home, [{ version: V.farBelow }, { version: V.justBelow }]); // both below the floor
      strictEqual(await discoverRuntimePluginRoot({ env: {}, home, selfUrl: NEUTRAL_SELF }), null);
    });

    it('a prerelease of the footer floor does NOT satisfy the gate', async () => {
      const preRoot = await mkRuntimeRoot(await tmp(pfx('pre')), { version: V.floorPrerelease });
      const home = await NO_HOME();
      const env = { AGENTIC_RUNTIME_ROOT: preRoot };
      strictEqual(await resolveRuntimePluginRoot({ env, home, selfUrl: NEUTRAL_SELF }), preRoot, 'resolve() (ungated) finds it');
      strictEqual(await discoverRuntimePluginRoot({ env, home, selfUrl: NEUTRAL_SELF }), null, 'gate rejects a prerelease of the floor');
      // a prerelease ABOVE the floor is still fine.
      strictEqual(await runtimeVersionAtLeast(preRoot), false);
      const preAbove = await mkRuntimeRoot(await tmp(pfx('pre2')), { version: V.abovePrerelease });
      strictEqual(await runtimeVersionAtLeast(preAbove, minRuntimeVersion()), true);
    });

    it('exactly at the footer floor passes the gate', async () => {
      const home = await NO_HOME();
      const atFooterFloor = await mkRuntimeRoot(await tmp(pfx('floor')), { version: minRuntimeVersion() });
      strictEqual(
        await discoverRuntimePluginRoot({ env: { AGENTIC_RUNTIME_ROOT: atFooterFloor }, home, selfUrl: NEUTRAL_SELF }),
        atFooterFloor,
      );
    });
  });
}
