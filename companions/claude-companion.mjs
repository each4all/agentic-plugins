#!/usr/bin/env node
// Codex → Claude companion bridge.
// Implements companions/contract.md v0.1.1 against the public `claude` CLI
// (claude -p, non-interactive). See contract.md for the wire surface this
// script must honor; this file deliberately stays close to that vocabulary.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const PEER_HOST = 'claude';
export const PEER_CLI_BIN = 'claude';
export const CONTRACT_VERSION = '0.1.1';

export const EXIT_SUCCESS = 0;
export const EXIT_PEER_RUN_ERROR = 1;
export const EXIT_COMPANION_MISUSE = 2;
export const EXIT_PEER_INFRA = 3;

export const STATUS = Object.freeze({
  SUCCESS: 'success',
  PEER_ERROR: 'peer_error',
  COMPANION_ERROR: 'companion_error',
});

export const ERROR_KIND = Object.freeze({
  PEER_RUN: 'peer_run_error',
  MISUSE: 'companion_misuse',
  CLI_NOT_FOUND: 'peer_cli_not_found',
  UNAUTH: 'peer_unauthenticated',
  INVOKE: 'peer_invocation_error',
});

export const STDERR_MAX = 200;

// Narrow auth-error wording match. False positives are worse than false
// negatives here (a misclassified peer_run_error still surfaces the same
// stderr summary), so the regex stays conservative. Known fragility per
// contract § 5.4 — peer CLI version drift may shift wording.
export const AUTH_REGEX = /please\s+(?:run|use)\s+`?claude\s+(?:login|auth)|not\s+authenticat(?:ed|ion)|please\s+log\s+in/i;

export class CompanionMisuseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CompanionMisuseError';
  }
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function decodeUtf8Strict(buf, sourceLabel) {
  try {
    return UTF8_DECODER.decode(buf);
  } catch {
    throw new CompanionMisuseError(`malformed UTF-8 from ${sourceLabel}`);
  }
}

export function parseArguments(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        'prompt-file':   { type: 'string' },
        'model':         { type: 'string' },
        'effort':        { type: 'string' },
        'cwd':           { type: 'string' },
        'output-format': { type: 'string', default: 'text' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    throw new CompanionMisuseError(`argument parse error: ${err.message}`);
  }

  const positionals = parsed.positionals;
  if (positionals.length === 0) {
    throw new CompanionMisuseError('missing required subcommand "task"');
  }
  const subcommand = positionals[0];
  if (subcommand !== 'task') {
    throw new CompanionMisuseError(`unknown subcommand "${subcommand}"; only "task" is supported`);
  }
  if (positionals.length > 2) {
    throw new CompanionMisuseError('extra positional arguments after PROMPT_ARG');
  }
  const promptArg = positionals.length === 2 ? positionals[1] : null;

  const outputFormat = parsed.values['output-format'];
  if (outputFormat !== 'text' && outputFormat !== 'json') {
    throw new CompanionMisuseError(`--output-format must be "text" or "json", got "${outputFormat}"`);
  }

  return {
    subcommand,
    promptArg,
    options: {
      promptFile:   parsed.values['prompt-file'] ?? null,
      model:        parsed.values.model          ?? null,
      effort:       parsed.values.effort         ?? null,
      cwd:          parsed.values.cwd            ?? null,
      outputFormat,
    },
  };
}

export async function resolvePromptInput({ parsed, stdin = process.stdin }) {
  const { promptArg, options: { promptFile } } = parsed;
  const stdinIsPipe = !stdin.isTTY;

  // § 2.3 strict precedence (v0.1.1): --prompt-file > PROMPT_ARG > stdin.
  // The two explicit input sources silently win over stdin regardless of
  // TTY/pipe state. Conflict only when two explicit sources are given.
  if (promptFile && promptArg !== null) {
    throw new CompanionMisuseError('--prompt-file and PROMPT_ARG are mutually exclusive');
  }
  if (!promptFile && promptArg === null && !stdinIsPipe) {
    throw new CompanionMisuseError('no prompt input given (use --prompt-file, PROMPT_ARG, or piped stdin)');
  }

  if (promptFile) {
    let buf;
    try {
      buf = readFileSync(promptFile);
    } catch (err) {
      const code = err && err.code ? err.code : 'unknown';
      throw new CompanionMisuseError(`--prompt-file read error (${code}): ${err.message}`);
    }
    return decodeUtf8Strict(buf, '--prompt-file');
  }

  if (promptArg !== null) {
    // Shell argv is UTF-8 by construction; trust the OS layer here.
    return promptArg;
  }

  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return decodeUtf8Strict(Buffer.concat(chunks), 'stdin');
}

export function buildClaudeArgs({ model, effort }) {
  // Always invoke peer in text mode so contract § 4.1 (verbatim peer stdout)
  // holds regardless of the caller's --output-format choice.
  // --no-session-persistence: companion is single-shot; do not litter disk.
  const args = ['-p', '--output-format', 'text', '--no-session-persistence'];
  if (model)  args.push('--model', model);
  if (effort) args.push('--effort', effort);
  return args;
}

export function invokePeer(
  { prompt, options },
  { spawnImpl = spawn, onPeerStart = () => {} } = {},
) {
  const args = buildClaudeArgs(options);
  const startedAt = new Date();
  const startMs = Date.now();

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(PEER_CLI_BIN, args, {
        cwd: options.cwd ?? process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        spawnError: err,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
      });
      return;
    }

    onPeerStart(child);

    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));
    // Peer may close stdin early on its own schedule; swallow EPIPE so the
    // companion classifies on exit code, not on the write race.
    child.stdin.on('error', () => {});

    let resolved = false;
    const finish = (payload) => {
      if (resolved) return;
      resolved = true;
      resolve({
        ...payload,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
      });
    };

    child.on('error', (err) => finish({ spawnError: err, exitCode: null, signal: null }));
    child.on('close', (code, signal) => finish({ spawnError: null, exitCode: code, signal }));

    // Decision 3: stdin-only prompt delivery (avoids argv length limits and
    // cross-host quoting differences).
    try {
      child.stdin.end(prompt);
    } catch (err) {
      finish({ spawnError: err, exitCode: null, signal: null });
    }
  });
}

export function classifyResult(invocation) {
  const { spawnError, exitCode, signal, stderr, stdout } = invocation;

  if (spawnError) {
    if (spawnError.code === 'ENOENT' || spawnError.code === 'EACCES') {
      return {
        status: STATUS.COMPANION_ERROR,
        exit_code: EXIT_PEER_INFRA,
        error: {
          kind: ERROR_KIND.CLI_NOT_FOUND,
          message: `peer CLI "${PEER_CLI_BIN}" not found or not executable`,
          detail: spawnError.message,
        },
      };
    }
    return {
      status: STATUS.COMPANION_ERROR,
      exit_code: EXIT_PEER_INFRA,
      error: {
        kind: ERROR_KIND.INVOKE,
        message: `peer process failed to start (${spawnError.code ?? 'unknown'})`,
        detail: spawnError.message,
      },
    };
  }

  if (signal) {
    return {
      status: STATUS.COMPANION_ERROR,
      exit_code: EXIT_PEER_INFRA,
      error: {
        kind: ERROR_KIND.INVOKE,
        message: `peer process terminated by signal ${signal}`,
        detail: null,
      },
    };
  }

  if (exitCode === 0) {
    return { status: STATUS.SUCCESS, exit_code: EXIT_SUCCESS, error: null };
  }

  // Non-zero peer exit: try the auth heuristic, otherwise treat as peer_run_error.
  const haystack = `${stderr}\n${stdout}`;
  if (AUTH_REGEX.test(haystack)) {
    return {
      status: STATUS.COMPANION_ERROR,
      exit_code: EXIT_PEER_INFRA,
      error: {
        kind: ERROR_KIND.UNAUTH,
        message: `${PEER_HOST} reports missing or expired authentication`,
        detail: stderr || stdout || null,
      },
    };
  }

  return {
    status: STATUS.PEER_ERROR,
    exit_code: EXIT_PEER_RUN_ERROR,
    error: {
      kind: ERROR_KIND.PEER_RUN,
      message: `peer exited with code ${exitCode}`,
      detail: stderr || null,
    },
  };
}

export function buildEnvelope({ invocation, classification, options }) {
  const envelope = {
    status: classification.status,
    peer_host: PEER_HOST,
    peer_model: options.model ?? null,
    stdout: invocation.stdout,
    exit_code: classification.exit_code,
    metadata: {
      duration_ms: invocation.durationMs,
      started_at: invocation.startedAt,
      completed_at: invocation.completedAt,
    },
  };
  if (classification.error) {
    envelope.error = classification.error;
  }
  return envelope;
}

export function formatStderrSummary(classification) {
  if (!classification.error) return '';
  const oneLine = classification.error.message.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= STDERR_MAX) return oneLine;
  return `${oneLine.slice(0, STDERR_MAX - 3)}...`;
}

function emitMisuseEnvelope(stdout, message, model) {
  // § 4.2 — when --output-format json was successfully parsed but a misuse
  // occurs before peer invocation, emit a minimal envelope so the JSON
  // contract holds. Metadata is omitted since peer never ran.
  const envelope = {
    status: STATUS.COMPANION_ERROR,
    peer_host: PEER_HOST,
    peer_model: model ?? null,
    stdout: '',
    exit_code: EXIT_COMPANION_MISUSE,
    error: { kind: ERROR_KIND.MISUSE, message, detail: null },
  };
  stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

export async function main(
  argv = process.argv.slice(2),
  {
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    spawnImpl = spawn,
  } = {},
) {
  // Signal handlers go up front so Ctrl-C during stdin read or arg parsing
  // produces 130 (the user-visible signal exit), not 1 (which collides with
  // contract § 5.1 EXIT_PEER_RUN_ERROR).
  let peerChild = null;
  const onSignalExit = (signame, code) => {
    if (peerChild) {
      try { peerChild.kill(signame); } catch { /* already dead */ }
    }
    process.exit(code);
  };
  const onSigInt  = () => onSignalExit('SIGINT', 130);
  const onSigTerm = () => onSignalExit('SIGTERM', 143);
  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);

  try {
    let parsed;
    try {
      parsed = parseArguments(argv);
    } catch (err) {
      // parseArguments failure → outputFormat unparseable → cannot honor JSON
      // mode reliably. Emit text-only stderr summary; documented limitation.
      const message = err instanceof CompanionMisuseError
        ? err.message
        : `unexpected error: ${err.message}`;
      stderr.write(`${message}\n`);
      return EXIT_COMPANION_MISUSE;
    }

    let prompt;
    try {
      prompt = await resolvePromptInput({ parsed, stdin });
    } catch (err) {
      const message = err instanceof CompanionMisuseError
        ? err.message
        : `unexpected error reading prompt: ${err.message}`;
      stderr.write(`${message}\n`);
      if (parsed.options.outputFormat === 'json') {
        emitMisuseEnvelope(stdout, message, parsed.options.model);
      }
      return EXIT_COMPANION_MISUSE;
    }

    const invocation = await invokePeer(
      { prompt, options: parsed.options },
      { spawnImpl, onPeerStart: (c) => { peerChild = c; } },
    );

    const classification = classifyResult(invocation);
    const summary = formatStderrSummary(classification);
    if (summary) stderr.write(`${summary}\n`);

    if (parsed.options.outputFormat === 'json') {
      const envelope = buildEnvelope({ invocation, classification, options: parsed.options });
      stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      stdout.write(invocation.stdout);
    }

    return classification.exit_code;
  } finally {
    process.removeListener('SIGINT', onSigInt);
    process.removeListener('SIGTERM', onSigTerm);
  }
}

const isMainModule = !!(
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
);
if (isMainModule) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`fatal: ${err && err.message ? err.message : String(err)}\n`);
      process.exit(EXIT_COMPANION_MISUSE);
    },
  );
}
