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
import { deepStrictEqual, strictEqual, ok, rejects } from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, chmod, readFile, rename, symlink } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
  // An id holding a double quote is typed inside single quotes.
  const parts = [vars.EXPLICIT_SUBTASK_ID.includes('"') ? `'${vars.EXPLICIT_SUBTASK_ID}'` : vars.EXPLICIT_SUBTASK_ID];
  if (vars.EXPLICIT_PR) parts.push(`--pr=${vars.EXPLICIT_PR}`);
  if (vars.EXPLICIT_COMMIT) parts.push(`--commit=${vars.EXPLICIT_COMMIT}`);
  if (vars.CORRECT === '1') parts.push('--correct');
  if (vars.NO_COMMIT === '1') parts.push('--no-commit');
  if (vars.WAIVE_DISPATCH === '1') parts.push('--waive-dispatch');
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

async function withFixture(fn, { topicA, idA = 'A' } = {}) {
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
        { id: idA, verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress', ...(topicA ? { topic: topicA } : {}) },
        { id: 'B', verb: 'compose', branch: 'feat/b', blocked_by: [idA], status: 'blocked' },
      ],
    });

    // The engineer child, as its Stop hook archives it.
    const engDir = join(work, '.agentic-plugins', 'state', 'engineer');
    const child = (home) => join(engDir, home, `${ENGINEER_ID}.md`);
    await mkdir(join(engDir, 'workflows'), { recursive: true });
    await mkdir(join(engDir, 'archive'), { recursive: true });
    const macroId = macroPath.split('/').pop().replace(/\.md$/, '');
    await writeFile(child('archive'), [
      // Created on its subtask's branch, as /orchestrator:next creates it; it
      // predates the dispatch record (ADR-0067 Decision 4, item 5), so the
      // scan judges it by that branch.
      '---', 'schema: "1.3"', `workflow_id: "${ENGINEER_ID}"`,
      'git_baseline:', '  branch: "feat/a"', `  head: "${'0'.repeat(40)}"`, '  status_digest: ""',
      `parent_workflow: "${macroId}"`, `originating_subtask: ${JSON.stringify(idA)}`, '---', '', '# child', '',
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
      const all = { EXPLICIT_SUBTASK_ID: idA, ...vars };
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
    const subtask = async (id = idA) => (await readWorkflow(macroPath)).frontmatter.plan.subtasks.find((s) => s.id === id);

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

  // ADR-0067 Decision 4, item 5 — the owner Phase 2's scan finds is bound by
  // done's write. Contract: the scan reads the dispatch the child records (or
  // the branch it was created on, for a child that predates the record) and
  // the write is refused under the macro's file lock when a plan revision
  // changed the subtask since; nothing is bound or completed. The completed
  // case above is the unrevised control.
  // The same for an owner the subtask already records (bound normally, the plan
  // revised afterwards with the owner kept): done completes the subtask in that
  // owner's name, so it compares the dispatch the owner records; the unrevised
  // case is the control.
  const TOPIC_WHY = 'topic is "a revised topic"; the child was dispatched for "the topic"';
  for (const [label, recorded, revision, why, noCommit, owned] of [
    ['a child that predates the record, the branch revised (--no-commit)', false, { branch: 'feat/a2' }, 'branch is "feat/a2"; the child was dispatched for "feat/a"', true, false],
    ['a recorded dispatch, the topic revised (--no-commit)', true, { topic: 'a revised topic' }, TOPIC_WHY, true, false],
    ['a recorded dispatch, the topic revised (the landing)', true, { topic: 'a revised topic' }, TOPIC_WHY, false, false],
    ['the owner recorded on the subtask, the topic revised (--no-commit)', true, { topic: 'a revised topic' }, TOPIC_WHY, true, true],
    ['the owner recorded on the subtask, the topic revised (the landing)', true, { topic: 'a revised topic' }, TOPIC_WHY, false, true],
    ['the owner recorded on the subtask, unrevised (the landing; control)', true, null, null, false, true],
  ]) {
    it(`${owned ? 'a recorded owner' : 'an owner the scan finds'} is not bound to a subtask revised since its dispatch: ${label}`, async () => {
      await withFixture(async ({ done, subtask, child, macroPath }) => {
        if (recorded) {
          const text = await readFile(child('archive'), 'utf8');
          await writeFile(child('archive'), text.replace('originating_subtask: "A"\n', 'originating_subtask: "A"\ndispatched_branch: "feat/a"\ndispatched_verb: "compose"\ndispatched_profile: ""\ndispatched_topic: "the topic"\n'));
        }
        await setPlan({
          workflowPath: macroPath, host: 'claude',
          subtasks: [
            {
              id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress', topic: 'the topic',
              ...(owned ? { engineer_workflow_id: ENGINEER_ID } : {}), ...revision,
            },
            { id: 'B', verb: 'compose', branch: 'feat/b', blocked_by: ['A'], status: 'blocked' },
          ],
        });
        const before = await readFile(macroPath, 'utf8');
        const r = noCommit ? await done({ NO_COMMIT: '1' }, { reason: 'investigation only' }) : await done({});
        if (!revision) {
          strictEqual(r.status, 0, r.stderr);
          strictEqual((await subtask('A')).status, 'completed');
          return;
        }
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes(`(dispatch-changed): ${why}`), r.stderr);
        strictEqual(await readFile(macroPath, 'utf8'), before);
        strictEqual((await subtask('A')).engineer_workflow_id, owned ? ENGINEER_ID : undefined);
        strictEqual((await subtask('A')).status, 'in_progress');
      });
    });
  }

  // A scan that cannot read a workflow home or file must refuse, not read the
  // failure as "no child": that would complete the subtask while its child is
  // still active (C3 review, G3). The faults are ones root cannot bypass. Since
  // the owner's dispatch is read from the owner scan whatever the owner
  // (ADR-0067 Decision 4, item 5), a fault present from the start stops Phase
  // 2; one that appears while `admission join` runs (a shim plugin root makes
  // it, then hands every call to the real state.mjs) reaches the active-child
  // scan after the join, the rule these cases hold.
  const faultDuringJoin = async (dir, fault) => {
    const shim = join(dir, 'shim-root');
    await mkdir(join(shim, 'scripts'), { recursive: true });
    await writeFile(join(shim, 'scripts', 'state.mjs'), [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      'const args = process.argv.slice(2);',
      `if (args[0] === 'admission' && args[1] === 'join') { ${fault} }`,
      `const r = spawnSync(process.execPath, [${JSON.stringify(resolve(ORCH_ROOT, 'scripts/state.mjs'))}, ...args], { stdio: 'inherit' });`,
      'process.exit(r.status ?? 1);',
    ].join('\n'));
    return { CLAUDE_PLUGIN_ROOT: shim, AGENTIC_ORCHESTRATOR_ROOT: shim };
  };
  for (const [what, fault] of [
    ['an engineer workflow file cannot be read', (work) => `mkdirSync(${JSON.stringify(join(work, '.agentic-plugins/state/engineer/workflows/compose-20260927T110000Z-bbbbbb.md'))}, { recursive: true });`],
    ['an engineer workflow home cannot be listed', (work) => `mkdirSync(${JSON.stringify(join(work, '.claude/agentic-engineer'))}, { recursive: true }); writeFileSync(${JSON.stringify(join(work, '.claude/agentic-engineer/workflows'))}, 'not a directory\\n');`],
  ]) {
    it(`--no-commit refuses when ${what}`, async () => {
      await withFixture(async ({ done, subtask, work, macroPath, dir }) => {
        await updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host: 'claude', engineerWorkflowId: ENGINEER_ID });
        const r = await done({ NO_COMMIT: '1' }, { reason: 'investigation only', env: await faultDuringJoin(dir, fault(work)) });
        strictEqual(r.status, 1, r.stderr);
        ok(/could not scan the engineer workflow homes for an active child of A/i.test(r.stderr), r.stderr);
        strictEqual((await subtask('A')).status, 'in_progress');
        deepStrictEqual(sessionEntries(work, macroPath), [], 'released on that refusal');
      });
    });
  }

  it('with the owner recorded, a fault present from the start stops the owner scan', async () => {
    await withFixture(async ({ done, subtask, work, macroPath }) => {
      await updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host: 'claude', engineerWorkflowId: ENGINEER_ID });
      await mkdir(join(work, '.agentic-plugins/state/engineer/workflows/compose-20260927T110000Z-bbbbbb.md'));
      const r = await done({ NO_COMMIT: '1' }, { reason: 'investigation only' });
      strictEqual(r.status, 1, r.stderr);
      ok(/could not scan the engineer workflow homes for A's owner/i.test(r.stderr), r.stderr);
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

  // R1 (refine-verify-20261009T035420Z-ed9f8f) — the dispatch of a recorded
  // owner whose file is gone cannot be read (a lane's home removed, say), so
  // the comparison cannot run: done refuses, and only --waive-dispatch with a
  // reason completes, the macro recording both. Contract: the refusal writes
  // nothing on either write path; the waiver is the one way through.
  for (const [label, vars] of [['the landing', {}], ['--no-commit', { NO_COMMIT: '1' }]]) {
    it(`a recorded owner with no file left refuses; --waive-dispatch with a reason completes and is recorded (${label})`, async () => {
      await withFixture(async ({ done, subtask, child, macroPath }) => {
        await updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host: 'claude', engineerWorkflowId: ENGINEER_ID });
        await rm(child('archive'));
        const before = await readFile(macroPath, 'utf8');
        const refused = await done(vars, { reason: vars.NO_COMMIT ? 'investigation only' : null });
        strictEqual(refused.status, 1, refused.stderr);
        ok(refused.stderr.includes(`recorded owner ${ENGINEER_ID} has no workflow file left`), refused.stderr);
        ok(refused.stderr.includes('rerun with --waive-dispatch and a reason'), refused.stderr);
        strictEqual(await readFile(macroPath, 'utf8'), before);
        const bare = await done({ ...vars, WAIVE_DISPATCH: '1' });
        strictEqual(bare.status, 1, bare.stderr);
        ok(/need a reason/.test(bare.stderr), bare.stderr);
        strictEqual(await readFile(macroPath, 'utf8'), before);
        const reason = 'the lane that held the child was removed; the merged pull request is the work';
        const r = await done({ ...vars, WAIVE_DISPATCH: '1' }, { reason });
        strictEqual(r.status, 0, r.stderr);
        strictEqual((await subtask('A')).status, 'completed');
        const { body } = await readWorkflow(macroPath);
        ok(body.includes(`Dispatch not compared (--waive-dispatch): the dispatch recorded by "${ENGINEER_ID}" could not be read`), body);
        ok(body.includes(`Reason: ${reason}`), body);
      });
    });
  }

  it('--waive-dispatch is refused while the owner\'s dispatch can be read, and nothing is written', async () => {
    await withFixture(async ({ done, subtask, macroPath }) => {
      await updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host: 'claude', engineerWorkflowId: ENGINEER_ID });
      const before = await readFile(macroPath, 'utf8');
      const r = await done({ WAIVE_DISPATCH: '1' }, { reason: 'nothing to waive' });
      strictEqual(r.status, 1, r.stderr);
      ok(r.stderr.includes("--waive-dispatch applies only when the owner's dispatch cannot be read"), r.stderr);
      strictEqual(await readFile(macroPath, 'utf8'), before);
      strictEqual((await subtask('A')).status, 'in_progress');
    });
  });

  it('a recorded owner whose file claims another subtask refuses, --waive-dispatch or not', async () => {
    await withFixture(async ({ done, subtask, child, macroPath }) => {
      await updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host: 'claude', engineerWorkflowId: ENGINEER_ID });
      const text = await readFile(child('archive'), 'utf8');
      await writeFile(child('archive'), text.replace('originating_subtask: "A"', 'originating_subtask: "B"'));
      const before = await readFile(macroPath, 'utf8');
      for (const vars of [{}, { WAIVE_DISPATCH: '1' }]) {
        const r = await done(vars, { reason: vars.WAIVE_DISPATCH ? 'complete it anyway' : null });
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes(`recorded owner ${ENGINEER_ID} was not dispatched for it`) && r.stderr.includes('originating_subtask=B'), r.stderr);
        strictEqual(await readFile(macroPath, 'utf8'), before);
        strictEqual((await subtask('A')).status, 'in_progress');
      }
    });
  });

  // R3 — the owner scan parses frontmatter values: a subtask id holding a quote
  // is written with a JSON escape, which matching the serialized text never
  // found, so its recorded owner read as missing. Contract: such an id is found
  // by its value on both paths, compared like any other, and --no-commit sees
  // its active child (the same reading).
  const QUOTED = 'A"1';
  it('a subtask id holding a quote: the claimant is found by its value and the subtask completes', async () => {
    await withFixture(async ({ done, subtask }) => {
      const r = await done({});
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await subtask()).status, 'completed');
      strictEqual((await subtask()).engineer_workflow_id, ENGINEER_ID);
    }, { idA: QUOTED });
  });

  it('a subtask id holding a quote: its recorded owner\'s dispatch is read and compared, and a revision refuses', async () => {
    await withFixture(async ({ done, subtask, macroPath }) => {
      await updateSubtask({ workflowPath: macroPath, subtaskId: QUOTED, host: 'claude', engineerWorkflowId: ENGINEER_ID });
      await setPlan({
        workflowPath: macroPath, host: 'claude',
        subtasks: [
          { id: QUOTED, verb: 'compose', branch: 'feat/a2', blocked_by: [], status: 'in_progress', engineer_workflow_id: ENGINEER_ID },
          { id: 'B', verb: 'compose', branch: 'feat/b', blocked_by: [QUOTED], status: 'blocked' },
        ],
      });
      const before = await readFile(macroPath, 'utf8');
      const r = await done({ NO_COMMIT: '1' }, { reason: 'investigation only' });
      strictEqual(r.status, 1, r.stderr);
      ok(r.stderr.includes('(dispatch-changed): branch is "feat/a2"; the child was dispatched for "feat/a"'), r.stderr);
      strictEqual(await readFile(macroPath, 'utf8'), before);
    }, { idA: QUOTED });
  });

  it('a subtask id holding a quote: --no-commit refuses while its child is active', async () => {
    await withFixture(async ({ done, subtask, child }) => {
      await rename(child('archive'), child('workflows'));
      const r = await done({ NO_COMMIT: '1' }, { reason: 'investigation only' });
      strictEqual(r.status, 1, r.stderr);
      ok(/still active/.test(r.stderr), r.stderr);
      strictEqual((await subtask()).status, 'in_progress');
    }, { idA: QUOTED });
  });

  // A topic holding U+2028, a line terminator to a regular expression but not
  // to the engineer's line-per-key frontmatter, is read whole.
  it('a recorded dispatch whose topic holds U+2028 is read whole, and the unrevised subtask completes', async () => {
    const topic = 'one two';
    await withFixture(async ({ done, subtask, child }) => {
      const text = await readFile(child('archive'), 'utf8');
      await writeFile(child('archive'), text.replace('originating_subtask: "A"\n', `originating_subtask: "A"\ndispatched_branch: "feat/a"\ndispatched_verb: "compose"\ndispatched_profile: ""\ndispatched_topic: ${JSON.stringify(topic)}\n`));
      const r = await done({});
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await subtask()).status, 'completed');
    }, { topicA: topic });
  });

  // R2 — two archived attempts claim the subtask (a re-dispatch after the first
  // child was archived). done refuses and prints, for each claimant, a binding
  // line that carries that claimant's dispatch, so a plan revised since refuses
  // the binding as every binding does. Contract: the line runs as printed in
  // bash and zsh, a topic with quotes and shell syntax included; the unrevised
  // binding and done are the control.
  it('two claimants: each binding line carries its dispatch, refuses a revised subtask, and binds an unrevised one', async () => {
    const topic = `it's "quoted" $HOME \`true\``;
    await withFixture(async ({ done, subtask, child, macroPath }) => {
      const second = 'compose-20260927T100500Z-bbbbbb';
      const recorded = (await readFile(child('archive'), 'utf8')).replace('originating_subtask: "A"\n', `originating_subtask: "A"\ndispatched_branch: "feat/a"\ndispatched_verb: "compose"\ndispatched_profile: ""\ndispatched_topic: ${JSON.stringify(topic)}\n`);
      await writeFile(child('archive'), recorded);
      await writeFile(join(dirname(child('archive')), `${second}.md`), recorded.replace(ENGINEER_ID, second));
      const refused = await done({});
      strictEqual(refused.status, 1, refused.stderr);
      ok(refused.stderr.includes('More than one engineer workflow claims A'), refused.stderr);
      const lines = refused.stderr.split('\n').filter((l) => l.startsWith('    node '));
      strictEqual(lines.length, 2, refused.stderr);
      ok(lines.every((l) => l.includes('--expect-dispatch=')), refused.stderr);
      const line = lines.find((l) => l.includes(second)).trim();
      const plan = (over) => setPlan({
        workflowPath: macroPath, host: 'claude',
        subtasks: [
          { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress', topic, ...over },
          { id: 'B', verb: 'compose', branch: 'feat/b', blocked_by: ['A'], status: 'blocked' },
        ],
      });
      const shells = ['bash', ...(spawnSync('zsh', ['-c', 'true']).status === 0 ? ['zsh'] : [])];
      const run = (shell) => spawnSync(shell, ['-c', line], { encoding: 'utf8', env: { ...GIT_ENV, PATH: `${dirname(process.execPath)}:${process.env.PATH}` } });
      // A plan revision after the refusal: the binding refuses in every shell.
      await plan({ topic: 'a revised topic' });
      const before = await readFile(macroPath, 'utf8');
      for (const shell of shells) {
        const bind = run(shell);
        strictEqual(bind.status, 1, `${shell}: ${bind.stderr}`);
        ok(bind.stderr.includes(`(dispatch-changed): topic is "a revised topic"; the child was dispatched for ${JSON.stringify(topic)}`), `${shell}: ${bind.stderr}`);
        strictEqual(await readFile(macroPath, 'utf8'), before);
      }
      // Revised back: the line binds the chosen claimant, and done completes it.
      await plan({});
      const bound = run(shells[shells.length - 1]);
      strictEqual(bound.status, 0, bound.stderr);
      strictEqual((await subtask()).engineer_workflow_id, second);
      const r = await done({});
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await subtask()).status, 'completed');
    });
  });

  it('the waiver needs a reason, names an owner, and excludes a dispatch to compare (updateSubtask)', async () => {
    await withFixture(async ({ macroPath }) => {
      const base = { workflowPath: macroPath, subtaskId: 'A', host: 'claude', engineerWorkflowId: ENGINEER_ID, status: 'completed', closedAt: '2026-10-09T00:00:00Z', waiveDispatch: true };
      const before = await readFile(macroPath, 'utf8');
      await rejects(updateSubtask(base), /--waive-dispatch requires a non-empty reason/);
      await rejects(updateSubtask({ ...base, reason: 'gone', engineerWorkflowId: undefined }), /--waive-dispatch names no owner/);
      await rejects(updateSubtask({ ...base, reason: 'gone', expectDispatch: { macro: 'm', subtask: 'A', branch: 'feat/a' } }), /not both/);
      strictEqual(await readFile(macroPath, 'utf8'), before);
    });
  });

  // A name the scan cannot resolve (a link to itself) is no absence either.
  it('the owner scan refuses when an engineer workflow name is a link loop, rather than guessing', async () => {
    await withFixture(async ({ done, subtask, work }) => {
      const home = join(work, '.agentic-plugins/state/engineer/archive');
      await symlink('compose-20260927T110000Z-bbbbbb.md', join(home, 'compose-20260927T110000Z-bbbbbb.md'));
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

  // ADR-0067 Decision 4, item 5 — the write joins the macro's run lock first.
  const sessionEntries = (work, macroPath) => {
    const lock = join(work, '.agentic-plugins/runs/autopilot/locks', `${macroPath.split('/').pop().replace(/\.md$/, '')}.lock`);
    return existsSync(lock) ? readdirSync(lock).filter((n) => /^s-[0-9a-f]{32}\.json$/.test(n)) : [];
  };
  const holdAsSession = (work, macroPath) => execFileSync(process.execPath, [
    resolve(ORCH_ROOT, 'scripts/state.mjs'), 'admission', 'join', '--macro', macroPath.split('/').pop().replace(/\.md$/, ''),
    '--checkout', work, '--command', 'finalize', '--host', 'codex',
  ], { encoding: 'utf8', env: GIT_ENV, stdio: 'pipe' }).trim();

  it('a session holding the macro lock refuses the write, naming it; nothing is written and its entry is kept', async () => {
    await withFixture(async ({ done, subtask, work, macroPath }) => {
      const other = holdAsSession(work, macroPath);
      for (const vars of [{}, { NO_COMMIT: '1' }]) {
        const r = await done(vars, { reason: vars.NO_COMMIT ? 'investigation only' : null });
        strictEqual(r.status, 1, r.stderr);
        ok(new RegExp(`an interactive session holds .*/orchestrator:finalize, .*host codex, .*admission ${other}`).test(r.stderr), r.stderr);
        strictEqual((await subtask('A')).status, 'in_progress');
        deepStrictEqual(sessionEntries(work, macroPath), [`s-${other}.json`]);
      }
    });
  });

  it('every exit after the join releases: a recorded landing, a --no-commit completion, and a write refused after the join', async () => {
    await withFixture(async ({ done, subtask, work, macroPath }) => {
      const refused = await done({}, { env: { FAKE_GH_RETARGET: macroPath } });
      strictEqual(refused.status, 1, refused.stderr);
      ok(/not the expected "feat\/a"/.test(refused.stderr), refused.stderr);
      deepStrictEqual(sessionEntries(work, macroPath), [], 'released after the refused write');
    });
    await withFixture(async ({ done, subtask, work, macroPath }) => {
      const r = await done({});
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await subtask('A')).status, 'completed');
      deepStrictEqual(sessionEntries(work, macroPath), [], 'released after the landing');
    });
    await withFixture(async ({ done, subtask, work, macroPath }) => {
      const r = await done({ NO_COMMIT: '1' }, { reason: 'investigation only' });
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await subtask('A')).status, 'completed');
      deepStrictEqual(sessionEntries(work, macroPath), [], 'released after the --no-commit completion');
    });
  });

  // A shim plugin root whose state.mjs moves the child back into the active
  // home while `admission join` runs, then hands every call to the real one:
  // a run's step that dispatched the subtask again between the check and the join.
  it('--no-commit reads the active children again after the join, and a child made meanwhile refuses and releases', async () => {
    await withFixture(async ({ done, subtask, work, macroPath, child, dir }) => {
      const shim = join(dir, 'shim-root');
      await mkdir(join(shim, 'scripts'), { recursive: true });
      await writeFile(join(shim, 'scripts', 'state.mjs'), [
        "import { renameSync } from 'node:fs';",
        "import { spawnSync } from 'node:child_process';",
        'const args = process.argv.slice(2);',
        `if (args[0] === 'admission' && args[1] === 'join') renameSync(${JSON.stringify(child('archive'))}, ${JSON.stringify(child('workflows'))});`,
        `const r = spawnSync(process.execPath, [${JSON.stringify(resolve(ORCH_ROOT, 'scripts/state.mjs'))}, ...args], { stdio: 'inherit' });`,
        'process.exit(r.status ?? 1);',
      ].join('\n'));
      const r = await done({ NO_COMMIT: '1' }, { reason: 'investigation only', env: { CLAUDE_PLUGIN_ROOT: shim, AGENTIC_ORCHESTRATOR_ROOT: shim } });
      strictEqual(r.status, 1, r.stderr);
      ok(/still active/.test(r.stderr), r.stderr);
      strictEqual((await subtask('A')).status, 'in_progress');
      deepStrictEqual(sessionEntries(work, macroPath), [], 'released on that refusal');
    });
  });

  // U7d — the Codex mirror's Phase 4 block ($orchestrator:done), run as the
  // agent runs it for --no-commit: the plugin root filled in, the optional
  // flags it omits for --no-commit dropped.
  const SKILL_TEXT = readFileSync(resolve(ORCH_ROOT, 'core/skills/done/SKILL.md'), 'utf8');
  // `landing`: the block as the agent runs it with a resolved landing (the
  // commit and pull request kept, no reason).
  const codexPhase4 = (root = ORCH_ROOT, { landing = false } = {}) => {
    const found = [...SKILL_TEXT.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1]).filter((b) => b.includes('--command done --host codex'));
    strictEqual(found.length, 1, 'one Codex block joins for done');
    const block = found[0].replaceAll('<orchestrator-plugin-root>', root);
    if (landing) return block.replace(' \\\n  [--correct] [--reason-file "$REASON_FILE"]', '');
    return block
      .replace(/^ {2}--commit "\$COMMIT_SHA" \\\n/m, '')
      .replace(/^ {2}--pr-url "\$PR_URL" \\\n/m, '')
      .replace('[--correct] [--reason-file "$REASON_FILE"]', '--reason-file "$REASON_FILE"');
  };
  const runCodexPhase4 = async ({ work, macroPath, dir }, vars, root = ORCH_ROOT, { landing = false, prelude = '' } = {}) => {
    const reasonFile = join(dir, 'reason.txt');
    await writeFile(reasonFile, 'investigation only');
    const macroId = macroPath.split('/').pop().replace(/\.md$/, '');
    const all = {
      MACRO_ID: macroId, MACRO_PATH: macroPath, REPO_ROOT: work, SUBTASK_ID: 'A',
      SUBTASK_BRANCH: 'feat/a', ENGINEER_WF_ID: ENGINEER_ID, CLOSED_AT: '2026-10-08T00:00:00Z', REASON_FILE: reasonFile, ...vars,
    };
    const assigns = Object.entries(all).map(([k, v]) => `${k}='${String(v).replace(/'/g, "'\\''")}'`).join('\n');
    const r = spawnSync('bash', ['-c', `${prelude}\n${assigns}\n${codexPhase4(root, { landing })}`], { cwd: work, encoding: 'utf8', env: { ...GIT_ENV, PATH: `${dirname(process.execPath)}:${process.env.PATH}` } });
    return { status: r.status, stderr: r.stderr, stdout: r.stdout };
  };

  // ADR-0067 Decision 4, item 5 — the Codex mirror's write passes the
  // dispatch of the owner its Phase 2 scan found: a subtask revised since the
  // dispatch is not completed or bound.
  it('Codex: the Phase 4 write is refused when the subtask is no longer the one the scanned owner was dispatched for', async () => {
    await withFixture(async ({ subtask, work, macroPath, dir }) => {
      await setPlan({
        workflowPath: macroPath, host: 'claude',
        subtasks: [
          { id: 'A', verb: 'compose', branch: 'feat/a2', blocked_by: [], status: 'in_progress' },
          { id: 'B', verb: 'compose', branch: 'feat/b', blocked_by: ['A'], status: 'blocked' },
        ],
      });
      const before = await readFile(macroPath, 'utf8');
      const r = await runCodexPhase4({ work, macroPath, dir }, { NO_COMMIT: '1', SUBTASK_BRANCH: 'feat/a2' });
      strictEqual(r.status, 1, r.stderr);
      ok(r.stderr.includes('(dispatch-changed): branch is "feat/a2"; the child was dispatched for "feat/a"'), r.stderr);
      strictEqual(await readFile(macroPath, 'utf8'), before);
      strictEqual((await subtask('A')).engineer_workflow_id, undefined);
      deepStrictEqual(sessionEntries(work, macroPath), [], 'released');
    });
  });

  // As the Claude test's shim: the child moves back into the active home
  // while `admission join` runs, so only a scan after the join sees it.
  it('Codex --no-commit: the Phase 4 block reads the active children after its join, refuses one made during it, and releases', async () => {
    await withFixture(async ({ subtask, work, macroPath, child, dir }) => {
      const shim = join(dir, 'shim-root');
      await mkdir(join(shim, 'scripts'), { recursive: true });
      await writeFile(join(shim, 'scripts', 'state.mjs'), [
        "import { renameSync } from 'node:fs';",
        "import { spawnSync } from 'node:child_process';",
        'const args = process.argv.slice(2);',
        `if (args[0] === 'admission' && args[1] === 'join') renameSync(${JSON.stringify(child('archive'))}, ${JSON.stringify(child('workflows'))});`,
        `const r = spawnSync(process.execPath, [${JSON.stringify(resolve(ORCH_ROOT, 'scripts/state.mjs'))}, ...args], { stdio: 'inherit' });`,
        'process.exit(r.status ?? 1);',
      ].join('\n'));
      const refused = await runCodexPhase4({ work, macroPath, dir }, { NO_COMMIT: '1' }, shim);
      strictEqual(refused.status, 1, refused.stderr);
      ok(/still active/.test(refused.stderr), refused.stderr);
      strictEqual((await subtask('A')).status, 'in_progress');
      deepStrictEqual(sessionEntries(work, macroPath), [], 'released on that refusal');
      // NO_COMMIT left unset, no commit to record: the scan still runs.
      const unset = await runCodexPhase4({ work, macroPath, dir }, {});
      strictEqual(unset.status, 1, unset.stderr);
      ok(/still active/.test(unset.stderr), unset.stderr);
      strictEqual((await subtask('A')).status, 'in_progress');
      // Control: the child archived, the same block completes the subtask.
      await rename(child('workflows'), child('archive'));
      const r = await runCodexPhase4({ work, macroPath, dir }, { NO_COMMIT: '1' });
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await subtask('A')).status, 'completed');
      deepStrictEqual(sessionEntries(work, macroPath), [], 'released after the write');
    });
  });
  // The Codex mirror's Phase 2 block: the owner and its dispatch come from
  // owner-dispatch, code rather than the agent's reading of the prose.
  const codexPhase2 = () => {
    const found = [...SKILL_TEXT.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1])
      .filter((b) => b.includes('owner-dispatch') && !b.includes('admission join'));
    strictEqual(found.length, 1, 'one Codex block reads the owner before the landing');
    return found[0].replaceAll('<orchestrator-plugin-root>', ORCH_ROOT);
  };
  it('Codex: the Phase 2 block prints the owner and the dispatch it records, recorded or found', async () => {
    await withFixture(async ({ work, macroPath, child }) => {
      const text = await readFile(child('archive'), 'utf8');
      await writeFile(child('archive'), text.replace('originating_subtask: "A"\n', 'originating_subtask: "A"\ndispatched_branch: "feat/a"\ndispatched_verb: "compose"\ndispatched_profile: "backend"\ndispatched_topic: "the topic"\n'));
      const macroId = macroPath.split('/').pop().replace(/\.md$/, '');
      const expected = { engineer_workflow_id: ENGINEER_ID, dispatch: { macro: macroId, subtask: 'A', branch: 'feat/a', verb: 'compose', profile: 'backend', topic: 'the topic' } };
      for (const owned of [false, true]) {
        if (owned) await updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host: 'codex', engineerWorkflowId: ENGINEER_ID });
        const r = spawnSync('bash', ['-c', `MACRO_ID='${macroId}'\nMACRO_PATH='${macroPath}'\nREPO_ROOT='${work}'\nSUBTASK_ID='A'\n${codexPhase2()}`], { cwd: work, encoding: 'utf8', env: { ...GIT_ENV, PATH: `${dirname(process.execPath)}:${process.env.PATH}` } });
        strictEqual(r.status, 0, r.stderr);
        const out = JSON.parse(r.stdout);
        deepStrictEqual({ engineer_workflow_id: out.engineer_workflow_id, dispatch: JSON.parse(out.dispatch) }, expected);
      }
    });
  });

  // R1 on Codex: the recorded owner's file gone, the block refuses; with
  // WAIVE_DISPATCH=1 and a reason it completes and the macro records the waiver.
  it('Codex: a recorded owner with no file left refuses; WAIVE_DISPATCH=1 with a reason completes and is recorded', async () => {
    await withFixture(async ({ subtask, work, macroPath, child, dir }) => {
      await updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host: 'codex', engineerWorkflowId: ENGINEER_ID });
      await rm(child('archive'));
      const before = await readFile(macroPath, 'utf8');
      const refused = await runCodexPhase4({ work, macroPath, dir }, { NO_COMMIT: '1' });
      strictEqual(refused.status, 1, refused.stderr);
      ok(refused.stderr.includes(`recorded owner ${ENGINEER_ID} has no workflow file left`), refused.stderr);
      strictEqual(await readFile(macroPath, 'utf8'), before);
      deepStrictEqual(sessionEntries(work, macroPath), [], 'released on that refusal');
      const r = await runCodexPhase4({ work, macroPath, dir }, { NO_COMMIT: '1', WAIVE_DISPATCH: '1' });
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await subtask('A')).status, 'completed');
      ok((await readWorkflow(macroPath)).body.includes(`Dispatch not compared (--waive-dispatch): the dispatch recorded by "${ENGINEER_ID}" could not be read`));
    });
  });

  it('Codex: WAIVE_DISPATCH=1 is refused while the owner\'s dispatch can be read', async () => {
    await withFixture(async ({ subtask, work, macroPath, dir }) => {
      await updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host: 'codex', engineerWorkflowId: ENGINEER_ID });
      const r = await runCodexPhase4({ work, macroPath, dir }, { NO_COMMIT: '1', WAIVE_DISPATCH: '1' });
      strictEqual(r.status, 1, r.stderr);
      ok(r.stderr.includes("--waive-dispatch applies only when the owner's dispatch cannot be read"), r.stderr);
      strictEqual((await subtask('A')).status, 'in_progress');
    });
  });
  // refine-verify-20261009T044549Z-bc0075, finding 1 — Phase 3 resolved the
  // landing for ENGINEER_WF_ID; a revision and a new dispatch before Phase 4
  // bind another owner. Contract: the block keeps the landing's owner, refuses
  // when the subtask now records another, and writes nothing; the unrevised
  // landing is the control.
  it('Codex: a landing resolved for one owner is not written for an owner bound since', async () => {
    await withFixture(async ({ subtask, work, macroPath, dir, child, squash }) => {
      const other = 'compose-20260927T101500Z-cccccc';
      await writeFile(join(dirname(child('archive')), `${other}.md`), (await readFile(child('archive'), 'utf8'))
        .replace(ENGINEER_ID, other)
        .replace('originating_subtask: "A"\n', 'originating_subtask: "A"\ndispatched_branch: "feat/a"\ndispatched_verb: "compose"\ndispatched_profile: ""\ndispatched_topic: "a revised topic"\n'));
      await setPlan({
        workflowPath: macroPath, host: 'codex',
        subtasks: [
          { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress', topic: 'a revised topic', engineer_workflow_id: other },
          { id: 'B', verb: 'compose', branch: 'feat/b', blocked_by: ['A'], status: 'blocked' },
        ],
      });
      const before = await readFile(macroPath, 'utf8');
      const landing = { COMMIT_SHA: squash, PR_URL: 'https://github.com/o/r/pull/7' };
      const r = await runCodexPhase4({ work, macroPath, dir }, landing, ORCH_ROOT, { landing: true });
      strictEqual(r.status, 1, r.stderr);
      ok(r.stderr.includes(`A now records owner ${other}, not ${ENGINEER_ID}`), r.stderr);
      strictEqual(await readFile(macroPath, 'utf8'), before);
      deepStrictEqual(sessionEntries(work, macroPath), [], 'released on that refusal');
    });
    await withFixture(async ({ subtask, work, macroPath, dir, squash }) => {
      await updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host: 'codex', engineerWorkflowId: ENGINEER_ID });
      const r = await runCodexPhase4({ work, macroPath, dir }, { COMMIT_SHA: squash, PR_URL: 'https://github.com/o/r/pull/7' }, ORCH_ROOT, { landing: true });
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await subtask('A')).status, 'completed');
      strictEqual((await subtask('A')).commit, squash);
    });
  });

  // Finding 3 — owner-dispatch's exit 3 is an answer, not a failure: under
  // set -e the waiver still completes, on both hosts.
  it('under set -e, --waive-dispatch with a reason still completes (Claude and Codex)', async () => {
    for (const host of ['claude', 'codex']) {
      await withFixture(async ({ done, subtask, child, macroPath, work, dir }) => {
        await updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host, engineerWorkflowId: ENGINEER_ID });
        await rm(child('archive'));
        const r = host === 'claude'
          ? await done({ NO_COMMIT: '1', WAIVE_DISPATCH: '1' }, { reason: 'the lane was removed', prelude: 'set -e' })
          : await runCodexPhase4({ work, macroPath, dir }, { NO_COMMIT: '1', WAIVE_DISPATCH: '1' }, ORCH_ROOT, { prelude: 'set -e' });
        strictEqual(r.status, 0, `${host}: ${r.stderr}`);
        strictEqual((await subtask('A')).status, 'completed', host);
      });
    }
  });
  // The Codex Phase 3 block resolves the landing for ENGINEER_WF_ID, the owner
  // Phase 2 printed: for an owner the scan recovered (none recorded), the
  // landing is bound to that attempt's dispatch time, as on Claude.
  it('Codex: the Phase 3 block resolves the landing for the owner Phase 2 printed', async () => {
    await withFixture(async ({ work, macroPath, dir, pr, squash }) => {
      const found = [...SKILL_TEXT.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1]).filter((b) => b.includes('resolve-landing'));
      strictEqual(found.length, 1, 'one Codex block resolves the landing');
      const block = found[0].replaceAll('<orchestrator-plugin-root>', ORCH_ROOT).replace(' [--pr "$PR"] [--commit "$COMMIT"]', '');
      const prs = join(dir, 'prs-codex.json');
      await writeFile(prs, JSON.stringify([pr()]));
      const vars = { REPO_ROOT: work, MACRO_PATH: macroPath, SUBTASK_ID: 'A', INTEGRATION_BRANCH: 'main', ENGINEER_WF_ID: ENGINEER_ID };
      const assigns = Object.entries(vars).map(([k, v]) => `${k}='${v}'`).join('\n');
      const r = spawnSync('bash', ['-c', `${assigns}\n${block}`], {
        cwd: work, encoding: 'utf8',
        env: { ...GIT_ENV, PATH: `${join(dir, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}`, FAKE_GH_PRS: prs },
      });
      strictEqual(r.status, 0, r.stderr);
      const landing = JSON.parse(r.stdout);
      strictEqual(landing.ok, true, r.stdout);
      strictEqual(landing.commit, squash);
    });
  });
});
