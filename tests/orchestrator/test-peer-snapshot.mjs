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
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/** A snapshot whose supervisor is gone and whose companion never ran: one a reclaim removes. */
async function abandonedSnapshot(top) {
  return lib.createPeerSnapshot({ cwd: top, persona, env, supervisorPid: await deadPid() });
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
      ok(text.includes('set `ENSEMBLE_VERDICT=failed` and name the `error_kind` in `summary.txt`'), `${name}: names the failed ensemble verdict`);
      ok(text.includes('--verdict "${ENSEMBLE_VERDICT:-$VERDICT}" --summary-file "$TEXT_DIR/summary.txt"'), `${name}: the ensemble commit takes it`);
    }
  });

  it('peer-now says files the peer writes are discarded', () => {
    for (const rel of ['commands/peer-now.md', 'core/skills/peer-now/SKILL.md']) {
      ok(read(rel).includes('A codex peer answers from a snapshot of the checkout, removed when the run ends (C96): a file it writes is discarded with it.'), rel);
    }
  });
});
