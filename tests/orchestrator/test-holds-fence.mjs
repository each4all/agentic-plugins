// tests/orchestrator/test-holds-fence.mjs
//
// ADR-0068 Decision 2, item 4 (impl-hold) — the hold's fence: an admission
// entry in the lane's worktree lock, named as a session's so every reader,
// an older driver included, reads it and judges it live until it is removed.
// A run and an admission are refused beside it, naming the release; the
// session `admission release` refuses it; only its own hold's repair writes
// or removes it.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const RL = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/run-locks.mjs')).href);
const ORCH_STATE = join(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');

const MACRO = 'macro-plan-20261026T000000Z-fe0001';
const HOLD = '0011223344556677';
const OTHER = '8899aabbccddeeff';
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && !k.startsWith('AGENTIC_') && !k.startsWith('NODE_TEST')));

async function withRepo(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'holds-fence-')));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { env: cleanEnv() });
  try { return await fn(repo); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const fence = (repo, holdId = HOLD) => RL.writeFence({ laneRoot: repo, holdId, subtaskId: 'S', macroId: MACRO });

describe('the hold\'s fence', () => {
  it('is a session-named entry of the lane\'s worktree lock, its id derived from the hold id', () => withRepo((repo) => {
    const file = fence(repo);
    strictEqual(file, join(RL.worktreeLockPath(repo), `s-${RL.fenceAdmissionId(HOLD)}.json`));
    const [e] = RL.readLockEntries(RL.worktreeLockPath(repo));
    strictEqual(e.session, true);
    ok(RL.isFence(e.holder));
    deepStrictEqual([e.holder.hold_id, e.holder.subtask_id, e.holder.macro_id], [HOLD, 'S', MACRO]);
    strictEqual(RL.fenceAdmissionId(HOLD), RL.fenceAdmissionId(HOLD), 'a retried handoff finds its own fence');
    ok(RL.fenceAdmissionId(HOLD) !== RL.fenceAdmissionId(OTHER));
  }));

  it('a run cannot take the lane beside it, and the refusal names the release', () => withRepo(async (repo) => {
    fence(repo);
    await rejects(RL.acquireLock(RL.worktreeLockPath(repo), { record: { kind: 'run', run_id: 'autopilot-20261026T000000Z-000001' }, attempts: 2 }),
      (err) => err instanceof RL.LockHeldError && err.message.includes(`agentic-autopilot release S --macro ${MACRO} --hold ${HOLD}`));
  }));

  it('an interactive admission is refused beside it, naming the release', () => withRepo((repo) => {
    fence(repo);
    const r = spawnSync(process.execPath, [ORCH_STATE, 'admission', 'join', '--macro', MACRO, '--checkout', repo, '--command', 'next', '--host', 'claude'], { encoding: 'utf8', env: cleanEnv() });
    strictEqual(r.status, 1, r.stderr);
    ok(r.stderr.includes(`agentic-autopilot release S --macro ${MACRO} --hold ${HOLD}`), r.stderr);
  }));

  it('the session `admission release` refuses it and leaves it', () => withRepo((repo) => {
    fence(repo);
    const r = spawnSync(process.execPath, [ORCH_STATE, 'admission', 'release', '--macro', MACRO, '--checkout', repo, '--admission', RL.fenceAdmissionId(HOLD)], { encoding: 'utf8', env: cleanEnv() });
    strictEqual(r.status, 1, r.stderr);
    ok(r.stderr.startsWith('state.mjs admission release: refused: ') && /hold's fence/.test(r.stderr) && r.stderr.includes(`--hold ${HOLD}`), r.stderr);
    strictEqual(RL.fenceState(repo, HOLD), 'present');
    throws(() => RL.releaseAdmission({ checkout: repo, macroId: MACRO, admissionId: RL.fenceAdmissionId(HOLD) }), (err) => err.code === 'fence');
  }));

  it('repair writes a held hold\'s missing fence and removes a released one\'s leftover, never another hold\'s', () => withRepo((repo) => {
    strictEqual(RL.repairFence({ laneRoot: repo, holdId: HOLD, subtaskId: 'S', macroId: MACRO, held: true }), 'written');
    strictEqual(RL.fenceState(repo, HOLD), 'present');
    strictEqual(RL.repairFence({ laneRoot: repo, holdId: HOLD, subtaskId: 'S', macroId: MACRO, held: true }), 'none');
    fence(repo, OTHER);
    strictEqual(RL.repairFence({ laneRoot: repo, holdId: HOLD, subtaskId: 'S', macroId: MACRO, held: false }), 'removed');
    strictEqual(RL.fenceState(repo, HOLD), 'absent');
    strictEqual(RL.fenceState(repo, OTHER), 'present', 'another hold\'s fence stays');
    strictEqual(RL.removeFence(repo, HOLD), false);
    deepStrictEqual(readdirSync(RL.worktreeLockPath(repo)), [`s-${RL.fenceAdmissionId(OTHER)}.json`]);
  }));

  it('laneLockRivals sees every live entry but the hold\'s own fence', () => withRepo(async (repo) => {
    fence(repo);
    deepStrictEqual(await RL.laneLockRivals(repo, { holdId: HOLD }), []);
    strictEqual((await RL.laneLockRivals(repo, { holdId: OTHER })).length, 1, 'another hold\'s view sees this fence');
    const held = await RL.acquireLock(join(RL.worktreeLockPath(repo), '..', 'other.lock'), { record: { kind: 'x' } });
    held.release();
  }));
});
