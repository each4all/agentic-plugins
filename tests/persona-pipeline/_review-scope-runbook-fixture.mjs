// C120 — the fixture test-review-scope-runbook.mjs (the blocks' regions, the
// refusal and the fallback, once in bash) and test-review-scope-runbook-e2e.mjs
// (the happy cycle, per installed shell) share: each persona's review-scope
// blocks read from its committed runbook, between its region markers, with
// only the placeholders the agent fills filled, as the agent fills them.
//
// Not discovered by `node --test`: the stem starts with an underscore.

import { ok, strictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { personaInfo } from './_personas.mjs';
import { shellBlocks } from './_verb-runbooks.mjs';

export const SHELLS = ['bash', 'zsh'].filter((sh) => spawnSync(sh, ['-c', 'true']).status === 0);

export const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
  GIT_AUTHOR_DATE: '2026-10-14T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-14T00:00:00Z',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};

export const baseEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_') && k !== 'CLAUDE_PLUGIN_ROOT')),
  ...GIT_ENV,
});

export const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: baseEnv(), stdio: ['ignore', 'pipe', 'pipe'] });

export function region(text, id) {
  const begin = `<!-- pipeline:begin ${id} -->`;
  const end = `<!-- pipeline:end ${id} -->`;
  const a = text.indexOf(begin);
  const b = text.indexOf(end);
  ok(a >= 0 && b > a, `the runbook holds the ${id} region`);
  return text.slice(a + begin.length, b);
}

export function fill(block, from, to) {
  strictEqual(block.split(from).length, 2, `the block holds ${from} once`);
  return block.replace(from, () => to);
}

// One persona's blocks, and each filled as the agent fills it.
export async function reviewScopeBlocks(persona) {
  const P = personaInfo(persona);
  const state = await import(pathToFileURL(P.path('scripts/state.mjs')).href);
  const critique = readFileSync(P.path('commands/critique.md'), 'utf8');
  const refine = readFileSync(P.path('commands/refine.md'), 'utf8');
  const [prepare] = shellBlocks(region(critique, 'critique-scope-prepare')).map((b) => b.text);
  const [close] = shellBlocks(region(critique, 'critique-scope-close')).map((b) => b.text);
  const [status, record] = shellBlocks(region(refine, 'refine-scope-record')).map((b) => b.text);
  return {
    P, state, critique, refine, status,
    ROOT_ENV: `AGENTIC_${persona.toUpperCase()}_ROOT`,
    prepare: () => fill(prepare, "'<profile, empty for the default>'", "''"),
    close: (texts, generation, ledger) => fill(fill(fill(close, "'<directory holding findings.json>'", `'${texts}'`), "'<generation from critique-scope>'", `'${generation}'`), "'<ledger from critique-scope>'", `'${ledger}'`),
    record: (texts) => fill(record, "'<directory holding targets.txt>'", `'${texts}'`),
  };
}

// A repository at `top` (its path may hold a space) on feat/doc, one commit
// of docs/adr.md, then the deliverable's text in the working tree, and a
// critique workflow whose baseline is that commit.
export async function documentRepo(state, dir, top) {
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
  return filePath;
}
