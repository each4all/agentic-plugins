// tests/orchestrator/test-autopilot-lanes.mjs
//
// ADR-0067 Decision 5 — the autopilot's lane layer
// (plugins/orchestrator/adapters/claude/autopilot/lanes.mjs) against real git
// worktrees in a scratch repository with a bare origin: placement from the
// repository's identity, creation (a new and an existing branch, a stale and a
// missing baseline ref, a failed add), removal (clean, dirty, a shared record,
// unowned, a remove refused after the check) and each reconciliation row.
// The macro view is built by hand with the fields the observer gives
// (plan, children, claims, readiness), so each row is set up exactly.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRepo } from './fixtures/autopilot-repo.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const LN = await import(join(AP, 'lanes.mjs'));
const L = await import(join(AP, 'ledger.mjs'));
const C = await import(join(AP, 'cli.mjs'));
const SR = await import(resolve(REPO_ROOT, 'plugins/orchestrator/scripts/lib/state-root.mjs'));
const RLK = await import(resolve(REPO_ROOT, 'plugins/orchestrator/scripts/lib/run-locks.mjs'));

const RUN = 'autopilot-20261009T000000Z-1a2b3c';
const OTHER_RUN = 'autopilot-20261009T000000Z-0a7e21';

function gitIn(fx, cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { env: fx.env, encoding: 'utf8' }).trim();
}

// The observer's view, with only what the lane layer reads. Like next-ready's
// answer when a subtask is ready, it carries no readiness list: the lane
// layer judges readiness from the plan.
function viewOf(subtasks, { children = {}, claims = [], claimsError = null } = {}) {
  return { macro: { fm: { plan: { subtasks } } }, children, claims, claimsError, ready: { ready: subtasks[0] ?? null } };
}

// A git on PATH whose `worktree unlock` runs `unlock` (a shell case arm, with
// "$REAL" the real git) and whose every other command is the real git's: its
// messages are German, so nothing may read them. Returns { env, done }.
function translatedGit(fx, unlock) {
  const dir = mkdtempSync(join(tmpdir(), 'lanes-git-'));
  const real = execFileSync('/bin/sh', ['-c', 'command -v git'], { env: fx.env, encoding: 'utf8' }).trim();
  writeFileSync(join(dir, 'git'), ['#!/bin/sh', `REAL="${real}"`, 'case " $* " in', `  *" worktree unlock "*) ${unlock} ;;`, 'esac', 'exec "$REAL" "$@"', ''].join('\n'), { mode: 0o755 });
  return { env: { ...fx.env, PATH: `${dir}:${fx.env.PATH}` }, done: () => rmSync(dir, { recursive: true, force: true }) };
}

async function setup({ shared = true, ...opts } = {}) {
  const fx = await makeRepo({ linked: true, ...opts });
  const home = LN.laneHome(fx.work);
  ok(!home.problem, home.problem);
  if (shared) SR.enableSharedCreation({ checkout: home.mainRoot, versions: { orchestrator: 'test' } });
  const runDir = L.createRunDir(fx.work, RUN);
  L.writeRun(runDir, { run_id: RUN, status: 'running', macro_id: fx.macroId });
  const base = gitIn(fx, fx.work, 'rev-parse', 'refs/remotes/origin/main');
  const t = {
    fx, home, runDir, base,
    lane: (id) => LN.lanePath(home, fx.macroId, id),
    // The lane events, but the one-time rollback-fence record (its own test).
    events: () => (L.readRun(fx.work, RUN)?.lanes ?? []).filter((e) => e.event !== 'lanes-first-run'),
    allEvents: () => L.readRun(fx.work, RUN)?.lanes ?? [],
    worktree: (p) => LN.listWorktrees(fx.work).find((w) => w.path === p) ?? null,
    create: (subtask, view) => LN.createLane({ home, checkout: fx.work, macroId: fx.macroId, subtask, view: view ?? viewOf([subtask]), baseline: 'main', runId: RUN, runDir, env: fx.env }),
    reconcile: (view) => LN.reconcileLanes({ home, checkout: fx.work, macroId: fx.macroId, view, baseline: 'main', runId: RUN, runDir, env: fx.env }),
    // A lane as Creation would leave it, built with git directly.
    rawLane: (id, branch, { reason = LN.lockReason(fx.macroId, id), identity = true } = {}) => {
      const p = LN.lanePath(home, fx.macroId, id);
      gitIn(fx, fx.work, 'worktree', 'add', '-q', ...(reason ? ['--lock', '--reason', reason] : []), '--no-track', '-b', branch, p, 'refs/remotes/origin/main');
      if (identity) LN.writeLaneIdentity(p, { macroId: fx.macroId, subtaskId: id, branch });
      return p;
    },
    // A commit on origin's main from another clone: the baseline moves.
    moveBaseline: () => {
      const other = join(fx.dir, `other-${Math.random().toString(16).slice(2, 8)}`);
      execFileSync('git', ['clone', '-q', fx.origin, other], { env: fx.env });
      writeFileSync(join(other, 'moved.txt'), 'moved\n');
      gitIn(fx, other, 'add', 'moved.txt');
      gitIn(fx, other, 'commit', '-q', '-m', 'feat: moved');
      gitIn(fx, other, 'push', '-q', 'origin', 'HEAD:main');
      return gitIn(fx, other, 'rev-parse', 'HEAD');
    },
  };
  return t;
}

describe('placement and identity', () => {
  it('places lanes by the repository\'s identity — the main worktree — not the launching checkout', async () => {
    const t = await setup();
    try {
      const main = realpathSync(t.fx.main);
      strictEqual(t.home.mainRoot, main);
      strictEqual(t.home.lanesDir, join(dirname(main), 'main-lanes'), 'named from the main worktree, never from work (the linked one)');
      strictEqual(t.lane('A'), join(dirname(main), 'main-lanes', t.fx.macroId, 'A'));
      deepStrictEqual(LN.parseLockReason(LN.lockReason(t.fx.macroId, 'A')), { macroId: t.fx.macroId, subtaskId: 'A' });
      strictEqual(LN.parseLockReason('agentic-autopilot not-a-macro A'), null);
      strictEqual(LN.parseLockReason('someone else'), null);
    } finally {
      t.fx.cleanup();
    }
  });

  it('refuses a repository whose git common dir is not named .git: it has no shared root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lanes-sep-'));
    try {
      execFileSync('git', ['init', '-q', '--separate-git-dir', join(dir, 'repo.git'), join(dir, 'w')]);
      match(LN.laneHome(join(dir, 'w')).problem ?? '', /is not named \.git/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('closes a removal intent only by a later done or kept record of the same lane id and path', async () => {
    const t = await setup();
    try {
      const m = t.home.mainRoot;
      LN.appendIntent(m, t.fx.macroId, { event: 'intent', path: '/x/A', lane_id: 'a'.repeat(16) });
      LN.appendIntent(m, t.fx.macroId, { event: 'intent', path: '/x/B', lane_id: 'b'.repeat(16) });
      LN.appendIntent(m, t.fx.macroId, { event: 'done', path: '/x/A', lane_id: 'c'.repeat(16) });
      LN.appendIntent(m, t.fx.macroId, { event: 'kept', path: '/x/B', lane_id: 'b'.repeat(16) });
      deepStrictEqual(LN.openIntents(m, t.fx.macroId).map((i) => i.path), ['/x/A']);
      ok(existsSync(join(m, '.agentic-plugins/runs/autopilot/lanes', `${t.fx.macroId}.jsonl`)), 'beside the macro lock, under the main worktree');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('creation', () => {
  it('cuts an absent branch from the freshly fetched baseline, locked with the run\'s reason, with no upstream, and records it', async () => {
    const t = await setup();
    try {
      const moved = t.moveBaseline();
      const r = t.create({ id: 'A', branch: 'feat/a', status: 'pending' });
      ok(r.ok, JSON.stringify(r.halt));
      strictEqual(r.lane.path, t.lane('A'));
      strictEqual(r.lane.form, 'new-branch');
      strictEqual(r.lane.base, moved, 'the branch starts at the baseline as origin has it now, not as last fetched');
      const w = t.worktree(r.lane.path);
      deepStrictEqual([w.branch, w.head, w.locked, w.lockReason], ['feat/a', moved, true, `agentic-autopilot ${t.fx.macroId} A`]);
      strictEqual(spawnSync('git', ['-C', t.fx.work, 'config', '--get', 'branch.feat/a.merge']).status, 1, 'no upstream is set');
      strictEqual(LN.readLaneIdentity(r.lane.path).identity.lane_id, r.lane.laneId);
      deepStrictEqual(t.events().map((e) => [e.event, e.subtask_id, e.lane_id, e.form]), [['created', 'A', r.lane.laneId, 'new-branch']]);
      strictEqual(LN.lanePreflight(r.lane.path, { env: t.fx.env }), null, 'the lane ignores the agentic state');
    } finally {
      t.fx.cleanup();
    }
  });

  it('attaches to an existing branch at the baseline, and refuses one that is not (a foreign branch)', async () => {
    const t = await setup();
    try {
      gitIn(t.fx, t.fx.work, 'branch', 'feat/a', 'refs/remotes/origin/main');
      const a = t.create({ id: 'A', branch: 'feat/a', status: 'pending' });
      ok(a.ok, JSON.stringify(a.halt));
      strictEqual(a.lane.form, 'existing-branch');
      gitIn(t.fx, t.fx.work, 'branch', 'feat/b', 'refs/remotes/origin/main');
      gitIn(t.fx, t.fx.work, 'commit-tree', '-m', 'x', 'HEAD^{tree}');
      const foreign = gitIn(t.fx, t.fx.work, 'commit-tree', '-p', 'HEAD', '-m', 'foreign', 'HEAD^{tree}');
      gitIn(t.fx, t.fx.work, 'update-ref', 'refs/heads/feat/b', foreign);
      const b = t.create({ id: 'B', branch: 'feat/b', status: 'pending' });
      strictEqual(b.ok, false);
      match(b.halt.detail, /feat\/b exists at .* which is not refs\/remotes\/origin\/main/);
      strictEqual(t.worktree(t.lane('B')), null, 'no lane was created');
    } finally {
      t.fx.cleanup();
    }
  });

  it('uses the last fetched baseline with a warning when the fetch fails, and halts when there is none', async () => {
    const t = await setup();
    try {
      gitIn(t.fx, t.fx.work, 'remote', 'set-url', 'origin', join(t.fx.dir, 'missing.git'));
      const lines = [];
      const r = LN.createLane({ home: t.home, checkout: t.fx.work, macroId: t.fx.macroId, subtask: { id: 'A', branch: 'feat/a', status: 'pending' }, view: viewOf([{ id: 'A', branch: 'feat/a', status: 'pending' }]), baseline: 'main', runId: RUN, runDir: t.runDir, env: t.fx.env, out: (s) => lines.push(s) });
      ok(r.ok, JSON.stringify(r.halt));
      strictEqual(r.lane.base, t.base);
      ok(lines.some((l) => /git fetch origin main failed .* using the last fetched refs\/remotes\/origin\/main/.test(l)), lines.join('\n'));
      ok(t.events().some((e) => e.event === 'fetch-warning'), 'the warning is in the ledger');
      gitIn(t.fx, t.fx.work, 'update-ref', '-d', 'refs/remotes/origin/main');
      const b = t.create({ id: 'B', branch: 'feat/b', status: 'pending' });
      strictEqual(b.ok, false);
      strictEqual(b.halt.reason, 'owner-choice');
      match(b.halt.detail, /no refs\/remotes\/origin\/main to cut or check a lane against/);
    } finally {
      t.fx.cleanup();
    }
  });

  it('halts with git\'s reason when the add fails, and never forces it', async () => {
    const t = await setup();
    try {
      mkdirSync(t.lane('A'), { recursive: true });
      writeFileSync(join(t.lane('A'), 'squatter.txt'), 'not ours\n');
      const r = t.create({ id: 'A', branch: 'feat/a', status: 'pending' });
      strictEqual(r.ok, false);
      match(r.halt.detail, /git worktree add .* failed: .*already exists/);
      ok(existsSync(join(t.lane('A'), 'squatter.txt')), 'the directory there is untouched');
      strictEqual(t.worktree(t.lane('A')), null);
      // git 2.54 creates the branch before it refuses the path (measured
      // 2026-10-09): the branch it leaves is at the baseline, so a relaunch
      // once the path is free attaches to it (row 12).
      strictEqual(gitIn(t.fx, t.fx.work, 'rev-parse', 'refs/heads/feat/a'), t.base);
      rmSync(t.lane('A'), { recursive: true, force: true });
      const again = t.create({ id: 'A', branch: 'feat/a', status: 'pending' });
      ok(again.ok, JSON.stringify(again.halt));
      strictEqual(again.lane.form, 'existing-branch');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('removal', () => {
  it('removes a clean lane of its own, keeps the branch, and closes the intent', async () => {
    const t = await setup();
    try {
      const { lane } = t.create({ id: 'A', branch: 'feat/a', status: 'pending' });
      const r = await LN.removeLane({ home: t.home, macroId: t.fx.macroId, subtaskId: 'A', runId: RUN, runDir: t.runDir, env: t.fx.env });
      strictEqual(r.outcome, 'removed', r.why);
      ok(!existsSync(lane.path));
      strictEqual(t.worktree(lane.path), null);
      ok(gitIn(t.fx, t.fx.work, 'rev-parse', 'refs/heads/feat/a'), 'the branch stays; the owner prunes it');
      deepStrictEqual(LN.readIntents(t.home.mainRoot, t.fx.macroId).map((i) => [i.event, i.lane_id]), [['intent', lane.laneId], ['done', lane.laneId]]);
      deepStrictEqual(t.events().map((e) => e.event), ['created', 'removed']);
    } finally {
      t.fx.cleanup();
    }
  });

  it('keeps a dirty lane, and one holding a shared record, still locked', async () => {
    const t = await setup();
    try {
      const a = t.create({ id: 'A', branch: 'feat/a', status: 'pending' }).lane;
      writeFileSync(join(a.path, 'wip.txt'), 'wip\n');
      const ra = await LN.removeLane({ home: t.home, macroId: t.fx.macroId, subtaskId: 'A', runId: RUN, runDir: t.runDir, env: t.fx.env });
      strictEqual(ra.outcome, 'kept');
      match(ra.why, /not clean: \?\? wip\.txt/);
      const b = t.create({ id: 'B', branch: 'feat/b', status: 'pending' }).lane;
      mkdirSync(join(b.path, '.agentic-plugins/state/engineer/workflows'), { recursive: true });
      writeFileSync(join(b.path, '.agentic-plugins/state/engineer/workflows/compose-x.md'), '---\n---\n');
      const rb = await LN.removeLane({ home: t.home, macroId: t.fx.macroId, subtaskId: 'B', runId: RUN, runDir: t.runDir, env: t.fx.env });
      strictEqual(rb.outcome, 'kept');
      match(rb.why, /\.agentic-plugins\/state\/engineer\/workflows in the lane holds 1 entry/);
      for (const l of [a, b]) {
        ok(existsSync(l.path));
        strictEqual(t.worktree(l.path).lockReason, LN.lockReason(t.fx.macroId, l.subtaskId), 'still locked with our reason');
      }
      deepStrictEqual(LN.readIntents(t.home.mainRoot, t.fx.macroId), [], 'no removal was announced');
    } finally {
      t.fx.cleanup();
    }
  });

  it('never touches a worktree it cannot prove its own', async () => {
    const t = await setup();
    try {
      t.rawLane('A', 'feat/a', { reason: 'the owner\'s lock' });
      t.rawLane('B', 'feat/b', { reason: null });
      for (const id of ['A', 'B']) {
        const r = await LN.removeLane({ home: t.home, macroId: t.fx.macroId, subtaskId: id, runId: RUN, runDir: t.runDir, env: t.fx.env });
        strictEqual(r.outcome, 'not-ours', id);
        ok(existsSync(t.lane(id)), id);
      }
    } finally {
      t.fx.cleanup();
    }
  });

  it('checks again after the unlock, and locks a lane again and records it kept when it changed after the check', async () => {
    const t = await setup();
    try {
      const { lane } = t.create({ id: 'A', branch: 'feat/a', status: 'pending' });
      const r = await LN.removeLane({
        home: t.home, macroId: t.fx.macroId, subtaskId: 'A', runId: RUN, runDir: t.runDir, env: t.fx.env,
        hooks: { afterCheck: () => writeFileSync(join(lane.path, 'late.txt'), 'late\n') },
      });
      strictEqual(r.outcome, 'kept');
      match(r.why, /not clean: \?\? late\.txt/);
      ok(existsSync(join(lane.path, 'late.txt')));
      strictEqual(t.worktree(lane.path).lockReason, LN.lockReason(t.fx.macroId, 'A'), 'locked again with the same reason');
      deepStrictEqual(LN.readIntents(t.home.mainRoot, t.fx.macroId).map((i) => i.event), ['intent', 'kept']);
      deepStrictEqual(LN.openIntents(t.home.mainRoot, t.fx.macroId), []);
      // A remove git itself refuses, after the second check.
      rmSync(join(lane.path, 'late.txt'));
      const r2 = await LN.removeLane({
        home: t.home, macroId: t.fx.macroId, subtaskId: 'A', runId: RUN, runDir: t.runDir, env: t.fx.env,
        hooks: { beforeRemove: () => writeFileSync(join(lane.path, 'later.txt'), 'later\n') },
      });
      strictEqual(r2.outcome, 'kept');
      match(r2.why, /git worktree remove refused/);
      strictEqual(t.worktree(lane.path).lockReason, LN.lockReason(t.fx.macroId, 'A'));
      deepStrictEqual(LN.openIntents(t.home.mainRoot, t.fx.macroId), []);
    } finally {
      t.fx.cleanup();
    }
  });

  it('leaves the removal intent open when the lane cannot be locked again: the only proof left that it is ours', async () => {
    const t = await setup();
    try {
      const { lane } = t.create({ id: 'A', branch: 'feat/a', status: 'pending' });
      const r = await LN.removeLane({
        home: t.home, macroId: t.fx.macroId, subtaskId: 'A', runId: RUN, runDir: t.runDir, env: t.fx.env,
        hooks: { beforeRemove: () => gitIn(t.fx, t.fx.work, 'worktree', 'lock', '--reason', 'someone else', lane.path) },
      });
      strictEqual(r.outcome, 'kept');
      match(r.why, /its removal intent stays open/);
      deepStrictEqual(LN.openIntents(t.home.mainRoot, t.fx.macroId).map((i) => i.lane_id), [lane.laneId]);
      ok(existsSync(lane.path));
    } finally {
      t.fx.cleanup();
    }
  });

  it('never removes a lane holding the driver\'s checkout, its run directory or the state root', async () => {
    const t = await setup();
    try {
      const { lane } = t.create({ id: 'A', branch: 'feat/a', status: 'pending' });
      const runDirInLane = join(lane.path, '.agentic-plugins/runs/autopilot', RUN);
      const r = await LN.removeLane({ home: t.home, macroId: t.fx.macroId, subtaskId: 'A', runId: RUN, runDir: t.runDir, env: t.fx.env, protect: [t.fx.work, runDirInLane] });
      strictEqual(r.outcome, 'kept');
      match(r.why, /holds .* which this run needs/);
      ok(existsSync(lane.path));
      const view = viewOf([{ id: 'A', branch: 'feat/a', status: 'completed' }]);
      const rec = await LN.reconcileLanes({ home: t.home, checkout: t.fx.work, macroId: t.fx.macroId, view, baseline: 'main', runId: RUN, runDir: t.runDir, env: t.fx.env, protect: [lane.path] });
      ok(existsSync(lane.path), 'row 7 keeps it too');
      ok(rec.reports.some((x) => /which this run needs/.test(x)), rec.reports.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });

  it('keeps a lane whose worktree lock another run or session holds, announcing nothing, unless the entry is the caller\'s own (removal and row 7)', async () => {
    const t = await setup();
    let other = null;
    try {
      const { lane } = t.create({ id: 'A', branch: 'feat/a', status: 'pending' });
      other = await RLK.acquireLock(RLK.worktreeLockPath(lane.path), { record: { run_id: OTHER_RUN } });
      const r = await LN.removeLane({ home: t.home, macroId: t.fx.macroId, subtaskId: 'A', runId: RUN, runDir: t.runDir, env: t.fx.env });
      strictEqual(r.outcome, 'kept');
      match(r.why, /a run or a session holds the lane's worktree lock/);
      const rec = await t.reconcile(viewOf([{ id: 'A', branch: 'feat/a', status: 'completed' }]));
      ok(rec.reports.some((x) => /lane .*\/A of subtask A \(completed\) is kept: a run or a session holds the lane's worktree lock/.test(x)), rec.reports.join('\n'));
      ok(existsSync(lane.path));
      strictEqual(t.worktree(lane.path).lockReason, LN.lockReason(t.fx.macroId, 'A'), 'still locked with our reason');
      deepStrictEqual(LN.readIntents(t.home.mainRoot, t.fx.macroId), [], 'no removal was announced');
      // The caller's own entry in the lane's lock does not keep the lane.
      const own = await LN.removeLane({ home: t.home, macroId: t.fx.macroId, subtaskId: 'A', runId: RUN, runDir: t.runDir, env: t.fx.env, ownLaneLock: other.entry });
      strictEqual(own.outcome, 'removed', own.why);
      ok(!existsSync(lane.path));
    } finally {
      other?.release();
      t.fx.cleanup();
    }
  });

  it('leaves a lane whose identity changed after it was judged as it is: locked, with nothing announced', async () => {
    const t = await setup();
    try {
      const { lane } = t.create({ id: 'A', branch: 'feat/a', status: 'pending' });
      const r = await LN.removeLane({
        home: t.home, macroId: t.fx.macroId, subtaskId: 'A', runId: RUN, runDir: t.runDir, env: t.fx.env,
        hooks: {
          afterCheck: () => {
            rmSync(LN.laneIdentityPath(lane.path));
            LN.writeLaneIdentity(lane.path, { macroId: t.fx.macroId, subtaskId: 'A', branch: 'feat/a', laneId: 'f'.repeat(16) });
          },
        },
      });
      strictEqual(r.outcome, 'kept');
      match(r.why, /changed after it was judged \(identity f{16}, not [0-9a-f]{16}\)/);
      ok(existsSync(lane.path));
      strictEqual(t.worktree(lane.path).lockReason, LN.lockReason(t.fx.macroId, 'A'), 'never unlocked');
      deepStrictEqual(LN.readIntents(t.home.mainRoot, t.fx.macroId), [], 'no removal was announced');
    } finally {
      t.fx.cleanup();
    }
  });

  it('reads the lane again before the remove: a worktree that replaced it after the unlock is neither removed nor locked as the run\'s', async () => {
    const t = await setup();
    try {
      const { lane } = t.create({ id: 'A', branch: 'feat/a', status: 'pending' });
      let replaced = false;
      const r = await LN.removeLane({
        home: t.home, macroId: t.fx.macroId, subtaskId: 'A', runId: RUN, runDir: t.runDir, env: t.fx.env,
        hooks: {
          // Someone removes the unlocked lane and adds a worktree of their own
          // at its path: clean, so the second removal check passes.
          afterUnlock: () => {
            gitIn(t.fx, t.fx.work, 'worktree', 'remove', lane.path);
            gitIn(t.fx, t.fx.work, 'worktree', 'add', '-q', '-b', 'theirs', lane.path, 'refs/remotes/origin/main');
            replaced = true;
          },
        },
      });
      ok(replaced);
      strictEqual(r.outcome, 'kept');
      match(r.why, /the lane changed after the unlock \(identity absent, not [0-9a-f]{16}\); locking it again failed \(it is no longer the lane .*\), so its removal intent stays open/);
      const w = t.worktree(lane.path);
      strictEqual(w?.branch, 'theirs', 'their worktree is still there');
      strictEqual(w.locked, false, 'and not locked with the run\'s reason');
      deepStrictEqual(LN.openIntents(t.home.mainRoot, t.fx.macroId).map((i) => i.lane_id), [lane.laneId],
        'the intent stays open: only the lane it names, at that path, closes it');
    } finally {
      t.fx.cleanup();
    }
  });

  it('keeps a lane a run or a session joined after the unlock, locked again with its reason', async () => {
    const t = await setup();
    let joined = null;
    try {
      const { lane } = t.create({ id: 'A', branch: 'feat/a', status: 'pending' });
      const r = await LN.removeLane({
        home: t.home, macroId: t.fx.macroId, subtaskId: 'A', runId: RUN, runDir: t.runDir, env: t.fx.env,
        hooks: { afterUnlock: async () => { joined = await RLK.acquireLock(RLK.worktreeLockPath(lane.path), { record: { run_id: OTHER_RUN } }); } },
      });
      ok(joined);
      strictEqual(r.outcome, 'kept');
      match(r.why, /a run or a session joined the lane's worktree lock/);
      ok(existsSync(lane.path));
      strictEqual(t.worktree(lane.path).lockReason, LN.lockReason(t.fx.macroId, 'A'), 'locked again with the same reason');
      deepStrictEqual(LN.readIntents(t.home.mainRoot, t.fx.macroId).map((i) => i.event), ['intent', 'kept']);
    } finally {
      joined?.release();
      t.fx.cleanup();
    }
  });

  it('after an unlock git reports failed, asks git whether the lane is locked rather than reading the message: locked again when it is not', async () => {
    const t = await setup();
    // One git unlocks, then reports failure; the other refuses and unlocks nothing.
    const unlockedAnyway = translatedGit(t.fx, '"$REAL" "$@" >/dev/null 2>&1; echo "fatal: Entsperren fehlgeschlagen" >&2; exit 1');
    const refused = translatedGit(t.fx, 'echo "fatal: Entsperren verweigert" >&2; exit 1');
    try {
      const a = t.create({ id: 'A', branch: 'feat/a', status: 'pending' }).lane;
      const ra = await LN.removeLane({ home: t.home, macroId: t.fx.macroId, subtaskId: 'A', runId: RUN, runDir: t.runDir, env: unlockedAnyway.env });
      strictEqual(ra.outcome, 'kept');
      match(ra.why, /git worktree unlock refused: fatal: Entsperren fehlgeschlagen/);
      strictEqual(t.worktree(a.path).lockReason, LN.lockReason(t.fx.macroId, 'A'), 'the lane git did unlock is locked again with its reason');
      const b = t.create({ id: 'B', branch: 'feat/b', status: 'pending' }).lane;
      const rb = await LN.removeLane({ home: t.home, macroId: t.fx.macroId, subtaskId: 'B', runId: RUN, runDir: t.runDir, env: refused.env });
      strictEqual(rb.outcome, 'kept');
      strictEqual(t.worktree(b.path).lockReason, LN.lockReason(t.fx.macroId, 'B'), 'the lane git did not unlock is still locked');
      for (const l of [a, b]) ok(existsSync(l.path));
      deepStrictEqual(LN.openIntents(t.home.mainRoot, t.fx.macroId), [], 'each intent is closed: each lane is locked with our reason');
    } finally {
      unlockedAnyway.done();
      refused.done();
      t.fx.cleanup();
    }
  });
});

describe('the rollback fence (Decision 4, item 4)', () => {
  it('records lanes_first_run_at before the first lane, after which the cutover cannot be rolled back; reconciliation sets it when it is missing', async () => {
    const t = await setup();
    try {
      strictEqual(SR.readSharedCreation(t.home.mainRoot).record.lanes_first_run_at, null);
      ok(t.create({ id: 'A', branch: 'feat/a', status: 'pending' }).ok);
      const at = SR.readSharedCreation(t.home.mainRoot).record.lanes_first_run_at;
      match(at ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      let refused = null;
      try { SR.disableSharedCreation({ checkout: t.home.mainRoot }); } catch (e) { refused = e; }
      match(refused?.message ?? '', /Lanes first ran at/);
      ok(t.create({ id: 'B', branch: 'feat/b', status: 'pending' }).ok);
      strictEqual(SR.readSharedCreation(t.home.mainRoot).record.lanes_first_run_at, at, 'set once');
      deepStrictEqual(t.allEvents().filter((e) => e.event === 'lanes-first-run').map((e) => e.lanes_first_run_at), [at], 'recorded once in the ledger');
    } finally {
      t.fx.cleanup();
    }
    const u = await setup();
    try {
      u.rawLane('A', 'feat/a');
      await u.reconcile(viewOf([{ id: 'A', branch: 'feat/a', status: 'pending' }]));
      match(SR.readSharedCreation(u.home.mainRoot).record.lanes_first_run_at ?? '', /^\d{4}-/);
    } finally {
      u.fx.cleanup();
    }
  });

  it('creates no lane while shared creation is off', async () => {
    const t = await setup({ shared: false });
    try {
      const r = t.create({ id: 'A', branch: 'feat/a', status: 'pending' });
      strictEqual(r.ok, false);
      match(r.halt.detail, /no lane was created: lanes need shared creation on/);
      strictEqual(t.worktree(t.lane('A')), null);
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('reconciliation', () => {
  it('adopts a lane whose creation succeeded before its ledger write, giving it an identity while it is locked (rows 6, pre-pass)', async () => {
    const t = await setup();
    try {
      const p = t.rawLane('A', 'feat/a', { identity: false });
      const view = viewOf([{ id: 'A', branch: 'feat/a', status: 'in_progress' }], { children: { A: { location: 'active', branch: 'feat/a' } } });
      const r = await t.reconcile(view);
      strictEqual(r.halt, null, JSON.stringify(r.halt));
      const id = LN.readLaneIdentity(p);
      strictEqual(id.state, 'ok');
      deepStrictEqual([...r.lanes.keys()], ['A']);
      deepStrictEqual([r.lanes.get('A').state, r.lanes.get('A').laneId], ['adopt', id.identity.lane_id]);
      deepStrictEqual(t.events().map((e) => [e.event, e.lane_id]), [['identity-assigned', id.identity.lane_id], ['adopted', id.identity.lane_id]]);
    } finally {
      t.fx.cleanup();
    }
  });

  it('halts on a subtask whose branch is checked out in a worktree that is not one of its lanes, the driver\'s own included (row 11)', async () => {
    const t = await setup();
    try {
      gitIn(t.fx, t.fx.work, 'worktree', 'add', '-q', join(t.fx.dir, 'elsewhere'), '-b', 'feat/a', 'refs/remotes/origin/main');
      gitIn(t.fx, t.fx.work, 'switch', '-q', '-c', 'feat/b', 'refs/remotes/origin/main');
      const view = viewOf([{ id: 'A', branch: 'feat/a', status: 'pending' }, { id: 'B', branch: 'feat/b', status: 'in_progress' }], { children: { B: { location: 'active', branch: 'feat/b' } } });
      const r = await t.reconcile(view);
      deepStrictEqual(r.halts.map((h) => [h.row, h.subtaskId]), [[11, 'A'], [11, 'B']]);
      match(r.halts[0].detail, /checked out in .*elsewhere, a worktree that is not one of this run's lanes/);
      match(r.halts[1].detail, /checked out in the driver's own checkout .*switch it off feat\/b and relaunch/);
      deepStrictEqual(r.toCreate, []);
    } finally {
      t.fx.cleanup();
    }
  });

  it('judges readiness from the plan: a subtask waiting on a predecessor gets no lane, and a look that could not list the claims halts', async () => {
    const t = await setup();
    try {
      const plan = [
        { id: 'A', branch: 'feat/a', status: 'in_progress' },
        { id: 'B', branch: 'feat/b', status: 'pending', blocked_by: ['A'] },
        { id: 'C', branch: 'feat/c', status: 'pending', blocked_by: [] },
      ];
      const r = await t.reconcile(viewOf(plan));
      deepStrictEqual(r.toCreate.map((s) => s.subtaskId), ['C'], 'B waits on A; A has no live child');
      // Row 10: A's live child is on feat/a, which no worktree has checked out
      // (a serial run's subtask): it gets a lane on that branch.
      gitIn(t.fx, t.fx.work, 'branch', 'feat/a', 'refs/remotes/origin/main');
      const live = await t.reconcile(viewOf(plan, { children: { A: { location: 'active', branch: 'feat/a' } } }));
      deepStrictEqual(live.toCreate.map((s) => [s.subtaskId, s.row, s.action]), [['A', 10, 'existing-branch'], ['C', null, 'new-branch']]);
      const e = await t.reconcile(viewOf(plan, { claimsError: 'cannot list /x' }));
      match(e.halt?.detail ?? '', /could not be listed .*no subtask can be judged unclaimed/);
      deepStrictEqual(e.toCreate, []);
    } finally {
      t.fx.cleanup();
    }
  });

  it('reuses an existing unclaimed branch only at the baseline, and halts on one that is not (row 12)', async () => {
    const t = await setup();
    try {
      gitIn(t.fx, t.fx.work, 'branch', 'feat/a', 'refs/remotes/origin/main');
      const ahead = gitIn(t.fx, t.fx.work, 'commit-tree', '-p', 'HEAD', '-m', 'ahead', 'HEAD^{tree}');
      gitIn(t.fx, t.fx.work, 'update-ref', 'refs/heads/feat/b', ahead);
      const view = viewOf([{ id: 'A', branch: 'feat/a', status: 'pending' }, { id: 'B', branch: 'feat/b', status: 'pending' }, { id: 'C', branch: 'feat/c', status: 'pending' }]);
      const r = await t.reconcile(view);
      deepStrictEqual(r.toCreate.map((s) => [s.subtaskId, s.row, s.action]), [['A', 12, 'existing-branch'], ['C', null, 'new-branch']]);
      deepStrictEqual(r.halts.map((h) => [h.row, h.subtaskId]), [[12, 'B']]);
    } finally {
      t.fx.cleanup();
    }
  });

  it('keeps a prepared lane while it is at the baseline, and halts once the baseline moved (row 4)', async () => {
    const t = await setup();
    try {
      t.rawLane('A', 'feat/a');
      const view = viewOf([{ id: 'A', branch: 'feat/a', status: 'pending' }]);
      let r = await t.reconcile(view);
      strictEqual(r.halt, null, JSON.stringify(r.halt));
      deepStrictEqual([r.lanes.get('A').state, r.lanes.get('A').ready], ['prepared', true]);
      t.moveBaseline();
      r = await t.reconcile(view);
      strictEqual(r.halt?.row, 4);
      match(r.halt.detail, /the baseline moved since the lane was cut/);
      ok(existsSync(t.lane('A')), 'the lane is kept for the owner');
    } finally {
      t.fx.cleanup();
    }
  });

  it('halts on a lane whose branch the plan changed (row 3), and on a pending subtask its lane\'s child claims (row 5)', async () => {
    const t = await setup();
    try {
      t.rawLane('A', 'feat/a');
      t.rawLane('B', 'feat/b');
      const view = viewOf([{ id: 'A', branch: 'feat/a2', status: 'in_progress' }, { id: 'B', branch: 'feat/b', status: 'pending' }],
        { children: { A: { location: 'active', branch: 'feat/a' } }, claims: [{ id: 'compose-x', originating_subtask: 'B', branch: 'feat/b' }] });
      const r = await t.reconcile(view);
      deepStrictEqual(r.halts.map((h) => [h.row, h.subtaskId]), [[3, 'A'], [5, 'B']]);
      match(r.halts[0].detail, /a lane is never re-pointed/);
      match(r.halts[1].detail, /re-attach it with \/orchestrator:next B/);
    } finally {
      t.fx.cleanup();
    }
  });

  it('finishes a cleanup interrupted after done: a completed subtask\'s lane, a crash after the unlock, and one after the remove (rows 7, 9, pre-pass)', async () => {
    const t = await setup();
    try {
      // Row 7: done recorded, the lane never removed.
      t.rawLane('A', 'feat/a');
      // Row 9: the intent written and the unlock done, the remove never ran.
      const b = t.rawLane('B', 'feat/b');
      const bId = LN.readLaneIdentity(b).identity.lane_id;
      LN.appendIntent(t.home.mainRoot, t.fx.macroId, { event: 'intent', path: b, lane_id: bId, subtask_id: 'B' });
      gitIn(t.fx, t.fx.work, 'worktree', 'unlock', b);
      // Pre-pass: the remove finished, the done record never written.
      LN.appendIntent(t.home.mainRoot, t.fx.macroId, { event: 'intent', path: t.lane('C'), lane_id: 'c'.repeat(16), subtask_id: 'C' });
      const view = viewOf(['A', 'B', 'C'].map((id) => ({ id, branch: `feat/${id.toLowerCase()}`, status: 'completed' })));
      const r = await t.reconcile(view);
      strictEqual(r.halt, null, JSON.stringify(r.halt));
      for (const id of ['A', 'B']) {
        ok(!existsSync(t.lane(id)), id);
        strictEqual(t.worktree(t.lane(id)), null, id);
      }
      deepStrictEqual(LN.openIntents(t.home.mainRoot, t.fx.macroId), [], 'every intent is closed');
      const done = LN.readIntents(t.home.mainRoot, t.fx.macroId).filter((i) => i.event === 'done').map((i) => i.subtask_id).sort();
      deepStrictEqual(done, ['A', 'B', 'C']);
    } finally {
      t.fx.cleanup();
    }
  });

  it('keeps a completed lane that fails the removal check, and relocks a crashed removal whose lane changed (rows 8, 9)', async () => {
    const t = await setup();
    try {
      const a = t.rawLane('A', 'feat/a');
      writeFileSync(join(a, 'wip.txt'), 'wip\n');
      const b = t.rawLane('B', 'feat/b');
      LN.appendIntent(t.home.mainRoot, t.fx.macroId, { event: 'intent', path: b, lane_id: LN.readLaneIdentity(b).identity.lane_id, subtask_id: 'B' });
      gitIn(t.fx, t.fx.work, 'worktree', 'unlock', b);
      writeFileSync(join(b, 'wip.txt'), 'wip\n');
      const view = viewOf(['A', 'B'].map((id) => ({ id, branch: `feat/${id.toLowerCase()}`, status: 'completed' })));
      const r = await t.reconcile(view);
      strictEqual(r.halt, null);
      for (const p of [a, b]) {
        ok(existsSync(join(p, 'wip.txt')));
        ok(t.worktree(p).locked, `${p} is locked`);
      }
      ok(r.reports.some((x) => /lane .*\/A of subtask A \(completed\) is kept: the lane is not clean/.test(x)), r.reports.join('\n'));
      ok(r.reports.some((x) => /kept the lane .*\/B \(locked again\)/.test(x)), r.reports.join('\n'));
      deepStrictEqual(LN.openIntents(t.home.mainRoot, t.fx.macroId), []);
    } finally {
      t.fx.cleanup();
    }
  });

  it('reports and never touches what it cannot prove ours, and halts on a lane whose directory is gone without pruning it (rows 1, 2, 9, 13)', async () => {
    const t = await setup();
    try {
      // Row 13: no lock, another macro's reason, and an unlocked worktree at
      // one of our lane paths whose identity does not match an intent.
      const stray = join(t.home.lanesDir, 'stray');
      gitIn(t.fx, t.fx.work, 'worktree', 'add', '-q', stray, '-b', 'stray', 'refs/remotes/origin/main');
      const foreign = join(t.home.lanesDir, 'macro-plan-20261001T000000Z-ffffff', 'A');
      gitIn(t.fx, t.fx.work, 'worktree', 'add', '-q', '--lock', '--reason', 'agentic-autopilot macro-plan-20261001T000000Z-ffffff A', foreign, '-b', 'foreign', 'refs/remotes/origin/main');
      const unlocked = t.rawLane('D', 'feat/d', { reason: null });
      LN.appendIntent(t.home.mainRoot, t.fx.macroId, { event: 'intent', path: unlocked, lane_id: 'e'.repeat(16), subtask_id: 'D' });
      // Row 2: a lane whose subtask left the plan.
      t.rawLane('Z', 'feat/z');
      // Row 1: a lane whose directory is gone.
      const gone = t.rawLane('A', 'feat/a');
      rmSync(gone, { recursive: true, force: true });
      const view = viewOf([{ id: 'A', branch: 'feat/a', status: 'in_progress' }], { children: { A: { location: 'active', branch: 'feat/a' } } });
      const r = await t.reconcile(view);
      deepStrictEqual(r.halts.map((h) => [h.row, h.subtaskId]), [[1, 'A']]);
      match(r.halt.detail, /git worktree unlock .* && git worktree prune \(the driver never prunes\)/);
      ok(t.worktree(gone), 'git still registers the gone lane: nothing was pruned');
      for (const p of [stray, foreign, unlocked, t.lane('Z')]) ok(existsSync(p), `${p} is untouched`);
      strictEqual(t.worktree(unlocked).locked, false, 'an unlocked worktree not provably ours is not locked by us');
      ok(r.reports.some((x) => /subtask Z is no longer in the plan/.test(x)), r.reports.join('\n'));
      strictEqual(r.reports.filter((x) => /left alone/.test(x)).length, 3, r.reports.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });

  it('halts on a pending subtask an engineer workflow already claims while it has no lane: re-attached, never dispatched twice', async () => {
    const t = await setup();
    try {
      const view = viewOf([{ id: 'A', branch: 'feat/a', status: 'pending' }], { claims: [{ id: 'compose-x', originating_subtask: 'A', branch: 'feat/a' }] });
      const r = await t.reconcile(view);
      deepStrictEqual(r.halts.map((h) => h.subtaskId), ['A']);
      match(r.halt.detail, /the engineer workflow compose-x claims it: .*re-attach it with \/orchestrator:next A/);
      deepStrictEqual(r.toCreate, []);
      const c = t.create({ id: 'A', branch: 'feat/a', status: 'pending' }, view);
      strictEqual(c.ok, false);
      match(c.halt.detail, /claims it/);
      strictEqual(t.worktree(t.lane('A')), null, 'no lane was created');
    } finally {
      t.fx.cleanup();
    }
  });

  it('locks a crashed removal again only while the worktree there is the lane its intent names (row 9)', async () => {
    const t = await setup();
    try {
      const b = t.rawLane('B', 'feat/b');
      const bId = LN.readLaneIdentity(b).identity.lane_id;
      LN.appendIntent(t.home.mainRoot, t.fx.macroId, { event: 'intent', path: b, lane_id: bId, subtask_id: 'B' });
      gitIn(t.fx, t.fx.work, 'worktree', 'unlock', b);
      writeFileSync(join(b, 'wip.txt'), 'wip\n');
      const view = viewOf([{ id: 'B', branch: 'feat/b', status: 'completed' }]);
      let replaced = false;
      const r = await LN.reconcileLanes({
        home: t.home, checkout: t.fx.work, macroId: t.fx.macroId, view, baseline: 'main', runId: RUN, runDir: t.runDir, env: t.fx.env,
        hooks: {
          // Between the look and the relock, someone replaces it at its path.
          beforeRelock: (p) => {
            gitIn(t.fx, t.fx.work, 'worktree', 'remove', '--force', p);
            gitIn(t.fx, t.fx.work, 'worktree', 'add', '-q', '-b', 'theirs', p, 'refs/remotes/origin/main');
            replaced = true;
          },
        },
      });
      ok(replaced);
      const w = t.worktree(b);
      strictEqual(w?.branch, 'theirs');
      strictEqual(w.locked, false, 'their worktree is not locked with the run\'s reason');
      ok(r.reports.some((x) => /kept the lane .*\/B, unlocked: .*locking it again failed \(it is no longer the lane/.test(x)), r.reports.join('\n'));
      deepStrictEqual(LN.openIntents(t.home.mainRoot, t.fx.macroId).map((i) => i.lane_id), [bId]);
    } finally {
      t.fx.cleanup();
    }
  });

  it('finishes a crashed removal without unlocking it again, so a git that speaks another language changes nothing (row 9)', async () => {
    const t = await setup();
    // A git whose failing unlock says so in German only.
    const wrap = translatedGit(t.fx, '"$REAL" "$@" 2>/dev/null && exit 0; rc=$?; echo "fatal: der Arbeitsbereich ist nicht gesperrt" >&2; exit $rc');
    try {
      const { env } = wrap;
      const b = t.rawLane('B', 'feat/b');
      LN.appendIntent(t.home.mainRoot, t.fx.macroId, { event: 'intent', path: b, lane_id: LN.readLaneIdentity(b).identity.lane_id, subtask_id: 'B' });
      gitIn(t.fx, t.fx.work, 'worktree', 'unlock', b);
      // The control: this git is the one the lane layer runs, and its message is not English.
      const probe = spawnSync('git', ['-C', t.fx.work, 'worktree', 'unlock', b], { env, encoding: 'utf8' });
      ok(probe.status !== 0 && /nicht gesperrt/.test(probe.stderr) && !/is not locked/.test(probe.stderr), probe.stderr);
      const r = await LN.reconcileLanes({ home: t.home, checkout: t.fx.work, macroId: t.fx.macroId, view: viewOf([{ id: 'B', branch: 'feat/b', status: 'completed' }]), baseline: 'main', runId: RUN, runDir: t.runDir, env });
      strictEqual(r.halt, null, JSON.stringify(r.halt));
      ok(!existsSync(b), r.reports.join('\n'));
      strictEqual(t.worktree(b), null);
      deepStrictEqual(LN.openIntents(t.home.mainRoot, t.fx.macroId), []);
      deepStrictEqual(LN.readIntents(t.home.mainRoot, t.fx.macroId).map((i) => i.event), ['intent', 'done']);
    } finally {
      wrap.done();
      t.fx.cleanup();
    }
  });
});

describe('a run\'s worker groups in its locks (Decision 6, Locks)', () => {
  const DRIVER = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-lane-driver.mjs');
  const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };

  it('a dead driver with two surviving groups keeps the macro lock live; status shows both and stop empties both', { timeout: 90_000 }, async (t) => {
    const fx = await makeRepo();
    const runId = 'autopilot-20261009T000000Z-4d5e6f';
    let groups = [];
    let driver = null;
    try {
      if ((await L.processFingerprint(process.pid)).kind === 'none') { t.skip('no process fingerprint on this platform'); return; }
      const lock = L.macroLockPath(L.mainWorktreeRoot(fx.work), fx.macroId);
      const runDir = L.createRunDir(fx.work, runId);
      L.writeRun(runDir, { run_id: runId, status: 'running', macro_id: fx.macroId, steps: 0, cost_usd: 0, started_at: 'then' });
      const ready = join(fx.dir, 'groups.json');
      const { spawn } = await import('node:child_process');
      driver = spawn(process.execPath, [DRIVER, lock, ready, runId, fx.macroId, fx.work, fx.dir], { stdio: 'ignore', env: fx.env });
      for (let i = 0; i < 150 && !existsSync(ready); i += 1) await new Promise((r) => { setTimeout(r, 100); });
      ok(existsSync(ready), 'the driver started its two groups');
      groups = JSON.parse(readFileSync(ready, 'utf8')).groups;
      const exited = new Promise((r) => driver.on('exit', r));
      driver.kill('SIGKILL');
      await exited;

      const entries = L.readLockEntries(lock);
      strictEqual(entries.length, 3, 'the run\'s own entry and one per group');
      const alive = [];
      for (const e of entries) alive.push([e.holder.worker?.lane ?? null, await L.holderAlive(e.holder)]);
      deepStrictEqual(alive.sort(), [['A', true], ['B', true], [null, false]].sort());
      let refused = null;
      try { (await L.acquireLock(lock, { record: { run_id: 'autopilot-20261009T000001Z-aaaaaa', macro_id: fx.macroId } })).release(); } catch (e) { refused = e; }
      ok(refused instanceof L.LockHeldError, `a second run is refused while a group of the dead driver lives: ${refused}`);

      const lines = [];
      const say = (s) => lines.push(s);
      strictEqual(await C.main(['status', '--repo', fx.work], { env: fx.env, out: say, err: say }), 0);
      ok(lines.some((l) => /its driver is gone, but 2 worker groups still run/.test(l)), lines.join('\n'));
      for (const lane of ['A', 'B']) ok(lines.some((l) => new RegExp(`worker group \\d+ \\(lane ${lane}, `).test(l)), lines.join('\n'));

      ok(L.readOpenRun(L.mainWorktreeRoot(fx.work), runId), 'the driver put its open-run record down');
      lines.length = 0;
      strictEqual(await C.main(['stop', '--repo', fx.work], { env: fx.env, out: say, err: say }), 0, lines.join('\n'));
      for (const pgid of groups) ok(!groupAlive(pgid), `group ${pgid} is empty after stop:\n${lines.join('\n')}`);
      ok(lines.some((l) => /lane A/.test(l)) && lines.some((l) => /lane B/.test(l)), lines.join('\n'));
      // Then, and only then, it cleans up after the dead driver: the run is
      // recorded halted, and its open-run record goes.
      const after = L.readRun(fx.work, runId);
      deepStrictEqual([after.run.status, after.run.halt?.reason, after.run.dead_run_cleanup?.by], ['halted', 'interrupted', 'stop'], lines.join('\n'));
      strictEqual(L.readOpenRun(L.mainWorktreeRoot(fx.work), runId), null, 'the open-run record is removed');
      const next = await L.acquireLock(lock, { record: { run_id: 'autopilot-20261009T000002Z-bbbbbb', macro_id: fx.macroId } });
      next.release();
    } finally {
      driver?.kill('SIGKILL');
      for (const pgid of groups) { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } }
      fx.cleanup();
    }
  });

  it('adds a group entry only while the run holds the lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lanes-lock-'));
    try {
      const lock = join(dir, 'x.lock');
      const held = await L.acquireLock(lock, { record: { run_id: RUN } });
      const g = held.addWorkerGroup({ pid: process.pid, lane: 'A', cwd: dir });
      strictEqual(L.readLockEntries(lock).length, 2);
      strictEqual(L.readLockEntries(lock).find((e) => e.file === g.entry).holder.worker.lane, 'A');
      g.release();
      held.release();
      let threw = false;
      try { held.addWorkerGroup({ pid: process.pid }); } catch { threw = true; }
      ok(threw, 'refused after the release');
      deepStrictEqual(L.readLockEntries(lock), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('where a step runs', () => {
  it('runs dispatch, verbs and commit in the lane with the default state root, and done and finalize in the driver\'s checkout', async () => {
    const t = await setup();
    try {
      SR.enableSharedCreation({ checkout: t.home.mainRoot, versions: { orchestrator: 'test' } });
      const stateRoot = { root: t.home.mainRoot, source: 'default-state-root', shared_creation: 'on' };
      const lanes = new Map([['A', { path: t.rawLane('A', 'feat/a'), subtaskId: 'A' }]]);
      for (const kind of ['dispatch', 'verb', 'commit']) {
        deepStrictEqual(LN.stepPlacement({ kind, subtaskId: 'A' }, { lanes, checkout: t.fx.work, stateRoot }), { cwd: t.lane('A'), stateBase: t.home.mainRoot, lane: 'A' }, kind);
      }
      for (const kind of ['done', 'done-no-commit', 'finalize']) {
        deepStrictEqual(LN.stepPlacement({ kind, subtaskId: 'A' }, { lanes, checkout: t.fx.work, stateRoot }), { cwd: t.fx.work, stateBase: t.home.mainRoot, lane: null }, kind);
      }
      match(LN.stepPlacement({ kind: 'verb', subtaskId: 'B' }, { lanes, checkout: t.fx.work, stateRoot }).problem, /subtask B has no lane/);
      // An operator override that names the driver's checkout binds the run,
      // and a lane refuses it: lanes need the default state root.
      const operator = { root: realpathSync(t.fx.work), source: 'operator', shared_creation: 'on' };
      match(LN.stepPlacement({ kind: 'verb', subtaskId: 'A' }, { lanes, checkout: t.fx.work, stateRoot: operator }).problem, /would not accept the run's state root/);
      deepStrictEqual(LN.lanesRequirements({ checkout: t.fx.work, stateRoot, macroPath: null }), []);
      match(LN.lanesRequirements({ checkout: t.fx.work, stateRoot: operator, macroPath: null }).join('\n'), /the operator's AGENTIC_STATE_BASE/);
      match(LN.lanesRequirements({ checkout: t.fx.work, stateRoot, macroPath: t.fx.macroPath }).join('\n'), /is not in a home of the default state root/,
        'the fixture\'s macro lives in the linked checkout\'s own home');
      // Serial: no lanes, every step in the driven checkout.
      deepStrictEqual(LN.stepPlacement({ kind: 'verb', subtaskId: 'A' }, { lanes: null, checkout: t.fx.work, stateRoot }), { cwd: t.fx.work, stateBase: t.home.mainRoot, lane: null });
    } finally {
      t.fx.cleanup();
    }
  });

  it('needs shared creation on, a driver outside the lanes, and every claiming workflow under the default state root', async () => {
    const t = await setup({ shared: false });
    try {
      const stateRoot = { root: t.home.mainRoot, source: 'default-state-root', shared_creation: 'off' };
      match(LN.lanesRequirements({ checkout: t.fx.work, stateRoot, macroPath: null }).join('\n'), /lanes need shared creation on \(it is off\)/);
      SR.enableSharedCreation({ checkout: t.home.mainRoot, versions: { orchestrator: 'test' } });
      const on = { ...stateRoot, shared_creation: 'on' };
      const inMain = join(t.home.mainRoot, '.agentic-plugins/state/engineer/workflows/compose-a.md');
      const inWork = join(t.fx.work, '.agentic-plugins/state/engineer/workflows/compose-b.md');
      // Under the main worktree, but in a nested worktree's own home: no lane reads it.
      const nested = join(t.home.mainRoot, '.claude/worktrees/x/.agentic-plugins/state/engineer/workflows/compose-c.md');
      const legacy = join(t.home.mainRoot, '.claude/agentic-engineer/workflows/compose-d.md');
      const view = { children: { A: { location: 'active', path: inMain } }, claims: [{ path: inMain }, { path: inWork }, { path: nested }, { path: legacy }] };
      const problems = LN.lanesRequirements({ checkout: t.fx.work, stateRoot: on, macroPath: null, view });
      strictEqual(problems.length, 2, problems.join('\n'));
      match(problems[0], /compose-b\.md claims the macro but is not in a home of the default state root/);
      match(problems[1], /compose-c\.md claims the macro but is not in a home of the default state root/);
      match(LN.lanesRequirements({ checkout: t.fx.work, stateRoot: on, macroPath: join(t.home.mainRoot, '.claude/worktrees/x/.agentic-plugins/state/orchestrator/workflows/m.md') }).join('\n'),
        /the macro .* is not in a home of the default state root/);
      const lane = t.rawLane('A', 'feat/a');
      match(LN.lanesRequirements({ checkout: lane, stateRoot: on, macroPath: null }).join('\n'), /is under the lanes directory/);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a run that holds the lane\'s worktree lock as well as the macro lock admits its worker in the lane; one that does not, refuses it', async () => {
    const t = await setup();
    const RL = await import(resolve(REPO_ROOT, 'plugins/orchestrator/scripts/lib/run-locks.mjs'));
    const held = [];
    try {
      const { lane } = t.create({ id: 'A', branch: 'feat/a', status: 'pending' });
      const token = 'f'.repeat(32);
      const record = { run_id: RUN, macro_id: t.fx.macroId, token_digest: RL.tokenDigest(token) };
      held.push(await RL.acquireLock(RL.macroLockPath(t.home.mainRoot, t.fx.macroId), { record }));
      const env = { ...t.fx.env, AGENTIC_AUTOPILOT: RUN, AGENTIC_AUTOPILOT_TOKEN: token };
      let refused = null;
      try { await RL.joinAdmission({ command: 'next', checkout: lane.path, macroId: t.fx.macroId, host: 'claude', env }); } catch (e) { refused = e; }
      ok(refused instanceof RL.LockHeldError, `without the lane's lock the run's own worker is refused: ${refused}`);
      held.push(await LN.holdLane(lane, { record }));
      const joined = await RL.joinAdmission({ command: 'next', checkout: lane.path, macroId: t.fx.macroId, host: 'claude', env });
      deepStrictEqual([joined.admissionId, joined.workerOf], ['', RUN]);
    } finally {
      for (const h of held) h.release();
      t.fx.cleanup();
    }
  });
});
