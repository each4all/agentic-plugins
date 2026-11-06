// C163 A1a (ADR-0023, implementation note of 2026-11-05): one outcome per
// review attempt, kept in the workflow's `review_attempts` scalar outside the
// 20-row ensemble_results cap. Runs go through the real runner against a stub
// companion (missing, success, empty answer, malformed envelope), so the
// ledger states are the runner's own; a handle with a snapshot record is
// written as the runner writes it. Each case reads the workflow file.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { personaInfo, personasFor, REPO_ROOT as REPO } from './_personas.mjs';

const BASELINE = {
  branch: 'test',
  head: '0000000000000000000000000000000000000000',
  status_digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
};
const HEAD = 'a'.repeat(40);
const INDEX_TREE = 'b'.repeat(40);
const WORKTREE_TREE = 'c'.repeat(40);

async function writeCompanions(root, { missing = false } = {}) {
  const dir = join(root, missing ? 'missing-companions' : 'fake-companions');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'discover-peer.mjs'), missing
    ? 'export async function discoverPeerCompanion() { return { ok: false, reason: "not installed" }; }\n'
    : 'export async function discoverPeerCompanion({ peer } = {}) { return { ok: true, path: new URL("./" + peer + "-companion.mjs", import.meta.url).pathname }; }\n');
  if (missing) return dir;
  const companion = `#!/usr/bin/env node
const mode = process.env.FAKE_COMPANION_MODE || 'json-success';
const envelope = (stdout) => JSON.stringify({ status: 'success', peer_host: 'codex', peer_model: null, stdout, exit_code: 0 });
if (mode === 'json-empty') process.stdout.write(envelope(''));
else if (mode === 'malformed') process.stdout.write('not json');
else process.stdout.write(envelope('the peer answer'));
`;
  for (const peer of ['claude', 'codex']) {
    await writeFile(join(dir, `${peer}-companion.mjs`), companion);
    await chmod(join(dir, `${peer}-companion.mjs`), 0o755);
  }
  return dir;
}

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_')));

describe('review-attempts library: the outcome mapping', async () => {
  const lib = await import(pathToFileURL(join(REPO, 'persona-pipeline/files/scripts/lib/review-attempts.mjs')).href);
  it('applies the ledger first, then the answer, then the verdict', () => {
    const o = (s) => lib.outcomeOf(s).outcome;
    strictEqual(o({ verdict: 'agreed' }), 'passed');
    strictEqual(o({ verdict: 'resolved' }), 'passed');
    strictEqual(o({ verdict: 'pass' }), 'passed');
    strictEqual(o({ verdict: 'concerns' }), 'concerns');
    deepStrictEqual(lib.outcomeOf({ verdict: 'regression' }), { outcome: 'concerns', reason: 'regression' });
    strictEqual(o({ verdict: 'conflict' }), 'conflict');
    strictEqual(o({ status: 'failed', error_kind: 'peer_cli_not_found', verdict: 'agreed' }), 'unavailable');
    strictEqual(o({ status: 'failed', error_kind: 'peer_unauthenticated' }), 'unavailable');
    strictEqual(o({ status: 'failed', error_kind: 'peer_invocation_error' }), 'unavailable');
    strictEqual(o({ status: 'failed', error_kind: 'envelope_parse_error' }), 'malformed');
    strictEqual(o({ status: 'failed', error_kind: 'envelope_shape_invalid' }), 'malformed');
    deepStrictEqual(lib.outcomeOf({ status: 'cancelled', error_kind: null }), { outcome: 'failed', reason: 'cancelled' });
    strictEqual(o({ status: 'failed', error_kind: 'snapshot_failed' }), 'failed');
    strictEqual(o({ status: 'completed', answer: 'empty', verdict: 'agreed' }), 'degraded');
    strictEqual(o({ status: 'completed', answer: 'unreadable' }), 'degraded');
    deepStrictEqual(lib.outcomeOf({ verdict: 'aborted' }), { outcome: 'failed', reason: 'unrecognized-verdict' });
  });
  it('classifies the four review types by type alone', () => {
    deepStrictEqual([...lib.REVIEW_ENSEMBLE_TYPES].sort(), ['adversarial-scan', 'plan-verify', 'refine-verify', 'review']);
    for (const t of ['investigate', 'brainstorm', 'frame', 'root-cause', 'cited-brief', 'peer-now']) strictEqual(lib.isReviewType(t), false, t);
  });
  it('the byte cap drops the oldest closed attempts and marks the history incomplete', () => {
    let raw;
    for (let i = 0; i < 12; i++) {
      raw = lib.applyReviewAttempt(raw, {
        id: `review-${String(i).padStart(2, '0')}`, phase: 'critique', type: 'review', state: 'closed', outcome: 'passed',
        tree: null, tree_reason: 'no-snapshot', recorded_at: '2026-11-05T00:00:00Z',
      }, { maxBytes: 1200 }).raw;
    }
    const doc = JSON.parse(raw);
    ok(Buffer.byteLength(raw) <= 1200);
    ok(doc.attempts.length < 12);
    strictEqual(doc.attempts.at(-1).id, 'review-11', 'the newest is kept');
    deepStrictEqual(doc.coverage.reasons, ['truncation']);
    strictEqual(doc.coverage.history_incomplete, true);
    strictEqual(doc.coverage.truncated, 12 - doc.attempts.length);
  });
  it('past the byte cap with only open attempts, the oldest open ones go too, said so', () => {
    let raw;
    for (let i = 0; i < 40; i++) {
      raw = lib.applyReviewAttempt(raw, { id: `review-open-${String(i).padStart(2, '0')}`, phase: 'critique', type: 'review', state: 'open', run_id: `review-open-${String(i).padStart(2, '0')}`, registered_at: '2026-11-05T00:00:00Z' }, { maxBytes: 1500 }).raw;
    }
    const doc = JSON.parse(raw);
    ok(Buffer.byteLength(raw) <= 1500, String(Buffer.byteLength(raw)));
    strictEqual(doc.attempts.at(-1).id, 'review-open-39');
    deepStrictEqual(doc.coverage.reasons, ['truncation']);
  });
  // One outcome per attempt: a second closing write of the same id (a rerun
  // that names the same attempt with another outcome) changes nothing, and
  // says which outcome it kept.
  it('a closed attempt keeps its first outcome when the same id is closed again with another', () => {
    const closed = { id: 'refine-verify-first', phase: 'refine', type: 'refine-verify', state: 'closed', tree: null, tree_reason: 'no-launch' };
    const first = lib.applyReviewAttempt(undefined, { ...closed, outcome: 'skipped', reason: 'local-only', recorded_at: '2026-11-05T00:00:00Z' });
    strictEqual(first.changed, true);
    const again = lib.applyReviewAttempt(first.raw, { ...closed, outcome: 'unavailable', reason: 'peer-unavailable', recorded_at: '2026-11-05T00:00:01Z' });
    deepStrictEqual([again.recorded, again.changed, again.raw], [true, false, first.raw]);
    deepStrictEqual([again.kept.outcome, again.kept.reason], ['skipped', 'local-only']);
    const [a] = JSON.parse(again.raw).attempts;
    deepStrictEqual([a.outcome, a.reason, a.recorded_at], ['skipped', 'local-only', '2026-11-05T00:00:00Z']);
  });
  it('the orchestrator copy is the same file (hand mirror)', async () => {
    const a = await readFile(join(REPO, 'persona-pipeline/files/scripts/lib/review-attempts.mjs'), 'utf8');
    const b = await readFile(join(REPO, 'plugins/orchestrator/scripts/lib/review-attempts.mjs'), 'utf8');
    strictEqual(b, a);
  });
});

for (const persona of personasFor('scripts/lib/review-attempts.mjs')) {
  const P = personaInfo(persona);
  const RUNNER = P.path('scripts/peer-runner.mjs');
  const STATE = P.path('scripts/state.mjs');
  const { HANDLE_SCHEMA_VERSION, SettleRefusal, peerRunPaths, runPeer, settleEnsemble, writeHandle } =
    await import(pathToFileURL(RUNNER).href);
  const { createWorkflow, listWorkflowFiles, parseWorkflowFile, recordPendingEnsemble, commitEnsemble, supersedeReviewAttempt } =
    await import(pathToFileURL(STATE).href);
  const { outcomeOf, projectReviewOutcomes, reviewOutcomeFor } = await import(pathToFileURL(P.path('scripts/lib/review-attempts.mjs')).href);

  async function withWorkflow(fn) {
    const repoRoot = await mkdtemp(join(tmpdir(), `${persona}-review-attempts-`));
    try {
      await createWorkflow({ repoRoot, verb: 'critique', host: 'claude', persona, gitBaseline: BASELINE, originalRequest: 'review attempts' });
      const [workflowPath] = await listWorkflowFiles(repoRoot);
      const companions = await writeCompanions(repoRoot);
      await fn({ repoRoot, workflowPath, companions });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  }
  const fm = async (workflowPath) => parseWorkflowFile(await readFile(workflowPath, 'utf8')).frontmatter;
  const view = async (workflowPath) => projectReviewOutcomes(await fm(workflowPath));
  const attempt = async (workflowPath, id) => (await view(workflowPath)).attempts.find((a) => a.id === id);
  const reviewRun = (ctx, runId, env = {}) => runPeer({
    repoRoot: ctx.repoRoot, runId, kind: 'ensemble', workflowPath: ctx.workflowPath, phase: 'critique',
    ensembleType: 'review', host: 'claude', peer: 'codex', promptText: '<task>review</task>', outputFormat: 'json',
    cwd: ctx.repoRoot, env: { ...process.env, AGENTIC_COMPANIONS_ROOT: ctx.companions, ...env },
  });
  // The run evidence settle hands commitEnsemble from a ledger, for the
  // history cases that commit directly: with none a commit records no outcome.
  const ev = (outcome) => ({ review: { outcome, status: 'completed', tree: null, tree_reason: 'not-isolated' } });
  const settle = (ctx, runId, extra = {}) => settleEnsemble({ repoRoot: ctx.repoRoot, workflowPath: ctx.workflowPath, phase: 'critique', runId, ...extra });
  async function leftBehind(ctx, runId, overrides = {}) {
    const paths = peerRunPaths(ctx.repoRoot, runId);
    await mkdir(paths.dir, { recursive: true, mode: 0o700 });
    await writeFile(paths.stdout, '');
    await writeFile(paths.stderr, '');
    const at = '2020-01-01T00:00:00.000Z';
    await writeHandle(paths.handle, {
      schema_version: HANDLE_SCHEMA_VERSION, run_id: runId, plugin: persona, kind: 'ensemble',
      workflow_path: ctx.workflowPath, phase: 'critique', ensemble_type: 'review', host: 'claude',
      peer_host: 'codex', model: null, effort: null, cwd: ctx.repoRoot, output_format: 'json',
      status: 'failed', pid: null, pgid: null, process_fingerprint: { kind: 'none' },
      started_at: at, updated_at: at, completed_at: at, last_output_at: null,
      stdout_bytes: 0, stderr_bytes: 0, exit_code: 1, error_kind: 'peer_run_error', prompt_retained: false,
      ...overrides,
    });
  }

  describe(`${persona}: a review attempt is registered with its pending row`, () => {
    it('a review run is open (unknown) from its dispatch until settled; another type records nothing', async () => {
      await withWorkflow(async (ctx) => {
        await recordPendingEnsemble({ workflowPath: ctx.workflowPath, phase: 'critique', ensemble_type: 'review', run_id: 'review-open' });
        await recordPendingEnsemble({ workflowPath: ctx.workflowPath, phase: 'investigate', ensemble_type: 'investigate', run_id: 'investigate-x' });
        const a = await attempt(ctx.workflowPath, 'review-open');
        deepStrictEqual([a.state, a.outcome, a.type, a.run_id], ['open', 'unknown', 'review', 'review-open']);
        ok(typeof a.registered_at === 'string');
        strictEqual((await view(ctx.workflowPath)).attempts.length, 1, 'investigate is no review');
        strictEqual(reviewOutcomeFor(await fm(ctx.workflowPath), 'review-open'), 'unknown');
      });
    });
  });

  describe(`${persona}: settle records one outcome per launched attempt`, () => {
    for (const [verdict, outcome] of [['agreed', 'passed'], ['concerns', 'concerns'], ['conflict', 'conflict'], ['regression', 'concerns']]) {
      it(`a completed run with verdict ${verdict}: ${outcome}, the raw verdict kept`, async () => {
        await withWorkflow(async (ctx) => {
          const run = await reviewRun(ctx, `review-${verdict}`);
          strictEqual(run.status, 'completed');
          await settle(ctx, `review-${verdict}`, { verdict, summary: 'synthesis' });
          const a = await attempt(ctx.workflowPath, `review-${verdict}`);
          deepStrictEqual([a.state, a.outcome, a.verdict, a.status], ['closed', outcome, verdict, 'completed']);
          // The runner ran in a directory that is no checkout: no snapshot.
          deepStrictEqual([a.tree, a.tree_reason], [null, 'not-isolated']);
        });
      });
    }

    it('a missing peer CLI: unavailable (the legacy row still says failed)', async () => {
      await withWorkflow(async (ctx) => {
        ctx.companions = await writeCompanions(ctx.repoRoot, { missing: true });
        await reviewRun(ctx, 'review-missing');
        strictEqual((await attempt(ctx.workflowPath, 'review-missing')).outcome, 'unknown', 'open until settled');
        await settle(ctx, 'review-missing', { verdict: 'agreed', summary: 'all good' });
        const a = await attempt(ctx.workflowPath, 'review-missing');
        deepStrictEqual([a.outcome, a.error_kind, a.reason, a.status], ['unavailable', 'peer_cli_not_found', 'peer_cli_not_found', 'failed']);
        strictEqual((await fm(ctx.workflowPath)).ensemble_results[0].verdict, 'failed');
      });
    });

    it('an envelope that does not parse: malformed', async () => {
      await withWorkflow(async (ctx) => {
        await reviewRun(ctx, 'review-malformed', { FAKE_COMPANION_MODE: 'malformed' });
        await settle(ctx, 'review-malformed', { verdict: 'agreed', summary: 's' });
        const a = await attempt(ctx.workflowPath, 'review-malformed');
        deepStrictEqual([a.outcome, a.error_kind], ['malformed', 'envelope_parse_error']);
      });
    });

    // The runbooks' rule: an answer that parses to nothing usable reads to
    // settle like any other, and the synthesis passes verdict `degraded`.
    it('a completed run the synthesis judged unusable (verdict degraded): degraded, verdict-degraded', async () => {
      await withWorkflow(async (ctx) => {
        const run = await reviewRun(ctx, 'review-judged-degraded');
        strictEqual(run.status, 'completed');
        await settle(ctx, 'review-judged-degraded', { verdict: 'degraded', summary: 'only structural shell' });
        const a = await attempt(ctx.workflowPath, 'review-judged-degraded');
        deepStrictEqual([a.state, a.outcome, a.reason, a.verdict, a.status], ['closed', 'degraded', 'verdict-degraded', 'degraded', 'completed']);
      });
    });

    it('an empty answer: degraded', async () => {
      await withWorkflow(async (ctx) => {
        await reviewRun(ctx, 'review-empty', { FAKE_COMPANION_MODE: 'json-empty' });
        await settle(ctx, 'review-empty', { verdict: 'agreed', summary: 's' });
        const a = await attempt(ctx.workflowPath, 'review-empty');
        deepStrictEqual([a.outcome, a.reason], ['degraded', 'answer-empty']);
      });
    });

    it('a run that failed otherwise: failed with its error kind, and the tree its snapshot held, not the checkout now', async () => {
      await withWorkflow(async (ctx) => {
        await recordPendingEnsemble({ workflowPath: ctx.workflowPath, phase: 'critique', ensemble_type: 'review', run_id: 'review-failed' });
        await leftBehind(ctx, 'review-failed', {
          snapshot: { isolation: 'snapshot', reason: null, root: null, peer_cwd: null, head: HEAD, index_tree: INDEX_TREE, worktree_tree: WORKTREE_TREE, owner_path: null, supervisor: null, removed_at: null, cleanup_error: null, prompt_paths_rewritten: 0 },
        });
        await settle(ctx, 'review-failed', {});
        const a = await attempt(ctx.workflowPath, 'review-failed');
        deepStrictEqual([a.outcome, a.reason], ['failed', 'peer_run_error']);
        deepStrictEqual(a.tree, { head: HEAD, index_tree: INDEX_TREE, worktree_tree: WORKTREE_TREE });
        ok(a.registered_at, 'the registration is kept when the attempt closes');
      });
    });

    // A checkout with no commit yet: the runner still isolates the peer in a
    // snapshot, which has no head and does have the trees it took.
    it('a snapshot of an unborn branch keeps its trees, with no head, through the real runner', async () => {
      await withWorkflow(async (ctx) => {
        const checkout = join(ctx.repoRoot, 'unborn');
        await mkdir(checkout);
        const git = (...args) => {
          const r = spawnSync('git', args, { cwd: checkout, encoding: 'utf8', env: cleanEnv() });
          strictEqual(r.status, 0, r.stderr);
          return r.stdout.trim();
        };
        git('init', '-q');
        await writeFile(join(checkout, 'file.txt'), 'under review\n');
        git('add', 'file.txt');
        const run = await runPeer({
          repoRoot: ctx.repoRoot, runId: 'review-unborn', kind: 'ensemble', workflowPath: ctx.workflowPath, phase: 'critique',
          ensembleType: 'review', host: 'claude', peer: 'codex', promptText: '<task>review</task>', outputFormat: 'json',
          cwd: checkout, env: { ...cleanEnv(), AGENTIC_COMPANIONS_ROOT: ctx.companions },
        });
        strictEqual(run.status, 'completed');
        await settle(ctx, 'review-unborn', { verdict: 'agreed', summary: 's' });
        const a = await attempt(ctx.workflowPath, 'review-unborn');
        deepStrictEqual([a.outcome, a.tree_reason, a.tree?.head], ['passed', undefined, null], JSON.stringify(a));
        strictEqual(a.tree.index_tree, git('write-tree'), 'the index the snapshot isolated');
        ok(/^[0-9a-f]{40,64}$/.test(a.tree.worktree_tree), a.tree.worktree_tree);
      });
    });

    it('a ledger that is gone: failed, ledger_missing, no tree with its reason', async () => {
      await withWorkflow(async (ctx) => {
        await recordPendingEnsemble({ workflowPath: ctx.workflowPath, phase: 'critique', ensemble_type: 'review', run_id: 'review-gone' });
        await settle(ctx, 'review-gone', {});
        const a = await attempt(ctx.workflowPath, 'review-gone');
        deepStrictEqual([a.outcome, a.reason, a.tree, a.tree_reason], ['failed', 'ledger_missing', null, 'evidence-missing']);
      });
    });

    it('a repeat settle keeps the first outcome', async () => {
      await withWorkflow(async (ctx) => {
        await reviewRun(ctx, 'review-twice');
        await settle(ctx, 'review-twice', { verdict: 'concerns', summary: 's' });
        await settle(ctx, 'review-twice', { verdict: 'agreed', summary: 's' });
        const doc = JSON.parse((await fm(ctx.workflowPath)).review_attempts);
        strictEqual(doc.attempts.length, 1);
        strictEqual(doc.attempts[0].outcome, 'concerns');
      });
    });
  });

  describe(`${persona}: a review that never launched`, () => {
    it('is recorded with its reason, once per finalize, and adds no legacy row or pending entry', async () => {
      await withWorkflow(async (ctx) => {
        const key = await mkdtemp(join(tmpdir(), 'review-key-'));
        try {
          const s = await settle(ctx, '', { ensembleType: 'review', noRunReason: 'local-only', attemptKey: key });
          strictEqual(s.settlement, 'skipped');
          strictEqual(s.outcome, 'skipped');
          ok(/^review-norun-[0-9a-f]{16}$/.test(s.attempt_id), s.attempt_id);
          const again = await settle(ctx, '', { ensembleType: 'review', noRunReason: 'local-only', attemptKey: key });
          strictEqual(again.attempt_id, s.attempt_id);
          const v = await view(ctx.workflowPath);
          strictEqual(v.attempts.length, 1);
          deepStrictEqual([v.attempts[0].outcome, v.attempts[0].reason, v.attempts[0].tree, v.attempts[0].tree_reason], ['skipped', 'local-only', null, 'no-launch']);
          const f = await fm(ctx.workflowPath);
          deepStrictEqual([f.ensemble_results ?? [], f.pending_ensemble ?? []], [[], []]);
        } finally {
          await rm(key, { recursive: true, force: true });
        }
      });
    });

    it('a rerun of the same attempt with another reason keeps the first outcome, and reports the one kept', async () => {
      await withWorkflow(async (ctx) => {
        const key = await mkdtemp(join(tmpdir(), 'review-key-'));
        try {
          const s = await settle(ctx, '', { ensembleType: 'review', noRunReason: 'local-only', attemptKey: key });
          strictEqual(s.outcome, 'skipped');
          const again = await settle(ctx, '', { ensembleType: 'review', noRunReason: 'peer-unavailable', attemptKey: key });
          deepStrictEqual([again.attempt_id, again.outcome], [s.attempt_id, 'skipped']);
          const v = await view(ctx.workflowPath);
          deepStrictEqual(v.attempts.map((a) => [a.id, a.outcome, a.reason]), [[s.attempt_id, 'skipped', 'local-only']]);
        } finally {
          await rm(key, { recursive: true, force: true });
        }
      });
    });

    it('a peer that was never found: unavailable, through the CLI', async () => {
      await withWorkflow(async (ctx) => {
        const r = spawnSync(process.execPath, [RUNNER, 'settle', '--repo-root', ctx.repoRoot, '--workflow-path', ctx.workflowPath,
          '--phase', 'critique', '--run-id', '', '--ensemble-type', 'review', '--no-run-reason', 'peer-unavailable', '--attempt-key', ctx.repoRoot],
        { encoding: 'utf8', env: cleanEnv() });
        strictEqual(r.status, 0, r.stderr);
        strictEqual(JSON.parse(r.stdout).outcome, 'unavailable');
        const [a] = (await view(ctx.workflowPath)).attempts;
        deepStrictEqual([a.outcome, a.reason], ['unavailable', 'peer-unavailable']);
      });
    });

    it('a word that is no reason, or no key, is refused before any write; no type, or another type, records nothing', async () => {
      await withWorkflow(async (ctx) => {
        const before = await readFile(ctx.workflowPath, 'utf8');
        await rejects(settle(ctx, '', { ensembleType: 'review', noRunReason: 'because', attemptKey: ctx.repoRoot }), (e) => e instanceof SettleRefusal && /--no-run-reason "because" is not one of/.test(e.message));
        await rejects(settle(ctx, '', { ensembleType: 'review', noRunReason: 'local-only' }), (e) => e instanceof SettleRefusal && /--attempt-key/.test(e.message));
        strictEqual((await settle(ctx, '')).settlement, 'skipped');
        strictEqual((await settle(ctx, '', { ensembleType: 'investigate', attemptKey: ctx.repoRoot })).settlement, 'skipped');
        strictEqual(await readFile(ctx.workflowPath, 'utf8'), before);
      });
    });

    it('a review with no reason given is recorded skipped, reason unspecified (records only: no step is refused)', async () => {
      await withWorkflow(async (ctx) => {
        const s = await settle(ctx, '', { ensembleType: 'refine-verify', attemptKey: ctx.repoRoot });
        deepStrictEqual([s.settlement, s.outcome], ['skipped', 'skipped']);
        const [a] = (await view(ctx.workflowPath)).attempts;
        deepStrictEqual([a.type, a.outcome, a.reason], ['refine-verify', 'skipped', 'unspecified']);
      });
    });
  });

  describe(`${persona}: superseded`, () => {
    it('an open attempt replaced by another reads superseded, with its replacement; a closed one keeps its outcome', async () => {
      await withWorkflow(async (ctx) => {
        await recordPendingEnsemble({ workflowPath: ctx.workflowPath, phase: 'critique', ensemble_type: 'review', run_id: 'review-old' });
        const r = spawnSync(process.execPath, [STATE, 'review-attempt-supersede', '--workflow-path', ctx.workflowPath, '--attempt-id', 'review-old', '--superseded-by', 'review-new'], { encoding: 'utf8', env: cleanEnv() });
        strictEqual(r.status, 0, r.stderr);
        const a = await attempt(ctx.workflowPath, 'review-old');
        deepStrictEqual([a.outcome, a.superseded_by], ['superseded', 'review-new']);
        strictEqual((await fm(ctx.workflowPath)).pending_ensemble.length, 1, 'records only: the pending row stays for its settle');
        const again = await supersedeReviewAttempt({ workflowPath: ctx.workflowPath, attemptId: 'review-old', supersededBy: 'review-other' });
        strictEqual(again.changed, false);
        strictEqual((await attempt(ctx.workflowPath, 'review-old')).superseded_by, 'review-new');
      });
    });
  });

  describe(`${persona}: retention and old records`, () => {
    // Attempts of the size real ones have: a runner's run id, registered at
    // dispatch, closed with its status and the tree of its snapshot. The byte
    // cap must keep at least as many as the 20-row results list would.
    it('past 20 results, every attempt is kept and the history stays complete', async () => {
      await withWorkflow(async (ctx) => {
        const ids = [];
        for (let i = 0; i < 25; i++) {
          const n = String(i).padStart(2, '0');
          const runId = `review-20261101T0000${n}Z-${n}a1b2`;
          ids.push(runId);
          await recordPendingEnsemble({ workflowPath: ctx.workflowPath, phase: 'critique', ensemble_type: 'review', run_id: runId });
          await commitEnsemble({
            workflowPath: ctx.workflowPath, run_id: runId, phase: 'critique', ensemble_type: 'review', verdict: i % 2 ? 'agreed' : 'concerns', summary: 's',
            completed_at: `2026-11-01T00:00:${n}Z`,
            review: { outcome: i % 2 ? 'passed' : 'concerns', status: 'completed', tree: { head: HEAD, index_tree: INDEX_TREE, worktree_tree: WORKTREE_TREE }, tree_reason: null },
          });
        }
        const f = await fm(ctx.workflowPath);
        strictEqual(f.ensemble_results.length, 20);
        const v = projectReviewOutcomes(f);
        deepStrictEqual(v.attempts.map((a) => a.id), ids, 'every attempt is kept');
        strictEqual(v.attempts[0].outcome, 'concerns', 'the pruned result keeps its outcome');
        ok(v.attempts.every((a) => a.registered_at && a.tree?.head === HEAD), 'each keeps its registration and tree');
        deepStrictEqual(v.coverage, { history_incomplete: false, reasons: [] });
        deepStrictEqual(v.legacy, []);
        // The attempts are full-size: a document of tiny ones proves nothing
        // about the cap (25 of these take more than 10 KB).
        ok(Buffer.byteLength(f.review_attempts, 'utf8') > 10000, String(Buffer.byteLength(f.review_attempts, 'utf8')));
      });
    });

    // A workflow whose 20 kept results hold no review: earlier reviews, by a
    // writer before this record, were pruned by later commits of other types.
    // A document begun now cannot know them, so it is incomplete from the
    // start, and nothing else would say so (no review row is left to miss).
    it('a document begun when the full results list holds no review is incomplete from the start', async () => {
      await withWorkflow(async (ctx) => {
        for (let i = 0; i < 20; i++) {
          await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: `investigate-${String(i).padStart(2, '0')}`, phase: 'investigate', ensemble_type: 'investigate', verdict: 'agreed', summary: 's', completed_at: `2026-11-02T00:00:${String(i).padStart(2, '0')}Z` });
        }
        const before = await fm(ctx.workflowPath);
        strictEqual(before.review_attempts, undefined, 'no review yet, no document');
        // The reader, before any document: the full list may have lost reviews.
        deepStrictEqual(projectReviewOutcomes(before).coverage, { history_incomplete: true, reasons: ['pre-instrumentation'] });
        await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: 'review-after', phase: 'critique', ensemble_type: 'review', verdict: 'agreed', summary: 's', completed_at: '2026-11-03T00:00:00Z', ...ev('passed') });
        const after = await fm(ctx.workflowPath);
        deepStrictEqual(JSON.parse(after.review_attempts).coverage, { history_incomplete: true, reasons: ['pre-instrumentation'] });
        deepStrictEqual(projectReviewOutcomes(after).coverage, { history_incomplete: true, reasons: ['pre-instrumentation'] });
        strictEqual(reviewOutcomeFor(after, 'review-after'), 'passed');
      });
    });

    it('a review result with no attempt reads unknown, never passed, and the history incomplete', async () => {
      await withWorkflow(async (ctx) => {
        const f = await fm(ctx.workflowPath);
        f.ensemble_results = [{ phase: 'critique', ensemble_type: 'review', run_id: 'review-legacy', verdict: 'agreed', summary: 's', completed_at: '2026-10-01T00:00:00Z' },
          { phase: 'investigate', ensemble_type: 'investigate', run_id: 'investigate-legacy', verdict: 'agreed', summary: 's', completed_at: '2026-10-01T00:00:00Z' }];
        const v = projectReviewOutcomes(f);
        deepStrictEqual(v.legacy.map((r) => [r.run_id, r.outcome]), [['review-legacy', 'unknown']]);
        deepStrictEqual(v.coverage, { history_incomplete: true, reasons: ['pre-instrumentation'] });
        strictEqual(reviewOutcomeFor(f, 'review-legacy'), 'unknown');
      });
    });

    it('a document begun after earlier reviews is incomplete from the start', async () => {
      await withWorkflow(async (ctx) => {
        // An older writer settled a review: a result and no document.
        const text = await readFile(ctx.workflowPath, 'utf8');
        const f = parseWorkflowFile(text).frontmatter;
        strictEqual(f.review_attempts, undefined);
        await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: 'review-a', phase: 'critique', ensemble_type: 'review', verdict: 'agreed', summary: 's', ...ev('passed') });
        const doc = JSON.parse((await fm(ctx.workflowPath)).review_attempts);
        deepStrictEqual(doc.coverage, { history_incomplete: false, reasons: [] });
        // Now remove the document, as an older writer's file would hold, and record another.
        const g = await fm(ctx.workflowPath);
        delete g.review_attempts;
        const { body } = parseWorkflowFile(await readFile(ctx.workflowPath, 'utf8'));
        const { assembleWorkflowFile } = await import(pathToFileURL(STATE).href);
        await writeFile(ctx.workflowPath, assembleWorkflowFile(g, body));
        await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: 'review-b', phase: 'critique', ensemble_type: 'review', verdict: 'agreed', summary: 's', ...ev('passed') });
        const v = await view(ctx.workflowPath);
        // Begun after review-a, whose result is still listed with no attempt.
        deepStrictEqual(v.coverage.reasons, ['pre-instrumentation', 'missing-outcome']);
        strictEqual(reviewOutcomeFor(await fm(ctx.workflowPath), 'review-a'), 'unknown');
        strictEqual(reviewOutcomeFor(await fm(ctx.workflowPath), 'review-b'), 'passed');
      });
    });

    it('an attempt an older writer settled without closing reads unknown (legacy-writer)', async () => {
      await withWorkflow(async (ctx) => {
        await recordPendingEnsemble({ workflowPath: ctx.workflowPath, phase: 'critique', ensemble_type: 'review', run_id: 'review-mixed' });
        const f = await fm(ctx.workflowPath);
        f.ensemble_results = [{ phase: 'critique', ensemble_type: 'review', run_id: 'review-mixed', verdict: 'agreed', summary: 's', completed_at: '2026-11-01T00:00:00Z' }];
        const v = projectReviewOutcomes(f);
        strictEqual(v.attempts[0].outcome, 'unknown');
        ok(v.coverage.reasons.includes('legacy-writer'), JSON.stringify(v.coverage));
      });
    });

    it('a corrupt or later-version document leaves the workflow readable, reads unknown, and is never rewritten', async () => {
      await withWorkflow(async (ctx) => {
        for (const raw of ['{ torn', JSON.stringify({ v: 2, attempts: [{ id: 'x' }] })]) {
          const text = await readFile(ctx.workflowPath, 'utf8');
          const { frontmatter: f, body } = parseWorkflowFile(text);
          f.review_attempts = raw;
          const { assembleWorkflowFile } = await import(pathToFileURL(STATE).href);
          await writeFile(ctx.workflowPath, assembleWorkflowFile(f, body));
          // A commit that closes an attempt (run evidence, the write path) and
          // one that only records gaps (another type) each leave it as it was.
          await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: `review-${raw.length}`, phase: 'critique', ensemble_type: 'review', verdict: 'agreed', summary: 's', ...ev('passed') });
          strictEqual((await fm(ctx.workflowPath)).review_attempts, raw, 'a closing commit leaves it as it was');
          await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: `investigate-${raw.length}`, phase: 'investigate', ensemble_type: 'investigate', verdict: 'agreed', summary: 's' });
          const after = await fm(ctx.workflowPath);
          strictEqual(after.review_attempts, raw, 'left as it was');
          const v = projectReviewOutcomes(after);
          ok(['unreadable', 'later-version'].includes(v.document), v.document);
          strictEqual(v.legacy.find((r) => r.run_id === `review-${raw.length}`).outcome, 'unknown');
          strictEqual(v.coverage.history_incomplete, true);
        }
        const r = spawnSync(process.execPath, [STATE, 'review-attempts', '--workflow-path', ctx.workflowPath], { encoding: 'utf8', env: cleanEnv() });
        strictEqual(r.status, 0, r.stderr);
        strictEqual(JSON.parse(r.stdout).document, 'later-version');
      });
    });
  });

  describe(`${persona}: what a writer must not make up, and must not lose (plan-verify review)`, () => {
    it('a repeat commit of a legacy result makes no outcome of its own: the row stays unknown', async () => {
      await withWorkflow(async (ctx) => {
        const text = await readFile(ctx.workflowPath, 'utf8');
        const { frontmatter: f, body } = parseWorkflowFile(text);
        f.ensemble_results = [{ phase: 'critique', ensemble_type: 'review', run_id: 'review-legacy', verdict: 'concerns', summary: 's', completed_at: '2026-10-01T00:00:00Z', codex_session_id: null }];
        const { assembleWorkflowFile } = await import(pathToFileURL(STATE).href);
        await writeFile(ctx.workflowPath, assembleWorkflowFile(f, body));
        // With run evidence, as a settle that lost the race to that row passes it.
        const out = await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: 'review-legacy', phase: 'critique', ensemble_type: 'review', verdict: 'agreed', summary: 's', ...ev('passed') });
        strictEqual(out.idempotentSkip, true);
        strictEqual(reviewOutcomeFor(await fm(ctx.workflowPath), 'review-legacy'), 'unknown');
        deepStrictEqual((await view(ctx.workflowPath)).attempts, []);
      });
    });

    it('a gap the results showed outlives the row once it is pruned', async () => {
      await withWorkflow(async (ctx) => {
        await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: 'review-first', phase: 'critique', ensemble_type: 'review', verdict: 'agreed', summary: 's', completed_at: '2026-11-01T00:00:00Z', ...ev('passed') });
        // An older writer settles a review: a result row, no attempt.
        const { frontmatter: f, body } = parseWorkflowFile(await readFile(ctx.workflowPath, 'utf8'));
        f.ensemble_results.push({ phase: 'critique', ensemble_type: 'review', run_id: 'review-older-writer', verdict: 'agreed', summary: 's', completed_at: '2026-11-01T00:00:01Z', codex_session_id: null });
        const { assembleWorkflowFile } = await import(pathToFileURL(STATE).href);
        await writeFile(ctx.workflowPath, assembleWorkflowFile(f, body));
        for (let i = 0; i < 21; i++) {
          await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: `review-${String(i).padStart(2, '0')}`, phase: 'critique', ensemble_type: 'review', verdict: 'agreed', summary: 's', completed_at: `2026-11-02T00:00:${String(i).padStart(2, '0')}Z`, ...ev('passed') });
        }
        const after = await fm(ctx.workflowPath);
        ok(!after.ensemble_results.some((r) => r.run_id === 'review-older-writer'), 'the row is pruned');
        const v = projectReviewOutcomes(after);
        deepStrictEqual([v.coverage.history_incomplete, v.coverage.reasons], [true, ['missing-outcome']]);
      });
    });

    // An older writer (a release before this record, on the other host, say)
    // settles a review beside a document of this version: the document never
    // heard of it, so only the reader can say its outcome is missing.
    it('a review row an older writer added beside the document reads missing-outcome to a reader, before any write records it', async () => {
      await withWorkflow(async (ctx) => {
        await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: 'review-first', phase: 'critique', ensemble_type: 'review', verdict: 'agreed', summary: 's', completed_at: '2026-11-01T00:00:00Z', ...ev('passed') });
        const { frontmatter: f, body } = parseWorkflowFile(await readFile(ctx.workflowPath, 'utf8'));
        f.ensemble_results.push({ phase: 'critique', ensemble_type: 'review', run_id: 'review-older-writer', verdict: 'failed', summary: 's', completed_at: '2026-11-01T00:00:01Z', codex_session_id: null });
        const { assembleWorkflowFile } = await import(pathToFileURL(STATE).href);
        await writeFile(ctx.workflowPath, assembleWorkflowFile(f, body));
        const g = await fm(ctx.workflowPath);
        deepStrictEqual(JSON.parse(g.review_attempts).coverage, { history_incomplete: false, reasons: [] }, 'the stored document never saw the row');
        const v = projectReviewOutcomes(g);
        deepStrictEqual(v.coverage, { history_incomplete: true, reasons: ['missing-outcome'] });
        deepStrictEqual(v.legacy.map((r) => [r.run_id, r.outcome]), [['review-older-writer', 'unknown']]);
      });
    });

    // The same older writer then prunes that row away with 20 commits of its
    // own: the row that showed the gap is gone, and no writer of this version
    // saw it. The marker a reader already saw must stay, through later writes.
    it('a gap a reader saw is never withdrawn when an older writer prunes its row unseen', async () => {
      await withWorkflow(async (ctx) => {
        const { assembleWorkflowFile, pruneEnsembleResults } = await import(pathToFileURL(STATE).href);
        await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: 'review-first', phase: 'critique', ensemble_type: 'review', verdict: 'agreed', summary: 's', completed_at: '2026-11-01T00:00:00Z', ...ev('passed') });
        const olderWriter = async (rows) => {
          const { frontmatter: f, body } = parseWorkflowFile(await readFile(ctx.workflowPath, 'utf8'));
          f.ensemble_results = pruneEnsembleResults([...f.ensemble_results, ...rows], 20);
          await writeFile(ctx.workflowPath, assembleWorkflowFile(f, body));
        };
        await olderWriter([{ phase: 'critique', ensemble_type: 'review', run_id: 'review-older-writer', verdict: 'failed', summary: 's', completed_at: '2026-11-01T00:00:01Z', codex_session_id: null }]);
        deepStrictEqual(projectReviewOutcomes(await fm(ctx.workflowPath)).coverage, { history_incomplete: true, reasons: ['missing-outcome'] }, 'a reader sees the gap');
        await olderWriter(Array.from({ length: 20 }, (_, i) => ({ phase: 'investigate', ensemble_type: 'investigate', run_id: `investigate-${String(i).padStart(2, '0')}`, verdict: 'agreed', summary: 's', completed_at: `2026-11-02T00:00:${String(i).padStart(2, '0')}Z`, codex_session_id: null })));
        const pruned = await fm(ctx.workflowPath);
        ok(!pruned.ensemble_results.some((r) => r.ensemble_type === 'review'), 'every review row is pruned');
        deepStrictEqual(JSON.parse(pruned.review_attempts).coverage, { history_incomplete: false, reasons: [] }, 'the stored document never saw it');
        deepStrictEqual(projectReviewOutcomes(pruned).coverage, { history_incomplete: true, reasons: ['pruned-unseen'] }, 'the reader still sees a gap');
        // A writer of this version, after: a commit of another type, then a review.
        await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: 'investigate-new', phase: 'investigate', ensemble_type: 'investigate', verdict: 'agreed', summary: 's', completed_at: '2026-11-03T00:00:00Z' });
        deepStrictEqual(JSON.parse((await fm(ctx.workflowPath)).review_attempts).coverage, { history_incomplete: true, reasons: ['pruned-unseen'] }, 'the write keeps the gap');
        await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: 'review-new', phase: 'critique', ensemble_type: 'review', verdict: 'agreed', summary: 's', completed_at: '2026-11-03T00:00:01Z', ...ev('passed') });
        const after = await fm(ctx.workflowPath);
        deepStrictEqual(projectReviewOutcomes(after).coverage, { history_incomplete: true, reasons: ['pruned-unseen'] });
        strictEqual(reviewOutcomeFor(after, 'review-new'), 'passed');
      });
    });

    // The runner takes a run id of any length; the attempt document holds
    // ids up to 160 characters. The watermark must take any id a row can
    // have, or a full list of this version's writes reads as rows lost.
    it('a run id past 160 characters as the newest row is a watermark like any other: no pruned-unseen', async () => {
      await withWorkflow(async (ctx) => {
        await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: 'review-first', phase: 'critique', ensemble_type: 'review', verdict: 'agreed', summary: 's', completed_at: '2026-11-01T00:00:00Z', ...ev('passed') });
        for (let i = 0; i < 18; i++) {
          await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: `investigate-${String(i).padStart(2, '0')}`, phase: 'investigate', ensemble_type: 'investigate', verdict: 'agreed', summary: 's', completed_at: `2026-11-02T00:00:${String(i).padStart(2, '0')}Z` });
        }
        const longId = `investigate-${'x'.repeat(150)}`;
        strictEqual(longId.length, 162);
        await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: longId, phase: 'investigate', ensemble_type: 'investigate', verdict: 'agreed', summary: 's', completed_at: '2026-11-03T00:00:00Z' });
        const f = await fm(ctx.workflowPath);
        strictEqual(f.ensemble_results.length, 20, 'a full list, nothing pruned');
        strictEqual(JSON.parse(f.review_attempts).seen, longId);
        deepStrictEqual(projectReviewOutcomes(f).coverage, { history_incomplete: false, reasons: [] });
        await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: 'investigate-after', phase: 'investigate', ensemble_type: 'investigate', verdict: 'agreed', summary: 's', completed_at: '2026-11-03T00:00:01Z' });
        deepStrictEqual(projectReviewOutcomes(await fm(ctx.workflowPath)).coverage, { history_incomplete: false, reasons: [] });
      });
    });

    // A row with an older completed_at than the 20 kept is pruned by the write
    // that appends it: its gap is read from the list the prune cuts.
    it('a review row appended and pruned in the same write still leaves its gap', async () => {
      await withWorkflow(async (ctx) => {
        for (let i = 0; i < 20; i++) {
          await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: `review-${String(i).padStart(2, '0')}`, phase: 'critique', ensemble_type: 'review', verdict: 'agreed', summary: 's', completed_at: `2026-11-02T00:00:${String(i).padStart(2, '0')}Z`, ...ev('passed') });
        }
        deepStrictEqual(projectReviewOutcomes(await fm(ctx.workflowPath)).coverage, { history_incomplete: false, reasons: [] });
        // Only a verdict (no run evidence), and older than every kept row.
        await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: 'review-older', phase: 'critique', ensemble_type: 'review', verdict: 'agreed', summary: 's', completed_at: '2026-10-01T00:00:00Z' });
        const after = await fm(ctx.workflowPath);
        ok(!after.ensemble_results.some((r) => r.run_id === 'review-older'), 'pruned by the write that appended it');
        deepStrictEqual(JSON.parse(after.review_attempts).coverage, { history_incomplete: true, reasons: ['missing-outcome'] });
      });
    });

    // A run id the runner takes and the document cannot hold (past 160
    // characters): the attempt is refused, and its pruned row's gap is kept.
    it('an attempt the document refuses still leaves the gap of its pruned row', async () => {
      await withWorkflow(async (ctx) => {
        for (let i = 0; i < 20; i++) {
          await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: `review-${String(i).padStart(2, '0')}`, phase: 'critique', ensemble_type: 'review', verdict: 'agreed', summary: 's', completed_at: `2026-11-02T00:00:${String(i).padStart(2, '0')}Z`, ...ev('passed') });
        }
        const longId = `review-${'x'.repeat(155)}`;
        strictEqual(longId.length, 162);
        await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: longId, phase: 'critique', ensemble_type: 'review', verdict: 'agreed', summary: 's', completed_at: '2026-10-01T00:00:00Z', ...ev('passed') });
        const after = await fm(ctx.workflowPath);
        ok(!after.ensemble_results.some((r) => r.run_id === longId), 'pruned by the write that appended it');
        const doc = JSON.parse(after.review_attempts);
        ok(!doc.attempts.some((a) => a.id === longId), 'the attempt is refused');
        deepStrictEqual(doc.coverage, { history_incomplete: true, reasons: ['missing-outcome'] });
      });
    });

    it('a superseded attempt keeps its outcome and takes the tree its settlement read', async () => {
      await withWorkflow(async (ctx) => {
        await recordPendingEnsemble({ workflowPath: ctx.workflowPath, phase: 'critique', ensemble_type: 'review', run_id: 'review-sup' });
        await supersedeReviewAttempt({ workflowPath: ctx.workflowPath, attemptId: 'review-sup', supersededBy: 'review-next' });
        await leftBehind(ctx, 'review-sup', {
          snapshot: { isolation: 'snapshot', reason: null, root: null, peer_cwd: null, head: HEAD, index_tree: INDEX_TREE, worktree_tree: WORKTREE_TREE, owner_path: null, supervisor: null, removed_at: null, cleanup_error: null, prompt_paths_rewritten: 0 },
        });
        await settle(ctx, 'review-sup', {});
        const a = await attempt(ctx.workflowPath, 'review-sup');
        deepStrictEqual([a.outcome, a.superseded_by, a.tree, a.tree_reason], ['superseded', 'review-next', { head: HEAD, index_tree: INDEX_TREE, worktree_tree: WORKTREE_TREE }, undefined]);
      });
    });

    it('a supersede naming no attempt id fails, and the attempt stays open', async () => {
      await withWorkflow(async (ctx) => {
        await recordPendingEnsemble({ workflowPath: ctx.workflowPath, phase: 'critique', ensemble_type: 'review', run_id: 'review-keep' });
        const r = spawnSync(process.execPath, [STATE, 'review-attempt-supersede', '--workflow-path', ctx.workflowPath, '--attempt-id', 'review-keep', '--superseded-by', 'not an id'], { encoding: 'utf8', env: cleanEnv() });
        ok(r.status !== 0, r.stdout);
        strictEqual((await attempt(ctx.workflowPath, 'review-keep')).state, 'open');
      });
    });

    it('a rerun of the same finalize through a linked directory names the same attempt', async () => {
      await withWorkflow(async (ctx) => {
        // A link to the workflows directory (as /var and /private/var on
        // macOS): another spelling of the same file.
        const alias = join(ctx.repoRoot, 'alias');
        await symlink(dirname(ctx.workflowPath), alias);
        const link = join(alias, basename(ctx.workflowPath));
        const a = await settle(ctx, '', { ensembleType: 'review', noRunReason: 'local-only', attemptKey: ctx.repoRoot });
        const b = await settleEnsemble({ repoRoot: ctx.repoRoot, workflowPath: link, phase: 'critique', runId: '', ensembleType: 'review', noRunReason: 'local-only', attemptKey: ctx.repoRoot });
        strictEqual(b.attempt_id, a.attempt_id);
        strictEqual((await view(ctx.workflowPath)).attempts.length, 1);
      });
    });

    it('a run whose prompt cannot be read records its attempt failed, prompt_unreadable', async () => {
      await withWorkflow(async (ctx) => {
        const run = await runPeer({
          repoRoot: ctx.repoRoot, runId: 'review-noprompt', kind: 'ensemble', workflowPath: ctx.workflowPath, phase: 'critique',
          ensembleType: 'review', host: 'claude', peer: 'codex', promptFile: join(ctx.repoRoot, 'missing.xml'), outputFormat: 'json',
          cwd: ctx.repoRoot, env: { ...process.env, AGENTIC_COMPANIONS_ROOT: ctx.companions },
        });
        strictEqual(run.error_kind, 'prompt_unreadable');
        const a = await attempt(ctx.workflowPath, 'review-noprompt');
        deepStrictEqual([a.state, a.outcome, a.reason], ['closed', 'failed', 'prompt_unreadable']);
      });
    });

    // An attempt this writer registered, whose result an older writer
    // committed without closing it: the verdict in that row is no evidence
    // of how the run went, so neither a repeat commit nor a repeat settle
    // turns it into an outcome.
    it('a repeat over an older writer\'s result leaves the open attempt unknown, never passed, and says legacy-writer', async () => {
      await withWorkflow(async (ctx) => {
        await recordPendingEnsemble({ workflowPath: ctx.workflowPath, phase: 'critique', ensemble_type: 'review', run_id: 'review-older' });
        const { frontmatter: f, body } = parseWorkflowFile(await readFile(ctx.workflowPath, 'utf8'));
        f.ensemble_results = [{ phase: 'critique', ensemble_type: 'review', run_id: 'review-older', verdict: 'agreed', summary: 's', completed_at: '2026-11-01T00:00:00Z', codex_session_id: null }];
        const { assembleWorkflowFile } = await import(pathToFileURL(STATE).href);
        await writeFile(ctx.workflowPath, assembleWorkflowFile(f, body));
        // With run evidence, as a settle that lost the race to that row passes it.
        const out = await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: 'review-older', phase: 'critique', ensemble_type: 'review', verdict: 'agreed', summary: 's', ...ev('passed') });
        strictEqual(out.idempotentSkip, true);
        await settle(ctx, 'review-older', { verdict: 'agreed', summary: 's' });
        const doc = JSON.parse((await fm(ctx.workflowPath)).review_attempts);
        deepStrictEqual(doc.attempts.map((a) => [a.id, a.state, a.outcome]), [['review-older', 'open', undefined]]);
        strictEqual(reviewOutcomeFor(await fm(ctx.workflowPath), 'review-older'), 'unknown');
        deepStrictEqual(doc.coverage, { history_incomplete: true, reasons: ['legacy-writer'] });
      });
    });

    it('a commit with only a verdict (an in-process caller with no run evidence) records no outcome: the row reads unknown, never passed', async () => {
      await withWorkflow(async (ctx) => {
        await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: 'review-never-ran', phase: 'critique', ensemble_type: 'review', verdict: 'agreed', summary: 'looks fine' });
        const f = await fm(ctx.workflowPath);
        strictEqual(f.ensemble_results[0].verdict, 'agreed', 'the legacy row is unchanged');
        strictEqual(reviewOutcomeFor(f, 'review-never-ran'), 'unknown');
        const v = projectReviewOutcomes(f);
        deepStrictEqual([v.attempts.length, v.legacy.map((x) => [x.run_id, x.outcome])], [0, [['review-never-ran', 'unknown']]]);
        strictEqual(v.coverage.history_incomplete, true);
      });
    });

    // The remedy the autopilot halt names for a pending ensemble left behind:
    // a hand commit through the CLI, which reads no run ledger. The attempt
    // closes failed (verdict-only) whatever the verdict says, never passed,
    // and is never left open for good with an older writer blamed.
    it('the ensemble-commit CLI closes a review attempt failed (verdict-only), never passed, and a later settle keeps it', async () => {
      await withWorkflow(async (ctx) => {
        const cli = (runId, verdict) => spawnSync(process.execPath, [STATE, 'ensemble-commit', '--workflow-path', ctx.workflowPath, '--run-id', runId,
          '--phase', 'critique', '--ensemble-type', 'review', '--verdict', verdict, '--summary', 'settled by hand'], { encoding: 'utf8', env: cleanEnv() });
        await recordPendingEnsemble({ workflowPath: ctx.workflowPath, phase: 'critique', ensemble_type: 'review', run_id: 'review-left-behind' });
        let r = cli('review-left-behind', 'aborted');
        strictEqual(r.status, 0, r.stderr);
        // A run this writer never registered, committed agreed by hand.
        r = cli('review-never-registered', 'agreed');
        strictEqual(r.status, 0, r.stderr);
        let f = await fm(ctx.workflowPath);
        deepStrictEqual(f.pending_ensemble ?? [], [], 'the pending row is popped');
        deepStrictEqual(f.ensemble_results.map((e) => [e.run_id, e.verdict]), [['review-left-behind', 'aborted'], ['review-never-registered', 'agreed']], 'the legacy rows are unchanged');
        const doc = JSON.parse(f.review_attempts);
        deepStrictEqual(doc.attempts.map((a) => [a.id, a.state, a.outcome, a.reason, a.verdict, a.tree, a.tree_reason]), [
          ['review-left-behind', 'closed', 'failed', 'verdict-only', 'aborted', null, 'evidence-missing'],
          ['review-never-registered', 'closed', 'failed', 'verdict-only', 'agreed', null, 'evidence-missing'],
        ]);
        const v = projectReviewOutcomes(f);
        deepStrictEqual(v.coverage, { history_incomplete: false, reasons: [] }, 'no older writer is blamed');
        // A settle afterwards finds the result row and records nothing more.
        const out = await settle(ctx, 'review-left-behind', { verdict: 'agreed', summary: 's' });
        strictEqual(out.settlement, 'already-settled');
        f = await fm(ctx.workflowPath);
        strictEqual(reviewOutcomeFor(f, 'review-left-behind'), 'failed');
      });
    });

    // A run with a ledger shows how it went: a hand commit, which reads none,
    // would hide that outcome for good (the first one is kept), so the CLI
    // refuses it before any write, with --repo-root or from the workflow's own
    // home with the working directory elsewhere, and settle records the
    // ledger's outcome.
    it('the ensemble-commit CLI refuses a review whose run has a ledger, and settle then records the ledger\'s outcome', async () => {
      await withWorkflow(async (ctx) => {
        const elsewhere = await mkdtemp(join(tmpdir(), 'commit-cwd-'));
        try {
          for (const [runId, where] of [['review-peer-gone', ['--repo-root', ctx.repoRoot]], ['review-peer-gone-cwd', []]]) {
            await recordPendingEnsemble({ workflowPath: ctx.workflowPath, phase: 'critique', ensemble_type: 'review', run_id: runId });
            await leftBehind(ctx, runId, { error_kind: 'peer_cli_not_found' });
            const before = await readFile(ctx.workflowPath, 'utf8');
            const r = spawnSync(process.execPath, [STATE, 'ensemble-commit', '--workflow-path', ctx.workflowPath, '--run-id', runId,
              '--phase', 'critique', '--ensemble-type', 'review', '--verdict', 'aborted', '--summary', 'settled by hand', ...where],
            { encoding: 'utf8', env: cleanEnv(), cwd: elsewhere });
            strictEqual(r.status, 1, `${runId}: refused`);
            ok(/has a run ledger, so its review is settled from it: peer-runner\.mjs settle/.test(r.stderr), r.stderr);
            strictEqual(await readFile(ctx.workflowPath, 'utf8'), before, `${runId}: nothing written`);
            const out = await settle(ctx, runId, { verdict: 'concerns', summary: 's' });
            strictEqual(out.settlement, 'committed');
            const a = JSON.parse((await fm(ctx.workflowPath)).review_attempts).attempts.find((x) => x.id === runId);
            deepStrictEqual([a.state, a.outcome, a.reason], ['closed', 'unavailable', 'peer_cli_not_found'], `${runId}: the ledger's outcome`);
          }
        } finally {
          await rm(elsewhere, { recursive: true, force: true });
        }
      });
    });

    it('a commit of a type that is no review records the gaps of the review rows its prune drops', async () => {
      await withWorkflow(async (ctx) => {
        await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: 'review-first', phase: 'critique', ensemble_type: 'review', verdict: 'agreed', summary: 's', completed_at: '2026-11-01T00:00:00Z', ...ev('passed') });
        const { frontmatter: f, body } = parseWorkflowFile(await readFile(ctx.workflowPath, 'utf8'));
        f.ensemble_results.push({ phase: 'critique', ensemble_type: 'review', run_id: 'review-older-writer', verdict: 'agreed', summary: 's', completed_at: '2026-11-01T00:00:01Z', codex_session_id: null });
        const { assembleWorkflowFile } = await import(pathToFileURL(STATE).href);
        await writeFile(ctx.workflowPath, assembleWorkflowFile(f, body));
        for (let i = 0; i < 21; i++) {
          await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: `investigate-${String(i).padStart(2, '0')}`, phase: 'investigate', ensemble_type: 'investigate', verdict: 'agreed', summary: 's', completed_at: `2026-11-02T00:00:${String(i).padStart(2, '0')}Z` });
        }
        const after = await fm(ctx.workflowPath);
        ok(!after.ensemble_results.some((r) => r.ensemble_type === 'review'), 'every review row is pruned');
        deepStrictEqual(projectReviewOutcomes(after).coverage, { history_incomplete: true, reasons: ['missing-outcome'] });
      });
    });

    it('with no document, non-review commits begin one only when a review row is there to lose', async () => {
      await withWorkflow(async (ctx) => {
        await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: 'investigate-only', phase: 'investigate', ensemble_type: 'investigate', verdict: 'agreed', summary: 's' });
        strictEqual((await fm(ctx.workflowPath)).review_attempts, undefined, 'no review, no document');
        // An older writer's review row, then enough non-review commits to prune it.
        const { frontmatter: f, body } = parseWorkflowFile(await readFile(ctx.workflowPath, 'utf8'));
        f.ensemble_results.push({ phase: 'critique', ensemble_type: 'review', run_id: 'review-older-writer', verdict: 'agreed', summary: 's', completed_at: '2026-11-01T00:00:01Z', codex_session_id: null });
        const { assembleWorkflowFile } = await import(pathToFileURL(STATE).href);
        await writeFile(ctx.workflowPath, assembleWorkflowFile(f, body));
        for (let i = 0; i < 21; i++) {
          await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: `investigate-${String(i).padStart(2, '0')}`, phase: 'investigate', ensemble_type: 'investigate', verdict: 'agreed', summary: 's', completed_at: `2026-11-02T00:00:${String(i).padStart(2, '0')}Z` });
        }
        const after = await fm(ctx.workflowPath);
        ok(!after.ensemble_results.some((r) => r.ensemble_type === 'review'), 'the review row is pruned');
        strictEqual(projectReviewOutcomes(after).coverage.history_incomplete, true);
      });
    });
  });

  describe(`${persona}: the /start lifecycle`, () => {
    const FLAGS = ['--ensemble-type <that type>', '--no-run-reason <peer-unavailable|local-only|privacy-gate|owner-skip>', '--attempt-key <a new text directory for that settle>'];
    // The settle rule each host follows: Claude's command, and the shared
    // skill Codex's $start reads (it writes workflow state too).
    const ruleIn = (text, from, to) => {
      const a = text.indexOf(from);
      const b = text.indexOf(to, a);
      ok(a !== -1 && b > a, `the rule between ${from} and ${to} is there`);
      return text.slice(a, b).replace(/\s+/g, ' ');
    };
    it('names the review that never launched on its empty-id settle', async () => {
      const rule = ruleIn(await readFile(P.path('commands/start.md'), 'utf8'), '**Each ensemble attempt is settled.**', '**No phase closes the workflow.**');
      for (const flag of FLAGS) ok(rule.includes(flag), `the settle rule names ${flag}`);
    });
    it('the shared skill Codex\'s $start follows names it too', async () => {
      const rule = ruleIn(await readFile(P.path('core/skills/start/SKILL.md'), 'utf8'), '**Inside the lifecycle**', 'No phase makes a verb\'s terminal write');
      ok(rule.includes('settled from its run ledger'), 'the lifecycle settles each phase');
      for (const flag of FLAGS) ok(rule.includes(flag), `the skill's settle rule names ${flag}`);
    });
    // A refine that loops inside the lifecycle: the refine skill's pass settle
    // settles each earlier pass, so the lifecycle settles the last pass only.
    // A lifecycle rule that settled every pass would record a pass that
    // launched no run twice, under two attempt keys.
    it('leaves a looping refine\'s earlier passes to the refine skill\'s pass settle, on both hosts', async () => {
      const step = '**Each pass settles its own run';
      ok((await readFile(P.path('core/skills/refine/SKILL.md'), 'utf8')).includes(`${step} (C163 A1a).**`), 'the refine skill has the pass settle step the rules name');
      const rules = [
        ruleIn(await readFile(P.path('commands/start.md'), 'utf8'), '**Each ensemble attempt is settled.**', '**No phase closes the workflow.**'),
        ruleIn(await readFile(P.path('core/skills/start/SKILL.md'), 'utf8'), '**Inside the lifecycle**', 'No phase makes a verb\'s terminal write'),
      ];
      for (const rule of rules) {
        ok(rule.includes(`${step}**`), `the rule names the pass settle: ${rule}`);
        ok(rule.includes('settles each earlier pass, launched or not'), 'the pass settle settles the earlier passes');
        ok(rule.includes('settles the last pass\'s attempt only') || rule.includes('settles here the last pass\'s attempt only'), 'the lifecycle settles the last pass only');
        ok(!/settles each attempt/.test(rule), 'no rule tells the lifecycle to settle every pass');
      }
    });
  });

  // On Codex a verb runs as a skill mention, with no command file to run the
  // finalize: each review verb's skill settles its own attempt. Its block is
  // run here as the skill renders it, in a checkout on the workflow's branch.
  describe(`${persona}: the verb skills settle their review on Codex`, () => {
    const REVIEW_VERBS = [['critique', 'review', 'agreed'], ['compose', 'plan-verify', 'agreed'], ['refine', 'refine-verify', 'resolved']];
    async function withCheckout(fn) {
      await withWorkflow(async (ctx) => {
        const r = spawnSync('git', ['init', '-q'], { cwd: ctx.repoRoot, encoding: 'utf8', env: cleanEnv() });
        strictEqual(r.status, 0, r.stderr);
        strictEqual(spawnSync('git', ['symbolic-ref', 'HEAD', `refs/heads/${BASELINE.branch}`], { cwd: ctx.repoRoot, env: cleanEnv() }).status, 0);
        await fn(ctx);
      });
    }
    const blockOf = async (verb) => {
      const text = await readFile(P.path(`core/skills/${verb}/SKILL.md`), 'utf8');
      const a = text.indexOf(`<!-- pipeline:begin ${verb}-review-settle -->`);
      const b = text.indexOf(`<!-- pipeline:end ${verb}-review-settle -->`);
      ok(a !== -1 && b > a, `the ${verb} skill has its settle region`);
      // The settle block, the one opening with its TEXT_DIR line (the region's
      // other shell block is the mktemp step).
      const m = /```bash\n(TEXT_DIR='[\s\S]*?)```/.exec(text.slice(a, b));
      ok(m, 'the region holds the settle block');
      return m[1];
    };
    // Fill the block's values as the agent does: each is a placeholder or a
    // literal the agent edits (the type's default, the empty reason).
    const fill = (block, values) => {
      let out = block.replaceAll('<plugin-root>', P.path(''));
      for (const [k, v] of Object.entries(values)) {
        const re = new RegExp(`^${k}='[^'\\n]*'$`, 'm');
        ok(re.test(out), `${k} is a value line of the block`);
        out = out.replace(re, () => `${k}='${v}'`);
      }
      ok(!out.includes('<plugin-root>') && !/^[A-Z_]+='</m.test(out), 'no placeholder is left');
      return out;
    };
    const runBlock = (script, cwd) => spawnSync('bash', ['-c', script], { cwd, encoding: 'utf8', env: cleanEnv() });
    // The dispatch's accounting flags, as the skill's prose lists them (the
    // code span naming the type and the run id), placeholders filled.
    const dispatchFlagsOf = async (verb, values) => {
      const text = await readFile(P.path(`core/skills/${verb}/SKILL.md`), 'utf8');
      const region = text.slice(text.indexOf(`<!-- pipeline:begin ${verb}-review-settle -->`), text.indexOf(`<!-- pipeline:end ${verb}-review-settle -->`));
      const m = /`([^`]*--ensemble-type <type>[^`]*--run-id <id>[^`]*)`/.exec(region);
      ok(m, 'the skill lists the dispatch flags in one code span');
      let span = m[1].replace(/\s+/g, ' ').trim();
      for (const [k, v] of Object.entries(values)) span = span.replaceAll(k, v);
      ok(!span.includes('<'), `every placeholder of the flags is filled: ${span}`);
      return span.split(' ');
    };

    for (const [verb, type, verdict] of REVIEW_VERBS) {
      it(`$${verb} with no run launched records the review that never ran, once`, async () => {
        await withCheckout(async (ctx) => {
          const textDir = await mkdtemp(join(tmpdir(), 'review-settle-'));
          const laterDir = await mkdtemp(join(tmpdir(), 'review-settle-'));
          try {
            const script = fill(await blockOf(verb), { TEXT_DIR: textDir, DISPATCH_DIR: '', VERDICT: '', ENSEMBLE_TYPE: type, NO_RUN_REASON: 'peer-unavailable' });
            for (let i = 0; i < 2; i++) {
              const r = runBlock(script, ctx.repoRoot);
              strictEqual(r.status, 0, r.stderr);
            }
            let v = await view(ctx.workflowPath);
            deepStrictEqual(v.attempts.map((a) => [a.phase, a.type, a.outcome, a.reason, a.tree_reason]), [[verb, type, 'unavailable', 'peer-unavailable', 'no-launch']]);
            // A later review of the same verb in the same workflow that never
            // launched either (the peer still away), settled from its own text
            // directory: an attempt of its own, never merged into the first.
            const r = runBlock(fill(await blockOf(verb), { TEXT_DIR: laterDir, DISPATCH_DIR: '', VERDICT: '', ENSEMBLE_TYPE: type, NO_RUN_REASON: 'local-only' }), ctx.repoRoot);
            strictEqual(r.status, 0, r.stderr);
            v = await view(ctx.workflowPath);
            deepStrictEqual(v.attempts.map((a) => [a.type, a.outcome, a.reason]), [[type, 'unavailable', 'peer-unavailable'], [type, 'skipped', 'local-only']]);
            ok(v.attempts[0].id !== v.attempts[1].id, 'two attempt ids');
          } finally {
            await rm(textDir, { recursive: true, force: true });
            await rm(laterDir, { recursive: true, force: true });
          }
        });
      });

      it(`$${verb} with a run launched settles it from its ledger`, async () => {
        await withCheckout(async (ctx) => {
          const textDir = await mkdtemp(join(tmpdir(), 'review-settle-'));
          const dispatchDir = await mkdtemp(join(tmpdir(), 'review-dispatch-'));
          try {
            // Launched through the CLI with exactly the accounting flags the
            // skill lists, as the agent would.
            const flags = await dispatchFlagsOf(verb, { '<the active workflow>': ctx.workflowPath, '<type>': type, '<id>': `${type}-codex-skill` });
            await writeFile(join(dispatchDir, 'prompt.xml'), '<task>review</task>\n');
            const launched = spawnSync(process.execPath, [RUNNER, 'run', '--repo-root', ctx.repoRoot, '--peer', 'claude',
              '--prompt-file', join(dispatchDir, 'prompt.xml'), '--output-format', 'json', '--cwd', ctx.repoRoot, ...flags],
            { encoding: 'utf8', env: { ...cleanEnv(), AGENTIC_COMPANIONS_ROOT: ctx.companions } });
            strictEqual(launched.status, 0, launched.stderr);
            strictEqual(JSON.parse(launched.stdout).status, 'completed');
            await writeFile(join(dispatchDir, 'prompt.xml.run.json'), launched.stdout);
            await writeFile(join(textDir, 'summary.txt'), 'the synthesis\n');
            strictEqual((await attempt(ctx.workflowPath, `${type}-codex-skill`)).outcome, 'unknown', 'open until settled');
            const r = runBlock(fill(await blockOf(verb), { TEXT_DIR: textDir, DISPATCH_DIR: dispatchDir, VERDICT: verdict, ENSEMBLE_TYPE: type, NO_RUN_REASON: '' }), ctx.repoRoot);
            strictEqual(r.status, 0, r.stderr);
            const a = await attempt(ctx.workflowPath, `${type}-codex-skill`);
            deepStrictEqual([a.state, a.phase, a.outcome, a.verdict, a.status], ['closed', verb, 'passed', verdict, 'completed']);
            deepStrictEqual((await fm(ctx.workflowPath)).pending_ensemble ?? [], [], 'the pending row is settled');
          } finally {
            await rm(textDir, { recursive: true, force: true });
            await rm(dispatchDir, { recursive: true, force: true });
          }
        });
      });
    }

    it('with no active workflow on the branch, the block records nothing', async () => {
      await withCheckout(async (ctx) => {
        strictEqual(spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/elsewhere'], { cwd: ctx.repoRoot, env: cleanEnv() }).status, 0);
        const before = await readFile(ctx.workflowPath, 'utf8');
        const r = runBlock(fill(await blockOf('critique'), { TEXT_DIR: ctx.repoRoot, DISPATCH_DIR: '', VERDICT: '', ENSEMBLE_TYPE: 'review', NO_RUN_REASON: 'local-only' }), ctx.repoRoot);
        strictEqual(r.status, 0, r.stderr);
        ok(/no review attempt to settle/.test(r.stderr), r.stderr);
        strictEqual(await readFile(ctx.workflowPath, 'utf8'), before);
      });
    });

    // Settle records nothing for a type that is no review, so the block
    // refuses a type outside its verb's review types, and a reason settle does
    // not know, before any write; the verb's other review type records.
    it('a type outside the verb\'s review types, or an unknown reason, stops the block before any write; the other type records', async () => {
      await withCheckout(async (ctx) => {
        const before = await readFile(ctx.workflowPath, 'utf8');
        for (const [verb, values, rule] of [
          ['critique', { ENSEMBLE_TYPE: 'critique', NO_RUN_REASON: 'local-only' }, /ENSEMBLE_TYPE is not one of this verb's review types/],
          ['refine', { ENSEMBLE_TYPE: 'plan-verify', NO_RUN_REASON: 'local-only' }, /ENSEMBLE_TYPE is not one of this verb's review types/],
          ['compose', { ENSEMBLE_TYPE: 'plan-verify', NO_RUN_REASON: 'peer-down' }, /NO_RUN_REASON is not/],
        ]) {
          const textDir = await mkdtemp(join(tmpdir(), 'review-settle-'));
          try {
            const r = runBlock(fill(await blockOf(verb), { TEXT_DIR: textDir, DISPATCH_DIR: '', VERDICT: '', ...values }), ctx.repoRoot);
            strictEqual(r.status, 1, `${verb} ${JSON.stringify(values)}: ${r.stderr}`);
            ok(rule.test(r.stderr), r.stderr);
            ok(/nothing was settled/.test(r.stderr), r.stderr);
          } finally {
            await rm(textDir, { recursive: true, force: true });
          }
        }
        strictEqual(await readFile(ctx.workflowPath, 'utf8'), before, 'nothing was written');
        const textDir = await mkdtemp(join(tmpdir(), 'review-settle-'));
        try {
          const r = runBlock(fill(await blockOf('critique'), { TEXT_DIR: textDir, DISPATCH_DIR: '', VERDICT: '', ENSEMBLE_TYPE: 'adversarial-scan', NO_RUN_REASON: 'owner-skip' }), ctx.repoRoot);
          strictEqual(r.status, 0, r.stderr);
          const v = await view(ctx.workflowPath);
          deepStrictEqual(v.attempts.map((a) => [a.phase, a.type, a.outcome, a.reason]), [['critique', 'adversarial-scan', 'skipped', 'owner-skip']]);
        } finally {
          await rm(textDir, { recursive: true, force: true });
        }
      });
    });

    // A launched run's verdict reaches settle as the agent typed it, and any
    // word settle does not map records a clean review `failed`
    // (`unrecognized-verdict`): the block refuses it before any write, and
    // each word it takes, and each the skill names for its verb, maps to an
    // outcome.
    const verdictArmOf = (block) => {
      const m = /case "\$VERDICT" in\n\s*([^)\n]+)\)/.exec(block);
      ok(m, 'the block checks VERDICT with one case arm');
      return m[1].split('|');
    };
    for (const [verb] of REVIEW_VERBS) {
      it(`$${verb}: each verdict word the block takes, and each the skill names, maps to an outcome`, async () => {
        const arm = verdictArmOf(await blockOf(verb));
        for (const w of arm) {
          const { outcome, reason } = outcomeOf({ status: 'completed', verdict: w });
          ok(outcome !== 'failed' && reason !== 'unrecognized-verdict', `${w} maps to ${outcome}`);
        }
        const text = await readFile(P.path(`core/skills/${verb}/SKILL.md`), 'utf8');
        const region = text.slice(text.indexOf(`<!-- pipeline:begin ${verb}-review-settle -->`), text.indexOf(`<!-- pipeline:end ${verb}-review-settle -->`));
        const m = /one\s+word, this verb's\s+(.*?),\s+or `degraded`/s.exec(region);
        ok(m, 'the skill names its verb\'s verdict words');
        const named = [...m[1].matchAll(/`([a-z-]+)`/g)].map((x) => x[1]);
        ok(named.length >= 3, `the words are named: ${named}`);
        for (const w of [...named, 'degraded']) ok(arm.includes(w), `the block takes ${w}`);
      });
    }

    it('a verdict settle does not map, a verdict with no run, or a value left unfilled stops the block before any write', async () => {
      await withCheckout(async (ctx) => {
        const before = await readFile(ctx.workflowPath, 'utf8');
        const textDir = await mkdtemp(join(tmpdir(), 'review-settle-'));
        const dispatchDir = await mkdtemp(join(tmpdir(), 'review-dispatch-'));
        try {
          await writeFile(join(textDir, 'summary.txt'), 'the synthesis\n');
          for (const [verb, values, rule] of [
            ['critique', { DISPATCH_DIR: dispatchDir, VERDICT: 'AGREED' }, /VERDICT is not agreed, resolved/],
            ['compose', { DISPATCH_DIR: dispatchDir, VERDICT: 'looks good' }, /VERDICT is not agreed, resolved/],
            ['refine', { DISPATCH_DIR: dispatchDir, VERDICT: 'failed' }, /VERDICT is not agreed, resolved/],
            ['refine', { DISPATCH_DIR: dispatchDir, VERDICT: '' }, /VERDICT is not agreed, resolved/],
            ['critique', { DISPATCH_DIR: '', VERDICT: 'agreed', NO_RUN_REASON: 'local-only' }, /VERDICT is set, but DISPATCH_DIR is empty/],
            ['compose', { TEXT_DIR: '', DISPATCH_DIR: '', VERDICT: '', NO_RUN_REASON: 'local-only' }, /TEXT_DIR is empty/],
          ]) {
            const type = REVIEW_VERBS.find(([v]) => v === verb)[1];
            const r = runBlock(fill(await blockOf(verb), { TEXT_DIR: textDir, ENSEMBLE_TYPE: type, NO_RUN_REASON: '', ...values }), ctx.repoRoot);
            strictEqual(r.status, 1, `${verb} ${JSON.stringify(values)}: ${r.stderr}`);
            ok(rule.test(r.stderr), r.stderr);
            ok(/nothing was settled/.test(r.stderr), r.stderr);
          }
          // The placeholders as the skill renders them, left unfilled: the
          // unfilled VERDICT with a dispatch directory, and an unfilled
          // TEXT_DIR or DISPATCH_DIR.
          const raw = (await blockOf('critique')).replaceAll('<plugin-root>', P.path(''));
          for (const [script, rule] of [
            [raw.replace(/^TEXT_DIR='[^'\n]*'$/m, `TEXT_DIR='${textDir}'`).replace(/^DISPATCH_DIR='[^'\n]*'$/m, `DISPATCH_DIR='${dispatchDir}'`), /VERDICT is not agreed, resolved/],
            [raw.replace(/^DISPATCH_DIR='[^'\n]*'$/m, "DISPATCH_DIR=''").replace(/^VERDICT='[^'\n]*'$/m, "VERDICT=''").replace(/^NO_RUN_REASON=''$/m, "NO_RUN_REASON='local-only'"), /TEXT_DIR or DISPATCH_DIR is not filled in/],
            [raw.replace(/^TEXT_DIR='[^'\n]*'$/m, `TEXT_DIR='${textDir}'`).replace(/^VERDICT='[^'\n]*'$/m, "VERDICT='agreed'"), /TEXT_DIR or DISPATCH_DIR is not filled in/],
          ]) {
            const r = runBlock(script, ctx.repoRoot);
            strictEqual(r.status, 1, r.stderr);
            ok(rule.test(r.stderr), r.stderr);
            ok(/nothing was settled/.test(r.stderr), r.stderr);
          }
          strictEqual(await readFile(ctx.workflowPath, 'utf8'), before, 'nothing was written');
          // Only a value that opens as its placeholder does is unfilled: a
          // real directory holding "<" further on settles.
          const angled = await mkdtemp(join(tmpdir(), 'review<settle-'));
          try {
            const r = runBlock(fill(await blockOf('critique'), { TEXT_DIR: angled, DISPATCH_DIR: '', VERDICT: '', ENSEMBLE_TYPE: 'review', NO_RUN_REASON: 'local-only' }), ctx.repoRoot);
            strictEqual(r.status, 0, r.stderr);
            deepStrictEqual((await view(ctx.workflowPath)).attempts.map((a) => [a.type, a.outcome, a.reason]), [['review', 'skipped', 'local-only']]);
          } finally {
            await rm(angled, { recursive: true, force: true });
          }
        } finally {
          await rm(textDir, { recursive: true, force: true });
          await rm(dispatchDir, { recursive: true, force: true });
        }
      });
    });

    // A refine loops (Steps 2 to 4 or 5), and each pass dispatches its own
    // refine-verify run, while the finalize settles one: each earlier pass
    // settles its run with the skill's pass settle block, on either host.
    const passBlockOf = async () => {
      const text = await readFile(P.path('core/skills/refine/SKILL.md'), 'utf8');
      const a = text.indexOf('<!-- pipeline:begin refine-pass-settle -->');
      const b = text.indexOf('<!-- pipeline:end refine-pass-settle -->');
      ok(a !== -1 && b > a, 'the refine skill has its pass settle region');
      ok(text.indexOf('Loop Steps 2') !== -1 && a > text.indexOf('Loop Steps 2'), 'the pass settle follows the loop');
      const m = /```bash\n(TEXT_DIR='[\s\S]*?)```/.exec(text.slice(a, b));
      ok(m, 'the region holds the pass settle block');
      return m[1];
    };
    async function launchRefineVerify(ctx, dispatchDir, runId) {
      const flags = await dispatchFlagsOf('refine', { '<the active workflow>': ctx.workflowPath, '<type>': 'refine-verify', '<id>': runId });
      await writeFile(join(dispatchDir, 'prompt.xml'), '<task>verify the fix</task>\n');
      const launched = spawnSync(process.execPath, [RUNNER, 'run', '--repo-root', ctx.repoRoot, '--peer', 'claude',
        '--prompt-file', join(dispatchDir, 'prompt.xml'), '--output-format', 'json', '--cwd', ctx.repoRoot, ...flags],
      { encoding: 'utf8', env: { ...cleanEnv(), AGENTIC_COMPANIONS_ROOT: ctx.companions } });
      strictEqual(launched.status, 0, launched.stderr);
      strictEqual(JSON.parse(launched.stdout).status, 'completed');
      await writeFile(join(dispatchDir, 'prompt.xml.run.json'), launched.stdout);
    }

    it('a looping refine settles each pass: every attempt closes with its own outcome, and no pending row is left', async () => {
      await withCheckout(async (ctx) => {
        const dirs = [];
        const dir = async (prefix) => {
          const d = await mkdtemp(join(tmpdir(), prefix));
          dirs.push(d);
          return d;
        };
        try {
          // Pass 1: its run, settled by the pass settle before the loop goes back.
          const dispatch1 = await dir('refine-pass-dispatch-');
          const text1 = await dir('refine-pass-text-');
          await launchRefineVerify(ctx, dispatch1, 'refine-verify-pass-1');
          await writeFile(join(text1, 'summary.txt'), 'pass 1: the fix regressed a passage\n');
          const pass = fill(await passBlockOf(), { TEXT_DIR: text1, DISPATCH_DIR: dispatch1, VERDICT: 'regression', NO_RUN_REASON: '', HOST: 'claude' });
          let r = runBlock(pass, ctx.repoRoot);
          strictEqual(r.status, 0, r.stderr);
          let a1 = await attempt(ctx.workflowPath, 'refine-verify-pass-1');
          // The pass's own verdict, not a word the block supplies: regression
          // records concerns, so the verdict field tells it from concerns.
          deepStrictEqual([a1.state, a1.phase, a1.outcome, a1.verdict], ['closed', 'refine', 'concerns', 'regression']);
          deepStrictEqual((await fm(ctx.workflowPath)).pending_ensemble ?? [], [], 'the pass settle settles its pending row');
          // Pass 2, the last: the finalize's settle (here the Codex skill's).
          const dispatch2 = await dir('refine-pass-dispatch-');
          const text2 = await dir('refine-pass-text-');
          await launchRefineVerify(ctx, dispatch2, 'refine-verify-pass-2');
          await writeFile(join(text2, 'summary.txt'), 'pass 2: resolved\n');
          r = runBlock(fill(await blockOf('refine'), { TEXT_DIR: text2, DISPATCH_DIR: dispatch2, VERDICT: 'resolved', ENSEMBLE_TYPE: 'refine-verify', NO_RUN_REASON: '' }), ctx.repoRoot);
          strictEqual(r.status, 0, r.stderr);
          const v = await view(ctx.workflowPath);
          deepStrictEqual(v.attempts.map((a) => [a.id, a.state, a.outcome, a.verdict]), [['refine-verify-pass-1', 'closed', 'concerns', 'regression'], ['refine-verify-pass-2', 'closed', 'passed', 'resolved']]);
          deepStrictEqual((await fm(ctx.workflowPath)).pending_ensemble ?? [], []);
          // The pass settle run again records nothing more.
          r = runBlock(pass, ctx.repoRoot);
          strictEqual(r.status, 0, r.stderr);
          a1 = await attempt(ctx.workflowPath, 'refine-verify-pass-1');
          deepStrictEqual([a1.outcome, a1.verdict], ['concerns', 'regression']);
          // No run of phase refine is left open, so a later settle that names
          // none (a local-only refine) records its outcome.
          const text3 = await dir('refine-pass-text-');
          r = runBlock(fill(await blockOf('refine'), { TEXT_DIR: text3, DISPATCH_DIR: '', VERDICT: '', ENSEMBLE_TYPE: 'refine-verify', NO_RUN_REASON: 'local-only' }), ctx.repoRoot);
          strictEqual(r.status, 0, r.stderr);
          strictEqual((await view(ctx.workflowPath)).attempts.length, 3);
        } finally {
          for (const d of dirs) await rm(d, { recursive: true, force: true });
        }
      });
    });

    it('a looping refine records a pass that launched no run: each pass one attempt, and the history reads complete', async () => {
      await withCheckout(async (ctx) => {
        const dirs = [];
        const dir = async (prefix) => {
          const d = await mkdtemp(join(tmpdir(), prefix));
          dirs.push(d);
          return d;
        };
        try {
          // Pass 1: the peer was not found, so no run launched; the pass
          // settle records it before the loop goes back.
          const text1 = await dir('refine-pass-text-');
          await writeFile(join(text1, 'summary.txt'), 'pass 1: local only, the peer was not found\n');
          const pass1 = fill(await passBlockOf(), { TEXT_DIR: text1, DISPATCH_DIR: '', VERDICT: '', NO_RUN_REASON: 'peer-unavailable', HOST: 'codex' });
          let r = runBlock(pass1, ctx.repoRoot);
          strictEqual(r.status, 0, r.stderr);
          // Pass 2: the privacy gate held, so again no run; the pass settle.
          const text2 = await dir('refine-pass-text-');
          await writeFile(join(text2, 'summary.txt'), 'pass 2: the prompt could not be made safe\n');
          r = runBlock(fill(await passBlockOf(), { TEXT_DIR: text2, DISPATCH_DIR: '', VERDICT: '', NO_RUN_REASON: 'privacy-gate', HOST: 'codex' }), ctx.repoRoot);
          strictEqual(r.status, 0, r.stderr);
          // Pass 3, the last: a run, settled by the finalize (here the Codex skill's).
          const dispatch3 = await dir('refine-pass-dispatch-');
          const text3 = await dir('refine-pass-text-');
          await launchRefineVerify(ctx, dispatch3, 'refine-verify-pass-3');
          await writeFile(join(text3, 'summary.txt'), 'pass 3: resolved\n');
          r = runBlock(fill(await blockOf('refine'), { TEXT_DIR: text3, DISPATCH_DIR: dispatch3, VERDICT: 'resolved', ENSEMBLE_TYPE: 'refine-verify', NO_RUN_REASON: '' }), ctx.repoRoot);
          strictEqual(r.status, 0, r.stderr);
          // The pass settle run again with the same text directory records nothing more.
          r = runBlock(pass1, ctx.repoRoot);
          strictEqual(r.status, 0, r.stderr);
          const v = await view(ctx.workflowPath);
          deepStrictEqual(v.attempts.map((a) => [a.type, a.phase, a.state, a.outcome, a.reason ?? null]),
            [['refine-verify', 'refine', 'closed', 'unavailable', 'peer-unavailable'], ['refine-verify', 'refine', 'closed', 'skipped', 'privacy-gate'], ['refine-verify', 'refine', 'closed', 'passed', null]]);
          strictEqual(v.coverage.history_incomplete, false, 'every pass is in the history');
          deepStrictEqual((await fm(ctx.workflowPath)).pending_ensemble ?? [], []);
        } finally {
          for (const d of dirs) await rm(d, { recursive: true, force: true });
        }
      });
    });

    it('the pass settle refuses another host, a word a refine synthesis does not use, a reason settle does not know, a verdict with no run or a reason beside one, or a value left unfilled or empty, before any write', async () => {
      await withCheckout(async (ctx) => {
        const textDir = await mkdtemp(join(tmpdir(), 'refine-pass-text-'));
        const dispatchDir = await mkdtemp(join(tmpdir(), 'refine-pass-dispatch-'));
        try {
          // Neither a run nor a reason, with no run pending that settle would
          // refuse on its own: the block stops it, so no made-up skipped
          // (unspecified) attempt is recorded.
          await writeFile(join(textDir, 'summary.txt'), 'the synthesis\n');
          const empty = await readFile(ctx.workflowPath, 'utf8');
          const none = runBlock(fill(await passBlockOf(), { TEXT_DIR: textDir, DISPATCH_DIR: '', VERDICT: '', NO_RUN_REASON: '', HOST: 'claude' }), ctx.repoRoot);
          strictEqual(none.status, 1, none.stderr);
          ok(/DISPATCH_DIR and NO_RUN_REASON are both empty/.test(none.stderr), none.stderr);
          strictEqual(await readFile(ctx.workflowPath, 'utf8'), empty, 'no attempt was recorded');
          await launchRefineVerify(ctx, dispatchDir, 'refine-verify-refused');
          await writeFile(join(textDir, 'summary.txt'), 'the synthesis\n');
          const before = await readFile(ctx.workflowPath, 'utf8');
          const good = { TEXT_DIR: textDir, DISPATCH_DIR: dispatchDir, VERDICT: 'concerns', NO_RUN_REASON: '', HOST: 'codex' };
          for (const [values, rule] of [
            [{ HOST: 'cluade' }, /HOST is not claude or codex/],
            [{ VERDICT: 'agreed' }, /VERDICT is not resolved, concerns, regression, conflict or degraded/],
            [{ VERDICT: 'AGREED' }, /VERDICT is not resolved, concerns, regression, conflict or degraded/],
            [{ VERDICT: '' }, /VERDICT is not resolved, concerns, regression, conflict or degraded/],
            [{ DISPATCH_DIR: '' }, /VERDICT is set, but DISPATCH_DIR is empty/],
            [{ DISPATCH_DIR: '', VERDICT: '' }, /DISPATCH_DIR and NO_RUN_REASON are both empty/],
            [{ NO_RUN_REASON: 'local-only' }, /NO_RUN_REASON is set, but DISPATCH_DIR names a run/],
            [{ DISPATCH_DIR: '', VERDICT: '', NO_RUN_REASON: 'peer-missing' }, /NO_RUN_REASON is not peer-unavailable, local-only, privacy-gate or owner-skip/],
            [{ TEXT_DIR: '' }, /TEXT_DIR is empty or not filled in/],
          ]) {
            const r = runBlock(fill(await passBlockOf(), { ...good, ...values }), ctx.repoRoot);
            strictEqual(r.status, 1, `${JSON.stringify(values)}: ${r.stderr}`);
            ok(rule.test(r.stderr), r.stderr);
            ok(/nothing was settled/.test(r.stderr), r.stderr);
          }
          // The placeholders as the skill renders them, each left unfilled.
          const raw = (await passBlockOf()).replaceAll('<plugin-root>', P.path(''));
          const set = (s, k, v) => s.replace(new RegExp(`^${k}='[^'\\n]*'$`, 'm'), () => `${k}='${v}'`);
          for (const [left, rule] of [
            ['HOST', /HOST is not claude or codex/],
            ['VERDICT', /VERDICT is not resolved/],
            ['DISPATCH_DIR', /DISPATCH_DIR is not filled in/],
            ['TEXT_DIR', /TEXT_DIR is empty or not filled in/],
          ]) {
            let script = raw;
            for (const [k, v] of Object.entries(good)) if (k !== left) script = set(script, k, v);
            const r = runBlock(script, ctx.repoRoot);
            strictEqual(r.status, 1, `${left} unfilled: ${r.stderr}`);
            ok(rule.test(r.stderr), r.stderr);
          }
          strictEqual(await readFile(ctx.workflowPath, 'utf8'), before, 'nothing was written');
          // Each word the block takes maps to an outcome settle records.
          const m = /case "\$VERDICT" in\n\s*([^)\n]+)\)/.exec(raw);
          ok(m, 'the pass settle checks VERDICT with one case arm');
          for (const w of m[1].split('|')) {
            const { outcome, reason } = outcomeOf({ status: 'completed', verdict: w });
            ok(outcome !== 'failed' && reason !== 'unrecognized-verdict', `${w} maps to ${outcome}`);
          }
        } finally {
          await rm(textDir, { recursive: true, force: true });
          await rm(dispatchDir, { recursive: true, force: true });
        }
      });
    });

    it('the refine command tells a looping refine to settle each pass with the skill\'s pass settle', async () => {
      const text = (await readFile(P.path('commands/refine.md'), 'utf8')).replace(/\s+/g, ' ');
      ok(/each pass dispatches from a text directory of its own, and that pass's run is settled before the next pass, with the pass settle block of `core\/skills\/refine\/SKILL\.md` \(`HOST` `claude`\)/.test(text),
        'the command names the pass settle for a looping refine');
      const skill = (await readFile(P.path('core/skills/refine/SKILL.md'), 'utf8')).replace(/\s+/g, ' ');
      ok(/\*\*Each pass settles its own run \(C163 A1a\)\.\*\*/.test(skill), 'the skill names the pass settle the command points at');
    });
  });
}

// The orchestrator's plan-verify, through its own runner: the plan commits the
// local synthesis's verdict whatever the run did, so the outcome is read from
// the run's ledger, and the verdict counts only for a run that completed with
// a usable answer.
{
  const ORCH_RUNNER = join(REPO, 'plugins/orchestrator/scripts/peer-runner.mjs');
  const ORCH_STATE = join(REPO, 'plugins/orchestrator/scripts/state.mjs');
  const { runPeer: orchRun } = await import(pathToFileURL(ORCH_RUNNER).href);
  const { createWorkflow: orchCreate, commitEnsemble: orchCommit, recordPendingEnsemble: orchPending, parseWorkflowFile: orchParse, assembleWorkflowFile: orchAssemble } =
    await import(pathToFileURL(ORCH_STATE).href);

  async function withMacro(fn) {
    const repoRoot = await mkdtemp(join(tmpdir(), 'orchestrator-review-attempts-'));
    try {
      const { filePath } = await orchCreate({ repoRoot, verb: 'plan', host: 'claude', gitBaseline: BASELINE, originalRequest: 'review attempts' });
      await fn({ repoRoot, workflowPath: filePath });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  }
  const macroFm = async (p) => orchParse(await readFile(p, 'utf8')).frontmatter;
  const macroAttempt = async (p, id) => JSON.parse((await macroFm(p)).review_attempts).attempts.find((a) => a.id === id);
  const planRun = async (ctx, runId, { missing = false, mode } = {}) => orchRun({
    repoRoot: ctx.repoRoot, runId, kind: 'ensemble', workflowPath: ctx.workflowPath, phase: 'plan',
    ensembleType: 'plan-verify', host: 'claude', peer: 'codex', promptText: '<task>verify the plan</task>', outputFormat: 'json',
    cwd: ctx.repoRoot,
    env: { ...cleanEnv(), AGENTIC_COMPANIONS_ROOT: await writeCompanions(ctx.repoRoot, { missing }), ...(mode ? { FAKE_COMPANION_MODE: mode } : {}) },
  });
  const planCommit = (ctx, runId, verdict = 'pass') => orchCommit({ workflowPath: ctx.workflowPath, run_id: runId, phase: 'plan', ensemble_type: 'plan-verify', verdict, summary: 'local synthesis' });

  describe('orchestrator: a plan-verify attempt keeps the outcome its run evidence shows', () => {
    it('a run that found no peer records unavailable, though the commit says pass', async () => {
      await withMacro(async (ctx) => {
        const run = await planRun(ctx, 'macro-plan-nopeer', { missing: true });
        deepStrictEqual([run.error_kind, run.handle_path], ['peer_cli_not_found', null], 'the real runner leaves no ledger');
        strictEqual((await macroFm(ctx.workflowPath)).pending_ensemble?.length ?? 0, 0, 'and no pending row');
        await planCommit(ctx, 'macro-plan-nopeer');
        const a = await macroAttempt(ctx.workflowPath, 'macro-plan-nopeer');
        deepStrictEqual([a.outcome, a.reason, a.verdict, a.tree, a.tree_reason], ['unavailable', 'no-ledger', 'pass', null, 'no-launch']);
        strictEqual((await macroFm(ctx.workflowPath)).ensemble_results[0].verdict, 'pass', 'the legacy row is unchanged');
      });
    });

    it('a run that completed with an empty answer records degraded, though the commit says pass', async () => {
      await withMacro(async (ctx) => {
        const run = await planRun(ctx, 'macro-plan-empty', { mode: 'json-empty' });
        strictEqual(run.status, 'completed');
        await planCommit(ctx, 'macro-plan-empty');
        const a = await macroAttempt(ctx.workflowPath, 'macro-plan-empty');
        deepStrictEqual([a.outcome, a.reason, a.status], ['degraded', 'answer-empty', 'completed']);
      });
    });

    // The only answer evidence of a completed json run is its envelope: one
    // gone, or torn mid-write, holds no answer to judge, and the plan's local
    // pass must not stand in for it.
    for (const [label, spoil] of [['gone', (p) => rm(p)], ['torn', (p) => writeFile(p, '{"status":"success","stdout":"the pe')]]) {
      it(`a completed run whose envelope is ${label} records degraded, answer-unreadable, though the commit says pass`, async () => {
        await withMacro(async (ctx) => {
          const run = await planRun(ctx, `macro-plan-envelope-${label}`);
          strictEqual(run.status, 'completed');
          ok(typeof run.envelope_path === 'string', 'the run wrote an envelope');
          await spoil(run.envelope_path);
          await planCommit(ctx, `macro-plan-envelope-${label}`);
          const a = await macroAttempt(ctx.workflowPath, `macro-plan-envelope-${label}`);
          deepStrictEqual([a.outcome, a.reason, a.status, a.verdict], ['degraded', 'answer-unreadable', 'completed', 'pass']);
        });
      });
    }

    it('a run that failed records how it ended, though the commit says pass', async () => {
      await withMacro(async (ctx) => {
        const run = await planRun(ctx, 'macro-plan-malformed', { mode: 'malformed' });
        deepStrictEqual([run.status, run.error_kind], ['failed', 'envelope_parse_error']);
        await planCommit(ctx, 'macro-plan-malformed');
        const a = await macroAttempt(ctx.workflowPath, 'macro-plan-malformed');
        deepStrictEqual([a.outcome, a.reason, a.status, a.error_kind, a.verdict], ['malformed', 'envelope_parse_error', 'failed', 'envelope_parse_error', 'pass']);
      });
    });

    // The ledger is evidence for the attempt it ran only: a completed run of
    // another ensemble type, or of another phase, committed under the plan's
    // plan-verify, is no plan review.
    it('a completed run of another type or phase records failed, ledger-mismatch, though the commit says pass', async () => {
      await withMacro(async (ctx) => {
        const env = { ...cleanEnv(), AGENTIC_COMPANIONS_ROOT: await writeCompanions(ctx.repoRoot) };
        for (const [runId, phase, ensembleType] of [['macro-investigate', 'plan', 'investigate'], ['macro-other-phase', 'replan', 'plan-verify']]) {
          const run = await orchRun({
            repoRoot: ctx.repoRoot, runId, kind: 'ensemble', workflowPath: ctx.workflowPath, phase, ensembleType,
            host: 'claude', peer: 'codex', promptText: '<task>something else</task>', outputFormat: 'json', cwd: ctx.repoRoot, env,
          });
          strictEqual(run.status, 'completed');
          await planCommit(ctx, runId);
          const a = await macroAttempt(ctx.workflowPath, runId);
          deepStrictEqual([a.outcome, a.reason, a.status, a.tree, a.tree_reason], ['failed', 'ledger-mismatch', undefined, null, 'evidence-mismatch'], runId);
        }
      });
    });

    it('a macro attempt the document refuses still leaves the gap of its pruned row', async () => {
      await withMacro(async (ctx) => {
        for (let i = 0; i < 20; i++) {
          await orchCommit({ workflowPath: ctx.workflowPath, run_id: `macro-plan-${String(i).padStart(2, '0')}`, phase: 'plan', ensemble_type: 'plan-verify', verdict: 'pass', summary: 's', completed_at: `2026-11-02T00:00:${String(i).padStart(2, '0')}Z` });
        }
        const longId = `macro-plan-${'x'.repeat(151)}`;
        strictEqual(longId.length, 162);
        await orchCommit({ workflowPath: ctx.workflowPath, run_id: longId, phase: 'plan', ensemble_type: 'plan-verify', verdict: 'pass', summary: 's', completed_at: '2026-10-01T00:00:00Z' });
        const after = await macroFm(ctx.workflowPath);
        ok(!after.ensemble_results.some((r) => r.run_id === longId), 'pruned by the write that appended it');
        const doc = JSON.parse(after.review_attempts);
        ok(!doc.attempts.some((a) => a.id === longId), 'the attempt is refused');
        deepStrictEqual(doc.coverage, { history_incomplete: true, reasons: ['missing-outcome'] });
      });
    });

    // A run in a git checkout: the orchestrator's runner isolates the peer in
    // a snapshot, and the attempt keeps the tree that snapshot held.
    it('a run in a checkout keeps the tree its snapshot held', async () => {
      await withMacro(async (ctx) => {
        const checkout = join(ctx.repoRoot, 'checkout');
        await mkdir(checkout);
        const git = (...args) => {
          const r = spawnSync('git', args, { cwd: checkout, encoding: 'utf8', env: cleanEnv() });
          strictEqual(r.status, 0, r.stderr);
          return r.stdout.trim();
        };
        git('init', '-q');
        await writeFile(join(checkout, 'plan.md'), 'the plan\n');
        git('add', 'plan.md');
        git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'plan');
        // An unstaged edit under review: the worktree tree differs from the index's.
        await writeFile(join(checkout, 'plan.md'), 'the plan, with an unstaged edit\n');
        const run = await orchRun({
          repoRoot: ctx.repoRoot, runId: 'macro-plan-tree', kind: 'ensemble', workflowPath: ctx.workflowPath, phase: 'plan',
          ensembleType: 'plan-verify', host: 'claude', peer: 'codex', promptText: '<task>verify the plan</task>', outputFormat: 'json',
          cwd: checkout, env: { ...cleanEnv(), AGENTIC_COMPANIONS_ROOT: await writeCompanions(ctx.repoRoot) },
        });
        strictEqual(run.status, 'completed');
        const head = git('rev-parse', 'HEAD');
        const indexTree = git('write-tree');
        const s = run.snapshot;
        deepStrictEqual([s?.isolation, s?.head, s?.index_tree], ['snapshot', head, indexTree], 'the runner isolated this checkout');
        ok(/^[0-9a-f]{40,64}$/.test(s.worktree_tree) && s.worktree_tree !== s.index_tree, 'the unstaged edit makes the worktree tree its own');
        // The live checkout moves on before the commit: the attempt keeps what the peer saw.
        await writeFile(join(checkout, 'plan.md'), 'the plan, edited after the review\n');
        git('add', 'plan.md');
        await planCommit(ctx, 'macro-plan-tree', 'concerns');
        const a = await macroAttempt(ctx.workflowPath, 'macro-plan-tree');
        deepStrictEqual([a.outcome, a.tree_reason], ['concerns', undefined], JSON.stringify(a));
        deepStrictEqual(a.tree, { head, index_tree: indexTree, worktree_tree: s.worktree_tree }, 'every hash of the snapshot the run took');
        ok(a.tree.index_tree !== git('write-tree'), 'not the checkout at commit time');
      });
    });

    it('a run that completed with an answer takes the synthesis verdict', async () => {
      await withMacro(async (ctx) => {
        await planRun(ctx, 'macro-plan-ok');
        await planCommit(ctx, 'macro-plan-ok', 'concerns');
        const a = await macroAttempt(ctx.workflowPath, 'macro-plan-ok');
        deepStrictEqual([a.outcome, a.status, a.verdict], ['concerns', 'completed', 'concerns']);
      });
    });

    // Each registration alone: an older writer's pending row with no
    // attempt, and an open attempt whose pending row is gone.
    it('a run registered by its pending row alone, its ledger gone, records failed, ledger_missing', async () => {
      await withMacro(async (ctx) => {
        const { frontmatter: f, body } = orchParse(await readFile(ctx.workflowPath, 'utf8'));
        f.pending_ensemble = [{ phase: 'plan', ensemble_type: 'plan-verify', run_id: 'macro-plan-gone', started_at: '2026-11-01T00:00:00Z' }];
        await writeFile(ctx.workflowPath, orchAssemble(f, body));
        strictEqual((await macroFm(ctx.workflowPath)).review_attempts, undefined, 'no attempt registered');
        await planCommit(ctx, 'macro-plan-gone');
        const a = await macroAttempt(ctx.workflowPath, 'macro-plan-gone');
        deepStrictEqual([a.outcome, a.reason, a.tree_reason], ['failed', 'ledger_missing', 'evidence-missing']);
      });
    });

    it('a run registered by its open attempt alone, its ledger gone, records failed, ledger_missing', async () => {
      await withMacro(async (ctx) => {
        await orchPending({ workflowPath: ctx.workflowPath, phase: 'plan', ensemble_type: 'plan-verify', run_id: 'macro-plan-gone' });
        const { frontmatter: f, body } = orchParse(await readFile(ctx.workflowPath, 'utf8'));
        f.pending_ensemble = [];
        await writeFile(ctx.workflowPath, orchAssemble(f, body));
        await planCommit(ctx, 'macro-plan-gone');
        const a = await macroAttempt(ctx.workflowPath, 'macro-plan-gone');
        deepStrictEqual([a.outcome, a.reason, a.tree_reason], ['failed', 'ledger_missing', 'evidence-missing']);
      });
    });

    it('a run launched and committed through a linked directory reads the ledger beside the real file', async () => {
      await withMacro(async (ctx) => {
        const alias = join(ctx.repoRoot, 'alias');
        await symlink(dirname(ctx.workflowPath), alias);
        const linked = { ...ctx, workflowPath: join(alias, basename(ctx.workflowPath)) };
        const run = await planRun(linked, 'macro-plan-linked');
        strictEqual(run.status, 'completed');
        await planCommit(linked, 'macro-plan-linked', 'concerns');
        const a = await macroAttempt(ctx.workflowPath, 'macro-plan-linked');
        deepStrictEqual([a.outcome, a.status], ['concerns', 'completed']);
      });
    });

    it('a repeat over an older writer\'s result leaves the open attempt unknown, and says legacy-writer', async () => {
      await withMacro(async (ctx) => {
        await orchPending({ workflowPath: ctx.workflowPath, phase: 'plan', ensemble_type: 'plan-verify', run_id: 'macro-plan-older' });
        const { frontmatter: f, body } = orchParse(await readFile(ctx.workflowPath, 'utf8'));
        f.ensemble_results = [{ phase: 'plan', ensemble_type: 'plan-verify', run_id: 'macro-plan-older', verdict: 'pass', summary: 's', completed_at: '2026-11-01T00:00:00Z', codex_session_id: null }];
        await writeFile(ctx.workflowPath, orchAssemble(f, body));
        await planCommit(ctx, 'macro-plan-older');
        const doc = JSON.parse((await macroFm(ctx.workflowPath)).review_attempts);
        deepStrictEqual(doc.attempts.map((a) => [a.id, a.state]), [['macro-plan-older', 'open']]);
        deepStrictEqual(doc.coverage.reasons, ['legacy-writer']);
      });
    });

    it('a macro commit of a type that is no review records the gaps of the review rows its prune drops', async () => {
      await withMacro(async (ctx) => {
        await orchCommit({ workflowPath: ctx.workflowPath, run_id: 'macro-plan-first', phase: 'plan', ensemble_type: 'plan-verify', verdict: 'pass', summary: 's', completed_at: '2026-11-01T00:00:00Z' });
        const { frontmatter: f, body } = orchParse(await readFile(ctx.workflowPath, 'utf8'));
        f.ensemble_results.push({ phase: 'plan', ensemble_type: 'plan-verify', run_id: 'macro-plan-older-writer', verdict: 'pass', summary: 's', completed_at: '2026-11-01T00:00:01Z', codex_session_id: null });
        await writeFile(ctx.workflowPath, orchAssemble(f, body));
        for (let i = 0; i < 21; i++) {
          await orchCommit({ workflowPath: ctx.workflowPath, run_id: `investigate-${String(i).padStart(2, '0')}`, phase: 'plan', ensemble_type: 'investigate', verdict: 'pass', summary: 's', completed_at: `2026-11-02T00:00:${String(i).padStart(2, '0')}Z` });
        }
        const after = await macroFm(ctx.workflowPath);
        ok(!after.ensemble_results.some((r) => r.ensemble_type === 'plan-verify'), 'every review row is pruned');
        deepStrictEqual(JSON.parse(after.review_attempts).coverage.reasons, ['missing-outcome']);
      });
    });

    it('a macro gap an older writer pruned unseen stays marked through later writes', async () => {
      await withMacro(async (ctx) => {
        await orchCommit({ workflowPath: ctx.workflowPath, run_id: 'macro-plan-first', phase: 'plan', ensemble_type: 'plan-verify', verdict: 'pass', summary: 's', completed_at: '2026-11-01T00:00:00Z' });
        const { frontmatter: f, body } = orchParse(await readFile(ctx.workflowPath, 'utf8'));
        const { pruneEnsembleResults: orchPrune } = await import(pathToFileURL(ORCH_STATE).href);
        f.ensemble_results = orchPrune([...f.ensemble_results,
          { phase: 'plan', ensemble_type: 'plan-verify', run_id: 'macro-plan-older-writer', verdict: 'pass', summary: 's', completed_at: '2026-11-01T00:00:01Z', codex_session_id: null },
          ...Array.from({ length: 20 }, (_, i) => ({ phase: 'plan', ensemble_type: 'investigate', run_id: `investigate-${String(i).padStart(2, '0')}`, verdict: 'pass', summary: 's', completed_at: `2026-11-02T00:00:${String(i).padStart(2, '0')}Z`, codex_session_id: null }))], 20);
        await writeFile(ctx.workflowPath, orchAssemble(f, body));
        await orchCommit({ workflowPath: ctx.workflowPath, run_id: 'investigate-new', phase: 'plan', ensemble_type: 'investigate', verdict: 'pass', summary: 's', completed_at: '2026-11-03T00:00:00Z' });
        deepStrictEqual(JSON.parse((await macroFm(ctx.workflowPath)).review_attempts).coverage, { history_incomplete: true, reasons: ['pruned-unseen'] });
      });
    });
  });
}
