// Guard meta-test for the discovery-based full test suite (ADR-0033).
//
// `npm test` is `node --test` (no-arg) — Node 24 discovers test files repo-wide
// by its default conventions, and `.github/workflows/full-tests.yml` runs that
// suite unfiltered as the repo-level coverage authority. That design only stays
// drift-proof if these invariants hold; this test fails loudly when any breaks,
// so a future change cannot silently re-open the coverage gap this ADR closed.
//
// Invariants:
//   (i)   Every file Node's no-arg discovery would pick up lives under one of the
//         allowed roots. A test added anywhere else is run by `npm test` but is
//         undiscoverable/unorganized — fail and point the author at the roots.
//   (ii)  Smoke tests stay OUT of the default-discovery namespace (`*.smoke.mjs`,
//         never `*.smoke.test.mjs`). CI runners have no host CLI, so smoke tests
//         must be explicitly opt-in via `npm run test:smoke`, not silently present.
//   (iii) `full-tests.yml` runs exactly one `npm test`, with no matrix.
//   (iv)  Every CI workflow (all but release-please.yml) triggers on a push to any
//         branch and on dispatch, with no path filter and no pull_request trigger.
//   (v)   Exactly one run step, full-tests.yml's `npm test`, runs tests in any
//         workflow, so no test file runs twice per push.
//
// This file matches `test-*.mjs`, so it is itself discovered by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..'); // tests/scripts -> repo root

// Directories whose discovered test files are the intended suite.
const ALLOWED_ROOTS = ['companions/tests', 'tests', 'kit/lint/tests'];

const FULL_TESTS_WORKFLOW = '.github/workflows/full-tests.yml';

// Node 24 default test-file discovery: a `.{js,cjs,mjs,ts,cts,mts}` file whose
// stem ends in `.test`, `-test`, `_test`, or starts with `test-`, or is exactly
// `test`; plus any such file inside a directory literally named `test`. Node 24
// strips types, so TypeScript extensions are discovered too — the matcher must
// mirror that, or a stray `*.test.ts` outside the roots would run under
// `npm test` yet escape this guard (false-pass).
const DISCOVERABLE_EXT = /\.(?:c|m)?[jt]s$/;

function matchesNamePattern(base) {
  if (!DISCOVERABLE_EXT.test(base)) return false;
  const stem = base.replace(DISCOVERABLE_EXT, '');
  return (
    stem.endsWith('.test') ||
    stem.endsWith('-test') ||
    stem.endsWith('_test') ||
    stem.startsWith('test-') ||
    stem === 'test'
  );
}

// Node's discovery skips `node_modules` and hidden (dot-prefixed) directories.
// Verified empirically against node v24 (hidden dirs are not descended into).
function isSkippedDir(name) {
  return name === 'node_modules' || name.startsWith('.');
}

function collectDiscovered(absDir, relDir, insideTestDir, out) {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (isSkippedDir(entry.name)) continue;
      collectDiscovered(
        path.join(absDir, entry.name),
        rel,
        insideTestDir || entry.name === 'test',
        out,
      );
    } else if (entry.isFile()) {
      if (matchesNamePattern(entry.name) || (insideTestDir && DISCOVERABLE_EXT.test(entry.name))) {
        out.push(rel);
      }
    }
  }
}

function listSmokeTestNamespaceLeaks() {
  const leaks = [];
  const walk = (absDir, relDir) => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (isSkippedDir(entry.name)) continue;
        walk(path.join(absDir, entry.name), rel);
      } else if (entry.isFile() && entry.name.endsWith('.smoke.test.mjs')) {
        leaks.push(rel);
      }
    }
  };
  walk(REPO_ROOT, '');
  return leaks;
}

test('(i) every Node-discovered test file lives under an allowed root', () => {
  const discovered = [];
  collectDiscovered(REPO_ROOT, '', false, discovered);
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
  for (const name of ['claude-companion.smoke.mjs', 'codex-companion.smoke.mjs']) {
    const p = path.join(REPO_ROOT, 'companions', 'tests', name);
    assert.ok(fs.existsSync(p), `expected smoke test at companions/tests/${name} (renamed out of *.test.mjs)`);
    assert.ok(
      !matchesNamePattern(name),
      `companions/tests/${name} must NOT match Node's default discovery patterns`,
    );
  }
  const leaks = listSmokeTestNamespaceLeaks();
  assert.deepEqual(
    leaks,
    [],
    `No *.smoke.test.mjs may remain — smoke tests must use the non-discoverable `
      + `*.smoke.mjs namespace. Found:\n  ${leaks.join('\n  ')}`,
  );
});

test('(iii) full-tests.yml runs npm test once, unfiltered', () => {
  const p = path.join(REPO_ROOT, FULL_TESTS_WORKFLOW);
  assert.ok(fs.existsSync(p), `${FULL_TESTS_WORKFLOW} must exist (the repo-level coverage authority)`);
  const content = fs.readFileSync(p, 'utf8');

  assert.equal(
    (content.match(/^\s*run:\s*npm test\s*$/gm) ?? []).length,
    1,
    `${FULL_TESTS_WORKFLOW} must run exactly \`npm test\` (the discovery-based full suite), once`,
  );
  assert.doesNotMatch(content, /^\s*matrix:/m, `${FULL_TESTS_WORKFLOW} must not fan the suite out over a matrix`);
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
    // GitHub runs for a branch deletion.
    const jobIfs = content.split('\n').filter((l) => /^    if:/.test(l));
    assert.ok(jobIfs.length > 0, `${file}: each job skips branch-deletion pushes`);
    for (const l of jobIfs) assert.equal(l, '    if: ${{ !github.event.deleted }}', `${file}: unexpected job condition`);
    const on = content.match(/^on:\n((?:(?:  .*|\s*)\n)+)/m);
    assert.ok(on, `${file}: no block-form on: trigger`);
    const trigger = on[1].split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    assert.deepEqual(trigger, CI_TRIGGER, `${file}: the on: block must be exactly push to every branch plus workflow_dispatch`);
  }
});

test('(v) one run step in one workflow runs tests, so no test file runs twice per push', () => {
  const runners = [];
  for (const { file, content } of allWorkflows()) {
    for (const body of runBodies(content)) {
      if (/\bnpm (?:run )?test\b|\bnode --test\b/.test(body)) runners.push({ file, body: body.trim() });
    }
  }
  assert.deepEqual(runners, [{ file: path.basename(FULL_TESTS_WORKFLOW), body: 'npm test' }],
    'only full-tests.yml runs tests, in exactly one step that is exactly `npm test`');
});
