// tests/orchestrator/test-done-runbook-e2e.mjs
//
// ADR-0062 — /orchestrator:done's happy path, end to end through each
// runbook's own block (commands/done.md as Claude renders it, and the Codex
// skill's mirror), in every shell the runbooks may run in, with the real
// orchestrator scripts, a real bare origin and a fake gh: the merge commit is
// recorded, the archived owner is found, and the successor is unblocked.
//
// The one end-to-end run per runbook path, in the large tier
// (scripts/data/test-tiers.json). The branches and refusals are in
// test-done-runbook.mjs (each once, in bash), and the rules the CLI applies
// in test-done-state.mjs, in process. A shell that is not installed (zsh on
// the CI image) is reported as skipped, not passed. Not /bin/sh: the blocks
// use bash arrays, which dash, Ubuntu's /bin/sh, lacks (the runbooks say so).

import { describe, it, before } from 'node:test';
import { strictEqual } from 'node:assert/strict';
import { DONE_SHELLS, ENGINEER_ID, VARIANTS, runner, withFixture } from './_done-runbook-fixture.mjs';

for (const [shell, installed] of DONE_SHELLS) for (const [variant, label] of VARIANTS) describe(`${label}, end to end (ADR-0062, ${shell})`, { skip: !installed && `${shell} is not installed` }, () => {
  before(() => { runner.shell = shell; runner.variant = variant; });
  it('records the merge commit, finds the archived owner, and unblocks the successor', async () => {
    await withFixture(async ({ done, subtask, squash }) => {
      const r = await done({});
      strictEqual(r.status, 0, r.stderr);
      const a = await subtask('A');
      strictEqual(a.status, 'completed');
      strictEqual(a.commit, squash);
      strictEqual(a.pr_url, 'https://github.com/o/r/pull/7');
      strictEqual(a.engineer_workflow_id, ENGINEER_ID);
      strictEqual((await subtask('B')).status, 'pending');
    });
  });
});
