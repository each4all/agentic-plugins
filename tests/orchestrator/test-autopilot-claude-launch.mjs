// C180: the autopilot starts Claude Code the way the companions start their
// peer, and its preflight and its workers agree on one launch
// (plugins/orchestrator/adapters/claude/autopilot/worker.mjs resolveClaudeLaunch
// over the orchestrator's copy of companions/peer-cli.mjs; driver.mjs
// checkClaudeCli). The resolver's own cases live beside the companions
// (companions/tests/peer-cli.test.mjs); these hold what the autopilot adds:
// AUTOPILOT_CLAUDE_BIN's precedence and naming, the preflight probing through
// the launch it hands on, and a launch whose target is gone failing the step
// with its reason and no process.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tmpDir } from '../_tmp.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const W = await import(resolve(AP, 'worker.mjs'));
const { checkClaudeCli, REQUIRED_CLAUDE_FLAGS } = await import(resolve(AP, 'driver.mjs'));
const { CMD_SHIM_LAYOUTS } = await import(resolve(REPO_ROOT, 'plugins/orchestrator/scripts/lib/peer-cli.mjs'));

const FAKE = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-fake-claude.mjs');
const ROOTS = { orchestrator: '/roots/orchestrator', engineer: '/roots/engineer', runtime: '/roots/runtime' };

function executable(dir, name) {
  const file = join(dir, name);
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
  return file;
}

describe('resolveClaudeLaunch (C180)', () => {
  it('with no override off Windows, pins claude to the absolute path PATH gives at the run\'s start', (t) => {
    const dir = tmpDir(t, 'autopilot-claude-launch-');
    const found = executable(dir, 'claude');
    const l = W.resolveClaudeLaunch({ PATH: `${join(dir, 'empty')}:${dir}` }, { platform: 'linux' });
    deepStrictEqual([l.ok, l.command, l.argsPrefix, l.source, l.variable], [true, found, [], 'path', 'CLAUDE_BIN']);
    rmSync(found);
    ok(W.launchGone(l).includes(`${found} no longer exists`), 'a pinned claude removed since is named, never looked up again');
  });

  it('with no claude the resolver can find, keeps the bare name for spawn\'s own search, as before', (t) => {
    const dir = tmpDir(t, 'autopilot-claude-launch-');
    for (const env of [{ PATH: dir }, {}]) {
      const l = W.resolveClaudeLaunch(env, { platform: 'linux' });
      deepStrictEqual([l.ok, l.command, l.argsPrefix, l.source], [true, 'claude', [], 'bare']);
    }
  });

  it('takes CLAUDE_BIN, and AUTOPILOT_CLAUDE_BIN before it', (t) => {
    const dir = tmpDir(t, 'autopilot-claude-launch-');
    const own = executable(dir, 'autopilot-claude');
    const shared = executable(dir, 'shared-claude');
    const viaShared = W.resolveClaudeLaunch({ CLAUDE_BIN: shared }, { platform: 'linux' });
    deepStrictEqual([viaShared.command, viaShared.variable], [shared, 'CLAUDE_BIN']);
    const viaOwn = W.resolveClaudeLaunch({ CLAUDE_BIN: shared, AUTOPILOT_CLAUDE_BIN: own }, { platform: 'linux' });
    deepStrictEqual([viaOwn.command, viaOwn.source, viaOwn.variable], [own, 'override', 'AUTOPILOT_CLAUDE_BIN']);
  });

  it('a name with no path is looked up on PATH and made absolute, so the worker runs what the preflight found', (t) => {
    const dir = tmpDir(t, 'autopilot-claude-launch-');
    const found = executable(dir, 'claude-nightly');
    const l = W.resolveClaudeLaunch({ AUTOPILOT_CLAUDE_BIN: 'claude-nightly', PATH: dir }, { platform: 'linux', cwd: '/' });
    strictEqual(l.command, found);
  });

  it('an AUTOPILOT_CLAUDE_BIN that names nothing is an error naming it, never a fallback to CLAUDE_BIN', (t) => {
    const dir = tmpDir(t, 'autopilot-claude-launch-');
    const missing = join(dir, 'gone');
    const l = W.resolveClaudeLaunch({ AUTOPILOT_CLAUDE_BIN: missing, CLAUDE_BIN: executable(dir, 'claude') }, { platform: 'linux' });
    strictEqual(l.ok, false);
    strictEqual(l.variable, 'AUTOPILOT_CLAUDE_BIN');
    ok(l.reason.includes(`AUTOPILOT_CLAUDE_BIN=${missing} names no file`), l.reason);
    ok(!/(^|[^_])CLAUDE_BIN/.test(l.reason), `the reason names only the variable that was set: ${l.reason}`);
  });

  it('renames the variable only where the resolver names it, never inside the path', (t) => {
    const dir = tmpDir(t, 'autopilot-claude-launch-');
    const missing = join(dir, 'x; set CLAUDE_BIN to', 'CLAUDE_BIN', 'claude');
    const l = W.resolveClaudeLaunch({ AUTOPILOT_CLAUDE_BIN: missing }, { platform: 'linux' });
    ok(l.reason.includes(`AUTOPILOT_CLAUDE_BIN=${missing} names no file; set AUTOPILOT_CLAUDE_BIN to`), l.reason);
  });

  it('names AUTOPILOT_CLAUDE_BIN when the resolver labels the resolved path, not the value typed', (t) => {
    const dir = tmpDir(t, 'autopilot-claude-launch-');
    writeFileSync(join(dir, 'claude'), '');
    chmodSync(join(dir, 'claude'), 0o644);
    const l = W.resolveClaudeLaunch({ AUTOPILOT_CLAUDE_BIN: './claude' }, { platform: 'linux', cwd: dir });
    strictEqual(l.ok, false);
    ok(l.reason.startsWith(`peer CLI "claude": AUTOPILOT_CLAUDE_BIN=${join(dir, 'claude')} is not executable; set AUTOPILOT_CLAUDE_BIN to`), l.reason);
  });

  it('on Windows, runs the npm claude.cmd shim\'s target with node, the shim itself never', () => {
    const target = 'node_modules\\@anthropic-ai\\claude-code\\cli.js';
    const layout = CMD_SHIM_LAYOUTS.find((x) => x.version === '9.0.2' && x.program === 'node');
    const entries = {
      'C:\\npm\\claude.cmd': { type: 'file', content: layout.lines(target).join('\r\n') },
      [`C:\\npm\\${target}`]: { type: 'file', content: '' },
    };
    const fs = {
      X_OK: 1,
      statSync: (p) => { if (!entries[p]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { isFile: () => true }; },
      accessSync: () => {},
      readFileSync: (p) => entries[p].content,
    };
    const l = W.resolveClaudeLaunch({ Path: 'C:\\npm' }, { platform: 'win32', cwd: 'C:\\work', execPath: 'C:\\node\\node.exe', fs });
    deepStrictEqual([l.command, l.argsPrefix, l.shim], ['C:\\node\\node.exe', [`C:\\npm\\${target}`], 'C:\\npm\\claude.cmd']);
  });
});

describe('the preflight probes through the launch it hands every worker (C180)', () => {
  const launch = { ok: true, command: '/opt/node', argsPrefix: ['/opt/claude/cli.js'], source: 'override', shim: null, variable: 'CLAUDE_BIN' };
  const help = REQUIRED_CLAUDE_FLAGS.join('\n');

  it('runs --version and --help as the launch, prefix first, and returns that launch', () => {
    const calls = [];
    const spawn = (cmd, args) => {
      calls.push([cmd, ...args]);
      return args.at(-1) === '--version' ? { status: 0, stdout: '2.1.300 (Claude Code)\n' } : { status: 0, stdout: help };
    };
    const r = checkClaudeCli({ env: {}, resolve: () => launch, spawn });
    deepStrictEqual(calls, [['/opt/node', '/opt/claude/cli.js', '--version'], ['/opt/node', '/opt/claude/cli.js', '--help']]);
    deepStrictEqual(r.problems, []);
    strictEqual(r.launch, launch, 'the launch handed on is the one probed');
    strictEqual(r.claude, '2.1.300 (Claude Code)');
  });

  it('a CLI that cannot be resolved refuses the start naming the variable, and starts nothing', () => {
    let spawned = 0;
    const r = checkClaudeCli({
      env: {},
      resolve: () => ({ ok: false, variable: 'AUTOPILOT_CLAUDE_BIN', reason: 'peer CLI "claude": AUTOPILOT_CLAUDE_BIN=/x names no file' }),
      spawn: () => { spawned += 1; return { status: 0 }; },
    });
    strictEqual(spawned, 0);
    strictEqual(r.launch, null);
    deepStrictEqual(r.problems, ['the Claude Code CLI cannot be started: peer CLI "claude": AUTOPILOT_CLAUDE_BIN=/x names no file']);
  });
});

describe('a launch whose target is gone by the step fails the step, with its reason (C180)', () => {
  it('launchGone names the missing file and the variable; a bare name is spawn\'s to find', (t) => {
    const dir = tmpDir(t, 'autopilot-claude-launch-');
    const script = join(dir, 'cli.js');
    writeFileSync(script, '');
    const launch = { ok: true, command: process.execPath, argsPrefix: [script], source: 'override', shim: null, variable: 'AUTOPILOT_CLAUDE_BIN' };
    strictEqual(W.launchGone(launch), null);
    rmSync(script);
    const why = W.launchGone(launch);
    ok(why.includes(`${script} no longer exists`), why);
    ok(why.includes('set AUTOPILOT_CLAUDE_BIN'), why);
    strictEqual(W.launchGone({ ok: true, command: 'claude', argsPrefix: [], source: 'bare', variable: 'CLAUDE_BIN' }), null);
  });

  it('startWorker spawns nothing for it and reports a spawn error carrying the reason', async (t) => {
    const dir = tmpDir(t, 'autopilot-claude-launch-');
    const script = join(dir, 'cli.js');
    writeFileSync(script, '');
    const claudeLaunch = { ok: true, command: process.execPath, argsPrefix: [script], source: 'override', shim: null, variable: 'CLAUDE_BIN' };
    rmSync(script);
    const handle = W.startWorker({
      cwd: dir, prompt: '/engineer:critique', stepKind: 'verb', runId: 'autopilot-20261121T000000Z-000001', seq: 1, roots: ROOTS,
      stepBudgetUsd: 1, stepTimeoutSec: 30, model: null, effort: null, rawPath: join(dir, 'worker-1.jsonl'),
      // A worker that resolved again would find this override, which names
      // nothing, and never a real claude on PATH.
      env: { ...process.env, AUTOPILOT_CLAUDE_BIN: join(dir, 'no-claude') }, claudeLaunch,
    });
    strictEqual(handle.pid, null);
    handle.begin();
    const w = await handle.done;
    ok(w.spawnError.includes(`${script} no longer exists`), w.spawnError);
    deepStrictEqual([w.lastResult, w.costUsd, w.groupTeardown, w.sessionId], [null, null, 'empty', null], 'no process, no session to offer for resume');
  });

  it('startWorker spawns the launch it is handed, prefix first, in place of any later resolution', async (t) => {
    const dir = tmpDir(t, 'autopilot-claude-launch-');
    const log = join(dir, 'claude.log');
    const handle = W.startWorker({
      cwd: dir, prompt: '/engineer:critique', stepKind: 'verb', runId: 'autopilot-20261121T000000Z-000001', seq: 1, roots: ROOTS,
      stepBudgetUsd: 1, stepTimeoutSec: 30, model: null, effort: null, rawPath: join(dir, 'worker-1.jsonl'),
      env: { ...process.env, AUTOPILOT_CLAUDE_BIN: join(dir, 'no-claude'), FAKE_CLAUDE_MODE: 'simple', FAKE_CLAUDE_LOG: log },
      claudeLaunch: { ok: true, command: process.execPath, argsPrefix: [FAKE], source: 'path', shim: null, variable: 'CLAUDE_BIN' },
    });
    handle.begin();
    const w = await handle.done;
    strictEqual(w.spawnError, null);
    ok(w.lastResult, 'the fake ran through the prefix and reported');
    ok(existsSync(log), 'the fake logged its start');
  });
});
