// tests/orchestrator/test-holds-seams.mjs
//
// ADR-0068 Decision 2 (impl-hold) — the seams the whole-change critique
// found between the hold's units: a withdrawal over a release still in force
// (I12: a rejection is never lost), the lane a hold records when its branch
// is checked out in the main checkout, the child a hold set before its
// dispatch compares, the legacy engineer home, an archived workflow or a
// quoted scalar that cannot be read (fail closed), an exclusion a crash left
// at a macro's end or a move, and a plan id that is no hold key.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ENG, makeRepo, ORCH, RUNTIME } from './fixtures/autopilot-repo.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ORCH_ROOT = join(REPO_ROOT, 'plugins/orchestrator');
const LIB = join(ORCH_ROOT, 'scripts/lib');
const H = await import(pathToFileURL(join(LIB, 'holds.mjs')).href);
const O = await import(pathToFileURL(join(LIB, 'hold-ops.mjs')).href);
const RL = await import(pathToFileURL(join(LIB, 'run-locks.mjs')).href);
const CLI = await import(pathToFileURL(join(ORCH_ROOT, 'adapters/claude/autopilot/holds-cli.mjs')).href);
const AUTOPILOT = await import(pathToFileURL(join(ORCH_ROOT, 'adapters/claude/autopilot/cli.mjs')).href);

const MACRO = 'macro-plan-20261026T000000Z-5ea115';
const S = 'S';
const BRANCH = 'feat/s';
const CHILD = 'compose-20261026T000000Z-c0c0c0';
const OP = 'op-20261026T000000Z-0000feed';
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
const cleanEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_') && k !== 'CLAUDE_PLUGIN_ROOT')),
  ...GIT_ENV,
});
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function withDirs(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'holds-seams-')));
  const main = join(dir, 'main');
  const lane = join(dir, 'lane');
  mkdirSync(main);
  mkdirSync(lane);
  try { return await fn({ main, lane, dir }); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const activate = (main) => H.writeProtocol(main, MACRO, { writtenBy: 'test' });
const hold = (main, over = {}) => O.setHold({ mainRoot: main, macroId: MACRO, subtaskId: S, branch: BRANCH, ...over });
const handOver = (main) => O.completeHandoff({ mainRoot: main, macroId: MACRO, subtaskId: S, stateRoots: [main] });
const state = (main) => H.holdStateOf(main, MACRO, S).state;
const gate = (main) => O.holdGate({ mainRoot: main, macroId: MACRO, subtaskId: S });
const basis = (content) => async () => ({ fingerprint_version: 1, fingerprint: 'f', tree_digest: 't', content_digest: content, child: null });
const release = (main, holdId, basisOf = basis('c')) => O.releaseHold({ mainRoot: main, macroId: MACRO, subtaskId: S, holdId, stateRoots: [main], basisOf });
const compare = (main, basisOf) => O.compareRelease({ mainRoot: main, macroId: MACRO, subtaskId: S, stateRoots: [main], basisOf });

const opsScalar = (id) => JSON.stringify(JSON.stringify({ v: 1, ops: [{ id, kind: 'verb', opened_at: '2026-10-26T00:00:00Z', ext: false }] }));
/** A child of S under `home` (workflows or archive), optionally with an open operation entry. */
function child(main, { home = '.agentic-plugins/state/engineer', sub = 'workflows', id = CHILD, op = null, branchLine = `  branch: "${BRANCH}"`, body = '# x' } = {}) {
  const dir = join(main, home, sub);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.md`);
  writeFileSync(file, [
    '---', `workflow_id: "${id}"`, 'git_baseline:', branchLine, 'pending_ensemble: []', `parent_workflow: "${MACRO}"`,
    `originating_subtask: "${S}"`, ...(op ? [`persona_operations: ${opsScalar(op)}`] : []), '---', '', body, '',
  ].join('\n'));
  return file;
}

describe('a withdrawal over a release still in force puts it back (I12: a rejection is never lost)', () => {
  it('a hold over a rejected release, withdrawn before its handoff, leaves the lane rejected: the gate still refuses', () => withDirs(async ({ main }) => {
    const h1 = await hold(main);
    await handOver(main);
    await release(main, h1.hold_id, basis('before'));
    strictEqual((await compare(main, basis('after'))).verdict, 'rejected');
    strictEqual(state(main), 'rejected');
    const h2 = await hold(main);
    strictEqual(state(main), 'pending');
    const r = await release(main, h2.hold_id);
    deepStrictEqual([r.state, r.restored], ['withdrawn', 'rejected']);
    strictEqual(state(main), 'rejected');
    match(gate(main), /was rejected/);
  }));

  it('a hold over an uncompared release, withdrawn because a blind run started (withdrawUnhandedHold), leaves it to compare', () => withDirs(async ({ main }) => {
    const h1 = await hold(main);
    await handOver(main);
    const r1 = await release(main, h1.hold_id, basis('kept'));
    const h2 = await hold(main);
    strictEqual(await O.withdrawUnhandedHold({ mainRoot: main, macroId: MACRO, subtaskId: S, holdId: h2.hold_id }), true);
    strictEqual(state(main), 'released-uncompared');
    strictEqual(H.readRecord(main, MACRO, 'releases', S).record.release_id, r1.release.release_id, 'the same release, its basis with it');
    strictEqual((await compare(main, basis('kept'))).verdict, 'consumed');
  }));

  it('a hold over a rejected release that is handed over and released records a new release, which the comparison judges alone', () => withDirs(async ({ main }) => {
    const h1 = await hold(main);
    await handOver(main);
    await release(main, h1.hold_id, basis('before'));
    await compare(main, basis('after'));
    const h2 = await hold(main);
    await handOver(main);
    strictEqual(state(main), 'held');
    await release(main, h2.hold_id, basis('now'));
    strictEqual(state(main), 'released-uncompared');
    strictEqual((await compare(main, basis('now'))).verdict, 'consumed');
    strictEqual(gate(main), null);
  }));
});

describe("a withdrawal that puts a release back takes the new hold's fence with it", () => {
  // A pending hold over a rejected release, its handoff stopped by a crash
  // after its fence (the fence present, no ack).
  const fencedOverRejected = async (main, lane) => {
    const h1 = await hold(main, { lane });
    await handOver(main);
    await release(main, h1.hold_id, basis('before'));
    await compare(main, basis('after'));
    const h2 = await hold(main, { lane });
    RL.writeFence({ laneRoot: lane, holdId: h2.hold_id, subtaskId: S, macroId: MACRO });
    strictEqual(RL.fenceState(lane, h2.hold_id), 'present');
    return h2;
  };

  it('release --hold of the new hold removes its fence before the earlier hold comes back', () => withDirs(async ({ main, lane }) => {
    const h2 = await fencedOverRejected(main, lane);
    strictEqual((await release(main, h2.hold_id)).restored, 'rejected');
    strictEqual(RL.fenceState(lane, h2.hold_id), 'absent');
    deepStrictEqual((await RL.laneLockRivals(lane, {})).map((e) => e.file), [], 'no fence is left in the lane');
  }));

  it("hold's own withdrawal (a blind run) removes it too", () => withDirs(async ({ main, lane }) => {
    const h2 = await fencedOverRejected(main, lane);
    strictEqual(await O.withdrawUnhandedHold({ mainRoot: main, macroId: MACRO, subtaskId: S, holdId: h2.hold_id }), true);
    strictEqual(RL.fenceState(lane, h2.hold_id), 'absent');
    strictEqual(state(main), 'rejected');
  }));
});

describe("the lane a hold records is the one its subtask's branch is checked out in (M2)", () => {
  it('branchLane: a linked worktree is the lane; the main checkout is none (null); no worktree is unknown', () => withDirs(async ({ dir }) => {
    const main = join(dir, 'repo');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    // A checked-out entry on disk: git's main worktree is told by it (state-root.mjs isWorkingTreeOf).
    writeFileSync(join(main, 'README'), 'x\n');
    git(main, 'add', 'README');
    git(main, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    git(main, 'branch', 'feat/x');
    strictEqual(O.branchLane(main, 'feat/x'), undefined);
    git(main, 'worktree', 'add', '-q', join(dir, 'wt'), 'feat/x');
    strictEqual(realpathSync(O.branchLane(main, 'feat/x')), realpathSync(join(dir, 'wt')));
    git(main, 'worktree', 'remove', '-f', join(dir, 'wt'));
    git(main, 'switch', '-q', 'feat/x');
    strictEqual(O.branchLane(main, 'feat/x'), null, "a hand dispatch's main checkout is no lane");
  }));

  it('`hold` on a hand-dispatched subtask (its branch in the main checkout) records no lane, and `status` keeps the hold', async () => {
    const fx = await makeRepo({ subtasks: [{ id: 'A' }] });
    try {
      const work = realpathSync(fx.work);
      const home = join(fx.dir, 'home');
      for (const host of ['.claude', '.codex']) {
        const e = join(home, host, 'plugins/cache/agentic-plugins/engineer/0.33.0/scripts');
        mkdirSync(e, { recursive: true });
        writeFileSync(join(e, 'state.mjs'), "if (process.argv[2] === 'hold-capability') console.log(JSON.stringify({ capability: 'hold-persona-1', protocol: 1 })); else process.exit(2);\n");
      }
      const env = { ...fx.env, HOME: home, AGENTIC_ORCHESTRATOR_ROOT: ORCH, AGENTIC_ENGINEER_ROOT: ENG, AGENTIC_RUNTIME_ROOT: RUNTIME };
      delete env.AGENTIC_AUTOPILOT;
      delete env.CODEX_HOME;
      await fx.dispatch('A');
      const cli = async (argv) => {
        const out = [];
        const err = [];
        const code = await AUTOPILOT.main([...argv, '--repo', work], { env, io: { stdin: { isTTY: false } }, out: (x) => out.push(x), err: (x) => err.push(x) });
        return { code, out: out.join('\n'), err: err.join('\n') };
      };
      const h = await cli(['hold', 'A', '--macro', fx.macroId]);
      strictEqual(h.code, 0, h.err);
      strictEqual(H.readOwnerHold(work, fx.macroId, 'A').record.lane, null, "the main checkout is no lane a fence may close");
      const st = await cli(['status', '--macro', fx.macroId]);
      ok(!/orphaned/.test(st.out), st.out);
      ok(['pending', 'held'].includes(H.holdStateOf(work, fx.macroId, 'A').state), st.out);
    } finally {
      fx.cleanup();
    }
  });
});

describe('the child a hold set before its dispatch compares (M6)', () => {
  // A content digest the comparison reads through the real basisFor: a fake
  // engineer whose content-digest hashes the file.
  const fakeEngineer = (dir) => {
    const root = join(dir, 'engineer');
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'state.mjs'), [
      "import { readFileSync } from 'node:fs';", "import { createHash } from 'node:crypto';",
      "const p = process.argv[process.argv.indexOf('--workflow-path') + 1];",
      "process.stdout.write(JSON.stringify({ schema: 'agentic-workflow-content-digest-1', digest: createHash('sha256').update(readFileSync(p)).digest('hex') }));",
    ].join('\n'));
    return root;
  };
  const basisOf = (dir) => CLI.basisFor({ engineerRoot: fakeEngineer(dir), fingerprintOf: async () => ({ version: 1, fingerprint: 'f' }) });

  it('the handoff records the child the lane has; the child archived, its edit after the release is rejected', () => withDirs(async ({ main, dir }) => {
    const h = await hold(main, { child: null });
    const active = child(main);
    await handOver(main);
    strictEqual(H.readRecord(main, MACRO, 'handoffs', S).record.child, CHILD);
    const archive = join(main, '.agentic-plugins/state/engineer/archive');
    mkdirSync(archive, { recursive: true });
    const archived = join(archive, `${CHILD}.md`);
    renameSync(active, archived);
    const b = basisOf(dir);
    const r = await release(main, h.hold_id, b);
    strictEqual(r.release.basis.child, CHILD);
    ok(r.release.basis.content_digest !== 'no child', 'the archived child is read');
    writeFileSync(archived, `${readFileSync(archived, 'utf8')}\nedited after the release\n`);
    strictEqual((await compare(main, b)).verdict, 'rejected');
  }));

  it('the child archived before the release, unchanged since, is consumed: the comparison reads the archived child the release read', () => withDirs(async ({ main, dir }) => {
    const h = await hold(main, { child: null });
    const active = child(main);
    await handOver(main);
    const archive = join(main, '.agentic-plugins/state/engineer/archive');
    mkdirSync(archive, { recursive: true });
    renameSync(active, join(archive, `${CHILD}.md`));
    const b = basisOf(dir);
    await release(main, h.hold_id, b);
    strictEqual((await compare(main, b)).verdict, 'consumed');
  }));

  it('a child archived before the handoff is found by its linkage: an edit to it after the release is rejected', () => withDirs(async ({ main, dir }) => {
    const h = await hold(main, { child: null });
    child(main, { sub: 'archive' });
    await handOver(main);
    strictEqual(H.readRecord(main, MACRO, 'handoffs', S).record.child, CHILD);
    const b = basisOf(dir);
    const r = await release(main, h.hold_id, b);
    ok(r.release.basis.content_digest !== 'no child', 'the archived child is read');
    const archived = join(main, '.agentic-plugins/state/engineer/archive', `${CHILD}.md`);
    writeFileSync(archived, `${readFileSync(archived, 'utf8')}\nedited after the release\n`);
    strictEqual((await compare(main, b)).verdict, 'rejected');
  }));

  it('of several archived children of the subtask, the latest is the lane\'s', () => withDirs(async ({ main }) => {
    child(main, { sub: 'archive', id: 'compose-20261025T000000Z-0a0a0a' });
    const latest = child(main, { sub: 'archive', id: 'refine-20261026T120000Z-0b0b0b' });
    child(main, { sub: 'archive', id: 'compose-20261026T000000Z-0c0c0c' });
    strictEqual(O.latestArchivedChild([main], { macroId: MACRO, subtaskId: S, branch: BRANCH }), latest);
    strictEqual(O.latestArchivedChild([main], { macroId: MACRO, subtaskId: S, branch: 'feat/other' }), null);
  }));

  it('unchanged, it is consumed', () => withDirs(async ({ main, dir }) => {
    const h = await hold(main, { child: null });
    child(main);
    await handOver(main);
    const b = basisOf(dir);
    await release(main, h.hold_id, b);
    strictEqual((await compare(main, b)).verdict, 'consumed');
  }));
});

describe('the scans fail closed (M7, M8, M9)', () => {
  it("a child in the legacy engineer home with an open operation keeps the handoff pending", () => withDirs(async ({ main }) => {
    await hold(main, { child: null });
    child(main, { home: '.claude/agentic-engineer', op: OP });
    const r = await handOver(main);
    strictEqual(r.state, 'pending');
    match(r.blocker, new RegExp(OP));
  }));

  it("an archived workflow that cannot be read keeps a completed subtask's retirement waiting, named", () => withDirs(async ({ main }) => {
    activate(main);
    await hold(main);
    const dir = join(main, '.agentic-plugins/state/engineer/archive');
    mkdirSync(dir, { recursive: true });
    const bad = join(dir, 'compose-20261026T000000Z-bad000.md');
    writeFileSync(bad, 'no frontmatter at all\n');
    const r = await O.retireSubtaskHolds({ mainRoot: main, macroId: MACRO, subtaskId: S, branch: BRANCH, stateRoots: [main] });
    strictEqual(r.state, 'waiting');
    match(r.why, /compose-20261026T000000Z-bad000\.md/);
    strictEqual(H.readOwnerHold(main, MACRO, S).record.state, 'held', 'nothing retired');
  }));

  it('a torn quoted branch line makes the workflow unreadable, never a workflow on no branch the handoff passes over', () => withDirs(async ({ main }) => {
    await hold(main, { child: null });
    const file = child(main, { op: OP, branchLine: `  branch: "${BRANCH}` });
    strictEqual(H.readWorkflowFacts(file).state, 'unreadable');
    const r = await handOver(main);
    strictEqual(r.state, 'pending');
    match(r.blocker, /cannot be read/);
  }));
});

describe('an exclusion a crash left is swept before the first look (M10)', () => {
  const deadExclusion = (main, kind) => {
    const DEAD = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid;
    H.publishOpRecord(main, MACRO, S, {
      operation_id: OP, kind, subtask_id: S, workflow_id: null, persona: 'orchestrator',
      host: null, opened_at: '2026-10-26T00:00:00Z', pid: DEAD, fingerprint: { kind: 'none' },
    });
  };

  it("a macro's end whose earlier retirement crashed retires the directory", () => withDirs(async ({ main }) => {
    activate(main);
    await hold(main);
    deadExclusion(main, 'retire');
    const r = await O.retireMacroHolds({ mainRoot: main, macroId: MACRO, subtasks: [{ id: S, branch: BRANCH }] });
    strictEqual(r.state, 'retired', r.why);
  }));

  it("a move whose earlier move crashed is not refused by that move's exclusion", () => withDirs(async ({ main }) => {
    activate(main);
    const file = child(main);
    deadExclusion(main, 'cutover');
    const withdraw = await O.excludeChildWriters({ mainRoot: main, childPath: file });
    strictEqual(typeof withdraw, 'function');
    withdraw();
    deepStrictEqual(H.readOps(main, MACRO, S).ops, []);
  }));
});

describe('a plan id that is no hold key is dispatched as with the holds off (M11)', () => {
  const ID = 'task:13';
  it('the library: no refusal, no mark, nothing to retire, and no throw, holds on or off', () => withDirs(async ({ main }) => {
    for (const on of [false, true]) {
      if (on) activate(main);
      deepStrictEqual(O.handDispatchRefusal({ mainRoot: main, macroId: MACRO, subtaskId: ID, branch: 'feat/t', stateRoots: [main] }), { active: false, why: null });
      let kept = null;
      const m = await O.publishDispatchMark({ mainRoot: main, macroId: MACRO, subtaskId: ID, branch: 'feat/t', stateRoots: [main], keep: (x) => { kept = x; } });
      deepStrictEqual([m, kept], [{ active: false, operationId: null }, { active: false, operationId: null }]);
      strictEqual((await O.retireSubtaskHolds({ mainRoot: main, macroId: MACRO, subtaskId: ID, stateRoots: [main] })).state, 'none');
    }
  }));

  it('state.mjs hold-gate and dispatch-mark-publish pass it, holds off and on', () => withDirs(async ({ main, dir }) => {
    const wf = join(main, '.agentic-plugins/state/orchestrator/workflows');
    mkdirSync(wf, { recursive: true });
    const macroPath = join(wf, `${MACRO}.md`);
    writeFileSync(macroPath, `---\nworkflow_id: "${MACRO}"\n---\n`);
    git(main, 'init', '-q', '-b', 'main');
    const run = (sub, extra = []) => spawnSync(process.execPath, [join(ORCH_ROOT, 'scripts/state.mjs'), sub,
      '--workflow-path', macroPath, '--subtask-id', ID, '--branch', 'feat/t', '--checkout', main, ...extra], { encoding: 'utf8', env: cleanEnv() });
    for (const on of [false, true]) {
      if (on) activate(main);
      const g = run('hold-gate');
      strictEqual(g.status, 0, g.stderr);
      const markFile = join(dir, `mark-${on}.json`);
      const p = run('dispatch-mark-publish', ['--mark-file', markFile]);
      strictEqual(p.status, 0, p.stderr);
      deepStrictEqual(JSON.parse(readFileSync(markFile, 'utf8')), { active: false, operation_id: null, reattach: false });
      const c = run('dispatch-mark-check', ['--mark-file', markFile]);
      strictEqual(c.status, 0, c.stderr);
    }
  }));
});

// --- the re-critique's seams (N1-N4, N10, N11) ---------------------------------

/** A workflow on BRANCH that is not the lane's child (another macro's), under `main`'s workflows. */
function stranger(main, { id = 'compose-20261026T000000Z-0d0d0d', body = null } = {}) {
  const dir = join(main, '.agentic-plugins/state/engineer/workflows');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.md`);
  writeFileSync(file, body ?? [
    '---', `workflow_id: "${id}"`, 'git_baseline:', `  branch: "${BRANCH}"`, 'pending_ensemble: []', '---', '', '# x', '',
  ].join('\n'));
  return file;
}
// A released lane with no child: held, handed over, released.
const releasedNoChild = async (main) => {
  const h = await hold(main, { child: null });
  await handOver(main);
  await release(main, h.hold_id, basis('c'));
  strictEqual(state(main), 'released-uncompared');
  return h;
};

describe('the comparison refuses what the release would (N1, I14)', () => {
  it('a workflow on the branch that is not the lane\'s child, begun after the release, refuses the comparison: the release stays uncompared', () => withDirs(async ({ main }) => {
    await releasedNoChild(main);
    stranger(main);
    const r = await compare(main, basis('c'));
    strictEqual(r.verdict, 'refused');
    match(r.why, /is not the lane's child/);
    strictEqual(state(main), 'released-uncompared');
    match(gate(main), /not compared yet/);
  }));

  it('so does one on the branch that cannot be read', () => withDirs(async ({ main }) => {
    await releasedNoChild(main);
    stranger(main, { body: 'no frontmatter\n' });
    const r = await compare(main, basis('c'));
    strictEqual(r.verdict, 'refused');
    match(r.why, /cannot be read/);
    strictEqual(state(main), 'released-uncompared');
  }));

  it("the child's pending peer ensemble refuses the comparison, as it refuses the release", () => withDirs(async ({ main }) => {
    const h = await hold(main, { child: CHILD });
    const file = child(main);
    await handOver(main);
    await release(main, h.hold_id, async () => ({ fingerprint_version: 1, fingerprint: 'f', tree_digest: 't', content_digest: 'c', child: CHILD }));
    writeFileSync(file, readFileSync(file, 'utf8').replace('pending_ensemble: []', 'pending_ensemble:\n  - run_id: "r1"'));
    const r = await compare(main, basis('c'));
    strictEqual(r.verdict, 'refused');
    match(r.why, /pending peer ensemble/);
    strictEqual(state(main), 'released-uncompared');
  }));

  it('one begun between the first look and the exclusion record refuses too (the look beside the record)', () => withDirs(async ({ main }) => {
    await releasedNoChild(main);
    const r = await O.compareRelease({
      mainRoot: main, macroId: MACRO, subtaskId: S, stateRoots: [main], basisOf: basis('c'), hooks: { beforeExclusion: () => { stranger(main); } },
    });
    strictEqual(r.verdict, 'refused');
    match(r.why, /is not the lane's child/);
    strictEqual(state(main), 'released-uncompared');
    deepStrictEqual(H.readOps(main, MACRO, S).ops, [], 'its exclusion record is withdrawn');
  }));
});

describe('an archived workflow that cannot be read blocks a lane whose hold names no child (N2)', () => {
  it('the handoff stays pending, naming it', () => withDirs(async ({ main }) => {
    await hold(main, { child: null });
    const bad = child(main, { sub: 'archive', id: 'compose-20261026T000000Z-bad111', body: '# x' });
    writeFileSync(bad, 'no frontmatter at all\n');
    const r = await handOver(main);
    strictEqual(r.state, 'pending');
    match(r.blocker, /compose-20261026T000000Z-bad111\.md cannot be read/);
  }));

  it('the release of a held hold refuses beside it, and so does the comparison of an earlier release', () => withDirs(async ({ main }) => {
    const h = await hold(main, { child: null });
    await handOver(main);
    const archive = join(main, '.agentic-plugins/state/engineer/archive');
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'compose-20261026T000000Z-bad222.md'), '---\nworkflow_id: "x\n---\n');
    await O.releaseHold({ mainRoot: main, macroId: MACRO, subtaskId: S, holdId: h.hold_id, stateRoots: [main], basisOf: basis('c') })
      .then(() => ok(false, 'refused'), (err) => { strictEqual(err.code, 'writer-active'); match(err.message, /bad222\.md cannot be read/); });
    strictEqual(state(main), 'held');
    // Released before the torn archive appeared, its comparison refuses beside it.
    rmSync(join(archive, 'compose-20261026T000000Z-bad222.md'));
    await release(main, h.hold_id, basis('c'));
    writeFileSync(join(archive, 'compose-20261026T000000Z-bad222.md'), '---\nworkflow_id: "x\n---\n');
    const r = await compare(main, basis('c'));
    strictEqual(r.verdict, 'refused');
    match(r.why, /bad222\.md cannot be read/);
    strictEqual(state(main), 'released-uncompared');
  }));

  it('a hold that names its child: an archive that cannot be looked at is never read as the child\'s absence (handoff, release, comparison)', () => withDirs(async ({ main }) => {
    const h = await hold(main, { child: CHILD });
    const home = join(main, '.agentic-plugins/state/engineer');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'archive'), 'not a directory\n');
    const a = O.archivedChildAt([main], CHILD);
    deepStrictEqual([a.file, a.unreadable.map((u) => u.file)], [null, [join(home, 'archive', `${CHILD}.md`)]]);
    const r = await handOver(main);
    strictEqual(r.state, 'pending');
    match(r.blocker, new RegExp(`may hold the lane's archived child ${CHILD}`));
    // Handed over and released while the archive could be read, then compared beside it.
    rmSync(join(home, 'archive'));
    await handOver(main);
    await release(main, h.hold_id, async () => ({ fingerprint_version: 1, fingerprint: 'f', tree_digest: 't', content_digest: 'c', child: CHILD }));
    writeFileSync(join(home, 'archive'), 'not a directory\n');
    const c = await compare(main, basis('c'));
    strictEqual(c.verdict, 'refused');
    match(c.why, /may hold the lane's archived child/);
  }));

  it('an archive directory that cannot be listed blocks too, never read as empty', () => withDirs(async ({ main }) => {
    await hold(main, { child: null });
    const home = join(main, '.agentic-plugins/state/engineer');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'archive'), 'not a directory\n');
    const a = O.archivedChildren([main], { macroId: MACRO, subtaskId: S, branch: BRANCH });
    deepStrictEqual([a.latest, a.unreadable.map((u) => u.file)], [null, [join(home, 'archive')]]);
    const r = await handOver(main);
    strictEqual(r.state, 'pending');
    match(r.blocker, /archive cannot be read/);
  }));
});

describe('one rule for archived children: the dispatch gate reads them (N3)', () => {
  it("an archived linked child's open entry refuses a hand dispatch, as retirement waits on it", () => withDirs(async ({ main }) => {
    activate(main);
    child(main, { sub: 'archive', op: OP });
    const r = O.handDispatchRefusal({ mainRoot: main, macroId: MACRO, subtaskId: S, branch: BRANCH, stateRoots: [main] });
    strictEqual(r.active, true);
    match(r.why ?? '', new RegExp(`a persona operation is open in subtask S's lane: ${OP}`));
    // Cleared by the owner, it is no longer open.
    H.clearOperation(main, MACRO, S, OP, { by: 'owner' });
    deepStrictEqual(O.handDispatchRefusal({ mainRoot: main, macroId: MACRO, subtaskId: S, branch: BRANCH, stateRoots: [main] }), { active: true, why: null });
  }));

  it('the re-attach handover counts only an operation begun since the check passed, never an archived child\'s from before', () => withDirs(async ({ main }) => {
    activate(main);
    child(main, { sub: 'archive', id: 'compose-20261025T000000Z-0a0a0a', op: OP });
    const args = { mainRoot: main, macroId: MACRO, subtaskId: S, branch: BRANCH, stateRoots: [main], operationId: null };
    const seen = O.childOperationIds(args);
    deepStrictEqual(seen, [OP]);
    strictEqual(O.dispatchHandedOver({ ...args, seen }), false, 'the archived child\'s entry was there at the pass');
    const NEW = 'op-20261026T000000Z-0000beef';
    child(main, { op: NEW });
    strictEqual(O.dispatchHandedOver({ ...args, seen }), true, 'the engineer\'s, begun since');
  }));
});

describe("abort's and finalize's check reads every record the macro's end retires (N4)", () => {
  for (const kind of ['handoffs', 'releases']) {
    it(`an unreadable ${kind.slice(0, -1)} record refuses the close, as the retirement would`, () => withDirs(async ({ main }) => {
      activate(main);
      await hold(main);
      await handOver(main);
      mkdirSync(join(H.holdsDir(main, MACRO), kind), { recursive: true });
      writeFileSync(H.recordPath(main, MACRO, kind, S), '{');
      const r = await O.closeRefusals({ mainRoot: main, macroId: MACRO, subtasks: [{ id: S, branch: BRANCH }], stateRoots: [main] });
      strictEqual(r.active, true);
      ok(r.why.some((w) => new RegExp(`subtask S's ${kind.slice(0, -1)} record cannot be read`).test(w)), r.why.join('\n'));
      strictEqual((await O.retireMacroHolds({ mainRoot: main, macroId: MACRO, subtasks: [{ id: S, branch: BRANCH }] })).state, 'waiting', 'the retirement refuses it too');
    }));
  }
  it('a handoff the plan does not name (only the handoffs directory does) is read too', () => withDirs(async ({ main }) => {
    activate(main);
    mkdirSync(join(H.holdsDir(main, MACRO), 'handoffs'), { recursive: true });
    writeFileSync(H.recordPath(main, MACRO, 'handoffs', 'Z'), '{');
    const r = await O.closeRefusals({ mainRoot: main, macroId: MACRO, subtasks: [], stateRoots: [main] });
    ok(r.why.some((w) => /subtask Z's handoff record cannot be read/.test(w)), r.why.join('\n'));
  }));
});

describe('the guards the earlier mutations survived (N10)', () => {
  it('withdrawUnhandedHold withdraws only the pending hold it names: another id, or a held hold, is left', () => withDirs(async ({ main }) => {
    const h = await hold(main);
    strictEqual(await O.withdrawUnhandedHold({ mainRoot: main, macroId: MACRO, subtaskId: S, holdId: 'f'.repeat(16) }), false);
    strictEqual(H.readOwnerHold(main, MACRO, S).record.hold_id, h.hold_id, 'another id withdraws nothing');
    await handOver(main);
    strictEqual(await O.withdrawUnhandedHold({ mainRoot: main, macroId: MACRO, subtaskId: S, holdId: h.hold_id }), false);
    strictEqual(state(main), 'held', 'a hold handed over is never withdrawn unhanded');
  }));

  it('a prior release that cannot be read refuses the withdrawal: nothing is written', () => withDirs(async ({ main }) => {
    const h1 = await hold(main);
    await handOver(main);
    await release(main, h1.hold_id, basis('before'));
    await compare(main, basis('after'));
    const h2 = await hold(main);
    const own = H.readOwnerHold(main, MACRO, S);
    H.writeWhole(own.path, { ...own.record, prior: { ...own.record.prior, release: { ...own.record.prior.release, basis: null } } });
    await release(main, h2.hold_id).then(() => ok(false, 'refused'), (err) => strictEqual(err.code, 'unreadable'));
    strictEqual(H.readOwnerHold(main, MACRO, S).record.hold_id, h2.hold_id, 'the new hold stays');
    strictEqual(state(main), 'pending');
  }));

  it("the latest archived child is the subtask's own: another subtask's, or another macro's, on the branch is not", () => withDirs(async ({ main }) => {
    const dir = join(main, '.agentic-plugins/state/engineer/archive');
    mkdirSync(dir, { recursive: true });
    const put = (id, macro, sub) => writeFileSync(join(dir, `${id}.md`), [
      '---', `workflow_id: "${id}"`, 'git_baseline:', `  branch: "${BRANCH}"`, `parent_workflow: "${macro}"`, `originating_subtask: "${sub}"`, '---', '',
    ].join('\n'));
    put('compose-20261026T000000Z-0e0e0e', MACRO, 'T');
    put('compose-20261026T000001Z-0f0f0f', 'macro-plan-20261026T000000Z-0th3r0', S);
    strictEqual(O.latestArchivedChild([main], { macroId: MACRO, subtaskId: S, branch: BRANCH }), null);
  }));
});

describe('a withdrawal that restores a release keeps its order (N11)', () => {
  const overRejected = async (main, lane) => {
    const h1 = await hold(main, { lane });
    await handOver(main);
    await release(main, h1.hold_id, basis('before'));
    await compare(main, basis('after'));
    const h2 = await hold(main, { lane });
    RL.writeFence({ laneRoot: lane, holdId: h2.hold_id, subtaskId: S, macroId: MACRO });
    return h2;
  };
  for (const via of ['release', 'withdrawUnhandedHold']) {
    const withdraw = (main, h2, hooks) => (via === 'release'
      ? O.releaseHold({ mainRoot: main, macroId: MACRO, subtaskId: S, holdId: h2.hold_id, stateRoots: [main], basisOf: basis('c'), hooks })
      : O.withdrawUnhandedHold({ mainRoot: main, macroId: MACRO, subtaskId: S, holdId: h2.hold_id, hooks }));

    it(`${via}: a crash between the release's restoration and the owner record's leaves the new hold pending, which a retry withdraws`, () => withDirs(async ({ main, lane }) => {
      const h2 = await overRejected(main, lane);
      const crash = new Error('crash');
      await withdraw(main, h2, { betweenRestoreWrites: () => { throw crash; } }).then(() => ok(false, 'crashed'), (err) => strictEqual(err, crash));
      strictEqual(H.readOwnerHold(main, MACRO, S).record.hold_id, h2.hold_id, 'the owner record is still the new hold');
      strictEqual(state(main), 'pending');
      strictEqual(H.readRecord(main, MACRO, 'releases', S).record.state, 'rejected', 'the release is back first');
      await withdraw(main, h2);
      strictEqual(state(main), 'rejected');
    }));

    it(`${via}: the new hold's fence is gone before the earlier hold comes back`, () => withDirs(async ({ main, lane }) => {
      const h2 = await overRejected(main, lane);
      let at = null;
      await withdraw(main, h2, { beforeRestore: () => { at = RL.fenceState(lane, h2.hold_id); } });
      strictEqual(at, 'absent');
      strictEqual(state(main), 'rejected');
    }));
  }
});

describe('a lane that cannot be looked at is never read as gone (the fail-closed rule for scans)', () => {
  // The lane's worktree under a directory that a file replaces: its stat
  // fails ENOTDIR, which no user, root included, can see past. `blind()`
  // makes it so, `see()` gives it back.
  const blindable = (dir) => {
    const box = join(dir, 'box');
    const lane = join(box, 'lane');
    mkdirSync(lane, { recursive: true });
    const away = `${box}.away`;
    return {
      lane,
      blind: () => { renameSync(box, away); writeFileSync(box, 'not a directory\n'); },
      see: () => { rmSync(box); renameSync(away, box); },
    };
  };
  const refusal = (code) => (err) => {
    ok(err instanceof O.HoldRefusal, String(err));
    strictEqual(err.code, code);
    match(err.message, /cannot be looked at \(ENOTDIR\)/);
    return true;
  };

  it('the handoff stays pending, naming it; a release, a withdrawal and a new hold refuse; its fence stays', () => withDirs(async ({ main, dir }) => {
    const { lane, blind, see } = blindable(dir);
    const h = await hold(main, { lane });
    blind();
    const r = await handOver(main);
    strictEqual(r.state, 'pending');
    match(r.blocker, /the lane's worktree .* cannot be looked at \(ENOTDIR\)/);
    // A pending hold's withdrawal would remove a fence it cannot see.
    await O.releaseHold({ mainRoot: main, macroId: MACRO, subtaskId: S, holdId: h.hold_id, stateRoots: [main], basisOf: basis('c') }).then(() => ok(false, 'refused'), refusal('lane-unreadable'));
    strictEqual(state(main), 'pending');
    see();
    strictEqual((await handOver(main)).state, 'held');
    strictEqual(RL.fenceState(lane, h.hold_id), 'present');
    blind();
    await release(main, h.hold_id).then(() => ok(false, 'refused'), refusal('lane-unreadable'));
    strictEqual(state(main), 'held');
    see();
    strictEqual(RL.fenceState(lane, h.hold_id), 'present', 'the fence stays while the lane cannot be seen');
    await release(main, h.hold_id);
    strictEqual(state(main), 'released-uncompared');
    blind();
    await hold(main, { lane }).then(() => ok(false, 'refused'), refusal('lane-unreadable'));
    strictEqual(state(main), 'released-uncompared', 'no hold was written');
    see();
  }));

  it("hold's own withdrawal (a blind run) refuses, its fence left in place", () => withDirs(async ({ main, dir }) => {
    const { lane, blind, see } = blindable(dir);
    const h = await hold(main, { lane });
    RL.writeFence({ laneRoot: lane, holdId: h.hold_id, subtaskId: S, macroId: MACRO });
    blind();
    await O.withdrawUnhandedHold({ mainRoot: main, macroId: MACRO, subtaskId: S, holdId: h.hold_id }).then(() => ok(false, 'refused'), refusal('lane-unreadable'));
    see();
    strictEqual(state(main), 'pending');
    strictEqual(RL.fenceState(lane, h.hold_id), 'present');
    strictEqual(await O.withdrawUnhandedHold({ mainRoot: main, macroId: MACRO, subtaskId: S, holdId: h.hold_id }), true);
    strictEqual(RL.fenceState(lane, h.hold_id), 'absent');
  }));

  it('a fence repair, a retirement, an orphaning and a macro end wait, naming it, and write nothing', () => withDirs(async ({ main, dir }) => {
    const { lane, blind, see } = blindable(dir);
    const h = await hold(main, { lane });
    strictEqual((await handOver(main)).state, 'held');
    RL.removeFence(lane, h.hold_id);
    blind();
    const fix = await O.repairHoldFence({ mainRoot: main, macroId: MACRO, subtaskId: S });
    strictEqual(fix.repaired, 'none');
    match(fix.blocker, /cannot be looked at \(ENOTDIR\)/);
    const ret = await O.retireSubtaskHolds({ mainRoot: main, macroId: MACRO, subtaskId: S, branch: BRANCH, stateRoots: [main] });
    strictEqual(ret.state, 'waiting');
    match(ret.why, /cannot be looked at \(ENOTDIR\)/);
    strictEqual(H.readOwnerHold(main, MACRO, S).record.state, 'held', 'not retired');
    deepStrictEqual(await O.orphanStale({ mainRoot: main, macroId: MACRO, subtasks: [], stateRoots: [main] }), [], 'not orphaned while the lane cannot be seen');
    strictEqual(H.readOwnerHold(main, MACRO, S).record.orphaned, undefined);
    const end = await O.retireMacroHolds({ mainRoot: main, macroId: MACRO, subtasks: [], stateRoots: [main] });
    strictEqual(end.state, 'waiting');
    match(end.why, /subtask S: the lane's worktree .* cannot be looked at \(ENOTDIR\)/);
    strictEqual(H.readOwnerHold(main, MACRO, S).state, 'ok', "the macro's holds are still there");
    see();
    strictEqual((await O.repairHoldFence({ mainRoot: main, macroId: MACRO, subtaskId: S })).repaired, 'written');
    const o = await O.orphanStale({ mainRoot: main, macroId: MACRO, subtasks: [], stateRoots: [main] });
    deepStrictEqual(o.map((x) => x.subtaskId), [S]);
    strictEqual(RL.fenceState(lane, h.hold_id), 'absent', 'orphaned with its fence once the lane is seen');
  }));
});

describe('a hold that names its child looks in every state root before it accepts a copy', () => {
  const handOverIn = (main, roots) => O.completeHandoff({ mainRoot: main, macroId: MACRO, subtaskId: S, stateRoots: roots });

  it("a later root's copy that cannot be looked at blocks the handoff and the comparison, though an earlier root has one", () => withDirs(async ({ main, dir }) => {
    const other = join(dir, 'other');
    const home = join(other, '.agentic-plugins/state/engineer');
    mkdirSync(home, { recursive: true });
    const first = child(main, { sub: 'archive' });
    const h = await hold(main, { child: CHILD });
    writeFileSync(join(home, 'archive'), 'not a directory\n');
    const a = O.archivedChildAt([main, other], CHILD);
    deepStrictEqual([a.file, a.unreadable.map((u) => u.file), a.others], [first, [join(home, 'archive', `${CHILD}.md`)], []]);
    const r = await handOverIn(main, [main, other]);
    strictEqual(r.state, 'pending');
    match(r.blocker, new RegExp(`may hold the lane's archived child ${CHILD}`));
    // Handed over and released while the later root could be looked at, then compared beside it.
    rmSync(join(home, 'archive'));
    strictEqual((await handOverIn(main, [main, other])).state, 'held');
    await O.releaseHold({ mainRoot: main, macroId: MACRO, subtaskId: S, holdId: h.hold_id, stateRoots: [main, other], basisOf: async () => ({ fingerprint_version: 1, fingerprint: 'f', tree_digest: 't', content_digest: 'c', child: CHILD }) });
    writeFileSync(join(home, 'archive'), 'not a directory\n');
    const c = await O.compareRelease({ mainRoot: main, macroId: MACRO, subtaskId: S, stateRoots: [main, other], basisOf: basis('c') });
    strictEqual(c.verdict, 'refused');
    match(c.why, /may hold the lane's archived child/);
    strictEqual(state(main), 'released-uncompared', 'not consumed');
  }));

  it('two copies in two roots block: which one holds its operations cannot be told', () => withDirs(async ({ main, dir }) => {
    const other = join(dir, 'other');
    const first = child(main, { sub: 'archive' });
    const second = child(other, { sub: 'archive', op: OP });
    await hold(main, { child: CHILD });
    deepStrictEqual(O.archivedChildAt([main, other], CHILD).others, [second]);
    deepStrictEqual(O.archivedChildAt([main, main], CHILD), { file: first, unreadable: [], others: [] }, 'one file named twice is one copy');
    const r = await handOverIn(main, [main, other]);
    strictEqual(r.state, 'pending');
    match(r.blocker, new RegExp(`archived child ${CHILD} is archived in several places`));
  }));
});
