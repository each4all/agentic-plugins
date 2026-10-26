// ADR-0068 Decision 5, item 4 — the checks the driver adds before a
// verification batch (plugins/orchestrator/adapters/claude/autopilot/
// verify-select.mjs).
//
// Each rule has its cases here, and scripts/mutation-specs/verify-select.mjs
// breaks each one and names the case that must notice:
//   - every change counts: committed or not, tracked or untracked, deleted
//     by its path, renamed by both paths, a moved submodule, in a git
//     environment it ignores; a file an index flag hides throws;
//   - the tokenizer reads literals, decoded, never comments or regular
//     expressions, ends a line at every line terminator, and a / it cannot
//     place next to a literal is uncertain;
//   - a module may read a file by a named suffix, by literals that cover its
//     path (one free segment, never the basename, with path evidence), or by
//     walking or copying a directory one literal names, or a walk takes
//     whole: a tree walk reads all of it, a plain readdir one level;
//   - only executable references are edges: imports, the runner's preloads,
//     the modules a computed import or a started process (fork and Worker
//     too) names in literals, and the modules a test hands a helper that
//     starts them; a comment naming a file is none; a test is as uncertain
//     as what it imports;
//   - a pipeline source counts as its copies and a copy as its sources and
//     their other copies, from base and tree; a broken or empty map widens;
//     the generator, what it reads and the personas' declarations add the
//     pipeline's check;
//   - a mutation spec that anchors a change selects its tests and its check,
//     never by what those tests or the tools it starts read; an uncertain
//     spec is checked unrestricted; the declaration's adds_on and mappings
//     add the rest;
//   - no match selects the suite, as does the test kind added unrestricted,
//     and a declaration with no suite kind throws; the worker's checks are
//     kept, never repeated;
//   - on this repository: the C150 change, persona.json through
//     _personas.mjs, the reads a review found missed, an unknown file, and
//     bounds on the selection's size and time.
// The backtest replay is test-autopilot-verify-select-backtest.mjs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as vs from '../../plugins/orchestrator/adapters/claude/autopilot/verify-select.mjs';
import { DEFAULT_TEST_PATTERN as NODE_PATTERN, listTestFiles } from '../../scripts/lib/discover-tests.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULE_REL = 'plugins/orchestrator/adapters/claude/autopilot/verify-select.mjs';

// The declaration the verification lanes write (.agentic-plugins/verify-checks.json).
const DECL = Object.freeze({
  schema: 'agentic-verify-checks-1.0',
  kinds: {
    'test-suite': { argv: ['npm', 'test'], slots: [], timeout_s: 7200, locks_itself: false, adds_on: [] },
    test: {
      argv: ['npm', 'test', '--', '{files}'],
      slots: [{ name: 'files', type: 'path', repeat: 'many', join: 'words', under: ['tests/', 'companions/tests/', 'kit/'], suffix: '.mjs' }],
      timeout_s: 3600, locks_itself: false, adds_on: [],
    },
    mutate: {
      argv: ['npm', 'run', 'mutate', '--', '{spec}', '--only', '{ids}'],
      slots: [
        { name: 'spec', type: 'path', repeat: 'one', under: ['scripts/mutation-specs/'], suffix: '.mjs' },
        { name: 'ids', type: 'id', repeat: 'many', join: 'comma' },
      ],
      timeout_s: 14400, locks_itself: true, adds_on: [],
    },
    'mutate-static': {
      argv: ['npm', 'run', 'mutate:static', '{specs}'],
      slots: [{ name: 'specs', type: 'path', repeat: 'optional-many', join: 'words', under: ['scripts/mutation-specs/'], suffix: '.mjs', lead: ['--'] }],
      timeout_s: 1800, locks_itself: false, adds_on: ['scripts/mutation-specs/*.mjs'],
    },
    'sync-persona-pipeline': { argv: ['npm', 'run', 'sync:persona-pipeline'], slots: [], timeout_s: 600, locks_itself: false, adds_on: ['persona-pipeline/**'] },
    'lint-plugin-shape': { argv: ['npm', 'run', 'lint:plugin-shape'], slots: [], timeout_s: 600, locks_itself: false, adds_on: ['plugins/**'] },
  },
  mappings: [],
});
const withMappings = (mappings) => ({ ...DECL, mappings });

const kinds = (r) => r.additions.map((a) => a.kind);
const addition = (r, kind) => r.additions.find((a) => a.kind === kind);
const reasonsFor = (r, test) => r.reasons.entries.filter((e) => e.test === test);
const changed = (...paths) => paths.map((p) => ({ path: p, status: 'M' }));

// A selection over an in-memory tree (and base, the tree unless given).
function select(files, changes, { base = files, declaration = DECL, requested = [] } = {}) {
  return vs.selectChecks({
    tree: vs.memoryReader(files), base: vs.memoryReader(base), changes, requested, declaration, maxListed: 100000,
  });
}

// ---------------------------------------------------------------------------
// git fixtures

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
  cwd, encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'],
});
function put(root, rel, text) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
}
function tempDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}
function initRepo(files) {
  const dir = tempDir('vs-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  for (const [rel, text] of Object.entries(files)) put(dir, rel, text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

// The repository's own tree, read from disk without git: a mutation copy has
// no .git.
function fsTree(root, overrides = {}) {
  const list = [];
  const walk = (rel) => {
    for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules' || p === '.agentic-plugins') continue;
        walk(p);
      } else if (e.isFile()) list.push(p);
    }
  };
  walk('');
  list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const cache = new Map();
  return {
    list: () => list,
    read(p) {
      if (Object.hasOwn(overrides, p)) return overrides[p];
      if (!cache.has(p)) {
        let text = null;
        try { if (lstatSync(path.join(root, p)).isFile()) text = readFileSync(path.join(root, p), 'utf8'); } catch { text = null; }
        cache.set(p, text);
      }
      return cache.get(p);
    },
  };
}

// ---------------------------------------------------------------------------

describe('verify-select — every change counts (R1)', () => {
  function scenario() {
    const dir = initRepo({
      'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n', 'old name.txt': 'o\n', 'sub/del.txt': 'd\n',
      'keep/x.txt': 'k\n', '.gitignore': '*.log\n',
    });
    const base = git(dir, 'rev-parse', 'HEAD').trim();
    put(dir, 'a.txt', 'a2\n');
    git(dir, 'commit', '-q', '-am', 'one');
    put(dir, 'b.txt', 'b2\n');
    git(dir, 'add', 'b.txt');
    put(dir, 'c.txt', 'c2\n');
    git(dir, 'mv', 'old name.txt', 'new 이름.txt');
    git(dir, 'rm', '-q', 'sub/del.txt');
    put(dir, 'u.txt', 'u\n');
    put(dir, 'x.log', 'ignored\n');
    return { dir, base };
  }
  const EXPECTED = [
    { path: 'a.txt', status: 'M' },
    { path: 'b.txt', status: 'M' },
    { path: 'c.txt', status: 'M' },
    { path: 'new 이름.txt', status: 'A' },
    { path: 'old name.txt', status: 'D', old: true },
    { path: 'sub/del.txt', status: 'D', old: true },
    { path: 'u.txt', status: 'U' },
  ];

  it('committed, staged, unstaged and untracked; a deletion by its path; a rename by both paths', () => {
    const { dir, base } = scenario();
    try {
      // Run from a subdirectory: every path is the repository's, not the cwd's.
      deepEqualChanges(vs.collectChanges({ cwd: path.join(dir, 'keep'), base }), EXPECTED);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('ignores an inherited GIT_DIR and GIT_INDEX_FILE that name another repository', () => {
    const { dir, base } = scenario();
    const other = initRepo({ 'elsewhere.txt': 'e\n' });
    const saved = { dir: process.env.GIT_DIR, index: process.env.GIT_INDEX_FILE };
    process.env.GIT_DIR = path.join(other, '.git');
    process.env.GIT_INDEX_FILE = path.join(other, '.git', 'index');
    try {
      deepEqualChanges(vs.collectChanges({ cwd: dir, base }), EXPECTED);
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved.dir;
      if (saved.index === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = saved.index;
      rmSync(dir, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('between two commits: only their difference, no untracked file', () => {
    const { dir, base } = scenario();
    try {
      const head = git(dir, 'rev-parse', 'HEAD').trim();
      deepEqualChanges(vs.collectChanges({ cwd: dir, base, head }), [{ path: 'a.txt', status: 'M' }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('throws when git fails: never an empty list', () => {
    const { dir } = scenario();
    try {
      assert.throws(() => vs.collectChanges({ cwd: dir, base: 'refs/heads/no-such-branch' }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('throws on a file git hides by an index flag: assume-unchanged or skip-worktree', () => {
    for (const flag of ['--assume-unchanged', '--skip-worktree']) {
      const dir = initRepo({ 'a.txt': 'a\n' });
      try {
        const base = git(dir, 'rev-parse', 'HEAD').trim();
        git(dir, 'update-index', flag, 'a.txt');
        put(dir, 'a.txt', 'edited\n');
        assert.deepEqual(git(dir, 'diff', '--name-only', base), '', `${flag}: git diff hides the edit`);
        assert.throws(() => vs.collectChanges({ cwd: dir, base }), /a\.txt is marked assume-unchanged or skip-worktree/, flag);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it('counts a submodule whose commit moved, whatever ignore setting it carries', () => {
    const sub = initRepo({ 's.txt': '1\n' });
    const dir = initRepo({ 'a.txt': 'a\n' });
    try {
      git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'mod');
      git(dir, 'commit', '-q', '-m', 'sub');
      const base = git(dir, 'rev-parse', 'HEAD').trim();
      git(dir, 'config', 'diff.ignoreSubmodules', 'all');
      git(dir, 'config', '-f', '.gitmodules', 'submodule.mod.ignore', 'all');
      put(path.join(dir, 'mod'), 's.txt', '2\n');
      git(path.join(dir, 'mod'), 'commit', '-q', '-am', 'move');
      assert.equal(git(dir, 'diff', '--name-only', base, '--', 'mod'), '', 'git diff alone hides it');
      assert.deepEqual(vs.collectChanges({ cwd: dir, base }).filter((c) => c.path === 'mod'), [{ path: 'mod', status: 'M' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sub, { recursive: true, force: true });
    }
  });
});

function deepEqualChanges(actual, expected) {
  assert.deepEqual(actual, expected);
}

describe('verify-select — the tokenizer', () => {
  const strings = (src) => vs.tokenize(src).tokens.filter((t) => t.k === 's').map((t) => t.v);

  it('reads quotes with escapes and templates with nested holes, and skips comments', () => {
    const src = [
      "const a = 'x\\'y/z.md'; const b = \"q/r.mjs\"; // 'comment/c.md'",
      "/* 'block/d.md' */ const t = `a/${f(`x/${y}`, 'n/m.md')}/e.md`;",
    ].join('\n');
    assert.deepEqual(strings(src), ["x'y/z.md", 'q/r.mjs', 'a/\u0000/e.md', 'x/\u0000', 'n/m.md']);
    assert.equal(vs.tokenize(src).uncertain, false);
  });

  it('skips a regular expression, and reads a division as one', () => {
    assert.deepEqual(strings("const re = /['\"]/g; const s = 'after.md';"), ['after.md']);
    assert.deepEqual(strings("const d = a / b / 2; const s = 'x.md';"), ['x.md']);
    const object = vs.tokenize("const o = {a: 1} / 2;\nconst s = 'y.md';");
    assert.deepEqual(object.tokens.filter((t) => t.k === 's').map((t) => t.v), ['y.md']);
    assert.equal(object.uncertain, false, 'after a `}` an open expression is a division, not an uncertainty');
  });

  it('marks a module uncertain when a literal, comment or regular expression has no end, or an escape cannot be read', () => {
    for (const src of ["const s = 'open", 'const t = `open', 'x = /unterminated\n', '/* open', 'const t = `a${b', "const s = '\\u{110000}';", "const s = '\\xZZ';"]) {
      assert.equal(vs.tokenize(src).uncertain, true, JSON.stringify(src));
    }
  });

  it('decodes escapes in strings and templates', () => {
    assert.deepEqual(strings("import '../src/\\u0068elper.mjs'; const t = `x\\x41/\\u{62}.md`; const n = 'a\\0b';"), ['../src/helper.mjs', 'xA/b.md', 'ab']);
  });

  it('reads a / after a control condition as a regular expression', () => {
    const src = "if (ok) /'data\\/value.json'/.test(x);\nconst s = 'after.md';";
    assert.deepEqual(strings(src), ['after.md']);
    assert.equal(vs.tokenize(src).uncertain, false);
  });

  it('a / after a postfix ++ is a division; after a } that could open a regular expression it keeps the literals and is uncertain', () => {
    for (const src of [
      "const n = x++ / readFileSync(join(ROOT, 'data', 'value.json')).length / 2;",
      "const n = y-- / readFileSync(join(ROOT, 'data', 'value.json')).length / 2;",
      "const n = x++ / /* c */ readFileSync(join(ROOT, 'data', 'value.json')).length / 2;",
    ]) {
      assert.deepEqual(strings(src), ['data', 'value.json'], src);
      assert.equal(vs.tokenize(src).uncertain, false, src);
    }
    assert.equal(vs.analyzeModule('const n = x++ / (await import(target)).value / 2;').computedImport, true, 'an import after the division is read');
    for (const src of [
      "const n = {a: 1} / readFileSync(join(ROOT, 'data', 'value.json')).length / 2;",
      "const n = {a: 1} / /* c */ readFileSync(join(ROOT, 'data', 'value.json')).length / 2;",
      "function f() {}\n/ab+c/.test(s); const q = 'data/value.json';",
    ]) {
      assert.ok(strings(src).includes('value.json') || strings(src).includes('data/value.json'), src);
      assert.equal(vs.tokenize(src).uncertain, true, src);
    }
  });

  it('a / after a property named by a keyword is a division', () => {
    for (const src of [
      "const n = obj.in / readFileSync(join(ROOT, 'data', 'value.json')).length / 2;",
      "const n = x.return / readFileSync(join(ROOT, 'data', 'value.json')).length / 2;",
      "const n = x?.typeof / readFileSync(join(ROOT, 'data', 'value.json')).length / 2;",
    ]) {
      assert.deepEqual(strings(src), ['data', 'value.json'], src);
      assert.equal(vs.tokenize(src).uncertain, false, src);
    }
    assert.deepEqual(strings("const r = typeof /'a.md'/;\nconst s = 'b.md';"), ['b.md'], 'the operator itself still opens a regular expression');
  });

  it('a line comment ends at every line terminator: CR, U+2028 and U+2029 as LF', () => {
    for (const end of ['\r', '\u2028', '\u2029', '\r\n']) {
      const src = `// note${end}const f = 'data/value.json';`;
      assert.deepEqual(strings(src), ['data/value.json'], JSON.stringify(end));
      assert.equal(vs.tokenize(src).uncertain, false, JSON.stringify(end));
    }
    assert.equal(vs.tokenize("const s = 'open\rconst t = 1;").uncertain, true, 'a string a CR ends is left open');
    assert.deepEqual(strings("const a = 1;\u2003/ignored/.test(x); const s = 'c.md';"), ['c.md'], 'Unicode white space is space, not punctuation');
  });
});

describe('verify-select — what a module may read (R4)', () => {
  const info = (src) => vs.analyzeModule(src);
  const covers = (src, mod, file) => vs.covers(info(src), file.split('/'), mod);
  const T = 'tests/plugin-shape/test-x.mjs';

  it('(b) literals that cover the path from the root: a directory and a built name (C150)', () => {
    const src = "const ENG = resolve(ROOT, 'plugins/engineer');\nread(`commands/${verb}.md`);";
    assert.equal(covers(src, T, 'plugins/engineer/commands/compose.md'), true);
  });

  it('(b) from the module\'s own directory or an ancestor', () => {
    const src = "const p = join(HERE, 'fixtures', 'x.json');";
    assert.equal(covers(src, 'tests/orchestrator/test-a.mjs', 'tests/orchestrator/fixtures/x.json'), true);
    assert.equal(covers("load('../shared/data.json');", 'tests/a/b/test-x.mjs', 'tests/a/shared/data.json'), true);
    assert.equal(covers(src, 'tests/orchestrator/test-a.mjs', 'a/b/fixtures/x.json'), false, 'two segments no literal names');
  });

  it('(b) at most one free segment', () => {
    assert.equal(covers('const f = `plugins/${p}/scripts/lib/args-file.mjs`;', T, 'plugins/x/scripts/lib/args-file.mjs'), true);
    assert.equal(covers('const f = `plugins/${p}/${q}/lib/args-file.mjs`;', T, 'plugins/x/scripts/lib/args-file.mjs'), false);
  });

  it('(b) the basename is never free, and a built basename needs a fixed segment beside it', () => {
    assert.equal(covers("const f = join(ROOT, 'plugins', 'engineer', name);", T, 'plugins/engineer/x.mjs'), false);
    assert.equal(covers("const d = 'plugins/engineer/commands';\nconst f = `${verb}.md`;", T, 'plugins/engineer/commands/compose.md'), false);
    assert.equal(covers("const d = 'plugins/engineer';\nconst f = `commands/${verb}.md`;", T, 'plugins/engineer/commands/compose.md'), true);
  });

  it('(b) a fixed segment must come from a literal with a / or a join/resolve call', () => {
    assert.equal(covers("const words = ['docs', 'README.md'];", T, 'docs/README.md'), false);
    assert.equal(covers("const f = join(ROOT, 'docs', 'README.md');", T, 'docs/README.md'), true);
    assert.equal(covers("const k = `r${i}`; const d = 'notes';", T, 'notes/r1'), false);
  });

  it('(b) a leading hole stands for a path another literal holds', () => {
    const src = "const AP = 'plugins/orchestrator/adapters/claude/autopilot';\nconst POLICY = `${AP}/policy.mjs`;";
    assert.equal(covers(src, 'scripts/mutation-specs/x.mjs', 'plugins/orchestrator/adapters/claude/autopilot/policy.mjs'), true);
  });

  // A hole inside a segment makes no rest piece, so only the piece itself,
  // tried where its first segment begins, covers the path; a fixed piece that
  // begins with the same segment is tried there too.
  it('(b) a hole inside the first segment, beside a fixed piece of that segment', () => {
    const src = "const a = 'codex-cli/README.md';\nconst p = `${name}-cli/index.mjs`;";
    assert.equal(covers(src, 'companions/x.mjs', 'companions/codex-cli/index.mjs'), true);
    assert.equal(covers(src, 'companions/x.mjs', 'companions/codex-srv/index.mjs'), false);
  });

  it('(c) a directory the module walks, which its literals name together', () => {
    const walk = "for (const f of readdirSync(join(ROOT, 'tests', 'fixtures'))) use(f);";
    assert.equal(vs.mayRead(info(walk), 'tests/fixtures/deep/b.json', 'tests/x/test-a.mjs'), 'dir');
    assert.equal(vs.mayRead(info(walk.replace('readdirSync', 'statSync')), 'tests/fixtures/deep/b.json', 'tests/x/test-a.mjs'), null);
    // One literal segment and a variable name no directory, nor do two
    // segments from separate literals.
    assert.equal(vs.mayRead(info("readdirSync(join(ROOT, 'plugins', name));"), 'plugins/engineer/x/y.md', 'tests/x/test-a.mjs'), null);
    assert.equal(vs.mayRead(info("const top = join(ROOT, 'docs');\nreaddirSync(join(top, 'adr'));"), 'docs/adr/0001-x.md', 'tests/x/test-a.mjs'), null);
  });

  it('(c) a directory of one segment, which a walk takes: in its arguments or through the names it is assigned to', () => {
    const T = 'tests/x/test-a.mjs';
    const deep = "function walkTree(dir) { for (const e of readdirSync(dir)) walkTree(join(dir, e)); }\n";
    assert.equal(vs.mayRead(info(`${deep}walkTree(join(REPO_ROOT, 'plugins'));`), 'plugins/engineer/commands/x.md', T), 'dir');
    assert.equal(vs.mayRead(info("for (const f of readdirSync('data')) use(f);"), 'data/value.json', T), 'dir');
    assert.equal(vs.mayRead(info("const FIX = join(import.meta.dirname, 'fixtures');\nfor (const f of readdirSync(FIX)) use(f);"), 'tests/x/fixtures/a.json', T), 'dir');
    assert.equal(vs.mayRead(info("const roots = [join(ROOT, 'docs')];\nfor (const r of roots) for (const f of readdirSync(r)) use(f);"), 'docs/a.md', T), 'dir', 'through a for-of name');
    assert.equal(vs.mayRead(info(`${deep}walkTree(\`\${REPO_ROOT}/plugins\`);`), 'plugins/x/a.md', T), 'dir', 'a leading hole is a root');
    assert.equal(vs.mayRead(info('readdirSync(`${STATE}/fixtures`);'), 'tests/x/fixtures/a.json', T), null, 'the root, never the module\'s own directory');
    // A literal no walk takes names no directory, however the module walks,
    // nor does one assigned to the same name in another block.
    assert.equal(vs.mayRead(info("const P = join(ROOT, 'plugins');\nfor (const f of readdirSync(tmp)) use(f);"), 'plugins/x.md', T), null);
    assert.equal(vs.mayRead(info("function a() { const dir = join(ROOT, 'docs'); return dir; }\nfunction b(dir) { return readdirSync(dir); }"), 'docs/x.md', T), null);
    // A climb names the directory it reaches, from the module's own only.
    const mod = 'plugins/engineer/scripts/lib/x.mjs';
    assert.equal(vs.mayRead(info("readdirSync(resolve(HERE, '..', '..', '..', 'orchestrator'));"), 'plugins/orchestrator/a.json', mod), 'dir');
    assert.equal(vs.mayRead(info("readdirSync(join(HERE, 'orchestrator'));"), 'plugins/orchestrator/a.json', mod), null, 'no other ancestor');
    assert.equal(vs.mayRead(info("readdirSync(`${STATE}/orchestrator`);"), 'plugins/orchestrator/a.json', mod), null, 'a leading hole is the root, never an ancestor');
  });

  it('(c) a plain readdir reads the files directly in the directory; a tree walk, a copy or a recursive read reads all of it', () => {
    const T = 'tests/x/test-a.mjs';
    const shallow = "for (const f of readdirSync(join(ROOT, 'data'))) use(f);";
    assert.equal(vs.mayRead(info(shallow), 'data/value.json', T), 'dir');
    assert.equal(vs.mayRead(info(shallow), 'data/deep/value.json', T), null);
    assert.equal(vs.mayRead(info(`mkdirSync(join(ROOT, 'out'), { recursive: true });\n${shallow}`), 'data/deep/value.json', T), null, 'mkdir\'s recursive option walks nothing');
    for (const src of [
      "for (const f of readdirSync(join(ROOT, 'data'), { recursive: true })) use(f);",
      "async function collect(dir) { for (const e of await readdir(dir)) await collect(join(dir, e)); }\nawait collect(join(ROOT, 'data'));",
      "const collect = (dir) => { for (const e of readdirSync(dir)) collect(join(dir, e)); };\ncollect(join(ROOT, 'data'));",
      "cpSync(join(ROOT, 'data'), tmp, { force: true });",
    ]) assert.equal(vs.mayRead(info(src), 'data/deep/value.json', T), 'dir', src);
  });

  it('(c) a copy reads the directory it copies', () => {
    const T = 'tests/x/test-a.mjs';
    for (const call of ['cpSync', 'cp']) {
      assert.equal(vs.mayRead(info(`${call}(join(ROOT, 'fixtures/tree'), tmp);`), 'fixtures/tree/a/b.json', T), 'dir', call);
    }
  });

  it('(a) a named suffix of two segments or more, bounded by non-path characters', () => {
    const F = 'plugins/orchestrator/adapters/claude/autopilot/budget.mjs';
    assert.equal(vs.namesSuffix('see autopilot/budget.mjs here', F), true);
    assert.equal(vs.namesSuffix('see autopilot/budget.mjs.', F), true);
    assert.equal(vs.namesSuffix('see budget.mjs here', F), false);
    assert.equal(vs.namesSuffix('see autopilot/budget.mjs.bak', F), false);
    assert.equal(vs.namesSuffix('see xautopilot/budget.mjs', F), false);
  });

  it('a literal names a file by its decoded value, escapes and all', () => {
    assert.equal(vs.mayRead(info("const f = 'data/v\\u0061lue.json';"), 'data/value.json', T), 'suffix');
    assert.equal(vs.mayRead(info("const f = join(ROOT, 'd\\x61ta', 'v\\u{61}lue.json');"), 'data/value.json', T), 'cover');
    const r = select({ 'data/value.json': '1\n', 'tests/test-e.mjs': "const f = 'data/v\\u0061lue.json';\n" }, changed('data/value.json'));
    assert.deepEqual(r.tests, { files: ['tests/test-e.mjs'] });
  });

  it('(a) a file of one segment is named only as itself, in a string literal', () => {
    assert.equal(vs.mayRead(info("const f = 'README.md';"), 'README.md', T), 'suffix');
    assert.equal(vs.mayRead(info('// see README.md\nconst x = 1;'), 'README.md', T), null);
    assert.equal(vs.mayRead(info("const f = 'docs/README.md';"), 'README.md', T), null);
  });
});

describe('verify-select — discovery and the import graph (R3, R5)', () => {
  it('discovers the files `node --test` runs, as scripts/lib/discover-tests.mjs does', () => {
    assert.equal(vs.DEFAULT_TEST_PATTERN, NODE_PATTERN);
    const dir = tempDir('vs-discover-');
    try {
      for (const rel of ['test.js', 'a/test-b.mjs', 'a/c.test.cjs', 'a/d_test.ts', '.hid/test-e.mjs', 'node_modules/p/test-f.mjs', 'b/test/g.js', 'b/notatest.mjs']) put(dir, rel, '\n');
      symlinkSync('a', path.join(dir, 'lnk'));
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'add', '-A', '-f');
      git(dir, 'commit', '-q', '-m', 'fixture');
      const node = listTestFiles(dir);
      assert.ok(node.includes('a/d_test.ts') && node.includes('a/c.test.cjs') && !node.some((p) => p.startsWith('.hid/') || p.startsWith('node_modules/') || p.startsWith('lnk/')), node.join(' '));
      assert.deepEqual(vs.discoverTests(vs.gitReader({ cwd: dir, commit: 'HEAD' })), node);
      assert.deepEqual(vs.discoverTests(vs.diskReader(dir)), node);
      const listed = vs.gitReader({ cwd: dir, commit: 'HEAD' }).list();
      assert.deepEqual(vs.discoverTests(vs.memoryReader(Object.fromEntries(listed.map((p) => [p, '\n'])))), node);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  const graphTree = {
    'tests/test-a.mjs': "import '../src/a.mjs';\n",
    'src/a.mjs': '// see src/c.mjs for the reader\nexport const a = 1;\n',
    'src/c.mjs': "import './d.mjs';\n",
    'src/d.mjs': 'export const d = 1;\n',
    'tests/test-d.mjs': "import { d } from '../src/d.mjs';\n",
    'tests/test-t.mjs': "import '../src/b.mjs';\n",
    'src/b.mjs': "export * from './e.mjs';\n",
    'src/e.mjs': "import './f.mjs';\n",
    'src/f.mjs': 'export const f = 1;\n',
    'tests/test-c.mjs': 'const m = await import(`../src/plug/${name}.mjs`);\n',
    'src/plug/one.mjs': "import '../../lib/g.mjs';\n",
    'lib/g.mjs': 'export const g = 1;\n',
    'tests/test-u.mjs': "import { x } from './gone.mjs';\n",
  };

  it('follows imports through other modules', () => {
    const r = select(graphTree, changed('src/f.mjs'));
    assert.deepEqual(r.tests, { files: ['tests/test-t.mjs'] });
    assert.deepEqual(reasonsFor(r, 'tests/test-t.mjs').map((e) => e.rule), ['import']);
  });

  it('a comment naming a file is no edge: the file is read, its imports are not', () => {
    const viaComment = select(graphTree, changed('src/c.mjs'));
    assert.deepEqual(viaComment.tests, { files: ['tests/test-a.mjs'] });
    assert.deepEqual(reasonsFor(viaComment, 'tests/test-a.mjs').map((e) => [e.rule, e.module]), [['suffix', 'src/a.mjs']]);
    assert.deepEqual(select(graphTree, changed('src/d.mjs')).tests, { files: ['tests/test-d.mjs'] });
  });

  it('a test\'s computed import is an edge to each module its literals cover', () => {
    const r = select(graphTree, changed('lib/g.mjs'));
    assert.deepEqual(r.tests, { files: ['tests/test-c.mjs'] });
    assert.equal(reasonsFor(r, 'tests/test-c.mjs')[0].rule, 'import');
  });

  it('an import that resolves to no file names it, so its deletion selects the test', () => {
    const r = select(graphTree, [{ path: 'tests/gone.mjs', status: 'D', old: true }]);
    assert.deepEqual(r.tests, { files: ['tests/test-u.mjs'] });
  });

  it('an import the tree no longer resolves resolves against the fork point: a deleted file keeps its importers', () => {
    const tree = {
      'tests/test-a.mjs': "const a = require('../src/a');\n",
      'tests/test-b.mjs': "const p = 'src/a.js';\n",
    };
    const r = select(tree, [{ path: 'src/a.js', status: 'D', old: true }], { base: { ...tree, 'src/a.js': 'module.exports = 1;\n' } });
    assert.deepEqual(r.tests, { files: ['tests/test-a.mjs', 'tests/test-b.mjs'] });
    assert.deepEqual(reasonsFor(r, 'tests/test-a.mjs').map((e) => e.rule), ['import']);
  });

  it('a computed import is an edge in any test directory, and a bare new URL specifier is relative', () => {
    const tree = {
      'companions/tests/test-c.mjs': 'const m = await import(`../../src/plug/${name}.mjs`);\n',
      'src/plug/one.mjs': "const f = 'data/one.json';\n",
      'tests/test-u.mjs': "const h = new URL('helper.mjs', import.meta.url);\n",
      'tests/helper.mjs': "const f = 'data/two.json';\n",
      'tests/test-z.mjs': "const f = ['data/one.json', 'data/two.json'];\n",
    };
    assert.deepEqual(select(tree, changed('data/one.json')).tests, { files: ['companions/tests/test-c.mjs', 'tests/test-z.mjs'] });
    assert.deepEqual(select(tree, changed('data/two.json')).tests, { files: ['tests/test-u.mjs', 'tests/test-z.mjs'] });
  });

  it('a computed import outside the tests is an edge too: a script that loads a library by its path', () => {
    const tree = {
      'tools/gen.mjs': "const m = await import(pathToFileURL(join(ROOT, 'lib/schema.mjs')).href);\n",
      'lib/schema.mjs': "import './contain.mjs';\n",
      'lib/contain.mjs': 'export const c = 1;\n',
      'tests/test-gen.mjs': "import '../tools/gen.mjs';\n",
    };
    const r = select(tree, changed('lib/contain.mjs'));
    assert.deepEqual(r.tests, { files: ['tests/test-gen.mjs'] });
    assert.deepEqual(reasonsFor(r, 'tests/test-gen.mjs').map((e) => e.rule), ['import']);
  });

  it('a process a module starts is an edge to each module its literals name, never one a comment names', () => {
    const tree = {
      'tests/test-cli.mjs': [
        "import { spawnSync } from 'node:child_process';",
        "const SCRIPTS = resolve(ROOT, 'plugins/x/scripts');",
        "spawnSync(process.execPath, [join(SCRIPTS, 'run.mjs')]);",
      ].join('\n'),
      'tests/test-note.mjs': "import { spawnSync } from 'node:child_process';\n// runs plugins/x/scripts/run.mjs\nspawnSync('true');\n",
      'plugins/x/scripts/run.mjs': "import { inspect } from './inspect.mjs';\n",
      'plugins/x/scripts/inspect.mjs': 'export const inspect = 1;\n',
    };
    const r = select(tree, changed('plugins/x/scripts/inspect.mjs'));
    assert.deepEqual(r.tests, { files: ['tests/test-cli.mjs'] });
    assert.deepEqual(reasonsFor(r, 'tests/test-cli.mjs').map((e) => e.rule), ['import']);
    assert.deepEqual(select(tree, changed('plugins/x/scripts/run.mjs')).tests, { files: ['tests/test-cli.mjs', 'tests/test-note.mjs'] },
      'the comment still reads the file it names');
  });

  it('a module loaded from a directory a loader walks is an edge', () => {
    const tree = {
      'tests/test-walk.mjs': "for (const f of readdirSync(join(ROOT, 'src/plugins'))) await import(join(ROOT, 'src/plugins', f));\n",
      'src/plugins/one.mjs': "import '../../lib/dependency.mjs';\n",
      'lib/dependency.mjs': 'export const d = 1;\n',
      'tests/test-direct.mjs': "import '../lib/dependency.mjs';\n",
    };
    const r = select(tree, changed('lib/dependency.mjs'));
    assert.deepEqual(r.tests, { files: ['tests/test-direct.mjs', 'tests/test-walk.mjs'] });
    assert.deepEqual(reasonsFor(r, 'tests/test-walk.mjs').map((e) => e.rule), ['import']);
  });

  it('a script a test hands to a helper that starts it, or imports it, is an edge', () => {
    const tree = {
      'tests/_helpers.mjs': "import { spawnSync } from 'node:child_process';\nexport const runNode = (args) => spawnSync(process.execPath, args);\nexport const load = (p) => import(p);\n",
      'tests/test-run.mjs': "import { runNode } from './_helpers.mjs';\nconst CLI = resolve(ROOT, 'plugins/x/scripts/dashboard.mjs');\nrunNode([CLI]);\n",
      'tests/test-load.mjs': "import { load } from './_helpers.mjs';\nawait load(join(ROOT, 'plugins/x/scripts/plug.mjs'));\n",
      'plugins/x/scripts/dashboard.mjs': "import './lib/readers.mjs';\n",
      'plugins/x/scripts/plug.mjs': "import './lib/readers.mjs';\n",
      'plugins/x/scripts/lib/readers.mjs': 'export const r = 1;\n',
      // A module the test imports from the plugin is not the test side: what
      // its literals name, a helper does not run.
      'tests/test-catalog.mjs': "import { runNode } from './_helpers.mjs';\nimport '../plugins/x/catalog.mjs';\nrunNode(['--version']);\n",
      'plugins/x/catalog.mjs': "export const TOOLS = ['plugins/x/scripts/dashboard.mjs'];\n",
    };
    const r = select(tree, changed('plugins/x/scripts/lib/readers.mjs'));
    assert.deepEqual(r.tests, { files: ['tests/test-load.mjs', 'tests/test-run.mjs'] });
    assert.deepEqual(reasonsFor(r, 'tests/test-run.mjs').map((e) => e.rule), ['import']);
    assert.deepEqual(reasonsFor(r, 'tests/test-load.mjs').map((e) => e.rule), ['import']);
  });

  it('a helper\'s loader lends the modules a test names, never the directories it walks', () => {
    const tree = {
      'tests/_helpers.mjs': 'export const load = (p) => import(p);\n',
      'tests/test-list.mjs': "import { load } from './_helpers.mjs';\nconst names = readdirSync(join(ROOT, 'src/plugins'));\nawait load(other);\n",
      'src/plugins/one.mjs': "import '../../lib/dep.mjs';\n",
      'lib/dep.mjs': 'export const d = 1;\n',
      'tests/test-dep.mjs': "import '../lib/dep.mjs';\n",
    };
    assert.deepEqual(select(tree, changed('lib/dep.mjs')).tests, { files: ['tests/test-dep.mjs'] });
    assert.deepEqual(select(tree, changed('src/plugins/one.mjs')).tests, { files: ['tests/test-list.mjs'] }, 'the walk still reads the files in it');
  });

  it('fork and Worker start a module: an edge to each module their literals name', () => {
    for (const start of ["fork(join(ROOT, 'src/child.mjs'));", "new Worker(join(ROOT, 'src/child.mjs'));"]) {
      const tree = {
        'tests/test-start.mjs': `${start}\n`,
        'src/child.mjs': "import './dep.mjs';\n",
        'src/dep.mjs': 'export const d = 1;\n',
        'tests/test-dep.mjs': "import '../src/dep.mjs';\n",
      };
      const r = select(tree, changed('src/dep.mjs'));
      assert.deepEqual(r.tests, { files: ['tests/test-dep.mjs', 'tests/test-start.mjs'] }, start);
      assert.deepEqual(reasonsFor(r, 'tests/test-start.mjs').map((e) => e.rule), ['import'], start);
    }
  });

  it('a plugin loader loads the modules of a directory one literal names; a tree it walks for another purpose loads nothing', () => {
    const tree = {
      'tools/gen.mjs': [
        "const v = await import(pathToFileURL(join(ROOT, 'lib/schema.mjs')).href);",
        'function walkFiles(dir) { for (const e of readdirSync(dir)) walkFiles(join(dir, e)); }',
        "walkFiles(join(ROOT, 'plugins'));",
      ].join('\n'),
      'lib/schema.mjs': 'export const s = 1;\n',
      'plugins/p/a.mjs': "import './dep.mjs';\n",
      'plugins/p/dep.mjs': 'export const d = 1;\n',
      'tests/test-gen.mjs': "import '../tools/gen.mjs';\n",
    };
    const r = select(tree, changed('plugins/p/dep.mjs'));
    assert.deepEqual(r.tests, { files: ['tests/test-gen.mjs'] });
    assert.deepEqual(reasonsFor(r, 'tests/test-gen.mjs').map((e) => [e.rule, e.module]), [['dir', 'tools/gen.mjs']], 'read by its walk, not loaded');
  });

  it('child_process exec starts a process; a regular expression\'s exec does not', () => {
    const tree = {
      'tests/test-exec.mjs': "import { exec } from 'node:child_process';\nexec('node src/cli.mjs');\n",
      'src/cli.mjs': "import './dep.mjs';\n",
      'src/dep.mjs': 'export const d = 1;\n',
      'tests/test-direct.mjs': "import '../src/dep.mjs';\n",
    };
    assert.deepEqual(select(tree, changed('src/dep.mjs')).tests, { files: ['tests/test-direct.mjs', 'tests/test-exec.mjs'] });
    assert.equal(vs.analyzeModule("const m = /a/.exec(s);\nconst f = 'src/cli.mjs';\n").spawns, false);
  });

  it('the disk reader follows imports into ignored and linked modules, as Node does', () => {
    const dir = initRepo({
      '.gitignore': 'src/helper.mjs\n',
      'tests/test-a.mjs': "import '../src/helper.mjs';\n",
      'tests/test-l.mjs': "import '../src/link.mjs';\n",
      'tests/test-b.mjs': "const f = ['data/value.json', 'data/other.json'];\n",
      'data/value.json': '1\n',
      'data/other.json': '2\n',
      'lib/real.mjs': "const f = 'data/other.json';\n",
    });
    try {
      put(dir, 'src/helper.mjs', "const f = 'data/value.json';\n");
      symlinkSync('../lib/real.mjs', path.join(dir, 'src/link.mjs'));
      const tree = vs.diskReader(dir);
      const base = vs.gitReader({ cwd: dir, commit: 'HEAD' });
      const run = (p) => vs.selectChecks({ tree, base, changes: changed(p), declaration: DECL }).tests;
      assert.deepEqual(run('data/value.json'), { files: ['tests/test-a.mjs', 'tests/test-b.mjs'] });
      assert.deepEqual(run('data/other.json'), { files: ['tests/test-b.mjs', 'tests/test-l.mjs'] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('the runner\'s preloads are imports of every test', () => {
    const tree = {
      'package.json': JSON.stringify({ scripts: { test: 'node --test --import ./tests/_env.mjs' } }),
      'tests/_env.mjs': "import '../lib/session.mjs';\n",
      'lib/session.mjs': 'export const s = 1;\n',
      'tests/test-a.mjs': 'export {};\n',
    };
    const r = select(tree, changed('lib/session.mjs'));
    assert.deepEqual(r.tests, { files: ['tests/test-a.mjs'] });
    // A test the change names itself: only the unread preloads select the suite.
    const unparsedTree = { ...tree, 'package.json': JSON.stringify({ scripts: { test: 'node --test $(cat preload)' } }) };
    assert.deepEqual(select(tree, changed('tests/test-a.mjs')).tests, { files: ['tests/test-a.mjs'] });
    const unparsed = select(unparsedTree, changed('tests/test-a.mjs'));
    assert.deepEqual(unparsed.tests, { suite: true });
    assert.ok(unparsed.widened.entries.some((w) => w.path === 'package.json'));
  });

  it('a change to package.json, the runner\'s configuration, selects the suite', () => {
    const declaration = { ...DECL, kinds: { ...DECL.kinds, 'check-package': { slots: [], adds_on: ['package.json'] } } };
    const r = select({ 'package.json': '{}', 'tests/test-a.mjs': "const p = 'package.json';\n" }, changed('package.json'), { declaration });
    assert.deepEqual(r.tests, { suite: true });
    assert.ok(r.reasons.entries.some((e) => e.rule === 'runner'));
    assert.deepEqual(kinds(r), ['test-suite', 'check-package'], 'the suite adds to the declared checks, never replaces them');
  });
});

describe('verify-select — the persona-pipeline map (R2)', () => {
  const realFiles = () => {
    const files = {};
    for (const p of [vs.PIPELINE_MANIFEST, vs.PIPELINE_OWNED]) files[p] = readFileSync(path.join(REPO_ROOT, p), 'utf8');
    for (const persona of ['designer', 'engineer', 'founder']) files[`plugins/${persona}/persona.json`] = '{}';
    return files;
  };

  it('a source counts as every copy, a copy as its sources and their other copies', () => {
    const reader = vs.memoryReader(realFiles());
    const map = vs.pipelineMap(reader);
    assert.equal(map.ok, true);
    const expand = vs.pipelineExpansion([map]);
    const region = expand('persona-pipeline/regions/verb-finalize.md');
    for (const p of ['designer', 'engineer', 'founder']) {
      for (const verb of ['compose', 'frame']) assert.ok(region.has(`plugins/${p}/commands/${verb}.md`), `${p} ${verb}`);
    }
    assert.ok(region.has('plugins/engineer/commands/refine.md') && region.has('plugins/founder/commands/refine.md'));
    const copy = expand('plugins/engineer/scripts/state.mjs');
    assert.ok(copy.has('persona-pipeline/files/scripts/state.mjs'), 'the copy\'s source');
    assert.ok(copy.has('plugins/designer/scripts/state.mjs') && copy.has('plugins/founder/scripts/state.mjs'), 'the source\'s other copies');
  });

  const mapTree = (regions) => ({
    'persona-pipeline/manifest.json': JSON.stringify({ schema: 'persona-pipeline-manifest-1.0', personas: ['engineer'], units: [], regions }),
    'plugins/engineer/persona.json': '{}',
    'tests/test-x.mjs': "const f = join(ROOT, 'plugins', 'engineer', 'commands', 'x.md');\n",
    'tests/test-y.mjs': "const f = join(ROOT, 'plugins', 'engineer', 'commands', 'y.md');\n",
  });
  const OLD = { id: 'old', template: 'regions/old.md', dest: 'commands/x.md', personas: ['engineer'] };

  it('reads the map from base and tree: a region the tree removed still maps', () => {
    const r = select(mapTree([]), [{ path: 'persona-pipeline/regions/old.md', status: 'D', old: true }], { base: mapTree([OLD]) });
    assert.deepEqual(r.tests, { files: ['tests/test-x.mjs'] });
    assert.ok(kinds(r).includes('sync-persona-pipeline'));
  });

  it('a map that does not parse widens: a change under persona-pipeline/ or plugins/ selects the suite', () => {
    // The tree's broken manifest maps the region to y.md too; only the base's
    // old mapping (x.md) can be read, and it must not stand for both.
    const NEW = { ...OLD, id: 'new', dest: 'commands/y.md' };
    const broken = { ...mapTree([OLD, NEW]), 'persona-pipeline/manifest.json': JSON.stringify({ schema: 'persona-pipeline-manifest-9.9', personas: ['engineer'], units: [], regions: [OLD, NEW] }) };
    const r = select(broken, changed('persona-pipeline/regions/old.md'), { base: mapTree([OLD]) });
    assert.ok(r.widened.entries.some((w) => w.path === vs.PIPELINE_MANIFEST), JSON.stringify(r.widened));
    assert.deepEqual(r.tests, { suite: true });
    assert.ok(r.reasons.entries.some((e) => e.rule === 'pipeline' && e.path === 'persona-pipeline/regions/old.md'));
    assert.ok(kinds(r).includes('sync-persona-pipeline'));
    const outside = select(broken, changed('tests/test-x.mjs'), { base: mapTree([OLD]) });
    assert.deepEqual(outside.tests, { files: ['tests/test-x.mjs'] }, 'a change outside the pipeline is selected as before');
  });

  it('a change to the manifest or owned.json counts as every path the map names', () => {
    const tree = { ...mapTree([OLD]), 'persona-pipeline/owned.json': JSON.stringify({ schema: 'persona-pipeline-owned-1.0', owned: { engineer: ['commands/y.md'] } }) };
    for (const p of [vs.PIPELINE_MANIFEST, vs.PIPELINE_OWNED]) {
      const r = select(tree, changed(p));
      assert.deepEqual(r.tests, { files: ['tests/test-x.mjs', 'tests/test-y.mjs'] }, p);
      assert.deepEqual(r.reasons.entries.map((e) => e.via).sort(), ['plugins/engineer/commands/x.md', 'plugins/engineer/commands/y.md'], p);
    }
  });

  it('an empty enrolment is malformed, as the generator has it: the map widens', () => {
    const base = JSON.parse(mapTree([OLD])['persona-pipeline/manifest.json']);
    for (const manifest of [{ ...base, regions: [{ ...OLD, personas: [] }] }, { ...base, personas: [], regions: [] }]) {
      const map = vs.pipelineMap(vs.memoryReader({ ...mapTree([]), 'persona-pipeline/manifest.json': JSON.stringify(manifest) }));
      assert.equal(map.ok, false, JSON.stringify(manifest));
    }
  });

  it('the generator, a module it loads, and a persona\'s declaration are pipeline inputs: the pipeline\'s check runs', () => {
    const tree = {
      ...mapTree([OLD]),
      'scripts/sync-persona-pipeline.mjs': "import './lib/persona-pipeline.mjs';\n",
      'scripts/lib/persona-pipeline.mjs': 'export const v = 1;\n',
      'scripts/other.mjs': 'export {};\n',
      'tests/test-g.mjs': "import '../scripts/sync-persona-pipeline.mjs';\nimport '../scripts/other.mjs';\nconst p = 'engineer/persona.json';\n",
    };
    for (const p of ['scripts/sync-persona-pipeline.mjs', 'scripts/lib/persona-pipeline.mjs', 'plugins/engineer/persona.json']) {
      const r = select(tree, changed(p));
      assert.ok(kinds(r).includes('sync-persona-pipeline'), `${p}: ${kinds(r)}`);
      assert.ok(r.widened.entries.some((w) => w.path === p), p);
    }
    assert.ok(!kinds(select(tree, changed('scripts/other.mjs'))).includes('sync-persona-pipeline'), 'a module the generator does not load is no input');
  });

  it('a module the generator loads, deleted, and a file it reads are pipeline inputs too', () => {
    const generator = [
      "const v = await import(pathToFileURL(join(ROOT, 'lib/schema-validate.mjs')).href);",
      "const REGISTRY = 'core/skills/decide/axes.yml';",
      "for (const p of personas) readFileSync(join(ROOT, 'plugins', p, REGISTRY));",
    ].join('\n');
    const tree = { ...mapTree([OLD]), 'scripts/sync-persona-pipeline.mjs': generator, 'tests/test-g.mjs': "import '../scripts/sync-persona-pipeline.mjs';\n" };
    const base = { ...tree, 'lib/schema-validate.mjs': 'export {};\n' };
    const gone = select(tree, [{ path: 'lib/schema-validate.mjs', status: 'D', old: true }], { base });
    assert.ok(kinds(gone).includes('sync-persona-pipeline'), `deleted: ${kinds(gone)}`);
    const data = select(tree, changed('plugins/engineer/core/skills/decide/axes.yml'));
    assert.ok(kinds(data).includes('sync-persona-pipeline'), `read: ${kinds(data)}`);
  });

  it('a Markdown file the generator scans for markers is a pipeline input, and selects the tests that run the generator', () => {
    const generator = [
      "const pluginsDir = join(root, 'plugins');",
      'function walkFiles(dir) { for (const e of readdirSync(dir)) walkFiles(join(dir, e)); }',
      'for (const persona of personas) for (const rel of walkFiles(join(pluginsDir, persona))) readFileSync(join(pluginsDir, persona, rel));',
    ].join('\n');
    const tree = {
      ...mapTree([OLD]),
      'scripts/sync-persona-pipeline.mjs': generator,
      'plugins/engineer/README.md': '# e\n',
      'tests/test-sync.mjs': "import { spawnSync } from 'node:child_process';\nspawnSync(process.execPath, [join(ROOT, 'scripts/sync-persona-pipeline.mjs')]);\n",
    };
    const r = select(tree, changed('plugins/engineer/README.md'));
    assert.ok(kinds(r).includes('sync-persona-pipeline'), kinds(r).join(' '));
    assert.ok(r.widened.entries.some((w) => w.path === 'plugins/engineer/README.md'));
    assert.deepEqual(reasonsFor(r, 'tests/test-sync.mjs').map((e) => [e.rule, e.module]), [['dir', 'scripts/sync-persona-pipeline.mjs']]);
  });

  it('an owned output the manifest no longer names counts as its persona\'s sources', () => {
    const tree = {
      'persona-pipeline/manifest.json': JSON.stringify({ schema: 'persona-pipeline-manifest-1.0', personas: ['engineer'], units: [{ id: 'u', source: 'files/u.mjs', dest: 'scripts/u.mjs', personas: ['engineer'] }], regions: [] }),
      'persona-pipeline/owned.json': JSON.stringify({ schema: 'persona-pipeline-owned-1.0', owned: { engineer: ['scripts/u.mjs', 'scripts/orphan.mjs'] } }),
      'plugins/engineer/persona.json': '{}',
    };
    const expand = vs.pipelineExpansion([vs.pipelineMap(vs.memoryReader(tree))]);
    assert.ok(expand('plugins/engineer/scripts/orphan.mjs').has('persona-pipeline/files/u.mjs'));
  });
});

describe('verify-select — mutation specs and the declaration (R6, R7)', () => {
  const specTree = {
    'scripts/mutation-specs/s.mjs': [
      "const T = 'tests/test-s.mjs';",
      'export const TESTS = [T];',
      "export const MUTATIONS = [{ id: 'A', prepare: (copy, tools) => tools.applyEdit(copy, { file: 'src/a.mjs', from: 'x', to: 'y' }) }];",
    ].join('\n'),
    'tests/test-s.mjs': "import { spawnSync } from 'node:child_process';\nspawnSync('node', ['bin/run']);\n",
    'src/a.mjs': 'export const x = 1;\n',
    'tests/test-a.mjs': "import '../src/a.mjs';\n",
    'docs/a.md': '# a\n',
  };

  it('a spec that anchors a changed file selects the tests it names, and its static check', () => {
    const r = select(specTree, changed('src/a.mjs'));
    assert.deepEqual(r.tests, { files: ['tests/test-a.mjs', 'tests/test-s.mjs'] });
    assert.deepEqual(reasonsFor(r, 'tests/test-s.mjs').map((e) => [e.rule, e.module]), [['spec', 'scripts/mutation-specs/s.mjs']]);
    assert.deepEqual(addition(r, 'mutate-static'), { kind: 'mutate-static', args: { specs: ['scripts/mutation-specs/s.mjs'] } });
  });

  it('a spec that runs its tests anchors what it edits, never what those tests read', () => {
    const tree = {
      'scripts/mutation-specs/r.mjs': [
        "import { execFileSync } from 'node:child_process';",
        "export const TESTS = ['tests/test-w.mjs'];",
        "export const MUTATIONS = [{ id: 'A', file: 'src/a.mjs', from: 'x', to: 'y' }];",
        "execFileSync(process.execPath, ['--test', ...TESTS]);",
      ].join('\n'),
      'src/a.mjs': 'export const x = 1;\n',
      'tests/test-w.mjs': "import '../src/a.mjs';\nfor (const f of readdirSync(join(ROOT, 'plugins', 'x'))) use(f);\n",
      'plugins/x/other.mjs': 'export {};\n',
    };
    const r = select(tree, changed('plugins/x/other.mjs'));
    assert.deepEqual(r.tests, { files: ['tests/test-w.mjs'] });
    assert.equal(addition(r, 'mutate-static'), undefined, JSON.stringify(r.additions));
    assert.deepEqual(addition(select(tree, changed('src/a.mjs')), 'mutate-static'), { kind: 'mutate-static', args: { specs: ['scripts/mutation-specs/r.mjs'] } });
    // Nor what the other specs edit, which the harness it imports loads.
    const harness = {
      ...tree,
      'scripts/harness.mjs': "for (const f of readdirSync(join(ROOT, 'scripts/mutation-specs'))) await import(join(ROOT, 'scripts/mutation-specs', f));\n",
      'scripts/mutation-specs/r.mjs': `import '../harness.mjs';\n${tree['scripts/mutation-specs/r.mjs']}`,
      'scripts/mutation-specs/z.mjs': "export const MUTATIONS = [{ id: 'Z', file: 'src/z.mjs', from: 'x', to: 'y' }];\n",
      'src/z.mjs': 'export const x = 1;\n',
      'tests/test-z.mjs': "import '../src/z.mjs';\n",
    };
    assert.deepEqual(addition(select(harness, changed('src/z.mjs')), 'mutate-static'), { kind: 'mutate-static', args: { specs: ['scripts/mutation-specs/z.mjs'] } });
  });

  it('a test module a spec imports is its own code: it anchors what that module names', () => {
    const tree = {
      'scripts/mutation-specs/q.mjs': [
        "import { execFileSync } from 'node:child_process';",
        "import { TARGET } from '../../tests/test-shared.mjs';",
        "export const TESTS = ['tests/test-spec.mjs'];",
        "export const MUTATIONS = [{ id: 'A', file: TARGET, from: 'x', to: 'y' }];",
        "execFileSync(process.execPath, ['--test', ...TESTS]);",
      ].join('\n'),
      'tests/test-shared.mjs': "export const TARGET = 'src/b.mjs';\n",
      'tests/test-spec.mjs': 'export {};\n',
      'tests/test-other.mjs': "import '../src/b.mjs';\n",
      'src/b.mjs': 'export const x = 1;\n',
    };
    const r = select(tree, changed('src/b.mjs'));
    assert.ok(r.tests.files.includes('tests/test-spec.mjs'), JSON.stringify(r.tests));
    assert.deepEqual(addition(r, 'mutate-static'), { kind: 'mutate-static', args: { specs: ['scripts/mutation-specs/q.mjs'] } });
  });

  it('a deleted spec is a trigger, never an argument: every surviving spec is checked', () => {
    const r = select(specTree, [{ path: 'scripts/mutation-specs/gone.mjs', status: 'D', old: true }]);
    assert.deepEqual(addition(r, 'mutate-static'), { kind: 'mutate-static', args: {} });
  });

  it('a spec that cannot be read with certainty adds the unrestricted static check to any change', () => {
    // It names src/a.mjs, which it would anchor if it were read with certainty.
    const tree = { ...specTree, 'scripts/mutation-specs/u.mjs': "export const TESTS = ['tests/test-a.mjs'];\nconst f = 'src/a.mjs';\nconst x = `open" };
    const r = select(tree, changed('docs/a.md'));
    assert.deepEqual(addition(r, 'mutate-static'), { kind: 'mutate-static', args: {} });
    assert.ok(r.widened.entries.some((w) => w.path === 'scripts/mutation-specs/u.mjs' && /certainty/.test(w.why)), JSON.stringify(r.widened.entries));
  });

  it('adds_on takes the triggers its slot accepts; an optional slot runs unrestricted when one does not fit, a required one throws', () => {
    const declaration = {
      ...DECL,
      kinds: {
        ...DECL.kinds,
        'lint-scripts': { slots: [{ name: 'files', type: 'path', repeat: 'optional-many', join: 'words', under: ['scripts/'], suffix: '.mjs' }], adds_on: ['scripts/**', 'docs/*.md'] },
        'check-scripts': { slots: [{ name: 'files', type: 'path', repeat: 'many', join: 'words', under: ['scripts/'], suffix: '.mjs' }], adds_on: ['scripts/**', 'docs/*.md'] },
      },
    };
    const tree = { ...specTree, 'scripts/x.mjs': 'export {};\n', 'tests/test-x.mjs': "const p = 'scripts/x.mjs'; const q = 'docs/a.md';\n" };
    const fits = select(tree, changed('scripts/x.mjs'), { declaration });
    assert.deepEqual(addition(fits, 'lint-scripts'), { kind: 'lint-scripts', args: { files: ['scripts/x.mjs'] } });
    assert.deepEqual(addition(fits, 'check-scripts'), { kind: 'check-scripts', args: { files: ['scripts/x.mjs'] } });
    const optional = { ...declaration, kinds: { ...declaration.kinds, 'check-scripts': { ...declaration.kinds['check-scripts'], adds_on: ['scripts/**'] } } };
    const mixed = select(tree, changed('scripts/x.mjs', 'docs/a.md'), { declaration: optional });
    assert.deepEqual(addition(mixed, 'lint-scripts'), { kind: 'lint-scripts', args: {} });
    assert.throws(() => select(tree, changed('scripts/x.mjs', 'docs/a.md'), { declaration }), /check-scripts: docs\/a\.md/);
    assert.throws(() => select(tree, [{ path: 'scripts/gone.mjs', status: 'D', old: true }], { declaration: optional }), /check-scripts: scripts\/gone\.mjs/);
  });

  it('a slot of one value runs once per trigger', () => {
    const declaration = { ...DECL, kinds: { ...DECL.kinds, 'check-one': { slots: [{ name: 'file', type: 'path', repeat: 'one', under: ['scripts/'], suffix: '.mjs' }], adds_on: ['scripts/*.mjs'] } } };
    const tree = { ...specTree, 'scripts/x.mjs': '', 'scripts/y.mjs': '', 'tests/test-x.mjs': "const p = 'scripts/x.mjs'; const q = 'scripts/y.mjs';\n" };
    const r = select(tree, changed('scripts/x.mjs', 'scripts/y.mjs'), { declaration });
    assert.deepEqual(r.additions.filter((a) => a.kind === 'check-one'), [
      { kind: 'check-one', args: { file: 'scripts/x.mjs' } }, { kind: 'check-one', args: { file: 'scripts/y.mjs' } },
    ]);
  });

  it('mappings add tests, or the suite, for the paths they match', () => {
    const declaration = withMappings([{ paths: ['docs/**'], tests: ['tests/test-a.mjs'] }, { paths: ['config/*.yml'], suite: true }]);
    const tests = select(specTree, changed('docs/guide.md'), { declaration });
    assert.deepEqual(tests.tests, { files: ['tests/test-a.mjs'] });
    assert.equal(reasonsFor(tests, 'tests/test-a.mjs')[0].rule, 'mapping');
    const suite = select(specTree, changed('config/x.yml'), { declaration });
    assert.deepEqual(suite.tests, { suite: true });
    assert.ok(suite.reasons.entries.some((e) => e.rule === 'mapping'));
  });

  it('a mapped test the tree lacks widens to the suite', () => {
    const r = select(specTree, changed('docs/guide.md'), { declaration: withMappings([{ paths: ['docs/**'], tests: ['tests/test-gone.mjs'] }]) });
    assert.deepEqual(r.tests, { suite: true });
    assert.ok(r.widened.entries.some((w) => w.path === 'tests/test-gone.mjs'));
  });

  it('a mapping of another shape throws: no selection', () => {
    for (const m of [{ paths: ['x'], tests: ['tests/a.mjs'], suite: true }, { paths: [], tests: ['tests/a.mjs'] }, { paths: ['x'], tests: [] }, { paths: ['x'], suite: false }]) {
      assert.throws(() => select(specTree, changed('docs/a.md'), { declaration: withMappings([m]) }), /mappings\[0\]/, JSON.stringify(m));
    }
  });
});

describe('verify-select — assembly (R8, R9)', () => {
  const tree = {
    'src/a.mjs': 'export const a = 1;\n',
    'tests/test-a.mjs': "import '../src/a.mjs';\n",
    'tests/test-b.mjs': "const f = 'src/a.mjs';\n",
    'plugins/x/a.mjs': 'export {};\n',
    'tests/test-p.mjs': "import '../plugins/x/a.mjs';\n",
    'tests/test-q.mjs': "const f = 'x/a.mjs';\n",
  };

  it('a changed file no test matches selects the suite; a matched one does not', () => {
    const r = select(tree, changed('src/a.mjs', 'docs/unknown.md'));
    assert.deepEqual(r.tests, { suite: true });
    assert.deepEqual(r.reasons.entries.filter((e) => e.rule === 'fallback').map((e) => e.path), ['docs/unknown.md']);
    assert.deepEqual(r.additions, [{ kind: 'test-suite', args: {} }]);
    assert.deepEqual(select(tree, changed('src/a.mjs')).tests, { files: ['tests/test-a.mjs', 'tests/test-b.mjs'] });
  });

  it('a test that reaches an uncertain module is selected for every change, and never cancels a fallback', () => {
    const t = { ...tree, 'tests/test-u.mjs': "const f = 'src/a.mjs'; const g = 'open\n" };
    const r = select(t, changed('plugins/x/a.mjs'));
    assert.ok(r.tests.files.includes('tests/test-u.mjs'), 'selected though it names no changed file');
    assert.deepEqual(reasonsFor(r, 'tests/test-u.mjs').map((e) => e.rule), ['uncertain']);
    const alone = { 'src/a.mjs': '', 'tests/test-u.mjs': "const f = 'src/a.mjs'; const g = 'open\n" };
    assert.deepEqual(select(alone, changed('src/a.mjs')).tests, { suite: true }, 'its partial reading is no match');
    const spec = { 'src/a.mjs': '', 'tests/test-s.mjs': '', 'scripts/mutation-specs/u.mjs': "const T = ['tests/test-s.mjs', 'src/a.mjs'];\nconst x = `open" };
    assert.deepEqual(select(spec, changed('src/a.mjs')).tests, { suite: true }, 'nor is an uncertain spec\'s');
  });

  it('a test is as uncertain as the modules it imports, and an unreadable module is uncertain', () => {
    for (const helper of ["export const f = 'src/a.mjs'; const g = 'open\n", null]) {
      const t = { ...tree, 'tests/test-h.mjs': "import './_helper.mjs';\n", 'tests/_helper.mjs': helper };
      const r = select(t, changed('plugins/x/a.mjs'));
      assert.ok(r.tests.files.includes('tests/test-h.mjs'), `${JSON.stringify(helper)}: selected though it names no changed file`);
      assert.deepEqual(reasonsFor(r, 'tests/test-h.mjs').map((e) => e.rule), ['uncertain']);
    }
    const alone = { 'src/a.mjs': '', 'tests/test-h.mjs': "import './_helper.mjs';\n", 'tests/_helper.mjs': "export const f = 'src/a.mjs'; const g = 'open\n" };
    assert.deepEqual(select(alone, changed('src/a.mjs')).tests, { suite: true }, 'its helper\'s partial reading is no match');
  });

  it('holds the test kind\'s bound on the list its own adds_on joins', () => {
    const helpers = Object.fromEntries(Array.from({ length: vs.MAX_TEST_FILES }, (_, i) => [`tests/h/x${i}.mjs`, '']));
    const t = { ...tree, ...helpers, 'tests/test-w.mjs': "for (const f of readdirSync(join(ROOT, 'tests', 'h'))) use(f);\n" };
    const declaration = { ...DECL, kinds: { ...DECL.kinds, test: { ...DECL.kinds.test, adds_on: ['tests/h/**'] } } };
    const r = select(t, changed(...Object.keys(helpers)), { declaration });
    assert.deepEqual(r.tests, { suite: true });
    assert.ok(r.widened.entries.some((w) => w.kind === 'test'), JSON.stringify(r.widened.entries));
  });

  it('the test kind added unrestricted stands as the suite, never as a file list', () => {
    const optional = { ...DECL.kinds.test, slots: [{ ...DECL.kinds.test.slots[0], repeat: 'optional-many' }], adds_on: ['docs/**'] };
    // A test reads docs/a.md, so no fallback selects the suite.
    const t = { ...tree, 'tests/test-d.mjs': "const f = 'docs/a.md';\n" };
    const r = select(t, changed('src/a.mjs', 'docs/a.md'), { declaration: { ...DECL, kinds: { ...DECL.kinds, test: optional } } });
    assert.ok(!r.reasons.entries.some((e) => e.rule === 'fallback'));
    assert.deepEqual(r.tests, { suite: true });
    assert.ok(r.widened.entries.some((w) => w.kind === 'test' && /unrestricted/.test(w.why)), JSON.stringify(r.widened.entries));
    assert.deepEqual(kinds(r), ['test-suite']);
  });

  it('a selected test the test kind cannot carry widens to the suite', () => {
    const r = select({ ...tree, 'tests/test-c.ts': "import '../src/a.mjs';\n" }, changed('src/a.mjs'));
    assert.deepEqual(r.tests, { suite: true });
    assert.ok(r.widened.entries.some((w) => w.path === 'tests/test-c.ts'));
  });

  it('keeps the worker\'s checks and never repeats one', () => {
    const requested = [{ kind: 'test', args: { files: ['tests/test-p.mjs'] } }, { kind: 'lint-plugin-shape', args: {} }];
    const r = select(tree, changed('plugins/x/a.mjs'), { requested });
    assert.equal(r.requested, requested);
    assert.deepEqual(r.requested, [{ kind: 'test', args: { files: ['tests/test-p.mjs'] } }, { kind: 'lint-plugin-shape', args: {} }]);
    assert.deepEqual(r.additions, [{ kind: 'test', args: { files: ['tests/test-q.mjs'] } }]);
    const suite = select(tree, changed('plugins/x/a.mjs'), { requested: [{ kind: 'test-suite', args: {} }] });
    assert.deepEqual(suite.additions, [{ kind: 'lint-plugin-shape', args: {} }]);
  });

  it('orders its additions by the declaration, their arguments sorted', () => {
    const t = {
      ...tree,
      'persona-pipeline/files/x.mjs': 'export {};\n',
      'scripts/mutation-specs/s.mjs': "export const TESTS = ['tests/test-p.mjs'];\nexport const MUTATIONS = [{ id: 'A', file: 'plugins/x/a.mjs', from: 'a', to: 'b' }];\n",
      'tests/test-z.mjs': "const f = 'files/x.mjs';\n",
    };
    const r = select(t, changed('plugins/x/a.mjs', 'persona-pipeline/files/x.mjs', 'src/a.mjs'));
    assert.deepEqual(kinds(r), ['test', 'mutate-static', 'sync-persona-pipeline', 'lint-plugin-shape']);
    assert.deepEqual(addition(r, 'test').args.files, ['tests/test-a.mjs', 'tests/test-b.mjs', 'tests/test-p.mjs', 'tests/test-q.mjs', 'tests/test-z.mjs']);
  });

  it('no change adds nothing', () => {
    assert.deepEqual(select(tree, []).additions, []);
  });

  it('throws without readers or a declaration with kinds', () => {
    assert.throws(() => vs.selectChecks({ tree: vs.memoryReader(tree), changes: [], declaration: DECL }), /base reader/);
    assert.throws(() => vs.selectChecks({ base: vs.memoryReader(tree), changes: [], declaration: DECL }), /tree reader/);
    assert.throws(() => select(tree, [], { declaration: { mappings: [] } }), /no kinds/);
  });

  it('throws when the suite is needed and the declaration has no kind that runs it: never a selection that runs no test', () => {
    const { 'test-suite': _, ...rest } = DECL.kinds;
    const declaration = { ...DECL, kinds: rest };
    assert.throws(() => select(tree, changed('docs/unknown.md'), { declaration }), /needs the whole suite, and the declaration has no test-suite kind/);
    assert.deepEqual(select(tree, changed('src/a.mjs'), { declaration }).tests, { files: ['tests/test-a.mjs', 'tests/test-b.mjs'] }, 'a file list needs no suite kind');
  });
});

describe('verify-select — on this repository', () => {
  const T150 = 'tests/plugin-shape/test-engineer-autopilot-runbooks.mjs';

  it('the C150 change selects the runbook test through the path it builds, with the comment naming the source removed', () => {
    const disk = fsTree(REPO_ROOT);
    const text = disk.read(T150);
    const stripped = text.split('\n').filter((l) => !l.includes('regions/verb-finalize')).join('\n');
    assert.ok(stripped.length < text.length && !stripped.includes('verb-finalize.md'), 'the comment that names the region is gone');
    assert.ok(/'plugins\/engineer'/.test(stripped) && stripped.includes('`commands/${verb}.md`'), 'the test still builds its paths');
    const tree = fsTree(REPO_ROOT, { [T150]: stripped });
    const r = vs.selectChecks({
      tree, base: tree, declaration: DECL, maxListed: 100000,
      changes: changed('persona-pipeline/regions/verb-finalize-consensus.md', 'persona-pipeline/regions/verb-finalize.md'),
    });
    assert.ok(r.tests.files?.includes(T150), 'selected');
    assert.ok(r.reasons.entries.some((e) => e.test === T150 && e.module === T150 && e.rule === 'cover'
      && e.via === 'plugins/engineer/commands/compose.md' && e.path === 'persona-pipeline/regions/verb-finalize.md'),
    'by the cover of plugins/engineer + commands/${verb}.md');
    // The consensus region alone (#974's change) reaches the test through
    // its own copies.
    const consensus = vs.selectChecks({ tree, base: tree, declaration: DECL, maxListed: 100000, changes: changed('persona-pipeline/regions/verb-finalize-consensus.md') });
    assert.ok(consensus.reasons.entries.some((e) => e.test === T150 && e.module === T150 && e.rule === 'cover'
      && /^plugins\/engineer\/commands\/(investigate|decide|critique)\.md$/.test(e.via)), 'the consensus region alone, by a cover');
  });

  it('a persona.json is read through tests/persona-pipeline/_personas.mjs, though another test names it', () => {
    const tree = fsTree(REPO_ROOT);
    const r = vs.selectChecks({ tree, base: tree, declaration: DECL, maxListed: 100000, changes: changed('plugins/engineer/persona.json') });
    const viaHelper = r.reasons.entries.filter((e) => e.module === 'tests/persona-pipeline/_personas.mjs' && e.rule === 'cover');
    assert.ok(viaHelper.some((e) => e.test === 'tests/persona-pipeline/test-decide-weights.mjs'), 'a test that imports the helper');
    assert.ok(!tree.read('tests/persona-pipeline/test-decide-weights.mjs').includes('persona.json'), 'the test itself names no persona.json');
    assert.ok(r.reasons.entries.some((e) => e.module !== 'tests/persona-pipeline/_personas.mjs' && e.test !== '*'), 'another test is selected otherwise');
    assert.ok(r.tests.files.includes('tests/persona-pipeline/test-decide-weights.mjs'));
  });

  it('the reads a review found missed: the generator\'s scan, a script a helper starts, walks of the plugins', () => {
    const tree = fsTree(REPO_ROOT);
    const cases = [
      ['plugins/engineer/README.md', 'tests/persona-pipeline/test-sync-persona-pipeline.mjs'],
      ['plugins/runtime/scripts/lib/state-readers.mjs', 'tests/acceptance/test-operator-observability-acceptance.mjs'],
      ['plugins/runtime/commands/doctor.md', 'tests/plugin-shape/test-host-tool-dependency-contract.mjs'],
      ['plugins/image/README.md', 'tests/persona-pipeline/test-region-engine.mjs'],
      ['plugins/attention/CHANGELOG.md', 'tests/persona-pipeline/test-region-engine.mjs'],
    ];
    const r = vs.selectChecks({ tree, base: tree, declaration: DECL, maxListed: 1e6, changes: changed(...cases.map(([p]) => p)) });
    for (const [p, t] of cases) assert.ok(r.reasons.entries.some((e) => e.path === p && e.test === t), `${p} selects ${t}`);
    assert.ok(kinds(r).includes('sync-persona-pipeline') && r.widened.entries.some((w) => w.path === 'plugins/engineer/README.md'), 'the README is a pipeline input');
  });

  it('an unknown file at the top selects the whole suite', () => {
    const tree = fsTree(REPO_ROOT);
    // Built here, so that no literal of this file names it.
    const unknown = `${['NOTES', 'unknown', process.pid].join('-')}.txt`;
    const r = vs.selectChecks({ tree, base: tree, declaration: DECL, changes: [{ path: unknown, status: 'U' }] });
    assert.deepEqual(r.tests, { suite: true });
    assert.deepEqual(r.reasons.entries.filter((e) => e.rule === 'fallback').map((e) => e.path), [unknown]);
  });

  it('stays bounded: a module selects at most a third of the tests, the ADR the suite or ten, each in under 10 s of CPU', () => {
    // A test that copies a whole plugin, the tests and the generator that walk
    // every plugin's tree, and a mutation spec's TESTS reach a module beyond
    // its importers: measured 2026-10-21, budget.mjs selects 62 of 249 tests
    // and policy.mjs 67, in about 4.5 s of CPU each (before the plugin walks
    // counted, 48 and 53 under a bound of a quarter). Text read as an edge
    // selected about 223 for any change. The time is the process's CPU time,
    // not the wall clock, which test files running in parallel stretch
    // (11.5-12.7 s observed for a 10 s run). After #990 the ADR selects 8:
    // four of them are the heavy-lock tests, which run the real mutation
    // harness, whose spec loading reaches persona-pipeline.mjs's TESTS and
    // through them the docs walk of test-set-terminal-archive-timing.mjs
    // (measured 2026-10-21: blanking that name in that spec alone leaves 3).
    // On CI the bound was met by a narrowing margin as the tree grew (10.1 to
    // 11.9 s of CPU for budget.mjs in three of four pull requests, 2026-10-25/26,
    // where this machine took 5.5 to 6.9 s): covers() tried every piece at
    // every segment. Indexed by first segment, the same selections take about
    // 3.1 to 4.5 s here, with identical results on 18 changes across the tree.
    const tree = fsTree(REPO_ROOT);
    const all = vs.discoverTests(tree).length;
    const run = (p) => {
      const c0 = process.cpuUsage();
      const r = vs.selectChecks({ tree, base: tree, declaration: DECL, changes: changed(p) });
      const c = process.cpuUsage(c0);
      return { r, ms: Math.round((c.user + c.system) / 1000) };
    };
    for (const p of ['plugins/orchestrator/adapters/claude/autopilot/budget.mjs', 'plugins/orchestrator/adapters/claude/autopilot/policy.mjs']) {
      const { r, ms } = run(p);
      assert.ok(r.tests.files, `${p} selects files, not the suite`);
      assert.ok(r.tests.files.length <= Math.ceil(all / 3), `${p} selects ${r.tests.files.length} of ${all}`);
      assert.ok(ms < 10000, `${p} took ${ms} ms of CPU`);
    }
    const { r } = run('docs/adr/0068-autopilot-lanes-that-keep-going.md');
    assert.ok(r.tests.suite || r.tests.files.length <= 10, JSON.stringify(r.tests).slice(0, 200));
  });

  it('loads from a copy of its own file alone: Node built-ins only', async () => {
    const text = readFileSync(path.join(REPO_ROOT, MODULE_REL), 'utf8');
    const specifiers = [...text.matchAll(/^import [^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.ok(specifiers.length > 0 && specifiers.every((s) => s.startsWith('node:')), specifiers.join(' '));
    const dir = tempDir('vs-copy-');
    try {
      copyFileSync(path.join(REPO_ROOT, MODULE_REL), path.join(dir, 'verify-select.mjs'));
      const copy = await import(pathToFileURL(path.join(dir, 'verify-select.mjs')).href);
      const r = copy.selectChecks({ tree: copy.memoryReader({ 'tests/test-a.mjs': "const f = 'src/a.mjs';\n", 'src/a.mjs': '' }), base: copy.memoryReader({}), changes: changed('src/a.mjs'), declaration: DECL });
      assert.deepEqual(r.tests, { files: ['tests/test-a.mjs'] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
