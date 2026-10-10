// ADR-0067 Decision 8, item 2 (WP) — the lane advice /orchestrator:plan and
// /orchestrator:approve show after their proposal: a simulation from
// blocked_by at one lane and at two, shown only when two shorten the run, its
// command naming the macro only when the autopilot could take it (shared
// creation on, the macro in a home of the default state root), and otherwise
// the cutover first.

import { describe, it, before, after } from 'node:test';
import { strictEqual, ok, match, deepStrictEqual, doesNotMatch } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { laneAdvice, laneAdviceLine, runnableSubtasks, simulateLanes } from '../../plugins/orchestrator/scripts/lib/lane-advice.mjs';

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const ORCH_STATE = join(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');
const DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const MACRO = 'macro-plan-20261010T000000Z-abcdef';
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
const cleanEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_'))),
  ...GIT_ENV,
});
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = (args) => spawnSync(process.execPath, [ORCH_STATE, ...args], { encoding: 'utf8', env: cleanEnv() });
const SWITCH_ON = { schema: 'agentic-shared-creation-1.0', enabled: true, enabled_at: '2026-10-08T00:00:00Z', versions: {} };

const st = (id, blocked_by = [], status = 'pending') => ({ id, blocked_by, status });
const ON = { macroId: MACRO, sharedCreation: 'on', macroUnderDefaultRoot: true };

describe('lane advice: the simulation (ADR-0067 Decision 8, item 2)', () => {
  it('A and B independent, C waiting on both: 3 steps in one lane, 2 with two, and the command names the macro', () => {
    const subtasks = [st('A'), st('B'), st('C', ['A', 'B'], 'blocked')];
    deepStrictEqual(simulateLanes(subtasks, 1).waves, [['A'], ['B'], ['C']]);
    deepStrictEqual(simulateLanes(subtasks, 2).waves, [['A', 'B'], ['C']]);
    const advice = laneAdvice({ subtasks, ...ON });
    strictEqual(advice.show, true);
    strictEqual(advice.lanes, 2);
    deepStrictEqual(advice.steps, { 1: 3, 2: 2 });
    strictEqual(advice.text, 'A and B are independent, C waits on both (3 steps in one lane, 2 with 2)');
    strictEqual(advice.command, `/orchestrator:autopilot start --execute --macro ${MACRO} --lanes 2`);
    strictEqual(laneAdviceLine(advice), `- lane_advice: ${advice.text}: ${advice.command}`);
  });

  it('a chain, where two lanes shorten nothing, gives no advice', () => {
    const subtasks = [st('A'), st('B', ['A'], 'blocked'), st('C', ['B'], 'blocked')];
    deepStrictEqual(laneAdvice({ subtasks, ...ON }), { show: false });
    strictEqual(laneAdviceLine(laneAdvice({ subtasks, ...ON })), null);
  });

  it('a single open subtask, or none, gives no advice', () => {
    deepStrictEqual(laneAdvice({ subtasks: [st('A')], ...ON }), { show: false });
    deepStrictEqual(laneAdvice({ subtasks: [], ...ON }), { show: false });
  });

  it('never names more lanes than the cap, however wide the ready set', () => {
    const subtasks = [st('A'), st('B'), st('C'), st('D')];
    const advice = laneAdvice({ subtasks, ...ON });
    strictEqual(advice.lanes, 2);
    deepStrictEqual(advice.steps, { 1: 4, 2: 2 });
    match(advice.command, / --lanes 2$/);
    strictEqual(laneAdvice({ subtasks, ...ON, cap: 4 }).lanes, 4, 'the cap bounds the simulation');
  });

  it('completed predecessors are satisfied; a subtask behind a deferred, abandoned or missing one never runs', () => {
    const subtasks = [
      st('A', [], 'completed'), st('B', ['A']), st('C', ['A']),
      st('D', [], 'deferred'), st('E', ['D'], 'blocked'), st('F', ['E'], 'blocked'), st('G', ['ghost'], 'blocked'),
    ];
    deepStrictEqual(runnableSubtasks(subtasks).map((s) => s.id), ['B', 'C']);
    const advice = laneAdvice({ subtasks, ...ON });
    strictEqual(advice.text, 'B and C are independent (2 steps in one lane, 1 with 2)');
  });

  it('an in-progress subtask counts as one still to run', () => {
    const subtasks = [st('A', [], 'in_progress'), st('B')];
    deepStrictEqual(laneAdvice({ subtasks, ...ON }).steps, { 1: 2, 2: 1 });
  });

  it('three side by side, then one waiting on all of them', () => {
    const subtasks = [st('A'), st('B'), st('C'), st('D', ['A', 'B', 'C'], 'blocked')];
    strictEqual(laneAdvice({ subtasks, ...ON, cap: 3 }).text, 'A, B and C are independent, D waits on all of them (4 steps in one lane, 2 with 3)');
  });

  it('lists at most three parallel steps, then counts the rest', () => {
    const subtasks = [];
    for (let i = 0; i < 5; i += 1) {
      const prev = i === 0 ? [] : [`P${i - 1}`, `Q${i - 1}`];
      subtasks.push(st(`P${i}`, prev), st(`Q${i}`, prev));
    }
    match(laneAdvice({ subtasks, ...ON }).text, /; 2 more such steps \(10 steps in one lane, 5 with 2\)$/);
  });

  it('the command is withheld, and the line names the cutover, while shared creation is off or the macro is elsewhere', () => {
    const subtasks = [st('A'), st('B')];
    const off = laneAdvice({ subtasks, ...ON, sharedCreation: 'off' });
    strictEqual(off.command, null);
    strictEqual(off.cutover_first, true);
    strictEqual(laneAdviceLine(off), '- lane_advice: A and B are independent (2 steps in one lane, 1 with 2); lanes need the state-root cutover first (shared creation is off): docs/runbooks/state-root-cutover.md');
    const elsewhere = laneAdvice({ subtasks, ...ON, macroUnderDefaultRoot: false });
    strictEqual(elsewhere.command, null);
    match(laneAdviceLine(elsewhere), /cutover first \(the macro is not in a home of the default state root\)/);
    const badId = laneAdvice({ subtasks, ...ON, macroId: 'macro; rm -rf /' });
    strictEqual(badId.command, null);
    strictEqual(badId.cutover_first, false);
    match(laneAdviceLine(badId), /\(no command: "macro; rm -rf \/" is not a macro workflow id\)$/);
    doesNotMatch(laneAdviceLine(badId), /cutover|--macro/);
  });

  it('an id outside the safe alphabet is quoted in the text', () => {
    match(laneAdvice({ subtasks: [st('a b'), st('C')], ...ON }).text, /^"a b" and C are independent/);
  });
});

describe('lane advice: state.mjs lane-advice on real checkouts', () => {
  let dir;
  let main;
  let lane;
  let head;
  const create = (checkout, branch = "main") => {
    const r = run([
      'create', '--repo-root', checkout, '--verb', 'plan', '--host', 'claude',
      '--git-baseline-branch', branch, '--git-baseline-head', head, '--status-digest', DIGEST,
      '--original-request', 'lane advice fixture',
    ]);
    strictEqual(r.status, 0, r.stderr);
    const path = r.stdout.trim();
    const file = join(dir, `subtasks-${basename(path)}.json`);
    writeFileSync(file, JSON.stringify([
      { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' },
      { id: 'B', verb: 'compose', branch: 'feat/b', blocked_by: [], status: 'pending' },
      { id: 'C', verb: 'compose', branch: 'feat/c', blocked_by: ['A', 'B'], status: 'blocked' },
    ]));
    const p = run(['plan-set', '--workflow-path', path, '--host', 'claude', '--subtasks-json-file', file, '--verdict', 'pass']);
    strictEqual(p.status, 0, p.stderr);
    return path;
  };
  const advise = (macroPath, checkout, format = []) => run(['lane-advice', '--workflow-path', macroPath, '--repo-root', checkout, ...format]);
  const switchOn = () => {
    mkdirSync(join(main, '.agentic-plugins/state'), { recursive: true });
    writeFileSync(join(main, '.agentic-plugins/state/shared-creation.json'), JSON.stringify(SWITCH_ON));
  };

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'lane-advice-')));
    main = join(dir, 'repo');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    writeFileSync(join(main, '.gitignore'), '.agentic-plugins/\n');
    git(main, 'add', '.gitignore');
    git(main, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'feat/lane', join(dir, 'lane'));
    main = realpathSync(main);
    lane = realpathSync(join(dir, 'lane'));
    head = git(main, 'rev-parse', 'HEAD');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('a macro of the main checkout: the cutover first while shared creation is off, then the command naming it', () => {
    const macroPath = create(main);
    const id = basename(macroPath, '.md');
    const off = advise(macroPath, main, ['--format', 'line']);
    strictEqual(off.status, 0, off.stderr);
    strictEqual(off.stdout, '- lane_advice: A and B are independent, C waits on both (3 steps in one lane, 2 with 2); lanes need the state-root cutover first (shared creation is off): docs/runbooks/state-root-cutover.md\n');
    switchOn();
    try {
      const on = advise(macroPath, lane, ['--format', 'line']);
      strictEqual(on.stdout, `- lane_advice: A and B are independent, C waits on both (3 steps in one lane, 2 with 2): /orchestrator:autopilot start --execute --macro ${id} --lanes 2\n`);
      const json = JSON.parse(advise(macroPath, lane).stdout);
      strictEqual(json.command, `/orchestrator:autopilot start --execute --macro ${id} --lanes 2`);
    } finally {
      rmSync(join(main, '.agentic-plugins/state/shared-creation.json'), { force: true });
    }
  });

  it("a macro in a linked worktree's own home gets no command even with shared creation on", () => {
    const macroPath = create(lane, "feat/lane");
    ok(macroPath.startsWith(lane), `created in the lane's own home: ${macroPath}`);
    switchOn();
    try {
      const r = advise(macroPath, lane, ['--format', 'line']);
      match(r.stdout, /lanes need the state-root cutover first \(the macro is not in a home of the default state root\)/);
      doesNotMatch(r.stdout, /--macro/);
    } finally {
      rmSync(join(main, '.agentic-plugins/state/shared-creation.json'), { force: true });
    }
  });

  it('prints nothing when there is no advice, and refuses an unknown format', () => {
    const r = run(['create', '--repo-root', main, '--verb', 'plan', '--host', 'claude', '--git-baseline-branch', 'feat/solo',
      '--git-baseline-head', head, '--status-digest', DIGEST, '--original-request', 'solo']);
    strictEqual(r.status, 0, r.stderr);
    const path = r.stdout.trim();
    const file = join(dir, 'solo.json');
    writeFileSync(file, JSON.stringify([{ id: 'A', verb: 'compose', branch: 'feat/solo-a', blocked_by: [], status: 'pending' }]));
    strictEqual(run(['plan-set', '--workflow-path', path, '--host', 'claude', '--subtasks-json-file', file, '--verdict', 'pass']).status, 0);
    const none = advise(path, main, ['--format', 'line']);
    strictEqual(none.status, 0, none.stderr);
    strictEqual(none.stdout, '');
    const bad = advise(path, main, ['--format', 'yaml']);
    strictEqual(bad.status, 1);
    match(bad.stderr, /--format takes line/);
  });
});
