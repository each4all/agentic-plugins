// ADR-0067 Decision 4, item 2 — the archive and resume-archive paths across
// the shared state root, for the persona state scripts (and the orchestrator's
// archive, which mirrors theirs):
// - `archive` reads the record's home from the resolved path: a relative
//   --workflow-path names a file under the process's directory, whatever
//   --repo-root names, and a `./`-relative path archives;
// - `resolve-workflow` finds `<id>.md` in the workflows homes of the
//   checkout's read set, refuses two files holding it, and exits 3 when none
//   does; `list-workflows` lists the read set;
// - /<persona>:resume archive <id> runs that resolver, then archives the file
//   in its own home: the runbook's own blocks, run from a linked worktree.
//
// Real git repositories: a main checkout and a linked worktree `lane` on feat/x.

import { describe, it, before, after } from 'node:test';
import { strictEqual, ok, match } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { personasFor, pluginRoot, REPO_ROOT } from './_personas.mjs';

const ORCH_STATE = join(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');
const SHELLS = ['bash', 'zsh'].filter((s) => spawnSync(s, ['-c', 'exit 0']).status === 0);
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
const cleanEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_') && k !== 'CLAUDE_PLUGIN_ROOT')),
  ...GIT_ENV,
  ...extra,
});
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function makeRepo(dir) {
  const main = join(dir, 'repo');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'README.md'), 'x\n');
  git(main, 'add', 'README.md');
  git(main, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  git(main, 'worktree', 'add', '-q', '-b', 'feat/x', join(dir, 'lane'));
  return { main: realpathSync(main), lane: realpathSync(join(dir, 'lane')), head: git(main, 'rev-parse', 'HEAD') };
}

const mdIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.md')) : []);

/** The bash block between a resume runbook's pipeline markers for `id`. */
function regionBlock(persona, id) {
  const text = readFileSync(join(pluginRoot(persona), 'commands/resume.md'), 'utf8');
  const begin = text.indexOf(`<!-- pipeline:begin ${id} -->\n`);
  const end = text.indexOf(`<!-- pipeline:end ${id} -->`);
  ok(begin >= 0 && end > begin, `${persona}/commands/resume.md holds the ${id} region`);
  const body = text.slice(begin, end).split('\n').slice(1).join('\n');
  const m = /^```bash\n([\s\S]*?)^```$/m.exec(body);
  ok(m, `${persona}/commands/resume.md: the ${id} region is one bash block`);
  return m[1];
}

for (const persona of personasFor('scripts/state.mjs')) {
  const cli = join(pluginRoot(persona), 'scripts/state.mjs');
  const home = `.agentic-plugins/state/${persona}`;
  const rootEnv = `AGENTIC_${persona.toUpperCase()}_ROOT`;
  const run = (args, { cwd = REPO_ROOT, env = {} } = {}) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: cleanEnv(env) });
  const create = (checkout, branch, head) => {
    const r = run([
      'create', '--repo-root', checkout, '--verb', 'decide', '--host', 'claude',
      '--git-baseline-branch', branch, '--git-baseline-head', head, '--status-digest', DIGEST,
      '--original-request', 'archive resume fixture',
    ]);
    strictEqual(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const wfDir = (root) => join(root, home, 'workflows');
  const arDir = (root) => join(root, home, 'archive');

  describe(`${persona}: archive and resume archive across the shared state root (ADR-0067 Decision 4, item 2)`, () => {
    let dir;
    let repo;
    const reset = () => {
      for (const root of [repo.main, repo.lane]) rmSync(join(root, '.agentic-plugins'), { recursive: true, force: true });
    };
    before(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), `state-root-archive-${persona}-`)));
      repo = makeRepo(dir);
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    it('archive: a relative --workflow-path from the main checkout, with --repo-root naming a lane, archives into the main home', () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head);
      const rel = `${home}/workflows/${basename(path)}`;
      const r = run(['archive', '--workflow-path', rel, '--host', 'claude', '--repo-root', repo.lane], { cwd: repo.main });
      strictEqual(r.status, 0, r.stderr);
      strictEqual(r.stdout.trim(), join(arDir(repo.main), basename(path)));
      ok(!existsSync(path), 'the record left the main workflows home');
      strictEqual(mdIn(arDir(repo.lane)).length, 0, 'nothing went to the lane archive');
    });

    it("archive: a './'-relative --workflow-path archives into the record's home", () => {
      reset();
      const path = create(repo.main, 'feat/x', repo.head);
      const r = run(['archive', '--workflow-path', `./${home}/workflows/${basename(path)}`, '--host', 'claude', '--repo-root', repo.main], { cwd: repo.main });
      strictEqual(r.status, 0, r.stderr);
      strictEqual(r.stdout.trim(), join(arDir(repo.main), basename(path)));
      ok(!existsSync(path));
    });

    it('resolve-workflow from a lane finds a record in the default state root and one in its own home', () => {
      reset();
      const inMain = create(repo.main, 'feat/x', repo.head);
      const inLane = create(repo.lane, 'feat/z', repo.head);
      ok(inMain.startsWith(wfDir(repo.main)) && inLane.startsWith(wfDir(repo.lane)), `${inMain} ${inLane}`);
      for (const path of [inMain, inLane]) {
        const r = run(['resolve-workflow', '--repo-root', repo.lane, '--workflow-id', basename(path, '.md')], { cwd: repo.lane });
        strictEqual(r.status, 0, r.stderr);
        strictEqual(r.stdout, `${path}\n`);
      }
      const listed = run(['list-workflows', '--repo-root', repo.lane], { cwd: repo.lane });
      strictEqual(listed.status, 0, listed.stderr);
      strictEqual(listed.stdout, `${inMain}\n${inLane}\n`, 'the default state root first, then the lane');
    });

    it('resolve-workflow refuses two files holding one id, naming both; exits 3 when none holds it; exit 1 on a non-id', () => {
      reset();
      const inMain = create(repo.main, 'feat/x', repo.head);
      const copy = join(wfDir(repo.lane), basename(inMain));
      mkdirSync(wfDir(repo.lane), { recursive: true });
      writeFileSync(copy, readFileSync(inMain, 'utf8'));
      const dup = run(['resolve-workflow', '--repo-root', repo.lane, '--workflow-id', basename(inMain, '.md')], { cwd: repo.lane });
      strictEqual(dup.status, 1, dup.stderr);
      strictEqual(dup.stdout, '');
      ok(dup.stderr.includes(inMain) && dup.stderr.includes(copy), dup.stderr);
      const none = run(['resolve-workflow', '--repo-root', repo.lane, '--workflow-id', 'decide-20261008T000000Z-000000'], { cwd: repo.lane });
      strictEqual(none.status, 3, none.stderr);
      strictEqual(none.stdout, '');
      match(none.stderr, /no workflow "decide-20261008T000000Z-000000"/);
      const bad = run(['resolve-workflow', '--repo-root', repo.lane, '--workflow-id', '../archive/x'], { cwd: repo.lane });
      strictEqual(bad.status, 1, bad.stderr);
      match(bad.stderr, /not a .* workflow id/);
    });

    for (const shell of SHELLS) {
      it(`resume.md (${shell}): archive <id> from a lane resolves the record and archives it in its own home`, () => {
        reset();
        const inMain = create(repo.main, 'feat/x', repo.head);
        const inLane = create(repo.lane, 'feat/z', repo.head);
        const resolveBlock = regionBlock(persona, 'resume-archive-resolve');
        const archiveBlock = regionBlock(persona, 'resume-archive');
        ok(resolveBlock.includes("ARCHIVE_WORKFLOW_ID='<workflow-id>'") && archiveBlock.includes("WORKFLOW='<workflow path>'"), 'the placeholders the runbook names');
        const sh = (block) => spawnSync(shell, ['-c', block], { cwd: repo.lane, encoding: 'utf8', env: cleanEnv({ [rootEnv]: pluginRoot(persona) }) });
        for (const [path, root] of [[inMain, repo.main], [inLane, repo.lane]]) {
          const resolved = sh(resolveBlock.replace("'<workflow-id>'", `'${basename(path, '.md')}'`));
          strictEqual(resolved.status, 0, resolved.stderr);
          const printed = /^WORKFLOW=(.*)$/m.exec(resolved.stdout)?.[1];
          strictEqual(printed, path);
          const archived = sh(archiveBlock.replace("'<workflow path>'", `'${printed}'`));
          strictEqual(archived.status, 0, archived.stderr);
          strictEqual(archived.stdout.trim(), join(arDir(root), basename(path)));
          ok(!existsSync(path), `${path} left its workflows home`);
        }
        strictEqual(mdIn(arDir(repo.lane)).length, 1, 'the lane archive holds the lane record only');
        // An id no root holds stops the block before anything is archived.
        const missing = sh(resolveBlock.replace("'<workflow-id>'", "'decide-20261008T000000Z-000000'"));
        strictEqual(missing.status, 1);
        match(missing.stderr, /names no single workflow file in the workflow homes of this checkout's read set/);
      });
    }
  });
}

describe('orchestrator: archive reads the macro home from the resolved path (ADR-0067 Decision 4, item 2)', () => {
  const HOME = '.agentic-plugins/state/orchestrator';
  let dir;
  let repo;
  const orch = (args, cwd) => spawnSync(process.execPath, [ORCH_STATE, ...args], { cwd, encoding: 'utf8', env: cleanEnv() });
  const createMacro = () => {
    const r = orch(['create', '--repo-root', repo.main, '--verb', 'plan', '--host', 'claude', '--git-baseline-branch', 'main',
      '--git-baseline-head', repo.head, '--original-request', 'archive fixture'], repo.main);
    strictEqual(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'state-root-archive-orch-')));
    repo = makeRepo(dir);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('a relative --workflow-path from the main checkout, with --repo-root naming a lane, archives into the main home', () => {
    const path = createMacro();
    const r = orch(['archive', '--workflow-path', `${HOME}/workflows/${basename(path)}`, '--host', 'claude', '--repo-root', repo.lane], repo.main);
    strictEqual(r.status, 0, r.stderr);
    ok(existsSync(join(repo.main, HOME, 'archive', basename(path))), r.stdout);
    ok(!existsSync(path));
    strictEqual(mdIn(join(repo.lane, HOME, 'archive')).length, 0, 'nothing went to the lane archive');
  });

  it("a './'-relative --workflow-path archives", () => {
    const path = createMacro();
    const r = orch(['archive', '--workflow-path', `./${HOME}/workflows/${basename(path)}`, '--host', 'claude', '--repo-root', repo.main], repo.main);
    strictEqual(r.status, 0, r.stderr);
    ok(existsSync(join(repo.main, HOME, 'archive', basename(path))), r.stdout);
    ok(!existsSync(path));
  });
});
