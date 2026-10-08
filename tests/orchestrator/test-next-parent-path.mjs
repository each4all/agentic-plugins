// tests/orchestrator/test-next-parent-path.mjs
//
// ADR-0067 Decision 3 (B′), end to end: /orchestrator:next's Phase 4 prelude
// exports AGENTIC_PARENT_WORKFLOW_PATH beside the two linkage ids, and the
// engineer verb bootstrap passes it to `state.mjs create`, which records it.
// The test runs the exact blocks — next.md's prelude, then the generated
// bootstrap of a profiled verb (compose) and of a plain one (frame) — with the
// real orchestrator and engineer scripts, in bash and in zsh (the Bash tool's
// shell on the owner's machine).
//
// The other version pairings: an orchestrator that exports no path (the
// child is linked by id alone), and a path with no ids (refused before any
// write).

import { describe, it } from 'node:test';
import { strictEqual, ok, match } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ORCH_ROOT = resolve(REPO_ROOT, 'plugins/orchestrator');
const ENGINEER_ROOT = resolve(REPO_ROOT, 'plugins/engineer');
const ENGINEER_WORKFLOWS = '.agentic-plugins/state/engineer/workflows';
const SHELLS = ['bash', 'zsh'].filter((s) => spawnSync(s, ['-c', 'exit 0']).status === 0);

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t.local',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t.local',
  GIT_CONFIG_NOSYSTEM: '1',
};
// The operator's agentic session stays out (C88); the blocks get only what
// the runbook gives them.
const baseEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && k !== 'CLAUDE_PLUGIN_ROOT')),
  ...GIT_ENV,
});

/** The fenced bash block of `text` that contains `needle`. */
function blockWith(text, needle) {
  const blocks = [...text.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
  const found = blocks.filter((b) => b.includes(needle));
  // Contract: the runs below execute this block — a renamed export must fail
  // here, not run nothing.
  strictEqual(found.length, 1, `one bash block holds ${needle}`);
  return found[0];
}

/** The bash block of a generated region of an engineer command. */
function regionBlock(verb, id) {
  const text = readFileSync(join(ENGINEER_ROOT, 'commands', `${verb}.md`), 'utf8');
  const from = text.indexOf(`<!-- pipeline:begin ${id} -->`);
  const to = text.indexOf(`<!-- pipeline:end ${id} -->`);
  ok(from >= 0 && to > from, `${verb}.md carries the ${id} region`);
  return blockWith(text.slice(from, to), 'state.mjs" create');
}

const PRELUDE = blockWith(readFileSync(join(ORCH_ROOT, 'commands/next.md'), 'utf8'), 'export AGENTIC_PARENT_WORKFLOW="$MACRO_ID"');
// The Codex mirror's own prelude ($orchestrator:next), maintained apart.
const CODEX_PRELUDE = blockWith(readFileSync(join(ORCH_ROOT, 'core/skills/next/SKILL.md'), 'utf8'), 'export AGENTIC_PARENT_WORKFLOW="$MACRO_ID"');

function withDispatch(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'next-parent-path-'));
  try {
    // The macro's checkout and the subtask's checkout are two directories, as
    // a lane and the main worktree are.
    const main = join(dir, 'main');
    const work = join(dir, 'work');
    mkdirSync(main);
    execFileSync('git', ['init', '-q', '-b', 'feat/t1', work], { env: baseEnv() });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'base'], { cwd: work, env: baseEnv() });
    const orch = (args) => execFileSync(process.execPath, [join(ORCH_ROOT, 'scripts/state.mjs'), ...args], { encoding: 'utf8', env: baseEnv() }).trim();
    const macroPath = orch([
      'create', '--repo-root', main, '--verb', 'plan', '--host', 'claude', '--git-baseline-branch', 'main',
      '--git-baseline-head', 'a'.repeat(40), '--original-request', 'next parent path fixture',
    ]);
    const macroId = macroPath.split('/').pop().replace(/\.md$/, '');
    return fn({ dir, main, work, macroPath, macroId });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(shell, script, work) {
  const r = spawnSync(shell, ['-c', script], {
    cwd: work, encoding: 'utf8',
    env: { ...baseEnv(), HOME: work, AGENTIC_ORCHESTRATOR_ROOT: ORCH_ROOT },
  });
  const dir = join(work, ENGINEER_WORKFLOWS);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
  return { ...r, files, text: files.length === 1 ? readFileSync(join(dir, files[0]), 'utf8') : null };
}

const dispatchVars = ({ macroId, macroPath, work }) => [
  `MACRO_ID='${macroId}'`,
  `MACRO_PATH='${macroPath}'`,
  "SUBTASK_ID='T1'",
  `ENGINEER_PLUGIN_ROOT='${ENGINEER_ROOT}'`,
  "DETECTED_HOST='claude'",
  "SUBTASK_PROFILE='backend'",
  "SUBTASK_TOPIC='parent path dispatch'",
  `REPO_ROOT='${work}'`,
].join('\n');

describe('/orchestrator:next hands the macro path to the engineer bootstrap (ADR-0067 Decision 3)', () => {
  for (const shell of SHELLS) {
    for (const [verb, region] of [['compose', 'compose-bootstrap'], ['frame', 'frame-bootstrap']]) {
      // Contract: next.md's Phase 4 exports and the bootstrap's PARENT_ARGS —
      // a dispatched child that does not record the path cannot reach a macro
      // kept in another checkout.
      it(`${shell}, ${verb}: the dispatched child records parent_workflow_path beside the two ids`, () => {
        withDispatch((ctx) => {
          const r = run(shell, `${dispatchVars(ctx)}\n${PRELUDE}\n${regionBlock(verb, region)}`, ctx.work);
          strictEqual(r.status, 0, r.stderr);
          strictEqual(r.files.length, 1, r.stderr);
          match(r.text, new RegExp(`^parent_workflow_path: ${JSON.stringify(ctx.macroPath).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm'));
          match(r.text, new RegExp(`^parent_workflow: "${ctx.macroId}"$`, 'm'));
          match(r.text, /^originating_subtask: "T1"$/m);
        });
      });
    }

    // Contract: the Codex mirror's prelude is the one $orchestrator:next runs;
    // it is kept apart from next.md, so it can lose the export on its own.
    it(`${shell}, Codex prelude: the dispatched child records parent_workflow_path`, () => {
      withDispatch((ctx) => {
        const r = run(shell, `${dispatchVars(ctx)}\n${CODEX_PRELUDE}\n${regionBlock('compose', 'compose-bootstrap')}`, ctx.work);
        strictEqual(r.status, 0, r.stderr);
        match(r.text, new RegExp(`^parent_workflow_path: ${JSON.stringify(ctx.macroPath).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm'));
        match(r.text, /^host_history:\n {2}- host: "codex"$/m);
      });
    });

    // Contract: an orchestrator from before ADR-0067 exports the ids only;
    // its dispatched children must keep being created and linked.
    it(`${shell}: an orchestrator that exports no path still dispatches a child linked by id`, () => {
      withDispatch((ctx) => {
        const r = run(shell, `${dispatchVars(ctx)}\n${PRELUDE}\nunset AGENTIC_PARENT_WORKFLOW_PATH\n${regionBlock('compose', 'compose-bootstrap')}`, ctx.work);
        strictEqual(r.status, 0, r.stderr);
        ok(!/^parent_workflow_path:/m.test(r.text), r.text);
        match(r.text, new RegExp(`^parent_workflow: "${ctx.macroId}"$`, 'm'));
      });
    });

    // Contract: the bootstrap's own check — a path without the ids is a
    // leftover or a dispatcher bug, never a parent link; it stops before create.
    for (const [verb, region] of [['compose', 'compose-bootstrap'], ['frame', 'frame-bootstrap']]) {
      it(`${shell}, ${verb}: the path without the two ids stops the bootstrap before any write`, () => {
        withDispatch((ctx) => {
          const r = run(shell, `REPO_ROOT='${ctx.work}'\nexport CLAUDE_PLUGIN_ROOT='${ENGINEER_ROOT}'\nexport AGENTIC_PARENT_WORKFLOW_PATH='${ctx.macroPath}'\n${regionBlock(verb, region)}`, ctx.work);
          strictEqual(r.status, 1, r.stdout);
          match(r.stderr, /AGENTIC_PARENT_WORKFLOW_PATH is set without AGENTIC_PARENT_WORKFLOW and AGENTIC_ORIGINATING_SUBTASK/);
          strictEqual(r.files.length, 0);
        });
      });
    }
  }
});
