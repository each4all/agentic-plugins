#!/usr/bin/env node
// plugins/orchestrator/scripts/dispatch-peer.mjs
//
// Host-shared canonical companion dispatch wrapper for the orchestrator
// plugin. Mirrors plugins/engineer/scripts/dispatch-peer.mjs (largely
// content-agnostic across plugins) with three orchestrator-specific
// adjustments per ADR-0018 §sub-decision-1:
//
//   1. tmp-dir prefix `orchestrator-prompt-` (was `engineer-prompt-`)
//   2. graceful degradation reordering: resolveCompanionPath runs BEFORE
//      recordPendingEnsemble. Companion missing → immediate graceful
//      return; no orphan-pending entry created. Caller (e.g.
//      /orchestrator:plan) can synthesize a LOCAL-ONLY result without a
//      cleanup step.
//   3. cross-references rewritten away from engineer-internal commands
//      (no /engineer:resume reference; no engineer-specific protocol
//      imports — orchestrator ships its own core/skills/_shared/references/
//      ensemble-protocol.md per ADR-0010 §5).
//
// Responsibilities:
//   1. Resolve the companion script path for a requested peer
//      ('claude' | 'codex') via env override → the caller's own host
//      install cache → the other host's install cache, only when the
//      caller's host has no companions installed, and reported (ADR-0061
//      §Decision 3; delegates to the companions plugin's
//      discoverPeerCompanion).
//   2. Build an XML-structured prompt fragment per
//      companions/contract.md §3 (helper buildEnsemblePrompt).
//   3. Spawn the companion's `task` subcommand per
//      companions/contract.md §2.1 + §2.2.
//   4. Map companion exit codes (§5.1) and JSON envelope (§4.2) into a
//      single result object: { ok, status, exitCode, stdout, stderr,
//      envelope, kind }.
//
// Out of scope (per companions/contract.md §6):
//   - Streaming / partial-message mode
//   - Internal timeout / retry policy
//   - Background job tracking — caller arranges background spawn (Claude
//     Bash run_in_background; Codex `task` subcommand) by invoking this
//     script as a subprocess.
//
// CLI:
//   node dispatch-peer.mjs --peer claude|codex
//                          (--prompt-file <path> | --prompt-text <string>)
//                          [--model <id>] [--effort <level>] [--cwd <dir>]
//                          [--output-format text|json]

import { spawn } from 'node:child_process';
import { readFile, writeFile, stat, readdir, mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, isAbsolute, resolve, dirname, relative, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { recordPendingEnsemble } from './state.mjs';

const ENV_OVERRIDE = 'AGENTIC_COMPANIONS_ROOT';
const VALID_PEERS = new Set(['claude', 'codex']);
const VALID_OUTPUT_FORMATS = new Set(['text', 'json']);

// -----------------------------------------------------------------------------
// Companion path resolution
//
// Bootstraps a companions plugin root and delegates the actual companion
// resolution (manifest verification, newest-compatible selection, preflight)
// to the canonical `discoverPeerCompanion()` library that root ships (per
// ADR-0008 §e), so the resolution logic is not duplicated here.
//
// Candidates follow ADR-0061 §Decision 3:
//   - each host's candidate is its versioned install cache —
//     ~/.claude/plugins/cache/agentic-plugins/companions/<version>/ and
//     <CODEX_HOME or ~/.codex>/plugins/cache/agentic-plugins/companions/<version>/.
//     The Codex marketplace clone (~/.codex/.tmp/marketplaces/…) tracks the
//     repository's main branch and is never a candidate, not even a fallback.
//   - the caller's own host goes first. The other host's cache is used only
//     when the caller's host has no companions installed, and the result says
//     so (`crossHostFallback`). An installed companions plugin that cannot
//     serve — no discovery library, or no companion passing preflight — is a
//     failure, not a reason to cross hosts.
//   - the caller's host is decided against the resolved cache roots, so a
//     custom $CODEX_HOME counts and a '/.codex/' path segment alone does not.
//   - there is no implicit repository rung. Running against a checkout's
//     companions takes an explicit AGENTIC_COMPANIONS_ROOT, the override
//     ADR-0061 §Decision 3 keeps for development; an implicit rung would run
//     whatever library the checkout holds with that library's own defaults.
//   - the chosen host's cache base is passed to the library explicitly, so an
//     older library whose own default still names the clone cannot fall back
//     to it.

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

function codexHomeDir(env, home) {
  const value = env.CODEX_HOME;
  return typeof value === 'string' && value.length > 0 ? resolve(value) : join(home, '.codex');
}

function hostCaches(env, home) {
  return {
    claude: {
      root: join(home, '.claude', 'plugins', 'cache'),
      companions: join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'companions'),
      manifest: join('.claude-plugin', 'plugin.json'),
    },
    codex: {
      root: join(codexHomeDir(env, home), 'plugins', 'cache'),
      companions: join(codexHomeDir(env, home), 'plugins', 'cache', 'agentic-plugins', 'companions'),
      manifest: join('.codex-plugin', 'plugin.json'),
    },
  };
}

// Canonical form for a containment check: the nearest existing ancestor is
// realpath'd and the rest re-appended, so a symlinked prefix (macOS /var ->
// /private/var, a symlinked ~/.codex) compares equal on both sides even when
// the tail does not exist.
// The resolved companion path is returned canonical too: the companion's CLI
// entry guard compares argv[1] with Node's canonical module path and silently
// does nothing when a symlink (a symlinked CODEX_HOME) makes the two differ.
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

/** 'codex' | 'claude' when `selfPath` sits in that host's install cache, else null (a checkout). */
function callerHostOf(selfPath, caches) {
  const self = realOrResolved(selfPath);
  if (isWithin(self, realOrResolved(caches.codex.root))) return 'codex';
  if (isWithin(self, realOrResolved(caches.claude.root))) return 'claude';
  return null;
}

/**
 * The companions install in one host cache: `{ state: 'absent' }` when no
 * manifest-verified companions version is there, `{ state: 'no-library',
 * version }` when one is but none bundles scripts/discover-peer.mjs
 * (companions 0.3.0+), else `{ state: 'ok', root }` for the newest that does.
 */
async function newestCompanionsInstall({ companions, manifest }) {
  if (!(await dirExists(companions))) return { state: 'absent' };
  let entries = [];
  try {
    entries = await readdir(companions, { withFileTypes: true });
  } catch {
    return { state: 'absent' };
  }
  const installed = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const versionRoot = join(companions, entry.name);
    let parsed;
    try {
      parsed = JSON.parse(await readFile(join(versionRoot, manifest), 'utf8'));
    } catch {
      continue;
    }
    if (parsed.name !== 'companions') continue;
    installed.push({
      version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
      root: versionRoot,
      hasLibrary: await fileExists(join(versionRoot, 'scripts', 'discover-peer.mjs')),
    });
  }
  if (installed.length === 0) return { state: 'absent' };
  installed.sort((a, b) => semverCompare(b.version, a.version));
  const withLibrary = installed.find((c) => c.hasLibrary);
  if (!withLibrary) return { state: 'no-library', version: installed[0].version };
  return { state: 'ok', root: withLibrary.root };
}

/**
 * Resolve the companion script for `peer` and report where it came from.
 *
 * @returns {Promise<{path: ?string, source: ?string, host: ?string,
 *   callerHost: string, crossHostFallback: boolean, version?: string,
 *   reason?: string}>} `path` is null on failure (graceful degradation per
 *   companions/contract.md §6.x); `source` is 'env', 'codex-cache',
 *   'claude-cache', or null when no host has companions installed;
 *   `callerHost` is 'codex', 'claude' or 'checkout'.
 */
export async function resolveCompanion(peer, {
  env = process.env,
  home = homedir(),
  selfPath = fileURLToPath(import.meta.url),
} = {}) {
  if (!VALID_PEERS.has(peer)) {
    throw new Error(`Invalid peer: ${peer}. Must be one of ${[...VALID_PEERS].join(', ')}.`);
  }
  const caches = hostCaches(env, home);
  const caller = callerHostOf(selfPath, caches);
  const callerHost = caller ?? 'checkout';

  // Env override: the companions root is the override directory itself.
  // Pre-locate discover-peer.mjs there; if missing, raise per ADR-0008
  // §e (script-pair layout requires the discovery library beside the
  // companion scripts).
  const overrideRoot = env[ENV_OVERRIDE];
  if (overrideRoot && overrideRoot.length > 0) {
    if (!isAbsolute(overrideRoot)) {
      throw new Error(`${ENV_OVERRIDE} must be absolute: ${overrideRoot}`);
    }
    const overrideDiscover = join(overrideRoot, 'discover-peer.mjs');
    if (!(await fileExists(overrideDiscover))) {
      throw new Error(
        `${ENV_OVERRIDE}=${overrideRoot} but discover-peer.mjs not found in that directory ` +
        `(companions v0.3.0+ requires the discovery library next to the companion scripts).`,
      );
    }
    const { discoverPeerCompanion } = await import(pathToFileURL(overrideDiscover).href);
    const result = await discoverPeerCompanion({ peer, env, home });
    return {
      path: result.ok ? realOrResolved(result.path) : null,
      source: 'env',
      host: null,
      callerHost,
      crossHostFallback: false,
      ...(result.ok ? { version: result.version } : { reason: result.reason }),
    };
  }

  const order = caller === 'codex' ? ['codex', 'claude'] : ['claude', 'codex'];
  for (const host of order) {
    const install = await newestCompanionsInstall(caches[host]);
    if (install.state === 'absent') continue;
    if (install.state === 'no-library') {
      return {
        path: null,
        source: `${host}-cache`,
        host,
        callerHost,
        crossHostFallback: caller !== null && host !== caller,
        reason: `companions ${install.version} in ${caches[host].companions} ships no ` +
          'scripts/discover-peer.mjs (companions 0.3.0+ required)',
      };
    }
    // A file URL, not the bare path: a '#' or '?' in a custom CODEX_HOME would
    // otherwise be read as a URL fragment or query.
    const { discoverPeerCompanion } = await import(pathToFileURL(join(install.root, 'scripts', 'discover-peer.mjs')).href);
    const result = await discoverPeerCompanion({
      peer,
      env,
      home,
      cacheBase: caches[host].companions,
      layout: 'multi-version',
      manifestPath: caches[host].manifest,
    });
    return {
      path: result.ok ? realOrResolved(result.path) : null,
      source: `${host}-cache`,
      host,
      callerHost,
      crossHostFallback: caller !== null && host !== caller,
      ...(result.ok ? { version: result.version } : { reason: result.reason }),
    };
  }

  return {
    path: null,
    source: null,
    host: null,
    callerHost,
    crossHostFallback: false,
    reason: 'companions plugin is not installed in the Claude or Codex plugin cache',
  };
}

/**
 * Resolve the companion script path for the given peer. Returns the absolute
 * path on success, or null on failure. See `resolveCompanion` for the
 * candidate order and the provenance this drops.
 */
export async function resolveCompanionPath(peer, options = {}) {
  return (await resolveCompanion(peer, options)).path;
}

// -----------------------------------------------------------------------------
// XML prompt builder per companions/contract.md §3

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlAttr(s) {
  return escapeXml(s).replace(/"/g, '&quot;');
}

/**
 * Build an XML prompt fragment matching companions/contract.md §3.1-§3.4
 * AND the orchestrator ensemble-protocol § Required blocks (which adds
 * <structured_output_contract> as a required element). All inputs are
 * plain text — escapeXml is applied. To embed pre-formed XML, build
 * the fragment yourself and pass it as promptText to dispatchPeer.
 */
export function buildEnsemblePrompt({
  task,
  structuredOutputContract,
  groundingRules,
  inputs,
  expectedOutput,
}) {
  if (!task) throw new Error('buildEnsemblePrompt: task is required');
  const parts = [];

  parts.push(`<task>\n${escapeXml(task).trim()}\n</task>`);

  if (structuredOutputContract !== undefined && structuredOutputContract !== null) {
    parts.push(
      `<structured_output_contract>\n${escapeXml(structuredOutputContract).trim()}\n</structured_output_contract>`,
    );
  }

  if (groundingRules !== undefined && groundingRules !== null) {
    if (Array.isArray(groundingRules)) {
      const inner = groundingRules.map((r) => `  <rule>${escapeXml(r)}</rule>`).join('\n');
      parts.push(`<grounding_rules>\n${inner}\n</grounding_rules>`);
    } else {
      parts.push(`<grounding_rules>\n${escapeXml(groundingRules).trim()}\n</grounding_rules>`);
    }
  }

  if (inputs && typeof inputs === 'object' && Object.keys(inputs).length > 0) {
    const inner = Object.entries(inputs)
      .map(([name, content]) =>
        `  <input name="${escapeXmlAttr(name)}">\n${escapeXml(content).trim()}\n  </input>`,
      )
      .join('\n');
    parts.push(`<inputs>\n${inner}\n</inputs>`);
  }

  if (expectedOutput) {
    parts.push(`<expected_output>\n${escapeXml(expectedOutput).trim()}\n</expected_output>`);
  }

  return parts.join('\n\n');
}

// -----------------------------------------------------------------------------
// Envelope shape validation per companions/contract.md §4.2 + §5.3

const VALID_STATUSES = new Set(['success', 'peer_error', 'companion_error']);
const VALID_PEER_HOSTS = new Set(['claude', 'codex']);
const VALID_KINDS = new Set([
  'peer_run_error',
  'companion_misuse',
  'peer_cli_not_found',
  'peer_unauthenticated',
  'peer_invocation_error',
]);

export function validateEnvelopeShape(env) {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    return { ok: false, reason: 'envelope is not a JSON object' };
  }
  for (const k of ['status', 'peer_host', 'peer_model', 'stdout', 'exit_code']) {
    if (!(k in env)) {
      return { ok: false, reason: `envelope missing required field: ${k}` };
    }
  }
  if (!VALID_STATUSES.has(env.status)) {
    return { ok: false, reason: `invalid envelope.status: ${JSON.stringify(env.status)}` };
  }
  if (!VALID_PEER_HOSTS.has(env.peer_host)) {
    return { ok: false, reason: `invalid envelope.peer_host: ${JSON.stringify(env.peer_host)}` };
  }
  if (env.peer_model !== null && typeof env.peer_model !== 'string') {
    return { ok: false, reason: 'envelope.peer_model must be string or null' };
  }
  if (typeof env.stdout !== 'string') {
    return { ok: false, reason: 'envelope.stdout must be string' };
  }
  if (typeof env.exit_code !== 'number' || !Number.isInteger(env.exit_code)) {
    return { ok: false, reason: `envelope.exit_code must be integer (got ${typeof env.exit_code})` };
  }

  if (env.status === 'success') {
    if (env.exit_code !== 0) {
      return { ok: false, reason: `success status requires exit_code 0 (got ${env.exit_code})` };
    }
    if (env.error !== undefined && env.error !== null) {
      return { ok: false, reason: 'success status must not include error object' };
    }
    return { ok: true };
  }

  if (typeof env.error !== 'object' || env.error === null || Array.isArray(env.error)) {
    return { ok: false, reason: `${env.status} status requires error object` };
  }
  if (!VALID_KINDS.has(env.error.kind)) {
    return { ok: false, reason: `invalid error.kind: ${JSON.stringify(env.error.kind)}` };
  }
  if (typeof env.error.message !== 'string' || env.error.message.length === 0) {
    return { ok: false, reason: 'error.message must be non-empty string' };
  }
  if (/[\r\n]/.test(env.error.message)) {
    return { ok: false, reason: 'error.message must be single-line (no CR/LF)' };
  }
  if ('detail' in env.error) {
    if (env.error.detail !== null && typeof env.error.detail !== 'string') {
      return { ok: false, reason: 'error.detail must be string or null when present' };
    }
  }
  if (env.status === 'peer_error') {
    if (env.exit_code !== 1 || env.error.kind !== 'peer_run_error') {
      return {
        ok: false,
        reason: `peer_error status requires (exit_code=1, error.kind=peer_run_error); got (${env.exit_code}, ${env.error.kind})`,
      };
    }
  } else if (env.status === 'companion_error') {
    if (env.exit_code === 2 && env.error.kind !== 'companion_misuse') {
      return {
        ok: false,
        reason: `companion_error exit_code=2 requires error.kind=companion_misuse (got ${env.error.kind})`,
      };
    }
    if (env.exit_code === 3 &&
        !['peer_cli_not_found', 'peer_unauthenticated', 'peer_invocation_error'].includes(env.error.kind)) {
      return {
        ok: false,
        reason: `companion_error exit_code=3 requires kind in {peer_cli_not_found, peer_unauthenticated, peer_invocation_error}; got ${env.error.kind}`,
      };
    }
    if (env.exit_code !== 2 && env.exit_code !== 3) {
      return {
        ok: false,
        reason: `companion_error requires exit_code 2 or 3 (got ${env.exit_code})`,
      };
    }
  }

  return { ok: true };
}

// -----------------------------------------------------------------------------
// Companion invocation
//
// Graceful-degradation contract (orchestrator-specific):
//   resolveCompanionPath runs BEFORE recordPendingEnsemble. If the
//   companion is missing, we return immediately with kind
//   'peer_cli_not_found'. No pending_ensemble entry is created — the
//   caller (e.g. /orchestrator:plan) can synthesize a LOCAL-ONLY plan
//   without a cleanup pass for orphan-pending entries.
//   This is the orchestrator-specific divergence from
//   plugins/engineer/scripts/dispatch-peer.mjs (which records pending
//   first, before resolving the companion — engineer relies on the
//   resume command's Step 5b to scrub orphans, a path orchestrator MVP
//   doesn't yet have).

export async function dispatchPeer({
  peer,
  promptText,
  promptFile,
  model,
  effort,
  cwd,
  outputFormat = 'json',
  env = process.env,
  ensembleBookkeeping = null,
  // Test seams for companion resolution (see resolveCompanion).
  home,
  selfPath,
}) {
  if (!VALID_OUTPUT_FORMATS.has(outputFormat)) {
    throw new Error(`Invalid outputFormat: ${outputFormat}. Must be 'text' or 'json'.`);
  }
  if (promptFile && promptText !== undefined) {
    throw new Error('Provide either promptFile or promptText, not both.');
  }
  if (!promptFile && (promptText === undefined || promptText === null)) {
    throw new Error('promptFile or promptText is required.');
  }
  if (ensembleBookkeeping !== null && ensembleBookkeeping !== undefined) {
    for (const k of ['workflowPath', 'phase', 'ensembleType', 'runId']) {
      const v = ensembleBookkeeping[k];
      if (typeof v !== 'string' || v.length === 0) {
        throw new Error(
          `ensembleBookkeeping.${k} must be a non-empty string (got ${JSON.stringify(v)})`,
        );
      }
    }
  }

  // Step 1 (orchestrator-specific ordering): resolve companion FIRST.
  // If missing, return graceful degradation immediately — no pending
  // entry is created, no orphan to clean up later.
  const companion = await resolveCompanion(peer, { env, home, selfPath });
  const companionPath = companion.path;
  if (companion.crossHostFallback) {
    // ADR-0061 §Decision 4: a Claude-cache companion is not pinned the way a
    // Codex install is, so a fallback is reported rather than taken silently.
    process.stderr.write(
      `dispatch-peer: companion resolved from the ${companion.host} plugin cache ` +
      `because the ${companion.callerHost} cache has no companions installed\n`,
    );
  }
  if (!companionPath) {
    return {
      ok: false,
      status: 'companion_error',
      exitCode: 3,
      stdout: '',
      stderr:
        `dispatch-peer: companion for peer "${peer}" not resolved: ` +
        `${companion.reason ?? 'no companion passed preflight'} — caller may proceed with a LOCAL-ONLY result.`,
      envelope: null,
      kind: 'peer_cli_not_found',
    };
  }

  // Step 2: companion located → record pending_ensemble best-effort
  // under the workflow file's per-file lock. Pairs with the caller-
  // driven `state.mjs ensemble-commit` that pops this entry, appends
  // the result, and prunes the retention cap in a single atomic
  // three-step mutation.
  if (ensembleBookkeeping) {
    try {
      await recordPendingEnsemble({
        workflowPath: ensembleBookkeeping.workflowPath,
        phase: ensembleBookkeeping.phase,
        ensemble_type: ensembleBookkeeping.ensembleType,
        run_id: ensembleBookkeeping.runId,
      });
    } catch (err) {
      process.stderr.write(
        `dispatch-peer: pending registration failed (continuing): ${err.message}\n`,
      );
    }
  }

  // Materialize promptText to a temp file so the companion sees a stable path.
  let cleanupTmpDir = null;
  let resolvedPromptFile = promptFile;
  if (promptText !== undefined) {
    const dir = await mkdtemp(join(tmpdir(), 'orchestrator-prompt-'));
    cleanupTmpDir = dir;
    resolvedPromptFile = join(dir, 'mission.xml');
    await writeFile(resolvedPromptFile, promptText, 'utf8');
  }

  const args = ['task', '--prompt-file', resolvedPromptFile, '--output-format', outputFormat];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (cwd) args.push('--cwd', cwd);

  try {
    const child = spawn('node', [companionPath, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));

    const exitCode = await new Promise((resolveP, rejectP) => {
      child.once('error', rejectP);
      child.once('close', (code) => resolveP(code ?? -1));
    });

    const stdout = Buffer.concat(stdoutChunks).toString('utf8');
    const stderr = Buffer.concat(stderrChunks).toString('utf8');

    let envelope = null;
    if (outputFormat === 'json') {
      try {
        envelope = JSON.parse(stdout);
      } catch (err) {
        const stderrOut = stderr + (stderr.endsWith('\n') ? '' : '\n') +
          `dispatch-peer: failed to parse JSON envelope: ${err.message}`;
        return {
          ok: false,
          status: 'companion_error',
          exitCode: exitCode === 0 ? 3 : exitCode,
          stdout,
          stderr: stderrOut,
          envelope: null,
          kind: 'envelope_parse_error',
          companionPath,
        };
      }

      const shape = validateEnvelopeShape(envelope);
      if (!shape.ok) {
        const stderrOut = stderr + (stderr.endsWith('\n') ? '' : '\n') +
          `dispatch-peer: envelope shape invalid: ${shape.reason}`;
        return {
          ok: false,
          status: 'companion_error',
          exitCode: exitCode === 0 ? 3 : exitCode,
          stdout,
          stderr: stderrOut,
          envelope,
          kind: 'envelope_shape_invalid',
          companionPath,
        };
      }
    }

    if (exitCode === 0) {
      return {
        ok: true,
        status: envelope?.status ?? 'success',
        exitCode: 0,
        stdout,
        stderr,
        envelope,
        companionPath,
      };
    }

    const inferredStatus =
      envelope?.status ?? (exitCode === 1 ? 'peer_error' : 'companion_error');
    return {
      ok: false,
      status: inferredStatus,
      exitCode,
      stdout,
      stderr,
      envelope,
      kind: envelope?.error?.kind ?? null,
      companionPath,
    };
  } finally {
    if (cleanupTmpDir) {
      try {
        await rm(cleanupTmpDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

// -----------------------------------------------------------------------------
// CLI mode

function parseCliArgs(argv) {
  const opts = { outputFormat: 'json' };
  let positional = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--peer':
        opts.peer = argv[++i];
        break;
      case '--prompt-file':
        opts.promptFile = argv[++i];
        break;
      case '--prompt-text':
        opts.promptText = argv[++i];
        break;
      case '--model':
        opts.model = argv[++i];
        break;
      case '--effort':
        opts.effort = argv[++i];
        break;
      case '--cwd':
        opts.cwd = argv[++i];
        break;
      case '--output-format':
        opts.outputFormat = argv[++i];
        break;
      case '--workflow-path':
        opts.workflowPath = argv[++i];
        break;
      case '--phase':
        opts.phase = argv[++i];
        break;
      case '--ensemble-type':
        opts.ensembleType = argv[++i];
        break;
      case '--run-id':
        opts.runId = argv[++i];
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        if (a.startsWith('--')) {
          throw new Error(`Unknown flag: ${a}`);
        }
        if (positional !== null) {
          throw new Error(`Multiple positional arguments not allowed: ${a}`);
        }
        positional = a;
    }
  }
  if (positional !== null && opts.promptFile === undefined && opts.promptText === undefined) {
    opts.promptText = positional;
  }
  return opts;
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: dispatch-peer.mjs --peer claude|codex',
      '         (--prompt-file <path> | --prompt-text <string> | <positional>)',
      '         [--model <id>] [--effort <level>] [--cwd <dir>]',
      '         [--output-format text|json]',
      '         [--workflow-path <path> --phase <p> --ensemble-type <t> --run-id <id>]',
      '',
      'When the four ensemble-bookkeeping flags are supplied (all four',
      'or none), dispatch-peer records a pending_ensemble entry under',
      "the workflow file's per-file lock AFTER companion resolution",
      '(graceful-degradation order — caller may proceed with LOCAL-ONLY',
      'when the companion is missing).',
      'The caller is responsible for invoking `state.mjs ensemble-commit`',
      'after synthesis to pop the pending entry and append the result',
      '(three-step atomic mutation).',
      '',
      'Exit codes (per companions/contract.md §5.1):',
      '  0 — success',
      '  1 — peer_run_error',
      '  2 — companion_misuse (this wrapper or downstream companion)',
      '  3 — peer CLI / infrastructure failure (graceful — caller may proceed LOCAL-ONLY)',
      '',
    ].join('\n'),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`dispatch-peer: ${err.message}\n`);
    process.exit(2);
  }

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  if (!opts.peer) {
    process.stderr.write('dispatch-peer: --peer claude|codex is required\n');
    process.exit(2);
  }
  if (!opts.promptFile && opts.promptText === undefined) {
    process.stderr.write('dispatch-peer: --prompt-file, --prompt-text, or positional prompt is required\n');
    process.exit(2);
  }

  const bookkeepingFlags = ['workflowPath', 'phase', 'ensembleType', 'runId'];
  const presentBookkeepingFlags = bookkeepingFlags.filter(
    (k) => opts[k] !== undefined,
  );
  let ensembleBookkeeping = null;
  if (presentBookkeepingFlags.length > 0) {
    if (presentBookkeepingFlags.length !== bookkeepingFlags.length) {
      const missing = bookkeepingFlags.filter(
        (k) => opts[k] === undefined,
      );
      process.stderr.write(
        `dispatch-peer: --workflow-path requires --phase, --ensemble-type, --run-id (missing: ${missing.join(', ')})\n`,
      );
      process.exit(2);
    }
    ensembleBookkeeping = {
      workflowPath: opts.workflowPath,
      phase: opts.phase,
      ensembleType: opts.ensembleType,
      runId: opts.runId,
    };
  }

  const result = await dispatchPeer({ ...opts, ensembleBookkeeping });

  if (opts.outputFormat === 'json' && result.envelope) {
    process.stdout.write(JSON.stringify(result.envelope) + '\n');
  } else {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : result.stderr + '\n');
  }
  process.exit(result.exitCode ?? 1);
}
