// Mutation spec — do the tests catch a peer-CLI launch resolver that falls
// back past a broken override, picks the shim over the .exe, runs a .cmd,
// accepts a shim with no target, searches a relative PATH entry, or a
// companion that spawns after a failed resolution? (C180 part 1)
//
// Run: npm run mutate -- scripts/mutation-specs/peer-cli-resolver.mjs
//
// R1-R4 and R6-R8 are the resolver's fail-closed points
// (companions/peer-cli.mjs), R5 the companion's: a failed resolution must end
// in the exit-3 envelope with no spawn. Eight cases: a `mutate` check names at
// most six of them (AGENTS.md), so run them as two checks.

const T_RESOLVER = 'companions/tests/peer-cli.test.mjs';
const T_CODEX = 'companions/tests/codex-companion.test.mjs';

export const TESTS = [T_RESOLVER, T_CODEX];

export const MUTATIONS = [
  {
    id: 'R1', file: 'companions/peer-cli.mjs', tests: [T_RESOLVER],
    from: "  if (override !== undefined && override !== '') {\n",
    to: "  if (override !== undefined && override !== '' && probe(fs, p.resolve(cwd, String(override))) === 'file') {\n",
    why: 'an override naming no file is ignored and the companion silently runs whatever the platform lookup finds',
    killed_by: /an override that names no file, a directory, or a non-executable file fails naming the variable, never falling back/,
  },
  {
    id: 'R2', file: 'companions/peer-cli.mjs', tests: [T_RESOLVER],
    from: "const WINDOWS_PATH_EXTS = Object.freeze(['.exe', '.cmd']);\n",
    to: "const WINDOWS_PATH_EXTS = Object.freeze(['.cmd', '.exe']);\n",
    why: 'the npm shim wins over a native .exe in the same directory',
    killed_by: /prefers an \.exe over an npm \.cmd shim in the same directory/,
  },
  {
    id: 'R3', file: 'companions/peer-cli.mjs', tests: [T_RESOLVER],
    from: "  if (ext === '.cmd') return launchFromShim({ name, variable, shimPath: file, source, fs, execPath, p });\n",
    to: "  if (ext === '.cmd') return launch(file, [], source);\n",
    why: 'the .cmd itself is spawned, which Node refuses without a shell (EINVAL) on Windows',
    killed_by: [/node shim runs its target through process\.execPath/, /a shim with no program runs its \.exe target directly/],
  },
  {
    id: 'R4', file: 'companions/peer-cli.mjs', tests: [T_RESOLVER],
    from: "  const state = probe(fs, target);\n  if (state !== 'file') {\n",
    to: "  const state = probe(fs, target);\n  if (state === 'other') {\n",
    why: 'a shim whose target is gone resolves, and the spawn fails later with no word of the shim or the variable',
    killed_by: /a missing target fails naming the shim, the target and the variable/,
  },
  {
    id: 'R5', file: 'companions/codex-companion.mjs', tests: [T_CODEX],
    from: '  if (!launch.ok) {\n',
    to: '  if (false) {\n',
    why: 'the companion spawns after a failed resolution instead of reporting peer_cli_not_found',
    killed_by: [/a resolution failure spawns nothing and returns a complete invocation/, /a resolution failure exits 3 in json mode/],
  },
  {
    id: 'R6', file: 'companions/peer-cli.mjs', tests: [T_RESOLVER],
    from: '  const dirs = windows ? splitWindowsPath(raw).filter(isWindowsAbsoluteDir)\n',
    to: '  const dirs = windows ? splitWindowsPath(raw)\n',
    why: 'a relative PATH entry is searched, so a codex.exe in the working directory can be picked up',
    killed_by: /never searches the working directory; skips relative and empty entries/,
  },
  {
    id: 'R7', file: 'companions/peer-cli.mjs', tests: [T_RESOLVER],
    from: '    return expected.length === lines.length && expected.every((l, i) => l === lines[i]);\n',
    to: "    return lines.includes(expected.find((l) => l.includes('%*')));\n",
    why: 'a shim is accepted on its launch line alone, so an added command, a variable or a reassigned dp0 around it goes unnoticed',
    killed_by: /refuses shebang arguments, variables, another program, mixed programs, added commands/,
  },
  {
    id: 'R8', file: 'companions/peer-cli.mjs', tests: [T_RESOLVER],
    from: `    } else if (atStart && (c === '"' || c === "'")) {\n`,
    to: `    } else if (c === '"' || c === "'") {\n`,
    why: "an apostrophe inside a PATH entry (C:\\Users\\O'Connor\\...) opens a quote and merges it with the entries after it",
    killed_by: /never searches the working directory; skips relative and empty entries/,
  },
];
