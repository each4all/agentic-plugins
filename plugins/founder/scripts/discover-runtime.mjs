#!/usr/bin/env node
// plugins/founder/scripts/discover-runtime.mjs
//
// ADR-0039 §5 ladder, founder DUAL-CONSUMER copy (ADR-0043 §2/§4). Two
// runtime capabilities ride this resolver, each with its OWN floor and its
// OWN gating capability file:
//
//   - FOOTER (ADR-0043 S3): `session-handoff.mjs` `emitTerminalHandoffSidecar`
//     shells out to the runtime `scripts/footer.mjs render` to code-synthesize
//     the completion footer. Floor = MIN_RUNTIME_VERSION; every ladder rung
//     gates on `scripts/footer.mjs`.
//   - NOTIFY (ADR-0040 §5): `peer-runner.mjs`'s peer-run terminal self-sensor
//     shells out to the runtime `scripts/notify.mjs emit`. Floor =
//     NOTIFY_MIN_RUNTIME_VERSION; every ladder rung gates on
//     `scripts/notify.mjs`.
//
// The capability file is a PARAMETER (ADR-0043 §2): copying engineer's
// footer-gated resolver wholesale would silently change notify discovery from
// "notify exists" to "footer exists", so each consumer passes its own
// capability + floor and the two ladders stay independent (independent
// regression tests pin both).
//
// COPY-NOT-IMPORT (ADR-0010 §5). footer.mjs / notify.mjs are L1 runtime;
// founder is an L3 persona. A cross-plugin `import` would break SemVer
// independence, so this module lives INSIDE founder and discovers the runtime
// plugin root by filesystem inspection only; the eventual footer.mjs /
// notify.mjs invocation goes through `child_process`.
//
// The resolver runs IN-PROCESS on terminal hot paths (no CLI boundary), so the
// version gate is folded into `discoverRuntimePluginRoot` — it returns a root
// only when the gating capability file exists AND the runtime is new enough.
// A missing OR too-old runtime is a silent fail-closed (null), with NO
// fall-back to a stale cache (ADR-0039 §5): the ladder resolves ONE best
// root, then that root is version-gated; it is never re-discovered to find an
// older-but-present copy.
//
// Candidates follow ADR-0061 §Decision 3:
//   - each host's candidate is its versioned install cache —
//     ~/.claude/plugins/cache/agentic-plugins/runtime/<version>/ and
//     <CODEX_HOME or ~/.codex>/plugins/cache/agentic-plugins/runtime/<version>/,
//     manifest-name verified, newest SemVer carrying the capability first.
//     The Codex marketplace clone (~/.codex/.tmp/marketplaces/…) tracks the
//     repository's main branch and is never a candidate, not even a fallback.
//   - the caller's own host goes first. The other host's cache is used only
//     when the caller's host has no runtime installed, and that fallback is
//     reported. A runtime installed on the caller's host that lacks the
//     capability is a failure, not a reason to cross hosts.
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

// FOOTER floor (ADR-0043 §4): the first RELEASED runtime version containing
// the ADR-0043 S2 `VALID_WORKFLOW_KINDS` expansion to founder/designer —
// plugin-runtime-v0.79.0 (S2 landed on main as cb720e7, PR #555; released by
// #556 on 2026-07-12). Every released runtime ≥0.63.0 renders footers, but a
// runtime below THIS floor rejects `workflow_kind: founder` and renders the
// unsupported-kind degradation text instead of the real footer, so the
// producer-side floor is the only compatibility gate available (the projection
// JSON carries no version field). The S9 completion-output contract is
// additive-visible and deliberately does NOT move this floor
// (plugins/runtime/docs/completion-output-contract.md §1). A
// planned-but-unreleased version must never be pinned here — release-please
// owns the bump, and the gate below fail-closes on anything older.
export const MIN_RUNTIME_VERSION = '0.79.0';

// NOTIFY floor (ADR-0040 §5, UNCHANGED by the footer onboarding — ADR-0043 §4
// explicitly keeps the two floors separate): the first RELEASED runtime
// version shipping notify.mjs, plugin-runtime-v0.71.0 (macro checkpoint
// 2026-07-04). Notify emission is a released capability and must not be
// dragged up by the footer floor.
export const NOTIFY_MIN_RUNTIME_VERSION = '0.71.0';

// Gating capability files (basenames under `<runtime-root>/scripts/`). Each
// consumer passes its own so the footer ladder and the notify ladder never
// share a gate (ADR-0043 §2).
export const FOOTER_CAPABILITY = 'footer.mjs';
export const NOTIFY_CAPABILITY = 'notify.mjs';

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

// Strict floor gate: a prerelease of the floor version (e.g. `0.79.0-beta.1`)
// must NOT satisfy `>= 0.79.0` — the prerelease precedes its release. `min` is
// a clean release (one of the exported floors). Cores compared numerically; on
// an equal core, a prerelease `version` is treated as BELOW. A prerelease of a
// HIGHER core (e.g. `0.80.0-beta.1`) deliberately passes — it postdates the
// floor release and therefore carries the gated capability (SemVer ordering;
// same semantics as the engineer/orchestrator/attention sibling copies).
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
 * is but none carries `capabilityRel`, else `{ state: 'ok', root, version }`
 * for the newest that does.
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
      capable: await fileExists(join(versionRoot, capabilityRel)),
    });
  }
  if (installed.length === 0) return { state: 'absent' };
  installed.sort((a, b) => semverCompare(b.version, a.version));
  const capable = installed.find((c) => c.capable);
  if (!capable) return { state: 'unusable', version: installed[0].version };
  return { state: 'ok', root: capable.root, version: capable.version };
}

/**
 * Resolve the runtime plugin root containing `scripts/<capability>`, WITHOUT
 * the version gate, and report where it came from.
 *
 * @param {object} [args]
 * @param {Record<string,string>} [args.env=process.env]
 * @param {string} [args.home=homedir()]
 * @param {string} [args.selfUrl=import.meta.url]
 * @param {string} [args.capability=FOOTER_CAPABILITY] — gating file basename
 *   under `scripts/` (FOOTER_CAPABILITY | NOTIFY_CAPABILITY)
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
  capability = FOOTER_CAPABILITY,
} = {}) {
  const capabilityRel = join('scripts', capability);
  const hosts = hostLayout(env, home);
  const selfPath = selfPathOf(selfUrl);
  const caller = callerHostOf(selfPath, hosts);
  const callerHost = caller ?? 'checkout';

  // 1. Env override — absolute, and scripts/<capability> must exist. It never
  // falls through to the caches.
  const overrideRoot = env[ENV_OVERRIDE];
  if (typeof overrideRoot === 'string' && overrideRoot.length > 0) {
    if (isAbsolute(overrideRoot) && (await fileExists(join(overrideRoot, capabilityRel)))) {
      return { root: realOrResolved(overrideRoot), source: 'env', host: null, callerHost, crossHostFallback: false };
    }
    return {
      root: null,
      source: 'env',
      host: null,
      callerHost,
      crossHostFallback: false,
      reason: `${ENV_OVERRIDE}=${overrideRoot} is not an absolute runtime root with scripts/${capability}`,
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
        reason: `runtime ${install.version} in ${hosts[host].base} ships no scripts/${capability}`,
      };
    }
    return { root: realOrResolved(install.root), ...provenance, version: install.version };
  }

  // 3. Sibling checkout — only when this file itself runs from a checkout:
  // <founder-root>/scripts/discover-runtime.mjs → <founder-root>/../runtime.
  if (caller === null && selfPath) {
    const sibling = resolve(dirname(selfPath), '..', '..', 'runtime');
    // A sibling that resolves into an install cache or a marketplace clone is
    // not a checkout.
    const hostTrees = [...hosts.codex.roots, ...hosts.claude.roots];
    if (ownership(sibling, hostTrees) === 0 && (await fileExists(join(sibling, capabilityRel)))) {
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
      `founder/discover-runtime: runtime resolved from the ${located.host} plugin cache ` +
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
 * render or emit against a runtime we cannot vouch for.
 */
export async function runtimeVersionAtLeast(root, min = MIN_RUNTIME_VERSION) {
  const version = await readRuntimeVersion(root);
  if (!version) return false;
  return versionGte(version, min);
}

/**
 * Resolve the runtime plugin root directory containing
 * `scripts/<capability>`, WITHOUT the version gate: `locateRuntimePluginRoot`
 * without the provenance. Returns the absolute path, or `null` if nothing
 * resolves.
 *
 * @param {object} args
 * @param {Record<string,string>} [args.env=process.env]
 * @param {string} [args.home=homedir()]
 * @param {string} [args.selfUrl=import.meta.url]
 * @param {string} [args.capability=FOOTER_CAPABILITY] — gating file basename
 *   under `scripts/` (FOOTER_CAPABILITY | NOTIFY_CAPABILITY)
 * @param {{write:(s:string)=>void}} [args.stderr=process.stderr] — receives
 *   the cross-host fallback report
 * @returns {Promise<?string>}
 */
export async function resolveRuntimePluginRoot({
  env = process.env,
  home = homedir(),
  selfUrl = import.meta.url,
  capability = FOOTER_CAPABILITY,
  stderr = process.stderr,
} = {}) {
  const located = await locateRuntimePluginRoot({ env, home, selfUrl, capability });
  reportCrossHostFallback(located, stderr);
  return located.root;
}

/**
 * Resolve the runtime plugin root, version-gated. Returns the absolute root
 * ONLY when `scripts/<capability>` exists AND the runtime declares a version
 * >= `minVersion`. A missing OR too-old runtime returns `null` — the calling
 * terminal path then fail-closes silently (no footer / no notification, the
 * completion or peer-run lifecycle proceeds), with NO fall-back to a stale
 * cache (ADR-0039 §5).
 *
 * The defaults are the FOOTER pair; the notify consumer passes
 * `{ minVersion: NOTIFY_MIN_RUNTIME_VERSION, capability: NOTIFY_CAPABILITY }`
 * explicitly (ADR-0043 §2 — the two ladders never share a gate).
 *
 * @param {object} [args]
 * @param {Record<string,string>} [args.env=process.env]
 * @param {string} [args.home=homedir()]
 * @param {string} [args.selfUrl=import.meta.url]
 * @param {string} [args.minVersion=MIN_RUNTIME_VERSION]
 * @param {string} [args.capability=FOOTER_CAPABILITY]
 * @param {{write:(s:string)=>void}} [args.stderr=process.stderr]
 * @returns {Promise<?string>}
 */
export async function discoverRuntimePluginRoot({
  env = process.env,
  home = homedir(),
  selfUrl = import.meta.url,
  minVersion = MIN_RUNTIME_VERSION,
  capability = FOOTER_CAPABILITY,
  stderr = process.stderr,
} = {}) {
  const located = await locateRuntimePluginRoot({ env, home, selfUrl, capability });
  if (!located.root) return null;
  if (!(await runtimeVersionAtLeast(located.root, minVersion))) return null;
  reportCrossHostFallback(located, stderr);
  return located.root;
}

// -----------------------------------------------------------------------------
// CLI surface — a thin `discover` shim for manual sanity checks + debugging.
// The founder terminal paths call `discoverRuntimePluginRoot` in-process, so
// this CLI is not on any hot path; it mirrors the engineer copy's `discover`
// subcommand shape (empty stdout + exit 0 means "not resolved"). `--notify`
// switches to the notify pair so both ladders stay debuggable, and `--json`
// prints the resolution with its provenance, so a diagnostic can report where
// the root came from.

async function cliMain(argv) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    process.stdout.write(
      [
        'plugins/founder/scripts/discover-runtime.mjs',
        '',
        'Usage:',
        '',
        '  discover [--notify] [--json]',
        '    Resolve the runtime plugin root (env override → this host\'s install',
        '    cache → the other host\'s cache → sibling checkout). Default gates on',
        '    the FOOTER capability (scripts/footer.mjs, version >= ' + MIN_RUNTIME_VERSION + ');',
        '    --notify gates on scripts/notify.mjs, version >= ' + NOTIFY_MIN_RUNTIME_VERSION + '.',
        '    Prints the absolute path on stdout. Empty stdout + exit 0 if not',
        '    resolved or too old. --json prints one JSON object with the root and',
        '    where it came from.',
        '',
      ].join('\n'),
    );
    return 0;
  }
  if (subcommand === 'discover') {
    const unknown = rest.find((flag) => flag !== '--notify' && flag !== '--json');
    if (unknown) {
      process.stderr.write(`discover-runtime.mjs: unknown flag ${unknown}\n`);
      return 2;
    }
    const pair = rest.includes('--notify')
      ? { minVersion: NOTIFY_MIN_RUNTIME_VERSION, capability: NOTIFY_CAPABILITY }
      : { minVersion: MIN_RUNTIME_VERSION, capability: FOOTER_CAPABILITY };
    if (rest.includes('--json')) {
      const located = await locateRuntimePluginRoot({ capability: pair.capability });
      const gated = located.root !== null && !(await runtimeVersionAtLeast(located.root, pair.minVersion));
      process.stdout.write(`${JSON.stringify({
        root: gated ? null : located.root,
        source: located.source,
        host: located.host,
        caller_host: located.callerHost,
        cross_host_fallback: located.crossHostFallback,
        ...(located.version ? { version: located.version } : {}),
        capability: pair.capability,
        min_version: pair.minVersion,
        ...(gated
          ? { reason: `runtime at ${located.root} is below the ${pair.minVersion} floor` }
          : located.reason ? { reason: located.reason } : {}),
      })}\n`);
      return 0;
    }
    const root = await discoverRuntimePluginRoot(pair);
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
