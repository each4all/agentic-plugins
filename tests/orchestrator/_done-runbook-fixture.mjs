// tests/orchestrator/_done-runbook-fixture.mjs
//
// ADR-0062 — the runner the /orchestrator:done runbook tests share
// (test-done-runbook.mjs, the branches and refusals; test-done-runbook-e2e.mjs,
// the happy path in every shell). The runbook is run as the agent receives
// it: the Phase 0..Completion section of commands/done.md goes through
// Claude's argument substitution for the argument line an operator would type
// (C67: the file as written is not the text the agent reads), then every
// ```bash block in it runs in one shell process (as the runbook requires), its
// arguments in the args file the agent writes (ADR-0059, C134(a)). The Codex
// mirror ($orchestrator:done) runs the one bash block of its skill, with the
// plugin root filled in as the agent fills it. git runs against a real bare
// "origin"; `gh` is a fake on PATH.

import { strictEqual, ok } from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { substituteClaudeArguments } from '../_claude-command-substitution.mjs';
import { withArgs } from './_command-args-file.mjs';
import { isSessionVariable } from '../../scripts/lib/session-env.mjs';

// Run on its own from an agentic session, a test file would inherit the
// session (`npm test` clears it first, tests/_hermetic-env.mjs): the
// fixtures' own writes would follow its AGENTIC_STATE_BASE. Cleared here, at
// import, before any of them; the runbook shells start without it too
// (runbookEnv).
for (const name of Object.keys(process.env)) if (isSessionVariable(name)) delete process.env[name];

export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
export const ORCH_ROOT = resolve(REPO_ROOT, 'plugins/orchestrator');
export const STATE_SCRIPT = resolve(ORCH_ROOT, 'scripts/state.mjs');
const { createWorkflow, setPlan, readWorkflow } = await import(STATE_SCRIPT);
const { parseCommandArguments } = await import(resolve(ORCH_ROOT, 'scripts/lib/command-args.mjs'));

export const DONE_TEXT = await readFile(resolve(ORCH_ROOT, 'commands/done.md'), 'utf8');
// Located in the file, before any rendering: typed text lands in the prose
// above Phase 0, so a heading or a fence inside it cannot move the section.
// Contract: the tests run the bash blocks between these headings.
export const PHASES = DONE_TEXT.slice(DONE_TEXT.indexOf('## Phase 0'), DONE_TEXT.indexOf('## Completion'));

export function bashBlocks(section) {
  const blocks = [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  // Contract: Phases 0-3 are one block, run in one shell (docket C75) — a moved
  // heading that cuts the section short, or a block split again, must fail
  // here, not run part of the runbook.
  strictEqual(blocks.length, 1, `done.md runs its phases as one bash block (found ${blocks.length})`);
  ok(blocks[0].includes("# --- Phase 3b"), "the block runs through Phase 3b");
  return blocks;
}

/**
 * The phases the agent runs after `/orchestrator:done <args>`. Rendering the
 * section alone gives what rendering the whole file gives there — every rule
 * is a local replacement — except the trailing ARGUMENTS line Claude adds to a
 * body with no placeholder, which done.md has; the invariance test checks it.
 */
export const renderPhases = (args) => substituteClaudeArguments(PHASES, args, { appendIfUnused: false });
export const runbookScript = (args) => bashBlocks(renderPhases(args)).join('\n');
export { substituteClaudeArguments };

/** The argument line an operator types for these arguments (argument-hint order). */
function typedArguments(vars, reason) {
  const parts = [vars.subtask];
  if (vars.pr) parts.push(`--pr=${vars.pr}`);
  if (vars.commit) parts.push(`--commit=${vars.commit}`);
  if (vars.correct) parts.push('--correct');
  if (vars.no_commit) parts.push('--no-commit');
  if (vars.waive_dispatch) parts.push('--waive-dispatch');
  if (vars.accept_landed_change) parts.push('--accept-landed-change');
  if (vars.workflow) parts.push(`--workflow=${vars.workflow}`);
  if (vars.integration_branch) parts.push(`--integration-branch=${vars.integration_branch}`);
  if (reason !== null) parts.push(reason);
  return parts.join(' ');
}

// The line of each runbook's block that names the args directory the agent made.
const ARGS_LINE = { claude: "ARGS_DIR='<directory from step 1>'", codex: "ARGS_DIR='<directory from mktemp>'" };
// The block's call to the argument parser.
const PARSE_CALL = /^ARGS_JSON="\$\(node "[^"\n]*\/scripts\/state\.mjs" command-args \\\n {2}--command done --args-file "\$ARGS_DIR\/args\.json"\)" \|\| exit 1$/m;
// A word holding a quote or a backslash cannot be typed: the grammar refuses
// it (the quoted-id case). A subtask id holding one is still a plan's to
// carry, and /orchestrator:next selects it by itself, so the cases that test
// how the block reads such an id by its value run the block from its parsed
// arguments on: the parser's call replaced by the fields it prints for the
// same line, with that id.
const TYPABLE = /^[^"'\\\s]+$/;
function withParsedArgs(block, vars, reason) {
  ok(PARSE_CALL.test(block), 'the block parses its arguments with state.mjs command-args');
  const fields = parseCommandArguments('done', typedArguments({ ...vars, subtask: 'X' }, reason));
  fields.subtask_id = vars.subtask;
  return block.replace(PARSE_CALL, () => `ARGS_JSON='${JSON.stringify(fields).replace(/'/g, "'\\''")}'`);
}

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t.local',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t.local',
  GIT_CONFIG_NOSYSTEM: '1',
};
export const GIT_ENV = { ...process.env, ...GIT_IDENTITY };
export const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

// The environment a runbook shell starts from: this process's, read when the
// block runs, without the agentic session's variables (scripts/lib/session-env.mjs).
// `npm test` clears them before any test, but a file run on its own from an
// agentic session (an autopilot worker) inherits them: AGENTIC_ORCHESTRATOR_ROOT
// would run the installed orchestrator instead of this tree's. A case that needs
// one sets it itself.
const runbookEnv = () => Object.fromEntries(Object.entries({ ...process.env, ...GIT_ENV, ...GIT_IDENTITY }).filter(([k]) => !isSessionVariable(k)));

/** Each shell the runbooks may run in, with whether it is installed here. */
export const DONE_SHELLS = ['bash', 'zsh'].map((sh) => [sh, spawnSync(sh, ['-c', 'true']).status === 0]);

const SKILL_TEXT = await readFile(resolve(ORCH_ROOT, 'core/skills/done/SKILL.md'), 'utf8');
/** The Codex skill's one bash block, its plugin root filled in as the agent fills it. */
export function codexBlock(root = ORCH_ROOT) {
  const blocks = [...SKILL_TEXT.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
  // Contract: one block, as on Claude — a block split again must fail here.
  strictEqual(blocks.length, 1, `the Codex done skill runs its phases as one bash block (found ${blocks.length})`);
  ok(blocks[0].includes('# --- Phase 3: resolve the landing'), 'the block runs through the landing');
  return blocks[0].replaceAll('<orchestrator-plugin-root>', root);
}

/**
 * The shell and the runbook (`claude`, commands/done.md; `codex`, the skill)
 * the running suite holds; a suite sets both in its `before`.
 */
export const runner = { shell: 'bash', variant: 'claude' };

export const ENGINEER_ID = 'compose-20260927T100000Z-abcdef';
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

/**
 * A repository with a bare origin, a macro whose subtask A (branch feat/a,
 * merged as pull request #7) blocks B, and A's engineer child archived; `fn`
 * receives `done(vars, opts)`, which runs the runbook `runner` names.
 */
export async function withFixture(fn, { topicA, idA = 'A' } = {}) {
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
    // The runbook's own temporary directories (the reason file) go under the
    // fixture, which is removed with it.
    const shellTmp = join(dir, 'tmp');
    await mkdir(shellTmp);
    const prsFile = join(dir, 'prs.json');
    const pr = (over = {}) => ({
      number: 7, url: 'https://github.com/o/r/pull/7', state: 'MERGED', baseRefName: 'main',
      headRefName: 'feat/a', createdAt: '2026-09-27T10:30:00Z', mergeCommit: { oid: squash }, ...over,
    });
    // The agent writes the arguments, the reason with them, into the args file
    // with its file-writing tool; the runbook never sees the text as shell
    // input. `typed` overrides the argument line when a case needs its exact spelling;
    // `prelude` runs before the script (shell options).
    // On Codex the plugin root a case swaps in (a shim) is the one the agent
    // fills into the block, and no Claude variable reaches the shell.
    async function done(vars, { prs = [pr()], reason = null, env = {}, typed = null, prelude = '' } = {}) {
      await writeFile(prsFile, JSON.stringify(prs));
      const all = { subtask: idA, ...vars };
      const codex = runner.variant === 'codex';
      // An id that cannot be typed is rendered as one that can: Claude's
      // substitution changes no bash block (the invariance case).
      const typable = typed !== null || TYPABLE.test(all.subtask);
      const text = typed ?? typedArguments(typable ? all : { ...all, subtask: 'X' }, reason);
      const block = codex
        ? codexBlock(env.AGENTIC_ORCHESTRATOR_ROOT ?? ORCH_ROOT)
        : runbookScript(text);
      const script = typable
        ? withArgs(block, text, { line: ARGS_LINE[runner.variant], base: dir })
        : withParsedArgs(block, all, reason);
      const full = `${prelude}\ncd '${work}'\n${script}`;
      const base = { ...runbookEnv(), TMPDIR: shellTmp, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, FAKE_GH_PRS: prsFile };
      let shellEnv;
      if (codex) {
        const { CLAUDE_PLUGIN_ROOT: _r, AGENTIC_ORCHESTRATOR_ROOT: _o, AGENTIC_HOST: _h, ...rest } = { ...base, ...env };
        shellEnv = rest;
      } else {
        shellEnv = { ...base, CLAUDE_PLUGIN_ROOT: ORCH_ROOT, AGENTIC_HOST: 'claude', ...env };
      }
      const r = spawnSync(runner.shell, ['-c', full], { encoding: 'utf8', env: shellEnv });
      return { status: r.status, stderr: r.stderr, stdout: r.stdout };
    }
    const subtask = async (id = idA) => (await readWorkflow(macroPath)).frontmatter.plan.subtasks.find((s) => s.id === id);

    return await fn({ dir, work, macroPath, squash, later, pr, done, subtask, child });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The two runbooks, with the label each suite carries. */
export const VARIANTS = [['claude', '/orchestrator:done runbook'], ['codex', '$orchestrator:done skill (Codex mirror)']];
