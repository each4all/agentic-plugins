// Runbook argument transport (ADR-0059): the args file and its grammars.
//
// The host substitutes a slash command's argument text into the runbook
// markdown before the model reads it. Spliced into a shell line, that text
// was truncated at `;`, expanded at `$(…)`, redirected at `>` and cut off at
// an apostrophe, and the worst of those exited zero. The runbooks no longer
// put it in shell source. The model writes it into an args file with its
// file-writing tool, and the CLI reads it with `--args-file <path>`. No shell
// sees the text on the way in, so none can damage it.
//
// This module is the reader of that file and the three grammars that turn its
// text into what each CLI's existing parser already takes:
//
//   - tokenizeRuntimeArguments — the runtime commands' subcommands and option
//     values, some of which are prose (ADR-0059 Decision 5);
//   - splitPersonaArguments — leading flags plus one intact body, for the
//     persona `decide` parsers (Decision 3);
//   - extractStartArguments — `/engineer:start`, whose `--base-branch` may sit
//     inside the free-text description (Decision 7).
//
// The file names a format, not a writer (Decision 4): any producer that emits
// it is acceptable, which is what lets a future hook producer replace the
// model's writing step without touching a consumer (Decision 6).
//
// The reader also removes the file once it has read it, when the runbook's
// own `mktemp -d` step created it (see "Removing what was read" below), so no
// runbook line has to run `rm`.
//
// Byte-identical copies ship in plugins/{runtime,engineer,designer,founder}/
// scripts/lib/args-file.mjs, because each package is installed on its own;
// tests/plugin-shape/test-args-file-transport.mjs fails when they differ.
// Library only — no CLI entry.

import { lstatSync, readdirSync, readFileSync, realpathSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

export const ARGS_FILE_VERSION = 1;
// Far above any argument string a person types (the largest recorded topic is
// about 5 KB). The cap exists so a mistaken path cannot pull a large file
// into argv.
export const ARGS_FILE_MAX_BYTES = 1024 * 1024;

export class ArgsFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArgsFileError';
  }
}

// A problem with the file or the option names the option; a problem with the
// text inside names the arguments, which is what the person typed.
const fail = (message) => {
  throw new ArgsFileError(`--args-file: ${message}`);
};
const refuse = (message) => {
  throw new ArgsFileError(`arguments: ${message}`);
};

// Text from the file or the command line is quoted into messages that reach a
// terminal, where a control character or line separator in it could forge or
// erase a line. Each one is shown as its code point instead.
const UNSAFE_IN_MESSAGE = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
const shown = (text) => String(text).replace(UNSAFE_IN_MESSAGE,
  (c) => `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`);

// ── The file ────────────────────────────────────────────────────────────────
//
// {"agentic_args": 1, "text": "<the argument text, exactly as typed>"}
//
// JSON rather than raw text: a JSON string keeps the argument's own trailing
// newlines apart from the file's formatting newline, which raw text cannot —
// a raw capture cannot tell an empty argument from a single newline
// (Decision 2). Every malformed shape fails here, explicitly; nothing is
// repaired or guessed.

/** The file's content for `text` — what a producer writes. */
export function encodeArgsFile(text) {
  if (typeof text !== 'string') throw new TypeError('encodeArgsFile expects a string');
  return `${JSON.stringify({ agentic_args: ARGS_FILE_VERSION, text })}\n`;
}

/** The argument text carried by the file's bytes. */
export function decodeArgsFile(bytes) {
  if (bytes.length > ARGS_FILE_MAX_BYTES) fail(`the file is ${bytes.length} bytes; the limit is ${ARGS_FILE_MAX_BYTES}`);
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('the file is not valid UTF-8');
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    fail(`the file is not valid JSON (${shown(error.message)})`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('the file must hold a JSON object {"agentic_args": 1, "text": "…"}');
  }
  if (!Object.hasOwn(value, 'agentic_args')) fail('the file has no "agentic_args" version field');
  if (value.agentic_args !== ARGS_FILE_VERSION) {
    // Only a primitive is quoted: a deeply nested value would overflow the
    // stack in JSON.stringify and escape as a RangeError, not a refusal.
    const version = value.agentic_args;
    const named = version === null || typeof version !== 'object' ? shown(JSON.stringify(version)) : `of type ${Array.isArray(version) ? 'array' : 'object'}`;
    fail(`version ${named} is not supported; this reader accepts ${ARGS_FILE_VERSION}`);
  }
  const extra = Object.keys(value).filter((key) => key !== 'agentic_args' && key !== 'text');
  if (extra.length > 0) fail(`unexpected field${extra.length > 1 ? 's' : ''} ${extra.map((k) => JSON.stringify(k)).join(', ')}`);
  if (!Object.hasOwn(value, 'text')) fail('the file has no "text" field');
  if (typeof value.text !== 'string') fail('"text" must be a string');
  // A lone surrogate is not text; handed to a process it would become U+FFFD.
  if (!value.text.isWellFormed()) fail('"text" holds a lone surrogate, which is not well-formed Unicode');
  // Command-line arguments cannot carry NUL, and this text stands in for them.
  if (value.text.includes('\x00')) fail('"text" holds a NUL character, which no command-line argument can carry');
  return value.text;
}

/**
 * The argument text in the args file at `path`. When the runbook's `mktemp -d`
 * step created the file, it is removed with its directory once read, whether
 * or not the text is valid.
 */
export function readArgsFile(path, { warn = (line) => process.stderr.write(line) } = {}) {
  if (typeof path !== 'string' || path === '') fail('no path was given');
  let bytes;
  try {
    let stats;
    try {
      stats = statSync(path);
    } catch (error) {
      fail(error.code === 'ENOENT' ? `no file at ${shown(path)}` : `cannot read ${shown(path)} (${shown(error.code ?? error.message)})`);
    }
    if (!stats.isFile()) fail(`${shown(path)} is not a regular file`);
    if (stats.size > ARGS_FILE_MAX_BYTES) fail(`the file is ${stats.size} bytes; the limit is ${ARGS_FILE_MAX_BYTES}`);
    try {
      bytes = readFileSync(path);
    } catch (error) {
      fail(`cannot read ${shown(path)} (${shown(error.code ?? error.message)})`);
    }
  } finally {
    removeReadArgsFile(path, { warn });
  }
  return decodeArgsFile(bytes);
}

// ── Removing what was read ──────────────────────────────────────────────────
//
// The runbook makes a directory with `mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"`
// and the model writes args.json into it; each block reads its file once. The
// runbook used to remove both with a shell trap, and that `rm` is what Codex's
// exec policy refuses (`rm -f`) and what an owner's `Bash(rm:*)` ask rule stops
// in Claude — so the reader removes them instead (ADR-0059, amendment of
// 2026-09-29 to (f)).
//
// Only what that step created is removed: a file named args.json that is the
// only entry of a directory named agentic-args.<suffix> directly under the
// temporary directory, neither of them a symbolic link, and the very file the
// reader opened. The path is normalized before any of that is checked. Any
// other path is read and left where it is, so a caller who names a file of
// their own never loses it. A directory that matches but holds anything else is left whole, with a
// warning, as the trap did. The directory is removed with rmdir, never as a
// tree.

const OWNED_DIRECTORY = /^agentic-args\.[A-Za-z0-9]{6,}$/;

const realOrNull = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/** The directories `mktemp -d "${TMPDIR:-/tmp}/…"` can have used, resolved. */
function temporaryRoots() {
  const roots = new Set();
  for (const candidate of [process.env.TMPDIR, tmpdir(), '/tmp']) {
    if (typeof candidate !== 'string' || candidate === '') continue;
    const real = realOrNull(candidate);
    if (real) roots.add(real);
  }
  return roots;
}

/**
 * Remove the args file at `path` and its directory when the runbook's
 * `mktemp -d` step created them; otherwise leave the path alone. Returns
 * 'removed', 'not-owned' or 'kept' (owned, but it could not be removed).
 */
export function removeReadArgsFile(path, { warn = (line) => process.stderr.write(line) } = {}) {
  if (typeof path !== 'string' || path === '') return 'not-owned';
  // resolve() drops a doubled or trailing separator and every `.` and `..`.
  // Without it, `<dir>//args.json` names its directory `<dir>/`, and lstat of
  // a path ending in a separator follows a symbolic link to a directory.
  const file = resolve(path);
  if (basename(file) !== 'args.json') return 'not-owned';
  const directory = dirname(file);
  if (!OWNED_DIRECTORY.test(basename(directory))) return 'not-owned';
  let directoryStats;
  let fileStats;
  try {
    directoryStats = lstatSync(directory);
    fileStats = lstatSync(file);
  } catch {
    return 'not-owned';
  }
  if (!directoryStats.isDirectory() || !fileStats.isFile()) return 'not-owned';
  const parent = realOrNull(dirname(directory));
  if (parent === null || !temporaryRoots().has(parent)) return 'not-owned';
  // The file the reader opened — `path` as the operating system resolves it —
  // must be the one about to be removed. resolve() folds `..` by spelling, so
  // a `..` after a symbolic link would otherwise read one file and name
  // another; realpathSync folds it the same way, so the check compares the two
  // files themselves.
  let opened;
  try {
    opened = statSync(path);
  } catch {
    return 'not-owned';
  }
  if (opened.dev !== fileStats.dev || opened.ino !== fileStats.ino) return 'not-owned';
  let entries;
  try {
    entries = readdirSync(directory);
  } catch (error) {
    warn(`⚠ --args-file: could not remove ${shown(directory)} (${shown(error.code ?? error.message)})\n`);
    return 'kept';
  }
  if (entries.length !== 1) {
    warn(`⚠ --args-file: left ${shown(directory)} in place; it holds files other than args.json\n`);
    return 'kept';
  }
  try {
    unlinkSync(file);
    rmdirSync(directory);
  } catch (error) {
    warn(`⚠ --args-file: could not remove ${shown(directory)} (${shown(error.code ?? error.message)})\n`);
    return 'kept';
  }
  return 'removed';
}

// ── Locating the option ─────────────────────────────────────────────────────

const OPTION = '--args-file';
const isArgsFileToken = (token) => token === OPTION || token.startsWith(`${OPTION}=`);

/**
 * Where `--args-file` sits in `argv`: `{ index, width, path }`, or null when
 * it is absent. `--args-file <path>` and `--args-file=<path>` are both read;
 * a repeated or valueless option fails.
 */
export function findArgsFileOption(argv) {
  let found = null;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!isArgsFileToken(token)) continue;
    if (found) fail('the option was given more than once');
    if (token === OPTION) {
      if (i + 1 >= argv.length) fail('the option needs a path');
      found = { index: i, width: 2, path: argv[i + 1] };
      i += 1;
    } else {
      found = { index: i, width: 1, path: token.slice(OPTION.length + 1) };
    }
    if (found.path === '') fail('the option needs a path');
  }
  return found;
}

// ── Grammar 1: runtime commands (Decision 5) ────────────────────────────────
//
// The words of a POSIX shell command line, with every expansion removed:
//
//   - space, tab, CR and LF outside quotes separate words; other whitespace
//     (NBSP, ideographic space) is part of a word;
//   - '…' is literal text;
//   - "…" is literal text, except that a backslash before " \ $ or ` stands
//     for that character and a backslash before a newline removes both;
//   - outside quotes a backslash stands for the character after it, and a
//     backslash before a newline removes both;
//   - pieces of one word join: --summary="a b" is the word `--summary=a b`;
//   - `*`, `?`, `[`, `{`, `!` and `=` are ordinary characters.
//
// A shell would act on the characters below instead of passing them through.
// Rather than reinterpret them, the grammar refuses them outside quotes and
// says so; quoting them gives the literal text:
//
//   ; & | < > ( )      operators
//   `                  command substitution
//   $ before a name, digit, {, (, or one of @*#?$!-      expansions
//   # or ~ starting a word                                comment, home dir

const SEPARATORS = new Set([' ', '\t', '\n', '\r']);
const OPERATORS = new Set([';', '&', '|', '<', '>', '(', ')']);
const EXPANDS_AFTER_DOLLAR = /[A-Za-z_0-9{(@*#?$!-]/;
const DQ_ESCAPABLE = new Set(['"', '\\', '$', '`']);

/** The argv the runtime grammar reads from `text`. */
export function tokenizeRuntimeArguments(text) {
  const words = [];
  let word = '';
  let inWord = false;
  const at = (i) => `at character ${i + 1}`;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (SEPARATORS.has(c)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
      i += 1;
      continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) refuse(`a single quote opened ${at(i)} is never closed`);
      word += text.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      const open = i;
      i += 1;
      for (;;) {
        if (i >= text.length) refuse(`a double quote opened ${at(open)} is never closed`);
        const d = text[i];
        if (d === '"') { i += 1; break; }
        if (d === '\\' && i + 1 < text.length && DQ_ESCAPABLE.has(text[i + 1])) { word += text[i + 1]; i += 2; continue; }
        if (d === '\\' && text[i + 1] === '\n') { i += 2; continue; }
        word += d;
        i += 1;
      }
      inWord = true;
      continue;
    }
    if (c === '\\') {
      if (i + 1 >= text.length) refuse(`a backslash ${at(i)} ends the text with nothing to escape`);
      if (text[i + 1] === '\n') { i += 2; continue; }
      word += text[i + 1];
      inWord = true;
      i += 2;
      continue;
    }
    if (OPERATORS.has(c)) refuse(`an unquoted '${c}' ${at(i)} is a shell operator, and no shell runs here; quote it to pass it as text`);
    if (c === '`') refuse(`an unquoted backquote ${at(i)} would run a command in a shell; quote it to pass it as text`);
    if (c === '$' && i + 1 < text.length && EXPANDS_AFTER_DOLLAR.test(text[i + 1])) {
      refuse(`an unquoted '$${text[i + 1]}' ${at(i)} would be expanded by a shell; quote it with '…' to pass it as text`);
    }
    if (!inWord && c === '#') refuse(`an unquoted '#' ${at(i)} starts a comment in a shell; quote it to pass it as text`);
    if (!inWord && c === '~') refuse(`an unquoted '~' ${at(i)} is a home directory in a shell; write the path out, or quote it to pass it as text`);
    word += c;
    inWord = true;
    i += 1;
  }
  if (inWord) words.push(word);
  return words;
}

/**
 * `argv` with its `--args-file <path>` replaced, in place, by the words the
 * runtime grammar reads from that file. Without the option, `argv` is
 * returned unchanged (as a copy). `read` is the file reader, for tests.
 */
export function expandArgsFile(argv, { read = readArgsFile } = {}) {
  const option = findArgsFileOption(argv);
  if (!option) return [...argv];
  const words = tokenizeRuntimeArguments(read(option.path));
  if (words.some(isArgsFileToken)) fail('an args file cannot name another args file');
  return [...argv.slice(0, option.index), ...words, ...argv.slice(option.index + option.width)];
}

// ── Grammar 2: persona decide (Decision 3) ──────────────────────────────────
//
// Leading flags, then one body. A flag is a word (a maximal run of anything
// but space, tab, CR and LF) that starts with `--`; the first word that does
// not, or the word after a lone `--`, starts the body.
//
//   - Text that starts with no flag and no `--` is its own body, byte for
//     byte, leading whitespace included.
//   - Otherwise the body is the text after the flags (and the `--`, if any)
//     and the one run of whitespace that separates them from it.
//
// The parsers already take `--` plus one intact body, so nothing in the body
// is split, joined or unquoted. Flag values are bare (`--size=minor`); a quote
// or backslash in a flag word fails rather than being read as quoting.

const isSeparator = (c) => SEPARATORS.has(c);

/** `{ flags, body }` for a persona argument string. */
export function splitPersonaArguments(text) {
  const flags = [];
  let i = 0;
  for (;;) {
    let start = i;
    while (start < text.length && isSeparator(text[start])) start += 1;
    if (start >= text.length) return { flags, body: flags.length === 0 ? text : '' };
    let end = start;
    while (end < text.length && !isSeparator(text[end])) end += 1;
    const word = text.slice(start, end);
    if (word === '--') {
      let body = end;
      while (body < text.length && isSeparator(text[body])) body += 1;
      return { flags, body: text.slice(body) };
    }
    if (!word.startsWith('--')) return { flags, body: flags.length === 0 ? text : text.slice(start) };
    if (/["'\\]/.test(word)) refuse(`the flag ${shown(word)} holds a quote or backslash; flags take a bare value, as in --size=minor`);
    flags.push(word);
    i = end;
  }
}

/** The argv a persona parser takes for `text`: `[...flags, "--", body]`. */
export function personaArgv(text) {
  const { flags, body } = splitPersonaArguments(text);
  return [...flags, '--', body];
}

/**
 * The persona CLIs take the args file as their only arguments. Returns the
 * file's path, or null when `argv` does not start with `--args-file`. Only
 * the first argument is looked at: after it, the persona grammar's flags and
 * body begin, and `resolve -- --args-file` names a body, not a file.
 */
export function soleArgsFilePath(argv) {
  if (argv.length === 0 || !isArgsFileToken(argv[0])) return null;
  const option = findArgsFileOption(argv.slice(0, argv[0] === OPTION ? 2 : 1));
  if (argv.length !== option.width) fail('the option cannot be combined with other arguments; put them in the file');
  return option.path;
}

// ── Grammar 3: /engineer:start (Decision 7) ─────────────────────────────────
//
// A feature description with at most one `--base-branch <ref>`, which may
// appear anywhere in it:
//
//   - the option is the word `--base-branch` (a word as above) and its value
//     is the next word; the `--base-branch=<ref>` spelling fails;
//   - the value may be wrapped in one pair of matching quotes, which are
//     removed; a quote or backslash left inside it, a leading `-`, or no value
//     at all fails, and so does a second `--base-branch`;
//   - the option, its value and the whitespace separating them from the
//     description are removed; every other byte of the description stays, and
//     the description starts at its first non-whitespace character;
//   - a description with nothing but whitespace fails.
//
// A description that has to mention the option names it quoted
// ("--base-branch"), which is not the option word.

const WORD = /[^ \t\r\n]+/g;

/** `{ baseBranch, baseBranchExplicit, feature }` for a start argument string. */
export function extractStartArguments(text, { defaultBaseBranch = 'origin/main' } = {}) {
  const words = [...text.matchAll(WORD)].map((m) => ({ start: m.index, end: m.index + m[0].length, text: m[0] }));
  const at = [];
  for (let k = 0; k < words.length; k += 1) {
    if (words[k].text === '--base-branch') at.push(k);
    else if (words[k].text.startsWith('--base-branch=')) refuse(`write --base-branch <ref>, not ${shown(words[k].text)}`);
  }
  if (at.length > 1) refuse(`--base-branch was given ${at.length} times; give it once`);
  let rest = text;
  let baseBranch = defaultBaseBranch;
  if (at.length === 1) {
    const k = at[0];
    const value = words[k + 1];
    if (!value || value.text.startsWith('-')) refuse('--base-branch needs a ref after it');
    let ref = value.text;
    if (ref.length >= 2 && (ref[0] === '"' || ref[0] === "'") && ref.at(-1) === ref[0]) ref = ref.slice(1, -1);
    if (ref === '') refuse('--base-branch was given an empty ref');
    if (/["'\\]/.test(ref)) refuse(`the --base-branch value ${shown(value.text)} holds a quote or backslash, which a git ref cannot contain`);
    if (ref.startsWith('-')) refuse(`the --base-branch value ${shown(value.text)} starts with '-', which a git ref cannot`);
    baseBranch = ref;
    const next = words[k + 2];
    const previous = words[k - 1];
    const cutStart = next ? words[k].start : (previous ? previous.end : 0);
    const cutEnd = next ? next.start : text.length;
    rest = text.slice(0, cutStart) + text.slice(cutEnd);
  }
  let begin = 0;
  while (begin < rest.length && isSeparator(rest[begin])) begin += 1;
  const feature = rest.slice(begin);
  if (feature === '') refuse('/engineer:start needs a feature description');
  return { baseBranch, baseBranchExplicit: at.length === 1, feature };
}
