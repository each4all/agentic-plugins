// ADR-0059 — runbook argument transport through a written args file.
//
// WHY THIS EXISTS. Fifteen command runbooks spliced the slash command's text
// unquoted into a shell line. Replayed over this repository's recorded
// topics, a third came through intact: the rest crashed on an apostrophe or
// were silently cut at `;` and redirected at `>` — and those exited zero. The
// runbooks now have the model write the text into an args file, and each CLI
// reads it with `--args-file`. No shell parses the text on the way in.
//
// WHAT IS CHECKED, at the transport/parser boundary — the text a grammar
// yields and the argv a parser receives, never an exit status alone, because
// the failure this removes exited zero:
//
//   1. one library: the four package copies of lib/args-file.mjs are
//      byte-identical (each package is installed on its own);
//   2. the file: every text comes back byte for byte, including the ones the
//      corpus cannot supply (empty, a lone newline, CRLF, invisible and
//      combining characters), and every malformed file is refused;
//   3. the three grammars, case by case;
//   4. the corpus: every recorded topic's shape replays intact, through each
//      persona's own decide parser (tests/fixtures/args-file-topic-shapes.json,
//      regenerated from the live state by scripts/replay-args-file-corpus.mjs);
//   5. the CLIs, run as processes with their working directory outside the
//      repository: hostile text reaches them intact and creates nothing,
//      concurrent runs each read their own file, and each runtime CLI refuses
//      a malformed file on its own usage-error path;
//   6. the runbooks and the Codex skills: every one that took typed text now
//      passes it by `--args-file`.
//
// Cleanup — the trap that removes the directory and keeps the exit status —
// is exercised in tests/plugin-shape/test-runbook-shell-portability.mjs,
// whose guard assertion it replaces (ADR-0059 Decision 8).

import { test } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { replayTopic } from '../_args-file-replay.mjs';
import { substituteClaudeArguments } from '../_claude-command-substitution.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = join(REPO_ROOT, 'plugins');
const rel = (p) => relative(REPO_ROOT, p).split('\\').join('/');

// The packages whose runbooks pass typed text by --args-file. ADR-0059 landed
// one package per commit (ADR-0016), runtime first, and each commit added its
// package here; every check below that concerns a package reads this list.
const CONVERTED = ['runtime'];
const LIB_PACKAGES = CONVERTED;
const PERSONAS = ['designer', 'engineer', 'founder'];
const CONVERTED_PERSONAS = PERSONAS.filter((p) => CONVERTED.includes(p));
const inConverted = (file) => CONVERTED.includes(file.split('/')[1]);
const unlessConverted = (pkg) => (CONVERTED.includes(pkg) ? false : `plugins/${pkg} does not read args files yet`);
const lib = await import(join(PLUGINS, 'runtime', 'scripts', 'lib', 'args-file.mjs'));
const { ArgsFileError } = lib;

const personaParsers = {};
for (const p of PERSONAS) personaParsers[p] = (await import(join(PLUGINS, p, 'scripts', 'lib', 'decide-args.mjs'))).parseArgs;

// Characters built from code points, so the source shows what they are.
const ch = (...cps) => String.fromCodePoint(...cps);
const NBSP = ch(0xa0);
const ZWSP = ch(0x200b);
const COMBINING_ACUTE = ch(0x301);
const LINE_SEPARATOR = ch(0x2028);
const EMOJI = ch(0x1f600);

// Text the corpus cannot supply: state.mjs records topics through singleLine(),
// so they hold no newline, no CR and no leading or trailing whitespace.
const HOSTILE = [
  '',
  '\n',
  'A 고르자; 아니면 B',
  "it's B's",
  'a $(id -un) b',
  'a `id -un` b',
  'x > f',
  'a; b (c)',
  'PR3 — 미러(agents/openai.md) 추가; 검증',
  'line1\nline2\n\ttab',
  'crlf\r\nline\r\n',
  `nbsp${NBSP}zwsp${ZWSP}e${COMBINING_ACUTE} ls${LINE_SEPARATOR}x ${EMOJI}`,
  '"double" and \\backslash\\ and \'single\'',
  '*.md B냐? [A] {a,b} ~/x #c !x =x',
  '--looks-like-a-flag but sits in the body',
  '  leading and trailing whitespace  \n',
];

const scratch = (label) => mkdtempSync(join(tmpdir(), `args-file-${label}-`));
// Every path the test writes — absolute, so a name written in one directory
// does not excuse the same name appearing in another — so the side-effect
// check can tell the test's files from anything a CLI or a splice creates.
const WRITTEN = new Set();
const writeArgs = (dir, name, text) => {
  const path = join(dir, name);
  writeFileSync(path, lib.encodeArgsFile(text));
  WRITTEN.add(path);
  return path;
};
/** Entries of `dir` the test did not write (the `repo` fixture aside). */
const strayIn = (dir) => readdirSync(dir).filter((f) => f !== 'repo' && !WRITTEN.has(join(dir, f)));
const gitStatus = () => spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout;

// ── 1. One library ──────────────────────────────────────────────────────────

test('the args-file library is one library', async (t) => {
  await t.test('every package that carries a copy carries the same bytes', () => {
    const copies = readdirSync(PLUGINS)
      .filter((p) => existsSync(join(PLUGINS, p, 'scripts', 'lib', 'args-file.mjs')))
      .sort();
    deepStrictEqual(copies, LIB_PACKAGES, 'the packages that read args files changed; update LIB_PACKAGES and the runbooks together');
    const bytes = copies.map((p) => readFileSync(join(PLUGINS, p, 'scripts', 'lib', 'args-file.mjs')));
    for (let i = 1; i < bytes.length; i += 1) {
      ok(bytes[i].equals(bytes[0]), `plugins/${copies[i]}/scripts/lib/args-file.mjs differs from plugins/${copies[0]}'s — copy the edited one over the others`);
    }
  });
});

// ── 2. The file ─────────────────────────────────────────────────────────────

test('the args file carries the text byte for byte, and refuses every malformed shape', async (t) => {
  await t.test('round trip, through bytes and through a real file', () => {
    const dir = scratch('codec');
    try {
      HOSTILE.forEach((text, i) => {
        strictEqual(lib.decodeArgsFile(Buffer.from(lib.encodeArgsFile(text))), text, `case ${i}`);
        strictEqual(lib.readArgsFile(writeArgs(dir, `${i}.json`, text)), text, `case ${i} from disk`);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('an empty argument and a lone newline stay distinct (Decision 2)', () => {
    const empty = lib.encodeArgsFile('');
    const newline = lib.encodeArgsFile('\n');
    ok(empty !== newline);
    strictEqual(lib.decodeArgsFile(Buffer.from(empty)), '');
    strictEqual(lib.decodeArgsFile(Buffer.from(newline)), '\n');
  });

  await t.test('a producer other than encodeArgsFile is accepted: the file names a format (Decision 4)', () => {
    const handWritten = '{ "text" : "a\\tb",\n  "agentic_args" : 1 }';
    strictEqual(lib.decodeArgsFile(Buffer.from(handWritten)), 'a\tb');
    // A raw NBSP or line separator inside the JSON string is still the same text.
    strictEqual(lib.decodeArgsFile(Buffer.from(`{"agentic_args":1,"text":"a${NBSP}b${LINE_SEPARATOR}c"}`)), `a${NBSP}b${LINE_SEPARATOR}c`);
  });

  const refused = [
    ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0x7d]), /not valid UTF-8/],
    ['not JSON', Buffer.from('--size=minor A'), /not valid JSON/],
    ['a raw newline inside the string', Buffer.from('{"agentic_args":1,"text":"a\nb"}'), /not valid JSON/],
    ['an array', Buffer.from('[1]'), /JSON object/],
    ['null', Buffer.from('null'), /JSON object/],
    ['no version', Buffer.from('{"text":"a"}'), /no "agentic_args"/],
    ['version 2', Buffer.from('{"agentic_args":2,"text":"a"}'), /version 2 is not supported/],
    ['version as a string', Buffer.from('{"agentic_args":"1","text":"a"}'), /version "1" is not supported/],
    ['no text', Buffer.from('{"agentic_args":1}'), /no "text" field/],
    ['text not a string', Buffer.from('{"agentic_args":1,"text":["a"]}'), /must be a string/],
    ['an extra field', Buffer.from('{"agentic_args":1,"text":"a","argv":["a"]}'), /unexpected field "argv"/],
    ['a lone surrogate', Buffer.from('{"agentic_args":1,"text":"a\\ud800"}'), /lone surrogate/],
    ['a NUL', Buffer.from('{"agentic_args":1,"text":"a\\u0000b"}'), /NUL/],
    ['over the size limit', Buffer.alloc(lib.ARGS_FILE_MAX_BYTES + 1, 0x20), /limit is/],
    ['a deeply nested version, which must not escape as a RangeError',
      Buffer.from(`{"agentic_args":${'['.repeat(15000)}1${']'.repeat(15000)},"text":""}`), /version of type array/],
  ];
  for (const [label, bytes, message] of refused) {
    await t.test(`refused: ${label}`, () => {
      throws(() => lib.decodeArgsFile(bytes), (e) => e instanceof ArgsFileError && message.test(e.message));
    });
  }

  await t.test('refused: a missing file, a directory, an empty path', () => {
    const dir = scratch('paths');
    try {
      throws(() => lib.readArgsFile(join(dir, 'absent.json')), (e) => e instanceof ArgsFileError && /no file at/.test(e.message));
      throws(() => lib.readArgsFile(dir), (e) => e instanceof ArgsFileError && /not a regular file/.test(e.message));
      throws(() => lib.readArgsFile(''), (e) => e instanceof ArgsFileError && /no path/.test(e.message));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('a message quoting file or command-line text cannot forge a terminal line', () => {
    throws(() => lib.readArgsFile('/absent\nforged line'), (e) => !e.message.includes('\n') && e.message.includes('<U+000A>'));
    throws(() => lib.splitPersonaArguments(`--x${ch(0x1b)}[2J"`), (e) => !e.message.includes(ch(0x1b)) && e.message.includes('<U+001B>'));
  });
});

// ── 3. The grammars ─────────────────────────────────────────────────────────

test('runtime grammar: shell-style words, nothing expanded, the rest refused', async (t) => {
  const words = [
    ['', []],
    ['  \t\r\n ', []],
    ['doctor --format json', ['doctor', '--format', 'json']],
    [`note --text 'A 고르자; 아니면 B'`, ['note', '--text', 'A 고르자; 아니면 B']],
    [`note --text "it's \\"quoted\\" \\\\ \\$HOME \\\`x\\\` \\n"`, ['note', '--text', 'it\'s "quoted" \\ $HOME `x` \\n']],
    [`--summary="a b"'c d'e`, ['--summary=a bc de']],
    ['a\\ b c\\;d', ['a b', 'c;d']],
    ['a\\\nb', ['ab']],
    [`"a\\\nb"`, ['ab']],
    ["''", ['']],
    [`x '' y`, ['x', '', 'y']],
    ['*.md B냐? [A] {a,b} !x =x 50%', ['*.md', 'B냐?', '[A]', '{a,b}', '!x', '=x', '50%']],
    ['a#b a~b $ a$', ['a#b', 'a~b', '$', 'a$']],
    [`"#c" '~/x' "$(id)"`, ['#c', '~/x', '$(id)']],
    [`crlf\r\nnext`, ['crlf', 'next']],
    [`nbsp${NBSP}inside`, [`nbsp${NBSP}inside`]],
  ];
  for (const [text, expected] of words) {
    await t.test(`reads ${JSON.stringify(text)}`, () => deepStrictEqual(lib.tokenizeRuntimeArguments(text), expected));
  }
  const refusals = [
    ["it's", /single quote opened at character 3/],
    ['"open', /double quote opened at character 1/],
    ['trailing\\', /backslash at character 9/],
    ['a ; b', /unquoted ';'/], ['a|b', /unquoted '\|'/], ['a & b', /unquoted '&'/],
    ['x > f', /unquoted '>'/], ['x < f', /unquoted '<'/], ['a (b)', /unquoted '\('/], ['b)', /unquoted '\)'/],
    ['a `id`', /backquote/],
    ['$(id)', /'\$\('/], ['$HOME', /'\$H'/], ['${x}', /'\$\{'/], ['cost $5', /'\$5'/], ['$@', /'\$@'/],
    ['#comment', /starts a comment/], ['~/x', /home directory/],
  ];
  for (const [text, message] of refusals) {
    await t.test(`refuses ${JSON.stringify(text)}`, () => {
      throws(() => lib.tokenizeRuntimeArguments(text), (e) => e instanceof ArgsFileError && message.test(e.message) && e.message.startsWith('arguments: '));
    });
  }

  await t.test('expandArgsFile replaces the option in place and leaves everything else', () => {
    const read = () => 'plan --family "a b"';
    deepStrictEqual(lib.expandArgsFile(['--args-file', 'F', '--repo-root', 'R'], { read }), ['plan', '--family', 'a b', '--repo-root', 'R']);
    deepStrictEqual(lib.expandArgsFile(['--repo-root', 'R', '--args-file=F'], { read }), ['--repo-root', 'R', 'plan', '--family', 'a b']);
    deepStrictEqual(lib.expandArgsFile(['--repo-root', 'R'], { read }), ['--repo-root', 'R']);
    throws(() => lib.expandArgsFile(['--args-file', 'F', '--args-file', 'G'], { read }), /more than once/);
    throws(() => lib.expandArgsFile(['--args-file'], { read }), /needs a path/);
    throws(() => lib.expandArgsFile(['--args-file='], { read }), /needs a path/);
    throws(() => lib.expandArgsFile(['--args-file', 'F'], { read: () => '--args-file G' }), /cannot name another args file/);
  });
});

test('persona grammar: leading flags, then one body byte for byte', async (t) => {
  const cases = [
    ['', { flags: [], body: '' }],
    ['\n', { flags: [], body: '\n' }],
    ['  leading whitespace is body when no flag leads', { flags: [], body: '  leading whitespace is body when no flag leads' }],
    ['A or B?', { flags: [], body: 'A or B?' }],
    ['--size=minor A 고르자; 아니면 B\n', { flags: ['--size=minor'], body: 'A 고르자; 아니면 B\n' }],
    ['  --size=major\t--weights=essence:2  body  with  spaces  ', { flags: ['--size=major', '--weights=essence:2'], body: 'body  with  spaces  ' }],
    ['-- --not-a-flag body', { flags: [], body: '--not-a-flag body' }],
    ['  --  after the separator run', { flags: [], body: 'after the separator run' }],
    ['--size=minor \n\t', { flags: ['--size=minor'], body: '' }],
    ['--size=minor --', { flags: ['--size=minor'], body: '' }],
    ['--size=minor', { flags: ['--size=minor'], body: '' }],
    ['-x is a body', { flags: [], body: '-x is a body' }],
    [`a${NBSP}--size=minor`, { flags: [], body: `a${NBSP}--size=minor` }],
  ];
  for (const [text, expected] of cases) {
    await t.test(`splits ${JSON.stringify(text)}`, () => deepStrictEqual(lib.splitPersonaArguments(text), expected));
  }
  await t.test('a quoted flag value is refused rather than read as quoting', () => {
    throws(() => lib.splitPersonaArguments('--size="minor" body'), /flag --size="minor" holds a quote/);
    throws(() => lib.splitPersonaArguments("--preset='x' body"), /holds a quote/);
  });
  await t.test('each persona parser receives the body intact through personaArgv', () => {
    for (const [name, parseArgs] of Object.entries(personaParsers)) {
      for (const body of HOSTILE.filter((h) => h.trim() !== '' && !/^[ \t\r\n]/.test(h))) {
        const parsed = parseArgs(lib.personaArgv(`--size=minor -- ${body}`));
        deepStrictEqual([parsed.errors, parsed.flags.size, parsed.body], [[], 'minor', body], `${name}: ${JSON.stringify(body)}`);
      }
    }
  });
  await t.test('soleArgsFilePath: the file is the only argument', () => {
    strictEqual(lib.soleArgsFilePath(['--args-file', 'F']), 'F');
    strictEqual(lib.soleArgsFilePath(['--args-file=F']), 'F');
    strictEqual(lib.soleArgsFilePath(['--size=minor', 'x']), null);
    // Only the first argument can name the file: after it the grammar's own
    // flags and body begin.
    strictEqual(lib.soleArgsFilePath(['--', '--args-file']), null);
    strictEqual(lib.soleArgsFilePath(['--', '--args-file=F']), null);
    strictEqual(lib.soleArgsFilePath(['body', '--args-file', 'F']), null);
    throws(() => lib.soleArgsFilePath(['--args-file']), /needs a path/);
    throws(() => lib.soleArgsFilePath(['--args-file', 'F', '--size=minor']), /cannot be combined/);
  });
});

test('start grammar: one --base-branch anywhere, the rest is the description', async (t) => {
  const cases = [
    ['Fix X', { baseBranch: 'origin/main', baseBranchExplicit: false, feature: 'Fix X' }],
    ['  Fix X\n', { baseBranch: 'origin/main', baseBranchExplicit: false, feature: 'Fix X\n' }],
    ['--base-branch origin/dev Fix X', { baseBranch: 'origin/dev', baseBranchExplicit: true, feature: 'Fix X' }],
    ['Fix --base-branch dev X', { baseBranch: 'dev', baseBranchExplicit: true, feature: 'Fix X' }],
    ['Fix  X --base-branch dev\n', { baseBranch: 'dev', baseBranchExplicit: true, feature: 'Fix  X' }],
    [`Fix it's --base-branch "feat/a-b" now; $(x)`, { baseBranch: 'feat/a-b', baseBranchExplicit: true, feature: "Fix it's now; $(x)" }],
    ["--base-branch 'v1.2' A", { baseBranch: 'v1.2', baseBranchExplicit: true, feature: 'A' }],
    ['mention "--base-branch" quoted', { baseBranch: 'origin/main', baseBranchExplicit: false, feature: 'mention "--base-branch" quoted' }],
    ['A --base-branchy x', { baseBranch: 'origin/main', baseBranchExplicit: false, feature: 'A --base-branchy x' }],
  ];
  for (const [text, expected] of cases) {
    await t.test(`extracts ${JSON.stringify(text)}`, () => deepStrictEqual(lib.extractStartArguments(text), expected));
  }
  const refusals = [
    ['', /needs a feature description/],
    [' \n\t', /needs a feature description/],
    ['--base-branch dev', /needs a feature description/],
    ['Fix --base-branch', /needs a ref/],
    ['Fix --base-branch --other', /needs a ref/],
    ['Fix --base-branch=dev', /not --base-branch=dev/],
    ['a --base-branch x b --base-branch y', /given 2 times/],
    ['a --base-branch "x y" b', /holds a quote or backslash/],
    ['a --base-branch x\\y b', /holds a quote or backslash/],
    ['a --base-branch "" b', /empty ref/],
    ["a --base-branch '-x' b", /starts with '-'/],
  ];
  for (const [text, message] of refusals) {
    await t.test(`refuses ${JSON.stringify(text)}`, () => {
      throws(() => lib.extractStartArguments(text), (e) => e instanceof ArgsFileError && message.test(e.message));
    });
  }
});

// ── 4. The corpus ───────────────────────────────────────────────────────────

test('every recorded topic shape replays intact', async (t) => {
  const fixture = JSON.parse(readFileSync(join(REPO_ROOT, 'tests', 'fixtures', 'args-file-topic-shapes.json'), 'utf8'));
  await t.test('the fixture is the corpus, not a sample', () => {
    // ADR-0059 measured 311 topics; the corpus has only grown since.
    ok(fixture.shapes.length >= 311, `only ${fixture.shapes.length} shapes`);
    ok(fixture.shapes.some((s) => s.includes('>')), 'no shape holds a `>`, the character that made the probe write files');
    ok(fixture.shapes.some((s) => s.includes("'")), 'no shape holds an apostrophe');
    ok(fixture.shapes.some((s) => /[;(]/.test(s)), 'no shape holds `;` or `(`');
    ok(fixture.shapes.some((s) => s.includes('가')), 'no shape holds Hangul');
  });
  await t.test('through the library, and through each persona parser', () => {
    // One import stands for every copy: test 1 holds them byte-identical.
    const failures = [];
    fixture.shapes.forEach((shape, i) => {
      for (const f of replayTopic(shape, lib, personaParsers)) failures.push(`shape ${i}: ${f}`);
    });
    deepStrictEqual(failures.slice(0, 20), []);
  });
  await t.test('the replay is not vacuous: it catches a grammar that damages the body', () => {
    const damaging = { ...lib, splitPersonaArguments: (text) => ({ ...lib.splitPersonaArguments(text), body: lib.splitPersonaArguments(text).body.trimEnd() }) };
    ok(replayTopic('body  ', damaging).some((f) => f.startsWith('persona')), 'a trimmed body went unnoticed');
    const splicing = { ...lib, tokenizeRuntimeArguments: (text) => text.split(/\s+/).filter(Boolean) };
    ok(replayTopic('A 고르자; 아니면 B', splicing).some((f) => f.startsWith('runtime')), 'a word-split value went unnoticed');
  });
});

// ── 5. The CLIs, as processes outside the repository ────────────────────────

const node = (args, cwd) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
const nodeAsync = (args, cwd) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { cwd });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

test('the CLIs read the args file, and the text reaches them intact', async (t) => {
  const before = gitStatus();
  const cwd = scratch('cli');
  try {
    await t.test('control: the old unquoted splice does create a file here, so an empty directory is evidence', () => {
      const probe = mkdtempSync(join(cwd, 'control-'));
      spawnSync('bash', ['-c', 'set -o noglob; node -e 0 x > f'], { cwd: probe });
      ok(existsSync(join(probe, 'f')), 'the control splice wrote nothing — the side-effect check below would be blind');
      rmSync(probe, { recursive: true, force: true });
    });

    await t.test('decide-registry resolve --args-file, in each persona: the body is the text', () => {
      for (const persona of CONVERTED_PERSONAS) {
        const cli = join(PLUGINS, persona, 'scripts', 'decide-registry.mjs');
        HOSTILE.forEach((text, i) => {
          // Unflagged text is its own body, byte for byte; text that would
          // read as a flag goes after `-- `, whose separator it does not start with.
          const flagLed = /^[^ \t\r\n]*/.exec(text.trimStart())[0].startsWith('--');
          const file = writeArgs(cwd, `${persona}-${i}.json`, flagLed ? `-- ${text}` : text);
          const r = node([cli, 'resolve', '--args-file', file], cwd);
          strictEqual(r.status, 0, `${persona} case ${i}: ${r.stderr}`);
          strictEqual(JSON.parse(r.stdout).body, text, `${persona} case ${i}`);
        });
        const flagged = node([cli, 'resolve', '--args-file', writeArgs(cwd, `${persona}-flagged.json`, '--size=minor A 고르자; 아니면 B')], cwd);
        deepStrictEqual([flagged.status, JSON.parse(flagged.stdout).size, JSON.parse(flagged.stdout).body], [0, 'minor', 'A 고르자; 아니면 B'], persona);
        // A body larger than a pipe buffer arrives whole: the CLI sets its exit
        // status rather than calling process.exit(), which cut stdout at 64 KiB.
        const large = 'B'.repeat(512 * 1024);
        const big = node([cli, 'resolve', '--args-file', writeArgs(cwd, `${persona}-large.json`, large)], cwd);
        strictEqual(big.status, 0, big.stderr);
        strictEqual(JSON.parse(big.stdout).body.length, large.length, `${persona}: a large body was truncated`);
        // `--args-file` after `--` is body text, as it was before the option existed.
        for (const bodyToken of ['--args-file', '--args-file=/tmp/x']) {
          const r = node([cli, 'resolve', '--', bodyToken], cwd);
          deepStrictEqual([r.status, JSON.parse(r.stdout).body], [0, bodyToken], `${persona}: resolve -- ${bodyToken}`);
        }
        const refused = [
          [['resolve', '--args-file', writeArgs(cwd, `${persona}-bad.json`, '--size=huge x')], /not in \{minor, standard, major\}/],
          [['resolve', '--args-file', writeArgs(cwd, `${persona}-q.json`, '--size="minor" x')], /holds a quote/],
          [['resolve', '--args-file', join(cwd, 'absent.json')], /no file at/],
          [['resolve', '--args-file', writeArgs(cwd, `${persona}-c.json`, 'x'), '--size=major'], /cannot be combined/],
          [['resolve', '--args-file'], /needs a path/],
        ];
        for (const [args, message] of refused) {
          const r = node([cli, ...args], cwd);
          strictEqual(r.status, 2, `${persona} ${args.join(' ')}: ${r.stderr}`);
          ok(message.test(r.stderr), `${persona}: ${r.stderr}`);
        }
      }
    });

    await t.test('start-args: the description and the base branch', { skip: unlessConverted('engineer') }, () => {
      const cli = join(PLUGINS, 'engineer', 'scripts', 'start-args.mjs');
      const ok0 = node([cli, '--args-file', writeArgs(cwd, 'start.json', `Fix it's; $(id) > f --base-branch 'feat/x'`)], cwd);
      strictEqual(ok0.status, 0, ok0.stderr);
      deepStrictEqual(JSON.parse(ok0.stdout), { base_branch: 'feat/x', base_branch_explicit: true, feature: "Fix it's; $(id) > f" });
      const plain = node([cli, '--args-file', writeArgs(cwd, 'start2.json', 'line\nnext\n')], cwd);
      deepStrictEqual(JSON.parse(plain.stdout), { base_branch: 'origin/main', base_branch_explicit: false, feature: 'line\nnext\n' });
      for (const text of ['', '--base-branch dev', 'a --base-branch']) {
        const r = node([cli, '--args-file', writeArgs(cwd, 'start-bad.json', text)], cwd);
        strictEqual(r.status, 2, JSON.stringify(text));
        ok(r.stderr.startsWith('✗ arguments: '), r.stderr);
      }
      strictEqual(node([cli], cwd).status, 2);
    });

    await t.test('runtime context: a note staged through the args file equals the text', () => {
      const repo = join(cwd, 'repo');
      mkdirSync(repo);
      spawnSync('git', ['init', '-q'], { cwd: repo });
      spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
      const cli = join(PLUGINS, 'runtime', 'scripts', 'context.mjs');
      for (const text of ['A 고르자; 아니면 B\'s $(id -un) > f `x`', `tab\there ${EMOJI}`]) {
        const quoted = `'${text.replaceAll("'", "'\\''")}'`;
        const file = writeArgs(cwd, 'note.json', `note --text ${quoted} --format json`);
        const r = node([cli, '--repo-root', repo, '--args-file', file], cwd);
        strictEqual(r.status, 0, r.stderr);
        const note = JSON.parse(readFileSync(join(repo, '.agentic-plugins', 'state', 'runtime', 'session-capture', 'note.json'), 'utf8'));
        strictEqual(note.content, text);
      }
    });

    await t.test('runtime: each CLI refuses a malformed args file on its own usage-error path', () => {
      const bad = writeArgs(cwd, 'bad.json', 'x ; y');
      const expected = {
        'bootstrap.mjs': 40, 'consensus.mjs': 1, 'context.mjs': 1, 'cutover-audit.mjs': 1, 'dashboard.mjs': 1,
        'doctor.mjs': 2, 'migrate.mjs': 1, 'retention.mjs': 1, 'settings.mjs': 2, 'worktree.mjs': 1,
      };
      for (const [script, status] of Object.entries(expected)) {
        const r = node([join(PLUGINS, 'runtime', 'scripts', script), '--args-file', bad], cwd);
        strictEqual(r.status, status, `${script}: ${r.stderr}${r.stdout}`);
        ok(/arguments: an unquoted ';'/.test(r.stderr + r.stdout), `${script} did not say why: ${r.stderr}${r.stdout}`);
      }
    });

    await t.test('runtime: the words land where the option sat (retention reads its subcommand first)', async () => {
      const { runRetentionCli } = await import(join(PLUGINS, 'runtime', 'scripts', 'retention.mjs'));
      const repo = join(cwd, 'repo');
      const res = await runRetentionCli(['--args-file', writeArgs(cwd, 'ret.json', 'plan --format json'), '--repo-root', repo]);
      ok(res.ok, res.reason);
      ok(JSON.parse(res.output).plan, 'no plan in the output');
    });

    await t.test('runtime parsers receive exactly the argv a direct invocation would', async () => {
      const text = `capture --summary "it's; (fine) $(no)" --next-action 'a > b' --risk yellow`;
      const argv = ['capture', '--summary', "it's; (fine) $(no)", '--next-action', 'a > b', '--risk', 'yellow'];
      const file = writeArgs(cwd, 'ctx.json', text);
      const { parseArgs } = await import(join(PLUGINS, 'runtime', 'scripts', 'context.mjs'));
      deepStrictEqual(parseArgs(lib.expandArgsFile(['--repo-root', cwd, '--args-file', file])), parseArgs(['--repo-root', cwd, ...argv]));
    });

    await t.test('concurrent invocations each read their own file', { skip: CONVERTED_PERSONAS.length === 0 ? 'no persona reads args files yet' : false }, async () => {
      const cli = join(PLUGINS, CONVERTED_PERSONAS[0], 'scripts', 'decide-registry.mjs');
      const bodies = Array.from({ length: 8 }, (_, i) => `run ${i}: A 고르자; 아니면 B ${'x'.repeat(i * 97)}`);
      const results = await Promise.all(bodies.map((body, i) => nodeAsync([cli, 'resolve', '--args-file', writeArgs(cwd, `c${i}.json`, body)], cwd)));
      results.forEach((r, i) => {
        strictEqual(r.status, 0, r.stderr);
        strictEqual(JSON.parse(r.stdout).body, bodies[i]);
      });
    });

    await t.test('runtime context: a hook-grade shape in an args file is classified as one', () => {
      // The classification must read the expanded argv: these exit 0 with no
      // report when typed directly, and must do the same from a file.
      const cli = join(PLUGINS, 'runtime', 'scripts', 'context.mjs');
      const repo = join(cwd, 'repo');
      for (const words of [['note', '--hook-grade', '--help'], ['publish-session', '--help'], ['entry-brief', '--surface', 'session-start-hook', '--help']]) {
        const direct = node([cli, '--repo-root', repo, ...words], cwd);
        const viaFile = node([cli, '--repo-root', repo, '--args-file', writeArgs(cwd, 'hook.json', words.join(' '))], cwd);
        deepStrictEqual([viaFile.status, viaFile.stdout], [direct.status, direct.stdout], words.join(' '));
        strictEqual(direct.status, 0, words.join(' '));
      }
    });

    await t.test('the side-effect check is not fooled by a name written elsewhere', () => {
      // A name this test wrote in another directory must still count as
      // stray here: the check keeps paths, not names.
      const elsewhere = scratch('elsewhere');
      const probe = scratch('probe');
      try {
        writeArgs(elsewhere, 'collision.json', 'x');
        writeFileSync(join(probe, 'collision.json'), '{}');
        deepStrictEqual(strayIn(probe), ['collision.json']);
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
        rmSync(probe, { recursive: true, force: true });
      }
    });

    await t.test('nothing was created but what the test wrote, and the repository is untouched', () => {
      const stray = strayIn(cwd);
      deepStrictEqual(stray, [], 'a CLI or a splice created files in its working directory');
      strictEqual(gitStatus(), before, 'the repository changed while the CLIs ran');
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 6. The runbooks and the Codex skills ────────────────────────────────────

// The runbooks ADR-0059 counted, plus designer's start, whose Phase 1c
// illustrates the decide call.
const ARGS_FILE_RUNBOOKS = ([
  'plugins/designer/commands/decide.md',
  'plugins/designer/commands/start.md',
  'plugins/engineer/commands/decide.md',
  'plugins/engineer/commands/start.md',
  'plugins/founder/commands/decide.md',
  ...['bootstrap', 'consensus', 'context', 'cutover', 'dashboard', 'doctor', 'migrate', 'retention', 'settings', 'worktree']
    .map((c) => `plugins/runtime/commands/${c}.md`),
]).filter(inConverted);
const ARGS_FILE_SKILLS = ([
  'plugins/designer/core/skills/decide/SKILL.md',
  'plugins/designer/core/skills/start/SKILL.md',
  'plugins/engineer/core/skills/decide/SKILL.md',
  'plugins/engineer/core/skills/start/SKILL.md',
  'plugins/founder/core/skills/decide/SKILL.md',
  ...['bootstrap', 'consensus', 'context', 'cutover', 'dashboard', 'doctor', 'migrate', 'retention', 'settings', 'worktree']
    .map((c) => `plugins/runtime/core/skills/${c}/SKILL.md`),
]).filter(inConverted);

function markdown(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) markdown(p, acc);
    else if (entry.endsWith('.md') && entry !== 'CHANGELOG.md') acc.push(p);
  }
  return acc;
}

test('the runbooks and skills pass typed text by --args-file', async (t) => {
  const all = markdown(PLUGINS).map(rel);
  await t.test('exactly these runbooks and skills name the option', () => {
    const naming = all.filter((f) => readFileSync(join(REPO_ROOT, f), 'utf8').includes('--args-file')).sort();
    deepStrictEqual(naming, [...ARGS_FILE_RUNBOOKS, ...ARGS_FILE_SKILLS].sort());
  });
  await t.test('every runbook creates the directory, writes the file, and passes the option', () => {
    for (const f of ARGS_FILE_RUNBOOKS.filter((r) => !r.endsWith('designer/commands/start.md'))) {
      const text = readFileSync(join(REPO_ROOT, f), 'utf8');
      ok(text.includes('mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"'), `${f}: no mktemp step`);
      ok(text.includes('{"agentic_args": 1, "text": "…"}'), `${f}: no file-writing step`);
      ok(text.includes('--args-file "$ARGS_DIR/args.json"'), `${f}: the CLI is not given the file`);
    }
  });
  await t.test('every runbook shows the typed text above the steps that copy it', () => {
    // The model transcribes what Claude substituted into the body, so the text
    // has to be on the page, in prose, before step 1 asks for it.
    const SENTINEL = 'ADR0059TYPEDTEXT';
    for (const f of ARGS_FILE_RUNBOOKS.filter((r) => !r.endsWith('designer/commands/start.md'))) {
      const body = readFileSync(join(REPO_ROOT, f), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
      const rendered = substituteClaudeArguments(body, SENTINEL, { appendIfUnused: false });
      const shown = rendered.indexOf(SENTINEL);
      ok(shown >= 0 && shown < rendered.indexOf('mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"'), `${f}: the typed text is not shown before the steps`);
    }
  });
  await t.test('the investigate profile placeholders no longer carry host-substituted text', () => {
    for (const p of CONVERTED_PERSONAS) {
      const text = readFileSync(join(PLUGINS, p, 'commands', 'investigate.md'), 'utf8');
      ok(text.includes('<profile from the arguments above — '), `plugins/${p}/commands/investigate.md`);
    }
  });
});

// ── 7. A runbook block, run as written ──────────────────────────────────────

test('engineer start: its own Phase 0 block hands the description to FEATURE intact', { skip: unlessConverted('engineer') }, async (t) => {
  const text = readFileSync(join(PLUGINS, 'engineer', 'commands', 'start.md'), 'utf8');
  const block = text.match(/```bash\n(ARGS_DIR='<directory from step 1>'\n[\s\S]*?start-args\.mjs[\s\S]*?)```/);
  ok(block, 'the Phase 0 block was not found in plugins/engineer/commands/start.md');
  const jq = spawnSync('jq', ['--version']).status === 0;
  for (const shell of ['bash', 'zsh']) {
    const available = spawnSync(shell, ['-c', 'exit 0']).status === 0;
    const skip = !jq ? 'jq is not installed' : !available ? `${shell} is not installed` : false;
    await t.test(`${shell}: trailing newlines, quotes and an embedded option`, { skip }, () => {
      const dir = mkdtempSync(join(tmpdir(), 'agentic-args.'));
      const out = scratch('start-block');
      try {
        writeFileSync(join(dir, 'args.json'), lib.encodeArgsFile(`--base-branch 'feat/x' it's "A"; $(id) > f\nnext\n\n`));
        const script = `${block[1].replace("ARGS_DIR='<directory from step 1>'", `ARGS_DIR='${dir}'`)}`
          + `printf '%s' "$FEATURE" > '${out}/feature'\nprintf '%s' "$BASE_BRANCH" > '${out}/base'\n`;
        const r = spawnSync(shell, ['-c', script], { cwd: out, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: join(PLUGINS, 'engineer') } });
        strictEqual(r.status, 0, r.stderr);
        strictEqual(readFileSync(join(out, 'feature'), 'utf8'), `it's "A"; $(id) > f\nnext\n\n`);
        strictEqual(readFileSync(join(out, 'base'), 'utf8'), 'feat/x');
        ok(!existsSync(dir), 'the args directory survived the block');
        deepStrictEqual(readdirSync(out).sort(), ['base', 'feature'], 'the block created files in its working directory');
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(out, { recursive: true, force: true });
      }
    });
  }
});
