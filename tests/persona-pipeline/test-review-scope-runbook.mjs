// C120 — the review-scope blocks of the critique and refine runbooks, for
// every persona: the regions hold the blocks the cycle runs, a close whose
// findings file was never written records nothing and does not stop the
// critique, and an older state.mjs without the subcommands, or a HEAD git
// cannot read, falls back instead of stopping the verb. Each branch runs
// once, in bash; the happy cycle runs per installed shell in
// test-review-scope-runbook-e2e.mjs (large tier). The blocks are read from
// each persona's committed runbook (_review-scope-runbook-fixture.mjs).

for (const name of Object.keys(process.env)) if (name.startsWith('AGENTIC_')) delete process.env[name];

import { describe, it } from 'node:test';
import { ok, strictEqual, match } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { tmpDir } from '../_tmp.mjs';
import { personasFor } from './_personas.mjs';
import { shellBlocks } from './_verb-runbooks.mjs';
import { GIT_ENV, baseEnv, documentRepo, git, region, reviewScopeBlocks } from './_review-scope-runbook-fixture.mjs';

// The in-process state calls (documentRepo, openCritiqueScope) run git with
// this process's environment: the caller's GIT_* (a hook's GIT_DIR, a bad
// GIT_CONFIG_COUNT) would point them elsewhere, so they get the fixture's.
for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
Object.assign(process.env, GIT_ENV);

for (const persona of personasFor('scripts/lib/review-scope.mjs')) {
  const B = await reviewScopeBlocks(persona);
  const { critique, refine } = B;
  const { runInCommandDirectory } = await import(pathToFileURL(B.P.path('scripts/lib/state-root.mjs')).href);

  describe(`${persona}: the review-scope runbook blocks, run (C120)`, () => {
    it('each region holds the blocks the cycle runs, and no other', () => {
      strictEqual(shellBlocks(region(critique, 'critique-scope-prepare')).length, 1);
      strictEqual(shellBlocks(region(critique, 'critique-scope-close')).length, 1);
      strictEqual(shellBlocks(region(refine, 'refine-scope-record')).length, 2);
      ok(critique.indexOf('pipeline:begin critique-scope-prepare') < critique.indexOf('pipeline:begin critique-dispatch'), 'the scope opens before the dispatch');
      ok(critique.indexOf('pipeline:begin critique-scope-close') < critique.indexOf('pipeline:begin critique-finalize'), 'the close comes before Phase 2');
      ok(refine.indexOf('pipeline:begin refine-scope-record') < refine.indexOf('pipeline:begin refine-dispatch'), 'the record comes before Refine-verify');
    });

    it('bash: a close whose findings file was never written records nothing and does not stop the critique', async (t) => {
      const dir = realpathSync(tmpDir(t, `${persona} review scope unwritten `));
      const top = join(dir, 'the repo');
      const filePath = await documentRepo(B.state, dir, top);
      // A critique opened, in process: the block names its real ledger and
      // generation, which the refusal leaves open and unchanged.
      const scope = await runInCommandDirectory(top, () => B.state.openCritiqueScope({ workflowPath: filePath, repoRoot: top }));
      strictEqual(scope.recorded, true, scope.reason);
      const reviews = join(dirname(dirname(filePath)), 'reviews');
      const ledgerFile = join(reviews, readdirSync(reviews).find((f) => f.endsWith('.json')));
      const before = readFileSync(ledgerFile, 'utf8');
      const texts = join(dir, 'agent text');
      mkdirSync(texts);
      const r = spawnSync('bash', ['-c', B.close(texts, scope.generation, scope.ledger)], { cwd: top, encoding: 'utf8', env: { ...baseEnv(), [B.ROOT_ENV]: B.P.root, ACTIVE: filePath } });
      strictEqual(r.status, 0, r.stderr);
      match(r.stderr, /findings\.json.*not a readable JSON file/);
      strictEqual(JSON.parse(r.stdout).closed, false);
      strictEqual(readFileSync(ledgerFile, 'utf8'), before, 'the open critique is left as it was');
    });

    it('bash: an older state.mjs without the subcommands falls back, never stops the verb', (t) => {
      const dir = realpathSync(tmpDir(t, `${persona} review scope old `));
      // The plugin root an older release installed: its state.mjs answers
      // every new subcommand as unknown, exit 2.
      const oldRoot = join(dir, 'old root');
      mkdirSync(join(oldRoot, 'scripts'), { recursive: true });
      writeFileSync(join(oldRoot, 'scripts', 'state.mjs'), "process.stderr.write(`unknown subcommand ${process.argv[2]}\\n`); process.exit(2);\n");
      const top = join(dir, 'the repo');
      git(dir, 'init', '-q', '-b', 'feat/doc', top);
      const texts = join(dir, 'agent text');
      mkdirSync(texts);
      writeFileSync(join(texts, 'targets.txt'), 'G1-F1\n');
      const LEDGER = '0123456789abcdef';
      const run = (block) => spawnSync('bash', ['-c', block], { cwd: top, encoding: 'utf8', env: { ...baseEnv(), [B.ROOT_ENV]: oldRoot, ACTIVE: join(dir, 'wf.md') } });
      for (const [block, field, value] of [
        [B.prepare(), 'recorded', false],
        [B.status, 'ledger', false],
        [B.record(texts), 'recorded', false],
        [B.close(texts, 1, LEDGER), 'closed', false],
      ]) {
        const r = run(block);
        strictEqual(r.status, 0, r.stderr);
        match(r.stderr, /unknown subcommand/);
        strictEqual(JSON.parse(r.stdout)[field], value);
      }
      strictEqual(JSON.parse(run(B.record(texts)).stdout).verify.mode, 'full');
      // A HEAD git cannot read: the blocks still reach the script, and it
      // falls back.
      writeFileSync(join(top, '.git', 'HEAD'), 'not a ref\n');
      const broken = (block) => spawnSync('bash', ['-c', block], { cwd: top, encoding: 'utf8', env: { ...baseEnv(), [B.ROOT_ENV]: B.P.root, ACTIVE: join(dir, 'wf.md') } });
      for (const block of [B.prepare(), B.record(texts)]) {
        const r = broken(block);
        strictEqual(r.status, 0, r.stderr);
        strictEqual(JSON.parse(r.stdout).recorded, false);
      }
    });
  });
}
