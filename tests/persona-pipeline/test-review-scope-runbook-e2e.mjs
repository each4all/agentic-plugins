// C120 — the review-scope runbook path end to end, run as written in bash and
// (when installed) zsh, for every persona: a full critique opened and closed,
// a refine's ledger read and record, then a scoped critique, against a real
// repository whose path and text directories hold a space. Large tier
// (scripts/data/test-tiers.json); the regions, the refusal and the fallbacks
// run once, in bash, in test-review-scope-runbook.mjs.

for (const name of Object.keys(process.env)) if (name.startsWith('AGENTIC_')) delete process.env[name];

import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, match } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tmpDir } from '../_tmp.mjs';
import { personasFor } from './_personas.mjs';
import { SHELLS, baseEnv, documentRepo, reviewScopeBlocks } from './_review-scope-runbook-fixture.mjs';

for (const persona of personasFor('scripts/lib/review-scope.mjs')) {
  const B = await reviewScopeBlocks(persona);

  describe(`${persona}: the review-scope runbook path, end to end (C120)`, () => {
    for (const shell of SHELLS) {
      it(`${shell}: full critique, refine read and record, scoped critique`, async (t) => {
        const dir = realpathSync(tmpDir(t, `${persona} review scope `));
        const top = join(dir, 'the repo');
        const filePath = await documentRepo(B.state, dir, top);
        const texts = join(dir, 'agent text');
        mkdirSync(texts);
        const run = (block) => spawnSync(shell, ['-c', block], { cwd: top, encoding: 'utf8', env: { ...baseEnv(), [B.ROOT_ENV]: B.P.root, ACTIVE: filePath } });
        const ok0 = (r) => {
          strictEqual(r.status, 0, r.stderr);
          return JSON.parse(r.stdout);
        };

        const first = ok0(run(B.prepare()));
        strictEqual(first.mode, 'full');
        strictEqual(first.generation, 1);
        const LEDGER = first.ledger;
        match(LEDGER, /^[0-9a-f]{16}$/);

        writeFileSync(join(texts, 'findings.json'), `${JSON.stringify({ findings: [
          { id: 'NEW', severity: 'MAJOR', location: 'docs/adr.md:5', text: "a 'quoted' $(not run) finding" },
        ] })}\n`);
        const closed = ok0(run(B.close(texts, 1, LEDGER)));
        deepStrictEqual(closed.carry, ['G1-F1']);

        const before = ok0(run(B.status));
        deepStrictEqual(before.carry, ['G1-F1']);
        deepStrictEqual(before.recurring, []);

        writeFileSync(join(top, 'docs', 'adr.md'), '# A\n\nContext.\n\nDecision, revised.\n\nConsequences.\n');
        writeFileSync(join(texts, 'targets.txt'), 'G1-F1\n');
        const attempt = ok0(run(B.record(texts)));
        strictEqual(attempt.attempt, 'R1');
        deepStrictEqual(attempt.verify, { mode: 'scoped', reason: 'scoped' }, 'Refine-verify may be scoped');

        const second = ok0(run(B.prepare()));
        strictEqual(second.mode, 'scoped', second.reason);
        deepStrictEqual(second.targets, ['G1-F1']);
        deepStrictEqual(second.passages.map((p) => [p.path, p.start, p.end]), [['docs/adr.md', 5, 5]]);
      });
    }
  });
}
