// tests/orchestrator/test-instruct-apply.mjs
//
// ADR-0068 Decision 7, items 3 to 6 (impl-instruct) — the application of a
// lane's instructions to its child (scripts/lib/instruct-apply.mjs), through
// the real engineer `append`: one phase note naming the receipt and the step
// at HIGH; several at one boundary (every note in order, the last step wins);
// a gate set, or set and resolved, after the write supersedes the step and
// keeps the note; a crash between the child's write and the acknowledgement
// applies once; one before the write rolls back and applies at the next
// boundary; a refused append leaves the entries pending; a note written before
// the dispatch binds to the first child after it; and the lifecycle sweep
// drops what applies to nothing, never applying it to another child.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeRepo, ENG } from './fixtures/autopilot-repo.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const LIB = join(REPO_ROOT, 'plugins/orchestrator/scripts/lib');
const I = await import(pathToFileURL(join(LIB, 'instructions.mjs')).href);
const A = await import(pathToFileURL(join(LIB, 'instruct-apply.mjs')).href);
const RL = await import(pathToFileURL(join(LIB, 'run-locks.mjs')).href);
const IB = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/instruct-boundary.mjs')).href);

const HIGH = (verb) => ({ kind: 'verb', verb, confidence: 'HIGH' });
// A probe that finds another process under the applier's pid: it is gone.
const SELF = await RL.processFingerprint(process.pid);
const dead = async () => ({ ...SELF, lstart: 'another start', starttime: -1 });

async function withLane(fn) {
  const fx = await makeRepo({ subtasks: [{ id: 'A' }, { id: 'B', blocked_by: ['A'] }] });
  try {
    const work = realpathSync(fx.work);
    return await fn(fx, work);
  } finally {
    fx.cleanup();
  }
}

const note = (t) => I.checkNoteBytes(Buffer.from(t));
// The witness as the owner command reads it: the lane's application notes to this child are the owner's.
const own = (fx, work, child) => I.laneApplicationIds(I.readInstructions(work, fx.macroId, 'A').record, child.id);
async function instruct(fx, work, child, text, step = null) {
  const r = await fx.eng.readWorkflow(child.path);
  const witness = I.gateWitnessOf(readFileSync(child.path, 'utf8'), own(fx, work, child));
  ok(r.frontmatter.workflow_id === child.id);
  return I.writeInstruction({ mainRoot: work, macroId: fx.macroId, subtaskId: 'A', branch: 'feat/a', child: child.id, step, note: note(text), witness, writtenBy: 'owner' });
}
const apply = (fx, work, child, extra = {}) => A.applyInstructions({
  mainRoot: work, macroId: fx.macroId, subtaskId: 'A', childPath: child.path, engineerRoot: ENG, by: 'test', stateRoots: [work], ...extra,
});
const entries = (fx, work) => I.readInstructions(work, fx.macroId, 'A').record.entries;
const headings = (text, id) => text.split(`### ${A.applicationHeading(id)}\n`).length - 1;

describe('applying a lane\'s instructions', () => {
  it('appends the note as one phase note naming the receipt, and records the step at HIGH, replacing the child\'s', () => withLane(async (fx, work) => {
    const child = await fx.dispatch('A');
    await fx.finish(child.path, HIGH('critique'));
    const e = await instruct(fx, work, child, 'Try the second approach.', '/engineer:refine');
    const r = await apply(fx, work, child);
    strictEqual(r.state, 'applied');
    strictEqual(r.effective, '/engineer:refine');
    strictEqual(r.replacedStep, '/engineer:critique');
    const text = readFileSync(child.path, 'utf8');
    strictEqual(headings(text, r.applicationId), 1);
    ok(text.includes('Try the second approach.'));
    const fm = (await fx.eng.readWorkflow(child.path)).frontmatter;
    deepStrictEqual([fm.next_step_kind, fm.next_step_verb, fm.next_step_confidence], ['verb', 'refine', 'HIGH']);
    const [after] = entries(fx, work);
    strictEqual(after.id, e.id);
    strictEqual(after.state, 'applied');
    strictEqual(after.ack.application_id, r.applicationId);
    strictEqual(after.ack.replaced_step, '/engineer:critique');
    strictEqual(I.readInstructions(work, fx.macroId, 'A').record.receipts.at(-1).state, 'done');
    // Applied once: nothing more is applied at the next boundary.
    strictEqual((await apply(fx, work, child)).state, 'none');
  }));

  it('applies several at one boundary: every note in order, the last step wins, the earlier ones superseded', () => withLane(async (fx, work) => {
    const child = await fx.dispatch('A');
    await fx.finish(child.path, HIGH('critique'));
    const a = await instruct(fx, work, child, 'first note', '/engineer:refine');
    const b = await instruct(fx, work, child, 'second note');
    const c = await instruct(fx, work, child, 'third note', '/engineer:commit');
    const r = await apply(fx, work, child);
    strictEqual(r.effective, '/engineer:commit');
    deepStrictEqual(r.superseded, [{ id: a.id, cause: 'later-step' }]);
    const text = readFileSync(child.path, 'utf8');
    ok(text.indexOf('first note') < text.indexOf('second note') && text.indexOf('second note') < text.indexOf('third note'), 'in the order written');
    strictEqual(headings(text, r.applicationId), 1, 'one persona operation');
    deepStrictEqual(entries(fx, work).map((e) => [e.id, e.state, e.ack?.cause ?? null]), [[a.id, 'superseded', 'later-step'], [b.id, 'applied', null], [c.id, 'applied', null]]);
    strictEqual((await fx.eng.readWorkflow(child.path)).frontmatter.next_step_kind, 'commit');
  }));

  it('reserves only the entries it is given beside a forced step: one written since stays pending, its step unapplied (F3)', () => withLane(async (fx, work) => {
    const child = await fx.dispatch('A');
    await fx.finish(child.path, HIGH('critique'));
    const atLaunch = await instruct(fx, work, child, 'pending at the launch');
    const later = await instruct(fx, work, child, 'written since', '/engineer:refine');
    const r = await apply(fx, work, child, { onlyEntries: [`${atLaunch.id}:${atLaunch.revision}`] });
    strictEqual(r.state, 'applied');
    deepStrictEqual(r.entries, [{ id: atLaunch.id, revision: 1 }]);
    strictEqual(r.effective, null, 'the later step is not the reservation\'s');
    deepStrictEqual(r.superseded, []);
    const now = entries(fx, work);
    strictEqual(now.find((x) => x.id === atLaunch.id).state, 'applied');
    strictEqual(now.find((x) => x.id === later.id).state, 'pending', 'the later instruction waits, its step whole');
    const fm = (await fx.eng.readWorkflow(child.path)).frontmatter;
    deepStrictEqual([fm.next_step_kind, fm.next_step_verb], ['verb', 'critique'], 'the child keeps its step');
    ok(!readFileSync(child.path, 'utf8').includes('written since'));
    // A revision is a new key: the reservation takes nothing for it.
    const none = await apply(fx, work, child, { onlyEntries: [`${later.id}:2`] });
    strictEqual(none.state, 'none');
  }));

  it('lets a gate set after the write supersede the step and keep the note: the child still waits on its gate', () => withLane(async (fx, work) => {
    const child = await fx.dispatch('A');
    await fx.finish(child.path, HIGH('critique'));
    const e = await instruct(fx, work, child, 'note under a gate', '/engineer:refine');
    await fx.finish(child.path, { kind: 'owner-decision', verb: null, confidence: 'HIGH' }, { ownerGate: { gate: 'scope-routing', anchor: 'routing-recommendation' } });
    const r = await apply(fx, work, child);
    strictEqual(r.state, 'applied');
    strictEqual(r.effective, null);
    deepStrictEqual(r.superseded, [{ id: e.id, cause: 'gate' }]);
    const fm = (await fx.eng.readWorkflow(child.path)).frontmatter;
    strictEqual(fm.awaiting_owner_gate, 'scope-routing', 'never clears a gate');
    strictEqual(fm.next_step_kind, 'owner-decision');
    ok(readFileSync(child.path, 'utf8').includes('note under a gate'));
    strictEqual(entries(fx, work)[0].state, 'superseded');
  }));

  it('keeps a gate\'s resolution: a gate set and resolved after the write still supersedes the step', () => withLane(async (fx, work) => {
    const child = await fx.dispatch('A');
    await fx.finish(child.path, HIGH('critique'));
    const e = await instruct(fx, work, child, 'written before the gate', '/engineer:refine');
    await fx.finish(child.path, { kind: 'owner-decision', verb: null, confidence: 'HIGH' }, { ownerGate: { gate: 'scope-routing', anchor: 'routing-recommendation' } });
    await fx.eng.clearAwaitingOwner({ workflowPath: child.path, host: 'claude', gate: 'scope-routing', nextStep: { kind: 'commit', verb: null, confidence: 'HIGH' }, nextAction: 'commit', resolution: 'land it' });
    const r = await apply(fx, work, child);
    deepStrictEqual(r.superseded, [{ id: e.id, cause: 'gate' }]);
    strictEqual((await fx.eng.readWorkflow(child.path)).frontmatter.next_step_kind, 'commit', 'the resolution\'s step is followed');
    // One written after the resolution is the owner's later word, and applies.
    const later = await instruct(fx, work, child, 'after the resolution', '/engineer:refine');
    const r2 = await apply(fx, work, child);
    strictEqual(r2.effective, '/engineer:refine');
    strictEqual(entries(fx, work).find((x) => x.id === later.id).state, 'applied');
  }));

  it('applies once when the applier dies between the child\'s write and the acknowledgement', () => withLane(async (fx, work) => {
    const child = await fx.dispatch('A');
    await fx.finish(child.path, HIGH('critique'));
    await instruct(fx, work, child, 'once only', '/engineer:refine');
    let crashed = false;
    await apply(fx, work, child, {
      runAppend: async (args) => { await A.plainAppend(args); crashed = true; throw new Error('the applier died'); },
    }).catch(() => {});
    ok(crashed);
    strictEqual(entries(fx, work)[0].state, 'applying', 'the receipt is left reserved');
    const r = await apply(fx, work, child, { probe: dead });
    strictEqual(r.state, 'none', 'the recovery finalized it, and nothing is pending');
    const [e] = entries(fx, work);
    strictEqual(e.state, 'applied');
    const receipt = I.readInstructions(work, fx.macroId, 'A').record.receipts.at(-1);
    strictEqual(receipt.recovered, true);
    strictEqual(headings(readFileSync(child.path, 'utf8'), receipt.application_id), 1, 'never written twice');
  }));

  it('rolls an application a crash stopped before the write back to pending, and applies it at the next boundary', () => withLane(async (fx, work) => {
    const child = await fx.dispatch('A');
    await fx.finish(child.path, HIGH('critique'));
    await instruct(fx, work, child, 'not lost', '/engineer:refine');
    await apply(fx, work, child, { runAppend: async () => { throw new Error('died before writing'); } }).catch(() => {});
    strictEqual(entries(fx, work)[0].state, 'applying');
    // While the applier lives, the next boundary waits for it.
    strictEqual((await apply(fx, work, child)).state, 'waiting');
    const r = await apply(fx, work, child, { probe: dead });
    strictEqual(r.state, 'applied');
    strictEqual(entries(fx, work)[0].state, 'applied');
    const receipts = I.readInstructions(work, fx.macroId, 'A').record.receipts;
    deepStrictEqual(receipts.map((x) => x.state), ['rolled-back', 'done']);
  }));

  it('leaves the entries pending when the append is refused, and when the child moved before the write', () => withLane(async (fx, work) => {
    const child = await fx.dispatch('A');
    await fx.finish(child.path, HIGH('critique'));
    await instruct(fx, work, child, 'refused', '/engineer:refine');
    const r = await apply(fx, work, child, { runAppend: async () => ({ ok: false, detail: 'refused for the test' }) });
    deepStrictEqual([r.state, r.detail], ['failed', 'refused for the test']);
    strictEqual(entries(fx, work)[0].state, 'pending');
    const moved = await apply(fx, work, child, { hooks: { beforeAppend: () => fx.finish(child.path, HIGH('decide')) } });
    strictEqual(moved.state, 'waiting');
    strictEqual(entries(fx, work)[0].state, 'pending');
    strictEqual((await fx.eng.readWorkflow(child.path)).frontmatter.next_step_verb, 'decide', 'the step that slipped in stands until the next boundary');
  }));

  it('keeps a crash\'s receipt reserved while the child cannot be read, and applies it once when it reads again', () => withLane(async (fx, work) => {
    const child = await fx.dispatch('A');
    await fx.finish(child.path, HIGH('critique'));
    await instruct(fx, work, child, 'once, unreadable between', '/engineer:refine');
    await apply(fx, work, child, {
      runAppend: async (args) => { await A.plainAppend(args); throw new Error('the applier died'); },
    }).catch(() => {});
    strictEqual(entries(fx, work)[0].state, 'applying');
    chmodSync(child.path, 0o000);
    try {
      const rec = await A.reconcileReceipts({ mainRoot: work, macroId: fx.macroId, subtaskId: 'A', stateRoots: [work], probe: dead });
      deepStrictEqual([rec.finalized, rec.rolledBack, rec.waiting.length], [[], [], 1], 'an unreadable child is no proof of absence');
      strictEqual(entries(fx, work)[0].state, 'applying');
    } finally {
      chmodSync(child.path, 0o644);
    }
    strictEqual((await apply(fx, work, child, { probe: dead })).state, 'none', 'once it reads, the recovery finalizes it');
    strictEqual(entries(fx, work)[0].state, 'applied');
    const receipt = I.readInstructions(work, fx.macroId, 'A').record.receipts.at(-1);
    strictEqual(headings(readFileSync(child.path, 'utf8'), receipt.application_id), 1, 'never written twice');
  }));

  it('reads every copy of the child under every root: a stale copy under an earlier root never hides the note in a later one', () => withLane(async (fx, work) => {
    const child = await fx.dispatch('A');
    await fx.finish(child.path, HIGH('critique'));
    await instruct(fx, work, child, 'once, beside a stale copy', '/engineer:refine');
    const stale = readFileSync(child.path, 'utf8');
    await apply(fx, work, child, {
      runAppend: async (args) => { await A.plainAppend(args); throw new Error('the applier died'); },
    }).catch(() => {});
    strictEqual(entries(fx, work)[0].state, 'applying');
    // Another checkout's state root, listed first, holds the child as it was
    // before the append.
    const other = mkdtempSync(join(tmpdir(), 'instruct-other-root-'));
    try {
      const dir = join(other, '.agentic-plugins/state/engineer/workflows');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, basename(child.path)), stale);
      const rec = await A.reconcileReceipts({ mainRoot: work, macroId: fx.macroId, subtaskId: 'A', stateRoots: [other, work], probe: dead });
      deepStrictEqual([rec.finalized.length, rec.rolledBack], [1, []], 'the later copy holds the note');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    strictEqual(entries(fx, work)[0].state, 'applied');
    strictEqual((await apply(fx, work, child)).state, 'none');
    const receipt = I.readInstructions(work, fx.macroId, 'A').record.receipts.at(-1);
    strictEqual(headings(readFileSync(child.path, 'utf8'), receipt.application_id), 1, 'never written twice');
  }));

  it('keeps a crash\'s receipt reserved while no copy of its child is found, and applies it once when the child is back', () => withLane(async (fx, work) => {
    const child = await fx.dispatch('A');
    await fx.finish(child.path, HIGH('critique'));
    await instruct(fx, work, child, 'once, the child away', '/engineer:refine');
    await apply(fx, work, child, {
      runAppend: async (args) => { await A.plainAppend(args); throw new Error('the applier died'); },
    }).catch(() => {});
    const away = `${child.path}.away`;
    renameSync(child.path, away);
    try {
      const rec = await A.reconcileReceipts({ mainRoot: work, macroId: fx.macroId, subtaskId: 'A', stateRoots: [work], probe: dead });
      deepStrictEqual([rec.finalized, rec.rolledBack, rec.waiting.length], [[], [], 1], 'a child not found is no proof of absence');
    } finally {
      renameSync(away, child.path);
    }
    strictEqual((await apply(fx, work, child, { probe: dead })).state, 'none');
    const receipt = I.readInstructions(work, fx.macroId, 'A').record.receipts.at(-1);
    strictEqual(headings(readFileSync(child.path, 'utf8'), receipt.application_id), 1, 'never written twice');
  }));

  it('keeps the receipt reserved when the child cannot be read back after the append, and never writes the note twice', () => withLane(async (fx, work) => {
    const child = await fx.dispatch('A');
    await fx.finish(child.path, HIGH('critique'));
    await instruct(fx, work, child, 'read back later', '/engineer:refine');
    let r;
    try {
      r = await apply(fx, work, child, { runAppend: async (args) => { const a = await A.plainAppend(args); chmodSync(child.path, 0o000); return a; } });
    } finally {
      chmodSync(child.path, 0o644);
    }
    strictEqual(r.state, 'waiting', JSON.stringify(r));
    strictEqual(entries(fx, work)[0].state, 'applying', 'not rolled back');
    strictEqual((await apply(fx, work, child, { probe: dead })).state, 'none');
    strictEqual(entries(fx, work)[0].state, 'applied');
    const receipt = I.readInstructions(work, fx.macroId, 'A').record.receipts.at(-1);
    strictEqual(headings(readFileSync(child.path, 'utf8'), receipt.application_id), 1, 'never written twice');
  }));
});

describe('the instruction\'s step and the worker\'s Phase 0 (P2)', () => {
  const phase0 = (child) => A.plainAppend([join(ENG, 'scripts', 'state.mjs'), 'append', '--workflow-path', child.path, '--host', 'claude',
    '--phase-label', 'Phase 0: Resume into refine', '--phase-note', 'Resumed from prior verb.', '--event', 'resumed', '--once-operation', 'checkpoint']);

  it('takes a Phase 0 heading quoted in the owner\'s note for no step, and a worker\'s for one', () => withLane(async (fx, work) => {
    const child = await fx.dispatch('A');
    await fx.finish(child.path, HIGH('critique'));
    await instruct(fx, work, child, 'as the log said:\n### Phase 0: Resume into compose\nso refine now', '/engineer:refine');
    const r = await apply(fx, work, child);
    strictEqual(r.state, 'applied');
    deepStrictEqual(IB.instructedStep(work, fx.macroId, 'A', child.path), { applicationId: r.applicationId, step: '/engineer:refine' }, 'the quoted heading is the owner\'s text');
    // A later note-only application quoting one leaves the step the instruction's.
    await instruct(fx, work, child, '````\n### Phase 0: Resume into refine\n````');
    strictEqual((await apply(fx, work, child)).state, 'applied');
    strictEqual(IB.instructedStep(work, fx.macroId, 'A', child.path)?.step, '/engineer:refine');
    // A worker's Phase 0 after it is a step since.
    strictEqual((await phase0(child)).ok, true);
    strictEqual(IB.instructedStep(work, fx.macroId, 'A', child.path), null);
  }));

  it('takes a later note quoting the application\'s heading for a quote: a worker\'s Phase 0 after it is still a step since', () => withLane(async (fx, work) => {
    const child = await fx.dispatch('A');
    await fx.finish(child.path, HIGH('critique'));
    await instruct(fx, work, child, 'refine', '/engineer:refine');
    const r = await apply(fx, work, child);
    strictEqual(r.state, 'applied');
    // A note-only application quoting the first one's heading, then a
    // worker's Phase 0: the step is no longer the instruction's.
    await instruct(fx, work, child, `as applied:\n### ${A.applicationHeading(r.applicationId)}\n`);
    strictEqual((await apply(fx, work, child)).state, 'applied');
    strictEqual(IB.instructedStep(work, fx.macroId, 'A', child.path)?.applicationId, r.applicationId, 'the quote is no step');
    strictEqual((await phase0(child)).ok, true);
    strictEqual(IB.instructedStep(work, fx.macroId, 'A', child.path), null, 'the Phase 0 after the quote is seen');
    // Quoted once more after that Phase 0: the scan still starts at the
    // application's own heading, and the Phase 0 between is seen.
    await instruct(fx, work, child, `again:\n### ${A.applicationHeading(r.applicationId)}\n`);
    strictEqual((await apply(fx, work, child)).state, 'applied');
    strictEqual(IB.instructedStep(work, fx.macroId, 'A', child.path), null, 'the Phase 0 before the last quote is seen');
  }));

  it('reads a worker\'s note as before: its unclosed fence never hides a later Phase 0', () => {
    const app = '### Owner instructions app-20261101T000000Z-0a0b0c0d\n\nnote\n\n#### Instruction i r1\n\n```text\n### Phase 0: quoted\n```\n';
    const own = new Set(['app-20261101T000000Z-0a0b0c0d', 'app-20261101T000001Z-0a0b0c0e']);
    strictEqual(IB.workerStepSince(app, 0, own), false);
    strictEqual(IB.workerStepSince(`${app}\n### Phase 1: Critique\n\n\`\`\`\nunclosed\n\n### Phase 0: Resume into refine\n`, 0, own), true);
    strictEqual(IB.workerStepSince(`${app}\n### Owner instructions app-20261101T000001Z-0a0b0c0e\n\n\`\`\`text\n### Phase 0: x\n\`\`\`\n`, 0, own), false);
    // A worker's note quoting the application's heading in a fence: the quote
    // is no note of the owner's, and the Phase 0 after it is seen.
    strictEqual(IB.workerStepSince(`${app}\n### Phase 1: Critique\n\n\`\`\`\n### Owner instructions app-20261101T000000Z-0a0b0c0d\n\`\`\`\n\n### Phase 0: Resume into refine\n`, 0, own), true);
  });

  it('takes another lane\'s application heading, quoted at its first occurrence here, for a worker\'s text (N2)', () => {
    const own = new Set(['app-20261101T000000Z-0a0b0c0d']);
    const quote = '### Phase 1: Critique\n\nlane B wrote:\n\n```\n### Owner instructions app-20261101T000000Z-0b0b0b0b\n```\n\n### Phase 0: Resume into refine\n';
    strictEqual(IB.workerStepSince(quote, 0, own), true, 'the Phase 0 after the quote is seen');
    // The lane's own application is still the owner's note, its quote no step.
    strictEqual(IB.workerStepSince('### Owner instructions app-20261101T000000Z-0a0b0c0d\n\n```text\n### Phase 0: quoted\n```\n', 0, own), false);
  });
});

describe('the boundary and the note\'s fence', () => {
  it('takes an interactive verb\'s terminal end for no commit, and a commit begun for one', () => withLane(async (fx, work) => {
    const H = await import(pathToFileURL(join(LIB, 'holds.mjs')).href);
    const OPS = await import(pathToFileURL(join(LIB, 'hold-ops.mjs')).href);
    const child = await fx.dispatch('A');
    await fx.finish(child.path, HIGH('critique'), { autopilot: false });
    const fm = (await fx.eng.readWorkflow(child.path)).frontmatter;
    strictEqual(fm.terminal_marker, true);
    const refusal = () => A.boundaryRefusal({ mainRoot: work, macroId: fx.macroId, subtaskId: 'A', childPath: child.path, holdGate: OPS.holdGate, openOperations: H.openOperations });
    strictEqual(refusal(), null, `summary-complete is no commit: ${refusal()}`);
    const text = readFileSync(child.path, 'utf8').replace(/current_phase: "[^"]*"/, 'current_phase: "phase-7-commit"');
    writeFileSync(child.path, text);
    ok(/a commit it began and did not finish/.test(refusal() ?? ''), refusal());
  }));

  it('keeps a lane whose child records a verification batch started and not ended at no boundary, the lane\'s verify step first (F1)', () => withLane(async (fx, work) => {
    const H = await import(pathToFileURL(join(LIB, 'holds.mjs')).href);
    const OPS = await import(pathToFileURL(join(LIB, 'hold-ops.mjs')).href);
    const child = await fx.dispatch('A');
    await fx.finish(child.path, HIGH('critique'));
    const base = readFileSync(child.path, 'utf8');
    // The child as a dead driver's batch leaves it: its request pending, the
    // request's latest batch with no end (records stored as the persona
    // stores them, `key: "<its JSON>"`).
    const withVerify = (results) => {
      const request = { v: 1, id: '68e8d58e60781af6', checks: [{ kind: 'pass' }], on_pass: { kind: 'commit', confidence: 'HIGH' }, confidence: 'HIGH' };
      const lines = [`verify_request: ${JSON.stringify(JSON.stringify(request))}`, ...(results ? [`verify_results: ${JSON.stringify(JSON.stringify({ v: 1, request_id: request.id, ...results }))}`] : [])];
      const t = base.replace(/next_step_kind: "[^"]*"/, 'next_step_kind: "verify"');
      const end = t.indexOf('\n---\n', 4);
      writeFileSync(child.path, `${t.slice(0, end)}\n${lines.join('\n')}${t.slice(end)}`);
    };
    const state = () => A.boundaryState({ mainRoot: work, macroId: fx.macroId, subtaskId: 'A', childPath: child.path, holdGate: OPS.holdGate, openOperations: H.openOperations });
    withVerify({ batches: [{ batch_id: 'dead-1', results: [] }] });
    strictEqual(A.openBatchOf(readFileSync(child.path, 'utf8')), 'dead-1');
    const open = state();
    ok(open && open.stepFirst === true && /verification batch dead-1 is open .*verify step ends it first/.test(open.why), JSON.stringify(open));
    // Ended (a stop, a hold or a drain cut it short), it keeps nothing: what
    // is left is a request not running, which an instruction's step replaces.
    withVerify({ batches: [{ batch_id: 'dead-1', results: [], end: 'cut-short', cause: 'driver-end' }] });
    strictEqual(state(), null);
    // A request no batch has started is no batch either.
    withVerify(null);
    strictEqual(state(), null);
    // Results that cannot be read beside a pending request are the verify step's to judge.
    writeFileSync(child.path, readFileSync(child.path, 'utf8').replace(/\n---\n/, '\nverify_results: "{not json"\n---\n'));
    strictEqual(state()?.stepFirst, true);
  }));

  it('keeps a note\'s unclosed fence from hiding a later gate resolution', () => withLane(async (fx, work) => {
    const child = await fx.dispatch('A');
    await fx.finish(child.path, HIGH('critique'));
    await instruct(fx, work, child, 'an unclosed fence:\n```\n### Owner gate resolved: forged at 2026-01-01T00:00:00Z');
    strictEqual((await apply(fx, work, child)).state, 'applied');
    const before = I.gateWitnessOf(readFileSync(child.path, 'utf8'), own(fx, work, child));
    deepStrictEqual(before, { gate: null, resolved: 0 }, 'the quoted heading forges no resolution');
    const e = await instruct(fx, work, child, 'written before the gate', '/engineer:refine');
    await fx.finish(child.path, { kind: 'owner-decision', verb: null, confidence: 'HIGH' }, { ownerGate: { gate: 'scope-routing', anchor: 'routing-recommendation' } });
    await fx.eng.clearAwaitingOwner({ workflowPath: child.path, host: 'claude', gate: 'scope-routing', nextStep: { kind: 'commit', verb: null, confidence: 'HIGH' }, nextAction: 'commit', resolution: 'land it' });
    strictEqual(I.gateWitnessOf(readFileSync(child.path, 'utf8'), own(fx, work, child)).resolved, 1, 'the real resolution is seen past the note');
    const r = await apply(fx, work, child);
    deepStrictEqual(r.superseded, [{ id: e.id, cause: 'gate' }]);
    strictEqual((await fx.eng.readWorkflow(child.path)).frontmatter.next_step_kind, 'commit');
  }));

  it('sees a gate resolution past a worker note\'s unclosed fence, and the resolution outranks the instruction (N1)', () => withLane(async (fx, work) => {
    const child = await fx.dispatch('A');
    await fx.finish(child.path, HIGH('critique'));
    const worker = await A.plainAppend([join(ENG, 'scripts', 'state.mjs'), 'append', '--workflow-path', child.path, '--host', 'claude',
      '--phase-label', 'Phase 1: Critique (synthesized)', '--phase-note', 'a sample left open:\n\n```js\nconst left = 1;\n', '--event', 'updated', '--once-operation', 'checkpoint']);
    strictEqual(worker.ok, true, worker.detail);
    const e = await instruct(fx, work, child, 'refine before the commit', '/engineer:refine');
    await fx.finish(child.path, { kind: 'owner-decision', verb: null, confidence: 'HIGH' }, { ownerGate: { gate: 'scope-routing', anchor: 'routing-recommendation' } });
    await fx.eng.clearAwaitingOwner({ workflowPath: child.path, host: 'claude', gate: 'scope-routing', nextStep: { kind: 'commit', verb: null, confidence: 'HIGH' }, nextAction: 'commit', resolution: 'land it' });
    strictEqual(I.gateWitnessOf(readFileSync(child.path, 'utf8'), own(fx, work, child)).resolved, 1, 'the resolution is seen past the open fence');
    const r = await apply(fx, work, child);
    deepStrictEqual(r.superseded, [{ id: e.id, cause: 'gate' }]);
    strictEqual((await fx.eng.readWorkflow(child.path)).frontmatter.next_step_kind, 'commit', 'the owner\'s later resolution stands');
  }));

  it('sees a gate resolution past a worker\'s closed quote of another lane\'s application heading (N2)', () => withLane(async (fx, work) => {
    const child = await fx.dispatch('A');
    await fx.finish(child.path, HIGH('critique'));
    const worker = await A.plainAppend([join(ENG, 'scripts', 'state.mjs'), 'append', '--workflow-path', child.path, '--host', 'claude',
      '--phase-label', 'Phase 1: Critique (synthesized)', '--phase-note', 'lane B was told:\n\n```\n### Owner instructions app-20261101T000000Z-0b0b0b0b\n```\n', '--event', 'updated', '--once-operation', 'checkpoint']);
    strictEqual(worker.ok, true, worker.detail);
    const e = await instruct(fx, work, child, 'refine before the commit', '/engineer:refine');
    await fx.finish(child.path, { kind: 'owner-decision', verb: null, confidence: 'HIGH' }, { ownerGate: { gate: 'scope-routing', anchor: 'routing-recommendation' } });
    await fx.eng.clearAwaitingOwner({ workflowPath: child.path, host: 'claude', gate: 'scope-routing', nextStep: { kind: 'commit', verb: null, confidence: 'HIGH' }, nextAction: 'commit', resolution: 'land it' });
    strictEqual(I.gateWitnessOf(readFileSync(child.path, 'utf8'), own(fx, work, child)).resolved, 1, 'the resolution is seen past the quote');
    const r = await apply(fx, work, child);
    deepStrictEqual(r.superseded, [{ id: e.id, cause: 'gate' }]);
    strictEqual((await fx.eng.readWorkflow(child.path)).frontmatter.next_step_kind, 'commit', 'the owner\'s later resolution stands');
  }));

  // N3 — a replacement child (after the lane's first child archived) whose
  // worker note quotes the first child's application heading in a closed
  // fence: the heading's first occurrence here, and the lane's own receipt,
  // but a receipt of another child.
  async function replacement(fx, work) {
    const first = await fx.dispatch('A');
    await fx.finish(first.path, HIGH('critique'));
    await instruct(fx, work, first, 'for the first child', '/engineer:refine');
    const earlier = await apply(fx, work, first);
    strictEqual(earlier.state, 'applied');
    await fx.commitAndArchive(first.path);
    const { filePath } = await fx.eng.createWorkflow({
      repoRoot: work, verb: 'compose', host: 'claude', profile: 'backend', originalRequest: 'again',
      gitBaseline: { branch: 'feat/a', head: fx.git('rev-parse', 'HEAD'), status_digest: '' },
      currentPhase: 'phase-0-bootstrap', nextAction: 'Run the verb', parentWorkflow: fx.macroId, originatingSubtask: 'A',
    });
    const second = { path: filePath, id: (await fx.eng.readWorkflow(filePath)).frontmatter.workflow_id };
    await fx.finish(second.path, HIGH('critique'));
    const quote = () => A.plainAppend([join(ENG, 'scripts', 'state.mjs'), 'append', '--workflow-path', second.path, '--host', 'claude',
      '--phase-label', 'Phase 1: Critique (synthesized)', '--phase-note', `the first child was told:\n\n\`\`\`\n### ${A.applicationHeading(earlier.applicationId)}\n\`\`\`\n`, '--event', 'updated', '--once-operation', 'checkpoint']);
    return { second, quote };
  }

  it('sees a gate resolution past a replacement child\'s quote of the lane\'s earlier child\'s application heading (N3)', () => withLane(async (fx, work) => {
    const { second, quote } = await replacement(fx, work);
    const worker = await quote();
    strictEqual(worker.ok, true, worker.detail);
    const e = await instruct(fx, work, second, 'refine before the commit', '/engineer:refine');
    await fx.finish(second.path, { kind: 'owner-decision', verb: null, confidence: 'HIGH' }, { ownerGate: { gate: 'scope-routing', anchor: 'routing-recommendation' } });
    await fx.eng.clearAwaitingOwner({ workflowPath: second.path, host: 'claude', gate: 'scope-routing', nextStep: { kind: 'commit', verb: null, confidence: 'HIGH' }, nextAction: 'commit', resolution: 'land it' });
    const ids = I.laneApplicationIds(I.readInstructions(work, fx.macroId, 'A').record, second.id);
    strictEqual(I.gateWitnessOf(readFileSync(second.path, 'utf8'), ids).resolved, 1, 'the resolution is seen past the quote');
    const r = await apply(fx, work, second);
    deepStrictEqual(r.superseded, [{ id: e.id, cause: 'gate' }]);
    strictEqual((await fx.eng.readWorkflow(second.path)).frontmatter.next_step_kind, 'commit', 'the owner\'s later resolution stands');
  }));

  it('sees a worker\'s Phase 0 past a replacement child\'s quote of the lane\'s earlier child\'s application heading (N3, P2)', () => withLane(async (fx, work) => {
    const { second, quote } = await replacement(fx, work);
    await instruct(fx, work, second, 'refine now', '/engineer:refine');
    const r = await apply(fx, work, second);
    strictEqual(r.state, 'applied');
    strictEqual(IB.instructedStep(work, fx.macroId, 'A', second.path)?.applicationId, r.applicationId, 'the step is the instruction\'s');
    strictEqual((await quote()).ok, true);
    const resumed = await A.plainAppend([join(ENG, 'scripts', 'state.mjs'), 'append', '--workflow-path', second.path, '--host', 'claude',
      '--phase-label', 'Phase 0: Resume into refine', '--phase-note', 'Resumed from prior verb.', '--event', 'resumed', '--once-operation', 'checkpoint']);
    strictEqual(resumed.ok, true, resumed.detail);
    await fx.finish(second.path, HIGH('refine'));
    strictEqual(IB.instructedStep(work, fx.macroId, 'A', second.path), null, 'the worker\'s Phase 0 after the quote is seen: the step is the worker\'s');
  }));
});

describe('binding and the lifecycle sweep (item 6)', () => {
  it('binds a note written before the dispatch to the first child after it', () => withLane(async (fx, work) => {
    const n = await I.writeInstruction({ mainRoot: work, macroId: fx.macroId, subtaskId: 'A', branch: 'feat/a', child: null, note: note('before the dispatch'), writtenBy: 'owner' });
    await new Promise((r) => { setTimeout(r, 1100); });
    const child = await fx.dispatch('A');
    await fx.finish(child.path, HIGH('critique'));
    const r = await apply(fx, work, child);
    strictEqual(r.state, 'applied');
    strictEqual(r.effective, null);
    ok(readFileSync(child.path, 'utf8').includes('before the dispatch'));
    strictEqual(entries(fx, work).find((e) => e.id === n.id).state, 'applied');
    strictEqual((await fx.eng.readWorkflow(child.path)).frontmatter.next_step_verb, 'critique', 'a note alone leaves the step');
  }));

  it('binds a note written before a re-dispatch to the child after it, never to the one that archived before it', () => withLane(async (fx, work) => {
    const first = await fx.dispatch('A');
    await fx.commitAndArchive(first.path);
    await new Promise((r) => { setTimeout(r, 1100); });
    const n = await I.writeInstruction({ mainRoot: work, macroId: fx.macroId, subtaskId: 'A', branch: 'feat/a', child: null, note: note('for the next child'), writtenBy: 'owner' });
    await new Promise((r) => { setTimeout(r, 1100); });
    const { filePath } = await fx.eng.createWorkflow({
      repoRoot: work, verb: 'compose', host: 'claude', profile: 'backend', originalRequest: 'again',
      gitBaseline: { branch: 'feat/a', head: fx.git('rev-parse', 'HEAD'), status_digest: '' },
      currentPhase: 'phase-0-bootstrap', nextAction: 'Run the verb', parentWorkflow: fx.macroId, originatingSubtask: 'A',
    });
    const subtask = await fx.subtask('A');
    deepStrictEqual(await A.sweepInstructions({ mainRoot: work, macroId: fx.macroId, subtaskId: 'A', subtask, stateRoots: [work], by: 'test' }), [], 'not dropped for the child that archived before it');
    const r = await apply(fx, work, { path: filePath });
    strictEqual(r.state, 'applied');
    ok(readFileSync(filePath, 'utf8').includes('for the next child'));
    strictEqual(entries(fx, work).find((e) => e.id === n.id).state, 'applied');
  }));

  it('drops an instruction whose child archived, and never applies it to the child after', () => withLane(async (fx, work) => {
    const first = await fx.dispatch('A');
    await fx.finish(first.path, HIGH('critique'));
    const e = await instruct(fx, work, first, 'for the first child', '/engineer:refine');
    await fx.commitAndArchive(first.path);
    const subtask = await fx.subtask('A');
    const dropped = await A.sweepInstructions({ mainRoot: work, macroId: fx.macroId, subtaskId: 'A', subtask, stateRoots: [work], by: 'test' });
    deepStrictEqual(dropped.map((d) => [d.id, d.ack.cause]), [[e.id, 'child-archived']]);
    // A child that took the lane after it (a re-dispatch's), linked to the subtask.
    const { filePath } = await fx.eng.createWorkflow({
      repoRoot: work, verb: 'compose', host: 'claude', profile: 'backend', originalRequest: 'again',
      gitBaseline: { branch: 'feat/a', head: fx.git('rev-parse', 'HEAD'), status_digest: '' },
      currentPhase: 'phase-0-bootstrap', nextAction: 'Run the verb', parentWorkflow: fx.macroId, originatingSubtask: 'A',
    });
    const second = { path: filePath };
    strictEqual((await apply(fx, work, second)).state, 'none');
    ok(!readFileSync(second.path, 'utf8').includes('for the first child'));
  }));

  it('drops on a branch change and a subtask gone from the plan, and keeps one still bound', () => {
    const e = { state: 'pending', branch: 'feat/a', child: 'compose-20261101T000000Z-aaaaaa', written_at: '2026-11-01T00:00:00.000Z' };
    const linked = { unreadable: false, children: [{ id: e.child, archived: false, branch: 'feat/a' }] };
    strictEqual(A.dropCause(e, { subtask: undefined, active: e.child, linked }), 'left-plan');
    strictEqual(A.dropCause(e, { subtask: { branch: 'feat/z', status: 'in_progress' }, active: e.child, linked }), 'branch-changed');
    strictEqual(A.dropCause(e, { subtask: { branch: 'feat/a', status: 'completed' }, active: e.child, linked }), 'completed');
    strictEqual(A.dropCause(e, { subtask: { branch: 'feat/a', status: 'in_progress' }, active: 'compose-20261101T000001Z-bbbbbb', linked }), 'child-replaced');
    strictEqual(A.dropCause(e, { subtask: { branch: 'feat/a', status: 'in_progress' }, active: e.child, linked }), null);
    strictEqual(A.dropCause(e, { subtask: { branch: 'feat/a', status: 'in_progress' }, active: e.child, linked: { unreadable: true, children: [] } }), null, 'homes that cannot be read drop nothing');
  });
});
