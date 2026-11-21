// Tests for companions/peer-cli.mjs, the peer-CLI launch resolver (C180 part 1).
//
// Windows is simulated in process: `platform: 'win32'`, an environment with
// PATH/Path/PATHEXT, and an in-memory file tree keyed by win32 paths. The npm
// cmd-shim fixtures are built by the template code of each cmd-shim release
// that writes a distinct .cmd layout (2.0.2, 3.0.3, 4.1.0, 7.0.0, 9.0.2; the
// sources are github.com/npm/cmd-shim at those tags, writeShim_), so the
// parser is held to what npm actually writes.
//
// Run: node --test companions/tests/peer-cli.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  PEER_CLI_OVERRIDE_ENV,
  parseCmdShim,
  resolvePeerCli,
  showValue,
  splitWindowsPath,
} from '../peer-cli.mjs';

const EXEC = 'C:\\Program Files\\nodejs\\node.exe';

// --- an in-memory file tree ------------------------------------------------

function fakeFs(entries) {
  const err = (code, p) => Object.assign(new Error(`${code}: ${p}`), { code });
  const get = (p) => entries[p];
  return {
    X_OK: 1,
    statSync(p) {
      const e = get(p);
      if (e === undefined) throw err('ENOENT', p);
      if (e.statError) throw err(e.statError, p);
      return { isFile: () => e.type !== 'dir' };
    },
    accessSync(p) {
      const e = get(p);
      if (e === undefined) throw err('ENOENT', p);
      if (!e.exec) throw err('EACCES', p);
    },
    readFileSync(p) {
      const e = get(p);
      if (e === undefined) throw err('ENOENT', p);
      if (e.readError) throw err(e.readError, p);
      return e.content ?? '';
    },
  };
}

const file = (content = '') => ({ type: 'file', content, exec: true });
const dir = () => ({ type: 'dir' });

// --- cmd-shim templates, one per distinct layout ---------------------------
// `target` is the relative target as npm writes it (backslashes); `prog` is
// 'node' for a node shim, null for a shim with no program; `args` are shebang
// arguments; `variables` a list of @SET lines (3.0.3 and later).

function shim202({ target, prog = 'node', args = '' }) {
  if (!prog) return `@"%~dp0\\${target}" ${''} ${''} %*\r\n`;
  const longProg = `"%~dp0\\${prog}.exe"`;
  const t = `"%~dp0\\${target}"`;
  return `@IF EXIST ${longProg} (\r\n`
    + `  ${longProg} ${args} ${t} %*\r\n`
    + ') ELSE (\r\n'
    + '  @SETLOCAL\r\n'
    + '  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n'
    + `  ${prog} ${args} ${t} %*\r\n`
    + ')';
}

function shim303({ target, prog = 'node', args = '', variables = '' }) {
  const head = '@ECHO off\r\nSETLOCAL\r\nCALL :find_dp0\r\n';
  const foot = 'ENDLOCAL\r\nEXIT /b %errorlevel%\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n';
  if (!prog) return `${head}"%dp0%\\${target}"   %*\r\n${foot}`;
  return head + variables + '\r\n'
    + `IF EXIST "%dp0%\\${prog}.exe" (\r\n`
    + `  SET "_prog=%dp0%\\${prog}.exe"\r\n`
    + ') ELSE (\r\n'
    + `  SET "_prog=${prog}"\r\n`
    + '  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n'
    + ')\r\n\r\n'
    + `"%_prog%" ${args.trim()} "%dp0%\\${target}" %*\r\n`
    + foot;
}

function shimCompound({ target, prog = 'node', args = '', variables = '', pathextInline }) {
  const head = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n';
  if (!prog) return `${head}"%dp0%\\${target}"   %*\r\n`;
  return head + variables + '\r\n'
    + `IF EXIST "%dp0%\\${prog}.exe" (\r\n`
    + `  SET "_prog=%dp0%\\${prog}.exe"\r\n`
    + ') ELSE (\r\n'
    + `  SET "_prog=${prog}"\r\n`
    + (pathextInline ? '' : '  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n')
    + ')\r\n\r\n'
    + 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & '
    + (pathextInline ? 'set PATHEXT=%PATHEXT:;.JS;=;% & ' : '')
    + `"%_prog%" ${args.trim()} "%dp0%\\${target}" %*\r\n`;
}
const shim410 = (o) => shimCompound({ ...o, pathextInline: false });
const shim700 = (o) => shimCompound({ ...o, pathextInline: false });
const shim902 = (o) => shimCompound({ ...o, pathextInline: true });

const LAYOUTS = { '2.0.2': shim202, '3.0.3': shim303, '4.1.0': shim410, '7.0.0': shim700, '9.0.2': shim902 };

// --- helpers ---------------------------------------------------------------

const win = (entries, env, extra = {}) =>
  resolvePeerCli(extra.name ?? 'codex', { platform: 'win32', env, cwd: 'C:\\work', execPath: EXEC, fs: fakeFs(entries), ...extra.opts });

const NPM_DIR = 'C:\\Users\\사용자 이름\\AppData\\Roaming\\npm';
const CODEX_JS = `${NPM_DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`;
const CODEX_REL = 'node_modules\\@openai\\codex\\bin\\codex.js';

function assertFails(result, ...fragments) {
  assert.equal(result.ok, false, `expected a failure, got ${JSON.stringify(result)}`);
  assert.equal(result.kind, 'peer_cli_not_found');
  for (const f of fragments) assert.ok(result.message.includes(f), `message ${JSON.stringify(result.message)} lacks ${JSON.stringify(f)}`);
  assert.ok(!/[\r\n]/.test(result.message), 'message stays one line');
}

// ---------------------------------------------------------------------------

describe('peer-cli: override variables', () => {
  it('maps each peer to its variable', () => {
    assert.deepEqual({ ...PEER_CLI_OVERRIDE_ENV }, { codex: 'CODEX_BIN', claude: 'CLAUDE_BIN' });
    assert.throws(() => resolvePeerCli('gemini', { env: {} }), TypeError);
  });

  it('POSIX: no override is the bare name, whatever PATH holds', () => {
    const r = resolvePeerCli('codex', { platform: 'linux', env: { PATH: '/nowhere' }, fs: fakeFs({}) });
    assert.deepEqual(r, { ok: true, command: 'codex', argsPrefix: [], source: 'bare', shim: null });
    const d = resolvePeerCli('claude', { platform: 'darwin', env: { CLAUDE_BIN: '' }, fs: fakeFs({}) });
    assert.equal(d.command, 'claude', 'an empty override is unset');
  });

  it('POSIX: an absolute or relative override path that is executable is used', () => {
    const fs = fakeFs({ '/opt/codex dir/코덱스': file(), '/work/bin/codex': file() });
    const abs = resolvePeerCli('codex', { platform: 'linux', env: { CODEX_BIN: '/opt/codex dir/코덱스' }, cwd: '/work', fs });
    assert.deepEqual(abs, { ok: true, command: '/opt/codex dir/코덱스', argsPrefix: [], source: 'override', shim: null });
    const rel = resolvePeerCli('codex', { platform: 'linux', env: { CODEX_BIN: './bin/codex' }, cwd: '/work', fs });
    assert.equal(rel.command, '/work/bin/codex');
  });

  it('POSIX: an override that names no file, a directory, or a non-executable file fails naming the variable, never falling back', () => {
    const fs = fakeFs({ '/opt/d': dir(), '/opt/plain': { type: 'file', exec: false }, '/usr/bin/codex': file() });
    const env = (v) => ({ CODEX_BIN: v, PATH: '/usr/bin' });
    assertFails(resolvePeerCli('codex', { platform: 'linux', env: env('/opt/missing'), fs }), 'CODEX_BIN="/opt/missing"'.replaceAll('"', ''), 'names no file');
    assertFails(resolvePeerCli('codex', { platform: 'linux', env: env('/opt/d'), fs }), 'CODEX_BIN=/opt/d', 'not a file');
    assertFails(resolvePeerCli('codex', { platform: 'linux', env: env('/opt/plain'), fs }), 'CODEX_BIN=/opt/plain', 'not executable');
    assertFails(resolvePeerCli('codex', { platform: 'linux', env: env('   '), fs }), 'CODEX_BIN=', 'not on PATH');
  });

  it('POSIX: an override found through a relative PATH entry is returned absolute, so cwd of the spawn cannot change it', () => {
    const fs = fakeFs({ '/home/u/bin/echo': file() });
    const r = resolvePeerCli('claude', { platform: 'linux', env: { CLAUDE_BIN: 'echo', PATH: 'bin' }, cwd: '/home/u', fs });
    assert.equal(r.command, '/home/u/bin/echo');
  });

  it('POSIX: a PATH directory that cannot be searched is passed over, as execvp does', () => {
    const fs = fakeFs({ '/private/codex-nightly': { type: 'file', statError: 'EACCES' }, '/opt/bin/codex-nightly': file() });
    const r = resolvePeerCli('codex', { platform: 'linux', env: { CODEX_BIN: 'codex-nightly', PATH: '/private:/opt/bin' }, fs });
    assert.equal(r.command, '/opt/bin/codex-nightly');
  });

  it('POSIX: any other error on a PATH candidate (ELOOP) stops the search, as it stops execvp', () => {
    const fs = fakeFs({ '/loop/codex-nightly': { type: 'file', statError: 'ELOOP' }, '/opt/bin/codex-nightly': file() });
    const r = resolvePeerCli('codex', { platform: 'linux', env: { CODEX_BIN: 'codex-nightly', PATH: '/loop:/opt/bin' }, fs });
    assertFails(r, '/loop/codex-nightly', 'cannot be read', 'CODEX_BIN');
  });

  it('POSIX: an override without a slash is looked up on PATH (empty entries skipped, non-executables passed over)', () => {
    const fs = fakeFs({ '/a/codex-nightly': { type: 'file', exec: false }, '/b/codex-nightly': file() });
    const r = resolvePeerCli('codex', { platform: 'linux', env: { CODEX_BIN: 'codex-nightly', PATH: '::/a:/b' }, fs });
    assert.equal(r.command, '/b/codex-nightly');
    assertFails(resolvePeerCli('codex', { platform: 'linux', env: { CODEX_BIN: 'codex-nightly' }, fs }), 'not on PATH');
  });

  it('runs the real filesystem default on a temporary executable', { skip: process.platform === 'win32' }, () => {
    const root = mkdtempSync(path.join(tmpdir(), 'peer-cli 실행-'));
    try {
      const bin = path.join(root, 'codex');
      writeFileSync(bin, '#!/bin/sh\n');
      chmodSync(bin, 0o755);
      assert.equal(resolvePeerCli('codex', { env: { CODEX_BIN: bin } }).command, bin);
      chmodSync(bin, 0o644);
      assertFails(resolvePeerCli('codex', { env: { CODEX_BIN: bin } }), 'not executable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('Windows: override forms — .exe, .com, .js, .cmd shim, bare name on PATH, relative', () => {
    const entries = {
      'D:\\tools\\codex.exe': file(),
      'D:\\tools\\codex.com': file(),
      'D:\\tools\\run me.mjs': file(),
      [`${NPM_DIR}\\codex.cmd`]: file(shim700({ target: CODEX_REL })),
      [CODEX_JS]: file(),
      'C:\\work\\bin\\codex.exe': file(),
      'D:\\tools\\codex.ps1': file(),
    };
    assert.deepEqual(win(entries, { CODEX_BIN: 'D:\\tools\\codex.exe' }),
      { ok: true, command: 'D:\\tools\\codex.exe', argsPrefix: [], source: 'override', shim: null });
    assert.equal(win(entries, { CODEX_BIN: 'D:/tools/codex.com' }).command, 'D:\\tools\\codex.com');
    assert.deepEqual(win(entries, { CODEX_BIN: 'D:\\tools\\run me.mjs' }).argsPrefix, ['D:\\tools\\run me.mjs']);
    const viaShim = win(entries, { CODEX_BIN: `${NPM_DIR}\\codex.cmd` });
    assert.deepEqual(viaShim, { ok: true, command: EXEC, argsPrefix: [CODEX_JS], source: 'override', shim: `${NPM_DIR}\\codex.cmd` });
    assert.equal(win(entries, { CODEX_BIN: 'bin\\codex.exe' }).command, 'C:\\work\\bin\\codex.exe');
    assert.equal(win(entries, { CODEX_BIN: 'codex', Path: 'D:\\tools' }).command, 'D:\\tools\\codex.exe',
      'a bare override name tries .exe then .cmd on PATH');
    assert.equal(win(entries, { CODEX_BIN: 'codex.cmd', Path: `D:\\tools;${NPM_DIR}` }).shim, `${NPM_DIR}\\codex.cmd`,
      'a bare name with an extension is looked up literally');
    assertFails(win(entries, { CODEX_BIN: 'D:\\tools\\codex.ps1' }), 'CODEX_BIN=D:\\tools\\codex.ps1', 'not runnable without a shell');
    assertFails(win(entries, { CODEX_BIN: 'C:codex.exe' }), 'CODEX_BIN=C:codex.exe', "drive's current directory");
    assertFails(win(entries, { CODEX_BIN: 'D:\\nope\\codex.exe', Path: 'D:\\tools' }), 'CODEX_BIN=D:\\nope\\codex.exe', 'names no file');
  });

  it('Windows: the override variable name is matched case-insensitively', () => {
    const entries = { 'D:\\x\\claude.exe': file() };
    assert.equal(win(entries, { claude_bin: 'D:\\x\\claude.exe' }, { name: 'claude' }).source, 'override');
  });
});

describe('peer-cli: Windows PATH search', () => {
  it('prefers an .exe over an npm .cmd shim in the same directory', () => {
    const entries = { [`${NPM_DIR}\\codex.exe`]: file(), [`${NPM_DIR}\\codex.cmd`]: file(shim700({ target: CODEX_REL })), [CODEX_JS]: file() };
    assert.deepEqual(win(entries, { Path: NPM_DIR }), { ok: true, command: `${NPM_DIR}\\codex.exe`, argsPrefix: [], source: 'path', shim: null });
  });

  it('keeps PATH order: a .cmd in an earlier directory beats an .exe in a later one', () => {
    const entries = { 'C:\\later\\codex.exe': file(), [`${NPM_DIR}\\codex.cmd`]: file(shim902({ target: CODEX_REL })), [CODEX_JS]: file() };
    const r = win(entries, { PATH: `${NPM_DIR};C:\\later` });
    assert.deepEqual(r, { ok: true, command: EXEC, argsPrefix: [CODEX_JS], source: 'path', shim: `${NPM_DIR}\\codex.cmd` });
  });

  it('ignores PATHEXT (set, unset, or without .EXE/.CMD)', () => {
    const entries = { 'C:\\bin\\codex.exe': file() };
    for (const PATHEXT of [undefined, '.COM;.EXE;.BAT;.CMD', '.BAT', '']) {
      const env = { PATH: 'C:\\bin' };
      if (PATHEXT !== undefined) env.PATHEXT = PATHEXT;
      assert.equal(win(entries, env).command, 'C:\\bin\\codex.exe', `PATHEXT=${PATHEXT}`);
    }
  });

  it('never searches the working directory; skips relative and empty entries; parses quoted entries holding ;', () => {
    // A relative entry would resolve against the working directory (C:\\work),
    // where both of these sit: neither may be found.
    const entries = { 'C:\\work\\codex.exe': file(), 'C:\\work\\rel\\codex.exe': file(), 'C:\\a;b dir\\codex.exe': file() };
    assertFails(win(entries, { PATH: 'rel;.;;' }), 'no codex.exe or npm codex.cmd shim', 'CODEX_BIN');
    assert.equal(win(entries, { PATH: 'rel;"C:\\a;b dir";C:\\other' }).command, 'C:\\a;b dir\\codex.exe');
    assert.deepEqual(splitWindowsPath(' C:\\x ;"C:\\y;z";;'), ['C:\\x', 'C:\\y;z']);
    assert.deepEqual(splitWindowsPath("'C:\\one;two';D:\\next;\"it's\""), ['C:\\one;two', 'D:\\next', "it's"]);
    // A quote opens only at an entry's start, as in libuv: an apostrophe in a
    // profile name is part of the name.
    assert.deepEqual(splitWindowsPath("C:\\Users\\O'Connor\\npm;D:\\Tools"), ["C:\\Users\\O'Connor\\npm", 'D:\\Tools']);
    const oconnor = { "C:\\Users\\O'Connor\\npm\\codex.exe": file(), 'D:\\Tools\\claude.exe': file() };
    assert.equal(win(oconnor, { PATH: "C:\\Users\\O'Connor\\npm;D:\\Tools" }).command, "C:\\Users\\O'Connor\\npm\\codex.exe");
    assert.equal(win(oconnor, { PATH: "C:\\Users\\O'Connor\\npm;D:\\Tools" }, { name: 'claude' }).command, 'D:\\Tools\\claude.exe');
  });

  it('reads PATH case-insensitively, the first key after sorting winning, and treats a missing or empty PATH as not found', () => {
    const entries = { 'C:\\one\\codex.exe': file(), 'C:\\two\\codex.exe': file() };
    assert.equal(win(entries, { Path: 'C:\\one', PATH: 'C:\\two' }).command, 'C:\\two\\codex.exe', "'PATH' sorts before 'Path'");
    assertFails(win(entries, {}), 'no codex.exe');
    assertFails(win(entries, { Path: '' }), 'no codex.exe');
  });

  it('a directory named like the CLI is passed over; an unreadable first hit stops the search', () => {
    const entries = { 'C:\\a\\codex.exe': dir(), 'C:\\b\\codex.cmd': { type: 'file', statError: 'EACCES' }, 'C:\\c\\codex.exe': file() };
    assertFails(win(entries, { PATH: 'C:\\a;C:\\b;C:\\c' }), 'C:\\b\\codex.cmd', 'cannot be read', 'CODEX_BIN');
    assert.equal(win(entries, { PATH: 'C:\\a;C:\\c' }).command, 'C:\\c\\codex.exe');
  });

  it('a shim whose content cannot be read stops the search with its name', () => {
    const entries = { 'C:\\b\\codex.cmd': { type: 'file', readError: 'EBUSY' }, 'C:\\c\\codex.exe': file() };
    assertFails(win(entries, { PATH: 'C:\\b;C:\\c' }), 'the npm shim C:\\b\\codex.cmd cannot be read', 'CODEX_BIN');
  });
});

describe('peer-cli: npm cmd-shim layouts', () => {
  for (const [version, build] of Object.entries(LAYOUTS)) {
    it(`cmd-shim ${version}: a node shim runs its target through process.execPath`, () => {
      const entries = { [`${NPM_DIR}\\codex.cmd`]: file(build({ target: CODEX_REL })), [CODEX_JS]: file() };
      assert.deepEqual(win(entries, { Path: NPM_DIR }),
        { ok: true, command: EXEC, argsPrefix: [CODEX_JS], source: 'path', shim: `${NPM_DIR}\\codex.cmd` });
    });

    it(`cmd-shim ${version}: a shim with no program runs its .exe target directly (Claude Code's npm bin)`, () => {
      const exe = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
      const entries = { [`${NPM_DIR}\\claude.cmd`]: file(build({ target: 'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe', prog: null })), [exe]: file() };
      assert.deepEqual(win(entries, { Path: NPM_DIR }, { name: 'claude' }),
        { ok: true, command: exe, argsPrefix: [], source: 'path', shim: `${NPM_DIR}\\claude.cmd` });
    });

    it(`cmd-shim ${version}: a missing target fails naming the shim, the target and the variable`, () => {
      const entries = { [`${NPM_DIR}\\codex.cmd`]: file(build({ target: CODEX_REL })) };
      assertFails(win(entries, { Path: NPM_DIR }), `${NPM_DIR}\\codex.cmd`, CODEX_JS, 'does not exist', 'CODEX_BIN');
    });
  }

  it('a local node_modules/.bin shim with ..\\ resolves against the shim directory', () => {
    const bin = 'C:\\proj\\node_modules\\.bin';
    const target = 'C:\\proj\\node_modules\\@openai\\codex\\bin\\codex.js';
    const entries = { [`${bin}\\codex.cmd`]: file(shim902({ target: '..\\@openai\\codex\\bin\\codex.js' })), [target]: file() };
    assert.deepEqual(win(entries, { Path: bin }).argsPrefix, [target]);
  });

  it('keeps a run of spaces inside the target as npm wrote it', () => {
    const exact = `${NPM_DIR}\\My  tools\\claude.exe`;
    const entries = {
      [`${NPM_DIR}\\claude.cmd`]: file(shim700({ target: 'My  tools\\claude.exe', prog: null })),
      [exact]: file(),
      [`${NPM_DIR}\\My tools\\claude.exe`]: file(),
    };
    assert.equal(win(entries, { Path: NPM_DIR }, { name: 'claude' }).command, exact);
  });

  it('a target that is a directory fails', () => {
    const entries = { [`${NPM_DIR}\\codex.cmd`]: file(shim700({ target: CODEX_REL })), [CODEX_JS]: dir() };
    assertFails(win(entries, { Path: NPM_DIR }), 'not a file');
  });

  it('refuses shebang arguments, variables, another program, mixed programs, added commands and a no-program shim whose target is not an .exe', () => {
    const NOT_A_LAYOUT = 'not exactly one of the layouts npm cmd-shim writes';
    const cases = [
      [shim902({ target: CODEX_REL, args: '--no-warnings' }), NOT_A_LAYOUT],
      [shim202({ target: CODEX_REL, args: '--no-warnings' }), NOT_A_LAYOUT],
      [shim303({ target: CODEX_REL, variables: '@SET NODE_OPTIONS=--x\r\n' }), NOT_A_LAYOUT],
      // cmd-shim turns `#!/usr/bin/env dp0=D:\other node` into this line.
      [shim902({ target: CODEX_REL, variables: '@SET dp0=D:\\other\r\n' }), NOT_A_LAYOUT],
      [shim700({ target: 'bin\\codex.sh', prog: 'bash' }), NOT_A_LAYOUT],
      [shim202({ target: 'bin\\codex.sh', prog: 'bash' }), NOT_A_LAYOUT],
      // node in one branch, bash in the other
      [shim700({ target: CODEX_REL }).replace('SET "_prog=node"', 'SET "_prog=bash"'), NOT_A_LAYOUT],
      // the same target launched through node and directly
      [shim202({ target: CODEX_REL }).replace('  node  "%~dp0', '  "%~dp0'), NOT_A_LAYOUT],
      // a command before the launch, and an argument after %*
      [shim202({ target: 'tool.exe', prog: null }).replace('@"', '@EXIT /b 42\r\n@"'), NOT_A_LAYOUT],
      [shim700({ target: CODEX_REL }).replace('%*\r\n', '%* --extra\r\n'), NOT_A_LAYOUT],
      [shim700({ target: CODEX_REL, prog: null }), 'only an .exe target'],
    ];
    for (const [text, fragment] of cases) {
      const entries = { [`${NPM_DIR}\\codex.cmd`]: file(text), [CODEX_JS]: file(), [`${NPM_DIR}\\bin\\codex.sh`]: file(), [`${NPM_DIR}\\tool.exe`]: file() };
      assertFails(win(entries, { Path: NPM_DIR }), fragment, 'CODEX_BIN', `${NPM_DIR}\\codex.cmd`);
    }
  });

  it('refuses a malformed shim: no launch line, conflicting targets, a rooted target, a match only in a comment', () => {
    const malformed = [
      ['@ECHO off\r\ncodex.exe %*\r\n', 'no npm cmd-shim launch line'],
      [shim202({ target: CODEX_REL }).replace(/codex\.js" %\*\r\n\)$/, 'other.js" %*\r\n)'), 'launches different targets'],
      // the two branches differ only in blanks the layout comparison collapses
      [shim202({ target: 'My  tools\\codex.js' }).replace(/My  tools(\\codex\.js" %\*\r\n\)$)/, 'My tools$1'), 'launches different targets'],
      [shim700({ target: 'C:\\evil\\codex.js' }), 'rooted target'],
      ['@ECHO off\r\n@REM "%dp0%\\codex.js" %*\r\n:: "%dp0%\\codex.js" %*\r\n', 'not exactly one of the layouts'],
    ];
    for (const [text, fragment] of malformed) {
      assert.ok(parseCmdShim(text).error, `parser refuses: ${fragment}`);
      const entries = { [`${NPM_DIR}\\codex.cmd`]: file(text), [CODEX_JS]: file() };
      assertFails(win(entries, { Path: NPM_DIR }), fragment, 'CODEX_BIN');
    }
  });

  it('every layout parses to its own version and program', () => {
    for (const [version, build] of Object.entries(LAYOUTS)) {
      const expected = version === '7.0.0' ? '4.1.0' : version;
      assert.deepEqual(parseCmdShim(build({ target: CODEX_REL })), { program: 'node', target: CODEX_REL, version: expected });
      assert.equal(parseCmdShim(build({ target: 'x\\y.exe', prog: null })).program, 'none');
    }
  });
});

describe('peer-cli: messages', () => {
  it('escapes control characters in the values a message shows', () => {
    assert.equal(showValue('a\r\nb\u0007'), 'a\\u000d\\u000ab\\u0007');
    const r = resolvePeerCli('codex', { platform: 'linux', env: { CODEX_BIN: '/x\n/y' }, fs: fakeFs({}) });
    assertFails(r, '/x\\u000a/y');
  });
});
