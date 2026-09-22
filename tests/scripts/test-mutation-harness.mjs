// Gate for `scripts/mutation-harness.mjs`.
//
// The harness is the thing that decides whether other guards are real, so the
// cost of it being quietly wrong is every score it ever produced. Two of its
// properties are load-bearing and neither is visible in a run's output:
//
//   1. THE COPY IS THE WORKING TREE, not HEAD. The files a mutation run exists
//      to check are usually uncommitted; a copy of HEAD would run the mutations
//      against the previous version of the code and report kills that belong to
//      someone else's work.
//   2. AN EDIT THAT DID NOT LAND IS NOT A VERDICT. A drifted anchor matches
//      nothing, the tests still pass, and without a refusal the run records
//      `SURVIVED` — which reads as "the guard is weak" when the truth is "the
//      mutation never happened".
//
// Everything here runs against a throwaway git repository built in tmp, never
// against this one: `makeDisposableCopy` writes a tree object, and a test that
// wrote objects into the developer's repo would be a side effect nobody asked
// for. The third assertion — that the source repo's index and status survive —
// is the reason that matters in both directions.

import { describe, it } from 'node:test';
import { ok, strictEqual, deepStrictEqual, throws, rejects } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MutationHarnessError,
  applyEdit,
  childEnv,
  fileAt,
  makeDisposableCopy,
  parseArgs,
  runSpec,
} from '../../scripts/mutation-harness.mjs';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test User',
  GIT_AUTHOR_EMAIL: 'test@test.local',
  GIT_COMMITTER_NAME: 'Test User',
  GIT_COMMITTER_EMAIL: 'test@test.local',
};

function write(root, rel, content) {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}

/**
 * A tmp repo holding: one committed-then-modified file, one committed file left
 * alone, one untracked file, and one gitignored file. Each is a distinct claim
 * about what the copy must contain.
 */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'harness-src-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { env: GIT_ENV, stdio: 'ignore' });
  execFileSync('git', ['init', '-q', '-b', 'main', root], { env: GIT_ENV, stdio: 'ignore' });
  git('config', 'commit.gpgsign', 'false');
  git('config', 'user.email', 'test@test.local');
  git('config', 'user.name', 'Test User');
  write(root, '.gitignore', 'ignored/\n');
  write(root, 'committed.txt', 'committed v1\n');
  write(root, 'modified.txt', 'HEAD version\n');
  git('add', '-A');
  git('commit', '-m', 'initial', '--no-gpg-sign');
  write(root, 'modified.txt', 'WORKING TREE version\n');
  write(root, 'untracked.txt', 'untracked content\n');
  write(root, 'ignored/local.txt', 'local state\n');
  return root;
}

const status = (root) =>
  execFileSync('git', ['-C', root, 'status', '--porcelain=v1'], { env: GIT_ENV, encoding: 'utf8' });

describe('makeDisposableCopy', () => {
  it('extracts HEAD plus the working tree, and honours .gitignore', () => {
    const root = makeRepo();
    const dest = join(root, '..', `harness-dest-${process.pid}`);
    try {
      const tree = makeDisposableCopy(root, dest);
      ok(/^[0-9a-f]{40}$/.test(tree), `expected a tree sha, got ${JSON.stringify(tree)}`);
      strictEqual(readFileSync(join(dest, 'committed.txt'), 'utf8'), 'committed v1\n');
      strictEqual(
        readFileSync(join(dest, 'modified.txt'), 'utf8'),
        'WORKING TREE version\n',
        'the copy must carry the WORKING TREE version — a HEAD-only copy would test the previous code',
      );
      strictEqual(readFileSync(join(dest, 'untracked.txt'), 'utf8'), 'untracked content\n');
      ok(
        !existsSync(join(dest, 'ignored/local.txt')),
        'gitignored local state must not travel into a mutation run',
      );
      ok(!existsSync(join(dest, '.git')), 'the copy is a plain directory, not a git checkout');
    } finally {
      rmSync(dest, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves the source repository index and working tree untouched', () => {
    const root = makeRepo();
    const dest = join(root, '..', `harness-dest2-${process.pid}`);
    try {
      const before = status(root);
      makeDisposableCopy(root, dest);
      const after = status(root);
      strictEqual(after, before, 'the run must not stage anything in the real repository');
      ok(before.includes('?? untracked.txt'), 'the fixture must actually have unstaged state to preserve');
      strictEqual(readFileSync(join(root, 'modified.txt'), 'utf8'), 'WORKING TREE version\n');
    } finally {
      rmSync(dest, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('replaces a pre-existing destination rather than merging into it', () => {
    const root = makeRepo();
    const dest = join(root, '..', `harness-dest3-${process.pid}`);
    try {
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, 'stale.txt'), 'from a previous run\n', 'utf8');
      makeDisposableCopy(root, dest);
      ok(!existsSync(join(dest, 'stale.txt')), 'a stale file from an earlier run must not survive');
    } finally {
      rmSync(dest, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('applyEdit — an edit that did not land is not a verdict', () => {
  let dir;
  const seed = (content) => {
    dir = mkdtempSync(join(tmpdir(), 'harness-edit-'));
    write(dir, 'file.txt', content);
    return dir;
  };

  it('refuses an anchor that matches nothing', () => {
    const copy = seed('alpha beta\n');
    throws(
      () => applyEdit(copy, { file: 'file.txt', from: 'gamma', to: 'delta' }),
      (err) => {
        ok(err instanceof MutationHarnessError, `got ${err?.name}`);
        ok(/occurs 0x/.test(err.message), err.message);
        return true;
      },
    );
    strictEqual(readFileSync(join(copy, 'file.txt'), 'utf8'), 'alpha beta\n', 'the file is untouched');
    rmSync(copy, { recursive: true, force: true });
  });

  it('refuses an anchor whose count is not the declared one', () => {
    const copy = seed('alpha alpha\n');
    throws(
      () => applyEdit(copy, { file: 'file.txt', from: 'alpha', to: 'omega' }),
      (err) => err instanceof MutationHarnessError && /occurs 2x .* expected 1/.test(err.message),
    );
    strictEqual(applyEdit(copy, { file: 'file.txt', from: 'alpha', to: 'omega', count: 2 }), 2);
    strictEqual(readFileSync(join(copy, 'file.txt'), 'utf8'), 'omega omega\n');
    rmSync(copy, { recursive: true, force: true });
  });

  it('refuses an edit that changes nothing', () => {
    const copy = seed('alpha\n');
    throws(
      () => applyEdit(copy, { file: 'file.txt', from: 'alpha', to: 'alpha' }),
      (err) => err instanceof MutationHarnessError && /changes nothing/.test(err.message),
    );
    rmSync(copy, { recursive: true, force: true });
  });

  it('names an unreadable target rather than throwing a raw fs error', () => {
    const copy = seed('alpha\n');
    throws(
      () => applyEdit(copy, { file: 'absent.txt', from: 'a', to: 'b' }),
      (err) => err instanceof MutationHarnessError && /cannot read absent\.txt/.test(err.message),
    );
    rmSync(copy, { recursive: true, force: true });
  });
});

describe('fileAt', () => {
  it('names an unreachable ref instead of failing opaquely', () => {
    const root = makeRepo();
    try {
      throws(
        () => fileAt(root, root, '0'.repeat(40), 'committed.txt'),
        (err) => err instanceof MutationHarnessError && /cannot read committed\.txt at 0{40}/.test(err.message),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// End to end. A tiny repo with one real test, driven through runSpec, so the
// scoring rules are exercised rather than described.

function makeScoringRepo() {
  const root = makeRepo();
  write(root, 'src/value.mjs', 'export const VALUE = 1;\n// a comment nobody asserts on\n');
  write(
    root,
    'tests/test-value.mjs',
    "import { test } from 'node:test';\n"
    + "import { strictEqual } from 'node:assert/strict';\n"
    + "import { VALUE } from '../src/value.mjs';\n"
    + "test('value is 1', () => strictEqual(VALUE, 1));\n",
  );
  return root;
}

const SPEC = `
export const TESTS = ['tests/test-value.mjs'];
export const MUTATIONS = [
  { id: 'K', file: 'src/value.mjs', from: 'VALUE = 1', to: 'VALUE = 2',
    why: 'breaks the asserted value' },
  { id: 'S', expect: 'SURVIVED', file: 'src/value.mjs',
    from: 'a comment nobody asserts on', to: 'a different comment',
    why: 'changes something no assertion covers' },
  { id: 'H', file: 'src/value.mjs', from: 'VALUE = 99', to: 'VALUE = 3',
    why: 'anchor has drifted' },
];
`;

describe('runSpec — scoring', () => {
  it('scores a kill, an expected survivor, and a drifted anchor separately', async () => {
    const root = makeScoringRepo();
    const workDir = join(root, '..', `harness-work-${process.pid}`);
    write(root, 'spec.mjs', SPEC);
    try {
      const { results, unexpected } = await runSpec(join(root, 'spec.mjs'), {
        repoRoot: root,
        workDir,
        log: () => {},
      });
      deepStrictEqual(
        results.map((r) => [r.id, r.verdict, r.agrees]),
        [['K', 'KILLED', true], ['S', 'SURVIVED', true], ['H', 'HARNESS-ERROR', false]],
      );
      strictEqual(unexpected.length, 1, 'only the drifted anchor is unexpected');
      ok(/occurs 0x/.test(results[2].detail), results[2].detail);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Peer-found on scripts/mutation-specs/decide-registry-root.mjs: a mutation
  // may name its own `tests`, and the control used to run only `spec.TESTS`.
  // A broken file in the per-mutation set therefore produced `CONTROL exit=0`
  // followed by KILLED verdicts that the mutation had not earned — the
  // fabricated verdict this harness exists to prevent, arriving through the one
  // door it did not watch.
  it('runs the control over per-mutation test sets too, not just the spec default', async () => {
    const root = makeScoringRepo();
    const workDir = join(root, '..', `harness-work3-${process.pid}`);
    // A second suite, named ONLY by the mutation, and broken.
    write(
      root,
      'tests/test-other.mjs',
      "import { test } from 'node:test';\n"
      + "test('other', () => { throw new Error('this suite is broken'); });\n",
    );
    write(root, 'spec.mjs', `
export const TESTS = ['tests/test-value.mjs'];
export const MUTATIONS = [
  { id: 'K', file: 'src/value.mjs', from: 'VALUE = 1', to: 'VALUE = 2',
    tests: ['tests/test-other.mjs'], why: 'scored against a suite the control must also prove green' },
];
`);
    try {
      await rejects(
        () => runSpec(join(root, 'spec.mjs'), { repoRoot: root, workDir, log: () => {} }),
        (err) => err instanceof MutationHarnessError && /UNMUTATED copy is not green/.test(err.message),
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to score anything when the unmutated control is not green', async () => {
    const root = makeScoringRepo();
    const workDir = join(root, '..', `harness-work2-${process.pid}`);
    // Break the tree itself: now every "kill" below would be unearned.
    write(root, 'src/value.mjs', 'export const VALUE = 7;\n// a comment nobody asserts on\n');
    write(root, 'spec.mjs', SPEC);
    try {
      await rejects(
        () => runSpec(join(root, 'spec.mjs'), { repoRoot: root, workDir, log: () => {} }),
        (err) => err instanceof MutationHarnessError && /UNMUTATED copy is not green/.test(err.message),
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('childEnv — the nested runner must not inherit the test context', () => {
  it('drops every NODE_TEST_* variable and keeps the rest', () => {
    // A PLANTED value with a control, not an assertion about absence: this file
    // runs under `node --test`, so NODE_TEST_CONTEXT really is set here, but a
    // check that only looked at the ambient value would pass by accident on a
    // machine where it is not.
    const env = childEnv({ NODE_TEST_CONTEXT: 'child-v8', NODE_TEST_ANYTHING: 'x', PATH: '/bin', HOME: '/h' });
    deepStrictEqual(env, { PATH: '/bin', HOME: '/h' });
    ok('NODE_TEST_CONTEXT' in process.env, 'the ambient variable this exists to strip must actually be present here');
    ok(!('NODE_TEST_CONTEXT' in childEnv()), 'the real ambient environment is scrubbed too');
  });

  it('a nested node --test reports failure through its exit status', () => {
    // The property the scrub buys, measured end to end rather than described:
    // with NODE_TEST_CONTEXT inherited, this same spawn exits 0 on a failing
    // test and every mutation would score SURVIVED.
    const dir = mkdtempSync(join(tmpdir(), 'harness-nested-'));
    write(dir, 'test-failing.mjs', "import { test } from 'node:test';\ntest('fails', () => { throw new Error('boom'); });\n");
    const run = (env) =>
      execFileSync(process.execPath, ['-e', `
        const { spawnSync } = require('node:child_process');
        const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test-failing.mjs'],
          { cwd: ${JSON.stringify(dir)}, encoding: 'utf8', env: ${JSON.stringify(env)} });
        process.stdout.write(String(r.status));
      `], { encoding: 'utf8' });
    try {
      strictEqual(run({ ...childEnv(), PATH: process.env.PATH }), '1', 'scrubbed: the failure reaches the exit status');
      strictEqual(
        run({ ...childEnv(), PATH: process.env.PATH, NODE_TEST_CONTEXT: 'child-v8' }),
        '0',
        'control: with the variable inherited the SAME failing test exits 0 — this is the trap the scrub removes',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parseArgs', () => {
  it('reads the flags the usage line documents', () => {
    const opts = parseArgs(['spec.mjs', '--only', 'A1,B2', '--repo-root', '/r', '--work-dir', '/w', '--keep']);
    strictEqual(opts.spec, 'spec.mjs');
    deepStrictEqual(opts.only, ['A1', 'B2']);
    strictEqual(opts.repoRoot, '/r');
    strictEqual(opts.workDir, '/w');
    strictEqual(opts.keep, true);
    deepStrictEqual(parseArgs([]).only, []);
    strictEqual(parseArgs([]).spec, undefined);
  });
});
