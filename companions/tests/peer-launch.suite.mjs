// Shared test suite for how both companions start their peer CLI through
// peer-cli.mjs (C180 part 1): the resolved command and argument prefix reach
// spawn, a resolution failure spawns nothing and ends in the contract § 5.3
// exit-3 peer_cli_not_found envelope in both output modes, and a spawn error
// after resolution names the launch. Both per-companion test files call
// definePeerLaunchSuite() with their own module, so the two directions are
// held to one definition.
//
// Not discovered by `node --test` on its own (no *.test.mjs suffix, per
// ADR-0033); it runs through claude-companion.test.mjs and
// codex-companion.test.mjs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

class FakeStdin extends Readable {
  constructor(content) {
    super();
    this.isTTY = false;
    this._chunks = [content];
  }
  _read() {
    const chunk = this._chunks.shift();
    if (chunk == null) this.push(null);
    else this.push(Buffer.from(chunk, 'utf8'));
  }
}

class Captured {
  constructor() { this.chunks = []; }
  write(s) { this.chunks.push(s); return true; }
  get value() { return this.chunks.join(''); }
}

function makeFakeChild({ spawnError = null, exitCode = 0, stdout = '' } = {}) {
  const child = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { end() {} });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  setImmediate(() => {
    if (spawnError) { child.emit('error', spawnError); return; }
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

const unresolved = (message) => () => ({ ok: false, kind: 'peer_cli_not_found', message, detail: 'why' });

export function definePeerLaunchSuite({ label, mod, scriptPath, peerBin, overrideEnv }) {
  const { invokePeer, main, classifyResult, EXIT_PEER_INFRA, STATUS, ERROR_KIND } = mod;

  describe(`${label}: peer CLI launch (peer-cli.mjs)`, () => {
    it('spawns the resolved command with its argument prefix before the peer arguments', async () => {
      const spawnImpl = recordingSpawn(makeFakeChild());
      const seen = [];
      const resolveImpl = (name, opts) => {
        seen.push({ name, env: opts.env });
        return { ok: true, command: '/node', argsPrefix: ['/npm/dir with space/cli.js'], source: 'path', shim: '/npm/x.cmd' };
      };
      const env = { MARK: '1' };
      await invokePeer({ prompt: 'p', options: {} }, { spawnImpl, resolveImpl, env });
      assert.deepEqual(seen, [{ name: peerBin, env }], 'resolves the peer by name with the injected environment');
      assert.equal(spawnImpl.calls.length, 1);
      assert.equal(spawnImpl.calls[0].bin, '/node');
      assert.equal(spawnImpl.calls[0].args[0], '/npm/dir with space/cli.js');
      assert.ok(spawnImpl.calls[0].args.length > 1, 'the peer arguments follow the prefix');
      assert.equal(spawnImpl.calls[0].opts.shell, undefined, 'never a shell');
    });

    it('a resolution failure spawns nothing and returns a complete invocation', async () => {
      const spawnImpl = recordingSpawn(makeFakeChild());
      const r = await invokePeer({ prompt: 'p', options: {} }, { spawnImpl, resolveImpl: unresolved('m'), env: {} });
      assert.equal(spawnImpl.calls.length, 0);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, '');
      assert.equal(r.spawnError, null);
      assert.ok(r.startedAt && r.completedAt && Number.isFinite(r.durationMs));
      assert.deepEqual(classifyResult(r), {
        status: STATUS.COMPANION_ERROR,
        exit_code: EXIT_PEER_INFRA,
        error: { kind: ERROR_KIND.CLI_NOT_FOUND, message: 'm', detail: 'why' },
      });
    });

    for (const format of ['json', 'text']) {
      it(`main(): a resolution failure exits 3 in ${format} mode with the resolver's message`, async () => {
        const spawnImpl = recordingSpawn(makeFakeChild());
        const stdout = new Captured();
        const stderr = new Captured();
        const message = `peer CLI "${peerBin}": ${overrideEnv}=/x names no file`;
        const code = await main(['task', '--output-format', format], {
          stdin: new FakeStdin('<task>hi</task>'), stdout, stderr, spawnImpl, env: {},
          resolveImpl: unresolved(message),
        });
        assert.equal(code, EXIT_PEER_INFRA);
        assert.equal(spawnImpl.calls.length, 0);
        assert.ok(stderr.value.includes(overrideEnv), 'stderr names the variable');
        if (format === 'json') {
          const envelope = JSON.parse(stdout.value);
          assert.equal(envelope.status, STATUS.COMPANION_ERROR);
          assert.equal(envelope.exit_code, 3);
          assert.equal(envelope.error.kind, 'peer_cli_not_found');
          assert.equal(envelope.error.message, message);
          assert.equal(envelope.stdout, '');
        } else {
          assert.equal(stdout.value, '');
        }
      });
    }

    it('a spawn error after resolution names the resolved launch and its source', async () => {
      const err = Object.assign(new Error('gone'), { code: 'ENOENT' });
      const viaShim = await invokePeer({ prompt: 'p', options: {} }, {
        spawnImpl: recordingSpawn(makeFakeChild({ spawnError: err })), env: {},
        resolveImpl: () => ({ ok: true, command: '/node', argsPrefix: ['/t.js'], source: 'override', shim: '/s.cmd' }),
      });
      const m = classifyResult(viaShim).error.message;
      assert.ok(m.includes('/node /t.js') && m.includes('/s.cmd') && m.includes(overrideEnv), m);
      const bare = await invokePeer({ prompt: 'p', options: {} }, {
        spawnImpl: recordingSpawn(makeFakeChild({ spawnError: err })), env: {},
        resolveImpl: () => ({ ok: true, command: peerBin, argsPrefix: [], source: 'bare', shim: null }),
      });
      assert.equal(classifyResult(bare).error.kind, 'peer_cli_not_found');
      assert.ok(classifyResult(bare).error.message.includes(overrideEnv));
      const busy = await invokePeer({ prompt: 'p', options: {} }, {
        spawnImpl: recordingSpawn(makeFakeChild({ spawnError: Object.assign(new Error('EMFILE'), { code: 'EMFILE' }) })), env: {},
        resolveImpl: () => ({ ok: true, command: peerBin, argsPrefix: [], source: 'bare', shim: null }),
      });
      assert.ok(classifyResult(busy).error.message.includes(`"${peerBin}"`), 'a bare launch failure names the CLI');
    });

    it('an executable the OS cannot load or may not run (EFTYPE, ENOEXEC, EPERM) is peer_cli_not_found naming the launch; other start failures name it too', async () => {
      const run = async (code) => classifyResult(await invokePeer({ prompt: 'p', options: {} }, {
        spawnImpl: recordingSpawn(makeFakeChild({ spawnError: Object.assign(new Error(code), { code }) })), env: {},
        resolveImpl: () => ({ ok: true, command: 'C:\\Apps\\broken.exe', argsPrefix: [], source: 'override', shim: null }),
      })).error;
      for (const code of ['EFTYPE', 'ENOEXEC', 'EPERM']) {
        const e = await run(code);
        assert.equal(e.kind, 'peer_cli_not_found', code);
        assert.ok(e.message.includes('broken.exe') && e.message.includes(overrideEnv), e.message);
      }
      const other = await run('EMFILE');
      assert.equal(other.kind, 'peer_invocation_error');
      assert.ok(other.message.includes('broken.exe') && other.message.includes(overrideEnv), other.message);
    });

    it('end to end: the script honours the override variable and refuses a missing one', { skip: process.platform === 'win32' }, () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'peer-launch 실행-'));
      try {
        const fake = path.join(root, `fake ${peerBin}`);
        writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\necho FAKE-PEER-RAN\n');
        chmodSync(fake, 0o755);
        const run = (value) => spawnSync(process.execPath, [scriptPath, 'task', '--output-format', 'json'], {
          input: '<task>hi</task>',
          encoding: 'utf8',
          env: { PATH: process.env.PATH, HOME: root, [overrideEnv]: value },
        });
        const ok = run(fake);
        assert.ok(ok.stdout.includes('FAKE-PEER-RAN'), `override ran: ${ok.stdout} ${ok.stderr}`);
        const missing = run(path.join(root, 'missing'));
        assert.equal(missing.status, 3, missing.stderr);
        const envelope = JSON.parse(missing.stdout);
        assert.equal(envelope.error.kind, 'peer_cli_not_found');
        assert.ok(envelope.error.message.includes(overrideEnv), envelope.error.message);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
}
