// The heavy-work lock's protocol (ADR-0068 Decision 6):
// plugins/orchestrator/scripts/lib/heavy-lock.mjs. The record, its stale
// judgment with the holder's ownership, the ownership registry and its close,
// the proof, release and cancellation. The harness's own lock tests
// (tests/scripts/test-mutation-harness.mjs) still hold the parts it had.

import { afterEach, describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

import {
  HeavyLockBusyError, HeavyLockClosedError, HeavyLockError, PROOF_ENV, VIA_ENV,
  acquire, closeOwnership, collectOwnerships, groupState, mintProof, orphanGroups, ownershipGroups, processInfo,
  reapStale, registerGroup, signalGroup,
} from '../../plugins/orchestrator/scripts/lib/heavy-lock.mjs';
import {
  BOUNDED, deadPid, groupAlive, lockOf, makeRepo, sleep, tracker, until,
} from './_heavy-lock-fixtures.mjs';

// A start this platform's reader spells, of a process that started long ago.
const ANOTHER_START = process.platform === 'linux' ? 'boot:0' : 'utc:Thu Jan  1 00:00:00 1970';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

let t;
afterEach(() => t?.cleanUp());

function setUp() {
  t = tracker();
  const root = t.dir(makeRepo());
  const path = t.lock(lockOf(root));
  return { root, path };
}

// A process leading a group of its own, which runs until killed.
function sleeper() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  t.group(child.pid);
  return child.pid;
}

// The record of a holder that is not this process, placed as a holder would.
function plantHolder(path, fields = {}) {
  const record = {
    pid: deadPid(), host: hostname(), started: null, token: randomUUID(),
    started_at: '2026-10-20T00:00:00.000Z', worktree: '/elsewhere', spec: 'planted.mjs', purpose: 'planted.mjs',
    ...fields,
  };
  writeFileSync(path, `${JSON.stringify(record)}\n`);
  return record;
}

// An ownership directory for `token`, as its holder opens it.
function openFor(path, token) {
  mkdirSync(join(`${path}.groups`, token), { recursive: true });
  return { path, token, chain: [token] };
}

const quiet = () => {};

describe('stale judgment', () => {
  it('reaps a record that does not parse, and never judges a holder on another host', BOUNDED, async () => {
    const { root, path } = setUp();
    writeFileSync(path, 'not a record');
    const said = [];
    const lock = await acquire(root, { log: (l) => said.push(l), pollMs: 20 });
    ok(said.some((l) => l.includes('removed a stale run lock (unreadable)')), said.join('\n'));
    lock.release();
    ok(!existsSync(path));

    const elsewhere = plantHolder(path, { host: 'elsewhere.invalid' });
    const raw = readFileSync(path, 'utf8');
    const waits = [];
    await rejects(acquire(root, { log: (l) => waits.push(l), pollMs: 20, signal: AbortSignal.timeout(400) }), { name: 'TimeoutError' });
    strictEqual(readFileSync(path, 'utf8'), raw, `the holder on another host keeps its lock (${elsewhere.pid})`);
    ok(waits.some((l) => l.includes('on elsewhere.invalid')), waits.join('\n'));
  });

  it('keeps a dead holder\'s lock while a group of its ownership runs, and takes it once the group ends', BOUNDED, async () => {
    const { root, path } = setUp();
    const holder = plantHolder(path);
    const pgid = sleeper();
    registerGroup(openFor(path, holder.token), pgid);
    const said = [];
    let taken = null;
    const waiting = acquire(root, { log: (l) => said.push(l), pollMs: 20 }).then((lock) => { taken = lock; return lock; });
    ok(await until(() => said.some((l) => l.includes(`(pid ${holder.pid} exited; its group ${pgid} still runs`))), said.join('\n'));
    await sleep(200);
    strictEqual(taken, null, 'nothing takes the lock while the group runs');
    strictEqual(JSON.parse(readFileSync(path, 'utf8')).token, holder.token);
    process.kill(-pgid, 'SIGKILL');
    const lock = await waiting;
    ok(said.some((l) => l.includes(`removed a stale run lock (pid ${holder.pid}, /elsewhere, which is not running)`)), said.join('\n'));
    deepStrictEqual(readdirSync(`${path}.groups`), [lock.token], 'the dead holder\'s ownership went with its lock');
    lock.release();
    ok(!existsSync(path) && !existsSync(`${path}.groups`));
  });

  it('a group whose leader is gone runs; a reused leader with another start is not ours; what cannot be told runs', () => {
    const err = (code) => Object.assign(new Error(code), { code });
    const sys = (group, leader, info = () => ({ zombie: false, started: 'utc:A' })) => ({
      kill: (pid) => { const e = pid < 0 ? group : leader; if (e) throw err(e); },
      info,
    });
    strictEqual(groupState(7, 'utc:A', sys('ESRCH', null)), 'gone');
    strictEqual(groupState(7, 'utc:A', sys(null, 'ESRCH')), 'running', 'a member lives after its leader exited');
    strictEqual(groupState(7, 'utc:A', sys(null, null)), 'running');
    strictEqual(groupState(7, 'utc:B', sys(null, null)), 'foreign', 'a reused live leader');
    strictEqual(groupState(7, 'utc:B', sys(null, null, () => ({ zombie: true, started: 'utc:A' }))), 'foreign', 'a reused zombie leader');
    strictEqual(groupState(7, 'utc:A', sys('EPERM', null)), 'running');
    strictEqual(groupState(7, 'utc:A', sys('EINVAL', null)), 'running', 'a probe that fails');
    strictEqual(groupState(7, 'utc:A', sys(null, 'EPERM')), 'running');
    strictEqual(groupState(7, 'utc:A', sys(null, null, () => null)), 'running', 'a start that cannot be read');
    strictEqual(groupState(7, 'boot:5', sys(null, null)), 'running', 'a start in another scheme');
    strictEqual(groupState(7, null, sys(null, null)), 'running', 'no start registered');
  });

  it('EPERM from the group probe still checks the leader: another user\'s process that took the id is not ours', () => {
    const err = (code) => Object.assign(new Error(code), { code });
    const sys = (leader, started) => ({
      kill: (pid) => { const e = pid < 0 ? 'EPERM' : leader; if (e) throw err(e); },
      info: () => (started === null ? null : { zombie: false, started }),
    });
    strictEqual(groupState(7, 'utc:A', sys('EPERM', 'utc:B')), 'foreign', 'another user\'s leader, started at another time');
    strictEqual(groupState(7, 'utc:A', sys(null, 'utc:B')), 'foreign', 'a leader that may be signalled, started at another time');
    strictEqual(groupState(7, 'utc:A', sys('EPERM', 'utc:A')), 'running', 'the registered leader');
    strictEqual(groupState(7, 'utc:A', sys('ESRCH', null)), 'running', 'its leader gone, another user\'s member may run');
    strictEqual(groupState(7, 'utc:A', sys('EPERM', null)), 'running', 'a leader whose start cannot be read (a /proc that hides it)');
  });

  it('only ESRCH ends a group: a group of zombies only runs until it is reaped', () => {
    const err = (code) => Object.assign(new Error(code), { code });
    const sys = (group, leader) => ({
      kill: (pid) => { const e = pid < 0 ? group : leader; if (e) throw err(e); },
      info: () => ({ zombie: true, started: 'utc:A' }),
    });
    strictEqual(groupState(7, 'utc:A', sys('EPERM', null)), 'running', 'macOS: the probe gives EPERM, the leader a zombie');
    strictEqual(groupState(7, 'utc:A', sys('EPERM', 'ESRCH')), 'running', 'macOS: its leader reaped, its members not');
    strictEqual(groupState(7, 'utc:A', sys(null, null)), 'running', 'Linux: the probe succeeds, the leader a zombie');
    strictEqual(groupState(7, 'utc:A', sys(null, 'ESRCH')), 'running', 'Linux: its leader reaped, its members not');
    strictEqual(groupState(7, 'utc:A', sys('ESRCH', 'ESRCH')), 'gone', 'reaped');
  });

  it('a real group whose only process is an unreaped zombie runs until it is reaped, then is gone', BOUNDED, async () => {
    t = tracker();
    // A parent that never reaps: its child leads a group of its own, and exits.
    const parent = spawn('perl', ['-e', '$| = 1; my $p = fork(); if (!$p) { setpgrp(0, 0); exit 0; } print "$p\\n"; sleep 60;'], { stdio: ['ignore', 'pipe', 'inherit'] });
    t.pid(parent.pid);
    let text = '';
    parent.stdout.on('data', (c) => { text += c; });
    ok(await until(() => /^\d+\n/.test(text)), `perl printed no pid: ${text}`);
    const pgid = Number(text.trim());
    ok(await until(() => processInfo(pgid)?.zombie === true), 'the child is a zombie');
    const started = processInfo(pgid).started;
    for (let i = 0; i < 5; i++) {
      strictEqual(groupState(pgid, started), 'running', 'a group of zombies only is not gone');
      await sleep(20);
    }
    // Its parent ends: the zombie's new parent reaps it, and the group is gone.
    parent.kill('SIGKILL');
    ok(await until(() => groupState(pgid, started) === 'gone'), 'the group has ended once reaped');
    const live = sleeper();
    strictEqual(groupState(live, processInfo(live).started), 'running', 'control: a live group runs');
  });

  it('a live group whose leader started at another time is not counted', BOUNDED, async () => {
    const { root, path } = setUp();
    const holder = plantHolder(path);
    const pgid = sleeper();
    await sleep(100);
    registerGroup(openFor(path, holder.token), pgid, { leaderStarted: ANOTHER_START });
    deepStrictEqual(ownershipGroups(path, holder.token), []);
    const lock = await acquire(root, { log: quiet, pollMs: 20, signal: AbortSignal.timeout(10_000) });
    lock.release();
    // Control: registered with its own start, it counts.
    const again = plantHolder(path);
    registerGroup(openFor(path, again.token), pgid);
    deepStrictEqual(ownershipGroups(path, again.token).map((g) => g.pgid), [pgid]);
  });
});

describe('the ownership registry', () => {
  it('a registration after the close fails; one landed just before it is judged', BOUNDED, async () => {
    const { root, path } = setUp();
    const lock = await acquire(root, { log: quiet });
    const pgid = sleeper();
    registerGroup(lock.ownership, pgid);
    closeOwnership(path, lock.token);
    deepStrictEqual(ownershipGroups(path, lock.token).map((g) => g.pgid), [pgid], 'the entry moved with its directory');
    const late = sleeper();
    throws(() => registerGroup(lock.ownership, late), HeavyLockClosedError);
    const entries = readdirSync(`${path}.groups`).flatMap((d) => readdirSync(join(`${path}.groups`, d)));
    ok(!entries.some((n) => n.startsWith(`${late}-`) && n.endsWith('.json')), `no entry for the late group: ${entries}`);
    throws(() => lock.release(), (e) => e instanceof HeavyLockBusyError && e.message.includes(String(pgid)));
    ok(existsSync(path), 'a refused release keeps the lock');
    process.kill(-pgid, 'SIGKILL');
    ok(await until(() => !groupAlive(pgid)));
    lock.release();
    ok(!existsSync(path) && !existsSync(`${path}.groups`));
  });

  it('an unregister removes its own entry only, wherever it lies, never a newer one for the same group', BOUNDED, async () => {
    const { root, path } = setUp();
    const lock = await acquire(root, { log: quiet });
    const pgid = sleeper();
    const first = registerGroup(lock.ownership, pgid);
    const second = registerGroup(lock.ownership, pgid);
    first.unregister();
    deepStrictEqual(ownershipGroups(path, lock.token).map((g) => g.name), [second.name]);
    closeOwnership(path, lock.token);
    second.unregister();
    deepStrictEqual(ownershipGroups(path, lock.token), [], 'found in the closed directory');
    lock.release();
  });

  it('a holder collects only foreign ownerships with no running group', BOUNDED, () => {
    const { path } = setUp();
    const own = randomUUID();
    const dead = randomUUID();
    const live = randomUUID();
    registerGroup(openFor(path, dead), deadPid());
    const pgid = sleeper();
    registerGroup(openFor(path, live), pgid);
    openFor(path, own);
    deepStrictEqual(collectOwnerships(path, own).map((g) => [g.token, g.pgid]), [[live, pgid]], 'the running ones are returned');
    const names = readdirSync(`${path}.groups`);
    deepStrictEqual(names.map((n) => n.slice(0, 36)).sort(), [own, live].sort());
    ok(names.includes(own) && !names.includes(live), `the live foreign ownership is kept, closed: ${names}`);
    throws(() => registerGroup({ path, token: live, chain: [live] }, pgid), HeavyLockClosedError);
    deepStrictEqual(orphanGroups(path).map((g) => g.pgid), [pgid]);
  });

  it('a process of an earlier holder that registers after the acquirer\'s last look makes it withdraw and wait', BOUNDED, async () => {
    const { root, path } = setUp();
    // An older reaper removed this holder's lock and left its ownership open.
    const orphan = randomUUID();
    const ownership = openFor(path, orphan);
    const pgid = sleeper();
    let placements = 0;
    const said = [];
    let taken = null;
    const waiting = acquire(root, {
      log: (l) => said.push(l), pollMs: 20,
      beforePlace: () => { placements += 1; if (placements === 1) registerGroup(ownership, pgid); },
    }).then((lock) => { taken = lock; return lock; });
    ok(await until(() => said.some((l) => l.includes(`waiting for process group ${pgid} of an earlier holder (token ${orphan})`))), said.join('\n'));
    await sleep(200);
    strictEqual(taken, null, 'the lock is not kept beside the late group');
    ok(!existsSync(path), 'the lock it placed was withdrawn');
    // Counted, not sampled: a lock placed and withdrawn at each poll is there
    // for an instant only.
    strictEqual(placements, 1, 'once withdrawn, it looks before placing again, and places nothing while the group runs');
    throws(() => registerGroup(ownership, sleeper()), HeavyLockClosedError, 'and the earlier ownership is closed');
    process.kill(-pgid, 'SIGKILL');
    const lock = await waiting;
    lock.release();
  });

  it('a scan that the close of its directory overtakes still finds the entry', BOUNDED, async () => {
    const { root, path } = setUp();
    const lock = await acquire(root, { log: quiet });
    const pgid = sleeper();
    registerGroup(lock.ownership, pgid);
    let first = true;
    const listed = () => { if (first) { first = false; closeOwnership(path, lock.token); } };
    deepStrictEqual(ownershipGroups(path, lock.token, { via: lock.token, listed }).map((g) => g.pgid), [pgid]);
    process.kill(-pgid, 'SIGKILL');
    ok(await until(() => !groupAlive(pgid)));
    lock.release();
  });

  it('waits for the running groups of an ownership that holds no lock, naming them', BOUNDED, async () => {
    const { root, path } = setUp();
    const orphan = randomUUID();
    const pgid = sleeper();
    registerGroup(openFor(path, orphan), pgid);
    const said = [];
    let taken = null;
    let placements = 0;
    const waiting = acquire(root, { log: (l) => said.push(l), pollMs: 20, beforePlace: () => { placements += 1; } })
      .then((lock) => { taken = lock; return lock; });
    ok(await until(() => said.some((l) => l.includes(`waiting for process group ${pgid} of an earlier holder (token ${orphan})`))), said.join('\n'));
    await sleep(200);
    strictEqual(taken, null);
    ok(!existsSync(path), 'the lock is not placed beside a running orphan');
    strictEqual(placements, 0, 'no placement is even tried while the orphan runs');
    process.kill(-pgid, 'SIGKILL');
    const lock = await waiting;
    ok(!readdirSync(`${path}.groups`).some((n) => n.startsWith(orphan)), 'the orphan\'s ownership was collected once it ended');
    lock.release();
  });

  it('a token or a process group that is not well-formed touches no path', BOUNDED, () => {
    const { path } = setUp();
    const outside = join(dirname(path), 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'kept'), '');
    throws(() => registerGroup({ path, token: '../outside', chain: [] }, 1), (e) => e instanceof HeavyLockError && /is not a UUID/.test(e.message));
    for (const pgid of [0, -1, 1.5, '12']) {
      throws(() => registerGroup({ path, token: randomUUID(), chain: [] }, pgid), /is not a positive integer/);
    }
    closeOwnership(path, '../outside');
    plantHolder(path, { token: '../outside' });
    const raw = readFileSync(path, 'utf8');
    strictEqual(reapStale(path, { raw, record: JSON.parse(raw) }, { pid: process.pid, host: hostname(), token: randomUUID() }, quiet), true);
    deepStrictEqual(readdirSync(outside), ['kept']);
    ok(!existsSync(`${path}.groups`), 'nothing was created');
  });
});

describe('release and cancellation', () => {
  it('an abort ends the wait with nothing placed', BOUNDED, async () => {
    const { root, path } = setUp();
    const held = await acquire(root, { log: quiet });
    const raw = readFileSync(path, 'utf8');
    const said = [];
    const cancel = new AbortController();
    const waiting = acquire(root, { log: (l) => said.push(l), pollMs: 20, signal: cancel.signal });
    ok(await until(() => said.some((l) => l.includes('waiting for the run of'))), said.join('\n'));
    cancel.abort();
    await rejects(waiting, { name: 'AbortError' });
    strictEqual(readFileSync(path, 'utf8'), raw, 'the holder keeps its lock');
    deepStrictEqual(readdirSync(dirname(path)).filter((n) => n.startsWith('mutation-harness.lock')).sort(),
      ['mutation-harness.lock', 'mutation-harness.lock.groups']);
    held.release();
    // An abort before the first attempt places nothing, though the lock is free.
    await rejects(acquire(root, { log: quiet, signal: AbortSignal.abort() }), { name: 'AbortError' });
    ok(!existsSync(path));
    // Nor does it join a holder whose proof it carries.
    const holder = await acquire(root, { kind: 'wrapper', purpose: 'p', log: quiet, mint: true });
    const env = { [PROOF_ENV]: holder.proof, [VIA_ENV]: holder.chain.join(',') };
    await rejects(acquire(root, { log: quiet, env, signal: AbortSignal.abort() }), { name: 'AbortError' });
    holder.release();
  });

  it('a registration that lands just before the release\'s close keeps the lock', BOUNDED, async () => {
    const { root, path } = setUp();
    const lock = await acquire(root, { log: quiet });
    const pgid = sleeper();
    throws(() => lock.release({ beforeClose: () => registerGroup(lock.ownership, pgid) }),
      (e) => e instanceof HeavyLockBusyError && e.message.includes(String(pgid)));
    ok(existsSync(path), 'the lock is kept');
    deepStrictEqual(ownershipGroups(path, lock.token).map((g) => g.pgid), [pgid]);
    process.kill(-pgid, 'SIGKILL');
    ok(await until(() => !groupAlive(pgid)));
    lock.release();
    ok(!existsSync(path));
  });

  it('repeats a waiting line with how long the wait has lasted', BOUNDED, async () => {
    const { root } = setUp();
    const held = await acquire(root, { log: quiet });
    const said = [];
    await rejects(acquire(root, { log: (l) => said.push(l), pollMs: 20, reportMs: 100, signal: AbortSignal.timeout(500) }), { name: 'TimeoutError' });
    ok(!said[0].includes('waited'), said[0]);
    ok(said.length >= 2 && said.slice(1).every((l) => /; waited \d+ s so far$/.test(l)), said.join('\n'));
    held.release();
  });
});

describe('who is inside an ownership', () => {
  it('a process whose holder ended while its ownership runs is refused, not left to wait on its own ancestors', BOUNDED, async () => {
    const { root, path } = setUp();
    const holder = plantHolder(path, { proof_digest: sha256(mintProof()), kind: 'wrapper' });
    const pgid = sleeper();
    registerGroup(openFor(path, holder.token), pgid);
    const inside = { [PROOF_ENV]: mintProof(), [VIA_ENV]: `${holder.token},${randomUUID()}` };
    await rejects(acquire(root, { log: quiet, env: inside, pollMs: 20, signal: AbortSignal.timeout(5000) }),
      (e) => e instanceof HeavyLockError && /would wait on this process's own ancestors/.test(e.message));
    // The same ownership, its lock gone (an older reaper removed it).
    rmSync(path);
    await rejects(acquire(root, { log: quiet, env: inside, pollMs: 20, signal: AbortSignal.timeout(5000) }),
      (e) => e instanceof HeavyLockError && /own ancestors/.test(e.message));
    // Control: a process from outside waits.
    await rejects(acquire(root, { log: quiet, pollMs: 20, signal: AbortSignal.timeout(300) }), { name: 'TimeoutError' });
  });

  it('refuses a chain of handles too deep or malformed to extend', BOUNDED, async () => {
    const { root } = setUp();
    const holder = await acquire(root, { kind: 'wrapper', purpose: 'p', log: quiet, mint: true });
    for (const via of [Array.from({ length: 64 }, () => randomUUID()).join(','), 'not-a-handle']) {
      await rejects(acquire(root, { log: quiet, env: { [PROOF_ENV]: holder.proof, [VIA_ENV]: via } }),
        (e) => e instanceof HeavyLockError && /nesting this deep is refused/.test(e.message));
    }
    const ok63 = await acquire(root, { log: quiet, env: { [PROOF_ENV]: holder.proof, [VIA_ENV]: Array.from({ length: 63 }, () => randomUUID()).join(',') } });
    strictEqual(ok63.chain.length, 64);
    holder.release();
  });
});

describe('signalling a group', () => {
  it('sends to the group it registered, never to one that took its id since', () => {
    const sent = [];
    const sys = (leader, started) => ({
      kill: (pid, signal) => { if (signal === 0) { if (pid > 0 && !leader) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); return; } sent.push([pid, signal]); },
      info: () => ({ zombie: false, started }),
    });
    strictEqual(signalGroup(7, 'utc:A', 'SIGTERM', sys(true, 'utc:B')), false, 'a reused leader');
    deepStrictEqual(sent, []);
    strictEqual(signalGroup(7, 'utc:A', 'SIGTERM', sys(true, 'utc:A')), true);
    strictEqual(signalGroup(7, 'utc:A', 'SIGKILL', sys(false, 'utc:B')), true, 'its leader gone, the group is still ours');
    deepStrictEqual(sent, [[-7, 'SIGTERM'], [-7, 'SIGKILL']]);
  });
});

describe('the proof', () => {
  it('a running holder\'s proof joins it without waiting; a wrong or stale proof is no join', BOUNDED, async () => {
    const { root, path } = setUp();
    const holder = await acquire(root, { kind: 'wrapper', purpose: 'the suite', log: quiet, mint: true });
    strictEqual(holder.record.proof_digest, sha256(holder.proof), 'the record keeps the digest');
    ok(!readFileSync(path, 'utf8').includes(holder.proof), 'the record keeps nothing the proof could be made from');
    const said = [];
    const env = { [PROOF_ENV]: holder.proof, [VIA_ENV]: holder.chain.join(',') };
    const joined = await acquire(root, { log: (l) => said.push(l), env, signal: AbortSignal.timeout(2000) });
    strictEqual(joined.joined, true);
    strictEqual(joined.token, holder.token);
    deepStrictEqual(joined.chain.slice(0, 1), [holder.token]);
    strictEqual(joined.chain.length, 2);
    deepStrictEqual(said, [`mutation-harness: inside the heavy-work lock of the suite (pid ${process.pid}); not waiting`]);
    joined.release();
    strictEqual(JSON.parse(readFileSync(path, 'utf8')).token, holder.token, 'a joined acquirer releases nothing');

    const wrong = { [PROOF_ENV]: mintProof() };
    const waits = [];
    await rejects(acquire(root, { log: (l) => waits.push(l), env: wrong, pollMs: 20, signal: AbortSignal.timeout(400) }), { name: 'TimeoutError' });
    ok(waits.some((l) => l.includes('waiting for the run of the suite')), waits.join('\n'));
    holder.release();

    // A proof whose holder is dead is ignored: the lock is judged stale and taken.
    const proof = mintProof();
    plantHolder(path, { proof_digest: sha256(proof), kind: 'wrapper' });
    const took = await acquire(root, { log: quiet, env: { [PROOF_ENV]: proof }, pollMs: 20, signal: AbortSignal.timeout(5000) });
    strictEqual(took.joined, false);
    took.release();
  });

  it('records what an older harness reads, and the start as this platform spells it', BOUNDED, async () => {
    const { root, path } = setUp();
    const lock = await acquire(root, { kind: 'wrapper', purpose: 'npm test', log: quiet, mint: true });
    const record = JSON.parse(readFileSync(path, 'utf8'));
    for (const key of ['pid', 'host', 'started', 'token', 'started_at', 'worktree', 'spec']) ok(key in record, key);
    strictEqual(record.spec, 'npm test', 'an older harness names a wrapper holder by its spec');
    strictEqual(record.schema, 'agentic-heavy-lock-1');
    strictEqual(record.kind, 'wrapper');
    strictEqual(record.started, processInfo(process.pid).started);
    lock.release();
  });
});
