// Claude command bodies carry no token Claude substitutes by accident.
//
// WHY THIS EXISTS. Claude Code substitutes a slash command's arguments into
// the command's markdown before the model sees it, and a dollar sign followed
// by a digit is one of the tokens it replaces (counted from 0).
// `/orchestrator:done` read its fields through two shell helpers written with
// `"$1"`, so `/orchestrator:done C3 --pr=826` handed the agent `"--pr=826"` in
// both: every field read empty, and the macro could not be recorded until the
// file was run by hand (docket C67, 2026-09-28). A quoted argument did worse —
// `A 'x"; touch f; "'` made `"$1"` read `"x"; touch f; ""`, and the shell ran
// it. The runbook test saw none of it, because it ran the file as written.
// The grammar and how it was measured: tests/_claude-command-substitution.mjs.
//
// THE RULE. A command body may use `$ARGUMENTS`: that is how a runbook
// receives its arguments, and ADR-0059 decides where it may reach shell
// source (the last check below holds those places to a named list). Nothing
// else from the grammar may appear:
//
//   - a dollar sign followed by a digit, in any spelling. Claude replaces
//     `$1`, `"$1"`, `$0.005`, and `\$1` too (it eats the backslash, so the
//     agent reads a bare token the file shows escaped). `$1abc` and `$12` are
//     left alone by Claude, but bash reads both as the positional parameter
//     `$1` followed by text: a runbook has no positional parameters to read.
//   - `${N}`: not substituted today only because the host's pattern wants a
//     digit right after `$`; a positional parameter all the same.
//   - `$ARGUMENTS[N]`.
//   - an `arguments:` frontmatter key, which turns `$<name>` into a
//     substitution as well (a missing token becomes "").
//
// `$@` and `$*` are not substituted and stay the shell's:
// plugins/engineer/commands/start.md reads `"$@"` after its
// `set -- $ARGUMENTS` splice, which ADR-0059 retires.
//
// The corpus is every body Claude loads from these plugins. Codex injects a
// SKILL.md byte-for-byte (measured 0.156.1 and 0.157.1), so the skills under
// core/skills are out of scope here.

import { test } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OutsideMeasuredGrammar,
  splitClaudeArguments,
  substituteClaudeArguments,
} from '../_claude-command-substitution.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS_DIR = join(REPO_ROOT, 'plugins');
const MEASURED = JSON.parse(readFileSync(join(REPO_ROOT, 'tests', 'fixtures', 'claude-command-substitution.json'), 'utf8'));
const rel = (root, p) => relative(root, p).split('\\').join('/');

// ── The corpus ──────────────────────────────────────────────────────────────

function walk(dir, keep, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, keep, acc);
    else if (keep(entry)) acc.push(p);
  }
  return acc;
}

/** Every file Claude loads as a command or skill body from the plugins under `pluginsDir`. */
function claudeBodies(pluginsDir) {
  const plugins = readdirSync(pluginsDir).filter((d) => existsSync(join(pluginsDir, d, '.claude-plugin', 'plugin.json')));
  return {
    plugins,
    files: plugins.flatMap((p) => [
      ...walk(join(pluginsDir, p, 'commands'), (f) => f.endsWith('.md')),
      ...walk(join(pluginsDir, p, 'skills'), (f) => f === 'SKILL.md'),
    ]).sort(),
  };
}

function splitFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  return m ? { frontmatter: m[1], body: text.slice(m[0].length) } : { frontmatter: '', body: text };
}

// ── The scanner (policy) ────────────────────────────────────────────────────
// The match starts at `$`, so `\$1` is caught like `$1`.
const FORBIDDEN = [
  { name: 'positional parameter', re: /\$\d/g },
  { name: 'braced positional parameter', re: /\$\{\d/g },
  { name: 'indexed argument', re: /\$ARGUMENTS\[\d+\]/g },
];
const forbiddenTokens = (line) =>
  FORBIDDEN.flatMap(({ name, re }) => [...line.matchAll(re)].map((m) => `${name} at column ${m.index + 1}`));

// Conservative: an `arguments` key anywhere — block or flow mapping, quoted or
// not — counts, even where a YAML parser would read it as part of a value.
const declaresArgumentNames = (frontmatter) => /(?:^|[\s{,])["']?arguments["']?[ \t]*:/m.test(frontmatter);

// The list-item and blockquote markers a fence can sit behind.
const CONTAINER = /^(?:[ \t]*(?:>[ \t]?|[-*+][ \t]+|\d{1,9}[.)][ \t]+))*/;

/** Lines inside fenced code blocks: ``` or ~~~, any indent, inside lists and blockquotes, CRLF-safe. */
function fencedLines(body) {
  const out = [];
  let open = null;
  for (const line of body.split(/\r?\n/)) {
    const bare = line.replace(CONTAINER, '');
    const fence = bare.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
    // A backtick fence's info string cannot hold a backtick (that is inline code).
    const isFence = fence && !(fence[1][0] === '`' && fence[2].includes('`'));
    if (open === null) {
      if (isFence) open = fence[1];
      continue;
    }
    if (isFence && fence[1][0] === open[0] && fence[1].length >= open.length && fence[2].trim() === '') {
      open = null;
      continue;
    }
    out.push(line);
  }
  return out;
}

// Where typed text lands in code: render the raw body with a sentinel and
// find it. An escaped `\$ARGUMENTS` (eight template placeholders today) comes
// out as the literal text `$ARGUMENTS` and carries nothing typed.
const SENTINEL = 'C67ARGSENTINEL';
const argumentLinesInCode = (body) =>
  fencedLines(substituteClaudeArguments(body, SENTINEL))
    .filter((line) => line.includes(SENTINEL))
    .map((line) => line.trim().replaceAll(SENTINEL, '$ARGUMENTS'));

// ADR-0059 §Context: 16 unquoted splice sites and 3 quoted placeholders; the
// three decide runbooks also name the placeholder in a comment beside their
// splice. ADR-0059 removes all of them. Each is pinned by its line so a new
// site cannot hide behind a removed one; delete an entry when its line goes.
const ARGUMENT_LINES_IN_CODE = {
  'plugins/designer/commands/decide.md': [
    '# `$ARGUMENTS` is the verbatim user input. Expand unquoted so the shell',
    'node "$CLAUDE_PLUGIN_ROOT/scripts/decide-registry.mjs" resolve $ARGUMENTS \\',
  ],
  'plugins/designer/commands/investigate.md': [
    '--profile "${AGENTIC_PROFILE:-<profile from $ARGUMENTS — design-brief; default \'design-brief\'>}" \\',
  ],
  'plugins/designer/commands/start.md': ['node "$CLAUDE_PLUGIN_ROOT/scripts/decide-registry.mjs" resolve $ARGUMENTS \\'],
  'plugins/engineer/commands/decide.md': [
    '# `$ARGUMENTS` is the verbatim user input from the slash command.',
    'node "$CLAUDE_PLUGIN_ROOT/scripts/decide-registry.mjs" resolve $ARGUMENTS \\',
  ],
  'plugins/engineer/commands/investigate.md': [
    '--profile "${AGENTIC_PROFILE:-<profile from $ARGUMENTS — analysis|root-cause|cited-brief; default \'analysis\'>}" \\',
  ],
  'plugins/engineer/commands/start.md': ['set -- $ARGUMENTS'],
  'plugins/founder/commands/decide.md': [
    '# `$ARGUMENTS` is the verbatim user input. Expand unquoted so the shell',
    'node "$CLAUDE_PLUGIN_ROOT/scripts/decide-registry.mjs" resolve $ARGUMENTS \\',
  ],
  'plugins/founder/commands/investigate.md': [
    '--profile "${AGENTIC_PROFILE:-<profile from $ARGUMENTS — business-brief; default \'business-brief\'>}" \\',
  ],
  'plugins/runtime/commands/bootstrap.md': ['node "$RUNTIME_ROOT/scripts/bootstrap.mjs" $ARGUMENTS'],
  'plugins/runtime/commands/compat.md': ['node "$RUNTIME_ROOT/scripts/compat.mjs" --repo-root "$REPO_ROOT" $ARGUMENTS'],
  'plugins/runtime/commands/consensus.md': ['node "$RUNTIME_ROOT/scripts/consensus.mjs" --repo-root "$REPO_ROOT" $ARGUMENTS'],
  'plugins/runtime/commands/context.md': ['node "$RUNTIME_ROOT/scripts/context.mjs" --repo-root "$REPO_ROOT" $ARGUMENTS'],
  'plugins/runtime/commands/cutover.md': ['node "$RUNTIME_ROOT/scripts/cutover-audit.mjs" --repo-root "$REPO_ROOT" $ARGUMENTS'],
  'plugins/runtime/commands/dashboard.md': ['node "$RUNTIME_ROOT/scripts/dashboard.mjs" --repo-root "$REPO_ROOT" --host claude $ARGUMENTS'],
  'plugins/runtime/commands/doctor.md': ['node "$RUNTIME_ROOT/scripts/doctor.mjs" --repo-root "$REPO_ROOT" $ARGUMENTS'],
  'plugins/runtime/commands/migrate.md': ['node "$RUNTIME_ROOT/scripts/migrate.mjs" --repo-root "$REPO_ROOT" $ARGUMENTS'],
  'plugins/runtime/commands/retention.md': ['node "$RUNTIME_ROOT/scripts/retention.mjs" $ARGUMENTS --repo-root "$REPO_ROOT"'],
  'plugins/runtime/commands/settings.md': ['node "$RUNTIME_ROOT/scripts/settings.mjs" --repo-root "$REPO_ROOT" $ARGUMENTS'],
  'plugins/runtime/commands/worktree.md': ['node "$RUNTIME_ROOT/scripts/worktree.mjs" --repo-root "$REPO_ROOT" $ARGUMENTS'],
};

test('Claude command-argument substitution', async (t) => {
  await t.test('the port reproduces every measured cell', () => {
    strictEqual(MEASURED.claude_version, '2.1.283');
    ok(MEASURED.cells.length >= 14, `only ${MEASURED.cells.length} measured cells`);
    for (const cell of MEASURED.cells) {
      const command = MEASURED.commands[cell.command];
      strictEqual(substituteClaudeArguments(command.body, cell.args, { argNames: command.argument_names }), cell.expanded,
        `/${cell.command} ${JSON.stringify(cell.args)}`);
    }
  });

  await t.test('the port follows the source where no cell was measured, and refuses what it does not model', () => {
    // No argument string at all leaves the body alone; a body without a
    // placeholder gets the arguments appended; long strings split on whitespace.
    strictEqual(substituteClaudeArguments('x $1', undefined), 'x $1');
    strictEqual(substituteClaudeArguments('no placeholder', 'a b'), 'no placeholder\n\nARGUMENTS: a b');
    strictEqual(splitClaudeArguments(`a ${'b'.repeat(10_000)} $(c) d`).length, 4);
    deepStrictEqual(splitClaudeArguments('NAME=1 A B'), ['A', 'B']);
    deepStrictEqual(splitClaudeArguments('A --pr="7" B'), ['A', '--pr=7', 'B']);
    deepStrictEqual(splitClaudeArguments('A $y B'), ['A', 'B']);
    for (const shape of [
      "A 'x", 'A > f', 'A (b)', 'A #c', 'if A', 'A \\\nB',
      "A $'x y' B", 'A $"x" B', 'A ${a:-${b}} B', 'A "$(echo "x")" B', '$(echo "a") B',
    ]) {
      throws(() => splitClaudeArguments(shape), OutsideMeasuredGrammar, shape);
    }
    // An opaque word the host never reaches, because it stops at an earlier
    // substitution, is not refused (the measured `"$(id -u)"` cell).
    deepStrictEqual(splitClaudeArguments('A $(x) "$(y)" $\'z\' B'), ['A']);
  });

  await t.test('whatever the port substitutes is forbidden or permitted; whatever is forbidden is named', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `w${i}`).join(' ');
    const changed = (line) => substituteClaudeArguments(line, twelve, { appendIfUnused: false }) !== line;
    const PERMITTED = ['$ARGUMENTS', '\\$ARGUMENTS'];
    const POLICY_ONLY = ['${1}', '$1abc', '$1_x', '$12', 'x${10}y'];
    const NEITHER = ['$@', '$*', '$#', '$HOME', '$CLAUDE_PLUGIN_ROOT', '${CLAUDE_PLUGIN_ROOT:-}', '$', 'price 5$'];
    const SUBSTITUTED = ['"$1"', '$0', '$10', '$11)', '\\$1', '\\\\$1', '\\$1abc', '$0.005', 'x $9)', '$ARGUMENTS[1]', '$ARGUMENTS[11]'];
    for (const line of SUBSTITUTED) {
      ok(changed(line), `${line} is substituted`);
      ok(forbiddenTokens(line).length > 0, `${line} is forbidden`);
    }
    for (const line of PERMITTED) {
      ok(changed(line), `${line} is substituted`);
      strictEqual(forbiddenTokens(line).length, 0, `${line} is permitted`);
    }
    for (const line of POLICY_ONLY) {
      strictEqual(changed(line), false, `${line} is not substituted`);
      ok(forbiddenTokens(line).length > 0, `${line} is forbidden anyway`);
    }
    for (const line of NEITHER) {
      strictEqual(changed(line), false, `${line} is not substituted`);
      strictEqual(forbiddenTokens(line).length, 0, `${line} is not forbidden`);
    }
  });

  await t.test('frontmatter and fences are read in every spelling the corpus could use', () => {
    for (const fm of [
      'arguments: [a]', '"arguments": a b', "'arguments' : [a]", '  arguments:\n  - a',
      '{arguments: [SUBTASK_ID]}', '{description: x, arguments: a}',
    ]) {
      ok(declaresArgumentNames(fm), fm);
    }
    ok(!declaresArgumentNames('argument-hint: <a>'));
    const body = [
      'prose $ARGUMENTS', '```bash', 'a $ARGUMENTS', '```', '~~~', 'b $ARGUMENTS', '~~~',
      '  ````sh', '  c $ARGUMENTS', '  ```', '  d $ARGUMENTS', '  ````', 'after $ARGUMENTS',
    ].join('\r\n');
    // The ```` fence is not closed by ```, so `d` is still code.
    deepStrictEqual(argumentLinesInCode(body), ['a $ARGUMENTS', 'b $ARGUMENTS', 'c $ARGUMENTS', 'd $ARGUMENTS']);
    const nested = [
      '- ```bash', '  e $ARGUMENTS', '  ```', '> ```bash', '> f $ARGUMENTS', '> ```',
      '1. ~~~', '   g $ARGUMENTS', '   ~~~', '- ```inline``` prose $ARGUMENTS',
    ].join('\n');
    deepStrictEqual(argumentLinesInCode(nested), ['e $ARGUMENTS', '> f $ARGUMENTS', 'g $ARGUMENTS']);
    // A frontmatter block is not body.
    deepStrictEqual(splitFrontmatter('---\r\na: 1\r\n---\r\nx').body, 'x');
  });

  await t.test('the corpus is every body Claude loads, found by traversal', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claude-bodies-'));
    try {
      for (const [p, files] of [['one', ['commands/a.md', 'commands/nested/b.md', 'skills/s/SKILL.md', 'skills/README.md']], ['codex-only', ['commands/x.md']]]) {
        for (const f of files) {
          mkdirSync(join(tmp, p, f, '..'), { recursive: true });
          writeFileSync(join(tmp, p, f), '');
        }
      }
      mkdirSync(join(tmp, 'one', '.claude-plugin'));
      writeFileSync(join(tmp, 'one', '.claude-plugin', 'plugin.json'), '{}');
      deepStrictEqual(claudeBodies(tmp).files.map((f) => rel(tmp, f)),
        ['one/commands/a.md', 'one/commands/nested/b.md', 'one/skills/s/SKILL.md']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    const { plugins, files } = claudeBodies(PLUGINS_DIR);
    for (const p of plugins) {
      const manifest = JSON.parse(readFileSync(join(PLUGINS_DIR, p, '.claude-plugin', 'plugin.json'), 'utf8'));
      for (const key of ['commands', 'skills']) {
        strictEqual(manifest[key], undefined,
          `plugins/${p}/.claude-plugin/plugin.json declares "${key}"; claudeBodies() reads the default directories only — extend it first`);
      }
    }
    // Identity, not a count: the files this defect was found in.
    for (const f of ['plugins/orchestrator/commands/done.md', 'plugins/orchestrator/commands/next.md']) {
      ok(files.map((p) => rel(REPO_ROOT, p)).includes(f), `${f} is not in the corpus`);
    }
  });

  const { files: CORPUS } = claudeBodies(PLUGINS_DIR);

  await t.test('no command body carries a positional parameter or an indexed argument', () => {
    const offenders = [];
    for (const f of CORPUS) {
      const { body } = splitFrontmatter(readFileSync(f, 'utf8'));
      body.split(/\r?\n/).forEach((line, i) => {
        for (const hit of forbiddenTokens(line)) offenders.push(`${rel(REPO_ROOT, f)} (body line ${i + 1}, ${hit}): ${line.trim()}`);
      });
    }
    deepStrictEqual(offenders, [],
      'Claude replaces these with the command\'s arguments before the agent reads the runbook; pass values through variables, the environment, or stdin');
  });

  await t.test('no command declares named arguments', () => {
    const declaring = CORPUS.filter((f) => declaresArgumentNames(splitFrontmatter(readFileSync(f, 'utf8')).frontmatter));
    deepStrictEqual(declaring.map((f) => rel(REPO_ROOT, f)), [],
      'an `arguments:` frontmatter key makes `$<name>` a substitution too (a missing token becomes "")');
  });

  await t.test('typed text reaches fenced code only on the lines ADR-0059 counts', () => {
    const found = {};
    for (const f of CORPUS) {
      const lines = argumentLinesInCode(splitFrontmatter(readFileSync(f, 'utf8')).body);
      if (lines.length > 0) found[rel(REPO_ROOT, f)] = lines;
    }
    deepStrictEqual(found, ARGUMENT_LINES_IN_CODE,
      'a new line puts typed text into shell source (ADR-0059); a removed one must be removed from ARGUMENT_LINES_IN_CODE');
  });
});
