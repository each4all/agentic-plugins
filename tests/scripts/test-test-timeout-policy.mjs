// Guard meta-test for the suite-wide --test-timeout policy (2026-07-11 hang).
//
// The intermittent claude-tests hang left the whole job silent for its full
// 30-minute limit because nothing bounded an individual test: node's default
// per-test timeout is Infinity, the workflow steps had no timeout-minutes,
// and an orphaned pending promise kept the file process alive through
// node:test's exit keep-alive. Defense layer F1 pins --test-timeout=120000
// into every npm test script; this file keeps that pin from silently
// regressing and proves the flag actually converts the observed hang shape
// into a bounded failure.
//
// Invariants:
//   (i)  Every node --test script in package.json carries --test-timeout,
//        placed BEFORE the first positional path (Node 24 parses a flag after
//        a positional as a test argument, silently dropping the bound).
//   (ii) An orphaned-pending-promise test (zero live handles, never settles —
//        the exact 2026-07-11 hang shape) exits nonzero within the bound
//        instead of hanging, and reports the timeout in its output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const TIMEOUT_FLAG = /--test-timeout=(\d+)/;

// The CI-gated suites that must stay bounded. test:smoke is deliberately
// absent: it is opt-in and host-CLI-bound, not a CI hang surface.
const BOUNDED_SCRIPTS = ['test', 'test:plugin-shape', 'test:cross-host'];

test('every CI-gated node --test script pins --test-timeout before its first test path', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  for (const name of BOUNDED_SCRIPTS) {
    const cmd = pkg.scripts[name];
    assert.ok(typeof cmd === 'string' && cmd.includes('node --test'),
      `scripts.${name} must exist and invoke node --test (it is a named CI hang surface)`);
    const match = cmd.match(TIMEOUT_FLAG);
    assert.ok(match, `scripts.${name} must carry --test-timeout (F1 hang defense)`);
    const value = Number(match[1]);
    assert.ok(value >= 60_000 && value <= 300_000,
      `scripts.${name} --test-timeout must stay within [60s, 300s] — below leaves no headroom over `
        + `the slowest real test, above stops converting hangs into fast failures (got ${value})`);
    const firstPath = cmd.search(/ (?:\.\/)?(?:tests|companions|kit)\//);
    if (name !== 'test') {
      // Curated-list scripts must actually match the path probe: a spelling
      // this regex cannot see (e.g. a new root) would otherwise skip the
      // ordering assertion entirely and let a late flag slip through.
      assert.notEqual(firstPath, -1,
        `scripts.${name} lists no recognizable test path — extend the path probe in this guard`);
    }
    if (firstPath !== -1) {
      assert.ok(cmd.indexOf('--test-timeout') < firstPath,
        `scripts.${name}: --test-timeout must precede the first test path — after a positional, `
          + 'Node 24 treats it as a test argument and the bound silently vanishes');
    }
  }
});

test('an orphaned pending promise fails within the bound instead of hanging', () => {
  const fixture = path.join(__dirname, 'fixtures', 'orphaned-pending-promise.mjs');
  // This meta-test itself runs as a node --test child; the inherited
  // NODE_TEST_CONTEXT would make the grandchild runner treat itself as an
  // in-process test file and exit 0 immediately instead of running the
  // fixture. NODE_OPTIONS is scrubbed for the same ambient-env hygiene.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const res = spawnSync(process.execPath, ['--test', '--test-timeout=2000', fixture], {
    encoding: 'utf8',
    env,
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  assert.equal(res.signal, null,
    'the fixture run must terminate on its own — a SIGKILL here means --test-timeout failed to bound the hang');
  assert.notEqual(res.status, 0, 'the timed-out fixture must exit nonzero');
  assert.match(`${res.stdout}\n${res.stderr}`, /test timed out after 2000ms/,
    'the failure must be attributed to the per-test timeout');
});
