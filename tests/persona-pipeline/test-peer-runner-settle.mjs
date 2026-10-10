// peer-runner.mjs settle (ADR-0066 PC2b DD6, RV1, RV2): what an ensemble
// attempt came to, decided from the run ledger, never from shell variables.
//
// Runs go through the real runner against a stub companion (missing, success,
// empty answer, malformed envelope, long-running), so the ledger states are
// the runner's own; the states a killed runner leaves between its writes
// (queued with a pending row, spawning) are written as that runner leaves
// them. Each case checks the workflow file: what settle wrote, or that it
// wrote nothing.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { personaInfo, personasFor } from './_personas.mjs';

const BASELINE = {
  branch: 'test',
  head: '0000000000000000000000000000000000000000',
  status_digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
};

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
if (mode === 'long') {
  process.stdout.write('started\\n');
  setInterval(() => {}, 1000);
} else if (mode === 'json-empty') {
  process.stdout.write(envelope(''));
} else if (mode === 'malformed') {
  process.stdout.write('not json');
} else {
  process.stdout.write(envelope('the peer answer'));
}
`;
  for (const peer of ['claude', 'codex']) {
    await writeFile(join(dir, `${peer}-companion.mjs`), companion);
    await chmod(join(dir, `${peer}-companion.mjs`), 0o755);
  }
  return dir;
}

async function waitFor(predicate, message, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${message}`);
}

for (const persona of personasFor('scripts/peer-runner.mjs')) {
  const P = personaInfo(persona);
  const RUNNER = P.path('scripts/peer-runner.mjs');
  const {
    HANDLE_SCHEMA_VERSION,
    SettleRefusal,
    cancelPeerRun,
    peerRunPaths,
    readHandle,
    reconcileOne,
    runPeer,
    settleEnsemble,
    writeHandle,
  } = await import(pathToFileURL(RUNNER).href);
  const { createWorkflow, listWorkflowFiles, parseWorkflowFile, recordPendingEnsemble, commitEnsemble } =
    await import(pathToFileURL(P.path('scripts/state.mjs')).href);

  async function withWorkflow(fn) {
    const repoRoot = await mkdtemp(join(tmpdir(), `${persona}-settle-`));
    try {
      await createWorkflow({ repoRoot, verb: 'compose', host: 'claude', persona, gitBaseline: BASELINE, originalRequest: 'settle' });
      const [workflowPath] = await listWorkflowFiles(repoRoot);
      const companions = await writeCompanions(repoRoot);
      await fn({ repoRoot, workflowPath, companions });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  }

  const fm = async (workflowPath) => parseWorkflowFile(await readFile(workflowPath, 'utf8')).frontmatter;
  const results = async (workflowPath) => (await fm(workflowPath)).ensemble_results ?? [];
  const pendings = async (workflowPath) => (await fm(workflowPath)).pending_ensemble ?? [];

  const ensembleRun = (ctx, runId, env = {}, extra = {}) => runPeer({
    repoRoot: ctx.repoRoot,
    runId,
    kind: 'ensemble',
    workflowPath: ctx.workflowPath,
    phase: 'compose',
    ensembleType: 'plan-verify',
    host: 'claude',
    peer: 'codex',
    promptText: '<task>settle</task>',
    outputFormat: 'json',
    cwd: ctx.repoRoot,
    env: { ...process.env, AGENTIC_COMPANIONS_ROOT: ctx.companions, ...env },
    ...extra,
  });

  // The handle a runner leaves at a write boundary, written as it writes it.
  async function leftBehind(ctx, runId, overrides = {}) {
    const paths = peerRunPaths(ctx.repoRoot, runId);
    await mkdir(paths.dir, { recursive: true, mode: 0o700 });
    await writeFile(paths.stdout, '');
    await writeFile(paths.stderr, '');
    const at = overrides.updated_at ?? new Date().toISOString();
    await writeHandle(paths.handle, {
      schema_version: HANDLE_SCHEMA_VERSION, run_id: runId, plugin: persona, kind: 'ensemble',
      workflow_path: ctx.workflowPath, phase: 'compose', ensemble_type: 'plan-verify', host: 'claude',
      peer_host: 'codex', model: null, effort: null, cwd: ctx.repoRoot, output_format: 'json',
      status: 'queued', pid: null, pgid: null, process_fingerprint: { kind: 'none' },
      started_at: at, updated_at: at, completed_at: null, last_output_at: null,
      stdout_bytes: 0, stderr_bytes: 0, exit_code: null, error_kind: null, prompt_retained: false,
      ...overrides,
    });
    return paths;
  }
  const pend = (ctx, runId, ensembleType = 'plan-verify') => recordPendingEnsemble({
    workflowPath: ctx.workflowPath, phase: 'compose', ensemble_type: ensembleType, run_id: runId, started_at: new Date().toISOString(),
  });
  const settle = (ctx, runId, extra = {}) => settleEnsemble({ repoRoot: ctx.repoRoot, workflowPath: ctx.workflowPath, phase: 'compose', runId, ...extra });
  const refused = (promise, pattern) => rejects(promise, (err) => err instanceof SettleRefusal && pattern.test(err.message));
  const OLD = '2020-01-01T00:00:00.000Z';

  describe(`${persona}: settle — never launched`, () => {
    it('with no run id, no pending entry and no ledger: skipped, nothing written (CLI exit 0)', async () => {
      await withWorkflow(async (ctx) => {
        const before = await readFile(ctx.workflowPath, 'utf8');
        const r = spawnSync(process.execPath, [RUNNER, 'settle', '--repo-root', ctx.repoRoot, '--workflow-path', ctx.workflowPath, '--host', 'claude', '--phase', 'compose', '--run-id', ''], { encoding: 'utf8' });
        strictEqual(r.status, 0, r.stderr);
        strictEqual(JSON.parse(r.stdout).settlement, 'skipped');
        ok(r.stderr.includes('settlement: skipped'), r.stderr);
        strictEqual(await readFile(ctx.workflowPath, 'utf8'), before);
      });
    });

    it('with no run id but a pending entry for the phase: refused (CLI exit 1), nothing written', async () => {
      await withWorkflow(async (ctx) => {
        await pend(ctx, 'plan-verify-a');
        const before = await readFile(ctx.workflowPath, 'utf8');
        const r = spawnSync(process.execPath, [RUNNER, 'settle', '--repo-root', ctx.repoRoot, '--workflow-path', ctx.workflowPath, '--phase', 'compose', '--run-id', ''], { encoding: 'utf8' });
        strictEqual(r.status, 1, r.stderr);
        deepStrictEqual(JSON.parse(r.stdout).settlement, 'refused');
        ok(r.stderr.includes('plan-verify-a'), r.stderr);
        strictEqual(await readFile(ctx.workflowPath, 'utf8'), before);
      });
    });

    it('with no run id but a ledger naming this workflow and phase with no result (its pending registration failed): refused', async () => {
      await withWorkflow(async (ctx) => {
        await leftBehind(ctx, 'plan-verify-b', { status: 'completed', completed_at: OLD });
        await refused(settle(ctx, ''), /unsettled ensemble attempt .*plan-verify-b/);
        // Another phase's or another workflow's ledger does not count.
        await rm(peerRunPaths(ctx.repoRoot, 'plan-verify-b').dir, { recursive: true });
        await leftBehind(ctx, 'plan-verify-c', { phase: 'critique' });
        await leftBehind(ctx, 'plan-verify-d', { workflow_path: join(ctx.repoRoot, 'other.md') });
        strictEqual((await settle(ctx, '')).settlement, 'skipped');
      });
    });

    // legacy_homes on (ADR-0025): a workflow still in the pre-migration home
    // has its ledgers there, and the scan reads each run from that home.
    if (P.capabilities.legacy_homes) it('with no run id and a legacy-home ledger naming this workflow and phase: refused (legacy_homes on)', async () => {
      await withWorkflow(async (ctx) => {
        const legacyState = join(ctx.repoRoot, '.claude', `agentic-${persona}`);
        await mkdir(join(ctx.repoRoot, '.claude'), { recursive: true });
        await rename(join(ctx.repoRoot, P.stateDirRel), legacyState);
        const workflowPath = join(legacyState, 'workflows', basename(ctx.workflowPath));
        const legacy = { ...ctx, workflowPath };
        const paths = peerRunPaths(ctx.repoRoot, 'plan-verify-l', { home: 'legacy' });
        await mkdir(paths.dir, { recursive: true, mode: 0o700 });
        const at = OLD;
        await writeHandle(paths.handle, {
          schema_version: HANDLE_SCHEMA_VERSION, run_id: 'plan-verify-l', plugin: persona, kind: 'ensemble',
          workflow_path: workflowPath, phase: 'compose', ensemble_type: 'plan-verify', host: 'claude',
          peer_host: 'codex', model: null, effort: null, cwd: ctx.repoRoot, output_format: 'json',
          status: 'completed', pid: null, pgid: null, process_fingerprint: { kind: 'none' },
          started_at: at, updated_at: at, completed_at: at, last_output_at: null,
          stdout_bytes: 0, stderr_bytes: 0, exit_code: 0, error_kind: null, prompt_retained: false,
        });
        await refused(settle(legacy, ''), /unsettled ensemble attempt .*plan-verify-l/);
      });
    });

    it('with no run id and a handle that cannot be read: refused, it could be the attempt', async () => {
      await withWorkflow(async (ctx) => {
        const paths = peerRunPaths(ctx.repoRoot, 'plan-verify-x');
        await mkdir(paths.dir, { recursive: true });
        await writeFile(paths.handle, '{ torn');
        await refused(settle(ctx, ''), /plan-verify-x \(unreadable handle\)/);
      });
    });

    it('a full results list does not block a skip with a run that ended long before its oldest entry', async () => {
      await withWorkflow(async (ctx) => {
        for (let i = 0; i < 20; i++) {
          await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: `r-${String(i).padStart(2, '0')}`, phase: 'compose', ensemble_type: 'plan-verify', verdict: 'agree', summary: 's', completed_at: `2026-10-01T00:00:${String(i).padStart(2, '0')}Z` });
        }
        await leftBehind(ctx, 'plan-verify-pruned', { status: 'completed', started_at: '2026-09-01T00:00:00.000Z', completed_at: '2026-09-01T00:05:00.000Z', updated_at: OLD });
        strictEqual((await settle(ctx, '')).settlement, 'skipped');
        await leftBehind(ctx, 'plan-verify-recent', { status: 'completed', started_at: '2026-10-02T00:00:00.000Z', completed_at: '2026-10-02T00:05:00.000Z' });
        await refused(settle(ctx, ''), /plan-verify-recent/);
      });
    });

    // Re-review of the code-step-6 fixes: a settlement follows the run's end,
    // so a run that started before the oldest kept entry but ended after it
    // cannot have been settled and pruned; one with no end time counts too.
    it('a full results list does not hide a run that started before its oldest entry but ended after it (re-review)', async () => {
      await withWorkflow(async (ctx) => {
        for (let i = 0; i < 20; i++) {
          await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: `r-${String(i).padStart(2, '0')}`, phase: 'compose', ensemble_type: 'plan-verify', verdict: 'agree', summary: 's', completed_at: `2026-10-01T00:00:${String(i).padStart(2, '0')}Z` });
        }
        await leftBehind(ctx, 'plan-verify-straddles', { status: 'completed', started_at: '2026-09-01T00:00:00.000Z', completed_at: '2026-10-01T00:00:05.000Z', updated_at: OLD });
        await refused(settle(ctx, ''), /plan-verify-straddles/);
        await rm(peerRunPaths(ctx.repoRoot, 'plan-verify-straddles').dir, { recursive: true });
        await leftBehind(ctx, 'plan-verify-no-end', { status: 'failed', started_at: '2026-09-01T00:00:00.000Z', completed_at: null, updated_at: OLD });
        await refused(settle(ctx, ''), /plan-verify-no-end/);
      });
    });

    it('a full results list does not hide an older attempt that never reached a terminal status (Review of code step 6)', async () => {
      await withWorkflow(async (ctx) => {
        for (let i = 0; i < 20; i++) {
          await commitEnsemble({ workflowPath: ctx.workflowPath, run_id: `r-${String(i).padStart(2, '0')}`, phase: 'compose', ensemble_type: 'plan-verify', verdict: 'agree', summary: 's', completed_at: `2026-10-01T00:00:${String(i).padStart(2, '0')}Z` });
        }
        // Its pending registration failed, so only the ledger shows it; a
        // settle commits only a terminal run, so this one was never settled.
        await leftBehind(ctx, 'plan-verify-old-open', { status: 'running', started_at: '2026-09-01T00:00:00.000Z', pid: process.pid });
        await refused(settle(ctx, ''), /plan-verify-old-open/);
      });
    });
  });

  describe(`${persona}: settle — launched and failed or abandoned`, () => {
    it('a missing companion: the pending entry is settled failed with peer_cli_not_found; the agent\'s verdict is not used', async () => {
      await withWorkflow(async (ctx) => {
        ctx.companions = await writeCompanions(ctx.repoRoot, { missing: true });
        const run = await ensembleRun(ctx, 'plan-verify-missing');
        deepStrictEqual([run.status, run.error_kind], ['failed', 'peer_cli_not_found']);
        strictEqual((await pendings(ctx.workflowPath)).length, 1, 'the runner leaves its pending entry');
        const s = await settle(ctx, 'plan-verify-missing', { verdict: 'agree', summary: 'all good' });
        deepStrictEqual([s.settlement, s.verdict, s.error_kind], ['committed', 'failed', 'peer_cli_not_found']);
        deepStrictEqual((await pendings(ctx.workflowPath)), []);
        const [result] = await results(ctx.workflowPath);
        deepStrictEqual([result.run_id, result.ensemble_type, result.verdict, result.summary], ['plan-verify-missing', 'plan-verify', 'failed', 'peer run failed: error_kind=peer_cli_not_found']);
      });
    });

    it('a malformed envelope: failed with envelope_parse_error', async () => {
      await withWorkflow(async (ctx) => {
        const run = await ensembleRun(ctx, 'plan-verify-malformed', { FAKE_COMPANION_MODE: 'malformed' });
        deepStrictEqual([run.status, run.error_kind], ['failed', 'envelope_parse_error']);
        const s = await settle(ctx, 'plan-verify-malformed');
        deepStrictEqual([s.verdict, (await results(ctx.workflowPath))[0].summary], ['failed', 'peer run failed: error_kind=envelope_parse_error']);
      });
    });

    it('a cancelled run: failed with cancelled', async () => {
      await withWorkflow(async (ctx) => {
        const running = ensembleRun(ctx, 'plan-verify-cancel', { FAKE_COMPANION_MODE: 'long' });
        const paths = peerRunPaths(ctx.repoRoot, 'plan-verify-cancel');
        // The stub never exits on its own: whatever fails below, it is
        // cancelled, or the run (and this test file) would wait on it forever.
        try {
          await waitFor(async () => (await readHandle(paths.handle).catch(() => null))?.status === 'running', 'running');
          await refused(settle(ctx, 'plan-verify-cancel'), /running and not shown abandoned: collect it first/);
          strictEqual((await results(ctx.workflowPath)).length, 0, 'a live run is not settled');
        } finally {
          strictEqual((await cancelPeerRun({ repoRoot: ctx.repoRoot, runId: 'plan-verify-cancel', graceMs: 2000 })).ok, true);
          await running;
        }
        const s = await settle(ctx, 'plan-verify-cancel');
        deepStrictEqual([s.status, s.verdict, (await results(ctx.workflowPath))[0].summary], ['cancelled', 'failed', 'peer run cancelled: error_kind=cancelled']);
      });
    });

    // The runner killed at each write boundary. Before the spawn the handle
    // carries no process, so a fresh one could still be starting: refused,
    // then orphaned once stale.
    for (const status of ['queued', 'spawning']) {
      it(`a runner killed while ${status}, after its pending entry: refused while fresh, settled failed (orphaned) once stale`, async () => {
        await withWorkflow(async (ctx) => {
          await leftBehind(ctx, `plan-verify-${status}`, { status });
          await pend(ctx, `plan-verify-${status}`);
          await refused(settle(ctx, `plan-verify-${status}`), new RegExp(`${status} and not shown abandoned`));
          strictEqual((await pendings(ctx.workflowPath)).length, 1);
          const s = await settle(ctx, `plan-verify-${status}`, { staleGraceMs: 0 });
          deepStrictEqual([s.status, s.verdict, s.error_kind], ['orphaned', 'failed', 'orphaned']);
          deepStrictEqual(await pendings(ctx.workflowPath), []);
        });
      });
    }

    it('a runner killed while running: refused while its companion lives, settled failed (orphaned) once it is gone', async () => {
      await withWorkflow(async (ctx) => {
        const runner = spawn(process.execPath, [RUNNER, 'run', '--repo-root', ctx.repoRoot, '--kind', 'ensemble', '--peer', 'codex',
          '--prompt-text', '<task>x</task>', '--workflow-path', ctx.workflowPath, '--phase', 'compose', '--host', 'claude',
          '--cwd', ctx.repoRoot, '--ensemble-type', 'plan-verify', '--run-id', 'plan-verify-killed'], {
          env: { ...process.env, AGENTIC_COMPANIONS_ROOT: ctx.companions, FAKE_COMPANION_MODE: 'long' }, stdio: 'ignore',
        });
        const paths = peerRunPaths(ctx.repoRoot, 'plan-verify-killed');
        // Its one line already written: killed before it, the stub would die
        // writing to the broken pipe, and the case would test nothing.
        const handle = await waitFor(async () => {
          const h = await readHandle(paths.handle).catch(() => null);
          return h?.status === 'running' && h.pid && h.stdout_bytes > 0 ? h : null;
        }, 'running with output');
        const exited = new Promise((r) => runner.once('exit', r));
        runner.kill('SIGKILL');
        await exited;
        try {
          await refused(settle(ctx, 'plan-verify-killed', { staleGraceMs: 0 }), /running and not shown abandoned/);
        } finally {
          try { process.kill(-handle.pgid, 'SIGKILL'); } catch { /* gone */ }
        }
        await waitFor(async () => { try { process.kill(handle.pid, 0); return false; } catch { return true; } }, 'companion gone');
        const s = await settle(ctx, 'plan-verify-killed', { staleGraceMs: 0 });
        deepStrictEqual([s.status, s.verdict], ['orphaned', 'failed']);
        deepStrictEqual(await pendings(ctx.workflowPath), []);
      });
    });

    it('a pending entry whose ledger is gone: settled failed (ledger_missing); a run id with neither is refused', async () => {
      await withWorkflow(async (ctx) => {
        await pend(ctx, 'plan-verify-pruned');
        const s = await settle(ctx, 'plan-verify-pruned');
        deepStrictEqual([s.verdict, s.error_kind, (await results(ctx.workflowPath))[0].summary], ['failed', 'ledger_missing', 'peer run ledger missing: error_kind=ledger_missing']);
        await refused(settle(ctx, 'plan-verify-nothing'), /no ledger and no pending entry/);
      });
    });
  });

  describe(`${persona}: settle — completed`, () => {
    it('a usable answer: the synthesis verdict and summary; without either, or with "failed", refused', async () => {
      await withWorkflow(async (ctx) => {
        const run = await ensembleRun(ctx, 'plan-verify-ok');
        strictEqual(run.status, 'completed');
        await refused(settle(ctx, 'plan-verify-ok', { summary: 's' }), /needs the synthesis --verdict/);
        await refused(settle(ctx, 'plan-verify-ok', { verdict: 'failed', summary: 's' }), /reserved for a run that failed/);
        await refused(settle(ctx, 'plan-verify-ok', { verdict: 'agree' }), /needs the synthesis --summary/);
        strictEqual((await pendings(ctx.workflowPath)).length, 1, 'a refusal writes nothing');
        const s = await settle(ctx, 'plan-verify-ok', { verdict: 'modify', summary: 'two gaps\nfolded in' });
        deepStrictEqual([s.settlement, s.verdict], ['committed', 'modify']);
        const [result] = await results(ctx.workflowPath);
        deepStrictEqual([result.verdict, result.summary], ['modify', 'two gaps folded in']);
        deepStrictEqual(await pendings(ctx.workflowPath), []);
      });
    });

    it('an empty answer: degraded, the synthesis local-only, whatever verdict the agent passes', async () => {
      await withWorkflow(async (ctx) => {
        const run = await ensembleRun(ctx, 'plan-verify-empty', { FAKE_COMPANION_MODE: 'json-empty' });
        strictEqual(run.status, 'completed', 'the envelope validator accepts an empty successful stdout');
        const s = await settle(ctx, 'plan-verify-empty', { verdict: 'agree', summary: 'local findings' });
        deepStrictEqual([s.verdict, s.answer], ['degraded', 'empty']);
        strictEqual((await results(ctx.workflowPath))[0].summary, 'peer answer empty; the synthesis is local-only: local findings');
      });
    });

    it('an unreadable answer (the completed run\'s envelope is gone): degraded, apart from a malformed envelope', async () => {
      await withWorkflow(async (ctx) => {
        await ensembleRun(ctx, 'plan-verify-gone');
        await rm(peerRunPaths(ctx.repoRoot, 'plan-verify-gone').envelope);
        const s = await settle(ctx, 'plan-verify-gone', { verdict: 'agree', summary: 's' });
        deepStrictEqual([s.status, s.verdict, s.answer], ['completed', 'degraded', 'unreadable']);
      });
    });

    it('a run whose pending registration failed but whose companion ran: settled by its run id', async () => {
      await withWorkflow(async (ctx) => {
        const aside = `${ctx.workflowPath}.aside`;
        await rename(ctx.workflowPath, aside);
        const run = await ensembleRun(ctx, 'plan-verify-unregistered');
        await rename(aside, ctx.workflowPath);
        strictEqual(run.status, 'completed');
        deepStrictEqual(await pendings(ctx.workflowPath), [], 'registration failed: no pending entry');
        await refused(settle(ctx, ''), /plan-verify-unregistered/);
        strictEqual((await settle(ctx, 'plan-verify-unregistered', { verdict: 'agree', summary: 's' })).settlement, 'committed');
        strictEqual((await settle(ctx, '')).settlement, 'skipped');
      });
    });
  });

  // ADR-0059 amendment (j): the synthesis summary an agent wrote reaches
  // settle as a file it wrote with its file-writing tool, read when the CLI
  // starts — before a failed run's result is committed.
  describe(`${persona}: settle --summary-file (ADR-0059 amendment (j))`, () => {
    // The child runs in the temporary repository, where the sentinels below
    // look: --repo-root does not change a process's working directory.
    const cliSettle = (ctx, runId, args) => spawnSync(process.execPath, [RUNNER, 'settle', '--repo-root', ctx.repoRoot,
      '--workflow-path', ctx.workflowPath, '--host', 'claude', '--phase', 'compose', '--run-id', runId, ...args], { cwd: ctx.repoRoot, encoding: 'utf8' });
    const HOSTILE = `--leading \`touch pwned-tick\` $(touch pwned-sub) "dq" 'sq' back\\slash ü`;

    it('a completed run records the summary as the file holds it, one trailing newline removed and its lines joined as settle joins them; nothing in it runs, and the file is kept', async () => {
      await withWorkflow(async (ctx) => {
        strictEqual((await ensembleRun(ctx, 'plan-verify-file')).status, 'completed');
        const file = join(ctx.repoRoot, 'summary.txt');
        await writeFile(file, `${HOSTILE}\nsecond line\n`);
        const r = cliSettle(ctx, 'plan-verify-file', ['--verdict', 'agree', '--summary-file', file]);
        strictEqual(r.status, 0, r.stderr);
        const [result] = await results(ctx.workflowPath);
        deepStrictEqual([result.verdict, result.summary], ['agree', `${HOSTILE} second line`]);
        strictEqual(await readFile(file, 'utf8'), `${HOSTILE}\nsecond line\n`, 'the file is kept as written');
        for (const name of ['pwned-tick', 'pwned-sub']) {
          await rejects(readFile(join(ctx.repoRoot, name)), { code: 'ENOENT' }, `${name}: nothing in the summary ran`);
        }
      });
    });

    it('both forms, or a file that cannot be used, refuse (exit 2) before the failed result of a launched run is committed', async () => {
      await withWorkflow(async (ctx) => {
        ctx.companions = await writeCompanions(ctx.repoRoot, { missing: true });
        strictEqual((await ensembleRun(ctx, 'plan-verify-early')).status, 'failed');
        const before = await readFile(ctx.workflowPath, 'utf8');
        const good = join(ctx.repoRoot, 'good.txt');
        const empty = join(ctx.repoRoot, 'empty.txt');
        const notUtf8 = join(ctx.repoRoot, 'latin1.txt');
        const nul = join(ctx.repoRoot, 'nul.txt');
        await writeFile(good, 'local findings\n');
        await writeFile(empty, '\n');
        await writeFile(notUtf8, Buffer.from([0x66, 0xe9, 0x0a]));
        await writeFile(nul, 'a\0b\n');
        const cases = [
          [['--summary', '', '--summary-file', good], /pass --summary or --summary-file, not both/],
          [['--summary-file', join(ctx.repoRoot, 'missing.txt'), '--summary-file', good], /--summary-file is given more than once/],
          [['--summary-file', join(ctx.repoRoot, 'missing.txt')], /--summary-file: cannot read .*ENOENT/],
          [['--summary-file', empty], /--summary-file: .* is empty/],
          [['--summary-file', notUtf8], /--summary-file: .* is not valid UTF-8/],
          [['--summary-file', nul], /--summary-file: .* holds a NUL byte/],
          [['--summary-file', '-'], /standard input/],
        ];
        const handle = peerRunPaths(ctx.repoRoot, 'plan-verify-early').handle;
        const handleBefore = await readFile(handle, 'utf8');
        for (const [args, pattern] of cases) {
          const r = cliSettle(ctx, 'plan-verify-early', args);
          strictEqual(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
          ok(pattern.test(r.stderr), `${args.join(' ')}: ${r.stderr}`);
          strictEqual(await readFile(ctx.workflowPath, 'utf8'), before, `${args.join(' ')}: nothing written`);
          strictEqual(await readFile(handle, 'utf8'), handleBefore, `${args.join(' ')}: the run ledger is untouched`);
        }
        // Control: the same settle with a usable file commits the failed result.
        const r = cliSettle(ctx, 'plan-verify-early', ['--summary-file', good]);
        strictEqual(r.status, 0, r.stderr);
        deepStrictEqual((await results(ctx.workflowPath)).map((e) => e.verdict), ['failed']);
      });
    });
  });

  describe(`${persona}: settle — identity and repetition`, () => {
    it('refuses a ledger that is not this attempt: a peer-now run, another workflow, another phase, another ensemble type', async () => {
      await withWorkflow(async (ctx) => {
        await leftBehind(ctx, 'peer-now-1', { kind: 'peer-now', status: 'completed' });
        await refused(settle(ctx, 'peer-now-1'), /peer-now run, not an ensemble attempt/);
        await leftBehind(ctx, 'plan-verify-other', { workflow_path: join(ctx.repoRoot, 'other.md'), status: 'failed' });
        await refused(settle(ctx, 'plan-verify-other'), /belongs to another workflow/);
        await leftBehind(ctx, 'plan-verify-phase', { phase: 'critique', status: 'failed' });
        await refused(settle(ctx, 'plan-verify-phase'), /is phase critique, not compose/);
        await leftBehind(ctx, 'plan-verify-type', { status: 'failed', error_kind: 'peer_run_error' });
        await pend(ctx, 'plan-verify-type', 'brainstorm');
        await refused(settle(ctx, 'plan-verify-type'), /ensemble type brainstorm is not the ledger's plan-verify/);
        deepStrictEqual(await results(ctx.workflowPath), []);
      });
    });

    it('a repeated settle is a reported no-op, for a failed and for a completed run', async () => {
      await withWorkflow(async (ctx) => {
        await leftBehind(ctx, 'plan-verify-f', { status: 'failed', error_kind: 'peer_run_error' });
        await pend(ctx, 'plan-verify-f');
        strictEqual((await settle(ctx, 'plan-verify-f')).settlement, 'committed');
        deepStrictEqual(await settle(ctx, 'plan-verify-f'), { ok: true, settlement: 'already-settled', run_id: 'plan-verify-f', phase: 'compose', verdict: 'failed' });
        await ensembleRun(ctx, 'plan-verify-c');
        strictEqual((await settle(ctx, 'plan-verify-c', { verdict: 'agree', summary: 's' })).settlement, 'committed');
        strictEqual((await settle(ctx, 'plan-verify-c', { verdict: 'conflict', summary: 'other' })).settlement, 'already-settled');
        deepStrictEqual((await results(ctx.workflowPath)).map((r) => [r.run_id, r.verdict]), [['plan-verify-f', 'failed'], ['plan-verify-c', 'agree']]);
      });
    });

    it('reconcile never replaces a terminal status the runner wrote after the caller read the handle (Review of code step 6)', async () => {
      await withWorkflow(async (ctx) => {
        const paths = await leftBehind(ctx, 'plan-verify-late', { status: 'cancelled', error_kind: 'cancelled', updated_at: OLD });
        const stale = { ...(await readHandle(paths.handle)), status: 'queued', updated_at: OLD, started_at: OLD };
        const next = await reconcileOne(paths, stale, { staleGraceMs: 1000, now: new Date() });
        strictEqual(next.status, 'cancelled');
        strictEqual((await readHandle(paths.handle)).status, 'cancelled');
      });
    });

    it('reconcile through an envelope never replaces a terminal status already on disk (re-review)', async () => {
      await withWorkflow(async (ctx) => {
        const envelope = JSON.stringify({ status: 'success', peer_host: 'codex', peer_model: null, stdout: 'answer', exit_code: 0 });
        // Control: a running handle with that envelope reconciles to completed.
        const live = await leftBehind(ctx, 'plan-verify-env-ok', { status: 'running', updated_at: OLD, started_at: OLD });
        await writeFile(live.envelope, envelope);
        strictEqual((await reconcileOne(live, await readHandle(live.handle), { staleGraceMs: 1000, now: new Date() })).status, 'completed', 'the envelope is one reconcile accepts');
        // A cancel landed after the caller read the handle.
        const paths = await leftBehind(ctx, 'plan-verify-env-late', { status: 'cancelled', error_kind: 'cancelled', updated_at: OLD });
        await writeFile(paths.envelope, envelope);
        const stale = { ...(await readHandle(paths.handle)), status: 'running' };
        strictEqual((await reconcileOne(paths, stale, { staleGraceMs: 1000, now: new Date() })).status, 'cancelled');
        strictEqual((await readHandle(paths.handle)).status, 'cancelled');
        await writeFile(paths.envelope, '{ torn');
        strictEqual((await reconcileOne(paths, stale, { staleGraceMs: 1000, now: new Date() })).status, 'cancelled', 'an unparseable envelope does not replace it either');
      });
    });

    it('a repeated commit returns the entry already recorded, read under its lock (re-review)', async () => {
      await withWorkflow(async (ctx) => {
        const base = { workflowPath: ctx.workflowPath, run_id: 'plan-verify-k', phase: 'compose', ensemble_type: 'plan-verify', summary: 's' };
        const first = await commitEnsemble({ ...base, verdict: 'agree' });
        deepStrictEqual([first.idempotentSkip, first.kept], [false, null]);
        const second = await commitEnsemble({ ...base, verdict: 'conflict' });
        deepStrictEqual([second.idempotentSkip, second.kept?.verdict], [true, 'agree']);
      });
    });

    it('two concurrent settles of a completed run report the verdict the workflow holds (Review of code step 6)', async () => {
      await withWorkflow(async (ctx) => {
        const run = await ensembleRun(ctx, 'plan-verify-twice');
        strictEqual(run.status, 'completed');
        const both = await Promise.all([
          settle(ctx, 'plan-verify-twice', { verdict: 'agree', summary: 'one' }),
          settle(ctx, 'plan-verify-twice', { verdict: 'conflict', summary: 'two' }),
        ]);
        const [kept] = await results(ctx.workflowPath);
        deepStrictEqual(both.map((s) => s.settlement).sort(), ['already-settled', 'committed']);
        deepStrictEqual(both.map((s) => s.verdict), [kept.verdict, kept.verdict]);
      });
    });

    it('two concurrent settles record one result', async () => {
      await withWorkflow(async (ctx) => {
        await leftBehind(ctx, 'plan-verify-race', { status: 'failed', error_kind: 'peer_run_error' });
        await pend(ctx, 'plan-verify-race');
        const both = await Promise.all([settle(ctx, 'plan-verify-race'), settle(ctx, 'plan-verify-race')]);
        deepStrictEqual(both.map((s) => s.settlement).sort(), ['already-settled', 'committed']);
        strictEqual((await results(ctx.workflowPath)).length, 1);
        deepStrictEqual(await pendings(ctx.workflowPath), []);
      });
    });
  });
}
