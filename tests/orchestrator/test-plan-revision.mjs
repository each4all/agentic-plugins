// tests/orchestrator/test-plan-revision.mjs
//
// ADR-0062 §Decisions 3-5 — what a plan revision (`setPlan` / `plan-set`)
// may do.
//   - Docket C22: setPlan replaced plan.subtasks without the unblock pass
//     that only updateSubtask ran, so a revision that satisfied a subtask's
//     blocked_by left it `blocked` and /orchestrator:next found nothing.
//   - A terminal macro is not revised (the /plan runbook rewrites
//     current_phase around plan-set, which strands terminal_marker=true
//     with a non-terminal phase).
//   - A completed subtask survives a revision unchanged unless --correct.

import { describe, it } from 'node:test';
import { strictEqual, ok, rejects, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE_MJS = resolve(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');

const {
  createWorkflow,
  readWorkflow,
  setPlan,
  updateSubtask,
  setMacroTerminal,
  appendPhase,
  parseWorkflowFile,
  assembleWorkflowFile,
} = await import(STATE_MJS);

async function withTmpRepo(name, fn) {
  const dir = await mkdtemp(join(tmpdir(), `orchestrator-plan-revision-${name}-`));
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'initial', '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const BASELINE = {
  branch: 'main',
  head: '0000000000000000000000000000000000000000',
  status_digest: '',
};

async function newMacro(repoRoot, subtasks) {
  const { filePath } = await createWorkflow({
    repoRoot, verb: 'plan', host: 'claude',
    gitBaseline: BASELINE, originalRequest: 'plan revision fixture',
  });
  await setPlan({ workflowPath: filePath, host: 'claude', subtasks });
  return filePath;
}

const st = (id, extra = {}) => ({
  id, verb: 'compose', branch: `feat/${id.toLowerCase()}`, blocked_by: [], status: 'pending', ...extra,
});

async function complete(filePath, id, commit = `${id.toLowerCase()}000`) {
  await updateSubtask({
    workflowPath: filePath, subtaskId: id, host: 'claude',
    engineerWorkflowId: `eng-${id}`, status: 'completed', commit,
    closedAt: '2026-09-27T10:00:00Z',
  });
}

// The completed record as the /plan runbook would re-materialize it: the
// plan-time fields only, no provenance.
const planTimeOnly = (s) => ({
  id: s.id, verb: s.verb, branch: s.branch, blocked_by: s.blocked_by, status: s.status,
});

describe('setPlan — unblock pass (C22)', () => {
  it('a revision that satisfies blocked_by promotes the subtask to pending', async () => {
    await withTmpRepo('satisfy', async (root) => {
      const filePath = await newMacro(root, [
        st('A', { status: 'in_progress' }),
        st('X'),
        st('B', { blocked_by: ['A', 'X'], status: 'blocked' }),
      ]);
      await complete(filePath, 'A');
      let { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.plan.subtasks[2].status, 'blocked');
      // Revision: B no longer waits on X (it was dropped from the plan).
      await setPlan({
        workflowPath: filePath, host: 'claude',
        subtasks: [
          frontmatter.plan.subtasks[0],
          st('B', { blocked_by: ['A'], status: 'blocked' }),
        ],
      });
      ({ frontmatter } = await readWorkflow(filePath));
      strictEqual(frontmatter.plan.subtasks[1].status, 'pending');
    });
  });

  it('a revision that empties blocked_by promotes the subtask to pending', async () => {
    await withTmpRepo('empty-deps', async (root) => {
      const filePath = await newMacro(root, [
        st('A'),
        st('B', { blocked_by: ['A'], status: 'blocked' }),
      ]);
      await setPlan({
        workflowPath: filePath, host: 'claude',
        subtasks: [st('A'), st('B', { blocked_by: [], status: 'blocked' })],
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.plan.subtasks[1].status, 'pending');
    });
  });

  it('updateSubtask runs the same pass, including an empty blocked_by', async () => {
    await withTmpRepo('shared-pass', async (root) => {
      const filePath = await newMacro(root, [st('A', { status: 'in_progress' }), st('B')]);
      // A file written before the shared pass existed: B is blocked on nothing.
      const { frontmatter, body } = parseWorkflowFile(await readFile(filePath, 'utf8'));
      frontmatter.plan.subtasks[1].status = 'blocked';
      await writeFile(filePath, assembleWorkflowFile(frontmatter, body));
      await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude', engineerWorkflowId: 'eng-A',
      });
      const after = await readWorkflow(filePath);
      strictEqual(after.frontmatter.plan.subtasks[1].status, 'pending');
    });
  });

  it('does not promote a blocked subtask whose predecessor is still open', async () => {
    await withTmpRepo('still-blocked', async (root) => {
      const filePath = await newMacro(root, [
        st('A', { status: 'in_progress' }),
        st('B', { blocked_by: ['A'], status: 'blocked' }),
      ]);
      await setPlan({
        workflowPath: filePath, host: 'claude',
        subtasks: [st('A', { status: 'in_progress' }), st('B', { blocked_by: ['A'], status: 'blocked' })],
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.plan.subtasks[1].status, 'blocked');
    });
  });

  it('never auto-terminals; an all-terminal revision is reported instead', async () => {
    await withTmpRepo('no-auto-terminal', async (root) => {
      const filePath = await newMacro(root, [st('A', { status: 'in_progress' }), st('B')]);
      await complete(filePath, 'A');
      const { frontmatter: before } = await readWorkflow(filePath);
      const r = await setPlan({
        workflowPath: filePath, host: 'claude',
        subtasks: [before.plan.subtasks[0]],
      });
      strictEqual(r.allTerminal, true);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.terminal_marker, undefined);
      strictEqual(frontmatter.current_phase, before.current_phase);
    });
  });

  it('an empty plan stays open', async () => {
    await withTmpRepo('empty-plan', async (root) => {
      const filePath = await newMacro(root, [st('A')]);
      const r = await setPlan({ workflowPath: filePath, host: 'claude', subtasks: [] });
      strictEqual(r.allTerminal, false);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.terminal_marker, undefined);
    });
  });

  it('CLI plan-set points an all-terminal revision at /orchestrator:finalize', async () => {
    await withTmpRepo('cli-hint', async (root) => {
      const filePath = await newMacro(root, [st('A', { status: 'in_progress' }), st('B')]);
      await complete(filePath, 'A');
      const { frontmatter } = await readWorkflow(filePath);
      const json = join(root, 'subtasks.json');
      await writeFile(json, JSON.stringify([frontmatter.plan.subtasks[0]]));
      const r = spawnSync(process.execPath, [
        STATE_MJS, 'plan-set', `--workflow-path=${filePath}`, '--host=claude',
        `--subtasks-json-file=${json}`,
      ], { encoding: 'utf8' });
      strictEqual(r.status, 0, r.stderr);
      strictEqual(r.stdout.trim(), filePath);
      ok(/\/orchestrator:finalize/.test(r.stderr), r.stderr);
    });
  });
});

describe('setPlan — a terminal macro is not revised (ADR-0062 §Decision 4)', () => {
  for (const [label, makeTerminal] of [
    ['auto-terminal (commit-complete)', async (filePath) => complete(filePath, 'A')],
    ['finalized', async (filePath) => setMacroTerminal({
      workflowPath: filePath, host: 'claude', terminalPhase: 'finalized', terminalMarker: true,
    })],
  ]) {
    it(`refuses a revision of a ${label} macro and writes nothing`, async () => {
      await withTmpRepo('terminal', async (root) => {
        const filePath = await newMacro(root, [st('A', { status: 'in_progress' })]);
        await makeTerminal(filePath);
        const before = await readFile(filePath, 'utf8');
        await rejects(() => setPlan({
          workflowPath: filePath, host: 'claude', subtasks: [st('A'), st('B')],
        }), /terminal macro is not revised.*archive/is);
        strictEqual(await readFile(filePath, 'utf8'), before);
      });
    });
  }
});

describe('append --require-open refuses a terminal macro under its own lock (ADR-0062 §Decision 4)', () => {
  it('refuses and writes nothing once the macro is terminal; appends while it is open', async () => {
    await withTmpRepo('require-open', async (root) => {
      const filePath = await newMacro(root, [st('A', { status: 'in_progress' })]);
      await appendPhase({
        workflowPath: filePath, host: 'claude', phaseLabel: 'open', currentPhase: 'phase-0-resume', requireOpen: true,
      });
      await setMacroTerminal({ workflowPath: filePath, host: 'claude', terminalPhase: 'finalized', terminalMarker: true });
      const before = await readFile(filePath, 'utf8');
      await rejects(() => appendPhase({
        workflowPath: filePath, host: 'claude', phaseLabel: 'late', currentPhase: 'phase-0-resume', requireOpen: true,
      }), /terminal macro is not revised/);
      strictEqual(await readFile(filePath, 'utf8'), before);
      const cli = spawnSync(process.execPath, [
        STATE_MJS, 'append', `--workflow-path=${filePath}`, '--host=claude',
        '--current-phase=phase-0-resume', '--require-open',
      ], { encoding: 'utf8' });
      strictEqual(cli.status, 1);
      strictEqual(await readFile(filePath, 'utf8'), before);
    });
  });
});

describe('setPlan — a completed subtask survives a revision (ADR-0062 §Decision 3)', () => {
  it('carries forward the provenance a revision omits', async () => {
    await withTmpRepo('carry', async (root) => {
      const filePath = await newMacro(root, [st('A', { status: 'in_progress', topic: 'the original work' }), st('B')]);
      await complete(filePath, 'A', 'abc1234');
      const { frontmatter: before } = await readWorkflow(filePath);
      const recorded = before.plan.subtasks[0];
      // The revision omits provenance and even the optional plan-time topic.
      const { topic: _t, ...withoutTopic } = planTimeOnly(recorded);
      await setPlan({
        workflowPath: filePath, host: 'claude',
        subtasks: [withoutTopic, st('B'), st('C')],
      });
      const { frontmatter } = await readWorkflow(filePath);
      deepStrictEqual(frontmatter.plan.subtasks[0], recorded);
    });
  });

  for (const [label, mutate, pattern] of [
    ['changes its commit', (s) => ({ ...s, commit: 'fff9999' }), /completed subtask "A".*commit/s],
    ['changes its status', (s) => ({ ...planTimeOnly(s), status: 'pending' }), /completed subtask "A".*status/s],
    ['drops it from the plan', null, /completed subtask "A" is missing/],
    ['changes the work it names (verb and branch)', (s) => ({ ...s, verb: 'investigate', branch: 'feat/replacement' }), /completed subtask "A" would change (verb|branch)/],
    ['changes its topic', (s) => ({ ...s, topic: 'something else' }), /completed subtask "A" would change topic/],
  ]) {
    it(`refuses a revision that ${label}, and accepts it with --correct`, async () => {
      await withTmpRepo('guard', async (root) => {
        const filePath = await newMacro(root, [st('A', { status: 'in_progress', topic: 'the original work' }), st('B')]);
        await complete(filePath, 'A', 'abc1234');
        const { frontmatter: before } = await readWorkflow(filePath);
        const revised = mutate
          ? [mutate(before.plan.subtasks[0]), st('B')]
          : [st('B')];
        const bytes = await readFile(filePath, 'utf8');
        await rejects(() => setPlan({ workflowPath: filePath, host: 'claude', subtasks: revised }), pattern);
        strictEqual(await readFile(filePath, 'utf8'), bytes);

        await rejects(() => setPlan({
          workflowPath: filePath, host: 'claude', subtasks: revised, correct: true,
        }), /--correct requires a non-empty reason/);

        await setPlan({
          workflowPath: filePath, host: 'claude', subtasks: revised,
          correct: true, reason: 'owner re-scoped A',
        });
        const { body } = await readWorkflow(filePath);
        ok(body.includes('Correction (--correct)'), body);
        ok(body.includes('Reason: owner re-scoped A'), body);
      });
    });
  }
});
