// ADR-0068 Decision 2, item 7 (implementation note of 2026-10-25, N4) — a
// persona operation runs from a command's first write of a macro's child to its
// last. Its id travels in the transport file of the command's operation
// directory and stays on the child while open; once a hold-aware orchestrator
// marked the macro (N2), its record under ops/<subtask>/ is published before
// the first write, one operation at a time in a lane, and the last write is
// refused once the owner cleared it. designer and founder (dispatch_target
// off) have no operations: their writes are as before.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, notStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { personaInfo, personasFor } from './_personas.mjs';

const MACRO = 'macro-plan-20261025T000000Z-abcdef';
const SUBTASK = 'hold-persona';
const AUTOPILOT = '.agentic-plugins/runs/autopilot';
const MARKER = { schema: 'agentic-holds-protocol-1', protocol: 1, written_by: 'orchestrator@test', at: '2026-10-25T00:00:00Z' };
const OTHER = 'op-20261025T000000Z-0badf00d';

// No AGENTIC_* (this session's run) and no GIT_* (an inherited GIT_INDEX_FILE
// or GIT_DIR would point the fixture's git at another repository).
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_')));

const scratch = [];
const tempDir = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
};

async function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'op-life-'));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: cleanEnv() }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'README.md'), 'x\n');
    git('add', '.');
    git('commit', '-q', '-m', 'feat: base');
    return await fn({ dir, head: git('rev-parse', 'HEAD') });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
  }
}

const holdsPath = (dir, rel = '') => join(dir, AUTOPILOT, 'holds', MACRO, rel);
function holdsFile(dir, rel, value) {
  const p = holdsPath(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
}
const opsDir = (dir) => holdsPath(dir, `ops/${SUBTASK}`);
const records = (dir) => (existsSync(opsDir(dir)) ? readdirSync(opsDir(dir)).filter((n) => !n.startsWith('.')).sort() : []);
const transport = (opDir) => JSON.parse(readFileSync(join(opDir, 'operation.json'), 'utf8'));

const engineer = await import(pathToFileURL(personaInfo('engineer').path('scripts/state.mjs')).href);
const fm = (state, p) => state.parseWorkflowFile(readFileSync(p, 'utf8')).frontmatter;
const opsOf = (state, p) => fm(state, p).persona_operations?.ops ?? [];

const create = (state, persona, dir, head, { opDir, linked = true, env = cleanEnv() } = {}) => state.createWorkflow({
  repoRoot: dir, verb: 'compose', host: 'claude', persona, originalRequest: 'op', env,
  gitBaseline: { branch: 'main', head, status_digest: '' },
  ...(linked ? { parentWorkflow: MACRO, originatingSubtask: SUBTASK } : {}),
  ...(opDir === undefined ? {} : { operationDir: opDir }),
});
const open = (state, workflowPath, opDir) => state.appendPhase({
  workflowPath, host: 'claude', verb: 'compose', phaseLabel: 'Phase 0: Resume into compose', currentPhase: 'phase-0-resume',
  clearNextStep: true, event: 'resumed', env: cleanEnv(), operationDir: opDir, openOperation: 'verb',
});
const finish = (state, workflowPath, opDir) => state.finishVerb({
  workflowPath, host: 'claude', nextAction: 'Critique the composed artifact',
  nextStep: { kind: 'verb', verb: 'critique', confidence: 'HIGH' }, env: cleanEnv(), operationDir: opDir,
});

describe('engineer: an operation before a hold-aware orchestrator ran (inactive)', () => {
  it('with no operation directory, no operation is kept', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    await finish(engineer, filePath);
    strictEqual(fm(engineer, filePath).persona_operations, undefined);
  }));

  it('the bootstrap opens it on the child and finish-verb closes it, publishing nothing', () => withRepo(async ({ dir, head }) => {
    const opDir = tempDir('op-');
    const { filePath, workflowId } = await create(engineer, 'engineer', dir, head, { opDir });
    const [entry] = opsOf(engineer, filePath);
    match(entry.id, /^op-\d{8}T\d{6}Z-[0-9a-f]{8}$/);
    deepStrictEqual({ kind: entry.kind, ext: entry.ext }, { kind: 'verb', ext: false });
    const t = transport(opDir);
    deepStrictEqual([t.operation_id, t.workflow_id, t.state, t.macro_id, t.subtask_id], [entry.id, workflowId, 'open', MACRO, SUBTASK]);
    strictEqual(existsSync(holdsPath(dir)), false, 'nothing under the holds directory');
    const result = await finish(engineer, filePath, opDir);
    strictEqual(result.terminal, true);
    strictEqual(fm(engineer, filePath).persona_operations, undefined, 'the last write removed the entry');
    strictEqual(transport(opDir).state, 'closed');
  }));

  it('overlapping operations each keep their own entry, closing in either order', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    const a = tempDir('op-a-');
    const b = tempDir('op-b-');
    await open(engineer, filePath, a);
    await open(engineer, filePath, b);
    const [ia, ib] = [transport(a).operation_id, transport(b).operation_id];
    deepStrictEqual(opsOf(engineer, filePath).map((o) => o.id), [ia, ib]);
    await engineer.appendPhase({ workflowPath: filePath, host: 'claude', phaseNote: 'a later write', event: 'updated', env: cleanEnv() });
    deepStrictEqual(opsOf(engineer, filePath).map((o) => o.id), [ia, ib], 'a later write carries both');
    await finish(engineer, filePath, a);
    deepStrictEqual(opsOf(engineer, filePath).map((o) => o.id), [ib], 'closing a removed a only');
    await engineer.appendPhase({ workflowPath: filePath, host: 'claude', event: 'updated', env: cleanEnv(), operationDir: b, closeOperation: true });
    strictEqual(fm(engineer, filePath).persona_operations, undefined);
  }));

  it('an operation opened before activation closes after it, and is refused once cleared', () => withRepo(async ({ dir, head }) => {
    const opDir = tempDir('op-');
    const { filePath } = await create(engineer, 'engineer', dir, head, { opDir });
    holdsFile(dir, 'protocol.json', MARKER);
    await finish(engineer, filePath, opDir);
    strictEqual(fm(engineer, filePath).persona_operations, undefined);

    const second = tempDir('op-');
    await open(engineer, filePath, second);
    holdsFile(dir, `ops/${SUBTASK}/${transport(second).operation_id}.cleared`, '');
    await rejects(finish(engineer, filePath, second), /cleared by the owner/);
  }));

  it('a registered operation whose marker is gone refuses its last write', () => withRepo(async ({ dir, head }) => {
    holdsFile(dir, 'protocol.json', MARKER);
    const opDir = tempDir('op-');
    const { filePath } = await create(engineer, 'engineer', dir, head, { opDir });
    strictEqual(opsOf(engineer, filePath)[0].ext, true);
    rmSync(holdsPath(dir), { recursive: true, force: true });
    const before = readFileSync(filePath, 'utf8');
    await rejects(finish(engineer, filePath, opDir), /whose marker is gone/);
    strictEqual(readFileSync(filePath, 'utf8'), before, 'nothing was written');
  }));
});

describe('engineer: an operation once a hold-aware orchestrator runs (active)', () => {
  it('publishes its record before the first write and removes it after the last', () => withRepo(async ({ dir, head }) => {
    holdsFile(dir, 'protocol.json', MARKER);
    const opDir = tempDir('op-');
    const { filePath } = await create(engineer, 'engineer', dir, head, { opDir });
    const id = transport(opDir).operation_id;
    deepStrictEqual(records(dir), [`${id}.json`]);
    const rec = JSON.parse(readFileSync(join(opsDir(dir), `${id}.json`), 'utf8'));
    deepStrictEqual([rec.schema, rec.operation_id, rec.kind, rec.macro_id, rec.subtask_id], ['agentic-persona-op-1', id, 'verb', MACRO, SUBTASK]);
    deepStrictEqual(opsOf(engineer, filePath), [{ id, kind: 'verb', opened_at: rec.opened_at, ext: true }]);
    await finish(engineer, filePath, opDir);
    deepStrictEqual(records(dir), []);
    strictEqual(fm(engineer, filePath).persona_operations, undefined);
  }));

  it('a second first write beside an open operation is refused, naming it, and leaves no record', () => withRepo(async ({ dir, head }) => {
    holdsFile(dir, 'protocol.json', MARKER);
    const first = tempDir('op-');
    const { filePath } = await create(engineer, 'engineer', dir, head, { opDir: first });
    const id = transport(first).operation_id;
    const before = readFileSync(filePath, 'utf8');
    await rejects(open(engineer, filePath, tempDir('op-')), new RegExp(`operation ${id} \\(verb\\) is open in subtask ${SUBTASK}`));
    strictEqual(readFileSync(filePath, 'utf8'), before, 'nothing was written');
    deepStrictEqual(records(dir), [`${id}.json`], 'the refused operation withdrew its record');
  }));

  it("another session's record with no .cleared refuses; once cleared, the first write proceeds", () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    holdsFile(dir, 'protocol.json', MARKER);
    holdsFile(dir, `ops/${SUBTASK}/${OTHER}.json`, { schema: 'agentic-persona-op-1', operation_id: OTHER, kind: 'commit' });
    await rejects(open(engineer, filePath, tempDir('op-')), new RegExp(`operation ${OTHER} \\(commit\\) is open`));
    holdsFile(dir, `ops/${SUBTASK}/${OTHER}.cleared`, '');
    await open(engineer, filePath, tempDir('op-'));
    strictEqual(opsOf(engineer, filePath).length, 1);
  }));

  it("a record that cannot be read counts open", () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    holdsFile(dir, 'protocol.json', MARKER);
    holdsFile(dir, `ops/${SUBTASK}/${OTHER}.json`, '{');
    await rejects(open(engineer, filePath, tempDir('op-')), new RegExp(`operation ${OTHER} is open`));
  }));

  it('an entry opened before activation counts open; once cleared it goes with the next first write', () => withRepo(async ({ dir, head }) => {
    const early = tempDir('op-');
    const { filePath } = await create(engineer, 'engineer', dir, head, { opDir: early });
    const id = transport(early).operation_id;
    holdsFile(dir, 'protocol.json', MARKER);
    await rejects(open(engineer, filePath, tempDir('op-')), new RegExp(`operation ${id} \\(verb\\) is open`));
    holdsFile(dir, `ops/${SUBTASK}/${id}.cleared`, '');
    const late = tempDir('op-');
    await open(engineer, filePath, late);
    deepStrictEqual(opsOf(engineer, filePath).map((o) => o.id), [transport(late).operation_id], 'the cleared entry went');
    // The cleared verb's delayed finish-verb, beside the later verb.
    await rejects(finish(engineer, filePath, early), /cleared by the owner/);
    await finish(engineer, filePath, late);
    strictEqual(fm(engineer, filePath).persona_operations, undefined);
  }));

  it("holding the workflow's lock, the first write looks at the child's entries again", () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    holdsFile(dir, 'protocol.json', MARKER);
    let pending;
    await engineer.withFileLock(filePath, async () => {
      pending = open(engineer, filePath, tempDir('op-'));
      // The record is published before the lock is taken.
      for (let i = 0; i < 100 && records(dir).length === 0; i += 1) await new Promise((r) => { setTimeout(r, 20); });
      strictEqual(records(dir).length, 1);
      // Another writer's entry lands while this one waits for the lock.
      const text = readFileSync(filePath, 'utf8');
      const end = text.indexOf('\n---\n', 4);
      const doc = JSON.stringify({ v: 1, ops: [{ id: OTHER, kind: 'verb', opened_at: '2026-10-25T00:00:00Z', ext: false }] });
      writeFileSync(filePath, `${text.slice(0, end)}\npersona_operations: ${JSON.stringify(doc)}${text.slice(end)}`);
    }, { env: cleanEnv(), hold: false });
    await rejects(pending, new RegExp(`operation ${OTHER} \\(verb\\) is open on`));
    deepStrictEqual(records(dir), [], 'the refused operation withdrew its record');
    deepStrictEqual(opsOf(engineer, filePath).map((o) => o.id), [OTHER]);
  }));

  it("a first write that read the holds inactive, and meets them active at the workflow's lock, is refused; run again it registers", () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    const opDir = tempDir('op-');
    let pending;
    await engineer.withFileLock(filePath, async () => {
      pending = open(engineer, filePath, opDir);
      for (let i = 0; i < 100 && !existsSync(join(opDir, 'operation.json')); i += 1) await new Promise((r) => { setTimeout(r, 20); });
      ok(existsSync(join(opDir, 'operation.json')), 'it read the holds before the lock');
      holdsFile(dir, 'protocol.json', MARKER);
    }, { env: cleanEnv(), hold: false });
    await rejects(pending, /turned active while this write waited/);
    strictEqual(fm(engineer, filePath).persona_operations, undefined);
    await open(engineer, filePath, opDir);
    deepStrictEqual(opsOf(engineer, filePath).map((o) => o.ext), [true]);
    deepStrictEqual(records(dir), [`${transport(opDir).operation_id}.json`]);
  }));

  it("a dispatch record of the id naming another kind or child is not adopted", () => withRepo(async ({ dir, head }) => {
    holdsFile(dir, 'protocol.json', MARKER);
    const id = 'op-20261025T010203Z-0123abcd';
    holdsFile(dir, `ops/${SUBTASK}/${id}.json`, { schema: 'agentic-persona-op-1', operation_id: id, kind: 'commit' });
    await rejects(
      create(engineer, 'engineer', dir, head, { opDir: tempDir('op-'), env: { ...cleanEnv(), AGENTIC_OPERATION_ID: id } }),
      /is not a record of this operation/,
    );
    holdsFile(dir, `ops/${SUBTASK}/${id}.json`, { schema: 'agentic-persona-op-1', operation_id: id, kind: 'verb', workflow_id: 'compose-20261024T000000Z-aaaaaa' });
    await rejects(
      create(engineer, 'engineer', dir, head, { opDir: tempDir('op-'), env: { ...cleanEnv(), AGENTIC_OPERATION_ID: id } }),
      /is not a record of this operation/,
    );
    deepStrictEqual(records(dir), [`${id}.json`], 'the foreign record is left as it was');
  }));

  it('two first writes at once never both proceed', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    holdsFile(dir, 'protocol.json', MARKER);
    const results = await Promise.allSettled([1, 2, 3].map(() => open(engineer, filePath, tempDir('op-'))));
    ok(results.filter((r) => r.status === 'fulfilled').length <= 1, 'at most one proceeds');
    strictEqual(opsOf(engineer, filePath).length, results.filter((r) => r.status === 'fulfilled').length);
    strictEqual(records(dir).length, opsOf(engineer, filePath).length, 'every refused one withdrew its record');
  }));

  it('a first write is refused while the holds directory cannot be read', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    holdsFile(dir, 'protocol.json', { ...MARKER, protocol: 2 });
    const before = readFileSync(filePath, 'utf8');
    const opDir = tempDir('op-');
    await rejects(open(engineer, filePath, opDir), /holds directory of .* cannot be read.*later than this persona/);
    strictEqual(readFileSync(filePath, 'utf8'), before, 'nothing was written');
    strictEqual(existsSync(join(opDir, 'operation.json')), false, 'no operation began');
    // A bootstrap too.
    rmSync(filePath);
    await rejects(create(engineer, 'engineer', dir, head, { opDir }), /cannot be read/);
  }));

  it('an operation running when the marker became unreadable finishes', () => withRepo(async ({ dir, head }) => {
    holdsFile(dir, 'protocol.json', MARKER);
    const opDir = tempDir('op-');
    const { filePath } = await create(engineer, 'engineer', dir, head, { opDir });
    holdsFile(dir, 'protocol.json', '{');
    await finish(engineer, filePath, opDir);
    strictEqual(fm(engineer, filePath).persona_operations, undefined);
  }));

  it("the last write is refused once the owner cleared the operation, and when its record is gone", () => withRepo(async ({ dir, head }) => {
    holdsFile(dir, 'protocol.json', MARKER);
    const opDir = tempDir('op-');
    const { filePath } = await create(engineer, 'engineer', dir, head, { opDir });
    const id = transport(opDir).operation_id;
    rmSync(join(opsDir(dir), `${id}.json`));
    const before = readFileSync(filePath, 'utf8');
    await rejects(finish(engineer, filePath, opDir), /record of operation .* is gone/);
    holdsFile(dir, `ops/${SUBTASK}/${id}.cleared`, '');
    await rejects(finish(engineer, filePath, opDir), /cleared by the owner/);
    strictEqual(readFileSync(filePath, 'utf8'), before, 'nothing was written');
  }));

  it("an owner gate's finish-verb closes the operation too", () => withRepo(async ({ dir, head }) => {
    holdsFile(dir, 'protocol.json', MARKER);
    const opDir = tempDir('op-');
    const { filePath } = await create(engineer, 'engineer', dir, head, { opDir });
    writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}\n### Routing recommendation\n\nx\n`);
    const result = await engineer.finishVerb({
      workflowPath: filePath, host: 'claude', nextAction: 'Owner: route', env: cleanEnv(), operationDir: opDir,
      nextStep: { kind: 'owner-decision', confidence: 'HIGH' }, ownerGate: { gate: 'scope-routing', anchor: 'routing-recommendation' },
    });
    strictEqual(result.terminal, false);
    strictEqual(fm(engineer, filePath).persona_operations, undefined);
    deepStrictEqual(records(dir), []);
  }));

  it("a dispatched bootstrap continues the dispatch's operation (AGENTIC_OPERATION_ID)", () => withRepo(async ({ dir, head }) => {
    holdsFile(dir, 'protocol.json', MARKER);
    const id = 'op-20261025T010203Z-0123abcd';
    // The dispatch's own record of the id, published before the engineer ran.
    holdsFile(dir, `ops/${SUBTASK}/${id}.json`, { schema: 'agentic-persona-op-1', operation_id: id, kind: 'verb' });
    const opDir = tempDir('op-');
    const { filePath } = await create(engineer, 'engineer', dir, head, { opDir, env: { ...cleanEnv(), AGENTIC_OPERATION_ID: id } });
    deepStrictEqual(opsOf(engineer, filePath).map((o) => o.id), [id]);
    strictEqual(transport(opDir).operation_id, id);
    await finish(engineer, filePath, opDir);
    deepStrictEqual(records(dir), []);
    await rejects(
      create(engineer, 'engineer', dir, head, { opDir: tempDir('op-'), env: { ...cleanEnv(), AGENTIC_OPERATION_ID: 'op-1' } }),
      /AGENTIC_OPERATION_ID "op-1" is not an operation id/,
    );
  }));
});

describe('engineer: the operation directory', () => {
  it('a first write run again continues its operation; one that ended is not reopened', () => withRepo(async ({ dir, head }) => {
    holdsFile(dir, 'protocol.json', MARKER);
    const opDir = tempDir('op-');
    const { filePath } = await create(engineer, 'engineer', dir, head);
    await open(engineer, filePath, opDir);
    const id = transport(opDir).operation_id;
    await open(engineer, filePath, opDir);
    deepStrictEqual(opsOf(engineer, filePath).map((o) => o.id), [id], 'no second entry');
    await finish(engineer, filePath, opDir);
    await rejects(open(engineer, filePath, opDir), /has ended: a command's first write takes a fresh operation directory/);
    await rejects(finish(engineer, filePath, opDir), /has ended: its last write already ran/);
  }));

  it("a directory bound to another workflow's operation is refused at either end", () => withRepo(async ({ dir, head }) => {
    const opDir = tempDir('op-');
    const { filePath } = await create(engineer, 'engineer', dir, head, { opDir });
    const t = transport(opDir);
    writeFileSync(join(opDir, 'operation.json'), JSON.stringify({ ...t, workflow_id: 'compose-20261024T000000Z-aaaaaa' }));
    await rejects(finish(engineer, filePath, opDir), /not of compose-/);
    await rejects(open(engineer, filePath, opDir), /not this one; use a fresh operation directory/);
    writeFileSync(join(opDir, 'operation.json'), '{');
    await rejects(finish(engineer, filePath, opDir), /operation file cannot be used/);
  }));

  it('a lost directory refuses the last write; with none, the write is as before and the operation stays open', () => withRepo(async ({ dir, head }) => {
    const opDir = tempDir('op-');
    const { filePath } = await create(engineer, 'engineer', dir, head, { opDir });
    const id = transport(opDir).operation_id;
    rmSync(opDir, { recursive: true, force: true });
    await rejects(finish(engineer, filePath, opDir), /is not a directory; nothing was written\. When it is lost/);
    const result = await finish(engineer, filePath);
    strictEqual(result.terminal, true);
    deepStrictEqual(opsOf(engineer, filePath).map((o) => o.id), [id]);
  }));

  it('the CLI opens at create or append and closes at finish-verb', () => withRepo(async ({ dir, head }) => {
    holdsFile(dir, 'protocol.json', MARKER);
    const script = personaInfo('engineer').path('scripts/state.mjs');
    const run = (...a) => spawnSync(process.execPath, [script, ...a], { cwd: dir, encoding: 'utf8', env: cleanEnv() });
    const opDir = tempDir('op-');
    const c = run('create', '--repo-root', dir, '--verb', 'compose', '--host', 'claude', '--git-baseline-branch', 'main', '--git-baseline-head', head,
      '--parent-workflow', MACRO, '--originating-subtask', SUBTASK, '--operation-dir', opDir);
    strictEqual(c.status, 0, c.stderr);
    const filePath = c.stdout.trim();
    const id = transport(opDir).operation_id;
    match(c.stderr, new RegExp(`operation ${id} \\(verb\\) is open; its directory is `));
    const actions = tempDir('act-');
    writeFileSync(join(actions, 'a.txt'), 'Critique\n');
    const f = run('finish-verb', '--workflow-path', filePath, '--host', 'claude', '--next-action-file', join(actions, 'a.txt'),
      '--next-step-kind', 'verb', '--next-step-verb', 'critique', '--next-step-confidence', 'HIGH', '--operation-dir', opDir);
    strictEqual(f.status, 0, f.stderr);
    deepStrictEqual(records(dir), []);
    const second = tempDir('op-');
    const a = run('append', '--workflow-path', filePath, '--host', 'claude', '--operation-dir', second, '--open-operation', 'verb');
    strictEqual(a.status, 0, a.stderr);
    strictEqual(opsOf(engineer, filePath)[0].id, transport(second).operation_id);
    const busy = run('append', '--workflow-path', filePath, '--host', 'claude', '--operation-dir', tempDir('op-'), '--open-operation', 'verb');
    notStrictEqual(busy.status, 0);
    match(busy.stderr, /one persona operation at a time in a lane/);
    const closed = run('append', '--workflow-path', filePath, '--host', 'claude', '--operation-dir', second, '--close-operation', 'true');
    strictEqual(closed.status, 0, closed.stderr);
    strictEqual(fm(engineer, filePath).persona_operations, undefined);
  }));

  it("a bootstrap's directory opens no other child: once its create landed, nor on another branch before", () => withRepo(async ({ dir, head }) => {
    const opDir = tempDir('op-');
    await create(engineer, 'engineer', dir, head, { opDir });
    const landed = transport(opDir);
    // Run again on its branch: refused by the child its file names, before the
    // create could refuse a second workflow there.
    await rejects(create(engineer, 'engineer', dir, head, { opDir }), /not this one; use a fresh operation directory/);
    deepStrictEqual(transport(opDir), landed, 'the file is left as it was');
    // A create that never landed names no child yet; its directory still
    // binds its branch.
    writeFileSync(join(opDir, 'operation.json'), JSON.stringify({ ...landed, workflow_id: null, state: 'opening' }));
    const other = engineer.createWorkflow({
      repoRoot: dir, verb: 'compose', host: 'claude', persona: 'engineer', originalRequest: 'op', env: cleanEnv(), operationDir: opDir,
      gitBaseline: { branch: 'feat/other', head, status_digest: '' }, parentWorkflow: MACRO, originatingSubtask: SUBTASK,
    });
    await rejects(other, /not this one; use a fresh operation directory/);
  }));

  it('a first write run again after its operation ended does not open it again', () => withRepo(async ({ dir, head }) => {
    holdsFile(dir, 'protocol.json', MARKER);
    const { filePath } = await create(engineer, 'engineer', dir, head);
    const opDir = tempDir('op-');
    await open(engineer, filePath, opDir);
    await finish(engineer, filePath, opDir);
    // A crash after the last write, before its file said so.
    writeFileSync(join(opDir, 'operation.json'), JSON.stringify({ ...transport(opDir), state: 'open' }));
    await rejects(open(engineer, filePath, opDir), /is no longer open on .*: it ended, or the owner cleared it/);
    deepStrictEqual(records(dir), [], 'the refused run withdrew the record it published');
    strictEqual(fm(engineer, filePath).persona_operations, undefined);
  }));

  it('a first write run again across activation publishes its record, and its last write removes it', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    const opDir = tempDir('op-');
    await open(engineer, filePath, opDir);
    holdsFile(dir, 'protocol.json', MARKER);
    await open(engineer, filePath, opDir);
    const id = transport(opDir).operation_id;
    deepStrictEqual(opsOf(engineer, filePath).map((o) => [o.id, o.ext]), [[id, true]]);
    deepStrictEqual(records(dir), [`${id}.json`]);
    await finish(engineer, filePath, opDir);
    deepStrictEqual(records(dir), []);
  }));

  it('an operation file missing a field, or naming another kind, is refused', () => withRepo(async ({ dir, head }) => {
    const opDir = tempDir('op-');
    const { filePath } = await create(engineer, 'engineer', dir, head, { opDir });
    const t = transport(opDir);
    writeFileSync(join(opDir, 'operation.json'), JSON.stringify({ ...t, kind: 'archive' }));
    await rejects(finish(engineer, filePath, opDir), /is a verb operation on .*, not the archive its file names/);
    const { opened_at: _gone, ...noStamp } = t;
    writeFileSync(join(opDir, 'operation.json'), JSON.stringify(noStamp));
    await rejects(finish(engineer, filePath, opDir), /operation file cannot be used/);
    const fresh = tempDir('op-');
    writeFileSync(join(fresh, 'operation.json'), JSON.stringify({ ...noStamp, workflow_id: null, state: 'opening' }));
    await rejects(open(engineer, filePath, fresh), /operation file cannot be used/);
  }));

  it('with no macro child, even a missing directory changes nothing', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head, { opDir: join(tmpdir(), 'op-never-made-x'), linked: false });
    strictEqual((await finish(engineer, filePath, join(tmpdir(), 'op-never-made-x'))).terminal, true);
  }));

  it('a workflow that is no macro child keeps no operation, whatever the directory', () => withRepo(async ({ dir, head }) => {
    holdsFile(dir, 'protocol.json', MARKER);
    const opDir = tempDir('op-');
    const { filePath } = await create(engineer, 'engineer', dir, head, { opDir, linked: false });
    await finish(engineer, filePath, opDir);
    strictEqual(fm(engineer, filePath).persona_operations, undefined);
    strictEqual(existsSync(join(opDir, 'operation.json')), false);
  }));
});

for (const persona of personasFor('scripts/state.mjs').filter((p) => p !== 'engineer')) {
  const state = await import(pathToFileURL(personaInfo(persona).path('scripts/state.mjs')).href);
  describe(`${persona}: no operations (dispatch_target off)`, () => {
    it('an operation directory changes nothing, beside an active, held macro', () => withRepo(async ({ dir, head }) => {
      holdsFile(dir, 'protocol.json', MARKER);
      holdsFile(dir, `ops/${SUBTASK}/${OTHER}.json`, { schema: 'agentic-persona-op-1', operation_id: OTHER, kind: 'verb' });
      const opDir = tempDir('op-');
      const { filePath } = await create(state, persona, dir, head, { opDir, linked: false });
      await open(state, filePath, opDir);
      const result = await finish(state, filePath, opDir);
      strictEqual(result.terminal, true);
      strictEqual(fm(state, filePath).persona_operations, undefined);
      strictEqual(existsSync(join(opDir, 'operation.json')), false);
      deepStrictEqual(records(dir), [`${OTHER}.json`]);
    }));
  });
}

// The runbooks carry the operation from each verb's first write to every one
// of its last writes: the bootstrap and the resume open it in the directory
// they print, and every finish-verb of the finalize (the typical write, the
// conflict gate, the commented owner-decision form) closes it there. A
// persona with dispatch_target off has no operation directory at all. A gate
// resolution, decide's Owner selection and refine's Owner decision, carries
// its own (below).
describe('the verb runbooks carry the operation directory (N4)', () => {
  const VERBS = ['compose', 'critique', 'decide', 'frame', 'investigate', 'refine'];
  // Each command as the shell reads it: continued lines joined, comment marks kept.
  const logical = (text) => text.replace(/\\\n(#)?\s*/g, ' ');
  for (const persona of personasFor('scripts/state.mjs')) {
    const info = personaInfo(persona);
    for (const verb of VERBS) {
      it(`${persona}/${verb}`, () => {
        const text = readFileSync(info.path(`commands/${verb}.md`), 'utf8');
        if (info.capabilities.dispatch_target !== true) {
          ok(!text.includes('OP_DIR') && !text.includes('--operation-dir'), 'no operation directory');
          return;
        }
        const lines = logical(text).split('\n');
        const region = (id) => {
          const from = text.indexOf(`<!-- pipeline:begin ${id} -->`);
          ok(from >= 0, `the ${id} region`);
          return logical(text.slice(from, text.indexOf(`<!-- pipeline:end ${id} -->`, from))).split('\n');
        };
        const creates = lines.filter((l) => /state\.mjs" create /.test(l));
        const resumes = lines.filter((l) => /state\.mjs" append .*--event resumed/.test(l));
        const finishes = region(`${verb}-finalize`).filter((l) => /state\.mjs" finish-verb /.test(l));
        deepStrictEqual([creates.length, resumes.length], [1, 1]);
        ok(finishes.length >= 2, 'the finish-verb calls, the commented form among them');
        ok(creates[0].includes('--operation-dir "$OP_DIR"'), creates[0]);
        ok(resumes[0].includes('--operation-dir "$OP_DIR" --open-operation verb'), resumes[0]);
        for (const l of finishes) ok(l.includes('--operation-dir "$OP_DIR"'), l);
        strictEqual((text.match(/^OP_DIR="\$\(mktemp -d "\$\{TMPDIR:-\/tmp\}\/agentic-op\.XXXXXX"\)" \|\| exit 1$/gm) ?? []).length, 2, 'the bootstrap and the resume make it');
        strictEqual((text.match(/^echo "OP_DIR=\$OP_DIR"$/gm) ?? []).length, 2, 'and print it');
        strictEqual((text.match(/^OP_DIR='<the operation directory the Phase 0 block printed as OP_DIR; empty when it printed none>'$/gm) ?? []).length, 1, 'the finalize takes it');
      });
    }
  }
});

// A gate resolution's blocks (decide's Owner selection, refine's Owner
// decision): every clear takes the operation arguments the block chose (the
// operation the run's Phase 0 opened, or one it opens in a directory of its
// own), and every finish-verb after it closes it there. Without dispatch_target
// the blocks have no operation directory.
describe('the gate resolution blocks carry the operation (N4)', () => {
  const logical = (text) => text.replace(/\\\n(#)?\s*/g, ' ');
  const REGIONS = { decide: ['decide-owner-selection'], refine: ['refine-owner-decision', 'refine-owner-decision-convergent'] };
  for (const persona of personasFor('scripts/state.mjs')) {
    const info = personaInfo(persona);
    for (const [verb, ids] of Object.entries(REGIONS)) {
      it(`${persona}/${verb}`, () => {
        const text = readFileSync(info.path(`commands/${verb}.md`), 'utf8');
        const id = ids.find((r) => text.includes(`<!-- pipeline:begin ${r} -->`));
        ok(id, 'the owner gate region');
        const from = text.indexOf(`<!-- pipeline:begin ${id} -->`);
        const region = text.slice(from, text.indexOf(`<!-- pipeline:end ${id} -->`, from));
        if (info.capabilities.dispatch_target !== true) {
          ok(!region.includes('OP_DIR') && !region.includes('--operation-dir'), 'no operation directory');
          return;
        }
        const lines = logical(region).split('\n');
        const clears = lines.filter((l) => /state\.mjs" awaiting-owner-clear /.test(l));
        const finishes = lines.filter((l) => /state\.mjs" finish-verb /.test(l));
        ok(clears.length >= 1 && finishes.length >= 1, 'a clear and a finish-verb');
        for (const l of clears) ok(l.includes('"${OP_ARGS[@]}"'), l);
        for (const l of finishes) ok(l.includes('--operation-dir "$OP_DIR"'), l);
        // Each block opens one when the run passed none: a gate operation the
        // finish-verb closes, and for refine's Fix now a verb operation its
        // phases continue.
        const opens = [...region.matchAll(/OP_ARGS=\(--operation-dir "\$OP_DIR" --open-operation ([a-z]+)\)/g)].map((m) => m[1]);
        deepStrictEqual(opens, verb === 'refine' ? ['verb', 'gate'] : ['gate']);
        // Inside a /start lifecycle no finish-verb follows: given Phase 0's
        // directory, each clear closes that operation.
        strictEqual((region.match(/OP_ARGS=\(--operation-dir "\$OP_DIR" --close-operation true\)/g) ?? []).length, clears.length, 'each block closes the carried one inside start');
      });
    }
  }
});
