// The text directory /orchestrator:next's blocks share (commands/next.md and
// its Codex mirror, core/skills/next/SKILL.md; docket C75). Each block may run
// in a fresh shell, so none relies on a variable an earlier block set: what a
// phase finds it writes to the directory mktemp printed, and every later block
// reads it there. A test that runs one block writes what the earlier phases
// would have written, then names the directory in the block's TEXT_DIR line,
// as the agent does.

import { ok } from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { parseCommandArguments } = await import(
  resolve(fileURLToPath(import.meta.url), '../../../plugins/orchestrator/scripts/lib/command-args.mjs'));

export const CLAUDE_TEXT_DIR_LINE = "TEXT_DIR='<directory from step 1>'";
export const CODEX_TEXT_DIR_LINE = "TEXT_DIR='<directory from mktemp>'";

/**
 * A new text directory holding what Phases 0 to 3b write: the checkout, the
 * macro file and the parsed arguments (Phase 0; `args` is the argument text
 * as typed, parsed by next's grammar as Phase 0 parses it, ADR-0059, C134(a)), the selected subtask as read-subtask or
 * next-ready printed it (Phase 1), the engineer root and the workflow the
 * ownership check saw (Phase 2), the admission (Phase 3b). A key left out is
 * not written, as when its phase has not run.
 */
export function carriedTextDir({ repoRoot, macroPath, args = '', subtask, engineerRoot, engineerWorkflow, admission } = {}, parent = tmpdir()) {
  const dir = mkdtempSync(join(parent, 'agentic-text.'));
  const put = (name, value) => {
    if (value !== undefined) writeFileSync(join(dir, name), value);
  };
  put('repo-root', repoRoot);
  put('macro-path', macroPath);
  // Phase 0 writes the arguments with the macro file.
  put('arguments.json', macroPath === undefined ? undefined : JSON.stringify(parseCommandArguments('next', args)));
  put('subtask.json', subtask === undefined ? undefined : JSON.stringify(subtask));
  put('engineer-root', engineerRoot);
  put('engineer-workflow', engineerWorkflow);
  put('admission', admission);
  return dir;
}

/** `block` with its TEXT_DIR line naming `dir`, as the agent fills it in. */
export function withTextDir(block, dir) {
  const line = [CLAUDE_TEXT_DIR_LINE, CODEX_TEXT_DIR_LINE].find((l) => block.startsWith(`${l}\n`));
  // Contract: every block reads the text directory its first line names — a
  // block that does not open with it would read another directory, or none.
  ok(line, `the block opens with its TEXT_DIR line:\n${block.slice(0, 200)}`);
  return block.replace(line, () => `TEXT_DIR='${dir.replace(/'/g, "'\\''")}'`);
}
