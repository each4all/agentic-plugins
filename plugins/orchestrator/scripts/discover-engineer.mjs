#!/usr/bin/env node
// plugins/orchestrator/scripts/discover-engineer.mjs
//
// ADR-0019 PR-D — engineer plugin root resolver. Used by
// /orchestrator:next + /orchestrator:done runbooks to locate the
// engineer plugin's scripts/state.mjs across:
//   - dev checkouts (monorepo)
//   - Claude Code's multi-version `~/.claude/plugins/cache/.../engineer/<version>/`
//   - Codex CLI's single fixed `~/.codex/.tmp/marketplaces/.../engineer/`
//
// Mirrors plugins/engineer/scripts/parent-writeback.mjs's
// `discoverOrchestratorPluginRoot` (PR-C) — same env-then-cache-then-
// sibling ladder, just inverted (orchestrator side searching for the
// engineer peer instead of engineer searching for orchestrator).
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
import { join, isAbsolute, resolve, dirname } from 'node:path';
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

async function dirExists(path) {
  try {
    const st = await stat(path);
    return st.isDirectory();
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

function cacheBases(home) {
  return {
    claude: join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'engineer'),
    codex: join(home, '.codex', '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'engineer'),
  };
}

/**
 * Resolve the engineer plugin root directory containing
 * `scripts/state.mjs`. Tries:
 *   1. `AGENTIC_ENGINEER_ROOT` env override (must be absolute +
 *      scripts/state.mjs must exist)
 *   2. Claude cache layout (multi-version; pick latest SemVer whose
 *      plugin.json `name` is "engineer" and whose scripts/state.mjs
 *      exists)
 *   3. Codex cache layout (single fixed path)
 *   4. Sibling fallback — derive orchestrator's own plugin root from
 *      `import.meta.url` (this file at `<orchestrator-root>/scripts/...`)
 *      and look for `<orchestrator-root>/../engineer/scripts/state.mjs`.
 *      Mirrors `plugins/engineer/scripts/parent-writeback.mjs`'s
 *      sibling fallback. Does NOT depend on any caller-supplied
 *      repoRoot — that would be the user's target project, not the
 *      orchestrator plugin checkout.
 * Returns the absolute path on first hit, `null` if nothing resolves.
 *
 * @param {object} args
 * @param {Record<string,string>} [args.env=process.env]
 * @param {string} [args.home=homedir()]
 * @param {string} [args.selfUrl=import.meta.url]
 * @returns {Promise<?string>}
 */
export async function discoverEngineerPluginRoot({
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
    if (await fileExists(join(overrideRoot, 'scripts', 'state.mjs'))) {
      return overrideRoot;
    }
    return null;
  }

  const { claude: claudeBase, codex: codexBase } = cacheBases(home);

  // Same-host preference (Codex P2 finding): when orchestrator runs from
  // a Codex install and a stale Claude engineer cache also exists,
  // returning the Claude cache first would route dispatch to the wrong
  // host's engineer (with potentially missing PR-D Phase 0 env-var
  // contract). Detect host from selfUrl and probe the matching cache
  // FIRST, falling back to the other host only if the same-host cache
  // misses entirely.
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
      if (manifest?.name !== 'engineer') continue;
      const statePath = join(versionRoot, 'scripts', 'state.mjs');
      if (!(await fileExists(statePath))) continue;
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
        && (await fileExists(join(codexBase, 'scripts', 'state.mjs')))) {
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

  // 4. Sibling fallback — derive orchestrator's plugin root from
  // selfUrl, then look one level up and over for engineer.
  if (typeof selfUrl === 'string' && selfUrl.length > 0) {
    let here;
    try {
      here = fileURLToPath(selfUrl);
    } catch {
      here = null;
    }
    if (here) {
      // here = <orch-root>/scripts/discover-engineer.mjs
      // dirname(here) = <orch-root>/scripts
      // resolve(..., '..', '..', 'engineer') = sibling engineer
      const sibling = resolve(dirname(here), '..', '..', 'engineer');
      if (await fileExists(join(sibling, 'scripts', 'state.mjs'))) {
        return sibling;
      }
    }
  }

  return null;
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
  return { ok: true };
}

// -----------------------------------------------------------------------------
// CLI surface
//
// /orchestrator:next + /orchestrator:done runbooks call this script as a CLI
// to resolve the engineer plugin root + optionally preflight it. Two
// subcommands keep the bash shim simple:
//
//   discover                 — print discovered root to stdout (empty if none)
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
        '  discover',
        '    Resolve engineer plugin root (env override → Claude cache →',
        '    Codex cache → sibling fallback) and print absolute path on stdout.',
        '    Empty stdout + exit 0 if not resolved.',
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

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain(process.argv.slice(2)).then((code) => process.exit(code ?? 0));
}
