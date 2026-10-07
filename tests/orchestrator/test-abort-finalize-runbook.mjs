// tests/orchestrator/test-abort-finalize-runbook.mjs
//
// /orchestrator:abort and /orchestrator:finalize, run as the agent runs them:
// the ```bash blocks of a phase, in one bash process. test-abort.mjs and
// test-finalize.mjs call the state library directly, so they cannot see what
// the runbook's shell does with a failure. Three things it did wrong until
// ADR-0063 S0, found while removing the runbooks' `rm` and in its review:
//
//   1. Phase 0 read `$?` inside `if ! MACRO_PATH="$(…)"; then RC=$?` — the
//      status of the negation, which is always 0 — so a find-active or
//      find-macro failure ended the command with exit 0.
//   2. Step 2 handed its failure tally back through a temp file and skipped
//      the check when the file was missing, so a shim that died before writing
//      it let step 3 mark the macro terminal. The tally is now the shim's exit
//      status.
//   3. Phases 1–3 read what Phase 0 set, but nothing said to run them in one
//      shell; run one per Bash call, they called `/scripts/state.mjs` and
//      Phase 3 printed success anyway. The runbooks now say so, and each later
//      block stops when Phase 0 has not run in its shell.

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ORCH_ROOT = resolve(REPO_ROOT, 'plugins/orchestrator');
const ENGINEER_ROOT = resolve(REPO_ROOT, 'plugins/engineer');
const { createWorkflow, setPlan, readWorkflow } = await import(resolve(ORCH_ROOT, 'scripts/state.mjs'));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t.local',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t.local',
  GIT_CONFIG_NOSYSTEM: '1',
};

/** The ```bash blocks between `## <from>` and the next `## ` heading. */
function phaseBlocks(text, from) {
  // Contract: the tests below slice the blocks they run by these headings — a
  // renamed heading or an empty phase must fail here, not run nothing.
  const start = text.indexOf(`## ${from}`);
  ok(start >= 0, `no "## ${from}" heading`);
  const end = text.indexOf('\n## ', start + 1);
  const section = text.slice(start, end < 0 ? undefined : end);
  const blocks = [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  ok(blocks.length > 0, `"## ${from}" has no bash block`);
  return blocks.join('\n');
}

async function withRepo(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-abort-finalize-runbook-'));
  try {
    const work = join(dir, 'work');
    execFileSync('git', ['init', '-q', '-b', 'main', work], { env: GIT_ENV });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'base'], { cwd: work, env: GIT_ENV });
    await writeFile(join(work, '.git', 'info', 'exclude'), '.agentic-plugins/\n.claude/\n');
    const { filePath: macroPath } = await createWorkflow({
      repoRoot: work, verb: 'plan', host: 'claude',
      gitBaseline: { branch: 'main', head: '0'.repeat(40), status_digest: '' },
      originalRequest: 'abort/finalize runbook fixture',
    });
    const run = (script, env = {}) => spawnSync('bash', ['-c', `cd '${work}'\n${script}`], {
      encoding: 'utf8',
      env: {
        ...GIT_ENV,
        PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
        CLAUDE_PLUGIN_ROOT: ORCH_ROOT, AGENTIC_ENGINEER_ROOT: ENGINEER_ROOT, AGENTIC_HOST: 'claude', ...env,
      },
    });
    return await fn({ dir, work, macroPath, run });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** An orchestrator root whose state.mjs fails every call with status 7. */
async function failingOrchestrator(dir) {
  const root = join(dir, 'failing-orchestrator');
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'state.mjs'), 'process.stderr.write("state.mjs: boom\\n"); process.exit(7);\n');
  return root;
}

for (const command of ['abort', 'finalize']) {
  const text = await readFile(resolve(ORCH_ROOT, `commands/${command}.md`), 'utf8');
  const phase0 = phaseBlocks(text, 'Phase 0');
  const phase1 = phaseBlocks(text, 'Phase 1');
  const phase2 = phaseBlocks(text, 'Phase 2');
  const phase3 = phaseBlocks(text, 'Phase 3');
  const terminal = command === 'abort' ? { phase: 'aborted', subtask: 'abandoned' } : { phase: 'finalized', subtask: 'deferred' };

  describe(`/orchestrator:${command} runbook, run as the agent runs it`, () => {
    it('Phase 0 finds the macro on the current branch (control)', async () => {
      await withRepo(async ({ run, macroPath }) => {
        const r = run(phase0);
        strictEqual(r.status, 0, r.stderr);
        ok(r.stdout.includes(macroPath.split('/').pop().replace(/\.md$/, '')), r.stdout);
      });
    });

    it('Phase 0 ends with find-active\'s own status when it fails, and its error is shown', async () => {
      await withRepo(async ({ dir, run }) => {
        const r = run(phase0, { CLAUDE_PLUGIN_ROOT: await failingOrchestrator(dir) });
        strictEqual(r.status, 7, `status ${r.status}; stderr ${r.stderr}`);
        ok(r.stderr.includes('state.mjs: boom'), r.stderr);
      });
    });

    it('Step 2 lets step 3 run when no child needed archiving (control)', async () => {
      await withRepo(async ({ work, run }) => {
        await mkdir(join(work, '.agentic-plugins', 'state', 'engineer', 'workflows'), { recursive: true });
        const r = run(`${phase0}\n${phase2}`);
        strictEqual(r.status, 0, r.stderr);
      });
    });

    it('Step 2 refuses step 3 when the child pass fails', async () => {
      await withRepo(async ({ work, run }) => {
        // The canonical workflow home is a file, so listing it fails inside
        // the shim (ENOTDIR) — on every platform, as root or not.
        await mkdir(join(work, '.agentic-plugins', 'state', 'engineer'), { recursive: true });
        await writeFile(join(work, '.agentic-plugins', 'state', 'engineer', 'workflows'), 'not a directory\n');
        await mkdir(join(work, '.claude', 'agentic-engineer', 'workflows'), { recursive: true });
        const r = run(`${phase0}\n${phase2}`);
        strictEqual(r.status, 1, `status ${r.status}; stderr ${r.stderr}`);
        ok(r.stderr.includes('Step 2 did not archive every engineer child'), r.stderr);
      });
    });

    // Each Bash tool call is a fresh shell. Run on its own, a later block has
    // none of what Phase 0 set, and used to call `/scripts/state.mjs` and, in
    // Phase 3, print success anyway (Refine-verify finding, 2026-09-29).
    for (const [name, block] of [['Phase 1', phase1], ['Phase 2', phase2], ['Phase 3', phase3]]) {
      it(`${name} run in a shell of its own stops before it acts`, async () => {
        await withRepo(async ({ run, macroPath }) => {
          const before = await readFile(macroPath, 'utf8');
          const r = run(block);
          ok(r.status !== 0, `status ${r.status}`);
          ok(r.stderr.includes('run Phases 0–3 in one Bash invocation'), r.stderr);
          ok(!r.stdout.includes('✓ macro'), r.stdout);
          strictEqual(await readFile(macroPath, 'utf8'), before, 'the macro changed');
        });
      });
    }

    it('a child of the macro that cannot be read stops step 3', async () => {
      // Refine-verify finding (2026-09-29): the shim logged the read failure
      // and moved on without counting it, so the macro closed over a live child.
      await withRepo(async ({ work, run, macroPath }) => {
        const macroId = macroPath.split('/').pop().replace(/\.md$/, '');
        const home = join(work, '.agentic-plugins', 'state', 'engineer', 'workflows');
        await mkdir(home, { recursive: true });
        await writeFile(join(home, 'compose-20260929T000000Z-abcdef.md'),
          `---\nschema: "9.9"\nworkflow_id: "compose-20260929T000000Z-abcdef"\nparent_workflow: "${macroId}"\n---\n\n# child\n`);
        const r = run([phase0, phase1, phase2, phase3].join('\n'));
        strictEqual(r.status, 1, `status ${r.status}; stderr ${r.stderr}`);
        ok(r.stderr.includes('failed to read compose-20260929T000000Z-abcdef.md'), r.stderr);
        ok((await readWorkflow(macroPath)).frontmatter.terminal_marker !== true, 'the macro was marked terminal over the child');
      });
    });

    // With Phase 0's variables in place, a failed write in Phase 1 or Phase 3
    // ends the invocation with its status instead of reading as success.
    for (const [name, block] of [['Phase 1', phase1], ['Phase 3', phase3]]) {
      it(`${name} keeps the status of a failed write`, async () => {
        await withRepo(async ({ dir, run }) => {
          const failing = await failingOrchestrator(dir);
          const r = run(`${phase0}\nORCH_PLUGIN_ROOT='${failing}'\n${block}`);
          strictEqual(r.status, 7, `status ${r.status}; stderr ${r.stderr}`);
          ok(!r.stdout.includes('✓ macro'), r.stdout);
        });
      });
    }

    it('Phases 0–3 in one invocation close the subtasks and mark the macro terminal', async () => {
      await withRepo(async ({ work, run, macroPath }) => {
        await setPlan({ workflowPath: macroPath, host: 'claude', subtasks: [
          { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' },
        ] });
        await mkdir(join(work, '.agentic-plugins', 'state', 'engineer', 'workflows'), { recursive: true });
        const r = run([phase0, phase1, phase2, phase3].join('\n'));
        strictEqual(r.status, 0, r.stderr);
        const { frontmatter } = await readWorkflow(macroPath);
        strictEqual(frontmatter.terminal_marker, true);
        strictEqual(frontmatter.current_phase, terminal.phase);
        strictEqual(frontmatter.plan.subtasks[0].status, terminal.subtask);
      });
    });
  });
}
