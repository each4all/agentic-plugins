// ADR-0067 Decision 4, item 5 (SR, U7c, U7d): /orchestrator:finalize and
// :abort (Phases 0-3, one shell), the Codex mirrors (each phase a shell call
// of its own) and /orchestrator:resume's archive block (run after the agent
// confirmed) join the macro lock before their first write and release it on
// every exit.
//
// The branches and refusals, each once, in bash (the standard test shape).
// The happy paths, end to end in every shell the runbooks may run in, are in
// test-admission-runbooks-e2e.mjs (the large tier).

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileTmpDirs } from '../_tmp.mjs';
import { SH, closeFixture, phases, resumeArchiveBlock, skillBlocks, withTyped } from './_admission-runbooks-fixture.mjs';

const makeDir = fileTmpDirs();
const shell = SH;

describe('/orchestrator:finalize, :abort and :resume archive join the macro lock before their first write (ADR-0067 Decision 4, item 5)', () => {
  const f = closeFixture(makeDir);

  for (const [name, status, phase] of [['finalize', 'deferred', 'finalized'], ['abort', 'abandoned', 'aborted']]) {
    it(`${name}.md (${shell}): a session holding the macro lock refuses before the first write; free, it closes the macro and releases`, async () => {
      const script = phases(name, '## Phase 4');
      const other = f.holdAsSession();
      const refused = f.runIn(shell, withTyped(script, `--workflow=${f.macroId}`));
      strictEqual(refused.status, 1, refused.stdout);
      match(refused.stderr, new RegExp(`an interactive session holds .*/orchestrator:done, .*host codex, .*admission ${other}`));
      strictEqual((await f.macro()).frontmatter.plan.subtasks[0].status, 'pending', 'nothing written');
      deepStrictEqual(f.sessionEntries(), [`s-${other}.json`]);
      f.release(other, f.main);
      const closed = f.runIn(shell, withTyped(script, `--workflow=${f.macroId}`));
      strictEqual(closed.status, 0, closed.stderr);
      const after = (await f.macro()).frontmatter;
      deepStrictEqual([after.plan.subtasks[0].status, after.current_phase, after.terminal_marker], [status, phase, true]);
      deepStrictEqual(f.sessionEntries(), [], 'released after the last write');
    });

    it(`${name}.md: a step that fails after the first write releases the admission`, { skip: f.asRoot && 'root reads any file' }, async () => {
      const home = join(f.lane, '.agentic-plugins/state/engineer/workflows');
      mkdirSync(home, { recursive: true });
      const unreadable = join(home, 'compose-20261008T000000Z-0bad00.md');
      writeFileSync(unreadable, '---\nworkflow_id: "x"\n---\n');
      execFileSync('chmod', ['000', unreadable]);
      const r = f.runIn(shell, withTyped(phases(name, '## Phase 4'), `--workflow=${f.macroId}`));
      strictEqual(r.status, 1, r.stdout);
      match(r.stderr, /Step 2 did not archive every engineer child/);
      strictEqual((await f.macro()).frontmatter.plan.subtasks[0].status, status, 'Phase 1 wrote');
      deepStrictEqual(f.sessionEntries(), [], 'released on that exit');
    });

    // U7d — the U7c review's item 1: the Codex mirror runs its phases in
    // separate shell calls, so Phases 2 and 3 check the carried admission.
    it(`${name} (Codex mirror): an admission released after Phase 1 stops Phases 2 and 3 before their writes`, async () => {
      const blocks = skillBlocks(name);
      const [phase1] = blocks.filter((b) => b.includes('admission join'));
      const phase2 = blocks.filter((b) => b.includes('admission check') && !b.includes('set-terminal'));
      const [phase3] = blocks.filter((b) => b.includes('set-terminal'));
      strictEqual(phase2.length, 1, 'one Phase 2 check block');
      const vars = { MACRO_ID: f.macroId, MACRO_PATH: f.macroPath, REPO_ROOT: f.lane };
      const joined = f.runIn(shell, `${phase1}\necho "ADMISSION=$ADMISSION"`, vars);
      strictEqual(joined.status, 0, joined.stderr);
      const id = joined.stdout.match(/^ADMISSION=([0-9a-f]{32})$/m)?.[1];
      ok(id, joined.stdout);
      // Control: held, the Phase 2 check passes and keeps the admission.
      strictEqual(f.runIn(shell, phase2[0], { ...vars, ADMISSION: id }).status, 0);
      deepStrictEqual(f.sessionEntries(), [`s-${id}.json`], 'still held');
      f.release(id);
      const p2 = f.runIn(shell, phase2[0], { ...vars, ADMISSION: id });
      strictEqual(p2.status, 1, p2.stdout);
      match(p2.stderr, /is gone from/);
      const p3 = f.runIn(shell, phase3, { ...vars, ADMISSION: id });
      strictEqual(p3.status, 1, p3.stdout);
      match(p3.stderr, /is gone from/);
      const fm = (await f.macro()).frontmatter;
      deepStrictEqual([fm.terminal_marker ?? null, fm.plan.subtasks[0].status], [null, status], 'Phase 1 wrote; set-terminal did not run');
      // Control: a held admission, Phase 3 sets the macro terminal and releases.
      const held = f.join(name);
      const closed = f.runIn(shell, phase3, { ...vars, ADMISSION: held });
      strictEqual(closed.status, 0, closed.stderr);
      deepStrictEqual([(await f.macro()).frontmatter.terminal_marker, f.sessionEntries()], [true, []], 'terminal, and released');
    });

    it(`${name} (Codex mirror): a Phase 2 check that fails on a permission error releases the admission`, { skip: f.asRoot && 'root reads any file' }, async () => {
      const [phase2] = skillBlocks(name).filter((b) => b.includes('admission check') && !b.includes('set-terminal'));
      const id = f.join(name);
      const entry = join(f.macroLock, `s-${id}.json`);
      execFileSync('chmod', ['000', entry]);
      try {
        const r = f.runIn(shell, phase2, { MACRO_ID: f.macroId, MACRO_PATH: f.macroPath, REPO_ROOT: f.lane, ADMISSION: id });
        strictEqual(r.status, 1, r.stdout);
      } finally {
        if (existsSync(entry)) execFileSync('chmod', ['600', entry]);
      }
      deepStrictEqual(f.sessionEntries(), [], 'released: no entry left to block the next session');
    });
  }

  it(`resume.md (${shell}): the archive refuses while a session holds the macro lock; free, it archives and releases`, async () => {
    const block = resumeArchiveBlock();
    const other = f.holdAsSession();
    const refused = f.runIn(shell, block, { WORKFLOW: f.macroPath, REPO_ROOT: f.lane });
    strictEqual(refused.status, 1, refused.stdout);
    match(refused.stderr, /an interactive session holds/);
    ok(existsSync(f.macroPath), 'nothing archived');
    f.release(other, f.main);
    const archived = f.runIn(shell, block, { WORKFLOW: f.macroPath, REPO_ROOT: f.lane });
    strictEqual(archived.status, 0, archived.stderr);
    ok(!existsSync(f.macroPath), 'archived');
    deepStrictEqual(f.sessionEntries(), [], 'released after the archive');
  });
});
