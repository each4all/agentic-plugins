// tests/orchestrator/test-autopilot-scratch.mjs
//
// ADR-0068, amendment of 2026-11-10 (C175) — a run's temporary root
// (plugins/orchestrator/adapters/claude/autopilot/scratch.mjs): where it goes,
// the proof every removal needs, what keeps a step's directory, the sweep of
// what earlier runs left, and the driver end to end (the fake `claude` and
// the scripted worker, as in test-autopilot-driver.mjs).
//
// Every removal here runs in a directory this file made under the system's
// temporary directory; the refusals are asserted on the judgments
// (`scratchTarget`, `proveScratch`), which remove nothing.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRepo, ORCH, ENG, RUNTIME } from './fixtures/autopilot-repo.mjs';
import { setup as lanesSetup } from './fixtures/autopilot-lanes-run.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const S = await import(join(AP, 'scratch.mjs'));
const L = await import(join(AP, 'ledger.mjs'));
const W = await import(join(AP, 'worker.mjs'));
const { startRun, DEFAULTS, preflight } = await import(join(AP, 'driver.mjs'));
const SNAP_LIB = await import(join(ORCH, 'scripts/lib/peer-snapshot.mjs'));
const FAKE = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-fake-claude.mjs');
const SCRIPTED = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-scripted-worker.mjs');

// The judgments of a peer snapshot's run take a fixed listing here, one with
// no process in any tree, never the machine's: this file runs in the parallel
// pool, where the system's listing of every process can fail to prove a tree
// empty while other files' processes start and exit (`tree-unknown`, measured
// 2026-11-10 in a verification batch and under 60 probes at once), and a
// snapshot whose run is over then stays. What is under test is what scratch
// does with a judgment; whether a run's supervisor lives is read from that
// one process, with no listing. The listing itself is the peer snapshot
// suites' subject, which run apart (scripts/data/test-tiers.json).
globalThis[SNAP_LIB.LISTING_HOOK] = async () => [];

const RUN = 'autopilot-20261110T010000Z-a1b2c3';
const OTHER = 'autopilot-20261110T010000Z-0f4e12';
const NAME = RUN.slice('autopilot-'.length);
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && !k.startsWith('AGENTIC_')));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...GIT_ENV, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim();

// A scratch place: a repository and a base outside it, removed with the test.
function place(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'scratch-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const base = join(dir, 'base');
  mkdirSync(repo);
  mkdirSync(base);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'f.txt'), 'x\n');
  git(repo, 'add', 'f.txt');
  git(repo, 'commit', '-q', '-m', 'init');
  return { dir, repo, base, env: { ...GIT_ENV, TMPDIR: base } };
}

async function allocated(t, runId = RUN) {
  const p = place(t);
  const made = await S.allocateScratch({ repoRoot: p.repo, mainRoot: p.repo, runId, env: p.env });
  return { ...p, ...made, ident: { root: made.root, runId, commonDir: made.commonDir } };
}

// A process that is gone, and the fingerprint it had.
async function deadProcess({ supervisor = false } = {}) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise((r) => { setTimeout(r, 200); });
  const fingerprint = supervisor ? await SNAP_LIB.supervisorFingerprint(child.pid) : await L.processFingerprint(child.pid);
  const exited = new Promise((r) => child.on('exit', r));
  child.kill('SIGKILL');
  await exited;
  return { pid: child.pid, fingerprint };
}

describe('where a run\'s temporary root goes', () => {
  it('takes TMPDIR when it lies outside every worktree, and never a directory inside one', (t) => {
    const p = place(t);
    deepStrictEqual(S.scratchBase({ repoRoot: p.repo, env: p.env }), { base: p.base });
    const inside = join(p.repo, 'tmp');
    mkdirSync(inside);
    const fell = S.scratchBase({ repoRoot: p.repo, env: { ...p.env, TMPDIR: inside } });
    strictEqual(fell.base, realpathSync('/tmp'), 'a TMPDIR inside the worktree is passed over for /tmp');
    const dotted = join(p.repo, '..tmp');
    mkdirSync(dotted);
    strictEqual(S.scratchBase({ repoRoot: p.repo, env: { ...p.env, TMPDIR: dotted } }).base, realpathSync('/tmp'), 'a directory whose name begins with two dots is inside the worktree too');
    // With every candidate inside a worktree there is no base, and no fallback.
    const none = S.scratchBase({ repoRoot: p.repo, env: { ...p.env, TMPDIR: inside }, worktrees: () => ['/'] });
    strictEqual(none.base, undefined);
    match(none.problem, /Set TMPDIR to a directory outside every worktree/);
    match(S.scratchBase({ repoRoot: p.repo, env: p.env, worktrees: () => null }).problem, /cannot be listed/);
  });

  it('a linked worktree counts: a TMPDIR inside it is passed over too', (t) => {
    const p = place(t);
    const lane = join(p.dir, 'lane');
    git(p.repo, 'worktree', 'add', '-q', '-b', 'lane', lane);
    const inLane = join(lane, 'tmp');
    mkdirSync(inLane);
    strictEqual(S.scratchBase({ repoRoot: p.repo, env: { ...p.env, TMPDIR: inLane } }).base, realpathSync('/tmp'));
  });

  it('the preflight names no temporary-directory problem for a repository with a base', async (t) => {
    const p = place(t);
    writeFileSync(join(p.repo, '.gitignore'), '.agentic-plugins/runs/\n.agentic-plugins/state/\n.agentic-plugins/tmp/\n.agentic-plugins/cache/\n');
    const ok1 = await preflight({ repoRoot: p.repo, env: { ...p.env, AGENTIC_ORCHESTRATOR_ROOT: ORCH, AGENTIC_ENGINEER_ROOT: ENG, AGENTIC_RUNTIME_ROOT: RUNTIME }, checkClaude: false });
    ok(!ok1.problems.some((x) => /temporary directory/.test(x)), ok1.problems.join('\n'));
  });

  it('allocates exclusively, with a marker and an index entry, and refuses a root that exists or a home that is a link', async (t) => {
    const a = await allocated(t);
    strictEqual(a.root, join(a.base, 'agentic-ap', NAME));
    const marker = JSON.parse(readFileSync(join(a.root, S.SCRATCH_MARKER), 'utf8'));
    deepStrictEqual([marker.schema, marker.run_id, marker.repo, marker.common_dir], [S.SCRATCH_SCHEMA, RUN, a.repo, join(a.repo, '.git')]);
    const index = S.listScratchIndex(a.repo);
    deepStrictEqual(index.map((e) => [e.runId, e.record.root, e.record.pid]), [[RUN, a.root, process.pid]]);
    await rejects(S.allocateScratch({ repoRoot: a.repo, mainRoot: a.repo, runId: RUN, env: a.env }), /EEXIST/);
    // A root that exists with no entry of the run's: refused, and no entry is
    // left that would hand another's directory to a sweep.
    mkdirSync(join(a.base, 'agentic-ap', OTHER.slice(10)));
    await rejects(S.allocateScratch({ repoRoot: a.repo, mainRoot: a.repo, runId: OTHER, env: a.env }), /could not be made exclusively/);
    deepStrictEqual(S.listScratchIndex(a.repo).map((e) => e.runId), [RUN]);

    const p = place(t);
    const elsewhere = join(p.dir, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(p.base, 'agentic-ap'));
    await rejects(S.allocateScratch({ repoRoot: p.repo, mainRoot: p.repo, runId: RUN, env: p.env }), /not a directory of your own/);
    deepStrictEqual(readdirSync(elsewhere), [], 'nothing was made through the link');
  });
});

describe('the proof a removal needs', () => {
  const root = `/tmp/agentic-ap/${NAME}`;
  it('scratchTarget judges the paths alone', () => {
    const t = (dir, o = { root, runId: RUN }) => S.scratchTarget(dir, o);
    deepStrictEqual(t(root), { ok: true, kind: 'root' });
    deepStrictEqual(t(`${root}/s3`), { ok: true, kind: 'step' });
    deepStrictEqual(t(`${root}/v4-0`), { ok: true, kind: 'check' });
    deepStrictEqual(t(`${root}/.removing-s3`), { ok: true, kind: 'removing' });
    const refused = [
      [root, { root: '', runId: RUN }, 'no-root'],
      [root, { root: undefined, runId: RUN }, 'no-root'],
      ['s1', { root: `agentic-ap/${NAME}`, runId: RUN }, 'root-not-absolute'],
      [root, { root: `${root}/`, runId: RUN }, 'root-not-absolute'],
      [root, { root: `/tmp/agentic-ap/x/../${NAME}`, runId: RUN }, 'root-not-absolute'],
      [root, { root, runId: 'run-1' }, 'run-id'],
      [root, { root, runId: OTHER }, 'root-layout'],
      [`/tmp/other/${NAME}`, { root: `/tmp/other/${NAME}`, runId: RUN }, 'root-layout'],
      ['', { root, runId: RUN }, 'dir-not-absolute'],
      ['/tmp', { root, runId: RUN }, 'outside-root'],
      ['/', { root, runId: RUN }, 'outside-root'],
      [`/tmp/agentic-ap/${OTHER.slice(10)}/s1`, { root, runId: RUN }, 'outside-root'],
      [`${root}/s1/deeper`, { root, runId: RUN }, 'outside-root'],
      [`${root}/notes`, { root, runId: RUN }, 'name'],
      [`${root}/s0`, { root, runId: RUN }, 'name'],
      [`${root}/${S.SCRATCH_MARKER}`, { root, runId: RUN }, 'name'],
      [`${root}/.removing-`, { root, runId: RUN }, 'name'],
    ];
    for (const [dir, o, why] of refused) deepStrictEqual(t(dir, o), { ok: false, why }, `${JSON.stringify(dir)} with ${JSON.stringify(o)}`);
  });

  it('proveScratch reads the root, its marker and the child, and refuses each that is not the run\'s', async (t) => {
    const a = await allocated(t);
    const step = join(a.root, 's1');
    mkdirSync(step);
    const why = (dir, ident = a.ident) => {
      try { S.proveScratch(dir, ident); return null; } catch (e) { ok(e instanceof S.ScratchRefusal, String(e)); return e.why; }
    };
    strictEqual(why(step), null);
    deepStrictEqual(S.proveScratch(join(a.root, 's2'), a.ident), { kind: 'step', gone: true });
    strictEqual(why(step, { ...a.ident, commonDir: join(a.dir, 'another.git') }), 'marker-of-another-repository');
    strictEqual(why(step, { ...a.ident, commonDir: '' }), 'no-repository');
    // A child that is a link, and one that is a file.
    symlinkSync(a.repo, join(a.root, 's7'));
    strictEqual(why(join(a.root, 's7')), 'not-a-directory');
    writeFileSync(join(a.root, 's8'), '');
    strictEqual(why(join(a.root, 's8')), 'not-a-directory');
    // The root reached through a link in its path.
    const link = join(a.dir, 'link');
    symlinkSync(a.base, link);
    const through = join(link, 'agentic-ap', NAME);
    strictEqual(why(join(through, 's1'), { ...a.ident, root: through }), 'root-through-a-link');
    // Another run's marker, then none.
    const marker = join(a.root, S.SCRATCH_MARKER);
    const text = readFileSync(marker, 'utf8');
    writeFileSync(marker, text.replace(RUN, OTHER));
    strictEqual(why(step), 'marker-of-another-run');
    rmSync(marker);
    strictEqual(why(step), 'no-marker');
    strictEqual(why(a.root), 'no-marker');
    ok(existsSync(step), 'no refusal removed anything');
    await rejects(S.removeScratch(step, a.ident), S.ScratchRefusal);
    ok(existsSync(step));
  });
});

describe('removal', () => {
  it('a step\'s directory goes with what it holds; the root only when empty, its marker last', async (t) => {
    const a = await allocated(t);
    const step = join(a.root, 's1');
    mkdirSync(join(step, 'agentic-text.abc'), { recursive: true });
    writeFileSync(join(step, 'agentic-text.abc', 'note.md'), 'n\n');
    await rejects(S.removeScratch(a.root, a.ident), /is not empty/);
    ok(existsSync(join(a.root, S.SCRATCH_MARKER)), 'a root with a directory keeps its marker');
    strictEqual(await S.removeScratch(step, a.ident), 'removed');
    strictEqual(await S.removeScratch(step, a.ident), 'gone');
    strictEqual(await S.removeScratch(a.root, a.ident), 'removed');
    ok(!existsSync(a.root));
    ok(existsSync(a.base) && existsSync(a.repo));
  });

  it('a removal a crash interrupted is finished by the next pass, without judging it again', async (t) => {
    const a = await allocated(t);
    const step = join(a.root, 's1');
    mkdirSync(join(step, 'sub'), { recursive: true });
    const asked = [];
    const busy = async (dir) => { asked.push(dir); return null; };
    const first = await S.sweepScratch({ ...a.ident, busy, rm: async () => { throw new Error('crashed'); } });
    deepStrictEqual([first.removed, first.rootRemoved, first.failures.map((f) => f.error)], [0, false, ['crashed']]);
    deepStrictEqual(readdirSync(a.root).sort(), ['.removing-s1', S.SCRATCH_MARKER]);
    const second = await S.sweepScratch({ ...a.ident, busy });
    deepStrictEqual([second.removed, second.rootRemoved, second.failures], [1, true, []]);
    deepStrictEqual(asked, [step], 'the renamed directory was not judged a second time');
    ok(!existsSync(a.root));
  });

  it('a sweep keeps what is held, what is busy and what the run did not make, and the root with them', async (t) => {
    const a = await allocated(t);
    for (const n of ['s1', 's2', 's3', 'v4-0', 'notes']) mkdirSync(join(a.root, n));
    const hold = new Map([[join(a.root, 's2'), 'the step\'s process group outlived SIGKILL']]);
    const judged = [];
    const busy = async (dir) => { judged.push(dir); return dir.endsWith('s3') ? 'a peer still uses it' : null; };
    const r = await S.sweepScratch({ ...a.ident, hold, busy });
    strictEqual(r.removed, 2);
    strictEqual(r.rootRemoved, false);
    deepStrictEqual(r.deferred.map((d) => [d.dir.slice(a.root.length + 1), d.why]), [
      ['notes', 'not a directory the run made'], ['s2', 'the step\'s process group outlived SIGKILL'], ['s3', 'a peer still uses it'],
    ]);
    deepStrictEqual(judged.map((d) => d.slice(a.root.length + 1)), ['s1', 's3'], 'a check\'s directory and a held one are not judged');
    deepStrictEqual(readdirSync(a.root).sort(), [S.SCRATCH_MARKER, 'notes', 's2', 's3']);
  });

  it('nothing is scanned before it is proven: a step directory that is a link is never opened, by a sweep or by a release', async (t) => {
    const a = await allocated(t);
    const elsewhere = join(a.dir, 'elsewhere');
    mkdirSync(join(elsewhere, 'engineer-peer-snapshot-AbC123'), { recursive: true });
    symlinkSync(elsewhere, join(a.root, 's1'));
    const scanned = [];
    const busy = async (dir) => { scanned.push(dir); return null; };
    const r = await S.sweepScratch({ ...a.ident, busy });
    deepStrictEqual([scanned, r.removed, r.rootRemoved], [[], 0, false]);
    match(r.failures[0].error, /not-a-directory/);
    const run = S.createRunScratch({ ...a.ident, mainRoot: a.repo, env: a.env, busy });
    await run.release(join(a.root, 's1'));
    deepStrictEqual(scanned, []);
    strictEqual((await run.end({ sweep: false })).failures, 1);
    ok(existsSync(join(elsewhere, 'engineer-peer-snapshot-AbC123')));
  });

  it('a marker that is no regular file is refused, never waited on', async (t) => {
    const a = await allocated(t);
    mkdirSync(join(a.root, 's1'));
    rmSync(join(a.root, S.SCRATCH_MARKER));
    execFileSync('mkfifo', [join(a.root, S.SCRATCH_MARKER)]);
    const r = await S.sweepScratch({ ...a.ident, busy: async () => null });
    deepStrictEqual([r.refused, r.removed, r.rootRemoved], ['no-marker', 0, false]);
    ok(existsSync(join(a.root, 's1')));
  });

  it('a sweep of a root that is not proven the run\'s touches nothing', async (t) => {
    const a = await allocated(t);
    mkdirSync(join(a.root, 's1'));
    const r = await S.sweepScratch({ ...a.ident, commonDir: join(a.dir, 'another.git'), busy: async () => null });
    deepStrictEqual([r.refused, r.removed, r.rootRemoved], ['marker-of-another-repository', 0, false]);
    ok(existsSync(join(a.root, 's1')));
  });
});

describe('what keeps a step\'s directory', () => {
  it('a snapshot directory with no owner record, however deep, keeps it', async (t) => {
    const a = await allocated(t);
    const step = join(a.root, 's1');
    mkdirSync(join(step, 'a', 'b', 'engineer-peer-snapshot-AbC123'), { recursive: true });
    match(await S.scratchBusy(step), /engineer-peer-snapshot-AbC123 has no owner record that reads/);
    mkdirSync(join(a.root, 's2', 'plain'), { recursive: true });
    strictEqual(await S.scratchBusy(join(a.root, 's2')), null);
    strictEqual(await S.scratchBusy(join(a.root, 's9')), null, 'a directory that is gone holds nothing');
  });

  it('a live peer\'s snapshot keeps the whole step directory; once its run is over it goes with its registration', async (t) => {
    const a = await allocated(t);
    const step = join(a.root, 's1');
    mkdirSync(step);
    writeFileSync(join(step, 'prompt.xml'), '<p/>\n');
    const saved = process.env.TMPDIR;
    let live;
    let over;
    process.env.TMPDIR = step;
    try {
      // One whose supervisor runs (this process), one whose supervisor is gone.
      live = await SNAP_LIB.createPeerSnapshot({ cwd: a.repo, runId: 'plan-verify-20261110T010000Z-aaaaaa', persona: 'engineer', env: a.env });
      const gone = await deadProcess({ supervisor: true });
      over = await SNAP_LIB.createPeerSnapshot({ cwd: a.repo, runId: 'plan-verify-20261110T010001Z-bbbbbb', persona: 'engineer', env: a.env, supervisorPid: process.pid });
      const owner = JSON.parse(readFileSync(over.owner_path, 'utf8'));
      writeFileSync(over.owner_path, `${JSON.stringify({ ...owner, supervisor: gone }, null, 2)}\n`);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
    }
    ok(live.parent.startsWith(step) && over.parent.startsWith(step), 'the snapshots are under the step\'s TMPDIR');
    const run = S.createRunScratch({ ...a.ident, mainRoot: a.repo, env: a.env });
    await run.release(step);
    ok(existsSync(join(step, 'prompt.xml')), 'the whole step directory stays while a peer of it lives');
    ok(existsSync(live.root), 'the live snapshot is untouched');
    ok(!existsSync(over.parent), 'the snapshot whose run is over was removed');
    ok(!git(a.repo, 'worktree', 'list', '--porcelain').includes(over.root), 'with its registration');
    let record = await run.end();
    match(record.deferred[0].why, /is not proven over \(alive: supervisor-alive\)/);
    strictEqual(record.removed_at, null);
    deepStrictEqual(S.listScratchIndex(a.repo).map((e) => e.runId), [RUN], 'the index keeps a root that is not gone');
    // The live run ends: its supervisor is gone now.
    const owner = JSON.parse(readFileSync(live.owner_path, 'utf8'));
    writeFileSync(live.owner_path, `${JSON.stringify({ ...owner, supervisor: await deadProcess({ supervisor: true }) }, null, 2)}\n`);
    record = await run.end();
    deepStrictEqual([record.deferred, record.failures], [[], 0]);
    ok(!existsSync(a.root));
    deepStrictEqual(S.listScratchIndex(a.repo), []);
    ok(!git(a.repo, 'worktree', 'list', '--porcelain').includes('peer-snapshot'), 'no snapshot registration is left');
  });
});

describe('the run\'s handle', () => {
  it('makes only its own step and check directories, removes one at a time in the background, and holds what it is told to', async (t) => {
    const a = await allocated(t);
    const order = [];
    let open = null;
    const rm = async (target, o) => {
      order.push(`start ${target.slice(a.root.length + 1)}`);
      await new Promise((r) => { open = r; });
      rmSync(target, o);
      order.push(`end ${target.slice(a.root.length + 1)}`);
    };
    const run = S.createRunScratch({ ...a.ident, mainRoot: a.repo, env: a.env, busy: async () => null, rm });
    throws(() => run.make(join(a.root, 'elsewhere')), /is not a step or check directory/);
    throws(() => run.make(a.root), /is not a step or check directory/);
    const [s1, s2, c] = [run.stepDir(1), run.stepDir(2), run.checkDir(3, 0)];
    for (const d of [s1, s2, c]) run.make(d);
    throws(() => run.make(s1), /EEXIST/);
    run.release(s1);
    run.release(s2);
    run.release(c, 'the check\'s process group outlived SIGKILL');
    // The step that released a directory is not kept waiting for its removal.
    await new Promise((r) => { setImmediate(r); });
    deepStrictEqual(order, ['start .removing-s1']);
    open();
    await new Promise((r) => { setTimeout(r, 50); });
    deepStrictEqual(order, ['start .removing-s1', 'end .removing-s1', 'start .removing-s2']);
    open();
    const record = await run.end();
    deepStrictEqual(record.deferred, [{ dir: c, why: 'the check\'s process group outlived SIGKILL' }]);
    deepStrictEqual(readdirSync(a.root).sort(), [S.SCRATCH_MARKER, 'v3-0']);
  });

  it('a removal that fails is counted and never thrown; an error end sweeps nothing', async (t) => {
    const a = await allocated(t);
    const run = S.createRunScratch({ ...a.ident, mainRoot: a.repo, env: a.env, busy: async () => { throw new Error('no'); } });
    run.make(run.stepDir(1));
    await run.release(run.stepDir(1));
    await run.release(join(a.dir, 'repo'));
    const record = await run.end({ sweep: false });
    strictEqual(record.failures, 2);
    deepStrictEqual(record.deferred.map((d) => d.dir), [run.stepDir(1)]);
    ok(existsSync(run.stepDir(1)) && existsSync(a.repo));
  });
});

describe('what earlier runs left', () => {
  it('sweeps a dead driver\'s root, and never the caller\'s own, a live driver\'s, or one whose run holds an open-run record', async (t) => {
    const p = place(t);
    const dead = await deadProcess();
    const ids = ['autopilot-20261110T010000Z-dead01', 'autopilot-20261110T010000Z-11fe01', 'autopilot-20261110T010000Z-5e1f01', 'autopilot-20261110T010000Z-09e001'];
    const [gone, live, self, open] = ids;
    const roots = {};
    for (const id of ids) {
      const made = await S.allocateScratch({ repoRoot: p.repo, mainRoot: p.repo, runId: id, env: p.env, pid: id === live ? process.pid : dead.pid });
      roots[id] = made.root;
      mkdirSync(join(made.root, 's1', 'agentic-text.x'), { recursive: true });
    }
    // The dead pid's own fingerprint, as its driver recorded it.
    for (const id of [gone, self, open]) {
      const file = join(S.scratchIndexDir(p.repo), `${id}.json`);
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), fingerprint: dead.fingerprint }));
    }
    L.writeOpenRun(p.repo, { runId: open, macroId: null, checkout: p.repo, runDir: join(p.repo, '.agentic-plugins/runs/autopilot', open), pid: dead.pid, fingerprint: dead.fingerprint, startedAt: '2026-11-10T01:00:00Z' });
    const results = await S.sweepLeftovers({ mainRoot: p.repo, selfRunId: self, env: p.env });
    deepStrictEqual(results.map((r) => [r.run_id, r.outcome]), [[live, 'live'], [gone, 'removed']].sort((x, y) => (x[0] < y[0] ? -1 : 1)));
    ok(!existsSync(roots[gone]));
    for (const id of [live, self, open]) ok(existsSync(join(roots[id], 's1', 'agentic-text.x')), `${id} is untouched`);
    deepStrictEqual(S.listScratchIndex(p.repo).map((e) => e.runId).sort(), [live, self, open].sort());
    deepStrictEqual(S.describeLeftovers(results), [`temporary files of run ${gone}: removed ${roots[gone]}`]);
  });

  it('an open-run record written while the sweep judged the driver keeps the root: it is read again once the driver is known dead', async (t) => {
    const p = place(t);
    const dead = await deadProcess();
    const made = await S.allocateScratch({ repoRoot: p.repo, mainRoot: p.repo, runId: RUN, env: p.env, pid: dead.pid });
    mkdirSync(join(made.root, 's1'));
    // The run wrote its record after the sweep listed the records, then died
    // with a worker in s1: the seam is where the sweep waited on the driver.
    const afterJudged = () => {
      L.writeOpenRun(p.repo, { runId: RUN, macroId: null, checkout: p.repo, runDir: join(p.repo, '.agentic-plugins/runs/autopilot', RUN), pid: dead.pid, fingerprint: dead.fingerprint, startedAt: '2026-11-10T01:00:00Z' });
    };
    deepStrictEqual(await S.sweepLeftovers({ mainRoot: p.repo, env: p.env, hooks: { afterJudged } }), []);
    ok(existsSync(join(made.root, 's1')));
    // Control: with the record gone, the same sweep takes it.
    L.removeOpenRun(p.repo, RUN);
    deepStrictEqual((await S.sweepLeftovers({ mainRoot: p.repo, env: p.env })).map((r) => r.outcome), ['removed']);
  });

  it('what a crash stranded is finished: an entry with no root, and an empty root with no marker; one with no marker that holds anything is kept', async (t) => {
    const p = place(t);
    const dead = await deadProcess();
    const ids = ['autopilot-20261110T010000Z-000001', 'autopilot-20261110T010000Z-000002', 'autopilot-20261110T010000Z-000003'];
    const roots = [];
    for (const id of ids) roots.push((await S.allocateScratch({ repoRoot: p.repo, mainRoot: p.repo, runId: id, env: p.env, pid: dead.pid })).root);
    // 1: died before its root was made (the entry comes first).
    rmSync(roots[0], { recursive: true });
    // 2: died between the root and its marker, or between the marker's removal and the root's.
    rmSync(join(roots[1], S.SCRATCH_MARKER));
    // 3: no marker, and something in it.
    rmSync(join(roots[2], S.SCRATCH_MARKER));
    mkdirSync(join(roots[2], 's1'));
    const results = await S.sweepLeftovers({ mainRoot: p.repo, env: p.env });
    deepStrictEqual(results.map((r) => r.outcome), ['removed', 'removed', 'kept']);
    deepStrictEqual([existsSync(roots[0]), existsSync(roots[1]), existsSync(join(roots[2], 's1'))], [false, false, true]);
    deepStrictEqual(S.listScratchIndex(p.repo).map((e) => e.runId), [ids[2]]);
  });

  it('keeps a root whose marker names another run, and an entry found from a linked checkout is swept from the main one', async (t) => {
    const p = place(t);
    const dead = await deadProcess();
    const lane = join(p.dir, 'lane');
    git(p.repo, 'worktree', 'add', '-q', '-b', 'lane', lane);
    // A run that drove the linked checkout: its index entry is the main one's.
    const made = await S.allocateScratch({ repoRoot: lane, mainRoot: p.repo, runId: RUN, env: p.env, pid: dead.pid });
    mkdirSync(join(made.root, 'v2-0', 'mutation-copy-x'), { recursive: true });
    const wrong = await S.allocateScratch({ repoRoot: p.repo, mainRoot: p.repo, runId: OTHER, env: p.env, pid: dead.pid });
    mkdirSync(join(wrong.root, 's1'));
    const marker = join(wrong.root, S.SCRATCH_MARKER);
    writeFileSync(marker, readFileSync(marker, 'utf8').replace(OTHER, RUN));
    for (const id of [RUN, OTHER]) {
      const file = join(S.scratchIndexDir(p.repo), `${id}.json`);
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), fingerprint: dead.fingerprint }));
    }
    const results = await S.sweepLeftovers({ mainRoot: p.repo, env: p.env });
    deepStrictEqual(results.map((r) => [r.run_id, r.outcome]).sort(), [[OTHER, 'kept'], [RUN, 'removed']].sort());
    match(results.find((r) => r.run_id === OTHER).detail, /is not proven that run's \(marker-of-another-run\)/);
    ok(existsSync(join(wrong.root, 's1')) && !existsSync(made.root));
  });
});

// ---------------------------------------------------------------------------
// The driver, end to end

const version = (root) => JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const COMMIT = { kind: 'commit', verb: null, confidence: 'HIGH' };

async function setup({ scenario }) {
  const fx = await makeRepo();
  const work = realpathSync(fx.work);
  fx.env.HOME = join(fx.dir, 'home');
  mkdirSync(fx.env.HOME);
  const base = join(fx.dir, 'tmp');
  mkdirSync(base);
  const scen = join(fx.dir, 'scenario.json');
  writeFileSync(scen, JSON.stringify(scenario));
  const roots = { orchestrator: ORCH, engineer: ENG, runtime: RUNTIME };
  const env = {
    ...fx.env, TMPDIR: base,
    AUTOPILOT_CLAUDE_BIN: FAKE, FAKE_CLAUDE_MODE: 'script', FAKE_WORKER_SCRIPT: SCRIPTED, FAKE_SCENARIO: scen,
    FAKE_CLAUDE_LOG: join(fx.dir, 'claude.log'),
    AGENTIC_ORCHESTRATOR_ROOT: ORCH, AGENTIC_ENGINEER_ROOT: ENG, AGENTIC_RUNTIME_ROOT: RUNTIME,
    FAKE_PLUGINS: JSON.stringify(Object.entries(roots).map(([name, root]) => ({ name, path: root, source: `${name}@agentic-plugins`, version: version(root) }))),
  };
  const lines = [];
  const run = (opts = {}, deps = {}) => startRun({
    repoRoot: work,
    options: { ...DEFAULTS, models: 'owner-default', model: null, effort: null, macro: null, forced: null, forcedText: null, notifyLocal: false, ...opts },
    env, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`), deps: { signals: new EventEmitter(), ...deps },
  });
  const latest = () => L.readRun(work, L.listRuns(work).at(-1));
  const workerEnvs = () => readFileSync(env.FAKE_CLAUDE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l).env).filter((e) => e.AGENTIC_AUTOPILOT_STEP);
  return { fx, work, env, base: realpathSync(base), run, lines, latest, workerEnvs };
}

describe('a run gives each step its own TMPDIR and removes it when the step ends', () => {
  it('each worker sees its step\'s directory, outside the worktree; what it left there is gone when the run ends, with the root and its index entry', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true } } });
    try {
      const seen = [];
      let firstGoneDuringRun = null;
      const startWorker = (o) => {
        // What a runbook's \`mktemp -d\` leaves, never deleted by the step.
        ok(existsSync(o.tmpDir), 'the directory exists before the worker starts');
        mkdirSync(join(o.tmpDir, 'agentic-text.Xy12ab'));
        writeFileSync(join(o.tmpDir, 'agentic-text.Xy12ab', 'note.md'), 'n\n');
        seen.push(o.tmpDir);
        const w = W.startWorker(o);
        // By the second step's end the first step's directory is gone, with
        // the run still going: the step's release removed it, not the run's end.
        if (o.seq === 2) return { ...w, done: w.done.then((x) => { firstGoneDuringRun = !existsSync(seen[0]) && existsSync(o.tmpDir); return x; }) };
        return w;
      };
      strictEqual(await t.run({}, { startWorker }), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.steps.map((s) => [s.kind, s.outcome]), [['dispatch', 'ok'], ['commit', 'ok']]);
      const root = join(t.base, 'agentic-ap', S.scratchRootName(r.run.run_id));
      deepStrictEqual(seen, [join(root, 's1'), join(root, 's2')]);
      deepStrictEqual(r.steps.map((s) => s.tmp_dir), seen, 'the started line records it');
      strictEqual(firstGoneDuringRun, true, 'the first step\'s directory went when that step ended');
      deepStrictEqual(t.workerEnvs().map((e) => e.TMPDIR), seen, 'the worker\'s TMPDIR is its step\'s');
      ok(!existsSync(root), 'the root is gone at the run\'s end');
      deepStrictEqual(readdirSync(join(t.base, 'agentic-ap')), []);
      deepStrictEqual(S.listScratchIndex(t.work), []);
      deepStrictEqual([r.run.scratch.root, r.run.scratch.deferred, r.run.scratch.failures, typeof r.run.scratch.removed_at], [root, [], 0, 'string']);
      strictEqual(t.fx.git('status', '--porcelain'), '', 'nothing of it dirtied the worktree');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a step whose group outlived SIGKILL keeps its directory, which the run records, and no sweep takes it while the run keeps its open-run record', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true } } });
    try {
      const startWorker = (o) => {
        const w = W.startWorker(o);
        return { ...w, done: w.done.then((x) => (o.seq === 1 ? { ...x, groupTeardown: 'lingering' } : x)) };
      };
      await t.run({}, { startWorker });
      const r = t.latest();
      const root = join(t.base, 'agentic-ap', S.scratchRootName(r.run.run_id));
      deepStrictEqual(r.run.scratch.deferred, [{ dir: join(root, 's1'), why: 'the step\'s process group outlived SIGKILL' }]);
      strictEqual(r.run.scratch.removed_at, null);
      ok(existsSync(join(root, 's1')));
      deepStrictEqual(S.listScratchIndex(t.work).map((e) => e.runId), [r.run.run_id]);
      ok(t.lines.some((l) => /temporary files: 1 directory stays under/.test(l)), t.lines.join('\n'));
      // While its open-run record stays, no sweep takes it.
      deepStrictEqual(L.listOpenRuns(t.work).map((x) => x.runId), [r.run.run_id]);
      deepStrictEqual(await S.sweepLeftovers({ mainRoot: t.work, env: t.env }), []);
      ok(existsSync(join(root, 's1')));
    } finally {
      t.fx.cleanup();
    }
  });

  it('a run\'s start sweeps what a dead run left and trims the checkout\'s old runs, and neither is a halt', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true } } });
    try {
      // A dead run's root, with what its step left, found from the index.
      const dead = await deadProcess();
      const left = await S.allocateScratch({ repoRoot: t.work, mainRoot: t.work, runId: RUN, env: t.env, pid: dead.pid });
      mkdirSync(join(left.root, 's3', 'agentic-op.q1w2e3'), { recursive: true });
      const entry = join(S.scratchIndexDir(t.work), `${RUN}.json`);
      writeFileSync(entry, JSON.stringify({ ...JSON.parse(readFileSync(entry, 'utf8')), fingerprint: dead.fingerprint }));
      // Twenty-one old ended runs: one past the floor of twenty.
      const old = (n) => `autopilot-202609${String(n).padStart(2, '0')}T000000Z-${String(n).padStart(6, '0')}`;
      for (let n = 1; n <= 21; n += 1) {
        const dir = join(t.work, '.agentic-plugins/runs/autopilot', old(n));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'run.json'), JSON.stringify({ run_id: old(n), status: 'halted', ended_at: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString() }));
        writeFileSync(join(dir, 'worker-1.jsonl'), 'x'.repeat(100));
      }
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      ok(!existsSync(left.root), 'the dead run\'s root is gone');
      ok(t.lines.includes(`  temporary files of run ${RUN}: removed ${left.root}`), t.lines.join('\n'));
      ok(t.lines.some((l) => /^ {2}retention: trimmed the worker streams and verification logs of 1 old run /.test(l)), t.lines.join('\n'));
      const runs = join(t.work, '.agentic-plugins/runs/autopilot');
      deepStrictEqual([existsSync(join(runs, old(1), 'worker-1.jsonl')), existsSync(join(runs, old(2), 'worker-1.jsonl')), existsSync(join(runs, old(1), 'run.json'))], [false, true, true]);
      deepStrictEqual(t.latest().steps.map((s) => [s.kind, s.outcome]), [['dispatch', 'ok'], ['commit', 'ok']], 'the run went on');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a start that cannot make its root starts no run', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true } } });
    try {
      const code = await t.run({}, { allocateScratch: async () => { throw new Error('the run\'s temporary directory /x could not be made exclusively (EACCES)'); } });
      strictEqual(code, 1);
      ok(t.lines.includes('ERR   - the run\'s temporary directory /x could not be made exclusively (EACCES)'), t.lines.join('\n'));
      deepStrictEqual(L.listRuns(t.work), [], 'no run directory was made');
      ok(!existsSync(t.env.FAKE_CLAUDE_LOG), 'no worker started');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a step directory that cannot be made fails the run before any worker of that step, with the driver\'s TMPDIR never used', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true } } });
    try {
      let started = 0;
      const allocateScratch = async (a) => {
        const made = await S.allocateScratch(a);
        // The step's name is taken by a file: its mkdir fails.
        writeFileSync(join(made.root, 's1'), '');
        return made;
      };
      await rejects(t.run({}, { allocateScratch, startWorker: (o) => { started += 1; return W.startWorker(o); } }), /EEXIST/);
      strictEqual(started, 0);
      const r = t.latest();
      strictEqual(r.run.status, 'error');
      ok(!existsSync(t.env.FAKE_CLAUDE_LOG), 'no worker started');
    } finally {
      t.fx.cleanup();
    }
  });
});

// The scheduler's own wiring (scheduler.mjs): with --lanes a step's directory
// reaches its worker, and goes, through other lines than the serial run's.
describe('a run with lanes gives each lane step its own TMPDIR too', () => {
  async function lanes(scenario) {
    const t = await lanesSetup({ scenario });
    const base = join(t.dir, 'tmp');
    mkdirSync(base);
    t.env.TMPDIR = base;
    const workerEnvs = () => readFileSync(t.env.FAKE_CLAUDE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l).env).filter((e) => e.AGENTIC_AUTOPILOT_STEP);
    return { ...t, base: realpathSync(base), workerEnvs };
  }

  it('each lane worker sees its step\'s directory, which the started line records; it is gone once the step ended, with the run still going', async () => {
    const t = await lanes({ A: { next: [COMMIT], file: 'a.txt' }, B: { next: [COMMIT], file: 'b.txt' } });
    try {
      const seen = new Map();
      let earlierGoneDuringRun = null;
      const startWorker = (o) => {
        ok(o.tmpDir && existsSync(o.tmpDir), 'the directory exists before the worker starts');
        mkdirSync(join(o.tmpDir, 'agentic-text.Xy12ab'));
        writeFileSync(join(o.tmpDir, 'agentic-text.Xy12ab', 'note.md'), 'n\n');
        seen.set(o.seq, o.tmpDir);
        const w = W.startWorker(o);
        // The last step started only after both dispatches had ended and
        // were settled. Their directories go in the background, so this
        // step is kept from ending (the run still goes) until they are
        // gone, for ten seconds at most; its own is still there then.
        if (o.seq === 4) {
          return { ...w, done: w.done.then(async (x) => {
            const gone = () => !existsSync(seen.get(1)) && !existsSync(seen.get(2));
            for (let i = 0; i < 100 && !gone(); i += 1) await new Promise((r) => { setTimeout(r, 100); });
            earlierGoneDuringRun = gone() && existsSync(o.tmpDir);
            return x;
          }) };
        }
        return w;
      };
      await t.run({}, { startWorker });
      const r = t.latest();
      const steps = [...r.steps].sort((a, b) => a.seq - b.seq);
      deepStrictEqual(steps.map((s) => [s.seq, s.outcome]), [[1, 'ok'], [2, 'ok'], [3, 'ok'], [4, 'ok']], t.lines.join('\n'));
      ok(steps.every((s) => s.lane === 'A' || s.lane === 'B'), 'every step ran in a lane');
      const root = join(t.base, 'agentic-ap', S.scratchRootName(r.run.run_id));
      deepStrictEqual([1, 2, 3, 4].map((n) => seen.get(n)), [1, 2, 3, 4].map((n) => join(root, `s${n}`)));
      deepStrictEqual(steps.map((s) => s.tmp_dir), [1, 2, 3, 4].map((n) => join(root, `s${n}`)), 'the started line records it');
      deepStrictEqual(t.workerEnvs().map((e) => e.TMPDIR).sort(), [1, 2, 3, 4].map((n) => join(root, `s${n}`)), 'each lane worker\'s TMPDIR is its step\'s, never the driver\'s');
      strictEqual(earlierGoneDuringRun, true, 'a step\'s directory went when that step ended');
      ok(!existsSync(root), 'the root is gone at the run\'s end');
      deepStrictEqual([r.run.scratch.deferred, r.run.scratch.failures], [[], 0]);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a lane step whose group outlived SIGKILL keeps its directory, which the run records', async () => {
    const t = await lanes({ A: { next: [COMMIT], file: 'a.txt' }, B: { next: [COMMIT], file: 'b.txt' } });
    try {
      // The first step's teardown answers only once the other lane's worker
      // has started (ten seconds at most), so the control below has a step.
      let secondStarted;
      const second = new Promise((r) => { secondStarted = r; });
      const startWorker = (o) => {
        if (o.seq === 2) secondStarted();
        return W.startWorker(o.seq === 1 ? { ...o, terminateGroup: async () => { await Promise.race([second, new Promise((r) => { setTimeout(r, 10_000); })]); return 'lingering'; } } : o);
      };
      await t.run({}, { startWorker });
      const r = t.latest();
      strictEqual(r.steps.find((s) => s.seq === 1)?.group_teardown, 'lingering', t.lines.join('\n'));
      const root = join(t.base, 'agentic-ap', S.scratchRootName(r.run.run_id));
      deepStrictEqual(r.run.scratch.deferred, [{ dir: join(root, 's1'), why: 'the step\'s process group outlived SIGKILL' }]);
      ok(existsSync(join(root, 's1')), 'the held directory stays');
      // The control: a lane step that ended with its group gone left nothing.
      const others = r.steps.filter((s) => s.seq !== 1 && s.tmp_dir);
      ok(others.length >= 1, 'another lane step ran');
      for (const s of others) ok(!existsSync(s.tmp_dir), `step ${s.seq}'s directory is gone`);
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('workerEnv', () => {
  it('sets the step\'s TMPDIR in place of the driver\'s, and leaves it alone with none', () => {
    const roots = { orchestrator: '/o', engineer: '/e', runtime: '/r' };
    strictEqual(W.workerEnv({ TMPDIR: '/driver' }, { runId: RUN, roots, tmpDir: '/steps/s1' }).TMPDIR, '/steps/s1');
    strictEqual(W.workerEnv({ TMPDIR: '/driver' }, { runId: RUN, roots }).TMPDIR, '/driver');
    strictEqual(W.workerEnv({ TMPDIR: '/driver' }, { runId: RUN, roots, tmpDir: '' }).TMPDIR, '/driver');
  });
});
