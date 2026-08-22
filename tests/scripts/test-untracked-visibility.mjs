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
//      revert of one of the 46 sites) from shipping blind. The one
//      deliberate exception is pinned by identity, not by count.
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
//   * `gitStatusDigest` (adapters/*/hooks/_shared.mjs) -> the status DIGEST
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
  // One digest producer per package (the hook _shared / stop copies are the
  // digest family; the persona gates above are the classify family).
  const DIGEST_PRODUCERS = [
    ['designer', 'plugins/designer/adapters/claude/hooks/_shared.mjs'],
    ['designer-codex', 'plugins/designer/adapters/codex/hooks/_shared.mjs'],
    ['engineer', 'plugins/engineer/adapters/claude/hooks/_shared.mjs'],
    ['founder', 'plugins/founder/adapters/claude/hooks/_shared.mjs'],
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

// The single deliberate exception, pinned by IDENTITY (file + the exact
// argv), not by a count: a count would silently absorb a second blind
// producer appearing while this one is removed.
const PRESERVED_UNO = {
  file: 'plugins/runtime/scripts/migrate-workflow-storage.mjs',
  needle: "['status', '--porcelain', '--untracked-files=no']",
};

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

// Line/block comments removed so a commented-out flag can never satisfy the
// check, and commented-out sample commands are never counted as producers.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')          // /* ... */
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))  // // ...
    .join('\n');
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
  const clean = stripComments(text);
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
  let preservedSeen = 0;

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
            assert.equal(rel, PRESERVED_UNO.file, `unexpected --untracked-files=no at ${where}`);
            preservedSeen += 1;
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

  it('the one intentional --untracked-files=no survives, by identity', () => {
    assert.equal(preservedSeen, 1, 'the deliberate -uno producer must remain exactly once');
    const text = readFileSync(path.join(REPO_ROOT, PRESERVED_UNO.file), 'utf8');
    assert.ok(text.includes(PRESERVED_UNO.needle), 'the preserved -uno argv changed shape');
  });
});
