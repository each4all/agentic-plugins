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
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ORCH_ROOT = resolve(REPO_ROOT, 'plugins/orchestrator');
const {
  createWorkflow, setPlan, setAwaitingOwner, clearAwaitingOwner, recordPendingEnsemble, setMacroTerminal, readWorkflow, computePlanHash,
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
// The plan written again with the verdict conflict for a Plan-verify run, as
// the plan-set block writes it: the plan-conflict gate bound to the run.
async function conflictGate(filePath, runId) {
  const { frontmatter } = await readWorkflow(filePath);
  await setPlan({ workflowPath: filePath, host: 'claude', subtasks: frontmatter.plan.subtasks, verdict: 'conflict', runId });
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
async function codexPlanCommitBlock(textDir, verdicts = { VERDICT: 'concerns' }, root = ORCH_ROOT) {
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
  return withVerdicts(blocks[0].replace(line, () => `TEXT_DIR='${textDir}'`), verdicts)
    .replaceAll('<plugin-root>', root).replaceAll('<claude|codex>', 'codex');
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
  return {
    find: one('Phase 0 selection', "printf 'ACTIVE=%s\\n'"),
    bootstrap: one('bootstrap', 'state.mjs" create'),
    resume: one('resume', 'Phase 0: Resume macro plan'),
    dispatch: one('dispatch', 'peer-runner.mjs" run'),
  };
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
// The verdict lines the agent fills in (each block runs in a fresh shell, so
// the block holds the verdict itself, docket C75); a case that sets none
// leaves them as written.
const VERDICT_LINE = "VERDICT='<pass|concerns|conflict>'";
function withVerdicts(block, { VERDICT, ENSEMBLE_VERDICT } = {}) {
  let out = block;
  if (VERDICT !== undefined) {
    ok(out.includes(VERDICT_LINE), 'the block holds its VERDICT line');
    out = out.replace(VERDICT_LINE, () => `VERDICT='${VERDICT}'`);
  }
  if (ENSEMBLE_VERDICT !== undefined) {
    ok(out.includes("ENSEMBLE_VERDICT=''"), 'the block holds its ENSEMBLE_VERDICT line');
    out = out.replace("ENSEMBLE_VERDICT=''", () => `ENSEMBLE_VERDICT='${ENSEMBLE_VERDICT}'`);
  }
  return out;
}
// A plugin root whose state.mjs fails one subcommand (FAIL_STEP) and hands
// every other call, and every import, to the real one: a write that fails
// part-way through plan's Phase 2 block (C132). With FAIL_AFTER=1 the write
// is made first, and the command fails after it (Review finding).
async function failingRoot(dir) {
  const root = join(dir, 'failing-root');
  await mkdir(join(root, 'scripts'), { recursive: true });
  const real = resolve(ORCH_ROOT, 'scripts/state.mjs');
  await writeFile(join(root, 'scripts', 'state.mjs'), [
    "import { spawnSync } from 'node:child_process';",
    "import { realpathSync } from 'node:fs';",
    "import { fileURLToPath } from 'node:url';",
    `export * from ${JSON.stringify(pathToFileURL(real).href)};`,
    // Run as a command, not imported (the block's reader imports it): by the
    // real path, since a temporary directory's spelling may go through a link.
    'let main = false;',
    'try { main = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { /* imported by node -e */ }',
    'if (main) {',
    '  const args = process.argv.slice(2);',
    "  if (args[0] === process.env.FAIL_STEP && !process.env.FAIL_AFTER) { process.stderr.write(`✗ injected failure: ${args[0]}\\n`); process.exit(1); }",
    `  const r = spawnSync(process.execPath, [${JSON.stringify(real)}, ...args], { stdio: 'inherit' });`,
    "  if (args[0] === process.env.FAIL_STEP) { process.stderr.write(`✗ injected failure: ${args[0]}\\n`); process.exit(1); }",
    '  process.exit(r.status ?? 1);',
    '}',
  ].join('\n'));
  return root;
}
const consensusTask = (dir, filePath, runId) => join(dir, '.agentic-plugins/state/orchestrator/consensus', `${basename(filePath, '.md')}.${runId}.md`);
// The plan's synthesis note, appended by each run of the finalize block.
const NOTE_HEADING = '### Phase 1: Plan (synthesized)';
const notesIn = (body) => body.split(`${NOTE_HEADING}\n`).length - 1;
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
    // The block finds the macro on the branch itself, and reads the run id the
    // dispatch wrote.
    const runPlanSet = async (dir, textDir, active, extra = {}) => {
      await writeTexts(textDir, { 'subtasks.json': SUBTASKS_JSON, 'decision.txt': 'Decide A\n', 'architecture.txt': 'One lane\n', 'run-id': 'macro-plan-20260930T000000Z-abcdef', 'run-macro': active, 'macro-path': active });
      const { planSet } = await planPhase2Blocks();
      return spawnSync(shell, ['-c', withVerdicts(withTextDir(planSet, textDir), extra)], { cwd: dir, encoding: 'utf8', env: blockEnv({ VERDICT: 'pass from the environment' }) });
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
    // `extra`: the verdicts the agent puts in the block, the run id the
    // dispatch wrote (RUN_ID) and the macro it wrote with it (RUN_MACRO,
    // `active` unless given), and the environment the block runs in.
    const runFinalize = async (dir, textDir, active, extra = {}, files = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n' }) => {
      const { VERDICT = 'pass', ENSEMBLE_VERDICT, RUN_ID = 'macro-plan-20260930T000000Z-abcdef', RUN_MACRO = active, ...env } = extra;
      // active null: Phase 0 wrote no macro-path.
      await writeTexts(textDir, { ...(active === null ? {} : { 'macro-path': active }), ...(RUN_ID === null ? {} : { 'run-id': RUN_ID }), ...(RUN_MACRO === null ? {} : { 'run-macro': RUN_MACRO }), ...files });
      const { finalize } = await planPhase2Blocks();
      // VERDICT null: the line left as the runbook writes it.
      return spawnSync(shell, ['-c', withVerdicts(withTextDir(finalize, textDir), { VERDICT: VERDICT ?? undefined, ENSEMBLE_VERDICT })], { cwd: dir, encoding: 'utf8', env: blockEnv(env) });
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

    it('an empty run id stops the block before either write (C132)', async () => {
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const before = await readFile(filePath, 'utf8');
        const r = await runFinalize(dir, textDir, filePath, { RUN_ID: '' });
        notStrictEqual(r.status, 0);
        ok(r.stderr.includes('/run-id is empty; nothing was written.'), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before, 'nothing was written');
      });
    });

    it('a terminal macro stops the block before any write', async () => {
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        await setMacroTerminal({ workflowPath: filePath, host: 'claude', terminalPhase: 'aborted' });
        const before = await readFile(filePath, 'utf8');
        const r = await runFinalize(dir, textDir, filePath);
        notStrictEqual(r.status, 0);
        ok(r.stderr.includes('terminal macro is not revised') && r.stderr.trimEnd().endsWith('nothing was written.'), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before, 'nothing was written');
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

    // C132 — every input is checked before any write: the verdicts, the run
    // id the dispatch wrote, and on a conflict the contested items.
    it('a verdict, run id or contested file it cannot use stops the block before any write (C132)', async () => {
      const files = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n' };
      for (const [what, extra, more, why] of [
        ['the VERDICT line left as written', { VERDICT: null }, {}, /VERDICT is "<pass\|concerns\|conflict>", not pass, concerns or conflict/],
        ['an unknown ENSEMBLE_VERDICT', { ENSEMBLE_VERDICT: 'skipped' }, {}, /ENSEMBLE_VERDICT is "skipped"/],
        ['a failed run with a conflict', { VERDICT: 'conflict', ENSEMBLE_VERDICT: 'failed' }, { 'contested.md': 'C1\n' }, /gave no peer positions to conflict with/],
        ['no run id written', { RUN_ID: null }, {}, /writes the run id to .*\/run-id/],
        ['a run id the dispatch could not have used', { RUN_ID: 'macro/plan' }, {}, /run-id holds "macro\/plan", not a run id the verdict pass can record/],
        ['a run id holding ..', { RUN_ID: 'macro-plan..x' }, {}, /not a run id the verdict pass can record/],
        ['a run id a command would read as an option', { RUN_ID: '--probe' }, {}, /run-id holds "--probe", not a run id the verdict pass can record/],
        ['a conflict whose run id the gate cannot record', { VERDICT: 'conflict', RUN_ID: 'macro-plan.bad' }, { 'contested.md': 'C1\n' }, /run-id holds "macro-plan\.bad", not a run id the verdict conflict can record/],
        ['a run id ending in a carriage return', { RUN_ID: 'macro-plan-20260930T000000Z-abcdef\r' }, {}, /not a run id/],
        ['a conflict with no contested.md', { VERDICT: 'conflict' }, {}, /contested\.md is missing or blank/],
        ['a conflict with a blank contested.md', { VERDICT: 'conflict' }, { 'contested.md': ' \n\t\n' }, /contested\.md is missing or blank/],
      ]) {
        await withTextRepo(async (dir, textDir) => {
          const filePath = await plannedMacro(dir);
          const before = await readFile(filePath, 'utf8');
          const r = await runFinalize(dir, textDir, filePath, extra, { ...files, ...more });
          strictEqual(r.status, 1, `${what}: ${r.stderr}`);
          ok(why.test(r.stderr) && r.stderr.trimEnd().endsWith('nothing was written.'), `${what}: ${r.stderr}`);
          strictEqual(await readFile(filePath, 'utf8'), before, `${what}: nothing was written`);
        });
      }
    });

    // C132 — a failure injected at each write in turn, then the block run
    // again as it is: the ensemble result is recorded once and the task file
    // is there. The append is not skipped on a rerun, so a failure past it
    // leaves the note twice, the duplicate accepted until the macro keeps a
    // machine record of the run's note.
    it('a rerun after a failure at any write keeps the ensemble result once and writes the task file; past the append it records the note again (C132)', async () => {
      const RUN_ID = 'macro-plan-20260930T000000Z-abcdef';
      for (const [step, after] of ['append', 'ensemble-commit', 'consensus-task'].flatMap((s) => [[s, ''], [s, '1']])) {
        await withTextRepo(async (dir, textDir) => {
          const filePath = await plannedMacro(dir);
          await conflictGate(filePath, RUN_ID);
          const files = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n', 'contested.md': 'C1: split A or not\n' };
          const failing = await failingRoot(dir);
          const first = await runFinalize(dir, textDir, filePath, { VERDICT: 'conflict', AGENTIC_ORCHESTRATOR_ROOT: failing, FAIL_STEP: step, FAIL_AFTER: after }, files);
          strictEqual(first.status, 1, `${step}: ${first.stderr}`);
          ok(first.stderr.includes(`✗ injected failure: ${step}`), first.stderr);
          const again = await runFinalize(dir, textDir, filePath, { VERDICT: 'conflict' }, files);
          strictEqual(again.status, 0, `${step}: ${again.stderr}`);
          const { frontmatter, body } = await readWorkflow(filePath);
          strictEqual(notesIn(body), step === 'append' && after === '' ? 1 : 2, `${step}${after ? ' (after)' : ''}: the note once per append that ran`);
          deepStrictEqual(frontmatter.ensemble_results.filter((e) => e.run_id === RUN_ID).map((e) => e.verdict), ['conflict'], `${step}: the result once`);
          strictEqual(await readFile(consensusTask(dir, filePath, RUN_ID), 'utf8'), 'C1: split A or not\n', `${step}: the task file`);
        });
      }
    });

    // Critique F1 — a re-plan (or a second session) finalizing a new run
    // records its note and result after the first run's.
    it('a later run records its own note and result after an earlier run\'s', async () => {
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const first = 'macro-plan-20260930T000000Z-aaaaaa';
        const second = 'macro-plan-20260930T000000Z-bbbbbb';
        for (const [runId, note] of [[first, 'The first note\n'], [second, 'The second note\n']]) {
          const r = await runFinalize(dir, textDir, filePath, { VERDICT: 'concerns', RUN_ID: runId }, { 'note.md': note, 'summary.txt': 'The summary\n' });
          strictEqual(r.status, 0, r.stderr);
        }
        const { frontmatter, body } = await readWorkflow(filePath);
        ok(body.includes(`${NOTE_HEADING}\n\nThe first note\n`) && body.includes(`${NOTE_HEADING}\n\nThe second note\n`), body);
        ok(body.indexOf('The first note') < body.indexOf('The second note'), 'the second after the first');
        deepStrictEqual(frontmatter.ensemble_results.map((e) => e.run_id), [first, second]);
      });
    });

    // Refine-verify N1 — a rerun after a failed ensemble commit, on a macro
    // made terminal since, is refused by the macro read before any write.
    it('a rerun refuses a macro made terminal since, recording no result', async () => {
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const failing = await failingRoot(dir);
        const first = await runFinalize(dir, textDir, filePath, { VERDICT: 'concerns', AGENTIC_ORCHESTRATOR_ROOT: failing, FAIL_STEP: 'ensemble-commit' });
        strictEqual(first.status, 1, first.stderr);
        await setMacroTerminal({ workflowPath: filePath, host: 'claude', terminalPhase: 'aborted' });
        const before = await readFile(filePath, 'utf8');
        const again = await runFinalize(dir, textDir, filePath, { VERDICT: 'concerns' });
        strictEqual(again.status, 1, again.stderr);
        ok(again.stderr.includes('a terminal macro is not revised'), again.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before, 'no ensemble result was written');
      });
    });

    // Critique F2 — the blocks write to the macro Phase 0 wrote to
    // macro-path; a branch switched since names another macro, which they
    // never find (docket C75: reload, never re-derive).
    it('the plan-set and note blocks write to the macro Phase 0 found, not the one a branch switched since names', async () => {
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        execFileSync('git', ['-C', dir, 'switch', '-q', '-c', 'feat/other']);
        const { filePath: other } = await createWorkflow({
          repoRoot: dir, verb: 'plan', host: 'claude',
          gitBaseline: { branch: 'feat/other', head: '0'.repeat(40), status_digest: '' },
          originalRequest: 'the macro the switched branch names',
        });
        const otherBefore = await readFile(other, 'utf8');
        const { planSet } = await planPhase2Blocks();
        await writeTexts(textDir, { 'macro-path': filePath, 'subtasks.json': SUBTASKS_JSON, 'decision.txt': 'Decide A\n', 'architecture.txt': 'One lane\n' });
        let r = spawnSync(shell, ['-c', withVerdicts(withTextDir(planSet, textDir), { VERDICT: 'concerns' })], { cwd: dir, encoding: 'utf8', env: blockEnv({ ACTIVE: other }) });
        strictEqual(r.status, 0, r.stderr);
        r = await runFinalize(dir, textDir, filePath, { VERDICT: 'concerns', ACTIVE: other });
        strictEqual(r.status, 0, r.stderr);
        const fm = (await readWorkflow(filePath)).frontmatter;
        deepStrictEqual([fm.plan.decision, fm.ensemble_results.at(-1).verdict], ['Decide A', 'concerns']);
        strictEqual(await readFile(other, 'utf8'), otherBefore, 'the macro the branch names now is untouched');
      });
    });

    it('a missing macro-path, or one naming no file, stops the block before any write', async () => {
      for (const [what, active, why] of [
        ['no macro-path', null, /writes the macro's path to .*\/macro-path: run it first; nothing was written\./],
        ['a macro-path naming no file', 'gone.md', /\/macro-path names no macro file \(".*gone\.md"\); nothing was written\./],
      ]) {
        await withTextRepo(async (dir, textDir) => {
          const filePath = await plannedMacro(dir);
          const before = await readFile(filePath, 'utf8');
          const r = await runFinalize(dir, textDir, active === null ? null : join(dir, active), { VERDICT: 'concerns' });
          strictEqual(r.status, 1, `${what}: ${r.stderr}`);
          ok(why.test(r.stderr), `${what}: ${r.stderr}`);
          strictEqual(await readFile(filePath, 'utf8'), before, `${what}: nothing was written`);
        });
      }
    });

    // Critique F5 — the strict run-id form is the gate's and the task file's,
    // needed on a conflict only: another verdict records any id the dispatch
    // could have used, such as one with an extended ISO time.
    it('a pass or concerns records a run id with colons and dots; a conflict refuses it before any write', async () => {
      const runId = 'macro-plan-2026-10-10T00:00:00.000Z-abc';
      for (const [VERDICT, ENSEMBLE_VERDICT, recorded] of [['pass', undefined, 'pass'], ['concerns', undefined, 'concerns'], ['concerns', 'failed', 'failed']]) {
        await withTextRepo(async (dir, textDir) => {
          const filePath = await plannedMacro(dir);
          const r = await runFinalize(dir, textDir, filePath, { VERDICT, ENSEMBLE_VERDICT, RUN_ID: runId });
          strictEqual(r.status, 0, `${recorded}: ${r.stderr}`);
          const { frontmatter } = await readWorkflow(filePath);
          deepStrictEqual([frontmatter.ensemble_results.at(-1).run_id, frontmatter.ensemble_results.at(-1).verdict], [runId, recorded]);
        });
      }
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const before = await readFile(filePath, 'utf8');
        const r = await runFinalize(dir, textDir, filePath, { VERDICT: 'conflict', RUN_ID: runId }, { 'note.md': 'The note\n', 'summary.txt': 'The summary\n', 'contested.md': 'C1\n' });
        strictEqual(r.status, 1, r.stderr);
        ok(/not a run id the verdict conflict can record; nothing was written\./.test(r.stderr), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before);
      });
    });

    // Critique G2 — the verdict is held to the gate plan-set recorded for the
    // run, and to a result already recorded for it, before any write: a wrong
    // VERDICT line is refused and fixed, never recorded for good.
    it('a verdict the gate plan-set recorded, or the run\'s recorded result, contradicts stops the block before any write', async () => {
      const RUN_ID = 'macro-plan-20260930T000000Z-abcdef';
      const files = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n', 'contested.md': 'C1\n' };
      for (const [what, gateRun, extra, why] of [
        ['a pass over the run\'s plan-conflict gate', RUN_ID, { VERDICT: 'pass' }, /plan-set recorded the plan-conflict gate for run macro-plan-20260930T000000Z-abcdef, but VERDICT is pass/],
        ['a failed run over the run\'s plan-conflict gate', RUN_ID, { VERDICT: 'concerns', ENSEMBLE_VERDICT: 'failed' }, /but VERDICT is concerns/],
      ]) {
        await withTextRepo(async (dir, textDir) => {
          const filePath = await plannedMacro(dir);
          if (gateRun) await conflictGate(filePath, gateRun);
          const before = await readFile(filePath, 'utf8');
          const r = await runFinalize(dir, textDir, filePath, { RUN_ID, ...extra }, files);
          strictEqual(r.status, 1, `${what}: ${r.stderr}`);
          ok(why.test(r.stderr) && r.stderr.trimEnd().endsWith('nothing was written.'), `${what}: ${r.stderr}`);
          strictEqual(await readFile(filePath, 'utf8'), before, `${what}: nothing was written`);
        });
      }
      // The macro read is checked apart from the parser (C110): a read that
      // prints the macro's JSON and then fails stops the block too.
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const before = await readFile(filePath, 'utf8');
        const r = await runFinalize(dir, textDir, filePath, { VERDICT: 'pass', RUN_ID, AGENTIC_ORCHESTRATOR_ROOT: await failingRoot(dir), FAIL_STEP: 'read', FAIL_AFTER: '1' }, files);
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes(`✗ Could not read ${filePath}; nothing was written.`), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before, 'nothing was written');
      });
      // The stuck state the check prevents: plan-set with conflict, then a
      // finalize with pass. Refused, then fixed to conflict: the note once, the
      // result conflict, the task file.
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        await conflictGate(filePath, RUN_ID);
        let r = await runFinalize(dir, textDir, filePath, { VERDICT: 'pass', RUN_ID }, files);
        strictEqual(r.status, 1, r.stderr);
        r = await runFinalize(dir, textDir, filePath, { VERDICT: 'conflict', RUN_ID }, files);
        strictEqual(r.status, 0, r.stderr);
        const { frontmatter, body } = await readWorkflow(filePath);
        strictEqual(notesIn(body), 1);
        deepStrictEqual(frontmatter.ensemble_results.map((e) => [e.run_id, e.verdict]), [[RUN_ID, 'conflict']]);
        ok(existsSync(consensusTask(dir, filePath, RUN_ID)), 'the task file');
      });
      // A recorded result keeps its verdict: a rerun with another is refused
      // by the result ensemble_results holds for the run, with the same one it
      // goes through (and records the note again).
      for (const [first, second] of [[{ VERDICT: 'pass' }, { VERDICT: 'concerns' }], [{ VERDICT: 'concerns', ENSEMBLE_VERDICT: 'failed' }, { VERDICT: 'concerns' }]]) {
        await withTextRepo(async (dir, textDir) => {
          const filePath = await plannedMacro(dir);
          let r = await runFinalize(dir, textDir, filePath, { RUN_ID, ...first }, files);
          strictEqual(r.status, 0, r.stderr);
          const before = await readFile(filePath, 'utf8');
          const recorded = first.ENSEMBLE_VERDICT ?? first.VERDICT;
          r = await runFinalize(dir, textDir, filePath, { RUN_ID, ...second }, files);
          strictEqual(r.status, 1, r.stderr);
          ok(r.stderr.includes(`the ensemble result of run ${RUN_ID} is already recorded with the verdict ${recorded}, not ${second.VERDICT}`) && r.stderr.trimEnd().endsWith('nothing was written.'), r.stderr);
          strictEqual(await readFile(filePath, 'utf8'), before, 'nothing was written');
          r = await runFinalize(dir, textDir, filePath, { RUN_ID, ...first }, files);
          strictEqual(r.status, 0, r.stderr);
          deepStrictEqual((await readWorkflow(filePath)).frontmatter.ensemble_results.map((e) => [e.run_id, e.verdict]), [[RUN_ID, recorded]]);
        });
      }
    });

    // The round is proposed only while the plan-conflict gate names the run.
    // A finalize that stopped before its result (or before its note), rerun
    // after the owner cleared the gate, records the conflict's result and
    // proposes no round; so does a conflict plan-set never gated. Whether the
    // owner cleared this run's gate is not in the macro's machine data, so
    // another verdict is not refused then (C132, Left open).
    it('a conflict rerun after the owner cleared the run\'s gate records its result and proposes no round', async () => {
      const RUN_ID = 'macro-plan-20260930T000000Z-abcdef';
      const files = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n', 'contested.md': 'C1\n' };
      for (const [step, notes] of [['ensemble-commit', 2], ['append', 1]]) {
        await withTextRepo(async (dir, textDir) => {
          const filePath = await plannedMacro(dir);
          await conflictGate(filePath, RUN_ID);
          // The pending entry the dispatch recorded, which the rerun's commit pops.
          await recordPendingEnsemble({ workflowPath: filePath, phase: 'plan', ensemble_type: 'plan-verify', run_id: RUN_ID });
          let r = await runFinalize(dir, textDir, filePath, { VERDICT: 'conflict', RUN_ID, AGENTIC_ORCHESTRATOR_ROOT: await failingRoot(dir), FAIL_STEP: step }, files);
          strictEqual(r.status, 1, `${step}: ${r.stderr}`);
          await clearAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-conflict', env: blockEnv({}) });
          r = await runFinalize(dir, textDir, filePath, { VERDICT: 'conflict', RUN_ID }, files);
          strictEqual(r.status, 0, `${step}: ${r.stderr}`);
          ok(r.stderr.includes(`No plan-conflict gate names run ${RUN_ID}`) && !r.stderr.includes('runtime:consensus'), `${step}: ${r.stderr}`);
          const { frontmatter, body } = await readWorkflow(filePath);
          strictEqual(notesIn(body), notes, `${step}: the note once per append that ran`);
          deepStrictEqual(frontmatter.ensemble_results.map((e) => [e.run_id, e.verdict]), [[RUN_ID, 'conflict']], step);
          deepStrictEqual(frontmatter.pending_ensemble ?? [], [], `${step}: the pending entry is popped`);
          ok(!existsSync(consensusTask(dir, filePath, RUN_ID)), `${step}: no round for a decided conflict`);
        });
      }
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const r = await runFinalize(dir, textDir, filePath, { VERDICT: 'conflict', RUN_ID }, files);
        strictEqual(r.status, 0, r.stderr);
        ok(r.stderr.includes(`No plan-conflict gate names run ${RUN_ID}`), r.stderr);
        deepStrictEqual((await readWorkflow(filePath)).frontmatter.ensemble_results.map((e) => e.verdict), ['conflict']);
        ok(!existsSync(consensusTask(dir, filePath, RUN_ID)), 'no round without the gate');
      });
    });

    // Critique H2 — a run id is recorded only for the macro its dispatch was
    // for: the plan-set and note blocks refuse a run-macro naming another
    // macro, or none; the dispatch empties run-id before its checks, so one
    // that stops at a check leaves no run id of an earlier dispatch behind.
    it('a run dispatched for another macro, or left by an earlier dispatch, is not recorded', async () => {
      const RUN_ID = 'macro-plan-20260930T000000Z-abcdef';
      const files = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n', 'contested.md': 'C1\n' };
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const otherMacro = join(dir, 'macro-a.md');
        for (const [what, RUN_MACRO, why] of [
          ['another macro', otherMacro, `✗ Run ${RUN_ID} was dispatched for ${otherMacro}, not for ${filePath}: dispatch a Plan-verify run for this macro; nothing was written.`],
          ['no run-macro', null, '/run-macro; nothing was written.'],
        ]) {
          await rm(join(textDir, 'run-macro'), { force: true });
          const before = await readFile(filePath, 'utf8');
          const r = await runFinalize(dir, textDir, filePath, { VERDICT: 'pass', RUN_ID, RUN_MACRO }, files);
          strictEqual(r.status, 1, `${what}: ${r.stderr}`);
          ok(r.stderr.includes(why), `${what}: ${r.stderr}`);
          strictEqual(await readFile(filePath, 'utf8'), before, `${what}: nothing was written`);
        }
        // plan-set with a conflict records the run's id only for its macro.
        const { planSet } = await planPhase2Blocks();
        await writeTexts(textDir, { 'subtasks.json': SUBTASKS_JSON, 'decision.txt': 'Decide A\n', 'architecture.txt': 'One lane\n', 'run-id': RUN_ID, 'run-macro': otherMacro, 'macro-path': filePath });
        const before = await readFile(filePath, 'utf8');
        const r = spawnSync(shell, ['-c', withVerdicts(withTextDir(planSet, textDir), { VERDICT: 'conflict' })], { cwd: dir, encoding: 'utf8', env: blockEnv({}) });
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes(`✗ Run ${RUN_ID} was dispatched for ${otherMacro}, not for ${filePath}`), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before, 'plan-set wrote nothing');
        // The dispatch that stops at its prompt check leaves run-id empty, and
        // the note block then refuses rather than record the earlier run.
        await writeTexts(textDir, { 'run-id': RUN_ID, 'run-macro': filePath });
        await rm(join(textDir, 'prompt.xml'), { force: true });
        const { dispatch } = await planTextBlocks();
        const d = spawnSync(shell, ['-c', withTextDir(dispatch, textDir)], { cwd: dir, encoding: 'utf8', env: blockEnv({}) });
        strictEqual(d.status, 1, d.stderr);
        strictEqual(await readFile(join(textDir, 'run-id'), 'utf8'), '', 'the earlier run id is gone');
        const f = await runFinalize(dir, textDir, filePath, { VERDICT: 'pass', RUN_ID: null, RUN_MACRO: null }, files);
        strictEqual(f.status, 1, f.stderr);
        ok(f.stderr.includes('/run-id is empty; nothing was written.'), f.stderr);
        // The control: this macro's run is recorded.
        const c = await runFinalize(dir, textDir, filePath, { VERDICT: 'pass', RUN_ID }, files);
        strictEqual(c.status, 0, c.stderr);
      });
    });
  });

  describe(`$orchestrator:plan Step 6 block, the Codex skill (${shell})`, () => {
    const runCodexCommit = async (dir, textDir, active, files, { verdicts, env = {}, root } = {}) => {
      // The agent wrote both with its file-editing tool, each line ending in a newline.
      await writeTexts(textDir, { 'macro-path': `${active}\n`, 'run-id': 'macro-plan-20261010T000000Z-c0de00\n', 'run-macro': `${active}\n`, ...files });
      return spawnSync(shell, ['-c', await codexPlanCommitBlock(textDir, verdicts, root)], { cwd: dir, encoding: 'utf8', env: blockEnv(env) });
    };

    // C132 on Codex: the same rerun after a failure at each write.
    it('a rerun after a failure at any write keeps the ensemble result once and writes the task file; past the append it records the note again (C132)', async () => {
      for (const [step, after] of ['append', 'ensemble-commit', 'consensus-task'].flatMap((s) => [[s, ''], [s, '1']])) {
        await withTextRepo(async (dir, textDir) => {
          const filePath = await plannedMacro(dir);
          await conflictGate(filePath, 'macro-plan-20261010T000000Z-c0de00');
          const files = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n', 'contested.md': 'C1: split A or not\n' };
          const failing = await failingRoot(dir);
          const first = await runCodexCommit(dir, textDir, filePath, files, { verdicts: { VERDICT: 'conflict' }, env: { FAIL_STEP: step, FAIL_AFTER: after }, root: failing });
          strictEqual(first.status, 1, `${step}: ${first.stderr}`);
          ok(first.stderr.includes(`✗ injected failure: ${step}`), first.stderr);
          const again = await runCodexCommit(dir, textDir, filePath, files, { verdicts: { VERDICT: 'conflict' } });
          strictEqual(again.status, 0, `${step}: ${again.stderr}`);
          const { frontmatter, body } = await readWorkflow(filePath);
          strictEqual(notesIn(body), step === 'append' && after === '' ? 1 : 2, `${step}${after ? ' (after)' : ''}: the note once per append that ran`);
          deepStrictEqual(frontmatter.ensemble_results.filter((e) => e.run_id === 'macro-plan-20261010T000000Z-c0de00').map((e) => e.verdict), ['conflict'], `${step}: the result once`);
          ok(existsSync(consensusTask(dir, filePath, 'macro-plan-20261010T000000Z-c0de00')), `${step}: the task file`);
        });
      }
    });

    // Critique K2 — the conflict inputs on Codex, as on Claude: the contested
    // items consensus-task reads, and a failed run, which gave no peer
    // positions to conflict with. Each is refused before the note and the
    // result are written, with the run's plan-conflict gate set as Step 5
    // sets it.
    it('a conflict with no or a blank contested.md, or a failed run with a conflict, stops the block before any write (C132)', async () => {
      const files = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n' };
      for (const [what, more, verdicts, why] of [
        ['no contested.md', {}, { VERDICT: 'conflict' }, /contested\.md is missing or blank/],
        ['a blank contested.md', { 'contested.md': ' \n\t\n' }, { VERDICT: 'conflict' }, /contested\.md is missing or blank/],
        ['a failed run with a conflict', { 'contested.md': 'C1\n' }, { VERDICT: 'conflict', ENSEMBLE_VERDICT: 'failed' }, /gave no peer positions to conflict with/],
      ]) {
        await withTextRepo(async (dir, textDir) => {
          const filePath = await plannedMacro(dir);
          await conflictGate(filePath, 'macro-plan-20261010T000000Z-c0de00');
          const before = await readFile(filePath, 'utf8');
          const r = await runCodexCommit(dir, textDir, filePath, { ...files, ...more }, { verdicts });
          strictEqual(r.status, 1, `${what}: ${r.stderr}`);
          ok(why.test(r.stderr) && r.stderr.trimEnd().endsWith('nothing was written.'), `${what}: ${r.stderr}`);
          strictEqual(await readFile(filePath, 'utf8'), before, `${what}: nothing was written`);
          ok(!existsSync(consensusTask(dir, filePath, 'macro-plan-20261010T000000Z-c0de00')), `${what}: no task file`);
        });
      }
    });

    it('a terminal macro, or one made terminal since a failed run, stops the block before any write (Refine-verify N1)', async () => {
      const files = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n' };
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const failing = await failingRoot(dir);
        const first = await runCodexCommit(dir, textDir, filePath, files, { env: { FAIL_STEP: 'ensemble-commit' }, root: failing });
        strictEqual(first.status, 1, first.stderr);
        await setMacroTerminal({ workflowPath: filePath, host: 'codex', terminalPhase: 'aborted' });
        const before = await readFile(filePath, 'utf8');
        const again = await runCodexCommit(dir, textDir, filePath, files);
        strictEqual(again.status, 1, again.stderr);
        ok(again.stderr.includes('a terminal macro is not revised') && again.stderr.trimEnd().endsWith('nothing was written.'), again.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before, 'nothing was written');
      });
    });

    it('a verdict the gate Step 5 recorded, or the run\'s recorded result, contradicts stops the block before any write (Critique G2)', async () => {
      const RUN_ID = 'macro-plan-20261010T000000Z-c0de00';
      const files = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n', 'contested.md': 'C1\n' };
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        await conflictGate(filePath, RUN_ID);
        const before = await readFile(filePath, 'utf8');
        let r = await runCodexCommit(dir, textDir, filePath, files, { verdicts: { VERDICT: 'pass' } });
        strictEqual(r.status, 1, r.stderr);
        ok(/plan-set recorded the plan-conflict gate for run macro-plan-20261010T000000Z-c0de00, but VERDICT is pass.*nothing was written\./.test(r.stderr), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before);
        r = await runCodexCommit(dir, textDir, filePath, files, { verdicts: { VERDICT: 'conflict' } });
        strictEqual(r.status, 0, r.stderr);
        deepStrictEqual((await readWorkflow(filePath)).frontmatter.ensemble_results.map((e) => e.verdict), ['conflict']);
        ok(existsSync(consensusTask(dir, filePath, RUN_ID)), 'the task file while the gate names the run');
      });
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        let r = await runCodexCommit(dir, textDir, filePath, files, { verdicts: { VERDICT: 'pass' } });
        strictEqual(r.status, 0, r.stderr);
        const before = await readFile(filePath, 'utf8');
        r = await runCodexCommit(dir, textDir, filePath, files, { verdicts: { VERDICT: 'concerns' } });
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes(`the ensemble result of run ${RUN_ID} is already recorded with the verdict pass, not concerns`) && r.stderr.trimEnd().endsWith('nothing was written.'), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before);
      });
      // A read that prints the macro's JSON and then fails (C110).
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const before = await readFile(filePath, 'utf8');
        const r = await runCodexCommit(dir, textDir, filePath, files, { verdicts: { VERDICT: 'pass' }, env: { FAIL_STEP: 'read', FAIL_AFTER: '1' }, root: await failingRoot(dir) });
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes(`✗ Could not read ${filePath}; nothing was written.`), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before, 'nothing was written');
      });
      // A rerun after the owner cleared the gate records the conflict's
      // result and proposes no round.
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        await conflictGate(filePath, RUN_ID);
        await recordPendingEnsemble({ workflowPath: filePath, phase: 'plan', ensemble_type: 'plan-verify', run_id: RUN_ID });
        let r = await runCodexCommit(dir, textDir, filePath, files, { verdicts: { VERDICT: 'conflict' }, env: { FAIL_STEP: 'ensemble-commit' }, root: await failingRoot(dir) });
        strictEqual(r.status, 1, r.stderr);
        await clearAwaitingOwner({ workflowPath: filePath, host: 'codex', gate: 'plan-conflict', env: blockEnv({}) });
        r = await runCodexCommit(dir, textDir, filePath, files, { verdicts: { VERDICT: 'conflict' } });
        strictEqual(r.status, 0, r.stderr);
        ok(r.stderr.includes(`No plan-conflict gate names run ${RUN_ID}`), r.stderr);
        const { frontmatter } = await readWorkflow(filePath);
        deepStrictEqual(frontmatter.ensemble_results.map((e) => e.verdict), ['conflict']);
        deepStrictEqual(frontmatter.pending_ensemble ?? [], [], 'the pending entry is popped');
        ok(!existsSync(consensusTask(dir, filePath, RUN_ID)), 'no round for a decided conflict');
      });
      // Critique H2 on Codex — a run-macro naming another macro is refused.
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const before = await readFile(filePath, 'utf8');
        const otherMacro = join(dir, 'macro-a.md');
        const r = await runCodexCommit(dir, textDir, filePath, { ...files, 'run-macro': `${otherMacro}\n` }, { verdicts: { VERDICT: 'pass' } });
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes(`✗ Run ${RUN_ID} was dispatched for ${otherMacro}, not for ${filePath}`), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before, 'nothing was written');
      });
    });

    // Critique F1, F2 and F5 on Codex: a later run's note and result after the
    // first's, the macro from macro-path, and the strict run-id form on a
    // conflict only.
    it('a later run records its own note, the macro is the one macro-path names, and a non-conflict takes any dispatched run id', async () => {
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        execFileSync('git', ['-C', dir, 'switch', '-q', '-c', 'feat/other']);
        const { filePath: other } = await createWorkflow({
          repoRoot: dir, verb: 'plan', host: 'claude',
          gitBaseline: { branch: 'feat/other', head: '0'.repeat(40), status_digest: '' },
          originalRequest: 'the macro the switched branch names',
        });
        const otherBefore = await readFile(other, 'utf8');
        const second = 'macro-plan-2026-10-10T00:00:00.000Z-abc';
        for (const [runId, note] of [['macro-plan-20261010T000000Z-c0de00', 'The first note\n'], [second, 'The second note\n']]) {
          const r = await runCodexCommit(dir, textDir, filePath, { 'run-id': `${runId}\n`, 'note.md': note, 'summary.txt': 'The summary\n' });
          strictEqual(r.status, 0, r.stderr);
        }
        const { frontmatter, body } = await readWorkflow(filePath);
        strictEqual(notesIn(body), 2, 'one note per finalize');
        ok(body.includes(`${NOTE_HEADING}\n\nThe second note\n`), body);
        deepStrictEqual(frontmatter.ensemble_results.map((e) => e.run_id), ['macro-plan-20261010T000000Z-c0de00', second]);
        strictEqual(await readFile(other, 'utf8'), otherBefore, 'the macro the branch names now is untouched');
        const before = await readFile(filePath, 'utf8');
        const r = await runCodexCommit(dir, textDir, filePath, { 'run-id': `${second}\n`, 'note.md': 'n\n', 'summary.txt': 's\n', 'contested.md': 'C1\n' }, { verdicts: { VERDICT: 'conflict' } });
        strictEqual(r.status, 1, r.stderr);
        ok(/not a run id the verdict conflict can record; nothing was written\./.test(r.stderr), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before);
      });
    });

    it('records the note and the ensemble result as written, and none of it runs', async () => {
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const r = await runCodexCommit(dir, textDir, filePath, { 'note.md': `${hostile('note')}\n`, 'summary.txt': `${hostile('summary')}\n` });
        strictEqual(r.status, 0, r.stderr);
        const { frontmatter, body } = await readWorkflow(filePath);
        ok(body.includes(`${NOTE_HEADING}\n\n${hostile('note')}\n\n`), body);
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

        const { find } = await planTextBlocks();
        let r = run(find, {});
        strictEqual(r.status, 0, r.stderr);
        strictEqual(r.stdout, 'ACTIVE=\n', 'no macro on the branch yet');
        r = run(`${bootstrap}\nprintf '%s\\n' "$ACTIVE"\n`, {});
        strictEqual(r.status, 0, r.stderr);
        const filePath = r.stdout.trim();
        // create scrubs the request to one line; nothing else changes it.
        strictEqual((await readWorkflow(filePath)).frontmatter.original_request, hostile('request').split('\n').join(' '));
        // As the dispatch writes them: the run's macro, then its id.
        await writeTexts(textDir, { 'run-macro': filePath, 'run-id': 'macro-plan-20261010T000000Z-0c1300' });
        r = run(withVerdicts(planSet, { VERDICT: 'concerns' }), {});
        strictEqual(r.status, 0, r.stderr);
        r = run(withVerdicts(finalize, { VERDICT: 'concerns' }), {});
        strictEqual(r.status, 0, r.stderr);

        const { frontmatter, body } = await readWorkflow(filePath);
        deepStrictEqual([frontmatter.plan.decision, frontmatter.plan.architecture], [hostile('decision'), `${hostile('architecture')}\n`]);
        ok(body.includes(`${NOTE_HEADING}\n\n${hostile('note')}\n\n`), body);
        strictEqual(frontmatter.ensemble_results.at(-1).summary, hostile('summary'));
        ok(!(await readFile(filePath, 'utf8')).includes('from the environment'), 'no NOTE or SUMMARY of the environment was recorded');
        await nothingRan(dir, textDir);
      });
    });

    it('the dispatch block refuses a missing prompt file before it dispatches', async () => {
      await withTextRepo(async (dir, textDir) => {
        const { dispatch } = await planTextBlocks();
        await writeTexts(textDir, { 'macro-path': await plannedMacro(dir) });
        const r = spawnSync(shell, ['-c', withTextDir(dispatch, textDir)], { cwd: dir, encoding: 'utf8', env: blockEnv({}) });
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes(`✗ ${textDir}/prompt.xml is missing or empty`), r.stderr);
        deepStrictEqual((await readdir(textDir)).sort(), ['macro-path', 'run-id'], 'no run was started: no run JSON beside the prompt');
        strictEqual(await readFile(join(textDir, 'run-id'), 'utf8'), '', 'and no run id');
      });
    });

    // Critique K3 — the dispatch block as it runs, in a fresh shell, with a
    // plugin root whose peer-runner records what it was given and what the
    // text directory held when it started, then answers after a pause. The
    // block empties the run id an earlier dispatch left, writes this run's
    // macro and id before it dispatches, and runs the runner in its own
    // foreground (the host backgrounds the block, never a shell `&`), so the
    // block's exit follows the runner's answer.
    it('the dispatch block writes run-macro and run-id before the runner starts, and runs it in the foreground (C75)', async () => {
      await withTextRepo(async (dir, textDir) => {
        const text = await readFile(resolve(ORCH_ROOT, 'commands/plan.md'), 'utf8');
        const { dispatch } = await planTextBlocks();
        // Contract: the agent launching the Plan-verify peer — a shell `&`
        // detaches the runner where neither the agent nor an autopilot host
        // can wait for it, and loses the run id with its shell.
        ok(!/&\s*$/m.test(dispatch.replace(/&&/g, '')), 'no line ends in a background &');
        ok(/run_in_background/.test(text.slice(0, text.indexOf(dispatch))), 'the text before it says to use the host background task');
        const shim = join(dir, 'shim-root');
        await mkdir(join(shim, 'scripts'), { recursive: true });
        await writeFile(join(shim, 'scripts', 'peer-runner.mjs'), [
          "import { readFileSync, writeFileSync } from 'node:fs';",
          "import { dirname, join } from 'node:path';",
          'const args = process.argv.slice(2);',
          "const textDir = dirname(args[args.indexOf('--prompt-file') + 1]);",
          "const held = (name) => readFileSync(join(textDir, name), 'utf8');",
          "const seen = { args, runId: held('run-id'), runMacro: held('run-macro') };",
          'await new Promise((r) => setTimeout(r, 400));',
          'writeFileSync(process.env.SHIM_LOG, JSON.stringify(seen));',
          "process.stdout.write('{\"shim\":true}\\n');",
        ].join('\n'));
        const filePath = await plannedMacro(dir);
        const shimLog = join(dir, 'shim-log.json');
        // What an earlier dispatch, for another macro, left in the directory.
        await writeTexts(textDir, { 'macro-path': filePath, 'prompt.xml': '<prompt/>\n', 'run-id': 'macro-plan-20261009T000000Z-0ld000', 'run-macro': join(dir, 'other-macro.md') });
        const r = spawnSync(shell, ['-c', withTextDir(dispatch, textDir)], { cwd: dir, encoding: 'utf8', env: blockEnv({ AGENTIC_ORCHESTRATOR_ROOT: shim, SHIM_LOG: shimLog }) });
        strictEqual(r.status, 0, r.stderr);
        ok(existsSync(shimLog), 'the runner had answered when the block exited');
        const seen = JSON.parse(await readFile(shimLog, 'utf8'));
        const opt = (name) => seen.args[seen.args.indexOf(name) + 1];
        strictEqual(seen.args[0], 'run');
        // The random tail's length is not pinned: zsh binds `&` before `*`, so
        // its RANDOM line (runid-runbooks') can print more than six digits.
        ok(/^macro-plan-\d{8}T\d{6}Z-[0-9a-f]+$/.test(opt('--run-id')), opt('--run-id'));
        notStrictEqual(opt('--run-id'), 'macro-plan-20261009T000000Z-0ld000', 'a new run id');
        deepStrictEqual([seen.runId, seen.runMacro], [opt('--run-id'), filePath], 'run-id and run-macro held this run before the runner started');
        strictEqual(opt('--workflow-path'), filePath);
        deepStrictEqual([await readFile(join(textDir, 'run-id'), 'utf8'), await readFile(join(textDir, 'run-macro'), 'utf8')], [opt('--run-id'), filePath]);
        strictEqual(await readFile(join(textDir, 'prompt.xml.run.json'), 'utf8'), '{"shim":true}\n', "the runner's answer");
      });
    });

    // Critique G1 — Phase 0's first block is the one selection: it writes
    // macro-path, and the resume block reads it, so a branch switched between
    // the two resumes the macro Phase 0 found (docket C75: reload, never
    // re-derive).
    it('the resume block resumes the macro Phase 0 found, not the one a branch switched since names', async () => {
      await withTextRepo(async (dir, textDir) => {
        const { find, bootstrap, resume } = await planTextBlocks();
        const run = (block) => spawnSync(shell, ['-c', withTextDir(block, textDir)], { cwd: dir, encoding: 'utf8', env: blockEnv({}) });
        const filePath = await plannedMacro(dir);
        let r = run(find);
        strictEqual(r.status, 0, r.stderr);
        ok(r.stdout.startsWith('ACTIVE=') && realpathSync(r.stdout.slice('ACTIVE='.length).trimEnd()) === realpathSync(filePath), r.stdout);
        const pinned = await readFile(join(textDir, 'macro-path'), 'utf8');
        strictEqual(pinned, r.stdout.slice('ACTIVE='.length).trimEnd(), 'macro-path holds what the block printed');
        execFileSync('git', ['-C', dir, 'switch', '-q', '-c', 'feat/other']);
        const { filePath: other } = await createWorkflow({
          repoRoot: dir, verb: 'plan', host: 'claude',
          gitBaseline: { branch: 'feat/other', head: '0'.repeat(40), status_digest: '' },
          originalRequest: 'the macro the switched branch names',
        });
        const otherBefore = await readFile(other, 'utf8');
        // A bootstrap after Phase 0 found a macro refuses: it would make a second one.
        await writeTexts(textDir, { 'request.txt': 'A request\n' });
        r = run(bootstrap);
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes('run the resume block instead; nothing was written.'), r.stderr);
        r = run(resume);
        strictEqual(r.status, 0, r.stderr);
        const { frontmatter, body } = await readWorkflow(filePath);
        deepStrictEqual([frontmatter.current_phase, body.includes('### Phase 0: Resume macro plan')], ['phase-0-resume', true]);
        strictEqual(await readFile(other, 'utf8'), otherBefore, 'the macro the branch names now is untouched');
        strictEqual(await readFile(join(textDir, 'macro-path'), 'utf8'), pinned, 'the pin is Phase 0\'s');
      });
    });

    it('the resume block refuses an empty macro-path, and both refuse a missing one, before any write', async () => {
      await withTextRepo(async (dir, textDir) => {
        const { bootstrap, resume } = await planTextBlocks();
        const run = (block) => spawnSync(shell, ['-c', withTextDir(block, textDir)], { cwd: dir, encoding: 'utf8', env: blockEnv({}) });
        const filePath = await plannedMacro(dir);
        const before = await readFile(filePath, 'utf8');
        await writeTexts(textDir, { 'request.txt': 'A request\n' });
        for (const block of [bootstrap, resume]) {
          const r = run(block);
          strictEqual(r.status, 1, r.stderr);
          ok(/Phase 0 writes what it found to .*\/macro-path: run it first; nothing was written\./.test(r.stderr), r.stderr);
        }
        await writeTexts(textDir, { 'macro-path': '' });
        const r = run(resume);
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes('Phase 0 found no orchestrator macro on this branch; bootstrap one instead.'), r.stderr);
        // A pinned macro whose file is gone since.
        await writeTexts(textDir, { 'macro-path': join(dir, 'gone.md') });
        const gone = run(resume);
        strictEqual(gone.status, 1, gone.stderr);
        ok(/\/macro-path names no macro file \(".*gone\.md"\); nothing was written\./.test(gone.stderr), gone.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before, 'nothing was written');
        deepStrictEqual((await readdir(join(dir, '.agentic-plugins/state/orchestrator/workflows'))).length, 1, 'no macro was created');
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
      const env = { ...process.env, AGENTIC_ORCHESTRATOR_ROOT: ORCH_ROOT, ACTIVE: join(dir, 'not-the-macro.md'), REPO_ROOT: dir };
      delete env.CLAUDE_PLUGIN_ROOT;
      delete env.AGENTIC_AUTOPILOT;
      const textDir = join(dir, 'texts');
      await mkdir(textDir, { recursive: true });
      await writeFile(join(textDir, 'macro-path'), active);
      const { laneAdvice } = await planPhase2Blocks();
      return spawnSync(shell, ['-c', withTextDir(laneAdvice, textDir)], { cwd: dir, encoding: 'utf8', env });
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
