// tests/orchestrator/test-autopilot-stall-sampler.mjs
//
// ADR-0068 Decision 3, item 6 — the run's sampler of the process table
// (plugins/orchestrator/adapters/claude/autopilot/stall-sampler.mjs): one read
// per tick for every registered worker, each judging its own tree; a read that
// never settles, a late answer, a read that throws, and a worker unregistered
// while a read is in flight. The worker's watch: test-autopilot-worker.mjs.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const S = await import(resolve(AP, 'stall.mjs'));
const SM = await import(resolve(AP, 'stall-sampler.mjs'));
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
const table = (procs = []) => ({ ok: true, procs, unreadable: [], exited: [], resolutionMs: 10 });

describe('the run\'s sampler (Decision 3, item 6; §Consequences)', () => {
  it('one read per tick for every registered worker, each judging its own tree', async () => {
    let reads = 0;
    const snap = table([
      { pid: 11, ppid: 10, pgid: 10, key: '11@a', ageMs: 0, cpuMs: 0 }, // worker 10's busy child
      { pid: 21, ppid: 20, pgid: 20, key: '21@a', ageMs: 0, cpuMs: 0 }, // worker 20's idle child
      { pid: 31, ppid: 30, pgid: 30, key: '31@a', ageMs: 0, cpuMs: 100 }, // worker 30's, its counter going back later
    ]);
    let n = 0;
    // 31's counter goes back every other tick from the fourth: worker 30's
    // unknown only (an unreadable pid would be every worker's, stall.mjs
    // membersOf).
    const back = () => n > 3 && n % 2 === 0;
    const sampler = SM.createStallSampler({
      intervalMs: 20, deadlineMs: 15,
      readTable: async () => {
        reads += 1;
        n += 1;
        const procs = snap.procs.map((p) => (p.pid === 11 ? { ...p, cpuMs: n * 50 } : p.pid === 31 && back() ? { ...p, cpuMs: 0 } : p));
        return { ...snap, procs };
      },
    });
    const got = { 10: [], 20: [], 30: [] };
    const regs = [10, 20, 30].map((pid) => sampler.register((s, m, w) => got[pid].push(s)));
    await pause(130);
    for (const r of regs) r.unregister();
    strictEqual(sampler.size, 0);
    const ticks = got[10].length;
    ok(ticks >= 3, `ticks ${ticks}`);
    strictEqual(reads, ticks, 'one read per tick, not one per worker');
    ok(got[20].every((s, i) => s === got[10][i]), 'the same snapshot for each');
    // The same snapshots, judged per worker.
    const verdictOf = (pid) => {
      const d = S.createStallDetector({ workerPid: pid, startMono: 0, startWall: 0, windowMs: 300, intervalMs: 100, cpuThresholdMs: 10 });
      let v = null;
      got[10].forEach((s, i) => { v = d.observeSample(s, (i + 1) * 100, (i + 1) * 100)?.verdict ?? v; });
      return d.verdict;
    };
    strictEqual(verdictOf(10), 'active');
    strictEqual(verdictOf(20), 'stalled');
    strictEqual(verdictOf(30), 'unknown');
  });

  it('a read that never settles is a timeout, then every tick it still runs is slow; no second read starts', async () => {
    let reads = 0;
    const sampler = SM.createStallSampler({ intervalMs: 20, deadlineMs: 10, readTable: () => { reads += 1; return new Promise(() => {}); } });
    const got = [];
    const reg = sampler.register((s) => got.push(s.why));
    await pause(120);
    reg.unregister();
    strictEqual(reads, 1);
    strictEqual(got[0], 'timeout');
    ok(got.length >= 3 && got.slice(1).every((w) => w === 'slow'), got.join(','));
  });

  it('a late answer is dropped, and a read that throws is a failed sample', async () => {
    let resolveLate;
    let calls = 0;
    const sampler = SM.createStallSampler({
      intervalMs: 30, deadlineMs: 10,
      readTable: () => {
        calls += 1;
        if (calls === 1) return new Promise((r) => { resolveLate = r; });
        throw new Error('no ps');
      },
    });
    const got = [];
    const reg = sampler.register((s) => got.push(s.ok ? 'ok' : s.why));
    await pause(45);
    resolveLate(table());
    await pause(40);
    reg.unregister();
    strictEqual(got[0], 'timeout');
    ok(!got.includes('ok'), `the late answer reached nobody: ${got.join(',')}`);
    ok(got.includes('failed'), got.join(','));
  });

  it('a worker unregistered while a read is in flight gets nothing from it', async () => {
    let release;
    const sampler = SM.createStallSampler({ intervalMs: 20, deadlineMs: 1000, readTable: () => new Promise((r) => { release = r; }) });
    const got = [];
    const reg = sampler.register((s) => got.push(s));
    await pause(30);
    reg.unregister();
    release(table());
    await pause(10);
    deepStrictEqual(got, []);
  });

  it('a listener that throws is passed over; the others still get the sample', async () => {
    const sampler = SM.createStallSampler({ intervalMs: 20, readTable: async () => table() });
    const got = [];
    const a = sampler.register(() => { throw new Error('x'); });
    const b = sampler.register((s) => got.push(s));
    await pause(50);
    a.unregister();
    b.unregister();
    ok(got.length >= 1);
  });
});
