// tests/orchestrator/test-instructions-records.mjs
//
// ADR-0068 Decision 7 (impl-instruct) — the instructions record
// (plugins/orchestrator/scripts/lib/instructions.mjs): the step grammar, held
// equal to policy.mjs's forced steps less the dispatch and the rerun; the
// note's bounds as the engineer's --phase-note-file reads it; the record's
// order, revisions, withdrawals and drops, with each refusal; readers that
// answer with a code and never an excerpt of the note; the gate witness; and
// the wake digest.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const LIB = join(REPO_ROOT, 'plugins/orchestrator/scripts/lib');
const I = await import(pathToFileURL(join(LIB, 'instructions.mjs')).href);
const POLICY = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/policy.mjs')).href);

const MACRO = 'macro-plan-20261019T084450Z-b66aaa';
const SECRET = 'the owner said: ship the thing on Tuesday';

function main() {
  return mkdtempSync(join(tmpdir(), 'instr-rec-'));
}

const note = (text) => {
  const n = I.checkNoteBytes(Buffer.from(text, 'utf8'));
  if (!n.ok) throw new Error(`fixture note refused: ${n.code}`);
  return n;
};

const write = (root, extra = {}) => I.writeInstruction({
  mainRoot: root, macroId: MACRO, subtaskId: 'impl-a', branch: 'feat/a', child: 'compose-20261101T000000Z-aaaaaa',
  step: null, note: note(SECRET), witness: { gate: null, resolved: 0 }, writtenBy: 'owner', ...extra,
});

describe('the step an instruction names', () => {
  it('takes /engineer:<verb> and /engineer:commit, as a forced step takes them', () => {
    deepStrictEqual([...I.STEP_VERBS], [...POLICY.VERBS]);
    for (const verb of [...POLICY.VERBS, 'commit']) {
      const text = `/engineer:${verb}`;
      const p = I.parseInstructionStep(`  ${text} `);
      strictEqual(p.ok, true, text);
      strictEqual(p.step, text);
      const forced = POLICY.parseForcedStep(text);
      strictEqual(p.kind, forced.kind, text);
      strictEqual(p.verb, forced.verb, text);
    }
  });

  it('refuses a dispatch, a rerun and anything malformed, each with its own code', () => {
    strictEqual(I.parseInstructionStep('/orchestrator:next').code, 'dispatch');
    strictEqual(I.parseInstructionStep('/orchestrator:next impl-a').code, 'dispatch');
    strictEqual(I.parseInstructionStep('verify').code, 'verify');
    for (const bad of ['/engineer:ship', '/engineer:compose now', 'engineer:compose', '', '/engineer:', '/designer:compose', null]) {
      strictEqual(I.parseInstructionStep(bad).ok, false, String(bad));
      strictEqual(I.parseInstructionStep(bad).code, 'not-a-step', String(bad));
    }
    // A step the forced-step grammar takes and an instruction does not.
    ok(POLICY.parseForcedStep('verify'));
    ok(POLICY.parseForcedStep('/orchestrator:next'));
  });
});

describe('the note', () => {
  it('is read as the engineer reads a phase-note file: one trailing newline removed', () => {
    strictEqual(I.checkNoteBytes(Buffer.from('a\n\n')).note, 'a\n');
    strictEqual(I.checkNoteBytes(Buffer.from('a\r\n')).note, 'a');
    strictEqual(I.checkNoteBytes(Buffer.from('a')).note, 'a');
    strictEqual(I.checkNoteBytes(Buffer.from('é\n')).sha256.length, 64);
  });

  it('refuses bytes that are no UTF-8, a NUL, a blank note and one past the bound', () => {
    strictEqual(I.checkNoteBytes(Buffer.from([0x61, 0xff, 0x62])).code, 'utf8');
    strictEqual(I.checkNoteBytes(Buffer.from('a\0b')).code, 'nul');
    strictEqual(I.checkNoteBytes(Buffer.from(' \n\t\n')).code, 'blank');
    strictEqual(I.checkNoteBytes(Buffer.alloc(I.NOTE_MAX_BYTES, 0x61)).ok, true);
    strictEqual(I.checkNoteBytes(Buffer.alloc(I.NOTE_MAX_BYTES + 1, 0x61)).code, 'too-large');
  });

  it('reads a file by its raw bytes and neither waits on a FIFO nor reads a missing file', () => {
    const dir = main();
    try {
      writeFileSync(join(dir, 'bad.md'), Buffer.from([0x61, 0xc3, 0x28]));
      strictEqual(I.readNoteFile(join(dir, 'bad.md')).code, 'utf8');
      writeFileSync(join(dir, 'ok.md'), `${SECRET}\n`);
      strictEqual(I.readNoteFile(join(dir, 'ok.md')).note, SECRET);
      strictEqual(I.readNoteFile(join(dir, 'missing.md')).code, 'unreadable');
      writeFileSync(join(dir, 'big.md'), Buffer.alloc(I.NOTE_MAX_BYTES + 2, 0x61));
      strictEqual(I.readNoteFile(join(dir, 'big.md')).code, 'too-large');
      if (process.platform !== 'win32') {
        execFileSync('mkfifo', [join(dir, 'fifo')]);
        strictEqual(I.readNoteFile(join(dir, 'fifo')).code, 'unreadable');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the record', () => {
  it('keeps several instructions in the order they were written, beside the holds', async () => {
    const root = main();
    try {
      const a = await write(root);
      const b = await write(root, { step: '/engineer:refine' });
      const c = await write(root, { child: null });
      const r = I.readInstructions(root, MACRO, 'impl-a');
      strictEqual(r.state, 'ok');
      deepStrictEqual(r.record.entries.map((e) => e.id), [a.id, b.id, c.id]);
      deepStrictEqual(r.record.entries.map((e) => e.state), ['pending', 'pending', 'pending']);
      strictEqual(r.path, join(root, '.agentic-plugins/runs/autopilot/holds', MACRO, 'instructions', 'impl-a.json'));
      strictEqual(I.pendingStep(r.record).id, b.id);
      strictEqual(a.revision, 1);
      strictEqual(a.note, SECRET);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('revises a pending instruction in its place, and refuses a revision that is no longer current', async () => {
    const root = main();
    try {
      const a = await write(root);
      const b = await write(root);
      const r2 = await write(root, { step: '/engineer:critique', revises: { id: a.id, revision: 1 } });
      strictEqual(r2.id, a.id);
      strictEqual(r2.revision, 2);
      const r = I.readInstructions(root, MACRO, 'impl-a').record;
      deepStrictEqual(r.entries.map((e) => [e.id, e.revision]), [[a.id, 2], [b.id, 1]]);
      strictEqual(r.entries[0].step, '/engineer:critique');
      // Revision 1 was superseded by revision 2: a revision of it is refused.
      await rejects(write(root, { revises: { id: a.id, revision: 1 } }), (e) => e.code === 'stale-revision');
      await rejects(write(root, { revises: { id: 'f'.repeat(16), revision: 1 } }), (e) => e.code === 'unknown');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('withdraws a pending instruction, and an ended one is final: neither revised nor withdrawn', async () => {
    const root = main();
    try {
      const a = await write(root);
      const w = await I.withdrawInstruction({ mainRoot: root, macroId: MACRO, subtaskId: 'impl-a', id: a.id, by: 'owner' });
      strictEqual(w.state, 'withdrawn');
      await rejects(I.withdrawInstruction({ mainRoot: root, macroId: MACRO, subtaskId: 'impl-a', id: a.id, by: 'owner' }), (e) => e.code === 'refused-withdraw');
      await rejects(write(root, { revises: { id: a.id, revision: 1 } }), (e) => e.code === 'refused-revise' && /final/.test(e.message));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to revise or withdraw an instruction being applied, and an applied one', async () => {
    const root = main();
    try {
      const a = await write(root);
      const b = await write(root);
      const file = I.instructionsPath(root, MACRO, 'impl-a');
      const rec = JSON.parse(readFileSync(file, 'utf8'));
      rec.entries[0] = { ...rec.entries[0], state: 'applying', receipt: 'app-1' };
      rec.entries[1] = { ...rec.entries[1], state: 'applied', ack: { at: new Date().toISOString(), by: 'run', cause: null, application_id: 'app-0', replaced_step: null } };
      writeFileSync(file, JSON.stringify(rec));
      strictEqual(I.readInstructions(root, MACRO, 'impl-a').state, 'ok');
      await rejects(write(root, { revises: { id: a.id, revision: 1 } }), (e) => e.code === 'refused-revise' && /being applied/.test(e.message));
      await rejects(I.withdrawInstruction({ mainRoot: root, macroId: MACRO, subtaskId: 'impl-a', id: a.id, by: 'owner' }), (e) => e.code === 'refused-withdraw');
      await rejects(write(root, { revises: { id: b.id, revision: 1 } }), (e) => e.code === 'refused-revise' && /applied, which is final/.test(e.message));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops pending instructions with their cause, and leaves one being applied to its receipt', async () => {
    const root = main();
    try {
      const a = await write(root);
      await write(root);
      const file = I.instructionsPath(root, MACRO, 'impl-a');
      const rec = JSON.parse(readFileSync(file, 'utf8'));
      rec.entries[1] = { ...rec.entries[1], state: 'applying', receipt: 'app-1' };
      writeFileSync(file, JSON.stringify(rec));
      const dropped = await I.dropInstructions({ mainRoot: root, macroId: MACRO, subtaskId: 'impl-a', cause: () => 'child-archived', by: 'run' });
      deepStrictEqual(dropped.map((e) => e.id), [a.id]);
      const after = I.readInstructions(root, MACRO, 'impl-a').record.entries;
      deepStrictEqual(after.map((e) => e.state), ['dropped', 'applying']);
      strictEqual(after[0].ack.cause, 'child-archived');
      // No record: nothing written, no directory made.
      const empty = main();
      deepStrictEqual(await I.dropInstructions({ mainRoot: empty, macroId: MACRO, subtaskId: 'impl-a', cause: () => 'completed', by: 'done' }), []);
      strictEqual(I.listInstructionIds(empty, MACRO).state, 'absent');
      rmSync(empty, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('answers a record it cannot read with a code and no byte of the note (P11)', async () => {
    const root = main();
    try {
      const file = I.instructionsPath(root, MACRO, 'impl-a');
      mkdirSync(dirname(file), { recursive: true });
      // JSON.parse's message quotes the text it failed on ("Unexpected token
      // 'T', "Tuesday: t"... is not valid JSON"): none of it may surface.
      writeFileSync(file, `Tuesday: ${SECRET}`);
      const r = I.readInstructions(root, MACRO, 'impl-a');
      strictEqual(r.state, 'unreadable');
      strictEqual(r.code, 'parse');
      ok(!JSON.stringify(r).includes('Tuesday'), JSON.stringify(r));
      await rejects(write(root), (e) => e.code === 'unreadable' && !e.message.includes('Tuesday'));
      // A record whose note no longer matches its digest is no record.
      const good = main();
      await write(good);
      const f2 = I.instructionsPath(good, MACRO, 'impl-a');
      const rec = JSON.parse(readFileSync(f2, 'utf8'));
      rec.entries[0].note = `${SECRET}!`;
      writeFileSync(f2, JSON.stringify(rec));
      deepStrictEqual(I.readInstructions(good, MACRO, 'impl-a').code, 'schema');
      rmSync(good, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a step outside the grammar at the write', async () => {
    const root = main();
    try {
      await rejects(write(root, { step: '/orchestrator:next' }), (e) => e.code === 'step');
      await rejects(write(root, { step: '/engineer:ship' }), (e) => e.code === 'step');
      strictEqual(I.readInstructions(root, MACRO, 'impl-a').state, 'absent');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('changes the wake digest at every write the owner makes, a write, a revision and a withdrawal', async () => {
    const root = main();
    try {
      const d0 = I.instructionsDigest(root, MACRO);
      const a = await write(root);
      const d1 = I.instructionsDigest(root, MACRO);
      await write(root, { revises: { id: a.id, revision: 1 } });
      const d2 = I.instructionsDigest(root, MACRO);
      await I.withdrawInstruction({ mainRoot: root, macroId: MACRO, subtaskId: 'impl-a', id: a.id, by: 'owner' });
      const d3 = I.instructionsDigest(root, MACRO);
      strictEqual(new Set([d0, d1, d2, d3]).size, 4);
      strictEqual(I.instructionsDigest(root, MACRO), d3);
      // A hand edit the readers refuse, its ids and revisions kept (a note
      // that no longer matches its sha256), wakes, and so does its repair
      // (the refine-verify peer's MINOR).
      const file = I.instructionsPath(root, MACRO, 'impl-a');
      const good = readFileSync(file, 'utf8');
      writeFileSync(file, good.replace(SECRET, 'the owner said: ship the thing on Friday'));
      strictEqual(I.readInstructions(root, MACRO, 'impl-a').state, 'unreadable');
      const bad = I.instructionsDigest(root, MACRO);
      ok(bad !== d3, 'the corruption wakes');
      writeFileSync(file, good);
      strictEqual(I.readInstructions(root, MACRO, 'impl-a').state, 'ok');
      strictEqual(I.instructionsDigest(root, MACRO), d3, 'the repair wakes, back to the record as it was');
      // A record that turns unreadable, or a hand edit that no longer
      // parses, wakes too.
      writeFileSync(I.instructionsPath(root, MACRO, 'impl-a'), '{"entries": [');
      ok(I.instructionsDigest(root, MACRO) !== d3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves the wake digest as it was at a run\'s own writes: a reservation, its receipt, its rollback, an application and a drop (critique 7 F1)', async () => {
    const root = main();
    try {
      const a = await write(root);
      const b = await write(root, { subtaskId: 'impl-b', branch: 'feat/b' });
      const d = I.instructionsDigest(root, MACRO);
      const set = (id, fn) => I.updateInstructions(root, MACRO, id, async (r) => ({ record: fn(r) }));
      const receipt = (state) => ({ application_id: 'app-1', state, child: 'compose-20261101T000000Z-aaaaaa', entries: [{ id: a.id, revision: 1 }] });
      await set('impl-a', (r) => ({ ...r, entries: r.entries.map((e) => ({ ...e, state: 'applying', receipt: 'app-1' })), receipts: [receipt('reserved')] }));
      strictEqual(I.readInstructions(root, MACRO, 'impl-a').state, 'ok', 'the fixture writes records the readers take, as a run does');
      strictEqual(I.instructionsDigest(root, MACRO), d, 'a reservation');
      await set('impl-a', (r) => ({ ...r, entries: r.entries.map(({ receipt: _, ...e }) => ({ ...e, state: 'pending' })), receipts: [receipt('rolled-back')] }));
      strictEqual(I.instructionsDigest(root, MACRO), d, 'a rollback and its receipt');
      await set('impl-a', (r) => ({ ...r, entries: r.entries.map((e) => ({ ...e, state: 'applied', ack: { at: '2026-11-02T00:00:00.000Z', by: 'run', cause: null, application_id: 'app-2', replaced_step: null } })), receipts: [...r.receipts, { ...receipt('done'), application_id: 'app-2' }] }));
      strictEqual(I.readInstructions(root, MACRO, 'impl-a').state, 'ok');
      strictEqual(I.instructionsDigest(root, MACRO), d, 'an application');
      await I.dropInstructions({ mainRoot: root, macroId: MACRO, subtaskId: 'impl-b', cause: () => 'child-archived', by: 'run' });
      strictEqual(I.readInstructions(root, MACRO, 'impl-b').record.entries[0].state, 'dropped');
      strictEqual(I.instructionsDigest(root, MACRO), d, 'a drop');
      ok(b.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('wakes the poll after a pass for an owner write that landed while the pass ran, after it read what was due (critique 7 F1)', async () => {
    const IB = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/instruct-boundary.mjs')).href);
    const root = main();
    try {
      const watch = IB.instructionsWatch(() => I.instructionsDigest(root, MACRO));
      strictEqual(watch.poll(), false);
      // A pass: it reads the records, then what is due; the owner writes
      // while it applies another lane's instructions; it ends.
      let end = watch.begin();
      await write(root);
      end();
      strictEqual(watch.poll(), true, 'the write during the pass wakes the next poll');
      strictEqual(watch.poll(), false, 'once');
      // A write before the pass is what the pass acted on: no wake after it.
      const a = await write(root);
      end = watch.begin();
      end();
      strictEqual(watch.poll(), false, 'a write the pass read is seen');
      // A poll during the pass that took a later digest is left as it is.
      end = watch.begin();
      await I.withdrawInstruction({ mainRoot: root, macroId: MACRO, subtaskId: 'impl-a', id: a.id, by: 'owner' });
      strictEqual(watch.poll(), true);
      end();
      strictEqual(watch.poll(), false, 'the pass\'s end does not take back what the poll saw');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('tells the run\'s end of an owner write since the last pass read the records, a poll that took it as seen included, once (critique 8 F1)', async () => {
    const IB = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/instruct-boundary.mjs')).href);
    const root = main();
    try {
      const watch = IB.instructionsWatch(() => I.instructionsDigest(root, MACRO));
      strictEqual(watch.sincePass(), false, 'nothing written');
      // A write the pass read at its start is what it acted on.
      const a = await write(root);
      watch.begin()();
      strictEqual(watch.sincePass(), false, 'a write the pass read');
      // A write after the pass, which a tick's poll then takes as seen: the
      // end is still told, and only once.
      watch.begin()();
      await I.withdrawInstruction({ mainRoot: root, macroId: MACRO, subtaskId: 'impl-a', id: a.id, by: 'owner' });
      strictEqual(watch.poll(), true, 'the tick saw the write');
      strictEqual(watch.sincePass(), true, 'the end is told of it though the poll took it as seen');
      strictEqual(watch.sincePass(), false, 'once');
      // A pass that begins after the write has read it.
      await write(root);
      watch.begin()();
      strictEqual(watch.sincePass(), false, 'the next pass read it');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('tells a step\'s admission of an instruction pending on a record no application attempt met, once per record (critique 9 F1)', async () => {
    const IB = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/instruct-boundary.mjs')).href);
    const root = main();
    try {
      const untried = IB.admissionRecheck(root, MACRO);
      strictEqual(untried('impl-a', null), false, 'no record');
      // Written after the lane's last attempt (none): the step yields, once.
      const a = await write(root, { step: '/engineer:refine' });
      strictEqual(untried('impl-a', null), true, 'a pending instruction no attempt met');
      strictEqual(untried('impl-a', null), false, 'once per record');
      // The record an attempt met is the one the run decided beside.
      const met = IB.instructionsKey(root, MACRO, 'impl-a');
      const fresh = IB.admissionRecheck(root, MACRO);
      strictEqual(fresh('impl-a', met), false, 'the record the last attempt met');
      // Another write since that attempt yields again.
      const b = await write(root);
      strictEqual(fresh('impl-a', met), true, 'a write since the attempt');
      strictEqual(fresh('impl-b', null), false, 'another subtask with no record');
      strictEqual(fresh(null, null), false, 'a step of no subtask');
      // Nothing pending: nothing to wait for, whatever the attempt met.
      await I.withdrawInstruction({ mainRoot: root, macroId: MACRO, subtaskId: 'impl-a', id: a.id, by: 'owner' });
      await I.withdrawInstruction({ mainRoot: root, macroId: MACRO, subtaskId: 'impl-a', id: b.id, by: 'owner' });
      strictEqual(IB.admissionRecheck(root, MACRO)('impl-a', null), false, 'every entry withdrawn');
      // A record that cannot be read may hold one: as the due list counts it.
      writeFileSync(I.instructionsPath(root, MACRO, 'impl-a'), '{ not json');
      strictEqual(IB.admissionRecheck(root, MACRO)('impl-a', null), true, 'an unreadable record');
      strictEqual(IB.admissionRecheck(root, MACRO)('impl-a', 'unreadable'), false, 'the unreadable record the attempt met');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the due list', () => {
  it('names a subtask the plan no longer holds, so the sweep drops its instructions', async () => {
    const IB = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/instruct-boundary.mjs')).href);
    const root = main();
    try {
      await write(root);
      deepStrictEqual(IB.instructionsDue(root, MACRO, [{ id: 'impl-z' }]).map((x) => x.subtaskId), ['impl-a']);
      deepStrictEqual(IB.instructionsDue(root, MACRO, [{ id: 'impl-a' }]).map((x) => x.subtaskId), ['impl-a']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names every open subtask of the plan, unreadable, when the instructions directory cannot be listed (M2)', async () => {
    const IB = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/instruct-boundary.mjs')).href);
    const root = main();
    try {
      await write(root);
      const dir = I.instructionsDir(root, MACRO);
      rmSync(dir, { recursive: true, force: true });
      writeFileSync(dir, 'not a directory\n');
      strictEqual(I.listInstructionIds(root, MACRO).state, 'unreadable');
      // Which lanes have one cannot be told: none skipped, so no lane's old
      // step runs over what the directory holds; a closed subtask has no lane.
      const plan = [{ id: 'impl-a' }, { id: 'impl-b', status: 'completed' }, { id: 'impl-c', status: 'pending' }, { id: 'impl-d', status: 'deferred' }];
      deepStrictEqual(IB.instructionsDue(root, MACRO, plan), [
        { subtaskId: 'impl-a', step: null, unreadable: true },
        { subtaskId: 'impl-c', step: null, unreadable: true },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the transitions', () => {
  it('moves only as the table says, and an ended instruction is final', () => {
    deepStrictEqual(I.instructionTransition('pending', 'reserve'), { to: 'applying' });
    deepStrictEqual(I.instructionTransition('applying', 'rollback'), { to: 'pending' });
    deepStrictEqual(I.instructionTransition('applying', 'apply'), { to: 'applied' });
    deepStrictEqual(I.instructionTransition('applying', 'supersede'), { to: 'superseded' });
    ok(I.instructionTransition('applying', 'drop').refused);
    for (const s of I.FINAL_STATES) for (const e of ['revise', 'withdraw', 'reserve', 'drop']) ok(I.instructionTransition(s, e).refused, `${s} ${e}`);
  });
});

describe('the gate witness', () => {
  const child = (gate, body) => `---\nworkflow_id: "w"\n${gate ? `awaiting_owner_gate: "${gate}"\n` : ''}---\n\n${body}`;

  it('reads the gate set and counts the resolutions outside the owner\'s notes', () => {
    deepStrictEqual(I.gateWitnessOf(child(null, '')), { gate: null, resolved: 0 });
    deepStrictEqual(I.gateWitnessOf(child('scope-routing', '')), { gate: 'scope-routing', resolved: 0 });
    // A worker's fenced quote that is not the heading's whole shape, and an
    // owner's note quoting the whole heading, count for nothing.
    const body = '### Owner gate resolved: scope-routing at 2026-11-01T10:00:00Z\n\ntext\n\n```\n### Owner gate resolved: quoted\n```\n\n'
      + '### Owner instructions app-20261101T000000Z-0a0b0c0d\n\n#### Instruction i r1 — applied\n\n```text\n### Owner gate resolved: forged at 2026-11-01T10:30:00Z\n```\n\n'
      + '### Owner gate resolved: pr-handling at 2026-11-01T11:00:00Z\n';
    const own = new Set(['app-20261101T000000Z-0a0b0c0d']);
    deepStrictEqual(I.gateWitnessOf(child(null, body), own), { gate: null, resolved: 2 });
    strictEqual(I.gateWitnessOf('no frontmatter'), null);
    ok(I.witnessChanged({ gate: null, resolved: 0 }, { gate: null, resolved: 1 }));
    ok(I.witnessChanged({ gate: null, resolved: 0 }, { gate: 'pr-handling', resolved: 0 }));
    ok(!I.witnessChanged({ gate: null, resolved: 1 }, { gate: null, resolved: 1 }));
  });

  it('counts a resolution past an unclosed fence in a worker\'s note (N1)', () => {
    const worker = '### Phase 1: Critique (synthesized)\n\n```js\nconst left = "unclosed";\n\n';
    const resolution = '### Owner gate resolved: scope-routing at 2026-11-01T10:00:00Z\n\nland it\n';
    deepStrictEqual(I.gateWitnessOf(child(null, worker)), { gate: null, resolved: 0 });
    deepStrictEqual(I.gateWitnessOf(child(null, `${worker}${resolution}`)), { gate: null, resolved: 1 });
    // Past an application's note too, whose own fences are closed.
    const app = '### Owner instructions app-20261101T000000Z-0a0b0c0d\n\n#### Instruction i r1 — applied\n\n````text\n```\n````\n\n';
    deepStrictEqual(I.gateWitnessOf(child(null, `${app}${worker}${resolution}`), new Set(['app-20261101T000000Z-0a0b0c0d'])), { gate: null, resolved: 1 });
  });

  it('takes a heading of the application\'s shape for the owner\'s note only when the lane\'s record names its id (N2)', () => {
    // A worker's closed fence quoting another lane's application heading:
    // the heading's first occurrence in this child, but no note of its lane.
    const worker = '### Phase 1: Critique (synthesized)\n\nlane B wrote:\n\n```\n### Owner instructions app-20261101T000000Z-0b0b0b0b\n```\n\n';
    const resolution = '### Owner gate resolved: scope-routing at 2026-11-01T10:00:00Z\n';
    const own = new Set(['app-20261101T000000Z-0a0b0c0d']);
    deepStrictEqual(I.gateWitnessOf(child(null, `${worker}${resolution}`), own), { gate: null, resolved: 1 });
    deepStrictEqual([...I.linesOutsideApplications(`${worker}${resolution}`, 0, own)].filter((l) => l.startsWith('### ')), [
      '### Phase 1: Critique (synthesized)', '### Owner instructions app-20261101T000000Z-0b0b0b0b', '### Owner gate resolved: scope-routing at 2026-11-01T10:00:00Z',
    ]);
    deepStrictEqual([...I.laneApplicationIds({ receipts: [{ application_id: 'app-20261101T000000Z-0a0b0c0d', child: 'c1', state: 'done' }, { application_id: 7, child: 'c1', state: 'done' }, null] }, 'c1')], ['app-20261101T000000Z-0a0b0c0d']);
    strictEqual(I.laneApplicationIds(null, 'c1').size, 0);
  });

  it('takes only the receipts of the child being read for its owner\'s notes (N3)', () => {
    // The lane's earlier child's application, quoted in a worker's closed
    // fence in its replacement: the heading's first occurrence here, but no
    // note of this child's.
    const record = { receipts: [
      { application_id: 'app-20261101T000000Z-0a0b0c0d', child: 'first', state: 'done' },
      { application_id: 'app-20261101T000001Z-0a0b0c0e', child: 'second', state: 'done' },
    ] };
    deepStrictEqual([...I.laneApplicationIds(record, 'second')], ['app-20261101T000001Z-0a0b0c0e']);
    deepStrictEqual([...I.laneApplicationIds(record, 'first')], ['app-20261101T000000Z-0a0b0c0d']);
    strictEqual(I.laneApplicationIds(record, null).size, 0, 'no child, no owner\'s notes');
    strictEqual(I.laneApplicationIds(record, '').size, 0);
    const worker = '### Phase 1: Critique (synthesized)\n\nthe first child was told:\n\n```\n### Owner instructions app-20261101T000000Z-0a0b0c0d\n```\n\n';
    const resolution = '### Owner gate resolved: scope-routing at 2026-11-01T10:00:00Z\n';
    deepStrictEqual(I.gateWitnessOf(child(null, `${worker}${resolution}`), I.laneApplicationIds(record, 'second')), { gate: null, resolved: 1 });
  });

  it('takes a rolled-back receipt\'s heading for a quote: only one that may have written its note is the owner\'s (N3)', () => {
    // A rolled-back receipt ended on proof that its child held no heading:
    // one there later quotes it. A reserved one may have written (a crash).
    const record = { receipts: [
      { application_id: 'app-20261101T000000Z-0a0b0c0d', child: 'c1', state: 'rolled-back' },
      { application_id: 'app-20261101T000001Z-0a0b0c0e', child: 'c1', state: 'reserved' },
      { application_id: 'app-20261101T000002Z-0a0b0c0f', child: 'c1', state: 'done' },
      { application_id: 'app-20261101T000003Z-0a0b0c10', child: 'c1', state: 'unknown' },
    ] };
    deepStrictEqual([...I.laneApplicationIds(record, 'c1')], ['app-20261101T000001Z-0a0b0c0e', 'app-20261101T000002Z-0a0b0c0f']);
    const worker = '### Phase 1: Critique (synthesized)\n\nthe failed append was:\n\n```\n### Owner instructions app-20261101T000000Z-0a0b0c0d\n```\n\n';
    const resolution = '### Owner gate resolved: scope-routing at 2026-11-01T10:00:00Z\n';
    deepStrictEqual(I.gateWitnessOf(child(null, `${worker}${resolution}`), I.laneApplicationIds(record, 'c1')), { gate: null, resolved: 1 });
  });
});

describe('retirement (Decision 7, item 6)', async () => {
  const OPS = await import(pathToFileURL(join(LIB, 'hold-ops.mjs')).href);

  it('done drops what no boundary applied, for a subtask with no other record, and leaves one being applied', async () => {
    const root = main();
    try {
      const a = await write(root);
      await write(root, { step: '/engineer:commit' });
      const file = I.instructionsPath(root, MACRO, 'impl-a');
      const rec = JSON.parse(readFileSync(file, 'utf8'));
      rec.entries[1] = { ...rec.entries[1], state: 'applying', receipt: 'app-1' };
      writeFileSync(file, JSON.stringify(rec));
      const r = await OPS.retireSubtaskHolds({ mainRoot: root, macroId: MACRO, subtaskId: 'impl-a', branch: 'feat/a', stateRoots: [root] });
      deepStrictEqual(r.instructionsDropped, [a.id]);
      const after = I.readInstructions(root, MACRO, 'impl-a').record.entries;
      deepStrictEqual(after.map((e) => [e.state, e.ack?.cause ?? null]), [['dropped', 'completed'], ['applying', null]]);
      // A plan that no longer records it completed drops nothing.
      const other = main();
      await write(other);
      const kept = await OPS.retireSubtaskHolds({ mainRoot: other, macroId: MACRO, subtaskId: 'impl-a', branch: 'feat/a', stateRoots: [other], stillCompleted: async () => false });
      strictEqual(kept.instructionsDropped, undefined);
      strictEqual(I.readInstructions(other, MACRO, 'impl-a').record.entries[0].state, 'pending');
      rmSync(other, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the macro\'s end drops every pending instruction and names each in its summary', async () => {
    const root = main();
    try {
      const a = await write(root);
      const b = await I.writeInstruction({
        mainRoot: root, macroId: MACRO, subtaskId: 'impl-b', branch: 'feat/b', child: null, note: note('later'), writtenBy: 'owner',
      });
      const r = await OPS.retireMacroHolds({ mainRoot: root, macroId: MACRO, subtasks: [], stateRoots: [root] });
      strictEqual(r.state, 'retired');
      deepStrictEqual(r.instructionsDropped.map((d) => [d.subtask_id, d.id, d.cause]), [['impl-a', a.id, 'macro-ended'], ['impl-b', b.id, 'macro-ended']]);
      strictEqual(I.listInstructionIds(root, MACRO).state, 'absent', 'the records went with the directory');
      // ...and their outcomes stay, for status and the ending run's halt.json.
      const IB = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/instruct-boundary.mjs')).href);
      deepStrictEqual(IB.instructionsSummary(root, MACRO).map((e) => [e.subtask_id, e.id, e.state, e.cause]), [['impl-a', a.id, 'dropped', 'macro-ended'], ['impl-b', b.id, 'dropped', 'macro-ended']]);
      ok(!JSON.stringify(IB.instructionsSummary(root, MACRO)).includes('Tuesday'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
