// The scope of a mutation-harness test launch on its heavy-work ownership entry
// (ADR-0023, amendments of 2026-11-22 and 2026-11-24, the mutation harness;
// C154): plugins/orchestrator/scripts/lib/heavy-scope.mjs, and what
// lib/heavy-lock.mjs's readers do with it. Small: the scopes are fakes, the
// entries files in a temporary directory, and no scope is ever made or read.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tmpDir } from '../_tmp.mjs';
import {
  HeavyLockClosedError, closeOwnership, ownershipGroups, registerGroup,
} from '../../plugins/orchestrator/scripts/lib/heavy-lock.mjs';
import { entryScope, harnessOwner, heldText, scopeCollector } from '../../plugins/orchestrator/scripts/lib/heavy-scope.mjs';
import { abandonedRecord, noScopeRecord, scopedRecord } from '../../plugins/orchestrator/scripts/lib/scope-launch.mjs';

const BOOT = '0123abcd-0000-4000-8000-00000000beef';
const CLOCK = `${BOOT}/-/pid:[4026531836]`;
// A pid no process has: its group reads gone.
const DEAD = 4194000;

function identity({ token, entry, pgid = DEAD, unit = `agentic-launch-harness-1-${randomUUID().slice(0, 8)}.scope`, supervisorPid = 4193999 }) {
  return {
    owner: harnessOwner(token, entry),
    unit,
    invocation_id: 'a'.repeat(32),
    cgroup_path: `/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}`,
    cgroup_id: '4242',
    boot_id: BOOT,
    gate: { pid: pgid, starttime: '100', clock: CLOCK },
    supervisor: { pid: supervisorPid, fingerprint: { kind: 'linux_proc_starttime', starttime: '50' }, clock: CLOCK, boot_id: BOOT },
    has_snapshot: false,
    association: null,
  };
}

// An ownership of a fresh token, open, under a lock path in a temp dir.
function ownership(t) {
  const path = join(tmpDir(t, 'heavy-scope-'), 'mutation-harness.lock');
  const token = randomUUID();
  mkdirSync(join(`${path}.groups`, token), { recursive: true });
  return { path, token, chain: [token] };
}

const entryFile = (o, name) => {
  for (const d of readdirSync(`${o.path}.groups`)) {
    try {
      return JSON.parse(readFileSync(join(`${o.path}.groups`, d, name), 'utf8'));
    } catch { /* not in this one */ }
  }
  return null;
};

// A collector whose scopes are fakes: `alive` names supervisors not proven
// gone, `readings` what each unit reads, `killed` the units killed, in order.
function fakeCollector({ alive = new Set(), readings = {}, kills = {} } = {}) {
  const log = [];
  const collector = scopeCollector({
    proveGone: (s) => ({ gone: !alive.has(s.pid) }),
    killScope: (id) => { log.push(`kill ${id.unit}`); return kills[id.unit] ?? { state: 'written' }; },
    readScope: (id) => { log.push(`read ${id.unit}`); return readings[id.unit] ?? { state: 'unproven' }; },
  });
  return { collector, log };
}

describe('what an entry\'s scope grants', () => {
  const token = randomUUID();
  const name = `${DEAD}-${randomUUID()}.json`;
  it('a whole identity bound to this token, entry and gate is held', () => {
    const id = identity({ token, entry: name });
    deepStrictEqual(entryScope({ pgid: DEAD, scope: scopedRecord(id) }, { token, name }), { held: 'scoped', identity: id });
  });
  it('a copied identity grants nothing: another entry, another token, another gate', () => {
    for (const id of [identity({ token, entry: 'other.json' }), identity({ token: randomUUID(), entry: name }), identity({ token, entry: name, pgid: DEAD - 1 })]) {
      deepStrictEqual(entryScope({ pgid: DEAD, scope: scopedRecord(id) }, { token, name }), { held: null, state: 'unbound' });
    }
  });
  it('no scope, none made, an abandoned one and a malformed one grant nothing; an unknown version is withheld', () => {
    strictEqual(entryScope({ pgid: DEAD }, { token, name }).held, null);
    strictEqual(entryScope({ pgid: DEAD, scope: noScopeRecord('unavailable') }, { token, name }).held, null);
    strictEqual(entryScope({ pgid: DEAD, scope: abandonedRecord(identity({ token, entry: name })) }, { token, name }).held, null);
    strictEqual(entryScope({ pgid: DEAD, scope: { version: 1, state: 'scoped', identity: {} } }, { token, name }).held, null);
    deepStrictEqual(entryScope({ pgid: DEAD, scope: { version: 2, state: 'scoped' } }, { token, name }), { held: 'withheld', check: 'unknown-version' });
  });
});

describe('a collector\'s pass', () => {
  it('writes every owed kill first, then reads each ended scope once, and kills a scope once per process', () => {
    const token = randomUUID();
    const a = identity({ token, entry: 'a.json', unit: 'agentic-launch-a.scope' });
    const b = identity({ token, entry: 'b.json', unit: 'agentic-launch-b.scope' });
    const { collector, log } = fakeCollector({ readings: { 'agentic-launch-a.scope': { state: 'gone' } } });
    const out = collector.pass([{ identity: a, groupRunning: false }, { identity: b, groupRunning: false }]);
    deepStrictEqual(log, ['kill agentic-launch-a.scope', 'kill agentic-launch-b.scope', 'read agentic-launch-a.scope', 'read agentic-launch-b.scope']);
    deepStrictEqual(out, [{ state: 'gone' }, { state: 'unproven' }]);
    log.length = 0;
    collector.pass([{ identity: b, groupRunning: false }]);
    deepStrictEqual(log, ['read agentic-launch-b.scope'], 'the kill is not written again; the scope is read again');
  });

  it('writes no kill while the supervisor lives, and reads every scope once, its group running or not', () => {
    const token = randomUUID();
    const a = identity({ token, entry: 'a.json', unit: 'agentic-launch-a.scope', supervisorPid: 77 });
    const b = identity({ token, entry: 'b.json', unit: 'agentic-launch-b.scope' });
    const { collector, log } = fakeCollector({ alive: new Set([77]) });
    const out = collector.pass([{ identity: a, groupRunning: false }, { identity: b, groupRunning: true }]);
    deepStrictEqual(log, ['kill agentic-launch-b.scope', 'read agentic-launch-a.scope', 'read agentic-launch-b.scope'], 'b is killed though its group runs; a only read');
    deepStrictEqual(out, [{ state: 'unproven' }, { state: 'unproven' }]);
  });

  it('tries a withheld kill again at the next pass, and reports a refused kill over an unproven reading', () => {
    const token = randomUUID();
    const a = identity({ token, entry: 'a.json', unit: 'agentic-launch-a.scope' });
    const b = identity({ token, entry: 'b.json', unit: 'agentic-launch-b.scope' });
    const { collector, log } = fakeCollector({
      kills: { 'agentic-launch-a.scope': { state: 'withheld', check: 'check-timeout' }, 'agentic-launch-b.scope': { state: 'refused', check: 'EACCES' } },
    });
    deepStrictEqual(collector.pass([{ identity: a, groupRunning: false }, { identity: b, groupRunning: false }]),
      [{ state: 'withheld', check: 'check-timeout' }, { state: 'refused', check: 'EACCES' }]);
    log.length = 0;
    collector.pass([{ identity: a, groupRunning: false }, { identity: b, groupRunning: false }]);
    deepStrictEqual(log, ['kill agentic-launch-a.scope', 'read agentic-launch-a.scope', 'read agentic-launch-b.scope']);
  });
});

describe('the lock\'s readers and a harness entry', () => {
  it('a dead group whose scope is not read gone keeps the entry running, naming the unit; gone lets it go', (t) => {
    const o = ownership(t);
    const entry = registerGroup(o, DEAD, { leaderStarted: null });
    const id = identity({ token: o.token, entry: entry.name });
    entry.recordScope(scopedRecord(id));
    const kept = fakeCollector();
    const held = ownershipGroups(o.path, o.token, { scopes: kept.collector });
    deepStrictEqual(held, [{ pgid: DEAD, name: entry.name, via: o.chain, scope: { state: 'unproven', unit: id.unit } }]);
    ok(heldText(held[0]).includes(`systemctl --user stop ${id.unit}`), heldText(held[0]));
    const gone = fakeCollector({ readings: { [id.unit]: { state: 'gone' } } });
    deepStrictEqual(ownershipGroups(o.path, o.token, { scopes: gone.collector }), []);
  });

  it('an entry read with no scope is read again once its group reads ended: a scope recorded meanwhile holds it', (t) => {
    const o = ownership(t);
    const entry = registerGroup(o, DEAD, { leaderStarted: null });
    const id = identity({ token: o.token, entry: entry.name });
    // The harness records the scope after the reader read the entry, and its
    // group has ended by the time the reader probes it.
    const sys = { kill: (pid, signal) => {
      if (pid === -DEAD && signal === 0 && entryFile(o, entry.name).scope === undefined) entry.recordScope(scopedRecord(id));
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    } };
    const held = ownershipGroups(o.path, o.token, { sys, scopes: fakeCollector().collector });
    deepStrictEqual(held.map((g) => g.scope?.unit), [id.unit]);
  });

  it('a close that renames the entry\'s directory between the read again\'s listing and its read is searched again, never read absent', (t) => {
    const o = ownership(t);
    const entry = registerGroup(o, DEAD, { leaderStarted: null });
    const id = identity({ token: o.token, entry: entry.name });
    const sys = { kill: (pid, signal) => {
      if (pid === -DEAD && signal === 0 && entryFile(o, entry.name).scope === undefined) entry.recordScope(scopedRecord(id));
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    } };
    // The listing of the read again names the open directory; the close
    // renames it before the entry is read there.
    let closes = 1;
    const found = () => { if (closes-- > 0) closeOwnership(o.path, o.token); };
    const held = ownershipGroups(o.path, o.token, { sys, found, scopes: fakeCollector().collector });
    strictEqual(closes, -1, 'the search ran again after the close');
    deepStrictEqual(held.map((g) => g.scope?.unit), [id.unit], 'the scope recorded meanwhile holds it');
  });

  it('an entry of no scope, or one whose identity is copied from another entry, is judged by its group alone', (t) => {
    const o = ownership(t);
    registerGroup(o, DEAD, { leaderStarted: null });
    const copied = registerGroup(o, DEAD, { leaderStarted: null });
    copied.recordScope(scopedRecord(identity({ token: o.token, entry: 'another.json' })));
    const { collector, log } = fakeCollector();
    deepStrictEqual(ownershipGroups(o.path, o.token, { scopes: collector }), []);
    deepStrictEqual(log, [], 'nothing is killed or read for them');
  });

  it('an entry whose scope is of an unknown version counts as running; a collector that throws leaves a scoped entry running', (t) => {
    const o = ownership(t);
    registerGroup(o, DEAD, { leaderStarted: null, scope: { version: 9 } });
    strictEqual(ownershipGroups(o.path, o.token, { scopes: fakeCollector().collector })[0].scope.state, 'withheld');
    const p = ownership(t);
    const entry = registerGroup(p, DEAD, { leaderStarted: null });
    entry.recordScope(scopedRecord(identity({ token: p.token, entry: entry.name })));
    const broken = { pass() { throw new Error('boom'); } };
    strictEqual(ownershipGroups(p.path, p.token, { scopes: broken })[0].scope.state, 'withheld');
  });

  it('an entry closed with its ownership (a release, a reaper) still counts while its scope is not read gone', (t) => {
    const o = ownership(t);
    const entry = registerGroup(o, DEAD, { leaderStarted: null });
    entry.recordScope(scopedRecord(identity({ token: o.token, entry: entry.name })));
    closeOwnership(o.path, o.token);
    const left = ownershipGroups(o.path, o.token, { scopes: fakeCollector().collector });
    strictEqual(left.length, 1, 'found in the closed directory');
  });
});

describe('the entry\'s records', () => {
  it('keeps the copy and the scope it was registered with, and writes the scope and its teardown wherever the entry lies', (t) => {
    const o = ownership(t);
    const copy = { path: '/tmp/copy', dev: '66306', ino: '18446744073709551615' };
    const entry = registerGroup(o, DEAD, { leaderStarted: null, copy, scope: noScopeRecord('inside-launcher', 'agentic-launch-x.scope') });
    deepStrictEqual(entryFile(o, entry.name).copy, copy, 'a 64-bit inode survives as a string');
    strictEqual(entryFile(o, entry.name).scope.reason, 'inside-launcher');
    const id = identity({ token: o.token, entry: entry.name });
    closeOwnership(o.path, o.token);
    entry.recordScope(scopedRecord(id));
    entry.recordTeardown({ state: 'gone', at: '2026-11-26T00:00:00Z' });
    deepStrictEqual(entryFile(o, entry.name).scope, { ...scopedRecord(id), teardown: { state: 'gone', at: '2026-11-26T00:00:00Z' } });
    strictEqual(entryFile(o, entry.name).copy.ino, copy.ino, 'a rewrite keeps the other fields');
    const dirs = readdirSync(`${o.path}.groups`);
    deepStrictEqual(readdirSync(join(`${o.path}.groups`, dirs[0])), [entry.name], 'no temporary file is left');
  });

  it('never writes a scope over an abandoned mark, and never writes an entry that is gone', (t) => {
    const o = ownership(t);
    const entry = registerGroup(o, DEAD, { leaderStarted: null });
    const id = identity({ token: o.token, entry: entry.name });
    entry.recordScope(abandonedRecord(id));
    throws(() => entry.recordScope(scopedRecord(id)), /marked abandoned/);
    strictEqual(entryFile(o, entry.name).scope.state, 'abandoned');
    entry.recordTeardown({ state: 'gone', at: '2026-11-26T00:00:00Z' });
    strictEqual(entryFile(o, entry.name).scope.teardown, undefined, 'a teardown goes only into a scoped entry');
    entry.unregister();
    throws(() => entry.recordScope(scopedRecord(id)), HeavyLockClosedError);
    strictEqual(entryFile(o, entry.name), null, 'not made again');
  });

  it('a directory retired while the entry is rewritten is never made again', (t) => {
    const o = ownership(t);
    const entry = registerGroup(o, DEAD, { leaderStarted: null });
    const retired = join(tmpDir(t, 'retired-'), 'gone');
    renameSync(join(`${o.path}.groups`, o.token), retired);
    throws(() => entry.recordScope(noScopeRecord('unavailable')), HeavyLockClosedError);
    deepStrictEqual(readdirSync(`${o.path}.groups`), [], 'no ownership directory is made again');
    writeFileSync(join(retired, 'unrelated'), '');
  });
});
