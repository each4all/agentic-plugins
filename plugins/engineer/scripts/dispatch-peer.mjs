#!/usr/bin/env node
// plugins/engineer/scripts/dispatch-peer.mjs
//
// Host-shared canonical companion dispatch wrapper for the engineer plugin.
//
// Responsibilities:
//   1. Resolve the companion script path for a requested peer ('claude' | 'codex')
//      via env override → Claude cache (multi-version) → Codex cache (single
//      fixed) → development repo fallback.
//   2. Build an XML-structured prompt fragment per companions/contract.md §3
//      (helper buildEnsemblePrompt — used by callers that want safe escaping
//      and the standard task/grounding_rules/inputs/expected_output shape).
//   3. Spawn the companion's `task` subcommand per companions/contract.md §2.1
//      and §2.2, collect stdout/stderr/exit, and return a structured result.
//   4. Map companion exit codes (§5.1) and JSON envelope (§4.2) into a single
//      result object: { ok, status, exitCode, stdout, stderr, envelope, kind }.
//
// Out of scope (per companions/contract.md §6):
//   - Streaming / partial-message mode
//   - Internal timeout / retry policy
//   - Background job tracking — caller arranges background spawn (Claude Bash
//     run_in_background; Codex `task` subcommand) by invoking this script as
//     a subprocess.
//
// CLI:
//   node dispatch-peer.mjs --peer claude|codex
//                          (--prompt-file <path> | --prompt-text <string>)
//                          [--model <id>] [--effort <level>] [--cwd <dir>]
//                          [--output-format text|json]

import { spawn } from 'node:child_process';
import { readFile, writeFile, stat, readdir, mkdtemp, rm } from 'node:fs/promises';
import { join, isAbsolute, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const ENV_OVERRIDE = 'AGENTIC_COMPANIONS_ROOT';
const VALID_PEERS = new Set(['claude', 'codex']);
const VALID_OUTPUT_FORMATS = new Set(['text', 'json']);

const CACHE_BASES = {
  claude: join(homedir(), '.claude', 'plugins', 'cache', 'agentic-plugins', 'companions'),
  codex: join(homedir(), '.codex', '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'companions'),
};

// -----------------------------------------------------------------------------
// Companion path resolution

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

async function findInClaudeCache(cacheBase, companionFile) {
  if (!(await dirExists(cacheBase))) return null;
  let entries;
  try {
    entries = await readdir(cacheBase, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const versionDir = join(cacheBase, entry.name);
    const manifestFile = join(versionDir, '.claude-plugin', 'plugin.json');
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    } catch {
      continue;
    }
    if (manifest.name !== 'companions') continue;
    const path = join(versionDir, 'scripts', companionFile);
    if (!(await fileExists(path))) continue;
    candidates.push({ version: typeof manifest.version === 'string' ? manifest.version : '0.0.0', path });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => semverCompare(b.version, a.version));
  return candidates[0].path;
}

async function findInCodexCache(cacheBase, companionFile) {
  const manifestFile = join(cacheBase, '.codex-plugin', 'plugin.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  } catch {
    return null;
  }
  if (manifest.name !== 'companions') return null;
  const path = join(cacheBase, 'scripts', companionFile);
  if (!(await fileExists(path))) return null;
  return path;
}

/**
 * Resolve the companion script path for the given peer, trying:
 *   1. AGENTIC_COMPANIONS_ROOT env override
 *   2. Claude cache layout (~/.claude/plugins/cache/agentic-plugins/companions/<semver>/)
 *   3. Codex cache layout (~/.codex/.tmp/marketplaces/agentic-plugins/plugins/companions/)
 *   4. Development repo sibling (this script's own ../../companions/scripts/, then repo-root companions/)
 *
 * Returns the absolute path on success, or null on failure.
 */
export async function resolveCompanionPath(peer, { env = process.env } = {}) {
  if (!VALID_PEERS.has(peer)) {
    throw new Error(`Invalid peer: ${peer}. Must be one of ${[...VALID_PEERS].join(', ')}.`);
  }
  const companionFile = peer === 'claude' ? 'claude-companion.mjs' : 'codex-companion.mjs';

  const overrideRoot = env[ENV_OVERRIDE];
  if (overrideRoot && overrideRoot.length > 0) {
    if (!isAbsolute(overrideRoot)) {
      throw new Error(`${ENV_OVERRIDE} must be absolute: ${overrideRoot}`);
    }
    const path = join(overrideRoot, companionFile);
    if (await fileExists(path)) return path;
    throw new Error(`${ENV_OVERRIDE}=${overrideRoot} but ${companionFile} not found in that directory`);
  }

  const fromClaudeCache = await findInClaudeCache(CACHE_BASES.claude, companionFile);
  if (fromClaudeCache) return fromClaudeCache;

  const fromCodexCache = await findInCodexCache(CACHE_BASES.codex, companionFile);
  if (fromCodexCache) return fromCodexCache;

  // Development repo: this file lives at plugins/engineer/scripts/dispatch-peer.mjs.
  // Companion candidates: ../../companions/scripts/<file>, then ../../../companions/<file>.
  const here = fileURLToPath(import.meta.url);
  const devCandidate = resolve(dirname(here), '..', '..', 'companions', 'scripts', companionFile);
  if (await fileExists(devCandidate)) return devCandidate;
  const topLevelCandidate = resolve(dirname(here), '..', '..', '..', 'companions', companionFile);
  if (await fileExists(topLevelCandidate)) return topLevelCandidate;

  return null;
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
 * Build an XML prompt fragment matching companions/contract.md §3.1-§3.4.
 * All inputs are plain text — escapeXml is applied. To embed pre-formed
 * XML, build the fragment yourself and pass it as promptText to dispatchPeer.
 *
 * @param {object} args
 * @param {string} args.task — required, content of <task> element
 * @param {string|string[]} [args.groundingRules] — content of <grounding_rules>;
 *   array becomes multiple <rule> children
 * @param {Record<string,string>} [args.inputs] — { name: content } → <inputs><input name="...">content</input></inputs>
 * @param {string} [args.expectedOutput] — content of <expected_output>
 * @returns {string} XML fragment (no root element, no XML declaration)
 */
export function buildEnsemblePrompt({ task, groundingRules, inputs, expectedOutput }) {
  if (!task) throw new Error('buildEnsemblePrompt: task is required');
  const parts = [];

  parts.push(`<task>\n${escapeXml(task).trim()}\n</task>`);

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
// Companion invocation

/**
 * Dispatch a peer-agent task through the companion script. Returns a
 * structured result object regardless of success or failure.
 *
 * @param {object} args
 * @param {'claude'|'codex'} args.peer — peer host (the OPPOSITE of the
 *   current host)
 * @param {string} [args.promptText] — XML prompt as a string (mutually
 *   exclusive with promptFile)
 * @param {string} [args.promptFile] — path to a UTF-8 file containing the
 *   XML prompt
 * @param {string} [args.model] — peer model identifier
 * @param {string} [args.effort] — peer effort/reasoning level
 * @param {string} [args.cwd] — working directory passed to the peer CLI
 * @param {'text'|'json'} [args.outputFormat='json'] — companion output mode
 * @param {NodeJS.ProcessEnv} [args.env=process.env] — environment for spawn
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   status: 'success'|'peer_error'|'companion_error',
 *   exitCode: number,
 *   stdout: string,
 *   stderr: string,
 *   envelope: object|null,
 *   kind?: string,
 *   companionPath?: string,
 * }>}
 */
export async function dispatchPeer({
  peer,
  promptText,
  promptFile,
  model,
  effort,
  cwd,
  outputFormat = 'json',
  env = process.env,
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

  const companionPath = await resolveCompanionPath(peer, { env });
  if (!companionPath) {
    return {
      ok: false,
      status: 'companion_error',
      exitCode: 3,
      stdout: '',
      stderr: `dispatch-peer: companion for peer "${peer}" not found in env override, cache, or development paths`,
      envelope: null,
      kind: 'peer_cli_not_found',
    };
  }

  // Materialize promptText to a temp file so the companion sees a stable path.
  // (--prompt-file beats stdin per contract §2.3, and a tempfile is simpler than
  // wiring inherited pipes through child spawn.)
  let cleanupTmpDir = null;
  let resolvedPromptFile = promptFile;
  if (promptText !== undefined) {
    const dir = await mkdtemp(join(tmpdir(), 'engineer-prompt-'));
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
        return {
          ok: false,
          status: 'companion_error',
          exitCode: exitCode ?? -1,
          stdout,
          stderr: stderr + (stderr.endsWith('\n') ? '' : '\n') +
            `dispatch-peer: failed to parse JSON envelope: ${err.message}`,
          envelope: null,
          kind: 'envelope_parse_error',
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
        // best-effort cleanup; not part of the contract
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
      '',
      'Exit codes (per companions/contract.md §5.1):',
      '  0 — success',
      '  1 — peer_run_error',
      '  2 — companion_misuse (this wrapper or downstream companion)',
      '  3 — peer CLI / infrastructure failure',
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

  const result = await dispatchPeer(opts);

  // Pass-through: stdout = companion stdout (text mode) or envelope JSON (json mode).
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
