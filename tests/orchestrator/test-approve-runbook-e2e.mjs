// tests/orchestrator/test-approve-runbook-e2e.mjs
//
// ADR-0063 D6 — the happy path of each runbook path test-approve-runbook.mjs
// covers, end to end through the runbook's own blocks, in every shell the
// runbooks may run in, with the real orchestrator scripts: /orchestrator:approve
// shows the table and hash and approves exactly that hash; /orchestrator:plan's
// text blocks (Phase 0's selection and bootstrap, Phase 2's plan-set, lane
// advice and finalize) record every text as written; plan's Plan-verify dispatch writes
// its run's macro and id before the runner starts (the run id allocated in
// every shell, C119); the Codex skill's Step 6 records its texts as written
// (ADR-0059, amendment of 2026-10-10).
//
// The one end-to-end run per runbook path, in the large tier
// (scripts/data/test-tiers.json). The static contracts, branches and refusals
// are in test-approve-runbook.mjs, each once, in bash. A shell that is not
// installed (zsh on the CI image) is reported as skipped, not passed.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual, notStrictEqual } from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  APPROVE_SHELLS, ORCH_ROOT, readWorkflow, computePlanHash,
  withRepo, plannedMacro, run, planPhase2Blocks, planTextBlocks, withTextDir, withVerdicts,
  NOTE_HEADING, writeTexts, SUBTASKS_JSON, hostile, blockEnv, withTextRepo, nothingRan, runCodexCommit,
} from './_approve-runbook-fixture.mjs';

for (const [shell, installed] of APPROVE_SHELLS) {
  const skip = !installed && `${shell} is not installed`;

  describe(`/orchestrator:approve runbook, end to end (${shell})`, { skip }, () => {
    it('shows the table and hash, then approves exactly that hash; again is a no-op', async () => {
      await withRepo(async (dir) => {
        const filePath = await plannedMacro(dir);
        const expected = computePlanHash((await readWorkflow(filePath)).frontmatter.plan.subtasks);
        let r = await run(shell, dir);
        strictEqual(r.status, 0, r.stderr);
        // Every field the hash covers is shown, the topic included.
        ok(r.stdout.includes('| id | label | verb | profile | branch | blocked_by | topic |'), r.stdout);
        ok(r.stdout.includes('| A | first | compose | backend | feat/a |  | the objective \\| with a pipe |'), r.stdout);
        ok(r.stdout.includes('| B |  | refine |  | feat/b | A |  |'), r.stdout);
        ok(r.stdout.includes(`plan_hash: ${expected}`), r.stdout);
        ok(r.stdout.includes('approval before: pending (awaiting_owner_gate=plan-approval)'), r.stdout);
        const envelope = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('{"workflowPath"')));
        strictEqual(envelope.plan_hash, expected);
        const fm = (await readWorkflow(filePath)).frontmatter;
        strictEqual(fm.plan_approval_status, 'approved');
        strictEqual(fm.plan_approval_plan_hash, expected);
        strictEqual(fm.awaiting_owner_gate, undefined);

        r = await run(shell, dir);
        strictEqual(r.status, 0, r.stderr);
        ok(r.stdout.includes('"noop":true'), r.stdout);
        ok(r.stdout.includes('approval before: approved'), r.stdout);
      });
    });
  });

  describe(`/orchestrator:plan text files (${shell}) (ADR-0059, amendment of 2026-10-10)`, { skip }, () => {
    it('the request, decision, architecture, note and summary are recorded as written, none of it runs, and no NOTE or SUMMARY comes from the environment', async () => {
      await withTextRepo(async (dir, textDir) => {
        const { bootstrap } = await planTextBlocks();
        const { planSet, laneAdvice, finalize } = await planPhase2Blocks();
        const texts = {
          'request.txt': `${hostile('request')}\n`,
          'subtasks.json': SUBTASKS_JSON,
          'decision.txt': `${hostile('decision')}\n`,
          // Two final newlines: the file's own is removed, the other is text.
          'architecture.txt': `${hostile('architecture')}\n\n`,
          'note.md': `${hostile('note')}\n`,
          'summary.txt': `${hostile('summary')}\r\n`,
        };
        await writeTexts(textDir, texts);
        const runBlock = (block, extra) => spawnSync(shell, ['-c', withTextDir(block, textDir)], { cwd: dir, encoding: 'utf8', env: blockEnv(extra) });

        const { find } = await planTextBlocks();
        let r = runBlock(find, {});
        strictEqual(r.status, 0, r.stderr);
        strictEqual(r.stdout, 'ACTIVE=\n', 'no macro on the branch yet');
        r = runBlock(`${bootstrap}\nprintf '%s\\n' "$ACTIVE"\n`, {});
        strictEqual(r.status, 0, r.stderr);
        const filePath = r.stdout.trim();
        // create scrubs the request to one line; nothing else changes it.
        strictEqual((await readWorkflow(filePath)).frontmatter.original_request, hostile('request').split('\n').join(' '));
        // As the dispatch writes them: the run's macro, then its id.
        await writeTexts(textDir, { 'run-macro': filePath, 'run-id': 'macro-plan-20261010T000000Z-0c1300' });
        r = runBlock(withVerdicts(planSet, { VERDICT: 'concerns' }), {});
        strictEqual(r.status, 0, r.stderr);
        // Phase 2's lane advice, which plan runs between the two writes: one
        // subtask, so no line.
        r = runBlock(laneAdvice, {});
        strictEqual(r.status, 0, r.stderr);
        strictEqual(r.stdout, '', 'no lane advice for a single subtask');
        r = runBlock(withVerdicts(finalize, { VERDICT: 'concerns' }), {});
        strictEqual(r.status, 0, r.stderr);

        const { frontmatter, body } = await readWorkflow(filePath);
        deepStrictEqual([frontmatter.plan.decision, frontmatter.plan.architecture], [hostile('decision'), `${hostile('architecture')}\n`]);
        ok(body.includes(`${NOTE_HEADING}\n\n${hostile('note')}\n\n`), body);
        strictEqual(frontmatter.ensemble_results.at(-1).summary, hostile('summary'));
        // The finalize's result and phase, which the former "records the note
        // and the ensemble result" case asserted.
        deepStrictEqual([frontmatter.ensemble_results.at(-1).verdict, frontmatter.current_phase], ['concerns', 'phase-2-presented']);
        ok(!(await readFile(filePath, 'utf8')).includes('from the environment'), 'no NOTE or SUMMARY of the environment was recorded');
        await nothingRan(dir, textDir);
      });
    });
  });

  describe(`/orchestrator:plan Plan-verify dispatch, end to end (${shell})`, { skip }, () => {
    // Critique K3 — the dispatch block as it runs, in a fresh shell, with a
    // plugin root whose peer-runner records what it was given and what the
    // text directory held when it started, then answers after a pause. The
    // block empties the run id an earlier dispatch left, writes this run's
    // macro and id before it dispatches, and runs the runner in its own
    // foreground (the host backgrounds the block, never a shell `&`), so the
    // block's exit follows the runner's answer.
    it('the dispatch block writes run-macro and run-id before the runner starts, and runs it in the foreground (C75)', async () => {
      await withTextRepo(async (dir, textDir) => {
        const text = await readFile(resolve(ORCH_ROOT, 'commands/plan.md'), 'utf8');
        const { dispatch } = await planTextBlocks();
        // Contract: the agent launching the Plan-verify peer — a shell `&`
        // detaches the runner where neither the agent nor an autopilot host
        // can wait for it, and loses the run id with its shell.
        ok(!/&\s*$/m.test(dispatch.replace(/&&/g, '')), 'no line ends in a background &');
        ok(/run_in_background/.test(text.slice(0, text.indexOf(dispatch))), 'the text before it says to use the host background task');
        const shim = join(dir, 'shim-root');
        await mkdir(join(shim, 'scripts'), { recursive: true });
        await writeFile(join(shim, 'scripts', 'peer-runner.mjs'), [
          "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
          "import { dirname, join } from 'node:path';",
          "import { spawnSync } from 'node:child_process';",
          'const args = process.argv.slice(2);',
          // R4 (C119, C26): the allocation goes to the real runner, logged.
          "if (args[0] === 'new-run-id') { appendFileSync(process.env.SHIM_ALLOC, args.join(' ') + '\\n'); process.exit(spawnSync(process.execPath, [process.env.REAL_RUNNER, ...args], { stdio: 'inherit' }).status ?? 1); }",
          "const textDir = dirname(args[args.indexOf('--prompt-file') + 1]);",
          "const held = (name) => readFileSync(join(textDir, name), 'utf8');",
          "const seen = { args, runId: held('run-id'), runMacro: held('run-macro') };",
          'await new Promise((r) => setTimeout(r, 400));',
          'writeFileSync(process.env.SHIM_LOG, JSON.stringify(seen));',
          "process.stdout.write('{\"shim\":true}\\n');",
        ].join('\n'));
        const filePath = await plannedMacro(dir);
        const shimLog = join(dir, 'shim-log.json');
        const shimAlloc = join(dir, 'shim-alloc.log');
        const env = blockEnv({ AGENTIC_ORCHESTRATOR_ROOT: shim, SHIM_LOG: shimLog, SHIM_ALLOC: shimAlloc, REAL_RUNNER: resolve(ORCH_ROOT, 'scripts/peer-runner.mjs') });
        // What an earlier dispatch, for another macro, left in the directory.
        await writeTexts(textDir, { 'macro-path': filePath, 'prompt.xml': '<prompt/>\n', 'run-id': 'macro-plan-20261009T000000Z-0ld000', 'run-macro': join(dir, 'other-macro.md') });
        const r = spawnSync(shell, ['-c', withTextDir(dispatch, textDir)], { cwd: dir, encoding: 'utf8', env });
        strictEqual(r.status, 0, r.stderr);
        ok(existsSync(shimLog), 'the runner had answered when the block exited');
        strictEqual(await readFile(shimAlloc, 'utf8'), 'new-run-id --prefix macro-plan\n', "one allocation, by the plugin's runner");
        const seen = JSON.parse(await readFile(shimLog, 'utf8'));
        const opt = (name) => seen.args[seen.args.indexOf(name) + 1];
        strictEqual(seen.args[0], 'run');
        // R4 (C119, C26): the id the runner allocated, six hex digits in every
        // shell (zsh read the arithmetic it replaces with other precedence).
        ok(/^macro-plan-\d{8}T\d{6}Z-[0-9a-f]{6}$/.test(opt('--run-id')), opt('--run-id'));
        notStrictEqual(opt('--run-id'), 'macro-plan-20261009T000000Z-0ld000', 'a new run id');
        deepStrictEqual([seen.runId, seen.runMacro], [opt('--run-id'), filePath], 'run-id and run-macro held this run before the runner started');
        strictEqual(opt('--workflow-path'), filePath);
        deepStrictEqual([await readFile(join(textDir, 'run-id'), 'utf8'), await readFile(join(textDir, 'run-macro'), 'utf8')], [opt('--run-id'), filePath]);
        strictEqual(await readFile(join(textDir, 'prompt.xml.run.json'), 'utf8'), '{"shim":true}\n', "the runner's answer");
        // An allocation that fails stops the block before the dispatch, with
        // run-id left empty for Phase 2.
        const unrun = join(dir, 'shim-log-unallocated.json');
        const refused = spawnSync(shell, ['-c', withTextDir(dispatch, textDir)], { cwd: dir, encoding: 'utf8', env: { ...env, SHIM_LOG: unrun, REAL_RUNNER: join(dir, 'no-such-runner.mjs') } });
        strictEqual(refused.status, 1, refused.stderr);
        ok(refused.stderr.includes('new-run-id allocated no run id'), refused.stderr);
        deepStrictEqual([existsSync(unrun), await readFile(join(textDir, 'run-id'), 'utf8')], [false, ''], 'no runner call, and no run id');
      });
    });
  });

  describe(`$orchestrator:plan Step 6 block, the Codex skill, end to end (${shell})`, { skip }, () => {
    it('records the note and the ensemble result as written, and none of it runs', async () => {
      await withTextRepo(async (dir, textDir) => {
        const filePath = await plannedMacro(dir);
        const r = await runCodexCommit(shell, dir, textDir, filePath, { 'note.md': `${hostile('note')}\n`, 'summary.txt': `${hostile('summary')}\n` });
        strictEqual(r.status, 0, r.stderr);
        const { frontmatter, body } = await readWorkflow(filePath);
        ok(body.includes(`${NOTE_HEADING}\n\n${hostile('note')}\n\n`), body);
        deepStrictEqual(
          [frontmatter.current_phase, frontmatter.ensemble_results.at(-1).verdict, frontmatter.ensemble_results.at(-1).summary, frontmatter.host_history.at(-1).host],
          ['phase-2-presented', 'concerns', hostile('summary'), 'codex'],
        );
        // The Codex spelling of the next commands, kept as written.
        ok(frontmatter.next_action.includes('($orchestrator:approve); then $orchestrator:next'), frontmatter.next_action);
        ok(!(await readFile(filePath, 'utf8')).includes('from the environment'), 'no NOTE or SUMMARY of the environment was recorded');
        await nothingRan(dir, textDir);
      });
    });
  });
}
