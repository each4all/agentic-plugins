// The fixture the admission runbook tests share (ADR-0067 Decision 4, item 5,
// SR, U7c): test-admission-runbooks.mjs (/orchestrator:next's branches and
// refusals, once, in bash), test-admission-close-runbooks.mjs (the branches
// and refusals of finalize, abort and resume's archive, once, in bash) and
// test-admission-runbooks-e2e.mjs (each runbook path's happy path end to end,
// in every shell it may run in, in the large tier).
//
// Real git repositories: a main checkout holding the macro, and a linked
// worktree `lane` where the command runs. The macro lock lives under the main
// checkout; /orchestrator:next also joins the lane's worktree lock. The runs
// use the real orchestrator and engineer scripts.

import { ok, deepStrictEqual, strictEqual } from 'node:assert/strict';
import { before, beforeEach } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { carriedTextDir, withTextDir } from './_next-text-dir.mjs';
import { withArgs } from './_command-args-file.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
export const ORCH_ROOT = join(REPO_ROOT, 'plugins/orchestrator');
export const ENGINEER_ROOT = join(REPO_ROOT, 'plugins/engineer');
export const ORCH_STATE = join(ORCH_ROOT, 'scripts/state.mjs');
export const ENG_STATE = join(ENGINEER_ROOT, 'scripts/state.mjs');
export const locks = await import(pathToFileURL(join(ORCH_ROOT, 'scripts/lib/run-locks.mjs')).href);
const { createWorkflow, setPlan, readWorkflow } = await import(pathToFileURL(ORCH_STATE).href);
export { setPlan, withTextDir };
const installed = (s) => spawnSync(s, ['-c', 'exit 0']).status === 0;
/** The shells the runbooks run in that are installed here, for the end-to-end runs. */
export const SHELLS = ['bash', 'zsh'].filter(installed);
/** The shells next's blocks are run in, each in a fresh shell, end to end: a POSIX sh too (dockets C75, C68). */
export const FRESH_SHELLS = ['bash', 'zsh', 'sh'].filter(installed);
/** The one shell the branches and refusals run in (the standard test shape). */
export const SH = 'bash';
export const RUN = 'autopilot-20261008T000000Z-ad0001';
export const SECRET = 'the-run-secret';

// The ARGS_DIR lines of the orchestrator runbooks, which name the args file
// the agent writes for the command's arguments (ADR-0059, C134(a)).
const ARGS_DIR_LINES = ["ARGS_DIR='<directory from step 3>'", "ARGS_DIR='<directory from step 1>'", "ARGS_DIR='<directory from mktemp>'"];
/** `block` with its ARGS_DIR line, when it has one, naming a new args file holding `text`. */
export function withTyped(block, text) {
  const line = ARGS_DIR_LINES.find((l) => block.includes(l));
  return line ? withArgs(block, text, { line }) : block;
}

const blocksOf = (text) => [...text.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
export const NEXT = readFileSync(join(ORCH_ROOT, 'commands/next.md'), 'utf8');
/** The fenced bash block of next.md that contains `needle`. */
function blockWith(needle) {
  const found = blocksOf(NEXT).filter((b) => b.includes(needle));
  // Contract: the runs execute this block — a renamed line must fail here,
  // not run nothing.
  strictEqual(found.length, 1, `one bash block of next.md holds ${needle}`);
  return found[0];
}
export const JOIN_AND_SWITCH = blockWith('admission join');
export const PRELUDE = blockWith('export AGENTIC_PARENT_WORKFLOW="$MACRO_ID"');
export const WRITEBACK = blockWith('--status=in_progress');
// The Codex mirror's blocks, with the plugin root the agent fills in.
export const CODEX_BLOCKS = blocksOf(readFileSync(join(ORCH_ROOT, 'core/skills/next/SKILL.md'), 'utf8'));
export const codexBlock = (needle, root = ORCH_ROOT) => {
  const found = CODEX_BLOCKS.filter((b) => b.includes(needle));
  strictEqual(found.length, 1, `one bash block of the next SKILL.md holds ${needle}`);
  return found[0].replaceAll('<orchestrator-plugin-root>', root);
};
// The Codex mirror's prelude ($orchestrator:next), kept apart, with the
// plugin-root placeholder filled in as the agent fills it.
export const CODEX_PRELUDE = CODEX_BLOCKS.filter((b) => b.includes('export AGENTIC_PARENT_WORKFLOW="$MACRO_ID"'))
  .map((b) => b.replaceAll('<orchestrator-plugin-root>', ORCH_ROOT));
// The Codex mirror's switching block, which reads again after its join (U7d),
// root filled in likewise. Found by its switch, not by the re-read it must hold.
export const CODEX_SWITCH = 'switch --no-track -c "$SUBTASK_BRANCH"';
export const CODEX_REREAD = CODEX_BLOCKS.filter((b) => b.includes(CODEX_SWITCH)).map((b) => b.replaceAll('<orchestrator-plugin-root>', ORCH_ROOT));
/** The blocks of next.md that read the text directory, in order. */
export const NEXT_BLOCKS = blocksOf(NEXT).filter((b) => b.startsWith("TEXT_DIR='<directory from step 1>'\n"));
/** The blocks of the Codex next skill that read the text directory, in order, root filled in. */
export const CODEX_TEXT_BLOCKS = CODEX_BLOCKS.filter((b) => b.startsWith("TEXT_DIR='<directory from mktemp>'\n")).map((b) => b.replaceAll('<orchestrator-plugin-root>', ORCH_ROOT));

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
// The operator's agentic session stays out (C88); the blocks get only what
// the runbook gives them.
export const cleanEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_') && k !== 'CLAUDE_PLUGIN_ROOT' && k !== 'CLAUDE_CODE_SESSION_ID')),
  ...GIT_ENV,
  ...extra,
});
export const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const idOf = (path) => path.split('/').pop().replace(/\.md$/, '');

/** A main checkout with one commit, `branches` beside main, and a linked worktree `lane` on feat/x. */
function makeRepos(dir, branches = []) {
  const main = join(dir, 'main');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, '.gitignore'), '.agentic-plugins/\n');
  git(main, 'add', '.gitignore');
  git(main, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  for (const b of branches) git(main, 'branch', b);
  git(main, 'worktree', 'add', '-q', '-b', 'feat/x', join(dir, 'lane'));
  return { main: realpathSync(main), lane: realpathSync(join(dir, 'lane')) };
}

/**
 * /orchestrator:next's fixture. Registers its before and beforeEach hooks in
 * the calling describe and returns its handle: `f.dir`, `f.main`, `f.lane`,
 * `f.macroPath`, `f.macroId`, `f.macroLock`, `f.laneLock`, `f.shim`, read
 * inside a test, and the helpers below. `makeDir(prefix)` makes the fixture's
 * directory (tests/_tmp.mjs fileTmpDirs, called at the top of the test file).
 */
export function nextFixture(makeDir) {
  const f = {};
  const sessionEntries = (lock) => (existsSync(lock) ? readdirSync(lock).filter((n) => /^s-[0-9a-f]{32}\.json$/.test(n)) : []);
  f.sessionEntries = sessionEntries;
  f.held = () => [...sessionEntries(f.laneLock), ...sessionEntries(f.macroLock)];

  /** Subtask T1 as Phase 1 read it, which the selection file holds. */
  f.T1 = (over = {}) => ({ id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'pending', ...over });
  /**
   * What the earlier phases left in the text directory (docket C75): a block
   * reads nothing else, so each run is a fresh shell given that directory
   * alone.
   */
  f.carried = (over = {}) => carriedTextDir({
    repoRoot: f.lane, macroPath: f.macroPath, subtask: f.T1(), engineerRoot: ENGINEER_ROOT, engineerWorkflow: '', ...over,
  }, f.dir);
  f.run = (shell, script, env = {}) => {
    const r = spawnSync(shell, ['-c', script], {
      cwd: f.lane, encoding: 'utf8',
      env: cleanEnv({ HOME: f.dir, AGENTIC_ORCHESTRATOR_ROOT: ORCH_ROOT, ...env }),
    });
    const vars = Object.fromEntries([...r.stdout.matchAll(/^(\w+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
    return { ...r, vars };
  };
  /** Phase 3b, then the id it wrote, as the next block reads it. */
  f.joinAndSwitch = (shell, over = {}, env = {}) => f.run(shell, `${withTextDir(JOIN_AND_SWITCH, f.carried(over))}\necho "ADMISSION=$ADMISSION"`, env);
  f.prelude = (shell, admission, env = {}, block = PRELUDE) => f.run(shell, `${withTextDir(block, f.carried({ admission }))}\necho "EXPORTED=$AGENTIC_PARENT_WORKFLOW"`, env);
  // Phase 5 in a fresh Bash call: only the text directory, no root or host
  // left over from Phase 4.
  f.writeback = (shell, admission, env = {}, block = WRITEBACK, over = {}) => f.run(shell, withTextDir(block, f.carried({ admission, ...over })), env);
  /** The Codex mirror's join block (root `root`), then the id it wrote. */
  f.codexJoin = (shell, over = {}, env = {}, root = ORCH_ROOT) => f.run(shell, `${withTextDir(codexBlock('admission join', root), f.carried(over))}\necho "ADMISSION=$ADMISSION"`, env);
  /** The Codex mirror's switching block (root `root`), given admission `admission`. */
  f.codexSwitch = (shell, admission, over = {}, env = {}, root = ORCH_ROOT) => f.run(shell, `${withTextDir(codexBlock(CODEX_SWITCH, root), f.carried({ admission, ...over }))}\necho "PASSED=1"`, env);
  /** An admission joined as Phase 3b's (or the Codex Phase 2's) join takes it. */
  f.joinCli = (host = 'claude') => execFileSync(process.execPath, [ORCH_STATE, 'admission', 'join', '--macro', f.macroId, '--checkout', f.lane, '--command', 'next', '--host', host], { encoding: 'utf8', env: cleanEnv(), stdio: 'pipe' }).trim();
  f.release = (id) => execFileSync(process.execPath, [ORCH_STATE, 'admission', 'release', '--macro', f.macroId, '--checkout', f.lane, '--admission', id], { env: cleanEnv(), stdio: 'pipe' });
  f.branch = () => git(f.lane, 'branch', '--show-current');
  f.subtask = async () => (await readWorkflow(f.macroPath)).frontmatter.plan.subtasks.find((s) => s.id === 'T1');
  f.idOf = idOf;
  // `selection`: the dispatch the child records (ADR-0067 Decision 4, item
  // 5), as Phase 4's AGENTIC_DISPATCH_SELECTION hands it to create; none for a
  // child created before the record.
  f.engineerChild = (selection = null) => execFileSync(process.execPath, [
    ENG_STATE, 'create', '--repo-root', f.lane, '--verb', 'compose', '--host', 'claude', '--persona', 'engineer',
    '--git-baseline-branch', 'feat/t1', '--git-baseline-head', git(f.lane, 'rev-parse', 'HEAD'), '--status-digest', 'x',
    '--profile', 'plan', '--original-request', 'admission fixture', '--current-phase', 'phase-0-bootstrap',
    '--next-action', 'x', '--parent-workflow', f.macroId, '--originating-subtask', 'T1',
    ...(selection ? ['--dispatch-selection', JSON.stringify(selection)] : []),
  ], { encoding: 'utf8', env: cleanEnv(), cwd: f.lane }).trim();
  // A run holding the lane's worktree lock and the macro lock, as the driver
  // takes them: this test process, alive, with a known secret.
  f.holdAsRun = async () => {
    const record = { run_id: RUN, repo: f.lane, macro_id: f.macroId, started_at: new Date().toISOString(), token_digest: createHash('sha256').update(SECRET).digest('hex') };
    return [await locks.acquireLock(f.laneLock, { record }), await locks.acquireLock(f.macroLock, { record })];
  };
  /** A new macro under the main checkout, in place of the one there, planned with `subtasks`; the tests' macro from here on. */
  f.freshMacro = async (subtasks = [f.T1()]) => {
    rmSync(join(f.main, '.agentic-plugins/state/orchestrator'), { recursive: true, force: true });
    ({ filePath: f.macroPath } = await createWorkflow({
      repoRoot: f.main, verb: 'plan', host: 'claude',
      gitBaseline: { branch: 'main', head: git(f.main, 'rev-parse', 'HEAD'), status_digest: '' },
      originalRequest: 'admission runbook fixture',
    }));
    await setPlan({ workflowPath: f.macroPath, host: 'claude', subtasks });
    f.macroId = idOf(f.macroPath);
    f.macroLock = locks.macroLockPath(f.main, f.macroId);
  };
  /** The state each test starts from: no agentic state, the lane on feat/x, a fresh macro. */
  f.reset = async () => {
    for (const root of [f.main, f.lane]) rmSync(join(root, '.agentic-plugins'), { recursive: true, force: true });
    if (f.branch() !== 'feat/x') git(f.lane, 'switch', '-q', 'feat/x');
    await f.freshMacro();
    f.laneLock = locks.worktreeLockPath(f.lane);
  };

  before(() => {
    f.dir = realpathSync(makeDir('admission-runbooks-'));
    ({ main: f.main, lane: f.lane } = makeRepos(f.dir, ['feat/t1']));
    // A plugin root whose state.mjs, while `admission join` runs, runs the
    // real state.mjs with the arguments DURING_JOIN names (a run's step), and,
    // given REVISE_T1 or REVISE_PLAN, revises subtask T1 or replaces the plan
    // of REVISE_MACRO (another session's /orchestrator:plan); it hands every
    // call to the real state.mjs.
    f.shim = join(f.dir, 'shim-root');
    mkdirSync(join(f.shim, 'scripts'), { recursive: true });
    writeFileSync(join(f.shim, 'scripts', 'state.mjs'), [
      "import { spawnSync } from 'node:child_process';",
      'const args = process.argv.slice(2);',
      "const joining = args[0] === 'admission' && args[1] === 'join';",
      'if (joining && process.env.DURING_JOIN) {',
      `  const step = spawnSync(process.execPath, [${JSON.stringify(ORCH_STATE)}, ...JSON.parse(process.env.DURING_JOIN)], { stdio: ['ignore', 'ignore', 'inherit'] });`,
      '  if (step.status !== 0) process.exit(97);',
      '}',
      'if (joining && (process.env.REVISE_T1 || process.env.REVISE_PLAN)) {',
      `  const { readWorkflow, setPlan } = await import(${JSON.stringify(pathToFileURL(ORCH_STATE).href)});`,
      '  const workflowPath = process.env.REVISE_MACRO;',
      '  const { frontmatter } = await readWorkflow(workflowPath);',
      '  const subtasks = process.env.REVISE_PLAN ? JSON.parse(process.env.REVISE_PLAN)',
      "    : frontmatter.plan.subtasks.map((s) => (s.id === 'T1' ? { ...s, ...JSON.parse(process.env.REVISE_T1) } : s));",
      "  await setPlan({ workflowPath, host: 'claude', subtasks });",
      '}',
      // FAIL_AFTER names a subcommand that prints its real answer, then exits
      // 1: a reader whose status only its own check sees (docket C110).
      'if (process.env.FAIL_AFTER === args[0]) {',
      `  const real = spawnSync(process.execPath, [${JSON.stringify(ORCH_STATE)}, ...args], { encoding: 'utf8' });`,
      '  process.stdout.write(real.stdout);',
      '  process.exit(1);',
      '}',
      `const r = spawnSync(process.execPath, [${JSON.stringify(ORCH_STATE)}, ...args], { stdio: 'inherit' });`,
      'process.exit(r.status ?? 1);',
    ].join('\n'));
  });
  beforeEach(() => f.reset());
  return f;
}

// Dockets C75 and C68, end to end: every block from Phase 0 to the writeback,
// each in a fresh shell that shares nothing with the others but the text
// directory. The topic holds a line break, a backslash, quotes, a `$` and a
// backquote, and runs past a pipe's 64 KiB, so next-ready's answer reaches its
// parser in several chunks, and an `echo` would have expanded its `\n` (zsh, a
// POSIX sh). Critique H6 — two-byte characters past every 64 KiB boundary, at
// both parities, so a pipe's chunk boundary splits one of them in one of the
// two topics: a reader that decodes chunk by chunk turns it into two
// replacement characters, and the topic is no longer the plan's.
export const TOPICS = ['', 'x'].map((pad) => `line one\nline \\n two "quoted" $HOME \`date\`\n${pad}${'é'.repeat(40000)}`);
const CAPTURE = '\nprintf \'%s\' "$AGENTIC_DISPATCH_SELECTION" > "$TEXT_DIR/selection.out" || exit 1\nprintf \'%s\' "$AGENTIC_TOPIC" > "$TEXT_DIR/topic.out" || exit 1\n';
/**
 * The dispatch `blocks` run in order, each in a fresh shell given only the
 * text directory: the switch, then the prelude (its exports captured), then
 * the engineer child this test creates in place of the engineer command, then
 * the writeback. Starts from the state beforeEach leaves: no child, no lock.
 */
export async function dispatchEndToEnd(f, shell, topic, { before: steps, prelude, writeback }) {
  ok(Buffer.byteLength(topic) > 70000, 'the topic runs past a pipe buffer');
  for (const root of [f.main, f.lane]) rmSync(join(root, '.agentic-plugins'), { recursive: true, force: true });
  if (f.branch() !== 'feat/x') git(f.lane, 'switch', '-q', 'feat/x');
  await f.freshMacro([f.T1({ profile: 'backend', topic })]);
  const textDir = mkdtempSync(join(f.dir, 'agentic-text.'));
  const env = { AGENTIC_ENGINEER_ROOT: ENGINEER_ROOT };
  const step = (block, suffix = '') => {
    const r = f.run(shell, `${withTyped(withTextDir(block, textDir), `--workflow=${f.macroId}`)}${suffix}`, env);
    strictEqual(r.status, 0, `${block.split('\n').slice(1, 4).join(' | ')}: ${r.stderr}`);
    return r;
  };
  for (const block of steps) step(block);
  strictEqual(f.branch(), 'feat/t1', 'the switch switched');
  const selected = JSON.parse(readFileSync(join(textDir, 'subtask.json'), 'utf8'));
  strictEqual(selected.topic, topic, 'the selection holds the topic as the plan does');
  step(prelude, CAPTURE);
  strictEqual(readFileSync(join(textDir, 'topic.out'), 'utf8'), topic, 'AGENTIC_TOPIC is the topic, byte for byte');
  const selection = JSON.parse(readFileSync(join(textDir, 'selection.out'), 'utf8'));
  deepStrictEqual(selection, { subtask: 'T1', branch: 'feat/t1', verb: 'compose', profile: 'backend', topic });
  // The engineer command, which this test does not run, creates the child.
  const child = f.engineerChild(selection);
  step(writeback);
  const t1 = await f.subtask();
  deepStrictEqual([t1.status, t1.engineer_workflow_id], ['in_progress', idOf(child)]);
  deepStrictEqual(f.held(), [], 'released after the writeback');
}

/** The bash blocks of commands/<name>.md from `## Phase 0` up to `until`, as one script. */
export function phases(name, until) {
  const text = readFileSync(join(ORCH_ROOT, 'commands', `${name}.md`), 'utf8');
  const from = text.indexOf('## Phase 0');
  const to = text.indexOf(until);
  // Contract: the runs execute these phases — a moved heading must fail here,
  // not run part of the runbook.
  ok(from >= 0 && to > from, `${name}.md carries Phase 0 through ${until}`);
  return blocksOf(text.slice(from, to)).join('\n');
}
/** resume.md's one block that joins the macro lock: its archive. */
export function resumeArchiveBlock() {
  const blocks = blocksOf(readFileSync(join(ORCH_ROOT, 'commands/resume.md'), 'utf8')).filter((b) => b.includes('admission join'));
  strictEqual(blocks.length, 1, 'resume.md: one block joins');
  return blocks[0];
}
/** The bash blocks of core/skills/<name>/SKILL.md, root filled in. */
export const skillBlocks = (name) => blocksOf(readFileSync(join(ORCH_ROOT, 'core/skills', name, 'SKILL.md'), 'utf8')).map((b) => b.replaceAll('<orchestrator-plugin-root>', ORCH_ROOT));

/**
 * finalize, abort and resume's fixture: a macro under the main checkout,
 * planned with one pending subtask, made anew before each test. Registers
 * its hooks in the calling describe; the handle is read inside a test.
 */
export function closeFixture(makeDir) {
  const f = {};
  f.asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  f.sessionEntries = () => (existsSync(f.macroLock) ? readdirSync(f.macroLock).filter((n) => /^s-[0-9a-f]{32}\.json$/.test(n)) : []);
  f.holdAsSession = () => execFileSync(process.execPath, [
    ORCH_STATE, 'admission', 'join', '--macro', f.macroId, '--checkout', f.main, '--command', 'done', '--host', 'codex',
  ], { encoding: 'utf8', env: cleanEnv(), stdio: 'pipe' }).trim();
  f.join = (name, checkout = f.lane) => execFileSync(process.execPath, [ORCH_STATE, 'admission', 'join', '--macro', f.macroId, '--checkout', checkout, '--command', name, '--host', 'codex'], { encoding: 'utf8', env: cleanEnv(), stdio: 'pipe' }).trim();
  f.release = (id, checkout = f.lane) => execFileSync(process.execPath, [ORCH_STATE, 'admission', 'release', '--macro', f.macroId, '--checkout', checkout, '--admission', id], { env: cleanEnv(), stdio: 'pipe' });
  f.runIn = (shell, script, vars = {}) => spawnSync(shell, ['-c', `${Object.entries(vars).map(([k, v]) => `${k}=${q(v)}`).join('\n')}\n${script}`], {
    cwd: f.lane, encoding: 'utf8',
    env: cleanEnv({ HOME: f.dir, AGENTIC_ORCHESTRATOR_ROOT: ORCH_ROOT, AGENTIC_ENGINEER_ROOT: ENGINEER_ROOT }),
  });
  f.macro = async () => readWorkflow(f.macroPath).catch(() => null);

  before(() => {
    f.dir = realpathSync(makeDir('admission-close-'));
    ({ main: f.main, lane: f.lane } = makeRepos(f.dir));
  });
  beforeEach(async () => {
    for (const root of [f.main, f.lane]) {
      try { execFileSync('chmod', ['-R', 'u+rwX', join(root, '.agentic-plugins')], { stdio: 'ignore' }); } catch { /* none */ }
      rmSync(join(root, '.agentic-plugins'), { recursive: true, force: true });
    }
    ({ filePath: f.macroPath } = await createWorkflow({
      repoRoot: f.main, verb: 'plan', host: 'claude',
      gitBaseline: { branch: 'main', head: git(f.main, 'rev-parse', 'HEAD'), status_digest: '' },
      originalRequest: 'admission close fixture',
    }));
    await setPlan({ workflowPath: f.macroPath, host: 'claude', subtasks: [{ id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'pending' }] });
    f.macroId = idOf(f.macroPath);
    f.macroLock = locks.macroLockPath(f.main, f.macroId);
  });
  return f;
}
