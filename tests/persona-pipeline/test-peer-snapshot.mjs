// C96 — a codex peer runs in a snapshot of the checkout, never the live tree:
// plugins/<persona>/scripts/lib/peer-snapshot.mjs (capture, materialize,
// remove, reclaim) and its two callers, peer-runner.mjs and dispatch-peer.mjs,
// run once for every persona the persona-pipeline manifest generates the
// library into (ADR-0066 Decision 5).
//
// The fixtures are real git repositories. The fake companion's `vandal` mode
// does what a peer was measured doing — `checkout -- .` and `clean -fd` in
// the directory it was given — so "the live tree is intact" is tested against
// the failure it exists for, not against a peer that never writes.

import { describe, it } from 'node:test';
import { ok, strictEqual, notStrictEqual, deepStrictEqual, rejects, match } from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  cpSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { personasFor, personaInfo } from './_personas.mjs';
// C142 O-F2 — this process's judgments read the suites' listing too.
import { listAgain } from './_peer-snapshot-listing.mjs';
import {
  GIT_ENV,
  cleanEnv,
  git,
  gitTry,
  sleep,
  waitFor,
  alive,
  within,
  killGroup,
  groupAlive,
  withTmp,
  leftovers,
  snapshotWorktrees,
  makeDirtyRepo,
  makeUnmergedRepo,
  liveView,
  indexStamp,
  withoutStateHome,
  writeFakeCompanions,
  startHostedRun,
  hostTeardown,
  editJson,
  leaderlessGroup,
  sigtermsSeen,
} from './_peer-snapshot-fixtures.mjs';

const require = createRequire(import.meta.url);

for (const persona of personasFor('scripts/lib/peer-snapshot.mjs')) {
  const P = personaInfo(persona);
  const lib = await import(pathToFileURL(P.path('scripts/lib/peer-snapshot.mjs')).href);
  const identity = await import(pathToFileURL(P.path('scripts/lib/process-identity.mjs')).href);
  const runner = await import(pathToFileURL(P.path('scripts/peer-runner.mjs')).href);
  const dispatcher = await import(pathToFileURL(P.path('scripts/dispatch-peer.mjs')).href);
  const state = await import(pathToFileURL(P.path('scripts/state.mjs')).href);
  const stateRoot = await import(pathToFileURL(P.path('scripts/lib/state-root.mjs')).href);
  const env = cleanEnv();
  // C142 O-F2 — the real listing without the processes it could not read: a
  // process of the user's own that hides its directory (a `login` or a `sudo`
  // on macOS, one not dumpable on Linux) and is not placed outside the run
  // reads `unknown`, so a case that is not about the listing judges only the
  // processes it reads, and its result does not hang on what else runs on the
  // machine; a listing that proves nothing is taken again (listAgain, C142
  // S-F2). The cases about the listing judge an injected one.
  const readable = async (options) => (await listAgain(() => identity.allProcessCwds(options)))?.filter((m) => !m.unreadable) ?? null;
  // The clock this process reads, which a runner records with its supervisor:
  // an owner record a case writes for a gone supervisor carries it, since a
  // Linux listing for a run whose clock was not recorded proves nothing (C142
  // R-F1). A snapshot made for a pid already gone records none of its own.
  const HERE = await identity.clockDomain();
  const withClock = (snap) => {
    const owner = JSON.parse(readFileSync(snap.owner_path, 'utf8'));
    owner.supervisor.fingerprint = { ...owner.supervisor.fingerprint, clock: HERE };
    writeFileSync(snap.owner_path, JSON.stringify(owner));
    return snap;
  };
  const reclaim = (options) => lib.reclaimPeerSnapshots({ listProcesses: readable, ...options });

  describe(`${persona}: peer snapshot — capture and materialize (C96)`, () => {
    it('keeps every working-tree and index state, leaves the live index untouched, and is removed whole', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        const before = liveView(top);
        const stamp = indexStamp(top);
        const snap = await lib.createPeerSnapshot({ cwd: join(top, 'sub'), runId: 'r1', persona, env });
        strictEqual(snap.isolation, 'snapshot');
        deepStrictEqual(indexStamp(top), stamp, 'the live index is read, never written');
        ok(relative(top, snap.root).startsWith('..'), 'the snapshot is outside the checkout');
        strictEqual(snap.peer_cwd, join(snap.root, 'sub'));
        const view = liveView(snap.root);
        strictEqual(view.head, before.head);
        strictEqual(view.status, withoutStateHome(before.status));
        strictEqual(view.cached, before.cached);
        strictEqual(view.diff, before.diff);
        strictEqual(view.flags, before.flags, 'assume-unchanged and skip-worktree flags are replayed');
        strictEqual(readFileSync(join(snap.root, 'a'), 'utf8'), 'A1\na2\nA3\n', 'the working bytes of a partially staged file');
        strictEqual(git(snap.root, 'show', ':a'), 'A1\na2\na3\n', 'its staged bytes');
        ok(!existsSync(join(snap.root, 'ignored.txt')) && !existsSync(join(snap.root, 'igdir')), 'ignored files stay out');
        ok(!existsSync(join(snap.root, '.agentic-plugins')), 'the state home stays out');
        ok(existsSync(join(snap.root, 'untracked')));
        strictEqual(snapshotWorktrees(top).length, 1);
        // A peer that tidies its directory tidies the snapshot only.
        git(snap.root, 'checkout', '--', '.');
        git(snap.root, 'clean', '-fdq');
        deepStrictEqual(liveView(top), before);
        const removed = await lib.removePeerSnapshot(snap, { env });
        deepStrictEqual(removed, { removed: true, error: null });
        strictEqual(snapshotWorktrees(top).length, 0);
        deepStrictEqual(leftovers(snaps), []);
        deepStrictEqual(indexStamp(top), stamp);
      });
    });

    it('a peer directory that holds only ignored files is created in the snapshot', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const snap = await lib.createPeerSnapshot({ cwd: join(top, 'igdir'), persona, env });
        strictEqual(snap.peer_cwd, join(snap.root, 'igdir'));
        ok(statSync(snap.peer_cwd).isDirectory());
        ok(!existsSync(join(snap.peer_cwd, 'x')));
        await lib.removePeerSnapshot(snap, { env });
      });
    });

    it('from a linked worktree: that worktree\'s HEAD and its own index', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        const lane = join(dir, 'lane');
        git(top, 'worktree', 'add', '-q', '-b', 'feat/x', lane);
        writeFileSync(join(lane, 'a'), 'lane-staged\n');
        git(lane, 'add', 'a');
        writeFileSync(join(lane, 'a'), 'lane-working\n');
        const before = liveView(lane);
        const snap = await lib.createPeerSnapshot({ cwd: lane, persona, env });
        const view = liveView(snap.root);
        strictEqual(view.head, before.head);
        strictEqual(view.status, before.status);
        strictEqual(view.cached, before.cached);
        strictEqual(readFileSync(join(snap.root, 'a'), 'utf8'), 'lane-working\n');
        await lib.removePeerSnapshot(snap, { env });
        deepStrictEqual(leftovers(snaps), []);
        deepStrictEqual(liveView(lane), before);
      });
    });

    it('an unborn HEAD gets an orphan snapshot, and no branch is left behind', async () => {
      await withTmp(async (dir, snaps) => {
        const top = join(dir, 'repo');
        mkdirSync(top);
        git(top, 'init', '-q', '-b', 'main');
        writeFileSync(join(top, 'staged'), 's\n');
        git(top, 'add', 'staged');
        writeFileSync(join(top, 'loose'), 'l\n');
        const before = git(top, 'status', '--porcelain=v1', '-uall');
        const snap = await lib.createPeerSnapshot({ cwd: top, persona, env });
        strictEqual(snap.isolation, 'snapshot');
        strictEqual(snap.head, null);
        strictEqual(git(snap.root, 'status', '--porcelain=v1', '-uall'), before);
        // A commit the peer makes there would create the orphan branch.
        git(snap.root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'peer');
        await lib.removePeerSnapshot(snap, { env });
        strictEqual(git(top, 'for-each-ref'), '');
        deepStrictEqual(leftovers(snaps), []);
        strictEqual(git(top, 'status', '--porcelain=v1', '-uall'), before);
      });
    });

    it('a directory that is no checkout runs as before (isolation none)', async () => {
      await withTmp(async (dir, snaps) => {
        const plain = join(dir, 'plain');
        mkdirSync(plain);
        deepStrictEqual(await lib.createPeerSnapshot({ cwd: plain, persona, env }), { isolation: 'none', reason: 'not-a-checkout' });
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('a broken .git fails the snapshot (never "no checkout") and leaves nothing', async () => {
      await withTmp(async (dir, snaps) => {
        const top = join(dir, 'repo');
        mkdirSync(top);
        writeFileSync(join(top, '.git'), 'gitdir: /nonexistent/elsewhere\n');
        await rejects(lib.createPeerSnapshot({ cwd: top, persona, env }), (e) => e.reason === 'git-discovery');
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('an unmerged index fails the snapshot and leaves no worktree or directory', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeUnmergedRepo(dir);
        await rejects(lib.createPeerSnapshot({ cwd: top, persona, env }), (e) => e.reason === 'unmerged-index');
        deepStrictEqual(leftovers(snaps), []);
        strictEqual(snapshotWorktrees(top).length, 0);
      });
    });

    it('git selectors in the caller\'s environment cannot point the capture or the snapshot at the live tree', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const before = liveView(top);
        const stamp = indexStamp(top);
        const poisoned = { ...env, GIT_DIR: join(top, '.git'), GIT_WORK_TREE: top, GIT_INDEX_FILE: join(top, '.git', 'index') };
        const snap = await lib.createPeerSnapshot({ cwd: top, persona, env: poisoned });
        deepStrictEqual(indexStamp(top), stamp);
        strictEqual(liveView(snap.root).status, withoutStateHome(before.status));
        const scrubbed = lib.scrubGitSelectors(poisoned);
        for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) ok(!(name in scrubbed), `${name} is scrubbed`);
        await lib.removePeerSnapshot(snap, { env: poisoned });
        deepStrictEqual(liveView(top), before);
      });
    });

    it('a TMPDIR inside the checkout puts the snapshot outside it', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const inside = join(top, 'igdir', 'tmp');
        mkdirSync(inside, { recursive: true });
        const saved = process.env.TMPDIR;
        process.env.TMPDIR = inside;
        try {
          const snap = await lib.createPeerSnapshot({ cwd: top, persona, env });
          ok(relative(top, snap.root).startsWith('..'), `${snap.root} is outside ${top}`);
          await lib.removePeerSnapshot(snap, { env });
        } finally {
          process.env.TMPDIR = saved;
        }
      });
    });

    it('HEAD moving during the capture is captured again; moving twice fails, leaving nothing', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        const move = () => git(top, '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'moved');
        const snap = await lib.createPeerSnapshot({ cwd: top, persona, env, hooks: { afterCapture: (n) => (n === 1 ? move() : null) } });
        strictEqual(snap.head, git(top, 'rev-parse', 'HEAD').trim(), 'the second capture, at the moved HEAD');
        await lib.removePeerSnapshot(snap, { env });
        await rejects(lib.createPeerSnapshot({ cwd: top, persona, env, hooks: { afterCapture: move } }), (e) => e.reason === 'head-moved');
        deepStrictEqual(leftovers(snaps), []);
        strictEqual(snapshotWorktrees(top).length, 0);
      });
    });

    it('a cancellation during the capture stops it and leaves nothing', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        const abort = new AbortController();
        await rejects(lib.createPeerSnapshot({ cwd: top, persona, env, signal: abort.signal, hooks: { afterCapture: () => abort.abort() } }), (e) => e.reason === 'cancelled');
        deepStrictEqual(leftovers(snaps), []);
        strictEqual(snapshotWorktrees(top).length, 0);
      });
    });

    it('a cancellation while a git call runs (a slow clean filter) stops that call, the filter with it, and reads as cancelled', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        // The filter is git's child: it records its shell's pid, starts a
        // descendant that ignores SIGTERM and holds none of git's pipes (so
        // 'close' does not wait for it), records that one's pid, then sleeps.
        const pidFile = join(dir, 'filter.pid');
        const descFile = join(dir, 'descendant.pid');
        // The descendant says it is ready once its trap is in place.
        const readyFile = join(dir, 'descendant.ready');
        git(top, 'config', 'filter.slow.clean', `(trap '' TERM; : > '${readyFile}'; exec sleep 30) </dev/null >/dev/null 2>&1 & echo $! > '${descFile}'; echo $$ > '${pidFile}'; sleep 30; cat`);
        writeFileSync(join(top, '.gitattributes'), 'slowfile filter=slow\n');
        writeFileSync(join(top, 'slowfile'), 'slow\n');
        const abort = new AbortController();
        const started = Date.now();
        const creating = lib.createPeerSnapshot({ cwd: top, persona, env, signal: abort.signal });
        let filterPid = null;
        let descendantPid = null;
        try {
          await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() && existsSync(readyFile), { message: 'the filter and its SIGTERM-ignoring descendant to start' });
          filterPid = Number(readFileSync(pidFile, 'utf8').trim());
          descendantPid = Number(readFileSync(descFile, 'utf8').trim());
          ok(alive(descendantPid), 'the descendant runs');
          abort.abort();
          await rejects(creating, (e) => e.reason === 'cancelled');
          ok(Date.now() - started < 20000, 'the filter was stopped, not waited out');
          ok(!alive(filterPid), 'the filter git started is stopped with git');
          ok(!alive(descendantPid), 'the descendant that ignores SIGTERM is killed before the call settles');
          deepStrictEqual(leftovers(snaps), []);
          strictEqual(snapshotWorktrees(top).length, 0);
        } finally {
          abort.abort();
          await creating.catch(() => {});
          if (filterPid) killGroup(filterPid);
          if (descendantPid) killGroup(descendantPid);
        }
      });
    });

    it('rewrites the live toplevel in a prompt, in every spelling, at path boundaries only', () => {
      const out = lib.rewritePromptPaths(
        'a=/r/top/x b=/link/top/y c=/r/top d=/r/top-other/z e=/q/r/top/w f=file:///r/top/v',
        ['/r/top', '/link/top'],
        '/snap/tree',
      );
      strictEqual(out.text, 'a=/snap/tree/x b=/snap/tree/y c=/snap/tree d=/r/top-other/z e=/q/r/top/w f=file:///snap/tree/v');
      strictEqual(out.count, 4);
    });

    it('rewrites the toplevel as an XML prompt escapes it', () => {
      const out = lib.rewritePromptPaths(
        'raw=/r/R&D/a text=/r/R&amp;D/b <f path="/r/Q&quot;s&amp;D/c"/> other=/r/R&amp;Dx/d',
        ['/r/R&D', '/r/Q"s&D'],
        '/snap/tree',
      );
      strictEqual(out.text, 'raw=/snap/tree/a text=/snap/tree/b <f path="/snap/tree/c"/> other=/r/R&amp;Dx/d');
      strictEqual(out.count, 3);
    });

    it('a TMPDIR whose path XML would escape is passed over: the root reads the same escaped or not', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const special = join(dir, 'R&D "tmp"');
        mkdirSync(special);
        const saved = process.env.TMPDIR;
        process.env.TMPDIR = special;
        try {
          const snap = await lib.createPeerSnapshot({ cwd: top, persona, env });
          ok(!/[&<>"']/.test(snap.root), `${snap.root} carries no character XML escapes`);
          await lib.removePeerSnapshot(snap, { env });
        } finally {
          process.env.TMPDIR = saved;
        }
      });
    });
  });

  describe(`${persona}: peer snapshot — reclaim (C96)`, () => {
    async function deadPid() {
      const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
      await new Promise((r) => child.once('exit', r));
      return child.pid;
    }
    const editOwner = (snap, fn) => {
      const owner = JSON.parse(readFileSync(snap.owner_path, 'utf8'));
      fn(owner);
      writeFileSync(snap.owner_path, JSON.stringify(owner));
    };

    it('reclaims a snapshot whose supervisor and companion are gone; keeps a live one', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        const dead = withClock(await lib.createPeerSnapshot({ cwd: top, persona, env, supervisorPid: await deadPid() }));
        const live = await lib.createPeerSnapshot({ cwd: top, persona, env });
        editOwner(dead, (o) => { o.companion = { pid: o.supervisor.pid, pgid: o.supervisor.pid, fingerprint: { kind: 'none' } }; });
        const report = await reclaim({ cwd: top, env });
        deepStrictEqual(report.reclaimed.map((r) => r.tree), [dead.root]);
        deepStrictEqual(report.kept.map((k) => [k.tree, k.why]), [[live.root, 'supervisor-alive']]);
        ok(!existsSync(dead.parent));
        ok(existsSync(live.root));
        await lib.removePeerSnapshot(live, { env });
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('keeps a snapshot whose supervisor died while its companion still runs, and reclaims it once that ends', async (t) => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const snap = withClock(await lib.createPeerSnapshot({ cwd: top, persona, env, supervisorPid: await deadPid() }));
        const peer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
        await new Promise((r) => peer.once('spawn', r));
        t.after(() => killGroup(peer.pid));
        await lib.recordSnapshotCompanion(snap, { pid: peer.pid, pgid: peer.pid, fingerprint: await identity.fingerprintForPid(peer.pid) });
        let report = await reclaim({ cwd: top, env });
        deepStrictEqual(report.kept.map((k) => k.why), ['companion-alive']);
        ok(existsSync(snap.root));
        process.kill(-peer.pid, 'SIGKILL');
        await waitFor(() => !groupAlive(peer.pid), { message: 'the companion group to end' });
        report = await reclaim({ cwd: top, env });
        deepStrictEqual(report.reclaimed.map((r) => [r.tree, r.why]), [[snap.root, 'owners-gone']]);
      });
    });

    it('a reused supervisor pid (another fingerprint) counts as gone', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const snap = await lib.createPeerSnapshot({ cwd: top, persona, env });
        editOwner(snap, (o) => {
          o.supervisor.fingerprint = { ...o.supervisor.fingerprint, lstart: 'Thu Jan  1 00:00:00 1970', starttime: '1' };
        });
        strictEqual(await identity.identityState(JSON.parse(readFileSync(snap.owner_path, 'utf8')).supervisor), 'differ');
        const report = await reclaim({ cwd: top, env });
        deepStrictEqual(report.reclaimed.map((r) => r.why), ['supervisor-gone-companion-unrecorded']);
      });
    });

    it('a launch whose companion was never recorded is kept after its supervisor dies, until the TTL', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const snap = withClock(await lib.createPeerSnapshot({ cwd: top, persona, env, supervisorPid: await deadPid() }));
        await lib.recordSnapshotLaunch(snap);
        let report = await reclaim({ cwd: top, env });
        deepStrictEqual(report.kept.map((k) => k.why), ['identity-unknown']);
        report = await reclaim({ cwd: top, env, now: Date.now() + lib.SNAPSHOT_TTL_MS + 60_000 });
        deepStrictEqual(report.reclaimed.map((r) => r.why), ['identity-unknown-expired']);
      });
    });

    it('an identity that cannot be told is kept until the record is older than the TTL', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const snap = await lib.createPeerSnapshot({ cwd: top, persona, env });
        editOwner(snap, (o) => { o.supervisor.fingerprint = { kind: 'none' }; });
        let report = await reclaim({ cwd: top, env });
        deepStrictEqual(report.kept.map((k) => k.why), ['identity-unknown']);
        report = await reclaim({ cwd: top, env, now: Date.now() + lib.SNAPSHOT_TTL_MS + 60_000 });
        deepStrictEqual(report.reclaimed.map((r) => r.why), ['identity-unknown-expired']);
      });
    });

    it('an unreadable owner record follows the TTL too', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const snap = await lib.createPeerSnapshot({ cwd: top, persona, env });
        writeFileSync(snap.owner_path, '{ not json');
        let report = await reclaim({ cwd: top, env });
        deepStrictEqual(report.kept.map((k) => k.why), ['owner-unreadable']);
        report = await reclaim({ cwd: top, env, now: Date.now() + lib.SNAPSHOT_TTL_MS + 60_000 });
        deepStrictEqual(report.reclaimed.map((r) => r.why), ['owner-unreadable-expired']);
        strictEqual(snapshotWorktrees(top).length, 0);
      });
    });

    it('a snapshot whose directory is gone loses its registration', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const snap = await lib.createPeerSnapshot({ cwd: top, persona, env });
        rmSync(snap.parent, { recursive: true, force: true });
        const report = await reclaim({ cwd: top, env });
        deepStrictEqual(report.reclaimed.map((r) => r.why), ['directory-gone']);
        strictEqual(snapshotWorktrees(top).length, 0);
      });
    });

    it('an interrupted creation (an owner record, no worktree) is reclaimed when its supervisor is gone', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        const parent = mkdtempSync(join(snaps, `${persona}-peer-snapshot-`));
        const owner = (pid) => ({
          schema: lib.SNAPSHOT_OWNER_SCHEMA, run_id: null, persona, live_toplevel: top, tree: join(parent, 'tree'), branch: null,
          supervisor: { pid, fingerprint: { kind: 'none', clock: HERE } }, companion: null, created_at: new Date().toISOString(),
        });
        writeFileSync(join(parent, 'owner.json'), JSON.stringify(owner(process.pid)));
        let report = await reclaim({ cwd: top, env });
        ok(existsSync(parent), 'a creator that may still be running is left alone');
        writeFileSync(join(parent, 'owner.json'), JSON.stringify(owner(await deadPid())));
        report = await reclaim({ cwd: top, env });
        deepStrictEqual(report.reclaimed.map((r) => r.why), ['interrupted-supervisor-gone-companion-unrecorded']);
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('a launch its supervisor records while the reclaim judges it is read again before anything is removed', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const snap = withClock(await lib.createPeerSnapshot({ cwd: top, persona, env, supervisorPid: await deadPid() }));
        // The supervisor records the launch, spawns its peer and dies after
        // the reclaim's first read of the owner record.
        let raced = false;
        const hooks = { afterOwnerRead: async () => {
          if (raced) return;
          raced = true;
          await lib.recordSnapshotLaunch(snap);
        } };
        const report = await reclaim({ cwd: top, env, hooks });
        ok(raced);
        deepStrictEqual(report.reclaimed, []);
        deepStrictEqual(report.kept.map((k) => [k.tree, k.why]), [[snap.root, 'identity-unknown']]);
        ok(existsSync(snap.root));
        await lib.removePeerSnapshot(snap, { env });
      });
    });

    it('a live companion group whose leader exited blocks the reclaim, however old the record', async (t) => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const snap = withClock(await lib.createPeerSnapshot({ cwd: top, persona, env, supervisorPid: await deadPid() }));
        // The leader starts a child in its own group, then exits.
        const leader = spawn(process.execPath, ['-e', "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).unref()"], { stdio: 'ignore', detached: true });
        t.after(() => killGroup(leader.pid));
        await new Promise((r) => leader.once('exit', r));
        ok(!alive(leader.pid) && groupAlive(leader.pid), 'the leader is gone, its group lives');
        await lib.recordSnapshotCompanion(snap, { pid: leader.pid, pgid: leader.pid, fingerprint: { kind: 'none' } });
        const report = await reclaim({ cwd: top, env, now: Date.now() + 10 * lib.SNAPSHOT_TTL_MS });
        deepStrictEqual(report.reclaimed, []);
        deepStrictEqual(report.kept.map((k) => k.why), ['companion-alive']);
        ok(existsSync(snap.root));
        await lib.removePeerSnapshot(snap, { env });
      });
    });

    it('an interrupted creation from a linked worktree is reclaimed from the main checkout', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        const lane = join(dir, 'lane');
        git(top, 'worktree', 'add', '-q', '-b', 'feat/lane', lane);
        const snap = withClock(await lib.createPeerSnapshot({ cwd: lane, persona, env, supervisorPid: await deadPid() }));
        strictEqual(JSON.parse(readFileSync(snap.owner_path, 'utf8')).common_dir, realpathSync(join(top, '.git')));
        // What a creation that died before `worktree add` left: the directory
        // and its owner record, no registered worktree.
        git(top, 'worktree', 'remove', '-f', '-f', snap.root);
        ok(existsSync(snap.owner_path));
        const report = await reclaim({ cwd: top, env });
        deepStrictEqual(report.reclaimed.map((r) => r.why), ['interrupted-supervisor-gone-companion-unrecorded']);
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('an interrupted creation\'s orphan branch is deleted with it', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        const parent = mkdtempSync(join(snaps, `${persona}-peer-snapshot-`));
        const branch = `peer-snapshot/${relative(snaps, parent)}`;
        git(top, 'update-ref', `refs/heads/${branch}`, 'HEAD');
        writeFileSync(join(parent, 'owner.json'), JSON.stringify({
          schema: lib.SNAPSHOT_OWNER_SCHEMA, run_id: null, persona, live_toplevel: top, tree: join(parent, 'tree'), branch,
          supervisor: { pid: await deadPid(), fingerprint: { kind: 'none', clock: HERE } }, companion: null, created_at: new Date().toISOString(),
        }));
        const report = await reclaim({ cwd: top, env });
        deepStrictEqual(report.errors, []);
        deepStrictEqual(report.reclaimed.map((r) => r.why), ['interrupted-supervisor-gone-companion-unrecorded']);
        strictEqual(git(top, 'for-each-ref', 'refs/heads/peer-snapshot'), '');
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('a reclaim deletes only the branch a snapshot\'s creation names for it, never another its owner record names (C142)', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        git(top, 'update-ref', 'refs/heads/keep', 'HEAD');
        const registered = withClock(await lib.createPeerSnapshot({ cwd: top, persona, env, supervisorPid: await deadPid() }));
        editOwner(registered, (o) => { o.branch = 'keep'; });
        const parent = mkdtempSync(join(snaps, `${persona}-peer-snapshot-`));
        writeFileSync(join(parent, 'owner.json'), JSON.stringify({
          schema: lib.SNAPSHOT_OWNER_SCHEMA, run_id: null, persona, live_toplevel: top, tree: join(parent, 'tree'), branch: 'keep',
          supervisor: { pid: await deadPid(), fingerprint: { kind: 'none', clock: HERE } }, companion: null, created_at: new Date().toISOString(),
        }));
        const report = await reclaim({ cwd: top, env });
        deepStrictEqual(report.errors, []);
        strictEqual(report.reclaimed.length, 2);
        ok(git(top, 'rev-parse', '--verify', 'refs/heads/keep').trim(), 'the branch the records name stays');
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('a branch that cannot be deleted keeps the owner record, and a later reclaim deletes it', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        const parent = mkdtempSync(join(snaps, `${persona}-peer-snapshot-`));
        const branch = `peer-snapshot/${relative(snaps, parent)}`;
        git(top, 'update-ref', `refs/heads/${branch}`, 'HEAD');
        writeFileSync(join(parent, 'owner.json'), JSON.stringify({
          schema: lib.SNAPSHOT_OWNER_SCHEMA, run_id: null, persona, live_toplevel: top, tree: join(parent, 'tree'), branch,
          supervisor: { pid: await deadPid(), fingerprint: { kind: 'none', clock: HERE } }, companion: null, created_at: new Date().toISOString(),
        }));
        // A ref lock another git process holds makes the deletion fail.
        const lock = join(top, '.git', 'refs', 'heads', `${branch}.lock`);
        writeFileSync(lock, '');
        let report = await reclaim({ cwd: top, env });
        strictEqual(report.reclaimed.length, 0);
        strictEqual(report.errors.length, 1);
        ok(existsSync(join(parent, 'owner.json')), 'the record the retry needs is kept');
        rmSync(lock);
        report = await reclaim({ cwd: top, env });
        deepStrictEqual(report.errors, []);
        deepStrictEqual(report.reclaimed.map((r) => r.why), ['interrupted-supervisor-gone-companion-unrecorded']);
        strictEqual(git(top, 'for-each-ref', 'refs/heads/peer-snapshot'), '');
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('two reclaimers racing remove the snapshot once, without errors', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        withClock(await lib.createPeerSnapshot({ cwd: top, persona, env, supervisorPid: await deadPid() }));
        const [a, b] = await Promise.all([reclaim({ cwd: top, env }), reclaim({ cwd: top, env })]);
        deepStrictEqual([...a.errors, ...b.errors], []);
        strictEqual(snapshotWorktrees(top).length, 0);
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('a worktree locked for another reason, or naming an owner outside its own directory, is not a snapshot', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const other = join(dir, 'other-peer-snapshot-x', 'tree');
        mkdirSync(dirname(other));
        writeFileSync(join(dirname(other), 'owner.json'), '{}');
        git(top, 'worktree', 'add', '-q', '--detach', '--lock', '--reason', `peer-snapshot v1 ${join(dir, 'elsewhere-peer-snapshot-y', 'owner.json')}`, other);
        const report = await reclaim({ cwd: top, env, now: Date.now() + 10 * lib.SNAPSHOT_TTL_MS });
        deepStrictEqual(report.reclaimed, []);
        ok(existsSync(other));
        git(top, 'worktree', 'remove', '-f', '-f', other);
      });
    });
  });

  describe(`${persona}: peer snapshot — whether its run is proven over (C142)`, () => {
    async function deadPid() {
      const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
      await new Promise((r) => child.once('exit', r));
      return child.pid;
    }
    const me = async () => ({ pid: process.pid, fingerprint: await identity.fingerprintForPid(process.pid) });
    // An owner record's other fields, which these cases do not vary.
    const judge = async (owner) => {
      const { verdict, why, supervisor, companion } = await lib.snapshotEnded(owner === null ? null : { live_toplevel: '/r', tree: '/s/tree', ...owner }, { listProcesses: readable });
      return [verdict, why, supervisor, companion];
    };

    it('ended: the supervisor gone and nothing of the companion\'s group left', async () => {
      const gone = { pid: await deadPid(), fingerprint: { kind: 'none', clock: HERE } };
      deepStrictEqual(await judge({ supervisor: gone, companion: null }), ['ended', 'supervisor-gone-nothing-launched', 'gone', null]);
      const companionPid = await deadPid();
      const companion = { pid: companionPid, pgid: companionPid, fingerprint: { kind: 'none' } };
      deepStrictEqual(await judge({ supervisor: gone, companion, launched_at: new Date().toISOString() }), ['ended', 'owners-gone', 'gone', 'gone']);
    });

    it('unknown: a supervisor pid a live process has under another fingerprint, which an incomplete fingerprint or another locale\'s reading also gives (C142, C141)', async () => {
      const fingerprint = (await me()).fingerprint;
      // A fingerprint that differs as a reused pid's would, one recorded
      // incomplete, and one of a kind this platform does not take: each reads
      // `differ` against the live process, this one.
      for (const recorded of [{ ...fingerprint, lstart: 'Thu Jan  1 00:00:00 1970', starttime: '1' }, { kind: fingerprint.kind }, { kind: 'another_platform_kind' }]) {
        const supervisor = { pid: process.pid, fingerprint: recorded };
        strictEqual(await identity.identityState(supervisor), 'differ', JSON.stringify(recorded));
        deepStrictEqual(await judge({ supervisor, companion: null }), ['unknown', 'supervisor-unknown', 'differ', null], JSON.stringify(recorded));
        const companionPid = await deadPid();
        deepStrictEqual(await judge({ supervisor, companion: { pid: companionPid, pgid: companionPid, fingerprint: { kind: 'none' } }, launched_at: new Date().toISOString() }), ['unknown', 'supervisor-unknown', 'differ', 'gone'], JSON.stringify(recorded));
      }
    });

    it('alive: the supervisor runs, or a process of the companion\'s group does', async (t) => {
      deepStrictEqual((await judge({ supervisor: await me(), companion: null })).slice(0, 2), ['alive', 'supervisor-alive']);
      // The companion's leader gone, its child running on in the run's tree.
      const tree = realpathSync(mkdtempSync(join(tmpdir(), 'peer-snapshot-tie-')));
      t.after(() => rmSync(tree, { recursive: true, force: true }));
      const pgid = await leaderlessGroup(t, tree);
      const companion = { pid: pgid, pgid, fingerprint: { kind: 'none' } };
      deepStrictEqual(await judge({ supervisor: { pid: await deadPid(), fingerprint: { kind: 'none', clock: HERE } }, companion, tree }), ['alive', 'companion-alive', 'gone', 'alive']);
    });

    it('unknown: a live group whose leader is gone is the run\'s only while a process of it runs in the run\'s tree, never by its id (C142)', async (t) => {
      const tree = realpathSync(mkdtempSync(join(tmpdir(), 'peer-snapshot-tie-')));
      const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'peer-snapshot-elsewhere-')));
      t.after(() => { rmSync(tree, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); });
      const gone = { pid: await deadPid(), fingerprint: { kind: 'none', clock: HERE } };
      const companionOf = (pgid) => ({ pid: pgid, pgid, fingerprint: { kind: 'none' } });
      // A group another process started under an id that was once the
      // companion's, and left: nothing of it runs in the run's tree.
      const stray = await leaderlessGroup(t, elsewhere);
      strictEqual(await lib.groupTiedToTree(stray, tree), 'untied');
      deepStrictEqual(await judge({ supervisor: gone, companion: companionOf(stray), tree }), ['unknown', 'companion-untied', 'gone', 'alive']);
      // The tree is the one found apart from the record: a record naming
      // a directory every process runs under ties nothing.
      const { verdict, why } = await lib.snapshotEnded({ live_toplevel: '/r', tree: '/', supervisor: gone, companion: companionOf(stray) }, { tree, listProcesses: readable });
      deepStrictEqual([verdict, why], ['unknown', 'companion-untied']);
      // The run's own: a process of it runs in the tree, its path as the
      // record spells it or through a link to it.
      mkdirSync(join(tree, 'sub'));
      const own = await leaderlessGroup(t, join(tree, 'sub'));
      strictEqual(await lib.groupTiedToTree(own, tree), 'tied');
      // Its parent spelled through a link resolves; the tree itself is never
      // followed through one, which could name any directory, `/` included.
      const link = join(elsewhere, 'link');
      symlinkSync(dirname(tree), link);
      strictEqual(await lib.groupTiedToTree(own, join(link, relative(dirname(tree), tree))), 'tied');
      const swapped = join(elsewhere, 'swapped');
      mkdirSync(swapped);
      symlinkSync('/', join(swapped, 'tree'));
      strictEqual(await lib.groupTiedToTree(stray, join(swapped, 'tree')), 'untied');
      symlinkSync(tree, join(swapped, 'tree-link'));
      strictEqual(await lib.groupTiedToTree(own, join(swapped, 'tree-link')), 'untied');
      // Neither a group with no process nor one named with no tree is tied.
      strictEqual(await lib.groupTiedToTree(gone.pid, tree), 'untied');
      strictEqual(await lib.groupTiedToTree(own, null), 'untied');
      strictEqual(groupAlive(stray) && groupAlive(own), true, 'judging signals nothing');
    });

    it('a cwd whose name cannot be read as written ties nothing: lsof\'s escapes, and a "(deleted)" suffix a directory carries itself (C142)', async (t) => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), 'peer-snapshot-names-')));
      t.after(() => rmSync(base, { recursive: true, force: true }));
      // A directory whose name holds a tab, which lsof writes as `\t`; and one
      // literally named with a backslash and a `t`.
      const tabbed = join(base, 'a\tb');
      const literal = join(base, 'a\\tb');
      mkdirSync(tabbed);
      mkdirSync(literal);
      const inTabbed = await leaderlessGroup(t, tabbed);
      // Never tied to the literal one; tied to its own only where the name is
      // read raw (Linux), never through an escape (macOS).
      strictEqual(await lib.groupTiedToTree(inTabbed, literal), 'untied');
      strictEqual(await lib.groupTiedToTree(inTabbed, tabbed), process.platform === 'linux' ? 'tied' : 'untied');
      // Linux marks a removed cwd " (deleted)"; a directory may carry that
      // name itself, and is then read as named.
      const named = join(base, 'tree (deleted)');
      mkdirSync(named);
      strictEqual(await identity.undeletedCwd(named), named);
      strictEqual(await identity.undeletedCwd(join(base, 'gone (deleted)')), join(base, 'gone'));
      strictEqual(await identity.undeletedCwd(join(base, 'tree')), join(base, 'tree'));
    });

    it('unknown, whatever the record\'s age: no record, an identity that cannot be told, a launch never named', async () => {
      deepStrictEqual(await judge(null), ['unknown', 'owner-unreadable', null, null]);
      // A record that names no supervisor proves nothing: a missing pid would read as one gone.
      deepStrictEqual(await judge({ supervisor: null, companion: null }), ['unknown', 'owner-incomplete', null, null]);
      deepStrictEqual(await lib.snapshotEnded({ supervisor: { pid: 1 << 22, fingerprint: { kind: 'none' } }, companion: null }), { verdict: 'unknown', why: 'owner-incomplete', supervisor: null, companion: null });
      strictEqual(await lib.readSnapshotOwner(join(tmpdir(), 'no-such-snapshot', 'owner.json')), null);
      const untold = { pid: process.pid, fingerprint: { kind: 'none' } };
      const old = new Date(Date.now() - 10 * lib.SNAPSHOT_TTL_MS).toISOString();
      deepStrictEqual((await judge({ supervisor: untold, companion: null, created_at: old })).slice(0, 2), ['unknown', 'supervisor-unknown']);
      const gone = { pid: await deadPid(), fingerprint: { kind: 'none', clock: HERE } };
      deepStrictEqual((await judge({ supervisor: gone, companion: null, launched_at: old, created_at: old })).slice(0, 2), ['unknown', 'launch-unrecorded']);
      deepStrictEqual((await judge({ supervisor: gone, companion: { pid: process.pid, pgid: process.pid, fingerprint: { kind: 'none' } } })).slice(0, 2), ['unknown', 'companion-unknown']);
    });

    it('unknown: a live group under a companion pid whose process cannot be told is no proof it is the run\'s (C142)', async (t) => {
      // A process of no run's, leading a group of its own under the pid a record names.
      const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', detached: true });
      t.after(() => killGroup(other.pid));
      ok(alive(other.pid) && groupAlive(other.pid));
      const gone = { pid: await deadPid(), fingerprint: { kind: 'none', clock: HERE } };
      deepStrictEqual(await judge({ supervisor: gone, companion: { pid: other.pid, pgid: other.pid, fingerprint: { kind: 'none' } } }), ['unknown', 'companion-unknown', 'gone', 'alive']);
    });

    it('unknown: a companion named without its pid and group, or with a group it does not lead, proves nothing (C142)', async () => {
      const gone = { pid: await deadPid(), fingerprint: { kind: 'none', clock: HERE } };
      const dead = await deadPid();
      for (const companion of [{ pid: dead, pgid: null, fingerprint: { kind: 'none' } }, { pid: dead, fingerprint: { kind: 'none' } }, { pid: String(dead), pgid: dead, fingerprint: { kind: 'none' } }, { pid: dead, pgid: 0 }, { pid: dead, pgid: gone.pid, fingerprint: { kind: 'none' } }, 'companion', false]) {
        deepStrictEqual(await judge({ supervisor: gone, companion }), ['unknown', 'owner-incomplete', null, null], JSON.stringify(companion));
      }
      // Named in full, the same dead companion reads gone.
      deepStrictEqual(await judge({ supervisor: gone, companion: { pid: dead, pgid: dead, fingerprint: { kind: 'none' } }, launched_at: new Date().toISOString() }), ['ended', 'owners-gone', 'gone', 'gone']);
    });

    it('unknown: a pid past the range a pid takes names no process, and is never read as one gone (C142)', async () => {
      const dead = await deadPid();
      // Nor is init's pid one a run's process has: its group, 1, is no run's.
      for (const pid of [1, 2 ** 31, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
        deepStrictEqual(await judge({ supervisor: { pid, fingerprint: { kind: 'none' } }, companion: null }), ['unknown', 'owner-incomplete', null, null], String(pid));
        deepStrictEqual(await judge({ supervisor: { pid: dead, fingerprint: { kind: 'none' } }, companion: { pid, pgid: pid, fingerprint: { kind: 'none' } } }), ['unknown', 'owner-incomplete', null, null], String(pid));
      }
    });

    it('unknown: an owner record that omits the companion its run\'s handle names, or names another, proves nothing, whatever its launch says (C142)', async () => {
      const gone = { pid: await deadPid(), fingerprint: { kind: 'none', clock: HERE } };
      const dead = await deadPid();
      const another = await deadPid();
      const companion = { pid: dead, pgid: dead, fingerprint: { kind: 'none' } };
      const judgeWith = async (owner, handle) => {
        const { verdict, why } = await lib.snapshotEnded({ live_toplevel: '/r', tree: '/s/tree', ...owner }, { handle, listProcesses: readable });
        return [verdict, why];
      };
      const launched = new Date().toISOString();
      for (const [owner, handle] of [
        [{ supervisor: gone, companion: null }, { pid: dead, pgid: dead }],
        [{ supervisor: gone, companion: null, launched_at: launched }, { pid: dead, pgid: dead }],
        [{ supervisor: gone }, { pid: dead, pgid: dead }],
        [{ supervisor: gone, companion: { pid: another, pgid: another, fingerprint: { kind: 'none' } }, launched_at: launched }, { pid: dead, pgid: dead }],
      ]) {
        deepStrictEqual(await judgeWith(owner, handle), ['unknown', 'owner-incomplete'], JSON.stringify([owner.companion, handle]));
      }
      // A handle whose process fields the runner did not write (a group
      // without its pid, or one it does not lead; a pid past the range, or
      // init's; a field of another type; a kept peer process the live fields
      // disagree with) proves nothing, and is never read as one naming none.
      for (const handle of [
        { pid: null, pgid: dead },
        // A pid without its group: the runner records the group it leads (on
        // Windows none, where no run is proven over).
        ...(process.platform === 'win32' ? [] : [{ pid: dead, pgid: null }]),
        // A kept peer process that names no pid.
        { pid: dead, pgid: dead, peer_process: {} },
        { pid: null, pgid: null, peer_process: { pid: null, pgid: null } },
        { pid: null, pgid: null, peer_process: { pgid: dead } },
        { pid: dead, pgid: another },
        { pid: 2 ** 32, pgid: 2 ** 32 },
        { pid: 1, pgid: 1 },
        { pid: dead, pgid: String(dead) },
        { pid: null, pgid: null, peer_process: { pid: String(dead), pgid: dead } },
        { pid: null, pgid: null, peer_process: { pid: dead, pgid: 1 } },
        { pid: null, pgid: null, peer_process: [dead, dead] },
        { pid: null, pgid: null, peer_process: dead },
        { pid: another, pgid: another, peer_process: { pid: dead, pgid: dead } },
      ]) {
        deepStrictEqual(await judgeWith({ supervisor: gone, companion, launched_at: launched }, handle), ['unknown', 'handle-malformed'], JSON.stringify(handle));
        deepStrictEqual(await judgeWith({ supervisor: gone, companion: null }, handle), ['unknown', 'handle-malformed'], JSON.stringify(handle));
        deepStrictEqual(lib.handlePeerProcess(handle), { malformed: true }, JSON.stringify(handle));
      }
      deepStrictEqual(lib.handlePeerProcess({ pid: null, pgid: null, peer_process: { pid: dead, pgid: dead } }), { pid: dead, pgid: dead });
      strictEqual(lib.handlePeerProcess({ pid: null, pgid: null }), null);
      // Group 1 is init's: no group of a run's, and `kill(-1, 0)` would read
      // as alive whatever runs.
      strictEqual(identity.isGroupAlive(1), false);
      // The handle and the record naming one companion, or a handle that
      // names none (a terminal write cleared it), judge as the record alone.
      deepStrictEqual(await judgeWith({ supervisor: gone, companion, launched_at: launched }, { pid: dead, pgid: dead }), ['ended', 'owners-gone']);
      deepStrictEqual(await judgeWith({ supervisor: gone, companion: null }, { pid: null, pgid: null }), ['ended', 'supervisor-gone-nothing-launched']);
      deepStrictEqual(await judgeWith({ supervisor: gone, companion: null }, null), ['ended', 'supervisor-gone-nothing-launched']);
      // The peer process a handle keeps past the writes that clear its pid
      // and pgid is the evidence then (one that names no pid is refused
      // above).
      const kept = { pid: null, pgid: null, peer_process: { pid: dead, pgid: dead } };
      deepStrictEqual(await judgeWith({ supervisor: gone, companion: null }, kept), ['unknown', 'owner-incomplete']);
      deepStrictEqual(await judgeWith({ supervisor: gone, companion: { pid: another, pgid: another, fingerprint: { kind: 'none' } }, launched_at: launched }, kept), ['unknown', 'owner-incomplete']);
      deepStrictEqual(await judgeWith({ supervisor: gone, companion, launched_at: launched }, kept), ['ended', 'owners-gone']);
    });

    it('unknown: a process left in the run\'s tree outside its companion\'s group keeps the run from being over, its tree removed or not, and the reclaim keeps the snapshot until it is old (C142 M-F1)', async (t) => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), 'peer-snapshot-occupied-')));
      t.after(() => rmSync(base, { recursive: true, force: true }));
      const tree = join(base, 'tree');
      mkdirSync(join(tree, 'sub'), { recursive: true });
      const gone = { pid: await deadPid(), fingerprint: { kind: 'none', clock: HERE } };
      const dead = await deadPid();
      const owner = { live_toplevel: '/r', tree: '/s/tree', supervisor: gone, companion: { pid: dead, pgid: dead, fingerprint: { kind: 'none' } }, launched_at: new Date().toISOString(), created_at: new Date().toISOString() };
      const judgeIn = async () => {
        const { verdict, why, supervisor, companion } = await lib.snapshotEnded(owner, { tree, listProcesses: readable });
        return [verdict, why, supervisor, companion];
      };
      strictEqual(await lib.treeOccupancy(tree, { supervisor: gone, listProcesses: readable }), 'none');
      deepStrictEqual(await judgeIn(), ['ended', 'owners-gone', 'gone', 'gone']);
      deepStrictEqual(await lib.judgeSnapshot(owner, { tree, listProcesses: readable }), { verdict: 'reclaim', why: 'owners-gone' });
      // A process the companion started in a group of its own, its cwd in
      // the tree: the companion's group has ended, and it runs on.
      const own = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { cwd: join(tree, 'sub'), stdio: 'ignore', detached: true });
      t.after(() => killGroup(own.pid));
      await waitFor(async () => (await lib.treeOccupancy(tree, { supervisor: gone })) === 'occupied', { message: 'the process to run in the tree' });
      deepStrictEqual(await judgeIn(), ['unknown', 'tree-occupied', 'gone', 'gone']);
      // The record's own tree is not the one judged: the tree found apart
      // from it is.
      strictEqual(await lib.treeOccupancy(owner.tree, { supervisor: gone, listProcesses: readable }), 'none');
      // The reclaim keeps it as an identity it cannot tell: until it is old.
      deepStrictEqual(await lib.judgeSnapshot(owner, { tree }), { verdict: 'keep', why: 'tree-occupied' });
      deepStrictEqual(await lib.judgeSnapshot(owner, { tree, ttlMs: 0, now: Date.now() + 1000 }), { verdict: 'reclaim', why: 'tree-occupied-expired' });
      // A removed tree is no proof: the process runs on in it.
      rmSync(tree, { recursive: true, force: true });
      strictEqual(await lib.treeOccupancy(tree, { supervisor: gone }), 'occupied');
      deepStrictEqual(await judgeIn(), ['unknown', 'tree-occupied', 'gone', 'gone']);
      ok(alive(own.pid), 'judging signals nothing');
      // No tree named is none that can be read.
      strictEqual(await lib.treeOccupancy(null), 'unknown');
      killGroup(own.pid);
      await waitFor(() => !alive(own.pid), { message: 'the process to end' });
      deepStrictEqual(await judgeIn(), ['ended', 'owners-gone', 'gone', 'gone']);
    });

    it('a tree is never read empty from a listing that failed, or past a process of the user\'s own whose directory the system denies (C142 M-F1)', async (t) => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), 'peer-snapshot-unread-')));
      t.after(() => rmSync(base, { recursive: true, force: true }));
      const tree = join(base, 'tree');
      mkdirSync(tree);
      const occupancy = (listed) => lib.treeOccupancy(tree, { listProcesses: async () => listed });
      const elsewhere = { pid: 2, cwd: base, raw: base };
      strictEqual(await occupancy([elsewhere]), 'none');
      // One that may run anywhere: the tree is not proven empty, and nothing
      // is read as the run's.
      strictEqual(await occupancy([elsewhere, { pid: 3, cwd: null, raw: null, unreadable: true }]), 'unknown');
      // One read in the tree still decides.
      strictEqual(await occupancy([{ pid: 3, cwd: null, raw: null, unreadable: true }, { pid: 4, cwd: tree, raw: tree }]), 'occupied');
      // Another user's, which no listing reads, is no such process.
      strictEqual(await occupancy([elsewhere, { pid: 5, cwd: null, raw: null }]), 'none');
      strictEqual(await occupancy(null), 'unknown');
      // The listing itself, in a child with its own PATH: on macOS an lsof
      // that does not list its reader failed, whatever it exits. So does one
      // that lists some processes and exits 1 (C142 N-F1).
      if (process.platform === 'darwin') {
        const bin = join(base, 'bin');
        mkdirSync(bin);
        const listing = () => spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(pathToFileURL(P.path('scripts/lib/process-identity.mjs')).href)}); console.log(JSON.stringify({ pid: process.pid, listed: await m.allProcessCwds() }));`], { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
        // The ps the listing checks lsof's against lists the reader alone,
        // and only when asked in UTC and the C locale, whose start times it
        // reads.
        writeFileSync(join(bin, 'ps'), `#!/bin/sh\n[ "$LC_ALL" = C ] && [ "$TZ" = UTC0 ] || exit 1\nprintf '%s 1 %s Ss Wed Oct 21 14:00:00 2026\\n' "$PPID" "$(id -u)"\n`, { mode: 0o755 });
        for (const script of ['#!/bin/sh\nexit 1\n', '#!/bin/sh\nexit 0\n', `#!/bin/sh\nprintf 'p%s\\nn/\\n' "$PPID"\nexit 1\n`, `#!/bin/sh\nprintf 'p1\\nn/\\n'\nexit 0\n`]) {
          writeFileSync(join(bin, 'lsof'), script, { mode: 0o755 });
          const probe = listing();
          strictEqual(probe.status, 0, probe.stderr);
          strictEqual(JSON.parse(probe.stdout).listed, null, script);
        }
        // Control: the same partial listing, exiting 0, is read.
        writeFileSync(join(bin, 'lsof'), `#!/bin/sh\nprintf 'p%s\\nn/\\n' "$PPID"\nexit 0\n`, { mode: 0o755 });
        const read = JSON.parse(listing().stdout);
        deepStrictEqual(read.listed, [{ pid: read.pid, cwd: '/', raw: '/' }]);
      }
    });

    // An injected system, as identity's listing reads it. macOS: `spawnSync`
    // answers each tool's run, and the reader is pid 1, of uid 501. Linux: a
    // /proc of `procs`, each { pid, cwd, tasks, uid, starttime, ppid, pgrp,
    // gone, threads }, where a cwd is a path or the error its read gives
    // ('EACCES', 'ENOENT'), `tasks` maps each thread to its cwd (the main
    // thread alone, by default), `threads` is the count its status reads (one
    // for each of `tasks` by default), `ppid` is its parent (1 by default; a list gives one for
    // each read of its stat, then its last), `nspid` its status's NSpid (its
    // pid alone by default; null for none), and `gone` is a pid listed that
    // has exited; the reader is pid 1 (init, its cwd /, started at 1), listed
    // after them, or none when `reader` is null, and `/proc/self` names it
    // unless `self` says otherwise; `/proc/self/mountinfo` reads `mountinfo`,
    // a /proc that hides nothing unless the case says otherwise. /proc also
    // lists `self`, `sys` and the file `uptime`, below which a read answers
    // ENOTDIR, as the real one's does.
    const failing = (code) => Object.assign(new Error(code), { code });
    const darwinSystem = (spawnSync, { now = () => 0, uptime = () => 0 } = {}) => ({ platform: 'darwin', pid: 1, getuid: () => 501, env: {}, spawnSync, now, uptime });
    const CLOCK = 'boot-a/time:[1]/pid:[1]';
    const PROC_MOUNT = '22 1 0:20 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw';
    const MOUNTINFO = `1 0 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n${PROC_MOUNT}\n`;
    const linuxSystem = (procs, { uid = 1000, boot = 'boot-a', timeNamespace = 'time:[1]', pidNamespace = 'pid:[1]', reader = 1, self = String(reader), mountinfo = MOUNTINFO } = {}) => {
      const all = reader === null || procs.some((p) => p.pid === reader) ? procs : [...procs, { pid: reader, cwd: '/', ppid: 0, starttime: 1 }];
      const proc = (pid) => all.find((p) => String(p.pid) === pid && !p.gone);
      const tasksOf = (p) => p.tasks ?? { [p.pid]: p.cwd };
      const statReads = new Map();
      const ppidOf = (p) => {
        if (!Array.isArray(p.ppid)) return p.ppid ?? 1;
        const n = statReads.get(p.pid) ?? 0;
        statReads.set(p.pid, n + 1);
        return p.ppid[Math.min(n, p.ppid.length - 1)];
      };
      const read = (v) => {
        if (v === 'EACCES' || v === 'ENOENT') throw failing(v);
        return v;
      };
      return {
        platform: 'linux',
        pid: reader,
        getuid: () => uid,
        readdir: async (path) => {
          const [, pid, sub] = path.split('/').filter(Boolean);
          if (pid === undefined) return [...all.map((p) => String(p.pid)), 'self', 'sys', 'uptime'];
          if (pid === 'uptime') throw failing('ENOTDIR');
          const p = proc(pid);
          if (!p || sub !== 'task') throw failing('ENOENT');
          return Object.keys(tasksOf(p));
        },
        readFile: async (path) => {
          if (path === '/proc/sys/kernel/random/boot_id') return `${read(boot)}\n`;
          if (path === '/proc/self/mountinfo') return read(mountinfo);
          const [, pid, file] = path.split('/').filter(Boolean);
          if (pid === 'uptime') throw failing('ENOTDIR');
          const p = proc(pid);
          if (!p) throw failing('ENOENT');
          const group = p.pgrp ?? p.pid;
          if (file === 'stat') return `${p.pid} (a b) S ${ppidOf(p)} ${group} ${group} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${p.starttime ?? 100} 0 0`;
          if (file === 'status') return `Name:\ta\nUid:\t${p.uid ?? uid}\t${p.uid ?? uid}\t0\t0\nThreads:\t${p.threads ?? Object.keys(tasksOf(p)).length}\n${p.nspid === null ? '' : `NSpid:\t${(p.nspid ?? [p.pid]).join('\t')}\n`}`;
          throw failing('ENOENT');
        },
        readlink: async (path) => {
          if (path === '/proc/self/ns/time') return read(timeNamespace);
          if (path === '/proc/self/ns/pid') return read(pidNamespace);
          if (path === '/proc/self') return read(self);
          const [, pid, sub, tid] = path.split('/').filter(Boolean);
          if (pid === 'uptime') throw failing('ENOTDIR');
          const p = proc(pid);
          if (!p) throw failing('ENOENT');
          if (sub === 'cwd') return read(p.cwd);
          return read(tasksOf(p)[tid] ?? 'ENOENT');
        },
        stat: async () => {
          throw failing('ENOENT');
        },
      };
    };
    const READER = { pid: 1, cwd: '/', raw: '/' };

    // macOS answers: `answers` keyed by the command run, `<cmd> table` for
    // the process table (`ps … lstart=`) and `<cmd> -p` for an lsof of a pid
    // list where the case sets one; a list gives one answer for each run,
    // then its last. A table row is [pid, ppid, ruid, lstart, state].
    const calls = [];
    const answering = (answers) => {
      const runs = new Map();
      return darwinSystem((cmd, args) => {
        calls.push([cmd, ...args]);
        const keys = [...(args.includes('pid=,ppid=,ruid=,stat=,lstart=') ? [`${cmd} table`] : []), ...(args.includes('-p') ? [`${cmd} -p`] : []), cmd];
        const key = keys.find((k) => Object.hasOwn(answers, k));
        if (key === undefined) return { error: failing('ENOENT'), status: null, stdout: null };
        if (!Array.isArray(answers[key])) return answers[key];
        const n = runs.get(key) ?? 0;
        runs.set(key, n + 1);
        return answers[key][Math.min(n, answers[key].length - 1)];
      });
    };
    const table = (rows, pid = 99) => ({ status: 0, pid, stdout: rows.map(([p, pp, uid, when, state = 'S']) => `  ${p}  ${pp}  ${uid} ${state} ${when}\n`).join('') });
    const at = (lstart) => String(Date.parse(`${lstart.slice(4)} UTC`) / 1000);
    const sysctl = { status: 0, stdout: '{ sec = 1000, usec = 5 } Wed Oct 21 00:00:00 2026\n' };
    const DARWIN_CLOCK = 'darwin-boot/1000.5';

    it('a listing of every process counts as complete on macOS only when lsof exits 0 and lists its reader; a pid list\'s exit 1 still stands (C142 N-F1)', async () => {
      const rows = [[1, 0, 501, 'Wed Oct 21 12:00:00 2026'], [2, 1, 501, 'Wed Oct 21 12:00:00 2026'], [3, 1, 501, 'Wed Oct 21 12:00:00 2026']];
      const partial = { status: 1, stdout: 'p1\nn/\np2\nn/x\n' };
      strictEqual(await identity.allProcessCwds({ clock: CLOCK, system: answering({ lsof: partial, 'ps table': table(rows) }) }), null);
      // One that exits 0 and does not list its reader failed too.
      strictEqual(await identity.allProcessCwds({ clock: CLOCK, system: answering({ lsof: { status: 0, stdout: '' }, 'ps table': table(rows) }) }), null);
      strictEqual(await identity.allProcessCwds({ clock: CLOCK, system: answering({ lsof: { status: 0, stdout: 'p2\nn/x\np3\nn/\n' }, 'ps table': table(rows) }) }), null);
      // A name that is no path is lsof's report of a directory it could not
      // read (F2, refine-verify of the seventh review): that process may run
      // anywhere, and the tree is not proven empty.
      const errorName = { status: 0, stdout: 'p1\nn/\np3\nncwd info error: Operation not permitted\n' };
      const placing = { starttime: at(rows[2][3]), clock: DARWIN_CLOCK, ancestors: [{ pid: 1, starttime: at(rows[0][3]) }] };
      deepStrictEqual(await identity.allProcessCwds({ clock: CLOCK, system: answering({ lsof: errorName, 'ps table': table(rows.slice(0, 1).concat([rows[2]])), sysctl }) }), [READER, { pid: 3, cwd: null, raw: 'cwd info error: Operation not permitted', unreadable: true, ...placing }]);
      strictEqual(await lib.treeOccupancy('/tmp/engineer-peer-snapshot-x/tree', { listProcesses: () => identity.allProcessCwds({ clock: CLOCK, system: answering({ lsof: errorName, 'ps table': table([rows[0], rows[2]]), sysctl }) }) }), 'unknown');
      deepStrictEqual(await identity.allProcessCwds({ clock: CLOCK, system: answering({ lsof: { ...partial, status: 0 }, 'ps table': table(rows.slice(0, 2)) }) }), [READER, { pid: 2, cwd: '/x', raw: '/x' }]);
      // A pid list exits 1 when a process of it has exited since: the others stand.
      const ps = { status: 0, stdout: '  5 7\n  6 7\n  8 9\n' };
      deepStrictEqual(await identity.groupMemberCwds(7, { system: answering({ ps, lsof: { status: 1, stdout: 'p5\nn/x\n' } }) }), [{ pid: 5, cwd: '/x', raw: '/x' }, { pid: 6, cwd: null, raw: null }]);
      strictEqual(await identity.groupMemberCwds(7, { system: answering({ ps, lsof: { status: 2, stdout: 'p5\nn/x\n' } }) }), null);
      // A PATH without the tools reads them where macOS keeps them, with the
      // same arguments; lsof never blocks on a call or warns.
      calls.length = 0;
      deepStrictEqual(await identity.groupMemberCwds(7, { system: answering({ '/bin/ps': ps, '/usr/sbin/lsof': { status: 0, stdout: 'p5\nn/x\np6\nn/y\n' } }) }), [{ pid: 5, cwd: '/x', raw: '/x' }, { pid: 6, cwd: '/y', raw: '/y' }]);
      deepStrictEqual(calls.map(([cmd]) => cmd), ['ps', '/bin/ps', 'lsof', '/usr/sbin/lsof']);
      deepStrictEqual(calls[2], calls[3].map((a, i) => (i === 0 ? 'lsof' : a)));
      ok(calls[3].includes('-b') && calls[3].includes('-w'), JSON.stringify(calls[3]));
    });

    it('on macOS, every process of the user\'s own that lsof leaves out (one set-uid, or started after it read the table) is read again until no round meets a new one, and listed unreadable unless it is read or has exited; a record with no name is unreadable (C142 O-F3)', async () => {
      const noon = 'Wed Oct 21 12:00:00 2026';
      const one = 'Wed Oct 21 13:00:00 2026';
      const two = 'Wed Oct 21 14:00:00 2026';
      // The reader 1, a shell 4, a sudo 5 it started, another user's 6, a
      // process 7 lsof did not read and reads now, one 8 that exits before
      // it is read again, one 9 lsof names no directory for, and the ps run
      // itself (99).
      const rows = [[1, 0, 501, noon], [4, 1, 501, one], [5, 4, 501, two], [6, 1, 0, noon], [7, 1, 501, two], [8, 1, 501, two], [9, 1, 501, noon], [99, 1, 501, two]];
      const lsof = { status: 0, stdout: 'p1\nn/\np4\nn/home\np9\n' };
      const answers = { lsof, 'lsof -p': { status: 1, stdout: 'p7\nn/w\n' }, 'ps table': [table(rows), table(rows.filter(([p]) => p !== 8 && p !== 99), 98)], sysctl };
      calls.length = 0;
      const listed = await identity.allProcessCwds({ clock: CLOCK, system: answering(answers) });
      const unread = (pid, lstart, ancestors) => ({ pid, cwd: null, raw: null, unreadable: true, starttime: at(lstart), clock: DARWIN_CLOCK, ancestors });
      deepStrictEqual(listed, [READER, { pid: 4, cwd: '/home', raw: '/home' }, unread(9, noon, [{ pid: 1, starttime: at(noon) }]), { pid: 7, cwd: '/w', raw: '/w' }, unread(5, two, [{ pid: 4, starttime: at(one) }, { pid: 1, starttime: at(noon) }])]);
      // lsof reads again exactly the processes it left out, and ps runs after
      // each lsof, in UTC and the C locale; a round that meets none it had not
      // met is the last.
      deepStrictEqual(calls.map(([cmd, ...args]) => [cmd, args.includes('-p') ? args[args.indexOf('-p') + 1] : null]), [['lsof', null], ['ps', null], ['lsof', '5,7,8'], ['ps', null], ['sysctl', null]]);
      // A pid ps lists again under another start time is another process's
      // since, which lsof has not read: it is read again, and unreadable.
      const reused = await identity.allProcessCwds({ clock: CLOCK, system: answering({ ...answers, 'ps table': [table(rows), table(rows.filter(([p]) => p !== 8).map((r) => (r[0] === 5 ? [5, 4, 501, 'Wed Oct 21 15:00:00 2026'] : r)))] }) });
      deepStrictEqual(reused.map((m) => [m.pid, m.starttime ?? null]), [[1, null], [4, null], [9, at(noon)], [7, null], [5, at('Wed Oct 21 15:00:00 2026')]]);
      // A ps or a second lsof that fails leaves the listing unproved.
      for (const failed of [{ 'ps table': { status: 1, stdout: '' } }, { 'ps table': [table(rows), { status: 1, stdout: '' }] }, { 'ps table': { status: 0, stdout: 'garbled\n' } }, { 'lsof -p': { status: 2, stdout: '' } }]) {
        strictEqual(await identity.allProcessCwds({ clock: CLOCK, system: answering({ ...answers, ...failed }) }), null, JSON.stringify(failed));
      }
      // The sudo is placed outside a run whose supervisor started after its
      // shell, which is no ancestor of the supervisor's, and outside one whose
      // supervisor runs under that shell too (macOS gives no orphan to the
      // shell: C142 P-F4); it is not placed in another boot time.
      const tree = '/tmp/engineer-peer-snapshot-x/tree';
      const supervisor = (ancestors, clock = DARWIN_CLOCK) => ({ pid: 50, fingerprint: { kind: 'macos_lstart_command', lstart: 'x', command: 'y', starttime: at('Wed Oct 21 13:30:00 2026'), clock, ancestors } });
      const occupancy = (judgedFor, given = { ...answers, lsof: { status: 0, stdout: 'p1\nn/\np4\nn/home\n' } }) => lib.treeOccupancy(tree, { supervisor: judgedFor, listProcesses: () => identity.allProcessCwds({ clock: CLOCK, system: answering(given) }) });
      strictEqual(await occupancy(supervisor([{ pid: 1, starttime: at(noon) }])), 'none');
      strictEqual(await occupancy(supervisor([{ pid: 4, starttime: at(one) }, { pid: 1, starttime: at(noon) }])), 'none');
      strictEqual(await occupancy(supervisor([{ pid: 1, starttime: at(noon) }], 'darwin-boot/1000.4')), 'unknown');
      // An orphan left to launchd is not placed by it, whatever ancestors the
      // supervisor recorded (F5, refine-verify of the eighth review).
      const orphaned = { lsof: { status: 0, stdout: 'p1\nn/\n' }, 'lsof -p': { status: 1, stdout: '' }, 'ps table': table([[1, 0, 501, noon], [70, 1, 501, two]]), sysctl };
      strictEqual(await occupancy(supervisor([]), orphaned), 'unknown');
      // A zombie runs nowhere: its directory went with its exit, though lsof
      // cannot read it.
      const zombie = { ...orphaned, 'ps table': table([[1, 0, 501, noon], [70, 1, 501, two, 'Z']]) };
      strictEqual(await occupancy(supervisor([]), zombie), 'none');
      deepStrictEqual(await identity.allProcessCwds({ clock: CLOCK, system: answering(zombie) }), [READER]);
      // A process that starts while lsof reads again (60 forks 61 and exits,
      // F1 of the same review) is read in its turn: in the tree it occupies
      // it, and one lsof never names is unreadable.
      const forked = (named) => ({ lsof: { status: 0, stdout: 'p1\nn/\n' }, 'lsof -p': [{ status: 1, stdout: '' }, named], 'ps table': [table([[1, 0, 501, noon], [60, 1, 501, two]]), table([[1, 0, 501, noon], [61, 1, 501, two]])], sysctl });
      strictEqual(await occupancy(supervisor([{ pid: 1, starttime: at(noon) }]), forked({ status: 0, stdout: `p61\nn${tree}/sub\n` })), 'occupied');
      strictEqual(await occupancy(supervisor([{ pid: 1, starttime: at(noon) }]), forked({ status: 1, stdout: '' })), 'unknown');
      strictEqual(await identity.clockDomain({ system: answering({ sysctl }) }), DARWIN_CLOCK);
      strictEqual(await identity.clockDomain({ system: answering({ sysctl: { status: 0, stdout: 'garbled' } }) }), null);
      strictEqual(await identity.clockDomain({ system: answering({ sysctl: { status: 0, stdout: '{ sec = 1000 }' } }) }), null);
      // The lineage a snapshot records for its supervisor, from one table.
      deepStrictEqual(await identity.processLineage(5, { system: answering({ 'ps table': table(rows), sysctl }) }), { starttime: at(two), clock: DARWIN_CLOCK, ancestors: [{ pid: 4, starttime: at(one) }, { pid: 1, starttime: at(noon) }] });
      strictEqual(await identity.processLineage(42, { system: answering({ 'ps table': table(rows), sysctl }) }), null);
      // The reader's own start time is kept only when its uptime dates its
      // start to that second (F4 of the same review): a wall clock set back
      // since it started gives none.
      const reader = (uptime) => identity.processLineage(1, { system: { ...answering({ 'ps table': table(rows), sysctl }), now: () => (Number(at(noon)) + 10.5) * 1000, uptime: () => uptime } });
      strictEqual((await reader(10)).starttime, at(noon));
      strictEqual((await reader(30)).starttime, null);
      strictEqual((await reader(8)).starttime, null);
    });

    it('on macOS, a hidden process whose ancestors reach one of the supervisor\'s other than launchd before the supervisor\'s pid is placed outside the run: a new terminal tab\'s set-uid login (C142 P-F4)', async () => {
      const tree = '/tmp/engineer-peer-snapshot-x/tree';
      const noon = 'Wed Oct 21 12:00:00 2026';
      const one = 'Wed Oct 21 13:00:00 2026';
      const two = 'Wed Oct 21 14:00:00 2026';
      // The supervisor 340 (13:30) runs under claude 330, its shell 320, the
      // set-uid login 310 of the tab it was started in, and the terminal 300.
      // The user then opens a tab: its login 400 (set-uid, so lsof leaves it
      // out) runs under the terminal. A process 410 lsof cannot read runs
      // under the supervisor, and 420 was left to launchd.
      const sup = { pid: 340, fingerprint: { kind: 'macos_lstart_command', lstart: 'x', command: 'y', starttime: at('Wed Oct 21 13:30:00 2026'), clock: DARWIN_CLOCK, ancestors: [{ pid: 330, starttime: at(one) }, { pid: 320, starttime: at(one) }, { pid: 310, starttime: at(one) }, { pid: 300, starttime: at(noon) }, { pid: 1, starttime: at(noon) }] } };
      const rows = [[1, 0, 501, noon], [300, 1, 501, noon], [310, 300, 501, one], [320, 310, 501, one], [330, 320, 501, one], [340, 330, 501, 'Wed Oct 21 13:30:00 2026']];
      const lsof = { status: 0, stdout: 'p1\nn/\np300\nn/\np320\nn/home\np330\nn/home/repo\np340\nn/home/repo\n' };
      const occupancy = (hidden, judgedFor = sup) => lib.treeOccupancy(tree, {
        supervisor: judgedFor,
        listProcesses: () => identity.allProcessCwds({ clock: CLOCK, system: answering({ lsof, 'lsof -p': { status: 1, stdout: '' }, 'ps table': table([...rows, hidden]), sysctl }) }),
      });
      const login = [400, 300, 501, two];
      // The earlier tab's login 310 started before the supervisor: placed by
      // its start time. The new tab's is placed through the terminal.
      strictEqual(await occupancy(login), 'none');
      // Not placed: one under the supervisor, whatever runs above it, one
      // left to launchd, and the login of a terminal started since, which is
      // no ancestor of the supervisor's.
      strictEqual(await occupancy([410, 340, 501, two]), 'unknown');
      strictEqual(await occupancy([420, 1, 501, two]), 'unknown');
      const later = { lsof: { status: 0, stdout: `${lsof.stdout}p350\nn/\n` }, 'lsof -p': { status: 1, stdout: '' }, 'ps table': table([...rows, [350, 1, 501, two], [400, 350, 501, two]]), sysctl };
      strictEqual(await lib.treeOccupancy(tree, { supervisor: sup, listProcesses: () => identity.allProcessCwds({ clock: CLOCK, system: answering(later) }) }), 'unknown');
      // Linux keeps its rule: a recorded ancestor there may be a subreaper,
      // which adopts what the run leaves, so the same lineage places nothing.
      const linuxSup = { pid: 340, fingerprint: { kind: 'linux_proc_starttime', starttime: '1000', command: 'node peer-runner.mjs', clock: CLOCK, ancestors: [{ pid: 330, starttime: '900' }, { pid: 300, starttime: '60' }, { pid: 1, starttime: '1', reaper: true }] } };
      const linuxMachine = [{ pid: 300, cwd: '/', starttime: 60 }, { pid: 330, cwd: '/home/repo', ppid: 300, starttime: 900 }, { pid: 400, cwd: 'EACCES', ppid: 300, starttime: 1500 }];
      strictEqual(await lib.treeOccupancy(tree, { supervisor: linuxSup, listProcesses: () => identity.allProcessCwds({ clock: CLOCK, system: linuxSystem(linuxMachine) }) }), 'unknown');
      // The judgments place it by the owner record's supervisor: with the new
      // tab open, a run whose supervisor is gone is proven over.
      const owner = { supervisor: { ...sup, pid: await deadPid() }, live_toplevel: '/r', tree, companion: null, created_at: new Date().toISOString() };
      const listing = (hidden) => () => identity.allProcessCwds({ clock: CLOCK, system: answering({ lsof, 'lsof -p': { status: 1, stdout: '' }, 'ps table': table([...rows, hidden]), sysctl }) });
      deepStrictEqual((await lib.snapshotEnded(owner, { tree, listProcesses: listing(login) })).verdict, 'ended');
      deepStrictEqual((await lib.snapshotEnded(owner, { tree, listProcesses: listing([420, 1, 501, two]) })).why, 'tree-unknown');
    });

    it('on Linux, a process whose main thread has exited runs on in its other threads\' directories, and only one with no thread left is gone (C142 N-F2)', async () => {
      const tree = '/tmp/engineer-peer-snapshot-x/tree';
      const listed = (procs) => identity.allProcessCwds({ clock: CLOCK, system: linuxSystem(procs) });
      // The main thread's link is gone, a thread runs on in the tree.
      const leaderless = { pid: 40, cwd: 'ENOENT', tasks: { 40: 'ENOENT', 41: `${tree}/sub`, 42: `${tree}/sub` } };
      deepStrictEqual(await listed([leaderless]), [{ pid: 40, cwd: `${tree}/sub`, raw: `${tree}/sub` }, READER]);
      strictEqual(await lib.treeOccupancy(tree, { listProcesses: () => listed([leaderless]) }), 'occupied');
      // The group's listing reads it the same way: it ties the group.
      deepStrictEqual(await identity.groupMemberCwds(40, { system: linuxSystem([leaderless, { pid: 50, cwd: '/' }]) }), [{ pid: 40, cwd: `${tree}/sub`, raw: `${tree}/sub` }]);
      // Its threads denied (one of the user's own, not dumpable): unreadable.
      const placing = { clock: CLOCK, ancestors: [{ pid: 1, starttime: '1', reaper: true }] };
      deepStrictEqual(await listed([{ pid: 40, cwd: 'ENOENT', tasks: { 40: 'ENOENT', 41: 'EACCES' }, starttime: 700 }]), [{ pid: 40, cwd: null, raw: null, unreadable: true, starttime: '700', ...placing }, READER]);
      // Gone: a zombie (no thread with a directory left), and a pid listed
      // that has exited since.
      deepStrictEqual(await listed([{ pid: 60, cwd: 'ENOENT' }, { pid: 61, gone: true }, { pid: 62, cwd: '/' }]), [{ pid: 62, cwd: '/', raw: '/' }, READER]);
      // Another user's, and one of the user's own that hides its directory.
      deepStrictEqual(await listed([{ pid: 70, cwd: 'EACCES', uid: 0 }, { pid: 71, cwd: 'EACCES', starttime: 900 }]), [{ pid: 70, cwd: null, raw: null }, { pid: 71, cwd: null, raw: null, unreadable: true, starttime: '900', ...placing }, READER]);
    });

    it('on Linux, a listing of every process that does not list its reader (an empty /proc, one unmounted or masked, or another pid namespace\'s) cannot be read (C142 O-F4)', async () => {
      const tree = '/tmp/engineer-peer-snapshot-x/tree';
      strictEqual(await identity.allProcessCwds({ clock: CLOCK, system: linuxSystem([], { reader: null }) }), null);
      strictEqual(await identity.allProcessCwds({ clock: CLOCK, system: linuxSystem([{ pid: 30, cwd: '/home' }], { reader: null }) }), null);
      strictEqual(await lib.treeOccupancy(tree, { listProcesses: () => identity.allProcessCwds({ clock: CLOCK, system: linuxSystem([], { reader: null }) }) }), 'unknown');
      // Control: the same /proc, listing its reader.
      deepStrictEqual(await identity.allProcessCwds({ clock: CLOCK, system: linuxSystem([{ pid: 30, cwd: '/home' }]) }), [{ pid: 30, cwd: '/home', raw: '/home' }, READER]);
      // A group's listing does not hold its reader: one that lists none is a
      // group with no process.
      deepStrictEqual(await identity.groupMemberCwds(40, { system: linuxSystem([], { reader: null }) }), []);
    });

    it('on Linux, a group is listed only through a /proc that is the reader\'s and, given the run\'s clock, only in the pid namespace it names: a group listed otherwise is another namespace\'s, and ties nothing (C142 U-F1)', async () => {
      const tree = '/tmp/engineer-peer-snapshot-x/tree';
      const procs = [{ pid: 40, cwd: `${tree}/sub` }, { pid: 50, cwd: '/' }];
      const member = [{ pid: 40, cwd: `${tree}/sub`, raw: `${tree}/sub` }];
      // Control: the reader's /proc, in the namespace the run's clock names.
      deepStrictEqual(await identity.groupMemberCwds(40, { clock: CLOCK, system: linuxSystem(procs) }), member);
      strictEqual(await lib.groupTiedToTree(40, tree, { clock: CLOCK, system: linuxSystem(procs) }), 'tied');
      // A /proc of another pid namespace: its `self` names the reader under
      // another pid, and its group 40 is that namespace's.
      strictEqual(await identity.groupMemberCwds(40, { system: linuxSystem(procs, { self: '1040' }) }), null);
      strictEqual(await lib.groupTiedToTree(40, tree, { clock: CLOCK, system: linuxSystem(procs, { self: '1040' }) }), 'unknown');
      // A reader in another pid namespace than the one the run's clock names,
      // or whose namespace cannot be read.
      strictEqual(await identity.groupMemberCwds(40, { clock: CLOCK, system: linuxSystem(procs, { pidNamespace: 'pid:[2]' }) }), null);
      strictEqual(await identity.groupMemberCwds(40, { clock: CLOCK, system: linuxSystem(procs, { pidNamespace: 'EACCES' }) }), null);
      strictEqual(await lib.groupTiedToTree(40, tree, { clock: CLOCK, system: linuxSystem(procs, { pidNamespace: 'pid:[2]' }) }), 'unknown');
      // An earlier runner's record keeps no clock: its group is read in the
      // reader's namespace, as before.
      deepStrictEqual(await identity.groupMemberCwds(40, { system: linuxSystem(procs, { pidNamespace: 'pid:[2]' }) }), member);
    });

    // The cancel and the judgment read the group through the system itself,
    // which has no seam: a process of their own reads a Linux /proc the probe
    // makes up (_peer-snapshot-ns-probe.mjs), as the fourteenth review's
    // probe did. A real group whose leader is gone runs outside the tree; the
    // made-up /proc says a process of a group under its id runs in it.
    it('on Linux, cancel signals no group, and the judgment ties none, listed in another pid namespace than the run\'s supervisor\'s clock names or through a /proc that is not the reader\'s (C142 U-F1)', async (t) => {
      await withTmp(async (dir) => {
        const repo = join(dir, 'repo');
        const parent = join(dir, `${persona}-peer-snapshot-ns`);
        const tree = join(parent, 'tree');
        mkdirSync(repo);
        mkdirSync(join(tree, 'sub'), { recursive: true });
        execFileSync('git', ['-C', repo, 'init', '-q'], { env: GIT_ENV });
        const pgid = await leaderlessGroup(t, repo);
        const supervisor = { pid: await deadPid(), fingerprint: { kind: 'linux_proc_starttime', starttime: '1000', clock: CLOCK, ancestors: [] } };
        const owner = { schema: 'peer-snapshot-owner-1', run_id: 'ns-run', live_toplevel: repo, tree, branch: null, supervisor, companion: { pid: pgid, pgid, fingerprint: { kind: 'none' } }, created_at: new Date().toISOString() };
        const ownerPath = join(parent, 'owner.json');
        writeFileSync(ownerPath, JSON.stringify(owner));
        const probe = (action, ns) => {
          const given = { runner: P.path('scripts/peer-runner.mjs'), lib: P.path('scripts/lib/peer-snapshot.mjs'), action, pgid, cwd: join(tree, 'sub'), pidNamespace: 'pid:[1]', owner, tree, repo, runId: owner.run_id, ...ns };
          const r = spawnSync(process.execPath, [join(import.meta.dirname, '_peer-snapshot-ns-probe.mjs'), JSON.stringify(given)], { env, encoding: 'utf8' });
          strictEqual(r.status, 0, r.stderr);
          return JSON.parse(r.stdout);
        };
        // The judgment: tied in the run's namespace, not in another, nor
        // through a /proc that is not the reader's.
        deepStrictEqual(probe('judge', {}).result, ['alive', 'companion-alive']);
        deepStrictEqual(probe('judge', { pidNamespace: 'pid:[2]' }).result, ['unknown', 'companion-untied']);
        deepStrictEqual(probe('judge', { self: '999999999' }).result, ['unknown', 'companion-untied']);
        // The cancel of a run whose handle names that group, its leader gone,
        // the handle unmoved past the stale grace.
        const paths = runner.peerRunPaths(repo, owner.run_id);
        const at = new Date(Date.now() - 5 * 60_000).toISOString();
        mkdirSync(paths.dir, { recursive: true });
        writeFileSync(paths.handle, JSON.stringify({
          schema_version: '1.0', run_id: owner.run_id, plugin: persona, kind: 'manual', workflow_path: null, phase: null, ensemble_type: null, host: 'claude', peer_host: 'codex', model: null, effort: null, cwd: repo, output_format: 'json',
          status: 'cancel_requested', pid: pgid, pgid, process_fingerprint: { kind: 'none' }, peer_process: { pid: pgid, pgid }, started_at: at, updated_at: at, completed_at: null, last_output_at: null,
          stdout_bytes: 0, stderr_bytes: 0, exit_code: null, error_kind: null, prompt_retained: false,
          snapshot: { isolation: 'snapshot', root: tree, owner_path: ownerPath, supervisor, removed_at: null },
        }));
        const refuses = (why) => {
          for (const ns of [{ pidNamespace: 'pid:[2]' }, { self: '999999999' }]) {
            const { result, sent } = probe('cancel', ns);
            deepStrictEqual(sent, [], `${JSON.stringify(ns)}: another namespace's group gets no signal`);
            deepStrictEqual([result.reason, result.why], ['supervisor_unknown', why], JSON.stringify(result));
            ok(groupAlive(pgid), 'the group runs on');
          }
        };
        // Its owner record there: the judgment refuses it.
        refuses('companion-untied');
        // Its snapshot gone with its owner record (a reclaim removed it): the
        // group the handle names is stopped only when tied in the namespace
        // the handle's supervisor's clock names.
        rmSync(parent, { recursive: true, force: true });
        refuses('snapshot-gone-group-unknown');
        // Control: in the run's namespace the group is tied, and stopped.
        strictEqual(probe('cancel', {}).sent[0], 'SIGTERM', 'the run\'s own group is stopped');
      });
    });

    // The same /proc, its leader alive: a process of another namespace under
    // the companion's pid, with the start time the record keeps, is no proof
    // that the reader's process of that pid is the companion (refine-verify of
    // the fourteenth review's fixes, F1). Nor is a process of the reader's
    // own /proc in another pid namespace than the one the supervisor's clock
    // names: that namespace numbers its own processes, and the same start
    // tick is all the two share (C142, eighteenth review's Y-F1).
    it('on Linux, a process read through a /proc that is not the reader\'s, or by a reader in another pid namespace than the run\'s supervisor\'s clock names, fingerprints none: no group is signalled as a live companion\'s on it (C142 U-F1, Y-F1)', async (t) => {
      await withTmp(async (dir) => {
        const repo = join(dir, 'repo');
        const parent = join(dir, `${persona}-peer-snapshot-ns`);
        const tree = join(parent, 'tree');
        mkdirSync(repo);
        mkdirSync(join(tree, 'sub'), { recursive: true });
        execFileSync('git', ['-C', repo, 'init', '-q'], { env: GIT_ENV });
        const leader = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { detached: true, cwd: repo, stdio: 'ignore' });
        t.after(() => killGroup(leader.pid));
        await new Promise((r) => leader.once('spawn', r));
        const pgid = leader.pid;
        const fingerprint = { kind: 'linux_proc_starttime', starttime: '1200' };
        const supervisor = { pid: await deadPid(), fingerprint: { kind: 'linux_proc_starttime', starttime: '1000', clock: CLOCK, ancestors: [] } };
        const owner = { schema: 'peer-snapshot-owner-1', run_id: 'ns-live', live_toplevel: repo, tree, branch: null, supervisor, companion: { pid: pgid, pgid, fingerprint }, created_at: new Date().toISOString() };
        const ownerPath = join(parent, 'owner.json');
        writeFileSync(ownerPath, JSON.stringify(owner));
        const paths = runner.peerRunPaths(repo, owner.run_id);
        mkdirSync(paths.dir, { recursive: true });
        const handleWith = (status) => {
          const at = new Date(Date.now() - 5 * 60_000).toISOString();
          writeFileSync(paths.handle, JSON.stringify({
            schema_version: '1.0', run_id: owner.run_id, plugin: persona, kind: 'manual', workflow_path: null, phase: null, ensemble_type: null, host: 'claude', peer_host: 'codex', model: null, effort: null, cwd: repo, output_format: 'json',
            status, pid: pgid, pgid, process_fingerprint: fingerprint, peer_process: { pid: pgid, pgid }, started_at: at, updated_at: at, completed_at: null, last_output_at: null,
            stdout_bytes: 0, stderr_bytes: 0, exit_code: null, error_kind: null, prompt_retained: false,
            snapshot: { isolation: 'snapshot', root: tree, owner_path: ownerPath, supervisor, removed_at: null },
          }));
        };
        const probe = (action, ns) => {
          const given = { runner: P.path('scripts/peer-runner.mjs'), lib: P.path('scripts/lib/peer-snapshot.mjs'), action, pgid, entry: pgid, cwd: join(tree, 'sub'), pidNamespace: 'pid:[1]', owner, tree, repo, runId: owner.run_id, ...ns };
          const r = spawnSync(process.execPath, [join(import.meta.dirname, '_peer-snapshot-ns-probe.mjs'), JSON.stringify(given)], { env, encoding: 'utf8' });
          strictEqual(r.status, 0, r.stderr);
          return JSON.parse(r.stdout);
        };
        // Another namespace's /proc (F1), and the reader's own /proc in
        // another pid namespace than the supervisor's clock names (Y-F1).
        for (const foreign of [{ self: '999999999' }, { pidNamespace: 'pid:[2]' }]) {
          const named = JSON.stringify(foreign);
          // The judgment: the companion matched in the run's namespace, and
          // cannot be told in another.
          deepStrictEqual(probe('judge', {}).result, ['alive', 'companion-alive']);
          deepStrictEqual(probe('judge', foreign).result, ['unknown', 'companion-unknown'], named);
          // A cancel of the run while it runs, and once its handle is terminal.
          for (const status of ['running', 'completed']) {
            handleWith(status);
            deepStrictEqual(probe('cancel', foreign).sent, [], `${named} ${status}: another namespace's process gets no signal`);
            ok(alive(pgid), 'the reader\'s process of that pid runs on');
          }
        }
        // The supervisor too, under the clock its fingerprint keeps: matched
        // in the run's namespace, and not told in another.
        const supervised = { ...owner, supervisor: { pid: pgid, fingerprint: { kind: 'linux_proc_starttime', starttime: '1200', clock: CLOCK, ancestors: [] } }, companion: null };
        deepStrictEqual(probe('judge', { owner: supervised }).result, ['alive', 'supervisor-alive']);
        deepStrictEqual(probe('judge', { owner: supervised, pidNamespace: 'pid:[2]' }).result, ['unknown', 'supervisor-unknown']);
        // The reclaim (judgeSnapshot) reads the companion under the
        // supervisor's clock too. Its group not led by that pid, a companion
        // matched only in another namespace is an identity that cannot be told:
        // kept until the record is past the TTL, then reclaimed, where a match
        // read in the run's namespace keeps it however old.
        const stale = { ...owner, companion: { pid: pgid, pgid: await deadPid(), fingerprint }, created_at: new Date(Date.now() - 5 * 60_000).toISOString() };
        const fresh = { ...stale, created_at: new Date().toISOString() };
        deepStrictEqual(probe('reclaim', { owner: stale, ttlMs: 60_000 }).result, ['keep', 'companion-alive']);
        for (const foreign of [{ self: '999999999' }, { pidNamespace: 'pid:[2]' }]) {
          deepStrictEqual(probe('reclaim', { owner: fresh, ttlMs: 60_000, ...foreign }).result, ['keep', 'identity-unknown'], JSON.stringify(foreign));
          deepStrictEqual(probe('reclaim', { owner: stale, ttlMs: 60_000, ...foreign }).result, ['reclaim', 'identity-unknown-expired'], JSON.stringify(foreign));
        }
        // Its snapshot gone with its owner record (a reclaim removed it): the
        // terminal run's group is stopped only on its leader read in the run's
        // namespace (stopHandleGroup).
        rmSync(parent, { recursive: true, force: true });
        handleWith('completed');
        for (const foreign of [{ self: '999999999' }, { pidNamespace: 'pid:[2]' }]) {
          deepStrictEqual(probe('cancel', foreign).sent, [], `${JSON.stringify(foreign)} snapshot gone: another namespace's process gets no signal`);
          ok(alive(pgid), 'the reader\'s process of that pid runs on');
        }
        // Control: in the run's namespace, the terminal run's group, its
        // leader the companion and its supervisor gone, is stopped.
        strictEqual(probe('cancel', {}).sent[0], 'SIGTERM', 'the run\'s own group is stopped');
      });
    });

    it('on Linux, a listing of every process through a /proc that hides the processes its reader may not ptrace (hidepid=invisible or ptraceable, systemd\'s ProtectProc=invisible) cannot be read (C142 P-F1)', async () => {
      const tree = '/tmp/engineer-peer-snapshot-x/tree';
      const procs = [{ pid: 30, cwd: '/home' }];
      const mounted = (...lines) => `1 0 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n${lines.join('\n')}\n`;
      const listed = (mountinfo) => identity.allProcessCwds({ clock: CLOCK, system: linuxSystem(procs, { mountinfo }) });
      const hiding = [
        mounted(`${PROC_MOUNT},hidepid=invisible`),
        mounted(`${PROC_MOUNT},hidepid=ptraceable,gid=27`),
        mounted(`${PROC_MOUNT},hidepid=2`),
        mounted(`${PROC_MOUNT},hidepid=4`),
        // The option where the mount's own options carry it.
        mounted(PROC_MOUNT.replace('rw,nosuid', 'rw,hidepid=invisible,nosuid')),
        // systemd's ProtectProc=invisible: a /proc of the service's own,
        // mounted over the host's.
        mounted(PROC_MOUNT, `90 22 0:51 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw,hidepid=invisible`),
        // Which mount at /proc is the one read is not told by their order: a
        // mount that hides, moved over a later one that does not, is listed
        // first (refine-verify of the ninth review).
        mounted(`22 90 0:20 / /proc rw - proc proc rw,hidepid=invisible`, '90 1 0:51 / /proc rw - proc proc rw'),
        // A source spelled `-`, which the kernel keeps: the first ` - ` alone
        // ends the optional fields (C142 Q-F2).
        mounted('22 1 0:20 / /proc rw,nosuid shared:12 - proc - rw,hidepid=invisible'),
        // A mountinfo that cannot be read, no /proc in it, or a /proc that is
        // no proc (masked): nothing shows what it hides.
        'EACCES',
        mounted(),
        mounted(PROC_MOUNT, '91 22 0:52 / /proc ro,relatime - tmpfs tmpfs ro'),
        // A mount over one process's directory, or below it: /proc still
        // lists the pid, and its links read as those of one exited (C142
        // R-F4).
        mounted(PROC_MOUNT, '93 22 0:54 / /proc/30 rw,relatime - tmpfs tmpfs rw'),
        mounted(PROC_MOUNT, '94 22 0:55 / /proc/30/task rw,relatime - tmpfs tmpfs rw'),
      ];
      for (const mountinfo of hiding) {
        strictEqual(await listed(mountinfo), null, mountinfo);
        strictEqual(await lib.treeOccupancy(tree, { listProcesses: () => listed(mountinfo) }), 'unknown', mountinfo);
      }
      // Controls: a /proc that hides nothing (no option, 0, off), one that
      // refuses reads and still lists every process (1, noaccess), a stack
      // of mounts at /proc none of which hides, one whose source is `-`, and
      // a mount below /proc (binfmt_misc), which is no mount at /proc.
      for (const mountinfo of [MOUNTINFO, mounted(`${PROC_MOUNT},hidepid=0`), mounted(`${PROC_MOUNT},hidepid=off`), mounted(`${PROC_MOUNT},hidepid=1`), mounted(`${PROC_MOUNT},hidepid=noaccess`), mounted(`${PROC_MOUNT},hidepid=1`, '92 22 0:53 / /proc rw - proc proc rw'), mounted('22 1 0:20 / /proc rw - proc - rw'), mounted(PROC_MOUNT, '23 22 0:21 / /proc/sys/fs/binfmt_misc rw,relatime - binfmt_misc binfmt_misc rw')]) {
        deepStrictEqual(await listed(mountinfo), [{ pid: 30, cwd: '/home', raw: '/home' }, READER], mountinfo);
      }
      // The judgments keep a run whose supervisor is gone while the /proc
      // hides: a process it hides may run in the tree.
      const owner = { supervisor: { pid: await deadPid(), fingerprint: { kind: 'linux_proc_starttime', starttime: '1000', command: 'node peer-runner.mjs', clock: CLOCK } }, live_toplevel: '/r', tree, companion: null, created_at: new Date().toISOString() };
      deepStrictEqual((await lib.snapshotEnded(owner, { tree, listProcesses: () => listed(hiding[0]) })).why, 'tree-unknown');
      strictEqual((await lib.snapshotEnded(owner, { tree, listProcesses: () => listed(MOUNTINFO) })).verdict, 'ended');
    });

    it('on Linux, a listing of every process read in another pid namespace than the run\'s lists none of the run\'s processes, and cannot be read for it (C142 Q-F1)', async () => {
      const tree = '/tmp/engineer-peer-snapshot-x/tree';
      const supervisor = { pid: await deadPid(), fingerprint: { kind: 'linux_proc_starttime', starttime: '1000', command: 'node peer-runner.mjs', clock: CLOCK } };
      const owner = { supervisor, live_toplevel: '/r', tree, companion: null, created_at: new Date().toISOString() };
      const procs = [{ pid: 2, cwd: '/', starttime: 5 }];
      // A sandbox that unshares the pid namespace, with a /proc of its own:
      // it lists its reader as itself and hides nothing, yet holds none of
      // the run's processes. The judgments pass the run's clock.
      const sandboxed = (options) => identity.allProcessCwds({ ...options, system: linuxSystem(procs, { pidNamespace: 'pid:[99]' }) });
      strictEqual(await sandboxed({ clock: CLOCK }), null);
      strictEqual(await lib.treeOccupancy(tree, { supervisor, listProcesses: sandboxed }), 'unknown');
      deepStrictEqual((await lib.snapshotEnded(owner, { tree, listProcesses: sandboxed })).why, 'tree-unknown');
      // A pid namespace that cannot be read now, or a clock of no Linux
      // pid namespace, proves nothing of the run's either.
      strictEqual(await identity.allProcessCwds({ clock: CLOCK, system: linuxSystem(procs, { pidNamespace: 'EACCES' }) }), null);
      strictEqual(await identity.allProcessCwds({ clock: 'darwin-boot/1000.5', system: linuxSystem(procs) }), null);
      // So does a listing for a run whose clock was not recorded, which names
      // no namespace to compare (C142 R-F1).
      strictEqual(await sandboxed({}), null);
      // Controls: the run's own pid namespace, whatever the boot or time
      // namespace (which place a process, never list it).
      const own = (options) => identity.allProcessCwds({ ...options, system: linuxSystem(procs) });
      for (const clock of [CLOCK, 'boot-b/time:[2]/pid:[1]']) deepStrictEqual(await own({ clock }), [{ pid: 2, cwd: '/', raw: '/' }, READER], clock);
      strictEqual(await lib.treeOccupancy(tree, { supervisor, listProcesses: own }), 'none');
      strictEqual((await lib.snapshotEnded(owner, { tree, listProcesses: own })).verdict, 'ended');
    });

    it('on Linux, a listing of every process reads /proc again until a round meets no process it had not met, so a process started while it ran is never left out (C142 Q-F3)', async () => {
      const tree = '/tmp/engineer-peer-snapshot-x/tree';
      const supervisor = { pid: await deadPid(), fingerprint: { kind: 'linux_proc_starttime', starttime: '1000', command: 'node peer-runner.mjs', clock: CLOCK } };
      const owner = { supervisor, live_toplevel: '/r', tree, companion: null, created_at: new Date().toISOString() };
      // `from` names the read of /proc each pid is first listed in (the
      // first by default).
      const revealing = (procs, from) => {
        const system = linuxSystem(procs);
        let reads = 0;
        return {
          ...system,
          readdir: async (path) => {
            const listed = await system.readdir(path);
            if (path !== '/proc') return listed;
            reads++;
            return listed.filter((entry) => (from[entry] ?? 1) <= reads);
          },
        };
      };
      // A process of the run (80) starts a child (81) in the tree once /proc
      // was first read, and exits before its turn: the child is read in the
      // next round.
      const forked = () => identity.allProcessCwds({ clock: CLOCK, system: revealing([{ pid: 80, gone: true }, { pid: 81, cwd: `${tree}/sub`, starttime: 1200 }], { 81: 2 }) });
      deepStrictEqual(await forked(), [READER, { pid: 81, cwd: `${tree}/sub`, raw: `${tree}/sub` }]);
      strictEqual(await lib.treeOccupancy(tree, { supervisor, listProcesses: forked }), 'occupied');
      deepStrictEqual((await lib.snapshotEnded(owner, { tree, listProcesses: forked })).why, 'tree-occupied');
      // A machine that starts a process each round: after the fourth, those
      // still unmet are listed `unreadable` when they are the user's own
      // (84), never left out, and another user's (85) is not listed.
      const machine = [81, 82, 83].map((pid) => ({ pid, cwd: '/home', starttime: 1100 }));
      const busy = () => identity.allProcessCwds({ clock: CLOCK, system: revealing([...machine, { pid: 84, cwd: tree, starttime: 1200 }, { pid: 85, cwd: tree, uid: 0 }], { 81: 2, 82: 3, 83: 4, 84: 5, 85: 5 }) });
      const placing = { clock: CLOCK, ancestors: [{ pid: 1, starttime: '1', reaper: true }] };
      deepStrictEqual(await busy(), [READER, ...machine.map(({ pid }) => ({ pid, cwd: '/home', raw: '/home' })), { pid: 84, cwd: null, raw: null, unreadable: true, starttime: '1200', ...placing }]);
      strictEqual(await lib.treeOccupancy(tree, { supervisor, listProcesses: busy }), 'unknown');
      deepStrictEqual((await lib.snapshotEnded(owner, { tree, listProcesses: busy })).why, 'tree-unknown');
      // One still unmet whose status cannot be read is counted as the user's
      // own, and a read of /proc again that fails leaves the listing unproved
      // (C142 X15, X16 of the eleventh review).
      const refused = revealing([...machine, { pid: 84, cwd: tree, starttime: 1200 }], { 81: 2, 82: 3, 83: 4, 84: 5 });
      const readFile = refused.readFile;
      refused.readFile = async (path) => (path === '/proc/84/status' ? Promise.reject(failing('EACCES')) : readFile(path));
      deepStrictEqual((await identity.allProcessCwds({ clock: CLOCK, system: refused })).at(-1), { pid: 84, cwd: null, raw: null, unreadable: true, starttime: '1200', ...placing });
      const once = linuxSystem(machine);
      let reads = 0;
      const reread = { ...once, readdir: async (path) => (path === '/proc' && ++reads > 1 ? Promise.reject(failing('EMFILE')) : once.readdir(path)) };
      strictEqual(await identity.allProcessCwds({ clock: CLOCK, system: reread }), null);
      // A process of the run that forks the next into the tree and exits
      // once each read of /proc lists it, past the last round: the one the
      // last read lists has exited before its status is read, and the child
      // it may have started no round met, so the listing is unproved (C142
      // R-F2). Up to four, the last round meets the process (three) or lists
      // it `unreadable` (four).
      const chain = (generations) => {
        const procs = [{ pid: 1, cwd: '/', ppid: 0, starttime: 1 }, { pid: 1000, cwd: `${tree}/sub`, starttime: 1200 }];
        const system = linuxSystem(procs);
        let listings = 0;
        return () => identity.allProcessCwds({
          clock: CLOCK,
          system: {
            ...system,
            readdir: async (path) => {
              const listed = await system.readdir(path);
              if (path === '/proc' && ++listings <= generations) {
                const last = procs.at(-1);
                last.gone = true;
                procs.push({ pid: last.pid + 1, cwd: `${tree}/sub`, starttime: 1200 });
              }
              return listed;
            },
          },
        });
      };
      for (const generations of [5, 10]) {
        strictEqual(await chain(generations)(), null, String(generations));
        strictEqual(await lib.treeOccupancy(tree, { supervisor, listProcesses: chain(generations) }), 'unknown', String(generations));
        deepStrictEqual((await lib.snapshotEnded(owner, { tree, listProcesses: chain(generations) })).why, 'tree-unknown', String(generations));
      }
      strictEqual(await lib.treeOccupancy(tree, { supervisor, listProcesses: chain(3) }), 'occupied');
      deepStrictEqual((await chain(4)()).map(({ pid, unreadable }) => [pid, unreadable ?? false]), [[1, false], [1004, true]]);
      // Control: a /proc that lists the same processes on every read.
      const still = () => identity.allProcessCwds({ clock: CLOCK, system: linuxSystem(machine) });
      strictEqual(await lib.treeOccupancy(tree, { supervisor, listProcesses: still }), 'none');
    });

    it('on Linux, a listing of every process for a run whose clock was not recorded (an earlier runner\'s record, or one whose clock could not be read) names no pid namespace to compare, and cannot be read for it (C142 R-F1)', async () => {
      const tree = '/tmp/engineer-peer-snapshot-x/tree';
      const unclocked = { pid: await deadPid(), fingerprint: { kind: 'linux_proc_starttime', starttime: '1000', command: 'node peer-runner.mjs' } };
      const owner = { supervisor: unclocked, live_toplevel: '/r', tree, companion: null, created_at: new Date().toISOString() };
      const procs = [{ pid: 2, cwd: '/', starttime: 5 }];
      // Read in a sandbox's pid namespace with a /proc of its own (the
      // peer's removal under a live occupant of the eleventh review), or in
      // the run's own: neither is proved to hold the run's processes.
      for (const pidNamespace of ['pid:[99]', 'pid:[1]']) {
        const listing = (options) => identity.allProcessCwds({ ...options, system: linuxSystem(procs, { pidNamespace }) });
        strictEqual(await listing({}), null, pidNamespace);
        strictEqual(await lib.treeOccupancy(tree, { supervisor: unclocked, listProcesses: listing }), 'unknown', pidNamespace);
        strictEqual(await lib.treeOccupancy(tree, { listProcesses: listing }), 'unknown', pidNamespace);
        deepStrictEqual((await lib.snapshotEnded(owner, { tree, listProcesses: listing })).why, 'tree-unknown', pidNamespace);
      }
      // Controls: the same record with its clock, read in the run's
      // namespace, and a group's listing, which needs none.
      const clocked = { ...unclocked, fingerprint: { ...unclocked.fingerprint, clock: CLOCK } };
      const own = (options) => identity.allProcessCwds({ ...options, system: linuxSystem(procs) });
      strictEqual(await lib.treeOccupancy(tree, { supervisor: clocked, listProcesses: own }), 'none');
      strictEqual((await lib.snapshotEnded({ ...owner, supervisor: clocked }, { tree, listProcesses: own })).verdict, 'ended');
      deepStrictEqual(await identity.groupMemberCwds(2, { system: linuxSystem(procs) }), [{ pid: 2, cwd: '/', raw: '/' }]);
    });

    it('on Linux, a process whose main thread has exited is read again while its threads come and go, and is gone only once its task list names no thread with a directory left and its status counts no other thread (C142 R-F3)', async () => {
      const tree = '/tmp/engineer-peer-snapshot-x/tree';
      const supervisor = { pid: await deadPid(), fingerprint: { kind: 'linux_proc_starttime', starttime: '1000', command: 'node peer-runner.mjs', clock: CLOCK } };
      const owner = { supervisor, live_toplevel: '/r', tree, companion: null, created_at: new Date().toISOString() };
      // Its last thread starts the next in the tree and exits as its link is
      // about to be read, `replaced` times; `last` is the task list left
      // after them (one more thread by default).
      const churning = (replaced, last = null) => () => {
        const p = { pid: 80, cwd: 'ENOENT', tasks: { 80: 'ENOENT', 81: `${tree}/sub` }, starttime: 1200 };
        const system = linuxSystem([p]);
        let n = 0;
        return identity.allProcessCwds({
          clock: CLOCK,
          system: {
            ...system,
            readlink: async (path) => {
              const tid = /^\/proc\/80\/task\/(\d+)\/cwd$/.exec(path)?.[1];
              if (tid !== undefined && tid !== '80' && n < replaced) {
                n++;
                p.tasks = n === replaced && last !== null ? last : { 80: 'ENOENT', [Number(tid) + 1]: `${tree}/sub` };
              }
              return system.readlink(path);
            },
          },
        });
      };
      // Replaced once or twice during the walk: read again, it runs in the tree.
      for (const replaced of [1, 2]) {
        deepStrictEqual(await churning(replaced)(), [{ pid: 80, cwd: `${tree}/sub`, raw: `${tree}/sub` }, READER], String(replaced));
        strictEqual(await lib.treeOccupancy(tree, { supervisor, listProcesses: churning(replaced) }), 'occupied', String(replaced));
        deepStrictEqual((await lib.snapshotEnded(owner, { tree, listProcesses: churning(replaced) })).why, 'tree-occupied', String(replaced));
      }
      // Replaced on every read: after four it is not read, and unreadable.
      const placing = { clock: CLOCK, ancestors: [{ pid: 1, starttime: '1', reaper: true }] };
      deepStrictEqual(await churning(10)(), [{ pid: 80, cwd: null, raw: null, unreadable: true, starttime: '1200', ...placing }, READER]);
      strictEqual(await lib.treeOccupancy(tree, { supervisor, listProcesses: churning(10) }), 'unknown');
      // A thread outside the tree (81) is read, and one in it (82) starts
      // another there (83) and exits before its link is read: the walk is
      // read again (refine-verify of the eleventh review's fixes).
      const partial = () => {
        const p = { pid: 80, cwd: 'ENOENT', tasks: { 80: 'ENOENT', 81: '/', 82: `${tree}/sub` }, starttime: 1200 };
        const system = linuxSystem([p]);
        return identity.allProcessCwds({
          clock: CLOCK,
          system: {
            ...system,
            readlink: async (path) => {
              if (path === '/proc/80/task/82/cwd') p.tasks = { 80: 'ENOENT', 81: '/', 83: `${tree}/sub` };
              return system.readlink(path);
            },
          },
        });
      };
      strictEqual(await lib.treeOccupancy(tree, { supervisor, listProcesses: partial }), 'occupied');
      deepStrictEqual((await lib.snapshotEnded(owner, { tree, listProcesses: partial })).why, 'tree-occupied');
      // A task list that ends early, naming the main thread alone while its
      // status counts another (82, in the tree), is read again.
      const truncated = () => {
        const p = { pid: 80, cwd: 'ENOENT', tasks: { 80: 'ENOENT', 82: `${tree}/sub` }, starttime: 1200 };
        const system = linuxSystem([p]);
        let reads = 0;
        return identity.allProcessCwds({
          clock: CLOCK,
          system: { ...system, readdir: async (path) => (path === '/proc/80/task' && ++reads === 1 ? ['80'] : system.readdir(path)) },
        });
      };
      strictEqual(await lib.treeOccupancy(tree, { supervisor, listProcesses: truncated }), 'occupied');
      deepStrictEqual((await lib.snapshotEnded(owner, { tree, listProcesses: truncated })).why, 'tree-occupied');
      // One that ends early naming a thread that reads (81, outside the tree)
      // while its status counts three is read again too (C142 S-F1); ending
      // early on every read, it is unreadable, with the directory it read.
      const cutShort = (times) => () => {
        const p = { pid: 80, cwd: 'ENOENT', tasks: { 80: 'ENOENT', 81: '/', 82: `${tree}/sub` }, starttime: 1200 };
        const system = linuxSystem([p]);
        let reads = 0;
        return identity.allProcessCwds({
          clock: CLOCK,
          system: { ...system, readdir: async (path) => (path === '/proc/80/task' && ++reads <= times ? ['80', '81'] : system.readdir(path)) },
        });
      };
      strictEqual(await lib.treeOccupancy(tree, { supervisor, listProcesses: cutShort(1) }), 'occupied');
      deepStrictEqual((await lib.snapshotEnded(owner, { tree, listProcesses: cutShort(1) })).why, 'tree-occupied');
      deepStrictEqual(await cutShort(10)(), [{ pid: 80, cwd: '/', raw: '/' }, { pid: 80, cwd: null, raw: null, unreadable: true, starttime: '1200', ...placing }, READER]);
      strictEqual(await lib.treeOccupancy(tree, { supervisor, listProcesses: cutShort(10) }), 'unknown');
      // Control: the whole list read at once is taken as it reads.
      deepStrictEqual(await cutShort(0)(), [{ pid: 80, cwd: '/', raw: '/' }, { pid: 80, cwd: `${tree}/sub`, raw: `${tree}/sub` }, READER]);
      // One cut short to a thread outside the tree (81), which exits once it
      // is read: the status's count falls to the thread the list left out
      // (83, in the tree), and the list read after the count no longer names
      // 81, so the walk is read again (refine-verify of the twelfth review's
      // fixes, F1).
      const exitsOnceRead = () => {
        const p = { pid: 80, cwd: 'ENOENT', tasks: { 80: 'ENOENT', 81: '/', 83: `${tree}/sub` }, starttime: 1200 };
        const system = linuxSystem([p]);
        let reads = 0;
        return identity.allProcessCwds({
          clock: CLOCK,
          system: {
            ...system,
            readdir: async (path) => (path === '/proc/80/task' && ++reads === 1 ? ['80', '81'] : system.readdir(path)),
            readlink: async (path) => {
              const raw = await system.readlink(path);
              if (path === '/proc/80/task/81/cwd') p.tasks = { 80: 'ENOENT', 83: `${tree}/sub` };
              return raw;
            },
          },
        });
      };
      deepStrictEqual(await exitsOnceRead(), [{ pid: 80, cwd: `${tree}/sub`, raw: `${tree}/sub` }, READER]);
      strictEqual(await lib.treeOccupancy(tree, { supervisor, listProcesses: exitsOnceRead }), 'occupied');
      deepStrictEqual((await lib.snapshotEnded(owner, { tree, listProcesses: exitsOnceRead })).why, 'tree-occupied');
      // A thread (81) is gone as its link is read, and a thread in the tree
      // takes its tid before the count: the count stays two and the list read
      // after it names 81 still, so only the link that was gone shows the walk
      // read nothing of it, and the walk is read again (the thirteenth
      // review's T-F1).
      const reused = () => {
        const p = { pid: 80, cwd: 'ENOENT', tasks: { 80: 'ENOENT', 81: `${tree}/sub` }, starttime: 1200 };
        const system = linuxSystem([p]);
        let reads = 0;
        return identity.allProcessCwds({
          clock: CLOCK,
          system: {
            ...system,
            readlink: async (path) => {
              if (path === '/proc/80/task/81/cwd' && ++reads === 1) throw failing('ENOENT');
              return system.readlink(path);
            },
          },
        });
      };
      deepStrictEqual(await reused(), [{ pid: 80, cwd: `${tree}/sub`, raw: `${tree}/sub` }, READER]);
      strictEqual(await lib.treeOccupancy(tree, { supervisor, listProcesses: reused }), 'occupied');
      deepStrictEqual((await lib.snapshotEnded(owner, { tree, listProcesses: reused })).why, 'tree-occupied');
      // A process started before the supervisor, so placed outside the run
      // once it is unreadable, whose thread reads in the tree while its list
      // is cut short on every read, or while its status cannot be read: the
      // directory it read keeps the tree (refine-verify of the twelfth
      // review's fixes, F2).
      const earlyUnproved = (how) => () => {
        const p = { pid: 80, cwd: 'ENOENT', tasks: { 80: 'ENOENT', 81: `${tree}/sub`, 82: '/' }, starttime: 900 };
        const system = linuxSystem([p]);
        return identity.allProcessCwds({
          clock: CLOCK,
          system: how === 'short'
            ? { ...system, readdir: async (path) => (path === '/proc/80/task' ? ['80', '81'] : system.readdir(path)) }
            : { ...system, readFile: async (path, enc) => { if (path === '/proc/80/status') throw failing('EIO'); return system.readFile(path, enc); } },
        });
      };
      const read = { short: [`${tree}/sub`], status: [`${tree}/sub`, '/'] };
      for (const how of ['short', 'status']) {
        const members = await earlyUnproved(how)();
        deepStrictEqual(members.filter((m) => m.pid === 80 && !m.unreadable), read[how].map((d) => ({ pid: 80, cwd: d, raw: d })), how);
        strictEqual(members.filter((m) => m.pid === 80 && m.unreadable).length, 1, how);
        strictEqual(await lib.treeOccupancy(tree, { supervisor, listProcesses: earlyUnproved(how) }), 'occupied', how);
        deepStrictEqual((await lib.snapshotEnded(owner, { tree, listProcesses: earlyUnproved(how) })).why, 'tree-occupied', how);
      }
      // Control: its last thread exits with none started, leaving its main
      // thread alone, a zombie: gone.
      deepStrictEqual(await churning(1, { 80: 'ENOENT' })(), [READER]);
      strictEqual(await lib.treeOccupancy(tree, { supervisor, listProcesses: churning(1, { 80: 'ENOENT' }) }), 'none');
      strictEqual((await lib.snapshotEnded(owner, { tree, listProcesses: churning(1, { 80: 'ENOENT' }) })).verdict, 'ended');
    });

    it('on Linux, a process of the user\'s own that hides its directory keeps a tree from reading empty only when it started after the run\'s supervisor (C142 N-F3)', async () => {
      const tree = '/tmp/engineer-peer-snapshot-x/tree';
      const supervisor = { pid: 9, fingerprint: { kind: 'linux_proc_starttime', starttime: '1000', command: 'node peer-runner.mjs', clock: CLOCK } };
      const occupancy = (starttime, judgedFor = supervisor, clock = {}) => lib.treeOccupancy(tree, {
        supervisor: judgedFor,
        listProcesses: () => identity.allProcessCwds({ clock: CLOCK, system: linuxSystem([{ pid: 30, cwd: '/home' }, { pid: 31, cwd: 'EACCES', starttime }], clock) }),
      });
      // One that started before the run cannot descend from it (an
      // ssh-agent, a codex session of another run).
      strictEqual(await occupancy(999), 'none');
      // One that started with the run or since may be the run's.
      strictEqual(await occupancy(1000), 'unknown');
      strictEqual(await occupancy(1001), 'unknown');
      // No start time to compare, on either side: it may be the run's.
      strictEqual(await occupancy('x'), 'unknown');
      strictEqual(await occupancy(999, null), 'unknown');
      strictEqual(await occupancy(999, { pid: 9, fingerprint: { kind: 'none' } }), 'unknown');
      strictEqual(await occupancy(999, { pid: 9, fingerprint: { kind: 'macos_lstart_command', lstart: 'x', command: 'y' } }), 'unknown');
      // Start times read in another clock do not compare (F1, refine-verify
      // of the seventh review): another boot, another time namespace, whose
      // offset shifts every start time a reader sees, or another pid
      // namespace, whose pids name other processes; nor do they when the
      // supervisor's clock was not recorded or cannot be read now.
      strictEqual(await occupancy(999, supervisor, { boot: 'boot-b' }), 'unknown');
      strictEqual(await occupancy(999, supervisor, { timeNamespace: 'time:[2]' }), 'unknown');
      strictEqual(await occupancy(999, supervisor, { pidNamespace: 'pid:[2]' }), 'unknown');
      strictEqual(await occupancy(999, supervisor, { boot: 'EACCES' }), 'unknown');
      strictEqual(await occupancy(999, { pid: 9, fingerprint: { ...supervisor.fingerprint, clock: undefined } }), 'unknown');
      strictEqual(await occupancy(999, { pid: 9, fingerprint: { ...supervisor.fingerprint, clock: null } }, { boot: 'EACCES' }), 'unknown');
      // A kernel without time namespaces is one clock per boot.
      strictEqual(await occupancy(999, { pid: 9, fingerprint: { ...supervisor.fingerprint, clock: 'boot-a/-/pid:[1]' } }, { timeNamespace: 'ENOENT' }), 'none');
      strictEqual(await identity.clockDomain({ system: linuxSystem([], { timeNamespace: 'ENOENT' }) }), 'boot-a/-/pid:[1]');
      strictEqual(await identity.clockDomain({ system: linuxSystem([], { pidNamespace: 'ENOENT' }) }), 'boot-a/time:[1]/-');
      strictEqual(await identity.clockDomain({ system: linuxSystem([], { timeNamespace: 'EACCES' }) }), null);
      strictEqual(await identity.clockDomain({ system: linuxSystem([], { pidNamespace: 'EACCES' }) }), null);
      // The judgments bound it by the owner record's supervisor.
      const owner = { supervisor: { ...supervisor, pid: await deadPid() }, live_toplevel: '/r', tree, companion: null, created_at: new Date().toISOString() };
      const hidden = (starttime) => () => identity.allProcessCwds({ clock: CLOCK, system: linuxSystem([{ pid: 31, cwd: 'EACCES', starttime }]) });
      const ended = async (starttime) => {
        const { verdict, why } = await lib.snapshotEnded(owner, { tree, listProcesses: hidden(starttime) });
        return [verdict, why];
      };
      deepStrictEqual(await ended(999), ['ended', 'supervisor-gone-nothing-launched']);
      deepStrictEqual(await ended(1001), ['unknown', 'tree-unknown']);
      deepStrictEqual(await lib.judgeSnapshot(owner, { tree, listProcesses: hidden(999) }), { verdict: 'reclaim', why: 'supervisor-gone-companion-unrecorded' });
      deepStrictEqual(await lib.judgeSnapshot(owner, { tree, listProcesses: hidden(1001) }), { verdict: 'keep', why: 'tree-unknown' });
      // A snapshot records its supervisor's start time, clock and ancestors
      // where it lists processes (Linux and macOS), each as the listing
      // reads them now.
      await withTmp(async (dir) => {
        const snap = await lib.createPeerSnapshot({ cwd: makeDirtyRepo(dir), persona, env });
        const { fingerprint } = JSON.parse(readFileSync(snap.owner_path, 'utf8')).supervisor;
        if (process.platform === 'linux' || process.platform === 'darwin') {
          const lineage = await identity.processLineage(process.pid);
          deepStrictEqual([fingerprint.starttime, fingerprint.clock, fingerprint.ancestors], [lineage.starttime, lineage.clock, lineage.ancestors], JSON.stringify(fingerprint));
          ok(typeof fingerprint.clock === 'string' && fingerprint.ancestors.length > 0, JSON.stringify(fingerprint));
        }
        await lib.removePeerSnapshot(snap, { env });
      });
    });

    it('on Linux, a process of the user\'s own that hides its directory and started after the run\'s supervisor is placed outside the run by an ancestor that started before the supervisor and is neither init nor one of the supervisor\'s (C142 O-F1)', async () => {
      const tree = '/tmp/engineer-peer-snapshot-x/tree';
      // The supervisor (gone) ran under claude 450, in the shell 410 of the
      // tmux server 400; sshd 300, the session's other shell 420 and another
      // lane's claude 430 started before it.
      const supervisor = { pid: 500, fingerprint: { kind: 'linux_proc_starttime', starttime: '1000', command: 'node peer-runner.mjs', clock: CLOCK, ancestors: [{ pid: 450, starttime: '900' }, { pid: 410, starttime: '70' }, { pid: 400, starttime: '60' }, { pid: 1, starttime: '1' }] } };
      const machine = [
        { pid: 300, cwd: 'EACCES', uid: 0, starttime: 50 },
        { pid: 400, cwd: '/home/u', starttime: 60 },
        { pid: 410, cwd: '/home/u', ppid: 400, starttime: 70 },
        { pid: 420, cwd: '/home/u', ppid: 400, starttime: 80 },
        { pid: 430, cwd: '/home/u/lane', ppid: 400, starttime: 85 },
        { pid: 450, cwd: '/home/u/repo', ppid: 410, starttime: 900 },
        { pid: 605, cwd: '/home/u/lane', ppid: 430, starttime: 2050 },
        { pid: 715, cwd: '/x', starttime: 1550 },
      ];
      const occupancy = (hidden, judgedFor = supervisor, clock = {}) => lib.treeOccupancy(tree, {
        supervisor: judgedFor,
        listProcesses: () => identity.allProcessCwds({ clock: CLOCK, system: linuxSystem([...machine, { cwd: 'EACCES', ...hidden }], clock) }),
      });
      // Placed: the interactive codex in the older shell, another lane's
      // peer, a new ssh session's process, and a sudo in the older shell.
      const codex = { pid: 600, ppid: 420, starttime: 2000 };
      for (const placed of [codex, { pid: 610, ppid: 605, starttime: 2100 }, { pid: 620, ppid: 300, starttime: 2200 }, { pid: 630, ppid: 420, starttime: 2300 }]) {
        strictEqual(await occupancy(placed), 'none', JSON.stringify(placed));
      }
      // Not placed, and so possibly the run's: one left to init, one left to
      // a subreaper among the supervisor's ancestors (the tmux server), one
      // whose only ancestor that started before the run is init, and one
      // whose ancestors cannot be read.
      for (const unplaced of [{ pid: 700, starttime: 1500 }, { pid: 710, ppid: 400, starttime: 1500 }, { pid: 720, ppid: 715, starttime: 1600 }, { pid: 740, ppid: 999, starttime: 1600 }]) {
        strictEqual(await occupancy(unplaced), 'unknown', JSON.stringify(unplaced));
      }
      // A parent read and then left (its child's parent changed between the
      // two reads of its stat): its pid may since be another process's.
      strictEqual(await occupancy({ pid: 750, ppid: [420, 1], starttime: 1600 }), 'unknown');
      strictEqual(await occupancy({ pid: 750, ppid: [420, 420], starttime: 1600 }), 'none');
      // Nor is one placed against a supervisor whose ancestors were not
      // recorded (an earlier runner's record) or are no list a snapshot
      // writes, nor in another clock.
      strictEqual(await occupancy(codex, { pid: 500, fingerprint: { ...supervisor.fingerprint, ancestors: undefined } }), 'unknown');
      strictEqual(await occupancy(codex, { pid: 500, fingerprint: { ...supervisor.fingerprint, ancestors: [{ pid: 450 }] } }), 'unknown');
      strictEqual(await occupancy(codex, supervisor, { pidNamespace: 'pid:[2]' }), 'unknown');
      // The init of a pid namespace below the reader's adopts what a parent in
      // its namespace leaves, though it is no ancestor of that parent (F3,
      // refine-verify of the eighth review): it places nothing, and nor does
      // an ancestor whose namespace pid cannot be read. A process of such a
      // namespace that is not its init places as any other.
      const container = { pid: 1000, cwd: 'EACCES', uid: 0, starttime: 40, nspid: [1000, 1] };
      const occupancyWith = (extra, hidden) => lib.treeOccupancy(tree, { supervisor, listProcesses: () => identity.allProcessCwds({ clock: CLOCK, system: linuxSystem([...machine, extra, { cwd: 'EACCES', ...hidden }]) }) });
      strictEqual(await occupancyWith(container, { pid: 760, ppid: 1000, starttime: 1600 }), 'unknown');
      strictEqual(await occupancyWith({ ...container, nspid: null }, { pid: 760, ppid: 1000, starttime: 1600 }), 'unknown');
      strictEqual(await occupancyWith({ ...container, nspid: [1000, 7] }, { pid: 760, ppid: 1000, starttime: 1600 }), 'none');
      // A /proc mounted from another pid namespace numbers the reader, and
      // every pid, as that namespace does (F2 of the same review): it gives
      // no listing and no clock, though it lists a process under the
      // reader's pid.
      strictEqual(await identity.allProcessCwds({ clock: CLOCK, system: linuxSystem(machine, { self: '1040' }) }), null);
      strictEqual(await identity.clockDomain({ system: linuxSystem(machine, { self: '1040' }) }), null);
      strictEqual(await identity.processLineage(450, { system: linuxSystem(machine, { self: 'EACCES' }) }).then((l) => l.clock), null);
      // The judgments place it by the owner record's supervisor.
      const owner = { supervisor: { ...supervisor, pid: await deadPid() }, live_toplevel: '/r', tree, companion: null, created_at: new Date().toISOString() };
      const listing = (hidden) => () => identity.allProcessCwds({ clock: CLOCK, system: linuxSystem([...machine, { cwd: 'EACCES', ...hidden }]) });
      deepStrictEqual((await lib.snapshotEnded(owner, { tree, listProcesses: listing(codex) })).verdict, 'ended');
      deepStrictEqual((await lib.snapshotEnded(owner, { tree, listProcesses: listing({ pid: 700, starttime: 1500 }) })).why, 'tree-unknown');
      // The lineage a snapshot records for its supervisor, as the listing
      // reads a hidden process's.
      deepStrictEqual(await identity.processLineage(450, { system: linuxSystem(machine) }), { starttime: '900', clock: CLOCK, ancestors: [{ pid: 410, starttime: '70' }, { pid: 400, starttime: '60' }, { pid: 1, starttime: '1', reaper: true }] });
      strictEqual(await identity.processLineage(999, { system: linuxSystem(machine) }), null);
    });

    it('on Linux, a hidden process is placed outside the run only by its ancestors below the first init that may have adopted it: those above a pid namespace\'s init say nothing of it (C142 P-F3)', async () => {
      const tree = '/tmp/engineer-peer-snapshot-x/tree';
      // The supervisor (gone) ran under claude 450 of the tmux server 400.
      // sshd 300 started before it; a process of the run entered the pid
      // namespace of the container 1000 (whose init sshd started) and left a
      // child there, which that init adopted.
      const supervisor = { pid: await deadPid(), fingerprint: { kind: 'linux_proc_starttime', starttime: '1000', command: 'node peer-runner.mjs', clock: CLOCK, ancestors: [{ pid: 450, starttime: '900' }, { pid: 400, starttime: '60' }, { pid: 1, starttime: '1', reaper: true }] } };
      const machine = [
        { pid: 300, cwd: 'EACCES', uid: 0, starttime: 50 },
        { pid: 400, cwd: '/home/u', starttime: 60 },
        { pid: 450, cwd: '/home/u/repo', ppid: 400, starttime: 900 },
        { pid: 1000, cwd: 'EACCES', uid: 0, ppid: 300, starttime: 70, nspid: [1000, 1] },
      ];
      const listing = (hidden) => () => identity.allProcessCwds({ clock: CLOCK, system: linuxSystem([...machine, { cwd: 'EACCES', ...hidden }]) });
      const adopted = { pid: 760, ppid: 1000, starttime: 1600 };
      strictEqual(await lib.treeOccupancy(tree, { supervisor, listProcesses: listing(adopted) }), 'unknown');
      const owner = { supervisor, live_toplevel: '/r', tree, companion: null, created_at: new Date().toISOString() };
      const { verdict, why } = await lib.snapshotEnded(owner, { tree, listProcesses: listing(adopted) });
      deepStrictEqual([verdict, why], ['unknown', 'tree-unknown']);
      // Below that init, an ancestor that started before the supervisor still
      // places it: the container's shell 1010, started by its init.
      const shell = { pid: 1010, cwd: 'EACCES', uid: 0, ppid: 1000, starttime: 80, nspid: [1010, 7] };
      strictEqual(await lib.treeOccupancy(tree, { supervisor, listProcesses: () => identity.allProcessCwds({ clock: CLOCK, system: linuxSystem([...machine, shell, { cwd: 'EACCES', pid: 770, ppid: 1010, starttime: 1600 }]) }) }), 'none');
      // And above the host's init nothing is read: one left to it stays
      // unplaced, as before.
      strictEqual(await lib.treeOccupancy(tree, { supervisor, listProcesses: listing({ pid: 780, ppid: 1, starttime: 1600 }) }), 'unknown');
    });

    it('unknown: an owner record whose supervisor is not the one its run\'s handle keeps, or a handle whose kept supervisor the runner did not write, proves nothing (C142 M-F2)', async () => {
      const gone = { pid: await deadPid(), fingerprint: { kind: 'none', clock: HERE } };
      const live = await me();
      const dead = await deadPid();
      const companion = { pid: dead, pgid: dead, fingerprint: { kind: 'none' } };
      const launched = new Date().toISOString();
      const judgeWith = async (owner, handle) => {
        const { verdict, why } = await lib.snapshotEnded({ live_toplevel: '/r', tree: '/s/tree', companion, launched_at: launched, ...owner }, { handle, listProcesses: readable });
        return [verdict, why];
      };
      const processFields = { pid: null, pgid: null, peer_process: { pid: dead, pgid: dead } };
      const keeping = (supervisor) => ({ ...processFields, snapshot: { isolation: 'snapshot', supervisor } });
      // The record names an exited supervisor while the handle keeps a live
      // one, the same pid under another fingerprint, or another pid.
      for (const [recorded, kept] of [[gone, live], [{ pid: live.pid, fingerprint: { kind: 'none' } }, live], [gone, { pid: dead, fingerprint: { kind: 'none' } }]]) {
        deepStrictEqual(await judgeWith({ supervisor: recorded }, keeping(kept)), ['unknown', 'owner-incomplete'], JSON.stringify([recorded, kept]));
      }
      // A kept supervisor the runner did not write: null, one naming no pid
      // of a run's or no fingerprint, or a key absent beside a peer process.
      for (const handle of [
        keeping(null),
        keeping({ pid: 1, fingerprint: { kind: 'none' } }),
        keeping({ pid: String(gone.pid), fingerprint: { kind: 'none' } }),
        keeping({ pid: gone.pid }),
        keeping({ pid: gone.pid, fingerprint: null }),
        keeping([gone.pid]),
        { ...processFields, snapshot: { isolation: 'snapshot' } },
      ]) {
        deepStrictEqual(await judgeWith({ supervisor: gone }, handle), ['unknown', 'handle-malformed'], JSON.stringify(handle));
        deepStrictEqual(lib.handleSupervisor(handle), { malformed: true }, JSON.stringify(handle));
      }
      // The same supervisor in both, or a handle an earlier runner wrote (no
      // supervisor and no peer process kept), judge as the record alone.
      deepStrictEqual(await judgeWith({ supervisor: gone }, keeping(gone)), ['ended', 'owners-gone']);
      deepStrictEqual(lib.handleSupervisor(keeping(gone)), gone);
      const earlier = { pid: null, pgid: null, snapshot: { isolation: 'snapshot' } };
      strictEqual(lib.handleSupervisor(earlier), null);
      deepStrictEqual(await judgeWith({ supervisor: gone }, earlier), ['ended', 'owners-gone']);
      deepStrictEqual(await judgeWith({ supervisor: live }, keeping(live)), ['alive', 'supervisor-alive']);
    });
  });

  describe(`${persona}: peer snapshot — the ADR-0067 write guard (C96)`, () => {
    it('a live workflow stays writable while a snapshot exists in a repository that does not ignore the state home', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        rmSync(join(top, '.agentic-plugins'), { recursive: true, force: true });
        const { filePath } = await stateRoot.runInCommandDirectory(top, () => state.createWorkflow({
          repoRoot: top, verb: 'compose', originalRequest: 'guard', host: 'claude', currentPhase: 'p', nextAction: 'n',
          gitBaseline: { branch: 'main', head: git(top, 'rev-parse', 'HEAD').trim(), status_digest: '' },
        }));
        const snap = await lib.createPeerSnapshot({ cwd: top, persona, env });
        await stateRoot.runInCommandDirectory(top, () => state.assertWorkflowWritable(filePath));
        // Control: the same record copied into the snapshot is a second copy
        // the guard refuses, so the pass above is the exclusion's doing.
        const copy = join(snap.root, relative(top, filePath));
        mkdirSync(dirname(copy), { recursive: true });
        cpSync(filePath, copy);
        await rejects(stateRoot.runInCommandDirectory(top, () => state.assertWorkflowWritable(filePath)));
        await lib.removePeerSnapshot(snap, { env });
      });
    });
  });

  describe(`${persona}: peer-runner — a codex peer runs in the snapshot (C96)`, () => {
    const PEER_RUNNER = P.path('scripts/peer-runner.mjs');

    async function fixture(dir) {
      const top = makeDirtyRepo(dir);
      const companions = await writeFakeCompanions(dir);
      return { top, companions, record: join(dir, 'record.json') };
    }
    const fakeEnv = (f, mode, extra = {}) => ({ ...env, AGENTIC_COMPANIONS_ROOT: f.companions, FAKE_COMPANION_MODE: mode, FAKE_RECORD: f.record, ...extra });

    it('the vandal peer tidies only the snapshot; its paths and prompt name the snapshot; the snapshot is removed', async () => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const link = join(dir, 'link');
        symlinkSync(f.top, link);
        const before = liveView(f.top);
        const promptFile = join(dir, 'prompt.xml');
        const prompt = `<task>read ${f.top}/a and ${link}/sub/s, not ${f.top}-other/a</task>`;
        writeFileSync(promptFile, prompt);
        const result = await runner.runPeer({
          repoRoot: f.top, peer: 'codex', promptFile, cwd: link, outputFormat: 'json',
          env: fakeEnv(f, 'vandal', { GIT_DIR: join(f.top, '.git'), GIT_WORK_TREE: f.top }),
        });
        strictEqual(result.status, 'completed');
        // The run's own ledger is the one change the live tree may show.
        const sansLedger = (v) => ({ ...v, status: withoutStateHome(v.status) });
        deepStrictEqual(sansLedger(liveView(f.top)), sansLedger(before), 'the live tree and index are intact');
        ok(!existsSync(join(f.top, 'peer-wrote-this')));
        const rec = JSON.parse(readFileSync(f.record, 'utf8'));
        strictEqual(rec.cwd, result.snapshot.peer_cwd);
        ok(rec.cwd.startsWith(dirname(result.snapshot.root)) && relative(f.top, rec.cwd).startsWith('..'));
        ok(relative(f.top, rec.promptFile).startsWith('..'), 'the prompt copy is outside the checkout');
        strictEqual(rec.prompt, `<task>read ${result.snapshot.root}/a and ${result.snapshot.root}/sub/s, not ${f.top}-other/a</task>`);
        strictEqual(rec.gitDir, null, 'no git selector reaches the companion');
        strictEqual(readFileSync(promptFile, 'utf8'), prompt, 'the caller\'s prompt file is unchanged');
        strictEqual(result.snapshot.isolation, 'snapshot');
        strictEqual(result.snapshot.prompt_paths_rewritten, 2);
        ok(result.snapshot.removed_at);
        strictEqual(result.snapshot.cleanup_error, null);
        strictEqual((await runner.readHandle(result.handle_path)).snapshot.head, before.head);
        strictEqual(snapshotWorktrees(f.top).length, 0);
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('a failed peer run removes its snapshot too', async () => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const result = await runner.runPeer({ repoRoot: f.top, peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'fail') });
        strictEqual(result.status, 'failed');
        ok(result.snapshot.removed_at);
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('a run that throws once its snapshot exists (an unreadable prompt) ends failed, its snapshot removed, no companion run', async () => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const promptDir = join(dir, 'prompt-is-a-directory');
        mkdirSync(promptDir);
        await rejects(runner.runPeer({ repoRoot: f.top, runId: 'throws-1', peer: 'codex', promptFile: promptDir, cwd: f.top, env: fakeEnv(f, 'vandal') }), (e) => e.code === 'EISDIR');
        const handle = await runner.readHandle(runner.peerRunPaths(f.top, 'throws-1').handle);
        strictEqual(handle.status, 'failed');
        strictEqual(handle.error_kind, 'EISDIR');
        ok(handle.completed_at);
        strictEqual(handle.snapshot.isolation, 'snapshot');
        ok(handle.snapshot.removed_at);
        ok(!existsSync(f.record), 'no companion ran');
        deepStrictEqual(leftovers(snaps), []);
        strictEqual(snapshotWorktrees(f.top).length, 0);
      });
    });

    it('a cancellation still reaches the peer when the ledger refuses the write that records it running', async (t) => {
      if (process.getuid?.() === 0) return t.skip('root writes through a read-only directory');
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const ledger = runner.peerRunPaths(f.top, 'eacces-1').dir;
        const cancellation = runner.createRunCancellation();
        // The update that records the running peer is shown to the run, then
        // its write fails: the ledger directory is read-only from here on.
        const hooks = { beforeHandleWrite: (h) => { if (h.status === 'running') chmodSync(ledger, 0o500); } };
        const running = runner.runPeer({ repoRoot: f.top, runId: 'eacces-1', peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'hang'), cancellation, cancelGraceMs: 500, hooks });
        // Handled now, judged below: an early rejection must fail this test,
        // not end it while it still holds TMPDIR.
        running.catch(() => {});
        let pid = null;
        try {
          await waitFor(() => existsSync(f.record), { message: 'the companion to start' });
          pid = JSON.parse(readFileSync(f.record, 'utf8')).pid;
          await waitFor(() => (statSync(ledger).mode & 0o777) === 0o500, { message: 'the ledger to turn read-only' });
          cancellation.request('SIGTERM');
          await rejects(within(running, 'the run to end on the cancellation'), (e) => e.code === 'EACCES');
          ok(!alive(pid), 'the peer is stopped');
          // The write that would have recorded the running peer is the one
          // that failed: the ledger never left spawning.
          const onDisk = await runner.readHandle(runner.peerRunPaths(f.top, 'eacces-1').handle);
          strictEqual(onDisk.status, 'spawning');
          strictEqual(onDisk.pid ?? null, null);
          deepStrictEqual(leftovers(snaps), []);
          strictEqual(snapshotWorktrees(f.top).length, 0);
        } finally {
          chmodSync(ledger, 0o700);
          if (pid) killGroup(pid);
          await running.catch(() => {});
        }
      });
    });

    it('a cancellation that comes after the run read its handle and before the terminal write still ends it cancelled', async () => {
      await withTmp(async (dir) => {
        const f = await fixture(dir);
        const cancellation = runner.createRunCancellation();
        // The signal lands as the terminal record is about to be written.
        const hooks = { beforeHandleWrite: (h, before) => { if (h.status === 'completed' && before === 'running') cancellation.request('SIGTERM'); } };
        const result = await runner.runPeer({ repoRoot: f.top, peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'vandal'), cancellation, hooks });
        strictEqual(cancellation.signal, 'SIGTERM');
        strictEqual(result.status, 'cancelled');
        strictEqual(result.error_kind, 'cancelled');
        strictEqual((await runner.readHandle(result.handle_path)).status, 'cancelled');
      });
    });

    // The interleaving the refine review of 2026-10-13 reproduced: the peer
    // exits on its own while a `cancel` from another process is under way,
    // the run reads its handle (`running`) to compute the terminal status, and
    // the cancel's write — `cancel_requested`, or its last, `cancelled` —
    // lands before the terminal write. That read sits in the four-copy spawn
    // section, which has no seam, so the test writes the cancel's record from
    // inside the read itself: fs/promises' readFile, wrapped for this one run.
    for (const landed of ['cancel_requested', 'cancelled']) {
      it(`a cancel whose ${landed} record lands between the run's last read and its terminal write keeps the run cancelled`, async () => {
        await withTmp(async (dir) => {
          const f = await fixture(dir);
          const runId = `landed-${landed}`;
          const paths = runner.peerRunPaths(f.top, runId);
          const fsp = require('node:fs/promises');
          const readFile = fsp.readFile;
          let injected = false;
          fsp.readFile = async (path, ...rest) => {
            const text = await readFile(path, ...rest);
            // The first read of the handle once the envelope is written is
            // the one the terminal status is computed from.
            if (!injected && String(path) === paths.handle && existsSync(paths.envelope)) {
              injected = true;
              const h = JSON.parse(text);
              strictEqual(h.status, 'running', 'the run reads its peer running');
              writeFileSync(paths.handle, `${JSON.stringify({ ...h, status: landed, error_kind: 'cancelled' }, null, 2)}\n`);
            }
            return text;
          };
          syncBuiltinESMExports();
          let result;
          try {
            result = await runner.runPeer({ repoRoot: f.top, runId, peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'vandal') });
          } finally {
            fsp.readFile = readFile;
            syncBuiltinESMExports();
          }
          ok(injected, 'the cancel landed in the gap');
          strictEqual(result.status, 'cancelled');
          strictEqual(result.error_kind, 'cancelled');
          strictEqual((await runner.readHandle(result.handle_path)).status, 'cancelled');
        });
      });
    }

    it('a cancellation requested after the run ended signals nothing of its peer', async () => {
      await withTmp(async (dir) => {
        const f = await fixture(dir);
        const cancellation = runner.createRunCancellation();
        const result = await runner.runPeer({ repoRoot: f.top, peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'vandal'), cancellation, cancelGraceMs: 200 });
        strictEqual(result.status, 'completed');
        const { pid } = JSON.parse(readFileSync(f.record, 'utf8'));
        const sent = [];
        const kill = process.kill;
        process.kill = (target, sig) => {
          if (Math.abs(target) === pid) sent.push([target, sig]);
          return kill.call(process, target, sig);
        };
        try {
          cancellation.request('SIGTERM');
          await sleep(500);
        } finally {
          process.kill = kill;
        }
        deepStrictEqual(sent, [], 'the ended peer\'s pid and group, which may be another process\'s by now, get no signal');
        strictEqual((await runner.readHandle(result.handle_path)).status, 'completed');
      });
    });

    it('a claude peer is not isolated: it gets the directory it was given', async () => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const result = await runner.runPeer({ repoRoot: f.top, peer: 'claude', promptText: 'x', cwd: join(f.top, 'sub'), env: fakeEnv(f, 'record') });
        strictEqual(result.status, 'completed');
        strictEqual(JSON.parse(readFileSync(f.record, 'utf8')).cwd, join(f.top, 'sub'));
        deepStrictEqual(result.snapshot.isolation, 'none');
        strictEqual(result.snapshot.reason, 'peer-not-isolated');
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('a snapshot that cannot be made fails the run before any companion runs (snapshot_failed), and settles failed', async () => {
      await withTmp(async (dir) => {
        const f = { top: makeUnmergedRepo(dir), companions: await writeFakeCompanions(dir), record: join(dir, 'record.json') };
        const { filePath: workflowPath } = await stateRoot.runInCommandDirectory(f.top, () => state.createWorkflow({
          repoRoot: f.top, verb: 'compose', originalRequest: 'x', host: 'claude', currentPhase: 'p', nextAction: 'n',
          gitBaseline: { branch: 'main', head: git(f.top, 'rev-parse', 'HEAD').trim(), status_digest: '' },
        }));
        const result = await runner.runPeer({
          repoRoot: f.top, peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'vandal'),
          kind: 'ensemble', runId: 'snap-fail', workflowPath, phase: 'compose', ensembleType: 'plan-verify',
        });
        strictEqual(result.status, 'failed');
        strictEqual(result.error_kind, 'snapshot_failed');
        strictEqual(result.exit_code, null);
        strictEqual(result.snapshot.isolation, 'failed');
        strictEqual(result.snapshot.reason, 'unmerged-index');
        ok(!existsSync(f.record), 'no companion ran');
        const settled = await runner.settleEnsemble({ repoRoot: f.top, workflowPath, phase: 'compose', runId: 'snap-fail', verdict: 'agreed', summary: 's' });
        strictEqual(settled.verdict, 'failed');
        strictEqual(settled.error_kind, 'snapshot_failed');
      });
    });

    it('a cancellation requested before the spawn ends the run cancelled — the capture itself stopped — no companion, no snapshot left', async () => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const cancellation = runner.createRunCancellation();
        cancellation.request('SIGTERM');
        const result = await runner.runPeer({ repoRoot: f.top, peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'vandal'), cancellation });
        strictEqual(result.status, 'cancelled');
        strictEqual(result.snapshot.reason, 'cancelled');
        ok(!existsSync(f.record));
        deepStrictEqual(leftovers(snaps), []);
        strictEqual(snapshotWorktrees(f.top).length, 0);
      });
    });

    it('a child holding the companion\'s stdout open does not hold the run: it is stopped once the companion exits', async () => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const running = runner.runPeer({ repoRoot: f.top, peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'leaky'), cancelGraceMs: 300 });
        let grandchild = null;
        try {
          const result = await within(running, 'the run to end with a child holding its pipes');
          grandchild = JSON.parse(readFileSync(f.record, 'utf8')).grandchild;
          strictEqual(result.status, 'completed');
          await waitFor(() => !alive(grandchild), { timeoutMs: 5000, message: 'the child to be stopped' });
          ok(result.snapshot.removed_at);
          deepStrictEqual(leftovers(snaps), []);
        } finally {
          if (grandchild === null && existsSync(f.record)) grandchild = JSON.parse(readFileSync(f.record, 'utf8')).grandchild;
          if (grandchild) killGroup(grandchild);
        }
      });
    });

    it('a claude peer\'s leftover child is stopped too: the group outlives no run', async () => {
      await withTmp(async (dir) => {
        const f = await fixture(dir);
        const plain = join(dir, 'plain');
        mkdirSync(plain);
        const result = await runner.runPeer({ repoRoot: f.top, peer: 'claude', promptText: 'x', cwd: plain, env: fakeEnv(f, 'stubborn'), cancelGraceMs: 300 });
        const { grandchild } = JSON.parse(readFileSync(f.record, 'utf8'));
        try {
          strictEqual(result.status, 'completed');
          await waitFor(() => !alive(grandchild), { timeoutMs: 5000, message: 'the claude peer\'s child to be stopped' });
        } finally {
          killGroup(grandchild);
        }
      });
    });

    it('a codex peer outside any checkout still gets no git selector naming the live repository', async () => {
      await withTmp(async (dir) => {
        const f = await fixture(dir);
        const before = liveView(f.top);
        const plain = join(dir, 'plain');
        mkdirSync(plain);
        const result = await runner.runPeer({
          repoRoot: f.top, peer: 'codex', promptText: 'x', cwd: plain,
          env: fakeEnv(f, 'vandal', { GIT_DIR: join(f.top, '.git'), GIT_WORK_TREE: f.top }),
        });
        strictEqual(result.snapshot.isolation, 'none');
        strictEqual(JSON.parse(readFileSync(f.record, 'utf8')).gitDir, null);
        const sansLedger = (v) => ({ ...v, status: withoutStateHome(v.status) });
        deepStrictEqual(sansLedger(liveView(f.top)), sansLedger(before));
      });
    });

    it('cancelPeerRun on a running peer: the snapshot is removed when the run ends', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const running = runner.runPeer({ repoRoot: f.top, runId: 'cancel-me', peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'hang') });
        running.catch(() => {}); // judged below
        await waitFor(() => existsSync(f.record), { message: 'the companion to start' });
        const peerPid = JSON.parse(readFileSync(f.record, 'utf8')).pid;
        t.after(() => killGroup(peerPid));
        const handlePath = runner.peerRunPaths(f.top, 'cancel-me').handle;
        await waitFor(async () => (await runner.readHandle(handlePath)).status === 'running', { message: 'the run to be running' });
        const cancelled = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'cancel-me', graceMs: 2000 });
        strictEqual(cancelled.ok, true);
        const result = await within(running, 'the cancelled run to end');
        strictEqual(result.status, 'cancelled');
        ok(result.snapshot.removed_at);
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('a child the companion leaves running is stopped before the snapshot is removed', async () => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const result = await runner.runPeer({ repoRoot: f.top, peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'stubborn'), cancelGraceMs: 300 });
        strictEqual(result.status, 'completed');
        const { grandchild } = JSON.parse(readFileSync(f.record, 'utf8'));
        try {
          await waitFor(() => !alive(grandchild), { timeoutMs: 5000, message: 'the stubborn grandchild to be killed' });
        } finally {
          killGroup(grandchild);
        }
        ok(result.snapshot.removed_at);
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('concurrent runs get distinct snapshots, and both are removed', async () => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const run = (id) => runner.runPeer({ repoRoot: f.top, runId: id, peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'vandal', { FAKE_RECORD: join(dir, `${id}.json`) }) });
        const [a, b] = await Promise.all([run('c-1'), run('c-2')]);
        strictEqual(a.status, 'completed');
        strictEqual(b.status, 'completed');
        notStrictEqual(a.snapshot.root, b.snapshot.root);
        deepStrictEqual(leftovers(snaps), []);
        strictEqual(snapshotWorktrees(f.top).length, 0);
      });
    });

    it('the CLI ends on SIGTERM (repeated) with 143, a cancelled ledger, the peer stopped and the snapshot removed', async () => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const cli = spawn(process.execPath, [PEER_RUNNER, 'run', '--repo-root', f.top, '--run-id', 'sig-1', '--peer', 'codex', '--prompt-text', 'x', '--cwd', f.top, '--cancel-grace-ms', '1000'], {
          env: { ...fakeEnv(f, 'hang'), TMPDIR: snaps }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const exited = new Promise((r) => cli.once('exit', (code, signal) => r({ code, signal })));
        await waitFor(() => existsSync(f.record), { message: 'the companion to start' });
        const { pid } = JSON.parse(readFileSync(f.record, 'utf8'));
        try {
          cli.kill('SIGTERM');
          cli.kill('SIGTERM');
          deepStrictEqual(await within(exited, 'the CLI to exit'), { code: 143, signal: null });
          ok(!alive(pid), 'the peer is stopped');
        } finally {
          killGroup(pid);
          killGroup(cli.pid);
        }
        const handle = await runner.readHandle(runner.peerRunPaths(f.top, 'sig-1').handle);
        strictEqual(handle.status, 'cancelled');
        ok(handle.snapshot.removed_at);
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('a runner killed outright leaves a snapshot its live peer keeps; the next sweep reclaims it once the peer ends', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const cli = spawn(process.execPath, [PEER_RUNNER, 'run', '--repo-root', f.top, '--run-id', 'kill-1', '--peer', 'codex', '--prompt-text', 'x', '--cwd', f.top], {
          env: { ...fakeEnv(f, 'hang'), TMPDIR: snaps }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        await waitFor(() => existsSync(f.record), { message: 'the companion to start' });
        const { pid } = JSON.parse(readFileSync(f.record, 'utf8'));
        t.after(() => killGroup(pid));
        const [snap] = snapshotWorktrees(f.top);
        const owner = snap.locked.slice('peer-snapshot v1 '.length);
        await waitFor(() => JSON.parse(readFileSync(owner, 'utf8')).companion !== null, { message: 'the companion record' });
        cli.kill('SIGKILL');
        await new Promise((r) => cli.once('exit', r));
        let swept = await runner.sweepPeerRuns({ repoRoot: f.top });
        deepStrictEqual(swept.snapshots.kept.map((k) => k.why), ['companion-alive']);
        process.kill(-pid, 'SIGKILL');
        await waitFor(() => !groupAlive(pid), { message: 'the peer group to end' });
        swept = await runner.sweepPeerRuns({ repoRoot: f.top });
        deepStrictEqual(swept.snapshots.reclaimed.map((r) => r.why), ['owners-gone']);
        deepStrictEqual(leftovers(snaps), []);
      });
    });
  });

  // C142 — measured 2026-10-19: Claude Code ends a background task (the runner
  // a runbook started) by SIGTERM to its processes and SIGKILL about 1.5 s
  // later, which can land while the runner is still stopping its peer: the
  // runner dies before its cleanup, its snapshot and locked worktree stay, and
  // its handle stays cancel_requested. Whoever finds such a run finishes it,
  // cancel or settle, once its owner record proves it over.
  describe(`${persona}: peer-runner — a run its host killed before its cleanup (C142)`, () => {
    const PEER_RUNNER = P.path('scripts/peer-runner.mjs');
    const fixture = async (dir) => ({ top: makeDirtyRepo(dir), companions: await writeFakeCompanions(dir), record: join(dir, 'record.json') });
    const hosted = (t, f, snaps, runId, mode, extra = []) => startHostedRun(t, {
      runnerPath: PEER_RUNNER, readHandle: runner.readHandle, handlePath: runner.peerRunPaths(f.top, runId).handle, top: f.top, runId,
      env: { ...env, AGENTIC_COMPANIONS_ROOT: f.companions, FAKE_COMPANION_MODE: mode, FAKE_RECORD: f.record, TMPDIR: snaps }, extra,
      ready: () => existsSync(f.record),
    });
    // The leak, as the host leaves it: one snapshot, its worktree registered.
    const assertLeftover = (f, snaps) => {
      strictEqual(leftovers(snaps).length, 1, 'the snapshot directory is left');
      strictEqual(snapshotWorktrees(f.top).length, 1, 'its worktree is still registered');
    };
    const assertRemoved = (f, snaps) => {
      deepStrictEqual(leftovers(snaps), []);
      strictEqual(snapshotWorktrees(f.top).length, 0);
      strictEqual(git(f.top, 'for-each-ref', 'refs/heads/peer-snapshot'), '');
    };
    const cancelCli = (f, snaps, runId) => {
      const r = spawnSync(process.execPath, [PEER_RUNNER, 'cancel', '--run-id', runId, '--repo-root', f.top, '--cancel-grace-ms', '500'], { env: { ...env, TMPDIR: snaps }, encoding: 'utf8' });
      return { status: r.status, answer: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr };
    };
    const removedClean = { removed: true, skipped: null, error: null };

    it('the host leaves the snapshot and a cancel_requested handle; cancel finishes the run cancelled and removes that snapshot (exit 0)', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const run = await hosted(t, f, snaps, 'host-1', 'deaf');
        await hostTeardown(run, runner.readHandle);
        // The leak, reproduced first.
        strictEqual((await runner.readHandle(run.handlePath)).status, 'cancel_requested');
        assertLeftover(f, snaps);
        const r = cancelCli(f, snaps, 'host-1');
        strictEqual(r.status, 0, r.stderr);
        deepStrictEqual([r.answer.ok, r.answer.status, r.answer.reason, r.answer.snapshot_cleanup], [true, 'cancelled', 'ended', removedClean]);
        const h = await runner.readHandle(run.handlePath);
        deepStrictEqual([h.status, h.error_kind, h.pid, h.snapshot.cleanup_error], ['cancelled', 'cancelled', null, null]);
        ok(h.snapshot.removed_at);
        assertRemoved(f, snaps);
      });
    });

    // C142 O-F2 — the runners these cases start judge the suites' listing
    // (_peer-snapshot-listing.mjs, preloaded through cleanEnv's NODE_OPTIONS),
    // never the system's alone, or a removal they expect would hang on what
    // else runs on the machine. The listing is installed only by code loaded
    // into the runner: the variable that names an occupant is the preload's,
    // and a runner started without the preload never reads it.
    it('cancel judges the listing the suite preloads into it, and without the preload never reads the variable that listing reads (C142 O-F2)', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const run = await hosted(t, f, snaps, 'host-1l', 'deaf');
        await hostTeardown(run, runner.readHandle);
        const tree = JSON.parse(readFileSync(run.ownerPath, 'utf8')).tree;
        const handle = readFileSync(run.handlePath, 'utf8');
        const cancelWith = (given) => {
          const r = spawnSync(process.execPath, [PEER_RUNNER, 'cancel', '--run-id', 'host-1l', '--repo-root', f.top, '--cancel-grace-ms', '500'], { env: { ...given, TMPDIR: snaps, PEER_SNAPSHOT_TEST_OCCUPANT: join(tree, 'sub') }, encoding: 'utf8' });
          return { status: r.status, answer: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr };
        };
        // The preloaded listing names a process in the tree: the run is not
        // proven over, and nothing is written or removed.
        const kept = cancelWith(env);
        deepStrictEqual([kept.answer?.ok, kept.answer?.why], [false, 'tree-occupied'], kept.stderr);
        strictEqual(readFileSync(run.handlePath, 'utf8'), handle, 'nothing is written');
        assertLeftover(f, snaps);
        // Without the preload the system's listing is judged, the one
        // production judges (C142 P-F2): with a real process running in the
        // tree, it keeps the run for that process, and nothing is written or
        // removed. The occupant is the reason: a process read in the tree
        // decides before any process the listing could not read is weighed
        // (treeOccupancy), so a listing that drops it, or reads none, fails
        // here (C142, tenth review).
        const { NODE_OPTIONS: _preload, ...bare } = env;
        const occupant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { cwd: tree, stdio: 'ignore', detached: true });
        t.after(() => killGroup(occupant.pid));
        const occupied = cancelWith(bare);
        deepStrictEqual([occupied.answer?.ok, occupied.answer?.why], [false, 'tree-occupied'], `${JSON.stringify(occupied.answer)} ${occupied.stderr}`);
        strictEqual(readFileSync(run.handlePath, 'utf8'), handle, 'nothing is written');
        assertLeftover(f, snaps);
        const exited = new Promise((done) => occupant.once('exit', done));
        killGroup(occupant.pid);
        await exited;
        // With that process gone, the system's listing names none in the
        // tree. It may still keep the snapshot (a process of the machine's it
        // could not read), so only the occupant is asserted unread, never a
        // removal.
        const unhooked = cancelWith(bare);
        ok(unhooked.answer, `the runner answers: ${unhooked.stderr}`);
        notStrictEqual(unhooked.answer?.why, 'tree-occupied', unhooked.stderr);
        ok(unhooked.answer?.snapshot_cleanup?.skipped !== 'tree-occupied', unhooked.stderr);
      });
    });

    it('while its supervisor lives, cannot be told, or its owner record proves nothing of it, cancel writes and removes nothing, and never answers not_running', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const run = await hosted(t, f, snaps, 'host-1r', 'deaf');
        await hostTeardown(run, runner.readHandle);
        const handle = readFileSync(run.handlePath, 'utf8');
        const owner = readFileSync(run.ownerPath, 'utf8');
        // A process of no run's, leading a group of its own under the pid a record names.
        const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', detached: true });
        t.after(() => killGroup(other.pid));
        // A group whose leader is gone and whose child runs on in the run's
        // tree, as a companion's would be after its leader exited.
        const leader = { pid: await leaderlessGroup(t, JSON.parse(owner).tree) };
        // A group whose leader is gone and whose child runs elsewhere: one
        // another process started under an id once the companion's, and left.
        const stray = await leaderlessGroup(t, dir);
        // A live supervisor read under another fingerprint (C141's locale, an
        // incomplete record): `differ`, which is no proof it is gone.
        const fingerprint = await identity.fingerprintForPid(process.pid);
        const differ = { pid: process.pid, fingerprint: { ...fingerprint, lstart: 'Thu Jan  1 00:00:00 1970', starttime: '1' } };
        // The handle and the owner record naming one companion, as the runner
        // writes them: `leader`, or `stray`.
        const asLeader = (h) => { h.pid = leader.pid; h.pgid = leader.pid; h.peer_process = { pid: leader.pid, pgid: leader.pid }; h.process_fingerprint = { kind: 'none' }; };
        const asStray = (h) => { h.pid = stray; h.pgid = stray; h.peer_process = { pid: stray, pgid: stray }; h.process_fingerprint = { kind: 'none' }; };
        for (const [edit, reason, why, editHandle] of [
          // C142 — a group whose leader is gone, its supervisor gone too, and
          // nothing of it in the run's tree: its id proves nothing, so it is
          // not stopped as the run's.
          [(o) => { o.companion = { pid: stray, pgid: stray, fingerprint: { kind: 'none' } }; }, 'supervisor_unknown', 'companion-untied', asStray],
          // The tree a group must run in is the one beside the record, never
          // the record's own: a record naming `/` ties nothing.
          [(o) => { o.tree = '/'; o.companion = { pid: stray, pgid: stray, fingerprint: { kind: 'none' } }; }, 'supervisor_unknown', 'companion-untied', asStray],
          // A supervisor at work or that cannot be told, the record and the
          // handle keeping the same one, as the runner writes them.
          [async (o, h) => { o.supervisor = h.snapshot.supervisor = { pid: process.pid, fingerprint: await identity.fingerprintForPid(process.pid) }; }, 'supervisor_alive', 'supervisor-alive'],
          [(o, h) => { o.supervisor = h.snapshot.supervisor = { pid: process.pid, fingerprint: { kind: 'none' } }; }, 'supervisor_unknown', 'supervisor-unknown'],
          [(o, h) => { o.supervisor = h.snapshot.supervisor = differ; }, 'supervisor_unknown', 'supervisor-unknown'],
          [(o, h) => { o.supervisor = h.snapshot.supervisor = { pid: process.pid, fingerprint: { kind: fingerprint.kind } }; }, 'supervisor_unknown', 'supervisor-unknown'],
          // Its companion's group left running: not stopped as the run's, the
          // supervisor not proven gone.
          [(o, h) => { o.supervisor = h.snapshot.supervisor = differ; o.companion = { pid: leader.pid, pgid: leader.pid, fingerprint: { kind: 'none' } }; }, 'supervisor_unknown', 'companion-alive', asLeader],
          // C142 M-F2 — a record naming another supervisor than the handle
          // keeps (an exited one, the handle's at work), or a handle keeping
          // one the runner did not write.
          [(o) => { o.supervisor = { pid: o.supervisor.pid, fingerprint: { kind: 'none' } }; }, 'supervisor_unknown', 'owner-incomplete', async (h) => { h.snapshot.supervisor = { pid: process.pid, fingerprint: await identity.fingerprintForPid(process.pid) }; }],
          [() => {}, 'supervisor_unknown', 'handle-malformed', (h) => { h.snapshot.supervisor = null; }],
          [() => {}, 'supervisor_unknown', 'handle-malformed', (h) => { delete h.snapshot.supervisor; }],
          // C142 M-F1 — the supervisor and the companion's group both gone,
          // and a process outside that group still runs in the tree (the
          // leaderless group above): the run is not over.
          [() => {}, 'supervisor_unknown', 'tree-occupied'],
          [(o) => { delete o.supervisor; }, 'supervisor_unknown', 'owner-incomplete'],
          // A supervisor pid past the range a pid takes names no process: the
          // record and the handle keeping the same one, as the runner copies
          // it, so the range alone decides (M-F2's cross-check answers
          // first for a record the handle disagrees with).
          [(o, h) => { o.supervisor = h.snapshot.supervisor = { pid: 2 ** 32, fingerprint: { kind: 'none' } }; }, 'supervisor_unknown', 'handle-malformed'],
          [(o) => { o.run_id = 'another-run'; }, 'supervisor_unknown', 'owner-of-another-run'],
          // C142 — a companion named without its group or pid.
          [(o) => { o.companion.pgid = null; }, 'supervisor_unknown', 'owner-incomplete'],
          [(o) => { o.companion.pid = String(o.companion.pid); }, 'supervisor_unknown', 'owner-incomplete'],
          // A group the companion does not lead: another process's.
          [(o) => { o.companion.pgid = other.pid; }, 'supervisor_unknown', 'owner-incomplete'],
          // A record that names another companion than the handle does, a
          // live group under it included, or none, whatever its launch says.
          [(o) => { o.companion = { pid: other.pid, pgid: other.pid, fingerprint: { kind: 'none' } }; }, 'supervisor_unknown', 'owner-incomplete'],
          [(o) => { o.companion = { pid: leader.pid, pgid: leader.pid, fingerprint: { kind: 'none' } }; }, 'supervisor_unknown', 'owner-incomplete'],
          [(o) => { o.companion = null; delete o.launched_at; }, 'supervisor_unknown', 'owner-incomplete'],
          [(o) => { o.companion = null; }, 'supervisor_unknown', 'owner-incomplete'],
          // C142 — a handle whose group field the runner did not write (a
          // numeric string) beside the run's own live group: never read as
          // naming no group, so the run is not finished while that group runs.
          [(o) => { o.companion = { pid: leader.pid, pgid: leader.pid, fingerprint: { kind: 'none' } }; }, 'supervisor_unknown', 'handle-malformed', (h) => { asLeader(h); h.pgid = String(leader.pid); }],
        ]) {
          const h = JSON.parse(handle);
          await editHandle?.(h);
          const o = JSON.parse(owner);
          await edit(o, h);
          const before = JSON.stringify(h);
          writeFileSync(run.handlePath, before);
          writeFileSync(run.ownerPath, JSON.stringify(o));
          const r = cancelCli(f, snaps, 'host-1r');
          strictEqual(r.status, 1, r.stderr);
          deepStrictEqual([r.answer.ok, r.answer.reason, r.answer.why, r.answer.status], [false, reason, why, 'cancel_requested'], JSON.stringify(o.companion));
          strictEqual(readFileSync(run.handlePath, 'utf8'), before, 'the handle is as it was');
          assertLeftover(f, snaps);
        }
        ok(alive(other.pid), 'a group the record cannot prove the run\'s is never signalled');
        ok(groupAlive(leader.pid), 'a group left under a supervisor not proven gone is never signalled');
        ok(groupAlive(stray), 'a group whose leader is gone and that nothing ties to the run is never signalled');
      });
    });

    it('a snapshot a reclaim removed leaves no owner record: cancel refuses while the handle is fresh, and finishes the run once it is stale', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const run = await hosted(t, f, snaps, 'host-1g', 'deaf');
        await hostTeardown(run, runner.readHandle);
        deepStrictEqual((await lib.reclaimPeerSnapshots({ cwd: f.top, env })).reclaimed.map((x) => x.why), ['owners-gone']);
        assertRemoved(f, snaps);
        let answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-1g', graceMs: 300 });
        deepStrictEqual([answer.ok, answer.reason, answer.why], [false, 'supervisor_unknown', 'owner-unreadable']);
        const stale = new Date(Date.now() - 2 * runner.DEFAULT_STALE_GRACE_MS).toISOString();
        editJson(run.handlePath, (h) => { h.updated_at = stale; });
        answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-1g', graceMs: 300 });
        deepStrictEqual([answer.ok, answer.status, answer.reason, answer.snapshot_cleanup], [true, 'cancelled', 'ended', { removed: true, skipped: null, error: null, already_gone: true }]);
        ok((await runner.readHandle(run.handlePath)).snapshot.removed_at);
      });
    });

    it('a snapshot a reclaim removed is no proof its supervisor is gone: cancel finishes the run, live or terminal, only once the supervisor its handle keeps is gone (C142)', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const run = await hosted(t, f, snaps, 'host-1s', 'deaf');
        await hostTeardown(run, runner.readHandle);
        const kept = (await runner.readHandle(run.handlePath)).snapshot.supervisor;
        deepStrictEqual(kept, JSON.parse(readFileSync(run.ownerPath, 'utf8')).supervisor, 'the handle keeps the owner record\'s supervisor');
        deepStrictEqual((await lib.reclaimPeerSnapshots({ cwd: f.top, env })).reclaimed.map((x) => x.why), ['owners-gone']);
        const stale = new Date(Date.now() - 2 * runner.DEFAULT_STALE_GRACE_MS).toISOString();
        const live = { pid: process.pid, fingerprint: await identity.fingerprintForPid(process.pid) };
        const untold = { pid: process.pid, fingerprint: { kind: 'none' } };
        // A live run, stale: a supervisor at work, or one that cannot be
        // told, still owns its end.
        for (const [supervisor, reason, why] of [[live, 'supervisor_alive', 'snapshot-gone-supervisor-match'], [untold, 'supervisor_unknown', 'snapshot-gone-supervisor-unknown'], [{ pid: 1 }, 'supervisor_unknown', 'snapshot-gone-supervisor-malformed']]) {
          editJson(run.handlePath, (h) => { h.updated_at = stale; h.snapshot.supervisor = supervisor; });
          const before = readFileSync(run.handlePath, 'utf8');
          const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-1s', graceMs: 300 });
          deepStrictEqual([answer.ok, answer.reason, answer.why], [false, reason, why]);
          strictEqual(readFileSync(run.handlePath, 'utf8'), before, `${why}: nothing is written`);
        }
        // A terminal run: nothing signalled, the removal not recorded.
        editJson(run.handlePath, (h) => Object.assign(h, { status: 'completed', error_kind: null, completed_at: stale, pid: null, pgid: null, process_fingerprint: { kind: 'none' } }, { snapshot: { ...h.snapshot, supervisor: untold } }));
        let answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-1s', graceMs: 300 });
        deepStrictEqual([answer.ok, answer.reason, answer.snapshot_cleanup], [true, 'already_terminal', { removed: false, skipped: 'supervisor-unknown', error: null }]);
        strictEqual((await runner.readHandle(run.handlePath)).snapshot.removed_at, null);
        // Its supervisor gone, the removal is recorded.
        editJson(run.handlePath, (h) => { h.snapshot.supervisor = kept; });
        answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-1s', graceMs: 300 });
        deepStrictEqual([answer.ok, answer.reason, answer.snapshot_cleanup], [true, 'already_terminal', { removed: true, skipped: null, error: null, already_gone: true }]);
      });
    });

    it('a process the companion left in a group of its own runs on in the tree: the reclaim keeps the snapshot until it is old, and cancel, live or terminal, finishes nothing while that process runs in the removed tree (C142 M-F1)', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const run = await hosted(t, f, snaps, 'host-1o', 'deaf');
        await hostTeardown(run, runner.readHandle);
        const tree = JSON.parse(readFileSync(run.ownerPath, 'utf8')).tree;
        // The supervisor and the companion's group both gone; a process of
        // another group runs in the tree.
        const own = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { cwd: tree, stdio: 'ignore', detached: true });
        t.after(() => killGroup(own.pid));
        await waitFor(async () => (await lib.treeOccupancy(tree, { supervisor: { fingerprint: { clock: HERE } } })) === 'occupied', { message: 'the process to run in the tree' });
        deepStrictEqual((await lib.reclaimPeerSnapshots({ cwd: f.top, env })).kept.map((x) => x.why), ['tree-occupied']);
        assertLeftover(f, snaps);
        // Old, it is reclaimed on age, the process left running.
        deepStrictEqual((await lib.reclaimPeerSnapshots({ cwd: f.top, env, ttlMs: 0 })).reclaimed.map((x) => x.why), ['tree-occupied-expired']);
        assertRemoved(f, snaps);
        ok(alive(own.pid), 'the reclaim signals nothing');
        const stale = new Date(Date.now() - 2 * runner.DEFAULT_STALE_GRACE_MS).toISOString();
        editJson(run.handlePath, (h) => { h.updated_at = stale; });
        const before = readFileSync(run.handlePath, 'utf8');
        let answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-1o', graceMs: 300 });
        deepStrictEqual([answer.ok, answer.reason, answer.why], [false, 'supervisor_unknown', 'snapshot-gone-tree-occupied']);
        strictEqual(readFileSync(run.handlePath, 'utf8'), before, 'nothing is written');
        editJson(run.handlePath, (h) => Object.assign(h, { status: 'completed', error_kind: null, completed_at: stale, pid: null, pgid: null, process_fingerprint: { kind: 'none' } }));
        answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-1o', graceMs: 300 });
        deepStrictEqual([answer.ok, answer.reason, answer.snapshot_cleanup], [true, 'already_terminal', { removed: false, skipped: 'tree-occupied', error: null }]);
        strictEqual((await runner.readHandle(run.handlePath)).snapshot.removed_at, null, 'no removal is recorded');
        ok(alive(own.pid), 'cancel signals nothing outside the group its handle names');
        // That process ended, the removal is recorded.
        killGroup(own.pid);
        await waitFor(() => !alive(own.pid), { message: 'the process to end' });
        answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-1o', graceMs: 300 });
        deepStrictEqual([answer.ok, answer.reason, answer.snapshot_cleanup], [true, 'already_terminal', { removed: true, skipped: null, error: null, already_gone: true }]);
      });
    });

    it('a snapshot a reclaim removed on age alone is no proof its peer stopped: cancel stops what is left of the companion\'s group before it finishes the run, and signals none of it while the supervisor its handle keeps is at work or cannot be told', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const run = await hosted(t, f, snaps, 'host-1a', 'deaf-family');
        const { grandchild } = JSON.parse(readFileSync(f.record, 'utf8'));
        t.after(() => killGroup(grandchild));
        process.kill(-run.cli.pid, 'SIGKILL');
        process.kill(run.companion.pid, 'SIGKILL');
        await within(run.exited, 'the runner to die');
        await waitFor(() => !alive(run.companion.pid), { message: 'the companion leader to be gone' });
        ok(groupAlive(run.companion.pgid) && alive(grandchild), 'its group lives on');
        // A companion the record never named: the reclaim cannot tell its
        // identity, and removes the snapshot on age while the group runs.
        editJson(run.ownerPath, (o) => { o.companion = null; });
        deepStrictEqual((await lib.reclaimPeerSnapshots({ cwd: f.top, env, ttlMs: 0 })).reclaimed.map((x) => x.why), ['identity-unknown-expired']);
        assertRemoved(f, snaps);
        ok(alive(grandchild), 'the reclaim left the group running');
        // Fresh, the handle may still be its supervisor's to write: refused,
        // and nothing of the group signalled (C142, refine-verify of the
        // seventeenth review's X-F1).
        editJson(run.handlePath, (h) => { h.updated_at = new Date().toISOString(); });
        const fresh = readFileSync(run.handlePath, 'utf8');
        const waited = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-1a', graceMs: 300 });
        deepStrictEqual([waited.ok, waited.reason, waited.why], [false, 'supervisor_unknown', 'owner-unreadable']);
        strictEqual(readFileSync(run.handlePath, 'utf8'), fresh, 'fresh: nothing is written');
        await sleep(250);
        deepStrictEqual(sigtermsSeen(f.record), [], 'fresh: nothing of the group is signalled');
        const stale = new Date(Date.now() - 2 * runner.DEFAULT_STALE_GRACE_MS).toISOString();
        // While the supervisor the handle keeps is at work, or cannot be
        // told, the group is never signalled, before or after the refusal:
        // the child ignores SIGTERM, so its log, not its survival, shows that
        // (C142, seventeenth review's X-F1).
        const kept = (await runner.readHandle(run.handlePath)).snapshot.supervisor;
        const live = { pid: process.pid, fingerprint: await identity.fingerprintForPid(process.pid) };
        const untold = { pid: process.pid, fingerprint: { kind: 'none' } };
        for (const [supervisor, reason, why] of [[live, 'supervisor_alive', 'snapshot-gone-supervisor-match'], [untold, 'supervisor_unknown', 'snapshot-gone-supervisor-unknown']]) {
          editJson(run.handlePath, (h) => { h.updated_at = stale; h.snapshot.supervisor = supervisor; });
          const before = readFileSync(run.handlePath, 'utf8');
          const refused = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-1a', graceMs: 300 });
          deepStrictEqual([refused.ok, refused.reason, refused.why], [false, reason, why]);
          strictEqual(readFileSync(run.handlePath, 'utf8'), before, `${why}: nothing is written`);
          await sleep(250);
          deepStrictEqual(sigtermsSeen(f.record), [], `${why}: nothing of the group is signalled`);
          ok(alive(grandchild) && groupAlive(run.companion.pgid), `${why}: the group runs on`);
        }
        editJson(run.handlePath, (h) => { h.updated_at = stale; h.snapshot.supervisor = kept; });
        const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-1a', graceMs: 300 });
        ok(!alive(grandchild), 'the child left in the group is stopped');
        ok(!groupAlive(run.companion.pgid));
        ok(sigtermsSeen(f.record).includes('child'), 'the log sees the SIGTERM the stop sends');
        deepStrictEqual([answer.ok, answer.status, answer.reason, answer.snapshot_cleanup], [true, 'cancelled', 'ended', { removed: true, skipped: null, error: null, already_gone: true }]);
      });
    });

    it('a terminal run whose snapshot a reclaim removed on age alone: cancel stops what is left of the group its handle names before it answers', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const run = await hosted(t, f, snaps, 'host-1t', 'deaf-family');
        const { grandchild } = JSON.parse(readFileSync(f.record, 'utf8'));
        t.after(() => killGroup(grandchild));
        process.kill(-run.cli.pid, 'SIGKILL');
        process.kill(run.companion.pid, 'SIGKILL');
        await within(run.exited, 'the runner to die');
        await waitFor(() => !alive(run.companion.pid), { message: 'the companion leader to be gone' });
        editJson(run.ownerPath, (o) => { o.companion = null; });
        deepStrictEqual((await lib.reclaimPeerSnapshots({ cwd: f.top, env, ttlMs: 0 })).reclaimed.map((x) => x.why), ['identity-unknown-expired']);
        // The runner wrote its answer before it was killed; a reconcile makes
        // the run terminal from it, its group still named on the handle.
        const p = runner.peerRunPaths(f.top, 'host-1t');
        writeFileSync(p.envelope, JSON.stringify({ status: 'success', peer_host: 'codex', peer_model: null, stdout: 'peer answer', exit_code: 0 }));
        const reconciled = await runner.reconcileOne(p, await runner.readHandle(p.handle), { staleGraceMs: 1, now: new Date() });
        deepStrictEqual([reconciled.status, reconciled.pgid], ['completed', run.companion.pgid]);
        ok(alive(grandchild), 'the group runs on');
        // While the supervisor its handle keeps cannot be told, that group is
        // never signalled, before or after the refusal (C142, refine-verify
        // of the sixteenth review's W-F1).
        const kept = reconciled.snapshot.supervisor;
        editJson(p.handle, (h) => { h.snapshot.supervisor = { pid: process.pid, fingerprint: { kind: 'none' } }; });
        let answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-1t', graceMs: 300 });
        deepStrictEqual([answer.ok, answer.reason, answer.snapshot_cleanup], [true, 'already_terminal', { removed: false, skipped: 'supervisor-unknown', error: null }]);
        ok(alive(grandchild) && groupAlive(run.companion.pgid), 'nothing of the group is signalled while its supervisor cannot be told');
        // The child ignores SIGTERM: its log, not its survival, shows none came
        // (C142, seventeenth review's X-F1).
        await sleep(250);
        deepStrictEqual(sigtermsSeen(f.record), [], 'no SIGTERM reaches the group while its supervisor cannot be told');
        editJson(p.handle, (h) => { h.snapshot.supervisor = kept; });
        answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-1t', graceMs: 300 });
        ok(!alive(grandchild) && !groupAlive(run.companion.pgid), 'the child left in the group is stopped');
        ok(sigtermsSeen(f.record).includes('child'), 'the log sees the SIGTERM the stop sends');
        deepStrictEqual([answer.ok, answer.status, answer.reason, answer.snapshot_cleanup], [true, 'completed', 'already_terminal', { removed: true, skipped: null, error: null, already_gone: true }]);
      });
    });

    it('a terminal run whose handle\'s pid and pgid a later write cleared: cancel stops what is left of the group its kept peer process names before it answers', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const run = await hosted(t, f, snaps, 'host-1k', 'deaf-family');
        const { grandchild } = JSON.parse(readFileSync(f.record, 'utf8'));
        t.after(() => killGroup(grandchild));
        process.kill(-run.cli.pid, 'SIGKILL');
        process.kill(run.companion.pid, 'SIGKILL');
        await within(run.exited, 'the runner to die');
        await waitFor(() => !alive(run.companion.pid), { message: 'the companion leader to be gone' });
        editJson(run.ownerPath, (o) => { o.companion = null; });
        deepStrictEqual((await lib.reclaimPeerSnapshots({ cwd: f.top, env, ttlMs: 0 })).reclaimed.map((x) => x.why), ['identity-unknown-expired']);
        // An orphan write made the run terminal and cleared its pid and pgid;
        // the peer process the runner kept names the group still.
        editJson(run.handlePath, (h) => Object.assign(h, { status: 'failed', error_kind: 'orphaned', completed_at: new Date().toISOString(), pid: null, pgid: null, process_fingerprint: { kind: 'none' } }));
        deepStrictEqual((await runner.readHandle(run.handlePath)).peer_process, { pid: run.companion.pid, pgid: run.companion.pgid });
        ok(alive(grandchild), 'the group runs on in the removed tree');
        const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-1k', graceMs: 300 });
        ok(!alive(grandchild) && !groupAlive(run.companion.pgid), 'the child left in the group is stopped');
        deepStrictEqual([answer.ok, answer.status, answer.reason, answer.snapshot_cleanup], [true, 'failed', 'already_terminal', { removed: true, skipped: null, error: null, already_gone: true }]);
      });
    });

    it('a terminal run whose owner record and handle agree on a live group that cannot be told, or on a group whose leader is gone and nothing of which runs in its tree: cancel signals neither and keeps the snapshot', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const run = await hosted(t, f, snaps, 'host-1w', 'deaf');
        await hostTeardown(run, runner.readHandle);
        // A process of no run's, alive and leading its own group, its
        // fingerprint not recorded: its identity cannot be told.
        const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', detached: true });
        t.after(() => killGroup(other.pid));
        // A group whose leader is gone, its child running outside the tree.
        const stray = await leaderlessGroup(t, dir);
        const terminal = { status: 'completed', error_kind: null, completed_at: new Date().toISOString(), pid: null, pgid: null, process_fingerprint: { kind: 'none' } };
        for (const [pid, why] of [[other.pid, 'companion-unknown'], [stray, 'companion-untied']]) {
          // As the runner writes them: one companion in the record and in
          // the handle's kept peer process, its supervisor (the killed
          // runner) gone.
          editJson(run.handlePath, (h) => Object.assign(h, terminal, { peer_process: { pid, pgid: pid } }));
          editJson(run.ownerPath, (o) => { o.companion = { pid, pgid: pid, fingerprint: { kind: 'none' } }; });
          const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-1w', graceMs: 300 });
          deepStrictEqual([answer.ok, answer.status, answer.reason, answer.snapshot_cleanup], [true, 'completed', 'already_terminal', { removed: false, skipped: why, error: null }], why);
          ok(alive(other.pid) && groupAlive(stray), `${why}: nothing is signalled`);
          strictEqual((await runner.readHandle(run.handlePath)).snapshot.removed_at, null, `${why}: no removal is recorded`);
          assertLeftover(f, snaps);
        }
      });
    });

    it('a terminal run whose owner record still exists but cannot be read: cancel signals nothing of the group its handle names, and keeps the snapshot', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const run = await hosted(t, f, snaps, 'host-1u', 'deaf-family');
        const { grandchild } = JSON.parse(readFileSync(f.record, 'utf8'));
        t.after(() => killGroup(grandchild));
        process.kill(-run.cli.pid, 'SIGKILL');
        process.kill(run.companion.pid, 'SIGKILL');
        await within(run.exited, 'the runner to die');
        await waitFor(() => !alive(run.companion.pid), { message: 'the companion leader to be gone' });
        // The record is there, unreadable: it may name a supervisor still at
        // work, so it proves nothing, and the snapshot is not gone.
        writeFileSync(run.ownerPath, '{');
        const p = runner.peerRunPaths(f.top, 'host-1u');
        writeFileSync(p.envelope, JSON.stringify({ status: 'success', peer_host: 'codex', peer_model: null, stdout: 'peer answer', exit_code: 0 }));
        deepStrictEqual((await runner.reconcileOne(p, await runner.readHandle(p.handle), { staleGraceMs: 1, now: new Date() })).pgid, run.companion.pgid);
        const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-1u', graceMs: 300 });
        ok(alive(grandchild), 'a group under an owner record that cannot be read is never signalled');
        // The child ignores SIGTERM: its log shows none came (C142 X-F1).
        await sleep(250);
        deepStrictEqual(sigtermsSeen(f.record), [], 'no SIGTERM reaches the group under an owner record that cannot be read');
        deepStrictEqual([answer.ok, answer.status, answer.reason, answer.snapshot_cleanup?.removed, answer.snapshot_cleanup?.skipped], [true, 'completed', 'already_terminal', false, 'owner-unreadable']);
        assertLeftover(f, snaps);
        strictEqual((await runner.readHandle(p.handle)).snapshot.removed_at, null);
      });
    });

    it('a group its handle names is signalled only while the handle\'s own process, its leader, is gone or still the one recorded: another process\'s group under that id is never stopped, live run or terminal', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const run = await hosted(t, f, snaps, 'host-1v', 'deaf');
        await hostTeardown(run, runner.readHandle);
        deepStrictEqual((await lib.reclaimPeerSnapshots({ cwd: f.top, env })).reclaimed.map((x) => x.why), ['owners-gone']);
        // A process of no run's, leading a group under an id the handle keeps.
        const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', detached: true });
        t.after(() => killGroup(other.pid));
        // A group whose leader is gone, nothing of it in the run's tree: one
        // another process started under an id once the companion's, and left.
        const stray = await leaderlessGroup(t, dir);
        const recorded = (await runner.readHandle(run.handlePath)).process_fingerprint;
        const stale = new Date(Date.now() - 2 * runner.DEFAULT_STALE_GRACE_MS).toISOString();
        const terminal = { status: 'completed', error_kind: null, completed_at: stale, updated_at: stale };
        const kept = (pid) => ({ peer_process: { pid, pgid: pid } });
        for (const [fields, why] of [
          // A live run, stale, its own process gone. A group the handle's
          // process did not lead, or one named as a string, is a handle the
          // runner did not write: no group of it is signalled.
          [{ updated_at: stale, pid: run.companion.pid, pgid: other.pid, process_fingerprint: recorded }, 'snapshot-gone-handle-malformed'],
          [{ updated_at: stale, pid: run.companion.pid, pgid: String(run.companion.pid), process_fingerprint: recorded }, 'snapshot-gone-handle-malformed'],
          // Its group's leader gone, and nothing of the group in its tree.
          [{ updated_at: stale, pid: stray, pgid: stray, ...kept(stray), process_fingerprint: { kind: 'none' } }, 'snapshot-gone-group-untied'],
          // A terminal run, as an envelope's reconcile leaves it: the pid now another process's, or one that cannot be told.
          [{ ...terminal, pid: other.pid, pgid: other.pid, ...kept(other.pid), process_fingerprint: recorded }, 'owner-unreadable-group-leader-differ'],
          [{ ...terminal, pid: other.pid, pgid: other.pid, ...kept(other.pid), process_fingerprint: { kind: 'none' } }, 'owner-unreadable-group-leader-unknown'],
          // Its pid and pgid cleared (the run's end, an orphan write): the
          // peer process it keeps names the group, judged the same way.
          [{ ...terminal, pid: null, pgid: null, ...kept(other.pid), process_fingerprint: { kind: 'none' } }, 'owner-unreadable-group-leader-unknown'],
          [{ ...terminal, pid: null, pgid: null, ...kept(stray), process_fingerprint: { kind: 'none' } }, 'owner-unreadable-group-untied'],
          [{ ...terminal, pid: null, pgid: null, peer_process: { pid: String(other.pid), pgid: other.pid }, process_fingerprint: { kind: 'none' } }, 'owner-unreadable-handle-malformed'],
        ]) {
          editJson(run.handlePath, (h) => Object.assign(h, fields));
          const before = readFileSync(run.handlePath, 'utf8');
          const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-1v', graceMs: 300 });
          deepStrictEqual([answer.ok, answer.reason, answer.why], [false, 'supervisor_unknown', why]);
          ok(alive(other.pid), `${why}: the other process is never signalled`);
          ok(groupAlive(stray), `${why}: the stray group is never signalled`);
          strictEqual(readFileSync(run.handlePath, 'utf8'), before, `${why}: nothing is written`);
        }
        // That group ended, the terminal run's snapshot is recorded removed,
        // so a later cancel has nothing of it to judge or stop.
        killGroup(other.pid);
        await waitFor(() => !groupAlive(other.pid), { message: 'the other group to end' });
        editJson(run.handlePath, (h) => Object.assign(h, { ...terminal, pid: null, pgid: null, ...kept(other.pid), process_fingerprint: { kind: 'none' } }));
        let answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-1v', graceMs: 300 });
        deepStrictEqual([answer.ok, answer.status, answer.reason, answer.snapshot_cleanup], [true, 'completed', 'already_terminal', { removed: true, skipped: null, error: null, already_gone: true }]);
        ok((await runner.readHandle(run.handlePath)).snapshot.removed_at);
        answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-1v', graceMs: 300 });
        deepStrictEqual([answer.ok, answer.reason, answer.snapshot_cleanup], [true, 'already_terminal', undefined]);
      });
    });

    it('an owner record naming anything but its run\'s own snapshot removes nothing: another worktree, its branch and a registration the record does not lock stay', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        // Another linked worktree of the checkout, with work not committed.
        const other = join(dir, 'other');
        git(f.top, 'worktree', 'add', '-q', '-b', 'other', other);
        writeFileSync(join(other, 'work.txt'), 'uncommitted\n');
        const run = await hosted(t, f, snaps, 'host-1o', 'deaf');
        await hostTeardown(run, runner.readHandle);
        const owner = readFileSync(run.ownerPath, 'utf8');
        const { tree } = JSON.parse(owner);
        const [{ locked: lockReason }] = snapshotWorktrees(f.top);
        const relock = (reason) => { git(f.top, 'worktree', 'unlock', tree); git(f.top, 'worktree', 'lock', '--reason', reason, tree); };
        const cases = [
          ['tree-not-the-snapshot', () => editJson(run.ownerPath, (o) => { o.tree = other; }), () => writeFileSync(run.ownerPath, owner)],
          ['tree-not-the-handle-root', () => editJson(run.handlePath, (h) => { h.snapshot.root = other; }), () => editJson(run.handlePath, (h) => { h.snapshot.root = tree; })],
          ['branch-not-the-snapshot', () => editJson(run.ownerPath, (o) => { o.branch = 'other'; }), () => writeFileSync(run.ownerPath, owner)],
          ['registration-not-locked-by-owner', () => relock('kept by hand'), () => relock(lockReason)],
        ];
        for (const [skipped, edit, undo] of cases) {
          edit();
          const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-1o', graceMs: 300 });
          deepStrictEqual([answer.ok, answer.status, answer.snapshot_cleanup], [true, 'cancelled', { removed: false, skipped, error: null }], skipped);
          const h = await runner.readHandle(run.handlePath);
          deepStrictEqual([h.snapshot.removed_at, h.snapshot.cleanup_error], [null, null], `${skipped}: nothing is recorded`);
          undo();
          strictEqual(readFileSync(join(other, 'work.txt'), 'utf8'), 'uncommitted\n', `${skipped}: the other worktree keeps its work`);
          ok(git(f.top, 'rev-parse', '--verify', 'refs/heads/other').trim(), `${skipped}: its branch stays`);
          assertLeftover(f, snaps);
        }
        // Its own snapshot, the record as written, is removed.
        const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-1o', graceMs: 300 });
        deepStrictEqual([answer.reason, answer.snapshot_cleanup], ['already_terminal', removedClean]);
        assertRemoved(f, snaps);
        strictEqual(readFileSync(join(other, 'work.txt'), 'utf8'), 'uncommitted\n');
      });
    });

    it('an unborn HEAD\'s snapshot: cancel deletes its orphan branch with it', async (t) => {
      await withTmp(async (dir, snaps) => {
        const top = join(dir, 'repo');
        mkdirSync(top);
        git(top, 'init', '-q', '-b', 'main');
        writeFileSync(join(top, 'a'), 'a\n');
        const f = { top: realpathSync(top), companions: await writeFakeCompanions(dir), record: join(dir, 'record.json') };
        const run = await hosted(t, f, snaps, 'host-1u', 'deaf');
        const { branch } = JSON.parse(readFileSync(run.ownerPath, 'utf8'));
        ok(branch, 'the snapshot has an orphan branch');
        // The peer commits on it, as a peer may.
        git(JSON.parse(readFileSync(run.ownerPath, 'utf8')).tree, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'peer', '--allow-empty');
        ok(git(f.top, 'for-each-ref', 'refs/heads/peer-snapshot').trim(), 'the branch has a commit');
        await hostTeardown(run, runner.readHandle);
        const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-1u', graceMs: 300 });
        deepStrictEqual([answer.ok, answer.reason, answer.snapshot_cleanup], [true, 'ended', removedClean]);
        assertRemoved(f, snaps);
      });
    });

    it('a cancel of a live run ends only once the companion\'s whole group is gone: a child its peer leaves is stopped', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const run = await hosted(t, f, snaps, 'host-1f', 'family');
        const { grandchild } = JSON.parse(readFileSync(f.record, 'utf8'));
        t.after(() => killGroup(grandchild));
        // The runner's own end stops the group only after its 10 s grace.
        const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-1f', graceMs: 300 });
        deepStrictEqual([answer.ok, answer.status], [true, 'cancelled']);
        ok(!alive(grandchild), 'the child left in the group is stopped before the answer');
        await within(run.exited, 'the runner to end');
        await waitFor(() => leftovers(snaps).length === 0, { message: 'the runner to remove its snapshot' });
      });
    });

    it('a cancel of a live run whose handle names a group its process does not lead signals nothing: refused unverifiable, the handle as it was (C142)', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const run = await hosted(t, f, snaps, 'host-1m', 'deaf');
        // A process of no run's, leading a group of its own.
        const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', detached: true });
        t.after(() => killGroup(other.pid));
        editJson(run.handlePath, (h) => { h.pgid = other.pid; });
        const before = readFileSync(run.handlePath, 'utf8');
        const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-1m', graceMs: 300 });
        deepStrictEqual([answer.ok, answer.reason, answer.why], [false, 'unsupported_unverifiable', 'handle-malformed']);
        strictEqual(readFileSync(run.handlePath, 'utf8'), before, 'nothing is written');
        ok(alive(other.pid) && alive(run.companion.pid), 'neither group is signalled');
        // The companion ignores SIGTERM: its log shows none came (C142 X-F1).
        await sleep(250);
        deepStrictEqual(sigtermsSeen(f.record), [], 'no SIGTERM reaches the companion');
        // The log sees a SIGTERM the companion gets, so its silence above is no
        // logger that never writes.
        process.kill(run.companion.pid, 'SIGTERM');
        await waitFor(() => sigtermsSeen(f.record).includes('companion'), { message: 'the companion to log its SIGTERM' });
        killGroup(run.cli.pid);
        killGroup(run.companion.pgid);
        await within(run.exited, 'the runner to die');
      });
    });

    it('cancel records the answer the runner wrote before it was killed, never cancelled', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const run = await hosted(t, f, snaps, 'host-2', 'deaf');
        await hostTeardown(run, runner.readHandle);
        // What the runner leaves when it dies between the envelope and its
        // terminal write.
        writeFileSync(runner.peerRunPaths(f.top, 'host-2').envelope, JSON.stringify({ status: 'success', peer_host: 'codex', peer_model: null, stdout: 'peer answer', exit_code: 0 }));
        const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-2', graceMs: 500 });
        deepStrictEqual([answer.ok, answer.status, answer.reason, answer.snapshot_cleanup], [true, 'completed', 'ended', removedClean]);
        strictEqual((await runner.readHandle(run.handlePath)).status, 'completed');
        assertRemoved(f, snaps);
      });
    });

    it('a dead supervisor is no proof its peer stopped: cancel stops what is left of the companion\'s group before it finishes the run', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const run = await hosted(t, f, snaps, 'host-3', 'deaf-family');
        const { grandchild } = JSON.parse(readFileSync(f.record, 'utf8'));
        t.after(() => killGroup(grandchild));
        // The runner killed outright, and the companion's leader alone: a
        // child of it that ignores SIGTERM runs on in its group.
        process.kill(-run.cli.pid, 'SIGKILL');
        process.kill(run.companion.pid, 'SIGKILL');
        await within(run.exited, 'the runner to die');
        await waitFor(() => !alive(run.companion.pid), { message: 'the companion leader to be gone' });
        ok(groupAlive(run.companion.pgid) && alive(grandchild), 'its group lives on');
        const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-3', graceMs: 300 });
        ok(!alive(grandchild), 'the child left in the group is stopped');
        ok(!groupAlive(run.companion.pgid));
        deepStrictEqual([answer.ok, answer.status, answer.reason, answer.snapshot_cleanup], [true, 'cancelled', 'ended', removedClean]);
        assertRemoved(f, snaps);
      });
    });

    it('a runner killed inside its cleanup (terminal, its snapshot not removed): cancel removes the snapshot once the run is over, the status as it was', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const run = await hosted(t, f, snaps, 'host-4', 'deaf');
        await hostTeardown(run, runner.readHandle);
        // The runner's terminal write, made before its cleanup.
        editJson(run.handlePath, (h) => Object.assign(h, { status: 'cancelled', error_kind: 'cancelled', completed_at: new Date().toISOString(), pid: null, pgid: null, process_fingerprint: { kind: 'none' } }));
        const dead = JSON.parse(readFileSync(run.ownerPath, 'utf8')).supervisor;
        // The record and the handle keep one supervisor, as the runner writes them.
        const untold = { pid: process.pid, fingerprint: { kind: 'none' } };
        editJson(run.ownerPath, (o) => { o.supervisor = untold; });
        editJson(run.handlePath, (h) => { h.snapshot.supervisor = untold; });
        let answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-4' });
        deepStrictEqual([answer.ok, answer.status, answer.reason, answer.snapshot_cleanup], [true, 'cancelled', 'already_terminal', { removed: false, skipped: 'supervisor-unknown', error: null }]);
        assertLeftover(f, snaps);
        editJson(run.ownerPath, (o) => { o.supervisor = dead; });
        editJson(run.handlePath, (h) => { h.snapshot.supervisor = dead; });
        answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-4' });
        deepStrictEqual([answer.ok, answer.status, answer.reason, answer.snapshot_cleanup], [true, 'cancelled', 'already_terminal', removedClean]);
        const h = await runner.readHandle(run.handlePath);
        strictEqual(h.status, 'cancelled');
        ok(h.snapshot.removed_at);
        assertRemoved(f, snaps);
        // Recorded removed: a later cancel has nothing to remove.
        answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-4' });
        strictEqual(answer.snapshot_cleanup, undefined);
      });
    });

    it('a runner killed inside its own end that leaves a process of its peer\'s group: cancel stops it before it answers, the status as it was', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const run = await hosted(t, f, snaps, 'host-4g', 'deaf-family');
        const { grandchild } = JSON.parse(readFileSync(f.record, 'utf8'));
        t.after(() => killGroup(grandchild));
        // Its terminal write made, the runner and the peer's leader die; the
        // child runs on.
        editJson(run.handlePath, (h) => Object.assign(h, { status: 'failed', error_kind: 'peer_run_error', completed_at: new Date().toISOString(), pid: null, pgid: null, process_fingerprint: { kind: 'none' } }));
        process.kill(-run.cli.pid, 'SIGKILL');
        process.kill(run.companion.pid, 'SIGKILL');
        await within(run.exited, 'the runner to die');
        await waitFor(() => !alive(run.companion.pid), { message: 'the companion leader to be gone' });
        ok(alive(grandchild));
        const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-4g', graceMs: 300 });
        ok(!alive(grandchild), 'the child is stopped');
        deepStrictEqual([answer.ok, answer.status, answer.reason, answer.snapshot_cleanup], [true, 'failed', 'already_terminal', removedClean]);
        assertRemoved(f, snaps);
      });
    });

    it('settle settles it failed and removes its snapshot; a settle stopped before its cleanup leaves the snapshot to the next', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        rmSync(join(f.top, '.agentic-plugins'), { recursive: true, force: true });
        const { filePath: workflowPath } = await stateRoot.runInCommandDirectory(f.top, () => state.createWorkflow({
          repoRoot: f.top, verb: 'compose', originalRequest: 'x', host: 'claude', currentPhase: 'p', nextAction: 'n',
          gitBaseline: { branch: 'main', head: git(f.top, 'rev-parse', 'HEAD').trim(), status_digest: '' },
        }));
        const ensemble = ['--kind', 'ensemble', '--workflow-path', workflowPath, '--phase', 'compose', '--ensemble-type', 'plan-verify'];

        let run = await hosted(t, f, snaps, 'host-5', 'deaf', ensemble);
        await hostTeardown(run, runner.readHandle);
        assertLeftover(f, snaps);
        let settled = await runner.settleEnsemble({ repoRoot: f.top, workflowPath, phase: 'compose', runId: 'host-5', staleGraceMs: 1 });
        deepStrictEqual([settled.settlement, settled.verdict, settled.status, settled.snapshot_cleanup], ['committed', 'failed', 'orphaned', removedClean]);
        assertRemoved(f, snaps);

        // The settlement committed, the cleanup never ran: the repeat does it.
        rmSync(f.record);
        run = await hosted(t, f, snaps, 'host-6', 'deaf', ensemble);
        await hostTeardown(run, runner.readHandle);
        // What the interrupted settle wrote: the ledger reconciled, the result committed.
        const p6 = runner.peerRunPaths(f.top, 'host-6');
        strictEqual((await runner.reconcileOne(p6, await runner.readHandle(p6.handle), { staleGraceMs: 1, now: new Date() })).status, 'orphaned');
        await state.commitEnsemble({ workflowPath, run_id: 'host-6', phase: 'compose', ensemble_type: 'plan-verify', verdict: 'failed', summary: 'peer run orphaned: error_kind=orphaned', completed_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
        assertLeftover(f, snaps);
        settled = await runner.settleEnsemble({ repoRoot: f.top, workflowPath, phase: 'compose', runId: 'host-6', staleGraceMs: 1 });
        deepStrictEqual([settled.settlement, settled.verdict, settled.snapshot_cleanup], ['already-settled', 'failed', removedClean]);
        const h6 = await runner.readHandle(p6.handle);
        deepStrictEqual([h6.status, Boolean(h6.snapshot.removed_at)], ['orphaned', true]);
        assertRemoved(f, snaps);

        // A companion its owner record names without its group proves
        // nothing: the run is settled, its snapshot kept.
        rmSync(f.record);
        run = await hosted(t, f, snaps, 'host-7', 'deaf', ensemble);
        await hostTeardown(run, runner.readHandle);
        editJson(run.ownerPath, (o) => { o.companion.pgid = null; });
        settled = await runner.settleEnsemble({ repoRoot: f.top, workflowPath, phase: 'compose', runId: 'host-7', staleGraceMs: 1 });
        deepStrictEqual([settled.settlement, settled.verdict, settled.snapshot_cleanup], ['committed', 'failed', { removed: false, skipped: 'owner-incomplete', error: null }]);
        assertLeftover(f, snaps);

        // A live supervisor read under another fingerprint (C141's locale,
        // an incomplete record) is no proof it is gone: the run is settled,
        // its snapshot kept.
        rmSync(f.record);
        run = await hosted(t, f, snaps, 'host-8', 'deaf', ensemble);
        await hostTeardown(run, runner.readHandle);
        const fingerprint = await identity.fingerprintForPid(process.pid);
        const differ = { pid: process.pid, fingerprint: { ...fingerprint, lstart: 'Thu Jan  1 00:00:00 1970', starttime: '1' } };
        editJson(run.ownerPath, (o) => { o.supervisor = differ; });
        editJson(run.handlePath, (h) => { h.snapshot.supervisor = differ; });
        settled = await runner.settleEnsemble({ repoRoot: f.top, workflowPath, phase: 'compose', runId: 'host-8', staleGraceMs: 1 });
        deepStrictEqual([settled.settlement, settled.verdict, settled.snapshot_cleanup], ['committed', 'failed', { removed: false, skipped: 'supervisor-unknown', error: null }]);
        // This run's dispatch reclaimed host-7's (its owners gone): the one
        // left is this run's own.
        assertLeftover(f, snaps);
        ok(existsSync(run.ownerPath), 'this run\'s snapshot is kept');
      });
    });

    // A runner killed outright and its companion's leader gone, a child of
    // its group running on in the snapshot, under an owner record that names
    // no companion and no launch: the handle still names the companion.
    const killedLeavingChild = async (t, f, snaps, runId, extra = []) => {
      const run = await hosted(t, f, snaps, runId, 'deaf-family', extra);
      const { grandchild } = JSON.parse(readFileSync(f.record, 'utf8'));
      t.after(() => killGroup(grandchild));
      process.kill(-run.cli.pid, 'SIGKILL');
      process.kill(run.companion.pid, 'SIGKILL');
      await within(run.exited, 'the runner to die');
      await waitFor(() => !alive(run.companion.pid), { message: 'the companion leader to be gone' });
      editJson(run.ownerPath, (o) => { o.companion = null; delete o.launched_at; });
      const h = await runner.readHandle(run.handlePath);
      deepStrictEqual([h.pid, h.pgid], [run.companion.pid, run.companion.pgid], 'the handle names the companion');
      ok(alive(grandchild), 'a child of its group runs on');
      return { run, grandchild };
    };

    it('an owner record that names no companion while the handle names one proves nothing: cancel writes, stops and removes nothing (C142 J-F1)', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const { run, grandchild } = await killedLeavingChild(t, f, snaps, 'host-9');
        const before = readFileSync(run.handlePath, 'utf8');
        const r = cancelCli(f, snaps, 'host-9');
        strictEqual(r.status, 1, r.stderr);
        deepStrictEqual([r.answer.ok, r.answer.reason, r.answer.why], [false, 'supervisor_unknown', 'owner-incomplete']);
        strictEqual(readFileSync(run.handlePath, 'utf8'), before, 'the handle is as it was');
        ok(alive(grandchild), 'the child runs on');
        assertLeftover(f, snaps);
      });
    });

    it('settle judges the owner record against the handle as it read it before its reconcile cleared the companion: the run is settled, its snapshot kept (C142 J-F1)', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        rmSync(join(f.top, '.agentic-plugins'), { recursive: true, force: true });
        const { filePath: workflowPath } = await stateRoot.runInCommandDirectory(f.top, () => state.createWorkflow({
          repoRoot: f.top, verb: 'compose', originalRequest: 'x', host: 'claude', currentPhase: 'p', nextAction: 'n',
          gitBaseline: { branch: 'main', head: git(f.top, 'rev-parse', 'HEAD').trim(), status_digest: '' },
        }));
        const ensemble = ['--kind', 'ensemble', '--workflow-path', workflowPath, '--phase', 'compose', '--ensemble-type', 'plan-verify'];
        const { run, grandchild } = await killedLeavingChild(t, f, snaps, 'host-10', ensemble);
        const settled = await runner.settleEnsemble({ repoRoot: f.top, workflowPath, phase: 'compose', runId: 'host-10', staleGraceMs: 1 });
        deepStrictEqual([settled.settlement, settled.verdict, settled.status, settled.snapshot_cleanup], ['committed', 'failed', 'orphaned', { removed: false, skipped: 'owner-incomplete', error: null }]);
        deepStrictEqual((({ pid, pgid }) => [pid, pgid])(await runner.readHandle(run.handlePath)), [null, null], 'the reconcile cleared the companion from the handle');
        ok(alive(grandchild), 'the child runs on');
        assertLeftover(f, snaps);
        // A repeat (already-settled) and a later cancel of the now terminal
        // run read the handle as the reconcile left it: the peer process it
        // keeps is still the evidence.
        const again = await runner.settleEnsemble({ repoRoot: f.top, workflowPath, phase: 'compose', runId: 'host-10', staleGraceMs: 1 });
        deepStrictEqual([again.settlement, again.snapshot_cleanup], ['already-settled', { removed: false, skipped: 'owner-incomplete', error: null }]);
        const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-10', graceMs: 300 });
        deepStrictEqual([answer.ok, answer.reason, answer.snapshot_cleanup], [true, 'already_terminal', { removed: false, skipped: 'owner-incomplete', error: null }]);
        ok(alive(grandchild), 'the child still runs on');
        assertLeftover(f, snaps);
        deepStrictEqual((await runner.readHandle(run.handlePath)).peer_process, { pid: run.companion.pid, pgid: run.companion.pgid }, 'the handle keeps the peer process');
      });
    });

    it('a handle an earlier runner wrote, with no peer process kept: settle still judges against its pid and pgid as read before its reconcile (C142 J-F1)', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        rmSync(join(f.top, '.agentic-plugins'), { recursive: true, force: true });
        const { filePath: workflowPath } = await stateRoot.runInCommandDirectory(f.top, () => state.createWorkflow({
          repoRoot: f.top, verb: 'compose', originalRequest: 'x', host: 'claude', currentPhase: 'p', nextAction: 'n',
          gitBaseline: { branch: 'main', head: git(f.top, 'rev-parse', 'HEAD').trim(), status_digest: '' },
        }));
        const ensemble = ['--kind', 'ensemble', '--workflow-path', workflowPath, '--phase', 'compose', '--ensemble-type', 'plan-verify'];
        const { run, grandchild } = await killedLeavingChild(t, f, snaps, 'host-11', ensemble);
        editJson(run.handlePath, (h) => { delete h.peer_process; });
        const settled = await runner.settleEnsemble({ repoRoot: f.top, workflowPath, phase: 'compose', runId: 'host-11', staleGraceMs: 1 });
        deepStrictEqual([settled.settlement, settled.status, settled.snapshot_cleanup], ['committed', 'orphaned', { removed: false, skipped: 'owner-incomplete', error: null }]);
        ok(alive(grandchild), 'the child runs on');
        assertLeftover(f, snaps);
      });
    });
  });

  describe(`${persona}: runbook guidance for the snapshot (C96, C127)`, () => {
    const protocol = readFileSync(P.path('core/skills/_shared/references/ensemble-protocol.md'), 'utf8').replace(/\s+/g, ' ');
    const peerNow = [readFileSync(P.path('commands/peer-now.md'), 'utf8'), readFileSync(P.path('core/skills/peer-now/SKILL.md'), 'utf8')].map((t) => t.replace(/\s+/g, ' '));

    it('the launch step says the peer reads a snapshot and to name a review base by commit id', () => {
      ok(protocol.includes('A codex peer never works in the checkout: the runner gives it a snapshot of HEAD plus the working tree and the index'));
      ok(protocol.includes('name files repo-relatively and a review base by its commit id'));
    });

    it('the collect step names snapshot_failed, maps snapshot paths back, and keeps pgrep -f from matching its own loop', () => {
      ok(protocol.includes('`snapshot_failed` (no snapshot of the checkout could be made for a codex peer'));
      ok(protocol.includes('A path in the answer under the handle\'s `snapshot.root` names the snapshot the peer read'));
      ok(protocol.includes('Collecting the peer stays notification-only.'));
      ok(protocol.includes("bracket one character (`pgrep -f '[m]utation-harness'`) or wait on a pid file (C127)"));
    });

    it('peer-now says files the peer writes are discarded', () => {
      for (const text of peerNow) ok(text.includes('A codex peer answers from a snapshot of the checkout, removed when the run ends (C96): a file it writes is discarded with it.'));
    });
  });

  describe(`${persona}: dispatch-peer — a codex peer runs in the snapshot (C96)`, () => {
    const DISPATCH = P.path('scripts/dispatch-peer.mjs');
    const fakeEnv = (f, mode) => ({ ...env, AGENTIC_COMPANIONS_ROOT: f.companions, FAKE_COMPANION_MODE: mode, FAKE_RECORD: f.record });

    it('the vandal peer tidies only the snapshot, which is removed when the dispatch ends', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        const f = { top, companions: await writeFakeCompanions(dir), record: join(dir, 'record.json') };
        const before = liveView(top);
        const r = spawnSync(process.execPath, [DISPATCH, '--peer', 'codex', '--prompt-text', `look at ${top}/a`, '--cwd', top], {
          env: { ...fakeEnv(f, 'vandal'), TMPDIR: snaps }, encoding: 'utf8',
        });
        strictEqual(r.status, 0, r.stderr);
        deepStrictEqual(liveView(top), before);
        const rec = JSON.parse(readFileSync(f.record, 'utf8'));
        ok(relative(top, rec.cwd).startsWith('..'), `${rec.cwd} is outside the checkout`);
        match(rec.prompt, /^look at \/.+\/tree\/a$/);
        ok(!rec.prompt.includes(`${top}/`));
        deepStrictEqual(leftovers(snaps), []);
        strictEqual(snapshotWorktrees(top).length, 0);
      });
    });

    it('SIGTERM (doctor\'s timeout) stops the peer group, removes the snapshot and exits 143', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        const f = { top, companions: await writeFakeCompanions(dir), record: join(dir, 'record.json') };
        const cli = spawn(process.execPath, [DISPATCH, '--peer', 'codex', '--prompt-text', 'x', '--cwd', top], {
          env: { ...fakeEnv(f, 'hang'), TMPDIR: snaps }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const exited = new Promise((r) => cli.once('exit', (code, signal) => r({ code, signal })));
        await waitFor(() => existsSync(f.record), { message: 'the companion to start' });
        const { pid } = JSON.parse(readFileSync(f.record, 'utf8'));
        try {
          cli.kill('SIGTERM');
          deepStrictEqual(await within(exited, 'the CLI to exit'), { code: 143, signal: null });
          ok(!groupAlive(pid));
        } finally {
          killGroup(pid);
          killGroup(cli.pid);
        }
        deepStrictEqual(leftovers(snaps), []);
        strictEqual(snapshotWorktrees(top).length, 0);
      });
    });

    it('a child holding the companion\'s pipes is stopped once the companion exits, and the dispatch ends', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        const f = { top, companions: await writeFakeCompanions(dir), record: join(dir, 'record.json') };
        let grandchild = null;
        try {
          const result = await within(dispatcher.dispatchPeer({ peer: 'codex', promptText: 'x', cwd: top, env: fakeEnv(f, 'leaky'), cancelGraceMs: 300 }), 'the dispatch to end');
          strictEqual(result.ok, true, result.stderr);
          grandchild = JSON.parse(readFileSync(f.record, 'utf8')).grandchild;
          await waitFor(() => !alive(grandchild), { timeoutMs: 5000, message: 'the child to be stopped' });
          deepStrictEqual(leftovers(snaps), []);
        } finally {
          if (grandchild === null && existsSync(f.record)) grandchild = JSON.parse(readFileSync(f.record, 'utf8')).grandchild;
          if (grandchild) killGroup(grandchild);
        }
      });
    });

    it('a cancellation requested after the dispatch ended signals nothing of its peer', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const f = { top, companions: await writeFakeCompanions(dir), record: join(dir, 'record.json') };
        const cancellation = identity.createRunCancellation();
        const result = await dispatcher.dispatchPeer({ peer: 'codex', promptText: 'x', cwd: top, env: fakeEnv(f, 'vandal'), cancellation, cancelGraceMs: 200 });
        strictEqual(result.ok, true, result.stderr);
        const { pid } = JSON.parse(readFileSync(f.record, 'utf8'));
        const sent = [];
        const kill = process.kill;
        process.kill = (target, sig) => {
          if (Math.abs(target) === pid) sent.push([target, sig]);
          return kill.call(process, target, sig);
        };
        try {
          cancellation.request('SIGTERM');
          await sleep(500);
        } finally {
          process.kill = kill;
        }
        deepStrictEqual(sent, []);
      });
    });

    it('a codex peer outside any checkout gets no git selector naming the live repository', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const f = { top, companions: await writeFakeCompanions(dir), record: join(dir, 'record.json') };
        const before = liveView(top);
        const plain = join(dir, 'plain');
        mkdirSync(plain);
        const result = await dispatcher.dispatchPeer({ peer: 'codex', promptText: 'x', cwd: plain, env: { ...fakeEnv(f, 'vandal'), GIT_DIR: join(top, '.git'), GIT_WORK_TREE: top } });
        strictEqual(result.ok, true, result.stderr);
        strictEqual(JSON.parse(readFileSync(f.record, 'utf8')).gitDir, null);
        deepStrictEqual(liveView(top), before);
      });
    });

    it('a snapshot that cannot be made: companion_error / snapshot_failed, no envelope, no companion', async () => {
      await withTmp(async (dir) => {
        const top = join(dir, 'repo');
        mkdirSync(top);
        writeFileSync(join(top, '.git'), 'gitdir: /nonexistent\n');
        const f = { top, companions: await writeFakeCompanions(dir), record: join(dir, 'record.json') };
        const result = await dispatcher.dispatchPeer({ peer: 'codex', promptText: 'x', cwd: top, env: fakeEnv(f, 'vandal') });
        strictEqual(result.ok, false);
        strictEqual(result.status, 'companion_error');
        strictEqual(result.kind, 'snapshot_failed');
        strictEqual(result.envelope, null);
        strictEqual(result.exitCode, 3);
        ok(!existsSync(f.record));
      });
    });

    it('a repository with no commit yet (runtime doctor\'s proof repo) is dispatched in an orphan snapshot', async () => {
      await withTmp(async (dir, snaps) => {
        const top = join(dir, 'repo');
        mkdirSync(top);
        git(top, 'init', '-q', '-b', 'main');
        writeFileSync(join(top, 'loose'), 'l\n');
        const f = { top, companions: await writeFakeCompanions(dir), record: join(dir, 'record.json') };
        const result = await dispatcher.dispatchPeer({ peer: 'codex', promptText: 'x', cwd: top, env: fakeEnv(f, 'vandal') });
        strictEqual(result.ok, true, result.stderr);
        ok(existsSync(join(top, 'loose')), 'the untracked file the peer cleaned is still in the live tree');
        ok(relative(realpathSync(top), JSON.parse(readFileSync(f.record, 'utf8')).cwd).startsWith('..'));
        deepStrictEqual(leftovers(snaps), []);
        strictEqual(git(top, 'for-each-ref'), '');
      });
    });
  });
}
