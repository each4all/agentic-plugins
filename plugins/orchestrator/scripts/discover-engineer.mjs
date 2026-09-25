#!/usr/bin/env node
// plugins/orchestrator/scripts/discover-engineer.mjs
//
// ADR-0019 PR-D — engineer plugin root resolver. Used by
// /orchestrator:next + /orchestrator:done runbooks to locate the
// engineer plugin's scripts/state.mjs across:
//   - Claude Code's versioned `~/.claude/plugins/cache/agentic-plugins/engineer/<version>/`
//   - Codex CLI's versioned `<CODEX_HOME or ~/.codex>/plugins/cache/agentic-plugins/engineer/<version>/`
//   - dev checkouts (monorepo), only when orchestrator itself runs from one
//
// Mirrors plugins/engineer/scripts/parent-writeback.mjs's
// `discoverOrchestratorPluginRoot` (PR-C) — same env-then-cache-then-
// sibling ladder, just inverted (orchestrator side searching for the
// engineer peer instead of engineer searching for orchestrator).
//
// Candidates follow ADR-0061 §Decision 3:
//   - each host's candidate is its versioned install cache, manifest-name
//     verified, newest SemVer carrying scripts/state.mjs first. The Codex
//     marketplace clone (~/.codex/.tmp/marketplaces/…) tracks the repository's
//     main branch and is never a candidate, not even a fallback.
//   - the caller's own host goes first. The other host's cache is used only
//     when the caller's host has no engineer installed, and that fallback is
//     reported. An engineer installed on the caller's host that carries no
//     scripts/state.mjs is a failure, not a reason to cross hosts.
//   - the caller's host is decided against the host's install cache and
//     marketplace clone trees, each also by its canonical path, so a custom
//     or symlinked $CODEX_HOME counts, a '/.codex/' path segment alone does
//     not, and a checkout elsewhere under a host's home is still a checkout.
//   - every returned root is canonical, so the CLI it leads to runs.
//   - the sibling checkout applies only when this file runs from a checkout,
//     never from a host install or a marketplace clone.
//
// Companion responsibility: minimum-version preflight via
// `preflightEngineerCapability(root)` — feature-probes
// `state.mjs create --help` for the `--parent-workflow` flag that
// landed in ADR-0019 PR-A. Pre-PR-A engineer installs lack the flag
// and would silently break the parent linkage if dispatched — the
// preflight gates that case at dispatch time with a clear diagnostic.
//
// Cross-plugin import boundary (ADR-0010 §5): this module lives inside
// orchestrator and discovers the engineer plugin root by filesystem
// inspection only. It does NOT import any engineer module. The eventual
// state.mjs invocation goes through `child_process` exec by orchestrator
// runbooks downstream — same shape as PR-C's parent-writeback.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, readdir, readFile as fsReadFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, isAbsolute, resolve, dirname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const execFileAsync = promisify(execFile);

const ENV_OVERRIDE = 'AGENTIC_ENGINEER_ROOT';

async function fileExists(path) {
  try {
    const st = await stat(path);
    return st.isFile();
  } catch {
    return false;
  }
}

function semverCompare(a, b) {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
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
      base: join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'engineer'),
      manifest: join('.claude-plugin', 'plugin.json'),
    },
    codex: {
      roots: [
        join(codexHome, 'plugins', 'cache'),
        join(codexHome, '.tmp', 'marketplaces'),
      ],
      base: join(codexHome, 'plugins', 'cache', 'agentic-plugins', 'engineer'),
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
 * The engineer install in one host cache: `{ state: 'absent' }` when no
 * manifest-verified engineer is there, `{ state: 'unusable', version }` when
 * one is but none carries scripts/state.mjs, else `{ state: 'ok', root,
 * version }` for the newest that does.
 */
async function newestEngineerInstall({ base, manifest }) {
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
    if (parsed?.name !== 'engineer') continue;
    installed.push({
      version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
      root: versionRoot,
      capable: await fileExists(join(versionRoot, 'scripts', 'state.mjs')),
    });
  }
  if (installed.length === 0) return { state: 'absent' };
  installed.sort((a, b) => semverCompare(b.version, a.version));
  const capable = installed.find((c) => c.capable);
  if (!capable) return { state: 'unusable', version: installed[0].version };
  return { state: 'ok', root: capable.root, version: capable.version };
}

/**
 * Resolve the engineer plugin root directory containing
 * `scripts/state.mjs`, and report where it came from. Tries:
 *   1. `AGENTIC_ENGINEER_ROOT` env override (must be absolute +
 *      scripts/state.mjs must exist); it never falls through
 *   2. the install cache of the host orchestrator itself runs from, then the
 *      other host's cache only when the first has no engineer installed
 *      (Claude first for a checkout caller)
 *   3. Sibling fallback, only when orchestrator runs from a checkout —
 *      derive orchestrator's own plugin root from `import.meta.url`
 *      (this file at `<orchestrator-root>/scripts/...`) and look for
 *      `<orchestrator-root>/../engineer/scripts/state.mjs`.
 *      Mirrors `plugins/engineer/scripts/parent-writeback.mjs`'s
 *      sibling fallback. Does NOT depend on any caller-supplied
 *      repoRoot — that would be the user's target project, not the
 *      orchestrator plugin checkout.
 *
 * @param {object} args
 * @param {Record<string,string>} [args.env=process.env]
 * @param {string} [args.home=homedir()]
 * @param {string} [args.selfUrl=import.meta.url]
 * @returns {Promise<{root: ?string, source: ?string, host: ?string,
 *   callerHost: string, crossHostFallback: boolean, version?: string,
 *   reason?: string}>} `source` is 'env', 'claude-cache', 'codex-cache',
 *   'sibling', or null when nothing resolved; `callerHost` is 'codex',
 *   'claude' or 'checkout'.
 */
export async function locateEngineerPluginRoot({
  env = process.env,
  home = homedir(),
  selfUrl = import.meta.url,
} = {}) {
  const hosts = hostLayout(env, home);
  const selfPath = selfPathOf(selfUrl);
  const caller = callerHostOf(selfPath, hosts);
  const callerHost = caller ?? 'checkout';

  // 1. Env override.
  const overrideRoot = env[ENV_OVERRIDE];
  if (typeof overrideRoot === 'string' && overrideRoot.length > 0) {
    if (isAbsolute(overrideRoot) && (await fileExists(join(overrideRoot, 'scripts', 'state.mjs')))) {
      return { root: realOrResolved(overrideRoot), source: 'env', host: null, callerHost, crossHostFallback: false };
    }
    return {
      root: null,
      source: 'env',
      host: null,
      callerHost,
      crossHostFallback: false,
      reason: `${ENV_OVERRIDE}=${overrideRoot} is not an absolute engineer root with scripts/state.mjs`,
    };
  }

  // 2. Install caches, the caller's own host first. Same-host preference
  // (Codex P2 finding): when orchestrator runs from a Codex install and a
  // stale Claude engineer cache also exists, returning the Claude cache first
  // would route dispatch to the wrong host's engineer (with potentially
  // missing PR-D Phase 0 env-var contract).
  const order = caller === 'codex' ? ['codex', 'claude'] : ['claude', 'codex'];
  for (const host of order) {
    const install = await newestEngineerInstall(hosts[host]);
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
        reason: `engineer ${install.version} in ${hosts[host].base} ships no scripts/state.mjs`,
      };
    }
    return { root: realOrResolved(install.root), ...provenance, version: install.version };
  }

  // 3. Sibling checkout — <orch-root>/scripts/discover-engineer.mjs →
  // <orch-root>/../engineer.
  if (caller === null && selfPath) {
    const sibling = resolve(dirname(selfPath), '..', '..', 'engineer');
    // A sibling that resolves into an install cache or a marketplace clone is
    // not a checkout.
    const hostTrees = [...hosts.codex.roots, ...hosts.claude.roots];
    if (ownership(sibling, hostTrees) === 0 && (await fileExists(join(sibling, 'scripts', 'state.mjs')))) {
      return { root: realOrResolved(sibling), source: 'sibling', host: null, callerHost, crossHostFallback: false };
    }
  }

  return {
    root: null,
    source: null,
    host: null,
    callerHost,
    crossHostFallback: false,
    reason: 'engineer plugin is not installed in the Claude or Codex plugin cache',
  };
}

/**
 * `locateEngineerPluginRoot` without the provenance: the absolute root, or
 * `null` if nothing resolves. A root taken from the other host's cache is
 * reported on `stderr` (ADR-0061 §Decision 4): once the catalog pins are
 * active, a Codex install holds a release commit and the other host's copy
 * does not.
 *
 * @param {object} args
 * @param {Record<string,string>} [args.env=process.env]
 * @param {string} [args.home=homedir()]
 * @param {string} [args.selfUrl=import.meta.url]
 * @param {{write:(s:string)=>void}} [args.stderr=process.stderr]
 * @returns {Promise<?string>}
 */
export async function discoverEngineerPluginRoot({
  env = process.env,
  home = homedir(),
  selfUrl = import.meta.url,
  stderr = process.stderr,
} = {}) {
  const located = await locateEngineerPluginRoot({ env, home, selfUrl });
  if (located.root && located.crossHostFallback) {
    try {
      stderr.write(
        `orchestrator/discover-engineer: engineer resolved from the ${located.host} plugin cache ` +
        `because the ${located.callerHost} cache has no engineer installed\n`,
      );
    } catch {
      /* reporting is advisory */
    }
  }
  return located.root;
}

/**
 * Feature-probe the engineer plugin install for ADR-0019 PR-A
 * `--parent-workflow` flag support. Reads the engineer
 * `scripts/state.mjs` source and greps for the
 * `'parent-workflow'` token — PR-A wires the flag as a key into the
 * CLI parser's `flags` object, so the literal string appears in source
 * whenever the install carries PR-A semantics.
 *
 * The source-grep approach is preferred over invoking `state.mjs create
 * --help` because the engineer CLI does NOT route `--help` after a
 * subcommand to a help-text printer — it raises "missing value for
 * flag --help" instead. Probing via source grep also avoids spawning
 * a child process at every dispatch (~10× faster) and works even if
 * the installed CLI happens to be broken for unrelated reasons.
 *
 * Pre-PR-A engineer installs lack the flag — dispatching against such
 * an install would silently drop the parent linkage and break §4
 * auto-writeback.
 *
 * @param {?string} root — engineer plugin root (return value of
 *   `discoverEngineerPluginRoot`)
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function preflightEngineerCapability(root) {
  if (typeof root !== 'string' || root.length === 0) {
    return { ok: false, reason: 'preflight-root-invalid' };
  }
  const cliPath = join(root, 'scripts', 'state.mjs');
  if (!(await fileExists(cliPath))) {
    return { ok: false, reason: 'preflight-state-mjs-missing' };
  }
  // Smoke-check the CLI is executable and exits cleanly on a no-op
  // probe — catches a broken install before we trust the source grep
  // below. We invoke the top-level `--help` form (engineer state.mjs
  // routes that to the help-text printer), NOT `create --help` (which
  // engineer treats as "missing value for --help" and exits non-zero).
  try {
    await execFileAsync(
      process.execPath,
      [cliPath, '--help'],
      { encoding: 'utf8', timeout: 10_000 },
    );
  } catch (err) {
    if (err.killed === true) {
      return { ok: false, reason: 'preflight-timeout: state.mjs --help exceeded 10s' };
    }
    return {
      ok: false,
      reason: `preflight-failed: exit=${err.code ?? 'n/a'} ${(err.stderr ?? err.message ?? '').toString().trim()}`,
    };
  }
  let stateText;
  try {
    stateText = await fsReadFile(cliPath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      reason: `preflight-read-failed: ${err.message}`,
    };
  }
  // PR-A wired `--parent-workflow` into the create CLI handler. The
  // token `'parent-workflow'` (with quotes) appears as the CLI flag
  // key; even if a future refactor reformats the surrounding code,
  // the literal flag name will persist as long as the contract holds.
  if (!stateText.includes("'parent-workflow'") && !stateText.includes('"parent-workflow"')
      && !stateText.includes('--parent-workflow')) {
    return {
      ok: false,
      reason: 'preflight-missing-flag: `--parent-workflow` not found in engineer ' +
        'state.mjs — install pre-dates ADR-0019 PR-A. Upgrade engineer to a version ' +
        'that ships the --parent-workflow / --originating-subtask flags before ' +
        '/orchestrator:next dispatch.',
    };
  }
  // PR-D wired Phase 0 env-var ingestion into the 6 verb commands.
  // An engineer install with PR-A state.mjs but pre-PR-D command files
  // would pass the flag check above yet silently drop parent linkage
  // when the dispatched runbook's Phase 0 ignores AGENTIC_PARENT_WORKFLOW.
  // Probe one command file (`investigate.md` is the canonical reference;
  // checking just one is sufficient because PR-D applies the boilerplate
  // identically across all six). Missing commands directory or missing
  // token both surface as a clear preflight failure.
  const verbCmd = join(root, 'commands', 'investigate.md');
  if (!(await fileExists(verbCmd))) {
    return {
      ok: false,
      reason: 'preflight-missing-command: engineer commands/investigate.md not found — ' +
        'install layout is incomplete. Re-install engineer or set AGENTIC_ENGINEER_ROOT ' +
        'to a complete plugin checkout.',
    };
  }
  let cmdText;
  try {
    cmdText = await fsReadFile(verbCmd, 'utf8');
  } catch (err) {
    return {
      ok: false,
      reason: `preflight-read-command-failed: ${err.message}`,
    };
  }
  if (!cmdText.includes('AGENTIC_PARENT_WORKFLOW')) {
    return {
      ok: false,
      reason: 'preflight-missing-env-ingest: engineer commands/investigate.md does NOT ' +
        'read AGENTIC_PARENT_WORKFLOW — install carries PR-A state.mjs flag support ' +
        'but pre-dates ADR-0019 PR-D Phase 0 env-var contract. Dispatching against this ' +
        'install would silently drop parent linkage. Upgrade engineer to ADR-0019 PR-D ' +
        'or later before /orchestrator:next.',
    };
  }
  // PR-E added two new engineer CLI subcommands invoked by
  // /orchestrator:finalize and /orchestrator:abort step 2 (active-children
  // detach pass): `detach-archive` (mid-flight child) and `stop-archive`
  // (terminal child with explicit head args). A PR-D-era engineer install
  // would pass the previous two probes but fail at finalize/abort dispatch
  // when the runbook tries to spawn these subcommands. Detect via the
  // `case 'detach-archive':` / `case 'stop-archive':` literal tokens in
  // state.mjs — same source-grep shape as the PR-A `--parent-workflow`
  // probe above (skill: handles refactors that rename surrounding context
  // as long as the literal CLI flag/subcommand string persists).
  if (!stateText.includes("'detach-archive'")
      && !stateText.includes('"detach-archive"')) {
    return {
      ok: false,
      reason: 'preflight-missing-cli: engineer state.mjs does NOT ship the ' +
        '`detach-archive` subcommand — install pre-dates ADR-0019 PR-E. ' +
        '/orchestrator:finalize / /orchestrator:abort step 2 (active-children ' +
        'detach pass) cannot dispatch without it. Upgrade engineer to a ' +
        'PR-E-or-later version.',
    };
  }
  if (!stateText.includes("'stop-archive'")
      && !stateText.includes('"stop-archive"')) {
    return {
      ok: false,
      reason: 'preflight-missing-cli: engineer state.mjs does NOT ship the ' +
        '`stop-archive` subcommand — install pre-dates ADR-0019 PR-E. ' +
        '/orchestrator:finalize / /orchestrator:abort step 2 (terminal-child ' +
        'path) cannot invoke the engineer Stop lifecycle without it. Upgrade ' +
        'engineer to a PR-E-or-later version.',
    };
  }
  return { ok: true };
}

// -----------------------------------------------------------------------------
// CLI surface
//
// /orchestrator:next + /orchestrator:done runbooks call this script as a CLI
// to resolve the engineer plugin root + optionally preflight it. Two
// subcommands keep the bash shim simple:
//
//   discover [--json]        — print discovered root to stdout (empty if none);
//                              --json prints the root with its provenance
//   preflight --root <path>  — print 'ok' to stdout on success, reason to
//                              stderr + exit 1 on failure
//
// Both are best-effort — exit 0 with empty stdout means "not found"; this
// is the same shape `state.mjs find-active` uses so the runbook's
// `VAR="$(... 2>/dev/null)"` capture pattern works uniformly.

async function cliMain(argv) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    process.stdout.write(
      [
        'plugins/orchestrator/scripts/discover-engineer.mjs',
        '',
        'Usage:',
        '',
        '  discover [--json]',
        '    Resolve engineer plugin root (env override → this host\'s install',
        '    cache → the other host\'s cache → sibling checkout) and print the',
        '    absolute path on stdout. Empty stdout + exit 0 if not resolved.',
        '    --json prints one JSON object with the root and where it came from.',
        '',
        '  preflight --root <path>',
        '    Verify engineer install at <path> exposes ADR-0019 PR-A',
        '    `--parent-workflow` flag. Exit 0 + empty stdout on success;',
        '    exit 1 + reason to stderr on failure.',
        '',
      ].join('\n'),
    );
    return 0;
  }

  if (subcommand === 'discover') {
    const unknown = rest.find((flag) => flag !== '--json');
    if (unknown) {
      process.stderr.write(`discover-engineer.mjs: unknown flag ${unknown}\n`);
      return 2;
    }
    if (rest.includes('--json')) {
      const located = await locateEngineerPluginRoot();
      process.stdout.write(`${JSON.stringify({
        root: located.root,
        source: located.source,
        host: located.host,
        caller_host: located.callerHost,
        cross_host_fallback: located.crossHostFallback,
        ...(located.version ? { version: located.version } : {}),
        ...(located.reason ? { reason: located.reason } : {}),
      })}\n`);
      return 0;
    }
    const root = await discoverEngineerPluginRoot();
    if (root) process.stdout.write(`${root}\n`);
    return 0;
  }

  if (subcommand === 'preflight') {
    // Tiny flag parser — only `--root <path>` is supported.
    let root = null;
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (t === '--root') { root = rest[++i]; continue; }
      const eq = t.indexOf('=');
      if (eq !== -1 && t.startsWith('--')) {
        const name = t.slice(2, eq);
        if (name === 'root') { root = t.slice(eq + 1); continue; }
      }
      process.stderr.write(`discover-engineer.mjs: unknown flag ${t}\n`);
      return 2;
    }
    if (!root) {
      process.stderr.write('discover-engineer.mjs: --root <path> is required\n');
      return 2;
    }
    const result = await preflightEngineerCapability(root);
    if (!result.ok) {
      process.stderr.write(`${result.reason}\n`);
      return 1;
    }
    return 0;
  }

  process.stderr.write(`discover-engineer.mjs: unknown subcommand: ${subcommand}\n`);
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
