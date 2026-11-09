// C176 (ADR-0063, amendment of 2026-11-09) — the convergence rule of the
// autopilot critique -> refine loop, in every persona the units reach:
//
//   - the deferral boundary (lib/review-scope.mjs closeGeneration): from
//     round 2 a MAJOR whose every reference carries `defer` is deferred, keeps
//     its severity and no longer blocks convergence; round 1, a CRITICAL, a
//     MINOR, a recurring finding, one flagged veto or conflict (sticky across
//     generations) and an ambiguous judgment are refused, each named; a later
//     critique that does not report a deferred finding leaves it deferred, one
//     that reports it with no `defer` opens it again
//   - the critique cap (state.mjs): finish-verb counts a critique synthesis
//     once per critique run (a rerun, another verb and an interrupted run add
//     nothing), the keys survive a re-read, and under an autopilot run a
//     critique at the cap that would start another round is refused, by
//     finish-verb and by critique-cap-check, while a clean one proceeds and
//     the critique-cap gate records; the owner's grant sets the limit relative
//     to the count, and another round at the cap without it is refused, on
//     critique-cap and on peer-conflict alike
//   - with dispatch_target off (founder, designer) nothing is counted

for (const name of Object.keys(process.env)) if (name.startsWith('AGENTIC_')) delete process.env[name];

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { personaInfo, personasFor } from './_personas.mjs';

const RUN = 'autopilot-20261109T141258Z-7f6e05';
const NOW = '2026-11-09T00:00:00Z';

// ---------------------------------------------------------------------------
// The deferral boundary (pure)

for (const persona of personasFor('scripts/lib/review-scope.mjs')) {
  const RS = await import(pathToFileURL(personaInfo(persona).path('scripts/lib/review-scope.mjs')).href);
  const FIELDS = { mode: 'full', reason: 'full', tree: 't', head: 'h', base: 'b', artifact: ['a.md'], document: true, targets: [] };
  // One critique: open the next generation and close it with `findings`.
  const critique = (ledger, findings, fields = {}) => {
    const opened = RS.openGeneration(ledger, { ...FIELDS, ...fields }, NOW);
    return RS.closeGeneration(opened.ledger, opened.generation, { findings }, NOW);
  };
  const NEW = (severity, extra = {}) => ({ id: 'NEW', severity, location: 'a.md:3', text: `a ${severity} finding`, ...extra });
  const DEFER = 'a hand-made file only';
  const byId = (ledger, id) => ledger.findings.find((f) => f.id === id);

  describe(`${persona}: C176 deferral boundary (review-scope closeGeneration)`, () => {
    it('round 1 never defers: the MAJOR is carried and the refusal named', () => {
      const one = critique(RS.emptyLedger('wf'), [NEW('MAJOR', { defer: DEFER })]);
      deepStrictEqual([one.result.round, one.result.converged, one.result.carry, one.result.deferred_now], [1, false, ['G1-F1'], []]);
      deepStrictEqual(one.result.deferral_refused, [{ id: 'G1-F1', reason: 'round' }]);
      strictEqual(byId(one.ledger, 'G1-F1').disposition, 'open');
    });

    it('round 2 defers a MAJOR whose every reference carries defer: severity kept, converged, the known limit stored and projected', () => {
      const one = critique(RS.emptyLedger('wf'), [NEW('MAJOR')]);
      const two = critique(one.ledger, [{ id: 'G1-F1', severity: 'MAJOR', defer: DEFER }, NEW('MAJOR', { defer: 'a special layout' })]);
      deepStrictEqual([two.result.round, two.result.converged, two.result.carry], [2, true, []]);
      deepStrictEqual([two.result.deferred_now, two.result.deferred, two.result.deferral_refused], [['G1-F1', 'G2-F1'], ['G1-F1', 'G2-F1'], []]);
      const f = byId(two.ledger, 'G1-F1');
      deepStrictEqual([f.disposition, f.severity, f.defer_reason], ['deferred', 'MAJOR', DEFER]);
      const status = RS.reviewStatus(two.ledger);
      deepStrictEqual([status.carry, status.deferred, status.round], [[], ['G1-F1', 'G2-F1'], 3]);
      deepStrictEqual(status.findings.find((x) => x.id === 'G1-F1').defer_reason, DEFER);
      // The ledger stays one this module (and so the next critique) reads.
      RS.validateLedger(two.ledger, 'wf');
      deepStrictEqual(two.ledger.generations.map((g) => g.round), [1, 2]);
    });

    it('a CRITICAL, a MINOR and a recurring MAJOR are never deferred', () => {
      const one = critique(RS.emptyLedger('wf'), [NEW('CRITICAL'), NEW('MINOR'), NEW('MAJOR')]);
      const refined = RS.recordRefine(one.ledger, { targets: ['G1-F3'], treeAfter: 't2' }, NOW).ledger;
      const two = critique(refined, [
        { id: 'G1-F1', defer: DEFER },
        { id: 'G1-F2', defer: DEFER },
        { id: 'G1-F3', verdict: 'unresolved', defer: DEFER },
      ]);
      deepStrictEqual(two.result.deferral_refused, [
        { id: 'G1-F1', reason: 'critical' },
        { id: 'G1-F2', reason: 'not-major' },
        { id: 'G1-F3', reason: 'recurring' },
      ]);
      deepStrictEqual([two.result.converged, two.result.carry, two.result.recurring], [false, ['G1-F1', 'G1-F3'], ['G1-F3']]);
    });

    it('a veto or conflict flag is sticky: flagged in round 1, a round-2 deferral without the flag is still refused', () => {
      const one = critique(RS.emptyLedger('wf'), [NEW('MAJOR', { veto: true }), NEW('MAJOR', { conflict: true })]);
      const two = critique(one.ledger, [{ id: 'G1-F1', defer: DEFER }, { id: 'G1-F2', defer: DEFER }, NEW('MAJOR', { veto: true, defer: DEFER })]);
      deepStrictEqual(two.result.deferral_refused, [
        { id: 'G1-F1', reason: 'veto' },
        { id: 'G1-F2', reason: 'conflict' },
        { id: 'G2-F1', reason: 'veto' },
      ]);
      strictEqual(byId(two.ledger, 'G1-F1').veto, true);
      strictEqual(RS.reviewStatus(two.ledger).findings.find((x) => x.id === 'G1-F2').conflict, true);
    });

    it('a veto or conflict raised by reference on an earlier finding is sticky too: refused in its own close, and in a later unflagged one', () => {
      const one = critique(RS.emptyLedger('wf'), [NEW('MAJOR'), NEW('MAJOR'), NEW('MAJOR'), NEW('MAJOR')]);
      // Round 2: the flag and the deferral in one reference (G1-F1, G1-F2);
      // the flag alone, with no deferral asked (G1-F3, G1-F4).
      const two = critique(one.ledger, [
        { id: 'G1-F1', veto: true, defer: DEFER },
        { id: 'G1-F2', conflict: true, defer: DEFER },
        { id: 'G1-F3', veto: true },
        { id: 'G1-F4', conflict: true },
      ]);
      deepStrictEqual(two.result.deferral_refused, [
        { id: 'G1-F1', reason: 'veto' },
        { id: 'G1-F2', reason: 'conflict' },
      ]);
      deepStrictEqual([two.result.deferred_now, two.result.carry], [[], ['G1-F1', 'G1-F2', 'G1-F3', 'G1-F4']]);
      deepStrictEqual(['G1-F3', 'G1-F4'].map((id) => [byId(two.ledger, id).veto === true, byId(two.ledger, id).conflict === true]), [[true, false], [false, true]]);
      // Round 3: the deferral asked again with no flag; the flags raised on
      // the carried findings in round 2 still refuse it.
      const three = critique(two.ledger, [
        { id: 'G1-F1', defer: DEFER },
        { id: 'G1-F2', defer: DEFER },
        { id: 'G1-F3', defer: DEFER },
        { id: 'G1-F4', defer: DEFER },
      ]);
      deepStrictEqual(three.result.deferral_refused, [
        { id: 'G1-F1', reason: 'veto' },
        { id: 'G1-F2', reason: 'conflict' },
        { id: 'G1-F3', reason: 'veto' },
        { id: 'G1-F4', reason: 'conflict' },
      ]);
      deepStrictEqual([three.result.converged, three.result.deferred], [false, []]);
    });

    it('an ambiguous judgment is refused: a reference without defer, a resolved verdict, or two severities', () => {
      const one = critique(RS.emptyLedger('wf'), [NEW('MAJOR'), NEW('MAJOR'), NEW('MAJOR')]);
      const two = critique(one.ledger, [
        { id: 'G1-F1', defer: DEFER }, { id: 'G1-F1' },
        { id: 'G1-F2', defer: DEFER }, { id: 'G1-F2', verdict: 'resolved', defer: DEFER },
        { id: 'G1-F3', severity: 'MAJOR', defer: DEFER }, { id: 'G1-F3', severity: 'MINOR', defer: DEFER },
      ]);
      deepStrictEqual(two.result.deferral_refused, ['G1-F1', 'G1-F2', 'G1-F3'].map((id) => ({ id, reason: 'ambiguous' })));
      deepStrictEqual(two.result.carry, ['G1-F1', 'G1-F2', 'G1-F3']);
    });

    it('a deferred finding stays deferred when a later full critique does not report it, and opens again when one reports it without defer', () => {
      const one = critique(RS.emptyLedger('wf'), [NEW('MAJOR')]);
      const two = critique(one.ledger, [{ id: 'G1-F1', defer: DEFER }]);
      const three = critique(two.ledger, []);
      deepStrictEqual([byId(three.ledger, 'G1-F1').disposition, three.result.converged, three.result.resolved], ['deferred', true, []]);
      const four = critique(three.ledger, [{ id: 'G1-F1' }]);
      deepStrictEqual([byId(four.ledger, 'G1-F1').disposition, four.result.carry], ['open', ['G1-F1']]);
    });

    it('a deferred finding reported again is judged again: a resolution not taken, a CRITICAL or a veto with no defer opens it', () => {
      const one = critique(RS.emptyLedger('wf'), [NEW('MAJOR'), NEW('MAJOR')]);
      const two = critique(one.ledger, [{ id: 'G1-F1', defer: DEFER }, { id: 'G1-F2', defer: DEFER }]);
      deepStrictEqual(two.result.deferred_now, ['G1-F1', 'G1-F2']);
      // A scoped critique whose passage is elsewhere: the resolution of G1-F1
      // is not taken (it lies in no passage), and it reports it CRITICAL.
      const scoped = { mode: 'scoped', passages: [{ path: 'a.md', start: 1, end: 2, deleted: false }] };
      const three = critique(two.ledger, [
        { id: 'G1-F1', severity: 'CRITICAL', verdict: 'resolved', location: 'a.md:10' },
        { id: 'G1-F2', veto: true, location: 'a.md:10' },
      ], scoped);
      deepStrictEqual([byId(three.ledger, 'G1-F1').disposition, byId(three.ledger, 'G1-F2').disposition], ['open', 'open']);
      deepStrictEqual([three.result.converged, three.result.carry], [false, ['G1-F1', 'G1-F2']]);
      strictEqual('defer_reason' in byId(three.ledger, 'G1-F2'), false, 'the known limit goes with the deferral');
    });

    it('a ledger that replaced another starts again at round 1', () => {
      const one = critique(RS.emptyLedger('wf'), [NEW('MAJOR')]);
      strictEqual(RS.nextRound(one.ledger), 2);
      strictEqual(RS.nextRound(RS.emptyLedger('wf')), 1);
    });

    it('a malformed defer, veto or conflict is refused before anything is judged', () => {
      const opened = RS.openGeneration(RS.emptyLedger('wf'), FIELDS, NOW);
      for (const bad of [{ defer: '' }, { defer: 'two\nlines' }, { defer: 3 }, { veto: 'yes' }, { conflict: 1 }]) {
        throws(() => RS.closeGeneration(opened.ledger, opened.generation, { findings: [NEW('MAJOR', bad)] }, NOW), RS.ReviewScopeError, JSON.stringify(bad));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// The critique cap (state.mjs)

for (const persona of personasFor('scripts/state.mjs')) {
  const STATE_PATH = personaInfo(persona).path('scripts/state.mjs');
  const CAPS = personaInfo(persona).capabilities;
  const S = await import(pathToFileURL(STATE_PATH).href);
  const cliEnv = (extra = {}) => ({
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_'))),
    ...extra,
  });
  const cli = (args, extra = {}) => spawnSync('node', [STATE_PATH, ...args], { encoding: 'utf8', env: cliEnv(extra) });
  const fmOf = async (wf) => S.parseWorkflowFile(await readFile(wf, 'utf8')).frontmatter;
  const AUTO = { AGENTIC_AUTOPILOT: RUN };

  async function withWorkflow(fn) {
    const dir = await mkdtemp(join(tmpdir(), `${persona}-c176-`));
    try {
      execFileSync('git', ['init', '-q', '-b', 'feat/x'], { cwd: dir, stdio: 'ignore' });
      const { filePath } = await S.createWorkflow({
        repoRoot: dir, verb: 'compose', host: 'claude',
        gitBaseline: { branch: 'feat/x', head: '0'.repeat(40), status_digest: '' },
        originalRequest: 'c176',
      });
      await fn(filePath, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  // A critique run: its resume (the marker), and its finish-verb when given,
  // under an autopilot run (only there is a round counted); `finishAlone`, the
  // same finish-verb in an interactive session.
  const resume = (wf, verb = 'critique') => S.appendPhase({ workflowPath: wf, host: 'claude', verb, phaseLabel: `Phase 0: Resume into ${verb}`, env: {} });
  const finish = (wf, nextStep, extra = {}) => S.finishVerb({ workflowPath: wf, host: 'claude', nextAction: 'n', nextStep, env: AUTO, ...extra });
  const finishAlone = (wf, nextStep, extra = {}) => S.finishVerb({ workflowPath: wf, host: 'claude', nextAction: 'n', nextStep, env: {}, ...extra });
  // The review attempt a critique's finalize settles before its finish-verb:
  // a launched run (`runId`) with its outcome, or none launched.
  let attemptSeq = 0;
  const settled = (wf, outcome, { launched = true } = {}) => {
    attemptSeq += 1;
    const id = launched ? `review-20261110T000000Z-${String(attemptSeq).padStart(6, '0')}` : `review-norun-${String(attemptSeq).padStart(16, '0')}`;
    return S.recordReviewAttempt({
      workflowPath: wf,
      attempt: { id, phase: 'critique', type: 'review', state: 'closed', outcome, ...(launched ? { run_id: id } : { reason: 'local-only' }), tree: null, tree_reason: launched ? 'no-snapshot' : 'no-launch' },
      env: {},
    }).then((r) => {
      strictEqual(r.changed, true, `the ${outcome} attempt was recorded: ${r.diagnostic}`);
      return r;
    });
  };
  const REFINE = { kind: 'verb', verb: 'refine', confidence: 'HIGH' };
  const COMMIT = { kind: 'commit', confidence: 'HIGH' };
  // Two critique rounds counted, and a third critique run in progress.
  async function atThirdCritique(wf) {
    for (let i = 0; i < 2; i++) {
      await resume(wf);
      await finish(wf, REFINE);
      await resume(wf, 'refine');
      await finish(wf, { kind: 'verb', verb: 'critique', confidence: 'HIGH' });
    }
    await resume(wf);
  }

  if (!CAPS.dispatch_target) {
    describe(`${persona}: C176 critique cap (dispatch_target off)`, () => {
      it('nothing is counted, and no grant is taken', async () => {
        await withWorkflow(async (wf) => {
          await resume(wf);
          await finish(wf, REFINE);
          const fm = await fmOf(wf);
          strictEqual('critique_rounds' in fm, false);
          ok(!(await readFile(wf, 'utf8')).includes('critique_rounds'));
        });
      });
    });
    continue;
  }

  describe(`${persona}: C176 critique cap — counting`, () => {
    it('finish-verb counts one round per critique run: a rerun and another verb add nothing, and the keys survive a re-read', async () => {
      await withWorkflow(async (wf) => {
        await resume(wf);
        await finish(wf, REFINE);
        deepStrictEqual([(await fmOf(wf)).critique_rounds, (await fmOf(wf)).critique_rounds_entry], [1, 1]);
        await finish(wf, REFINE);
        strictEqual((await fmOf(wf)).critique_rounds, 1, 'a rerun of the same finalize counts nothing more');
        await resume(wf, 'refine');
        await finish(wf, { kind: 'verb', verb: 'critique', confidence: 'HIGH' });
        strictEqual((await fmOf(wf)).critique_rounds, 1, 'a refine counts nothing');
        ok(/^critique_rounds: 1$/m.test(await readFile(wf, 'utf8')), 'written as an integer');
      });
    });

    it('a critique run stopped before its finish-verb counts nothing', async () => {
      await withWorkflow(async (wf) => {
        await resume(wf);
        await resume(wf);
        await finish(wf, REFINE);
        deepStrictEqual([(await fmOf(wf)).critique_rounds, (await fmOf(wf)).critique_rounds_entry], [1, 2]);
      });
    });

    it('a workflow created by the critique verb counts its first run, and its next resume as another', async () => {
      const dir = await mkdtemp(join(tmpdir(), `${persona}-c176-`));
      try {
        execFileSync('git', ['init', '-q', '-b', 'feat/x'], { cwd: dir, stdio: 'ignore' });
        const { filePath: wf } = await S.createWorkflow({
          repoRoot: dir, verb: 'critique', host: 'claude',
          gitBaseline: { branch: 'feat/x', head: '0'.repeat(40), status_digest: '' }, originalRequest: 'c176',
        });
        await finish(wf, REFINE);
        strictEqual((await fmOf(wf)).critique_rounds, 1);
        await resume(wf);
        await finish(wf, REFINE);
        strictEqual((await fmOf(wf)).critique_rounds, 2);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('an interactive critique is no round: a workflow the owner drives alone never reaches the cap, its peer-conflict clear to refine included', async () => {
      await withWorkflow(async (wf) => {
        for (let i = 0; i < 3; i++) {
          await resume(wf);
          await finishAlone(wf, REFINE);
        }
        await resume(wf);
        await finishAlone(wf, { kind: 'owner-decision', confidence: 'MEDIUM' }, { ownerGate: { gate: 'peer-conflict', anchor: 'ensemble-synthesis' } });
        strictEqual('critique_rounds' in (await fmOf(wf)), false, 'no interactive critique was counted');
        const r = cli(['awaiting-owner-clear', '--workflow-path', wf, '--host', 'claude', '--gate', 'peer-conflict',
          '--next-step-kind', 'verb', '--next-step-verb', 'refine', '--next-step-confidence', 'HIGH']);
        strictEqual(r.status, 0, r.stderr);
      });
    });

    it('a failed peer attempt counts nothing; a completed synthesis and a critique that launched no peer count', async () => {
      await withWorkflow(async (wf) => {
        for (const outcome of ['failed', 'malformed', 'degraded', 'unavailable']) {
          await resume(wf);
          await settled(wf, outcome);
          await finish(wf, REFINE);
          strictEqual((await fmOf(wf)).critique_rounds ?? 0, 0, `a launched run settled ${outcome} is no round`);
        }
        await resume(wf);
        await settled(wf, 'concerns');
        await finish(wf, REFINE);
        strictEqual((await fmOf(wf)).critique_rounds, 1, 'a synthesis of the peer\'s answer counts');
        await resume(wf);
        await settled(wf, 'failed');
        await finish(wf, REFINE);
        strictEqual((await fmOf(wf)).critique_rounds, 1, 'a failed attempt after a counted round adds nothing');
        await resume(wf);
        await settled(wf, 'skipped', { launched: false });
        await finish(wf, REFINE);
        strictEqual((await fmOf(wf)).critique_rounds, 2, 'a local synthesis with no peer launched, right after a failed attempt, counts');
      });
    });

    it('the attempt closed last is the run in progress, not the one registered last', async () => {
      // Two runs registered, A then B; their finalizes settle them in either
      // order. The critique counts on the outcome settled last.
      const at = (s) => new Date(`2026-11-10T00:00:${s}Z`);
      const settleRun = (wf, runId, verdict, outcome, now) => S.commitEnsemble({
        workflowPath: wf, run_id: runId, phase: 'critique', ensemble_type: 'review', verdict, summary: 's',
        review: { outcome, status: outcome === 'failed' ? 'failed' : 'completed', error_kind: outcome === 'failed' ? 'peer_timeout' : null, tree: null, tree_reason: 'no-snapshot' },
        env: {}, now,
      });
      for (const [first, second, rounds] of [[['B', 'failed', 'failed'], ['A', 'concerns', 'concerns'], 1], [['A', 'concerns', 'concerns'], ['B', 'failed', 'failed'], 0]]) {
        await withWorkflow(async (wf) => {
          await resume(wf);
          for (const id of ['A', 'B']) await S.recordPendingEnsemble({ workflowPath: wf, phase: 'critique', ensemble_type: 'review', run_id: `review-20261110T000000Z-00000${id}`, env: {}, now: at('00') });
          await settleRun(wf, `review-20261110T000000Z-00000${first[0]}`, first[1], first[2], at('10'));
          await settleRun(wf, `review-20261110T000000Z-00000${second[0]}`, second[1], second[2], at('20'));
          await finish(wf, REFINE);
          strictEqual((await fmOf(wf)).critique_rounds ?? 0, rounds, `${first[0]} settled, then ${second[0]} (${second[2]})`);
        });
      }
    });

    it('the reader refuses a count or limit that is no integer, or a limit of 0', async () => {
      await withWorkflow(async (wf) => {
        const text = await readFile(wf, 'utf8');
        const end = text.indexOf('\n---\n');
        for (const line of ['critique_rounds: -1', 'critique_rounds: "2"', 'critique_round_limit: 0', 'critique_rounds_entry: 1.5']) {
          throws(() => S.parseWorkflowFile(`${text.slice(0, end)}\n${line}${text.slice(end)}`), /must be an integer/, line);
        }
      });
    });
  });

  describe(`${persona}: C176 critique cap — enforcement under autopilot`, () => {
    it('at the cap, refine is refused by finish-verb and critique-cap-check, the file untouched; commit and the critique-cap gate proceed', async () => {
      await withWorkflow(async (wf) => {
        await atThirdCritique(wf);
        const before = await readFile(wf, 'utf8');
        const refine = ['--next-step-kind', 'verb', '--next-step-verb', 'refine', '--next-step-confidence', 'HIGH'];
        let r = cli(['critique-cap-check', '--workflow-path', wf, '--host', 'claude', ...refine], AUTO);
        strictEqual(r.status, 1, r.stderr);
        ok(/round 3 of the subtask's critique cap 3/.test(r.stderr) && /OWNER_GATE=critique-cap/.test(r.stderr), r.stderr);
        deepStrictEqual(JSON.parse(r.stdout).at_cap, true);
        r = cli(['finish-verb', '--workflow-path', wf, '--host', 'claude', '--next-action', 'n', ...refine], AUTO);
        strictEqual(r.status, 1, r.stderr);
        ok(/OWNER_GATE=critique-cap/.test(r.stderr), r.stderr);
        strictEqual(await readFile(wf, 'utf8'), before, 'a refusal writes nothing');
        // A verify request whose on_pass is refine is the same next round.
        const req = join(wf, '..', 'req.json');
        await writeFile(req, JSON.stringify({ checks: [], on_pass: { kind: 'verb', verb: 'refine', confidence: 'HIGH' }, confidence: 'HIGH' }));
        strictEqual(cli(['critique-cap-check', '--workflow-path', wf, '--host', 'claude', '--request-file', req], AUTO).status, 1);
        // Interactively the cap is never enforced.
        r = cli(['critique-cap-check', '--workflow-path', wf, '--host', 'claude', ...refine]);
        strictEqual(r.status, 0, r.stderr);
        strictEqual(JSON.parse(r.stdout).enforced, false);
        // A clean critique at the cap proceeds.
        strictEqual(cli(['critique-cap-check', '--workflow-path', wf, '--host', 'claude', '--next-step-kind', 'commit', '--next-step-confidence', 'HIGH'], AUTO).status, 0);
        r = cli(['finish-verb', '--workflow-path', wf, '--host', 'claude', '--next-action', 'Owner: grant rounds or accept',
          '--next-step-kind', 'owner-decision', '--next-step-confidence', 'MEDIUM', '--owner-gate', 'critique-cap', '--owner-gate-anchor', 'critique-cap'], AUTO);
        strictEqual(r.status, 0, r.stderr);
        const fm = await fmOf(wf);
        deepStrictEqual([fm.awaiting_owner_gate, fm.critique_rounds, fm.next_step_kind], ['critique-cap', 3, 'owner-decision']);
      });
    });

    it('the locked write judges the cap again: a write that counts the third round refuses refine on the state it holds', async () => {
      await withWorkflow(async (wf) => {
        await atThirdCritique(wf);
        const before = await readFile(wf, 'utf8');
        await rejects(
          S.appendPhase({ workflowPath: wf, host: 'claude', nextStep: REFINE, countCritique: true, event: 'updated', env: AUTO }),
          /OWNER_GATE=critique-cap/,
        );
        strictEqual(await readFile(wf, 'utf8'), before);
      });
    });

    it('the verify form counts the round once, a retry included, and at the cap refuses an on_pass of refine', async () => {
      const dir = await mkdtemp(join(tmpdir(), `${persona}-c176-verify-`));
      try {
        const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-C', dir, ...args], { encoding: 'utf8' }).trim();
        git('init', '-q', '-b', 'feat/x');
        await writeFile(join(dir, '.gitignore'), '.agentic-plugins/state/\n');
        execFileSync('mkdir', ['-p', join(dir, 'tests'), join(dir, '.agentic-plugins')]);
        await writeFile(join(dir, 'tests/a.mjs'), '// fixture\n');
        await writeFile(join(dir, '.agentic-plugins/verify-checks.json'), await readFile(join(personaInfo(persona).path('.'), '..', '..', '.agentic-plugins/verify-checks.json'), 'utf8'));
        git('add', '-A');
        git('commit', '-q', '-m', 'fixture');
        const sha = git('rev-parse', 'HEAD');
        const { filePath: wf } = await S.createWorkflow({
          repoRoot: dir, verb: 'compose', host: 'claude', gitBaseline: { branch: 'feat/x', head: sha, status_digest: '' }, originalRequest: 'c176',
        });
        const env = { AGENTIC_AUTOPILOT: RUN, AGENTIC_AUTOPILOT_VERIFY: sha, AGENTIC_AUTOPILOT_STEP: '3' };
        const request = (onPass) => ({ checks: [{ kind: 'test', args: { files: ['tests/a.mjs'] } }], on_pass: onPass, confidence: 'HIGH' });
        const verify = (onPass) => S.finishVerb({
          workflowPath: wf, host: 'claude', nextAction: 'Verify', nextStep: { kind: 'verify', confidence: 'HIGH' }, verifyRequest: request(onPass), env, cwd: dir,
        });
        await atThirdCritique(wf);
        // The third critique is in progress, as its resume leaves it under a run.
        await S.appendPhase({ workflowPath: wf, host: 'claude', currentPhase: 'phase-0-resume', clearTerminalMarker: true, env: {} });
        // The finalize's check before settle refuses what the last write would.
        const check = (onPass) => S.checkVerifyRequest({ workflowPath: wf, host: 'claude', nextStep: { kind: 'verify', confidence: 'HIGH' }, input: request(onPass), env, cwd: dir });
        await rejects(check(REFINE), /OWNER_GATE=critique-cap/);
        strictEqual((await check(COMMIT)).ok, true);
        await rejects(verify(REFINE), /OWNER_GATE=critique-cap/);
        strictEqual((await fmOf(wf)).critique_rounds, 2, 'a refusal counts nothing');
        await verify(COMMIT);
        await verify(COMMIT);
        deepStrictEqual([(await fmOf(wf)).critique_rounds, (await fmOf(wf)).next_step_kind], [3, 'verify']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('at the cap, a critique whose peer failed is no round: finish-verb takes refine, while the check before settle holds it to the cap', async () => {
      await withWorkflow(async (wf) => {
        await atThirdCritique(wf);
        const refine = ['--next-step-kind', 'verb', '--next-step-verb', 'refine', '--next-step-confidence', 'HIGH'];
        await settled(wf, 'failed');
        const r = cli(['critique-cap-check', '--workflow-path', wf, '--host', 'claude', ...refine], AUTO);
        strictEqual(r.status, 1, 'before settle the run is taken as counted');
        await finish(wf, REFINE);
        deepStrictEqual([(await fmOf(wf)).critique_rounds, (await fmOf(wf)).next_step_verb], [2, 'refine']);
      });
    });

    it('below the cap refine proceeds under autopilot', async () => {
      await withWorkflow(async (wf) => {
        await resume(wf);
        const r = cli(['finish-verb', '--workflow-path', wf, '--host', 'claude', '--next-action', 'n',
          '--next-step-kind', 'verb', '--next-step-verb', 'refine', '--next-step-confidence', 'HIGH'], AUTO);
        strictEqual(r.status, 0, r.stderr);
        strictEqual((await fmOf(wf)).critique_rounds, 1);
      });
    });
  });

  describe(`${persona}: C176 critique cap — the owner's exits`, () => {
    async function capped(wf, gate = 'critique-cap') {
      await atThirdCritique(wf);
      await finish(wf, { kind: 'owner-decision', confidence: 'MEDIUM' }, { ownerGate: { gate, anchor: gate } });
      strictEqual((await fmOf(wf)).critique_rounds, 3);
    }
    const clear = (wf, gate, extra = []) => cli(['awaiting-owner-clear', '--workflow-path', wf, '--host', 'claude', '--gate', gate, ...extra]);
    const REFINE_ARGS = ['--next-step-kind', 'verb', '--next-step-verb', 'refine', '--next-step-confidence', 'HIGH'];

    it('another round takes a grant, which sets the limit relative to the count; the next critique counts against it', async () => {
      await withWorkflow(async (wf) => {
        await capped(wf);
        const before = await readFile(wf, 'utf8');
        let r = clear(wf, 'critique-cap', REFINE_ARGS);
        strictEqual(r.status, 1, r.stderr);
        ok(/critique cap is reached \(3 of 3 rounds\)/.test(r.stderr), r.stderr);
        strictEqual(await readFile(wf, 'utf8'), before);
        r = clear(wf, 'critique-cap', [...REFINE_ARGS, '--grant-critique-rounds', '2']);
        strictEqual(r.status, 0, r.stderr);
        const fm = await fmOf(wf);
        deepStrictEqual([fm.critique_round_limit, 'awaiting_owner_gate' in fm, fm.next_step_verb], [5, false, 'refine']);
        ok(/Granted 2 further critique rounds: the critique cap is now 5 \(3 counted\)/.test(await readFile(wf, 'utf8')));
        // The cap does not fire again at once: round 4 may refine.
        await resume(wf, 'refine');
        await finish(wf, { kind: 'verb', verb: 'critique', confidence: 'HIGH' });
        await resume(wf);
        strictEqual(cli(['critique-cap-check', '--workflow-path', wf, '--host', 'claude', ...REFINE_ARGS], AUTO).status, 0);
      });
    });

    it('accepting the open findings takes a resolution naming them; a grant on another gate, a grant of 0 and a grant with no round are refused', async () => {
      await withWorkflow(async (wf) => {
        await capped(wf);
        let r = clear(wf, 'critique-cap', ['--next-step-kind', 'commit', '--next-step-confidence', 'HIGH']);
        strictEqual(r.status, 1, r.stderr);
        ok(/by accepting the open findings/.test(r.stderr), r.stderr);
        for (const extra of [['--grant-critique-rounds', '0', ...REFINE_ARGS], ['--grant-critique-rounds', '2', '--next-step-kind', 'commit', '--next-step-confidence', 'HIGH']]) {
          strictEqual(clear(wf, 'critique-cap', extra).status, 1, extra.join(' '));
        }
      });
      await withWorkflow(async (wf) => {
        await capped(wf);
        const r = clear(wf, 'critique-cap', ['--next-step-kind', 'commit', '--next-step-confidence', 'HIGH', '--resolution', 'Accepted G2-F1 as a known limit.']);
        strictEqual(r.status, 0, r.stderr);
        strictEqual('critique_round_limit' in (await fmOf(wf)), false, 'acceptance grants no round');
      });
      await withWorkflow(async (wf) => {
        await S.setAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'pr-handling', anchor: 'pr-handling' });
        const r = clear(wf, 'pr-handling', [...REFINE_ARGS, '--grant-critique-rounds', '1']);
        strictEqual(r.status, 1);
        ok(/clears the critique-cap or peer-conflict gate, not pr-handling/.test(r.stderr), r.stderr);
      });
    });

    it('no other clear of critique-cap goes on: a verb without a grant, and no next step, are refused', async () => {
      await withWorkflow(async (wf) => {
        await capped(wf);
        const before = await readFile(wf, 'utf8');
        for (const extra of [
          ['--next-step-kind', 'verb', '--next-step-verb', 'critique', '--next-step-confidence', 'HIGH', '--resolution', 'look again'],
          ['--resolution', 'Accepted G2-F1.'],
          ['--clear-next-step', 'true', '--resolution', 'Accepted G2-F1.'],
        ]) {
          const r = clear(wf, 'critique-cap', extra);
          strictEqual(r.status, 1, `${extra.join(' ')}: ${r.stderr}`);
        }
        strictEqual(await readFile(wf, 'utf8'), before);
      });
      await withWorkflow(async (wf) => {
        await capped(wf, 'peer-conflict');
        const r = clear(wf, 'peer-conflict', ['--next-step-kind', 'verb', '--next-step-verb', 'critique', '--next-step-confidence', 'HIGH']);
        strictEqual(r.status, 1, r.stderr);
        ok(/critique cap is reached/.test(r.stderr), r.stderr);
      });
    });

    it('a peer-conflict cleared with refine at the cap takes a grant too', async () => {
      await withWorkflow(async (wf) => {
        await capped(wf, 'peer-conflict');
        strictEqual(clear(wf, 'peer-conflict', REFINE_ARGS).status, 1);
        const r = clear(wf, 'peer-conflict', [...REFINE_ARGS, '--grant-critique-rounds', '1']);
        strictEqual(r.status, 0, r.stderr);
        strictEqual((await fmOf(wf)).critique_round_limit, 4);
      });
    });

    it('no clear is taken under autopilot, a grant included', async () => {
      await withWorkflow(async (wf) => {
        await capped(wf);
        await rejects(
          S.clearAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'critique-cap', nextStep: REFINE, grantCritiqueRounds: 1, env: AUTO }),
          /refused under autopilot/,
        );
      });
    });
  });
}
