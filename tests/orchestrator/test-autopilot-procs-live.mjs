// tests/orchestrator/test-autopilot-procs-live.mjs
//
// ADR-0068 Decision 3 — the stall watch's process table
// (plugins/orchestrator/adapters/claude/autopilot/procs.mjs) read from this
// machine's real one. A large-tier test (scripts/data/test-tiers.json): it
// lists every process of the machine within the read's deadline, which a pool
// that keeps every CPU busy can make it miss, so it runs in npm test's
// low-concurrency pass. The parsers, on fixed tables:
// tests/orchestrator/test-autopilot-procs.mjs.

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const P = await import(resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/procs.mjs'));

describe('readProcessTable on this machine', () => {
  it('reads this machine\'s table when it is macOS', { skip: process.platform !== 'darwin' }, async () => {
    const r = await P.readProcessTable();
    strictEqual(r.ok, true);
    ok(r.procs.some((p) => p.pid === process.pid), 'this process is listed');
  });
});
