// C163 D2b — a claude peer runs in a snapshot of the checkout, as a codex peer
// has since C96: the cases each dispatch surface (peer-runner.mjs's runPeer
// and CLI, dispatch-peer.mjs's dispatchPeer and CLI) must pass for a claude
// peer. One copy of the cases, run by tests/persona-pipeline/
// test-peer-snapshot-claude.mjs for each persona and by tests/orchestrator/
// test-peer-snapshot-claude.mjs for the orchestrator's copies.
//
// The fake companion's record says what the peer saw: its directory, the
// prompt it read, the GIT_DIR it inherited and `toplevel`, the worktree its
// own git commands reach from its directory with the environment it was
// given. Its `vandal` mode tidies that directory with git, as a peer was
// measured doing (C96), so "the live tree is intact" is tested against the
// failure the snapshot exists for. Each case that hands the peer a GIT_DIR and
// a GIT_WORK_TREE naming the live repository checks that they were stripped:
// left in, they would aim the peer's git at the live tree from any directory.

import { describe, it } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  git,
  groupAlive,
  killGroup,
  leftovers,
  liveView,
  makeDirtyRepo,
  makeUnmergedRepo,
  snapshotWorktrees,
  waitFor,
  withTmp,
  within,
  withoutStateHome,
  writeFakeCompanions,
} from './_peer-snapshot-fixtures.mjs';

/**
 * @param {object} o
 * @param {string} o.label             the plugin the cases run against (a persona, or orchestrator)
 * @param {object} o.runner            that plugin's peer-runner.mjs module
 * @param {object} o.dispatcher        that plugin's dispatch-peer.mjs module
 * @param {string} o.runnerPath        the path of its peer-runner.mjs (the CLI)
 * @param {string} o.dispatchPath      the path of its dispatch-peer.mjs (the CLI)
 * @param {string} o.evidenceBoundary  the block a peer's prompt opens with (C163 D2a)
 * @param {object} o.env               the clean environment the suites run peers with
 */
export function claudePeerCases({ label, runner, dispatcher, runnerPath, dispatchPath, evidenceBoundary, env }) {
  const fixture = async (dir) => ({ top: makeDirtyRepo(dir), companions: await writeFakeCompanions(dir), record: join(dir, 'record.json') });
  const fakeEnv = (f, mode, extra = {}) => ({ ...env, AGENTIC_COMPANIONS_ROOT: f.companions, FAKE_COMPANION_MODE: mode, FAKE_RECORD: f.record, ...extra });
  // Git selectors naming the live repository, which no peer may inherit.
  const liveSelectors = (top) => ({ GIT_DIR: join(top, '.git'), GIT_WORK_TREE: top });
  const record = (f) => JSON.parse(readFileSync(f.record, 'utf8'));
  // The run's own ledger is the one change the live tree may show.
  const sansLedger = (v) => ({ ...v, status: withoutStateHome(v.status) });

  describe(`${label}: peer-runner — a claude peer runs in the snapshot (C163 D2b)`, () => {
    it('runPeer: a claude peer works in the snapshot — its directory, its prompt and its git name the snapshot — and the snapshot is removed', async () => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const before = liveView(f.top);
        const result = await runner.runPeer({
          repoRoot: f.top, peer: 'claude', promptText: `<task>read ${f.top}/a</task>`, cwd: join(f.top, 'sub'), outputFormat: 'json',
          env: fakeEnv(f, 'vandal', liveSelectors(f.top)),
        });
        strictEqual(result.status, 'completed');
        deepStrictEqual(sansLedger(liveView(f.top)), sansLedger(before), 'the live tree and index are intact');
        ok(!existsSync(join(f.top, 'sub', 'peer-wrote-this')), 'the peer wrote nothing in the live tree');
        const rec = record(f);
        strictEqual(result.snapshot.isolation, 'snapshot');
        strictEqual(rec.cwd, join(result.snapshot.root, 'sub'), 'its directory is the snapshot\'s copy of the one it was given');
        strictEqual(rec.cwd, result.snapshot.peer_cwd);
        strictEqual(rec.toplevel, result.snapshot.root, 'its git reaches the snapshot, not the checkout');
        strictEqual(rec.gitDir, null, 'no git selector reaches the companion');
        strictEqual(rec.prompt, `${evidenceBoundary}\n\n<task>read ${result.snapshot.root}/a</task>`, 'its prompt names the snapshot');
        ok(relative(f.top, rec.promptFile).startsWith('..'), 'the prompt copy is outside the checkout');
        ok(result.snapshot.removed_at, 'the snapshot is removed when the run ends');
        strictEqual(result.snapshot.cleanup_error, null);
        strictEqual(snapshotWorktrees(f.top).length, 0);
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('runPeer: a claude peer outside any checkout gets no git selector naming the live repository', async () => {
      await withTmp(async (dir) => {
        const f = await fixture(dir);
        const before = liveView(f.top);
        const plain = join(dir, 'plain');
        mkdirSync(plain);
        const result = await runner.runPeer({ repoRoot: f.top, peer: 'claude', promptText: 'x', cwd: plain, env: fakeEnv(f, 'vandal', liveSelectors(f.top)) });
        strictEqual(result.status, 'completed');
        deepStrictEqual([result.snapshot.isolation, result.snapshot.reason], ['none', 'not-a-checkout']);
        const rec = record(f);
        strictEqual(rec.gitDir, null, 'no git selector reaches the companion');
        strictEqual(rec.toplevel, null, 'its git reaches no repository from a directory outside any checkout');
        deepStrictEqual(sansLedger(liveView(f.top)), sansLedger(before), 'the live tree and index are intact');
      });
    });

    it('runPeer: a claude peer whose snapshot cannot be made is not run (snapshot_failed)', async () => {
      await withTmp(async (dir) => {
        const f = { top: makeUnmergedRepo(dir), companions: await writeFakeCompanions(dir), record: join(dir, 'record.json') };
        const result = await runner.runPeer({ repoRoot: f.top, peer: 'claude', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'vandal') });
        deepStrictEqual([result.status, result.error_kind, result.exit_code], ['failed', 'snapshot_failed', null]);
        deepStrictEqual([result.snapshot.isolation, result.snapshot.reason], ['failed', 'unmerged-index']);
        ok(!existsSync(f.record), 'no companion ran');
      });
    });

    it('runPeer: a cancelled claude run removes its snapshot', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const running = runner.runPeer({ repoRoot: f.top, runId: 'claude-cancel', peer: 'claude', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'hang') });
        running.catch(() => {}); // judged below
        await waitFor(() => existsSync(f.record), { message: 'the companion to start' });
        const peerPid = record(f).pid;
        t.after(() => killGroup(peerPid));
        ok(snapshotWorktrees(f.top).length === 1, 'the running claude peer has its snapshot');
        const handlePath = runner.peerRunPaths(f.top, 'claude-cancel').handle;
        await waitFor(async () => (await runner.readHandle(handlePath)).status === 'running', { message: 'the run to be running' });
        const cancelled = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'claude-cancel', graceMs: 2000 });
        strictEqual(cancelled.ok, true);
        const result = await within(running, 'the cancelled run to end');
        strictEqual(result.status, 'cancelled');
        ok(result.snapshot.removed_at, 'the snapshot is removed when the run ends');
        strictEqual(snapshotWorktrees(f.top).length, 0);
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('runPeer: a claude run whose runner is killed outright keeps its snapshot while the peer lives; the next sweep reclaims it once the peer ends', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const cli = spawn(process.execPath, [runnerPath, 'run', '--repo-root', f.top, '--run-id', 'claude-kill', '--peer', 'claude', '--prompt-text', 'x', '--cwd', f.top], {
          env: { ...fakeEnv(f, 'hang'), TMPDIR: snaps }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        await waitFor(() => existsSync(f.record), { message: 'the companion to start' });
        const { pid } = record(f);
        t.after(() => killGroup(pid));
        const [snap] = snapshotWorktrees(f.top);
        ok(snap, 'the claude peer runs in a snapshot');
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

  describe(`${label}: dispatch-peer — a claude peer runs in the snapshot (C163 D2b)`, () => {
    it('dispatchPeer: a claude peer works in the snapshot — its directory, its prompt and its git name the snapshot — and the snapshot is removed', async () => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const before = liveView(f.top);
        const result = await dispatcher.dispatchPeer({ peer: 'claude', promptText: `look at ${f.top}/a`, cwd: f.top, env: fakeEnv(f, 'vandal', liveSelectors(f.top)) });
        strictEqual(result.ok, true, result.stderr);
        deepStrictEqual(liveView(f.top), before, 'the live tree and index are intact');
        ok(!existsSync(join(f.top, 'peer-wrote-this')), 'the peer wrote nothing in the live tree');
        const rec = record(f);
        ok(relative(f.top, rec.cwd).startsWith('..'), `${rec.cwd} is outside the checkout`);
        strictEqual(rec.toplevel, rec.cwd, 'its git reaches the snapshot it was given, not the checkout');
        strictEqual(rec.gitDir, null, 'no git selector reaches the companion');
        strictEqual(rec.prompt, `${evidenceBoundary}\n\nlook at ${rec.toplevel}/a`, 'its prompt names the snapshot');
        strictEqual(snapshotWorktrees(f.top).length, 0, 'the snapshot is removed when the dispatch ends');
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('dispatchPeer: a claude peer given no directory works in a snapshot of the current one', async () => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const before = liveView(f.top);
        const here = process.cwd();
        process.chdir(f.top);
        let result;
        try {
          result = await dispatcher.dispatchPeer({ peer: 'claude', promptText: 'x', env: fakeEnv(f, 'vandal') });
        } finally {
          process.chdir(here);
        }
        strictEqual(result.ok, true, result.stderr);
        deepStrictEqual(liveView(f.top), before, 'the live tree and index are intact');
        const rec = record(f);
        ok(relative(f.top, rec.cwd).startsWith('..'), `${rec.cwd} is outside the checkout`);
        strictEqual(rec.toplevel, rec.cwd, 'its git reaches the snapshot of the current directory');
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('dispatchPeer: a claude peer outside any checkout gets no git selector naming the live repository', async () => {
      await withTmp(async (dir) => {
        const f = await fixture(dir);
        const before = liveView(f.top);
        const plain = join(dir, 'plain');
        mkdirSync(plain);
        const result = await dispatcher.dispatchPeer({ peer: 'claude', promptText: 'x', cwd: plain, env: fakeEnv(f, 'vandal', liveSelectors(f.top)) });
        strictEqual(result.ok, true, result.stderr);
        const rec = record(f);
        strictEqual(rec.cwd, plain, 'a directory outside any checkout is the peer\'s own');
        strictEqual(rec.gitDir, null, 'no git selector reaches the companion');
        strictEqual(rec.toplevel, null, 'its git reaches no repository from a directory outside any checkout');
        deepStrictEqual(liveView(f.top), before, 'the live tree and index are intact');
      });
    });

    it('dispatchPeer: a claude peer whose snapshot cannot be made is not run (snapshot_failed)', async () => {
      await withTmp(async (dir) => {
        const top = join(dir, 'repo');
        mkdirSync(top);
        writeFileSync(join(top, '.git'), 'gitdir: /nonexistent\n');
        const f = { top, companions: await writeFakeCompanions(dir), record: join(dir, 'record.json') };
        const result = await dispatcher.dispatchPeer({ peer: 'claude', promptText: 'x', cwd: top, env: fakeEnv(f, 'vandal') });
        deepStrictEqual([result.ok, result.status, result.kind, result.exitCode, result.envelope], [false, 'companion_error', 'snapshot_failed', 3, null]);
        ok(!existsSync(f.record), 'no companion ran');
      });
    });

    it('dispatch-peer CLI: SIGTERM stops a claude peer\'s group, removes its snapshot and exits 143', async () => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const cli = spawn(process.execPath, [dispatchPath, '--peer', 'claude', '--prompt-text', 'x', '--cwd', f.top], {
          env: { ...fakeEnv(f, 'hang'), TMPDIR: snaps }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const exited = new Promise((r) => cli.once('exit', (code, signal) => r({ code, signal })));
        await waitFor(() => existsSync(f.record), { message: 'the companion to start' });
        const { pid, cwd } = record(f);
        try {
          ok(relative(f.top, cwd).startsWith('..'), 'the claude peer runs in a snapshot');
          strictEqual(snapshotWorktrees(f.top).length, 1);
          cli.kill('SIGTERM');
          deepStrictEqual(await within(exited, 'the CLI to exit'), { code: 143, signal: null });
          ok(!groupAlive(pid), 'the peer\'s group is stopped');
        } finally {
          killGroup(pid);
          killGroup(cli.pid);
        }
        strictEqual(snapshotWorktrees(f.top).length, 0, 'the snapshot is removed');
        deepStrictEqual(leftovers(snaps), []);
        strictEqual(git(f.top, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1, 'only the checkout itself is a worktree');
      });
    });
  });
}
