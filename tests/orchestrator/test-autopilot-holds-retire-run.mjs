// ADR-0068 Decision 2, items 8 and 11 (impl-hold Task 12): what ended goes at
// the places I3 names besides done — a run's start (before any release is
// compared or any row acts) orphans a hold its subtask no longer matches and
// retires a completed subtask's records; `status` does the same and retires
// an archived macro's holds directory; the Stop hook's sweep reaches an
// archived macro, which its loop over live macros never sees.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AP, COMMIT, setup } from './fixtures/autopilot-lanes-run.mjs';
import { bounded, H, laneEvents, OPS } from './fixtures/autopilot-holds-run.mjs';

const HC = await import(pathToFileURL(join(AP, 'holds-cli.mjs')).href);
const STOP = await import(pathToFileURL(join(AP, '../../../scripts/stop-archive.mjs')).href);

async function withRun(fn) {
  const t = await setup({ subtasks: [{ id: 'A' }, { id: 'C' }], scenario: { A: { next: [COMMIT], file: 'a.txt' }, C: { next: [COMMIT], file: 'c.txt' } } });
  try {
    const M = t.fx.macroId;
    // C has landed: recorded completed before the run.
    const engineerWorkflowId = 'compose-20261026T000000Z-cccccc';
    await t.fx.orch.updateSubtask({ workflowPath: t.fx.macroPath, subtaskId: 'C', host: 'claude', status: 'in_progress', engineerWorkflowId });
    await t.fx.orch.updateSubtask({
      workflowPath: t.fx.macroPath, subtaskId: 'C', host: 'claude', status: 'completed', engineerWorkflowId,
      commit: t.fx.git('rev-parse', 'HEAD'), closedAt: '2026-10-26T00:00:00Z',
    });
    H.writeProtocol(t.work, M, { writtenBy: 'test' });
    const c = await OPS.setHold({ mainRoot: t.work, macroId: M, subtaskId: 'C', branch: 'feat/c' });
    const z = await OPS.setHold({ mainRoot: t.work, macroId: M, subtaskId: 'Z', branch: 'feat/z' });
    await fn({ t, M, c, z });
  } finally {
    t.fx.cleanup();
  }
}

describe('ended holds at a run\'s start, at status, and at Stop (ADR-0068 Decision 2, item 8)', () => {
  it("a run's start orphans a hold whose subtask left the plan and retires a completed subtask's records, and records both", () => withRun(async ({ t, M, c, z }) => {
    await bounded(t);
    const owner = (id) => H.readOwnerHold(t.work, M, id).record;
    deepStrictEqual([owner('Z').state, owner('Z').orphaned?.why], ['held', 'subtask Z left the plan']);
    strictEqual(owner('C').state, 'retired');
    ok(t.lines.some((l) => l.includes(`lane Z: its hold ${z.hold_id} is orphaned: subtask Z left the plan`)), t.lines.join('\n'));
    ok(t.lines.some((l) => l.includes('lane C: completed: its hold records are retired')), t.lines.join('\n'));
    const events = laneEvents(t, t.latest());
    ok(events.some((e) => e.event === 'orphaned' && e.subtask_id === 'Z' && e.hold_id === z.hold_id), JSON.stringify(events));
    ok(events.some((e) => e.event === 'retired' && e.subtask_id === 'C' && e.hold_id === c.hold_id), JSON.stringify(events));
  }));

  it("status orphans and retires too; an archived macro's holds directory goes at status and at the Stop sweep", () => withRun(async ({ t, M, z }) => {
    const lines = await HC.holdsStatusLines(t.work, M);
    ok(lines.some((l) => l.includes(`Z: hold ${z.hold_id} orphaned now: subtask Z left the plan`)), lines.join('\n'));
    ok(lines.some((l) => l.includes('C: completed: its hold records retired now')), lines.join('\n'));
    strictEqual(H.readOwnerHold(t.work, M, 'C').record.state, 'retired');
    // Archived (a Stop moved it), its directory left by a crash.
    const archive = join(t.work, '.agentic-plugins/state/orchestrator/archive');
    mkdirSync(archive, { recursive: true });
    renameSync(t.fx.macroPath, join(archive, `${M}.md`));
    deepStrictEqual(await HC.holdsStatusLines(t.work, M), [`holds of ${M}: retired (the macro is archived)`]);
    strictEqual(existsSync(H.holdsDir(t.work, M)), false);
    // Left again, the Stop hook's sweep retires it: its loop sees no live macro.
    H.writeProtocol(t.work, M, { writtenBy: 'test' });
    const results = await STOP.runMacroStopArchiveAll({ repoRoot: t.work, host: 'claude', stderr: { write() {} } });
    deepStrictEqual(results, [], 'no live macro');
    strictEqual(existsSync(H.holdsDir(t.work, M)), false);
  }));
});
