// tests/orchestrator/test-approve-runbook.mjs
//
// ADR-0063 D6 — /orchestrator:approve, run as written: the bash block in
// commands/approve.md, against real macro files. It resolves the macro, prints
// the table and hash it approves, and approves exactly that hash. The
// /orchestrator:plan Phase 2 blocks (the plan-set write with its verdict, then
// the note and ensemble commit) run the same way, and so do the lane-advice
// lines both print (ADR-0067 Decision 8, item 2). So do plan's bootstrap and
// Plan-verify dispatch blocks where they take text: every value the agent
// writes — the request, the decision, the architecture, the phase note, the
// summary — reaches state.mjs from a file in the text directory, as written,
// and nothing in it runs (ADR-0059, amendment of 2026-10-10).
//
// The static contracts, and each branch and refusal once, in bash. The happy
// path of each runbook path (approve; plan's text blocks through Phase 2;
// plan's Plan-verify dispatch; the Codex skill's Step 6) runs in every shell the runbooks may run in, in the
// large tier: test-approve-runbook-e2e.mjs. The shared runner is
// _approve-runbook-fixture.mjs.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual, notStrictEqual } from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  ORCH_ROOT, ENG_ROOT, AUTOPILOT_RUN_ID,
  createWorkflow, setPlan, setAwaitingOwner, clearAwaitingOwner, recordPendingEnsemble, setMacroTerminal, readWorkflow,
  approveBlock, withRepo, plannedMacro, conflictGate, run, dispatchedChild,
  planPhase2Blocks, planTextBlocks, withTextDir, withVerdicts, failingRoot, consensusTask, NOTE_HEADING, notesIn,
  writeTexts, SUBTASKS_JSON, blockEnv, withTextRepo,
  runFinalize as runFinalizeIn, runCodexCommit as runCodexCommitIn, sideBySideMacro, CUTOVER_LINE,
} from './_approve-runbook-fixture.mjs';

// The branches and refusals run once, in bash; the describe titles keep the
// shell, as the mutation specs' killing tests name them.
const shell = 'bash';

describe('/orchestrator:approve binds the approval to the hash it showed', () => {
  it('passes the shown plan_hash as --expect-hash', async () => {
    const block = await approveBlock();
    // Contract: the agent running /orchestrator:approve — the hash it approves must be
    // the one it showed; a second plan-hash read or no --expect-hash approves a plan
    // that changed in between (no single-process run can show that race).
    ok(block.includes('SHOWN="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" plan-hash --workflow-path "$MACRO_PATH")"'), 'the block reads plan-hash once');
    ok(/PLAN_HASH="\$\(printf '%s\\n' "\$SHOWN" \| node -e '[^']*JSON\.parse\(d\)\.plan_hash/.test(block), 'PLAN_HASH comes from what was shown');
    ok(block.includes('--expect-hash "$PLAN_HASH"'), 'plan-approve is bound to it');
  });

  it('passes the shown rebind_digest as --expect-rebind (ADR-0068 Decision 8, item 2)', async () => {
    const block = await approveBlock();
    ok(/REBIND_DIGEST="\$\(printf '%s\\n' "\$SHOWN" \| node -e '[^']*JSON\.parse\(d\)\.rebind_digest/.test(block), 'REBIND_DIGEST comes from what was shown');
    ok(block.includes('--expect-rebind "$REBIND_DIGEST"'), 'plan-approve is bound to it');
  });
});

{
  describe(`/orchestrator:approve runbook (${shell})`, () => {
    it('shows the in-progress children it rebinds and tells, approves exactly that view, and tells the child (ADR-0068 Decision 8)', async () => {
      await withRepo(async (dir) => {
        const filePath = await plannedMacro(dir);
        const child = await dispatchedChild(dir, filePath);
        let r = await run(shell, dir);
        strictEqual(r.status, 0, r.stderr);
        ok(r.stdout.includes('in-progress children: nothing to rebind or tell'), r.stdout);
        const { frontmatter } = await readWorkflow(filePath);
        await setPlan({ workflowPath: filePath, host: 'claude', subtasks: frontmatter.plan.subtasks.map((x) => (x.id === 'A' ? { ...x, topic: 'the owner | revised it' } : x)) });
        r = await run(shell, dir, { AGENTIC_ENGINEER_ROOT: ENG_ROOT });
        strictEqual(r.status, 0, r.stderr);
        ok(r.stdout.includes('| subtask | child | state | next step | rebinding | note to the child |'), r.stdout);
        ok(r.stdout.includes(`| A | ${child.id} | active | none recorded (phase phase-0-bootstrap) | rebound on topic | told the change of topic |`), r.stdout);
        ok(/\nrebind_digest: [0-9a-f]{64}\n/.test(r.stdout), r.stdout);
        const envelope = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('{"workflowPath"')));
        strictEqual(envelope.rebindings, 1);
        deepStrictEqual(envelope.deliveries.map((d) => d.status), ['delivered']);
        ok((await readFile(child.path, 'utf8')).includes('the owner | revised it'));
      });
    });

    it('shows an archived child last told other words refused, though it matches its dispatch (ADR-0068 Decision 8, item 2)', async () => {
      await withRepo(async (dir) => {
        const filePath = await plannedMacro(dir);
        const child = await dispatchedChild(dir, filePath);
        const { frontmatter } = await readWorkflow(filePath);
        const revise = (topic) => setPlan({ workflowPath: filePath, host: 'claude', subtasks: frontmatter.plan.subtasks.map((x) => (x.id === 'A' ? { ...x, topic } : x)) });
        await revise('the owner revised it');
        let r = await run(shell, dir, { AGENTIC_ENGINEER_ROOT: ENG_ROOT });
        strictEqual(r.status, 0, r.stderr);
        // The child committed and archived, told the revised words; the plan
        // revised back to the words it was dispatched for.
        const archived = child.path.replace('/workflows/', '/archive/');
        await mkdir(join(archived, '..'), { recursive: true });
        await writeFile(archived, await readFile(child.path, 'utf8'));
        await rm(child.path);
        await revise('the objective | with a pipe');
        r = await run(shell, dir, { AGENTIC_ENGINEER_ROOT: ENG_ROOT });
        strictEqual(r.status, 0, r.stderr);
        const row = r.stdout.split('\n').find((l) => l.startsWith(`| A | ${child.id} | archived |`));
        ok(row?.includes(`| matches its dispatch; refused at every write that binds it: ${child.id} was last told other words for subtask A`), r.stdout);
      });
    });

    it('escapes backslashes and every line break in a cell', async () => {
      await withRepo(async (dir) => {
        const { filePath } = await createWorkflow({
          repoRoot: dir, verb: 'plan', host: 'claude',
          gitBaseline: { branch: 'main', head: '0'.repeat(40), status_digest: '' },
          originalRequest: 'escaping fixture',
        });
        await setPlan({
          workflowPath: filePath, host: 'claude',
          subtasks: [{ id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending', topic: 'cr\rcrlf\r\nlf\nback\\slash' }],
        });
        const r = await run(shell, dir);
        strictEqual(r.status, 0, r.stderr);
        ok(r.stdout.includes('| A |  | compose |  | feat/a |  | cr\\ncrlf\\nlf\\nback\\\\slash |'), JSON.stringify(r.stdout));
        ok(!/\r/.test(r.stdout), 'no carriage return reaches the table');
      });
    });

    it('is refused while plan-conflict is set, and under an autopilot run, writing nothing', async () => {
      await withRepo(async (dir) => {
        const filePath = await plannedMacro(dir);
        await setAwaitingOwner({
          workflowPath: filePath, host: 'claude', gate: 'plan-conflict',
          pointer: `.agentic-plugins/state/orchestrator/workflows/${basename(filePath)}#ensemble-synthesis`,
        });
        const before = await readFile(filePath, 'utf8');
        let r = await run(shell, dir);
        strictEqual(r.status, 1);
        ok(r.stderr.includes('Plan-verify ensemble reported a conflict'), r.stderr);
        ok(r.stdout.includes('approval before: pending (awaiting_owner_gate=plan-conflict)'), r.stdout);
        r = await run(shell, dir, { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
        strictEqual(r.status, 1);
        ok(r.stderr.includes('refused under autopilot'), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before);
      });
    });

    it('finds the macro from a subtask branch, and by --workflow', async () => {
      await withRepo(async (dir) => {
        const filePath = await plannedMacro(dir);
        execFileSync('git', ['-C', dir, 'switch', '-q', '-c', 'feat/a']);
        let r = await run(shell, dir);
        strictEqual(r.status, 0, r.stderr);
        strictEqual((await readWorkflow(filePath)).frontmatter.plan_approval_status, 'approved');

        execFileSync('git', ['-C', dir, 'switch', '-q', '-c', 'unrelated']);
        r = await run(shell, dir);
        strictEqual(r.status, 1);
        ok(r.stderr.includes("No macro workflow on branch 'unrelated'"), r.stderr);
        r = await run(shell, dir, {}, `--workflow=${basename(filePath, '.md')}`);
        strictEqual(r.status, 0, r.stderr);
        ok(r.stdout.includes('"noop":true'), r.stdout);
        r = await run(shell, dir, {}, '--workflow=../archive/x');
        strictEqual(r.status, 1);
        ok(r.stderr.includes('must be a basename-shaped workflow id'), r.stderr);
        deepStrictEqual(r.stdout, '');
      });
    });
  });
}

describe('/orchestrator:plan sets the gate in the plan write', () => {
  it('no later block sets a gate', async () => {
    const { finalize } = await planPhase2Blocks();
    // Contract: the agent running /orchestrator:plan — a separate gate write leaves the
    // plan approvable between the two writes.
    ok(!finalize.includes('awaiting-owner-set'), 'the gate is not set in a separate write');
  });
});

{
  describe(`/orchestrator:plan plan-set block (${shell})`, () => {
    // The agent writes the subtasks, the decision and the architecture to the
    // text directory before the block; so does this.
    // The block finds the macro on the branch itself, and reads the run id the
    // dispatch wrote.
    const runPlanSet = async (dir, textDir, active, extra = {}) => {
      await writeTexts(textDir, { 'subtasks.json': SUBTASKS_JSON, 'decision.txt': 'Decide A\n', 'architecture.txt': 'One lane\n', 'run-id': 'macro-plan-20260930T000000Z-abcdef', 'run-macro': active, 'macro-path': active });
      const { planSet } = await planPhase2Blocks();
      return spawnSync(shell, ['-c', withVerdicts(withTextDir(planSet, textDir), extra)], { cwd: dir, encoding: 'utf8', env: blockEnv({ VERDICT: 'pass from the environment' }) });
    };
    const newMacro = async (dir) => (await createWorkflow({
      repoRoot: dir, verb: 'plan', host: 'claude',
      gitBaseline: { branch: 'main', head: '0'.repeat(40), status_digest: '' },
      originalRequest: 'plan-set block fixture',
    })).filePath;

    it('a conflict verdict writes the plan at plan-conflict; another verdict at plan-approval', async () => {
      await withTextRepo(async (dir, textDir) => {
        const filePath = await newMacro(dir);
        let r = await runPlanSet(dir, textDir, filePath, { VERDICT: 'conflict' });
        strictEqual(r.status, 0, r.stderr);
        let fm = (await readWorkflow(filePath)).frontmatter;
        strictEqual(fm.plan.subtasks[0].id, 'A');
        strictEqual(fm.awaiting_owner_gate, 'plan-conflict');
        strictEqual(fm.awaiting_owner_pointer, `.agentic-plugins/state/orchestrator/workflows/${basename(filePath)}#ensemble-synthesis`);
        r = await runPlanSet(dir, textDir, filePath, { VERDICT: 'concerns' });
        strictEqual(r.status, 0, r.stderr);
        fm = (await readWorkflow(filePath)).frontmatter;
        strictEqual(fm.awaiting_owner_gate, 'plan-approval');
      });
    });

    it('refuses to write the plan when no verdict was set', async () => {
      await withTextRepo(async (dir, textDir) => {
        const filePath = await newMacro(dir);
        const before = await readFile(filePath, 'utf8');
        const r = await runPlanSet(dir, textDir, filePath);
        notStrictEqual(r.status, 0);
        ok(r.stderr.includes('verdict must be one of pass, concerns, conflict'), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before);
      });
    });
  });

  describe(`/orchestrator:plan note + ensemble block (${shell})`, () => {
    const runFinalize = (...a) => runFinalizeIn(shell, ...a);

    it('an empty run id stops the block before either write (C132)', async () => {
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const before = await readFile(filePath, 'utf8');
        const r = await runFinalize(dir, textDir, filePath, { RUN_ID: '' });
        notStrictEqual(r.status, 0);
        ok(r.stderr.includes('/run-id is empty; nothing was written.'), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before, 'nothing was written');
      });
    });

    it('a terminal macro stops the block before any write', async () => {
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        await setMacroTerminal({ workflowPath: filePath, host: 'claude', terminalPhase: 'aborted' });
        const before = await readFile(filePath, 'utf8');
        const r = await runFinalize(dir, textDir, filePath);
        notStrictEqual(r.status, 0);
        ok(r.stderr.includes('terminal macro is not revised') && r.stderr.trimEnd().endsWith('nothing was written.'), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before, 'nothing was written');
      });
    });

    it('a missing note or summary file stops the block before either write', async () => {
      // Contract: the agent running /orchestrator:plan — a note recorded whose
      // ensemble result then cannot be committed leaves the run pending under a
      // phase that says it was synthesized. Every file the reader refuses
      // stops the block, not only a missing one: a newline alone is empty to it
      // (Review finding), and so are a NUL byte and text that is not UTF-8.
      const note = 'The note\n';
      const summary = 'The summary\n';
      for (const [flag, files, why] of [
        ['--summary-file', { 'note.md': note }, /cannot read .*ENOENT/],
        ['--phase-note-file', { 'summary.txt': summary }, /cannot read .*ENOENT/],
        ['--summary-file', { 'note.md': note, 'summary.txt': '\n' }, /is empty/],
        ['--phase-note-file', { 'note.md': 'a\0b\n', 'summary.txt': summary }, /holds a NUL byte/],
        ['--summary-file', { 'note.md': note, 'summary.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]) }, /is not valid UTF-8/],
      ]) {
        await withTextRepo(async (dir, textDir) => {
          const filePath = await plannedMacro(dir);
          const before = await readFile(filePath, 'utf8');
          const r = await runFinalize(dir, textDir, filePath, {}, files);
          strictEqual(r.status, 1, r.stderr);
          const line = r.stderr.trimEnd().split('\n').at(-1);
          ok(line.startsWith(`✗ ${flag}: `) && why.test(line) && line.endsWith('nothing was written.'), r.stderr);
          strictEqual(await readFile(filePath, 'utf8'), before, `${flag} ${why}: nothing was written`);
        });
      }
    });

    // C132 — every input is checked before any write: the verdicts, the run
    // id the dispatch wrote, and on a conflict the contested items.
    it('a verdict, run id or contested file it cannot use stops the block before any write (C132)', async () => {
      const files = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n' };
      for (const [what, extra, more, why] of [
        ['the VERDICT line left as written', { VERDICT: null }, {}, /VERDICT is "<pass\|concerns\|conflict>", not pass, concerns or conflict/],
        ['an unknown ENSEMBLE_VERDICT', { ENSEMBLE_VERDICT: 'skipped' }, {}, /ENSEMBLE_VERDICT is "skipped"/],
        ['a failed run with a conflict', { VERDICT: 'conflict', ENSEMBLE_VERDICT: 'failed' }, { 'contested.md': 'C1\n' }, /gave no peer positions to conflict with/],
        ['no run id written', { RUN_ID: null }, {}, /writes the run id to .*\/run-id/],
        ['a run id the dispatch could not have used', { RUN_ID: 'macro/plan' }, {}, /run-id holds "macro\/plan", not a run id the macro can record/],
        ['a run id holding ..', { RUN_ID: 'macro-plan..x' }, {}, /not a run id the macro can record/],
        ['a run id a command would read as an option', { RUN_ID: '--probe' }, {}, /run-id holds "--probe", not a run id the macro can record/],
        ['a conflict whose run id the gate cannot record', { VERDICT: 'conflict', RUN_ID: 'macro-plan.bad' }, { 'contested.md': 'C1\n' }, /run-id holds "macro-plan\.bad", not a run id the macro can record/],
        ['a run id ending in a carriage return', { RUN_ID: 'macro-plan-20260930T000000Z-abcdef\r' }, {}, /not a run id/],
        ['a conflict with no contested.md', { VERDICT: 'conflict' }, {}, /contested\.md is missing or blank/],
        ['a conflict with a blank contested.md', { VERDICT: 'conflict' }, { 'contested.md': ' \n\t\n' }, /contested\.md is missing or blank/],
      ]) {
        await withTextRepo(async (dir, textDir) => {
          const filePath = await plannedMacro(dir);
          const before = await readFile(filePath, 'utf8');
          const r = await runFinalize(dir, textDir, filePath, extra, { ...files, ...more });
          strictEqual(r.status, 1, `${what}: ${r.stderr}`);
          ok(why.test(r.stderr) && r.stderr.trimEnd().endsWith('nothing was written.'), `${what}: ${r.stderr}`);
          strictEqual(await readFile(filePath, 'utf8'), before, `${what}: nothing was written`);
        });
      }
    });

    // C132 — a failure injected at each write in turn (before it, and after
    // it was made), then the block run again as it is: the note, keyed by the
    // run, and the ensemble result are each recorded once, and the task file
    // is there. With the owner's clear of the gate between the two runs, the
    // rerun still records the note and the result once, and proposes no
    // round: the macro records the clear (plan_conflict_cleared_run_id).
    it('a rerun after a failure at any write records the note and the result once and writes the task file; after the owner clears the gate, it proposes no round (C132)', async () => {
      const RUN_ID = 'macro-plan-20260930T000000Z-abcdef';
      for (const clear of [false, true]) {
        for (const [step, after] of ['append', 'ensemble-commit', 'consensus-task'].flatMap((s) => [[s, ''], [s, '1']])) {
          const what = `${step}${after ? ' (after)' : ''}${clear ? ', cleared between the runs' : ''}`;
          await withTextRepo(async (dir, textDir) => {
            const filePath = await plannedMacro(dir);
            await conflictGate(filePath, RUN_ID);
            const files = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n', 'contested.md': 'C1: split A or not\n' };
            const failing = await failingRoot(dir);
            const first = await runFinalize(dir, textDir, filePath, { VERDICT: 'conflict', AGENTIC_ORCHESTRATOR_ROOT: failing, FAIL_STEP: step, FAIL_AFTER: after }, files);
            strictEqual(first.status, 1, `${what}: ${first.stderr}`);
            ok(first.stderr.includes(`✗ injected failure: ${step}`), first.stderr);
            if (clear) await clearAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-conflict', env: blockEnv({}) });
            const again = await runFinalize(dir, textDir, filePath, { VERDICT: 'conflict' }, files);
            strictEqual(again.status, 0, `${what}: ${again.stderr}`);
            const { frontmatter, body } = await readWorkflow(filePath);
            strictEqual(notesIn(body), 1, `${what}: the note once`);
            strictEqual(frontmatter.phase_note_run_ids, RUN_ID, `${what}: the run's note is recorded`);
            deepStrictEqual(frontmatter.ensemble_results.filter((e) => e.run_id === RUN_ID).map((e) => e.verdict), ['conflict'], `${what}: the result once`);
            if (clear) {
              ok(again.stderr.includes(`The owner has cleared the plan-conflict gate of run ${RUN_ID}`) && !again.stderr.includes('runtime:consensus'), `${what}: ${again.stderr}`);
              ok(!existsSync(consensusTask(dir, filePath, RUN_ID)), `${what}: no round for a decided conflict`);
            } else {
              strictEqual(await readFile(consensusTask(dir, filePath, RUN_ID), 'utf8'), 'C1: split A or not\n', `${what}: the task file`);
            }
          });
        }
      }
    });

    // Critique F1 — a re-plan (or a second session) finalizing a new run
    // records its note and result after the first run's.
    it('a later run records its own note and result after an earlier run\'s', async () => {
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const first = 'macro-plan-20260930T000000Z-aaaaaa';
        const second = 'macro-plan-20260930T000000Z-bbbbbb';
        for (const [runId, note] of [[first, 'The first note\n'], [second, 'The second note\n']]) {
          const r = await runFinalize(dir, textDir, filePath, { VERDICT: 'concerns', RUN_ID: runId }, { 'note.md': note, 'summary.txt': 'The summary\n' });
          strictEqual(r.status, 0, r.stderr);
        }
        const { frontmatter, body } = await readWorkflow(filePath);
        ok(body.includes(`${NOTE_HEADING}\n\nThe first note\n`) && body.includes(`${NOTE_HEADING}\n\nThe second note\n`), body);
        ok(body.indexOf('The first note') < body.indexOf('The second note'), 'the second after the first');
        deepStrictEqual(frontmatter.ensemble_results.map((e) => e.run_id), [first, second]);
      });
    });

    // Refine-verify N1 — a rerun after a failed ensemble commit, on a macro
    // made terminal since, is refused by the macro read before any write.
    it('a rerun refuses a macro made terminal since, recording no result', async () => {
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const failing = await failingRoot(dir);
        const first = await runFinalize(dir, textDir, filePath, { VERDICT: 'concerns', AGENTIC_ORCHESTRATOR_ROOT: failing, FAIL_STEP: 'ensemble-commit' });
        strictEqual(first.status, 1, first.stderr);
        await setMacroTerminal({ workflowPath: filePath, host: 'claude', terminalPhase: 'aborted' });
        const before = await readFile(filePath, 'utf8');
        const again = await runFinalize(dir, textDir, filePath, { VERDICT: 'concerns' });
        strictEqual(again.status, 1, again.stderr);
        ok(again.stderr.includes('a terminal macro is not revised'), again.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before, 'no ensemble result was written');
      });
    });

    // Critique F2 — the blocks write to the macro Phase 0 wrote to
    // macro-path; a branch switched since names another macro, which they
    // never find (docket C75: reload, never re-derive).
    it('the plan-set and note blocks write to the macro Phase 0 found, not the one a branch switched since names', async () => {
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        execFileSync('git', ['-C', dir, 'switch', '-q', '-c', 'feat/other']);
        const { filePath: other } = await createWorkflow({
          repoRoot: dir, verb: 'plan', host: 'claude',
          gitBaseline: { branch: 'feat/other', head: '0'.repeat(40), status_digest: '' },
          originalRequest: 'the macro the switched branch names',
        });
        const otherBefore = await readFile(other, 'utf8');
        const { planSet } = await planPhase2Blocks();
        await writeTexts(textDir, { 'macro-path': filePath, 'subtasks.json': SUBTASKS_JSON, 'decision.txt': 'Decide A\n', 'architecture.txt': 'One lane\n' });
        let r = spawnSync(shell, ['-c', withVerdicts(withTextDir(planSet, textDir), { VERDICT: 'concerns' })], { cwd: dir, encoding: 'utf8', env: blockEnv({ ACTIVE: other }) });
        strictEqual(r.status, 0, r.stderr);
        r = await runFinalize(dir, textDir, filePath, { VERDICT: 'concerns', ACTIVE: other });
        strictEqual(r.status, 0, r.stderr);
        const fm = (await readWorkflow(filePath)).frontmatter;
        deepStrictEqual([fm.plan.decision, fm.ensemble_results.at(-1).verdict], ['Decide A', 'concerns']);
        strictEqual(await readFile(other, 'utf8'), otherBefore, 'the macro the branch names now is untouched');
      });
    });

    it('a missing macro-path, or one naming no file, stops the block before any write', async () => {
      for (const [what, active, why] of [
        ['no macro-path', null, /writes the macro's path to .*\/macro-path: run it first; nothing was written\./],
        ['a macro-path naming no file', 'gone.md', /\/macro-path names no macro file \(".*gone\.md"\); nothing was written\./],
      ]) {
        await withTextRepo(async (dir, textDir) => {
          const filePath = await plannedMacro(dir);
          const before = await readFile(filePath, 'utf8');
          const r = await runFinalize(dir, textDir, active === null ? null : join(dir, active), { VERDICT: 'concerns' });
          strictEqual(r.status, 1, `${what}: ${r.stderr}`);
          ok(why.test(r.stderr), `${what}: ${r.stderr}`);
          strictEqual(await readFile(filePath, 'utf8'), before, `${what}: nothing was written`);
        });
      }
    });

    // C132 (Critique F5 before it) — the note is keyed by the run, so every
    // verdict takes the form the macro's records of a run take, the gate's
    // and the task file's: an id with an extended ISO time, which no
    // peer-runner new-run-id allocates, is refused before any write whatever
    // the verdict.
    it('a run id with colons and dots is refused before any write, whatever the verdict (C132)', async () => {
      const runId = 'macro-plan-2026-10-10T00:00:00.000Z-abc';
      for (const [VERDICT, ENSEMBLE_VERDICT] of [['pass', undefined], ['concerns', undefined], ['concerns', 'failed'], ['conflict', undefined]]) {
        await withTextRepo(async (dir, textDir) => {
          const filePath = await plannedMacro(dir);
          const before = await readFile(filePath, 'utf8');
          const r = await runFinalize(dir, textDir, filePath, { VERDICT, ENSEMBLE_VERDICT, RUN_ID: runId }, { 'note.md': 'The note\n', 'summary.txt': 'The summary\n', 'contested.md': 'C1\n' });
          strictEqual(r.status, 1, `${VERDICT}/${ENSEMBLE_VERDICT}: ${r.stderr}`);
          ok(/not a run id the macro can record \(letters, digits, _ and -, opening with a letter or digit\); nothing was written\./.test(r.stderr), r.stderr);
          strictEqual(await readFile(filePath, 'utf8'), before);
        });
      }
    });

    // Critique G2 — the verdict is held to the gate plan-set recorded for the
    // run, and to a result already recorded for it, before any write: a wrong
    // VERDICT line is refused and fixed, never recorded for good.
    it('a verdict the gate plan-set recorded, or the run\'s recorded result, contradicts stops the block before any write', async () => {
      const RUN_ID = 'macro-plan-20260930T000000Z-abcdef';
      const files = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n', 'contested.md': 'C1\n' };
      for (const [what, gateRun, extra, why] of [
        ['a pass over the run\'s plan-conflict gate', RUN_ID, { VERDICT: 'pass' }, /plan-set recorded the plan-conflict gate for run macro-plan-20260930T000000Z-abcdef, but VERDICT is pass/],
        ['a failed run over the run\'s plan-conflict gate', RUN_ID, { VERDICT: 'concerns', ENSEMBLE_VERDICT: 'failed' }, /but VERDICT is concerns/],
      ]) {
        await withTextRepo(async (dir, textDir) => {
          const filePath = await plannedMacro(dir);
          if (gateRun) await conflictGate(filePath, gateRun);
          const before = await readFile(filePath, 'utf8');
          const r = await runFinalize(dir, textDir, filePath, { RUN_ID, ...extra }, files);
          strictEqual(r.status, 1, `${what}: ${r.stderr}`);
          ok(why.test(r.stderr) && r.stderr.trimEnd().endsWith('nothing was written.'), `${what}: ${r.stderr}`);
          strictEqual(await readFile(filePath, 'utf8'), before, `${what}: nothing was written`);
        });
      }
      // The macro read is checked apart from the parser (C110): a read that
      // prints the macro's JSON and then fails stops the block too.
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const before = await readFile(filePath, 'utf8');
        const r = await runFinalize(dir, textDir, filePath, { VERDICT: 'pass', RUN_ID, AGENTIC_ORCHESTRATOR_ROOT: await failingRoot(dir), FAIL_STEP: 'read', FAIL_AFTER: '1' }, files);
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes(`✗ Could not read ${filePath}; nothing was written.`), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before, 'nothing was written');
      });
      // The stuck state the check prevents: plan-set with conflict, then a
      // finalize with pass. Refused, then fixed to conflict: the note once, the
      // result conflict, the task file.
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        await conflictGate(filePath, RUN_ID);
        let r = await runFinalize(dir, textDir, filePath, { VERDICT: 'pass', RUN_ID }, files);
        strictEqual(r.status, 1, r.stderr);
        r = await runFinalize(dir, textDir, filePath, { VERDICT: 'conflict', RUN_ID }, files);
        strictEqual(r.status, 0, r.stderr);
        const { frontmatter, body } = await readWorkflow(filePath);
        strictEqual(notesIn(body), 1);
        deepStrictEqual(frontmatter.ensemble_results.map((e) => [e.run_id, e.verdict]), [[RUN_ID, 'conflict']]);
        ok(existsSync(consensusTask(dir, filePath, RUN_ID)), 'the task file');
      });
      // A recorded result keeps its verdict: a rerun with another is refused
      // by the result ensemble_results holds for the run, with the same one it
      // goes through (and records the note again).
      for (const [first, second] of [[{ VERDICT: 'pass' }, { VERDICT: 'concerns' }], [{ VERDICT: 'concerns', ENSEMBLE_VERDICT: 'failed' }, { VERDICT: 'concerns' }]]) {
        await withTextRepo(async (dir, textDir) => {
          const filePath = await plannedMacro(dir);
          let r = await runFinalize(dir, textDir, filePath, { RUN_ID, ...first }, files);
          strictEqual(r.status, 0, r.stderr);
          const before = await readFile(filePath, 'utf8');
          const recorded = first.ENSEMBLE_VERDICT ?? first.VERDICT;
          r = await runFinalize(dir, textDir, filePath, { RUN_ID, ...second }, files);
          strictEqual(r.status, 1, r.stderr);
          ok(r.stderr.includes(`the ensemble result of run ${RUN_ID} is already recorded with the verdict ${recorded}, not ${second.VERDICT}`) && r.stderr.trimEnd().endsWith('nothing was written.'), r.stderr);
          strictEqual(await readFile(filePath, 'utf8'), before, 'nothing was written');
          r = await runFinalize(dir, textDir, filePath, { RUN_ID, ...first }, files);
          strictEqual(r.status, 0, r.stderr);
          deepStrictEqual((await readWorkflow(filePath)).frontmatter.ensemble_results.map((e) => [e.run_id, e.verdict]), [[RUN_ID, recorded]]);
        });
      }
    });

    // The round is proposed only while the plan-conflict gate names the run.
    // A finalize that stopped before its result (or before its note), rerun
    // after the owner cleared the gate, records the conflict's result and
    // its note once, and proposes no round: the macro records the clear
    // (plan_conflict_cleared_run_id), which the block reads, never a note's
    // text (C132). That record also says the run's verdict is conflict, so
    // another verdict is refused for it; and a conflict for a run plan-set
    // gated with no conflict at all is refused before any write.
    it('a conflict rerun after the owner cleared the run\'s gate records its result and proposes no round; the record holds the verdict (C132)', async () => {
      const RUN_ID = 'macro-plan-20260930T000000Z-abcdef';
      const files = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n', 'contested.md': 'C1\n' };
      for (const [step, notes] of [['ensemble-commit', 1], ['append', 1]]) {
        await withTextRepo(async (dir, textDir) => {
          const filePath = await plannedMacro(dir);
          await conflictGate(filePath, RUN_ID);
          // The pending entry the dispatch recorded, which the rerun's commit pops.
          await recordPendingEnsemble({ workflowPath: filePath, phase: 'plan', ensemble_type: 'plan-verify', run_id: RUN_ID });
          let r = await runFinalize(dir, textDir, filePath, { VERDICT: 'conflict', RUN_ID, AGENTIC_ORCHESTRATOR_ROOT: await failingRoot(dir), FAIL_STEP: step }, files);
          strictEqual(r.status, 1, `${step}: ${r.stderr}`);
          await clearAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-conflict', env: blockEnv({}) });
          r = await runFinalize(dir, textDir, filePath, { VERDICT: 'conflict', RUN_ID }, files);
          strictEqual(r.status, 0, `${step}: ${r.stderr}`);
          ok(r.stderr.includes(`The owner has cleared the plan-conflict gate of run ${RUN_ID} (plan_conflict_cleared_run_id)`) && !r.stderr.includes('runtime:consensus'), `${step}: ${r.stderr}`);
          const { frontmatter, body } = await readWorkflow(filePath);
          strictEqual(notesIn(body), notes, `${step}: the note once`);
          deepStrictEqual(frontmatter.ensemble_results.map((e) => [e.run_id, e.verdict]), [[RUN_ID, 'conflict']], step);
          deepStrictEqual(frontmatter.pending_ensemble ?? [], [], `${step}: the pending entry is popped`);
          ok(!existsSync(consensusTask(dir, filePath, RUN_ID)), `${step}: no round for a decided conflict`);
        });
      }
      // The clear says the run's verdict is conflict: another is refused.
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        await conflictGate(filePath, RUN_ID);
        await clearAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-conflict', env: blockEnv({}) });
        const before = await readFile(filePath, 'utf8');
        const r = await runFinalize(dir, textDir, filePath, { VERDICT: 'pass', RUN_ID }, files);
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes(`the owner cleared the plan-conflict gate plan-set recorded for run ${RUN_ID}, but VERDICT is pass`) && r.stderr.trimEnd().endsWith('nothing was written.'), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before, 'nothing was written');
      });
      // A conflict for a run plan-set never gated: plan-set recorded another
      // verdict, and nothing is written.
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const before = await readFile(filePath, 'utf8');
        const r = await runFinalize(dir, textDir, filePath, { VERDICT: 'conflict', RUN_ID }, files);
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes(`no plan-conflict gate names run ${RUN_ID}, and the owner cleared none for it: plan-set recorded another verdict`) && r.stderr.trimEnd().endsWith('nothing was written.'), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before, 'nothing was written');
        ok(!existsSync(consensusTask(dir, filePath, RUN_ID)), 'no round without the gate');
      });
    });

    // Plan-verify finding (plan-verify-20261019T030746Z-4c83cd): the owner
    // clears the run's gate, then a plan-set rerun gates the same run again.
    // The clear record decides, as consensus-task's refusal does: the block
    // proposes no round and completes, run after run, rather than fail at
    // consensus-task each time (C132).
    it('a run plan-set gated again after the owner cleared it proposes no round, and completes (C132)', async () => {
      const RUN_ID = 'macro-plan-20260930T000000Z-abcdef';
      const files = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n', 'contested.md': 'C1\n' };
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        await conflictGate(filePath, RUN_ID);
        await clearAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-conflict', env: blockEnv({}) });
        await conflictGate(filePath, RUN_ID);
        const gatedAgain = (await readWorkflow(filePath)).frontmatter;
        deepStrictEqual([gatedAgain.awaiting_owner_gate, gatedAgain.awaiting_owner_run_id, gatedAgain.plan_conflict_cleared_run_id], ['plan-conflict', RUN_ID, RUN_ID], 'the control: the run is gated again, and the clear is kept');
        for (const pass of ['first', 'again']) {
          const r = await runFinalize(dir, textDir, filePath, { VERDICT: 'conflict', RUN_ID }, files);
          strictEqual(r.status, 0, `${pass}: ${r.stderr}`);
          ok(r.stderr.includes(`The owner has cleared the plan-conflict gate of run ${RUN_ID}`), `${pass}: ${r.stderr}`);
        }
        const { frontmatter, body } = await readWorkflow(filePath);
        strictEqual(notesIn(body), 1, 'the note once');
        deepStrictEqual(frontmatter.ensemble_results.map((e) => [e.run_id, e.verdict]), [[RUN_ID, 'conflict']]);
        ok(!existsSync(consensusTask(dir, filePath, RUN_ID)), 'no round for a decided conflict');
      });
    });

    // Critique H2 — a run id is recorded only for the macro its dispatch was
    // for: the plan-set and note blocks refuse a run-macro naming another
    // macro, or none; the dispatch empties run-id before its checks, so one
    // that stops at a check leaves no run id of an earlier dispatch behind.
    it('a run dispatched for another macro, or left by an earlier dispatch, is not recorded', async () => {
      const RUN_ID = 'macro-plan-20260930T000000Z-abcdef';
      const files = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n', 'contested.md': 'C1\n' };
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const otherMacro = join(dir, 'macro-a.md');
        for (const [what, RUN_MACRO, why] of [
          ['another macro', otherMacro, `✗ Run ${RUN_ID} was dispatched for ${otherMacro}, not for ${filePath}: dispatch a Plan-verify run for this macro; nothing was written.`],
          ['no run-macro', null, '/run-macro; nothing was written.'],
        ]) {
          await rm(join(textDir, 'run-macro'), { force: true });
          const before = await readFile(filePath, 'utf8');
          const r = await runFinalize(dir, textDir, filePath, { VERDICT: 'pass', RUN_ID, RUN_MACRO }, files);
          strictEqual(r.status, 1, `${what}: ${r.stderr}`);
          ok(r.stderr.includes(why), `${what}: ${r.stderr}`);
          strictEqual(await readFile(filePath, 'utf8'), before, `${what}: nothing was written`);
        }
        // plan-set with a conflict records the run's id only for its macro.
        const { planSet } = await planPhase2Blocks();
        await writeTexts(textDir, { 'subtasks.json': SUBTASKS_JSON, 'decision.txt': 'Decide A\n', 'architecture.txt': 'One lane\n', 'run-id': RUN_ID, 'run-macro': otherMacro, 'macro-path': filePath });
        const before = await readFile(filePath, 'utf8');
        const r = spawnSync(shell, ['-c', withVerdicts(withTextDir(planSet, textDir), { VERDICT: 'conflict' })], { cwd: dir, encoding: 'utf8', env: blockEnv({}) });
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes(`✗ Run ${RUN_ID} was dispatched for ${otherMacro}, not for ${filePath}`), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before, 'plan-set wrote nothing');
        // The dispatch that stops at its prompt check leaves run-id empty, and
        // the note block then refuses rather than record the earlier run.
        await writeTexts(textDir, { 'run-id': RUN_ID, 'run-macro': filePath });
        await rm(join(textDir, 'prompt.xml'), { force: true });
        const { dispatch } = await planTextBlocks();
        const d = spawnSync(shell, ['-c', withTextDir(dispatch, textDir)], { cwd: dir, encoding: 'utf8', env: blockEnv({}) });
        strictEqual(d.status, 1, d.stderr);
        strictEqual(await readFile(join(textDir, 'run-id'), 'utf8'), '', 'the earlier run id is gone');
        const f = await runFinalize(dir, textDir, filePath, { VERDICT: 'pass', RUN_ID: null, RUN_MACRO: null }, files);
        strictEqual(f.status, 1, f.stderr);
        ok(f.stderr.includes('/run-id is empty; nothing was written.'), f.stderr);
        // The control: this macro's run is recorded.
        const c = await runFinalize(dir, textDir, filePath, { VERDICT: 'pass', RUN_ID }, files);
        strictEqual(c.status, 0, c.stderr);
      });
    });
  });

  describe(`$orchestrator:plan Step 6 block, the Codex skill (${shell})`, () => {
    const runCodexCommit = (...a) => runCodexCommitIn(shell, ...a);

    // C132 on Codex: the same rerun after a failure at each write, as it is
    // and with the owner's clear of the gate between the runs.
    it('a rerun after a failure at any write records the note and the result once and writes the task file; after the owner clears the gate, it proposes no round (C132)', async () => {
      const RUN_ID = 'macro-plan-20261010T000000Z-c0de00';
      for (const clear of [false, true]) {
        for (const [step, after] of ['append', 'ensemble-commit', 'consensus-task'].flatMap((s) => [[s, ''], [s, '1']])) {
          const what = `${step}${after ? ' (after)' : ''}${clear ? ', cleared between the runs' : ''}`;
          await withTextRepo(async (dir, textDir) => {
            const filePath = await plannedMacro(dir);
            await conflictGate(filePath, RUN_ID);
            const files = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n', 'contested.md': 'C1: split A or not\n' };
            const failing = await failingRoot(dir);
            const first = await runCodexCommit(dir, textDir, filePath, files, { verdicts: { VERDICT: 'conflict' }, env: { FAIL_STEP: step, FAIL_AFTER: after }, root: failing });
            strictEqual(first.status, 1, `${what}: ${first.stderr}`);
            ok(first.stderr.includes(`✗ injected failure: ${step}`), first.stderr);
            if (clear) await clearAwaitingOwner({ workflowPath: filePath, host: 'codex', gate: 'plan-conflict', env: blockEnv({}) });
            const again = await runCodexCommit(dir, textDir, filePath, files, { verdicts: { VERDICT: 'conflict' } });
            strictEqual(again.status, 0, `${what}: ${again.stderr}`);
            const { frontmatter, body } = await readWorkflow(filePath);
            strictEqual(notesIn(body), 1, `${what}: the note once`);
            strictEqual(frontmatter.phase_note_run_ids, RUN_ID, `${what}: the run's note is recorded`);
            deepStrictEqual(frontmatter.ensemble_results.filter((e) => e.run_id === RUN_ID).map((e) => e.verdict), ['conflict'], `${what}: the result once`);
            if (clear) {
              ok(again.stderr.includes(`The owner has cleared the plan-conflict gate of run ${RUN_ID}`) && !again.stderr.includes('runtime:consensus'), `${what}: ${again.stderr}`);
              ok(!existsSync(consensusTask(dir, filePath, RUN_ID)), `${what}: no round for a decided conflict`);
            } else {
              ok(existsSync(consensusTask(dir, filePath, RUN_ID)), `${what}: the task file`);
            }
          });
        }
      }
    });

    // The same on Codex: a run Step 5 gated again after the owner cleared it.
    it('a run Step 5 gated again after the owner cleared it proposes no round, and completes (C132)', async () => {
      const RUN_ID = 'macro-plan-20261010T000000Z-c0de00';
      const files = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n', 'contested.md': 'C1\n' };
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        await conflictGate(filePath, RUN_ID);
        await clearAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'plan-conflict', env: blockEnv({}) });
        await conflictGate(filePath, RUN_ID);
        const gatedAgain = (await readWorkflow(filePath)).frontmatter;
        deepStrictEqual([gatedAgain.awaiting_owner_gate, gatedAgain.awaiting_owner_run_id, gatedAgain.plan_conflict_cleared_run_id], ['plan-conflict', RUN_ID, RUN_ID], 'the control: the run is gated again, and the clear is kept');
        for (const pass of ['first', 'again']) {
          const r = await runCodexCommit(dir, textDir, filePath, files, { verdicts: { VERDICT: 'conflict' } });
          strictEqual(r.status, 0, `${pass}: ${r.stderr}`);
          ok(r.stderr.includes(`The owner has cleared the plan-conflict gate of run ${RUN_ID}`), `${pass}: ${r.stderr}`);
        }
        const { frontmatter, body } = await readWorkflow(filePath);
        strictEqual(notesIn(body), 1, 'the note once');
        deepStrictEqual(frontmatter.ensemble_results.map((e) => [e.run_id, e.verdict]), [[RUN_ID, 'conflict']]);
        ok(!existsSync(consensusTask(dir, filePath, RUN_ID)), 'no round for a decided conflict');
      });
    });

    // The clear record holds the run's verdict on Codex, as on Claude: another
    // verdict for a cleared run is refused, and so is a conflict for a run
    // Step 5 never gated; neither writes anything (C132).
    it('the clear record holds the verdict: another verdict for a cleared run, or a conflict for a run never gated, stops the block before any write (C132)', async () => {
      const RUN_ID = 'macro-plan-20261010T000000Z-c0de00';
      const files = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n', 'contested.md': 'C1\n' };
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        await conflictGate(filePath, RUN_ID);
        await clearAwaitingOwner({ workflowPath: filePath, host: 'codex', gate: 'plan-conflict', env: blockEnv({}) });
        const before = await readFile(filePath, 'utf8');
        const r = await runCodexCommit(dir, textDir, filePath, files, { verdicts: { VERDICT: 'pass' } });
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes(`the owner cleared the plan-conflict gate plan-set recorded for run ${RUN_ID}, but VERDICT is pass`) && r.stderr.trimEnd().endsWith('nothing was written.'), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before, 'nothing was written');
      });
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const before = await readFile(filePath, 'utf8');
        const r = await runCodexCommit(dir, textDir, filePath, files, { verdicts: { VERDICT: 'conflict' } });
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes(`no plan-conflict gate names run ${RUN_ID}, and the owner cleared none for it: plan-set recorded another verdict`) && r.stderr.trimEnd().endsWith('nothing was written.'), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before, 'nothing was written');
        ok(!existsSync(consensusTask(dir, filePath, RUN_ID)), 'no round without the gate');
      });
    });

    // Critique K2 — the conflict inputs on Codex, as on Claude: the contested
    // items consensus-task reads, and a failed run, which gave no peer
    // positions to conflict with. Each is refused before the note and the
    // result are written, with the run's plan-conflict gate set as Step 5
    // sets it.
    it('a conflict with no or a blank contested.md, or a failed run with a conflict, stops the block before any write (C132)', async () => {
      const files = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n' };
      for (const [what, more, verdicts, why] of [
        ['no contested.md', {}, { VERDICT: 'conflict' }, /contested\.md is missing or blank/],
        ['a blank contested.md', { 'contested.md': ' \n\t\n' }, { VERDICT: 'conflict' }, /contested\.md is missing or blank/],
        ['a failed run with a conflict', { 'contested.md': 'C1\n' }, { VERDICT: 'conflict', ENSEMBLE_VERDICT: 'failed' }, /gave no peer positions to conflict with/],
      ]) {
        await withTextRepo(async (dir, textDir) => {
          const filePath = await plannedMacro(dir);
          await conflictGate(filePath, 'macro-plan-20261010T000000Z-c0de00');
          const before = await readFile(filePath, 'utf8');
          const r = await runCodexCommit(dir, textDir, filePath, { ...files, ...more }, { verdicts });
          strictEqual(r.status, 1, `${what}: ${r.stderr}`);
          ok(why.test(r.stderr) && r.stderr.trimEnd().endsWith('nothing was written.'), `${what}: ${r.stderr}`);
          strictEqual(await readFile(filePath, 'utf8'), before, `${what}: nothing was written`);
          ok(!existsSync(consensusTask(dir, filePath, 'macro-plan-20261010T000000Z-c0de00')), `${what}: no task file`);
        });
      }
    });

    it('a terminal macro, or one made terminal since a failed run, stops the block before any write (Refine-verify N1)', async () => {
      const files = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n' };
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const failing = await failingRoot(dir);
        const first = await runCodexCommit(dir, textDir, filePath, files, { env: { FAIL_STEP: 'ensemble-commit' }, root: failing });
        strictEqual(first.status, 1, first.stderr);
        await setMacroTerminal({ workflowPath: filePath, host: 'codex', terminalPhase: 'aborted' });
        const before = await readFile(filePath, 'utf8');
        const again = await runCodexCommit(dir, textDir, filePath, files);
        strictEqual(again.status, 1, again.stderr);
        ok(again.stderr.includes('a terminal macro is not revised') && again.stderr.trimEnd().endsWith('nothing was written.'), again.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before, 'nothing was written');
      });
    });

    it('a verdict the gate Step 5 recorded, or the run\'s recorded result, contradicts stops the block before any write (Critique G2)', async () => {
      const RUN_ID = 'macro-plan-20261010T000000Z-c0de00';
      const files = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n', 'contested.md': 'C1\n' };
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        await conflictGate(filePath, RUN_ID);
        const before = await readFile(filePath, 'utf8');
        let r = await runCodexCommit(dir, textDir, filePath, files, { verdicts: { VERDICT: 'pass' } });
        strictEqual(r.status, 1, r.stderr);
        ok(/plan-set recorded the plan-conflict gate for run macro-plan-20261010T000000Z-c0de00, but VERDICT is pass.*nothing was written\./.test(r.stderr), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before);
        r = await runCodexCommit(dir, textDir, filePath, files, { verdicts: { VERDICT: 'conflict' } });
        strictEqual(r.status, 0, r.stderr);
        deepStrictEqual((await readWorkflow(filePath)).frontmatter.ensemble_results.map((e) => e.verdict), ['conflict']);
        ok(existsSync(consensusTask(dir, filePath, RUN_ID)), 'the task file while the gate names the run');
      });
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        let r = await runCodexCommit(dir, textDir, filePath, files, { verdicts: { VERDICT: 'pass' } });
        strictEqual(r.status, 0, r.stderr);
        const before = await readFile(filePath, 'utf8');
        r = await runCodexCommit(dir, textDir, filePath, files, { verdicts: { VERDICT: 'concerns' } });
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes(`the ensemble result of run ${RUN_ID} is already recorded with the verdict pass, not concerns`) && r.stderr.trimEnd().endsWith('nothing was written.'), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before);
      });
      // A read that prints the macro's JSON and then fails (C110).
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const before = await readFile(filePath, 'utf8');
        const r = await runCodexCommit(dir, textDir, filePath, files, { verdicts: { VERDICT: 'pass' }, env: { FAIL_STEP: 'read', FAIL_AFTER: '1' }, root: await failingRoot(dir) });
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes(`✗ Could not read ${filePath}; nothing was written.`), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before, 'nothing was written');
      });
      // A rerun after the owner cleared the gate records the conflict's
      // result and proposes no round.
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        await conflictGate(filePath, RUN_ID);
        await recordPendingEnsemble({ workflowPath: filePath, phase: 'plan', ensemble_type: 'plan-verify', run_id: RUN_ID });
        let r = await runCodexCommit(dir, textDir, filePath, files, { verdicts: { VERDICT: 'conflict' }, env: { FAIL_STEP: 'ensemble-commit' }, root: await failingRoot(dir) });
        strictEqual(r.status, 1, r.stderr);
        await clearAwaitingOwner({ workflowPath: filePath, host: 'codex', gate: 'plan-conflict', env: blockEnv({}) });
        r = await runCodexCommit(dir, textDir, filePath, files, { verdicts: { VERDICT: 'conflict' } });
        strictEqual(r.status, 0, r.stderr);
        ok(r.stderr.includes(`The owner has cleared the plan-conflict gate of run ${RUN_ID} (plan_conflict_cleared_run_id)`), r.stderr);
        const { frontmatter } = await readWorkflow(filePath);
        deepStrictEqual(frontmatter.ensemble_results.map((e) => e.verdict), ['conflict']);
        deepStrictEqual(frontmatter.pending_ensemble ?? [], [], 'the pending entry is popped');
        ok(!existsSync(consensusTask(dir, filePath, RUN_ID)), 'no round for a decided conflict');
      });
      // Critique H2 on Codex — a run-macro naming another macro is refused.
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const before = await readFile(filePath, 'utf8');
        const otherMacro = join(dir, 'macro-a.md');
        const r = await runCodexCommit(dir, textDir, filePath, { ...files, 'run-macro': `${otherMacro}\n` }, { verdicts: { VERDICT: 'pass' } });
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes(`✗ Run ${RUN_ID} was dispatched for ${otherMacro}, not for ${filePath}`), r.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before, 'nothing was written');
      });
    });

    // Critique F1, F2 and F5 on Codex: a later run's note and result after the
    // first's, the macro from macro-path, and the run-id form the macro's
    // records take, whatever the verdict (C132).
    it('a later run records its own note, the macro is the one macro-path names, and a run id with colons and dots is refused', async () => {
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        execFileSync('git', ['-C', dir, 'switch', '-q', '-c', 'feat/other']);
        const { filePath: other } = await createWorkflow({
          repoRoot: dir, verb: 'plan', host: 'claude',
          gitBaseline: { branch: 'feat/other', head: '0'.repeat(40), status_digest: '' },
          originalRequest: 'the macro the switched branch names',
        });
        const otherBefore = await readFile(other, 'utf8');
        const second = 'macro-plan-20261010T000000Z-c0de01';
        for (const [runId, note] of [['macro-plan-20261010T000000Z-c0de00', 'The first note\n'], [second, 'The second note\n']]) {
          const r = await runCodexCommit(dir, textDir, filePath, { 'run-id': `${runId}\n`, 'note.md': note, 'summary.txt': 'The summary\n' });
          strictEqual(r.status, 0, r.stderr);
        }
        const { frontmatter, body } = await readWorkflow(filePath);
        strictEqual(notesIn(body), 2, 'one note per finalize');
        ok(body.includes(`${NOTE_HEADING}\n\nThe second note\n`), body);
        deepStrictEqual(frontmatter.ensemble_results.map((e) => e.run_id), ['macro-plan-20261010T000000Z-c0de00', second]);
        strictEqual(await readFile(other, 'utf8'), otherBefore, 'the macro the branch names now is untouched');
        const before = await readFile(filePath, 'utf8');
        for (const VERDICT of ['concerns', 'conflict']) {
          const r = await runCodexCommit(dir, textDir, filePath, { 'run-id': 'macro-plan-2026-10-10T00:00:00.000Z-abc\n', 'note.md': 'n\n', 'summary.txt': 's\n', 'contested.md': 'C1\n' }, { verdicts: { VERDICT } });
          strictEqual(r.status, 1, `${VERDICT}: ${r.stderr}`);
          ok(/not a run id the macro can record \(letters, digits, _ and -, opening with a letter or digit\); nothing was written\./.test(r.stderr), r.stderr);
          strictEqual(await readFile(filePath, 'utf8'), before);
        }
      });
    });

    it('a file the reader refuses stops the block before either write', async () => {
      // Contract: the Codex agent running $orchestrator:plan — the same refusal
      // as commands/plan.md Phase 2 (Critique finding): a note recorded whose
      // ensemble result then cannot be committed leaves the run pending under a
      // phase that says it was synthesized.
      const note = 'The note\n';
      const summary = 'The summary\n';
      for (const [flag, files, why] of [
        ['--summary-file', { 'note.md': note }, /cannot read .*ENOENT/],
        ['--phase-note-file', { 'summary.txt': summary }, /cannot read .*ENOENT/],
        ['--summary-file', { 'note.md': note, 'summary.txt': '\n' }, /is empty/],
        ['--phase-note-file', { 'note.md': 'a\0b\n', 'summary.txt': summary }, /holds a NUL byte/],
        ['--summary-file', { 'note.md': note, 'summary.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]) }, /is not valid UTF-8/],
      ]) {
        await withTextRepo(async (dir, textDir) => {
          const filePath = await plannedMacro(dir);
          const before = await readFile(filePath, 'utf8');
          const r = await runCodexCommit(dir, textDir, filePath, files);
          strictEqual(r.status, 1, r.stderr);
          const line = r.stderr.trimEnd().split('\n').at(-1);
          ok(line.startsWith(`✗ ${flag}: `) && why.test(line) && line.endsWith('nothing was written.'), r.stderr);
          strictEqual(await readFile(filePath, 'utf8'), before, `${flag} ${why}: nothing was written`);
        });
      }
    });
  });

  describe(`/orchestrator:plan text files (${shell}) (ADR-0059, amendment of 2026-10-10)`, () => {
    it('the dispatch block refuses a missing prompt file before it dispatches', async () => {
      await withTextRepo(async (dir, textDir) => {
        const { dispatch } = await planTextBlocks();
        await writeTexts(textDir, { 'macro-path': await plannedMacro(dir) });
        const r = spawnSync(shell, ['-c', withTextDir(dispatch, textDir)], { cwd: dir, encoding: 'utf8', env: blockEnv({}) });
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes(`✗ ${textDir}/prompt.xml is missing or empty`), r.stderr);
        deepStrictEqual((await readdir(textDir)).sort(), ['macro-path', 'run-id'], 'no run was started: no run JSON beside the prompt');
        strictEqual(await readFile(join(textDir, 'run-id'), 'utf8'), '', 'and no run id');
      });
    });

    // Critique G1 — Phase 0's first block is the one selection: it writes
    // macro-path, and the resume block reads it, so a branch switched between
    // the two resumes the macro Phase 0 found (docket C75: reload, never
    // re-derive).
    it('the resume block resumes the macro Phase 0 found, not the one a branch switched since names', async () => {
      await withTextRepo(async (dir, textDir) => {
        const { find, bootstrap, resume } = await planTextBlocks();
        const run = (block) => spawnSync(shell, ['-c', withTextDir(block, textDir)], { cwd: dir, encoding: 'utf8', env: blockEnv({}) });
        const filePath = await plannedMacro(dir);
        let r = run(find);
        strictEqual(r.status, 0, r.stderr);
        ok(r.stdout.startsWith('ACTIVE=') && realpathSync(r.stdout.slice('ACTIVE='.length).trimEnd()) === realpathSync(filePath), r.stdout);
        const pinned = await readFile(join(textDir, 'macro-path'), 'utf8');
        strictEqual(pinned, r.stdout.slice('ACTIVE='.length).trimEnd(), 'macro-path holds what the block printed');
        execFileSync('git', ['-C', dir, 'switch', '-q', '-c', 'feat/other']);
        const { filePath: other } = await createWorkflow({
          repoRoot: dir, verb: 'plan', host: 'claude',
          gitBaseline: { branch: 'feat/other', head: '0'.repeat(40), status_digest: '' },
          originalRequest: 'the macro the switched branch names',
        });
        const otherBefore = await readFile(other, 'utf8');
        // A bootstrap after Phase 0 found a macro refuses: it would make a second one.
        await writeTexts(textDir, { 'request.txt': 'A request\n' });
        r = run(bootstrap);
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes('run the resume block instead; nothing was written.'), r.stderr);
        r = run(resume);
        strictEqual(r.status, 0, r.stderr);
        const { frontmatter, body } = await readWorkflow(filePath);
        deepStrictEqual([frontmatter.current_phase, body.includes('### Phase 0: Resume macro plan')], ['phase-0-resume', true]);
        strictEqual(await readFile(other, 'utf8'), otherBefore, 'the macro the branch names now is untouched');
        strictEqual(await readFile(join(textDir, 'macro-path'), 'utf8'), pinned, 'the pin is Phase 0\'s');
      });
    });

    it('the resume block refuses an empty macro-path, and both refuse a missing one, before any write', async () => {
      await withTextRepo(async (dir, textDir) => {
        const { bootstrap, resume } = await planTextBlocks();
        const run = (block) => spawnSync(shell, ['-c', withTextDir(block, textDir)], { cwd: dir, encoding: 'utf8', env: blockEnv({}) });
        const filePath = await plannedMacro(dir);
        const before = await readFile(filePath, 'utf8');
        await writeTexts(textDir, { 'request.txt': 'A request\n' });
        for (const block of [bootstrap, resume]) {
          const r = run(block);
          strictEqual(r.status, 1, r.stderr);
          ok(/Phase 0 writes what it found to .*\/macro-path: run it first; nothing was written\./.test(r.stderr), r.stderr);
        }
        await writeTexts(textDir, { 'macro-path': '' });
        const r = run(resume);
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes('Phase 0 found no orchestrator macro on this branch; bootstrap one instead.'), r.stderr);
        // A pinned macro whose file is gone since.
        await writeTexts(textDir, { 'macro-path': join(dir, 'gone.md') });
        const gone = run(resume);
        strictEqual(gone.status, 1, gone.stderr);
        ok(/\/macro-path names no macro file \(".*gone\.md"\); nothing was written\./.test(gone.stderr), gone.stderr);
        strictEqual(await readFile(filePath, 'utf8'), before, 'nothing was written');
        deepStrictEqual((await readdir(join(dir, '.agentic-plugins/state/orchestrator/workflows'))).length, 1, 'no macro was created');
      });
    });
  });
}

{
  describe(`lane advice in the plan and approve runbooks (${shell})`, () => {
    const runLaneAdvice = async (dir, active) => {
      const env = { ...process.env, AGENTIC_ORCHESTRATOR_ROOT: ORCH_ROOT, ACTIVE: join(dir, 'not-the-macro.md'), REPO_ROOT: dir };
      delete env.CLAUDE_PLUGIN_ROOT;
      delete env.AGENTIC_AUTOPILOT;
      const textDir = join(dir, 'texts');
      await mkdir(textDir, { recursive: true });
      await writeFile(join(textDir, 'macro-path'), active);
      const { laneAdvice } = await planPhase2Blocks();
      return spawnSync(shell, ['-c', withTextDir(laneAdvice, textDir)], { cwd: dir, encoding: 'utf8', env });
    };

    it("plan's Phase 2 prints the line for side-by-side subtasks, and nothing for a chain", async () => {
      await withRepo(async (dir) => {
        let r = await runLaneAdvice(dir, await sideBySideMacro(dir));
        strictEqual(r.status, 0, r.stderr);
        strictEqual(r.stdout, `${CUTOVER_LINE}\n`);
      });
      await withRepo(async (dir) => {
        const r = await runLaneAdvice(dir, await plannedMacro(dir));
        strictEqual(r.status, 0, r.stderr);
        strictEqual(r.stdout, '');
      });
    });

    it('approve prints the line after the approval', async () => {
      await withRepo(async (dir) => {
        await sideBySideMacro(dir);
        const r = await run(shell, dir);
        strictEqual(r.status, 0, r.stderr);
        const lines = r.stdout.trimEnd().split('\n');
        ok(lines.at(-2).startsWith('workflow: '), r.stdout);
        strictEqual(lines.at(-1), CUTOVER_LINE);
      });
    });
  });
}
