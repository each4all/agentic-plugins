// tests/orchestrator/test-runbook-workflow-resolver.mjs
//
// ADR-0067 Decision 4, item 2 — the --workflow=<id> resolvers of
// /orchestrator:next, :approve, :done, :finalize and :abort find the macro in
// the orchestrator workflow homes of the checkout's read set: from a linked
// worktree, a macro stored in the main checkout. The test runs each runbook's
// own Phase 0 block, cut where its resolver ends, with the real orchestrator
// script, in bash and in zsh.

import { describe, it, before, after } from 'node:test';
import { deepStrictEqual, strictEqual, ok, match } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { withArgs } from './_command-args-file.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ORCH_ROOT = resolve(REPO_ROOT, 'plugins/orchestrator');
const HOME = '.agentic-plugins/state/orchestrator';
const SHELLS = ['bash', 'zsh'].filter((s) => spawnSync(s, ['-c', 'exit 0']).status === 0);
const RUNBOOKS = ['next', 'approve', 'done', 'finalize', 'abort'];
const OPEN = 'if [ -n "$ARG_WORKFLOW_ID" ]; then';
// The id reaches each block in the args file the agent writes (C134(a)); done
// takes a subtask id too. next names its args directory in step 3.
const ARGS_LINE = { next: "ARGS_DIR='<directory from step 3>'" };
const typed = (name, id) => (name === 'done' ? `T1 --workflow=${id}` : `--workflow=${id}`);

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

/** The resolver block of `name`, its args file holding --workflow=<id>, and next's text directory a new one. */
function resolverRun(name, id) {
  let block = withArgs(resolverBlock(name), typed(name, id), { line: ARGS_LINE[name] });
  if (name === 'next') block = block.replace("TEXT_DIR='<directory from step 1>'", () => `TEXT_DIR='${mkdtempSync(join(tmpdir(), 'agentic-text.'))}'`);
  return block;
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
    env: baseEnv({ AGENTIC_ORCHESTRATOR_ROOT: ORCH_ROOT, ...env }),
  });

  for (const name of RUNBOOKS) {
    for (const shell of SHELLS) {
      it(`${name}.md (${shell}): from a linked worktree, --workflow finds the macro stored in the main checkout`, () => {
        const r = runIn(shell, lane, resolverRun(name, macroId), {});
        strictEqual(r.status, 0, r.stderr);
        match(r.stdout, new RegExp(`^MACRO_PATH=${macroPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
        // An id no root holds is refused, naming the read set.
        const missing = runIn(shell, lane, resolverRun(name, 'macro-plan-20261008T000000Z-000000'), {});
        strictEqual(missing.status, 1);
        match(missing.stderr, /names no single macro file in the orchestrator workflow homes of this checkout's read set/);
      });
    }
  }

  // resume.md Phase 3: archive <workflow-id> resolves the id through the same
  // resolver before it archives anything.
  for (const shell of SHELLS) {
    it(`resume.md (${shell}): archive <workflow-id> from a linked worktree resolves the macro stored in the main checkout`, () => {
      // C134(a): the id reaches resolve-workflow as the file the agent wrote.
      const block = (id) => {
        const textDir = mkdtempSync(join(tmpdir(), 'agentic text.'));
        writeFileSync(join(textDir, 'workflow-id.txt'), `${id}\n`);
        return runbookBlock('resume', '--workflow-id-file "$TEXT_DIR/workflow-id.txt"').replace("TEXT_DIR='<directory from step 1>'", () => `TEXT_DIR='${textDir}'`);
      };
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
      const r = runIn(SHELLS[0], lane, resolverRun('next', macroId), {});
      strictEqual(r.status, 1);
      ok(r.stderr.includes(macroPath) && r.stderr.includes(copy), r.stderr);
    } finally {
      rmSync(copy);
    }
  });
});

/** The bash block of the Codex skill `name` holding `needle`, its plugin root filled in as the agent fills it. */
function codexBlock(name, needle) {
  const text = readFileSync(join(ORCH_ROOT, 'core/skills', name, 'SKILL.md'), 'utf8');
  const blocks = [...text.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1]).filter((b) => b.includes(needle));
  // Contract: the runs below execute this block — a renamed line must fail
  // here, not run nothing.
  strictEqual(blocks.length, 1, `${name}/SKILL.md: one block holds ${needle}`);
  return blocks[0].replaceAll('<orchestrator-plugin-root>', ORCH_ROOT).replaceAll('<plugin-root>', ORCH_ROOT);
}

// C134(a) on Codex: the Phase 0 block of $orchestrator:approve, :abort and
// :finalize parses the args file with command-args and resolves the macro it
// names, and $orchestrator:resume's archive block reads the id from
// workflow-id.txt; nothing the user typed runs. Each skill's own block, with
// the real orchestrator script, in bash and in zsh.
describe('the Codex skills take their arguments from a file (C134(a))', () => {
  const CODEX_PHASE0 = ['approve', 'abort', 'finalize'];
  const CODEX_ARGS_LINE = "ARGS_DIR='<directory from mktemp>'";
  let dir;
  let main;
  let lane;
  let detached;
  let macroPath;
  let macroId;
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'codex-resolver-')));
    main = join(dir, 'repo');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    writeFileSync(join(main, 'README.md'), 'x\n');
    git(main, 'add', 'README.md');
    git(main, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'feat/x', join(dir, 'lane'));
    git(main, 'worktree', 'add', '-q', '--detach', join(dir, 'detached'));
    main = realpathSync(main);
    lane = realpathSync(join(dir, 'lane'));
    detached = realpathSync(join(dir, 'detached'));
    macroPath = execFileSync(process.execPath, [join(ORCH_ROOT, 'scripts/state.mjs'),
      'create', '--repo-root', main, '--verb', 'plan', '--host', 'codex', '--git-baseline-branch', 'main',
      '--git-baseline-head', git(main, 'rev-parse', 'HEAD'), '--original-request', 'codex resolver fixture',
    ], { encoding: 'utf8', env: baseEnv() }).trim();
    macroId = basename(macroPath, '.md');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const runIn = (shell, cwd, block) => spawnSync(shell, ['-c', block], { cwd, encoding: 'utf8', env: baseEnv() });
  const printed = (r) => /^MACRO_PATH=(.*)$/m.exec(r.stdout)?.[1];
  const pwned = (cwd) => readdirSync(cwd).filter((n) => n.startsWith('pwned'));
  const HOSTILE = `--workflow=x'; touch pwned-tick-\`touch pwned-sub\`; echo "$(touch pwned-cmd)"`;

  for (const name of CODEX_PHASE0) {
    for (const shell of SHELLS) {
      it(`${name}/SKILL.md Phase 0 (${shell}): the args file's --workflow finds the macro from a linked worktree, no argument finds it on its branch, and a refused argument runs nothing`, () => {
        const block = codexBlock(name, 'command-args');
        ok(block.startsWith(`${CODEX_ARGS_LINE}\n`), `${name}: the block opens with its ARGS_DIR line`);
        const phase0 = (cwd, text) => runIn(shell, cwd, withArgs(block, text, { line: CODEX_ARGS_LINE }));
        const byId = phase0(lane, `--workflow=${macroId}`);
        strictEqual(byId.status, 0, byId.stderr);
        strictEqual(printed(byId), macroPath);
        match(byId.stdout, new RegExp(`^MACRO_ID=${macroId}$`, 'm'));
        // No argument: the active macro of the branch it was planned on.
        const active = phase0(main, '');
        strictEqual(active.status, 0, active.stderr);
        strictEqual(printed(active), macroPath);
        // An id no root holds, an unknown option, a path-shaped id and a word
        // holding shell syntax are refused, and resolve nothing.
        for (const [text, why] of [
          ['--workflow=macro-plan-20261008T000000Z-000000', /macro-plan-20261008T000000Z-000000/],
          ['--bogus', /--bogus/],
          ['--workflow=..', /not a basename-shaped workflow id/],
          [HOSTILE, /quote|backslash/],
        ]) {
          const r = phase0(lane, text);
          strictEqual(r.status, 1, `${text}: ${r.stdout}`);
          strictEqual(printed(r), undefined, `${text}: no macro`);
          match(r.stderr, why, text);
        }
        deepStrictEqual(pwned(lane), [], 'nothing in the arguments ran');
        // On a detached HEAD abort and finalize refuse before the parse, as
        // their commands do; approve resolves a named macro there.
        const onDetached = phase0(detached, `--workflow=${macroId}`);
        if (name === 'approve') {
          strictEqual(onDetached.status, 0, onDetached.stderr);
          strictEqual(printed(onDetached), macroPath);
        } else {
          strictEqual(onDetached.status, 1, onDetached.stdout);
          match(onDetached.stderr, /Detached HEAD/);
        }
      });
    }
  }

  for (const shell of SHELLS) {
    it(`resume/SKILL.md archive (${shell}): the id in workflow-id.txt resolves the macro from a linked worktree; an id no root holds, or one holding shell syntax, is refused and runs nothing`, () => {
      const block = codexBlock('resume', '--workflow-id-file "$TEXT_DIR/workflow-id.txt"');
      const TEXT_DIR_LINE = "TEXT_DIR='<directory from mktemp>'";
      ok(block.startsWith(`${TEXT_DIR_LINE}\n`) && !block.includes('<workflow-id>'), 'the id travels in a file');
      const resolveWith = (id) => {
        const textDir = mkdtempSync(join(dir, 'agentic text.'));
        writeFileSync(join(textDir, 'workflow-id.txt'), `${id}\n`);
        return runIn(shell, lane, block.replace(TEXT_DIR_LINE, () => `TEXT_DIR='${textDir}'`));
      };
      const r = resolveWith(macroId);
      strictEqual(r.status, 0, r.stderr);
      strictEqual(r.stdout.trim(), macroPath);
      for (const id of ['macro-plan-20261008T000000Z-000000', `macro-x'; touch pwned-tick-\`touch pwned-sub\`; echo "$(touch pwned-cmd)"`]) {
        const refused = resolveWith(id);
        strictEqual(refused.status === 0, false, `${id}: ${refused.stdout}`);
        strictEqual(refused.stdout.trim(), '', `${id}: no macro`);
      }
      deepStrictEqual(pwned(lane), [], 'nothing in the id ran');
    });
  }
});

/**
 * One phase of done.md's block (Phases 0-3 run as one block, docket C75): the
 * block's plugin-root lines, then its lines from the `# --- <phase>` marker up
 * to the next phase's.
 */
function doneSection(phase, next) {
  const text = readFileSync(join(ORCH_ROOT, 'commands/done.md'), 'utf8');
  const blocks = [...text.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
  strictEqual(blocks.length, 1, 'done.md: one block runs Phases 0-3');
  const lines = blocks[0].split('\n');
  const from = lines.findIndex((l) => l.startsWith(`# --- ${phase}`));
  const to = lines.findIndex((l) => l.startsWith(`# --- ${next}`));
  // Contract: the runs below execute this phase — a renamed marker must fail
  // here, not run nothing.
  ok(from > 0 && to > from, `done.md marks ${phase} and ${next}`);
  // The plugin-root lines, which follow the block's ARGS_DIR line.
  const root = lines.findIndex((l) => l.startsWith('CLAUDE_PLUGIN_ROOT='));
  ok(root > 0, 'done.md sets its plugin root');
  return [...lines.slice(root, root + 2), ...lines.slice(from, to)].join('\n');
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
      const block = `${fieldReader()}\n${doneSection('Phase 2:', 'Phase 3a:')}\nprintf "OWNER=%s\\n" "$EXISTING_ENG_WF_ID"\n`;
      const r = spawnSync(shell, ['-c', block], { cwd: lane, encoding: 'utf8', env: env({ EXISTING_ENG_WF_ID: '' }) });
      strictEqual(r.status, 0, r.stderr);
      match(r.stdout, new RegExp(`^OWNER=${childId}$`, 'm'));
    });

    it(`(${shell}) --no-commit refuses while the active child sits in a third worktree's own home`, () => {
      const r = spawnSync(shell, ['-c', doneSection('Phase 3a:', 'Phase 3b:')], { cwd: lane, encoding: 'utf8', env: env({ NO_COMMIT: 'true' }) });
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
