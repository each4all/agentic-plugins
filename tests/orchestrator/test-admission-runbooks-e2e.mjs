// ADR-0067 Decision 4, item 5 (SR, U7c): the admission runbooks' happy paths,
// end to end through their own blocks, in every shell each may run in, with
// the real orchestrator and engineer scripts.
//
// - /orchestrator:next (commands/next.md) and the Codex mirror: every block
//   from Phase 0 (the Codex Phase 1) to the writeback, each in a fresh shell
//   that shares nothing with the others but the text directory (dockets C75,
//   C68, critique H6), in bash, zsh and a POSIX sh, with both topics of the
//   fixture (two-byte characters across a pipe's chunk boundary at both
//   parities).
// - /orchestrator:finalize and :abort (Phases 0-3, one shell), and their Codex
//   mirrors (each phase a shell call of its own), close the macro,
//   and /orchestrator:resume's archive block archives it, each releasing the
//   macro lock, in bash and zsh.
//
// The one end-to-end run per runbook path, in the large tier
// (scripts/data/test-tiers.json). The branches and refusals are in
// test-admission-runbooks.mjs and test-admission-close-runbooks.mjs, each
// once, in bash. A shell that is not installed (zsh on the CI image) is
// reported as skipped, not passed.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileTmpDirs } from '../_tmp.mjs';
import {
  CODEX_TEXT_BLOCKS, NEXT_BLOCKS, TOPICS, closeFixture, dispatchEndToEnd, nextFixture, phases, resumeArchiveBlock, skillBlocks, withTyped,
} from './_admission-runbooks-fixture.mjs';

const makeDir = fileTmpDirs();
const installed = (s) => spawnSync(s, ['-c', 'exit 0']).status === 0;
const skipped = (s) => !installed(s) && `${s} is not installed`;

describe('/orchestrator:next dispatches end to end, each block in a fresh shell (ADR-0067 Decision 4, item 5)', () => {
  const f = nextFixture(makeDir);

  for (const shell of ['bash', 'zsh', 'sh']) {
    it(`${shell}: every block of next.md, each in a fresh shell given only the text directory, dispatches the subtask Phase 1 selected and records it`, { skip: skipped(shell) }, async () => {
      // Contract: the blocks the agent runs, in order — Phase 0, Phase 1's
      // selection, validation, approval gate and hold gate, Phase 2, Phase 3,
      // Phase 3b, Phase 4's prelude, Phase 5. A block that no longer opens
      // with its TEXT_DIR line drops out of this list and fails here.
      strictEqual(NEXT_BLOCKS.length, 10, 'ten blocks read the text directory');
      const [phase0, selection, validation, gate, holdGate, phase2, phase3, joinSwitch, preludeBlock, writebackBlock] = NEXT_BLOCKS;
      ok(holdGate.includes('state.mjs" hold-gate'), 'the fifth block is the hold gate');
      for (const topic of TOPICS) {
        await dispatchEndToEnd(f, shell, topic, { before: [phase0, selection, validation, gate, holdGate, phase2, phase3, joinSwitch], prelude: preludeBlock, writeback: writebackBlock });
      }
    });

    // Critique H6 — the Codex mirror, end to end the same way: Phase 1's
    // selection, the approval gate, Phase 2's ownership check, the join and
    // the switch, Phase 3's prelude, Phase 4's writeback.
    it(`${shell}: every block of the Codex next skill, each in a fresh shell given only the text directory, dispatches the subtask Phase 1 selected and records it`, { skip: skipped(shell) }, async () => {
      // Contract: the nine blocks of the skill, in order; the standalone
      // release (the sixth) runs only when stopping before Phase 4.
      strictEqual(CODEX_TEXT_BLOCKS.length, 9, 'nine blocks read the text directory');
      const [phase1, gate, holdGate, ownership, join_, release, switchBlock, preludeBlock, writebackBlock] = CODEX_TEXT_BLOCKS;
      ok(holdGate.includes('state.mjs" hold-gate'), 'the third block is the hold gate');
      ok(release.includes('admission release') && !release.includes('trap'), 'the sixth block is the standalone release');
      for (const topic of TOPICS) {
        await dispatchEndToEnd(f, shell, topic, { before: [phase1, gate, holdGate, ownership, join_, switchBlock], prelude: preludeBlock, writeback: writebackBlock });
      }
    });
  }
});

describe('/orchestrator:finalize, :abort and :resume archive close the macro end to end (ADR-0067 Decision 4, item 5)', () => {
  const f = closeFixture(makeDir);

  for (const shell of ['bash', 'zsh']) {
    for (const [name, status, phase] of [['finalize', 'deferred', 'finalized'], ['abort', 'abandoned', 'aborted']]) {
      it(`${name}.md (${shell}), end to end: closes the macro and releases the macro lock`, { skip: skipped(shell) }, async () => {
        const closed = f.runIn(shell, withTyped(phases(name, '## Phase 4'), `--workflow=${f.macroId}`));
        strictEqual(closed.status, 0, closed.stderr);
        const after = (await f.macro()).frontmatter;
        deepStrictEqual([after.plan.subtasks[0].status, after.current_phase, after.terminal_marker], [status, phase, true]);
        deepStrictEqual(f.sessionEntries(), [], 'released after the last write');
      });
    }

    // The Codex mirrors run each phase in a shell call of its own, the
    // admission carried from Phase 1's join to Phase 3's release.
    for (const [name, status] of [['finalize', 'deferred'], ['abort', 'abandoned']]) {
      it(`${name} (Codex mirror, ${shell}), end to end: Phases 1-3, each a shell call, close the macro and release the macro lock`, { skip: skipped(shell) }, async () => {
        const blocks = skillBlocks(name);
        const [phase1] = blocks.filter((b) => b.includes('admission join'));
        const [phase2] = blocks.filter((b) => b.includes('admission check') && !b.includes('set-terminal'));
        const [phase3] = blocks.filter((b) => b.includes('set-terminal'));
        const vars = { MACRO_ID: f.macroId, MACRO_PATH: f.macroPath, REPO_ROOT: f.lane };
        const joined = f.runIn(shell, `${phase1}\necho "ADMISSION=$ADMISSION"`, vars);
        strictEqual(joined.status, 0, joined.stderr);
        const id = joined.stdout.match(/^ADMISSION=([0-9a-f]{32})$/m)?.[1];
        ok(id, joined.stdout);
        for (const block of [phase2, phase3]) {
          const r = f.runIn(shell, block, { ...vars, ADMISSION: id });
          strictEqual(r.status, 0, r.stderr);
        }
        const fm = (await f.macro()).frontmatter;
        deepStrictEqual([fm.plan.subtasks[0].status, fm.terminal_marker], [status, true]);
        deepStrictEqual(f.sessionEntries(), [], 'released after the last write');
      });
    }

    it(`resume.md (${shell}), end to end: the archive block archives the macro and releases the macro lock`, { skip: skipped(shell) }, () => {
      const archived = f.runIn(shell, resumeArchiveBlock(), { WORKFLOW: f.macroPath, REPO_ROOT: f.lane });
      strictEqual(archived.status, 0, archived.stderr);
      ok(!existsSync(f.macroPath), 'archived');
      deepStrictEqual(f.sessionEntries(), [], 'released after the archive');
    });
  }
});
