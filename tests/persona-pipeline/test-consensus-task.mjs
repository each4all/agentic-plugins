// scripts/state.mjs — ADR-0067 Decision 8: the consensus task file of a
// conflict gate, for every persona the pipeline generates state.mjs into (the
// conflict gates need no capability).
//
// Covers:
//   - consensus-task: written to <home>/consensus/<workflow id>.<run id>.md
//     only for a run ensemble_results records with the verdict conflict;
//     refused for an unrecorded run, another verdict, a run id outside the
//     alphabet (a `.` would let a live name equal a retired one), empty text;
//     it prints the bounded round it proposes, with the absolute path
//   - the gate's run id: recorded by finish-verb --owner-gate-run-id and
//     awaiting-owner-set --run-id on a conflict gate only; serialized last;
//     deleted by a gate set without one; a re-set naming another run, or
//     none, and a clear retire the replaced run's file as <…>.resolved.md
//   - consensus-proposal: current only with the gate, the run id, the
//     recorded conflict and the file; the interactive preflight shows it
//   - a run id left behind by a pre-CP script (its carrier keeps the key
//     while it clears the gate) still reads, and is never current
//   - ensemble-verdict prints the recorded verdict, empty for none
//   - a writer whose lock was reclaimed neither publishes nor retires a task
//     file; the consensus directory is private
//   - inside a /<persona>:start lifecycle, the consensus-task and
//     awaiting-owner-set commands the phase-boundary rule names run as written
//     (the contested items from a file, the gate with its run id)
//
// Run via `node --test tests/persona-pipeline/test-consensus-task.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual, rejects } from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { personasFor, personaInfo } from './_personas.mjs';

for (const persona of personasFor('scripts/state.mjs')) {
  const P = personaInfo(persona);
  const STATE_PATH = P.path('scripts/state.mjs');
  const {
    createWorkflow,
    readWorkflow,
    appendPhase,
    commitEnsemble,
    setAwaitingOwner,
    clearAwaitingOwner,
    finishVerb,
    writeConsensusTask,
    writeConsensusTaskUnderLock,
    retireConsensusTask,
    consensusProposal,
    autopilotPreflight,
    VALID_WORKFLOW_OWNER_GATES,
    CONFLICT_OWNER_GATES,
  } = await import(pathToFileURL(STATE_PATH).href);

  // The suite may run inside an autopilot worker (docket C88); nothing here is
  // one, so no AGENTIC_* variable of the worker reaches a child.
  const cliEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_')));
  const runCli = (args) => spawnSync(process.execPath, [STATE_PATH, ...args], { encoding: 'utf8', env: cliEnv() });

  async function withWorkflow(fn, { verb = 'critique' } = {}) {
    // The temporary directory's own path may hold characters outside the
    // safe set; the command must quote it then.
    const dir = await mkdtemp(join(tmpdir(), `${persona}-consensus task-`));
    try {
      execFileSync('git', ['init', '-q', '-b', 'feat/x'], { cwd: dir, stdio: 'ignore' });
      const { filePath, frontmatter } = await createWorkflow({
        repoRoot: dir, verb, host: 'claude',
        gitBaseline: { branch: 'feat/x', head: '0'.repeat(40), status_digest: '' },
        originalRequest: 'consensus task',
        currentPhase: 'phase-0-bootstrap',
      });
      await fn({ dir, wf: filePath, id: frontmatter.workflow_id });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const settle = (wf, runId, verdict) => commitEnsemble({
    workflowPath: wf, run_id: runId, phase: 'critique', ensemble_type: 'review', verdict, summary: 's',
  });
  const taskFile = (dir, id, runId, suffix = '') => join(dir, P.stateDirRel, 'consensus', `${id}.${runId}${suffix}.md`);
  const gate = (name, runId) => ({ gate: name, anchor: 'ensemble-synthesis', ...(runId === undefined ? {} : { runId }) });
  const ownerDecision = { kind: 'owner-decision', confidence: 'HIGH' };

  describe(`${persona}: consensus task file (ADR-0067 Decision 8)`, () => {
    it('the conflict gates are decide-conflict and peer-conflict, and every persona reads and sets peer-conflict', () => {
      deepStrictEqual([...CONFLICT_OWNER_GATES], ['decide-conflict', 'peer-conflict']);
      ok(VALID_WORKFLOW_OWNER_GATES.has('peer-conflict'));
    });

    it('consensus-task writes the contested items for a recorded conflict, and prints the bounded round with the absolute path', () => withWorkflow(async ({ dir, wf, id }) => {
      await settle(wf, 'review-1', 'conflict');
      const r = runCli(['consensus-task', '--workflow-path', wf, '--run-id', 'review-1', '--text', 'C1: A or B?\n']);
      strictEqual(r.status, 0, r.stderr);
      const file = taskFile(dir, id, 'review-1');
      strictEqual(await readFile(file, 'utf8'), 'C1: A or B?\n');
      // The directory name holds a space: the path is quoted as one word.
      strictEqual(r.stdout, `/runtime:consensus plan --task-file '${file}' --peers claude,codex --max-rounds 2\n`);
      const codex = await writeConsensusTask({ workflowPath: wf, runId: 'review-1', text: 'C1', host: 'codex' });
      ok(codex.command.startsWith('$runtime:consensus plan --task-file '), codex.command);
      strictEqual(codex.pointer, `${P.stateDirRel}/consensus/${id}.review-1.md`);
    }));

    it('consensus-task refuses an unrecorded run, another verdict, an unsafe run id and empty text, writing nothing', () => withWorkflow(async ({ dir, wf }) => {
      await settle(wf, 'review-1', 'concerns');
      await settle(wf, 'review-2', 'failed');
      for (const [args, why] of [
        [['--run-id', 'review-9', '--text', 'x'], /run review-9 has no ensemble result/],
        [['--run-id', 'review-1', '--text', 'x'], /recorded with verdict "concerns", not conflict/],
        [['--run-id', 'review-2', '--text', 'x'], /recorded with verdict "failed", not conflict/],
        [['--run-id', 'r.resolved', '--text', 'x'], /is not a run id/],
        [['--run-id', '../x', '--text', 'x'], /is not a run id/],
        [['--run-id', 'review-1', '--text', '  \n'], /the contested items are empty/],
      ]) {
        const r = runCli(['consensus-task', '--workflow-path', wf, ...args]);
        strictEqual(r.status, 1, `${args.join(' ')}: ${r.stderr}`);
        ok(why.test(r.stderr), r.stderr);
      }
      ok(!existsSync(join(dir, P.stateDirRel, 'consensus')), 'no task file was written');
    }));

    it('finish-verb records a conflict gate with its run id, serialized last; the proposal is current', () => withWorkflow(async ({ dir, wf, id }) => {
      await settle(wf, 'review-1', 'conflict');
      await writeConsensusTask({ workflowPath: wf, runId: 'review-1', text: 'C1' });
      const r = runCli(['finish-verb', '--workflow-path', wf, '--host', 'claude', '--next-action', 'Owner decision',
        '--next-step-kind', 'owner-decision', '--next-step-confidence', 'HIGH',
        '--owner-gate', 'peer-conflict', '--owner-gate-anchor', 'ensemble-synthesis', '--owner-gate-run-id', 'review-1']);
      strictEqual(r.status, 0, r.stderr);
      const { frontmatter } = await readWorkflow(wf);
      deepStrictEqual([frontmatter.awaiting_owner_gate, frontmatter.awaiting_owner_run_id, frontmatter.terminal_marker ?? false], ['peer-conflict', 'review-1', false]);
      const text = await readFile(wf, 'utf8');
      const keys = text.split('\n---\n')[0].split('\n').filter((l) => /^[a-z_]+:/.test(l)).map((l) => l.split(':')[0]);
      strictEqual(keys.at(-1), 'awaiting_owner_run_id', 'the run id is the last key, where an older carrier re-emits it in place');
      const p = await consensusProposal({ workflowPath: wf });
      deepStrictEqual([p.current, p.gate, p.run_id, p.task_file, p.pointer],
        [true, 'peer-conflict', 'review-1', taskFile(dir, id, 'review-1'), `${P.stateDirRel}/consensus/${id}.review-1.md`]);
      const cli = JSON.parse(runCli(['consensus-proposal', '--workflow-path', wf]).stdout);
      strictEqual(cli.command, p.command);
      ok(p.command.includes(' --peers claude,codex --max-rounds 2'), p.command);
    }));

    it('only a conflict gate records a run id; --owner-gate-run-id needs --owner-gate', () => withWorkflow(async ({ wf }) => {
      await rejects(finishVerb({ workflowPath: wf, host: 'claude', nextAction: 'x', nextStep: ownerDecision, ownerGate: { gate: 'scope-routing', anchor: 'routing-recommendation', runId: 'review-1' } }),
        /only a conflict gate \(decide-conflict, peer-conflict\) records the run id/);
      await rejects(setAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'decide-conflict', anchor: 'ensemble-synthesis', runId: 'a.b' }),
        /awaiting_owner_run_id must be a run id/);
      const r = runCli(['finish-verb', '--workflow-path', wf, '--host', 'claude', '--next-action', 'x',
        '--next-step-kind', 'owner-decision', '--next-step-confidence', 'HIGH', '--owner-gate-run-id', 'review-1']);
      strictEqual(r.status, 1);
      ok(/--owner-gate-run-id goes with --owner-gate/.test(r.stderr), r.stderr);
      strictEqual((await readWorkflow(wf)).frontmatter.awaiting_owner_gate, undefined, 'nothing was set');
    }));

    it('a proposal is current only with the gate, its run id, the recorded conflict and the file', () => withWorkflow(async ({ dir, wf, id }) => {
      const reason = async () => (await consensusProposal({ workflowPath: wf })).reason;
      ok(/no owner gate is set/.test(await reason()));
      await settle(wf, 'review-1', 'conflict');
      await setAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'peer-conflict', anchor: 'ensemble-synthesis' });
      ok(/records no run id/.test(await reason()), 'a gate without a run id');
      await setAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'peer-conflict', anchor: 'ensemble-synthesis', runId: 'review-1' });
      ok(/does not exist/.test(await reason()), 'no file yet');
      await writeConsensusTask({ workflowPath: wf, runId: 'review-1', text: 'C1' });
      strictEqual((await consensusProposal({ workflowPath: wf })).current, true);
      await settle(wf, 'review-2', 'concerns');
      await setAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'peer-conflict', anchor: 'ensemble-synthesis', runId: 'review-2' });
      ok(/recorded with verdict concerns/.test(await reason()), 'a run recorded with another verdict');
      ok(!existsSync(taskFile(dir, id, 'review-1')), 'the re-set to another run retired the first file');
      ok(existsSync(taskFile(dir, id, 'review-1', '.resolved')), 'kept as evidence');
      await setAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'peer-conflict', anchor: 'ensemble-synthesis', runId: 'review-3' });
      ok(/run review-3 has no ensemble result/.test(await reason()), 'a run with no result');
      await clearAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'peer-conflict', resolution: 'ruled', env: cliEnv() });
      ok(/no owner gate is set/.test(await reason()));
    }));

    it('a gate set again without a run id deletes it and retires its file; the clear retires the file and records the run', () => withWorkflow(async ({ dir, wf, id }) => {
      await settle(wf, 'decide-1', 'conflict');
      await writeConsensusTask({ workflowPath: wf, runId: 'decide-1', text: 'D1' });
      await setAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'decide-conflict', anchor: 'ensemble-synthesis', runId: 'decide-1' });
      // An owner selection or a veto re-sets decide-conflict with no run id.
      const reset = await setAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'decide-conflict', anchor: 'ensemble-synthesis' });
      strictEqual(reset.frontmatter.awaiting_owner_run_id, undefined);
      strictEqual(reset.retired.retired, taskFile(dir, id, 'decide-1', '.resolved'));
      ok(!existsSync(taskFile(dir, id, 'decide-1')));
      // A second conflict, then the owner's clear.
      await settle(wf, 'decide-2', 'conflict');
      await writeConsensusTask({ workflowPath: wf, runId: 'decide-2', text: 'D2' });
      await setAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'decide-conflict', anchor: 'ensemble-synthesis', runId: 'decide-2' });
      const cleared = await clearAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'decide-conflict', resolution: 'Owner selection: B', env: cliEnv() });
      strictEqual(cleared.frontmatter.awaiting_owner_run_id, undefined, 'the run id goes with the gate');
      strictEqual(cleared.retired.retired, taskFile(dir, id, 'decide-2', '.resolved'));
      deepStrictEqual((await readdir(join(dir, P.stateDirRel, 'consensus'))).sort(), [`${id}.decide-1.resolved.md`, `${id}.decide-2.resolved.md`]);
      ok((await readFile(wf, 'utf8')).includes(', run decide-2).'), 'the resolved note names the run');
    }));

    it('a run id a pre-CP script left without its gate still reads, is never current, and goes with the next gate write', () => withWorkflow(async ({ dir, wf, id }) => {
      await settle(wf, 'review-1', 'conflict');
      await writeConsensusTask({ workflowPath: wf, runId: 'review-1', text: 'C1' });
      // What an older script's carrier leaves after it clears the gate: the
      // run id, at the tail, with no gate.
      const text = await readFile(wf, 'utf8');
      const [head, ...rest] = text.split('\n---\n');
      await writeFile(wf, [`${head}\nawaiting_owner_run_id: "review-1"`, ...rest].join('\n---\n'));
      const { frontmatter } = await readWorkflow(wf);
      strictEqual(frontmatter.awaiting_owner_run_id, 'review-1', 'the file reads');
      strictEqual((await consensusProposal({ workflowPath: wf })).current, false);
      await appendPhase({ workflowPath: wf, host: 'claude', nextStep: ownerDecision, ownerGate: gate('scope-routing'), event: 'updated' });
      const after = await readWorkflow(wf);
      deepStrictEqual([after.frontmatter.awaiting_owner_gate, after.frontmatter.awaiting_owner_run_id], ['scope-routing', undefined]);
      ok(existsSync(taskFile(dir, id, 'review-1', '.resolved')), 'its file is retired with it');
    }));

    it('the interactive preflight puts the proposed round to the owner only while it is current', () => withWorkflow(async ({ wf }) => {
      await settle(wf, 'review-1', 'conflict');
      await setAwaitingOwner({ workflowPath: wf, host: 'claude', gate: 'peer-conflict', anchor: 'ensemble-synthesis', runId: 'review-1' });
      const env = cliEnv();
      const before = await autopilotPreflight({ workflowPath: wf, host: 'claude', env });
      ok(!before.stdout.includes('runtime:consensus'), 'no file, no proposal');
      const { command } = await writeConsensusTask({ workflowPath: wf, runId: 'review-1', text: 'C1' });
      const after = await autopilotPreflight({ workflowPath: wf, host: 'claude', env });
      ok(after.stdout.includes(`Proposed first, for the owner to run: a bounded consensus round on the contested items, ${command}\n`), after.stdout);
      ok(/the owner rules on the contested items/.test(after.stdout), 'the peer-conflict resolution is named');
    }));

    it('ensemble-verdict prints the verdict recorded for a run, an empty line for none', () => withWorkflow(async ({ wf }) => {
      await settle(wf, 'review-1', 'conflict');
      deepStrictEqual(
        [['review-1'], ['review-9'], ['']].map(([id]) => runCli(['ensemble-verdict', '--workflow-path', wf, '--run-id', id]).stdout),
        ['conflict\n', '\n', '\n'],
      );
    }));

    it('a writer whose lock was reclaimed neither publishes nor retires a task file; the consensus directory is private', () => withWorkflow(async ({ dir, wf, id }) => {
      await settle(wf, 'review-1', 'conflict');
      const consensusDir = join(dir, P.stateDirRel, 'consensus');
      // Another writer reclaimed the workflow's lock as stale while this one held it.
      const lockPath = `${wf}.lock`;
      const lost = { lockPath, token: 'this-writer' };
      await writeFile(lockPath, 'the-new-owner');
      await rejects(writeConsensusTaskUnderLock({ workflowPath: wf, runId: 'review-1', text: 'C1' }, lost), /ownership mismatch/);
      deepStrictEqual(await readdir(consensusDir), [], 'nothing published, and no temporary file left');
      strictEqual((await stat(consensusDir)).mode & 0o777, 0o700);
      await rm(lockPath);
      await writeConsensusTask({ workflowPath: wf, runId: 'review-1', text: 'C1' });
      await writeFile(lockPath, 'the-new-owner');
      const r = await retireConsensusTask(wf, id, 'review-1', lost);
      strictEqual(r.retired, null);
      ok(/another writer reclaimed the lock on the workflow/.test(r.warning), r.warning);
      ok(existsSync(taskFile(dir, id, 'review-1')), 'the new owner\'s file stays where it is');
      await rm(lockPath);
    }));

    it('inside a start lifecycle, the consensus-task and awaiting-owner-set commands the phase-boundary rule names run as written', () => withWorkflow(async ({ dir, wf, id }) => {
      // The rule as /<persona>:start renders it (persona-pipeline/regions/
      // start-phase-boundary.md), its code spans with their placeholders filled.
      const start = (await readFile(P.path('commands/start.md'), 'utf8')).replace(/\s+/g, ' ');
      const span = (re) => { const m = re.exec(start); ok(m, `${re} in start.md`); return m[1]; };
      const taskCommand = span(/`state\.mjs (consensus-task [^`]*)`/);
      const gateFlags = span(/`(--anchor ensemble-synthesis --run-id <that run id>)`/);
      ok(taskCommand.includes(' --host "${AGENTIC_HOST:-claude}" '), `the round is named for the host the lifecycle runs on: ${taskCommand}`);
      await settle(wf, 'review-1', 'conflict');
      // The contested items, written to a file: a leading `--`, a delimiter-like
      // line and a command substitution are all text.
      const items = join(dir, 'items.md');
      const contested = '-- C1: keep "A" or $(touch pwned)\nCONTESTED_ITEMS\n';
      await writeFile(items, contested);
      const fill = (command) => command.replaceAll('<that run id>', 'review-1').replaceAll('<that file>', `'${items}'`);
      const sh = (command) => spawnSync('bash', ['-c', `node "$STATE" ${command}`], {
        cwd: dir, encoding: 'utf8', env: { ...cliEnv(), STATE: STATE_PATH, ACTIVE: wf },
      });
      const task = sh(fill(taskCommand));
      strictEqual(task.status, 0, task.stderr);
      strictEqual(await readFile(taskFile(dir, id, 'review-1'), 'utf8'), contested);
      ok(!existsSync(join(dir, 'pwned')));
      ok(task.stdout.startsWith('/runtime:consensus plan --task-file '), task.stdout);
      const set = sh(fill(`awaiting-owner-set --workflow-path "$ACTIVE" --host claude --gate peer-conflict ${gateFlags}`));
      strictEqual(set.status, 0, set.stderr);
      const { frontmatter } = await readWorkflow(wf);
      deepStrictEqual([frontmatter.awaiting_owner_gate, frontmatter.awaiting_owner_run_id], ['peer-conflict', 'review-1']);
      strictEqual((await consensusProposal({ workflowPath: wf })).current, true);
      // --run-id on a gate that is not a conflict gate is refused, writing nothing.
      const refused = sh(fill(`awaiting-owner-set --workflow-path "$ACTIVE" --host claude --gate scope-routing --anchor routing-recommendation --run-id review-1`));
      strictEqual(refused.status, 1);
      ok(/only a conflict gate \(decide-conflict, peer-conflict\) records the run id/.test(refused.stderr), refused.stderr);
      strictEqual((await readWorkflow(wf)).frontmatter.awaiting_owner_gate, 'peer-conflict');
    }));
  });
}
