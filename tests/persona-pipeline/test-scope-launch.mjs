// C181 (ADR-0023 §6, amendments of 2026-11-22 and 2026-11-24) — a launch in
// a scope of its own: the records a launcher writes, where it already runs
// inside another launcher's scope (two path readings and the manager's unit,
// judged in process), and the gate's handshake on this machine's systemd user
// manager: the gate alone in a new scope, the identity recorded before the
// word, the scope closed, then the word, on which the companion runs in the
// gate's place. Its kill ends a descendant in a session of its own while a
// user process outside the run survives. A failure or a cancellation before
// the word runs nothing. The live rows skip, with the reason, where no scope
// can be made.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT } from './_personas.mjs';
import { tmpDir } from '../_tmp.mjs';

const LIB = join(REPO_ROOT, 'persona-pipeline/files/scripts/lib');
const L = await import(pathToFileURL(join(LIB, 'scope-launch.mjs')).href);
const S = await import(pathToFileURL(join(LIB, 'scope.mjs')).href);
const R = await import(pathToFileURL(join(LIB, 'scope-reader.mjs')).href);

const UID = 1000;
const MANAGER = `/user.slice/user-${UID}.slice/user@${UID}.service`;

function busPath(unit) {
  return `o "/org/freedesktop/systemd1/unit/${unit.replace(/[^A-Za-z0-9]/g, (c) => `_${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}"\n`;
}

describe('the records a launcher writes', () => {
  it('a unit name is used once and reads as a launcher scope', () => {
    const a = L.scopeUnitName('plan-verify-20261124T114936Z-701ae6');
    const b = L.scopeUnitName('plan-verify-20261124T114936Z-701ae6');
    ok(a !== b);
    ok(a.startsWith(`${S.SCOPE_UNIT_PREFIX}plan-verify-20261124T114936Z-701ae6-`) && a.endsWith('.scope'), a);
    deepStrictEqual(S.scopeRecordState({ scope: L.noScopeRecord('inside-launcher', a) }), { state: 'none', reason: 'inside-launcher', enclosing_unit: a });
  });

  it('no scope, and an abandoned one, parse as their states', () => {
    deepStrictEqual(S.scopeRecordState({ scope: L.noScopeRecord('unavailable') }), { state: 'none', reason: 'unavailable', enclosing_unit: null });
    strictEqual(S.scopeRecordState({ scope: L.abandonedRecord({}) }).state, 'malformed');
  });
});

describe('a launcher inside another launcher\'s scope (placementFrom)', () => {
  const launcherUnit = `${S.SCOPE_UNIT_PREFIX}step-7-abcd.scope`;
  const rows = [
    ['a launcher scope in both readings is inside it',
      { before: `${MANAGER}/app.slice/${launcherUnit}`, answer: { status: 0, stdout: busPath(launcherUnit) } },
      { inside: true, enclosingUnit: launcherUnit }],
    ['a login session with the manager naming no unit is not inside one',
      { before: `/user.slice/user-${UID}.slice/session-3.scope`, answer: { status: 1, stdout: '', stderr: 'Call failed: PID 9 does not belong to any loaded unit.\n' } },
      { inside: false }],
    ['a unit of the manager that is no launcher scope, named by the manager, is not inside one',
      { before: `${MANAGER}/app.slice/tmux-spawn-1.scope`, answer: { status: 0, stdout: busPath('tmux-spawn-1.scope') } },
      { inside: false }],
    ['a launcher scope the manager does not name withholds',
      { before: `${MANAGER}/app.slice/${launcherUnit}`, answer: { status: 0, stdout: busPath('other.scope') } },
      { withheld: 'placement' }],
    ['the manager naming no unit for a path below it withholds',
      { before: `${MANAGER}/app.slice/${launcherUnit}`, answer: { status: 1, stdout: '', stderr: 'Call failed: PID 9 does not belong to any loaded unit.\n' } },
      { withheld: 'placement' }],
    ['a session path with any other failure of the manager withholds',
      { before: `/user.slice/user-${UID}.slice/session-3.scope`, answer: { status: 1, stdout: '', stderr: 'Failed to connect to bus\n' } },
      { withheld: 'placement' }],
    ['a session path with the manager naming a unit withholds',
      { before: `/user.slice/user-${UID}.slice/session-3.scope`, answer: { status: 0, stdout: busPath('session-3.scope') } },
      { withheld: 'placement' }],
    ['a process in a cgroup a unit made below itself is in that unit',
      { before: `${MANAGER}/app.slice/example.service/worker`, answer: { status: 0, stdout: busPath('example.service') } },
      { inside: false }],
    ['a unit the manager names that holds no component of the path withholds',
      { before: `${MANAGER}/app.slice/example.service/worker`, answer: { status: 0, stdout: busPath('other.service') } },
      { withheld: 'placement' }],
    ['a unit named only above the manager\'s own cgroup withholds',
      { before: `${MANAGER}/app.slice/x.service`, answer: { status: 0, stdout: busPath(`user@${UID}.service`) } },
      { withheld: 'placement' }],
  ];
  for (const [name, { before, answer }, want] of rows) {
    it(name, () => {
      deepStrictEqual(L.placementFrom({ before, after: before, answer, uid: UID }), want);
    });
  }

  it('two path readings that differ, or one that failed, withhold', () => {
    const answer = { status: 0, stdout: busPath(launcherUnit) };
    const path = `${MANAGER}/app.slice/${launcherUnit}`;
    deepStrictEqual(L.placementFrom({ before: path, after: `${MANAGER}/app.slice/x.scope`, answer, uid: UID }), { withheld: 'placement-path' });
    deepStrictEqual(L.placementFrom({ before: null, after: path, answer, uid: UID }), { withheld: 'placement-path' });
  });
});

// Whether this machine can make a scope: the reader's checks and systemd-run.
const AVAILABLE = (() => {
  if (process.platform !== 'linux') return 'Linux only';
  const a = L.scopeAvailability();
  if (!a.available) return `no scope can be made here (${a.check})`;
  if (spawnSync('systemd-run', ['--version'], { stdio: 'ignore' }).status !== 0) return 'no systemd-run';
  return null;
})();

const owner = (runId) => ({ kind: 'peer-run', run_id: runId });

function exitOf(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolveP) => {
    child.once('exit', (code, signal) => resolveP({ code, signal }));
  });
}

function firstLine(stream) {
  return new Promise((resolveP) => {
    let text = '';
    stream.on('data', (chunk) => {
      text += String(chunk);
      if (text.includes('\n')) resolveP(text.split('\n')[0]);
    });
  });
}

async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

describe('the gate\'s handshake on this machine', { skip: AVAILABLE ?? false }, () => {
  it('records the identity before the word, closes the scope, and the kill ends a descendant in a session of its own', async (t) => {
    const runId = `test-launch-${process.pid}-a`;
    const unit = L.scopeUnitName(runId);
    // Outside the run: a process of the user the kill must not reach.
    const outsider = spawn('sleep', ['300'], { stdio: 'ignore', detached: true });
    t.after(() => {
      try {
        process.kill(outsider.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    });
    const child = L.spawnGated({
      unit,
      command: '/bin/sh',
      args: ['-c', 'setsid sleep 300 </dev/null >/dev/null 2>&1 & echo "$$ $!"; sleep 300'],
      options: { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    });
    const line = firstLine(child.stdout);
    let planted = null;
    // Registered before the first await: the companion's group, and the
    // descendant that left it, end whatever the rows below find.
    t.after(() => {
      for (const target of [-child.pid, planted]) {
        try {
          if (target) process.kill(target, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    });
    const records = [];
    let wordGivenAfterRecord = false;
    const result = await L.gateHandshake(child, {
      unit,
      owner: owner(runId),
      hasSnapshot: false,
      record: async (identity) => {
        records.push(structuredClone(identity));
        wordGivenAfterRecord = true;
      },
    });
    strictEqual(result.launched, true, JSON.stringify(result));
    ok(wordGivenAfterRecord);
    strictEqual(records.length, 1);
    deepStrictEqual(records[0], result.identity);
    deepStrictEqual(S.scopeIdentityProblems(result.identity), []);
    strictEqual(result.identity.unit, unit);
    strictEqual(result.identity.gate.pid, child.pid);
    deepStrictEqual(S.scopeRecordState({ scope: L.scopedRecord(result.identity) }).state, 'scoped');
    // The companion runs in the gate's place: same pid.
    const [shellPid, descendant] = (await line).split(' ').map(Number);
    planted = descendant;
    strictEqual(shellPid, child.pid);
    ok(alive(descendant));
    // The descendant left the companion's group and session.
    ok(spawnSync('ps', ['-o', 'sid=', '-p', String(descendant)], { encoding: 'utf8' }).stdout.trim() !== String(child.pid));
    // The kill, under every check of the reader.
    const ender = R.createScopeEnder();
    strictEqual(ender.kill(result.identity).state, 'written');
    ok(await until(() => !alive(descendant)), 'the descendant in its own session is gone');
    const reading = await until(() => {
      const r = R.readScopeOnce(result.identity);
      return r.state === 'gone' || r.state === 'emptied' ? r : null;
    });
    ok(reading, 'the scope reads gone or emptied after the kill');
    await exitOf(child);
    ok(alive(outsider.pid), 'a user process outside the run survives');
  });

  it('a record that fails before the word runs nothing and says it was called', async (t) => {
    const runId = `test-launch-${process.pid}-b`;
    const unit = L.scopeUnitName(runId);
    const dir = tmpDir(t, 'scope-launch-');
    const marker = join(dir, 'ran');
    const child = L.spawnGated({ unit, command: '/bin/sh', args: ['-c', `: > '${marker}'`], options: { stdio: ['ignore', 'ignore', 'ignore'], detached: true } });
    const result = await L.gateHandshake(child, {
      unit,
      owner: owner(runId),
      hasSnapshot: false,
      record: async () => {
        throw new Error('ledger write failed');
      },
    });
    deepStrictEqual({ launched: result.launched, check: result.check, recorded: result.recorded }, { launched: false, check: 'record', recorded: true });
    await exitOf(child);
    strictEqual(existsSync(marker), false);
  });

  it('a cancellation before the word runs nothing and records nothing', async (t) => {
    const runId = `test-launch-${process.pid}-c`;
    const unit = L.scopeUnitName(runId);
    const dir = tmpDir(t, 'scope-launch-');
    const marker = join(dir, 'ran');
    const child = L.spawnGated({ unit, command: '/bin/sh', args: ['-c', `: > '${marker}'`], options: { stdio: ['ignore', 'ignore', 'ignore'], detached: true } });
    let called = false;
    const result = await L.gateHandshake(child, {
      unit,
      owner: owner(runId),
      hasSnapshot: false,
      signal: AbortSignal.abort(),
      record: async () => {
        called = true;
      },
    });
    deepStrictEqual({ launched: result.launched, check: result.check, recorded: result.recorded, called }, { launched: false, check: 'cancelled', recorded: false, called: false });
    await exitOf(child);
    strictEqual(existsSync(marker), false);
  });

  it('a unit name the manager already holds refuses the create, and the gate never runs', async (t) => {
    const runId = `test-launch-${process.pid}-d`;
    const unit = L.scopeUnitName(runId);
    const holder = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, '--', 'sleep', '300'], { stdio: 'ignore', detached: true });
    t.after(() => {
      try {
        process.kill(-holder.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    });
    ok(await until(() => spawnSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8' }).stdout.trim() === 'active'));
    const dir = tmpDir(t, 'scope-launch-');
    const marker = join(dir, 'ran');
    const child = L.spawnGated({ unit, command: '/bin/sh', args: ['-c', `: > '${marker}'`], options: { stdio: ['ignore', 'ignore', 'ignore'], detached: true } });
    const result = await L.gateHandshake(child, { unit, owner: owner(runId), hasSnapshot: false, record: async () => {} });
    strictEqual(result.launched, false);
    strictEqual(result.recorded, false);
    await exitOf(child);
    strictEqual(existsSync(marker), false);
  });
});
