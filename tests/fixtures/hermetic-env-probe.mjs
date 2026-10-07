// Fixture for tests/test-hermetic-env.mjs, run by it through `npm test` and
// through a bare `node --test`; its name keeps it out of the suite's own
// discovery. It fails when a variable the parent planted
// (HERMETIC_PROBE_PLANTED) reached this process or a process it spawns, and
// when the opt-in switch did not.

import { it } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const planted = JSON.parse(process.env.HERMETIC_PROBE_PLANTED);

it('this process sees none of the planted session variables', () => {
  deepStrictEqual(planted.filter((name) => name in process.env), []);
});

it('a process it spawns sees none of them either', () => {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))'], { encoding: 'utf8' });
  strictEqual(r.status, 0, r.stderr);
  deepStrictEqual(planted.filter((name) => JSON.parse(r.stdout).includes(name)), []);
});

it('the opt-in switch stays', () => {
  strictEqual(process.env.AGENTIC_EGRESS_REAL_SMOKE, 'kept');
});
