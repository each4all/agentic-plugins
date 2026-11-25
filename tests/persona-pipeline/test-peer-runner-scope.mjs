// C181 (ADR-0023 §6, amendments of 2026-11-22 and 2026-11-24) — a peer run's
// launch in a scope of its own and its one end, through the persona runner
// (lib/scope-run.mjs, wired into peer-runner.mjs's spawn section):
//
//   - where no scope can be made, the run launches as before and its handle
//     says why (a fake system, any host);
//   - on this machine's systemd user manager: a descendant the companion
//     leaves in a session of its own, holding the companion's stdout, is gone
//     at the run's end, its teardown `gone`, while a user process outside the
//     run survives; a run in a checkout records the scope to the snapshot's
//     owner record too and removes the snapshot on that reading; a process
//     that left the scope through a scope of its own keeps the pipe, which
//     the end closes within its bound (`pipe_held`);
//   - a gated launch that fails before the word marks its record abandoned and
//     launches directly, and one whose mark cannot be written launches
//     nothing.
//
// The live rows run through the engineer's runner and the orchestrator's
// hand-kept one, which takes the same launch and end (its copies of the
// libraries are held to the source byte for byte), and skip, with the reason,
// where no scope can be made. Small rows
// call the library; the live ones spawn systemd-run and a fake companion
// (medium). No row reads the whole process table: each checks the pids it
// planted.

import './_drop-session.mjs';
import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { personaInfo } from './_personas.mjs';
import { tmpDir } from '../_tmp.mjs';

const P = personaInfo('engineer');
const RUNNER = await import(pathToFileURL(P.path('scripts/peer-runner.mjs')).href);
const ORCHESTRATOR = await import(new URL('../../plugins/orchestrator/scripts/peer-runner.mjs', import.meta.url).href);
// The libraries the runner loads: the engineer's generated copies, which the
// drift check holds to the persona-pipeline source.
const RUN = await import(pathToFileURL(P.path('scripts/lib/scope-run.mjs')).href);
const L = await import(pathToFileURL(P.path('scripts/lib/scope-launch.mjs')).href);
const S = await import(pathToFileURL(P.path('scripts/lib/scope.mjs')).href);

// Whether this machine can make a scope: the reader's checks and systemd-run.
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

async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// A companions root whose companion runs `body` (JavaScript, top-level await
// allowed) and then answers a JSON envelope.
async function writeCompanion(dir, body) {
  const root = join(dir, 'companions');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'discover-peer.mjs'), `export async function discoverPeerCompanion({ peer } = {}) {
  return { ok: true, path: new URL('./' + peer + '-companion.mjs', import.meta.url).pathname };
}
`);
  const path = join(root, 'claude-companion.mjs');
  await writeFile(path, `${body}
process.stdout.write(JSON.stringify({ status: 'success', peer_host: 'claude', peer_model: null, stdout: 'ok', exit_code: 0 }));
process.exit(0);
`);
  await chmod(path, 0o755);
  return root;
}

// A body that leaves a `sleep` in a session of its own holding the
// companion's stdout, and writes its pid to `pidFile`.
function plantBody(pidFile, command = 'setsid sleep 300') {
  return `const { spawn } = await import('node:child_process');
spawn('/bin/sh', ['-c', ${JSON.stringify(`${command} & echo $! > '${pidFile}'`)}], { stdio: ['ignore', 'inherit', 'ignore'], detached: true }).unref();
await new Promise((r) => setTimeout(r, 300));`;
}

function runIn(dir, companionsRoot, runId, extra = {}, runner = RUNNER) {
  return runner.runPeer({
    repoRoot: dir, runId, kind: 'manual', host: 'claude', peer: 'claude', promptText: '<task>scope</task>',
    outputFormat: 'json', cwd: dir, env: { ...process.env, AGENTIC_COMPANIONS_ROOT: companionsRoot }, ...extra,
  });
}

async function readPid(path) {
  const pid = await until(async () => {
    try {
      const n = Number((await readFile(path, 'utf8')).trim());
      return Number.isInteger(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  });
  ok(pid, `the planted pid in ${path}`);
  return pid;
}

describe('where no scope can be made', () => {
  it('the run launches as before, and its handle says why', async (t) => {
    const dir = tmpDir(t, 'scope-run-none-');
    const companionsRoot = await writeCompanion(dir, '');
    // A system the reader refuses at once: not Linux.
    const system = { platform: 'darwin', now: () => Date.now(), pid: process.pid, uid: () => 1000 };
    const result = await runIn(dir, companionsRoot, 'scope-none', { scopeSystem: system });
    strictEqual(result.status, 'completed');
    const handle = await RUNNER.readHandle(result.handle_path);
    deepStrictEqual(handle.scope, { version: S.SCOPE_VERSION, state: 'none', reason: 'unavailable' });
    strictEqual(handle.pipe_held, undefined);
  });

  it('planLaunch writes the record of a run that makes no scope, and plans a direct launch', async () => {
    const written = [];
    // The availability and placement checks are the reader's; their judgment
    // is placementFrom's (test-scope-launch.mjs). A refused system plans the
    // direct launch with its reason.
    const plan = await RUN.planLaunch({
      runId: 'scope-plan',
      system: { platform: 'darwin', now: () => Date.now(), pid: process.pid, uid: () => 1000 },
      writeRecord: async (scope) => {
        written.push(scope);
      },
      warn: () => {},
    });
    strictEqual(plan.kind, 'direct');
    deepStrictEqual(written, [{ version: S.SCOPE_VERSION, state: 'none', reason: 'unavailable' }]);
  });

  it('a record that cannot be written still plans the direct launch', async () => {
    const warnings = [];
    const plan = await RUN.planLaunch({
      runId: 'scope-plan-unwritten',
      system: { platform: 'darwin', now: () => Date.now(), pid: process.pid, uid: () => 1000 },
      writeRecord: async () => {
        throw new Error('ledger write failed');
      },
      warn: (text) => warnings.push(text),
    });
    strictEqual(plan.kind, 'direct');
    ok(warnings.some((w) => w.includes('was not written')), warnings.join('\n'));
  });

  it('the association is the autopilot run and step, or null', () => {
    deepStrictEqual(RUN.associationOf({ AGENTIC_AUTOPILOT: 'autopilot-20261124T114307Z-990637', AGENTIC_AUTOPILOT_STEP: '21' }), { autopilot_run: 'autopilot-20261124T114307Z-990637', autopilot_step: '21' });
    strictEqual(RUN.associationOf({ AGENTIC_AUTOPILOT: 'autopilot-x' }), null);
    strictEqual(RUN.associationOf({ AGENTIC_AUTOPILOT: 'a b', AGENTIC_AUTOPILOT_STEP: '1' }), null);
    strictEqual(RUN.associationOf({}), null);
  });
});

describe('a scoped run on this machine', { skip: AVAILABLE ?? false }, () => {
  for (const [name, runner] of [['engineer', RUNNER], ['orchestrator', ORCHESTRATOR]]) {
    it(`${name}: ends a descendant in a session of its own that holds the companion's stdout, and a user process outside the run survives`, async (t) => {
      await descendantRow(t, runner);
    });
    it(`${name}: a run in a checkout records the scope to the owner record and removes the snapshot on the end's reading of gone`, async (t) => {
      await checkoutRow(t, runner);
    });
  }

  async function descendantRow(t, runner) {
    const dir = tmpDir(t, 'scope-run-live-');
    const pidFile = join(dir, 'planted');
    const outsider = spawn('sleep', ['300'], { stdio: 'ignore', detached: true });
    t.after(() => killQuiet(outsider.pid));
    let planted = null;
    t.after(() => killQuiet(planted));
    const companionsRoot = await writeCompanion(dir, plantBody(pidFile));
    const result = await runIn(dir, companionsRoot, 'scope-live-a', {}, runner);
    planted = await readPid(pidFile);
    strictEqual(result.status, 'completed', JSON.stringify(result));
    const handle = await runner.readHandle(result.handle_path);
    const state = S.scopeRecordState(handle);
    strictEqual(state.state, 'scoped', JSON.stringify(handle.scope));
    strictEqual(state.identity.owner.run_id, 'scope-live-a');
    strictEqual(state.identity.has_snapshot, false);
    strictEqual(state.identity.gate.pid, handle.peer_process.pid);
    strictEqual(handle.scope.teardown.state, 'gone', JSON.stringify(handle.scope.teardown));
    strictEqual(handle.pipe_held, undefined);
    strictEqual(alive(planted), false, 'the descendant in its own session is gone');
    ok(alive(outsider.pid), 'a user process outside the run survives');
  }

  it('a companion that leaves nothing behind reads gone, its scope already collected when the kill is asked', async (t) => {
    const dir = tmpDir(t, 'scope-run-plain-');
    const companionsRoot = await writeCompanion(dir, '');
    const result = await runIn(dir, companionsRoot, 'scope-live-plain');
    strictEqual(result.status, 'completed', JSON.stringify(result));
    const handle = await RUNNER.readHandle(result.handle_path);
    strictEqual(S.scopeRecordState(handle).state, 'scoped', JSON.stringify(handle.scope));
    strictEqual(handle.scope.teardown.state, 'gone', JSON.stringify(handle.scope.teardown));
  });

  async function checkoutRow(t, runner) {
    const dir = tmpDir(t, 'scope-run-checkout-');
    const repo = join(dir, 'repo');
    await mkdir(repo);
    const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' } });
    git('init', '-q', '-b', 'main');
    await writeFile(join(repo, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'init');
    const pidFile = join(dir, 'planted');
    let planted = null;
    t.after(() => killQuiet(planted));
    // The companion copies the snapshot's owner record while it runs (the
    // record goes with the snapshot at the end): the scope must be there,
    // written before the word, and agree with the handle's.
    const ownerCopy = join(dir, 'owner-seen.json');
    const copyOwner = `{ const fs = await import('node:fs'); const path = await import('node:path');
const at = process.argv.indexOf('--cwd'); fs.copyFileSync(path.join(path.dirname(process.argv[at + 1]), 'owner.json'), ${JSON.stringify(ownerCopy)}); }`;
    const companionsRoot = await writeCompanion(dir, `${copyOwner}\n${plantBody(pidFile)}`);
    const result = await runIn(repo, companionsRoot, 'scope-live-b', {}, runner);
    planted = await readPid(pidFile);
    strictEqual(result.status, 'completed', JSON.stringify(result));
    const handle = await runner.readHandle(result.handle_path);
    strictEqual(handle.snapshot?.isolation, 'snapshot', JSON.stringify(handle.snapshot));
    const state = S.scopeRecordState(handle);
    strictEqual(state.state, 'scoped');
    strictEqual(state.identity.has_snapshot, true);
    strictEqual(handle.scope.teardown.state, 'gone');
    const seen = JSON.parse(await readFile(ownerCopy, 'utf8'));
    strictEqual(S.scopeRecordState(seen).state, 'scoped', `the owner record carried the scope while the companion ran: ${JSON.stringify(seen.scope)}`);
    ok(S.scopeRecordsAgree(seen, handle), 'the owner record and the handle name one scope');
    ok(typeof handle.snapshot.removed_at === 'string', `the snapshot was removed: ${JSON.stringify(handle.snapshot)}`);
    strictEqual(existsSync(handle.snapshot.owner_path), false, 'the owner record went with the snapshot');
    strictEqual(alive(planted), false);
  }

  it('a process that left the scope through a scope of its own keeps the pipe, which the end closes within its bound', async (t) => {
    const dir = tmpDir(t, 'scope-run-held-');
    const pidFile = join(dir, 'planted');
    const unit = `${S.SCOPE_UNIT_PREFIX}test-held-${process.pid}-${Date.now()}.scope`;
    let planted = null;
    t.after(() => {
      killQuiet(planted);
      spawnSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' });
    });
    const companionsRoot = await writeCompanion(dir, plantBody(pidFile, `systemd-run --user --scope --quiet --collect --unit=${unit} sleep 300`));
    const started = Date.now();
    const result = await runIn(dir, companionsRoot, 'scope-live-c');
    const took = Date.now() - started;
    planted = await readPid(pidFile);
    strictEqual(result.status, 'completed', JSON.stringify(result));
    const handle = await RUNNER.readHandle(result.handle_path);
    strictEqual(handle.pipe_held, true);
    // The run's own scope emptied: the process is in another scope.
    strictEqual(handle.scope.teardown.state, 'gone', JSON.stringify(handle.scope.teardown));
    ok(took < 30000, `the end is bounded (${took} ms)`);
    ok(alive(planted), 'a process in a scope of its own is outside the run\'s kill');
  });
});

describe('a gated launch that fails before the word', { skip: AVAILABLE ?? false }, () => {
  async function gatedPlan(t, writeRecord) {
    const dir = tmpDir(t, 'scope-run-abandon-');
    const marker = join(dir, 'ran');
    const plan = await RUN.planLaunch({ runId: `scope-abandon-${process.pid}`, writeRecord, warn: () => {} });
    strictEqual(plan.kind, 'gated');
    return { plan, marker };
  }

  it('marks its record abandoned and launches directly', async (t) => {
    const writes = [];
    const { plan, marker } = await gatedPlan(t, async (scope) => {
      writes.push(scope.state);
      if (scope.state === 'scoped') throw new Error('handle write failed');
    });
    const launch = RUN.beginLaunch(plan, '/bin/sh', ['-c', `: > '${marker}'`], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const closed = new Promise((r) => launch.child.once('close', r));
    const answer = await launch.handshake();
    strictEqual(answer.launched, false);
    ok(typeof answer.relaunch === 'function');
    await closed;
    strictEqual(existsSync(marker), false, 'the gate ran nothing');
    deepStrictEqual(writes, ['scoped', 'abandoned']);
    const direct = answer.relaunch();
    t.after(() => killQuiet(direct.child.pid));
    const ended = await direct.end({ closed: new Promise((r) => direct.child.once('close', (code, signal) => r({ code, signal }))) });
    strictEqual(ended.code, 0);
    strictEqual(ended.scoped, false);
    ok(existsSync(marker), 'the direct launch ran');
  });

  it('launches nothing where the mark cannot be written', async (t) => {
    const writes = [];
    const { plan, marker } = await gatedPlan(t, async (scope) => {
      writes.push(scope.state);
      throw new Error('ledger write failed');
    });
    const launch = RUN.beginLaunch(plan, '/bin/sh', ['-c', `: > '${marker}'`], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const closed = new Promise((r) => launch.child.once('close', (code, signal) => r({ code, signal })));
    const answer = await launch.handshake();
    deepStrictEqual(answer, { launched: false });
    const ended = await launch.end({ closed });
    deepStrictEqual({ failure: ended.failure, code: ended.code, scoped: ended.scoped }, { failure: 'scope_abandon_unwritten', code: null, scoped: false });
    strictEqual(existsSync(marker), false);
    deepStrictEqual(writes, ['scoped', 'abandoned']);
  });
});
