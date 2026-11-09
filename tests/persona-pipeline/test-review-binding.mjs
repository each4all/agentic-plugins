// tests/persona-pipeline/test-review-binding.mjs
//
// C163 A2b (ADR-0069) — a review is bound to the change it reviewed:
//
//   - the identity a review records (Decision 1), from the real runner and its
//     snapshot, and the manifest's one projection;
//   - which differences count (Decision 2), composed path by path;
//   - enforcement at Phase 7 (Decision 3): an unchanged change, a clean rebase,
//     an edit after review, a review of a different change, a partial
//     multi-package commit and its recovery, an old record (Decision 4);
//   - the owner's acceptance, which an edit makes stale.
//
// The landing half (resolve-landing, done, the policy) is
// tests/orchestrator/test-review-binding-landing.mjs.

import { describe, it } from 'node:test';
import { deepStrictEqual, doesNotMatch, match, notStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, personaInfo } from './_personas.mjs';

const P = personaInfo('engineer');
const STATE_BIN = P.path('scripts/state.mjs');
const PHASE7_BIN = P.path('scripts/phase7-commit.mjs');
const S = await import(pathToFileURL(STATE_BIN).href);
const LIB = await import(pathToFileURL(P.path('scripts/lib/review-attempts.mjs')).href);
const CI = await import(pathToFileURL(P.path('scripts/lib/change-identity.mjs')).href);
const SNAP = await import(pathToFileURL(P.path('scripts/lib/peer-snapshot.mjs')).href);
const RUNNER = await import(pathToFileURL(P.path('scripts/peer-runner.mjs')).href);

const AUTOPILOT = { AGENTIC_AUTOPILOT: 'autopilot-20261107T010203Z-abcdef' };

// The projection stages in the process's own environment, as Phase 7 does
// (critique of 2026-11-08, MAJOR 1): the in-process checks below read no
// repository selector a caller left set.
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k];

function env(extra = {}) {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith('AGENTIC_') || k.startsWith('GIT_')) delete e[k];
  delete e.ACCEPT_CURRENT_TREE;
  return { ...e, AGENTIC_ORCHESTRATOR_ROOT: resolve(REPO_ROOT, 'plugins/orchestrator'), ...extra };
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: env() }).trim();
const digest = (dir) => execFileSync('shasum', ['-a', '256'], {
  input: execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd: dir }),
  encoding: 'utf8',
}).trim().split(/\s+/)[0];

// A clone with a bare origin, `main` as its default branch, on a feature branch.
async function withRepo(fn, { packages = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'review-binding-')));
  const dir = join(root, 'work');
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(root, 'origin.git')], { env: env() });
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: env() });
    for (const [k, v] of [['user.name', 'review-binding'], ['user.email', 'rb@example.invalid'], ['commit.gpgsign', 'false']]) git(dir, 'config', k, v);
    await writeFile(join(dir, '.gitignore'), '.agentic-plugins/state/\n');
    await mkdir(join(dir, 'pkgA'));
    await mkdir(join(dir, 'pkgB'));
    await writeFile(join(dir, 'pkgA', 'x'), 'x0\n');
    await writeFile(join(dir, 'pkgB', 'y'), 'y0\n');
    await writeFile(join(dir, 'other'), 'o0\n');
    if (packages) {
      await writeFile(join(dir, 'release-please-config.json'), JSON.stringify({ packages: { pkgA: {}, pkgB: {} } }));
    }
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'chore: baseline', '--no-verify');
    git(dir, 'remote', 'add', 'origin', join(root, 'origin.git'));
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    git(dir, 'remote', 'set-head', 'origin', 'main');
    git(dir, 'switch', '-q', '-c', 'feat/s');
    await fn(dir, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function workflow(dir, paths = ['pkgA/x']) {
  const wf = execFileSync('node', [
    STATE_BIN, 'create', '--repo-root', dir, '--verb', 'compose', '--profile', 'code', '--persona', 'engineer',
    '--host', 'claude', '--git-baseline-branch', git(dir, 'branch', '--show-current'), '--git-baseline-head', git(dir, 'rev-parse', 'HEAD'),
    '--status-digest', digest(dir), '--current-phase', 'phase-0-bootstrap', '--next-action', 'Run skill',
    '--original-request', 'the change',
  ], { cwd: dir, encoding: 'utf8', env: env(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  for (const p of paths) {
    execFileSync('node', [STATE_BIN, 'record-composed-file', '--workflow-path', wf, '--path', p, '--op', 'edit'], { cwd: dir, env: env(), stdio: 'pipe' });
  }
  execFileSync('node', [STATE_BIN, 'append', '--workflow-path', wf, '--host', 'claude', '--next-step-kind', 'commit', '--next-step-confidence', 'HIGH', '--event', 'updated'], { cwd: dir, env: env(), stdio: 'pipe' });
  return wf;
}

let clock = Date.parse('2026-11-07T00:00:00Z');
const tick = () => new Date((clock += 1000)).toISOString().replace(/\.\d{3}Z$/, 'Z');

// A completed review of the checkout as it is, as settle records it: `covered`
// defaults to every path the change touches, so it is `full`.
async function review(dir, wf, id, { outcome = 'passed', covered = null, shown = null, result = null } = {}) {
  const captured = await SNAP.captureWorkingTree({ cwd: dir, env: env() });
  const { identity, reason } = CI.captureIdentity({
    repoRoot: dir, head: captured.head, resultTree: result ?? captured.tree, source: 'snapshot', capturedAt: tick(), refresh: false, flagged: captured.flagged,
  });
  const touched = identity ? identity.manifest.map(LIB.entryPath) : [];
  const cov = covered ?? touched;
  await S.recordReviewAttempt({
    workflowPath: wf,
    env: env(),
    attempt: { id, phase: 'critique', type: 'review', state: 'closed', outcome, run_id: id, tree: null, tree_reason: 'no-snapshot' },
    binding: { identity, reason, coverage: { shown: shown ?? cov, covered: cov } },
  });
}
const check = (dir, wf, paths = ['pkgA/x']) => S.reviewBindingCheck({ workflowPath: wf, repoRoot: dir, paths, refresh: false });
const phase7 = (dir, wf, mode, args = [], extra = {}) => {
  const r = spawnSync('node', [PHASE7_BIN, '--mode', mode, '--workflow-path', wf, '--repo-root', dir, '--host', 'claude', ...args], { cwd: dir, encoding: 'utf8', env: env(extra) });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};
async function subject(root, text = 'fix(pkgA): change x') {
  const file = join(root, `subject-${Math.random().toString(16).slice(2)}.txt`);
  await writeFile(file, `${text}\n`);
  return file;
}
const headOf = (dir) => git(dir, 'rev-parse', 'HEAD');
const comparisons = async (wf) => JSON.parse(S.parseWorkflowFile(await readFile(wf, 'utf8')).frontmatter.review_bindings).comparisons;

describe('the change identity (ADR-0069 Decision 1)', () => {
  it('records the base, the result tree and the manifest, its landing branch and where it came from', async () => {
    await withRepo(async (dir) => {
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      const c = await SNAP.captureWorkingTree({ cwd: dir, env: env() });
      const { identity } = CI.captureIdentity({ repoRoot: dir, head: c.head, resultTree: c.tree, source: 'checkout', capturedAt: '2026-11-07T00:00:00Z', refresh: false });
      deepStrictEqual([identity.v, identity.object_format, identity.base.branch, identity.base.source, identity.source, identity.result_tree],
        [1, 'sha1', 'main', 'default', 'checkout', c.tree]);
      strictEqual(identity.base.commit, git(dir, 'rev-parse', 'main'));
      strictEqual(identity.manifest.length, 1);
      match(identity.manifest[0], /^100644 100644 [0-9a-f]{40} [0-9a-f]{40} M\tpkgA\/x$/);
    });
  });

  it('the branch to land on: an argument, then the macro, then the default branch, and no local guess', async () => {
    await withRepo(async (dir, root) => {
      deepStrictEqual(CI.resolveLandingBranch({ repoRoot: dir, argument: 'rel', macroBranch: 'dev' }), { branch: 'rel', source: 'argument' });
      deepStrictEqual(CI.resolveLandingBranch({ repoRoot: dir, macroBranch: 'dev' }), { branch: 'dev', source: 'macro' });
      deepStrictEqual(CI.resolveLandingBranch({ repoRoot: dir }), { branch: 'main', source: 'default' });
      git(dir, 'remote', 'set-head', 'origin', '--delete');
      strictEqual(CI.resolveLandingBranch({ repoRoot: dir }).branch, null);
      const macro = join(root, 'macro.md');
      await writeFile(macro, '---\nschema_version: "1.2"\ngit_baseline:\n  head: "abc"\n  branch: "dev"\n  status_digest: "d"\nplan:\n  subtasks: []\n---\n');
      strictEqual(CI.macroBranchOf({ parent_workflow_path: macro }), 'dev');
      strictEqual(CI.macroBranchOf({}), null);
    });
  });

  it('several best merge bases, an unborn branch and flagged index entries record no identity, with the reason', async () => {
    await withRepo(async (dir) => {
      const c = await SNAP.captureWorkingTree({ cwd: dir, env: env() });
      strictEqual(CI.captureIdentity({ repoRoot: dir, head: c.head, resultTree: c.tree, source: 's', capturedAt: 'x', refresh: false, flagged: ['a'] }).reason, 'index-flags');
      strictEqual(CI.captureIdentity({ repoRoot: dir, head: null, resultTree: c.tree, source: 's', capturedAt: 'x', refresh: false }).reason, 'unborn-branch');
      // A criss-cross: two commits, each merging the other's parent.
      git(dir, 'switch', '-q', 'main');
      await writeFile(join(dir, 'm1'), '1\n');
      git(dir, 'add', 'm1');
      git(dir, 'commit', '-qm', 'm1', '--no-verify');
      git(dir, 'switch', '-q', 'feat/s');
      await writeFile(join(dir, 'f1'), '1\n');
      git(dir, 'add', 'f1');
      git(dir, 'commit', '-qm', 'f1', '--no-verify');
      const f1 = headOf(dir);
      git(dir, 'merge', '-q', '--no-ff', '--no-edit', 'main');
      git(dir, 'switch', '-q', 'main');
      git(dir, 'merge', '-q', '--no-ff', '--no-edit', f1);
      git(dir, 'push', '-q', 'origin', 'main');
      git(dir, 'switch', '-q', 'feat/s');
      const h = headOf(dir);
      strictEqual(CI.captureIdentity({ repoRoot: dir, head: h, resultTree: c.tree, source: 's', capturedAt: 'x', refresh: false }).reason, 'several-merge-bases');
    });
  });

  it('the manifest ignores diff settings, shows a pinned submodule whatever its ignore setting, and drops the state homes', async () => {
    await withRepo(async (dir) => {
      const base = git(dir, 'rev-parse', 'HEAD^{tree}');
      // A tracked file under a state home reads as nothing (ADR-0069 P3).
      strictEqual(CI.isExcludedFromManifest('.agentic-plugins/state/x.json'), true);
      strictEqual(CI.isExcludedFromManifest('.claude/agentic-engineer/workflows/a.md'), true);
      strictEqual(CI.isExcludedFromManifest('.claude/settings.json'), false);
      strictEqual(CI.isExcludedFromManifest('.agentic-plugins/other'), false);
      // Through the projection: a file under a state home moved, and nothing shows.
      git(dir, 'update-index', '--add', '--cacheinfo', `100644,${git(dir, 'rev-parse', 'HEAD:other')},.agentic-plugins/state/x.json`);
      deepStrictEqual(CI.manifestBetween(dir, base, git(dir, 'write-tree')).entries, []);
      git(dir, 'rm', '-q', '--cached', '.agentic-plugins/state/x.json');
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      git(dir, 'add', 'pkgA/x');
      const tree1 = git(dir, 'write-tree');
      git(dir, 'config', 'diff.noprefix', 'true');
      git(dir, 'config', 'diff.renames', 'copies');
      git(dir, 'config', 'color.diff', 'always');
      const a = CI.manifestBetween(dir, base, tree1).entries;
      git(dir, 'config', '--unset', 'diff.noprefix');
      strictEqual(CI.manifestBetween(dir, base, tree1).entries.join(), a.join());
      // A gitlink moved, under each ignore setting that hides it. A setting
      // reaches only a path .gitmodules maps to a submodule's name (ADR-0069
      // P1): with no mapping git shows the move with no option at all, and the
      // manifest's option would be untested. So each setting first proves, on
      // git's own output, that it hides the move; that control reads no user or
      // system configuration, where a `submodule.mod.ignore` would override the
      // one in .gitmodules.
      const old = 'a'.repeat(40);
      const pin = 'b'.repeat(40);
      git(dir, 'update-index', '--add', '--cacheinfo', `160000,${old},mod`);
      const t1 = git(dir, 'write-tree');
      git(dir, 'update-index', '--add', '--cacheinfo', `160000,${pin},mod`);
      const t2 = git(dir, 'write-tree');
      const mapping = '[submodule "mod"]\n\tpath = mod\n\turl = ./mod\n';
      const holdsThePin = () => {
        strictEqual(execFileSync('git', ['diff-tree', '-r', '--raw', '--no-renames', '--full-index', t1, t2], {
          cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: env({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }),
        }).trim(), '');
        const pinned = CI.manifestBetween(dir, t1, t2).entries;
        strictEqual(pinned.length, 1);
        match(pinned[0], /^160000 160000 a{40} b{40} M\tmod$/);
      };
      // Set in .gitmodules.
      await writeFile(join(dir, '.gitmodules'), `${mapping}\tignore = all\n`);
      holdsThePin();
      // Set in the repository's configuration.
      await writeFile(join(dir, '.gitmodules'), mapping);
      git(dir, 'config', 'diff.ignoreSubmodules', 'all');
      git(dir, 'config', 'submodule.mod.ignore', 'all');
      holdsThePin();
    });
  });

  // Critique of 2026-11-07, MAJOR 2: a decoder that strips a byte-order mark
  // made `other` and U+FEFF `other` one path.
  it('a leading U+FEFF is part of a path, never stripped', async () => {
    await withRepo(async (dir) => {
      const base = git(dir, 'rev-parse', 'HEAD^{tree}');
      const bom = `${String.fromCharCode(0xfeff)}other`;
      git(dir, 'update-index', '--add', '--cacheinfo', `100644,${git(dir, 'rev-parse', 'HEAD:other')},${bom}`);
      const entries = CI.manifestBetween(dir, base, git(dir, 'write-tree')).entries;
      deepStrictEqual(entries.map(LIB.entryPath), [bom]);
    });
  });

  it('a rename is a delete and an add; a mode is a difference', async () => {
    await withRepo(async (dir) => {
      const base = git(dir, 'rev-parse', 'HEAD^{tree}');
      git(dir, 'mv', 'other', 'renamed');
      const t = git(dir, 'write-tree');
      deepStrictEqual(CI.manifestBetween(dir, base, t).entries.map((e) => e.split(' ')[4]).sort(), ['A\trenamed', 'D\tother']);
      git(dir, 'mv', 'renamed', 'other');
      await chmod(join(dir, 'other'), 0o755);
      git(dir, 'add', 'other');
      match(CI.manifestBetween(dir, base, git(dir, 'write-tree')).entries[0], /^100644 100755 /);
    });
  });

  it('a subject: covered is a subset of shown, and a path outside the repository is refused', () => {
    deepStrictEqual(CI.parseSubject('{"shown":["a","./b"],"covered":["c"]}').subject, { shown: ['a', 'b', 'c'], covered: ['c'] });
    match(CI.parseSubject('{"shown":["../a"],"covered":[]}').problem, /not relative/);
    match(CI.parseSubject('{"shown":["/a"],"covered":[]}').problem, /not relative/);
    match(CI.parseSubject('{"shown":[]}').problem, /both be lists/);
    match(CI.parseSubject('{"shown":[],"covered":[],"x":1}').problem, /unknown field/);
    match(CI.parseSubject('nope').problem, /not JSON/);
  });
});

// The real runner against a stub peer, which edits its snapshot on request.
async function stubCompanions(root) {
  const dir = join(root, 'fake-companions');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'discover-peer.mjs'), 'export async function discoverPeerCompanion({ peer } = {}) { return { ok: true, path: new URL("./" + peer + "-companion.mjs", import.meta.url).pathname }; }\n');
  const companion = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const at = process.argv.indexOf('--cwd');
if (process.env.FAKE_EDIT) writeFileSync(join(at > 0 ? process.argv[at + 1] : process.cwd(), process.env.FAKE_EDIT), 'edited by the peer\\n');
process.stdout.write(JSON.stringify({ status: 'success', peer_host: 'codex', peer_model: null, stdout: 'the peer answer', exit_code: 0 }));
`;
  for (const peer of ['claude', 'codex']) {
    await writeFile(join(dir, `${peer}-companion.mjs`), companion);
    await chmod(join(dir, `${peer}-companion.mjs`), 0o755);
  }
  return dir;
}

describe('the runner records what the review saw (ADR-0069 Decision 1, item 4)', () => {
  const run = async (dir, wf, companions, runId, extra = {}, runEnv = {}) => RUNNER.runPeer({
    repoRoot: dir, runId, kind: 'ensemble', workflowPath: wf, phase: 'critique', ensembleType: 'review', host: 'claude',
    peer: 'codex', promptText: '<task>review</task>', outputFormat: 'json', cwd: dir,
    env: { ...env(), AGENTIC_COMPANIONS_ROOT: companions, ...runEnv }, ...extra,
  });
  const settle = (dir, wf, runId) => RUNNER.settleEnsemble({ repoRoot: dir, workflowPath: wf, phase: 'critique', runId, verdict: 'agreed', summary: 'fine', host: 'claude', env: env() });
  const record = async (wf, id) => JSON.parse(S.parseWorkflowFile(await readFile(wf, 'utf8')).frontmatter.review_bindings).attempts[id];

  it('a peer that leaves its snapshot alone binds, with its subject; the attempt document gains no field', async () => {
    await withRepo(async (dir, root) => {
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      const companions = await stubCompanions(root);
      const subjectFile = join(root, 'subject.json');
      await writeFile(subjectFile, JSON.stringify({ shown: ['pkgA/x'], covered: ['pkgA/x'] }));
      await run(dir, wf, companions, 'review-run-1', { subjectFile });
      await settle(dir, wf, 'review-run-1');
      const rec = await record(wf, 'review-run-1');
      deepStrictEqual([rec.identity.source, rec.identity.base.branch, rec.coverage], ['snapshot', 'main', 'full']);
      const fm = S.parseWorkflowFile(await readFile(wf, 'utf8')).frontmatter;
      // Decision 4: an older reader of the attempts finds its own schema.
      strictEqual(LIB.reviewAttemptsProblem(JSON.parse(fm.review_attempts)), null);
      deepStrictEqual(Object.keys(JSON.parse(fm.review_attempts).attempts[0]).filter((k) => k === 'identity' || k === 'coverage'), []);
      strictEqual((await check(dir, wf)).state, 'same');
    });
  });

  it('a peer that changes its snapshot records no identity, and vouches for nothing', async () => {
    await withRepo(async (dir, root) => {
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      const companions = await stubCompanions(root);
      await run(dir, wf, companions, 'review-run-2', {}, { FAKE_EDIT: 'pkgA/x' });
      await settle(dir, wf, 'review-run-2');
      const rec = await record(wf, 'review-run-2');
      deepStrictEqual([rec.identity, rec.reason], [null, 'snapshot-changed']);
      const c = await check(dir, wf);
      deepStrictEqual([c.state, c.held], ['not-comparable', true]);
      match(c.reason, /unbound-review:review-run-2:snapshot-changed/);
    });
  });

  it('a dispatch with no subject is unbound: what it showed is not known, so it vouches for nothing', async () => {
    await withRepo(async (dir, root) => {
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      const companions = await stubCompanions(root);
      await run(dir, wf, companions, 'review-run-3');
      await settle(dir, wf, 'review-run-3');
      strictEqual((await record(wf, 'review-run-3')).coverage, null);
      const c = await check(dir, wf);
      deepStrictEqual([c.state, c.held], ['not-comparable', true]);
      match(c.reason, /unbound-review:review-run-3:no-subject/);
    });
  });

  it('an empty subject is a record: it covers no path, so what the change touches is uncovered', async () => {
    await withRepo(async (dir, root) => {
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      const companions = await stubCompanions(root);
      const subjectFile = join(root, 'subject.json');
      await writeFile(subjectFile, JSON.stringify({ shown: [], covered: [] }));
      await run(dir, wf, companions, 'review-run-4', { subjectFile });
      await settle(dir, wf, 'review-run-4');
      const c = await check(dir, wf);
      deepStrictEqual([c.state, c.failures.map((f) => [f.path, f.why])], ['different', [['pkgA/x', 'uncovered']]]);
    });
  });

  it('an untouched snapshot with an unstaged submodule update binds', async () => {
    await withRepo(async (dir, root) => {
      // A submodule the checkout moved and did not stage.
      const sub = join(dir, 'sub');
      await mkdir(sub);
      execFileSync('git', ['init', '-q', '-b', 'main', sub], { env: env() });
      for (const [k, v] of [['user.name', 's'], ['user.email', 's@example.invalid'], ['commit.gpgsign', 'false']]) git(sub, 'config', k, v);
      await writeFile(join(sub, 'f'), '1\n');
      git(sub, 'add', 'f');
      git(sub, 'commit', '-qm', 'one', '--no-verify');
      git(dir, 'add', 'sub');
      git(dir, 'commit', '-qm', 'chore: pin', '--no-verify');
      git(dir, 'push', '-q', 'origin', 'feat/s:main');
      const wf = workflow(dir, ['sub']);
      await writeFile(join(sub, 'f'), '2\n');
      git(sub, 'commit', '-qam', 'two', '--no-verify');
      const companions = await stubCompanions(root);
      const subjectFile = join(root, 'subject.json');
      await writeFile(subjectFile, JSON.stringify({ shown: ['sub'], covered: ['sub'] }));
      await run(dir, wf, companions, 'review-run-5', { subjectFile });
      await settle(dir, wf, 'review-run-5');
      const rec = await record(wf, 'review-run-5');
      strictEqual(rec.reason, undefined);
      strictEqual(rec.identity.source, 'snapshot');
    });
  });

  it("settle waits for the runner's second capture: a run terminal and not yet captured again is refused while its runner lives", async () => {
    await withRepo(async (dir, root) => {
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      const companions = await stubCompanions(root);
      await run(dir, wf, companions, 'review-run-6');
      // The handle as the runner leaves it between its terminal status and its
      // cleanup: an identity, no second capture, and a live supervisor (this process).
      const handlePath = join(S.workflowStorage(wf).stateRoot, '.agentic-plugins/state/engineer/peer-runs/review-run-6/handle.json');
      const handle = JSON.parse(await readFile(handlePath, 'utf8'));
      const { end_tree: _gone, ...snapshot } = handle.snapshot;
      await writeFile(handlePath, JSON.stringify({ ...handle, snapshot }));
      await rejects(settle(dir, wf, 'review-run-6'), /still finishing/);
      // With its runner gone it settles, unbound.
      await writeFile(handlePath, JSON.stringify({ ...handle, snapshot: { ...snapshot, supervisor: { pid: 999999, fingerprint: { kind: 'none' } } } }));
      await settle(dir, wf, 'review-run-6');
      strictEqual((await record(wf, 'review-run-6')).reason, 'snapshot-not-recaptured');
    });
  });

  it('a review that never launched records the checkout, and answers for no path', async () => {
    await withRepo(async (dir, root) => {
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      const out = await RUNNER.settleEnsemble({
        repoRoot: dir, workflowPath: wf, phase: 'critique', runId: '', ensembleType: 'review', noRunReason: 'local-only', attemptKey: root, host: 'claude', env: env(),
      });
      const rec = await record(wf, out.attempt_id);
      strictEqual(rec.identity.source, 'checkout');
      // It is on record and counts for nothing: a skip's reason is the worker's claim.
      strictEqual((await check(dir, wf)).state, 'no-reviews');
    });
  });
});

describe('which reviews vouch for a change (ADR-0069 Decisions 2 and 3, the pure rule)', () => {
  const e = (path, after = 'b') => `100644 100644 ${'a'.repeat(40)} ${after.repeat(40)} M\t${path}`;
  // A workflow's record as settle builds it: every review listed in the ledger
  // in the order given and closed, then its binding applied in `settled` order
  // (the ledger's, by default). A review is `{id, outcome, manifest, covered,
  // shown, identity: null, reason, coverage: null, branch, format, v}`.
  function record(reviews, { settled = null, maxBytes = undefined } = {}) {
    const attempts = reviews.map((r) => ({
      id: r.id, phase: 'critique', type: 'review', state: 'closed', outcome: r.outcome ?? 'passed', ...(r.outcome === 'skipped' ? { reason: 'local-only' } : {}), recorded_at: '2026-11-07T00:00:00Z', tree: null, tree_reason: 'x',
    }));
    const fm = { review_attempts: JSON.stringify({ v: 1, attempts, coverage: { history_incomplete: false, reasons: [] } }) };
    for (const id of settled ?? reviews.map((r) => r.id)) {
      const r = reviews.find((x) => x.id === id);
      const identity = r.identity === null ? null : { v: r.v ?? 1, object_format: r.format ?? 'sha1', base: { branch: r.branch ?? 'main' }, captured_at: '2026-11-07T00:00:00Z', manifest: r.manifest ?? [] };
      const coverage = r.coverage === null ? null : { shown: [...new Set([...(r.shown ?? []), ...(r.covered ?? [])])], covered: r.covered ?? [] };
      const out = LIB.applyReviewBinding(fm.review_bindings, id, { identity, reason: r.reason ?? null, coverage }, { attempts: LIB.projectReviewOutcomes(fm).attempts, ...(maxBytes ? { maxBytes } : {}) });
      fm.review_bindings = out.raw;
    }
    return fm;
  }
  const compare = (change, fm) => LIB.compareWithBindings({ change, frontmatter: fm, branch: 'main', objectFormat: 'sha1' });
  const failed = (c) => [c.state, c.failures.map((f) => [f.path, f.why])];

  it('one full review of the same change vouches; any byte of one path does not', () => {
    const fm = record([{ id: 'R', manifest: [e('a')], covered: ['a'] }]);
    strictEqual(compare([e('a')], fm).state, 'same');
    deepStrictEqual(compare([e('a', 'c')], fm).failures, [{ path: 'a', why: 'differs', by: ['R'] }]);
  });

  it('a path no review covers fails, and so does a path dropped from the change', () => {
    const fm = record([{ id: 'R', manifest: [e('a')], covered: ['a'] }]);
    deepStrictEqual(failed(compare([e('a'), e('b')], fm)), ['different', [['b', 'uncovered']]]);
    deepStrictEqual(failed(compare([], fm)), ['different', [['a', 'differs']]]);
  });

  it('a scoped review composes with the full one before it, path by path; the latest in the ledger answers', () => {
    const fm = record([
      { id: 'F', manifest: [e('a'), e('b')], covered: ['a', 'b'] },
      { id: 'S', manifest: [e('a'), e('b', 'c')], covered: ['b'] },
    ]);
    strictEqual(compare([e('a'), e('b', 'c')], fm).state, 'same');
    // The edit outside the scoped path stays unreviewed.
    deepStrictEqual(failed(compare([e('a', 'd'), e('b', 'c')], fm)), ['different', [['a', 'differs']]]);
    // The earlier answer on the scoped path is replaced.
    deepStrictEqual(failed(compare([e('a'), e('b')], fm)), ['different', [['b', 'differs']]]);
  });

  it('a review settled after a later-listed one is unbound, and only a later full review lifts it', () => {
    const reviews = [
      { id: 'F', manifest: [e('a'), e('b')], covered: ['a', 'b'] },
      { id: 'S', manifest: [e('a'), e('b', 'c')], covered: ['b'] },
    ];
    deepStrictEqual(LIB.decodeReviewBindings(record(reviews, { settled: ['S', 'F'] }).review_bindings).doc.attempts.F.reason, 'settled-out-of-order');
    deepStrictEqual([compare([e('a'), e('b', 'c')], record(reviews, { settled: ['S', 'F'] })).reason], ['unbound-review:F:settled-out-of-order']);
    // A later full review saw the whole change after it.
    const lifted = record([...reviews, { id: 'G', manifest: [e('a'), e('b', 'c')], covered: ['a', 'b'] }], { settled: ['S', 'F', 'G'] });
    strictEqual(compare([e('a'), e('b', 'c')], lifted).state, 'same');
  });

  it('a path a later full review no longer shows answers as untouched; one it showed changed does not', () => {
    const early = { id: 'E', manifest: [e('a'), e('gone')], covered: ['a', 'gone'] };
    strictEqual(compare([e('a')], record([early, { id: 'L', manifest: [e('a')], covered: ['a'] }])).state, 'same');
    const showed = { id: 'L', manifest: [e('a')], covered: ['a'], shown: ['a', 'gone'] };
    deepStrictEqual(failed(compare([e('a')], record([early, showed]))), ['different', [['gone', 'differs']]]);
    // Not a full review: it clears nothing.
    deepStrictEqual(failed(compare([e('a')], record([early, { id: 'L', manifest: [e('a'), e('x')], covered: ['a'] }]))), ['different', [['gone', 'differs']]]);
    // The change does touch it: the untouched entry differs.
    deepStrictEqual(failed(compare([e('a'), e('gone')], record([early, { id: 'L', manifest: [e('a')], covered: ['a'] }]))), ['different', [['gone', 'differs']]]);
  });

  it('a path a review covers and the change leaves untouched is compared: an edit to it is a different change', () => {
    const fm = record([{ id: 'R', manifest: [e('a')], covered: ['a', 'b'] }]);
    strictEqual(compare([e('a')], fm).state, 'same');
    deepStrictEqual(failed(compare([e('a'), e('b')], fm)), ['different', [['b', 'differs']]]);
  });

  it('which outcomes count: passed, concerns and conflict answer; a skip, a failure and an unavailable peer do not', () => {
    deepStrictEqual([...LIB.COUNTING_REVIEW_OUTCOMES], ['passed', 'concerns', 'conflict']);
    for (const outcome of ['failed', 'degraded', 'unavailable', 'malformed', 'skipped']) {
      strictEqual(compare([e('a')], record([{ id: 'R', outcome, manifest: [e('a')], covered: ['a'] }])).state, 'no-reviews', outcome);
    }
    for (const outcome of ['passed', 'concerns', 'conflict']) {
      strictEqual(compare([e('a')], record([{ id: 'R', outcome, manifest: [e('a')], covered: ['a'] }])).state, 'same', outcome);
    }
  });

  it('an unbound counting review is not comparable until a later full review lifts it', () => {
    const later = { id: 'F', manifest: [e('a')], covered: ['a'] };
    for (const [unbound, why] of [
      [{ id: 'U', identity: null, reason: 'snapshot-changed' }, 'snapshot-changed'],
      [{ id: 'U', manifest: [e('a')], coverage: null }, 'no-subject'],
      [{ id: 'U', manifest: [e('a')], covered: ['a'], branch: 'dev' }, 'other-landing-branch:dev'],
      [{ id: 'U', manifest: [e('a')], covered: ['a'], format: 'sha256' }, 'object-format'],
      [{ id: 'U', manifest: [e('a')], covered: ['a'], v: 2 }, 'identity-version'],
    ]) {
      strictEqual(compare([e('a')], record([later, unbound])).reason, `unbound-review:U:${why}`, why);
      // Lifted by a later full review, by ledger position.
      strictEqual(compare([e('a')], record([unbound, later])).state, 'same', why);
    }
    // A record from before the identity existed: an attempt with no binding.
    const fm = record([later]);
    const attempts = JSON.parse(fm.review_attempts);
    attempts.attempts.push({ ...attempts.attempts[0], id: 'old' });
    strictEqual(compare([e('a')], { ...fm, review_attempts: JSON.stringify(attempts) }).reason, 'unbound-review:old:no-identity-recorded');
  });

  it('an incomplete history, an unreadable record or a later version is not comparable', () => {
    const fm = record([{ id: 'R', manifest: [e('a')], covered: ['a'] }]);
    const attempts = JSON.parse(fm.review_attempts);
    attempts.coverage = { history_incomplete: true, reasons: ['truncation'], truncated: 1 };
    strictEqual(compare([e('a')], { ...fm, review_attempts: JSON.stringify(attempts) }).reason, 'history-incomplete:truncation');
    strictEqual(compare([e('a')], { ...fm, review_bindings: '{"v":1}' }).reason, 'bindings-unreadable');
    strictEqual(compare([e('a')], { ...fm, review_bindings: JSON.stringify({ ...JSON.parse(fm.review_bindings), v: 2 }) }).reason, 'bindings-later-version');
  });

  it('a path answered by a review that cannot answer for this change is not comparable', () => {
    // D covered b on another branch; F, a full review on this branch, lifts D
    // and shows b without covering it, so D's answer on b stands.
    const fm = record([
      { id: 'D', manifest: [e('a'), e('b')], covered: ['a', 'b'], branch: 'dev' },
      { id: 'F', manifest: [e('a')], covered: ['a'], shown: ['a', 'b'] },
    ]);
    strictEqual(compare([e('a')], fm).reason, 'answer-unusable:b:D:other-landing-branch:dev');
  });

  it('the record is bounded by the paths: past its cap it is truncated, and the change is not comparable', () => {
    ok(LIB.REVIEW_BINDINGS_MAX_BYTES * 1.25 < 256 * 1024);
    // A real change: 100 paths, reviewed on fifteen different trees, fits.
    const paths = Array.from({ length: 100 }, (_, i) => `plugins/some-plugin/scripts/lib/a-module-with-a-long-name-${String(i).padStart(3, '0')}.mjs`);
    const hex = (n) => n.toString(16).padStart(40, '0');
    const manifestOf = (tree) => paths.map((p, i) => `100644 100644 ${hex(i)} ${hex(1000 * (tree + 1) + i)} M\t${p}`);
    const many = record(Array.from({ length: 15 }, (_, i) => ({ id: `r${i}`, manifest: manifestOf(i), covered: paths })));
    strictEqual(LIB.decodeReviewBindings(many.review_bindings).doc.truncated, undefined);
    strictEqual(compare(manifestOf(14), many).state, 'same');
    strictEqual(compare(manifestOf(13), many).state, 'different');
    // A change too large for the cap.
    const big = record([{ id: 'R', manifest: manifestOf(0), covered: paths }], { maxBytes: 4000 });
    strictEqual(LIB.decodeReviewBindings(big.review_bindings).doc.truncated, true);
    strictEqual(compare(manifestOf(0), big).reason, 'bindings-truncated');
    // Comparisons stay bounded, and survive a truncation.
    let raw = big.review_bindings;
    for (let i = 0; i < LIB.REVIEW_COMPARISONS_MAX + 5; i += 1) raw = LIB.applyCommittedComparison(raw, `c${i}`, { state: 'same', manifest_sha256: 'a'.repeat(64), at: '2026-11-07T00:00:00Z' }).raw;
    const doc = LIB.decodeReviewBindings(raw).doc;
    deepStrictEqual([Object.keys(doc.comparisons).length, Boolean(doc.comparisons[`c${LIB.REVIEW_COMPARISONS_MAX + 4}`]), doc.comparisons.c0], [LIB.REVIEW_COMPARISONS_MAX, true, undefined]);
  });

  it('a failure the record shows to be of another change is passed over; one it cannot show stays read', () => {
    const change = [e('a')];
    const fm = record([
      { id: 'P', manifest: [e('a')], covered: ['a'] },
      { id: 'X', outcome: 'failed', manifest: [e('a', 'c')], covered: ['a'] },
    ]);
    deepStrictEqual([...LIB.attemptsOfOtherChange(fm, change, { branch: 'main', objectFormat: 'sha1' })], ['X']);
    // It saw the change's own entry: it stays read.
    deepStrictEqual([...LIB.attemptsOfOtherChange(fm, [e('a', 'c')], { branch: 'main', objectFormat: 'sha1' })], []);
    // A path the change does not touch says nothing (an untracked file the snapshot held).
    const extra = record([{ id: 'X', outcome: 'failed', manifest: [e('a'), e('untracked')], covered: ['a', 'untracked'] }]);
    deepStrictEqual([...LIB.attemptsOfOtherChange(extra, change, { branch: 'main', objectFormat: 'sha1' })], []);
    // Another branch, or no identity: nothing shows it.
    for (const over of [{ branch: 'dev' }, { identity: null, reason: 'snapshot-changed' }]) {
      const fm2 = record([{ id: 'X', outcome: 'failed', manifest: [e('a', 'c')], covered: ['a'], ...over }]);
      deepStrictEqual([...LIB.attemptsOfOtherChange(fm2, change, { branch: 'main', objectFormat: 'sha1' })], [], JSON.stringify(over));
    }
    // A later failure covering the same path replaces the earlier one's evidence there.
    const two = record([
      { id: 'X1', outcome: 'failed', manifest: [e('a', 'c')], covered: ['a'] },
      { id: 'X2', outcome: 'failed', manifest: [e('a', 'd')], covered: ['a'] },
    ]);
    deepStrictEqual([...LIB.attemptsOfOtherChange(two, change, { branch: 'main', objectFormat: 'sha1' })], ['X2']);
  });

  it('a file name with a line break does not make two manifests one digest', () => {
    const one = '100644 100644 a b A\tx';
    const two = '100644 100644 c d A\ty';
    ok(LIB.manifestDigest([one, two]) !== LIB.manifestDigest([`${one}\n${two}`]));
  });

  it('a malformed record is unreadable: an unknown field, an answer naming no attempt, a state no comparison has', () => {
    const fm = record([{ id: 'R', manifest: [e('a')], covered: ['a'] }]);
    const doc = JSON.parse(fm.review_bindings);
    strictEqual(LIB.decodeReviewBindings(JSON.stringify(doc)).state, 'ok');
    match(LIB.decodeReviewBindings(JSON.stringify({ ...doc, manifests: {} })).diagnostic, /unknown field/);
    match(LIB.decodeReviewBindings(JSON.stringify({ ...doc, answers: { a: [e('a'), 'constructor'] } })).diagnostic, /names an attempt the document does not hold/);
    match(LIB.decodeReviewBindings(JSON.stringify({ ...doc, answers: { a: [e('b'), 'R'] } })).diagnostic, /an entry of another path/);
    match(LIB.decodeReviewBindings(JSON.stringify({ ...doc, comparisons: { c: { state: 'bogus' } } })).diagnostic, /state is not a comparison's/);
  });
});

describe('Phase 7 compares the change with its reviews (ADR-0069 Decision 3)', () => {
  it('an unchanged change commits, and records the comparison keyed by its commit', async () => {
    await withRepo(async (dir, root) => {
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await review(dir, wf, 'r1');
      const plan = JSON.parse(phase7(dir, wf, 'plan').stdout);
      deepStrictEqual([plan.review_binding.state, plan.review_binding.held, plan.review_binding.hold], ['same', false, null]);
      // The plan takes the branch to land on as execute does (critique of
      // 2026-11-07, MINOR): one with no ref proves nothing.
      const elsewhere = JSON.parse(phase7(dir, wf, 'plan', ['--landing-branch', 'release']).stdout);
      deepStrictEqual([elsewhere.review_binding.state, elsewhere.review_binding.reason], ['not-comparable', 'no-landing-ref']);
      const r = phase7(dir, wf, 'autopilot', ['--subject-file', await subject(root)], AUTOPILOT);
      strictEqual(r.code, 0, r.stderr);
      const rec = (await comparisons(wf))[headOf(dir)];
      deepStrictEqual([rec.state, rec.branch, rec.manifest_sha256.length], ['same', 'main', 64]);
    });
  });

  it('an edit after review: the plan says so, autopilot refuses (exit 10) and interactive refuses, nothing written', async () => {
    await withRepo(async (dir, root) => {
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await review(dir, wf, 'r1');
      await writeFile(join(dir, 'pkgA', 'x'), 'x1 \n'); // one byte, whitespace
      const plan = JSON.parse(phase7(dir, wf, 'plan').stdout);
      deepStrictEqual([plan.review_binding.state, plan.review_binding.paths], ['different', ['pkgA/x']]);
      match(plan.review_binding.hold, /critique/);
      const before = headOf(dir);
      const text = await readFile(wf, 'utf8');
      const auto = phase7(dir, wf, 'autopilot', ['--subject-file', await subject(root)], AUTOPILOT);
      strictEqual(auto.code, 10, auto.stderr);
      match(auto.stderr, /not the one reviewed.*pkgA\/x/);
      const inter = phase7(dir, wf, 'execute', ['--subject-file', await subject(root)]);
      strictEqual(inter.code, 10, inter.stderr);
      match(inter.stderr, /Recommended action: \/engineer:critique/);
      strictEqual(headOf(dir), before);
      strictEqual(await readFile(wf, 'utf8'), text);
    });
  });

  it('a new review of the change as it is lets it', async () => {
    await withRepo(async (dir, root) => {
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await review(dir, wf, 'r1');
      await writeFile(join(dir, 'pkgA', 'x'), 'x2\n');
      await review(dir, wf, 'r2');
      strictEqual((await check(dir, wf)).state, 'same');
      strictEqual(phase7(dir, wf, 'autopilot', ['--subject-file', await subject(root)], AUTOPILOT).code, 0);
    });
  });

  it('a clean rebase onto a main that moved other files is the same change; a main that edited a touched file is not', async () => {
    await withRepo(async (dir, root) => {
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await review(dir, wf, 'r1');
      strictEqual(phase7(dir, wf, 'execute', ['--subject-file', await subject(root)]).code, 0);
      // main moves on another path; the branch is rebased onto it.
      git(dir, 'switch', '-q', 'main');
      await writeFile(join(dir, 'other'), 'o1\n');
      git(dir, 'commit', '-qam', 'chore: other', '--no-verify');
      git(dir, 'push', '-q', 'origin', 'main');
      git(dir, 'switch', '-q', 'feat/s');
      git(dir, 'rebase', '-q', 'main');
      strictEqual((await check(dir, wf, [])).state, 'same');
      // main edits the touched file itself: the before-object moved.
      git(dir, 'switch', '-q', 'main');
      await writeFile(join(dir, 'pkgB', 'y'), 'y1\n');
      await writeFile(join(dir, 'pkgA', 'x'), 'x0\nmain\n');
      git(dir, 'commit', '-qam', 'chore: touched', '--no-verify');
      git(dir, 'push', '-q', 'origin', 'main');
      git(dir, 'switch', '-q', 'feat/s');
      strictEqual(spawnSync('git', ['rebase', '-q', '-X', 'theirs', 'main'], { cwd: dir, env: env() }).status, 0);
      const c = await check(dir, wf, []);
      deepStrictEqual([c.state, c.failures.map((f) => f.path)], ['different', ['pkgA/x']]);
    });
  });

  it('a review of a different change does not vouch; its attempt no longer holds the commit by outcome', async () => {
    await withRepo(async (dir, root) => {
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await review(dir, wf, 'r1');
      // A later review of another change fails, and the change goes back to
      // the one passed. Conservatively the failure, listed last, holds.
      await writeFile(join(dir, 'pkgA', 'x'), 'other change\n');
      await review(dir, wf, 'r2', { outcome: 'failed' });
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      strictEqual((await S.reviewGateCheck({ workflowPath: wf, repoRoot: dir })).held, true);
      // The comparison reads r1; narrowed to the change, r2 is of another one.
      const c = await check(dir, wf);
      deepStrictEqual([c.state, c.other_change_attempts], ['same', ['r2']]);
      const narrowed = await S.reviewGateCheck({ workflowPath: wf, repoRoot: dir, binding: c });
      deepStrictEqual([narrowed.latest.id, narrowed.held], ['r1', false]);
      // A failure of this very change still holds.
      await review(dir, wf, 'r3', { outcome: 'failed' });
      const c2 = await check(dir, wf);
      const same = await S.reviewGateCheck({ workflowPath: wf, repoRoot: dir, binding: c2 });
      deepStrictEqual([same.latest.id, same.held], ['r3', true]);
      strictEqual(phase7(dir, wf, 'autopilot', ['--subject-file', await subject(root)], AUTOPILOT).code, 10);
    });
  });

  // Critique of 2026-11-07, CRITICAL 1: the narrowing read `no-reviews` as a
  // comparison, and judged "another change" by the whole manifest's digest.
  it('a failure no counting review answers keeps holding: an edit after it, an untracked file, a scoped pass before it', async () => {
    await withRepo(async (dir, root) => {
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await review(dir, wf, 'r1', { outcome: 'failed' });
      // Held as A1b holds it.
      strictEqual(phase7(dir, wf, 'autopilot', ['--subject-file', await subject(root)], AUTOPILOT).code, 10);
      // A one-byte edit after the failure: no review counts, so nothing narrows.
      await writeFile(join(dir, 'pkgA', 'x'), 'x1 \n');
      const edited = await check(dir, wf);
      deepStrictEqual([edited.state, edited.other_change_attempts], ['no-reviews', null]);
      strictEqual((await S.reviewGateCheck({ workflowPath: wf, repoRoot: dir, binding: edited })).held, true);
      const before = headOf(dir);
      const auto = phase7(dir, wf, 'autopilot', ['--subject-file', await subject(root)], AUTOPILOT);
      strictEqual(auto.code, 10, auto.stderr);
      strictEqual(headOf(dir), before);
    });
    await withRepo(async (dir, root) => {
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await writeFile(join(dir, 'scratch'), 'not committed\n');
      await review(dir, wf, 'r1', { outcome: 'failed' });
      // The review's snapshot holds `scratch`, the commit does not: the same
      // change on every path the commit touches.
      strictEqual((await S.reviewGateCheck({ workflowPath: wf, repoRoot: dir, binding: await check(dir, wf) })).held, true);
      strictEqual(phase7(dir, wf, 'autopilot', ['--subject-file', await subject(root)], AUTOPILOT).code, 10);
    });
    await withRepo(async (dir) => {
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await writeFile(join(dir, 'scratch'), 'not committed\n');
      await review(dir, wf, 'r1', { covered: ['pkgA/x'] });
      await review(dir, wf, 'r2', { outcome: 'failed' });
      const c = await check(dir, wf);
      deepStrictEqual([c.state, c.other_change_attempts], ['same', []]);
      const gate = await S.reviewGateCheck({ workflowPath: wf, repoRoot: dir, binding: c });
      deepStrictEqual([gate.latest.id, gate.held], ['r2', true]);
    });
  });

  it('a partial multi-package commit claims nothing; its recovery binds the whole series', async () => {
    await withRepo(async (dir, root) => {
      const paths = ['pkgA/x', 'pkgB/y'];
      const wf = workflow(dir, paths);
      const id = S.parseWorkflowFile(await readFile(wf, 'utf8')).frontmatter.workflow_id;
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await writeFile(join(dir, 'pkgB', 'y'), 'y1\n');
      await review(dir, wf, 'r1');
      strictEqual((await check(dir, wf, paths)).state, 'same');
      // The series stops after its first commit: what is committed so far is
      // not the change reviewed, and no comparison is recorded for it.
      git(dir, 'add', 'pkgA/x');
      git(dir, 'commit', '-qm', `fix(pkgA): x\n\nWorkflow-ID: ${id}`, '--no-verify');
      const partial = headOf(dir);
      deepStrictEqual((await check(dir, wf, [])).failures.map((f) => f.path), ['pkgB/y']);
      strictEqual((await check(dir, wf, paths)).state, 'same');
      strictEqual(S.parseWorkflowFile(await readFile(wf, 'utf8')).frontmatter.review_bindings.includes(partial), false);
      // Recovery: the rest committed by hand with its trailer, then Phase 7's
      // recovery path records the comparison of the whole for its last commit.
      git(dir, 'add', 'pkgB/y');
      git(dir, 'commit', '-qm', `fix(pkgB): y\n\nWorkflow-ID: ${id}`, '--no-verify');
      const r = phase7(dir, wf, 'autopilot', [], AUTOPILOT);
      strictEqual(r.code, 0, r.stderr);
      const rec = (await comparisons(wf))[headOf(dir)];
      strictEqual(rec.state, 'same');
    });
  });

  it('the recovery of a commit that is not the change reviewed is refused too, interactively, and nothing is written', async () => {
    await withRepo(async (dir) => {
      const wf = workflow(dir);
      const id = S.parseWorkflowFile(await readFile(wf, 'utf8')).frontmatter.workflow_id;
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await review(dir, wf, 'r1');
      await writeFile(join(dir, 'pkgA', 'x'), 'x2 by hand\n');
      git(dir, 'add', 'pkgA/x');
      git(dir, 'commit', '-qm', `fix(pkgA): x\n\nWorkflow-ID: ${id}`, '--no-verify');
      const before = await readFile(wf, 'utf8');
      const r = phase7(dir, wf, 'execute');
      strictEqual(r.code, 10, r.stderr);
      match(r.stderr, /not the one reviewed/);
      strictEqual(await readFile(wf, 'utf8'), before);
    });
  });

  it("with no base resolved, another workflow's commit on the branch makes it not comparable; alone it reads no-reviews", async () => {
    await withRepo(async (dir) => {
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      git(dir, 'remote', 'set-head', 'origin', '--delete');
      strictEqual((await check(dir, wf)).state, 'no-reviews');
      git(dir, 'add', 'pkgA/x');
      git(dir, 'commit', '-qm', 'fix: x\n\nWorkflow-ID: compose-20261107T000000Z-eeeeee', '--no-verify');
      const c = await check(dir, wf, []);
      deepStrictEqual([c.state, c.reason], ['not-comparable', 'no-landing-branch']);
    });
  });

  it('the projection keeps a staged mode core.filemode cannot read: admission sees the commit as it will be', async () => {
    await withRepo(async (dir, root) => {
      git(dir, 'config', 'core.filemode', 'false');
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await review(dir, wf, 'r1');
      git(dir, 'update-index', '--chmod=+x', 'pkgA/x');
      const c = await check(dir, wf);
      deepStrictEqual([c.state, c.failures.map((f) => f.path)], ['different', ['pkgA/x']]);
      strictEqual(phase7(dir, wf, 'execute', ['--subject-file', await subject(root)]).code, 10);
    });
  });

  it("a commit with an extra path: the refusal names it, and the owner's acceptance is of that change", async () => {
    await withRepo(async (dir, root) => {
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await review(dir, wf, 'r1');
      await writeFile(join(dir, 'other'), 'an extra\n');
      const refused = phase7(dir, wf, 'execute', ['--subject-file', await subject(root), '--include-extra', 'other', '--confirm-non-interactive']);
      strictEqual(refused.code, 10, refused.stderr);
      match(refused.stderr, /review-binding-accept --workflow-path \S+ --include-extra other --note-file/);
      const nothing = spawnSync('node', [STATE_BIN, 'review-binding-accept', '--workflow-path', wf, '--repo-root', dir], { cwd: dir, encoding: 'utf8', env: env() });
      strictEqual(nothing.status, 1);
      const accepted = spawnSync('node', [STATE_BIN, 'review-binding-accept', '--workflow-path', wf, '--repo-root', dir, '--include-extra', 'other'], { cwd: dir, encoding: 'utf8', env: env() });
      strictEqual(accepted.status, 0, accepted.stderr);
      const r = phase7(dir, wf, 'execute', ['--subject-file', await subject(root), '--include-extra', 'other', '--confirm-non-interactive']);
      strictEqual(r.code, 0, r.stderr);
    });
  });

  it('a partial series whose reviewed package is left out is refused before its first commit', async () => {
    await withRepo(async (dir, root) => {
      const wf = workflow(dir, ['pkgA/x']);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await writeFile(join(dir, 'pkgB', 'y'), 'y1\n'); // reviewed, and outside the manifest
      await review(dir, wf, 'r1');
      const c = await check(dir, wf);
      deepStrictEqual([c.state, c.failures.map((f) => f.path)], ['different', ['pkgB/y']]);
      const r = phase7(dir, wf, 'execute', ['--subject-file', await subject(root), '--confirm-non-interactive']);
      strictEqual(r.code, 10, r.stderr);
    });
  });

  it('an old record (no identity) reads unbound, never matching: autopilot refuses, interactive warns and commits', async () => {
    await withRepo(async (dir, root) => {
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await S.recordReviewAttempt({
        workflowPath: wf,
        env: env(),
        attempt: { id: 'old', phase: 'critique', type: 'review', state: 'closed', outcome: 'passed', run_id: 'old', tree: null, tree_reason: 'no-snapshot' },
      });
      const c = await check(dir, wf);
      deepStrictEqual([c.state, c.held], ['not-comparable', true]);
      match(c.reason, /unbound-review:old:no-identity-recorded/);
      const before = headOf(dir);
      const auto = phase7(dir, wf, 'autopilot', ['--subject-file', await subject(root)], AUTOPILOT);
      strictEqual(auto.code, 10);
      strictEqual(headOf(dir), before);
      const inter = phase7(dir, wf, 'execute', ['--subject-file', await subject(root)]);
      strictEqual(inter.code, 0, inter.stderr);
      match(inter.stderr, /review binding: the change cannot be compared/);
      strictEqual((await comparisons(wf))[headOf(dir)].state, 'not-comparable');
    });
  });

  it('a commit in the interval naming no workflow makes it not comparable, whatever the reviews say', async () => {
    await withRepo(async (dir) => {
      const wf = workflow(dir);
      await writeFile(join(dir, 'other'), 'by hand\n');
      git(dir, 'commit', '-qam', 'chore: by hand', '--no-verify');
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await review(dir, wf, 'r1');
      const c = await check(dir, wf);
      deepStrictEqual([c.state, /^commit-without-workflow:/.test(c.reason)], ['not-comparable', true]);
    });
  });

  // The owner's instruction of 2026-11-09: the committing workflow's reviews
  // alone are read, and an interval holding another workflow's commit claims
  // nothing.
  it('a commit of another workflow in the interval makes it not comparable; its reviews are not read', async () => {
    await withRepo(async (dir, root) => {
      const w1 = workflow(dir, ['pkgA/x']);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await review(dir, w1, 'r1');
      strictEqual(phase7(dir, w1, 'execute', ['--subject-file', await subject(root)]).code, 0);
      const id1 = S.parseWorkflowFile(await readFile(w1, 'utf8')).frontmatter.workflow_id;
      const c = CI.compareCommitted({
        repoRoot: dir,
        frontmatter: { workflow_id: 'compose-20261107T000000Z-bbbbbb', review_attempts: JSON.stringify({ v: 1, attempts: [], coverage: { history_incomplete: false, reasons: [] } }) },
        refresh: false,
      });
      deepStrictEqual([c.state, c.reason], ['not-comparable', `commit-of-other-workflow:${headOf(dir).slice(0, 12)}:${id1}`]);
      // Its own commits are its own.
      strictEqual(CI.compareCommitted({ repoRoot: dir, frontmatter: S.parseWorkflowFile(await readFile(w1, 'utf8')).frontmatter, refresh: false }).state, 'same');
    });
  });

  it("the owner's acceptance lets the change, for this change only; under autopilot it is refused", async () => {
    await withRepo(async (dir, root) => {
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await review(dir, wf, 'r1');
      await writeFile(join(dir, 'pkgA', 'x'), 'x2\n');
      const note = join(root, 'note.txt');
      await writeFile(note, 'the owner read the edit\n');
      const refused = spawnSync('node', [STATE_BIN, 'review-binding-accept', '--workflow-path', wf, '--repo-root', dir], { cwd: dir, encoding: 'utf8', env: env(AUTOPILOT) });
      strictEqual(refused.status, 1);
      match(refused.stderr, /only the owner accepts/);
      const ok1 = spawnSync('node', [STATE_BIN, 'review-binding-accept', '--workflow-path', wf, '--repo-root', dir, '--note-file', note], { cwd: dir, encoding: 'utf8', env: env() });
      strictEqual(ok1.status, 0, ok1.stderr);
      const c = await check(dir, wf);
      deepStrictEqual([c.state, c.accepted, c.held], ['different', true, false]);
      // An edit makes it stale.
      await writeFile(join(dir, 'pkgA', 'x'), 'x3\n');
      const moved = await check(dir, wf);
      deepStrictEqual([moved.accepted, moved.held], [false, true]);
      await writeFile(join(dir, 'pkgA', 'x'), 'x2\n');
      strictEqual(phase7(dir, wf, 'autopilot', ['--subject-file', await subject(root)], AUTOPILOT).code, 0);
    });
  });

  // Critique of 2026-11-07, MAJOR 5.
  it('a merge of the branch to land on into the branch names no workflow and is left out; a merge of anything else is not', async () => {
    await withRepo(async (dir, root) => {
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await review(dir, wf, 'r1');
      strictEqual(phase7(dir, wf, 'execute', ['--subject-file', await subject(root)]).code, 0);
      // main moves on another path, and is merged into the branch ("Update branch").
      git(dir, 'switch', '-q', 'main');
      await writeFile(join(dir, 'other'), 'o1\n');
      git(dir, 'commit', '-qam', 'chore: other', '--no-verify');
      git(dir, 'push', '-q', 'origin', 'main');
      git(dir, 'switch', '-q', 'feat/s');
      git(dir, 'merge', '-q', '--no-ff', '--no-edit', 'main');
      deepStrictEqual([(await check(dir, wf, [])).state], ['same']);
      // A side branch no one landed, merged in: its commit names this workflow,
      // and only the merge names none, so only the merge makes the interval
      // claim nothing (a side commit with no trailer would refuse it anyway).
      const id = S.parseWorkflowFile(await readFile(wf, 'utf8')).frontmatter.workflow_id;
      git(dir, 'switch', '-q', '-c', 'side', 'main');
      await writeFile(join(dir, 'pkgB', 'y'), 'side\n');
      git(dir, 'commit', '-qam', `chore: side\n\nWorkflow-ID: ${id}`, '--no-verify');
      git(dir, 'switch', '-q', 'feat/s');
      git(dir, 'merge', '-q', '--no-ff', '--no-edit', 'side');
      const c = await check(dir, wf, []);
      deepStrictEqual([c.state, /^commit-without-workflow:/.test(c.reason)], ['not-comparable', true]);
    });
  });

  // Critique of 2026-11-07, MAJOR 9: with no package map the series is one
  // commit, so admission's projection over every commit was never exercised.
  it('a per-package split is judged whole at admission: both packages are projected before the first commit', async () => {
    await withRepo(async (dir) => {
      const paths = ['pkgA/x', 'pkgB/y'];
      const wf = workflow(dir, paths);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await writeFile(join(dir, 'pkgB', 'y'), 'y1\n');
      await review(dir, wf, 'r1');
      const plan = JSON.parse(phase7(dir, wf, 'plan').stdout);
      deepStrictEqual([plan.requires_split, plan.review_binding.state], [true, 'same']);
      const before = headOf(dir);
      const r = phase7(dir, wf, 'execute', ['--suggested-subjects']);
      strictEqual(r.code, 0, r.stderr);
      strictEqual(git(dir, 'rev-list', '--count', `${before}..HEAD`), '2');
      strictEqual((await comparisons(wf))[headOf(dir)].state, 'same');
    }, { packages: true });
  });

  it('a comparison of nothing to accept is refused; so is one with no review', async () => {
    await withRepo(async (dir) => {
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      const r = spawnSync('node', [STATE_BIN, 'review-binding-accept', '--workflow-path', wf, '--repo-root', dir], { cwd: dir, encoding: 'utf8', env: env() });
      strictEqual(r.status, 1);
      match(r.stderr, /compares no-reviews; there is nothing to accept/);
    });
  });

  it('a commit an amend made needs its comparison recorded again, for an archived workflow too', async () => {
    await withRepo(async (dir, root) => {
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await review(dir, wf, 'r1');
      strictEqual(phase7(dir, wf, 'execute', ['--subject-file', await subject(root)]).code, 0);
      const first = headOf(dir);
      git(dir, 'commit', '--amend', '-qm', `${git(dir, 'log', '-1', '--format=%s')} reworded\n\nWorkflow-ID: ${S.parseWorkflowFile(await readFile(wf, 'utf8')).frontmatter.workflow_id}`, '--no-verify');
      const second = headOf(dir);
      ok((await comparisons(wf))[first]);
      strictEqual((await comparisons(wf))[second], undefined);
      const r = spawnSync('node', [STATE_BIN, 'review-binding-record', '--workflow-path', wf, '--repo-root', dir], { cwd: dir, encoding: 'utf8', env: env() });
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await comparisons(wf))[second].state, 'same');
    });
  });

  // Critique of 2026-11-08, MAJOR 1: the projection read no GIT_* variable,
  // while Phase 7's `git add` inherits every one.
  it('a filter only the environment gives git reaches the projection as it reaches the commit', async () => {
    await withRepo(async (dir, root) => {
      const wf = workflow(dir);
      await writeFile(join(dir, '.git', 'info', 'attributes'), 'pkgA/x filter=up\n');
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await review(dir, wf, 'r1');
      // With no filter defined, the change is the one reviewed.
      strictEqual((await check(dir, wf)).state, 'same');
      const up = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'filter.up.clean', GIT_CONFIG_VALUE_0: 'tr a-z A-Z' };
      const before = headOf(dir);
      const auto = phase7(dir, wf, 'autopilot', ['--subject-file', await subject(root)], { ...AUTOPILOT, ...up });
      strictEqual(auto.code, 10, auto.stderr);
      match(auto.stderr, /pkgA\/x \(differs from what r1 reviewed\)/);
      strictEqual(headOf(dir), before);
    });
  });

  // Critique of 2026-11-08, MAJOR 2: the projection staged from disk, where
  // Phase 7 stages with `git add`.
  it('the projection is the tree the commit holds: a staged deletion, a new file, a filtered file, an edit', async () => {
    await withRepo(async (dir, root) => {
      const wf = workflow(dir, ['pkgA/x', 'pkgB/y', 'other', 'new']);
      git(dir, 'config', 'filter.up.clean', 'tr a-z A-Z');
      await writeFile(join(dir, '.git', 'info', 'attributes'), 'other filter=up\n');
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      git(dir, 'rm', '-q', 'pkgB/y');
      await writeFile(join(dir, 'other'), 'lower\n');
      await writeFile(join(dir, 'new'), 'n\n');
      const staging = JSON.parse(phase7(dir, wf, 'plan').stdout).staging_set;
      deepStrictEqual(staging, ['new', 'other', 'pkgA/x', 'pkgB/y']);
      const projected = CI.projectedTree(dir, staging);
      strictEqual(projected.reason, null);
      const r = phase7(dir, wf, 'execute', ['--subject-file', await subject(root, 'fix: the change')]);
      strictEqual(r.code, 0, r.stderr);
      strictEqual(git(dir, 'rev-parse', 'HEAD^{tree}'), projected.tree);
    });
  });

  it('a flagged path is not projected: assume-unchanged or skip-worktree reads not comparable', async () => {
    await withRepo(async (dir, root) => {
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await review(dir, wf, 'r1');
      git(dir, 'add', 'pkgA/x');
      git(dir, 'update-index', '--assume-unchanged', 'pkgA/x');
      deepStrictEqual(CI.projectedTree(dir, ['pkgA/x']), { tree: null, reason: 'index-flags' });
      const c = await check(dir, wf);
      deepStrictEqual([c.state, c.reason, c.held], ['not-comparable', 'index-flags', true]);
      // No key, so no acceptance: the way on is to clear the flag (refine-verify
      // of 2026-11-08, F7).
      const hold = S.reviewBindingHoldText(c, { workflowPath: wf });
      match(hold, /cannot be accepted as it is: clear the assume-unchanged or skip-worktree flag/);
      doesNotMatch(hold, /review-binding-accept/);
      // One flag per call: given together, update-index applies only one.
      git(dir, 'update-index', '--no-assume-unchanged', 'pkgA/x');
      git(dir, 'update-index', '--skip-worktree', 'pkgA/x');
      strictEqual(CI.projectedTree(dir, ['pkgA/x']).reason, 'index-flags');
      // With a failed outcome too, the flag is what autopilot names first: no
      // acceptance can be given until it is cleared (third pass).
      git(dir, 'update-index', '--no-skip-worktree', 'pkgA/x');
      await review(dir, wf, 'r2', { outcome: 'failed' });
      git(dir, 'update-index', '--assume-unchanged', 'pkgA/x');
      const mixed = phase7(dir, wf, 'autopilot', ['--subject-file', await subject(root)], AUTOPILOT);
      strictEqual(mixed.code, 10, mixed.stderr);
      match(mixed.stderr, /cannot be accepted as it is: clear the assume-unchanged/);
      doesNotMatch(mixed.stderr, /review-accept/);
      git(dir, 'update-index', '--no-assume-unchanged', 'pkgA/x');
      await review(dir, wf, 'r3');
      strictEqual((await check(dir, wf)).state, 'same');
    });
  });

  // Critique of 2026-11-08, MAJOR 3: the acceptance projected the manifest's
  // own list, Phase 7 the staging set.
  it('a manifest naming an ignored file: the acceptance and Phase 7 judge the one staging set', async () => {
    await withRepo(async (dir, root) => {
      await writeFile(join(dir, '.git', 'info', 'exclude'), 'dist/\n');
      const wf = workflow(dir, ['pkgA/x', 'dist/out.js']);
      await mkdir(join(dir, 'dist'));
      await writeFile(join(dir, 'dist', 'out.js'), 'built\n');
      // A passed review of the change, a failure of a later edit, then back.
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await review(dir, wf, 'r1');
      await writeFile(join(dir, 'pkgA', 'x'), 'a later edit\n');
      await review(dir, wf, 'r2', { outcome: 'failed' });
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      const c = await check(dir, wf, ['pkgA/x']);
      deepStrictEqual([c.state, c.other_change_attempts], ['same', ['r2']]);
      const plan = JSON.parse(phase7(dir, wf, 'plan').stdout);
      deepStrictEqual([plan.staging_set, plan.review_binding.state, plan.review_hold], [['pkgA/x'], 'same', null]);
      const r = phase7(dir, wf, 'execute', ['--subject-file', await subject(root)]);
      strictEqual(r.code, 0, r.stderr);
      doesNotMatch(r.stderr, /⚠ review/);
    });
    await withRepo(async (dir, root) => {
      await writeFile(join(dir, '.git', 'info', 'exclude'), 'dist/\n');
      const wf = workflow(dir, ['pkgA/x', 'dist/out.js']);
      await mkdir(join(dir, 'dist'));
      await writeFile(join(dir, 'dist', 'out.js'), 'built\n');
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await review(dir, wf, 'r1');
      await writeFile(join(dir, 'pkgA', 'x'), 'x2 after the review\n');
      strictEqual(phase7(dir, wf, 'execute', ['--subject-file', await subject(root)]).code, 10);
      // The owner's acceptance is of the tree Phase 7 commits, so it takes there.
      const accepted = spawnSync('node', [STATE_BIN, 'review-binding-accept', '--workflow-path', wf, '--repo-root', dir], { cwd: dir, encoding: 'utf8', env: env() });
      strictEqual(accepted.status, 0, accepted.stderr);
      const r = phase7(dir, wf, 'execute', ['--subject-file', await subject(root)]);
      strictEqual(r.code, 0, r.stderr);
    });
  });

  // Critique of 2026-11-08, MAJOR 5: the partial series was committed by hand,
  // so nothing showed Phase 7's own series records nothing part way.
  it("Phase 7's own series stopped part way records no comparison; its rerun records the whole", async () => {
    await withRepo(async (dir) => {
      const wf = workflow(dir, ['pkgA/x', 'pkgB/y']);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await writeFile(join(dir, 'pkgB', 'y'), 'y1\n');
      await review(dir, wf, 'r1');
      // A hook refuses the split's second commit, pkgB's.
      const hook = join(dir, '.git', 'hooks', 'pre-commit');
      await writeFile(hook, '#!/bin/sh\ngit diff --cached --name-only | grep -q "^pkgB/" && exit 1\nexit 0\n');
      await chmod(hook, 0o755);
      const before = headOf(dir);
      const stopped = phase7(dir, wf, 'execute', ['--suggested-subjects']);
      notStrictEqual(stopped.code, 0);
      strictEqual(git(dir, 'rev-list', '--count', `${before}..HEAD`), '1');
      strictEqual((await comparisons(wf))?.[headOf(dir)], undefined);
      await rm(hook);
      const again = phase7(dir, wf, 'execute', ['--suggested-subjects']);
      strictEqual(again.code, 0, again.stderr);
      strictEqual(git(dir, 'rev-list', '--count', `${before}..HEAD`), '2');
      strictEqual((await comparisons(wf))[headOf(dir)].state, 'same');
    }, { packages: true });
  });

  // Refine-verify of 2026-11-08: the projection's `add --force` for a
  // submodule had no test that a move under ignore=all reaches it.
  it('a submodule set to ignore=all: the projection stages its move as Phase 7 does', async () => {
    await withRepo(async (dir, root) => {
      const mod = join(dir, 'mod');
      execFileSync('git', ['init', '-q', '-b', 'main', mod], { env: env() });
      for (const [k, v] of [['user.name', 'mod'], ['user.email', 'mod@example.invalid'], ['commit.gpgsign', 'false']]) git(mod, 'config', k, v);
      await writeFile(join(mod, 'f'), '1\n');
      git(mod, 'add', 'f');
      git(mod, 'commit', '-qm', 'one', '--no-verify');
      const one = headOf(mod);
      await writeFile(join(mod, 'f'), '2\n');
      git(mod, 'commit', '-qam', 'two', '--no-verify');
      const two = headOf(mod);
      git(mod, 'checkout', '-q', one);
      await writeFile(join(dir, '.gitmodules'), '[submodule "mod"]\n\tpath = mod\n\turl = ./mod\n\tignore = all\n');
      git(dir, 'update-index', '--add', '--cacheinfo', `160000,${one},mod`);
      git(dir, 'add', '.gitmodules');
      git(dir, 'commit', '-qm', 'chore: the submodule', '--no-verify');
      git(mod, 'checkout', '-q', two);
      const wf = workflow(dir, ['mod']);
      const staging = JSON.parse(phase7(dir, wf, 'plan').stdout).staging_set;
      deepStrictEqual(staging, ['mod']);
      const projected = CI.projectedTree(dir, staging);
      const r = phase7(dir, wf, 'execute', ['--subject-file', await subject(root, 'fix: move the submodule')]);
      strictEqual(r.code, 0, r.stderr);
      strictEqual(git(dir, 'rev-parse', 'HEAD:mod'), two);
      strictEqual(git(dir, 'rev-parse', 'HEAD^{tree}'), projected.tree);
    });
  });

  // Refine-verify of 2026-11-08, F3: an inherited GIT_DIR / GIT_WORK_TREE made
  // Phase 7 commit in another repository than the one compared.
  it('a repository the environment selects that is not the checkout reads not comparable: nothing is committed anywhere', async () => {
    await withRepo(async (dir, root) => {
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await review(dir, wf, 'r1');
      const other = join(root, 'other');
      execFileSync('git', ['clone', '-q', '--shared', dir, other], { env: env() });
      for (const [k, v] of [['user.name', 'o'], ['user.email', 'o@example.invalid'], ['commit.gpgsign', 'false']]) git(other, 'config', k, v);
      git(other, 'switch', '-q', 'feat/s');
      await writeFile(join(other, 'pkgA', 'x'), 'x1\n');
      const [mine, theirs] = [headOf(dir), headOf(other)];
      const elsewhere = { GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other };
      const auto = phase7(dir, wf, 'autopilot', ['--subject-file', await subject(root)], { ...AUTOPILOT, ...elsewhere });
      strictEqual(auto.code, 10, auto.stderr);
      match(auto.stderr, /repository-mismatch/);
      deepStrictEqual([headOf(dir), headOf(other)], [mine, theirs]);
      // Interactively too: no review question, so no warning that commits
      // (refine-verify of 2026-11-08, second pass).
      const inter = phase7(dir, wf, 'execute', ['--subject-file', await subject(root)], elsewhere);
      strictEqual(inter.code, 10, inter.stderr);
      match(inter.stderr, /unset the GIT_DIR or GIT_WORK_TREE/);
      deepStrictEqual([headOf(dir), headOf(other)], [mine, theirs]);
      // A checkout named by a relative path is the checkout (refine-verify of
      // 2026-11-08, third pass). Named from its parent, as `work`, so a path
      // applied twice (`root/work/work`) is never the checkout: a path relative
      // to this process's cwd lands on the checkout again whenever that cwd and
      // the checkout sit at one depth under one parent (the mutation harness's
      // copy beside the temporary repository, refine-verify of 2026-11-08,
      // fourth pass: P29 survived).
      const fromParent = spawnSync('node', ['--input-type=module', '-e',
        "const CI = await import(process.argv[1]); process.stdout.write(JSON.stringify(CI.projectedTree('work', ['pkgA/x'])));",
        pathToFileURL(P.path('scripts/lib/change-identity.mjs')).href,
      ], { cwd: root, encoding: 'utf8', env: env() });
      strictEqual(fromParent.status, 0, fromParent.stderr);
      const relProjected = JSON.parse(fromParent.stdout);
      strictEqual(relProjected.reason, null);
      strictEqual(relProjected.tree, CI.projectedTree(dir, ['pkgA/x']).tree);
      // A work tree alone that is not the checkout's is the same mismatch.
      const tree = JSON.parse(phase7(dir, wf, 'plan', [], { GIT_WORK_TREE: other }).stdout).review_binding;
      deepStrictEqual([tree.state, tree.reason], ['not-comparable', 'repository-mismatch']);
      // The checkout's own repository, selected under another spelling of its
      // path, is no mismatch (a case-insensitive filesystem, measured on macOS).
      const upper = join(root, 'WORK');
      if (existsSync(upper)) {
        Object.assign(process.env, { GIT_DIR: join(upper, '.git'), GIT_WORK_TREE: upper });
        try {
          strictEqual(CI.projectedTree(dir, ['pkgA/x']).reason, null);
        } finally {
          delete process.env.GIT_DIR;
          delete process.env.GIT_WORK_TREE;
        }
      }
    });
  });

});

// The owner's instruction of 2026-11-09: what landed is compared with what the
// child workflow committed, by the manifests, and no review is read again.
describe('the landed comparison (ADR-0069 Decision 2)', () => {
  const landed = (dir, start, commit, head, child = null) => {
    const r = spawnSync('node', [STATE_BIN, 'review-compare-landed', '--repo-root', dir, '--commit', commit, '--integration-branch', 'main',
      ...(start ? ['--start', start] : []), ...(head ? ['--head', head] : []), ...(child ? ['--child-workflow', child] : [])], { cwd: dir, encoding: 'utf8', env: env() });
    strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  async function committed(dir, root) {
    const wf = workflow(dir);
    await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
    await review(dir, wf, 'r1');
    strictEqual(phase7(dir, wf, 'execute', ['--subject-file', await subject(root)]).code, 0);
    return { wf, head: headOf(dir), id: S.parseWorkflowFile(await readFile(wf, 'utf8')).frontmatter.workflow_id };
  }
  const squash = async (dir, message = 'fix(pkgA): squash') => {
    git(dir, 'switch', '-q', 'main');
    const start = headOf(dir);
    git(dir, 'merge', '-q', '--squash', 'feat/s');
    git(dir, 'commit', '-qm', message, '--no-verify');
    return { start, commit: headOf(dir) };
  };

  it('a squash that holds what was committed reads what the commit read; the trailer is gone from main', async () => {
    await withRepo(async (dir, root) => {
      const { head, id } = await committed(dir, root);
      const { start, commit } = await squash(dir);
      strictEqual(landed(dir, start, commit, head, id).state, 'same');
    });
  });

  it('what landed differs from what was committed: different, naming the path', async () => {
    await withRepo(async (dir, root) => {
      const { head, id } = await committed(dir, root);
      git(dir, 'switch', '-q', 'main');
      const start = headOf(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'an edit after the review\n');
      git(dir, 'commit', '-qam', 'fix: landed something else', '--no-verify');
      const out = landed(dir, start, headOf(dir), head, id);
      deepStrictEqual([out.state, out.failures.map((f) => [f.path, f.why])], ['different', [['pkgA/x', 'landed']]]);
    });
  });

  it('a rebased series compares from its start, so the earlier package is seen', async () => {
    await withRepo(async (dir, root) => {
      const paths = ['pkgA/x', 'pkgB/y'];
      const wf = workflow(dir, paths);
      const id = S.parseWorkflowFile(await readFile(wf, 'utf8')).frontmatter.workflow_id;
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await writeFile(join(dir, 'pkgB', 'y'), 'y1\n');
      await review(dir, wf, 'r1');
      git(dir, 'add', 'pkgA/x');
      git(dir, 'commit', '-qm', `fix(pkgA): x\n\nWorkflow-ID: ${id}`, '--no-verify');
      git(dir, 'add', 'pkgB/y');
      git(dir, 'commit', '-qm', `fix(pkgB): y\n\nWorkflow-ID: ${id}`, '--no-verify');
      strictEqual(phase7(dir, wf, 'execute').code, 0);
      const head = headOf(dir);
      const start = git(dir, 'rev-parse', 'main');
      git(dir, 'switch', '-q', 'main');
      git(dir, 'merge', '-q', '--ff-only', 'feat/s');
      strictEqual(landed(dir, start, headOf(dir), head, id).state, 'same');
      // Comparing the last commit alone misses the earlier package.
      const lastOnly = landed(dir, `${headOf(dir)}~1`, headOf(dir), head, id);
      deepStrictEqual([lastOnly.state, lastOnly.failures.map((f) => f.path)], ['different', ['pkgA/x']]);
    });
  });

  it('with no evidence of the start, no head, no child, or no comparison recorded for the head, it is not comparable', async () => {
    await withRepo(async (dir, root) => {
      const { head, id } = await committed(dir, root);
      const { start, commit } = await squash(dir);
      deepStrictEqual([landed(dir, null, commit, head, id).state, landed(dir, null, commit, head, id).reason], ['not-comparable', 'no-landing-evidence']);
      strictEqual(landed(dir, start, commit, null, id).reason, 'no-head-commit');
      strictEqual(landed(dir, start, commit, head).reason, 'no-child-workflow');
      strictEqual(landed(dir, start, commit, head, 'compose-20261107T000000Z-ffffff').reason, 'workflow-not-found:compose-20261107T000000Z-ffffff');
      match(landed(dir, start, commit, start, id).reason, /^no-committed-comparison:/);
    });
  });

  it('a commit that was not comparable is still not comparable once landed, with the reason', async () => {
    await withRepo(async (dir, root) => {
      await writeFile(join(dir, 'other'), 'by hand\n');
      git(dir, 'commit', '-qam', 'chore: by hand', '--no-verify');
      const { head, id } = await committed(dir, root);
      const { start, commit } = await squash(dir);
      const out = landed(dir, start, commit, head, id);
      deepStrictEqual([out.state, /^committed-not-comparable:commit-without-workflow:/.test(out.reason)], ['not-comparable', true]);
    });
  });

  it('a start after the landing is refused: it measures something else', async () => {
    await withRepo(async (dir, root) => {
      const { head, id } = await committed(dir, root);
      const { commit } = await squash(dir);
      git(dir, 'commit', '-q', '--allow-empty', '-m', 'later', '--no-verify');
      strictEqual(landed(dir, headOf(dir), commit, head, id).reason, 'start-not-before-landing');
      strictEqual(landed(dir, commit, commit, head, id).reason, 'start-not-before-landing');
    });
  });

  it('a head whose object is gone is still compared, by the record keyed by its sha', async () => {
    await withRepo(async (dir, root) => {
      const { head, id } = await committed(dir, root);
      const { start, commit } = await squash(dir);
      git(dir, 'branch', '-qD', 'feat/s');
      git(dir, 'reflog', 'expire', '--expire=now', '--all');
      git(dir, 'gc', '-q', '--prune=now');
      strictEqual(spawnSync('git', ['cat-file', '-e', head], { cwd: dir }).status === 0, false);
      strictEqual(landed(dir, start, commit, head, id).state, 'same');
    });
  });

  // Refine-verify of 2026-11-09: a commit Phase 7 found different after it
  // must not land as merely not comparable, unless the owner accepted it.
  it('a commit recorded different lands different, unless the owner accepted it before its commit', async () => {
    await withRepo(async (dir, root) => {
      const wf = workflow(dir);
      const id = S.parseWorkflowFile(await readFile(wf, 'utf8')).frontmatter.workflow_id;
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await review(dir, wf, 'r1');
      await writeFile(join(dir, 'pkgA', 'x'), 'x2 after the review\n');
      strictEqual(spawnSync('node', [STATE_BIN, 'review-binding-accept', '--workflow-path', wf, '--repo-root', dir], { cwd: dir, encoding: 'utf8', env: env() }).status, 0);
      strictEqual(phase7(dir, wf, 'execute', ['--subject-file', await subject(root)]).code, 0);
      const head = headOf(dir);
      deepStrictEqual([(await comparisons(wf))[head].state, (await comparisons(wf))[head].accepted], ['different', true]);
      const { start, commit } = await squash(dir);
      deepStrictEqual([landed(dir, start, commit, head, id).state, landed(dir, start, commit, head, id).reason], ['not-comparable', 'committed-different']);
      // Not accepted (a pre-commit hook rewrote it): different, naming the path.
      const text = await readFile(wf, 'utf8');
      await writeFile(wf, text.replace(/\\"accepted\\":true/, '\\"accepted\\":false'));
      const out = landed(dir, start, commit, head, id);
      deepStrictEqual([out.state, out.failures.map((x) => x.path)], ['different', ['pkgA/x']]);
    });
  });

  // A commit after Phase 7 (a review-comment fixup, a suggestion, a
  // force-push) has no committed comparison: the landing proves nothing, and
  // done records it with its line.
  it('a head with no committed comparison is not comparable', async () => {
    await withRepo(async (dir, root) => {
      const { id } = await committed(dir, root);
      await writeFile(join(dir, 'pkgA', 'x'), 'a review-comment fixup\n');
      git(dir, 'commit', '-qam', 'fix: review comment', '--no-verify');
      const head = headOf(dir);
      const { start, commit } = await squash(dir);
      deepStrictEqual([landed(dir, start, commit, head, id).state, landed(dir, start, commit, head, id).reason], ['not-comparable', `no-committed-comparison:${head.slice(0, 12)}`]);
    });
  });

  // Critique of 2026-11-08, MAJOR 4: the lookup took the first copy found.
  it('a workflow whose active and archived copies differ is no one workflow: the landing is not comparable', async () => {
    await withRepo(async (dir, root) => {
      const { wf, head, id } = await committed(dir, root);
      const archive = join(dir, '.agentic-plugins/state/engineer/archive');
      await mkdir(archive, { recursive: true });
      const copy = join(archive, `${id}.md`);
      await writeFile(copy, await readFile(wf, 'utf8'));
      // Copies that hold the same bytes are one workflow.
      strictEqual(CI.locateWorkflow(dir, id).file, wf);
      // A later review, of an edit the landing does not hold, recorded on the
      // archived copy alone: the active one would read the same.
      await writeFile(join(dir, 'pkgA', 'x'), 'x2\n');
      await review(dir, copy, 'r2');
      git(dir, 'checkout', '--', 'pkgA/x');
      deepStrictEqual(CI.locateWorkflow(dir, id), { file: null, reason: 'ambiguous' });
      const { start, commit } = await squash(dir);
      const out = landed(dir, start, commit, head, id);
      deepStrictEqual([out.state, out.reason], ['not-comparable', `workflow-ambiguous:${id}`]);
    });
  });

  // Refine-verify of 2026-11-08, F4: an archive that found its name taken
  // writes a suffixed file, which the lookup did not see.
  it('an archived copy under a suffixed name is a copy too', async () => {
    await withRepo(async (dir, root) => {
      const { wf, head, id } = await committed(dir, root);
      const archive = join(dir, '.agentic-plugins/state/engineer/archive');
      await mkdir(archive, { recursive: true });
      await writeFile(join(archive, `${id}.md`), await readFile(wf, 'utf8'));
      // The later review, on the copy archived second, under the suffixed name.
      await writeFile(join(dir, 'pkgA', 'x'), 'x2\n');
      await review(dir, wf, 'r2');
      git(dir, 'checkout', '--', 'pkgA/x');
      const suffixed = join(archive, `${id}-20261108T000000Z-abcdef.md`);
      // Its id quoted and escaped, as JSON spells it: the same workflow
      // (refine-verify of 2026-11-08, third pass).
      await writeFile(suffixed, (await readFile(wf, 'utf8')).replace(/^workflow_id: .*$/m, `workflow_id: "\\u0063${id.slice(1)}"`));
      await rm(wf);
      // A file whose name only begins with the id is another workflow's.
      await writeFile(join(archive, `${id}-other.md`), 'not a copy\n');
      // Nor is a workflow's canonical file a copy of a shorter id it begins
      // with: its frontmatter names itself (refine-verify of 2026-11-08, second pass).
      await writeFile(join(archive, 'compose-20261108T000000Z-abcdef.md'), '---\nworkflow_id: compose-20261108T000000Z-abcdef\n---\n');
      deepStrictEqual(CI.locateWorkflow(dir, 'compose'), { file: null, reason: 'not-found' });
      // A home that cannot be read may hold a copy: nothing is claimed. Searchable
      // but not listable (0o300), so the canonical copy is found and only the
      // listing that finds suffixed copies fails.
      if (process.getuid?.() !== 0) {
        await chmod(archive, 0o300);
        try {
          deepStrictEqual(CI.locateWorkflow(dir, id), { file: null, reason: 'unreadable' });
        } finally {
          await chmod(archive, 0o755);
        }
      }
      deepStrictEqual(CI.locateWorkflow(dir, id), { file: null, reason: 'ambiguous' });
      const { start, commit } = await squash(dir);
      const out = landed(dir, start, commit, head, id);
      deepStrictEqual([out.state, out.reason], ['not-comparable', `workflow-ambiguous:${id}`]);
    });
  });

  it('a stale ref on both sides that calls it the same at commit is different once landed', async () => {
    await withRepo(async (dir, root) => {
      // Review and commit against a ref that has not seen main's edit to a touched file.
      const wf = workflow(dir);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      await review(dir, wf, 'r1');
      strictEqual((await check(dir, wf)).state, 'same');
      strictEqual(phase7(dir, wf, 'execute', ['--subject-file', await subject(root)]).code, 0);
      const head = headOf(dir);
      // Another clone moves main on the touched file; this clone has not fetched.
      const other = join(root, 'other-clone');
      execFileSync('git', ['clone', '-q', join(root, 'origin.git'), other], { env: env() });
      git(other, 'config', 'user.name', 'o');
      git(other, 'config', 'user.email', 'o@example.invalid');
      await writeFile(join(other, 'pkgA', 'x'), 'main moved\n');
      git(other, 'commit', '-qam', 'chore: moved', '--no-verify');
      git(other, 'push', '-q', 'origin', 'main');
      // The landing starts from main's real tip, and restores the reviewed content.
      git(dir, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
      const start = git(dir, 'rev-parse', 'origin/main');
      git(dir, 'switch', '-q', '--detach', start);
      await writeFile(join(dir, 'pkgA', 'x'), 'x1\n');
      git(dir, 'commit', '-qam', 'fix: squash', '--no-verify');
      const id = S.parseWorkflowFile(await readFile(wf, 'utf8')).frontmatter.workflow_id;
      const out = landed(dir, start, headOf(dir), head, id);
      deepStrictEqual([out.state, out.failures.map((f) => f.path)], ['different', ['pkgA/x']]);
    });
  });
});

// Critique of 2026-11-07, MAJOR 7: `${TEXT_DIR:+--subject-file "…"}` is one
// word under zsh, the macOS default shell, so the generated Codex settle of a
// review that never launched failed there with `Unknown argument`.
describe('the Codex settle of a review that never launched', () => {
  it('passes the subject file as words of its own, with no expansion zsh leaves joined', async () => {
    const checked = [];
    for (const persona of ['engineer', 'founder', 'designer']) {
      for (const verb of ['compose', 'critique', 'refine']) {
        const file = resolve(REPO_ROOT, 'plugins', persona, 'core/skills', verb, 'SKILL.md');
        let text;
        try {
          text = await readFile(file, 'utf8');
        } catch {
          continue;
        }
        const m = new RegExp(`<!-- pipeline:begin ${verb}-review-settle -->([\\s\\S]*?)<!-- pipeline:end ${verb}-review-settle -->`).exec(text);
        if (!m) continue;
        const settle = m[1].slice(m[1].lastIndexOf("--run-id ''"));
        strictEqual(/\$\{[A-Za-z_][A-Za-z0-9_]*:\+/.test(m[1]), false, `${persona} ${verb}: an alternative expansion in the settle block`);
        match(settle, /\n {4}--subject-file "\$TEXT_DIR\/subject\.json" \\\n/, `${persona} ${verb}`);
        checked.push(`${persona}/${verb}`);
      }
    }
    for (const verb of ['compose', 'critique', 'refine']) ok(checked.includes(`engineer/${verb}`), `${checked}`);
  });

  // Critique of 2026-11-08, sixth pass, MAJOR 4: the block reads the subject
  // from TEXT_DIR, and the prose asked for it only beside a launched run's
  // prompt, so no agent following it could make a no-run review bind.
  it("tells the agent to write the subject in TEXT_DIR, where the block reads it", async () => {
    const checked = [];
    for (const persona of ['engineer', 'founder', 'designer']) {
      for (const verb of ['compose', 'critique', 'refine']) {
        let text;
        try {
          text = await readFile(resolve(REPO_ROOT, 'plugins', persona, 'core/skills', verb, 'SKILL.md'), 'utf8');
        } catch {
          continue;
        }
        const m = new RegExp(`<!-- pipeline:begin ${verb}-review-settle -->([\\s\\S]*?)<!-- pipeline:end ${verb}-review-settle -->`).exec(text);
        if (!m) continue;
        const start = m[1].indexOf('- no run launched:');
        ok(start >= 0, `${persona} ${verb}: the no-run bullet`);
        const bullet = m[1].slice(start, m[1].indexOf('\n\n', start));
        match(bullet, /create `subject\.json` in\s+`TEXT_DIR`/, `${persona} ${verb}: the no-run bullet asks for the subject in TEXT_DIR`);
        match(m[1], /--subject-file "\$TEXT_DIR\/subject\.json"/, `${persona} ${verb}: the block reads it there`);
        checked.push(`${persona}/${verb}`);
      }
    }
    for (const verb of ['compose', 'critique', 'refine']) ok(checked.includes(`engineer/${verb}`), `${checked}`);
  });
});

// Refine-verify of the sixth critique's refine: the capture times order the
// reads only if the reads cannot overlap, and an index copy is judged as the
// index only with that index's own timestamps.
