// ADR-0067 Decision 4, item 2 (SR) for the persona state scripts: lookups
// search the read set, a workflow found in a checkout's own home is updated
// where it is, two copies of one branch key are an error, `create` checks the
// whole repository under the creation locks of Decision 2 and puts the record
// where Decision 1(a)/3 say, `archive` uses the record's own home, and the
// Stop's branch-agnostic sweep leaves every branch another worktree has out.
//
// Real git repositories: a main checkout, a linked worktree `lane` on
// feat/x, and a third worktree `other` on feat/y.

import { describe, it, before, after } from 'node:test';
import { strictEqual, notStrictEqual, ok, match, deepStrictEqual, rejects } from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import nodeFs from 'node:fs';
import { personasFor, pluginRoot, REPO_ROOT } from './_personas.mjs';

const ORCH_STATE = join(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');
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
const DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
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
const startWriter = (cli, args, env) => {
  const writer = { done: false };
  writer.result = new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
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

for (const persona of personasFor('scripts/state.mjs')) {
  const cli = join(pluginRoot(persona), 'scripts/state.mjs');
  const home = `.agentic-plugins/state/${persona}`;
  const run = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: cleanEnv(env) });
  const create = (checkout, branch, head, env = {}, extra = []) => run([
    'create', '--repo-root', checkout, '--verb', 'decide', '--host', 'claude',
    '--git-baseline-branch', branch, '--git-baseline-head', head, '--status-digest', DIGEST,
    '--original-request', 'state root fixture', ...extra,
  ], env);
  const findActive = (checkout, branch) => run(['find-active', '--repo-root', checkout, '--branch', branch]);
  const wfDir = (root) => join(root, home, 'workflows');
  const listed = (root) => (existsSync(wfDir(root)) ? readdirSync(wfDir(root)).filter((n) => n.endsWith('.md')) : []);

  describe(`${persona}: writers find records in the read set (ADR-0067 Decision 4, item 2)`, () => {
    let dir;
    let repo;
    const reset = () => {
      for (const root of [repo.main, repo.lane, repo.other]) {
        rmSync(join(root, '.agentic-plugins'), { recursive: true, force: true });
        rmSync(join(root, '.claude'), { recursive: true, force: true });
      }
    };
    const switchOn = () => {
      mkdirSync(join(repo.main, '.agentic-plugins/state'), { recursive: true });
      writeFileSync(join(repo.main, '.agentic-plugins/state/shared-creation.json'), JSON.stringify(SWITCH_ON));
    };
    before(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), `state-root-writers-${persona}-`)));
      repo = makeRepo(dir);
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    it('find-active from a linked worktree finds a workflow stored in the main checkout', () => {
      reset();
      const made = create(repo.main, 'feat/x', repo.head);
      strictEqual(made.status, 0, made.stderr);
      const path = made.stdout.trim();
      ok(path.startsWith(join(repo.main, home)), path);
      const found = findActive(repo.lane, 'feat/x');
      strictEqual(found.status, 0, found.stderr);
      strictEqual(found.stdout.trim(), path);
    });

    it("a workflow in the linked worktree's own home is found and updated in place, never copied", () => {
      reset();
      const made = create(repo.lane, 'feat/x', repo.head);
      strictEqual(made.status, 0, made.stderr);
      const path = made.stdout.trim();
      ok(path.startsWith(join(repo.lane, home)), path);
      strictEqual(findActive(repo.lane, 'feat/x').stdout.trim(), path);
      const appended = run(['append', '--workflow-path', path, '--host', 'claude', '--phase-label', 'P', '--phase-note', 'in place', '--event', 'updated']);
      strictEqual(appended.status, 0, appended.stderr);
      match(readFileSync(path, 'utf8'), /in place/);
      deepStrictEqual(listed(repo.main), [], 'nothing was created in the main checkout');
      // Shared creation on moves where a record is created, not where one found
      // in the checkout's own home is written.
      switchOn();
      const again = run(['append', '--workflow-path', path, '--host', 'claude', '--phase-label', 'P', '--phase-note', 'still in place', '--event', 'updated']);
      strictEqual(again.status, 0, again.stderr);
      match(readFileSync(path, 'utf8'), /still in place/);
      deepStrictEqual(listed(repo.main), [], 'nothing was copied to the default state root');
      strictEqual(findActive(repo.lane, 'feat/x').stdout.trim(), path);
    });

    it('two active workflows for one branch, one per root, are an error naming both', () => {
      reset();
      const a = create(repo.main, 'feat/x', repo.head);
      strictEqual(a.status, 0, a.stderr);
      // A second copy for the key, made the way an older script could: in the
      // lane's own home, where the old guard looked only.
      mkdirSync(wfDir(repo.lane), { recursive: true });
      const second = join(wfDir(repo.lane), 'decide-20261008T000000Z-aaaaaa.md');
      writeFileSync(second, readFileSync(a.stdout.trim(), 'utf8').replace(/workflow_id: "[^"]+"/, 'workflow_id: "decide-20261008T000000Z-aaaaaa"'));
      const found = findActive(repo.lane, 'feat/x');
      strictEqual(found.status, 1);
      match(found.stderr, /2 active workflows on branch "feat\/x"/);
      ok(found.stderr.includes(a.stdout.trim()) && found.stderr.includes(second), found.stderr);
      // From the main checkout the lane's own home is not in the read set.
      strictEqual(findActive(repo.main, 'feat/x').stdout.trim(), a.stdout.trim());
    });

    it('create refuses a branch key active in the read set', () => {
      reset();
      strictEqual(create(repo.main, 'feat/x', repo.head).status, 0);
      const second = create(repo.lane, 'feat/x', repo.head);
      strictEqual(second.status, 1);
      match(second.stderr, /already exists on branch 'feat\/x'/);
      deepStrictEqual(listed(repo.lane), []);
    });

    it("create refuses a branch key active in another worktree's own home, outside the read set", () => {
      reset();
      // A record in `other`'s own home for feat/x: no reader in the lane sees it.
      const hidden = create(repo.other, 'feat/x', repo.head);
      strictEqual(hidden.status, 0, hidden.stderr);
      ok(hidden.stdout.trim().startsWith(join(repo.other, home)));
      strictEqual(findActive(repo.lane, 'feat/x').stdout.trim(), '');
      const second = create(repo.lane, 'feat/x', repo.head);
      strictEqual(second.status, 1);
      ok(second.stderr.includes(hidden.stdout.trim()), second.stderr);
      deepStrictEqual(listed(repo.lane), []);
    });

    it('shared creation off: a linked worktree creates in its own home, and leaves the main checkout untouched', () => {
      reset();
      const made = create(repo.lane, 'feat/x', repo.head);
      strictEqual(made.status, 0, made.stderr);
      ok(made.stdout.trim().startsWith(join(repo.lane, home)));
      ok(!existsSync(join(repo.main, '.agentic-plugins')), 'no lock or directory under the default state root');
    });

    it('shared creation on: a linked worktree creates under the default state root', () => {
      reset();
      switchOn();
      const made = create(repo.lane, 'feat/x', repo.head);
      strictEqual(made.status, 0, made.stderr);
      ok(made.stdout.trim().startsWith(join(repo.main, home)), made.stdout);
      deepStrictEqual(listed(repo.lane), []);
    });

    it("shared creation on, AGENTIC_STATE_BASE naming the checkout: the record stays home, under the repository's lock too", () => {
      reset();
      switchOn();
      const made = create(repo.lane, 'feat/x', repo.head, { AGENTIC_STATE_BASE: repo.lane });
      strictEqual(made.status, 0, made.stderr);
      ok(made.stdout.trim().startsWith(join(repo.lane, home)), made.stdout);
      // The repository's creation lock lives in the default state root's home;
      // taking it there leaves that home's directories behind.
      ok(existsSync(wfDir(repo.main)), 'the repository creation lock was taken in the default state root');
    });

    it('a refused AGENTIC_STATE_BASE or an unreadable switch refuses create, writing nothing', () => {
      reset();
      const refused = create(repo.lane, 'feat/x', repo.head, { AGENTIC_STATE_BASE: repo.main });
      strictEqual(refused.status, 1);
      match(refused.stderr, /AGENTIC_STATE_BASE/);
      mkdirSync(join(repo.main, '.agentic-plugins/state'), { recursive: true });
      writeFileSync(join(repo.main, '.agentic-plugins/state/shared-creation.json'), '{broken');
      const unreadable = create(repo.lane, 'feat/x', repo.head);
      strictEqual(unreadable.status, 1);
      match(unreadable.stderr, /Shared-creation switch unreadable/);
      deepStrictEqual(listed(repo.lane), []);
      deepStrictEqual(listed(repo.main), []);
    });

    it("archive puts a record in its own home's archive, whatever checkout asks", () => {
      reset();
      const made = create(repo.main, 'feat/x', repo.head);
      const path = made.stdout.trim();
      const archived = run(['archive', '--workflow-path', path, '--host', 'claude', '--repo-root', repo.lane]);
      strictEqual(archived.status, 0, archived.stderr);
      const to = archived.stdout.trim();
      strictEqual(dirname(to), join(repo.main, home, 'archive'));
      ok(!existsSync(join(repo.lane, home, 'archive')), "nothing went to the lane's archive");
    });

    // U2b — one writable copy on every write path.
    const append = (path) => run(['append', '--workflow-path', path, '--host', 'claude', '--phase-label', 'P', '--phase-note', 'one copy', '--event', 'updated']);

    it('a workflow held at one relative path under two roots refuses every write to either file', () => {
      reset();
      const made = create(repo.main, 'feat/x', repo.head);
      strictEqual(made.status, 0, made.stderr);
      const path = made.stdout.trim();
      const copy = join(wfDir(repo.lane), basename(path));
      mkdirSync(wfDir(repo.lane), { recursive: true });
      writeFileSync(copy, readFileSync(path, 'utf8'));
      const before = readFileSync(path, 'utf8');
      for (const target of [path, copy]) {
        const refused = append(target);
        strictEqual(refused.status, 1, `append to ${target} must refuse`);
        match(refused.stderr, /held by 2 files/);
        ok(refused.stderr.includes(path) && refused.stderr.includes(copy), refused.stderr);
      }
      const archived = run(['archive', '--workflow-path', path, '--host', 'claude', '--repo-root', repo.main]);
      strictEqual(archived.status, 1, 'archive is a write path too');
      strictEqual(readFileSync(path, 'utf8'), before, 'nothing was written');
      strictEqual(readFileSync(copy, 'utf8'), before);
    });

    it("a copy in another worktree's own home, outside the read set, refuses the write too", () => {
      reset();
      const made = create(repo.lane, 'feat/x', repo.head);
      strictEqual(made.status, 0, made.stderr);
      const path = made.stdout.trim();
      const copy = join(wfDir(repo.other), basename(path));
      mkdirSync(wfDir(repo.other), { recursive: true });
      writeFileSync(copy, readFileSync(path, 'utf8'));
      const refused = append(path);
      strictEqual(refused.status, 1);
      ok(refused.stderr.includes(copy), refused.stderr);
      rmSync(copy);
      strictEqual(append(path).status, 0, 'with the copy gone, the write goes through');
    });

    it('a copy in the legacy home of the same root refuses the write (engineer)', { skip: persona !== 'engineer' }, () => {
      reset();
      const made = create(repo.main, 'feat/x', repo.head);
      const path = made.stdout.trim();
      const legacy = join(repo.main, '.claude/agentic-engineer/workflows');
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, basename(path)), readFileSync(path, 'utf8'));
      const refused = append(path);
      strictEqual(refused.status, 1);
      match(refused.stderr, /held by 2 files/);
    });

    it('a write through a symbolic link to the workflow file is refused, and the link stays a link', () => {
      reset();
      const made = create(repo.main, 'feat/x', repo.head);
      const path = made.stdout.trim();
      const alias = join(dir, `alias-${persona}.md`);
      rmSync(alias, { force: true });
      symlinkSync(path, alias);
      const refused = append(alias);
      strictEqual(refused.status, 1);
      match(refused.stderr, /symbolic link/);
      ok(lstatSync(alias).isSymbolicLink(), 'the alias was not replaced by a second copy');
      strictEqual(append(path).status, 0, 'the file itself is written');
      rmSync(alias);
    });

    it('the same file reached through a symlinked home directory is one copy, not two', () => {
      reset();
      const made = create(repo.main, 'feat/x', repo.head);
      const path = made.stdout.trim();
      // The lane's own home is a link to the main checkout's: one directory.
      mkdirSync(join(repo.lane, '.agentic-plugins/state'), { recursive: true });
      symlinkSync(join(repo.main, home), join(repo.lane, home));
      const appended = append(path);
      strictEqual(appended.status, 0, appended.stderr);
    });
  });

  // ADR-0067 Decision 2: with shared creation on, a create or an archive in a
  // home other than the default state root's takes the repository's creation
  // lock (the default state root's home) and then that home's. Each is held
  // here in turn; `reached` is what the writer visibly does just before it
  // asks for the lock: the repository lock's `ensureDir` of the default state
  // root's workflows directory, or holding the repository lock itself.
  describe(`${persona}: create and archive wait on both creation locks once shared creation is on (ADR-0067 Decision 2)`, () => {
    let dir;
    let repo;
    const repoLock = () => join(repo.main, home, '.creation-lock');
    const homeLock = () => join(repo.lane, home, '.creation-lock');
    const reset = () => {
      for (const root of [repo.main, repo.lane, repo.other]) rmSync(join(root, '.agentic-plugins'), { recursive: true, force: true });
    };
    const switchOn = () => {
      mkdirSync(join(repo.main, '.agentic-plugins/state'), { recursive: true });
      writeFileSync(join(repo.main, '.agentic-plugins/state/shared-creation.json'), JSON.stringify(SWITCH_ON));
    };
    // The record stays in the lane's own home: AGENTIC_STATE_BASE names it.
    const createInLane = () => startWriter(cli, [
      'create', '--repo-root', repo.lane, '--verb', 'decide', '--host', 'claude',
      '--git-baseline-branch', 'feat/x', '--git-baseline-head', repo.head, '--status-digest', DIGEST,
      '--original-request', 'creation lock fixture',
    ], { AGENTIC_STATE_BASE: repo.lane });
    // A record in the lane's own home, made while shared creation was off.
    const recordInLane = () => {
      const made = create(repo.lane, 'feat/x', repo.head);
      strictEqual(made.status, 0, made.stderr);
      ok(made.stdout.trim().startsWith(join(repo.lane, home)), made.stdout);
      return made.stdout.trim();
    };
    const archiveFromLane = (path) => startWriter(cli, ['archive', '--workflow-path', path, '--host', 'claude', '--repo-root', repo.lane], {});
    before(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), `state-root-locks-${persona}-`)));
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
      ok(made.stdout.trim().startsWith(join(repo.lane, home)), made.stdout);
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
      const path = recordInLane();
      switchOn();
      ok(!existsSync(wfDir(repo.main)));
      await waitsOn(repoLock(), () => archiveFromLane(path), {
        reached: () => existsSync(wfDir(repo.main)),
        written: () => !existsSync(path),
      });
      ok(existsSync(join(repo.lane, home, 'archive', basename(path))), "archived in the record's own home");
    });

    it("archive waits on the record home's creation lock", async () => {
      reset();
      const path = recordInLane();
      switchOn();
      await waitsOn(homeLock(), () => archiveFromLane(path), {
        reached: () => existsSync(repoLock()),
        written: () => !existsSync(path),
      });
      ok(existsSync(join(repo.lane, home, 'archive', basename(path))), "archived in the record's own home");
    });
  });

  describe(`${persona}: a dispatched child goes beside its macro once shared creation is on (ADR-0067 Decision 3)`, () => {
    let dir;
    let repo;
    const dispatchOn = JSON.parse(readFileSync(join(pluginRoot(persona), 'persona.json'), 'utf8')).capabilities?.dispatch_target === true;
    before(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), `state-root-child-${persona}-`)));
      repo = makeRepo(dir);
    });
    after(() => rmSync(dir, { recursive: true, force: true }));
    // AGENTIC_STATE_BASE naming the checkout keeps the macro in its own home
    // once shared creation is on (ADR-0067 Decision 2).
    const macroIn = (checkout) => execFileSync(process.execPath, [ORCH_STATE, 'create', '--repo-root', checkout, '--verb', 'plan', '--host', 'claude',
      '--git-baseline-branch', 'main', '--git-baseline-head', repo.head, '--original-request', 'macro'], { encoding: 'utf8', env: cleanEnv({ AGENTIC_STATE_BASE: checkout }) }).trim();

    it('beside the macro, with or without the recorded path, AGENTIC_STATE_BASE notwithstanding', { skip: !dispatchOn && 'dispatch_target off' }, () => {
      for (const root of [repo.main, repo.lane]) rmSync(join(root, '.agentic-plugins'), { recursive: true, force: true });
      mkdirSync(join(repo.main, '.agentic-plugins/state'), { recursive: true });
      writeFileSync(join(repo.main, '.agentic-plugins/state/shared-creation.json'), JSON.stringify(SWITCH_ON));
      // The macro sits in the lane's own home (a macro not yet cut over).
      const macroPath = macroIn(repo.lane);
      const macroId = basename(macroPath, '.md');
      ok(macroPath.startsWith(repo.lane));
      const withPath = create(repo.lane, 'feat/x', repo.head, {}, ['--parent-workflow', macroId, '--originating-subtask', 'T1', '--parent-workflow-path', macroPath]);
      strictEqual(withPath.status, 0, withPath.stderr);
      ok(withPath.stdout.trim().startsWith(join(repo.lane, home)), withPath.stdout);
      rmSync(withPath.stdout.trim());
      const idsOnly = create(repo.lane, 'feat/x', repo.head, { AGENTIC_STATE_BASE: repo.main }, ['--parent-workflow', macroId, '--originating-subtask', 'T1']);
      strictEqual(idsOnly.status, 0, idsOnly.stderr);
      ok(idsOnly.stdout.trim().startsWith(join(repo.lane, home)), idsOnly.stdout);
      // Control: without the parent ids the record goes to the default state root.
      rmSync(idsOnly.stdout.trim());
      const plain = create(repo.lane, 'feat/x', repo.head);
      ok(plain.stdout.trim().startsWith(join(repo.main, home)), plain.stdout);
    });
  });

  describe(`${persona}: the Stop sweep leaves branches other worktrees have out (ADR-0067 Decision 1(b))`, () => {
    let dir;
    let repo;
    before(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), `state-root-sweep-${persona}-`)));
      repo = makeRepo(dir);
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    it("a terminal workflow on the lane's branch, stored in the main checkout, is not swept from the main checkout", async () => {
      const made = create(repo.main, 'feat/x', repo.head);
      strictEqual(made.status, 0, made.stderr);
      const path = made.stdout.trim();
      writeFileSync(join(repo.lane, 'work.txt'), 'w\n');
      git(repo.lane, 'add', 'work.txt');
      git(repo.lane, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'feat: lane work');
      const terminal = run(['set-terminal', '--workflow-path', path, '--host', 'claude', '--terminal-phase', 'commit-complete', '--terminal-marker', 'true']);
      strictEqual(terminal.status, 0, terminal.stderr);
      const { runStopArchiveOrphanSweep } = await import(pathToFileURL(join(pluginRoot(persona), 'scripts/stop-archive.mjs')).href);
      const calls = [];
      const spy = async (args) => { calls.push(args.workflowPath); return { archived: false, reason: 'spy' }; };
      const sink = { write() {} };
      const results = await runStopArchiveOrphanSweep({ repoRoot: repo.main, host: 'claude', stderr: sink, archive: spy });
      deepStrictEqual(calls, []);
      deepStrictEqual(results, []);
      // Control: once no worktree has feat/x out, the same sweep judges it on the branch tip.
      git(repo.main, 'worktree', 'remove', '--force', repo.lane);
      await runStopArchiveOrphanSweep({ repoRoot: repo.main, host: 'claude', stderr: sink, archive: spy });
      deepStrictEqual(calls, [path]);
    });
  });

  // U3 — what derives from a record found under another root: the handoff
  // slot and the git facts stay the checkout's, pointers and peer runs follow
  // the record, and the writeback finds its macro through the read set.
  describe(`${persona}: a record under the state root, worked from a linked worktree (ADR-0067 Decisions 1, 3, 4)`, () => {
    let dir;
    let repo;
    const runIn = (cwd, args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: cleanEnv() });
    const slot = (root) => join(root, home, 'last-session-handoff.json');
    const reset = () => {
      for (const root of [repo.main, repo.lane, repo.other]) rmSync(join(root, '.agentic-plugins'), { recursive: true, force: true });
    };
    before(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), `state-root-u3-${persona}-`)));
      repo = makeRepo(dir);
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    it("the terminal sidecar probes the lane's HEAD, writes the slot in the lane, and points into the state root", () => {
      reset();
      const made = create(repo.main, 'feat/x', repo.head);
      strictEqual(made.status, 0, made.stderr);
      const path = made.stdout.trim();
      // The lane's branch moves past the baseline; the main checkout's HEAD
      // stays on it, so a probe of the storage root would say "not moved".
      git(repo.lane, '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'feat: lane work');
      strictEqual(git(repo.main, 'rev-parse', 'HEAD'), repo.head);
      const done = runIn(repo.lane, [
        'set-terminal', '--workflow-path', path, '--host', 'claude',
        '--terminal-phase', 'summary-complete', '--terminal-marker', 'true', '--next-action', 'archive',
      ]);
      strictEqual(done.status, 0, done.stderr);
      ok(existsSync(slot(repo.lane)), "the slot is the lane's");
      ok(!existsSync(slot(repo.main)), 'nothing in the storage root');
      const projection = JSON.parse(readFileSync(slot(repo.lane), 'utf8'));
      strictEqual(projection.workflow_path, `${home}/workflows/${basename(path)}`);
      strictEqual(projection.archive_gate, 'ready_to_archive', JSON.stringify(projection));
    });

    it("run from the main checkout, the sidecar reads the lane's branch tip from refs/heads, not the main checkout's HEAD", () => {
      reset();
      const made = create(repo.main, 'feat/x', repo.head);
      strictEqual(made.status, 0, made.stderr);
      git(repo.lane, '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'feat: more lane work');
      strictEqual(git(repo.main, 'rev-parse', 'HEAD'), repo.head, "the main checkout's HEAD is the baseline");
      const done = runIn(repo.main, [
        'set-terminal', '--workflow-path', made.stdout.trim(), '--host', 'claude',
        '--terminal-phase', 'summary-complete', '--terminal-marker', 'true', '--next-action', 'archive',
      ]);
      strictEqual(done.status, 0, done.stderr);
      ok(existsSync(slot(repo.main)), "the slot is the main checkout's, where the command ran");
      ok(!existsSync(slot(repo.lane)));
      strictEqual(JSON.parse(readFileSync(slot(repo.main), 'utf8')).archive_gate, 'ready_to_archive');
    });

    it('a run of a workflow under the state root is kept in its home, and settled from the lane', async () => {
      reset();
      const made = create(repo.main, 'feat/x', repo.head);
      const workflowPath = made.stdout.trim();
      const runner = await import(pathToFileURL(join(pluginRoot(persona), 'scripts/peer-runner.mjs')).href);
      const companions = join(dir, 'fake-companions');
      mkdirSync(companions, { recursive: true });
      writeFileSync(join(companions, 'discover-peer.mjs'),
        'export async function discoverPeerCompanion({ peer } = {}) { return { ok: true, path: new URL("./" + peer + "-companion.mjs", import.meta.url).pathname }; }\n');
      writeFileSync(join(companions, 'codex-companion.mjs'),
        "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ status: 'success', peer_host: 'codex', peer_model: null, stdout: 'ok', exit_code: 0 }));\n",
        { mode: 0o755 });
      const runId = 'plan-verify-20261008T000000Z-u3a001';
      await runner.runPeer({
        repoRoot: repo.lane, runId, kind: 'ensemble', workflowPath, phase: 'compose', ensembleType: 'plan-verify',
        host: 'claude', peer: 'codex', promptText: '<task>u3</task>', outputFormat: 'json', cwd: repo.lane,
        env: { ...cleanEnv(), AGENTIC_COMPANIONS_ROOT: companions },
      });
      ok(existsSync(join(repo.main, home, 'peer-runs', runId, 'handle.json')), "the ledger is in the record's own home");
      ok(!existsSync(join(repo.lane, home, 'peer-runs')), "nothing in the lane's home");
      const status = await runner.statusPeerRun({ repoRoot: repo.lane, runId });
      strictEqual(status.run_id ?? status.handle?.run_id ?? runId, runId);
      const settled = await runner.settleEnsemble({
        repoRoot: repo.lane, workflowPath, phase: 'compose', runId, verdict: 'agreed', summary: 'u3',
      });
      strictEqual(settled.settlement, 'committed', JSON.stringify(settled));
      match(readFileSync(workflowPath, 'utf8'), /run_id: "plan-verify-20261008T000000Z-u3a001"/);
      // A run id in two read roots is ambiguity, never a choice.
      mkdirSync(join(repo.lane, home, 'peer-runs', runId), { recursive: true });
      await rejects(runner.statusPeerRun({ repoRoot: repo.lane, runId }), /exists in both/);
    });

    it("a child committed in the lane writes back to its macro in the main checkout, found through the read set", { skip: !JSON.parse(readFileSync(join(pluginRoot(persona), 'persona.json'), 'utf8')).capabilities?.dispatch_target && 'dispatch_target off' }, async () => {
      reset();
      const orch = (args) => execFileSync(process.execPath, [ORCH_STATE, ...args], { encoding: 'utf8', env: cleanEnv() }).trim();
      const macroPath = orch([
        'create', '--repo-root', repo.main, '--verb', 'plan', '--host', 'claude',
        '--git-baseline-branch', 'main', '--git-baseline-head', repo.head, '--status-digest', DIGEST,
        '--original-request', 'u3 macro',
      ]);
      const macroId = basename(macroPath, '.md');
      const subtasks = join(dir, `subtasks-${persona}.json`);
      writeFileSync(subtasks, JSON.stringify([{ id: 'T1', verb: 'compose', branch: 'feat/x', blocked_by: [], status: 'in_progress' }]));
      orch(['plan-set', '--workflow-path', macroPath, '--host', 'claude', '--subtasks-json-file', subtasks]);
      // An older orchestrator's dispatch: the ids, no path. Shared creation is
      // off, so the child is created in the lane's own home.
      const child = create(repo.lane, 'feat/x', repo.head, {}, ['--parent-workflow', macroId, '--originating-subtask', 'T1']);
      strictEqual(child.status, 0, child.stderr);
      ok(child.stdout.trim().startsWith(join(repo.lane, home)));
      git(repo.lane, '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'feat: child work');
      const commit = git(repo.lane, 'rev-parse', 'HEAD');
      const { writebackParent } = await import(pathToFileURL(join(pluginRoot(persona), 'scripts/parent-writeback.mjs')).href);
      const err = [];
      const result = await writebackParent({
        repoRoot: repo.lane, parentWorkflowId: macroId, originatingSubtaskId: 'T1',
        engineerWorkflowId: basename(child.stdout.trim(), '.md'), commit, host: 'claude',
        orchestratorRoot: join(REPO_ROOT, 'plugins/orchestrator'), stderr: { write: (t) => err.push(t) },
      });
      strictEqual(result.ok, true, err.join(''));
      ok(readFileSync(macroPath, 'utf8').includes(commit), 'the terminal note is on the macro');
      // A stray copy in another worktree's own home refuses the next writeback.
      mkdirSync(join(repo.other, '.agentic-plugins/state/orchestrator/workflows'), { recursive: true });
      writeFileSync(join(repo.other, '.agentic-plugins/state/orchestrator/workflows', basename(macroPath)), readFileSync(macroPath, 'utf8'));
      const again = await writebackParent({
        repoRoot: repo.lane, parentWorkflowId: macroId, originatingSubtaskId: 'T1',
        engineerWorkflowId: basename(child.stdout.trim(), '.md'), commit, host: 'claude',
        orchestratorRoot: join(REPO_ROOT, 'plugins/orchestrator'), stderr: { write: () => {} },
      });
      strictEqual(again.reason, 'parent-ambiguous');
    });
  });

  // U4c — the second Plan-verify's findings on the persona writers: a copy is
  // judged by workflow id, a path write sees the branch key's second active
  // workflow, the copy check holds the lock, a scan or a checkout that cannot
  // be told fails closed, an aliased home gets no slot, and a peer-run
  // directory is absent only on ENOENT.
  describe(`${persona}: one copy by id, one active per branch, failing closed (ADR-0067 Decisions 1, 2, 4)`, () => {
    let dir;
    let repo;
    let noGit;
    let failingRevParse;
    const runIn = (cwd, args, env = {}) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: cleanEnv(env) });
    const appendArgs = (path) => ['append', '--workflow-path', path, '--host', 'claude', '--phase-label', 'P', '--phase-note', 'u4c', '--event', 'updated'];
    const append = (path, cwd = REPO_ROOT, env = {}) => runIn(cwd, appendArgs(path), env);
    const terminal = (path) => ['set-terminal', '--workflow-path', path, '--host', 'claude', '--terminal-phase', 'summary-complete', '--terminal-marker', 'true', '--next-action', 'archive'];
    const slot = (root) => join(root, home, 'last-session-handoff.json');
    const asId = (text, id) => text.replace(/workflow_id: "[^"]+"/, `workflow_id: "${id}"`);
    const reset = () => {
      for (const root of [repo.main, repo.lane, repo.other]) {
        rmSync(join(root, '.agentic-plugins'), { recursive: true, force: true });
        rmSync(join(root, '.claude'), { recursive: true, force: true });
      }
    };
    const fakeCompanions = () => {
      const companions = join(dir, 'fake-companions');
      mkdirSync(companions, { recursive: true });
      writeFileSync(join(companions, 'discover-peer.mjs'),
        'export async function discoverPeerCompanion({ peer } = {}) { return { ok: true, path: new URL("./" + peer + "-companion.mjs", import.meta.url).pathname }; }\n');
      writeFileSync(join(companions, 'codex-companion.mjs'),
        "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ status: 'success', peer_host: 'codex', peer_model: null, stdout: 'ok', exit_code: 0 }));\n",
        { mode: 0o755 });
      return companions;
    };
    before(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), `state-root-u4c-${persona}-`)));
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
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      mkdirSync(wfDir(repo.lane), { recursive: true });
      const renamed = join(wfDir(repo.lane), 'decide-20261008T000000Z-c0c0c0.md');
      writeFileSync(renamed, readFileSync(path, 'utf8'));
      const refused = append(path);
      strictEqual(refused.status, 1);
      match(refused.stderr, /held by 2 files/);
      ok(refused.stderr.includes(renamed), refused.stderr);
      rmSync(renamed);
      strictEqual(append(path).status, 0, 'with the copy gone, the write goes through');
    });

    it("a second active workflow on the record's branch key refuses a path write from a checkout that reads both", () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      mkdirSync(wfDir(repo.lane), { recursive: true });
      const second = join(wfDir(repo.lane), 'decide-20261008T000000Z-bbbbbb.md');
      writeFileSync(second, asId(readFileSync(path, 'utf8'), 'decide-20261008T000000Z-bbbbbb'));
      const fromLane = append(path, repo.lane);
      strictEqual(fromLane.status, 1);
      match(fromLane.stderr, /2 active workflows on branch "feat\/x"/);
      strictEqual(append(second, repo.main).status, 1, "the lane's record: the read set of its root holds both");
      // The main checkout reads one of them, so the owner can finish it there.
      strictEqual(append(path, repo.main).status, 0);
    });

    it('the copy check runs holding the lock: a copy made while the writer waits refuses it', async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const lock = `${path}.lock`;
      writeFileSync(lock, `${process.pid}:held-by-the-test`);
      const waiting = new Promise((resolveRun) => {
        const child = spawn(process.execPath, [cli, ...appendArgs(path)], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (status) => resolveRun({ status, stderr }));
      });
      await new Promise((r) => setTimeout(r, 1000));
      mkdirSync(wfDir(repo.lane), { recursive: true });
      writeFileSync(join(wfDir(repo.lane), basename(path)), readFileSync(path, 'utf8'));
      rmSync(lock);
      const waited = await waiting;
      strictEqual(waited.status, 1, 'the copy that appeared while it waited refuses the write');
      match(waited.stderr, /held by 2 files/);
    });

    it('worktrees git cannot list refuse a write and a create: a copy or an active workflow may be there', () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const write = append(path, REPO_ROOT, { PATH: noGit });
      strictEqual(write.status, 1);
      match(write.stderr, /Cannot list the other worktrees/);
      const made = create(repo.main, 'feat/z', repo.head, { PATH: noGit });
      strictEqual(made.status, 1);
      match(made.stderr, /Cannot list the other worktrees/);
      strictEqual(append(path).status, 0, 'control: with git, the write goes through');
    });

    it("a checkout that cannot be told writes no handoff slot, rather than the storage root's", () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const done = runIn(repo.lane, terminal(path), { PATH: failingRevParse });
      strictEqual(done.status, 0, done.stderr);
      match(done.stderr, /handoff slot not written/);
      ok(!existsSync(slot(repo.main)), "not the storage root's slot");
      ok(!existsSync(slot(repo.lane)));
    });

    it("a home linked to another checkout's gets no handoff slot: it would be that checkout's", () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      mkdirSync(join(repo.lane, '.agentic-plugins/state'), { recursive: true });
      symlinkSync(join(repo.main, home), join(repo.lane, home));
      const done = runIn(repo.lane, terminal(path));
      strictEqual(done.status, 0, done.stderr);
      match(done.stderr, /handoff slot not written: .* is a symbolic link/);
      ok(!existsSync(slot(repo.main)), "the main checkout's slot is untouched");
    });

    it('a peer-run directory that cannot be judged is not read as absent', { skip: typeof process.getuid === 'function' && process.getuid() === 0 && 'root reads any directory' }, async () => {
      reset();
      create(repo.main, 'feat/x', repo.head);
      const runner = await import(pathToFileURL(join(pluginRoot(persona), 'scripts/peer-runner.mjs')).href);
      const runId = 'plan-verify-20261008T000000Z-u4c001';
      const peerRuns = join(repo.main, home, 'peer-runs');
      mkdirSync(join(peerRuns, runId), { recursive: true });
      // No search permission: the run directory cannot be lstat'ed.
      execFileSync('chmod', ['000', peerRuns]);
      try {
        await rejects(runner.statusPeerRun({ repoRoot: repo.lane, runId }), /cannot tell whether/);
      } finally {
        execFileSync('chmod', ['755', peerRuns]);
      }
    });

    it('the sweep leaves a run id two directories hold alone, and reports the run and its own directory', async () => {
      reset();
      const workflowPath = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runner = await import(pathToFileURL(join(pluginRoot(persona), 'scripts/peer-runner.mjs')).href);
      const runId = 'plan-verify-20261008T000000Z-u4c002';
      await runner.runPeer({
        repoRoot: repo.main, runId, kind: 'ensemble', workflowPath, phase: 'compose', ensembleType: 'plan-verify',
        host: 'claude', peer: 'codex', promptText: '<task>u4c</task>', outputFormat: 'json', cwd: repo.main,
        env: { ...cleanEnv(), AGENTIC_COMPANIONS_ROOT: fakeCompanions() },
      });
      const inMain = join(repo.main, home, 'peer-runs', runId);
      const inLane = join(repo.lane, home, 'peer-runs', runId);
      cpSync(inMain, inLane, { recursive: true });
      const later = new Date('2031-01-01T00:00:00Z');
      const report = await runner.sweepPeerRuns({ repoRoot: repo.lane, applyRetention: true, now: later });
      deepStrictEqual(report.ambiguous.map((a) => a.run_id), [runId]);
      deepStrictEqual(report.pruned, []);
      ok(existsSync(inMain) && existsSync(inLane), 'neither copy was touched');
      strictEqual(report.root, join(repo.lane, home, 'peer-runs'), "the checkout's own directory");
      strictEqual(report.retention_applied, true);
      rmSync(join(repo.lane, home, 'peer-runs'), { recursive: true });
      const again = await runner.sweepPeerRuns({ repoRoot: repo.lane, applyRetention: true, now: later });
      deepStrictEqual(again.pruned.map((p) => p.run_id), [runId], 'control: one copy is swept as before');
      strictEqual(again.retention_applied, true, "retention ran, though the lane's own directory is missing");
    });

    it('a macro copy under another file name refuses the writeback', { skip: !JSON.parse(readFileSync(join(pluginRoot(persona), 'persona.json'), 'utf8')).capabilities?.dispatch_target && 'dispatch_target off' }, async () => {
      reset();
      const orch = (args) => execFileSync(process.execPath, [ORCH_STATE, ...args], { encoding: 'utf8', env: cleanEnv() }).trim();
      const macroPath = orch([
        'create', '--repo-root', repo.main, '--verb', 'plan', '--host', 'claude',
        '--git-baseline-branch', 'main', '--git-baseline-head', repo.head, '--status-digest', DIGEST,
        '--original-request', 'u4c macro',
      ]);
      const macroId = basename(macroPath, '.md');
      const subtasks = join(dir, `subtasks-u4c-${persona}.json`);
      writeFileSync(subtasks, JSON.stringify([{ id: 'T1', verb: 'compose', branch: 'feat/x', blocked_by: [], status: 'in_progress' }]));
      orch(['plan-set', '--workflow-path', macroPath, '--host', 'claude', '--subtasks-json-file', subtasks]);
      const child = create(repo.lane, 'feat/x', repo.head, {}, ['--parent-workflow', macroId, '--originating-subtask', 'T1']);
      strictEqual(child.status, 0, child.stderr);
      git(repo.lane, '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'feat: u4c child work');
      const strays = join(repo.other, '.agentic-plugins/state/orchestrator/workflows');
      mkdirSync(strays, { recursive: true });
      writeFileSync(join(strays, 'macro-plan-20261008T000000Z-5a5a5a.md'), readFileSync(macroPath, 'utf8'));
      const { writebackParent } = await import(pathToFileURL(join(pluginRoot(persona), 'scripts/parent-writeback.mjs')).href);
      const before = readFileSync(macroPath, 'utf8');
      const result = await writebackParent({
        repoRoot: repo.lane, parentWorkflowId: macroId, originatingSubtaskId: 'T1',
        engineerWorkflowId: basename(child.stdout.trim(), '.md'), commit: git(repo.lane, 'rev-parse', 'HEAD'), host: 'claude',
        orchestratorRoot: join(REPO_ROOT, 'plugins/orchestrator'), stderr: { write: () => {} },
      });
      strictEqual(result.reason, 'parent-ambiguous');
      strictEqual(readFileSync(macroPath, 'utf8'), before, 'the macro was not written');
    });

    it('settle and the unsettled-attempt scan judge the workflow by its file, not its spelling', async () => {
      reset();
      const workflowPath = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runner = await import(pathToFileURL(join(pluginRoot(persona), 'scripts/peer-runner.mjs')).href);
      const runId = 'plan-verify-20261008T000000Z-u4c003';
      await runner.runPeer({
        repoRoot: repo.main, runId, kind: 'ensemble', workflowPath, phase: 'compose', ensembleType: 'plan-verify',
        host: 'claude', peer: 'codex', promptText: '<task>u4c</task>', outputFormat: 'json', cwd: repo.main,
        env: { ...cleanEnv(), AGENTIC_COMPANIONS_ROOT: fakeCompanions() },
      });
      // Drop the pending row: only the ledger names the attempt now.
      writeFileSync(workflowPath, readFileSync(workflowPath, 'utf8').replace(/^pending_ensemble:\n(?:  .*\n)+/m, 'pending_ensemble: []\n'));
      ok(/^pending_ensemble: \[\]$/m.test(readFileSync(workflowPath, 'utf8')), 'the pending row is gone');
      match(readFileSync(join(repo.main, home, 'peer-runs', runId, 'handle.json'), 'utf8'), /"workflow_path"/);
      const link = join(dir, `main-link-${persona}`);
      rmSync(link, { force: true });
      symlinkSync(repo.main, link);
      const alias = join(link, home, 'workflows', basename(workflowPath));
      await rejects(
        runner.settleEnsemble({ repoRoot: repo.lane, workflowPath: alias, phase: 'compose', runId: '', verdict: 'agreed', summary: 'u4c' }),
        /unsettled ensemble attempt/,
      );
      const byId = await runner.settleEnsemble({ repoRoot: repo.lane, workflowPath: alias, phase: 'compose', runId, verdict: 'agreed', summary: 'u4c' })
        .then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }));
      ok(byId.ok || !/belongs to another workflow/.test(byId.e.message), byId.e?.message);
      strictEqual(byId.r?.settlement, 'committed', JSON.stringify(byId.r ?? byId.e?.message));
    });
  });

  // U4d — the third Plan-verify's findings on the persona writers: a
  // repository whose identity cannot be read fails closed, a writer judges the
  // checkout its caller names (not its working directory), one file reached
  // through two names is one workflow, an aliased slot is neither read nor
  // consumed, an inaccessible ledger is no absence, one identity rule for run
  // directories, the sweep's own directory, a FIFO or a vanished file in a scan.
  describe(`${persona}: the writers judge the caller's checkout and one file once (ADR-0067 Decisions 1, 2, 4)`, () => {
    let dir;
    let repo;
    const capabilities = JSON.parse(readFileSync(join(pluginRoot(persona), 'persona.json'), 'utf8')).capabilities ?? {};
    const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    const runIn = (cwd, args, env = {}, timeout = undefined) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: cleanEnv(env), timeout });
    const appendArgs = (path) => ['append', '--workflow-path', path, '--host', 'claude', '--phase-label', 'P', '--phase-note', 'u4d', '--event', 'updated'];
    const terminal = (path) => ['set-terminal', '--workflow-path', path, '--host', 'claude', '--terminal-phase', 'summary-complete', '--terminal-marker', 'true', '--next-action', 'archive'];
    const asId = (text, id) => text.replace(/workflow_id: "[^"]+"/, `workflow_id: "${id}"`);
    const slot = (root) => join(root, home, 'last-session-handoff.json');
    const script = (name) => pathToFileURL(join(pluginRoot(persona), 'scripts', name)).href;
    const reset = () => {
      for (const root of [repo.main, repo.lane, repo.other]) {
        rmSync(join(root, '.agentic-plugins'), { recursive: true, force: true });
        rmSync(join(root, '.claude'), { recursive: true, force: true });
      }
    };
    const fakeCompanions = () => {
      const companions = join(dir, 'fake-companions');
      mkdirSync(companions, { recursive: true });
      writeFileSync(join(companions, 'discover-peer.mjs'),
        'export async function discoverPeerCompanion({ peer } = {}) { return { ok: true, path: new URL("./" + peer + "-companion.mjs", import.meta.url).pathname }; }\n');
      writeFileSync(join(companions, 'codex-companion.mjs'),
        "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ status: 'success', peer_host: 'codex', peer_model: null, stdout: 'ok', exit_code: 0 }));\n",
        { mode: 0o755 });
      return companions;
    };
    const ensembleRun = async (workflowPath, runId) => {
      const runner = await import(script('peer-runner.mjs'));
      await runner.runPeer({
        repoRoot: repo.main, runId, kind: 'ensemble', workflowPath, phase: 'compose', ensembleType: 'plan-verify',
        host: 'claude', peer: 'codex', promptText: '<task>u4d</task>', outputFormat: 'json', cwd: repo.main,
        env: { ...cleanEnv(), AGENTIC_COMPANIONS_ROOT: fakeCompanions() },
      });
      return runner;
    };
    before(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), `state-root-u4d-${persona}-`)));
      repo = makeRepo(dir);
    });
    after(() => {
      for (const root of [repo.main, repo.lane, repo.other]) {
        try { execFileSync('chmod', ['-R', 'u+rwX', root]); } catch { /* best effort */ }
      }
      rmSync(dir, { recursive: true, force: true });
    });

    it('a repository whose identity cannot be read refuses a write: its other worktrees cannot be listed', { skip: asRoot && 'root reads any file' }, () => {
      reset();
      const path = create(repo.lane, 'feat/x', repo.head).stdout.trim();
      ok(path.startsWith(join(repo.lane, home)), path);
      execFileSync('chmod', ['000', join(repo.lane, '.git')]);
      try {
        const refused = runIn(REPO_ROOT, appendArgs(path));
        strictEqual(refused.status, 1, refused.stderr);
        match(refused.stderr, /repository identity cannot be read/);
      } finally {
        execFileSync('chmod', ['644', join(repo.lane, '.git')]);
      }
      strictEqual(runIn(REPO_ROOT, appendArgs(path)).status, 0, 'control: readable, the write goes through');
    });

    it("the Stop judges the checkout it is given, not the process's working directory", () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      mkdirSync(wfDir(repo.lane), { recursive: true });
      writeFileSync(join(wfDir(repo.lane), 'decide-20261008T000000Z-d4d4d4.md'), asId(readFileSync(path, 'utf8'), 'decide-20261008T000000Z-d4d4d4'));
      const probe = [
        `const { runStopArchive } = await import(${JSON.stringify(script('stop-archive.mjs'))});`,
        `const r = await runStopArchive({ workflowPath: ${JSON.stringify(path)}, host: 'claude', repoRoot: ${JSON.stringify(repo.lane)}, statusDigest: ${JSON.stringify(DIGEST)} });`,
        'process.stdout.write(JSON.stringify(r));',
      ].join('\n');
      // The process runs outside every repository: only the checkout the call
      // names puts the lane's read set, and the second workflow, in view.
      const stop = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: dir, encoding: 'utf8', env: cleanEnv() });
      strictEqual(stop.status, 0, stop.stderr);
      match(stop.stderr, /snapshot failed: .*2 active workflows on branch "feat\/x"/);
      ok(!/event: "snapshot"/.test(readFileSync(path, 'utf8')), 'no snapshot was written');
    });

    it('a child committed in the lane, written back from a process elsewhere, is judged in the lane: a second macro on the branch refuses', { skip: !capabilities.dispatch_target && 'dispatch_target off' }, async () => {
      reset();
      const orch = (args) => execFileSync(process.execPath, [ORCH_STATE, ...args], { encoding: 'utf8', env: cleanEnv() }).trim();
      const macroPath = orch([
        'create', '--repo-root', repo.main, '--verb', 'plan', '--host', 'claude',
        '--git-baseline-branch', 'main', '--git-baseline-head', repo.head, '--status-digest', DIGEST,
        '--original-request', 'u4d macro',
      ]);
      const macroId = basename(macroPath, '.md');
      const subtasks = join(dir, `subtasks-u4d-${persona}.json`);
      writeFileSync(subtasks, JSON.stringify([{ id: 'T1', verb: 'compose', branch: 'feat/x', blocked_by: [], status: 'in_progress' }]));
      orch(['plan-set', '--workflow-path', macroPath, '--host', 'claude', '--subtasks-json-file', subtasks]);
      const child = create(repo.lane, 'feat/x', repo.head, {}, ['--parent-workflow', macroId, '--originating-subtask', 'T1']);
      strictEqual(child.status, 0, child.stderr);
      git(repo.lane, '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'feat: u4d child work');
      // A second active macro on the macro's branch, in the lane's own home:
      // the lane's readers see both.
      const second = join(repo.lane, '.agentic-plugins/state/orchestrator/workflows/macro-plan-20261008T000000Z-d4d4d4.md');
      mkdirSync(dirname(second), { recursive: true });
      writeFileSync(second, asId(readFileSync(macroPath, 'utf8'), 'macro-plan-20261008T000000Z-d4d4d4'));
      const before = readFileSync(macroPath, 'utf8');
      const { writebackParent } = await import(script('parent-writeback.mjs'));
      const err = [];
      // This process runs in the agentic-plugins checkout, another repository.
      const result = await writebackParent({
        repoRoot: repo.lane, parentWorkflowId: macroId, originatingSubtaskId: 'T1',
        engineerWorkflowId: basename(child.stdout.trim(), '.md'), commit: git(repo.lane, 'rev-parse', 'HEAD'), host: 'claude',
        orchestratorRoot: join(REPO_ROOT, 'plugins/orchestrator'), stderr: { write: (t) => err.push(t) },
      });
      notStrictEqual(result.ok, true, err.join(''));
      match(err.join(''), /2 active workflows on branch "main"/);
      strictEqual(readFileSync(macroPath, 'utf8'), before, 'the macro was not written');
    });

    it('one workflow reached through two names in its home is one workflow: found and written', () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      symlinkSync(path, join(wfDir(repo.main), 'decide-20261008T000000Z-a1a5ed.md'));
      const found = findActive(repo.lane, 'feat/x');
      strictEqual(found.status, 0, found.stderr);
      strictEqual(found.stdout.trim(), path, 'the file itself, not the link');
      strictEqual(runIn(repo.lane, appendArgs(path)).status, 0);
      strictEqual(runIn(repo.lane, terminal(path)).status, 0);
    });

    it("a slot under a home linked to another checkout's is neither read nor consumed", async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      strictEqual(runIn(repo.main, terminal(path)).status, 0);
      ok(existsSync(slot(repo.main)), "the main checkout's slot");
      mkdirSync(join(repo.lane, '.agentic-plugins/state'), { recursive: true });
      symlinkSync(join(repo.main, home), join(repo.lane, home));
      const handoff = await import(script('session-handoff.mjs'));
      strictEqual(await handoff.readPendingHandoff(repo.lane), null);
      strictEqual(await handoff.pendingHandoffReinjectionLine(repo.lane), null);
      await handoff.consumePendingHandoff(slot(repo.lane), repo.lane);
      ok(existsSync(slot(repo.main)), 'the slot is still there');
      for (const host of ['claude', 'codex']) {
        const hook = join(pluginRoot(persona), `adapters/${host}/hooks/session-start.mjs`);
        const ran = spawnSync(process.execPath, [hook], { cwd: repo.lane, input: JSON.stringify({ cwd: repo.lane }), encoding: 'utf8', env: cleanEnv() });
        strictEqual(ran.status, 0, ran.stderr);
        ok(!ran.stdout.includes(`[${persona}-handoff-pending]`), ran.stdout);
        ok(existsSync(slot(repo.main)), `the ${host} SessionStart in the lane left the main checkout's slot`);
      }
      strictEqual((await handoff.readPendingHandoff(repo.main))?.projectionFile, slot(repo.main), "control: the main checkout reads its own");
    });

    it('a ledger that cannot be judged is no absence: settle with no run id refuses', { skip: asRoot && 'root reads any directory' }, async () => {
      reset();
      const workflowPath = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-u4d005';
      const runner = await ensembleRun(workflowPath, runId);
      writeFileSync(workflowPath, readFileSync(workflowPath, 'utf8').replace(/^pending_ensemble:\n(?:  .*\n)+/m, 'pending_ensemble: []\n'));
      const runDir = join(repo.main, home, 'peer-runs', runId);
      execFileSync('chmod', ['000', runDir]);
      try {
        await rejects(
          runner.settleEnsemble({ repoRoot: repo.main, workflowPath, phase: 'compose', runId: '', verdict: 'agreed', summary: 'u4d' }),
          /cannot tell whether/,
        );
      } finally {
        execFileSync('chmod', ['755', runDir]);
      }
      await rejects(
        runner.settleEnsemble({ repoRoot: repo.main, workflowPath, phase: 'compose', runId: '', verdict: 'agreed', summary: 'u4d' }),
        /unsettled ensemble attempt/,
        'control: readable, the attempt is found',
      );
    });

    it('a link in a peer-runs directory is no ledger, whatever it names: the sweep reads the directories alone', async () => {
      reset();
      const workflowPath = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-u4d006';
      const runner = await ensembleRun(workflowPath, runId);
      const inMain = join(repo.main, home, 'peer-runs', runId);
      const laneRuns = join(repo.lane, home, 'peer-runs');
      mkdirSync(laneRuns, { recursive: true });
      const elsewhere = join(dir, `ledger-copy-${persona}`);
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
      ok(!existsSync(inMain) && lstatSync(join(laneRuns, runId)).isSymbolicLink() && existsSync(join(elsewhere, 'handle.json')),
        'the directory is pruned; the link, and what the first one named, are left alone');
    });

    it("the sweep reports the checkout's own directory when it is linked to another root's", async () => {
      reset();
      const workflowPath = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runner = await ensembleRun(workflowPath, 'plan-verify-20261008T000000Z-u4d007');
      mkdirSync(join(repo.lane, home), { recursive: true });
      symlinkSync(join(repo.main, home, 'peer-runs'), join(repo.lane, home, 'peer-runs'));
      const report = await runner.sweepPeerRuns({ repoRoot: repo.lane });
      strictEqual(report.root, join(repo.lane, home, 'peer-runs'));
    });

    it('a FIFO in another root refuses the copy scan at once, never waited on: runtime reads it as no regular file too', () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      mkdirSync(wfDir(repo.other), { recursive: true });
      const fifo = join(wfDir(repo.other), 'decide-20261008T000000Z-f1f0f1.md');
      execFileSync('mkfifo', [fifo]);
      const refused = runIn(repo.lane, appendArgs(path), {}, 20_000);
      strictEqual(refused.error?.code, undefined, 'not waited on');
      strictEqual(refused.status, 1, refused.stderr);
      match(refused.stderr, /not a regular file/);
      rmSync(fifo);
      const appended = runIn(repo.lane, appendArgs(path));
      strictEqual(appended.status, 0, `control: ${appended.stderr}`);
    });

    it('a name listed but gone by its read is no workflow and no copy', async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      // Two files an archive moves between the listing and the read: their
      // open fails ENOENT. One holds a second workflow on the branch, the
      // other the record's own name.
      const second = join(wfDir(repo.main), 'decide-20261008T000000Z-90e90e.md');
      writeFileSync(second, readFileSync(path, 'utf8').replace(/workflow_id: "[^"]+"/, 'workflow_id: "decide-20261008T000000Z-90e90e"'));
      mkdirSync(wfDir(repo.lane), { recursive: true });
      const sameName = join(wfDir(repo.lane), basename(path));
      writeFileSync(sameName, readFileSync(path, 'utf8'));
      const state = await import(script('state.mjs'));
      const realOpen = nodeFs.openSync;
      nodeFs.openSync = function openSync(file, ...rest) {
        if (file === second || file === sameName) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
        return realOpen.call(this, file, ...rest);
      };
      try {
        strictEqual(await state.findActiveWorkflowByBranch(repo.lane, 'feat/x'), path);
        await state.appendPhase({ workflowPath: path, host: 'claude', phaseLabel: 'P', phaseNote: 'gone', event: 'updated' });
      } finally {
        nodeFs.openSync = realOpen;
      }
      ok(readFileSync(path, 'utf8').includes('gone'), 'written');
    });
  });

  describe(`${persona}: every --repo-root command judges that checkout, and one rule for every listing (ADR-0067 Decisions 1, 2, 4)`, () => {
    let dir;
    let repo;
    const runIn = (cwd, args, env = {}, timeout = undefined) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: cleanEnv(env), timeout });
    const appendArgs = (path) => ['append', '--workflow-path', path, '--host', 'claude', '--phase-label', 'P', '--phase-note', 'u4e', '--event', 'updated'];
    const terminal = (path) => ['set-terminal', '--workflow-path', path, '--host', 'claude', '--terminal-phase', 'summary-complete', '--terminal-marker', 'true', '--next-action', 'archive'];
    const asId = (text, id) => text.replace(/workflow_id: "[^"]+"/, `workflow_id: "${id}"`);
    const script = (name) => pathToFileURL(join(pluginRoot(persona), 'scripts', name)).href;
    const runnerCli = join(pluginRoot(persona), 'scripts/peer-runner.mjs');
    const reset = () => {
      for (const root of [repo.main, repo.lane, repo.other]) {
        rmSync(join(root, '.agentic-plugins'), { recursive: true, force: true });
        rmSync(join(root, '.claude'), { recursive: true, force: true });
      }
    };
    // A second active workflow on feat/x in the lane's own home: the lane's
    // readers see it beside the main checkout's record; the main checkout's do
    // not.
    const plantSecond = (path, id) => {
      mkdirSync(wfDir(repo.lane), { recursive: true });
      const second = join(wfDir(repo.lane), `${id}.md`);
      writeFileSync(second, asId(readFileSync(path, 'utf8'), id));
      return second;
    };
    const fakeCompanions = () => {
      const companions = join(dir, 'fake-companions');
      mkdirSync(companions, { recursive: true });
      writeFileSync(join(companions, 'discover-peer.mjs'),
        'export async function discoverPeerCompanion({ peer } = {}) { return { ok: true, path: new URL("./" + peer + "-companion.mjs", import.meta.url).pathname }; }\n');
      writeFileSync(join(companions, 'codex-companion.mjs'),
        "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ status: 'success', peer_host: 'codex', peer_model: null, stdout: 'ok', exit_code: 0 }));\n",
        { mode: 0o755 });
      return companions;
    };
    const ensembleRun = async (workflowPath, runId, root = repo.main) => {
      const runner = await import(script('peer-runner.mjs'));
      await runner.runPeer({
        repoRoot: root, runId, kind: 'ensemble', workflowPath, phase: 'compose', ensembleType: 'plan-verify',
        host: 'claude', peer: 'codex', promptText: '<task>u4e</task>', outputFormat: 'json', cwd: root,
        env: { ...cleanEnv(), AGENTIC_COMPANIONS_ROOT: fakeCompanions() },
      });
      return runner;
    };
    const dropPending = (workflowPath) => writeFileSync(workflowPath, readFileSync(workflowPath, 'utf8').replace(/^pending_ensemble:\n(?:  .*\n)+/m, 'pending_ensemble: []\n'));
    before(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), `state-root-u4e-${persona}-`)));
      repo = makeRepo(dir);
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    it('archive --repo-root <lane>, run from outside every repository, judges the lane: a second workflow there refuses', () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      strictEqual(runIn(repo.main, terminal(path)).status, 0);
      plantSecond(path, 'decide-20261008T000000Z-e4e001');
      const archive = (checkout) => runIn(dir, ['archive', '--workflow-path', path, '--host', 'claude', '--repo-root', checkout]);
      const refused = archive(repo.lane);
      strictEqual(refused.status, 1, refused.stderr);
      match(refused.stderr, /2 active workflows on branch "feat\/x"/);
      ok(existsSync(path), 'not archived');
      const control = archive(repo.main);
      strictEqual(control.status, 0, `control: the main checkout's read set holds one (${control.stderr})`);
      ok(!existsSync(path), 'archived from the main checkout');
    });

    it('peer-runner settle --repo-root <lane>, run from outside every repository, judges the lane', async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-e4e002';
      await ensembleRun(path, runId);
      plantSecond(path, 'decide-20261008T000000Z-e4e002');
      const settle = (checkout) => spawnSync(process.execPath, [
        runnerCli, 'settle', '--repo-root', checkout, '--workflow-path', path, '--phase', 'compose',
        '--run-id', runId, '--verdict', 'agreed', '--summary', 'u4e', '--host', 'claude',
      ], { cwd: dir, encoding: 'utf8', env: cleanEnv() });
      const refused = settle(repo.lane);
      notStrictEqual(refused.status, 0, refused.stdout);
      match(refused.stderr, /2 active workflows on branch "feat\/x"/);
      ok(!(readFileSync(path, 'utf8').split('ensemble_results:')[1] ?? '').includes(runId), 'nothing settled');
      const control = settle(repo.main);
      strictEqual(control.status, 0, control.stderr);
      match(control.stderr, /settlement: committed/);
    });

    it('settleEnsemble called as an API judges the checkout repoRoot names, from outside every repository', async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-a4a007';
      const runner = await ensembleRun(path, runId);
      plantSecond(path, 'decide-20261008T000000Z-a4a007');
      // This test process runs outside the fixture repository: only the
      // checkout repoRoot names puts the lane's second workflow in view.
      await rejects(
        runner.settleEnsemble({ repoRoot: repo.lane, workflowPath: path, phase: 'compose', runId, verdict: 'agreed', summary: 'u4g' }),
        /2 active workflows on branch "feat\/x"/,
      );
      ok(!(readFileSync(path, 'utf8').split('ensemble_results:')[1] ?? '').includes(runId), 'nothing settled');
      const control = await runner.settleEnsemble({ repoRoot: repo.main, workflowPath: path, phase: 'compose', runId, verdict: 'agreed', summary: 'u4g' });
      strictEqual(control.settlement, 'committed', JSON.stringify(control));
    });

    it('a link in place of a run directory is no ledger: settle with no run id and the sweep pass it by, as runtime does', async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-e4e003';
      const runner = await ensembleRun(path, runId);
      dropPending(path);
      const inHome = join(repo.main, home, 'peer-runs', runId);
      const elsewhere = join(dir, `linked-ledger-${persona}`);
      rmSync(elsewhere, { recursive: true, force: true });
      cpSync(inHome, elsewhere, { recursive: true });
      rmSync(inHome, { recursive: true, force: true });
      symlinkSync(elsewhere, inHome);
      const report = await runner.sweepPeerRuns({ repoRoot: repo.main, applyRetention: true, now: new Date('2031-01-01T00:00:00Z') });
      strictEqual(report.scanned, 0, 'no ledger read through the link');
      deepStrictEqual([report.planned_prunes, report.pruned], [[], []]);
      ok(lstatSync(inHome).isSymbolicLink() && existsSync(join(elsewhere, 'handle.json')), 'the link and what it names are left alone');
      const settled = await runner.settleEnsemble({ repoRoot: repo.main, workflowPath: path, phase: 'compose', runId: '', verdict: 'agreed', summary: 'u4e' });
      strictEqual(settled.settlement, 'skipped', JSON.stringify(settled));
      // Control: the same ledger as a directory is an attempt settle must name.
      unlinkSync(inHome);
      cpSync(elsewhere, inHome, { recursive: true });
      await rejects(
        runner.settleEnsemble({ repoRoot: repo.main, workflowPath: path, phase: 'compose', runId: '', verdict: 'agreed', summary: 'u4e' }),
        /unsettled ensemble attempt/,
      );
    });

    it('a FIFO in a home of the read set refuses the branch scan at once, never waited on', () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      mkdirSync(wfDir(repo.lane), { recursive: true });
      const fifo = join(wfDir(repo.lane), 'decide-20261008T000000Z-f1f0e4.md');
      execFileSync('mkfifo', [fifo]);
      const found = runIn(repo.lane, ['find-active', '--repo-root', repo.lane, '--branch', 'feat/x'], {}, 20_000);
      strictEqual(found.error?.code, undefined, 'not waited on');
      strictEqual(found.status, 1, found.stderr);
      match(found.stderr, /not a regular file/);
      rmSync(fifo);
      strictEqual(runIn(repo.lane, ['find-active', '--repo-root', repo.lane, '--branch', 'feat/x']).stdout.trim(), path, 'control');
    });

    it('a copy whose workflow_id sits past the first 256 KiB of its frontmatter is a copy', () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const id = basename(path, '.md');
      const text = readFileSync(path, 'utf8');
      // The same record under another name, its id after a long key.
      const late = text.replace(/^workflow_id: .*\n/m, '').replace(/^---\n/, `---\npad: "${'p'.repeat(300 * 1024)}"\nworkflow_id: "${id}"\n`);
      mkdirSync(wfDir(repo.other), { recursive: true });
      writeFileSync(join(wfDir(repo.other), 'decide-20261008T000000Z-1a7e1d.md'), late);
      const refused = runIn(repo.main, appendArgs(path));
      strictEqual(refused.status, 1, refused.stderr);
      match(refused.stderr, /held by 2 files/);
    });

    it('a file reached through two read roots is handed to a writer under the name that is not a link', () => {
      reset();
      const path = create(repo.lane, 'feat/x', repo.head).stdout.trim();
      ok(path.startsWith(join(repo.lane, home)), path);
      mkdirSync(wfDir(repo.main), { recursive: true });
      symlinkSync(path, join(wfDir(repo.main), basename(path)));
      const found = findActive(repo.lane, 'feat/x');
      strictEqual(found.status, 0, found.stderr);
      strictEqual(found.stdout.trim(), path, "the lane's file, not the main checkout's link");
      strictEqual(runIn(repo.lane, appendArgs(found.stdout.trim())).status, 0);
    });

    // U4f — the fifth Plan-verify's findings.
    const markingCompanions = (marker) => {
      const at = join(dir, 'marking-companions');
      mkdirSync(at, { recursive: true });
      writeFileSync(join(at, 'discover-peer.mjs'),
        'export async function discoverPeerCompanion({ peer } = {}) { return { ok: true, path: new URL("./" + peer + "-companion.mjs", import.meta.url).pathname }; }\n');
      writeFileSync(join(at, 'codex-companion.mjs'),
        `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, 'called\\n');\nprocess.stdout.write(JSON.stringify({ status: 'success', peer_host: 'codex', peer_model: null, stdout: 'ok', exit_code: 0 }));\n`,
        { mode: 0o755 });
      return at;
    };
    const later = new Date('2031-01-01T00:00:00Z');

    it('an explicit --repo-root that names no checkout of the repository reads every root of it: a second workflow anywhere refuses', () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      strictEqual(runIn(repo.main, terminal(path)).status, 0);
      plantSecond(path, 'decide-20261008T000000Z-f4f001');
      const elsewhere = join(dir, 'another-repository');
      if (!existsSync(elsewhere)) {
        mkdirSync(elsewhere);
        git(elsewhere, 'init', '-q', '-b', 'main');
      }
      const unrelated = join(dir, 'unrelated-directory');
      mkdirSync(unrelated, { recursive: true });
      // Run from the lane: the mistyped option must not narrow the guard to
      // the storage root, whose own read set holds one.
      const archive = (named) => runIn(repo.lane, ['archive', '--workflow-path', path, '--host', 'claude', '--repo-root', named]);
      for (const named of [unrelated, join(dir, 'no-such-directory'), elsewhere]) {
        const refused = archive(named);
        strictEqual(refused.status, 1, `${named}: ${refused.stderr}`);
        match(refused.stderr, /2 active workflows on branch "feat\/x"/);
        ok(existsSync(path), 'not archived');
      }
      const control = archive(repo.main);
      strictEqual(control.status, 0, `control: the main checkout named, its read set holds one (${control.stderr})`);
      ok(!existsSync(path));
    });

    it('an ensemble run the write guard refuses writes no ledger and calls no companion', () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      plantSecond(path, 'decide-20261008T000000Z-f4f009');
      const marker = join(dir, `companion-called-${persona}`);
      rmSync(marker, { force: true });
      const companions = markingCompanions(marker);
      const launch = (checkout, runId) => spawnSync(process.execPath, [
        runnerCli, 'run', '--repo-root', checkout, '--kind', 'ensemble', '--peer', 'codex', '--prompt-text', '<task>u4f</task>',
        '--workflow-path', path, '--phase', 'compose', '--ensemble-type', 'plan-verify', '--run-id', runId,
        '--host', 'claude', '--cwd', checkout, '--output-format', 'json',
      ], { cwd: dir, encoding: 'utf8', env: cleanEnv({ AGENTIC_COMPANIONS_ROOT: companions }) });
      const runId = 'plan-verify-20261008T000000Z-f4f009';
      const refused = launch(repo.lane, runId);
      notStrictEqual(refused.status, 0, refused.stdout);
      match(refused.stderr, /2 active workflows on branch "feat\/x"/);
      ok(!/pending registration failed/.test(refused.stderr), 'refused before the run, not after');
      for (const root of [repo.main, repo.lane, repo.other]) ok(!existsSync(join(root, home, 'peer-runs', runId)), `no ledger in ${root}`);
      ok(!existsSync(marker), 'no companion called');
      ok(!readFileSync(path, 'utf8').includes(runId), 'no pending row');
      const control = launch(repo.main, 'plan-verify-20261008T000000Z-f4f019');
      strictEqual(control.status, 0, `control: ${control.stderr}`);
      ok(existsSync(marker), 'control: the companion called');
      ok(existsSync(join(repo.main, home, 'peer-runs', 'plan-verify-20261008T000000Z-f4f019')));
    });

    it('a link beside a ledger is no second name: the sweep reads and prunes the directory itself', async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-f4f003';
      const runner = await ensembleRun(path, runId);
      const mainRuns = join(repo.main, home, 'peer-runs');
      const laneRuns = join(repo.lane, home, 'peer-runs');
      mkdirSync(laneRuns, { recursive: true });
      // The real directory in the lane, read after the main checkout's link.
      renameSync(join(mainRuns, runId), join(laneRuns, runId));
      symlinkSync(join(laneRuns, runId), join(mainRuns, runId));
      const report = await runner.sweepPeerRuns({ repoRoot: repo.lane, applyRetention: true, now: later });
      strictEqual(report.scanned, 1);
      deepStrictEqual(report.prune_skipped, []);
      deepStrictEqual(report.pruned.map((p) => p.run_id), [runId], 'swept through the directory itself, so retention runs');
      ok(!existsSync(join(laneRuns, runId)));
      // A link whose name no ledger may have, listed before the valid name.
      const second = 'plan-verify-20261008T000000Z-f4f013';
      await ensembleRun(path, second);
      symlinkSync(join(mainRuns, second), join(mainRuns, 'A alias'));
      const preview = await runner.sweepPeerRuns({ repoRoot: repo.main, now: later });
      strictEqual(preview.scanned, 1);
      deepStrictEqual(preview.planned_prunes.map((p) => p.run_id), [second]);
    });

    it('a run id two ledgers hold is swept in neither, a link beside them notwithstanding', async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-f4f004';
      const runner = await ensembleRun(path, runId);
      const inMain = join(repo.main, home, 'peer-runs', runId);
      const laneRuns = join(repo.lane, home, 'peer-runs');
      mkdirSync(laneRuns, { recursive: true });
      cpSync(inMain, join(laneRuns, runId), { recursive: true });
      symlinkSync(inMain, join(laneRuns, 'plan-verify-20261008T000000Z-f4f0a1'));
      const report = await runner.sweepPeerRuns({ repoRoot: repo.lane, applyRetention: true, now: later });
      deepStrictEqual(report.ambiguous.map((a) => a.run_id), [runId]);
      strictEqual(report.scanned, 0, 'neither ledger, under any name');
      deepStrictEqual(report.planned_prunes, []);
      ok(existsSync(join(inMain, 'handle.json')) && existsSync(join(laneRuns, runId, 'handle.json')));
    });

    it('a link to a file under a run id is no ledger: the id is free, as every listing says', async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-f4f008';
      const laneRuns = join(repo.lane, home, 'peer-runs');
      mkdirSync(laneRuns, { recursive: true });
      const notLedger = join(dir, `not-a-ledger-${persona}`);
      writeFileSync(notLedger, 'x');
      symlinkSync(notLedger, join(laneRuns, runId));
      const runner = await ensembleRun(path, runId, repo.lane);
      ok(existsSync(join(repo.main, home, 'peer-runs', runId, 'handle.json')), "the run, in its workflow's home");
      strictEqual((await runner.statusPeerRun({ repoRoot: repo.lane, runId })).run_id, runId, 'read from the lane: one ledger');
    });

    it("the lister hands out the name that is not a link of a file reached through two read roots, as the Stop's sweep archives by it", async () => {
      reset();
      const path = create(repo.lane, 'feat/x', repo.head).stdout.trim();
      ok(path.startsWith(join(repo.lane, home)), path);
      mkdirSync(wfDir(repo.main), { recursive: true });
      symlinkSync(path, join(wfDir(repo.main), basename(path)));
      const state = await import(script('state.mjs'));
      deepStrictEqual(await state.listWorkflowFilesAllHomes(repo.lane), [path], "the lane's file, not the main checkout's link read first");
    });

    it('peer-runner --repo-root with no path is a usage error, not a crash', () => {
      const ran = spawnSync(process.execPath, [runnerCli, 'status', '--run-id', 'plan-verify-20261008T000000Z-f4f011', '--repo-root'], { cwd: dir, encoding: 'utf8', env: cleanEnv() });
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
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-a4a001';
      const runner = await ensembleRun(path, runId);
      const runDir = join(repo.main, home, 'peer-runs', runId);
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
      deepStrictEqual(report.planned_prunes.map((p) => p.run_id), [runId]);
      deepStrictEqual(report.prune_skipped, [{ run_id: runId, reason: 'replaced' }]);
      deepStrictEqual(report.pruned, []);
      ok(existsSync(join(runDir, 'handle.json')), 'the recreated ledger is kept');
      const again = await runner.sweepPeerRuns({ repoRoot: repo.main, applyRetention: true, now: new Date('2032-01-01T00:00:00Z'), retentionTtlDays: 0 });
      deepStrictEqual(again.pruned.map((p) => p.run_id), [runId], 'control: planned anew, it is pruned');
    });

    it('the sweep checks its selection again before each change: a second ledger made meanwhile leaves both', async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-a4a002';
      const runner = await ensembleRun(path, runId);
      const runDir = join(repo.main, home, 'peer-runs', runId);
      const inLane = join(repo.lane, home, 'peer-runs', runId);
      const copy = join(dir, `planned-copy-${persona}`);
      rmSync(copy, { recursive: true, force: true });
      cpSync(runDir, copy, { recursive: true });
      // The fourth lstat of the run directory is the last check, made once
      // the prune has claimed the directory it judges (U4j).
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
      deepStrictEqual(report.ambiguous.map((a) => a.run_id), [runId], 'reported as the run id two ledgers hold');
      ok(existsSync(join(runDir, 'handle.json')) && existsSync(join(inLane, 'handle.json')), 'neither ledger was deleted');
    });

    it('a second ledger made in an empty legacy home since the plan is seen right before the deletion', { skip: persona !== 'engineer' && 'no legacy home' }, async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-a4b001';
      const runner = await ensembleRun(path, runId);
      const runDir = join(repo.main, home, 'peer-runs', runId);
      const inLegacy = join(repo.main, '.claude', `agentic-${persona}`, 'peer-runs', runId);
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
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-a4b002';
      const runner = await ensembleRun(path, runId);
      const runDir = join(repo.main, home, 'peer-runs', runId);
      const handleFile = join(runDir, 'handle.json');
      writeFileSync(handleFile, `${JSON.stringify({ ...JSON.parse(readFileSync(handleFile, 'utf8')), status: 'running', completed_at: null }, null, 2)}\n`);
      const inLane = join(repo.lane, home, 'peer-runs', runId);
      // The second lstat of the run directory is the check at the write.
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

    it('a link where a run id has no ledger is refused by status and settle, never read through', async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-a4b003';
      const runner = await ensembleRun(path, runId);
      const inHome = join(repo.main, home, 'peer-runs', runId);
      const elsewhere = join(dir, `unlisted-ledger-${persona}`);
      rmSync(elsewhere, { recursive: true, force: true });
      renameSync(inHome, elsewhere);
      symlinkSync(elsewhere, inHome);
      await rejects(runner.statusPeerRun({ repoRoot: repo.main, runId }), /is not a run directory/);
      await rejects(
        runner.settleEnsemble({ repoRoot: repo.main, workflowPath: path, phase: 'compose', runId, verdict: 'agreed', summary: 'u4h' }),
        /is not a run directory/,
      );
      ok(!(readFileSync(path, 'utf8').split('ensemble_results:')[1] ?? '').includes(runId), 'nothing settled');
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
    const runningWithEnvelope = async (path, runId) => {
      const runner = await ensembleRun(path, runId);
      const runDir = join(repo.main, home, 'peer-runs', runId);
      const handleFile = join(runDir, 'handle.json');
      const running = { ...JSON.parse(readFileSync(handleFile, 'utf8')), status: 'running', completed_at: null };
      writeFileSync(handleFile, `${JSON.stringify(running, null, 2)}\n`);
      ok(existsSync(join(runDir, 'envelope.json')), 'the run left an envelope');
      return { runner, runDir, handleFile, running, paths: { dir: runDir, handle: handleFile, envelope: join(runDir, 'envelope.json') } };
    };

    it('the prune deletes only the directory it claimed and judged: a running ledger put in its place before the claim is put back', async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-a4c001';
      const runner = await ensembleRun(path, runId);
      const runDir = join(repo.main, home, 'peer-runs', runId);
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
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-a4c002';
      const runner = await ensembleRun(path, runId);
      const runDir = join(repo.main, home, 'peer-runs', runId);
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
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-a4c007';
      const runner = await ensembleRun(path, runId);
      const runDir = join(repo.main, home, 'peer-runs', runId);
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
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const { runner, runDir, handleFile, running, paths } = await runningWithEnvelope(path, 'plan-verify-20261008T000000Z-a4c003');
      let asked = 0;
      const after = await runner.reconcileOne(paths, running, { staleGraceMs: 0, now: later, guard: () => ++asked === 1 });
      strictEqual(asked, 2, 'asked before the write, and again right before its rename');
      strictEqual(after.status, 'running', "the caller's handle");
      strictEqual(JSON.parse(readFileSync(handleFile, 'utf8')).status, 'running', 'not written');
      deepStrictEqual(readdirSync(runDir).filter((n) => n.endsWith('.tmp')), [], 'no temporary file left');
    });

    it('a guard that cannot judge the run directory propagates from the reconciling write, never recorded as a corrupt envelope', async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const { runner, handleFile, running, paths } = await runningWithEnvelope(path, 'plan-verify-20261008T000000Z-a4c004');
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
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const { runner, runDir, handleFile, running, paths } = await runningWithEnvelope(path, 'plan-verify-20261008T000000Z-a4c008');
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

    // U4l — the U4j review's remaining findings: a prune's claim is its run
    // id's ledger in every ownership check, the sweep puts back one an
    // interrupted prune left, every failure names where the claim is, and the
    // claim name is bounded.
    const claimOf = async (runDir) => {
      const { claimName } = await import(script('lib/state-root.mjs'));
      return join(dirname(runDir), claimName(basename(runDir)));
    };
    // What an interrupted prune leaves: the run directory under its claim name.
    const leaveClaim = async (runDir) => {
      const claim = await claimOf(runDir);
      renameSync(runDir, claim);
      return claim;
    };

    it("a claim an interrupted prune left is its run id's ledger: status, cancel and settle refuse it, and no run takes the run id", async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-a4d001';
      const runner = await ensembleRun(path, runId);
      const runDir = join(repo.main, home, 'peer-runs', runId);
      const claim = await leaveClaim(runDir);
      await rejects(runner.statusPeerRun({ repoRoot: repo.main, runId }), /claimed by a prune/);
      await rejects(runner.cancelPeerRun({ repoRoot: repo.main, runId }), /claimed by a prune/);
      await rejects(
        runner.settleEnsemble({ repoRoot: repo.main, workflowPath: path, phase: 'compose', runId, verdict: 'agreed', summary: 'u4l' }),
        /claimed by a prune/,
      );
      await rejects(ensembleRun(path, runId), /already exists for run_id/);
      ok(!existsSync(runDir), 'no ledger made under the run id');
      ok(existsSync(join(claim, 'handle.json')), 'the claim, untouched');
    });

    it('the unsettled-attempt scan counts an attempt whose ledger a prune claimed: an empty run id cannot hide it', async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-a4d002';
      const runner = await ensembleRun(path, runId);
      dropPending(path);
      await leaveClaim(join(repo.main, home, 'peer-runs', runId));
      await rejects(
        runner.settleEnsemble({ repoRoot: repo.main, workflowPath: path, phase: 'compose', runId: '', verdict: 'agreed', summary: 'u4l' }),
        /unsettled ensemble attempt/,
      );
    });

    it('the sweep puts back a claim an interrupted prune left once no prune can hold it, and leaves a younger one', async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-a4d003';
      const runner = await ensembleRun(path, runId);
      const runDir = join(repo.main, home, 'peer-runs', runId);
      const claim = await leaveClaim(runDir);
      // Just renamed: a prune may be judging it.
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
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-a4d004';
      const runner = await ensembleRun(path, runId);
      const runDir = join(repo.main, home, 'peer-runs', runId);
      // The run id's ledger in the lane's own home too, and the main checkout's claimed.
      const laneRuns = join(repo.lane, home, 'peer-runs');
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

    it('a claim made after the selection leaves its run id alone from then on: neither ledger is swept', async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-a4d008';
      const runner = await ensembleRun(path, runId);
      const runs = join(repo.main, home, 'peer-runs');
      const runDir = join(runs, runId);
      const claim = await claimOf(runDir);
      const real = nodeFs.readdirSync;
      let made = false;
      // Once the selection has listed the directory: a prune's claim on the
      // run id beside it.
      nodeFs.readdirSync = function readdirSync(p, ...rest) {
        const out = real.call(this, p, ...rest);
        if (!made && String(p) === runs && new Error().stack.includes('sweepSelection')) {
          made = true;
          cpSync(runDir, claim, { recursive: true });
        }
        return out;
      };
      let report;
      try {
        report = await runner.sweepPeerRuns({ repoRoot: repo.main, applyRetention: true, now: later, retentionTtlDays: 0 });
      } finally {
        nodeFs.readdirSync = real;
      }
      ok(made, 'the selection listed the directory');
      deepStrictEqual([report.planned_prunes, report.pruned, report.prune_skipped], [[], [], []]);
      deepStrictEqual(report.ambiguous.map((a) => a.run_id), [runId]);
      ok(existsSync(runDir) && existsSync(claim), 'both left');
    });

    it('a claim with no handle naming its run id is reported and left: a deletion that failed partway', async () => {
      reset();
      const runs = join(repo.main, home, 'peer-runs');
      const claim = await claimOf(join(runs, 'plan-verify-20261008T000000Z-a4d005'));
      mkdirSync(claim, { recursive: true });
      writeFileSync(join(claim, 'stdout.log'), 'partly deleted\n');
      const runner = await import(script('peer-runner.mjs'));
      const report = await runner.sweepPeerRuns({ repoRoot: repo.main, applyRetention: true, now: later });
      deepStrictEqual(report.claims, [{ path: claim, run_id: null, state: 'unreadable' }]);
      ok(existsSync(join(claim, 'stdout.log')), 'left');
    });

    it('a judgment that fails names where the claimed directory is left: under its claim name when a ledger took the run id meanwhile', async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-a4d006';
      const runner = await ensembleRun(path, runId);
      const runDir = join(repo.main, home, 'peer-runs', runId);
      const handle = JSON.parse(readFileSync(join(runDir, 'handle.json'), 'utf8'));
      const claim = await claimOf(runDir);
      // The judgment's identity read of the claim fails, after a running
      // ledger was made under the run id.
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
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-a4d007';
      const runner = await ensembleRun(path, runId);
      const runDir = join(repo.main, home, 'peer-runs', runId);
      // A directory in the ledger whose entries cannot be removed.
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
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const prefix = 'plan-verify-20261008T000000Z-';
      const runId = `${prefix}${'a'.repeat(250 - prefix.length)}`;
      const runner = await ensembleRun(path, runId);
      const report = await runner.sweepPeerRuns({ repoRoot: repo.main, applyRetention: true, now: later, retentionTtlDays: 0 });
      deepStrictEqual(report.pruned.map((p) => p.run_id), [runId]);
      deepStrictEqual(claimsIn(join(repo.main, home, 'peer-runs')), [], 'no claim left');
    });

    it('a link made where a run id has no ledger, right after the look, is never read through: status and settle report no ledger', async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-a4c005';
      const runner = await ensembleRun(path, runId);
      const inHome = join(repo.main, home, 'peer-runs', runId);
      const elsewhere = join(dir, `unlisted-ledger-j-${persona}`);
      rmSync(elsewhere, { recursive: true, force: true });
      renameSync(inHome, elsewhere);
      // The lookup asks each home (the first lstat of this path), then looks
      // at the fallback path itself (the second): the link comes after that.
      let restore = onLstatThrow(inHome, 2, () => symlinkSync(elsewhere, inHome));
      try {
        await rejects(runner.statusPeerRun({ repoRoot: repo.main, runId }), /no peer-run ledger for run_id/);
      } finally {
        restore();
      }
      ok(lstatSync(inHome).isSymbolicLink(), 'the link was made');
      unlinkSync(inHome);
      restore = onLstatThrow(inHome, 2, () => symlinkSync(elsewhere, inHome));
      let settled;
      try {
        settled = await runner.settleEnsemble({ repoRoot: repo.main, workflowPath: path, phase: 'compose', runId, verdict: 'agreed', summary: 'u4j' });
      } finally {
        restore();
      }
      ok(lstatSync(inHome).isSymbolicLink(), 'the link was made');
      strictEqual(settled.error_kind, 'ledger_missing', JSON.stringify(settled));
    });

    it("a peer-runs directory that turns into a file after the sweep's selection is refused, not read as missing", async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runner = await ensembleRun(path, 'plan-verify-20261008T000000Z-a4c006');
      const runs = join(repo.main, home, 'peer-runs');
      const moved = join(dir, `moved-runs-${persona}`);
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

    it("a file in a workflow home's place is no empty home: the lister and find-active refuse it, as runtime's readers do", async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      mkdirSync(join(repo.lane, home), { recursive: true });
      writeFileSync(wfDir(repo.lane), 'not a directory');
      const state = await import(script('state.mjs'));
      await rejects(state.listWorkflowFilesAllHomes(repo.lane), (err) => err.code === 'ENOTDIR');
      strictEqual(findActive(repo.lane, 'feat/x').status, 1, 'find-active refuses');
      rmSync(wfDir(repo.lane));
      deepStrictEqual(await state.listWorkflowFilesAllHomes(repo.lane), [path], 'control');
    });

    it('runPeer called as an API judges the checkout repoRoot names: beside a second workflow there, the run is refused before its ledger', async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      plantSecond(path, 'decide-20261008T000000Z-a4a003');
      const runner = await import(script('peer-runner.mjs'));
      const runId = 'plan-verify-20261008T000000Z-a4a003';
      // This test process runs outside the fixture repository: only the
      // checkout repoRoot names puts the lane's second workflow in view.
      await rejects(runner.runPeer({
        repoRoot: repo.lane, runId, kind: 'ensemble', workflowPath: path, phase: 'compose', ensembleType: 'plan-verify',
        host: 'claude', peer: 'codex', promptText: '<task>u4g</task>', outputFormat: 'json', cwd: repo.lane,
        env: { ...cleanEnv(), AGENTIC_COMPANIONS_ROOT: fakeCompanions() },
      }), /2 active workflows on branch "feat\/x"/);
      for (const root of [repo.main, repo.lane, repo.other]) ok(!existsSync(join(root, home, 'peer-runs', runId)), `no ledger in ${root}`);
      ok(!readFileSync(path, 'utf8').includes(runId), 'no pending row');
    });

    it('a second workflow made after the precheck is refused by the locked registration, and the run goes on without a row', async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runner = await import(script('peer-runner.mjs'));
      const runId = 'plan-verify-20261008T000000Z-a4a004';
      // After the precheck, the runner asks whether the run id is free: the
      // second workflow appears then, before the registration's lock.
      const restore = onLstat(join(repo.main, home, 'peer-runs', runId), 1, () => plantSecond(path, 'decide-20261008T000000Z-a4a004'));
      const stderr = [];
      const write = process.stderr.write;
      process.stderr.write = (chunk, ...rest) => { stderr.push(String(chunk)); return true; };
      let result;
      try {
        result = await runner.runPeer({
          repoRoot: repo.lane, runId, kind: 'ensemble', workflowPath: path, phase: 'compose', ensembleType: 'plan-verify',
          host: 'claude', peer: 'codex', promptText: '<task>u4g</task>', outputFormat: 'json', cwd: repo.lane,
          env: { ...cleanEnv(), AGENTIC_COMPANIONS_ROOT: fakeCompanions() },
        });
      } finally {
        process.stderr.write = write;
        restore();
      }
      match(stderr.join(''), /pending registration failed \(continuing\): .*2 active workflows on branch "feat\/x"/);
      ok(result, 'the run went on');
      ok(existsSync(join(repo.main, home, 'peer-runs', runId, 'handle.json')), "the ledger, in the workflow's home");
      ok(!readFileSync(path, 'utf8').includes(runId), 'no pending row');
    });

    it('a stray file or link in the legacy peer-runs directory is no ledger: the sweep and status agree there is one home', { skip: persona !== 'engineer' && 'no legacy home' }, async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-a4a005';
      const runner = await ensembleRun(path, runId);
      const legacyRuns = join(repo.main, '.claude', `agentic-${persona}`, 'peer-runs');
      mkdirSync(legacyRuns, { recursive: true });
      writeFileSync(join(legacyRuns, 'stray'), 'x');
      symlinkSync(join(legacyRuns, 'stray'), join(legacyRuns, 'plan-verify-20261008T000000Z-a4a0f5'));
      strictEqual((await runner.statusPeerRun({ repoRoot: repo.main, runId })).run_id, runId);
      const report = await runner.sweepPeerRuns({ repoRoot: repo.main });
      strictEqual(report.scanned, 1, 'the canonical ledger, no dual-home refusal');
      mkdirSync(join(legacyRuns, 'plan-verify-20261008T000000Z-a4a0d5'));
      await rejects(runner.sweepPeerRuns({ repoRoot: repo.main }), /both .* contain peer-run ledgers/, 'control: a run directory there is a second home');
    });

    it("the lister refuses a FIFO in a workflow home, which the Stop's sweep would otherwise wait on", async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const fifo = join(wfDir(repo.main), 'decide-20261008T000000Z-f1f0e5.md');
      execFileSync('mkfifo', [fifo]);
      const state = await import(script('state.mjs'));
      try {
        await rejects(state.listWorkflowFilesAllHomes(repo.lane), /is not a regular file/);
      } finally {
        rmSync(fifo);
      }
      deepStrictEqual(await state.listWorkflowFilesAllHomes(repo.lane), [path], 'control');
    });

    it("a FIFO in the record's place is refused by the write guard at once, never waited on", () => {
      reset();
      create(repo.main, 'feat/x', repo.head);
      const fifo = join(wfDir(repo.main), 'decide-20261008T000000Z-f1f0a5.md');
      execFileSync('mkfifo', [fifo]);
      try {
        const written = runIn(repo.lane, appendArgs(fifo), {}, 20_000);
        strictEqual(written.error?.code, undefined, 'not waited on');
        strictEqual(written.status, 1, written.stdout);
      } finally {
        rmSync(fifo);
      }
    });

    it('the SessionStart hooks report a lookup the scans refuse, rather than show no active workflow, and go on to the handoff backstop', () => {
      reset();
      create(repo.main, 'feat/x', repo.head);
      mkdirSync(wfDir(repo.lane), { recursive: true });
      const fifo = join(wfDir(repo.lane), 'decide-20261008T000000Z-f1f0e6.md');
      execFileSync('mkfifo', [fifo]);
      // A pending handoff in the lane: the backstop re-surfaces and consumes it.
      const pendingSlot = join(repo.lane, home, 'last-session-handoff.json');
      const projection = JSON.stringify({ workflow_id: 'decide-20261008T000000Z-f1f0e7', workflow_kind: persona, archive_gate: 'archived', routing_recommendation: 'fresh' });
      try {
        for (const host of ['claude', 'codex']) {
          writeFileSync(pendingSlot, projection);
          const hook = join(pluginRoot(persona), `adapters/${host}/hooks/session-start.mjs`);
          const ran = spawnSync(process.execPath, [hook], { cwd: repo.lane, input: JSON.stringify({ cwd: repo.lane }), encoding: 'utf8', env: cleanEnv(), timeout: 20_000 });
          strictEqual(ran.error?.code, undefined, `${host}: not waited on`);
          strictEqual(ran.status, 0, `${host}: nonfatal (${ran.stderr})`);
          match(ran.stderr, new RegExp(`${persona}/session-start: no active workflow shown: .*not a regular file`), host);
          ok(ran.stdout.includes(`[${persona}-handoff-pending]`), `${host}: the backstop ran after the refusal (${ran.stdout})`);
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

    it('a ledger with no valid name is never swept, and a valid name linked to it gives it none', async () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head).stdout.trim();
      const runId = 'plan-verify-20261008T000000Z-a4a006';
      const runner = await ensembleRun(path, runId);
      const runs = join(repo.main, home, 'peer-runs');
      renameSync(join(runs, runId), join(runs, 'not a run id'));
      symlinkSync(join(runs, 'not a run id'), join(runs, runId));
      const report = await runner.sweepPeerRuns({ repoRoot: repo.main, applyRetention: true, now: later, retentionTtlDays: 0 });
      strictEqual(report.scanned, 0);
      deepStrictEqual(report.pruned, []);
      ok(existsSync(join(runs, 'not a run id', 'handle.json')));
    });

    const phase7 = join(pluginRoot(persona), 'scripts/phase7-commit.mjs');
    it('Phase 7 from outside every repository judges the lane it names: a second workflow on the branch refuses the commit', { skip: !existsSync(phase7) && 'no Phase 7 driver' }, () => {
      reset();
      // The state homes stay out of the commit and the clean check, as a
      // real checkout's ignore rules keep them.
      writeFileSync(join(repo.main, '.git/info/exclude'), '.agentic-plugins/\n.claude/\n');
      git(repo.lane, 'checkout', '-q', '--', '.');
      // The record in the main checkout, whose own read set holds it alone; the
      // second workflow in the lane, which only the lane's read set holds: the
      // commit is refused only when the guard judges the lane --repo-root names.
      const path = create(repo.main, 'feat/x', git(repo.lane, 'rev-parse', 'HEAD')).stdout.trim();
      ok(path.startsWith(join(repo.main, home)), path);
      strictEqual(run(['record-composed-file', '--workflow-path', path, '--path', 'README.md', '--op', 'edit']).status, 0);
      writeFileSync(join(repo.lane, 'README.md'), `u4e ${persona}\n`);
      const second = plantSecond(path, 'decide-20261008T000000Z-e4e007');
      const before = git(repo.lane, 'rev-parse', 'HEAD');
      const commit = () => spawnSync(process.execPath, [
        phase7, '--mode', 'execute', '--workflow-path', path, '--repo-root', repo.lane, '--host', 'claude',
        '--subject', 'docs: u4e phase 7 collision', '--confirm-non-interactive', '--lenient-cc',
      ], { cwd: dir, encoding: 'utf8', env: cleanEnv() });
      const refused = commit();
      notStrictEqual(refused.status, 0, refused.stdout);
      match(refused.stderr, /2 active workflows on branch "feat\/x"/);
      strictEqual(git(repo.lane, 'rev-parse', 'HEAD'), before, 'no commit');
      ok(!/terminal_marker: true/.test(readFileSync(path, 'utf8')));
      rmSync(second);
      const landed = commit();
      strictEqual(landed.status, 0, `control: alone on its branch, it commits (${landed.stderr})`);
      notStrictEqual(git(repo.lane, 'rev-parse', 'HEAD'), before);
    });
  });
}
