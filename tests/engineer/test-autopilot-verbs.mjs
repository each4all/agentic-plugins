// plugins/engineer/scripts/state.mjs — ADR-0063 D3/D4: what the verb
// runbooks call to behave under an autopilot run.
//
// Covers:
//   - autopilot-preflight: silent in interactive mode, the rules banner under
//     autopilot, a refusal under autopilot when an owner gate is set, and the
//     owner-facing notice (with the resolving surface) in interactive mode;
//     a malformed AGENTIC_AUTOPILOT is interactive
//   - finish-verb: interactive = today's terminal write (summary-complete +
//     terminal marker + handoff sidecar) plus the next step; autopilot = the
//     next step and next action only, no marker, no sidecar
//   - set-terminal --terminal-marker true refused under autopilot; false and
//     interactive allowed
//   - awaiting-owner-set --anchor derives the pointer from the workflow path
//   - close-complete is a terminal phase
//
// Run via `node --test tests/engineer/test-autopilot-verbs.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE_PATH = resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs');

const {
  TERMINAL_PHASES,
  createWorkflow,
  readWorkflow,
  appendPhase,
  setAwaitingOwner,
  autopilotPreflight,
  finishVerb,
} = await import(STATE_PATH);

const AUTOPILOT_RUN_ID = 'autopilot-20260930T010203Z-abcdef';

// The child must not inherit an AGENTIC_AUTOPILOT from whoever runs the
// suite (an autopilot worker would), and must not find a runtime plugin to
// render a footer with: the sidecar's projection file is what is asserted.
function cliEnv(extra = {}) {
  const env = { ...process.env };
  delete env.AGENTIC_AUTOPILOT;
  return { ...env, ...extra };
}

function runCli(args, extra = {}) {
  return spawnSync('node', [STATE_PATH, ...args], { encoding: 'utf8', env: cliEnv(extra) });
}

async function withWorkflow(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'engineer-autopilot-verbs-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'feat/x'], { cwd: dir, stdio: 'ignore' });
    const { filePath } = await createWorkflow({
      repoRoot: dir, verb: 'critique', host: 'claude',
      gitBaseline: { branch: 'feat/x', head: '0'.repeat(40), status_digest: '' },
      originalRequest: 'autopilot verbs',
      currentPhase: 'phase-0-bootstrap',
    });
    await appendPhase({
      workflowPath: filePath, host: 'claude', phaseLabel: 'Phase 1: Critique (synthesized)',
      phaseNote: 'findings', currentPhase: 'phase-2-presented', nextAction: 'Refine', event: 'updated',
    });
    await fn(filePath, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const exists = (p) => access(p).then(() => true, () => false);

describe('autopilot-preflight (ADR-0063 D4)', () => {
  it('prints nothing in interactive mode, with or without a workflow', async () => {
    await withWorkflow(async (wf) => {
      for (const args of [[], ['--workflow-path', wf], ['--workflow-path', '']]) {
        const r = runCli(['autopilot-preflight', ...args]);
        strictEqual(r.status, 0, r.stderr);
        strictEqual(r.stdout, '');
        strictEqual(r.stderr, '');
      }
    });
  });

  it('a malformed or empty AGENTIC_AUTOPILOT is interactive', async () => {
    await withWorkflow(async (wf) => {
      for (const value of ['', '1', 'autopilot', 'autopilot-20260930T010203Z-ABCDEF', ` ${AUTOPILOT_RUN_ID}`]) {
        const r = runCli(['autopilot-preflight', '--workflow-path', wf], { AGENTIC_AUTOPILOT: value });
        strictEqual(r.status, 0, `${JSON.stringify(value)}: ${r.stderr}`);
        strictEqual(r.stdout, '', JSON.stringify(value));
      }
    });
  });

  it('prints the rules banner under an autopilot run', async () => {
    await withWorkflow(async (wf) => {
      const r = runCli(['autopilot-preflight', '--workflow-path', wf], { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
      strictEqual(r.status, 0, r.stderr);
      ok(r.stdout.startsWith(`Autopilot run ${AUTOPILOT_RUN_ID} (ADR-0063 D4):`), r.stdout);
      for (const rule of ['present in batch', 'recommended option', 'CRITICAL and MAJOR', 'finish-verb',
        'never run git commit, push, or open a pull request', 'record the owner gate',
        'core/skills/_shared/references/autopilot-mode.md']) {
        ok(r.stdout.includes(rule), `banner names "${rule}": ${r.stdout}`);
      }
    });
  });

  it('refuses under autopilot when an owner gate is set, writing nothing', async () => {
    await withWorkflow(async (wf) => {
      await setAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'decide-conflict', anchor: 'ensemble-synthesis' });
      const before = await readFile(wf, 'utf8');
      const r = runCli(['autopilot-preflight', '--workflow-path', wf], { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
      strictEqual(r.status, 1);
      strictEqual(r.stdout, '');
      ok(r.stderr.includes('owner gate decide-conflict is set'), r.stderr);
      ok(r.stderr.includes(`#ensemble-synthesis`), r.stderr);
      ok(r.stderr.includes('an autopilot step never resolves an owner gate'), r.stderr);
      strictEqual(await readFile(wf, 'utf8'), before);
    });
  });

  it('puts a pending gate to the owner in interactive mode, naming how it is resolved', async () => {
    await withWorkflow(async (wf) => {
      const expectations = {
        'decide-conflict': '/engineer:decide, whose Owner selection step clears the gate',
        'recurring-finding': '/engineer:refine, whose Owner decision step clears the gate',
        'staging-set': '/engineer:commit, which clears the gate and then commits',
        'pr-handling': 'the outward action (push, pull request), then clears the gate',
        'scope-routing': 'chooses the route, then clears the gate',
      };
      for (const [gate, how] of Object.entries(expectations)) {
        await setAwaitingOwner({ workflowPath: wf, host: 'claude', gate, anchor: 'here' });
        const r = runCli(['autopilot-preflight', '--workflow-path', wf]);
        strictEqual(r.status, 0, r.stderr);
        ok(r.stdout.startsWith(`Owner gate ${gate} is pending since `), r.stdout);
        ok(r.stdout.includes(`#here`), r.stdout);
        ok(r.stdout.includes(how), `${gate}: ${r.stdout}`);
        ok(r.stdout.includes(`awaiting-owner-clear --workflow-path "${wf}" --host claude --gate ${gate} --next-step-kind`), r.stdout);
        const cleared = runCli(['awaiting-owner-clear', '--workflow-path', wf, '--host', 'claude', '--gate', gate]);
        strictEqual(cleared.status, 0, cleared.stderr);
      }
    });
  });

  it('--surface commit prints the commit surface\'s own rules; a bad surface is refused', async () => {
    await withWorkflow(async (wf) => {
      let r = runCli(['autopilot-preflight', '--workflow-path', wf, '--surface', 'commit'], { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
      strictEqual(r.status, 0, r.stderr);
      ok(r.stdout.includes('the one step that commits or closes the workflow'), r.stdout);
      ok(r.stdout.includes('--mode autopilot'), r.stdout);
      ok(!r.stdout.includes('never run git commit'), 'the verb rule is not printed to the commit surface');
      r = runCli(['autopilot-preflight', '--workflow-path', wf, '--surface', 'commit']);
      strictEqual(r.stdout, '', 'interactive: nothing');
      r = runCli(['autopilot-preflight', '--workflow-path', wf, '--surface', 'push']);
      strictEqual(r.status, 1);
    });
  });

  it('names the Codex spelling of the resolving surface for --host codex', async () => {
    await withWorkflow(async (wf) => {
      await setAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'staging-set', anchor: 'phase7-plan' });
      const r = runCli(['autopilot-preflight', '--workflow-path', wf, '--host', 'codex']);
      strictEqual(r.status, 0, r.stderr);
      ok(r.stdout.includes('$engineer:commit'), r.stdout);
      ok(r.stdout.includes('--host codex --gate staging-set'), r.stdout);
    });
  });

  it('the function reports the same verdicts', async () => {
    await withWorkflow(async (wf) => {
      let v = await autopilotPreflight({ workflowPath: wf, env: {} });
      deepStrictEqual([v.mode, v.gate, v.refuse, v.stdout], ['interactive', null, false, '']);
      v = await autopilotPreflight({ workflowPath: wf, env: { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID } });
      deepStrictEqual([v.mode, v.gate, v.refuse], ['autopilot', null, false]);
      await setAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'pr-handling', anchor: 'pr-handling' });
      v = await autopilotPreflight({ workflowPath: wf, env: { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID } });
      strictEqual(v.refuse, true);
      strictEqual(v.gate.gate, 'pr-handling');
    });
  });
});

describe('finish-verb (ADR-0063 D3)', () => {
  const FINISH = (wf, ...extra) => [
    'finish-verb', '--workflow-path', wf, '--host', 'claude',
    '--next-action', 'Refine the findings', ...extra,
  ];

  it('interactive: summary-complete + terminal marker + next step, and the handoff sidecar fires', async () => {
    await withWorkflow(async (wf, dir) => {
      const r = runCli(FINISH(wf, '--next-step-kind', 'verb', '--next-step-verb', 'refine', '--next-step-confidence', 'HIGH'));
      strictEqual(r.status, 0, r.stderr);
      strictEqual(r.stdout, `${wf}\n`);
      ok(!r.stderr.includes('autopilot:'), r.stderr);
      const fm = (await readWorkflow(wf)).frontmatter;
      strictEqual(fm.current_phase, 'summary-complete');
      strictEqual(fm.terminal_marker, true);
      strictEqual(fm.next_action, 'Refine the findings');
      strictEqual(fm.next_step_kind, 'verb');
      strictEqual(fm.next_step_verb, 'refine');
      strictEqual(fm.next_step_confidence, 'HIGH');
      strictEqual(fm.host_history.at(-1).event, 'updated');
      ok(await exists(join(dir, '.agentic-plugins/state/engineer/last-session-handoff.json')),
        'the ADR-0031 sidecar wrote its projection, as set-terminal does');
    });
  });

  it('autopilot: the next step and next action only — no marker, no terminal phase, no sidecar', async () => {
    await withWorkflow(async (wf, dir) => {
      const r = runCli(
        FINISH(wf, '--next-step-kind', 'commit', '--next-step-confidence', 'HIGH'),
        { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID },
      );
      strictEqual(r.status, 0, r.stderr);
      ok(r.stderr.includes('the terminal marker is left for /engineer:commit'), r.stderr);
      const fm = (await readWorkflow(wf)).frontmatter;
      strictEqual(fm.current_phase, 'phase-2-presented');
      ok(fm.terminal_marker !== true, 'terminal_marker stays unset');
      strictEqual(fm.next_action, 'Refine the findings');
      strictEqual(fm.next_step_kind, 'commit');
      strictEqual(fm.next_step_verb, undefined);
      strictEqual(fm.next_step_confidence, 'HIGH');
      strictEqual(await exists(join(dir, '.agentic-plugins/state/engineer/last-session-handoff.json')), false,
        'the driver is the handoff: no sidecar under autopilot');
    });
  });

  it('requires the next step and keeps the verb-iff-kind=verb rule, writing nothing on refusal', async () => {
    await withWorkflow(async (wf) => {
      const before = await readFile(wf, 'utf8');
      for (const args of [
        FINISH(wf),
        FINISH(wf, '--next-step-kind', 'commit'),
        FINISH(wf, '--next-step-confidence', 'HIGH'),
        FINISH(wf, '--next-step-kind', 'verb', '--next-step-confidence', 'HIGH'),
        FINISH(wf, '--next-step-kind', 'commit', '--next-step-verb', 'refine', '--next-step-confidence', 'HIGH'),
        FINISH(wf, '--next-step-kind', 'ship', '--next-step-confidence', 'HIGH'),
        ['finish-verb', '--workflow-path', wf, '--host', 'claude', '--next-step-kind', 'done', '--next-step-confidence', 'HIGH'],
      ]) {
        for (const extra of [{}, { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID }]) {
          const r = runCli(args, extra);
          strictEqual(r.status, 1, `${args.join(' ')} ${JSON.stringify(extra)}: ${r.stderr}`);
        }
      }
      strictEqual(await readFile(wf, 'utf8'), before);
    });
  });

  it('--owner-gate: recorded with the next step in one write, in both modes, leaving the workflow open', async () => {
    await withWorkflow(async (wf) => {
      const gated = (extra) => runCli([
        'finish-verb', '--workflow-path', wf, '--host', 'claude',
        '--next-action', 'Owner: select a direction',
        '--next-step-kind', 'owner-decision', '--next-step-confidence', 'MEDIUM',
        '--owner-gate', 'decide-conflict', '--owner-gate-anchor', 'ensemble-synthesis',
      ], extra);
      for (const env of [{ AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID }, {}]) {
        // An inherited terminal marker (an earlier interactive verb) is turned off.
        runCli(['set-terminal', '--workflow-path', wf, '--host', 'claude', '--terminal-phase', 'summary-complete']);
        strictEqual((await readWorkflow(wf)).frontmatter.terminal_marker, true);
        const historyBefore = (await readWorkflow(wf)).frontmatter.host_history.length;
        const r = gated(env);
        strictEqual(r.status, 0, r.stderr);
        const fm = (await readWorkflow(wf)).frontmatter;
        strictEqual(fm.host_history.length, historyBefore + 1, 'one write');
        deepStrictEqual(
          [fm.awaiting_owner_gate, fm.awaiting_owner_pointer, fm.next_step_kind, fm.next_step_confidence, fm.terminal_marker],
          ['decide-conflict', `.agentic-plugins/state/engineer/workflows/${basename(wf)}#ensemble-synthesis`, 'owner-decision', 'MEDIUM', false],
          JSON.stringify(env),
        );
        const cleared = runCli(['awaiting-owner-clear', '--workflow-path', wf, '--host', 'claude', '--gate', 'decide-conflict']);
        strictEqual(cleared.status, 0, cleared.stderr);
      }
    });
  });

  it('autopilot turns an inherited terminal marker off, and refuses while a peer ensemble is pending', async () => {
    await withWorkflow(async (wf) => {
      runCli(['set-terminal', '--workflow-path', wf, '--host', 'claude', '--terminal-phase', 'summary-complete']);
      const pend = runCli(['ensemble-pending', '--workflow-path', wf, '--phase', 'critique', '--ensemble-type', 'review', '--run-id', 'rv-1']);
      strictEqual(pend.status, 0, pend.stderr);
      const before = await readFile(wf, 'utf8');
      const args = ['finish-verb', '--workflow-path', wf, '--host', 'claude', '--next-action', 'Refine',
        '--next-step-kind', 'verb', '--next-step-verb', 'refine', '--next-step-confidence', 'HIGH'];
      let r = runCli(args, { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
      strictEqual(r.status, 1);
      ok(r.stderr.includes('a peer ensemble is still pending (rv-1)'), r.stderr);
      strictEqual(await readFile(wf, 'utf8'), before);
      runCli(['ensemble-commit', '--workflow-path', wf, '--host', 'claude', '--phase', 'critique', '--ensemble-type', 'review', '--run-id', 'rv-1', '--verdict', 'agree', '--summary', 's']);
      r = runCli(args, { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
      strictEqual(r.status, 0, r.stderr);
      const fm = (await readWorkflow(wf)).frontmatter;
      deepStrictEqual([fm.terminal_marker, fm.next_step_kind, fm.next_step_verb], [false, 'verb', 'refine']);
    });
  });

  it('--owner-gate needs the owner-decision kind, its anchor, a valid gate, and no other gate set', async () => {
    await withWorkflow(async (wf) => {
      const base = ['finish-verb', '--workflow-path', wf, '--host', 'claude', '--next-action', 'x'];
      const before = await readFile(wf, 'utf8');
      for (const extra of [
        ['--next-step-kind', 'commit', '--next-step-confidence', 'HIGH', '--owner-gate', 'decide-conflict', '--owner-gate-anchor', 'a'],
        ['--next-step-kind', 'owner-decision', '--next-step-confidence', 'HIGH', '--owner-gate', 'decide-conflict'],
        ['--next-step-kind', 'owner-decision', '--next-step-confidence', 'HIGH', '--owner-gate-anchor', 'a'],
        ['--next-step-kind', 'owner-decision', '--next-step-confidence', 'HIGH', '--owner-gate', 'plan-approval', '--owner-gate-anchor', 'a'],
        ['--next-step-kind', 'owner-decision', '--next-step-confidence', 'HIGH', '--owner-gate', 'decide-conflict', '--owner-gate-anchor', 'bad anchor'],
      ]) {
        for (const env of [{}, { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID }]) {
          const r = runCli([...base, ...extra], env);
          strictEqual(r.status, 1, `${extra.join(' ')} ${JSON.stringify(env)}: ${r.stderr}`);
        }
      }
      strictEqual(await readFile(wf, 'utf8'), before);
      await setAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'pr-handling', anchor: 'pr-handling' });
      const gatedBefore = await readFile(wf, 'utf8');
      const r = runCli([...base, '--next-step-kind', 'owner-decision', '--next-step-confidence', 'HIGH',
        '--owner-gate', 'decide-conflict', '--owner-gate-anchor', 'ensemble-synthesis'], { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
      strictEqual(r.status, 1);
      ok(r.stderr.includes('owner gate pr-handling is already set'), r.stderr);
      strictEqual(await readFile(wf, 'utf8'), gatedBefore, 'the next step is not written either');
    });
  });

  it('the function refuses a missing next step', async () => {
    await withWorkflow(async (wf) => {
      await finishVerb({ workflowPath: wf, host: 'claude', nextAction: 'x', env: {} }).then(
        () => ok(false, 'should refuse'),
        (err) => ok(/next step/.test(err.message), err.message),
      );
    });
  });
});

describe('beginCommit and awaiting-owner-clear with a next step (ADR-0063)', () => {
  it('beginCommit leaves the workflow at phase-7-commit with no terminal marker', async () => {
    const { beginCommit } = await import(STATE_PATH);
    await withWorkflow(async (wf) => {
      runCli(['set-terminal', '--workflow-path', wf, '--host', 'claude', '--terminal-phase', 'summary-complete']);
      await beginCommit({ workflowPath: wf, host: 'claude' });
      const fm = (await readWorkflow(wf)).frontmatter;
      deepStrictEqual([fm.current_phase, fm.terminal_marker, fm.host_history.at(-1).event], ['phase-7-commit', false, 'updated']);
    });
  });

  it('awaiting-owner-clear writes the owner\'s next step with the clear, so owner-decision does not linger', async () => {
    await withWorkflow(async (wf) => {
      runCli(['finish-verb', '--workflow-path', wf, '--host', 'claude', '--next-action', 'Owner: route',
        '--next-step-kind', 'owner-decision', '--next-step-confidence', 'HIGH',
        '--owner-gate', 'scope-routing', '--owner-gate-anchor', 'routing-recommendation'], { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
      const bad = runCli(['awaiting-owner-clear', '--workflow-path', wf, '--host', 'claude', '--gate', 'scope-routing', '--next-step-kind', 'verb', '--next-step-confidence', 'HIGH']);
      strictEqual(bad.status, 1, 'kind verb without the verb is refused');
      strictEqual((await readWorkflow(wf)).frontmatter.awaiting_owner_gate, 'scope-routing', 'nothing written');
      const r = runCli(['awaiting-owner-clear', '--workflow-path', wf, '--host', 'claude', '--gate', 'scope-routing',
        '--next-step-kind', 'verb', '--next-step-verb', 'frame', '--next-step-confidence', 'HIGH']);
      strictEqual(r.status, 0, r.stderr);
      const { frontmatter: fm, body } = await readWorkflow(wf);
      deepStrictEqual([fm.awaiting_owner_gate, fm.next_step_kind, fm.next_step_verb, fm.next_step_confidence], [undefined, 'verb', 'frame', 'HIGH']);
      ok(body.includes('### Owner gate resolved: scope-routing at '), body);
    });
  });

  it('--resolution puts the owner\'s decision in the same write as the clear and the next step (round-3 F1)', async () => {
    await withWorkflow(async (wf) => {
      runCli(['awaiting-owner-set', '--workflow-path', wf, '--host', 'claude', '--gate', 'pr-handling', '--anchor', 'pr-handling']);
      const before = await readFile(wf, 'utf8');
      const empty = runCli(['awaiting-owner-clear', '--workflow-path', wf, '--host', 'claude', '--gate', 'pr-handling', '--resolution', '  ']);
      strictEqual(empty.status, 1, 'an empty resolution is refused');
      strictEqual(await readFile(wf, 'utf8'), before);
      const history = (await readWorkflow(wf)).frontmatter.host_history.length;
      const r = runCli(['awaiting-owner-clear', '--workflow-path', wf, '--host', 'claude', '--gate', 'pr-handling',
        '--resolution', 'Owner pushed the branch and opened the pull request.', '--next-step-kind', 'done', '--next-step-confidence', 'HIGH']);
      strictEqual(r.status, 0, r.stderr);
      const { frontmatter: fm, body } = await readWorkflow(wf);
      strictEqual(fm.host_history.length, history + 1, 'one write');
      deepStrictEqual([fm.awaiting_owner_gate, fm.next_step_kind], [undefined, 'done']);
      ok(/### Owner gate resolved: pr-handling at [^\n]+\n\nOwner pushed the branch and opened the pull request\.\n\nCleared awaiting_owner/.test(body), body);
    });
  });
});

describe('an owner gate is never recorded on a terminal workflow (round-2 #1)', () => {
  it('awaiting-owner-set turns an inherited terminal marker off in the same write', async () => {
    await withWorkflow(async (wf) => {
      runCli(['set-terminal', '--workflow-path', wf, '--host', 'claude', '--terminal-phase', 'summary-complete']);
      strictEqual((await readWorkflow(wf)).frontmatter.terminal_marker, true);
      const r = runCli(['awaiting-owner-set', '--workflow-path', wf, '--host', 'claude', '--gate', 'pr-handling', '--anchor', 'pr-handling']);
      strictEqual(r.status, 0, r.stderr);
      const fm = (await readWorkflow(wf)).frontmatter;
      deepStrictEqual([fm.awaiting_owner_gate, fm.terminal_marker], ['pr-handling', false]);
    });
  });

  it('the no-changes close\'s handoff names the close, not a commit, while its archive is pending (round-2 #8)', async () => {
    const { mapCompletionFlags } = await import(resolve(REPO_ROOT, 'plugins/engineer/scripts/session-handoff.mjs'));
    const closing = mapCompletionFlags({ archive_gate: 'blocked', phase: 'close-complete', next_action: 'x' }, ['head_moved']);
    ok(closing.completionNextAction.includes('Finish the no-changes close: run /engineer:commit'), closing.completionNextAction);
    ok(!closing.completionNextAction.includes('Commit the completed work'), closing.completionNextAction);
    const other = mapCompletionFlags({ archive_gate: 'blocked', phase: 'summary-complete', next_action: 'x' }, ['head_moved']);
    ok(other.completionNextAction.includes('Commit the completed work'), 'every other phase keeps the commit advice');
  });
});

describe('set-terminal under autopilot (ADR-0063 D3)', () => {
  it('refuses --terminal-marker true, writing nothing; false and interactive are allowed', async () => {
    await withWorkflow(async (wf) => {
      const before = await readFile(wf, 'utf8');
      const base = ['set-terminal', '--workflow-path', wf, '--host', 'claude', '--terminal-phase', 'summary-complete'];
      let r = runCli(base, { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
      strictEqual(r.status, 1);
      ok(r.stderr.includes('refused under autopilot'), r.stderr);
      r = runCli([...base, '--terminal-marker', 'true'], { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
      strictEqual(r.status, 1);
      strictEqual(await readFile(wf, 'utf8'), before);

      r = runCli([...base, '--terminal-marker', 'false'], { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await readWorkflow(wf)).frontmatter.terminal_marker, false);

      r = runCli(base);
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await readWorkflow(wf)).frontmatter.terminal_marker, true);
    });
  });
});

describe('awaiting-owner-set --anchor (ADR-0063)', () => {
  it('derives <workflow path relative to the repo>#<anchor>', async () => {
    await withWorkflow(async (wf) => {
      const r = runCli(['awaiting-owner-set', '--workflow-path', wf, '--host', 'claude', '--gate', 'staging-set', '--anchor', 'phase7-plan']);
      strictEqual(r.status, 0, r.stderr);
      strictEqual(
        (await readWorkflow(wf)).frontmatter.awaiting_owner_pointer,
        `.agentic-plugins/state/engineer/workflows/${basename(wf)}#phase7-plan`,
      );
    });
  });

  it('refuses both, neither, a bad anchor, and a workflow outside a state home', async () => {
    await withWorkflow(async (wf, dir) => {
      const before = await readFile(wf, 'utf8');
      const base = ['awaiting-owner-set', '--workflow-path', wf, '--host', 'claude', '--gate', 'staging-set'];
      for (const extra of [
        ['--anchor', 'a', '--pointer', 'x.md#a'],
        [],
        ['--anchor', 'has space'],
        ['--anchor', '../up'],
        ['--anchor', ''],
      ]) {
        const r = runCli([...base, ...extra]);
        strictEqual(r.status === 0, false, `${extra.join(' ')} must be refused`);
      }
      strictEqual(await readFile(wf, 'utf8'), before);
      await setAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'pr-handling', anchor: 'ok' }).then(() => {});
      await setAwaitingOwner({
        workflowPath: join(dir, 'elsewhere.md'), host: 'claude', gate: 'pr-handling', anchor: 'ok',
      }).then(
        () => ok(false, 'should refuse'),
        (err) => ok(/not under an engineer state home/.test(err.message), err.message),
      );
    });
  });
});

describe('close-complete (ADR-0063 no-changes close)', () => {
  it('is a terminal phase alongside the ADR-0017 three', () => {
    for (const p of ['commit-complete', 'summary-complete', 'fix-complete', 'close-complete']) {
      ok(TERMINAL_PHASES.has(p), p);
    }
    strictEqual(TERMINAL_PHASES.size, 4);
  });
});
