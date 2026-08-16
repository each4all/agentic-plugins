// Host-tool dependency contract — a command runbook must not instruct the
// agent to call a host tool the session may not carry.
//
// Origin (measured 2026-08-16, baseline refresh to Claude Code `2.1.233`):
// 2.1.233 withdrew the todo/task-tracking tools (`TaskCreate`/`TaskGet`/
// `TaskUpdate`/`TaskList`, `TodoWrite`) from Opus 4.8, Sonnet 5, Fable 5,
// Mythos 5, and newer models behind an opt-in `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`.
// Twenty Claude command runbooks still opened with "Use `TaskCreate` and
// `TaskUpdate` to track progress" — observed directly while running
// `/orchestrator:next`, whose own runbook issued the instruction into a session
// with no such tool. The dependency was not Claude-only in reach:
// `plugins/orchestrator/skills/next/SKILL.md` names the Claude command markdown
// as Codex's behavioral source, so it could reach a Codex session too.
//
// Pins, and what each is actually worth:
//   1. IDENTITY, not count — the twenty runbooks are named, the list length is
//      pinned, and the entries are required to be distinct, so a rename or a
//      duplicated entry cannot keep the list satisfied. The marker is required
//      in the runbook PREAMBLE (after `$ARGUMENTS`, before the first section
//      heading) rather than anywhere in the file: a whole-file search is
//      satisfiable by a fenced example or an HTML comment after the operational
//      instruction is gone.
//   2. Absence sweep across command and skill surfaces, over markdown AND the
//      `agents/*.yaml` prompt files, plus any root-level `SKILL.md` the Claude
//      shortcut allows. It fails closed on unexpected directory errors — only a
//      genuinely absent directory is tolerated.
//   3. Doc lockstep, scoped to the row that states the rule and asserting the
//      PROHIBITION rather than the mere presence of the opt-in token. The
//      earlier form checked only that `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` appeared
//      somewhere in the row, which a row *recommending* the opt-in would satisfy
//      just as well — an assertion weaker than its own failure message.
//
// Known limit, stated rather than papered over: pin 2 matches identifiers. It
// is deliberately strict — a runbook may not name these tools even to warn
// against them, because that caution belongs in the baseline — and it cannot
// catch a synonym ("use the todo tracker"). It is a guard against the exact
// regression observed, not a proof that no host-tool dependency exists.

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const BASELINE = join(REPO_ROOT, 'plugins/runtime/docs/host-parity-baseline.md');

const WITHDRAWN_TOOLS = ['TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'TodoWrite'];

// The host-neutral replacement, whitespace-normalized before matching so a
// re-wrap of the surrounding prose cannot break the pin.
const NEUTRAL_MARKER = 'use the host’s task-tracking tools when the session exposes them';
const NEUTRAL_MARKER_ASCII = "use the host's task-tracking tools when the session exposes them";

const REWRITTEN_RUNBOOKS = [
  'plugins/designer/commands/compose.md',
  'plugins/designer/commands/critique.md',
  'plugins/designer/commands/decide.md',
  'plugins/designer/commands/frame.md',
  'plugins/designer/commands/investigate.md',
  'plugins/designer/commands/refine.md',
  'plugins/engineer/commands/compose.md',
  'plugins/engineer/commands/critique.md',
  'plugins/engineer/commands/decide.md',
  'plugins/engineer/commands/frame.md',
  'plugins/engineer/commands/investigate.md',
  'plugins/engineer/commands/refine.md',
  'plugins/founder/commands/compose.md',
  'plugins/founder/commands/critique.md',
  'plugins/founder/commands/decide.md',
  'plugins/founder/commands/frame.md',
  'plugins/founder/commands/investigate.md',
  'plugins/founder/commands/refine.md',
  'plugins/orchestrator/commands/next.md',
  'plugins/orchestrator/commands/plan.md',
];

const PROMPT_EXTENSIONS = ['.md', '.yaml', '.yml'];
const squash = (text) => text.replace(/\s+/g, ' ');

// The operational preamble: everything after the `$ARGUMENTS` placeholder up to
// the first section heading or horizontal rule. This is where a command states
// how the agent should work, and the only place the marker counts.
function preamble(text) {
  const start = text.indexOf('$ARGUMENTS');
  if (start === -1) return null;
  const rest = text.slice(start + '$ARGUMENTS'.length);
  const end = rest.search(/^(?:## |---\s*$)/m);
  return end === -1 ? rest : rest.slice(0, end);
}

async function collectPromptFiles(dir, acc) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    // Fail closed on anything but a genuinely absent directory: a permission
    // or I/O error that silently yields zero files turns this sweep into a
    // vacuous pass, which is the failure mode it exists to prevent.
    if (error?.code === 'ENOENT') return acc;
    throw error;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await collectPromptFiles(full, acc);
    else if (PROMPT_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) acc.push(full);
  }
  return acc;
}

describe('host-tool dependency contract', () => {
  it('pins the rewritten runbooks by identity and requires the host-neutral phrasing in their preamble', async () => {
    strictEqual(REWRITTEN_RUNBOOKS.length, 20, 'the twenty rewritten runbooks are all listed');
    strictEqual(
      new Set(REWRITTEN_RUNBOOKS).size,
      REWRITTEN_RUNBOOKS.length,
      'the list holds twenty distinct paths — a duplicate would weaken the identity pin to a count',
    );
    for (const rel of REWRITTEN_RUNBOOKS) {
      const text = await readFile(join(REPO_ROOT, rel), 'utf8');
      const head = preamble(text);
      ok(head, `${rel} has an $ARGUMENTS preamble`);
      const squashed = squash(head);
      ok(
        squashed.includes(NEUTRAL_MARKER) || squashed.includes(NEUTRAL_MARKER_ASCII),
        `${rel} states the host-neutral progress-tracking phrasing in its preamble, not merely somewhere in the file`,
      );
    }
  });

  it('instructs no withdrawn host tool from any plugin command, skill, or agent prompt', async () => {
    const plugins = (await readdir(join(REPO_ROOT, 'plugins'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    ok(plugins.length > 0, 'the sweep found plugin directories');
    const files = [];
    for (const plugin of plugins) {
      const root = join(REPO_ROOT, 'plugins', plugin);
      await collectPromptFiles(join(root, 'commands'), files);
      await collectPromptFiles(join(root, 'skills'), files);
      // Claude accepts a plugin with a root-level SKILL.md and no skills/
      // directory (recorded in the baseline's Plugin contents row).
      try {
        const rootSkill = join(root, 'SKILL.md');
        await readFile(rootSkill, 'utf8');
        files.push(rootSkill);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    ok(files.length > 0, 'the sweep found command/skill prompt files to check');
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      for (const tool of WITHDRAWN_TOOLS) {
        ok(
          !text.includes(tool),
          `${relative(REPO_ROOT, file)} must not name \`${tool}\` — Claude Code 2.1.233 withdrew it `
          + 'from current models, and the Claude command markdown is also Codex’s behavioral source. '
          + 'Phrase progress tracking as intent with the host tool as an optional means; if the tool needs '
          + 'discussing, discuss it in the host parity baseline rather than in a runbook.',
        );
      }
    }
  });

  it('keeps the prohibition stated in the Parity Matrix row that owns it', async () => {
    const baseline = await readFile(BASELINE, 'utf8');
    const row = baseline.split('\n').find((line) => line.startsWith('| Skills and commands |'));
    ok(row, 'host-parity-baseline.md has a Skills and commands parity row');
    const squashedRow = squash(row);
    ok(
      squashedRow.includes('must not hard-depend on a host tool a model may not carry'),
      'the Skills and commands row states the no-hard-dependency rule',
    );
    // Assert the PROHIBITION, not the token. A row recommending the opt-in
    // would contain `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` just as happily.
    ok(
      squashedRow.includes('Do not re-introduce the dependency by recommending `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`'),
      'the Skills and commands row forbids re-introducing the dependency via the opt-in, rather than merely mentioning it',
    );
  });
});
