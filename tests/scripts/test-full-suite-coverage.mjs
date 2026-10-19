// Guard meta-test for the discovery-based full test suite (ADR-0033).
//
// `npm test` is `node --test` (no-arg) — Node 24 discovers test files repo-wide
// by its default conventions, and `.github/workflows/full-tests.yml` runs that
// suite unfiltered as the repo-level coverage authority, split into shards
// that together run each discovered file once (2026-10-19 amendment). That
// design only stays drift-proof if these invariants hold; this test fails
// loudly when any breaks, so a future change cannot silently re-open the
// coverage gap this ADR closed.
//
// Invariants:
//   (i)   Every file Node's no-arg discovery would pick up lives under one of the
//         allowed roots. A test added anywhere else is run by `npm test` but is
//         undiscoverable/unorganized — fail and point the author at the roots.
//   (ii)  Smoke tests stay OUT of the default-discovery namespace (`*.smoke.mjs`,
//         never `*.smoke.test.mjs`). CI runners have no host CLI, so smoke tests
//         must be explicitly opt-in via `npm run test:smoke`, not silently present.
//   (iii) `full-tests.yml` has exactly the shard matrix and the aggregate check
//         (one axis, 2 to 4 shards, no include, exclude or continue-on-error,
//         the shard bound from the matrix itself, full history, Node 24), and
//         the shards it names run every discovered file exactly once.
//   (iv)  Every CI workflow (all but release-please.yml) triggers on a push to any
//         branch and on dispatch, with no path filter and no pull_request trigger.
//   (v)   Exactly one run step, full-tests.yml's shard step, runs tests in any
//         workflow, so no test file runs twice per push.
//
// Discovery is scripts/lib/discover-tests.mjs, the list the shards split,
// which tests/scripts/test-discover-tests.mjs holds to a real `node --test`.
//
// This file matches `test-*.mjs`, so it is itself discovered by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listTestFiles } from '../../scripts/lib/discover-tests.mjs';
import { MAX_SHARDS, MIN_SHARDS, planShards } from '../../scripts/shard-tests.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..'); // tests/scripts -> repo root

// Directories whose discovered test files are the intended suite.
const ALLOWED_ROOTS = ['companions/tests', 'tests', 'kit/lint/tests'];

const FULL_TESTS_WORKFLOW = '.github/workflows/full-tests.yml';

test('(i) every Node-discovered test file lives under an allowed root', () => {
  const discovered = listTestFiles(REPO_ROOT);
  const underRoot = (rel) => ALLOWED_ROOTS.some((root) => rel === root || rel.startsWith(`${root}/`));
  const strays = discovered.filter((rel) => !underRoot(rel));
  assert.deepEqual(
    strays,
    [],
    `Test files discovered by \`npm test\` (node --test) must live under one of `
      + `${ALLOWED_ROOTS.join(', ')}. Move these or they escape the intended layout:\n  `
      + strays.join('\n  '),
  );
  // Sanity: discovery must actually find the suite (guards against a walk that
  // silently collects nothing). Not a fixed count — just non-trivial.
  assert.ok(discovered.length > 40, `expected discovery to find the suite, got ${discovered.length} files`);
});

test('(ii) smoke tests stay out of the default-discovery namespace', () => {
  const discovered = listTestFiles(REPO_ROOT);
  for (const name of ['claude-companion.smoke.mjs', 'codex-companion.smoke.mjs']) {
    const rel = `companions/tests/${name}`;
    assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), `expected smoke test at ${rel} (renamed out of *.test.mjs)`);
    assert.ok(!discovered.includes(rel), `${rel} must NOT match Node's default discovery patterns`);
  }
  const leaks = discovered.filter((rel) => path.posix.basename(rel).includes('.smoke.'));
  assert.deepEqual(
    leaks,
    [],
    `No discovered smoke test (such as *.smoke.test.mjs) may remain — smoke tests must use the `
      + `non-discoverable *.smoke.mjs namespace. Found:\n  ${leaks.join('\n  ')}`,
  );
});

// The jobs of full-tests.yml, comment and blank lines left out, line for line.
// MATRIX stands for the one line that names the shards, `shard: [1, 2, …]`.
// Pinned whole because each line carries part of the guarantee: the shard
// count comes from the matrix itself (strategy.job-total), not from a number
// that could disagree with it; no include, exclude or continue-on-error adds,
// drops or excuses a shard; the history and Node version are what the tests
// need; and the check `full test suite (Node 24)` passes only when every shard
// did, and runs even when one failed (always()), so it cannot turn skipped.
const MATRIX = '<matrix>';
const FULL_TESTS_JOBS = [
  'jobs:',
  '  shard:',
  '    name: full test suite (Node 24) shard ${{ matrix.shard }}/${{ strategy.job-total }}',
  '    if: ${{ !github.event.deleted }}',
  '    runs-on: ubuntu-latest',
  '    timeout-minutes: 25',
  '    strategy:',
  '      fail-fast: false',
  '      matrix:',
  MATRIX,
  '    steps:',
  '      - name: Checkout',
  '        uses: actions/checkout@v6',
  '        with:',
  '          fetch-depth: 0',
  '      - name: Setup Node 24',
  '        uses: actions/setup-node@v6',
  '        with:',
  '          node-version: 24',
  '      - name: Run test shard (npm test)',
  '        timeout-minutes: 20',
  '        env:',
  '          SHARD: ${{ matrix.shard }}',
  '          TOTAL: ${{ strategy.job-total }}',
  '        run: node scripts/shard-tests.mjs run "$SHARD/$TOTAL"',
  '  full-suite:',
  '    name: full test suite (Node 24)',
  '    needs: shard',
  '    if: ${{ always() && !github.event.deleted }}',
  '    runs-on: ubuntu-latest',
  '    timeout-minutes: 5',
  '    steps:',
  '      - name: Every shard passed',
  '        env:',
  '          SHARDS: ${{ needs.shard.result }}',
  '        run: test "$SHARDS" = success',
];

test('(iii) full-tests.yml runs the suite as shards that hold every discovered file exactly once', () => {
  const p = path.join(REPO_ROOT, FULL_TESTS_WORKFLOW);
  assert.ok(fs.existsSync(p), `${FULL_TESTS_WORKFLOW} must exist (the repo-level coverage authority)`);
  const lines = fs.readFileSync(p, 'utf8').split('\n')
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
    .map((l) => l.trimEnd());
  const jobs = lines.slice(lines.indexOf('jobs:'));
  const matrix = jobs.find((l) => /^\s+shard: \[/.test(l));
  assert.ok(matrix, `${FULL_TESTS_WORKFLOW} names its shards in a matrix`);
  assert.deepEqual(jobs.map((l) => (l === matrix ? MATRIX : l)), FULL_TESTS_JOBS,
    `${FULL_TESTS_WORKFLOW}'s jobs must be exactly the shard matrix and the aggregate check`);

  // The shards are 1..N, in order, with N from 2 to 4.
  const m = /^        shard: \[(\d+(?:, \d+)*)\]$/.exec(matrix);
  assert.ok(m, `the matrix line is \`shard: [1, 2, …]\`; got ${matrix.trim()}`);
  const shards = m[1].split(', ').map(Number);
  const total = shards.length;
  assert.deepEqual(shards, Array.from({ length: total }, (_, i) => i + 1), 'the shards are 1..N in order');
  assert.ok(total >= MIN_SHARDS && total <= MAX_SHARDS, `${MIN_SHARDS} to ${MAX_SHARDS} shards; got ${total}`);

  // What those N shards would run, here: every discovered file, once.
  const discovered = listTestFiles(REPO_ROOT);
  const { shards: lists } = planShards(REPO_ROOT, total);
  assert.equal(lists.length, total);
  for (const list of lists) assert.ok(list.length > 0, 'no shard is empty');
  assert.deepEqual(lists.flat().sort(), discovered, `the ${total} shards run every discovered file exactly once`);
  assert.ok(discovered.includes('tests/scripts/test-full-suite-coverage.mjs'), 'discovery found the real suite');
});

// The CI workflows are every workflow but release-please.yml. They run on a
// push to any branch (tags excluded by the branch filter) and on dispatch, with
// no pull_request trigger: GitHub starts a pull_request run for a PR that
// release-please updates with GITHUB_TOKEN in an approval-required state, and
// that run sits with zero jobs until the PR closes, then fails. A push made
// with GITHUB_TOKEN starts no run at all. A path filter would let a change
// escape the suite. ADR-0033, 2026-10-03 amendment.
const RELEASE_WORKFLOW = 'release-please.yml';
const CI_TRIGGER = ['  push:', "    branches: ['**']", '  workflow_dispatch:'];

function allWorkflows() {
  const dir = path.join(REPO_ROOT, '.github', 'workflows');
  return fs.readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => ({ file: f, content: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

const ciWorkflows = () => allWorkflows().filter((w) => w.file !== RELEASE_WORKFLOW);

/** The shell each `run:` executes: an inline value, or the lines of a block scalar. */
function runBodies(content) {
  const lines = content.split('\n');
  const bodies = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(\s*)(?:- )?run:\s*(.*)$/);
    if (!m) continue;
    if (!/^[|>]/.test(m[2])) {
      bodies.push(m[2]);
      continue;
    }
    const indent = m[1].length;
    const body = [];
    while (i + 1 < lines.length && (lines[i + 1].trim() === '' || lines[i + 1].search(/\S/) > indent)) {
      i += 1;
      body.push(lines[i]);
    }
    bodies.push(body.join('\n'));
  }
  return bodies;
}

test('(iv) every CI workflow triggers on a push to any branch and on dispatch, never on pull_request', () => {
  const workflows = ciWorkflows();
  assert.ok(workflows.some((w) => w.file === path.basename(FULL_TESTS_WORKFLOW)), 'the scan read the real workflow directory');
  for (const { file, content } of workflows) {
    // A job condition could narrow the trigger back down (e.g. to main) where
    // the on: block cannot show it. The one condition allowed skips the push
    // GitHub runs for a branch deletion; full-tests.yml's aggregate check adds
    // always() to it, so a failed shard still reports (pinned in (iii)).
    const allowed = new Set(['    if: ${{ !github.event.deleted }}']);
    if (file === path.basename(FULL_TESTS_WORKFLOW)) allowed.add('    if: ${{ always() && !github.event.deleted }}');
    const jobIfs = content.split('\n').filter((l) => /^    if:/.test(l));
    assert.ok(jobIfs.length > 0, `${file}: each job skips branch-deletion pushes`);
    for (const l of jobIfs) assert.ok(allowed.has(l), `${file}: unexpected job condition ${l.trim()}`);
    const on = content.match(/^on:\n((?:(?:  .*|\s*)\n)+)/m);
    assert.ok(on, `${file}: no block-form on: trigger`);
    const trigger = on[1].split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    assert.deepEqual(trigger, CI_TRIGGER, `${file}: the on: block must be exactly push to every branch plus workflow_dispatch`);
  }
});

// A step runs tests when it calls npm test, node --test or the shard script,
// which starts npm test itself.
const TEST_RUNNER = /\bnpm (?:run )?test\b|\bnode --test\b|\bshard-tests\.mjs\b/;

test('(v) one run step in one workflow runs tests, so no test file runs twice per push', () => {
  const runners = [];
  for (const { file, content } of allWorkflows()) {
    for (const body of runBodies(content)) {
      if (TEST_RUNNER.test(body)) runners.push({ file, body: body.trim() });
    }
  }
  assert.deepEqual(runners, [{ file: path.basename(FULL_TESTS_WORKFLOW), body: 'node scripts/shard-tests.mjs run "$SHARD/$TOTAL"' }],
    'only full-tests.yml runs tests, in exactly one step: its shard step');
});
