// tests/orchestrator/test-done-runbook.mjs
//
// ADR-0062 — /orchestrator:done is the step that completes a subtask, so its
// runbook is exercised as written: every ```bash block of commands/done.md
// from Phase 0 up to Completion runs in one bash process (as the runbook
// requires), with the argument variables an agent would extract from
// $ARGUMENTS. git runs against a real bare "origin"; `gh` is a fake on PATH.

import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, chmod, readFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ORCH_ROOT = resolve(REPO_ROOT, 'plugins/orchestrator');
const { createWorkflow, setPlan, updateSubtask, readWorkflow } = await import(resolve(ORCH_ROOT, 'scripts/state.mjs'));

async function runbookScript() {
  const text = await readFile(resolve(ORCH_ROOT, 'commands/done.md'), 'utf8');
  const body = text.slice(text.indexOf('## Phase 0'), text.indexOf('## Completion'));
  const blocks = [...body.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  ok(blocks.length >= 5, `done.md phases carry their bash blocks (found ${blocks.length})`);
  return blocks.join('\n');
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t.local',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t.local',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

const ENGINEER_ID = 'compose-20260927T100000Z-abcdef';
// FAKE_GH_RETARGET, when set, rewrites the macro while gh "runs": a plan
// revision that lands between resolving the landing and writing it.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
if (process.env.FAKE_GH_RETARGET) {
  const p = process.env.FAKE_GH_RETARGET;
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('branch: "feat/a"', 'branch: "feat/a2"'));
}
process.stdout.write(fs.readFileSync(process.env.FAKE_GH_PRS, 'utf8'));
`;

async function withFixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-done-runbook-'));
  try {
    const origin = join(dir, 'origin.git');
    const work = join(dir, 'work');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: GIT_ENV });
    execFileSync('git', ['clone', '-q', origin, work], { env: GIT_ENV });
    git(work, 'commit', '-q', '--allow-empty', '-m', 'base');
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'switch', '-q', '-c', 'feat/a');
    git(work, 'commit', '-q', '--allow-empty', '-m', 'work');
    git(work, 'switch', '-q', 'main');
    git(work, 'commit', '-q', '--allow-empty', '-m', 'work (#7)');
    const squash = git(work, 'rev-parse', 'HEAD');
    git(work, 'commit', '-q', '--allow-empty', '-m', 'unrelated (#9)');
    const later = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '-q', 'origin', 'main');
    // Keep state files out of `git status` so nothing depends on them.
    await writeFile(join(work, '.git', 'info', 'exclude'), '.agentic-plugins/\n');

    const { filePath: macroPath } = await createWorkflow({
      repoRoot: work, verb: 'plan', host: 'claude',
      gitBaseline: { branch: 'main', head: '0'.repeat(40), status_digest: '' },
      originalRequest: 'done runbook fixture',
    });
    await setPlan({
      workflowPath: macroPath, host: 'claude',
      subtasks: [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress' },
        { id: 'B', verb: 'compose', branch: 'feat/b', blocked_by: ['A'], status: 'blocked' },
      ],
    });

    // The engineer child, as its Stop hook archives it.
    const engDir = join(work, '.agentic-plugins', 'state', 'engineer');
    const child = (home) => join(engDir, home, `${ENGINEER_ID}.md`);
    await mkdir(join(engDir, 'workflows'), { recursive: true });
    await mkdir(join(engDir, 'archive'), { recursive: true });
    const macroId = macroPath.split('/').pop().replace(/\.md$/, '');
    await writeFile(child('archive'), [
      '---', 'schema: "1.3"', `workflow_id: "${ENGINEER_ID}"`,
      `parent_workflow: "${macroId}"`, 'originating_subtask: "A"', '---', '', '# child', '',
    ].join('\n'));

    const bin = join(dir, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'gh'), FAKE_GH);
    await chmod(join(bin, 'gh'), 0o755);
    const prsFile = join(dir, 'prs.json');
    const pr = (over = {}) => ({
      number: 7, url: 'https://github.com/o/r/pull/7', state: 'MERGED', baseRefName: 'main',
      headRefName: 'feat/a', createdAt: '2026-09-27T10:30:00Z', mergeCommit: { oid: squash }, ...over,
    });
    const script = await runbookScript();

    // The agent writes the reason with its file-writing tool and names the
    // file in REASON_FILE; the runbook never sees the text as shell input.
    async function done(vars, { prs = [pr()], reason = null, env = {} } = {}) {
      await writeFile(prsFile, JSON.stringify(prs));
      const all = { EXPLICIT_SUBTASK_ID: 'A', ...vars };
      if (reason !== null) {
        const reasonFile = join(dir, 'reason.txt');
        await writeFile(reasonFile, reason);
        all.REASON_FILE = reasonFile;
      }
      // Single-quoted assignments, as an agent would write literal values.
      const assigns = Object.entries(all)
        .map(([k, v]) => `${k}='${String(v).replace(/'/g, "'\\''")}'`).join('\n');
      const full = `${assigns}\ncd '${work}'\n${script}`;
      const r = spawnSync('bash', ['-c', full], {
        encoding: 'utf8',
        env: {
          ...GIT_ENV,
          PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
          CLAUDE_PLUGIN_ROOT: ORCH_ROOT, AGENTIC_HOST: 'claude', FAKE_GH_PRS: prsFile, ...env,
        },
      });
      return { status: r.status, stderr: r.stderr, stdout: r.stdout };
    }
    const subtask = async (id = 'A') => (await readWorkflow(macroPath)).frontmatter.plan.subtasks.find((s) => s.id === id);

    return await fn({ dir, work, macroPath, squash, later, pr, done, subtask, child });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('/orchestrator:done runbook (ADR-0062)', () => {
  it('records the merge commit, finds the archived owner, and unblocks the successor', async () => {
    await withFixture(async ({ done, subtask, squash }) => {
      const r = await done({});
      strictEqual(r.status, 0, r.stderr);
      const a = await subtask('A');
      strictEqual(a.status, 'completed');
      strictEqual(a.commit, squash);
      strictEqual(a.pr_url, 'https://github.com/o/r/pull/7');
      strictEqual(a.engineer_workflow_id, ENGINEER_ID);
      strictEqual((await subtask('B')).status, 'pending');
    });
  });

  it('a second run changes nothing', async () => {
    await withFixture(async ({ done, macroPath }) => {
      strictEqual((await done({})).status, 0);
      const before = await readFile(macroPath, 'utf8');
      const again = await done({});
      strictEqual(again.status, 0, again.stderr);
      ok(/already completed/.test(again.stderr), again.stderr);
      strictEqual(await readFile(macroPath, 'utf8'), before);
    });
  });

  it('refuses while the pull request is open, and records nothing', async () => {
    await withFixture(async ({ done, subtask, pr }) => {
      const r = await done({}, { prs: [pr({ state: 'OPEN', mergeCommit: null })] });
      strictEqual(r.status, 1);
      ok(/Cannot record A yet — not_merged/.test(r.stderr), r.stderr);
      strictEqual((await subtask('A')).status, 'in_progress');
    });
  });

  it('--correct needs a reason, then records old and new with the reason verbatim', async () => {
    await withFixture(async ({ done, macroPath, pr, later, squash, dir }) => {
      strictEqual((await done({})).status, 0);
      const corrected = [pr({ mergeCommit: { oid: later } })];
      const bare = await done({ CORRECT: '1' }, { prs: corrected });
      strictEqual(bare.status, 1);
      ok(/need a reason/.test(bare.stderr), bare.stderr);

      const marker = join(dir, 'should-not-exist');
      const reason = `landed as ${later.slice(0, 7)}; "quoted" $(touch ${marker}) \`touch ${marker}\``;
      const r = await done({ CORRECT: '1' }, { prs: corrected, reason });
      strictEqual(r.status, 0, r.stderr);
      const { frontmatter, body } = await readWorkflow(macroPath);
      strictEqual(frontmatter.plan.subtasks[0].commit, later);
      ok(body.includes(`commit: "${squash}" -> "${later}"`), body);
      ok(body.includes(`Reason: ${reason}`), body);
      strictEqual(existsSync(marker), false, 'the reason is never evaluated by the shell');
    });
  });

  it('a reason that contains shell syntax or a heredoc-delimiter line is recorded, never run', async () => {
    await withFixture(async ({ done, macroPath, pr, later, dir }) => {
      strictEqual((await done({})).status, 0);
      const marker = join(dir, 'should-not-exist');
      const reason = `line one\nAGENTIC_DONE_REASON_EOF\ntouch ${marker}\nEOF\n$(touch ${marker})`;
      const r = await done({ CORRECT: '1' }, { prs: [pr({ mergeCommit: { oid: later } })], reason });
      strictEqual(r.status, 0, r.stderr);
      strictEqual(existsSync(marker), false, 'nothing in the reason ran');
      ok((await readWorkflow(macroPath)).body.includes(`Reason: ${reason}`));
    });
  });

  it('with the owner recovered from the archive, an older merge of the branch is not taken', async () => {
    await withFixture(async ({ done, subtask, pr }) => {
      const old = pr({ number: 3, url: 'https://github.com/o/r/pull/3', createdAt: '2026-09-01T00:00:00Z' });
      const r = await done({}, { prs: [old] });
      strictEqual(r.status, 1);
      ok(/no_pr/.test(r.stderr), r.stderr);
      strictEqual((await subtask('A')).status, 'in_progress');
      strictEqual((await subtask('B')).status, 'blocked');
    });
  });

  it('--workflow selects the macro explicitly under bash', async () => {
    await withFixture(async ({ done, subtask, macroPath }) => {
      const id = macroPath.split('/').pop().replace(/\.md$/, '');
      const r = await done({ EXPLICIT_WORKFLOW_ID: id });
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await subtask('A')).status, 'completed');
    });
  });

  it('--no-commit is refused while the engineer child is active, then completes with the reason', async () => {
    await withFixture(async ({ done, subtask, child, macroPath }) => {
      await rename(child('archive'), child('workflows'));
      const refused = await done({ NO_COMMIT: '1' }, { reason: 'investigation only; no code change' });
      strictEqual(refused.status, 1);
      ok(/still active/.test(refused.stderr), refused.stderr);
      strictEqual((await subtask('A')).status, 'in_progress');

      await rename(child('workflows'), child('archive'));
      const r = await done({ NO_COMMIT: '1' }, { reason: 'investigation only; no code change' });
      strictEqual(r.status, 0, r.stderr);
      const a = await subtask('A');
      strictEqual(a.status, 'completed');
      strictEqual('commit' in a, false);
      ok((await readWorkflow(macroPath)).body.includes('Reason: investigation only; no code change'));
    });
  });

  // A scan that cannot read a workflow home or file must refuse, not read the
  // failure as "no child": that would complete the subtask while its child is
  // still active (C3 review, G3). The faults are ones root cannot bypass. The
  // owner is recorded first so the --no-commit cases reach the active-child
  // scan rather than stopping at the owner scan.
  it('--no-commit refuses when an engineer workflow file cannot be read', async () => {
    await withFixture(async ({ done, subtask, work, macroPath }) => {
      await updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host: 'claude', engineerWorkflowId: ENGINEER_ID });
      await mkdir(join(work, '.agentic-plugins/state/engineer/workflows/compose-20260927T110000Z-bbbbbb.md'));
      const r = await done({ NO_COMMIT: '1' }, { reason: 'investigation only' });
      strictEqual(r.status, 1, r.stderr);
      ok(/could not scan the engineer workflow homes for an active child of A/i.test(r.stderr), r.stderr);
      strictEqual((await subtask('A')).status, 'in_progress');
    });
  });

  it('--no-commit refuses when an engineer workflow home cannot be listed', async () => {
    await withFixture(async ({ done, subtask, work, macroPath }) => {
      await updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host: 'claude', engineerWorkflowId: ENGINEER_ID });
      await mkdir(join(work, '.claude/agentic-engineer'), { recursive: true });
      await writeFile(join(work, '.claude/agentic-engineer/workflows'), 'not a directory\n');
      const r = await done({ NO_COMMIT: '1' }, { reason: 'investigation only' });
      strictEqual(r.status, 1, r.stderr);
      ok(/could not scan the engineer workflow homes for an active child of A/i.test(r.stderr), r.stderr);
      strictEqual((await subtask('A')).status, 'in_progress');
    });
  });

  it('the owner scan refuses when an engineer workflow file cannot be read, rather than guessing', async () => {
    await withFixture(async ({ done, subtask, work }) => {
      await mkdir(join(work, '.agentic-plugins/state/engineer/archive/compose-20260927T110000Z-bbbbbb.md'));
      const r = await done({});
      strictEqual(r.status, 1, r.stderr);
      ok(/could not scan the engineer workflow homes for A's owner/i.test(r.stderr), r.stderr);
      strictEqual((await subtask('A')).status, 'in_progress');
    });
  });

  it('--no-commit excludes --commit', async () => {
    await withFixture(async ({ done, squash }) => {
      const r = await done({ NO_COMMIT: '1', EXPLICIT_COMMIT: squash }, { reason: 'x' });
      strictEqual(r.status, 1);
      ok(/--no-commit excludes/.test(r.stderr), r.stderr);
    });
  });

  it('refuses to write when the plan moves the subtask while the landing is resolved', async () => {
    await withFixture(async ({ done, macroPath, subtask }) => {
      const r = await done({}, { env: { FAKE_GH_RETARGET: macroPath } });
      strictEqual(r.status, 1, r.stderr);
      ok(/not the expected "feat\/a"/.test(r.stderr), r.stderr);
      const a = await subtask('A');
      strictEqual(a.status, 'in_progress');
      strictEqual(a.branch, 'feat/a2');
    });
  });

  it('resolves the landing for the branch the plan records now, not an earlier one', async () => {
    await withFixture(async ({ done, macroPath, subtask }) => {
      // The plan moved A to feat/a2; the merged pull request is for feat/a.
      // (The write-time race is guarded by subtask-update --expect-branch,
      // covered in test-subtask-provenance.mjs.)
      await updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host: 'claude', engineerWorkflowId: ENGINEER_ID });
      const text = await readFile(macroPath, 'utf8');
      await writeFile(macroPath, text.replace('branch: "feat/a"', 'branch: "feat/a2"'));
      const r = await done({});
      ok(/no_pr/.test(r.stderr), r.stderr);
      strictEqual(r.status, 1);
      strictEqual((await subtask('A')).status, 'in_progress');
    });
  });
});
