// ADR-0068 Decision 2, item 7 (implementation note of 2026-10-25, N4) — every
// command that writes a macro's child is either a persona operation or refuses
// in a held lane. Each lock of a workflow names its writer class
// (LANE_WRITERS); holding the lock, a `plain` write of a held lane's child with
// no operation open on it is refused, as it is while the holds cannot be read.
// The inventory below holds every lock site, every CLI subcommand and every
// script that imports a writer to a class, so a new writer fails here until
// it is classified. Inert before a hold-aware orchestrator marked the macro
// (N2, item 9).

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, rejects, strictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { personaInfo, personasFor } from './_personas.mjs';

const MACRO = 'macro-plan-20261025T000000Z-abcdef';
const SUBTASK = 'hold-persona';
const AUTOPILOT = '.agentic-plugins/runs/autopilot';
const MARKER = { schema: 'agentic-holds-protocol-1', protocol: 1, written_by: 'orchestrator@test', at: '2026-10-25T00:00:00Z' };
const HOLD = { schema: 'agentic-hold-1', hold_id: '00112233445566ff', subtask_id: SUBTASK, branch: 'main', lane: null, child: null, state: 'held', set_by: 'owner', set_at: '2026-10-25T00:00:00Z' };
const REFUSED = /is held \(hold 00112233445566ff is held\), and no persona operation is open on .*outside a persona operation is refused.*\(ADR-0068 Decision 2, item 7\)/;
const UNREADABLE = /the holds directory of macro-plan-20261025T000000Z-abcdef cannot be read .*and no persona operation is open on .*\(ADR-0068 Decision 2, item 7\)/;

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_')));
// The Stop hook runs in this process, and its sweep's git reads process.env:
// no AGENTIC_* (this session's run) and no GIT_* (an inherited GIT_DIR would
// point the sweep's branch check at another repository).
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AGENTIC_') || k.startsWith('GIT_')) delete process.env[k];
}

async function withRepo(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hold-writers-')));
  const scratch = [];
  const tempDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'hold-writers-op-'));
    scratch.push(d);
    return d;
  };
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: cleanEnv() }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, '.git/info/exclude'), '.agentic-plugins/\n');
    writeFileSync(join(dir, 'README.md'), 'x\n');
    git('add', '.');
    git('commit', '-q', '-m', 'feat: base');
    return await fn({ dir, head: git('rev-parse', 'HEAD'), git, tempDir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const d of scratch) rmSync(d, { recursive: true, force: true });
  }
}

function holdsFile(dir, rel, value) {
  const p = join(dir, AUTOPILOT, 'holds', MACRO, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
}
const activate = (dir) => holdsFile(dir, 'protocol.json', MARKER);
const holdOn = (dir, hold = HOLD) => holdsFile(dir, `holds/${SUBTASK}.json`, hold);

const engineer = await import(pathToFileURL(personaInfo('engineer').path('scripts/state.mjs')).href);
const stop = await import(pathToFileURL(personaInfo('engineer').path('scripts/stop-archive.mjs')).href);
const fmOf = (state, p) => state.parseWorkflowFile(readFileSync(p, 'utf8')).frontmatter;

// A macro's child, created before the hold (a held lane refuses a create
// outside an operation), its verb's operation open when `operationDir` is set.
const child = (state, persona, dir, head, { operationDir, branch = 'main' } = {}) => state.createWorkflow({
  repoRoot: dir, verb: 'compose', host: 'claude', persona, originalRequest: 'hold',
  gitBaseline: { branch, head, status_digest: '' }, env: cleanEnv(),
  parentWorkflow: MACRO, originatingSubtask: SUBTASK, ...(operationDir ? { operationDir } : {}),
});

// The plain writers a person could run by hand in a held lane, outside any
// operation: each is refused and writes nothing.
const PLAIN = [
  ['append (no operation directory)', (s, wf) => s.appendPhase({ workflowPath: wf, host: 'claude', phaseLabel: 'x', phaseNote: 'x', env: cleanEnv() })],
  ['set-terminal (no operation directory)', (s, wf) => s.setTerminal({ workflowPath: wf, host: 'claude', terminalPhase: 'summary-complete', env: cleanEnv() })],
  ['record-composed-file', (s, wf) => s.recordComposedFile({ workflowPath: wf, path: 'README.md', op: 'edit', host: 'claude', env: cleanEnv() })],
  ['ensemble-pending', (s, wf) => s.recordPendingEnsemble({ workflowPath: wf, phase: 'compose', ensemble_type: 'plan-verify', run_id: 'plan-verify-20261025T000000Z-aaaaaa', env: cleanEnv() })],
  ['awaiting-owner-set', (s, wf) => s.setAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'scope-routing', pointer: 'x#y', env: cleanEnv() })],
  ['set-parent-writeback-marker', (s, wf) => s.setParentWritebackMarker({ workflowPath: wf, host: 'claude', at: '2026-10-25T00:00:00Z', env: cleanEnv() })],
  ['ensemble-commit of a run the child never recorded', (s, wf) => s.commitEnsemble({
    workflowPath: wf, run_id: 'plan-verify-20261025T000000Z-bbbbbb', phase: 'compose', ensemble_type: 'plan-verify', verdict: 'agreed', summary: 'x', env: cleanEnv(),
  })],
  ['archive outside an operation', (s, wf, dir) => s.archiveWorkflow({ workflowPath: wf, host: 'claude', repoRoot: dir, env: cleanEnv() })],
];

describe('engineer: a held lane refuses a write of its child outside a persona operation', () => {
  for (const [name, write] of PLAIN) {
    it(`${name}: refused, nothing written`, () => withRepo(async ({ dir, head }) => {
      activate(dir);
      const { filePath } = await child(engineer, 'engineer', dir, head);
      holdOn(dir);
      const before = readFileSync(filePath, 'utf8');
      await rejects(write(engineer, filePath, dir), REFUSED);
      strictEqual(readFileSync(filePath, 'utf8'), before);
    }));
  }

  it('the same writes are admitted while an operation is open on the child', () => withRepo(async ({ dir, head, tempDir }) => {
    activate(dir);
    const { filePath } = await child(engineer, 'engineer', dir, head, { operationDir: tempDir() });
    holdOn(dir);
    // The archive last: it moves the file.
    for (const [, write] of PLAIN) await write(engineer, filePath, dir);
    ok(!existsSync(filePath), 'archived');
  }));

  it('an operation the owner cleared no longer admits them', () => withRepo(async ({ dir, head, tempDir }) => {
    activate(dir);
    const { filePath } = await child(engineer, 'engineer', dir, head, { operationDir: tempDir() });
    const [op] = engineer.parseWorkflowFile(readFileSync(filePath, 'utf8')).frontmatter.persona_operations.ops;
    holdsFile(dir, `ops/${SUBTASK}/${op.id}.cleared`, '');
    holdOn(dir);
    await rejects(engineer.recordComposedFile({ workflowPath: filePath, path: 'README.md', op: 'edit', host: 'claude', env: cleanEnv() }), REFUSED);
  }));

  it('a hold set while the write waits for the workflow\'s lock refuses it', () => withRepo(async ({ dir, head }) => {
    activate(dir);
    const { filePath } = await child(engineer, 'engineer', dir, head);
    const before = readFileSync(filePath, 'utf8');
    let pending;
    await engineer.withFileLock(filePath, async () => {
      pending = engineer.recordComposedFile({ workflowPath: filePath, path: 'README.md', op: 'edit', host: 'claude', env: cleanEnv() });
      await new Promise((r) => { setTimeout(r, 300); });
      holdOn(dir);
    }, { env: cleanEnv(), hold: false, writer: engineer.LANE_WRITERS.snapshot });
    await rejects(pending, REFUSED);
    strictEqual(readFileSync(filePath, 'utf8'), before);
  }));

  it('the CLI refuses with the reason and a nonzero exit', () => withRepo(async ({ dir, head }) => {
    activate(dir);
    const { filePath } = await child(engineer, 'engineer', dir, head);
    holdOn(dir);
    const r = spawnSync(process.execPath, [personaInfo('engineer').path('scripts/state.mjs'), 'record-composed-file', '--workflow-path', filePath,
      '--path', 'README.md', '--op', 'edit', '--host', 'claude'], { cwd: dir, encoding: 'utf8', env: cleanEnv() });
    ok(r.status !== 0, 'refused');
    match(r.stderr, REFUSED);
  }));

  for (const [why, setup] of [
    ['no marker (inactive)', (dir) => holdOn(dir)],
    ['a released hold', (dir) => { activate(dir); holdOn(dir, { ...HOLD, state: 'released' }); }],
    ['an orphaned hold', (dir) => { activate(dir); holdOn(dir, { ...HOLD, orphaned: { at: '2026-10-25T00:00:00Z', why: 'left the plan' } }); }],
    ['a hold on another branch', (dir) => { activate(dir); holdOn(dir, { ...HOLD, branch: 'feat/other' }); }],
    ['no hold', (dir) => activate(dir)],
  ]) {
    it(`with ${why}, a write outside an operation is as before`, () => withRepo(async ({ dir, head }) => {
      const { filePath } = await child(engineer, 'engineer', dir, head);
      setup(dir);
      await engineer.recordComposedFile({ workflowPath: filePath, path: 'README.md', op: 'edit', host: 'claude', env: cleanEnv() });
      strictEqual(fmOf(engineer, filePath).commit_manifest?.length, 1);
    }));
  }

  it('an unreadable hold record refuses it, as a hold does', () => withRepo(async ({ dir, head }) => {
    activate(dir);
    const { filePath } = await child(engineer, 'engineer', dir, head);
    holdOn(dir, '{');
    await rejects(engineer.recordComposedFile({ workflowPath: filePath, path: 'README.md', op: 'edit', host: 'claude', env: cleanEnv() }), /is held \(the hold record cannot be read/);
  }));

  it('while the holds cannot be read, it is refused with none open, admitted with one open', () => withRepo(async ({ dir, head, tempDir }) => {
    const plain = await child(engineer, 'engineer', dir, head);
    holdsFile(dir, 'protocol.json', '{');
    await rejects(engineer.recordComposedFile({ workflowPath: plain.filePath, path: 'README.md', op: 'edit', host: 'claude', env: cleanEnv() }), UNREADABLE);
    rmSync(plain.filePath);
    rmSync(join(dir, AUTOPILOT, 'holds', MACRO, 'protocol.json'));
    const open = await child(engineer, 'engineer', dir, head, { operationDir: tempDir() });
    holdsFile(dir, 'protocol.json', '{');
    await engineer.recordComposedFile({ workflowPath: open.filePath, path: 'README.md', op: 'edit', host: 'claude', env: cleanEnv() });
    strictEqual(fmOf(engineer, open.filePath).commit_manifest?.length, 1);
  }));

  it('operations of a later version, which cannot be read, do not admit it in a held lane', () => withRepo(async ({ dir, head }) => {
    activate(dir);
    const { filePath } = await child(engineer, 'engineer', dir, head);
    const text = readFileSync(filePath, 'utf8');
    const end = text.indexOf('\n---\n', 4);
    const doc = JSON.stringify({ v: 2, ops: [{ id: 'op-20261025T000000Z-0badf00d', kind: 'verb', opened_at: '2026-10-25T00:00:00Z', ext: true }] });
    writeFileSync(filePath, `${text.slice(0, end)}\npersona_operations: ${JSON.stringify(doc)}${text.slice(end)}`);
    holdOn(dir);
    await rejects(engineer.recordComposedFile({ workflowPath: filePath, path: 'README.md', op: 'edit', host: 'claude', env: cleanEnv() }), /are a later version \(v 2\)/);
  }));

  it('a linked bootstrap with no operation is refused in a held lane, and withdrawn', () => withRepo(async ({ dir, head, tempDir }) => {
    activate(dir);
    holdOn(dir);
    await rejects(child(engineer, 'engineer', dir, head), REFUSED);
    const home = join(dir, personaInfo('engineer').workflowDirRel);
    deepStrictEqual(existsSync(home) ? readdirSync(home).filter((n) => n.endsWith('.md')) : [], []);
    // As its operation's first write it is admitted.
    const { filePath } = await child(engineer, 'engineer', dir, head, { operationDir: tempDir() });
    ok(existsSync(filePath));
  }));
});

describe('engineer: the writers a held lane admits outside an operation', () => {
  it('the Stop and PreCompact snapshot (fields the content digest leaves out)', () => withRepo(async ({ dir, head }) => {
    activate(dir);
    const { filePath } = await child(engineer, 'engineer', dir, head);
    holdOn(dir);
    const digest = (await engineer.contentDigest(filePath)).digest;
    for (const trigger of ['stop', 'pre-compact']) await engineer.snapshot({ workflowPath: filePath, host: 'claude', trigger, env: cleanEnv() });
    strictEqual(fmOf(engineer, filePath).last_snapshot.trigger, 'pre-compact');
    strictEqual((await engineer.contentDigest(filePath)).digest, digest);
  }));

  it("the settlement of a run the child records (a step running when the hold was set settles, item 4)", () => withRepo(async ({ dir, head, tempDir }) => {
    activate(dir);
    const operationDir = tempDir();
    const { filePath } = await child(engineer, 'engineer', dir, head, { operationDir });
    const runId = 'plan-verify-20261025T000000Z-cccccc';
    await engineer.recordPendingEnsemble({ workflowPath: filePath, phase: 'compose', ensemble_type: 'plan-verify', run_id: runId, env: cleanEnv() });
    // The verb's operation ends (its finish-verb), leaving the run pending.
    await engineer.appendPhase({ workflowPath: filePath, host: 'claude', phaseLabel: 'x', phaseNote: 'x', operationDir, closeOperation: true, env: cleanEnv() });
    strictEqual(fmOf(engineer, filePath).persona_operations, undefined);
    holdOn(dir);
    const settle = () => engineer.commitEnsemble({
      workflowPath: filePath, run_id: runId, phase: 'compose', ensemble_type: 'plan-verify', verdict: 'failed', summary: 'x', env: cleanEnv(),
    });
    await settle();
    const fm = fmOf(engineer, filePath);
    deepStrictEqual([fm.pending_ensemble ?? [], fm.ensemble_results.map((e) => e.run_id)], [[], [runId]]);
    // Settled again, it records nothing more, and is not refused.
    strictEqual((await settle()).idempotentSkip, true);
  }));

  it("a result, end or pass of the driver's batch is admitted; it is refused only by its own checks", () => withRepo(async ({ dir, head }) => {
    activate(dir);
    const { filePath } = await child(engineer, 'engineer', dir, head);
    holdOn(dir);
    // No request is pending: the batch's own check refuses the pass, not the hold.
    await rejects(engineer.recordPass({ workflowPath: filePath, host: 'claude', requestId: 'r1', batchId: 'b1' }),
      (err) => !/item 7/.test(err.message));
  }));

  it("the orchestrator's lifecycle archive (abort, finalize) is an operation of its own", () => withRepo(async ({ dir, head }) => {
    activate(dir);
    const { filePath } = await child(engineer, 'engineer', dir, head);
    holdOn(dir);
    const r = await engineer.detachArchive({ workflowPath: filePath, host: 'claude', repoRoot: dir, env: cleanEnv() });
    strictEqual(r.detached, true);
    const fm = fmOf(engineer, r.to);
    deepStrictEqual([fm.parent_detached, fm.persona_operations], [true, undefined]);
    // Its record went once the archive released its locks.
    deepStrictEqual(readdirSync(join(dir, AUTOPILOT, 'holds', MACRO, 'ops', SUBTASK)), []);
  }));

  it('the lifecycle archive is refused beside another open operation, and while the holds cannot be read', () => withRepo(async ({ dir, head, tempDir }) => {
    activate(dir);
    const { filePath } = await child(engineer, 'engineer', dir, head, { operationDir: tempDir() });
    holdOn(dir);
    const before = readFileSync(filePath, 'utf8');
    await rejects(engineer.detachArchive({ workflowPath: filePath, host: 'claude', repoRoot: dir, env: cleanEnv() }), /one persona operation at a time in a lane/);
    strictEqual(readFileSync(filePath, 'utf8'), before);
    holdsFile(dir, 'protocol.json', '{');
    await rejects(engineer.detachArchive({ workflowPath: filePath, host: 'claude', repoRoot: dir, env: cleanEnv() }), /cannot be read/);
    strictEqual(readFileSync(filePath, 'utf8'), before);
  }));

  it('inactive, the lifecycle archive is as before: nothing of its operation stays on the archived file', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await child(engineer, 'engineer', dir, head);
    const r = await engineer.detachArchive({ workflowPath: filePath, host: 'claude', repoRoot: dir, env: cleanEnv() });
    strictEqual(r.detached, true);
    strictEqual(fmOf(engineer, r.to).persona_operations, undefined);
    ok(!existsSync(join(dir, AUTOPILOT, 'holds')), 'no holds directory made');
  }));
});

describe('engineer: the review findings of Task 8', () => {
  it("an archive that ends a named operation is refused once that operation is gone, never riding another's entry", () => withRepo(async ({ dir, head, tempDir }) => {
    activate(dir);
    // The lifecycle archive's operation was cleared and a verb took the lane
    // between its mark and its archive: only the verb's entry is open.
    const { filePath } = await child(engineer, 'engineer', dir, head, { operationDir: tempDir() });
    holdOn(dir);
    await rejects(engineer.archiveWorkflow({
      workflowPath: filePath, host: 'claude', repoRoot: dir, env: cleanEnv(), closeOperationKind: 'archive', closeOperationId: 'op-20261025T000000Z-0badf00d',
    }), /operation op-20261025T000000Z-0badf00d \(archive\) is no longer open/);
    ok(existsSync(filePath), 'not archived');
  }));

  it('a batch start is refused in a held lane even beside an open operation', () => withRepo(async ({ dir, head, tempDir }) => {
    activate(dir);
    const { filePath } = await child(engineer, 'engineer', dir, head, { operationDir: tempDir() });
    holdOn(dir);
    const fm = fmOf(engineer, filePath);
    match(engineer.laneWriterRefusal(filePath, fm, { writer: engineer.LANE_WRITERS.job }), /no machine job starts in a held lane/);
    // The same lane, a plain write: admitted beside the operation.
    strictEqual(engineer.laneWriterRefusal(filePath, fm), null);
    // Released, the job starts.
    holdOn(dir, { ...HOLD, state: 'released' });
    strictEqual(engineer.laneWriterRefusal(filePath, fm, { writer: engineer.LANE_WRITERS.job }), null);
  }));

  for (const [name, launch] of [
    ['peer-runner run', async (dir, wf, env) => {
      const runner = await import(pathToFileURL(personaInfo('engineer').path('scripts/peer-runner.mjs')).href);
      const r = await runner.runPeer({
        repoRoot: dir, peer: 'claude', promptText: 'x', cwd: dir, env, kind: 'ensemble', workflowPath: wf, phase: 'compose',
        ensembleType: 'plan-verify', runId: 'plan-verify-20261025T000000Z-dddddd',
      });
      strictEqual(r.status, 'failed');
      strictEqual(JSON.parse(readFileSync(r.handle_path, 'utf8')).error_kind, 'held_lane');
    }],
    ['dispatch-peer', async (dir, wf, env) => {
      const dispatcher = await import(pathToFileURL(personaInfo('engineer').path('scripts/dispatch-peer.mjs')).href);
      const r = await dispatcher.dispatchPeer({
        peer: 'claude', promptText: 'x', cwd: dir, env,
        ensembleBookkeeping: { workflowPath: wf, phase: 'compose', ensembleType: 'plan-verify', runId: 'plan-verify-20261025T000000Z-eeeeee' },
      });
      deepStrictEqual([r.ok, r.kind], [false, 'held_lane']);
      match(r.stderr, /outside a persona operation is refused/);
    }],
  ]) {
    it(`${name}: a pending registration a held lane refuses stops the launch before the companion`, () => withRepo(async ({ dir, head, tempDir }) => {
      activate(dir);
      const { filePath } = await child(engineer, 'engineer', dir, head);
      holdOn(dir);
      const companions = tempDir();
      const marker = join(companions, 'ran');
      writeFileSync(join(companions, 'discover-peer.mjs'),
        "export async function discoverPeerCompanion({ peer } = {}) { return { ok: true, path: new URL('./' + peer + '-companion.mjs', import.meta.url).pathname }; }\n");
      writeFileSync(join(companions, 'claude-companion.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'x');\n`);
      await launch(dir, filePath, { ...cleanEnv(), AGENTIC_COMPANIONS_ROOT: companions });
      strictEqual(existsSync(marker), false, 'the companion never ran');
      strictEqual(fmOf(engineer, filePath).pending_ensemble?.length ?? 0, 0);
    }));
  }
});

describe('engineer: the Stop hook in a held lane', () => {
  it("the Stop lifecycle leaves a terminal child with no operation open, and archives it once released", () => withRepo(async ({ dir, head, git }) => {
    activate(dir);
    const { filePath } = await child(engineer, 'engineer', dir, head);
    await engineer.setTerminal({ workflowPath: filePath, host: 'claude', terminalPhase: 'summary-complete', env: cleanEnv() });
    holdOn(dir);
    writeFileSync(join(dir, 'README.md'), 'y\n');
    git('commit', '-qam', 'feat: by hand');
    const lines = [];
    const args = { workflowPath: filePath, host: 'claude', repoRoot: dir, headSha: git('rev-parse', 'HEAD'), headSubject: 'feat: by hand', stderr: { write: (s) => lines.push(s) } };
    const left = await stop.runStopArchive(args);
    deepStrictEqual(left, { archived: false, reason: 'held-lane' });
    ok(existsSync(filePath));
    match(lines.join(''), /leaves .*is held/);
    holdOn(dir, { ...HOLD, state: 'released' });
    strictEqual((await stop.runStopArchive(args)).archived, true);
  }));

  it("the orphan sweep from another lane's session leaves a held lane's child", () => withRepo(async ({ dir, head, git }) => {
    activate(dir);
    git('checkout', '-q', '-b', 'feat/gone');
    const { filePath } = await child(engineer, 'engineer', dir, head, { branch: 'feat/gone' });
    await engineer.setTerminal({ workflowPath: filePath, host: 'claude', terminalPhase: 'summary-complete', env: cleanEnv() });
    git('checkout', '-q', 'main');
    git('branch', '-q', '-D', 'feat/gone');
    holdOn(dir, { ...HOLD, branch: 'feat/gone' });
    const lines = [];
    deepStrictEqual(await stop.runStopArchiveOrphanSweep({ repoRoot: dir, host: 'claude', stderr: { write: (s) => lines.push(s) } }), []);
    ok(existsSync(filePath));
    match(lines.join(''), /orphan-sweep leaves .*is held/);
    // Released, the next sweep archives it.
    holdOn(dir, { ...HOLD, branch: 'feat/gone', state: 'released' });
    deepStrictEqual((await stop.runStopArchiveOrphanSweep({ repoRoot: dir, host: 'claude', stderr: { write() {} } })).map((x) => x.archived), [true]);
  }));
});

for (const persona of personasFor('scripts/state.mjs').filter((p) => p !== 'engineer')) {
  const state = await import(pathToFileURL(personaInfo(persona).path('scripts/state.mjs')).href);
  describe(`${persona}: writes are unchanged beside holds (dispatch_target off)`, () => {
    it('a plain write of a workflow carrying linkage, in a held lane, is admitted', () => withRepo(async ({ dir, head }) => {
      // Begun before the hold: a held lane refuses an unlinked bootstrap
      // (item 5), and every bootstrap of this persona is unlinked.
      const { filePath } = await state.createWorkflow({
        repoRoot: dir, verb: 'compose', host: 'claude', persona, originalRequest: 'hold',
        gitBaseline: { branch: 'main', head, status_digest: '' }, env: cleanEnv(),
      });
      // The linkage as data this persona only carries.
      const text = readFileSync(filePath, 'utf8');
      const end = text.indexOf('\n---\n', 4);
      writeFileSync(filePath, `${text.slice(0, end)}\nparent_workflow: "${MACRO}"\noriginating_subtask: "${SUBTASK}"${text.slice(end)}`);
      activate(dir);
      holdOn(dir);
      await state.appendPhase({ workflowPath: filePath, host: 'claude', phaseLabel: 'x', phaseNote: 'x', env: cleanEnv() });
      await state.setTerminal({ workflowPath: filePath, host: 'claude', terminalPhase: 'summary-complete', env: cleanEnv() });
      strictEqual(fmOf(state, filePath).terminal_marker, true);
      strictEqual(state.laneWriterRefusal(filePath, fmOf(state, filePath)), null);
    }));
  });
}

// --- the inventory ------------------------------------------------------------

// Every lock of a workflow in state.mjs, by the function that takes it: the
// number of its locks and every writer class its text names. A new lock, or a
// class changed, fails here until it is classified.
const LOCK_SITES = {
  createWorkflowUnderLock: { calls: 1, writers: ['writerOf(operation)', 'LANE_WRITERS.create'] },
  appendPhase: { calls: 1, writers: ['writerOf(operation)'] },
  snapshot: { calls: 1, writers: ['LANE_WRITERS.snapshot'] },
  recordPendingEnsemble: { calls: 1, writers: ['LANE_WRITERS.plain'] },
  commitEnsemble: { calls: 1, writers: ['LANE_WRITERS.settlement'] },
  recordManifestEntry: { calls: 1, writers: ['LANE_WRITERS.plain'] },
  setCheckpoint: { calls: 1, writers: ['writerOf(operation)'] },
  setTerminal: { calls: 1, writers: ['writerOf(operation)'] },
  writeConsensusTask: { calls: 1, writers: ['LANE_WRITERS.plain'] },
  openCritiqueScope: { calls: 1, writers: ['LANE_WRITERS.plain'] },
  closeCritiqueScope: { calls: 1, writers: ['LANE_WRITERS.plain'] },
  recordRefineScope: { calls: 1, writers: ['LANE_WRITERS.plain'] },
  setAwaitingOwner: { calls: 1, writers: ['LANE_WRITERS.plain'] },
  clearAwaitingOwner: { calls: 1, writers: ['writerOf(operation)'] },
  recordVerifyRequest: { calls: 1, writers: ['writerOf(operation)'] },
  verifyWrite: { calls: 1, writers: ['=LANE_WRITERS.job', 'writer'] },
  setParentWritebackMarker: { calls: 1, writers: ['LANE_WRITERS.plain'] },
  clearParentWritebackMarker: { calls: 1, writers: ['LANE_WRITERS.plain'] },
  beginCommit: { calls: 1, writers: ['writerOf(operation)'] },
  endChildOperation: { calls: 1, writers: ['writerOf(operation)', 'writerOf(operation)'] },
  bookkeepOperation: { calls: 1, writers: ['writerOf(operation)'] },
  detachArchive: { calls: 1, writers: ['writerOf(operation)'] },
  archiveWorkflow: { calls: 1, writers: ['=LANE_WRITERS.plain', 'writerOf(operation)', 'writer', 'writer'] },
  archiveCandidateWithRaceRetry: { calls: 1, writers: ['LANE_WRITERS.destination'] },
};

// verifyWrite's callers: a batch's start and restart are `job` (verifyWrite's
// default: no machine job starts in a held lane, item 3); its results, end and
// pass continue a batch that was running (item 4).
const VERIFY_WRITERS = {
  recordBatchStart: null, recordBatchRestart: null,
  recordResult: 'LANE_WRITERS.machine', recordBatchEnd: 'LANE_WRITERS.machine', recordPass: 'LANE_WRITERS.machine',
};

// Every CLI subcommand: the ones that write a workflow (through the functions
// above) and the ones that only read, or write no workflow.
const WRITER_SUBCOMMANDS = [
  'create', 'append', 'operation', 'snapshot', 'ensemble-pending', 'ensemble-commit', 'checkpoint-set', 'record-composed-file',
  'record-refine-file', 'set-parent-writeback-marker', 'clear-parent-writeback-marker', 'set-terminal', 'awaiting-owner-set',
  'awaiting-owner-clear', 'consensus-task', 'critique-scope', 'critique-close', 'refine-record', 'finish-verb', 'verify-batch-start',
  'verify-batch-restart', 'verify-result', 'verify-batch-end', 'verify-pass', 'archive', 'detach-archive', 'stop-archive',
];
const READER_SUBCOMMANDS = [
  'find-active', 'resolve-workflow', 'list-workflows', 'dispatch-selection', 'read', 'review-status', 'ensemble-verdict',
  'consensus-proposal', 'autopilot-preflight', 'verify-results', 'verify-capability', 'hold-capability', 'content-digest',
  'diagnose-redundancy', 'check-clean-baseline', 'state-root', 'shared-creation',
];

// What every other script and hook imports from state.mjs: each writer among
// them is a function above, so its class is there.
const IMPORTS = {
  'scripts/dispatch-peer.mjs': ['LANE_WRITER_REFUSED', 'recordPendingEnsemble'],
  'scripts/peer-runner.mjs': ['ENSEMBLE_RESULTS_RETENTION_CAP', 'LANE_WRITER_REFUSED', 'assertWorkflowWritable', 'commitEnsemble', 'parseWorkflowFile', 'readTextArgumentFile', 'recordPendingEnsemble', 'resolveWorkflowStorage', 'workflowStorage'],
  'scripts/phase7-commit.mjs': ['appendPhase', 'archiveWorkflow', 'autopilotMode', 'beginCommit', 'clearParentWritebackMarker', 'endChildOperation', 'noActiveChildrenCheck', 'noPendingEnsembleCheck', 'parseWorkflowFile', 'readTextArgumentFile', 'setParentWritebackMarker', 'setTerminal'],
  'scripts/session-handoff.mjs': ['branchTip', 'checkedOutBranch', 'currentGitBranch', 'findActiveWorkflowByBranch', 'legacyStateDirRel', 'readWorkflow', 'terminalPhases', 'workflowDir', 'workflowStateRoot'],
  'scripts/stop-archive.mjs': ['archiveWorkflow', 'branchRefState', 'branchTip', 'checkedOutBranch', 'closeArchivedCommit', 'descendsFrom', 'laneWriterRefusal', 'listWorkflowFilesAllHomes', 'noActiveChildrenCheck', 'parseWorkflowFile', 'snapshot', 'sweepLeavesChild', 'terminalMarkerCheck', 'terminalPhaseCheck'],
  'adapters/claude/hooks/pre-compact.mjs': ['findActiveWorkflow', 'snapshot'],
  'adapters/claude/hooks/session-start.mjs': ['findActiveWorkflow', 'readWorkflow'],
  'adapters/claude/hooks/stop.mjs': ['findActiveWorkflow', 'readWorkflow'],
  'adapters/codex/hooks/pre-compact.mjs': ['findActiveWorkflow', 'snapshot'],
  'adapters/codex/hooks/session-start.mjs': ['findActiveWorkflow', 'readWorkflow'],
  'adapters/codex/hooks/stop.mjs': ['findActiveWorkflow', 'readWorkflow'],
};

// Every mention of withFileLock in state.mjs: its definition, the calls above
// and the comments and messages that name it.
const WITH_FILE_LOCK_MENTIONS = 56;

const FUNCTION_RE = /^(?:export )?(?:async )?function (\w+)/gm;

function lockSites(src) {
  const starts = [...src.matchAll(FUNCTION_RE)].map((m) => ({ name: m[1], at: m.index }));
  const sites = {};
  let total = 0;
  for (const m of src.matchAll(/withFileLock\(/g)) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const line = src.slice(lineStart, src.indexOf('\n', m.index));
    const before = line.slice(0, m.index - lineStart);
    // Comments, the definition and text in a message are no lock.
    if (/^\s*(\/\/|\*)/.test(line) || /function $/.test(before) || /[`'"][^`'"]*$/.test(before)) continue;
    total += 1;
    const fn = starts.filter((s) => s.at < m.index).at(-1);
    const end = starts.find((s) => s.at > fn.at)?.at ?? src.length;
    const body = src.slice(fn.at, end);
    sites[fn.name] ??= {
      calls: 0,
      writers: [...body.matchAll(/\bwriter(?:: ([^,}\n]+)| = ([^,}\n)]+)|(?=\s*[,}]))/g)].map((w) => (w[1] ?? (w[2] ? `=${w[2]}` : 'writer')).trim()),
    };
    sites[fn.name].calls += 1;
  }
  return { sites, total };
}

for (const persona of personasFor('scripts/state.mjs')) {
  const root = personaInfo(persona).root;
  const src = readFileSync(join(root, 'scripts/state.mjs'), 'utf8');
  describe(`${persona}: the writer inventory (Decision 2, item 7)`, () => {
    it('every lock of a workflow is classified', () => {
      const { sites, total } = lockSites(src);
      deepStrictEqual(sites, LOCK_SITES);
      strictEqual(total, Object.values(LOCK_SITES).reduce((n, s) => n + s.calls, 0));
      // Every mention of the lock, in code, comments and messages alike: a
      // lock in a form the extraction above does not see (an alias, a name
      // split from its call) changes this count, and is classified here.
      strictEqual(src.match(/\bwithFileLock\b/g).length, WITH_FILE_LOCK_MENTIONS);
    });

    it("the driver's verification writers are classified", () => {
      for (const [fn, cls] of Object.entries(VERIFY_WRITERS)) {
        const at = src.search(new RegExp(`^export async function ${fn}\\(`, 'm'));
        ok(at >= 0, fn);
        const call = src.slice(at).match(/return verifyWrite\(\{([^}]*)\}/)[1];
        strictEqual(call.match(/writer: ([\w.]+)/)?.[1] ?? null, cls, fn);
      }
    });

    it('the writer classes are the ones the inventory names', async () => {
      const state = await import(pathToFileURL(join(root, 'scripts/state.mjs')).href);
      deepStrictEqual(Object.values(state.LANE_WRITERS).sort(), ['create', 'destination', 'job', 'machine', 'operation', 'plain', 'settlement', 'snapshot']);
      // A lock with no class of its own is plain; one naming no class is refused.
      await rejects(state.withFileLock(join(tmpdir(), 'no-such-workflow.md'), async () => {}, { writer: 'exempt' }), /is no writer class/);
    });

    it('every CLI subcommand is classified', () => {
      const cli = src.slice(src.indexOf('switch (subcommand) {'));
      // Any quote, and any case label at all: one this cannot read fails.
      const labels = [...cli.matchAll(/^\s*case\b\s*([^:\n]*):/gm)].map((m) => m[1].trim());
      const found = labels.map((l) => l.match(/^(['"`])([a-z0-9-]+)\1$/)?.[2] ?? l).sort();
      deepStrictEqual(found, [...WRITER_SUBCOMMANDS, ...READER_SUBCOMMANDS].sort());
      deepStrictEqual(WRITER_SUBCOMMANDS.filter((s) => READER_SUBCOMMANDS.includes(s)), []);
    });

    it('no other script or hook takes a workflow lock, and each imports only the writers above', () => {
      const found = {};
      const walk = (d) => {
        for (const n of readdirSync(d)) {
          const p = join(d, n);
          if (statSync(p).isDirectory()) { walk(p); continue; }
          if (!n.endsWith('.mjs') || p === join(root, 'scripts/state.mjs')) continue;
          const t = readFileSync(p, 'utf8');
          // Named in a comment only: a code line naming it is a lock of its own.
          const code = t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
          strictEqual(/\bwithFileLock\b/.test(code), false, `${relative(root, p)} takes a workflow lock`);
          // Only named imports of state.mjs, which the list below reads: a
          // namespace, default or dynamic import of it would hide its writers.
          for (const re of [
            /^\s*import\s+\*\s+as\s+\w+\s+from\s+['"][^'"\n]*\bstate\.mjs['"]/m,
            /^\s*import\s+\w+\s*(?:,[^\n]*)?\s+from\s+['"][^'"\n]*\bstate\.mjs['"]/m,
            /\bimport\(\s*['"`][^'"`\n]*\bstate\.mjs/,
          ]) {
            strictEqual(re.test(t), false, `${relative(root, p)} imports state.mjs in a form the inventory cannot read`);
          }
          const names = [...t.matchAll(/import \{([^}]*)\} from '[./]*(?:scripts\/)?state\.mjs'/g)]
            .flatMap((x) => x[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean));
          if (names.length > 0) found[relative(root, p)] = names.sort();
        }
      };
      for (const d of ['scripts', 'adapters']) if (existsSync(join(root, d))) walk(join(root, d));
      deepStrictEqual(found, Object.fromEntries(Object.entries(IMPORTS).filter(([p]) => existsSync(join(root, p)))));
    });
  });
}
