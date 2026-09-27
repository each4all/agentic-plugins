// tests/plugin-shape/test-orchestrator-landing-runbooks.mjs
//
// ADR-0062 runbook contracts for /orchestrator:plan, :next and :done, on
// both hosts (Claude commands/*.md and the Codex skill mirrors). The state
// CLI behaviour itself is covered in tests/orchestrator/; these assertions
// pin the runbook steps that call it, in the order that matters.

import { describe, it } from 'node:test';
import { ok } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ORCH = resolve(REPO_ROOT, 'plugins/orchestrator');
const read = (rel) => readFile(resolve(ORCH, rel), 'utf8');

function indexOfOrFail(text, needle, label) {
  const at = text.indexOf(needle);
  ok(at >= 0, `${label}: expected to find ${JSON.stringify(needle)}`);
  return at;
}

describe('/orchestrator:plan refuses a terminal macro before writing (ADR-0062 §Decision 4)', () => {
  it('Claude runbook refuses a terminal macro inside both phase appends', async () => {
    const text = await read('commands/plan.md');
    indexOfOrFail(text, 'ADR-0062 §Decision 4', 'plan.md');
    ok(/--phase-label "Phase 0: Resume macro plan"[\s\S]{0,300}--require-open \|\| exit 1/.test(text),
      'the resume append carries --require-open and stops on refusal');
    ok(/--current-phase phase-2-presented[\s\S]{0,300}--require-open/.test(text),
      'the post-plan append carries --require-open');
  });

  it('Codex skill mirror states the same refusal', async () => {
    const text = await read('core/skills/plan/SKILL.md');
    ok(text.includes('terminal_marker'), 'plan skill names terminal_marker');
    ok(text.includes('ADR-0062 §Decision 4'), 'plan skill cites the decision');
    ok(text.includes('--require-open'), 'plan skill uses the locked refusal');
    ok(text.includes('stop before writing anything'), 'plan skill stops before any write');
  });
});

describe('/orchestrator:next takes readiness from the plan (ADR-0062 §Decision 5)', () => {
  it('Claude runbook asks subtask-readiness for the explicit-id checks', async () => {
    const text = await read('commands/next.md');
    ok(text.includes('subtask-readiness --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID"'),
      'next.md resolves readiness through the state CLI');
    ok(!text.includes('tiny scanner'), 'the inline frontmatter scanner is gone');
    ok(!text.includes('its blocked_by predecessors have not completed'),
      'the status-only blocked diagnosis is gone');
    ok(text.includes('STALE_BLOCKED'), 'a stale blocked status is reported as such');
    ok(/in_progress_or_blocked\)[\s\S]{0,1500}o\.readiness/.test(text),
      'the no-candidate diagnosis prints next-ready readiness');
  });

  it('Codex skill mirror names the same facts and the branch base', async () => {
    const text = await read('core/skills/next/SKILL.md');
    ok(text.includes('subtask-readiness'), 'next skill uses subtask-readiness');
    ok(text.includes('stale_blocked'), 'next skill reports stale blocked');
    ok(text.includes('refs/remotes/origin/<integration>'), 'next skill branches from the remote-tracking ref');
    ok(text.includes('--no-track'), 'next skill does not set an upstream on the new branch');
  });
});

describe('/orchestrator:done records the landing (ADR-0062 §Decisions 1-3)', () => {
  it('Claude runbook resolves the merge commit and never the branch tip', async () => {
    const text = await read('commands/done.md');
    ok(text.includes('state.mjs" resolve-landing'), 'done.md calls resolve-landing');
    ok(!text.includes('rev-parse "refs/heads/$SUBTASK_BRANCH"'), 'done.md no longer resolves the branch tip');
    ok(text.includes('--expect-branch="$SUBTASK_BRANCH"'), 'every completion write carries --expect-branch');
    ok(text.includes('with your file-writing tool'), 'the reason reaches the runbook as a file the agent wrote');
    ok(!/<<-?\s*'?[A-Z_]*REASON/.test(text), 'no heredoc carries the reason (a delimiter line in it would end the heredoc)');
    ok(text.includes('"workflows", "archive"'), 'the owner fallback scan includes archive homes');
  });

  it('Codex skill mirror follows the same ritual', async () => {
    const text = await read('core/skills/done/SKILL.md');
    for (const needle of ['resolve-landing', '--expect-branch', '--no-commit', '--correct', 'archive homes', 'ancestry-only']) {
      ok(text.includes(needle), `done skill mentions ${needle}`);
    }
  });
});

describe('engineer preflight purpose per runbook (ADR-0062 §Decision 6)', () => {
  it('/next dispatches with the full check; /finalize and /abort use the lifecycle check', async () => {
    const next = await read('commands/next.md');
    ok(/discover-engineer\.mjs" preflight \\?\n?\s*--root "\$ENGINEER_PLUGIN_ROOT"(?! --purpose)/.test(next),
      'next.md preflights for dispatch');
    for (const cmd of ['finalize', 'abort']) {
      const text = await read(`commands/${cmd}.md`);
      ok(text.includes('preflight --root "$ENGINEER_PLUGIN_ROOT" --purpose lifecycle'), `${cmd}.md uses the lifecycle preflight`);
    }
  });
});
