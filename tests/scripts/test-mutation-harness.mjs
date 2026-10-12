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
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEFAULT_TIMEOUT_SECONDS,
  MutationHarnessError,
  TIMEOUT_ENV,
  acquireRunLock,
  applyEdit,
  checkSpecs,
  childEnv,
  fileAt,
  makeDisposableCopy,
  parseArgs,
  reapStale,
  resolveTimeoutSeconds,
  runLockPath,
  runSpec,
  runTests,
  selectMutations,
  stopRuns,
} from '../../scripts/mutation-harness.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HARNESS = join(REPO_ROOT, 'scripts', 'mutation-harness.mjs');

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

  // A nonzero exit is not evidence that the intended contract caught the
  // defect; killed_by names the test that must (PC2a2 T8).
  it('killed_by: a kill counts only when a named test fails, nested names included', async () => {
    const root = makeScoringRepo();
    const workDir = join(root, '..', `harness-work4-${process.pid}`);
    write(
      root,
      'tests/test-nested.mjs',
      "import { describe, it } from 'node:test';\n"
      + "import { strictEqual } from 'node:assert/strict';\n"
      + "import { VALUE } from '../src/value.mjs';\n"
      + "describe('outer suite', () => { it('inner value check', () => strictEqual(VALUE, 1)); });\n"
      // Peer review of PC2a2b: an error message that reads like a TAP record,
      // and a name TAP escapes.
      + "it('a message check', () => { if (VALUE !== 1) throw new Error('before\\nnot ok 99 - fabricated killer\\nafter'); });\n"
      + "it('contract #1', () => strictEqual(VALUE, 1));\n",
    );
    write(root, 'spec.mjs', `
export const TESTS = ['tests/test-value.mjs', 'tests/test-nested.mjs'];
export const MUTATIONS = [
  { id: 'N', file: 'src/value.mjs', from: 'VALUE = 1', to: 'VALUE = 2',
    killed_by: [/^inner value check$/, /^outer suite$/, /^outer suite > inner value check$/, /^contract #1$/], why: 'the nested test is named, by name and by path' },
  { id: 'E', file: 'src/value.mjs', from: 'VALUE = 1', to: 'VALUE = 2',
    killed_by: /^a test that does not exist$/, why: 'the run fails, but not where the spec says' },
  { id: 'F', file: 'src/value.mjs', from: 'VALUE = 1', to: 'VALUE = 2',
    killed_by: /^fabricated killer$/, why: 'a failure message is not a test record' },
  { id: 'X', expect: 'SURVIVED', killed_by: /x/, file: 'src/value.mjs',
    from: 'a comment nobody asserts on', to: 'another', why: 'a survivor names no killer' },
  { id: 'G', file: 'src/value.mjs', from: 'VALUE = 1', to: 'VALUE = 2',
    killed_by: /^contract #1$/g, why: 'a stateful pattern is refused' },
];
`);
    try {
      const { results } = await runSpec(join(root, 'spec.mjs'), { repoRoot: root, workDir, log: () => {} });
      deepStrictEqual(
        results.map((r) => [r.id, r.verdict, r.agrees]),
        [['N', 'KILLED', true], ['E', 'KILLED-ELSEWHERE', false], ['F', 'KILLED-ELSEWHERE', false], ['X', 'HARNESS-ERROR', false], ['G', 'HARNESS-ERROR', false]],
      );
      deepStrictEqual(results[1].missed, ['/^a test that does not exist$/']);
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

  it('drops the operator\'s agentic session and keeps an opt-in switch (C88)', () => {
    const env = childEnv({
      AGENTIC_AUTOPILOT: 'autopilot-20261007T000000Z-abcdef', AGENTIC_ENGINEER_ROOT: '/planted',
      AGENTIC_COMPANION_DEPTH: '1', AGENTIC_EGRESS_REAL_SMOKE: '1', PATH: '/bin',
    });
    deepStrictEqual(env, { AGENTIC_EGRESS_REAL_SMOKE: '1', PATH: '/bin' });
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
    const opts = parseArgs(['spec.mjs', '--only', 'A1,B2', '--repo-root', '/r', '--work-dir', '/w', '--keep', '--timeout', '3600']);
    strictEqual(opts.spec, 'spec.mjs');
    deepStrictEqual(opts.only, ['A1', 'B2']);
    strictEqual(opts.repoRoot, '/r');
    strictEqual(opts.workDir, '/w');
    strictEqual(opts.keep, true);
    strictEqual(opts.timeout, '3600');
    deepStrictEqual(parseArgs([]).only, []);
    strictEqual(parseArgs([]).spec, undefined);
    strictEqual(parseArgs([]).timeout, undefined);
    strictEqual(parseArgs(['spec.mjs', '--timeout']).timeout, '', 'a --timeout with no value is kept, to be refused');
  });

  it('reads --static and every spec it names', () => {
    const opts = parseArgs(['--static', 'a.mjs', 'b.mjs']);
    strictEqual(opts.static, true);
    deepStrictEqual(opts.specs, ['a.mjs', 'b.mjs']);
    strictEqual(opts.spec, 'a.mjs');
    strictEqual(parseArgs([]).static, false);
    deepStrictEqual(parseArgs(['--static']).specs, []);
  });
});

// ---------------------------------------------------------------------------
// C135: the per-run timeout is the operator's, and a run that passes it is no
// verdict. The fixed 900 s stopped the persona runbook suites and reported
// them as "test run failed to start".

const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms));

// Running, and not a zombie: an orphan's new parent may be slow to reap it.
// Where ps cannot run (a sandbox may deny it), the signal check decides.
function running(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code === 'ESRCH') return false;
  }
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  if (ps.error) return true;
  const stat = (ps.stdout ?? '').trim();
  return stat !== '' && !stat.startsWith('Z');
}

// Whether `condition` holds within `ms`.
async function until(condition, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    if (condition()) return true;
  }
  return condition();
}

const gone = (pid, ms) => until(() => !running(pid), ms);

const pidsIn = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number) : []);

// A value module that never finishes loading, after starting a process of its
// own and noting both pids: the test that imports it hangs, as the runbook
// suites ran past 900 s, and leaves something behind to clean up.
const hangingSource = (pidFile) => [
  "import { spawn } from 'node:child_process';",
  "import { appendFileSync } from 'node:fs';",
  "const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
  `appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n' + sleeper.pid + '\\n');`,
  'await new Promise(() => setInterval(() => {}, 1000));',
  'export const VALUE = 1;',
  '',
].join('\n');

describe('timeout — configurable, refused when invalid (C135)', () => {
  it('defaults to 900 s; the flag beats the environment', () => {
    strictEqual(DEFAULT_TIMEOUT_SECONDS, 900);
    strictEqual(resolveTimeoutSeconds(undefined, {}), 900);
    strictEqual(resolveTimeoutSeconds(undefined, { [TIMEOUT_ENV]: '3600' }), 3600);
    strictEqual(resolveTimeoutSeconds('60', { [TIMEOUT_ENV]: '3600' }), 60);
  });

  it('refuses a value that is not a whole number of seconds from 1, naming its source', () => {
    for (const bad of ['0', '-5', '1.5', '10s', ' 10', '', 'abc', '1e3', '0900', '99999999999']) {
      throws(
        () => resolveTimeoutSeconds(bad, {}),
        (err) => err instanceof MutationHarnessError && err.message.startsWith('--timeout takes a whole number'),
        `--timeout ${JSON.stringify(bad)}`,
      );
      throws(
        () => resolveTimeoutSeconds(undefined, { [TIMEOUT_ENV]: bad }),
        (err) => err instanceof MutationHarnessError && err.message.startsWith(`${TIMEOUT_ENV} takes a whole number`),
        `${TIMEOUT_ENV}=${JSON.stringify(bad)}`,
      );
    }
    // The largest delay setTimeout honours; one more would fire at once.
    strictEqual(resolveTimeoutSeconds('2147483', {}), 2147483);
    throws(() => resolveTimeoutSeconds('2147484', {}), MutationHarnessError);
  });
});

// A regression here would hang, not fail, so each test below carries a bound of
// its own. On a test, not on its suite: a suite's timeout bounds the suite as a
// whole, and its later tests would be cancelled once the earlier ones used it.
const BOUNDED = { timeout: 60_000 };

// Whether `pid` names a process, a zombie included.
function exists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// A run's test result is what its runner reported, never how the supervisor
// around it exited: a runner that could not start, or a supervisor that died,
// used to read as a test that failed, and so as a kill.
describe('runTests — only the runner\'s own exit is a test result', () => {
  it('a runner that cannot start, or a supervisor that dies without a report, is no verdict', BOUNDED, async () => {
    const root = makeScoringRepo();
    const preload = join(root, '..', `harness-preload-${process.pid}.cjs`);
    // Loaded by every node the run starts; it acts in the supervisor alone.
    writeFileSync(preload, [
      "if (process.execArgv[0] === '-e') {",
      "  if (process.env.HARNESS_PRELOAD === 'no-start') process.execPath = '/nonexistent/node';",
      "  else throw new Error('the supervisor crashed');",
      '}',
      '',
    ].join('\n'));
    const options = process.env.NODE_OPTIONS;
    const restore = () => {
      if (options === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = options;
      delete process.env.HARNESS_PRELOAD;
    };
    try {
      process.env.NODE_OPTIONS = `${options ?? ''} --require ${JSON.stringify(preload)}`.trim();
      process.env.HARNESS_PRELOAD = 'no-start';
      await rejects(
        () => runTests(root, ['tests/test-value.mjs']),
        (err) => err instanceof MutationHarnessError && /^test run failed to start: .*ENOENT/.test(err.message),
      );
      process.env.HARNESS_PRELOAD = 'crash';
      await rejects(
        () => runTests(root, ['tests/test-value.mjs']),
        (err) => err instanceof MutationHarnessError
          && /^test run ended without reporting how its runner exited/.test(err.message),
      );
      // Control: without the preload the same run passes, and a failing one fails.
      restore();
      strictEqual((await runTests(root, ['tests/test-value.mjs'])).status, 0);
      write(root, 'src/value.mjs', 'export const VALUE = 2;\n');
      strictEqual((await runTests(root, ['tests/test-value.mjs'])).status, 1);
    } finally {
      restore();
      rmSync(preload, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runSpec — a run past the timeout is no verdict (C135)', () => {
  it('scores the hung mutation TIMEOUT, never a kill or a failure to start, stops what it started, and goes on', BOUNDED, async () => {
    const root = makeScoringRepo();
    const workDir = join(root, '..', `harness-work-timeout-${process.pid}`);
    const pidFile = join(root, '..', `harness-sleepers-${process.pid}`);
    write(root, 'spec.mjs', `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const TESTS = ['tests/test-value.mjs'];
export const MUTATIONS = [
  { id: 'T', prepare: (copy) => writeFileSync(join(copy, 'src/value.mjs'), ${JSON.stringify(hangingSource(pidFile))}),
    why: 'the test run hangs past the timeout' },
  { id: 'K', file: 'src/value.mjs', from: 'VALUE = 1', to: 'VALUE = 2', why: 'breaks the asserted value' },
];
`);
    const lines = [];
    try {
      const started = Date.now();
      // The timeout bounds every run, the control and K included, and each
      // run is three node startups: 5 s leaves them room under a loaded
      // `npm test`, where 1 s stopped the control.
      const { results, unexpected } = await runSpec(join(root, 'spec.mjs'), {
        repoRoot: root, workDir, timeoutSeconds: 5, log: (l) => lines.push(l),
      });
      deepStrictEqual(results.map((r) => [r.id, r.verdict, r.agrees]), [['T', 'TIMEOUT', false], ['K', 'KILLED', true]]);
      deepStrictEqual(unexpected.map((r) => r.id), ['T'], 'no verdict is not the expected verdict');
      ok(/passed 5 s and was stopped — no verdict/.test(results[0].detail), results[0].detail);
      ok(!/failed to start/.test(lines.join('\n')), lines.join('\n'));
      ok(lines.some((l) => /^T\s+TIMEOUT\s/.test(l)), lines.join('\n'));
      ok(Date.now() - started < 60_000, 'the run was stopped at the timeout');
      const hung = pidsIn(pidFile);
      strictEqual(hung.length, 2, 'the hung test file and the process it started');
      for (const pid of hung) ok(await gone(pid), `pid ${pid} of the hung run was stopped with it`);
    } finally {
      for (const pid of pidsIn(pidFile)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      rmSync(pidFile, { force: true });
      rmSync(workDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to score anything when the control passes the timeout', BOUNDED, async () => {
    const root = makeScoringRepo();
    const workDir = join(root, '..', `harness-work-timeout2-${process.pid}`);
    const pidFile = join(root, '..', `harness-sleepers2-${process.pid}`);
    write(root, 'src/value.mjs', hangingSource(pidFile));
    write(root, 'spec.mjs', SPEC);
    try {
      const started = Date.now();
      await rejects(
        () => runSpec(join(root, 'spec.mjs'), { repoRoot: root, workDir, timeoutSeconds: 1, log: () => {} }),
        (err) => err instanceof MutationHarnessError
          && /^the UNMUTATED copy's test run passed 1 s and was stopped — no verdict/.test(err.message),
      );
      // One second, not ten: the timeout is read in seconds.
      ok(Date.now() - started < 9000, `stopped after ${Date.now() - started} ms`);
      await rejects(
        () => runSpec(join(root, 'spec.mjs'), { repoRoot: root, workDir, timeoutSeconds: 0, log: () => {} }),
        (err) => err instanceof MutationHarnessError && /^timeoutSeconds takes a whole number/.test(err.message),
      );
    } finally {
      for (const pid of pidsIn(pidFile)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      rmSync(pidFile, { force: true });
      rmSync(workDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops what a finished test run left running', BOUNDED, async () => {
    const root = makeScoringRepo();
    const workDir = join(root, '..', `harness-work-leftover-${process.pid}`);
    const pidFile = join(root, '..', `harness-leftovers-${process.pid}`);
    write(
      root,
      'tests/test-leaves.mjs',
      "import { test } from 'node:test';\n"
      + "import { spawn } from 'node:child_process';\n"
      + "import { appendFileSync } from 'node:fs';\n"
      + "test('leaves a process behind', () => {\n"
      + "  const s = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\n"
      + '  s.unref();\n'
      + `  appendFileSync(${JSON.stringify(pidFile)}, s.pid + '\\n');\n`
      + '});\n',
    );
    write(root, 'spec.mjs', `
export const TESTS = ['tests/test-leaves.mjs'];
export const MUTATIONS = [
  { id: 'S', expect: 'SURVIVED', file: 'src/value.mjs', from: 'a comment nobody asserts on', to: 'another',
    why: 'a run that passes and leaves a process behind' },
];
`);
    try {
      const { unexpected } = await runSpec(join(root, 'spec.mjs'), { repoRoot: root, workDir, log: () => {} });
      strictEqual(unexpected.length, 0);
      const left = pidsIn(pidFile);
      strictEqual(left.length, 2, 'the control and the mutation each left one');
      for (const pid of left) ok(await gone(pid), `pid ${pid} outlived its test run`);
    } finally {
      for (const pid of pidsIn(pidFile)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      rmSync(pidFile, { force: true });
      rmSync(workDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A process that left the run's group with the output pipe open (a test run
  // in the runner's own process, `--test-isolation=none`, hands it the pipe)
  // used to hold the harness for ever: the deadline ended at the runner's exit.
  it('bounds the output too: a process that left the group holding the pipe does not hold the harness', BOUNDED, async () => {
    const root = makeScoringRepo();
    const workDir = join(root, '..', `harness-work-escape-${process.pid}`);
    const pidFile = join(root, '..', `harness-escaped-${process.pid}`);
    write(
      root,
      'tests/test-escape.mjs',
      "import { test } from 'node:test';\n"
      + "import { spawn } from 'node:child_process';\n"
      + "import { appendFileSync } from 'node:fs';\n"
      + "test('leaves a process holding the output', () => {\n"
      // It ends by itself after 20 s, so that a harness it holds still ends.
      + "  const s = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] });\n"
      + '  s.unref();\n'
      + `  appendFileSync(${JSON.stringify(pidFile)}, s.pid + '\\n');\n`
      + '});\n',
    );
    write(root, 'spec.mjs', `
export const TESTS = ['tests/test-escape.mjs'];
export const MUTATIONS = [
  { id: 'S', expect: 'SURVIVED', file: 'src/value.mjs', from: 'a comment nobody asserts on', to: 'another', why: 'unreached' },
];
`);
    const options = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `${options ?? ''} --test-isolation=none`.trim();
    try {
      const started = Date.now();
      await rejects(
        () => runSpec(join(root, 'spec.mjs'), { repoRoot: root, workDir, timeoutSeconds: 2, log: () => {} }),
        (err) => err instanceof MutationHarnessError && /passed 2 s and was stopped — no verdict/.test(err.message),
      );
      ok(Date.now() - started < 30_000, `stopped after ${Date.now() - started} ms`);
      strictEqual(pidsIn(pidFile).length, 1, 'the run left one process holding the pipe');
    } finally {
      if (options === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = options;
      for (const pid of pidsIn(pidFile)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      rmSync(pidFile, { force: true });
      rmSync(workDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The harness's own tests run harnesses: when the outer run stops a test
  // process, the runs that process started end with it, though each leads a
  // group of its own.
  it('a nested harness\'s test run ends with the outer run that stopped it', BOUNDED, async () => {
    const inner = makeScoringRepo();
    const outer = makeRepo();
    const workDir = join(outer, '..', `harness-work-outer-${process.pid}`);
    const innerWork = join(inner, '..', `harness-work-inner-${process.pid}`);
    const pidFile = join(inner, '..', `harness-nested-${process.pid}`);
    write(inner, 'src/value.mjs', hangingSource(pidFile));
    write(inner, 'spec.mjs', SPEC);
    write(
      outer,
      'tests/test-nested.mjs',
      "import { test } from 'node:test';\n"
      + `import { runSpec } from ${JSON.stringify(pathToFileURL(HARNESS).href)};\n`
      + "test('runs a harness', () => runSpec("
      + `${JSON.stringify(join(inner, 'spec.mjs'))}, { repoRoot: ${JSON.stringify(inner)}, `
      + `workDir: ${JSON.stringify(innerWork)}, timeoutSeconds: 600, log: () => {} }));\n`,
    );
    write(outer, 'spec.mjs', `
export const TESTS = ['tests/test-nested.mjs'];
export const MUTATIONS = [
  { id: 'S', expect: 'SURVIVED', file: 'committed.txt', from: 'committed v1', to: 'v2', why: 'unreached' },
];
`);
    try {
      await rejects(
        () => runSpec(join(outer, 'spec.mjs'), { repoRoot: outer, workDir, timeoutSeconds: 5, log: () => {} }),
        (err) => err instanceof MutationHarnessError && /passed 5 s and was stopped — no verdict/.test(err.message),
      );
      const nested = pidsIn(pidFile);
      strictEqual(nested.length, 2, 'the nested run had started its hanging test');
      for (const pid of nested) ok(await gone(pid), `pid ${pid} of the nested run outlived the outer run`);
    } finally {
      for (const pid of pidsIn(pidFile)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      for (const dir of [pidFile, workDir, innerWork, inner, outer]) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the CLI hands --timeout and the environment\'s timeout to its runs, and refuses a bad one without waiting', BOUNDED, async () => {
    const root = makeScoringRepo();
    const pidFile = join(root, '..', `harness-cli-timeout-${process.pid}`);
    write(root, 'src/value.mjs', hangingSource(pidFile));
    write(root, 'spec.mjs', SPEC);
    const spec = join(root, 'spec.mjs');
    try {
      for (const [args, env] of [[['--timeout', '1'], {}], [[], { [TIMEOUT_ENV]: '1' }]]) {
        const run = await runCli([spec, '--repo-root', root, ...args], env).exited;
        strictEqual(run.code, 1, run.out);
        ok(run.out.includes("the UNMUTATED copy's test run passed 1 s and was stopped — no verdict"), run.out);
      }
      // Held by another run: a bad timeout is refused at once, not after the wait.
      const lock = await acquireRunLock(root, { log: () => {} });
      try {
        const run = await runCli([spec, '--repo-root', root, '--timeout', '0'], {}, 10_000).exited;
        strictEqual(run.code, 1, run.out);
        ok(run.out.includes('--timeout takes a whole number of seconds'), run.out);
        ok(!run.out.includes('waiting for the run'), run.out);
      } finally {
        lock.release();
      }
    } finally {
      for (const pid of pidsIn(pidFile)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      rmSync(pidFile, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// C102: an id names one case, its copy and its verdict.

describe('mutation ids (C102)', () => {
  const m = (id) => ({ id, why: '' });

  it('refuses a repeated or missing id, and an --only id the spec lacks even beside one it has', () => {
    throws(
      () => selectMutations([m('A'), m('B'), m('A')], [], 'spec.mjs'),
      (err) => err instanceof MutationHarnessError && err.message === 'spec.mjs repeats mutation id(s) A',
    );
    throws(
      () => selectMutations([m('A'), m(''), { why: '' }], [], 'spec.mjs'),
      (err) => err instanceof MutationHarnessError && err.message === 'spec.mjs has 2 mutation(s) without an id',
    );
    throws(
      () => selectMutations([m('A'), m('B')], ['A', 'Z'], 'spec.mjs'),
      (err) => err instanceof MutationHarnessError && err.message === '--only names id(s) spec.mjs does not have: Z',
    );
    deepStrictEqual(selectMutations([m('A'), m('B'), m('C')], ['C', 'A']).map((x) => x.id), ['A', 'C']);
    deepStrictEqual(selectMutations([m('A'), m('B')]).map((x) => x.id), ['A', 'B']);
  });

  it('runSpec refuses them before running anything', async () => {
    const root = makeScoringRepo();
    const workDir = join(root, '..', `harness-work-ids-${process.pid}`);
    write(root, 'dup.mjs', `${SPEC}\nMUTATIONS.push({ ...MUTATIONS[0] });\n`);
    write(root, 'spec.mjs', SPEC);
    try {
      await rejects(
        () => runSpec(join(root, 'dup.mjs'), { repoRoot: root, workDir, log: () => {} }),
        (err) => err instanceof MutationHarnessError && /repeats mutation id\(s\) K$/.test(err.message),
      );
      await rejects(
        () => runSpec(join(root, 'spec.mjs'), { repoRoot: root, workDir, only: ['K', 'NOPE'], log: () => {} }),
        (err) => err instanceof MutationHarnessError && /does not have: NOPE$/.test(err.message),
      );
      ok(!existsSync(join(workDir, 'control')), 'no copy was made, no control was run');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('every spec in scripts/mutation-specs passes the id check', async () => {
    const dir = join(REPO_ROOT, 'scripts', 'mutation-specs');
    const files = readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
    // Named, not counted: the check must have read these.
    for (const known of ['codex-cache-discovery.mjs', 'persona-pipeline.mjs', 'state-root.mjs']) {
      ok(files.includes(known), `${known} is among the specs read`);
    }
    ok(files.length >= 28, `${files.length} specs`);
    for (const file of files) {
      const spec = await import(pathToFileURL(join(dir, file)).href);
      ok((spec.MUTATIONS ?? []).length > 0, `${file} has mutations`);
      selectMutations(spec.MUTATIONS, [], file);
    }
  });
});

// ---------------------------------------------------------------------------
// C101: runs in worktrees of one repository take turns.

function makeRepoWithLane() {
  const root = makeScoringRepo();
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { env: GIT_ENV, stdio: 'ignore' });
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture', '--no-gpg-sign');
  const lane = `${root}-lane`;
  git('worktree', 'add', '-q', '-b', 'lane', lane);
  return { root, lane };
}

const removeRepoWithLane = ({ root, lane }) => {
  rmSync(lane, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
};

// A start this platform's reader spells, of a process that started long ago.
const ANOTHER_START = process.platform === 'linux' ? 'boot:0' : 'utc:Thu Jan  1 00:00:00 1970';

// A process that exited: its pid names no running process.
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

function writeLock(path, record) {
  writeFileSync(path, `${JSON.stringify({
    token: 'planted', started_at: '2026-10-11T00:00:00.000Z', worktree: '/elsewhere', spec: 'old.mjs',
    ...record,
  })}\n`);
}

// Place the reap guard of the lock `path` for the reaper `record`, as a reaper
// does: a directory holding one entry, named by the reaper's token. A guard
// already there is replaced.
function writeGuard(path, record) {
  const guard = `${path}.reap`;
  rmSync(guard, { recursive: true, force: true });
  mkdirSync(guard);
  writeLock(join(guard, record.token), record);
}

// The environment for a harness under test: no inherited timeout.
const cliEnv = () => {
  const env = childEnv();
  delete env[TIMEOUT_ENV];
  return env;
};

// A node process killed at its deadline: a lock wait that never ends would
// otherwise keep this file running past its test's timeout.
function spawnNode(args, env = {}, deadlineMs = 30_000) {
  const child = spawn(process.execPath, args, { env: { ...cliEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const deadline = setTimeout(() => child.kill('SIGKILL'), deadlineMs);
  const exited = new Promise((done) => child.on('close', (code, signal) => {
    clearTimeout(deadline);
    done({ code, signal, out });
  }));
  return { child, exited, output: () => out };
}

const runCli = (args, env, deadlineMs) => spawnNode([HARNESS, ...args], env, deadlineMs);

// Take the lock of `root` and release it, in a process of its own.
const acquireInChild = (root, env) => spawnNode([
  '--input-type=module', '-e',
  `import { acquireRunLock } from ${JSON.stringify(pathToFileURL(HARNESS).href)};\n`
  + `(await acquireRunLock(${JSON.stringify(root)}, { pollMs: 20 })).release();\n`,
], env);

describe('run lock — one run at a time per repository (C101)', () => {
  it('worktrees share one lock; the second waits until the first releases it', BOUNDED, async () => {
    const repo = makeRepoWithLane();
    try {
      strictEqual(runLockPath(repo.lane), runLockPath(repo.root));
      const first = await acquireRunLock(repo.root, { spec: 'first.mjs', log: () => {} });
      const lines = [];
      let second = null;
      const waiting = acquireRunLock(repo.lane, { spec: 'second.mjs', log: (l) => lines.push(l), pollMs: 20 })
        .then((lock) => { second = lock; return lock; });
      const said = () => lines.some((l) => l.includes(`waiting for the run of first.mjs in ${repo.root} (pid ${process.pid}`));
      ok(await until(said), lines.join('\n'));
      await sleep(100);
      strictEqual(second, null, 'the second run waits while the first holds the lock');
      first.release();
      const lock = await waiting;
      ok(existsSync(lock.path));
      ok(lines.some((l) => /the run lock is ours after \d+ s/.test(l)), lines.join('\n'));
      first.release();
      ok(existsSync(lock.path), 'a run releases only its own lock');
      lock.release();
      ok(!existsSync(lock.path));
    } finally {
      removeRepoWithLane(repo);
    }
  });

  it('a CLI killed with SIGKILL: its test run ends with it, and the next run takes its lock', BOUNDED, async () => {
    const root = makeScoringRepo();
    const pidFile = join(root, '..', `harness-sigkill-${process.pid}`);
    write(root, 'src/value.mjs', hangingSource(pidFile));
    write(root, 'spec.mjs', SPEC);
    const path = runLockPath(root);
    const cli = runCli([join(root, 'spec.mjs'), '--repo-root', root, '--timeout', '600']);
    try {
      ok(await until(() => pidsIn(pidFile).length === 2, 30_000), 'the hung test run started');
      const started = pidsIn(pidFile);
      cli.child.kill('SIGKILL');
      await cli.exited;
      for (const pid of started) ok(await gone(pid), `pid ${pid} of its test run outlived the harness`);
      ok(existsSync(path), 'a killed run cannot release its lock');
      const run = await acquireInChild(root).exited;
      strictEqual(run.code, 0, run.out);
      ok(run.out.includes(`removed a stale run lock (pid ${cli.child.pid}, `), run.out);
    } finally {
      for (const pid of pidsIn(pidFile)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      rmSync(pidFile, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('takes over a lock whose holder is gone: dead, a reused pid, or no holder named', BOUNDED, async () => {
    const root = makeRepo();
    const path = runLockPath(root);
    const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const dead = deadPid();
      writeLock(path, { pid: dead, host: hostname() });
      let run = await acquireInChild(root).exited;
      strictEqual(run.code, 0, run.out);
      ok(run.out.includes(`removed a stale run lock (pid ${dead}, /elsewhere, which is not running)`), run.out);

      // The holder's pid now names a process that started at another time,
      // spelled as this reader spells a start.
      await sleep(100);
      writeLock(path, { pid: stranger.pid, host: hostname(), started: ANOTHER_START });
      run = await acquireInChild(root).exited;
      strictEqual(run.code, 0, run.out);
      ok(run.out.includes(`removed a stale run lock (pid ${stranger.pid}, `), run.out);

      writeFileSync(path, 'not a record');
      run = await acquireInChild(root).exited;
      strictEqual(run.code, 0, run.out);
      ok(run.out.includes('removed a stale run lock (unreadable)'), run.out);
      ok(!existsSync(path));

      // A record that names no holder is not waited for either.
      writeFileSync(path, '{}\n');
      run = await acquireInChild(root).exited;
      strictEqual(run.code, 0, run.out);
      ok(run.out.includes('removed a stale run lock (unreadable)'), run.out);
    } finally {
      stranger.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A reaper that pauses between its read and its removal is still reaping:
  // its guard goes only once it has stopped running, never for its age.
  it('leaves a stale lock to the reaper whose guard holds it until that reaper is gone', BOUNDED, async () => {
    const root = makeRepo();
    const path = runLockPath(root);
    const reaper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      writeLock(path, { pid: deadPid(), host: hostname() });
      writeGuard(path, { pid: reaper.pid, host: hostname(), token: 'paused-reaper' });
      const waiter = acquireInChild(root);
      await sleep(500);
      strictEqual(waiter.child.exitCode, null, 'it waits while the guard\'s reaper runs');
      ok(existsSync(path), 'the stale lock is the guard holder\'s to remove');
      reaper.kill('SIGKILL');
      const run = await waiter.exited;
      strictEqual(run.code, 0, run.out);
      ok(run.out.includes('removed the guard of a reaper that is not running'), run.out);
      ok(!existsSync(`${path}.reap`));
    } finally {
      reaper.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Judging a guard takes a while; a waiter that judged a dead reaper's guard
  // used to remove whatever guard was there by then, a live reaper's too.
  it('removes a dead reaper\'s guard only while it is still the guard it judged', BOUNDED, () => {
    const root = makeRepo();
    const path = runLockPath(root);
    const guard = `${path}.reap`;
    const self = { pid: process.pid, host: hostname(), token: 'this-waiter' };
    try {
      writeLock(path, { pid: deadPid(), host: hostname() });
      const raw = readFileSync(path, 'utf8');
      const seen = { raw, record: JSON.parse(raw) };
      writeGuard(path, { pid: deadPid(), host: hostname(), token: 'dead-reaper' });
      const lines = [];
      // While this waiter judges the dead reaper, another removes that guard
      // and places its own.
      const removed = reapStale(path, seen, self, (l) => lines.push(l), {
        running: () => {
          writeGuard(path, { pid: process.pid, host: hostname(), token: 'live-reaper' });
          return false;
        },
      });
      strictEqual(removed, false);
      deepStrictEqual(readdirSync(guard), ['live-reaper'], 'the live reaper keeps its guard');
      ok(existsSync(path), 'the stale lock is the live reaper\'s to remove');
      deepStrictEqual(lines, []);
      // Control: the guard judged, still in place, goes.
      writeGuard(path, { pid: deadPid(), host: hostname(), token: 'dead-reaper' });
      strictEqual(reapStale(path, seen, self, (l) => lines.push(l), { running: () => false }), false);
      ok(!existsSync(guard), 'a dead reaper\'s guard is removed');
      ok(lines.some((l) => l.includes('removed the guard of a reaper that is not running')), lines.join('\n'));
      // An empty guard, left by a reaper killed as it took its entry out, is
      // no reaper's: the next reaper replaces it and reaps.
      mkdirSync(guard);
      strictEqual(reapStale(path, seen, self, () => {}), true);
      ok(!existsSync(path) && !existsSync(guard));
      // A guard file from an older harness is named for the operator to remove.
      writeLock(path, { pid: deadPid(), host: hostname() });
      writeFileSync(guard, '{}\n');
      throws(() => reapStale(path, { raw: readFileSync(path, 'utf8'), record: null }, self, () => {}),
        (err) => err instanceof MutationHarnessError && err.message.includes('left by an older harness'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The window the re-check left open: after a waiter's last read of a dead
  // reaper's guard, another waiter takes that guard and a live reaper places
  // its own. A waiter that removed the guard by its name then removed the live
  // one; it captures the entry it judged, by that entry's own name, instead.
  it('captures only the dead reaper\'s guard it judged, whatever replaced it after its last read', BOUNDED, () => {
    const root = makeRepo();
    const path = runLockPath(root);
    const guard = `${path}.reap`;
    const self = { pid: process.pid, host: hostname(), token: 'this-waiter' };
    try {
      writeLock(path, { pid: deadPid(), host: hostname() });
      const raw = readFileSync(path, 'utf8');
      const seen = { raw, record: JSON.parse(raw) };
      writeGuard(path, { pid: deadPid(), host: hostname(), token: 'dead-reaper' });
      const lines = [];
      let judged = 0;
      const removed = reapStale(path, seen, self, (l) => lines.push(l), {
        running: () => false,
        judged: () => {
          judged += 1;
          writeGuard(path, { pid: process.pid, host: hostname(), token: 'live-reaper' });
        },
      });
      strictEqual(judged, 1, 'the waiter judged the dead reaper\'s guard');
      strictEqual(removed, false);
      deepStrictEqual(readdirSync(guard), ['live-reaper'], 'the live reaper keeps its guard');
      ok(existsSync(path), 'the stale lock is the live reaper\'s to remove');
      deepStrictEqual(lines, [], 'nothing was taken');
      deepStrictEqual(readdirSync(dirname(path)).filter((n) => n.startsWith('mutation-harness.lock.')), ['mutation-harness.lock.reap']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ps prints a start time in local time: a waiter in another time zone used
  // to read a live holder's start as another process's, and take its lock.
  it('judges a live holder running whatever time zone the waiter runs in', BOUNDED, async () => {
    const root = makeRepo();
    const path = runLockPath(root);
    const holder = spawnNode([
      '--input-type=module', '-e',
      `import { acquireRunLock } from ${JSON.stringify(pathToFileURL(HARNESS).href)};\n`
      + `await acquireRunLock(${JSON.stringify(root)}, { log: () => {} });\n`
      + 'setInterval(() => {}, 1000);\n',
    ], { TZ: 'Pacific/Kiritimati' });
    try {
      ok(await until(() => existsSync(path), 10_000), 'the holder took the lock');
      const held = JSON.parse(readFileSync(path, 'utf8'));
      strictEqual(typeof held.started, 'string', 'the holder recorded its start, so a waiter compares it');
      const waiter = acquireInChild(root, { TZ: 'America/Adak' });
      // It says it waits only once it has judged the holder running.
      ok(await until(() => waiter.output().includes('waiting for the run'), 10_000), waiter.output());
      await sleep(200);
      strictEqual(waiter.child.exitCode, null, 'a waiter in another time zone still waits');
      strictEqual(JSON.parse(readFileSync(path, 'utf8')).token, held.token, 'the holder still holds its lock');
      holder.child.kill('SIGKILL');
      const run = await waiter.exited;
      strictEqual(run.code, 0, run.out);
      ok(run.out.includes(`removed a stale run lock (pid ${holder.child.pid}, `), run.out);
    } finally {
      holder.child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A harness of another version may spell a start another way; unequal
  // spellings of one start must not read as a reused pid.
  it('does not compare a start spelled in a scheme the reader does not use', BOUNDED, async () => {
    const root = makeRepo();
    const path = runLockPath(root);
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      await sleep(100);
      writeLock(path, { pid: holder.pid, host: hostname(), started: 'Thu Jan  1 00:00:00 1970' });
      const waiter = acquireInChild(root);
      ok(await until(() => waiter.output().includes('waiting for the run'), 10_000), waiter.output());
      await sleep(200);
      strictEqual(waiter.child.exitCode, null, 'it waits for the live holder');
      holder.kill('SIGKILL');
      const run = await waiter.exited;
      strictEqual(run.code, 0, run.out);
      ok(run.out.includes(`removed a stale run lock (pid ${holder.pid}, `), run.out);
    } finally {
      holder.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('waits for a holder on another host instead of judging it', BOUNDED, async () => {
    const root = makeRepo();
    const path = runLockPath(root);
    try {
      writeLock(path, { pid: deadPid(), host: 'elsewhere.invalid' });
      const waiter = acquireInChild(root);
      await sleep(500);
      strictEqual(waiter.child.exitCode, null, 'it is still waiting');
      rmSync(path);
      const run = await waiter.exited;
      strictEqual(run.code, 0, run.out);
      ok(run.out.includes('on elsewhere.invalid'), run.out);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('two CLI runs in two worktrees take turns: their test runs never overlap', BOUNDED, async () => {
    const repo = makeRepoWithLane();
    const turns = join(repo.root, '..', `harness-turns-${process.pid}.log`);
    const spec = join(repo.root, '..', `harness-turns-spec-${process.pid}.mjs`);
    const slow = "import { test } from 'node:test';\n"
      + "import { appendFileSync } from 'node:fs';\n"
      + "test('takes a while', async () => {\n"
      + `  appendFileSync(${JSON.stringify(turns)}, 'start\\n');\n`
      + '  await new Promise((wake) => setTimeout(wake, 300));\n'
      + `  appendFileSync(${JSON.stringify(turns)}, 'end\\n');\n`
      + '});\n';
    write(repo.root, 'tests/test-slow.mjs', slow);
    write(repo.lane, 'tests/test-slow.mjs', slow);
    writeFileSync(spec, `
export const TESTS = ['tests/test-slow.mjs'];
export const MUTATIONS = [
  { id: 'S', expect: 'SURVIVED', file: 'src/value.mjs', from: 'a comment nobody asserts on', to: 'another', why: 'takes a turn' },
];
`);
    try {
      const a = runCli([spec, '--repo-root', repo.root]);
      const b = runCli([spec, '--repo-root', repo.lane]);
      const [ra, rb] = await Promise.all([a.exited, b.exited]);
      strictEqual(ra.code, 0, ra.out);
      strictEqual(rb.code, 0, rb.out);
      ok(/waiting for the run of /.test(ra.out + rb.out), `one run waited:\n${ra.out}\n${rb.out}`);
      deepStrictEqual(
        readFileSync(turns, 'utf8').trim().split('\n'),
        ['start', 'end', 'start', 'end', 'start', 'end', 'start', 'end'],
        'four test runs, one at a time',
      );
      ok(!existsSync(runLockPath(repo.root)), 'the lock is released');
    } finally {
      rmSync(turns, { force: true });
      rmSync(spec, { force: true });
      removeRepoWithLane(repo);
    }
  });

  // The lock goes last: released while the run still ran, another harness
  // could start beside it.
  it('a signal to the CLI stops its test run, and only then releases the lock', BOUNDED, async () => {
    const root = makeScoringRepo();
    const pidFile = join(root, '..', `harness-signal-${process.pid}`);
    write(root, 'src/value.mjs', hangingSource(pidFile));
    write(root, 'spec.mjs', SPEC);
    const path = runLockPath(root);
    const cli = runCli([join(root, 'spec.mjs'), '--repo-root', root, '--timeout', '600']);
    try {
      ok(await until(() => pidsIn(pidFile).length === 2, 30_000), 'the test file and the process it started are running');
      const started = pidsIn(pidFile);
      ok(existsSync(path), 'the run holds the lock');
      cli.child.kill('SIGTERM');
      // The first moment the lock is gone or the CLI has exited.
      let left = null;
      while (left === null) {
        if (!existsSync(path) || cli.child.exitCode !== null || cli.child.signalCode !== null) {
          left = started.filter(exists);
        }
        await sleep(1);
      }
      deepStrictEqual(left, [], 'nothing of the run was left when the lock was released');
      const { code } = await cli.exited;
      strictEqual(code, 143);
      ok(!existsSync(path), 'the lock is released');
      for (const pid of started) ok(await gone(pid), `pid ${pid} of its test run was stopped`);
    } finally {
      cli.child.kill('SIGKILL');
      for (const pid of pidsIn(pidFile)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      rmSync(pidFile, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A run that a signal ended while the harness waited for another used to
  // let runSpec start the next one, which nothing then stopped.
  it('starts no test run once its runs are being stopped', BOUNDED, async () => {
    const root = makeScoringRepo();
    try {
      const run = await spawnNode([
        '--input-type=module', '-e',
        `import { runTests, stopRuns } from ${JSON.stringify(pathToFileURL(HARNESS).href)};\n`
        + `const tests = ['tests/test-value.mjs'];\n`
        + `console.log('before', (await runTests(${JSON.stringify(root)}, tests)).status);\n`
        + "console.log('stopped', await stopRuns());\n"
        + `try { await runTests(${JSON.stringify(root)}, tests); console.log('ran'); }\n`
        + "catch (err) { console.log('refused:', err.message); }\n",
      ]).exited;
      strictEqual(run.code, 0, run.out);
      deepStrictEqual(run.out.trim().split('\n'), [
        'before 0', 'stopped true', 'refused: the harness is stopping; no test run starts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Released while the run still ran, the lock would let another harness start
  // beside it; a run that will not end keeps the lock until it does.
  it('a signal keeps the lock while a test run will not end, and releases it once it has', BOUNDED, async () => {
    const root = makeScoringRepo();
    const pidFile = join(root, '..', `harness-unkillable-${process.pid}`);
    const preload = join(root, '..', `harness-unkillable-${process.pid}.cjs`);
    const release = join(root, '..', `harness-unkillable-${process.pid}.release`);
    write(root, 'src/value.mjs', hangingSource(pidFile));
    write(root, 'spec.mjs', SPEC);
    // In the CLI alone, a group may not be killed until the release file exists.
    writeFileSync(preload, [
      "if (process.argv[1] && process.argv[1].endsWith('/scripts/mutation-harness.mjs')) {",
      '  const kill = process.kill.bind(process);',
      '  process.kill = (pid, signal) => {',
      `    if (pid < 0 && signal === 'SIGKILL' && !require('node:fs').existsSync(${JSON.stringify(release)})) {`,
      "      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });",
      '    }',
      '    return kill(pid, signal);',
      '  };',
      '}',
      '',
    ].join('\n'));
    const path = runLockPath(root);
    const cli = runCli(
      [join(root, 'spec.mjs'), '--repo-root', root, '--timeout', '600'],
      { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` },
    );
    try {
      ok(await until(() => pidsIn(pidFile).length === 2, 30_000), 'the test file and the process it started are running');
      const started = pidsIn(pidFile);
      cli.child.kill('SIGTERM');
      ok(await until(() => cli.output().includes('a test run has not ended after SIGTERM'), 15_000), cli.output());
      await sleep(1000);
      strictEqual(cli.child.exitCode, null, 'the CLI waits for the run');
      ok(existsSync(path), 'the lock is kept while the run runs');
      ok(started.every(exists), 'the run is still running');
      writeFileSync(release, '');
      const { code } = await cli.exited;
      strictEqual(code, 143);
      ok(!existsSync(path), 'the lock is released once the run has ended');
      for (const pid of started) ok(!exists(pid), `pid ${pid} of its test run was gone before the CLI exited`);
    } finally {
      cli.child.kill('SIGKILL');
      for (const pid of pidsIn(pidFile)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      for (const file of [pidFile, preload, release]) rmSync(file, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The static check: does every mutation still apply? Anchor drift recurred four
// times (C85, C97, C113, C129) because nothing applied the edits when the
// anchored source changed; a full run per spec costs hours.

describe('checkSpecs — every edit applied, no test run', () => {
  it('reports each case that would not apply, and runs no test', async () => {
    const root = makeScoringRepo();
    const workDir = join(root, '..', `harness-static-${process.pid}`);
    const ran = join(root, '..', `harness-static-ran-${process.pid}`);
    write(root, 'tests/test-marker.mjs', `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(ran)}, 'ran');\n`);
    write(root, 'spec.mjs', `
export const TESTS = ['tests/test-marker.mjs'];
export const MUTATIONS = [
  { id: 'A', file: 'src/value.mjs', from: 'VALUE = 1', to: 'VALUE = 2', why: 'applies' },
  { id: 'D', file: 'src/value.mjs', from: 'VALUE = 99', to: 'VALUE = 3', why: 'a drifted anchor' },
  { id: 'N', file: 'src/value.mjs', from: 'VALUE = 1', to: 'VALUE = 1', why: 'changes nothing' },
  { id: 'P', prepare: () => { throw new TypeError('the shape moved'); }, why: 'prepare fails outside the harness' },
  { id: 'T', file: 'src/value.mjs', from: 'VALUE = 1', to: 'VALUE = 2', tests: ['tests/test-gone.mjs'], why: 'names a test file the tree lacks' },
  { id: 'K', expect: 'SURVIVED', killed_by: /x/, file: 'src/value.mjs', from: 'VALUE = 1', to: 'VALUE = 2', why: 'refused as a run refuses it' },
  { id: 'Z', prepare: () => { throw null; }, why: 'throws what is not an Error' },
];
`);
    try {
      const { specs, drift } = await checkSpecs([join(root, 'spec.mjs')], { repoRoot: root, workDir, log: () => {} });
      strictEqual(specs.length, 1);
      strictEqual(specs[0].cases, 7);
      strictEqual(specs[0].error, undefined);
      deepStrictEqual(specs[0].drift.map((d) => d.id), ['D', 'N', 'P', 'T', 'K', 'Z']);
      strictEqual(drift, 6);
      const detail = Object.fromEntries(specs[0].drift.map((d) => [d.id, d.detail]));
      ok(/occurs 0x/.test(detail.D), detail.D);
      ok(/changes nothing/.test(detail.N), detail.N);
      ok(/TypeError: the shape moved/.test(detail.P), detail.P);
      ok(/tests\/test-gone\.mjs/.test(detail.T), detail.T);
      ok(/a survivor has none/.test(detail.K), detail.K);
      strictEqual(detail.Z, 'prepare threw null');
      ok(!existsSync(ran), 'no test file was run');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      rmSync(ran, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a spec that does not load, or names a test file the tree lacks, and goes on', async () => {
    const root = makeScoringRepo();
    const workDir = join(root, '..', `harness-static2-${process.pid}`);
    write(root, 'dup.mjs', `${SPEC}\nMUTATIONS.push({ ...MUTATIONS[0] });\n`);
    write(root, 'gone.mjs', SPEC.replace("'tests/test-value.mjs'", "'tests/test-gone.mjs'"));
    write(root, 'none.mjs', SPEC.replace("export const TESTS = ['tests/test-value.mjs'];", ''));
    write(root, 'spec.mjs', SPEC);
    try {
      const { specs, drift } = await checkSpecs(
        [join(root, 'dup.mjs'), join(root, 'gone.mjs'), join(root, 'none.mjs'), join(root, 'spec.mjs')],
        { repoRoot: root, workDir, log: () => {} },
      );
      ok(/repeats mutation id\(s\) K$/.test(specs[0].error), specs[0].error);
      ok(/tests\/test-gone\.mjs/.test(specs[1].error), specs[1].error);
      ok(/names no test files/.test(specs[2].error), specs[2].error);
      strictEqual(specs[3].error, undefined);
      deepStrictEqual(specs[3].drift.map((d) => d.id), ['H'], 'the spec after them is still checked');
      strictEqual(drift, 4);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('gives each case the copy as it was: what an earlier case added, removed or changed is undone', async () => {
    const root = makeScoringRepo();
    const workDir = join(root, '..', `harness-static3-${process.pid}`);
    // What a link put where the copy was points to: nothing in it is touched.
    const outside = join(root, '..', `harness-static3-outside-${process.pid}`);
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'keep\n');
    writeFileSync(join(outside, 'committed.txt'), 'outside\n');
    write(root, 'docs/readme.txt', 'read me\n');
    write(root, 'lib/a.txt', 'a\n');
    symlinkSync('committed.txt', join(root, 'link.txt'));
    write(root, 'spec.mjs', `
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const SOURCE = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
let ROOT_MODE;
const as_it_was = (copy) => {
  const wrong = [];
  if (!lstatSync(copy).isDirectory()) throw new Error('the copy is no directory');
  if ((statSync(copy).mode & 0o7777) !== ROOT_MODE) wrong.push('the copy keeps its mode');
  for (const rel of ['added.txt', 'newdir', 'lib-moved', 'dangling.txt', 'nowhere']) {
    try { lstatSync(join(copy, rel)); wrong.push(rel + ' is still there'); } catch {}
  }
  for (const rel of ['committed.txt', 'modified.txt', 'untracked.txt', 'src/value.mjs', 'tests/test-value.mjs', 'docs/readme.txt', 'lib/a.txt']) {
    let text = null;
    try { text = readFileSync(join(copy, rel), 'utf8'); } catch {}
    if (text !== SOURCE(rel)) wrong.push(rel + ' differs');
    else if (!lstatSync(join(copy, rel)).isFile()) wrong.push(rel + ' is no file');
  }
  if ((statSync(join(copy, 'modified.txt')).mode & 0o777) === 0o600) wrong.push('modified.txt keeps its mode');
  if ((statSync(join(copy, 'docs')).mode & 0o777) !== (statSync(new URL('docs', import.meta.url)).mode & 0o777)) wrong.push('docs keeps its mode');
  if (!lstatSync(join(copy, 'link.txt')).isSymbolicLink() || readlinkSync(join(copy, 'link.txt')) !== 'committed.txt') wrong.push('link.txt is no link');
  if (wrong.length > 0) throw new Error(wrong.join('; '));
};
export const TESTS = ['tests/test-value.mjs'];
export const MUTATIONS = [
  { id: 'W', why: 'adds, removes and changes paths', prepare: (copy) => {
    ROOT_MODE = statSync(copy).mode & 0o7777;
    renameSync(join(copy, 'lib'), join(copy, 'lib-moved'));
    chmodSync(join(copy, 'docs'), 0o000);
    rmSync(join(copy, 'link.txt'));
    writeFileSync(join(copy, 'link.txt'), 'a file where a link was');
    writeFileSync(join(copy, 'added.txt'), 'added');
    mkdirSync(join(copy, 'newdir/sub'), { recursive: true });
    writeFileSync(join(copy, 'newdir/sub/file.txt'), 'nested');
    rmSync(join(copy, 'committed.txt'));
    rmSync(join(copy, 'src'), { recursive: true });
    writeFileSync(join(copy, 'src'), 'a file where a directory was');
    chmodSync(join(copy, 'modified.txt'), 0o600);
    // Same size and inode, times put back as far as node can: its size does
    // not tell.
    const test = join(copy, 'tests/test-value.mjs');
    const before = statSync(test);
    writeFileSync(test, 'X'.repeat(before.size));
    utimesSync(test, before.atime, before.mtime);
  } },
  { id: 'X', why: 'changes a file, then fails', prepare: (copy) => {
    writeFileSync(join(copy, 'untracked.txt'), 'changed by a failing case');
    throw new Error('failed midway');
  } },
  { id: 'R1', why: 'sees the copy as it was', file: 'src/value.mjs', from: 'VALUE = 1', to: 'VALUE = 2', prepare: as_it_was },
  // The copy itself removed: the restore cannot put it back, a new one replaces it.
  { id: 'Y', why: 'removes the whole copy', prepare: (copy) => rmSync(copy, { recursive: true, force: true }) },
  { id: 'R2', why: 'sees the copy as it was', file: 'src/value.mjs', from: 'VALUE = 1', to: 'VALUE = 2', prepare: as_it_was },
  // The copy's own root: its mode is put back, so the next case can edit at
  // the top, and the restore can put that back too.
  { id: 'V', why: 'closes the copy itself to writes', prepare: (copy) => chmodSync(copy, 0o555) },
  { id: 'B', why: 'edits a file at the top of the copy', prepare: (copy) => writeFileSync(join(copy, 'committed.txt'), 'edited at the top') },
  { id: 'R3', why: 'sees the copy as it was', file: 'src/value.mjs', from: 'VALUE = 1', to: 'VALUE = 2', prepare: as_it_was },
  // A link where the copy was: the restore does not follow it, a new copy replaces it.
  { id: 'L', why: 'puts a link to another directory where the copy was', prepare: (copy) => {
    rmSync(copy, { recursive: true, force: true });
    symlinkSync(${JSON.stringify(outside)}, copy);
  } },
  { id: 'R4', why: 'sees the copy as it was', file: 'src/value.mjs', from: 'VALUE = 1', to: 'VALUE = 2', prepare: as_it_was },
  // Links that point nowhere, which rmSync leaves in place on node before 24.13.1.
  { id: 'G', why: 'adds a link that points nowhere, and puts one where a file was', prepare: (copy) => {
    symlinkSync('nowhere', join(copy, 'dangling.txt'));
    rmSync(join(copy, 'committed.txt'));
    symlinkSync('nowhere', join(copy, 'committed.txt'));
  } },
  { id: 'R5', why: 'sees the copy as it was', file: 'src/value.mjs', from: 'VALUE = 1', to: 'VALUE = 2', prepare: as_it_was },
];
`);
    try {
      const lines = [];
      const { specs } = await checkSpecs([join(root, 'spec.mjs')], { repoRoot: root, workDir, log: (l) => lines.push(l) });
      deepStrictEqual(specs[0].drift.map((d) => [d.id, d.detail]), [['X', 'prepare threw Error: failed midway']]);
      // Only the case that removed the copy needs a new one: a fallback for
      // every case would hide a restore that fails.
      deepStrictEqual(
        lines.filter((l) => /the copy could not be put back .*; it is made again$/.test(l)).map((l) => l.split(/\s+/)[1]),
        ['Y', 'L'],
        lines.join('\n'),
      );
      deepStrictEqual(readdirSync(outside).sort(), ['committed.txt', 'keep.txt'], 'nothing is added to or removed from the directory the link pointed to');
      strictEqual(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep\n');
      strictEqual(readFileSync(join(outside, 'committed.txt'), 'utf8'), 'outside\n');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('replaces a copy whose root became a link that points nowhere, and goes on', BOUNDED, async () => {
    // In a child process: on node 24 before 24.13.1 rmSync leaves such a link
    // in place, and the copy made over it aborts the process.
    const root = makeScoringRepo();
    write(root, 'scripts/mutation-specs/dangling.mjs', `
import { readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
export const TESTS = ['tests/test-value.mjs'];
export const MUTATIONS = [
  { id: 'N', why: 'puts a link that points nowhere where the copy was', prepare: (copy) => {
    rmSync(copy, { recursive: true, force: true });
    symlinkSync(copy + '-nowhere', copy);
  } },
  { id: 'R', why: 'sees the copy as it was', prepare: (copy) => {
    if (readFileSync(join(copy, 'src/value.mjs'), 'utf8') !== readFileSync(new URL('../../src/value.mjs', import.meta.url), 'utf8')) throw new Error('src/value.mjs differs');
  } },
];
`);
    try {
      const run = await runCli(['--static', '--repo-root', root]).exited;
      strictEqual(run.code, 0, run.out);
      ok(/static: 1 specs, 2 cases, 0 drift/.test(run.out), run.out);
      ok(/ N {2}the copy could not be put back .*; it is made again/.test(run.out), run.out);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('tells a same-size rewrite of a file just put back, on a filesystem whose times are coarse', async () => {
    // A filesystem with one-second times (HFS+), or Linux before 6.13, whose
    // change times move by the jiffy, cannot be made here: the check is given
    // an lstat that floors both times to 2^20 seconds (some twelve days), which
    // stands for one. A rewrite in the tick of the restore before it keeps
    // every field but the modification time the copy fixed.
    const root = makeScoringRepo();
    const workDir = join(root, '..', `harness-static4-${process.pid}`);
    const tick = 2n ** 20n * 1_000_000_000n;
    const coarse = (abs) => {
      const st = lstatSync(abs, { bigint: true });
      return { mode: st.mode, size: st.size, ino: st.ino, mtimeNs: (st.mtimeNs / tick) * tick, ctimeNs: (st.ctimeNs / tick) * tick };
    };
    write(root, 'spec.mjs', `
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const TEST = 'tests/test-value.mjs';
const rewrite = (fill) => (copy) => writeFileSync(join(copy, TEST), fill.repeat(statSync(join(copy, TEST)).size));
export const TESTS = [TEST];
export const MUTATIONS = [
  { id: 'W1', why: 'rewrites a file of the first copy, same size', prepare: rewrite('X') },
  { id: 'W2', why: 'rewrites the file the restore just put back, same size', prepare: rewrite('Y') },
  { id: 'R', why: 'sees the file as it was', prepare: (copy) => {
    if (readFileSync(join(copy, TEST), 'utf8') !== readFileSync(new URL(TEST, import.meta.url), 'utf8')) throw new Error(TEST + ' differs');
  } },
];
`);
    try {
      const { specs } = await checkSpecs([join(root, 'spec.mjs')], { repoRoot: root, workDir, lstat: coarse, log: () => {} });
      deepStrictEqual(specs[0].drift, []);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the CLI checks every spec in scripts/mutation-specs by default, and exits 1 on drift', BOUNDED, async () => {
    const root = makeScoringRepo();
    write(root, 'scripts/mutation-specs/good.mjs', SPEC.replace(/\n  \{ id: 'H'[^]*?\},\n/, '\n'));
    write(root, 'scripts/mutation-specs/drifted.mjs', SPEC);
    try {
      const drifted = await runCli(['--static', '--repo-root', root]).exited;
      strictEqual(drifted.code, 1, drifted.out);
      ok(/drifted\.mjs/.test(drifted.out) && /\bH\b.*occurs 0x/.test(drifted.out), drifted.out);
      ok(/good\.mjs/.test(drifted.out), `the other spec is checked too: ${drifted.out}`);
      rmSync(join(root, 'scripts/mutation-specs/drifted.mjs'));
      const clean = await runCli(['--static', '--repo-root', root]).exited;
      strictEqual(clean.code, 0, clean.out);
      ok(/static: 1 specs, 2 cases, 0 drift/.test(clean.out), clean.out);
      const named = await runCli(['--static', '--repo-root', root, join(root, 'scripts/mutation-specs/good.mjs'), '--only', 'K']).exited;
      strictEqual(named.code, 0, named.out);
      const two = await runCli(['--static', '--repo-root', root, 'a.mjs', 'b.mjs', '--only', 'K']).exited;
      strictEqual(two.code, 1, two.out);
      ok(/--only takes one spec/.test(two.out), two.out);
      rmSync(join(root, 'scripts/mutation-specs/good.mjs'));
      const empty = await runCli(['--static', '--repo-root', root]).exited;
      strictEqual(empty.code, 1, empty.out);
      ok(/scripts\/mutation-specs holds no spec/.test(empty.out), empty.out);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
