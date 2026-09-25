#!/usr/bin/env node
// plugins/attention/scripts/discover-runtime.mjs
//
// ADR-0039 §5 ladder, applied to the ADR-0040 §3 attention sensors. Every
// attention hook sensor (Notification / Stop / SubagentStop) resolves the
// runtime plugin root through this resolver and shells out to the runtime's
// `scripts/notify.mjs emit` — the only component that touches notification
// channels. Locating `notify.mjs` at the installed runtime plugin root
// requires this resolver.
//
// COPY-NOT-IMPORT (ADR-0010 §5). notify.mjs is L1 runtime; attention is a
// separate L1 plugin. A cross-plugin `import` would break SemVer independence,
// so this module lives INSIDE attention and discovers the runtime plugin root
// by filesystem inspection only; the eventual notify.mjs invocation goes
// through `child_process`. It is a deliberate sibling copy of engineer's
// `discover-runtime.mjs` (itself derived from orchestrator's
// `discover-engineer.mjs` ladder: env override → the caller's own host install
// cache → the other host's cache → sibling checkout), re-gated on
// `scripts/notify.mjs` instead of `scripts/footer.mjs`.
//
// The resolver runs IN-PROCESS on hook hot paths (no CLI boundary), so the
// version gate is folded into `discoverRuntimePluginRoot` — it returns a root
// only when notify.mjs exists AND the runtime is new enough. A missing OR
// too-old runtime is a silent fail-closed (null), with NO fall-back to a stale
// cache (ADR-0039 §5): the ladder resolves ONE best root, then that root is
// version-gated; it is never re-discovered to find an older-but-present copy.
//
// Candidates follow ADR-0061 §Decision 3, for both resolvers below:
//   - each host's candidate is its versioned install cache —
//     ~/.claude/plugins/cache/agentic-plugins/runtime/<version>/ and
//     <CODEX_HOME or ~/.codex>/plugins/cache/agentic-plugins/runtime/<version>/,
//     manifest-name verified, newest SemVer passing the resolver's filter
//     first. The Codex marketplace clone (~/.codex/.tmp/marketplaces/…)
//     tracks the repository's main branch and is never a candidate, not even
//     a fallback.
//   - the caller's own host goes first. The other host's cache is used only
//     when the caller's host has no runtime installed, and that fallback is
//     reported. A runtime installed on the caller's host that fails the
//     filter is a failure, not a reason to cross hosts.
//   - the caller's host is decided against the host's install cache and
//     marketplace clone trees, each also by its canonical path, so a custom
//     or symlinked $CODEX_HOME counts, a '/.codex/' path segment alone does
//     not, and a checkout elsewhere under a host's home is still a checkout.
//   - every returned root is canonical, so the CLI it leads to runs.
//   - the sibling checkout applies only when this file runs from a checkout,
//     never from a host install or a marketplace clone.

import { stat, readdir, readFile as fsReadFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, isAbsolute, resolve, dirname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ENV_OVERRIDE = 'AGENTIC_RUNTIME_ROOT';

// The floor runtime version whose `notify.mjs emit` interface exists at all.
// ADR-0040's release-gate subtask pinned this to the FIRST RELEASED runtime
// version shipping notify.mjs: plugin-runtime-v0.71.0 (macro checkpoint
// 2026-07-04, tag plugin-runtime-v0.71.0). A planned-but-unreleased version
// must never be pinned here — release-please owns the bump, and the gate
// below fail-closes on anything older (missing/too-old ⇒ silent no-op).
export const MIN_RUNTIME_VERSION = '0.71.0';

// The SEPARATE capability floor for the ADR-0044 §2 capture spawn: the first
// RELEASED runtime version shipping `context.mjs publish-session` —
// plugin-runtime-v0.82.0, recorded by the S4a release-proof gate (ADR-0044
// §Status, 2026-07-19). The two gates never share a constant (ADR-0044 §2
// dual-floor rule): below THIS floor the Stop sensor silently skips the
// capture spawn while notifications keep working at MIN_RUNTIME_VERSION.
// The §13 declaration the plugin ships (data/runtime-floors.json,
// floors.publish_session) must agree with this constant byte-for-byte —
// the plugin-shape test pins the pair.
export const PUBLISH_SESSION_MIN_RUNTIME_VERSION = '0.82.0';

// The THIRD capability floor, for the ADR-0045 §7 SessionStart entry-brief
// spawn: the first RELEASED runtime version shipping `context.mjs
// entry-brief` — plugin-runtime-v0.83.0, recorded by the S8a release-proof
// gate (ADR-0045 §Status, 2026-07-20). The notify, publisher, and
// entry-brief floors never share a constant (ADR-0045 §12 / ADR-0043
// released-floor rule): below THIS floor the SessionStart sensor silently
// skips the entry-brief spawn while notifications and capture keep their
// own gates. Prerelease semantics are the shared strict `versionGte` below
// — a prerelease of the floor core (`0.83.0-beta.1`) fails, a prerelease of
// a higher core passes — matching the runtime-side §18 diagnosis, whose
// declaration validation (`CLEAN_RELEASE_SEMVER_RE` in
// session-readiness.mjs) refuses any non-clean-`X.Y.Z` declared floor. The
// §18 declaration this plugin ships (data/runtime-floors.json,
// floors.entry_brief — an additive sibling key) must agree with this
// constant byte-for-byte — the plugin-shape test pins the pair.
export const ENTRY_BRIEF_MIN_RUNTIME_VERSION = '0.83.0';

// The FOURTH capability floor, for the ADR-0047 §2/§9 response-needed
// classifier/producer path: the first RELEASED runtime version whose
// notify-schema carries the `response-needed` kind contract (schema +
// filter vocabulary + shuttle remap template) — plugin-runtime-v0.84.0,
// Release A of the ADR-0047 §8 two-release rollout, recorded by the
// `signal-runtime-release` macro subtask (2026-07-21). It deliberately
// does NOT raise the notify floor above (ADR-0044 "two gates never share
// a constant"): below THIS floor the Stop sensor takes the pre-ADR-0047
// bare path (turn-complete, no classifier, no headline) while
// notifications keep working at MIN_RUNTIME_VERSION — graceful
// degradation, never an error, and never a kind the resolving runtime's
// validateEvent would reject (§8 enable-sequence failure 1). Prerelease
// semantics are the shared strict `versionGte` below. The §9 declaration
// this plugin ships (data/runtime-floors.json, floors.response_signal —
// an additive sibling key) must agree with this constant byte-for-byte —
// the plugin-shape test pins the pair.
export const RESPONSE_SIGNAL_MIN_RUNTIME_VERSION = '0.84.0';

async function fileExists(path) {
  try {
    const st = await stat(path);
    return st.isFile();
  } catch {
    return false;
  }
}

// Ordering compare for CACHE SELECTION (pick the latest). Prereleases sort by
// their numeric core, with a SemVer-standard tie-break on an equal core: a
// clean release orders ABOVE its own prereleases, so a cache holding both
// `0.83.0-beta.1` and `0.83.0` selects the release deterministically instead
// of inheriting readdir order (Codex Plan-verify). The strict gate below
// (`versionGte`) is still what actually enforces the floor.
function semverCompare(a, b) {
  // Build metadata (`+…`) strips FIRST: it may itself contain hyphens
  // (`1.0.0+build-5` is a clean release, SemVer §10), so splitting on `-`
  // before dropping it would misread the metadata as a prerelease.
  const [bareA] = String(a).split('+', 2);
  const [bareB] = String(b).split('+', 2);
  const [coreA, preA] = bareA.split('-', 2);
  const [coreB, preB] = bareB.split('-', 2);
  const pa = coreA.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = coreB.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  if (!preA && preB) return 1;
  if (preA && !preB) return -1;
  return 0;
}

// Strict floor gate: a prerelease of the floor version (e.g. `0.71.0-beta.1`)
// must NOT satisfy `>= 0.71.0` — the prerelease precedes its release. `min` is
// a clean release (MIN_RUNTIME_VERSION). Cores compared numerically; on an
// equal core, a prerelease `version` is treated as BELOW. A prerelease of a
// HIGHER core (e.g. `0.72.0-beta.1`) deliberately passes — it postdates the
// floor release and therefore carries notify.mjs (SemVer ordering; same
// semantics as the engineer sibling copy).
function versionGte(version, min) {
  // Same build-metadata-first strip as semverCompare: `X.Y.Z+build-5` is a
  // clean release of core X.Y.Z, never a prerelease (SemVer §10).
  const [bare] = String(version).split('+', 2);
  const [core, prerelease] = bare.split('-', 2);
  const parts = core.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const floor = String(min).split('-', 1)[0].split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const av = parts[i] ?? 0;
    const bv = floor[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  // Cores equal — accept only a clean release (no prerelease suffix).
  return !prerelease;
}

// Codex honors $CODEX_HOME for everything it writes, including the plugin
// cache; an unset or empty value means ~/.codex.
function codexHomeDir(env, home) {
  const value = env.CODEX_HOME;
  return typeof value === 'string' && value.length > 0 ? resolve(value) : join(home, '.codex');
}

function hostLayout(env, home) {
  const codexHome = codexHomeDir(env, home);
  return {
    claude: {
      // The trees a host installs into and clones marketplaces into. Code
      // under them is that host's, never a checkout. Only these trees: a
      // checkout elsewhere under the host's home is still a checkout.
      roots: [
        join(home, '.claude', 'plugins', 'cache'),
        join(home, '.claude', 'plugins', 'marketplaces'),
      ],
      base: join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'runtime'),
      manifest: join('.claude-plugin', 'plugin.json'),
    },
    codex: {
      roots: [
        join(codexHome, 'plugins', 'cache'),
        join(codexHome, '.tmp', 'marketplaces'),
      ],
      base: join(codexHome, 'plugins', 'cache', 'agentic-plugins', 'runtime'),
      manifest: join('.codex-plugin', 'plugin.json'),
    },
  };
}

// Canonical form: the nearest existing ancestor is realpath'd and the rest
// re-appended, so a symlinked prefix (macOS /var -> /private/var, a symlinked
// ~/.codex) compares equal on both sides even when the tail does not exist.
// Every root this module returns is canonical too: the CLIs a root leads to
// compare argv[1] with Node's canonical module path, and silently do nothing
// when a symlink makes the two differ.
function realOrResolved(path) {
  let head = resolve(path);
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      tail.push(basename(head));
      head = parent;
    }
  }
}

function isWithin(child, parent) {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function selfPathOf(selfUrl) {
  if (typeof selfUrl !== 'string' || selfUrl.length === 0) return null;
  try {
    return fileURLToPath(selfUrl);
  } catch {
    return null;
  }
}

// The length of the most specific root in `roots` that holds `path`, compared
// both as spelled and canonically (so a path reached through a symlink, or a
// tree symlinked elsewhere, still counts); 0 when none holds it. A symlink
// below a root is not followed: the canonical comparison covers a root that is
// itself a link or sits under one.
function ownership(path, roots) {
  const spelled = resolve(path);
  const canonical = realOrResolved(path);
  let best = 0;
  for (const root of roots) {
    const spelledRoot = resolve(root);
    const canonicalRoot = realOrResolved(root);
    if (isWithin(spelled, spelledRoot)) best = Math.max(best, spelledRoot.length);
    if (isWithin(canonical, canonicalRoot)) best = Math.max(best, canonicalRoot.length);
  }
  return best;
}

// 'codex' | 'claude' when this file sits in that host's install cache or a
// marketplace clone, else null (a checkout). When both hosts' trees hold it
// (one cache relocated inside the other's), the more specific root wins.
function callerHostOf(selfPath, hosts) {
  if (!selfPath) return null;
  const codex = ownership(selfPath, hosts.codex.roots);
  const claude = ownership(selfPath, hosts.claude.roots);
  if (codex === 0 && claude === 0) return null;
  return codex >= claude ? 'codex' : 'claude';
}

/**
 * The runtime install in one host cache: `{ state: 'absent' }` when no
 * manifest-verified runtime is there, `{ state: 'unusable', version }` when one
 * is but none carries `capabilityRel`, else `{ state: 'ok', root, version }`
 * for the newest that does. A null `capabilityRel` filters by manifest alone.
 */
async function newestRuntimeInstall({ base, manifest }, capabilityRel) {
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return { state: 'absent' };
  }
  const installed = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const versionRoot = join(base, entry.name);
    let parsed;
    try {
      parsed = JSON.parse(await fsReadFile(join(versionRoot, manifest), 'utf8'));
    } catch {
      continue;
    }
    if (parsed?.name !== 'runtime') continue;
    installed.push({
      version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
      root: versionRoot,
      capable: capabilityRel === null || (await fileExists(join(versionRoot, capabilityRel))),
    });
  }
  if (installed.length === 0) return { state: 'absent' };
  installed.sort((a, b) => semverCompare(b.version, a.version));
  const capable = installed.find((c) => c.capable);
  if (!capable) return { state: 'unusable', version: installed[0].version };
  return { state: 'ok', root: capable.root, version: capable.version };
}

// The shared ladder. `accepts(root)` decides the env override and the sibling
// checkout; `capabilityRel` filters cache candidates (null = manifest alone).
async function locate({ env, home, selfUrl, accepts, capabilityRel, describe }) {
  const hosts = hostLayout(env, home);
  const selfPath = selfPathOf(selfUrl);
  const caller = callerHostOf(selfPath, hosts);
  const callerHost = caller ?? 'checkout';

  // 1. Env override — absolute, and accepted. It never falls through to the
  // caches.
  const overrideRoot = env[ENV_OVERRIDE];
  if (typeof overrideRoot === 'string' && overrideRoot.length > 0) {
    if (isAbsolute(overrideRoot) && (await accepts(overrideRoot))) {
      return { root: realOrResolved(overrideRoot), source: 'env', host: null, callerHost, crossHostFallback: false };
    }
    return {
      root: null,
      source: 'env',
      host: null,
      callerHost,
      crossHostFallback: false,
      reason: `${ENV_OVERRIDE}=${overrideRoot} is not an absolute runtime root ${describe}`,
    };
  }

  // 2. Install caches, the caller's own host first.
  const order = caller === 'codex' ? ['codex', 'claude'] : ['claude', 'codex'];
  for (const host of order) {
    const install = await newestRuntimeInstall(hosts[host], capabilityRel);
    if (install.state === 'absent') continue;
    const provenance = {
      source: `${host}-cache`,
      host,
      callerHost,
      crossHostFallback: caller !== null && host !== caller,
    };
    if (install.state === 'unusable') {
      return {
        root: null,
        ...provenance,
        reason: `runtime ${install.version} in ${hosts[host].base} is not a runtime root ${describe}`,
      };
    }
    return { root: realOrResolved(install.root), ...provenance, version: install.version };
  }

  // 3. Sibling checkout — only when this file itself runs from a checkout:
  // <attention-root>/scripts/discover-runtime.mjs → <attention-root>/../runtime.
  if (caller === null && selfPath) {
    const sibling = resolve(dirname(selfPath), '..', '..', 'runtime');
    // A sibling that resolves into an install cache or a marketplace clone is
    // not a checkout.
    const hostTrees = [...hosts.codex.roots, ...hosts.claude.roots];
    if (ownership(sibling, hostTrees) === 0 && (await accepts(sibling))) {
      return { root: realOrResolved(sibling), source: 'sibling', host: null, callerHost, crossHostFallback: false };
    }
  }

  return {
    root: null,
    source: null,
    host: null,
    callerHost,
    crossHostFallback: false,
    reason: 'runtime plugin is not installed in the Claude or Codex plugin cache',
  };
}

// ADR-0061 §Decision 4: once the catalog pins are active, a Codex install holds
// a release commit and a Claude copy does not, so a root taken from the other
// host's cache is reported rather than taken silently. Best-effort —
// reporting must never break a hook.
function reportCrossHostFallback(located, stderr) {
  if (!located.root || !located.crossHostFallback) return;
  try {
    stderr.write(
      `attention/discover-runtime: runtime resolved from the ${located.host} plugin cache ` +
      `because the ${located.callerHost} cache has no runtime installed\n`,
    );
  } catch {
    /* reporting is advisory */
  }
}

/**
 * Resolve the runtime plugin root containing `scripts/notify.mjs`, WITHOUT the
 * version gate, and report where it came from.
 *
 * @param {object} [args]
 * @param {Record<string,string>} [args.env=process.env]
 * @param {string} [args.home=homedir()]
 * @param {string} [args.selfUrl=import.meta.url]
 * @returns {Promise<{root: ?string, source: ?string, host: ?string,
 *   callerHost: string, crossHostFallback: boolean, version?: string,
 *   reason?: string}>} `source` is 'env', 'claude-cache', 'codex-cache',
 *   'sibling', or null when nothing resolved; `callerHost` is 'codex',
 *   'claude' or 'checkout'.
 */
export async function locateRuntimePluginRoot({
  env = process.env,
  home = homedir(),
  selfUrl = import.meta.url,
} = {}) {
  const capabilityRel = join('scripts', 'notify.mjs');
  return locate({
    env,
    home,
    selfUrl,
    accepts: (root) => fileExists(join(root, capabilityRel)),
    capabilityRel,
    describe: 'with scripts/notify.mjs',
  });
}

/**
 * Read the runtime plugin's declared version from either manifest layout
 * (mirrors version.mjs: source checkouts and host caches keep a manifest beside
 * the scripts dir). Returns a SemVer string, or null when neither manifest is
 * readable / carries a version.
 */
async function readRuntimeVersion(root) {
  for (const rel of [
    join('.claude-plugin', 'plugin.json'),
    join('.codex-plugin', 'plugin.json'),
  ]) {
    try {
      const manifest = JSON.parse(await fsReadFile(join(root, rel), 'utf8'));
      if (typeof manifest.version === 'string' && manifest.version.trim()) {
        return manifest.version.trim();
      }
    } catch {
      /* try the other manifest layout */
    }
  }
  return null;
}

/**
 * True when the runtime plugin at `root` declares a version >= `min`. A
 * missing/unreadable version is treated as too-old (fail-closed): we will not
 * emit against a runtime we cannot vouch for.
 */
export async function runtimeVersionAtLeast(root, min = MIN_RUNTIME_VERSION) {
  const version = await readRuntimeVersion(root);
  if (!version) return false;
  return versionGte(version, min);
}

/**
 * Resolve the runtime plugin root directory containing `scripts/notify.mjs`,
 * WITHOUT the version gate: `locateRuntimePluginRoot` without the provenance.
 * Returns the absolute path, or `null` if nothing resolves.
 *
 * @param {object} args
 * @param {Record<string,string>} [args.env=process.env]
 * @param {string} [args.home=homedir()]
 * @param {string} [args.selfUrl=import.meta.url]
 * @param {{write:(s:string)=>void}} [args.stderr=process.stderr] — receives
 *   the cross-host fallback report
 * @returns {Promise<?string>}
 */
export async function resolveRuntimePluginRoot({
  env = process.env,
  home = homedir(),
  selfUrl = import.meta.url,
  stderr = process.stderr,
} = {}) {
  const located = await locateRuntimePluginRoot({ env, home, selfUrl });
  reportCrossHostFallback(located, stderr);
  return located.root;
}

/**
 * Resolve the runtime plugin root, version-gated. Returns the absolute root
 * ONLY when `scripts/notify.mjs` exists AND the runtime declares a version >=
 * `minVersion`. A missing OR too-old runtime returns `null` — the attention
 * sensors then fail-close silently (no notification, the hook exits 0 and the
 * host lifecycle proceeds), with NO fall-back to a stale cache (ADR-0039 §5).
 *
 * @param {object} [args]
 * @param {Record<string,string>} [args.env=process.env]
 * @param {string} [args.home=homedir()]
 * @param {string} [args.selfUrl=import.meta.url]
 * @param {string} [args.minVersion=MIN_RUNTIME_VERSION]
 * @param {{write:(s:string)=>void}} [args.stderr=process.stderr]
 * @returns {Promise<?string>}
 */
export async function discoverRuntimePluginRoot({
  env = process.env,
  home = homedir(),
  selfUrl = import.meta.url,
  minVersion = MIN_RUNTIME_VERSION,
  stderr = process.stderr,
} = {}) {
  const located = await locateRuntimePluginRoot({ env, home, selfUrl });
  if (!located.root) return null;
  if (!(await runtimeVersionAtLeast(located.root, minVersion))) return null;
  reportCrossHostFallback(located, stderr);
  return located.root;
}

/**
 * Locate the NEWEST runtime plugin root by manifest identity alone — the
 * ADR-0045 §7 capability-neutral rung for the entry-brief dispatcher. The
 * notify-gated resolver above requires `scripts/notify.mjs` before it will
 * even consider a root, which is capability-specific GATING, not the
 * capability-specific DISCOVERY the entry seam needs (a runtime build
 * carrying `context.mjs` but not `notify.mjs` must still be discoverable —
 * Codex Plan-verify reproduction), and it disagrees with the §18 readiness
 * diagnosis, which stats `context.mjs` in the NEWEST installed build.
 *
 * Candidates are directories whose manifest declares `name: "runtime"` —
 * no capability-file filter. That keeps the ADR-0039 §5 no-stale-fallback
 * invariant intact for the caller: this resolves ONE newest root; the
 * caller then applies its own floor gate and executor-existence probe to
 * THAT root and no-ops when either fails, never re-descending to an
 * older-but-capable build (exactly the dispatcher shape §18 mirrors).
 * Ladder (same order as locateRuntimePluginRoot): env override (absolute,
 * manifest-identified) → the caller's own host cache → the other host's
 * cache → sibling checkout (manifest-identified).
 *
 * @param {object} [args]
 * @param {Record<string,string>} [args.env=process.env]
 * @param {string} [args.home=homedir()]
 * @param {string} [args.selfUrl=import.meta.url]
 * @returns {Promise<{root: ?string, source: ?string, host: ?string,
 *   callerHost: string, crossHostFallback: boolean, version?: string,
 *   reason?: string}>}
 */
export async function locateNewestRuntimePluginRoot({
  env = process.env,
  home = homedir(),
  selfUrl = import.meta.url,
} = {}) {
  return locate({
    env,
    home,
    selfUrl,
    accepts: async (root) => (await readRuntimeManifestName(root)) === 'runtime',
    capabilityRel: null,
    describe: 'with a runtime manifest',
  });
}

/**
 * `locateNewestRuntimePluginRoot` without the provenance: the absolute root,
 * or `null` if nothing resolves.
 *
 * @param {object} [args]
 * @param {Record<string,string>} [args.env=process.env]
 * @param {string} [args.home=homedir()]
 * @param {string} [args.selfUrl=import.meta.url]
 * @param {{write:(s:string)=>void}} [args.stderr=process.stderr]
 * @returns {Promise<?string>}
 */
export async function resolveNewestRuntimePluginRoot({
  env = process.env,
  home = homedir(),
  selfUrl = import.meta.url,
  stderr = process.stderr,
} = {}) {
  const located = await locateNewestRuntimePluginRoot({ env, home, selfUrl });
  reportCrossHostFallback(located, stderr);
  return located.root;
}

// Read the plugin `name` from either manifest layout; null when unreadable.
async function readRuntimeManifestName(root) {
  for (const rel of [
    join('.claude-plugin', 'plugin.json'),
    join('.codex-plugin', 'plugin.json'),
  ]) {
    try {
      const manifest = JSON.parse(await fsReadFile(join(root, rel), 'utf8'));
      if (typeof manifest?.name === 'string') return manifest.name;
    } catch {
      /* try the other manifest layout */
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// CLI surface — a thin `discover` shim for manual sanity checks + debugging.
// The attention sensors call `discoverRuntimePluginRoot` in-process, so this
// CLI is not on any hook's critical path; it mirrors engineer's
// discover-runtime.mjs `discover` subcommand shape (empty stdout + exit 0
// means "not resolved"). `--json` prints the resolution with its provenance
// instead, so a diagnostic can report where the root came from.

async function cliMain(argv) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    process.stdout.write(
      [
        'plugins/attention/scripts/discover-runtime.mjs',
        '',
        'Usage:',
        '',
        '  discover [--json]',
        '    Resolve the runtime plugin root (env override → this host\'s install',
        '    cache → the other host\'s cache → sibling checkout), version-gated to',
        '    >= ' + MIN_RUNTIME_VERSION + ', and print the absolute path on stdout. Empty stdout',
        '    + exit 0 if not resolved or too old. --json prints one JSON object',
        '    with the root and where it came from.',
        '',
      ].join('\n'),
    );
    return 0;
  }
  if (subcommand === 'discover') {
    const unknown = rest.find((flag) => flag !== '--json');
    if (unknown) {
      process.stderr.write(`discover-runtime.mjs: unknown flag ${unknown}\n`);
      return 2;
    }
    if (rest.includes('--json')) {
      const located = await locateRuntimePluginRoot();
      const gated = located.root !== null && !(await runtimeVersionAtLeast(located.root));
      process.stdout.write(`${JSON.stringify({
        root: gated ? null : located.root,
        source: located.source,
        host: located.host,
        caller_host: located.callerHost,
        cross_host_fallback: located.crossHostFallback,
        ...(located.version ? { version: located.version } : {}),
        min_version: MIN_RUNTIME_VERSION,
        ...(gated
          ? { reason: `runtime at ${located.root} is below the ${MIN_RUNTIME_VERSION} floor` }
          : located.reason ? { reason: located.reason } : {}),
      })}\n`);
      return 0;
    }
    const root = await discoverRuntimePluginRoot();
    if (root) process.stdout.write(`${root}\n`);
    return 0;
  }
  process.stderr.write(`discover-runtime.mjs: unknown subcommand: ${subcommand}\n`);
  return 2;
}

// Run as a CLI only when this file is the entry point. Both sides are compared
// canonical and as paths, so an install reached through a symlink (with or
// without --preserve-symlinks-main), or under a directory whose name needs URL
// escaping (a space, '#', non-ASCII), still runs (ADR-0061 S2).
function invokedAsCli() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsCli()) {
  cliMain(process.argv.slice(2)).then((code) => process.exit(code ?? 0));
}
