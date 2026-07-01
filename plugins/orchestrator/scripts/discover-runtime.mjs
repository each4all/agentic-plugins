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
// `discover-engineer.mjs` env → Claude-cache-SemVer → Codex-fixed-cache →
// sibling-monorepo ladder, inverted to search for the runtime peer and gated on
// a minimum runtime version. It is byte-for-byte the engineer copy of the same
// resolver save for these plugin-name comments (ADR-0039 §5 per-plugin copy).
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

import { stat, readdir, readFile as fsReadFile } from 'node:fs/promises';
import { join, isAbsolute, resolve, dirname } from 'node:path';
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

async function fileExists(path) {
  try {
    const st = await stat(path);
    return st.isFile();
  } catch {
    return false;
  }
}

async function dirExists(path) {
  try {
    const st = await stat(path);
    return st.isDirectory();
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

function cacheBases(home) {
  return {
    claude: join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'runtime'),
    codex: join(home, '.codex', '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'runtime'),
  };
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
 * WITHOUT the version gate. Ladder (mirrors discover-engineer.mjs):
 *   1. `AGENTIC_RUNTIME_ROOT` env override (absolute + scripts/footer.mjs must exist)
 *   2. Claude cache layout (multi-version; latest SemVer whose plugin.json
 *      `name` is "runtime" and whose scripts/footer.mjs exists)
 *   3. Codex cache layout (single fixed path)
 *   4. Sibling fallback — derive orchestrator's own plugin root from `import.meta.url`
 *      (this file at `<orchestrator-root>/scripts/...`) and look for
 *      `<orchestrator-root>/../runtime/scripts/footer.mjs`.
 * Returns the absolute path on first hit, `null` if nothing resolves.
 *
 * @param {object} args
 * @param {Record<string,string>} [args.env=process.env]
 * @param {string} [args.home=homedir()]
 * @param {string} [args.selfUrl=import.meta.url]
 * @returns {Promise<?string>}
 */
export async function resolveRuntimePluginRoot({
  env = process.env,
  home = homedir(),
  selfUrl = import.meta.url,
} = {}) {
  // 1. Env override.
  const overrideRoot = env[ENV_OVERRIDE];
  if (typeof overrideRoot === 'string' && overrideRoot.length > 0) {
    if (!isAbsolute(overrideRoot)) {
      return null;
    }
    if (await fileExists(join(overrideRoot, 'scripts', 'footer.mjs'))) {
      return overrideRoot;
    }
    return null;
  }

  const { claude: claudeBase, codex: codexBase } = cacheBases(home);

  // Same-host preference (mirrors discover-engineer's Codex P2 finding): when
  // orchestrator runs from one host's install and a stale opposite-host runtime
  // cache also exists, probe the matching cache FIRST so the footer render uses
  // the same-host runtime. Detect host from selfUrl.
  let sameHost = null;
  if (typeof selfUrl === 'string' && selfUrl.length > 0) {
    if (selfUrl.includes('/.codex/')) sameHost = 'codex';
    else if (selfUrl.includes('/.claude/')) sameHost = 'claude';
  }

  async function probeClaudeCache() {
    if (!(await dirExists(claudeBase))) return null;
    let entries = [];
    try {
      entries = await readdir(claudeBase, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const versionRoot = join(claudeBase, entry.name);
      const manifestFile = join(versionRoot, '.claude-plugin', 'plugin.json');
      let manifest;
      try {
        manifest = JSON.parse(await fsReadFile(manifestFile, 'utf8'));
      } catch {
        continue;
      }
      if (manifest?.name !== 'runtime') continue;
      const footerPath = join(versionRoot, 'scripts', 'footer.mjs');
      if (!(await fileExists(footerPath))) continue;
      candidates.push({
        version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
        root: versionRoot,
      });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => semverCompare(b.version, a.version));
    return candidates[0].root;
  }
  async function probeCodexCache() {
    if ((await dirExists(codexBase))
        && (await fileExists(join(codexBase, 'scripts', 'footer.mjs')))) {
      return codexBase;
    }
    return null;
  }

  // 2 + 3: probe caches in same-host-first order.
  const order = sameHost === 'codex'
    ? [probeCodexCache, probeClaudeCache]
    : [probeClaudeCache, probeCodexCache];
  for (const probe of order) {
    const root = await probe();
    if (root) return root;
  }

  // 4. Sibling fallback — derive orchestrator's plugin root from selfUrl, then
  // look one level up and over for the runtime peer.
  if (typeof selfUrl === 'string' && selfUrl.length > 0) {
    let here;
    try {
      here = fileURLToPath(selfUrl);
    } catch {
      here = null;
    }
    if (here) {
      // here = <orchestrator-root>/scripts/discover-runtime.mjs
      // dirname(here) = <orchestrator-root>/scripts
      // resolve(..., '..', '..', 'runtime') = sibling runtime plugin
      const sibling = resolve(dirname(here), '..', '..', 'runtime');
      if (await fileExists(join(sibling, 'scripts', 'footer.mjs'))) {
        return sibling;
      }
    }
  }

  return null;
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
 * @returns {Promise<?string>}
 */
export async function discoverRuntimePluginRoot({
  env = process.env,
  home = homedir(),
  selfUrl = import.meta.url,
  minVersion = MIN_RUNTIME_VERSION,
} = {}) {
  const root = await resolveRuntimePluginRoot({ env, home, selfUrl });
  if (!root) return null;
  if (!(await runtimeVersionAtLeast(root, minVersion))) return null;
  return root;
}

// -----------------------------------------------------------------------------
// CLI surface — a thin `discover` shim for manual sanity checks + debugging.
// The orchestrator terminal path calls `discoverRuntimePluginRoot` in-process,
// so this CLI is not on any runbook's critical path; it mirrors
// discover-engineer.mjs's `discover` subcommand shape (empty stdout + exit 0
// means "not resolved").

async function cliMain(argv) {
  const [subcommand] = argv;
  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    process.stdout.write(
      [
        'plugins/orchestrator/scripts/discover-runtime.mjs',
        '',
        'Usage:',
        '',
        '  discover',
        '    Resolve the runtime plugin root (env override → Claude cache →',
        '    Codex cache → sibling fallback), version-gated to >= ' + MIN_RUNTIME_VERSION + ',',
        '    and print the absolute path on stdout. Empty stdout + exit 0 if',
        '    not resolved or too old.',
        '',
      ].join('\n'),
    );
    return 0;
  }
  if (subcommand === 'discover') {
    const root = await discoverRuntimePluginRoot();
    if (root) process.stdout.write(`${root}\n`);
    return 0;
  }
  process.stderr.write(`discover-runtime.mjs: unknown subcommand: ${subcommand}\n`);
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain(process.argv.slice(2)).then((code) => process.exit(code ?? 0));
}
