// Mutation spec — do the shard tests catch the defects they exist for?
//
// Run: npm run mutate -- scripts/mutation-specs/full-tests-shards.mjs
//
// full-tests.yml runs the suite as shards (ADR-0033, amendment of 2026-10-19).
// A defect in the split, the launch or the workflow's wiring does not fail a
// test: it runs fewer of them, and CI stays green. Each mutation below puts
// one such defect in and names the test that must notice.
//
// Groups: D discovery, P the partition, R the launch, W the workflow's
// wiring, K recorded weights.
//
// Not here: launching through a shell instead of an argument array. Every
// path is held to letters, digits, `.`, `_`, `-` and `/` before the launch
// (P5), so a shell splits the list exactly as the array does; the mutation is
// equivalent, and the whitelist is what P5 tests.

const COVERAGE = 'tests/scripts/test-full-suite-coverage.mjs';
const SHARD_TESTS = 'tests/scripts/test-shard-tests.mjs';
const DISCOVERY_TESTS = 'tests/scripts/test-discover-tests.mjs';

const CLI = 'scripts/shard-tests.mjs';
const DISCOVER = 'scripts/lib/discover-tests.mjs';
const WORKFLOW = '.github/workflows/full-tests.yml';

export const TESTS = [COVERAGE, SHARD_TESTS, DISCOVERY_TESTS];

export const MUTATIONS = [
  // ---- D: discovery is Node's ------------------------------------------------
  {
    id: 'D1', file: DISCOVER, tests: [DISCOVERY_TESTS],
    from: "exclude: (name) => name === 'node_modules',",
    to: "exclude: (name) => name === 'node_modules' || name === 'test',",
    why: 'the list skips files node --test runs, so no shard runs them',
    killed_by: /names exactly the files a real no-argument node --test executes/,
  },
  {
    id: 'D2', file: DISCOVER, tests: [DISCOVERY_TESTS],
    from: "'**/{test,test/**/*,test-*,*[._-]test}.{js,mjs,cjs,ts,mts,cts}'",
    to: "'**/{test,test/**/*,test-*,*[._-]test}.{js,mjs,cjs}'",
    why: 'TypeScript tests node --test runs drop out of the list',
    killed_by: /names exactly the files a real no-argument node --test executes/,
  },
  {
    id: 'D3', file: DISCOVER, tests: [SHARD_TESTS],
    from: ".map((rel) => rel.split(path.sep).join('/'))",
    to: ".map((rel) => rel.split('\\\\').join('/'))",
    why: 'a backslash in a POSIX file name becomes a separator, and the shard runs another file in its place',
    killed_by: /a backslash in a file name stays part of the name/,
  },

  // ---- P: the shards are an exact partition ---------------------------------
  {
    id: 'P1', file: CLI,
    from: 'for (const { rel, weight } of order) {',
    to: 'for (const { rel, weight } of order.slice(1)) {',
    why: 'the heaviest file is assigned to no shard',
    killed_by: [/\(iii\) full-tests\.yml runs the suite as shards/, /run every discovered file exactly once, for every shard count/],
  },
  {
    id: 'P2', file: CLI,
    from: '    shards[target].push(rel);',
    to: '    shards[target].push(rel);\n    if (target > 0) shards[0].push(rel);',
    why: 'a file runs in two shards',
    killed_by: [/\(iii\) full-tests\.yml runs the suite as shards/, /run every discovered file exactly once, for every shard count/],
  },
  {
    id: 'P3', file: CLI,
    from: "if (where.length === 0) problems.push(`${rel} is in no shard`);",
    to: 'if (false) void 0;',
    why: 'the partition check passes a file that is in no shard',
    killed_by: /partitionProblems names a dropped, duplicated or undiscovered file/,
  },
  {
    id: 'P4', file: CLI,
    from: 'if (shard.length === 0) problems.push(',
    to: 'if (false) problems.push(',
    why: 'the partition check passes an empty shard',
    killed_by: /partitionProblems names a dropped, duplicated or undiscovered file/,
  },
  {
    id: 'P5', file: CLI,
    from: "&& /^[A-Za-z0-9._/-]+$/.test(rel)",
    to: "&& /^[^\\0]+$/.test(rel)",
    why: 'a path with a space or a glob character reaches the runner, which reads it as something else',
    killed_by: [/only a path the runner receives unchanged is safe/, /run refuses a shard of a tree with an unsafe test path/],
  },
  {
    id: 'P6', file: CLI,
    from: '.sort((a, b) => b.weight - a.weight || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));',
    to: '.sort((a, b) => b.weight - a.weight);',
    why: 'ties fall in input order, so two shards of one run can compute different partitions',
    killed_by: /deterministic and independent of the order/,
  },
  {
    id: 'P7', file: CLI,
    from: 'if (loads[i] < loads[target]) target = i;',
    to: 'if (loads[i] > loads[target]) target = i;',
    why: 'each file goes to the most-loaded shard: the split is no longer balanced',
    killed_by: /heaviest file first, each to the least-loaded shard/,
  },

  // ---- R: the launch ---------------------------------------------------------
  {
    id: 'R1', file: CLI,
    from: 'if (missing.length > 0) {',
    to: 'if (false) {',
    why: 'a file that does not exist reaches node --test, which skips it and exits 0',
    killed_by: /run refuses a shard that names a file that does not exist/,
  },
  {
    id: 'R2', file: CLI,
    from: 'return res.status ?? 1;',
    to: 'return 0;',
    why: 'a failing shard reports success',
    killed_by: /run hands npm test exactly its shard's files/,
  },
  {
    id: 'R3', file: CLI,
    from: "spawnSync('npm', ['test', '--', ...files],",
    to: "spawnSync('npm', ['test', '--', ...files.slice(1)],",
    why: 'the shard prints a file it never runs',
    killed_by: [/run hands npm test exactly its shard's files/, /with the real npm, the shards execute every discovered file exactly once/],
  },
  {
    id: 'R4', file: CLI,
    from: "for (const name of Object.keys(env)) if (name.startsWith('NODE_TEST_')) delete env[name];",
    to: 'void env;',
    why: 'a shard started under a test runner inherits NODE_TEST_CONTEXT, and its node --test runs nothing and passes',
    killed_by: [/run hands npm test exactly its shard's files/, /with the real npm, the shards execute every discovered file exactly once/],
  },
  {
    id: 'R5', file: CLI,
    from: "if (Object.hasOwn(readPackageScripts(repoRoot), 'pretest')) {",
    to: 'if (false) {',
    why: 'a pretest hook runs between the existence check and node --test',
    killed_by: /run refuses a package\.json with a pretest hook/,
  },

  // ---- W: the workflow's wiring ---------------------------------------------
  {
    id: 'W1', file: WORKFLOW, tests: [COVERAGE],
    from: '          SHARD: ${{ matrix.shard }}',
    to: '          SHARD: 1',
    why: 'every shard runs shard 1: the rest of the suite runs nowhere',
    killed_by: /\(iii\)/,
  },
  {
    id: 'W2', file: WORKFLOW, tests: [COVERAGE],
    from: '          TOTAL: ${{ strategy.job-total }}',
    to: '          TOTAL: 4',
    why: 'three jobs run shards 1 to 3 of four: shard 4 runs nowhere',
    killed_by: /\(iii\)/,
  },
  {
    id: 'W3', file: WORKFLOW, tests: [COVERAGE],
    from: '        run: test "$SHARDS" = success',
    to: "        run: 'true'",
    why: 'the required check passes with a failed shard',
    killed_by: /\(iii\)/,
  },
  {
    id: 'W4', file: WORKFLOW, tests: [COVERAGE],
    from: '    if: ${{ always() && !github.event.deleted }}',
    to: '    if: ${{ !github.event.deleted }}',
    why: 'a failed shard skips the required check, and a skipped required check reads as passing',
    killed_by: /\(iii\)/,
  },
  {
    id: 'W5', file: WORKFLOW, tests: [COVERAGE],
    from: '        timeout-minutes: 20\n',
    to: '        timeout-minutes: 20\n        continue-on-error: true\n',
    why: 'a failing shard counts as success',
    killed_by: /\(iii\)/,
  },
  {
    id: 'W6', file: WORKFLOW, tests: [COVERAGE],
    from: '        shard: [1, 2, 3]\n',
    to: '        shard: [1, 2, 3]\n        exclude:\n          - shard: 2\n',
    why: 'one shard of the partition is never started',
    killed_by: /\(iii\)/,
  },
  {
    id: 'W7', file: WORKFLOW, tests: [COVERAGE],
    from: '        shard: [1, 2, 3]\n',
    to: '        shard: [1, 3]\n',
    why: 'the shards are not 1..N, so shard 2 of the partition runs nowhere',
    killed_by: /\(iii\)/,
  },
  {
    id: 'W8', file: WORKFLOW, tests: [COVERAGE],
    from: '          fetch-depth: 0\n',
    to: '          fetch-depth: 1\n',
    why: 'the tests that read release tags skip instead of running',
    killed_by: /\(iii\)/,
  },

  // ---- K: recorded weights ---------------------------------------------------
  {
    id: 'K1', file: CLI,
    from: "if (last?.summary !== true) problems.push(",
    to: 'if (false) problems.push(',
    why: 'a stopped run rewrites the weights from part of the suite',
    killed_by: /record refuses a run that did not finish/,
  },
  {
    id: 'K3', file: CLI,
    from: 'else if (event.success !== true || event.counts?.cancelled !== 0) problems.push(',
    to: 'else if (false) problems.push(',
    why: 'a failed or cancelled run, whose files may have stopped early, rewrites the weights',
    killed_by: /record refuses a run that did not finish/,
  },
  {
    id: 'K4', file: CLI,
    from: 'const abs = path.resolve(root, event.file);',
    to: 'let abs = path.resolve(root, event.file);\n    try { abs = fs.realpathSync(abs); } catch { /* as before the fix */ }',
    why: 'a linked test file is recorded under its target\'s name, so a complete run is refused',
    killed_by: /record takes the reporter's output of a real run/,
  },
  {
    id: 'K5', file: 'scripts/lib/duration-reporter.mjs', tests: [SHARD_TESTS],
    from: "&& data.nesting === 0 && typeof data.file === 'string' && namesFile(data.name, data.file)) {",
    to: '&& false) {',
    why: 'a test file that never imports node:test gets no duration, so a complete run is refused',
    killed_by: /record takes the reporter's output of a real run/,
  },
  {
    id: 'K2', file: CLI,
    from: "|| typeof s !== 'number' || !Number.isFinite(s) || s < 0)",
    to: "|| typeof s !== 'number')",
    why: 'a negative weight is accepted and skews every shard',
    killed_by: [/a weights file must be schema 1/, /the CLI refuses a bad shard spec/],
  },
];
