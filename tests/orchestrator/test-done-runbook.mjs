// tests/orchestrator/test-done-runbook.mjs
//
// ADR-0062 — /orchestrator:done is the step that completes a subtask, so the
// branches and refusals its runbook's shell text decides are exercised here as
// the agent receives the runbook (tests/orchestrator/_done-runbook-fixture.mjs
// renders and runs it): each once, in bash. Its happy path, in every shell the
// runbooks may run in, is in test-done-runbook-e2e.mjs (the large tier); the
// rules the CLI applies (the owner scans, the argument grammar, the write's own
// refusals) are tested in process in test-done-state.mjs.
//
// Two runbooks: commands/done.md (Claude) and the Codex skill's mirror. The
// Claude suite holds every case; the Codex suite only those its own block's
// shell text decides (`both`), since the rules behind a CLI call are the same
// code whichever block calls it.

import { describe, it, before } from 'node:test';
import { deepStrictEqual, match, strictEqual, notStrictEqual, ok } from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile, rename } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  DONE_TEXT, ENGINEER_ID, GIT_ENV, ORCH_ROOT, PHASES, STATE_SCRIPT, VARIANTS,
  bashBlocks, codexBlock, git, renderPhases, runbookScript, runner, substituteClaudeArguments, withFixture,
} from './_done-runbook-fixture.mjs';

const { createWorkflow, setPlan, updateSubtask, readWorkflow, parseWorkflowFile, assembleWorkflowFile } = await import(STATE_SCRIPT);

for (const [variant, label] of VARIANTS) describe(`${label} (ADR-0062, bash)`, () => {
  before(() => { runner.shell = 'bash'; runner.variant = variant; });
  const SH = 'bash';
  // A case about one host's text alone (Claude's argument substitution, the
  // Codex block's shape) runs in that host's suite only; a case whose decision
  // lives in a CLI the block calls runs in the Claude suite only (claudeOnly);
  // `both` runs a branch each block's own shell text decides.
  const both = it;
  const claudeOnly = variant === 'claude' ? it : () => {};
  const codexOnly = variant === 'codex' ? it : () => {};

  // A file run on its own from an agentic session inherits the session's
  // variables; the runbook shell starts without them (runbookEnv). Planted
  // here, where a variable inherited at load would not show: the plugin root
  // names a directory with no state.mjs, and the run marker would put the
  // block under autopilot. The control passes them as a case does, and fails.
  claudeOnly('the runbook shell starts without the session\'s inherited AGENTIC_* variables', async () => {
    await withFixture(async ({ dir, done, subtask }) => {
      const planted = {
        AGENTIC_ORCHESTRATOR_ROOT: join(dir, 'planted-orchestrator-root'),
        AGENTIC_ENGINEER_ROOT: join(dir, 'planted-engineer-root'),
        AGENTIC_AUTOPILOT: 'autopilot-20261023T000000Z-abcdef',
      };
      const control = await done({}, { env: planted });
      notStrictEqual(control.status, 0, 'the planted variables do not reach the block: the check proves nothing');
      strictEqual((await subtask('A')).status, 'in_progress');
      const saved = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
      Object.assign(process.env, planted);
      let r;
      try {
        r = await done({});
      } finally {
        for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await subtask('A')).status, 'completed');
    });
  });

  // C67. Claude replaced `"$1"` in the field readers with the second argument,
  // so any /done typed with a flag read every field as empty.
  claudeOnly('--pr=<n> names the pull request, and the fields still read', async () => {
    await withFixture(async ({ done, subtask, squash }) => {
      const r = await done({ pr: '7' });
      strictEqual(r.status, 0, r.stderr);
      const a = await subtask('A');
      strictEqual(a.status, 'completed');
      strictEqual(a.commit, squash);
      strictEqual((await subtask('B')).status, 'pending');
    });
  });

  claudeOnly('Claude\'s argument substitution leaves every bash block as written', () => {
    const file = bashBlocks(PHASES).join('\n');
    const lines = [
      '', 'A', 'A --pr=7', 'A --pr=7 --commit=0123abc --correct landed as the rebased tip',
      'A --no-commit "investigation only" --workflow=macro-plan-x --integration-branch=main',
      `A 'x"; touch /tmp/never; "' --correct`,
      'A --no-commit\n## Phase 0\n```bash\ntouch /tmp/never\n```\n## Completion',
      Array.from({ length: 12 }, (_, i) => `w${i}`).join(' '),
    ];
    // Contract: Claude substitutes the typed arguments into the command body — a
    // placeholder inside a bash block would turn typed text into shell.
    for (const args of lines) {
      const whole = substituteClaudeArguments(DONE_TEXT, args);
      // The substitution did run: the prose placeholders took the arguments.
      ok(!whole.includes('$ARGUMENTS') && whole.includes(args), `nothing was substituted for <${args}>`);
      ok(whole.includes(renderPhases(args)), `rendering the section alone differs from the file for <${args}>`);
      strictEqual(bashBlocks(renderPhases(args)).join('\n'), file, `a bash block changed for <${args}>`);
    }
  });

  claudeOnly('a typed argument that closes a double quote is never run', async () => {
    await withFixture(async ({ done, subtask, dir, macroPath }) => {
      const marker = join(dir, 'should-not-exist');
      const reason = `x"; touch ${marker}; "`;
      const r = await done({ no_commit: true }, { reason, typed: `A --no-commit ${reason}` });
      strictEqual(existsSync(marker), false, 'the argument ran as shell');
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await subtask('A')).status, 'completed');
      ok((await readWorkflow(macroPath)).body.includes(`Reason: ${reason}`));
    });
  });

  // zsh's echo expands the backslash escapes in its argument, as bash's does
  // under xpg_echo. A reader that piped `echo "$SUBTASK_JSON"` into JSON.parse
  // got a raw newline inside a JSON string and read every field as empty.
  both('a subtask whose JSON carries escapes still reads under an echo that expands them', async () => {
    await withFixture(async ({ done, subtask, squash }) => {
      const r = await done({ pr: '7' }, { prelude: SH === 'bash' ? 'shopt -s xpg_echo' : '' });
      strictEqual(r.status, 0, r.stderr);
      const a = await subtask('A');
      strictEqual(a.status, 'completed');
      strictEqual(a.commit, squash);
    }, { topicA: 'line one\nline two, C:\\temp' });
  });

  // The document goes through printf, a builtin, so the reader is not bounded
  // by the argument and environment limit of an exec'd command (1 MiB in all
  // on macOS, 128 KiB per string on Linux). Checked on the reader as done.md
  // spells it, because read-subtask itself cuts its output at 64 KiB today
  // (docket C70) and would fail an end-to-end case before the reader runs.
  both('the field reader takes a document larger than an exec argument limit', async () => {
    const lines = (variant === 'codex' ? codexBlock() : runbookScript('A')).split('\n');
    // Contract: the test runs these two runbook lines — renamed, they must fail here.
    const reader = lines.find((l) => l.startsWith('JSON_FIELD='));
    const read = lines.find((l) => l.startsWith('SUBTASK_BRANCH='));
    ok(reader && read, `the ${variant} runbook reads the subtask branch through JSON_FIELD`);
    const dir = await mkdtemp(join(tmpdir(), 'orchestrator-done-reader-'));
    try {
      const doc = join(dir, 'subtask.json');
      await writeFile(doc, JSON.stringify({ id: 'A', branch: 'feat/a', topic: 'x'.repeat(1_100_000) }));
      const r = spawnSync(SH, ['-c', `SUBTASK_JSON="$(cat '${doc}')"\n${reader}\n${read}\nprintf '%s' "$SUBTASK_BRANCH"`], {
        encoding: 'utf8', env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` },
      });
      strictEqual(r.stdout, 'feat/a', r.stderr);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Docket C110: the integration branch comes from the macro's own read. A read
  // that prints its answer and then fails stops the block before the landing;
  // piped into its parser, the read's status was lost and the block went on.
  both('a macro read that prints its answer and then fails stops the block; nothing is recorded', async () => {
    await withFixture(async ({ done, subtask, dir }) => {
      const shim = join(dir, 'failing-read-root');
      await mkdir(join(shim, 'scripts'), { recursive: true });
      await writeFile(join(shim, 'scripts', 'state.mjs'), [
        "import { spawnSync } from 'node:child_process';",
        'const args = process.argv.slice(2);',
        `const real = spawnSync(process.execPath, [${JSON.stringify(resolve(ORCH_ROOT, 'scripts/state.mjs'))}, ...args], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });`,
        'process.stdout.write(real.stdout);',
        "process.exit(args[0] === 'read' ? 1 : (real.status ?? 1));",
      ].join('\n'));
      const env = { CLAUDE_PLUGIN_ROOT: shim, AGENTIC_ORCHESTRATOR_ROOT: shim };
      const r = await done({}, { env });
      strictEqual(r.status, 1, r.stderr);
      strictEqual((await subtask('A')).status, 'in_progress', 'nothing was recorded');
      // Control: with the branch named, the block reads no macro, and records.
      const named = await done({ integration_branch: 'main' }, { env });
      strictEqual(named.status, 0, named.stderr);
      strictEqual((await subtask('A')).status, 'completed');
    });
  });

  both('without gh, --commit is recorded by ancestry, with no pull request and a note saying so', async () => {
    await withFixture(async ({ done, subtask, squash, macroPath }) => {
      const r = await done({ commit: squash }, { env: { FAKE_GH_FAIL: '1' } });
      strictEqual(r.status, 0, r.stderr);
      const a = await subtask('A');
      strictEqual(a.status, 'completed');
      strictEqual(a.commit, squash);
      strictEqual(a.pr_url, undefined);
      ok((await readWorkflow(macroPath)).body.includes('Reason: Landing verified by ancestry only: gh was unavailable'));
    });
  });

  both('a second run changes nothing', async () => {
    await withFixture(async ({ done, macroPath }) => {
      strictEqual((await done({})).status, 0);
      const before = await readFile(macroPath, 'utf8');
      const again = await done({});
      strictEqual(again.status, 0, again.stderr);
      ok(/already completed/.test(again.stderr), again.stderr);
      strictEqual(await readFile(macroPath, 'utf8'), before);
    });
  });

  both('refuses while the pull request is open, and records nothing', async () => {
    await withFixture(async ({ done, subtask, pr }) => {
      const r = await done({}, { prs: [pr({ state: 'OPEN', mergeCommit: null })] });
      strictEqual(r.status, 1);
      ok(/Cannot record A yet — not_merged/.test(r.stderr), r.stderr);
      strictEqual((await subtask('A')).status, 'in_progress');
    });
  });

  both('--correct needs a reason, then records old and new with the reason verbatim', async () => {
    await withFixture(async ({ done, macroPath, pr, later, squash, dir }) => {
      strictEqual((await done({})).status, 0);
      const corrected = [pr({ mergeCommit: { oid: later } })];
      const bare = await done({ correct: true }, { prs: corrected });
      strictEqual(bare.status, 1);
      ok(/need a reason/.test(bare.stderr), bare.stderr);

      const marker = join(dir, 'should-not-exist');
      const reason = `landed as ${later.slice(0, 7)}; "quoted" $(touch ${marker}) \`touch ${marker}\``;
      const r = await done({ correct: true }, { prs: corrected, reason });
      strictEqual(r.status, 0, r.stderr);
      const { frontmatter, body } = await readWorkflow(macroPath);
      strictEqual(frontmatter.plan.subtasks[0].commit, later);
      ok(body.includes(`commit: "${squash}" -> "${later}"`), body);
      ok(body.includes(`Reason: ${reason}`), body);
      strictEqual(existsSync(marker), false, 'the reason is never evaluated by the shell');
    });
  });

  // C163 A2b (ADR-0069 Decision 3) — a landing that differs from what was
  // reviewed has landed: it is not recorded until the owner says what follows.
  // The engineer answering here is a stub that prints the comparison.
  both('a landing that differs is refused; --accept-landed-change with a reason records it, and the macro says so', async () => {
    await withFixture(async ({ done, macroPath, dir }) => {
      const root = join(dir, 'stub-engineer');
      await mkdir(join(root, 'scripts'), { recursive: true });
      await mkdir(join(root, '.claude-plugin'), { recursive: true });
      await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'engineer', version: '9.9.9' }));
      await writeFile(join(root, 'scripts', 'state.mjs'), `process.stdout.write(JSON.stringify({ kind: 'landed', state: process.env.STUB_STATE, reason: process.env.STUB_STATE === 'different' ? null : 'no-committed-comparison:abc', failures: [{ path: 'pkg/x', why: 'differs', by: ['r1'] }] }));\n`);
      const env = { AGENTIC_ENGINEER_ROOT: root, STUB_STATE: 'different' };
      const refused = await done({}, { env });
      strictEqual(refused.status, 1, refused.stderr);
      match(refused.stderr, /is not the change reviewed: pkg\/x/);
      strictEqual((await readWorkflow(macroPath)).frontmatter.plan.subtasks[0].status, 'in_progress');
      const bare = await done({ accept_landed_change: true }, { env });
      strictEqual(bare.status, 1);
      ok(/need a reason/.test(bare.stderr), bare.stderr);
      // Under an autopilot run the acceptance is the owner's alone: a worker
      // rerunning done with it and a reason it wrote is refused at the write,
      // and nothing is recorded (critique of 2026-11-08, MAJOR 1).
      const worker = await done({ accept_landed_change: true }, { env: { ...env, AGENTIC_AUTOPILOT: 'autopilot-20261108T000000Z-abcdef' }, reason: 'a worker wrote this' });
      strictEqual(worker.status, 1, worker.stderr);
      match(worker.stderr, /--accept-landed-change refused under autopilot/);
      strictEqual((await readWorkflow(macroPath)).frontmatter.plan.subtasks[0].status, 'in_progress');
      const r = await done({ accept_landed_change: true }, { env, reason: 'the owner read the difference' });
      strictEqual(r.status, 0, r.stderr);
      const { frontmatter, body } = await readWorkflow(macroPath);
      strictEqual(frontmatter.plan.subtasks[0].status, 'completed');
      ok(body.includes('Landed change differs from what was reviewed (pkg/x)'), body);
      // --correct is another thing: it does not stand for the owner's word on this.
      const corrected = await done({ correct: true }, { env, reason: 'a correction' });
      strictEqual(corrected.status, 1, corrected.stderr);
      match(corrected.stderr, /is not the change reviewed/);
    });
  });

  both('a landing that cannot be compared is recorded, and the macro says why', async () => {
    await withFixture(async ({ done, macroPath, dir }) => {
      const root = join(dir, 'stub-engineer');
      await mkdir(join(root, 'scripts'), { recursive: true });
      await mkdir(join(root, '.claude-plugin'), { recursive: true });
      await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'engineer', version: '9.9.9' }));
      await writeFile(join(root, 'scripts', 'state.mjs'), `process.stdout.write(JSON.stringify({ kind: 'landed', state: 'not-comparable', reason: 'no-committed-comparison:abc', failures: [] }));\n`);
      const r = await done({}, { env: { AGENTIC_ENGINEER_ROOT: root } });
      strictEqual(r.status, 0, r.stderr);
      const { frontmatter, body } = await readWorkflow(macroPath);
      strictEqual(frontmatter.plan.subtasks[0].status, 'completed');
      ok(body.includes('Landed change not compared with its reviews: no-committed-comparison:abc'), body);
    });
  });

  both('a reason that contains shell syntax or a heredoc-delimiter line is recorded, never run', async () => {
    await withFixture(async ({ done, macroPath, pr, later, dir }) => {
      strictEqual((await done({})).status, 0);
      const marker = join(dir, 'should-not-exist');
      const reason = `line one\nAGENTIC_DONE_REASON_EOF\ntouch ${marker}\nEOF\n$(touch ${marker})`;
      const r = await done({ correct: true }, { prs: [pr({ mergeCommit: { oid: later } })], reason });
      strictEqual(r.status, 0, r.stderr);
      strictEqual(existsSync(marker), false, 'nothing in the reason ran');
      ok((await readWorkflow(macroPath)).body.includes(`Reason: ${reason}`));
    });
  });

  both('with the owner recovered from the archive, an older merge of the branch is not taken', async () => {
    await withFixture(async ({ done, subtask, pr }) => {
      const old = pr({ number: 3, url: 'https://github.com/o/r/pull/3', createdAt: '2026-09-01T00:00:00Z' });
      const r = await done({}, { prs: [old] });
      strictEqual(r.status, 1);
      ok(/no_pr/.test(r.stderr), r.stderr);
      strictEqual((await subtask('A')).status, 'in_progress');
      strictEqual((await subtask('B')).status, 'blocked');
    });
  });

  both('--workflow selects the macro explicitly under bash', async () => {
    await withFixture(async ({ done, subtask, macroPath }) => {
      const id = macroPath.split('/').pop().replace(/\.md$/, '');
      const r = await done({ workflow: id });
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await subtask('A')).status, 'completed');
    });
  });

  both('--no-commit is refused while the engineer child is active, then completes with the reason', async () => {
    await withFixture(async ({ done, subtask, child, macroPath }) => {
      await rename(child('archive'), child('workflows'));
      const refused = await done({ no_commit: true }, { reason: 'investigation only; no code change' });
      strictEqual(refused.status, 1);
      ok(/still active/.test(refused.stderr), refused.stderr);
      strictEqual((await subtask('A')).status, 'in_progress');

      await rename(child('workflows'), child('archive'));
      const r = await done({ no_commit: true }, { reason: 'investigation only; no code change' });
      strictEqual(r.status, 0, r.stderr);
      const a = await subtask('A');
      strictEqual(a.status, 'completed');
      strictEqual('commit' in a, false);
      ok((await readWorkflow(macroPath)).body.includes('Reason: investigation only; no code change'));
    });
  });

  // ADR-0067 Decision 4, item 5 — the owner Phase 2's scan finds is bound by
  // done's write. Contract: the scan reads the dispatch the child records (or
  // the branch it was created on, for a child that predates the record) and
  // the write is refused under the macro's file lock when a plan revision
  // changed the subtask since; nothing is bound or completed. The completed
  // case above is the unrevised control. The same comparison for an owner the
  // subtask already records is the owner scan's (test-done-state.mjs).
  const TOPIC_WHY = 'topic is "a revised topic"; the child was dispatched for "the topic"';
  for (const [label, recorded, revision, why, noCommit] of [
    ['a child that predates the record, the branch revised (--no-commit)', false, { branch: 'feat/a2' }, 'branch is "feat/a2"; the child was dispatched for "feat/a"', true],
    ['a recorded dispatch, the topic revised (--no-commit)', true, { topic: 'a revised topic' }, TOPIC_WHY, true],
    ['a recorded dispatch, the topic revised (the landing)', true, { topic: 'a revised topic' }, TOPIC_WHY, false],
  ]) {
    both(`an owner the scan finds is not bound to a subtask revised since its dispatch: ${label}`, async () => {
      await withFixture(async ({ done, subtask, child, macroPath }) => {
        if (recorded) {
          const text = await readFile(child('archive'), 'utf8');
          await writeFile(child('archive'), text.replace('originating_subtask: "A"\n', 'originating_subtask: "A"\ndispatched_branch: "feat/a"\ndispatched_verb: "compose"\ndispatched_profile: ""\ndispatched_topic: "the topic"\n'));
        }
        await setPlan({
          workflowPath: macroPath, host: 'claude',
          subtasks: [
            {
              id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress', topic: 'the topic', ...revision,
            },
            { id: 'B', verb: 'compose', branch: 'feat/b', blocked_by: ['A'], status: 'blocked' },
          ],
        });
        const before = await readFile(macroPath, 'utf8');
        const r = noCommit ? await done({ no_commit: true }, { reason: 'investigation only' }) : await done({});
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes(`(dispatch-changed): ${why}`), r.stderr);
        strictEqual(await readFile(macroPath, 'utf8'), before);
        strictEqual((await subtask('A')).engineer_workflow_id, undefined);
        strictEqual((await subtask('A')).status, 'in_progress');
      });
    });
  }

  // A scan that cannot read a workflow home or file must refuse, not read the
  // failure as "no child": that would complete the subtask while its child is
  // still active (C3 review, G3). The scans' own refusals, for each fault, are
  // tested in process (test-done-state.mjs); here, the block's: a fault that
  // appears while `admission join` runs (a shim plugin root makes it, then
  // hands every call to the real state.mjs) reaches the active-child scan
  // after the join, and one present from the start stops the owner scan.
  const faultDuringJoin = async (dir, fault) => {
    const shim = join(dir, 'shim-root');
    await mkdir(join(shim, 'scripts'), { recursive: true });
    await writeFile(join(shim, 'scripts', 'state.mjs'), [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      'const args = process.argv.slice(2);',
      `if (args[0] === 'admission' && args[1] === 'join') { ${fault} }`,
      `const r = spawnSync(process.execPath, [${JSON.stringify(resolve(ORCH_ROOT, 'scripts/state.mjs'))}, ...args], { stdio: 'inherit' });`,
      'process.exit(r.status ?? 1);',
    ].join('\n'));
    return { CLAUDE_PLUGIN_ROOT: shim, AGENTIC_ORCHESTRATOR_ROOT: shim };
  };
  for (const [what, fault] of [
    ['an engineer workflow home cannot be listed', (work) => `mkdirSync(${JSON.stringify(join(work, '.claude/agentic-engineer'))}, { recursive: true }); writeFileSync(${JSON.stringify(join(work, '.claude/agentic-engineer/workflows'))}, 'not a directory\\n');`],
  ]) {
    both(`--no-commit refuses when ${what}`, async () => {
      await withFixture(async ({ done, subtask, work, macroPath, dir }) => {
        await updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host: 'claude', engineerWorkflowId: ENGINEER_ID });
        const r = await done({ no_commit: true }, { reason: 'investigation only', env: await faultDuringJoin(dir, fault(work)) });
        strictEqual(r.status, 1, r.stderr);
        ok(/could not scan the engineer workflow homes for an active child of A/i.test(r.stderr), r.stderr);
        strictEqual((await subtask('A')).status, 'in_progress');
        deepStrictEqual(sessionEntries(work, macroPath), [], 'released on that refusal');
      });
    });
  }

  both('the owner scan refuses when an engineer workflow file cannot be read, rather than guessing', async () => {
    await withFixture(async ({ done, subtask, work }) => {
      await mkdir(join(work, '.agentic-plugins/state/engineer/archive/compose-20260927T110000Z-bbbbbb.md'));
      const r = await done({});
      strictEqual(r.status, 1, r.stderr);
      ok(/could not scan the engineer workflow homes for A's owner/i.test(r.stderr), r.stderr);
      strictEqual((await subtask('A')).status, 'in_progress');
    });
  });

  // R1 (refine-verify-20261009T035420Z-ed9f8f) — the dispatch of a recorded
  // owner whose file is gone cannot be read (a lane's home removed, say), so
  // the comparison cannot run: done refuses, and only --waive-dispatch with a
  // reason completes, the macro recording both. Contract: the refusal writes
  // nothing on either write path; the waiver is the one way through.
  for (const [label, vars] of [['the landing', {}], ['--no-commit', { no_commit: true }]]) {
    both(`a recorded owner with no file left refuses; --waive-dispatch with a reason completes and is recorded (${label})`, async () => {
      await withFixture(async ({ done, subtask, child, macroPath }) => {
        await updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host: 'claude', engineerWorkflowId: ENGINEER_ID });
        await rm(child('archive'));
        const before = await readFile(macroPath, 'utf8');
        const refused = await done(vars, { reason: vars.no_commit ? 'investigation only' : null });
        strictEqual(refused.status, 1, refused.stderr);
        ok(refused.stderr.includes(`recorded owner ${ENGINEER_ID} has no workflow file left`), refused.stderr);
        ok(refused.stderr.includes('rerun with --waive-dispatch and a reason'), refused.stderr);
        strictEqual(await readFile(macroPath, 'utf8'), before);
        const bare = await done({ ...vars, waive_dispatch: true });
        strictEqual(bare.status, 1, bare.stderr);
        ok(/need a reason/.test(bare.stderr), bare.stderr);
        strictEqual(await readFile(macroPath, 'utf8'), before);
        const reason = 'the lane that held the child was removed; the merged pull request is the work';
        const r = await done({ ...vars, waive_dispatch: true }, { reason });
        strictEqual(r.status, 0, r.stderr);
        strictEqual((await subtask('A')).status, 'completed');
        const { body } = await readWorkflow(macroPath);
        ok(body.includes(`Dispatch not compared (--waive-dispatch): the dispatch recorded by "${ENGINEER_ID}" could not be read`), body);
        ok(body.includes(`Reason: ${reason}`), body);
      });
    });
  }

  both('--waive-dispatch is refused while the owner\'s dispatch can be read and the record vouches for it, and nothing is written', async () => {
    await withFixture(async ({ done, subtask, macroPath }) => {
      await updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host: 'claude', engineerWorkflowId: ENGINEER_ID });
      const before = await readFile(macroPath, 'utf8');
      const r = await done({ waive_dispatch: true }, { reason: 'nothing to waive' });
      strictEqual(r.status, 1, r.stderr);
      ok(r.stderr.includes('waives nothing: the macro\'s record vouches for what'), r.stderr);
      strictEqual(await readFile(macroPath, 'utf8'), before);
      strictEqual((await subtask('A')).status, 'in_progress');
    });
  });

  // ADR-0068 Decision 8, item 4 — the macro's record says the archived owner
  // was last told other words for A than A's now (the plan revised back after
  // a note, say): its dispatch matches, yet done refuses, since no note reaches
  // an archived child. --waive-dispatch with a reason is its way out, and the
  // macro records the waiver.
  both('an archived owner last told other words is refused; --waive-dispatch with a reason completes it and is recorded', async () => {
    await withFixture(async ({ done, subtask, macroPath }) => {
      await updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host: 'claude', engineerWorkflowId: ENGINEER_ID });
      const parsed = parseWorkflowFile(await readFile(macroPath, 'utf8'));
      parsed.frontmatter.plan_rebindings = JSON.stringify({
        v: 1, approval: { id: 'a'.repeat(32), at: '2026-10-20T00:00:00Z', hash: 'b'.repeat(64) },
        rebindings: [], carried: [], pending: [],
        told: { [ENGINEER_ID]: { subtask: 'A', profile: '', topic: 'other words', delivery_id: 'd-0123456789abcdef', at: '2026-10-20T00:00:00Z' } },
      });
      await writeFile(macroPath, assembleWorkflowFile(parsed.frontmatter, parsed.body));
      const before = await readFile(macroPath, 'utf8');
      const refused = await done({});
      strictEqual(refused.status, 1, refused.stderr);
      ok(refused.stderr.includes(`${ENGINEER_ID} was last told other words for subtask A (delivery d-0123456789abcdef)`), refused.stderr);
      ok(refused.stderr.includes('/orchestrator:done --waive-dispatch with a reason completes the subtask'), refused.stderr);
      strictEqual(await readFile(macroPath, 'utf8'), before);
      // The waiver is of the told check only: the dispatch is still compared,
      // so a subtask moved to another branch is refused all the same.
      await writeFile(macroPath, before.replace('branch: "feat/a"', 'branch: "feat/a2"'));
      const moved = await done({ no_commit: true, waive_dispatch: true }, { reason: 'anyway' });
      strictEqual(moved.status, 1, moved.stderr);
      ok(moved.stderr.includes('(dispatch-changed)'), moved.stderr);
      strictEqual((await subtask('A')).status, 'in_progress');
      await writeFile(macroPath, before);
      const reason = 'the child finished under the words it was told; the merged pull request is the work';
      const r = await done({ waive_dispatch: true }, { reason });
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await subtask('A')).status, 'completed');
      const { body } = await readWorkflow(macroPath);
      ok(body.includes(`Told check waived (--waive-dispatch): ${ENGINEER_ID} is not bound to subtask "A"`), body);
      ok(body.includes(`Reason: ${reason}`), body);
    });
  });

  // Each block's own `OWNER_RC -eq 3 && WAIVE_DISPATCH` test decides the
  // waiver half (owner-dispatch exits 1 for an owner dispatched elsewhere), so
  // it runs against both runbooks.
  both('a recorded owner whose file claims another subtask refuses, --waive-dispatch or not', async () => {
    await withFixture(async ({ done, subtask, child, macroPath }) => {
      await updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host: 'claude', engineerWorkflowId: ENGINEER_ID });
      const text = await readFile(child('archive'), 'utf8');
      await writeFile(child('archive'), text.replace('originating_subtask: "A"', 'originating_subtask: "B"'));
      const before = await readFile(macroPath, 'utf8');
      for (const vars of [{}, { waive_dispatch: true }]) {
        const r = await done(vars, { reason: vars.waive_dispatch ? 'complete it anyway' : null });
        strictEqual(r.status, 1, r.stderr);
        ok(r.stderr.includes(`recorded owner ${ENGINEER_ID} was not dispatched for it`) && r.stderr.includes('originating_subtask=B'), r.stderr);
        strictEqual(await readFile(macroPath, 'utf8'), before);
        strictEqual((await subtask('A')).status, 'in_progress');
      }
    });
  });

  // R3 — the owner scan parses frontmatter values: a subtask id holding a quote
  // is written with a JSON escape, which matching the serialized text never
  // found, so its recorded owner read as missing. Contract: such an id is found
  // by its value on both paths, compared like any other, and --no-commit sees
  // its active child (the same reading).
  const QUOTED = 'A"1';
  claudeOnly('a subtask id holding a quote: the claimant is found by its value and the subtask completes', async () => {
    await withFixture(async ({ done, subtask }) => {
      const r = await done({});
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await subtask()).status, 'completed');
      strictEqual((await subtask()).engineer_workflow_id, ENGINEER_ID);
    }, { idA: QUOTED });
  });

  // C134(a) — the arguments reach the block in the args file and are parsed
  // by done's grammar, which takes a value bare: a typed id holding a quote is
  // refused before anything is read or written, and none of it runs. (The
  // cases above run the block from its parsed arguments on.)
  both('a typed subtask id holding a quote is refused by the grammar; nothing runs or is written', async () => {
    await withFixture(async ({ done, subtask, macroPath, dir }) => {
      const marker = join(dir, 'should-not-exist');
      const before = await readFile(macroPath, 'utf8');
      const r = await done({}, { typed: `'A"1$(touch ${marker})' --no-commit investigation only` });
      strictEqual(r.status, 1, r.stderr);
      ok(r.stderr.includes('holds a quote or backslash; write it bare'), r.stderr);
      strictEqual(existsSync(marker), false, 'nothing in the id ran');
      strictEqual(await readFile(macroPath, 'utf8'), before);
      strictEqual((await subtask('A')).status, 'in_progress');
    });
  });

  // R2 — two archived attempts claim the subtask (a re-dispatch after the first
  // child was archived). done refuses and prints, for each claimant, a binding
  // line that carries that claimant's dispatch, so a plan revised since refuses
  // the binding as every binding does. Contract: the line runs as printed in
  // bash and zsh, a topic with quotes and shell syntax included; the unrevised
  // binding and done are the control.
  claudeOnly('two claimants: each binding line carries its dispatch, refuses a revised subtask, and binds an unrevised one', async () => {
    const topic = `it's "quoted" $HOME \`true\``;
    await withFixture(async ({ done, subtask, child, macroPath }) => {
      const second = 'compose-20260927T100500Z-bbbbbb';
      const recorded = (await readFile(child('archive'), 'utf8')).replace('originating_subtask: "A"\n', `originating_subtask: "A"\ndispatched_branch: "feat/a"\ndispatched_verb: "compose"\ndispatched_profile: ""\ndispatched_topic: ${JSON.stringify(topic)}\n`);
      await writeFile(child('archive'), recorded);
      await writeFile(join(dirname(child('archive')), `${second}.md`), recorded.replace(ENGINEER_ID, second));
      const refused = await done({});
      strictEqual(refused.status, 1, refused.stderr);
      ok(refused.stderr.includes('More than one engineer workflow claims A'), refused.stderr);
      const lines = refused.stderr.split('\n').filter((l) => l.startsWith('    node '));
      strictEqual(lines.length, 2, refused.stderr);
      ok(lines.every((l) => l.includes('--expect-dispatch=')), refused.stderr);
      const line = lines.find((l) => l.includes(second)).trim();
      const plan = (over) => setPlan({
        workflowPath: macroPath, host: 'claude',
        subtasks: [
          { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress', topic, ...over },
          { id: 'B', verb: 'compose', branch: 'feat/b', blocked_by: ['A'], status: 'blocked' },
        ],
      });
      const shells = ['bash', ...(spawnSync('zsh', ['-c', 'true']).status === 0 ? ['zsh'] : [])];
      const run = (shell) => spawnSync(shell, ['-c', line], { encoding: 'utf8', env: { ...GIT_ENV, PATH: `${dirname(process.execPath)}:${process.env.PATH}` } });
      // A plan revision after the refusal: the binding refuses in every shell.
      await plan({ topic: 'a revised topic' });
      const before = await readFile(macroPath, 'utf8');
      for (const shell of shells) {
        const bind = run(shell);
        strictEqual(bind.status, 1, `${shell}: ${bind.stderr}`);
        ok(bind.stderr.includes(`(dispatch-changed): topic is "a revised topic"; the child was dispatched for ${JSON.stringify(topic)}`), `${shell}: ${bind.stderr}`);
        strictEqual(await readFile(macroPath, 'utf8'), before);
      }
      // Revised back: the line binds the chosen claimant, and done completes it.
      await plan({});
      const bound = run(shells[shells.length - 1]);
      strictEqual(bound.status, 0, bound.stderr);
      strictEqual((await subtask()).engineer_workflow_id, second);
      const r = await done({});
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await subtask()).status, 'completed');
    });
  });

  both('refuses to write when the plan moves the subtask while the landing is resolved', async () => {
    await withFixture(async ({ done, macroPath, subtask }) => {
      const r = await done({}, { env: { FAKE_GH_RETARGET: macroPath } });
      strictEqual(r.status, 1, r.stderr);
      ok(/not the expected "feat\/a"/.test(r.stderr), r.stderr);
      const a = await subtask('A');
      strictEqual(a.status, 'in_progress');
      strictEqual(a.branch, 'feat/a2');
    });
  });

  claudeOnly('resolves the landing for the branch the plan records now, not an earlier one', async () => {
    await withFixture(async ({ done, macroPath, subtask }) => {
      // The plan moved A to feat/a2; the merged pull request is for feat/a.
      // (The write-time race is guarded by subtask-update --expect-branch,
      // covered in test-subtask-provenance.mjs.)
      await updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host: 'claude', engineerWorkflowId: ENGINEER_ID });
      const text = await readFile(macroPath, 'utf8');
      await writeFile(macroPath, text.replace('branch: "feat/a"', 'branch: "feat/a2"'));
      const r = await done({});
      ok(/no_pr/.test(r.stderr), r.stderr);
      strictEqual(r.status, 1);
      strictEqual((await subtask('A')).status, 'in_progress');
    });
  });

  // ADR-0067 Decision 4, item 5 — the write joins the macro's run lock first.
  const sessionEntries = (work, macroPath) => {
    const lock = join(work, '.agentic-plugins/runs/autopilot/locks', `${macroPath.split('/').pop().replace(/\.md$/, '')}.lock`);
    return existsSync(lock) ? readdirSync(lock).filter((n) => /^s-[0-9a-f]{32}\.json$/.test(n)) : [];
  };
  const holdAsSession = (work, macroPath) => execFileSync(process.execPath, [
    resolve(ORCH_ROOT, 'scripts/state.mjs'), 'admission', 'join', '--macro', macroPath.split('/').pop().replace(/\.md$/, ''),
    '--checkout', work, '--command', 'finalize', '--host', 'codex',
  ], { encoding: 'utf8', env: GIT_ENV, stdio: 'pipe' }).trim();

  both('a session holding the macro lock refuses the write, naming it; nothing is written and its entry is kept', async () => {
    await withFixture(async ({ done, subtask, work, macroPath }) => {
      const other = holdAsSession(work, macroPath);
      for (const vars of [{}, { no_commit: true }]) {
        const r = await done(vars, { reason: vars.no_commit ? 'investigation only' : null });
        strictEqual(r.status, 1, r.stderr);
        ok(new RegExp(`an interactive session holds .*/orchestrator:finalize, .*host codex, .*admission ${other}`).test(r.stderr), r.stderr);
        strictEqual((await subtask('A')).status, 'in_progress');
        deepStrictEqual(sessionEntries(work, macroPath), [`s-${other}.json`]);
      }
    });
  });

  both('every exit after the join releases: a recorded landing, a --no-commit completion, and a write refused after the join', async () => {
    await withFixture(async ({ done, subtask, work, macroPath }) => {
      const refused = await done({}, { env: { FAKE_GH_RETARGET: macroPath } });
      strictEqual(refused.status, 1, refused.stderr);
      ok(/not the expected "feat\/a"/.test(refused.stderr), refused.stderr);
      deepStrictEqual(sessionEntries(work, macroPath), [], 'released after the refused write');
    });
    await withFixture(async ({ done, subtask, work, macroPath }) => {
      const r = await done({});
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await subtask('A')).status, 'completed');
      deepStrictEqual(sessionEntries(work, macroPath), [], 'released after the landing');
    });
    await withFixture(async ({ done, subtask, work, macroPath }) => {
      const r = await done({ no_commit: true }, { reason: 'investigation only' });
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await subtask('A')).status, 'completed');
      deepStrictEqual(sessionEntries(work, macroPath), [], 'released after the --no-commit completion');
    });
  });

  // A shim plugin root whose state.mjs moves the child back into the active
  // home while `admission join` runs, then hands every call to the real one:
  // a run's step that dispatched the subtask again between the check and the join.
  both('--no-commit reads the active children again after the join, and a child made meanwhile refuses and releases', async () => {
    await withFixture(async ({ done, subtask, work, macroPath, child, dir }) => {
      const shim = join(dir, 'shim-root');
      await mkdir(join(shim, 'scripts'), { recursive: true });
      await writeFile(join(shim, 'scripts', 'state.mjs'), [
        "import { renameSync } from 'node:fs';",
        "import { spawnSync } from 'node:child_process';",
        'const args = process.argv.slice(2);',
        `if (args[0] === 'admission' && args[1] === 'join') renameSync(${JSON.stringify(child('archive'))}, ${JSON.stringify(child('workflows'))});`,
        `const r = spawnSync(process.execPath, [${JSON.stringify(resolve(ORCH_ROOT, 'scripts/state.mjs'))}, ...args], { stdio: 'inherit' });`,
        'process.exit(r.status ?? 1);',
      ].join('\n'));
      const r = await done({ no_commit: true }, { reason: 'investigation only', env: { CLAUDE_PLUGIN_ROOT: shim, AGENTIC_ORCHESTRATOR_ROOT: shim } });
      strictEqual(r.status, 1, r.stderr);
      ok(/still active/.test(r.stderr), r.stderr);
      strictEqual((await subtask('A')).status, 'in_progress');
      deepStrictEqual(sessionEntries(work, macroPath), [], 'released on that refusal');
    });
  });

  // Finding 3 — owner-dispatch's exit 3 is an answer, not a failure: under
  // set -e the waiver still completes.
  both('under set -e, --waive-dispatch with a reason still completes', async () => {
    await withFixture(async ({ done, subtask, child, macroPath }) => {
      await updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host: variant, engineerWorkflowId: ENGINEER_ID });
      await rm(child('archive'));
      const r = await done({ no_commit: true, waive_dispatch: true }, { reason: 'the lane was removed', prelude: 'set -e' });
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await subtask('A')).status, 'completed');
    });
  });

  // A shim plugin root whose state.mjs prints the real answer of every call,
  // then exits `rc` for the `failing` subcommand.
  const printThenFail = async (dir, failing, rc = 1) => {
    const shim = join(dir, `print-then-fail-${failing}`);
    await mkdir(join(shim, 'scripts'), { recursive: true });
    await writeFile(join(shim, 'scripts', 'state.mjs'), [
      "import { spawnSync } from 'node:child_process';",
      'const args = process.argv.slice(2);',
      `const real = spawnSync(process.execPath, [${JSON.stringify(resolve(ORCH_ROOT, 'scripts/state.mjs'))}, ...args], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });`,
      'process.stdout.write(real.stdout);',
      `process.exit(args[0] === ${JSON.stringify(failing)} ? ${rc} : (real.status ?? 1));`,
    ].join('\n'));
    return { CLAUDE_PLUGIN_ROOT: shim, AGENTIC_ORCHESTRATOR_ROOT: shim };
  };

  // C110, Critique J2 and J3 — the subtask read and the landing are read
  // before anything is written: one that prints its answer (a whole subtask,
  // an {ok: true} landing with its commit) and then fails stops the block, and
  // nothing is joined or recorded. The control is the first case above.
  for (const failing of ['read-subtask', 'resolve-landing']) {
    both(`a ${failing} that prints its answer and then fails stops the block; nothing is recorded (C110)`, async () => {
      await withFixture(async ({ done, subtask, dir, work, macroPath }) => {
        const before = await readFile(macroPath, 'utf8');
        const r = await done({}, { env: await printThenFail(dir, failing) });
        strictEqual(r.status, 1, r.stderr);
        strictEqual(await readFile(macroPath, 'utf8'), before, 'nothing was written');
        strictEqual((await subtask('A')).status, 'in_progress');
        deepStrictEqual(sessionEntries(work, macroPath), [], 'nothing was joined');
      });
    });
  }

  // Critique D2 in one block: two macros both hold a subtask A. The block
  // resolves the macro from its arguments and reads its owner and landing
  // there, so a run for one macro completes that macro's A only. The second
  // macro's A was never dispatched: refused, nothing written to either; with
  // its own child it completes, and the first macro's A stays as it was.
  both('the same subtask id in another macro: a run completes the macro its arguments name, and no other', async () => {
    await withFixture(async ({ done, subtask, child, macroPath, work }) => {
      const { filePath: otherPath } = await createWorkflow({
        repoRoot: work, verb: 'plan', host: 'claude',
        // One active macro per branch: the second is planned on another branch,
        // and its runs name main as the integration branch.
        gitBaseline: { branch: 'plan-two', head: '0'.repeat(40), status_digest: '' },
        originalRequest: 'a second macro holding subtask A',
      });
      await setPlan({
        workflowPath: otherPath, host: 'claude',
        subtasks: [{ id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress' }],
      });
      const otherId = otherPath.split('/').pop().replace(/\.md$/, '');
      const first = await readFile(macroPath, 'utf8');
      const second = await readFile(otherPath, 'utf8');
      const named = { workflow: otherId, integration_branch: 'main' };
      const refused = await done(named);
      strictEqual(refused.status, 1, refused.stderr);
      strictEqual(await readFile(macroPath, 'utf8'), first, 'the first macro is unchanged');
      strictEqual(await readFile(otherPath, 'utf8'), second, 'the second macro is unchanged');
      const otherChild = 'compose-20260927T100500Z-dddddd';
      await writeFile(join(dirname(child('archive')), `${otherChild}.md`), (await readFile(child('archive'), 'utf8'))
        .replace(ENGINEER_ID, otherChild).replace(/parent_workflow: "[^"]*"/, `parent_workflow: "${otherId}"`));
      const r = await done(named);
      strictEqual(r.status, 0, r.stderr);
      const otherA = (await readWorkflow(otherPath)).frontmatter.plan.subtasks.find((s) => s.id === 'A');
      deepStrictEqual([otherA.status, otherA.engineer_workflow_id], ['completed', otherChild]);
      strictEqual(await readFile(macroPath, 'utf8'), first, 'the first macro is still unchanged');
      strictEqual((await subtask('A')).status, 'in_progress');
    });
  });

  // RV1 (refine-verify-20261017T172119Z-a982196) in one block: the landing is
  // resolved by the run that writes it. With the integration branch rewound
  // past the merge commit the run refuses (not_reachable) and records nothing;
  // with the branch pushed again the same run completes.
  claudeOnly('an integration branch rewound past the merge commit refuses; pushed again, the run completes', async () => {
    await withFixture(async ({ done, subtask, work, macroPath, squash, later }) => {
      git(work, 'push', '-q', '--force', 'origin', `${squash}~1:refs/heads/main`);
      const before = await readFile(macroPath, 'utf8');
      const refused = await done({});
      strictEqual(refused.status, 1, refused.stderr);
      ok(/Cannot record A yet — not_reachable/.test(refused.stderr), refused.stderr);
      strictEqual(await readFile(macroPath, 'utf8'), before, 'nothing was written');
      git(work, 'push', '-q', '--force', 'origin', `${later}:refs/heads/main`);
      const r = await done({});
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await subtask('A')).commit, squash);
    });
  });

  // The owner's ruling of 2026-10-17 (recurring-finding, option d): the Codex
  // skill runs as one block, as Claude's, and carries nothing between shell
  // calls. Contract: the files the block reads are the args file the agent
  // wrote (through command-args, C134(a)) and the reason, which is the one
  // file it writes, from the parsed arguments.
  codexOnly('the skill reads no file but its args file and the reason, and writes only the reason', () => {
    const block = codexBlock();
    ok(!block.includes('TEXT_DIR'), 'the block names no text directory');
    deepStrictEqual([...block.matchAll(/--args-file\s+("[^"]*")/g)].map((m) => m[1]), ['"$ARGS_DIR/args.json"'], 'the args file is read once');
    deepStrictEqual([...block.matchAll(/\bcat\s+("[^"]*")/g)].map((m) => m[1]), ['"$REASON_FILE"'], 'the reason is the one file cat reads');
    deepStrictEqual([...block.matchAll(/writeFileSync\(([^,]*),/g)].map((m) => m[1]), ['process.argv[1]'], 'one file is written');
    ok(/writeFileSync\(process\.argv\[1\],JSON\.parse\(d\)\.reason\)\)' "\$REASON_FILE"/.test(block), 'the file written is the reason');
    deepStrictEqual(block.split('\n').filter((l) => /(^|[^2&])>\s*"?\$/.test(l)), [], 'no line redirects into a file');
  });
});
