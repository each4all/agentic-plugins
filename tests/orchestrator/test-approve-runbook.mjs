// tests/orchestrator/test-approve-runbook.mjs
//
// ADR-0063 D6 — /orchestrator:approve, run as written: the bash block in
// commands/approve.md, against real macro files, in bash and (when installed)
// zsh. It resolves the macro, prints the table and hash it approves, and
// approves exactly that hash.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual, notStrictEqual } from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ORCH_ROOT = resolve(REPO_ROOT, 'plugins/orchestrator');
const {
  createWorkflow, setPlan, setAwaitingOwner, setMacroTerminal, readWorkflow, computePlanHash,
} = await import(resolve(ORCH_ROOT, 'scripts/state.mjs'));

const AUTOPILOT_RUN_ID = 'autopilot-20260930T010203Z-abcdef';
const SHELLS = ['bash', 'zsh'].filter((sh) => spawnSync(sh, ['-c', 'true']).status === 0);

async function approveBlock() {
  const text = await readFile(resolve(ORCH_ROOT, 'commands/approve.md'), 'utf8');
  const from = text.indexOf('## Phase 0 — Resolve the macro, show the plan, approve it');
  ok(from >= 0, 'approve.md carries its Phase 0');
  const m = /```bash\n([\s\S]*?)```/.exec(text.slice(from));
  ok(m, 'Phase 0 has a bash block');
  return m[1];
}

async function withRepo(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-approve-runbook-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init', '--no-gpg-sign']);
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function plannedMacro(dir) {
  const { filePath } = await createWorkflow({
    repoRoot: dir, verb: 'plan', host: 'claude',
    gitBaseline: { branch: 'main', head: '0'.repeat(40), status_digest: '' },
    originalRequest: 'approve runbook fixture',
  });
  await setPlan({
    workflowPath: filePath, host: 'claude',
    subtasks: [
      { id: 'A', label: 'first', verb: 'compose', profile: 'backend', branch: 'feat/a', blocked_by: [], status: 'pending', topic: 'the objective | with a pipe' },
      { id: 'B', verb: 'refine', branch: 'feat/b', blocked_by: ['A'], status: 'blocked' },
    ],
  });
  return filePath;
}

async function run(shell, dir, extraEnv = {}) {
  const env = { ...process.env, AGENTIC_ORCHESTRATOR_ROOT: ORCH_ROOT, ...extraEnv };
  delete env.CLAUDE_PLUGIN_ROOT;
  if (!('AGENTIC_AUTOPILOT' in extraEnv)) delete env.AGENTIC_AUTOPILOT;
  if (!('EXPLICIT_WORKFLOW_ID' in extraEnv)) delete env.EXPLICIT_WORKFLOW_ID;
  return spawnSync(shell, ['-c', await approveBlock()], { cwd: dir, encoding: 'utf8', env });
}

describe('/orchestrator:approve binds the approval to the hash it showed', () => {
  it('passes the shown plan_hash as --expect-hash', async () => {
    const block = await approveBlock();
    ok(block.includes('SHOWN="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" plan-hash --workflow-path "$MACRO_PATH")"'), 'the block reads plan-hash once');
    ok(/PLAN_HASH="\$\(printf '%s\\n' "\$SHOWN" \| node -e '[^']*JSON\.parse\(d\)\.plan_hash/.test(block), 'PLAN_HASH comes from what was shown');
    ok(block.includes('--expect-hash "$PLAN_HASH"'), 'plan-approve is bound to it');
  });
});

for (const shell of SHELLS) {
  describe(`/orchestrator:approve runbook (${shell})`, () => {
    it('shows the table and hash, then approves exactly that hash; again is a no-op', async () => {
      await withRepo(async (dir) => {
        const filePath = await plannedMacro(dir);
        const expected = computePlanHash((await readWorkflow(filePath)).frontmatter.plan.subtasks);
        let r = await run(shell, dir);
        strictEqual(r.status, 0, r.stderr);
        // Every field the hash covers is shown, the topic included.
        ok(r.stdout.includes('| id | label | verb | profile | branch | blocked_by | topic |'), r.stdout);
        ok(r.stdout.includes('| A | first | compose | backend | feat/a |  | the objective \\| with a pipe |'), r.stdout);
        ok(r.stdout.includes('| B |  | refine |  | feat/b | A |  |'), r.stdout);
        ok(r.stdout.includes(`plan_hash: ${expected}`), r.stdout);
        ok(r.stdout.includes('approval before: pending (awaiting_owner_gate=plan-approval)'), r.stdout);
        const envelope = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('{"workflowPath"')));
        strictEqual(envelope.plan_hash, expected);
        const fm = (await readWorkflow(filePath)).frontmatter;
        strictEqual(fm.plan_approval_status, 'approved');
        strictEqual(fm.plan_approval_plan_hash, expected);
        strictEqual(fm.awaiting_owner_gate, undefined);

        r = await run(shell, dir);
        strictEqual(r.status, 0, r.stderr);
        ok(r.stdout.includes('"noop":true'), r.stdout);
        ok(r.stdout.includes('approval before: approved'), r.stdout);
      });
    });

    it('escapes backslashes and every line break in a cell', async () => {
      await withRepo(async (dir) => {
        const { filePath } = await createWorkflow({
          repoRoot: dir, verb: 'plan', host: 'claude',
          gitBaseline: { branch: 'main', head: '0'.repeat(40), status_digest: '' },
          originalRequest: 'escaping fixture',
        });
        await setPlan({
          workflowPath: filePath, host: 'claude',
          subtasks: [{ id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending', topic: 'cr\rcrlf\r\nlf\nback\\slash' }],
        });
        const r = await run(shell, dir);
        strictEqual(r.status, 0, r.stderr);
        ok(r.stdout.includes('| A |  | compose |  | feat/a |  | cr\\ncrlf\\nlf\\nback\\\\slash |'), JSON.stringify(r.stdout));
        ok(!/\r/.test(r.stdout), 'no carriage return reaches the table');
      });
    });

    it('is refused while plan-conflict is set, and under an autopilot run, writing nothing', async () => {
      await withRepo(async (dir) => {
        const filePath = await plannedMacro(dir);
        await setAwaitingOwner({
          workflowPath: filePath, host: 'claude', gate: 'plan-conflict',
          pointer: `.agentic-plugins/state/orchestrator/workflows/${basename(filePath)}#ensemble-synthesis`,
        });
        const before = await readFile(filePath, 'utf8');
        let r = await run(shell, dir);
        strictEqual(r.status, 1);
        ok(r.stderr.includes('Plan-verify ensemble reported a conflict'), r.stderr);
        ok(r.stdout.includes('approval before: pending (awaiting_owner_gate=plan-conflict)'), r.stdout);
        r = await run(shell, dir, { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
        strictEqual(r.status, 1);
        ok(r.stderr.includes('refused under autopilot'), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before);
      });
    });

    it('finds the macro from a subtask branch, and by --workflow', async () => {
      await withRepo(async (dir) => {
        const filePath = await plannedMacro(dir);
        execFileSync('git', ['-C', dir, 'switch', '-q', '-c', 'feat/a']);
        let r = await run(shell, dir);
        strictEqual(r.status, 0, r.stderr);
        strictEqual((await readWorkflow(filePath)).frontmatter.plan_approval_status, 'approved');

        execFileSync('git', ['-C', dir, 'switch', '-q', '-c', 'unrelated']);
        r = await run(shell, dir);
        strictEqual(r.status, 1);
        ok(r.stderr.includes("No macro workflow on branch 'unrelated'"), r.stderr);
        r = await run(shell, dir, { EXPLICIT_WORKFLOW_ID: basename(filePath, '.md') });
        strictEqual(r.status, 0, r.stderr);
        ok(r.stdout.includes('"noop":true'), r.stdout);
        r = await run(shell, dir, { EXPLICIT_WORKFLOW_ID: '../archive/x' });
        strictEqual(r.status, 1);
        ok(r.stderr.includes('must be a basename-shaped workflow id'), r.stderr);
        deepStrictEqual(r.stdout, '');
      });
    });
  });
}

// /orchestrator:plan Phase 2. The plan write carries the verdict, so the
// conflict gate is set in the same write as the plan (the state tests cover
// what plan-set does with it); the second block records the note and the
// ensemble result and must fail when either write fails.
async function planPhase2Blocks() {
  const text = await readFile(resolve(ORCH_ROOT, 'commands/plan.md'), 'utf8');
  const from = text.indexOf('## Phase 2 — State finalize');
  ok(from >= 0, 'plan.md carries Phase 2');
  const blocks = [...text.slice(from).matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  ok(blocks.length >= 2, 'Phase 2 has the plan-set block and the note + ensemble block');
  return blocks;
}

describe('/orchestrator:plan passes its verdict to plan-set', () => {
  it('the plan-set block carries --verdict "$VERDICT", and no later block sets a gate', async () => {
    const [planSet, finalize] = await planPhase2Blocks();
    ok(/state\.mjs" plan-set \\[\s\S]*--verdict "\$VERDICT"/.test(planSet), planSet);
    ok(!finalize.includes('awaiting-owner-set'), 'the gate is not set in a separate write');
    ok(finalize.includes('--verdict "$VERDICT"'), 'the ensemble commit records the same verdict');
  });
});

for (const shell of SHELLS) {
  describe(`/orchestrator:plan plan-set block (${shell})`, () => {
    // The block makes its subtasks file with mktemp and has the model fill
    // it; a mktemp shim hands it a file the test has already written.
    const runPlanSet = async (dir, active, extra = {}) => {
      const bin = join(dir, '.test-bin');
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, 'mktemp'), '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_BASE"\n');
      await chmod(join(bin, 'mktemp'), 0o755);
      const base = join(dir, '.test-subtasks');
      await writeFile(`${base}.json`, JSON.stringify([
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' },
      ]));
      const env = {
        ...process.env, AGENTIC_ORCHESTRATOR_ROOT: ORCH_ROOT, PATH: `${bin}:${process.env.PATH}`,
        ACTIVE: active, FIXTURE_BASE: base, ...extra,
      };
      delete env.CLAUDE_PLUGIN_ROOT;
      delete env.AGENTIC_AUTOPILOT;
      if (!('VERDICT' in extra)) delete env.VERDICT;
      const [planSet] = await planPhase2Blocks();
      return spawnSync(shell, ['-c', planSet], { cwd: dir, encoding: 'utf8', env });
    };
    const newMacro = async (dir) => (await createWorkflow({
      repoRoot: dir, verb: 'plan', host: 'claude',
      gitBaseline: { branch: 'main', head: '0'.repeat(40), status_digest: '' },
      originalRequest: 'plan-set block fixture',
    })).filePath;

    it('a conflict verdict writes the plan at plan-conflict; another verdict at plan-approval', async () => {
      await withRepo(async (dir) => {
        const filePath = await newMacro(dir);
        let r = await runPlanSet(dir, filePath, { VERDICT: 'conflict' });
        strictEqual(r.status, 0, r.stderr);
        let fm = (await readWorkflow(filePath)).frontmatter;
        strictEqual(fm.plan.subtasks[0].id, 'A');
        strictEqual(fm.awaiting_owner_gate, 'plan-conflict');
        strictEqual(fm.awaiting_owner_pointer, `.agentic-plugins/state/orchestrator/workflows/${basename(filePath)}#ensemble-synthesis`);
        r = await runPlanSet(dir, filePath, { VERDICT: 'concerns' });
        strictEqual(r.status, 0, r.stderr);
        fm = (await readWorkflow(filePath)).frontmatter;
        strictEqual(fm.awaiting_owner_gate, 'plan-approval');
      });
    });

    it('refuses to write the plan when no verdict was set', async () => {
      await withRepo(async (dir) => {
        const filePath = await newMacro(dir);
        const before = await readFile(filePath, 'utf8');
        const r = await runPlanSet(dir, filePath);
        notStrictEqual(r.status, 0);
        ok(r.stderr.includes('verdict must be one of pass, concerns, conflict'), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before);
      });
    });
  });

  describe(`/orchestrator:plan note + ensemble block (${shell})`, () => {
    const runFinalize = async (dir, active, extra = {}) => {
      const env = {
        ...process.env, AGENTIC_ORCHESTRATOR_ROOT: ORCH_ROOT,
        ACTIVE: active, RUN_ID: 'macro-plan-20260930T000000Z-abcdef', VERDICT: 'pass', SUMMARY: 's', ...extra,
      };
      delete env.CLAUDE_PLUGIN_ROOT;
      delete env.AGENTIC_AUTOPILOT;
      const [, finalize] = await planPhase2Blocks();
      return spawnSync(shell, ['-c', finalize], { cwd: dir, encoding: 'utf8', env });
    };

    it('records the note and the ensemble result', async () => {
      await withRepo(async (dir) => {
        const filePath = await plannedMacro(dir);
        const r = await runFinalize(dir, filePath, { VERDICT: 'concerns' });
        strictEqual(r.status, 0, r.stderr);
        const fm = (await readWorkflow(filePath)).frontmatter;
        strictEqual(fm.ensemble_results.at(-1).verdict, 'concerns');
        strictEqual(fm.current_phase, 'phase-2-presented');
      });
    });

    it('fails when the ensemble commit fails', async () => {
      await withRepo(async (dir) => {
        const filePath = await plannedMacro(dir);
        const r = await runFinalize(dir, filePath, { RUN_ID: '' });
        notStrictEqual(r.status, 0);
        ok(r.stderr.includes('run_id must be a non-empty string'), r.stderr);
      });
    });

    it('stops when the append refuses a terminal macro, before the ensemble commit', async () => {
      await withRepo(async (dir) => {
        const filePath = await plannedMacro(dir);
        await setMacroTerminal({ workflowPath: filePath, host: 'claude', terminalPhase: 'aborted' });
        const r = await runFinalize(dir, filePath);
        notStrictEqual(r.status, 0);
        ok(r.stderr.includes('terminal macro is not revised'), r.stderr);
        strictEqual((await readWorkflow(filePath)).frontmatter.ensemble_results, undefined);
      });
    });
  });
}
