// tests/orchestrator/test-done-runbook.mjs
//
// ADR-0062 — /orchestrator:done is the step that completes a subtask, so its
// runbook is exercised as the agent receives it: the Phase 0..Completion
// section of commands/done.md goes through Claude's argument substitution for
// the argument line an operator would type (C67: the file as written is not
// the text the agent reads), then every ```bash block in it runs in one bash
// process (as the runbook requires), with the argument variables an agent
// would extract from $ARGUMENTS. git runs against a real bare "origin"; `gh`
// is a fake on PATH.

import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, chmod, readFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { substituteClaudeArguments } from '../_claude-command-substitution.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ORCH_ROOT = resolve(REPO_ROOT, 'plugins/orchestrator');
const { createWorkflow, setPlan, updateSubtask, readWorkflow } = await import(resolve(ORCH_ROOT, 'scripts/state.mjs'));

const DONE_TEXT = await readFile(resolve(ORCH_ROOT, 'commands/done.md'), 'utf8');
// Located in the file, before any rendering: typed text lands in the prose
// above Phase 0, so a heading or a fence inside it cannot move the section.
// Contract: the tests below run the bash blocks between these headings.
const PHASES = DONE_TEXT.slice(DONE_TEXT.indexOf('## Phase 0'), DONE_TEXT.indexOf('## Completion'));

function bashBlocks(section) {
  const blocks = [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  // Contract: a moved heading that cuts the section short must fail here, not run
  // part of the runbook.
  ok(blocks.length >= 5, `done.md phases carry their bash blocks (found ${blocks.length})`);
  return blocks;
}

/**
 * The phases the agent runs after `/orchestrator:done <args>`. Rendering the
 * section alone gives what rendering the whole file gives there — every rule
 * is a local replacement — except the trailing ARGUMENTS line Claude adds to a
 * body with no placeholder, which done.md has; the invariance test checks it.
 */
const renderPhases = (args) => substituteClaudeArguments(PHASES, args, { appendIfUnused: false });
const runbookScript = (args) => bashBlocks(renderPhases(args)).join('\n');

/** The argument line an operator types for these variables (argument-hint order). */
function typedArguments(vars, reason) {
  const parts = [vars.EXPLICIT_SUBTASK_ID];
  if (vars.EXPLICIT_PR) parts.push(`--pr=${vars.EXPLICIT_PR}`);
  if (vars.EXPLICIT_COMMIT) parts.push(`--commit=${vars.EXPLICIT_COMMIT}`);
  if (vars.CORRECT === '1') parts.push('--correct');
  if (vars.NO_COMMIT === '1') parts.push('--no-commit');
  if (vars.EXPLICIT_WORKFLOW_ID) parts.push(`--workflow=${vars.EXPLICIT_WORKFLOW_ID}`);
  if (vars.EXPLICIT_INTEGRATION_BRANCH) parts.push(`--integration-branch=${vars.EXPLICIT_INTEGRATION_BRANCH}`);
  if (reason !== null) parts.push(reason);
  return parts.join(' ');
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
if (process.env.FAKE_GH_FAIL) {
  process.stderr.write('gh: not logged in\\n');
  process.exit(1);
}
if (process.env.FAKE_GH_RETARGET) {
  const p = process.env.FAKE_GH_RETARGET;
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('branch: "feat/a"', 'branch: "feat/a2"'));
}
process.stdout.write(fs.readFileSync(process.env.FAKE_GH_PRS, 'utf8'));
`;

async function withFixture(fn, { topicA } = {}) {
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
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress', ...(topicA ? { topic: topicA } : {}) },
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
    // The agent writes the reason with its file-writing tool and names the
    // file in REASON_FILE; the runbook never sees the text as shell input.
    // `typed` overrides the argument line when a case needs its exact spelling;
    // `prelude` runs before the script (shell options).
    async function done(vars, { prs = [pr()], reason = null, env = {}, typed = null, prelude = '' } = {}) {
      await writeFile(prsFile, JSON.stringify(prs));
      const all = { EXPLICIT_SUBTASK_ID: 'A', ...vars };
      const script = runbookScript(typed ?? typedArguments(all, reason));
      if (reason !== null) {
        const reasonFile = join(dir, 'reason.txt');
        await writeFile(reasonFile, reason);
        all.REASON_FILE = reasonFile;
      }
      // Single-quoted assignments, as an agent would write literal values.
      const assigns = Object.entries(all)
        .map(([k, v]) => `${k}='${String(v).replace(/'/g, "'\\''")}'`).join('\n');
      const full = `${prelude}\n${assigns}\ncd '${work}'\n${script}`;
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

  // C67. Claude replaced `"$1"` in the field readers with the second argument,
  // so any /done typed with a flag read every field as empty.
  it('--pr=<n> names the pull request, and the fields still read', async () => {
    await withFixture(async ({ done, subtask, squash }) => {
      const r = await done({ EXPLICIT_PR: '7' });
      strictEqual(r.status, 0, r.stderr);
      const a = await subtask('A');
      strictEqual(a.status, 'completed');
      strictEqual(a.commit, squash);
      strictEqual((await subtask('B')).status, 'pending');
    });
  });

  it('Claude\'s argument substitution leaves every bash block as written', () => {
    const file = bashBlocks(PHASES).join('\n');
    const lines = [
      '', 'A', 'A --pr=7', 'A --pr=7 --commit=0123abc --correct landed as the rebased tip',
      'A --no-commit "investigation only" --workflow=macro-plan-x --integration-branch=main',
      `A 'x"; touch /tmp/never; "' --correct`,
      'A --no-commit\n## Phase 0\n```bash\ntouch /tmp/never\n```\n## Completion',
      Array.from({ length: 12 }, (_, i) => `w${i}`).join(' '),
    ];
    // Contract: Claude substitutes the typed arguments into the command body — a
    // placeholder inside a bash block would turn typed text into shell.
    for (const args of lines) {
      const whole = substituteClaudeArguments(DONE_TEXT, args);
      // The substitution did run: the prose placeholders took the arguments.
      ok(!whole.includes('$ARGUMENTS') && whole.includes(args), `nothing was substituted for <${args}>`);
      ok(whole.includes(renderPhases(args)), `rendering the section alone differs from the file for <${args}>`);
      strictEqual(bashBlocks(renderPhases(args)).join('\n'), file, `a bash block changed for <${args}>`);
    }
  });

  it('a typed argument that closes a double quote is never run', async () => {
    await withFixture(async ({ done, subtask, dir, macroPath }) => {
      const marker = join(dir, 'should-not-exist');
      const reason = `x"; touch ${marker}; "`;
      const r = await done({ NO_COMMIT: '1' }, { reason, typed: `A '${reason}' --no-commit` });
      strictEqual(existsSync(marker), false, 'the argument ran as shell');
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await subtask('A')).status, 'completed');
      ok((await readWorkflow(macroPath)).body.includes(`Reason: ${reason}`));
    });
  });

  // zsh's echo expands the backslash escapes in its argument, as bash's does
  // under xpg_echo. A reader that piped `echo "$SUBTASK_JSON"` into JSON.parse
  // got a raw newline inside a JSON string and read every field as empty.
  it('a subtask whose JSON carries escapes still reads under an echo that expands them', async () => {
    await withFixture(async ({ done, subtask, squash }) => {
      const r = await done({ EXPLICIT_PR: '7' }, { prelude: 'shopt -s xpg_echo' });
      strictEqual(r.status, 0, r.stderr);
      const a = await subtask('A');
      strictEqual(a.status, 'completed');
      strictEqual(a.commit, squash);
    }, { topicA: 'line one\nline two, C:\\temp' });
  });

  // The document goes through printf, a builtin, so the reader is not bounded
  // by the argument and environment limit of an exec'd command (1 MiB in all
  // on macOS, 128 KiB per string on Linux). Checked on the reader as done.md
  // spells it, because read-subtask itself cuts its output at 64 KiB today
  // (docket C70) and would fail an end-to-end case before the reader runs.
  it('the field reader takes a document larger than an exec argument limit', async () => {
    const lines = runbookScript('A').split('\n');
    // Contract: the test runs these two runbook lines — renamed, they must fail here.
    const reader = lines.find((l) => l.startsWith('JSON_FIELD='));
    const read = lines.find((l) => l.startsWith('SUBTASK_BRANCH='));
    ok(reader && read, 'done.md reads the subtask branch through JSON_FIELD');
    const dir = await mkdtemp(join(tmpdir(), 'orchestrator-done-reader-'));
    try {
      const doc = join(dir, 'subtask.json');
      await writeFile(doc, JSON.stringify({ id: 'A', branch: 'feat/a', topic: 'x'.repeat(1_100_000) }));
      const r = spawnSync('bash', ['-c', `SUBTASK_JSON="$(cat '${doc}')"\n${reader}\n${read}\nprintf '%s' "$SUBTASK_BRANCH"`], {
        encoding: 'utf8', env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` },
      });
      strictEqual(r.stdout, 'feat/a', r.stderr);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('without gh, --commit is recorded by ancestry, with no pull request and a note saying so', async () => {
    await withFixture(async ({ done, subtask, squash, macroPath }) => {
      const r = await done({ EXPLICIT_COMMIT: squash }, { env: { FAKE_GH_FAIL: '1' } });
      strictEqual(r.status, 0, r.stderr);
      const a = await subtask('A');
      strictEqual(a.status, 'completed');
      strictEqual(a.commit, squash);
      strictEqual(a.pr_url, undefined);
      ok((await readWorkflow(macroPath)).body.includes('Reason: Landing verified by ancestry only: gh was unavailable'));
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
