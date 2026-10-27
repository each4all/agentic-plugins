// tests/orchestrator/test-autopilot-scheduler-holds.mjs
//
// ADR-0068 Decision 2, items 3 and 4 (impl-hold) — the driver leaves a held
// subtask alone while other lanes go on: never dispatched or stepped; a step
// already running when the hold is set runs to its end, and the run then
// hands the lane over (fenced, acked); a persona operation open in a lane,
// however long it writes nothing, holds its spawn back; holdGate refuses a
// held lane and one whose records cannot be read.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AP, COMMIT, setup, stepsOf } from './fixtures/autopilot-lanes-run.mjs';

const LIB = resolve(AP, '../../../scripts/lib');
const H = await import(pathToFileURL(join(LIB, 'holds.mjs')).href);
const OPS = await import(pathToFileURL(join(LIB, 'hold-ops.mjs')).href);
const RL = await import(pathToFileURL(join(LIB, 'run-locks.mjs')).href);
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });

describe('the driver leaves a held subtask alone (ADR-0068 Decision 2, item 3)', () => {
  it('a subtask held before the run is never dispatched, and its handoff completes; the other lane is stepped', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [COMMIT], file: 'b.txt' } } });
    try {
      const h = await OPS.setHold({ mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', branch: 'feat/a', lane: null, child: null });
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(stepsOf(r).map((s) => [s[3], s[2]]), [['B', 'dispatch'], ['B', 'commit']], t.lines.join('\n'));
      strictEqual(H.holdStateOf(t.work, t.fx.macroId, 'A').state, 'held');
      ok(t.lines.some((l) => l.includes(`lane A: held (hold ${h.hold_id})`)), t.lines.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });

  it('a hold set while the lane\'s step runs lets the step run to its end, then the run hands the lane over, fenced, and steps it no more', async () => {
    const t = await setup({
      scenario: { A: { next: [COMMIT] }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 1: ['mark-start:a-started', 'wait:hold-set'] } },
    });
    try {
      const running = t.run();
      for (let i = 0; i < 600 && !existsSync(join(t.dir, 'a-started')); i += 1) await pause(50);
      ok(existsSync(join(t.dir, 'a-started')), 'A started');
      const h = await OPS.setHold({ mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', branch: 'feat/a', lane: t.lane('A'), child: null });
      strictEqual(H.holdStateOf(t.work, t.fx.macroId, 'A').state, 'pending');
      writeFileSync(join(t.dir, 'hold-set'), '1');
      strictEqual(await running, 2, t.lines.join('\n'));
      const steps = stepsOf(t.latest());
      deepStrictEqual(steps.filter((s) => s[3] === 'A').map((s) => [s[2], s[4]]), [['dispatch', 'ok']], 'the step in flight ran to its end, and nothing after it');
      strictEqual(H.holdStateOf(t.work, t.fx.macroId, 'A').state, 'held');
      strictEqual(RL.fenceState(t.lane('A'), h.hold_id), 'present', 'the lane is fenced');
      ok(steps.some((s) => s[3] === 'B' && s[2] === 'commit'), 'the other lane went on');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a persona operation open in a lane longer than any quiet period holds its spawn back until it closes', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 2: ['mark-start:b-started'] } } });
    try {
      const op = 'op-20261026T000000Z-0000abcd';
      // Published long before the run, never written since.
      H.publishOpRecord(t.work, t.fx.macroId, 'A', { operation_id: op, kind: 'verb' });
      const lines = t.lines.push.bind(t.lines);
      t.lines.push = (line) => {
        if (/lane B/.test(line) && existsSync(join(t.dir, 'b-started'))) {
          try { H.removeOpRecord(t.work, t.fx.macroId, 'A', op); } catch { /* gone */ }
        }
        return lines(line);
      };
      strictEqual(await t.run({}, { wakeIntervalMs: 300, quietMs: 1 }), 2, t.lines.join('\n'));
      const steps = stepsOf(t.latest());
      const firstA = steps.findIndex((s) => s[3] === 'A');
      const firstB = steps.findIndex((s) => s[3] === 'B');
      ok(firstB >= 0 && (firstA < 0 || firstA > firstB), `A waited for its operation: ${JSON.stringify(steps)}`);
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('holdGate (the hold a machine job and each action read)', () => {
  it('refuses a held, pending or unreadable hold, an uncompared or rejected release, and an unreadable holds directory', async () => {
    const t = await setup({ scenario: {} });
    try {
      const M = t.fx.macroId;
      const gate = () => OPS.holdGate({ mainRoot: t.work, macroId: M, subtaskId: 'A' });
      strictEqual(gate(), null);
      const h = await OPS.setHold({ mainRoot: t.work, macroId: M, subtaskId: 'A', branch: 'feat/a' });
      ok(/handoff pending/.test(gate()));
      await OPS.completeHandoff({ mainRoot: t.work, macroId: M, subtaskId: 'A', stateRoots: [t.work] });
      ok(/is held/.test(gate()));
      await OPS.releaseHold({ mainRoot: t.work, macroId: M, subtaskId: 'A', holdId: h.hold_id, stateRoots: [t.work], basisOf: async () => ({ fingerprint_version: 0, fingerprint: '', tree_digest: 't', content_digest: 'c', child: null }) });
      ok(/not compared yet/.test(gate()));
      const rel = H.readRecord(t.work, M, 'releases', 'A');
      H.writeWhole(rel.path, { ...rel.record, state: 'rejected' });
      ok(/rejected/.test(gate()));
      H.writeWhole(rel.path, { ...rel.record, state: 'consumed' });
      strictEqual(gate(), null);
      writeFileSync(H.recordPath(t.work, M, 'holds', 'A'), '{');
      ok(/cannot be read/.test(gate()));
      strictEqual(OPS.holdGate({ mainRoot: t.work, macroId: M, subtaskId: 'B' }), null, 'another subtask is not held');
      const dir = join(H.holdsDir(t.work, M), 'holds');
      H.unlinkQuiet(join(dir, 'A.json'));
      H.unlinkQuiet(join(dir, '.lock'));
      const { rmSync } = await import('node:fs');
      rmSync(dir, { recursive: true, force: true });
      writeFileSync(dir, 'not a directory');
      ok(/cannot be read/.test(OPS.holdGate({ mainRoot: t.work, macroId: M, subtaskId: 'B' })), 'run-wide');
      mkdirSync(join(t.dir, 'unused'), { recursive: true });
    } finally {
      t.fx.cleanup();
    }
  });
});
