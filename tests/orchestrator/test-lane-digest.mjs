// tests/orchestrator/test-lane-digest.mjs
//
// ADR-0068 Decision 2, item 7 (impl-hold) — the release basis and its
// comparison (scripts/lib/lane-digest.mjs, hold-ops.mjs `compareRelease`):
// every non-ignored file of the lane, checked-out submodules included, through
// a temporary index (the lane's own never touched, its hidden bits cleared);
// the child's content digest from the real engineer; the comparison once,
// behind the writer exclusion that a persona first write respects in either
// order.

import { describe, it } from 'node:test';
import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const LIB = join(REPO_ROOT, 'plugins/orchestrator/scripts/lib');
const D = await import(pathToFileURL(join(LIB, 'lane-digest.mjs')).href);
const H = await import(pathToFileURL(join(LIB, 'holds.mjs')).href);
const OPS = await import(pathToFileURL(join(LIB, 'hold-ops.mjs')).href);
const PERSONA = await import(pathToFileURL(join(REPO_ROOT, 'plugins/engineer/scripts/lib/holds.mjs')).href);
const ENGINEER = join(REPO_ROOT, 'plugins/engineer');

const MACRO = 'macro-plan-20261026T000000Z-d00001';
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1', HOME: tmpdir() };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function withRepo(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lane-digest-')));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n.agentic-plugins/state/\n.agentic-plugins/runs/\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  try { return await fn(repo, dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('the tree digest', () => {
  it('moves with a tracked, an untracked and a deleted file; not with an ignored one', () => withRepo((repo) => {
    const base = D.treeDigest(repo).digest;
    strictEqual(D.treeDigest(repo).digest, base, 'stable');
    writeFileSync(join(repo, 'ignored.txt'), 'x');
    strictEqual(D.treeDigest(repo).digest, base, 'an ignored file is outside it (the documented limit)');
    writeFileSync(join(repo, 'a.txt'), 'b\n');
    const tracked = D.treeDigest(repo).digest;
    notStrictEqual(tracked, base);
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    strictEqual(D.treeDigest(repo).digest, base, 'put back, equal again');
    writeFileSync(join(repo, 'new.txt'), 'n');
    notStrictEqual(D.treeDigest(repo).digest, base);
    rmSync(join(repo, 'new.txt'));
    rmSync(join(repo, 'a.txt'));
    notStrictEqual(D.treeDigest(repo).digest, base);
  }));

  it('sees an edit of the same size whose times were put back (the copied index trusts no stat)', () => withRepo((repo) => {
    // Whole-second stat checks with no ctime: git would take the file for
    // unchanged by its stat alone.
    git(repo, 'config', 'core.trustctime', 'false');
    git(repo, 'config', 'core.checkStat', 'minimal');
    // Dated well before the index, so the index's entry is not racily clean
    // (git re-hashes an entry as new as its index, which would hide the
    // defect this test is for).
    const file = join(repo, 'a.txt');
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(file, old, old);
    git(repo, 'update-index', '--refresh');
    const base = D.treeDigest(repo).digest;
    writeFileSync(file, 'z\n');
    utimesSync(file, old, old);
    notStrictEqual(D.treeDigest(repo).digest, base);
  }));

  it('never touches the lane\'s own index, and sees an edit its assume-unchanged or skip-worktree bit hides', () => withRepo((repo) => {
    const index = join(repo, '.git', 'index');
    const before = readFileSync(index);
    const mtime = statSync(index).mtimeMs;
    const base = D.treeDigest(repo).digest;
    deepStrictEqual(readFileSync(index), before);
    strictEqual(statSync(index).mtimeMs, mtime);
    for (const bit of ['--assume-unchanged', '--skip-worktree']) {
      git(repo, 'update-index', bit, 'a.txt');
      writeFileSync(join(repo, 'a.txt'), `hidden by ${bit}\n`);
      strictEqual(git(repo, 'status', '--porcelain'), '', `git status does not see it (${bit})`);
      notStrictEqual(D.treeDigest(repo).digest, base, `the digest does (${bit})`);
      git(repo, 'update-index', bit.replace('--', '--no-'), 'a.txt');
      writeFileSync(join(repo, 'a.txt'), 'a\n');
    }
  }));

  it('ignores an inherited GIT_DIR or GIT_INDEX_FILE', () => withRepo((repo, dir) => {
    const base = D.treeDigest(repo).digest;
    const saved = { ...process.env };
    try {
      process.env.GIT_INDEX_FILE = join(dir, 'elsewhere-index');
      process.env.GIT_DIR = join(dir, 'nowhere');
      strictEqual(D.treeDigest(repo).digest, base);
    } finally {
      for (const k of ['GIT_INDEX_FILE', 'GIT_DIR']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  }));

  it('a checked-out submodule\'s edits move it; an uninitialized one counts by its commit', () => withRepo((repo, dir) => {
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    git(sub, 'init', '-q', '-b', 'main');
    writeFileSync(join(sub, 's.txt'), 's\n');
    git(sub, 'add', '-A');
    git(sub, 'commit', '-q', '-m', 's');
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'mod');
    git(repo, 'commit', '-q', '-m', 'sub');
    const base = D.treeDigest(repo).digest;
    writeFileSync(join(repo, 'mod', 's.txt'), 'edited\n');
    notStrictEqual(D.treeDigest(repo).digest, base, 'an unstaged edit inside the submodule');
    writeFileSync(join(repo, 'mod', 's.txt'), 's\n');
    strictEqual(D.treeDigest(repo).digest, base);
    git(repo, 'submodule', 'deinit', '-q', '-f', 'mod');
    ok(D.treeDigest(repo).digest.length === 64, 'an uninitialized one still digests');
  }));

  it('the lane\'s worktree lock is outside it, where the lane does not ignore its runs (a release removes its own fence)', () => withRepo((repo) => {
    writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
    const base = D.treeDigest(repo).digest;
    const lock = join(repo, '.agentic-plugins/runs/autopilot/worktree.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, `s-${'a'.repeat(32)}.json`), '{"kind":"session","command":"hold"}');
    strictEqual(D.treeDigest(repo).digest, base);
    writeFileSync(join(repo, '.agentic-plugins/runs/other.txt'), 'x');
    notStrictEqual(D.treeDigest(repo).digest, base, 'the rest of an unignored runs directory is in it');
  }));

  it('names the generated state paths a lane does not ignore', () => withRepo((repo) => {
    deepStrictEqual(D.unignoredStatePaths(repo), []);
    writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
    deepStrictEqual(D.unignoredStatePaths(repo), ['.agentic-plugins/state/', '.agentic-plugins/runs/']);
  }));
});

describe('the content digest', () => {
  it('is the real engineer\'s, and a Stop snapshot leaves it unchanged', () => withRepo((repo) => {
    const wf = join(repo, 'wf.md');
    writeFileSync(wf, '---\nschema: "1.4"\nworkflow_id: "compose-20261026T000000Z-aaaaaa"\npersona: "engineer"\nverb: "compose"\nprofile: "plan"\noriginal_request: "x"\nstarted_at: "2026-10-26T00:00:00Z"\nupdated_at: "2026-10-26T00:00:00Z"\nrepo_root: "/x"\ngit_baseline:\n  branch: "main"\n  head: "abc"\n  status_digest: "d"\ncurrent_phase: "p"\nnext_action: "n"\ntasks: []\nhost_history:\n  - host: "claude"\n    at: "2026-10-26T00:00:00Z"\n    event: "created"\npending_ensemble: []\nensemble_results: []\n---\n\n# body\n');
    const a = D.contentDigest(ENGINEER, wf);
    ok(/^[0-9a-f]{64}$/.test(a));
    writeFileSync(wf, readFileSync(wf, 'utf8').replace('updated_at: "2026-10-26T00:00:00Z"', 'updated_at: "2026-10-27T00:00:00Z"'));
    strictEqual(D.contentDigest(ENGINEER, wf), a, 'updated_at is a snapshot field');
    writeFileSync(wf, readFileSync(wf, 'utf8').replace('# body', '# body edited'));
    notStrictEqual(D.contentDigest(ENGINEER, wf), a);
  }));
});

describe('the comparison', () => {
  const SUB = 'S';
  const setup = async (main, lane) => {
    const h = await OPS.setHold({ mainRoot: main, macroId: MACRO, subtaskId: SUB, branch: 'feat/s', lane, child: null });
    await OPS.completeHandoff({ mainRoot: main, macroId: MACRO, subtaskId: SUB, stateRoots: [main] });
    return h;
  };
  const basisOf = async ({ laneRoot }) => ({ fingerprint_version: 1, fingerprint: 'f', tree_digest: D.treeDigest(laneRoot).digest, content_digest: 'c', child: null });

  it('a lane unchanged since its release consumes it once, and the kept park it recorded ends by its id', () => withRepo(async (lane, dir) => {
    const main = join(dir, 'main');
    mkdirSync(main);
    const h = await setup(main, lane);
    await OPS.releaseHold({ mainRoot: main, macroId: MACRO, subtaskId: SUB, holdId: h.hold_id, stateRoots: [main], basisOf, keptParkId: () => 'a'.repeat(16) });
    const ended = [];
    const r = await OPS.compareRelease({ mainRoot: main, macroId: MACRO, subtaskId: SUB, stateRoots: [main], basisOf, endPark: async (id) => { ended.push(id); } });
    strictEqual(r.verdict, 'consumed');
    deepStrictEqual(ended, ['a'.repeat(16)]);
    strictEqual(H.readRecord(main, MACRO, 'releases', SUB).record.park_ended, true);
    strictEqual((await OPS.compareRelease({ mainRoot: main, macroId: MACRO, subtaskId: SUB, stateRoots: [main], basisOf })).verdict, 'none', 'consumed once');
  }));

  it('a lane edited after its release rejects it, and a rejected release is not compared again once the tree is put back', () => withRepo(async (lane, dir) => {
    const main = join(dir, 'main');
    mkdirSync(main);
    const h = await setup(main, lane);
    await OPS.releaseHold({ mainRoot: main, macroId: MACRO, subtaskId: SUB, holdId: h.hold_id, stateRoots: [main], basisOf });
    writeFileSync(join(lane, 'a.txt'), 'after the release\n');
    strictEqual((await OPS.compareRelease({ mainRoot: main, macroId: MACRO, subtaskId: SUB, stateRoots: [main], basisOf })).verdict, 'rejected');
    writeFileSync(join(lane, 'a.txt'), 'a\n');
    strictEqual((await OPS.compareRelease({ mainRoot: main, macroId: MACRO, subtaskId: SUB, stateRoots: [main], basisOf })).verdict, 'none');
    strictEqual(H.holdStateOf(main, MACRO, SUB).state, 'rejected');
  }));

  it('a crash between the consumption and the park\'s end is finished by the recorded park id only', () => withRepo(async (lane, dir) => {
    const main = join(dir, 'main');
    mkdirSync(main);
    const h = await setup(main, lane);
    await OPS.releaseHold({ mainRoot: main, macroId: MACRO, subtaskId: SUB, holdId: h.hold_id, stateRoots: [main], basisOf, keptParkId: () => 'b'.repeat(16) });
    let crash = true;
    try {
      await OPS.compareRelease({ mainRoot: main, macroId: MACRO, subtaskId: SUB, stateRoots: [main], basisOf, endPark: async () => { if (crash) throw new Error('killed'); } });
    } catch { /* the crash */ }
    const rec = H.readRecord(main, MACRO, 'releases', SUB).record;
    deepStrictEqual([rec.state, rec.park_ended], ['consumed', false]);
    crash = false;
    const ended = [];
    strictEqual((await OPS.finishConsumption({ mainRoot: main, macroId: MACRO, subtaskId: SUB, endPark: async (id) => { ended.push(id); } })).finished, true);
    deepStrictEqual(ended, ['b'.repeat(16)]);
    strictEqual((await OPS.finishConsumption({ mainRoot: main, macroId: MACRO, subtaskId: SUB, endPark: async (id) => { ended.push(id); } })).finished, false, 'idempotent');
  }));

  it('basesEqual: every clause decides — the fingerprint, its version, the tree, the content, the child; a missing side is never equal', () => {
    const base = { fingerprint_version: 3, fingerprint: 'f', tree_digest: 't', content_digest: 'c', child: 'compose-20261026T000000Z-c00001' };
    strictEqual(OPS.basesEqual(base, { ...base }), true);
    for (const [key, value] of [['fingerprint', 'g'], ['fingerprint_version', 4], ['tree_digest', 'u'], ['content_digest', 'd'], ['child', 'compose-20261026T000000Z-c00002'], ['child', null]]) {
      strictEqual(OPS.basesEqual(base, { ...base, [key]: value }), false, `${key} differs`);
    }
    strictEqual(OPS.basesEqual({ ...base, child: null }, { ...base, child: undefined }), true, 'no child either way');
    strictEqual(OPS.basesEqual(null, base), false);
    strictEqual(OPS.basesEqual(base, null), false);
  });

  it('an ignored file the fingerprint reads, edited after the release, rejects it: the tree digest alone does not see it', () => withRepo(async (lane, dir) => {
    const main = join(dir, 'main');
    mkdirSync(main);
    writeFileSync(join(lane, 'ignored.txt'), 'before\n');
    const h = await setup(main, lane);
    // The fingerprint reads what the tree digest leaves out (the lane's
    // ignored state, P13): here, the ignored file itself.
    const withFingerprint = async ({ laneRoot }) => ({ ...(await basisOf({ laneRoot })), fingerprint: readFileSync(join(laneRoot, 'ignored.txt'), 'utf8') });
    await OPS.releaseHold({ mainRoot: main, macroId: MACRO, subtaskId: SUB, holdId: h.hold_id, stateRoots: [main], basisOf: withFingerprint });
    const tree = D.treeDigest(lane).digest;
    writeFileSync(join(lane, 'ignored.txt'), 'after\n');
    strictEqual(D.treeDigest(lane).digest, tree, 'the tree digest does not see an ignored file');
    strictEqual((await OPS.compareRelease({ mainRoot: main, macroId: MACRO, subtaskId: SUB, stateRoots: [main], basisOf: withFingerprint })).verdict, 'rejected');
  }));

  for (const order of ['the comparison first', 'the persona first']) {
    it(`a persona first write racing the comparison: exactly one side refuses (${order})`, () => withRepo(async (lane, dir) => {
      const main = join(dir, 'main');
      mkdirSync(main);
      const h = await setup(main, lane);
      await OPS.releaseHold({ mainRoot: main, macroId: MACRO, subtaskId: SUB, holdId: h.hold_id, stateRoots: [main], basisOf });
      // The persona's first write, as its library does it (N4): publish, then
      // look again for any other open operation.
      const personaFirstWrite = () => {
        const id = PERSONA.newOperationId();
        PERSONA.publishOpRecord(main, MACRO, SUB, { operation_id: id, kind: 'verb', subtask_id: SUB, workflow_id: null, persona: 'engineer', host: 'claude', opened_at: '2026-10-26T00:00:00Z' });
        const others = PERSONA.readOps(main, MACRO, SUB).ops.filter((o) => o.id !== id && !o.cleared);
        if (others.length) { PERSONA.removeOpRecord(main, MACRO, SUB, id); return 'refused'; }
        return 'proceeds';
      };
      let persona;
      let r;
      if (order === 'the comparison first') {
        r = await OPS.compareRelease({ mainRoot: main, macroId: MACRO, subtaskId: SUB, stateRoots: [main], basisOf: async (x) => { persona = personaFirstWrite(); return basisOf(x); } });
        deepStrictEqual([r.verdict, persona], ['consumed', 'refused']);
      } else {
        persona = personaFirstWrite();
        r = await OPS.compareRelease({ mainRoot: main, macroId: MACRO, subtaskId: SUB, stateRoots: [main], basisOf });
        deepStrictEqual([persona, r.verdict], ['proceeds', 'refused']);
        strictEqual(H.holdStateOf(main, MACRO, SUB).state, 'released-uncompared', 'the lane does not step, and its release waits');
      }
    }));
  }
});
