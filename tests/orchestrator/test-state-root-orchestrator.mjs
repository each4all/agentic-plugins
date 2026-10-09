// ADR-0067 Decision 4, item 2 (SR) for orchestrator's state script: lookups
// (find-active, find-macro, the runbooks' --workflow=<id> resolver, the Stop's
// macro list) search the read set, a macro is written in place and in one
// copy only, `create` checks the whole repository, `archive` uses the macro's
// own home, the archive guard counts a child in any worktree's own home, and
// two worktrees updating one macro at once lose neither write.
//
// Real git repositories: a main checkout, a linked worktree `lane` on feat/x,
// and a third worktree `other` on feat/y.

import { describe, it, before, after } from 'node:test';
import { strictEqual, ok, match, deepStrictEqual, notStrictEqual, rejects } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import nodeFs from 'node:fs';

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const ORCH_STATE = join(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');
const HOME = '.agentic-plugins/state/orchestrator';
const DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
const cleanEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_'))),
  ...GIT_ENV,
  ...extra,
});
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = (args, env = {}) => spawnSync(process.execPath, [ORCH_STATE, ...args], { encoding: 'utf8', env: cleanEnv(env) });
const runAsync = (args, cwd = undefined) => new Promise((resolve) => {
  const child = spawn(process.execPath, [ORCH_STATE, ...args], { cwd, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stderr }));
});
const SWITCH_ON = { schema: 'agentic-shared-creation-1.0', enabled: true, enabled_at: '2026-10-08T00:00:00Z', versions: {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Wait until `cond` holds, up to `ms` (inside acquireLock's 5 s budget), so a
// loaded machine waits for the writer to reach the lock instead of failing or
// passing by timing.
const waitFor = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await sleep(25);
  }
  return true;
};
// A writer run in the background: `done` turns true when it exits.
const startWriter = (args, env = {}) => {
  const writer = { done: false };
  writer.result = new Promise((resolve) => {
    const child = spawn(process.execPath, [ORCH_STATE, ...args], { env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => { writer.done = true; resolve({ status, stdout, stderr }); });
  });
  return writer;
};
// Hold the creation lock `lock` the way acquireLock holds one (a lock file
// with a fresh mtime, which a writer waits on), start the writer, and show it
// waits there: once it has `reached` the lock, it neither finishes nor writes
// while the lock is held, and it does both once the lock is released.
const waitsOn = async (lock, start, { reached, written }) => {
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, `${process.pid}:held-by-the-test`);
  let writer;
  try {
    writer = start();
    ok(await waitFor(reached), `the writer reached ${lock}`);
    await sleep(700);
    ok(!writer.done, `the writer waits for ${lock}`);
    ok(!written(), 'nothing was written while the lock was held');
  } finally {
    rmSync(lock, { force: true });
  }
  const done = await writer.result;
  strictEqual(done.status, 0, done.stderr);
  ok(written(), 'released, the writer finishes');
  return done;
};

function makeRepo(dir) {
  const main = join(dir, 'repo');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'README.md'), 'x\n');
  git(main, 'add', 'README.md');
  git(main, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  git(main, 'worktree', 'add', '-q', '-b', 'feat/x', join(dir, 'lane'));
  git(main, 'worktree', 'add', '-q', '-b', 'feat/y', join(dir, 'other'));
  return {
    main: realpathSync(main),
    lane: realpathSync(join(dir, 'lane')),
    other: realpathSync(join(dir, 'other')),
    head: git(main, 'rev-parse', 'HEAD'),
  };
}

describe('orchestrator: macros are found in the read set and written in one copy (ADR-0067 Decision 4, item 2)', () => {
  let dir;
  let repo;
  const wfDir = (root) => join(root, HOME, 'workflows');
  const listed = (root) => (existsSync(wfDir(root)) ? readdirSync(wfDir(root)).filter((n) => n.endsWith('.md')) : []);
  const reset = () => {
    for (const root of [repo.main, repo.lane, repo.other]) {
      rmSync(join(root, '.agentic-plugins'), { recursive: true, force: true });
      rmSync(join(root, '.claude'), { recursive: true, force: true });
    }
  };
  const create = (checkout, branch = 'main') => run([
    'create', '--repo-root', checkout, '--verb', 'plan', '--host', 'claude',
    '--git-baseline-branch', branch, '--git-baseline-head', repo.head, '--status-digest', DIGEST,
    '--original-request', 'orchestrator state root fixture',
  ]);
  const plan = (macroPath, subtasks) => {
    const file = join(dir, `subtasks-${basename(macroPath)}.json`);
    writeFileSync(file, JSON.stringify(subtasks));
    const r = run(['plan-set', '--workflow-path', macroPath, '--host', 'claude', '--subtasks-json-file', file]);
    strictEqual(r.status, 0, r.stderr);
  };
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'state-root-orch-')));
    repo = makeRepo(dir);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('find-active, find-macro and resolve-workflow from a linked worktree find a macro in the main checkout', () => {
    reset();
    const made = create(repo.main);
    strictEqual(made.status, 0, made.stderr);
    const macroPath = made.stdout.trim();
    plan(macroPath, [{ id: 'T1', verb: 'compose', branch: 'feat/x', blocked_by: [], status: 'pending' }]);
    strictEqual(run(['find-active', '--repo-root', repo.lane, '--branch', 'main']).stdout.trim(), macroPath);
    strictEqual(run(['find-macro', '--repo-root', repo.lane, '--subtask-branch', 'feat/x']).stdout.trim(), macroPath);
    const resolved = run(['resolve-workflow', '--repo-root', repo.lane, '--workflow-id', basename(macroPath, '.md')]);
    strictEqual(resolved.status, 0, resolved.stderr);
    strictEqual(resolved.stdout.trim(), macroPath);
    const missing = run(['resolve-workflow', '--repo-root', repo.lane, '--workflow-id', 'macro-plan-20261008T000000Z-abcdef']);
    strictEqual(missing.status, 3, 'no root holds it: 3, apart from an error');
    match(missing.stderr, /no macro/);
  });

  it("a macro in the linked worktree's own home is found and updated in place, never copied", () => {
    reset();
    const made = create(repo.lane);
    strictEqual(made.status, 0, made.stderr);
    const macroPath = made.stdout.trim();
    ok(macroPath.startsWith(wfDir(repo.lane)), macroPath);
    plan(macroPath, [{ id: 'T1', verb: 'compose', branch: 'feat/z', blocked_by: [], status: 'pending' }]);
    deepStrictEqual(listed(repo.main), [], 'nothing was created in the main checkout');
    strictEqual(run(['resolve-workflow', '--repo-root', repo.lane, '--workflow-id', basename(macroPath, '.md')]).stdout.trim(), macroPath);
    // Shared creation on moves where a macro is created, not where one found
    // in the checkout's own home is written.
    mkdirSync(join(repo.main, '.agentic-plugins/state'), { recursive: true });
    writeFileSync(join(repo.main, '.agentic-plugins/state/shared-creation.json'), JSON.stringify(SWITCH_ON));
    plan(macroPath, [{ id: 'T1', verb: 'compose', branch: 'feat/w', blocked_by: [], status: 'pending' }]);
    match(readFileSync(macroPath, 'utf8'), /feat\/w/);
    deepStrictEqual(listed(repo.main), [], 'nothing was copied to the default state root');
    strictEqual(run(['resolve-workflow', '--repo-root', repo.lane, '--workflow-id', basename(macroPath, '.md')]).stdout.trim(), macroPath);
  });

  it('create refuses a branch key active in the read set, or in another worktree\'s own home', () => {
    reset();
    strictEqual(create(repo.main).status, 0);
    const second = create(repo.lane);
    strictEqual(second.status, 1);
    match(second.stderr, /already exists on branch 'main'/);
    deepStrictEqual(listed(repo.lane), []);
    reset();
    const hidden = create(repo.other, 'integration');
    strictEqual(hidden.status, 0, hidden.stderr);
    const again = create(repo.lane, 'integration');
    strictEqual(again.status, 1);
    ok(again.stderr.includes(hidden.stdout.trim()), again.stderr);
  });

  it('a macro held by two files refuses every write, and the resolver names both', () => {
    reset();
    const made = create(repo.main);
    const macroPath = made.stdout.trim();
    const copy = join(wfDir(repo.lane), basename(macroPath));
    mkdirSync(wfDir(repo.lane), { recursive: true });
    writeFileSync(copy, readFileSync(macroPath, 'utf8'));
    const before = readFileSync(macroPath, 'utf8');
    const subtasks = join(dir, 'two-copies.json');
    writeFileSync(subtasks, JSON.stringify([{ id: 'T1', verb: 'compose', branch: 'feat/q', blocked_by: [], status: 'pending' }]));
    for (const target of [macroPath, copy]) {
      const refused = run(['plan-set', '--workflow-path', target, '--host', 'claude', '--subtasks-json-file', subtasks]);
      strictEqual(refused.status, 1, `plan-set on ${target} must refuse`);
      match(refused.stderr, /held by 2 files/);
    }
    strictEqual(readFileSync(macroPath, 'utf8'), before);
    const resolved = run(['resolve-workflow', '--repo-root', repo.lane, '--workflow-id', basename(macroPath, '.md')]);
    strictEqual(resolved.status, 1);
    ok(resolved.stderr.includes(macroPath) && resolved.stderr.includes(copy), resolved.stderr);
  });

  it("archive puts a macro in its own home's archive, whatever checkout asks", () => {
    reset();
    const macroPath = create(repo.main).stdout.trim();
    const archived = run(['archive', '--workflow-path', macroPath, '--host', 'claude', '--repo-root', repo.lane]);
    strictEqual(archived.status, 0, archived.stderr);
    strictEqual(dirname(archived.stdout.trim()), join(repo.main, HOME, 'archive'));
    ok(!existsSync(join(repo.lane, HOME, 'archive')), "nothing went to the lane's archive");
  });

  it("the archive guard counts a child in any worktree's own home, once", async () => {
    reset();
    const macroPath = create(repo.main).stdout.trim();
    const macroId = basename(macroPath, '.md');
    const { noActiveEngineerChildrenScan, listAllMacros } = await import(pathToFileURL(ORCH_STATE).href);
    const childDir = join(repo.other, '.agentic-plugins/state/engineer/workflows');
    mkdirSync(childDir, { recursive: true });
    writeFileSync(join(childDir, 'compose-20261008T000000Z-c0ffee.md'), `---\nworkflow_id: "compose-20261008T000000Z-c0ffee"\nparent_workflow: "${macroId}"\n---\n`);
    strictEqual(await noActiveEngineerChildrenScan(repo.main, macroId), 1, "a child in another worktree's own home blocks");
    strictEqual(await noActiveEngineerChildrenScan(repo.lane, macroId), 1, 'from any checkout');
    deepStrictEqual(await listAllMacros(repo.lane), [macroPath], "the lane's Stop sees the main checkout's macro");
  });

  it('two worktrees writing one macro meet on one lock, and lose neither write', async () => {
    reset();
    const macroPath = create(repo.main).stdout.trim();
    plan(macroPath, [
      { id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'pending' },
      { id: 'T2', verb: 'compose', branch: 'feat/t2', blocked_by: [], status: 'pending' },
      { id: 'T3', verb: 'compose', branch: 'feat/t3', blocked_by: [], status: 'pending' },
    ]);
    // Each writer runs in its own checkout and names the macro the way the
    // runbooks do there: the main checkout by the active macro on its branch,
    // the lane by `--workflow=<id>` through the lane's read set. One file.
    const id = basename(macroPath, '.md');
    const resolveIn = (checkout, args) => spawnSync(process.execPath, [ORCH_STATE, ...args, '--repo-root', checkout], { cwd: checkout, encoding: 'utf8', env: cleanEnv() }).stdout.trim();
    const fromMain = resolveIn(repo.main, ['find-active', '--branch', 'main']);
    const fromLane = resolveIn(repo.lane, ['resolve-workflow', '--workflow-id', id]);
    strictEqual(fromMain, macroPath);
    strictEqual(fromLane, macroPath);
    const update = (checkout, path, subtask, i) => runAsync([
      'subtask-update', '--workflow-path', path, '--host', 'claude', '--subtask-id', subtask,
      '--status', 'in_progress', '--engineer-workflow-id', `compose-20261008T00000${i}Z-abc12${i}`,
    ], checkout);
    // A writer in the main checkout holds the macro's lock: the lane's writer
    // waits for it rather than writing beside it.
    const lock = `${macroPath}.lock`;
    writeFileSync(lock, `${process.pid}:held-by-the-test`);
    const before = readFileSync(macroPath, 'utf8');
    const waiting = update(repo.lane, fromLane, 'T1', 1);
    await new Promise((r) => setTimeout(r, 1500));
    strictEqual(readFileSync(macroPath, 'utf8'), before, 'nothing was written while the lock was held');
    rmSync(lock);
    const waited = await waiting;
    strictEqual(waited.status, 0, waited.stderr);
    // Then one writer from each checkout at once.
    const both = await Promise.all([update(repo.main, fromMain, 'T2', 2), update(repo.lane, fromLane, 'T3', 3)]);
    for (const r of both) strictEqual(r.status, 0, r.stderr);
    const read = JSON.parse(run(['read', '--workflow-path', macroPath]).stdout);
    deepStrictEqual(read.plan.subtasks.map((s) => s.status), ['in_progress', 'in_progress', 'in_progress']);
  });
});

// ADR-0067 Decision 2: with shared creation on, a create or an archive in a
// home other than the default state root's takes the repository's creation
// lock (the default state root's home) and then that home's. Each is held here
// in turn; `reached` is what the writer visibly does just before it asks for
// the lock: the repository lock's `ensureDir` of the default state root's
// workflows directory, or holding the repository lock itself.
describe('orchestrator: create and archive wait on both creation locks once shared creation is on (ADR-0067 Decision 2)', () => {
  let dir;
  let repo;
  const wfDir = (root) => join(root, HOME, 'workflows');
  const listed = (root) => (existsSync(wfDir(root)) ? readdirSync(wfDir(root)).filter((n) => n.endsWith('.md')) : []);
  const repoLock = () => join(repo.main, HOME, '.creation-lock');
  const homeLock = () => join(repo.lane, HOME, '.creation-lock');
  const reset = () => {
    for (const root of [repo.main, repo.lane, repo.other]) rmSync(join(root, '.agentic-plugins'), { recursive: true, force: true });
  };
  const switchOn = () => {
    mkdirSync(join(repo.main, '.agentic-plugins/state'), { recursive: true });
    writeFileSync(join(repo.main, '.agentic-plugins/state/shared-creation.json'), JSON.stringify(SWITCH_ON));
  };
  const createArgs = [
    'create', '--verb', 'plan', '--host', 'claude', '--git-baseline-branch', 'main', '--status-digest', DIGEST,
    '--original-request', 'creation lock fixture',
  ];
  // The macro stays in the lane's own home: AGENTIC_STATE_BASE names it.
  const createInLane = () => startWriter([...createArgs, '--repo-root', repo.lane, '--git-baseline-head', repo.head], { AGENTIC_STATE_BASE: repo.lane });
  // A macro in the lane's own home, made while shared creation was off.
  const macroInLane = () => {
    const made = run([...createArgs, '--repo-root', repo.lane, '--git-baseline-head', repo.head]);
    strictEqual(made.status, 0, made.stderr);
    ok(made.stdout.trim().startsWith(wfDir(repo.lane)), made.stdout);
    return made.stdout.trim();
  };
  const archiveFromLane = (path) => startWriter(['archive', '--workflow-path', path, '--host', 'claude', '--repo-root', repo.lane]);
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'state-root-orch-locks-')));
    repo = makeRepo(dir);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("create waits on the repository's creation lock", async () => {
    reset();
    switchOn();
    const made = await waitsOn(repoLock(), createInLane, {
      reached: () => existsSync(wfDir(repo.main)),
      written: () => listed(repo.lane).length === 1,
    });
    ok(made.stdout.trim().startsWith(wfDir(repo.lane)), made.stdout);
  });

  it("create waits on the record home's creation lock", async () => {
    reset();
    switchOn();
    await waitsOn(homeLock(), createInLane, {
      reached: () => existsSync(repoLock()),
      written: () => listed(repo.lane).length === 1,
    });
    ok(!existsSync(repoLock()), 'and releases the repository lock');
  });

  it("archive waits on the repository's creation lock", async () => {
    reset();
    const path = macroInLane();
    switchOn();
    ok(!existsSync(wfDir(repo.main)));
    await waitsOn(repoLock(), () => archiveFromLane(path), {
      reached: () => existsSync(wfDir(repo.main)),
      written: () => !existsSync(path),
    });
    ok(existsSync(join(repo.lane, HOME, 'archive', basename(path))), "archived in the macro's own home");
  });

  it("archive waits on the record home's creation lock", async () => {
    reset();
    const path = macroInLane();
    switchOn();
    await waitsOn(homeLock(), () => archiveFromLane(path), {
      reached: () => existsSync(repoLock()),
      written: () => !existsSync(path),
    });
    ok(existsSync(join(repo.lane, HOME, 'archive', basename(path))), "archived in the macro's own home");
  });
});

describe('orchestrator: what derives from a macro under another root (ADR-0067 Decisions 1, 4)', () => {
  let dir;
  let repo;
  const slot = (root) => join(root, HOME, 'last-session-handoff.json');
  const reset = () => {
    for (const root of [repo.main, repo.lane, repo.other]) rmSync(join(root, '.agentic-plugins'), { recursive: true, force: true });
  };
  const create = (checkout, branch = 'main') => run([
    'create', '--repo-root', checkout, '--verb', 'plan', '--host', 'claude',
    '--git-baseline-branch', branch, '--git-baseline-head', repo.head, '--status-digest', DIGEST,
    '--original-request', 'orchestrator derived fixture',
  ]);
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'state-root-orch-u4b-')));
    repo = makeRepo(dir);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("the terminal sidecar writes the slot in the command's checkout and points into the state root", () => {
    reset();
    const macroPath = create(repo.main).stdout.trim();
    const done = spawnSync(process.execPath, [ORCH_STATE,
      'set-terminal', '--workflow-path', macroPath, '--host', 'claude',
      '--terminal-phase', 'finalized', '--terminal-marker', 'true', '--next-action', 'archive',
    ], { cwd: repo.lane, encoding: 'utf8', env: cleanEnv() });
    strictEqual(done.status, 0, done.stderr);
    ok(existsSync(slot(repo.lane)), "the slot is the lane's");
    ok(!existsSync(slot(repo.main)), 'nothing beside the macro');
    strictEqual(JSON.parse(readFileSync(slot(repo.lane), 'utf8')).workflow_path, `${HOME}/workflows/${basename(macroPath)}`);
  });

  it("a macro's peer run is kept in the macro's home, found from the lane, and refused when two roots hold the id", async () => {
    reset();
    const macroPath = create(repo.main).stdout.trim();
    const runner = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/peer-runner.mjs')).href);
    const companions = join(dir, 'fake-companions');
    mkdirSync(companions, { recursive: true });
    writeFileSync(join(companions, 'discover-peer.mjs'),
      'export async function discoverPeerCompanion({ peer } = {}) { return { ok: true, path: new URL("./" + peer + "-companion.mjs", import.meta.url).pathname }; }\n');
    writeFileSync(join(companions, 'codex-companion.mjs'),
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ status: 'success', peer_host: 'codex', peer_model: null, stdout: 'ok', exit_code: 0 }));\n",
      { mode: 0o755 });
    const runId = 'plan-verify-20261008T000000Z-u4b001';
    await runner.runPeer({
      repoRoot: repo.lane, runId, kind: 'ensemble', workflowPath: macroPath, phase: 'plan', ensembleType: 'plan-verify',
      host: 'claude', peer: 'codex', promptText: '<task>u4b</task>', outputFormat: 'json', cwd: repo.lane,
      env: { ...cleanEnv(), AGENTIC_COMPANIONS_ROOT: companions },
    });
    ok(existsSync(join(repo.main, HOME, 'peer-runs', runId, 'handle.json')), "the ledger is in the macro's own home");
    ok(!existsSync(join(repo.lane, HOME, 'peer-runs')), "nothing in the lane's home");
    const status = await runner.statusPeerRun({ repoRoot: repo.lane, runId });
    ok(JSON.stringify(status).includes(runId), JSON.stringify(status));
    mkdirSync(join(repo.lane, HOME, 'peer-runs', runId), { recursive: true });
    let refused = null;
    try {
      await runner.statusPeerRun({ repoRoot: repo.lane, runId });
    } catch (err) {
      refused = err;
    }
    ok(refused && /exists in both/.test(refused.message), String(refused));
  });

  it("a Stop records each macro's git facts from the worktree that has its branch, or none", async () => {
    reset();
    const onMain = create(repo.main, 'main').stdout.trim();
    const onLane = create(repo.main, 'feat/x').stdout.trim();
    const nowhere = create(repo.main, 'integration').stdout.trim();
    writeFileSync(join(repo.main, 'dirt.txt'), 'untracked\n');
    try {
      const mainDigest = createHash('sha256').update(execFileSync('git', ['-C', repo.main, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'])).digest('hex');
      const { runMacroStopArchiveAll } = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/stop-archive.mjs')).href);
      const LANE_DIGEST = 'a'.repeat(64);
      await runMacroStopArchiveAll({ repoRoot: repo.lane, host: 'claude', statusDigest: LANE_DIGEST, headSubject: 'feat: lane', stderr: { write: () => {} } });
      const digestOf = (path) => JSON.parse(run(['read', '--workflow-path', path]).stdout).last_snapshot.status_digest;
      strictEqual(digestOf(onLane), LANE_DIGEST, "the lane's own branch: the Stop's facts");
      strictEqual(digestOf(onMain), mainDigest, 'another worktree has the branch: its working tree');
      notStrictEqual(mainDigest, LANE_DIGEST);
      strictEqual(digestOf(nowhere), '', 'no worktree has the branch: unavailable');
    } finally {
      rmSync(join(repo.main, 'dirt.txt'), { force: true });
    }
  });
});

// U4c — the second Plan-verify's findings on orchestrator: a copy is judged by
// workflow id, a path write sees the integration branch's second active
// macro, the copy check holds the lock, a scan or a checkout that cannot be
// told fails closed, an aliased home gets no slot, a run id is one ledger
// across the read roots (the sweep included), and the Stop's macro list keeps
// the default state root's spelling and both homes.
describe('orchestrator: one copy by id, one active per branch, failing closed (ADR-0067 Decisions 1, 2, 4)', () => {
  let dir;
  let repo;
  let noGit;
  let failingRevParse;
  const wfDir = (root) => join(root, HOME, 'workflows');
  const slot = (root) => join(root, HOME, 'last-session-handoff.json');
  const runIn = (cwd, args, env = {}) => spawnSync(process.execPath, [ORCH_STATE, ...args], { cwd, encoding: 'utf8', env: cleanEnv(env) });
  const appendArgs = (path) => ['append', '--workflow-path', path, '--host', 'claude', '--phase-label', 'P', '--phase-note', 'u4c', '--event', 'updated'];
  const append = (path, cwd = REPO_ROOT, env = {}) => runIn(cwd, appendArgs(path), env);
  const terminal = (path) => ['set-terminal', '--workflow-path', path, '--host', 'claude', '--terminal-phase', 'finalized', '--terminal-marker', 'true', '--next-action', 'archive'];
  const asId = (text, id) => text.replace(/workflow_id: "[^"]+"/, `workflow_id: "${id}"`);
  const reset = () => {
    for (const root of [repo.main, repo.lane, repo.other]) {
      rmSync(join(root, '.agentic-plugins'), { recursive: true, force: true });
      rmSync(join(root, '.claude'), { recursive: true, force: true });
    }
  };
  const create = (checkout, branch = 'main', env = {}) => run([
    'create', '--repo-root', checkout, '--verb', 'plan', '--host', 'claude',
    '--git-baseline-branch', branch, '--git-baseline-head', repo.head, '--status-digest', DIGEST,
    '--original-request', 'orchestrator u4c fixture',
  ], env);
  const runPeerIn = async (runner, { repoRoot, runId, workflowPath }) => {
    const companions = join(dir, 'fake-companions');
    mkdirSync(companions, { recursive: true });
    writeFileSync(join(companions, 'discover-peer.mjs'),
      'export async function discoverPeerCompanion({ peer } = {}) { return { ok: true, path: new URL("./" + peer + "-companion.mjs", import.meta.url).pathname }; }\n');
    writeFileSync(join(companions, 'codex-companion.mjs'),
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ status: 'success', peer_host: 'codex', peer_model: null, stdout: 'ok', exit_code: 0 }));\n",
      { mode: 0o755 });
    return runner.runPeer({
      repoRoot, runId, kind: 'peer-now', ...(workflowPath ? { workflowPath } : {}),
      host: 'claude', peer: 'codex', promptText: '<task>u4c</task>', outputFormat: 'json', cwd: repoRoot,
      env: { ...cleanEnv(), AGENTIC_COMPANIONS_ROOT: companions },
    });
  };
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'state-root-orch-u4c-')));
    repo = makeRepo(dir);
    noGit = join(dir, 'no-git-bin');
    mkdirSync(noGit);
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    failingRevParse = join(dir, 'failing-rev-parse-bin');
    mkdirSync(failingRevParse);
    writeFileSync(join(failingRevParse, 'git'), `#!/bin/sh\nif [ "$1" = "rev-parse" ]; then exit 128; fi\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('a copy under another file name with the same workflow id refuses the write', () => {
    reset();
    const path = create(repo.main).stdout.trim();
    mkdirSync(wfDir(repo.lane), { recursive: true });
    const renamed = join(wfDir(repo.lane), 'macro-plan-20261008T000000Z-c0c0c0.md');
    writeFileSync(renamed, readFileSync(path, 'utf8'));
    const refused = append(path);
    strictEqual(refused.status, 1);
    match(refused.stderr, /held by 2 files/);
    ok(refused.stderr.includes(renamed), refused.stderr);
    rmSync(renamed);
    strictEqual(append(path).status, 0, 'with the copy gone, the write goes through');
  });

  it("a second active macro on the integration branch refuses a path write from a checkout that reads both", () => {
    reset();
    const path = create(repo.main).stdout.trim();
    mkdirSync(wfDir(repo.lane), { recursive: true });
    const second = join(wfDir(repo.lane), 'macro-plan-20261008T000000Z-bbbbbb.md');
    writeFileSync(second, asId(readFileSync(path, 'utf8'), 'macro-plan-20261008T000000Z-bbbbbb'));
    const fromLane = append(path, repo.lane);
    strictEqual(fromLane.status, 1);
    match(fromLane.stderr, /2 active workflows on branch "main"/);
    strictEqual(append(second, repo.main).status, 1, "the lane's macro: the read set of its root holds both");
    strictEqual(append(path, repo.main).status, 0, 'the main checkout reads one');
  });

  it('the copy check runs holding the lock: a copy made while the writer waits refuses it', async () => {
    reset();
    const path = create(repo.main).stdout.trim();
    const lock = `${path}.lock`;
    writeFileSync(lock, `${process.pid}:held-by-the-test`);
    const waiting = runAsync(appendArgs(path));
    await new Promise((r) => setTimeout(r, 1000));
    mkdirSync(wfDir(repo.lane), { recursive: true });
    writeFileSync(join(wfDir(repo.lane), basename(path)), readFileSync(path, 'utf8'));
    rmSync(lock);
    const waited = await waiting;
    strictEqual(waited.status, 1, 'the copy that appeared while it waited refuses the write');
    match(waited.stderr, /held by 2 files/);
  });

  it('worktrees git cannot list refuse a write and a create', () => {
    reset();
    const path = create(repo.main).stdout.trim();
    const write = append(path, REPO_ROOT, { PATH: noGit });
    strictEqual(write.status, 1);
    match(write.stderr, /Cannot list the other worktrees/);
    const made = create(repo.main, 'feat/z', { PATH: noGit });
    strictEqual(made.status, 1);
    match(made.stderr, /Cannot list the other worktrees/);
    strictEqual(append(path).status, 0, 'control: with git, the write goes through');
  });

  it("a checkout that cannot be told writes no handoff slot, rather than the storage root's", () => {
    reset();
    const path = create(repo.main).stdout.trim();
    const done = runIn(repo.lane, terminal(path), { PATH: failingRevParse });
    strictEqual(done.status, 0, done.stderr);
    match(done.stderr, /handoff slot not written/);
    ok(!existsSync(slot(repo.main)), "not the storage root's slot");
    ok(!existsSync(slot(repo.lane)));
  });

  it("a home linked to another checkout's gets no handoff slot: it would be that checkout's", () => {
    reset();
    const path = create(repo.main).stdout.trim();
    mkdirSync(join(repo.lane, '.agentic-plugins/state'), { recursive: true });
    symlinkSync(join(repo.main, HOME), join(repo.lane, HOME));
    const done = runIn(repo.lane, terminal(path));
    strictEqual(done.status, 0, done.stderr);
    match(done.stderr, /handoff slot not written: .* is a symbolic link/);
    ok(!existsSync(slot(repo.main)), "the main checkout's slot is untouched");
  });

  it('a new run refuses a run id another read root holds, and the sweep leaves one two directories hold alone', async () => {
    reset();
    create(repo.main);
    const runner = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/peer-runner.mjs')).href);
    const runId = 'peer-now-20261008T000000Z-u4c001';
    await runPeerIn(runner, { repoRoot: repo.main, runId });
    const inMain = join(repo.main, HOME, 'peer-runs', runId);
    const inLane = join(repo.lane, HOME, 'peer-runs', runId);
    ok(existsSync(inMain));
    let refused = null;
    try {
      await runPeerIn(runner, { repoRoot: repo.lane, runId });
    } catch (err) {
      refused = err;
    }
    ok(refused && /already exists/.test(refused.message), String(refused));
    ok(!existsSync(inLane), 'no second ledger in the lane');
    cpSync(inMain, inLane, { recursive: true });
    const later = new Date('2031-01-01T00:00:00Z');
    const report = await runner.sweepPeerRuns({ repoRoot: repo.lane, applyRetention: true, now: later });
    deepStrictEqual(report.ambiguous.map((a) => a.run_id), [runId]);
    deepStrictEqual(report.pruned, []);
    ok(existsSync(inMain) && existsSync(inLane), 'neither copy was touched');
    strictEqual(report.root, join(repo.lane, HOME, 'peer-runs'), "the checkout's own directory");
    strictEqual(report.retention_applied, true);
    rmSync(join(repo.lane, HOME, 'peer-runs'), { recursive: true });
    const again = await runner.sweepPeerRuns({ repoRoot: repo.lane, applyRetention: true, now: later });
    deepStrictEqual(again.pruned.map((p) => p.run_id), [runId], 'control: one copy is swept as before');
    strictEqual(again.retention_applied, true, "retention ran, though the lane's own directory is missing");
  });

  it('a peer-run directory that cannot be judged is not read as absent', { skip: typeof process.getuid === 'function' && process.getuid() === 0 && 'root reads any directory' }, async () => {
    reset();
    create(repo.main);
    const runner = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/peer-runner.mjs')).href);
    const runId = 'peer-now-20261008T000000Z-u4c002';
    const peerRuns = join(repo.main, HOME, 'peer-runs');
    mkdirSync(join(peerRuns, runId), { recursive: true });
    // No search permission: the run directory cannot be lstat'ed.
    execFileSync('chmod', ['000', peerRuns]);
    let refused = null;
    try {
      await runner.statusPeerRun({ repoRoot: repo.lane, runId });
    } catch (err) {
      refused = err;
    } finally {
      execFileSync('chmod', ['755', peerRuns]);
    }
    ok(refused && /cannot tell whether/.test(refused.message), String(refused));
  });

  it("the Stop's macro list keeps the default state root's spelling of a file reached twice", async () => {
    reset();
    const path = create(repo.main).stdout.trim();
    mkdirSync(join(repo.lane, '.agentic-plugins/state'), { recursive: true });
    symlinkSync(join(repo.main, HOME), join(repo.lane, HOME));
    const { listAllMacros } = await import(pathToFileURL(ORCH_STATE).href);
    deepStrictEqual(await listAllMacros(repo.lane), [path]);
  });

  it("the Stop's macro list keeps an active legacy macro while the canonical home holds only archive", async () => {
    reset();
    const path = create(repo.main).stdout.trim();
    const legacy = join(repo.main, '.claude/agentic-orchestrator/workflows');
    mkdirSync(legacy, { recursive: true });
    const moved = join(legacy, basename(path));
    writeFileSync(moved, readFileSync(path, 'utf8'));
    rmSync(path);
    mkdirSync(join(repo.main, HOME, 'archive'), { recursive: true });
    writeFileSync(join(repo.main, HOME, 'archive', 'macro-plan-20261001T000000Z-a0a0a0.md'), '---\nworkflow_id: "macro-plan-20261001T000000Z-a0a0a0"\n---\n');
    const { listAllMacros } = await import(pathToFileURL(ORCH_STATE).href);
    deepStrictEqual(await listAllMacros(repo.main), [moved]);
  });
});

// U4d — the third Plan-verify's findings on orchestrator: one macro reached
// through two names is one macro, the Stop judges the checkout it is given,
// an aliased slot is neither read nor consumed, one identity rule for run
// directories, and the sweep's own directory.
describe("orchestrator: the writers judge the caller's checkout and one file once (ADR-0067 Decisions 1, 2, 4)", () => {
  let dir;
  let repo;
  const wfDir = (root) => join(root, HOME, 'workflows');
  const slot = (root) => join(root, HOME, 'last-session-handoff.json');
  const runIn = (cwd, args, env = {}) => spawnSync(process.execPath, [ORCH_STATE, ...args], { cwd, encoding: 'utf8', env: cleanEnv(env) });
  const appendArgs = (path) => ['append', '--workflow-path', path, '--host', 'claude', '--phase-label', 'P', '--phase-note', 'u4d', '--event', 'updated'];
  const terminal = (path) => ['set-terminal', '--workflow-path', path, '--host', 'claude', '--terminal-phase', 'finalized', '--terminal-marker', 'true', '--next-action', 'archive'];
  const asId = (text, id) => text.replace(/workflow_id: "[^"]+"/, `workflow_id: "${id}"`);
  const peerRunner = () => import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/peer-runner.mjs')).href);
  const reset = () => {
    for (const root of [repo.main, repo.lane, repo.other]) {
      rmSync(join(root, '.agentic-plugins'), { recursive: true, force: true });
      rmSync(join(root, '.claude'), { recursive: true, force: true });
    }
  };
  const create = (checkout, branch = 'main') => run([
    'create', '--repo-root', checkout, '--verb', 'plan', '--host', 'claude',
    '--git-baseline-branch', branch, '--git-baseline-head', repo.head, '--status-digest', DIGEST,
    '--original-request', 'orchestrator u4d fixture',
  ]);
  const runPeerIn = async (runner, { repoRoot, runId }) => {
    const companions = join(dir, 'fake-companions');
    mkdirSync(companions, { recursive: true });
    writeFileSync(join(companions, 'discover-peer.mjs'),
      'export async function discoverPeerCompanion({ peer } = {}) { return { ok: true, path: new URL("./" + peer + "-companion.mjs", import.meta.url).pathname }; }\n');
    writeFileSync(join(companions, 'codex-companion.mjs'),
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ status: 'success', peer_host: 'codex', peer_model: null, stdout: 'ok', exit_code: 0 }));\n",
      { mode: 0o755 });
    return runner.runPeer({
      repoRoot, runId, kind: 'peer-now', host: 'claude', peer: 'codex', promptText: '<task>u4d</task>',
      outputFormat: 'json', cwd: repoRoot, env: { ...cleanEnv(), AGENTIC_COMPANIONS_ROOT: companions },
    });
  };
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'state-root-orch-u4d-')));
    repo = makeRepo(dir);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('one macro reached through two names in its home is one macro: found and written', () => {
    reset();
    const path = create(repo.main).stdout.trim();
    symlinkSync(path, join(wfDir(repo.main), 'macro-plan-20261008T000000Z-a1a5ed.md'));
    const found = run(['find-active', '--repo-root', repo.main, '--branch', 'main']);
    strictEqual(found.status, 0, found.stderr);
    strictEqual(found.stdout.trim(), path, 'the file itself, not the link');
    strictEqual(runIn(repo.lane, appendArgs(path)).status, 0);
  });

  it("the Stop judges the checkout it is given, not the process's working directory", () => {
    reset();
    const path = create(repo.main).stdout.trim();
    mkdirSync(wfDir(repo.lane), { recursive: true });
    writeFileSync(join(wfDir(repo.lane), 'macro-plan-20261008T000000Z-d4d4d4.md'), asId(readFileSync(path, 'utf8'), 'macro-plan-20261008T000000Z-d4d4d4'));
    const probe = [
      `const { runMacroStopArchiveAll } = await import(${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/stop-archive.mjs')).href)});`,
      `await runMacroStopArchiveAll({ repoRoot: ${JSON.stringify(repo.lane)}, host: 'claude', statusDigest: ${JSON.stringify(DIGEST)} });`,
    ].join('\n');
    // The process runs outside every repository: only the checkout the call
    // names puts the lane's read set, and the second macro, in view.
    const stop = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: dir, encoding: 'utf8', env: cleanEnv() });
    strictEqual(stop.status, 0, stop.stderr);
    ok(!/event: "snapshot"/.test(readFileSync(path, 'utf8')), `no snapshot was written: ${stop.stderr}`);
  });

  it("a slot under a home linked to another checkout's is neither read nor consumed", async () => {
    reset();
    const path = create(repo.main).stdout.trim();
    strictEqual(runIn(repo.main, terminal(path)).status, 0);
    ok(existsSync(slot(repo.main)), "the main checkout's slot");
    mkdirSync(join(repo.lane, '.agentic-plugins/state'), { recursive: true });
    symlinkSync(join(repo.main, HOME), join(repo.lane, HOME));
    const handoff = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/session-handoff.mjs')).href);
    strictEqual(await handoff.readPendingHandoff(repo.lane), null);
    await handoff.consumePendingHandoff(slot(repo.lane), repo.lane);
    ok(existsSync(slot(repo.main)), 'the slot is still there');
    for (const host of ['claude', 'codex']) {
      const hook = join(REPO_ROOT, `plugins/orchestrator/adapters/${host}/hooks/session-start.mjs`);
      const ran = spawnSync(process.execPath, [hook], { cwd: repo.lane, input: JSON.stringify({ cwd: repo.lane }), encoding: 'utf8', env: cleanEnv() });
      strictEqual(ran.status, 0, ran.stderr);
      ok(!ran.stdout.includes('[orchestrator-handoff-pending]'), ran.stdout);
      ok(existsSync(slot(repo.main)), `the ${host} SessionStart in the lane left the main checkout's slot`);
    }
    strictEqual((await handoff.readPendingHandoff(repo.main))?.projectionFile, slot(repo.main), 'control: the main checkout reads its own');
  });

  it('a link in a peer-runs directory is no ledger, whatever it names: the sweep reads the directories alone', async () => {
    reset();
    create(repo.main);
    const runner = await peerRunner();
    const runId = 'peer-now-20261008T000000Z-u4d006';
    await runPeerIn(runner, { repoRoot: repo.main, runId });
    const inMain = join(repo.main, HOME, 'peer-runs', runId);
    const laneRuns = join(repo.lane, HOME, 'peer-runs');
    mkdirSync(laneRuns, { recursive: true });
    const elsewhere = join(dir, 'ledger-copy');
    rmSync(elsewhere, { recursive: true, force: true });
    cpSync(inMain, elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(laneRuns, runId));
    const later = new Date('2031-01-01T00:00:00Z');
    const preview = await runner.sweepPeerRuns({ repoRoot: repo.lane, now: later });
    deepStrictEqual(preview.ambiguous, [], 'a link to a copy is no second ledger');
    strictEqual(preview.scanned, 1, 'the directory alone');
    strictEqual((await runner.statusPeerRun({ repoRoot: repo.lane, runId })).run_id, runId, 'status reads one ledger');
    unlinkSync(join(laneRuns, runId));
    symlinkSync(inMain, join(laneRuns, runId));
    const again = await runner.sweepPeerRuns({ repoRoot: repo.lane, applyRetention: true, now: later });
    deepStrictEqual(again.ambiguous, []);
    strictEqual(again.scanned, 1, 'the directory, once');
    deepStrictEqual(again.pruned.map((p) => p.run_id), [runId]);
    ok(!existsSync(inMain) && existsSync(join(elsewhere, 'handle.json')), 'the directory is pruned; what the first link named is left alone');
  });

  it("the sweep reports the checkout's own directory when it is linked to another root's", async () => {
    reset();
    create(repo.main);
    const runner = await peerRunner();
    await runPeerIn(runner, { repoRoot: repo.main, runId: 'peer-now-20261008T000000Z-u4d007' });
    mkdirSync(join(repo.lane, HOME), { recursive: true });
    symlinkSync(join(repo.main, HOME, 'peer-runs'), join(repo.lane, HOME, 'peer-runs'));
    const report = await runner.sweepPeerRuns({ repoRoot: repo.lane });
    strictEqual(report.root, join(repo.lane, HOME, 'peer-runs'));
  });
});

describe('orchestrator: every --repo-root command judges that checkout, and one rule for every listing (ADR-0067 Decisions 1, 2, 4)', () => {
  let dir;
  let repo;
  const wfDir = (root) => join(root, HOME, 'workflows');
  const runIn = (cwd, args, env = {}, timeout = undefined) => spawnSync(process.execPath, [ORCH_STATE, ...args], { cwd, encoding: 'utf8', env: cleanEnv(env), timeout });
  const appendArgs = (path) => ['append', '--workflow-path', path, '--host', 'claude', '--phase-label', 'P', '--phase-note', 'u4e', '--event', 'updated'];
  const terminal = (path) => ['set-terminal', '--workflow-path', path, '--host', 'claude', '--terminal-phase', 'finalized', '--terminal-marker', 'true', '--next-action', 'archive'];
  const asId = (text, id) => text.replace(/workflow_id: "[^"]+"/, `workflow_id: "${id}"`);
  const runnerCli = join(REPO_ROOT, 'plugins/orchestrator/scripts/peer-runner.mjs');
  const reset = () => {
    for (const root of [repo.main, repo.lane, repo.other]) {
      rmSync(join(root, '.agentic-plugins'), { recursive: true, force: true });
      rmSync(join(root, '.claude'), { recursive: true, force: true });
    }
  };
  const create = (checkout, branch = 'main') => run([
    'create', '--repo-root', checkout, '--verb', 'plan', '--host', 'claude',
    '--git-baseline-branch', branch, '--git-baseline-head', repo.head, '--status-digest', DIGEST,
    '--original-request', 'orchestrator u4e fixture',
  ]);
  const plantSecond = (path, id) => {
    mkdirSync(wfDir(repo.lane), { recursive: true });
    writeFileSync(join(wfDir(repo.lane), `${id}.md`), asId(readFileSync(path, 'utf8'), id));
  };
  // A fake companion; with `marker`, each call appends a line to it.
  const companions = (marker = null) => {
    const at = join(dir, marker ? 'marking-companions' : 'fake-companions');
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, 'discover-peer.mjs'),
      'export async function discoverPeerCompanion({ peer } = {}) { return { ok: true, path: new URL("./" + peer + "-companion.mjs", import.meta.url).pathname }; }\n');
    const mark = marker ? `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, 'called\\n');\n` : '';
    writeFileSync(join(at, 'codex-companion.mjs'),
      `#!/usr/bin/env node\n${mark}process.stdout.write(JSON.stringify({ status: 'success', peer_host: 'codex', peer_model: null, stdout: 'ok', exit_code: 0 }));\n`,
      { mode: 0o755 });
    return at;
  };
  const plan = (macroPath, subtasks) => {
    const at = join(dir, `subtasks-${basename(macroPath)}.json`);
    writeFileSync(at, JSON.stringify(subtasks));
    const r = run(['plan-set', '--workflow-path', macroPath, '--host', 'claude', '--subtasks-json-file', at]);
    strictEqual(r.status, 0, r.stderr);
  };
  const peerNow = async (runner, runId, root = repo.main) => runner.runPeer({
    repoRoot: root, runId, kind: 'peer-now', host: 'claude', peer: 'codex', promptText: '<task>u4f</task>',
    outputFormat: 'json', cwd: root, env: { ...cleanEnv(), AGENTIC_COMPANIONS_ROOT: companions() },
  });
  const later = new Date('2031-01-01T00:00:00Z');
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'state-root-orch-u4e-')));
    repo = makeRepo(dir);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('archive --repo-root <lane>, run from outside every repository, judges the lane: a second macro there refuses', () => {
    reset();
    const path = create(repo.main).stdout.trim();
    strictEqual(runIn(repo.main, terminal(path)).status, 0);
    plantSecond(path, 'macro-plan-20261008T000000Z-e4e001');
    const archive = (checkout) => runIn(dir, ['archive', '--workflow-path', path, '--host', 'claude', '--repo-root', checkout]);
    const refused = archive(repo.lane);
    notStrictEqual(refused.status, 0, refused.stdout);
    match(refused.stderr, /2 active workflows on branch "main"/);
    ok(existsSync(path), 'not archived');
    const control = archive(repo.main);
    strictEqual(control.status, 0, `control: the main checkout's read set holds one (${control.stderr})`);
    ok(!existsSync(path), 'archived from the main checkout');
  });

  it('peer-runner run --repo-root <lane>, run from outside every repository, is refused beside a second macro: no ledger, no companion call', () => {
    reset();
    const path = create(repo.main).stdout.trim();
    plantSecond(path, 'macro-plan-20261008T000000Z-e4e002');
    const marker = join(dir, 'companion-called');
    rmSync(marker, { force: true });
    const launch = (checkout, runId) => spawnSync(process.execPath, [
      runnerCli, 'run', '--repo-root', checkout, '--kind', 'ensemble', '--peer', 'codex', '--prompt-text', '<task>u4e</task>',
      '--workflow-path', path, '--phase', 'plan', '--ensemble-type', 'plan-verify', '--run-id', runId,
      '--host', 'claude', '--cwd', checkout, '--output-format', 'json',
    ], { cwd: dir, encoding: 'utf8', env: cleanEnv({ AGENTIC_COMPANIONS_ROOT: companions(marker) }) });
    // The write guard is asked before the run: a refusal leaves no ledger and
    // calls no companion (a registration failing later, under the lock,
    // keeps the runner's continuation).
    const runId = 'plan-verify-20261008T000000Z-e4e002';
    const refused = launch(repo.lane, runId);
    notStrictEqual(refused.status, 0, refused.stdout);
    match(refused.stderr, /2 active workflows on branch "main"/);
    ok(!/pending registration failed/.test(refused.stderr), 'refused before the run, not after');
    for (const root of [repo.main, repo.lane, repo.other]) ok(!existsSync(join(root, HOME, 'peer-runs', runId)), `no ledger in ${root}`);
    ok(!existsSync(marker), 'no companion called');
    ok(!readFileSync(path, 'utf8').includes(runId), 'no pending row');
    const control = launch(repo.main, 'plan-verify-20261008T000000Z-e4e012');
    strictEqual(control.status, 0, `control: ${control.stderr}`);
    ok(existsSync(marker), 'control: the companion called');
    ok(readFileSync(path, 'utf8').includes('plan-verify-20261008T000000Z-e4e012'), 'the pending row, from the main checkout');
  });

  it('a link in place of a run directory is no ledger: the sweep neither reconciles nor prunes through it, as runtime reads it', async () => {
    reset();
    create(repo.main);
    const runner = await import(pathToFileURL(runnerCli).href);
    const runId = 'peer-now-20261008T000000Z-e4e003';
    await runner.runPeer({
      repoRoot: repo.main, runId, kind: 'peer-now', host: 'claude', peer: 'codex', promptText: '<task>u4e</task>',
      outputFormat: 'json', cwd: repo.main, env: { ...cleanEnv(), AGENTIC_COMPANIONS_ROOT: companions() },
    });
    const inHome = join(repo.main, HOME, 'peer-runs', runId);
    const elsewhere = join(dir, 'linked-ledger');
    rmSync(elsewhere, { recursive: true, force: true });
    cpSync(inHome, elsewhere, { recursive: true });
    rmSync(inHome, { recursive: true, force: true });
    symlinkSync(elsewhere, inHome);
    // A handle left running beside its envelope: reconciled through the link.
    const handleFile = join(elsewhere, 'handle.json');
    const handle = JSON.parse(readFileSync(handleFile, 'utf8'));
    writeFileSync(handleFile, `${JSON.stringify({ ...handle, status: 'running', completed_at: null }, null, 2)}\n`);
    ok(existsSync(join(elsewhere, 'envelope.json')), 'the envelope is there');
    const report = await runner.sweepPeerRuns({ repoRoot: repo.main, applyRetention: true, now: new Date('2031-01-01T00:00:00Z') });
    strictEqual(report.scanned, 0, 'no ledger read through the link');
    deepStrictEqual([report.reconciled, report.planned_prunes, report.pruned], [[], [], []]);
    strictEqual(JSON.parse(readFileSync(handleFile, 'utf8')).status, 'running', 'what the link names is not written');
    ok(existsSync(join(elsewhere, 'handle.json')), 'and not deleted');
    // Control: the same ledger as a directory is reconciled.
    unlinkSync(inHome);
    cpSync(elsewhere, inHome, { recursive: true });
    const control = await runner.sweepPeerRuns({ repoRoot: repo.main, now: new Date('2031-01-01T00:00:00Z') });
    deepStrictEqual(control.reconciled, [{ run_id: runId, from: 'running', to: 'completed' }]);
  });

  it('a FIFO in a home of the read set refuses the branch scan and find-macro at once, never waited on', () => {
    reset();
    const path = create(repo.main).stdout.trim();
    plan(path, [{ id: 'T1', verb: 'compose', branch: 'feat/x', blocked_by: [], status: 'pending' }]);
    mkdirSync(wfDir(repo.lane), { recursive: true });
    const fifo = join(wfDir(repo.lane), 'macro-plan-20261008T000000Z-f1f0e4.md');
    execFileSync('mkfifo', [fifo]);
    const found = runIn(repo.lane, ['find-active', '--repo-root', repo.lane, '--branch', 'main'], {}, 20_000);
    strictEqual(found.error?.code, undefined, 'find-active: not waited on');
    strictEqual(found.status, 1, found.stderr);
    match(found.stderr, /not a regular file/);
    const macro = runIn(repo.lane, ['find-macro', '--repo-root', repo.lane, '--subtask-branch', 'feat/x'], {}, 20_000);
    strictEqual(macro.error?.code, undefined, 'find-macro: not waited on');
    strictEqual(macro.status, 1, macro.stderr);
    match(macro.stderr, /not a regular file/);
    rmSync(fifo);
    strictEqual(runIn(repo.lane, ['find-macro', '--repo-root', repo.lane, '--subtask-branch', 'feat/x']).stdout.trim(), path, 'control');
  });

  it('a macro reached through two read roots is handed to a writer under the name that is not a link', () => {
    reset();
    const path = create(repo.lane).stdout.trim();
    ok(path.startsWith(join(repo.lane, HOME)), path);
    mkdirSync(wfDir(repo.main), { recursive: true });
    symlinkSync(path, join(wfDir(repo.main), basename(path)));
    const found = runIn(repo.lane, ['find-active', '--repo-root', repo.lane, '--branch', 'main']);
    strictEqual(found.status, 0, found.stderr);
    strictEqual(found.stdout.trim(), path, "the lane's file, not the main checkout's link");
    strictEqual(runIn(repo.lane, appendArgs(found.stdout.trim())).status, 0);
    // find-macro and resolve-workflow, through the shared lister, likewise.
    plan(path, [{ id: 'T1', verb: 'compose', branch: 'feat/z', blocked_by: [], status: 'pending' }]);
    strictEqual(runIn(repo.lane, ['find-macro', '--repo-root', repo.lane, '--subtask-branch', 'feat/z']).stdout.trim(), path, 'find-macro');
    const resolved = runIn(repo.lane, ['resolve-workflow', '--repo-root', repo.lane, '--workflow-id', basename(path, '.md')]);
    strictEqual(resolved.status, 0, resolved.stderr);
    strictEqual(resolved.stdout.trim(), path, 'resolve-workflow');
  });

  // U4f — the fifth Plan-verify's findings.
  it('an explicit --repo-root that names no checkout of the repository reads every root of it: a second macro anywhere refuses', () => {
    reset();
    const path = create(repo.main).stdout.trim();
    strictEqual(runIn(repo.main, terminal(path)).status, 0);
    plantSecond(path, 'macro-plan-20261008T000000Z-f4f001');
    const elsewhere = join(dir, 'another-repository');
    if (!existsSync(elsewhere)) {
      mkdirSync(elsewhere);
      git(elsewhere, 'init', '-q', '-b', 'main');
    }
    const unrelated = join(dir, 'unrelated-directory');
    mkdirSync(unrelated, { recursive: true });
    const archive = (named) => runIn(repo.lane, ['archive', '--workflow-path', path, '--host', 'claude', '--repo-root', named]);
    for (const named of [unrelated, join(dir, 'no-such-directory'), elsewhere]) {
      const refused = archive(named);
      notStrictEqual(refused.status, 0, `${named}: ${refused.stdout}`);
      match(refused.stderr, /2 active workflows on branch "main"/);
      ok(existsSync(path), 'not archived');
    }
    const control = archive(repo.main);
    strictEqual(control.status, 0, `control: ${control.stderr}`);
    ok(!existsSync(path));
  });

  it('a link beside a ledger is no second name: the sweep reads and prunes the directory itself', async () => {
    reset();
    create(repo.main);
    const runner = await import(pathToFileURL(runnerCli).href);
    const runId = 'peer-now-20261008T000000Z-f4f003';
    await peerNow(runner, runId);
    const mainRuns = join(repo.main, HOME, 'peer-runs');
    const laneRuns = join(repo.lane, HOME, 'peer-runs');
    mkdirSync(laneRuns, { recursive: true });
    renameSync(join(mainRuns, runId), join(laneRuns, runId));
    symlinkSync(join(laneRuns, runId), join(mainRuns, runId));
    const report = await runner.sweepPeerRuns({ repoRoot: repo.lane, applyRetention: true, now: later });
    strictEqual(report.scanned, 1);
    deepStrictEqual(report.prune_skipped, []);
    deepStrictEqual(report.pruned.map((p) => p.run_id), [runId], 'swept through the directory itself, so retention runs');
    ok(!existsSync(join(laneRuns, runId)));
    const second = 'peer-now-20261008T000000Z-f4f013';
    await peerNow(runner, second);
    symlinkSync(join(mainRuns, second), join(mainRuns, 'A alias'));
    const preview = await runner.sweepPeerRuns({ repoRoot: repo.main, now: later });
    strictEqual(preview.scanned, 1);
    deepStrictEqual(preview.planned_prunes.map((p) => p.run_id), [second]);
  });

  it('a run id two ledgers hold is swept in neither, a link beside them notwithstanding', async () => {
    reset();
    create(repo.main);
    const runner = await import(pathToFileURL(runnerCli).href);
    const runId = 'peer-now-20261008T000000Z-f4f004';
    await peerNow(runner, runId);
    const inMain = join(repo.main, HOME, 'peer-runs', runId);
    const laneRuns = join(repo.lane, HOME, 'peer-runs');
    mkdirSync(laneRuns, { recursive: true });
    cpSync(inMain, join(laneRuns, runId), { recursive: true });
    symlinkSync(inMain, join(laneRuns, 'peer-now-20261008T000000Z-f4f0a1'));
    const report = await runner.sweepPeerRuns({ repoRoot: repo.lane, applyRetention: true, now: later });
    deepStrictEqual(report.ambiguous.map((a) => a.run_id), [runId]);
    strictEqual(report.scanned, 0, 'neither ledger, under any name');
    deepStrictEqual(report.planned_prunes, []);
  });

  it('a link to a file under a run id is no ledger: the id is free, as every listing says', async () => {
    reset();
    create(repo.main);
    const runner = await import(pathToFileURL(runnerCli).href);
    const runId = 'peer-now-20261008T000000Z-f4f008';
    const laneRuns = join(repo.lane, HOME, 'peer-runs');
    mkdirSync(laneRuns, { recursive: true });
    const notLedger = join(dir, 'not-a-ledger');
    writeFileSync(notLedger, 'x');
    symlinkSync(notLedger, join(laneRuns, runId));
    await peerNow(runner, runId);
    ok(existsSync(join(repo.main, HOME, 'peer-runs', runId, 'handle.json')));
    strictEqual((await runner.statusPeerRun({ repoRoot: repo.lane, runId })).run_id, runId, 'read from the lane: one ledger');
  });

  it('peer-runner --repo-root with no path is a usage error, not a crash', () => {
    const ran = spawnSync(process.execPath, [runnerCli, 'status', '--run-id', 'peer-now-20261008T000000Z-f4f011', '--repo-root'], { cwd: dir, encoding: 'utf8', env: cleanEnv() });
    strictEqual(ran.status, 2, ran.stderr);
    match(ran.stderr, /--repo-root needs a path/);
    ok(!/\n\s+at /.test(ran.stderr), `no stack: ${ran.stderr}`);
  });

  // U4g — the sixth Plan-verify's findings.
  // Calls `action` once, when fs.lstatSync is asked about `target` for the
  // `nth` time (before that call, or with `after` once it returned): a seam
  // between a sweep's plan and its changes.
  const onLstat = (target, nth, action, { after = false } = {}) => {
    const real = nodeFs.lstatSync;
    let calls = 0;
    nodeFs.lstatSync = function lstatSync(p, ...rest) {
      const hit = String(p) === target && ++calls === nth;
      if (hit && !after) action();
      const out = real.call(this, p, ...rest);
      if (hit && after) action();
      return out;
    };
    return () => { nodeFs.lstatSync = real; };
  };

  it('the sweep deletes only the ledger it planned: one recreated under its run id since the plan is kept', async () => {
    reset();
    create(repo.main);
    const runner = await import(pathToFileURL(runnerCli).href);
    const runId = 'peer-now-20261008T000000Z-a4a001';
    await peerNow(runner, runId);
    const runDir = join(repo.main, HOME, 'peer-runs', runId);
    const handle = JSON.parse(readFileSync(join(runDir, 'handle.json'), 'utf8'));
    // Once the plan has taken the ledger's identity (its second lstat).
    const restore = onLstat(runDir, 2, () => {
      rmSync(runDir, { recursive: true, force: true });
      mkdirSync(runDir);
      const fresh = { ...handle, started_at: '2031-01-01T00:00:00.000Z', updated_at: '2031-01-01T00:00:01.000Z', completed_at: '2031-01-01T00:00:01.000Z' };
      writeFileSync(join(runDir, 'handle.json'), `${JSON.stringify(fresh, null, 2)}\n`);
    }, { after: true });
    let report;
    try {
      report = await runner.sweepPeerRuns({ repoRoot: repo.main, applyRetention: true, now: later, retentionTtlDays: 0 });
    } finally {
      restore();
    }
    deepStrictEqual(report.prune_skipped, [{ run_id: runId, reason: 'replaced' }]);
    deepStrictEqual(report.pruned, []);
    ok(existsSync(join(runDir, 'handle.json')), 'the recreated ledger is kept');
    const again = await runner.sweepPeerRuns({ repoRoot: repo.main, applyRetention: true, now: new Date('2032-01-01T00:00:00Z'), retentionTtlDays: 0 });
    deepStrictEqual(again.pruned.map((p) => p.run_id), [runId], 'control: planned anew, it is pruned');
  });

  it('the sweep checks its selection again before each change: a second ledger made meanwhile leaves both', async () => {
    reset();
    create(repo.main);
    const runner = await import(pathToFileURL(runnerCli).href);
    const runId = 'peer-now-20261008T000000Z-a4a002';
    await peerNow(runner, runId);
    const runDir = join(repo.main, HOME, 'peer-runs', runId);
    const inLane = join(repo.lane, HOME, 'peer-runs', runId);
    const copy = join(dir, 'planned-copy');
    rmSync(copy, { recursive: true, force: true });
    cpSync(runDir, copy, { recursive: true });
    // The fourth lstat of the run directory is the last check, made once the
    // prune has claimed the directory it judges (U4j).
    const restore = onLstat(runDir, 4, () => {
      mkdirSync(dirname(inLane), { recursive: true });
      cpSync(copy, inLane, { recursive: true });
    });
    let report;
    try {
      report = await runner.sweepPeerRuns({ repoRoot: repo.lane, applyRetention: true, now: later, retentionTtlDays: 0 });
    } finally {
      restore();
    }
    deepStrictEqual(report.prune_skipped, [{ run_id: runId, reason: 'ambiguous' }]);
    deepStrictEqual(report.pruned, []);
    deepStrictEqual(report.ambiguous.map((a) => a.run_id), [runId]);
    ok(existsSync(join(runDir, 'handle.json')) && existsSync(join(inLane, 'handle.json')), 'neither ledger was deleted');
  });

  it('a second ledger made in an empty legacy home since the plan is seen right before the deletion', async () => {
    reset();
    create(repo.main);
    const runner = await import(pathToFileURL(runnerCli).href);
    const runId = 'peer-now-20261008T000000Z-a4b001';
    await peerNow(runner, runId);
    const runDir = join(repo.main, HOME, 'peer-runs', runId);
    const inLegacy = join(repo.main, '.claude/agentic-orchestrator/peer-runs', runId);
    // Once the prune has read the handle and the identity (the third lstat),
    // before its last check.
    const restore = onLstat(runDir, 3, () => {
      mkdirSync(dirname(inLegacy), { recursive: true });
      cpSync(runDir, inLegacy, { recursive: true });
    }, { after: true });
    let report;
    try {
      report = await runner.sweepPeerRuns({ repoRoot: repo.main, applyRetention: true, now: later, retentionTtlDays: 0 });
    } finally {
      restore();
    }
    deepStrictEqual(report.prune_skipped, [{ run_id: runId, reason: 'ambiguous' }]);
    ok(existsSync(join(runDir, 'handle.json')) && existsSync(join(inLegacy, 'handle.json')), 'neither ledger was deleted');
  });

  it('the sweep asks again at the reconciling write: a second ledger made meanwhile leaves the handle as it is', async () => {
    reset();
    create(repo.main);
    const runner = await import(pathToFileURL(runnerCli).href);
    const runId = 'peer-now-20261008T000000Z-a4b002';
    await peerNow(runner, runId);
    const runDir = join(repo.main, HOME, 'peer-runs', runId);
    const handleFile = join(runDir, 'handle.json');
    writeFileSync(handleFile, `${JSON.stringify({ ...JSON.parse(readFileSync(handleFile, 'utf8')), status: 'running', completed_at: null }, null, 2)}\n`);
    const inLane = join(repo.lane, HOME, 'peer-runs', runId);
    const restore = onLstat(runDir, 2, () => {
      mkdirSync(dirname(inLane), { recursive: true });
      cpSync(runDir, inLane, { recursive: true });
    });
    let report;
    try {
      report = await runner.sweepPeerRuns({ repoRoot: repo.lane, now: later });
    } finally {
      restore();
    }
    deepStrictEqual(report.reconciled, []);
    strictEqual(JSON.parse(readFileSync(handleFile, 'utf8')).status, 'running', 'not written');
    deepStrictEqual(report.ambiguous.map((a) => a.run_id), [runId]);
  });

  it('a link where a run id has no ledger is refused by status, never read through', async () => {
    reset();
    create(repo.main);
    const runner = await import(pathToFileURL(runnerCli).href);
    const runId = 'peer-now-20261008T000000Z-a4b003';
    await peerNow(runner, runId);
    const inHome = join(repo.main, HOME, 'peer-runs', runId);
    const elsewhere = join(dir, 'unlisted-ledger');
    rmSync(elsewhere, { recursive: true, force: true });
    renameSync(inHome, elsewhere);
    symlinkSync(elsewhere, inHome);
    await rejects(runner.statusPeerRun({ repoRoot: repo.main, runId }), /is not a run directory/);
  });

  // U4j — the eighth Plan-verify's findings.
  const freshRunning = (runDir, handle) => {
    rmSync(runDir, { recursive: true, force: true });
    mkdirSync(runDir);
    const fresh = { ...handle, status: 'running', started_at: '2031-01-01T00:00:00.000Z', updated_at: '2031-01-01T00:00:01.000Z', completed_at: null };
    writeFileSync(join(runDir, 'handle.json'), `${JSON.stringify(fresh, null, 2)}\n`);
  };
  const claimsIn = (runs) => readdirSync(runs).filter((n) => n.includes('~prune~'));
  // As onLstat, for a call that throws (nothing there): `action` runs once
  // the nth call has thrown.
  const onLstatThrow = (target, nth, action) => {
    const real = nodeFs.lstatSync;
    let calls = 0;
    nodeFs.lstatSync = function lstatSync(p, ...rest) {
      const hit = String(p) === target && ++calls === nth;
      try {
        return real.call(this, p, ...rest);
      } finally {
        if (hit) action();
      }
    };
    return () => { nodeFs.lstatSync = real; };
  };
  const runningWithEnvelope = async (runId) => {
    const runner = await import(pathToFileURL(runnerCli).href);
    await peerNow(runner, runId);
    const runDir = join(repo.main, HOME, 'peer-runs', runId);
    const handleFile = join(runDir, 'handle.json');
    const running = { ...JSON.parse(readFileSync(handleFile, 'utf8')), status: 'running', completed_at: null };
    writeFileSync(handleFile, `${JSON.stringify(running, null, 2)}\n`);
    ok(existsSync(join(runDir, 'envelope.json')), 'the run left an envelope');
    return { runner, runDir, handleFile, running, paths: { dir: runDir, handle: handleFile, envelope: join(runDir, 'envelope.json') } };
  };

  it('the prune deletes only the directory it claimed and judged: a running ledger put in its place before the claim is put back', async () => {
    reset();
    create(repo.main);
    const runner = await import(pathToFileURL(runnerCli).href);
    const runId = 'peer-now-20261008T000000Z-a4c001';
    await peerNow(runner, runId);
    const runDir = join(repo.main, HOME, 'peer-runs', runId);
    const handle = JSON.parse(readFileSync(join(runDir, 'handle.json'), 'utf8'));
    // Right after the prune's identity check (the third lstat), before the
    // claim: a running ledger made anew under the run id.
    const restore = onLstat(runDir, 3, () => freshRunning(runDir, handle), { after: true });
    let report;
    try {
      report = await runner.sweepPeerRuns({ repoRoot: repo.main, applyRetention: true, now: later, retentionTtlDays: 0 });
    } finally {
      restore();
    }
    deepStrictEqual(report.pruned, []);
    deepStrictEqual(report.prune_skipped, [{ run_id: runId, reason: 'no-longer-terminal' }]);
    strictEqual(JSON.parse(readFileSync(join(runDir, 'handle.json'), 'utf8')).status, 'running', 'the running ledger, back under its run id');
    deepStrictEqual(claimsIn(dirname(runDir)), [], 'no claim left');
  });

  it('a ledger made under the run id while the prune judges its claim is kept, and the claimed one beside it, reported', async () => {
    reset();
    create(repo.main);
    const runner = await import(pathToFileURL(runnerCli).href);
    const runId = 'peer-now-20261008T000000Z-a4c002';
    await peerNow(runner, runId);
    const runDir = join(repo.main, HOME, 'peer-runs', runId);
    const handle = JSON.parse(readFileSync(join(runDir, 'handle.json'), 'utf8'));
    // The fourth lstat of the run directory is the last check, inside the
    // judgment of the claimed directory.
    const restore = onLstat(runDir, 4, () => freshRunning(runDir, handle));
    let report;
    try {
      report = await runner.sweepPeerRuns({ repoRoot: repo.main, applyRetention: true, now: later, retentionTtlDays: 0 });
    } finally {
      restore();
    }
    deepStrictEqual(report.pruned, []);
    strictEqual(report.prune_skipped.length, 1, JSON.stringify(report.prune_skipped));
    const [skipped] = report.prune_skipped;
    deepStrictEqual([skipped.run_id, skipped.reason], [runId, 'ambiguous']);
    strictEqual(JSON.parse(readFileSync(join(runDir, 'handle.json'), 'utf8')).status, 'running', 'the new ledger is kept');
    ok(typeof skipped.kept === 'string' && dirname(skipped.kept) === dirname(runDir), `kept under its claim name: ${skipped.kept}`);
    strictEqual(JSON.parse(readFileSync(join(skipped.kept, 'handle.json'), 'utf8')).started_at, handle.started_at, 'the planned ledger, not deleted');
    deepStrictEqual(report.ambiguous.map((a) => a.run_id), [runId]);
  });

  it('the claim is never put back over an empty directory made under the run id meanwhile: it keeps its claim name', async () => {
    reset();
    create(repo.main);
    const runner = await import(pathToFileURL(runnerCli).href);
    const runId = 'peer-now-20261008T000000Z-a4c007';
    await peerNow(runner, runId);
    const runDir = join(repo.main, HOME, 'peer-runs', runId);
    // A runner's mkdir under the run id, before its first file.
    const restore = onLstat(runDir, 4, () => mkdirSync(runDir));
    let report;
    try {
      report = await runner.sweepPeerRuns({ repoRoot: repo.main, applyRetention: true, now: later, retentionTtlDays: 0 });
    } finally {
      restore();
    }
    const [skipped] = report.prune_skipped;
    deepStrictEqual([skipped?.run_id, skipped?.reason], [runId, 'ambiguous']);
    deepStrictEqual(readdirSync(runDir), [], 'the empty directory, not replaced');
    ok(existsSync(join(skipped.kept, 'handle.json')), 'the planned ledger, under its claim name');
  });

  it('the reconciling write asks the guard again right before its rename: a refusal there leaves the handle and no temporary file', async () => {
    reset();
    create(repo.main);
    const { runner, runDir, handleFile, running, paths } = await runningWithEnvelope('peer-now-20261008T000000Z-a4c003');
    let asked = 0;
    const after = await runner.reconcileOne(paths, running, { staleGraceMs: 0, now: later, guard: () => ++asked === 1 });
    strictEqual(asked, 2, 'asked before the write, and again right before its rename');
    strictEqual(after.status, 'running', "the caller's handle");
    strictEqual(JSON.parse(readFileSync(handleFile, 'utf8')).status, 'running', 'not written');
    deepStrictEqual(readdirSync(runDir).filter((n) => n.endsWith('.tmp')), [], 'no temporary file left');
  });

  it('a guard that cannot judge the run directory propagates from the reconciling write, never recorded as a corrupt envelope', async () => {
    reset();
    create(repo.main);
    const { runner, handleFile, running, paths } = await runningWithEnvelope('peer-now-20261008T000000Z-a4c004');
    let asked = 0;
    const guard = () => {
      if (++asked === 1) throw Object.assign(new Error('cannot list the peer-runs directory (EACCES)'), { code: 'EACCES' });
      return true;
    };
    await rejects(runner.reconcileOne(paths, running, { staleGraceMs: 0, now: later, guard }), /cannot list the peer-runs directory/);
    strictEqual(JSON.parse(readFileSync(handleFile, 'utf8')).status, 'running', 'not recorded as failed/envelope_parse_error');
  });

  it('the reconciling write is bound to the ledger it read: a directory made anew under the run id meanwhile is left as it is', async () => {
    reset();
    create(repo.main);
    const { runner, runDir, handleFile, running, paths } = await runningWithEnvelope('peer-now-20261008T000000Z-a4c008');
    const fresh = { ...running, started_at: '2031-01-01T00:00:00.000Z', updated_at: '2031-01-01T00:00:01.000Z' };
    let asked = 0;
    // After the envelope was read: a running ledger made anew under the run id.
    const guard = () => {
      if (++asked === 1) {
        rmSync(runDir, { recursive: true, force: true });
        mkdirSync(runDir);
        writeFileSync(handleFile, `${JSON.stringify(fresh, null, 2)}\n`);
      }
      return true;
    };
    const after = await runner.reconcileOne(paths, running, { staleGraceMs: 0, now: later, guard });
    strictEqual(after.status, 'running', "the caller's handle");
    const disk = JSON.parse(readFileSync(handleFile, 'utf8'));
    deepStrictEqual([disk.status, disk.started_at, disk.updated_at], ['running', fresh.started_at, fresh.updated_at], 'the new ledger, untouched: not given the old run\'s result');
  });

  // U4m — the U4k review's item 7: a terminal status another command wrote
  // on the same run after the caller's read is kept, as the persona runners keep it.
  for (const withEnvelope of [true, false]) {
    it(`the reconciling write keeps a terminal status a cancel wrote after the caller's read (${withEnvelope ? 'envelope' : 'orphan'} branch)`, async () => {
      reset();
      create(repo.main);
      const { runner, handleFile, running, paths } = await runningWithEnvelope(`peer-now-20261008T000000Z-a4m00${withEnvelope ? 1 : 2}`);
      if (!withEnvelope) rmSync(paths.envelope);
      const stale = { ...running, pid: null, pgid: null, updated_at: '2020-01-01T00:00:00.000Z' };
      writeFileSync(handleFile, `${JSON.stringify(stale, null, 2)}\n`);
      let asked = 0;
      // Between the caller's read and the write: the same run, cancelled.
      const guard = () => {
        if (++asked === 1) writeFileSync(handleFile, `${JSON.stringify({ ...stale, status: 'cancelled', error_kind: 'cancelled' }, null, 2)}\n`);
        return true;
      };
      const after = await runner.reconcileOne(paths, stale, { staleGraceMs: 0, now: later, guard });
      strictEqual(asked, 2, 'asked before the write and again right before its rename: the write ran');
      strictEqual(after.status, 'cancelled', 'and returned what it wrote');
      const disk = JSON.parse(readFileSync(handleFile, 'utf8'));
      deepStrictEqual([disk.status, disk.error_kind], ['cancelled', 'cancelled'], 'the cancel, kept');
    });
  }

  // U4l — the U4j review's remaining findings (see the persona tests).
  const claimOf = async (runDir) => {
    const { claimName } = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/state-root.mjs')).href);
    return join(dirname(runDir), claimName(basename(runDir)));
  };
  const leaveClaim = async (runDir) => {
    const claim = await claimOf(runDir);
    renameSync(runDir, claim);
    return claim;
  };
  const orchRunner = () => import(pathToFileURL(runnerCli).href);

  it("a claim an interrupted prune left is its run id's ledger: status and cancel refuse it, and no run takes the run id", async () => {
    reset();
    create(repo.main);
    const runner = await orchRunner();
    const runId = 'peer-now-20261008T000000Z-a4d001';
    await peerNow(runner, runId);
    const runDir = join(repo.main, HOME, 'peer-runs', runId);
    const claim = await leaveClaim(runDir);
    await rejects(runner.statusPeerRun({ repoRoot: repo.main, runId }), /claimed by a prune/);
    await rejects(runner.cancelPeerRun({ repoRoot: repo.main, runId }), /claimed by a prune/);
    await rejects(peerNow(runner, runId), /already exists for run_id/);
    ok(!existsSync(runDir), 'no ledger made under the run id');
    ok(existsSync(join(claim, 'handle.json')), 'the claim, untouched');
  });

  it('the sweep puts back a claim an interrupted prune left once no prune can hold it, and leaves a younger one', async () => {
    reset();
    create(repo.main);
    const runner = await orchRunner();
    const runId = 'peer-now-20261008T000000Z-a4d003';
    await peerNow(runner, runId);
    const runDir = join(repo.main, HOME, 'peer-runs', runId);
    const claim = await leaveClaim(runDir);
    const young = await runner.sweepPeerRuns({ repoRoot: repo.main });
    deepStrictEqual(young.claims, [{ path: claim, run_id: null, state: 'held' }]);
    ok(existsSync(claim) && !existsSync(runDir), 'left as it is');
    const old = await runner.sweepPeerRuns({ repoRoot: repo.main, now: later });
    deepStrictEqual(old.claims, [{ path: runDir, run_id: runId, state: 'recovered' }]);
    ok(existsSync(join(runDir, 'handle.json')) && !existsSync(claim), 'back under its run id');
    strictEqual((await runner.statusPeerRun({ repoRoot: repo.main, runId })).status, 'completed', 'read again by its run id');
  });

  it('a claim whose run id another ledger holds stays, and both are left alone, as for any run id two ledgers hold', async () => {
    reset();
    create(repo.main);
    const runner = await orchRunner();
    const runId = 'peer-now-20261008T000000Z-a4d004';
    await peerNow(runner, runId);
    const runDir = join(repo.main, HOME, 'peer-runs', runId);
    const laneRuns = join(repo.lane, HOME, 'peer-runs');
    mkdirSync(laneRuns, { recursive: true });
    cpSync(runDir, join(laneRuns, runId), { recursive: true });
    const claim = await leaveClaim(runDir);
    const report = await runner.sweepPeerRuns({ repoRoot: repo.lane, applyRetention: true, now: later, retentionTtlDays: 0 });
    deepStrictEqual(report.claims, [{ path: claim, run_id: runId, state: 'kept' }]);
    deepStrictEqual(report.ambiguous.map((a) => a.run_id), [runId]);
    // Swept through neither ledger: the selection counts the claim, so the
    // lane ledger is never planned for a prune (not only refused at its claim).
    deepStrictEqual([report.planned_prunes, report.pruned], [[], []]);
    ok(existsSync(claim) && existsSync(join(laneRuns, runId)) && !existsSync(runDir), 'both left where they were');
  });

  it('a claim with no handle naming its run id is reported and left: a deletion that failed partway', async () => {
    reset();
    const runs = join(repo.main, HOME, 'peer-runs');
    const claim = await claimOf(join(runs, 'peer-now-20261008T000000Z-a4d005'));
    mkdirSync(claim, { recursive: true });
    writeFileSync(join(claim, 'stdout.log'), 'partly deleted\n');
    const runner = await orchRunner();
    const report = await runner.sweepPeerRuns({ repoRoot: repo.main, applyRetention: true, now: later });
    deepStrictEqual(report.claims, [{ path: claim, run_id: null, state: 'unreadable' }]);
    ok(existsSync(join(claim, 'stdout.log')), 'left');
  });

  it('a judgment that fails names where the claimed directory is left: under its claim name when a ledger took the run id meanwhile', async () => {
    reset();
    create(repo.main);
    const runner = await orchRunner();
    const runId = 'peer-now-20261008T000000Z-a4d006';
    await peerNow(runner, runId);
    const runDir = join(repo.main, HOME, 'peer-runs', runId);
    const handle = JSON.parse(readFileSync(join(runDir, 'handle.json'), 'utf8'));
    const claim = await claimOf(runDir);
    const real = nodeFs.lstatSync;
    nodeFs.lstatSync = function lstatSync(p, ...rest) {
      if (String(p) === claim && new Error().stack.includes('ledgerIdentity')) {
        freshRunning(runDir, handle);
        throw Object.assign(new Error(`EIO: i/o error, lstat '${p}'`), { code: 'EIO' });
      }
      return real.call(this, p, ...rest);
    };
    try {
      await rejects(
        runner.sweepPeerRuns({ repoRoot: repo.main, applyRetention: true, now: later, retentionTtlDays: 0 }),
        (error) => error.message.includes('EIO') && error.message.includes(`stays claimed at ${claim}`),
      );
    } finally {
      nodeFs.lstatSync = real;
    }
    ok(existsSync(join(claim, 'handle.json')), 'the planned ledger, under its claim name');
    strictEqual(JSON.parse(readFileSync(join(runDir, 'handle.json'), 'utf8')).status, 'running', 'the new ledger, kept');
  });

  it('a deletion that fails names the claimed directory it left partly deleted', { skip: process.getuid?.() === 0 && 'root deletes any file' }, async () => {
    reset();
    create(repo.main);
    const runner = await orchRunner();
    const runId = 'peer-now-20261008T000000Z-a4d007';
    await peerNow(runner, runId);
    const runDir = join(repo.main, HOME, 'peer-runs', runId);
    mkdirSync(join(runDir, 'locked'));
    writeFileSync(join(runDir, 'locked', 'file'), 'x');
    execFileSync('chmod', ['500', join(runDir, 'locked')]);
    const claim = await claimOf(runDir);
    try {
      await rejects(
        runner.sweepPeerRuns({ repoRoot: repo.main, applyRetention: true, now: later, retentionTtlDays: 0 }),
        (error) => error.code === 'prune-failed' && error.message.includes(`partly deleted, at ${claim}`),
      );
      ok(existsSync(claim), 'the claim stays where the error says');
    } finally {
      execFileSync('chmod', ['-R', 'u+rwX', dirname(runDir)]);
    }
  });

  it('a run id of any valid length is pruned: the claim name is bounded', async () => {
    reset();
    create(repo.main);
    const runner = await orchRunner();
    const prefix = 'peer-now-20261008T000000Z-';
    const runId = `${prefix}${'a'.repeat(250 - prefix.length)}`;
    await peerNow(runner, runId);
    const report = await runner.sweepPeerRuns({ repoRoot: repo.main, applyRetention: true, now: later, retentionTtlDays: 0 });
    deepStrictEqual(report.pruned.map((p) => p.run_id), [runId]);
    deepStrictEqual(claimsIn(join(repo.main, HOME, 'peer-runs')), [], 'no claim left');
  });

  it('a link made where a run id has no ledger, right after the look, is never read through: status and cancel report no ledger', async () => {
    reset();
    create(repo.main);
    const runner = await import(pathToFileURL(runnerCli).href);
    const runId = 'peer-now-20261008T000000Z-a4c005';
    await peerNow(runner, runId);
    const inHome = join(repo.main, HOME, 'peer-runs', runId);
    const elsewhere = join(dir, 'unlisted-ledger-j');
    rmSync(elsewhere, { recursive: true, force: true });
    renameSync(inHome, elsewhere);
    for (const read of [() => runner.statusPeerRun({ repoRoot: repo.main, runId }), () => runner.cancelPeerRun({ repoRoot: repo.main, runId })]) {
      // The lookup asks each home (the first lstat of this path), then looks
      // at the fallback path itself (the second): the link comes after that.
      const restore = onLstatThrow(inHome, 2, () => symlinkSync(elsewhere, inHome));
      try {
        await rejects(read(), /no peer-run ledger for run_id/);
      } finally {
        restore();
      }
      ok(nodeFs.lstatSync(inHome).isSymbolicLink(), 'the link was made');
      unlinkSync(inHome);
    }
  });

  it("a peer-runs directory that turns into a file after the sweep's selection is refused, not read as missing", async () => {
    reset();
    create(repo.main);
    const runner = await import(pathToFileURL(runnerCli).href);
    await peerNow(runner, 'peer-now-20261008T000000Z-a4c006');
    const runs = join(repo.main, HOME, 'peer-runs');
    const moved = join(dir, 'moved-runs');
    rmSync(moved, { recursive: true, force: true });
    const real = nodeFs.readdirSync;
    let swapped = false;
    // Once the selection (sweepSelection) has listed the directory.
    nodeFs.readdirSync = function readdirSync(p, ...rest) {
      const out = real.call(this, p, ...rest);
      if (!swapped && String(p) === runs && new Error().stack.includes('sweepSelection')) {
        swapped = true;
        renameSync(runs, moved);
        writeFileSync(runs, 'not a directory');
      }
      return out;
    };
    try {
      await rejects(runner.sweepPeerRuns({ repoRoot: repo.main }), (err) => err.code === 'ENOTDIR');
    } finally {
      nodeFs.readdirSync = real;
      if (swapped) {
        rmSync(runs, { force: true });
        renameSync(moved, runs);
      }
    }
    ok(swapped, 'the selection listed the directory');
    strictEqual((await runner.sweepPeerRuns({ repoRoot: repo.main })).scanned, 1, 'control');
  });

  it("a file in a macro home's place is no empty home: resolve-workflow and find-macro refuse it, as runtime's readers do", () => {
    reset();
    const path = create(repo.main).stdout.trim();
    plan(path, [{ id: 'T1', verb: 'compose', branch: 'feat/e', blocked_by: [], status: 'pending' }]);
    mkdirSync(join(repo.lane, HOME), { recursive: true });
    writeFileSync(wfDir(repo.lane), 'not a directory');
    const resolved = runIn(repo.lane, ['resolve-workflow', '--repo-root', repo.lane, '--workflow-id', basename(path, '.md')]);
    strictEqual(resolved.status, 1, `not "no root holds it" (3): ${resolved.stderr}`);
    const macro = runIn(repo.lane, ['find-macro', '--repo-root', repo.lane, '--subtask-branch', 'feat/e']);
    strictEqual(macro.status, 1, macro.stdout);
    rmSync(wfDir(repo.lane));
    strictEqual(runIn(repo.lane, ['resolve-workflow', '--repo-root', repo.lane, '--workflow-id', basename(path, '.md')]).stdout.trim(), path, 'control');
  });

  it('runPeer called as an API judges the checkout repoRoot names: beside a second macro there, the run is refused before its ledger', async () => {
    reset();
    const path = create(repo.main).stdout.trim();
    plantSecond(path, 'macro-plan-20261008T000000Z-a4a003');
    const runner = await import(pathToFileURL(runnerCli).href);
    const runId = 'plan-verify-20261008T000000Z-a4a003';
    // This test process runs outside the fixture repository: only the
    // checkout repoRoot names puts the lane's second macro in view.
    await rejects(runner.runPeer({
      repoRoot: repo.lane, runId, kind: 'ensemble', workflowPath: path, phase: 'plan', ensembleType: 'plan-verify',
      host: 'claude', peer: 'codex', promptText: '<task>u4g</task>', outputFormat: 'json', cwd: repo.lane,
      env: { ...cleanEnv(), AGENTIC_COMPANIONS_ROOT: companions() },
    }), /2 active workflows on branch "main"/);
    for (const root of [repo.main, repo.lane, repo.other]) ok(!existsSync(join(root, HOME, 'peer-runs', runId)), `no ledger in ${root}`);
    ok(!readFileSync(path, 'utf8').includes(runId), 'no pending row');
  });

  it("a FIFO in a macro's place is refused at once, never waited on: the write guard, resolve-workflow and the Stop's macro facts", { timeout: 60_000 }, async () => {
    reset();
    const path = create(repo.main).stdout.trim();
    const fifo = join(wfDir(repo.main), 'macro-plan-20261008T000000Z-f1f0a4.md');
    execFileSync('mkfifo', [fifo]);
    try {
      const written = runIn(repo.lane, appendArgs(fifo), {}, 20_000);
      strictEqual(written.error?.code, undefined, 'the write guard: not waited on');
      strictEqual(written.status, 1, written.stdout);
      const resolved = runIn(repo.lane, ['resolve-workflow', '--repo-root', repo.lane, '--workflow-id', basename(fifo, '.md')], {}, 20_000);
      strictEqual(resolved.error?.code, undefined, 'resolve-workflow: not waited on');
      strictEqual(resolved.status, 1, resolved.stdout);
      match(resolved.stderr, /not a regular file/);
      const { listAllMacros } = await import(pathToFileURL(ORCH_STATE).href);
      await rejects(listAllMacros(repo.lane), /is not a regular file/, "the Stop's macro list");
      // In a child process, so a read that waits on the FIFO times out there
      // rather than hanging this one.
      const probe = [
        `const { macroGitFacts } = await import(${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/stop-archive.mjs')).href)});`,
        `process.stdout.write(JSON.stringify(await macroGitFacts({ workflowPath: ${JSON.stringify(fifo)}, repoRoot: ${JSON.stringify(repo.lane)}, ownBranch: 'refs/heads/feat/q', statusDigest: 'd', headSubject: 's' })));`,
      ].join('\n');
      const facts = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: dir, encoding: 'utf8', env: cleanEnv(), timeout: 20_000 });
      strictEqual(facts.error?.code, undefined, "the Stop's macro facts: not waited on");
      deepStrictEqual(JSON.parse(facts.stdout), { statusDigest: 'd', headSubject: 's' }, "the caller's facts, as for any macro it cannot read");
    } finally {
      rmSync(fifo);
    }
    strictEqual(runIn(repo.lane, ['resolve-workflow', '--repo-root', repo.lane, '--workflow-id', basename(path, '.md')]).stdout.trim(), path, 'control');
  });

  it('a stray file or link in the legacy peer-runs directory is no ledger: the sweep and status agree there is one home', async () => {
    reset();
    create(repo.main);
    const runner = await import(pathToFileURL(runnerCli).href);
    const runId = 'peer-now-20261008T000000Z-a4a005';
    await peerNow(runner, runId);
    const legacyRuns = join(repo.main, '.claude/agentic-orchestrator/peer-runs');
    mkdirSync(legacyRuns, { recursive: true });
    writeFileSync(join(legacyRuns, 'stray'), 'x');
    symlinkSync(join(legacyRuns, 'stray'), join(legacyRuns, 'peer-now-20261008T000000Z-a4a0f5'));
    strictEqual((await runner.statusPeerRun({ repoRoot: repo.main, runId })).run_id, runId);
    const report = await runner.sweepPeerRuns({ repoRoot: repo.main });
    strictEqual(report.scanned, 1, 'the canonical ledger, no dual-home refusal');
    mkdirSync(join(legacyRuns, 'peer-now-20261008T000000Z-a4a0d5'));
    await rejects(runner.sweepPeerRuns({ repoRoot: repo.main }), /both .* contain peer-run ledgers/, 'control: a run directory there is a second home');
  });

  it('the SessionStart hooks report a lookup the scans refuse, rather than show no active macro, and go on to the handoff backstop', () => {
    reset();
    create(repo.main);
    mkdirSync(wfDir(repo.lane), { recursive: true });
    const fifo = join(wfDir(repo.lane), 'macro-plan-20261008T000000Z-f1f0e6.md');
    execFileSync('mkfifo', [fifo]);
    // A pending handoff in the lane: the backstop re-surfaces and consumes it.
    const pendingSlot = join(repo.lane, HOME, 'last-session-handoff.json');
    const projection = JSON.stringify({ workflow_id: 'macro-plan-20261008T000000Z-f1f0e7', workflow_kind: 'orchestrator', archive_gate: 'archived', routing_recommendation: 'fresh' });
    try {
      for (const host of ['claude', 'codex']) {
        writeFileSync(pendingSlot, projection);
        const hook = join(REPO_ROOT, `plugins/orchestrator/adapters/${host}/hooks/session-start.mjs`);
        const ran = spawnSync(process.execPath, [hook], { cwd: repo.lane, input: JSON.stringify({ cwd: repo.lane }), encoding: 'utf8', env: cleanEnv(), timeout: 20_000 });
        strictEqual(ran.error?.code, undefined, `${host}: not waited on`);
        strictEqual(ran.status, 0, `${host}: nonfatal (${ran.stderr})`);
        match(ran.stderr, /orchestrator\/session-start: no active workflow shown: .*not a regular file/, host);
        ok(ran.stdout.includes('[orchestrator-handoff-pending]'), `${host}: the backstop ran after the refusal (${ran.stdout})`);
        ok(!existsSync(pendingSlot), `${host}: and consumed the pending handoff`);
      }
    } finally {
      rmSync(fifo);
    }
  });

  it('peer-runner --repo-root followed by another option is a usage error, not that option taken for a path', () => {
    const ran = spawnSync(process.execPath, [runnerCli, 'sweep', '--repo-root', '--apply'], { cwd: dir, encoding: 'utf8', env: cleanEnv() });
    strictEqual(ran.status, 2, ran.stderr);
    match(ran.stderr, /--repo-root needs a path/);
  });
});

// U5b (first part) — the runbooks' engineer scans read the repository-wide
// scan set from `state.mjs scan-roots`, which fails rather than leave a
// worktree out.
describe('orchestrator: scan-roots, the repository-wide scan set (ADR-0067 Decision 1(b))', () => {
  let dir;
  let repo;
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'state-root-orch-scan-')));
    repo = makeRepo(dir);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("lists the read set first, then every other worktree, each once, and fails when git cannot list them", () => {
    const fromLane = run(['scan-roots', '--repo-root', repo.lane]);
    strictEqual(fromLane.status, 0, fromLane.stderr);
    deepStrictEqual(JSON.parse(fromLane.stdout).map((r) => realpathSync(r)), [repo.main, repo.lane, repo.other]);
    const fromMain = run(['scan-roots', '--repo-root', repo.main]);
    deepStrictEqual(JSON.parse(fromMain.stdout).map((r) => realpathSync(r)), [repo.main, repo.lane, repo.other]);
    const noGit = join(dir, 'no-git-bin');
    mkdirSync(noGit, { recursive: true });
    const refused = run(['scan-roots', '--repo-root', repo.lane], { PATH: noGit });
    strictEqual(refused.status, 1);
    match(refused.stderr, /Cannot list the other worktrees/);
    strictEqual(refused.stdout, '');
  });
});
