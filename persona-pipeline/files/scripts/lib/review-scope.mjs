// scripts/lib/review-scope.mjs
//
// C120 — the review ledger of a document deliverable, and the scope of its
// re-critique. A document (an ADR, a runbook, other prose as the main
// artifact) gets one full critique; after a refine, the next critique reviews
// the passages the refine changed and the findings it targeted, and a new
// finding outside them that is not CRITICAL is left open instead of starting
// another round. A code deliverable, or anything this module cannot vouch
// for, keeps the full critique. ADR-0063, amendment of 2026-10-14, has the
// contract; state.mjs holds the ledger under the workflow's lock and runs the
// git side through the functions here. Generated from persona-pipeline/
// (ADR-0066).
//
// The ledger is one JSON file per workflow beside its state home
// (`<state home>/reviews/<workflow id>.json`), with an id of its own
// (`ledger_id`) a close must name, so a close from before a reset never lands
// in the ledger that replaced it:
//
//   generations  one per critique: its id, mode (full | scoped | partial, a
//                profile other than the default) and the
//                reason, the tree it reviewed, HEAD, the baseline, the
//                artifact set, the passages of a scoped one, the targets,
//                the critique runs the workflow had noted when it opened
//                (`critique_entries`), and its state (open | closed |
//                abandoned)
//   findings     every finding, with a workflow-wide id (G<generation>-F<n>),
//                its severity, location and text, its disposition
//                (open | resolved | left-open) and the refine attempts that
//                targeted it
//   refines      one attempt per closed generation (R<generation>): the
//                findings it targeted and the tree it left
//
// The pure functions take and return plain values; nothing here writes.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

import { scrubGitSelectors } from './peer-snapshot.mjs';

export const REVIEW_LEDGER_SCHEMA = 'review-ledger-1';
export const SEVERITIES = Object.freeze(['CRITICAL', 'MAJOR', 'MINOR', 'SUGGESTION']);
export const BLOCKING_SEVERITIES = Object.freeze(['CRITICAL', 'MAJOR']);
export const GENERATION_MODES = Object.freeze(['full', 'scoped', 'partial']);
const SEVERITY_RANK = Object.freeze({ SUGGESTION: 0, MINOR: 1, MAJOR: 2, CRITICAL: 3 });
// A deliverable is a document only when every changed path is Markdown (.mdx
// excluded: it carries code) and no changed line is or may be code (`codeLines`:
// the union of a stateless over-reading and the CommonMark reference parser,
// vendored in ./vendor), and no code or HTML block changes what it holds
// (`codeBlockSequence`): Markdown can execute (a runbook's shell blocks are
// code). Other prose
// formats stay full: a `.txt` name is no evidence (CMakeLists.txt,
// requirements.txt), and reStructuredText and AsciiDoc have code block forms
// this module does not read.
export const DOCUMENT_EXTENSIONS = Object.freeze(['.md', '.markdown']);
const REGULAR_FILE_MODES = new Set(['100644', '100755', '000000']);
const FINDING_ID_RE = /^G([1-9][0-9]*)-F([1-9][0-9]*)$/;
const LEDGER_ID_RE = /^[0-9a-f]{16,64}$/;
const STATE_PATH_RE = /^(?:\.agentic-plugins\/state\/|\.claude\/agentic-[^/]*\/)/;
// Every `append --verb critique` notes this line (state.mjs appendPhase): the
// critique command's resume, each critique phase of a /<persona>:start
// lifecycle, any other run that names the verb. The workflow file so counts
// the critiques that ran, recorded in the ledger or not. A release before it
// noted only the critique command's resume heading, which counts when the
// marker does not stand on the line before it.
export const CRITIQUE_RUN_MARKER = '<!-- agentic: critique run -->';
const CRITIQUE_RESUME_RE = /^### Phase 0: Resume into critique[ \t]*$/;

export class ReviewScopeError extends Error {}

// ---------------------------------------------------------------------------
// git, read-only

function gitEnv() {
  return { ...scrubGitSelectors(process.env), LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
}

function git(top, args) {
  return execFileSync('git', ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-C', top, ...args], {
    encoding: 'utf8',
    env: gitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

function gitOrNull(top, args) {
  try {
    return git(top, args);
  } catch {
    return null;
  }
}

/**
 * The branch `top` has checked out, '' on a detached HEAD, or null when git
 * cannot say (no checkout, an unreadable HEAD).
 */
export function currentBranch(top) {
  const out = gitOrNull(top, ['branch', '--show-current']);
  return out === null ? null : out.trim();
}

/** Whether a merge, rebase, cherry-pick or revert is in progress in `top`. */
export function operationInProgress(top) {
  for (const ref of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD']) {
    if (gitOrNull(top, ['rev-parse', '-q', '--verify', ref]) !== null) return ref;
  }
  return null;
}

/**
 * The workflow's baseline as the commit it names, or null: a full commit id
 * that resolves to a commit in `top`. A symbolic name (`HEAD`, a branch, what
 * a repository with no commit records) moves with the checkout, so it is no
 * baseline a scope can be held to.
 */
export function baselineCommit(top, base) {
  if (typeof base !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base)) return null;
  const resolved = (gitOrNull(top, ['rev-parse', '-q', '--verify', `${base}^{commit}`]) ?? '').trim();
  return resolved === base ? base : null;
}

/**
 * The paths that differ between `base` (a commit) and `tree` (a tree id), the
 * state homes left out, as `{ path, status, oldMode, newMode }` sorted by
 * path. Renames read as a deletion and an addition.
 */
export function artifactChanges(top, base, tree) {
  const out = git(top, ['diff', '--raw', '-z', '--no-renames', '--abbrev=40', base, tree]);
  const fields = out.split('\0');
  const changes = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i];
    const path = fields[i + 1];
    if (!meta.startsWith(':')) break;
    const [oldMode, newMode, , , status] = meta.slice(1).split(' ');
    if (STATE_PATH_RE.test(path)) continue;
    changes.push({ path, status, oldMode, newMode });
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * A file's text at a commit or tree, or null when the path is not there. An
 * object git cannot read throws: an earlier critique's tree is unreferenced,
 * so `git gc` can prune it, and a lost file is not an absent one.
 */
export function blobText(top, treeish, path) {
  const entry = git(top, ['ls-tree', '-z', '--full-tree', treeish, '--', path]);
  if (entry === '') return null;
  const m = /^[0-7]{6} blob ([0-9a-f]+)\t/.exec(entry);
  if (!m) throw new ReviewScopeError(`${treeish}:${path} is not a file`);
  return git(top, ['cat-file', 'blob', m[1]]);
}

/** The -U0 hunks of one path between two tree-ishes: `{ os, oc, ns, nc }`. */
export function hunks(top, from, to, path) {
  const out = git(top, ['diff', '-U0', '--no-color', '--no-renames', '--no-ext-diff', '--no-textconv', from, to, '--', path]);
  const found = [];
  for (const line of out.split('\n')) {
    const m = /^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@/.exec(line);
    if (!m) continue;
    found.push({ os: Number(m[1]), oc: m[2] === undefined ? 1 : Number(m[2]), ns: Number(m[3]), nc: m[4] === undefined ? 1 : Number(m[4]) });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Markdown structure

function lines(text) {
  if (text === null || text === '') return [];
  const split = text.split('\n');
  if (split.at(-1) === '') split.pop();
  return split;
}

// The CommonMark reference parser, loaded on first use: most subcommands
// never read Markdown.
let commonmark = null;
function parseCommonMark(text) {
  commonmark ??= createRequire(import.meta.url)('./vendor/commonmark.min.cjs');
  return new commonmark.Parser().parse(text);
}

// The CommonMark nodes read as code: code blocks, and HTML blocks, every one
// of them, since a `<pre><code>` block carries a command as text and a tag
// list would pass the tag it does not name (the owner's ruling, 2026-10-15).
const CODE_NODE_TYPES = new Set(['code_block', 'html_block']);

/**
 * The code blocks CommonMark reads in a text, fenced or indented, and its HTML
 * blocks, as 1-based line ranges `{ start, end }`, the fence lines included;
 * an unclosed fence runs to the end of the text. CommonMark also ends a line
 * at a bare CR, which git does not, so its line numbers would not be git's: a
 * text holding one is read as one code block, the whole text.
 */
export function codeBlockRanges(text) {
  const ranges = [];
  if (text === null || text === '') return ranges;
  if (/\r(?!\n)/.test(text)) return [{ start: 1, end: Math.max(1, lines(text).length) }];
  const walker = parseCommonMark(text).walker();
  for (let event = walker.next(); event !== null; event = walker.next()) {
    if (!event.entering || !CODE_NODE_TYPES.has(event.node.type)) continue;
    const [[start], [end]] = event.node.sourcepos;
    ranges.push({ start, end });
  }
  return ranges;
}

/**
 * The CommonMark code blocks and HTML blocks of a text in order, each as
 * `[type, info, literal]`: what they hold, not where. A change whose every
 * changed line is prose can still change it, by moving a container marker or
 * a fence that decides which unchanged lines are code (dropping a list marker
 * pulls an unindented command into the fence below it), and such a change is
 * code (the owner's ruling on M1, 2026-10-15).
 */
export function codeBlockSequence(text) {
  const blocks = [];
  if (text === null || text === '') return blocks;
  const walker = parseCommonMark(text).walker();
  for (let event = walker.next(); event !== null; event = walker.next()) {
    if (!event.entering || !CODE_NODE_TYPES.has(event.node.type)) continue;
    blocks.push([event.node.type, event.node.info ?? '', event.node.literal ?? '']);
  }
  return blocks;
}

/** Reader 2: every line a CommonMark code block or HTML block spans. */
export function commonmarkCodeLines(text) {
  const code = new Set();
  for (const { start, end } of codeBlockRanges(text)) for (let n = start; n <= end; n++) code.add(n);
  return code;
}

// The column a line's text reaches after `s`, from column `from`: a tab
// advances to the next multiple of four, as CommonMark counts it.
function width(s, from = 0) {
  let w = from;
  for (const ch of s) w += ch === '\t' ? 4 - (w % 4) : 1;
  return w;
}

const FENCE_LIKE_RE = /`{3,}|~{3,}/;
const MARKER_RE = /^(?:>|[-*+](?=[ \t]|$)|[0-9]{1,9}[.)](?=[ \t]|$))/;

// Whether a line's leading white space reaches column 4 at the line start, or
// five columns past a block-quote or list marker in its prefix (the marker's
// one space, then the four of indented code).
function deepIndent(line) {
  if (line.trim() === '') return false;
  let column = 0;
  let marker = null;
  let i = 0;
  while (i < line.length) {
    const space = /^[ \t]+/.exec(line.slice(i));
    if (space) {
      const start = column;
      column = width(space[0], column);
      i += space[0].length;
      if (marker === null ? start === 0 && column >= 4 : column - marker >= 5) return true;
      continue;
    }
    const m = MARKER_RE.exec(line.slice(i));
    if (m === null) return false;
    i += m[0].length;
    column += m[0].length;
    marker = column;
  }
  return false;
}

/**
 * Reader 1: the lines that may be code, read with no fence pairing and no
 * container state, so nothing here can be paired or tracked wrong: every line
 * from the first fence-like line (three or more backticks or tildes anywhere
 * on it) to the last; every line `deepIndent` reads as indented, with no
 * paragraph exception; each blank run between two of those; and each such
 * line's neighbours. It reads what CommonMark reads as text but an agent may
 * run (an indented line CommonMark joins to the paragraph before it).
 */
export function possibleCodeLines(text) {
  const all = lines(text);
  const code = new Set();
  const fences = [];
  const indented = [];
  all.forEach((line, i) => {
    if (FENCE_LIKE_RE.test(line)) fences.push(i + 1);
    if (deepIndent(line)) indented.push(i + 1);
  });
  if (fences.length > 0) for (let n = fences[0]; n <= fences.at(-1); n++) code.add(n);
  const deep = new Set(indented);
  for (let k = 0; k + 1 < indented.length; k++) {
    let blank = true;
    for (let n = indented[k] + 1; n < indented[k + 1]; n++) if (all[n - 1].trim() !== '') blank = false;
    if (blank) for (let n = indented[k] + 1; n < indented[k + 1]; n++) deep.add(n);
  }
  for (const n of deep) {
    for (const m of [n - 1, n, n + 1]) if (m >= 1 && m <= all.length) code.add(m);
  }
  return code;
}

/**
 * The 1-based line numbers that are code or may be: the union of the two
 * readers. CommonMark settles where an unclosed or mis-paired fence ends,
 * which reader 1 cannot without pairing; reader 1 covers what CommonMark
 * reads as text but an agent may run. A line either calls code is code.
 */
export function codeLines(text) {
  const code = possibleCodeLines(text);
  for (const n of commonmarkCodeLines(text)) code.add(n);
  return code;
}

const ATX_RE = /^ {0,3}#{1,6}(\s|$)/;

/**
 * The blocks of a Markdown text as 1-based line ranges `{ start, end }`: a
 * code or HTML block (as CommonMark reads it) is one block, blank lines separate the
 * others, and an ATX heading is a block of its own. A list or a table with no
 * blank line in it is one block.
 */
export function markdownBlocks(text) {
  const all = lines(text);
  const code = new Map(codeBlockRanges(text).map(({ start, end }) => [start, end]));
  const blocks = [];
  let i = 0;
  while (i < all.length) {
    if (code.has(i + 1)) {
      const end = Math.max(i + 1, Math.min(code.get(i + 1), all.length));
      blocks.push({ start: i + 1, end });
      i = end;
      continue;
    }
    const line = all[i];
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    if (ATX_RE.test(line)) {
      blocks.push({ start: i + 1, end: i + 1 });
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < all.length && all[j + 1].trim() !== '' && !code.has(j + 2) && !ATX_RE.test(all[j + 1])) j += 1;
    blocks.push({ start: i + 1, end: j + 1 });
    i = j + 1;
  }
  return blocks;
}

function hasExtension(path, exts) {
  const lower = path.toLowerCase();
  return exts.some((e) => lower.endsWith(e));
}

/**
 * Whether the change from `base` to `tree` is a document deliverable:
 * `{ document, reason }`. It is one only when the artifact set is not empty,
 * every path is a regular Markdown file, no changed line, on either side, is
 * one `codeLines` reads as code, and each path's `codeBlockSequence` is the
 * same on both sides.
 */
export function classifyDeliverable(top, base, tree, changes) {
  if (changes.length === 0) return { document: false, reason: 'empty-artifact-set' };
  for (const c of changes) {
    if (!hasExtension(c.path, DOCUMENT_EXTENSIONS)) return { document: false, reason: `not-prose:${c.path}` };
    if (!REGULAR_FILE_MODES.has(c.oldMode) || !REGULAR_FILE_MODES.has(c.newMode)) return { document: false, reason: `not-a-regular-file:${c.path}` };
    const found = hunks(top, base, tree, c.path);
    if (found.length === 0) return { document: false, reason: `no-text-change:${c.path}` };
    const oldText = blobText(top, base, c.path);
    const newText = blobText(top, tree, c.path);
    const before = codeLines(oldText);
    const after = codeLines(newText);
    for (const h of found) {
      for (let n = h.os; n < h.os + h.oc; n++) if (before.has(n)) return { document: false, reason: `code-changed:${c.path}` };
      for (let n = h.ns; n < h.ns + h.nc; n++) if (after.has(n)) return { document: false, reason: `code-changed:${c.path}` };
    }
    if (JSON.stringify(codeBlockSequence(oldText)) !== JSON.stringify(codeBlockSequence(newText))) return { document: false, reason: `code-blocks-changed:${c.path}` };
  }
  return { document: true, reason: 'document' };
}

/**
 * The passages a change from `fromTree` to `toTree` touched in `paths`, in the
 * new text's coordinates: each a block (or a run of blocks) of the new text
 * with its lines, and the old lines a hunk replaced or deleted as `before`. A
 * deletion anchors to the blocks just before and after it. A deleted file is
 * one passage with `deleted: true`.
 */
export function changedPassages(top, fromTree, toTree, paths) {
  const passages = [];
  for (const path of paths) {
    const oldText = blobText(top, fromTree, path);
    const newText = blobText(top, toTree, path);
    if (oldText === newText) continue;
    if (newText === null) {
      passages.push({ path, start: 0, end: 0, deleted: true, text: '', before: oldText ?? '' });
      continue;
    }
    const newLines = lines(newText);
    const oldLines = lines(oldText ?? '');
    const blocks = markdownBlocks(newText);
    const marked = new Map();
    const mark = (block, before) => {
      if (!block) return;
      const key = block.start;
      if (!marked.has(key)) marked.set(key, { block, before: [] });
      if (before) marked.get(key).before.push(before);
    };
    for (const h of oldText === null ? [{ os: 0, oc: 0, ns: 1, nc: newLines.length }] : hunks(top, fromTree, toTree, path)) {
      const before = h.oc > 0 ? oldLines.slice(h.os - 1, h.os - 1 + h.oc).join('\n') : '';
      const lo = h.ns;
      const hi = h.ns + h.nc - 1;
      const touched = h.nc > 0 ? blocks.filter((b) => b.start <= hi && b.end >= lo) : [];
      if (touched.length > 0) {
        touched.forEach((b, k) => mark(b, k === 0 ? before : ''));
        continue;
      }
      // A deletion (or a change to blank lines only): the deletion point is
      // after new line `ns` (before it when nc > 0), anchored both ways.
      const point = h.nc > 0 ? h.ns - 1 : h.ns;
      const prev = [...blocks].reverse().find((b) => b.start <= point);
      const next = blocks.find((b) => b.start > point);
      mark(prev, before);
      mark(next, prev ? '' : before);
      // Nothing left to anchor to (the file holds no block now): the whole
      // file is the passage.
      if (!prev && !next) passages.push({ path, start: 0, end: 0, deleted: false, whole: true, text: newText, before });
    }
    for (const { block, before } of [...marked.values()].sort((a, b) => a.block.start - b.block.start)) {
      passages.push({
        path,
        start: block.start,
        end: block.end,
        deleted: false,
        text: newLines.slice(block.start - 1, block.end).join('\n'),
        before: before.filter((b) => b !== '').join('\n'),
      });
    }
  }
  return passages;
}

/**
 * A finding location, parsed: `path`, `path:12`, `path:12-20`, `path:12:3`
 * (a column is dropped), `path:L12`, `path#L12` or `path#L12-L20`.
 */
export function parseLocation(location) {
  if (typeof location !== 'string') return null;
  const text = location.trim().replace(/^`+|`+$/g, '');
  const m = /^(.*?)(?:#L([0-9]+)(?:-L?([0-9]+))?|:L?([0-9]+)(?:-L?([0-9]+))?(?::[0-9]+)?)$/.exec(text);
  if (!m) return { path: text, start: null, end: null };
  const start = Number(m[2] ?? m[4]);
  const end = m[3] ?? m[5];
  return { path: m[1], start, end: end === undefined ? start : Number(end) };
}

// The artifact path a location's path spells, or null: `./` and doubled
// slashes are dropped, and an absolute spelling names the longest known path
// it ends in. A relative path that only ends in a known one
// (`other/docs/a.md` for `docs/a.md`) is another file.
function knownPath(path, known) {
  let p = path.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/\.\//g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  if (known.has(p)) return p;
  if (!/^(?:\/|[A-Za-z]:\/)/.test(p)) return null;
  const hits = [...known].filter((k) => p.endsWith(`/${k}`));
  return hits.length === 0 ? null : hits.reduce((a, b) => (b.length > a.length ? b : a));
}

/**
 * Whether a finding's location falls in a passage: `true` (it overlaps one,
 * or it cannot be placed: no path, or a path that is not in `artifact` nor a
 * passage's, counts in scope), `false` (an artifact path, but no passage
 * there overlaps it), or `null` when it names no line range on a passage's
 * path.
 */
export function inPassages(location, passages, artifact = []) {
  const loc = parseLocation(location);
  if (loc === null) return true;
  const path = knownPath(loc.path, new Set([...artifact, ...passages.map((p) => p.path)]));
  if (path === null) return true;
  const onPath = passages.filter((p) => p.path === path);
  if (onPath.length === 0) return false;
  if (onPath.some((p) => p.deleted || p.whole)) return true;
  if (loc.start === null) return null;
  return onPath.some((p) => p.start <= loc.end && p.end >= loc.start);
}

/**
 * Whether a location is shown to fall in a passage: a line range on a passage
 * path that overlaps one, or a deleted or whole-file passage's path. A
 * location that cannot be placed is not: what decides a resolution needs the
 * evidence that the reviewer read that text.
 */
export function overlapsPassage(location, passages, artifact = []) {
  const loc = parseLocation(location);
  if (loc === null) return false;
  const path = knownPath(loc.path, new Set([...artifact, ...passages.map((p) => p.path)]));
  if (path === null) return false;
  const onPath = passages.filter((p) => p.path === path);
  if (onPath.some((p) => p.deleted || p.whole)) return true;
  if (loc.start === null) return false;
  return onPath.some((p) => p.start <= loc.end && p.end >= loc.start);
}

// ---------------------------------------------------------------------------
// The ledger (pure)

export function emptyLedger(workflowId, ledgerId = randomBytes(8).toString('hex')) {
  return { schema: REVIEW_LEDGER_SCHEMA, workflow_id: workflowId, ledger_id: ledgerId, generations: [], findings: [], refines: [] };
}

/**
 * How many critique runs the workflow file's body notes: each marker line,
 * and each resume heading an older release wrote with no marker before it. A
 * note that quotes either only adds a run, which makes the next critique full.
 */
export function critiqueEntries(body) {
  const all = String(body ?? '').split('\n').map((l) => l.replace(/\r$/, ''));
  let n = 0;
  all.forEach((line, i) => {
    if (line === CRITIQUE_RUN_MARKER) n += 1;
    else if (CRITIQUE_RESUME_RE.test(line) && all[i - 1] !== CRITIQUE_RUN_MARKER) n += 1;
  });
  return n;
}

/**
 * Whether a critique ran that the ledger holds no generation for: more
 * critique runs are noted than the last generation counted when it opened,
 * plus `pending`, the runs the caller is part of (1 for critique-scope, whose
 * own run is noted; 0 after it). A critique-scope that failed, an older
 * state.mjs, a checkout it could not vouch for: each leaves a run the ledger
 * never saw, whose findings it cannot hand on.
 */
export function unrecordedCritique(ledger, entries, pending) {
  const last = ledger.generations.at(-1);
  return last !== undefined && entries > last.critique_entries + pending;
}

/** A ledger read from disk, checked for the shape this module writes. */
export function validateLedger(ledger, workflowId) {
  const bad = (why) => new ReviewScopeError(`the review ledger of ${workflowId} is not usable (${why})`);
  if (ledger === null || typeof ledger !== 'object' || Array.isArray(ledger)) throw bad('not an object');
  if (ledger.schema !== REVIEW_LEDGER_SCHEMA) throw bad(`schema ${JSON.stringify(ledger.schema)}`);
  if (ledger.workflow_id !== workflowId) throw bad(`it names workflow ${JSON.stringify(ledger.workflow_id)}`);
  if (typeof ledger.ledger_id !== 'string' || !LEDGER_ID_RE.test(ledger.ledger_id)) throw bad('it has no ledger id');
  for (const key of ['generations', 'findings', 'refines']) if (!Array.isArray(ledger[key])) throw bad(`${key} is not a list`);
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  // A passage bounds the left-open route, so one with no path or a range that
  // is not one is no passage the ledger can hold.
  const isPassage = (p) => isObject(p) && typeof p.path === 'string' && p.path !== ''
    && Number.isInteger(p.start) && Number.isInteger(p.end)
    && (p.deleted === true || p.whole === true ? p.start === 0 && p.end === 0 : p.start >= 1 && p.end >= p.start);
  // Generation ids are the ledger's chronology (each critique opens the
  // next), so they run 1, 2, 3 in order.
  ledger.generations.forEach((g, i) => {
    if (!isObject(g) || g.id !== i + 1 || !GENERATION_MODES.includes(g.mode) || !['open', 'closed', 'abandoned'].includes(g.state)
      || !Number.isInteger(g.critique_entries) || g.critique_entries < 0 || typeof g.tree !== 'string' || !isList(g.artifact) || !isList(g.targets) || !Array.isArray(g.passages)
      || !g.passages.every((p) => isPassage(p) && g.artifact.includes(p.path))) throw bad(`generations[${i}] is malformed`);
  });
  ledger.findings.forEach((x, i) => {
    if (!isObject(x) || typeof x.id !== 'string' || !FINDING_ID_RE.test(x.id) || !SEVERITIES.includes(x.severity)
      || !['open', 'resolved', 'left-open'].includes(x.disposition) || !isList(x.targeted_by) || !Array.isArray(x.history)
      || !x.history.every((h) => isObject(h) && Number.isInteger(h.generation) && typeof h.verdict === 'string')) throw bad(`findings[${i}] is malformed`);
  });
  ledger.refines.forEach((r, i) => {
    if (!isObject(r) || typeof r.attempt !== 'string' || !isList(r.targets) || typeof r.tree_after !== 'string') throw bad(`refines[${i}] is malformed`);
  });
  return ledger;
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

function isBlocking(f) {
  return f.disposition === 'open' && BLOCKING_SEVERITIES.includes(f.severity);
}

function closedGenerations(ledger) {
  return ledger.generations.filter((g) => g.state === 'closed');
}

/**
 * Whether a critique opened after the last closed one never closed (its close
 * refused, or its run stopped): the findings it saw are not in the ledger, so
 * the ledger vouches for nothing until a critique closes again.
 */
export function unclosedCritique(ledger) {
  const lastClosed = closedGenerations(ledger).reduce((m, g) => Math.max(m, g.id), 0);
  return ledger.generations.some((g) => g.state !== 'closed' && g.id > lastClosed);
}

function higher(a, b) {
  return SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
}

/**
 * The blocking findings that are recurring: a refine attempt targeted the
 * finding, and a critique closed after that attempt judged it unresolved. A
 * target no critique has judged since its refine (a partial critique that
 * did not report it, or none yet) is not recurring.
 */
export function recurringFindings(ledger) {
  const after = new Map(ledger.refines.map((r) => [r.attempt, r.after_generation ?? 0]));
  const judgedAfter = (f, attempt) => f.history.some((h) => h.verdict === 'unresolved' && h.generation > (after.get(attempt) ?? Infinity));
  return ledger.findings.filter((f) => isBlocking(f) && f.targeted_by.some((a) => judgedAfter(f, a))).map((f) => f.id);
}

// The verdicts that judge a target: a critique's resolution or rejection, or
// a full critique's not reporting it. A partial critique's omission
// (`not-judged`) leaves it a target.
const TARGET_JUDGMENTS = new Set(['resolved', 'unresolved', 'not-reported']);

/**
 * The refine targets no critique closed since their attempt has judged, in
 * the order they were recorded. A full critique closed after the attempt
 * judged every target, the ones it did not report (and so resolved, or left
 * resolved) included.
 */
export function outstandingTargets(ledger) {
  const byId = new Map(ledger.findings.map((f) => [f.id, f]));
  const out = [];
  for (const r of ledger.refines) {
    const after = r.after_generation ?? 0;
    if (ledger.generations.some((g) => g.state === 'closed' && g.mode === 'full' && g.id > after)) continue;
    for (const t of r.targets) {
      const f = byId.get(t);
      if (f === undefined || out.includes(t)) continue;
      if (!(f.history ?? []).some((h) => h.generation > after && TARGET_JUDGMENTS.has(h.verdict))) out.push(t);
    }
  }
  return out;
}

/**
 * The mode the next critique runs in: `{ mode, reason, from, targets }`.
 * Scoped only when every condition holds; any other case is full, with the
 * first condition that failed as the reason. A profile other than the
 * default is `partial`: it judges what its lens reports, resolves nothing
 * else, and is never the full critique a scoped one starts from. `current` is
 * what the command found: `{ defaultProfile, tree, head, base, artifact,
 * document, documentReason, operation }`. Refine-record asks the same
 * question of the tree it just recorded, for its Refine-verify.
 */
export function decideScope(ledger, current) {
  const full = (reason) => ({ mode: 'full', reason, from: null, targets: [] });
  // A partial critique judges what its lens reports, but a refine's targets
  // stay targets until a critique judges them: one it does not judge is open,
  // not resolved, and a later partial critique still holds it.
  if (!current.defaultProfile) return { mode: 'partial', reason: 'not-the-default-profile', from: null, targets: outstandingTargets(ledger) };
  if (current.operation) return full(`operation-in-progress:${current.operation}`);
  if (current.artifact.length === 0) return full('empty-artifact-set');
  if (!current.document) return full(current.documentReason);
  const closed = closedGenerations(ledger);
  if (!closed.some((g) => g.mode === 'full')) return full('no-full-critique-recorded');
  const last = closed.at(-1);
  if (last.mode === 'partial') return full('last-critique-had-another-profile');
  if (unclosedCritique(ledger)) return full('unclosed-critique-since-the-last-close');
  const attempt = ledger.refines.find((r) => r.after_generation === last.id);
  if (!attempt) return full('no-refine-recorded-since-the-last-critique');
  if (attempt.tree_after !== current.tree) return full('tree-changed-since-the-refine-record');
  if (last.head !== current.head) return full('head-moved');
  if (last.base !== current.base) return full('baseline-changed');
  if (!sameSet(last.artifact, current.artifact)) return full('artifact-set-changed');
  const ids = new Set(ledger.findings.map((f) => f.id));
  const unknown = attempt.targets.find((t) => !ids.has(t));
  if (unknown) return full(`unknown-target:${unknown}`);
  return { mode: 'scoped', reason: 'scoped', from: last.tree, targets: [...attempt.targets] };
}

/**
 * Open generation `id` (the next) with what `critique-scope` found; an open
 * generation left by a run that never closed it is abandoned.
 */
export function openGeneration(ledger, fields, now) {
  const next = structuredClone(ledger);
  for (const g of next.generations) if (g.state === 'open') g.state = 'abandoned';
  const id = next.generations.reduce((m, g) => Math.max(m, g.id), 0) + 1;
  next.generations.push({
    id,
    mode: fields.mode,
    reason: fields.reason,
    tree: fields.tree,
    head: fields.head,
    base: fields.base,
    artifact: [...fields.artifact],
    document: fields.document,
    from_tree: fields.from ?? null,
    passages: (fields.passages ?? []).map(({ path, start, end, deleted, whole }) => ({ path, start, end, deleted, ...(whole ? { whole: true } : {}) })),
    targets: [...(fields.targets ?? [])],
    critique_entries: fields.critiqueEntries ?? 0,
    state: 'open',
    opened_at: now,
    closed_at: null,
  });
  return { ledger: next, generation: id };
}

function checkFindingsInput(input, ledger) {
  if (input === null || typeof input !== 'object' || !Array.isArray(input.findings)) {
    throw new ReviewScopeError('the findings file holds no {"findings": [...]} object');
  }
  const known = new Set(ledger.findings.map((f) => f.id));
  input.findings.forEach((f, i) => {
    const where = `findings[${i}]`;
    if (f === null || typeof f !== 'object') throw new ReviewScopeError(`${where} is not an object`);
    if (f.id !== 'NEW' && !(typeof f.id === 'string' && FINDING_ID_RE.test(f.id))) {
      throw new ReviewScopeError(`${where}.id is ${JSON.stringify(f.id)}: give a ledger id (G<n>-F<n>) or NEW`);
    }
    if (f.id !== 'NEW' && !known.has(f.id)) throw new ReviewScopeError(`${where}.id ${f.id} is not in the review ledger`);
    if (f.id === 'NEW' && !SEVERITIES.includes(f.severity)) throw new ReviewScopeError(`${where}.severity must be one of ${SEVERITIES.join(', ')}`);
    if (f.severity !== undefined && !SEVERITIES.includes(f.severity)) throw new ReviewScopeError(`${where}.severity must be one of ${SEVERITIES.join(', ')}`);
    if (f.id === 'NEW' && (typeof f.text !== 'string' || f.text.trim() === '')) throw new ReviewScopeError(`${where}.text is empty`);
    if (f.verdict !== undefined && f.verdict !== 'resolved' && f.verdict !== 'unresolved') throw new ReviewScopeError(`${where}.verdict must be resolved or unresolved`);
    if (f.scope !== undefined && f.scope !== 'in' && f.scope !== 'outside') throw new ReviewScopeError(`${where}.scope must be in or outside`);
    if (f.location !== undefined && typeof f.location !== 'string') throw new ReviewScopeError(`${where}.location is not a string`);
    const loc = parseLocation(f.location);
    if (loc !== null && loc.start !== null && (loc.start < 1 || loc.end < loc.start)) {
      throw new ReviewScopeError(`${where}.location ${JSON.stringify(f.location)} names no line range (start 1 or more, end not before start)`);
    }
  });
}

/**
 * Close the open generation `id` with the critique's findings and return the
 * new ledger and the disposition:
 *
 *   carry      open CRITICAL / MAJOR findings, in the ledger: refine's work
 *   left_open  findings left for the owner (a scoped critique's new
 *              non-CRITICAL finding outside the passages)
 *   recurring  carried findings an earlier refine attempt already targeted
 *   resolved   findings this critique resolved
 *   new        the ids this critique gave its new findings
 *   converged  no CRITICAL or MAJOR finding is open
 *
 * A scoped critique resolves a target only on one `resolved` verdict for it;
 * a missing, duplicated or contradictory one leaves it open, and a prior open
 * finding it neither targeted nor judged stays open, and so does one it judged
 * resolved that lies in no passage (it did not read that text). A full critique reviews
 * the whole deliverable: a prior finding it does not report again is resolved.
 * A partial one (another profile) judges what it reports and resolves nothing
 * else. A finding's severity follows the latest judgment, except that a
 * critique narrower than full never lowers a CRITICAL or MAJOR, and an
 * ambiguous judgment (references that disagree) takes the highest.
 */
export function closeGeneration(ledger, id, input, now) {
  const next = structuredClone(ledger);
  const gen = next.generations.find((g) => g.id === id);
  if (!gen || gen.state !== 'open') {
    throw new ReviewScopeError(`generation ${id} is not the open critique of this workflow; run critique-scope again`);
  }
  checkFindingsInput(input, next);
  const byId = new Map(next.findings.map((f) => [f.id, f]));
  const refs = new Map();
  for (const f of input.findings) if (f.id !== 'NEW') refs.set(f.id, [...(refs.get(f.id) ?? []), f]);
  const resolved = [];
  // Whether a finding sits outside the passages a scoped critique reviewed: a
  // location that overlaps one is in, whatever the review claimed, and so is
  // one that cannot be placed (a path the artifact set does not hold); one on
  // an artifact path but no passage is outside unless the review marked it
  // in; a location that names no line on a passage path is outside only when
  // marked so, and a finding with no location cannot be shown outside.
  const outsidePassages = (location, scope) => {
    if (typeof location !== 'string' || location.trim() === '') return false;
    const overlap = inPassages(location, gen.passages, gen.artifact);
    if (overlap === true) return false;
    if (overlap === false) return scope !== 'in';
    return scope === 'outside';
  };
  const judge = (finding, references, { mustBeSingle }) => {
    const verdicts = new Set(references.map((r) => r.verdict ?? 'unresolved'));
    const single = references.length === 1 || !mustBeSingle;
    const ok = single && verdicts.size === 1 && verdicts.has('resolved');
    const last = references.at(-1);
    // A scoped critique reads the passages and the targets, not the rest: a
    // finding the refine did not target is resolved there only when every
    // report of it places it in a passage. The ledger's location is no
    // evidence: it is in the coordinates of the text it was found in, which
    // the refine may have shifted. Elsewhere the resolution is noted and not
    // taken: the severity it reports still counts, and the finding keeps its
    // disposition under the rules below (a left-open one stays so only when
    // every report places it outside).
    const unread = ok && gen.mode === 'scoped' && !mustBeSingle
      && !references.every((r) => overlapsPassage(r.location, gen.passages, gen.artifact));
    const accepted = ok && !unread;
    const reported = references.map((r) => r.severity).filter((s) => s !== undefined);
    if (reported.length > 0) {
      const ambiguous = references.length > 1 && (verdicts.size > 1 || new Set(reported).size > 1);
      const keep = ambiguous || (gen.mode !== 'full' && BLOCKING_SEVERITIES.includes(finding.severity));
      finding.severity = keep ? reported.reduce(higher, finding.severity) : reported.at(-1);
    }
    if (typeof last.location === 'string') finding.location = last.location;
    if (accepted) {
      finding.disposition = 'resolved';
      resolved.push(finding.id);
    } else if (finding.disposition === 'left-open' && gen.mode === 'scoped' && !mustBeSingle && finding.severity !== 'CRITICAL'
      && references.every((r) => outsidePassages(r.location, r.scope))) {
      // Reported again, and every report places it outside what the refine
      // changed, in this critique's coordinates: it stays the owner's, or
      // every scoped critique would pull it back into refine. A report with no
      // location is not placed outside: the ledger's location is in the
      // coordinates of the text it was found in, which the refine may have
      // shifted. A target is not the owner's any more: the refine aimed at
      // it, so the critique judged it wherever it lies.
    } else if (unread && finding.disposition !== 'left-open') {
      // A resolution not taken leaves an open finding open and a resolved
      // one resolved.
    } else {
      finding.disposition = 'open';
    }
    finding.history.push({ generation: id, verdict: accepted ? 'resolved' : unread ? 'resolved-outside-passages' : 'unresolved' });
  };

  const targets = new Set(gen.targets);
  // `mustBeSingle` marks a target: one the refine aimed at, so the scoped
  // critique reads it whatever its place.
  for (const finding of next.findings) {
    const references = refs.get(finding.id);
    if (references) {
      judge(finding, references, { mustBeSingle: targets.has(finding.id) });
    } else if (gen.mode === 'full' && finding.disposition !== 'resolved') {
      finding.disposition = 'resolved';
      finding.history.push({ generation: id, verdict: 'not-reported' });
      resolved.push(finding.id);
    }
    // scoped or partial and unreferenced: a target is open (no verdict counts
    // unresolved), whatever it was before the refine aimed at it (left open,
    // or resolved by an earlier critique and edited again), and any other
    // finding stays as it was.
    // A partial critique's lens may not cover it, so there the omission is
    // noted as not judged: no judgment the recurring rule counts, and the
    // finding stays a target for the next partial critique.
    else if (references === undefined && targets.has(finding.id)) {
      finding.disposition = 'open';
      finding.history.push({ generation: id, verdict: gen.mode === 'partial' ? 'not-judged' : 'unresolved' });
    }
  }

  const added = [];
  const leftOpen = [];
  let n = 0;
  for (const f of input.findings) {
    if (f.id !== 'NEW') continue;
    n += 1;
    const fid = `G${id}-F${n}`;
    let disposition = 'open';
    if (gen.mode === 'scoped') {
      if (f.severity !== 'CRITICAL' && outsidePassages(f.location, f.scope)) disposition = 'left-open';
    }
    const finding = {
      id: fid,
      generation: id,
      severity: f.severity,
      location: typeof f.location === 'string' ? f.location : '',
      text: f.text.trim(),
      disposition,
      targeted_by: [],
      history: [],
    };
    next.findings.push(finding);
    byId.set(fid, finding);
    added.push(fid);
    if (disposition === 'left-open') leftOpen.push(fid);
  }

  gen.state = 'closed';
  gen.closed_at = now;
  const carry = next.findings.filter(isBlocking).map((f) => f.id);
  return {
    ledger: next,
    result: {
      generation: id,
      mode: gen.mode,
      reason: gen.reason,
      converged: carry.length === 0,
      carry,
      left_open: next.findings.filter((f) => f.disposition === 'left-open').map((f) => f.id),
      left_open_now: leftOpen,
      recurring: recurringFindings(next),
      resolved,
      new: added,
    },
  };
}

/**
 * Record a refine attempt after the last closed critique: the findings it
 * targeted and the tree it left. One attempt per critique (`R<generation>`,
 * `R0` before any): a second record after the same critique adds its targets
 * and moves the tree. A target must name a ledger finding.
 */
export function recordRefine(ledger, { targets, treeAfter }, now) {
  const next = structuredClone(ledger);
  const ids = new Set(next.findings.map((f) => f.id));
  for (const t of targets) {
    if (typeof t !== 'string' || !ids.has(t)) throw new ReviewScopeError(`refine target ${JSON.stringify(t)} is not a finding in the review ledger`);
  }
  const last = closedGenerations(next).at(-1) ?? null;
  const after = last === null ? null : last.id;
  const attemptId = `R${after ?? 0}`;
  let attempt = next.refines.find((r) => r.attempt === attemptId);
  if (!attempt) {
    attempt = { attempt: attemptId, after_generation: after, targets: [], tree_after: null, recorded_at: null };
    next.refines.push(attempt);
  }
  for (const t of targets) if (!attempt.targets.includes(t)) attempt.targets.push(t);
  attempt.tree_after = treeAfter;
  attempt.recorded_at = now;
  for (const f of next.findings) {
    if (attempt.targets.includes(f.id) && !f.targeted_by.includes(attemptId)) f.targeted_by.push(attemptId);
  }
  return { ledger: next, attempt: { ...attempt, targets: [...attempt.targets] } };
}

/** What the ledger says now, for refine's recurring check and the notes. */
export function reviewStatus(ledger) {
  const last = ledger.generations.at(-1) ?? null;
  const open = ledger.findings.filter(isBlocking);
  return {
    generations: ledger.generations.length,
    last: last === null ? null : { id: last.id, mode: last.mode, reason: last.reason, state: last.state, document: last.document },
    carry: open.map((f) => f.id),
    recurring: recurringFindings(ledger),
    left_open: ledger.findings.filter((f) => f.disposition === 'left-open').map((f) => f.id),
    findings: ledger.findings.map(({ id, severity, location, text, disposition, targeted_by }) => ({ id, severity, location, text, disposition, targeted_by })),
  };
}
