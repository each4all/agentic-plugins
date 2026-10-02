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
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
