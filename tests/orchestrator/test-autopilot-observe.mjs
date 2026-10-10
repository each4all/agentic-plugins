// tests/orchestrator/test-autopilot-observe.mjs
//
// ADR-0063 D3a/D4 — the autopilot observer (plugins/orchestrator/adapters/
// claude/autopilot/observe.mjs) against real state: a scratch repository
// with a bare origin, a macro and engineer children written by the plugins'
// own state APIs, the real orchestrator/engineer/runtime CLIs of this
// checkout, and a fake `gh` on PATH that moves a pull request from absent to
// open to merged. Each case also runs the policy on the view, so the shapes
// the policy tests assume are the shapes the observer builds.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRepo } from './fixtures/autopilot-repo.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const { observe } = await import(resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/observe.mjs'));
const { decide } = await import(resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/policy.mjs'));

const RUN = 'autopilot-20261001T000000Z-123456';
const HIGH = (verb) => ({ kind: 'verb', verb, confidence: 'HIGH' });

async function withRepo(fn, opts) {
  const fx = await makeRepo(opts);
  // Hermetic: no user-level agentic config or git config reaches the CLIs.
  fx.env.HOME = join(fx.dir, 'home');
  mkdirSync(fx.env.HOME);
  try {
    const look = (over = {}) => observe({ repoRoot: fx.work, roots: fx.roots, macroId: over.macroId ?? null, fetch: over.fetch ?? true, env: fx.env });
    return await fn(fx, look);
  } finally {
    fx.cleanup();
  }
}

describe('observe → decide on real state', () => {
  it('an approved macro with nothing dispatched: dispatch the first ready subtask', async () => {
    await withRepo(async (fx, look) => {
      const v = look();
      strictEqual(v.macro.id, fx.macroId);
      strictEqual(v.macro.archived, false);
      strictEqual(v.macro.relPath, `.agentic-plugins/state/orchestrator/workflows/${fx.macroId}.md`);
      deepStrictEqual(v.ready.approval, { status: 'approved', hash_ok: true });
      strictEqual(v.ready.ready.id, 'A');
      deepStrictEqual([v.git.branch, v.git.clean, v.git.detached], ['main', true, false]);
      strictEqual(v.briefError, null);
      ok(['lead', 'owner-choice-required'].includes(v.brief.disposition), v.brief.disposition);
      deepStrictEqual([v.children, v.claims, v.foreign], [{}, [], null]);
      const d = decide(v, { runId: RUN });
      deepStrictEqual([d.outcome, d.step.kind, d.step.subtaskId], ['step', 'dispatch', 'A']);
    });
  });

  it('an active child with a HIGH next step: run that verb', async () => {
    await withRepo(async (fx, look) => {
      const c = await fx.dispatch('A');
      await fx.finish(c.path, HIGH('critique'));
      const v = look();
      const child = v.children.A;
      deepStrictEqual(
        [child.location, child.workflow_id, child.branch, child.terminal_marker, child.next_step, child.parent_workflow, child.originating_subtask],
        ['active', c.id, 'feat/a', false, { kind: 'verb', verb: 'critique', confidence: 'HIGH' }, fx.macroId, 'A'],
      );
      deepStrictEqual(v.claims.map((x) => [x.id, x.originating_subtask]), [[c.id, 'A']]);
      const d = decide(v, { runId: RUN });
      deepStrictEqual([d.step.kind, d.step.verb], ['verb', 'critique']);
    });
  });

  it('an interactive finish (terminal summary-complete) still carries its live next step', async () => {
    await withRepo(async (fx, look) => {
      const c = await fx.dispatch('A');
      await fx.finish(c.path, { kind: 'commit', verb: null, confidence: 'HIGH' }, { autopilot: false });
      const v = look();
      deepStrictEqual([v.children.A.current_phase, v.children.A.terminal_marker], ['summary-complete', true]);
      strictEqual(decide(v, { runId: RUN }).step.kind, 'commit');
    });
  });

  it('a committed, archived child: waits on its landing until the pull request merges, then done', async () => {
    await withRepo(async (fx, look) => {
      const c = await fx.dispatch('A');
      await fx.finish(c.path, { kind: 'commit', verb: null, confidence: 'HIGH' });
      await fx.commitAndArchive(c.path);
      let v = look();
      deepStrictEqual([v.children.A.location, v.children.A.current_phase], ['archived', 'commit-complete']);
      deepStrictEqual([v.landing.A.ok, v.landing.A.reason], [false, 'no_pr']);
      strictEqual(v.fetch.attempted, true);
      let d = decide(v, { runId: RUN });
      strictEqual(d.reason, 'awaiting-landing');
      deepStrictEqual(d.waiting[0].commands, ['git push -u origin feat/a', 'gh pr create --base main --head feat/a --fill']);

      fx.setPrs([{ number: 7, url: 'u', state: 'OPEN', baseRefName: 'main', headRefName: 'feat/a', createdAt: new Date(Date.now() + 60_000).toISOString(), mergeCommit: null }]);
      v = look();
      strictEqual(v.landing.A.reason, 'not_merged');
      strictEqual(decide(v, { runId: RUN }).reason, 'awaiting-landing');

      fx.setPrs([fx.land('A', 'feat/a')]);
      v = look();
      strictEqual(v.landing.A.ok, true);
      d = decide(v, { runId: RUN });
      deepStrictEqual([d.step.kind, d.step.subtaskId], ['done', 'A']);
    });
  });

  it('preview does not fetch: a merge it has not fetched still reads as not reachable', async () => {
    await withRepo(async (fx, look) => {
      const c = await fx.dispatch('A');
      await fx.finish(c.path, { kind: 'commit', verb: null, confidence: 'HIGH' });
      await fx.commitAndArchive(c.path);
      const pr = fx.land('A', 'feat/a');
      // Rewind the local remote-tracking ref so only a fetch would see the merge.
      fx.git('update-ref', 'refs/remotes/origin/main', `${pr.mergeCommit.oid}~1`);
      fx.setPrs([pr]);
      const v = look({ fetch: false });
      deepStrictEqual([v.fetch.attempted, v.landing.A.ok, v.landing.A.reason], [false, false, 'not_reachable']);
      strictEqual(look({ fetch: true }).landing.A.ok, true);
    });
  });

  it('a child closed without a commit: done --no-commit', async () => {
    await withRepo(async (fx, look) => {
      const c = await fx.dispatch('A');
      await fx.finish(c.path, { kind: 'done', verb: null, confidence: 'HIGH' });
      await fx.commitAndArchive(c.path, { phase: 'close-complete' });
      const v = look();
      deepStrictEqual([v.children.A.location, v.children.A.current_phase, v.landing.A], ['archived', 'close-complete', undefined]);
      const d = decide(v, { runId: RUN });
      deepStrictEqual([d.step.kind, d.step.engineerWorkflowId], ['done-no-commit', c.id]);
    });
  });

  it('an archived child of an earlier attempt on another branch does not count (E1)', async () => {
    await withRepo(async (fx, look) => {
      const c = await fx.dispatch('A');
      await fx.finish(c.path, { kind: 'done', verb: null, confidence: 'HIGH' });
      await fx.commitAndArchive(c.path, { phase: 'close-complete' });
      // A plan revision moves the in_progress subtask to another branch; it
      // keeps the old engineer id.
      const m = await fx.readMacro();
      const subtasks = m.plan.subtasks.map((s) => (s.id === 'A' ? { ...s, branch: 'feat/a2' } : s));
      await fx.orch.setPlan({ workflowPath: fx.macroPath, host: 'claude', subtasks });
      await fx.orch.approvePlan({ workflowPath: fx.macroPath, host: 'claude', env: {} });
      // feat/a is checked out and no subtask names it any more: only a pinned
      // macro (the driver pins it on its first look) is found.
      strictEqual(look().macro, null);
      ok(/no active macro is on, or referenced by a subtask of, branch feat\/a: name one with --macro/.test(decide(look(), { runId: RUN }).detail));
      const v = look({ macroId: fx.macroId });
      strictEqual(v.children.A.location, 'linkage-mismatch');
      ok(/branch=feat\/a, the plan says feat\/a2/.test(v.children.A.detail), v.children.A.detail);
      strictEqual(decide(v, { runId: RUN }).reason, 'owner-choice');
    });
  });

  it('a child behind a subtask still pending (an interrupted dispatch) is a claim the policy refuses', async () => {
    await withRepo(async (fx, look) => {
      const s = await fx.subtask('A');
      fx.git('switch', '-q', '--no-track', '-c', s.branch, 'refs/remotes/origin/main');
      await fx.eng.createWorkflow({
        repoRoot: fx.work, verb: 'compose', host: 'claude', originalRequest: 'x',
        gitBaseline: { branch: s.branch, head: fx.git('rev-parse', 'HEAD'), status_digest: '' },
        parentWorkflow: fx.macroId, originatingSubtask: 'A',
      });
      const v = look();
      strictEqual(v.claims.length, 1);
      strictEqual(v.claims[0].originating_subtask, 'A');
      const d = decide(v, { runId: RUN });
      strictEqual(d.reason, 'owner-choice');
      ok(/claims subtask A, which is pending/.test(d.detail), d.detail);
    });
  });

  it('an unrelated engineer workflow on the checked-out branch is foreign', async () => {
    await withRepo(async (fx, look) => {
      await fx.eng.createWorkflow({
        repoRoot: fx.work, verb: 'investigate', host: 'claude', originalRequest: 'x',
        gitBaseline: { branch: 'main', head: fx.git('rev-parse', 'HEAD'), status_digest: '' },
      });
      const v = look();
      ok(v.foreign && /its parent is none/.test(v.foreign.detail), JSON.stringify(v.foreign));
      strictEqual(decide(v, { runId: RUN }).reason, 'owner-choice');
    });
  });

  it('a plan edited after approval halts plan-unapproved', async () => {
    await withRepo(async (fx, look) => {
      const m = await fx.readMacro();
      await fx.orch.setPlan({ workflowPath: fx.macroPath, host: 'claude', subtasks: m.plan.subtasks.map((s) => ({ ...s, topic: `${s.topic}!` })) });
      const v = look();
      strictEqual(v.ready.approval.status, 'pending');
      const d = decide(v, { runId: RUN });
      strictEqual(d.reason, 'plan-unapproved');
      strictEqual(d.pointer, `.agentic-plugins/state/orchestrator/workflows/${fx.macroId}.md#macro-plan`);
    });
  });

  it('the archived macro, pinned by id, reads as completed with its approval facts', async () => {
    await withRepo(async (fx, look) => {
      for (const id of ['A', 'B']) {
        await fx.orch.updateSubtask({
          workflowPath: fx.macroPath, subtaskId: id, host: 'claude', status: 'completed',
          engineerWorkflowId: `compose-20261001T00000${id === 'A' ? 1 : 2}Z-abcdef`, closedAt: '2026-10-01T00:00:00Z', reason: 'fixture',
        });
      }
      const m = await fx.readMacro();
      strictEqual(m.terminal_marker, true, 'the last completion auto-terminalizes the macro');
      await fx.orch.archiveWorkflow({ workflowPath: fx.macroPath, host: 'claude', repoRoot: fx.work });
      strictEqual(look().macro, null, 'nothing is active once it is archived');
      const v = look({ macroId: fx.macroId });
      deepStrictEqual([v.macro.archived, v.ready.approval.status, v.ready.approval.hash_ok], [true, 'approved', true]);
      strictEqual(decide(v, { runId: RUN }).outcome, 'completed');
    });
  });
});

// ADR-0067 Decision 1 (SR, U6) — the observer finds records where the
// plugins' readers find them: a pinned macro through resolve-workflow (the
// read set), its archive in the read set, an engineer child archived, or a
// claim, in any worktree's own homes; pointers are relative to the state root
// holding the record (Decision 1(c)), never absolute.
describe('observe from a linked worktree (ADR-0067 Decision 1)', () => {
  const addWorktree = (fx, name) => {
    const wt = join(fx.dir, name);
    fx.git('worktree', 'add', '-q', '-b', `wt/${name}`, wt, 'refs/remotes/origin/main');
    return realpathSync(wt);
  };
  const lookFrom = (fx, repoRoot, over = {}) => observe({ repoRoot, roots: fx.roots, macroId: fx.macroId, fetch: false, env: fx.env, ...over });

  it('a macro in the main checkout, pinned by id, is found from a lane and pointed to relative to its root', async () => {
    await withRepo(async (fx) => {
      const lane = addWorktree(fx, 'lane');
      const v = lookFrom(fx, lane);
      strictEqual(v.macroLookupError, null);
      strictEqual(v.macro.path, realpathSync(fx.macroPath));
      strictEqual(v.macro.relPath, `.agentic-plugins/state/orchestrator/workflows/${fx.macroId}.md`);
      strictEqual(decide(v, { runId: RUN }).outcome, 'step');
    });
  });

  it('two files holding the pinned macro are an error, never one of them', async () => {
    await withRepo(async (fx) => {
      const lane = addWorktree(fx, 'lane');
      const copy = join(lane, '.agentic-plugins/state/orchestrator/workflows', `${fx.macroId}.md`);
      mkdirSync(dirname(copy), { recursive: true });
      writeFileSync(copy, readFileSync(fx.macroPath, 'utf8'));
      const v = lookFrom(fx, lane);
      strictEqual(v.macro, null);
      ok(/resolve-workflow exited 1: .*held by 2 files/.test(v.macroLookupError), v.macroLookupError);
    });
  });

  it('the archived macro, pinned by id, is found in the read set from a lane', async () => {
    await withRepo(async (fx) => {
      const lane = addWorktree(fx, 'lane');
      for (const id of ['A', 'B']) {
        await fx.orch.updateSubtask({
          workflowPath: fx.macroPath, subtaskId: id, host: 'claude', status: 'completed',
          engineerWorkflowId: `compose-20261001T00000${id === 'A' ? 1 : 2}Z-abcdef`, closedAt: '2026-10-01T00:00:00Z', reason: 'fixture',
        });
      }
      await fx.orch.archiveWorkflow({ workflowPath: fx.macroPath, host: 'claude', repoRoot: fx.work });
      const v = lookFrom(fx, lane);
      strictEqual(v.macroLookupError, null);
      deepStrictEqual([v.macro.archived, v.macro.relPath.startsWith('.agentic-plugins/state/orchestrator/archive/')], [true, true]);
      strictEqual(decide(v, { runId: RUN }).outcome, 'completed');
    });
  });

  it("a child archived in a third worktree's own home is found, and its pointer is relative to that worktree", async () => {
    await withRepo(async (fx) => {
      const lane = addWorktree(fx, 'lane');
      const third = addWorktree(fx, 'third');
      const c = await fx.dispatch('A');
      await fx.finish(c.path, { kind: 'commit', verb: null, confidence: 'HIGH' });
      const archived = await fx.commitAndArchive(c.path);
      const moved = join(third, '.agentic-plugins/state/engineer/archive', basename(archived.to));
      mkdirSync(dirname(moved), { recursive: true });
      renameSync(archived.to, moved);
      const v = lookFrom(fx, lane);
      strictEqual(v.children.A.location, 'archived', JSON.stringify(v.children.A));
      strictEqual(v.children.A.relPath, `.agentic-plugins/state/engineer/archive/${basename(moved)}`);
    });
  });

  it("a live engineer workflow claiming the macro in a third worktree's own home is a claim", async () => {
    await withRepo(async (fx) => {
      const lane = addWorktree(fx, 'lane');
      const third = addWorktree(fx, 'third');
      const { filePath } = await fx.eng.createWorkflow({
        repoRoot: third, verb: 'compose', host: 'claude', originalRequest: 'x',
        gitBaseline: { branch: 'wt/third', head: fx.git('rev-parse', 'HEAD'), status_digest: '' },
        parentWorkflow: fx.macroId, originatingSubtask: 'A',
      });
      ok(filePath.startsWith(join(third, '.agentic-plugins/state/engineer/workflows')), filePath);
      const v = lookFrom(fx, lane);
      strictEqual(v.claimsError, null);
      deepStrictEqual(v.claims.map((c) => [c.originating_subtask, c.relPath]), [['A', `.agentic-plugins/state/engineer/workflows/${basename(filePath)}`]]);
      ok(/claims subtask A, which is pending/.test(decide(v, { runId: RUN }).detail));
    });
  });

  // U4j — only absence (ENOENT) is an empty home; a file in a directory's
  // place is refused, as the state library's scans refuse it.
  it("a file in an engineer workflow home's place in a third worktree is a claims error, never no claim", async () => {
    await withRepo(async (fx) => {
      const lane = addWorktree(fx, 'lane');
      const third = addWorktree(fx, 'third');
      mkdirSync(join(third, '.agentic-plugins/state/engineer'), { recursive: true });
      writeFileSync(join(third, '.agentic-plugins/state/engineer/workflows'), 'not a directory');
      const v = lookFrom(fx, lane);
      ok(/cannot list .*\/third\/\.agentic-plugins\/state\/engineer\/workflows: ENOTDIR/.test(v.claimsError ?? ''), String(v.claimsError));
    });
  });

  it("a file in an engineer archive's place in a third worktree is an error for an archived child, never a skip", async () => {
    await withRepo(async (fx) => {
      const lane = addWorktree(fx, 'lane');
      const third = addWorktree(fx, 'third');
      const c = await fx.dispatch('A');
      await fx.finish(c.path, { kind: 'commit', verb: null, confidence: 'HIGH' });
      await fx.commitAndArchive(c.path);
      strictEqual(lookFrom(fx, lane).children.A.location, 'archived', 'control: found in the main checkout');
      mkdirSync(join(third, '.agentic-plugins/state/engineer'), { recursive: true });
      writeFileSync(join(third, '.agentic-plugins/state/engineer/archive'), 'not a directory');
      const v = lookFrom(fx, lane);
      strictEqual(v.children.A.location, 'error', JSON.stringify(v.children.A));
      ok(/ENOTDIR/.test(v.children.A.detail), v.children.A.detail);
    });
  });
});

// ADR-0067 Decision 8 — what a consensus proposal is judged from, read from
// records the plugins' own state APIs wrote: the run id the conflict gate
// records, the runs ensemble_results holds as a conflict, and the task file
// for that run in the record's own home (its existence only). The policy
// then proposes the round only while that file is there.
describe('the consensus facts (ADR-0067 Decision 8)', () => {
  const PLAN_RUN = 'macro-plan-20261001T000000Z-0ff1ce';
  const PEER_RUN = 'review-20261001T000000Z-c0ffee';
  const round = (file) => `/runtime:consensus plan --task-file ${file} --peers claude,codex --max-rounds 2`;
  const retire = (file) => renameSync(file, file.replace(/\.md$/, '.resolved.md'));

  it('a macro on plan-conflict: its run, its recorded conflict and its task file in the orchestrator home; the round is proposed only while the file exists', async () => {
    await withRepo(async (fx, look) => {
      const subtasks = (await fx.readMacro()).plan.subtasks;
      await fx.orch.setPlan({ workflowPath: fx.macroPath, host: 'claude', subtasks, verdict: 'conflict', runId: PLAN_RUN });
      await fx.orch.commitEnsemble({ workflowPath: fx.macroPath, run_id: PLAN_RUN, phase: 'plan', ensemble_type: 'plan-verify', verdict: 'conflict', summary: 'C1 contested' });
      const rel = `.agentic-plugins/state/orchestrator/consensus/${fx.macroId}.${PLAN_RUN}.md`;
      // The gate and its result are recorded; the file is not written yet.
      let v = look();
      const file = join(dirname(dirname(v.macro.path)), 'consensus', `${fx.macroId}.${PLAN_RUN}.md`);
      deepStrictEqual(v.macro.consensus, { run_id: PLAN_RUN, conflict_runs: [PLAN_RUN], task: { path: file, relPath: rel, exists: false } });
      strictEqual(decide(v, { runId: RUN }).proposals, undefined, 'no file, no proposal');

      await fx.orch.writeConsensusTask({ workflowPath: fx.macroPath, runId: PLAN_RUN, text: 'C1: split A?' });
      v = look();
      strictEqual(v.macro.consensus.task.exists, true);
      strictEqual(realpathSync(v.macro.consensus.task.path), realpathSync(join(fx.work, rel)), 'the file the plan wrote');
      const d = decide(v, { runId: RUN });
      strictEqual(d.reason, 'plan-unapproved');
      deepStrictEqual(d.proposals, [{ kind: 'consensus', command: round(file), pointer: rel, subtask_id: null, gate: 'plan-conflict' }]);

      retire(join(fx.work, rel));
      v = look();
      strictEqual(v.macro.consensus.task.exists, false);
      strictEqual(decide(v, { runId: RUN }).proposals, undefined, 'a retired file proposes nothing');
    });
  });

  it('an engineer child on peer-conflict: its facts in the engineer home, and the round while its file exists', async () => {
    await withRepo(async (fx, look) => {
      const c = await fx.dispatch('A');
      await fx.eng.commitEnsemble({ workflowPath: c.path, run_id: PEER_RUN, phase: 'critique', ensemble_type: 'review', verdict: 'conflict', summary: 'C1 contested' });
      await fx.eng.writeConsensusTask({ workflowPath: c.path, runId: PEER_RUN, text: 'C1: A or B?' });
      await fx.finish(c.path, { kind: 'owner-decision', verb: null, confidence: 'HIGH' }, { ownerGate: { gate: 'peer-conflict', anchor: 'ensemble-synthesis', runId: PEER_RUN } });
      const rel = `.agentic-plugins/state/engineer/consensus/${c.id}.${PEER_RUN}.md`;
      let v = look();
      const file = join(dirname(dirname(v.children.A.path)), 'consensus', `${c.id}.${PEER_RUN}.md`);
      deepStrictEqual(v.children.A.consensus, { run_id: PEER_RUN, conflict_runs: [PEER_RUN], task: { path: file, relPath: rel, exists: true } });
      strictEqual(realpathSync(file), realpathSync(join(fx.work, rel)));
      const d = decide(v, { runId: RUN });
      strictEqual(d.reason, 'awaiting-owner:peer-conflict');
      deepStrictEqual(d.proposals, [{ kind: 'consensus', command: round(file), pointer: rel, subtask_id: 'A', gate: 'peer-conflict' }]);

      retire(join(fx.work, rel));
      v = look();
      strictEqual(v.children.A.consensus.task.exists, false);
      strictEqual(decide(v, { runId: RUN }).proposals, undefined);
    });
  });
});
