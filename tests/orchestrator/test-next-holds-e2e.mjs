// ADR-0068 Decision 2, item 5 (impl-hold Task 11): /orchestrator:next's
// happy path with the holds on, end to end through the runbook's own blocks
// (commands/next.md), in every shell the runbook may run in, with the real
// orchestrator and engineer scripts: Phase 3b publishes the dispatch's mark
// (N4), a hold set during the dispatch waits for it, the real engineer
// bootstrap continues it under AGENTIC_OPERATION_ID, Phase 5 leaves it to the
// engineer and records the dispatch, and the verb's last write ends it.
//
// The one end-to-end run per runbook path, in the large tier
// (scripts/data/test-tiers.json). The branches and refusals are in
// test-next-holds.mjs: the library in process, the CLI's own branches as
// focused CLI calls, and the runbook's refusals as single-block runs.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, strictEqual } from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { fileTmpDirs } from '../_tmp.mjs';
import { BLOCKS, SHELLS, holds, nextHoldsFixture, withTextDir } from './_next-holds-fixture.mjs';

const makeDir = fileTmpDirs();

describe('/orchestrator:next and holds, end to end (ADR-0068 Decision 2, item 5)', () => {
  const f = nextHoldsFixture(makeDir);

  for (const shell of SHELLS) {
    it(`(${shell}) Phase 3b publishes the mark; a hold set during the dispatch waits for it; the real engineer bootstrap continues it, and its last write ends it`, async () => {
      f.activate();
      const textDir = f.carried();
      const joined = f.run(shell, withTextDir(BLOCKS.JOIN_AND_SWITCH, textDir));
      strictEqual(joined.status, 0, joined.stderr);
      strictEqual(f.branch(), 'feat/t1');
      const m = f.mark(textDir);
      match(m.operation_id, holds.OPERATION_ID_RE);
      deepStrictEqual([m.active, m.reattach], [true, false]);
      deepStrictEqual(f.records(), [`${m.operation_id}.json`]);
      const rec = holds.readOps(f.main, f.macroId, 'T1').ops[0].record;
      deepStrictEqual([rec.kind, rec.workflow_id, rec.subtask_id], ['verb', null, 'T1']);
      // The owner holds the subtask now: its handoff waits for the dispatch.
      await f.hold();
      const waiting = await f.handoff();
      strictEqual(waiting.state, 'pending');
      match(waiting.blocker, new RegExp(`a persona operation is open in the lane: ${m.operation_id} \\(verb\\)`));
      // Phase 4's check beside its own mark refuses: the hold applies now.
      const pre = f.run(shell, `${withTextDir(BLOCKS.PRELUDE, textDir)}\necho "OPID=\${AGENTIC_OPERATION_ID:-}"`);
      strictEqual(pre.status, 1);
      match(pre.stderr, /subtask T1 is held/);
      // Without the hold, the prelude exports the mark's id.
      rmSync(holds.recordPath(f.main, f.macroId, 'holds', 'T1'));
      const pre2 = f.run(shell, `${withTextDir(BLOCKS.PRELUDE, textDir)}\necho "OPID=\${AGENTIC_OPERATION_ID:-}"`);
      strictEqual(pre2.status, 0, pre2.stderr);
      strictEqual(pre2.vars.OPID, m.operation_id);
      // The engineer's bootstrap continues the mark under that id.
      const child = f.bootstrap(pre2.vars.OPID);
      strictEqual(child.status, 0, child.stderr);
      deepStrictEqual(f.entriesOf(child.path).map((o) => [o.id, o.ext]), [[m.operation_id, true]]);
      deepStrictEqual(f.records(), [`${m.operation_id}.json`], 'one record, the mark, continued');
      // Phase 5: the child carries the mark, so it stays, the engineer's.
      const wrote = f.run(shell, withTextDir(BLOCKS.WRITEBACK, textDir));
      strictEqual(wrote.status, 0, wrote.stderr);
      match(wrote.stderr, /is its engineer's operation now/);
      deepStrictEqual(f.records(), [`${m.operation_id}.json`]);
      strictEqual((await f.subtask()).status, 'in_progress');
      // The verb's last write ends it: the record goes with the entry.
      const fin = f.finishVerb(child.path, child.opDir);
      strictEqual(fin.status, 0, fin.stderr);
      deepStrictEqual(f.records(), []);
    });
  }
});
