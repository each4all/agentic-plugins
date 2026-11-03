// tests/orchestrator/test-autopilot-instruct-serial.mjs
//
// ADR-0068 Decision 7 (impl-instruct) — a serial run applies the owner's
// instructions at the lane's next step boundary (driver.mjs,
// instruct-boundary.mjs, state.mjs instruct-apply): to an idle lane whose
// judgment halted the last run; to a lane mid-step, applied after the step
// and surviving its finish-verb; beside a forced step (refused beside one
// with a next step, taken beside a note alone, the note pending at the
// launch applied before it, one written after the launch waiting for it,
// taken beside a sibling's whose child has archived and beside one bound to a
// child the lane no longer has, refused beside a record that cannot be read);
// an application left waiting deferring the recorded step, tried again and
// halting after the last attempt; a commit the child began and did not finish
// running again, the instruction never applied over it; and nothing where the
// lane's operations cannot be made visible. The step ledger's instruction
// lines are read apart from the steps (ledger.mjs readRun). The runs use the
// scripted worker (fixtures/autopilot-scripted-worker.mjs).

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AP, COMMIT, CRITIQUE, setup } from './fixtures/autopilot-lanes-run.mjs';
import { REPO_ROOT } from './fixtures/autopilot-repo.mjs';

const I = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/instructions.mjs')).href);
const P = await import(resolve(AP, 'policy.mjs'));
const IB = await import(resolve(AP, 'instruct-boundary.mjs'));
const C = await import(resolve(AP, 'cli.mjs'));
const LOW = { kind: 'verb', verb: 'critique', confidence: 'LOW' };

function childOf(t, id) {
  const dir = join(t.work, '.agentic-plugins/state/engineer/workflows');
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
    const text = readFileSync(join(dir, name), 'utf8');
    if (text.includes(`originating_subtask: "${id}"`)) return { path: join(dir, name), text, id: /workflow_id: "([^"]+)"/.exec(text)[1] };
  }
  return null;
}

// The hold-aware engineer on both hosts (item 9).
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
const entries = (t, id = 'A') => I.readInstructions(t.work, t.fx.macroId, id).record.entries;
const waitFile = async (file) => {
  for (let i = 0; i < 600 && !existsSync(file); i += 1) await new Promise((r) => { setTimeout(r, 50); });
  ok(existsSync(file), `${file} never appeared`);
};

describe('ADR-0068 Decision 7 — a serial run applies instructions at the lane\'s boundary', () => {
  it('to an idle lane whose judgment halted the last run: the instruction\'s step replaces the halt, and its step ledger line names the application', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [LOW, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
    try {
      installEngineers(t);
      await t.run({ lanes: 1, maxSteps: 2 });
      strictEqual(t.latest().halt.reason, 'low-confidence', t.lines.join('\n'));
      const e = await instruct(t, 'A', 'Take the second approach; the first one leaks.', '/engineer:refine');
      await t.run({ lanes: 1, maxSteps: 1 });
      const run = t.latest();
      const started = run.steps.filter((s) => s.event === 'started' || s.kind);
      const verb = started.find((s) => s.kind === 'verb');
      ok(verb && /\/engineer:refine/.test(verb.command), JSON.stringify(run.steps));
      const [after] = entries(t);
      strictEqual(after.id, e.id);
      strictEqual(after.state, 'applied');
      strictEqual(verb.instruction_application, after.ack.application_id, 'the step carries the application it came from');
      ok(childOf(t, 'A').text.includes('Take the second approach; the first one leaks.'));
      ok(t.lines.some((l) => /applied subtask A's instructions as app-\S+ \(next \/engineer:refine\)/.test(l)), t.lines.join('\n'));
      ok(!t.lines.join('\n').includes('the first one leaks'), 'the note is carried, never printed');
    } finally {
      t.fx.cleanup();
    }
  });

  it('applies an instruction written after the turn\'s application, while the run resolved its roots, before the step decided without it: the commit never runs (critique 9 F1)', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, COMMIT, CRITIQUE], file: 'a.txt' } }, subtasks: [{ id: 'A' }] });
    try {
      installEngineers(t);
      // A's critique ends with commit as its recorded step. The turn after it
      // applies instructions (none), decides the commit and reserves it; the
      // owner writes /engineer:refine to A while the drift check resolves the
      // roots, the turn's last await before the spawn. Only a check at the
      // step's admission keeps the commit from running, archiving the child
      // and dropping the instruction `child-archived`.
      const R = await import(resolve(AP, 'roots.mjs'));
      const runsDir = join(t.work, '.agentic-plugins/runs/autopilot');
      const critiqueEnded = () => {
        const runs = existsSync(runsDir) ? readdirSync(runsDir).filter((n) => n.startsWith('autopilot-')).sort() : [];
        const f = runs.length ? join(runsDir, runs.at(-1), 'steps.jsonl') : null;
        if (!f || !existsSync(f)) return false;
        const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const started = lines.find((l) => l.event === 'started' && l.subtask_id === 'A' && /\/engineer:critique/.test(l.command ?? ''));
        return Boolean(started) && lines.some((l) => l.event === 'finished' && l.seq === started.seq);
      };
      let written = null;
      const resolveRoots = async (o) => {
        if (!written && critiqueEnded()) written = await instruct(t, 'A', 'written while the run resolved its roots', '/engineer:refine');
        return R.resolveRoots(o);
      };
      await t.run({ lanes: 1, maxSteps: 3 }, { resolveRoots });
      ok(written, `the instruction was written during the drift check after A's critique ended\n${t.lines.join('\n')}`);
      const run = t.latest();
      const [entry] = entries(t);
      strictEqual(entry.state, 'applied', `the instruction was not applied (${entry.state}${entry.ack?.cause ? `, ${entry.ack.cause}` : ''})\n${t.lines.join('\n')}`);
      const verbs = run.steps.filter((s) => s.subtask_id === 'A' && s.kind !== 'dispatch');
      ok(!verbs.some((s) => s.kind === 'commit' || /\/engineer:commit/.test(s.command ?? '')), `the commit ran over the instruction: ${JSON.stringify(verbs.map((s) => s.command))}\n${t.lines.join('\n')}`);
      ok(verbs.some((s) => /\/engineer:refine/.test(s.command ?? '') && s.instruction_application === entry.ack.application_id), `${JSON.stringify(verbs.map((s) => [s.command, s.instruction_application]))}\n${t.lines.join('\n')}`);
      ok(t.lines.some((l) => /subtask A: an instruction written since its last application attempt comes before this step/.test(l)), t.lines.join('\n'));
      // The yield reserved nothing it kept, and took the same seq again.
      deepStrictEqual(run.steps.map((s) => s.seq), [1, 2, 3], JSON.stringify(run.steps));
      strictEqual(run.halt?.reason, 'budget', JSON.stringify(run.halt));
    } finally {
      t.fx.cleanup();
    }
  });

  it('applies an instruction written after the turn\'s application wrote and before it returned, while its group was torn down: the commit never runs (critique 9 F1\'s refine)', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, COMMIT, CRITIQUE], file: 'a.txt' }, actions: { 2: ['mark-start:s2', 'wait:go2'] } }, subtasks: [{ id: 'A' }] });
    try {
      installEngineers(t);
      // A note with no step, written during A's critique, is applied by the
      // turn after it; the critique's recorded step, commit, stays. The owner
      // writes /engineer:refine once the application has written and before
      // the attempt returns (the applier's group torn down): the turn's
      // record of what its attempt met must be the record before it, or the
      // refine counts as tried and the commit runs over it.
      let written = null;
      const applyInstructions = async (a) => {
        const r = await IB.applyAtBoundary(a);
        if (!written && r.ok && r.result.state === 'applied') written = await instruct(t, 'A', 'written while the applier was torn down', '/engineer:refine');
        return r;
      };
      const running = t.run({ lanes: 1, maxSteps: 3 }, { applyInstructions });
      await waitFile(join(t.dir, 's2'));
      const note = await instruct(t, 'A', 'a note for the next step');
      writeFileSync(join(t.dir, 'go2'), '');
      await running;
      ok(written, `the second instruction was written after the note's application\n${t.lines.join('\n')}`);
      const run = t.latest();
      const byId = Object.fromEntries(entries(t).map((e) => [e.id, e]));
      strictEqual(byId[note.id].state, 'applied', JSON.stringify(byId[note.id]));
      strictEqual(byId[written.id].state, 'applied', `the refine was not applied (${byId[written.id].state}${byId[written.id].ack?.cause ? `, ${byId[written.id].ack.cause}` : ''})\n${t.lines.join('\n')}`);
      const verbs = run.steps.filter((s) => s.subtask_id === 'A' && s.kind !== 'dispatch');
      ok(!verbs.some((s) => s.kind === 'commit' || /\/engineer:commit/.test(s.command ?? '')), `the commit ran over the instruction: ${JSON.stringify(verbs.map((s) => s.command))}\n${t.lines.join('\n')}`);
      ok(verbs.some((s) => /\/engineer:refine/.test(s.command ?? '')), `${JSON.stringify(verbs.map((s) => s.command))}\n${t.lines.join('\n')}`);
    } finally {
      t.fx.cleanup();
    }
  });

  it('to a lane mid-step: applied after the step ends, the record surviving the worker\'s finish-verb', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE, CRITIQUE] }, actions: { 2: ['mark-start:s2', 'wait:go2'] } }, subtasks: [{ id: 'A' }] });
    try {
      installEngineers(t);
      const running = t.run({ lanes: 1, maxSteps: 3 });
      await waitFile(join(t.dir, 's2'));
      const e = await instruct(t, 'A', 'mid-step note', '/engineer:refine');
      writeFileSync(join(t.dir, 'go2'), '');
      await running;
      const run = t.latest();
      const verbs = run.steps.filter((s) => s.kind === 'verb');
      deepStrictEqual(verbs.map((s) => /\/engineer:(\w+)/.exec(s.command)?.[1]), ['critique', 'refine'], t.lines.join('\n'));
      strictEqual(verbs[0].instruction_application, undefined, 'the step in flight was not touched');
      const [after] = entries(t);
      strictEqual(after.id, e.id);
      strictEqual(after.state, 'applied');
      strictEqual(after.ack.replaced_step, '/engineer:critique', 'it replaced the step the worker\'s finish-verb wrote');
      strictEqual(verbs[1].instruction_application, after.ack.application_id);
    } finally {
      t.fx.cleanup();
    }
  });

  it('refuses a forced step beside a pending instruction with a next step, and takes one beside a note alone, applying the note pending at launch before it (F3)', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [LOW, CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
    try {
      installEngineers(t);
      await t.run({ lanes: 1, maxSteps: 2 });
      const withStep = await instruct(t, 'A', 'with a step', '/engineer:refine');
      const forced = { forced: P.parseForcedStep('/engineer:critique'), forcedText: '/engineer:critique' };
      await t.run({ lanes: 1, maxSteps: 1, ...forced });
      let run = t.latest();
      strictEqual(run.halt.reason, 'owner-choice');
      ok(new RegExp(`subtask A has instruction ${withStep.id} r1 pending with the next step /engineer:refine`).test(run.halt.detail), run.halt.detail);
      deepStrictEqual(run.steps, []);
      // halt.json names the instruction and its state, never its note.
      ok(run.halt.instructions.some((x) => x.id === withStep.id && x.state === 'pending' && x.step === '/engineer:refine'), JSON.stringify(run.halt.instructions));
      ok(!JSON.stringify(run.halt).includes('with a step'));
      await I.withdrawInstruction({ mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', id: withStep.id, by: 'owner' });
      const noteOnly = await instruct(t, 'A', 'a note alone');
      await t.run({ lanes: 1, maxSteps: 2, ...forced });
      run = t.latest();
      const verbs = run.steps.filter((s) => s.kind === 'verb');
      ok(verbs.length >= 1 && verbs[0].forced === true && /\/engineer:critique/.test(verbs[0].command), JSON.stringify(run.steps));
      strictEqual(verbs[0].instruction_application, undefined, 'a note sets no step: the forced step is the owner\'s');
      const n = entries(t).find((x) => x.id === noteOnly.id);
      strictEqual(n.state, 'applied');
      // Item 3: the next run applies what was pending before it acts on the
      // lane, its forced step included. The ledger's instruction line, listed
      // apart from the steps (ledger.mjs readRun), carries the seq of the
      // step about to start, never merged into that step: the forced one's.
      const line = run.instructions.find((x) => x.instruction);
      ok(line && line.seq === verbs[0].seq && line.instruction.state === 'applied', `the note is applied before the forced step\n${JSON.stringify(run.instructions)}\n${JSON.stringify(verbs)}`);
      ok(!run.steps.some((x) => x.event === 'instruction' || x.instruction), JSON.stringify(run.steps));
      ok(childOf(t, 'A').text.includes('a note alone'));
    } finally {
      t.fx.cleanup();
    }
  });

  it('makes an instruction written after the launch wait for the untaken forced step, and applies it at the boundary after it (F3)', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [LOW, CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
    try {
      installEngineers(t);
      await t.run({ lanes: 1, maxSteps: 2 });
      strictEqual(t.latest().halt.reason, 'low-confidence', t.lines.join('\n'));
      const c = childOf(t, 'A');
      // A note pending at the launch: applied before the forced step, alone.
      const atLaunch = await instruct(t, 'A', 'pending at the launch');
      // The owner's instruction, written once the run has taken its forced
      // step and before its first look at the lane: the run's budget is made
      // there, after the refusal's read (a synchronous write, as the budget is).
      const { execFileSync } = await import('node:child_process');
      const { createBudget } = await import(resolve(AP, 'budget.mjs'));
      const writer = `const I = await import(process.argv[1]); const [w, m, ch, wit] = process.argv.slice(2);
        const e = await I.writeInstruction({ mainRoot: w, macroId: m, subtaskId: 'A', branch: 'feat/a', child: ch, step: '/engineer:refine', note: I.checkNoteBytes(Buffer.from('written after the launch')), witness: JSON.parse(wit), writtenBy: 'owner' });
        process.stdout.write(e.id);`;
      let later = null;
      const deps = {
        createBudget: (o) => {
          later = execFileSync(process.execPath, ['--input-type=module', '-e', writer, pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/instructions.mjs')).href, t.work, t.fx.macroId, c.id, JSON.stringify(I.gateWitnessOf(c.text))], { encoding: 'utf8' });
          return createBudget(o);
        },
      };
      await t.run({ lanes: 1, maxSteps: 2, forced: P.parseForcedStep('/engineer:critique'), forcedText: '/engineer:critique' }, deps);
      ok(later, t.lines.join('\n'));
      const verbs = t.latest().steps.filter((s) => s.kind === 'verb');
      deepStrictEqual(verbs.map((s) => [s.forced === true, /\/engineer:(\w+)/.exec(s.command)?.[1]]), [[true, 'critique'], [false, 'refine']], `${JSON.stringify(t.latest().steps)}\n${t.lines.join('\n')}`);
      const e = entries(t).find((x) => x.id === later);
      strictEqual(e.state, 'applied');
      strictEqual(e.ack.replaced_step, '/engineer:critique', 'it replaced the step the forced critique\'s finish-verb wrote');
      strictEqual(verbs[1].instruction_application, e.ack.application_id);
      // The note pending at the launch was applied on its own, before the
      // forced step, at its seq; the later one after it.
      const n = entries(t).find((x) => x.id === atLaunch.id);
      strictEqual(n.state, 'applied');
      ok(n.ack.application_id !== e.ack.application_id, 'two applications');
      const lines = t.latest().instructions.filter((x) => x.instruction?.state === 'applied');
      deepStrictEqual(lines.map((x) => [x.seq, x.instruction.application_id]), [[verbs[0].seq, n.ack.application_id], [verbs[1].seq, e.ack.application_id]], JSON.stringify(t.latest().instructions));
    } finally {
      t.fx.cleanup();
    }
  });

  it('keeps an untaken forced step waiting while the application of a note pending at the launch is deferred, and takes it once the note applied (F3)', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [LOW, CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
    try {
      installEngineers(t);
      await t.run({ lanes: 1, maxSteps: 2 });
      const note = await instruct(t, 'A', 'read this before the critique');
      let calls = 0;
      await t.run({ lanes: 1, maxSteps: 1, forced: P.parseForcedStep('/engineer:critique'), forcedText: '/engineer:critique' }, {
        instructRetryMs: 50,
        applyInstructions: async (a) => {
          calls += 1;
          if (calls > 6) t.signals.emit('SIGINT');
          if (calls === 1) return { ok: true, result: { state: 'waiting', detail: 'the child moved for the test', dropped: [] } };
          return IB.applyAtBoundary(a);
        },
      });
      const run = t.latest();
      const verbs = run.steps.filter((s) => s.kind === 'verb');
      ok(verbs.length === 1 && verbs[0].forced === true && /\/engineer:critique/.test(verbs[0].command), `${JSON.stringify(run.steps)}\n${t.lines.join('\n')}`);
      strictEqual(calls, 2, t.lines.join('\n'));
      const n = entries(t).find((x) => x.id === note.id);
      strictEqual(n.state, 'applied');
      // Both attempts at the forced step's seq: it waited for the note.
      deepStrictEqual(run.instructions.map((x) => [x.seq, x.instruction.detail_code ?? x.instruction.state]), [[verbs[0].seq, 'waiting'], [verbs[0].seq, 'applied']], JSON.stringify(run.instructions));
    } finally {
      t.fx.cleanup();
    }
  });

  it('takes a forced step beside a sibling\'s pending instruction with a step when the sibling\'s child has archived: only the subtask the forced step can name is read', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [COMMIT], file: 'a.txt' }, B: { next: [LOW, CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }, { id: 'B' }] });
    try {
      installEngineers(t);
      await t.run({ lanes: 1, maxSteps: 4 });
      const archived = (() => {
        const dir = join(t.work, '.agentic-plugins/state/engineer/archive');
        for (const name of existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.md')) : []) {
          const text = readFileSync(join(dir, name), 'utf8');
          if (text.includes('originating_subtask: "A"')) return { text, id: /workflow_id: "([^"]+)"/.exec(text)[1] };
        }
        return null;
      })();
      ok(archived, `A's child archived\n${t.lines.join('\n')}`);
      ok(childOf(t, 'B'), `B's child active\n${t.lines.join('\n')}`);
      // A's instruction, left pending beside its archived child (its drop,
      // child-archived, comes at a boundary of A, after the forced step).
      const a = await I.writeInstruction({
        mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', branch: 'feat/a', child: archived.id, step: '/engineer:refine',
        note: I.checkNoteBytes(Buffer.from('for A')), witness: I.gateWitnessOf(archived.text), writtenBy: 'owner',
      });
      strictEqual(entries(t, 'A').find((x) => x.id === a.id).state, 'pending');
      await t.run({ lanes: 1, maxSteps: 1, forced: P.parseForcedStep('/engineer:critique'), forcedText: '/engineer:critique' });
      const run = t.latest();
      ok(!/is refused/.test(run.halt?.detail ?? ''), `${run.halt?.detail}\n${t.lines.join('\n')}`);
      const verbs = run.steps.filter((s) => s.kind === 'verb');
      ok(verbs.length === 1 && verbs[0].forced === true && verbs[0].subtask_id === 'B' && /\/engineer:critique/.test(verbs[0].command), `${JSON.stringify(run.steps)}\n${t.lines.join('\n')}`);
    } finally {
      t.fx.cleanup();
    }
  });

  it('takes a forced step beside a pending instruction with a step bound to a child that no longer has the lane, which is then dropped; a record that cannot be read refuses it (F2)', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [LOW, CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
    try {
      installEngineers(t);
      await t.run({ lanes: 1, maxSteps: 2 });
      strictEqual(t.latest().halt.reason, 'low-confidence', t.lines.join('\n'));
      // An instruction for a child the lane no longer has (a replacement
      // took the subtask before any boundary swept it): it applies to
      // nothing (item 6), so it refuses nothing.
      const stale = await I.writeInstruction({
        mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', branch: 'feat/a', child: 'critique-20260101T000000Z-0a0b0c', step: '/engineer:refine',
        note: I.checkNoteBytes(Buffer.from('for the earlier child')), witness: { gate: null, resolved: 0 }, writtenBy: 'owner',
      });
      const forced = { forced: P.parseForcedStep('/engineer:critique'), forcedText: '/engineer:critique' };
      await t.run({ lanes: 1, maxSteps: 1, ...forced });
      const run = t.latest();
      ok(!/is refused/.test(run.halt?.detail ?? ''), `${run.halt?.detail}\n${t.lines.join('\n')}`);
      const verbs = run.steps.filter((s) => s.kind === 'verb');
      ok(verbs.length === 1 && verbs[0].forced === true && /\/engineer:critique/.test(verbs[0].command), `${JSON.stringify(run.steps)}\n${t.lines.join('\n')}`);
      const e = entries(t).find((x) => x.id === stale.id);
      deepStrictEqual([e.state, e.ack?.cause], ['dropped', 'child-replaced'], JSON.stringify(e));
      // What the record holds cannot be told: the forced step is refused, naming the record.
      writeFileSync(I.instructionsPath(t.work, t.fx.macroId, 'A'), '{ not json');
      await t.run({ lanes: 1, maxSteps: 1, ...forced });
      const r2 = t.latest();
      strictEqual(r2.halt.reason, 'owner-choice', t.lines.join('\n'));
      ok(/is refused: subtask A's instructions record .*A\.json cannot be read/.test(r2.halt.detail), r2.halt.detail);
      deepStrictEqual(r2.steps, []);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a run that ends after an application and before its step: the relaunch applies a second, and status says the first one\'s step never ran', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [LOW, CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
    try {
      installEngineers(t);
      await t.run({ lanes: 1, maxSteps: 2 });
      const first = await instruct(t, 'A', 'first', '/engineer:refine');
      // The run stops right after the application, before it spawns the step.
      await t.run({ lanes: 1, maxSteps: 1 }, { applyInstructions: async (a) => { const r = await IB.applyAtBoundary(a); t.signals.emit('SIGINT'); return r; } });
      strictEqual(t.latest().halt.reason, 'interrupted');
      ok(!t.latest().steps.some((s) => s.kind === 'verb'), 'no step was spawned');
      strictEqual(entries(t)[0].state, 'applied');
      const second = await instruct(t, 'A', 'second', '/engineer:decide');
      await t.run({ lanes: 1, maxSteps: 1 });
      const verb = t.latest().steps.find((s) => s.kind === 'verb');
      ok(verb && /\/engineer:decide/.test(verb.command), JSON.stringify(t.latest().steps));
      const out = [];
      await C.main(['status', '--macro', t.fx.macroId, '--repo', t.work], { env: t.env, io: { stdin: { isTTY: false } }, out: (s) => out.push(s), err: (s) => out.push(s) });
      const text = out.join('\n');
      ok(new RegExp(`instruction ${first.id} r1: applied next /engineer:refine.*its step was replaced before it ran`).test(text), text);
      ok(new RegExp(`instruction ${second.id} r1: applied next /engineer:decide.*its step ran \\(run autopilot-\\S+, step 1\\)`).test(text), text);
    } finally {
      t.fx.cleanup();
    }
  });

  it('names on a step\'s ledger line an application the run did not make (the owner command\'s), read from the receipts', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [LOW, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
    try {
      await t.run({ lanes: 1, maxSteps: 2 });
      await instruct(t, 'A', 'owner applied', '/engineer:refine');
      const AP2 = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/instruct-apply.mjs')).href);
      const { ENG } = await import('./fixtures/autopilot-repo.mjs');
      const r = await AP2.applyInstructions({ mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', childPath: childOf(t, 'A').path, engineerRoot: ENG, by: 'instruct', stateRoots: [t.work] });
      strictEqual(r.state, 'applied');
      await t.run({ lanes: 1, maxSteps: 1 });
      const verb = t.latest().steps.find((x) => x.kind === 'verb');
      ok(verb && /\/engineer:refine/.test(verb.command), JSON.stringify(t.latest().steps));
      strictEqual(verb.instruction_application, r.applicationId);
    } finally {
      t.fx.cleanup();
    }
  });

  it('an application left waiting defers the lane\'s recorded step, tries again, and halts after the last attempt with the instruction kept', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
    try {
      await t.run({ lanes: 1, maxSteps: 1 });
      await instruct(t, 'A', 'replace the critique', '/engineer:refine');
      let calls = 0;
      await t.run({ lanes: 1, maxSteps: 2 }, {
        instructRetryMs: 50,
        applyInstructions: async () => {
          calls += 1;
          // A run that tries without bound is stopped, and the count fails.
          if (calls > 6) t.signals.emit('SIGINT');
          return { ok: true, result: { state: 'waiting', detail: 'the child moved for the test', dropped: [] } };
        },
      });
      const run = t.latest();
      deepStrictEqual(run.steps.filter((s) => s.kind === 'verb'), [], `the recorded critique never ran over the pending instruction\n${t.lines.join('\n')}`);
      strictEqual(calls, 3);
      strictEqual(run.halt.reason, 'owner-choice');
      ok(/subtask A's instructions stayed waiting through 3 attempts at its boundary \(the child moved for the test\)/.test(run.halt.detail), run.halt.detail);
      strictEqual(entries(t)[0].state, 'pending', 'the instruction is kept');
      deepStrictEqual(run.instructions.map((x) => x.instruction.detail_code), ['waiting', 'waiting', 'waiting'], 'each attempt is on the ledger, apart from the steps');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a record that turns unreadable keeps the recorded step deferred, and halts naming the record to repair', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
    try {
      await t.run({ lanes: 1, maxSteps: 1 });
      await instruct(t, 'A', 'replace the critique', '/engineer:refine');
      const file = I.instructionsPath(t.work, t.fx.macroId, 'A');
      let calls = 0;
      await t.run({ lanes: 1, maxSteps: 2 }, {
        instructRetryMs: 50,
        applyInstructions: async () => {
          calls += 1;
          if (calls > 6) t.signals.emit('SIGINT');
          writeFileSync(file, '{ not json');
          return { ok: true, result: { state: 'unreadable', detail: 'the record cannot be read for the test', dropped: [] } };
        },
      });
      const run = t.latest();
      deepStrictEqual(run.steps.filter((s) => s.kind === 'verb'), [], `the recorded critique never ran over an unknown record\n${t.lines.join('\n')}`);
      // One attempt on the record as written, then three on the record that
      // cannot be read: the count starts again when the record changes.
      strictEqual(calls, 4);
      ok(/stayed unreadable through 3 attempts.*Repair or remove the record .*instructions/.test(run.halt.detail), run.halt.detail);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a deferred application that applies at its retry starts the instruction\'s step, once, at the seq it waited at', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
    try {
      await t.run({ lanes: 1, maxSteps: 1 });
      installEngineers(t);
      await instruct(t, 'A', 'replace the critique', '/engineer:refine');
      let calls = 0;
      await t.run({ lanes: 1, maxSteps: 1 }, {
        instructRetryMs: 50,
        applyInstructions: async (a) => {
          calls += 1;
          if (calls === 1) return { ok: true, result: { state: 'waiting', detail: 'the child moved for the test', dropped: [] } };
          return IB.applyAtBoundary(a);
        },
      });
      const run = t.latest();
      const verbs = run.steps.filter((s) => s.kind === 'verb');
      deepStrictEqual(verbs.map((s) => [s.seq, /\/engineer:(\w+)/.exec(s.command)?.[1]]), [[1, 'refine']], `${JSON.stringify(run.steps)}\n${t.lines.join('\n')}`);
      strictEqual(calls, 2);
      strictEqual(entries(t)[0].state, 'applied');
    } finally {
      t.fx.cleanup();
    }
  });

  it('keeps a lane at no boundary (an operation open) from its recorded step, and applies at the retry once the operation closed (M1)', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
    try {
      await t.run({ lanes: 1, maxSteps: 1 });
      installEngineers(t);
      await instruct(t, 'A', 'replace the critique', '/engineer:refine');
      let calls = 0;
      await t.run({ lanes: 1, maxSteps: 1 }, {
        instructRetryMs: 50,
        applyInstructions: async (a) => {
          calls += 1;
          if (calls === 1) return { ok: true, result: { state: 'not-at-boundary', detail: 'a persona operation is open in subtask A\'s lane (the test\'s)', dropped: [] } };
          return IB.applyAtBoundary(a);
        },
      });
      const run = t.latest();
      const verbs = run.steps.filter((s) => s.kind === 'verb');
      deepStrictEqual(verbs.map((s) => [s.seq, /\/engineer:(\w+)/.exec(s.command)?.[1]]), [[1, 'refine']], `${JSON.stringify(run.steps)}\n${t.lines.join('\n')}`);
      strictEqual(calls, 2);
      strictEqual(entries(t)[0].state, 'applied');
    } finally {
      t.fx.cleanup();
    }
  });

  it('leaves an instruction pending beside a commit the child began and did not finish: the commit runs again, and the instruction never applies over it (item 5)', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
    try {
      await t.run({ lanes: 1, maxSteps: 1 });
      installEngineers(t);
      // The child as a commit a crash interrupted leaves it.
      const c = childOf(t, 'A');
      writeFileSync(c.path, c.text.replace(/current_phase: "[^"]*"/, 'current_phase: "phase-7-commit"'));
      await instruct(t, 'A', 'refine instead', '/engineer:refine');
      await t.run({ lanes: 1, maxSteps: 1 });
      const run = t.latest();
      const verb = run.steps.find((s) => s.kind === 'verb' || s.kind === 'commit');
      ok(verb && /\/engineer:commit/.test(verb.command), `the commit runs again\n${JSON.stringify(run.steps.map((s) => [s.kind, s.command]))}\n${t.lines.join('\n')}`);
      strictEqual(verb.instruction_application, undefined);
      ok(t.lines.some((l) => /subtask A's instructions not-at-boundary: subtask A's child is in a commit it began and did not finish/.test(l)), t.lines.join('\n'));
      ok(entries(t)[0].state !== 'applied', JSON.stringify(entries(t)[0]));
      ok(!childOf(t, 'A').text.includes('refine instead'), 'the note never reached the child');
      // The turn's attempt met this record: the commit's admission does not
      // yield to it (critique 9 F1's recheck asks only of a record no attempt met).
      ok(!t.lines.some((l) => /comes before this step; deciding again/.test(l)), t.lines.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });

  it('applies nothing where the lane\'s operations cannot be made visible, and the run goes on as it would', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
    try {
      await t.run({ lanes: 1, maxSteps: 1 });
      await instruct(t, 'A', 'invisible', '/engineer:refine');
      await t.run({ lanes: 1, maxSteps: 1 });
      const verb = t.latest().steps.find((s) => s.kind === 'verb');
      ok(verb && /\/engineer:critique/.test(verb.command), JSON.stringify(t.latest().steps));
      strictEqual(entries(t)[0].state, 'pending');
      ok(t.lines.some((l) => /subtask A's instructions inactive: the lane's operations cannot be made visible/.test(l)), t.lines.join('\n'));
      ok(!childOf(t, 'A').text.includes('invisible'));
    } finally {
      t.fx.cleanup();
    }
  });
});
