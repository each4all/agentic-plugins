// tests/orchestrator/test-runbook-workflow-resolver.mjs
//
// ADR-0067 Decision 4, item 2 — the --workflow=<id> resolvers of
// /orchestrator:next, :approve, :done, :finalize and :abort find the macro in
// the orchestrator workflow homes of the checkout's read set: from a linked
// worktree, a macro stored in the main checkout. The test runs each runbook's
// own Phase 0 block, cut where its resolver ends, with the real orchestrator
// script, in bash and in zsh.

import { describe, it, before, after } from 'node:test';
import { strictEqual, ok, match } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ORCH_ROOT = resolve(REPO_ROOT, 'plugins/orchestrator');
const HOME = '.agentic-plugins/state/orchestrator';
const SHELLS = ['bash', 'zsh'].filter((s) => spawnSync(s, ['-c', 'exit 0']).status === 0);
const RUNBOOKS = ['next', 'approve', 'done', 'finalize', 'abort'];
const OPEN = 'if [ -n "${EXPLICIT_WORKFLOW_ID:-}" ]; then';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t.local',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t.local',
  GIT_CONFIG_NOSYSTEM: '1',
};
const baseEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_') && k !== 'CLAUDE_PLUGIN_ROOT')),
  ...GIT_ENV,
  ...extra,
});
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: baseEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * The runbook's bash block that resolves --workflow=<id>, cut after the `fi`
 * that closes its resolution, plus a line printing the result. A runbook
 * whose block no longer has this shape fails here rather than run nothing.
 */
function resolverBlock(name) {
  const text = readFileSync(join(ORCH_ROOT, 'commands', `${name}.md`), 'utf8');
  const blocks = [...text.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1]).filter((b) => b.includes(OPEN));
  strictEqual(blocks.length, 1, `${name}.md: one block resolves --workflow`);
  const lines = blocks[0].split('\n');
  const open = lines.indexOf(OPEN);
  const close = lines.findIndex((l, i) => i > open && l === 'fi');
  ok(open >= 0 && close > open, `${name}.md: the resolution closes at column 0`);
  return [...lines.slice(0, close + 1), 'printf "MACRO_PATH=%s\\n" "$MACRO_PATH"', ''].join('\n');
}

describe('runbook --workflow=<id> resolvers search the read set (ADR-0067 Decision 4, item 2)', () => {
  let dir;
  let main;
  let lane;
  let macroPath;
  let macroId;
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'runbook-resolver-')));
    main = join(dir, 'repo');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    writeFileSync(join(main, 'README.md'), 'x\n');
    git(main, 'add', 'README.md');
    git(main, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'feat/x', join(dir, 'lane'));
    main = realpathSync(main);
    lane = realpathSync(join(dir, 'lane'));
    macroPath = execFileSync(process.execPath, [join(ORCH_ROOT, 'scripts/state.mjs'),
      'create', '--repo-root', main, '--verb', 'plan', '--host', 'claude', '--git-baseline-branch', 'main',
      '--git-baseline-head', git(main, 'rev-parse', 'HEAD'), '--original-request', 'runbook resolver fixture',
    ], { encoding: 'utf8', env: baseEnv() }).trim();
    macroId = basename(macroPath, '.md');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const runIn = (shell, cwd, block, env) => spawnSync(shell, ['-c', block], {
    cwd, encoding: 'utf8',
    env: baseEnv({ AGENTIC_ORCHESTRATOR_ROOT: ORCH_ROOT, EXPLICIT_SUBTASK_ID: 'T1', ...env }),
  });

  for (const name of RUNBOOKS) {
    for (const shell of SHELLS) {
      it(`${name}.md (${shell}): from a linked worktree, --workflow finds the macro stored in the main checkout`, () => {
        const block = resolverBlock(name);
        const r = runIn(shell, lane, block, { EXPLICIT_WORKFLOW_ID: macroId });
        strictEqual(r.status, 0, r.stderr);
        match(r.stdout, new RegExp(`^MACRO_PATH=${macroPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
        // An id no root holds is refused, naming the read set.
        const missing = runIn(shell, lane, block, { EXPLICIT_WORKFLOW_ID: 'macro-plan-20261008T000000Z-000000' });
        strictEqual(missing.status, 1);
        match(missing.stderr, /names no single macro file in the orchestrator workflow homes of this checkout's read set/);
      });
    }
  }

  // resume.md Phase 3: archive <workflow-id> resolves the id through the same
  // resolver before it archives anything.
  for (const shell of SHELLS) {
    it(`resume.md (${shell}): archive <workflow-id> from a linked worktree resolves the macro stored in the main checkout`, () => {
      const block = (id) => runbookBlock('resume', "ARCHIVE_WORKFLOW_ID='<workflow-id>'").replace("'<workflow-id>'", `'${id}'`);
      const r = runIn(shell, lane, block(macroId), {});
      strictEqual(r.status, 0, r.stderr);
      match(r.stdout, new RegExp(`^WORKFLOW=${macroPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
      const missing = runIn(shell, lane, block('macro-plan-20261008T000000Z-000000'), {});
      strictEqual(missing.status, 1);
      match(missing.stderr, /names no single macro file in the orchestrator workflow homes of this checkout's read set/);
    });
  }

  it('two files holding one macro id are refused, naming both', () => {
    const copy = join(lane, HOME, 'workflows', basename(macroPath));
    mkdirSync(join(lane, HOME, 'workflows'), { recursive: true });
    writeFileSync(copy, readFileSync(macroPath, 'utf8'));
    try {
      const r = runIn(SHELLS[0], lane, resolverBlock('next'), { EXPLICIT_WORKFLOW_ID: macroId });
      strictEqual(r.status, 1);
      ok(r.stderr.includes(macroPath) && r.stderr.includes(copy), r.stderr);
    } finally {
      rmSync(copy);
    }
  });
});

/** The bash block of done.md that holds `needle`. */
function doneBlock(needle) {
  const text = readFileSync(join(ORCH_ROOT, 'commands/done.md'), 'utf8');
  const blocks = [...text.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1]).filter((b) => b.includes(needle));
  strictEqual(blocks.length, 1, `done.md: one block holds ${needle}`);
  return blocks[0];
}

// ADR-0067 Decision 1(b) — done.md's engineer scans (the owner of a subtask,
// and --no-commit's active child) read every worktree's own homes (state.mjs
// owner-dispatch and active-child, over the repository-wide scan set): a child
// an older persona left in a third worktree is found from a lane.
describe("done.md's engineer scans read every worktree (ADR-0067 Decision 1(b))", () => {
  let dir;
  let main;
  let lane;
  let third;
  const macroId = 'macro-plan-20261008T000000Z-d0d0d0';
  const childId = 'compose-20261008T000000Z-c41d00';
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'done-scan-')));
    main = join(dir, 'repo');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    writeFileSync(join(main, 'README.md'), 'x\n');
    git(main, 'add', 'README.md');
    git(main, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'feat/x', join(dir, 'lane'));
    git(main, 'worktree', 'add', '-q', '-b', 'feat/t1', join(dir, 'third'));
    main = realpathSync(main);
    lane = realpathSync(join(dir, 'lane'));
    third = realpathSync(join(dir, 'third'));
    const home = join(third, '.agentic-plugins/state/engineer/workflows');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, `${childId}.md`),
      `---\nworkflow_id: "${childId}"\nparent_workflow: "${macroId}"\noriginating_subtask: "T1"\ngit_baseline:\n  branch: "feat/t1"\n---\n`);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));
  const env = (extra) => baseEnv({
    AGENTIC_ORCHESTRATOR_ROOT: ORCH_ROOT, MACRO_ID: macroId, SUBTASK_ID: 'T1', REPO_ROOT: lane,
    // owner-dispatch puts the macro path only into the binding lines it prints.
    MACRO_PATH: join(main, '.agentic-plugins/state/orchestrator/workflows', `${macroId}.md`), DETECTED_HOST: 'claude', ...extra,
  });
  // Phase 2 reads owner-dispatch's answer with Phase 1's field reader.
  const fieldReader = () => readFileSync(join(ORCH_ROOT, 'commands/done.md'), 'utf8').split('\n').find((l) => l.startsWith('JSON_FIELD='));

  for (const shell of SHELLS) {
    it(`(${shell}) the owner scan finds a child held only in a third worktree's own home`, () => {
      const block = `${fieldReader()}\n${doneBlock('owner-dispatch "${OWNER_ARGS[@]}"')}\nprintf "OWNER=%s\\n" "$EXISTING_ENG_WF_ID"\n`;
      const r = spawnSync(shell, ['-c', block], { cwd: lane, encoding: 'utf8', env: env({ EXISTING_ENG_WF_ID: '' }) });
      strictEqual(r.status, 0, r.stderr);
      match(r.stdout, new RegExp(`^OWNER=${childId}$`, 'm'));
    });

    it(`(${shell}) --no-commit refuses while the active child sits in a third worktree's own home`, () => {
      const r = spawnSync(shell, ['-c', doneBlock('ACTIVE_CHILD="$(')], { cwd: lane, encoding: 'utf8', env: env({ NO_COMMIT: '1' }) });
      strictEqual(r.status, 1);
      match(r.stderr, /is still active/);
      ok(r.stderr.includes(third), r.stderr);
    });
  }
});

/** The bash block of `<name>.md` that holds `needle`. */
function runbookBlock(name, needle) {
  const text = readFileSync(join(ORCH_ROOT, 'commands', `${name}.md`), 'utf8');
  const blocks = [...text.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1]).filter((b) => b.includes(needle));
  strictEqual(blocks.length, 1, `${name}.md: one block holds ${needle}`);
  return blocks[0];
}

// ADR-0067 Decision 1(b) — the child detach pass of /orchestrator:finalize and
// :abort reads every worktree's own homes through `state.mjs scan-roots`: a
// child held only in a third worktree is archived from a lane, a worktree
// list git cannot give refuses the step, and a file that cannot be read
// counts as a failure rather than "no child".
describe("finalize.md's and abort.md's child detach pass reads every worktree (ADR-0067 Decision 1(b))", () => {
  let dir;
  let main;
  let lane;
  let third;
  let macroId;
  let nodeOnly;
  const ENG_ROOT = resolve(REPO_ROOT, 'plugins/engineer');
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const engHome = (root, d = 'workflows') => join(root, '.agentic-plugins/state/engineer', d);
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'detach-scan-')));
    main = join(dir, 'repo');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    writeFileSync(join(main, 'README.md'), 'x\n');
    git(main, 'add', 'README.md');
    git(main, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'feat/x', join(dir, 'lane'));
    git(main, 'worktree', 'add', '-q', '-b', 'feat/t1', join(dir, 'third'));
    main = realpathSync(main);
    lane = realpathSync(join(dir, 'lane'));
    third = realpathSync(join(dir, 'third'));
    const macroPath = execFileSync(process.execPath, [join(ORCH_ROOT, 'scripts/state.mjs'),
      'create', '--repo-root', main, '--verb', 'plan', '--host', 'claude', '--git-baseline-branch', 'main',
      '--git-baseline-head', git(main, 'rev-parse', 'HEAD'), '--original-request', 'detach scan fixture',
    ], { encoding: 'utf8', env: baseEnv() }).trim();
    macroId = basename(macroPath, '.md');
    nodeOnly = join(dir, 'node-only-bin');
    mkdirSync(nodeOnly);
    symlinkSync(process.execPath, join(nodeOnly, 'node'));
  });
  after(() => {
    try { execFileSync('chmod', ['-R', 'u+rwX', dir]); } catch { /* best effort */ }
    rmSync(dir, { recursive: true, force: true });
  });
  const reset = () => {
    for (const root of [main, lane, third]) rmSync(join(root, '.agentic-plugins/state/engineer'), { recursive: true, force: true });
  };
  // A mid-flight child of the macro, created by engineer in the third
  // worktree's own home (shared creation is off).
  const makeChild = () => execFileSync(process.execPath, [join(ENG_ROOT, 'scripts/state.mjs'),
    'create', '--repo-root', third, '--verb', 'compose', '--host', 'claude', '--git-baseline-branch', 'feat/t1',
    '--git-baseline-head', git(third, 'rev-parse', 'HEAD'),
    '--status-digest', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    '--original-request', 'detach scan child', '--parent-workflow', macroId, '--originating-subtask', 'T1',
  ], { encoding: 'utf8', env: baseEnv() }).trim();
  const env = (extra = {}) => baseEnv({
    AGENTIC_ENGINEER_ROOT: ENG_ROOT, ORCH_PLUGIN_ROOT: ORCH_ROOT, MACRO_PATH: 'set by Phase 0', MACRO_ID: macroId,
    REPO_ROOT: lane, DETECTED_HOST: 'claude', ...extra,
  });

  for (const name of ['finalize', 'abort']) {
    for (const shell of SHELLS) {
      it(`${name}.md (${shell}): run from a lane, the detach pass archives a child held only in a third worktree's own home`, () => {
        reset();
        const child = makeChild();
        ok(child.startsWith(engHome(third)), child);
        const r = spawnSync(shell, ['-c', runbookBlock(name, 'STEP2_RC=0')], { cwd: lane, encoding: 'utf8', env: env() });
        strictEqual(r.status, 0, r.stderr);
        match(r.stdout, /mid-flight child detached/);
        ok(!existsSync(child), 'the child left the workflows home');
        ok(readdirSync(engHome(third, 'archive')).some((n) => n.startsWith(basename(child, '.md'))), "archived in its own home's archive");
      });
    }

    it(`${name}.md: a worktree list git cannot give refuses the step`, () => {
      reset();
      const child = makeChild();
      // The shell by its path: PATH holds node alone, so git is missing.
      const r = spawnSync(execFileSync('sh', ['-c', `command -v ${SHELLS[0]}`], { encoding: 'utf8' }).trim(), ['-c', runbookBlock(name, 'STEP2_RC=0')], { cwd: lane, encoding: 'utf8', env: env({ PATH: nodeOnly }) });
      strictEqual(r.status, 1, r.stdout);
      match(r.stderr, /Could not list the repository's worktrees to scan for children/);
      ok(existsSync(child), 'the child is untouched');
    });

    it(`${name}.md: a file that cannot be read counts as a failure, not as "no child"`, { skip: asRoot && 'root reads any file' }, () => {
      reset();
      mkdirSync(engHome(third), { recursive: true });
      const unreadable = join(engHome(third), 'compose-20261008T000000Z-0bad00.md');
      writeFileSync(unreadable, `---\nworkflow_id: "compose-20261008T000000Z-0bad00"\nparent_workflow: "${macroId}"\n---\n`);
      execFileSync('chmod', ['000', unreadable]);
      try {
        const r = spawnSync(SHELLS[0], ['-c', runbookBlock(name, 'STEP2_RC=0')], { cwd: lane, encoding: 'utf8', env: env() });
        strictEqual(r.status, 1, r.stdout);
        match(r.stderr, /cannot read .*compose-20261008T000000Z-0bad00\.md/);
      } finally {
        execFileSync('chmod', ['644', unreadable]);
      }
    });
  }
});
