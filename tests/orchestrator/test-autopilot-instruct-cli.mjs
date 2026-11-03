// tests/orchestrator/test-autopilot-instruct-cli.mjs
//
// ADR-0068 Decision 7, item 2 (impl-instruct) — the owner's `instruct`
// command through `agentic-autopilot` (cli.mjs, instruct-cli.mjs): an
// instruction written for an idle child and for a subtask before its dispatch,
// revised and withdrawn; each refusal (a worker, a malformed step, a dispatch
// as a step, a subtask not in the plan or closed, an ended macro, an archived
// child, a step with no child, a step for a gated child); the note never
// printed; the warning beside a live run that does not apply instructions;
// and an application that waits where a read cannot know (a workflow file or
// the lane's child that does not parse, worktrees git cannot list).

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeRepo, ORCH, ENG, RUNTIME } from './fixtures/autopilot-repo.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const C = await import(pathToFileURL(join(AP, 'cli.mjs')).href);
const I = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/instructions.mjs')).href);
const RL = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/run-locks.mjs')).href);
const H = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/holds.mjs')).href);
const EV = await import(pathToFileURL(join(AP, 'events.mjs')).href);

// The hold-aware engineer on both hosts, as `hold` needs it (Decision 7,
// item 9: an instruction is applied only where the lane's operations are
// visible).
function fakeEngineer(dir) {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'state.mjs'), "if (process.argv[2] === 'hold-capability') console.log(JSON.stringify({ capability: 'hold-persona-1', protocol: 1 })); else process.exit(2);\n");
}
function withCaches(fx, env) {
  const home = join(fx.dir, 'home');
  mkdirSync(home, { recursive: true });
  fakeEngineer(join(home, '.claude/plugins/cache/agentic-plugins/engineer/0.33.0'));
  fakeEngineer(join(home, '.codex/plugins/cache/agentic-plugins/engineer/0.33.0'));
  const e = { ...env, HOME: home };
  delete e.CODEX_HOME;
  return e;
}

const SECRET = 'look at the cache key first; it is Tuesday';

async function withRepo(fn) {
  const fx = await makeRepo({ subtasks: [{ id: 'A' }, { id: 'B', blocked_by: ['A'] }] });
  const env = { ...fx.env, AGENTIC_ORCHESTRATOR_ROOT: ORCH, AGENTIC_ENGINEER_ROOT: ENG, AGENTIC_RUNTIME_ROOT: RUNTIME };
  delete env.AGENTIC_AUTOPILOT;
  // A home with no engineer installed: the command applies nothing here, so a
  // test of the write sees it pending; withCaches installs the hold-aware one.
  env.HOME = join(fx.dir, 'bare-home');
  mkdirSync(env.HOME);
  delete env.CODEX_HOME;
  const notes = join(fx.dir, 'notes');
  mkdirSync(notes);
  const noteFile = join(notes, 'note.md');
  writeFileSync(noteFile, `${SECRET}\n`);
  try { return await fn(fx, env, realpathSync(fx.work), noteFile); } finally { fx.cleanup(); }
}

async function run(argv, env, work) {
  const out = [];
  const err = [];
  const code = await C.main([...argv, '--repo', work], { env, io: { stdin: { isTTY: false } }, out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const idOf = (text) => /instruction ([0-9a-f]{16}) r(\d+)/.exec(text);
const entries = (work, macroId, id = 'A') => {
  const r = I.readInstructions(work, macroId, id);
  return r.state === 'ok' ? r.record.entries : [];
};

describe('agentic-autopilot instruct', () => {
  it('writes a note and a step for an idle child, prints its id and state and never the note; status lists it', () => withRepo(async (fx, env, work, noteFile) => {
    const child = await fx.dispatch('A');
    const r = await run(['instruct', 'A', '--macro', fx.macroId, '--note-file', noteFile, '--next', '/engineer:refine'], env, work);
    strictEqual(r.code, 0, r.err);
    const m = idOf(r.out);
    ok(m && m[2] === '1', r.out);
    ok(/: pending \(next \/engineer:refine\)/.test(r.out), r.out);
    ok(r.out.includes(`for child ${child.id}`), r.out);
    ok(!r.out.includes('Tuesday') && !r.err.includes('Tuesday'), 'the note is carried, never printed');
    const [e] = entries(work, fx.macroId);
    strictEqual(e.id, m[1]);
    strictEqual(e.child, child.id);
    strictEqual(e.step, '/engineer:refine');
    strictEqual(e.note, SECRET);
    strictEqual(e.branch, 'feat/a');
    strictEqual(e.witness.gate, null);
    const s = await run(['status', '--macro', fx.macroId], env, work);
    ok(s.out.includes(`instruction ${e.id} r1: pending next /engineer:refine`), s.out);
    ok(!s.out.includes('Tuesday'), s.out);
  }));

  it('takes a note alone before the dispatch, and refuses a step there', () => withRepo(async (fx, env, work, noteFile) => {
    const step = await run(['instruct', 'A', '--macro', fx.macroId, '--note-file', noteFile, '--next', '/engineer:critique'], env, work);
    strictEqual(step.code, 1);
    ok(/has no child yet: an instruction before its dispatch takes a note only/.test(step.err), step.err);
    strictEqual(entries(work, fx.macroId).length, 0, 'nothing written');
    const r = await run(['instruct', 'A', '--macro', fx.macroId, '--note-file', noteFile], env, work);
    strictEqual(r.code, 0, r.err);
    ok(/waiting for the dispatch/.test(r.out), r.out);
    const [e] = entries(work, fx.macroId);
    strictEqual(e.child, null);
    strictEqual(e.step, null);
  }));

  it('refuses a malformed step, a dispatch and a rerun as the step, with nothing written', () => withRepo(async (fx, env, work, noteFile) => {
    await fx.dispatch('A');
    for (const [next, why] of [['/engineer:ship', /is not a step an instruction names/], ['/orchestrator:next', /is a dispatch/], ['verify', /rerun of a verification/], ['/engineer:compose now', /is not a step/]]) {
      const r = await run(['instruct', 'A', '--macro', fx.macroId, '--note-file', noteFile, '--next', next], env, work);
      strictEqual(r.code, 1, next);
      ok(why.test(r.err), `${next}: ${r.err}`);
    }
    strictEqual(entries(work, fx.macroId).length, 0);
  }));

  it('refuses a worker of a run, a subtask not in the plan or closed, and an ended macro', () => withRepo(async (fx, env, work, noteFile) => {
    const worker = await run(['instruct', 'A', '--macro', fx.macroId, '--note-file', noteFile], { ...env, AGENTIC_AUTOPILOT: 'autopilot-20261101T000000Z-000001' }, work);
    ok(worker.code === 1 && /never holds or instructs a lane/.test(worker.err), worker.err);
    const unknown = await run(['instruct', 'Z', '--macro', fx.macroId, '--note-file', noteFile], env, work);
    ok(unknown.code === 1 && /is not in macro/.test(unknown.err), unknown.err);
    await fx.orch.bulkSubtaskStatus({ workflowPath: fx.macroPath, host: 'claude', fromStatuses: ['blocked'], toStatus: 'deferred' });
    const deferred = await run(['instruct', 'B', '--macro', fx.macroId, '--note-file', noteFile], env, work);
    ok(deferred.code === 1 && /subtask B is deferred: there is no lane to instruct/.test(deferred.err), deferred.err);
    await fx.orch.setMacroTerminal({ workflowPath: fx.macroPath, host: 'claude', terminalPhase: 'finalized', terminalMarker: true, nextAction: 'archive' });
    const ended = await run(['instruct', 'A', '--macro', fx.macroId, '--note-file', noteFile], env, work);
    ok(ended.code === 1 && /has ended/.test(ended.err), ended.err);
    strictEqual(entries(work, fx.macroId).length, 0);
    strictEqual(entries(work, fx.macroId, 'B').length, 0);
  }));

  it('refuses a subtask whose child has archived: the lane\'s next work is landing', () => withRepo(async (fx, env, work, noteFile) => {
    const child = await fx.dispatch('A');
    await fx.commitAndArchive(child.path);
    const r = await run(['instruct', 'A', '--macro', fx.macroId, '--note-file', noteFile], env, work);
    strictEqual(r.code, 1);
    ok(new RegExp(`child ${child.id} has archived`).test(r.err), r.err);
    strictEqual(entries(work, fx.macroId).length, 0);
  }));

  it('refuses a step for a child with an owner gate set, and takes a note for it', () => withRepo(async (fx, env, work, noteFile) => {
    const child = await fx.dispatch('A');
    await fx.finish(child.path, { kind: 'owner-decision', verb: null, confidence: 'HIGH' }, { ownerGate: { gate: 'scope-routing', anchor: 'routing-recommendation' } });
    const step = await run(['instruct', 'A', '--macro', fx.macroId, '--note-file', noteFile, '--next', '/engineer:refine'], env, work);
    strictEqual(step.code, 1);
    ok(/has the owner gate scope-routing set: an instruction never clears a gate/.test(step.err), step.err);
    const n = await run(['instruct', 'A', '--macro', fx.macroId, '--note-file', noteFile], env, work);
    strictEqual(n.code, 0, n.err);
    strictEqual(entries(work, fx.macroId)[0].witness.gate, 'scope-routing', 'the witness records the gate at the write');
  }));

  it('revises a pending instruction in its place, refuses a stale revision, and withdraws it', () => withRepo(async (fx, env, work, noteFile) => {
    await fx.dispatch('A');
    const first = idOf((await run(['instruct', 'A', '--macro', fx.macroId, '--note-file', noteFile], env, work)).out);
    const second = idOf((await run(['instruct', 'A', '--macro', fx.macroId, '--note-file', noteFile, '--next', '/engineer:commit'], env, work)).out);
    const rev = await run(['instruct', 'A', '--macro', fx.macroId, '--note-file', noteFile, '--next', '/engineer:critique', '--revises', `${first[1]}:1`], env, work);
    strictEqual(rev.code, 0, rev.err);
    ok(rev.out.includes(`instruction ${first[1]} r2`), rev.out);
    const list = entries(work, fx.macroId);
    strictEqual(list.length, 2);
    strictEqual(list[0].id, first[1], 'the revision keeps its place');
    strictEqual(list[0].step, '/engineer:critique');
    const stale = await run(['instruct', 'A', '--macro', fx.macroId, '--note-file', noteFile, '--revises', `${first[1]}:1`], env, work);
    ok(stale.code === 1 && /is at revision 2, not 1/.test(stale.err), stale.err);
    const w = await run(['instruct', 'A', '--macro', fx.macroId, '--withdraw', second[1]], env, work);
    strictEqual(w.code, 0, w.err);
    strictEqual(entries(work, fx.macroId)[1].state, 'withdrawn');
    const again = await run(['instruct', 'A', '--macro', fx.macroId, '--withdraw', second[1]], env, work);
    ok(again.code === 1 && /final/.test(again.err), again.err);
  }));

  it('needs a note file, and refuses one it cannot take', () => withRepo(async (fx, env, work) => {
    await fx.dispatch('A');
    const none = await run(['instruct', 'A', '--macro', fx.macroId], env, work);
    ok(none.code === 1 && /needs --note-file/.test(none.err), none.err);
    const blank = join(fx.dir, 'blank.md');
    writeFileSync(blank, '\n');
    const b = await run(['instruct', 'A', '--macro', fx.macroId, '--note-file', blank], env, work);
    ok(b.code === 1 && /is empty or blank/.test(b.err), b.err);
    strictEqual(entries(work, fx.macroId).length, 0);
  }));

  it('warns beside a live run that does not apply instructions: the instruction waits for one that does', () => withRepo(async (fx, env, work, noteFile) => {
    await fx.dispatch('A');
    const lock = RL.macroLockPath(work, fx.macroId);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, `h-${process.pid}-abcdef.json`), JSON.stringify({ kind: 'run', run_id: 'autopilot-20261101T000000Z-000009', pid: process.pid, fingerprint: await RL.processFingerprint(process.pid), worker: null, capabilities: ['holds-1'] }));
    const r = await run(['instruct', 'A', '--macro', fx.macroId, '--note-file', noteFile], env, work);
    strictEqual(r.code, 0, r.err);
    ok(/run autopilot-20261101T000000Z-000009 does not apply instructions \(instructions-1\): the instruction waits for a run that does/.test(r.out), r.out);
    strictEqual(entries(work, fx.macroId)[0].state, 'pending');
  }));

  it('with no run live, applies at the lane\'s boundary itself and writes no event (items 3 and 8)', () => withRepo(async (fx, env0, work, noteFile) => {
    const env = withCaches(fx, env0);
    const child = await fx.dispatch('A');
    await fx.finish(child.path, { kind: 'verb', verb: 'critique', confidence: 'HIGH' });
    const r = await run(['instruct', 'A', '--macro', fx.macroId, '--note-file', noteFile, '--next', '/engineer:refine'], env, work);
    strictEqual(r.code, 0, r.err);
    ok(/applied now as app-\S+: 1 instruction\(s\), next step \/engineer:refine/.test(r.out), r.out);
    ok(readFileSync(child.path, 'utf8').includes(SECRET), 'the note reached the child');
    const fm = (await fx.eng.readWorkflow(child.path)).frontmatter;
    strictEqual(fm.next_step_verb, 'refine');
    strictEqual(entries(work, fx.macroId)[0].state, 'applied');
    ok(!existsSync(EV.eventsPath({ mainRoot: work, macroId: fx.macroId })), 'an owner command writes no event');
    const s = await run(['status', '--macro', fx.macroId], env, work);
    ok(/r1: applied next \/engineer:refine/.test(s.out), s.out);
  }));

  it('reads the gate witness as the application does: an earlier owner note quoting a resolution heading forges none (N2)', () => withRepo(async (fx, env0, work, noteFile) => {
    const env = withCaches(fx, env0);
    const child = await fx.dispatch('A');
    await fx.finish(child.path, { kind: 'verb', verb: 'critique', confidence: 'HIGH' });
    writeFileSync(noteFile, 'the log said:\n### Owner gate resolved: scope-routing at 2026-11-01T10:00:00Z\n');
    const n = await run(['instruct', 'A', '--macro', fx.macroId, '--note-file', noteFile], env, work);
    strictEqual(n.code, 0, n.err);
    ok(/applied now as app-\S+/.test(n.out), n.out);
    writeFileSync(noteFile, `${SECRET}\n`);
    const r = await run(['instruct', 'A', '--macro', fx.macroId, '--note-file', noteFile, '--next', '/engineer:refine'], env, work);
    strictEqual(r.code, 0, r.err);
    ok(/applied now as app-\S+: 1 instruction\(s\), next step \/engineer:refine/.test(r.out), r.out);
    deepStrictEqual(entries(work, fx.macroId).map((e) => e.state), ['applied', 'applied'], 'no gate was set or resolved, and nothing is superseded');
    strictEqual((await fx.eng.readWorkflow(child.path)).frontmatter.next_step_verb, 'refine');
  }));

  it('reads a replacement child\'s witness as the application does: its quote of the earlier child\'s application heading hides no resolution (N3)', () => withRepo(async (fx, env0, work, noteFile) => {
    const env = withCaches(fx, env0);
    const first = await fx.dispatch('A');
    await fx.finish(first.path, { kind: 'verb', verb: 'critique', confidence: 'HIGH' });
    const n = await run(['instruct', 'A', '--macro', fx.macroId, '--note-file', noteFile], env, work);
    strictEqual(n.code, 0, n.err);
    const earlier = I.readInstructions(work, fx.macroId, 'A').record.receipts.at(-1);
    strictEqual(earlier.state, 'done');
    await fx.commitAndArchive(first.path);
    // The child that took the lane after it, whose worker quotes the earlier
    // child's application heading in a closed fence, and a gate set and
    // resolved there before the owner writes again.
    const { filePath } = await fx.eng.createWorkflow({
      repoRoot: work, verb: 'compose', host: 'claude', profile: 'backend', originalRequest: 'again',
      gitBaseline: { branch: 'feat/a', head: fx.git('rev-parse', 'HEAD'), status_digest: '' },
      currentPhase: 'phase-0-bootstrap', nextAction: 'Run the verb', parentWorkflow: fx.macroId, originatingSubtask: 'A',
    });
    await fx.finish(filePath, { kind: 'verb', verb: 'critique', confidence: 'HIGH' });
    const A = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/instruct-apply.mjs')).href);
    const worker = await A.plainAppend([join(ENG, 'scripts', 'state.mjs'), 'append', '--workflow-path', filePath, '--host', 'claude',
      '--phase-label', 'Phase 1: Critique (synthesized)', '--phase-note', `the first child was told:\n\n\`\`\`\n### ${A.applicationHeading(earlier.application_id)}\n\`\`\`\n`, '--event', 'updated', '--once-operation', 'checkpoint']);
    strictEqual(worker.ok, true, worker.detail);
    await fx.finish(filePath, { kind: 'owner-decision', verb: null, confidence: 'HIGH' }, { ownerGate: { gate: 'scope-routing', anchor: 'routing-recommendation' } });
    await fx.eng.clearAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'scope-routing', nextStep: { kind: 'verb', verb: 'critique', confidence: 'HIGH' }, nextAction: 'critique', resolution: 'go on' });
    const r = await run(['instruct', 'A', '--macro', fx.macroId, '--note-file', noteFile, '--next', '/engineer:refine'], env, work);
    strictEqual(r.code, 0, r.err);
    ok(/applied now as app-\S+: 1 instruction\(s\), next step \/engineer:refine/.test(r.out), r.out);
    deepStrictEqual(entries(work, fx.macroId).map((e) => e.state), ['applied', 'applied'], 'the resolution came before the write: nothing is superseded');
    strictEqual((await fx.eng.readWorkflow(filePath)).frontmatter.next_step_verb, 'refine');
  }));

  it('reconciles a receipt a crash left before anything else, so an instruction stuck applying is applied (P1)', () => withRepo(async (fx, env0, work, noteFile) => {
    const env = withCaches(fx, env0);
    const child = await fx.dispatch('A');
    await fx.finish(child.path, { kind: 'verb', verb: 'critique', confidence: 'HIGH' });
    const A = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/instruct-apply.mjs')).href);
    const e = await I.writeInstruction({ mainRoot: work, macroId: fx.macroId, subtaskId: 'A', branch: 'feat/a', child: child.id, step: '/engineer:refine', note: I.checkNoteBytes(Buffer.from('stuck')), witness: I.gateWitnessOf(readFileSync(child.path, 'utf8')), writtenBy: 'owner' });
    await A.applyInstructions({ mainRoot: work, macroId: fx.macroId, subtaskId: 'A', childPath: child.path, engineerRoot: ENG, by: 'test', stateRoots: [work], runAppend: async () => { throw new Error('died'); } }).catch(() => {});
    // The applier is gone: its receipt names a process that no longer lives.
    const file = I.instructionsPath(work, fx.macroId, 'A');
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    rec.receipts[0].pid = 2 ** 22 - 3;
    writeFileSync(file, JSON.stringify(rec));
    strictEqual(entries(work, fx.macroId)[0].state, 'applying');
    // The public application, with nothing new pending: the recovery comes first.
    const S = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs')).href);
    const r = await S.applyLaneInstructions({ workflowPath: fx.macroPath, host: 'claude', engineerRoot: ENG, subtaskId: 'A', env, home: env.HOME });
    strictEqual(r.state, 'applied', JSON.stringify(r));
    deepStrictEqual(entries(work, fx.macroId).map((x) => [x.id === e.id, x.state]), [[true, 'applied']]);
  }));

  it('leaves a held lane, and a released one whose release awaits its comparison, as they are (item 5)', () => withRepo(async (fx, env0, work, noteFile) => {
    const env = withCaches(fx, env0);
    const child = await fx.dispatch('A');
    await fx.finish(child.path, { kind: 'verb', verb: 'critique', confidence: 'HIGH' });
    const h = await run(['hold', 'A', '--macro', fx.macroId], env, work);
    strictEqual(h.code, 0, h.err);
    const holdId = /hold ([0-9a-f]{16})/.exec(h.out)[1];
    const held = await run(['instruct', 'A', '--macro', fx.macroId, '--note-file', noteFile, '--next', '/engineer:refine'], env, work);
    strictEqual(held.code, 0, held.err);
    ok(/not applied now \(not-at-boundary: subtask A is held/.test(held.out), held.out);
    const rel = await run(['release', 'A', '--macro', fx.macroId, '--hold', holdId], env, work);
    strictEqual(rel.code, 0, rel.err);
    const again = await run(['instruct', 'A', '--macro', fx.macroId, '--note-file', noteFile], env, work);
    ok(/not applied now \(not-at-boundary: subtask A's release \(hold \S+\) is not compared yet/.test(again.out), again.out);
    strictEqual(H.holdStateOf(work, fx.macroId, 'A').state, 'released-uncompared', 'the release still awaits its comparison');
    ok(!readFileSync(child.path, 'utf8').includes(SECRET), 'nothing reached the child');
    deepStrictEqual(entries(work, fx.macroId).map((e) => e.state), ['pending', 'pending']);
  }));

  // M2 (the slice's second critique): a read that cannot know defers, never
  // reads as nothing to do (a `none` or `no-child` result leaves the lane's
  // recorded step to run over the instruction).
  for (const [what, where] of [
    ['an unrelated archive file in another persona\'s home that does not parse', '.agentic-plugins/state/designer/archive/broken.md'],
    // The lane's child itself: no child found is no proof there is none
    // (state.mjs, before the application's own read).
    ['the lane\'s own child, whose file does not parse', null],
    // Its id line gone, the file still parses: which child it is cannot be
    // told, and skipped it would read as gone (a drop, child-archived).
    ['the lane\'s own child, whose file names no workflow id', 'no-id'],
  ]) {
    it(`leaves the instructions pending, waiting, beside ${what}: the lane's child may be in it`, () => withRepo(async (fx, env0, work) => {
      const env = withCaches(fx, env0);
      const child = await fx.dispatch('A');
      await fx.finish(child.path, { kind: 'verb', verb: 'critique', confidence: 'HIGH' });
      await I.writeInstruction({ mainRoot: work, macroId: fx.macroId, subtaskId: 'A', branch: 'feat/a', child: child.id, step: '/engineer:refine', note: I.checkNoteBytes(Buffer.from(SECRET)), witness: I.gateWitnessOf(readFileSync(child.path, 'utf8')), writtenBy: 'owner' });
      const file = where === null || where === 'no-id' ? child.path : join(work, where);
      if (where === null) writeFileSync(file, readFileSync(file, 'utf8').replace(/^---\n/, ''));
      else if (where === 'no-id') writeFileSync(file, readFileSync(file, 'utf8').replace(/^workflow_id: .*\n/m, ''));
      else {
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, 'not a workflow\n');
      }
      const S = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs')).href);
      const r = await S.applyLaneInstructions({ workflowPath: fx.macroPath, host: 'claude', engineerRoot: ENG, subtaskId: 'A', env, home: env.HOME });
      strictEqual(r.state, 'waiting', JSON.stringify(r));
      ok(r.detail.includes(file), `the detail names the file: ${r.detail}`);
      strictEqual(entries(work, fx.macroId)[0].state, 'pending');
      ok(!readFileSync(child.path, 'utf8').includes(SECRET), 'nothing reached the child');
    }));
  }

  it('leaves an entry left applying that no reserved receipt names unresolved, waiting, naming the record: never read as nothing to do', () => withRepo(async (fx, env0, work) => {
    const env = withCaches(fx, env0);
    const child = await fx.dispatch('A');
    await fx.finish(child.path, { kind: 'verb', verb: 'critique', confidence: 'HIGH' });
    await I.writeInstruction({ mainRoot: work, macroId: fx.macroId, subtaskId: 'A', branch: 'feat/a', child: child.id, step: '/engineer:refine', note: I.checkNoteBytes(Buffer.from(SECRET)), witness: I.gateWitnessOf(readFileSync(child.path, 'utf8')), writtenBy: 'owner' });
    // A record edited by hand: the entry applying, its receipt nowhere.
    const file = I.instructionsPath(work, fx.macroId, 'A');
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    rec.entries[0] = { ...rec.entries[0], state: 'applying', receipt: 'app-20261101T000000Z-0000abcd' };
    writeFileSync(file, JSON.stringify(rec));
    strictEqual(I.readInstructions(work, fx.macroId, 'A').state, 'ok', 'the record still reads');
    const S = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs')).href);
    const r = await S.applyLaneInstructions({ workflowPath: fx.macroPath, host: 'claude', engineerRoot: ENG, subtaskId: 'A', env, home: env.HOME });
    strictEqual(r.state, 'waiting', JSON.stringify(r));
    ok(r.detail.includes('no reserved receipt names it') && r.detail.includes(file), r.detail);
    ok(!readFileSync(child.path, 'utf8').includes(SECRET), 'nothing reached the child');
  }));

  it('leaves the instructions pending, waiting, when the repository\'s worktrees cannot be listed, and refuses a write then', () => withRepo(async (fx, env0, work, noteFile) => {
    const env = withCaches(fx, env0);
    const child = await fx.dispatch('A');
    await fx.finish(child.path, { kind: 'verb', verb: 'critique', confidence: 'HIGH' });
    await I.writeInstruction({ mainRoot: work, macroId: fx.macroId, subtaskId: 'A', branch: 'feat/a', child: child.id, step: '/engineer:refine', note: I.checkNoteBytes(Buffer.from(SECRET)), witness: I.gateWitnessOf(readFileSync(child.path, 'utf8')), writtenBy: 'owner' });
    // The common dir's worktrees list is no directory: git's list cannot be
    // read, and a child in a worktree's state root would go unseen.
    writeFileSync(join(work, '.git', 'worktrees'), 'not a directory\n');
    const S = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs')).href);
    const r = await S.applyLaneInstructions({ workflowPath: fx.macroPath, host: 'claude', engineerRoot: ENG, subtaskId: 'A', env, home: env.HOME });
    strictEqual(r.state, 'waiting', JSON.stringify(r));
    ok(/worktrees cannot be listed/.test(r.detail), r.detail);
    strictEqual(entries(work, fx.macroId)[0].state, 'pending');
    ok(!readFileSync(child.path, 'utf8').includes(SECRET), 'nothing reached the child');
    const w = await run(['instruct', 'A', '--macro', fx.macroId, '--note-file', noteFile], env, work);
    strictEqual(w.code, 1, w.out);
    ok(/worktrees cannot be listed.*nothing was written/.test(w.err), w.err);
    strictEqual(entries(work, fx.macroId).length, 1, 'no second instruction');
  }));

  it('applies nothing where the lane\'s operations cannot be made visible (item 9)', () => withRepo(async (fx, env, work, noteFile) => {
    const child = await fx.dispatch('A');
    await fx.finish(child.path, { kind: 'verb', verb: 'critique', confidence: 'HIGH' });
    const r = await run(['instruct', 'A', '--macro', fx.macroId, '--note-file', noteFile, '--next', '/engineer:refine'], env, work);
    strictEqual(r.code, 0, r.err);
    ok(/not applied now \(inactive: the lane's operations cannot be made visible/.test(r.out), r.out);
    strictEqual(entries(work, fx.macroId)[0].state, 'pending');
    strictEqual((await fx.eng.readWorkflow(child.path)).frontmatter.next_step_verb, 'critique');
  }));
});
