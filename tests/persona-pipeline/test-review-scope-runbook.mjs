// C120 — the review-scope blocks of the critique and refine runbooks, run as
// written in bash and (when installed) zsh, for every persona: a full
// critique opened and closed, a refine's ledger read and record, then a
// scoped critique, against a real repository whose path and text directories
// hold a space; and an older state.mjs without the subcommands, which the
// blocks fall back from instead of stopping the verb. The blocks are read from each persona's committed runbook,
// between its region markers; only the placeholders the agent fills are
// filled, as the agent fills them.

for (const name of Object.keys(process.env)) if (name.startsWith('AGENTIC_')) delete process.env[name];

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual, match } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { personasFor, personaInfo } from './_personas.mjs';
import { shellBlocks } from './_verb-runbooks.mjs';

const SHELLS = ['bash', 'zsh'].filter((sh) => spawnSync(sh, ['-c', 'true']).status === 0);
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
  GIT_AUTHOR_DATE: '2026-10-14T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-14T00:00:00Z',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
const baseEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_') && k !== 'CLAUDE_PLUGIN_ROOT')),
  ...GIT_ENV,
});
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: baseEnv(), stdio: ['ignore', 'pipe', 'pipe'] });

function region(text, id) {
  const begin = `<!-- pipeline:begin ${id} -->`;
  const end = `<!-- pipeline:end ${id} -->`;
  const a = text.indexOf(begin);
  const b = text.indexOf(end);
  ok(a >= 0 && b > a, `the runbook holds the ${id} region`);
  return text.slice(a + begin.length, b);
}

function fill(block, from, to) {
  strictEqual(block.split(from).length, 2, `the block holds ${from} once`);
  return block.replace(from, () => to);
}

for (const persona of personasFor('scripts/lib/review-scope.mjs')) {
  const P = personaInfo(persona);
  const state = await import(pathToFileURL(P.path('scripts/state.mjs')).href);
  const ROOT_ENV = `AGENTIC_${persona.toUpperCase()}_ROOT`;
  const critique = readFileSync(P.path('commands/critique.md'), 'utf8');
  const refine = readFileSync(P.path('commands/refine.md'), 'utf8');
  const [prepare] = shellBlocks(region(critique, 'critique-scope-prepare')).map((b) => b.text);
  const [close] = shellBlocks(region(critique, 'critique-scope-close')).map((b) => b.text);
  const [status, record] = shellBlocks(region(refine, 'refine-scope-record')).map((b) => b.text);

  describe(`${persona}: the review-scope runbook blocks, run (C120)`, () => {
    it('each region holds the blocks the cycle runs, and no other', () => {
      strictEqual(shellBlocks(region(critique, 'critique-scope-prepare')).length, 1);
      strictEqual(shellBlocks(region(critique, 'critique-scope-close')).length, 1);
      strictEqual(shellBlocks(region(refine, 'refine-scope-record')).length, 2);
      ok(critique.indexOf('pipeline:begin critique-scope-prepare') < critique.indexOf('pipeline:begin critique-dispatch'), 'the scope opens before the dispatch');
      ok(critique.indexOf('pipeline:begin critique-scope-close') < critique.indexOf('pipeline:begin critique-finalize'), 'the close comes before Phase 2');
      ok(refine.indexOf('pipeline:begin refine-scope-record') < refine.indexOf('pipeline:begin refine-dispatch'), 'the record comes before Refine-verify');
    });

    for (const shell of SHELLS) {
      it(`${shell}: full critique, refine read and record, scoped critique`, async () => {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), `${persona} review scope `)));
        try {
          const top = join(dir, 'the repo');
          mkdirSync(join(top, 'docs'), { recursive: true });
          git(dir, 'init', '-q', '-b', 'feat/doc', top);
          writeFileSync(join(top, 'docs', 'adr.md'), '# A\n\nDraft.\n');
          git(top, 'add', '-A');
          git(top, 'commit', '-q', '-m', 'base');
          const base = git(top, 'rev-parse', 'HEAD').trim();
          writeFileSync(join(top, 'docs', 'adr.md'), '# A\n\nContext.\n\nDecision.\n\nConsequences.\n');
          const { filePath } = await state.createWorkflow({
            repoRoot: top, verb: 'critique', host: 'claude',
            gitBaseline: { branch: 'feat/doc', head: base, status_digest: '' },
            originalRequest: 'review scope runbook', currentPhase: 'phase-0-bootstrap',
          });
          const texts = join(dir, 'agent text');
          mkdirSync(texts);
          const run = (block) => spawnSync(shell, ['-c', block], { cwd: top, encoding: 'utf8', env: { ...baseEnv(), [ROOT_ENV]: P.root, ACTIVE: filePath } });
          const ok0 = (r) => {
            strictEqual(r.status, 0, r.stderr);
            return JSON.parse(r.stdout);
          };

          const first = ok0(run(fill(prepare, "'<profile, empty for the default>'", "''")));
          strictEqual(first.mode, 'full');
          strictEqual(first.generation, 1);
          const LEDGER = first.ledger;
          match(LEDGER, /^[0-9a-f]{16}$/);

          // A close whose findings file was never written records nothing
          // (the generation stays open) and does not stop the critique.
          const unwritten = run(fill(fill(fill(close, "'<directory holding findings.json>'", `'${texts}'`), "'<generation from critique-scope>'", "'1'"), "'<ledger from critique-scope>'", `'${LEDGER}'`));
          strictEqual(unwritten.status, 0, unwritten.stderr);
          match(unwritten.stderr, /findings\.json.*not a readable JSON file/);
          strictEqual(JSON.parse(unwritten.stdout).closed, false);

          writeFileSync(join(texts, 'findings.json'), `${JSON.stringify({ findings: [
            { id: 'NEW', severity: 'MAJOR', location: 'docs/adr.md:5', text: "a 'quoted' $(not run) finding" },
          ] })}\n`);
          const closed = ok0(run(fill(fill(fill(close, "'<directory holding findings.json>'", `'${texts}'`), "'<generation from critique-scope>'", "'1'"), "'<ledger from critique-scope>'", `'${LEDGER}'`)));
          deepStrictEqual(closed.carry, ['G1-F1']);

          const before = ok0(run(status));
          deepStrictEqual(before.carry, ['G1-F1']);
          deepStrictEqual(before.recurring, []);

          writeFileSync(join(top, 'docs', 'adr.md'), '# A\n\nContext.\n\nDecision, revised.\n\nConsequences.\n');
          writeFileSync(join(texts, 'targets.txt'), 'G1-F1\n');
          const attempt = ok0(run(fill(record, "'<directory holding targets.txt>'", `'${texts}'`)));
          strictEqual(attempt.attempt, 'R1');
          deepStrictEqual(attempt.verify, { mode: 'scoped', reason: 'scoped' }, 'Refine-verify may be scoped');

          const second = ok0(run(fill(prepare, "'<profile, empty for the default>'", "''")));
          strictEqual(second.mode, 'scoped', second.reason);
          deepStrictEqual(second.targets, ['G1-F1']);
          deepStrictEqual(second.passages.map((p) => [p.path, p.start, p.end]), [['docs/adr.md', 5, 5]]);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it(`${shell}: an older state.mjs without the subcommands falls back, never stops the verb`, () => {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), `${persona} review scope old `)));
        try {
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
          const run = (block) => spawnSync(shell, ['-c', block], { cwd: top, encoding: 'utf8', env: { ...baseEnv(), [ROOT_ENV]: oldRoot, ACTIVE: join(dir, 'wf.md') } });
          for (const [block, field, value] of [
            [fill(prepare, "'<profile, empty for the default>'", "''"), 'recorded', false],
            [status, 'ledger', false],
            [fill(record, "'<directory holding targets.txt>'", `'${texts}'`), 'recorded', false],
            [fill(fill(fill(close, "'<directory holding findings.json>'", `'${texts}'`), "'<generation from critique-scope>'", "'1'"), "'<ledger from critique-scope>'", `'${LEDGER}'`), 'closed', false],
          ]) {
            const r = run(block);
            strictEqual(r.status, 0, r.stderr);
            match(r.stderr, /unknown subcommand/);
            strictEqual(JSON.parse(r.stdout)[field], value);
          }
          strictEqual(JSON.parse(run(fill(record, "'<directory holding targets.txt>'", `'${texts}'`)).stdout).verify.mode, 'full');
          // A HEAD git cannot read: the blocks still reach the script, and it
          // falls back.
          writeFileSync(join(top, '.git', 'HEAD'), 'not a ref\n');
          const broken = (block) => spawnSync(shell, ['-c', block], { cwd: top, encoding: 'utf8', env: { ...baseEnv(), [ROOT_ENV]: P.root, ACTIVE: join(dir, 'wf.md') } });
          for (const block of [fill(prepare, "'<profile, empty for the default>'", "''"), fill(record, "'<directory holding targets.txt>'", `'${texts}'`)]) {
            const r = broken(block);
            strictEqual(r.status, 0, r.stderr);
            strictEqual(JSON.parse(r.stdout).recorded, false);
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  });
}
