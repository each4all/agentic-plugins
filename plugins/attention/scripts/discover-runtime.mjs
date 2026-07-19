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
// `discover-engineer.mjs` env → Claude-cache-SemVer → Codex-fixed-cache →
// sibling-monorepo ladder), re-gated on `scripts/notify.mjs` instead of
// `scripts/footer.mjs`.
//
// The resolver runs IN-PROCESS on hook hot paths (no CLI boundary), so the
// version gate is folded into `discoverRuntimePluginRoot` — it returns a root
// only when notify.mjs exists AND the runtime is new enough. A missing OR
// too-old runtime is a silent fail-closed (null), with NO fall-back to a stale
// cache (ADR-0039 §5): the ladder resolves ONE best root, then that root is
// version-gated; it is never re-discovered to find an older-but-present copy.

import { stat, readdir, readFile as fsReadFile } from 'node:fs/promises';
import { join, isAbsolute, resolve, dirname } from 'node:path';
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

// Strict floor gate: a prerelease of the floor version (e.g. `0.71.0-beta.1`)
// must NOT satisfy `>= 0.71.0` — the prerelease precedes its release. `min` is
// a clean release (MIN_RUNTIME_VERSION). Cores compared numerically; on an
// equal core, a prerelease `version` is treated as BELOW. A prerelease of a
// HIGHER core (e.g. `0.72.0-beta.1`) deliberately passes — it postdates the
// floor release and therefore carries notify.mjs (SemVer ordering; same
// semantics as the engineer sibling copy).
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
 * emit against a runtime we cannot vouch for.
 */
export async function runtimeVersionAtLeast(root, min = MIN_RUNTIME_VERSION) {
  const version = await readRuntimeVersion(root);
  if (!version) return false;
  return versionGte(version, min);
}

/**
 * Resolve the runtime plugin root directory containing `scripts/notify.mjs`,
 * WITHOUT the version gate. Ladder (mirrors engineer's discover-runtime.mjs):
 *   1. `AGENTIC_RUNTIME_ROOT` env override (absolute + scripts/notify.mjs must exist)
 *   2. Claude cache layout (multi-version; latest SemVer whose plugin.json
 *      `name` is "runtime" and whose scripts/notify.mjs exists)
 *   3. Codex cache layout (single fixed path)
 *   4. Sibling fallback — derive attention's own plugin root from `import.meta.url`
 *      (this file at `<attention-root>/scripts/...`) and look for
 *      `<attention-root>/../runtime/scripts/notify.mjs`.
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
    if (await fileExists(join(overrideRoot, 'scripts', 'notify.mjs'))) {
      return overrideRoot;
    }
    return null;
  }

  const { claude: claudeBase, codex: codexBase } = cacheBases(home);

  // Same-host preference (mirrors discover-engineer's Codex P2 finding): when
  // attention runs from one host's install and a stale opposite-host runtime
  // cache also exists, probe the matching cache FIRST so the emit uses the
  // same-host runtime. Detect host from selfUrl.
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
      const notifyPath = join(versionRoot, 'scripts', 'notify.mjs');
      if (!(await fileExists(notifyPath))) continue;
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
        && (await fileExists(join(codexBase, 'scripts', 'notify.mjs')))) {
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

  // 4. Sibling fallback — derive attention's plugin root from selfUrl, then look
  // one level up and over for the runtime peer.
  if (typeof selfUrl === 'string' && selfUrl.length > 0) {
    let here;
    try {
      here = fileURLToPath(selfUrl);
    } catch {
      here = null;
    }
    if (here) {
      // here = <attention-root>/scripts/discover-runtime.mjs
      // dirname(here) = <attention-root>/scripts
      // resolve(..., '..', '..', 'runtime') = sibling runtime plugin
      const sibling = resolve(dirname(here), '..', '..', 'runtime');
      if (await fileExists(join(sibling, 'scripts', 'notify.mjs'))) {
        return sibling;
      }
    }
  }

  return null;
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
// The attention sensors call `discoverRuntimePluginRoot` in-process, so this
// CLI is not on any hook's critical path; it mirrors engineer's
// discover-runtime.mjs `discover` subcommand shape (empty stdout + exit 0
// means "not resolved").

async function cliMain(argv) {
  const [subcommand] = argv;
  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    process.stdout.write(
      [
        'plugins/attention/scripts/discover-runtime.mjs',
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
