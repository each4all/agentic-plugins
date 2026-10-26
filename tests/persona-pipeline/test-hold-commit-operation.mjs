// ADR-0068 Decision 2, item 7 (implementation note of 2026-10-25, N4) — the
// commit's persona operation. `/engineer:commit` (Phase 7) opens it at its
// first write (beginCommit, or a close's terminal write) and it runs on through
// the terminal write, the Stop hook's archive and the parent note after it,
// which ends it; a commit that refuses before its terminal write ends it
// there, and one stopped by an error leaves it for the owner to clear. Its id
// is its entry on the child, where the Stop hook finds it. The
// staging-set gate an autopilot commit records is an operation of one write.
// The Stop hook's sweep leaves a child another session's operation is open on
// once the holds are active. designer and founder (dispatch_target and
// commit_surface off) keep no operation: their archives are as before.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { personaInfo, REPO_ROOT } from './_personas.mjs';

// This process's archives and snapshots read process.env: no AGENTIC_* (this
// session's run) and no GIT_* (an inherited GIT_INDEX_FILE or GIT_DIR would
// point the fixture's git at another repository).
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AGENTIC_') || k.startsWith('GIT_')) delete process.env[k];
}

const MACRO = 'macro-plan-20261025T000000Z-abcdef';
const SUBTASK = 'hold-persona';
const MARKER = { schema: 'agentic-holds-protocol-1', protocol: 1, written_by: 'orchestrator@test', at: '2026-10-25T00:00:00Z' };
const OTHER = 'op-20261025T000000Z-0badf00d';
const RUN = 'autopilot-20261025T000000Z-abcdef';

const childEnv = (extra = {}) => ({ ...process.env, AGENTIC_ORCHESTRATOR_ROOT: resolve(REPO_ROOT, 'plugins/orchestrator'), ...extra });

const E = personaInfo('engineer');
const STATE_BIN = E.path('scripts/state.mjs');
const PHASE7_BIN = E.path('scripts/phase7-commit.mjs');
const engineer = await import(pathToFileURL(STATE_BIN).href);
const stop = await import(pathToFileURL(E.path('scripts/stop-archive.mjs')).href);

const sh = (dir, cmd, args) => execFileSync(cmd, args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() }).trimEnd();
const run = (dir, bin, args, extra = {}) => {
  const r = spawnSync('node', [bin, ...args], { cwd: dir, encoding: 'utf8', env: childEnv(extra) });
  return { code: r.status, stdout: r.stdout.trimEnd(), stderr: r.stderr.trimEnd() };
};

function withSandbox(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hold-commit-'));
    try {
      for (const a of [['init', '-q', '-b', 'feat/s'], ['config', 'user.name', 't'], ['config', 'user.email', 't@example.invalid'], ['config', 'commit.gpgsign', 'false']]) sh(dir, 'git', a);
      writeFileSync(join(dir, 'release-please-config.json'), readFileSync(join(REPO_ROOT, 'release-please-config.json'), 'utf8'));
      writeFileSync(join(dir, '.gitignore'), '.agentic-plugins/\n');
      writeFileSync(join(dir, 'README.md'), '# sandbox\n');
      mkdirSync(join(dir, 'plugins', 'engineer'), { recursive: true });
      writeFileSync(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 0;\n');
      sh(dir, 'git', ['add', '.']);
      sh(dir, 'git', ['commit', '-qm', 'chore: sandbox baseline', '--no-verify']);
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const EMPTY_DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
function createChild(dir, bin = STATE_BIN, persona = 'engineer') {
  return sh(dir, 'node', [bin, 'create', '--repo-root', dir, '--verb', 'compose', '--profile', 'code', '--persona', persona,
    '--host', 'claude', '--git-baseline-branch', 'feat/s', '--git-baseline-head', sh(dir, 'git', ['rev-parse', 'HEAD']),
    '--status-digest', EMPTY_DIGEST, '--current-phase', 'phase-0-bootstrap', '--next-action', 'Run skill',
    '--original-request', 'wire the thing', '--parent-workflow', MACRO, '--originating-subtask', SUBTASK]);
}
const nextStep = (dir, wf, kind) => sh(dir, 'node', [STATE_BIN, 'append', '--workflow-path', wf, '--host', 'claude',
  '--next-step-kind', kind, '--next-step-confidence', 'HIGH', '--event', 'updated']);
function readyToCommit(dir) {
  const wf = createChild(dir);
  nextStep(dir, wf, 'commit');
  sh(dir, 'node', [STATE_BIN, 'record-composed-file', '--workflow-path', wf, '--path', 'plugins/engineer/a.mjs', '--op', 'edit']);
  writeFileSync(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
  return wf;
}
const execArgs = (dir, wf, ...extra) => ['--mode', 'execute', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude', '--suggested-subjects', ...extra];

const holdsPath = (dir, rel = '') => join(dir, '.agentic-plugins/runs/autopilot/holds', MACRO, rel);
function holdsFile(dir, rel, value) {
  const p = holdsPath(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
}
const activate = (dir) => holdsFile(dir, 'protocol.json', MARKER);
const opsDir = (dir) => holdsPath(dir, `ops/${SUBTASK}`);
const records = (dir) => (existsSync(opsDir(dir)) ? readdirSync(opsDir(dir)).filter((n) => !n.startsWith('.')).sort() : []);
const fmOf = (p) => engineer.parseWorkflowFile(readFileSync(p, 'utf8')).frontmatter;
const opsOf = (p) => fmOf(p).persona_operations?.ops ?? [];
const head = (dir) => sh(dir, 'git', ['rev-parse', 'HEAD']);

// The Stop hook on the child's branch, its parent note watched: what the
// commit's operation is when the note runs.
async function stopHook(dir, wf) {
  const seen = [];
  const result = await stop.runStopArchive({
    workflowPath: wf, host: 'claude', repoRoot: dir,
    headSha: head(dir), headSubject: sh(dir, 'git', ['log', '-1', '--format=%s']),
    stderr: { write() {} },
    noteParent: async ({ archivedPath }) => { seen.push({ entries: opsOf(archivedPath), records: records(dir) }); },
  });
  return { result, seen };
}

describe('engineer: the commit operation before a hold-aware orchestrator ran (inactive)', () => {
  it('opens at the commit, stays open through the terminal write, and ends after the archive and its parent note', withSandbox(async (dir) => {
    const wf = readyToCommit(dir);
    const r = run(dir, PHASE7_BIN, execArgs(dir, wf));
    strictEqual(r.code, 0, r.stderr);
    const fm = fmOf(wf);
    deepStrictEqual([fm.current_phase, fm.terminal_marker], ['commit-complete', true]);
    const [entry] = opsOf(wf);
    deepStrictEqual([opsOf(wf).length, entry.kind, entry.ext], [1, 'commit', false]);
    match(entry.id, /^op-\d{8}T\d{6}Z-[0-9a-f]{8}$/);
    strictEqual(existsSync(holdsPath(dir)), false, 'nothing under the holds directory');

    const { result, seen } = await stopHook(dir, wf);
    strictEqual(result.archived, true);
    deepStrictEqual(seen.map((s) => s.entries.map((o) => o.id)), [[entry.id]], 'still open when the parent note ran');
    strictEqual(fmOf(result.to).persona_operations, undefined, 'ended after it');
    deepStrictEqual(fmOf(result.to).host_history.at(-1).event, 'archived', 'the end adds no event: it is no progress');
  }));
});

describe('engineer: the commit operation once a hold-aware orchestrator runs (active)', () => {
  it('publishes its record at the commit and removes it only after the parent note', withSandbox(async (dir) => {
    activate(dir);
    const wf = readyToCommit(dir);
    const r = run(dir, PHASE7_BIN, execArgs(dir, wf));
    strictEqual(r.code, 0, r.stderr);
    const [entry] = opsOf(wf);
    deepStrictEqual([entry.kind, entry.ext], ['commit', true]);
    deepStrictEqual(records(dir), [`${entry.id}.json`], 'open past the terminal write');
    const { result, seen } = await stopHook(dir, wf);
    strictEqual(result.archived, true);
    deepStrictEqual(seen, [{ entries: [entry], records: [`${entry.id}.json`] }], 'open while the parent note ran');
    deepStrictEqual(records(dir), []);
    strictEqual(fmOf(result.to).persona_operations, undefined);
  }));

  it('is refused beside another open operation, before anything is committed', withSandbox(async (dir) => {
    activate(dir);
    const wf = readyToCommit(dir);
    holdsFile(dir, `ops/${SUBTASK}/${OTHER}.json`, { schema: 'agentic-persona-op-1', operation_id: OTHER, kind: 'verb' });
    const before = head(dir);
    const text = readFileSync(wf, 'utf8');
    const r = run(dir, PHASE7_BIN, execArgs(dir, wf));
    strictEqual(r.code === 0, false, r.stderr);
    match(r.stderr, new RegExp(`operation ${OTHER} \\(verb\\) is open in subtask ${SUBTASK}`));
    strictEqual(head(dir), before, 'nothing was committed');
    strictEqual(readFileSync(wf, 'utf8'), text, 'nothing was written');
    deepStrictEqual(records(dir), [`${OTHER}.json`]);
  }));

  it('a commit that stops before its terminal write ends its operation; run again it opens another', withSandbox(async (dir) => {
    activate(dir);
    const wf = readyToCommit(dir);
    // A pending ensemble fails the post-commit gate after the commit landed.
    sh(dir, 'node', [STATE_BIN, 'ensemble-pending', '--workflow-path', wf, '--phase', 'compose', '--ensemble-type', 'plan-verify', '--run-id', 'pv-1']);
    const r = run(dir, PHASE7_BIN, execArgs(dir, wf));
    strictEqual(r.code, 5, r.stderr);
    deepStrictEqual([opsOf(wf), records(dir)], [[], []], 'the stopped commit left no operation open');
    // Settled, the commit runs again (the landed commit's recovery).
    sh(dir, 'node', [STATE_BIN, 'ensemble-commit', '--workflow-path', wf, '--host', 'claude', '--phase', 'compose', '--ensemble-type', 'plan-verify', '--run-id', 'pv-1', '--verdict', 'agree', '--summary', 's']);
    const again = run(dir, PHASE7_BIN, execArgs(dir, wf));
    strictEqual(again.code, 0, again.stderr);
    deepStrictEqual(opsOf(wf).map((o) => o.kind), ['commit']);
    deepStrictEqual(records(dir), [`${opsOf(wf)[0].id}.json`]);
  }));

  it('a second commit beside one still open (running, or left by a crash) is refused until the owner clears it', withSandbox(async (dir) => {
    activate(dir);
    const wf = readyToCommit(dir);
    // The first write landed, then the commit died (or still runs).
    await engineer.beginCommit({ workflowPath: wf, host: 'claude' });
    const [entry] = opsOf(wf);
    const before = head(dir);
    const r = run(dir, PHASE7_BIN, execArgs(dir, wf));
    strictEqual(r.code === 0, false);
    match(r.stderr, new RegExp(`operation ${entry.id} \\(commit\\) is open`));
    strictEqual(head(dir), before, 'nothing was committed');
    // The owner's word that its session is gone: the next commit opens its own.
    holdsFile(dir, `ops/${SUBTASK}/${entry.id}.cleared`, '');
    const again = run(dir, PHASE7_BIN, execArgs(dir, wf));
    strictEqual(again.code, 0, again.stderr);
    const ops = opsOf(wf);
    deepStrictEqual([ops.length, ops[0].kind, ops[0].id === entry.id], [1, 'commit', false], 'the cleared entry went with its first write');
  }));

  it('an operation the owner cleared is not ended by the Stop hook: its entry and record stay', withSandbox(async (dir) => {
    activate(dir);
    const wf = readyToCommit(dir);
    strictEqual(run(dir, PHASE7_BIN, execArgs(dir, wf)).code, 0);
    const [entry] = opsOf(wf);
    holdsFile(dir, `ops/${SUBTASK}/${entry.id}.cleared`, '');
    const { result } = await stopHook(dir, wf);
    strictEqual(result.archived, true, 'the archive is the commit\'s own continuation');
    deepStrictEqual(opsOf(result.to), [entry], 'its last write refused');
    deepStrictEqual(records(dir), [`${entry.id}.cleared`, `${entry.id}.json`]);
  }));

  it('a commit whose archive gate fails stays open for the next Stop', withSandbox(async (dir) => {
    activate(dir);
    const wf = readyToCommit(dir);
    strictEqual(run(dir, PHASE7_BIN, execArgs(dir, wf)).code, 0);
    const [entry] = opsOf(wf);
    // An owner gate keeps the archive back (ADR-0063 D6).
    await engineer.appendPhase({
      workflowPath: wf, host: 'claude', phaseLabel: 'Routing recommendation', phaseNote: 'x', event: 'updated',
      nextStep: { kind: 'owner-decision', confidence: 'HIGH' }, ownerGate: { gate: 'scope-routing', anchor: 'routing-recommendation' },
    });
    const { result, seen } = await stopHook(dir, wf);
    strictEqual(result.archived, false);
    deepStrictEqual([seen, opsOf(wf), records(dir)], [[], [entry], [`${entry.id}.json`]]);
  }));
});

describe('engineer: the no-changes close and the staging-set gate are commit operations', () => {
  const closeArgs = (dir, wf) => ['--mode', 'close', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude'];

  for (const active of [false, true]) {
    it(`the close opens it at its terminal write and its archive ends it (${active ? 'active' : 'inactive'})`, withSandbox(async (dir) => {
      if (active) activate(dir);
      const wf = createChild(dir);
      nextStep(dir, wf, 'done');
      const r = run(dir, PHASE7_BIN, closeArgs(dir, wf));
      strictEqual(r.code, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      strictEqual(out.closed, true);
      strictEqual(fmOf(out.archived_to).current_phase, 'close-complete');
      strictEqual(fmOf(out.archived_to).persona_operations, undefined);
      deepStrictEqual(records(dir), []);
    }));
  }

  it('the close is refused beside another open operation, writing nothing', withSandbox(async (dir) => {
    activate(dir);
    const wf = createChild(dir);
    nextStep(dir, wf, 'done');
    holdsFile(dir, `ops/${SUBTASK}/${OTHER}.json`, { schema: 'agentic-persona-op-1', operation_id: OTHER, kind: 'verb' });
    const text = readFileSync(wf, 'utf8');
    const r = run(dir, PHASE7_BIN, closeArgs(dir, wf));
    strictEqual(r.code === 0, false);
    match(r.stderr, new RegExp(`operation ${OTHER} \\(verb\\) is open`));
    strictEqual(readFileSync(wf, 'utf8'), text);
  }));

  it('the staging-set gate is an operation of one write: admitted, it leaves no entry and no record', withSandbox(async (dir) => {
    activate(dir);
    const wf = readyToCommit(dir);
    writeFileSync(join(dir, 'stray.md'), 'not in the manifest\n');
    sh(dir, 'git', ['add', 'stray.md']);
    const blocked = (() => {
      holdsFile(dir, `ops/${SUBTASK}/${OTHER}.json`, { schema: 'agentic-persona-op-1', operation_id: OTHER, kind: 'verb' });
      const text = readFileSync(wf, 'utf8');
      const r = run(dir, PHASE7_BIN, ['--mode', 'autopilot', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude'], { AGENTIC_AUTOPILOT: RUN });
      rmSync(join(opsDir(dir), `${OTHER}.json`));
      return { r, unchanged: readFileSync(wf, 'utf8') === text };
    })();
    match(blocked.r.stderr, new RegExp(`operation ${OTHER} \\(verb\\) is open`));
    ok(blocked.unchanged, 'refused beside another operation, nothing written');
    const r = run(dir, PHASE7_BIN, ['--mode', 'autopilot', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude'], { AGENTIC_AUTOPILOT: RUN });
    strictEqual(r.code, 0, r.stderr);
    strictEqual(JSON.parse(r.stdout).action, 'staging-set');
    strictEqual(fmOf(wf).awaiting_owner_gate, 'staging-set');
    deepStrictEqual([fmOf(wf).persona_operations, records(dir)], [undefined, []]);
  }));
});

describe("the Stop hook's sweep and another session's operation", () => {
  // A terminal child of a branch no worktree has checked out (its lane's
  // worktree removed, the branch deleted), with an operation open on it.
  async function orphan(dir, { bin = STATE_BIN, persona = 'engineer', ext = true, field = true } = {}) {
    sh(dir, 'git', ['checkout', '-q', '-b', 'feat/gone']);
    const wf = sh(dir, 'node', [bin, 'create', '--repo-root', dir, '--verb', 'compose', '--profile', 'code', '--persona', persona,
      '--host', 'claude', '--git-baseline-branch', 'feat/gone', '--git-baseline-head', head(dir), '--status-digest', EMPTY_DIGEST,
      '--current-phase', 'phase-0-bootstrap', '--next-action', 'x', '--original-request', 'x',
      ...(persona === 'engineer' ? ['--parent-workflow', MACRO, '--originating-subtask', SUBTASK] : [])]);
    sh(dir, 'node', [bin, 'set-terminal', '--workflow-path', wf, '--host', 'claude', '--terminal-phase', 'summary-complete', '--terminal-marker', 'true']);
    // The operation, and for designer and founder the linkage, as data their
    // scripts only carry.
    const text = readFileSync(wf, 'utf8');
    const end = text.indexOf('\n---\n', 4);
    const doc = JSON.stringify({ v: 1, ops: [{ id: OTHER, kind: 'commit', opened_at: '2026-10-25T00:00:00Z', ext }] });
    const linkage = persona === 'engineer' ? '' : `\nparent_workflow: "${MACRO}"\noriginating_subtask: "${SUBTASK}"`;
    writeFileSync(wf, `${text.slice(0, end)}${linkage}${field ? `\npersona_operations: ${JSON.stringify(doc)}` : ''}${text.slice(end)}`);
    sh(dir, 'git', ['checkout', '-q', 'feat/s']);
    sh(dir, 'git', ['branch', '-q', '-D', 'feat/gone']);
    return wf;
  }

  it('active: it leaves the child; once the owner cleared the operation, it archives it', withSandbox(async (dir) => {
    activate(dir);
    const wf = await orphan(dir);
    let results = await stop.runStopArchiveOrphanSweep({ repoRoot: dir, host: 'claude', stderr: { write() {} } });
    deepStrictEqual(results, []);
    ok(existsSync(wf));
    holdsFile(dir, `ops/${SUBTASK}/${OTHER}.cleared`, '');
    results = await stop.runStopArchiveOrphanSweep({ repoRoot: dir, host: 'claude', stderr: { write() {} } });
    deepStrictEqual(results.map((x) => x.archived), [true]);
  }));

  it('a record with no entry on the child keeps it (published before its first write, or left by a crash)', withSandbox(async (dir) => {
    activate(dir);
    const wf = await orphan(dir);
    holdsFile(dir, `ops/${SUBTASK}/${OTHER}.cleared`, '');
    holdsFile(dir, 'ops/' + SUBTASK + '/op-20261025T000002Z-0badbeef.json', { schema: 'agentic-persona-op-1', operation_id: 'op-20261025T000002Z-0badbeef', kind: 'verb' });
    deepStrictEqual(await stop.runStopArchiveOrphanSweep({ repoRoot: dir, host: 'claude', stderr: { write() {} } }), []);
    ok(existsSync(wf));
  }));

  it('unreadable holds: it leaves a child with no operation field too', withSandbox(async (dir) => {
    // Set up before: with the holds unreadable, a write outside an operation
    // is refused (item 7).
    const wf = await orphan(dir, { field: false });
    holdsFile(dir, 'protocol.json', '{');
    deepStrictEqual(await stop.runStopArchiveOrphanSweep({ repoRoot: dir, host: 'claude', stderr: { write() {} } }), []);
    ok(existsSync(wf));
  }));

  it('unreadable holds: it leaves the child', withSandbox(async (dir) => {
    const wf = await orphan(dir);
    holdsFile(dir, 'protocol.json', '{');
    deepStrictEqual(await stop.runStopArchiveOrphanSweep({ repoRoot: dir, host: 'claude', stderr: { write() {} } }), []);
    ok(existsSync(wf));
  }));

  it('an operation opened between its read and the archive keeps the child (rechecked under the lock)', withSandbox(async (dir) => {
    activate(dir);
    const wf = await orphan(dir);
    holdsFile(dir, `ops/${SUBTASK}/${OTHER}.cleared`, '');
    const late = 'op-20261025T000001Z-0badcafe';
    const results = await stop.runStopArchiveOrphanSweep({
      repoRoot: dir, host: 'claude', stderr: { write() {} },
      archive: (args) => {
        const text = readFileSync(wf, 'utf8');
        const doc = JSON.stringify({ v: 1, ops: [{ id: late, kind: 'verb', opened_at: '2026-10-25T00:00:01Z', ext: true }] });
        writeFileSync(wf, text.replace(/^persona_operations: .*$/m, `persona_operations: ${JSON.stringify(doc)}`));
        return engineer.archiveWorkflow(args);
      },
    });
    deepStrictEqual(results.map((x) => [x.archived, x.gateFailures]), [[false, ['open_operation']]]);
    ok(existsSync(wf));
  }));

  it('inactive: it archives the child, and ends a commit operation on it', withSandbox(async (dir) => {
    const wf = await orphan(dir, { ext: false });
    const [res] = await stop.runStopArchiveOrphanSweep({ repoRoot: dir, host: 'claude', stderr: { write() {} } });
    strictEqual(res.archived, true);
    ok(!existsSync(wf));
    strictEqual(fmOf(res.to).persona_operations, undefined);
  }));

  for (const persona of ['designer', 'founder']) {
    it(`${persona}: keeps no operation, so the sweep archives as before and carries the field`, withSandbox(async (dir) => {
      activate(dir);
      const P = personaInfo(persona);
      const pstop = await import(pathToFileURL(P.path('scripts/stop-archive.mjs')).href);
      const wf = await orphan(dir, { bin: P.path('scripts/state.mjs'), persona });
      const field = readFileSync(wf, 'utf8').split('\n').find((l) => l.startsWith('persona_operations:'));
      const [res] = await pstop.runStopArchiveOrphanSweep({ repoRoot: dir, host: 'claude', stderr: { write() {} } });
      strictEqual(res?.archived, true);
      strictEqual(readFileSync(res.to, 'utf8').split('\n').find((l) => l.startsWith('persona_operations:')), field, 'carried byte for byte');
    }));
  }
});
