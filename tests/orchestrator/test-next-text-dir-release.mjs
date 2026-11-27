// ADR-0059 Decision 10, items 1 and 3: /orchestrator:next releases its text
// directory only as the last step of Phase 5's exit trap (Phase 4's writeback
// on the Codex skill), and only when each of three results authorizes it: the
// writeback exited 0, the mark's withdrawal reported withdrawn, gone,
// unpublished or carried (read from its JSON reply), and the admission release
// exited 0. Any other exit keeps it, names each leftover with its id and exits
// non-zero, a writeback that landed included. Phase 3b never releases it, and
// publishes over a kept mark only after a withdrawal that showed who holds it.
//
// The standard test shape (AGENTS.md § Build / test / CI): the runbook's own
// blocks, each a run in one shell, over the real CLIs; the withdrawal's
// replies and a failed admission release come from a wrapper of the
// orchestrator's state.mjs that answers those two calls and hands every other
// call to the real one. The blocks' CLI calls and the path list are checked
// statically by tests/plugin-shape/test-runbook-cli-contracts.mjs; the happy
// path end to end is test-next-holds-e2e.mjs's.

import { describe, it, before } from 'node:test';
import { doesNotMatch, match, ok, strictEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileTmpDirs } from '../_tmp.mjs';
import {
  BLOCKS, ENGINEER_ROOT, ORCH_ROOT, ORCH_STATE, SHELLS, git, holds, nextHoldsFixture, withTextDir,
} from './_next-holds-fixture.mjs';

const makeDir = fileTmpDirs();
const shell = SHELLS[0];

// The engineer's bootstrap block as /engineer:compose ships it, run in the
// shell of Phase 4's prelude (the single-shell contract), its profile filled.
const COMPOSE = readFileSync(join(ENGINEER_ROOT, 'commands/compose.md'), 'utf8');
const BOOTSTRAP = (() => {
  const blocks = [...COMPOSE.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((m) => m[1]).filter((b) => b.includes('--original-request-file "$REQUEST_FILE"'));
  // Contract: the run executes the engineer's own bootstrap — a renamed line
  // must fail here, not run nothing.
  strictEqual(blocks.length, 1, 'one bootstrap block in /engineer:compose');
  return blocks[0].replace(/<profile from the arguments above[^>]*>/, 'plan');
})();

describe("/orchestrator:next's text directory (ADR-0059 Decision 10, items 1 and 3)", () => {
  const f = nextHoldsFixture(makeDir);
  let fakeRoot;
  before(() => {
    // A wrapper root: FAKE_WITHDRAW answers dispatch-mark-withdraw (fail, old:
    // exit 0 with no reply, malformed, or a disposition), FAKE_ADMISSION=fail
    // fails the admission release; every other call is the real CLI's. The
    // runbook looks for these words in it: 'tmpdir-make' 'tmpdir-release'.
    fakeRoot = join(f.dir, 'fake-orchestrator');
    mkdirSync(join(fakeRoot, 'scripts'), { recursive: true });
    writeFileSync(join(fakeRoot, 'scripts', 'state.mjs'), [
      "// 'tmpdir-make' 'tmpdir-release'",
      "import { spawnSync } from 'node:child_process';",
      'const [sub, action] = process.argv.slice(2);',
      'const w = process.env.FAKE_WITHDRAW;',
      "if (sub === 'dispatch-mark-withdraw' && w) {",
      "  if (w === 'fail') { process.stderr.write('withdraw: a lock failed\\n'); process.exit(1); }",
      "  if (w === 'old') process.exit(0);",
      "  if (w === 'malformed') { process.stdout.write('{not json\\n'); process.exit(0); }",
      '  process.stdout.write(JSON.stringify({ disposition: w, operation_id: null, subtask_id: "T1" }) + "\\n");',
      '  process.exit(0);',
      '}',
      "if (sub === 'admission' && action === 'release' && process.env.FAKE_ADMISSION === 'fail') { process.stderr.write('admission release: refused (test)\\n'); process.exit(1); }",
      `const r = spawnSync(process.execPath, [${JSON.stringify(ORCH_STATE)}, ...process.argv.slice(2)], { stdio: 'inherit' });`,
      'process.exit(r.status ?? 1);',
    ].join('\n'));
  });
  const env = (extra = {}) => ({ TMPDIR: f.dir, ...extra });
  const fake = (extra) => env({ AGENTIC_ORCHESTRATOR_ROOT: fakeRoot, ...extra });
  /** Phases 3b and 4 over a marked directory, and the engineer's real create: Phase 5 is next. */
  const dispatched = async (block = BLOCKS.JOIN_AND_SWITCH, prelude = BLOCKS.PRELUDE, sh = shell) => {
    const textDir = f.carried({ marked: true });
    const joined = f.run(sh, withTextDir(block, textDir), env());
    strictEqual(joined.status, 0, joined.stderr);
    const pre = f.run(sh, `${withTextDir(prelude, textDir)}\necho "OPID=\${AGENTIC_OPERATION_ID:-}"`, env());
    strictEqual(pre.status, 0, pre.stderr);
    strictEqual(f.bootstrap(pre.vars.OPID || null).status, 0);
    return textDir;
  };

  // The happy path in every shell the runbook may run in.
  for (const sh of SHELLS) {
    it(`Phase 5 (${sh}): the writeback, an authorizing withdrawal and the admission release: the last step releases the directory, stdout the envelope alone`, async () => {
      const textDir = await dispatched(BLOCKS.JOIN_AND_SWITCH, BLOCKS.PRELUDE, sh);
      const r = f.run(sh, withTextDir(BLOCKS.WRITEBACK, textDir), env());
      strictEqual(r.status, 0, r.stderr);
      // One JSON document: no withdrawal or release reply leaks to stdout.
      strictEqual(JSON.parse(r.stdout).updatedSubtask.status, 'in_progress');
      strictEqual(existsSync(textDir), false, 'released');
      strictEqual((await f.subtask()).status, 'in_progress');
      doesNotMatch(r.stderr, /agentic-dir release|✗/);
    });
  }

  describe(`Phase 5 (${shell})`, () => {

    it('a mark its engineer carries authorizes the release (the holds on)', async () => {
      f.activate();
      const textDir = await dispatched();
      match(f.mark(textDir).operation_id, holds.OPERATION_ID_RE);
      const r = f.run(shell, withTextDir(BLOCKS.WRITEBACK, textDir), env());
      strictEqual(r.status, 0, r.stderr);
      match(r.stderr, /is its engineer's operation now/);
      strictEqual(existsSync(textDir), false);
    });

    for (const [reply, why] of [['unknown', /\(unknown\)/], ['unreadable', /\(unreadable\)/], ['fail', /the withdrawal failed, or its reply was not read/], ['old', /the withdrawal failed, or its reply was not read/], ['malformed', /the withdrawal failed, or its reply was not read/]]) {
      it(`a writeback that landed beside a withdrawal that ${reply === 'old' ? 'replies nothing (an older CLI)' : `reports ${reply}`}: kept, exit 1, the withdrawal to retry named`, async () => {
        const textDir = await dispatched();
        const r = f.run(shell, withTextDir(BLOCKS.WRITEBACK, textDir), fake({ FAKE_WITHDRAW: reply }));
        strictEqual(r.status, 1, r.stderr);
        match(r.stdout, /"updatedSubtask":\{[^}]*"status":"in_progress"/, 'the writeback landed, and its envelope is printed');
        strictEqual((await f.subtask()).status, 'in_progress');
        match(r.stderr, why);
        match(r.stderr, /retry the withdrawal, with the subtask and branch subtask\.json keeps, until it reports withdrawn, gone, unpublished or carried: node "[^"]+\/scripts\/state\.mjs" dispatch-mark-withdraw --workflow-path "[^"]+" --subtask-id "T1" --branch "feat\/t1"/);
        match(r.stderr, /writer-clear is only for an operation whose session the owner has shown gone/);
        ok(existsSync(join(textDir, 'dispatch-mark.json')) && existsSync(join(textDir, 'admission')), 'kept, with what the cleanup reads');
      });
    }

    it('an admission release that fails after a landed writeback: kept, exit 1, the release named with the admission id', async () => {
      const textDir = await dispatched();
      const admission = readFileSync(join(textDir, 'admission'), 'utf8');
      ok(admission !== '', 'an admission was joined');
      const r = f.run(shell, withTextDir(BLOCKS.WRITEBACK, textDir), fake({ FAKE_ADMISSION: 'fail' }));
      strictEqual(r.status, 1, r.stderr);
      match(r.stdout, /"updatedSubtask":\{[^}]*"status":"in_progress"/);
      match(r.stderr, new RegExp(`The admission ${admission} of macro ${f.macroId} is still held.*admission release --macro ${f.macroId} --checkout "[^"]+" --admission ${admission}`));
      doesNotMatch(r.stderr, /dispatch mark kept/, 'the withdrawal authorized: only the admission is left');
      ok(existsSync(textDir));
      // The cleanup it names, run by hand: the admission goes.
      strictEqual(spawnSync(process.execPath, [ORCH_STATE, 'admission', 'release', '--macro', f.macroId, '--checkout', f.lane, '--admission', admission], { encoding: 'utf8' }).status, 0);
    });

    it('a refused writeback keeps the directory and its own status, the cleanup done', async () => {
      const textDir = await dispatched();
      // The plan changed after the selection: the writeback refuses.
      const sub = JSON.parse(readFileSync(join(textDir, 'subtask.json'), 'utf8'));
      writeFileSync(join(textDir, 'subtask.json'), JSON.stringify({ ...sub, topic: 'another topic' }));
      const r = f.run(shell, withTextDir(BLOCKS.WRITEBACK, textDir), env());
      ok(r.status !== 0, 'refused');
      ok(existsSync(textDir), 'kept');
      doesNotMatch(r.stderr, /still held|dispatch mark kept/, 'no leftover: the admission and the mark went');
    });

    it('both cleanups failing after a landed writeback: both leftovers named, the admission release still attempted', async () => {
      const textDir = await dispatched();
      const r = f.run(shell, `set -e\n${withTextDir(BLOCKS.WRITEBACK, textDir)}`, fake({ FAKE_WITHDRAW: 'fail', FAKE_ADMISSION: 'fail' }));
      strictEqual(r.status, 1, r.stderr);
      match(r.stderr, /admission release: refused \(test\)/, 'attempted under errexit');
      match(r.stderr, /is still held/);
      match(r.stderr, /dispatch mark kept/);
      ok(existsSync(textDir));
    });
  });

  describe(`Phase 3b (${shell})`, () => {
    it('never releases the directory, and publishes over a kept mark only after a withdrawal that showed who holds it', async () => {
      f.activate();
      // The switch fails (the branch is checked out elsewhere): the trap
      // withdraws the mark, keeps its file and the directory.
      git(f.main, 'worktree', 'add', '-q', join(f.dir, 'other'), 'feat/t1');
      const textDir = f.carried({ marked: true });
      const failed = f.run(shell, withTextDir(BLOCKS.JOIN_AND_SWITCH, textDir), env());
      ok(failed.status !== 0);
      ok(existsSync(textDir), 'Phase 3b keeps it');
      const mark = readFileSync(join(textDir, 'dispatch-mark.json'), 'utf8');
      git(f.main, 'worktree', 'remove', '--force', join(f.dir, 'other'));
      // Rerun, the withdrawal of the kept mark indeterminate: nothing published or switched.
      const stopped = f.run(shell, withTextDir(BLOCKS.JOIN_AND_SWITCH, textDir), fake({ FAKE_WITHDRAW: 'unknown' }));
      strictEqual(stopped.status, 1);
      match(stopped.stderr, /was not shown withdrawn; no new mark was published and nothing was switched/);
      match(stopped.stderr, /retry the withdrawal until it reports withdrawn, gone, unpublished or carried/);
      strictEqual(readFileSync(join(textDir, 'dispatch-mark.json'), 'utf8'), mark, 'the only record of the old id is kept');
      strictEqual(f.records().length, 0);
      strictEqual(f.branch(), 'feat/x');
      // Rerun with the real withdrawal (gone): it publishes and switches.
      const again = f.run(shell, withTextDir(BLOCKS.JOIN_AND_SWITCH, textDir), env());
      strictEqual(again.status, 0, again.stderr);
      strictEqual(f.branch(), 'feat/t1');
      ok(f.mark(textDir).operation_id !== JSON.parse(mark).operation_id, 'a new mark');
      ok(existsSync(textDir));
    });
  });

  describe(`Phase 3b's trap (${shell})`, () => {
    it('under errexit, an unresolved old mark and a failed admission release: both leftovers named, nothing released', async () => {
      f.activate();
      git(f.main, 'worktree', 'add', '-q', join(f.dir, 'other'), 'feat/t1');
      const textDir = f.carried({ marked: true });
      ok(f.run(shell, withTextDir(BLOCKS.JOIN_AND_SWITCH, textDir), env()).status !== 0, 'the switch failed, the mark file kept');
      git(f.main, 'worktree', 'remove', '--force', join(f.dir, 'other'));
      const r = f.run(shell, `set -e\n${withTextDir(BLOCKS.JOIN_AND_SWITCH, textDir)}`, fake({ FAKE_WITHDRAW: 'unknown', FAKE_ADMISSION: 'fail' }));
      strictEqual(r.status, 1);
      match(r.stderr, /is still held: its release failed/);
      match(r.stderr, /\(operation op-[^)]+\) was not shown withdrawn \(unknown\)/);
      ok(existsSync(textDir));
      // The admission the failed release left, released as its line says.
      const admission = readFileSync(join(textDir, 'admission'), 'utf8');
      strictEqual(spawnSync(process.execPath, [ORCH_STATE, 'admission', 'release', '--macro', f.macroId, '--checkout', f.lane, '--admission', admission], { encoding: 'utf8' }).status, 0);
    });
  });

  describe(`the Codex skill (${shell})`, () => {
    it('its writeback releases on the three results, and keeps on a withdrawal that shows no owner', async () => {
      let textDir = f.carried({ marked: true });
      strictEqual(f.run(shell, withTextDir(BLOCKS.CODEX_JOIN, textDir), env()).status, 0);
      strictEqual(f.run(shell, withTextDir(BLOCKS.CODEX_SWITCH, textDir), env()).status, 0);
      strictEqual(f.run(shell, withTextDir(BLOCKS.CODEX_PRELUDE, textDir), env()).status, 0);
      strictEqual(f.bootstrap(null).status, 0);
      let r = f.run(shell, withTextDir(BLOCKS.CODEX_WRITEBACK, textDir), env());
      strictEqual(r.status, 0, r.stderr);
      strictEqual(existsSync(textDir), false);
      // A re-attach of the same child, its withdrawal unreadable.
      git(f.lane, 'switch', '-q', 'feat/x');
      textDir = f.carried({ marked: true, subtask: await f.subtask(), engineerWorkflow: readActive() });
      strictEqual(f.run(shell, withTextDir(BLOCKS.CODEX_JOIN, textDir), env()).status, 0);
      strictEqual(f.run(shell, withTextDir(BLOCKS.CODEX_SWITCH, textDir), env()).status, 0);
      strictEqual(f.run(shell, withTextDir(BLOCKS.CODEX_PRELUDE, textDir), env()).status, 0);
      // The skill names its root in place: the wrapper's, here.
      r = f.run(shell, withTextDir(BLOCKS.CODEX_WRITEBACK.replaceAll(`${ORCH_ROOT}/scripts/state.mjs`, `${fakeRoot}/scripts/state.mjs`), textDir), fake({ FAKE_WITHDRAW: 'unreadable' }));
      strictEqual(r.status, 1, r.stderr);
      match(r.stderr, /\(unreadable\)/);
      ok(existsSync(textDir));
    });
  });

  // The engineer workflow on feat/t1, as the ownership check would see it.
  function readActive() {
    const r = spawnSync(process.execPath, [join(ENGINEER_ROOT, 'scripts/state.mjs'), 'find-active', '--repo-root', f.lane, '--branch', 'feat/t1'], { encoding: 'utf8' });
    strictEqual(r.status, 0, r.stderr);
    return r.stdout.trim();
  }

  describe(`one shell: the prelude, the engineer's real bootstrap, Phase 5 (${shell})`, () => {
    for (const topic of ['', 'the subtask topic']) {
      it(`${topic ? 'a topic' : 'no topic'}: the engineer's bootstrap leaves next's directory, and Phase 5 releases it`, async () => {
        // The macro's subtask with this topic, so the writeback's expectations hold.
        const { setPlan } = await import('../../plugins/orchestrator/scripts/state.mjs');
        await setPlan({ workflowPath: f.macroPath, host: 'claude', subtasks: [f.T1({ topic }), { id: 'T2', verb: 'compose', branch: 'feat/t2', blocked_by: [], status: 'pending' }] });
        const textDir = f.carried({ marked: true, subtask: f.T1({ topic }) });
        strictEqual(f.run(shell, withTextDir(BLOCKS.JOIN_AND_SWITCH, textDir), env()).status, 0);
        // The engineer's own step-1 directory, for a request when there is no topic.
        const own = spawnSync(process.execPath, [join(ENGINEER_ROOT, 'scripts/state.mjs'), 'tmpdir-make', '--kind', 'text'], { encoding: 'utf8', env: { ...process.env, TMPDIR: f.dir } }).stdout.trim();
        ok(own !== '');
        writeFileSync(join(own, 'request.txt'), 'a request\n');
        const script = [
          withTextDir(BLOCKS.PRELUDE, textDir),
          BOOTSTRAP.replace("TEXT_DIR='<directory from step 1>'", `TEXT_DIR='${own}'`),
          `[ -d '${textDir}' ] && echo NEXT_KEPT=yes`,
          withTextDir(BLOCKS.WRITEBACK, textDir),
        ].join('\n');
        const r = f.run(shell, script, env({ AGENTIC_ENGINEER_ROOT: ENGINEER_ROOT }));
        strictEqual(r.status, 0, r.stderr);
        strictEqual(r.vars.NEXT_KEPT, 'yes', "the engineer's bootstrap left next's directory");
        strictEqual(existsSync(textDir), false, 'Phase 5 released it');
        strictEqual(existsSync(own), topic !== '', topic ? 'a topic: the engineer read none of its own directory, and kept it' : "no topic: the engineer released its own request's directory");
        strictEqual((await f.subtask()).status, 'in_progress');
      });
    }
  });
});
