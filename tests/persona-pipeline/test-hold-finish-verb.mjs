// ADR-0068 Decision 2, item 6 (implementation note of 2026-10-25, N2, N3) — an
// interactive finish-verb of a macro's child records the next step and leaves
// the terminal marker unset while its subtask is held or has a kept park, or a
// run of its macro is live; only once a hold-aware orchestrator marked the
// macro's holds directory (item 9: until then the persona writes as today).
// Also the persona's content digest (N6) and capability token (N8). An earlier
// engineer's snapshot: test-hold-persona-mixed-version.mjs.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { personaInfo, personasFor } from './_personas.mjs';

const MACRO = 'macro-plan-20261025T000000Z-abcdef';
const SUBTASK = 'hold-persona';
const AUTOPILOT = '.agentic-plugins/runs/autopilot';
const MARKER = { schema: 'agentic-holds-protocol-1', protocol: 1, written_by: 'orchestrator@test', at: '2026-10-25T00:00:00Z' };
const HOLD = { schema: 'agentic-hold-1', hold_id: '00112233445566ff', subtask_id: SUBTASK, branch: 'main', lane: null, child: null, state: 'held', set_by: 'owner', set_at: '2026-10-25T00:00:00Z' };
const PARK = { schema: 'agentic-autopilot-park-1.0', record_id: '0123456789abcdef', subtask_id: SUBTASK, state: 'parked' };

// No AGENTIC_* (this session's run) and no GIT_* (an inherited GIT_INDEX_FILE
// or GIT_DIR would point the fixture's git at another repository).
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_')));

async function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hold-finish-'));
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
  }
}

function holdsFile(dir, rel, value) {
  const p = join(dir, AUTOPILOT, 'holds', MACRO, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
}

// A verb's Phase 0 opens its operation (N4), whose last write is the
// finish-verb: in a held lane a write outside one is refused (item 7).
const opDirs = new Map();
const child = async (state, persona, dir, head, { linked = true } = {}) => {
  const operationDir = mkdtempSync(join(tmpdir(), 'hold-op-'));
  const created = await state.createWorkflow({
    repoRoot: dir, verb: 'compose', host: 'claude', persona, originalRequest: 'hold',
    gitBaseline: { branch: 'main', head, status_digest: '' }, operationDir, env: cleanEnv(),
    ...(linked ? { parentWorkflow: MACRO, originatingSubtask: SUBTASK } : {}),
  });
  opDirs.set(created.filePath, operationDir);
  return created;
};

const finish = (state, workflowPath) => state.finishVerb({
  workflowPath, host: 'claude', nextAction: 'Critique the composed artifact',
  nextStep: { kind: 'verb', verb: 'critique', confidence: 'HIGH' }, env: cleanEnv(), operationDir: opDirs.get(workflowPath),
});

function assertOpen(state, filePath, result) {
  strictEqual(result.terminal, false);
  ok(result.held && typeof result.held.why === 'string', 'says why it stays open');
  const { frontmatter } = state.parseWorkflowFile(readFileSync(filePath, 'utf8'));
  strictEqual(frontmatter.terminal_marker, undefined);
  notStrictEqual(frontmatter.current_phase, 'summary-complete');
  deepStrictEqual([frontmatter.next_step_kind, frontmatter.next_step_verb, frontmatter.next_step_confidence], ['verb', 'critique', 'HIGH']);
}

function assertTerminal(state, filePath, result) {
  strictEqual(result.terminal, true);
  strictEqual(result.held, undefined);
  const { frontmatter } = state.parseWorkflowFile(readFileSync(filePath, 'utf8'));
  strictEqual(frontmatter.terminal_marker, true);
  strictEqual(frontmatter.current_phase, 'summary-complete');
}

const engineer = await import(pathToFileURL(personaInfo('engineer').path('scripts/state.mjs')).href);

describe('engineer: a hold-aware finish-verb (Decision 2, item 6)', () => {
  it('before a hold-aware orchestrator ran (no marker), writes terminal whatever the directory holds', () => withRepo(async ({ dir, head }) => {
    holdsFile(dir, `holds/${SUBTASK}.json`, HOLD);
    holdsFile(dir, `parks/${SUBTASK}.json`, PARK);
    const { filePath } = await child(engineer, 'engineer', dir, head);
    assertTerminal(engineer, filePath, await finish(engineer, filePath));
  }));

  it('active, with no hold, park or live run, writes terminal', () => withRepo(async ({ dir, head }) => {
    holdsFile(dir, 'protocol.json', MARKER);
    const { filePath } = await child(engineer, 'engineer', dir, head);
    assertTerminal(engineer, filePath, await finish(engineer, filePath));
  }));

  it('active, while the subtask is held, stays open', () => withRepo(async ({ dir, head }) => {
    holdsFile(dir, 'protocol.json', MARKER);
    holdsFile(dir, `holds/${SUBTASK}.json`, HOLD);
    const { filePath } = await child(engineer, 'engineer', dir, head);
    const result = await finish(engineer, filePath);
    assertOpen(engineer, filePath, result);
    match(result.held.why, /is held/);
  }));

  it('active, while the hold record cannot be read, stays open', () => withRepo(async ({ dir, head }) => {
    holdsFile(dir, 'protocol.json', MARKER);
    holdsFile(dir, `holds/${SUBTASK}.json`, '{');
    const { filePath } = await child(engineer, 'engineer', dir, head);
    assertOpen(engineer, filePath, await finish(engineer, filePath));
  }));

  for (const [why, hold] of [
    ['released', { ...HOLD, state: 'released' }],
    ['retired', { ...HOLD, state: 'retired' }],
    ['orphaned', { ...HOLD, orphaned: { at: '2026-10-25T00:00:00Z', why: 'left the plan' } }],
    ['set on another branch', { ...HOLD, branch: 'feat/other' }],
    ['set on another child', { ...HOLD, child: 'compose-20261024T000000Z-aaaaaa' }],
  ]) {
    it(`active, with a hold ${why}, writes terminal`, () => withRepo(async ({ dir, head }) => {
      holdsFile(dir, 'protocol.json', MARKER);
      holdsFile(dir, `holds/${SUBTASK}.json`, hold);
      const { filePath } = await child(engineer, 'engineer', dir, head);
      assertTerminal(engineer, filePath, await finish(engineer, filePath));
    }));
  }

  it('active, while the subtask has a kept park, stays open', () => withRepo(async ({ dir, head }) => {
    holdsFile(dir, 'protocol.json', MARKER);
    holdsFile(dir, `parks/${SUBTASK}.json`, PARK);
    const { filePath } = await child(engineer, 'engineer', dir, head);
    const result = await finish(engineer, filePath);
    assertOpen(engineer, filePath, result);
    match(result.held.why, /kept park/);
  }));

  it('active, while a run of the macro is live, stays open', () => withRepo(async ({ dir, head }) => {
    holdsFile(dir, 'protocol.json', MARKER);
    const holds = await import(pathToFileURL(personaInfo('engineer').path('scripts/lib/holds.mjs')).href);
    const lock = join(dir, AUTOPILOT, 'locks', `${MACRO}.lock`);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, `h-${process.pid}-aa.json`), JSON.stringify({ run_id: 'autopilot-20261025T000000Z-abcdef', pid: process.pid, fingerprint: holds.processFingerprint(process.pid), worker: null }));
    const { filePath } = await child(engineer, 'engineer', dir, head);
    const result = await finish(engineer, filePath);
    assertOpen(engineer, filePath, result);
    match(result.held.why, /is live/);
  }));

  it('while the holds directory cannot be read (an unreadable marker), stays open', () => withRepo(async ({ dir, head }) => {
    // Begun before: an unreadable marker refuses an operation's first write
    // and lets a running one finish (N2).
    const { filePath } = await child(engineer, 'engineer', dir, head);
    holdsFile(dir, 'protocol.json', { ...MARKER, protocol: 2 });
    const result = await finish(engineer, filePath);
    assertOpen(engineer, filePath, result);
    match(result.held.why, /cannot be read/);
  }));

  it("a hold set while finish-verb waits for the workflow's lock keeps it open", () => withRepo(async ({ dir, head }) => {
    holdsFile(dir, 'protocol.json', MARKER);
    const { filePath } = await child(engineer, 'engineer', dir, head);
    let pending;
    await engineer.withFileLock(filePath, async () => {
      pending = finish(engineer, filePath);
      await new Promise((r) => { setTimeout(r, 300); });
      holdsFile(dir, `holds/${SUBTASK}.json`, HOLD);
    }, { env: cleanEnv(), hold: false });
    assertOpen(engineer, filePath, await pending);
  }));

  it('a workflow that is no macro child writes terminal beside a held subtask', () => withRepo(async ({ dir, head }) => {
    // Begun before the hold: a held lane refuses an unlinked bootstrap (item 5).
    const { filePath } = await child(engineer, 'engineer', dir, head, { linked: false });
    holdsFile(dir, 'protocol.json', MARKER);
    holdsFile(dir, `holds/${SUBTASK}.json`, HOLD);
    assertTerminal(engineer, filePath, await finish(engineer, filePath));
  }));

  it('an owner gate is recorded as before, beside a hold', () => withRepo(async ({ dir, head }) => {
    holdsFile(dir, 'protocol.json', MARKER);
    holdsFile(dir, `holds/${SUBTASK}.json`, HOLD);
    const { filePath } = await child(engineer, 'engineer', dir, head);
    writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}\n### Routing recommendation\n\nx\n`);
    const result = await engineer.finishVerb({
      workflowPath: filePath, host: 'claude', nextAction: 'Owner: route',
      nextStep: { kind: 'owner-decision', confidence: 'HIGH' }, ownerGate: { gate: 'scope-routing', anchor: 'routing-recommendation' }, env: cleanEnv(),
      operationDir: opDirs.get(filePath),
    });
    strictEqual(result.terminal, false);
    strictEqual(result.held, undefined, 'the gate, not the hold, keeps it open');
    strictEqual(engineer.parseWorkflowFile(readFileSync(filePath, 'utf8')).frontmatter.awaiting_owner_gate, 'scope-routing');
  }));

  it('the CLI says why the workflow stays open', () => withRepo(async ({ dir, head }) => {
    holdsFile(dir, 'protocol.json', MARKER);
    holdsFile(dir, `holds/${SUBTASK}.json`, HOLD);
    const { filePath } = await child(engineer, 'engineer', dir, head);
    const actionDir = mkdtempSync(join(tmpdir(), 'hold-action-'));
    writeFileSync(join(actionDir, 'a.txt'), 'Critique the composed artifact\n');
    const r = spawnSync(process.execPath, [personaInfo('engineer').path('scripts/state.mjs'), 'finish-verb', '--workflow-path', filePath, '--host', 'claude',
      '--next-action-file', join(actionDir, 'a.txt'), '--next-step-kind', 'verb', '--next-step-verb', 'critique', '--next-step-confidence', 'HIGH',
      '--operation-dir', opDirs.get(filePath)], { cwd: dir, encoding: 'utf8', env: cleanEnv() });
    rmSync(actionDir, { recursive: true, force: true });
    strictEqual(r.status, 0, r.stderr);
    match(r.stderr, /stays open \(ADR-0068 Decision 2, item 6\): subtask hold-persona is held/);
    // No terminal handoff for a workflow that stays open.
    strictEqual(existsSync(join(dir, '.agentic-plugins/state/engineer/last-session-handoff.json')), false, 'no handoff projection written');
    strictEqual(engineer.parseWorkflowFile(readFileSync(filePath, 'utf8')).frontmatter.terminal_marker, undefined);
  }));
});

for (const persona of personasFor('scripts/state.mjs').filter((p) => p !== 'engineer')) {
  const state = await import(pathToFileURL(personaInfo(persona).path('scripts/state.mjs')).href);
  describe(`${persona}: finish-verb is unchanged beside holds (dispatch_target off)`, () => {
    it('writes terminal while a hold-aware orchestrator holds a subtask', () => withRepo(async ({ dir, head }) => {
      // Begun before the hold: a held lane refuses an unlinked bootstrap
      // (item 5), and every bootstrap of this persona is unlinked.
      const { filePath } = await child(state, persona, dir, head);
      holdsFile(dir, 'protocol.json', MARKER);
      holdsFile(dir, `holds/${SUBTASK}.json`, HOLD);
      holdsFile(dir, `parks/${SUBTASK}.json`, PARK);
      strictEqual(state.parseWorkflowFile(readFileSync(filePath, 'utf8')).frontmatter.parent_workflow, undefined, 'no linkage recorded');
      assertTerminal(state, filePath, await finish(state, filePath));
    }));
  });
}

for (const persona of personasFor('scripts/state.mjs')) {
  const info = personaInfo(persona);
  const state = await import(pathToFileURL(info.path('scripts/state.mjs')).href);
  describe(`${persona}: content digest (N6) and capability token (N8)`, () => {
    const digest = async (p) => (await state.contentDigest(p)).digest;

    it('a snapshot, from either host or trigger, leaves the digest unchanged', () => withRepo(async ({ dir, head }) => {
      const { filePath } = await child(state, persona, dir, head);
      const before = await state.contentDigest(filePath);
      strictEqual(before.schema, 'agentic-workflow-content-digest-1');
      await state.snapshot({ workflowPath: filePath, host: 'claude', trigger: 'stop', statusDigest: 'abc', env: cleanEnv() });
      await state.snapshot({ workflowPath: filePath, host: 'codex', trigger: 'pre-compact', env: cleanEnv() });
      strictEqual(await digest(filePath), before.digest);
    }));

    // Only a dispatch target writes under an autopilot run (ADR-0066 Decision 3).
    if (info.capabilities.dispatch_target === true) it('a snapshot of a workflow an autopilot step wrote leaves the digest unchanged', () => withRepo(async ({ dir, head }) => {
      const { filePath } = await child(state, persona, dir, head);
      const run = (step) => ({ ...cleanEnv(), AGENTIC_AUTOPILOT: 'autopilot-20261025T000000Z-abcdef', AGENTIC_AUTOPILOT_STEP: String(step) });
      await state.appendPhase({ workflowPath: filePath, host: 'claude', phaseNote: 'step 1', event: 'updated', env: run(1) });
      // An earlier release's write, which keeps no handoff generation, changes
      // the handoff: this release's next write (the snapshot) advances the stamp.
      const marked = readFileSync(filePath, 'utf8');
      ok(/^verify_handoff: /m.test(marked), 'the autopilot write stamped the handoff');
      writeFileSync(filePath, marked.replace(/^current_phase: .*$/m, 'current_phase: "phase-1-older-release"'));
      const before = await digest(filePath);
      const stamp = (t) => t.split('\n').find((l) => l.startsWith('verify_handoff: '));
      const stampBefore = stamp(readFileSync(filePath, 'utf8'));
      // A later step's snapshot moves the attempt mark on; a plain one stamps the handoff.
      await state.snapshot({ workflowPath: filePath, host: 'claude', trigger: 'stop', env: run(2) });
      await state.snapshot({ workflowPath: filePath, host: 'claude', trigger: 'stop', env: cleanEnv() });
      notStrictEqual(stamp(readFileSync(filePath, 'utf8')), stampBefore, 'the snapshots moved the stamp');
      strictEqual(await digest(filePath), before);
    }));

    it('a note, a next step, a body edit or a carried key moves it', () => withRepo(async ({ dir, head }) => {
      const { filePath } = await child(state, persona, dir, head);
      let last = await digest(filePath);
      const moved = async (what) => {
        const now = await digest(filePath);
        notStrictEqual(now, last, what);
        last = now;
      };
      await state.appendPhase({ workflowPath: filePath, host: 'claude', phaseNote: 'a note', event: 'updated', env: cleanEnv() });
      await moved('a note');
      await state.appendPhase({ workflowPath: filePath, host: 'claude', nextStep: { kind: 'verb', verb: 'critique', confidence: 'HIGH' }, event: 'updated', env: cleanEnv() });
      await moved('a next step');
      writeFileSync(filePath, readFileSync(filePath, 'utf8').replace('a note', 'a nite'));
      await moved('a body edit');
      const text = readFileSync(filePath, 'utf8');
      const end = text.indexOf('\n---\n', 4);
      writeFileSync(filePath, `${text.slice(0, end)}\nzz_future_key: "one"${text.slice(end)}`);
      await moved('a carried key added');
      writeFileSync(filePath, readFileSync(filePath, 'utf8').replace('zz_future_key: "one"', 'zz_future_key: "two"'));
      await moved('a carried key changed');
    }));

    it('the CLI prints the digest and the capability', () => withRepo(async ({ dir, head }) => {
      const { filePath } = await child(state, persona, dir, head);
      const run = (...a) => spawnSync(process.execPath, [info.path('scripts/state.mjs'), ...a], { cwd: dir, encoding: 'utf8', env: cleanEnv() });
      const d = run('content-digest', '--workflow-path', filePath);
      strictEqual(d.status, 0, d.stderr);
      deepStrictEqual(JSON.parse(d.stdout), await state.contentDigest(filePath));
      const c = run('hold-capability');
      strictEqual(c.status, 0, c.stderr);
      deepStrictEqual(JSON.parse(c.stdout), { capability: 'hold-persona-1', protocol: 1 });
    }));
  });
}
