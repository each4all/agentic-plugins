#!/usr/bin/env node
// plugins/designer/scripts/discover-runtime.mjs
//
// ADR-0039 §5 ladder, designer DUAL-CONSUMER copy (ADR-0043 §2/§4). Two
// runtime capabilities ride this resolver, each with its OWN floor and its
// OWN gating capability file:
//
//   - FOOTER (ADR-0043 S4): `session-handoff.mjs` `emitTerminalHandoffSidecar`
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
// designer is an L3 persona. A cross-plugin `import` would break SemVer
// independence, so this module lives INSIDE designer and discovers the runtime
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

import { stat, readdir, readFile as fsReadFile } from 'node:fs/promises';
import { join, isAbsolute, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ENV_OVERRIDE = 'AGENTIC_RUNTIME_ROOT';

// FOOTER floor (ADR-0043 §4): the first RELEASED runtime version containing
// the ADR-0043 S2 `VALID_WORKFLOW_KINDS` expansion to founder/designer —
// plugin-runtime-v0.79.0 (S2 landed on main as cb720e7, PR #555; released by
// #556 on 2026-07-12). Every released runtime ≥0.63.0 renders footers, but a
// runtime below THIS floor rejects `workflow_kind: designer` and renders the
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
 * render or emit against a runtime we cannot vouch for.
 */
export async function runtimeVersionAtLeast(root, min = MIN_RUNTIME_VERSION) {
  const version = await readRuntimeVersion(root);
  if (!version) return false;
  return versionGte(version, min);
}

/**
 * Resolve the runtime plugin root directory containing
 * `scripts/<capability>`, WITHOUT the version gate. Ladder (mirrors the
 * engineer/orchestrator copies):
 *   1. `AGENTIC_RUNTIME_ROOT` env override (absolute + scripts/<capability> must exist)
 *   2. Claude cache layout (multi-version; latest SemVer whose plugin.json
 *      `name` is "runtime" and whose scripts/<capability> exists)
 *   3. Codex cache layout (single fixed path)
 *   4. Sibling fallback — derive designer's own plugin root from `import.meta.url`
 *      (this file at `<designer-root>/scripts/...`) and look for
 *      `<designer-root>/../runtime/scripts/<capability>`.
 * Returns the absolute path on first hit, `null` if nothing resolves.
 *
 * @param {object} args
 * @param {Record<string,string>} [args.env=process.env]
 * @param {string} [args.home=homedir()]
 * @param {string} [args.selfUrl=import.meta.url]
 * @param {string} [args.capability=FOOTER_CAPABILITY] — gating file basename
 *   under `scripts/` (FOOTER_CAPABILITY | NOTIFY_CAPABILITY)
 * @returns {Promise<?string>}
 */
export async function resolveRuntimePluginRoot({
  env = process.env,
  home = homedir(),
  selfUrl = import.meta.url,
  capability = FOOTER_CAPABILITY,
} = {}) {
  const capabilityRel = join('scripts', capability);
  // 1. Env override.
  const overrideRoot = env[ENV_OVERRIDE];
  if (typeof overrideRoot === 'string' && overrideRoot.length > 0) {
    if (!isAbsolute(overrideRoot)) {
      return null;
    }
    if (await fileExists(join(overrideRoot, capabilityRel))) {
      return overrideRoot;
    }
    return null;
  }

  const { claude: claudeBase, codex: codexBase } = cacheBases(home);

  // Same-host preference (mirrors discover-engineer's Codex P2 finding): when
  // designer runs from one host's install and a stale opposite-host runtime
  // cache also exists, probe the matching cache FIRST so the render/emit uses
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
      if (!(await fileExists(join(versionRoot, capabilityRel)))) continue;
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
        && (await fileExists(join(codexBase, capabilityRel)))) {
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

  // 4. Sibling fallback — derive designer's plugin root from selfUrl, then look
  // one level up and over for the runtime peer.
  if (typeof selfUrl === 'string' && selfUrl.length > 0) {
    let here;
    try {
      here = fileURLToPath(selfUrl);
    } catch {
      here = null;
    }
    if (here) {
      // here = <designer-root>/scripts/discover-runtime.mjs
      // dirname(here) = <designer-root>/scripts
      // resolve(..., '..', '..', 'runtime') = sibling runtime plugin
      const sibling = resolve(dirname(here), '..', '..', 'runtime');
      if (await fileExists(join(sibling, capabilityRel))) {
        return sibling;
      }
    }
  }

  return null;
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
 * @returns {Promise<?string>}
 */
export async function discoverRuntimePluginRoot({
  env = process.env,
  home = homedir(),
  selfUrl = import.meta.url,
  minVersion = MIN_RUNTIME_VERSION,
  capability = FOOTER_CAPABILITY,
} = {}) {
  const root = await resolveRuntimePluginRoot({ env, home, selfUrl, capability });
  if (!root) return null;
  if (!(await runtimeVersionAtLeast(root, minVersion))) return null;
  return root;
}

// -----------------------------------------------------------------------------
// CLI surface — a thin `discover` shim for manual sanity checks + debugging.
// The designer terminal paths call `discoverRuntimePluginRoot` in-process, so
// this CLI is not on any hot path; it mirrors the engineer copy's `discover`
// subcommand shape (empty stdout + exit 0 means "not resolved"). `--notify`
// switches to the notify pair so both ladders stay debuggable.

async function cliMain(argv) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    process.stdout.write(
      [
        'plugins/designer/scripts/discover-runtime.mjs',
        '',
        'Usage:',
        '',
        '  discover [--notify]',
        '    Resolve the runtime plugin root (env override → Claude cache →',
        '    Codex cache → sibling fallback). Default gates on the FOOTER',
        '    capability (scripts/footer.mjs, version >= ' + MIN_RUNTIME_VERSION + ');',
        '    --notify gates on scripts/notify.mjs, version >= ' + NOTIFY_MIN_RUNTIME_VERSION + '.',
        '    Prints the absolute path on stdout. Empty stdout + exit 0 if not',
        '    resolved or too old.',
        '',
      ].join('\n'),
    );
    return 0;
  }
  if (subcommand === 'discover') {
    const notify = rest.includes('--notify');
    const root = await discoverRuntimePluginRoot(
      notify
        ? { minVersion: NOTIFY_MIN_RUNTIME_VERSION, capability: NOTIFY_CAPABILITY }
        : {},
    );
    if (root) process.stdout.write(`${root}\n`);
    return 0;
  }
  process.stderr.write(`discover-runtime.mjs: unknown subcommand: ${subcommand}\n`);
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain(process.argv.slice(2)).then((code) => process.exit(code ?? 0));
}
