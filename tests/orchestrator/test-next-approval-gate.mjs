// tests/orchestrator/test-next-approval-gate.mjs
//
// ADR-0063 D4 rule 3 and owner decision D3 (slice S6) — the plan-approval
// gate of /orchestrator:next. Under an autopilot run only a plan approved at
// its current hash is dispatched; interactive dispatch is never refused and
// warns in one line about a plan pending approval or changed since it was
// approved; a macro planned before schema 1.2 dispatches as it always did.
// The gate is state.mjs approval-gate; the runbook blocks are run as written,
// in bash and (when installed) zsh, against real macro files.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ORCH_ROOT = resolve(REPO_ROOT, 'plugins/orchestrator');
const STATE = resolve(ORCH_ROOT, 'scripts/state.mjs');
const {
  createWorkflow, setPlan, approvePlan, updateSubtask, planApprovalGate, parseWorkflowFile, assembleWorkflowFile,
} = await import(STATE);

const RUN_ID = 'autopilot-20260930T010203Z-abcdef';
const SHELLS = ['bash', 'zsh'].filter((sh) => spawnSync(sh, ['-c', 'true']).status === 0);

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-next-approval-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function rewrite(filePath, edit) {
  const { frontmatter, body } = parseWorkflowFile(await readFile(filePath, 'utf8'));
  edit(frontmatter);
  await writeFile(filePath, assembleWorkflowFile(frontmatter, body));
}

// A macro in each approval state the gate distinguishes. `stale` is what a
// 1.1 writer leaves: it changes the plan without resetting the approval.
// `absent` is a macro no 1.2 writer planned: schema 1.1, no approval keys.
async function macro(dir, state) {
  const { filePath } = await createWorkflow({
    repoRoot: dir, verb: 'plan', host: 'claude',
    gitBaseline: { branch: 'main', head: '0'.repeat(40), status_digest: '' },
    originalRequest: 'next approval gate fixture',
  });
  await setPlan({
    workflowPath: filePath, host: 'claude',
    verdict: state === 'conflict' ? 'conflict' : 'pass',
    subtasks: [
      { id: 'A', verb: 'compose', profile: 'backend', branch: 'feat/a', blocked_by: [], status: 'pending', topic: 'first' },
      { id: 'B', verb: 'refine', branch: 'feat/b', blocked_by: ['A'], status: 'blocked' },
    ],
  });
  if (state === 'approved' || state === 'stale') {
    await approvePlan({ workflowPath: filePath, host: 'claude', env: {} });
  }
  if (state === 'stale') {
    await rewrite(filePath, (fm) => { fm.plan.subtasks[0].topic = 'changed after the approval'; });
  }
  if (state === 'absent') {
    await rewrite(filePath, (fm) => {
      fm.schema = '1.1';
      for (const k of ['plan_approval_status', 'awaiting_owner_gate', 'awaiting_owner_since', 'awaiting_owner_pointer']) {
        delete fm[k];
      }
    });
  }
  return filePath;
}

const pointerOf = (filePath, anchor) =>
  `.agentic-plugins/state/orchestrator/workflows/${basename(filePath)}#${anchor}`;

// The environment a block or the CLI runs in: this plugin, and no autopilot
// run unless the case names one — a runner that exports AGENTIC_AUTOPILOT
// must not turn the interactive cases into autopilot ones.
function envFor(extra = {}, base = process.env) {
  const env = { ...base, AGENTIC_ORCHESTRATOR_ROOT: ORCH_ROOT, ...extra };
  delete env.CLAUDE_PLUGIN_ROOT;
  for (const k of ['AGENTIC_AUTOPILOT', 'EXPLICIT_SUBTASK_ID', 'EXPLICIT_WORKFLOW_ID', 'SUBTASK_JSON']) {
    if (!(k in extra)) delete env[k];
  }
  return env;
}

describe('test controls', () => {
  it('a block or CLI run drops the autopilot and selection variables the runner carries', () => {
    const planted = {
      PATH: '/usr/bin', AGENTIC_AUTOPILOT: RUN_ID, EXPLICIT_SUBTASK_ID: 'B', EXPLICIT_WORKFLOW_ID: 'x',
      SUBTASK_JSON: '{"id":"B"}', CLAUDE_PLUGIN_ROOT: '/elsewhere', AGENTIC_ORCHESTRATOR_ROOT: '/elsewhere',
    };
    const env = envFor({}, planted);
    for (const k of ['AGENTIC_AUTOPILOT', 'EXPLICIT_SUBTASK_ID', 'EXPLICIT_WORKFLOW_ID', 'SUBTASK_JSON', 'CLAUDE_PLUGIN_ROOT']) {
      strictEqual(k in env, false, k);
    }
    strictEqual(env.AGENTIC_ORCHESTRATOR_ROOT, ORCH_ROOT);
    strictEqual(env.PATH, '/usr/bin');
    strictEqual(envFor({ AGENTIC_AUTOPILOT: 'x' }, planted).AGENTIC_AUTOPILOT, 'x');
  });
});

// The subtask as a dispatcher selected it: by default, A as the file holds it.
async function subtaskIn(filePath, id = 'A') {
  const { frontmatter } = parseWorkflowFile(await readFile(filePath, 'utf8'));
  return frontmatter.plan.subtasks.find((s) => s.id === id);
}

async function gateFor(filePath, opts = {}) {
  const { host = 'claude', env = {} } = opts;
  const selected = 'selected' in opts ? opts.selected : await subtaskIn(filePath);
  const { frontmatter } = parseWorkflowFile(await readFile(filePath, 'utf8'));
  return planApprovalGate({ frontmatter, workflowPath: filePath, host, env, selected });
}

describe('planApprovalGate (ADR-0063 D4 rule 3, owner decision D3)', () => {
  const table = [
    // state, interactive verdict, autopilot verdict
    ['approved', 'proceed', 'proceed'],
    ['absent', 'proceed', 'refuse'],
    ['pending', 'warn', 'refuse'],
    ['stale', 'warn', 'refuse'],
    ['conflict', 'warn', 'refuse'],
  ];
  for (const [state, interactive, autopilot] of table) {
    it(`${state}: interactive ${interactive}, autopilot ${autopilot}`, async () => {
      await withDir(async (dir) => {
        const filePath = await macro(dir, state);
        const before = await readFile(filePath, 'utf8');
        const i = await gateFor(filePath);
        strictEqual(i.verdict, interactive);
        strictEqual(i.autopilot, false);
        strictEqual(i.lines.length, { proceed: 0, warn: 1 }[interactive]);
        const a = await gateFor(filePath, { env: { AGENTIC_AUTOPILOT: RUN_ID } });
        strictEqual(a.verdict, autopilot);
        strictEqual(a.autopilot, true);
        strictEqual(a.lines.length, { proceed: 0, refuse: 2 }[autopilot]);
        strictEqual(a.reason, autopilot === 'refuse' ? 'plan-unapproved' : null);
        strictEqual(await readFile(filePath, 'utf8'), before, 'the gate writes nothing');
      });
    });
  }

  it('reads the approval facts next-ready reports', async () => {
    await withDir(async (dir) => {
      for (const [state, approval] of [
        ['approved', { status: 'approved', hash_ok: true }],
        ['stale', { status: 'approved', hash_ok: false }],
        ['pending', { status: 'pending', hash_ok: null }],
        ['absent', { status: 'absent', hash_ok: null }],
      ]) {
        const filePath = await macro(dir, state);
        deepStrictEqual((await gateFor(filePath)).approval, approval, state);
        const nextReady = JSON.parse(execFileSync('node', [STATE, 'next-ready', '--workflow-path', filePath], { encoding: 'utf8' }));
        deepStrictEqual(nextReady.approval, approval, `${state}: the same facts as next-ready`);
        await rm(filePath);
      }
    });
  });

  it('a refusal names the reason, the run, the state, where the owner acts and the command', async () => {
    await withDir(async (dir) => {
      const filePath = await macro(dir, 'pending');
      const [first, second] = (await gateFor(filePath, { env: { AGENTIC_AUTOPILOT: RUN_ID } })).lines;
      ok(first.startsWith('✗ plan-unapproved — '), first);
      ok(first.includes(`AGENTIC_AUTOPILOT=${RUN_ID}`), first);
      ok(first.includes('this plan is pending approval (awaiting_owner_gate=plan-approval)'), first);
      ok(second.includes(`Pointer: ${pointerOf(filePath, 'macro-plan')}.`), second);
      ok(second.includes(`/orchestrator:approve --workflow=${basename(filePath, '.md')}`), second);
    });
  });

  it('says why each plan is unapproved, and points a conflict at its synthesis', async () => {
    await withDir(async (dir) => {
      const env = { AGENTIC_AUTOPILOT: RUN_ID };
      let filePath = await macro(dir, 'absent');
      let [first, second] = (await gateFor(filePath, { env })).lines;
      ok(first.includes('this plan has no approval recorded'), first);
      ok(second.includes(pointerOf(filePath, 'macro-plan')), second);
      await rm(filePath);

      filePath = await macro(dir, 'stale');
      const approvedAt = parseWorkflowFile(await readFile(filePath, 'utf8')).frontmatter.plan_approval_approved_at;
      [first] = (await gateFor(filePath, { env })).lines;
      ok(first.includes(`this plan has changed since it was approved at ${approvedAt}`), first);
      await rm(filePath);

      filePath = await macro(dir, 'conflict');
      [first, second] = (await gateFor(filePath, { env })).lines;
      ok(first.includes('awaiting_owner_gate=plan-conflict'), first);
      ok(second.includes(`Pointer: ${pointerOf(filePath, 'ensemble-synthesis')}.`), second);
      ok(second.includes('settles the Plan-verify conflict'), second);
      ok(second.includes('awaiting-owner-clear --gate plan-conflict'), second);
    });
  });

  it('warns interactively in one line that says an autopilot run would refuse', async () => {
    await withDir(async (dir) => {
      for (const state of ['pending', 'stale']) {
        const filePath = await macro(dir, state);
        const { lines, reason } = await gateFor(filePath);
        strictEqual(reason, 'plan-unapproved');
        strictEqual(lines.length, 1);
        ok(lines[0].startsWith('⚠ This plan '), lines[0]);
        ok(!lines[0].includes('\n'), 'one line');
        ok(lines[0].includes('dispatching anyway, which an autopilot run would refuse'), lines[0]);
        ok(lines[0].includes(`/orchestrator:approve --workflow=${basename(filePath, '.md')}`), lines[0]);
        await rm(filePath);
      }
    });
  });

  it('spells the command for the host', async () => {
    await withDir(async (dir) => {
      const filePath = await macro(dir, 'conflict');
      const [line] = (await gateFor(filePath, { host: 'codex' })).lines;
      ok(line.includes('$orchestrator:approve --workflow='), line);
      ok(line.includes('$orchestrator:plan'), line);
      ok(!line.includes('/orchestrator:'), line);
      await rejects(() => gateFor(filePath, { host: 'cursor' }), /Invalid host/);
    });
  });

  it('is on only for a well-formed run id', async () => {
    await withDir(async (dir) => {
      const filePath = await macro(dir, 'pending');
      for (const value of ['', '1', 'true', 'autopilot', 'autopilot-20260930T010203Z-ABCDEF', ` ${RUN_ID}`, `${RUN_ID}\n`]) {
        const gate = await gateFor(filePath, { env: { AGENTIC_AUTOPILOT: value } });
        strictEqual(gate.autopilot, false, JSON.stringify(value));
        strictEqual(gate.verdict, 'warn', JSON.stringify(value));
      }
    });
  });

  it('under autopilot, binds the approval to the subtask as it was selected', async () => {
    await withDir(async (dir) => {
      const filePath = await macro(dir, 'approved');
      const selected = await subtaskIn(filePath);
      const env = { AGENTIC_AUTOPILOT: RUN_ID };
      strictEqual((await gateFor(filePath, { env, selected })).verdict, 'proceed');
      // Progress is not what the owner approves: a selection read before it moved still matches.
      const progressed = { ...selected, status: 'in_progress', engineer_workflow_id: 'eng-A' };
      strictEqual((await gateFor(filePath, { env, selected: progressed })).verdict, 'proceed');
      for (const [what, changed] of [
        ['topic', { ...selected, topic: 'never approved' }],
        ['label', { ...selected, label: 'never approved' }],
        ['branch', { ...selected, branch: 'feat/other' }],
        ['verb', { ...selected, verb: 'refine' }],
        ['profile', { ...selected, profile: undefined }],
        ['blocked_by', { ...selected, blocked_by: ['B'] }],
        ['id', { ...selected, id: 'Z' }],
      ]) {
        const gate = await gateFor(filePath, { env, selected: changed });
        strictEqual(gate.verdict, 'refuse', what);
        strictEqual(gate.reason, 'plan-unapproved', what);
        ok(gate.lines[0].startsWith('✗ plan-unapproved — '), gate.lines[0]);
        ok(gate.lines[0].includes(`subtask ${changed.id} as selected is not in it`), gate.lines[0]);
        ok(gate.lines[1].includes(`Pointer: ${pointerOf(filePath, 'macro-plan')}. Run /orchestrator:next again`), gate.lines[1]);
      }
      // Interactive dispatch is not refused over it (D3).
      strictEqual((await gateFor(filePath, { selected: { ...selected, topic: 'x' } })).verdict, 'proceed');
    });
  });

  it('needs the selected subtask as an object with an id', async () => {
    await withDir(async (dir) => {
      const filePath = await macro(dir, 'approved');
      for (const selected of [null, [], 'A', { label: 'no id' }, { id: 7 }]) {
        await rejects(() => gateFor(filePath, { selected }), /selected subtask must be a JSON object with a string id/);
      }
    });
  });
});

async function rejects(fn, pattern) {
  let error;
  try { await fn(); } catch (e) { error = e; }
  ok(error, 'expected a rejection');
  ok(pattern.test(error.message), error.message);
}

describe('state.mjs approval-gate', () => {
  const cli = (args, extra) => spawnSync('node', [STATE, 'approval-gate', ...args], { encoding: 'utf8', env: envFor(extra) });

  it('exits 1 on a refusal, 0 otherwise, with the verdict as JSON and the lines on stderr', async () => {
    await withDir(async (dir) => {
      const filePath = await macro(dir, 'pending');
      const args = ['--workflow-path', filePath, '--host', 'claude', '--subtask-json', JSON.stringify(await subtaskIn(filePath))];
      let r = cli(args, { AGENTIC_AUTOPILOT: RUN_ID });
      strictEqual(r.status, 1);
      const refused = JSON.parse(r.stdout);
      deepStrictEqual(Object.keys(refused).sort(), ['approval', 'autopilot', 'pointer', 'reason', 'verdict']);
      strictEqual(refused.verdict, 'refuse');
      strictEqual(r.stderr.split('\n').filter(Boolean).length, 2);
      ok(r.stderr.startsWith('✗ plan-unapproved'), r.stderr);

      r = cli(args);
      strictEqual(r.status, 0, r.stderr);
      strictEqual(JSON.parse(r.stdout).verdict, 'warn');
      strictEqual(r.stderr.split('\n').filter(Boolean).length, 1);
    });
  });

  it('needs --host and --subtask-json, and refuses a selection that is not a subtask', async () => {
    await withDir(async (dir) => {
      const filePath = await macro(dir, 'approved');
      const json = JSON.stringify(await subtaskIn(filePath));
      for (const [args, message] of [
        [['--workflow-path', filePath, '--subtask-json', json], 'missing required flag --host'],
        [['--workflow-path', filePath, '--host', 'claude'], 'missing required flag --subtask-json'],
        [['--workflow-path', filePath, '--host', 'claude', '--subtask-json', '{"id":'], '--subtask-json is not JSON'],
        [['--workflow-path', filePath, '--host', 'claude', '--subtask-json', '[]'], 'must be a JSON object with a string id'],
      ]) {
        const r = cli(args);
        strictEqual(r.status, 1, message);
        ok(r.stderr.includes(message), r.stderr);
        strictEqual(r.stdout, '', message);
      }
    });
  });
});

// The runbook blocks as written.
async function nextMd() {
  return readFile(resolve(ORCH_ROOT, 'commands/next.md'), 'utf8');
}

async function phase1Blocks() {
  const text = await nextMd();
  const from = text.indexOf('## Phase 1 — Subtask selection');
  const to = text.indexOf('## Phase 2 — Branch precondition');
  ok(from >= 0 && to > from, 'next.md carries Phase 1 and Phase 2');
  return [...text.slice(from, to).matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
}

async function gateBlock() {
  const blocks = await phase1Blocks();
  const gates = blocks.filter((b) => b.includes('approval-gate'));
  strictEqual(gates.length, 1, 'Phase 1 has one approval-gate block');
  return gates[0];
}

// The Codex mirror's gate snippet, with its root placeholder filled in.
async function codexGateBlock() {
  const text = await readFile(resolve(ORCH_ROOT, 'core/skills/next/SKILL.md'), 'utf8');
  const from = text.indexOf('## Phase 1 - Resolve macro and subtask');
  const to = text.indexOf('## Phase 2 - Branch and ownership preconditions');
  ok(from >= 0 && to > from, 'SKILL.md carries Phase 1 and Phase 2');
  const gates = [...text.slice(from, to).matchAll(/```bash\n([\s\S]*?)```/g)]
    .map((m) => m[1]).filter((b) => b.includes('approval-gate'));
  strictEqual(gates.length, 1, 'the mirror\'s Phase 1 has one approval-gate block');
  ok(gates[0].includes('"<orchestrator-plugin-root>/scripts/state.mjs"'), gates[0]);
  return gates[0].replaceAll('<orchestrator-plugin-root>', ORCH_ROOT);
}

describe('/orchestrator:next runbook shape', () => {
  it('Phase 1 ends with the gate, after the dispatch-ready validation and before Phase 2', async () => {
    const blocks = await phase1Blocks();
    strictEqual(blocks.length, 3, 'selection, validation, gate');
    ok(blocks[1].includes('case "$SUBTASK_STATUS" in'), 'the second block validates the subtask');
    ok(blocks[2].includes('approval-gate'), 'the last Phase 1 block is the gate');
    ok(blocks[2].includes('--workflow-path "$MACRO_PATH" --host claude \\\n  --subtask-json "$SUBTASK_JSON" >/dev/null || exit 1'), blocks[2]);
  });

  it('the Codex mirror runs the same gate in its Phase 1, as codex', async () => {
    const block = await codexGateBlock();
    ok(block.includes('--workflow-path "$MACRO_PATH" --host codex \\\n  --subtask-json "$SUBTASK_JSON" >/dev/null || exit 1'), block);
  });
});

for (const shell of SHELLS) {
  describe(`/orchestrator:next approval gate block (${shell})`, () => {
    const run = async (filePath, extra = {}, block = gateBlock) =>
      spawnSync(shell, ['-c', `${await block()}\necho DISPATCH`], {
        encoding: 'utf8',
        env: envFor({ MACRO_PATH: filePath, SUBTASK_JSON: JSON.stringify(await subtaskIn(filePath)), ...extra }),
      });

    it('under autopilot, refuses every plan not approved at its current hash', async () => {
      await withDir(async (dir) => {
        for (const state of ['pending', 'stale', 'absent', 'conflict']) {
          const filePath = await macro(dir, state);
          const r = await run(filePath, { AGENTIC_AUTOPILOT: RUN_ID });
          strictEqual(r.status, 1, `${state}: ${r.stderr}`);
          strictEqual(r.stdout, '', `${state}: nothing past the gate runs`);
          ok(r.stderr.startsWith('✗ plan-unapproved — '), r.stderr);
          await rm(filePath);
        }
      });
    });

    it('under autopilot, passes an approved plan silently', async () => {
      await withDir(async (dir) => {
        const r = await run(await macro(dir, 'approved'), { AGENTIC_AUTOPILOT: RUN_ID });
        strictEqual(r.status, 0, r.stderr);
        strictEqual(r.stderr, '');
        strictEqual(r.stdout, 'DISPATCH\n', 'the JSON verdict stays off the runbook output');
      });
    });

    it('interactively, warns in one line and dispatches; a legacy or approved macro gets no line', async () => {
      await withDir(async (dir) => {
        for (const [state, lines] of [['pending', 1], ['stale', 1], ['conflict', 1], ['absent', 0], ['approved', 0]]) {
          const filePath = await macro(dir, state);
          const r = await run(filePath);
          strictEqual(r.status, 0, `${state}: ${r.stderr}`);
          strictEqual(r.stdout, 'DISPATCH\n', state);
          const got = r.stderr.split('\n').filter(Boolean);
          strictEqual(got.length, lines, `${state}: ${r.stderr}`);
          if (lines) ok(got[0].startsWith('⚠ This plan '), got[0]);
          await rm(filePath);
        }
      });
    });

    it('the Codex mirror refuses and warns the same way, naming the Codex command', async () => {
      await withDir(async (dir) => {
        const filePath = await macro(dir, 'pending');
        let r = await run(filePath, { AGENTIC_AUTOPILOT: RUN_ID }, codexGateBlock);
        strictEqual(r.status, 1, r.stderr);
        strictEqual(r.stdout, '');
        ok(r.stderr.startsWith('✗ plan-unapproved — '), r.stderr);
        ok(r.stderr.includes('$orchestrator:approve --workflow='), r.stderr);
        r = await run(filePath, {}, codexGateBlock);
        strictEqual(r.status, 0, r.stderr);
        strictEqual(r.stdout, 'DISPATCH\n');
        strictEqual(r.stderr.split('\n').filter(Boolean).length, 1, r.stderr);
        await approvePlan({ workflowPath: filePath, host: 'claude', env: {} });
        r = await run(filePath, { AGENTIC_AUTOPILOT: RUN_ID }, codexGateBlock);
        strictEqual(r.status, 0, r.stderr);
        strictEqual(r.stderr, '');
      });
    });
  });

  // The explicit id is gated as well as the automatic pick: Phase 1 as a
  // whole, selection → validation → gate.
  describe(`/orchestrator:next Phase 1 end to end (${shell})`, () => {
    const script = async (between = '') => {
      const [selection, validation, gate] = await phase1Blocks();
      return `${selection}\n${validation}\n${between}\n${gate}\necho "DISPATCH $SUBTASK_ID $SUBTASK_TOPIC"`;
    };
    const run = async (filePath, extra = {}, between = '') =>
      spawnSync(shell, ['-c', await script(between)], {
        encoding: 'utf8', env: envFor({ MACRO_PATH: filePath, ...extra }),
      });

    it('refuses every unapproved plan under autopilot, by explicit id and by automatic pick', async () => {
      await withDir(async (dir) => {
        for (const state of ['pending', 'stale', 'absent', 'conflict']) {
          const filePath = await macro(dir, state);
          for (const extra of [{ EXPLICIT_SUBTASK_ID: 'A' }, {}]) {
            const r = await run(filePath, { AGENTIC_AUTOPILOT: RUN_ID, ...extra });
            strictEqual(r.status, 1, `${state} ${JSON.stringify(extra)}: ${r.stderr}`);
            ok(r.stderr.startsWith('✗ plan-unapproved'), r.stderr);
            ok(!r.stdout.includes('DISPATCH'), r.stdout);
          }
          await rm(filePath);
        }
      });
    });

    it('dispatches once the owner approves, and interactively with a warning before that', async () => {
      await withDir(async (dir) => {
        const filePath = await macro(dir, 'pending');
        for (const extra of [{ EXPLICIT_SUBTASK_ID: 'A' }, {}]) {
          const r = await run(filePath, extra);
          strictEqual(r.status, 0, r.stderr);
          strictEqual(r.stdout, 'DISPATCH A first\n');
          strictEqual(r.stderr.split('\n').filter(Boolean).length, 1, r.stderr);
        }
        await approvePlan({ workflowPath: filePath, host: 'claude', env: {} });
        for (const extra of [{ EXPLICIT_SUBTASK_ID: 'A' }, {}]) {
          const r = await run(filePath, { AGENTIC_AUTOPILOT: RUN_ID, ...extra });
          strictEqual(r.status, 0, r.stderr);
          strictEqual(r.stdout, 'DISPATCH A first\n');
          strictEqual(r.stderr, '');
        }
      });
    });

    // Between the selection and the gate, the plan is rewritten and the new
    // plan approved. The gate reads an approved plan; what would be
    // dispatched is the subtask as it was selected, which nobody approved.
    it('refuses under autopilot when the plan was replaced and approved after the selection', async () => {
      await withDir(async (dir) => {
        const injector = join(dir, 'replan.mjs');
        await writeFile(injector, [
          'const [state, workflowPath] = process.argv.slice(2);',
          "const { setPlan, approvePlan } = await import(new URL(`file://${state}`).href);",
          'await setPlan({ workflowPath, host: \'claude\', verdict: \'pass\', subtasks: [',
          "  { id: 'A', verb: 'compose', profile: 'backend', branch: 'feat/a', blocked_by: [], status: 'pending', topic: 'replaced and approved' },",
          "  { id: 'B', verb: 'refine', branch: 'feat/b', blocked_by: ['A'], status: 'blocked' },",
          ']});',
          "await approvePlan({ workflowPath, host: 'claude', env: {} });",
        ].join('\n'));
        const between = `node "${injector}" "${STATE}" "$MACRO_PATH" || exit 9`;
        for (const extra of [{ EXPLICIT_SUBTASK_ID: 'A' }, {}]) {
          // Each round starts from the plan the owner approved first.
          const fresh = await macro(dir, 'approved');
          const r = await run(fresh, { AGENTIC_AUTOPILOT: RUN_ID, ...extra }, between);
          strictEqual(r.status, 1, `${JSON.stringify(extra)}: ${r.stderr}`);
          ok(r.stderr.includes('subtask A as selected is not in it'), r.stderr);
          ok(!r.stdout.includes('DISPATCH'), r.stdout);
          strictEqual(parseWorkflowFile(await readFile(fresh, 'utf8')).frontmatter.plan_approval_status, 'approved',
            'the control: the injected plan was approved before the gate read it');
          await rm(fresh);
        }
      });
    });

    // Progress is not approved: a subtask whose status and provenance moved
    // between the two reads is still the one the owner approved.
    it('dispatches under autopilot when only progress moved after the selection', async () => {
      await withDir(async (dir) => {
        const injector = join(dir, 'progress.mjs');
        await writeFile(injector, [
          'const [state, workflowPath] = process.argv.slice(2);',
          "const { updateSubtask } = await import(new URL(`file://${state}`).href);",
          "await updateSubtask({ workflowPath, subtaskId: 'A', host: 'claude', status: 'in_progress', engineerWorkflowId: 'eng-A' });",
        ].join('\n'));
        const between = `node "${injector}" "${STATE}" "$MACRO_PATH" || exit 9`;
        for (const extra of [{ EXPLICIT_SUBTASK_ID: 'A' }, {}]) {
          const fresh = await macro(dir, 'approved');
          const r = await run(fresh, { AGENTIC_AUTOPILOT: RUN_ID, ...extra }, between);
          strictEqual(r.status, 0, `${JSON.stringify(extra)}: ${r.stderr}`);
          strictEqual(r.stdout, 'DISPATCH A first\n');
          strictEqual(r.stderr, '');
          const { frontmatter } = parseWorkflowFile(await readFile(fresh, 'utf8'));
          strictEqual(frontmatter.plan.subtasks[0].status, 'in_progress', 'the control: progress moved before the gate read it');
          strictEqual(frontmatter.plan_approval_status, 'approved', 'a progress write does not revoke the approval');
          await rm(fresh);
        }
      });
    });

    it('re-attaches an in_progress subtask by explicit id under autopilot', async () => {
      await withDir(async (dir) => {
        const filePath = await macro(dir, 'approved');
        await updateSubtask({ workflowPath: filePath, subtaskId: 'A', host: 'claude', status: 'in_progress', engineerWorkflowId: 'eng-A' });
        const r = await run(filePath, { AGENTIC_AUTOPILOT: RUN_ID, EXPLICIT_SUBTASK_ID: 'A' });
        strictEqual(r.status, 0, r.stderr);
        strictEqual(r.stdout, 'DISPATCH A first\n');
        strictEqual(r.stderr, '');
      });
    });
  });
}
