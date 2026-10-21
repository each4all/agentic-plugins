// plugins/orchestrator/adapters/claude/autopilot/verify-select.mjs
//
// ADR-0068 Decision 5, item 4 — the checks the driver adds before a
// verification batch. Given a lane's changed paths, it selects every test that
// may read a changed file, and each declared check whose `adds_on` globs a
// changed file matches. It adds; it never drops a check the worker asked for.
//
// The selection reads the tree as text and never imports a file of it: the
// lane's tree is not the installed orchestrator's code. Its rules:
//
// - Every change counts (`collectChanges`): committed or not, tracked or
//   untracked, added, modified or deleted, a submodule whatever its ignore
//   setting; a file git hides by an index flag (assume-unchanged,
//   skip-worktree) throws. Renames are not detected, so a rename counts as its
//   old path deleted and its new path added. A persona-pipeline source counts
//   as every copy generated from it, and a copy as its sources and their other
//   copies (`pipelineMap`). The generator, the modules it loads, the files
//   they may read (every file of the plugins it walks for markers) and each
//   persona's declaration are pipeline inputs too: a change to one adds the
//   pipeline's own check.
// - A test is selected for a file when the file is in the test's import
//   closure, or when a module of that closure may read it (`mayRead`): its text
//   names the file's path or a suffix of two segments or more; its string
//   literals cover the path segment by segment, with at most one free segment;
//   or it walks or copies a directory one literal names in two segments or
//   more (every file under it), or one a walk takes whole (`join(ROOT,
//   'plugins')` in the walk's arguments, or assigned to a name it takes): a
//   tree walk reads every file under that one, a plain readdir the files
//   directly in it. Only executable
//   references are edges of the closure (imports, requires, `new URL(…,
//   import.meta.url)`, the runner's preloads, and, from a module that makes a
//   computed import or starts a process or worker, each JavaScript module its
//   string literals name, or, for a computed import, each module of a
//   directory one literal names): a comment, or a module naming a file it
//   never loads, is never one. A loader anywhere in a test's closure (a
//   helper that starts what it is handed) loads what the test and its other
//   test-side modules name. An import the tree no longer resolves resolves
//   against the fork point, so a deleted file keeps its importers.
// - A mutation spec that anchors a changed file selects the tests it names, and
//   becomes a trigger of the kinds whose `adds_on` match it. Its anchors are
//   what it and the modules it imports may read, never what the tests it
//   runs, the other specs or the tools it starts read.
// - The declaration's mappings add tests, or the suite, for the paths they
//   match. A kind whose `adds_on` a change matches is added whole, or the
//   selection throws.
// - No match never means no relevant tests: a changed file no test is selected
//   for by evidence selects the whole suite, as do package.json (the runner's
//   own configuration), a pipeline path while the pipeline map does not parse,
//   a test the `test` kind cannot carry, and the `test` kind added with no
//   file. A module the tokenizer cannot read with certainty (a literal left
//   open, a `/` after `}` that may open a regular expression), or cannot
//   read at all, selects the tests that reach it for every change, and what
//   it reads is no match. One match cancels a fallback while another
//   reading of the same file is unresolved, as ADR-0068 D5 item 4 accepts.
//
// A thrown error means "no selection": the caller never treats it as an empty
// one. Readers cache what they read: a selection takes fresh readers. Its
// imports are Node built-ins only, so the installed driver loads it from its
// own plugin copy.

import { execFileSync } from 'node:child_process';
import { globSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Node 24's default `node --test` pattern (scripts/lib/discover-tests.mjs,
// whose parity test runs a real `node --test`); test-verify-select.mjs checks
// that this copy matches it.
export const DEFAULT_TEST_PATTERN = '**/{test,test/**/*,test-*,*[._-]test}.{js,mjs,cjs,ts,mts,cts}';

// The rules' constants. Each is a decision the tests pin with a mutation.
export const FREE_SEGMENTS = 1;          // R4(b): at most one segment a variable fills
export const MIN_SUFFIX_SEGMENTS = 2;    // R4(a): a named suffix of two segments or more
export const MIN_DIR_SEGMENTS = 2;       // R4(c): a directory one literal names in two segments or more
export const MAX_LISTED = 200;           // R10: reasons and widenings kept in the result
export const MAX_TEST_FILES = 400;       // the declaration's limit on one slot's values

export const PIPELINE_MANIFEST = 'persona-pipeline/manifest.json';
export const PIPELINE_OWNED = 'persona-pipeline/owned.json';
// The pipeline's other inputs: the generator (with every module it loads) and
// each persona's declaration, which its check validates.
export const PIPELINE_GENERATOR = 'scripts/sync-persona-pipeline.mjs';
const PERSONA_DECLARATION = /^plugins\/[^/]+\/persona\.json$/;
const MANIFEST_SCHEMA = 'persona-pipeline-manifest-1.0';
const OWNED_SCHEMA = 'persona-pipeline-owned-1.0';
const SPEC_DIR = 'scripts/mutation-specs/';
const RUNNER_CONFIG = 'package.json';

const JS_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'];
const RESOLVE_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.json'];
// The calls whose arguments build a path, and the calls that read a whole
// directory (R4(b) evidence, R4(c)).
const PATH_CALLS = new Set(['join', 'resolve']);
const DIR_CALLS = new Set(['readdir', 'readdirSync', 'opendir', 'opendirSync', 'glob', 'globSync', 'cp', 'cpSync', 'walk']);
// A walk the module defines itself (`walkFiles`, `walkDir`) reads a directory too.
const isDirCall = (name) => DIR_CALLS.has(name) || /^walk[A-Z]/.test(name);
// The calls that read a whole tree, where a plain readdir reads one level.
const DEEP_CALLS = new Set(['cp', 'cpSync', 'glob', 'globSync', 'walk']);
// The words that start a statement: an assignment's expression ends there.
const STATEMENT_WORDS = new Set(['const', 'let', 'var', 'function', 'class', 'import', 'export', 'if', 'for', 'while', 'return', 'throw']);
// The calls that run a module in another process or thread (R5): a module
// that makes one loads the JavaScript modules its literals name.
const SPAWN_CALLS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'execSync', 'fork', 'Worker']);
// After these, a `/` starts a regular expression, never a division.
const REGEX_AFTER_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'extends']);
// After these, a `)` closes a condition, and a `/` starts a regular expression.
const CONTROL_WORDS = new Set(['if', 'while', 'for', 'with']);
const HOLE = '\u0000';
const SIMPLE_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '' };

// The text an escape at text[j] (a backslash) stands for, and its length; the
// text is null for an escape the tokenizer cannot decode.
function escapeAt(text, j) {
  const e = text[j + 1];
  if (e === undefined) return [null, 1];
  if (e === '\r' && text[j + 2] === '\n') return ['', 3];
  if (e === '\n' || e === '\r' || e === '\u2028' || e === '\u2029') return ['', 2];
  if (e === 'x') {
    const h = /^[0-9A-Fa-f]{2}/.exec(text.slice(j + 2, j + 4));
    return h ? [String.fromCharCode(parseInt(h[0], 16)), 4] : [null, 2];
  }
  if (e === 'u') {
    const braced = /^\{([0-9A-Fa-f]{1,6})\}/.exec(text.slice(j + 2, j + 10));
    if (braced) {
      const cp = parseInt(braced[1], 16);
      return cp <= 0x10ffff ? [String.fromCodePoint(cp), 2 + braced[0].length] : [null, 2];
    }
    const h = /^[0-9A-Fa-f]{4}/.exec(text.slice(j + 2, j + 6));
    return h ? [String.fromCharCode(parseInt(h[0], 16)), 6] : [null, 2];
  }
  return [Object.hasOwn(SIMPLE_ESCAPES, e) ? SIMPLE_ESCAPES[e] : e, 2];
}

const fail = (msg) => { throw new Error(`verify-select: ${msg}`); };
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isJs = (p) => JS_EXTS.includes(path.posix.extname(p));
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** A repository-relative POSIX path: no leading `/`, no empty, `.` or `..` segment. */
export function safeRelPath(p) {
  return typeof p === 'string' && p !== '' && !p.startsWith('/') && !p.includes('\0')
    && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// -----------------------------------------------------------------------------
// Git, with an environment that carries no GIT_* variable (an inherited
// GIT_DIR or GIT_INDEX_FILE would answer for another repository) and with
// replace objects ignored.

function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.toUpperCase().startsWith('GIT_')) env[k] = v;
  return env;
}

function git(cwd, args, { input, buffer = false } = {}) {
  return execFileSync('git', ['--no-replace-objects', ...args], {
    cwd, env: gitEnv(), input, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'],
    ...(buffer ? {} : { encoding: 'utf8' }),
  });
}

const splitZ = (out) => out.split('\0').filter((s) => s !== '');

function topLevel(cwd) {
  return git(cwd, ['rev-parse', '--show-toplevel']).replace(/\n$/, '');
}

/**
 * Every change of the lane against `base` (R1): `git diff` from `base` to the
 * working tree (committed, staged and unstaged) and the untracked files that
 * are not ignored, or, with `head`, from `base` to that commit. Returns
 * `[{path, status, old?}]` sorted by path: status A, M, D, or U (untracked);
 * a deleted path is `old`. Throws when git fails, and when git would hide a
 * change of the working tree: a file marked assume-unchanged or
 * skip-worktree. A submodule's ignore setting is overridden.
 */
export function collectChanges({ cwd, base, head = null }) {
  if (typeof cwd !== 'string' || typeof base !== 'string' || base === '') fail('collectChanges takes {cwd, base}');
  const top = topLevel(cwd);
  const range = head === null ? [base] : [base, head];
  if (head === null) {
    // `ls-files -v` tags an assume-unchanged file in lower case and a
    // skip-worktree file `S`: git diff reports neither file's edits.
    for (const entry of splitZ(git(top, ['ls-files', '-v', '-z', '--cached', '--full-name']))) {
      const tag = entry[0];
      if (tag === 'S' || (tag >= 'a' && tag <= 'z')) fail(`${entry.slice(2)} is marked assume-unchanged or skip-worktree, so git hides its changes`);
    }
  }
  const out = splitZ(git(top, ['diff', '-z', '--name-status', '--no-renames', '--no-ext-diff', '--no-relative', '--ignore-submodules=none', ...range, '--']));
  const changes = [];
  for (let i = 0; i < out.length; i += 2) {
    const code = out[i][0];
    const p = out[i + 1];
    if (p === undefined) fail(`git diff printed a status with no path (${JSON.stringify(out[i])})`);
    const status = code === 'A' || code === 'D' ? code : 'M';
    changes.push(status === 'D' ? { path: p, status, old: true } : { path: p, status });
  }
  if (head === null) {
    for (const p of splitZ(git(top, ['ls-files', '-z', '--others', '--exclude-standard', '--full-name']))) {
      changes.push({ path: p, status: 'U' });
    }
  }
  return changes.sort((a, b) => byText(a.path, b.path) || byText(a.status, b.status));
}

// -----------------------------------------------------------------------------
// Readers: `{list(): string[], read(path): string|null, tests?(): string[]}`.
// `list` is sorted POSIX paths; `read` is a file's text, or null when it is
// not a readable regular file.

/** A reader over `{path: text}`, for tests. */
export function memoryReader(files) {
  const map = new Map(Object.entries(files));
  const list = [...map.keys()].sort(byText);
  return { list: () => list, read: (p) => (map.has(p) ? map.get(p) : null) };
}

/**
 * The lane's tree on disk: tracked and untracked files that are not ignored,
 * and every file Node's test discovery sees (it does not read .gitignore).
 */
export function diskReader(root) {
  const top = topLevel(root);
  const tracked = splitZ(git(top, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--full-name']));
  const tests = discoverOnDisk(top);
  // A file as Node opens it: a link to a file counts, and an ignored file the
  // tree imports is found by `exists`, as Node's resolution finds it.
  const isFile = (p) => {
    if (!safeRelPath(p)) return false;
    try { return statSync(path.join(top, p)).isFile(); } catch { return false; }
  };
  const list = [...new Set([...tracked, ...tests])].filter(isFile).sort(byText);
  const cache = new Map();
  return {
    root: top,
    list: () => list,
    tests: () => tests,
    exists: isFile,
    read(p) {
      if (cache.has(p)) return cache.get(p);
      let text = null;
      if (isFile(p)) {
        try { text = readFileSync(path.join(top, p), 'utf8'); } catch { text = null; }
      }
      cache.set(p, text);
      return text;
    },
  };
}

function discoverOnDisk(root) {
  return globSync(DEFAULT_TEST_PATTERN, { cwd: root, exclude: (name) => name === 'node_modules' })
    .map((rel) => rel.split(path.sep).join('/'))
    .sort(byText);
}

/**
 * A commit's tree, read from git objects. Every JavaScript and JSON blob is
 * read in one `git cat-file --batch`; a symbolic link or a submodule is
 * listed but reads as null.
 */
export function gitReader({ cwd, commit }) {
  const top = topLevel(cwd);
  const entries = new Map();
  for (const line of splitZ(git(top, ['ls-tree', '-r', '-z', '--full-tree', commit]))) {
    const tab = line.indexOf('\t');
    const [mode, type, oid] = line.slice(0, tab).split(' ');
    entries.set(line.slice(tab + 1), { mode, type, oid });
  }
  const list = [...entries.keys()].sort(byText);
  const texts = new Map();
  const blobOf = (p) => {
    const e = entries.get(p);
    return e && e.type === 'blob' && (e.mode === '100644' || e.mode === '100755') ? e.oid : null;
  };
  const wanted = list.filter((p) => (isJs(p) || p.endsWith('.json')) && blobOf(p) !== null);
  if (wanted.length > 0) {
    const out = git(top, ['cat-file', '--batch'], { input: `${wanted.map(blobOf).join('\n')}\n`, buffer: true });
    let at = 0;
    for (const p of wanted) {
      const nl = out.indexOf(10, at);
      const header = out.subarray(at, nl).toString('utf8').split(' ');
      if (header[1] !== 'blob') fail(`git cat-file did not return the blob of ${p}`);
      const size = Number(header[2]);
      texts.set(p, out.subarray(nl + 1, nl + 1 + size).toString('utf8'));
      at = nl + 1 + size + 1;
    }
  }
  return {
    list: () => list,
    read(p) {
      if (texts.has(p)) return texts.get(p);
      const oid = blobOf(p);
      const text = oid === null ? null : git(top, ['cat-file', 'blob', oid]);
      texts.set(p, text);
      return text;
    },
  };
}

/** The test files Node discovers in a reader's tree. */
export function discoverTests(reader) {
  if (typeof reader.tests === 'function') return reader.tests();
  return reader.list().filter((p) => !p.split('/').includes('node_modules') && path.posix.matchesGlob(p, DEFAULT_TEST_PATTERN));
}

// -----------------------------------------------------------------------------
// The tokenizer: string and template literals (a template's `${…}` is a hole),
// identifiers and punctuation, with comments and regular expressions skipped.
// A literal left open, or a regular expression with no end where nothing else
// may stand, makes the module uncertain.

// JavaScript's line terminators, which end a line comment, a string and a
// regular expression, and its white space.
const LINE_TERMINATORS = new Set(['\n', '\r', '\u2028', '\u2029']);
const isSpace = (c) => c === ' ' || c === '\t' || c === '\f' || c === '\v' || LINE_TERMINATORS.has(c)
  || (c > '\u007f' && /[\s\ufeff]/u.test(c));

// The index of the line terminator that ends the line at `i`, or the text's end.
function lineEnd(text, i) {
  let j = i;
  while (j < text.length && !LINE_TERMINATORS.has(text[j])) j += 1;
  return j;
}

export function tokenize(text) {
  const tokens = [];
  const holes = [];     // per open template hole: [template token, brace depth]
  const parens = [];    // per open `(`: the identifier before it, or null
  let uncertain = false;
  let i = 0;
  const n = text.length;
  const prev = () => tokens[tokens.length - 1];
  // Each token's bracket depth (`d`), and, for a literal or a name, the calls
  // whose arguments it stands in (`calls`, innermost last).
  let depth = 0;
  const push = (tok) => {
    if (tok.k === 'p' && (tok.v === ')' || tok.v === ']' || tok.v === '}')) depth -= 1;
    tok.d = depth;
    if (tok.k === 's' || tok.k === 'id') tok.calls = parens.map((x) => x?.name ?? null);
    tokens.push(tok);
    if (tok.k === 'p' && (tok.v === '(' || tok.v === '[' || tok.v === '{')) depth += 1;
  };
  const callee = () => (parens.length ? parens[parens.length - 1] : null);
  // A string directly in a join/resolve call's arguments: `call` names the
  // call; `callee`, the name of the call it stands directly in.
  const stringToken = (q) => {
    const c = callee();
    return { k: 's', q, v: '', call: c !== null && PATH_CALLS.has(c.name) ? c : null, callee: c?.name ?? null };
  };

  // Appends the escape at `j` to a literal; one it cannot decode makes the
  // module uncertain. A decoded NUL never stands for a hole.
  const escaped = (tok, j) => {
    const [value, len] = escapeAt(text, j);
    if (value === null) uncertain = true;
    else tok.v += value.replaceAll(HOLE, '\ufffd');
    return j + len;
  };

  // Reads a template's text from `j` up to its end or its next hole.
  const templateChunk = (tok, j) => {
    while (j < n) {
      const c = text[j];
      if (c === '\\') { j = escaped(tok, j); continue; }
      if (c === '`') return { end: j + 1, closed: true };
      if (c === '$' && text[j + 1] === '{') {
        tok.v += HOLE;
        holes.push([tok, 0]);
        return { end: j + 2, closed: false };
      }
      tok.v += c;
      j += 1;
    }
    uncertain = true;
    return { end: n, closed: true };
  };

  if (text.startsWith('#!')) i = lineEnd(text, 0);
  while (i < n) {
    const c = text[i];
    if (isSpace(c)) { i += 1; continue; }
    if (c === '/' && text[i + 1] === '/') { i = lineEnd(text, i); continue; }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      if (e < 0) { uncertain = true; break; }
      i = e + 2;
      continue;
    }
    if (c === '\'' || c === '"') {
      const tok = stringToken(c);
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const d = text[j];
        if (d === '\\') { j = escaped(tok, j); continue; }
        if (d === c) { closed = true; j += 1; break; }
        if (d === '\n' || d === '\r') break;
        tok.v += d;
        j += 1;
      }
      if (!closed) uncertain = true;
      push(tok);
      i = j;
      continue;
    }
    if (c === '`') {
      const tok = stringToken('`');
      push(tok);
      i = templateChunk(tok, i + 1).end;
      continue;
    }
    if (c === '{') {
      if (holes.length) holes[holes.length - 1][1] += 1;
      push({ k: 'p', v: c });
      i += 1;
      continue;
    }
    if (c === '}') {
      if (holes.length && holes[holes.length - 1][1] === 0) {
        const [tok] = holes.pop();
        i = templateChunk(tok, i + 1).end;
        continue;
      }
      if (holes.length) holes[holes.length - 1][1] -= 1;
      push({ k: 'p', v: c });
      i += 1;
      continue;
    }
    if (c === '(') { const p = prev(); parens.push(p && p.k === 'id' ? { name: p.v } : null); push({ k: 'p', v: c }); i += 1; continue; }
    if (c === ')') { const o = parens.pop(); push({ k: 'p', v: c, opener: o?.name ?? null }); i += 1; continue; }
    if (c === '/') {
      const p = prev();
      const pp = tokens[tokens.length - 2];
      // After a postfix `++`/`--` a `/` is a division (an operand ends there).
      // After a `}` it may end a block before a regular expression or an
      // object before a division: the text cannot tell.
      const postfix = p !== undefined && p.k === 'p' && (p.v === '+' || p.v === '-') && pp !== undefined && pp.k === 'p' && pp.v === p.v;
      const ambiguous = p !== undefined && p.k === 'p' && p.v === '}';
      // A word after `.` is a property (`obj.in / 2`), never the operator.
      const property = pp !== undefined && pp.k === 'p' && pp.v === '.';
      const regex = !postfix && (p === undefined || (p.k === 'p' && p.v !== ')' && p.v !== ']') || (p.k === 'id' && REGEX_AFTER_WORDS.has(p.v) && !property)
        || (p.k === 'p' && p.v === ')' && CONTROL_WORDS.has(p.opener)));
      if (regex) {
        let j = i + 1;
        let inClass = false;
        let end = -1;
        while (j < n) {
          const d = text[j];
          if (LINE_TERMINATORS.has(d)) break;
          if (d === '\\') { j += 2; continue; }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) { end = j; break; }
          j += 1;
        }
        // An ambiguous `/` that could open a regular expression: either
        // reading may hide what the other holds (a literal, a comment, an
        // import), so it is read as a division, which keeps every literal,
        // and the module is uncertain.
        if (end >= 0 && ambiguous) {
          uncertain = true;
          end = -1;
        }
        if (end >= 0) {
          j = end + 1;
          while (j < n && /[A-Za-z]/.test(text[j])) j += 1;
          push({ k: 're' });
          i = j;
          continue;
        }
        // After an ambiguous token an open expression is a division, no
        // regular expression.
        if (!ambiguous) uncertain = true;
      }
      push({ k: 'p', v: c });
      i += 1;
      continue;
    }
    if (/[\p{ID_Start}$_]/u.test(c)) {
      let j = i + 1;
      while (j < n && /[\p{ID_Continue}$\u200c\u200d]/u.test(text[j])) j += 1;
      push({ k: 'id', v: text.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(text[j])) j += 1;
      push({ k: 'n' });
      i = j;
      continue;
    }
    push({ k: 'p', v: c });
    i += 1;
  }
  if (holes.length) uncertain = true;
  return { tokens, uncertain };
}

// -----------------------------------------------------------------------------
// One module's evidence, read once per tree.

const PATH_WORD_SPLIT = /[^\p{L}\p{N}._/@+~\u0000-]+/u;
const SEGMENT_SPLIT = /[^\p{L}\p{N}._@+~-]+/u;

function segmentPattern(seg) {
  return new RegExp(`^${seg.split(HOLE).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`, 'u');
}

// The pieces of a literal: each word of it split at `/`, its `./` and `../`
// dropped (a cover may start at any ancestor of the module's directory).
// `dirStart`: the piece may name a directory by itself (R4(c)): a literal a
// walk takes (`walked`) that has a `/`, stands alone in the walk's
// arguments, or ends a join/resolve call (`join(ROOT, 'plugins')`), never
// one argument among others (`join(home, '.claude', 'plugins', name)`).
function piecesOf(tok, { runEnd = false, walked = false, dirArg = false } = {}) {
  const pieces = [];
  for (const raw of tok.v.split(PATH_WORD_SPLIT)) {
    if (raw === '' || raw.length > 400) continue;
    const segs = raw.split('/').filter((s) => s !== '' && s !== '.' && s !== '..');
    if (segs.length === 0) continue;
    const parsed = segs.map((s) => {
      const fixed = !s.includes(HOLE);
      const holeOnly = /^\u0000+$/.test(s);
      // A basename a hole begins but a fixed extension ends (`${verb}.md`).
      const weakExt = !fixed && !holeOnly ? (/\.[A-Za-z0-9]+$/.exec(s.slice(s.lastIndexOf(HOLE) + 1))?.[0] ?? null) : null;
      return { text: s, fixed, holeOnly, weakExt, re: fixed ? null : segmentPattern(s) };
    });
    if (parsed.every((s) => s.holeOnly)) continue;
    const evidence = raw.includes('/') || tok.call !== null || dirArg;
    const dirStart = walked && (raw.includes('/') || dirArg || runEnd);
    // A leading hole is often a path another literal holds (`${AP}/policy.mjs`
    // with AP = 'plugins/…/autopilot'): the rest stands on its own too, and
    // the cover then needs pieces before it. As a directory, the hole is a
    // root (`${ROOT}/plugins`), never one free segment.
    // `up`: the `..` it starts with, which a directory it names climbs from
    // the module's own.
    const lead = parsed.findIndex((s) => !s.holeOnly);
    const up = /^(?:\.\.?\/)*/.exec(raw)[0].split('/').filter((s) => s === '..').length;
    pieces.push({ segs: parsed, evidence, dirStart: dirStart && lead === 0, up, anyFixed: parsed.some((s) => s.fixed) });
    if (lead > 0) {
      const rest = parsed.slice(lead);
      pieces.push({ segs: rest, evidence, dirStart, rootOnly: true, up: 0, anyFixed: rest.some((s) => s.fixed) });
    }
  }
  return pieces;
}

// The functions a module defines that read a directory and call themselves:
// walks of a whole tree (`function collect(dir) { … readdir(dir) …
// collect(full) }`, or the same as `const collect = (dir) => { … }`).
function recursiveWalkers(tokens) {
  const out = new Set();
  for (let t = 0; t < tokens.length; t += 1) {
    const tok = tokens[t];
    if (tok.k !== 'id' || tokens[t - 1]?.v === '.') continue;
    let defines = tokens[t - 1]?.v === 'function' && tokens[t + 1]?.v === '(';
    if (!defines && tokens[t + 1]?.v === '=' && tokens[t + 2]?.v !== '=' && tokens[t + 2]?.v !== '>') {
      let u = t + 2;
      if (tokens[u]?.v === 'async') u += 1;
      if (tokens[u]?.v === 'function') defines = true;
      else if (tokens[u]?.k === 'id' && tokens[u + 1]?.v === '=' && tokens[u + 2]?.v === '>') defines = true;
      else if (tokens[u]?.v === '(') {
        let w = u + 1;
        while (w < tokens.length && !(tokens[w].v === ')' && tokens[w].d === tokens[u].d)) w += 1;
        defines = tokens[w + 1]?.v === '=' && tokens[w + 2]?.v === '>';
      }
    }
    if (!defines) continue;
    let b = t + 1;
    while (b < tokens.length && tokens[b].v !== '{') b += 1;
    let reads = false;
    let self = false;
    for (let u = b + 1; u < tokens.length && !(tokens[u].v === '}' && tokens[u].d === tokens[b].d); u += 1) {
      const x = tokens[u];
      if (x.k !== 'id') continue;
      if (DIR_CALLS.has(x.v)) reads = true;
      if (x.v === tok.v && tokens[u + 1]?.v === '(' && tokens[u - 1]?.v !== '.') self = true;
    }
    if (reads && self) out.add(tok.v);
  }
  return out;
}

// The literals a directory walk takes: those in its arguments, and those of
// an expression assigned to a name the walk takes, directly or through other
// names (`const dir = join(ROOT, 'plugins'); walk(dir)`; `for (const r of
// ROOTS)` assigns ROOTS to r). An assignment reaches the uses in the block
// it stands in (the block of a for-of's loop). Returns the literals' token
// indexes.
function walkedLiterals(tokens, dirCall) {
  const out = new Set();
  const queue = [];
  tokens.forEach((x, i) => {
    if ((x.k === 's' || x.k === 'id') && x.calls.some(dirCall)) {
      if (x.k === 's') out.add(i);
      else queue.push([x.v, i]);
    }
  });
  if (queue.length === 0) return out;
  // The block each token stands in: the nearest token before it, and after
  // it, at a lower depth.
  const n = tokens.length;
  const low = Math.min(0, ...tokens.map((x) => x.d));
  const high = Math.max(0, ...tokens.map((x) => x.d)) - low;
  const blockStart = new Array(n);
  const blockEnd = new Array(n);
  let near = new Array(high + 2).fill(-1);
  for (let i = 0; i < n; i += 1) {
    const d = tokens[i].d - low;
    blockStart[i] = near[d];
    for (let k = d + 1; k <= high + 1; k += 1) near[k] = i;
  }
  near = new Array(high + 2).fill(n);
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = tokens[i].d - low;
    blockEnd[i] = near[d];
    for (let k = d + 1; k <= high + 1; k += 1) near[k] = i;
  }
  const byName = new Map();
  for (let t = 0; t < n; t += 1) {
    const tok = tokens[t];
    if (tok.k !== 'id' || tokens[t - 1]?.v === '.') continue;
    const nx = tokens[t + 1];
    const assign = nx?.k === 'p' && nx.v === '=' && tokens[t + 2]?.v !== '=' && tokens[t + 2]?.v !== '>';
    const forOf = nx?.k === 'id' && nx.v === 'of' && ['const', 'let', 'var'].includes(tokens[t - 1]?.v);
    if (!assign && !forOf) continue;
    let u = t + 2;
    for (; u < n; u += 1) {
      const x = tokens[u];
      if (x.d < tok.d || (x.d === tok.d && ((x.k === 'p' && (x.v === ';' || x.v === ',')) || (x.k === 'id' && STATEMENT_WORDS.has(x.v))))) break;
    }
    const scope = forOf && tokens[t - 3]?.v === 'for' ? t - 3 : t;
    if (!byName.has(tok.v)) byName.set(tok.v, []);
    byName.get(tok.v).push({ from: t + 2, to: u, after: blockStart[scope], before: blockEnd[scope] });
  }
  const done = new Set();
  while (queue.length) {
    const [name, at] = queue.pop();
    for (const a of byName.get(name) ?? []) {
      if (done.has(a) || at <= a.after || at >= a.before) continue;
      done.add(a);
      for (let u = a.from; u < a.to; u += 1) {
        if (tokens[u].k === 's') out.add(u);
        else if (tokens[u].k === 'id' && tokens[u - 1]?.v !== '.') queue.push([tokens[u].v, u]);
      }
    }
  }
  return out;
}

export function analyzeModule(text) {
  const { tokens, uncertain } = tokenize(text);
  const pieces = [];
  const imports = [];
  let computedImport = false;
  let dirRead = false;
  let spawns = false;
  // A walk the module defines (a function that reads a directory and calls
  // itself) reads a whole tree; so do the deep calls and a walk's `recursive`
  // option (never mkdir's).
  const walkers = recursiveWalkers(tokens);
  const dirCall = (name) => name !== null && (isDirCall(name) || walkers.has(name));
  const walked = walkedLiterals(tokens, dirCall);
  const deepWalk = walkers.size > 0 || tokens.some((x) => x.k === 'id' && (DEEP_CALLS.has(x.v) || /^walk[A-Z]/.test(x.v) || (x.v === 'recursive' && x.calls.some(dirCall))));
  for (let t = 0; t < tokens.length; t += 1) {
    const tok = tokens[t];
    if (tok.k === 's') {
      // Consecutive literal arguments of one join/resolve call also stand as
      // one path, so a directory they name together is one piece of it; when
      // they end the call, that path may name a directory by itself.
      const runStart = tok.call !== null && !(tokens[t - 2]?.k === 's' && tokens[t - 2].call === tok.call && tokens[t - 1]?.v === ',');
      let run = tok.v;
      let count = 1;
      let u = t + 2;
      if (runStart) {
        for (; tokens[u]?.k === 's' && tokens[u].call === tok.call && tokens[u - 1]?.v === ','; u += 2) {
          run += `/${tokens[u].v}`;
          count += 1;
        }
      }
      const runEnd = runStart && tokens[u - 1]?.k === 'p' && tokens[u - 1].v === ')';
      pieces.push(...piecesOf(tok, { runEnd: runEnd && count === 1, walked: walked.has(t), dirArg: dirCall(tok.callee) }));
      if (count > 1 && !/\s/.test(run)) pieces.push(...piecesOf({ v: run, call: tok.call }, { runEnd, walked: walked.has(t) }));
      continue;
    }
    if (tok.k !== 'id') continue;
    if (dirCall(tok.v)) dirRead = true;
    if (SPAWN_CALLS.has(tok.v)) spawns = true;
    const next = tokens[t + 1];
    const before = tokens[t - 1];
    const member = before && before.k === 'p' && before.v === '.';
    const literalCall = () => {
      const lit = tokens[t + 2];
      const after = tokens[t + 3];
      return next && next.k === 'p' && next.v === '(' && lit && lit.k === 's' && !lit.v.includes(HOLE)
        && after && after.k === 'p' && (after.v === ')' || after.v === ',') ? lit.v : null;
    };
    if (tok.v === 'from' && next && next.k === 's' && !member) {
      if (!next.v.includes(HOLE)) imports.push({ spec: next.v, kind: 'import' });
    } else if (tok.v === 'import' && !member) {
      if (next && next.k === 's') imports.push({ spec: next.v, kind: 'import' });
      else if (next && next.k === 'p' && next.v === '(') {
        const lit = literalCall();
        if (lit !== null) imports.push({ spec: lit, kind: 'import' });
        else computedImport = true;
      }
    } else if (tok.v === 'require' && !member) {
      const lit = literalCall();
      if (lit !== null) imports.push({ spec: lit, kind: 'import' });
    } else if (tok.v === 'URL' && before && before.k === 'id' && before.v === 'new') {
      const lit = literalCall();
      const meta = tokens.slice(t + 4, t + 9).map((x) => x.v).join(' ');
      if (lit !== null && meta === 'import . meta . url') imports.push({ spec: lit, kind: 'url' });
    }
  }
  // `exec` is also a regular expression's method: it starts a process only
  // in a module that loads child_process.
  if (!spawns && imports.some((x) => /^(node:)?child_process$/.test(x.spec)) && tokens.some((x) => x.k === 'id' && x.v === 'exec')) spawns = true;
  const weakExts = new Set();
  for (const p of pieces) {
    const last = p.segs[p.segs.length - 1];
    if (last.weakExt && p.anyFixed) weakExts.add(last.weakExt);
  }
  // The literals as decoded: an escaped name (`'data/value.json'`) is
  // named by its value, which the source text does not hold.
  const literalText = tokens.filter((tok) => tok.k === 's').map((tok) => tok.v).join('\n');
  const literalSegments = new Set(literalText.split(SEGMENT_SPLIT));
  const segments = new Set([...text.split(SEGMENT_SPLIT), ...literalSegments]);
  const searchText = `${text}\n${literalText}`;
  return { text, literalText, searchText, uncertain, pieces, imports, computedImport, dirRead, deepWalk, spawns, segments, literalSegments, weakExts };
}

// -----------------------------------------------------------------------------
// R4 — may module M read path F?

const BEFORE_PATH = /[A-Za-z0-9._-]/;
const AFTER_PATH = /[A-Za-z0-9_/-]/;

// (a) M's text names F, or a suffix of F of MIN_SUFFIX_SEGMENTS segments or
// more, where no path character continues it on either side. A file shorter
// than that is named only as itself: `x/README.md` does not name README.md.
export function namesSuffix(text, file) {
  const segs = file.split('/');
  const from = segs.length < MIN_SUFFIX_SEGMENTS ? [0] : Array.from({ length: segs.length - MIN_SUFFIX_SEGMENTS + 1 }, (_, k) => k);
  for (const k of from) {
    const needle = segs.slice(k).join('/');
    let at = text.indexOf(needle);
    while (at >= 0) {
      const before = at === 0 ? '' : text[at - 1];
      const after = text[at + needle.length] ?? '';
      const afterOk = !AFTER_PATH.test(after) && !(after === '.' && /[A-Za-z0-9]/.test(text[at + needle.length + 1] ?? ''));
      const beforeOk = before === '' || (before === '/' ? segs.length >= MIN_SUFFIX_SEGMENTS : !BEFORE_PATH.test(before));
      if (afterOk && beforeOk) return true;
      at = text.indexOf(needle, at + 1);
    }
  }
  return false;
}

// (b) M's literals cover `segs` left to right from an ancestor of M's
// directory: each segment matched by a literal's segment, at most
// FREE_SEGMENTS of them free (filled by a variable, or matched by a segment
// with a hole), the last never free nor a bare hole, and at least one fixed
// segment taken from a literal with a `/` or from a join/resolve call. The
// segments of M's own location count as covered; `minLiteral` asks one piece
// of such an evidence literal to match that many fixed segments.
export function covers(info, segs, modulePath, { minLiteral = 0 } = {}) {
  const n = segs.length;
  if (n === 0) return false;
  const own = ownDirs(modulePath);
  const memo = new Map();
  const go = (i, free, ev, lit) => {
    if (i === n) return ev && lit >= minLiteral;
    const key = `${i}:${free}:${ev ? 1 : 0}:${lit}`;
    if (memo.has(key)) return memo.get(key);
    memo.set(key, false);
    let ok = false;
    for (const p of info.pieces) {
      const len = p.segs.length;
      if (i + len > n) continue;
      let f = free;
      let e = ev;
      let pieceLit = 0;
      let match = true;
      for (let k = 0; k < len && match; k += 1) {
        const s = p.segs[k];
        const at = i + k;
        const last = at === n - 1;
        if (s.fixed) {
          if (s.text !== segs[at]) match = false;
          else if (p.evidence) {
            e = true;
            pieceLit += 1;
          }
        } else if (last) {
          // A basename is never free: only a hole before a fixed extension,
          // in a literal that also holds a fixed segment.
          if (!(s.weakExt && p.anyFixed && s.re.test(segs[at]))) match = false;
        } else if (s.re.test(segs[at])) {
          f += 1;
          if (f > FREE_SEGMENTS) match = false;
        } else match = false;
      }
      if (match && go(i + len, f, e, Math.min(Math.max(lit, pieceLit), minLiteral))) { ok = true; break; }
    }
    if (!ok && i < n - 1 && free < FREE_SEGMENTS) ok = go(i + 1, free + 1, ev, lit);
    memo.set(key, ok);
    return ok;
  };
  for (let k = 0; k <= own.length && k < n; k += 1) {
    if (k > 0 && segs[k - 1] !== own[k - 1]) break;
    if (go(k, 0, false, 0)) return true;
  }
  return false;
}

/**
 * How module M (its analysis `info`, at `modulePath`) may read `file`: 'suffix',
 * 'cover', 'dir', or null.
 */
export function mayRead(info, file, modulePath) {
  const segs = file.split('/');
  const base = segs[segs.length - 1];
  const ext = path.posix.extname(base);
  if (info.segments.has(base)) {
    // A file of one segment is named only in a string literal: a comment's
    // "README.md" names any of them.
    if (namesSuffix(segs.length >= MIN_SUFFIX_SEGMENTS ? info.searchText : info.literalText, file)) return 'suffix';
    if (covers(info, segs, modulePath)) return 'cover';
  } else if (ext !== '' && info.weakExts.has(ext) && covers(info, segs, modulePath)) return 'cover';
  return walksTo(info, segs, modulePath, info.segments) ? 'dir' : null;
}

const ownDirs = (modulePath) => path.posix.dirname(modulePath).split('/').filter((s) => s !== '.');

/**
 * (c) Whether one piece of M's literals names directory `segs` whole, from the
 * root or from M's own directory (climbed by the `..` the piece starts with;
 * a piece after a leading hole, from the root only): a piece that may name a
 * directory by itself (`dirStart`), with at most FREE_SEGMENTS of its
 * segments free and the last fixed. `join(ROOT, 'plugins')`,
 * `readdirSync('data')` and `join(import.meta.dirname, 'fixtures')` name one;
 * separate literals, or one join argument among others, name none.
 */
export function namesDir(info, segs, modulePath, { whole = true } = {}) {
  // Two fixed segments or more of one literal, anywhere in the module.
  if (segs.length >= MIN_DIR_SEGMENTS && covers(info, segs, modulePath, { minLiteral: MIN_DIR_SEGMENTS })) return true;
  if (!whole) return false;
  const own = ownDirs(modulePath);
  for (const p of info.pieces) {
    if (!p.dirStart || p.segs.length > segs.length || !p.segs[p.segs.length - 1].fixed) continue;
    const k = segs.length - p.segs.length;
    if (k !== 0 && (p.rootOnly || k !== own.length - p.up || own.slice(0, k).some((s, j) => s !== segs[j]))) continue;
    let free = 0;
    const match = p.segs.every((s, j) => {
      if (s.fixed) return s.text === segs[k + j];
      free += 1;
      return free <= FREE_SEGMENTS && s.re.test(segs[k + j]);
    });
    if (match) return true;
  }
  return false;
}

// (c) A walked or copied directory that a piece names (`namesDir`): every
// file under it when the module walks a whole tree, else the files directly
// in it. `named` filters the candidates cheaply.
// With `oneLiteral`, only a directory one literal names in MIN_DIR_SEGMENTS
// segments or more counts.
function walksTo(info, segs, modulePath, named, { oneLiteral = false } = {}) {
  if (!info.dirRead) return false;
  for (let len = 1; len < segs.length; len += 1) {
    const whole = !oneLiteral && (info.deepWalk || len === segs.length - 1);
    if (named.has(segs[len - 1]) && namesDir(info, segs.slice(0, len), modulePath, { whole })) return true;
  }
  return false;
}

/**
 * Whether module M's string literals name JavaScript module `file` (a named
 * suffix, or a cover): the modules a computed import or a started process may
 * load. A module with a computed import may also load each module of a
 * directory it walks (a loader of plugins); a process runs the one script
 * it is given, so a directory a module copies before it starts one is no
 * load. A comment names none. `computed`: the load is a computed import
 * (by default, when M makes one).
 */
export function mayLoad(info, file, modulePath, { computed = info.computedImport } = {}) {
  const segs = file.split('/');
  const base = segs[segs.length - 1];
  if (info.literalSegments.has(base) || info.weakExts.has(path.posix.extname(base))) {
    if (namesSuffix(info.literalText, file) || covers(info, segs, modulePath)) return true;
  }
  // A plugin loader names the directory it loads from in one literal
  // (`join(ROOT, 'src/plugins')`): a module that imports one file by a
  // computed path and walks a tree for another purpose loads none of it.
  return computed && walksTo(info, segs, modulePath, info.literalSegments, { oneLiteral: true });
}

// A module of the test side: one under a tests directory.
const isTestSide = (p) => p.split('/').slice(0, -1).some((s) => s === 'tests' || s === 'test' || s === '__tests__');

// -----------------------------------------------------------------------------
// The tree's import graph (R3, R5).

// `baseFiles`: the fork point's files, against which an import the tree no
// longer resolves still names the file it deleted.
function createGraph(reader, { baseFiles = new Set() } = {}) {
  const list = reader.list();
  const files = new Set(list);
  const has = (p) => files.has(p) || (typeof reader.exists === 'function' && reader.exists(p));
  const jsFiles = list.filter((p) => isJs(p) && !p.split('/').includes('node_modules'));
  const infos = new Map();
  const edgesOf = new Map();
  const info = (p) => {
    if (!infos.has(p)) {
      const text = reader.read(p);
      infos.set(p, text === null ? { ...analyzeModule(''), unreadable: true, uncertain: true } : analyzeModule(text));
    }
    return infos.get(p);
  };

  // The runner's preloads (`--import`, `--require`, `-r` of scripts.test).
  let preloads = [];
  let runnerUnparsed = false;
  const pkgText = reader.read(RUNNER_CONFIG);
  if (pkgText !== null) {
    let script = null;
    try { script = JSON.parse(pkgText)?.scripts?.test ?? null; } catch { runnerUnparsed = true; }
    if (typeof script === 'string') {
      if (/['"`$;&|<>()\\]/.test(script)) runnerUnparsed = true;
      else {
        const words = script.split(/\s+/).filter(Boolean);
        for (let w = 0; w < words.length; w += 1) {
          const m = /^--(import|require)=(.+)$/.exec(words[w]);
          let spec = null;
          if (m) spec = m[2];
          else if (['--import', '--require', '-r'].includes(words[w])) spec = words[w + 1] ?? null;
          if (spec === null) continue;
          if (!spec.startsWith('.')) continue;
          const target = resolveSpec(has, '', spec);
          if (target === null) runnerUnparsed = true;
          else preloads.push(target);
        }
      }
    } else if (script !== null) runnerUnparsed = true;
  }
  preloads = [...new Set(preloads)];

  // A module's import edges. A relative specifier resolves against the tree,
  // and else against the fork point: a deleted file stays the import's
  // target. One that resolves in neither adds no edge (a later change that
  // adds the file makes it resolve). A URL's specifier is relative unless it
  // names a scheme or begins with `/`.
  const importEdges = (p) => {
    if (edgesOf.has(p)) return edgesOf.get(p);
    const out = new Set();
    for (const { spec, kind } of info(p).imports) {
      let rel = spec;
      if (kind === 'url' && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec) && !spec.startsWith('/') && !spec.startsWith('.')) rel = `./${spec}`;
      if (!rel.startsWith('./') && !rel.startsWith('../')) continue;
      const dir = path.posix.dirname(p);
      const target = resolveSpec(has, dir, rel) ?? resolveSpec((x) => baseFiles.has(x), dir, rel);
      if (target !== null) out.add(target);
    }
    const value = [...out].sort(byText);
    edgesOf.set(p, value);
    return value;
  };

  // The JavaScript modules a module's literals name, which it loads as a
  // loader of `mode`: 'computed' (a computed `import(…)`, which also loads
  // each module of a directory it walks) or 'spawn' (a process or worker it
  // starts).
  const loadsOf = new Map();
  const loadEdges = (p, mode) => {
    const key = `${mode}\0${p}`;
    if (!loadsOf.has(key)) {
      const m = info(p);
      loadsOf.set(key, jsFiles.filter((j) => j !== p && mayLoad(m, j, p, { computed: mode === 'computed' })));
    }
    return loadsOf.get(key);
  };
  const modesOf = (m) => [...(m.computedImport ? ['computed'] : []), ...(m.spawns ? ['spawn'] : [])];

  // A module's closure: its imports, and with `loads` what its loaders load.
  // A mutation spec's closure takes no load: what the tests it runs, the
  // other specs the harness loads, or a tool it starts read is not what the
  // spec edits. With `lend`, a test's closure, a loader anywhere in it (a
  // helper that starts a process, or imports by a computed path) runs what
  // the test side hands it: the test, and each module under a tests
  // directory, loads the modules its literals name (never a directory it
  // walks: that is a loader's own reading).
  const closures = new Map();
  const closure = (start, { preload = true, loads = true, lend = false } = {}) => {
    const key = `${preload ? 1 : 0}${loads ? 1 : 0}${lend ? 1 : 0}${start}`;
    if (closures.has(key)) return closures.get(key);
    const seen = new Set([start, ...(preload ? preloads : [])]);
    const queue = [...seen];
    const visit = (y) => { if (!seen.has(y)) { seen.add(y); queue.push(y); } };
    let loaders = false;
    const lent = new Set();
    let uncertain = false;
    for (;;) {
      while (queue.length) {
        const x = queue.pop();
        if (!has(x)) {
          // A file the change deleted has no edges; any other is unknown.
          if (!baseFiles.has(x)) uncertain = true;
          continue;
        }
        if (!isJs(x)) continue;
        const m = info(x);
        if (m.uncertain) uncertain = true;
        for (const y of importEdges(x)) visit(y);
        if (!loads) continue;
        for (const mode of modesOf(m)) {
          loaders = true;
          for (const y of loadEdges(x, mode)) visit(y);
        }
      }
      if (!lend || !loaders) break;
      for (const x of [...seen]) {
        if ((x !== start && !isTestSide(x)) || !isJs(x) || !has(x) || lent.has(x)) continue;
        lent.add(x);
        for (const y of loadEdges(x, 'spawn')) visit(y);
      }
      if (queue.length === 0) break;
    }
    const value = { modules: seen, uncertain };
    closures.set(key, value);
    return value;
  };

  return { files, has, info, closure, preloads, runnerUnparsed };
}

// Node's resolution of a relative specifier against the tree: the path, then
// with each extension, then a directory's index.
function resolveSpec(has, dir, spec) {
  const clean = spec.replace(/[?#].*$/, '');
  const target = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, clean));
  if (target.startsWith('..') || target === '.' || target.startsWith('/')) return null;
  if (has(target)) return target;
  for (const ext of RESOLVE_EXTS) if (has(`${target}${ext}`)) return `${target}${ext}`;
  for (const ext of ['.js', '.mjs', '.cjs']) if (has(`${target}/index${ext}`)) return `${target}/index${ext}`;
  return null;
}

// -----------------------------------------------------------------------------
// R2 — the persona-pipeline map between sources and generated copies.

function readJson(reader, p) {
  const text = reader.read(p);
  if (text === null) return { present: false };
  try { return { present: true, value: JSON.parse(text) }; } catch { return { present: true, value: undefined }; }
}

/**
 * The pipeline pairs `[source, copy]` a tree's manifest and owned.json name.
 * `ok` is false when either file is present but malformed: then `named` holds
 * what could be read, and the caller expands every change to all of it.
 */
export function pipelineMap(reader) {
  const pairs = [];
  const named = new Set();
  const manifest = readJson(reader, PIPELINE_MANIFEST);
  const owned = readJson(reader, PIPELINE_OWNED);
  if (!manifest.present && !owned.present) return { ok: true, pairs, named };
  const pluginDirs = new Set(reader.list().filter((p) => p.startsWith('plugins/')).map((p) => p.split('/')[1]));
  const personaOk = (p) => typeof p === 'string' && /^[a-z][a-z0-9-]*$/.test(p) && pluginDirs.has(p);
  let ok = manifest.present;
  const m = manifest.value;
  const sourcesOf = new Map();
  // An empty enrolment is malformed, as the generator's validateManifest has
  // it: a usable map never maps a source to no copy.
  if (ok && (!isObj(m) || m.schema !== MANIFEST_SCHEMA || !Array.isArray(m.personas) || m.personas.length === 0
    || !m.personas.every(personaOk) || !Array.isArray(m.units) || !Array.isArray(m.regions))) ok = false;
  if (ok) {
    const entries = [...m.units.map((u) => [u, u?.source]), ...m.regions.map((r) => [r, r?.template])];
    for (const [entry, src] of entries) {
      if (!isObj(entry) || !safeRelPath(src) || !safeRelPath(entry.dest) || !Array.isArray(entry.personas)
        || entry.personas.length === 0 || !entry.personas.every((p) => m.personas.includes(p))) { ok = false; continue; }
      const source = `persona-pipeline/${src}`;
      named.add(source);
      for (const p of entry.personas) {
        const copy = `plugins/${p}/${entry.dest}`;
        pairs.push([source, copy]);
        named.add(copy);
        if (!sourcesOf.has(p)) sourcesOf.set(p, new Set());
        sourcesOf.get(p).add(source);
      }
    }
  }
  if (owned.present) {
    const o = owned.value;
    if (!isObj(o) || o.schema !== OWNED_SCHEMA || !isObj(o.owned)) ok = false;
    else {
      const copies = new Set(pairs.map(([, c]) => c));
      for (const [persona, outputs] of Object.entries(o.owned)) {
        if (!personaOk(persona) || !Array.isArray(outputs) || !outputs.every(safeRelPath)) { ok = false; continue; }
        for (const out of outputs) {
          const copy = `plugins/${persona}/${out}`;
          named.add(copy);
          // An output the manifest no longer names: every source of its persona.
          if (!copies.has(copy)) for (const s of sourcesOf.get(persona) ?? []) pairs.push([s, copy]);
        }
      }
    }
  }
  return { ok, pairs, named };
}

/**
 * The expansion of a changed path over pipeline maps (base and tree): a source
 * as every copy, a copy as its sources and their other copies.
 */
export function pipelineExpansion(maps) {
  const copiesOf = new Map();
  const sourcesOf = new Map();
  const add = (m, k, v) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(v); };
  for (const map of maps) for (const [s, c] of map.pairs) { add(copiesOf, s, c); add(sourcesOf, c, s); }
  return (p) => {
    const out = new Set([p]);
    for (const c of copiesOf.get(p) ?? []) out.add(c);
    for (const s of sourcesOf.get(p) ?? []) {
      out.add(s);
      for (const c of copiesOf.get(s) ?? []) out.add(c);
    }
    return out;
  };
}

// -----------------------------------------------------------------------------
// Globs of `adds_on` and of the mappings: `*` and `?` within a segment, `**`
// across segments.

export function globRegex(glob) {
  const segs = glob.split('/');
  let re = '^';
  segs.forEach((s, i) => {
    const lastSeg = i === segs.length - 1;
    if (s === '**') { re += lastSeg ? '.*' : '(?:[^/]+/)*'; return; }
    re += s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    if (!lastSeg) re += '/';
  });
  return new RegExp(`${re}$`, 'u');
}

const matchesAny = (globs, p) => globs.some((g) => globRegex(g).test(p));

// -----------------------------------------------------------------------------
// The declaration, as `parseDeclaration` (the persona's lib/verify.mjs) returns
// it or as its JSON: `{kinds: {id: {slots, adds_on}}, mappings}`.

function readDeclaration(declaration) {
  if (!isObj(declaration) || !isObj(declaration.kinds)) fail('the declaration has no kinds');
  const kinds = Object.entries(declaration.kinds).map(([id, k]) => {
    if (!isObj(k) || !Array.isArray(k.slots) || !Array.isArray(k.adds_on)) fail(`kind ${id} has no slots or adds_on list`);
    return { id, slots: k.slots, adds_on: k.adds_on };
  });
  const mappings = declaration.mappings ?? [];
  if (!Array.isArray(mappings)) fail('the declaration\'s mappings is not a list');
  const maps = mappings.map((m, i) => {
    const where = `mappings[${i}]`;
    if (!isObj(m) || !Array.isArray(m.paths) || m.paths.length === 0 || !m.paths.every((g) => typeof g === 'string' && g !== '')) {
      fail(`${where} is not {paths: [glob…], tests: [path…]} or {paths: [glob…], suite: true}`);
    }
    const keys = Object.keys(m).sort().join(',');
    if (keys === 'paths,tests' && Array.isArray(m.tests) && m.tests.length > 0 && m.tests.every(safeRelPath)) return { paths: m.paths, tests: m.tests };
    if (keys === 'paths,suite' && m.suite === true) return { paths: m.paths, suite: true };
    return fail(`${where} is not {paths: [glob…], tests: [path…]} or {paths: [glob…], suite: true}`);
  });
  return { kinds, mappings: maps };
}

// The single path slot a kind fills from paths.
function pathSlot(kind) {
  if (kind.slots.length !== 1) return null;
  const s = kind.slots[0];
  return s.type === 'path' && ['one', 'many', 'optional-many'].includes(s.repeat) ? s : null;
}

const PATH_ALPHABET = /^[A-Za-z0-9._/-]{1,256}$/;
function fitsSlot(slot, p) {
  return PATH_ALPHABET.test(p) && !p.startsWith('-') && safeRelPath(p)
    && (!slot.under || slot.under.some((u) => p.startsWith(u)))
    && (!slot.suffix || p.endsWith(slot.suffix));
}

// -----------------------------------------------------------------------------
// The selection.

/**
 * The checks the driver adds to a request (Decision 5, item 4).
 *
 * - `tree`, `base`: readers of the lane's tree and of its fork point.
 * - `changes`: `collectChanges`'s list.
 * - `requested`: the worker's checks, `[{kind, args}]`, returned as given.
 * - `declaration`: the repository's declaration.
 * - `testKind`, `suiteKind`: the kinds that run test files and the suite.
 *
 * Returns `{requested, additions, tests, reasons, widened}`: `additions` in the
 * check form, ordered by the declaration's kinds; `tests` either `{files}` or
 * `{suite: true}`; `reasons` and `widened` as `{entries, total}`, the first
 * MAX_LISTED entries kept.
 */
export function selectChecks({ tree, base, changes, requested = [], declaration, testKind = 'test', suiteKind = 'test-suite', maxListed = MAX_LISTED }) {
  if (!tree || typeof tree.list !== 'function' || typeof tree.read !== 'function') fail('selectChecks needs a tree reader');
  if (!base || typeof base.list !== 'function' || typeof base.read !== 'function') fail('selectChecks needs a base reader');
  if (!Array.isArray(changes)) fail('selectChecks needs the changes');
  if (!Array.isArray(requested)) fail('requested is not a list of checks');
  const decl = readDeclaration(declaration);
  const reasons = [];
  const widened = [];
  const tests = discoverTests(tree);
  const testSet = new Set(tests);
  const graph = createGraph(tree, { baseFiles: new Set(base.list()) });
  let suite = false;

  // R2: the pipeline map, from base and tree.
  const maps = [pipelineMap(base), pipelineMap(tree)];
  const expand = pipelineExpansion(maps);
  const allNamed = new Set([...maps[0].named, ...maps[1].named]);
  const changedPaths = [...new Set(changes.map((c) => c.path))].sort(byText);
  const expansions = new Map(changedPaths.map((p) => [p, expand(p)]));
  const mapUnusable = maps.some((m) => !m.ok);
  // A map that does not parse on one side may hide a copy the other names
  // nowhere: a change under persona-pipeline/ or plugins/ then selects the
  // suite.
  if (mapUnusable) widened.push({ path: PIPELINE_MANIFEST, why: 'the persona-pipeline map does not parse on one side; every change under persona-pipeline/ or plugins/ selects the suite' });
  const unmapped = (p) => mapUnusable && (p.startsWith('persona-pipeline/') || p.startsWith('plugins/'));
  for (const p of changedPaths) {
    if (p === PIPELINE_MANIFEST || p === PIPELINE_OWNED || unmapped(p)) {
      for (const x of allNamed) expansions.get(p).add(x);
    }
  }

  // R6: mutation specs, read as text.
  const specs = tree.list().filter((p) => p.startsWith(SPEC_DIR) && !p.slice(SPEC_DIR.length).includes('/') && p.endsWith('.mjs'));
  // A spec's closure is its imports alone: what the tests it runs, the other
  // specs the harness loads and the tools it starts read is not what it edits.
  const specClosure = (s) => graph.closure(s, { preload: false, loads: false });
  // mayRead, once per module and path.
  const howCache = new Map();
  const how = (m, f) => {
    let per = howCache.get(m);
    if (!per) { per = new Map(); howCache.set(m, per); }
    if (!per.has(f)) per.set(f, mayRead(graph.info(m), f, m));
    return per.get(f);
  };
  const readable = (modules) => [...modules].filter((m) => isJs(m) && graph.has(m)).sort(byText);
  const specAnchors = (s, f) => {
    const c = specClosure(s);
    if (c.modules.has(f)) return true;
    return readable(c.modules).some((m) => how(m, f) !== null);
  };
  const specTestsCache = new Map();
  const specTests = (s) => {
    if (!specTestsCache.has(s)) specTestsCache.set(s, tests.filter((t) => specAnchors(s, t)));
    return specTestsCache.get(s);
  };
  // The paths matched against adds_on, each with whether it can be a check's
  // argument: a file of the tree, never a deleted one.
  const triggers = new Map();
  const addTrigger = (p, arg) => { triggers.set(p, (triggers.get(p) ?? true) && arg && graph.files.has(p)); };
  // An unusable map adds the pipeline's own check, unrestricted.
  if (mapUnusable) addTrigger(PIPELINE_MANIFEST, false);
  // So does a change to a pipeline input outside persona-pipeline/: the
  // generator, a module it loads, a file one of them may read (a deleted
  // module they still name included: the reading is of its path), or a
  // persona's declaration. A module that stopped naming a file is itself
  // changed, and an input.
  const generator = graph.has(PIPELINE_GENERATOR) ? graph.closure(PIPELINE_GENERATOR, { preload: false }).modules : new Set([PIPELINE_GENERATOR]);
  const generatorReads = (p) => [...generator].some((m) => isJs(m) && graph.has(m) && how(m, p) !== null);
  for (const p of changedPaths) {
    if (!generator.has(p) && !PERSONA_DECLARATION.test(p) && !generatorReads(p)) continue;
    addTrigger(PIPELINE_MANIFEST, false);
    widened.push({ path: p, why: 'a persona-pipeline input outside persona-pipeline/: the pipeline\'s check runs' });
  }
  for (const s of specs) {
    const c = specClosure(s);
    const anchorsAny = !c.uncertain && [...graph.files].some((f) => f !== s && !testSet.has(f) && specAnchors(s, f));
    if (!anchorsAny) {
      addTrigger(s, false);
      widened.push({ path: s, why: c.uncertain ? 'the mutation spec cannot be read with certainty' : 'the mutation spec anchors no file of the tree' });
    }
  }

  // The tests that may read each path: by import closure or by R4.
  const testClosures = new Map(tests.map((t) => [t, graph.closure(t, { lend: true })]));
  const testModules = new Map(tests.map((t) => [t, readable(testClosures.get(t).modules).filter((m) => m !== t)]));
  const uncertainTests = tests.filter((t) => testClosures.get(t).uncertain);
  const readers = new Map();
  const testsReading = (f) => {
    if (readers.has(f)) return readers.get(f);
    const out = [];
    for (const t of tests) {
      if (testClosures.get(t).modules.has(f)) { out.push({ test: t, rule: 'import', module: t }); continue; }
      // The test's own reading first, then its modules in path order.
      for (const m of [t, ...testModules.get(t)]) {
        const rule = isJs(m) && graph.has(m) ? how(m, f) : null;
        if (rule !== null) { out.push({ test: t, rule, module: m }); break; }
      }
    }
    readers.set(f, out);
    return out;
  };

  // A test that reaches a module the tokenizer could not read is selected for
  // every change, and is no match: nothing it or an uncertain spec selects
  // cancels a fallback.
  const selected = new Set();
  const select = (t) => { selected.add(t); };
  if (changedPaths.length > 0) {
    for (const t of uncertainTests) {
      select(t);
      reasons.push({ path: '*', via: '*', test: t, rule: 'uncertain', module: t });
    }
  }
  for (const p of changedPaths) {
    let matched = false;
    // The runner's configuration and an unmapped pipeline path select the
    // suite, and still count as triggers, spec anchors and mapped paths.
    if (p === RUNNER_CONFIG || unmapped(p)) {
      suite = true;
      matched = true;
      reasons.push({ path: p, via: p, test: '*', rule: p === RUNNER_CONFIG ? 'runner' : 'pipeline', module: p });
    }
    for (const f of [...expansions.get(p)].sort(byText)) {
      addTrigger(f, true);
      for (const r of testsReading(f)) {
        select(r.test);
        if (!testClosures.get(r.test).uncertain) matched = true;
        reasons.push({ path: p, via: f, ...r });
      }
      for (const s of specs) {
        if (s === f || !specAnchors(s, f)) continue;
        addTrigger(s, true);
        for (const t of specTests(s)) {
          select(t);
          if (!specClosure(s).uncertain) matched = true;
          reasons.push({ path: p, via: f, test: t, rule: 'spec', module: s });
        }
      }
      for (const m of decl.mappings) {
        if (!matchesAny(m.paths, f)) continue;
        matched = true;
        if (m.suite) { suite = true; reasons.push({ path: p, via: f, test: '*', rule: 'mapping', module: '*' }); continue; }
        for (const t of m.tests) {
          if (!graph.files.has(t)) {
            suite = true;
            widened.push({ path: t, why: 'a mapped test is not in the tree' });
            continue;
          }
          select(t);
          reasons.push({ path: p, via: f, test: t, rule: 'mapping', module: '*' });
        }
      }
    }
    if (!matched) {
      suite = true;
      reasons.push({ path: p, via: p, test: '*', rule: 'fallback', module: '*' });
    }
  }
  if (graph.runnerUnparsed) {
    suite = true;
    widened.push({ path: RUNNER_CONFIG, why: 'the test script\'s preloads cannot be read' });
  }

  // R7: the kinds whose adds_on match a trigger. A kind is added whole, or
  // the selection throws: a check the declaration asks for is never dropped.
  // An optional slot with a trigger it cannot take runs unrestricted; a slot
  // of one value runs once per trigger; more values than a slot takes are
  // split across checks.
  const kindById = new Map(decl.kinds.map((k) => [k.id, k]));
  const additions = new Map();
  const triggerList = [...triggers.entries()].sort((a, b) => byText(a[0], b[0]));
  for (const kind of decl.kinds) {
    if (kind.adds_on.length === 0) continue;
    const hit = triggerList.filter(([p]) => matchesAny(kind.adds_on, p));
    if (hit.length === 0) continue;
    if (kind.slots.length === 0) { additions.set(kind.id, [{ kind: kind.id, args: {} }]); continue; }
    const slot = pathSlot(kind);
    const fits = (p, arg) => arg && slot !== null && fitsSlot(slot, p);
    const unfit = hit.filter(([p, arg]) => !fits(p, arg)).map(([p]) => p);
    if (slot === null || (unfit.length > 0 && slot.repeat !== 'optional-many')) {
      fail(`kind ${kind.id}: ${(unfit[0] ?? hit[0][0])} matches its adds_on, and its slots cannot be filled from it`);
    }
    const values = hit.map(([p]) => p);
    if (unfit.length > 0 || (slot.repeat === 'optional-many' && values.length > MAX_TEST_FILES)) {
      additions.set(kind.id, [{ kind: kind.id, args: {} }]);
      continue;
    }
    const per = slot.repeat === 'one' ? 1 : MAX_TEST_FILES;
    const checks = [];
    for (let k = 0; k < values.length; k += per) {
      const chunk = values.slice(k, k + per);
      checks.push({ kind: kind.id, args: { [slot.name]: slot.repeat === 'one' ? chunk[0] : chunk } });
    }
    additions.set(kind.id, checks);
  }

  // R8: the tests, as files of the test kind or as the suite.
  // The test kind's own adds_on arguments join the selected tests, and the
  // bound holds for the joined list.
  const tKind = kindById.get(testKind);
  const tSlot0 = tKind ? pathSlot(tKind) : null;
  const tSlot = tSlot0 && tSlot0.repeat !== 'one' ? tSlot0 : null;
  // The test kind added unrestricted (its optional slot could not take a
  // trigger) runs every test: no file list stands for it, the suite does.
  if (tSlot !== null && (additions.get(testKind) ?? []).some((a) => !Object.hasOwn(a.args, tSlot.name))) {
    suite = true;
    widened.push({ kind: testKind, why: `the ${testKind} kind is added unrestricted, which runs every test` });
  }
  const extra = (additions.get(testKind) ?? []).flatMap((a) => a.args?.[tSlot?.name] ?? []);
  const files = [...new Set([...selected, ...extra])].sort(byText);
  if (!suite) {
    if (tSlot === null) { suite = true; widened.push({ kind: testKind, why: 'no declared kind carries test files' }); }
    else {
      const unfit = files.filter((t) => !fitsSlot(tSlot, t));
      if (unfit.length > 0) { suite = true; for (const t of unfit) widened.push({ path: t, why: `the ${testKind} kind cannot carry this test file` }); }
      else if (files.length > MAX_TEST_FILES) { suite = true; widened.push({ kind: testKind, why: `more than ${MAX_TEST_FILES} test files` }); }
    }
  }

  // R9: the worker's checks are kept, and never repeated.
  const same = (a, b) => canonical(a) === canonical(b);
  const requestedFiles = new Set();
  let suiteRequested = false;
  for (const r of requested) {
    if (!isObj(r)) continue;
    if (r.kind === suiteKind) suiteRequested = true;
    if (r.kind === testKind && tSlot && Array.isArray(r.args?.[tSlot.name])) for (const f of r.args[tSlot.name]) requestedFiles.add(f);
  }
  const out = [];
  if (suite) {
    if (!kindById.has(suiteKind)) fail(`the selection needs the whole suite, and the declaration has no ${suiteKind} kind`);
    if (!suiteRequested) additions.set(suiteKind, [{ kind: suiteKind, args: {} }]);
    additions.delete(testKind);
  } else if (!suiteRequested) {
    const wanted = files.filter((f) => !requestedFiles.has(f));
    if (wanted.length > 0) additions.set(testKind, [{ kind: testKind, args: { [tSlot.name]: wanted } }]);
    else additions.delete(testKind);
  } else additions.delete(testKind);
  for (const kind of decl.kinds) {
    for (const a of additions.get(kind.id) ?? []) {
      if (requested.some((r) => isObj(r) && r.kind === a.kind && same(r.args ?? {}, a.args))) continue;
      out.push(a);
    }
  }

  const order = (a, b) => byText(a.path ?? '', b.path ?? '') || byText(a.test ?? '', b.test ?? '') || byText(a.rule ?? '', b.rule ?? '') || byText(a.via ?? '', b.via ?? '') || byText(a.kind ?? '', b.kind ?? '');
  reasons.sort(order);
  widened.sort(order);
  return {
    requested,
    additions: out,
    tests: suite ? { suite: true } : { files },
    reasons: { entries: reasons.slice(0, maxListed), total: reasons.length },
    widened: { entries: widened.slice(0, maxListed), total: widened.length },
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObj(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
