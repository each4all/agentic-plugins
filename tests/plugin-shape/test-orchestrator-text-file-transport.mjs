// ADR-0059, amendment of 2026-10-10 (item (j)) — the orchestrator's runbooks
// pass text an agent writes, or copies from a peer or the user, as files.
//
// WHY THIS EXISTS. /orchestrator:plan's Phase 2 assigned the Plan-verify note
// as NOTE="…", and the note's breakdown carries the peer's sentences: a
// backtick or $(…) in them ran as a command, under bash and zsh (docket
// C130). The decision, the architecture, the summary, the request, resume's
// drift note, checkpoint's summary and peer-now's prompt were spliced the same
// way. The runbooks now have the agent write each value with its file tool
// into a `mktemp -d` text directory, and the block passes the file to a
// `--<name>-file` option the CLI reads itself. tests/orchestrator/
// test-approve-runbook.mjs and test-plan-consensus.mjs run plan's blocks with
// hostile files (in a directory whose path holds a space); this file keeps
// the form from coming back anywhere in the package.
//
// WHAT IS CHECKED, over every orchestrator command, Codex skill, shared
// reference and agents/openai.yaml:
//
//   1. in a shell block, read as the shell splits it (quotes, `$(…)` and
//      backquotes across lines, escaped quotes, backslash-newlines): no
//      placeholder the agent fills, in any form — a flag, a variable, a printf
//      or echo into a file or a message — except one that is not text (an
//      enum, the plugin root, the directory mktemp printed on the line that
//      names it) or sits in a program's own source (`node -e`); no free-text
//      flag takes an expansion (`--summary "$SUMMARY"`); no NOTE / SUMMARY /
//      … is assigned or added to; no heredoc; no `$PROMPT_ARG`. A flag that
//      takes a fixed literal is not the class;
//   2. a state.mjs text file is passed as "$TEXT_DIR/<name>", quoted, from a
//      block that opens with its TEXT_DIR line, in a runbook that creates the
//      directory with `mktemp -d` and has the agent write the file with its
//      file tool;
//   3. in prose and YAML, no free-text flag is shown taking a placeholder, and
//      no `$PROMPT_ARG`;
//   4. the exceptions are pinned by identity: each is still where it was,
//      once, and holds only values a program read or printed (peer-now's
//      note, approve's hash) or a command's grammar in a message to stderr
//      (`Use --workflow=<id>.`), or predates this change and is named as such;
//   5. the guard is not vacuous: the conversions are found by identity, and a
//      violation planted in each corpus class is reported, with its line.

import { test } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fencedBlocks } from '../_runbook-checks.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ORCH = join(REPO_ROOT, 'plugins/orchestrator');
const rel = (p) => relative(REPO_ROOT, p).split('\\').join('/');
const read = (f) => readFileSync(join(REPO_ROOT, f), 'utf8');

function walk(dir, keep, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, keep, acc);
    else if (keep(entry)) acc.push(rel(p));
  }
  return acc;
}
const COMMANDS = walk(join(ORCH, 'commands'), (e) => e.endsWith('.md'));
const SKILL_DOCS = walk(join(ORCH, 'core/skills'), (e) => e.endsWith('.md'));
const YAML = walk(join(ORCH, 'core/skills'), (e) => e.endsWith('.yaml') || e.endsWith('.yml'));

// The free-text flags of the CLIs runbooks call, and the variables a block
// would hold such text in: the lists the expansion and assignment checks read.
// A placeholder needs no list; it is found whatever flag or variable carries
// it. `--reason` and `--text` keep their own file readers (`--reason-file`,
// `--text-file`); `--prompt-text` is the user's grammar for peer-now, which a
// block never passes.
const TEXT_FLAGS = ['phase-note', 'summary', 'next-action', 'original-request', 'resolution', 'decision', 'architecture', 'subject', 'subject-pkg', 'prompt-text', 'text', 'reason'];
const TEXT_VARS = ['NOTE', 'SUMMARY', 'RESOLUTION', 'OWNER_RESOLUTION', 'APPROVED_SUBJECT', 'DECISION', 'ARCHITECTURE', 'REQUEST', 'PROMPT_TEXT'];
// The state.mjs options that read text from a file (ADR-0059 amendment (j)).
const STATE_TEXT_FILE_FLAGS = ['original-request', 'next-action', 'phase-note', 'summary', 'decision', 'architecture'];
const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh']);
const MKTEMP_STEP = 'mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"';
const TEXT_DIR_LINES = ["TEXT_DIR='<directory from step 1>'", "TEXT_DIR='<directory from mktemp>'"];

const ASSIGNMENT = new RegExp(`^(?:${TEXT_VARS.join('|')})\\+?=`);
// A heredoc or herestring, its delimiter quoted, escaped (<<\EOF) or bare.
const HEREDOC = /<<<|<<-?\s*\\?["']?[A-Za-z_]/g;
const PROSE_PLACEHOLDER = new RegExp(`--(${TEXT_FLAGS.filter((f) => f !== 'prompt-text').join('|')})(?:=|\\s+)(?:"<|'<|<)`);
// A placeholder the agent fills: `<…>` around words, on one line, wherever it
// sits in a word (`prefix<summary>`) and whatever it holds (`<the user's …>`).
// Not shell syntax: `<<`, `<(`, `<&`, `< file`, `<"$file"`. A program's own
// source, the script `node -e` runs, is not searched (`i<a.length;…`).
const PLACEHOLDER = /(?<!<)<(?![<(&\s=/0-9"'$-])[^<>\n]*[A-Za-z…][^<>\n]*>/g;
const SCRIPT_FLAGS = ['-e', '--eval', '-p', '--print'];
// Placeholders that are not text, so a block may hold them: an enum
// (`<claude|codex>`), the plugin root, and the directory mktemp printed on the
// line that names it (the text directory, or the args directory of ADR-0059).
const ENUM_PLACEHOLDER = /^<[\w-]+(?:\|[\w-]+)+>$/;
const ROOT_PLACEHOLDERS = ['<plugin-root>', '<orchestrator-plugin-root>'];
const DIRECTORY_LINE = /^(?:TEXT_DIR|ARGS_DIR)='<directory from (?:step 1|mktemp)>'$/;

// The words of a shell block's source as the shell splits them (Critique
// finding M2: a value read line by line, or up to the next quote character,
// hid what followed). A single-quoted span is literal; a double-quoted one runs
// to its unescaped close, and `$(…)` and backquotes to theirs, each across
// lines; a backslash-newline outside them is removed, so it splits no word
// (Refine-verify finding: `"prefix"\<newline>"$(…)"` is one word); a `#`
// that starts a word comments out the rest of its line. Returns each word's
// offset, its text as written (`raw`) and without its backslash-newlines
// (`text`), and the comments' ranges.
function shellWords(src) {
  const words = [];
  const comments = [];
  let i = 0;
  let start = -1;
  const close = () => {
    if (start >= 0) { const raw = src.slice(start, i); words.push({ at: start, raw, text: raw.replace(/\\\n/g, '') }); }
    start = -1;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (/\s/.test(c) || c === ';' || c === '|' || c === '&') { close(); i += 1; continue; }
    if (c === '#' && start < 0) {
      const end = src.indexOf('\n', i);
      comments.push([i, end < 0 ? src.length : end]);
      i = end < 0 ? src.length : end;
      continue;
    }
    if (start < 0) start = i;
    i = pastConstruct(src, i);
  }
  close();
  return { words, comments };
}
// The offset past the quoted span, substitution or escape that starts at i
// (past the character itself when none does).
function pastConstruct(src, i) {
  if (src[i] === '\\') return i + 2;
  if (src[i] === "'") { const end = src.indexOf("'", i + 1); return end < 0 ? src.length : end + 1; }
  if (src[i] === '"') return pastDouble(src, i + 1);
  if (src[i] === '`') return pastBackquote(src, i + 1);
  if (src[i] === '$' && src[i + 1] === '(') return pastSubstitution(src, i + 2);
  return i + 1;
}
function pastDouble(src, j) {
  while (j < src.length) {
    if (src[j] === '"') return j + 1;
    j = src[j] === "'" ? j + 1 : pastConstruct(src, j);
  }
  return j;
}
function pastBackquote(src, j) {
  while (j < src.length) {
    if (src[j] === '\\') j += 2;
    else if (src[j] === '`') return j + 1;
    else j += 1;
  }
  return j;
}
function pastSubstitution(src, j) {
  let depth = 1;
  while (j < src.length) {
    if (src[j] === '(') { depth += 1; j += 1; } else if (src[j] === ')') {
      depth -= 1;
      j += 1;
      if (depth === 0) return j;
    } else j = pastConstruct(src, j);
  }
  return j;
}
// Whether the shell expands anything in a word: a `$` or a backquote outside
// single quotes.
function expands(raw) {
  let dq = false;
  for (let j = 0; j < raw.length; j += 1) {
    const c = raw[j];
    if (c === '\\') j += 1;
    else if (c === '$' || c === '`') return true;
    else if (c === '"') dq = !dq;
    else if (c === "'" && !dq) { const end = raw.indexOf("'", j + 1); j = end < 0 ? raw.length : end; }
  }
  return false;
}

/**
 * The problems of one document: `{ at, text, why }`, `at` its label and line.
 * `kind` is 'markdown' or 'yaml'.
 */
function textTransportProblems(text, label, kind = 'markdown') {
  const problems = [];
  const add = (n, line, why) => problems.push({ at: `${label}:${n}`, text: line.trim(), why });
  if (kind === 'yaml') {
    text.split(/\r?\n/).forEach((line, i) => {
      if (PROSE_PLACEHOLDER.test(line)) add(i + 1, line, 'a text flag shown taking a placeholder');
      if (line.includes('$PROMPT_ARG')) add(i + 1, line, '$PROMPT_ARG');
    });
    return problems;
  }
  const blocks = fencedBlocks(text);
  // Prose: every line outside a fence (1-based: the opening fence is the line
  // before a block's first body line, the closing fence the line after its last).
  const inFence = new Set();
  for (const b of blocks) for (let k = -1; k <= b.lines.length; k += 1) inFence.add(b.start + k);
  text.split(/\r?\n/).forEach((line, i) => {
    if (inFence.has(i + 1)) return;
    if (PROSE_PLACEHOLDER.test(line)) add(i + 1, line, 'a text flag shown taking a placeholder');
    if (line.includes('$PROMPT_ARG')) add(i + 1, line, '$PROMPT_ARG');
  });
  let usesTextDir = false;
  for (const b of blocks.filter((x) => SHELL_LANGS.has(x.lang))) {
    const src = b.lines.join('\n');
    const lineStarts = [0];
    for (let j = 0; j < src.length; j += 1) if (src[j] === '\n') lineStarts.push(j + 1);
    const lineAt = (offset) => lineStarts.findLastIndex((s) => s <= offset);
    const flag = (offset, why) => { const k = lineAt(offset); add(b.start + k, b.lines[k], why); };
    const { words, comments } = shellWords(src);
    const inComment = (offset) => comments.some(([from, to]) => offset >= from && offset < to);
    // What a flag or an assignment problem already names: its placeholder is
    // not reported again.
    const covered = [];
    words.forEach((w, k) => {
      // A free-text flag takes a fixed literal only (its value, the next word,
      // or after `=`).
      const flagName = TEXT_FLAGS.find((f) => w.text === `--${f}` || w.text.startsWith(`--${f}=`));
      if (flagName !== undefined) {
        const glued = w.text.length > flagName.length + 2;
        const value = glued ? { at: w.at + flagName.length + 3, raw: w.text.slice(flagName.length + 3) } : words[k + 1];
        if (value !== undefined) {
          if (/<[^<>]*>/.test(value.raw) || value.raw.startsWith('<')) {
            flag(w.at, `--${flagName} takes a placeholder`);
            covered.push([value.at, value.at + value.raw.length]);
          } else if (expands(value.raw)) flag(w.at, `--${flagName} takes an expansion`);
        }
      }
      // A state.mjs text file, quoted, from the text directory.
      const fileFlag = STATE_TEXT_FILE_FLAGS.find((f) => w.text === `--${f}-file` || w.text.startsWith(`--${f}-file=`));
      if (fileFlag !== undefined) {
        const glued = w.text.length > fileFlag.length + 7;
        const value = glued ? w.text.slice(fileFlag.length + 8) : words[k + 1]?.text;
        if (!/^"\$TEXT_DIR\/[\w.-]+"$/.test(value ?? '')) flag(w.at, `--${fileFlag}-file is not "$TEXT_DIR/<name>"`);
      }
      // A variable that holds text, assigned or added to in the block, its
      // whole value reported, so an exception is pinned by all it holds.
      if (ASSIGNMENT.test(w.text)) {
        problems.push({ at: `${label}:${b.start + lineAt(w.at)}`, text: w.raw, why: 'an assignment of agent text' });
        covered.push([w.at, w.at + w.raw.length]);
      }
    });
    for (const m of src.matchAll(HEREDOC)) if (!inComment(m.index)) flag(m.index, 'a heredoc');
    for (let at = src.indexOf('$PROMPT_ARG'); at >= 0; at = src.indexOf('$PROMPT_ARG', at + 1)) {
      if (!inComment(at)) flag(at, '$PROMPT_ARG');
    }
    // Any placeholder left in the source, whatever form carries it (a printf
    // or echo into a file, any variable, any flag), is text the agent writes
    // into the block (Critique finding M2) — unless it is not text: an enum,
    // the plugin root, or a directory on the line that names it. A message's
    // grammar (`Use --workflow=<id>.`) is pinned by identity below: its shape
    // alone does not tell it from a placeholder the agent fills (Refine-verify
    // finding).
    for (const m of src.matchAll(PLACEHOLDER)) {
      if (inComment(m.index) || covered.some(([from, to]) => m.index >= from && m.index < to)) continue;
      const k = words.findIndex((w) => m.index >= w.at && m.index < w.at + w.raw.length);
      if (k > 0 && SCRIPT_FLAGS.includes(words[k - 1].text)) continue;
      const line = b.lines[lineAt(m.index)].trim();
      if (ENUM_PLACEHOLDER.test(m[0]) || ROOT_PLACEHOLDERS.includes(m[0]) || DIRECTORY_LINE.test(line)) continue;
      flag(m.index, 'a placeholder in shell source');
    }
    const code = b.lines.map((line, k) => ({ line, n: b.start + k, k })).filter(({ line }) => line.trim() !== '' && !line.trimStart().startsWith('#'));
    if (code.some(({ line }) => line.includes('$TEXT_DIR'))) {
      usesTextDir = true;
      if (!TEXT_DIR_LINES.includes(code[0].line.trim())) add(code[0].n, code[0].line, 'a block that reads the text directory does not open with its TEXT_DIR line');
    }
  }
  if (usesTextDir) {
    if (!text.includes(MKTEMP_STEP)) add(0, label, 'no mktemp -d step creates the text directory');
    if (!/with your file-(?:writing|editing) tool/i.test(text.replace(/\s+/g, ' '))) add(0, label, 'the files are not written with the file tool');
  }
  // In document order (a stable sort keeps a line's own problems in order).
  const lineOf = (p) => Number(p.at.slice(p.at.lastIndexOf(':') + 1));
  return problems.sort((a, b) => lineOf(a) - lineOf(b));
}

// The exceptions, by identity: the file, the line as written, and why it is
// not the class. Each must be found exactly once, and nowhere else.
const ALLOWED = [
  // The note is built from values programs read or printed (the run's ids and
  // paths, head's read of the response) and the peer enum: an expansion's
  // result is not evaluated again. Pinned whole: a line of text written into
  // its body would be shell source.
  {
    file: 'plugins/orchestrator/commands/peer-now.md',
    line: 'NOTE="peer: $PEER\nrun_id: $RUN_ID\nhandle: $HANDLE_PATH\nprompt-mode: verbatim\n\n### Response\n\n$RESPONSE\n"',
    why: 'an assignment of agent text',
  },
  { file: 'plugins/orchestrator/commands/peer-now.md', line: '--phase-note "$NOTE" \\', why: '--phase-note takes an expansion' },
  { file: 'plugins/orchestrator/core/skills/peer-now/SKILL.md', line: '--phase-note "$NOTE" \\', why: '--phase-note takes an expansion' },
  // The hash Phase 1 printed, which the agent copies: hex digits, not text.
  { file: 'plugins/orchestrator/core/skills/approve/SKILL.md', line: '--expect-hash "<plan_hash from Phase 1>"', why: 'a placeholder in shell source' },
  // A command's grammar, shown to the user in a message to stderr: the line as
  // written, since a one-word placeholder in a message may as well be text the
  // agent fills (`echo "Drift: <summary>" >&2`, Refine-verify finding).
  ...[
    ['plugins/orchestrator/commands/abort.md', 'echo "✗ No macro workflow references branch \'$GIT_BRANCH\'. Use --workflow=<id>." >&2'],
    ['plugins/orchestrator/commands/done.md', 'echo "✗ No macro workflow references branch \'$GIT_BRANCH\'. Use --workflow=<id>." >&2'],
    ['plugins/orchestrator/commands/finalize.md', 'echo "✗ No macro workflow references branch \'$GIT_BRANCH\'. Use --workflow=<id> to specify." >&2'],
    ['plugins/orchestrator/commands/approve.md', 'echo "✗ Detached HEAD — pass --workflow=<macro-id>, or switch to the macro\'s branch or a subtask branch." >&2'],
    ['plugins/orchestrator/commands/approve.md', 'echo "✗ No macro workflow on branch \'$GIT_BRANCH\'. Pass --workflow=<macro-id>, or run /orchestrator:plan first." >&2'],
    ['plugins/orchestrator/commands/finalize.md', 'echo "✗ engineer plugin not found — cannot detach children. Install engineer or set AGENTIC_ENGINEER_ROOT=<path>." >&2'],
    ['plugins/orchestrator/commands/next.md', 'echo "  Install engineer or set AGENTIC_ENGINEER_ROOT=<path> before /orchestrator:next dispatch." >&2'],
    ['plugins/orchestrator/commands/next.md', 'echo "  Switch to the macro branch first: git switch <branch>" >&2'],
    ['plugins/orchestrator/commands/next.md', 'echo "  Use --workflow=<id> to specify, or run /orchestrator:plan to start one." >&2'],
    ['plugins/orchestrator/commands/next.md', 'echo "  Record each predecessor with /orchestrator:done <id> once its pull request has merged, or pick a different subtask." >&2'],
    ['plugins/orchestrator/commands/next.md', 'echo "✗ Subtask $SUBTASK_ID now waits on: $WAITING_NOW (the plan changed after Phase 1\'s selection); nothing was switched. Record each predecessor with /orchestrator:done <id> once its pull request has merged, then rerun /orchestrator:next." >&2'],
    ['plugins/orchestrator/commands/plan.md', 'echo "  Switch to a branch first: git switch <branch>" >&2'],
    ['plugins/orchestrator/commands/done.md', 'echo "✗ /orchestrator:done requires a <subtask-id> argument." >&2'],
    ['plugins/orchestrator/commands/done.md', 'echo "✓ Subtask $SUBTASK_ID is already completed at $EXISTING_CLOSED_AT with commit ${EXISTING_COMMIT:-<none>}. Nothing to do; to change the record, rerun with --correct and a reason." >&2'],
    ['plugins/orchestrator/commands/next.md', 'echo "  Repair: node \\"$CLAUDE_PLUGIN_ROOT/scripts/state.mjs\\" subtask-update --workflow-path \\"$MACRO_PATH\\" --host <host> --subtask-id $SUBTASK_ID --status=pending, then rerun /orchestrator:next." >&2'],
  ].map(([file, line]) => ({ file, line, why: 'a placeholder in shell source' })),
  // Predates C130 S3 and is outside it: the archive mode's workflow id, a user
  // argument, single-quoted (persona resume runbooks carry the same line).
  // Pinned so it is the only one; moving it to the args file is its own change.
  { file: 'plugins/orchestrator/commands/resume.md', line: "ARCHIVE_WORKFLOW_ID='<workflow-id>'", why: 'a placeholder in shell source' },
];

function corpusProblems() {
  const all = [
    ...[...COMMANDS, ...SKILL_DOCS].flatMap((f) => textTransportProblems(read(f), f)),
    ...YAML.flatMap((f) => textTransportProblems(read(f), f, 'yaml')),
  ];
  return { all, left: all.filter((p) => !allowed(p)) };
}
function allowed(p) {
  return ALLOWED.some((a) => p.at.startsWith(`${a.file}:`) && p.text === a.line && p.why === a.why);
}

test('no orchestrator runbook, skill, reference or agent file splices agent text into shell source', () => {
  // Contract: the agent running these runbooks and Codex skills — a placeholder
  // it fills in a block's source, or a variable it sets there, runs a backtick
  // or $(…) in the text it holds (the peer's sentences, in plan's note).
  const { left } = corpusProblems();
  deepStrictEqual(left.map((p) => `${p.at}: ${p.why}: ${p.text}`), []);
});

test('each exception is where it was, once', () => {
  // Contract: an allow-list entry that no longer matches would let the next
  // line written there pass unseen; one that matches twice allows a copy.
  const { all } = corpusProblems();
  for (const a of ALLOWED) {
    const hits = all.filter((p) => p.at.startsWith(`${a.file}:`) && p.text === a.line && p.why === a.why);
    strictEqual(hits.length, 1, `${a.file}: ${a.line}`);
  }
  // The note those lines record is built from head's read of the response,
  // read on the line right before it.
  ok(read('plugins/orchestrator/commands/peer-now.md').includes('  RESPONSE="$(head -c 4000 "$STDOUT_PATH")"\n  NOTE="peer: $PEER\n'), 'peer-now builds its note from head\'s read');
  ok(/`head -c 4000 "\$STDOUT_PATH"`/.test(read('plugins/orchestrator/core/skills/peer-now/SKILL.md')), 'the Codex skill names where $NOTE comes from');
});

test('the corpus is the orchestrator package, and the conversions are there (guards a vacuous pass)', () => {
  // Identity, not a count: the documents that carried the class before C130 S3.
  for (const f of [
    'plugins/orchestrator/commands/plan.md', 'plugins/orchestrator/commands/resume.md',
    'plugins/orchestrator/commands/checkpoint.md', 'plugins/orchestrator/commands/peer-now.md',
  ]) ok(COMMANDS.includes(f), f);
  for (const f of [
    'plugins/orchestrator/core/skills/plan/SKILL.md', 'plugins/orchestrator/core/skills/resume/SKILL.md',
    'plugins/orchestrator/core/skills/checkpoint/SKILL.md', 'plugins/orchestrator/core/skills/peer-now/SKILL.md',
    'plugins/orchestrator/core/skills/_shared/references/ensemble-protocol.md',
  ]) ok(SKILL_DOCS.includes(f), f);
  ok(YAML.includes('plugins/orchestrator/core/skills/peer-now/agents/openai.yaml'), 'peer-now openai.yaml');
  // Each value now travels as a file, from the text directory.
  const uses = {
    'plugins/orchestrator/commands/plan.md': [
      '--original-request-file "$TEXT_DIR/request.txt"', 'PROMPT_FILE="$TEXT_DIR/prompt.xml"',
      '--subtasks-json-file "$TEXT_DIR/subtasks.json"', '--decision-file "$TEXT_DIR/decision.txt"',
      '--architecture-file "$TEXT_DIR/architecture.txt"', '--phase-note-file "$TEXT_DIR/note.md"',
      '--summary-file "$TEXT_DIR/summary.txt"',
    ],
    'plugins/orchestrator/commands/resume.md': ['--phase-note-file "$TEXT_DIR/note.md"'],
    'plugins/orchestrator/commands/checkpoint.md': ['--summary-file "$TEXT_DIR/summary.txt"'],
    'plugins/orchestrator/commands/peer-now.md': ['--prompt-file "$PROMPT_FILE"', 'PROMPT_FILE="$(cat "$TEXT_DIR/prompt-path.txt")"'],
    'plugins/orchestrator/core/skills/resume/SKILL.md': ['--phase-note-file "$TEXT_DIR/note.md"'],
    'plugins/orchestrator/core/skills/checkpoint/SKILL.md': ['--summary-file "$TEXT_DIR/summary.txt"'],
    'plugins/orchestrator/core/skills/peer-now/SKILL.md': ['--prompt-file "$PROMPT_FILE"'],
    'plugins/orchestrator/core/skills/plan/SKILL.md': ['--decision-file <file>', '--architecture-file <file>', '--summary-file <summary file>', '--phase-note-file <note file>', '--original-request-file <file>'],
    'plugins/orchestrator/core/skills/_shared/references/ensemble-protocol.md': ['`--summary-file`'],
    'plugins/orchestrator/core/skills/peer-now/agents/openai.yaml': ['dispatch it with --prompt-file'],
  };
  for (const [f, needles] of Object.entries(uses)) {
    for (const needle of needles) ok(read(f).includes(needle), `${f} passes ${needle}`);
  }
});

test('a violation planted in each corpus class is reported, with its line', () => {
  // The checker run over a real document with one line changed: the planted
  // line, and only it, is left once the exceptions are set aside, as in the
  // corpus test. A checker that reports nothing passes the corpus vacuously.
  const plant = (f, from, to, kind) => {
    const text = read(f);
    ok(text.includes(from), `${f} holds the line the plant replaces: ${from}`);
    deepStrictEqual(textTransportProblems(text, f, kind).filter((p) => !allowed(p)), [], `${f} has no problem before the plant`);
    return textTransportProblems(text.replace(from, () => to), f, kind)
      .filter((p) => !allowed(p))
      .map((p) => [p.why, p.text]);
  };
  const PLAN = 'plugins/orchestrator/commands/plan.md';
  // A command block: plan's note back to NOTE="…" (C130 itself).
  deepStrictEqual(plant(PLAN, '  --phase-note-file "$TEXT_DIR/note.md" \\', 'NOTE="### Ensemble synthesis: <breakdown>"\n  --phase-note "$NOTE" \\'), [
    ['an assignment of agent text', 'NOTE="### Ensemble synthesis: <breakdown>"'],
    ['--phase-note takes an expansion', '--phase-note "$NOTE" \\'],
  ]);
  // The persona heredoc form, which a delimiter line in the text ends.
  deepStrictEqual(plant(PLAN, '--summary-file "$TEXT_DIR/summary.txt" \\', "--summary \"$(cat <<'PHASE_NOTE'\n)\" \\"), [
    ['--summary takes an expansion', '--verdict "$VERDICT" --summary "$(cat <<\'PHASE_NOTE\''],
    ['a heredoc', '--verdict "$VERDICT" --summary "$(cat <<\'PHASE_NOTE\''],
  ]);
  // Single quotes, the glued = spelling, and a bare placeholder.
  deepStrictEqual(plant(PLAN, '  --decision-file "$TEXT_DIR/decision.txt" \\', "  --decision '<one-line decision rationale>' --architecture=<summary> \\"), [
    ['--decision takes a placeholder', "--decision '<one-line decision rationale>' --architecture=<summary> \\"],
    ['--architecture takes a placeholder', "--decision '<one-line decision rationale>' --architecture=<summary> \\"],
  ]);
  // An unquoted path splits at a space in the directory's path.
  deepStrictEqual(plant(PLAN, '  --architecture-file "$TEXT_DIR/architecture.txt" \\', '  --architecture-file $TEXT_DIR/architecture.txt \\'), [
    ['--architecture-file is not "$TEXT_DIR/<name>"', '--architecture-file $TEXT_DIR/architecture.txt \\'],
  ]);
  // A block that reads the text directory without naming it first.
  deepStrictEqual(plant('plugins/orchestrator/commands/checkpoint.md', "TEXT_DIR='<directory from step 1>'\n", ''), [
    ['a block that reads the text directory does not open with its TEXT_DIR line', 'CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"'],
  ]);
  // peer-now's prompt spliced again.
  deepStrictEqual(plant('plugins/orchestrator/commands/peer-now.md', '  --peer "$PEER" --prompt-file "$PROMPT_FILE" \\', '  --peer "$PEER" $PROMPT_ARG \\'), [
    ['$PROMPT_ARG', '--peer "$PEER" $PROMPT_ARG \\'],
  ]);
  // The flag and its value on two lines, joined by a backslash; a value that
  // is a backquoted command; a heredoc whose delimiter is escaped (Review
  // findings).
  const RESUME = 'plugins/orchestrator/commands/resume.md';
  deepStrictEqual(plant(RESUME, '  --phase-note-file "$TEXT_DIR/note.md" \\', '  --phase-note \\\n  "<one-paragraph macro drift summary>" \\'), [
    ['--phase-note takes a placeholder', '--phase-note \\'],
  ]);
  deepStrictEqual(plant(RESUME, '  --phase-note-file "$TEXT_DIR/note.md" \\', '  --phase-note "`cat peer-note.txt`" \\'), [
    ['--phase-note takes an expansion', '--phase-note "`cat peer-note.txt`" \\'],
  ]);
  deepStrictEqual(plant(RESUME, '  --phase-note-file "$TEXT_DIR/note.md" \\', '  --phase-note `cat peer-note.txt` \\'), [
    ['--phase-note takes an expansion', '--phase-note `cat peer-note.txt` \\'],
  ]);
  deepStrictEqual(plant(RESUME, "TEXT_DIR='<directory from step 1>'\n", "TEXT_DIR='<directory from step 1>'\nIFS= read -r -d '' DRIFT <<\\DRIFT_NOTE\n"), [
    ['a heredoc', "IFS= read -r -d '' DRIFT <<\\DRIFT_NOTE"],
  ]);
  // The excepted note with text written into its body.
  const PEER_NOW = 'plugins/orchestrator/commands/peer-now.md';
  deepStrictEqual(plant(PEER_NOW, '\n  $RESPONSE\n  "', '\n  <peer feedback copied here>\n  "'), [
    ['an assignment of agent text', 'NOTE="peer: $PEER\nrun_id: $RUN_ID\nhandle: $HANDLE_PATH\nprompt-mode: verbatim\n\n### Response\n\n<peer feedback copied here>\n"'],
  ]);
  // A Codex skill block.
  deepStrictEqual(plant('plugins/orchestrator/core/skills/resume/SKILL.md', '  --phase-note-file "$TEXT_DIR/note.md" \\', '  --phase-note "<summary>" \\'), [
    ['--phase-note takes a placeholder', '--phase-note "<summary>" \\'],
  ]);
  // Forms no list of flags or variables names (Critique finding M2): text
  // written into a file by the shell, any variable, any flag, a variable added
  // to, and the prompt path as S2's persona runbooks first spelled it.
  const DIR_LINE = "TEXT_DIR='<directory from step 1>'\n";
  for (const [line, report] of [
    [`printf '%s\\n' "<…drift summary>" > "$TEXT_DIR/note.md"`, 'a placeholder in shell source'],
    ['echo "<the drift summary>" > "$TEXT_DIR/note.md"', 'a placeholder in shell source'],
    ['DRIFT="<one-paragraph drift summary>"', 'a placeholder in shell source'],
    ['NOTE+="<the drift summary>"', 'an assignment of agent text'],
  ]) {
    deepStrictEqual(plant(RESUME, DIR_LINE, `${DIR_LINE}${line}\n`), [[report, line]], line);
  }
  // Whatever the placeholder holds, wherever it sits in its word, and in a
  // message to stderr too (Refine-verify findings).
  for (const line of [
    `printf '%s\\n' "<the user's drift summary>" > "$TEXT_DIR/note.md"`,
    'DRIFT="prefix<summary>"',
    'echo "Drift: <summary>" >&2',
  ]) {
    deepStrictEqual(plant(RESUME, DIR_LINE, `${DIR_LINE}${line}\n`), [['a placeholder in shell source', line]], line);
  }
  deepStrictEqual(plant(RESUME, '  --phase-label "Resume: drift=<clean|dirty>" \\', '  --phase-label "Resume: <summary>" \\'), [
    ['a placeholder in shell source', '--phase-label "Resume: <summary>" \\'],
  ]);
  deepStrictEqual(plant(PEER_NOW, 'PROMPT_FILE="$TEXT_DIR/prompt.xml"\n', "PROMPT_FILE='<the path the user gave>'\n"), [
    ['a placeholder in shell source', "PROMPT_FILE='<the path the user gave>'"],
  ]);
  // A double-quoted value read to its real close: across a line, and past an
  // escaped quote (Critique finding M2, from the peer).
  deepStrictEqual(plant(RESUME, '  --phase-note-file "$TEXT_DIR/note.md" \\', '  --phase-note "Drift found:\n$SUMMARY" \\'), [
    ['--phase-note takes an expansion', '--phase-note "Drift found:'],
  ]);
  deepStrictEqual(plant(RESUME, '  --phase-note-file "$TEXT_DIR/note.md" \\', '  --phase-note "a \\" quote, then $SUMMARY" \\'), [
    ['--phase-note takes an expansion', '--phase-note "a \\" quote, then $SUMMARY" \\'],
  ]);
  // A backslash-newline inside a word joins it, so the value is all of it
  // (Refine-verify finding).
  deepStrictEqual(plant(RESUME, '  --phase-note-file "$TEXT_DIR/note.md" \\', '  --phase-note "prefix"\\\n"$(cat peer-note.txt)" \\'), [
    ['--phase-note takes an expansion', '--phase-note "prefix"\\'],
  ]);
  // So does one inside the flag's name.
  deepStrictEqual(plant(RESUME, '  --phase-note-file "$TEXT_DIR/note.md" \\', '  --phase-\\\nnote "$SUMMARY" \\'), [
    ['--phase-note takes an expansion', '--phase-\\'],
  ]);
  // Skill prose, and a shared reference's prose.
  deepStrictEqual(plant('plugins/orchestrator/core/skills/plan/SKILL.md', '[--decision-file <file>]', '[--decision <text>]'), [
    ['a text flag shown taking a placeholder', plantedLine('plugins/orchestrator/core/skills/plan/SKILL.md', '[--decision-file <file>]', '[--decision <text>]')],
  ]);
  deepStrictEqual(plant('plugins/orchestrator/core/skills/_shared/references/ensemble-protocol.md', 'before writing its file', 'before passing it to `--summary "<text>"`'), [
    ['a text flag shown taking a placeholder', plantedLine('plugins/orchestrator/core/skills/_shared/references/ensemble-protocol.md', 'before writing its file', 'before passing it to `--summary "<text>"`')],
  ]);
  // An agent file.
  deepStrictEqual(plant('plugins/orchestrator/core/skills/peer-now/agents/openai.yaml', 'dispatch it with --prompt-file', 'dispatch it as $PROMPT_ARG', 'yaml'), [
    ['$PROMPT_ARG', plantedLine('plugins/orchestrator/core/skills/peer-now/agents/openai.yaml', 'dispatch it with --prompt-file', 'dispatch it as $PROMPT_ARG')],
  ]);
});

// The whole line a plant lands on, as the checker reports it.
function plantedLine(f, from, to) {
  const text = read(f).replace(from, () => to);
  return text.split(/\r?\n/).find((l) => l.includes(to)).trim();
}

test('a fixed literal on a text flag is not the class', () => {
  // Contract: the checker's boundary — the runbook's own words are not text an
  // agent writes; a checker that flagged them would be answered by an
  // allow-list that also hides the class.
  const doc = '```bash\nnode "$X/state.mjs" append --phase-note "Resumed prior orchestrator plan workflow." \\\n  --next-action "Await the owner\'s approval" --event resumed\n```\n';
  deepStrictEqual(textTransportProblems(doc, 'literal.md'), []);
  // Prose may show the user's own grammar for peer-now.
  deepStrictEqual(textTransportProblems('Exactly one of `--prompt-text "..."` or `--prompt-file <path>`.\n', 'grammar.md'), []);
  // Placeholders that are not text: an enum, the plugin root, a `$` a single
  // quote keeps literal, and a program's own source (`node -e`).
  const notText = [
    '```bash',
    'node "<plugin-root>/scripts/state.mjs" append --host <claude|codex> \\',
    '  --phase-label "Resume: drift=<clean|dirty>" --next-action \'Run $orchestrator:next\' --event resumed',
    'node -e \'for (let i = 0; i<a.length; i += 1) if (a[i] <x> 0) process.exit(1)\'',
    '```',
    '',
  ].join('\n');
  deepStrictEqual(textTransportProblems(notText, 'not-text.md'), []);
  // A message's grammar is not told from text by its shape: outside the lines
  // pinned above, `<id>` in a message is reported like any placeholder.
  deepStrictEqual(textTransportProblems('```bash\necho "✗ Use --workflow=<id>." >&2\n```\n', 'message.md').map((p) => p.why), ['a placeholder in shell source']);
});
