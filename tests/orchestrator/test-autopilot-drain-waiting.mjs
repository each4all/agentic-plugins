// tests/orchestrator/test-autopilot-drain-waiting.mjs
//
// ADR-0067 Decision 7, docket C128 — what a run's looks leave waiting to land
// (plugins/orchestrator/adapters/claude/autopilot/scheduler.mjs
// `reconcileWaiting`, `endedUnlooked`, `landingFactsOf`) and what a serial
// run's halt lists (driver.mjs `withLanding`), on hand-built views. The driven
// cases (a failed look, a look that cannot read the macro, an interrupt, an
// error, the end's own look) are in test-autopilot-scheduler.mjs.

import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AP = resolve(fileURLToPath(import.meta.url), '../../../plugins/orchestrator/adapters/claude/autopilot');
const { endedUnlooked, landingFactsOf, reconcileWaiting } = await import(resolve(AP, 'scheduler.mjs'));
const { withLanding } = await import(resolve(AP, 'driver.mjs'));

// Each ready with a pull request open, so its sync carries the push.
const ready = (id, commit = null) => ({ subtaskId: id, branch: `feat/${id}`, ...(commit ? { commit } : {}), sync: { state: 'ready', base_commit: 'b'.repeat(40), detail: null, commands: [`git push origin feat/${id}`], note: null } });
const states = (list) => list.map((w) => [w.subtaskId, w.sync?.state, w.sync?.detail]);

describe('reconcileWaiting', () => {
  it('a drain\'s last look keeps what it could not read, unknown, and lets go of what it read as no longer waiting', () => {
    const archived = (current_phase = 'commit-complete') => ({ location: 'archived', current_phase });
    const view = {
      macro: { fm: { plan: { subtasks: [
        { id: 'A', status: 'in_progress' }, { id: 'B', status: 'in_progress' }, { id: 'C', status: 'completed' },
        { id: 'D', status: 'in_progress' }, { id: 'G', status: 'in_progress' }, { id: 'H', status: 'in_progress' },
        { id: 'K', status: 'in_progress' },
      ] } } },
      // next-ready failed, and the look still read every subtask.
      readyError: 'next-ready failed',
      children: {
        A: archived(), B: { location: 'error', detail: 'bad file' }, D: archived(), G: { location: 'active' },
        H: archived(), K: archived('close-complete'),
      },
      // A's check failed; H's refused (no answer either way); D's merged; K
      // closed with no commit, so it has none.
      landing: { A: { error: 'gh timed out' }, D: { ok: true }, H: { ok: false, reason: 'gh_unavailable', detail: 'gh: not logged in' } },
    };
    const found = [ready('E'), { subtaskId: 'F', branch: 'feat/F', sync: null }];
    const out = reconcileWaiting(['A', 'B', 'C', 'D', 'G', 'H', 'K', 'E'].map((id) => ready(id)), view, found);
    deepStrictEqual(states(out), [
      ['E', 'ready', null],
      ['F', 'unknown', "the run's last look failed (its landing report did not complete)"],
      ['A', 'unknown', "the run's last look failed (subtask A's landing could not be checked (gh timed out))"],
      ['B', 'unknown', "the run's last look failed (subtask B's engineer workflow could not be read (bad file))"],
      ['H', 'unknown', "the run's last look failed (subtask H's landing check answered gh_unavailable (gh: not logged in))"],
    ]);
    deepStrictEqual(out[2].sync, { state: 'unknown', base_commit: 'b'.repeat(40), detail: out[2].sync.detail, commands: [], note: null }, 'the tip it was judged against stays, its commands go');
    // A failed look keeps every lane that waited.
    deepStrictEqual(states(reconcileWaiting([ready('A'), { subtaskId: 'B', branch: 'feat/B' }], { lookError: 'no git' }, [])), [
      ['A', 'unknown', "the run's last look failed (no git)"], ['B', 'unknown', "the run's last look failed (no git)"],
    ]);
  });

  it('a look that did not fetch adds nothing to a freshness at the same commit, and judges a new commit unknown', () => {
    const view = { macro: { fm: { plan: { subtasks: [{ id: 'A', status: 'in_progress' }, { id: 'B', status: 'in_progress' }] } } } };
    const withheld = (id, commit) => ({ subtaskId: id, branch: `feat/${id}`, commit, withheld: true, sync: { state: 'unknown', base_commit: 'b'.repeat(40), detail: 'origin/main was not fetched in this look', commands: [], note: null } });
    const out = reconcileWaiting([ready('A', 'a1'), ready('B', 'b1')], view, [withheld('A', 'a1'), withheld('B', 'b2')]);
    deepStrictEqual(states(out), [['A', 'ready', null], ['B', 'unknown', 'origin/main was not fetched in this look']]);
    deepStrictEqual(out[0].sync.commands, ['git push origin feat/A'], 'the freshness it had, whole');
    strictEqual(out.some((w) => 'withheld' in w), false, 'the mark stays with the report');
  });

  it('a look with no report of its own keeps each entry as listed, lists a new one unknown, and still lets go of one it reads as landed', () => {
    const view = {
      macro: { fm: { plan: { subtasks: [{ id: 'A', status: 'in_progress' }, { id: 'B', status: 'in_progress' }, { id: 'D', status: 'in_progress' }] } } },
      children: { D: { location: 'archived', current_phase: 'commit-complete' } }, landing: { D: { ok: true } },
    };
    const a = { ...ready('A', 'a1'), sync: { state: 'unknown', base_commit: null, detail: "the run's last look failed (x)", commands: [], note: null } };
    const out = reconcileWaiting([a, ready('D', 'd1')], view, [{ subtaskId: 'A', branch: 'feat/A', unreported: true }, { subtaskId: 'B', branch: 'feat/B', unreported: true }]);
    deepStrictEqual(out, [a, { subtaskId: 'B', branch: 'feat/B', sync: { state: 'unknown', base_commit: null, detail: 'no report was made for the look that found it', commands: [], note: null } }]);
  });

  // C128, the A-lands-then-B sequence: B was judged ready against the tip
  // before A landed, and a look that did not fetch cannot judge it again.
  it('a look that did not fetch keeps no ready past a landing it saw, and a needs-sync stands', () => {
    const subtasks = (...ids) => ids.map((id) => (id === 'C' ? { id, status: 'completed', commit: 'c'.repeat(40) } : { id, status: 'in_progress' }));
    const merged = { children: { A: { location: 'archived', current_phase: 'commit-complete' } }, landing: { A: { ok: true } } };
    const behind = { subtaskId: 'E', branch: 'feat/E', commit: 'e1', sync: { state: 'needs-sync', base_commit: 'b'.repeat(40), detail: 'it does not contain origin/main at bbbbbbb', commands: ['git -C wt merge origin/main'], note: null } };
    const withheld = (id, commit) => ({ subtaskId: id, branch: `feat/${id}`, commit, withheld: true, sync: { state: 'unknown', base_commit: 'b'.repeat(40), detail: 'origin/main was not fetched in this look', commands: [], note: null } });
    const one = 'subtask A landed after the look that judged it ready, and this look did not fetch';

    // No report of its own (the end's look): B's ready goes, E's needs-sync stays.
    const unreported = reconcileWaiting([ready('A', 'a1'), ready('B', 'b1'), behind], { macro: { fm: { plan: { subtasks: subtasks('A', 'B', 'E') } } }, ...merged },
      [{ subtaskId: 'B', branch: 'feat/B', unreported: true }, { subtaskId: 'E', branch: 'feat/E', unreported: true }]);
    deepStrictEqual(states(unreported), [['B', 'unknown', one], ['E', 'needs-sync', behind.sync.detail]]);
    deepStrictEqual([unreported[0].commit, unreported[0].sync.base_commit, unreported[0].sync.commands], ['b1', 'b'.repeat(40), []], 'the tip it was judged against stays, its commands go');
    deepStrictEqual(unreported[1], behind, 'needs-sync, whole');

    // A report that did not fetch withholds B at the same commit: no ready either.
    const unfetched = reconcileWaiting([ready('A', 'a1'), ready('B', 'b1')], { macro: { fm: { plan: { subtasks: subtasks('A', 'B') } } }, ...merged }, [withheld('B', 'b1')]);
    deepStrictEqual(states(unfetched), [['B', 'unknown', one]]);

    // A waiting lane that leaves recorded completed with its commit lands too,
    // and every landing is named.
    const two = reconcileWaiting([ready('A', 'a1'), ready('C', 'c1'), ready('B', 'b1')], { macro: { fm: { plan: { subtasks: subtasks('A', 'B', 'C') } } }, ...merged },
      [{ subtaskId: 'B', branch: 'feat/B', unreported: true }]);
    deepStrictEqual(states(two), [['B', 'unknown', 'subtasks A, C landed after the look that judged it ready, and this look did not fetch']]);

    // A merged pull request the list never held (its landing check failed
    // until this look) is a landing all the same.
    const unlisted = reconcileWaiting([ready('B', 'b1')], { macro: { fm: { plan: { subtasks: subtasks('A', 'B') } } }, ...merged },
      [{ subtaskId: 'B', branch: 'feat/B', unreported: true }]);
    deepStrictEqual(states(unlisted), [['B', 'unknown', one]]);

    // Controls: a lane that stops waiting without landing (a new attempt, a
    // completion with no commit), a completion the list did not hold (landed
    // before the look that judged it), or a fetched report, leaves the ready
    // as judged.
    const again = reconcileWaiting([ready('A', 'a1'), ready('B', 'b1')], { macro: { fm: { plan: { subtasks: subtasks('A', 'B') } } }, children: { A: { location: 'active' } } },
      [{ subtaskId: 'B', branch: 'feat/B', unreported: true }]);
    deepStrictEqual(states(again), [['B', 'ready', null]]);
    const noCommit = reconcileWaiting([ready('A', 'a1'), ready('B', 'b1')], { macro: { fm: { plan: { subtasks: [{ id: 'A', status: 'completed' }, { id: 'B', status: 'in_progress' }] } } } },
      [{ subtaskId: 'B', branch: 'feat/B', unreported: true }]);
    deepStrictEqual(states(noCommit), [['B', 'ready', null]]);
    const earlier = reconcileWaiting([ready('B', 'b1')], { macro: { fm: { plan: { subtasks: subtasks('B', 'C') } } } },
      [{ subtaskId: 'B', branch: 'feat/B', unreported: true }]);
    deepStrictEqual(states(earlier), [['B', 'ready', null]]);
    const fetched = reconcileWaiting([ready('A', 'a1'), ready('B', 'b1')], { macro: { fm: { plan: { subtasks: subtasks('A', 'B') } } }, ...merged }, [ready('B', 'b1')]);
    deepStrictEqual(states(fetched), [['B', 'ready', null]]);
  });
});

describe('endedUnlooked', () => {
  it('a run that ends without its last look confirms nothing it lists', () => {
    const out = endedUnlooked([ready('A'), { subtaskId: 'B', branch: 'feat/B', sync: null }], 'the owner interrupted the run');
    deepStrictEqual(states(out), [
      ['A', 'unknown', 'the run ended before its last look (the owner interrupted the run)'],
      ['B', 'unknown', 'the run ended before its last look (the owner interrupted the run)'],
    ]);
    deepStrictEqual(out[0].sync, { state: 'unknown', base_commit: 'b'.repeat(40), detail: out[0].sync.detail, commands: [], note: null });
  });
});

describe('landingFactsOf', () => {
  it('each waiting subtask takes the commit, freshness and overlap the report found, its withheld mark included; one it does not list takes none', () => {
    const overlap = { base: { ref: 'refs/remotes/origin/main', clean: true }, pairs: [] };
    const report = { entries: [{ subtaskId: 'A', commit: 'a1', sync: { state: 'unknown' }, withheld: true }, { subtaskId: 'B', commit: 'b1', sync: { state: 'ready' }, overlap, withheld: false }] };
    deepStrictEqual(landingFactsOf([{ subtaskId: 'A' }, { subtaskId: 'B' }, { subtaskId: 'C' }], report), [
      { subtaskId: 'A', commit: 'a1', sync: { state: 'unknown' }, withheld: true },
      { subtaskId: 'B', commit: 'b1', sync: { state: 'ready' }, overlap },
      { subtaskId: 'C', commit: null, sync: null },
    ]);
    deepStrictEqual(landingFactsOf([{ subtaskId: 'A' }], null), [{ subtaskId: 'A' }], 'no report, no facts');
  });
});

describe('withLanding', () => {
  const report = { integration: 'main', mergeOrder: [{ subtaskId: 'A', branch: 'feat/A', rebaseAfter: [] }], entries: [{ subtaskId: 'A', commit: 'a1', sync: ready('A').sync, overlap: null }] };
  it('a serial run\'s halt for any reason lists what its looks found waiting', () => {
    const d = withLanding({ reason: 'no-progress', detail: 'nothing changed' }, report, [ready('A', 'a1')]);
    deepStrictEqual([d.waiting.map((w) => [w.subtaskId, w.sync.state]), d.integration, d.mergeOrder], [[['A', 'ready']], 'main', report.mergeOrder]);
    deepStrictEqual(withLanding({ reason: 'budget', detail: 'spent' }, report, []), { reason: 'budget', detail: 'spent' }, 'nothing waits, nothing added');
  });
  it('an awaiting-landing halt lists the run\'s list as its end left it, not the list of the look that decided it', () => {
    // The decision's look listed A and B ready; as the run ended, A landed
    // and B's freshness could not be confirmed.
    const decided = { reason: 'awaiting-landing', detail: 'x', waiting: [ready('A', 'a1'), ready('B', 'b1')] };
    const b = endedUnlooked([ready('B', 'b1')], 'the owner interrupted the run');
    const d = withLanding(decided, report, b);
    deepStrictEqual(states(d.waiting), [['B', 'unknown', 'the run ended before its last look (the owner interrupted the run)']]);
    deepStrictEqual([d.integration, d.mergeOrder], ['main', report.mergeOrder]);
    deepStrictEqual(withLanding(decided, null, []).waiting, [], 'every branch landed: the halt lists none');
  });
  it('an awaiting-landing halt whose report failed lists each branch unknown, never as if ready', () => {
    const view = { macro: { fm: { plan: { subtasks: [{ id: 'A', status: 'in_progress' }] } } } };
    const list = reconcileWaiting([], view, landingFactsOf([{ subtaskId: 'A', branch: 'feat/A' }], { entries: [] }));
    const d = withLanding({ reason: 'awaiting-landing', detail: 'x', waiting: [{ subtaskId: 'A', branch: 'feat/A' }] }, null, list);
    deepStrictEqual(states(d.waiting), [['A', 'unknown', "the run's last look failed (its landing report did not complete)"]]);
    strictEqual(d.integration, undefined);
  });
});
