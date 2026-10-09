// ADR-0067 Decision 4, item 5 (SR, U7c): /orchestrator:next's admission in
// the run locks, through the runbook's own blocks — Phase 3b (join, read
// again, switch), Phase 4's prelude (check) and Phase 5 (check, writeback,
// release) — with the real orchestrator and engineer scripts, in bash and in
// zsh (the Bash tool's shell on the owner's machine).
//
// Real git repositories: a main checkout holding the macro, and a linked
// worktree `lane` where the command runs. The macro lock lives under the main
// checkout; /orchestrator:next also joins the lane's worktree lock.

import { describe, it, before, after, beforeEach } from 'node:test';
import { deepStrictEqual, match, ok, rejects, strictEqual } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ORCH_ROOT = join(REPO_ROOT, 'plugins/orchestrator');
const ENGINEER_ROOT = join(REPO_ROOT, 'plugins/engineer');
const ORCH_STATE = join(ORCH_ROOT, 'scripts/state.mjs');
const ENG_STATE = join(ENGINEER_ROOT, 'scripts/state.mjs');
const locks = await import(pathToFileURL(join(ORCH_ROOT, 'scripts/lib/run-locks.mjs')).href);
const { createWorkflow, setPlan, readWorkflow } = await import(pathToFileURL(ORCH_STATE).href);
const SHELLS = ['bash', 'zsh'].filter((s) => spawnSync(s, ['-c', 'exit 0']).status === 0);
const RUN = 'autopilot-20261008T000000Z-ad0001';
const SECRET = 'the-run-secret';

const NEXT = readFileSync(join(ORCH_ROOT, 'commands/next.md'), 'utf8');
/** The fenced bash block of next.md that contains `needle`. */
function blockWith(needle) {
  const found = [...NEXT.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1]).filter((b) => b.includes(needle));
  // Contract: the runs below execute this block — a renamed line must fail
  // here, not run nothing.
  strictEqual(found.length, 1, `one bash block of next.md holds ${needle}`);
  return found[0];
}
const JOIN_AND_SWITCH = blockWith('admission join');
const PRELUDE = blockWith('export AGENTIC_PARENT_WORKFLOW="$MACRO_ID"');
// The Codex mirror's prelude ($orchestrator:next), kept apart, with the
// plugin-root placeholder filled in as the agent fills it.
const CODEX_PRELUDE = [...readFileSync(join(ORCH_ROOT, 'core/skills/next/SKILL.md'), 'utf8').matchAll(/^```bash\n([\s\S]*?)^```$/gm)]
  .map((m) => m[1]).filter((b) => b.includes('export AGENTIC_PARENT_WORKFLOW="$MACRO_ID"'))
  .map((b) => b.replaceAll('<orchestrator-plugin-root>', ORCH_ROOT));
const WRITEBACK = blockWith('--status=in_progress');
// The Codex mirror's blocks, with the plugin root the agent fills in.
const CODEX_BLOCKS = [...readFileSync(join(ORCH_ROOT, 'core/skills/next/SKILL.md'), 'utf8').matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
const codexBlock = (needle, root = ORCH_ROOT) => {
  const found = CODEX_BLOCKS.filter((b) => b.includes(needle));
  strictEqual(found.length, 1, `one bash block of the next SKILL.md holds ${needle}`);
  return found[0].replaceAll('<orchestrator-plugin-root>', root);
};
// The Codex mirror's switching block, which reads again after its join (U7d),
// root filled in likewise. Found by its switch, not by the re-read it must hold.
const CODEX_SWITCH = 'switch --no-track -c "$SUBTASK_BRANCH"';
const CODEX_REREAD = CODEX_BLOCKS.filter((b) => b.includes(CODEX_SWITCH)).map((b) => b.replaceAll('<orchestrator-plugin-root>', ORCH_ROOT));

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
// The operator's agentic session stays out (C88); the blocks get only what
// the runbook gives them.
const cleanEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_') && k !== 'CLAUDE_PLUGIN_ROOT' && k !== 'CLAUDE_CODE_SESSION_ID')),
  ...GIT_ENV,
  ...extra,
});
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

describe('/orchestrator:next joins the run locks before it switches (ADR-0067 Decision 4, item 5)', () => {
  let dir;
  let main;
  let lane;
  let macroPath;
  let macroId;
  let macroLock;
  let laneLock;
  let shim;
  const sessionEntries = (lock) => (existsSync(lock) ? readdirSync(lock).filter((n) => /^s-[0-9a-f]{32}\.json$/.test(n)) : []);
  const held = () => [...sessionEntries(laneLock), ...sessionEntries(macroLock)];

  /** What Phases 0-2 leave set, as the agent carries it into the next block. */
  const carried = (over = {}) => Object.entries({
    MACRO_ID: macroId, MACRO_PATH: macroPath, REPO_ROOT: lane, SUBTASK_ID: 'T1', SUBTASK_BRANCH: 'feat/t1',
    SUBTASK_VERB: 'compose', ENGINEER_PLUGIN_ROOT: ENGINEER_ROOT, EXISTING_ENG_PATH: '', SUBTASK_PROFILE: '', SUBTASK_TOPIC: '',
    SUBTASK_STATUS: 'pending', SUBTASK_EXISTING_ENG_WF_ID: '', ...over,
  }).map(([k, v]) => `${k}=${q(v)}`).join('\n');

  function run(shell, script, env = {}) {
    const r = spawnSync(shell, ['-c', script], {
      cwd: lane, encoding: 'utf8',
      env: cleanEnv({ HOME: dir, AGENTIC_ORCHESTRATOR_ROOT: ORCH_ROOT, ...env }),
    });
    const vars = Object.fromEntries([...r.stdout.matchAll(/^(\w+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
    return { ...r, vars };
  }
  /** Phase 3b, then the id it carried, as the agent reads it. */
  const joinAndSwitch = (shell, over = {}, env = {}) => run(shell, `${carried(over)}\n${JOIN_AND_SWITCH}\necho "ADMISSION=$ADMISSION"`, env);
  const prelude = (shell, admission, env = {}, block = PRELUDE) => run(shell, `${carried({ ADMISSION: admission })}\n${block}\necho "EXPORTED=$AGENTIC_PARENT_WORKFLOW"`, env);
  // Phase 5 in a fresh Bash call: only what the agent carries, no root or host
  // left over from Phase 4.
  const writeback = (shell, admission, env = {}, block = WRITEBACK, over = {}) => run(shell, `${carried({ ADMISSION: admission, ...over })}\n${block}`, env);
  /** An admission joined as Phase 3b's (or the Codex Phase 2's) join takes it. */
  const joinCli = (host = 'claude') => execFileSync(process.execPath, [ORCH_STATE, 'admission', 'join', '--macro', macroId, '--checkout', lane, '--command', 'next', '--host', host], { encoding: 'utf8', env: cleanEnv(), stdio: 'pipe' }).trim();
  const branch = () => git(lane, 'branch', '--show-current');
  const subtask = async () => (await readWorkflow(macroPath)).frontmatter.plan.subtasks.find((s) => s.id === 'T1');
  // `selection`: the dispatch the child records (ADR-0067 Decision 4, item
  // 5), as Phase 4's AGENTIC_DISPATCH_SELECTION hands it to create; none for a
  // child created before the record.
  const engineerChild = (selection = null) => execFileSync(process.execPath, [
    ENG_STATE, 'create', '--repo-root', lane, '--verb', 'compose', '--host', 'claude', '--persona', 'engineer',
    '--git-baseline-branch', 'feat/t1', '--git-baseline-head', git(lane, 'rev-parse', 'HEAD'), '--status-digest', 'x',
    '--profile', 'plan', '--original-request', 'admission fixture', '--current-phase', 'phase-0-bootstrap',
    '--next-action', 'x', '--parent-workflow', macroId, '--originating-subtask', 'T1',
    ...(selection ? ['--dispatch-selection', JSON.stringify(selection)] : []),
  ], { encoding: 'utf8', env: cleanEnv(), cwd: lane }).trim();
  // A run holding the lane's worktree lock and the macro lock, as the driver
  // takes them: this test process, alive, with a known secret.
  const holdAsRun = async () => {
    const record = { run_id: RUN, repo: lane, macro_id: macroId, started_at: new Date().toISOString(), token_digest: createHash('sha256').update(SECRET).digest('hex') };
    return [await locks.acquireLock(laneLock, { record }), await locks.acquireLock(macroLock, { record })];
  };

  before(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'admission-runbooks-')));
    main = join(dir, 'main');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    writeFileSync(join(main, '.gitignore'), '.agentic-plugins/\n');
    git(main, 'add', '.gitignore');
    git(main, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    git(main, 'branch', 'feat/t1');
    git(main, 'worktree', 'add', '-q', '-b', 'feat/x', join(dir, 'lane'));
    main = realpathSync(main);
    lane = realpathSync(join(dir, 'lane'));
    macroLock = locks.macroLockPath(main, 'MACRO');
    // A plugin root whose state.mjs, while `admission join` runs, runs the
    // real state.mjs with the arguments DURING_JOIN names (a run's step), and,
    // given REVISE_T1 or REVISE_PLAN, revises subtask T1 or replaces the plan
    // of REVISE_MACRO (another session's /orchestrator:plan); it hands every
    // call to the real state.mjs.
    shim = join(dir, 'shim-root');
    mkdirSync(join(shim, 'scripts'), { recursive: true });
    writeFileSync(join(shim, 'scripts', 'state.mjs'), [
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
      `const r = spawnSync(process.execPath, [${JSON.stringify(ORCH_STATE)}, ...args], { stdio: 'inherit' });`,
      'process.exit(r.status ?? 1);',
    ].join('\n'));
  });
  /** A new macro under the main checkout, in place of the one there, planned with `subtasks`; the tests' macro from here on. */
  const freshMacro = async (subtasks = [{ id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'pending' }]) => {
    rmSync(join(main, '.agentic-plugins/state/orchestrator'), { recursive: true, force: true });
    ({ filePath: macroPath } = await createWorkflow({
      repoRoot: main, verb: 'plan', host: 'claude',
      gitBaseline: { branch: 'main', head: git(main, 'rev-parse', 'HEAD'), status_digest: '' },
      originalRequest: 'admission runbook fixture',
    }));
    await setPlan({ workflowPath: macroPath, host: 'claude', subtasks });
    macroId = macroPath.split('/').pop().replace(/\.md$/, '');
    macroLock = locks.macroLockPath(main, macroId);
  };
  beforeEach(async () => {
    for (const root of [main, lane]) rmSync(join(root, '.agentic-plugins'), { recursive: true, force: true });
    if (branch() !== 'feat/x') git(lane, 'switch', '-q', 'feat/x');
    await freshMacro();
    laneLock = locks.worktreeLockPath(lane);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  for (const shell of SHELLS) {
    it(`${shell}: joins both locks, switches, and holds the admission until Phase 5, which writes the subtask back and releases it`, async () => {
      const joined = joinAndSwitch(shell);
      strictEqual(joined.status, 0, joined.stderr);
      const id = joined.vars.ADMISSION;
      match(id, /^[0-9a-f]{32}$/);
      strictEqual(branch(), 'feat/t1');
      deepStrictEqual(sessionEntries(laneLock), [`s-${id}.json`], "the lane's worktree lock");
      deepStrictEqual(sessionEntries(macroLock), [`s-${id}.json`], 'and the macro lock, under the main checkout');
      const pre = prelude(shell, id);
      strictEqual(pre.status, 0, pre.stderr);
      strictEqual(pre.vars.EXPORTED, macroId, 'the prelude went on to the exports');
      const child = engineerChild();
      const wrote = writeback(shell, id);
      strictEqual(wrote.status, 0, wrote.stderr);
      const t1 = await subtask();
      deepStrictEqual([t1.status, t1.engineer_workflow_id], ['in_progress', child.split('/').pop().replace(/\.md$/, '')]);
      deepStrictEqual(held(), [], 'released after the writeback');
    });

    it(`${shell}: contention — another session's /orchestrator:next is refused, naming the holder; nothing is switched or left behind`, async () => {
      const first = joinAndSwitch(shell);
      strictEqual(first.status, 0, first.stderr);
      git(lane, 'switch', '-q', 'feat/x');
      // Same lane, another macro: the worktree lock. The main checkout, the
      // same macro: the macro lock.
      for (const over of [{ MACRO_ID: 'macro-plan-20261008T000000Z-ad0002' }, { REPO_ROOT: main }]) {
        const second = joinAndSwitch(shell, over);
        strictEqual(second.status, 1, second.stdout);
        match(second.stderr, /an interactive session holds .*\/orchestrator:next, checkout .*lane, host claude, .*admission [0-9a-f]{32}/);
        strictEqual(second.vars.ADMISSION, undefined, 'the block stopped at the join');
      }
      strictEqual(branch(), 'feat/x', 'nothing was switched');
      deepStrictEqual(held(), [`s-${first.vars.ADMISSION}.json`, `s-${first.vars.ADMISSION}.json`], "the first session's entries kept, no other");
    });

    it(`${shell}: an interrupted command — its entries outlive it and block a run, until the release command its refusal names removes them`, async () => {
      const dead = joinAndSwitch(shell);
      strictEqual(dead.status, 0, dead.stderr);
      // The session dies before Phase 5.
      await rejects(holdAsRun(), (err) => err instanceof locks.LockHeldError && /an interactive session holds/.test(err.message));
      const refused = joinAndSwitch(shell, { REPO_ROOT: main });
      const release = refused.stderr.match(/state\.mjs admission release [^\n]*?--admission [0-9a-f]{32}/)?.[0];
      ok(release, refused.stderr);
      const r = spawnSync(shell, ['-c', `node ${q(ORCH_STATE)} ${release.slice('state.mjs '.length)}`], { encoding: 'utf8', env: cleanEnv() });
      strictEqual(r.status, 0, r.stderr);
      deepStrictEqual(held(), []);
      const run_ = await holdAsRun();
      for (const h of run_) h.release();
    });

    it(`${shell}: a released admission is seen by check — the prelude stops before the exports, and Phase 5 writes nothing`, async () => {
      const joined = joinAndSwitch(shell);
      strictEqual(joined.status, 0, joined.stderr);
      const id = joined.vars.ADMISSION;
      execFileSync(process.execPath, [ORCH_STATE, 'admission', 'release', '--macro', macroId, '--checkout', lane, '--admission', id], { env: cleanEnv(), stdio: 'pipe' });
      const pre = prelude(shell, id);
      strictEqual(pre.status, 1, pre.stdout);
      match(pre.stderr, /is gone from .*Stop before acting/);
      strictEqual(pre.vars.EXPORTED, undefined, 'no export ran');
      strictEqual(CODEX_PRELUDE.length, 1, 'one Codex prelude');
      const codex = prelude(shell, id, {}, CODEX_PRELUDE[0]);
      strictEqual(codex.status, 1, codex.stdout);
      strictEqual(codex.vars.EXPORTED, undefined, 'the Codex prelude stops too');
      engineerChild();
      const wrote = writeback(shell, id);
      strictEqual(wrote.status, 1, wrote.stdout);
      match(wrote.stderr, /is gone from .*Stop before acting/, "Phase 5's own check refused");
      strictEqual((await subtask()).status, 'pending', 'the macro was not written');
      deepStrictEqual(held(), []);
    });

    // A fresh Bash call keeps nothing Phase 4 set, and the shell of Phase 4's
    // engineer call has the engineer's root in CLAUDE_PLUGIN_ROOT: Phase 5 sets
    // the orchestrator's root and the host itself, or its check and release
    // fail and the admission stays in both locks.
    it(`${shell}: Phase 5 sets its own plugin root and host — run as Claude Code loads it, beside the engineer's root, it writes back and releases both locks`, async () => {
      const joined = joinAndSwitch(shell);
      strictEqual(joined.status, 0, joined.stderr);
      const id = joined.vars.ADMISSION;
      deepStrictEqual(held(), [`s-${id}.json`, `s-${id}.json`], 'held in both locks');
      const child = engineerChild();
      // Claude Code writes the plugin path into the braced variable when it
      // loads the command; nothing else names the orchestrator's root here.
      const loaded = WRITEBACK.replaceAll('${CLAUDE_PLUGIN_ROOT}', ORCH_ROOT);
      const wrote = writeback(shell, id, { AGENTIC_ORCHESTRATOR_ROOT: '', CLAUDE_PLUGIN_ROOT: ENGINEER_ROOT }, loaded);
      strictEqual(wrote.status, 0, wrote.stderr);
      const t1 = await subtask();
      deepStrictEqual([t1.status, t1.engineer_workflow_id], ['in_progress', child.split('/').pop().replace(/\.md$/, '')]);
      deepStrictEqual(held(), [], 'released from both locks');
    });

    // The Codex mirror's Phase 4 finds the engineer workflow itself, so it
    // runs in a fresh shell call too.
    it(`${shell}: the Codex Phase 4 block, in a fresh shell call, finds the engineer workflow, writes it back and releases`, async () => {
      const id = execFileSync(process.execPath, [ORCH_STATE, 'admission', 'join', '--macro', macroId, '--checkout', lane, '--command', 'next', '--host', 'codex'], { encoding: 'utf8', env: cleanEnv(), stdio: 'pipe' }).trim();
      git(lane, 'switch', '-q', 'feat/t1');
      const child = engineerChild();
      const wrote = writeback(shell, id, {}, codexBlock('subtask-update'));
      strictEqual(wrote.status, 0, wrote.stderr);
      const t1 = await subtask();
      deepStrictEqual([t1.status, t1.engineer_workflow_id], ['in_progress', child.split('/').pop().replace(/\.md$/, '')]);
      deepStrictEqual(held(), [], 'released from both locks');
    });

    it(`${shell}: Phase 5's no-active-workflow exit releases the admission`, () => {
      const joined = joinAndSwitch(shell);
      strictEqual(joined.status, 0, joined.stderr);
      const wrote = writeback(shell, joined.vars.ADMISSION);
      strictEqual(wrote.status, 1);
      match(wrote.stderr, /no active workflow on feat\/t1/);
      deepStrictEqual(held(), []);
    });

    it(`${shell}: what a run's step could change before the join is read again after it; a change, or a failed switch, releases and switches nothing`, () => {
      // The tree dirtied after Phase 2's clean check.
      writeFileSync(join(lane, 'stray.txt'), 'x\n');
      try {
        const dirty = joinAndSwitch(shell);
        strictEqual(dirty.status, 1, dirty.stdout);
        match(dirty.stderr, /working tree changed after Phase 2's clean check/);
      } finally {
        rmSync(join(lane, 'stray.txt'));
      }
      strictEqual(branch(), 'feat/x');
      deepStrictEqual(held(), [], 'released on that exit');
      // The subtask branch's engineer workflow Phase 2 saw, gone since.
      const engineerDir = join(lane, '.agentic-plugins/state/engineer/workflows');
      mkdirSync(engineerDir, { recursive: true });
      const changed = joinAndSwitch(shell, { EXISTING_ENG_PATH: join(engineerDir, 'compose-20261008T000000Z-000001.md') });
      strictEqual(changed.status, 1, changed.stdout);
      match(changed.stderr, /engineer workflow on 'feat\/t1' changed after Phase 2's ownership check/);
      deepStrictEqual(held(), []);
      // A switch that fails: the subtask branch is checked out in the main
      // checkout, so git refuses it in the lane.
      git(main, 'switch', '-q', 'feat/t1');
      try {
        const failed = joinAndSwitch(shell);
        ok(failed.status !== 0 && failed.vars.ADMISSION === undefined, `git's own status, before the end: ${failed.status} ${failed.stdout}`);
        match(failed.stderr, /'feat\/t1' is already (used by worktree|checked out) at/);
      } finally {
        git(main, 'switch', '-q', 'main');
      }
      strictEqual(branch(), 'feat/x');
      deepStrictEqual(held(), []);
    });

    // U7d — the U7c review's item 3: the selected subtask, read again after
    // the join, before the switch, on both hosts. The run's step lands while
    // `admission join` runs (the shim root), so only a read after the join
    // sees it: a read moved before the join passes the stale selection.
    it(`${shell}: a subtask a run's step completes during the join is read again after it; nothing is switched or dispatched`, async () => {
      // A second subtask keeps the macro open once T1 completes.
      const plan = [
        { id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'pending' },
        { id: 'T2', verb: 'compose', branch: 'feat/t2', blocked_by: ['T1'], status: 'blocked' },
      ];
      await freshMacro(plan);
      const step = () => ({ AGENTIC_ORCHESTRATOR_ROOT: shim, DURING_JOIN: JSON.stringify(['subtask-update', '--workflow-path', macroPath, '--host', 'claude', '--subtask-id', 'T1', '--status', 'completed', '--engineer-workflow-id', 'compose-20261008T000000Z-0d0001', '--event', 'updated']) });
      const claude = joinAndSwitch(shell, {}, step());
      strictEqual(claude.status, 1, claude.stdout);
      match(claude.stderr, /Subtask T1 changed after Phase 1's selection \(status was "pending", now "completed"; engineer_workflow_id was "", now "compose-20261008T000000Z-0d0001"\)/);
      strictEqual(branch(), 'feat/x');
      deepStrictEqual(held(), [], 'released on that exit');
      // The Codex mirror, on a macro of its own: its join block, during which
      // the step lands, then its switching block.
      await freshMacro(plan);
      strictEqual(CODEX_REREAD.length, 1, 'one Codex block reads the subtask again');
      const joined = run(shell, `${carried()}\n${codexBlock('admission join', shim)}\necho "ADMISSION=$ADMISSION"`, step());
      strictEqual(joined.status, 0, joined.stderr);
      strictEqual((await subtask()).status, 'completed', 'the step landed during the Codex join');
      const id = joined.vars.ADMISSION;
      const codex = run(shell, `${carried({ ADMISSION: id })}\n${CODEX_REREAD[0]}\necho "PASSED=1"`);
      strictEqual(codex.status, 1, codex.stdout);
      match(codex.stderr, /Subtask T1 changed after its selection \(status was "pending", now "completed"; engineer_workflow_id was "", now "compose-20261008T000000Z-0d0001"\)/);
      strictEqual(codex.vars.PASSED, undefined);
      deepStrictEqual(held(), [], 'the Codex block released too');
      strictEqual(branch(), 'feat/x', 'the Codex block switched nothing');
      // Control: as selected, the Codex block switches and keeps the admission.
      const held2 = execFileSync(process.execPath, [ORCH_STATE, 'admission', 'join', '--macro', macroId, '--checkout', lane, '--command', 'next', '--host', 'codex'], { encoding: 'utf8', env: cleanEnv(), stdio: 'pipe' }).trim();
      const control = run(shell, `${carried({ ADMISSION: held2, SUBTASK_STATUS: 'completed', SUBTASK_EXISTING_ENG_WF_ID: 'compose-20261008T000000Z-0d0001' })}\n${CODEX_REREAD[0]}\necho "PASSED=1"`);
      strictEqual(control.status, 0, control.stderr);
      strictEqual(control.vars.PASSED, '1');
      strictEqual(branch(), 'feat/t1', 'switched');
      deepStrictEqual(held(), [`s-${held2}.json`, `s-${held2}.json`], 'the admission kept for Phase 4');
      execFileSync(process.execPath, [ORCH_STATE, 'admission', 'release', '--macro', macroId, '--checkout', lane, '--admission', held2], { env: cleanEnv(), stdio: 'pipe' });
    });

    // A plan revision (/orchestrator:plan in another session) lands while
    // `admission join` runs: the shim root's state.mjs revises T1 during the
    // join, then hands every call to the real one. Only a read after the join
    // sees it; Phase 1's values are what the agent carries.
    it(`${shell}: a plan revision during the join that changes the subtask's branch, verb, profile or topic is read after it; nothing is switched (both hosts)`, async () => {
      const original = { id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'pending' };
      const revisions = [['branch', 'feat/t1b', 'feat/t1'], ['verb', 'refine', 'compose'], ['profile', 'plan', ''], ['topic', 'a revised topic', '']];
      const codexJoin = codexBlock('admission join', shim);
      const codexReread = codexBlock(CODEX_SWITCH, shim);
      for (const [field, now, was] of revisions) {
        const env = { AGENTIC_ORCHESTRATOR_ROOT: shim, REVISE_MACRO: macroPath, REVISE_T1: JSON.stringify({ [field]: now }) };
        const changed = new RegExp(`\\(${field} was ${JSON.stringify(was)}, now ${JSON.stringify(now)}\\)`);
        await setPlan({ workflowPath: macroPath, host: 'claude', subtasks: [original] });
        const claude = joinAndSwitch(shell, {}, env);
        strictEqual(claude.status, 1, `${field}: ${claude.stdout}${claude.stderr}`);
        match(claude.stderr, new RegExp(`Subtask T1 changed after Phase 1's selection ${changed.source}`));
        strictEqual((await subtask())[field], now, `${field}: the revision landed during the join`);
        strictEqual(branch(), 'feat/x', `${field}: nothing was switched`);
        deepStrictEqual(held(), [], `${field}: released on that exit`);
        // The Codex mirror: its join block, then its switching block.
        await setPlan({ workflowPath: macroPath, host: 'claude', subtasks: [original] });
        const joined = run(shell, `${carried()}\n${codexJoin}\necho "ADMISSION=$ADMISSION"`, env);
        strictEqual(joined.status, 0, joined.stderr);
        match(joined.vars.ADMISSION, /^[0-9a-f]{32}$/);
        const codex = run(shell, `${carried({ ADMISSION: joined.vars.ADMISSION })}\n${codexReread}\necho "PASSED=1"`);
        strictEqual(codex.status, 1, `${field}: ${codex.stdout}${codex.stderr}`);
        match(codex.stderr, new RegExp(`Subtask T1 changed after its selection ${changed.source}`));
        strictEqual(codex.vars.PASSED, undefined);
        strictEqual(branch(), 'feat/x', `${field}: the Codex block switched nothing`);
        deepStrictEqual(held(), [], `${field}: the Codex block released`);
      }
      // Control: through the same shim, no revision — both hosts' blocks
      // switch. The topic ends in a newline, which Phase 1's command
      // substitution dropped from what the agent carries.
      await setPlan({ workflowPath: macroPath, host: 'claude', subtasks: [{ ...original, topic: 'line one\nline two\n' }] });
      const asRead = { SUBTASK_TOPIC: 'line one\nline two' };
      const control = joinAndSwitch(shell, asRead, { AGENTIC_ORCHESTRATOR_ROOT: shim });
      strictEqual(control.status, 0, control.stderr);
      strictEqual(branch(), 'feat/t1');
      execFileSync(process.execPath, [ORCH_STATE, 'admission', 'release', '--macro', macroId, '--checkout', lane, '--admission', control.vars.ADMISSION], { env: cleanEnv(), stdio: 'pipe' });
      git(lane, 'switch', '-q', 'feat/x');
      const joined = run(shell, `${carried(asRead)}\n${codexJoin}\necho "ADMISSION=$ADMISSION"`, { AGENTIC_ORCHESTRATOR_ROOT: shim });
      strictEqual(joined.status, 0, joined.stderr);
      const codex = run(shell, `${carried({ ...asRead, ADMISSION: joined.vars.ADMISSION })}\n${codexReread}\necho "PASSED=1"`);
      strictEqual(codex.status, 0, codex.stderr);
      strictEqual(branch(), 'feat/t1');
      execFileSync(process.execPath, [ORCH_STATE, 'admission', 'release', '--macro', macroId, '--checkout', lane, '--admission', joined.vars.ADMISSION], { env: cleanEnv(), stdio: 'pipe' });
    });

    // The SR refine's Refine-verify, F1: a plan revision during the join gives
    // the pending subtask a predecessor not yet completed, every field the
    // re-read compares unchanged. Phase 1's dependency gate is judged again.
    it(`${shell}: a plan revision during the join that makes the subtask wait on a predecessor is judged after it; nothing is switched (both hosts)`, async () => {
      const t1 = { id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'pending' };
      const revised = (t2Status) => JSON.stringify([{ ...t1, blocked_by: ['T2'] }, { id: 'T2', verb: 'compose', branch: 'feat/t2', blocked_by: [], status: t2Status }]);
      const env = { AGENTIC_ORCHESTRATOR_ROOT: shim, REVISE_MACRO: macroPath, REVISE_PLAN: revised('pending') };
      const claude = joinAndSwitch(shell, {}, env);
      strictEqual(claude.status, 1, `${claude.stdout}${claude.stderr}`);
      match(claude.stderr, /Subtask T1 now waits on: T2 \(the plan changed after Phase 1's selection\); nothing was switched/);
      deepStrictEqual((await subtask()).blocked_by, ['T2'], 'the revision landed during the join');
      strictEqual(branch(), 'feat/x', 'nothing was switched');
      deepStrictEqual(held(), [], 'released on that exit');
      // The Codex mirror: its join block, then its switching block.
      await setPlan({ workflowPath: macroPath, host: 'claude', subtasks: [t1] });
      const joined = run(shell, `${carried()}\n${codexBlock('admission join', shim)}\necho "ADMISSION=$ADMISSION"`, env);
      strictEqual(joined.status, 0, joined.stderr);
      const codex = run(shell, `${carried({ ADMISSION: joined.vars.ADMISSION })}\n${codexBlock(CODEX_SWITCH, shim)}\necho "PASSED=1"`);
      strictEqual(codex.status, 1, `${codex.stdout}${codex.stderr}`);
      match(codex.stderr, /Subtask T1 now waits on: T2 \(the plan changed after its selection\); nothing was switched/);
      strictEqual(codex.vars.PASSED, undefined);
      strictEqual(branch(), 'feat/x', 'the Codex block switched nothing');
      deepStrictEqual(held(), [], 'the Codex block released');
      // Control: the same revision with T2 completed leaves T1 ready. The gate
      // judges readiness, not a changed blocked_by: both hosts switch.
      await setPlan({ workflowPath: macroPath, host: 'claude', subtasks: [t1] });
      const ready = { ...env, REVISE_PLAN: revised('completed') };
      const control = joinAndSwitch(shell, {}, ready);
      strictEqual(control.status, 0, control.stderr);
      strictEqual(branch(), 'feat/t1');
      execFileSync(process.execPath, [ORCH_STATE, 'admission', 'release', '--macro', macroId, '--checkout', lane, '--admission', control.vars.ADMISSION], { env: cleanEnv(), stdio: 'pipe' });
      git(lane, 'switch', '-q', 'feat/x');
      const codexJoined = run(shell, `${carried()}\n${codexBlock('admission join', shim)}\necho "ADMISSION=$ADMISSION"`, ready);
      strictEqual(codexJoined.status, 0, codexJoined.stderr);
      const codexControl = run(shell, `${carried({ ADMISSION: codexJoined.vars.ADMISSION })}\n${codexBlock(CODEX_SWITCH, shim)}\necho "PASSED=1"`);
      strictEqual(codexControl.status, 0, codexControl.stderr);
      strictEqual(branch(), 'feat/t1');
      execFileSync(process.execPath, [ORCH_STATE, 'admission', 'release', '--macro', macroId, '--checkout', lane, '--admission', codexJoined.vars.ADMISSION], { env: cleanEnv(), stdio: 'pipe' });
    });

    // The SR refine's Refine-verify, F2: another session's /orchestrator:plan
    // lands between Phase 3b and Phase 5 (two Bash calls). The child was
    // dispatched for the subtask as Phase 1 read it; the writeback must not
    // bind it to the revised subtask.
    it(`${shell}: a plan revision after the switch that changes the subtask's branch, verb, profile or topic refuses the writeback; the child stays unrecorded and the admission is released (both hosts)`, async () => {
      const original = { id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'pending' };
      const revisions = [['branch', 'feat/t1b', 'feat/t1'], ['verb', 'refine', 'compose'], ['profile', 'plan', ''], ['topic', 'a revised topic', '']];
      const blocks = [['claude', WRITEBACK], ['codex', codexBlock('subtask-update')]];
      git(lane, 'switch', '-q', 'feat/t1');
      const childId = engineerChild().split('/').pop().replace(/\.md$/, '');
      for (const [field, now, was] of revisions) {
        for (const [host, block] of blocks) {
          await setPlan({ workflowPath: macroPath, host: 'claude', subtasks: [original] });
          const id = joinCli(host);
          await setPlan({ workflowPath: macroPath, host: 'claude', subtasks: [{ ...original, [field]: now }] });
          const wrote = writeback(shell, id, {}, block);
          strictEqual(wrote.status, 1, `${host}, ${field}: ${wrote.stdout}`);
          ok(wrote.stderr.includes(`subtask "T1" ${field} is ${JSON.stringify(now)}, not the expected ${JSON.stringify(was)}`), `${host}, ${field}: ${wrote.stderr}`);
          const t1 = await subtask();
          deepStrictEqual([t1.status, t1.engineer_workflow_id, t1[field]], ['pending', undefined, now], `${host}, ${field}: the child is not bound to the revised subtask`);
          deepStrictEqual(held(), [], `${host}, ${field}: released`);
        }
      }
      // Control: no revision. The plan's topic ends in a newline, which the
      // agent's carried value lost, and it has no profile: both writebacks
      // bind the child.
      for (const [host, block] of blocks) {
        await setPlan({ workflowPath: macroPath, host: 'claude', subtasks: [{ ...original, topic: 'line one\nline two\n' }] });
        const id = joinCli(host);
        const wrote = writeback(shell, id, {}, block, { SUBTASK_TOPIC: 'line one\nline two' });
        strictEqual(wrote.status, 0, `${host}: ${wrote.stderr}`);
        const t1 = await subtask();
        deepStrictEqual([t1.status, t1.engineer_workflow_id], ['in_progress', childId], `${host}: bound`);
        deepStrictEqual(held(), [], `${host}: released`);
      }
    });

    // ADR-0067 Decision 4, item 5 — a child re-attached from an earlier
    // dispatch (its writeback was refused, or never ran) while the plan was
    // revised since: Phase 1 read the revised subtask, so its own values match,
    // but the child was dispatched for the subtask as it was. Contract: Phase
    // 5 passes the dispatch the child records, and the write is refused.
    it(`${shell}: a re-attached child whose recorded dispatch the revised subtask no longer matches is not bound, though Phase 1's values match (both hosts)`, async () => {
      const original = { id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'pending' };
      const revisions = [['verb', 'refine', 'compose', 'SUBTASK_VERB'], ['profile', 'plan', '', 'SUBTASK_PROFILE'], ['topic', 'a revised topic', '', 'SUBTASK_TOPIC']];
      const blocks = [['claude', WRITEBACK], ['codex', codexBlock('subtask-update')]];
      git(lane, 'switch', '-q', 'feat/t1');
      const childId = engineerChild({ subtask: 'T1', branch: 'feat/t1', verb: 'compose', profile: '', topic: '' }).split('/').pop().replace(/\.md$/, '');
      for (const [field, now, was, carriedName] of revisions) {
        for (const [host, block] of blocks) {
          await setPlan({ workflowPath: macroPath, host: 'claude', subtasks: [{ ...original, [field]: now }] });
          const id = joinCli(host);
          const wrote = writeback(shell, id, {}, block, { [carriedName]: now });
          strictEqual(wrote.status, 1, `${host}, ${field}: ${wrote.stdout}`);
          ok(wrote.stderr.includes(`(dispatch-changed): ${field} is ${JSON.stringify(now)}; the child was dispatched for ${JSON.stringify(was)}`), `${host}, ${field}: ${wrote.stderr}`);
          const t1 = await subtask();
          deepStrictEqual([t1.status, t1.engineer_workflow_id], ['pending', undefined], `${host}, ${field}: not bound`);
          deepStrictEqual(held(), [], `${host}, ${field}: released`);
        }
      }
      // Control: the subtask as the child records it binds on both hosts.
      for (const [host, block] of blocks) {
        await setPlan({ workflowPath: macroPath, host: 'claude', subtasks: [original] });
        const wrote = writeback(shell, joinCli(host), {}, block);
        strictEqual(wrote.status, 0, `${host}: ${wrote.stderr}`);
        deepStrictEqual([(await subtask()).status, (await subtask()).engineer_workflow_id], ['in_progress', childId], `${host}: bound`);
        deepStrictEqual(held(), [], `${host}: released`);
      }
    });

    it(`${shell}: a worker of the run holding both locks passes with an empty id, and switches; another session is refused`, async () => {
      const run_ = await holdAsRun();
      try {
        const worker = { AGENTIC_AUTOPILOT: RUN, AGENTIC_AUTOPILOT_TOKEN: SECRET };
        const joined = joinAndSwitch(shell, {}, worker);
        strictEqual(joined.status, 0, joined.stderr);
        strictEqual(joined.vars.ADMISSION, '', 'an empty admission id');
        strictEqual(branch(), 'feat/t1');
        deepStrictEqual(held(), [], 'no entry');
        strictEqual(prelude(shell, '', worker).status, 0, "the worker's check passes");
        git(lane, 'switch', '-q', 'feat/x');
        const other = joinAndSwitch(shell);
        strictEqual(other.status, 1, other.stdout);
        match(other.stderr, new RegExp(`another autopilot run holds .*${RUN}`));
        strictEqual(branch(), 'feat/x');
      } finally {
        for (const h of run_) h.release();
      }
    });
  }
});

/** The bash blocks of commands/<name>.md from `## Phase 0` up to `until`, as one script. */
function phases(name, until) {
  const text = readFileSync(join(ORCH_ROOT, 'commands', `${name}.md`), 'utf8');
  const from = text.indexOf('## Phase 0');
  const to = text.indexOf(until);
  // Contract: the runs below execute these phases — a moved heading must fail
  // here, not run part of the runbook.
  ok(from >= 0 && to > from, `${name}.md carries Phase 0 through ${until}`);
  return [...text.slice(from, to).matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1]).join('\n');
}

// finalize.md and abort.md run Phases 0-3 in one shell; resume.md's archive
// block runs after the agent confirmed. Each joins the macro lock before its
// first write and releases on every exit.
describe('/orchestrator:finalize, :abort and :resume archive join the macro lock before their first write (ADR-0067 Decision 4, item 5)', () => {
  let dir;
  let main;
  let lane;
  let macroPath;
  let macroId;
  let macroLock;
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const sessionEntries = () => (existsSync(macroLock) ? readdirSync(macroLock).filter((n) => /^s-[0-9a-f]{32}\.json$/.test(n)) : []);
  const holdAsSession = () => execFileSync(process.execPath, [
    ORCH_STATE, 'admission', 'join', '--macro', macroId, '--checkout', main, '--command', 'done', '--host', 'codex',
  ], { encoding: 'utf8', env: cleanEnv(), stdio: 'pipe' }).trim();
  const runIn = (shell, script, vars = {}) => spawnSync(shell, ['-c', `${Object.entries(vars).map(([k, v]) => `${k}=${q(v)}`).join('\n')}\n${script}`], {
    cwd: lane, encoding: 'utf8',
    env: cleanEnv({ HOME: dir, AGENTIC_ORCHESTRATOR_ROOT: ORCH_ROOT, AGENTIC_ENGINEER_ROOT: ENGINEER_ROOT }),
  });
  const macro = async () => readWorkflow(macroPath).catch(() => null);

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'admission-close-')));
    main = join(dir, 'main');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    writeFileSync(join(main, '.gitignore'), '.agentic-plugins/\n');
    git(main, 'add', '.gitignore');
    git(main, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'feat/x', join(dir, 'lane'));
    main = realpathSync(main);
    lane = realpathSync(join(dir, 'lane'));
  });
  beforeEach(async () => {
    for (const root of [main, lane]) {
      try { execFileSync('chmod', ['-R', 'u+rwX', join(root, '.agentic-plugins')], { stdio: 'ignore' }); } catch { /* none */ }
      rmSync(join(root, '.agentic-plugins'), { recursive: true, force: true });
    }
    ({ filePath: macroPath } = await createWorkflow({
      repoRoot: main, verb: 'plan', host: 'claude',
      gitBaseline: { branch: 'main', head: git(main, 'rev-parse', 'HEAD'), status_digest: '' },
      originalRequest: 'admission close fixture',
    }));
    await setPlan({ workflowPath: macroPath, host: 'claude', subtasks: [{ id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'pending' }] });
    macroId = macroPath.split('/').pop().replace(/\.md$/, '');
    macroLock = locks.macroLockPath(main, macroId);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  for (const [name, status, phase] of [['finalize', 'deferred', 'finalized'], ['abort', 'abandoned', 'aborted']]) {
    for (const shell of SHELLS) {
      it(`${name}.md (${shell}): a session holding the macro lock refuses before the first write; free, it closes the macro and releases`, async () => {
        const script = phases(name, '## Phase 4');
        const other = holdAsSession();
        const refused = runIn(shell, script, { EXPLICIT_WORKFLOW_ID: macroId });
        strictEqual(refused.status, 1, refused.stdout);
        match(refused.stderr, new RegExp(`an interactive session holds .*/orchestrator:done, .*host codex, .*admission ${other}`));
        strictEqual((await macro()).frontmatter.plan.subtasks[0].status, 'pending', 'nothing written');
        deepStrictEqual(sessionEntries(), [`s-${other}.json`]);
        execFileSync(process.execPath, [ORCH_STATE, 'admission', 'release', '--macro', macroId, '--checkout', main, '--admission', other], { env: cleanEnv(), stdio: 'pipe' });
        const closed = runIn(shell, script, { EXPLICIT_WORKFLOW_ID: macroId });
        strictEqual(closed.status, 0, closed.stderr);
        const after_ = (await macro()).frontmatter;
        deepStrictEqual([after_.plan.subtasks[0].status, after_.current_phase, after_.terminal_marker], [status, phase, true]);
        deepStrictEqual(sessionEntries(), [], 'released after the last write');
      });
    }

    it(`${name}.md: a step that fails after the first write releases the admission`, { skip: asRoot && 'root reads any file' }, async () => {
      const home = join(lane, '.agentic-plugins/state/engineer/workflows');
      mkdirSync(home, { recursive: true });
      const unreadable = join(home, 'compose-20261008T000000Z-0bad00.md');
      writeFileSync(unreadable, '---\nworkflow_id: "x"\n---\n');
      execFileSync('chmod', ['000', unreadable]);
      const r = runIn(SHELLS[0], phases(name, '## Phase 4'), { EXPLICIT_WORKFLOW_ID: macroId });
      strictEqual(r.status, 1, r.stdout);
      match(r.stderr, /Step 2 did not archive every engineer child/);
      strictEqual((await macro()).frontmatter.plan.subtasks[0].status, status, 'Phase 1 wrote');
      deepStrictEqual(sessionEntries(), [], 'released on that exit');
    });

    // U7d — the U7c review's item 1: the Codex mirror runs its phases in
    // separate shell calls, so Phases 2 and 3 check the carried admission.
    it(`${name} (Codex mirror): an admission released after Phase 1 stops Phases 2 and 3 before their writes`, async () => {
      const skill = readFileSync(join(ORCH_ROOT, 'core/skills', name, 'SKILL.md'), 'utf8');
      const blocks = [...skill.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1].replaceAll('<orchestrator-plugin-root>', ORCH_ROOT));
      const [phase1] = blocks.filter((b) => b.includes('admission join'));
      const phase2 = blocks.filter((b) => b.includes('admission check') && !b.includes('set-terminal'));
      const [phase3] = blocks.filter((b) => b.includes('set-terminal'));
      strictEqual(phase2.length, 1, 'one Phase 2 check block');
      const vars = { MACRO_ID: macroId, MACRO_PATH: macroPath, REPO_ROOT: lane };
      const joined = runIn(SHELLS[0], `${phase1}\necho "ADMISSION=$ADMISSION"`, vars);
      strictEqual(joined.status, 0, joined.stderr);
      const id = joined.stdout.match(/^ADMISSION=([0-9a-f]{32})$/m)?.[1];
      ok(id, joined.stdout);
      // Control: held, the Phase 2 check passes and keeps the admission.
      strictEqual(runIn(SHELLS[0], phase2[0], { ...vars, ADMISSION: id }).status, 0);
      deepStrictEqual(sessionEntries(), [`s-${id}.json`], 'still held');
      execFileSync(process.execPath, [ORCH_STATE, 'admission', 'release', '--macro', macroId, '--checkout', lane, '--admission', id], { env: cleanEnv(), stdio: 'pipe' });
      const p2 = runIn(SHELLS[0], phase2[0], { ...vars, ADMISSION: id });
      strictEqual(p2.status, 1, p2.stdout);
      match(p2.stderr, /is gone from/);
      const p3 = runIn(SHELLS[0], phase3, { ...vars, ADMISSION: id });
      strictEqual(p3.status, 1, p3.stdout);
      match(p3.stderr, /is gone from/);
      const fm = (await macro()).frontmatter;
      deepStrictEqual([fm.terminal_marker ?? null, fm.plan.subtasks[0].status], [null, status], 'Phase 1 wrote; set-terminal did not run');
      // Control: a held admission, Phase 3 sets the macro terminal and releases.
      const held = execFileSync(process.execPath, [ORCH_STATE, 'admission', 'join', '--macro', macroId, '--checkout', lane, '--command', name, '--host', 'codex'], { encoding: 'utf8', env: cleanEnv(), stdio: 'pipe' }).trim();
      const closed = runIn(SHELLS[0], phase3, { ...vars, ADMISSION: held });
      strictEqual(closed.status, 0, closed.stderr);
      deepStrictEqual([(await macro()).frontmatter.terminal_marker, sessionEntries()], [true, []], 'terminal, and released');
    });

    it(`${name} (Codex mirror): a Phase 2 check that fails on a permission error releases the admission`, { skip: asRoot && 'root reads any file' }, async () => {
      const skill = readFileSync(join(ORCH_ROOT, 'core/skills', name, 'SKILL.md'), 'utf8');
      const [phase2] = [...skill.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1].replaceAll('<orchestrator-plugin-root>', ORCH_ROOT))
        .filter((b) => b.includes('admission check') && !b.includes('set-terminal'));
      const id = execFileSync(process.execPath, [ORCH_STATE, 'admission', 'join', '--macro', macroId, '--checkout', lane, '--command', name, '--host', 'codex'], { encoding: 'utf8', env: cleanEnv(), stdio: 'pipe' }).trim();
      const entry = join(macroLock, `s-${id}.json`);
      execFileSync('chmod', ['000', entry]);
      try {
        const r = runIn(SHELLS[0], phase2, { MACRO_ID: macroId, MACRO_PATH: macroPath, REPO_ROOT: lane, ADMISSION: id });
        strictEqual(r.status, 1, r.stdout);
      } finally {
        if (existsSync(entry)) execFileSync('chmod', ['600', entry]);
      }
      deepStrictEqual(sessionEntries(), [], 'released: no entry left to block the next session');
    });
  }

  for (const shell of SHELLS) {
    it(`resume.md (${shell}): the archive refuses while a session holds the macro lock; free, it archives and releases`, async () => {
      const text = readFileSync(join(ORCH_ROOT, 'commands/resume.md'), 'utf8');
      const blocks = [...text.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1]).filter((b) => b.includes('admission join'));
      strictEqual(blocks.length, 1, 'resume.md: one block joins');
      const other = holdAsSession();
      const refused = runIn(shell, blocks[0], { WORKFLOW: macroPath, REPO_ROOT: lane });
      strictEqual(refused.status, 1, refused.stdout);
      match(refused.stderr, /an interactive session holds/);
      ok(existsSync(macroPath), 'nothing archived');
      execFileSync(process.execPath, [ORCH_STATE, 'admission', 'release', '--macro', macroId, '--checkout', main, '--admission', other], { env: cleanEnv(), stdio: 'pipe' });
      const archived = runIn(shell, blocks[0], { WORKFLOW: macroPath, REPO_ROOT: lane });
      strictEqual(archived.status, 0, archived.stderr);
      ok(!existsSync(macroPath), 'archived');
      deepStrictEqual(sessionEntries(), [], 'released after the archive');
    });
  }
});
