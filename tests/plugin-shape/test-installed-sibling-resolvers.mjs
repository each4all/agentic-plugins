// The cross-plugin sibling resolvers: every copy of `discover-runtime.mjs`
// (attention's two resolvers, founder's and designer's two capability
// ladders), orchestrator's `discover-engineer.mjs`, engineer's
// `parent-writeback.mjs` orchestrator resolver, and runtime doctor's private
// engineer resolver.
//
// ADR-0061 §Decision 3, as S2 of its implementation manifest applies it:
//   - each host's candidate is its versioned install cache; Codex's lives under
//     $CODEX_HOME, and the marketplace clone (`.tmp/marketplaces`) is never a
//     candidate, not even as a last resort;
//   - among retained versions the newest manifest-verified one that passes the
//     resolver's own filter wins, the manifest read from the host's own layout;
//   - a caller running from a Codex install tries the Codex cache first and
//     uses the Claude cache only when Codex has none installed, and says so
//     (`crossHostFallback`, plus a stderr line from the resolvers that return a
//     bare root); a Claude-installed caller mirrors that;
//   - an installed sibling that fails the filter fails closed rather than
//     crossing hosts;
//   - the caller's host is decided against each host's install cache and
//     marketplace clone trees, each also canonically, so a custom or symlinked
//     CODEX_HOME counts, a tree symlinked elsewhere still counts, a stray
//     '/.codex/' path segment does not, a checkout elsewhere under a host's
//     home is still a checkout, and overlapping trees go to the more specific;
//   - every returned root is canonical, because the CLIs a root leads to
//     compare argv[1] with Node's canonical module path and silently do nothing
//     when a symlink makes them differ;
//   - the sibling checkout applies only to a caller running from a checkout —
//     never to one in a host install or in the marketplace clone;
//   - the env override wins and never falls through.
//
// These are deliberate copies (ADR-0010 §5), so each one is exercised rather
// than one standing in for the rest. The per-plugin test files keep the floor
// gates and each copy's own details.

import { describe, it, before, after } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, cp } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');

const CLAUDE_MANIFEST = join('.claude-plugin', 'plugin.json');
const CODEX_MANIFEST = join('.codex-plugin', 'plugin.json');
const FOOTER = join('scripts', 'footer.mjs');
const NOTIFY = join('scripts', 'notify.mjs');
const STATE = join('scripts', 'state.mjs');

const CACHE_SOURCES = { env: 'env', sibling: 'sibling' };
const DOCTOR_SOURCES = { env: 'env-override', sibling: 'sibling-monorepo' };

const runtimeLadder = (plugin, extra = {}) => ({
  module: `plugins/${plugin}/scripts/discover-runtime.mjs`,
  caller: plugin,
  callerFile: 'discover-runtime.mjs',
  seek: 'runtime',
  override: 'AGENTIC_RUNTIME_ROOT',
  sources: CACHE_SOURCES,
  ...extra,
});

const LOCATORS = [
  runtimeLadder('engineer', {
    id: 'engineer discover-runtime',
    capability: FOOTER,
    locate: (m, a) => m.locateRuntimePluginRoot(a),
    resolve: (m, a) => m.resolveRuntimePluginRoot(a),
  }),
  runtimeLadder('orchestrator', {
    id: 'orchestrator discover-runtime',
    capability: FOOTER,
    locate: (m, a) => m.locateRuntimePluginRoot(a),
    resolve: (m, a) => m.resolveRuntimePluginRoot(a),
  }),
  ...['founder', 'designer'].flatMap((plugin) => [
    runtimeLadder(plugin, {
      id: `${plugin} discover-runtime (footer)`,
      capability: FOOTER,
      locate: (m, a) => m.locateRuntimePluginRoot(a),
      resolve: (m, a) => m.resolveRuntimePluginRoot(a),
    }),
    runtimeLadder(plugin, {
      id: `${plugin} discover-runtime (notify)`,
      capability: NOTIFY,
      locate: (m, a) => m.locateRuntimePluginRoot({ ...a, capability: m.NOTIFY_CAPABILITY }),
      resolve: (m, a) => m.resolveRuntimePluginRoot({ ...a, capability: m.NOTIFY_CAPABILITY }),
    }),
  ]),
  runtimeLadder('attention', {
    id: 'attention discover-runtime (notify)',
    capability: NOTIFY,
    locate: (m, a) => m.locateRuntimePluginRoot(a),
    resolve: (m, a) => m.resolveRuntimePluginRoot(a),
  }),
  runtimeLadder('attention', {
    id: 'attention discover-runtime (newest by manifest)',
    capability: null,
    locate: (m, a) => m.locateNewestRuntimePluginRoot(a),
    resolve: (m, a) => m.resolveNewestRuntimePluginRoot(a),
  }),
  {
    id: 'orchestrator discover-engineer',
    module: 'plugins/orchestrator/scripts/discover-engineer.mjs',
    caller: 'orchestrator',
    callerFile: 'discover-engineer.mjs',
    seek: 'engineer',
    override: 'AGENTIC_ENGINEER_ROOT',
    capability: STATE,
    sources: CACHE_SOURCES,
    locate: (m, a) => m.locateEngineerPluginRoot(a),
    resolve: (m, a) => m.discoverEngineerPluginRoot(a),
  },
  {
    id: 'engineer parent-writeback',
    module: 'plugins/engineer/scripts/parent-writeback.mjs',
    caller: 'engineer',
    callerFile: 'parent-writeback.mjs',
    seek: 'orchestrator',
    override: 'AGENTIC_ORCHESTRATOR_ROOT',
    capability: STATE,
    sources: CACHE_SOURCES,
    locate: (m, a) => m.locateOrchestratorPluginRoot(a),
    // writebackParent reports the fallback; tests/engineer/test-parent-writeback.mjs covers it.
    resolve: null,
  },
  {
    id: 'runtime doctor engineer resolver',
    module: 'plugins/runtime/scripts/doctor.mjs',
    caller: 'runtime',
    callerFile: 'doctor.mjs',
    seek: 'engineer',
    override: 'AGENTIC_ENGINEER_ROOT',
    capability: STATE,
    sources: DOCTOR_SOURCES,
    locate: (m, a) => m.locateInstalledEngineerRoot(a),
    // Doctor reports the fallback in the proof result (tool_root_cross_host_fallback).
    resolve: null,
  },
];

const claudeCache = (home) => join(home, '.claude', 'plugins', 'cache', 'agentic-plugins');
const codexCache = (codexHome) => join(codexHome, 'plugins', 'cache', 'agentic-plugins');
const cloneOf = (codexHome) => join(codexHome, '.tmp', 'marketplaces', 'agentic-plugins', 'plugins');

// A plugin root: both manifests unless `manifestRel` names one, plus the
// resolver's capability file unless `capable` is false.
async function plant(root, { name, version, manifestRel = null, capability, capable = true }) {
  for (const rel of manifestRel ? [manifestRel] : [CLAUDE_MANIFEST, CODEX_MANIFEST]) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), JSON.stringify({ name, version }));
  }
  await mkdir(join(root, 'scripts'), { recursive: true });
  if (capability && capable) await writeFile(join(root, capability), '// stub\n');
  return root;
}

const plantClaude = (home, spec, version, opts = {}) =>
  plant(join(claudeCache(home), spec.seek, version), { name: spec.seek, version, manifestRel: CLAUDE_MANIFEST, capability: spec.capability, ...opts });
const plantCodex = (codexHome, spec, version, opts = {}) =>
  plant(join(codexCache(codexHome), spec.seek, version), { name: spec.seek, version, manifestRel: CODEX_MANIFEST, capability: spec.capability, ...opts });

// Where an installed copy of the caller would live, as the resolver's selfUrl.
const installedSelf = (cacheRoot, spec) =>
  pathToFileURL(join(cacheRoot, spec.caller, '9.9.9', 'scripts', spec.callerFile)).href;

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

function capture() {
  const lines = [];
  return { stderr: { write: (s) => { lines.push(s); } }, text: () => lines.join('') };
}

before(async () => {
  // Canonical, so a planted path equals the canonical root a resolver returns
  // (macOS tmpdir sits behind /var -> /private/var).
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'sibling-resolvers-')));
});
after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

for (const spec of LOCATORS) {
  describe(`${spec.id} (${spec.module}) — ADR-0061 S2`, () => {
    let mod;
    before(async () => {
      mod = await import(pathToFileURL(join(REPO_ROOT, spec.module)).href);
    });

    it('a Codex-installed caller resolves from the Codex cache under a custom CODEX_HOME, over a newer Claude copy', async () => {
      const { home, codexHome, env } = await freshHomes();
      const codexRoot = await plantCodex(codexHome, spec, '0.5.0');
      await plantClaude(home, spec, '0.9.0');
      // A ~/.codex cache the custom CODEX_HOME replaces.
      await plantCodex(join(home, '.codex'), spec, '0.8.0');
      const selfUrl = installedSelf(codexCache(codexHome), spec);
      const got = await spec.locate(mod, { env, home, selfUrl });
      strictEqual(got.root, codexRoot);
      strictEqual(got.source, 'codex-cache');
      strictEqual(got.host, 'codex');
      strictEqual(got.callerHost, 'codex');
      strictEqual(got.crossHostFallback, false);
      if (spec.resolve) {
        const sink = capture();
        strictEqual(await spec.resolve(mod, { env, home, selfUrl, stderr: sink.stderr }), codexRoot);
        strictEqual(sink.text(), '', 'a same-host root is not reported');
      }
    });

    it('a Claude-installed caller resolves from the Claude cache over a newer Codex copy', async () => {
      const { home, codexHome, env } = await freshHomes();
      const claudeRoot = await plantClaude(home, spec, '0.5.0');
      await plantCodex(codexHome, spec, '0.9.0');
      const got = await spec.locate(mod, { env, home, selfUrl: installedSelf(claudeCache(home), spec) });
      strictEqual(got.root, claudeRoot);
      strictEqual(got.host, 'claude');
      strictEqual(got.callerHost, 'claude');
      strictEqual(got.crossHostFallback, false);
    });

    it('among retained Codex versions the newest manifest-verified one that passes the filter wins', async () => {
      const { home, codexHome, env } = await freshHomes();
      await plantCodex(codexHome, spec, '0.4.0');
      const newest = await plantCodex(codexHome, spec, '0.6.0');
      // Newer, but: another plugin's manifest; a Claude-layout manifest only;
      // and (for a capability-gated resolver) no capability file.
      await plantCodex(codexHome, spec, '0.9.0', { name: `not-${spec.seek}` });
      await plantCodex(codexHome, spec, '0.7.0', { manifestRel: CLAUDE_MANIFEST });
      if (spec.capability) await plantCodex(codexHome, spec, '0.8.0', { capable: false });
      const got = await spec.locate(mod, { env, home, selfUrl: installedSelf(codexCache(codexHome), spec) });
      strictEqual(got.root, newest);
      strictEqual(got.version, '0.6.0');
    });

    it('never chooses the marketplace clone — not over an older install, and not when nothing is installed', async () => {
      const { home, codexHome, env } = await freshHomes();
      await plant(join(cloneOf(codexHome), spec.seek), { name: spec.seek, version: '99.0.0', capability: spec.capability });
      const selfUrl = installedSelf(codexCache(codexHome), spec);
      const empty = await spec.locate(mod, { env, home, selfUrl });
      strictEqual(empty.root, null, 'the clone is not a fallback');
      strictEqual(empty.source, null);
      const installed = await plantCodex(codexHome, spec, '0.1.0');
      strictEqual((await spec.locate(mod, { env, home, selfUrl })).root, installed);
    });

    it('a Codex-installed caller falls back to the Claude cache only when Codex has none installed, and reports it', async () => {
      const { home, codexHome, env } = await freshHomes();
      const claudeRoot = await plantClaude(home, spec, '0.5.0');
      const selfUrl = installedSelf(codexCache(codexHome), spec);
      const got = await spec.locate(mod, { env, home, selfUrl });
      strictEqual(got.root, claudeRoot);
      strictEqual(got.host, 'claude');
      strictEqual(got.callerHost, 'codex');
      strictEqual(got.crossHostFallback, true);
      if (spec.resolve) {
        const sink = capture();
        strictEqual(await spec.resolve(mod, { env, home, selfUrl, stderr: sink.stderr }), claudeRoot);
        ok(/resolved from the claude plugin cache because the codex cache has no/.test(sink.text()), `the fallback must be reported: ${JSON.stringify(sink.text())}`);
      }
    });

    it('an installed sibling on the caller\'s host that fails the filter fails closed rather than crossing hosts', async (t) => {
      if (!spec.capability) {
        t.skip('this resolver filters by manifest alone');
        return;
      }
      const { home, codexHome, env } = await freshHomes();
      await plantCodex(codexHome, spec, '0.5.0', { capable: false });
      await plantClaude(home, spec, '0.9.0');
      const got = await spec.locate(mod, { env, home, selfUrl: installedSelf(codexCache(codexHome), spec) });
      strictEqual(got.root, null);
      strictEqual(got.host, 'codex');
      strictEqual(got.crossHostFallback, false);
      ok(typeof got.reason === 'string' && got.reason.length > 0, 'the failure carries a reason');
    });

    it("a '/.codex/' path segment alone does not make a Codex caller", async () => {
      const { home, codexHome, env } = await freshHomes();
      const claudeRoot = await plantClaude(home, spec, '0.5.0');
      await plantCodex(codexHome, spec, '0.5.0');
      const decoy = join(scratch, `decoy-${seq}`, '.codex', 'plugins', 'cache', 'agentic-plugins');
      const got = await spec.locate(mod, { env, home, selfUrl: installedSelf(decoy, spec) });
      strictEqual(got.callerHost, 'checkout');
      strictEqual(got.root, claudeRoot, 'a checkout caller probes Claude first');
    });

    it('a caller inside the marketplace clone is Codex-hosted and never takes the clone\'s sibling', async () => {
      const { home, codexHome, env } = await freshHomes();
      await plant(join(cloneOf(codexHome), spec.seek), { name: spec.seek, version: '99.0.0', capability: spec.capability });
      const selfUrl = pathToFileURL(join(cloneOf(codexHome), spec.caller, 'scripts', spec.callerFile)).href;
      const got = await spec.locate(mod, { env, home, selfUrl });
      strictEqual(got.callerHost, 'codex');
      strictEqual(got.root, null);
    });

    it('a checkout caller takes the sibling checkout when no cache has one', async () => {
      const { home, env } = await freshHomes();
      const repo = join(scratch, `repo-${seq}`);
      const sibling = await plant(join(repo, 'plugins', spec.seek), { name: spec.seek, version: '0.1.0', capability: spec.capability });
      const selfUrl = pathToFileURL(join(repo, 'plugins', spec.caller, 'scripts', spec.callerFile)).href;
      const got = await spec.locate(mod, { env, home, selfUrl });
      strictEqual(got.root, sibling);
      strictEqual(got.source, spec.sources.sibling);
      strictEqual(got.callerHost, 'checkout');
    });

    it('a caller in a marketplace clone symlinked out of CODEX_HOME is still Codex-hosted and never takes the clone\'s sibling', async () => {
      const { home, codexHome, env } = await freshHomes();
      const elsewhere = join(scratch, `tmp-elsewhere-${seq}`);
      await mkdir(join(elsewhere, 'marketplaces'), { recursive: true });
      await symlink(elsewhere, join(codexHome, '.tmp'));
      const realClone = join(elsewhere, 'marketplaces', 'agentic-plugins', 'plugins');
      await plant(join(realClone, spec.seek), { name: spec.seek, version: '99.0.0', capability: spec.capability });
      // Node hands a module its canonical path, so the caller sees the link's target.
      const selfUrl = pathToFileURL(join(realClone, spec.caller, 'scripts', spec.callerFile)).href;
      const got = await spec.locate(mod, { env, home, selfUrl });
      strictEqual(got.callerHost, 'codex');
      strictEqual(got.root, null);
    });

    it('a caller in an install cache symlinked out of CODEX_HOME is still Codex-hosted', async () => {
      const { home, codexHome, env } = await freshHomes();
      const elsewhere = join(scratch, `cache-elsewhere-${seq}`);
      await mkdir(elsewhere, { recursive: true });
      await mkdir(join(codexHome, 'plugins'), { recursive: true });
      await symlink(elsewhere, join(codexHome, 'plugins', 'cache'));
      const codexRoot = await plantCodex(codexHome, spec, '0.5.0');
      await plantClaude(home, spec, '0.9.0');
      const selfUrl = pathToFileURL(join(elsewhere, 'agentic-plugins', spec.caller, '9.9.9', 'scripts', spec.callerFile)).href;
      const got = await spec.locate(mod, { env, home, selfUrl });
      strictEqual(got.callerHost, 'codex');
      strictEqual(got.host, 'codex');
      strictEqual(got.root, await realpath(codexRoot), 'the root is returned canonical');
    });

    it('under a symlinked CODEX_HOME the returned root is canonical, not the link spelling', async () => {
      const { home } = await freshHomes();
      const realCodex = join(scratch, `codex-real-${seq}`);
      await mkdir(realCodex, { recursive: true });
      const link = join(scratch, `codex-link-${seq}`);
      await symlink(realCodex, link);
      const env = { CODEX_HOME: link };
      await plantCodex(link, spec, '0.5.0');
      const selfUrl = pathToFileURL(join(realCodex, 'plugins', 'cache', 'agentic-plugins', spec.caller, '9.9.9', 'scripts', spec.callerFile)).href;
      const got = await spec.locate(mod, { env, home, selfUrl });
      strictEqual(got.callerHost, 'codex');
      strictEqual(got.root, join(realCodex, 'plugins', 'cache', 'agentic-plugins', spec.seek, '0.5.0'));
    });

    it('a caller in a marketplace clone whose own directory is symlinked elsewhere is still Codex-hosted', async () => {
      const { home, codexHome, env } = await freshHomes();
      const elsewhere = join(scratch, `marketplaces-elsewhere-${seq}`);
      await mkdir(elsewhere, { recursive: true });
      await mkdir(join(codexHome, '.tmp'), { recursive: true });
      await symlink(elsewhere, join(codexHome, '.tmp', 'marketplaces'));
      const realClone = join(elsewhere, 'agentic-plugins', 'plugins');
      await plant(join(realClone, spec.seek), { name: spec.seek, version: '99.0.0', capability: spec.capability });
      const selfUrl = pathToFileURL(join(realClone, spec.caller, 'scripts', spec.callerFile)).href;
      const got = await spec.locate(mod, { env, home, selfUrl });
      strictEqual(got.callerHost, 'codex');
      strictEqual(got.root, null);
    });

    it('a checkout elsewhere under a host home, or under a directory CODEX_HOME/.tmp links to, still takes its sibling', async () => {
      const { home, codexHome, env } = await freshHomes();
      const underClaudeHome = join(home, '.claude', 'dev', 'agentic-plugins');
      const shared = join(scratch, `shared-tmp-${seq}`);
      await mkdir(shared, { recursive: true });
      await symlink(shared, join(codexHome, '.tmp'));
      const underSharedTmp = join(shared, 'work', 'agentic-plugins');
      for (const repo of [underClaudeHome, underSharedTmp]) {
        const sibling = await plant(join(repo, 'plugins', spec.seek), { name: spec.seek, version: '0.1.0', capability: spec.capability });
        const selfUrl = pathToFileURL(join(repo, 'plugins', spec.caller, 'scripts', spec.callerFile)).href;
        const got = await spec.locate(mod, { env, home, selfUrl });
        strictEqual(got.callerHost, 'checkout', repo);
        strictEqual(got.root, sibling, repo);
      }
    });

    it('a Claude cache relocated inside CODEX_HOME still makes its caller Claude-hosted', async () => {
      const { home, codexHome, env } = await freshHomes();
      const relocated = join(codexHome, 'claude-cache');
      await mkdir(relocated, { recursive: true });
      await mkdir(join(home, '.claude', 'plugins'), { recursive: true });
      await symlink(relocated, join(home, '.claude', 'plugins', 'cache'));
      const claudeRoot = await plantClaude(home, spec, '0.5.0');
      await plantCodex(codexHome, spec, '0.9.0');
      const selfUrl = pathToFileURL(join(relocated, 'agentic-plugins', spec.caller, '9.9.9', 'scripts', spec.callerFile)).href;
      const got = await spec.locate(mod, { env, home, selfUrl });
      strictEqual(got.callerHost, 'claude');
      strictEqual(got.host, 'claude');
      strictEqual(got.crossHostFallback, false);
      strictEqual(got.root, await realpath(claudeRoot));
    });

    it('a Claude cache relocated inside the Codex install cache goes to the more specific (Claude) root', async () => {
      // Both hosts' trees hold the caller here; the longer, more specific root owns it.
      const { home, codexHome, env } = await freshHomes();
      const relocated = join(codexHome, 'plugins', 'cache', 'claude-cache');
      await mkdir(relocated, { recursive: true });
      await mkdir(join(home, '.claude', 'plugins'), { recursive: true });
      await symlink(relocated, join(home, '.claude', 'plugins', 'cache'));
      const claudeRoot = await plantClaude(home, spec, '0.5.0');
      await plantCodex(codexHome, spec, '0.9.0');
      const selfUrl = pathToFileURL(join(relocated, 'agentic-plugins', spec.caller, '9.9.9', 'scripts', spec.callerFile)).href;
      const got = await spec.locate(mod, { env, home, selfUrl });
      strictEqual(got.callerHost, 'claude');
      strictEqual(got.host, 'claude');
      strictEqual(got.crossHostFallback, false);
      strictEqual(got.root, await realpath(claudeRoot));
    });

    it('a checkout sibling that is a symlink into the marketplace clone is refused', async () => {
      const { home, codexHome, env } = await freshHomes();
      const cloneSibling = await plant(join(cloneOf(codexHome), spec.seek), { name: spec.seek, version: '99.0.0', capability: spec.capability });
      const repo = join(scratch, `repo-linked-${seq}`);
      await mkdir(join(repo, 'plugins'), { recursive: true });
      await symlink(cloneSibling, join(repo, 'plugins', spec.seek));
      const selfUrl = pathToFileURL(join(repo, 'plugins', spec.caller, 'scripts', spec.callerFile)).href;
      const got = await spec.locate(mod, { env, home, selfUrl });
      strictEqual(got.callerHost, 'checkout');
      strictEqual(got.root, null, 'a sibling that resolves into a host tree is not a checkout');
    });

    it('the env override wins and never falls through to the caches', async () => {
      const { home, codexHome } = await freshHomes();
      await plantCodex(codexHome, spec, '0.5.0');
      const selfUrl = installedSelf(codexCache(codexHome), spec);
      const overrideRoot = await plant(join(scratch, `override-${seq}`), { name: spec.seek, version: '0.1.0', capability: spec.capability });
      const good = await spec.locate(mod, { env: { CODEX_HOME: codexHome, [spec.override]: overrideRoot }, home, selfUrl });
      deepStrictEqual([good.root, good.source], [overrideRoot, spec.sources.env]);
      const missing = await spec.locate(mod, { env: { CODEX_HOME: codexHome, [spec.override]: join(scratch, 'no-such-root') }, home, selfUrl });
      deepStrictEqual([missing.root, missing.source], [null, spec.sources.env]);
    });
  });
}

describe('a resolved root runs its CLI under a symlinked CODEX_HOME (ADR-0061 S2)', () => {
  // The resolver may pick an older installed engineer whose entry guard still
  // compares argv[1] as spelled; the canonical root is what lets that CLI run.
  const OLD_GUARD_STATE = "if (import.meta.url === `file://${process.argv[1]}`) { process.stdout.write('ran\\n'); }\n";

  it('discover-engineer hands back a canonical root, so even an old-guard state.mjs executes', async () => {
    const { locateEngineerPluginRoot } = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/discover-engineer.mjs')).href);
    const home = join(scratch, 'e2e-home');
    const realCodex = join(scratch, 'e2e-codex-real');
    const link = join(scratch, 'e2e-codex-link');
    await mkdir(home, { recursive: true });
    await mkdir(realCodex, { recursive: true });
    await symlink(realCodex, link);
    const installed = await plantCodex(link, { seek: 'engineer', capability: STATE }, '0.20.0');
    await writeFile(join(installed, 'scripts', 'state.mjs'), OLD_GUARD_STATE);
    const selfUrl = pathToFileURL(join(realCodex, 'plugins', 'cache', 'agentic-plugins', 'orchestrator', '9.9.9', 'scripts', 'discover-engineer.mjs')).href;
    const got = await locateEngineerPluginRoot({ env: { CODEX_HOME: link }, home, selfUrl });
    strictEqual(got.host, 'codex');
    const run = (script) => execFileSync(process.execPath, [script], { encoding: 'utf8' });
    strictEqual(run(join(got.root, 'scripts', 'state.mjs')), 'ran\n', 'the canonical root reaches an old-guard CLI');
    // Control: through the link spelling the old guard does nothing.
    strictEqual(run(join(installed, 'scripts', 'state.mjs')), '', 'control: the link spelling runs nothing');
  });
});

// The CLIs the S2 resolvers hand paths to, and the resolvers' own CLIs: each
// must behave the same from the repository, from a directory whose name needs
// URL escaping, and through a symlink — with and without
// --preserve-symlinks-main, which keeps the link in import.meta.url.
describe('CLI entry points run from any install spelling (ADR-0061 S2)', () => {
  const CLIS = [
    'plugins/orchestrator/scripts/state.mjs',
    'plugins/engineer/scripts/state.mjs',
    'plugins/engineer/scripts/dispatch-peer.mjs',
    'plugins/runtime/scripts/notify.mjs',
    'plugins/engineer/scripts/discover-runtime.mjs',
    'plugins/orchestrator/scripts/discover-runtime.mjs',
    'plugins/founder/scripts/discover-runtime.mjs',
    'plugins/designer/scripts/discover-runtime.mjs',
    'plugins/attention/scripts/discover-runtime.mjs',
    'plugins/orchestrator/scripts/discover-engineer.mjs',
  ];
  let escaped;
  let linked;
  before(async () => {
    escaped = join(scratch, 'space home #홈');
    for (const plugin of new Set(CLIS.map((rel) => rel.split('/')[1]))) {
      await cp(join(REPO_ROOT, 'plugins', plugin), join(escaped, 'plugins', plugin), { recursive: true });
    }
    linked = join(scratch, 'install-link');
    await symlink(escaped, linked);
  });

  for (const rel of CLIS) {
    it(`${rel} answers --help identically from the repository, an escaped path and a symlink`, () => {
      const help = (root, nodeArgs = []) => {
        const out = spawnSync(process.execPath, [...nodeArgs, join(root, rel), '--help'], { encoding: 'utf8' });
        return [out.status, out.stdout, out.stderr];
      };
      const reference = help(REPO_ROOT);
      ok(reference[1].length + reference[2].length > 0, 'the reference run prints something to compare');
      deepStrictEqual(help(escaped), reference, 'a path needing URL escaping');
      deepStrictEqual(help(linked), reference, 'a path through a symlink');
      deepStrictEqual(help(linked, ['--preserve-symlinks-main']), reference, 'a symlink kept in import.meta.url');
    });
  }
});
