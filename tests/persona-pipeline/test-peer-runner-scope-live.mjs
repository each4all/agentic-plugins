// C181 (ADR-0023 §6, amendment of 2026-11-24, who else ends a scope) — a
// scoped run whose runner dies: the companion and a descendant it left in a
// session of its own keep running in the run's scope, and a later sweep, once
// it proves the runner gone, ends that scope through the run's own records,
// reads it gone and removes the run's snapshot on that reading, while a user
// process outside the run survives.
//
// Large tier (scripts/data/test-tiers.json): it runs the runner's CLI end to
// end on this machine's systemd user manager, kills it, and waits on real
// time for the scope's end. It skips, with the reason, where no scope can be
// made. It checks only the pids it planted, never the whole process table.

import './_drop-session.mjs';
import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { personaInfo } from './_personas.mjs';
import { tmpDir } from '../_tmp.mjs';

const P = personaInfo('engineer');
const RUNNER_PATH = P.path('scripts/peer-runner.mjs');
const RUNNER = await import(pathToFileURL(RUNNER_PATH).href);
const L = await import(pathToFileURL(P.path('scripts/lib/scope-launch.mjs')).href);
const S = await import(pathToFileURL(P.path('scripts/lib/scope.mjs')).href);

const AVAILABLE = (() => {
  if (process.platform !== 'linux') return 'Linux only';
  const a = L.scopeAvailability();
  if (!a.available) return `no scope can be made here (${a.check})`;
  if (spawnSync('systemd-run', ['--version'], { stdio: 'ignore' }).status !== 0) return 'no systemd-run';
  const placement = L.launcherPlacement();
  if (placement.inside !== false) return `this process makes no scope of its own (${placement.inside ? 'inside a launcher' : placement.withheld})`;
  return null;
})();

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

function killQuiet(target) {
  try {
    if (target) process.kill(target, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('a scoped run whose runner dies', { skip: AVAILABLE ?? false }, () => {
  it('a later sweep ends its scope once the runner is proven gone, and removes its snapshot on that reading', async (t) => {
    const dir = tmpDir(t, 'scope-run-reclaim-');
    const repo = join(dir, 'repo');
    await mkdir(repo);
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' };
    const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: gitEnv });
    git('init', '-q', '-b', 'main');
    await writeFile(join(repo, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'init');

    const pidFile = join(dir, 'planted');
    const companionsRoot = join(dir, 'companions');
    await mkdir(companionsRoot);
    await writeFile(join(companionsRoot, 'discover-peer.mjs'), `export async function discoverPeerCompanion({ peer } = {}) {
  return { ok: true, path: new URL('./' + peer + '-companion.mjs', import.meta.url).pathname };
}
`);
    // The companion leaves a sleep in a session of its own, then runs on.
    await writeFile(join(companionsRoot, 'claude-companion.mjs'), `const { spawn } = await import('node:child_process');
spawn('/bin/sh', ['-c', ${JSON.stringify(`setsid sleep 300 </dev/null >/dev/null 2>&1 & echo $! > '${pidFile}'`)}], { stdio: 'ignore', detached: true }).unref();
setInterval(() => {}, 1000);
await new Promise((r) => setTimeout(r, 300000));
`);
    await chmod(join(companionsRoot, 'claude-companion.mjs'), 0o755);
    const promptFile = join(dir, 'prompt.xml');
    await writeFile(promptFile, '<task>scope</task>\n');

    // The runner's temporary files (its prompt's copy, the snapshot) go in the
    // test's own directory: killed, the runner removes none of them itself.
    const runnerTmp = join(dir, 'tmp');
    await mkdir(runnerTmp);

    const outsider = spawn('sleep', ['300'], { stdio: 'ignore', detached: true });
    let planted = null;
    let companion = null;
    const runner = spawn(process.execPath, [RUNNER_PATH, 'run', '--repo-root', repo, '--kind', 'manual', '--peer', 'claude',
      '--prompt-file', promptFile, '--output-format', 'json', '--host', 'claude', '--cwd', repo, '--run-id', 'scope-reclaim'], {
      env: { ...process.env, AGENTIC_COMPANIONS_ROOT: companionsRoot, TMPDIR: runnerTmp },
      stdio: 'ignore',
      detached: true,
    });
    // Registered before the first await: whatever the rows find, nothing the
    // run planted outlives the test.
    t.after(() => {
      for (const target of [runner.pid, companion, planted, outsider.pid]) killQuiet(target);
    });

    const paths = RUNNER.peerRunPaths(repo, 'scope-reclaim');
    const running = await until(async () => {
      try {
        const h = await RUNNER.readHandle(paths.handle);
        return h.status === 'running' && Number.isInteger(h.pid) && S.scopeRecordState(h).state === 'scoped' ? h : null;
      } catch {
        return null;
      }
    });
    ok(running, 'the run records its scope and runs');
    companion = running.pid;
    planted = await until(async () => {
      try {
        const n = Number((await readFile(pidFile, 'utf8')).trim());
        return Number.isInteger(n) && n > 0 ? n : null;
      } catch {
        return null;
      }
    });
    ok(planted, 'the companion planted its descendant');
    const ownerPath = running.snapshot?.owner_path;
    ok(typeof ownerPath === 'string' && existsSync(ownerPath), 'the run has a snapshot');
    // The companion's owner record is written apart from the running handle:
    // the runner is killed only once it is in, so the snapshot is judged on a
    // fully recorded run, never one whose companion is unknown.
    const owner = await until(async () => {
      try {
        const o = JSON.parse(await readFile(ownerPath, 'utf8'));
        return o.companion?.pid === running.pid ? o : null;
      } catch {
        return null;
      }
    });
    ok(owner, 'the owner record names the companion the handle does');
    strictEqual(S.scopeRecordsAgree(running, owner), true, 'the owner record carries the scope the handle does');

    // The runner dies; what it launched runs on in its scope.
    process.kill(runner.pid, 'SIGKILL');
    ok(await until(() => !alive(runner.pid)), 'the runner is gone');
    ok(alive(companion) && alive(planted), 'the companion and its descendant run on');

    // A later sweep proves the runner gone, ends the scope and reads it gone.
    // Each sweep reads the scope once, without waiting, and the manager may
    // remove the emptied cgroup only after that reading: a later sweep then
    // reads it gone. The snapshot's judgment comes before that reading in a
    // sweep, so on a loaded machine the sweep that records gone may still
    // have seen the companion's group alive (an unreaped zombie) and kept the
    // snapshot (`companion-alive`); a later sweep judges it again and removes
    // it through the gate, on the reading of gone. Sweeps are repeated until
    // both are recorded, and no sweep may leave the snapshot removed while
    // the handle records no gone.
    let after = null;
    let last = null;
    let early = null;
    await until(async () => {
      last = await RUNNER.sweepPeerRuns({ repoRoot: repo, staleGraceMs: 0 });
      after = await RUNNER.readHandle(paths.handle);
      const removed = !existsSync(ownerPath);
      if (removed && after.scope?.teardown?.state !== 'gone' && early === null) early = { teardown: after.scope?.teardown ?? null, snapshots: last?.snapshots };
      return early !== null || (after.scope?.teardown?.state === 'gone' && removed);
    });
    strictEqual(early, null, `the snapshot was removed before its scope was read gone: ${JSON.stringify(early)}`);
    ok(!alive(planted) && !alive(companion), 'the companion and its descendant are gone');
    strictEqual(after.scope?.teardown?.state, 'gone', JSON.stringify(after.scope?.teardown));
    ok(!existsSync(ownerPath), `the snapshot was removed on a reading of gone: ${JSON.stringify(last?.snapshots)}`);
    ok(alive(outsider.pid), 'a user process outside the run survives');
  });
});
