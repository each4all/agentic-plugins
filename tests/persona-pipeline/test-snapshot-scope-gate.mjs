// C181 (ADR-0023 §6, amendment of 2026-11-24, what is kept while a scope is
// not read gone) — the removal gate of persona-pipeline's peer-snapshot.mjs,
// which every remover of a snapshot passes (removePeerSnapshot, and through it
// removeOwnedSnapshot and the reclaim): an owner record that carries a scope
// is removed only on a reading of gone this process made; a record with no
// scope, or none at all with no tree left, goes as 2026-10-19 decides; a
// record that cannot be read, or is absent while a tree is left, is kept
// whatever its age. The reading is the gate's seam (`readScope`), so no row
// depends on this machine's cgroups. The fixtures are real git repositories.

import { afterEach, describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT } from './_personas.mjs';
import { cleanEnv, makeDirtyRepo, snapshotWorktrees, withTmp } from './_peer-snapshot-fixtures.mjs';

const LIB = join(REPO_ROOT, 'persona-pipeline/files/scripts/lib');
const lib = await import(pathToFileURL(join(LIB, 'peer-snapshot.mjs')).href);
const reader = await import(pathToFileURL(join(LIB, 'scope-reader.mjs')).href);

const env = cleanEnv();
const BOOT = 'e55a09fa-13b3-445f-9aa0-4b51e123717f';
const OTHER_BOOT = '11111111-2222-3333-4444-555555555555';
const CLOCK = `${BOOT}/time:[4026531834]/pid:[4026531836]`;
const MANAGER = '/user.slice/user-1000.slice/user@1000.service';
let serial = 0;

function identity(over = {}) {
  serial += 1;
  const unit = `agentic-launch-r${serial}-k3j9.scope`;
  return {
    owner: { kind: 'peer-run', run_id: `r${serial}` },
    unit,
    invocation_id: '0123456789abcdef0123456789abcdef',
    cgroup_path: `${MANAGER}/app.slice/${unit}`,
    cgroup_id: String(9000 + serial),
    boot_id: BOOT,
    gate: { pid: 4242, starttime: '5000', clock: CLOCK },
    supervisor: { pid: 4000, fingerprint: { kind: 'linux_proc_starttime', starttime: '4000' }, clock: CLOCK, boot_id: BOOT },
    has_snapshot: true,
    association: null,
    ...over,
  };
}

const scoped = (id = identity()) => ({ version: 1, state: 'scoped', identity: id });

function setScope(snap, scope) {
  const owner = JSON.parse(readFileSync(snap.owner_path, 'utf8'));
  if (scope === undefined) delete owner.scope;
  else owner.scope = scope;
  writeFileSync(snap.owner_path, JSON.stringify(owner));
}

// A reading seam that answers `state` and counts its calls.
function reading(state) {
  const seen = [];
  const fn = async (id) => {
    seen.push(id.unit);
    return { state };
  };
  return { fn, seen };
}

// A reading seam for rows that must not read: it counts its calls, and each
// row asserts none (a throw alone would be caught by the gate as withheld).
const calls = { n: 0 };
const never = async () => {
  calls.n += 1;
  return { state: 'gone' };
};

afterEach(() => {
  strictEqual(calls.n, 0, 'the gate read a scope it had no need to read');
});

const whole = (snap) => existsSync(snap.owner_path) && existsSync(snap.root) && snapshotWorktrees(snap.live_toplevel).length === 1;
const removedAll = (snap) => !existsSync(snap.parent) && snapshotWorktrees(snap.live_toplevel).length === 0;
const asRemover = (snap) => ({ live_toplevel: snap.live_toplevel, root: snap.root, parent: snap.parent, branch: null });

describe('C181: the snapshot removal gate — records that carry no scope', () => {
  for (const [label, scope] of [
    ['an earlier release\'s record, with no scope', undefined],
    ['a run that made no scope', { version: 1, state: 'none', reason: 'unavailable' }],
    ['a scoped launch abandoned before the word', { version: 1, state: 'abandoned', identity: identity() }],
  ]) {
    it(`${label} is removed as 2026-10-19 decides, with no reading`, async () => {
      await withTmp(async (dir) => {
        const snap = await lib.createPeerSnapshot({ cwd: makeDirtyRepo(dir), persona: 'engineer', env });
        setScope(snap, scope);
        const removed = await lib.removePeerSnapshot(asRemover(snap), { env, readScope: never });
        deepStrictEqual([removed.removed, removed.kept], [true, undefined]);
        ok(removedAll(snap));
      });
    });
  }

  it('a record read whole that is no owner record passes (the proof owner-unreadable-expired rests on)', async () => {
    await withTmp(async (dir) => {
      const snap = await lib.createPeerSnapshot({ cwd: makeDirtyRepo(dir), persona: 'engineer', env });
      writeFileSync(snap.owner_path, JSON.stringify({ schema: 'something-else', scope: scoped() }));
      const removed = await lib.removePeerSnapshot(asRemover(snap), { env, readScope: never });
      strictEqual(removed.removed, true);
      ok(removedAll(snap));
    });
  });
});

describe('C181: the snapshot removal gate — a record that carries a scope', () => {
  for (const state of ['unproven', 'emptied', 'withheld', 'refused']) {
    it(`is kept whole on a reading of ${state}, naming the unit`, async () => {
      await withTmp(async (dir) => {
        const snap = await lib.createPeerSnapshot({ cwd: makeDirtyRepo(dir), persona: 'engineer', env });
        const id = identity();
        setScope(snap, scoped(id));
        const read = reading(state);
        const removed = await lib.removePeerSnapshot(asRemover(snap), { env, readScope: read.fn });
        deepStrictEqual(removed, { removed: false, error: null, kept: `scope-${state}`, unit: id.unit });
        deepStrictEqual(read.seen, [id.unit]);
        ok(whole(snap), 'the tree, its registration and the owner record are left');
      });
    });
  }

  it('is kept when the reading throws', async () => {
    await withTmp(async (dir) => {
      const snap = await lib.createPeerSnapshot({ cwd: makeDirtyRepo(dir), persona: 'engineer', env });
      setScope(snap, scoped());
      const removed = await lib.removePeerSnapshot(asRemover(snap), { env, readScope: async () => { throw new Error('boom'); } });
      strictEqual(removed.kept, 'scope-withheld');
      ok(whole(snap));
    });
  });

  it('is removed on a reading of gone at the removal', async () => {
    await withTmp(async (dir) => {
      const snap = await lib.createPeerSnapshot({ cwd: makeDirtyRepo(dir), persona: 'engineer', env });
      setScope(snap, scoped());
      const removed = await lib.removePeerSnapshot(asRemover(snap), { env, readScope: reading('gone').fn });
      strictEqual(removed.removed, true);
      ok(removedAll(snap));
    });
  });

  it('is removed with no new reading once this process read the scope gone earlier', async () => {
    await withTmp(async (dir) => {
      const snap = await lib.createPeerSnapshot({ cwd: makeDirtyRepo(dir), persona: 'engineer', env });
      const id = identity();
      setScope(snap, scoped(id));
      strictEqual(reader.readGoneHere(id), false);
      // A reader under another boot reads the scope gone before any lookup.
      // A reader attestReader did not return adds nothing to the record.
      deepStrictEqual(reader.observeScope({ bootId: OTHER_BOOT }, id), { state: 'gone', check: 'other-boot' });
      strictEqual(reader.readGoneHere(id), false);
      deepStrictEqual(reader.observeScope({ ok: true, bootId: OTHER_BOOT }, id), { state: 'gone', check: 'other-boot' });
      strictEqual(reader.readGoneHere(id), true);
      strictEqual(reader.readGoneHere(identity()), false, 'another scope is no reading of this one');
      const removed = await lib.removePeerSnapshot(asRemover(snap), { env, readScope: never });
      strictEqual(removed.removed, true);
      ok(removedAll(snap));
    });
  });

  for (const [label, scope, why] of [
    ['of a version this reader does not know', { version: 2, state: 'scoped' }, 'scope-unknown-version'],
    ['this release does not parse', { version: 1, state: 'scoped', identity: { ...identity(), cgroup_id: 'x' } }, 'scope-malformed'],
    ['whose owner kind is an inherited key', { version: 1, state: 'scoped', identity: { ...identity(), owner: { kind: 'constructor' } } }, 'scope-malformed'],
  ]) {
    it(`a scope ${label} is kept, and not read`, async () => {
      await withTmp(async (dir) => {
        const snap = await lib.createPeerSnapshot({ cwd: makeDirtyRepo(dir), persona: 'engineer', env });
        setScope(snap, scope);
        const removed = await lib.removePeerSnapshot(asRemover(snap), { env, readScope: never });
        strictEqual(removed.kept, why);
        ok(whole(snap));
      });
    });
  }

  it('removeOwnedSnapshot passes the gate too', async () => {
    await withTmp(async (dir) => {
      const snap = await lib.createPeerSnapshot({ cwd: makeDirtyRepo(dir), runId: 'r-owned', persona: 'engineer', env });
      setScope(snap, scoped());
      const owner = JSON.parse(readFileSync(snap.owner_path, 'utf8'));
      const removed = await lib.removeOwnedSnapshot(snap.owner_path, owner, { env, root: snap.root, readScope: reading('unproven').fn });
      strictEqual(removed.kept, 'scope-unproven');
      ok(whole(snap));
    });
  });
});

describe('C181: the snapshot removal gate rests on the record a verdict was made on', () => {
  it('a record that gained a scope since the verdict is kept', async () => {
    await withTmp(async (dir) => {
      const snap = await lib.createPeerSnapshot({ cwd: makeDirtyRepo(dir), persona: 'engineer', env });
      const judged = JSON.parse(readFileSync(snap.owner_path, 'utf8'));
      setScope(snap, scoped());
      const removed = await lib.removePeerSnapshot(asRemover(snap), { env, readScope: never, judged });
      strictEqual(removed.kept, 'owner-changed');
      ok(whole(snap));
    });
  });

  it('a record that turned malformed since a verdict made on a whole one is kept', async () => {
    await withTmp(async (dir) => {
      const snap = await lib.createPeerSnapshot({ cwd: makeDirtyRepo(dir), persona: 'engineer', env });
      const judged = JSON.parse(readFileSync(snap.owner_path, 'utf8'));
      writeFileSync(snap.owner_path, '{ not json');
      strictEqual((await lib.removePeerSnapshot(asRemover(snap), { env, readScope: never, judged })).kept, 'owner-changed');
      ok(existsSync(snap.root));
    });
  });

  it('a record that reads whole again after a verdict made on none is kept', async () => {
    await withTmp(async (dir) => {
      const snap = await lib.createPeerSnapshot({ cwd: makeDirtyRepo(dir), persona: 'engineer', env });
      strictEqual((await lib.removePeerSnapshot(asRemover(snap), { env, readScope: never, judged: null })).kept, 'owner-changed');
      ok(whole(snap));
    });
  });

  it('the same record passes (the control)', async () => {
    await withTmp(async (dir) => {
      const snap = await lib.createPeerSnapshot({ cwd: makeDirtyRepo(dir), persona: 'engineer', env });
      const judged = JSON.parse(readFileSync(snap.owner_path, 'utf8'));
      strictEqual((await lib.removePeerSnapshot(asRemover(snap), { env, readScope: never, judged })).removed, true);
      ok(removedAll(snap));
    });
  });
});

describe('C181: the snapshot removal gate — an owner record that does not read', () => {
  it('absent while the tree is left: kept', async () => {
    await withTmp(async (dir) => {
      const snap = await lib.createPeerSnapshot({ cwd: makeDirtyRepo(dir), persona: 'engineer', env });
      rmSync(snap.owner_path);
      const removed = await lib.removePeerSnapshot(asRemover(snap), { env, readScope: never });
      strictEqual(removed.kept, 'owner-absent-tree-left');
      ok(existsSync(snap.root));
    });
  });

  it('absent with no tree left (a first owner write that failed): removed, with no reading', async () => {
    await withTmp(async (dir, snaps) => {
      const parent = mkdtempSync(join(snaps, 'engineer-peer-snapshot-'));
      const removed = await lib.removePeerSnapshot({ live_toplevel: null, root: null, parent, branch: null }, { env, readScope: never });
      strictEqual(removed.removed, true);
      ok(!existsSync(parent));
    });
  });

  it('a lookup that fails otherwise (here the record is a directory): kept', async () => {
    await withTmp(async (dir) => {
      const snap = await lib.createPeerSnapshot({ cwd: makeDirtyRepo(dir), persona: 'engineer', env });
      rmSync(snap.owner_path);
      mkdirSync(snap.owner_path);
      const removed = await lib.removePeerSnapshot(asRemover(snap), { env, readScope: never });
      strictEqual(removed.kept, 'owner-unreadable');
      ok(existsSync(snap.root));
    });
  });

  it('a record with no read permission: kept', { skip: process.getuid?.() === 0 ? 'root reads a file of mode 000' : false }, async () => {
    await withTmp(async (dir) => {
      const snap = await lib.createPeerSnapshot({ cwd: makeDirtyRepo(dir), persona: 'engineer', env });
      chmodSync(snap.owner_path, 0o000);
      try {
        const removed = await lib.removePeerSnapshot(asRemover(snap), { env, readScope: never });
        strictEqual(removed.kept, 'owner-unreadable');
        ok(existsSync(snap.root));
      } finally {
        chmodSync(snap.owner_path, 0o600);
      }
    });
  });
});

describe('C181: the reclaim parts the owner record\'s lookups and passes the gate before its age rule', () => {
  const late = Date.now() + lib.SNAPSHOT_TTL_MS + 60_000;

  it('a registered snapshot whose owner record is absent while its tree is left is kept past the TTL', async () => {
    await withTmp(async (dir) => {
      const snap = await lib.createPeerSnapshot({ cwd: makeDirtyRepo(dir), persona: 'engineer', env });
      rmSync(snap.owner_path);
      const report = await lib.reclaimPeerSnapshots({ cwd: snap.live_toplevel, env, now: late, readScope: never });
      deepStrictEqual([report.kept.map((k) => k.why), report.reclaimed, report.errors], [['owner-absent-tree-left'], [], []]);
      ok(existsSync(snap.root));
    });
  });

  it('a registered snapshot whose owner record cannot be read is kept past the TTL', async () => {
    await withTmp(async (dir) => {
      const snap = await lib.createPeerSnapshot({ cwd: makeDirtyRepo(dir), persona: 'engineer', env });
      rmSync(snap.owner_path);
      mkdirSync(snap.owner_path);
      const report = await lib.reclaimPeerSnapshots({ cwd: snap.live_toplevel, env, now: late, readScope: never });
      deepStrictEqual([report.kept.map((k) => k.why), report.reclaimed], [['owner-unreadable'], []]);
    });
  });

  it('a scope not read gone keeps a snapshot the age rule would reclaim, naming its unit', async () => {
    await withTmp(async (dir) => {
      const snap = await lib.createPeerSnapshot({ cwd: makeDirtyRepo(dir), persona: 'engineer', env });
      const id = identity();
      setScope(snap, scoped(id));
      // A supervisor whose identity cannot be told reclaims on age alone.
      const owner = JSON.parse(readFileSync(snap.owner_path, 'utf8'));
      owner.supervisor.fingerprint = { kind: 'none' };
      writeFileSync(snap.owner_path, JSON.stringify(owner));
      const report = await lib.reclaimPeerSnapshots({ cwd: snap.live_toplevel, env, now: late, readScope: reading('unproven').fn });
      deepStrictEqual([report.kept, report.reclaimed, report.errors], [[{ tree: snap.root, why: 'scope-unproven', unit: id.unit }], [], []]);
      ok(whole(snap));
      // The control: the same snapshot, its scope read gone, is reclaimed.
      const again = await lib.reclaimPeerSnapshots({ cwd: snap.live_toplevel, env, now: late, readScope: reading('gone').fn });
      deepStrictEqual(again.reclaimed.map((r) => r.why), ['identity-unknown-expired']);
      ok(removedAll(snap));
    });
  });
});
