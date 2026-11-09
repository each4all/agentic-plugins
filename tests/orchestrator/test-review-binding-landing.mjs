// tests/orchestrator/test-review-binding-landing.mjs
//
// C163 A2b (ADR-0069) — the completion path and the autopilot policy:
//
//   - `landingEvidence`: where a landing started, from the landing's own
//     evidence, a fake `gh` standing for GitHub's answer;
//   - `resolve-landing` asks the persona how what landed compares;
//   - the policy halts for the owner on a landing that differs; a landing that
//     cannot be compared goes on;
//   - the report keeps a pre-merge comparison apart from a landed mismatch.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isSessionVariable } from '../../scripts/lib/session-env.mjs';

// Run on its own from an agentic session (an autopilot worker's quick check),
// this file would inherit the session (`npm test` clears it first,
// tests/_hermetic-env.mjs): an inherited AGENTIC_AUTOPILOT makes the owner's
// writes refuse and the commit step take the autopilot mode (critique of
// 2026-11-08, sixth pass, MAJOR 5). Cleared here, before the modules load.
for (const name of Object.keys(process.env)) if (isSessionVariable(name)) delete process.env[name];

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP =resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const P = await import(resolve(AP, 'policy.mjs'));
const O = await import(resolve(AP, 'observe.mjs'));
const L = await import(resolve(REPO_ROOT, 'plugins/orchestrator/scripts/landing.mjs'));
const ENGINEER = resolve(REPO_ROOT, 'plugins/engineer');
const STATE_MJS = resolve(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');
const ENG_BIN = join(ENGINEER, 'scripts/state.mjs');
const ENG = await import(pathToFileURL(ENG_BIN).href);
const CI = await import(pathToFileURL(join(ENGINEER, 'scripts/lib/change-identity.mjs')).href);
const SNAP = await import(pathToFileURL(join(ENGINEER, 'scripts/lib/peer-snapshot.mjs')).href);

const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (process.env.FAKE_GH_FAIL) { process.stderr.write('gh: not logged in\\n'); process.exit(1); }
if (args[0] === 'api') {
  const m = /commits\\/([0-9a-f]+)\\/pulls/.exec(args[1]);
  const map = JSON.parse(fs.readFileSync(process.env.FAKE_GH_PULLS, 'utf8'));
  process.stdout.write(JSON.stringify(map[m[1]] ?? []));
} else {
  process.stdout.write(fs.readFileSync(process.env.FAKE_GH_PRS, 'utf8'));
}
`;

function cleanEnv(extra = {}) {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith('AGENTIC_') || k.startsWith('GIT_')) delete e[k];
  return { ...e, ...extra };
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv() }).trim();

async function withRepo(fn) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'binding-landing-')));
  const dir = join(root, 'work');
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(root, 'origin.git')], { env: cleanEnv() });
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: cleanEnv() });
    for (const [k, v] of [['user.name', 'b'], ['user.email', 'b@example.invalid'], ['commit.gpgsign', 'false']]) git(dir, 'config', k, v);
    await writeFile(join(dir, '.gitignore'), '.agentic-plugins/\n');
    await writeFile(join(dir, 'a'), 'a0\n');
    await writeFile(join(dir, 'b'), 'b0\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'chore: base', '--no-verify');
    git(dir, 'remote', 'add', 'origin', join(root, 'origin.git'));
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    git(dir, 'remote', 'set-head', 'origin', 'main');
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'gh'), FAKE_GH);
    await chmod(join(bin, 'gh'), 0o755);
    await fn(dir, root, bin);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('landingEvidence — where a landing started (ADR-0069 Decision 2)', () => {
  const withGh = async (bin, root, pulls, fn) => {
    const file = join(root, 'pulls.json');
    await writeFile(file, JSON.stringify(pulls));
    const saved = { PATH: process.env.PATH, FAKE_GH_PULLS: process.env.FAKE_GH_PULLS };
    process.env.PATH = `${bin}:${dirname(process.execPath)}:${process.env.PATH}`;
    process.env.FAKE_GH_PULLS = file;
    try {
      return await fn();
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.FAKE_GH_PULLS === undefined) delete process.env.FAKE_GH_PULLS; else process.env.FAKE_GH_PULLS = saved.FAKE_GH_PULLS;
    }
  };

  it('a merge commit starts at its first parent, its second parent the head, with no forge', async () => {
    await withRepo(async (dir) => {
      const base = git(dir, 'rev-parse', 'HEAD');
      git(dir, 'switch', '-q', '-c', 'feat');
      await writeFile(join(dir, 'a'), 'a1\n');
      git(dir, 'commit', '-qam', 'x', '--no-verify');
      const tip = git(dir, 'rev-parse', 'HEAD');
      git(dir, 'switch', '-q', 'main');
      git(dir, 'merge', '-q', '--no-ff', '--no-edit', 'feat');
      const out = await L.landingEvidence({ repoRoot: dir, commit: git(dir, 'rev-parse', 'HEAD') });
      deepStrictEqual(out, { start: base, head: tip, evidence: 'merge-commit' });
    });
  });

  it('a squash: the merge commit is the pull request\'s, its parent is not, and that is the start', async () => {
    await withRepo(async (dir, root, bin) => {
      const base = git(dir, 'rev-parse', 'HEAD');
      await writeFile(join(dir, 'a'), 'a1\n');
      git(dir, 'commit', '-qam', 'squash (#7)', '--no-verify');
      const commit = git(dir, 'rev-parse', 'HEAD');
      const out = await withGh(bin, root, { [commit]: [7], [base]: [3] }, () => L.landingEvidence({ repoRoot: dir, commit, prNumber: 7, headRefOid: 'f'.repeat(40) }));
      deepStrictEqual(out, { start: base, head: 'f'.repeat(40), evidence: 'pull-request-commits' });
    });
  });

  it('a rebase that dropped a commit walks only what it landed, never by the branch\'s count', async () => {
    await withRepo(async (dir, root, bin) => {
      const base = git(dir, 'rev-parse', 'HEAD');
      await writeFile(join(dir, 'b'), 'cherry-picked earlier\n');
      git(dir, 'commit', '-qam', 'on main already (#6)', '--no-verify');
      const onMain = git(dir, 'rev-parse', 'HEAD');
      await writeFile(join(dir, 'a'), 'a1\n');
      git(dir, 'commit', '-qam', 'kept one (#7)', '--no-verify');
      const first = git(dir, 'rev-parse', 'HEAD');
      await writeFile(join(dir, 'a'), 'a2\n');
      git(dir, 'commit', '-qam', 'kept two (#7)', '--no-verify');
      const commit = git(dir, 'rev-parse', 'HEAD');
      const out = await withGh(bin, root, { [commit]: [7], [first]: [7], [onMain]: [6], [base]: [] }, () => L.landingEvidence({ repoRoot: dir, commit, prNumber: 7 }));
      deepStrictEqual([out.start, out.evidence], [onMain, 'pull-request-commits']);
    });
  });

  it('with no evidence the start is null: a commit not of this pull request, no pull request, gh failing', async () => {
    await withRepo(async (dir, root, bin) => {
      const commit = git(dir, 'rev-parse', 'HEAD');
      strictEqual((await withGh(bin, root, { [commit]: [9] }, () => L.landingEvidence({ repoRoot: dir, commit, prNumber: 7 }))).evidence, 'not-associated');
      strictEqual((await L.landingEvidence({ repoRoot: dir, commit })).evidence, 'no-pull-request');
      process.env.FAKE_GH_FAIL = '1';
      try {
        const failed = await withGh(bin, root, {}, () => L.landingEvidence({ repoRoot: dir, commit, prNumber: 7 }));
        deepStrictEqual([failed.start, failed.evidence], [null, 'gh-unavailable']);
      } finally {
        delete process.env.FAKE_GH_FAIL;
      }
    });
  });
});

describe('resolve-landing compares what landed (ADR-0069 Decision 2)', () => {
  it('a squash of the committed change reads same; an edit after it landed reads different; a fixup with no comparison reads not comparable; the landing itself is never refused for it', async () => {
    await withRepo(async (dir, root, bin) => {
      git(dir, 'switch', '-q', '-c', 'feat/a');
      const orch = await import(pathToFileURL(STATE_MJS).href);
      const engEnv = cleanEnv();
      const created = execFileSync('node', [ENG_BIN, 'create', '--repo-root', dir, '--verb', 'compose', '--profile', 'code', '--persona', 'engineer', '--host', 'claude',
        '--git-baseline-branch', 'feat/a', '--git-baseline-head', git(dir, 'rev-parse', 'HEAD'), '--status-digest', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        '--current-phase', 'phase-0-bootstrap', '--next-action', 'Run skill', '--original-request', 'x'], { cwd: dir, encoding: 'utf8', env: engEnv }).trim();
      const childId = created.split('/').pop().replace(/\.md$/, '');
      await writeFile(join(dir, 'a'), 'a1\n');
      const captured = await SNAP.captureWorkingTree({ cwd: dir, env: engEnv });
      const { identity, reason } = CI.captureIdentity({ repoRoot: dir, head: captured.head, resultTree: captured.tree, source: 'snapshot', capturedAt: '2026-11-07T00:00:00Z', refresh: false });
      await ENG.recordReviewAttempt({
        workflowPath: created, env: engEnv,
        attempt: { id: 'r1', phase: 'critique', type: 'review', state: 'closed', outcome: 'passed', run_id: 'r1', tree: null, tree_reason: 'x' },
        binding: { identity, reason, coverage: { shown: ['a'], covered: ['a'] } },
      });
      git(dir, 'add', 'a');
      git(dir, 'commit', '-qm', `fix: a\n\nWorkflow-ID: ${childId}`, '--no-verify');
      const head = git(dir, 'rev-parse', 'HEAD');
      execFileSync('node', [ENG_BIN, 'review-binding-record', '--workflow-path', created, '--repo-root', dir], { cwd: dir, env: engEnv, stdio: 'pipe' });
      // The landing, on main: a squash holding what was reviewed.
      git(dir, 'switch', '-q', 'main');
      const start = git(dir, 'rev-parse', 'HEAD');
      git(dir, 'merge', '-q', '--squash', 'feat/a');
      git(dir, 'commit', '-qm', 'fix: a (#7)', '--no-verify');
      const squash = git(dir, 'rev-parse', 'HEAD');
      git(dir, 'push', '-q', 'origin', 'main');
      const { filePath: macroPath } = await orch.createWorkflow({
        repoRoot: dir, verb: 'plan', host: 'claude', gitBaseline: { branch: 'main', head: '0'.repeat(40), status_digest: '' }, originalRequest: 'landing',
      });
      await orch.setPlan({ workflowPath: macroPath, host: 'claude', subtasks: [{ id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress' }] });
      await orch.updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host: 'claude', engineerWorkflowId: childId });
      const prs = join(root, 'prs.json');
      const pulls = join(root, 'pulls.json');
      const pr = (oid, headRefOid = head) => [{ number: 7, url: 'u', state: 'MERGED', baseRefName: 'main', headRefName: 'feat/a', createdAt: '2099-01-01T00:00:00Z', mergeCommit: { oid }, headRefOid }];
      await writeFile(prs, JSON.stringify(pr(squash)));
      await writeFile(pulls, JSON.stringify({ [squash]: [7], [start]: [] }));
      const ask = () => {
        const r = spawnSync(process.execPath, [STATE_MJS, 'resolve-landing', `--repo-root=${dir}`, `--workflow-path=${macroPath}`, '--subtask-id=A', '--integration-branch=main'], {
          encoding: 'utf8',
          env: cleanEnv({ PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, FAKE_GH_PRS: prs, FAKE_GH_PULLS: pulls, AGENTIC_ENGINEER_ROOT: ENGINEER }),
        });
        strictEqual(r.status, 0, r.stderr);
        return JSON.parse(r.stdout);
      };
      const same = ask();
      deepStrictEqual([same.ok, same.landed_review.state], [true, 'same']);
      // Main instead took an edit no one reviewed.
      await writeFile(join(dir, 'a'), 'an unreviewed edit\n');
      git(dir, 'commit', '-qam', 'fix: a again (#7)', '--no-verify');
      const edited = git(dir, 'rev-parse', 'HEAD');
      git(dir, 'push', '-q', 'origin', 'main');
      await writeFile(prs, JSON.stringify(pr(edited)));
      await writeFile(pulls, JSON.stringify({ [edited]: [7], [squash]: [7], [start]: [] }));
      const diff = ask();
      deepStrictEqual([diff.ok, diff.commit, diff.landed_review.state, diff.landed_review.failures.map((f) => f.path)], [true, edited, 'different', ['a']]);
      // A fixup on the branch after its comparison was recorded, then landed: the
      // head has no committed comparison, so the landing proves nothing.
      git(dir, 'switch', '-q', 'feat/a');
      await writeFile(join(dir, 'a'), 'a review-comment fixup\n');
      git(dir, 'commit', '-qam', 'fix: review comment', '--no-verify');
      const fixup = git(dir, 'rev-parse', 'HEAD');
      git(dir, 'switch', '-q', 'main');
      await writeFile(join(dir, 'a'), 'a review-comment fixup\n');
      git(dir, 'commit', '-qam', 'fix: a, fixed up (#7)', '--no-verify');
      const fixed = git(dir, 'rev-parse', 'HEAD');
      git(dir, 'push', '-q', 'origin', 'main');
      await writeFile(prs, JSON.stringify(pr(fixed, fixup)));
      await writeFile(pulls, JSON.stringify({ [fixed]: [7], [edited]: [] }));
      const fixedUp = ask();
      deepStrictEqual([fixedUp.landed_review.state, fixedUp.landed_review.reason], ['not-comparable', `no-committed-comparison:${fixup.slice(0, 12)}`]);
    });
  });
});

// ---------------------------------------------------------------------------
// The policy, on a view as the observer builds it.

const MACRO = 'macro-plan-20261001T000000Z-abcdef';
const ENG_A = 'compose-20261001T000100Z-aaaaaa';
const sub = (id, status, extra = {}) => ({ id, label: id, verb: 'compose', profile: 'backend', branch: `feat/${id.toLowerCase()}`, blocked_by: [], status, ...extra });
const child = (over = {}) => ({
  location: 'active',
  path: `/r/.agentic-plugins/state/engineer/workflows/${ENG_A}.md`,
  relPath: `.agentic-plugins/state/engineer/workflows/${ENG_A}.md`,
  workflow_id: ENG_A, branch: 'feat/a', current_phase: 'phase-2-presented', terminal_marker: false,
  next_step: { kind: 'commit', verb: null, confidence: 'HIGH' },
  awaiting_owner: null, workflow_type: 'verb-chain', parent_detached: false,
  pending_ensemble: 0, pending_runs: [], ensemble_results: 1, commit_manifest: 1, progress: 3,
  parent_workflow: MACRO, originating_subtask: 'A', ...over,
});
const view = (children, landing = {}) => ({
  repoRoot: '/r',
  git: { branch: 'feat/a', head: 'h0', porcelain: '', clean: true, detached: false },
  brief: { disposition: 'lead', leading: { command: '/orchestrator:resume' }, rows: [] },
  briefError: null,
  macro: {
    id: MACRO, path: `/r/.agentic-plugins/state/orchestrator/workflows/${MACRO}.md`,
    relPath: `.agentic-plugins/state/orchestrator/workflows/${MACRO}.md`, archived: false,
    fm: {
      workflow_id: MACRO, current_phase: 'phase-2-presented', terminal_marker: false, plan_approval_status: 'approved', plan_approval_plan_hash: 'f'.repeat(64),
      git_baseline: { branch: 'main' }, plan: { subtasks: [sub('A', 'in_progress', { engineer_workflow_id: ENG_A })] }, host_history: [],
    },
  },
  macroLookupError: null,
  ready: { ready: null, reason: 'in_progress_or_blocked', readiness: [], approval: { status: 'approved', hash_ok: true } },
  readyError: null,
  children,
  foreign: null,
  claims: Object.entries(children).filter(([, c]) => c.location === 'active').map(([id, c]) => ({ id: c.workflow_id, path: c.path, relPath: c.relPath, originating_subtask: id, branch: c.branch })),
  claimsError: null,
  landing,
});
const ctx = () => ({ runId: 'autopilot-20261001T000000Z-123456', macroId: MACRO, forced: null, finalizeAttempted: false });

describe('the autopilot policy reads the comparison (ADR-0069 Decision 3)', () => {
  it('what landed differing halts for the owner before done; not comparable goes on; the same goes on', () => {
    const archived = { location: 'archived', terminal_marker: true, current_phase: 'commit-complete', next_step: null };
    const landed = (state, failures = []) => ({ A: { ok: true, commit: 'c'.repeat(40), landed_review: { state, reason: state === 'not-comparable' ? 'no-landing-evidence' : null, failures } } });
    const diff = P.decide(view({ A: child(archived) }, landed('different', [{ path: 'a.mjs', why: 'differs', by: ['r1'] }])), ctx());
    deepStrictEqual([diff.outcome, diff.reason], ['halt', 'owner-choice']);
    match(diff.detail, /is not the change reviewed \(a\.mjs\)/);
    match(diff.detail, /--accept-landed-change/);
    for (const state of ['same', 'not-comparable', 'no-reviews']) {
      const d = P.decide(view({ A: child(archived) }, landed(state)), ctx());
      deepStrictEqual([d.outcome, d.step?.kind], ['step', 'done'], state);
    }
  });

  it('the report keeps the provisional comparison before the merge apart', () => {
    const rec = P.reviewRecord({ latest: null, held: false, outcomes: [], history_incomplete: false, reasons: [], comparison: { commit: 'c', state: 'different', reason: null } });
    match(P.reviewOutcomesText(rec), /before the merge the commit compared different with its reviews, provisionally/);
    const clean = P.reviewRecord({ latest: null, held: false, outcomes: [], history_incomplete: false, reasons: [], comparison: { commit: 'c', state: 'same', reason: null } });
    ok(!/before the merge/.test(P.reviewOutcomesText(clean)));
  });

  // Refine-verify of 2026-11-09: no look compares, so a lane Phase 7 refused is
  // parked on its step's report; the owner's acceptance must pick it up.
  it("the owner's acceptance of a refused change moves the lane fingerprint, and nothing moves it before", () => {
    const acceptance = JSON.stringify({ v: 1, manifest_sha256: 'a'.repeat(64), state: 'different', accepted_at: '2026-11-09T00:00:00Z' });
    strictEqual('binding_acceptance' in O.reviewSummary({}), false);
    deepStrictEqual(O.reviewSummary({ review_binding_acceptance: acceptance }).binding_acceptance, { manifest_sha256: 'a'.repeat(64), state: 'different', accepted_at: '2026-11-09T00:00:00Z' });
    const before = P.laneFingerprint(view({ A: child({ review: O.reviewSummary({}) }) }), 'A');
    strictEqual(P.laneFingerprint(view({ A: child({ review: O.reviewSummary({}) }) }), 'A'), before);
    const after = P.laneFingerprint(view({ A: child({ review: O.reviewSummary({ review_binding_acceptance: acceptance }) }) }), 'A');
    ok(after !== before, 'the acceptance moves it');
  });

  it('the observer reads the last comparison, an older engineer\'s through its carrier', () => {
    const raw = JSON.stringify({ v: 1, attempts: {}, comparisons: { abc: { state: 'same', at: '2026-11-07T00:00:00Z' }, def: { state: 'different', at: '2026-11-08T00:00:00Z' } } });
    strictEqual(O.reviewSummary({ review_bindings: raw }).comparison.commit, 'def');
    strictEqual(O.reviewSummary({ _forward_compat_unknowns: [{ key: 'review_bindings', value: raw }] }).comparison.state, 'different');
    strictEqual('comparison' in O.reviewSummary({}), false);
  });
});
