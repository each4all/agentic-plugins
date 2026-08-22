// Shared test suite for the cooperative nested-peer-invocation guard that both
// companions implement identically (companions/README.md § Nested peer
// invocation guard). Both per-companion test files call
// defineNestingGuardSuite() with their own module, script path and peer CLI
// name, so the guard is asserted in both directions from ONE definition — the
// guard is a mirror by construction, and a drifting copy is exactly the
// failure mode a single shared suite prevents.
//
// Not discovered by `node --test` on its own (no *.test.mjs suffix, per
// ADR-0033); it runs through claude-companion.test.mjs and
// codex-companion.test.mjs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// --- minimal local helpers (self-contained on purpose) ----------------------

class CountingStdin extends Readable {
  constructor(content, { isTTY } = { isTTY: false }) {
    super();
    this.isTTY = isTTY;
    this.reads = 0;
    this._chunks = content == null ? [] : [content];
  }
  _read() {
    this.reads += 1;
    const chunk = this._chunks.shift();
    if (chunk == null) this.push(null);
    else this.push(Buffer.from(chunk, 'utf8'));
  }
}

function makeFakeChild({ stdout = '', exitCode = 0 } = {}) {
  const child = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), {
    lastWrite: undefined,
    end(data) { this.lastWrite = data; },
  });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout, 'utf8'));
    child.emit('close', exitCode, null);
  });
  return child;
}

function recordingSpawn(child) {
  const calls = [];
  const fn = (bin, args, opts) => { calls.push({ bin, args, opts }); return child; };
  fn.calls = calls;
  return fn;
}

class CapturedStream {
  constructor() { this.chunks = []; }
  write(s) { this.chunks.push(s); return true; }
  get value() { return this.chunks.join(''); }
}

// A caller environment with an unrelated variable, so pass-through (contract
// § 2.4: companions do not consume or filter peer-host env) is observable.
const BASE_ENV = Object.freeze({ PATH: '/usr/bin:/bin', HOME: '/home/peer', SOME_PASSTHROUGH: 'kept' });

function withEnv(overrides) {
  return { ...BASE_ENV, ...overrides };
}

const MALFORMED_MARKERS = ['', ' ', 'abc', '-1', '1.5', ' 1', '1 ', '+1', '0x1', '1e3', '٣', '1\n', '00', '01', '007', '000002'];

export function defineNestingGuardSuite({ label, mod, scriptPath, peerBin }) {
  const {
    checkNesting,
    buildNestingRefusal,
    childEnvForPeer,
    invokePeer,
    main,
    NESTING_DEPTH_ENV,
    NESTING_MAX_DEPTH_ENV,
    DEFAULT_MAX_NESTING_DEPTH,
    STATUS,
    ERROR_KIND,
    EXIT_SUCCESS,
    EXIT_COMPANION_MISUSE,
    EXIT_PEER_INFRA,
    PEER_HOST,
  } = mod;

  describe(`${label} — nested peer invocation guard (cooperative, not a security boundary)`, () => {
    describe('constants', () => {
      it('names the marker + bound variables and defaults the bound to 1', () => {
        assert.equal(NESTING_DEPTH_ENV, 'AGENTIC_COMPANION_DEPTH');
        assert.equal(NESTING_MAX_DEPTH_ENV, 'AGENTIC_COMPANION_MAX_DEPTH');
        assert.equal(DEFAULT_MAX_NESTING_DEPTH, 1);
      });
    });

    describe('checkNesting', () => {
      it('absent marker → depth 0, not refused (top-level caller; contract § 2.4: no env var is required)', () => {
        const r = checkNesting(withEnv({}));
        assert.deepEqual(
          { refused: r.refused, depth: r.depth, max: r.max, reason: r.reason },
          { refused: false, depth: 0, max: DEFAULT_MAX_NESTING_DEPTH, reason: null },
        );
      });

      it('explicit "0" → top-level, not refused', () => {
        const r = checkNesting(withEnv({ [NESTING_DEPTH_ENV]: '0' }));
        assert.equal(r.refused, false);
        assert.equal(r.depth, 0);
      });

      it('marker at the default bound ("1") → refused, reason depth', () => {
        const r = checkNesting(withEnv({ [NESTING_DEPTH_ENV]: '1' }));
        assert.equal(r.refused, true);
        assert.equal(r.reason, 'depth');
        assert.equal(r.depth, 1);
        assert.equal(r.max, 1);
      });

      it('marker above the bound ("7") → refused, reason depth', () => {
        const r = checkNesting(withEnv({ [NESTING_DEPTH_ENV]: '7' }));
        assert.equal(r.refused, true);
        assert.equal(r.reason, 'depth');
        assert.equal(r.depth, 7);
      });

      it('an explicit bound widens deliberately: depth 1 under AGENTIC_COMPANION_MAX_DEPTH=2 passes, depth 2 is refused', () => {
        assert.equal(checkNesting(withEnv({ [NESTING_DEPTH_ENV]: '1', [NESTING_MAX_DEPTH_ENV]: '2' })).refused, false);
        const r = checkNesting(withEnv({ [NESTING_DEPTH_ENV]: '2', [NESTING_MAX_DEPTH_ENV]: '2' }));
        assert.equal(r.refused, true);
        assert.equal(r.max, 2);
      });

      it('AGENTIC_COMPANION_MAX_DEPTH=0 refuses even a top-level caller (an explicit dispatch kill-switch)', () => {
        const r = checkNesting(withEnv({ [NESTING_MAX_DEPTH_ENV]: '0' }));
        assert.equal(r.refused, true);
        assert.equal(r.reason, 'depth');
        assert.equal(r.depth, 0);
        assert.equal(r.max, 0);
      });

      it('malformed marker values are treated as nested (fail closed), never as top-level', () => {
        for (const raw of MALFORMED_MARKERS) {
          const r = checkNesting(withEnv({ [NESTING_DEPTH_ENV]: raw }));
          assert.equal(r.refused, true, `raw=${JSON.stringify(raw)} must refuse`);
          assert.equal(r.reason, 'malformed', `raw=${JSON.stringify(raw)} reason`);
          assert.equal(r.depth, null, `raw=${JSON.stringify(raw)} depth is unknown`);
        }
      });

      it('a malformed bound falls back to the default bound (a typo never widens the guard)', () => {
        for (const raw of ['', 'abc', '-1', '2.0', ' 2', '+2', '02', '007']) {
          const r = checkNesting(withEnv({ [NESTING_DEPTH_ENV]: '1', [NESTING_MAX_DEPTH_ENV]: raw }));
          assert.equal(r.max, DEFAULT_MAX_NESTING_DEPTH, `bound raw=${JSON.stringify(raw)} falls back`);
          assert.equal(r.refused, true, `bound raw=${JSON.stringify(raw)} still refuses depth 1`);
        }
        // Control: a well-formed bound is honoured.
        assert.equal(checkNesting(withEnv({ [NESTING_DEPTH_ENV]: '1', [NESTING_MAX_DEPTH_ENV]: '2' })).refused, false);
      });

      it('accepts canonical multi-digit integers with no length cap (regression: the old 6-digit cap wrongly rejected them)', () => {
        // A 7-digit marker is a valid nested depth → refused by depth, not by malform.
        const r = checkNesting(withEnv({ [NESTING_DEPTH_ENV]: '1000000' }));
        assert.equal(r.refused, true);
        assert.equal(r.reason, 'depth');
        assert.equal(r.depth, 1000000);
        // A 7-digit bound is honoured (not a malformed fallback): depth 5 under it passes.
        assert.equal(checkNesting(withEnv({ [NESTING_DEPTH_ENV]: '5', [NESTING_MAX_DEPTH_ENV]: '1000000' })).refused, false);
        // '0' alone stays valid (top-level), only leading-zeroed multi-digits are malformed.
        assert.equal(checkNesting(withEnv({ [NESTING_DEPTH_ENV]: '0' })).malformed ?? false, false);
      });
    });

    describe('buildNestingRefusal → contract § 5.3 triple', () => {
      it('reuses the existing peer_invocation_error row: companion_error / 3 / peer_invocation_error', () => {
        const c = buildNestingRefusal(checkNesting(withEnv({ [NESTING_DEPTH_ENV]: '1' })));
        assert.equal(c.status, STATUS.COMPANION_ERROR);
        assert.equal(c.exit_code, EXIT_PEER_INFRA);
        assert.equal(c.error.kind, ERROR_KIND.INVOKE);
        assert.match(c.error.message, /nested peer dispatch refused/);
        assert.match(c.error.message, /AGENTIC_COMPANION_DEPTH=1/);
        assert.match(c.error.message, /AGENTIC_COMPANION_MAX_DEPTH=1/);
        assert.equal(c.error.message.includes('\n'), false, '§ 5.2 — single-line message');
        assert.ok(c.error.message.length <= 200, '§ 5.2 — stays under ~200 chars');
        assert.match(c.error.detail, /not a security boundary/);
        assert.match(c.error.detail, /AGENTIC_COMPANION_MAX_DEPTH/);
        assert.match(c.error.detail, /strip/i, 'detail names the env-stripping wrapper limit');
      });

      it('malformed marker → same triple; message says malformed + fail closed and quotes the value on one line', () => {
        const c = buildNestingRefusal(checkNesting(withEnv({ [NESTING_DEPTH_ENV]: 'ban\nana' })));
        assert.equal(c.status, STATUS.COMPANION_ERROR);
        assert.equal(c.exit_code, EXIT_PEER_INFRA);
        assert.equal(c.error.kind, ERROR_KIND.INVOKE);
        assert.match(c.error.message, /malformed/);
        assert.match(c.error.message, /fail closed/);
        assert.equal(c.error.message.includes('\n'), false, 'the raw value is escaped, not embedded');
        assert.ok(c.error.message.length <= 200);
      });

      it('a very long malformed value is truncated in the message', () => {
        const c = buildNestingRefusal(checkNesting(withEnv({ [NESTING_DEPTH_ENV]: 'x'.repeat(500) })));
        assert.ok(c.error.message.length <= 200, `message length ${c.error.message.length}`);
      });

      it('does not name the peer host (the guard reads identically in both directions)', () => {
        const c = buildNestingRefusal(checkNesting(withEnv({ [NESTING_DEPTH_ENV]: '1' })));
        assert.equal(c.error.message.includes(PEER_HOST), false);
        assert.equal(c.error.detail.includes(PEER_HOST), false);
      });

      it('refuses to build a refusal for a non-refused check (programming-error guard)', () => {
        assert.throws(() => buildNestingRefusal(checkNesting(withEnv({}))), /not refused/);
      });
    });

    describe('marker propagation (childEnvForPeer + invokePeer)', () => {
      it('stamps depth+1 on the peer environment and keeps every other variable (pass-through, contract § 2.4)', () => {
        const env = childEnvForPeer(withEnv({}), 0);
        assert.equal(env[NESTING_DEPTH_ENV], '1');
        assert.equal(env.SOME_PASSTHROUGH, 'kept');
        assert.equal(env.PATH, BASE_ENV.PATH);
        assert.equal(env.HOME, BASE_ENV.HOME);
        assert.equal(childEnvForPeer(withEnv({ [NESTING_DEPTH_ENV]: '2' }), 2)[NESTING_DEPTH_ENV], '3');
      });

      it('does not mutate the caller environment object', () => {
        const env = withEnv({});
        childEnvForPeer(env, 0);
        assert.equal(NESTING_DEPTH_ENV in env, false);
      });

      it('invokePeer spawns the peer CLI with the stamped environment', async () => {
        const spawnFn = recordingSpawn(makeFakeChild({ exitCode: 0 }));
        await invokePeer({ prompt: 'x', options: {} }, { spawnImpl: spawnFn, env: withEnv({}) });
        assert.equal(spawnFn.calls.length, 1);
        assert.equal(spawnFn.calls[0].bin, peerBin);
        assert.equal(spawnFn.calls[0].opts.env[NESTING_DEPTH_ENV], '1');
        assert.equal(spawnFn.calls[0].opts.env.SOME_PASSTHROUGH, 'kept');
      });

      it('invokePeer at depth 1 under bound 2 stamps "2" — the guard counts, it never resets', async () => {
        const spawnFn = recordingSpawn(makeFakeChild({ exitCode: 0 }));
        await invokePeer(
          { prompt: 'x', options: {} },
          { spawnImpl: spawnFn, env: withEnv({ [NESTING_DEPTH_ENV]: '1', [NESTING_MAX_DEPTH_ENV]: '2' }) },
        );
        assert.equal(spawnFn.calls[0].opts.env[NESTING_DEPTH_ENV], '2');
      });
    });

    describe('main() — refusal happens before stdin is read and before any spawn', () => {
      const PROMPT = '<task>hi</task>';

      it('text mode: exit 3, empty stdout, one-line stderr, spawn not called, stdin not read', async () => {
        const spawnFn = recordingSpawn(makeFakeChild({ stdout: 'MUST NOT APPEAR', exitCode: 0 }));
        const stdin = new CountingStdin(PROMPT, { isTTY: false });
        const stdout = new CapturedStream();
        const stderr = new CapturedStream();
        const code = await main(['task'], { stdin, stdout, stderr, spawnImpl: spawnFn, env: withEnv({ [NESTING_DEPTH_ENV]: '1' }) });
        assert.equal(code, EXIT_PEER_INFRA);
        assert.equal(stdout.value, '', 'text mode: nothing from the peer because there was no peer');
        assert.match(stderr.value, /nested peer dispatch refused/);
        assert.equal(stderr.value.trim().split('\n').length, 1, '§ 5.2 — single stderr line');
        assert.equal(spawnFn.calls.length, 0, 'no peer process was spawned');
        assert.equal(stdin.reads, 0, 'stdin was not read');
      });

      it('json mode: envelope companion_error / 3 / peer_invocation_error, empty stdout, peer_model echoes --model, no metadata (peer never ran)', async () => {
        const spawnFn = recordingSpawn(makeFakeChild({ exitCode: 0 }));
        const stdin = new CountingStdin(PROMPT, { isTTY: false });
        const stdout = new CapturedStream();
        const stderr = new CapturedStream();
        const code = await main(
          ['task', '--output-format', 'json', '--model', 'peer-model'],
          { stdin, stdout, stderr, spawnImpl: spawnFn, env: withEnv({ [NESTING_DEPTH_ENV]: '1' }) },
        );
        assert.equal(code, EXIT_PEER_INFRA);
        const env = JSON.parse(stdout.value);
        assert.equal(env.status, STATUS.COMPANION_ERROR);
        assert.equal(env.peer_host, PEER_HOST);
        assert.equal(env.peer_model, 'peer-model');
        assert.equal(env.stdout, '');
        assert.equal(env.exit_code, EXIT_PEER_INFRA);
        assert.equal(env.error.kind, ERROR_KIND.INVOKE);
        assert.match(env.error.message, /nested peer dispatch refused/);
        assert.match(env.error.detail, /not a security boundary/);
        assert.equal('metadata' in env, false, 'metadata omitted — the peer never ran (same as the misuse envelope)');
        assert.equal(stderr.value.trim().split('\n').length, 1);
        assert.equal(spawnFn.calls.length, 0);
        assert.equal(stdin.reads, 0);
      });

      it('spoofed / malformed marker refuses in both output modes', async () => {
        for (const format of ['text', 'json']) {
          const spawnFn = recordingSpawn(makeFakeChild({ exitCode: 0 }));
          const stdin = new CountingStdin(PROMPT, { isTTY: false });
          const stdout = new CapturedStream();
          const stderr = new CapturedStream();
          const code = await main(
            ['task', '--output-format', format],
            { stdin, stdout, stderr, spawnImpl: spawnFn, env: withEnv({ [NESTING_DEPTH_ENV]: 'banana' }) },
          );
          assert.equal(code, EXIT_PEER_INFRA, `${format}: exit`);
          assert.match(stderr.value, /malformed/, `${format}: stderr`);
          assert.equal(spawnFn.calls.length, 0, `${format}: no spawn`);
          assert.equal(stdin.reads, 0, `${format}: stdin untouched`);
          if (format === 'json') {
            const env = JSON.parse(stdout.value);
            assert.equal(env.error.kind, ERROR_KIND.INVOKE);
            assert.match(env.error.message, /fail closed/);
          } else {
            assert.equal(stdout.value, '');
          }
        }
      });

      it('control: absent marker proceeds — the peer is spawned with the marker stamped and the run succeeds', async () => {
        const spawnFn = recordingSpawn(makeFakeChild({ stdout: 'PEER OUT', exitCode: 0 }));
        const stdin = new CountingStdin(PROMPT, { isTTY: false });
        const stdout = new CapturedStream();
        const stderr = new CapturedStream();
        const code = await main(['task'], { stdin, stdout, stderr, spawnImpl: spawnFn, env: withEnv({}) });
        assert.equal(code, EXIT_SUCCESS);
        assert.equal(stdout.value, 'PEER OUT');
        assert.equal(stderr.value, '');
        assert.equal(spawnFn.calls.length, 1);
        assert.equal(spawnFn.calls[0].opts.env[NESTING_DEPTH_ENV], '1');
        assert.ok(stdin.reads > 0, 'stdin was read on the happy path');
      });

      it('control: explicit "0" proceeds like an absent marker', async () => {
        const spawnFn = recordingSpawn(makeFakeChild({ stdout: 'ok', exitCode: 0 }));
        const code = await main(['task'], {
          stdin: new CountingStdin(PROMPT, { isTTY: false }),
          stdout: new CapturedStream(),
          stderr: new CapturedStream(),
          spawnImpl: spawnFn,
          env: withEnv({ [NESTING_DEPTH_ENV]: '0' }),
        });
        assert.equal(code, EXIT_SUCCESS);
        assert.equal(spawnFn.calls.length, 1);
        assert.equal(spawnFn.calls[0].opts.env[NESTING_DEPTH_ENV], '1');
      });

      it('control: depth 1 under an explicit bound of 2 proceeds and stamps 2', async () => {
        const spawnFn = recordingSpawn(makeFakeChild({ stdout: 'ok', exitCode: 0 }));
        const code = await main(['task'], {
          stdin: new CountingStdin(PROMPT, { isTTY: false }),
          stdout: new CapturedStream(),
          stderr: new CapturedStream(),
          spawnImpl: spawnFn,
          env: withEnv({ [NESTING_DEPTH_ENV]: '1', [NESTING_MAX_DEPTH_ENV]: '2' }),
        });
        assert.equal(code, EXIT_SUCCESS);
        assert.equal(spawnFn.calls[0].opts.env[NESTING_DEPTH_ENV], '2');
      });

      it('argument misuse still wins over the guard (parse failure → exit 2, no envelope, no spawn)', async () => {
        const spawnFn = recordingSpawn(makeFakeChild({ exitCode: 0 }));
        const stdout = new CapturedStream();
        const stderr = new CapturedStream();
        const code = await main(['review'], {
          stdin: new CountingStdin(PROMPT, { isTTY: false }),
          stdout, stderr, spawnImpl: spawnFn,
          env: withEnv({ [NESTING_DEPTH_ENV]: '1' }),
        });
        assert.equal(code, EXIT_COMPANION_MISUSE);
        assert.equal(stdout.value, '');
        assert.match(stderr.value, /only "task" is supported/);
        assert.equal(spawnFn.calls.length, 0);
      });

      it('§ 2.3 dual-source misuse wins over the guard (both explicit sources → exit 2, not the guard\'s 3) — detectable with no stdin read', async () => {
        for (const format of ['text', 'json']) {
          const spawnFn = recordingSpawn(makeFakeChild({ exitCode: 0 }));
          const stdin = new CountingStdin(PROMPT, { isTTY: false });
          const stdout = new CapturedStream();
          const stderr = new CapturedStream();
          const code = await main(
            ['task', 'inline-prompt', '--prompt-file', '/definitely/not/read', '--output-format', format],
            { stdin, stdout, stderr, spawnImpl: spawnFn, env: withEnv({ [NESTING_DEPTH_ENV]: '1' }) },
          );
          assert.equal(code, EXIT_COMPANION_MISUSE, `${format}: contract § 2.3 requires exit 2, the guard must not turn it into 3`);
          assert.match(stderr.value, /mutually exclusive/, `${format}: stderr names the § 2.3 conflict`);
          assert.equal(spawnFn.calls.length, 0, `${format}: no spawn`);
          assert.equal(stdin.reads, 0, `${format}: the misuse is decided without reading stdin`);
          if (format === 'json') {
            const env = JSON.parse(stdout.value);
            assert.equal(env.error.kind, ERROR_KIND.MISUSE, 'JSON envelope carries companion_misuse, not peer_invocation_error');
            assert.equal(env.exit_code, EXIT_COMPANION_MISUSE);
          } else {
            assert.equal(stdout.value, '');
          }
        }
      });

      it('§ 2.3 missing-input-with-TTY wins over the guard (no source + TTY → exit 2, not 3)', async () => {
        const spawnFn = recordingSpawn(makeFakeChild({ exitCode: 0 }));
        const stdin = new CountingStdin(null, { isTTY: true });
        const stdout = new CapturedStream();
        const stderr = new CapturedStream();
        const code = await main(
          ['task', '--output-format', 'json'],
          { stdin, stdout, stderr, spawnImpl: spawnFn, env: withEnv({ [NESTING_DEPTH_ENV]: '1' }) },
        );
        assert.equal(code, EXIT_COMPANION_MISUSE, 'no input source + TTY is a § 2.3 misuse (exit 2), decided before the guard');
        const env = JSON.parse(stdout.value);
        assert.equal(env.error.kind, ERROR_KIND.MISUSE);
        assert.equal(spawnFn.calls.length, 0);
      });

      it('main() defaults to process.env when no env is injected (the CLI path) — guarded by a scoped process.env marker', async () => {
        const spawnFn = recordingSpawn(makeFakeChild({ exitCode: 0 }));
        const prior = process.env[NESTING_DEPTH_ENV];
        process.env[NESTING_DEPTH_ENV] = '1';
        try {
          const code = await main(['task'], {
            stdin: new CountingStdin(PROMPT, { isTTY: false }),
            stdout: new CapturedStream(),
            stderr: new CapturedStream(),
            spawnImpl: spawnFn,
          });
          assert.equal(code, EXIT_PEER_INFRA);
          assert.equal(spawnFn.calls.length, 0);
        } finally {
          if (prior === undefined) delete process.env[NESTING_DEPTH_ENV];
          else process.env[NESTING_DEPTH_ENV] = prior;
        }
      });
    });

    describe('real script process (hermetic: fake peer CLI on PATH, no network)', () => {
      const skip = process.platform === 'win32' ? 'POSIX fake peer script' : false;

      function makeFakePeerDir() {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'companion-nesting-'));
        const bin = path.join(dir, 'bin');
        mkdirSync(bin);
        // The fake peer prints the marker it received and exits 0; the
        // companion forwards that as the peer's verbatim stdout (§ 4.1).
        const fake = path.join(bin, peerBin);
        writeFileSync(fake, `#!/bin/sh\nprintf '%s' "\${${NESTING_DEPTH_ENV}-<unset>}"\n`, 'utf8');
        chmodSync(fake, 0o755);
        return { dir, bin };
      }

      function runScript(argv, env, input = '<task>x</task>') {
        return spawnSync(process.execPath, [scriptPath, ...argv], {
          env,
          input,
          encoding: 'utf8',
          timeout: 30000,
        });
      }

      it('nested marker → the real CLI exits 3 with the refusal envelope and a single stderr line', { skip }, () => {
        const { dir, bin } = makeFakePeerDir();
        try {
          const r = runScript(['task', '--output-format', 'json'], { PATH: bin, HOME: dir, [NESTING_DEPTH_ENV]: '1' });
          assert.equal(r.status, EXIT_PEER_INFRA, `stderr=${r.stderr}`);
          const env = JSON.parse(r.stdout);
          assert.equal(env.status, STATUS.COMPANION_ERROR);
          assert.equal(env.exit_code, EXIT_PEER_INFRA);
          assert.equal(env.error.kind, ERROR_KIND.INVOKE);
          assert.equal(env.stdout, '', 'the fake peer never ran (its marker line is absent)');
          assert.equal(r.stderr.trim().split('\n').length, 1);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it('control: no marker + no peer on PATH → exit 3 / peer_cli_not_found (the guard did not fire; the spawn was attempted)', { skip }, () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'companion-nesting-empty-'));
        try {
          const r = runScript(['task', '--output-format', 'json'], { PATH: dir, HOME: dir });
          assert.equal(r.status, EXIT_PEER_INFRA, `stderr=${r.stderr}`);
          const env = JSON.parse(r.stdout);
          assert.equal(env.error.kind, ERROR_KIND.CLI_NOT_FOUND);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it('the real spawn path stamps AGENTIC_COMPANION_DEPTH=1 into the peer CLI environment', { skip }, () => {
        const { dir, bin } = makeFakePeerDir();
        try {
          const r = runScript(['task'], { PATH: bin, HOME: dir });
          assert.equal(r.status, EXIT_SUCCESS, `stderr=${r.stderr}`);
          assert.equal(r.stdout, '1');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it('a caller-set depth 1 under bound 2 reaches the peer CLI as 2', { skip }, () => {
        const { dir, bin } = makeFakePeerDir();
        try {
          const r = runScript(['task'], { PATH: bin, HOME: dir, [NESTING_DEPTH_ENV]: '1', [NESTING_MAX_DEPTH_ENV]: '2' });
          assert.equal(r.status, EXIT_SUCCESS, `stderr=${r.stderr}`);
          assert.equal(r.stdout, '2');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });
  });
}
