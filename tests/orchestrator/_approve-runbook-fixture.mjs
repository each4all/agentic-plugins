// tests/orchestrator/_approve-runbook-fixture.mjs
//
// ADR-0063 D6 — the runner the /orchestrator:approve and /orchestrator:plan
// runbook tests share (test-approve-runbook.mjs, the static contracts and the
// branches and refusals, each once in bash; test-approve-runbook-e2e.mjs, the
// happy path of each runbook path in every shell). Each block is sliced from
// the runbook as written (commands/approve.md, commands/plan.md, and the Codex
// plan skill core/skills/plan/SKILL.md) by its heading, its placeholders filled
// as the agent fills them, and run in a fresh shell against real macro files.

import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { withArgs } from './_command-args-file.mjs';

export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
export const ORCH_ROOT = resolve(REPO_ROOT, 'plugins/orchestrator');
export const ENG_ROOT = resolve(REPO_ROOT, 'plugins/engineer');
const orch = await import(resolve(ORCH_ROOT, 'scripts/state.mjs'));
export const {
  createWorkflow, setPlan, setAwaitingOwner, clearAwaitingOwner, recordPendingEnsemble, setMacroTerminal, readWorkflow, computePlanHash, updateSubtask,
} = orch;
export const eng = await import(resolve(ENG_ROOT, 'scripts/state.mjs'));

export const AUTOPILOT_RUN_ID = 'autopilot-20260930T010203Z-abcdef';
/**
 * Each shell the runbooks may run in, with whether it is installed here. Not
 * /bin/sh: the blocks use bash arrays, which dash, Ubuntu's /bin/sh, lacks.
 */
export const APPROVE_SHELLS = ['bash', 'zsh'].map((sh) => [sh, spawnSync(sh, ['-c', 'true']).status === 0]);

export async function approveBlock() {
  const text = await readFile(resolve(ORCH_ROOT, 'commands/approve.md'), 'utf8');
  // Contract: this test slices the block it runs by this heading — a renamed
  // heading must fail here, not run some other block.
  const from = text.indexOf('## Phase 0 — Resolve the macro, show the plan, approve it');
  ok(from >= 0, 'approve.md carries its Phase 0');
  const m = /```bash\n([\s\S]*?)```/.exec(text.slice(from));
  ok(m, 'Phase 0 has a bash block');
  return m[1];
}

export async function withRepo(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-approve-runbook-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init', '--no-gpg-sign']);
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function plannedMacro(dir) {
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
export async function conflictGate(filePath, runId) {
  const { frontmatter } = await readWorkflow(filePath);
  await setPlan({ workflowPath: filePath, host: 'claude', subtasks: frontmatter.plan.subtasks, verdict: 'conflict', runId });
}

// The approve block run with `args`, the command's arguments as typed, in the
// args file the agent writes (ADR-0059, C134(a)): a new one each run, since
// command-args removes the file it read.
export async function run(shell, dir, extraEnv = {}, args = '') {
  const env = { ...process.env, AGENTIC_ORCHESTRATOR_ROOT: ORCH_ROOT, ...extraEnv };
  delete env.CLAUDE_PLUGIN_ROOT;
  if (!('AGENTIC_AUTOPILOT' in extraEnv)) delete env.AGENTIC_AUTOPILOT;
  return spawnSync(shell, ['-c', withArgs(await approveBlock(), args)], { cwd: dir, encoding: 'utf8', env });
}

// ADR-0068 Decision 8 — an in-progress subtask of the macro, dispatched as
// /orchestrator:next does: its child records the dispatch selection.
export async function dispatchedChild(dir, filePath) {
  const { frontmatter } = await readWorkflow(filePath);
  const a = frontmatter.plan.subtasks.find((x) => x.id === 'A');
  const { filePath: child } = await eng.createWorkflow({
    repoRoot: dir, verb: a.verb, host: 'claude', profile: a.profile, originalRequest: a.topic,
    gitBaseline: { branch: a.branch, head: '0'.repeat(40), status_digest: '' },
    currentPhase: 'phase-0-bootstrap', nextAction: 'Run the verb', parentWorkflow: frontmatter.workflow_id, originatingSubtask: 'A',
    dispatchSelection: { subtask: 'A', branch: a.branch, verb: a.verb, profile: a.profile, topic: a.topic },
  });
  const id = (await eng.readWorkflow(child)).frontmatter.workflow_id;
  await updateSubtask({ workflowPath: filePath, host: 'claude', subtaskId: 'A', status: 'in_progress', engineerWorkflowId: id });
  return { path: child, id };
}

// /orchestrator:plan Phase 2. The plan write carries the verdict, so the
// conflict gate is set in the same write as the plan (the state tests cover
// what plan-set does with it); the second block records the note and the
// ensemble result and must fail when either write fails.
export async function planPhase2Blocks() {
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
export async function codexPlanCommitBlock(textDir, verdicts = { VERDICT: 'concerns' }, root = ORCH_ROOT) {
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
export async function planTextBlocks() {
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
export const TEXT_DIR_LINE = "TEXT_DIR='<directory from step 1>'";
export function withTextDir(block, textDir) {
  // Contract: the agent running /orchestrator:plan — a block that does not
  // open with this line reads its files from nowhere the agent wrote them.
  strictEqual(block.split('\n').find((l) => l.trim() !== '').trim(), TEXT_DIR_LINE, 'the block opens with its text directory');
  return block.replace(TEXT_DIR_LINE, () => `TEXT_DIR='${textDir}'`);
}
// The verdict lines the agent fills in (each block runs in a fresh shell, so
// the block holds the verdict itself, docket C75); a case that sets none
// leaves them as written.
const VERDICT_LINE = "VERDICT='<pass|concerns|conflict>'";
export function withVerdicts(block, { VERDICT, ENSEMBLE_VERDICT } = {}) {
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
export async function failingRoot(dir) {
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
export const consensusTask = (dir, filePath, runId) => join(dir, '.agentic-plugins/state/orchestrator/consensus', `${basename(filePath, '.md')}.${runId}.md`);
// The plan's synthesis note, appended by each run of the finalize block.
export const NOTE_HEADING = '### Phase 1: Plan (synthesized)';
export const notesIn = (body) => body.split(`${NOTE_HEADING}\n`).length - 1;
export async function writeTexts(textDir, files) {
  for (const [name, content] of Object.entries(files)) await writeFile(join(textDir, name), content);
}
export const SUBTASKS_JSON = JSON.stringify([{ id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' }]);
// What an agent writes, and what a peer's sentences in a note or summary can
// hold: shell syntax that runs when it is source, a leading --, lines that
// would end a heredoc or name a variable of the block, quotes, a backslash,
// $orchestrator:next as the note's scaffold spells it, and non-ASCII text.
export const hostile = (tag) => [
  `--${tag}: \`touch pwned-${tag}-tick\` and $(touch pwned-${tag}-sub); "double" 'single' back\\slash ü`,
  'PHASE_NOTE',
  'TEXT_DIR',
  `next: $orchestrator:next and \${HOME}`,
].join('\n');
// The environment the blocks run in: no AGENTIC_* of an autopilot worker
// (docket C88), and a NOTE and SUMMARY of its own, which the blocks must not
// read.
export function blockEnv(extra) {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_'))),
    AGENTIC_ORCHESTRATOR_ROOT: ORCH_ROOT, NOTE: 'NOTE from the environment', SUMMARY: 'SUMMARY from the environment', ...extra,
  };
  delete env.CLAUDE_PLUGIN_ROOT;
  return env;
}
// The text directory's path holds a space: a block that passes a file path
// unquoted splits it into two words.
export async function withTextRepo(fn) {
  const textDir = await mkdtemp(join(tmpdir(), 'agentic text.'));
  try {
    return await withRepo((dir) => fn(dir, textDir));
  } finally {
    await rm(textDir, { recursive: true, force: true });
  }
}
export async function nothingRan(...dirs) {
  for (const d of dirs) {
    deepStrictEqual((await readdir(d)).filter((n) => n.startsWith('pwned')), [], `nothing in the text ran in ${d}`);
  }
}

// plan's Phase 2 note + ensemble block in `shell`. `extra`: the verdicts the
// agent puts in the block, the run id the dispatch wrote (RUN_ID) and the
// macro it wrote with it (RUN_MACRO, `active` unless given), and the
// environment the block runs in.
export async function runFinalize(shell, dir, textDir, active, extra = {}, files = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n' }) {
  const { VERDICT = 'pass', ENSEMBLE_VERDICT, RUN_ID = 'macro-plan-20260930T000000Z-abcdef', RUN_MACRO = active, ...env } = extra;
  // active null: Phase 0 wrote no macro-path.
  await writeTexts(textDir, { ...(active === null ? {} : { 'macro-path': active }), ...(RUN_ID === null ? {} : { 'run-id': RUN_ID }), ...(RUN_MACRO === null ? {} : { 'run-macro': RUN_MACRO }), ...files });
  const { finalize } = await planPhase2Blocks();
  // VERDICT null: the line left as the runbook writes it.
  return spawnSync(shell, ['-c', withVerdicts(withTextDir(finalize, textDir), { VERDICT: VERDICT ?? undefined, ENSEMBLE_VERDICT })], { cwd: dir, encoding: 'utf8', env: blockEnv(env) });
}

// The Codex plan skill's Step 6 block in `shell`.
export async function runCodexCommit(shell, dir, textDir, active, files, { verdicts, env = {}, root } = {}) {
  // The agent wrote both with its file-editing tool, each line ending in a newline.
  await writeTexts(textDir, { 'macro-path': `${active}\n`, 'run-id': 'macro-plan-20261010T000000Z-c0de00\n', 'run-macro': `${active}\n`, ...files });
  return spawnSync(shell, ['-c', await codexPlanCommitBlock(textDir, verdicts, root)], { cwd: dir, encoding: 'utf8', env: blockEnv(env) });
}

// ADR-0067 Decision 8, item 2 — the lane advice both runbooks print after the
// plan is stored or approved: one `- lane_advice:` line when two lanes shorten
// the plan, nothing otherwise. In a fresh repository shared creation is off,
// so the line names the cutover instead of the command.
export async function sideBySideMacro(dir) {
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
export const CUTOVER_LINE = '- lane_advice: A and B are independent, C waits on both (3 steps in one lane, 2 with 2); lanes need the state-root cutover first (shared creation is off): docs/runbooks/state-root-cutover.md';
