// Mutation spec — do the tests catch a temporary-file leak guard that stops
// failing, stops telling files apart, or a helper that stops removing what a
// test made? (docket C175)
//
// Run: npm run mutate -- scripts/mutation-specs/tmp-guard.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. The guard's whole job is to fail: a guard that
// never sets an exit code, or declares every file, leaves the suite exactly
// as green as a guard that works, and so does a helper that removes nothing
// once no test fails. Each case below breaks one link of the chain — the
// helper's removal call, the per-file directory, the declaration check, the
// exit code, the runner's removal of its own run directory, and the runner's
// look at an entry made after the guard's count — and names the test that
// must notice. Six cases, which one `mutate` check runs (AGENTS.md).
//
// NO CASE EDITS scripts/lib/remove-tree.mjs. A mutation's copy is no sandbox:
// the harness changes the working directory and the environment, nothing
// else, so a removal helper with its containment or its link handling cut
// would run against the real file system. Those properties are held by
// tests/scripts/test-tmp-guard.mjs on a fake file system that records calls
// (two of its refusals that look at the file system, a link that leads out
// of the base and a base replaced since it was held, run once more on the
// real one, on directories the test made in its own temporary directory).

const T = 'tests/scripts/test-tmp-guard.mjs';

export const TESTS = [T];

export const MUTATIONS = [
  {
    id: 'G1', file: 'tests/_tmp.mjs', tests: [T],
    from: '  t.after(() => removeTree(base, dir));\n',
    to: '',
    why: 'tmpDir no longer removes its directory, so a test that throws first leaves it behind (C175 as found)',
    killed_by: /tmpDir and fileTmpDirs remove their directories when a test fails/,
  },
  {
    id: 'G3', file: 'tests/_tmp-guard.mjs', tests: [T],
    from: '  const dir = fs.mkdtempSync(path.join(runDir, FILE_DIR_PREFIX));\n',
    to: '  const dir = path.join(runDir, `${FILE_DIR_PREFIX}shared`);\n  fs.mkdirSync(dir, { recursive: true });\n',
    why: 'every test file shares one TMPDIR, so what one file leaves is charged to another running beside it',
    killed_by: /each file gets a TMPDIR of its own in the run directory/,
  },
  {
    id: 'G4', file: 'tests/_tmp-guard.mjs', tests: [T],
    from: '  const declared = run.leaks.includes(file);\n',
    to: '  const declared = true;\n',
    why: 'every file counts as declared, so a new leaker passes unnoticed',
    killed_by: [/an undeclared file that leaves an entry fails/, /npm test with the real preloads fails an undeclared leaker/],
  },
  {
    id: 'G5', file: 'tests/_tmp-guard.mjs', tests: [T],
    from: '      process.exitCode = 1;\n',
    to: '',
    why: 'the guard reports an undeclared leaker but never fails its file',
    killed_by: /an undeclared file that leaves an entry fails/,
  },
  {
    id: 'G6', file: 'scripts/run-tests.mjs', tests: [T],
    from: '    removeTree(base, runDir);\n',
    to: '    void base;\n',
    why: 'the runner no longer removes its run directory, so every npm test leaves a tg-* tree in the system temporary directory',
    killed_by: [/leaves no run directory/, /removes it all/],
  },
  {
    id: 'G8', file: 'scripts/lib/tmp-leaks.mjs', tests: [T],
    from: '      const late = counted ? left.filter((n) => !counted.has(n)) : left;\n',
    to: '      const late = [];\n',
    why: 'the runner trusts a file\'s result and never looks at its directory, so an entry an exit listener makes after the count escapes and the run passes',
    killed_by: [/an entry made after the guard's count is charged to its file by the runner/, /npm test fails an undeclared file whose entry was made after the guard's count/],
  },
];
