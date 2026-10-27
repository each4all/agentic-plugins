// tests/orchestrator/test-holds-records.mjs
//
// ADR-0068 Decision 2 (impl-hold) — the orchestrator's holds records
// (plugins/orchestrator/scripts/lib/holds-records.mjs) and its reads over them
// (scripts/lib/holds.mjs), held to the fixtures the persona's half is held to
// (tests/fixtures/holds-protocol/): every reader verdict and every transition
// and refusal as data; the libraries import with no cycle; a child's open
// operations read fresh from its file, archived or not; the old readers of
// parks and lock entries neither hang on a FIFO nor take a dangling link for
// nothing.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const LIB = join(REPO_ROOT, 'plugins/orchestrator/scripts/lib');
const HR = await import(pathToFileURL(join(LIB, 'holds-records.mjs')).href);
const H = await import(pathToFileURL(join(LIB, 'holds.mjs')).href);
const RL = await import(pathToFileURL(join(LIB, 'run-locks.mjs')).href);
const PK = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/parks.mjs')).href);
const POLICY = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/policy.mjs')).href);

const FIXTURES = join(REPO_ROOT, 'tests', 'fixtures', 'holds-protocol');
const CASES = JSON.parse(readFileSync(join(FIXTURES, 'cases.json'), 'utf8'));
const TRANSITIONS = JSON.parse(readFileSync(join(FIXTURES, 'release-transitions.json'), 'utf8'));
const AUTOPILOT = '.agentic-plugins/runs/autopilot';

function resolveEntry(spec) {
  if (spec === '$marker') return CASES.marker;
  if (spec === '$hold') return { json: CASES.hold };
  if (typeof spec === 'string' && spec.startsWith('$op:')) return { json: { ...CASES.op, operation_id: spec.slice(4) } };
  if (spec && typeof spec === 'object' && spec.hold) return { json: { ...CASES.hold, ...spec.hold } };
  return spec;
}

function materialize(main, c) {
  const holds = join(main, AUTOPILOT, 'holds', CASES.macro);
  if (c.holds_path !== undefined) {
    mkdirSync(dirname(holds), { recursive: true });
    writeFileSync(holds, c.holds_path);
    return;
  }
  if (c.files === null) return;
  mkdirSync(holds, { recursive: true });
  for (const [rel, raw] of Object.entries(c.files)) {
    const spec = resolveEntry(raw);
    const p = join(holds, rel);
    mkdirSync(dirname(p), { recursive: true });
    if (typeof spec === 'string') writeFileSync(p, spec);
    else if (spec.json !== undefined) writeFileSync(p, `${JSON.stringify(spec.json)}\n`);
    else if (spec.dir) mkdirSync(p, { recursive: true });
    else if (spec.fifo) execFileSync('mkfifo', [p]);
    else if (spec.link) symlinkSync(spec.link, p);
    else throw new Error(`fixture ${c.id}: unknown entry ${rel}`);
  }
}

async function withMain(fn) {
  const main = mkdtempSync(join(tmpdir(), 'holds-records-'));
  try {
    return await fn(main);
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
}

describe('holds records: the protocol fixtures (N2-N4)', () => {
  for (const c of CASES.cases) {
    it(c.id, () => withMain((main) => {
      materialize(main, c);
      const workflowId = c.workflow_id === undefined ? CASES.workflow_id : c.workflow_id;
      strictEqual(HR.readActivation(main, CASES.macro).state, c.expect.activation);
      if (c.expect.owner !== undefined || c.expect.applies !== undefined) {
        const owner = HR.readOwnerHold(main, CASES.macro, CASES.subtask);
        strictEqual(owner.state, c.expect.owner, JSON.stringify(owner));
        strictEqual(HR.holdApplies(owner, { branch: CASES.branch, workflowId }).applies, c.expect.applies);
      }
      if (c.expect.park !== undefined) strictEqual(HR.readKeptPark(main, CASES.macro, CASES.subtask).kept, c.expect.park);
      if (c.expect.ops !== undefined) {
        const ops = HR.readOps(main, CASES.macro, CASES.subtask);
        strictEqual(ops.state, c.expect.ops_state);
        deepStrictEqual(ops.ops.map((o) => ({ id: o.id, open: !o.cleared, record: o.record !== null ? 'ok' : o.error !== undefined ? 'unreadable' : 'none' })), c.expect.ops);
        // openOperations, with no child: what the records say is open.
        const open = H.openOperations({ mainRoot: main, macroId: CASES.macro, subtaskId: CASES.subtask });
        const want = c.expect.ops_state === 'unreadable' ? ['(ops)'] : c.expect.ops.filter((o) => o.open).map((o) => o.id);
        deepStrictEqual(open.open.map((o) => o.id), want);
      }
    }));
  }
});

describe('holds records: the release transitions (N7)', () => {
  it('every transition of the table, and every refusal, as data', () => {
    for (const t of TRANSITIONS.transitions) deepStrictEqual(HR.holdTransition(t.from, t.event), { to: t.to }, `${t.from} ${t.event}`);
    for (const r of TRANSITIONS.refused) strictEqual(HR.holdTransition(r.from, r.event).refused, r.why, `${r.from} ${r.event}`);
    deepStrictEqual([...HR.HOLD_TERMINAL_STATES].sort(), [...TRANSITIONS.terminal].sort());
    for (const s of TRANSITIONS.terminal) {
      for (const e of ['handoff-complete', 'release-same-hold-id', 'done', 'orphan']) ok(HR.holdTransition(s, e).refused, `${s} ${e} refused`);
    }
  });

  it('the records give each state of the table, and the persona reads each as the table says', () => withMain((main) => {
    const M = CASES.macro;
    const S = CASES.subtask;
    const hold = { ...CASES.hold, subtask_id: S };
    const put = (kind, value) => HR.writeWhole(HR.recordPath(main, M, kind, S), value);
    const release = (state) => ({ schema: HR.RELEASE_SCHEMA, release_id: 'a'.repeat(16), hold_id: hold.hold_id, subtask_id: S, state, basis: state === 'withdrawn' ? null : { fingerprint_version: 1, fingerprint: 'f', tree_digest: 't', content_digest: 'c', child: null }, park_record_id: null, park_ended: false, released_at: 'x', compared_at: null });
    const handoff = { schema: HR.HANDOFF_SCHEMA, hold_id: hold.hold_id, subtask_id: S, state: 'acked', fence: null, at: 'x' };
    const cases = {
      pending: () => { put('holds', hold); },
      held: () => { put('holds', hold); put('handoffs', handoff); },
      'released-uncompared': () => { put('holds', { ...hold, state: 'released' }); put('releases', release('uncompared')); },
      consumed: () => { put('holds', { ...hold, state: 'released' }); put('releases', release('consumed')); },
      rejected: () => { put('holds', { ...hold, state: 'released' }); put('releases', release('rejected')); },
      withdrawn: () => { put('holds', { ...hold, state: 'released' }); put('releases', release('withdrawn')); },
      retired: () => { put('holds', { ...hold, state: 'retired' }); },
      orphaned: () => { put('holds', { ...hold, orphaned: { at: 'x', why: 'left the plan' } }); },
    };
    for (const [state, setup] of Object.entries(cases)) {
      rmSync(HR.holdsDir(main, M), { recursive: true, force: true });
      setup();
      strictEqual(HR.holdStateOf(main, M, S).state, state);
      const owner = HR.readOwnerHold(main, M, S);
      strictEqual(HR.holdApplies(owner, { branch: hold.branch }).applies, TRANSITIONS.persona_reads[state].applies, state);
    }
    // A release of this hold written before its owner record moved (a crash
    // inside `release`) is not in force: the hold is still held.
    rmSync(HR.holdsDir(main, M), { recursive: true, force: true });
    put('holds', hold); put('handoffs', handoff); put('releases', release('uncompared'));
    strictEqual(HR.holdStateOf(main, M, S).state, 'held');
    // An acked handoff of an older hold does not make a new one held.
    put('holds', { ...hold, hold_id: 'b'.repeat(16) });
    strictEqual(HR.holdStateOf(main, M, S).state, 'pending');
  }));
});

describe('holds records: writes and ids', () => {
  it('the marker is written once and never over one that is there', () => withMain((main) => {
    strictEqual(HR.writeProtocol(main, CASES.macro, { writtenBy: 'test' }).written, true);
    strictEqual(HR.readActivation(main, CASES.macro).state, 'active');
    strictEqual(HR.writeProtocol(main, CASES.macro, { writtenBy: 'test' }).written, false);
  }));

  it('the identifier forms are policy.mjs\'s', () => {
    for (const id of ['A', 'a.b-c_d', 'x'.repeat(64), 'x'.repeat(65), '.a', 'a/b', '', 'é']) strictEqual(HR.isSafeSubtaskId(id), POLICY.isSafeSubtaskId(id), id);
    for (const id of [CASES.macro, 'macro-plan-20261019T084450Z-b66aa', 'macro-x']) strictEqual(HR.isSafeMacroId(id), POLICY.isSafeMacroId(id), id);
    ok(HR.OPERATION_ID_RE.test(HR.newOperationId()));
    ok(HR.isRecordId(HR.newRecordId()));
  });

  it('writer-clear creates its file once', () => withMain((main) => {
    const id = HR.newOperationId();
    strictEqual(HR.clearOperation(main, CASES.macro, CASES.subtask, id, { by: 'owner' }).cleared, true);
    strictEqual(HR.clearOperation(main, CASES.macro, CASES.subtask, id, { by: 'owner' }).cleared, false);
    deepStrictEqual(HR.readOps(main, CASES.macro, CASES.subtask).ops.map((o) => [o.id, o.cleared]), [[id, true]]);
  }));

  it('the holds lock is a run-locks lock, released after its work, and waited on while held', () => withMain(async (main) => {
    const lock = HR.holdsLockPath(main, CASES.macro);
    strictEqual(await H.withHoldsLock(main, CASES.macro, () => RL.readLockEntries(lock).length), 1);
    deepStrictEqual(RL.readLockEntries(lock), []);
    // Held by a live process (this one, under another entry): waited on, then refused.
    const held = await RL.acquireLock(lock, { record: { kind: 'holds', run_id: 'other' } });
    const prev = H.setHoldsLockWaitMs(150);
    try {
      await rejects(H.withHoldsLock(main, CASES.macro, () => 1), /holds lock .* is held/);
    } finally {
      H.setHoldsLockWaitMs(prev);
      held.release();
    }
  }));
});

describe('holds: the libraries import with no cycle', () => {
  it('a bare node process imports each library first', () => {
    for (const lib of ['holds-records.mjs', 'holds.mjs']) {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(LIB, lib)).href)}); console.log('ok')`], { encoding: 'utf8' });
      strictEqual(r.status, 0, r.stderr);
      strictEqual(r.stdout.trim(), 'ok');
    }
    // holds-records.mjs imports nothing of the plugin's.
    const text = readFileSync(join(LIB, 'holds-records.mjs'), 'utf8');
    deepStrictEqual(text.match(/^import .* from '\.[^']*';$/gm) ?? [], []);
    // holds.mjs imports neither state.mjs, parks.mjs nor policy.mjs.
    ok(!/from '[^']*(state|parks|policy)\.mjs'/.test(readFileSync(join(LIB, 'holds.mjs'), 'utf8')));
  });
});

const CHILD_ID = 'compose-20261026T000000Z-aaaaaa';
function childFile(dir, { ops, branch = 'feat/x', pending = false, archived = false } = {}) {
  const base = join(dir, '.agentic-plugins/state/engineer', archived ? 'archive' : 'workflows');
  mkdirSync(base, { recursive: true });
  const file = join(base, `${CHILD_ID}.md`);
  const lines = ['---', 'schema: "1.4"', `workflow_id: "${CHILD_ID}"`, 'git_baseline:', `  branch: "${branch}"`, '  head: "abc"',
    ...(pending ? ['pending_ensemble:', '  - phase: "compose"'] : ['pending_ensemble: []']),
    `parent_workflow: "${CASES.macro}"`, 'originating_subtask: "S"'];
  // The persona's encoding (engineer state.mjs serialize): the document's JSON
  // in one double-quoted scalar.
  if (ops !== undefined) lines.push(`persona_operations: ${JSON.stringify(JSON.stringify({ v: 1, ops }))}`);
  writeFileSync(file, `${lines.join('\n')}\n---\n\n# body\n`);
  return file;
}

describe('holds: a child\'s open operations (P3)', () => {
  const op = (id, kind = 'verb') => ({ id, kind, opened_at: '2026-10-26T00:00:00Z', ext: false });
  for (const archived of [false, true]) {
    it(`an entry on ${archived ? 'an archived' : 'a live'} child is open, read from the file itself`, () => withMain((main) => {
      const id = HR.newOperationId();
      const child = childFile(main, { ops: [op(id)], archived });
      deepStrictEqual(H.openOperations({ mainRoot: main, macroId: CASES.macro, subtaskId: 'S', childPath: child }).open.map((o) => [o.id, o.kind, o.from]), [[id, 'verb', 'entry']]);
    }));
  }

  it('a pre-activation entry and a record unite; a .cleared beats an entry; an unreadable document counts open', () => withMain((main) => {
    const a = HR.newOperationId();
    const b = HR.newOperationId();
    const child = childFile(main, { ops: [op(a), op(b, 'commit')] });
    HR.publishOpRecord(main, CASES.macro, 'S', { operation_id: a, kind: 'verb' });
    deepStrictEqual(H.openOperations({ mainRoot: main, macroId: CASES.macro, subtaskId: 'S', childPath: child }).open.map((o) => [o.id, o.from]).sort(), [[a, 'both'], [b, 'entry']].sort());
    HR.clearOperation(main, CASES.macro, 'S', b, { by: 'owner' });
    deepStrictEqual(H.openOperations({ mainRoot: main, macroId: CASES.macro, subtaskId: 'S', childPath: child }).open.map((o) => o.id), [a]);
    writeFileSync(child, readFileSync(child, 'utf8').replace(/persona_operations: .*\n/, 'persona_operations: "{not json"\n'));
    deepStrictEqual(H.openOperations({ mainRoot: main, macroId: CASES.macro, subtaskId: 'S', childPath: child }).open.map((o) => o.id).sort(), ['(child)', a].sort());
  }));

  it('a later document version counts open; no field is none', () => withMain((main) => {
    const child = childFile(main, {});
    deepStrictEqual(H.openOperations({ mainRoot: main, macroId: CASES.macro, subtaskId: 'S', childPath: child }).open, []);
    writeFileSync(child, readFileSync(child, 'utf8').replace('---\n\n#', `persona_operations: ${JSON.stringify(JSON.stringify({ v: 2, ops: [] }))}\n---\n\n#`));
    deepStrictEqual(H.openOperations({ mainRoot: main, macroId: CASES.macro, subtaskId: 'S', childPath: child }).open.map((o) => o.id), ['(child)']);
  }));

  // Critique round 6, M2: the engineer writes the workflow itself (state.mjs
  // create, as a macro's child, opens its verb operation), and its own read of
  // the file (state.mjs read) is the oracle: every field of each entry we
  // decode equals the engineer's. Nothing here is conditional.
  it('the real engineer\'s workflow, with an operation open, decodes', async () => withMain(async (main) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_')));
    const engineer = (...args) => spawnSync(process.execPath, [join(REPO_ROOT, 'plugins/engineer/scripts/state.mjs'), ...args], { encoding: 'utf8', env });
    const repo = join(main, 'repo');
    mkdirSync(repo);
    const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env }).trim();
    git('init', '-q', '-b', 'main');
    git('-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    writeFileSync(join(main, 'request.txt'), 'request\n');
    mkdirSync(join(main, 'op'));
    const c = engineer('create', '--repo-root', repo, '--verb', 'compose', '--host', 'claude', '--persona', 'engineer',
      '--git-baseline-branch', 'main', '--git-baseline-head', git('rev-parse', 'HEAD'), '--status-digest', 'x',
      '--original-request-file', join(main, 'request.txt'), '--current-phase', 'phase-0-bootstrap', '--next-action', 'x',
      '--operation-dir', join(main, 'op'), '--parent-workflow', CASES.macro, '--originating-subtask', 'S');
    strictEqual(c.status, 0, c.stderr);
    const child = c.stdout.trim().split('\n')[0];
    const r = engineer('read', '--workflow-path', child);
    strictEqual(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout).persona_operations;
    strictEqual(doc.ops.length, 1, JSON.stringify(doc));
    const ours = H.decodePersonaOperations(H.readWorkflowFacts(child).fields.persona_operations);
    strictEqual(ours.state, 'ok');
    deepStrictEqual(ours.ops, doc.ops);
    deepStrictEqual(H.openOperations({ mainRoot: main, macroId: CASES.macro, subtaskId: 'S', childPath: child }).open.map((o) => [o.id, o.kind]), doc.ops.map((o) => [o.id, o.kind]));
  }));

  it('pending_ensemble and the branch are read from the frontmatter', () => withMain((main) => {
    const f = H.readWorkflowFacts(childFile(main, { pending: true, branch: 'feat/y' }));
    deepStrictEqual([f.fields.pending_ensemble, f.fields.branch, f.fields.workflow_id], [true, 'feat/y', CHILD_ID]);
    deepStrictEqual(H.readWorkflowFacts(childFile(main, {})).fields.pending_ensemble, false);
  }));
});

describe('holds: the workflows on a subtask\'s branch (P16)', () => {
  it('the linked child, another lane\'s and an unlinked workflow are told apart; an unreadable one is reported', () => withMain((main) => {
    const dir = join(main, '.agentic-plugins/state/engineer/workflows');
    mkdirSync(dir, { recursive: true });
    const wf = (id, extra) => writeFileSync(join(dir, `${id}.md`), `---\nworkflow_id: "${id}"\ngit_baseline:\n  branch: "feat/x"\n${extra}---\n`);
    wf('linked', `parent_workflow: "${CASES.macro}"\noriginating_subtask: "S"\n`);
    wf('other-lane', `parent_workflow: "${CASES.macro}"\noriginating_subtask: "T"\n`);
    wf('unlinked', '');
    writeFileSync(join(dir, 'broken.md'), 'no frontmatter');
    writeFileSync(join(dir, 'elsewhere.md'), '---\nworkflow_id: "e"\ngit_baseline:\n  branch: "feat/z"\n---\n');
    const r = H.branchWorkflows({ stateRoots: [main], branch: 'feat/x', macroId: CASES.macro, subtaskId: 'S' });
    deepStrictEqual(r.linked.map((f) => f.split('/').pop()), ['linked.md']);
    deepStrictEqual(r.other.map((o) => o.workflowId).sort(), ['other-lane', 'unlinked']);
    deepStrictEqual(r.unreadable.map((u) => u.file.split('/').pop()), ['broken.md']);
  }));
});

describe('holds: the old readers on a FIFO and a dangling link (P16)', () => {
  it('readPark neither hangs on a FIFO nor reads a dangling link as absent', () => withMain((main) => {
    const dir = PK.parksDir(main, CASES.macro);
    mkdirSync(dir, { recursive: true });
    execFileSync('mkfifo', [join(dir, 'A.json')]);
    symlinkSync('gone.json', join(dir, 'B.json'));
    strictEqual(PK.readPark(main, CASES.macro, 'A').state, 'unreadable');
    strictEqual(PK.readPark(main, CASES.macro, 'B').state, 'unreadable');
  }));

  it('readLockEntries neither hangs on a FIFO entry nor takes a dangling entry for gone', () => withMain((main) => {
    const lock = join(main, 'x.lock');
    mkdirSync(lock, { recursive: true });
    execFileSync('mkfifo', [join(lock, `s-${'a'.repeat(32)}.json`)]);
    let err = null;
    try { RL.readLockEntries(lock); } catch (e) { err = e; }
    ok(err && /not a regular file/.test(err.message), String(err));
    rmSync(join(lock, `s-${'a'.repeat(32)}.json`));
    symlinkSync('gone.json', join(lock, `s-${'b'.repeat(32)}.json`));
    err = null;
    try { RL.readLockEntries(lock); } catch (e) { err = e; }
    ok(err && /link to nothing/.test(err.message), String(err));
  }));
});
