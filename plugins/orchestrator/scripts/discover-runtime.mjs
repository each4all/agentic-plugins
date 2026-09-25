#!/usr/bin/env node
// plugins/orchestrator/scripts/discover-runtime.mjs
//
// ADR-0039 §5 — runtime plugin root resolver. The orchestrator terminal path
// (session-handoff.mjs `emitTerminalHandoffSidecar`) shells out to the runtime
// plugin's `scripts/footer.mjs render` to code-synthesize the completion footer
// after it writes the ADR-0031 macro projection. Locating `footer.mjs` at the
// installed runtime plugin root requires this resolver.
//
// COPY-NOT-IMPORT (ADR-0010 §5). footer.mjs is L1 runtime; orchestrator is L2. A
// capability plugin cannot `import` a runtime module (that would break SemVer
// independence). This module lives INSIDE orchestrator and discovers the runtime
// plugin root by filesystem inspection only; the eventual footer.mjs invocation
// goes through `child_process` exec. It is a deliberate copy of the sibling
// `discover-engineer.mjs` ladder (env override → the caller's own host install
// cache → the other host's cache → sibling checkout), inverted to search for
// the runtime peer and gated on a minimum runtime version. It is byte-for-byte
// the engineer copy of the same resolver save for its plugin-name comments and
// the plugin name in its diagnostic prefix (ADR-0039 §5 per-plugin copy).
//
// DIVERGENCE from discover-engineer.mjs's discover/preflight split: that module
// exposes discovery and capability-preflight as two CLI subcommands because the
// /orchestrator:next runbook shells out to each in turn. Here the resolver runs
// IN-PROCESS on the orchestrator terminal hot path (no CLI boundary), so the
// version gate is folded into `discoverRuntimePluginRoot` — it returns a root
// only when footer.mjs exists AND the runtime is new enough. A missing OR
// too-old runtime is a silent fail-closed (null), with NO fall-back to a stale
// cache (ADR-0039 §5): the ladder resolves ONE best root, then that root is
// version-gated; it is never re-discovered to find an older-but-present copy.
//
// Candidates follow ADR-0061 §Decision 3:
//   - each host's candidate is its versioned install cache —
//     ~/.claude/plugins/cache/agentic-plugins/runtime/<version>/ and
//     <CODEX_HOME or ~/.codex>/plugins/cache/agentic-plugins/runtime/<version>/,
//     manifest-name verified, newest SemVer carrying scripts/footer.mjs first.
//     The Codex marketplace clone (~/.codex/.tmp/marketplaces/…) tracks the
//     repository's main branch and is never a candidate, not even a fallback.
//   - the caller's own host goes first. The other host's cache is used only
//     when the caller's host has no runtime installed, and that fallback is
//     reported. A runtime installed on the caller's host that carries no
//     footer.mjs is a failure, not a reason to cross hosts.
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

// The floor runtime version whose `footer.mjs render` interface carries every
// flag the orchestrator wiring passes. `--workflow-projection-file` (ADR-0031)
// landed in runtime 0.63.0 (commit f78935a) — the newest of the required
// render flags (`--context-state`/`--completion-state`/`--recommended-next-work`
// predate it), so 0.63.0 is the effective floor. A runtime below this would
// throw "Unknown argument" on render → the subprocess fail-closes anyway, but
// gating here avoids spawning a doomed child and gives a clean "too old" signal.
export const MIN_RUNTIME_VERSION = '0.63.0';

// The floor runtime version whose `notify.mjs emit` interface exists at all
// (ADR-0040 §5 peer-run terminal self-sensor). Pinned to the FIRST RELEASED
// runtime version shipping notify.mjs: plugin-runtime-v0.71.0 (the ADR-0040
// release-gate pin; same constant as the attention sibling's
// MIN_RUNTIME_VERSION). This is a SEPARATE, higher floor than
// MIN_RUNTIME_VERSION above — the footer floor stays 0.63.0 so terminal
// footers keep rendering against older runtimes, while notify emission
// fail-closes silently below 0.71.0 (peer-runner.mjs passes this as
// `minVersion` to `discoverRuntimePluginRoot`).
export const NOTIFY_MIN_RUNTIME_VERSION = '0.71.0';

async function fileExists(path) {
  try {
    const st = await stat(path);
    return st.isFile();
  } catch {
    return false;
  }
}

// Ordering compare for CACHE SELECTION (pick the latest). Prereleases sort by
// their numeric core here — good enough for "newest candidate"; the strict
// gate below (`versionGte`) is what actually enforces the floor.
function semverCompare(a, b) {
  const pa = String(a).split('-', 1)[0].split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).split('-', 1)[0].split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// Strict floor gate (Codex Plan-verify MINOR): a prerelease of the floor version
// (e.g. `0.63.0-beta.1`) must NOT satisfy `>= 0.63.0` — the prerelease precedes
// its release. `min` is a clean release (MIN_RUNTIME_VERSION). Cores compared
// numerically; on an equal core, a prerelease `version` is treated as BELOW.
function versionGte(version, min) {
  const [core, prerelease] = String(version).split('-', 2);
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
 * is but none carries scripts/footer.mjs, else `{ state: 'ok', root, version }`
 * for the newest that does.
 */
async function newestRuntimeInstall({ base, manifest }) {
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
      capable: await fileExists(join(versionRoot, 'scripts', 'footer.mjs')),
    });
  }
  if (installed.length === 0) return { state: 'absent' };
  installed.sort((a, b) => semverCompare(b.version, a.version));
  const capable = installed.find((c) => c.capable);
  if (!capable) return { state: 'unusable', version: installed[0].version };
  return { state: 'ok', root: capable.root, version: capable.version };
}

/**
 * Resolve the runtime plugin root containing `scripts/footer.mjs`, WITHOUT the
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
  const hosts = hostLayout(env, home);
  const selfPath = selfPathOf(selfUrl);
  const caller = callerHostOf(selfPath, hosts);
  const callerHost = caller ?? 'checkout';

  // 1. Env override — absolute, and scripts/footer.mjs must exist. It never
  // falls through to the caches.
  const overrideRoot = env[ENV_OVERRIDE];
  if (typeof overrideRoot === 'string' && overrideRoot.length > 0) {
    if (isAbsolute(overrideRoot) && (await fileExists(join(overrideRoot, 'scripts', 'footer.mjs')))) {
      return { root: realOrResolved(overrideRoot), source: 'env', host: null, callerHost, crossHostFallback: false };
    }
    return {
      root: null,
      source: 'env',
      host: null,
      callerHost,
      crossHostFallback: false,
      reason: `${ENV_OVERRIDE}=${overrideRoot} is not an absolute runtime root with scripts/footer.mjs`,
    };
  }

  // 2. Install caches, the caller's own host first.
  const order = caller === 'codex' ? ['codex', 'claude'] : ['claude', 'codex'];
  for (const host of order) {
    const install = await newestRuntimeInstall(hosts[host]);
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
        reason: `runtime ${install.version} in ${hosts[host].base} ships no scripts/footer.mjs`,
      };
    }
    return { root: realOrResolved(install.root), ...provenance, version: install.version };
  }

  // 3. Sibling checkout — only when this file itself runs from a checkout:
  // <orchestrator-root>/scripts/discover-runtime.mjs → <orchestrator-root>/../runtime.
  if (caller === null && selfPath) {
    const sibling = resolve(dirname(selfPath), '..', '..', 'runtime');
    // A sibling that resolves into an install cache or a marketplace clone is
    // not a checkout.
    const hostTrees = [...hosts.codex.roots, ...hosts.claude.roots];
    if (ownership(sibling, hostTrees) === 0 && (await fileExists(join(sibling, 'scripts', 'footer.mjs')))) {
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
// reporting must never break a terminal path.
function reportCrossHostFallback(located, stderr) {
  if (!located.root || !located.crossHostFallback) return;
  try {
    stderr.write(
      `orchestrator/discover-runtime: runtime resolved from the ${located.host} plugin cache ` +
      `because the ${located.callerHost} cache has no runtime installed\n`,
    );
  } catch {
    /* reporting is advisory */
  }
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
 * render against a runtime we cannot vouch for.
 */
export async function runtimeVersionAtLeast(root, min = MIN_RUNTIME_VERSION) {
  const version = await readRuntimeVersion(root);
  if (!version) return false;
  return versionGte(version, min);
}

/**
 * Resolve the runtime plugin root directory containing `scripts/footer.mjs`,
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
 * ONLY when `scripts/footer.mjs` exists AND the runtime declares a version >=
 * `minVersion`. A missing OR too-old runtime returns `null` — the orchestrator
 * terminal path then fail-closes silently (no footer, the completion proceeds),
 * with NO fall-back to a stale cache (ADR-0039 §5).
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

// -----------------------------------------------------------------------------
// CLI surface — a thin `discover` shim for manual sanity checks + debugging.
// The orchestrator terminal path calls `discoverRuntimePluginRoot` in-process,
// so this CLI is not on any runbook's critical path; it mirrors
// discover-engineer.mjs's `discover` subcommand shape (empty stdout + exit 0
// means "not resolved"). `--json` prints the resolution with its provenance
// instead, so a diagnostic can report where the root came from.

async function cliMain(argv) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    process.stdout.write(
      [
        'plugins/orchestrator/scripts/discover-runtime.mjs',
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
