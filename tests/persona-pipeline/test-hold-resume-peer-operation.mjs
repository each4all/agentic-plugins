// ADR-0068 Decision 2, item 7 (implementation note of 2026-10-25, N4) —
// /resume and /peer-now are persona operations. The resume marker and the
// archive are each an operation of one write: admitted as a first write is, it
// leaves no entry. A consultation on a macro's child registers before its
// launch with a write of the entry alone (`state.mjs operation`), so the lane
// sees a run that names no workflow; its [Peer] note, or its failure, ends it.
// designer and founder keep no operation, and their runbooks pass no flag.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { personaInfo } from './_personas.mjs';

const MACRO = 'macro-plan-20261025T000000Z-abcdef';
const SUBTASK = 'hold-persona';
const MARKER = { schema: 'agentic-holds-protocol-1', protocol: 1, written_by: 'orchestrator@test', at: '2026-10-25T00:00:00Z' };
const OTHER = 'op-20261025T000000Z-0badf00d';
const RUN_ID = 'peer-now-20261025T000000Z-abc123';

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_')));

const scratch = [];
const tempDir = (prefix = 'op-') => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(d);
  return d;
};

async function withRepo(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'op-resume-peer-')));
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
  repoRoot: dir, verb: 'compose', host: 'claude', persona, originalRequest: 'op', env: cleanEnv(),
  gitBaseline: { branch: 'main', head, status_digest: '' },
  ...(persona === 'engineer' ? { parentWorkflow: MACRO, originatingSubtask: SUBTASK } : {}),
});
// designer and founder take no linkage: it is written in as data.
function linkAsData(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const end = text.indexOf('\n---\n', 4);
  writeFileSync(filePath, `${text.slice(0, end)}\nparent_workflow: "${MACRO}"\noriginating_subtask: "${SUBTASK}"${text.slice(end)}`);
}
const marker = (state, workflowPath) => state.appendPhase({
  workflowPath, host: 'claude', phaseLabel: 'Resume', phaseNote: 'Re-entered', event: 'resumed', env: cleanEnv(),
  childOperation: { point: 'once', kind: 'resume' },
});
const cliOf = (persona, dir) => (...args) => spawnSync('node', [personaInfo(persona).path('scripts/state.mjs'), ...args], { cwd: dir, encoding: 'utf8', env: cleanEnv() });

describe('engineer: the resume marker is an operation of one write', () => {
  it('inactive: as before', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    await marker(engineer, filePath);
    const f = fm(engineer, filePath);
    deepStrictEqual([f.host_history.at(-1).event, f.persona_operations], ['resumed', undefined]);
  }));

  it('active: admitted, it leaves no entry and no record; beside another operation it is refused, writing nothing', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    activate(dir);
    await marker(engineer, filePath);
    deepStrictEqual([fm(engineer, filePath).host_history.at(-1).event, fm(engineer, filePath).persona_operations, records(dir)], ['resumed', undefined, []]);
    otherOpen(dir);
    const before = readFileSync(filePath, 'utf8');
    await rejects(marker(engineer, filePath), new RegExp(`operation ${OTHER} \\(verb\\) is open in subtask ${SUBTASK}`));
    strictEqual(readFileSync(filePath, 'utf8'), before);
  }));

  it("the CLI's append takes --once-operation, and refuses it beside an operation directory", () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    activate(dir);
    otherOpen(dir);
    const cli = cliOf('engineer', dir);
    const before = readFileSync(filePath, 'utf8');
    const r = cli('append', '--workflow-path', filePath, '--host', 'claude', '--phase-label', 'Resume', '--event', 'resumed', '--once-operation', 'resume');
    strictEqual(r.status, 1, r.stderr);
    ok(r.stderr.includes(`operation ${OTHER} (verb) is open`), r.stderr);
    strictEqual(readFileSync(filePath, 'utf8'), before);
    const both = cli('append', '--workflow-path', filePath, '--host', 'claude', '--event', 'resumed', '--once-operation', 'resume', '--operation-dir', tempDir());
    strictEqual(both.status, 1);
    ok(both.stderr.includes('an operation directory or a child operation, not both'), both.stderr);
    strictEqual(readFileSync(filePath, 'utf8'), before);
  }));
});

describe('engineer: an archive is an operation of one write', () => {
  const archive = (dir, filePath) => cliOf('engineer', dir)('archive', '--workflow-path', filePath, '--host', 'claude', '--repo-root', dir);

  it('inactive: archives as before', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    const r = archive(dir, filePath);
    strictEqual(r.status, 0, r.stderr);
    ok(!existsSync(filePath) && existsSync(r.stdout.trim()));
  }));

  it('active: beside another operation it is refused and the workflow stays active; alone it archives, leaving no record', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    activate(dir);
    otherOpen(dir);
    const before = readFileSync(filePath, 'utf8');
    const refused = archive(dir, filePath);
    strictEqual(refused.status, 1);
    ok(refused.stderr.includes(`operation ${OTHER} (verb) is open in subtask ${SUBTASK}`), refused.stderr);
    strictEqual(readFileSync(filePath, 'utf8'), before);
    rmSync(join(opsDir(dir), `${OTHER}.json`));
    const r = archive(dir, filePath);
    strictEqual(r.status, 0, r.stderr);
    const to = r.stdout.trim();
    deepStrictEqual([existsSync(filePath), fm(engineer, to).persona_operations, records(dir)], [false, undefined, []]);
  }));

  it("cleared by the owner while it waited for the workflow's lock, it is refused and the workflow stays active", () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    activate(dir);
    let pending;
    await engineer.withFileLock(filePath, async () => {
      pending = engineer.archiveWorkflow({ workflowPath: filePath, host: 'claude', repoRoot: dir, onceOperationKind: 'archive', env: cleanEnv() });
      for (let i = 0; i < 100 && records(dir).length === 0; i += 1) await new Promise((r) => { setTimeout(r, 20); });
      strictEqual(records(dir).length, 1, 'its record was published before the lock');
      holdsFile(dir, `ops/${SUBTASK}/${records(dir)[0].replace(/\.json$/, '')}.cleared`, '');
    }, { env: cleanEnv(), hold: false });
    await rejects(pending, /cleared by the owner \(writer-clear\) while it waited/);
    // The owner's .cleared stays: it is the owner's, never the persona's to remove.
    deepStrictEqual([existsSync(filePath), records(dir).filter((n) => n.endsWith('.json'))], [true, []], 'the workflow stays, and its record goes once the locks are released');
  }));

  it('a source already gone is no write: no operation opens for it', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    activate(dir);
    otherOpen(dir);
    rmSync(filePath);
    const r = await engineer.archiveWorkflow({ workflowPath: filePath, host: 'claude', repoRoot: dir, onceOperationKind: 'archive', env: cleanEnv() });
    deepStrictEqual([r.archived, r.reason, records(dir)], [false, 'source-missing', []]);
  }));

  it('an archive that closes an operation is not one as well', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    await rejects(
      engineer.archiveWorkflow({ workflowPath: filePath, host: 'claude', repoRoot: dir, onceOperationKind: 'archive', closeOperationKind: 'commit', env: cleanEnv() }),
      /closes an operation or is one, not both/,
    );
    ok(existsSync(filePath));
  }));
});

describe("engineer: an operation's own write (state.mjs operation) moves the entry alone", () => {
  const book = (filePath, opDir, extra) => engineer.bookkeepOperation({ workflowPath: filePath, host: 'claude', operationDir: opDir, env: cleanEnv(), ...extra });
  // Clocks a minute apart from the create's, so a write that stamped
  // updated_at would be seen, whatever second the case runs in.
  const LATER = new Date(Date.now() + 60_000);
  const LATEST = new Date(Date.now() + 120_000);

  it('opens and closes a peer operation, adding no host_history event and moving no updated_at', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    activate(dir);
    const before = fm(engineer, filePath);
    const opDir = tempDir();
    const opened = await book(filePath, opDir, { openOperation: 'peer', now: LATER });
    const id = transport(opDir).operation_id;
    deepStrictEqual(opened, { written: true, id });
    const mid = fm(engineer, filePath);
    deepStrictEqual(mid.persona_operations.ops.map((o) => [o.id, o.kind, o.ext]), [[id, 'peer', true]]);
    deepStrictEqual([mid.updated_at, mid.host_history], [before.updated_at, before.host_history]);
    deepStrictEqual(records(dir), [`${id}.json`]);
    deepStrictEqual(await book(filePath, opDir, { closeOperation: true, now: LATEST }), { written: true, id });
    const after = fm(engineer, filePath);
    deepStrictEqual([after.persona_operations, after.updated_at, after.host_history, records(dir), transport(opDir).state],
      [undefined, before.updated_at, before.host_history, [], 'closed']);
  }));

  it('beside another operation the open is refused, writing nothing', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    activate(dir);
    otherOpen(dir);
    const before = readFileSync(filePath, 'utf8');
    await rejects(book(filePath, tempDir(), { openOperation: 'peer' }), new RegExp(`operation ${OTHER} \\(verb\\) is open in subtask ${SUBTASK}`));
    deepStrictEqual([readFileSync(filePath, 'utf8'), records(dir)], [before, []]);
  }));

  it('a close in a directory that opened nothing writes nothing', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    const before = readFileSync(filePath, 'utf8');
    deepStrictEqual(await book(filePath, tempDir(), { closeOperation: true }), { written: false, id: null });
    strictEqual(readFileSync(filePath, 'utf8'), before);
  }));

  it('takes one point and a directory', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    await rejects(book(filePath, tempDir(), {}), /opens its operation .* or closes it/);
    await rejects(book(filePath, tempDir(), { openOperation: 'peer', closeOperation: true }), /opens its operation .* or closes it/);
    await rejects(book(filePath, undefined, { openOperation: 'peer' }), /takes the command's operation directory/);
  }));

  it('the CLI prints what it wrote', () => withRepo(async ({ dir, head }) => {
    const { filePath } = await create(engineer, 'engineer', dir, head);
    const opDir = tempDir();
    const r = cliOf('engineer', dir)('operation', '--workflow-path', filePath, '--host', 'claude', '--operation-dir', opDir, '--open-operation', 'peer');
    strictEqual(r.status, 0, r.stderr);
    deepStrictEqual(JSON.parse(r.stdout), { written: true, id: transport(opDir).operation_id });
    deepStrictEqual(fm(engineer, filePath).persona_operations.ops.map((o) => [o.kind, o.ext]), [['peer', false]]);
  }));
});

// --- the runbooks' blocks ------------------------------------------------------

function regionBlock(persona, dest, id) {
  const text = readFileSync(personaInfo(persona).path(dest), 'utf8');
  const begin = text.indexOf(`<!-- pipeline:begin ${id} -->`);
  const end = text.indexOf(`<!-- pipeline:end ${id} -->`);
  // Contract: the region this file runs — gone, the case would run nothing.
  ok(begin >= 0 && end > begin, `${persona}/${dest} holds region ${id}`);
  const body = text.slice(begin, end);
  const runnable = [...body.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => !/^\s*mktemp -d /.test(b));
  strictEqual(runnable.length, 1, `${id}: one block to run`);
  return runnable[0];
}
function fill(block, placeholder, value) {
  ok(block.includes(placeholder), `the block holds ${placeholder}`);
  return block.split(placeholder).join(value);
}

// A plugin root whose state.mjs is the persona's own and whose peer-runner is
// a stub: `run` records the lane's operation records at its launch
// (STUB_SEEN), and exits STUB_RC.
function stubRoot(persona) {
  const root = tempDir('op-root-');
  mkdirSync(join(root, 'scripts'));
  symlinkSync(personaInfo(persona).path('scripts/state.mjs'), join(root, 'scripts/state.mjs'));
  writeFileSync(join(root, 'scripts/peer-runner.mjs'), `
import { existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const [cmd, ...rest] = process.argv.slice(2);
const flag = (n) => rest[rest.indexOf('--' + n) + 1];
if (cmd === 'new-run-id') { process.stdout.write(${JSON.stringify(RUN_ID)} + '\\n'); process.exit(0); }
if (cmd !== 'run') process.exit(2);
const ops = process.env.STUB_OPS;
writeFileSync(process.env.STUB_SEEN, JSON.stringify(existsSync(ops) ? readdirSync(ops).sort() : []));
const runDir = join(flag('repo-root'), '.stub-run');
mkdirSync(runDir, { recursive: true });
writeFileSync(join(runDir, 'handle.json'), JSON.stringify({ run_id: flag('run-id'), peer_host: flag('peer') }));
writeFileSync(join(runDir, 'stdout.log'), 'the answer\\n');
const rc = Number(process.env.STUB_RC ?? 0);
if (rc === 137) process.exit(rc);
process.stdout.write(JSON.stringify({ ok: rc === 0, run_id: flag('run-id'), handle_path: join(runDir, 'handle.json'),
  stdout_path: join(runDir, 'stdout.log'), stderr_path: join(runDir, 'stderr.log'), status: rc === 0 ? 'completed' : 'failed', ...(rc === 0 ? {} : { error_kind: 'peer_run_error' }) }));
process.exit(rc);
`);
  return root;
}

const SHELLS = ['bash', 'zsh'].filter((s) => spawnSync(s, ['-c', 'true']).status === 0);

function runBlock(shell, dir, block, root, persona, extra = {}) {
  const env = { ...cleanEnv(), [`AGENTIC_${persona.toUpperCase()}_ROOT`]: root, ...extra };
  return spawnSync(shell, ['-c', block], { cwd: dir, encoding: 'utf8', env });
}

for (const shell of SHELLS) {
  describe(`engineer runbooks (${shell}): /peer-now registers its consultation, and /resume's marker is one write`, () => {
    const dispatchBlock = (textDir) => fill(fill(regionBlock('engineer', 'commands/peer-now.md', 'peer-now-dispatch'),
      "TEXT_DIR='<directory from step 1>'", `TEXT_DIR='${textDir}'`), "PEER='<claude|codex, from --peer>'", "PEER='codex'");
    const noteBlock = (textDir) => fill(regionBlock('engineer', 'commands/peer-now.md', 'peer-now-note'),
      "DISPATCH_DIR='<the directory the dispatch ran with>'", `DISPATCH_DIR='${textDir}'`);
    const consult = (dir, root, rc = 0, textDir = tempDir('op-text-')) => {
      writeFileSync(join(textDir, 'prompt.xml'), '<task>x</task>\n');
      const seen = join(textDir, 'seen.json');
      const r = runBlock(shell, dir, dispatchBlock(textDir), root, 'engineer', { STUB_OPS: opsDir(dir), STUB_SEEN: seen, STUB_RC: String(rc) });
      return { r, textDir, seen: existsSync(seen) ? JSON.parse(readFileSync(seen, 'utf8')) : null };
    };

    it('active: the record is published before the launch, stays open after it, and the note ends it', () => withRepo(async ({ dir, head }) => {
      const { filePath } = await create(engineer, 'engineer', dir, head);
      activate(dir);
      const root = stubRoot('engineer');
      const { r, textDir, seen } = consult(dir, root);
      strictEqual(r.status, 0, r.stderr);
      const id = transport(join(textDir, 'op')).operation_id;
      deepStrictEqual(seen, [`${id}.json`], 'the lane saw the consultation while it ran');
      deepStrictEqual(fm(engineer, filePath).persona_operations.ops.map((o) => [o.id, o.kind]), [[id, 'peer']]);
      const n = runBlock(shell, dir, noteBlock(textDir), root, 'engineer');
      strictEqual(n.status, 0, n.stderr);
      const f = fm(engineer, filePath);
      deepStrictEqual([f.persona_operations, records(dir), transport(join(textDir, 'op')).state], [undefined, [], 'closed']);
      ok(readFileSync(filePath, 'utf8').includes('### [Peer] codex consultation'));
    }));

    it('a failed consultation ends its operation in the dispatch', () => withRepo(async ({ dir, head }) => {
      const { filePath } = await create(engineer, 'engineer', dir, head);
      activate(dir);
      const { r, textDir, seen } = consult(dir, stubRoot('engineer'), 1);
      strictEqual(r.status, 1);
      strictEqual(seen.length, 1);
      deepStrictEqual([fm(engineer, filePath).persona_operations, records(dir), transport(join(textDir, 'op')).state], [undefined, [], 'closed']);
    }));

    it('a runner that left no result (killed, its peer maybe still running) leaves the operation open', () => withRepo(async ({ dir, head }) => {
      const { filePath } = await create(engineer, 'engineer', dir, head);
      activate(dir);
      const { r, textDir } = consult(dir, stubRoot('engineer'), 137);
      strictEqual(r.status, 137);
      ok(r.stderr.includes('left no ended result'), r.stderr);
      const id = transport(join(textDir, 'op')).operation_id;
      deepStrictEqual([fm(engineer, filePath).persona_operations.ops.map((o) => o.id), records(dir), transport(join(textDir, 'op')).state], [[id], [`${id}.json`], 'open']);
    }));

    it('a dispatch run again from the same directory launches no second consultation', () => withRepo(async ({ dir, head }) => {
      const { filePath } = await create(engineer, 'engineer', dir, head);
      activate(dir);
      const root = stubRoot('engineer');
      const first = consult(dir, root);
      strictEqual(first.r.status, 0, first.r.stderr);
      const again = consult(dir, root, 1, first.textDir);
      strictEqual(again.r.status, 1);
      ok(again.r.stderr.includes('dispatch each consultation from a fresh directory'), again.r.stderr);
      const id = transport(join(first.textDir, 'op')).operation_id;
      deepStrictEqual([fm(engineer, filePath).persona_operations.ops.map((o) => o.id), records(dir)], [[id], [`${id}.json`]], 'the first one stays open');
    }));

    it('the note goes only to the workflow the dispatch was for', () => withRepo(async ({ dir, head }) => {
      activate(dir);
      const root = stubRoot('engineer');
      const { r, textDir } = consult(dir, root);
      strictEqual(r.status, 0, r.stderr);
      strictEqual(readFileSync(join(textDir, 'prompt.xml.workflow'), 'utf8'), '\n', 'standalone: for no workflow');
      // A macro's child appears after the standalone dispatch.
      const { filePath } = await create(engineer, 'engineer', dir, head);
      otherOpen(dir);
      const before = readFileSync(filePath, 'utf8');
      const n = runBlock(shell, dir, noteBlock(textDir), root, 'engineer');
      strictEqual(n.status, 1);
      ok(n.stderr.includes('was dispatched for no workflow, not'), n.stderr);
      strictEqual(readFileSync(filePath, 'utf8'), before);
    }));

    it('beside another operation in the lane nothing is launched', () => withRepo(async ({ dir, head }) => {
      const { filePath } = await create(engineer, 'engineer', dir, head);
      activate(dir);
      otherOpen(dir);
      const before = readFileSync(filePath, 'utf8');
      const { r, seen } = consult(dir, stubRoot('engineer'));
      strictEqual(r.status, 1);
      ok(r.stderr.includes('nothing was dispatched'), r.stderr);
      deepStrictEqual([seen, readFileSync(filePath, 'utf8'), records(dir)], [null, before, []]);
    }));

    it('with no active workflow the consultation is standalone: no operation directory', () => withRepo(async ({ dir }) => {
      activate(dir);
      const { r, textDir, seen } = consult(dir, stubRoot('engineer'));
      strictEqual(r.status, 0, r.stderr);
      deepStrictEqual([seen, existsSync(join(textDir, 'op'))], [[], false]);
    }));

    it('scripts that do not know holds (no hold-capability) open none', () => withRepo(async ({ dir, head }) => {
      const { filePath } = await create(engineer, 'engineer', dir, head);
      activate(dir);
      otherOpen(dir);
      const root = stubRoot('engineer');
      // An earlier state.mjs: every command but hold-capability is the real one.
      rmSync(join(root, 'scripts/state.mjs'));
      writeFileSync(join(root, 'scripts/state.mjs'), `
if (process.argv[2] === 'hold-capability') process.exit(1);
process.argv.splice(1, 1, ${JSON.stringify(personaInfo('engineer').path('scripts/state.mjs'))});
await import(${JSON.stringify(pathToFileURL(personaInfo('engineer').path('scripts/state.mjs')).href)});
`);
      const { r, textDir, seen } = consult(dir, root);
      strictEqual(r.status, 0, r.stderr);
      deepStrictEqual([seen, existsSync(join(textDir, 'op')), fm(engineer, filePath).persona_operations], [[`${OTHER}.json`], false, undefined]);
    }));

    it("the resume marker's block: refused beside another operation, written alone", () => withRepo(async ({ dir, head }) => {
      const { filePath } = await create(engineer, 'engineer', dir, head);
      activate(dir);
      otherOpen(dir);
      const textDir = tempDir('op-text-');
      writeFileSync(join(textDir, 'note.md'), 'Re-entered via /engineer:resume; drift=clean. no changes since baseline\n');
      writeFileSync(join(textDir, 'read.json'), JSON.stringify({ workflow_id: fm(engineer, filePath).workflow_id, git_baseline: { head } }));
      const block = fill(fill(regionBlock('engineer', 'commands/resume.md', 'resume-marker'),
        "TEXT_DIR='<directory from step 1>'", `TEXT_DIR='${textDir}'`), "READ_DIR='<the directory Phase 2 read into>'", `READ_DIR='${textDir}'`);
      const root = personaInfo('engineer').root;
      const before = readFileSync(filePath, 'utf8');
      const refused = runBlock(shell, dir, block, root, 'engineer');
      strictEqual(refused.status, 1);
      ok(refused.stderr.includes(`operation ${OTHER} (verb) is open`), refused.stderr);
      strictEqual(readFileSync(filePath, 'utf8'), before);
      rmSync(join(opsDir(dir), `${OTHER}.json`));
      const r = runBlock(shell, dir, block, root, 'engineer');
      strictEqual(r.status, 0, r.stderr);
      deepStrictEqual([fm(engineer, filePath).host_history.at(-1).event, fm(engineer, filePath).persona_operations, records(dir)], ['resumed', undefined, []]);
    }));
  });
}

describe('engineer skills: the Codex side passes the same operation flags', () => {
  it("peer-now's dispatch opens and, on a failure, closes the consultation; its label step closes it at the note", () => {
    const text = readFileSync(personaInfo('engineer').path('core/skills/peer-now/SKILL.md'), 'utf8');
    const dispatch = [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).find((b) => b.includes('peer-runner.mjs" run'));
    ok(dispatch, 'the dispatch block');
    const launch = dispatch.indexOf('peer-runner.mjs" run');
    const open = dispatch.indexOf('--open-operation peer');
    const close = dispatch.indexOf('--close-operation true');
    ok(open > 0 && open < launch, 'opened before the launch');
    ok(close > launch && /if \[ "\$RUN_RC" -ne 0 \] && \[ -n "\$OP_DIR" \]; then/.test(dispatch), 'closed after a failed launch');
    ok(/hold-capability >\/dev\/null 2>&1; then/.test(dispatch), 'only with scripts that know holds');
    ok(text.includes('\`prompt.xml.workflow\` (empty for none): a workflow found now that the\n  consultation was not for gets no note.'), 'the note goes to the workflow the dispatch was for');
    ok(text.includes('pass \`--operation-dir <that directory>/op --close-operation\n  true\` with the append'), 'the note closes it');
    ok(/failed\|cancelled\|orphaned\)/.test(dispatch), 'only a run its result says ended');
  });

  it("resume's marker step passes --once-operation resume", () => {
    ok(readFileSync(personaInfo('engineer').path('core/skills/resume/SKILL.md'), 'utf8').includes('Pass `--once-operation resume` with it'));
  });

  for (const persona of ['designer', 'founder']) {
    it(`${persona}'s skills pass none`, () => {
      for (const skill of ['peer-now', 'resume']) {
        ok(!/--open-operation|--close-operation|--once-operation/.test(readFileSync(personaInfo(persona).path(`core/skills/${skill}/SKILL.md`), 'utf8')), `${persona}/${skill}`);
      }
    });
  }
});

for (const persona of ['designer', 'founder']) {
  describe(`${persona}: /resume and /peer-now keep no operation`, () => {
    it('the runbooks pass no operation flag', () => {
      for (const [dest, id] of [['commands/peer-now.md', 'peer-now-dispatch'], ['commands/peer-now.md', 'peer-now-note'], ['commands/resume.md', 'resume-marker']]) {
        const b = regionBlock(persona, dest, id);
        ok(!/operation|OP_DIR|OP_ARGS/.test(b), `${persona}/${dest} ${id}`);
      }
    });

    it('with the linkage as data, beside an open operation record, the marker, the archive and an operation write are as before', () => withRepo(async ({ dir, head }) => {
      const state = await load(persona);
      const { filePath } = await create(state, persona, dir, head);
      linkAsData(filePath);
      activate(dir);
      otherOpen(dir);
      await marker(state, filePath);
      strictEqual(fm(state, filePath).host_history.at(-1).event, 'resumed');
      const before = readFileSync(filePath, 'utf8');
      deepStrictEqual(await state.bookkeepOperation({ workflowPath: filePath, host: 'claude', operationDir: tempDir(), openOperation: 'peer', env: cleanEnv() }),
        { written: false, id: null });
      strictEqual(readFileSync(filePath, 'utf8'), before);
      const r = cliOf(persona, dir)('archive', '--workflow-path', filePath, '--host', 'claude', '--repo-root', dir);
      strictEqual(r.status, 0, r.stderr);
      ok(!existsSync(filePath));
    }));
  });
}
