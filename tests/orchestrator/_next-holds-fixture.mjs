// The fixture /orchestrator:next's holds tests share (ADR-0068 Decision 2,
// item 5): test-next-holds.mjs (the library, the CLI's own branches and the
// runbook's branch and refusal runs) and test-next-holds-e2e.mjs (the happy
// path end to end, in the large tier). Real git repositories: a main checkout
// holding the macro and the holds, and a linked worktree `lane` where the
// command runs; an engineer that is not hold-aware beside the real one.

import { strictEqual } from 'node:assert/strict';
import { before, beforeEach } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { carriedTextDir, withTextDir } from './_next-text-dir.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
export const ORCH_ROOT = join(REPO_ROOT, 'plugins/orchestrator');
export const ENGINEER_ROOT = join(REPO_ROOT, 'plugins/engineer');
export const ORCH_STATE = join(ORCH_ROOT, 'scripts/state.mjs');
export const ENG_STATE = join(ENGINEER_ROOT, 'scripts/state.mjs');
const { createWorkflow, setPlan, readWorkflow } = await import(pathToFileURL(ORCH_STATE).href);
export const holds = await import(pathToFileURL(join(ORCH_ROOT, 'scripts/lib/holds.mjs')).href);
export const ops = await import(pathToFileURL(join(ORCH_ROOT, 'scripts/lib/hold-ops.mjs')).href);
export const SHELLS = ['bash', 'zsh'].filter((s) => spawnSync(s, ['-c', 'exit 0']).status === 0);

const NEXT = readFileSync(join(ORCH_ROOT, 'commands/next.md'), 'utf8');
const SKILL = readFileSync(join(ORCH_ROOT, 'core/skills/next/SKILL.md'), 'utf8');
const blocksOf = (text) => [...text.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
/** The one fenced bash block of `text` holding every needle. */
function blockWith(text, ...needles) {
  const found = blocksOf(text).filter((b) => needles.every((n) => b.includes(n)));
  // Contract: the runs execute this block — a renamed line must fail here,
  // not run nothing.
  strictEqual(found.length, 1, `one bash block holds ${needles.join(' + ')}`);
  return found[0].replaceAll('<orchestrator-plugin-root>', ORCH_ROOT);
}
export const BLOCKS = {
  PHASE1_GATE: blockWith(NEXT, 'state.mjs" hold-gate', '--checkout "$REPO_ROOT" || exit 1'),
  PHASE3: blockWith(NEXT, 'discover-engineer.mjs" preflight'),
  JOIN_AND_SWITCH: blockWith(NEXT, 'admission join'),
  PRELUDE: blockWith(NEXT, 'export AGENTIC_PARENT_WORKFLOW="$MACRO_ID"'),
  WRITEBACK: blockWith(NEXT, '--status=in_progress'),
  CODEX_GATE: blockWith(SKILL, 'state.mjs" hold-gate', '--checkout "$REPO_ROOT" || exit 1'),
  CODEX_JOIN: blockWith(SKILL, 'admission join'),
  CODEX_SWITCH: blockWith(SKILL, 'switch --no-track -c "$SUBTASK_BRANCH"'),
  CODEX_PRELUDE: blockWith(SKILL, 'export AGENTIC_PARENT_WORKFLOW="$MACRO_ID"'),
  CODEX_WRITEBACK: blockWith(SKILL, '--status in_progress'),
};
export { withTextDir };

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
// The operator's agentic session stays out (C88).
export const cleanEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_') && k !== 'CLAUDE_PLUGIN_ROOT' && k !== 'CLAUDE_CODE_SESSION_ID')),
  ...GIT_ENV,
  ...extra,
});
export const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * Registers the fixture's before and beforeEach hooks in the calling describe
 * and returns its handle: `f.main`, `f.lane`, `f.macroPath`, `f.macroId`,
 * `f.dir`, `f.fakeEngineer`, read inside a test, and the helpers below.
 * `makeDir(prefix)` makes the fixture's directory (tests/_tmp.mjs
 * fileTmpDirs, called at the top level of the test file).
 */
export function nextHoldsFixture(makeDir) {
  const f = {};
  f.T1 = (over = {}) => ({ id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'pending', ...over });
  f.carried = (over = {}) => carriedTextDir({
    repoRoot: f.lane, macroPath: f.macroPath, subtask: f.T1(), engineerRoot: ENGINEER_ROOT, engineerWorkflow: '', ...over,
  }, f.dir);
  f.run = (shell, script, env = {}) => {
    const r = spawnSync(shell, ['-c', script], {
      cwd: f.lane, encoding: 'utf8', env: cleanEnv({ HOME: f.dir, AGENTIC_ORCHESTRATOR_ROOT: ORCH_ROOT, ...env }),
    });
    const vars = Object.fromEntries([...r.stdout.matchAll(/^(\w+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
    return { ...r, vars };
  };
  /** A subcommand of the orchestrator's state.mjs, as the runbook calls it, for subtask T1 in the lane. */
  f.orchCli = (subcommand, ...extra) => spawnSync(process.execPath, [
    ORCH_STATE, subcommand, '--workflow-path', f.macroPath, '--subtask-id', 'T1', '--branch', 'feat/t1', '--checkout', f.lane, ...extra,
  ], { encoding: 'utf8', env: cleanEnv(), cwd: f.lane });
  f.gateCli = (...extra) => f.orchCli('hold-gate', ...extra);
  f.activate = () => holds.writeProtocol(f.main, f.macroId, { writtenBy: 'test' });
  f.records = () => {
    const d = holds.opsDir(f.main, f.macroId, 'T1');
    return existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.json')).sort() : [];
  };
  f.mark = (textDir) => JSON.parse(readFileSync(join(textDir, 'dispatch-mark.json'), 'utf8'));
  f.branch = () => git(f.lane, 'branch', '--show-current');
  f.subtask = async () => (await readWorkflow(f.macroPath)).frontmatter.plan.subtasks.find((s) => s.id === 'T1');
  f.hold = () => ops.setHold({ mainRoot: f.main, macroId: f.macroId, subtaskId: 'T1', branch: 'feat/t1', lane: null });
  f.handoff = () => ops.completeHandoff({ mainRoot: f.main, macroId: f.macroId, subtaskId: 'T1', stateRoots: [f.main, f.lane] });
  /** The engineer's bootstrap as Phase 4 runs it: the real create, given the exports, opening its operation. */
  f.bootstrap = (operationId, opDir = mkdtempSync(join(f.dir, 'op-'))) => {
    const r = spawnSync(process.execPath, [
      ENG_STATE, 'create', '--repo-root', f.lane, '--verb', 'compose', '--host', 'claude', '--persona', 'engineer',
      '--git-baseline-branch', 'feat/t1', '--git-baseline-head', git(f.lane, 'rev-parse', 'HEAD'), '--status-digest', 'x',
      '--profile', 'plan', '--original-request', 'holds fixture', '--current-phase', 'phase-0-bootstrap',
      '--next-action', 'x', '--parent-workflow', f.macroId, '--originating-subtask', 'T1',
      '--dispatch-selection', JSON.stringify({ subtask: 'T1', branch: 'feat/t1', verb: 'compose', profile: '', topic: '' }),
      '--operation-dir', opDir,
    ], { encoding: 'utf8', env: cleanEnv(operationId ? { AGENTIC_OPERATION_ID: operationId } : {}), cwd: f.lane });
    return { ...r, path: r.stdout.trim(), opDir };
  };
  /** The verb's last write, which ends its operation. */
  f.finishVerb = (path, opDir) => spawnSync(process.execPath, [
    ENG_STATE, 'finish-verb', '--workflow-path', path, '--host', 'claude', '--operation-dir', opDir, '--next-action', 'x',
    '--next-step-kind', 'verb', '--next-step-verb', 'critique', '--next-step-confidence', 'HIGH',
  ], { encoding: 'utf8', env: cleanEnv(), cwd: f.lane });
  f.entriesOf = (path) => holds.decodePersonaOperations(holds.readWorkflowFacts(path).fields.persona_operations).ops;
  /** A child of T1 the bootstrap created on its branch and whose verb ended: the lane is back on feat/x. */
  f.endedChild = () => {
    git(f.lane, 'switch', '-q', 'feat/t1');
    const first = f.bootstrap(null);
    strictEqual(first.status, 0, first.stderr);
    strictEqual(f.finishVerb(first.path, first.opDir).status, 0);
    git(f.lane, 'switch', '-q', 'feat/x');
    return first;
  };

  before(() => {
    f.dir = realpathSync(makeDir('next-holds-'));
    let main = join(f.dir, 'main');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    writeFileSync(join(main, '.gitignore'), '.agentic-plugins/\n');
    git(main, 'add', '.gitignore');
    git(main, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    git(main, 'branch', 'feat/t1');
    git(main, 'worktree', 'add', '-q', '-b', 'feat/x', join(f.dir, 'lane'));
    f.main = realpathSync(main);
    f.lane = realpathSync(join(f.dir, 'lane'));
    // An engineer that is not hold-aware: its hold-capability fails; every
    // other command is the real engineer's.
    f.fakeEngineer = join(f.dir, 'old-engineer');
    mkdirSync(join(f.fakeEngineer, 'scripts'), { recursive: true });
    writeFileSync(join(f.fakeEngineer, 'scripts', 'state.mjs'), [
      "import { spawnSync } from 'node:child_process';",
      "if (process.argv[2] === 'hold-capability') process.exit(2);",
      `const r = spawnSync(process.execPath, [${JSON.stringify(ENG_STATE)}, ...process.argv.slice(2)], { stdio: 'inherit' });`,
      'process.exit(r.status ?? 1);',
    ].join('\n'));
  });
  beforeEach(async () => {
    for (const root of [f.main, f.lane]) rmSync(join(root, '.agentic-plugins'), { recursive: true, force: true });
    if (f.branch() !== 'feat/x') git(f.lane, 'switch', '-q', 'feat/x');
    rmSync(join(f.dir, 'other'), { recursive: true, force: true });
    try { git(f.main, 'worktree', 'prune'); } catch { /* none */ }
    ({ filePath: f.macroPath } = await createWorkflow({
      repoRoot: f.main, verb: 'plan', host: 'claude',
      gitBaseline: { branch: 'main', head: git(f.main, 'rev-parse', 'HEAD'), status_digest: '' },
      originalRequest: 'holds runbook fixture',
    }));
    await setPlan({ workflowPath: f.macroPath, host: 'claude', subtasks: [f.T1(), { id: 'T2', verb: 'compose', branch: 'feat/t2', blocked_by: [], status: 'pending' }] });
    f.macroId = f.macroPath.split('/').pop().replace(/\.md$/, '');
  });
  return f;
}
