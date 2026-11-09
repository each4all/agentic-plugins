// drift-digest — dirty-tree gates must see untracked files regardless of the
// user's `status.showUntrackedFiles` setting (R3 §3.5).
//
// Two layers, because either alone is vacuous:
//
//   1. BEHAVIOUR — run the real persona `runCleanBaselineCheck` against a
//      scratch repo that FORCES the condition (`git config
//      status.showUntrackedFiles no` + an untracked file). Without
//      `--untracked-files=normal` on the producer, git reports an empty
//      porcelain blob and the gate classifies the tree CLEAN — the exact
//      false-negative this suite exists to catch. Controls: a genuinely
//      clean tree must still classify clean with a BYTE-IDENTICAL digest,
//      and a tracked-only modification must be unaffected by the flag.
//
//   2. STRUCTURE — every `git status` producer across the five packages
//      carries the flag. A behaviour test can only reach the producers it
//      imports; the structural sweep is what stops a NEW producer (or a
//      revert of one of the 46 sites) from shipping blind. The deliberate
//      exceptions are pinned by identity, not by count.
//
// Run: node --test tests/scripts/test-untracked-visibility.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// sha256 of an empty porcelain blob — the digest every clean tree must produce.
const EMPTY_DIGEST = createHash('sha256').update('').digest('hex');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeScratchRepo({ hideUntracked }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'untracked-visibility-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  // THE FORCED CONDITION. Without this the test would pass on any machine
  // whose git shows untracked files by default — i.e. it would be green by
  // accident and would not bite when the flag is removed.
  if (hideUntracked) git(dir, ['config', 'status.showUntrackedFiles', 'no']);
  writeFileSync(path.join(dir, 'tracked.txt'), 'tracked\n', 'utf8');
  git(dir, ['add', 'tracked.txt']);
  git(dir, ['commit', '-qm', 'init']);
  return dir;
}

// --- 1. BEHAVIOUR — the real producers ------------------------------------

const PERSONAS = ['designer', 'engineer', 'founder'];

// Both producer families are exercised, because they answer different
// questions and could regress independently:
//   * `runCleanBaselineCheck` (scripts/state.mjs) -> clean/dirty CLASSIFY
//   * `gitStatusDigest` (scripts/lib/hook-helpers.mjs; orchestrator's adapters/claude/hooks/_shared.mjs) -> the status DIGEST
describe('drift-digest — clean-baseline gates see untracked files under status.showUntrackedFiles=no', () => {
  for (const persona of PERSONAS) {
    describe(persona, () => {
      let runCleanBaselineCheck;

      before(async () => {
        ({ runCleanBaselineCheck } = await import(
          path.join(REPO_ROOT, 'plugins', persona, 'scripts', 'state.mjs')
        ));
      });

      it('classifies a tree with ONLY an untracked file as dirty (the R3 §3.5 false negative)', () => {
        const dir = makeScratchRepo({ hideUntracked: true });
        try {
          writeFileSync(path.join(dir, 'untracked.txt'), 'x\n', 'utf8');
          // Control first: prove the condition is actually in force — the
          // unflagged command the producer USED to run reports nothing here,
          // so a green result below cannot come from a lenient environment.
          const unflagged = git(dir, ['status', '--porcelain=v1', '-z']);
          assert.equal(unflagged, '', 'precondition: status.showUntrackedFiles=no hides the untracked file');

          const result = runCleanBaselineCheck({ repoRoot: dir });
          assert.equal(result.status, 'dirty', `${persona}: untracked-only tree must classify dirty, got ${result.status}`);
          assert.deepEqual(result.categories.untracked, ['untracked.txt'], `${persona}: the untracked entry is surfaced by name`);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it('control: a genuinely clean tree still classifies clean under both settings', () => {
        for (const hideUntracked of [true, false]) {
          const dir = makeScratchRepo({ hideUntracked });
          try {
            const result = runCleanBaselineCheck({ repoRoot: dir });
            assert.equal(result.status, 'clean', `${persona}: clean tree (hideUntracked=${hideUntracked})`);
            assert.deepEqual(result.categories.untracked, [], `${persona}: no phantom untracked entries`);
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      });

      it('control: a tracked-only modification is still classified dirty with no untracked entries', () => {
        const dir = makeScratchRepo({ hideUntracked: true });
        try {
          appendFileSync(path.join(dir, 'tracked.txt'), 'more\n', 'utf8');
          const result = runCleanBaselineCheck({ repoRoot: dir });
          assert.equal(result.status, 'dirty', `${persona}: tracked modification`);
          assert.deepEqual(result.categories.modified, ['tracked.txt'], `${persona}: tracked change unaffected by the flag`);
          assert.deepEqual(result.categories.untracked, [], `${persona}: no untracked noise`);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });
  }
});

describe('drift-digest — hook status digests see untracked files, and clean-tree digest bytes are unchanged', () => {
  // One digest producer per package (the hook helpers are the digest family;
  // the persona gates above are the classify family). The persona plugins'
  // helpers are one generated module, scripts/lib/hook-helpers.mjs (ADR-0066 D5).
  const DIGEST_PRODUCERS = [
    ['designer', 'plugins/designer/scripts/lib/hook-helpers.mjs'],
    ['engineer', 'plugins/engineer/scripts/lib/hook-helpers.mjs'],
    ['founder', 'plugins/founder/scripts/lib/hook-helpers.mjs'],
    ['orchestrator', 'plugins/orchestrator/adapters/claude/hooks/_shared.mjs'],
  ];

  for (const [label, rel] of DIGEST_PRODUCERS) {
    describe(label, () => {
      let gitStatusDigest;

      before(async () => {
        ({ gitStatusDigest } = await import(path.join(REPO_ROOT, rel)));
      });

      it('digests a tree whose only change is an untracked file as NON-empty', () => {
        const dir = makeScratchRepo({ hideUntracked: true });
        try {
          writeFileSync(path.join(dir, 'untracked.txt'), 'x\n', 'utf8');
          assert.equal(git(dir, ['status', '--porcelain=v1', '-z']), '', 'precondition: the setting hides it');
          const digest = gitStatusDigest(dir);
          assert.notEqual(digest, EMPTY_DIGEST, `${label}: an untracked file must move the digest off the clean value`);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it('control: the CLEAN-tree digest is byte-identical to the historical empty-porcelain value', () => {
        for (const hideUntracked of [true, false]) {
          const dir = makeScratchRepo({ hideUntracked });
          try {
            assert.equal(
              gitStatusDigest(dir),
              EMPTY_DIGEST,
              `${label}: clean-tree digest must not change (hideUntracked=${hideUntracked}) — persisted baselines compare against it`,
            );
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      });

      it('control: a tracked-only modification digests identically with and without the flag', () => {
        const dir = makeScratchRepo({ hideUntracked: true });
        try {
          appendFileSync(path.join(dir, 'tracked.txt'), 'more\n', 'utf8');
          const withoutFlag = git(dir, ['status', '--porcelain=v1', '-z']);
          const expected = createHash('sha256').update(withoutFlag).digest('hex');
          assert.equal(gitStatusDigest(dir), expected, `${label}: tracked-only digest is flag-invariant`);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });
  }
});

// --- 2. STRUCTURE — no producer regresses ----------------------------------

// The deliberate exceptions, each pinned by IDENTITY (file + the exact argv),
// not by a count: a count would silently absorb a second blind producer
// appearing while one of these is removed. Each must be seen exactly once.
//   - migrate-workflow-storage: tracked files only, by design.
//   - peer-snapshot (the persona-pipeline copy in each persona, and
//     orchestrator's): it reads the `.A` intent-to-add records of a copied
//     index and nothing else; untracked files reach the snapshot through its
//     own `git add`, never through this status, which is no digest.
const PEER_SNAPSHOT_UNO = "['status', '--porcelain=v2', '-z', '--untracked-files=no', '--ignore-submodules=all']";
const PRESERVED_UNO = [
  { file: 'plugins/runtime/scripts/migrate-workflow-storage.mjs', needle: "['status', '--porcelain', '--untracked-files=no']" },
  ...['designer', 'engineer', 'founder', 'orchestrator'].map((pkg) => ({
    file: `plugins/${pkg}/scripts/lib/peer-snapshot.mjs`,
    needle: PEER_SNAPSHOT_UNO,
  })),
];

// The exception a detected -uno producer is, or null: its file AND its argv,
// as detected with comments removed. The same argv kept only in a comment,
// beside a changed command, is not it.
function preservedException(rel, producerText) {
  return PRESERVED_UNO.find((p) => p.file === rel && p.needle === producerText.trim()) || null;
}

const PACKAGES = ['designer', 'engineer', 'founder', 'orchestrator', 'runtime'];
const SCAN_EXTENSIONS = new Set(['.mjs', '.md']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (SCAN_EXTENSIONS.has(path.extname(entry))) out.push(full);
  }
  return out;
}

// Detecting a producer is a small static analysis, not a line grep. Three
// evasions were reproduced against a line-based matcher and each is closed
// below (peer review 2026-08-22):
//   (a) an argv array bound to a variable, then passed to spawnSync/execFile
//       one or more lines later — the executor and the args are on different
//       lines, so a per-line rule sees neither as a producer;
//   (b) a trailing `// --untracked-files=normal` comment on an otherwise
//       blind command — a substring check on the raw line passes;
//   (c) executors outside a fixed vocabulary (spawnSync, execFile, …).
// So: strip comments first, then scan the file as a whole for any argv
// (array literal or shell string) that runs `git status`, and require the
// flag inside that same command — wherever the command's text lives.

// Comments removed so a commented-out flag can never satisfy the check, and
// commented-out sample commands are never counted as producers.
//
// In a script, a comment is found by scanning the JS tokens that can hold its
// openers: strings, template literals (with their `${…}`) and regex literals
// are kept whole, and only a `//` or `/*` outside them opens a comment. A
// regex over the raw text cannot tell them apart: it read the glob string
// `'.claude/agentic-*/**'` as opening a block comment that ran to the next
// `*/` and hid every producer between them, which is how the peer-snapshot
// exception went unseen while a pathspec held one; and a rule that asks for a
// blank before `/*` misses a comment glued to a string, letting a flag in it
// pass. A block comment keeps its line breaks, so reported lines stay true.
//
// Markdown has no JS comments in its prose, and its apostrophes and quotes
// are no strings, so in a `.md` file only a `//` after a blank (or at a line's
// start) ends the line, never a URL's.
const REGEX_AFTER = /(?:^|[(,=:[!&|?{};+\-*%<>~^])$|(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new)$/;

// The end (exclusive) of a quoted string opened at `start`: its unescaped
// quote or, unterminated, the line's end.
function quotedEnd(text, start, quote) {
  let i = start + 1;
  while (i < text.length && text[i] !== quote && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
  return Math.min(text.length, text[i] === quote ? i + 1 : i);
}

// The end of a regex literal opened at `start`: its unescaped `/` outside a
// `[...]` class, then its flags; it never spans a line.
function regexEnd(text, start) {
  let i = start + 1;
  let inClass = false;
  while (i < text.length && text[i] !== '\n') {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      i += 1;
      while (/[a-z]/i.test(text[i] || '')) i += 1;
      return i;
    }
    i += 1;
  }
  return i;
}

// Template text from `start` (just after a backtick, or after the `}` that
// closes a `${`): its end, and whether it stopped at a `${` (back to code).
function templateEnd(text, start) {
  let i = start;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '`') return { end: i + 1, open: false };
    if (text[i] === '$' && text[i + 1] === '{') return { end: i + 2, open: true };
    i += 1;
  }
  return { end: text.length, open: false };
}

function stripComments(text, { markdown = false } = {}) {
  if (markdown) return text.split('\n').map((line) => line.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
  let out = '';
  let tail = '';       // the code just before the cursor, for REGEX_AFTER
  const depths = [];   // the brace depth inside each open `${`
  let i = 0;
  const keep = (end, value) => { out += text.slice(i, end); i = end; if (value) tail = 'x'; };
  const template = (start) => {
    const t = templateEnd(text, start);
    keep(t.end, !t.open);
    if (t.open) { depths.push(0); tail = '{'; }
  };
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      const e = text.indexOf('\n', i);
      i = e === -1 ? text.length : e;
      tail += ' ';
      continue;
    }
    if (c === '/' && d === '*') {
      const e = text.indexOf('*/', i + 2);
      const end = e === -1 ? text.length : e + 2;
      out += text.slice(i, end).replace(/[^\n]/g, '');
      i = end;
      tail += ' ';
      continue;
    }
    if (c === "'" || c === '"') { keep(quotedEnd(text, i, c), true); continue; }
    if (c === '`') { template(i + 1); continue; }
    // A postfix `++` or `--` ends a value, so a `/` after it divides.
    const before = tail.trimEnd();
    if (c === '/' && REGEX_AFTER.test(before) && !/(\+\+|--)$/.test(before)) { keep(regexEnd(text, i), true); continue; }
    if (depths.length > 0 && c === '{') depths[depths.length - 1] += 1;
    if (depths.length > 0 && c === '}') {
      if (depths[depths.length - 1] === 0) {
        depths.pop();
        template(i + 1);
        continue;
      }
      depths[depths.length - 1] -= 1;
    }
    out += c;
    tail = (tail + c).slice(-16);
    i += 1;
  }
  return out;
}

// Consequence worth knowing before writing docs: a prose line that QUOTES an
// executable-shaped command (`[ -n "$(git status --porcelain …)" ]`) is
// indistinguishable from the real thing to any static rule, and will be
// reported. That is the correct trade — a matcher lenient enough to tell them
// apart is lenient enough to miss a real producer — so describe such commands
// in words rather than pasting a runnable shape.
// Markdown prose lines (bullets, quotes) are not executable; a fenced shell
// snippet is. Rather than parse markdown, require an execution shape: a
// shell pipeline/gate (`| shasum`, `$(...)`, `if [ -n ...`) or an assignment.
const MD_EXEC_SHAPE = /(\|\s*shasum|\$\(|^\s*[A-Z_]+=)/;

// One `git status` invocation, in any of the shapes this repo uses.
// Array form:  ['status', '--porcelain=v1', '-z']  (possibly with leading
//              global flags like '--no-optional-locks')
// String form: 'git status --porcelain=v1 -z'  /  git -C "$X" status --porcelain
const ARRAY_STATUS = /\[[^\]]*['"]status['"][^\]]*\]/g;
const STRING_STATUS = /git\s+(?:-C\s+[^\s]+\s+)?status[^'"`\n)]*/g;

function producersIn(text, { markdown }) {
  const clean = stripComments(text, { markdown });
  const found = [];
  for (const m of clean.matchAll(ARRAY_STATUS)) {
    // An argv array is only a producer if it asks for machine-readable or
    // short output (a `['status']` inside unrelated data is not).
    if (!/--porcelain|--short/.test(m[0])) continue;
    found.push({ text: m[0], index: m.index });
  }
  for (const m of clean.matchAll(STRING_STATUS)) {
    if (!/--porcelain|--short/.test(m[0])) continue;
    if (markdown) {
      const lineStart = clean.lastIndexOf('\n', m.index) + 1;
      const lineEnd = clean.indexOf('\n', m.index);
      const line = clean.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      if (!MD_EXEC_SHAPE.test(line)) continue;
    }
    found.push({ text: m[0], index: m.index });
  }
  return found.map((f) => ({
    ...f,
    line: clean.slice(0, f.index).split('\n').length,
  }));
}

describe('drift-digest — structural: every git status producer carries --untracked-files=normal', () => {
  const offenders = [];
  const seenProducers = [];
  const preservedSeen = new Map(PRESERVED_UNO.map(({ file }) => [file, 0]));
  const unexpectedUno = [];

  before(() => {
    for (const pkg of PACKAGES) {
      for (const file of walk(path.join(REPO_ROOT, 'plugins', pkg))) {
        const rel = path.relative(REPO_ROOT, file);
        const raw = readFileSync(file, 'utf8');
        const markdown = path.extname(file) === '.md';
        for (const producer of producersIn(raw, { markdown })) {
          // `git worktree list --porcelain` is a different command, unaffected
          // by status.showUntrackedFiles.
          if (/worktree\s+list/.test(producer.text)) continue;
          const where = `${rel}:${producer.line}`;
          if (/--untracked-files=no\b/.test(producer.text)) {
            if (preservedException(rel, producer.text)) preservedSeen.set(rel, preservedSeen.get(rel) + 1);
            else unexpectedUno.push(`${where} — ${producer.text.trim()}`);
            continue;
          }
          seenProducers.push(where);
          if (!/--untracked-files=normal\b/.test(producer.text)) {
            offenders.push(`${where} — ${producer.text.trim()}`);
          }
        }
      }
    }
  });

  it('finds no producer missing the flag', () => {
    // Contract: the scripts' clean-baseline and digest code, and the agent
    // running a runbook's STATUS_DIGEST / CURRENT_DIGEST line, whose digest
    // state.mjs records and resume compares — a producer without
    // --untracked-files=normal sees no untracked file under
    // status.showUntrackedFiles=no, so a dirty tree passes as clean.
    assert.deepEqual(offenders, [], `producers blind to untracked files:\n${offenders.join('\n')}`);
  });

  it('is non-vacuous: the sweep actually reached the known producer population', () => {
    // Guards against a regex that silently matches nothing (a green sweep
    // over zero files proves nothing). The floor is well below the measured
    // 46 so ordinary refactors do not trip it.
    assert.ok(
      seenProducers.length >= 40,
      `structural sweep found only ${seenProducers.length} producers — the matcher likely stopped matching`,
    );
  });

  it('finds no --untracked-files=no outside the deliberate exceptions', () => {
    assert.deepEqual(unexpectedUno, [], `unexpected --untracked-files=no:\n${unexpectedUno.join('\n')}`);
  });

  it('each intentional --untracked-files=no survives exactly once, by identity (file and detected argv)', () => {
    for (const { file } of PRESERVED_UNO) {
      assert.equal(preservedSeen.get(file), 1, `the deliberate -uno producer in ${file} must remain exactly once, with its argv`);
    }
  });

  it('an exception is its file and its argv: a changed argv in the same file is unexpected', () => {
    const snapshot = 'plugins/designer/scripts/lib/peer-snapshot.mjs';
    // The file's command, changed, with the original argv left in a comment:
    // the comment is gone once stripped, and the command is no exception.
    const changed = producersIn(`run(['status', '--porcelain', '--untracked-files=no']); // ${PEER_SNAPSHOT_UNO}`, { markdown: false });
    assert.equal(changed.length, 1);
    assert.equal(preservedException(snapshot, changed[0].text), null);
    // The exact argv in another file is no exception either.
    assert.equal(preservedException('plugins/runtime/scripts/other.mjs', PEER_SNAPSHOT_UNO), null);
    assert.notEqual(preservedException(snapshot, PEER_SNAPSHOT_UNO), null);
  });
});

describe('drift-digest — structural: the comment stripper', () => {
  const PRODUCER = "run(['status', '--porcelain']);";
  const detected = (lines, markdown = false) => producersIn(lines.join('\n'), { markdown }).map((p) => p.text);

  it('keeps a producer after a string that holds a comment opener', () => {
    // The shape that hid the peer-snapshot exception: a glob string holding
    // `/*` well before the producer, and a `*/` only after it.
    assert.deepEqual(detected(["const SPECS = ['.claude/agentic-*/**'];", PRODUCER, '/* end */']), ["['status', '--porcelain']"]);
    assert.deepEqual(detected(["const glob = 'x/**';", "const marker = ' /*/';", PRODUCER, '/* end */']), ["['status', '--porcelain']"]);
  });

  it('keeps a producer after a regex literal or a template that holds a comment opener', () => {
    // A class holds `/*` unescaped, and a `/` inside it does not end the regex.
    assert.deepEqual(detected(['const re = /[/*]x/g;', PRODUCER, '/* end */']), ["['status', '--porcelain']"]);
    assert.deepEqual(detected(['if (!x) return /[/]x[/*]/.test(y);', PRODUCER, '/* end */']), ["['status', '--porcelain']"]);
    assert.deepEqual(detected(["const t = `a ${f({ b: '/*' })} /* c`;", PRODUCER, '/* end */']), ["['status', '--porcelain']"]);
  });

  it('removes a real comment, so a flag inside it never counts', () => {
    // Glued to a string, after a blank, and as a line comment inside the argv.
    assert.deepEqual(detected(["run(['status', '--porcelain'/* '--untracked-files=normal' */]);"]), ["['status', '--porcelain']"]);
    assert.deepEqual(detected(["run(['status', '--porcelain', /* '--untracked-files=normal' */]);"]), ["['status', '--porcelain', ]"]);
    assert.deepEqual(detected(["run(['status', '--porcelain', // '--untracked-files=normal'", ']);']), ["['status', '--porcelain', \n]"]);
    // A commented-out command is no producer, and a removed block keeps the
    // line count, so a reported line stays true.
    assert.deepEqual(detected(["/* run(['status', '--porcelain']);", '*/']), []);
    // A `/` after a postfix `++` divides: no regex literal hides the comment.
    assert.deepEqual(
      detected(["let i = 1; const n = i++ / 2; run(['status', '--porcelain'/* '--untracked-files=normal' */]);"]),
      ["['status', '--porcelain']"],
    );
    assert.equal(producersIn(['/*', '', '*/', PRODUCER].join('\n'), { markdown: false })[0].line, 4);
  });

  it('in markdown, ends a line at a // after a blank only, never at a URL', () => {
    // A line commented out after a blank, or at the line's start, holds no
    // producer; the same line uncommented does.
    assert.deepEqual(detected(['// X="$(git status --porcelain)"'], true), []);
    assert.deepEqual(detected(['echo ok // X="$(git status --porcelain)"'], true), []);
    assert.deepEqual(detected(['X="$(git status --porcelain)"'], true), ['git status --porcelain']);
    assert.deepEqual(detected(["see https://example.test; X=\"$(git status --porcelain)\""], true), ['git status --porcelain']);
  });
});
