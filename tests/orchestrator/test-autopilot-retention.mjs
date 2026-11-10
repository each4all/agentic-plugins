// tests/orchestrator/test-autopilot-retention.mjs
//
// ADR-0068, amendment of 2026-11-10 (C175) — the cap on what a checkout's old
// runs keep (plugins/orchestrator/adapters/claude/autopilot/retention.mjs):
// only a run's bulk goes (worker streams, verification logs), only beyond
// both floors, never from a run that may be in use, and never from a run a
// workflow names (its streams stay with its logs). Runs are laid out by hand in a scratch
// repository; every reader of a trimmed run still answers.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const R = await import(join(AP, 'retention.mjs'));
const L = await import(join(AP, 'ledger.mjs'));
const S = await import(join(AP, 'scratch.mjs'));
const C = await import(join(AP, 'cli.mjs'));

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-10T00:00:00Z');
const now = () => NOW;
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && !k.startsWith('AGENTIC_')));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...GIT_ENV, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim();
// Run ids in order: the stamp's day, then a suffix.
const idOf = (n) => `autopilot-202610${String(n).padStart(2, '0')}T000000Z-${String(n).padStart(6, '0')}`;

function place(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'retention-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), '.agentic-plugins/\n');
  git(repo, 'add', '.gitignore');
  git(repo, 'commit', '-q', '-m', 'init');
  return { dir, repo };
}

// A run as its driver left it: the records, two worker streams, one batch's log.
function layRun(repo, runId, { status = 'halted', endedDaysAgo = 30, bulk = true } = {}) {
  const dir = join(repo, '.agentic-plugins/runs/autopilot', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), `${JSON.stringify({ run_id: runId, status, started_at: new Date(NOW - endedDaysAgo * DAY - 1000).toISOString(), ended_at: status === 'running' ? null : new Date(NOW - endedDaysAgo * DAY).toISOString(), steps: 1, cost_usd: 1 })}\n`);
  writeFileSync(join(dir, 'steps.jsonl'), `${JSON.stringify({ event: 'started', seq: 1, kind: 'dispatch', subtask_id: 'A', session_id: 's-1' })}\n${JSON.stringify({ event: 'finished', seq: 1, outcome: 'ok' })}\n`);
  writeFileSync(join(dir, 'halt.json'), '{"reason":"awaiting-landing"}\n');
  if (bulk) {
    writeFileSync(join(dir, 'worker-1.jsonl'), 'x'.repeat(1000));
    writeFileSync(join(dir, 'worker-2.jsonl'), 'y'.repeat(500));
    mkdirSync(join(dir, 'verify', `${runId}-s2-abc123`), { recursive: true });
    writeFileSync(join(dir, 'verify', `${runId}-s2-abc123`, '0.log'), 'z'.repeat(250));
  }
  return dir;
}
const filesOf = (dir) => readdirSync(dir).sort();
const WHOLE = ['halt.json', 'run.json', 'steps.jsonl', 'verify', 'worker-1.jsonl', 'worker-2.jsonl'];
const TRIMMED = ['halt.json', 'run.json', 'steps.jsonl'];
const apply = (p, o = {}) => R.applyRetention({ repoRoot: p.repo, mainRoot: p.repo, now, keepRuns: 2, ...o });
const plan = (p, o = {}) => R.planRetention({ repoRoot: p.repo, mainRoot: p.repo, now, keepRuns: 2, ...o });

describe('which runs are trimmed', () => {
  it('only an ended run beyond both floors: not among the newest, and ended long enough ago', async (t) => {
    const p = place(t);
    const dirs = {};
    for (const n of [1, 2, 3, 4, 5]) dirs[n] = layRun(p.repo, idOf(n), { endedDaysAgo: n === 2 ? 3 : 30, status: n === 1 ? 'completed' : n === 3 ? 'error' : 'halted' });
    const before = plan(p);
    deepStrictEqual(before.runs.map((r) => [r.run_id, r.action, r.why]), [
      [idOf(1), 'trim', null],
      [idOf(2), 'keep', 'it ended within 14 days'],
      [idOf(3), 'trim', null],
      [idOf(4), 'keep', 'it is among the newest 2 ended runs'],
      [idOf(5), 'keep', 'it is among the newest 2 ended runs'],
    ]);
    strictEqual(before.runs[0].bytes, 1750);
    for (const n of [1, 2, 3, 4, 5]) deepStrictEqual(filesOf(dirs[n]), WHOLE, 'a plan changes nothing');
    const r = await apply(p);
    deepStrictEqual([r.ok, r.busy, r.trimmed, r.kept, r.failures], [true, false, [{ run_id: idOf(1), bytes: 1750 }, { run_id: idOf(3), bytes: 1750 }], 3, []]);
    deepStrictEqual([1, 2, 3, 4, 5].map((n) => filesOf(dirs[n])), [TRIMMED, WHOLE, TRIMMED, WHOLE, WHOLE]);
    // Every reader of a trimmed run still answers.
    const read = L.readRun(p.repo, idOf(1));
    deepStrictEqual([read.run.status, read.steps.map((s) => [s.seq, s.outcome, s.session_id]), read.halt.reason], ['completed', [[1, 'ok', 's-1']], 'awaiting-landing']);
    deepStrictEqual([read.run.retention.trimmed_at, read.run.retention.bytes, read.run.retention.verify_kept], ['2026-11-10T00:00:00.000Z', 1750, false]);
    deepStrictEqual(L.listRuns(p.repo), [1, 2, 3, 4, 5].map(idOf));
    ok(!existsSync(join(p.repo, '.agentic-plugins/runs/autopilot/retention.lock')), 'the lock is gone');
    // A second pass finds nothing left.
    deepStrictEqual((await apply(p)).trimmed, []);
    strictEqual(plan(p).runs[0].why, 'it was trimmed before');
  });

  it('never a run that may be in use: running, draining, with an open-run record, a cleanup lock or a temporary root, or one whose run.json does not read', async (t) => {
    const p = place(t);
    const ids = [1, 2, 3, 4, 5, 6, 7].map(idOf);
    const dirs = ids.map((id, i) => layRun(p.repo, id, { status: i === 0 ? 'running' : i === 1 ? 'draining' : 'halted' }));
    for (const n of [20, 21]) layRun(p.repo, idOf(n), { endedDaysAgo: 1 });
    L.writeOpenRun(p.repo, { runId: ids[2], macroId: null, checkout: p.repo, runDir: dirs[2], pid: 1, fingerprint: null, startedAt: 'x' });
    mkdirSync(join(L.openRunsDir(p.repo), `${ids[3]}.cleanup.lock`), { recursive: true });
    mkdirSync(S.scratchIndexDir(p.repo), { recursive: true });
    writeFileSync(join(S.scratchIndexDir(p.repo), `${ids[4]}.json`), '{}');
    writeFileSync(join(dirs[5], 'run.json'), '{not json');
    const r = await apply(p);
    deepStrictEqual(r.trimmed.map((x) => x.run_id), [ids[6]], 'the control: a plain old ended run is trimmed');
    deepStrictEqual(dirs.map(filesOf), [WHOLE, WHOLE, WHOLE, WHOLE, WHOLE, WHOLE, TRIMMED]);
    deepStrictEqual(plan(p).runs.slice(0, 6).map((x) => x.why), [
      'it is running', 'it is draining', 'it has an open-run record', 'a cleanup of it holds its lock', 'its temporary root is not gone yet', 'its run.json does not read',
    ]);
  });

  it('never a run directory that is a link: another place\'s run is not this checkout\'s to trim', async (t) => {
    const p = place(t);
    const dir = layRun(p.repo, idOf(1));
    for (const n of [20, 21]) layRun(p.repo, idOf(n), { endedDaysAgo: 1 });
    const elsewhere = join(p.dir, 'elsewhere');
    renameSync(dir, elsewhere);
    symlinkSync(elsewhere, dir);
    deepStrictEqual((await apply(p)).trimmed, []);
    strictEqual(plan(p).runs[0].why, 'its directory is a link, or not a directory');
    deepStrictEqual(filesOf(elsewhere), WHOLE);
  });

  for (const [what, rel] of [['the ledger', '.agentic-plugins/runs/autopilot'], ['a directory above the ledger', '.agentic-plugins/runs']]) {
    it(`never a run reached through a link above it: ${what} that is a link holds another place's runs`, async (t) => {
      const p = place(t);
      const dir = layRun(p.repo, idOf(1));
      for (const n of [20, 21]) layRun(p.repo, idOf(n), { endedDaysAgo: 1 });
      // The control: the same run, reached through no link, is one to trim.
      deepStrictEqual(plan(p).runs.map((r) => r.action), ['trim', 'keep', 'keep']);
      const elsewhere = join(p.dir, 'elsewhere');
      renameSync(join(p.repo, rel), elsewhere);
      symlinkSync(elsewhere, join(p.repo, rel));
      deepStrictEqual(filesOf(dir), WHOLE, 'the run still reads through the link');
      const r = await apply(p);
      deepStrictEqual([r.trimmed, r.failures], [[], []]);
      deepStrictEqual(plan(p).runs.map((x) => x.why), Array(3).fill('its directory is a link, or not a directory'));
      deepStrictEqual(filesOf(dir), WHOLE);
    });
  }

  it('a run taken up between the plan and its trim is left whole', async (t) => {
    const p = place(t);
    const dir = layRun(p.repo, idOf(1));
    for (const n of [20, 21]) layRun(p.repo, idOf(n), { endedDaysAgo: 1 });
    // A cleanup takes the run after the plan: the judgment just before the
    // files go reads its lock.
    const planned = [];
    const r = await apply(p, { hooks: { afterPlan: (pl) => {
      planned.push(...pl.runs.filter((x) => x.action === 'trim').map((x) => x.run_id));
      mkdirSync(join(L.openRunsDir(p.repo), `${idOf(1)}.cleanup.lock`), { recursive: true });
    } } });
    deepStrictEqual(planned, [idOf(1)], 'control: the plan named it');
    deepStrictEqual([r.trimmed, r.kept, r.failures], [[], 3, []]);
    deepStrictEqual(filesOf(dir), WHOLE);
  });
});

describe('citations keep a run whole', () => {
  const wfDir = (repo) => join(repo, '.agentic-plugins/state/engineer/workflows');
  function old(p) {
    const dirs = [1, 2, 3, 4].map((n) => layRun(p.repo, idOf(n)));
    for (const n of [20, 21]) layRun(p.repo, idOf(n), { endedDaysAgo: 1 });
    return dirs;
  }
  it('an active workflow, a workflow archived within the floor and a journal of an active workflow each keep whole the runs they name: their worker streams with their logs', async (t) => {
    const p = place(t);
    const dirs = old(p);
    mkdirSync(wfDir(p.repo), { recursive: true });
    writeFileSync(join(wfDir(p.repo), 'compose-20261101T000000Z-aaaaaa.md'), `---\nverify_request: "{\\"run_id\\":\\"${idOf(1)}\\",\\"step\\":2}"\n---\n`);
    const archive = join(p.repo, '.agentic-plugins/state/engineer/archive');
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'compose-20261001T000000Z-bbbbbb.md'), `carried_from ${idOf(2)}\n`);
    const stale = join(archive, 'compose-20260901T000000Z-cccccc.md');
    writeFileSync(stale, `carried_from ${idOf(4)}\n`);
    utimesSync(stale, new Date(NOW - 40 * DAY), new Date(NOW - 40 * DAY));
    writeFileSync(join(archive, 'compose-20261001T000000Z-bbbbbb.md'), `carried_from ${idOf(2)}\n`);
    utimesSync(join(archive, 'compose-20261001T000000Z-bbbbbb.md'), new Date(NOW - DAY), new Date(NOW - DAY));
    const journal = join(p.repo, '.agentic-plugins/state/orchestrator/verify-journal');
    mkdirSync(journal, { recursive: true });
    const j = join(journal, 'compose-20261101T000000Z-aaaaaa.jsonl');
    writeFileSync(j, `${JSON.stringify({ op: 'start', payload: { run_id: idOf(3) } })}\n`);
    utimesSync(j, new Date(NOW - 40 * DAY), new Date(NOW - 40 * DAY));
    utimesSync(join(wfDir(p.repo), 'compose-20261101T000000Z-aaaaaa.md'), new Date(NOW - 40 * DAY), new Date(NOW - 40 * DAY));
    const cited = R.citedRuns({ repoRoot: p.repo, mainRoot: p.repo, now });
    deepStrictEqual([cited.ok, [...cited.cited].sort()], [true, [idOf(1), idOf(2), idOf(3)]]);
    deepStrictEqual(plan(p).runs.slice(0, 4).map((x) => [x.action, x.why]), [
      ['keep', 'a workflow names the run'], ['keep', 'a workflow names the run'], ['keep', 'a workflow names the run'], ['trim', null],
    ]);
    const r = await apply(p);
    deepStrictEqual(r.trimmed.map((x) => [x.run_id, x.bytes]), [[idOf(4), 1750]], 'the control: the run only a stale archive names is trimmed');
    deepStrictEqual(dirs.map(filesOf), [WHOLE, WHOLE, WHOLE, TRIMMED]);
    strictEqual(L.readRun(p.repo, idOf(1)).run.retention, undefined, 'a cited run records no trim');
    ok(existsSync(join(dirs[0], 'verify', `${idOf(1)}-s2-abc123`, '0.log')), 'the log a workflow\'s results point at still reads');
    strictEqual(readFileSync(join(dirs[0], 'worker-1.jsonl'), 'utf8').length, 1000, 'and so does the stream of the step that asked for it');
  });

  it('a cited run with no verification logs keeps its worker streams too', async (t) => {
    const p = place(t);
    const dirs = old(p);
    for (const d of dirs) rmSync(join(d, 'verify'), { recursive: true });
    mkdirSync(wfDir(p.repo), { recursive: true });
    writeFileSync(join(wfDir(p.repo), 'compose-20261101T000000Z-aaaaaa.md'), `names ${idOf(1)}\n`);
    const STREAMS = ['halt.json', 'run.json', 'steps.jsonl', 'worker-1.jsonl', 'worker-2.jsonl'];
    deepStrictEqual((await apply(p)).trimmed.map((x) => x.run_id), [idOf(2), idOf(3), idOf(4)]);
    deepStrictEqual(dirs.map(filesOf), [STREAMS, TRIMMED, TRIMMED, TRIMMED]);
  });

  it('a workflow home that does not read keeps every run past the floors whole', async (t) => {
    const p = place(t);
    const dirs = old(p);
    // A file in the workflows directory's place: not absence, so not empty.
    mkdirSync(join(p.repo, '.agentic-plugins/state/engineer'), { recursive: true });
    writeFileSync(wfDir(p.repo), '');
    const cited = R.citedRuns({ repoRoot: p.repo, mainRoot: p.repo, now });
    strictEqual(cited.ok, false);
    match(cited.problem, /does not read \(ENOTDIR\)/);
    const r = await apply(p);
    deepStrictEqual([r.citations.ok, r.trimmed, r.failures], [false, [], []]);
    deepStrictEqual(dirs.map(filesOf), [WHOLE, WHOLE, WHOLE, WHOLE]);
    deepStrictEqual(plan(p).runs.slice(0, 4).map((x) => [x.action, x.why]), Array(4).fill(['keep', 'citations do not read: a workflow or journal does not read (ENOTDIR)']));
    match(R.describeApplied(r), /^retention: ⚠ every run past the floors is kept whole: a workflow or journal does not read/);
    match(R.describePlan(plan(p)).at(-1), /^⚠ every run past the floors is kept whole: /);
    // The control: the same runs, with the home readable, are trimmed.
    rmSync(wfDir(p.repo));
    deepStrictEqual((await apply(p)).trimmed.length, 4);
  });

  it('a workflow that is a link to a file is read through it, with the journal its frontmatter id names; anything else in a workflow\'s place keeps every run', async (t) => {
    const p = place(t);
    const dirs = old(p);
    mkdirSync(wfDir(p.repo), { recursive: true });
    const target = join(p.dir, 'kept-elsewhere.md');
    writeFileSync(target, `---\nworkflow_id: "compose-20261101T000000Z-eeeeee"\nverify_request: "${idOf(1)}"\n---\n`);
    symlinkSync(target, join(wfDir(p.repo), 'renamed.md'));
    const journal = join(p.repo, '.agentic-plugins/state/orchestrator/verify-journal');
    mkdirSync(journal, { recursive: true });
    const j = join(journal, 'compose-20261101T000000Z-eeeeee.jsonl');
    writeFileSync(j, `${JSON.stringify({ op: 'start', payload: { run_id: idOf(2) } })}\n`);
    utimesSync(j, new Date(NOW - 40 * DAY), new Date(NOW - 40 * DAY));
    deepStrictEqual([...R.citedRuns({ repoRoot: p.repo, mainRoot: p.repo, now }).cited].sort(), [idOf(1), idOf(2)]);
    await apply(p);
    deepStrictEqual(dirs.map(filesOf), [WHOLE, WHOLE, TRIMMED, TRIMMED]);
    // A FIFO where a workflow would be: not read, and not passed over.
    execFileSync('mkfifo', [join(wfDir(p.repo), 'compose-20261101T000000Z-ffffff.md')]);
    const cited = R.citedRuns({ repoRoot: p.repo, mainRoot: p.repo, now });
    deepStrictEqual([cited.ok, cited.problem], [false, 'a workflow or journal does not read (ENOTFILE)']);
  });

  it('a linked checkout\'s workflows count too', async (t) => {
    const p = place(t);
    const dirs = old(p);
    const lane = join(p.dir, 'lane');
    git(p.repo, 'worktree', 'add', '-q', '-b', 'lane', lane);
    mkdirSync(wfDir(lane), { recursive: true });
    writeFileSync(join(wfDir(lane), 'refine-20261101T000000Z-dddddd.md'), `batch of ${idOf(2)}\n`);
    await apply(p);
    deepStrictEqual(dirs.map(filesOf), [TRIMMED, WHOLE, TRIMMED, TRIMMED]);
  });
});

describe('one retention at a time, and a pass a crash interrupted', () => {
  it('a second retention while one holds the lock does nothing', async (t) => {
    const p = place(t);
    layRun(p.repo, idOf(1));
    for (const n of [20, 21]) layRun(p.repo, idOf(n), { endedDaysAgo: 1 });
    let second = null;
    const first = await apply(p, { hooks: { beforeTrim: async () => { second = await apply(p); } } });
    deepStrictEqual([second.busy, second.trimmed], [true, []]);
    deepStrictEqual(first.trimmed.map((x) => x.run_id), [idOf(1)]);
  });

  it('what was renamed and not removed is finished by the next pass, whatever the floors say then', async (t) => {
    const p = place(t);
    const dir = layRun(p.repo, idOf(1));
    for (const n of [20, 21]) layRun(p.repo, idOf(n), { endedDaysAgo: 1 });
    const crashed = await apply(p, { hooks: { afterRename: () => { throw new Error('crashed'); } } });
    deepStrictEqual([crashed.ok, crashed.failures.map((f) => f.error)], [false, ['crashed']]);
    deepStrictEqual(filesOf(dir), ['.removing-worker-1.jsonl', 'halt.json', 'run.json', 'steps.jsonl', 'verify', 'worker-2.jsonl']);
    // The floors now keep it (every run is among the newest): the leftover goes, and nothing else.
    const r = await apply(p, { keepRuns: 10 });
    deepStrictEqual(r.trimmed.map((x) => x.run_id), [idOf(1)]);
    deepStrictEqual(filesOf(dir), ['halt.json', 'run.json', 'steps.jsonl', 'verify', 'worker-2.jsonl']);
    // A name that only looks like a leftover is no bulk of the run's.
    writeFileSync(join(dir, '.removing-run.json'), '');
    deepStrictEqual((await apply(p, { keepRuns: 10 })).trimmed, []);
    ok(existsSync(join(dir, '.removing-run.json')));
  });

  it('a leftover of a run a workflow names since is finished, and nothing else of the run goes (the amendment\'s limit)', async (t) => {
    const p = place(t);
    const dir = layRun(p.repo, idOf(1));
    for (const n of [20, 21]) layRun(p.repo, idOf(n), { endedDaysAgo: 1 });
    await apply(p, { hooks: { afterRename: () => { throw new Error('crashed'); } } });
    const wf = join(p.repo, '.agentic-plugins/state/engineer/workflows');
    mkdirSync(wf, { recursive: true });
    writeFileSync(join(wf, 'compose-20261101T000000Z-aaaaaa.md'), `names ${idOf(1)}\n`);
    deepStrictEqual(plan(p).runs[0].why, 'finishing an interrupted trim (a workflow names the run)');
    deepStrictEqual((await apply(p)).trimmed.map((x) => x.run_id), [idOf(1)]);
    deepStrictEqual(filesOf(dir), ['halt.json', 'run.json', 'steps.jsonl', 'verify', 'worker-2.jsonl']);
  });
});

describe('the retention command', () => {
  it('shows what would go and changes nothing; --execute sweeps what earlier runs left in their temporary roots, then trims; a root not proven its run\'s fails the command', async (t) => {
    const p = place(t);
    const ids = Array.from({ length: 22 }, (_, i) => idOf(i + 1));
    const dirs = ids.map((id) => layRun(p.repo, id));
    // A dead run's temporary root, on the index (a pid no process has).
    const base = join(p.dir, 'tmp');
    mkdirSync(base);
    const scratchEnv = { ...GIT_ENV, TMPDIR: base };
    const left = await S.allocateScratch({ repoRoot: p.repo, mainRoot: p.repo, runId: ids[0], env: scratchEnv, pid: 2 ** 22 + 12345 });
    mkdirSync(join(left.root, 's1', 'agentic-text.x'), { recursive: true });
    const lines = [];
    const io = { out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`), env: GIT_ENV, now };
    strictEqual(await C.retentionCmd({ execute: false }, p.repo, io), 0);
    deepStrictEqual(lines.slice(0, 4), [
      `temporary files of run ${ids[0]}: ${left.root}`,
      `kept ${ids[0]}: its temporary root is not gone yet`,
      `would trim ${ids[1]}: 3 items, 0.0 MB`,
      `kept ${ids[2]}: it is among the newest 20 ended runs`,
    ]);
    strictEqual(lines.at(-1), 'Nothing was changed. Run with --execute to trim.');
    deepStrictEqual(filesOf(dirs[1]), WHOLE);
    ok(existsSync(join(left.root, 's1')), 'the dry run removed nothing');
    lines.length = 0;
    strictEqual(await C.retentionCmd({ execute: true }, p.repo, io), 0);
    deepStrictEqual(lines, [`temporary files of run ${ids[0]}: removed ${left.root}`, `trimmed ${ids[0]}: 0.0 MB`, `trimmed ${ids[1]}: 0.0 MB`, '2 runs trimmed, 20 kept']);
    ok(!existsSync(left.root));
    deepStrictEqual([filesOf(dirs[0]), filesOf(dirs[1]), filesOf(dirs[2])], [TRIMMED, TRIMMED, WHOLE]);
    // A root that is not proven its run's is the owner's to look at: exit 1.
    const wrong = await S.allocateScratch({ repoRoot: p.repo, mainRoot: p.repo, runId: ids[1], env: scratchEnv, pid: 2 ** 22 + 12345 });
    mkdirSync(join(wrong.root, 's1'));
    writeFileSync(join(wrong.root, S.SCRATCH_MARKER), '{}');
    lines.length = 0;
    strictEqual(await C.retentionCmd({ execute: true }, p.repo, io), 1);
    match(lines[0], /is not proven that run's \(marker-of-another-run\)/);
    ok(existsSync(join(wrong.root, 's1')));
  });

  it('a step of an autopilot run never trims', async (t) => {
    const p = place(t);
    const lines = [];
    const code = await C.main(['retention', '--execute', '--repo', p.repo], { env: { ...GIT_ENV, AGENTIC_AUTOPILOT: idOf(1) }, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`) });
    strictEqual(code, 1);
    match(lines.join('\n'), /a step of an autopilot run never trims the runs' records/);
  });
});
