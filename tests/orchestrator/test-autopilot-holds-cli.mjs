// tests/orchestrator/test-autopilot-holds-cli.mjs
//
// ADR-0068 Decision 2 (impl-hold) — the owner's hold commands through
// `agentic-autopilot` (cli.mjs, holds-cli.mjs): hold, release --hold, the bare
// release beside a hold, --discard-unreadable, writer-clear and the
// macro-scoped status; each refusal, with or without a live run.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeRepo, ORCH, ENG, RUNTIME } from './fixtures/autopilot-repo.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const C = await import(pathToFileURL(join(AP, 'cli.mjs')).href);
const PK = await import(pathToFileURL(join(AP, 'parks.mjs')).href);
const H = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/holds.mjs')).href);
const RL = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/run-locks.mjs')).href);
const OPS = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/hold-ops.mjs')).href);
const HCLI = await import(pathToFileURL(join(AP, 'holds-cli.mjs')).href);

function fakeEngineer(dir) {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'state.mjs'), "if (process.argv[2] === 'hold-capability') console.log(JSON.stringify({ capability: 'hold-persona-1', protocol: 1 })); else process.exit(2);\n");
}

async function withRepo(fn, { caches = true } = {}) {
  const fx = await makeRepo({ subtasks: [{ id: 'A' }, { id: 'B', blocked_by: ['A'] }] });
  const home = join(fx.dir, 'home');
  mkdirSync(home);
  if (caches) {
    fakeEngineer(join(home, '.claude/plugins/cache/agentic-plugins/engineer/0.33.0'));
    fakeEngineer(join(home, '.codex/plugins/cache/agentic-plugins/engineer/0.33.0'));
  }
  const env = { ...fx.env, HOME: home, AGENTIC_ORCHESTRATOR_ROOT: ORCH, AGENTIC_ENGINEER_ROOT: ENG, AGENTIC_RUNTIME_ROOT: RUNTIME };
  delete env.AGENTIC_AUTOPILOT;
  delete env.CODEX_HOME;
  try { return await fn(fx, env, realpathSync(fx.work)); } finally { fx.cleanup(); }
}
async function run(argv, env, work) {
  const out = [];
  const err = [];
  const code = await C.main([...argv, '--repo', work], { env, io: { stdin: { isTTY: false } }, out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const holdIdOf = (text) => /hold ([0-9a-f]{16})/.exec(text)?.[1];

describe('agentic-autopilot hold and release', () => {
  it('hold with no run and no lane: handed over at once, unfenced and warned; status shows it from the macro; release --hold names it', () => withRepo(async (fx, env, work) => {
    const h = await run(['hold', 'A', '--macro', fx.macroId], env, work);
    strictEqual(h.code, 0, h.err);
    const id = holdIdOf(h.out);
    ok(id, h.out);
    ok(/\(held\)/.test(h.out) && /has no lane yet.*rolling the orchestrator back below this release while a hold exists is unsupported/s.test(h.out), h.out);
    ok(h.out.includes(`agentic-autopilot release A --macro ${fx.macroId} --hold ${id}`), h.out);
    ok(/hold-persona-1/.test(h.out), 'names the engineer the person needs');
    strictEqual(H.readActivation(work, fx.macroId).state, 'active', 'the marker went up before the record');
    const s = await run(['status', '--macro', fx.macroId], env, work);
    ok(s.out.includes(`A: held (hold ${id})`), s.out);
    const again = await run(['hold', 'A', '--macro', fx.macroId], env, work);
    ok(again.code === 1 && /already held/.test(again.err), again.err);
    const wrong = await run(['release', 'A', '--macro', fx.macroId, '--hold', 'f'.repeat(16)], env, work);
    ok(wrong.code === 1 && /names the hold it ends/.test(wrong.err), wrong.err);
    const rel = await run(['release', 'A', '--macro', fx.macroId, '--hold', id], env, work);
    strictEqual(rel.code, 0, rel.err);
    ok(/stop editing and close the session first/.test(rel.out), rel.out);
    strictEqual(H.holdStateOf(work, fx.macroId, 'A').state, 'released-uncompared');
    deepStrictEqual(H.readHoldEvents(work, fx.macroId).map((e) => e.event), ['held', 'released']);
  }));

  it('refuses a worker of a run, a completed or unknown subtask, and a persona not installed on both hosts', () => withRepo(async (fx, env, work) => {
    for (const argv of [['hold', 'A'], ['release', 'A', '--hold', 'a'.repeat(16)], ['writer-clear', 'A', '--operation', 'op-20261026T000000Z-00000000']]) {
      const r = await run([...argv, '--macro', fx.macroId], { ...env, AGENTIC_AUTOPILOT: 'autopilot-20261026T000000Z-000001' }, work);
      ok(r.code === 1 && /never (holds|releases|clears)/.test(r.err), `${argv[0]}: ${r.err}`);
    }
    const unknown = await run(['hold', 'Z', '--macro', fx.macroId], env, work);
    ok(unknown.code === 1 && /not in macro/.test(unknown.err), unknown.err);
    const noCaches = await withRepo(async (fx2, env2, work2) => run(['hold', 'A', '--macro', fx2.macroId], env2, work2), { caches: false });
    ok(noCaches.code === 1 && /Claude Code: no engineer is installed/.test(noCaches.err) && /Codex CLI/.test(noCaches.err), noCaches.err);
  }));

  it('refuses a subtask the plan closed (deferred, abandoned) and a macro that ended (ADR-0068 Decision 2, item 8)', () => withRepo(async (fx, env, work) => {
    await fx.orch.bulkSubtaskStatus({ workflowPath: fx.macroPath, host: 'claude', fromStatuses: ['blocked'], toStatus: 'deferred' });
    const deferred = await run(['hold', 'B', '--macro', fx.macroId], env, work);
    strictEqual(deferred.code, 1);
    ok(/subtask B is deferred: there is nothing to hold/.test(deferred.err), deferred.err);
    await fx.orch.setMacroTerminal({ workflowPath: fx.macroPath, host: 'claude', terminalPhase: 'finalized', terminalMarker: true, nextAction: 'archive' });
    const ended = await run(['hold', 'A', '--macro', fx.macroId], env, work);
    strictEqual(ended.code, 1);
    ok(new RegExp(`macro ${fx.macroId} has ended \\(current_phase finalized\\): there is nothing to hold`).test(ended.err), ended.err);
    strictEqual(H.readOwnerHold(work, fx.macroId, 'A').state, 'absent', 'nothing held');
  }));

  it('refuses beside a live run that does not honour holds', () => withRepo(async (fx, env, work) => {
    const lock = RL.macroLockPath(work, fx.macroId);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, `h-${process.pid}-abcdef.json`), JSON.stringify({ kind: 'run', run_id: 'autopilot-20261026T000000Z-000009', pid: process.pid, fingerprint: await RL.processFingerprint(process.pid), worker: null }));
    const r = await run(['hold', 'A', '--macro', fx.macroId], env, work);
    ok(r.code === 1 && /is live and does not honour holds.*stop --macro/.test(r.err), r.err);
    deepStrictEqual(H.listRecordIds(work, fx.macroId, 'holds').ids, []);
    strictEqual(H.readActivation(work, fx.macroId).state, 'inactive', 'refused at the first look, before anything is written');
  }));

  it("names the lane's last session of this macro, the latest started, never another macro's subtask of the same id (item 5)", () => withRepo(async (fx, env, work) => {
    const LN = await import(pathToFileURL(join(AP, 'lanes.mjs')).href);
    const lane = LN.lanePath(LN.laneHome(work), fx.macroId, 'A');
    // The lane a run left: a worktree holding the subtask's branch.
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['-C', work, 'worktree', 'add', '-q', '-b', 'feat/a', lane], { env: fx.env, stdio: 'ignore' });
    const runs = join(work, '.agentic-plugins/runs/autopilot');
    const ledger = (run, macroId, steps) => {
      mkdirSync(join(runs, run), { recursive: true });
      writeFileSync(join(runs, run, 'run.json'), JSON.stringify({ run_id: run, macro_id: macroId }));
      writeFileSync(join(runs, run, 'steps.jsonl'), steps.map((s) => JSON.stringify({ event: 'started', subtask_id: 'A', ...s })).join('\n'));
    };
    ledger('autopilot-20261026T000000Z-000001', fx.macroId, [
      { session_id: 'mine-old', cwd: lane, started_at: '2026-10-26T00:00:01Z' },
      { session_id: 'mine-new', cwd: lane, started_at: '2026-10-26T00:05:00Z' },
    ]);
    // A later run of another macro, its own subtask A, in its own lane.
    ledger('autopilot-20261026T010000Z-000002', 'macro-plan-20261026T000000Z-0ther0', [
      { session_id: 'theirs', cwd: '/elsewhere/A', started_at: '2026-10-26T01:00:00Z' },
    ]);
    const h = await run(['hold', 'A', '--macro', fx.macroId], env, work);
    strictEqual(h.code, 0, h.err);
    ok(h.out.includes(`its last session: claude --resume mine-new (worked in ${lane})`), h.out);
    ok(!h.out.includes('theirs'), h.out);
  }));

  it('beside a live hold-aware run, hold leaves the handoff to it', () => withRepo(async (fx, env, work) => {
    const lock = RL.macroLockPath(work, fx.macroId);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, `h-${process.pid}-abcdef.json`), JSON.stringify({ kind: 'run', run_id: 'autopilot-20261026T000000Z-000009', pid: process.pid, fingerprint: await RL.processFingerprint(process.pid), worker: null, capabilities: ['holds-1'], lanes: 2 }));
    const r = await run(['hold', 'A', '--macro', fx.macroId], env, work);
    strictEqual(r.code, 0, r.err);
    ok(/\(pending\)/.test(r.out) && /completes the handoff/.test(r.out), r.out);
    strictEqual(H.holdStateOf(work, fx.macroId, 'A').state, 'pending');
  }));
});

describe('the bare release beside a hold', () => {
  it('refuses a held lane, an uncompared release and a rejected one, and a subtask neither held nor parked', () => withRepo(async (fx, env, work) => {
    const none = await run(['release', 'A', '--macro', fx.macroId], env, work);
    ok(none.code === 1 && /neither held nor parked/.test(none.err), none.err);
    const id = holdIdOf((await run(['hold', 'A', '--macro', fx.macroId], env, work)).out);
    let r = await run(['release', 'A', '--macro', fx.macroId], env, work);
    ok(r.code === 1 && /a bare release refuses on a held lane/.test(r.err) && r.err.includes(`--hold ${id}`), r.err);
    await run(['release', 'A', '--macro', fx.macroId, '--hold', id], env, work);
    r = await run(['release', 'A', '--macro', fx.macroId], env, work);
    ok(r.code === 1 && /has not been compared/.test(r.err), r.err);
    const rel = H.readRecord(work, fx.macroId, 'releases', 'A');
    H.writeWhole(rel.path, { ...rel.record, state: 'rejected' });
    r = await run(['release', 'A', '--macro', fx.macroId], env, work);
    ok(r.code === 1 && /rejected/.test(r.err) && /hold and release it again/.test(r.err), r.err);
  }));

  it('never deletes a park it cannot read: it points at --discard-unreadable, which keeps a copy', () => withRepo(async (fx, env, work) => {
    mkdirSync(PK.parksDir(work, fx.macroId), { recursive: true });
    writeFileSync(PK.parkPath(work, fx.macroId, 'A'), '{torn');
    const r = await run(['release', 'A', '--macro', fx.macroId], env, work);
    ok(r.code === 1 && /--discard-unreadable/.test(r.err), r.err);
    strictEqual(readFileSync(PK.parkPath(work, fx.macroId, 'A'), 'utf8'), '{torn');
    const d = await run(['release', 'A', '--macro', fx.macroId, '--discard-unreadable'], env, work);
    strictEqual(d.code, 0, d.err);
    deepStrictEqual(PK.readPark(work, fx.macroId, 'A'), { state: 'absent' });
    const copies = readdirSync(H.discardedDir(work, fx.macroId));
    strictEqual(copies.length, 1);
    strictEqual(readFileSync(join(H.discardedDir(work, fx.macroId), copies[0]), 'utf8'), '{torn');
  }));

  it('a discarded owner\'s record becomes a new hold on the plan\'s branch, so the lane is never given back unguarded', () => withRepo(async (fx, env, work) => {
    await run(['hold', 'A', '--macro', fx.macroId], env, work);
    writeFileSync(H.recordPath(work, fx.macroId, 'holds', 'A'), '{');
    const refused = await run(['hold', 'A', '--macro', fx.macroId], env, work);
    ok(refused.code === 1 && /cannot be read.*--discard-unreadable/.test(refused.err), refused.err);
    const d = await run(['release', 'A', '--macro', fx.macroId, '--discard-unreadable'], env, work);
    strictEqual(d.code, 0, d.err);
    const owner = H.readOwnerHold(work, fx.macroId, 'A');
    deepStrictEqual([owner.state, owner.record.state, owner.record.branch], ['ok', 'held', 'feat/a']);
    strictEqual(H.holdApplies(owner, { branch: 'feat/a' }).applies, true);
  }));
});

describe('the review\'s cases', () => {
  it('a release records the lane\'s real fingerprint, at the park\'s version', () => withRepo(async (fx, env, work) => {
    const id = holdIdOf((await run(['hold', 'A', '--macro', fx.macroId], env, work)).out);
    strictEqual((await run(['release', 'A', '--macro', fx.macroId, '--hold', id], env, work)).code, 0);
    const basis = H.readRecord(work, fx.macroId, 'releases', 'A').record.basis;
    const PO = await import(pathToFileURL(join(AP, 'policy.mjs')).href);
    strictEqual(basis.fingerprint_version, PO.PARK_FINGERPRINT_VERSION);
    ok(/^[0-9a-f]{64}$/.test(basis.fingerprint), JSON.stringify(basis));
  }));

  it('discard never blocks on a FIFO where a park is kept', () => withRepo(async (fx, env, work) => {
    const { execFileSync } = await import('node:child_process');
    mkdirSync(PK.parksDir(work, fx.macroId), { recursive: true });
    execFileSync('mkfifo', [PK.parkPath(work, fx.macroId, 'A')]);
    const d = await run(['release', 'A', '--macro', fx.macroId, '--discard-unreadable'], env, work);
    strictEqual(d.code, 0, d.err);
    strictEqual(existsSync(PK.parkPath(work, fx.macroId, 'A')), false);
  }));

  it('a hold whose second look finds a run that does not honour holds is withdrawn', () => withRepo(async (fx, env, work) => {
    const HC = await import(pathToFileURL(join(AP, 'holds-cli.mjs')).href);
    const lock = RL.macroLockPath(work, fx.macroId);
    const out = [];
    const errs = [];
    const fp = await RL.processFingerprint(process.pid);
    const code = await HC.holdCmd({ macro: fx.macroId, subtask: 'A' }, work, {
      out: (s) => out.push(s), err: (s) => errs.push(s), env, home: env.HOME, engineerRoot: ENG,
      hooks: { afterPublish: () => { mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, `h-${process.pid}-abcdef.json`), JSON.stringify({ kind: 'run', run_id: 'autopilot-20261026T000000Z-000009', pid: process.pid, fingerprint: fp, worker: null })); } },
    });
    strictEqual(code, 1, out.join('\n'));
    ok(/started meanwhile.*withdrawn/.test(errs.join('\n')), errs.join('\n'));
    strictEqual(H.readOwnerHold(work, fx.macroId, 'A').state, 'absent');
  }));

  it('a hold whose second look finds a hold-aware run that started meanwhile leaves the handoff to it, naming it', () => withRepo(async (fx, env, work) => {
    const HC = await import(pathToFileURL(join(AP, 'holds-cli.mjs')).href);
    const lock = RL.macroLockPath(work, fx.macroId);
    const out = [];
    const errs = [];
    const fp = await RL.processFingerprint(process.pid);
    const code = await HC.holdCmd({ macro: fx.macroId, subtask: 'A' }, work, {
      out: (s) => out.push(s), err: (s) => errs.push(s), env, home: env.HOME, engineerRoot: ENG,
      hooks: { afterPublish: () => { mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, `h-${process.pid}-abcdef.json`), JSON.stringify({ kind: 'run', run_id: 'autopilot-20261026T000000Z-00000a', pid: process.pid, fingerprint: fp, worker: null, capabilities: ['holds-1'] })); } },
    });
    strictEqual(code, 0, errs.join('\n'));
    ok(/\(pending\)/.test(out.join('\n')) && /run autopilot-20261026T000000Z-00000a completes the handoff/.test(out.join('\n')), out.join('\n'));
  }));
});

describe('a hold on a subtask with no lane yet (critique round 4, K1)', () => {
  const own = (fx, work) => {
    const mine = join(fx.dir, 'my-work');
    // The person's own worktree for the subtask's branch, anywhere.
    return import('node:child_process').then(({ execFileSync }) => {
      execFileSync('git', ['-C', work, 'worktree', 'add', '-q', '-b', 'feat/a', mine], { env: fx.env, stdio: 'ignore' });
      return realpathSync(mine);
    });
  };

  // The worktree command `hold` prints, run as printed with <path> filled in;
  // a command that fails (a branch that does not exist yet) fails the test.
  const runPrintedAdd = (text, mine, work, env) => {
    const cmd = /worktree of your own \((git worktree add [^)]*)\)/.exec(text)?.[1];
    ok(cmd, text);
    const args = cmd.split(' ').slice(1).map((a) => (a === '<path>' ? mine : a));
    execFileSync('git', ['-C', work, ...args], { env, stdio: 'pipe' });
    return realpathSync(mine);
  };

  it("names a worktree command that works for a branch that already exists (critique round 6, M1)", () => withRepo(async (fx, env, work) => {
    execFileSync('git', ['-C', work, 'branch', 'feat/a', 'refs/remotes/origin/main'], { env: fx.env, stdio: 'ignore' });
    const h = await run(['hold', 'A', '--macro', fx.macroId], env, work);
    strictEqual(h.code, 0, h.err);
    ok(/to work in a worktree of your own \(git worktree add <path> feat\/a\): before the release/.test(h.out), h.out);
    const mine = runPrintedAdd(h.out, join(fx.dir, 'my-work'), work, fx.env);
    strictEqual(execFileSync('git', ['-C', mine, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), 'feat/a');
  }));

  it('records no lane, and a worktree the person then makes for the branch leaves it held: status orphans nothing, the gate still holds', () => withRepo(async (fx, env, work) => {
    const id = holdIdOf((await run(['hold', 'A', '--macro', fx.macroId], env, work)).out);
    ok(id);
    strictEqual(H.readOwnerHold(work, fx.macroId, 'A').record.lane, null, 'never the path a run would create');
    await own(fx, work);
    const s = await run(['status', '--macro', fx.macroId], env, work);
    strictEqual(s.code, 0, s.err);
    ok(s.out.includes(`A: held (hold ${id})`), s.out);
    const owner = H.readOwnerHold(work, fx.macroId, 'A').record;
    strictEqual(owner.orphaned, undefined, JSON.stringify(owner));
    ok(OPS.holdGate({ mainRoot: work, macroId: fx.macroId, subtaskId: 'A' }), 'the persona still sees the hold');
  }));

  // Critique round 5, L1: the person's own worktree has one order back to the
  // run, which hold names and release enforces: commit, remove the worktree,
  // then release. Kept, the run would park the subtask (lanes.mjs row 11);
  // removed after the release, the comparison would find the lane its basis
  // named gone.
  it("a person's own worktree goes back to the run in one stated order: release refuses while it has the branch; committed and removed, the release is consumed", () => withRepo(async (fx, env, work) => {
    const { execFileSync } = await import('node:child_process');
    const h = await run(['hold', 'A', '--macro', fx.macroId], env, work);
    const id = holdIdOf(h.out);
    // Critique round 6, M1: the branch dispatch has not created yet is
    // created from the baseline's tip, and the printed command works as given.
    ok(/to work in a worktree of your own \(git worktree add --no-track -b feat\/a <path> origin\/main\): before the release, commit your work there and remove it/.test(h.out), h.out);
    // Said up front: a subtask not dispatched yet is dispatched at the
    // baseline's tip, or at the tip a consumed release records when it
    // contains the baseline (ADR-0062 Decision 2, amendment of 2026-10-27).
    ok(/subtask A is not dispatched yet: a run dispatches it on feat\/a at origin\/main's tip, or at the tip this hold's release records once the run has compared it equal, when that tip contains origin\/main .*rebased onto origin\/main, before the release/.test(h.out), h.out);
    const mine = runPrintedAdd(h.out, join(fx.dir, 'my-work'), work, fx.env);
    // No upstream: a branch tracking the baseline would point the person's push at it.
    strictEqual(spawnSync('git', ['-C', work, 'config', '--get', 'branch.feat/a.merge'], { env: fx.env, encoding: 'utf8' }).stdout, '', 'the new branch tracks nothing');
    writeFileSync(join(mine, 'person.txt'), 'the work\n');
    const refused = await run(['release', 'A', '--macro', fx.macroId, '--hold', id], env, work);
    strictEqual(refused.code, 1, refused.out);
    ok(refused.err.includes(`checked out in ${mine}, a worktree that is not a run's lane for it`) && refused.err.includes(`git worktree remove ${mine}`), refused.err);
    strictEqual(H.holdStateOf(work, fx.macroId, 'A').state, 'held', 'nothing released');
    strictEqual(H.readRecord(work, fx.macroId, 'releases', 'A').state, 'absent');
    const g = (...a) => execFileSync('git', ['-C', mine, ...a], { env: fx.env, stdio: 'ignore' });
    g('add', 'person.txt');
    g('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'the work');
    execFileSync('git', ['-C', work, 'worktree', 'remove', mine], { env: fx.env, stdio: 'ignore' });
    const rel = await run(['release', 'A', '--macro', fx.macroId, '--hold', id], env, work);
    strictEqual(rel.code, 0, rel.err);
    const ctx = { mainRoot: work, macroId: fx.macroId, subtaskId: 'A', stateRoots: [work] };
    const basisOf = HCLI.basisFor({ engineerRoot: ENG, fingerprintOf: HCLI.releaseFingerprint({ ...ctx, roots: fx.roots, env: fx.env }) });
    strictEqual((await OPS.compareRelease({ ...ctx, basisOf })).verdict, 'consumed');
  }));

  // Critique round 6, M5: with no worktree, the release's basis is the
  // branch's tip, and only the fingerprint covers it (no tree, no child): a
  // commit on the branch after the release is a change the comparison rejects.
  it('a release with no worktree is rejected when the branch moves after it', () => withRepo(async (fx, env, work) => {
    const id = holdIdOf((await run(['hold', 'A', '--macro', fx.macroId], env, work)).out);
    ok(id);
    const git = (...a) => execFileSync('git', ['-C', work, ...a], { env: fx.env, encoding: 'utf8' }).trim();
    git('branch', 'feat/a', 'refs/remotes/origin/main');
    const rel = await run(['release', 'A', '--macro', fx.macroId, '--hold', id], env, work);
    strictEqual(rel.code, 0, rel.err);
    strictEqual(H.readRecord(work, fx.macroId, 'releases', 'A').record.basis.tree_digest, 'no worktree');
    // A commit on the branch after the release, made with no worktree.
    const tip = git('rev-parse', 'refs/heads/feat/a');
    const later = git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'after the release');
    git('update-ref', 'refs/heads/feat/a', later, tip);
    const ctx = { mainRoot: work, macroId: fx.macroId, subtaskId: 'A', stateRoots: [work] };
    const basisOf = HCLI.basisFor({ engineerRoot: ENG, fingerprintOf: HCLI.releaseFingerprint({ ...ctx, roots: fx.roots, env: fx.env }) });
    strictEqual((await OPS.compareRelease({ ...ctx, basisOf })).verdict, 'rejected');
  }));

  // Whose lane a worktree is follows reconciliation's rule (lanes.mjs
  // gatherLaneFacts): the run's lock reason naming the macro and subtask,
  // wherever the worktree is, never its path.
  for (const [name, where, locked, refused] of [
    ["a run's lane, locked with its reason, is not refused", 'canonical', true, false],
    ["a run's lane moved elsewhere, its lock kept, is not refused", 'moved', true, false],
    ['an unlocked worktree at the path a run would use is refused', 'canonical', false, true],
  ]) {
    it(`whose lane it is: ${name}`, () => withRepo(async (fx, env, work) => {
      const { execFileSync } = await import('node:child_process');
      const LN = await import(pathToFileURL(join(AP, 'lanes.mjs')).href);
      const lane = where === 'canonical' ? LN.lanePath(LN.laneHome(work), fx.macroId, 'A') : join(fx.dir, 'moved-lane');
      execFileSync('git', ['-C', work, 'worktree', 'add', '-q', '-b', 'feat/a', lane], { env: fx.env, stdio: 'ignore' });
      if (locked) execFileSync('git', ['-C', work, 'worktree', 'lock', '--reason', LN.lockReason(fx.macroId, 'A'), lane], { env: fx.env, stdio: 'ignore' });
      const h = await run(['hold', 'A', '--macro', fx.macroId], env, work);
      strictEqual(/is not a run's lane/.test(h.out), refused, h.out);
      const rel = await run(['release', 'A', '--macro', fx.macroId, '--hold', holdIdOf(h.out)], env, work);
      strictEqual(rel.code, refused ? 1 : 0, rel.err);
      if (refused) ok(/no run's lock names it/.test(rel.err), rel.err);
    }));
  }

  it('a worktree that holds the branch by the handoff is taken then, and fenced', () => withRepo(async (fx, env, work) => {
    // A live hold-aware run: the hold stays pending, its handoff the run's.
    const lock = RL.macroLockPath(work, fx.macroId);
    mkdirSync(lock, { recursive: true });
    const entry = join(lock, `h-${process.pid}-abcdef.json`);
    writeFileSync(entry, JSON.stringify({ kind: 'run', run_id: 'autopilot-20261026T000000Z-000009', pid: process.pid, fingerprint: await RL.processFingerprint(process.pid), worker: null, capabilities: ['holds-1'], lanes: 2 }));
    const id = holdIdOf((await run(['hold', 'A', '--macro', fx.macroId], env, work)).out);
    strictEqual(H.readOwnerHold(work, fx.macroId, 'A').record.lane, null);
    const mine = await own(fx, work);
    const { rmSync } = await import('node:fs');
    rmSync(entry);
    const h = await OPS.completeHandoff({ mainRoot: work, macroId: fx.macroId, subtaskId: 'A', stateRoots: [work] });
    strictEqual(h.state, 'held', JSON.stringify(h));
    strictEqual(H.readOwnerHold(work, fx.macroId, 'A').record.lane, mine);
    strictEqual(RL.fenceState(mine, id), 'present');
  }));

  it('a worktree made after the handoff is taken at the release: an edit there after the release is rejected', () => withRepo(async (fx, env, work) => {
    const id = holdIdOf((await run(['hold', 'A', '--macro', fx.macroId], env, work)).out);
    strictEqual(H.holdStateOf(work, fx.macroId, 'A').state, 'held');
    const mine = await own(fx, work);
    writeFileSync(join(mine, 'person.txt'), 'at release\n');
    const ctx = { mainRoot: work, macroId: fx.macroId, subtaskId: 'A', stateRoots: [work] };
    const basisOf = HCLI.basisFor({ engineerRoot: ENG, fingerprintOf: HCLI.releaseFingerprint({ ...ctx, roots: fx.roots, env: fx.env }) });
    const released = await OPS.releaseHold({ ...ctx, holdId: id, basisOf });
    strictEqual(H.readOwnerHold(work, fx.macroId, 'A').record.lane, mine);
    ok(released.release.basis.tree_digest !== 'no worktree', JSON.stringify(released.release.basis));
    writeFileSync(join(mine, 'person.txt'), 'changed after the release\n');
    strictEqual((await OPS.compareRelease({ ...ctx, basisOf })).verdict, 'rejected');
  }));

  it('hold prints the lane its handoff took', () => withRepo(async (fx, env, work) => {
    const out = [];
    const errs = [];
    let mine;
    const code = await HCLI.holdCmd({ macro: fx.macroId, subtask: 'A' }, work, {
      out: (s) => out.push(s), err: (s) => errs.push(s), env, home: env.HOME, engineerRoot: ENG,
      hooks: { afterPublish: async () => { mine = await own(fx, work); } },
    });
    strictEqual(code, 0, errs.join('\n'));
    ok(out.includes(`  lane: ${mine}`) && !/has no lane yet/.test(out.join('\n')), out.join('\n'));
  }));
});

// ADR-0062 Decision 2, amendment of 2026-10-27 (the owner's decision on row
// 12, refine pass 8): a person's work on a held, undispatched subtask, handed
// back through a consumed release of its current hold, is what the run
// dispatches on, when it contains the baseline.
describe("a person's work on an undispatched subtask, handed back (ADR-0062 Decision 2, amendment of 2026-10-27)", () => {
  const sh = async () => (await import('node:child_process')).execFileSync;
  const gitOf = (x, fx) => (cwd, ...a) => x('git', ['-C', cwd, ...a], { env: fx.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  // Hold A, work in a worktree of one's own, commit, remove it, release.
  async function handBack(fx, env, work, { file = 'person.txt', rebase = false } = {}) {
    const g = gitOf(await sh(), fx);
    const id = holdIdOf((await run(['hold', 'A', '--macro', fx.macroId], env, work)).out);
    ok(id, 'held');
    const mine = join(fx.dir, `my-work-${file}`);
    const branched = g(work, 'branch', '--list', 'feat/a') !== '';
    g(work, 'worktree', 'add', '-q', ...(branched ? [mine, 'feat/a'] : ['-b', 'feat/a', mine]));
    if (rebase) g(mine, 'rebase', '-q', 'refs/remotes/origin/main');
    writeFileSync(join(mine, file), 'the work\n');
    g(mine, 'add', file);
    g(mine, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `work: ${file}`);
    g(work, 'worktree', 'remove', mine);
    const rel = await run(['release', 'A', '--macro', fx.macroId, '--hold', id], env, work);
    strictEqual(rel.code, 0, rel.err);
    return { id, tip: g(work, 'rev-parse', 'refs/heads/feat/a'), g };
  }
  // The run's one comparison of the release.
  async function consume(fx, work) {
    const ctx = { mainRoot: work, macroId: fx.macroId, subtaskId: 'A', stateRoots: [work] };
    const basisOf = HCLI.basisFor({ engineerRoot: ENG, fingerprintOf: HCLI.releaseFingerprint({ ...ctx, roots: fx.roots, env: fx.env }) });
    return (await OPS.compareRelease({ ...ctx, basisOf })).verdict;
  }
  // Row 12 of reconciliation, as a run judges A, pending with no lane.
  async function judge(fx, work, branch = 'feat/a') {
    const LN = await import(pathToFileURL(join(AP, 'lanes.mjs')).href);
    const subtask = { id: 'A', branch, status: 'pending' };
    const view = { macro: { fm: { plan: { subtasks: [subtask] } } }, children: {}, claims: [] };
    const facts = LN.gatherLaneFacts({ home: LN.laneHome(work), checkout: work, macroId: fx.macroId, view, baseline: 'main', env: fx.env });
    return LN.judgeSubtask(facts, subtask);
  }
  // A commit lands on origin's main from another clone, and the checkout fetches it.
  async function moveBaseline(fx, work) {
    const g = gitOf(await sh(), fx);
    const other = join(fx.dir, 'other');
    (await sh())('git', ['clone', '-q', fx.origin, other], { env: fx.env, stdio: 'ignore' });
    writeFileSync(join(other, 'moved.txt'), 'moved\n');
    g(other, 'add', 'moved.txt');
    g(other, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'feat: moved');
    g(other, 'push', '-q', 'origin', 'HEAD:main');
    g(work, 'fetch', '-q', 'origin');
  }

  it('a consumed release records the branch tip, and row 12 dispatches on it; a commit made after it is vouched for by nothing, and its halt never advises discarding it', () => withRepo(async (fx, env, work) => {
    const { tip, g } = await handBack(fx, env, work);
    // Not compared yet, the release vouches for nothing.
    const before = await judge(fx, work);
    ok(before.row === 12 && before.halt, JSON.stringify(before));
    strictEqual(await consume(fx, work), 'consumed');
    strictEqual(H.readRecord(work, fx.macroId, 'releases', 'A').record.basis.branch_tip, tip);
    deepStrictEqual(await judge(fx, work), { row: 12, action: 'existing-branch' });
    // The plan moved the subtask to another branch at that same tip: the
    // release was of feat/a, and vouches for no other.
    g(work, 'branch', 'feat/a2', tip);
    ok((await judge(fx, work, 'feat/a2')).halt, 'a release of another branch vouches for nothing');
    // A commit the person made after the release: no consumed release handed it back.
    const later = g(work, 'commit-tree', '-p', tip, '-m', 'later', `${tip}^{tree}`);
    g(work, 'update-ref', 'refs/heads/feat/a', later);
    const j = await judge(fx, work);
    strictEqual(j.row, 12);
    const d = j.halt?.detail ?? '';
    ok(/carries commits that are not on it; no consumed release of a hold on subtask A handed that tip back/.test(d), d);
    ok(d.includes(`hold it (agentic-autopilot hold A --macro ${fx.macroId}), rebase feat/a onto origin/main unless it contains it, then release it`), d);
    ok(!/remove or reset|reset it to|delete it/.test(d), `never advises discarding the work: ${d}`);
  }));

  it('a handed-back tip that does not contain the baseline halts with a rebase, never a removal; rebased and handed back again, row 12 dispatches on it', () => withRepo(async (fx, env, work) => {
    const first = await handBack(fx, env, work);
    strictEqual(await consume(fx, work), 'consumed');
    await moveBaseline(fx, work);
    const j = await judge(fx, work);
    strictEqual(j.row, 12);
    const d = j.halt?.detail ?? '';
    ok(d.includes(`the tip the consumed release of hold ${first.id} handed back, but it does not contain refs/remotes/origin/main`), d);
    ok(d.includes(`hold it again (agentic-autopilot hold A --macro ${fx.macroId}), rebase feat/a onto origin/main, then release it`), d);
    ok(!/remove|reset|delete/.test(d), `never advises discarding the work: ${d}`);
    // What the halt says, done: a new hold, the branch rebased, released and consumed.
    const again = await handBack(fx, env, work, { file: 'more.txt', rebase: true });
    ok(again.tip !== first.tip);
    strictEqual(await consume(fx, work), 'consumed');
    deepStrictEqual(await judge(fx, work), { row: 12, action: 'existing-branch' });
  }));
});

describe('discard reads the plan under the holds lock (refine of critique round 4)', () => {
  it('a plan revised while the discard waits for the lock gives its replacement the new branch: status keeps it, the gate holds', () => withRepo(async (fx, env, work) => {
    await run(['hold', 'A', '--macro', fx.macroId], env, work);
    writeFileSync(H.recordPath(work, fx.macroId, 'holds', 'A'), '{torn');
    let unlock;
    let entered;
    const gate = new Promise((r) => { unlock = r; });
    const ready = new Promise((r) => { entered = r; });
    const holder = H.withHoldsLock(work, fx.macroId, async () => { entered(); await gate; });
    await ready;
    const pending = HCLI.discardCmd({ macro: fx.macroId, subtask: 'A' }, work, { out: () => {}, err: () => {} });
    await new Promise((r) => { setTimeout(r, 100); });
    const plan = (await fx.readMacro()).plan.subtasks.map((s) => (s.id === 'A' ? { ...s, branch: 'feat/new-a' } : s));
    await fx.orch.setPlan({ workflowPath: fx.macroPath, host: 'claude', subtasks: plan });
    unlock();
    await holder;
    strictEqual(await pending, 0);
    strictEqual(H.readOwnerHold(work, fx.macroId, 'A').record.branch, 'feat/new-a');
    const s = await run(['status', '--macro', fx.macroId], env, work);
    ok(!/orphaned/.test(s.out), s.out);
    ok(OPS.holdGate({ mainRoot: work, macroId: fx.macroId, subtaskId: 'A' }), 'the replacement applies');
  }));
});

describe('hold asks again under the holds lock (critique round 4, K3)', () => {
  const holdRacing = (fx, env, work, beforeSet) => {
    const out = [];
    const errs = [];
    return HCLI.holdCmd({ macro: fx.macroId, subtask: 'A' }, work, {
      out: (s) => out.push(s), err: (s) => errs.push(s), env, home: env.HOME, engineerRoot: ENG, hooks: { beforeSet },
    }).then((code) => ({ code, out: out.join('\n'), err: errs.join('\n') }));
  };

  it('a finalize that ends the macro and retires its holds after the first looks refuses the hold: nothing is held, no fence, no "the lane is yours"', () => withRepo(async (fx, env, work) => {
    const r = await holdRacing(fx, env, work, async () => {
      await fx.orch.setMacroTerminal({ workflowPath: fx.macroPath, host: 'claude', terminalPhase: 'finalized', terminalMarker: true, nextAction: 'archive' });
      strictEqual((await OPS.retireMacroHolds({ mainRoot: work, macroId: fx.macroId })).state, 'retired');
    });
    strictEqual(r.code, 1, r.out);
    ok(new RegExp(`macro ${fx.macroId} has ended`).test(r.err), r.err);
    ok(!/the lane is yours/.test(r.out), r.out);
    deepStrictEqual(H.listRecordIds(work, fx.macroId, 'holds').ids, []);
  }));

  it('a macro ended after the first looks refuses the hold, its holds not retired yet (a retirement that waits)', () => withRepo(async (fx, env, work) => {
    const r = await holdRacing(fx, env, work, async () => {
      await fx.orch.setMacroTerminal({ workflowPath: fx.macroPath, host: 'claude', terminalPhase: 'aborted', terminalMarker: true, nextAction: 'archive' });
    });
    strictEqual(r.code, 1, r.out);
    ok(new RegExp(`macro ${fx.macroId} has ended`).test(r.err), r.err);
    deepStrictEqual(H.listRecordIds(work, fx.macroId, 'holds').ids, []);
    strictEqual(H.readActivation(work, fx.macroId).state, 'active', 'the holds were on throughout');
  }));

  it('holds retired since the hold turned them on refuse it too, the macro still open', () => withRepo(async (fx, env, work) => {
    const r = await holdRacing(fx, env, work, async () => {
      strictEqual((await OPS.retireMacroHolds({ mainRoot: work, macroId: fx.macroId })).state, 'retired');
    });
    strictEqual(r.code, 1, r.out);
    ok(/the holds of macro .* are inactive now/.test(r.err), r.err);
    deepStrictEqual(H.listRecordIds(work, fx.macroId, 'holds').ids, []);
    strictEqual(H.readActivation(work, fx.macroId).state, 'inactive');
  }));

  // The cases above end the macro before setHold is called. Here the hold
  // waits on the holds lock (taken from beforeSet, so the first looks have
  // passed), and the macro ends while it waits: only a look taken under the
  // lock sees it. The ending runs from a timer, after the synchronous part of
  // setHold, so a look taken before the lock always sees the macro open.
  it('a hold that waits on the holds lock while a finalize ends the macro asks once it has the lock: refused, nothing held', () => withRepo(async (fx, env, work) => {
    let unlock;
    let entered;
    let holder;
    let ending;
    const gate = new Promise((r) => { unlock = r; });
    const r = await holdRacing(fx, env, work, async () => {
      const ready = new Promise((res) => { entered = res; });
      holder = H.withHoldsLock(work, fx.macroId, async () => { entered(); await gate; });
      await ready;
      ending = new Promise((res) => { setTimeout(res, 100); })
        .then(() => fx.orch.setMacroTerminal({ workflowPath: fx.macroPath, host: 'claude', terminalPhase: 'finalized', terminalMarker: true, nextAction: 'archive' }))
        .finally(() => unlock());
    });
    await ending;
    await holder;
    strictEqual(r.code, 1, r.out);
    ok(new RegExp(`macro ${fx.macroId} has ended \\(current_phase finalized\\)`).test(r.err), r.err);
    ok(!/the lane is yours/.test(r.out), r.out);
    deepStrictEqual(H.listRecordIds(work, fx.macroId, 'holds').ids, []);
  }));
});

describe('writer-clear', () => {
  it('creates the operation\'s .cleared once, and the operation no longer counts open', () => withRepo(async (fx, env, work) => {
    const op = 'op-20261026T000000Z-0000abcd';
    H.publishOpRecord(work, fx.macroId, 'A', { operation_id: op, kind: 'verb' });
    const r = await run(['writer-clear', 'A', '--macro', fx.macroId, '--operation', op], env, work);
    strictEqual(r.code, 0, r.err);
    ok(existsSync(join(H.opsDir(work, fx.macroId, 'A'), `${op}.cleared`)));
    deepStrictEqual(H.openOperations({ mainRoot: work, macroId: fx.macroId, subtaskId: 'A' }).open, []);
    ok(/cleared already/.test((await run(['writer-clear', 'A', '--macro', fx.macroId, '--operation', op], env, work)).out));
  }));
});

describe('discard and what it leaves to a release (N5, N6)', () => {
  const recordOf = (work, fx, kind) => H.readRecord(work, fx.macroId, kind, 'A');
  const releaseIt = (fx, env, work, id) => run(['release', 'A', '--macro', fx.macroId, '--hold', id], env, work);

  it("a discarded owner's record takes the old hold's fence from every worktree, the one the subtask left included", () => withRepo(async (fx, env, work) => {
    const { execFileSync } = await import('node:child_process');
    const id = holdIdOf((await run(['hold', 'A', '--macro', fx.macroId], env, work)).out);
    // The lane the hold was set in, which a branch revision moved the subtask away from.
    const old = join(fx.dir, 'old-lane');
    execFileSync('git', ['-C', work, 'worktree', 'add', '-q', '-b', 'feat/a-old', old], { env: fx.env, stdio: 'ignore' });
    RL.writeFence({ laneRoot: old, holdId: id, subtaskId: 'A', macroId: fx.macroId });
    strictEqual(RL.fenceState(old, id), 'present');
    writeFileSync(H.recordPath(work, fx.macroId, 'holds', 'A'), '{');
    const d = await run(['release', 'A', '--macro', fx.macroId, '--discard-unreadable'], env, work);
    strictEqual(d.code, 0, d.err);
    strictEqual(RL.fenceState(old, id), 'absent', 'no fence of the unreadable hold is stranded');
  }));

  it('a discarded handoff: the release is compared, never withdrawn with nothing to compare', () => withRepo(async (fx, env, work) => {
    const id = holdIdOf((await run(['hold', 'A', '--macro', fx.macroId], env, work)).out);
    strictEqual(H.holdStateOf(work, fx.macroId, 'A').state, 'held');
    writeFileSync(H.recordPath(work, fx.macroId, 'handoffs', 'A'), '{');
    strictEqual((await run(['release', 'A', '--macro', fx.macroId, '--discard-unreadable'], env, work)).code, 0);
    const r = await releaseIt(fx, env, work, id);
    strictEqual(r.code, 0, r.err);
    ok(!/withdrawn/.test(r.out), r.out);
    deepStrictEqual([H.holdStateOf(work, fx.macroId, 'A').state, recordOf(work, fx, 'releases').record.state], ['released-uncompared', 'uncompared']);
  }));

  it("a discarded owner's record beside an acked handoff: its replacement's release is compared", () => withRepo(async (fx, env, work) => {
    await run(['hold', 'A', '--macro', fx.macroId], env, work);
    writeFileSync(H.recordPath(work, fx.macroId, 'holds', 'A'), '{');
    strictEqual((await run(['release', 'A', '--macro', fx.macroId, '--discard-unreadable'], env, work)).code, 0);
    const owner = H.readOwnerHold(work, fx.macroId, 'A').record;
    deepStrictEqual([owner.set_by, owner.compare_on_release, H.holdStateOf(work, fx.macroId, 'A').state], ['discard', true, 'pending']);
    const r = await releaseIt(fx, env, work, owner.hold_id);
    strictEqual(r.code, 0, r.err);
    strictEqual(recordOf(work, fx, 'releases').record.state, 'uncompared');
  }));

  it('git that cannot list the worktrees refuses the discard of an owner record: nothing is replaced, and a retry once it lists them does it', () => withRepo(async (fx, env, work) => {
    const { execFileSync } = await import('node:child_process');
    await run(['hold', 'A', '--macro', fx.macroId], env, work);
    writeFileSync(H.recordPath(work, fx.macroId, 'holds', 'A'), '{');
    const common = execFileSync('git', ['-C', work, 'rev-parse', '--git-common-dir'], { env: fx.env, encoding: 'utf8' }).trim();
    const wt = resolve(work, common, 'worktrees');
    const aside = `${wt}.aside`;
    const had = existsSync(wt);
    if (had) execFileSync('mv', [wt, aside]);
    writeFileSync(wt, 'not a directory\n');
    try {
      const d = await run(['release', 'A', '--macro', fx.macroId, '--discard-unreadable'], env, work);
      strictEqual(d.code, 1);
      ok(/cannot be listed/.test(d.err), d.err);
      strictEqual(H.readOwnerHold(work, fx.macroId, 'A').state, 'unreadable', 'the record is left for the retry');
    } finally {
      execFileSync('rm', ['-f', wt]);
      if (had) execFileSync('mv', [aside, wt]);
    }
    strictEqual((await run(['release', 'A', '--macro', fx.macroId, '--discard-unreadable'], env, work)).code, 0);
    strictEqual(H.readOwnerHold(work, fx.macroId, 'A').record.set_by, 'discard');
  }));

  for (const kind of ['handoffs', 'releases']) {
    it(`a discarded ${kind.slice(0, -1)}: the release is marked compared before the record it depends on changes, so a crash between keeps it compared`, () => withRepo(async (fx, env, work) => {
      const HC = await import(pathToFileURL(join(AP, 'holds-cli.mjs')).href);
      await run(['hold', 'A', '--macro', fx.macroId], env, work);
      mkdirSync(join(H.holdsDir(work, fx.macroId), kind), { recursive: true });
      writeFileSync(H.recordPath(work, fx.macroId, kind, 'A'), '{');
      const crash = new Error('crash');
      let seen = null;
      await HC.discardCmd({ macro: fx.macroId, subtask: 'A' }, work, {
        out: () => {}, err: () => {},
        hooks: { beforeDependentWrite: (k) => { seen = [k, H.readOwnerHold(work, fx.macroId, 'A').record.compare_on_release]; throw crash; } },
      }).then(() => ok(false, 'crashed'), (e) => strictEqual(e, crash));
      deepStrictEqual(seen, [kind, true]);
      strictEqual(H.readRecord(work, fx.macroId, kind, 'A').state, 'unreadable', 'the record it depends on is unchanged');
    }));
  }

  it('a discarded release of a pending hold counts as rejected until a release with a basis replaces it, never a withdrawal (I12)', () => withRepo(async (fx, env, work) => {
    const id = holdIdOf((await run(['hold', 'A', '--macro', fx.macroId], env, work)).out);
    // Pending: its handoff gone (as before it acked).
    H.unlinkQuiet(H.recordPath(work, fx.macroId, 'handoffs', 'A'));
    mkdirSync(join(H.holdsDir(work, fx.macroId), 'releases'), { recursive: true });
    writeFileSync(H.recordPath(work, fx.macroId, 'releases', 'A'), '{');
    strictEqual((await run(['release', 'A', '--macro', fx.macroId, '--discard-unreadable'], env, work)).code, 0);
    strictEqual(recordOf(work, fx, 'releases').record.state, 'rejected');
    const r = await releaseIt(fx, env, work, id);
    strictEqual(r.code, 0, r.err);
    strictEqual(recordOf(work, fx, 'releases').record.state, 'uncompared', 'a release with a basis, which the driver compares');
  }));
});
