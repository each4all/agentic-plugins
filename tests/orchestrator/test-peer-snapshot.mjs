// C96 — the orchestrator's peers run in a snapshot of the checkout, never the
// live tree: plugins/orchestrator/scripts/peer-runner.mjs and dispatch-peer.mjs
// with their copies of lib/peer-snapshot.mjs and lib/process-identity.mjs
// (tests/scripts/test-orchestrator-peer-snapshot-parity.mjs holds the copies
// to the persona-pipeline sources, whose own suite,
// tests/persona-pipeline/test-peer-snapshot.mjs, covers the library itself).
//
// The cases are the persona dispatchers' guarantees, run against the
// orchestrator's copies, plus what the orchestrator keeps of its own: the
// companion is resolved before anything is recorded, so a missing companion
// leaves no ledger, no pending row and no snapshot, and reclaims none.

import { describe, it } from 'node:test';
import { ok, strictEqual, notStrictEqual, deepStrictEqual, rejects, match } from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// C142 O-F2 — this process's judgments read the suites' listing too.
import '../persona-pipeline/_peer-snapshot-listing.mjs';
import {
  alive,
  cleanEnv,
  git,
  groupAlive,
  killGroup,
  leftovers,
  liveView,
  makeDirtyRepo,
  makeUnmergedRepo,
  sleep,
  snapshotWorktrees,
  waitFor,
  withTmp,
  within,
  withoutStateHome,
  writeFakeCompanions,
  startHostedRun,
  hostTeardown,
  editJson,
  leaderlessGroup,
  sigtermsSeen,
} from '../persona-pipeline/_peer-snapshot-fixtures.mjs';

const require = createRequire(import.meta.url);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORCH = (rel) => join(REPO_ROOT, 'plugins/orchestrator', rel);
const PEER_RUNNER = ORCH('scripts/peer-runner.mjs');
const DISPATCH = ORCH('scripts/dispatch-peer.mjs');

const lib = await import(pathToFileURL(ORCH('scripts/lib/peer-snapshot.mjs')).href);
const identity = await import(pathToFileURL(ORCH('scripts/lib/process-identity.mjs')).href);
const runner = await import(pathToFileURL(PEER_RUNNER).href);
const dispatcher = await import(pathToFileURL(DISPATCH).href);
const state = await import(pathToFileURL(ORCH('scripts/state.mjs')).href);
const stateRoot = await import(pathToFileURL(ORCH('scripts/lib/state-root.mjs')).href);
const env = cleanEnv();
const persona = 'orchestrator';

async function fixture(dir) {
  const top = makeDirtyRepo(dir);
  const companions = await writeFakeCompanions(dir);
  return { top, companions, record: join(dir, 'record.json') };
}
const fakeEnv = (f, mode, extra = {}) => ({ ...env, AGENTIC_COMPANIONS_ROOT: f.companions, FAKE_COMPANION_MODE: mode, FAKE_RECORD: f.record, ...extra });

/** A companions root whose discovery resolves nothing: the companion is missing. */
function writeUnavailableCompanions(dir) {
  const root = join(dir, 'unavailable-companions');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'discover-peer.mjs'), `
export async function discoverPeerCompanion() {
  return { ok: false, reason: 'peer missing' };
}
`);
  return root;
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise((r) => child.once('exit', r));
  return child.pid;
}

/**
 * A snapshot whose supervisor is gone and whose companion never ran: one a reclaim removes.
 * It is made for a live process that then exits, so its owner record keeps the start time,
 * clock and ancestors a run's supervisor has, which place outside the run a process of the
 * machine's that hides its directory (C142 O-F2).
 */
async function abandonedSnapshot(top) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise((r) => child.once('spawn', r));
  try {
    return await lib.createPeerSnapshot({ cwd: top, persona, env, supervisorPid: child.pid });
  } finally {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;
  }
}

async function macroWorkflow(top) {
  const { filePath } = await stateRoot.runInCommandDirectory(top, () => state.createWorkflow({
    repoRoot: top, verb: 'plan', originalRequest: 'snapshot', host: 'claude', currentPhase: 'p', nextAction: 'n',
    gitBaseline: { branch: 'main', head: git(top, 'rev-parse', 'HEAD').trim(), status_digest: '' },
  }));
  return filePath;
}

const pendingOf = async (workflowPath) => (await state.readWorkflow(workflowPath)).frontmatter.pending_ensemble ?? [];

describe('orchestrator: peer-runner — a codex peer runs in the snapshot (C96)', () => {
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
      ok(dirname(result.snapshot.root).includes(`${persona}-peer-snapshot-`), result.snapshot.root);
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
      const hooks = { beforeHandleWrite: (h) => { if (h.status === 'running') chmodSync(ledger, 0o500); } };
      const running = runner.runPeer({ repoRoot: f.top, runId: 'eacces-1', peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'hang'), cancellation, cancelGraceMs: 500, hooks });
      running.catch(() => {});
      let pid = null;
      try {
        await waitFor(() => existsSync(f.record), { message: 'the companion to start' });
        pid = JSON.parse(readFileSync(f.record, 'utf8')).pid;
        await waitFor(() => (statSync(ledger).mode & 0o777) === 0o500, { message: 'the ledger to turn read-only' });
        cancellation.request('SIGTERM');
        await rejects(within(running, 'the run to end on the cancellation'), (e) => e.code === 'EACCES');
        ok(!alive(pid), 'the peer is stopped');
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
      const hooks = { beforeHandleWrite: (h, before) => { if (h.status === 'completed' && before === 'running') cancellation.request('SIGTERM'); } };
      const result = await runner.runPeer({ repoRoot: f.top, peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'vandal'), cancellation, hooks });
      strictEqual(cancellation.signal, 'SIGTERM');
      strictEqual(result.status, 'cancelled');
      strictEqual(result.error_kind, 'cancelled');
      strictEqual((await runner.readHandle(result.handle_path)).status, 'cancelled');
    });
  });

  // A cancel from another process whose record lands between the run's last
  // read of its handle and its terminal write: written from inside that read
  // (fs/promises' readFile, wrapped for this one run), since the read sits in
  // the four-copy spawn section, which has no seam.
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
      deepStrictEqual(sent, [], 'the ended peer\'s pid and group get no signal');
      strictEqual((await runner.readHandle(result.handle_path)).status, 'completed');
    });
  });

  it('a claude peer is not isolated: it gets the directory it was given', async () => {
    await withTmp(async (dir, snaps) => {
      const f = await fixture(dir);
      const result = await runner.runPeer({ repoRoot: f.top, peer: 'claude', promptText: 'x', cwd: join(f.top, 'sub'), env: fakeEnv(f, 'record') });
      strictEqual(result.status, 'completed');
      strictEqual(JSON.parse(readFileSync(f.record, 'utf8')).cwd, join(f.top, 'sub'));
      strictEqual(result.snapshot.isolation, 'none');
      strictEqual(result.snapshot.reason, 'peer-not-isolated');
      deepStrictEqual(leftovers(snaps), []);
    });
  });

  it('a snapshot that cannot be made fails the run before any companion runs (snapshot_failed), its pending row recorded', async () => {
    await withTmp(async (dir) => {
      const f = { top: makeUnmergedRepo(dir), companions: await writeFakeCompanions(dir), record: join(dir, 'record.json') };
      const workflowPath = await macroWorkflow(f.top);
      const result = await runner.runPeer({
        repoRoot: f.top, peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'vandal'),
        kind: 'ensemble', runId: 'snap-fail', workflowPath, phase: 'plan', ensembleType: 'plan-verify',
      });
      strictEqual(result.status, 'failed');
      strictEqual(result.error_kind, 'snapshot_failed');
      strictEqual(result.exit_code, null);
      strictEqual(result.snapshot.isolation, 'failed');
      strictEqual(result.snapshot.reason, 'unmerged-index');
      ok(!existsSync(f.record), 'no companion ran');
      strictEqual((await runner.readHandle(result.handle_path)).status, 'failed');
      // The ensemble commit of the plan runbook settles it.
      deepStrictEqual((await pendingOf(workflowPath)).map((p) => p.run_id), ['snap-fail']);
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
      running.catch(() => {});
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

  it('a sweep that refuses its ledger scan (two homes holding ledgers) still reclaims the abandoned snapshots first', async () => {
    await withTmp(async (dir, snaps) => {
      const f = await fixture(dir);
      const snap = await abandonedSnapshot(f.top);
      mkdirSync(join(f.top, '.agentic-plugins/state/orchestrator/peer-runs/canonical-run'), { recursive: true });
      mkdirSync(join(f.top, '.claude/agentic-orchestrator/peer-runs/legacy-run'), { recursive: true });
      await rejects(runner.sweepPeerRuns({ repoRoot: f.top }), /Ambiguous orchestrator peer-run storage/);
      ok(!existsSync(snap.root), 'the abandoned snapshot was reclaimed before the scan refused');
      strictEqual(snapshotWorktrees(f.top).length, 0);
      deepStrictEqual(leftovers(snaps), []);
    });
  });
});

// C142 — the host's end of a background task can kill the runner before its
// cleanup (tests/persona-pipeline/test-peer-snapshot.mjs has the measurement
// and the whole set of cases): the orchestrator's cancel finishes such a run
// as the personas' does. The orchestrator has no settle.
describe('orchestrator: peer-runner — a run its host killed before its cleanup (C142)', () => {
  const hosted = (t, f, snaps, runId, mode) => startHostedRun(t, {
    runnerPath: PEER_RUNNER, readHandle: runner.readHandle, handlePath: runner.peerRunPaths(f.top, runId).handle, top: f.top, runId,
    env: { ...fakeEnv(f, mode), TMPDIR: snaps }, ready: () => existsSync(f.record),
  });
  const removedClean = { removed: true, skipped: null, error: null };

  const cancelCli = (f, runId) => {
    const r = spawnSync(process.execPath, [PEER_RUNNER, 'cancel', '--run-id', runId, '--repo-root', f.top, '--cancel-grace-ms', '500'], { env, encoding: 'utf8' });
    return { status: r.status, answer: JSON.parse(r.stdout), stderr: r.stderr };
  };

  it('the host leaves the snapshot and a cancel_requested handle; cancel finishes the run cancelled and removes that snapshot (exit 0)', async (t) => {
    await withTmp(async (dir, snaps) => {
      const f = await fixture(dir);
      const run = await hosted(t, f, snaps, 'host-1', 'deaf');
      await hostTeardown(run, runner.readHandle);
      strictEqual((await runner.readHandle(run.handlePath)).status, 'cancel_requested');
      strictEqual(leftovers(snaps).length, 1, 'the host left the snapshot');
      const r = cancelCli(f, 'host-1');
      strictEqual(r.status, 0, r.stderr);
      deepStrictEqual([r.answer.ok, r.answer.status, r.answer.reason, r.answer.snapshot_cleanup], [true, 'cancelled', 'ended', removedClean]);
      ok((await runner.readHandle(run.handlePath)).snapshot.removed_at);
      deepStrictEqual(leftovers(snaps), []);
      strictEqual(snapshotWorktrees(f.top).length, 0);
    });
  });

  // C142 O-F2 — the orchestrator's runner judges the suites' listing
  // (cleanEnv preloads it), never the system's alone; without the preload it
  // never reads the variable that listing reads.
  it('cancel judges the listing the suite preloads into it, and without the preload never reads the variable that listing reads (C142 O-F2)', async (t) => {
    await withTmp(async (dir, snaps) => {
      const f = await fixture(dir);
      const run = await hosted(t, f, snaps, 'host-1l', 'deaf');
      await hostTeardown(run, runner.readHandle);
      const tree = JSON.parse(readFileSync(run.ownerPath, 'utf8')).tree;
      const handle = readFileSync(run.handlePath, 'utf8');
      const cancelWith = (given) => {
        const r = spawnSync(process.execPath, [PEER_RUNNER, 'cancel', '--run-id', 'host-1l', '--repo-root', f.top, '--cancel-grace-ms', '500'], { env: { ...given, PEER_SNAPSHOT_TEST_OCCUPANT: join(tree, 'sub') }, encoding: 'utf8' });
        return { answer: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr };
      };
      const kept = cancelWith(env);
      deepStrictEqual([kept.answer?.ok, kept.answer?.why], [false, 'tree-occupied'], kept.stderr);
      strictEqual(readFileSync(run.handlePath, 'utf8'), handle, 'nothing is written');
      strictEqual(leftovers(snaps).length, 1, 'the snapshot is kept');
      // The system's listing, the one production judges (C142 P-F2), keeps
      // the run for a real process running in the tree, which decides before
      // any process it could not read is weighed; nothing is written or
      // removed.
      const { NODE_OPTIONS: _preload, ...bare } = env;
      const occupant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { cwd: tree, stdio: 'ignore', detached: true });
      t.after(() => killGroup(occupant.pid));
      const occupied = cancelWith(bare);
      deepStrictEqual([occupied.answer?.ok, occupied.answer?.why], [false, 'tree-occupied'], `${JSON.stringify(occupied.answer)} ${occupied.stderr}`);
      strictEqual(readFileSync(run.handlePath, 'utf8'), handle, 'nothing is written');
      strictEqual(leftovers(snaps).length, 1, 'the snapshot is kept');
      const exited = new Promise((done) => occupant.once('exit', done));
      killGroup(occupant.pid);
      await exited;
      // With it gone, the system's listing names no process in the tree; it
      // may still keep the snapshot, so only the occupant is asserted unread.
      const unhooked = cancelWith(bare);
      ok(unhooked.answer, `the runner answers: ${unhooked.stderr}`);
      notStrictEqual(unhooked.answer?.why, 'tree-occupied', unhooked.stderr);
      ok(unhooked.answer?.snapshot_cleanup?.skipped !== 'tree-occupied', unhooked.stderr);
    });
  });

  it('while its supervisor lives or cannot be told, or its companion cannot be, cancel writes and removes nothing', async (t) => {
    await withTmp(async (dir, snaps) => {
      const f = await fixture(dir);
      const run = await hosted(t, f, snaps, 'host-1r', 'deaf');
      await hostTeardown(run, runner.readHandle);
      const handle = readFileSync(run.handlePath, 'utf8');
      const owner = readFileSync(run.ownerPath, 'utf8');
      // A process of no run's, leading a group of its own under the pid a record names.
      const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', detached: true });
      t.after(() => killGroup(other.pid));
      const me = { pid: process.pid, fingerprint: await identity.fingerprintForPid(process.pid) };
      // A group whose leader is gone and whose child runs on in the run's
      // tree, as a companion's would be after its leader exited.
      const leader = { pid: await leaderlessGroup(t, JSON.parse(owner).tree) };
      // A group whose leader is gone and whose child runs elsewhere: one
      // another process started under an id once the companion's, and left.
      const stray = await leaderlessGroup(t, dir);
      // A live supervisor read under another fingerprint (C141's locale, an
      // incomplete record): `differ`, which is no proof it is gone.
      const differ = { pid: process.pid, fingerprint: { ...me.fingerprint, lstart: 'Thu Jan  1 00:00:00 1970', starttime: '1' } };
      // The handle and the owner record naming one companion, as the runner
      // writes them: `leader`, or `stray`.
      const asLeader = (h) => { h.pid = leader.pid; h.pgid = leader.pid; h.peer_process = { pid: leader.pid, pgid: leader.pid }; h.process_fingerprint = { kind: 'none' }; };
      const asStray = (h) => { h.pid = stray; h.pgid = stray; h.peer_process = { pid: stray, pgid: stray }; h.process_fingerprint = { kind: 'none' }; };
      for (const [edit, reason, why, editHandle] of [
        // C142 — a group whose leader is gone, its supervisor gone too, and
        // nothing of it in the run's tree: its id proves nothing.
        [(o) => { o.companion = { pid: stray, pgid: stray, fingerprint: { kind: 'none' } }; }, 'supervisor_unknown', 'companion-untied', asStray],
        // A supervisor at work or that cannot be told, the record and the
        // handle keeping the same one, as the runner writes them.
        [(o, h) => { o.supervisor = h.snapshot.supervisor = me; }, 'supervisor_alive', 'supervisor-alive'],
        [(o, h) => { o.supervisor = h.snapshot.supervisor = { pid: process.pid, fingerprint: { kind: 'none' } }; }, 'supervisor_unknown', 'supervisor-unknown'],
        [(o, h) => { o.supervisor = h.snapshot.supervisor = differ; }, 'supervisor_unknown', 'supervisor-unknown'],
        [(o, h) => { o.supervisor = h.snapshot.supervisor = { pid: process.pid, fingerprint: { kind: me.fingerprint.kind } }; }, 'supervisor_unknown', 'supervisor-unknown'],
        // Its companion's group left running: not stopped as the run's, the
        // supervisor not proven gone.
        [(o, h) => { o.supervisor = h.snapshot.supervisor = differ; o.companion = { pid: leader.pid, pgid: leader.pid, fingerprint: { kind: 'none' } }; }, 'supervisor_unknown', 'companion-alive', asLeader],
        // C142 M-F2 — a record naming another supervisor than the handle
        // keeps (an exited one, the handle's at work), or a handle keeping
        // one the runner did not write.
        [(o) => { o.supervisor = { pid: o.supervisor.pid, fingerprint: { kind: 'none' } }; }, 'supervisor_unknown', 'owner-incomplete', (h) => { h.snapshot.supervisor = me; }],
        [() => {}, 'supervisor_unknown', 'handle-malformed', (h) => { h.snapshot.supervisor = null; }],
        // C142 M-F1 — the supervisor and the companion's group both gone,
        // and a process outside that group still runs in the tree (the
        // leaderless group above): the run is not over.
        [() => {}, 'supervisor_unknown', 'tree-occupied'],
        // A supervisor pid past the range a pid takes names no process.
        [(o) => { o.supervisor = { pid: 2 ** 32, fingerprint: { kind: 'none' } }; }, 'supervisor_unknown', 'owner-incomplete'],
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
        // C142 — a handle whose group field the runner did not write, beside
        // the run's own live group: never read as naming no group.
        [(o) => { o.companion = { pid: leader.pid, pgid: leader.pid, fingerprint: { kind: 'none' } }; }, 'supervisor_unknown', 'handle-malformed', (h) => { asLeader(h); h.pgid = String(leader.pid); }],
      ]) {
        const h = JSON.parse(handle);
        editHandle?.(h);
        const o = JSON.parse(owner);
        edit(o, h);
        const before = JSON.stringify(h);
        writeFileSync(run.handlePath, before);
        writeFileSync(run.ownerPath, JSON.stringify(o));
        const r = cancelCli(f, 'host-1r');
        strictEqual(r.status, 1, r.stderr);
        deepStrictEqual([r.answer.ok, r.answer.reason, r.answer.why], [false, reason, why], JSON.stringify(o.companion));
        strictEqual(readFileSync(run.handlePath, 'utf8'), before, 'the handle is as it was');
        strictEqual(leftovers(snaps).length, 1);
      }
      // A live group under a companion pid whose process cannot be told, the
      // supervisor gone: the orchestrator's copy of the judgment refuses it
      // (a handle naming that pid is refused before it, unverifiable).
      const gone = JSON.parse(owner).supervisor;
      strictEqual(await identity.identityState(gone), 'gone');
      deepStrictEqual((await lib.snapshotEnded({ ...JSON.parse(owner), companion: { pid: other.pid, pgid: other.pid, fingerprint: { kind: 'none' } } })).why, 'companion-unknown');
      // With no handle to check against (the rows above all disagree with
      // it too), a companion named without its group, or with a group it
      // does not lead, still proves nothing.
      const named = JSON.parse(owner).companion;
      for (const companion of [{ ...named, pgid: null }, { ...named, pgid: other.pid }]) {
        deepStrictEqual((await lib.snapshotEnded({ ...JSON.parse(owner), companion })).why, 'owner-incomplete', JSON.stringify(companion));
      }
      // A group whose leader is gone is the run's only while a process of it
      // runs in the run's tree: the orchestrator's copy ties it the same way.
      deepStrictEqual((await lib.snapshotEnded({ ...JSON.parse(owner), companion: { pid: stray, pgid: stray, fingerprint: { kind: 'none' } } })).why, 'companion-untied');
      strictEqual(await lib.groupTiedToTree(leader.pid, JSON.parse(owner).tree), 'tied');
      // A handle whose process fields the runner did not write proves nothing.
      for (const h of [{ pid: 1, pgid: 1 }, { pid: null, pgid: null, peer_process: { pid: String(other.pid), pgid: other.pid } }]) {
        deepStrictEqual((await lib.snapshotEnded({ ...JSON.parse(owner) }, { handle: h })).why, 'handle-malformed', JSON.stringify(h));
      }
      strictEqual(identity.isGroupAlive(1), false);
      ok(alive(other.pid), 'a group the record cannot prove the run\'s is never signalled');
      ok(groupAlive(leader.pid), 'a group left under a supervisor not proven gone is never signalled');
      ok(groupAlive(stray), 'a group whose leader is gone and that nothing ties to the run is never signalled');
    });
  });

  it('a runner killed inside its cleanup (terminal, its snapshot not removed): cancel removes the snapshot, the status as it was', async (t) => {
    await withTmp(async (dir, snaps) => {
      const f = await fixture(dir);
      const run = await hosted(t, f, snaps, 'host-2', 'deaf');
      await hostTeardown(run, runner.readHandle);
      editJson(run.handlePath, (h) => Object.assign(h, { status: 'cancelled', error_kind: 'cancelled', completed_at: new Date().toISOString(), pid: null, pgid: null, process_fingerprint: { kind: 'none' } }));
      const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-2' });
      deepStrictEqual([answer.ok, answer.status, answer.reason, answer.snapshot_cleanup], [true, 'cancelled', 'already_terminal', removedClean]);
      deepStrictEqual(leftovers(snaps), []);
      strictEqual(snapshotWorktrees(f.top).length, 0);
    });
  });

  it('cancel records the answer the runner wrote before it was killed, never cancelled', async (t) => {
    await withTmp(async (dir, snaps) => {
      const f = await fixture(dir);
      const run = await hosted(t, f, snaps, 'host-2e', 'deaf');
      await hostTeardown(run, runner.readHandle);
      // What the runner leaves when it dies between the envelope and its
      // terminal write.
      writeFileSync(runner.peerRunPaths(f.top, 'host-2e').envelope, JSON.stringify({ status: 'success', peer_host: 'codex', peer_model: null, stdout: 'peer answer', exit_code: 0 }));
      const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-2e', graceMs: 500 });
      deepStrictEqual([answer.ok, answer.status, answer.reason, answer.snapshot_cleanup], [true, 'completed', 'ended', removedClean]);
      strictEqual((await runner.readHandle(run.handlePath)).status, 'completed');
      deepStrictEqual(leftovers(snaps), []);
      strictEqual(snapshotWorktrees(f.top).length, 0);
    });
  });

  it('a dead supervisor is no proof its peer stopped: cancel stops what is left of the companion\'s group before it finishes the run', async (t) => {
    await withTmp(async (dir, snaps) => {
      const f = await fixture(dir);
      const run = await hosted(t, f, snaps, 'host-2d', 'deaf-family');
      const { grandchild } = JSON.parse(readFileSync(f.record, 'utf8'));
      t.after(() => killGroup(grandchild));
      // The runner killed outright, and the companion's leader alone: a
      // child of it that ignores SIGTERM runs on in its group.
      process.kill(-run.cli.pid, 'SIGKILL');
      process.kill(run.companion.pid, 'SIGKILL');
      await within(run.exited, 'the runner to die');
      await waitFor(() => !alive(run.companion.pid), { message: 'the companion leader to be gone' });
      ok(groupAlive(run.companion.pgid) && alive(grandchild), 'its group lives on');
      const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-2d', graceMs: 300 });
      ok(!alive(grandchild), 'the child left in the group is stopped');
      ok(!groupAlive(run.companion.pgid));
      deepStrictEqual([answer.ok, answer.status, answer.reason, answer.snapshot_cleanup], [true, 'cancelled', 'ended', removedClean]);
      deepStrictEqual(leftovers(snaps), []);
      strictEqual(snapshotWorktrees(f.top).length, 0);
    });
  });

  it('a runner killed inside its own end that leaves a process of its peer\'s group: cancel stops it before it answers, the status as it was', async (t) => {
    await withTmp(async (dir, snaps) => {
      const f = await fixture(dir);
      const run = await hosted(t, f, snaps, 'host-2g', 'deaf-family');
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
      const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-2g', graceMs: 300 });
      ok(!alive(grandchild), 'the child is stopped');
      deepStrictEqual([answer.ok, answer.status, answer.reason, answer.snapshot_cleanup], [true, 'failed', 'already_terminal', removedClean]);
      deepStrictEqual(leftovers(snaps), []);
      strictEqual(snapshotWorktrees(f.top).length, 0);
    });
  });

  it('a terminal run whose owner record names no companion is judged against the peer process its handle keeps: cancel removes nothing while a child of its group runs (C142 J-F1)', async (t) => {
    await withTmp(async (dir, snaps) => {
      const f = await fixture(dir);
      const run = await hosted(t, f, snaps, 'host-2j', 'deaf-family');
      const { grandchild } = JSON.parse(readFileSync(f.record, 'utf8'));
      t.after(() => killGroup(grandchild));
      process.kill(-run.cli.pid, 'SIGKILL');
      process.kill(run.companion.pid, 'SIGKILL');
      await within(run.exited, 'the runner to die');
      await waitFor(() => !alive(run.companion.pid), { message: 'the companion leader to be gone' });
      editJson(run.ownerPath, (o) => { o.companion = null; delete o.launched_at; });
      // An orphan write clears the handle's pid and pgid; the peer process it
      // recorded stays.
      const p = runner.peerRunPaths(f.top, 'host-2j');
      const orphaned = await runner.reconcileOne(p, await runner.readHandle(p.handle), { staleGraceMs: 1, now: new Date() });
      deepStrictEqual([orphaned.status, orphaned.pid, orphaned.pgid], ['orphaned', null, null]);
      const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-2j', graceMs: 300 });
      deepStrictEqual([answer.ok, answer.reason, answer.snapshot_cleanup], [true, 'already_terminal', { removed: false, skipped: 'owner-incomplete', error: null }]);
      ok(alive(grandchild), 'the child runs on');
      strictEqual(leftovers(snaps).length, 1, 'the snapshot is kept');
      deepStrictEqual(orphaned.peer_process, { pid: run.companion.pid, pgid: run.companion.pgid }, 'the handle keeps the peer process');
    });
  });

  it('a snapshot a reclaim removed on age alone is no proof its peer stopped: cancel stops what is left of the companion\'s group first, and signals none of it while the supervisor its handle keeps is at work or cannot be told', async (t) => {
    await withTmp(async (dir, snaps) => {
      const f = await fixture(dir);
      const run = await hosted(t, f, snaps, 'host-3', 'deaf-family');
      const { grandchild } = JSON.parse(readFileSync(f.record, 'utf8'));
      t.after(() => killGroup(grandchild));
      process.kill(-run.cli.pid, 'SIGKILL');
      process.kill(run.companion.pid, 'SIGKILL');
      await within(run.exited, 'the runner to die');
      await waitFor(() => !alive(run.companion.pid), { message: 'the companion leader to be gone' });
      editJson(run.ownerPath, (o) => { o.companion = null; });
      deepStrictEqual((await lib.reclaimPeerSnapshots({ cwd: f.top, env, ttlMs: 0 })).reclaimed.map((x) => x.why), ['identity-unknown-expired']);
      ok(alive(grandchild), 'the reclaim left the group running');
      // Fresh, the handle may still be its supervisor's to write: refused,
      // and nothing of the group signalled (C142, refine-verify of the
      // seventeenth review's X-F1).
      editJson(run.handlePath, (h) => { h.updated_at = new Date().toISOString(); });
      const fresh = readFileSync(run.handlePath, 'utf8');
      const waited = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-3', graceMs: 300 });
      deepStrictEqual([waited.ok, waited.reason, waited.why], [false, 'supervisor_unknown', 'owner-unreadable']);
      strictEqual(readFileSync(run.handlePath, 'utf8'), fresh, 'fresh: nothing is written');
      await sleep(250);
      deepStrictEqual(sigtermsSeen(f.record), [], 'fresh: nothing of the group is signalled');
      const stale = new Date(Date.now() - 2 * runner.DEFAULT_STALE_GRACE_MS).toISOString();
      // While the supervisor the handle keeps is at work, or cannot be told,
      // the group is never signalled, before or after the refusal: the child
      // ignores SIGTERM, so its log, not its survival, shows that (C142,
      // seventeenth review's X-F1).
      const kept = (await runner.readHandle(run.handlePath)).snapshot.supervisor;
      const live = { pid: process.pid, fingerprint: await identity.fingerprintForPid(process.pid) };
      const untold = { pid: process.pid, fingerprint: { kind: 'none' } };
      for (const [supervisor, reason, why] of [[live, 'supervisor_alive', 'snapshot-gone-supervisor-match'], [untold, 'supervisor_unknown', 'snapshot-gone-supervisor-unknown']]) {
        editJson(run.handlePath, (h) => { h.updated_at = stale; h.snapshot.supervisor = supervisor; });
        const before = readFileSync(run.handlePath, 'utf8');
        const refused = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-3', graceMs: 300 });
        deepStrictEqual([refused.ok, refused.reason, refused.why], [false, reason, why]);
        strictEqual(readFileSync(run.handlePath, 'utf8'), before, `${why}: nothing is written`);
        await sleep(250);
        deepStrictEqual(sigtermsSeen(f.record), [], `${why}: nothing of the group is signalled`);
        ok(alive(grandchild) && groupAlive(run.companion.pgid), `${why}: the group runs on`);
      }
      editJson(run.handlePath, (h) => { h.updated_at = stale; h.snapshot.supervisor = kept; });
      const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-3', graceMs: 300 });
      ok(!alive(grandchild) && !groupAlive(run.companion.pgid), 'the child left in the group is stopped');
      ok(sigtermsSeen(f.record).includes('child'), 'the log sees the SIGTERM the stop sends');
      deepStrictEqual([answer.ok, answer.status, answer.reason, answer.snapshot_cleanup], [true, 'cancelled', 'ended', { removed: true, skipped: null, error: null, already_gone: true }]);
    });
  });

  it('a terminal run whose snapshot a reclaim removed on age alone: cancel stops what is left of the group its handle names', async (t) => {
    await withTmp(async (dir, snaps) => {
      const f = await fixture(dir);
      const run = await hosted(t, f, snaps, 'host-3t', 'deaf-family');
      const { grandchild } = JSON.parse(readFileSync(f.record, 'utf8'));
      t.after(() => killGroup(grandchild));
      process.kill(-run.cli.pid, 'SIGKILL');
      process.kill(run.companion.pid, 'SIGKILL');
      await within(run.exited, 'the runner to die');
      await waitFor(() => !alive(run.companion.pid), { message: 'the companion leader to be gone' });
      editJson(run.ownerPath, (o) => { o.companion = null; });
      deepStrictEqual((await lib.reclaimPeerSnapshots({ cwd: f.top, env, ttlMs: 0 })).reclaimed.map((x) => x.why), ['identity-unknown-expired']);
      const p = runner.peerRunPaths(f.top, 'host-3t');
      writeFileSync(p.envelope, JSON.stringify({ status: 'success', peer_host: 'codex', peer_model: null, stdout: 'peer answer', exit_code: 0 }));
      const reconciled = await runner.reconcileOne(p, await runner.readHandle(p.handle), { staleGraceMs: 1, now: new Date() });
      strictEqual(reconciled.status, 'completed');
      ok(alive(grandchild), 'the group runs on');
      // While the supervisor its handle keeps cannot be told, that group is
      // never signalled, before or after the refusal (C142, refine-verify of
      // the sixteenth review's W-F1).
      const kept = reconciled.snapshot.supervisor;
      editJson(p.handle, (h) => { h.snapshot.supervisor = { pid: process.pid, fingerprint: { kind: 'none' } }; });
      let answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-3t', graceMs: 300 });
      deepStrictEqual([answer.ok, answer.reason, answer.snapshot_cleanup], [true, 'already_terminal', { removed: false, skipped: 'supervisor-unknown', error: null }]);
      ok(alive(grandchild) && groupAlive(run.companion.pgid), 'nothing of the group is signalled while its supervisor cannot be told');
      // The child ignores SIGTERM: its log, not its survival, shows none came
      // (C142, seventeenth review's X-F1).
      await sleep(250);
      deepStrictEqual(sigtermsSeen(f.record), [], 'no SIGTERM reaches the group while its supervisor cannot be told');
      editJson(p.handle, (h) => { h.snapshot.supervisor = kept; });
      answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-3t', graceMs: 300 });
      ok(!alive(grandchild) && !groupAlive(run.companion.pgid), 'the child left in the group is stopped');
      ok(sigtermsSeen(f.record).includes('child'), 'the log sees the SIGTERM the stop sends');
      deepStrictEqual([answer.ok, answer.status, answer.reason, answer.snapshot_cleanup], [true, 'completed', 'already_terminal', { removed: true, skipped: null, error: null, already_gone: true }]);
    });
  });

  it('a terminal run whose owner record still exists but cannot be read: cancel signals nothing of the group its handle names, and keeps the snapshot', async (t) => {
    await withTmp(async (dir, snaps) => {
      const f = await fixture(dir);
      const run = await hosted(t, f, snaps, 'host-3u', 'deaf-family');
      const { grandchild } = JSON.parse(readFileSync(f.record, 'utf8'));
      t.after(() => killGroup(grandchild));
      process.kill(-run.cli.pid, 'SIGKILL');
      process.kill(run.companion.pid, 'SIGKILL');
      await within(run.exited, 'the runner to die');
      await waitFor(() => !alive(run.companion.pid), { message: 'the companion leader to be gone' });
      // The record is there, unreadable: it may name a supervisor still at
      // work, so it proves nothing, and the snapshot is not gone.
      writeFileSync(run.ownerPath, '{');
      const p = runner.peerRunPaths(f.top, 'host-3u');
      writeFileSync(p.envelope, JSON.stringify({ status: 'success', peer_host: 'codex', peer_model: null, stdout: 'peer answer', exit_code: 0 }));
      strictEqual((await runner.reconcileOne(p, await runner.readHandle(p.handle), { staleGraceMs: 1, now: new Date() })).pgid, run.companion.pgid);
      const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-3u', graceMs: 300 });
      ok(alive(grandchild), 'a group under an owner record that cannot be read is never signalled');
      // The child ignores SIGTERM: its log shows none came (C142 X-F1).
      await sleep(250);
      deepStrictEqual(sigtermsSeen(f.record), [], 'no SIGTERM reaches the group under an owner record that cannot be read');
      deepStrictEqual([answer.ok, answer.status, answer.reason, answer.snapshot_cleanup?.removed, answer.snapshot_cleanup?.skipped], [true, 'completed', 'already_terminal', false, 'owner-unreadable']);
      strictEqual(leftovers(snaps).length, 1);
    });
  });

  it('a group its handle names is signalled only while the handle\'s own process, its leader, is gone or still the one recorded: another process\'s group under that id is never stopped, live run or terminal', async (t) => {
    await withTmp(async (dir, snaps) => {
      const f = await fixture(dir);
      const run = await hosted(t, f, snaps, 'host-3v', 'deaf');
      await hostTeardown(run, runner.readHandle);
      deepStrictEqual((await lib.reclaimPeerSnapshots({ cwd: f.top, env })).reclaimed.map((x) => x.why), ['owners-gone']);
      // A process of no run's, leading a group under an id the handle keeps.
      const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', detached: true });
      t.after(() => killGroup(other.pid));
      // A group whose leader is gone, nothing of it in the run's tree.
      const stray = await leaderlessGroup(t, dir);
      const recorded = (await runner.readHandle(run.handlePath)).process_fingerprint;
      const stale = new Date(Date.now() - 2 * runner.DEFAULT_STALE_GRACE_MS).toISOString();
      const terminal = { status: 'completed', error_kind: null, completed_at: stale, updated_at: stale };
      const kept = (pid) => ({ peer_process: { pid, pgid: pid } });
      for (const [fields, why] of [
        [{ updated_at: stale, pid: run.companion.pid, pgid: other.pid, process_fingerprint: recorded }, 'snapshot-gone-handle-malformed'],
        [{ updated_at: stale, pid: stray, pgid: stray, ...kept(stray), process_fingerprint: { kind: 'none' } }, 'snapshot-gone-group-untied'],
        [{ ...terminal, pid: other.pid, pgid: other.pid, ...kept(other.pid), process_fingerprint: recorded }, 'owner-unreadable-group-leader-differ'],
        [{ ...terminal, pid: other.pid, pgid: other.pid, ...kept(other.pid), process_fingerprint: { kind: 'none' } }, 'owner-unreadable-group-leader-unknown'],
        // Its pid and pgid cleared: the peer process it keeps names the group.
        [{ ...terminal, pid: null, pgid: null, ...kept(other.pid), process_fingerprint: { kind: 'none' } }, 'owner-unreadable-group-leader-unknown'],
        [{ ...terminal, pid: null, pgid: null, ...kept(stray), process_fingerprint: { kind: 'none' } }, 'owner-unreadable-group-untied'],
        [{ ...terminal, pid: null, pgid: null, peer_process: { pid: String(other.pid), pgid: other.pid }, process_fingerprint: { kind: 'none' } }, 'owner-unreadable-handle-malformed'],
      ]) {
        editJson(run.handlePath, (h) => Object.assign(h, fields));
        const before = readFileSync(run.handlePath, 'utf8');
        const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-3v', graceMs: 300 });
        deepStrictEqual([answer.ok, answer.reason, answer.why], [false, 'supervisor_unknown', why]);
        ok(alive(other.pid), `${why}: the other process is never signalled`);
        ok(groupAlive(stray), `${why}: the stray group is never signalled`);
        strictEqual(readFileSync(run.handlePath, 'utf8'), before, `${why}: nothing is written`);
      }
      killGroup(other.pid);
      await waitFor(() => !groupAlive(other.pid), { message: 'the other group to end' });
      editJson(run.handlePath, (h) => Object.assign(h, { ...terminal, pid: null, pgid: null, ...kept(other.pid), process_fingerprint: { kind: 'none' } }));
      let answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-3v', graceMs: 300 });
      deepStrictEqual([answer.ok, answer.status, answer.reason, answer.snapshot_cleanup], [true, 'completed', 'already_terminal', { removed: true, skipped: null, error: null, already_gone: true }]);
      answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-3v', graceMs: 300 });
      deepStrictEqual([answer.ok, answer.reason, answer.snapshot_cleanup], [true, 'already_terminal', undefined]);
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
      const run = await hosted(t, f, snaps, 'host-3m', 'deaf');
      const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', detached: true });
      t.after(() => killGroup(other.pid));
      editJson(run.handlePath, (h) => { h.pgid = other.pid; });
      const before = readFileSync(run.handlePath, 'utf8');
      const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-3m', graceMs: 300 });
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

  it('a terminal run whose handle\'s pid and pgid a later write cleared: cancel stops what is left of the group its kept peer process names', async (t) => {
    await withTmp(async (dir, snaps) => {
      const f = await fixture(dir);
      const run = await hosted(t, f, snaps, 'host-3k', 'deaf-family');
      const { grandchild } = JSON.parse(readFileSync(f.record, 'utf8'));
      t.after(() => killGroup(grandchild));
      process.kill(-run.cli.pid, 'SIGKILL');
      process.kill(run.companion.pid, 'SIGKILL');
      await within(run.exited, 'the runner to die');
      await waitFor(() => !alive(run.companion.pid), { message: 'the companion leader to be gone' });
      editJson(run.ownerPath, (o) => { o.companion = null; });
      deepStrictEqual((await lib.reclaimPeerSnapshots({ cwd: f.top, env, ttlMs: 0 })).reclaimed.map((x) => x.why), ['identity-unknown-expired']);
      editJson(run.handlePath, (h) => Object.assign(h, { status: 'failed', error_kind: 'orphaned', completed_at: new Date().toISOString(), pid: null, pgid: null, process_fingerprint: { kind: 'none' } }));
      ok(alive(grandchild), 'the group runs on in the removed tree');
      const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-3k', graceMs: 300 });
      ok(!alive(grandchild) && !groupAlive(run.companion.pgid), 'the child left in the group is stopped');
      deepStrictEqual([answer.ok, answer.status, answer.reason, answer.snapshot_cleanup], [true, 'failed', 'already_terminal', { removed: true, skipped: null, error: null, already_gone: true }]);
    });
  });

  it('a snapshot a reclaim removed leaves no owner record: cancel refuses while the handle is fresh, and finishes the run once it is stale', async (t) => {
    await withTmp(async (dir, snaps) => {
      const f = await fixture(dir);
      const run = await hosted(t, f, snaps, 'host-1g', 'deaf');
      await hostTeardown(run, runner.readHandle);
      deepStrictEqual((await lib.reclaimPeerSnapshots({ cwd: f.top, env })).reclaimed.map((x) => x.why), ['owners-gone']);
      deepStrictEqual(leftovers(snaps), []);
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
      const run = await hosted(t, f, snaps, 'host-3s', 'deaf');
      await hostTeardown(run, runner.readHandle);
      const kept = (await runner.readHandle(run.handlePath)).snapshot.supervisor;
      deepStrictEqual(kept, JSON.parse(readFileSync(run.ownerPath, 'utf8')).supervisor);
      deepStrictEqual((await lib.reclaimPeerSnapshots({ cwd: f.top, env })).reclaimed.map((x) => x.why), ['owners-gone']);
      const stale = new Date(Date.now() - 2 * runner.DEFAULT_STALE_GRACE_MS).toISOString();
      const live = { pid: process.pid, fingerprint: await identity.fingerprintForPid(process.pid) };
      const untold = { pid: process.pid, fingerprint: { kind: 'none' } };
      // A live run, stale: a supervisor at work, or one that cannot be told,
      // still owns its end.
      for (const [supervisor, reason, why] of [[live, 'supervisor_alive', 'snapshot-gone-supervisor-match'], [untold, 'supervisor_unknown', 'snapshot-gone-supervisor-unknown'], [{ pid: 1 }, 'supervisor_unknown', 'snapshot-gone-supervisor-malformed']]) {
        editJson(run.handlePath, (h) => { h.updated_at = stale; h.snapshot.supervisor = supervisor; });
        const before = readFileSync(run.handlePath, 'utf8');
        const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-3s', graceMs: 300 });
        deepStrictEqual([answer.ok, answer.reason, answer.why], [false, reason, why]);
        strictEqual(readFileSync(run.handlePath, 'utf8'), before, `${why}: nothing is written`);
      }
      // A terminal run: nothing signalled, the removal not recorded.
      editJson(run.handlePath, (h) => Object.assign(h, { status: 'completed', error_kind: null, completed_at: stale, pid: null, pgid: null, process_fingerprint: { kind: 'none' } }, { snapshot: { ...h.snapshot, supervisor: untold } }));
      let answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-3s', graceMs: 300 });
      deepStrictEqual([answer.ok, answer.reason, answer.snapshot_cleanup], [true, 'already_terminal', { removed: false, skipped: 'supervisor-unknown', error: null }]);
      strictEqual((await runner.readHandle(run.handlePath)).snapshot.removed_at, null);
      // Its supervisor gone, the removal is recorded.
      editJson(run.handlePath, (h) => { h.snapshot.supervisor = kept; });
      answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-3s', graceMs: 300 });
      deepStrictEqual([answer.ok, answer.reason, answer.snapshot_cleanup], [true, 'already_terminal', { removed: true, skipped: null, error: null, already_gone: true }]);
    });
  });

  it('a process the companion left in a group of its own runs on in the tree: the reclaim keeps the snapshot until it is old, and cancel, live or terminal, finishes nothing while it runs in the removed tree (C142 M-F1)', async (t) => {
    await withTmp(async (dir, snaps) => {
      const f = await fixture(dir);
      const run = await hosted(t, f, snaps, 'host-3o', 'deaf');
      await hostTeardown(run, runner.readHandle);
      const tree = JSON.parse(readFileSync(run.ownerPath, 'utf8')).tree;
      const own = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { cwd: tree, stdio: 'ignore', detached: true });
      t.after(() => killGroup(own.pid));
      await waitFor(async () => (await lib.treeOccupancy(tree, { supervisor: { fingerprint: { clock: await identity.clockDomain() } } })) === 'occupied', { message: 'the process to run in the tree' });
      deepStrictEqual((await lib.reclaimPeerSnapshots({ cwd: f.top, env })).kept.map((x) => x.why), ['tree-occupied']);
      deepStrictEqual((await lib.reclaimPeerSnapshots({ cwd: f.top, env, ttlMs: 0 })).reclaimed.map((x) => x.why), ['tree-occupied-expired']);
      deepStrictEqual(leftovers(snaps), []);
      const stale = new Date(Date.now() - 2 * runner.DEFAULT_STALE_GRACE_MS).toISOString();
      editJson(run.handlePath, (h) => { h.updated_at = stale; });
      const before = readFileSync(run.handlePath, 'utf8');
      let answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-3o', graceMs: 300 });
      deepStrictEqual([answer.ok, answer.reason, answer.why], [false, 'supervisor_unknown', 'snapshot-gone-tree-occupied']);
      strictEqual(readFileSync(run.handlePath, 'utf8'), before);
      editJson(run.handlePath, (h) => Object.assign(h, { status: 'completed', error_kind: null, completed_at: stale, pid: null, pgid: null, process_fingerprint: { kind: 'none' } }));
      answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-3o', graceMs: 300 });
      deepStrictEqual([answer.ok, answer.reason, answer.snapshot_cleanup], [true, 'already_terminal', { removed: false, skipped: 'tree-occupied', error: null }]);
      ok(alive(own.pid), 'nothing outside the group its handle names is signalled');
      killGroup(own.pid);
      await waitFor(() => !alive(own.pid), { message: 'the process to end' });
      answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-3o', graceMs: 300 });
      deepStrictEqual([answer.ok, answer.reason, answer.snapshot_cleanup], [true, 'already_terminal', { removed: true, skipped: null, error: null, already_gone: true }]);
    });
  });

  it('a terminal run whose owner record and handle agree on a live group that cannot be told, or on a group whose leader is gone and nothing of which runs in its tree: cancel signals neither and keeps the snapshot', async (t) => {
    await withTmp(async (dir, snaps) => {
      const f = await fixture(dir);
      const run = await hosted(t, f, snaps, 'host-3w', 'deaf');
      await hostTeardown(run, runner.readHandle);
      const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', detached: true });
      t.after(() => killGroup(other.pid));
      const stray = await leaderlessGroup(t, dir);
      const terminal = { status: 'completed', error_kind: null, completed_at: new Date().toISOString(), pid: null, pgid: null, process_fingerprint: { kind: 'none' } };
      for (const [pid, why] of [[other.pid, 'companion-unknown'], [stray, 'companion-untied']]) {
        editJson(run.handlePath, (h) => Object.assign(h, terminal, { peer_process: { pid, pgid: pid } }));
        editJson(run.ownerPath, (o) => { o.companion = { pid, pgid: pid, fingerprint: { kind: 'none' } }; });
        const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-3w', graceMs: 300 });
        deepStrictEqual([answer.ok, answer.status, answer.reason, answer.snapshot_cleanup], [true, 'completed', 'already_terminal', { removed: false, skipped: why, error: null }], why);
        ok(alive(other.pid) && groupAlive(stray), `${why}: nothing is signalled`);
        strictEqual(leftovers(snaps).length, 1, `${why}: the snapshot is kept`);
      }
    });
  });

  it('an owner record naming another worktree than the tree its handle recorded removes nothing', async (t) => {
    await withTmp(async (dir, snaps) => {
      const f = await fixture(dir);
      const other = join(dir, 'other');
      git(f.top, 'worktree', 'add', '-q', '-b', 'other', other);
      writeFileSync(join(other, 'work.txt'), 'uncommitted\n');
      const run = await hosted(t, f, snaps, 'host-4', 'deaf');
      await hostTeardown(run, runner.readHandle);
      const owner = readFileSync(run.ownerPath, 'utf8');
      for (const [skipped, edit] of [
        ['tree-not-the-snapshot', (o) => { o.tree = other; }],
        ['branch-not-the-snapshot', (o) => { o.branch = 'other'; }],
      ]) {
        editJson(run.ownerPath, edit);
        const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-4', graceMs: 300 });
        deepStrictEqual([answer.ok, answer.status, answer.snapshot_cleanup], [true, 'cancelled', { removed: false, skipped, error: null }], skipped);
        writeFileSync(run.ownerPath, owner);
        strictEqual(readFileSync(join(other, 'work.txt'), 'utf8'), 'uncommitted\n', `${skipped}: the other worktree keeps its work`);
        ok(git(f.top, 'rev-parse', '--verify', 'refs/heads/other').trim(), `${skipped}: its branch stays`);
        strictEqual(leftovers(snaps).length, 1);
      }
      const answer = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'host-4', graceMs: 300 });
      deepStrictEqual(answer.snapshot_cleanup, removedClean);
      deepStrictEqual(leftovers(snaps), []);
    });
  });

  // The orchestrator's runner is kept by hand, and its stopHandleGroup reads
  // the handle's group in the namespace the handle's supervisor's clock names:
  // the persona suite's namespace case, through the same probe
  // (_peer-snapshot-ns-probe.mjs), run against the orchestrator's runner and
  // library (C142 U-F1; the fifteenth review's V-F1).
  it('on Linux, cancel signals no group listed in another pid namespace than the run\'s supervisor\'s clock names, or through a /proc that is not the reader\'s (C142 U-F1)', async (t) => {
    await withTmp(async (dir) => {
      const repo = join(dir, 'repo');
      const parent = join(dir, `${persona}-peer-snapshot-ns`);
      const tree = join(parent, 'tree');
      mkdirSync(repo);
      mkdirSync(join(tree, 'sub'), { recursive: true });
      git(repo, 'init', '-q');
      const pgid = await leaderlessGroup(t, repo);
      const supervisor = { pid: await deadPid(), fingerprint: { kind: 'linux_proc_starttime', starttime: '1000', clock: 'boot-a/time:[1]/pid:[1]', ancestors: [] } };
      const owner = { schema: 'peer-snapshot-owner-1', run_id: 'ns-run', live_toplevel: repo, tree, branch: null, supervisor, companion: { pid: pgid, pgid, fingerprint: { kind: 'none' } }, created_at: new Date().toISOString() };
      const ownerPath = join(parent, 'owner.json');
      writeFileSync(ownerPath, JSON.stringify(owner));
      const paths = runner.peerRunPaths(repo, owner.run_id);
      const at = new Date(Date.now() - 5 * 60_000).toISOString();
      mkdirSync(paths.dir, { recursive: true });
      writeFileSync(paths.handle, JSON.stringify({
        schema_version: '1.0', run_id: owner.run_id, plugin: persona, kind: 'manual', workflow_path: null, phase: null, ensemble_type: null, host: 'claude', peer_host: 'codex', model: null, effort: null, cwd: repo, output_format: 'json',
        status: 'cancel_requested', pid: pgid, pgid, process_fingerprint: { kind: 'none' }, peer_process: { pid: pgid, pgid }, started_at: at, updated_at: at, completed_at: null, last_output_at: null,
        stdout_bytes: 0, stderr_bytes: 0, exit_code: null, error_kind: null, prompt_retained: false,
        snapshot: { isolation: 'snapshot', root: tree, owner_path: ownerPath, supervisor, removed_at: null },
      }));
      const cancel = (ns) => {
        const given = { runner: PEER_RUNNER, lib: ORCH('scripts/lib/peer-snapshot.mjs'), action: 'cancel', pgid, cwd: join(tree, 'sub'), pidNamespace: 'pid:[1]', repo, runId: owner.run_id, ...ns };
        const r = spawnSync(process.execPath, [join(REPO_ROOT, 'tests/persona-pipeline/_peer-snapshot-ns-probe.mjs'), JSON.stringify(given)], { env, encoding: 'utf8' });
        strictEqual(r.status, 0, r.stderr);
        return JSON.parse(r.stdout);
      };
      const refuses = (why) => {
        for (const ns of [{ pidNamespace: 'pid:[2]' }, { self: '999999999' }]) {
          const { result, sent } = cancel(ns);
          deepStrictEqual(sent, [], `${JSON.stringify(ns)}: another namespace's group gets no signal`);
          deepStrictEqual([result.reason, result.why], ['supervisor_unknown', why], JSON.stringify(result));
          ok(groupAlive(pgid), 'the group runs on');
        }
      };
      // Its owner record there: the orchestrator's copy of the judgment
      // refuses it.
      refuses('companion-untied');
      // Its snapshot gone with its owner record (a reclaim removed it): the
      // orchestrator's stopHandleGroup ties the group only in the namespace
      // the handle's supervisor's clock names.
      rmSync(parent, { recursive: true, force: true });
      refuses('snapshot-gone-group-unknown');
      // Control: in the run's namespace the group is tied, and stopped.
      strictEqual(cancel({}).sent[0], 'SIGTERM', 'the run\'s own group is stopped');
    });
  });

  // Its leader alive: the orchestrator's verifiedProcessForHandle and
  // stopHandleGroup read the handle's process in the pid namespace the handle's
  // supervisor's clock names, as the persona runner does (C142, eighteenth
  // review's Y-F1).
  it('on Linux, a live companion read by a reader in another pid namespace than the run\'s supervisor\'s clock names, or through a /proc that is not the reader\'s, gets no signal (C142 Y-F1)', async (t) => {
    await withTmp(async (dir) => {
      const repo = join(dir, 'repo');
      const parent = join(dir, `${persona}-peer-snapshot-ns`);
      const tree = join(parent, 'tree');
      mkdirSync(repo);
      mkdirSync(join(tree, 'sub'), { recursive: true });
      git(repo, 'init', '-q');
      const leader = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { detached: true, cwd: repo, stdio: 'ignore' });
      t.after(() => killGroup(leader.pid));
      await new Promise((r) => leader.once('spawn', r));
      const pgid = leader.pid;
      const fingerprint = { kind: 'linux_proc_starttime', starttime: '1200' };
      const supervisor = { pid: await deadPid(), fingerprint: { kind: 'linux_proc_starttime', starttime: '1000', clock: 'boot-a/time:[1]/pid:[1]', ancestors: [] } };
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
      const cancel = (ns) => {
        const given = { runner: PEER_RUNNER, lib: ORCH('scripts/lib/peer-snapshot.mjs'), action: 'cancel', pgid, entry: pgid, cwd: join(tree, 'sub'), pidNamespace: 'pid:[1]', repo, runId: owner.run_id, ...ns };
        const r = spawnSync(process.execPath, [join(REPO_ROOT, 'tests/persona-pipeline/_peer-snapshot-ns-probe.mjs'), JSON.stringify(given)], { env, encoding: 'utf8' });
        strictEqual(r.status, 0, r.stderr);
        return JSON.parse(r.stdout);
      };
      for (const foreign of [{ pidNamespace: 'pid:[2]' }, { self: '999999999' }]) {
        // A cancel of the run while it runs (verifiedProcessForHandle), and
        // once its handle is terminal and its snapshot gone (stopHandleGroup's
        // leader).
        for (const status of ['running', 'completed']) {
          handleWith(status);
          deepStrictEqual(cancel(foreign).sent, [], `${JSON.stringify(foreign)} ${status}: another namespace's process gets no signal`);
          ok(alive(pgid), 'the reader\'s process of that pid runs on');
        }
      }
      // Its snapshot gone with its owner record (a reclaim removed it): the
      // terminal run's group is stopped only on its leader read in the run's
      // namespace (stopHandleGroup).
      rmSync(parent, { recursive: true, force: true });
      handleWith('completed');
      for (const foreign of [{ pidNamespace: 'pid:[2]' }, { self: '999999999' }]) {
        deepStrictEqual(cancel(foreign).sent, [], `${JSON.stringify(foreign)} snapshot gone: another namespace's process gets no signal`);
        ok(alive(pgid), 'the reader\'s process of that pid runs on');
      }
      // Control: in the run's namespace, the terminal run's group is stopped.
      strictEqual(cancel({}).sent[0], 'SIGTERM', 'the run\'s own group is stopped');
    });
  });
});

describe('orchestrator: peer-runner — a queued ledger is judged by staleness (C96)', () => {
  // A run is `queued` while its snapshot is captured: a runner killed then
  // leaves a ledger that only this rule ends.
  async function queuedLedger(f, runId, at) {
    const result = await runner.runPeer({ repoRoot: f.top, runId, peer: 'claude', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'record') });
    const paths = runner.peerRunPaths(f.top, runId);
    rmSync(paths.envelope, { force: true });
    const h = await runner.readHandle(result.handle_path);
    const queued = { ...h, status: 'queued', pid: null, pgid: null, process_fingerprint: { kind: 'none' }, completed_at: null, exit_code: null, error_kind: null, started_at: at, updated_at: at };
    writeFileSync(paths.handle, `${JSON.stringify(queued, null, 2)}\n`);
    return paths;
  }

  it('a queued ledger older than the stale grace is orphaned; a fresh one (a capture still running) is kept', async () => {
    await withTmp(async (dir) => {
      const f = await fixture(dir);
      const stale = await queuedLedger(f, 'queued-stale', new Date(Date.now() - 10 * 60_000).toISOString());
      const fresh = await queuedLedger(f, 'queued-fresh', new Date().toISOString());
      await runner.sweepPeerRuns({ repoRoot: f.top });
      const s = await runner.readHandle(stale.handle);
      strictEqual(s.status, 'orphaned');
      strictEqual(s.error_kind, 'orphaned');
      strictEqual((await runner.readHandle(fresh.handle)).status, 'queued');
    });
  });
});

describe('orchestrator: the companion is resolved before anything is recorded (C96 keeps it)', () => {
  it('peer-runner: a missing companion leaves no ledger, no pending row and no snapshot, and reclaims none', async () => {
    await withTmp(async (dir, snaps) => {
      const top = makeDirtyRepo(dir);
      const workflowPath = await macroWorkflow(top);
      const seeded = await abandonedSnapshot(top);
      const result = await runner.runPeer({
        repoRoot: top, peer: 'codex', promptText: `look at ${top}/a`, cwd: top,
        env: { ...env, AGENTIC_COMPANIONS_ROOT: writeUnavailableCompanions(dir) },
        kind: 'ensemble', runId: 'no-companion', workflowPath, phase: 'plan', ensembleType: 'plan-verify',
      });
      strictEqual(result.ok, false);
      strictEqual(result.kind, 'peer_cli_not_found');
      for (const key of ['handle_path', 'stdout_path', 'stderr_path', 'envelope_path', 'prompt_path', 'companion_path', 'snapshot']) {
        strictEqual(result[key], null, `${key} is null`);
      }
      ok(!existsSync(runner.peerRunPaths(top, 'no-companion').dir), 'no ledger');
      deepStrictEqual(await pendingOf(workflowPath), [], 'no pending row');
      deepStrictEqual(snapshotWorktrees(top).map((w) => w.worktree), [seeded.root], 'no snapshot made, the abandoned one not reclaimed');
      // Control: a run whose companion resolves reclaims that same snapshot,
      // so the one kept above was kept by the order, not by its owner record.
      const f = { top, companions: await writeFakeCompanions(dir), record: join(dir, 'record.json') };
      strictEqual((await runner.runPeer({ repoRoot: top, peer: 'codex', promptText: 'x', cwd: top, env: fakeEnv(f, 'vandal') })).status, 'completed');
      strictEqual(snapshotWorktrees(top).length, 0);
      deepStrictEqual(leftovers(snaps), []);
    });
  });

  it('dispatch-peer: a missing companion is LOCAL-ONLY, with no pending row, no snapshot and no reclaim', async () => {
    await withTmp(async (dir, snaps) => {
      const top = makeDirtyRepo(dir);
      const workflowPath = await macroWorkflow(top);
      const seeded = await abandonedSnapshot(top);
      const result = await dispatcher.dispatchPeer({
        peer: 'codex', promptText: 'x', cwd: top,
        env: { ...env, AGENTIC_COMPANIONS_ROOT: writeUnavailableCompanions(dir) },
        ensembleBookkeeping: { workflowPath, phase: 'plan', ensembleType: 'plan-verify', runId: 'no-companion' },
      });
      strictEqual(result.ok, false);
      strictEqual(result.kind, 'peer_cli_not_found');
      strictEqual(result.exitCode, 3);
      match(result.stderr, /caller may proceed with a LOCAL-ONLY result/);
      deepStrictEqual(await pendingOf(workflowPath), []);
      deepStrictEqual(snapshotWorktrees(top).map((w) => w.worktree), [seeded.root]);
      const f = { top, companions: await writeFakeCompanions(dir), record: join(dir, 'record.json') };
      strictEqual((await dispatcher.dispatchPeer({ peer: 'codex', promptText: 'x', cwd: top, env: fakeEnv(f, 'vandal') })).ok, true);
      strictEqual(snapshotWorktrees(top).length, 0, 'control: a resolved companion reclaims it');
      deepStrictEqual(leftovers(snaps), []);
    });
  });
});

describe('orchestrator: the ADR-0067 write guard beside a snapshot (C96)', () => {
  it('a macro stays writable while a snapshot exists in a repository that does not ignore the state home', async () => {
    await withTmp(async (dir) => {
      const top = makeDirtyRepo(dir);
      rmSync(join(top, '.agentic-plugins'), { recursive: true, force: true });
      const filePath = await macroWorkflow(top);
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

describe('orchestrator: dispatch-peer — a codex peer runs in the snapshot (C96)', () => {
  it('the vandal peer tidies only the snapshot, which is removed when the dispatch ends', async () => {
    await withTmp(async (dir, snaps) => {
      const f = await fixture(dir);
      const before = liveView(f.top);
      const r = spawnSync(process.execPath, [DISPATCH, '--peer', 'codex', '--prompt-text', `look at ${f.top}/a`, '--cwd', f.top], {
        env: { ...fakeEnv(f, 'vandal'), TMPDIR: snaps }, encoding: 'utf8',
      });
      strictEqual(r.status, 0, r.stderr);
      deepStrictEqual(liveView(f.top), before);
      const rec = JSON.parse(readFileSync(f.record, 'utf8'));
      ok(relative(f.top, rec.cwd).startsWith('..'), `${rec.cwd} is outside the checkout`);
      match(rec.prompt, /^look at \/.+\/tree\/a$/);
      ok(!rec.prompt.includes(`${f.top}/`));
      deepStrictEqual(leftovers(snaps), []);
      strictEqual(snapshotWorktrees(f.top).length, 0);
    });
  });

  it('SIGTERM stops the peer group, removes the snapshot and exits 143', async () => {
    await withTmp(async (dir, snaps) => {
      const f = await fixture(dir);
      const cli = spawn(process.execPath, [DISPATCH, '--peer', 'codex', '--prompt-text', 'x', '--cwd', f.top], {
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
      strictEqual(snapshotWorktrees(f.top).length, 0);
    });
  });

  it('a child holding the companion\'s pipes is stopped once the companion exits, and the dispatch ends', async () => {
    await withTmp(async (dir, snaps) => {
      const f = await fixture(dir);
      let grandchild = null;
      try {
        const result = await within(dispatcher.dispatchPeer({ peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'leaky'), cancelGraceMs: 300 }), 'the dispatch to end');
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
      const f = await fixture(dir);
      const cancellation = identity.createRunCancellation();
      const result = await dispatcher.dispatchPeer({ peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'vandal'), cancellation, cancelGraceMs: 200 });
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
      const f = await fixture(dir);
      const before = liveView(f.top);
      const plain = join(dir, 'plain');
      mkdirSync(plain);
      const result = await dispatcher.dispatchPeer({ peer: 'codex', promptText: 'x', cwd: plain, env: { ...fakeEnv(f, 'vandal'), GIT_DIR: join(f.top, '.git'), GIT_WORK_TREE: f.top } });
      strictEqual(result.ok, true, result.stderr);
      strictEqual(JSON.parse(readFileSync(f.record, 'utf8')).gitDir, null);
      deepStrictEqual(liveView(f.top), before);
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

  it('a repository with no commit yet is dispatched in an orphan snapshot', async () => {
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

describe('orchestrator: runbook guidance for the snapshot (C96, C127)', () => {
  const read = (rel) => readFileSync(ORCH(rel), 'utf8').replace(/\s+/g, ' ');
  const protocol = read('core/skills/_shared/references/ensemble-protocol.md');

  it('the launch step says the peer reads a snapshot made after the companion resolves, and to name a review base by commit id', () => {
    ok(protocol.includes('A codex peer never works in the checkout: the runner gives it a snapshot of HEAD plus the working tree and the index'));
    ok(protocol.includes('name files repo-relatively and a review base by its commit id'));
    ok(protocol.includes('a missing companion still leaves no ledger, no `pending_ensemble` row and no snapshot'));
  });

  it('the collect step names snapshot_failed, maps snapshot paths back, and keeps pgrep -f from matching its own loop', () => {
    ok(protocol.includes('`snapshot_failed` (no snapshot of the checkout could be made for a codex peer'));
    ok(protocol.includes('A path in the answer under the handle\'s `snapshot.root` names the snapshot the peer read'));
    ok(protocol.includes('Collecting the peer stays notification-only.'));
    ok(protocol.includes("bracket one character (`pgrep -f '[m]utation-harness'`) or wait on a pid file (C127)"));
  });

  it('both plan entry points name the snapshot step and commit a failed run as failed, the plan keeping the local verdict', () => {
    const command = read('commands/plan.md');
    const skill = read('core/skills/plan/SKILL.md');
    ok(command.includes('for a codex peer, make a snapshot of HEAD plus the working tree and the index in a temporary worktree (C96)'));
    ok(skill.includes('A codex peer runs in a snapshot of HEAD plus the working tree and the index (C96), never the checkout'));
    for (const [name, text] of [['commands/plan.md', command], ['core/skills/plan/SKILL.md', skill]]) {
      ok(text.includes('is `failed`, `cancelled` or `orphaned`, whatever its `error_kind`, `snapshot_failed` included), the plan is LOCAL-ONLY'), `${name}: a run that did not complete makes the plan LOCAL-ONLY`);
      ok(text.includes('set the block\'s `ENSEMBLE_VERDICT` line to `failed` and name the `error_kind` in `summary.txt`'), `${name}: names the failed ensemble verdict`);
      ok(text.includes('--verdict "${ENSEMBLE_VERDICT:-$VERDICT}" --summary-file "$TEXT_DIR/summary.txt"'), `${name}: the ensemble commit takes it`);
    }
  });

  it('peer-now says files the peer writes are discarded', () => {
    for (const rel of ['commands/peer-now.md', 'core/skills/peer-now/SKILL.md']) {
      ok(read(rel).includes('A codex peer answers from a snapshot of the checkout, removed when the run ends (C96): a file it writes is discarded with it.'), rel);
    }
  });
});

// Docket C75 — peer-now's Phase 2 note, on both hosts, runs in a fresh shell:
// it finds the macro on the branch again and reads the peer, the run id and
// the run's paths from what Phase 1 wrote to the text directory. The response
// holds shell syntax, which is recorded and never run.
describe('orchestrator peer-now: the note block runs in a fresh shell (C75)', async () => {
  const { fencedBlocks } = await import(pathToFileURL(join(REPO_ROOT, 'tests/_runbook-checks.mjs')).href);
  const { createWorkflow, readWorkflow } = await import(pathToFileURL(ORCH('scripts/state.mjs')).href);
  const noteBlock = (rel) => {
    const found = fencedBlocks(readFileSync(ORCH(rel), 'utf8')).map((b) => b.lines.join('\n')).filter((b) => b.includes('RESPONSE="$(head -c 4000 "$STDOUT_PATH")"'));
    strictEqual(found.length, 1, `${rel}: one block builds the note`);
    return found[0];
  };
  // Phase 2's lookup: the one block that finds the macro (the note block
  // finds none, it reads the lookup's).
  const lookupBlock = (rel) => {
    const found = fencedBlocks(readFileSync(ORCH(rel), 'utf8')).map((b) => b.lines.join('\n')).filter((b) => b.includes('find-active --repo-root "$REPO_ROOT")" || exit 1'));
    strictEqual(found.length, 1, `${rel}: one block finds the active macro`);
    return found[0];
  };
  const fill = (block) => block.replaceAll('<plugin-root>', ORCH('')).replaceAll('<claude|codex>', 'codex');
  // Each test reads its blocks itself: a block missing fails that test.
  const blocks = [
    ['claude', () => lookupBlock('commands/peer-now.md'), () => noteBlock('commands/peer-now.md'), "TEXT_DIR='<directory from step 1>'"],
    ['codex', () => fill(lookupBlock('core/skills/peer-now/SKILL.md')), () => fill(noteBlock('core/skills/peer-now/SKILL.md')), "TEXT_DIR='<directory from mktemp>'"],
  ];
  const shells = ['bash', 'zsh', 'sh'].filter((s) => spawnSync(s, ['-c', 'exit 0']).status === 0);
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' });
  for (const shell of shells) {
    for (const [host, lookupOf, blockOf, dirLine] of blocks) {
      // Critique H3 — the lookup and the note block, each in a fresh shell,
      // with a branch switched between them to one whose macro is another: the
      // note goes to the macro the lookup found.
      it(`${shell}, ${host}: the note holds the run Phase 1 wrote and the response, none of it run, in the macro the lookup found`, async () => {
        const [lookup, block] = [lookupOf(), blockOf()];
        const dir = realpathSync(mkdtempSync(join(tmpdir(), 'peer-now-note-')));
        try {
          spawnSync('git', ['init', '-q', '-b', 'main', dir]);
          writeFileSync(join(dir, '.gitignore'), '.agentic-plugins/\n');
          git(dir, 'add', '.gitignore');
          git(dir, 'commit', '-q', '-m', 'init');
          const { filePath } = await createWorkflow({
            repoRoot: dir, verb: 'plan', host: 'claude',
            gitBaseline: { branch: 'main', head: '0'.repeat(40), status_digest: '' }, originalRequest: 'peer-now note fixture',
          });
          git(dir, 'switch', '-q', '-c', 'feat/other');
          const { filePath: other } = await createWorkflow({
            repoRoot: dir, verb: 'plan', host: 'claude',
            gitBaseline: { branch: 'feat/other', head: '0'.repeat(40), status_digest: '' }, originalRequest: 'the macro the switched branch names',
          });
          git(dir, 'switch', '-q', 'main');
          const otherBefore = readFileSync(other, 'utf8');
          const textDir = mkdtempSync(join(tmpdir(), 'agentic-text.'));
          const stdoutPath = join(textDir, 'stdout.txt');
          writeFileSync(stdoutPath, 'line one\nline \\ two $(touch pwned) `touch pwned2`\n');
          writeFileSync(join(textDir, 'peer'), 'codex');
          writeFileSync(join(textDir, 'run-id'), 'peer-now-20261017T000000Z-0a0b0c');
          writeFileSync(join(textDir, 'run.json'), JSON.stringify({ ok: true, run_id: 'peer-now-20261017T000000Z-0a0b0c', handle_path: join(textDir, 'handle.json'), stdout_path: stdoutPath }));
          const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && k !== 'CLAUDE_PLUGIN_ROOT'));
          const run = (b) => {
            ok(b.startsWith(`${dirLine}\n`), 'the block opens with its TEXT_DIR line');
            return spawnSync(shell, ['-c', b.replace(dirLine, () => `TEXT_DIR='${textDir}'`)], { cwd: dir, encoding: 'utf8', env: { ...env, AGENTIC_ORCHESTRATOR_ROOT: ORCH('') } });
          };
          let r = run(lookup);
          strictEqual(r.status, 0, r.stderr);
          strictEqual(r.stdout, `${filePath}\n`, 'the lookup prints the macro it found');
          git(dir, 'switch', '-q', 'feat/other');
          r = run(block);
          strictEqual(r.status, 0, r.stderr);
          const { body } = await readWorkflow(filePath);
          ok(body.includes('[Peer] codex consultation'), body);
          ok(body.includes('run_id: peer-now-20261017T000000Z-0a0b0c'), body);
          ok(body.includes('line \\ two $(touch pwned) `touch pwned2`'), body);
          ok(!existsSync(join(dir, 'pwned')) && !existsSync(join(dir, 'pwned2')), 'nothing in the response ran');
          strictEqual(readFileSync(other, 'utf8'), otherBefore, 'the macro the switched branch names is untouched');
          // A lookup that found no macro: the note block records nothing.
          git(dir, 'switch', '-q', '-c', 'feat/none');
          r = run(lookup);
          strictEqual(r.status, 0, r.stderr);
          strictEqual(readFileSync(join(textDir, 'macro-path'), 'utf8'), '', 'the lookup wrote that it found none');
          const before = [readFileSync(filePath, 'utf8'), readFileSync(other, 'utf8')];
          r = run(block);
          strictEqual(r.status, 1, r.stderr);
          ok(r.stderr.includes('The lookup found no active macro'), r.stderr);
          deepStrictEqual([readFileSync(filePath, 'utf8'), readFileSync(other, 'utf8')], before, 'nothing was recorded');
          rmSync(textDir, { recursive: true, force: true });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
});
