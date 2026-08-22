#!/usr/bin/env node
// Claude → Codex companion bridge.
// Implements companions/contract.md v0.1.1 against the public `codex` CLI
// (codex exec, non-interactive). See contract.md for the wire surface this
// script must honor; this file deliberately stays close to that vocabulary,
// and stays line-for-line symmetric with claude-companion.mjs where the
// peer-host CLIs allow it (bidirectional symmetry per ADR-0001 COMPANION).

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const PEER_HOST = 'codex';
export const PEER_CLI_BIN = 'codex';
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

// ---------------------------------------------------------------------------
// Cooperative nested-peer-invocation guard (companion-internal; no contract
// surface change — see companions/README.md § Nested peer invocation guard).
//
// A peer run is a full agent turn, and that agent can run shell commands —
// including the OTHER companion: Claude → codex-companion → `codex exec` →
// claude-companion → `claude -p` → … With no guard that recursion is bounded
// only by accident. Measured 2026-08-22 (claude 2.1.239 / codex 0.148.0):
// codex→claude→codex completed a nested round trip (the inner peer replied
// PONG); claude→codex→claude spawned the nested `claude -p` and failed only
// on codex's sandboxed network, 174 s later. 0 of 168 recorded peer runs
// show an executed nested companion, so the prompts have not triggered it —
// but nothing prevented it.
//
// Mechanism: every companion stamps the peer CLI it spawns with
// AGENTIC_COMPANION_DEPTH=<depth+1>. A companion that starts with the marker
// at or above AGENTIC_COMPANION_MAX_DEPTH (default 1 — one peer hop) refuses
// BEFORE reading the prompt and spawns nothing, emitting the EXISTING
// contract § 5.3 row companion_error / 3 / peer_invocation_error with the
// reason in error.detail (text mode: empty stdout + the one-line stderr
// summary). A marker that is present but not a canonical non-negative
// integer is treated as nested (fail closed); a malformed bound falls back to
// the default bound, never wider.
//
// This is cooperative recursion protection, NOT a security boundary: a
// wrapper that strips or rewrites the environment defeats the marker, and
// that limit is documented rather than hidden. Contract § 2.4 still holds —
// nothing is REQUIRED in the environment; an absent marker is depth 0.
export const NESTING_DEPTH_ENV = 'AGENTIC_COMPANION_DEPTH';
export const NESTING_MAX_DEPTH_ENV = 'AGENTIC_COMPANION_MAX_DEPTH';
export const DEFAULT_MAX_NESTING_DEPTH = 1;
// Canonical non-negative integer only: "0", or a non-zero leading digit
// followed by more digits — no sign, whitespace, leading zeros, radix or
// exponent forms, and NO arbitrary length cap (a real value like 1000000 is
// valid; a pathologically huge value parses to a finite or Infinite Number
// and still compares fail-closed). Anything else is malformed. An earlier
// `^[0-9]{1,6}$` both accepted leading zeros (000002 read as 2) and rejected
// valid 7+-digit values (peer review 2026-08-22).
const NESTING_INT_RE = /^(0|[1-9][0-9]*)$/;
const NESTING_VALUE_PREVIEW_MAX = 24;
// Stamped on the child when the inherited marker is malformed and a caller
// bypassed main()'s refusal: any non-digit value keeps the child fail-closed.
const NESTING_MALFORMED_SENTINEL = 'malformed';

export function readNestingDepth(env = process.env) {
  const raw = env[NESTING_DEPTH_ENV];
  if (raw === undefined) return { present: false, raw: undefined, depth: 0, malformed: false };
  if (!NESTING_INT_RE.test(raw)) return { present: true, raw, depth: null, malformed: true };
  return { present: true, raw, depth: Number(raw), malformed: false };
}

export function readMaxNestingDepth(env = process.env) {
  const raw = env[NESTING_MAX_DEPTH_ENV];
  // A malformed bound is ignored in favour of the default — a typo must never
  // widen the guard. No stderr warning: § 5.2 keeps stderr empty on exit 0.
  if (raw === undefined || !NESTING_INT_RE.test(raw)) return DEFAULT_MAX_NESTING_DEPTH;
  return Number(raw);
}

export function checkNesting(env = process.env) {
  const { raw, depth, malformed } = readNestingDepth(env);
  const max = readMaxNestingDepth(env);
  if (malformed) return { refused: true, reason: 'malformed', depth: null, max, raw };
  if (depth >= max) return { refused: true, reason: 'depth', depth, max, raw };
  return { refused: false, reason: null, depth, max, raw };
}

function previewNestingValue(raw) {
  const s = String(raw);
  const clipped = s.length > NESTING_VALUE_PREVIEW_MAX ? `${s.slice(0, NESTING_VALUE_PREVIEW_MAX)}…` : s;
  // JSON-escaped so control characters cannot break the § 5.2 single line.
  return JSON.stringify(clipped);
}

export function buildNestingRefusal(check) {
  if (!check || !check.refused) {
    throw new Error('buildNestingRefusal: nesting check is not refused');
  }
  const message = check.reason === 'malformed'
    ? `nested peer dispatch refused: ${NESTING_DEPTH_ENV} is set but malformed (${previewNestingValue(check.raw)}); treated as nested (fail closed); peer CLI not started`
    : `nested peer dispatch refused: already inside a peer invocation (${NESTING_DEPTH_ENV}=${check.depth} >= ${NESTING_MAX_DEPTH_ENV}=${check.max}); peer CLI not started`;
  const detail = [
    'Cooperative nested-peer-invocation guard (not a security boundary).',
    `A companion stamps the peer CLI it spawns with ${NESTING_DEPTH_ENV}=<depth+1>; a companion started inside that peer sees the marker and refuses when depth >= ${NESTING_MAX_DEPTH_ENV} (default ${DEFAULT_MAX_NESTING_DEPTH}, i.e. one peer hop). A malformed marker counts as nested.`,
    'The peer CLI was not spawned and the prompt input was not read.',
    `To allow deeper nesting deliberately, set ${NESTING_MAX_DEPTH_ENV} in the OUTERMOST caller's environment; it propagates with the marker. Wrappers that strip or rewrite the environment defeat the marker (known limit).`,
  ].join('\n');
  return {
    status: STATUS.COMPANION_ERROR,
    exit_code: EXIT_PEER_INFRA,
    error: { kind: ERROR_KIND.INVOKE, message, detail },
  };
}

// The marker value for the peer CLI this companion is about to spawn.
export function nextNestingMarker(depth) {
  return (depth === null || depth === undefined) ? NESTING_MALFORMED_SENTINEL : String(depth + 1);
}

// The peer CLI environment: the caller's environment, passed through in full
// (contract § 2.4 — companions do not consume or filter peer-host env), plus
// the stamped marker. Never mutates the input object.
export function childEnvForPeer(env, depth = readNestingDepth(env).depth) {
  return { ...env, [NESTING_DEPTH_ENV]: nextNestingMarker(depth) };
}

// Narrow auth-error wording match for codex. False positives are worse than
// false negatives here (a misclassified peer_run_error still surfaces the
// same stderr summary), so the regex stays conservative. Known fragility per
// contract § 5.4 — peer CLI version drift may shift wording.
//
// Observed wordings (extend as Codex CLI drifts):
// - "not signed in" / "please run codex login" / "please use codex auth" /
//   "please log in" (original set).
// - "ChatGPT account ID not available, please re-run `codex login`"
//   (present in the 0.148.0 binary; `(?:re-)?run` covers it).
// - Deliberately NOT matched: the informational status line "API key
//   configured (run codex login to use ChatGPT)" — so a bare `run codex
//   login` stays out.
export const AUTH_REGEX = /not\s+signed\s+in|please\s+(?:(?:re-)?run|use)\s+`?codex\s+(?:login|auth)|please\s+log\s+in/i;

// Stderr-only companion to AUTH_REGEX. Measured live 2026-08-22 on codex-cli
// 0.148.0 with an empty CODEX_HOME (no credentials) and again with an
// invalid OPENAI_API_KEY: `codex exec` does NOT pre-check auth and prints
// none of the wordings above. It tries the API, logs module-level lines
//   "… ERROR codex_api::endpoint::responses_websocket: failed to connect to
//    websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/…"
//   "warning: Falling back from WebSockets to HTTPS transport. unexpected
//    status 401 Unauthorized: Missing bearer or basic authentication …"
// and exits 1 on its top-level diagnostic line
//   "ERROR: unexpected status 401 Unauthorized: Missing bearer or basic
//    authentication in header, url: https://api.openai.com/v1/responses, …"
// Only that terminal line is matched, and only at the start of a stderr
// line (`ERROR:` with the colon is codex's top-level error prefix; the
// module lines carry a timestamp and no colon): a preliminary WebSocket 401
// that falls back to a terminal 429/5xx stays peer_run_error, and nothing is
// read from stdout, where peer content may legitimately quote "HTTP error:
// 401 Unauthorized" or "Missing bearer or basic authentication" (peer-review
// reproductions). Known fragility per contract § 5.4: if codex reshapes its
// top-level error line this degrades to a false negative, which is the
// preferred failure direction.
export const AUTH_STDERR_REGEX = /(?:^|\n)ERROR:\s+unexpected\s+status\s+401\s+unauthorized\b/i;

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

// § 2.3 input-source validation that needs NO I/O — computable from the
// parsed args + stdin.isTTY alone, never consuming stdin. Split out so main()
// can enforce the contract's exit-2 misuse cases (both explicit sources; no
// source with a TTY) BEFORE the cooperative nesting guard: a companion-
// internal guard must not turn a § 2.3 companion_misuse into a
// peer_invocation_error (peer review 2026-08-22).
export function validatePromptSourcesNoIO({ parsed, stdin = process.stdin }) {
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
}

export async function resolvePromptInput({ parsed, stdin = process.stdin }) {
  const { promptArg, options: { promptFile } } = parsed;
  validatePromptSourcesNoIO({ parsed, stdin });

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

export function buildCodexArgs({ model, effort, cwd, nestingMarker }) {
  // --skip-git-repo-check: companion may be invoked outside a git repo
  // (sandbox semantics unchanged; only the early-exit check is suppressed).
  // --ephemeral: companion is single-shot; do not litter disk. Mirror of
  // claude's --no-session-persistence per ADR-0001 COMPANION symmetry.
  const args = ['exec', '--skip-git-repo-check', '--ephemeral'];
  // Decision 4: --effort has no native codex flag, route through -c
  // model_reasoning_effort=<X> (config override; documented public surface).
  if (model)  args.push('--model', model);
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
  // Decision 5: cwd goes into args as --cd <DIR>. Bypassing --cd via spawn
  // cwd: would skip codex's internal sandbox/log path resolution.
  if (cwd)    args.push('--cd', cwd);
  // Nesting guard marker, codex-side delivery (see § Cooperative
  // nested-peer-invocation guard above). Measured 2026-08-22 on codex-cli
  // 0.148.0: `codex exec` does NOT forward arbitrary parent-process
  // environment variables to the shell commands its model runs — with the
  // spawn env alone, a marker and CLAUDECODE were both absent in the shell
  // tool (env count 25, matching the user's `inherit = "core"`). So the env
  // stamp alone never reaches a companion started from inside a codex peer;
  // the public `shell_environment_policy.set` override — the same `-c` config
  // surface as the effort override above — injects the marker into every
  // shell command codex runs and always delivered it in testing (`printenv
  // AGENTIC_COMPANION_DEPTH` returned the value with the override present in
  // three orderings). The value is JSON-quoted so it parses as a TOML string,
  // not an integer.
  //
  // KNOWN LIMIT (measured, honest scope): codex's `-c` override for a dotted
  // `shell_environment_policy.*` key is applied in an order-sensitive way that
  // drops the config-file `inherit` and reverts it to codex's built-in default
  // (~"all") for THIS peer invocation — the shell tool's env count rose 25→83
  // and a non-core parent var leaked in. That widens (never narrows) what the
  // codex peer's own shell tools inherit for this one call; it is an env-
  // hygiene loosening, not a functional or security change (the guard is
  // cooperative, and the companion already passes the full parent env to codex
  // per contract § 2.4). A wrapper whose `shell_environment_policy` strips the
  // marker outright still defeats the guard — the documented cooperative limit.
  if (nestingMarker !== undefined) {
    args.push('-c', `shell_environment_policy.set.${NESTING_DEPTH_ENV}=${JSON.stringify(nestingMarker)}`);
  }
  return args;
}

export function invokePeer(
  { prompt, options },
  { spawnImpl = spawn, onPeerStart = () => {}, env = process.env } = {},
) {
  // NOTE: the nesting guard is enforced at the main() invocation boundary
  // (it must emit a classified envelope and refuse before any I/O), not in
  // this raw spawn mechanism. invokePeer is NOT a guarded entry point — a
  // caller that imports it directly bypasses the refusal (no production
  // caller does; it is exported for tests). It still STAMPS the marker so a
  // peer it does spawn carries depth+1.
  const depth = readNestingDepth(env).depth;
  const args = buildCodexArgs({ ...options, nestingMarker: nextNestingMarker(depth) });
  const startedAt = new Date();
  const startMs = Date.now();

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(PEER_CLI_BIN, args, {
        // Decision 5: cwd is conveyed via --cd in args, not via spawn cwd:.
        // Companion's spawn cwd stays at process.cwd() so codex's internal
        // sandbox/log paths resolve as codex itself expects.
        cwd: process.cwd(),
        // Nesting guard marker in the spawn env as well (codex's own process,
        // its notify hook and MCP servers inherit it; the shell-tool delivery
        // is the -c override in buildCodexArgs).
        env: childEnvForPeer(env, depth),
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

    // Decision 3: stdin-only prompt delivery. codex appends piped stdin as
    // a `<stdin>` block when a positional prompt is also given (per
    // codex exec --help), so the companion MUST send EITHER positional OR
    // stdin to peer, never both — we pick stdin-only across both companions.
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
  // AUTH_REGEX reads both streams (the human-facing rows may land on either);
  // AUTH_STDERR_REGEX reads stderr alone, where codex's top-level diagnostic
  // lines live — see its comment for why it must not see stdout.
  const haystack = `${stderr}\n${stdout}`;
  if (AUTH_REGEX.test(haystack) || AUTH_STDERR_REGEX.test(stderr)) {
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

function emitPreInvocationEnvelope(stdout, classification, model) {
  // § 4.2 — when --output-format json was successfully parsed but the
  // companion stops before peer invocation (misuse, or the nesting guard),
  // emit a minimal envelope so the JSON contract holds. Metadata is omitted
  // since the peer never ran; the error triple comes from the classification.
  const envelope = {
    status: classification.status,
    peer_host: PEER_HOST,
    peer_model: model ?? null,
    stdout: '',
    exit_code: classification.exit_code,
    error: classification.error,
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
    env = process.env,
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

    // § 2.3 no-I/O input-source validation runs BEFORE the nesting guard so a
    // contract companion_misuse (both explicit sources; no source with a TTY)
    // keeps its required exit 2 even inside a nested call — the cooperative
    // guard must not mask a contract-level argument error. Reads no stdin.
    try {
      validatePromptSourcesNoIO({ parsed, stdin });
    } catch (err) {
      const message = err instanceof CompanionMisuseError
        ? err.message
        : `unexpected error: ${err.message}`;
      stderr.write(`${message}\n`);
      if (parsed.options.outputFormat === 'json') {
        emitPreInvocationEnvelope(stdout, {
          status: STATUS.COMPANION_ERROR,
          exit_code: EXIT_COMPANION_MISUSE,
          error: { kind: ERROR_KIND.MISUSE, message, detail: null },
        }, parsed.options.model);
      }
      return EXIT_COMPANION_MISUSE;
    }

    // Nesting guard — after argument parsing and the no-I/O § 2.3 validation
    // (so JSON mode is honoured and argument misuse keeps winning) but BEFORE
    // the prompt is read and BEFORE any spawn: a refused nested dispatch
    // touches neither stdin nor the peer CLI.
    const nesting = checkNesting(env);
    if (nesting.refused) {
      const classification = buildNestingRefusal(nesting);
      stderr.write(`${formatStderrSummary(classification)}\n`);
      if (parsed.options.outputFormat === 'json') {
        emitPreInvocationEnvelope(stdout, classification, parsed.options.model);
      }
      return classification.exit_code;
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
        emitPreInvocationEnvelope(stdout, {
          status: STATUS.COMPANION_ERROR,
          exit_code: EXIT_COMPANION_MISUSE,
          error: { kind: ERROR_KIND.MISUSE, message, detail: null },
        }, parsed.options.model);
      }
      return EXIT_COMPANION_MISUSE;
    }

    const invocation = await invokePeer(
      { prompt, options: parsed.options },
      { spawnImpl, onPeerStart: (c) => { peerChild = c; }, env },
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
