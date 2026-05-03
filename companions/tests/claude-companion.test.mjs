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

// --- helpers ---------------------------------------------------------------

class FakeStdin extends Readable {
  constructor(content, { isTTY } = { isTTY: false }) {
    super();
    this.isTTY = isTTY;
    this._chunks = content == null ? [] : [content];
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

  it('throws on --prompt-file + piped stdin', async () => {
    const parsed = parseArguments(['task', '--prompt-file', '/x']);
    const stdin = new FakeStdin('extra', { isTTY: false });
    await assert.rejects(
      () => resolvePromptInput({ parsed, stdin }),
      /--prompt-file conflicts with piped stdin/,
    );
  });

  it('throws on PROMPT_ARG + piped stdin', async () => {
    const parsed = parseArguments(['task', 'inline']);
    const stdin = new FakeStdin('extra', { isTTY: false });
    await assert.rejects(
      () => resolvePromptInput({ parsed, stdin }),
      /PROMPT_ARG conflicts with piped stdin/,
    );
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

  it('does not match unrelated stderr', () => {
    assert.equal(AUTH_REGEX.test('rate limit exceeded'), false);
    assert.equal(AUTH_REGEX.test('connection reset by peer'), false);
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

  it('success envelope has required keys, no error object', () => {
    const cls = { status: STATUS.SUCCESS, exit_code: EXIT_SUCCESS, error: null };
    const env = buildEnvelope({
      invocation,
      classification: cls,
      options: { model: null, outputFormat: 'json' },
    });
    assert.equal(env.status, STATUS.SUCCESS);
    assert.equal(env.peer_host, PEER_HOST);
    assert.equal(env.peer_model, null);
    assert.equal(env.stdout, 'peer text');
    assert.equal(env.exit_code, EXIT_SUCCESS);
    assert.ok(env.metadata);
    assert.equal(env.metadata.duration_ms, 42);
    assert.ok(!('error' in env), 'success envelope MUST NOT include error');
  });

  it('error envelope includes error object with kind/message', () => {
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

  it('passes peer args from buildClaudeArgs', async () => {
    const spawnFn = fakeSpawnReturning(makeFakeChild({ exitCode: 0 }));
    await invokePeer(
      { prompt: 'x', options: { model: 'opus', effort: 'high' } },
      { spawnImpl: spawnFn },
    );
    const { bin, args } = fakeSpawnReturning.lastCall;
    assert.equal(bin, PEER_CLI_BIN);
    assert.ok(args.includes('--model'));
    assert.ok(args.includes('opus'));
    assert.ok(args.includes('--effort'));
    assert.ok(args.includes('high'));
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

  it('happy path json mode → envelope written to stdout', async () => {
    const spawnFn = fakeSpawnReturning(makeFakeChild({ stdout: 'PEER', exitCode: 0 }));
    const stdout = new CapturedStream();
    const stderr = new CapturedStream();
    const stdin = new FakeStdin('<task>hi</task>', { isTTY: false });
    const code = await main(
      ['task', '--output-format', 'json'],
      { stdin, stdout, stderr, spawnImpl: spawnFn },
    );
    assert.equal(code, EXIT_SUCCESS);
    const env = JSON.parse(stdout.value);
    assert.equal(env.status, STATUS.SUCCESS);
    assert.equal(env.peer_host, PEER_HOST);
    assert.equal(env.stdout, 'PEER');
    assert.equal(env.exit_code, EXIT_SUCCESS);
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

  it('removes signal handlers after invocation completes', async () => {
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
});

describe('contract version export', () => {
  it('exports CONTRACT_VERSION matching contract.md', () => {
    assert.equal(CONTRACT_VERSION, '0.1.0');
  });
});
