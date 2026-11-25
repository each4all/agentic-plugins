// C181 (ADR-0023 §6, amendment of 2026-11-24, who else ends a scope, and what
// is kept while one is not read gone) — the readers of a run whose runner may
// be gone: `cancel`, `settle` and `sweep` each end the run's scope as a step
// of their own, only where its handle binds, its supervisor is proven gone and
// the run is terminal or stale; a handle that binds nothing because its owner
// record is proven absent is read, never killed; every answer reports the
// teardown apart (`scope_teardown`); a sweep writes every kill before any
// reading, each scope at most once; and retention keeps a terminal run whose
// scope is not read gone. The reclaim ends the scope only of a snapshot of
// its own persona, through the handle its owner record names, every kill
// before any reading; and a scoped run whose owner record names a companion
// its handle does not is `owner-incomplete`. The ender is the runners' seam
// (`scopeEnder`), so no
// row depends on this machine's cgroups; the ledgers are real files. The
// engineer's generated copy is the runner under test (every persona's copy is
// the same source, which the persona-pipeline drift check holds).

// Dropped first: a run from an autopilot step would write as the step.
import './_drop-session.mjs';
import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import nodeFs, { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { personaInfo } from './_personas.mjs';
import { tmpDir } from '../_tmp.mjs';
import { cleanEnv, makeDirtyRepo, snapshotWorktrees, withTmp } from './_peer-snapshot-fixtures.mjs';

const P = personaInfo('engineer');
const runner = await import(pathToFileURL(P.path('scripts/peer-runner.mjs')).href);
const { createWorkflow } = await import(pathToFileURL(P.path('scripts/state.mjs')).href);
const { HANDLE_SCHEMA_VERSION, cancelPeerRun, peerRunPaths, readHandle, reclaimWithScopes, settleEnsemble, sweepPeerRuns, writeHandle } = runner;
const snapshotLib = await import(pathToFileURL(P.path('scripts/lib/peer-snapshot.mjs')).href);

const BOOT = 'e55a09fa-13b3-445f-9aa0-4b51e123717f';
const CLOCK = `${BOOT}/time:[4026531834]/pid:[4026531836]`;
const MANAGER = '/user.slice/user-1000.slice/user@1000.service';
const OLD = '2026-01-01T00:00:00.000Z';

function identity(runId, over = {}) {
  const unit = `agentic-launch-${runId}.scope`;
  return {
    owner: { kind: 'peer-run', run_id: runId },
    unit,
    invocation_id: '0123456789abcdef0123456789abcdef',
    cgroup_path: `${MANAGER}/app.slice/${unit}`,
    cgroup_id: '9001',
    boot_id: BOOT,
    gate: { pid: 4242, starttime: '5000', clock: CLOCK },
    supervisor: { pid: 4000, fingerprint: { kind: 'linux_proc_starttime', starttime: '4000' }, clock: CLOCK, boot_id: BOOT },
    has_snapshot: false,
    association: null,
    ...over,
  };
}

const scoped = (runId, over = {}, teardown) => ({ version: 1, state: 'scoped', identity: identity(runId, over), ...(teardown ? { teardown } : {}) });

function handle(repoRoot, runId, over = {}) {
  const at = over.updated_at ?? new Date().toISOString();
  return {
    schema_version: HANDLE_SCHEMA_VERSION,
    run_id: runId,
    plugin: P.name,
    kind: 'manual',
    workflow_path: null,
    phase: null,
    ensemble_type: null,
    host: 'claude',
    peer_host: 'codex',
    model: null,
    effort: null,
    cwd: repoRoot,
    output_format: 'json',
    status: 'completed',
    pid: null,
    pgid: null,
    process_fingerprint: { kind: 'none' },
    started_at: at,
    updated_at: at,
    completed_at: at,
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
    exit_code: 0,
    error_kind: null,
    prompt_retained: false,
    ...over,
  };
}

async function ledger(repoRoot, runId, over = {}) {
  const paths = peerRunPaths(repoRoot, runId);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.stdout, '');
  writeFileSync(paths.stderr, '');
  await writeHandle(paths.handle, handle(repoRoot, runId, over));
  return paths;
}

// A fake ender: what the supervisor check and each reading answer, and every
// call in order. Like the runners' ender (createScopeEnder), it reads a scope
// at most once and answers a second ask with the first reading, unrecorded.
function ender({ supervisor = { gone: true, check: 'esrch' }, read = 'gone' } = {}) {
  const calls = [];
  const readings = new Map();
  return {
    calls,
    supervisorGone: (s) => {
      calls.push(['supervisor', s.pid]);
      return typeof supervisor === 'function' ? supervisor(s) : supervisor;
    },
    kill: (id) => {
      calls.push(['kill', id.unit]);
      return { state: 'written' };
    },
    read: (id) => {
      if (!readings.has(id.unit)) {
        calls.push(['read', id.unit]);
        readings.set(id.unit, { state: typeof read === 'function' ? read(id) : read });
      }
      return readings.get(id.unit);
    },
  };
}

const acts = (e) => e.calls.filter(([what]) => what !== 'supervisor');

describe('C181: cancel ends the scope of a run whose runner is gone', () => {
  it('a terminal run whose handle binds and whose supervisor is gone: one kill, one reading, the teardown recorded without moving updated_at', async (t) => {
    const repoRoot = tmpDir(t, 'scope-cancel-');
    const paths = await ledger(repoRoot, 'r-gone', { updated_at: OLD, scope: scoped('r-gone') });
    const e = ender();
    const answer = await cancelPeerRun({ repoRoot, runId: 'r-gone', scopeEnder: e });
    strictEqual(answer.ok, true);
    strictEqual(answer.reason, 'already_terminal');
    deepStrictEqual(answer.scope_teardown, { state: 'gone', unit: 'agentic-launch-r-gone.scope' });
    deepStrictEqual(acts(e), [['kill', 'agentic-launch-r-gone.scope'], ['read', 'agentic-launch-r-gone.scope']]);
    const after = await readHandle(paths.handle);
    strictEqual(after.scope.teardown.state, 'gone');
    strictEqual(after.updated_at, OLD, 'a teardown is no move of the run');
  });

  it('a supervisor not proven gone keeps the scope: no kill, no reading, nothing written, the answer says why', async (t) => {
    const repoRoot = tmpDir(t, 'scope-cancel-');
    const paths = await ledger(repoRoot, 'r-alive', { scope: scoped('r-alive') });
    const e = ender({ supervisor: { gone: false, check: 'alive' } });
    const answer = await cancelPeerRun({ repoRoot, runId: 'r-alive', scopeEnder: e });
    strictEqual(answer.ok, true);
    deepStrictEqual(answer.scope_teardown, { state: 'withheld', check: 'supervisor-alive', unit: 'agentic-launch-r-alive.scope' });
    deepStrictEqual(acts(e), []);
    strictEqual((await readHandle(paths.handle)).scope.teardown, undefined);
  });

  it('a handle that binds nothing because its owner record is proven absent is read, never killed, with no supervisor check', async (t) => {
    const repoRoot = tmpDir(t, 'scope-cancel-');
    const snapshot = { isolation: 'snapshot', owner_path: join(repoRoot, 'gone-snapshot', 'owner.json'), root: null, removed_at: OLD };
    await ledger(repoRoot, 'r-absent', { snapshot, scope: scoped('r-absent', { has_snapshot: true }) });
    const e = ender({ read: 'unproven' });
    const answer = await cancelPeerRun({ repoRoot, runId: 'r-absent', scopeEnder: e });
    deepStrictEqual(answer.scope_teardown, { state: 'unproven', unit: 'agentic-launch-r-absent.scope', read_only: 'owner-absent' });
    deepStrictEqual(e.calls, [['read', 'agentic-launch-r-absent.scope']]);
  });

  it('an owner record that cannot be read binds nothing and keeps everything: no kill, no reading', async (t) => {
    const repoRoot = tmpDir(t, 'scope-cancel-');
    const ownerDir = join(repoRoot, 'unreadable-owner');
    mkdirSync(ownerDir);
    const snapshot = { isolation: 'snapshot', owner_path: ownerDir, root: null, removed_at: OLD };
    await ledger(repoRoot, 'r-unread', { snapshot, scope: scoped('r-unread', { has_snapshot: true }) });
    const e = ender();
    const answer = await cancelPeerRun({ repoRoot, runId: 'r-unread', scopeEnder: e });
    deepStrictEqual(answer.scope_teardown, { state: 'withheld', check: 'owner-unreadable', unit: 'agentic-launch-r-unread.scope' });
    deepStrictEqual(e.calls, []);
  });

  it('a stored teardown of gone is read again only, and a later reading never replaces it', async (t) => {
    const repoRoot = tmpDir(t, 'scope-cancel-');
    const paths = await ledger(repoRoot, 'r-stored', { scope: scoped('r-stored', {}, { state: 'gone', at: '2026-01-01T00:00:00Z' }) });
    const e = ender({ read: 'withheld' });
    const answer = await cancelPeerRun({ repoRoot, runId: 'r-stored', scopeEnder: e });
    strictEqual(answer.scope_teardown.state, 'withheld');
    deepStrictEqual(e.calls, [['read', 'agentic-launch-r-stored.scope']]);
    strictEqual((await readHandle(paths.handle)).scope.teardown.state, 'gone');
  });

  for (const [label, scope, expected] of [
    ['an earlier release\'s handle, with no scope', undefined, undefined],
    ['a run that made no scope', { version: 1, state: 'none', reason: 'unavailable' }, undefined],
    ['a scope of a version this reader does not know', { version: 2, state: 'scoped' }, { state: 'withheld', check: 'scope-unknown-version' }],
    ['a scope this release does not parse', { version: 1, state: 'scoped', identity: { unit: 'x' } }, { state: 'withheld', check: 'scope-malformed' }],
  ]) {
    it(`${label}: no kill, no reading, ${expected ? 'withheld' : 'no scope_teardown'}`, async (t) => {
      const repoRoot = tmpDir(t, 'scope-cancel-');
      await ledger(repoRoot, 'r-none', scope === undefined ? {} : { scope });
      const e = ender();
      const answer = await cancelPeerRun({ repoRoot, runId: 'r-none', scopeEnder: e });
      strictEqual(answer.ok, true);
      deepStrictEqual(answer.scope_teardown, expected);
      deepStrictEqual(e.calls, []);
    });
  }
});

describe('C181: what a kill rests on', () => {
  it('a runner that moved during the supervisor check keeps its scope: the kill rests on the handle read after it', async (t) => {
    const repoRoot = tmpDir(t, 'scope-race-');
    const base = { status: 'running', completed_at: null, exit_code: null, updated_at: OLD, scope: scoped('r-race') };
    const paths = await ledger(repoRoot, 'r-race', base);
    const e = ender({
      supervisor: () => {
        // The runner writes a fresh update while the reader checks.
        writeFileSync(paths.handle, `${JSON.stringify(handle(repoRoot, 'r-race', { ...base, started_at: OLD, updated_at: new Date().toISOString() }), null, 2)}\n`);
        return { gone: true, check: 'esrch' };
      },
    });
    const answer = await cancelPeerRun({ repoRoot, runId: 'r-race', scopeEnder: e });
    deepStrictEqual(answer.scope_teardown, { state: 'withheld', check: 'not-stale', unit: 'agentic-launch-r-race.scope' });
    deepStrictEqual(acts(e), []);
  });

  for (const [label, over] of [
    ['a scope that says no snapshot on a handle that records one', { scope: scoped('r-mis'), snapshot: { isolation: 'snapshot', owner_path: '/nowhere/owner.json', root: null, removed_at: OLD } }],
    ['a snapshot record that names no owner record where a snapshot keeps one', { scope: scoped('r-mis', { has_snapshot: true }), snapshot: { isolation: 'snapshot', owner_path: '/nowhere/elsewhere.json', root: null, removed_at: OLD } }],
  ]) {
    it(`${label}: no kill, no reading, and retention keeps the run`, async (t) => {
      const repoRoot = tmpDir(t, 'scope-mis-');
      await ledger(repoRoot, 'r-mis', { updated_at: OLD, ...over });
      const e = ender();
      const answer = await cancelPeerRun({ repoRoot, runId: 'r-mis', scopeEnder: e });
      deepStrictEqual(answer.scope_teardown, { state: 'withheld', check: 'owner-unreadable', unit: 'agentic-launch-r-mis.scope' });
      deepStrictEqual(e.calls, []);
      const report = await sweepPeerRuns({ repoRoot, applyRetention: true, retentionTtlDays: 1, scopeEnder: ender() });
      deepStrictEqual(report.pruned, []);
    });
  }
});

describe('C181: settle ends the scope before it settles, and reports it apart', () => {
  it('a failed ensemble run whose runner is gone: killed and read, the settlement unchanged', async (t) => {
    const repoRoot = tmpDir(t, 'scope-settle-');
    const { filePath: workflowPath } = await createWorkflow({
      repoRoot, verb: 'compose', originalRequest: 'scope settle', host: 'claude',
      gitBaseline: { branch: 'test', head: '0000000000000000000000000000000000000000', status_digest: '' },
      currentPhase: 'phase-1', nextAction: 'compose',
    });
    await ledger(repoRoot, 'plan-verify-20261124T000000Z-abcdef', {
      kind: 'ensemble', workflow_path: workflowPath, phase: 'compose', ensemble_type: 'plan-verify',
      status: 'failed', error_kind: 'peer_run_error', exit_code: 1, updated_at: OLD,
      scope: scoped('plan-verify-20261124T000000Z-abcdef'),
    });
    const e = ender();
    const answer = await settleEnsemble({ repoRoot, workflowPath, phase: 'compose', runId: 'plan-verify-20261124T000000Z-abcdef', host: 'claude', scopeEnder: e });
    strictEqual(answer.settlement, 'committed');
    strictEqual(answer.verdict, 'failed');
    deepStrictEqual(answer.scope_teardown, { state: 'gone', unit: 'agentic-launch-plan-verify-20261124T000000Z-abcdef.scope' });
    deepStrictEqual(acts(e).map(([what]) => what), ['kill', 'read']);
  });
});

describe('C181: settle refusal', () => {
  it('a run still live after the reconcile is refused, and the refusal carries the teardown the call made', async (t) => {
    const repoRoot = tmpDir(t, 'scope-settle-');
    const { filePath: workflowPath } = await createWorkflow({
      repoRoot, verb: 'compose', originalRequest: 'scope settle', host: 'claude',
      gitBaseline: { branch: 'test', head: '0000000000000000000000000000000000000000', status_digest: '' },
      currentPhase: 'phase-1', nextAction: 'compose',
    });
    const runId = 'plan-verify-20261124T000001Z-abcdef';
    await ledger(repoRoot, runId, {
      kind: 'ensemble', workflow_path: workflowPath, phase: 'compose', ensemble_type: 'plan-verify',
      status: 'running', completed_at: null, exit_code: null, pid: process.pid, updated_at: OLD, scope: scoped(runId),
    });
    const e = ender();
    let refusal = null;
    try {
      await settleEnsemble({ repoRoot, workflowPath, phase: 'compose', runId, host: 'claude', scopeEnder: e });
    } catch (err) {
      refusal = err;
    }
    ok(refusal instanceof runner.SettleRefusal, String(refusal));
    deepStrictEqual(refusal.scopeTeardown, { state: 'gone', unit: `agentic-launch-${runId}.scope` });
  });
});

describe('C181: sweep writes every kill first, reads each scope once, and retention keeps what is not read gone', () => {
  it('two terminal runs: both kills before either reading', async (t) => {
    const repoRoot = tmpDir(t, 'scope-sweep-');
    await ledger(repoRoot, 'r-a', { scope: scoped('r-a') });
    await ledger(repoRoot, 'r-b', { scope: scoped('r-b') });
    const e = ender();
    const report = await sweepPeerRuns({ repoRoot, scopeEnder: e });
    deepStrictEqual(acts(e).map(([what]) => what), ['kill', 'kill', 'read', 'read']);
    deepStrictEqual(report.scope_teardowns.map((r) => [r.run_id, r.state]).sort(), [['r-a', 'gone'], ['r-b', 'gone']]);
  });

  it('a live run that has not moved for less than the stale grace is not killed', async (t) => {
    const repoRoot = tmpDir(t, 'scope-sweep-');
    await ledger(repoRoot, 'r-live', { status: 'running', pid: process.pid, completed_at: null, exit_code: null, scope: scoped('r-live') });
    const e = ender();
    const report = await sweepPeerRuns({ repoRoot, scopeEnder: e, staleGraceMs: 60_000 });
    deepStrictEqual(acts(e), []);
    deepStrictEqual(report.scope_teardowns, [{ run_id: 'r-live', state: 'withheld', check: 'not-stale', unit: 'agentic-launch-r-live.scope' }]);
  });

  it('retention keeps a terminal run whose scope is not read gone, counted with the non-terminal runs', async (t) => {
    const repoRoot = tmpDir(t, 'scope-sweep-');
    const kept = await ledger(repoRoot, 'r-held', { updated_at: OLD, scope: scoped('r-held') });
    const plain = await ledger(repoRoot, 'r-plain', { updated_at: OLD });
    const report = await sweepPeerRuns({ repoRoot, applyRetention: true, retentionTtlDays: 1, scopeEnder: ender({ read: 'unproven' }) });
    deepStrictEqual(report.pruned.map((p) => p.run_id), ['r-plain']);
    deepStrictEqual(report.scope_held, [{ run_id: 'r-held', reason: 'scope-not-gone', unit: 'agentic-launch-r-held.scope' }]);
    ok(!report.planned_prunes.some((p) => p.run_id === 'r-held'), 'not even planned');
    strictEqual((await readHandle(kept.handle)).scope.teardown.state, 'unproven');
    ok(plain);
  });

  it('control: the same run read gone is pruned as any terminal run', async (t) => {
    const repoRoot = tmpDir(t, 'scope-sweep-');
    await ledger(repoRoot, 'r-done', { updated_at: OLD, scope: scoped('r-done') });
    const report = await sweepPeerRuns({ repoRoot, applyRetention: true, retentionTtlDays: 1, scopeEnder: ender({ read: 'gone' }) });
    deepStrictEqual(report.pruned.map((p) => p.run_id), ['r-done']);
    deepStrictEqual(report.scope_held, []);
  });

  it('a handle whose owner record is proven absent holds no authority, and is pruned though its scope is not read gone', async (t) => {
    const repoRoot = tmpDir(t, 'scope-sweep-');
    const snapshot = { isolation: 'snapshot', owner_path: join(repoRoot, 'gone-snapshot', 'owner.json'), root: null, removed_at: OLD };
    await ledger(repoRoot, 'r-orphan', { updated_at: OLD, snapshot, scope: scoped('r-orphan', { has_snapshot: true }) });
    const report = await sweepPeerRuns({ repoRoot, applyRetention: true, retentionTtlDays: 1, scopeEnder: ender({ read: 'unproven' }) });
    deepStrictEqual(report.pruned.map((p) => p.run_id), ['r-orphan']);
  });

  it('the same handle is checked again on its claimed directory: an owner record that appears right after the claim keeps the run', async (t) => {
    const repoRoot = tmpDir(t, 'scope-sweep-');
    const ownerPath = join(repoRoot, 'late-snapshot', 'owner.json');
    const snapshot = { isolation: 'snapshot', owner_path: ownerPath, root: null, removed_at: OLD };
    const paths = await ledger(repoRoot, 'r-late', { updated_at: OLD, snapshot, scope: scoped('r-late', { has_snapshot: true }) });
    // Right after the prune's claim (its rename of the run directory): every
    // check before it saw the owner record absent, so only the check on the
    // claimed handle can see it.
    const real = nodeFs.renameSync;
    let claimed = 0;
    nodeFs.renameSync = function renameSync(from, ...rest) {
      const out = real.call(this, from, ...rest);
      if (String(from) === paths.dir && ++claimed === 1) {
        mkdirSync(join(repoRoot, 'late-snapshot'), { recursive: true });
        writeFileSync(ownerPath, '{}\n');
      }
      return out;
    };
    let report;
    try {
      report = await sweepPeerRuns({ repoRoot, applyRetention: true, retentionTtlDays: 1, scopeEnder: ender({ read: 'unproven' }) });
    } finally {
      nodeFs.renameSync = real;
    }
    strictEqual(claimed, 1, 'the prune claimed the run directory');
    deepStrictEqual(report.pruned, []);
    deepStrictEqual(report.prune_skipped, [{ run_id: 'r-late', reason: 'scope-not-gone' }]);
    ok(existsSync(paths.handle), 'the run directory, back under its run id');
  });

  it('a scope this release does not parse keeps its run too', async (t) => {
    const repoRoot = tmpDir(t, 'scope-sweep-');
    await ledger(repoRoot, 'r-bad', { updated_at: OLD, scope: { version: 1, state: 'scoped', identity: { unit: 'x' } } });
    const report = await sweepPeerRuns({ repoRoot, applyRetention: true, retentionTtlDays: 1, scopeEnder: ender() });
    deepStrictEqual(report.pruned, []);
    deepStrictEqual(report.scope_held, [{ run_id: 'r-bad', reason: 'scope-malformed' }]);
  });

  it('a scope of a version this reader does not know keeps its run', async (t) => {
    const repoRoot = tmpDir(t, 'scope-sweep-');
    await ledger(repoRoot, 'r-later', { updated_at: OLD, scope: { version: 2, state: 'scoped' } });
    const report = await sweepPeerRuns({ repoRoot, applyRetention: true, retentionTtlDays: 1, scopeEnder: ender() });
    deepStrictEqual(report.pruned, []);
    deepStrictEqual(report.scope_held, [{ run_id: 'r-later', reason: 'scope-unknown-version' }]);
  });
});

// A snapshot of `persona` made in a real repository, its owner record carrying
// `scope` and its supervisor one whose identity cannot be told, so the age
// rule (a `now` past the TTL) reclaims it, and, when `ledgerOver` is not null,
// this persona's ledger for its run with the same scope and a snapshot record
// naming that owner record.
async function scopedSnapshot(dir, runId, { persona = P.name, ledgerOver = {}, ownerScope } = {}) {
  const env = cleanEnv();
  const top = makeDirtyRepo(dir);
  const snap = await snapshotLib.createPeerSnapshot({ cwd: top, runId, persona, env });
  const scope = scoped(runId, { has_snapshot: true });
  const owner = JSON.parse(readFileSync(snap.owner_path, 'utf8'));
  // The scope's supervisor, its identity never told on the record.
  owner.supervisor = { pid: scope.identity.supervisor.pid, fingerprint: { kind: 'none' } };
  owner.scope = ownerScope ?? scope;
  writeFileSync(snap.owner_path, JSON.stringify(owner));
  let paths = null;
  if (ledgerOver !== null) {
    const snapshot = { isolation: 'snapshot', owner_path: snap.owner_path, root: snap.root, removed_at: null };
    paths = await ledger(top, runId, { updated_at: OLD, snapshot, scope, ...ledgerOver });
  }
  return { env, top, snap, paths, unit: scope.identity.unit };
}

const LATE = new Date(Date.now() + 25 * 60 * 60 * 1000);

describe('C181: the reclaim ends the scope of its own persona\'s snapshot through the handle its owner record names', () => {
  it('a snapshot of this persona whose handle binds: killed before it is judged, read once at the gate, removed, the teardown recorded', async () => {
    await withTmp(async (dir) => {
      const { env, top, snap, paths, unit } = await scopedSnapshot(dir, 'r-own');
      const e = ender();
      const report = await reclaimWithScopes({ repoRoot: top, cwd: top, env, ender: e, now: LATE, snapshotNow: LATE });
      deepStrictEqual(acts(e), [['kill', unit], ['read', unit]]);
      strictEqual(report.reclaimed.length, 1);
      deepStrictEqual(report.scope_teardowns, [{ run_id: 'r-own', state: 'gone', unit }]);
      ok(!existsSync(snap.parent), 'the snapshot is removed');
      strictEqual(snapshotWorktrees(top).length, 0);
      strictEqual((await readHandle(paths.handle)).scope.teardown.state, 'gone');
    });
  });

  it('a scope the kill leaves unproven keeps the snapshot whole, and the handle records what was read', async () => {
    await withTmp(async (dir) => {
      const { env, top, snap, paths, unit } = await scopedSnapshot(dir, 'r-held');
      const e = ender({ read: 'unproven' });
      const report = await reclaimWithScopes({ repoRoot: top, cwd: top, env, ender: e, now: LATE, snapshotNow: LATE });
      deepStrictEqual(acts(e), [['kill', unit], ['read', unit]]);
      deepStrictEqual(report.kept, [{ tree: snap.root, why: 'scope-unproven', unit }]);
      ok(existsSync(snap.owner_path) && existsSync(snap.root));
      strictEqual((await readHandle(paths.handle)).scope.teardown.state, 'unproven');
    });
  });

  for (const [label, opts, setup, unrouted] of [
    // This persona's ledger holds the run id and names the snapshot: only
    // the owner record's persona refuses. The binding refuses it again, so
    // the kill alone cannot tell the reclaim's own refusal; the reclaim then
    // takes no route to the scope at all (no teardown reported), which only
    // its own refusal shows (R8; R13 holds the binding's, through cancel).
    ['another persona\'s snapshot', { persona: 'founder' }, undefined, true],
    ['a run id no ledger of this persona holds', { ledgerOver: null }, undefined, true],
    ['a handle whose supervisor is not proven gone', {}, () => ({ supervisor: { gone: false, check: 'alive' } })],
    ['a live handle that has moved within the stale grace', { ledgerOver: { status: 'running', completed_at: null, exit_code: null, updated_at: new Date(LATE.getTime() - 1000).toISOString() } }],
  ]) {
    it(`${label}: no kill; the gate reads the scope once and keeps the snapshot`, async () => {
      await withTmp(async (dir) => {
        const { env, top, snap, unit } = await scopedSnapshot(dir, 'r-other', opts);
        const e = ender({ read: 'unproven', ...(setup ? setup() : {}) });
        const report = await reclaimWithScopes({ repoRoot: top, cwd: top, env, ender: e, now: LATE, snapshotNow: LATE, staleGraceMs: 60_000 });
        deepStrictEqual(acts(e), [['read', unit]]);
        deepStrictEqual(report.kept, [{ tree: snap.root, why: 'scope-unproven', unit }]);
        ok(existsSync(snap.root));
        if (unrouted) strictEqual(report.scope_teardowns, undefined, 'the reclaim takes no route to this scope');
      });
    });
  }

  it('a handle whose snapshot record names another owner record, one that binds: no kill', async () => {
    await withTmp(async (dir) => {
      const { env, top, snap, paths, unit } = await scopedSnapshot(dir, 'r-decoy');
      // A copy of the owner record in another snapshot directory: the handle
      // binds through it, so only the reclaim's own match refuses.
      const decoy = join(dir, 'engineer-peer-snapshot-decoy');
      mkdirSync(decoy);
      writeFileSync(join(decoy, 'owner.json'), readFileSync(snap.owner_path));
      const h = await readHandle(paths.handle);
      h.snapshot = { ...h.snapshot, owner_path: join(decoy, 'owner.json'), root: null };
      await writeHandle(paths.handle, h);
      const e = ender({ read: 'unproven' });
      const report = await reclaimWithScopes({ repoRoot: top, cwd: top, env, ender: e, now: LATE, snapshotNow: LATE });
      deepStrictEqual(acts(e), [['read', unit]]);
      deepStrictEqual(report.kept, [{ tree: snap.root, why: 'scope-unproven', unit }]);
    });
  });

  for (const [label, supervisor] of [
    ['another pid', { pid: 4001, fingerprint: { kind: 'none' } }],
    ['another start', { pid: 4000, fingerprint: { kind: 'linux_proc_starttime', starttime: '4001', clock: CLOCK } }],
  ]) {
    it(`an owner record whose supervisor is not its scope's (${label}): no kill`, async () => {
      await withTmp(async (dir) => {
        const { env, top, snap, unit } = await scopedSnapshot(dir, 'r-sup');
        const owner = JSON.parse(readFileSync(snap.owner_path, 'utf8'));
        owner.supervisor = supervisor;
        writeFileSync(snap.owner_path, JSON.stringify(owner));
        const e = ender({ read: 'unproven' });
        await reclaimWithScopes({ repoRoot: top, cwd: top, env, ender: e, now: LATE, snapshotNow: LATE });
        deepStrictEqual(acts(e), [['read', unit]]);
      });
    });
  }

  it('a handle redirected to another owner record during the supervisor check: no kill', async () => {
    await withTmp(async (dir) => {
      const { env, top, snap, paths, unit } = await scopedSnapshot(dir, 'r-move');
      const decoy = join(dir, 'engineer-peer-snapshot-moved');
      mkdirSync(decoy);
      writeFileSync(join(decoy, 'owner.json'), readFileSync(snap.owner_path));
      const e = ender({
        read: 'unproven',
        supervisor: () => {
          const h = JSON.parse(readFileSync(paths.handle, 'utf8'));
          h.snapshot = { ...h.snapshot, owner_path: join(decoy, 'owner.json'), root: null };
          writeFileSync(paths.handle, JSON.stringify(h));
          return { gone: true, check: 'esrch' };
        },
      });
      await reclaimWithScopes({ repoRoot: top, cwd: top, env, ender: e, now: LATE, snapshotNow: LATE });
      deepStrictEqual(acts(e), [['read', unit]]);
    });
  });

  it('a cancel of this persona\'s run whose snapshot record names another persona\'s owner record binds nothing', async () => {
    await withTmp(async (dir) => {
      const { top, unit } = await scopedSnapshot(dir, 'r-foreign', { persona: 'founder' });
      const e = ender();
      const answer = await cancelPeerRun({ repoRoot: top, runId: 'r-foreign', scopeEnder: e });
      deepStrictEqual(answer.scope_teardown, { state: 'withheld', check: 'owner-mismatch', unit });
      deepStrictEqual(e.calls, []);
    });
  });

  it('an owner record whose scope disagrees with the handle\'s binds nothing: no kill', async () => {
    await withTmp(async (dir) => {
      const other = scoped('r-dis', { has_snapshot: true, cgroup_id: '9999' });
      const { env, top, unit } = await scopedSnapshot(dir, 'r-dis', { ownerScope: other });
      const e = ender({ read: 'unproven' });
      const report = await reclaimWithScopes({ repoRoot: top, cwd: top, env, ender: e, now: LATE, snapshotNow: LATE });
      deepStrictEqual(acts(e), [['read', unit]]);
      deepStrictEqual(report.scope_teardowns, [{ run_id: 'r-dis', state: 'withheld', check: 'records-disagree', unit }]);
    });
  });

  it('two snapshots: both kills before either reading', async () => {
    await withTmp(async (dir) => {
      const first = await scopedSnapshot(dir, 'r-one');
      const env = first.env;
      const snap = await snapshotLib.createPeerSnapshot({ cwd: first.top, runId: 'r-two', persona: P.name, env });
      const scope = scoped('r-two', { has_snapshot: true });
      const owner = JSON.parse(readFileSync(snap.owner_path, 'utf8'));
      owner.supervisor = { pid: scope.identity.supervisor.pid, fingerprint: { kind: 'none' } };
      owner.scope = scope;
      writeFileSync(snap.owner_path, JSON.stringify(owner));
      await ledger(first.top, 'r-two', { updated_at: OLD, snapshot: { isolation: 'snapshot', owner_path: snap.owner_path, root: snap.root, removed_at: null }, scope });
      const e = ender();
      const report = await reclaimWithScopes({ repoRoot: first.top, cwd: first.top, env, ender: e, now: LATE, snapshotNow: LATE });
      deepStrictEqual(acts(e).map(([what]) => what), ['kill', 'kill', 'read', 'read']);
      strictEqual(report.reclaimed.length, 2);
    });
  });

  it('control: a snapshot whose owner record carries no scope is reclaimed as before, with no kill and no reading', async () => {
    await withTmp(async (dir) => {
      const { env, top, snap } = await scopedSnapshot(dir, 'r-plain', { ownerScope: { version: 1, state: 'none', reason: 'unavailable' }, ledgerOver: { scope: { version: 1, state: 'none', reason: 'unavailable' } } });
      const e = ender();
      const report = await reclaimWithScopes({ repoRoot: top, cwd: top, env, ender: e, now: LATE, snapshotNow: LATE });
      deepStrictEqual(e.calls, []);
      strictEqual(report.reclaimed.length, 1);
      strictEqual(report.scope_teardowns, undefined);
      ok(!existsSync(snap.parent));
    });
  });
});

describe('C181: an owner record naming a companion the scoped handle does not is owner-incomplete', () => {
  const companion = { pid: 4194000, pgid: 4194000, fingerprint: { kind: 'none' } };
  const owner = (over = {}) => ({ live_toplevel: '/r', tree: '/s/tree', supervisor: { pid: 4194001, fingerprint: { kind: 'none' } }, companion, ...over });
  const handleOf = (over = {}) => ({ pid: null, pgid: null, ...over });

  for (const [label, o, h] of [
    ['a scoped handle', owner(), handleOf({ scope: scoped('r-inc') })],
    ['a scoped owner record', owner({ scope: scoped('r-inc') }), handleOf()],
  ]) {
    it(`${label} naming no companion while the owner record names one`, async () => {
      const judged = await snapshotLib.snapshotEnded(o, { handle: h, listProcesses: () => [] });
      deepStrictEqual([judged.verdict, judged.why], ['unknown', 'owner-incomplete']);
    });
  }

  it('control: with no scope on either record the run is judged on its owners, as 2026-10-19 decides', async () => {
    const judged = await snapshotLib.snapshotEnded(owner(), { handle: handleOf(), listProcesses: () => [] });
    ok(judged.why !== 'owner-incomplete', JSON.stringify(judged));
  });

  it('control: a scoped run whose owner record names no companion either is not owner-incomplete', async () => {
    const judged = await snapshotLib.snapshotEnded(owner({ companion: null }), { handle: handleOf({ scope: scoped('r-inc') }), listProcesses: () => [] });
    ok(judged.why !== 'owner-incomplete', JSON.stringify(judged));
  });
});

// The orchestrator's hand-kept runner takes the same reader steps (its copy of
// them is the persona runner's text, persona aside, which no byte check
// holds): its cancel and sweep end the scope of a run whose runner is gone,
// its retention keeps what is not read gone, and its reclaim ends the scope
// only of an orchestrator snapshot. The rows run the core of each above
// through it.
describe('C181: the orchestrator runner ends a dead run\'s scope as the personas\' does', async () => {
  const orch = await import(new URL('../../plugins/orchestrator/scripts/peer-runner.mjs', import.meta.url).href);
  const orchLedger = async (repoRoot, runId, over = {}) => {
    const paths = orch.peerRunPaths(repoRoot, runId);
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.stdout, '');
    writeFileSync(paths.stderr, '');
    await orch.writeHandle(paths.handle, handle(repoRoot, runId, { plugin: 'orchestrator', ...over }));
    return paths;
  };

  it('cancel of a terminal run whose supervisor is gone: one kill, one reading, the teardown recorded without moving updated_at', async (t) => {
    const repoRoot = tmpDir(t, 'scope-orch-cancel-');
    const paths = await orchLedger(repoRoot, 'o-gone', { updated_at: OLD, scope: scoped('o-gone') });
    const e = ender();
    const answer = await orch.cancelPeerRun({ repoRoot, runId: 'o-gone', scopeEnder: e });
    strictEqual(answer.ok, true);
    deepStrictEqual(answer.scope_teardown, { state: 'gone', unit: 'agentic-launch-o-gone.scope' });
    deepStrictEqual(acts(e), [['kill', 'agentic-launch-o-gone.scope'], ['read', 'agentic-launch-o-gone.scope']]);
    const after = await orch.readHandle(paths.handle);
    strictEqual(after.scope.teardown.state, 'gone');
    strictEqual(after.updated_at, OLD, 'a teardown is no move of the run');
  });

  it('cancel with a supervisor not proven gone: no kill, no reading, nothing written', async (t) => {
    const repoRoot = tmpDir(t, 'scope-orch-cancel-');
    const paths = await orchLedger(repoRoot, 'o-alive', { scope: scoped('o-alive') });
    const e = ender({ supervisor: { gone: false, check: 'alive' } });
    const answer = await orch.cancelPeerRun({ repoRoot, runId: 'o-alive', scopeEnder: e });
    deepStrictEqual(answer.scope_teardown, { state: 'withheld', check: 'supervisor-alive', unit: 'agentic-launch-o-alive.scope' });
    deepStrictEqual(acts(e), []);
    strictEqual((await orch.readHandle(paths.handle)).scope.teardown, undefined);
  });

  it('sweep: both kills before either reading, and retention keeps the run not read gone while it prunes the one read gone', async (t) => {
    const repoRoot = tmpDir(t, 'scope-orch-sweep-');
    await orchLedger(repoRoot, 'o-held', { updated_at: OLD, scope: scoped('o-held') });
    await orchLedger(repoRoot, 'o-done', { updated_at: OLD, scope: scoped('o-done') });
    const e = ender({ read: (id) => (id.unit === 'agentic-launch-o-held.scope' ? 'unproven' : 'gone') });
    const report = await orch.sweepPeerRuns({ repoRoot, applyRetention: true, retentionTtlDays: 1, scopeEnder: e });
    deepStrictEqual(acts(e).map(([what]) => what), ['kill', 'kill', 'read', 'read']);
    deepStrictEqual(report.pruned.map((p) => p.run_id), ['o-done']);
    deepStrictEqual(report.scope_held, [{ run_id: 'o-held', reason: 'scope-not-gone', unit: 'agentic-launch-o-held.scope' }]);
  });

  it('the reclaim ends the scope of an orchestrator snapshot whose handle binds, and of no persona\'s', async () => {
    for (const [persona, killed] of [['orchestrator', true], [P.name, false]]) {
      await withTmp(async (dir) => {
        const env = cleanEnv();
        const top = makeDirtyRepo(dir);
        const snap = await snapshotLib.createPeerSnapshot({ cwd: top, runId: 'o-snap', persona, env });
        const scope = scoped('o-snap', { has_snapshot: true });
        const owner = JSON.parse(readFileSync(snap.owner_path, 'utf8'));
        owner.supervisor = { pid: scope.identity.supervisor.pid, fingerprint: { kind: 'none' } };
        owner.scope = scope;
        writeFileSync(snap.owner_path, JSON.stringify(owner));
        const snapshot = { isolation: 'snapshot', owner_path: snap.owner_path, root: snap.root, removed_at: null };
        const paths = await orchLedger(top, 'o-snap', { updated_at: OLD, snapshot, scope });
        const e = ender({ read: killed ? 'gone' : 'unproven' });
        const report = await orch.reclaimWithScopes({ repoRoot: top, cwd: top, env, ender: e, now: LATE, snapshotNow: LATE });
        const unit = scope.identity.unit;
        if (killed) {
          deepStrictEqual(acts(e), [['kill', unit], ['read', unit]]);
          deepStrictEqual(report.scope_teardowns, [{ run_id: 'o-snap', state: 'gone', unit }]);
          ok(!existsSync(snap.parent), 'the snapshot is removed');
          strictEqual((await orch.readHandle(paths.handle)).scope.teardown.state, 'gone');
        } else {
          deepStrictEqual(acts(e), [['read', unit]], `${persona}'s snapshot gets no kill from the orchestrator`);
          ok(existsSync(snap.root), 'kept');
          // The binding would refuse it too; only the reclaim's own refusal
          // takes no route to the scope at all (as R8 holds for the personas).
          strictEqual(report.scope_teardowns, undefined, 'the reclaim takes no route to this scope');
        }
      });
    }
  });
});
