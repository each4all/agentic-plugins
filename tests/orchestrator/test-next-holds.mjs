// ADR-0068 Decision 2, item 5 (impl-hold Task 11): /orchestrator:next never
// dispatches a held subtask by hand. Its hold gate (Phase 1, Phase 3 with the
// engineer's capability, Phase 3b under the holds lock, Phase 4 beside the
// mark) and the dispatch's mark (N4), which the real engineer bootstrap
// continues under AGENTIC_OPERATION_ID, so a hold set during the dispatch
// waits for it; every exit after the mark's publication withdraws a mark no
// child carries. Run through the runbook's own blocks (commands/next.md and
// the Codex mirror), with the real orchestrator and engineer scripts.
//
// Real git repositories: a main checkout holding the macro and the holds, and
// a linked worktree `lane` where the command runs.

import { describe, it, before, after, beforeEach } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { carriedTextDir, withTextDir } from './_next-text-dir.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ORCH_ROOT = join(REPO_ROOT, 'plugins/orchestrator');
const ENGINEER_ROOT = join(REPO_ROOT, 'plugins/engineer');
const ORCH_STATE = join(ORCH_ROOT, 'scripts/state.mjs');
const ENG_STATE = join(ENGINEER_ROOT, 'scripts/state.mjs');
const { createWorkflow, setPlan, readWorkflow } = await import(pathToFileURL(ORCH_STATE).href);
const holds = await import(pathToFileURL(join(ORCH_ROOT, 'scripts/lib/holds.mjs')).href);
const ops = await import(pathToFileURL(join(ORCH_ROOT, 'scripts/lib/hold-ops.mjs')).href);
const SHELLS = ['bash', 'zsh'].filter((s) => spawnSync(s, ['-c', 'exit 0']).status === 0);

const NEXT = readFileSync(join(ORCH_ROOT, 'commands/next.md'), 'utf8');
const SKILL = readFileSync(join(ORCH_ROOT, 'core/skills/next/SKILL.md'), 'utf8');
const blocksOf = (text) => [...text.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
/** The one fenced bash block of `text` holding every needle. */
function blockWith(text, ...needles) {
  const found = blocksOf(text).filter((b) => needles.every((n) => b.includes(n)));
  // Contract: the runs below execute this block — a renamed line must fail
  // here, not run nothing.
  strictEqual(found.length, 1, `one bash block holds ${needles.join(' + ')}`);
  return found[0].replaceAll('<orchestrator-plugin-root>', ORCH_ROOT);
}
const PHASE1_GATE = blockWith(NEXT, 'state.mjs" hold-gate', '--checkout "$REPO_ROOT" || exit 1');
const PHASE3 = blockWith(NEXT, 'discover-engineer.mjs" preflight');
const JOIN_AND_SWITCH = blockWith(NEXT, 'admission join');
const PRELUDE = blockWith(NEXT, 'export AGENTIC_PARENT_WORKFLOW="$MACRO_ID"');
const WRITEBACK = blockWith(NEXT, '--status=in_progress');
const CODEX_GATE = blockWith(SKILL, 'state.mjs" hold-gate', '--checkout "$REPO_ROOT" || exit 1');
const CODEX_JOIN = blockWith(SKILL, 'admission join');
const CODEX_SWITCH = blockWith(SKILL, 'switch --no-track -c "$SUBTASK_BRANCH"');
const CODEX_PRELUDE = blockWith(SKILL, 'export AGENTIC_PARENT_WORKFLOW="$MACRO_ID"');
const CODEX_WRITEBACK = blockWith(SKILL, '--status in_progress');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
// The operator's agentic session stays out (C88).
const cleanEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_') && k !== 'CLAUDE_PLUGIN_ROOT' && k !== 'CLAUDE_CODE_SESSION_ID')),
  ...GIT_ENV,
  ...extra,
});
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('/orchestrator:next and holds (ADR-0068 Decision 2, item 5)', () => {
  let dir;
  let main;
  let lane;
  let macroPath;
  let macroId;
  let fakeEngineer;

  const T1 = (over = {}) => ({ id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'pending', ...over });
  const carried = (over = {}) => carriedTextDir({
    repoRoot: lane, macroPath, subtask: T1(), engineerRoot: ENGINEER_ROOT, engineerWorkflow: '', ...over,
  }, dir);
  function run(shell, script, env = {}) {
    const r = spawnSync(shell, ['-c', script], {
      cwd: lane, encoding: 'utf8', env: cleanEnv({ HOME: dir, AGENTIC_ORCHESTRATOR_ROOT: ORCH_ROOT, ...env }),
    });
    const vars = Object.fromEntries([...r.stdout.matchAll(/^(\w+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
    return { ...r, vars };
  }
  const gateCli = (...extra) => spawnSync(process.execPath, [
    ORCH_STATE, 'hold-gate', '--workflow-path', macroPath, '--subtask-id', 'T1', '--branch', 'feat/t1', '--checkout', lane, ...extra,
  ], { encoding: 'utf8', env: cleanEnv() });
  const activate = () => holds.writeProtocol(main, macroId, { writtenBy: 'test' });
  const records = () => {
    const d = holds.opsDir(main, macroId, 'T1');
    return existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.json')).sort() : [];
  };
  const mark = (textDir) => JSON.parse(readFileSync(join(textDir, 'dispatch-mark.json'), 'utf8'));
  const branch = () => git(lane, 'branch', '--show-current');
  const subtask = async () => (await readWorkflow(macroPath)).frontmatter.plan.subtasks.find((s) => s.id === 'T1');
  const hold = () => ops.setHold({ mainRoot: main, macroId, subtaskId: 'T1', branch: 'feat/t1', lane: null });
  const handoff = () => ops.completeHandoff({ mainRoot: main, macroId, subtaskId: 'T1', stateRoots: [main, lane] });
  /** The engineer's bootstrap as Phase 4 runs it: the real create, given the exports, opening its operation. */
  const bootstrap = (operationId, opDir = mkdtempSync(join(dir, 'op-'))) => {
    const r = spawnSync(process.execPath, [
      ENG_STATE, 'create', '--repo-root', lane, '--verb', 'compose', '--host', 'claude', '--persona', 'engineer',
      '--git-baseline-branch', 'feat/t1', '--git-baseline-head', git(lane, 'rev-parse', 'HEAD'), '--status-digest', 'x',
      '--profile', 'plan', '--original-request', 'holds fixture', '--current-phase', 'phase-0-bootstrap',
      '--next-action', 'x', '--parent-workflow', macroId, '--originating-subtask', 'T1',
      '--dispatch-selection', JSON.stringify({ subtask: 'T1', branch: 'feat/t1', verb: 'compose', profile: '', topic: '' }),
      '--operation-dir', opDir,
    ], { encoding: 'utf8', env: cleanEnv(operationId ? { AGENTIC_OPERATION_ID: operationId } : {}), cwd: lane });
    return { ...r, path: r.stdout.trim(), opDir };
  };
  /** The verb's last write, which ends its operation. */
  const finishVerb = (path, opDir) => spawnSync(process.execPath, [
    ENG_STATE, 'finish-verb', '--workflow-path', path, '--host', 'claude', '--operation-dir', opDir, '--next-action', 'x',
    '--next-step-kind', 'verb', '--next-step-verb', 'critique', '--next-step-confidence', 'HIGH',
  ], { encoding: 'utf8', env: cleanEnv(), cwd: lane });
  const entriesOf = (path) => holds.decodePersonaOperations(holds.readWorkflowFacts(path).fields.persona_operations).ops;

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'next-holds-')));
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
    // An engineer that is not hold-aware: its hold-capability fails; every
    // other command is the real engineer's.
    fakeEngineer = join(dir, 'old-engineer');
    mkdirSync(join(fakeEngineer, 'scripts'), { recursive: true });
    writeFileSync(join(fakeEngineer, 'scripts', 'state.mjs'), [
      "import { spawnSync } from 'node:child_process';",
      "if (process.argv[2] === 'hold-capability') process.exit(2);",
      `const r = spawnSync(process.execPath, [${JSON.stringify(ENG_STATE)}, ...process.argv.slice(2)], { stdio: 'inherit' });`,
      'process.exit(r.status ?? 1);',
    ].join('\n'));
  });
  beforeEach(async () => {
    for (const root of [main, lane]) rmSync(join(root, '.agentic-plugins'), { recursive: true, force: true });
    if (branch() !== 'feat/x') git(lane, 'switch', '-q', 'feat/x');
    rmSync(join(dir, 'other'), { recursive: true, force: true });
    try { git(main, 'worktree', 'prune'); } catch { /* none */ }
    ({ filePath: macroPath } = await createWorkflow({
      repoRoot: main, verb: 'plan', host: 'claude',
      gitBaseline: { branch: 'main', head: git(main, 'rev-parse', 'HEAD'), status_digest: '' },
      originalRequest: 'holds runbook fixture',
    }));
    await setPlan({ workflowPath: macroPath, host: 'claude', subtasks: [T1(), { id: 'T2', verb: 'compose', branch: 'feat/t2', blocked_by: [], status: 'pending' }] });
    macroId = macroPath.split('/').pop().replace(/\.md$/, '');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  describe('state.mjs hold-gate', () => {
    it('a macro whose holds are off: nothing new — no refusal, no output, no holds directory', () => {
      const r = gateCli('--engineer-root', fakeEngineer);
      deepStrictEqual([r.status, r.stdout, r.stderr], [0, '', '']);
      strictEqual(existsSync(holds.holdsDir(main, macroId)), false);
    });

    it('refuses a pending and a held hold, naming the release; another subtask\'s hold does not refuse', async () => {
      activate();
      strictEqual(gateCli().status, 0, 'on, with no hold');
      const other = await ops.setHold({ mainRoot: main, macroId, subtaskId: 'T2', branch: 'feat/t2' });
      strictEqual(gateCli().status, 0, gateCli().stderr);
      ok(other.hold_id);
      const h = await hold();
      let r = gateCli();
      strictEqual(r.status, 1);
      match(r.stderr, new RegExp(`Subtask T1 is not dispatched by hand: subtask T1 is held \\(hold ${h.hold_id}, its handoff pending\\); the owner gives it back with agentic-autopilot release T1 --macro ${macroId} --hold ${h.hold_id}`));
      strictEqual((await handoff()).state, 'held');
      r = gateCli();
      strictEqual(r.status, 1);
      match(r.stderr, new RegExp(`subtask T1 is held \\(hold ${h.hold_id}\\); the owner gives it back`));
    });

    it('refuses a hold record that cannot be read, a release not compared yet, a rejected release, and an unreadable marker', async () => {
      activate();
      mkdirSync(join(holds.holdsDir(main, macroId), 'holds'), { recursive: true });
      writeFileSync(holds.recordPath(main, macroId, 'holds', 'T1'), '{');
      let r = gateCli();
      strictEqual(r.status, 1);
      match(r.stderr, /hold records cannot be read .*--discard-unreadable keeps a copy/);
      const h = await hold().catch(() => null);
      strictEqual(h, null, 'setHold refuses over the unreadable record');
      rmSync(holds.recordPath(main, macroId, 'holds', 'T1'));
      const held = await hold();
      strictEqual((await handoff()).state, 'held');
      const basis = { fingerprint_version: 1, fingerprint: 'f', tree_digest: 't', content_digest: 'c', child: null };
      await ops.releaseHold({ mainRoot: main, macroId, subtaskId: 'T1', holdId: held.hold_id, stateRoots: [main, lane], basisOf: async () => basis });
      r = gateCli();
      strictEqual(r.status, 1);
      match(r.stderr, /release \(hold [0-9a-f]+\) is not compared yet; a run compares the release before it steps the lane, and dispatches the subtask once it is ready: launch \/orchestrator:autopilot/);
      const cmp = await ops.compareRelease({ mainRoot: main, macroId, subtaskId: 'T1', stateRoots: [main, lane], basisOf: async () => ({ ...basis, tree_digest: 'moved' }) });
      strictEqual(cmp.verdict, 'rejected');
      r = gateCli();
      strictEqual(r.status, 1);
      match(r.stderr, /was rejected: the lane changed after its release; hold it and release it again/);
      writeFileSync(holds.protocolPath(main, macroId), '{');
      r = gateCli();
      strictEqual(r.status, 1);
      match(r.stderr, /the holds directory of .* cannot be read .* so whether subtask T1 is held cannot be told/);
    });

    it('refuses an open persona operation in the lane, naming writer-clear; a cleared one does not refuse', () => {
      activate();
      const id = 'op-20261026T000000Z-0badc0de';
      holds.publishOpRecord(main, macroId, 'T1', { operation_id: id, kind: 'verb', subtask_id: 'T1' });
      const r = gateCli();
      strictEqual(r.status, 1);
      match(r.stderr, new RegExp(`a persona operation is open in subtask T1's lane: ${id} \\(verb\\).*agentic-autopilot writer-clear T1 --macro ${macroId} --operation <id>`));
      holds.clearOperation(main, macroId, 'T1', id, { by: 'test' });
      strictEqual(gateCli().status, 0, gateCli().stderr);
    });

    it('with the holds on, refuses an engineer that is not hold-aware (Phase 3); the real one passes', () => {
      activate();
      const r = gateCli('--engineer-root', fakeEngineer);
      strictEqual(r.status, 1);
      match(r.stderr, /the holds of .* are on, and the engineer at .*old-engineer is not hold-aware .*install the engineer release with hold-persona-1/);
      strictEqual(gateCli('--engineer-root', ENGINEER_ROOT).status, 0);
    });
  });

  describe('the mark, in the library', () => {
    const args = () => ({ mainRoot: main, macroId, subtaskId: 'T1', branch: 'feat/t1', stateRoots: [main, lane] });
    it('a macro whose holds are off: the mark makes no holds directory', async () => {
      const r = await ops.publishDispatchMark(args());
      deepStrictEqual(r, { active: false, operationId: null });
      strictEqual(existsSync(holds.holdsDir(main, macroId)), false);
    });

    it('an operation published between the mark and its second look withdraws the mark and refuses', async () => {
      activate();
      const rival = 'op-20261026T000000Z-0000beef';
      await ops.publishDispatchMark({ ...args(), hooks: { afterPublish: () => holds.publishOpRecord(main, macroId, 'T1', { operation_id: rival, kind: 'checkpoint', subtask_id: 'T1' }) } })
        .then(() => ok(false, 'refused'), (err) => match(err.message, new RegExp(`${rival} \\(checkpoint\\)`)));
      deepStrictEqual(records(), [`${rival}.json`], 'the mark is withdrawn, the rival left');
    });

    it('an operation begun before the holds turned on (an entry on the child, no record) refuses the gate', async () => {
      git(lane, 'switch', '-q', 'feat/t1');
      const child = bootstrap(null);
      strictEqual(child.status, 0, child.stderr);
      git(lane, 'switch', '-q', 'feat/x');
      deepStrictEqual(entriesOf(child.path).map((o) => o.ext), [false]);
      activate();
      const r = gateCli();
      strictEqual(r.status, 1);
      match(r.stderr, new RegExp(`a persona operation is open in subtask T1's lane: ${entriesOf(child.path)[0].id}`));
    });

    it('a mark an archived child carries is not withdrawn', async () => {
      activate();
      const m = await ops.publishDispatchMark(args());
      const archive = join(lane, '.agentic-plugins/state/engineer/archive');
      mkdirSync(archive, { recursive: true });
      const doc = JSON.stringify(JSON.stringify({ v: 1, ops: [{ id: m.operationId, kind: 'verb', opened_at: '2026-10-26T00:00:00Z', ext: true }] }));
      writeFileSync(join(archive, 'compose-20261026T000000Z-aaaaaa.md'), [
        '---', 'workflow_id: "compose-20261026T000000Z-aaaaaa"', `parent_workflow: "${macroId}"`, 'originating_subtask: "T1"',
        'git_baseline:', '  branch: "feat/t1"', `persona_operations: ${doc}`, '---', '', 'body', '',
      ].join('\n'));
      deepStrictEqual(await ops.withdrawDispatchMark({ ...args(), operationId: m.operationId }), { state: 'carried' });
      deepStrictEqual(records(), [`${m.operationId}.json`]);
    });
  });

  for (const shell of SHELLS) {
    describe(`the runbook's blocks (${shell})`, () => {
      it("Phase 1's hold gate and Phase 3's capability check refuse, before anything is switched or written", async () => {
        activate();
        await hold();
        for (const block of [PHASE1_GATE, PHASE3]) {
          const r = run(shell, withTextDir(block, carried()));
          strictEqual(r.status, 1, r.stdout);
          match(r.stderr, /Subtask T1 is not dispatched by hand: subtask T1 is held/);
        }
        strictEqual(branch(), 'feat/x');
        deepStrictEqual(records(), []);
      });

      it('Phase 3b publishes the mark; a hold set during the dispatch waits for it; the real engineer bootstrap continues it, and its last write ends it', async () => {
        activate();
        const textDir = carried();
        const joined = run(shell, withTextDir(JOIN_AND_SWITCH, textDir));
        strictEqual(joined.status, 0, joined.stderr);
        strictEqual(branch(), 'feat/t1');
        const m = mark(textDir);
        match(m.operation_id, holds.OPERATION_ID_RE);
        deepStrictEqual([m.active, m.reattach], [true, false]);
        deepStrictEqual(records(), [`${m.operation_id}.json`]);
        const rec = holds.readOps(main, macroId, 'T1').ops[0].record;
        deepStrictEqual([rec.kind, rec.workflow_id, rec.subtask_id], ['verb', null, 'T1']);
        // The owner holds the subtask now: its handoff waits for the dispatch.
        await hold();
        const waiting = await handoff();
        strictEqual(waiting.state, 'pending');
        match(waiting.blocker, new RegExp(`a persona operation is open in the lane: ${m.operation_id} \\(verb\\)`));
        // Phase 4's check beside its own mark refuses: the hold applies now.
        const pre = run(shell, `${withTextDir(PRELUDE, textDir)}\necho "OPID=\${AGENTIC_OPERATION_ID:-}"`);
        strictEqual(pre.status, 1);
        match(pre.stderr, /subtask T1 is held/);
        // Without the hold, the prelude exports the mark's id.
        rmSync(holds.recordPath(main, macroId, 'holds', 'T1'));
        const pre2 = run(shell, `${withTextDir(PRELUDE, textDir)}\necho "OPID=\${AGENTIC_OPERATION_ID:-}"`);
        strictEqual(pre2.status, 0, pre2.stderr);
        strictEqual(pre2.vars.OPID, m.operation_id);
        // The engineer's bootstrap continues the mark under that id.
        const child = bootstrap(pre2.vars.OPID);
        strictEqual(child.status, 0, child.stderr);
        deepStrictEqual(entriesOf(child.path).map((o) => [o.id, o.ext]), [[m.operation_id, true]]);
        deepStrictEqual(records(), [`${m.operation_id}.json`], 'one record, the mark, continued');
        // Phase 5: the child carries the mark, so it stays, the engineer's.
        const wrote = run(shell, withTextDir(WRITEBACK, textDir));
        strictEqual(wrote.status, 0, wrote.stderr);
        match(wrote.stderr, /is its engineer's operation now/);
        deepStrictEqual(records(), [`${m.operation_id}.json`]);
        strictEqual((await subtask()).status, 'in_progress');
        // The verb's last write ends it: the record goes with the entry.
        const fin = finishVerb(child.path, child.opDir);
        strictEqual(fin.status, 0, fin.stderr);
        deepStrictEqual(records(), []);
      });

      it('an exit before the engineer took the mark over withdraws it: a failed switch, and a Phase 5 with no child', async () => {
        activate();
        // The switch fails: the subtask's branch is checked out elsewhere.
        git(main, 'worktree', 'add', '-q', join(dir, 'other'), 'feat/t1');
        let textDir = carried();
        const failed = run(shell, withTextDir(JOIN_AND_SWITCH, textDir));
        strictEqual(failed.status === 0, false, 'the switch failed');
        match(mark(textDir).operation_id, holds.OPERATION_ID_RE, 'a mark was published before the switch');
        deepStrictEqual(records(), [], 'and withdrawn by the exit');
        git(main, 'worktree', 'remove', '--force', join(dir, 'other'));
        // The engineer never created its child: Phase 5's exit withdraws it.
        textDir = carried();
        strictEqual(run(shell, withTextDir(JOIN_AND_SWITCH, textDir)).status, 0);
        strictEqual(records().length, 1);
        const wrote = run(shell, withTextDir(WRITEBACK, textDir));
        strictEqual(wrote.status, 1);
        match(wrote.stderr, /withdrew the dispatch mark/);
        deepStrictEqual(records(), []);
        strictEqual((await subtask()).status, 'pending', 'nothing was recorded in progress');
      });

      it('a hold set before Phase 3b refuses it under the holds lock; nothing is switched, published or held', async () => {
        activate();
        await hold();
        const textDir = carried();
        const r = run(shell, withTextDir(JOIN_AND_SWITCH, textDir));
        strictEqual(r.status, 1);
        match(r.stderr, /Subtask T1 is not dispatched by hand: subtask T1 is held/);
        strictEqual(branch(), 'feat/x');
        deepStrictEqual(records(), []);
        strictEqual(existsSync(join(textDir, 'dispatch-mark.json')), false);
      });

      it('the prelude run again before a later engineer block passes once the engineer holds the lane, though a hold is set since; the hold is handed over after the verb', async () => {
        activate();
        const textDir = carried();
        strictEqual(run(shell, withTextDir(JOIN_AND_SWITCH, textDir)).status, 0);
        const pre = run(shell, `${withTextDir(PRELUDE, textDir)}\necho "OPID=\${AGENTIC_OPERATION_ID:-}"`);
        strictEqual(pre.status, 0, pre.stderr);
        // A hold set between the check and the engineer's first write waits.
        await hold();
        const child = bootstrap(pre.vars.OPID);
        strictEqual(child.status, 0, child.stderr);
        strictEqual((await handoff()).state, 'pending', 'the engineer holds the lane: the hold waits');
        const again = run(shell, `${withTextDir(PRELUDE, textDir)}\necho "OPID=\${AGENTIC_OPERATION_ID:-}"`);
        strictEqual(again.status, 0, again.stderr);
        strictEqual(again.vars.OPID, pre.vars.OPID, 'the same id, for the same operation');
        strictEqual(finishVerb(child.path, child.opDir).status, 0);
        // The hold, set with no lane, takes the worktree its branch is in at
        // the handoff: the dispatching session's admission holds that lane
        // until Phase 5 releases it.
        strictEqual((await handoff()).state, 'pending', "the dispatch's session still holds the lane");
        const wrote = run(shell, withTextDir(WRITEBACK, textDir));
        strictEqual(wrote.status, 0, wrote.stderr);
        strictEqual((await handoff()).state, 'held', 'handed over once the verb and its dispatch ended');
        strictEqual(holds.readOwnerHold(main, macroId, 'T1').record.lane, realpathSync(lane));
      });

      it('a dispatch whose check before the engineer refused is not recorded in progress, though a linked child is on the branch', async () => {
        activate();
        git(lane, 'switch', '-q', 'feat/t1');
        const first = bootstrap(null);
        strictEqual(first.status, 0, first.stderr);
        strictEqual(finishVerb(first.path, first.opDir).status, 0);
        git(lane, 'switch', '-q', 'feat/x');
        const textDir = carried({ engineerWorkflow: first.path });
        strictEqual(run(shell, withTextDir(JOIN_AND_SWITCH, textDir)).status, 0);
        await hold();
        strictEqual(run(shell, withTextDir(PRELUDE, textDir)).status, 1, 'the check refuses the held subtask');
        const wrote = run(shell, withTextDir(WRITEBACK, textDir));
        strictEqual(wrote.status, 1);
        match(wrote.stderr, /did not pass for this dispatch; subtask T1 is not recorded in progress/);
        strictEqual((await subtask()).status, 'pending');
      });

      it('holds turned on after Phase 3 passed an engineer that is not hold-aware: the check before the engineer refuses it', async () => {
        const textDir = carried({ engineerRoot: fakeEngineer });
        // Phase 3's check, the holds off: the old engineer passes.
        strictEqual(gateCli('--engineer-root', fakeEngineer).status, 0, 'off, Phase 3 lets the old engineer pass');
        activate();
        strictEqual(run(shell, withTextDir(JOIN_AND_SWITCH, textDir)).status, 0);
        const pre = run(shell, withTextDir(PRELUDE, textDir));
        strictEqual(pre.status, 1);
        match(pre.stderr, /old-engineer is not hold-aware/);
      });

      it("a mark that cannot be read is no mark: the check refuses, rather than leaving the engineer's bootstrap a record it refuses", async () => {
        activate();
        const textDir = carried();
        strictEqual(run(shell, withTextDir(JOIN_AND_SWITCH, textDir)).status, 0);
        writeFileSync(join(holds.opsDir(main, macroId, 'T1'), `${mark(textDir).operation_id}.json`), '{');
        const pre = run(shell, withTextDir(PRELUDE, textDir));
        strictEqual(pre.status, 1);
        match(pre.stderr, /the dispatch's mark .* cannot be read/);
      });

      it('a re-attach publishes no mark, and its engineer resume opens its own operation', async () => {
        activate();
        git(lane, 'switch', '-q', 'feat/t1');
        const first = bootstrap(null);
        strictEqual(first.status, 0, first.stderr);
        strictEqual(finishVerb(first.path, first.opDir).status, 0);
        git(lane, 'switch', '-q', 'feat/x');
        const textDir = carried({ subtask: T1(), engineerWorkflow: first.path });
        const joined = run(shell, withTextDir(JOIN_AND_SWITCH, textDir));
        strictEqual(joined.status, 0, joined.stderr);
        deepStrictEqual(mark(textDir), { active: true, operation_id: null, reattach: true });
        deepStrictEqual(records(), []);
        const pre = run(shell, `${withTextDir(PRELUDE, textDir)}\necho "OPID=\${AGENTIC_OPERATION_ID-unset}"`, { AGENTIC_OPERATION_ID: 'op-20261026T000000Z-00000000' });
        strictEqual(pre.status, 0, pre.stderr);
        strictEqual(pre.vars.OPID, 'unset', 'no id is exported, and a stale one is dropped');
        const resumed = spawnSync(process.execPath, [
          ENG_STATE, 'append', '--workflow-path', first.path, '--host', 'claude', '--verb', 'compose',
          '--operation-dir', mkdtempSync(join(dir, 'op-')), '--open-operation', 'verb', '--phase-label', 'resume', '--phase-note', 'x',
          '--current-phase', 'phase-0-resume', '--next-action', 'x', '--event', 'resumed',
        ], { encoding: 'utf8', env: cleanEnv(), cwd: lane });
        strictEqual(resumed.status, 0, resumed.stderr);
        // The prelude again, before the engineer's next block: its operation is the engineer's.
        const again = run(shell, withTextDir(PRELUDE, textDir));
        strictEqual(again.status, 0, again.stderr);
      });

      it('holds turned on after Phase 3b judged them off: Phase 4 refuses, since no mark is there for a hold to wait for', async () => {
        const textDir = carried();
        strictEqual(run(shell, withTextDir(JOIN_AND_SWITCH, textDir)).status, 0);
        deepStrictEqual(mark(textDir), { active: false, operation_id: null, reattach: false });
        deepStrictEqual(records(), [], 'nothing new while the holds are off');
        activate();
        const pre = run(shell, withTextDir(PRELUDE, textDir));
        strictEqual(pre.status, 1);
        match(pre.stderr, /turned on after the dispatch judged them off/);
      });

      it('a dispatch whose holds were off at the switch passes the prelude again once its engineer holds the lane, though they turned on since (N8)', async () => {
        const textDir = carried();
        strictEqual(run(shell, withTextDir(JOIN_AND_SWITCH, textDir)).status, 0);
        deepStrictEqual(mark(textDir), { active: false, operation_id: null, reattach: false });
        const pre = run(shell, withTextDir(PRELUDE, textDir));
        strictEqual(pre.status, 0, pre.stderr);
        // The engineer's bootstrap opens its own operation (no mark to continue).
        const child = bootstrap(null);
        strictEqual(child.status, 0, child.stderr);
        // The owner's first hold of the macro turns its holds on.
        activate();
        const again = run(shell, withTextDir(PRELUDE, textDir));
        strictEqual(again.status, 0, again.stderr);
        const wrote = run(shell, withTextDir(WRITEBACK, textDir));
        strictEqual(wrote.status, 0, wrote.stderr);
        strictEqual((await subtask()).status, 'in_progress');
      });

      it('a later prelude that refuses removes the earlier pass: Phase 5 does not record the dispatch (N9)', async () => {
        activate();
        const textDir = carried();
        strictEqual(run(shell, withTextDir(JOIN_AND_SWITCH, textDir)).status, 0);
        strictEqual(run(shell, withTextDir(PRELUDE, textDir)).status, 0);
        ok(existsSync(join(textDir, 'dispatch-mark.json.checked')), 'the first check passed');
        await hold();
        strictEqual(run(shell, withTextDir(PRELUDE, textDir)).status, 1, 'no engineer holds the lane: the hold refuses');
        strictEqual(existsSync(join(textDir, 'dispatch-mark.json.checked')), false);
        const wrote = run(shell, withTextDir(WRITEBACK, textDir));
        strictEqual(wrote.status, 1);
        match(wrote.stderr, /did not pass for this dispatch; subtask T1 is not recorded in progress/);
        strictEqual((await subtask()).status, 'pending');
      });

      it('a re-attach whose holds were off at the switch, refused once they turned on, is not recorded in progress (N9)', async () => {
        git(lane, 'switch', '-q', 'feat/t1');
        const first = bootstrap(null);
        strictEqual(first.status, 0, first.stderr);
        strictEqual(finishVerb(first.path, first.opDir).status, 0);
        git(lane, 'switch', '-q', 'feat/x');
        const textDir = carried({ engineerWorkflow: first.path });
        strictEqual(run(shell, withTextDir(JOIN_AND_SWITCH, textDir)).status, 0);
        deepStrictEqual(mark(textDir), { active: false, operation_id: null, reattach: true });
        activate();
        await hold();
        strictEqual(run(shell, withTextDir(PRELUDE, textDir)).status, 1);
        const wrote = run(shell, withTextDir(WRITEBACK, textDir));
        strictEqual(wrote.status, 1);
        match(wrote.stderr, /did not pass for this dispatch/);
        strictEqual((await subtask()).status, 'pending');
      });

      it('a check that fails on an error (a mark file that cannot be read) takes its earlier pass away: Phase 5 does not record the dispatch', async () => {
        activate();
        const textDir = carried();
        strictEqual(run(shell, withTextDir(JOIN_AND_SWITCH, textDir)).status, 0);
        const pre = run(shell, `${withTextDir(PRELUDE, textDir)}\necho "OPID=\${AGENTIC_OPERATION_ID:-}"`);
        strictEqual(pre.status, 0, pre.stderr);
        strictEqual(bootstrap(pre.vars.OPID).status, 0);
        ok(existsSync(join(textDir, 'dispatch-mark.json.checked')));
        writeFileSync(join(textDir, 'dispatch-mark.json'), '{');
        strictEqual(run(shell, withTextDir(PRELUDE, textDir)).status === 0, false, 'the check fails');
        strictEqual(existsSync(join(textDir, 'dispatch-mark.json.checked')), false);
        const wrote = run(shell, withTextDir(WRITEBACK, textDir));
        strictEqual(wrote.status, 1);
        strictEqual((await subtask()).status, 'pending');
      });

      it('a check that fails in its discovery (the repository\'s worktrees cannot be listed) takes its earlier pass away first: Phase 5 does not record the dispatch', { skip: process.getuid?.() === 0 && 'root reads a directory without its permission' }, async () => {
        activate();
        const textDir = carried();
        strictEqual(run(shell, withTextDir(JOIN_AND_SWITCH, textDir)).status, 0);
        const pre = run(shell, `${withTextDir(PRELUDE, textDir)}\necho "OPID=\${AGENTIC_OPERATION_ID:-}"`);
        strictEqual(pre.status, 0, pre.stderr);
        strictEqual(bootstrap(pre.vars.OPID).status, 0);
        ok(existsSync(join(textDir, 'dispatch-mark.json.checked')), 'the first check passed');
        // The check itself, as Phase 4 runs it, against a worktree list it
        // cannot read: it fails, and the earlier pass is gone.
        const worktrees = join(main, '.git', 'worktrees');
        chmodSync(worktrees, 0o111);
        let r;
        try {
          r = spawnSync(process.execPath, [
            ORCH_STATE, 'dispatch-mark-check', '--workflow-path', macroPath, '--subtask-id', 'T1', '--branch', 'feat/t1',
            '--checkout', lane, '--mark-file', join(textDir, 'dispatch-mark.json'),
          ], { encoding: 'utf8', env: cleanEnv(), cwd: lane });
        } finally {
          chmodSync(worktrees, 0o755);
        }
        ok(r.status !== 0, `the check fails on the worktree list: ${r.stderr}`);
        strictEqual(existsSync(join(textDir, 'dispatch-mark.json.checked')), false, 'no earlier pass survives the failed check');
        const wrote = run(shell, withTextDir(WRITEBACK, textDir));
        strictEqual(wrote.status, 1);
        strictEqual((await subtask()).status, 'pending');
      });

      it('a dispatch whose mark file is gone is not recorded in progress (N9)', async () => {
        const textDir = carried();
        strictEqual(run(shell, withTextDir(JOIN_AND_SWITCH, textDir)).status, 0);
        strictEqual(run(shell, withTextDir(PRELUDE, textDir)).status, 0);
        strictEqual(bootstrap(null).status, 0);
        rmSync(join(textDir, 'dispatch-mark.json'));
        const wrote = run(shell, withTextDir(WRITEBACK, textDir));
        strictEqual(wrote.status, 1);
        match(wrote.stderr, /dispatch-mark\.json is missing, so no check before the engineer passed/);
        strictEqual((await subtask()).status, 'pending');
      });
    });
  }

  it('the Codex mirror: its Phase 1 gate refuses a held subtask; its switch publishes the mark, its prelude exports it, its writeback withdraws one no child carries', async () => {
    const shell = SHELLS[0];
    activate();
    await hold();
    let r = run(shell, withTextDir(CODEX_GATE, carried()));
    strictEqual(r.status, 1);
    match(r.stderr, /subtask T1 is held/);
    rmSync(holds.recordPath(main, macroId, 'holds', 'T1'));
    const textDir = carried();
    r = run(shell, withTextDir(CODEX_JOIN, textDir));
    strictEqual(r.status, 0, r.stderr);
    r = run(shell, withTextDir(CODEX_SWITCH, textDir));
    strictEqual(r.status, 0, r.stderr);
    const m = mark(textDir);
    deepStrictEqual(records(), [`${m.operation_id}.json`]);
    r = run(shell, `${withTextDir(CODEX_PRELUDE, textDir)}\necho "OPID=\${AGENTIC_OPERATION_ID:-}"`);
    strictEqual(r.status, 0, r.stderr);
    strictEqual(r.vars.OPID, m.operation_id);
    r = run(shell, withTextDir(CODEX_WRITEBACK, textDir));
    strictEqual(r.status, 1, 'no child: the writeback stops');
    deepStrictEqual(records(), [], 'and its exit withdraws the mark');
  });
});
