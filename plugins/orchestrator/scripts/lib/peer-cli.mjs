// COPIED from companions — do not edit this copy.
// Source: companions/peer-cli.mjs, byte for byte below these
// three lines; tests/scripts/test-orchestrator-peer-snapshot-parity.mjs checks it.
// Peer-CLI launch resolver shared by both companions (C180 part 1).
//
// resolvePeerCli('codex' | 'claude') says how to start the peer CLI without a
// shell: `{ ok: true, command, argsPrefix, source, shim }`, spawned as
// spawn(command, [...argsPrefix, ...peerArgs]), or a typed failure
// `{ ok: false, kind: 'peer_cli_not_found', message, detail }` that the
// companion reports as its contract § 5.3 exit-3 envelope. Resolution is
// implementation behaviour (companions/README.md § Peer CLI resolution); the
// wire contract does not change.
//
// Order:
// 1. The override variable (CODEX_BIN / CLAUDE_BIN), on every platform, when
//    set and non-empty. A value with a path separator is a path, resolved
//    against `cwd`; a value without one is a file name looked up on PATH. An
//    override that names nothing runnable is an error naming the variable,
//    never a fallback.
// 2. Not Windows: the bare name, which spawn finds on PATH as it always has.
// 3. Windows: PATH directories in order (no current-directory search, PATHEXT
//    ignored), each trying <name>.exe, then <name>.cmd. An .exe runs as is. A
//    .cmd is read as an npm cmd-shim and never run itself: a node shim runs
//    its target as `process.execPath <target>`, a shim with no program whose
//    target is an .exe runs that .exe. The first hit is final.
//
// The module imports only node built-ins, so a package that needs the same
// resolution can keep a byte copy of it under a drift check.

import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const PEER_CLI_OVERRIDE_ENV = Object.freeze({ codex: 'CODEX_BIN', claude: 'CLAUDE_BIN' });
export const PEER_CLI_NOT_FOUND = 'peer_cli_not_found';

const REAL_FS = Object.freeze({ statSync, accessSync, readFileSync, X_OK: constants.X_OK });
const WINDOWS_PATH_EXTS = Object.freeze(['.exe', '.cmd']);
const WINDOWS_OVERRIDE_EXTS = new Set(['.exe', '.com', '.cmd', '.js', '.mjs', '.cjs']);
const JS_EXTS = new Set(['.js', '.mjs', '.cjs']);
const SHIM_TARGET = /"%(?:~dp0|dp0%)\\([^"]+?)"\s+%\*/;

// The .cmd text every cmd-shim release from 2.0.2 to 9.0.2 writes, one entry
// per distinct layout (github.com/npm/cmd-shim, writeShim_ at 2.0.2, 3.0.3,
// 4.1.0 = 7.0.0 and 9.0.2), as lines for a target `t`: a node shim (the
// target's shebang names node, with no arguments or variables) and a shim
// with no program (the target itself is launched). A shim is accepted only
// when its lines, blanks dropped and runs of blanks collapsed, equal one of
// these exactly, so no extra command, argument or assignment slips through.
const V3_HEAD = ['@ECHO off', 'SETLOCAL', 'CALL :find_dp0'];
const V3_FOOT = ['ENDLOCAL', 'EXIT /b %errorlevel%', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b'];
const V4_HEAD = ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0'];
const PROG_SELECT = ['IF EXIST "%dp0%\\node.exe" (', 'SET "_prog=%dp0%\\node.exe"', ') ELSE (', 'SET "_prog=node"'];
const V4_LAUNCH = 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% &';
export const CMD_SHIM_LAYOUTS = Object.freeze([
  { version: '2.0.2', program: 'node', lines: (t) => ['@IF EXIST "%~dp0\\node.exe" (', `"%~dp0\\node.exe" "%~dp0\\${t}" %*`, ') ELSE (', '@SETLOCAL', '@SET PATHEXT=%PATHEXT:;.JS;=;%', `node "%~dp0\\${t}" %*`, ')'] },
  { version: '2.0.2', program: 'none', lines: (t) => [`@"%~dp0\\${t}" %*`] },
  { version: '3.0.3', program: 'node', lines: (t) => [...V3_HEAD, ...PROG_SELECT, 'SET PATHEXT=%PATHEXT:;.JS;=;%', ')', `"%_prog%" "%dp0%\\${t}" %*`, ...V3_FOOT] },
  { version: '3.0.3', program: 'none', lines: (t) => [...V3_HEAD, `"%dp0%\\${t}" %*`, ...V3_FOOT] },
  { version: '4.1.0', program: 'node', lines: (t) => [...V4_HEAD, ...PROG_SELECT, 'SET PATHEXT=%PATHEXT:;.JS;=;%', ')', `${V4_LAUNCH} "%_prog%" "%dp0%\\${t}" %*`] },
  { version: '9.0.2', program: 'node', lines: (t) => [...V4_HEAD, ...PROG_SELECT, ')', `${V4_LAUNCH} set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%" "%dp0%\\${t}" %*`] },
  { version: '4.1.0', program: 'none', lines: (t) => [...V4_HEAD, `"%dp0%\\${t}" %*`] },
]);

// Paths and values shown in a message: control characters escaped, since the
// message travels as one line (the dispatcher refuses a raw CR or LF).
export function showValue(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// Windows environment names are case-insensitive: Node sorts the keys and uses
// the first that matches, and so does this.
export function readEnv(env, name, windows) {
  if (!windows) return env[name];
  const upper = name.toUpperCase();
  const key = Object.keys(env).sort().find((k) => k.toUpperCase() === upper);
  return key === undefined ? undefined : env[key];
}

// A Windows PATH value split on libuv's rule for quotes: `;` separates
// entries, and an entry that opens with a double or single quote runs to the
// matching quote, `;` included, the quotes removed. A quote anywhere else is
// part of the name (C:\Users\O'Connor\...); libuv also drops a stray quote
// at an entry's end, which this keeps (no installer writes one).
export function splitWindowsPath(value) {
  const entries = [];
  let current = '';
  let atStart = true;
  let quote = null;
  for (const c of String(value)) {
    if (quote !== null) {
      if (c === quote) quote = null;
      else current += c;
    } else if (atStart && (c === '"' || c === "'")) {
      quote = c;
      atStart = false;
    } else if (c === ';') {
      entries.push(current);
      current = '';
      atStart = true;
    } else {
      current += c;
      atStart = false;
    }
  }
  entries.push(current);
  return entries.map((e) => e.trim()).filter((e) => e !== '');
}

const isWindowsAbsoluteDir = (dir) => /^[A-Za-z]:[\\/]/.test(dir) || /^[\\/]{2}[^\\/]/.test(dir);

function fail(message, detail = null) {
  return { ok: false, kind: PEER_CLI_NOT_FOUND, message, detail };
}

function launch(command, argsPrefix, source, shim = null) {
  return { ok: true, command, argsPrefix, source, shim };
}

// 'file' | 'absent' | 'other' (a directory or other non-file) | an Error that
// is neither absence nor a type mismatch (EACCES, ELOOP, ...).
function probe(fs, p) {
  try {
    return fs.statSync(p).isFile() ? 'file' : 'other';
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return 'absent';
    return err instanceof Error ? err : new Error(String(err));
  }
}

const recovery = (name, variable) =>
  `install ${name}, or set ${variable} to the ${name} executable`;

// Reads an npm cmd-shim and says what it launches: { program: 'node' |
// 'none', target, version } or { error }. The target is taken from the first
// launch line, then the whole text must be one of CMD_SHIM_LAYOUTS for it.
export function parseCmdShim(text) {
  // Blank runs are collapsed only to compare a line with its layout; the
  // target is read from the line as written, so a name with two spaces keeps
  // them.
  const normalize = (l) => l.replace(/[ \t]+/g, ' ').trim();
  const raw = String(text).split(/\r?\n/).filter((l) => l.trim() !== '');
  const lines = raw.map(normalize);
  const targets = new Set(raw.map((l) => l.match(SHIM_TARGET)).filter(Boolean).map((m) => m[1]));
  if (targets.size === 0) return { error: 'has no npm cmd-shim launch line ("%dp0%\\<target>" %*)' };
  // npm writes one target into every launch line; two that differ, even only
  // in blanks the comparison below would not see, are not its layout.
  if (targets.size > 1) return { error: `launches different targets (${[...targets].map(showValue).join(', ')})` };
  const [target] = targets;
  const layout = CMD_SHIM_LAYOUTS.find((candidate) => {
    const expected = candidate.lines(target).map(normalize);
    return expected.length === lines.length && expected.every((l, i) => l === lines[i]);
  });
  if (!layout) {
    return { error: 'is not exactly one of the layouts npm cmd-shim writes (another program, shebang arguments or variables, or an added command)' };
  }
  if (/^[A-Za-z]:/.test(target) || /^[\\/]/.test(target)) {
    return { error: `names a rooted target ${showValue(target)} where npm writes a relative one` };
  }
  return { program: layout.program, target, version: layout.version };
}

// An npm .cmd shim, turned into the launch it stands for.
function launchFromShim({ name, variable, shimPath, source, fs, execPath, p }) {
  let text;
  try {
    text = fs.readFileSync(shimPath, 'utf8');
  } catch (err) {
    return fail(`peer CLI "${name}": the npm shim ${showValue(shimPath)} cannot be read; ${recovery(name, variable)}`,
      err && err.message ? showValue(err.message) : null);
  }
  const parsed = parseCmdShim(text);
  if (parsed.error) {
    return fail(`peer CLI "${name}": the npm shim ${showValue(shimPath)} ${parsed.error}; set ${variable} to the ${name} executable (only the npm cmd-shim layout is supported)`);
  }
  const target = p.resolve(p.dirname(shimPath), parsed.target);
  const state = probe(fs, target);
  if (state !== 'file') {
    const why = state === 'absent' ? 'which does not exist'
      : state === 'other' ? 'which is not a file' : 'which cannot be read';
    return fail(`peer CLI "${name}": the npm shim ${showValue(shimPath)} points at ${showValue(target)}, ${why}; reinstall ${name}, or set ${variable} to the ${name} executable`,
      state instanceof Error ? showValue(state.message) : null);
  }
  if (parsed.program === 'node') return launch(execPath, [target], source, shimPath);
  if (p.extname(target).toLowerCase() === '.exe') return launch(target, [], source, shimPath);
  return fail(`peer CLI "${name}": the npm shim ${showValue(shimPath)} launches ${showValue(target)} with no program, and only an .exe target can run that way; set ${variable} to the ${name} executable`);
}

// A file the override named, or a PATH hit on Windows, turned into its launch.
function launchFromFile({ name, variable, file, source, windows, fs, execPath, p, viaOverride }) {
  const label = viaOverride ? `${variable}=${showValue(file)}` : showValue(file);
  if (!windows) {
    try {
      fs.accessSync(file, fs.X_OK);
    } catch (err) {
      return fail(`peer CLI "${name}": ${label} is not executable; set ${variable} to the ${name} executable`,
        err && err.message ? showValue(err.message) : null);
    }
    return launch(file, [], source);
  }
  const ext = p.extname(file).toLowerCase();
  if (ext === '.exe' || ext === '.com') return launch(file, [], source);
  if (ext === '.cmd') return launchFromShim({ name, variable, shimPath: file, source, fs, execPath, p });
  if (JS_EXTS.has(ext)) return launch(execPath, [file], source);
  return fail(`peer CLI "${name}": ${label} is not runnable without a shell (an .exe, .com, npm .cmd shim or JavaScript file is); set ${variable} to the ${name} executable`);
}

// The first PATH entry holding one of `names`, or null; on Windows a hit that
// cannot be checked (EACCES, ...) is a hit too, and the caller reports it.
function searchPath({ env, windows, fs, p, names, cwd }) {
  const raw = readEnv(env, 'PATH', windows);
  if (raw === undefined || raw === '') return null;
  const dirs = windows ? splitWindowsPath(raw).filter(isWindowsAbsoluteDir)
    : String(raw).split(':').filter((d) => d !== '');
  for (const dir of dirs) {
    for (const n of names) {
      // Absolute, so the file checked is the file spawned whatever cwd the
      // spawn runs in.
      const candidate = p.resolve(cwd, dir, n);
      const state = probe(fs, candidate);
      if (state === 'absent' || state === 'other') continue;
      // On Windows the first hit is final, so one that cannot be checked is
      // reported. Elsewhere a directory that cannot be searched (EACCES) is
      // passed over, as execvp passes it over; any other error stops the
      // search, as it stops execvp.
      if (state instanceof Error) {
        if (!windows && state.code === 'EACCES') continue;
        return { file: candidate, error: state };
      }
      if (!windows) {
        try { fs.accessSync(candidate, fs.X_OK); } catch { continue; }
      }
      return { file: candidate };
    }
  }
  return null;
}

export function resolvePeerCli(name, {
  env = process.env,
  platform = process.platform,
  cwd = process.cwd(),
  execPath = process.execPath,
  fs = REAL_FS,
} = {}) {
  const variable = PEER_CLI_OVERRIDE_ENV[name];
  if (!variable) throw new TypeError(`unknown peer CLI ${JSON.stringify(name)}`);
  const windows = platform === 'win32';
  const p = windows ? path.win32 : path.posix;
  const base = { name, variable, windows, fs, execPath, p };

  const override = readEnv(env, variable, windows);
  if (override !== undefined && override !== '') {
    const value = String(override);
    const hasSeparator = windows ? /[\\/]/.test(value) || /^[A-Za-z]:/.test(value) : value.includes('/');
    if (windows && /^[A-Za-z]:(?![\\/])/.test(value)) {
      return fail(`peer CLI "${name}": ${variable}=${showValue(value)} is relative to a drive's current directory; set ${variable} to a full path`);
    }
    if (hasSeparator) {
      const file = p.resolve(cwd, value);
      const state = probe(fs, file);
      if (state !== 'file') {
        const why = state === 'absent' ? 'names no file' : state === 'other' ? 'names something that is not a file' : 'cannot be read';
        return fail(`peer CLI "${name}": ${variable}=${showValue(value)} ${why}; set ${variable} to the ${name} executable, or unset it`,
          state instanceof Error ? showValue(state.message) : null);
      }
      return launchFromFile({ ...base, file, source: 'override', viaOverride: true });
    }
    const names = windows && !WINDOWS_OVERRIDE_EXTS.has(p.extname(value).toLowerCase())
      ? WINDOWS_PATH_EXTS.map((e) => value + e) : [value];
    const hit = searchPath({ env, windows, fs, p, names, cwd });
    if (!hit) {
      return fail(`peer CLI "${name}": ${variable}=${showValue(value)} is not on PATH; set ${variable} to the ${name} executable's full path, or unset it`);
    }
    if (hit.error) {
      return fail(`peer CLI "${name}": ${variable}=${showValue(value)} found ${showValue(hit.file)} on PATH, which cannot be read; set ${variable} to the ${name} executable's full path`, showValue(hit.error.message));
    }
    return launchFromFile({ ...base, file: hit.file, source: 'override', viaOverride: true });
  }

  if (!windows) return launch(name, [], 'bare');

  const hit = searchPath({ env, windows, fs, p, names: WINDOWS_PATH_EXTS.map((e) => name + e), cwd });
  if (!hit) {
    return fail(`peer CLI "${name}": no ${name}.exe or npm ${name}.cmd shim in a PATH directory; ${recovery(name, variable)}`);
  }
  if (hit.error) {
    return fail(`peer CLI "${name}": ${showValue(hit.file)}, the first ${name} on PATH, cannot be read; ${recovery(name, variable)}`, showValue(hit.error.message));
  }
  return launchFromFile({ ...base, file: hit.file, source: 'path', viaOverride: false });
}
