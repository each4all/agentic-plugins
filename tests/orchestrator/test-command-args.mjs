// tests/orchestrator/test-command-args.mjs
//
// C134(a) — the orchestrator commands' argument receiver: `state.mjs
// command-args --command <c> --args-file <path>` reads an ADR-0059 args file
// with the shared codec (scripts/lib/args-file.mjs, unchanged) and prints the
// fields of the command's grammar (scripts/lib/command-args.mjs) as one JSON
// object. Covers:
//   - every command's grammar: each field, always present, and the forms each
//     option takes;
//   - refusals: a duplicate, unknown, bare or valued option; --no-commit with
//     an option it excludes; a quoted or backslashed word; a stray positional;
//     an option after done's reason began; resume's words;
//   - done's reason kept byte for byte, hostile text included;
//   - the CLI: the args file is consumed by its reader (a runbook's mktemp
//     file and its directory are removed, on a refusal too), a file of the
//     caller's is kept, an unknown command reads nothing, a bad file names
//     why, and a refusal prints nothing on stdout.

import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, throws, ok, match } from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ORCH = resolve(REPO_ROOT, 'plugins/orchestrator');
const STATE = resolve(ORCH, 'scripts/state.mjs');
const { parseCommandArguments, COMMAND_NAMES } = await import(resolve(ORCH, 'scripts/lib/command-args.mjs'));
const { encodeArgsFile } = await import(resolve(ORCH, 'scripts/lib/args-file.mjs'));

const env = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_')));
const cli = (args) => spawnSync(process.execPath, [STATE, ...args], { encoding: 'utf8', env: env() });

const MACRO = 'macro-plan-20261016T164728Z-6b1b43';
const DONE_EMPTY = {
  agentic_command_args: 1, command: 'done', subtask_id: '', pr: '', commit: '', correct: false,
  no_commit: false, waive_dispatch: false, workflow_id: '', integration_branch: '', reason: '',
};
const done = (fields) => ({ ...DONE_EMPTY, ...fields });

describe('the grammars', () => {
  it('names the six commands', () => {
    deepStrictEqual([...COMMAND_NAMES].sort(), ['abort', 'approve', 'done', 'finalize', 'next', 'resume']);
  });

  it('next: an optional subtask id and --workflow=<id>, in either order', () => {
    const empty = { agentic_command_args: 1, command: 'next', subtask_id: '', workflow_id: '' };
    deepStrictEqual(parseCommandArguments('next', ''), empty);
    deepStrictEqual(parseCommandArguments('next', '  \n'), empty);
    deepStrictEqual(parseCommandArguments('next', 'PR1'), { ...empty, subtask_id: 'PR1' });
    deepStrictEqual(parseCommandArguments('next', `idfile-cli --workflow=${MACRO}`), { ...empty, subtask_id: 'idfile-cli', workflow_id: MACRO });
    deepStrictEqual(parseCommandArguments('next', `\t--workflow=${MACRO}\n idfile-cli\n`), { ...empty, subtask_id: 'idfile-cli', workflow_id: MACRO });
  });

  it('abort, finalize and approve: --workflow=<id> only', () => {
    for (const command of ['abort', 'finalize', 'approve']) {
      deepStrictEqual(parseCommandArguments(command, ''), { agentic_command_args: 1, command, workflow_id: '' });
      deepStrictEqual(parseCommandArguments(command, `--workflow=${MACRO}`), { agentic_command_args: 1, command, workflow_id: MACRO });
      throws(() => parseCommandArguments(command, 'T1'), /takes no positional argument \(got T1\)/);
      throws(() => parseCommandArguments(command, '-- why'), /takes no free text/);
      throws(() => parseCommandArguments(command, '--pr=1'), new RegExp(`unknown option --pr=1; ${command} takes --workflow=<…>`));
    }
  });

  it('resume: nothing, archive, or archive <workflow-id>', () => {
    const r = (mode, workflow_id = '') => ({ agentic_command_args: 1, command: 'resume', mode, workflow_id });
    deepStrictEqual(parseCommandArguments('resume', ''), r('resume'));
    deepStrictEqual(parseCommandArguments('resume', 'archive'), r('archive'));
    deepStrictEqual(parseCommandArguments('resume', ` archive  ${MACRO}\n`), r('archive', MACRO));
    throws(() => parseCommandArguments('resume', 'resume'), /"?resume"? is not a resume mode\. Usage: \/orchestrator:resume \[archive \[<workflow-id>\]\]/);
    throws(() => parseCommandArguments('resume', 'archive a b'), /takes one workflow id; b follows it/);
    throws(() => parseCommandArguments('resume', 'archive --workflow=x'), /resume takes no options/);
    throws(() => parseCommandArguments('resume', "archive 'x'"), /holds a quote or backslash/);
  });

  it('done: the subtask id, every option, and the reason', () => {
    deepStrictEqual(parseCommandArguments('done', 'T1'), done({ subtask_id: 'T1' }));
    deepStrictEqual(
      parseCommandArguments('done', `T1 --pr=12 --commit=abc1234 --correct --waive-dispatch --workflow=${MACRO} --integration-branch=release/x the PR was retargeted`),
      done({ subtask_id: 'T1', pr: '12', commit: 'abc1234', correct: true, waive_dispatch: true, workflow_id: MACRO, integration_branch: 'release/x', reason: 'the PR was retargeted' }),
    );
    deepStrictEqual(parseCommandArguments('done', '--no-commit T2 closed with evidence only'), done({ subtask_id: 'T2', no_commit: true, reason: 'closed with evidence only' }));
    deepStrictEqual(parseCommandArguments('done', 'T2 -- --no-commit is named here'), done({ subtask_id: 'T2', reason: '--no-commit is named here' }));
    deepStrictEqual(parseCommandArguments('done', 'T2 --'), done({ subtask_id: 'T2' }));
    deepStrictEqual(parseCommandArguments('done', 'T2 --   '), done({ subtask_id: 'T2' }));
  });

  it("done's reason is the text from its first word to the end, byte for byte", () => {
    const hostile = "it's \"done\"; $(rm -rf /) `id` $HOME \\n\nsecond line\r\n\ttab ü 한국어 \u2028 ;|&<>  ";
    deepStrictEqual(parseCommandArguments('done', `T1 --no-commit ${hostile}`), done({ subtask_id: 'T1', no_commit: true, reason: hostile }));
    deepStrictEqual(parseCommandArguments('done', `T1 -- ${hostile}`), done({ subtask_id: 'T1', reason: hostile }));
    // Words that look like options but name none of done's are text.
    deepStrictEqual(parseCommandArguments('done', 'T1 see --verbose and --pr-x'), done({ subtask_id: 'T1', reason: 'see --verbose and --pr-x' }));
  });

  it('refuses what it cannot read as written, naming why', () => {
    const cases = [
      ['', /done needs a subtask id/],
      ['--pr=1', /done needs a subtask id/],
      ['-- reason', /the subtask id comes before '--'/],
      ['T1 --pr=1 --pr=2', /--pr is given more than once/],
      ['T1 --correct --correct', /--correct is given more than once/],
      ['T1 --pr 3', /write --pr=<value>; --pr needs its value after '='/],
      ['T1 --pr=', /--pr= needs a value/],
      ['T1 --pr=-1', /the --pr value -1 starts with '-'/],
      ['T1 --correct=yes', /--correct takes no value/],
      ['T1 --bogus', /unknown option --bogus; done takes --pr=<…>, --commit=<…>, --correct/],
      ['T1 -x', /unknown option -x; options are written --name/],
      ['T1 --pr="12"', /the option --pr="12" holds a quote or backslash/],
      ["'T1'", /the subtask id 'T1' holds a quote or backslash/],
      ['T\\1', /the subtask id T\\1 holds a quote or backslash/],
      ['T1 because --no-commit', /the option --no-commit comes after the reason began/],
      ['T1 because --pr=3', /the option --pr=3 comes after the reason began/],
      ['T1 --no-commit --pr=3 r', /--no-commit excludes --pr/],
      ['T1 --commit=abc --no-commit --correct r', /--no-commit excludes --commit, --correct/],
    ];
    for (const [text, pattern] of cases) throws(() => parseCommandArguments('done', text), pattern, JSON.stringify(text));
    throws(() => parseCommandArguments('next', 'T1 T2'), /next takes one subtask id; T2 follows it/);
    throws(() => parseCommandArguments('next', '--workflow'), /write --workflow=<value>/);
    throws(() => parseCommandArguments('next', `--workflow=${MACRO} --workflow=${MACRO}`), /--workflow is given more than once/);
    throws(() => parseCommandArguments('next', 'T1 x\u0007'), /; x<U\+0007> follows it/, 'a control character is shown as its code point');
    throws(() => parseCommandArguments('plan', ''), /unknown command "plan"/);
  });
});

describe('state.mjs command-args', () => {
  const withDir = (fn) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'command-args-')));
    try {
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  // The file a runbook's `mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"`
  // step and the model's write make.
  const owned = (text) => {
    const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'agentic-args.')));
    const file = join(dir, 'args.json');
    writeFileSync(file, encodeArgsFile(text));
    return { dir, file };
  };

  it('prints one JSON line of the fields and consumes a runbook-made args file', () => {
    const { dir, file } = owned(`T1 --no-commit -- it's $(x) "q"\nline 2`);
    const r = cli(['command-args', '--command', 'done', '--args-file', file]);
    strictEqual(r.status, 0, r.stderr);
    strictEqual(r.stdout.split('\n').length, 2, 'one line');
    deepStrictEqual(JSON.parse(r.stdout), done({ subtask_id: 'T1', no_commit: true, reason: `it's $(x) "q"\nline 2` }));
    ok(!existsSync(file) && !existsSync(dir), 'the reader removed the file and its directory');
  });

  it('consumes the runbook-made file on a refusal too, and prints nothing on stdout', () => {
    const { dir, file } = owned('T1 --pr=1 --pr=2');
    const r = cli(['command-args', '--command', 'done', '--args-file', file]);
    strictEqual(r.status, 1);
    strictEqual(r.stdout, '');
    match(r.stderr, /^state\.mjs command-args: arguments: --pr is given more than once\n$/);
    ok(!existsSync(dir), 'removed whether or not the text is valid');
  });

  it('keeps a file of the caller\'s, and reads nothing for an unknown or missing command', () => withDir((dir) => {
    const file = join(dir, 'args.json');
    writeFileSync(file, encodeArgsFile('archive'));
    const r = cli(['command-args', '--command', 'resume', '--args-file', file]);
    strictEqual(r.status, 0, r.stderr);
    deepStrictEqual(JSON.parse(r.stdout), { agentic_command_args: 1, command: 'resume', mode: 'archive', workflow_id: '' });
    ok(existsSync(file), 'not a runbook-made path: kept');
    const { dir: ownedDir, file: ownedFile } = owned('T1');
    try {
      const unknown = cli(['command-args', '--command', 'plan', '--args-file', ownedFile]);
      strictEqual(unknown.status, 1);
      match(unknown.stderr, /unknown command "plan"; expected one of next, done, abort, finalize, approve, resume/);
      ok(existsSync(ownedFile), 'an unknown command reads nothing, so the file is left for a corrected call');
      const missing = cli(['command-args', '--args-file', ownedFile]);
      strictEqual(missing.status, 1);
      match(missing.stderr, /missing required flag --command/);
      ok(existsSync(ownedFile));
    } finally {
      rmSync(ownedDir, { recursive: true, force: true });
    }
  }));

  it('refuses a bad file, naming why, and an args file given twice', () => withDir((dir) => {
    const file = join(dir, 'args.json');
    const cases = [
      [Buffer.from([0x7b, 0xff, 0x7d]), /--args-file: the file is not valid UTF-8/],
      ['not json', /--args-file: the file is not valid JSON/],
      ['{"agentic_args": 2, "text": ""}', /version 2 is not supported/],
      ['{"agentic_args": 1, "text": "a", "extra": 1}', /unexpected field "extra"/],
      ['{"agentic_args": 1, "text": "T1\\u0000"}', /holds a NUL character/],
      ['{"agentic_args": 1, "text": "\\ud800"}', /lone surrogate/],
    ];
    for (const [bytes, pattern] of cases) {
      writeFileSync(file, bytes);
      const r = cli(['command-args', '--command', 'next', '--args-file', file]);
      strictEqual(r.status, 1, `${String(bytes)}: ${r.stderr}`);
      strictEqual(r.stdout, '');
      match(r.stderr, pattern);
    }
    const absent = cli(['command-args', '--command', 'next', '--args-file', join(dir, 'none.json')]);
    strictEqual(absent.status, 1);
    match(absent.stderr, /--args-file: no file at/);
    const empty = cli(['command-args', '--command', 'next', '--args-file', '']);
    strictEqual(empty.status, 1);
    match(empty.stderr, /--args-file: no path was given/);
    writeFileSync(file, encodeArgsFile('T1'));
    const twice = cli(['command-args', '--command', 'next', '--args-file', file, '--args-file', file]);
    strictEqual(twice.status, 2);
    match(twice.stderr, /--args-file is given more than once/);
  }));

  it('parses with the shared codec, used unchanged: command-args.mjs imports it and holds no reader of its own', () => {
    const source = readFileSync(resolve(ORCH, 'scripts/lib/command-args.mjs'), 'utf8');
    match(source, /^import \{ ArgsFileError, readArgsFile \} from '\.\/args-file\.mjs';$/m);
    ok(!/readFileSync|TextDecoder|JSON\.parse/.test(source), 'no second reader of the file');
  });
});
