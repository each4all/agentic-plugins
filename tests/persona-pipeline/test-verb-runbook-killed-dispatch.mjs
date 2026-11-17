// R4 F1, with the real runner and the real dispatch block (ADR-0066 PC2b):
// a dispatch killed after it launched the run leaves its result empty; the
// finalize takes the run the dispatch recorded, stops before any write while
// the peer still runs, and settles it failed once it is abandoned; a ledger
// pruned since settles as ledger_missing. One variant of each finalize
// region, in bash: verb-finalize (engineer's compose),
// verb-finalize-consensus (engineer's critique) and verb-finalize-convergent
// (designer's refine). Large tier (scripts/data/test-tiers.json): it sends
// real signals to a process group and polls the runner's status against
// real time. The fixture is _verb-runbook-fixture.mjs.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, rm, readFile, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { MANIFEST } from './_personas.mjs';
import { verbRunbookFixture } from './_verb-runbook-fixture.mjs';

const shell = 'bash';
const VARIANTS = [
  ['engineer', 'compose', 'regions/verb-finalize.md'],
  ['engineer', 'critique', 'regions/verb-finalize-consensus.md'],
  ['designer', 'refine', 'regions/verb-finalize-convergent.md'],
];

async function waitFor(probe, done, what) {
  for (const end = Date.now() + 20000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    const v = probe();
    if (done(v)) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('the killed-dispatch variants are the finalize regions (guards a vacuous pass)', () => {
  it('each variant\'s verb is generated from its region, and the variants cover every finalize region', () => {
    for (const [persona, verb, template] of VARIANTS) {
      ok(MANIFEST.regions.some((r) => r.dest === `commands/${verb}.md` && r.personas.includes(persona) && r.template === template && /-finalize(-convergent)?$/.test(r.id)), `${persona}/${verb}: ${template}`);
    }
    const all = [...new Set(MANIFEST.regions.filter((r) => /^commands\/\w+\.md$/.test(r.dest) && /-finalize(-convergent|-consensus)?$/.test(r.id)).map((r) => r.template))].sort();
    deepStrictEqual(VARIANTS.map(([, , t]) => t).sort(), all);
  });
});

for (const [persona, verb] of VARIANTS) {
  const fx = await verbRunbookFixture(persona);
  const { P, ROOT_ENV, readWorkflow, runBlock, state, withTexts, lastTextDir, withRepo, createWorkflow, archive, stubCompanions, statusOf } = fx;
  const finalize = (opts) => fx.finalize(fx.committed, verb, opts);

  describe(`${persona}: verb runbook blocks (${shell}, committed), a killed dispatch`, () => {
    it(`${verb}'s finalize: a dispatch killed after the launch leaves its result empty; the run it recorded is settled — still running, the block stops before any write; abandoned, it settles failed; a pruned ledger settles ledger_missing (R4 F1)`, async () => {
      const hang = await stubCompanions({ hang: true });
      const ok_ = await stubCompanions();
      const scratch = await realpath(await mkdtemp(join(tmpdir(), `${persona}-killed-runner-`)));
      let peerPid = null;
      let hostPid = null;
      try {
        await withRepo(async (dir) => {
          const { dispatch } = fx.verbBlocks(fx.committed, verb);
          ok(dispatch, 'the dispatch block');
          const vars = { ACTIVE: '/w/stale.md', RUN_ID: 'stale', VERDICT: 'stale' };
          const fm = async (wf) => (await readWorkflow(wf)).frontmatter;
          const dispatchIn = async () => {
            const b = await withTexts(dispatch, { 'prompt.xml': '<task>fixture</task>' });
            return { block: b, runDir: lastTextDir() };
          };

          // The dispatch block, as the host runs it, killed with its shell
          // and runner once the peer runs; the peer, in a group of its
          // own, lives on.
          let wf = createWorkflow(dir, verb);
          const killed = await dispatchIn();
          const env = { ...process.env, [ROOT_ENV]: P.root, AGENTIC_COMPANIONS_ROOT: hang, TMPDIR: scratch, ...vars };
          delete env.CLAUDE_PLUGIN_ROOT;
          delete env.AGENTIC_AUTOPILOT;
          const host = spawn(shell, ['-c', killed.block], { cwd: dir, env, stdio: 'ignore', detached: true });
          hostPid = host.pid;
          const exited = once(host, 'exit');
          const id = await waitFor(() => { try { return JSON.parse(state('read', '--workflow-path', wf)).pending_ensemble?.[0]?.run_id; } catch { return undefined; } }, (x) => typeof x === 'string', 'the pending entry');
          const st = await waitFor(() => statusOf(dir, id), (x) => x?.handle?.status === 'running' && Number.isInteger(x.handle.pid), 'the peer to run');
          peerPid = st.handle.pid;
          process.kill(-host.pid, 'SIGKILL');
          await exited;
          strictEqual(readFileSync(join(killed.runDir, 'prompt.xml.run.json'), 'utf8'), '', 'the redirect left the result empty');
          deepStrictEqual(JSON.parse(readFileSync(join(killed.runDir, 'prompt.xml.dispatch.json'), 'utf8')), { run_id: id, workflow_path: wf });

          // The peer still runs: settle, the block's first write, refuses
          // it, so the block stops before any write (R4 G1).
          const before = await readFile(wf, 'utf8');
          let r = runBlock(shell, dir, await finalize({ runDir: killed.runDir }), vars);
          strictEqual(r.status, 1, r.stderr);
          ok(r.stderr.includes(`run ${id} is running and not shown abandoned: collect it first`), r.stderr);
          strictEqual(await readFile(wf, 'utf8'), before, 'nothing was written');

          // The peer gone too: abandoned past the grace, settled failed.
          process.kill(peerPid, 'SIGKILL');
          await waitFor(() => alive(peerPid), (x) => !x, 'the peer to end');
          r = runBlock(shell, dir, await finalize({ runDir: killed.runDir }), { ...vars, PEER_RUN_STALE_GRACE_MS: '1' });
          strictEqual(r.status, 0, r.stderr);
          let got = await fm(wf);
          deepStrictEqual([got.ensemble_results.map((x) => [x.run_id, x.verdict]), got.pending_ensemble ?? [], got.current_phase], [[[id, 'failed']], [], 'summary-complete']);
          ok(got.ensemble_results[0].summary.includes('orphaned'), got.ensemble_results[0].summary);
          archive(dir, wf);

          // A ledger pruned since the run: the result's handle is gone, and
          // settle records the run failed (ledger_missing) from its pending
          // entry.
          wf = createWorkflow(dir, verb);
          const pruned = await dispatchIn();
          r = runBlock(shell, dir, pruned.block, { ...vars, AGENTIC_COMPANIONS_ROOT: ok_ });
          strictEqual(r.status, 0, r.stderr);
          const result = JSON.parse(readFileSync(join(pruned.runDir, 'prompt.xml.run.json'), 'utf8'));
          await rm(dirname(result.handle_path), { recursive: true });
          r = runBlock(shell, dir, await finalize({ runDir: pruned.runDir }), vars);
          strictEqual(r.status, 0, r.stderr);
          got = await fm(wf);
          deepStrictEqual([got.ensemble_results.map((x) => [x.run_id, x.verdict, x.summary]), got.pending_ensemble ?? []], [[[result.run_id, 'failed', 'peer run ledger missing: error_kind=ledger_missing']], []]);
          archive(dir, wf);
        });
      } finally {
        // A poll that timed out before the kill leaves the dispatch's shell
        // and runner alive in their group: ended here, before their
        // directories go, as the peer is once it was found.
        if (hostPid !== null) { try { process.kill(-hostPid, 'SIGKILL'); } catch { /* the group is gone */ } }
        if (peerPid !== null && alive(peerPid)) process.kill(peerPid, 'SIGKILL');
        await rm(hang, { recursive: true, force: true });
        await rm(ok_, { recursive: true, force: true });
        await rm(scratch, { recursive: true, force: true });
      }
    });
  });
}
