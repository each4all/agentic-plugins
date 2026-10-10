// tests/orchestrator/test-approve-runbook.mjs
//
// ADR-0063 D6 — /orchestrator:approve, run as written: the bash block in
// commands/approve.md, against real macro files, in bash and (when installed)
// zsh. It resolves the macro, prints the table and hash it approves, and
// approves exactly that hash. The /orchestrator:plan Phase 2 blocks (the
// plan-set write with its verdict, then the note and ensemble commit) run the
// same way, and so do the lane-advice lines both print (ADR-0067 Decision 8,
// item 2). So do plan's bootstrap and Plan-verify dispatch blocks where they
// take text: every value the agent writes — the request, the decision, the
// architecture, the phase note, the summary — reaches state.mjs from a file in
// the text directory, as written, and nothing in it runs (ADR-0059, amendment
// of 2026-10-10).

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual, notStrictEqual } from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
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
  // Contract: this test slices the block it runs by this heading — a renamed
  // heading must fail here, not run some other block.
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
    // Contract: the agent running /orchestrator:approve — the hash it approves must be
    // the one it showed; a second plan-hash read or no --expect-hash approves a plan
    // that changed in between (no single-process run can show that race).
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
  // Contract: this test slices the blocks it runs by this heading — a renamed
  // heading must fail here, not run some other block.
  const from = text.indexOf('## Phase 2 — State finalize');
  ok(from >= 0, 'plan.md carries Phase 2');
  const blocks = [...text.slice(from).matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  // Each block by what it runs, not by its place: Phase 2 also carries the
  // lane-advice block between the two writes.
  const one = (what, token) => {
    const found = blocks.filter((b) => b.includes(token));
    strictEqual(found.length, 1, `Phase 2 has one ${what} block`);
    return found[0];
  };
  return {
    planSet: one('plan-set', 'state.mjs" plan-set'),
    laneAdvice: one('lane-advice', 'state.mjs" lane-advice'),
    finalize: one('note + ensemble', 'state.mjs" ensemble-commit'),
  };
}

// The Codex plan skill's Step 6 block, the same note and ensemble commit, with
// its placeholders filled as a Codex agent fills them: the plugin root, the
// host, and the text directory.
async function codexPlanCommitBlock(textDir) {
  const text = await readFile(resolve(ORCH_ROOT, 'core/skills/plan/SKILL.md'), 'utf8');
  // Contract: this test slices the block it runs by this heading — a renamed
  // heading must fail here, not run some other block.
  const from = text.indexOf('### Step 6: Commit the ensemble result');
  const to = text.indexOf('### Step 7');
  ok(from >= 0 && to > from, 'the plan skill carries Step 6');
  const blocks = [...text.slice(from, to).matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  strictEqual(blocks.length, 1, 'Step 6 has one block');
  const line = "TEXT_DIR='<directory from mktemp>'";
  // Contract: the Codex agent running $orchestrator:plan — a block that does
  // not open with this line reads its files from nowhere the agent wrote them.
  strictEqual(blocks[0].split('\n')[0], line, 'the block opens with its text directory');
  return blocks[0].replace(line, () => `TEXT_DIR='${textDir}'`)
    .replaceAll('<plugin-root>', ORCH_ROOT).replaceAll('<claude|codex>', 'codex');
}

// The blocks before Phase 2 that take text: Phase 0's bootstrap (indented
// under its list item, which the shell does not mind) and Phase 1's dispatch.
async function planTextBlocks() {
  const text = await readFile(resolve(ORCH_ROOT, 'commands/plan.md'), 'utf8');
  const to = text.indexOf('## Phase 2 — State finalize');
  ok(to >= 0, 'plan.md carries Phase 2');
  const blocks = [...text.slice(0, to).matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  const one = (what, token) => {
    const found = blocks.filter((b) => b.includes(token));
    strictEqual(found.length, 1, `plan.md has one ${what} block before Phase 2`);
    return found[0];
  };
  return { bootstrap: one('bootstrap', 'state.mjs" create'), dispatch: one('dispatch', 'peer-runner.mjs" run') };
}

// Every block that reads a text file opens with the line that names the
// directory; the agent puts the path mktemp printed there, and so does this.
const TEXT_DIR_LINE = "TEXT_DIR='<directory from step 1>'";
function withTextDir(block, textDir) {
  // Contract: the agent running /orchestrator:plan — a block that does not
  // open with this line reads its files from nowhere the agent wrote them.
  strictEqual(block.split('\n').find((l) => l.trim() !== '').trim(), TEXT_DIR_LINE, 'the block opens with its text directory');
  return block.replace(TEXT_DIR_LINE, () => `TEXT_DIR='${textDir}'`);
}
async function writeTexts(textDir, files) {
  for (const [name, content] of Object.entries(files)) await writeFile(join(textDir, name), content);
}
const SUBTASKS_JSON = JSON.stringify([{ id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' }]);
// What an agent writes, and what a peer's sentences in a note or summary can
// hold: shell syntax that runs when it is source, a leading --, lines that
// would end a heredoc or name a variable of the block, quotes, a backslash,
// $orchestrator:next as the note's scaffold spells it, and non-ASCII text.
const hostile = (tag) => [
  `--${tag}: \`touch pwned-${tag}-tick\` and $(touch pwned-${tag}-sub); "double" 'single' back\\slash ü`,
  'PHASE_NOTE',
  'TEXT_DIR',
  `next: $orchestrator:next and \${HOME}`,
].join('\n');
// The environment the blocks run in: no AGENTIC_* of an autopilot worker
// (docket C88), and a NOTE and SUMMARY of its own, which the blocks must not
// read.
function blockEnv(extra) {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_'))),
    AGENTIC_ORCHESTRATOR_ROOT: ORCH_ROOT, NOTE: 'NOTE from the environment', SUMMARY: 'SUMMARY from the environment', ...extra,
  };
  delete env.CLAUDE_PLUGIN_ROOT;
  return env;
}
// The text directory's path holds a space: a block that passes a file path
// unquoted splits it into two words.
async function withTextRepo(fn) {
  const textDir = await mkdtemp(join(tmpdir(), 'agentic text.'));
  try {
    return await withRepo((dir) => fn(dir, textDir));
  } finally {
    await rm(textDir, { recursive: true, force: true });
  }
}
async function nothingRan(...dirs) {
  for (const d of dirs) {
    deepStrictEqual((await readdir(d)).filter((n) => n.startsWith('pwned')), [], `nothing in the text ran in ${d}`);
  }
}

describe('/orchestrator:plan sets the gate in the plan write', () => {
  it('no later block sets a gate', async () => {
    const { finalize } = await planPhase2Blocks();
    // Contract: the agent running /orchestrator:plan — a separate gate write leaves the
    // plan approvable between the two writes.
    ok(!finalize.includes('awaiting-owner-set'), 'the gate is not set in a separate write');
  });
});

for (const shell of SHELLS) {
  describe(`/orchestrator:plan plan-set block (${shell})`, () => {
    // The agent writes the subtasks, the decision and the architecture to the
    // text directory before the block; so does this.
    const runPlanSet = async (dir, textDir, active, extra = {}) => {
      await writeTexts(textDir, { 'subtasks.json': SUBTASKS_JSON, 'decision.txt': 'Decide A\n', 'architecture.txt': 'One lane\n' });
      const env = blockEnv({ ACTIVE: active, ...extra });
      if (!('VERDICT' in extra)) delete env.VERDICT;
      const { planSet } = await planPhase2Blocks();
      return spawnSync(shell, ['-c', withTextDir(planSet, textDir)], { cwd: dir, encoding: 'utf8', env });
    };
    const newMacro = async (dir) => (await createWorkflow({
      repoRoot: dir, verb: 'plan', host: 'claude',
      gitBaseline: { branch: 'main', head: '0'.repeat(40), status_digest: '' },
      originalRequest: 'plan-set block fixture',
    })).filePath;

    it('a conflict verdict writes the plan at plan-conflict; another verdict at plan-approval', async () => {
      await withTextRepo(async (dir, textDir) => {
        const filePath = await newMacro(dir);
        let r = await runPlanSet(dir, textDir, filePath, { VERDICT: 'conflict' });
        strictEqual(r.status, 0, r.stderr);
        let fm = (await readWorkflow(filePath)).frontmatter;
        strictEqual(fm.plan.subtasks[0].id, 'A');
        strictEqual(fm.awaiting_owner_gate, 'plan-conflict');
        strictEqual(fm.awaiting_owner_pointer, `.agentic-plugins/state/orchestrator/workflows/${basename(filePath)}#ensemble-synthesis`);
        r = await runPlanSet(dir, textDir, filePath, { VERDICT: 'concerns' });
        strictEqual(r.status, 0, r.stderr);
        fm = (await readWorkflow(filePath)).frontmatter;
        strictEqual(fm.awaiting_owner_gate, 'plan-approval');
      });
    });

    it('refuses to write the plan when no verdict was set', async () => {
      await withTextRepo(async (dir, textDir) => {
        const filePath = await newMacro(dir);
        const before = await readFile(filePath, 'utf8');
        const r = await runPlanSet(dir, textDir, filePath);
        notStrictEqual(r.status, 0);
        ok(r.stderr.includes('verdict must be one of pass, concerns, conflict'), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before);
      });
    });
  });

  describe(`/orchestrator:plan note + ensemble block (${shell})`, () => {
    const runFinalize = async (dir, textDir, active, extra = {}, files = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n' }) => {
      await writeTexts(textDir, files);
      const env = blockEnv({ ACTIVE: active, RUN_ID: 'macro-plan-20260930T000000Z-abcdef', VERDICT: 'pass', ...extra });
      const { finalize } = await planPhase2Blocks();
      return spawnSync(shell, ['-c', withTextDir(finalize, textDir)], { cwd: dir, encoding: 'utf8', env });
    };

    it('records the note and the ensemble result', async () => {
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const r = await runFinalize(dir, textDir, filePath, { VERDICT: 'concerns' });
        strictEqual(r.status, 0, r.stderr);
        const fm = (await readWorkflow(filePath)).frontmatter;
        strictEqual(fm.ensemble_results.at(-1).verdict, 'concerns');
        strictEqual(fm.current_phase, 'phase-2-presented');
      });
    });

    it('fails when the ensemble commit fails', async () => {
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const r = await runFinalize(dir, textDir, filePath, { RUN_ID: '' });
        notStrictEqual(r.status, 0);
        ok(r.stderr.includes('run_id must be a non-empty string'), r.stderr);
      });
    });

    it('stops when the append refuses a terminal macro, before the ensemble commit', async () => {
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        await setMacroTerminal({ workflowPath: filePath, host: 'claude', terminalPhase: 'aborted' });
        const r = await runFinalize(dir, textDir, filePath);
        notStrictEqual(r.status, 0);
        ok(r.stderr.includes('terminal macro is not revised'), r.stderr);
        strictEqual((await readWorkflow(filePath)).frontmatter.ensemble_results, undefined);
      });
    });

    it('a missing note or summary file stops the block before either write', async () => {
      // Contract: the agent running /orchestrator:plan — a note recorded whose
      // ensemble result then cannot be committed leaves the run pending under a
      // phase that says it was synthesized. Every file the reader refuses
      // stops the block, not only a missing one: a newline alone is empty to it
      // (Review finding), and so are a NUL byte and text that is not UTF-8.
      const note = 'The note\n';
      const summary = 'The summary\n';
      for (const [flag, files, why] of [
        ['--summary-file', { 'note.md': note }, /cannot read .*ENOENT/],
        ['--phase-note-file', { 'summary.txt': summary }, /cannot read .*ENOENT/],
        ['--summary-file', { 'note.md': note, 'summary.txt': '\n' }, /is empty/],
        ['--phase-note-file', { 'note.md': 'a\0b\n', 'summary.txt': summary }, /holds a NUL byte/],
        ['--summary-file', { 'note.md': note, 'summary.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]) }, /is not valid UTF-8/],
      ]) {
        await withTextRepo(async (dir, textDir) => {
          const filePath = await plannedMacro(dir);
          const before = await readFile(filePath, 'utf8');
          const r = await runFinalize(dir, textDir, filePath, {}, files);
          strictEqual(r.status, 1, r.stderr);
          const line = r.stderr.trimEnd().split('\n').at(-1);
          ok(line.startsWith(`✗ ${flag}: `) && why.test(line) && line.endsWith('nothing was written.'), r.stderr);
          strictEqual(await readFile(filePath, 'utf8'), before, `${flag} ${why}: nothing was written`);
        });
      }
    });
  });

  describe(`$orchestrator:plan Step 6 block, the Codex skill (${shell})`, () => {
    const runCodexCommit = async (dir, textDir, active, files) => {
      await writeTexts(textDir, files);
      const env = blockEnv({ ACTIVE: active, RUN_ID: 'macro-plan-20261010T000000Z-c0de00', VERDICT: 'concerns' });
      return spawnSync(shell, ['-c', await codexPlanCommitBlock(textDir)], { cwd: dir, encoding: 'utf8', env });
    };

    it('records the note and the ensemble result as written, and none of it runs', async () => {
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const r = await runCodexCommit(dir, textDir, filePath, { 'note.md': `${hostile('note')}\n`, 'summary.txt': `${hostile('summary')}\n` });
        strictEqual(r.status, 0, r.stderr);
        const { frontmatter, body } = await readWorkflow(filePath);
        ok(body.includes(`### Phase 1: Plan (synthesized)\n\n${hostile('note')}\n\n`), body);
        deepStrictEqual(
          [frontmatter.current_phase, frontmatter.ensemble_results.at(-1).verdict, frontmatter.ensemble_results.at(-1).summary, frontmatter.host_history.at(-1).host],
          ['phase-2-presented', 'concerns', hostile('summary'), 'codex'],
        );
        // The Codex spelling of the next commands, kept as written.
        ok(frontmatter.next_action.includes('($orchestrator:approve); then $orchestrator:next'), frontmatter.next_action);
        ok(!(await readFile(filePath, 'utf8')).includes('from the environment'), 'no NOTE or SUMMARY of the environment was recorded');
        await nothingRan(dir, textDir);
      });
    });

    it('a file the reader refuses stops the block before either write', async () => {
      // Contract: the Codex agent running $orchestrator:plan — the same refusal
      // as commands/plan.md Phase 2 (Critique finding): a note recorded whose
      // ensemble result then cannot be committed leaves the run pending under a
      // phase that says it was synthesized.
      const note = 'The note\n';
      const summary = 'The summary\n';
      for (const [flag, files, why] of [
        ['--summary-file', { 'note.md': note }, /cannot read .*ENOENT/],
        ['--phase-note-file', { 'summary.txt': summary }, /cannot read .*ENOENT/],
        ['--summary-file', { 'note.md': note, 'summary.txt': '\n' }, /is empty/],
        ['--phase-note-file', { 'note.md': 'a\0b\n', 'summary.txt': summary }, /holds a NUL byte/],
        ['--summary-file', { 'note.md': note, 'summary.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]) }, /is not valid UTF-8/],
      ]) {
        await withTextRepo(async (dir, textDir) => {
          const filePath = await plannedMacro(dir);
          const before = await readFile(filePath, 'utf8');
          const r = await runCodexCommit(dir, textDir, filePath, files);
          strictEqual(r.status, 1, r.stderr);
          const line = r.stderr.trimEnd().split('\n').at(-1);
          ok(line.startsWith(`✗ ${flag}: `) && why.test(line) && line.endsWith('nothing was written.'), r.stderr);
          strictEqual(await readFile(filePath, 'utf8'), before, `${flag} ${why}: nothing was written`);
        });
      }
    });
  });

  describe(`/orchestrator:plan text files (${shell}) (ADR-0059, amendment of 2026-10-10)`, () => {
    it('the request, decision, architecture, note and summary are recorded as written, none of it runs, and no NOTE or SUMMARY comes from the environment', async () => {
      await withTextRepo(async (dir, textDir) => {
        const { bootstrap } = await planTextBlocks();
        const { planSet, finalize } = await planPhase2Blocks();
        const texts = {
          'request.txt': `${hostile('request')}\n`,
          'subtasks.json': SUBTASKS_JSON,
          'decision.txt': `${hostile('decision')}\n`,
          // Two final newlines: the file's own is removed, the other is text.
          'architecture.txt': `${hostile('architecture')}\n\n`,
          'note.md': `${hostile('note')}\n`,
          'summary.txt': `${hostile('summary')}\r\n`,
        };
        await writeTexts(textDir, texts);
        const run = (block, extra) => spawnSync(shell, ['-c', withTextDir(block, textDir)], { cwd: dir, encoding: 'utf8', env: blockEnv(extra) });

        let r = run(`${bootstrap}\nprintf '%s\\n' "$ACTIVE"\n`, { REPO_ROOT: dir, GIT_BRANCH: 'main' });
        strictEqual(r.status, 0, r.stderr);
        const filePath = r.stdout.trim();
        // create scrubs the request to one line; nothing else changes it.
        strictEqual((await readWorkflow(filePath)).frontmatter.original_request, hostile('request').split('\n').join(' '));
        r = run(planSet, { ACTIVE: filePath, VERDICT: 'concerns', RUN_ID: 'macro-plan-20261010T000000Z-0c1300' });
        strictEqual(r.status, 0, r.stderr);
        r = run(finalize, { ACTIVE: filePath, VERDICT: 'concerns', RUN_ID: 'macro-plan-20261010T000000Z-0c1300' });
        strictEqual(r.status, 0, r.stderr);

        const { frontmatter, body } = await readWorkflow(filePath);
        deepStrictEqual([frontmatter.plan.decision, frontmatter.plan.architecture], [hostile('decision'), `${hostile('architecture')}\n`]);
        ok(body.includes(`### Phase 1: Plan (synthesized)\n\n${hostile('note')}\n\n`), body);
        strictEqual(frontmatter.ensemble_results.at(-1).summary, hostile('summary'));
        ok(!(await readFile(filePath, 'utf8')).includes('from the environment'), 'no NOTE or SUMMARY of the environment was recorded');
        await nothingRan(dir, textDir);
      });
    });

    it('the dispatch block refuses a missing prompt file before it dispatches', async () => {
      await withTextRepo(async (dir, textDir) => {
        const { dispatch } = await planTextBlocks();
        const r = spawnSync(shell, ['-c', withTextDir(dispatch, textDir)], { cwd: dir, encoding: 'utf8', env: blockEnv({ REPO_ROOT: dir, ACTIVE: join(dir, 'no-macro.md') }) });
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes(`✗ ${textDir}/prompt.xml is missing or empty`), r.stderr);
        deepStrictEqual(await readdir(textDir), [], 'no run was started: no run JSON beside the prompt');
      });
    });
  });
}

// ADR-0067 Decision 8, item 2 — the lane advice both runbooks print after the
// plan is stored or approved: one `- lane_advice:` line when two lanes shorten
// the plan, nothing otherwise. In a fresh repository shared creation is off,
// so the line names the cutover instead of the command.
async function sideBySideMacro(dir) {
  const { filePath } = await createWorkflow({
    repoRoot: dir, verb: 'plan', host: 'claude',
    gitBaseline: { branch: 'main', head: '0'.repeat(40), status_digest: '' },
    originalRequest: 'lane advice runbook fixture',
  });
  await setPlan({
    workflowPath: filePath, host: 'claude',
    subtasks: [
      { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' },
      { id: 'B', verb: 'compose', branch: 'feat/b', blocked_by: [], status: 'pending' },
      { id: 'C', verb: 'compose', branch: 'feat/c', blocked_by: ['A', 'B'], status: 'blocked' },
    ],
  });
  return filePath;
}
const CUTOVER_LINE = '- lane_advice: A and B are independent, C waits on both (3 steps in one lane, 2 with 2); lanes need the state-root cutover first (shared creation is off): docs/runbooks/state-root-cutover.md';

for (const shell of SHELLS) {
  describe(`lane advice in the plan and approve runbooks (${shell})`, () => {
    const runLaneAdvice = async (dir, active) => {
      const env = { ...process.env, AGENTIC_ORCHESTRATOR_ROOT: ORCH_ROOT, ACTIVE: active, REPO_ROOT: dir };
      delete env.CLAUDE_PLUGIN_ROOT;
      delete env.AGENTIC_AUTOPILOT;
      const { laneAdvice } = await planPhase2Blocks();
      return spawnSync(shell, ['-c', laneAdvice], { cwd: dir, encoding: 'utf8', env });
    };

    it("plan's Phase 2 prints the line for side-by-side subtasks, and nothing for a chain", async () => {
      await withRepo(async (dir) => {
        let r = await runLaneAdvice(dir, await sideBySideMacro(dir));
        strictEqual(r.status, 0, r.stderr);
        strictEqual(r.stdout, `${CUTOVER_LINE}\n`);
      });
      await withRepo(async (dir) => {
        const r = await runLaneAdvice(dir, await plannedMacro(dir));
        strictEqual(r.status, 0, r.stderr);
        strictEqual(r.stdout, '');
      });
    });

    it('approve prints the line after the approval', async () => {
      await withRepo(async (dir) => {
        await sideBySideMacro(dir);
        const r = await run(shell, dir);
        strictEqual(r.status, 0, r.stderr);
        const lines = r.stdout.trimEnd().split('\n');
        ok(lines.at(-2).startsWith('workflow: '), r.stdout);
        strictEqual(lines.at(-1), CUTOVER_LINE);
      });
    });
  });
}
