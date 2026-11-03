// tests/orchestrator/test-autopilot-verify-lanes-instruct.mjs
//
// ADR-0068 Decision 7, item 5 — the owner's instruction beside an answered
// verification request in a run with lanes (scheduler.mjs), end to end with
// the fake Claude and the scripted worker (fixtures/autopilot-lanes-run.mjs).
// Split from test-autopilot-verify-lanes.mjs so that the mutation cases that
// target it (scripts/mutation-specs/impl-instruct.mjs) run this suite alone,
// well inside the mutation harness's timeout.
//
// Covers:
//   - one applied after the batch passed, the lane's tree changed since,
//     replaces on_pass, and the P7 guard does not resume the requesting verb
//     over it;
//   - a relaunch ends the batch a dead driver left open before it applies an
//     instruction with a step, which then replaces what is left of it;
//   - one with a step written while a batch is prepared, after the admission,
//     starts no batch, and an instruction record that cannot be read then
//     starts none either; two such yields in a row are no steps that changed
//     nothing;
//   - one written while a started batch waits for the heavy-work lock, and
//     between its checks, waits for the batch's end, then replaces on_pass;
//   - a queued request, and what is left of a batch a hold cut short, is
//     replaced by a step and runs after a note alone.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { COMMIT, setup } from './fixtures/autopilot-lanes-run.mjs';
import { DECLARATION } from './_verify-fixtures.mjs';
import { BOUNDS, checkLogs, childOf, commitChecks, entryOf, holdsOn, installEngineers, sleep, untilTrue, verify } from './_verify-lanes-helpers.mjs';
import { acquire } from '../../plugins/orchestrator/scripts/lib/heavy-lock.mjs';

const PK = await import('../../plugins/orchestrator/adapters/claude/autopilot/parks.mjs');
const VR = await import('../../plugins/orchestrator/adapters/claude/autopilot/verify-run.mjs');
const VO = await import('../../plugins/orchestrator/adapters/claude/autopilot/verify-ops.mjs');
const HO = await import('../../plugins/orchestrator/scripts/lib/hold-ops.mjs');
const HR = await import('../../plugins/orchestrator/scripts/lib/holds.mjs');

describe('verify-lanes: the owner\'s instruction beside an answered request (ADR-0068 Decision 7, item 5)', () => {
  it('an instruction applied after the batch passed, the lane\'s tree changed since, replaces on_pass, and the P7 guard does not resume the requesting verb over it', { timeout: 300_000 }, async () => {
    const I = await import('../../plugins/orchestrator/scripts/lib/instructions.mjs');
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [verify([{ kind: 'pass' }]), COMMIT, COMMIT], file: true } } });
    const logs = mkdtempSync(join(tmpdir(), 'verify-lanes-log-'));
    try {
      commitChecks(t);
      t.env.VERIFY_FIXTURE_LOG = join(logs, 'order.log');
      let written = null;
      const startVerify = (a) => {
        const h = VR.startVerify(a);
        return {
          ...h,
          // While the batch runs the owner edits the lane and writes an
          // instruction: it is applied once the batch has ended, at the
          // lane's next boundary.
          done: h.done.then(async (r) => {
            for (const host of ['.claude', '.codex']) {
              const dir = join(t.env.HOME, host, 'plugins/cache/agentic-plugins/engineer/0.33.0', 'scripts');
              mkdirSync(dir, { recursive: true });
              writeFileSync(join(dir, 'state.mjs'), "if (process.argv[2] === 'hold-capability') console.log(JSON.stringify({ capability: 'hold-persona-1', protocol: 1 })); else process.exit(2);\n");
            }
            writeFileSync(join(a.job.lane, 'owner-edit.txt'), 'an edit of the owner\n');
            const text = readFileSync(a.job.workflowPath, 'utf8');
            written = await I.writeInstruction({
              mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', branch: 'feat/a', child: /workflow_id: "([^"]+)"/.exec(text)[1], step: '/engineer:refine',
              note: I.checkNoteBytes(Buffer.from('refine before the commit')), witness: I.gateWitnessOf(text), writtenBy: 'owner',
            });
            return r;
          }),
        };
      };
      await t.run({ maxSteps: 2 }, { verifyBounds: BOUNDS, startVerify });
      const r = t.latest();
      ok(written, t.lines.join('\n'));
      deepStrictEqual(r.steps.map((s) => [s.kind, s.command?.replace(/ .*/, '') ?? null]), [['dispatch', '/orchestrator:next'], ['verify', 'verify'], ['verb', '/engineer:refine']], `${JSON.stringify(r.steps.map((s) => [s.kind, s.command]))}\n${t.lines.join('\n')}`);
      strictEqual(r.steps[1].verify.batch.end, 'passed');
      const e = I.readInstructions(t.work, t.fx.macroId, 'A').record.entries[0];
      strictEqual(e.state, 'applied');
      strictEqual(r.steps[2].instruction_application, e.ack.application_id, 'the step carries the application');
    } finally {
      t.fx.cleanup();
      rmSync(logs, { recursive: true, force: true });
    }
  });

  it('a relaunch ends the batch a dead driver left open before it applies an instruction with a step, which then replaces what is left of it (F1)', { timeout: 300_000 }, async () => {
    const I = await import('../../plugins/orchestrator/scripts/lib/instructions.mjs');
    const { S, VD, VJ, digestOf } = await import('./_verify-fixtures.mjs');
    const L = await import('../../plugins/orchestrator/adapters/claude/autopilot/ledger.mjs');
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [verify([{ kind: 'pass' }, { kind: 'pass2' }]), COMMIT, COMMIT], file: true } } });
    const logs = mkdtempSync(join(tmpdir(), 'verify-lanes-log-'));
    try {
      commitChecks(t);
      t.env.VERIFY_FIXTURE_LOG = join(logs, 'order.log');
      // Run 1: the dispatch records the request, and the run ends there.
      await t.run({ maxSteps: 1 }, { verifyBounds: BOUNDS });
      const c = childOf(t, 'A');
      ok(c, t.lines.join('\n'));
      const fm = (await S.readWorkflow(c.path)).frontmatter;
      strictEqual(fm.next_step_kind, 'verify', t.lines.join('\n'));
      ok(!t.latest().steps.some((s) => s.kind === 'verify'), `run 1 started no batch\n${t.lines.join('\n')}`);
      // A batch of the request a driver started and died in, on the lane's
      // tree: the journal and the record hold its start, and nothing ended it.
      const lane = t.lane('A');
      const sha = t.git(lane, 'rev-parse', 'HEAD');
      const decl = VD.readDeclarationAt(lane, sha).declaration;
      const checks = fm.verify_request.checks.map((x) => ({ kind: x.kind, origin: 'worker', argv: VD.resolveCheck(decl, x) }));
      const start = VJ.startPayload({ batchId: 'dead-1', runId: L.listRuns(t.work).at(-1), treeStart: await digestOf(lane), declarationCommit: sha, declarationDigest: decl.digest, checks, checksDigest: VD.checksDigest(checks.map((x) => x.argv)), startedAt: '2026-10-20T01:00:00Z' });
      VJ.appendJournal(VJ.journalPath(t.work, fm.workflow_id), { op: 'start', request_id: fm.verify_request.id, batch_id: 'dead-1', payload: start, meta: { verb: fm.verb, base: sha, checks_digest: start.checks_digest } });
      await S.recordBatchStart({ workflowPath: c.path, host: 'claude', requestId: fm.verify_request.id, input: start });
      installEngineers(t);
      const e = await I.writeInstruction({
        mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', branch: 'feat/a', child: fm.workflow_id, step: '/engineer:refine',
        note: I.checkNoteBytes(Buffer.from('refine after the batch')), witness: I.gateWitnessOf(readFileSync(c.path, 'utf8')), writtenBy: 'owner',
      });
      await t.run({ maxSteps: 1 }, { verifyBounds: BOUNDS });
      const r = t.latest();
      deepStrictEqual(r.steps.map((s) => [s.kind, s.command?.replace(/ .*/, '') ?? null]), [['verify', 'verify'], ['verb', '/engineer:refine']], `${JSON.stringify(r.steps.map((s) => [s.kind, s.command]))}\n${t.lines.join('\n')}`);
      deepStrictEqual([r.steps[0].verify.outcome, r.steps[0].verify.batch?.batch_id, r.steps[0].verify.batch?.end], ['none', 'dead-1', 'cut-short'], JSON.stringify(r.steps[0].verify));
      const ran = readFileSync(join(logs, 'order.log'), { encoding: 'utf8', flag: 'a+' }).split('\n').filter(Boolean);
      deepStrictEqual(ran, [], 'nothing of the batch ran');
      const ends = VJ.readJournal(VJ.journalPath(t.work, fm.workflow_id)).entries.filter((x) => x.op === 'end').map((x) => [x.batch_id, x.payload?.end, x.payload?.cause ?? null]);
      deepStrictEqual(ends, [['dead-1', 'cut-short', 'driver-end']], 'the open batch was ended, never left open');
      const applied = entryOf(I, t, e.id);
      strictEqual(applied.state, 'applied');
      strictEqual(applied.ack.replaced_step, 'verify', 'its step replaced the request');
      strictEqual(r.steps[1].instruction_application, applied.ack.application_id);
    } finally {
      t.fx.cleanup();
      rmSync(logs, { recursive: true, force: true });
    }
  });

  it('two batches in a row that yield to an instruction written while each was prepared are no steps that changed nothing: the lane goes on (critique 10 F1\'s refine)', { timeout: 300_000 }, async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [verify([{ kind: 'pass' }]), COMMIT], file: true } } });
    const logs = mkdtempSync(join(tmpdir(), 'verify-lanes-log-'));
    try {
      commitChecks(t);
      t.env.VERIFY_FIXTURE_LOG = join(logs, 'order.log');
      // Two owner writes, each withdrawn before the pass could apply it, as
      // startVerify answers them; the third batch runs.
      let yields = 0;
      const startVerify = (a) => {
        if (yields < 2) {
          yields += 1;
          return { abort: () => {}, done: Promise.resolve({ outcome: 'none', instruction: true, detail: 'an instruction with a next step was written while the batch was prepared', wrote: false }) };
        }
        return VR.startVerify(a);
      };
      await t.run({ maxSteps: 2 }, { verifyBounds: BOUNDS, startVerify });
      const r = t.latest();
      deepStrictEqual(r.steps.map((s) => [s.kind, s.outcome, s.verify?.outcome ?? null]), [['dispatch', 'ok', null], ['verify', 'ok', 'none'], ['verify', 'ok', 'none'], ['verify', 'ok', 'ran'], ['commit', 'ok', null]], `${JSON.stringify(r.steps.map((s) => [s.kind, s.outcome]))}\n${t.lines.join('\n')}`);
      strictEqual(PK.readPark(t.work, t.fx.macroId, 'A').state, 'absent', 'no lane parked no-progress');
    } finally {
      t.fx.cleanup();
      rmSync(logs, { recursive: true, force: true });
    }
  });

  it('an instruction record that cannot be read while a batch is prepared starts no batch, as one with a pending step (critique 10 F1\'s refine)', { timeout: 300_000 }, async () => {
    const I = await import('../../plugins/orchestrator/scripts/lib/instructions.mjs');
    const IB = await import('../../plugins/orchestrator/adapters/claude/autopilot/instruct-boundary.mjs');
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [verify([{ kind: 'pass' }]), COMMIT], file: true } } });
    const logs = mkdtempSync(join(tmpdir(), 'verify-lanes-log-'));
    try {
      commitChecks(t);
      const log = join(logs, 'order.log');
      t.env.VERIFY_FIXTURE_LOG = log;
      const file = I.instructionsPath(t.work, t.fx.macroId, 'A');
      let damaged = false;
      let repaired = false;
      const verifyOps = {
        treeDigest: VO.DEFAULT_OPS.treeDigest,
        // The record is damaged during the checks' selection.
        select: async (a) => {
          if (!damaged) { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, '{'); damaged = true; }
          return VO.DEFAULT_OPS.select(a);
        },
      };
      // ...and repaired (removed) before the next pass applies it.
      const applyInstructions = async (a) => {
        if (damaged && !repaired) { rmSync(file, { force: true }); repaired = true; }
        return IB.applyAtBoundary(a);
      };
      await t.run({ maxSteps: 2 }, { verifyBounds: BOUNDS, verifyOps, applyInstructions });
      const r = t.latest();
      ok(damaged && repaired, t.lines.join('\n'));
      deepStrictEqual(r.steps.map((s) => [s.kind, s.verify?.outcome ?? null]), [['dispatch', null], ['verify', 'none'], ['verify', 'ran'], ['commit', null]], `${JSON.stringify(r.steps.map((s) => [s.kind, s.outcome]))}\n${t.lines.join('\n')}`);
      deepStrictEqual(readFileSync(log, 'utf8').split('\n').filter((x) => x === 'pass'), ['pass'], 'the batch ran once, after the record was repaired');
    } finally {
      t.fx.cleanup();
      rmSync(logs, { recursive: true, force: true });
    }
  });

  it('an instruction with a step written while a batch is prepared, after the admission, starts no batch: its step replaces the request (critique 10 F1)', { timeout: 300_000 }, async () => {
    const I = await import('../../plugins/orchestrator/scripts/lib/instructions.mjs');
    const { VJ } = await import('./_verify-fixtures.mjs');
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [verify([{ kind: 'pass' }]), COMMIT, COMMIT], file: true } } });
    const logs = mkdtempSync(join(tmpdir(), 'verify-lanes-log-'));
    try {
      commitChecks(t);
      const log = join(logs, 'order.log');
      t.env.VERIFY_FIXTURE_LOG = log;
      let written = null;
      const verifyOps = {
        treeDigest: VO.DEFAULT_OPS.treeDigest,
        // The owner writes the instruction during the checks' selection, an
        // await of the batch's preparation, after the step's admission.
        select: async (a) => {
          if (!written) {
            installEngineers(t);
            const c = childOf(t, 'A');
            written = await I.writeInstruction({
              mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', branch: 'feat/a', child: c.id, step: '/engineer:refine',
              note: I.checkNoteBytes(Buffer.from('refine instead of the checks')), witness: I.gateWitnessOf(c.text), writtenBy: 'owner',
            });
          }
          return VO.DEFAULT_OPS.select(a);
        },
      };
      await t.run({ maxSteps: 2 }, { verifyBounds: BOUNDS, verifyOps });
      const r = t.latest();
      ok(written, t.lines.join('\n'));
      deepStrictEqual(r.steps.map((s) => [s.kind, s.command?.replace(/ .*/, '') ?? null]), [['dispatch', '/orchestrator:next'], ['verify', 'verify'], ['verb', '/engineer:refine']], `${JSON.stringify(r.steps.map((s) => [s.kind, s.command]))}\n${t.lines.join('\n')}`);
      deepStrictEqual([r.steps[1].verify.outcome, r.steps[1].verify.batch], ['none', null], JSON.stringify(r.steps[1].verify));
      const ran = readFileSync(log, { encoding: 'utf8', flag: 'a+' }).split('\n').filter(Boolean);
      deepStrictEqual(ran, [], 'no check ran');
      const applied = entryOf(I, t, written.id);
      strictEqual(applied.state, 'applied');
      strictEqual(applied.ack.replaced_step, 'verify', 'its step replaced the request');
      strictEqual(r.steps[2].instruction_application, applied.ack.application_id);
      // Nothing of a batch was written: not even the journal's intent.
      const starts = VJ.readJournal(VJ.journalPath(t.work, applied.child)).entries.filter((x) => x.op === 'start' || x.op === 'restart');
      deepStrictEqual(starts, [], 'no batch start was recorded');
    } finally {
      t.fx.cleanup();
      rmSync(logs, { recursive: true, force: true });
    }
  });

  it('an instruction written while a started batch waits for the heavy-work lock, and one while its checks run, wait for the batch\'s end, the run attempting no application on the lane meanwhile: its results stay, and its step replaces on_pass (M3)', { timeout: 300_000 }, async () => {
    const I = await import('../../plugins/orchestrator/scripts/lib/instructions.mjs');
    const IB = await import('../../plugins/orchestrator/adapters/claude/autopilot/instruct-boundary.mjs');
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [verify([{ kind: 'pass' }, { kind: 'slow' }]), COMMIT, COMMIT], file: true } } });
    const logs = mkdtempSync(join(tmpdir(), 'verify-lanes-log-'));
    let holder = null;
    let running = null;
    // Every application the run attempts on the lane before the test lets the
    // batch end. The writer refuses one mid-batch too (the child records the
    // batch open, instruct-apply.mjs boundaryState), so the entries' state
    // alone cannot tell whether the run kept the lane at no boundary itself:
    // the run's own rule (scheduler.mjs applyInstructions) is that a lane
    // whose batch has started is not attempted at all.
    const midBatch = [];
    let batchLetGo = false;
    const applyInstructions = async (a) => {
      if (!batchLetGo) midBatch.push(a.subtaskId);
      return IB.applyAtBoundary(a);
    };
    // The slow check outlives its default timeout (30 s at 100 ms seconds):
    // give it 30 s of real time.
    const decl = JSON.parse(DECLARATION);
    decl.kinds.slow = { ...decl.kinds.slow, timeout_s: 300 };
    try {
      commitChecks(t, JSON.stringify(decl, null, 2));
      installEngineers(t);
      const log = join(logs, 'order.log');
      // The slow check ends when the test lets it (the file `go`), never on a
      // timer, so "still inside the slow check" holds on a loaded machine.
      const go = join(logs, 'go');
      Object.assign(t.env, { VERIFY_FIXTURE_LOG: log, VERIFY_FIXTURE_SLOW_UNTIL: go, AGENTIC_HEAVY_LOCK_POLL_MS: '50' });
      holder = await acquire(t.work, { kind: 'harness', purpose: 'a mutation run in the main checkout', log: () => {}, pollMs: 20 });
      running = t.run({ maxSteps: 2 }, { verifyBounds: BOUNDS, applyInstructions });
      await untilTrue(() => t.latest().run.verifying?.state === 'waiting', 'the batch to wait for the heavy-work lock', t);
      const child = childOf(t, 'A');
      ok(child, t.lines.join('\n'));
      const e = await I.writeInstruction({
        mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', branch: 'feat/a', child: child.id, step: '/engineer:refine',
        note: I.checkNoteBytes(Buffer.from('refine before the commit')), witness: I.gateWitnessOf(child.text), writtenBy: 'owner',
      });
      // Several ticks (300 ms) while the batch waits: the instruction records
      // wake the loop, and the lane is at no boundary.
      await sleep(1500);
      strictEqual(entryOf(I, t, e.id).state, 'pending', `not applied while the batch waits for the lock\n${t.lines.join('\n')}`);
      holder.release();
      holder = null;
      // The first check ran and the second runs: the batch is past one of its
      // checks and inside the next, still started. A second instruction (a
      // note) written now wakes the loop (the records are wake sources), so
      // the run looks at the lane here: neither applies.
      await untilTrue(() => readFileSync(log, 'utf8').split('\n').includes('slow'), 'the second check to start', t);
      const tellsBefore = t.lines.length;
      const e2 = await I.writeInstruction({
        mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', branch: 'feat/a', child: child.id, step: null,
        note: I.checkNoteBytes(Buffer.from('and keep the commit small')), witness: I.gateWitnessOf(child.text), writtenBy: 'owner',
      });
      await sleep(1500);
      ok(!readFileSync(log, 'utf8').includes('slow-end'), 'still inside the slow check');
      deepStrictEqual([entryOf(I, t, e.id).state, entryOf(I, t, e2.id).state], ['pending', 'pending'], `not applied while the batch's checks run\n${t.lines.slice(tellsBefore).join('\n')}`);
      ok(!readFileSync(child.path, 'utf8').includes('refine before the commit'), 'nothing reached the child during the batch');
      // No instruction was pending before the batch waited, so every attempt
      // recorded so far came while the batch was started.
      deepStrictEqual(midBatch, [], `no application attempted on the lane while its batch waited for the lock or ran its checks\n${t.lines.join('\n')}`);
      batchLetGo = true;
      writeFileSync(go, '1');
      await running;
      running = null;
      const r = t.latest();
      deepStrictEqual(r.steps.map((s) => [s.kind, s.command?.replace(/ .*/, '') ?? null]), [['dispatch', '/orchestrator:next'], ['verify', 'verify'], ['verb', '/engineer:refine']], `${JSON.stringify(r.steps.map((s) => [s.kind, s.command]))}\n${t.lines.join('\n')}`);
      // The batch ran whole and its results stay: the application came after
      // them, and the step replaced the request's on_pass (the commit).
      strictEqual(r.steps[1].verify.batch.end, 'passed', checkLogs(r));
      const after = entryOf(I, t, e.id);
      strictEqual(after.state, 'applied');
      strictEqual(entryOf(I, t, e2.id).ack?.application_id, after.ack.application_id, 'both applied at the batch\'s end, as one application');
      strictEqual(r.steps[2].instruction_application, after.ack.application_id);
      // Its record stays: a log per check, each run to its end (the slow
      // check's end line), none cut short by the application.
      const batchDir = join(r.dir, 'verify', r.steps[1].verify.batch.batch_id);
      ok(readdirSync(batchDir).filter((n) => n.endsWith('.log')).length >= 2, checkLogs(r));
      ok(readFileSync(log, 'utf8').split('\n').includes('slow-end'), 'the slow check ran to its end');
    } finally {
      holder?.release();
      if (running) {
        writeFileSync(join(logs, 'go'), '1');
        t.signals.emit('SIGINT');
        await Promise.race([running.catch(() => {}), sleep(30_000)]);
      }
      t.fx.cleanup();
      rmSync(logs, { recursive: true, force: true });
    }
  });

  // What is left of a batch a hold cut short: an instruction written while
  // the lane is held applies once its release is compared; with a step it
  // replaces the batch's remainder, with a note alone the remainder runs,
  // after the note (M3).
  for (const step of ['/engineer:refine', null]) {
    it(`what is left of a batch a hold cut short is ${step ? 'replaced by the instruction\'s step' : 'run under an instruction\'s note alone, after the note'} (M3)`, { timeout: 300_000 }, async () => {
      const I = await import('../../plugins/orchestrator/scripts/lib/instructions.mjs');
      const HRUN = await import('./fixtures/autopilot-holds-run.mjs');
      const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [verify([{ kind: 'pass' }, { kind: 'slow' }]), COMMIT, COMMIT], file: true } } });
      const logs = mkdtempSync(join(tmpdir(), 'verify-lanes-log-'));
      const decl = JSON.parse(DECLARATION);
      decl.kinds.slow = { ...decl.kinds.slow, timeout_s: 300 };
      try {
        commitChecks(t, JSON.stringify(decl, null, 2));
        holdsOn(t);
        installEngineers(t);
        const log = join(logs, 'order.log');
        // The slow check ends only once the test lets it (the file `go`),
        // never on a timer: the hold is always set while it runs, so the
        // batch meets the hold at the boundary after it, with a check left.
        const go = join(logs, 'go');
        Object.assign(t.env, { VERIFY_FIXTURE_LOG: log, VERIFY_FIXTURE_SLOW_UNTIL: go });
        // Run 1: the hold comes while the batch's second check runs, which
        // cuts the batch short, and the run hands the lane over.
        let h = null;
        const first = HRUN.bounded(t, {}, { verifyBounds: BOUNDS });
        await untilTrue(() => readFileSync(log, 'utf8').split('\n').includes('slow'), 'the second check to start', t);
        h = await HO.setHold({ mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', branch: 'feat/a' });
        // The hold is set: the slow check may end (from here it passes as
        // soon as it starts, as in run 2's remainder with a note alone).
        writeFileSync(go, '1');
        await first;
        const r1 = t.latest();
        const cut = r1.steps.find((s) => s.kind === 'verify');
        deepStrictEqual([cut?.verify?.batch?.end, cut?.verify?.batch?.cause], ['cut-short', 'hold'], `${JSON.stringify(cut?.verify)}\n${t.lines.join('\n')}`);
        strictEqual(HR.holdStateOf(t.work, t.fx.macroId, 'A').state, 'held', t.lines.join('\n'));
        // The owner's instruction while the lane is held, then the release.
        const child = childOf(t, 'A');
        const e = await I.writeInstruction({
          mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', branch: 'feat/a', child: child.id, step,
          note: I.checkNoteBytes(Buffer.from('a word on the cut batch')), witness: I.gateWitnessOf(child.text), writtenBy: 'owner',
        });
        await HRUN.release(t, h, async () => HRUN.BASIS);
        // Run 2: the release compared (unchanged), the instruction applied,
        // then the lane decided.
        const before = readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
        await HRUN.bounded(t, { maxSteps: 1 }, { verifyBounds: BOUNDS, releaseBasis: HRUN.basisSeam(HRUN.BASIS).fn });
        const r2 = t.latest();
        const shape = `${JSON.stringify(r2.steps.map((s) => [s.subtask_id, s.kind, s.command?.replace(/ .*/, '') ?? null, s.started_at]))}\n${t.lines.join('\n')}`;
        strictEqual(HRUN.releaseOf(t).state, 'consumed', shape);
        const after = entryOf(I, t, e.id);
        strictEqual(after.state, 'applied', shape);
        if (step) {
          // The step replaced the remainder: no batch ran in run 2.
          deepStrictEqual(r2.steps.map((s) => [s.kind, s.command?.replace(/ .*/, '') ?? null]), [['verb', '/engineer:refine']], shape);
          strictEqual(r2.steps[0].instruction_application, after.ack.application_id);
          strictEqual(readFileSync(log, 'utf8').split('\n').filter(Boolean).length, before, 'no check ran');
        } else {
          // The remainder ran, continuing the batch the hold cut, after the note.
          const v = r2.steps.find((s) => s.kind === 'verify');
          ok(v && v.verify?.batch?.end === 'passed', shape);
          strictEqual(r2.steps[0], v, `the remainder is the lane's first step\n${shape}`);
          ok(Date.parse(v.started_at) >= Date.parse(after.ack.at), `the remainder started after the note was applied\n${shape}`);
          // The commit on_pass ran after it may have archived the child.
          ok(childOf(t, 'A', { archived: true })?.text.includes('a word on the cut batch'), 'the note reached the child');
        }
      } finally {
        writeFileSync(join(logs, 'go'), '1');
        t.fx.cleanup();
        rmSync(logs, { recursive: true, force: true });
      }
    });
  }

  // A queued request: B's, recorded while A's batch runs, so it waits its
  // turn (one batch at a time). An instruction with a step replaces it; one
  // with a note alone leaves it to run, after the note (M3).
  for (const step of ['/engineer:refine', null]) {
    it(`a queued request is ${step ? 'replaced by the instruction\'s step' : 'run under an instruction\'s note alone, after the note'} (M3)`, { timeout: 300_000 }, async () => {
      const I = await import('../../plugins/orchestrator/scripts/lib/instructions.mjs');
      const t = await setup({
        subtasks: [{ id: 'A' }, { id: 'B' }],
        scenario: {
          A: { next: [verify([{ kind: 'slow' }]), COMMIT, COMMIT], file: 'a.txt' },
          B: { next: [verify([{ kind: 'pass' }]), COMMIT, COMMIT], file: 'b.txt' },
          actions: { 'dispatch:B': ['wait:a-slow'] },
        },
      });
      const logs = mkdtempSync(join(tmpdir(), 'verify-lanes-log-'));
      const decl = JSON.parse(DECLARATION);
      decl.kinds.slow = { ...decl.kinds.slow, timeout_s: 300 };
      let running = null;
      try {
        commitChecks(t, JSON.stringify(decl, null, 2));
        installEngineers(t);
        const log = join(logs, 'order.log');
        // A's check ends when the test lets it (the file `go`), never on a
        // timer: the order this test asserts holds on a loaded machine too.
        const go = join(logs, 'go');
        Object.assign(t.env, { VERIFY_FIXTURE_LOG: log, VERIFY_FIXTURE_SLOW_UNTIL: go });
        running = t.run({ lanes: 2, maxSteps: 3 }, { verifyBounds: BOUNDS });
        // A's batch runs; B's dispatch, let go then, records B's request.
        await untilTrue(() => readFileSync(log, 'utf8').split('\n').includes('slow'), 'A\'s check to start', t);
        writeFileSync(join(t.dir, 'a-slow'), '1');
        await untilTrue(() => /next_step_kind: "?verify"?/.test(childOf(t, 'B')?.text ?? ''), 'B\'s request', t);
        // B's dispatch ended, and the turn its end woke decided B: the request
        // waits in the queue behind A's batch.
        await untilTrue(() => t.latest().steps.some((s) => s.subtask_id === 'B' && s.kind === 'dispatch' && s.ended_at), 'B\'s dispatch to end', t);
        await sleep(1000);
        ok(!readFileSync(log, 'utf8').includes('slow-end'), 'A\'s batch still runs: B\'s request is queued');
        const child = childOf(t, 'B');
        const e = await I.writeInstruction({
          mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'B', branch: 'feat/b', child: child.id, step,
          note: I.checkNoteBytes(Buffer.from('a word on the queued request')), witness: I.gateWitnessOf(child.text), writtenBy: 'owner',
        });
        // A's batch ends only once the instruction has done its work beside
        // it: with a step, B's step has started (the run's last, under the
        // cap of 3, before A's on_pass could take it); with a note alone, the
        // note is applied, so B's queued batch can only start after it.
        if (step) await untilTrue(() => t.latest().steps.some((s) => s.subtask_id === 'B' && s.kind === 'verb'), 'B\'s instructed step to start', t);
        else await untilTrue(() => entryOf(I, t, e.id, 'B').state === 'applied', 'the note to be applied', t);
        ok(!readFileSync(log, 'utf8').includes('slow-end'), 'A\'s batch still runs when the instruction has done its work');
        writeFileSync(go, '1');
        await running;
        running = null;
        const r = t.latest();
        const b = r.steps.filter((s) => s.subtask_id === 'B');
        const shape = `${JSON.stringify(r.steps.map((s) => [s.subtask_id, s.kind, s.command?.replace(/ .*/, '') ?? null, s.started_at]))}\n${t.lines.join('\n')}`;
        const after = entryOf(I, t, e.id, 'B');
        strictEqual(after.state, 'applied', shape);
        const appliedAt = Date.parse(after.ack.at);
        if (step) {
          // The step replaced the request: B's batch never ran.
          deepStrictEqual(b.map((s) => [s.kind, s.command?.replace(/ .*/, '') ?? null]), [['dispatch', '/orchestrator:next'], ['verb', '/engineer:refine']], shape);
          strictEqual(b[1].instruction_application, after.ack.application_id);
          ok(!readFileSync(log, 'utf8').split('\n').includes('pass'), 'B\'s check never ran');
        } else {
          // The note reached B's child; its request ran after it, as queued.
          const v = b.find((s) => s.kind === 'verify');
          ok(v && v.verify?.batch?.end === 'passed', shape);
          ok(Date.parse(v.started_at) >= appliedAt, `B's batch started after the note was applied\n${shape}`);
          ok(readFileSync(childOf(t, 'B')?.path ?? child.path, 'utf8').includes('a word on the queued request'), 'the note reached B\'s child');
        }
        // A's batch ran whole beside it.
        ok(r.steps.some((s) => s.subtask_id === 'A' && s.kind === 'verify' && s.verify?.batch?.end === 'passed'), checkLogs(r));
      } finally {
        if (running) {
          writeFileSync(join(t.dir, 'a-slow'), '1');
          writeFileSync(join(logs, 'go'), '1');
          t.signals.emit('SIGINT');
          await Promise.race([running.catch(() => {}), sleep(30_000)]);
        }
        t.fx.cleanup();
        rmSync(logs, { recursive: true, force: true });
      }
    });
  }
});
