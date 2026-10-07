// tests/plugin-shape/test-orchestrator-landing-runbooks.mjs
//
// The calls and flags the /orchestrator:plan, :next, :done, :finalize and
// :abort runbooks make on both hosts (Claude commands/*.md and the Codex
// skill mirrors), where no behavior test runs the block. The state CLI
// behaviour itself is covered in tests/orchestrator/.

import { describe, it } from 'node:test';
import { ok } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ORCH = resolve(REPO_ROOT, 'plugins/orchestrator');
const read = (rel) => readFile(resolve(ORCH, rel), 'utf8');

describe('/orchestrator:plan refuses a terminal macro before writing', () => {
  it('Claude runbook refuses a terminal macro inside both phase appends', async () => {
    const text = await read('commands/plan.md');
    // Contract: the agent running /orchestrator:plan — without --require-open the resume
    // append writes into a terminal macro instead of stopping.
    ok(/--phase-label "Phase 0: Resume macro plan"[\s\S]{0,300}--require-open \|\| exit 1/.test(text),
      'the resume append carries --require-open and stops on refusal');
    // Contract: the agent running /orchestrator:plan — without --require-open the post-plan
    // append lands on a macro finalized in between.
    ok(/--current-phase phase-2-presented[\s\S]{0,300}--require-open/.test(text),
      'the post-plan append carries --require-open');
  });

  it('Codex skill mirror passes the same refusal flag', async () => {
    const text = await read('core/skills/plan/SKILL.md');
    // Contract: the Codex agent running $orchestrator:plan — without the flag its appends
    // write into a terminal macro.
    ok(text.includes('--require-open'), 'plan skill uses the locked refusal');
  });
});

describe('/orchestrator:next takes readiness from the plan', () => {
  it('Claude runbook asks subtask-readiness for the explicit-id checks', async () => {
    const text = await read('commands/next.md');
    // Contract: the agent running /orchestrator:next — the explicit-id check must call the
    // state CLI with these arguments, not judge readiness from the status alone.
    ok(text.includes('subtask-readiness --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID"'),
      'next.md resolves readiness through the state CLI');
    // Contract: the no-candidate stop reads next-ready's `readiness` field — without it the
    // stop message falls back to a status-only diagnosis.
    ok(/in_progress_or_blocked\)[\s\S]{0,1500}o\.readiness/.test(text),
      'the no-candidate diagnosis prints next-ready readiness');
  });

  it('Codex skill mirror calls the same CLI and branches from the remote-tracking ref', async () => {
    const text = await read('core/skills/next/SKILL.md');
    // Contract: the Codex agent running $orchestrator:next — it must call subtask-readiness,
    // and create the branch from origin/<integration> without an upstream (otherwise a
    // successor starts from the previous subtask's branch, or a bare push targets main).
    ok(text.includes('subtask-readiness'), 'next skill uses subtask-readiness');
    ok(text.includes('refs/remotes/origin/<integration>'), 'next skill branches from the remote-tracking ref');
    ok(text.includes('--no-track'), 'next skill does not set an upstream on the new branch');
  });
});

describe('/orchestrator:done records the landing', () => {
  it('Claude runbook resolves the merge commit and hands the reason over as a file', async () => {
    const text = await read('commands/done.md');
    // Contract: the agent running /orchestrator:done — the landing comes from
    // resolve-landing, and every completion write carries --expect-branch.
    ok(text.includes('state.mjs" resolve-landing'), 'done.md calls resolve-landing');
    ok(text.includes('--expect-branch="$SUBTASK_BRANCH"'), 'every completion write carries --expect-branch');
    // Contract: the agent running /orchestrator:done — the reason must reach the block as a
    // file the agent wrote; a heredoc ends at a delimiter line inside the reason and runs the rest.
    ok(text.includes('with your file-writing tool'), 'the reason reaches the runbook as a file the agent wrote');
    ok(!/<<-?\s*'?[A-Z_]*REASON/.test(text), 'no heredoc carries the reason (a delimiter line in it would end the heredoc)');
  });

  it('Codex skill mirror calls the same CLI with the same flags', async () => {
    const text = await read('core/skills/done/SKILL.md');
    // Contract: the Codex agent running $orchestrator:done — the call and the flags it
    // passes; a missing one records the branch tip, skips the branch check or a mode.
    for (const needle of ['resolve-landing', '--expect-branch', '--no-commit', '--correct']) {
      ok(text.includes(needle), `done skill mentions ${needle}`);
    }
  });
});

describe('engineer preflight purpose per runbook', () => {
  it('/next dispatches with the full check; /finalize and /abort use the lifecycle check', async () => {
    const next = await read('commands/next.md');
    // Contract: discover-engineer.mjs preflight reads --purpose — /next must run the full
    // dispatch check, /finalize and /abort the lifecycle one (else they stop halfway).
    ok(/discover-engineer\.mjs" preflight \\?\n?\s*--root "\$ENGINEER_PLUGIN_ROOT"(?! --purpose)/.test(next),
      'next.md preflights for dispatch');
    for (const cmd of ['finalize', 'abort']) {
      const text = await read(`commands/${cmd}.md`);
      ok(text.includes('preflight --root "$ENGINEER_PLUGIN_ROOT" --purpose lifecycle'), `${cmd}.md uses the lifecycle preflight`);
    }
  });
});
