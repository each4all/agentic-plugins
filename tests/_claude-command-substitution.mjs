// What Claude Code does to a plugin command body before the model sees it.
//
// Claude substitutes the slash command's arguments into the markdown of a
// command body. A runbook test that executes the file as written therefore
// runs text no agent ever receives: `/orchestrator:done C3 --pr=826` handed the
// agent a `"$1"` that read `"--pr=826"`, so every field `/done` read came back
// empty, while the runbook test — which ran the file text — stayed green
// (docket C67). This module reproduces the substitution so a test can run the
// text Claude hands the agent instead.
//
// Not discovered by `node --test` (the leading underscore matches none of its
// patterns); gated by tests/plugin-shape/test-command-argument-substitution.mjs.
//
// PROVENANCE. Claude Code 2.1.283, 2026-09-28, two ways:
//
//   1. The bundled source in the native binary. Plugin commands reach
//      `uEe(body, args, true, argNames, av)`; the argument string is split by
//      `qhr` → `Qd` → tree-sitter bash → `xle` (first command) → `hKe` (its
//      words). The rules below follow that source; the minified names are
//      given to find it again.
//   2. Live runs, recorded verbatim in tests/fixtures/claude-command-substitution.json
//      (14 argument strings, including quotes, newlines, `$(…)`, `;`, globs and
//      `!`). The gate checks this module against every one of them.
//      scripts/probe-claude-command-substitution.mjs repeats the measurement.
//
// Codex does not do this: a mentioned skill's SKILL.md is injected
// byte-for-byte (codex-cli 0.156.1 and 0.157.1, measured the same day). Claude
// loads no SKILL.md from these plugins (their Claude `skills/` directories hold
// only a README), so the substitution reaches exactly `plugins/*/commands/`.
//
// THE SUBSTITUTION (`uEe`, in the order it applies):
//
//   0. No argument string at all (undefined/null) leaves the body unchanged.
//      A slash command typed without arguments passes "" — the rules run.
//   1. `\$` (not itself preceded by `\`) followed by a digit, `ARGUMENTS`, or a
//      declared argument name becomes a literal `$`: the backslash is eaten,
//      even when there are no arguments.
//   2. Declared names (frontmatter `arguments:`), longest first: `$name` not
//      followed by `[` or a word character becomes token i, or "" when the
//      token is missing.
//   3. `$ARGUMENTS[N]` becomes token N, or stays literal when it is missing.
//   4. `$N` — `/\$(\d+)(?!\w)/`, counted from 0 — becomes token N, or stays
//      literal when it is missing. `$0.005` is `$0` followed by `.005`.
//   5. `$ARGUMENTS` becomes the whole argument string. It is a plain
//      replaceAll, so `$ARGUMENTS_HINT` loses its prefix too.
//   6. When nothing was substituted and the string is non-empty, the body
//      gains a trailing "\n\nARGUMENTS: <string>".
//   A substituted value is never substituted again, and its `!` is escaped
//   where it could open a load-time `` !`command` `` (`av`).
//
// Never touched: `${1}`, `$@`, `$*`, `$1abc`, `$1_x`, `$CLAUDE_PLUGIN_ROOT`.
// (`${CLAUDE_PLUGIN_ROOT}` in exactly that spelling is replaced by the plugin
// root in a separate, argument-independent pass this module does not model.)
//
// THE TOKENS (`qhr`). An argument string of more than 10,000 characters is
// split on whitespace. Otherwise it is parsed as bash and the FIRST command's
// words become the tokens — a newline, `;`, `&` or `|` ends that command.
// Leading `NAME=value` assignments are skipped. Each word then becomes:
//   - a plain word: itself, with each `\x` reduced to `x`;
//   - a quoted word ('…' or "…" as the whole word): the text between the
//     quotes, verbatim — escapes inside double quotes are NOT processed and
//     `$y` inside them is kept as text;
//   - a word joining several of those (`--pr="7"`): the pieces joined;
//   - an unquoted `$y` / `${y}`: skipped;
//   - an unquoted `$(…)`, backquote or `<(…)` (alone or inside a joined word):
//     the end of the tokens.
// The first word is kept whatever it is (`$(x) A` gives `$(x)`, `A`). When no
// command word is found, the string is split on whitespace.
// Shapes this module does not reproduce throw OutsideMeasuredGrammar rather
// than guess. Some change how the whole string parses — an unterminated quote,
// a redirection, a parenthesis, a `#` comment, a heredoc, a shell keyword as
// the first word — and throw wherever they are. Others are opaque only inside
// one word — `$'…'`, `$"…"`, a nested `${…}`, a double-quoted word holding
// `$(…)` or a backquote, a `$(…)` holding a quote — and throw only when the
// tokens reach that word, since the host stops at an earlier substitution.

export class OutsideMeasuredGrammar extends Error {}

const ARGUMENT_PARSE_LIMIT = 10_000; // `IM`
const PROTECTED_DOLLAR = '￿';
const VALUE_FENCE = '￾';
const SHELL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
  'function', 'select', 'time', 'coproc', '{', '}', '[[', ']]', '!',
  'export', 'declare', 'typeset', 'local', 'readonly',
]);

const regexEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `av`: keep a substituted value from forming a `` !`…` `` shell block.
function escapeValue(v) {
  return v.replace(/`!/g, '` !').replace(/!`/g, '! `').replace(/(^|\s)!/gm, '$1\\!');
}

function closingParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === '\\') { i += 1; continue; }
    if (s[i] === '(') depth += 1;
    if (s[i] === ')') { depth -= 1; if (depth === 0) return i; }
  }
  throw new OutsideMeasuredGrammar('unterminated $( or <(');
}

/** The first command's words, each a list of pieces { kind, text }. */
function firstCommandWords(s) {
  const words = [];
  let pieces = [];
  let plain = '';
  const flush = () => { if (plain !== '') { pieces.push({ kind: 'word', text: plain }); plain = ''; } };
  const endWord = () => { flush(); if (pieces.length > 0) { words.push(pieces); pieces = []; } };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    if (c === ' ' || c === '\t') { endWord(); i += 1; continue; }
    if (c === '\n' || c === ';' || c === '&' || c === '|') break;
    if (c === '\\') {
      if (next === undefined) { plain += c; i += 1; continue; }
      if (next === '\n') throw new OutsideMeasuredGrammar('line continuation');
      plain += c + next; i += 2; continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new OutsideMeasuredGrammar('unterminated single quote');
      flush(); pieces.push({ kind: 'quoted', text: s.slice(i, end + 1) }); i = end + 1; continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      if (j >= s.length) throw new OutsideMeasuredGrammar('unterminated double quote');
      const text = s.slice(i, j + 1);
      flush();
      pieces.push(/\$\(|`/.test(text)
        ? { kind: 'unsupported', text, why: 'a substitution inside double quotes' }
        : { kind: 'quoted', text });
      i = j + 1; continue;
    }
    if (c === '$' && (next === "'" || next === '"')) {
      const end = s.indexOf(next, i + 2);
      if (end < 0) throw new OutsideMeasuredGrammar(`unterminated $${next}`);
      flush(); pieces.push({ kind: 'unsupported', text: s.slice(i, end + 1), why: `$${next}…${next} quoting` }); i = end + 1; continue;
    }
    if ((c === '$' || c === '<' || c === '>') && next === '(') {
      const end = closingParen(s, i + 1);
      const text = s.slice(i, end + 1);
      flush();
      pieces.push({ kind: 'substitution', text, ...(/['"`]/.test(text) ? { why: 'a quote inside a substitution' } : {}) });
      i = end + 1; continue;
    }
    if (c === '`') {
      let j = i + 1;
      while (j < s.length && s[j] !== '`') j += s[j] === '\\' ? 2 : 1;
      if (j >= s.length) throw new OutsideMeasuredGrammar('unterminated backquote');
      flush(); pieces.push({ kind: 'substitution', text: s.slice(i, j + 1) }); i = j + 1; continue;
    }
    if (c === '$' && next === '{') {
      const end = s.indexOf('}', i + 2);
      if (end < 0) throw new OutsideMeasuredGrammar('unterminated ${');
      const text = s.slice(i, end + 1);
      flush();
      pieces.push(/[{$'"`]/.test(text.slice(2))
        ? { kind: 'unsupported', text, why: 'a nested ${…}' }
        : { kind: 'expansion', text });
      i = end + 1; continue;
    }
    if (c === '$' && next !== undefined && /[A-Za-z_]/.test(next)) {
      const m = s.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      flush(); pieces.push({ kind: 'expansion', text: `$${m[0]}` }); i += 1 + m[0].length; continue;
    }
    if (c === '$' && next !== undefined && /[0-9?#@*!$-]/.test(next)) {
      flush(); pieces.push({ kind: 'expansion', text: s.slice(i, i + 2) }); i += 2; continue;
    }
    if ('<>()'.includes(c)) throw new OutsideMeasuredGrammar(`unquoted ${c}`);
    if (c === '#' && plain === '' && pieces.length === 0) throw new OutsideMeasuredGrammar('comment');
    plain += c; i += 1;
  }
  endWord();
  return words;
}

// `qe` and `O`: a word loses its backslashes, a quoted word its quotes.
const unquote = (t) => (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'")) ? t.slice(1, -1) : t);
const pieceText = (p) => (p.kind === 'word' ? p.text.replace(/\\(.)/g, '$1') : unquote(p.text));

// Reached a word this module cannot tokenize the way the host does.
function refuse(pieces) {
  const odd = pieces.find((p) => p.kind === 'unsupported' || p.why);
  if (odd) throw new OutsideMeasuredGrammar(odd.why);
}

/** `hKe`: the argv of the first command, or null when it has no command word. */
function commandArgv(words) {
  const argv = [];
  let named = false;
  for (const pieces of words) {
    const single = pieces.length === 1 ? pieces[0] : null;
    if (!named) refuse(pieces);
    else if (!pieces.some((p) => p.kind === 'substitution')) refuse(pieces);
    if (!named) {
      if (pieces[0].kind === 'word' && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(pieces[0].text)) continue;
      named = true;
      const raw = pieces.map((p) => p.text).join('');
      if (single?.kind === 'word' && SHELL_KEYWORDS.has(raw)) throw new OutsideMeasuredGrammar(`first word ${raw}`);
      if (single) argv.push(pieceText(single));
      else argv.push(pieces.some((p) => p.kind === 'substitution') ? raw : pieces.map(pieceText).join(''));
      continue;
    }
    if (single) {
      if (single.kind === 'substitution') break;
      if (single.kind !== 'expansion') argv.push(pieceText(single));
    } else {
      if (pieces.some((p) => p.kind === 'substitution')) break;
      argv.push(pieces.map(pieceText).join(''));
    }
  }
  return named ? argv : null;
}

/** Split an argument string into the tokens `$N` and `$ARGUMENTS[N]` read. */
export function splitClaudeArguments(args) {
  if (!args || !args.trim()) return [];
  const argv = args.length > ARGUMENT_PARSE_LIMIT ? null : commandArgv(firstCommandWords(args));
  return argv && argv.length > 0 ? argv : args.split(/\s+/).filter(Boolean);
}

/**
 * The body Claude Code hands the model for a plugin command invoked with
 * `args` (the text after the command name, "" when none was typed).
 */
export function substituteClaudeArguments(body, args, { argNames = [], appendIfUnused = true } = {}) {
  if (args === undefined || args === null) return body;
  const scrub = (s) => s.replaceAll(PROTECTED_DOLLAR, '�').replaceAll(VALUE_FENCE, '�');
  const wrap = (v) => VALUE_FENCE + escapeValue(scrub(v ?? '')).replaceAll('$', PROTECTED_DOLLAR) + VALUE_FENCE;
  const tokens = splitClaudeArguments(args);
  const names = argNames
    .map((name, i) => ({ name, i }))
    .filter(({ name }) => Boolean(name))
    .sort((a, b) => b.name.length - a.name.length);
  const escapable = ['\\d', 'ARGUMENTS', ...names.map(({ name }) => `${regexEscape(name)}(?![\\[\\w])`)].join('|');

  let text = scrub(body);
  text = text.replace(new RegExp(`(?<!\\\\)\\\\\\$(?=${escapable})`, 'g'), PROTECTED_DOLLAR);
  let used = false;
  for (const { name, i } of names) {
    text = text.replace(new RegExp(`\\$${regexEscape(name)}(?![\\[\\w])`, 'g'), () => { used = true; return wrap(tokens[i]); });
  }
  text = text.replace(/\$ARGUMENTS\[(\d+)\]/g, (whole, digits) => {
    const token = tokens[parseInt(digits, 10)];
    if (token === undefined) return PROTECTED_DOLLAR + whole.slice(1);
    used = true;
    return wrap(token);
  });
  text = text.replace(/\$(\d+)(?!\w)/g, (whole, digits) => {
    const token = tokens[parseInt(digits, 10)];
    if (token === undefined) return whole;
    used = true;
    return wrap(token);
  });
  text = text.replaceAll('$ARGUMENTS', () => { used = true; return wrap(args); });
  if (!used && appendIfUnused && args) text += `\n\nARGUMENTS: ${wrap(args)}`;
  return text.replaceAll(PROTECTED_DOLLAR, '$').replaceAll(VALUE_FENCE, '');
}
