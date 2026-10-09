// ADR-0067 Decision 4, item 5 (SR, U7b): the interactive commands' admission
// entries in the locks an autopilot run takes, through `state.mjs admission
// join|check|release` and scripts/lib/run-locks.mjs, where the lock primitive
// now lives (the Claude adapter's ledger.mjs re-exports it).
//
// Real git repositories: a main checkout and a linked worktree `lane`. The
// macro lock lives under the main checkout; /orchestrator:next also joins the
// worktree lock of the checkout it runs in.

import { describe, it, before, after, beforeEach } from 'node:test';
import { deepStrictEqual, match, ok, rejects, strictEqual } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const ORCH_STATE = join(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');
const locks = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/run-locks.mjs')).href);
const ledger = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/ledger.mjs')).href);

const MACRO = 'macro-plan-20261008T000000Z-ad0001';
const OTHER_MACRO = 'macro-plan-20261008T000000Z-ad0002';
const RUN = 'autopilot-20261008T000000Z-ad0001';
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
const admission = (args, env = {}, cwd = undefined) => spawnSync(process.execPath, [ORCH_STATE, 'admission', ...args], { cwd, encoding: 'utf8', env: cleanEnv(env) });
const sha = (s) => createHash('sha256').update(s).digest('hex');

describe('admission entries in the run locks (ADR-0067 Decision 4, item 5)', () => {
  let dir;
  let repo;
  let macroLock;
  let laneLock;
  const sessionEntries = (lock) => (existsSync(lock) ? readdirSync(lock).filter((n) => /^s-[0-9a-f]{32}\.json$/.test(n)) : []);
  const join_ = (command, checkout, macro = MACRO, env = {}) => admission(['join', '--macro', macro, '--checkout', checkout, '--command', command, '--host', 'claude', '--session-id', 'sess-1'], env);
  const check = (id, checkout, macro = MACRO, env = {}) => admission(['check', '--macro', macro, '--checkout', checkout, '--admission', id], env);
  const release = (id, checkout, macro = MACRO) => admission(['release', '--macro', macro, '--checkout', checkout, '--admission', id]);
  // A run holding a lock: this test process, alive, with a known secret.
  const holdAsRun = async (lock, token = 'the-run-secret') => ledger.acquireLock(lock, {
    record: { run_id: RUN, repo: repo.lane, macro_id: MACRO, started_at: new Date().toISOString(), token_digest: sha(token) },
  });

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'admission-')));
    const main = join(dir, 'repo');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    writeFileSync(join(main, 'README.md'), 'x\n');
    git(main, 'add', 'README.md');
    git(main, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'feat/x', join(dir, 'lane'));
    repo = { main: realpathSync(main), lane: realpathSync(join(dir, 'lane')) };
    repo.laneSub = join(repo.lane, 'sub', 'dir');
    mkdirSync(repo.laneSub, { recursive: true });
    macroLock = locks.macroLockPath(repo.main, MACRO);
    laneLock = locks.worktreeLockPath(repo.lane);
  });
  beforeEach(() => {
    for (const root of [repo.main, repo.lane, repo.laneSub]) rmSync(join(root, '.agentic-plugins'), { recursive: true, force: true });
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('the lock primitive lives in scripts/lib/run-locks.mjs, and ledger.mjs re-exports that one', () => {
    for (const name of ['acquireLock', 'holderAlive', 'listLocks', 'macroLockPath', 'mainWorktreeRoot', 'processFingerprint', 'provablySame', 'readLockEntries', 'worktreeLockPath', 'LockHeldError']) {
      strictEqual(ledger[name], locks[name], name);
    }
  });

  it('join writes one entry in each lock its command joins; check sees it; release removes it, and check then stops', () => {
    const joined = join_('next', repo.lane);
    strictEqual(joined.status, 0, joined.stderr);
    const id = joined.stdout.trim();
    match(id, /^[0-9a-f]{32}$/);
    deepStrictEqual(sessionEntries(laneLock), [`s-${id}.json`], "next joins the lane's worktree lock");
    deepStrictEqual(sessionEntries(macroLock), [`s-${id}.json`], 'and the macro lock, under the main checkout');
    const entry = JSON.parse(readFileSync(join(macroLock, `s-${id}.json`), 'utf8'));
    deepStrictEqual(
      { ...entry, acquired_at: typeof entry.acquired_at },
      { kind: 'session', admission_id: id, command: 'next', macro_id: MACRO, checkout: repo.lane, host: 'claude', session_id: 'sess-1', acquired_at: 'string' },
    );
    strictEqual(check(id, repo.lane).status, 0);
    strictEqual(release(id, repo.lane).status, 0);
    deepStrictEqual([...sessionEntries(laneLock), ...sessionEntries(macroLock)], []);
    const stopped = check(id, repo.lane);
    strictEqual(stopped.status, 1);
    match(stopped.stderr, /is gone from .*Stop before acting/);
    strictEqual(release(id, repo.lane).status, 0, 'release again: nothing left, no error');
    const done = join_('done', repo.lane);
    strictEqual(done.status, 0, done.stderr);
    deepStrictEqual(sessionEntries(laneLock), [], 'done joins the macro lock only');
    deepStrictEqual(sessionEntries(macroLock), [`s-${done.stdout.trim()}.json`]);
  });

  it('check stops when any entry of the admission is gone, or it was made for another checkout', () => {
    const id = join_('next', repo.lane).stdout.trim();
    rmSync(join(laneLock, `s-${id}.json`));
    const stopped = check(id, repo.lane);
    strictEqual(stopped.status, 1);
    match(stopped.stderr, /gone from .*worktree\.lock/);
    strictEqual(release(id, repo.lane).status, 0);
    const done = join_('done', repo.lane).stdout.trim();
    strictEqual(check(done, repo.lane).status, 0);
    const elsewhere = check(done, repo.main);
    strictEqual(elsewhere.status, 1);
    match(elsewhere.stderr, /was made for the checkout/);
  });

  it('a second join beside a live admission is refused, naming the holder and how to release it, and writes nothing', () => {
    const first = join_('next', repo.lane).stdout.trim();
    for (const [command, macro] of [['done', MACRO], ['finalize', MACRO], ['next', OTHER_MACRO]]) {
      const refused = join_(command, repo.lane, macro);
      strictEqual(refused.status, 1, `${command} ${macro}: ${refused.stderr}`);
      match(refused.stderr, /an interactive session holds .*\/orchestrator:next, checkout .*lane, host claude, session sess-1, admitted \d+ min ago, admission [0-9a-f]{32}/);
      ok(refused.stderr.includes(`state.mjs admission release --macro ${MACRO} --checkout ${repo.lane} --admission ${first}`), refused.stderr);
      strictEqual(refused.stdout, '');
    }
    deepStrictEqual(sessionEntries(macroLock), [`s-${first}.json`]);
    deepStrictEqual(sessionEntries(laneLock), [`s-${first}.json`], "next for another macro meets the first in the lane's worktree lock");
    deepStrictEqual(sessionEntries(locks.macroLockPath(repo.main, OTHER_MACRO)), [], 'and leaves nothing in its own macro lock');
  });

  it('an admission blocks a run starting, and is never cleared, however old: shown as stale past 4 h', async () => {
    const id = join_('done', repo.lane).stdout.trim();
    const file = join(macroLock, `s-${id}.json`);
    const entry = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, `${JSON.stringify({ ...entry, acquired_at: new Date(Date.now() - 5 * 3600_000).toISOString() })}\n`);
    const old = new Date(Date.now() - 5 * 3600_000);
    utimesSync(file, old, old);
    await rejects(holdAsRun(macroLock), (err) => err instanceof locks.LockHeldError
      && /an interactive session holds/.test(err.message)
      && /stale: older than 4 h/.test(err.message));
    ok(existsSync(file), 'never cleared as debris');
    deepStrictEqual(readdirSync(macroLock).filter((n) => n.startsWith('h-')), [], "the run's own entry removed");
    const listed = locks.listLocks(repo.main, repo.lane).filter((l) => l.session);
    deepStrictEqual(listed.map((l) => l.holder.admission_id), [id], 'listLocks shows the admission');
  });

  it('a run holding the locks refuses a session, naming the run and where to look', async () => {
    const held = await holdAsRun(macroLock);
    try {
      const refused = join_('done', repo.main);
      strictEqual(refused.status, 1, refused.stderr);
      match(refused.stderr, new RegExp(`another autopilot run holds .*${RUN} \\(pid ${process.pid}\\), launched in .*lane: run /orchestrator:autopilot status there`));
      deepStrictEqual(sessionEntries(macroLock), []);
    } finally {
      held.release();
    }
    strictEqual(join_('done', repo.main).status, 0, 'control: once the run is gone, the session is admitted');
  });

  it("the holding run's workers pass with no entry; another run's worker, a wrong token or none is refused", async () => {
    const held = [await holdAsRun(laneLock), await holdAsRun(macroLock)];
    try {
      const worker = { AGENTIC_AUTOPILOT: RUN, AGENTIC_AUTOPILOT_TOKEN: 'the-run-secret' };
      const passed = join_('next', repo.lane, MACRO, worker);
      strictEqual(passed.status, 0, passed.stderr);
      strictEqual(passed.stdout, '\n', 'an empty admission id');
      match(passed.stderr, new RegExp(`worker of the holding run ${RUN}`));
      deepStrictEqual([...sessionEntries(laneLock), ...sessionEntries(macroLock)], [], 'no entry');
      strictEqual(check('', repo.lane, MACRO, worker).status, 0, 'a worker checks with the empty id');
      strictEqual(release('', repo.lane).status, 0);
      for (const env of [
        { AGENTIC_AUTOPILOT: RUN, AGENTIC_AUTOPILOT_TOKEN: 'a-wrong-secret' },
        { AGENTIC_AUTOPILOT: RUN },
        { AGENTIC_AUTOPILOT: 'autopilot-20261008T000000Z-ad0002', AGENTIC_AUTOPILOT_TOKEN: 'the-run-secret' },
        {},
      ]) {
        const refused = join_('next', repo.lane, MACRO, env);
        strictEqual(refused.status, 1, `${JSON.stringify(env)}: ${refused.stderr}`);
        match(refused.stderr, /another autopilot run holds/);
        strictEqual(check('', repo.lane, MACRO, env).status, 1, `check ${JSON.stringify(env)}`);
      }
    } finally {
      for (const h of held) h.release();
    }
    strictEqual(check('', repo.lane, MACRO, { AGENTIC_AUTOPILOT: RUN, AGENTIC_AUTOPILOT_TOKEN: 'the-run-secret' }).status, 1, 'the run gone, a worker check stops');
  });

  it('a run that adds its entry while a session joins is seen on the second look: the session removes its own and refuses', async () => {
    let rival;
    await rejects(
      locks.joinAdmission({
        command: 'done', checkout: repo.lane, macroId: MACRO, host: 'claude', env: cleanEnv(),
        hooks: {
          afterCreate: async () => {
            rival = join(macroLock, `h-${process.pid}-0123456789ab.json`);
            writeFileSync(rival, `${JSON.stringify({ run_id: RUN, repo: repo.lane, macro_id: MACRO, pid: process.pid, fingerprint: await locks.processFingerprint(process.pid), worker: null })}\n`);
          },
        },
      }),
      (err) => err instanceof locks.LockHeldError && /another autopilot run holds/.test(err.message),
    );
    deepStrictEqual(sessionEntries(macroLock), [], 'its own entry removed');
    ok(existsSync(rival), "the run's entry kept");
  });

  it('two sessions joining at once: never both admitted', async () => {
    const launch = () => new Promise((done) => {
      const child = spawn(process.execPath, [ORCH_STATE, 'admission', 'join', '--macro', MACRO, '--checkout', repo.lane, '--command', 'done', '--host', 'codex'], { env: cleanEnv() });
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.on('close', (status) => done({ status, stdout }));
    });
    for (let round = 0; round < 3; round += 1) {
      rmSync(join(repo.main, '.agentic-plugins'), { recursive: true, force: true });
      const results = await Promise.all([launch(), launch(), launch()]);
      const admitted = results.filter((r) => r.status === 0);
      ok(admitted.length <= 1, JSON.stringify(results));
      deepStrictEqual(sessionEntries(macroLock), admitted.map((r) => `s-${r.stdout.trim()}.json`));
    }
  });

  // The runbooks a worker loads may come from a newer text than its pinned
  // scripts: a pinned orchestrator without the subcommand refuses the start.
  it('the driver refuses a pinned orchestrator whose state.mjs has no admission subcommand', async () => {
    const { capabilityProblems } = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/roots.mjs')).href);
    const old = join(dir, 'old-orchestrator');
    for (const rel of ['scripts/state.mjs', 'commands/next.md', 'commands/done.md']) {
      mkdirSync(dirname(join(old, rel)), { recursive: true });
      writeFileSync(join(old, rel), readFileSync(join(REPO_ROOT, 'plugins/orchestrator', rel), 'utf8'));
    }
    deepStrictEqual(await capabilityProblems({ orchestrator: old }), [], 'control: the current scripts pass');
    writeFileSync(join(old, 'scripts/state.mjs'), readFileSync(join(old, 'scripts/state.mjs'), 'utf8').replace("case 'admission'", "case 'admission-gone'"));
    const problems = await capabilityProblems({ orchestrator: old });
    strictEqual(problems.length, 1, problems.join('\n'));
    match(problems[0], /lacks the admission entries the runbooks join/);
  });

  it('usage errors: an unknown command, host or action, and a malformed id', () => {
    const badCommand = admission(['join', '--macro', MACRO, '--checkout', repo.lane, '--command', 'plan', '--host', 'claude']);
    notZero(badCommand, /--command must be one of next, done, finalize, abort, resume/);
    notZero(admission(['join', '--macro', MACRO, '--checkout', repo.lane, '--command', 'done', '--host', 'other']), /--host must be claude or codex/);
    notZero(admission(['open', '--macro', MACRO, '--checkout', repo.lane]), /admission takes join, check or release/);
    notZero(check('../../x', repo.lane), /not an admission id/);
    deepStrictEqual(sessionEntries(macroLock), []);
  });

  // A session run from a subdirectory of the checkout (or that lost its
  // REPO_ROOT between Bash calls) keys the same worktree lock as one at the
  // toplevel, and as the driver does.
  it('a checkout is keyed by its toplevel: a join from a subdirectory meets a next admission from the toplevel, and either spelling checks and releases it', () => {
    for (const [first, second] of [[repo.lane, repo.laneSub], [repo.laneSub, repo.lane]]) {
      const held = join_('next', first);
      strictEqual(held.status, 0, held.stderr);
      const id = held.stdout.trim();
      const refused = join_('next', second, OTHER_MACRO);
      strictEqual(refused.status, 1, `next from ${second} beside next from ${first}: ${refused.stderr}`);
      match(refused.stderr, /an interactive session holds .*worktree\.lock: \/orchestrator:next/);
      ok(refused.stderr.includes(`--checkout ${repo.lane} --admission ${id}`), refused.stderr);
      deepStrictEqual(sessionEntries(locks.macroLockPath(repo.main, OTHER_MACRO)), [], 'the refused join leaves nothing');
      ok(!existsSync(join(repo.laneSub, '.agentic-plugins')), 'no worktree lock under the subdirectory');
      deepStrictEqual(sessionEntries(laneLock), [`s-${id}.json`]);
      strictEqual(JSON.parse(readFileSync(join(macroLock, `s-${id}.json`), 'utf8')).checkout, repo.lane, 'the entry records the toplevel');
      const checked = check(id, second);
      strictEqual(checked.status, 0, checked.stderr);
      strictEqual(release(id, second).status, 0);
      deepStrictEqual([...sessionEntries(laneLock), ...sessionEntries(macroLock)], [], `released from ${second}`);
    }
  });

  it('an empty --checkout is refused before anything is written, whatever the working directory', () => {
    const id = join_('done', repo.lane).stdout.trim();
    match(id, /^[0-9a-f]{32}$/);
    const before = sessionEntries(macroLock);
    for (const empty of [['--checkout', ''], ['--checkout=']]) {
      const joined = admission(['join', '--macro', OTHER_MACRO, ...empty, '--command', 'next', '--host', 'claude'], {}, repo.lane);
      notZero(joined, /--checkout needs a path/);
      strictEqual(joined.stdout, '');
      const checked = admission(['check', '--macro', MACRO, ...empty, '--admission', id], {}, repo.lane);
      notZero(checked, /--checkout needs a path/);
      const released = admission(['release', '--macro', MACRO, ...empty, '--admission', id], {}, repo.lane);
      notZero(released, /--checkout needs a path/);
    }
    const flagWithoutValue = admission(['join', '--macro', OTHER_MACRO, '--checkout', '--command', 'next', '--host', 'claude'], {}, repo.lane);
    notZero(flagWithoutValue, /--checkout needs a path/);
    deepStrictEqual(sessionEntries(laneLock), [], 'no worktree-lock entry');
    deepStrictEqual(sessionEntries(locks.macroLockPath(repo.main, OTHER_MACRO)), [], 'no macro-lock entry');
    deepStrictEqual(sessionEntries(macroLock), before, 'the standing admission is neither released nor joined beside');
    strictEqual(check(id, repo.lane).status, 0, 'control: with its checkout, the admission checks');
  });
});

function notZero(result, pattern) {
  ok(result.status !== 0, result.stdout);
  match(result.stderr, pattern);
}
