// Guard meta-test for the discovery-based full test suite (ADR-0033).
//
// `npm test` is `node --test` (no-arg) — Node 24 discovers test files repo-wide
// by its default conventions, and `.github/workflows/full-tests.yml` runs that
// suite unfiltered as the repo-level coverage authority. That design only stays
// drift-proof if three invariants hold; this test fails loudly when any breaks,
// so a future change cannot silently re-open the coverage gap this ADR closed.
//
// Invariants:
//   (i)   Every file Node's no-arg discovery would pick up lives under one of the
//         allowed roots. A test added anywhere else is run by `npm test` but is
//         undiscoverable/unorganized — fail and point the author at the roots.
//   (ii)  Smoke tests stay OUT of the default-discovery namespace (`*.smoke.mjs`,
//         never `*.smoke.test.mjs`). CI runners have no host CLI, so smoke tests
//         must be explicitly opt-in via `npm run test:smoke`, not silently present.
//   (iii) `full-tests.yml` actually gates pull_request with no path filter, runs
//         exactly `npm test`, and replicates the release-please env the suite needs.
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

test('(iii) full-tests.yml gates pull_request unfiltered, runs npm test, wires release-please env', () => {
  const p = path.join(REPO_ROOT, FULL_TESTS_WORKFLOW);
  assert.ok(fs.existsSync(p), `${FULL_TESTS_WORKFLOW} must exist (the repo-level coverage authority)`);
  const content = fs.readFileSync(p, 'utf8');

  assert.match(content, /^\s*pull_request:/m, `${FULL_TESTS_WORKFLOW} must trigger on pull_request`);
  assert.doesNotMatch(
    content,
    /^\s*paths(?:-ignore)?:/m,
    `${FULL_TESTS_WORKFLOW} must NOT use a paths/paths-ignore filter — it is the full-suite authority`,
  );
  assert.match(
    content,
    /^\s*run:\s*npm test\s*$/m,
    `${FULL_TESTS_WORKFLOW} must run exactly \`npm test\` (the discovery-based full suite)`,
  );
  // Tie the branch-detection expression to the actual env-key assignment ON ONE
  // LINE: the key (optionally YAML-quoted) immediately assigned a value that
  // contains the release-please branch ref. This rejects both a bare mention in
  // a comment (false-pass) and is tolerant of quoted YAML keys (false-fail) —
  // the host workflows gate on head_ref == release-please--branches--main.
  assert.match(
    content,
    /^\s*"?AGENTIC_RELEASE_PLEASE_PR"?:\s.*release-please--branches--main/m,
    `${FULL_TESTS_WORKFLOW} must assign AGENTIC_RELEASE_PLEASE_PR from the release-please branch detection `
      + `(head_ref == release-please--branches--main) on the env-key line — not merely mention it in a comment — `
      + `so release-please PRs tolerate intentional version/catalog lag`,
  );
});
