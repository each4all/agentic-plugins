// tests/orchestrator/test-autopilot-worker-stall-e2e.mjs
//
// ADR-0068 Decision 3 — the stall watch end to end: a real descendant of the
// fake `claude` (tests/orchestrator/fixtures/autopilot-fake-claude.mjs,
// FAKE_BUSY_CHILD) burns CPU while the step's stream stays quiet, and the
// worker host (plugins/orchestrator/adapters/claude/autopilot/worker.mjs),
// sampling the machine's real process table through the run's sampler
// (stall-sampler.mjs), judges the step active.
//
// A large-tier test (scripts/data/test-tiers.json): it reads the whole process
// table and measures real CPU time, so it runs in npm test's low-concurrency
// pass. One read of the table takes about 200 ms with a thousand processes, so
// the sampler and the detector run each second, and the step stays quiet past
// the five-second window long enough for several windows to be judged on known
// samples. The rest of the watch, on a fake sampler and a clock the test
// moves: tests/orchestrator/test-autopilot-worker.mjs.

import { describe, it } from 'node:test';
import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPid } from '../_pidfile.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const W = await import(resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/worker.mjs'));
const SM = await import(resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/stall-sampler.mjs'));
const FAKE = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-fake-claude.mjs');
chmodSync(FAKE, 0o755);

const RUN = 'autopilot-20261001T000000Z-123456';
const ROOTS = { orchestrator: '/roots/orchestrator', engineer: '/roots/engineer', runtime: '/roots/runtime' };

// The values together: a sample and a judgment each second, a five-second
// window, and a quiet stream of twelve seconds, so the windows from the fifth
// second on are judged on the CPU the samples saw; the step's own bound is far
// past the stream's end.
const INTERVAL_MS = 1000;
const WINDOW_MS = 5000;
const CPU_THRESHOLD_MS = 100;
const QUIET_MS = 12_000;
const STEP_TIMEOUT_SEC = 60;

describe('the stall watch on the real process table', () => {
  it('a real descendant that burns CPU keeps a quiet step active (the probe and the tree, end to end)', { skip: !['darwin', 'linux'].includes(process.platform) }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-stall-busy-'));
    const pidfile = join(dir, 'busy.pid');
    const sampler = SM.createStallSampler({ intervalMs: INTERVAL_MS });
    const records = [];
    try {
      const h = W.startWorker({
        cwd: dir, prompt: 'x', stepKind: 'verb', runId: RUN, seq: 1, roots: ROOTS, stepBudgetUsd: 1, stepTimeoutSec: STEP_TIMEOUT_SEC,
        rawPath: join(dir, 'w.jsonl'),
        env: { ...process.env, AUTOPILOT_CLAUDE_BIN: FAKE, FAKE_CLAUDE_MODE: 'events', FAKE_CLAUDE_PIDFILE: pidfile, FAKE_EVENTS: JSON.stringify([{ delay: QUIET_MS, event: { result: null } }]), FAKE_BUSY_CHILD: '1' },
        stall: { mode: 'on', sampler, detector: { windowMs: WINDOW_MS, intervalMs: INTERVAL_MS, cpuThresholdMs: CPU_THRESHOLD_MS } }, onStall: (r) => records.push(r),
      });
      h.begin();
      const w = await h.done;
      strictEqual(w.aborted, null, `a busy child is activity: ${JSON.stringify(records)}`);
      deepStrictEqual(records.filter((r) => r.verdict === 'stalled'), []);
      // A full window judged on known samples: the summary keeps a window's CPU
      // only for one with no unknown interval in it.
      notStrictEqual(w.stall.summary.lowest_window_cpu_ms, null, `no full window was judged on known samples: ${JSON.stringify(w.stall.summary)}`);
      ok(w.stall.summary.lowest_window_cpu_ms >= CPU_THRESHOLD_MS, JSON.stringify(w.stall.summary));
    } finally {
      sampler.stop();
      const pid = readPid(pidfile);
      if (pid !== null) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
