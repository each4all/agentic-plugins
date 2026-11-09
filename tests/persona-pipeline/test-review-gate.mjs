// tests/persona-pipeline/test-review-gate.mjs
//
// C163 A1b (ADR-0028 and ADR-0063, implementation notes of 2026-11-07) — the
// persona half of the review gate:
//
//   - `state.mjs review-gate` reads a workflow's latest review outcome, whether
//     it holds a commit back (failed, degraded, unavailable, malformed or
//     unknown), the owner's acceptance and, when that names the latest
//     attempt, whether the checkout's working tree is still the accepted one;
//   - `state.mjs review-accept` records the owner's acceptance of the latest
//     blocking attempt for the working tree as it is; it is refused under an
//     autopilot run, for an attempt that is not the latest, and for one that
//     holds nothing back;
//   - Phase 7 under autopilot refuses the commit and the recovery of a commit
//     begun (exit 10) before anything is written, unless an acceptance covers
//     both the attempt and the tree; a close is not held; interactively
//     the plan names the hold (`review_hold`), and execute warns and commits.
//
// One suite per persona each unit is generated into (ADR-0066 Decision 5).

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { personasFor, personaInfo, REPO_ROOT } from './_personas.mjs';

const AUTOPILOT_RUN_ID = 'autopilot-20261107T010203Z-abcdef';

function env(extra = {}) {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith('AGENTIC_')) delete e[k];
  delete e.ACCEPT_CURRENT_TREE;
  return { ...e, AGENTIC_ORCHESTRATOR_ROOT: resolve(REPO_ROOT, 'plugins/orchestrator'), ...extra };
}
const AP = { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID };
const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: env() }).trimEnd();

function digest(dir) {
  return execFileSync('shasum', ['-a', '256'], {
    input: execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd: dir }),
    encoding: 'utf8',
  }).trim().split(/\s+/)[0];
}

async function withSandbox(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'review-gate-'));
  const texts = await mkdtemp(join(tmpdir(), 'review-gate-texts-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'feat/s'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'review-gate'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'review-gate@example.invalid'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    await writeFile(join(dir, '.gitignore'), '.agentic-plugins/state/\n');
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'a.mjs'), 'export const a = 0;\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'chore: sandbox baseline', '--no-verify'], { cwd: dir });
    let n = 0;
    const text = async (body) => {
      const file = join(texts, `text-${(n += 1)}.txt`);
      await writeFile(file, `${body}\n`);
      return file;
    };
    await fn(dir, text);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(texts, { recursive: true, force: true });
  }
}

// A usable review of the checkout as it is, bound to it (ADR-0069): the
// sandbox gets a branch to land on, a remote-tracking ref at its baseline.
const boundPassed = async (S, P, dir, wf, id) => {
  if (spawnSync('git', ['-C', dir, 'remote', 'get-url', 'origin']).status !== 0) {
    const base = sh(dir, 'git', ['rev-parse', 'HEAD']);
    sh(dir, 'git', ['remote', 'add', 'origin', join(dir, 'no-such-origin')]);
    sh(dir, 'git', ['update-ref', 'refs/remotes/origin/main', base]);
    sh(dir, 'git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  }
  const CI = await import(pathToFileURL(P.path('scripts/lib/change-identity.mjs')).href);
  const SNAP = await import(pathToFileURL(P.path('scripts/lib/peer-snapshot.mjs')).href);
  const captured = await SNAP.captureWorkingTree({ cwd: dir, env: env() });
  const { identity, reason } = CI.captureIdentity({ repoRoot: dir, head: captured.head, resultTree: captured.tree, source: 'snapshot', capturedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), refresh: false });
  const paths = identity.manifest.map((e) => e.slice(e.indexOf('\t') + 1));
  return S.recordReviewAttempt({
    workflowPath: wf,
    env: env(),
    attempt: { id, phase: 'critique', type: 'review', state: 'closed', outcome: 'passed', run_id: id, tree: null, tree_reason: 'no-snapshot' },
    binding: { identity, reason, coverage: { shown: paths, covered: paths } },
  });
};
for (const persona of personasFor('scripts/state.mjs')) {
  const P = personaInfo(persona);
  const STATE_BIN = P.path('scripts/state.mjs');
  const S = await import(pathToFileURL(STATE_BIN).href);
  const stateRun = (cwd, args, extra = {}) => {
    const r = spawnSync('node', [STATE_BIN, ...args], { cwd, encoding: 'utf8', env: env(extra) });
    return { code: r.status, stdout: r.stdout.trimEnd(), stderr: r.stderr.trimEnd() };
  };

  function workflow(dir, { next = 'commit' } = {}) {
    const wf = sh(dir, 'node', [
      STATE_BIN, 'create', '--repo-root', dir, '--verb', 'compose', '--profile', 'code', '--persona', persona,
      '--host', 'claude', '--git-baseline-branch', 'feat/s', '--git-baseline-head', sh(dir, 'git', ['rev-parse', 'HEAD']),
      '--status-digest', digest(dir), '--current-phase', 'phase-0-bootstrap', '--next-action', 'Run skill',
      '--original-request', 'the change',
    ]);
    sh(dir, 'node', [STATE_BIN, 'record-composed-file', '--workflow-path', wf, '--path', 'src/a.mjs', '--op', 'edit']);
    sh(dir, 'node', [STATE_BIN, 'append', '--workflow-path', wf, '--host', 'claude', '--next-step-kind', next,
      '--next-step-confidence', 'HIGH', '--event', 'updated']);
    return wf;
  }
  // A closed review attempt, as settle records it.
  const attempt = (wf, id, outcome, extra = {}) => S.recordReviewAttempt({
    workflowPath: wf,
    env: env(),
    attempt: {
      id, phase: 'critique', type: 'review', state: 'closed', outcome, run_id: id, tree: null, tree_reason: 'no-snapshot',
      ...(outcome === 'skipped' ? { reason: 'local-only' } : {}), ...extra,
    },
  });
  const gate = (dir, wf) => {
    const r = stateRun(dir, ['review-gate', '--workflow-path', wf, '--repo-root', dir]);
    strictEqual(r.code, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const accept = async (dir, wf, id, text, extra = {}) => stateRun(dir, [
    'review-accept', '--workflow-path', wf, '--attempt-id', id, '--repo-root', dir, '--note-file', await text('the peer timed out; the owner read the change'),
  ], extra);

  describe(`${persona}: state.mjs review-gate and review-accept (C163 A1b)`, () => {
    it('a failed latest review holds the commit; the owner accepts it for this tree, and the gate lets it', async () => {
      await withSandbox(async (dir, text) => {
        const wf = workflow(dir);
        await writeFile(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
        await attempt(wf, 'review-1', 'passed');
        await attempt(wf, 'review-2', 'failed', { error_kind: 'peer_timeout', status: 'failed' });
        const before = gate(dir, wf);
        deepStrictEqual([before.latest.id, before.latest.outcome, before.latest.error_kind, before.blocking, before.held, before.change],
          ['review-2', 'failed', 'peer_timeout', true, true, null]);
        const r = await accept(dir, wf, 'review-2', text);
        strictEqual(r.code, 0, r.stderr);
        const out = JSON.parse(r.stdout);
        deepStrictEqual([out.ok, out.attempt_id, out.outcome], [true, 'review-2', 'failed']);
        const fm = S.parseWorkflowFile(await readFile(wf, 'utf8')).frontmatter;
        const doc = JSON.parse(fm.review_acceptance);
        deepStrictEqual([doc.v, doc.attempt_id, doc.outcome, doc.error_kind, doc.tree, doc.note],
          [1, 'review-2', 'failed', 'peer_timeout', out.tree, 'the peer timed out; the owner read the change']);
        // The record as the owner saw it: the last attempt listed, with its time, and the gaps then.
        const listedAt = JSON.parse(fm.review_attempts).attempts.at(-1).recorded_at;
        deepStrictEqual([doc.listed, doc.gaps], [{ id: 'review-2', at: listedAt }, []]);
        const after = gate(dir, wf);
        deepStrictEqual([after.acceptance.state, after.change.state, after.held], ['matches', 'same', false]);
      });
    });

    it('an edit after the acceptance moves the tree, and holds the commit again', async () => {
      await withSandbox(async (dir, text) => {
        const wf = workflow(dir);
        await writeFile(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
        await attempt(wf, 'review-1', 'degraded');
        strictEqual((await accept(dir, wf, 'review-1', text)).code, 0);
        await writeFile(join(dir, 'src', 'a.mjs'), 'export const a = 2;\n');
        const g = gate(dir, wf);
        deepStrictEqual([g.acceptance.state, g.change.state, g.held], ['matches', 'moved', true]);
        match(S.reviewHoldText(g, { workflowPath: wf }), /the owner accepted it for another change/);
        // The path is one shell word, quoted when it needs it (refine-verify MINOR F5).
        match(S.reviewHoldText(g, { workflowPath: '/tmp/My Projects/w.md' }), /review-accept --workflow-path '\/tmp\/My Projects\/w\.md' --attempt-id review-1 /);
        match(S.reviewHoldText(g, { workflowPath: "/tmp/it's/w.md" }), /--workflow-path '\/tmp\/it'\\''s\/w\.md' --attempt-id/);
        match(S.reviewHoldText(g, { workflowPath: '/tmp/a\nb.md' }), /review-accept --attempt-id review-1`, with --workflow-path naming this workflow's file \(its path cannot be printed here\)/);
      });
    });

    // Critique of 2026-11-07, third pass, MAJOR 4: a tree the gate cannot
    // compare holds the commit, as one that moved does.
    it('a working tree that cannot be compared holds the commit, whatever the acceptance names', async () => {
      await withSandbox(async (dir, text) => {
        const wf = workflow(dir);
        await writeFile(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
        await attempt(wf, 'review-1', 'failed', { error_kind: 'peer_timeout' });
        strictEqual((await accept(dir, wf, 'review-1', text)).code, 0);
        strictEqual(gate(dir, wf).held, false, 'the tree it was given for (control)');
        // An edit to a file so marked is not in the tree a snapshot captures.
        execFileSync('git', ['update-index', '--assume-unchanged', 'src/a.mjs'], { cwd: dir });
        const g = gate(dir, wf);
        deepStrictEqual([g.acceptance.state, g.change.state, g.change.reason, g.held], ['matches', 'unreadable', 'checkout-unreadable:index-flags', true]);
        match(S.reviewHoldText(g, { workflowPath: wf }), /the owner accepted it, but the working tree cannot be compared \(checkout-unreadable:index-flags\)/);
      });
    });

    // Critique of 2026-11-07, third pass, MAJOR 3: the refusal's ways on are
    // ones the commands take.
    it('the hold offers no new review or acceptance for a record no new review can repair, and no acceptance of an attempt still open', async () => {
      await withSandbox(async (dir) => {
        const wf = workflow(dir);
        await attempt(wf, 'review-1', 'passed');
        const t = await readFile(wf, 'utf8');
        const put = (doc) => writeFile(wf, t.replace(/^review_attempts: .*$/m, `review_attempts: ${JSON.stringify(doc)}`));
        await put('not json');
        const unreadable = S.reviewHoldText(gate(dir, wf), { workflowPath: wf });
        match(unreadable, /the review record cannot be read, so neither a new review nor an acceptance can be recorded over it: repair the workflow file's review_attempts by hand/);
        ok(!/Run the review again|review-accept/.test(unreadable), unreadable);
        await put(JSON.stringify({ v: 99, attempts: [] }));
        const later = S.reviewHoldText(gate(dir, wf), { workflowPath: wf });
        match(later, /written by a later version than this one reads, so neither a new review nor an acceptance can be recorded over it: upgrade the plugins/);
        ok(!/Run the review again|review-accept/.test(later), later);
        await writeFile(wf, t);
        await S.recordPendingEnsemble({ workflowPath: wf, phase: 'critique', ensemble_type: 'review', run_id: 'review-2', env: env() });
        const open = S.reviewHoldText(gate(dir, wf), { workflowPath: wf });
        match(open, /Run the review again \(a new outcome replaces it\); review-2 is still open, so it cannot be accepted until its run is settled/);
        ok(!/review-accept/.test(open), open);
      });
    });

    it('a later review makes the acceptance stale', async () => {
      await withSandbox(async (dir, text) => {
        const wf = workflow(dir);
        await attempt(wf, 'review-1', 'failed');
        strictEqual((await accept(dir, wf, 'review-1', text)).code, 0);
        await attempt(wf, 'review-2', 'unavailable', { error_kind: 'peer_cli_not_found' });
        const g = gate(dir, wf);
        deepStrictEqual([g.latest.id, g.acceptance.state, g.held], ['review-2', 'stale', true]);
        match(S.reviewHoldText(g, { workflowPath: wf }), /names another attempt \(review-1\), which a later review replaced/);
      });
    });

    it('review-accept is refused under an autopilot run, for an attempt that is not the latest, and for one that holds nothing back', async () => {
      await withSandbox(async (dir, text) => {
        const wf = workflow(dir);
        await attempt(wf, 'review-1', 'failed');
        const auto = await accept(dir, wf, 'review-1', text, AP);
        strictEqual(auto.code, 1);
        match(auto.stderr, /refused under an autopilot run .*only the owner accepts a review outcome/);
        await attempt(wf, 'review-2', 'malformed', { error_kind: 'envelope_parse_error' });
        const older = await accept(dir, wf, 'review-1', text);
        strictEqual(older.code, 1);
        match(older.stderr, /review-1 is not the latest review attempt .*the latest is review-2 \(critique review\): malformed, envelope_parse_error/);
        await attempt(wf, 'review-3', 'passed');
        const usable = await accept(dir, wf, 'review-3', text);
        strictEqual(usable.code, 1);
        match(usable.stderr, /review-3 is passed, which holds nothing back/);
        strictEqual(S.parseWorkflowFile(await readFile(wf, 'utf8')).frontmatter.review_acceptance, undefined, 'nothing was written');
      });
    });

    // Critique MAJOR 1 (refine of 2026-11-07): an attempt with no outcome yet
    // cannot be accepted, and an acceptance is bound to the outcome it names.
    it('review-accept refuses an attempt still open (its run pending); once settled failed it is accepted, for that outcome only', async () => {
      await withSandbox(async (dir, text) => {
        const wf = workflow(dir);
        await S.recordPendingEnsemble({ workflowPath: wf, phase: 'critique', ensemble_type: 'review', run_id: 'review-1', env: env() });
        const pending = gate(dir, wf);
        deepStrictEqual([pending.latest.id, pending.latest.outcome, pending.held], ['review-1', 'unknown', true]);
        const early = await accept(dir, wf, 'review-1', text);
        strictEqual(early.code, 1);
        match(early.stderr, /review-1 is still open \(run review-1 is pending\), so it has no outcome to accept; collect and settle its run first \(peer-runner\.mjs settle --run-id review-1\)/);
        strictEqual(S.parseWorkflowFile(await readFile(wf, 'utf8')).frontmatter.review_acceptance, undefined, 'nothing was written');
        await S.commitEnsemble({
          workflowPath: wf, run_id: 'review-1', phase: 'critique', ensemble_type: 'review', verdict: 'failed', summary: 'the peer timed out', env: env(),
          review: { outcome: 'failed', reason: 'peer_timeout', status: 'failed', error_kind: 'peer_timeout', tree: null, tree_reason: 'no-snapshot' },
        });
        strictEqual((await accept(dir, wf, 'review-1', text)).code, 0);
        deepStrictEqual([gate(dir, wf).acceptance.state, gate(dir, wf).held], ['matches', false]);
        // The same attempt id with another outcome recorded in the acceptance is stale.
        const t = await readFile(wf, 'utf8');
        const doc = JSON.parse(S.parseWorkflowFile(t).frontmatter.review_acceptance);
        await writeFile(wf, t.replace(/^review_acceptance: .*$/m, `review_acceptance: ${JSON.stringify(JSON.stringify({ ...doc, outcome: 'unknown', error_kind: undefined, reason: undefined }))}`));
        const g = gate(dir, wf);
        deepStrictEqual([g.acceptance.state, g.acceptance.reason, g.held], ['stale', 'outcome-changed', true]);
      });
    });

    // Refine-verify MINOR (refine of 2026-11-07): each of the two conditions
    // refuses on its own.
    it('review-accept refuses an open attempt an older writer settled (no pending run), and a closed one whose run is still pending', async () => {
      await withSandbox(async (dir, text) => {
        const wf = workflow(dir);
        // An older writer's settle: the pending row popped, a result row, no outcome.
        await S.recordPendingEnsemble({ workflowPath: wf, phase: 'critique', ensemble_type: 'review', run_id: 'review-1', env: env() });
        await S.commitEnsemble({ workflowPath: wf, run_id: 'review-1', phase: 'critique', ensemble_type: 'review', verdict: 'agreed', summary: 's', env: env() });
        const fm1 = S.parseWorkflowFile(await readFile(wf, 'utf8')).frontmatter;
        strictEqual((fm1.pending_ensemble ?? []).length, 0, 'no pending run');
        const open1 = await accept(dir, wf, 'review-1', text);
        strictEqual(open1.code, 1);
        match(open1.stderr, /review-1 is still open, so it has no outcome to accept; .*settle answers already-settled\), run the review again instead/);
        // A closed attempt whose run is still pending.
        await S.recordPendingEnsemble({ workflowPath: wf, phase: 'critique', ensemble_type: 'review', run_id: 'review-2', env: env() });
        await attempt(wf, 'review-2', 'failed', { error_kind: 'peer_timeout' });
        const fm2 = S.parseWorkflowFile(await readFile(wf, 'utf8')).frontmatter;
        ok((fm2.pending_ensemble ?? []).some((e) => e.run_id === 'review-2'), 'its run is pending');
        const pending2 = await accept(dir, wf, 'review-2', text);
        strictEqual(pending2.code, 1);
        match(pending2.stderr, /review-2 is still open \(run review-2 is pending\)/);
        strictEqual(S.parseWorkflowFile(await readFile(wf, 'utf8')).frontmatter.review_acceptance, undefined, 'nothing was written');
      });
    });

    // Critique MAJOR 5: a review that never ran, with no reason given, holds
    // the commit and is the owner's to accept.
    it('a skipped review with no reason given holds the commit, and the owner can accept it; local-only does not hold it', async () => {
      await withSandbox(async (dir, text) => {
        const wf = workflow(dir);
        await attempt(wf, 'review-1', 'skipped', { reason: 'local-only' });
        strictEqual(gate(dir, wf).held, false, 'local-only (control)');
        await attempt(wf, 'review-2', 'skipped', { reason: 'unspecified' });
        const g = gate(dir, wf);
        deepStrictEqual([g.latest.id, g.latest.reason, g.blocking, g.held], ['review-2', 'unspecified', true, true]);
        strictEqual((await accept(dir, wf, 'review-2', text)).code, 0);
        strictEqual(gate(dir, wf).held, false);
      });
    });

    // Critique of 2026-11-07, MAJOR 2: a replacement registers after the
    // attempt it replaces; a link back would revive an earlier outcome.
    it('review-attempt-supersede refuses a replacement listed before the attempt it replaces; the gate never follows one', async () => {
      await withSandbox(async (dir) => {
        const wf = workflow(dir);
        await attempt(wf, 'review-1', 'passed');
        // Registered (open) as a dispatch registers it.
        await S.recordPendingEnsemble({ workflowPath: wf, phase: 'critique', ensemble_type: 'review', run_id: 'review-2', env: env() });
        const supersede = (by) => stateRun(dir, ['review-attempt-supersede', '--workflow-path', wf, '--attempt-id', 'review-2', '--superseded-by', by]);
        const before = await readFile(wf, 'utf8');
        const back = supersede('review-1');
        strictEqual(back.code, 1, back.stdout);
        match(back.stderr, /review-1 is listed before review-2; a replacement is an attempt registered after the one it replaces/);
        strictEqual(await readFile(wf, 'utf8'), before, 'nothing was written');
        // A link back written by hand (or an older writer) reads unknown.
        const t = await readFile(wf, 'utf8');
        const doc = JSON.parse(S.parseWorkflowFile(t).frontmatter.review_attempts);
        doc.attempts[1] = { ...doc.attempts[1], state: 'closed', outcome: 'superseded', superseded_by: 'review-1', tree: null, tree_reason: 'superseded', recorded_at: '2026-11-07T00:00:00Z' };
        await writeFile(wf, t.replace(/^review_attempts: .*$/m, `review_attempts: ${JSON.stringify(JSON.stringify(doc))}`));
        const g = gate(dir, wf);
        deepStrictEqual([g.latest.id, g.latest.outcome, g.latest.reason, g.held], ['review-2', 'unknown', 'replacement-backward', true]);
        await writeFile(wf, before);
        strictEqual(supersede('review-3').code, 0, 'a replacement still to register (control)');
      });
    });
  });
}

for (const persona of personasFor('scripts/phase7-commit.mjs')) {
  const P = personaInfo(persona);
  const PHASE7_BIN = P.path('scripts/phase7-commit.mjs');
  const STATE_BIN = P.path('scripts/state.mjs');
  const S = await import(pathToFileURL(STATE_BIN).href);
  const itDispatchOn = P.capabilities.dispatch_target ? it : () => {};
  const run = (cwd, args, extra = {}) => {
    const r = spawnSync('node', [PHASE7_BIN, ...args], { cwd, encoding: 'utf8', env: env(extra) });
    return { code: r.status, stdout: r.stdout.trimEnd(), stderr: r.stderr.trimEnd() };
  };
  function workflow(dir, { next = 'commit' } = {}) {
    const wf = sh(dir, 'node', [
      STATE_BIN, 'create', '--repo-root', dir, '--verb', 'compose', '--profile', 'code', '--persona', persona,
      '--host', 'claude', '--git-baseline-branch', 'feat/s', '--git-baseline-head', sh(dir, 'git', ['rev-parse', 'HEAD']),
      '--status-digest', digest(dir), '--current-phase', 'phase-0-bootstrap', '--next-action', 'Run skill',
      '--original-request', 'the change',
    ]);
    sh(dir, 'node', [STATE_BIN, 'record-composed-file', '--workflow-path', wf, '--path', 'src/a.mjs', '--op', 'edit']);
    sh(dir, 'node', [STATE_BIN, 'append', '--workflow-path', wf, '--host', 'claude', '--next-step-kind', next,
      '--next-step-confidence', 'HIGH', '--event', 'updated']);
    return wf;
  }
  const attempt = (wf, id, outcome, extra = {}) => S.recordReviewAttempt({
    workflowPath: wf, env: env(),
    attempt: { id, phase: 'critique', type: 'review', state: 'closed', outcome, run_id: id, tree: null, tree_reason: 'no-snapshot', ...extra },
  });
  const accept = async (dir, wf, id, text) => {
    const r = spawnSync('node', [STATE_BIN, 'review-accept', '--workflow-path', wf, '--attempt-id', id, '--repo-root', dir, '--note-file', await text('accepted')], { cwd: dir, encoding: 'utf8', env: env() });
    strictEqual(r.status, 0, r.stderr);
  };
  const auto = (dir, wf, ...extra) => run(dir, ['--mode', 'autopilot', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude', ...extra], AP);
  // A git on PATH that, at the second `git ls-files` (executeMode reading the
  // changes again, after the plan's read and the first review check),
  // records a failed review as a concurrent writer would, then runs the real
  // git: only the check at commit admission can see it.
  const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  async function injectingGit(wf) {
    const bin = await mkdtemp(join(tmpdir(), 'review-gate-git-'));
    const mark = join(bin, 'injected');
    const inject = join(bin, 'inject.mjs');
    await writeFile(inject, [
      `const S = await import(${JSON.stringify(pathToFileURL(STATE_BIN).href)});`,
      'const env = { ...process.env }; delete env.AGENTIC_AUTOPILOT;',
      `await S.recordReviewAttempt({ workflowPath: ${JSON.stringify(wf)}, env, attempt: { id: 'review-2', phase: 'critique', type: 'review', state: 'closed', outcome: 'failed', error_kind: 'peer_timeout', run_id: 'review-2', tree: null, tree_reason: 'no-snapshot' } });`,
    ].join('\n'));
    const count = join(bin, 'count');
    await writeFile(join(bin, 'git'), [
      '#!/bin/sh',
      `if [ "$1" = ls-files ] && [ ! -e '${mark}' ]; then`,
      `  if [ -e '${count}' ]; then : > '${mark}'; '${process.execPath}' '${inject}' || exit 97; else : > '${count}'; fi`,
      'fi',
      `exec '${REAL_GIT}' "$@"`,
      '',
    ].join('\n'));
    await chmod(join(bin, 'git'), 0o755);
    return { env: { ...AP, PATH: `${bin}:${process.env.PATH}` }, mark, cleanup: () => rm(bin, { recursive: true, force: true }) };
  }
  const snapshot = async (dir, wf) => ({
    head: sh(dir, 'git', ['rev-parse', 'HEAD']),
    staged: sh(dir, 'git', ['diff', '--cached', '--name-only']),
    wf: await readFile(wf, 'utf8'),
  });

  describe(`${persona}: Phase 7 holds a commit on a review outcome that holds it back (C163 A1b)`, () => {
    itDispatchOn('under autopilot a failed latest review refuses the commit (exit 10), writing nothing; each blocking class does', async () => {
      for (const [outcome, extra] of [['failed', { error_kind: 'peer_timeout' }], ['degraded', { reason: 'answer-empty' }], ['unavailable', { error_kind: 'peer_cli_not_found' }], ['malformed', { error_kind: 'envelope_parse_error' }]]) {
        await withSandbox(async (dir, text) => {
          const wf = workflow(dir);
          await writeFile(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
          await attempt(wf, 'review-1', outcome, extra);
          const before = await snapshot(dir, wf);
          const r = auto(dir, wf, '--subject-file', await text('fix: set a to 1'));
          strictEqual(r.code, 10, `${outcome}: ${r.stderr}`);
          match(r.stderr, new RegExp(`✗ refused under autopilot: the latest review outcome holds the commit back: review-1 \\(critique review\\): ${outcome}, ${Object.values(extra)[0]}`));
          match(r.stderr, /state\.mjs review-accept --workflow-path .* --attempt-id review-1 --note-file <file>/);
          match(r.stderr, /Nothing was committed and nothing was written/);
          deepStrictEqual(await snapshot(dir, wf), before, outcome);
        });
      }
    });

    // An open attempt (unknown) is held as well: its pending row refuses the
    // commit first (P11), and the library and policy suites read it unknown.
    itDispatchOn('a review record that cannot be read is unknown, and refuses the commit, with no attempt to accept', async () => {
      await withSandbox(async (dir, text) => {
        const wf = workflow(dir);
        await writeFile(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
        await attempt(wf, 'review-1', 'passed');
        const t = await readFile(wf, 'utf8');
        ok(/^review_attempts: .*$/m.test(t), 'the record is in the file');
        await writeFile(wf, t.replace(/^review_attempts: .*$/m, 'review_attempts: "not json"'));
        const r = auto(dir, wf, '--subject-file', await text('fix: set a to 1'));
        strictEqual(r.code, 10, r.stderr);
        match(r.stderr, /the review record: unknown, document-unreadable/);
        match(r.stderr, /the review record cannot be read, so neither a new review nor an acceptance can be recorded over it: repair the workflow file's review_attempts by hand/);
        ok(!/Run the review again|review-accept --/.test(r.stderr), r.stderr);
      });
    });

    // Critique MAJOR 1 and 5 (refine of 2026-11-07), end to end through Phase 7.
    itDispatchOn('an acceptance given while the attempt read another outcome, and a skip with no reason, each refuse the commit', async () => {
      await withSandbox(async (dir, text) => {
        const wf = workflow(dir);
        await writeFile(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
        await attempt(wf, 'review-1', 'failed', { error_kind: 'peer_timeout' });
        await accept(dir, wf, 'review-1', text);
        // The acceptance as it would read had it been given while the attempt was open.
        const t = await readFile(wf, 'utf8');
        const doc = JSON.parse(S.parseWorkflowFile(t).frontmatter.review_acceptance);
        const whileOpen = JSON.stringify({ ...doc, outcome: 'unknown', error_kind: undefined });
        await writeFile(wf, t.replace(/^review_acceptance: .*$/m, `review_acceptance: ${JSON.stringify(whileOpen)}`));
        const r = auto(dir, wf, '--subject-file', await text('fix: set a to 1'));
        strictEqual(r.code, 10, r.stderr);
        match(r.stderr, /the owner accepted it when it read unknown, and it reads another outcome now/);
        await attempt(wf, 'review-2', 'skipped', { reason: 'unspecified' });
        const skipped = auto(dir, wf, '--subject-file', await text('fix: set a to 1'));
        strictEqual(skipped.code, 10, skipped.stderr);
        match(skipped.stderr, /review-1 \(critique review\): failed, peer_timeout \(the later review review-2 was skipped, which clears nothing\)/);
      });
    });

    // Critique of 2026-11-07, MAJOR 1: the record is read again at commit
    // admission, not taken from the frontmatter read before planning.
    itDispatchOn('a failed review recorded after the plan and the first check refuses the commit at admission (exit 10), writing nothing', async () => {
      await withSandbox(async (dir, text) => {
        const wf = workflow(dir);
        await writeFile(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
        await boundPassed(S, P, dir, wf, 'review-1');
        const subject = await text('fix: set a to 1');
        const git = await injectingGit(wf);
        try {
          const head = sh(dir, 'git', ['rev-parse', 'HEAD']);
          const r = run(dir, ['--mode', 'autopilot', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude', '--subject-file', subject], git.env);
          ok(existsSync(git.mark), 'the failed review was recorded during the step');
          strictEqual(r.code, 10, r.stderr);
          match(r.stderr, /✗ refused under autopilot: the latest review outcome holds the commit back: review-2 \(critique review\): failed, peer_timeout/);
          deepStrictEqual([sh(dir, 'git', ['rev-parse', 'HEAD']), sh(dir, 'git', ['diff', '--cached', '--name-only'])], [head, '']);
          const fm = S.parseWorkflowFile(await readFile(wf, 'utf8')).frontmatter;
          deepStrictEqual([fm.terminal_marker ?? false, fm.current_phase], [false, 'phase-0-bootstrap'], 'no commit operation began');
        } finally {
          await git.cleanup();
        }
      });
    });

    // Critique of 2026-11-07, MAJOR 3, end to end.
    itDispatchOn('a review skipped after a failure (local-only, privacy-gate) refuses the commit; the owner accepts the failure, and it commits', async () => {
      for (const reason of ['local-only', 'privacy-gate']) {
        await withSandbox(async (dir, text) => {
          const wf = workflow(dir);
          await writeFile(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
          await attempt(wf, 'review-1', 'failed', { error_kind: 'peer_timeout' });
          await attempt(wf, 'review-2', 'skipped', { reason });
          const r = auto(dir, wf, '--subject-file', await text('fix: set a to 1'));
          strictEqual(r.code, 10, `${reason}: ${r.stderr}`);
          match(r.stderr, /review-1 \(critique review\): failed, peer_timeout \(the later review review-2 was skipped, which clears nothing\)/);
          match(r.stderr, /--attempt-id review-1 --note-file <file>/);
          await accept(dir, wf, 'review-1', text);
          const ok1 = auto(dir, wf, '--subject-file', await text('fix: set a to 1'));
          strictEqual(ok1.code, 0, `${reason}: ${ok1.stderr}`);
        });
      }
    });

    // Refine-verify of 2026-11-07, F1, end to end: an acceptance a later
    // registration made stale is not revived by a skip's lookback.
    itDispatchOn('an acceptance a later registration made stale stays stale when a skip reads the accepted attempt again', async () => {
      await withSandbox(async (dir, text) => {
        const wf = workflow(dir);
        await writeFile(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
        await attempt(wf, 'review-1', 'unavailable', { error_kind: 'peer_cli_not_found' });
        await accept(dir, wf, 'review-1', text);
        await S.recordPendingEnsemble({ workflowPath: wf, phase: 'critique', ensemble_type: 'review', run_id: 'review-2', env: env() });
        await S.supersedeReviewAttempt({ workflowPath: wf, attemptId: 'review-2', supersededBy: 'review-3', env: env() });
        await S.commitEnsemble({ workflowPath: wf, run_id: 'review-2', phase: 'critique', ensemble_type: 'review', verdict: 'failed', summary: 's', env: env(),
          review: { outcome: 'failed', reason: null, status: 'failed', error_kind: 'peer_timeout', tree: null, tree_reason: 'no-snapshot' } });
        await attempt(wf, 'review-3', 'skipped', { reason: 'local-only' });
        const r = auto(dir, wf, '--subject-file', await text('fix: set a to 1'));
        strictEqual(r.code, 10, r.stderr);
        match(r.stderr, /review-1 \(critique review\): unavailable, peer_cli_not_found \(the later review review-3 was skipped, which clears nothing\); the owner accepted it before a later review was registered/);
      });
    });

    // The commit is judged before the staging-set gate's write, too.
    itDispatchOn('a held review is refused before the staging-set gate is recorded', async () => {
      await withSandbox(async (dir, text) => {
        await writeFile(join(dir, 'stray.txt'), 'not the workflow\'s\n');
        const wf = workflow(dir);
        await writeFile(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
        await attempt(wf, 'review-1', 'failed', { error_kind: 'peer_timeout' });
        const before = await snapshot(dir, wf);
        const r = auto(dir, wf, '--subject-file', await text('fix: set a to 1'));
        strictEqual(r.code, 10, r.stderr);
        match(r.stderr, /review-1 \(critique review\): failed, peer_timeout/);
        deepStrictEqual(await snapshot(dir, wf), before, 'no staging-set gate');
        strictEqual(S.parseWorkflowFile(before.wf).frontmatter.awaiting_owner_gate, undefined);
      });
    });

    itDispatchOn('a later usable review lets the commit (control)', async () => {
      await withSandbox(async (dir, text) => {
        const wf = workflow(dir);
        await writeFile(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
        await attempt(wf, 'review-1', 'failed', { error_kind: 'peer_timeout' });
        await boundPassed(S, P, dir, wf, 'review-2');
        const r = auto(dir, wf, '--subject-file', await text('fix: set a to 1'));
        strictEqual(r.code, 0, r.stderr);
        strictEqual(JSON.parse(r.stdout).action, 'committed');
      });
    });

    itDispatchOn("the owner's acceptance lets the commit; an edit after it holds the commit again", async () => {
      await withSandbox(async (dir, text) => {
        const wf = workflow(dir);
        await writeFile(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
        await attempt(wf, 'review-1', 'failed', { error_kind: 'peer_timeout' });
        await accept(dir, wf, 'review-1', text);
        await writeFile(join(dir, 'src', 'a.mjs'), 'export const a = 2;\n');
        const moved = auto(dir, wf, '--subject-file', await text('fix: set a to 2'));
        strictEqual(moved.code, 10, moved.stderr);
        match(moved.stderr, /the owner accepted it for another change/);
        await accept(dir, wf, 'review-1', text);
        const r = auto(dir, wf, '--subject-file', await text('fix: set a to 2'));
        strictEqual(r.code, 0, r.stderr);
        strictEqual(JSON.parse(r.stdout).action, 'committed');
      });
    });

    itDispatchOn('the recovery of a commit begun is held as well; an acceptance lets it recover', async () => {
      await withSandbox(async (dir, text) => {
        const wf = workflow(dir);
        const id = wf.split('/').pop().replace(/\.md$/, '');
        await writeFile(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
        execFileSync('git', ['commit', '-qam', 'fix: set a to 1', '-m', `Workflow-ID: ${id}`, '--no-verify'], { cwd: dir });
        await attempt(wf, 'review-1', 'unavailable', { error_kind: 'peer_cli_not_found' });
        const before = await snapshot(dir, wf);
        const planned = JSON.parse(run(dir, ['--mode', 'plan', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude']).stdout);
        strictEqual(planned.no_changes.path, 'recovery');
        match(planned.review_hold, /review-1 \(critique review\): unavailable, peer_cli_not_found/);
        const r = auto(dir, wf);
        strictEqual(r.code, 10, r.stderr);
        match(r.stderr, /review-1 \(critique review\): unavailable, peer_cli_not_found/);
        deepStrictEqual(await snapshot(dir, wf), before);
        await accept(dir, wf, 'review-1', text);
        const ok1 = auto(dir, wf);
        strictEqual(ok1.code, 0, ok1.stderr);
        strictEqual(JSON.parse(ok1.stdout).action, 'recovered');
      });
    });

    itDispatchOn('a close lands nothing and is not held', async () => {
      await withSandbox(async (dir) => {
        const wf = workflow(dir, { next: 'done' });
        await attempt(wf, 'review-1', 'failed');
        // A close has no manifest entry to land.
        const text0 = await readFile(wf, 'utf8');
        await writeFile(wf, text0.replace(/^commit_manifest:\n(?: {2}.*\n)+/m, ''));
        const r = auto(dir, wf);
        strictEqual(r.code, 0, r.stderr);
        strictEqual(JSON.parse(r.stdout).action, 'closed');
      });
    });

    // Critique of 2026-11-07, fourth pass, MAJOR 3: the user decides at plan
    // time, so the hold is in the plan, not only in the run that commits.
    itDispatchOn('interactively the plan names the hold before the decision, and writes nothing', async () => {
      await withSandbox(async (dir, text) => {
        const wf = workflow(dir);
        await writeFile(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
        const plan = () => {
          const r = run(dir, ['--mode', 'plan', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude']);
          strictEqual(r.code, 0, r.stderr);
          return JSON.parse(r.stdout);
        };
        strictEqual(plan().review_hold, null, 'no review recorded');
        await attempt(wf, 'review-1', 'failed', { error_kind: 'peer_timeout' });
        const before = await snapshot(dir, wf);
        const held = plan();
        match(held.review_hold, /^the latest review outcome holds the commit back: review-1 \(critique review\): failed, peer_timeout; the owner has not accepted it\. Run the review again/);
        match(held.review_hold, /state\.mjs review-accept --workflow-path .* --attempt-id review-1 --note-file <file>/);
        deepStrictEqual(await snapshot(dir, wf), before, 'plan writes nothing');
        await accept(dir, wf, 'review-1', text);
        strictEqual(plan().review_hold, null, 'accepted for this tree');
        await writeFile(join(dir, 'src', 'a.mjs'), 'export const a = 2;\n');
        match(plan().review_hold, /the owner accepted it for another change/, 'the tree moved since');
      });
    });

    itDispatchOn('the plan names no hold over a clean tree that lands nothing', async () => {
      await withSandbox(async (dir) => {
        const wf = workflow(dir, { next: 'done' });
        await attempt(wf, 'review-1', 'failed', { error_kind: 'peer_timeout' });
        const text0 = await readFile(wf, 'utf8');
        await writeFile(wf, text0.replace(/^commit_manifest:\n(?: {2}.*\n)+/m, ''));
        const r = run(dir, ['--mode', 'plan', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude']);
        strictEqual(r.code, 0, r.stderr);
        const plan = JSON.parse(r.stdout);
        strictEqual(plan.no_changes.path, 'close');
        strictEqual(plan.review_hold, null);
      });
    });

    for (const [where, rel] of [['the commit command', 'commands/commit.md'], ['the commit skill', 'core/skills/commit/SKILL.md'], ['the start command', 'commands/start.md'], ['the start skill', 'core/skills/start/SKILL.md']]) {
      itDispatchOn(`${where} tells the agent to show the plan's review_hold before asking`, async () => {
        const body = await readFile(P.path(rel), 'utf8');
        match(body, /the plan's `review_hold` is set, a review outcome holds this commit back:\s+show the user\s+that line before asking anything/);
      });
    }

    itDispatchOn('a skip that holds after a failure refuses the commit and names the failure', async () => {
      await withSandbox(async (dir, text) => {
        const wf = workflow(dir);
        await writeFile(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
        await attempt(wf, 'review-1', 'failed', { error_kind: 'peer_timeout' });
        await attempt(wf, 'review-2', 'skipped', { reason: 'owner-skip' });
        const r = auto(dir, wf, '--subject-file', await text('fix: set a to 1'));
        strictEqual(r.code, 10, r.stderr);
        match(r.stderr, /review-1 \(critique review\): failed, peer_timeout \(the later review review-2 was skipped, which clears nothing\)/);
        match(r.stderr, /--attempt-id review-1 /);
        const refused = spawnSync('node', [STATE_BIN, 'review-accept', '--workflow-path', wf, '--attempt-id', 'review-2', '--repo-root', dir, '--note-file', await text('accepted')], { cwd: dir, encoding: 'utf8', env: env() });
        ok(refused.status !== 0, 'the skip cannot be accepted in the failure\'s place');
        await accept(dir, wf, 'review-1', text);
        const after = run(dir, ['--mode', 'autopilot', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude', '--subject-file', await text('fix: set a to 1')], AP);
        strictEqual(after.code, 0, after.stderr);
      });
    });

    it('interactively execute warns and commits', async () => {
      await withSandbox(async (dir, text) => {
        const wf = workflow(dir);
        await writeFile(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
        await attempt(wf, 'review-1', 'failed', { error_kind: 'peer_timeout' });
        const r = run(dir, ['--mode', 'execute', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude', '--confirm-non-interactive', '--subject-file', await text('fix: set a to 1')]);
        strictEqual(r.code, 0, r.stderr);
        match(r.stderr, /⚠ review: the latest review outcome holds the commit back: review-1 \(critique review\): failed, peer_timeout; the owner has not accepted it\..*Interactively this is a warning; under autopilot the commit is refused\./);
        strictEqual(sh(dir, 'git', ['log', '-1', '--format=%s']), 'fix: set a to 1');
      });
    });
  });
}
