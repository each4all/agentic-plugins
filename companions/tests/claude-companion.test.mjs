// Unit tests for companions/claude-companion.mjs.
// Each describe-block ties to a contract.md section so conformance
// coverage is traceable.
//
// Run: node --test companions/tests/claude-companion.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  AUTH_REGEX,
  CompanionMisuseError,
  CONTRACT_VERSION,
  ERROR_KIND,
  EXIT_COMPANION_MISUSE,
  EXIT_PEER_INFRA,
  EXIT_PEER_RUN_ERROR,
  EXIT_SUCCESS,
  PEER_CLI_BIN,
  PEER_HOST,
  STATUS,
  STDERR_MAX,
  buildClaudeArgs,
  buildEnvelope,
  classifyResult,
  formatStderrSummary,
  invokePeer,
  main,
  parseArguments,
  resolvePromptInput,
} from '../claude-companion.mjs';
import * as companionModule from '../claude-companion.mjs';
import { fileURLToPath } from 'node:url';
import { defineNestingGuardSuite } from './nesting-guard.suite.mjs';

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
      '--model', 'claude-opus-4-7',
      '--effort', 'high',
      '--cwd', '/work',
      '--output-format', 'json',
    ]);
    assert.equal(r.options.promptFile, '/tmp/p.xml');
    assert.equal(r.options.model, 'claude-opus-4-7');
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
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'claude-companion-'));
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
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'claude-companion-'));
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
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'claude-companion-'));
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
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'claude-companion-'));
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

// --- buildClaudeArgs (peer CLI mapping) -----------------------------------

describe('buildClaudeArgs (peer CLI mapping)', () => {
  it('emits -p, --output-format text, --no-session-persistence by default', () => {
    const args = buildClaudeArgs({});
    assert.deepEqual(args, ['-p', '--output-format', 'text', '--no-session-persistence']);
  });

  it('appends --model when given', () => {
    const args = buildClaudeArgs({ model: 'opus' });
    assert.ok(args.includes('--model'));
    assert.ok(args.includes('opus'));
  });

  it('appends --effort when given', () => {
    const args = buildClaudeArgs({ effort: 'high' });
    assert.ok(args.includes('--effort'));
    assert.ok(args.includes('high'));
  });
});

// --- § 5.3 status / exit_code / error.kind table --------------------------

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
      stderr: 'Please run `claude login` to authenticate.',
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
      stdout: 'You are not authenticated. Please log in.',
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
  it('matches common claude unauth wordings', () => {
    assert.ok(AUTH_REGEX.test('Please run `claude login` to authenticate.'));
    assert.ok(AUTH_REGEX.test('Please use claude auth before continuing'));
    assert.ok(AUTH_REGEX.test('You are not authenticated. Sign in with claude auth.'));
    assert.ok(AUTH_REGEX.test('Please log in to continue'));
  });

  it('matches Claude Code CLI 2.1.128+ wording (Not logged in · Please run /login)', () => {
    // Empirically observed when codex spawns `claude -p` without inheriting
    // the parent shell's keychain access — Claude CLI 2.1.128 emits this
    // exact stderr instead of the older "claude login" / "log in" forms.
    assert.ok(AUTH_REGEX.test('Not logged in · Please run /login'));
    assert.ok(AUTH_REGEX.test('not logged in'));
    assert.ok(AUTH_REGEX.test('Please run /login'));
  });

  it('does not match unrelated stderr', () => {
    assert.equal(AUTH_REGEX.test('rate limit exceeded'), false);
    assert.equal(AUTH_REGEX.test('connection reset by peer'), false);
  });

  // Captured verbatim from the installed Claude Code CLI 2.1.239 binary
  // (2026-08-22). The two Anthropic-profile rows say neither "please" nor
  // "not logged in", which is why they slipped past the classifier (R2
  // review residual 6: expired profile → peer_run_error / exit 1).
  const CLAUDE_2_1_239_AUTH_ROWS = [
    'Anthropic profile login expired · Re-authenticate your Anthropic profile',
    'Anthropic profile login expired · Run /login to use your claude.ai account instead, or re-authenticate the profile',
    'Login expired · Please run /login',
    'OAuth token revoked · Please run /login',
    'Not logged in · Run /login', // CLAUDE_CODE_REMOTE variant — no "Please"
  ];

  it('matches the Anthropic-profile expiry family and sibling rows (captured from 2.1.239)', () => {
    for (const row of CLAUDE_2_1_239_AUTH_ROWS) {
      assert.ok(AUTH_REGEX.test(row), `expected auth match: ${row}`);
    }
  });

  it('does not match the still-valid-login warning or non-auth API-error rows from the same capture', () => {
    // A warning emitted while the login is still valid — "expires", not
    // "expired" — can sit on stderr next to an unrelated non-zero exit and
    // MUST NOT flip the classification to peer_unauthenticated.
    assert.equal(AUTH_REGEX.test('Your login expires in 3 days · run /login to renew'), false);
    // Non-auth rows of the same error table.
    assert.equal(AUTH_REGEX.test('Prompt is too long'), false);
    assert.equal(AUTH_REGEX.test('Credit balance is too low'), false);
    // Normal peer content that merely talks about expiry — including the
    // exact contiguous phrase "login expired" (peer-review reproduction:
    // stdout is part of the haystack, so a bare `login expired` alternative
    // flipped an unrelated non-zero exit to peer_unauthenticated).
    assert.equal(AUTH_REGEX.test('the customer login expired yesterday'), false);
    assert.equal(AUTH_REGEX.test('Refresh the token before it expires; expired tokens are rejected upstream.'), false);
    assert.equal(AUTH_REGEX.test('The session expired after 30 minutes of inactivity.'), false);
    // Captured rows deliberately left out (invalid ≠ missing/expired; the
    // Bedrock/Vertex rows are ambiguous between the two) — pinned so that
    // widening them is an explicit decision, not drift.
    assert.equal(AUTH_REGEX.test('Invalid API key · Fix external API key'), false);
    assert.equal(AUTH_REGEX.test('AWS credentials expired or invalid'), false);
    assert.equal(AUTH_REGEX.test('Google Cloud credentials expired or invalid'), false);
  });

  it('does not match codex-only auth wordings (copy-paste regression guard)', () => {
    // codex-companion's AUTH_REGEX matches `not signed in`, `please run codex
    // login`, etc. The claude regex MUST be host-specific and NOT pick up
    // these codex-only phrases — if a refactor accidentally restored the
    // codex regex here, this test catches it before merge. Mirror of the
    // symmetric guard in companions/tests/codex-companion.test.mjs.
    assert.equal(AUTH_REGEX.test('You are not signed in.'), false);
    assert.equal(AUTH_REGEX.test('Please run `codex login` to authenticate.'), false);
    assert.equal(AUTH_REGEX.test('Please use codex auth before continuing'), false);
    // codex 0.148.0's live unauthenticated wording is an HTTP 401 line;
    // claude's CLI speaks in its own rows ("Invalid API key · …"), so the
    // claude regex must not learn the codex 401 anchor by copy-paste —
    // neither the terminal line nor the module-level WebSocket line.
    assert.equal(AUTH_REGEX.test('ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses'), false);
    assert.equal(AUTH_REGEX.test('2026-08-22T09:55:07.648566Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses'), false);
  });
});

describe('classifyResult — Anthropic-profile expiry wording (2.1.233+)', () => {
  const baseInvocation = { spawnError: null, signal: null, stdout: '', stderr: '' };

  it('exit 1 + "Anthropic profile login expired · Run /login …" on stdout → companion_error / 3 / peer_unauthenticated', () => {
    const r = classifyResult({
      ...baseInvocation,
      exitCode: 1,
      stdout: 'Anthropic profile login expired · Run /login to use your claude.ai account instead, or re-authenticate the profile\n',
    });
    assert.equal(r.status, STATUS.COMPANION_ERROR);
    assert.equal(r.exit_code, EXIT_PEER_INFRA);
    assert.equal(r.error.kind, ERROR_KIND.UNAUTH);
    assert.match(r.error.message, /missing or expired authentication/);
  });

  it('exit 1 + "Anthropic profile login expired · Re-authenticate your Anthropic profile" on stderr → peer_unauthenticated', () => {
    const r = classifyResult({
      ...baseInvocation,
      exitCode: 1,
      stderr: 'Anthropic profile login expired · Re-authenticate your Anthropic profile',
    });
    assert.equal(r.exit_code, EXIT_PEER_INFRA);
    assert.equal(r.error.kind, ERROR_KIND.UNAUTH);
  });

  it('exit 1 + the still-valid-login warning on stderr stays peer_run_error / 1', () => {
    const r = classifyResult({
      ...baseInvocation,
      exitCode: 1,
      stderr: 'Your login expires in 3 days · run /login to renew',
    });
    assert.equal(r.status, STATUS.PEER_ERROR);
    assert.equal(r.exit_code, EXIT_PEER_RUN_ERROR);
    assert.equal(r.error.kind, ERROR_KIND.PEER_RUN);
  });

  it('exit 1 + partial stdout saying "login expired" about something else stays peer_run_error / 1', () => {
    // Peer-review reproduction against the first cut's bare `login expired`.
    const r = classifyResult({
      ...baseInvocation,
      exitCode: 1,
      stdout: 'Summary: the customer login expired yesterday, so the report skipped that account.\n',
      stderr: 'Error: stream disconnected before completion',
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
      options: { model: 'claude-opus-4-7', outputFormat: 'json' },
    });
    assert.equal(env.peer_model, 'claude-opus-4-7');
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

  it('passes peer args from buildClaudeArgs (with positional pinning)', async () => {
    const spawnFn = fakeSpawnReturning(makeFakeChild({ exitCode: 0 }));
    await invokePeer(
      { prompt: 'x', options: { model: 'opus', effort: 'high' } },
      { spawnImpl: spawnFn },
    );
    const { bin, args } = fakeSpawnReturning.lastCall;
    assert.equal(bin, PEER_CLI_BIN);
    const modelIdx = args.indexOf('--model');
    assert.notEqual(modelIdx, -1, '--model present');
    assert.equal(args[modelIdx + 1], 'opus', '--model value follows immediately');
    const effortIdx = args.indexOf('--effort');
    assert.notEqual(effortIdx, -1, '--effort present');
    assert.equal(args[effortIdx + 1], 'high', '--effort value follows immediately');
  });

  it('sets spawn cwd from options.cwd', async () => {
    const spawnFn = fakeSpawnReturning(makeFakeChild({ exitCode: 0 }));
    await invokePeer({ prompt: 'x', options: { cwd: '/work' } }, { spawnImpl: spawnFn });
    assert.equal(fakeSpawnReturning.lastCall.opts.cwd, '/work');
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

// --- nested peer invocation guard (shared suite, both directions) ---------

defineNestingGuardSuite({
  label: 'claude-companion',
  mod: companionModule,
  scriptPath: fileURLToPath(new URL('../claude-companion.mjs', import.meta.url)),
  peerBin: PEER_CLI_BIN,
});

describe('contract version export', () => {
  it('exports CONTRACT_VERSION matching contract.md', () => {
    assert.equal(CONTRACT_VERSION, '0.1.1');
  });
});
