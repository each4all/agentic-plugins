// tests/orchestrator/test-autopilot-landing-ready.mjs
//
// ADR-0067 Decision 7 (docket C118) — the landing-ready event. End to end with
// the fake `claude` and the scripted worker (fixtures/): a commit is reported
// once, with its commit, its overlap and a merge order, while the run keeps
// dispatching, and after a step judged failed, into the log under the main
// worktree when the run drives a linked one; a waiting subtask no run
// recorded is reported when the next run starts, and not again; the report
// touches no ref, object, index, worktree or remote. Then the report itself,
// on a hand-built view: the deduplication key, a branch git cannot resolve, a
// check that could not run, a conflict with the integration branch, a check no
// merge driver, config or attributes reach, a shallow clone whose boundary
// moves, and the merge order.

import { describe, it } from 'node:test';
import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRepo, ORCH, ENG, RUNTIME } from './fixtures/autopilot-repo.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const { startRun, DEFAULTS } = await import(resolve(AP, 'driver.mjs'));
const L = await import(resolve(AP, 'ledger.mjs'));
const { landingReport, planOrder, readLandingLog, reportLandingReady } = await import(resolve(AP, 'landing-ready.mjs'));
// Where a watcher tails the macro's landing log (ADR-0067 Decision 7), written
// out here rather than taken from the module.
const landingLog = (mainRoot, macroId) => join(mainRoot, '.agentic-plugins', 'runs', 'autopilot', 'landing', `${macroId}.jsonl`);
const FAKE = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-fake-claude.mjs');
const SCRIPTED = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-scripted-worker.mjs');

const ROOTS = { orchestrator: ORCH, engineer: ENG, runtime: RUNTIME };
const version = (root) => JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const COMMIT = { kind: 'commit', verb: null, confidence: 'HIGH' };
const INDEPENDENT = (...ids) => ids.map((id) => ({ id }));
const RUN_ID = 'autopilot-20261001T000000Z-abcdef';

async function setup({ scenario, subtasks, linked = false }) {
  const fx = await makeRepo({ ...(subtasks ? { subtasks } : {}), linked });
  const work = realpathSync(fx.work);
  fx.env.HOME = join(fx.dir, 'home');
  mkdirSync(fx.env.HOME);
  const scen = join(fx.dir, 'scenario.json');
  writeFileSync(scen, JSON.stringify(scenario));
  const env = {
    ...fx.env,
    AUTOPILOT_CLAUDE_BIN: FAKE, FAKE_CLAUDE_MODE: 'script', FAKE_WORKER_SCRIPT: SCRIPTED, FAKE_SCENARIO: scen,
    FAKE_CLAUDE_LOG: join(fx.dir, 'claude.log'),
    AGENTIC_ORCHESTRATOR_ROOT: ORCH, AGENTIC_ENGINEER_ROOT: ENG, AGENTIC_RUNTIME_ROOT: RUNTIME,
    FAKE_PLUGINS: JSON.stringify(Object.entries(ROOTS).map(([name, root]) => ({ name, path: root, source: `${name}@agentic-plugins`, version: version(root) }))),
  };
  const lines = [];
  // One run: its exit code and its records, found as the run it added (two
  // runs in one second need not sort in start order).
  const run = async () => {
    const before = new Set(L.listRuns(work));
    lines.length = 0;
    const code = await startRun({
      repoRoot: work,
      options: { ...DEFAULTS, models: 'owner-default', model: null, effort: null, macro: null, forced: null, forcedText: null, notifyLocal: false },
      env, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`), deps: { signals: new EventEmitter() },
    });
    const id = L.listRuns(work).find((x) => !before.has(x));
    return { code, r: L.readRun(work, id) };
  };
  const logFile = landingLog(realpathSync(fx.main), fx.macroId);
  const log = () => readLandingLog(logFile);
  const sha = (branch) => fx.git('rev-parse', `refs/heads/${branch}`);
  return { fx, work, run, lines, log, logFile, sha };
}

// /engineer:commit's effect, by hand: one file committed on the subtask's
// branch, then the commit-complete archive — no run sees it happen.
async function commitByHand(fx, id, rel, content) {
  const child = await fx.dispatch(id);
  writeFileSync(join(fx.work, rel), content);
  fx.git('add', rel);
  fx.git('commit', '-q', '-m', `feat: ${id}`);
  await fx.eng.setTerminal({ workflowPath: child.path, host: 'claude', terminalPhase: 'commit-complete' });
  await fx.eng.archiveWorkflow({ workflowPath: child.path, host: 'claude', repoRoot: fx.work });
  return child;
}

describe('the landing-ready event, driven (ADR-0067 Decision 7)', () => {
  it('a commit step emits the event while the run keeps dispatching', async () => {
    // The run drives a linked worktree: the log is the main worktree's.
    const t = await setup({
      subtasks: INDEPENDENT('A', 'B'),
      scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: true } },
      linked: true,
    });
    try {
      const { code, r } = await t.run();
      strictEqual(code, 2, t.lines.join('\n'));
      deepStrictEqual(r.steps.map((s) => [s.kind, s.subtask_id, s.outcome]),
        [['dispatch', 'A', 'ok'], ['commit', 'A', 'ok'], ['dispatch', 'B', 'ok'], ['commit', 'B', 'ok']]);
      // Each commit is reported after its own step, and A's before B was dispatched.
      deepStrictEqual(r.landing.map((x) => [x.subtask_id, x.after_seq]), [['A', 2], ['B', 4]]);
      const [a, b] = r.landing;
      const shaA = t.sha('feat/a');
      deepStrictEqual(
        [a.subtask_id, a.branch, a.commit, a.engineer_workflow_id, a.integration_branch, a.reason, a.run_id, a.macro_id],
        ['A', 'feat/a', shaA, (await t.fx.subtask('A')).engineer_workflow_id, 'main', 'no_pr', r.run.run_id, t.fx.macroId],
      );
      deepStrictEqual(a.commands, ['git push -u origin feat/a', 'gh pr create --base main --head feat/a --fill']);
      strictEqual(b.commit, t.sha('feat/b'));
      const line = t.lines.findIndex((l) => l.startsWith(`◆ landing-ready: A on feat/a at ${shaA.slice(0, 10)} (no pull request yet); the run goes on`));
      const nextDispatch = t.lines.findIndex((l) => l.startsWith('[3] /orchestrator:next B '));
      ok(line >= 0 && line < nextDispatch, t.lines.join('\n'));
      // The steps ledger keeps one line per step.
      deepStrictEqual(readFileSync(join(r.dir, 'steps.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).event),
        ['started', 'finished', 'started', 'finished', 'started', 'finished', 'started', 'finished']);
      // The watchable log, under the main worktree, holds the same records, once each.
      notStrictEqual(realpathSync(t.fx.main), t.work);
      deepStrictEqual(t.log(), r.landing);
      ok(!existsSync(join(t.work, '.agentic-plugins', 'runs', 'autopilot', 'landing')), 'no log in the linked worktree');
      strictEqual(r.halt.reason, 'awaiting-landing');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a commit whose step is judged failed is still reported', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT] }, actions: { 2: 'report-failed' } } });
    try {
      const { code, r } = await t.run();
      strictEqual(code, 2, t.lines.join('\n'));
      deepStrictEqual(r.steps.map((s) => [s.kind, s.outcome]), [['dispatch', 'ok'], ['commit', 'worker-failed']]);
      deepStrictEqual(r.landing.map((x) => [x.subtask_id, x.after_seq, x.commit]), [['A', 2, t.sha('feat/a')]]);
      deepStrictEqual(t.log().map((x) => x.subtask_id), ['A']);
    } finally {
      t.fx.cleanup();
    }
  });

  it('reports one clean and one conflicting pair, the merge order, and the awaiting-landing halt lists the same', async () => {
    const t = await setup({
      subtasks: INDEPENDENT('A', 'B', 'C'),
      scenario: {
        A: { next: [COMMIT], file: 'shared.txt' },
        B: { next: [COMMIT], file: true },
        C: { next: [COMMIT], file: 'shared.txt' },
      },
    });
    try {
      const { code, r } = await t.run();
      strictEqual(code, 2, t.lines.join('\n'));
      deepStrictEqual(r.steps.map((s) => s.kind), ['dispatch', 'commit', 'dispatch', 'commit', 'dispatch', 'commit']);
      const [shaA, shaB, shaC] = ['feat/a', 'feat/b', 'feat/c'].map(t.sha);
      const base = t.fx.git('rev-parse', 'refs/remotes/origin/main');
      const byId = Object.fromEntries(r.landing.map((x) => [x.subtask_id, x]));
      deepStrictEqual(Object.keys(byId), ['A', 'B', 'C']);
      // Reported when it committed, A had no other waiting subtask to meet.
      deepStrictEqual(byId.A.overlap, { base: { ref: 'refs/remotes/origin/main', commit: base, result: 'clean' }, pairs: [] });
      const c = byId.C;
      deepStrictEqual(c.overlap.base, { ref: 'refs/remotes/origin/main', commit: base, result: 'clean' });
      deepStrictEqual(c.overlap.pairs, [
        { subtask_id: 'A', branch: 'feat/a', commit: shaA, result: 'conflict', paths: ['shared.txt'] },
        { subtask_id: 'B', branch: 'feat/b', commit: shaB, result: 'clean' },
      ]);
      deepStrictEqual(c.merge_order, [
        { subtask_id: 'A', branch: 'feat/a', rebase_after: [] },
        { subtask_id: 'B', branch: 'feat/b', rebase_after: [] },
        { subtask_id: 'C', branch: 'feat/c', rebase_after: ['A'] },
      ]);
      strictEqual(c.commit, shaC);

      strictEqual(r.halt.reason, 'awaiting-landing');
      deepStrictEqual(r.halt.waiting.map((w) => [w.subtaskId, w.commit, w.overlap.base.result, w.overlap.pairs.map((p) => `${p.subtaskId}:${p.result}`)]), [
        ['A', shaA, 'clean', ['B:clean', 'C:conflict']],
        ['B', shaB, 'clean', ['A:clean', 'C:clean']],
        ['C', shaC, 'clean', ['A:conflict', 'B:clean']],
      ]);
      deepStrictEqual(r.halt.merge_order.map((m) => [m.subtaskId, m.rebaseAfter]), [['A', []], ['B', []], ['C', ['A']]]);
      ok(t.lines.includes('  merge order: A → B → C (advisory; C rebases once A lands)'), t.lines.join('\n'));
      ok(t.lines.includes(`      at ${shaC} · overlap: origin/main clean; A (feat/a) conflict: shared.txt; B (feat/b) clean`), t.lines.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });

  it('recovers an unrecorded commit when a run starts, reports it once across restarts, and a new commit again', {
    skip: process.getuid?.() === 0 ? 'root ignores file modes' : false,
  }, async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [COMMIT] } } });
    try {
      // Committed with no run watching: by hand, or by a run that died first.
      await commitByHand(t.fx, 'A', 'a.txt', 'A\n');
      const first = t.sha('feat/a');
      // An earlier driver died mid-append, leaving a torn line, and the log
      // cannot be written now.
      mkdirSync(dirname(t.logFile), { recursive: true });
      writeFileSync(t.logFile, '{"event":"landing-ready","subtask_id":"A"');
      chmodSync(t.logFile, 0o444);

      let { code, r } = await t.run();
      strictEqual(code, 2, t.lines.join('\n'));
      deepStrictEqual([r.steps.length, r.halt.reason], [0, 'awaiting-landing']);
      deepStrictEqual(r.landing.map((x) => [x.subtask_id, x.after_seq, x.commit]), [['A', 0, first]], 'reported when the run starts');
      ok(t.lines.some((l) => l.startsWith('⚠ landing-ready: could not record the report')), t.lines.join('\n'));
      deepStrictEqual(t.log(), [], 'the log was not written');
      // The halt still lists what the report found.
      deepStrictEqual([r.halt.waiting[0].commit, r.halt.waiting[0].overlap.base.result], [first, 'clean']);

      // The next start reports it again, since the log does not hold it.
      chmodSync(t.logFile, 0o644);
      ({ code, r } = await t.run());
      strictEqual(code, 2);
      deepStrictEqual(r.landing.map((x) => [x.subtask_id, x.commit]), [['A', first]]);
      deepStrictEqual(t.log().map((x) => [x.subtask_id, x.commit]), [['A', first]], 'the torn line did not swallow the record');

      ({ code, r } = await t.run());
      strictEqual(code, 2);
      deepStrictEqual(r.landing, [], 'a recorded commit is not reported again');
      ok(!t.lines.some((l) => l.startsWith('◆ landing-ready')), t.lines.join('\n'));
      strictEqual(r.halt.waiting[0].commit, first, 'the halt still lists it');

      // The owner pushes a fix onto the branch: a new commit, a new event.
      writeFileSync(join(t.work, 'fix.txt'), 'fix\n');
      t.fx.git('add', 'fix.txt');
      t.fx.git('commit', '-q', '-m', 'fix: A');
      const second = t.sha('feat/a');
      ({ code, r } = await t.run());
      strictEqual(code, 2);
      deepStrictEqual(r.landing.map((x) => [x.subtask_id, x.commit]), [['A', second]]);
      deepStrictEqual(t.log().map((x) => [x.subtask_id, x.commit]), [['A', first], ['A', second]]);
      ok(!existsSync(join(t.fx.dir, 'claude.log')), 'no worker was started');
    } finally {
      t.fx.cleanup();
    }
  });

  it('changes no ref, object, index, worktree or remote', async () => {
    const t = await setup({ subtasks: INDEPENDENT('A', 'B', 'C'), scenario: { A: { next: [COMMIT] }, B: { next: [COMMIT] }, C: { next: [COMMIT] } } });
    try {
      await commitByHand(t.fx, 'A', 'shared.txt', 'A\n');
      await commitByHand(t.fx, 'B', 'b.txt', 'B\n');
      await commitByHand(t.fx, 'C', 'shared.txt', 'C\n');
      // On a branch no check names, so an index a check leaves behind cannot
      // match HEAD by chance (the last check reads C's commit).
      t.fx.git('switch', '-q', 'main');
      const origin = (...args) => execFileSync('git', ['-C', t.fx.origin, ...args], { env: t.fx.env, encoding: 'utf8' }).trim();
      const snapshot = () => ({
        refs: t.fx.git('for-each-ref', '--format=%(refname) %(objectname)'),
        objects: t.fx.git('count-objects', '-v'),
        head: t.fx.git('symbolic-ref', 'HEAD'),
        index: t.fx.git('ls-files', '--stage'),
        tree: t.fx.git('status', '--porcelain', '--untracked-files=all', '--ignored=no'),
        origin: origin('for-each-ref', '--format=%(refname) %(objectname)'),
      });
      const before = snapshot();

      const { code, r } = await t.run();
      strictEqual(code, 2, t.lines.join('\n'));
      deepStrictEqual(r.landing.map((x) => x.subtask_id), ['A', 'B', 'C']);
      // The overlap was really checked: merge-tree ran on every pair.
      deepStrictEqual(r.halt.waiting.map((w) => w.overlap.pairs.map((p) => `${p.subtaskId}:${p.result}`)),
        [['B:clean', 'C:conflict'], ['A:clean', 'C:clean'], ['A:conflict', 'B:clean']]);
      deepStrictEqual(snapshot(), before);
      ok(!existsSync(join(t.fx.dir, 'claude.log')), 'no worker was started');
    } finally {
      t.fx.cleanup();
    }
  });
});

// A view as observe.mjs builds it, for subtasks committed (commit-complete,
// archived) and waiting: each {id, branch, wf, blocked_by?}.
function waitingView(fx, subtasks) {
  return {
    macro: {
      id: fx.macroId, archived: false,
      fm: {
        git_baseline: { branch: 'main' },
        plan: { subtasks: subtasks.map((s) => ({ id: s.id, status: 'in_progress', branch: s.branch, blocked_by: s.blocked_by ?? [], engineer_workflow_id: s.wf })) },
      },
    },
    children: Object.fromEntries(subtasks.map((s) => [s.id, {
      location: 'archived', terminal_marker: true, current_phase: 'commit-complete', workflow_id: s.wf, branch: s.branch,
    }])),
    landing: Object.fromEntries(subtasks.map((s) => [s.id, { ok: false, reason: 'no_pr', detail: '' }])),
  };
}

describe('the landing-ready report', () => {
  const branchWith = (fx, branch, rel, content) => {
    fx.git('switch', '-q', '--no-track', '-c', branch, 'refs/remotes/origin/main');
    writeFileSync(join(fx.work, rel), content);
    fx.git('add', rel);
    fx.git('commit', '-q', '-m', `feat: ${branch}`);
    return fx.git('rev-parse', 'HEAD');
  };
  // The fixture's own home for git, so neither the user's global config nor
  // their XDG attributes reach a test that writes its own.
  const isolate = (fx) => {
    const home = join(fx.dir, 'home');
    mkdirSync(home, { recursive: true });
    Object.assign(fx.env, { HOME: home, XDG_CONFIG_HOME: join(home, '.config') });
    return home;
  };
  const AC = [
    { id: 'A', branch: 'feat/a', wf: 'compose-20261001T000000Z-aaaaaa' },
    { id: 'C', branch: 'feat/c', wf: 'compose-20261001T000000Z-cccccc' },
  ];

  it('keys an event by subtask, attempt and commit; a branch outside the print-safe alphabet still resolves, and one that does not resolve emits nothing', async () => {
    const fx = await makeRepo();
    const runDir = mkdtempSync(join(tmpdir(), 'landing-run-'));
    try {
      const sha = branchWith(fx, 'feat/café', 'a.txt', 'A\n');
      const lines = [];
      const report = (view) => reportLandingReady({ repoRoot: fx.work, mainRoot: fx.work, runDir, runId: RUN_ID, seq: 0, view, out: (s) => lines.push(s) });
      const log = () => readLandingLog(landingLog(fx.work, fx.macroId)).map((x) => [x.subtask_id, x.engineer_workflow_id, x.commit]);

      report(waitingView(fx, [{ id: 'A', branch: 'feat/café', wf: 'compose-20261001T000000Z-aaaaaa' }]));
      deepStrictEqual(log(), [['A', 'compose-20261001T000000Z-aaaaaa', sha]]);
      report(waitingView(fx, [{ id: 'A', branch: 'feat/café', wf: 'compose-20261001T000000Z-aaaaaa' }]));
      strictEqual(log().length, 1, 'the same attempt and commit is not reported again');
      // A new attempt on the same commit (the subtask dispatched again).
      report(waitingView(fx, [{ id: 'A', branch: 'feat/café', wf: 'compose-20261001T000000Z-bbbbbb' }]));
      deepStrictEqual(log().map((x) => x[1]), ['compose-20261001T000000Z-aaaaaa', 'compose-20261001T000000Z-bbbbbb']);

      // A branch git cannot resolve here: listed with no commit, never reported.
      const gone = report(waitingView(fx, [{ id: 'A', branch: 'feat/gone', wf: 'compose-20261001T000000Z-cccccc' }]));
      deepStrictEqual([gone.entries[0].commit, gone.entries[0].overlap.base.result, gone.reported], [null, 'unavailable', []]);
      strictEqual(log().length, 2);
      ok(/refs\/heads\/feat\/gone does not resolve here/.test(gone.entries[0].overlap.base.detail), gone.entries[0].overlap.base.detail);
    } finally {
      fx.cleanup();
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('does not keep an unavailable check: the next look checks again', async () => {
    const fx = await makeRepo();
    try {
      branchWith(fx, 'feat/a', 'shared.txt', 'A\n');
      branchWith(fx, 'feat/c', 'shared.txt', 'C\n');
      const view = waitingView(fx, [
        { id: 'A', branch: 'feat/a', wf: 'compose-20261001T000000Z-aaaaaa' },
        { id: 'C', branch: 'feat/c', wf: 'compose-20261001T000000Z-cccccc' },
      ]);
      const cache = new Map();
      // A look whose time for checks has run out.
      const spent = landingReport({ repoRoot: fx.work, view, cache, budgetMs: 0 });
      deepStrictEqual(spent.entries.map((e) => e.overlap.pairs[0].result), ['unavailable', 'unavailable']);
      ok(/ran out/.test(spent.entries[0].overlap.pairs[0].detail), spent.entries[0].overlap.pairs[0].detail);
      // A look where merge-tree itself fails (a git that refuses it).
      const bin = join(fx.dir, 'failing-merge-tree');
      mkdirSync(bin);
      writeFileSync(join(bin, 'git'), '#!/bin/sh\nfor a in "$@"; do [ "$a" = merge-tree ] && { echo "fatal: simulated" >&2; exit 128; }; done\nPATH="$REAL_PATH" exec git "$@"\n');
      chmodSync(join(bin, 'git'), 0o755);
      const failing = landingReport({ repoRoot: fx.work, view, cache, env: { ...fx.env, PATH: `${bin}:${fx.env.PATH}`, REAL_PATH: fx.env.PATH } });
      deepStrictEqual(failing.entries.map((e) => [e.overlap.base.result, e.overlap.pairs[0].result]), [['unavailable', 'unavailable'], ['unavailable', 'unavailable']]);
      ok(/exited 128: fatal: simulated/.test(failing.entries[0].overlap.pairs[0].detail), failing.entries[0].overlap.pairs[0].detail);
      const next = landingReport({ repoRoot: fx.work, view, cache });
      deepStrictEqual(next.entries.map((e) => [e.overlap.base.result, e.overlap.pairs[0].result]), [['clean', 'conflict'], ['clean', 'conflict']]);
    } finally {
      fx.cleanup();
    }
  });

  it('reports a conflict with the integration branch once it moves', async () => {
    const fx = await makeRepo();
    try {
      isolate(fx);
      const shaA = branchWith(fx, 'feat/a', 'shared.txt', 'A\n');
      const shaB = branchWith(fx, 'feat/b', 'b.txt', 'B\n');
      // The integration branch moves on after both were cut, changing shared.txt too.
      fx.git('switch', '-q', 'main');
      writeFileSync(join(fx.work, 'shared.txt'), 'main\n');
      fx.git('add', 'shared.txt');
      fx.git('commit', '-q', '-m', 'feat: main moves');
      fx.git('push', '-q', 'origin', 'HEAD:main');
      fx.git('fetch', '-q', 'origin');
      const base = fx.git('rev-parse', 'refs/remotes/origin/main');
      const report = landingReport({
        repoRoot: fx.work, env: fx.env,
        view: waitingView(fx, [AC[0], { id: 'B', branch: 'feat/b', wf: 'compose-20261001T000000Z-bbbbbb' }]),
      });
      deepStrictEqual(report.base, { ref: 'refs/remotes/origin/main', commit: base });
      deepStrictEqual(report.entries.map((e) => [e.subtaskId, e.commit, e.overlap.base]), [
        ['A', shaA, { ref: 'refs/remotes/origin/main', commit: base, result: 'conflict', paths: ['shared.txt'] }],
        ['B', shaB, { ref: 'refs/remotes/origin/main', commit: base, result: 'clean' }],
      ]);
    } finally {
      fx.cleanup();
    }
  });

  it('checks where no merge driver, config or attributes reach it, and writes nothing to the repository', async () => {
    const fx = await makeRepo();
    try {
      const home = isolate(fx);
      const shaA = branchWith(fx, 'feat/a', 'shared.txt', 'A\n');
      const shaC = branchWith(fx, 'feat/c', 'shared.txt', 'C\n');
      fx.git('switch', '-q', 'main');
      // A merge driver that takes their side and leaves its marks: a file
      // naming who selected it, and a ref in the repository.
      const marker = join(fx.dir, 'driver-ran');
      const driver = join(fx.dir, 'driver.sh');
      writeFileSync(driver, `#!/bin/sh\necho "$4" >> '${marker}'\n(unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE; git -C '${fx.work}' update-ref refs/driver/ran HEAD)\ncp "$3" "$1"\n`);
      chmodSync(driver, 0o755);
      // The repository's: its config defines the driver, and the checkout's
      // attributes and info/attributes select it.
      fx.git('config', 'merge.repo.driver', `${driver} %A %O %B repo`);
      writeFileSync(join(fx.work, '.gitattributes'), 'shared.txt merge=repo\n');
      mkdirSync(join(fx.work, '.git', 'info'), { recursive: true });
      writeFileSync(join(fx.work, '.git', 'info', 'attributes'), 'shared.txt merge=repo\n');
      // The user's: an attributes file the global config names, and the XDG
      // one, each with union, which merges the conflict clean.
      writeFileSync(join(fx.dir, 'home-attributes'), 'shared.txt merge=union\n');
      writeFileSync(join(home, '.gitconfig'), `[core]\n\tattributesFile = ${join(fx.dir, 'home-attributes')}\n`);
      mkdirSync(join(home, '.config', 'git'), { recursive: true });
      writeFileSync(join(home, '.config', 'git', 'attributes'), 'shared.txt merge=union\n');
      // The environment's: config passed in GIT_CONFIG_COUNT, a driver and an
      // attributes file that selects it.
      writeFileSync(join(fx.dir, 'env-attributes'), 'shared.txt merge=env\n');
      const env = {
        ...fx.env, GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'merge.env.driver', GIT_CONFIG_VALUE_0: `${driver} %A %O %B env`,
        GIT_CONFIG_KEY_1: 'core.attributesFile', GIT_CONFIG_VALUE_1: join(fx.dir, 'env-attributes'),
      };

      // The control: in the repository, merge-tree runs the driver, which
      // writes a ref, and calls the conflict clean (exit 0).
      execFileSync('git', ['-C', fx.work, 'merge-tree', '--write-tree', '--name-only', '--no-messages', shaA, shaC], { env: fx.env });
      strictEqual(readFileSync(marker, 'utf8'), 'repo\n');
      strictEqual(fx.git('for-each-ref', '--format=%(refname)', 'refs/driver/'), 'refs/driver/ran');
      fx.git('update-ref', '-d', 'refs/driver/ran');
      rmSync(marker);

      const snapshot = () => ({
        refs: fx.git('for-each-ref', '--format=%(refname) %(objectname)'),
        objects: fx.git('count-objects', '-v'),
        index: fx.git('ls-files', '--stage'),
        tree: fx.git('status', '--porcelain', '--untracked-files=all', '--ignored=no'),
      });
      const before = snapshot();
      // The scratch goes under a temp directory of the test's own.
      const tmp = join(fx.dir, 'tmp');
      mkdirSync(tmp);
      const tmpBefore = process.env.TMPDIR;
      process.env.TMPDIR = tmp;
      let report;
      try {
        report = landingReport({ repoRoot: fx.work, view: waitingView(fx, AC), env });
      } finally {
        if (tmpBefore === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = tmpBefore;
      }
      deepStrictEqual(report.entries.map((e) => [e.subtaskId, e.overlap.base.result, e.overlap.pairs.map((p) => [p.subtaskId, p.result, p.paths])]), [
        ['A', 'clean', [['C', 'conflict', ['shared.txt']]]],
        ['C', 'clean', [['A', 'conflict', ['shared.txt']]]],
      ]);
      ok(!existsSync(marker), `a merge driver ran: ${existsSync(marker) ? readFileSync(marker, 'utf8') : ''}`);
      deepStrictEqual(snapshot(), before);
      deepStrictEqual(readdirSync(tmp), [], 'the look removed its scratch');
    } finally {
      fx.cleanup();
    }
  });

  it('answers in a shallow clone, and checks again once its boundary moves', async () => {
    const fx = await makeRepo();
    try {
      isolate(fx);
      // A second commit on the integration branch: a clone one deep then has a boundary.
      writeFileSync(join(fx.work, 'base.txt'), 'base\n');
      fx.git('add', 'base.txt');
      fx.git('commit', '-q', '-m', 'chore: base');
      fx.git('push', '-q', 'origin', 'HEAD:main');
      const shallow = join(fx.dir, 'shallow');
      execFileSync('git', ['clone', '-q', '--depth', '1', `file://${fx.origin}`, shallow], { env: fx.env });
      const boundaryFile = join(shallow, '.git', 'shallow');
      const boundary = () => (existsSync(boundaryFile) ? readFileSync(boundaryFile, 'utf8') : '');
      ok(boundary(), 'the clone is shallow');
      const inShallow = { work: shallow, git: (...args) => execFileSync('git', ['-C', shallow, ...args], { env: fx.env, encoding: 'utf8' }).trim() };
      branchWith(inShallow, 'feat/a', 'shared.txt', 'A\n');
      branchWith(inShallow, 'feat/c', 'shared.txt', 'C\n');
      // A git that counts the merge-tree runs.
      const bin = join(fx.dir, 'counting-git');
      const runs = join(fx.dir, 'merge-tree-runs');
      mkdirSync(bin);
      writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = merge-tree ] && echo run >> '${runs}'; done\nPATH="$REAL_PATH" exec git "$@"\n`);
      chmodSync(join(bin, 'git'), 0o755);
      const env = { ...fx.env, PATH: `${bin}:${fx.env.PATH}`, REAL_PATH: fx.env.PATH };
      const count = () => (existsSync(runs) ? readFileSync(runs, 'utf8').split('\n').filter(Boolean).length : 0);
      const view = waitingView(fx, AC);
      const cache = new Map();
      const answers = (r) => r.entries.map((e) => [e.subtaskId, e.overlap.base.result, e.overlap.pairs.map((p) => p.result)]);
      const expected = [['A', 'clean', ['conflict']], ['C', 'clean', ['conflict']]];

      const first = landingReport({ repoRoot: shallow, view, cache, env });
      deepStrictEqual(answers(first), expected, JSON.stringify(first.entries.map((e) => e.overlap)));
      strictEqual(count(), 3, 'A and C against the base, and the pair once');
      landingReport({ repoRoot: shallow, view, cache, env });
      strictEqual(count(), 3, 'the next look, on the same boundary, answers from the cache');
      // A deepening fetch moves the boundary under the same commits: they are checked again.
      const before = boundary();
      execFileSync('git', ['-C', shallow, 'fetch', '-q', '--deepen=1', 'origin'], { env: fx.env });
      notStrictEqual(boundary(), before);
      const deeper = landingReport({ repoRoot: shallow, view, cache, env });
      deepStrictEqual(answers(deeper), expected);
      strictEqual(count(), 6);
    } finally {
      fx.cleanup();
    }
  });

  it('orders the merge by the plan\'s dependencies, then by position', () => {
    deepStrictEqual(planOrder([
      { id: 'C', blocked_by: ['B'] }, { id: 'A' }, { id: 'B', blocked_by: ['A'] }, { id: 'D', blocked_by: ['gone'] },
    ]), ['A', 'B', 'C', 'D']);
    // A cycle, which the plan validator refuses, still yields every subtask.
    deepStrictEqual(planOrder([{ id: 'X', blocked_by: ['Y'] }, { id: 'Y', blocked_by: ['X'] }]), ['X', 'Y']);
  });
});
