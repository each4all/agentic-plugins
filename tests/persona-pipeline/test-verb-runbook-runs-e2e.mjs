// The verb runbooks' happy path (ADR-0063 S3+S4; ADR-0066 Stage 3, PC3b U4b),
// once per runbook path in every installed shell (bash and, when installed,
// zsh): each persona's six committed verb runbooks, whose finalize settles a
// completed run from the real runner's ledger and makes the terminal write
// with the verb's next step and declared next action. Large tier
// (scripts/data/test-tiers.json): each case starts a real peer run and runs
// the finalize block. The branches and refusals run once, in bash, in
// test-verb-runbook-runs.mjs; the fixture is _verb-runbook-fixture.mjs.

import { describe, it } from 'node:test';
import { rm } from 'node:fs/promises';

import { PERSONAS, SHELLS, VERBS, assertPersonasReached, verbRunbookFixture } from './_verb-runbook-fixture.mjs';

describe('the verb runbook happy paths reach every persona and shell (guards a vacuous pass)', () => {
  it('the personas the verb regions are generated into are the personas on disk, and bash is installed', () => {
    assertPersonasReached();
    if (!SHELLS.includes('bash')) throw new Error('bash is not installed');
  });
});

for (const persona of PERSONAS) {
  const fx = await verbRunbookFixture(persona);
  for (const shell of SHELLS) {
    describe(`${persona}: verb runbook happy path (${shell}, committed)`, () => {
      for (const verb of VERBS) {
        it(`${verb}'s finalize: a completed run records the synthesis verdict, and the terminal write names the verb's next step and next action`, async () => {
          const companions = await fx.stubCompanions();
          try {
            await fx.withRepo(async (dir) => {
              // A value an earlier shell left is not what the block reads.
              await fx.completedFinalize(shell, dir, fx.committed, verb, companions, { ACTIVE: '/w/stale.md', RUN_ID: 'stale', VERDICT: 'stale' });
            });
          } finally {
            await rm(companions, { recursive: true, force: true });
          }
        });
      }
    });
  }
}
