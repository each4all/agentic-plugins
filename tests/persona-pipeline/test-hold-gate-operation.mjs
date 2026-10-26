// ADR-0068 Decision 2, item 7 (implementation note of 2026-10-25, N4) — a
// checkpoint and a gate resolution are persona operations. A checkpoint is one
// write: admitted as a first write is, it leaves no entry. A gate resolution
// runs from its clear to the finish-verb after it: the clear opens it in an
// operation directory, or continues the one the verb's Phase 0 opened, and the
// finish-verb closes it; a clear given neither is an operation of one write.
// designer and founder keep no operation.

import { describe, it } from 'node:test';
import { deepStrictEqual, rejects, strictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { personaInfo } from './_personas.mjs';

const MACRO = 'macro-plan-20261025T000000Z-abcdef';
const SUBTASK = 'hold-persona';
const MARKER = { schema: 'agentic-holds-protocol-1', protocol: 1, written_by: 'orchestrator@test', at: '2026-10-25T00:00:00Z' };
const OTHER = 'op-20261025T000000Z-0badf00d';

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_')));

const scratch = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'op-'));
  scratch.push(d);
  return d;
};

async function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'op-gate-'));
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

const holdsPath = (dir, rel = '') => join(dir, '.agentic-plugins/runs/autopilot/holds', MACRO, rel);
function holdsFile(dir, rel, value) {
  const p = holdsPath(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
}
const activate = (dir) => holdsFile(dir, 'protocol.json', MARKER);
const otherOpen = (dir) => holdsFile(dir, `ops/${SUBTASK}/${OTHER}.json`, { schema: 'agentic-persona-op-1', operation_id: OTHER, kind: 'verb' });
const opsDir = (dir) => holdsPath(dir, `ops/${SUBTASK}`);
const records = (dir) => (existsSync(opsDir(dir)) ? readdirSync(opsDir(dir)).filter((n) => !n.startsWith('.') && n !== `${OTHER}.json`).sort() : []);
const transport = (opDir) => JSON.parse(readFileSync(join(opDir, 'operation.json'), 'utf8'));

async function load(persona) {
  return import(pathToFileURL(personaInfo(persona).path('scripts/state.mjs')).href);
}
const engineer = await load('engineer');
const fm = (state, p) => state.parseWorkflowFile(readFileSync(p, 'utf8')).frontmatter;

const create = (state, persona, dir, head) => state.createWorkflow({
  repoRoot: dir, verb: 'decide', host: 'claude', persona, originalRequest: 'op', env: cleanEnv(),
  gitBaseline: { branch: 'main', head, status_digest: '' },
  ...(persona === 'engineer' ? { parentWorkflow: MACRO, originatingSubtask: SUBTASK } : {}),
});
const gate = (state, workflowPath) => state.appendPhase({
  workflowPath, host: 'claude', phaseLabel: 'Routing recommendation', phaseNote: 'x', event: 'updated', env: cleanEnv(),
  nextStep: { kind: 'owner-decision', confidence: 'HIGH' }, ownerGate: { gate: 'scope-routing', anchor: 'routing-recommendation' },
});
const clear = (state, workflowPath, extra = {}) => state.clearAwaitingOwner({
  workflowPath, host: 'claude', gate: 'scope-routing', resolution: 'Owner: compose it',
  nextStep: { kind: 'verb', verb: 'compose', confidence: 'HIGH' }, env: cleanEnv(), ...extra,
});
const finish = (state, workflowPath, opDir) => state.finishVerb({
  workflowPath, host: 'claude', nextAction: 'Compose it', nextStep: { kind: 'verb', verb: 'compose', confidence: 'HIGH' },
  env: cleanEnv(), operationDir: opDir,
});
const checkpoint = (state, workflowPath) => state.setCheckpoint({ workflowPath, host: 'claude', summary: 'half way', env: cleanEnv() });

describe('engineer: a checkpoint is an operation of one write', () => {
  it('inactive: as before', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    await checkpoint(engineer, filePath);
    deepStrictEqual([fm(engineer, filePath).latest_checkpoint.summary, fm(engineer, filePath).persona_operations], ['half way', undefined]);
  }));

  it('active: admitted, it leaves no entry and no record; beside another operation it is refused', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    activate(dir);
    await checkpoint(engineer, filePath);
    deepStrictEqual([fm(engineer, filePath).persona_operations, records(dir)], [undefined, []]);
    otherOpen(dir);
    const before = readFileSync(filePath, 'utf8');
    await rejects(checkpoint(engineer, filePath), new RegExp(`operation ${OTHER} \\(verb\\) is open in subtask ${SUBTASK}`));
    strictEqual(readFileSync(filePath, 'utf8'), before);
  }));

  // Held to the lock: what lands while the write waits for the workflow's
  // lock (another operation's entry, the owner's clear of this one) is seen.
  async function whileWaiting(filePath, dir, during) {
    let pending;
    await engineer.withFileLock(filePath, async () => {
      pending = checkpoint(engineer, filePath);
      for (let i = 0; i < 100 && records(dir).length === 0; i += 1) await new Promise((r) => { setTimeout(r, 20); });
      strictEqual(records(dir).length, 1, 'its record was published before the lock');
      during(records(dir)[0].replace(/\.json$/, ''));
    }, { env: cleanEnv(), hold: false });
    return pending;
  }

  it("another operation's entry that lands while it waits for the lock refuses it", () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    activate(dir);
    const pending = whileWaiting(filePath, dir, () => {
      const text = readFileSync(filePath, 'utf8');
      const end = text.indexOf('\n---\n', 4);
      const doc = JSON.stringify({ v: 1, ops: [{ id: OTHER, kind: 'verb', opened_at: '2026-10-25T00:00:00Z', ext: false }] });
      writeFileSync(filePath, `${text.slice(0, end)}\npersona_operations: ${JSON.stringify(doc)}${text.slice(end)}`);
    });
    await rejects(pending, new RegExp(`operation ${OTHER} \\(verb\\) is open on`));
    strictEqual(fm(engineer, filePath).latest_checkpoint, undefined);
  }));

  it('cleared by the owner while it waited for the lock, its one write is refused', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    activate(dir);
    const pending = whileWaiting(filePath, dir, (id) => holdsFile(dir, `ops/${SUBTASK}/${id}.cleared`, ''));
    await rejects(pending, /cleared by the owner \(writer-clear\) while it waited/);
    strictEqual(fm(engineer, filePath).latest_checkpoint, undefined);
  }));

  it('unreadable holds: refused', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    holdsFile(dir, 'protocol.json', '{');
    await rejects(checkpoint(engineer, filePath), /holds directory of .* cannot be read/);
  }));
});

describe('engineer: a gate resolution is one operation across its clear and its finish-verb', () => {
  it('the clear opens it in the directory, and the finish-verb closes it there', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    await gate(engineer, filePath);
    activate(dir);
    const opDir = tempDir();
    await clear(engineer, filePath, { operationDir: opDir, openOperation: 'gate' });
    const id = transport(opDir).operation_id;
    deepStrictEqual(fm(engineer, filePath).persona_operations.ops.map((o) => [o.id, o.kind, o.ext]), [[id, 'gate', true]]);
    deepStrictEqual(records(dir), [`${id}.json`], 'open between the clear and the finish-verb');
    await finish(engineer, filePath, opDir);
    deepStrictEqual([fm(engineer, filePath).persona_operations, records(dir)], [undefined, []]);
  }));

  it("the clear continues the operation the verb's Phase 0 opened", () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    await gate(engineer, filePath);
    activate(dir);
    const opDir = tempDir();
    await engineer.appendPhase({
      workflowPath: filePath, host: 'claude', verb: 'decide', phaseLabel: 'Phase 0: Resume into decide', event: 'resumed',
      env: cleanEnv(), operationDir: opDir, openOperation: 'verb',
    });
    const before = fm(engineer, filePath).persona_operations;
    await clear(engineer, filePath, { operationDir: opDir });
    deepStrictEqual(fm(engineer, filePath).persona_operations, before, 'the same operation, carried');
    strictEqual(fm(engineer, filePath).awaiting_owner_gate, undefined);
    await finish(engineer, filePath, opDir);
    deepStrictEqual([fm(engineer, filePath).persona_operations, records(dir)], [undefined, []]);
  }));

  it("inside a /start lifecycle the clear closes the operation Phase 0 opened (no finish-verb follows)", () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    await gate(engineer, filePath);
    activate(dir);
    const opDir = tempDir();
    await engineer.appendPhase({
      workflowPath: filePath, host: 'claude', phaseLabel: 'Phase 0: Resume', event: 'resumed',
      env: cleanEnv(), operationDir: opDir, openOperation: 'verb',
    });
    strictEqual(records(dir).length, 1);
    await clear(engineer, filePath, { operationDir: opDir, closeOperation: true, nextStep: undefined, clearNextStep: true });
    deepStrictEqual([fm(engineer, filePath).awaiting_owner_gate, fm(engineer, filePath).persona_operations, records(dir), transport(opDir).state], [undefined, undefined, [], 'closed']);
  }));

  it('a clear that means to continue an operation that ended is refused, writing nothing', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    const opDir = tempDir();
    await engineer.appendPhase({
      workflowPath: filePath, host: 'claude', phaseLabel: 'Phase 0: Resume into decide', event: 'resumed',
      env: cleanEnv(), operationDir: opDir, openOperation: 'verb',
    });
    // The verb's own finalize recorded the gate and closed its operation.
    await engineer.appendPhase({ workflowPath: filePath, host: 'claude', phaseLabel: 'Routing recommendation', phaseNote: 'x', event: 'updated', env: cleanEnv() });
    await engineer.finishVerb({
      workflowPath: filePath, host: 'claude', nextAction: 'Owner: route it', operationDir: opDir,
      nextStep: { kind: 'owner-decision', confidence: 'HIGH' }, ownerGate: { gate: 'scope-routing', anchor: 'routing-recommendation' }, env: cleanEnv(),
    });
    strictEqual(transport(opDir).state, 'closed');
    const before = readFileSync(filePath, 'utf8');
    await rejects(clear(engineer, filePath, { operationDir: opDir }), /no open operation in .* is closed/);
    strictEqual(readFileSync(filePath, 'utf8'), before);
  }));

  it("the CLI's clear takes the operation directory and kind, and the CLI's finish-verb closes it", () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    await gate(engineer, filePath);
    activate(dir);
    const opDir = tempDir();
    const cli = (...args) => spawnSync('node', [personaInfo('engineer').path('scripts/state.mjs'), ...args], { cwd: dir, encoding: 'utf8', env: cleanEnv() });
    const c = cli('awaiting-owner-clear', '--workflow-path', filePath, '--host', 'claude', '--gate', 'scope-routing',
      '--next-step-kind', 'verb', '--next-step-verb', 'compose', '--next-step-confidence', 'HIGH',
      '--operation-dir', opDir, '--open-operation', 'gate');
    strictEqual(c.status, 0, c.stderr);
    const id = transport(opDir).operation_id;
    deepStrictEqual([fm(engineer, filePath).persona_operations.ops.map((o) => o.kind), records(dir)], [['gate'], [`${id}.json`]]);
    const f = cli('finish-verb', '--workflow-path', filePath, '--host', 'claude', '--next-action', 'Compose it',
      '--next-step-kind', 'verb', '--next-step-verb', 'compose', '--next-step-confidence', 'HIGH', '--operation-dir', opDir);
    strictEqual(f.status, 0, f.stderr);
    deepStrictEqual([fm(engineer, filePath).persona_operations, records(dir)], [undefined, []]);
  }));

  it('a clear with no directory is an operation of one write: admitted alone, refused beside another', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    await gate(engineer, filePath);
    activate(dir);
    otherOpen(dir);
    const before = readFileSync(filePath, 'utf8');
    await rejects(clear(engineer, filePath), new RegExp(`operation ${OTHER} \\(verb\\) is open`));
    strictEqual(readFileSync(filePath, 'utf8'), before);
    rmSync(join(opsDir(dir), `${OTHER}.json`));
    await clear(engineer, filePath);
    deepStrictEqual([fm(engineer, filePath).awaiting_owner_gate, fm(engineer, filePath).persona_operations, records(dir)], [undefined, undefined, []]);
  }));
});

for (const persona of ['designer', 'founder']) {
  describe(`${persona}: a checkpoint and a gate clear keep no operation`, () => {
    it('with the linkage as data, beside an open operation record, both write as before', () => withRepo(async ({ dir, head }) => {
      const state = await load(persona);
      const { filePath } = await create(state, persona, dir, head);
      await gate(state, filePath);
      const text = readFileSync(filePath, 'utf8');
      const end = text.indexOf('\n---\n', 4);
      writeFileSync(filePath, `${text.slice(0, end)}\nparent_workflow: "${MACRO}"\noriginating_subtask: "${SUBTASK}"${text.slice(end)}`);
      activate(dir);
      otherOpen(dir);
      await checkpoint(state, filePath);
      await clear(state, filePath);
      deepStrictEqual([fm(state, filePath).awaiting_owner_gate, fm(state, filePath).latest_checkpoint.summary], [undefined, 'half way']);
    }));
  });
}
