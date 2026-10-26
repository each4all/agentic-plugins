// ADR-0068 Decision 2, item 10 — the takeover prototype (hold-persona plan,
// Task 12). A lane's worker step, a hold, the person's session in the lane,
// the release, the comparison and the driver's resume, driven end to end:
// the persona half is the real engineer scripts, run through the generated
// blocks of its runbooks (the runbook transport, OP_DIR included); the
// orchestrator half is the scratch one beside this file, which is not
// plugins/orchestrator's. Acceptance and findings: README.md here. No `claude`
// is spawned: whether `claude --resume` of a lane's session works stays
// [unverified].

import { describe, it } from 'node:test';
import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { personaInfo, REPO_ROOT } from '../../persona-pipeline/_personas.mjs';
import { scratchOrchestrator } from './_scratch-orchestrator.mjs';

// The Stop hook and the snapshots below run in this process: no AGENTIC_*
// (this session's run) and no GIT_* (an inherited GIT_INDEX_FILE or GIT_DIR
// would point the fixture's git at another repository).
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AGENTIC_') || k.startsWith('GIT_')) delete process.env[k];
}

const MACRO = 'macro-plan-20261025T000000Z-abcdef';
const SUBTASK = 'hold-persona';
const BRANCH = 'lane/hold-persona';
const RUN = 'autopilot-20261025T000000Z-abcdef';
const E = personaInfo('engineer');
const STATE_BIN = E.path('scripts/state.mjs');
const engineer = await import(pathToFileURL(STATE_BIN).href);
const stopHook = await import(pathToFileURL(E.path('scripts/stop-archive.mjs')).href);

const SHELL = 'bash';
const baseEnv = () => ({ ...process.env, AGENTIC_ENGINEER_ROOT: E.root, AGENTIC_ORCHESTRATOR_ROOT: resolve(REPO_ROOT, 'plugins/orchestrator') });
// A worker step of the run: the driver's dispatch environment (ADR-0019 §3,
// ADR-0063 §0.2) and the operation id its dispatch began (N4).
const workerEnv = (step, extra = {}) => ({ ...baseEnv(), AGENTIC_AUTOPILOT: RUN, AGENTIC_AUTOPILOT_STEP: String(step), ...extra });
// The person's session: interactive, no run named.
const personEnv = () => baseEnv();

const scratch = [];
const tempDir = (prefix) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(d);
  return d;
};

// The main checkout, where the holds live, and the lane's worktree on its own
// branch, where the worker and the person work. The workflows live in the
// lane's checkout, or, with the shared-creation switch on (ADR-0067 Decision 1,
// as on a machine that ran lanes), in the main checkout's state root.
// Barriers a test made: each is opened when the test ends, whatever it did, so
// a companion still waiting never keeps the test process alive.
const barriers = [];
const newBarrier = () => {
  const b = join(tempDir('hold-barrier-'), 'go');
  barriers.push(b);
  return b;
};
async function withLaneIn(shared, fn, { ignoreState = true } = {}) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'hold-takeover-')));
  const main = join(top, 'main');
  const lane = join(top, 'lane');
  try {
    mkdirSync(main);
    const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: process.env }).trimEnd();
    git(main, 'init', '-q', '-b', 'main');
    for (const [k, v] of [['user.email', 't@example.invalid'], ['user.name', 't'], ['commit.gpgsign', 'false']]) git(main, 'config', k, v);
    writeFileSync(join(main, 'release-please-config.json'), readFileSync(join(REPO_ROOT, 'release-please-config.json'), 'utf8'));
    writeFileSync(join(main, '.gitignore'), ignoreState ? '.agentic-plugins/\n' : 'node_modules/\n');
    mkdirSync(join(main, 'plugins/engineer'), { recursive: true });
    writeFileSync(join(main, 'plugins/engineer/a.mjs'), 'export const a = 0;\n');
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'chore: base', '--no-verify');
    git(main, 'worktree', 'add', '-q', '-b', BRANCH, lane);
    if (shared) {
      mkdirSync(join(main, '.agentic-plugins/state'), { recursive: true });
      writeFileSync(join(main, '.agentic-plugins/state/shared-creation.json'), JSON.stringify({ schema: 'agentic-shared-creation-1.0', enabled: true, enabled_at: '2026-10-25T00:00:00Z' }));
    }
    const orch = scratchOrchestrator({ main, macro: MACRO, engineerStateBin: STATE_BIN, env: process.env });
    return await fn({ main, lane, shared, git: (...a) => git(lane, ...a), orch });
  } finally {
    for (const b of barriers.splice(0)) {
      writeFileSync(b, '');
      await new Promise((r) => { setTimeout(r, 200); });
    }
    rmSync(top, { recursive: true, force: true });
    for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
  }
}

// --- the runbook transport ---------------------------------------------------

function regionBlock(dest, id) {
  const text = readFileSync(E.path(dest), 'utf8');
  const begin = text.indexOf(`<!-- pipeline:begin ${id} -->`);
  const end = text.indexOf(`<!-- pipeline:end ${id} -->`);
  ok(begin >= 0 && end > begin, `${dest} holds region ${id}`);
  const runnable = [...text.slice(begin, end).matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => !/^\s*mktemp -d /.test(b));
  strictEqual(runnable.length, 1, `${id}: one block to run`);
  return runnable[0];
}
function fill(block, pairs) {
  let out = block;
  for (const [placeholder, value] of pairs) {
    ok(out.includes(placeholder), `the block holds ${placeholder}`);
    out = out.split(placeholder).join(value);
  }
  return out;
}
function runBlock(cwd, block, env) {
  const r = spawnSync(SHELL, ['-c', block], { cwd, encoding: 'utf8', env, timeout: 60_000 });
  ok(r.status !== null, `the block ran to its end (${r.error?.message ?? r.signal})`);
  return r;
}
// A block left running: its result once it exits.
function startBlock(cwd, block, env) {
  const child = spawn(SHELL, ['-c', block], { cwd, env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  return new Promise((res) => { child.on('close', (status) => res({ status, stdout, stderr })); });
}
async function waitFor(file, ms = 30_000) {
  const until = Date.now() + ms;
  while (!existsSync(file)) {
    ok(Date.now() < until, `${file} appeared`);
    await new Promise((r) => { setTimeout(r, 50); });
  }
}
const opDirOf = (r) => {
  const m = /^OP_DIR=(.+)$/m.exec(r.stdout);
  ok(m, `the block printed OP_DIR:\n${r.stdout}\n${r.stderr}`);
  return m[1];
};
const textDir = (files) => {
  const d = tempDir('hold-text-');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), `${text}\n`);
  return d;
};

// compose's Phase 0 bootstrap, as /orchestrator:next's dispatch runs it.
function bootstrap(lane, env) {
  const block = fill(regionBlock('commands/compose.md', 'compose-bootstrap'), [["TEXT_DIR='<directory from step 1>'", `TEXT_DIR='${textDir({ 'request.txt': 'the topic' })}'`]]);
  return runBlock(lane, block, { ...env, AGENTIC_PROFILE: 'code' });
}
// A verb's Phase 0 resume (compose's unless named).
const resumeVerb = (lane, env, verb = 'compose') => runBlock(lane, regionBlock(`commands/${verb}.md`, `${verb}-resume`), env);
// compose's ensemble dispatch, the peer launched through the real runner; left
// running, its result is `done`.
function dispatchEnsemble(lane, env) {
  const dir = textDir({ 'prompt.xml': '<task>review</task>' });
  const done = startBlock(lane, fill(regionBlock('commands/compose.md', 'compose-dispatch'), [["TEXT_DIR='<directory from step 1>'", `TEXT_DIR='${dir}'`]]), env);
  return { done, dir };
}
// A verb's Phase 2 finalize (compose's unless named; no run launched, or the
// run dispatched from `dispatchDir`). Its finish-verb records the runbook's
// typical next step, or `next`: { verb }, { commit: true } or { gate: true }
// (the owner-decision form, gate scope-routing).
function finalize(lane, env, opDir, next = {}, dispatchDir = '', verb = 'compose') {
  const note = `### Ensemble skipped: ${verb} (local-only)\n\nlocal${next.gate ? '\n\n### Routing recommendation\n\nThis belongs in another subtask.' : ''}`;
  let block = fill(regionBlock(`commands/${verb}.md`, `${verb}-finalize`), [
    ["TEXT_DIR='<directory from step 1>'", `TEXT_DIR='${textDir({ 'note.md': note, 'summary.txt': 'local only', 'next-action.txt': next.gate ? 'Owner: route it' : 'Next' })}'`],
    ["DISPATCH_DIR='<the directory the dispatch block ran with; empty when no run launched; the run ledger directory when a run launched and that directory is gone>'", `DISPATCH_DIR='${dispatchDir}'`],
    ["VERDICT='<the synthesis verdict>'", "VERDICT='agreed'"],
    ["CONFIDENCE='<HIGH|MEDIUM|LOW>'", "CONFIDENCE='HIGH'"],
    ["OP_DIR='<the operation directory the Phase 0 block printed as OP_DIR; empty when it printed none>'", `OP_DIR='${opDir}'`],
  ]);
  // The runbook's "change the --next-step-* flags when the verb's result selects
  // a different next step", and its owner-decision form for a gate.
  const typical = /--next-step-kind verb --next-step-verb '[a-z]+'( \\\n\s*--next-step-confidence "\$CONFIDENCE")/;
  ok(typical.test(block), 'the typical finish-verb');
  if (next.commit) block = block.replace(typical, '--next-step-kind commit$1');
  else if (next.gate) block = block.replace(typical, "--next-step-kind owner-decision$1 --owner-gate 'scope-routing' --owner-gate-anchor 'routing-recommendation'");
  else if (next.verb) block = block.replace(typical, `--next-step-kind verb --next-step-verb '${next.verb}'$1`);
  return runBlock(lane, block, env);
}

const fm = (p) => engineer.parseWorkflowFile(readFileSync(p, 'utf8')).frontmatter;
const opsOf = (p) => fm(p).persona_operations?.ops ?? [];
const activeChild = (lane) => execFileSync(process.execPath, [STATE_BIN, 'find-active', '--repo-root', lane], { cwd: lane, encoding: 'utf8', env: process.env }).trim();
const opRecords = (orch) => {
  const d = join(orch.dir, 'ops', SUBTASK);
  return existsSync(d) ? readdirSync(d).filter((n) => !n.startsWith('.')).sort() : [];
};
// The Stop hook's write at a turn end of a workflow left open: a snapshot. A
// later turn's is `later` minutes on, with another status digest, so it
// rewrites last_snapshot even when the test runs within one second.
const snapshotAtStop = (p, later = 0) => engineer.snapshot({
  workflowPath: p, host: 'claude', trigger: 'stop', env: process.env,
  now: new Date(Date.now() + later * 60_000), statusDigest: later === 0 ? undefined : 'f'.repeat(64),
});

/**
 * The run's step 1 dispatches the subtask; the owner holds it while the step
 * is still in its verb, and the handoff waits for the step's last write.
 * Returns the lane held, its child and the hold id.
 */
async function workerStepThenHeld({ main, lane, shared, orch }) {
  orch.activate();
  const dispatched = 'op-20261025T000000Z-0d15ba7c';
  const env = workerEnv(1, { AGENTIC_PARENT_WORKFLOW: MACRO, AGENTIC_ORIGINATING_SUBTASK: SUBTASK, AGENTIC_TOPIC: 'Build the thing', AGENTIC_OPERATION_ID: dispatched });
  const boot = bootstrap(lane, env);
  strictEqual(boot.status, 0, boot.stderr);
  const child = activeChild(lane);
  strictEqual(resolve(child, '..'), join(shared ? main : lane, '.agentic-plugins/state/engineer/workflows'));
  // Operation-id continuity: the dispatch's id is the child's open operation.
  deepStrictEqual(opsOf(child).map((o) => [o.id, o.kind, o.ext]), [[dispatched, 'verb', true]]);
  deepStrictEqual(opRecords(orch), [`${dispatched}.json`]);

  const holdId = orch.hold({ subtask: SUBTASK, branch: BRANCH, lane: 'lane-1', child: fm(child).workflow_id });
  const pending = orch.handoff(SUBTASK, child);
  strictEqual(pending.state, 'pending', 'the step is still in its operation');
  ok(pending.blockers.some((b) => b.includes(dispatched)), pending.blockers.join('; '));

  // The step runs to its end (item 4: never aborted) and records its next step.
  const fin = finalize(lane, workerEnv(1), opDirOf(boot));
  strictEqual(fin.status, 0, fin.stderr);
  const f = fm(child);
  deepStrictEqual([f.next_step_kind, f.next_step_verb, f.terminal_marker, f.persona_operations], ['verb', 'critique', undefined, undefined]);
  deepStrictEqual(opRecords(orch), []);
  deepStrictEqual(orch.handoff(SUBTASK, child), { state: 'held', blockers: [] });
  return { child, holdId };
}

for (const shared of [false, true]) describe(`the takeover (Decision 2, item 10), end to end against a scratch orchestrator half (shared creation ${shared ? 'on' : 'off'})`, () => {
  const withLane = (fn) => withLaneIn(shared, fn);
  it("a person's verb in the held lane: the release is consumed and the driver resumes from the person's next step", () => withLane(async (ctx) => {
    const { lane, orch } = ctx;
    const { child, holdId } = await workerStepThenHeld(ctx);

    // The person's session: a verb on the lane's child (item 5).
    const resumed = resumeVerb(lane, personEnv());
    strictEqual(resumed.status, 0, resumed.stderr);
    const opDir = opDirOf(resumed);
    const [open] = opsOf(child);
    strictEqual(open.kind, 'verb');
    // The person's verb runs its own ensemble: a peer run the session started.
    const barrier = newBarrier();
    const ensemble = dispatchEnsemble(lane, { ...personEnv(), AGENTIC_COMPANIONS_ROOT: fakeCompanions({ barrier }) });
    // While the peer runs, the release refuses: the person's operation is open
    // and its ensemble pending (item 7).
    await waitFor(`${barrier}.started`);
    strictEqual(fm(child).pending_ensemble.length, 1);
    const refused = orch.release({ subtask: SUBTASK, holdId, lane, childPath: child }).refused;
    match(refused, new RegExp(open.id));
    match(refused, /a pending peer ensemble/);
    writeFileSync(barrier, '');
    const ran = await ensemble.done;
    strictEqual(ran.status, 0, ran.stderr);
    // Ended, still pending until the finalize settles it.
    match(orch.release({ subtask: SUBTASK, holdId, lane, childPath: child }).refused, /a pending peer ensemble/);

    const fin = finalize(lane, personEnv(), opDir, { verb: 'refine' }, ensemble.dir);
    strictEqual(fin.status, 0, fin.stderr);
    // Item 6: interactive, but the lane is held, so the workflow stays open.
    match(fin.stderr, /stays open \(ADR-0068 Decision 2, item 6\): subtask hold-persona is held/);
    let f = fm(child);
    deepStrictEqual([f.next_step_kind, f.next_step_verb, f.terminal_marker, f.current_phase === 'summary-complete', f.persona_operations, f.pending_ensemble ?? []], ['verb', 'refine', undefined, false, undefined, []]);
    strictEqual(f.ensemble_results.at(-1).verdict, 'agreed');
    deepStrictEqual(opRecords(orch), []);
    await snapshotAtStop(child);

    const rel = orch.release({ subtask: SUBTASK, holdId, lane, childPath: child });
    ok(rel.released, JSON.stringify(rel));
    // The session's last turn ends after the release: its Stop snapshot is
    // left out of the content digest (N6).
    const beforeStop = fm(child).last_snapshot;
    await snapshotAtStop(child, 1);
    notStrictEqual(JSON.stringify(fm(child).last_snapshot), JSON.stringify(beforeStop), 'the snapshot rewrote last_snapshot');
    const cmp = orch.compare({ subtask: SUBTASK, lane, childPath: child });
    strictEqual(cmp.state, 'consumed', JSON.stringify(cmp));
    deepStrictEqual(orch.compare({ subtask: SUBTASK, lane, childPath: child }), { state: 'consumed', compared: false }, 'consumed once');
    deepStrictEqual(orch.resumeFrom({ childPath: child }), { action: 'dispatch-verb', verb: 'refine' });

    // The driver's next step: a worker spawned after the person's session runs
    // the verb the person recorded.
    const { verb } = orch.resumeFrom({ childPath: child });
    const next = resumeVerb(lane, workerEnv(2), verb);
    strictEqual(next.status, 0, next.stderr);
    deepStrictEqual([fm(child).verb, opsOf(child).map((o) => o.kind)], ['refine', ['verb']]);
    const done = finalize(lane, workerEnv(2), opDirOf(next), {}, '', verb);
    strictEqual(done.status, 0, done.stderr);
    f = fm(child);
    deepStrictEqual([f.next_step_kind, f.next_step_verb, f.terminal_marker, f.persona_operations], ['verb', 'critique', undefined, undefined]);
  }));

  it('a hand edit after the release rejects it, once: putting the tree back gives nothing back', () => withLane(async (ctx) => {
    const { lane, orch } = ctx;
    const { child, holdId } = await workerStepThenHeld(ctx);
    ok(orch.release({ subtask: SUBTASK, holdId, lane, childPath: child }).released);
    const file = join(lane, 'plugins/engineer/a.mjs');
    const before = readFileSync(file, 'utf8');
    writeFileSync(file, 'export const a = 2;\n');
    const cmp = orch.compare({ subtask: SUBTASK, lane, childPath: child });
    strictEqual(cmp.state, 'rejected');
    notStrictEqual(cmp.now.tree, cmp.basis.tree);
    strictEqual(cmp.now.workflow, cmp.basis.workflow, "the child's own record did not move");
    ok(existsSync(join(orch.dir, 'parks', `${SUBTASK}.json`)), 'the lane parks owner-choice');
    writeFileSync(file, before);
    deepStrictEqual(orch.compare({ subtask: SUBTASK, lane, childPath: child }), { state: 'rejected', compared: false });
    // Only a new hold and release give the lane back; their consumption ends
    // the park.
    const again = orch.hold({ subtask: SUBTASK, branch: BRANCH, lane: 'lane-1', child: fm(child).workflow_id });
    deepStrictEqual(orch.handoff(SUBTASK, child), { state: 'held', blockers: [] });
    ok(orch.release({ subtask: SUBTASK, holdId: again, lane, childPath: child }).released);
    strictEqual(orch.compare({ subtask: SUBTASK, lane, childPath: child }).state, 'consumed');
    strictEqual(existsSync(join(orch.dir, 'parks', `${SUBTASK}.json`)), false, 'the kept park ended');
  }));

  it("a persona write after the release (a checkpoint, no longer held) moves the child's digest and rejects it", () => withLane(async (ctx) => {
    const { lane, orch } = ctx;
    const { child, holdId } = await workerStepThenHeld(ctx);
    ok(orch.release({ subtask: SUBTASK, holdId, lane, childPath: child }).released);
    const r = runBlock(lane, fill(regionBlock('commands/checkpoint.md', 'checkpoint-set'), [
      ["TEXT_DIR='<directory from step 1>'", `TEXT_DIR='${textDir({ 'summary.txt': 'one more thought' })}'`],
    ]), personEnv());
    strictEqual(r.status, 0, r.stderr);
    const cmp = orch.compare({ subtask: SUBTASK, lane, childPath: child });
    strictEqual(cmp.state, 'rejected');
    strictEqual(cmp.now.tree, cmp.basis.tree);
    notStrictEqual(cmp.now.workflow, cmp.basis.workflow);
  }));

  it('a committed child: the commit stays an operation through its archive and parent note, then the lane waits to land', () => withLane(async (ctx) => {
    const { lane, orch, git } = ctx;
    const { child, holdId } = await workerStepThenHeld(ctx);

    const resumed = resumeVerb(lane, personEnv());
    strictEqual(resumed.status, 0, resumed.stderr);
    writeFileSync(join(lane, 'plugins/engineer/a.mjs'), 'export const a = 1;\n');
    const rec = spawnSync(process.execPath, [STATE_BIN, 'record-composed-file', '--workflow-path', child, '--path', 'plugins/engineer/a.mjs', '--op', 'edit'], { cwd: lane, encoding: 'utf8', env: personEnv() });
    strictEqual(rec.status, 0, rec.stderr);
    const fin = finalize(lane, personEnv(), opDirOf(resumed), { verb: 'commit', commit: true });
    strictEqual(fin.status, 0, fin.stderr);
    strictEqual(fm(child).next_step_kind, 'commit');

    const base = git('rev-parse', 'HEAD');
    const commit = runBlock(lane, regionBlock('commands/commit.md', 'commit-execute'), personEnv());
    strictEqual(commit.status, 0, `${commit.stdout}\n${commit.stderr}`);
    notStrictEqual(git('rev-parse', 'HEAD'), base, 'the person committed');
    const [op] = opsOf(child);
    strictEqual(op?.kind, 'commit', 'the commit is still open until its archive');
    match(orch.release({ subtask: SUBTASK, holdId, lane, childPath: child }).refused, new RegExp(op.id));

    const notes = [];
    const stop = await stopHook.runStopArchive({
      workflowPath: child, host: 'claude', repoRoot: lane,
      headSha: git('rev-parse', 'HEAD'), headSubject: git('log', '-1', '--format=%s'),
      stderr: { write() {} },
      // The parent writeback's slot (the orchestrator's writer is replaced by
      // a probe): the commit is still open there.
      noteParent: async ({ archivedPath }) => {
        notes.push({ archivedPath, entries: opsOf(archivedPath).map((o) => o.id), records: opRecords(orch), release: orch.release({ subtask: SUBTASK, holdId, lane, childPath: child }) });
      },
    });
    strictEqual(stop.archived, true, JSON.stringify(stop));
    strictEqual(notes.length, 1, 'the parent note ran once');
    strictEqual(notes[0].archivedPath, stop.to, 'on the archived file');
    deepStrictEqual([notes[0].entries, notes[0].records], [[op.id], [`${op.id}.json`]], 'the commit is open through the note');
    match(notes[0].release.refused, new RegExp(op.id));
    const archived = stop.to;
    strictEqual(existsSync(child), false);
    deepStrictEqual([fm(archived).persona_operations, opRecords(orch)], [undefined, []]);

    const rel = orch.release({ subtask: SUBTASK, holdId, lane, childPath: child });
    ok(rel.released, JSON.stringify(rel));
    strictEqual(rel.basis.workflow, null, 'no active child to digest');
    strictEqual(orch.compare({ subtask: SUBTASK, lane, childPath: child }).state, 'consumed');
    deepStrictEqual(orch.resumeFrom({ childPath: child, archivedPath: archived }), { action: 'wait-to-land' });
  }));

  it('no child: an unlinked bootstrap is refused in the held lane; hand work is compared, and the driver dispatches', () => withLane(async (ctx) => {
    const { lane, orch, git } = ctx;
    orch.activate();
    const holdId = orch.hold({ subtask: SUBTASK, branch: BRANCH, lane: 'lane-1', child: null });
    deepStrictEqual(orch.handoff(SUBTASK, null), { state: 'held', blockers: [] });

    const refused = bootstrap(lane, personEnv());
    notStrictEqual(refused.status, 0, 'item 5');
    match(refused.stderr, /is a held lane of macro-plan-20261025T000000Z-abcdef \(subtask hold-persona: hold [0-9a-f]{16} is held\).*Decision 2, item 5/);
    strictEqual(activeChild(lane), '', 'no workflow was created');

    writeFileSync(join(lane, 'plugins/engineer/a.mjs'), 'export const a = 3;\n');
    git('commit', '-q', '-am', 'fix(engineer): by hand', '--no-verify');
    const rel = orch.release({ subtask: SUBTASK, holdId, lane, childPath: null });
    ok(rel.released, JSON.stringify(rel));
    strictEqual(orch.compare({ subtask: SUBTASK, lane, childPath: null }).state, 'consumed');
    deepStrictEqual(orch.resumeFrom({ childPath: null }), { action: 'dispatch' });

    const boot = bootstrap(lane, workerEnv(2, { AGENTIC_PARENT_WORKFLOW: MACRO, AGENTIC_ORIGINATING_SUBTASK: SUBTASK, AGENTIC_TOPIC: 'Build the thing' }));
    strictEqual(boot.status, 0, boot.stderr);
    strictEqual(fm(activeChild(lane)).originating_subtask, SUBTASK);
  }));

  it("a peer run the session started itself: the release waits for its note; the run's ledger is not the child's", () => withLane(async (ctx) => {
    const { lane, orch } = ctx;
    const { child, holdId } = await workerStepThenHeld(ctx);
    const dispatchDir = textDir({ 'prompt.xml': '<task>x</task>' });
    const barrier = newBarrier();
    const env = { ...personEnv(), AGENTIC_COMPANIONS_ROOT: fakeCompanions({ barrier }) };
    const running = startBlock(lane, fill(regionBlock('commands/peer-now.md', 'peer-now-dispatch'), [
      ["TEXT_DIR='<directory from step 1>'", `TEXT_DIR='${dispatchDir}'`], ["PEER='<claude|codex, from --peer>'", "PEER='codex'"],
    ]), env);
    // While the peer runs, the consultation is an open operation and the
    // release refuses.
    await waitFor(`${barrier}.started`);
    const [op] = opsOf(child);
    strictEqual(op?.kind, 'peer');
    match(orch.release({ subtask: SUBTASK, holdId, lane, childPath: child }).refused, new RegExp(op.id));
    writeFileSync(barrier, '');
    const d = await running;
    strictEqual(d.status, 0, d.stderr);
    match(orch.release({ subtask: SUBTASK, holdId, lane, childPath: child }).refused, new RegExp(op.id), 'ended, it waits for its note');
    const n = runBlock(lane, fill(regionBlock('commands/peer-now.md', 'peer-now-note'), [["DISPATCH_DIR='<the directory the dispatch ran with>'", `DISPATCH_DIR='${dispatchDir}'`]]), env);
    strictEqual(n.status, 0, n.stderr);
    strictEqual(fm(child).persona_operations, undefined);
    ok(readFileSync(child, 'utf8').includes('### [Peer] codex consultation'));
    deepStrictEqual(fm(child).pending_ensemble ?? [], [], 'a consultation records no ensemble on the child');

    const rel = orch.release({ subtask: SUBTASK, holdId, lane, childPath: child });
    ok(rel.released, JSON.stringify(rel));
    strictEqual(orch.compare({ subtask: SUBTASK, lane, childPath: child }).state, 'consumed');
    const resume = orch.resumeFrom({ childPath: child });
    deepStrictEqual(resume, { action: 'dispatch-verb', verb: 'critique' });
    // The session's run stays in the ledger, naming no workflow; the resumed
    // worker's verb settles its own phase beside it (an empty id: no run of
    // its own launched).
    const runId = readFileSync(join(dispatchDir, 'prompt.xml.run-id'), 'utf8').trim();
    const handle = JSON.parse(readFileSync(join(resolve(child, '../..'), 'peer-runs', runId, 'handle.json'), 'utf8'));
    deepStrictEqual([handle.status, handle.workflow_path ?? null], ['completed', null]);
    const next = resumeVerb(lane, workerEnv(2), resume.verb);
    strictEqual(next.status, 0, next.stderr);
    strictEqual(fm(child).verb, 'critique');
    const done = finalize(lane, workerEnv(2), opDirOf(next), {}, '', resume.verb);
    strictEqual(done.status, 0, done.stderr);
    deepStrictEqual([fm(child).next_step_verb, fm(child).persona_operations], ['refine', undefined]);
  }));

  // The resumed worker's verb: it writes `file` (recorded in the child's
  // commit manifest) and records the next step commit; then its commit step.
  function resumedWorkerCommits(lane, child, file, text) {
    const next = resumeVerb(lane, workerEnv(2));
    strictEqual(next.status, 0, next.stderr);
    const op = existsSync(join(lane, file)) ? 'edit' : 'create';
    writeFileSync(join(lane, file), text);
    const rec = spawnSync(process.execPath, [STATE_BIN, 'record-composed-file', '--workflow-path', child, '--path', file, '--op', op], { cwd: lane, encoding: 'utf8', env: workerEnv(2) });
    strictEqual(rec.status, 0, rec.stderr);
    const fin = finalize(lane, workerEnv(2), opDirOf(next), { verb: 'commit', commit: true });
    strictEqual(fin.status, 0, fin.stderr);
    const c = runBlock(lane, regionBlock('commands/commit.md', 'commit-autopilot'), workerEnv(3));
    strictEqual(c.status, 0, `${c.stdout}\n${c.stderr}`);
    return JSON.parse(c.stdout);
  }

  it("a capture file at the runtime's session-capture path and a hand edit in no manifest: compared equal; the resumed worker's commit stops at the staging-set gate", () => withLane(async (ctx) => {
    const { lane, orch, git } = ctx;
    const { child, holdId } = await workerStepThenHeld(ctx);
    // The person's session: a hand edit (no operation: item 7's narrowing),
    // and a file where the runtime's session capture writes, in the lane's
    // state root (a synthetic file there; the runtime's writer does not run).
    writeFileSync(join(lane, 'plugins/engineer/a.mjs'), 'export const a = 4;\n');
    const capture = join(lane, '.agentic-plugins/state/runtime/session-capture');
    mkdirSync(capture, { recursive: true });
    writeFileSync(join(capture, 'note.json'), '{"schema":"runtime-session-note"}\n');

    const rel = orch.release({ subtask: SUBTASK, holdId, lane, childPath: child });
    ok(rel.released, JSON.stringify(rel));
    writeFileSync(join(capture, 'note.json'), '{"schema":"runtime-session-note","later":true}\n');
    strictEqual(orch.compare({ subtask: SUBTASK, lane, childPath: child }).state, 'consumed', 'the capture is ignored state, outside both digests');
    deepStrictEqual(orch.resumeFrom({ childPath: child }), { action: 'dispatch-verb', verb: 'critique' });

    const base = git('rev-parse', 'HEAD');
    const out = resumedWorkerCommits(lane, child, 'plugins/engineer/b.mjs', 'export const b = 1;\n');
    deepStrictEqual([out.action, out.staging_set, out.extras], ['staging-set', ['plugins/engineer/b.mjs'], ['plugins/engineer/a.mjs']]);
    strictEqual(git('rev-parse', 'HEAD'), base, 'nothing was committed');
    deepStrictEqual(orch.resumeFrom({ childPath: child }), { action: 'park', gate: 'staging-set' });
  }));

  for (const staged of [false, true]) {
    it(`a hand edit inside a manifest path, ${staged ? 'staged: the resumed worker\'s commit stops at the staging-set gate' : 'unstaged: it rides with the resumed worker\'s commit'}`, () => withLane(async (ctx) => {
      const { lane, orch, git } = ctx;
      const { child, holdId } = await workerStepThenHeld(ctx);
      writeFileSync(join(lane, 'plugins/engineer/a.mjs'), 'export const a = 0;\nexport const byHand = true;\n');
      if (staged) git('add', 'plugins/engineer/a.mjs');
      ok(orch.release({ subtask: SUBTASK, holdId, lane, childPath: child }).released);
      strictEqual(orch.compare({ subtask: SUBTASK, lane, childPath: child }).state, 'consumed');

      const base = git('rev-parse', 'HEAD');
      const out = resumedWorkerCommits(lane, child, 'plugins/engineer/a.mjs', `${readFileSync(join(lane, 'plugins/engineer/a.mjs'), 'utf8')}export const byWorker = true;\n`);
      if (staged) {
        strictEqual(out.action, 'staging-set', JSON.stringify(out));
        strictEqual(git('rev-parse', 'HEAD'), base);
        return;
      }
      strictEqual(out.action, 'committed', JSON.stringify(out));
      const committed = git('show', 'HEAD:plugins/engineer/a.mjs');
      ok(committed.includes('byHand') && committed.includes('byWorker'), committed);
    }));
  }

  it("the person's next step commit: the driver's commit step commits what the person's verb recorded", () => withLane(async (ctx) => {
    const { lane, orch, git } = ctx;
    const { child, holdId } = await workerStepThenHeld(ctx);
    const resumed = resumeVerb(lane, personEnv());
    strictEqual(resumed.status, 0, resumed.stderr);
    writeFileSync(join(lane, 'plugins/engineer/a.mjs'), 'export const a = 5;\n');
    const rec = spawnSync(process.execPath, [STATE_BIN, 'record-composed-file', '--workflow-path', child, '--path', 'plugins/engineer/a.mjs', '--op', 'edit'], { cwd: lane, encoding: 'utf8', env: personEnv() });
    strictEqual(rec.status, 0, rec.stderr);
    const fin = finalize(lane, personEnv(), opDirOf(resumed), { commit: true });
    strictEqual(fin.status, 0, fin.stderr);
    deepStrictEqual([fm(child).next_step_kind, fm(child).terminal_marker], ['commit', undefined]);
    ok(orch.release({ subtask: SUBTASK, holdId, lane, childPath: child }).released);
    strictEqual(orch.compare({ subtask: SUBTASK, lane, childPath: child }).state, 'consumed');
    deepStrictEqual(orch.resumeFrom({ childPath: child }), { action: 'commit' });

    const c = runBlock(lane, regionBlock('commands/commit.md', 'commit-autopilot'), workerEnv(2));
    strictEqual(c.status, 0, `${c.stdout}\n${c.stderr}`);
    strictEqual(JSON.parse(c.stdout).action, 'committed', c.stdout);
    strictEqual(git('show', 'HEAD:plugins/engineer/a.mjs'), 'export const a = 5;');
  }));

  it("the person's owner decision: the gate is recorded, the workflow stays open, and the driver parks the lane", () => withLane(async (ctx) => {
    const { lane, orch } = ctx;
    const { child, holdId } = await workerStepThenHeld(ctx);
    const resumed = resumeVerb(lane, personEnv());
    strictEqual(resumed.status, 0, resumed.stderr);
    const fin = finalize(lane, personEnv(), opDirOf(resumed), { gate: true });
    strictEqual(fin.status, 0, fin.stderr);
    const f = fm(child);
    deepStrictEqual([f.next_step_kind, f.awaiting_owner_gate, f.terminal_marker, f.persona_operations], ['owner-decision', 'scope-routing', undefined, undefined]);
    ok(orch.release({ subtask: SUBTASK, holdId, lane, childPath: child }).released);
    strictEqual(orch.compare({ subtask: SUBTASK, lane, childPath: child }).state, 'consumed');
    deepStrictEqual(orch.resumeFrom({ childPath: child }), { action: 'park', gate: 'scope-routing' });
  }));

  it("the handoff waits on an operation the child's entry alone shows (begun before activation), and on the workflow's file lock", () => withLane(async (ctx) => {
    const { lane, orch } = ctx;
    // Step 1 dispatched before a hold-aware orchestrator ran: no record.
    const boot = bootstrap(lane, workerEnv(1, { AGENTIC_PARENT_WORKFLOW: MACRO, AGENTIC_ORIGINATING_SUBTASK: SUBTASK, AGENTIC_TOPIC: 'Build the thing' }));
    strictEqual(boot.status, 0, boot.stderr);
    const child = activeChild(lane);
    const [entry] = opsOf(child);
    strictEqual(entry.ext, false);
    orch.activate();
    deepStrictEqual(opRecords(orch), []);
    orch.hold({ subtask: SUBTASK, branch: BRANCH, lane: 'lane-1', child: fm(child).workflow_id });
    deepStrictEqual(orch.handoff(SUBTASK, child), { state: 'pending', blockers: [`persona operation ${entry.id} (entry)`] });
    const fin = finalize(lane, workerEnv(1), opDirOf(boot));
    strictEqual(fin.status, 0, fin.stderr);
    strictEqual(fm(child).persona_operations, undefined);
    // A writer holding the workflow's lock, with nothing else open: the Stop
    // hook's snapshot, the one write a held lane admits outside an operation.
    await engineer.withFileLock(child, async () => {
      deepStrictEqual(orch.handoff(SUBTASK, child), { state: 'pending', blockers: ['the workflow file lock'] });
    }, { env: process.env, hold: false, writer: 'snapshot' });
    deepStrictEqual(orch.handoff(SUBTASK, child), { state: 'held', blockers: [] });
  }));
});

// A companions root whose discovery answers with a companion (as
// tests/persona-pipeline/test-peer-runner.mjs fakes it), which the real peer
// runner launches. It answers at once, or, given `barrier`, writes
// `<barrier>.started` and answers once `<barrier>` exists.
function fakeCompanions({ barrier = null } = {}) {
  const root = tempDir('hold-companions-');
  writeFileSync(join(root, 'discover-peer.mjs'), `
export async function discoverPeerCompanion({ peer } = {}) {
  if (peer !== 'claude' && peer !== 'codex') return { ok: false, reason: 'bad peer' };
  return { ok: true, path: new URL('./' + peer + '-companion.mjs', import.meta.url).pathname };
}
`);
  for (const peer of ['claude', 'codex']) {
    const p = join(root, `${peer}-companion.mjs`);
    writeFileSync(p, `#!/usr/bin/env node
if (process.argv[2] !== 'task') process.exit(2);
const barrier = ${JSON.stringify(barrier)};
if (barrier) {
  const fs = await import('node:fs');
  fs.writeFileSync(barrier + '.started', '');
  // Never outlives a test that failed before opening it.
  const until = Date.now() + 60_000;
  while (!fs.existsSync(barrier) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
}
process.stdout.write(JSON.stringify({ status: 'success', peer_host: '${peer}', peer_model: null, stdout: 'the answer', exit_code: 0 }));
`);
    chmodSync(p, 0o755);
  }
  return root;
}

// A finding for impl-hold, measured here: the tree digest of Decision 2,
// item 7 covers every non-ignored file, and the persona's records live in the
// checkout's state root. In a repository that does not ignore
// `.agentic-plugins/`, with shared creation off, the session's own Stop
// snapshot after the release (a write the content digest leaves out, N6)
// moves the tree digest, so the release is rejected with no edit of anyone's.
describe('finding: a repository that does not ignore .agentic-plugins/', () => {
  it("the session's Stop snapshot after the release moves the tree digest", () => withLaneIn(false, async (ctx) => {
    const { lane, orch } = ctx;
    const { child, holdId } = await workerStepThenHeld(ctx);
    ok(orch.release({ subtask: SUBTASK, holdId, lane, childPath: child }).released);
    await snapshotAtStop(child, 1);
    const cmp = orch.compare({ subtask: SUBTASK, lane, childPath: child });
    strictEqual(cmp.now.workflow, cmp.basis.workflow, 'the content digest leaves the snapshot out');
    notStrictEqual(cmp.now.tree, cmp.basis.tree, 'the tree digest does not');
    strictEqual(cmp.state, 'rejected');
  }, { ignoreState: false }));
});
