// tests/orchestrator/test-autopilot-instruct-lanes.mjs
//
// ADR-0068 Decision 7 (impl-instruct) — a run with lanes applies the owner's
// instructions (scheduler.mjs, instruct-boundary.mjs): to a lane mid-step,
// left pending while its step runs and applied after it; to a parked lane while
// another lane's step runs, within the poll (the records are wake sources),
// the lane reconsidered and stepped by the instruction's step, with an
// `instruction` event and a lanes.jsonl line carrying codes and ids only; a
// failed instruct-apply command parks its lane once while the other lanes
// step; an application left waiting defers the lane's recorded step, tries
// again at the tick and parks the lane after the last attempt; a lane at no
// boundary is tried again once its boundary opens, before its recorded step
// starts, however soon after the attempt; and a
// relaunch's `--lane <id> --next` beside a pending instruction that carries a
// next step is refused, naming it.

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AP, COMMIT, CRITIQUE, setup } from './fixtures/autopilot-lanes-run.mjs';
import * as HR from './fixtures/autopilot-holds-run.mjs';
import { REPO_ROOT } from './fixtures/autopilot-repo.mjs';

const I = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/instructions.mjs')).href);
const P = await import(resolve(AP, 'policy.mjs'));
const EV = await import(resolve(AP, 'events.mjs'));
const IB = await import(resolve(AP, 'instruct-boundary.mjs'));
const OL = await import(resolve(AP, 'offloop.mjs'));
const LOW = { kind: 'verb', verb: 'critique', confidence: 'LOW' };

function childOf(t, id) {
  const dir = join(t.work, '.agentic-plugins/state/engineer/workflows');
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
    const text = readFileSync(join(dir, name), 'utf8');
    if (text.includes(`originating_subtask: "${id}"`)) return { path: join(dir, name), text, id: /workflow_id: "([^"]+)"/.exec(text)[1] };
  }
  return null;
}
function installEngineers(t) {
  for (const host of ['.claude', '.codex']) {
    const dir = join(t.env.HOME, host, 'plugins/cache/agentic-plugins/engineer/0.33.0', 'scripts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.mjs'), "if (process.argv[2] === 'hold-capability') console.log(JSON.stringify({ capability: 'hold-persona-1', protocol: 1 })); else process.exit(2);\n");
  }
}
async function instruct(t, id, text, step = null) {
  const c = childOf(t, id);
  return I.writeInstruction({
    mainRoot: t.work, macroId: t.fx.macroId, subtaskId: id, branch: `feat/${id.toLowerCase()}`, child: c?.id ?? null, step,
    note: I.checkNoteBytes(Buffer.from(text)), witness: c ? I.gateWitnessOf(c.text) : null, writtenBy: 'owner',
  });
}
const runsDir = (t) => join(t.work, '.agentic-plugins/runs/autopilot');
const lanesLines = (t) => {
  const runs = readdirSync(runsDir(t)).filter((n) => n.startsWith('autopilot-')).sort();
  const f = join(runsDir(t), runs.at(-1), 'lanes.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
// A setup run of two steps that must dispatch both lanes: A's dispatch waits
// until B's has started, so A's next step cannot take the run's second step
// first. Without it, a loaded machine let A's dispatch end while B's lane was
// being created; B's admission then yielded, its lane was removed unused, and
// the run's second step was A's critique, leaving B undispatched.
const BOTH_DISPATCHED = { 'dispatch:A': ['wait:b-dispatched'], 'dispatch:B': ['mark-start:b-dispatched'] };
function bothDispatched(t) {
  ok(!existsSync(join(t.dir, 'b-dispatched.timeout')), `A's dispatch ran out its wait for B's to start\n${t.lines.join('\n')}`);
  ok(childOf(t, 'A') && childOf(t, 'B'), t.lines.join('\n'));
}
const until = async (pred, what) => {
  for (let i = 0; i < 600; i += 1) {
    try { if (pred()) return; } catch { /* not yet */ }
    await new Promise((r) => { setTimeout(r, 50); });
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe('ADR-0068 Decision 7 — a run with lanes applies instructions at a lane\'s boundary', () => {
  it('to a parked lane while another lane\'s step runs: applied within the poll, the lane reconsidered and stepped by the instruction', async () => {
    const t = await setup({
      scenario: { recordDispatch: true, A: { next: [LOW, CRITIQUE] }, B: { next: [CRITIQUE, CRITIQUE] }, actions: { 'dispatch:B': ['wait:goB'] } },
      subtasks: [{ id: 'A' }, { id: 'B' }],
    });
    let running = null;
    try {
      installEngineers(t);
      // A quiet interval longer than the test: A parks from the decision's
      // look, so the tick would otherwise wake the loop to judge it a quiet
      // interval later, apply the instruction then, and hide a run whose
      // instruction records wake nothing, or that applies to a parked lane
      // without nominating it to be judged again (impl-instruct L1, L4).
      // While B's step waits, the instruction is the only wake left.
      running = t.run({ lanes: 2, maxSteps: 3 }, { quietMs: 600_000 });
      await until(() => lanesLines(t).some((l) => l.event === 'parked' && l.subtask_id === 'A'), 'lane A to park');
      const e = await instruct(t, 'A', 'park note: go on with a refine', '/engineer:refine');
      await until(() => I.readInstructions(t.work, t.fx.macroId, 'A').record.entries[0].state === 'applied', 'the instruction to apply');
      // B is let go only once A's instructed step has started: the run's three
      // steps are then A's dispatch, B's and A's refine, whatever the timing.
      await until(() => { const runs = readdirSync(runsDir(t)).filter((n) => n.startsWith('autopilot-')).sort(); return readFileSync(join(runsDir(t), runs.at(-1), 'steps.jsonl'), 'utf8').includes('"command":"/engineer:refine"'); }, 'A\'s refine to start');
      writeFileSync(join(t.dir, 'goB'), '');
      await running;
      running = null;
      const run = t.latest();
      // The step budget ends the run, which never waits out the quiet
      // interval: an idle end judges its parked lanes only after it.
      strictEqual(run.halt?.reason, 'budget', JSON.stringify(run.halt));
      const a = run.steps.filter((s) => s.subtask_id === 'A' && s.kind === 'verb');
      ok(a.some((s) => /\/engineer:refine/.test(s.command)), `${JSON.stringify(run.steps.map((s) => [s.subtask_id, s.kind, s.command]))}\n${t.lines.join('\n')}`);
      const line = lanesLines(t).find((l) => l.event === 'instruction' && l.subtask_id === 'A');
      ok(line && line.instruction.state === 'applied' && line.instruction.entries[0] === `${e.id}:1`, JSON.stringify(lanesLines(t)));
      ok(lanesLines(t).some((l) => l.event === 'resumed' && l.subtask_id === 'A'), 'the lane was reconsidered');
      ok(run.halt?.instructions?.some((x) => x.id === e.id && x.state === 'applied' && /^app-/.test(x.application_id)), JSON.stringify(run.halt));
      const events = readFileSync(EV.eventsPath({ mainRoot: t.work, macroId: t.fx.macroId }), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const ev = events.find((x) => x.kind === 'instruction');
      ok(ev && ev.subtask_id === 'A' && ev.action === 'applied' && ev.step_set === true && ev.applied === 1, JSON.stringify(events.map((x) => x.kind)));
      ok(!readFileSync(EV.eventsPath({ mainRoot: t.work, macroId: t.fx.macroId }), 'utf8').includes('park note'), 'no note in the event file');
      ok(!JSON.stringify(lanesLines(t)).includes('park note'), 'no note in lanes.jsonl');
    } finally {
      // A failure before the run ended (impl-instruct L1, L4): B is let go and
      // the run interrupted, and awaited a bounded while, before the fixture
      // it writes in is deleted.
      if (running) {
        writeFileSync(join(t.dir, 'goB'), '');
        t.signals.emit('SIGINT');
        await Promise.race([running.catch(() => {}), new Promise((r) => { setTimeout(r, 30_000).unref(); })]);
      }
      t.fx.cleanup();
    }
  });

  it('wakes within the poll for an instruction written while a pass ran, after it read what was due, another lane\'s step still running (critique 7 F1)', async () => {
    const t = await setup({
      scenario: { recordDispatch: true, A: { next: [LOW, CRITIQUE] }, B: { next: [CRITIQUE, CRITIQUE] }, actions: { 'dispatch:B': ['wait:goB'] } },
      subtasks: [{ id: 'A' }, { id: 'B' }],
    });
    let running = null;
    try {
      installEngineers(t);
      // The owner's first note wakes the loop for a pass; its two calls of
      // the application (before the parked lanes are judged, and before the
      // decision) find A at no boundary with its own step first, which asks
      // for no other pass. The second call, after that call read what was
      // due, is where the owner's second note lands. Nothing else wakes the
      // run: A is parked with a quiet interval longer than the test, and B's
      // step waits. The first call is that pass's first: A's `parked` line
      // is written by the decision, after both calls of its iteration, and
      // the iteration after it starts only on a wake, the first note's poll
      // (a pass in flight when the note landed would already be past its
      // second call). A run that never wakes for it stalls the wait for the
      // second call, a failure, never a pass.
      const calls = [];
      let second = null;
      const applyInstructions = async (a) => {
        calls.push(Date.now());
        if (calls.length > 40) t.signals.emit('SIGINT');
        strictEqual(a.subtaskId, 'A');
        if (calls.length === 2) second = await instruct(t, 'A', 'the second note, written while the pass ran');
        return { ok: true, result: { state: 'not-at-boundary', detail: 'subtask A\'s own step comes first (the test\'s)', step_first: true, dropped: [] } };
      };
      running = t.run({ lanes: 2, maxSteps: 3 }, { quietMs: 600_000, applyInstructions });
      await until(() => lanesLines(t).some((l) => l.event === 'parked' && l.subtask_id === 'A'), 'lane A to park');
      strictEqual(calls.length, 0, 'A has no instruction before the first note');
      await instruct(t, 'A', 'the first note');
      await until(() => second !== null, 'the second note to be written during the pass');
      const writtenAt = Date.now();
      // Within the poll (a tick of 300 ms) the run looks at A again; ten
      // ticks is the bound, B's step still waiting all the while.
      for (const end = writtenAt + 3000; Date.now() < end && calls.length < 3;) await new Promise((r) => { setTimeout(r, 50); });
      ok(calls.length >= 3, `the write during the pass woke the run, which tried A again\n${t.lines.join('\n')}`);
      ok(!existsSync(join(t.dir, 'goB')), 'B\'s step was still running');
      writeFileSync(join(t.dir, 'goB'), '');
      await running;
      running = null;
    } finally {
      if (running) {
        writeFileSync(join(t.dir, 'goB'), '');
        t.signals.emit('SIGINT');
        await Promise.race([running.catch(() => {}), new Promise((r) => { setTimeout(r, 30_000).unref(); })]);
      }
      t.fx.cleanup();
    }
  });

  it('applies an instruction written during the idle end\'s last looks before the run ends, the only lane parked (critique 8 F1)', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [LOW, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
    try {
      installEngineers(t);
      // A is the only lane and parks `low-confidence`: nothing runs and
      // nothing can start, so the loop goes to its idle end. The owner's
      // instruction lands during a fresh look of A's worktree after A parked
      // (the end's last judgment of every parked lane, `reconsider(true)`),
      // and that look takes three ticks: the tick's poll takes the write as
      // seen and queues a wake, which an end that does not wait never reads.
      // The instruction is no fingerprint change, so only the end's own read
      // of the records keeps the run from halting beside it.
      const lanePath = t.lane('A');
      let written = null;
      const observeAsync = async (a, o) => {
        if (!written && a.fetch === false && a.repoRoot === lanePath && lanesLines(t).some((l) => l.event === 'parked' && l.subtask_id === 'A')) {
          written = await instruct(t, 'A', 'written during the end\'s look', '/engineer:refine');
          await new Promise((r) => { setTimeout(r, 900); });
        }
        return OL.observeInChild(a, o);
      };
      await t.run({ lanes: 2, maxSteps: 2 }, { observeAsync });
      ok(written, `the instruction was written during a look of A's worktree after it parked\n${t.lines.join('\n')}`);
      const run = t.latest();
      const [entry] = I.readInstructions(t.work, t.fx.macroId, 'A').record.entries;
      strictEqual(entry.state, 'applied', `the run ended beside a pending instruction (halt ${JSON.stringify(run.halt)})\n${t.lines.join('\n')}`);
      const a = run.steps.filter((s) => s.subtask_id === 'A' && s.kind === 'verb');
      ok(a.some((s) => /\/engineer:refine/.test(s.command)), `${JSON.stringify(run.steps.map((s) => [s.subtask_id, s.kind, s.command]))}\n${t.lines.join('\n')}`);
      strictEqual(run.halt?.reason, 'budget', JSON.stringify(run.halt));
    } finally {
      t.fx.cleanup();
    }
  });

  it('applies an instruction written during the landing report, after the loop\'s passes, before the step decided without it: the commit never runs (critique 9 F1)', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, COMMIT, CRITIQUE], file: 'a.txt' } }, subtasks: [{ id: 'A' }] });
    try {
      installEngineers(t);
      // A's critique ends with commit as its recorded step. The owner writes
      // /engineer:refine to A during the landing report of the iteration
      // after that end: the loop's two application passes have run, and the
      // decision that follows chooses the commit from the child as it is.
      // Only a check at the step's admission keeps the commit from running,
      // archiving the child and dropping the instruction `child-archived`.
      const stepsFile = () => {
        const runs = readdirSync(runsDir(t)).filter((n) => n.startsWith('autopilot-')).sort();
        return join(runsDir(t), runs.at(-1), 'steps.jsonl');
      };
      const critiqueEnded = () => {
        if (!existsSync(stepsFile())) return false;
        const lines = readFileSync(stepsFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const started = lines.find((l) => l.event === 'started' && l.subtask_id === 'A' && /\/engineer:critique/.test(l.command ?? ''));
        return Boolean(started) && lines.some((l) => l.event === 'finished' && l.seq === started.seq);
      };
      // The first report after the critique's end is the settle's own, at the
      // loop's top, before its passes (scheduler.mjs settle); the second is
      // the loop's, after them and before the decision.
      let written = null;
      let reports = 0;
      const offLoop = async (task, args, o) => {
        if (task === 'reportLanding' && !written && critiqueEnded() && (reports += 1) === 2) {
          written = await instruct(t, 'A', 'written during the landing report', '/engineer:refine');
        }
        return OL.offLoop(task, args, o);
      };
      await t.run({ lanes: 2, maxSteps: 3 }, { offLoop });
      ok(written, `the instruction was written during a landing report after A's critique ended\n${t.lines.join('\n')}`);
      const run = t.latest();
      const [entry] = I.readInstructions(t.work, t.fx.macroId, 'A').record.entries;
      strictEqual(entry.state, 'applied', `the instruction was not applied (${entry.state}${entry.ack?.cause ? `, ${entry.ack.cause}` : ''})\n${t.lines.join('\n')}`);
      const steps = run.steps.filter((s) => s.subtask_id === 'A' && s.kind !== 'dispatch');
      ok(!steps.some((s) => s.kind === 'commit' || /\/engineer:commit/.test(s.command ?? '')), `the commit ran over the instruction: ${JSON.stringify(steps.map((s) => s.command))}\n${t.lines.join('\n')}`);
      ok(steps.some((s) => /\/engineer:refine/.test(s.command ?? '') && s.instruction_application === entry.ack.application_id), `${JSON.stringify(steps.map((s) => [s.command, s.instruction_application]))}\n${t.lines.join('\n')}`);
      ok(t.lines.some((l) => /lane A: an instruction written since its last application attempt comes before this step/.test(l)), t.lines.join('\n'));
      strictEqual(run.halt?.reason, 'budget', JSON.stringify(run.halt));
    } finally {
      t.fx.cleanup();
    }
  });

  it('to a lane mid-step: left pending while the step runs, applied after it, the record surviving the worker\'s finish-verb', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE, CRITIQUE] }, actions: { 2: ['mark-start:s2', 'wait:go2'] } }, subtasks: [{ id: 'A' }] });
    let running = null;
    try {
      installEngineers(t);
      running = t.run({ lanes: 2, maxSteps: 3 });
      await until(() => existsSync(join(t.dir, 's2')), 'A\'s critique to start');
      const e = await instruct(t, 'A', 'mid-step note', '/engineer:refine');
      // The instruction record wakes the loop within a tick (300 ms): over
      // many ticks with the step still running, the lane is at no boundary
      // and the instruction stays pending (impl-instruct Q1a). Nothing else
      // keeps a lane mid-step from an application: no persona operation is
      // open between the verb's writes. The wait ends early only when the
      // entry leaves pending (a run that applied mid-step, which fails
      // below); a loaded machine that took longer than it to wake would let
      // Q1a survive, never fail the test.
      const state = () => I.readInstructions(t.work, t.fx.macroId, 'A').record.entries[0].state;
      for (const end = Date.now() + 5000; Date.now() < end && state() === 'pending';) await new Promise((r) => { setTimeout(r, 50); });
      strictEqual(I.readInstructions(t.work, t.fx.macroId, 'A').record.entries[0].state, 'pending', `applied mid-step\n${t.lines.join('\n')}`);
      writeFileSync(join(t.dir, 'go2'), '');
      await running;
      running = null;
      const run = t.latest();
      const verbs = run.steps.filter((s) => s.subtask_id === 'A' && s.kind === 'verb');
      ok(verbs.length === 2 && /\/engineer:critique/.test(verbs[0].command) && /\/engineer:refine/.test(verbs[1].command), `${JSON.stringify(verbs.map((s) => s.command))}\n${t.lines.join('\n')}`);
      strictEqual(verbs[0].instruction_application, undefined, 'the step in flight was not touched');
      const [after] = I.readInstructions(t.work, t.fx.macroId, 'A').record.entries;
      strictEqual(after.id, e.id);
      strictEqual(after.state, 'applied');
      strictEqual(after.ack.replaced_step, '/engineer:critique', 'it replaced the step the worker\'s finish-verb wrote');
      strictEqual(verbs[1].instruction_application, after.ack.application_id);
    } finally {
      if (running) {
        writeFileSync(join(t.dir, 'go2'), '');
        t.signals.emit('SIGINT');
        await Promise.race([running.catch(() => {}), new Promise((r) => { setTimeout(r, 30_000).unref(); })]);
      }
      t.fx.cleanup();
    }
  });

  it('a failed instruct-apply command parks its lane once, and the other lanes are decided and stepped', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE] }, B: { next: [CRITIQUE, LOW] } }, subtasks: [{ id: 'A' }, { id: 'B' }] });
    try {
      // A note before the dispatch keeps A due from the first look.
      await instruct(t, 'A', 'a note before the dispatch');
      let calls = 0;
      await t.run({ lanes: 2, maxSteps: 3 }, {
        applyInstructions: async (a) => {
          calls += 1;
          // A loop that applies again and again never reaches a decision:
          // the run is stopped, and the count below fails.
          if (calls > 5) t.signals.emit('SIGINT');
          strictEqual(a.subtaskId, 'A');
          return { ok: false, detail: 'instruct-apply failed for the test' };
        },
      });
      const run = t.latest();
      strictEqual(calls, 1, `tried once, not again on the record left as it was\n${t.lines.join('\n')}`);
      ok(run.steps.some((s) => s.subtask_id === 'B' && s.kind === 'verb'), `B was decided and stepped\n${JSON.stringify(run.steps.map((s) => [s.subtask_id, s.kind]))}`);
      ok(!run.steps.some((s) => s.subtask_id === 'A'), 'A was parked before any step');
      ok(lanesLines(t).some((l) => l.event === 'parked' && l.subtask_id === 'A' && /instruct-apply failed for the test/.test(l.detail)), JSON.stringify(lanesLines(t)));
    } finally {
      t.fx.cleanup();
    }
  });

  it('an application left waiting defers the lane\'s recorded step, tries again at the tick, and parks the lane after the last attempt', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE] }, B: { next: [CRITIQUE, CRITIQUE, LOW] }, actions: BOTH_DISPATCHED }, subtasks: [{ id: 'A' }, { id: 'B' }] });
    try {
      await t.run({ lanes: 2, maxSteps: 2 });
      bothDispatched(t);
      await instruct(t, 'A', 'replace the critique', '/engineer:refine');
      let calls = 0;
      await t.run({ lanes: 2, maxSteps: 4 }, {
        applyInstructions: async (a) => {
          calls += 1;
          if (calls > 6) t.signals.emit('SIGINT');
          strictEqual(a.subtaskId, 'A');
          return { ok: true, result: { state: 'waiting', detail: 'the child moved for the test', dropped: [] } };
        },
      });
      const run = t.latest();
      ok(!run.steps.some((s) => s.subtask_id === 'A'), `A's recorded critique never ran over the pending instruction\n${JSON.stringify(run.steps.map((s) => [s.subtask_id, s.kind, s.command]))}\n${t.lines.join('\n')}`);
      ok(run.steps.some((s) => s.subtask_id === 'B' && s.kind === 'verb'), 'B went on');
      strictEqual(calls, 3, `three attempts, each at a tick\n${t.lines.join('\n')}`);
      ok(lanesLines(t).some((l) => l.event === 'parked' && l.subtask_id === 'A' && /stayed waiting through 3 attempts.*the child moved for the test/.test(l.detail)), JSON.stringify(lanesLines(t)));
      strictEqual(I.readInstructions(t.work, t.fx.macroId, 'A').record.entries[0].state, 'pending', 'the instruction is kept');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a record that turns unreadable keeps the lane\'s recorded step deferred, and parks the lane naming the record and its release', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE] }, B: { next: [CRITIQUE, CRITIQUE, LOW] }, actions: BOTH_DISPATCHED }, subtasks: [{ id: 'A' }, { id: 'B' }] });
    try {
      await t.run({ lanes: 2, maxSteps: 2 });
      bothDispatched(t);
      await instruct(t, 'A', 'replace the critique', '/engineer:refine');
      const file = I.instructionsPath(t.work, t.fx.macroId, 'A');
      let calls = 0;
      await t.run({ lanes: 2, maxSteps: 4 }, {
        applyInstructions: async () => {
          calls += 1;
          if (calls > 6) t.signals.emit('SIGINT');
          writeFileSync(file, '{ not json');
          return { ok: true, result: { state: 'unreadable', detail: 'the record cannot be read for the test', dropped: [] } };
        },
      });
      const run = t.latest();
      ok(!run.steps.some((s) => s.subtask_id === 'A'), `A's recorded critique never ran over an unknown record\n${t.lines.join('\n')}`);
      // One attempt on the record as written, then three on the record that
      // cannot be read: the count starts again when the record changes.
      strictEqual(calls, 4, t.lines.join('\n'));
      ok(lanesLines(t).some((l) => l.event === 'parked' && l.subtask_id === 'A' && /stayed unreadable through 3 attempts.*Repair or remove the record.*agentic-autopilot release A --macro/.test(l.detail)), JSON.stringify(lanesLines(t)));
    } finally {
      t.fx.cleanup();
    }
  });

  it('a lane left waiting with no other lane to run is still tried at each tick, and parks after the last attempt before the run ends', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
    try {
      await t.run({ lanes: 2, maxSteps: 1 });
      await instruct(t, 'A', 'replace the critique', '/engineer:refine');
      let calls = 0;
      await t.run({ lanes: 2, maxSteps: 2 }, {
        applyInstructions: async () => {
          calls += 1;
          if (calls > 6) t.signals.emit('SIGINT');
          return { ok: true, result: { state: 'waiting', detail: 'the child moved for the test', dropped: [] } };
        },
      });
      const run = t.latest();
      ok(!run.steps.some((s) => s.subtask_id === 'A'), JSON.stringify(run.steps.map((s) => [s.subtask_id, s.kind])));
      strictEqual(calls, 3, `the idle run waits for its deferred lane\n${t.lines.join('\n')}`);
      ok(lanesLines(t).some((l) => l.event === 'parked' && l.subtask_id === 'A' && /stayed waiting through 3 attempts/.test(l.detail)), JSON.stringify(lanesLines(t)));
    } finally {
      t.fx.cleanup();
    }
  });

  it('keeps a lane at no boundary from its recorded step until the instruction applies, its boundary opening at any time (M1)', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
    try {
      await t.run({ lanes: 2, maxSteps: 1 });
      ok(childOf(t, 'A'), t.lines.join('\n'));
      installEngineers(t);
      const e = await instruct(t, 'A', 'refine before the critique', '/engineer:refine');
      // A session's operation is open in the lane at both of the turn's
      // attempts, and closes right after the second: nothing else holds the
      // lane back (no laneBusy), so a lane decided as before would start its
      // recorded critique before the next attempt.
      let calls = 0;
      await t.run({ lanes: 2, maxSteps: 2 }, {
        applyInstructions: async (a) => {
          calls += 1;
          if (calls > 8) t.signals.emit('SIGINT');
          if (calls <= 2) return { ok: true, result: { state: 'not-at-boundary', detail: 'a persona operation is open in subtask A\'s lane (the test\'s)', dropped: [] } };
          return IB.applyAtBoundary(a);
        },
      });
      const run = t.latest();
      const a = run.steps.filter((s) => s.subtask_id === 'A');
      ok(a.length > 0 && /\/engineer:refine/.test(a[0].command), `A's first step is the instruction's, not its recorded critique\n${JSON.stringify(a.map((s) => s.command))}\n${t.lines.join('\n')}`);
      ok(calls >= 3, `tried again (calls ${calls})`);
      const after = I.readInstructions(t.work, t.fx.macroId, 'A').record.entries.find((x) => x.id === e.id);
      strictEqual(after.state, 'applied');
      strictEqual(a[0].instruction_application, after.ack.application_id);
    } finally {
      t.fx.cleanup();
    }
  });

  it('decides a lane whose own step comes first (an interrupted commit, a pending settlement) as before, the instruction pending (M1)', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
    try {
      await t.run({ lanes: 2, maxSteps: 1 });
      const e = await instruct(t, 'A', 'after the commit', '/engineer:refine');
      let calls = 0;
      // A short wait for a lane held back: one that waited for its boundary
      // would park well within the test.
      await t.run({ lanes: 2, maxSteps: 2 }, {
        busyWaitMs: 1500,
        applyInstructions: async () => {
          calls += 1;
          if (calls > 30) t.signals.emit('SIGINT');
          return { ok: true, result: { state: 'not-at-boundary', detail: 'subtask A\'s child is in a commit it began and did not finish (the test\'s)', step_first: true, dropped: [] } };
        },
      });
      const run = t.latest();
      const a = run.steps.filter((s) => s.subtask_id === 'A');
      ok(a.length > 0 && /\/engineer:critique/.test(a[0].command), `the lane's own step ran\n${JSON.stringify(a.map((s) => s.command))}\n${t.lines.join('\n')}`);
      ok(!lanesLines(t).some((l) => l.event === 'parked' && l.subtask_id === 'A'), JSON.stringify(lanesLines(t)));
      strictEqual(I.readInstructions(t.work, t.fx.macroId, 'A').record.entries.find((x) => x.id === e.id).state, 'pending');
      // The last attempt met this record: the step's admission does not yield
      // to it (critique 9 F1's recheck asks only of a record no attempt met).
      ok(!t.lines.some((l) => /comes before this step; deciding again/.test(l)), t.lines.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });

  it('applies a held lane\'s instruction right after its release is compared, before the lane is decided (item 5)', async () => {
    const t = await setup({
      subtasks: [{ id: 'A' }, { id: 'B' }],
      scenario: { A: { next: [COMMIT, COMMIT], file: 'a.txt' }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 1: ['mark-start:a-started', 'wait:hold-set'] } },
    });
    try {
      // Run 1: A's dispatch runs, the hold is set during it, and the run
      // hands the lane over; B commits.
      const first = t.run();
      await until(() => existsSync(join(t.dir, 'a-started')), 'A to start');
      const h = await HR.OPS.setHold({ mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', branch: 'feat/a', lane: t.lane('A'), child: null });
      writeFileSync(join(t.dir, 'hold-set'), '1');
      await first;
      strictEqual(HR.H.holdStateOf(t.work, t.fx.macroId, 'A').state, 'held', t.lines.join('\n'));
      // The hold-aware engineer on both hosts, so the run's application can
      // make its operation visible (item 9).
      installEngineers(t);
      const e = await instruct(t, 'A', 'after the hold, refine first', '/engineer:refine');
      await HR.release(t, h, async () => HR.BASIS);
      // The comparison at the run's start cannot take its basis; the loop's
      // retry can, after the first application pass of its turn passed the
      // lane by (its release not compared yet).
      let n = 0;
      const seam = HR.basisSeam(() => { n += 1; if (n === 1) throw new Error('the basis failed'); return HR.BASIS; });
      await HR.bounded(t, {}, { releaseBasis: seam.fn });
      strictEqual(HR.releaseOf(t).state, 'consumed', t.lines.join('\n'));
      const run = t.latest();
      const a = run.steps.filter((s) => s.subtask_id === 'A');
      ok(a.length > 0 && /\/engineer:refine/.test(a[0].command), `A's first step after its release is the instruction's\n${JSON.stringify(a.map((s) => s.command))}\n${t.lines.join('\n')}`);
      const after = I.readInstructions(t.work, t.fx.macroId, 'A').record.entries.find((x) => x.id === e.id);
      strictEqual(after.state, 'applied');
      strictEqual(a[0].instruction_application, after.ack.application_id);
    } finally {
      t.fx.cleanup();
    }
  });

  it('refuses a relaunch\'s --lane <id> --next beside a pending instruction that carries a next step', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [LOW, CRITIQUE] }, B: { next: [LOW, CRITIQUE] } }, subtasks: [{ id: 'A' }, { id: 'B' }] });
    try {
      await t.run({ lanes: 2, maxSteps: 2 });
      const p = await instruct(t, 'A', 'with a step', '/engineer:refine');
      await t.run({ lanes: 2, maxSteps: 1, forcedPairs: [{ lane: 'A', step: P.parseForcedStep('/engineer:critique') }], forcedText: '--lane A --next /engineer:critique' });
      const run = t.latest();
      strictEqual(run.halt.reason, 'owner-choice', t.lines.join('\n'));
      ok(new RegExp(`--lane A --next is refused: subtask A has instruction ${p.id} r1 pending`).test(run.halt.detail), run.halt.detail);
      strictEqual(I.readInstructions(t.work, t.fx.macroId, 'A').record.entries[0].state, 'pending');
    } finally {
      t.fx.cleanup();
    }
  });

  it('takes a relaunch\'s --lane <id> --next beside a pending instruction with a step bound to a child that no longer has the lane, which is then dropped (F2)', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [LOW, CRITIQUE] }, B: { next: [LOW, CRITIQUE] } }, subtasks: [{ id: 'A' }, { id: 'B' }] });
    try {
      installEngineers(t);
      await t.run({ lanes: 2, maxSteps: 2 });
      const stale = await I.writeInstruction({
        mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', branch: 'feat/a', child: 'critique-20260101T000000Z-0a0b0c', step: '/engineer:refine',
        note: I.checkNoteBytes(Buffer.from('for the earlier child')), witness: { gate: null, resolved: 0 }, writtenBy: 'owner',
      });
      await t.run({ lanes: 2, maxSteps: 1, forcedPairs: [{ lane: 'A', step: P.parseForcedStep('/engineer:critique') }], forcedText: '--lane A --next /engineer:critique' });
      const run = t.latest();
      ok(!/is refused/.test(run.halt?.detail ?? ''), `${run.halt?.detail}\n${t.lines.join('\n')}`);
      const a = run.steps.filter((s) => s.subtask_id === 'A' && s.kind === 'verb');
      ok(a.length === 1 && a[0].forced === true && /\/engineer:critique/.test(a[0].command), `${JSON.stringify(run.steps)}\n${t.lines.join('\n')}`);
      const e = I.readInstructions(t.work, t.fx.macroId, 'A').record.entries.find((x) => x.id === stale.id);
      strictEqual(e.state, 'dropped', JSON.stringify(e));
      strictEqual(e.ack.cause, 'child-replaced');
    } finally {
      t.fx.cleanup();
    }
  });

  it('applies a note pending at a relaunch before the lane\'s forced step, and makes one written after the launch wait for it (F3)', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [LOW, CRITIQUE, CRITIQUE] }, B: { next: [LOW, LOW, LOW] } }, subtasks: [{ id: 'A' }, { id: 'B' }] });
    try {
      installEngineers(t);
      await t.run({ lanes: 2, maxSteps: 2 });
      // A note to A, pending as the run takes A's forced step: item 3 applies
      // it before the run acts on the lane.
      const atLaunch = await instruct(t, 'A', 'read this before the critique');
      // The owner's later word to A (a step), written after the run looked
      // at A's record for its launch entries and before the application
      // reserves them: the reservation takes only those.
      let later = null;
      const applyInstructions = async (a) => {
        if (a.subtaskId === 'A' && !later) {
          ok(Array.isArray(a.onlyEntries) && a.onlyEntries.length === 1, JSON.stringify(a.onlyEntries));
          later = await instruct(t, 'A', 'written after the launch', '/engineer:refine');
        }
        return IB.applyAtBoundary(a);
      };
      await t.run({ lanes: 2, maxSteps: 2, forcedPairs: [{ lane: 'A', step: P.parseForcedStep('/engineer:critique') }], forcedText: '--lane A --next /engineer:critique' }, { applyInstructions });
      const run = t.latest();
      ok(later, t.lines.join('\n'));
      const a = run.steps.filter((s) => s.subtask_id === 'A' && s.kind === 'verb');
      // The forced critique first, then the later instruction's step (item 5:
      // it waits for the forced step, and is applied at the boundary after it).
      ok(a.length === 2 && a[0].forced === true && /\/engineer:critique/.test(a[0].command) && /\/engineer:refine/.test(a[1].command),
        `${JSON.stringify(a.map((s) => [s.forced, s.command]))}\n${t.lines.join('\n')}`);
      const rec = I.readInstructions(t.work, t.fx.macroId, 'A').record.entries;
      const first = rec.find((x) => x.id === atLaunch.id);
      const second = rec.find((x) => x.id === later.id);
      strictEqual(first.state, 'applied');
      strictEqual(second.state, 'applied');
      ok(first.ack.application_id !== second.ack.application_id, 'two applications: one before the forced step, one after it');
      strictEqual(second.ack.replaced_step, '/engineer:critique', 'it replaced the step the forced critique\'s finish-verb wrote');
      strictEqual(a[1].instruction_application, second.ack.application_id);
      // In the child, the note pending at the launch comes before the forced
      // critique's own Phase 0.
      const text = childOf(t, 'A').text;
      const note = text.indexOf(`\n### Owner instructions ${first.ack.application_id}\n`);
      const phases = [...text.matchAll(/\n### Phase 0: Resume into critique\n/g)].map((m) => m.index);
      ok(note > 0 && phases.length >= 1 && note < phases.at(-1), `the launch's note precedes the forced step (note at ${note}, Phase 0s at ${phases})`);
    } finally {
      t.fx.cleanup();
    }
  });
});
