// ADR-0059 Decision 9, item 3 (**The operation**) and Decision 10, item 5
// (C175): a persona operation's first write records its directory's marker id
// in the transport file (`dir_marker_id`), so the release can bind a closed
// operation to the directory it was opened in; and a last write given an
// operation directory that is missing writes nothing and says it may already
// have run. In process, through the functions the CLI calls; every directory
// lives under a test's own TMPDIR. An earlier engineer's close and replay of
// the field are in test-hold-persona-mixed-version.mjs, which reads the
// release from its tag.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, rejects, strictEqual } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { tmpDir } from '../_tmp.mjs';
import { personaInfo } from './_personas.mjs';

const MACRO = 'macro-plan-20261025T000000Z-abcdef';
const SUBTASK = 'hold-persona';
const MARKER = { schema: 'agentic-holds-protocol-1', protocol: 1, written_by: 'orchestrator@test', at: '2026-10-25T00:00:00Z' };

const engineer = await import(pathToFileURL(personaInfo('engineer').path('scripts/state.mjs')).href);
const adir = await import(pathToFileURL(personaInfo('engineer').path('scripts/lib/agentic-dir.mjs')).href);

// No AGENTIC_* (this session's run) and no GIT_* (an inherited GIT_DIR would
// point the fixture's git at another repository).
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_')));

function repo(t) {
  const dir = fs.realpathSync(tmpDir(t, 'adir-transport-repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: cleanEnv() }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(join(dir, 'README.md'), 'x\n');
  git('add', '.');
  git('commit', '-q', '-m', 'feat: base');
  return { dir, head: git('rev-parse', 'HEAD') };
}

const env = (root) => ({ TMPDIR: root });
const make = (root, kind, parent = null) => {
  const m = adir.makeDir({ kind, parent, env: env(root) });
  ok(m.ok, JSON.stringify(m));
  return m;
};
const transport = (opDir) => JSON.parse(fs.readFileSync(join(opDir, 'operation.json'), 'utf8'));
const activate = (dir) => {
  const p = join(dir, '.agentic-plugins/runs/autopilot/holds', MACRO, 'protocol.json');
  fs.mkdirSync(join(p, '..'), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(MARKER)}\n`);
};
const opsDir = (dir) => join(dir, '.agentic-plugins/runs/autopilot/holds', MACRO, 'ops', SUBTASK);
const fm = (p) => engineer.parseWorkflowFile(fs.readFileSync(p, 'utf8')).frontmatter;

const create = ({ dir, head }, opDir, { linked = true } = {}) => engineer.createWorkflow({
  repoRoot: dir, verb: 'compose', host: 'claude', persona: 'engineer', originalRequest: 'op', env: cleanEnv(),
  gitBaseline: { branch: 'main', head, status_digest: '' },
  ...(linked ? { parentWorkflow: MACRO, originatingSubtask: SUBTASK } : {}),
  ...(opDir === undefined ? {} : { operationDir: opDir }),
});
const open = (workflowPath, opDir) => engineer.appendPhase({
  workflowPath, host: 'claude', verb: 'compose', phaseLabel: 'Phase 0: Resume into compose', currentPhase: 'phase-0-resume',
  clearNextStep: true, event: 'resumed', env: cleanEnv(), operationDir: opDir, openOperation: 'verb',
});
const finish = (workflowPath, opDir) => engineer.finishVerb({
  workflowPath, host: 'claude', nextAction: 'Critique the composed artifact',
  nextStep: { kind: 'verb', verb: 'critique', confidence: 'HIGH' }, env: cleanEnv(), operationDir: opDir,
});

describe('the transport records the operation directory\'s marker id (Decision 9, item 3)', () => {
  it('a fresh open of a made op directory records it; the lane\'s record does not; the close keeps it, and the release removes the directory', async (t) => {
    const r = repo(t);
    activate(r.dir);
    const root = fs.realpathSync(tmpDir(t, 'adir-transport-'));
    const m = make(root, 'op');
    const { filePath } = await create(r, m.path);
    const opened = transport(m.path);
    strictEqual(opened.dir_marker_id, m.marker.id);
    strictEqual(opened.state, 'open');
    const [record] = fs.readdirSync(opsDir(r.dir)).filter((n) => n.endsWith('.json'));
    const rec = JSON.parse(fs.readFileSync(join(opsDir(r.dir), record), 'utf8'));
    strictEqual(rec.operation_id, opened.operation_id);
    strictEqual(Object.hasOwn(rec, 'dir_marker_id'), false, 'the lane record carries no directory');
    await finish(filePath, m.path);
    const closed = transport(m.path);
    deepStrictEqual([closed.state, closed.dir_marker_id], ['closed', m.marker.id]);
    deepStrictEqual(adir.releaseDir(m.path).outcome, 'removed');
  });

  it('a text directory\'s nested op records the nested marker\'s id, and its parent releases with it', async (t) => {
    const r = repo(t);
    const root = fs.realpathSync(tmpDir(t, 'adir-transport-'));
    const text = make(root, 'text');
    const nested = make(root, 'op', text.path);
    const { filePath } = await create(r);
    await open(filePath, nested.path);
    strictEqual(transport(nested.path).dir_marker_id, nested.marker.id);
    ok(nested.marker.id !== text.marker.id);
    await finish(filePath, nested.path);
    strictEqual(adir.releaseDir(text.path).outcome, 'removed');
  });

  it('a mktemp directory, a nested op of an unmarked parent, and a marker that does not name the directory record no field; the release refuses what they wrote', async (t) => {
    const r = repo(t);
    const root = fs.realpathSync(tmpDir(t, 'adir-transport-'));
    const legacy = fs.mkdtempSync(join(root, 'agentic-op.'));
    const { filePath } = await create(r, legacy);
    strictEqual(Object.hasOwn(transport(legacy), 'dir_marker_id'), false);
    await finish(filePath, legacy);
    strictEqual(Object.hasOwn(transport(legacy), 'dir_marker_id'), false, 'a field-less close stays field-less');
    deepStrictEqual([adir.releaseDir(legacy).outcome, adir.releaseDir(legacy).reason], ['not-owned', 'marker-absent']);

    // A marker copied from another directory names that one.
    const a = make(root, 'op');
    const b = make(root, 'op');
    fs.copyFileSync(join(a.path, '.agentic-dir.json'), join(b.path, '.agentic-dir.copy'));
    fs.renameSync(join(b.path, '.agentic-dir.copy'), join(b.path, '.agentic-dir.json'));
    strictEqual(adir.operationDirMarkerId(b.path), null);
    strictEqual(adir.operationDirMarkerId(a.path), a.marker.id);

    // A nested op whose own marker passes, under a text directory whose
    // marker is gone: the parent's proof is required too.
    const text = make(root, 'text');
    const nested = make(root, 'op', text.path);
    strictEqual(adir.operationDirMarkerId(nested.path), nested.marker.id);
    fs.unlinkSync(join(text.path, '.agentic-dir.json'));
    strictEqual(adir.operationDirMarkerId(nested.path), null);
    // Neither a path of another form, nor a claimed one, nor a text directory.
    for (const p of [join(root, 'elsewhere'), `${a.path}/`, join(root, `.removing-${a.path.split('/').at(-1)}`), make(root, 'text').path]) {
      strictEqual(adir.operationDirMarkerId(p), null, p);
    }
  });

  it('a first write run again keeps the id the file has; a field-less replay stays field-less', async (t) => {
    const r = repo(t);
    const root = fs.realpathSync(tmpDir(t, 'adir-transport-'));
    const m = make(root, 'op');
    const { filePath } = await create(r);
    await open(filePath, m.path);
    const first = transport(m.path);
    await open(filePath, m.path);
    deepStrictEqual(transport(m.path), first, 'the replay rewrote the same record');
    const legacy = fs.mkdtempSync(join(root, 'agentic-op.'));
    await open(filePath, legacy);
    // A marker that names the directory, placed after the first write, does
    // not bind the replay: the id is read only when the operation opens.
    const st = fs.lstatSync(legacy, { bigint: true });
    const pst = fs.statSync(root, { bigint: true });
    const id = 'ab'.repeat(16);
    fs.writeFileSync(join(legacy, '.agentic-dir.json'), JSON.stringify({
      schema: 'agentic-dir-1', id, kind: 'op', name: legacy.split('/').at(-1), made_at: '2026-11-26T00:00:00Z',
      dev: String(st.dev), ino: String(st.ino), uid: process.geteuid(), parent: { path: root, dev: String(pst.dev), ino: String(pst.ino) },
    }));
    strictEqual(adir.operationDirMarkerId(legacy), id, 'the marker passes');
    await open(filePath, legacy);
    strictEqual(Object.hasOwn(transport(legacy), 'dir_marker_id'), false);
  });

  it('designer and founder (dispatch_target off) keep no operation, so nothing is recorded', async (t) => {
    const designer = await import(pathToFileURL(personaInfo('designer').path('scripts/state.mjs')).href);
    const r = repo(t);
    const root = fs.realpathSync(tmpDir(t, 'adir-transport-'));
    const m = make(root, 'op');
    await designer.createWorkflow({
      repoRoot: r.dir, verb: 'compose', host: 'claude', persona: 'designer', originalRequest: 'op', env: cleanEnv(),
      gitBaseline: { branch: 'main', head: r.head, status_digest: '' }, parentWorkflow: MACRO, originatingSubtask: SUBTASK, operationDir: m.path,
    });
    strictEqual(fs.existsSync(join(m.path, 'operation.json')), false);
  });
});

describe('the closing write\'s message (Decision 10, item 5)', () => {
  const MISSING = /the operation directory .* is missing; nothing was written\. It may have been released after this write already ran, and then nothing is to be repeated; or it was lost\./;

  it('a macro\'s child: names the open operations, the later one included, and writer-clear with its condition; nothing is written', async (t) => {
    const r = repo(t);
    const root = fs.realpathSync(tmpDir(t, 'adir-transport-'));
    const a = make(root, 'op');
    const b = make(root, 'op');
    const { filePath } = await create(r, a.path);
    await open(filePath, b.path);
    const [ia, ib] = [transport(a.path).operation_id, transport(b.path).operation_id];
    fs.rmSync(a.path, { recursive: true });
    const before = fs.readFileSync(filePath, 'utf8');
    const err = await finish(filePath, a.path).then(() => null, (e) => e);
    ok(err, 'refused');
    match(err.message, MISSING);
    match(err.message, new RegExp(`Open on ${fm(filePath).workflow_id}: ${ia} \\(verb\\), ${ib} \\(verb\\)\\.`));
    match(err.message, new RegExp(`agentic-autopilot writer-clear ${SUBTASK} --macro ${MACRO} --operation <id>\`, only once the owner has established that the operation's session is gone`));
    match(err.message, /lifts its lane exclusion and, while the macro's holds are on, makes its closing write refuse\. \(ADR-0059 Decision 10, item 5\)$/);
    strictEqual(fs.readFileSync(filePath, 'utf8'), before, 'nothing was written');
    // A child's operation can be lost, so it never gets the non-child's remedy.
    strictEqual(/with no operation directory|keeps no persona operation/.test(err.message), false);
  });

  it('a workflow that is no macro\'s child, with no open operation, refuses too, with no writer-clear', async (t) => {
    const r = repo(t);
    const root = fs.realpathSync(tmpDir(t, 'adir-transport-'));
    const { filePath } = await create(r, undefined, { linked: false });
    const gone = join(root, 'agentic-op.Gone000000');
    const err = await finish(filePath, gone).then(() => null, (e) => e);
    ok(err, 'refused');
    match(err.message, MISSING);
    const wf = fm(filePath).workflow_id;
    match(err.message, new RegExp(`No operation is open on ${wf}\\.`));
    match(err.message, new RegExp(`${wf} keeps no persona operation `));
    // Its way forward: the write again with no operation directory, once the
    // workflow shows it did not land (and never when it landed).
    match(err.message, /shows that this write did not land, run this write again with no operation directory \(an empty OP_DIR\)/);
    match(err.message, /when it shows the write landed, nothing is to be repeated\./);
    match(err.message, /\(ADR-0059 Decision 10, item 5\)$/);
    strictEqual(/writer-clear/.test(err.message), false);
    // A first write given a missing directory is no last write: as before.
    await open(filePath, gone);
  });

  it('a lookup that fails is not a missing directory: a child refuses naming its code; a workflow that is no child writes as before', async (t) => {
    const r = repo(t);
    const root = fs.realpathSync(tmpDir(t, 'adir-transport-'));
    const file = join(root, 'a-file');
    fs.writeFileSync(file, 'x');
    const under = join(file, 'op');
    const { filePath } = await create(r, make(root, 'op').path);
    await rejects(finish(filePath, under), /the operation directory .* cannot be looked up \(ENOTDIR\); nothing was written/);
    await rejects(finish(filePath, file), /the operation directory .* is not a directory; nothing was written$/);
    const standalone = await create(repo(t), undefined, { linked: false });
    strictEqual((await finish(standalone.filePath, under)).terminal, true);
  });
});
