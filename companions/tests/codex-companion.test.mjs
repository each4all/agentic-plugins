// Unit tests for companions/codex-companion.mjs.
// Each describe-block ties to a contract.md section so conformance
// coverage is traceable. Mirrors companions/tests/claude-companion.test.mjs
// per ADR-0001 COMPANION (bidirectional symmetry); per-host differences
// (peer CLI flag mapping, AUTH_REGEX wording) are reflected here.
//
// Run: node --test companions/tests/codex-companion.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  AUTH_REGEX,
  AUTH_STDERR_REGEX,
  CONTRACT_VERSION,
  CompanionMisuseError,
  ERROR_KIND,
  EXIT_COMPANION_MISUSE,
  EXIT_PEER_INFRA,
  EXIT_PEER_RUN_ERROR,
  EXIT_SUCCESS,
  PEER_CLI_BIN,
  PEER_HOST,
  STATUS,
  STDERR_MAX,
  buildCodexArgs,
  buildEnvelope,
  classifyResult,
  formatStderrSummary,
  invokePeer,
  main,
  parseArguments,
  resolvePromptInput,
} from '../codex-companion.mjs';

// --- helpers ---------------------------------------------------------------

class FakeStdin extends Readable {
  constructor(content, { isTTY } = { isTTY: false }) {
    super();
    this.isTTY = isTTY;
    if (content == null) this._chunks = [];
    else if (Array.isArray(content)) this._chunks = [...content];
    else this._chunks = [content];
  }
  _read() {
    const chunk = this._chunks.shift();
    if (chunk == null) {
      this.push(null);
    } else if (typeof chunk === 'string') {
      this.push(Buffer.from(chunk, 'utf8'));
    } else {
      this.push(chunk);
    }
  }
}

function makeFakeChild({
  stdout = '',
  stderr = '',
  exitCode = 0,
  signal = null,
  spawnError = null,
} = {}) {
  const child = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), {
    lastWrite: undefined,
    end(data) { this.lastWrite = data; },
  });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killSignals = [];
  child.kill = (sig) => { child.killSignals.push(sig); return true; };

  setImmediate(() => {
    if (spawnError) {
      child.emit('error', spawnError);
      return;
    }
    if (stdout) child.stdout.emit('data', Buffer.from(stdout, 'utf8'));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr, 'utf8'));
    child.emit('close', exitCode, signal);
  });
  return child;
}

function fakeSpawnReturning(child) {
  return (bin, args, opts) => {
    fakeSpawnReturning.lastCall = { bin, args, opts };
    return child;
  };
}

class CapturedStream {
  constructor() { this.chunks = []; }
  write(s) { this.chunks.push(s); return true; }
  get value() { return this.chunks.join(''); }
}

// --- § 2 Invocation Surface -----------------------------------------------

describe('§ 2 — parseArguments', () => {
  it('parses bare task subcommand', () => {
    const r = parseArguments(['task']);
    assert.equal(r.subcommand, 'task');
    assert.equal(r.promptArg, null);
    assert.equal(r.options.outputFormat, 'text', 'default --output-format is text per § 2.2');
  });

  it('parses task + positional PROMPT_ARG', () => {
    const r = parseArguments(['task', '<task>hi</task>']);
    assert.equal(r.promptArg, '<task>hi</task>');
  });

  it('parses all five pinned options', () => {
    const r = parseArguments([
      'task',
      '--prompt-file', '/tmp/p.xml',
      '--model', 'gpt-5-codex',
      '--effort', 'high',
      '--cwd', '/work',
      '--output-format', 'json',
    ]);
    assert.equal(r.options.promptFile, '/tmp/p.xml');
    assert.equal(r.options.model, 'gpt-5-codex');
    assert.equal(r.options.effort, 'high');
    assert.equal(r.options.cwd, '/work');
    assert.equal(r.options.outputFormat, 'json');
  });

  it('throws CompanionMisuseError on missing subcommand', () => {
    assert.throws(() => parseArguments([]), CompanionMisuseError);
  });

  it('throws on unknown subcommand (§ 2.1 — only `task`)', () => {
    assert.throws(() => parseArguments(['review']), /only "task" is supported/);
  });

  it('throws on unknown option (parseArgs strict mode)', () => {
    assert.throws(() => parseArguments(['task', '--foo', 'bar']), CompanionMisuseError);
  });

  it('throws on invalid --output-format value', () => {
    assert.throws(
      () => parseArguments(['task', '--output-format', 'html']),
      /must be "text" or "json"/,
    );
  });

  it('throws on extra positional after PROMPT_ARG', () => {
    assert.throws(() => parseArguments(['task', 'a', 'b']), /extra positional/);
  });
});

// --- § 2.3 Prompt input precedence ----------------------------------------

describe('§ 2.3 — resolvePromptInput', () => {
  it('reads prompt from --prompt-file', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'codex-companion-'));
    const file = path.join(tmp, 'prompt.xml');
    writeFileSync(file, '<task>file</task>', 'utf8');
    try {
      const parsed = parseArguments(['task', '--prompt-file', file]);
      const stdin = new FakeStdin(null, { isTTY: true });
      const r = await resolvePromptInput({ parsed, stdin });
      assert.equal(r, '<task>file</task>');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reads prompt from PROMPT_ARG', async () => {
    const parsed = parseArguments(['task', '<task>arg</task>']);
    const stdin = new FakeStdin(null, { isTTY: true });
    const r = await resolvePromptInput({ parsed, stdin });
    assert.equal(r, '<task>arg</task>');
  });

  it('reads prompt from stdin pipe', async () => {
    const parsed = parseArguments(['task']);
    const stdin = new FakeStdin('<task>stdin</task>', { isTTY: false });
    const r = await resolvePromptInput({ parsed, stdin });
    assert.equal(r, '<task>stdin</task>');
  });

  it('throws on --prompt-file + PROMPT_ARG', async () => {
    const parsed = parseArguments(['task', 'inline', '--prompt-file', '/x']);
    const stdin = new FakeStdin(null, { isTTY: true });
    await assert.rejects(
      () => resolvePromptInput({ parsed, stdin }),
      /mutually exclusive/,
    );
  });

  it('ignores piped stdin when --prompt-file is given (v0.1.1 strict precedence)', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'codex-companion-'));
    const file = path.join(tmp, 'prompt.xml');
    writeFileSync(file, '<task>file</task>', 'utf8');
    try {
      const parsed = parseArguments(['task', '--prompt-file', file]);
      const stdin = new FakeStdin('<task>extra</task>', { isTTY: false });
      const r = await resolvePromptInput({ parsed, stdin });
      assert.equal(r, '<task>file</task>');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('ignores piped stdin when PROMPT_ARG is given (v0.1.1 strict precedence)', async () => {
    const parsed = parseArguments(['task', '<task>arg</task>']);
    const stdin = new FakeStdin('<task>extra</task>', { isTTY: false });
    const r = await resolvePromptInput({ parsed, stdin });
    assert.equal(r, '<task>arg</task>');
  });

  it('throws when no input source is given (stdin TTY)', async () => {
    const parsed = parseArguments(['task']);
    const stdin = new FakeStdin(null, { isTTY: true });
    await assert.rejects(
      () => resolvePromptInput({ parsed, stdin }),
      /no prompt input given/,
    );
  });

  it('throws on --prompt-file ENOENT', async () => {
    const parsed = parseArguments(['task', '--prompt-file', '/nonexistent/path/xyz']);
    const stdin = new FakeStdin(null, { isTTY: true });
    await assert.rejects(
      () => resolvePromptInput({ parsed, stdin }),
      /--prompt-file read error/,
    );
  });

  it('throws on --prompt-file with malformed UTF-8 (§ 2.2)', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'codex-companion-'));
    const file = path.join(tmp, 'bad.bin');
    writeFileSync(file, Buffer.from([0xff, 0xfe, 0xfd]));
    try {
      const parsed = parseArguments(['task', '--prompt-file', file]);
      const stdin = new FakeStdin(null, { isTTY: true });
      await assert.rejects(
        () => resolvePromptInput({ parsed, stdin }),
        /malformed UTF-8/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws on stdin with malformed UTF-8 (Stage-1 extension)', async () => {
    const parsed = parseArguments(['task']);
    const stdin = new FakeStdin(Buffer.from([0xc3, 0x28]), { isTTY: false });
    await assert.rejects(
      () => resolvePromptInput({ parsed, stdin }),
      /malformed UTF-8/,
    );
  });

  it('decodes a UTF-8 codepoint split across stdin chunks', async () => {
    const parsed = parseArguments(['task']);
    // U+20AC EURO SIGN = 0xE2 0x82 0xAC; split into two chunks across the codepoint.
    const stdin = new FakeStdin(
      [Buffer.from([0xe2, 0x82]), Buffer.from([0xac])],
      { isTTY: false },
    );
    const r = await resolvePromptInput({ parsed, stdin });
    assert.equal(r, '€');
  });

  it('throws on --prompt-file pointing to a directory (§ 2.2)', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'codex-companion-'));
    try {
      const parsed = parseArguments(['task', '--prompt-file', tmp]);
      const stdin = new FakeStdin(null, { isTTY: true });
      await assert.rejects(
        () => resolvePromptInput({ parsed, stdin }),
        /--prompt-file read error/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// --- buildCodexArgs (peer CLI mapping) ------------------------------------

describe('buildCodexArgs (peer CLI mapping)', () => {
  it('emits exec, --skip-git-repo-check, --ephemeral by default', () => {
    const args = buildCodexArgs({});
    assert.deepEqual(args, ['exec', '--skip-git-repo-check', '--ephemeral']);
  });

  it('appends --model when given', () => {
    const args = buildCodexArgs({ model: 'gpt-5-codex' });
    const idx = args.indexOf('--model');
    assert.notEqual(idx, -1);
    assert.equal(args[idx + 1], 'gpt-5-codex');
  });

  it('appends -c model_reasoning_effort=<X> when --effort given (Decision 4)', () => {
    const args = buildCodexArgs({ effort: 'high' });
    const idx = args.indexOf('-c');
    assert.notEqual(idx, -1);
    assert.equal(args[idx + 1], 'model_reasoning_effort=high');
  });

  it('appends --cd <DIR> when --cwd given (Decision 5)', () => {
    const args = buildCodexArgs({ cwd: '/work' });
    const idx = args.indexOf('--cd');
    assert.notEqual(idx, -1);
    assert.equal(args[idx + 1], '/work');
  });
});

// --- invokePeer (mocked spawn) --------------------------------------------

describe('invokePeer (mocked spawn)', () => {
  it('captures stdout/stderr/exit code from peer', async () => {
    const spawnFn = fakeSpawnReturning(makeFakeChild({ stdout: 'OK', exitCode: 0 }));
    const result = await invokePeer(
      { prompt: '<task>x</task>', options: {} },
      { spawnImpl: spawnFn },
    );
    assert.equal(result.stdout, 'OK');
    assert.equal(result.exitCode, 0);
    assert.equal(result.spawnError, null);
  });

  it('writes prompt to peer stdin (Decision 3 — stdin only)', async () => {
    const child = makeFakeChild({ exitCode: 0 });
    const spawnFn = fakeSpawnReturning(child);
    await invokePeer({ prompt: 'PROMPT_BODY', options: {} }, { spawnImpl: spawnFn });
    assert.equal(child.stdin.lastWrite, 'PROMPT_BODY');
  });

  it('passes peer args from buildCodexArgs (with positional pinning)', async () => {
    const spawnFn = fakeSpawnReturning(makeFakeChild({ exitCode: 0 }));
    await invokePeer(
      { prompt: 'x', options: { model: 'gpt-5-codex', effort: 'high' } },
      { spawnImpl: spawnFn },
    );
    const { bin, args } = fakeSpawnReturning.lastCall;
    assert.equal(bin, PEER_CLI_BIN);
    const modelIdx = args.indexOf('--model');
    assert.notEqual(modelIdx, -1, '--model present');
    assert.equal(args[modelIdx + 1], 'gpt-5-codex', '--model value follows immediately');
    const effortIdx = args.indexOf('-c');
    assert.notEqual(effortIdx, -1, '-c present (effort override per Decision 4)');
    assert.equal(args[effortIdx + 1], 'model_reasoning_effort=high', '-c value follows immediately');
  });

  it('conveys cwd via --cd in args, NOT via spawn cwd: (Decision 5)', async () => {
    const spawnFn = fakeSpawnReturning(makeFakeChild({ exitCode: 0 }));
    await invokePeer({ prompt: 'x', options: { cwd: '/work' } }, { spawnImpl: spawnFn });
    // codex --cd handles its own internal cwd resolution for sandbox/log paths.
    // Stricter than notEqual('/work'): the implementation pins spawn cwd: to
    // process.cwd() so codex's sandbox/log paths anchor to the companion's
    // own cwd. Asserting equality catches any drift, not just the '/work' case.
    assert.equal(fakeSpawnReturning.lastCall.opts.cwd, process.cwd(),
      'spawn cwd: must equal process.cwd(); codex --cd does the user-cwd work');
    const cdIdx = fakeSpawnReturning.lastCall.args.indexOf('--cd');
    assert.notEqual(cdIdx, -1, '--cd present in args');
    assert.equal(fakeSpawnReturning.lastCall.args[cdIdx + 1], '/work');
  });

  it('reports ENOENT spawn error', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const spawnFn = fakeSpawnReturning(makeFakeChild({ spawnError: err }));
    const result = await invokePeer({ prompt: 'x', options: {} }, { spawnImpl: spawnFn });
    assert.equal(result.spawnError && result.spawnError.code, 'ENOENT');
  });

  it('calls onPeerStart with the spawned child', async () => {
    const child = makeFakeChild({ exitCode: 0 });
    const spawnFn = fakeSpawnReturning(child);
    let captured = null;
    await invokePeer(
      { prompt: 'x', options: {} },
      { spawnImpl: spawnFn, onPeerStart: (c) => { captured = c; } },
    );
    assert.equal(captured, child);
  });

  it('reports signal termination', async () => {
    const spawnFn = fakeSpawnReturning(makeFakeChild({ exitCode: null, signal: 'SIGSEGV' }));
    const result = await invokePeer({ prompt: 'x', options: {} }, { spawnImpl: spawnFn });
    assert.equal(result.signal, 'SIGSEGV');
  });
});

// --- § 5.3 classifyResult --------------------------------------------------

describe('§ 5.3 — classifyResult', () => {
  const baseInvocation = {
    spawnError: null, exitCode: 0, signal: null,
    stdout: '', stderr: '',
  };

  it('exit 0 → success / 0 / no error', () => {
    const r = classifyResult({ ...baseInvocation, exitCode: 0, stdout: 'ok' });
    assert.equal(r.status, STATUS.SUCCESS);
    assert.equal(r.exit_code, EXIT_SUCCESS);
    assert.equal(r.error, null);
  });

  it('exit non-zero → peer_error / 1 / peer_run_error', () => {
    const r = classifyResult({ ...baseInvocation, exitCode: 7, stderr: 'something failed' });
    assert.equal(r.status, STATUS.PEER_ERROR);
    assert.equal(r.exit_code, EXIT_PEER_RUN_ERROR);
    assert.equal(r.error.kind, ERROR_KIND.PEER_RUN);
  });

  it('exit non-zero + auth-pattern stderr → companion_error / 3 / peer_unauthenticated', () => {
    const r = classifyResult({
      ...baseInvocation,
      exitCode: 1,
      stderr: 'You are not signed in. Run codex login to authenticate.',
    });
    assert.equal(r.status, STATUS.COMPANION_ERROR);
    assert.equal(r.exit_code, EXIT_PEER_INFRA);
    assert.equal(r.error.kind, ERROR_KIND.UNAUTH);
  });

  it('exit non-zero + auth-pattern in stdout (stderr empty) → peer_unauthenticated', () => {
    const r = classifyResult({
      ...baseInvocation,
      exitCode: 1,
      stderr: '',
      stdout: 'Please log in to continue.',
    });
    assert.equal(r.error.kind, ERROR_KIND.UNAUTH);
  });

  it('spawnError ENOENT → companion_error / 3 / peer_cli_not_found', () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const r = classifyResult({ ...baseInvocation, spawnError: err });
    assert.equal(r.exit_code, EXIT_PEER_INFRA);
    assert.equal(r.error.kind, ERROR_KIND.CLI_NOT_FOUND);
  });

  it('spawnError EACCES → companion_error / 3 / peer_cli_not_found', () => {
    const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const r = classifyResult({ ...baseInvocation, spawnError: err });
    assert.equal(r.error.kind, ERROR_KIND.CLI_NOT_FOUND);
  });

  it('spawnError other code → companion_error / 3 / peer_invocation_error', () => {
    const err = Object.assign(new Error('weird'), { code: 'EPERM' });
    const r = classifyResult({ ...baseInvocation, spawnError: err });
    assert.equal(r.error.kind, ERROR_KIND.INVOKE);
  });

  it('signal termination → companion_error / 3 / peer_invocation_error', () => {
    const r = classifyResult({ ...baseInvocation, exitCode: null, signal: 'SIGSEGV' });
    assert.equal(r.exit_code, EXIT_PEER_INFRA);
    assert.equal(r.error.kind, ERROR_KIND.INVOKE);
  });
});

describe('AUTH_REGEX', () => {
  it('matches common codex unauth wordings', () => {
    assert.ok(AUTH_REGEX.test('You are not signed in.'));
    assert.ok(AUTH_REGEX.test('Please run `codex login` to authenticate.'));
    assert.ok(AUTH_REGEX.test('Please use codex auth before continuing'));
    assert.ok(AUTH_REGEX.test('Please log in to continue'));
  });

  it('does not match unrelated stderr', () => {
    assert.equal(AUTH_REGEX.test('rate limit exceeded'), false);
    assert.equal(AUTH_REGEX.test('connection reset by peer'), false);
  });

  // Captured live 2026-08-22 from codex-cli 0.148.0: `codex exec` with an
  // empty CODEX_HOME (no credentials) and again with an invalid
  // OPENAI_API_KEY prints none of the "not signed in" / "please run codex
  // login" wordings — it attempts the API, logs module-level WebSocket
  // lines, falls back to HTTPS, and exits 1 on a top-level "ERROR:" line.
  // Before AUTH_STDERR_REGEX a missing credential therefore classified as
  // peer_run_error / exit 1 (mirror of the claude-side R2 residual 6).
  const CODEX_0_148_0_WEBSOCKET_LINE = '2026-08-22T09:55:07.648566Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses';
  const CODEX_0_148_0_FALLBACK_WARNING = 'warning: Falling back from WebSockets to HTTPS transport. unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses, cf-ray: a2f100485c29d1cd-ICN';
  const CODEX_0_148_0_TERMINAL_LINE = 'ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: a2f100813f66ea13-ICN, request id: req_0f76ada3dc404b7ca3f7e6433eabac29';

  it('AUTH_STDERR_REGEX matches only the terminal top-level 401 line of codex 0.148.0, not the module-level or warning lines', () => {
    assert.ok(AUTH_STDERR_REGEX.test(CODEX_0_148_0_TERMINAL_LINE));
    // Embedded after other stderr lines (line-start anchor via "\n").
    assert.ok(AUTH_STDERR_REGEX.test(`ERROR: Reconnecting... 5/5\n${CODEX_0_148_0_TERMINAL_LINE}`));
    // CRLF stderr still anchors at line start.
    assert.ok(AUTH_STDERR_REGEX.test(`ERROR: Reconnecting... 5/5\r\n${CODEX_0_148_0_TERMINAL_LINE}`));
    // Preliminary lines alone are not the verdict — the run may still fall
    // back to a different terminal failure.
    assert.equal(AUTH_STDERR_REGEX.test(CODEX_0_148_0_WEBSOCKET_LINE), false);
    assert.equal(AUTH_STDERR_REGEX.test(CODEX_0_148_0_FALLBACK_WARNING), false);
    // A terminal line quoted mid-line (not at line start) is not the verdict either.
    assert.equal(AUTH_STDERR_REGEX.test('Summary: the run logged "ERROR: unexpected status 401 Unauthorized" before recovering.'), false);
    // The human-facing regex never learned the 401 lines.
    assert.equal(AUTH_REGEX.test(CODEX_0_148_0_TERMINAL_LINE), false);
    assert.equal(AUTH_REGEX.test(CODEX_0_148_0_WEBSOCKET_LINE), false);
  });

  it('matches the binary-observed "please re-run `codex login`" wording', () => {
    assert.ok(AUTH_REGEX.test('ChatGPT account ID not available, please re-run `codex login`'));
  });

  it('does not match non-auth transport/status lines, generic 401 prose, or the informational login status line', () => {
    // Same diagnostic shape, non-auth status — a rate limit or server error
    // must stay peer_run_error.
    assert.equal(AUTH_STDERR_REGEX.test('ERROR: unexpected status 429 Too Many Requests, url: https://api.openai.com/v1/responses'), false);
    assert.equal(AUTH_STDERR_REGEX.test('ERROR: unexpected status 500 Internal Server Error, url: https://api.openai.com/v1/responses'), false);
    assert.equal(AUTH_STDERR_REGEX.test('ERROR: Reconnecting... 2/5'), false);
    assert.equal(AUTH_STDERR_REGEX.test('stream disconnected before completion: connection reset'), false);
    // Peer-review reproductions against the first cut's generic anchors.
    for (const prose of [
      'the proxy returned HTTP error: 401 Unauthorized',
      'the example contains Missing bearer or basic authentication',
      'The upstream returned 401 Unauthorized for the stale token, so we refreshed it.',
    ]) {
      assert.equal(AUTH_REGEX.test(prose), false, `AUTH_REGEX must not match: ${prose}`);
      assert.equal(AUTH_STDERR_REGEX.test(prose), false, `AUTH_STDERR_REGEX must not match: ${prose}`);
    }
    // Informational status line in the 0.148.0 binary — "run codex login"
    // without "please" is NOT a failure, which is why the bare phrase is
    // deliberately not an alternative.
    assert.equal(AUTH_REGEX.test('API key configured (run codex login to use ChatGPT)'), false);
  });

  it('does not match claude-only auth wordings (copy-paste regression guard)', () => {
    // claude-companion's AUTH_REGEX matches `not authenticated`, `please run
    // claude login`, etc. The codex regex MUST be host-specific and NOT pick
    // up these claude-only phrases — if a refactor accidentally restored the
    // claude regex here, this test catches it before merge.
    assert.equal(AUTH_REGEX.test('Please run `claude login` to authenticate.'), false);
    assert.equal(AUTH_REGEX.test('Please use claude auth before continuing'), false);
    assert.equal(AUTH_REGEX.test('You are not authenticated.'), false);
    assert.equal(AUTH_REGEX.test('Sign in via not authentication failure'), false);
    // claude 2.1.233+ Anthropic-profile expiry rows belong to the claude regex.
    assert.equal(AUTH_REGEX.test('Anthropic profile login expired · Re-authenticate your Anthropic profile'), false);
    assert.equal(AUTH_REGEX.test('Login expired · Please run /login'), false);
  });
});

describe('classifyResult — codex 0.148.0 live unauthenticated stderr', () => {
  const baseInvocation = { spawnError: null, signal: null, stdout: '', stderr: '' };
  const TERMINAL_401 = 'ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: a2f1011a286aea93-ICN, request id: req_4e04c494c456484cb6806f7572972d4d';
  const WEBSOCKET_401 = '2026-08-22T09:55:32.382648Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses';

  it('exit 1 + the real stderr tail (reconnects, then the terminal 401 line) → companion_error / 3 / peer_unauthenticated', () => {
    const r = classifyResult({
      ...baseInvocation,
      exitCode: 1,
      stderr: [WEBSOCKET_401, 'ERROR: Reconnecting... 5/5', TERMINAL_401].join('\n'),
    });
    assert.equal(r.status, STATUS.COMPANION_ERROR);
    assert.equal(r.exit_code, EXIT_PEER_INFRA);
    assert.equal(r.error.kind, ERROR_KIND.UNAUTH);
    assert.match(r.error.message, /missing or expired authentication/);
  });

  it('the terminal 401 line on STDOUT only does not classify (stderr-only anchor)', () => {
    const r = classifyResult({ ...baseInvocation, exitCode: 1, stdout: `${TERMINAL_401}\n`, stderr: 'Error: stream disconnected before completion' });
    assert.equal(r.status, STATUS.PEER_ERROR);
    assert.equal(r.exit_code, EXIT_PEER_RUN_ERROR);
    assert.equal(r.error.kind, ERROR_KIND.PEER_RUN);
  });

  it('a preliminary WebSocket 401 followed by a terminal 429 stays peer_run_error / 1 (peer-review ordering case)', () => {
    const r = classifyResult({
      ...baseInvocation,
      exitCode: 1,
      stderr: [WEBSOCKET_401, 'warning: Falling back from WebSockets to HTTPS transport. unexpected status 401 Unauthorized: Unknown error, url: wss://api.openai.com/v1/responses', 'ERROR: unexpected status 429 Too Many Requests, url: https://api.openai.com/v1/responses'].join('\n'),
    });
    assert.equal(r.status, STATUS.PEER_ERROR);
    assert.equal(r.exit_code, EXIT_PEER_RUN_ERROR);
    assert.equal(r.error.kind, ERROR_KIND.PEER_RUN);
  });

  it('exit 1 + a 429 on the transport line stays peer_run_error / 1', () => {
    const r = classifyResult({
      ...baseInvocation,
      exitCode: 1,
      stderr: 'ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 429 Too Many Requests, url: wss://api.openai.com/v1/responses',
    });
    assert.equal(r.status, STATUS.PEER_ERROR);
    assert.equal(r.exit_code, EXIT_PEER_RUN_ERROR);
    assert.equal(r.error.kind, ERROR_KIND.PEER_RUN);
  });
});

// --- § 4 Output Convention -------------------------------------------------

describe('§ 4.2 — buildEnvelope', () => {
  const invocation = {
    stdout: 'peer text',
    stderr: '',
    durationMs: 42,
    startedAt: '2026-05-03T01:00:00Z',
    completedAt: '2026-05-03T01:00:00Z',
  };

  it('success envelope has required keys (presence) with peer_model present even if null', () => {
    const cls = { status: STATUS.SUCCESS, exit_code: EXIT_SUCCESS, error: null };
    const env = buildEnvelope({
      invocation,
      classification: cls,
      options: { model: null, outputFormat: 'json' },
    });
    // § 4.2 — peer_model REQUIRED, value MAY be null. Assert key existence.
    for (const k of ['status', 'peer_host', 'peer_model', 'stdout', 'exit_code']) {
      assert.ok(k in env, `envelope must contain key "${k}"`);
    }
    assert.equal(env.status, STATUS.SUCCESS);
    assert.equal(env.peer_host, PEER_HOST);
    assert.equal(env.peer_model, null);
    assert.equal(env.stdout, 'peer text');
    assert.equal(env.exit_code, EXIT_SUCCESS);
    assert.ok(!('error' in env), 'success envelope MUST NOT include error');
  });

  it('metadata sub-fields are emitted together with ISO-8601 Z-suffix timestamps', () => {
    const cls = { status: STATUS.SUCCESS, exit_code: EXIT_SUCCESS, error: null };
    const env = buildEnvelope({
      invocation,
      classification: cls,
      options: { model: null, outputFormat: 'json' },
    });
    assert.ok(env.metadata, 'metadata object present');
    assert.equal(typeof env.metadata.duration_ms, 'number');
    assert.match(env.metadata.started_at,   /Z$/, 'started_at is ISO-8601 Z-suffix');
    assert.match(env.metadata.completed_at, /Z$/, 'completed_at is ISO-8601 Z-suffix');
  });

  it('error envelope includes error object with kind/message (presence + value)', () => {
    const cls = {
      status: STATUS.PEER_ERROR,
      exit_code: EXIT_PEER_RUN_ERROR,
      error: { kind: ERROR_KIND.PEER_RUN, message: 'peer exited 5', detail: 'detail' },
    };
    const env = buildEnvelope({
      invocation,
      classification: cls,
      options: { model: null, outputFormat: 'json' },
    });
    assert.ok('error' in env, 'error envelope MUST include error key');
    assert.equal(env.error.kind, ERROR_KIND.PEER_RUN);
    assert.equal(env.error.message, 'peer exited 5');
  });

  it('peer_model echoes caller --model verbatim (Decision 6)', () => {
    const cls = { status: STATUS.SUCCESS, exit_code: 0, error: null };
    const env = buildEnvelope({
      invocation,
      classification: cls,
      options: { model: 'gpt-5-codex', outputFormat: 'json' },
    });
    assert.equal(env.peer_model, 'gpt-5-codex');
  });
});

// --- § 5.2 stderr summary --------------------------------------------------

describe('§ 5.2 — formatStderrSummary', () => {
  it('returns empty string when no error', () => {
    assert.equal(formatStderrSummary({ error: null }), '');
  });

  it('passes short single-line message through', () => {
    const s = formatStderrSummary({ error: { message: 'short message' } });
    assert.equal(s, 'short message');
  });

  it('flattens multi-line / multi-space message to single line', () => {
    const s = formatStderrSummary({ error: { message: 'line1\nline2\n\n  line3' } });
    assert.equal(s, 'line1 line2 line3');
    assert.equal(s.includes('\n'), false);
  });

  it('truncates messages longer than STDERR_MAX', () => {
    const long = 'x'.repeat(300);
    const s = formatStderrSummary({ error: { message: long } });
    assert.equal(s.length, STDERR_MAX);
    assert.ok(s.endsWith('...'));
  });
});

// --- main() integration (mocked spawn) ------------------------------------

describe('main() integration', () => {
  it('happy path text mode → exit 0, peer stdout written', async () => {
    const spawnFn = fakeSpawnReturning(makeFakeChild({ stdout: 'PEER OUT', exitCode: 0 }));
    const stdout = new CapturedStream();
    const stderr = new CapturedStream();
    const stdin = new FakeStdin('<task>hi</task>', { isTTY: false });
    const code = await main(['task'], { stdin, stdout, stderr, spawnImpl: spawnFn });
    assert.equal(code, EXIT_SUCCESS);
    assert.equal(stdout.value, 'PEER OUT');
    assert.equal(stderr.value, '');
  });

  it('happy path json mode → envelope written to stdout, stderr empty', async () => {
    const spawnFn = fakeSpawnReturning(makeFakeChild({ stdout: 'PEER', exitCode: 0 }));
    const stdout = new CapturedStream();
    const stderr = new CapturedStream();
    const stdin = new FakeStdin('<task>hi</task>', { isTTY: false });
    const code = await main(
      ['task', '--output-format', 'json'],
      { stdin, stdout, stderr, spawnImpl: spawnFn },
    );
    assert.equal(code, EXIT_SUCCESS);
    assert.equal(stderr.value, '', '§ 5.2 — stderr empty on exit 0 (JSON mode too)');
    const env = JSON.parse(stdout.value);
    assert.equal(env.status, STATUS.SUCCESS);
    assert.equal(env.peer_host, PEER_HOST);
    assert.equal(env.stdout, 'PEER');
    assert.equal(env.exit_code, EXIT_SUCCESS);
  });

  it('text mode preserves peer stdout verbatim — trailing newline kept', async () => {
    const spawnFn = fakeSpawnReturning(makeFakeChild({ stdout: 'A\n', exitCode: 0 }));
    const stdout = new CapturedStream();
    const stdin = new FakeStdin('<task>x</task>', { isTTY: false });
    await main(['task'], { stdin, stdout, stderr: new CapturedStream(), spawnImpl: spawnFn });
    assert.equal(stdout.value, 'A\n', '§ 4.1 — companion does not strip trailing newline');
  });

  it('text mode preserves peer stdout verbatim — absent newline not added', async () => {
    const spawnFn = fakeSpawnReturning(makeFakeChild({ stdout: 'A', exitCode: 0 }));
    const stdout = new CapturedStream();
    const stdin = new FakeStdin('<task>x</task>', { isTTY: false });
    await main(['task'], { stdin, stdout, stderr: new CapturedStream(), spawnImpl: spawnFn });
    assert.equal(stdout.value, 'A', '§ 4.1 — companion does not append trailing newline');
  });

  it('text mode preserves peer stdout verbatim even on peer error exit', async () => {
    const spawnFn = fakeSpawnReturning(makeFakeChild({
      stdout: 'partial output', stderr: 'oops', exitCode: 5,
    }));
    const stdout = new CapturedStream();
    const stdin = new FakeStdin('<task>x</task>', { isTTY: false });
    const code = await main(['task'], {
      stdin, stdout, stderr: new CapturedStream(), spawnImpl: spawnFn,
    });
    assert.equal(code, EXIT_PEER_RUN_ERROR);
    assert.equal(stdout.value, 'partial output', '§ 4.1 — verbatim even when exit != 0');
  });

  it('emits JSON envelope with companion_misuse on resolvePromptInput failure', async () => {
    const spawnFn = fakeSpawnReturning(makeFakeChild({ exitCode: 0 }));
    const stdout = new CapturedStream();
    const stderr = new CapturedStream();
    const stdin = new FakeStdin(null, { isTTY: true });
    const code = await main(
      ['task', '--output-format', 'json'],
      { stdin, stdout, stderr, spawnImpl: spawnFn },
    );
    assert.equal(code, EXIT_COMPANION_MISUSE);
    const env = JSON.parse(stdout.value);
    assert.equal(env.status, STATUS.COMPANION_ERROR);
    assert.equal(env.peer_host, PEER_HOST);
    assert.equal(env.peer_model, null);
    assert.equal(env.exit_code, EXIT_COMPANION_MISUSE);
    assert.equal(env.error.kind, ERROR_KIND.MISUSE);
    assert.ok(stderr.value.includes('no prompt input'), 'stderr summary mirrors envelope');
  });

  it('parseArguments failure → text fallback (envelope omitted; documented limitation)', async () => {
    const stdout = new CapturedStream();
    const stderr = new CapturedStream();
    const code = await main(
      ['unknown-cmd', '--output-format', 'json'],
      {
        stdin: new FakeStdin(null, { isTTY: true }),
        stdout, stderr,
        spawnImpl: fakeSpawnReturning(makeFakeChild({ exitCode: 0 })),
      },
    );
    assert.equal(code, EXIT_COMPANION_MISUSE);
    assert.equal(stdout.value, '', 'no JSON envelope emitted when arg parse fails');
    assert.ok(stderr.value.length > 0);
  });

  it('missing input → exit 2, stderr 1-line summary', async () => {
    const spawnFn = fakeSpawnReturning(makeFakeChild({ exitCode: 0 }));
    const stdout = new CapturedStream();
    const stderr = new CapturedStream();
    const stdin = new FakeStdin(null, { isTTY: true });
    const code = await main(['task'], { stdin, stdout, stderr, spawnImpl: spawnFn });
    assert.equal(code, EXIT_COMPANION_MISUSE);
    assert.ok(stderr.value.includes('no prompt input'));
    assert.equal(stderr.value.trim().split('\n').length, 1, 'stderr is single line on error');
  });

  it('peer non-zero exit → exit 1, stderr summary', async () => {
    const spawnFn = fakeSpawnReturning(makeFakeChild({
      stdout: '', stderr: 'something broke', exitCode: 5,
    }));
    const stdout = new CapturedStream();
    const stderr = new CapturedStream();
    const stdin = new FakeStdin('<task>hi</task>', { isTTY: false });
    const code = await main(['task'], { stdin, stdout, stderr, spawnImpl: spawnFn });
    assert.equal(code, EXIT_PEER_RUN_ERROR);
    assert.ok(stderr.value.includes('peer exited with code 5'));
  });

  it('peer ENOENT → exit 3 / peer_cli_not_found in JSON envelope', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const spawnFn = fakeSpawnReturning(makeFakeChild({ spawnError: err }));
    const stdout = new CapturedStream();
    const stderr = new CapturedStream();
    const stdin = new FakeStdin('<task>hi</task>', { isTTY: false });
    const code = await main(
      ['task', '--output-format', 'json'],
      { stdin, stdout, stderr, spawnImpl: spawnFn },
    );
    assert.equal(code, EXIT_PEER_INFRA);
    const env = JSON.parse(stdout.value);
    assert.equal(env.status, STATUS.COMPANION_ERROR);
    assert.equal(env.error.kind, ERROR_KIND.CLI_NOT_FOUND);
  });

  it('removes signal handlers after invocation completes (happy path)', async () => {
    const beforeInt  = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const spawnFn = fakeSpawnReturning(makeFakeChild({ exitCode: 0 }));
    const stdin = new FakeStdin('<task>hi</task>', { isTTY: false });
    await main(['task'], {
      stdin,
      stdout: new CapturedStream(),
      stderr: new CapturedStream(),
      spawnImpl: spawnFn,
    });
    assert.equal(process.listenerCount('SIGINT'),  beforeInt,  'SIGINT listener leaked');
    assert.equal(process.listenerCount('SIGTERM'), beforeTerm, 'SIGTERM listener leaked');
  });

  it('removes signal handlers when parseArguments throws', async () => {
    const beforeInt  = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    await main(['unknown-cmd'], {
      stdin: new FakeStdin(null, { isTTY: true }),
      stdout: new CapturedStream(),
      stderr: new CapturedStream(),
      spawnImpl: fakeSpawnReturning(makeFakeChild({ exitCode: 0 })),
    });
    assert.equal(process.listenerCount('SIGINT'),  beforeInt);
    assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
  });

  it('removes signal handlers when peer ENOENT', async () => {
    const beforeInt  = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    await main(['task'], {
      stdin: new FakeStdin('<task>hi</task>', { isTTY: false }),
      stdout: new CapturedStream(),
      stderr: new CapturedStream(),
      spawnImpl: fakeSpawnReturning(makeFakeChild({ spawnError: err })),
    });
    assert.equal(process.listenerCount('SIGINT'),  beforeInt);
    assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
  });
});

describe('contract version export', () => {
  it('exports CONTRACT_VERSION matching contract.md', () => {
    assert.equal(CONTRACT_VERSION, '0.1.1');
  });
});
