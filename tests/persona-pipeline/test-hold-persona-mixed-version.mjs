// ADR-0068 Decision 2 (implementation note of 2026-10-25, N4, N6) — an
// earlier engineer beside the hold-persona release: it carries
// persona_operations byte for byte through its own writes, its snapshot
// leaves the content digest unchanged, and it takes the operation flags a
// runbook of this release passes as a no-op. Apart from the other hold-persona
// tests because it reads the earlier engineer from its release tag with
// `git archive`: a missing tag fails the test (CI checks out with full
// history and tags), and a mutation run's copy carries no tags.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT, personaInfo } from './_personas.mjs';

const PREVIOUS = 'plugin-engineer-v0.32.0';
const OPS = { v: 1, ops: [{ id: 'op-20261025T090000Z-0123abcd', kind: 'verb', opened_at: '2026-10-25T09:00:00Z', ext: false }] };
// No AGENTIC_* (this session's run) and no GIT_* (an inherited GIT_INDEX_FILE
// or GIT_DIR would point the fixture's git at another repository).
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_')));
const fieldLine = (text) => text.split('\n').filter((l) => l.startsWith('persona_operations:'));
const encode = (doc) => JSON.stringify(JSON.stringify(doc));
const engineer = await import(pathToFileURL(personaInfo('engineer').path('scripts/state.mjs')).href);

async function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hold-mixed-'));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: cleanEnv() }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'README.md'), 'x\n');
    git('add', '.');
    git('commit', '-q', '-m', 'feat: base');
    return await fn({ dir, head: git('rev-parse', 'HEAD') });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// An engineer workflow holding the field, written at the tail as this release writes it.
async function workflowWith(state, persona, dir, head, raw) {
  const { filePath } = await state.createWorkflow({
    repoRoot: dir, verb: 'compose', host: 'claude', persona, originalRequest: 'ops',
    gitBaseline: { branch: 'main', head, status_digest: '' },
  });
  const text = readFileSync(filePath, 'utf8');
  const end = text.indexOf('\n---\n', 4);
  writeFileSync(filePath, `${text.slice(0, end)}\npersona_operations: ${raw}${text.slice(end)}`);
  return filePath;
}

const oldRoot = mkdtempSync(join(tmpdir(), 'engineer-previous-'));
process.on('exit', () => rmSync(oldRoot, { recursive: true, force: true }));
{
  const tag = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--verify', '-q', `${PREVIOUS}^{commit}`], { encoding: 'utf8' });
  if (tag.status !== 0) throw new Error(`${PREVIOUS} is not in this clone: fetch the tags (CI checks out with fetch-depth 0); this test fails rather than skip`);
  const tar = execFileSync('git', ['-C', REPO_ROOT, 'archive', '--format=tar', PREVIOUS, 'plugins/engineer'], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', oldRoot], { input: tar });
}
const OLD = join(oldRoot, 'plugins/engineer');
const oldCli = (args, dir) => spawnSync(process.execPath, [join(OLD, 'scripts/state.mjs'), ...args], { cwd: dir, encoding: 'utf8', env: cleanEnv() });

describe(`an earlier engineer (${PREVIOUS}) beside persona_operations`, () => {
  it('does not know the field', () => {
    ok(!readFileSync(join(OLD, 'scripts/state.mjs'), 'utf8').includes('persona_operations'));
  });

  it('keeps it byte for byte through its own append, snapshot and set-terminal', () => withRepo(async ({ dir, head }) => {
    const filePath = await workflowWith(engineer, 'engineer', dir, head, encode(OPS));
    const before = fieldLine(readFileSync(filePath, 'utf8'));
    for (const args of [
      ['append', '--workflow-path', filePath, '--host', 'codex', '--phase-note', 'older host'],
      ['snapshot', '--workflow-path', filePath, '--host', 'codex', '--trigger', 'stop'],
      ['set-terminal', '--workflow-path', filePath, '--host', 'codex', '--terminal-phase', 'summary-complete'],
    ]) {
      const r = oldCli(args, dir);
      strictEqual(r.status, 0, `${args[0]}: ${r.stderr}`);
    }
    const after = readFileSync(filePath, 'utf8');
    deepStrictEqual(fieldLine(after), before);
    deepStrictEqual(engineer.parseWorkflowFile(after).frontmatter.persona_operations, OPS, 'and this release reads it back');
  }));

  // A runbook of this release beside an earlier release's scripts (a pinned
  // plugin root, or command text loaded from a newer checkout): the operation
  // flags are ignored, so no operation is kept and every write is as before.
  it("takes this release's operation flags as a no-op", () => withRepo(async ({ dir, head }) => {
    const opDir = mkdtempSync(join(tmpdir(), 'op-'));
    try {
      const c = oldCli(['create', '--repo-root', dir, '--verb', 'compose', '--host', 'claude', '--git-baseline-branch', 'main',
        '--git-baseline-head', head, '--parent-workflow', 'macro-plan-20261025T000000Z-abcdef', '--originating-subtask', 'hold-persona',
        '--operation-dir', opDir], dir);
      strictEqual(c.status, 0, c.stderr);
      const filePath = c.stdout.trim();
      for (const args of [
        ['append', '--workflow-path', filePath, '--host', 'claude', '--operation-dir', opDir, '--open-operation', 'verb'],
        ['set-terminal', '--workflow-path', filePath, '--host', 'claude', '--terminal-phase', 'summary-complete', '--operation-dir', opDir],
      ]) {
        const r = oldCli(args, dir);
        strictEqual(r.status, 0, `${args[0]}: ${r.stderr}`);
      }
      ok(!readFileSync(filePath, 'utf8').includes('persona_operations'));
      deepStrictEqual(readdirSync(opDir), [], 'no transport file');
    } finally {
      rmSync(opDir, { recursive: true, force: true });
    }
  }));

  it('its snapshot, re-serializing the file, leaves the content digest unchanged', () => withRepo(async ({ dir, head }) => {
    const filePath = await workflowWith(engineer, 'engineer', dir, head, encode(OPS));
    const before = (await engineer.contentDigest(filePath)).digest;
    const r = oldCli(['snapshot', '--workflow-path', filePath, '--host', 'codex', '--trigger', 'stop'], dir);
    strictEqual(r.status, 0, r.stderr);
    strictEqual((await engineer.contentDigest(filePath)).digest, before);
  }));
});
