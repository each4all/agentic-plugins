// ADR-0068 Decision 2, item 9 (implementation note of 2026-10-25, N4) — the
// one schema field the persona's half adds: `persona_operations`, the open
// operations of a macro's child, a JSON document in a double-quoted scalar
// at the tail of the frontmatter. Known only with dispatch_target on; every
// other reader (an earlier engineer release, designer, founder) carries it
// byte for byte through its forward-compat carrier.
//
// An earlier engineer beside the field: test-hold-persona-mixed-version.mjs.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { personaInfo, personasFor } from './_personas.mjs';

const OPS = { v: 1, ops: [{ id: 'op-20261025T090000Z-0123abcd', kind: 'verb', opened_at: '2026-10-25T09:00:00Z', ext: false }] };

// No AGENTIC_* (this session's run) and no GIT_* (an inherited GIT_INDEX_FILE
// or GIT_DIR would point the fixture's git at another repository).
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_')));
const fieldLine = (text) => text.split('\n').filter((l) => l.startsWith('persona_operations:'));

async function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'persona-ops-'));
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

// A workflow of `persona` whose frontmatter holds the field as `raw` (the
// scalar's text after the colon), written at the tail as this release writes it.
async function workflowWith(state, persona, dir, head, raw) {
  const { filePath } = await state.createWorkflow({
    repoRoot: dir, verb: 'compose', host: 'claude', persona, originalRequest: 'ops',
    gitBaseline: { branch: 'main', head, status_digest: '' }, env: cleanEnv(),
  });
  const text = readFileSync(filePath, 'utf8');
  const end = text.indexOf('\n---\n', 4);
  writeFileSync(filePath, `${text.slice(0, end)}\npersona_operations: ${raw}${text.slice(end)}`);
  return filePath;
}

const encode = (doc) => JSON.stringify(JSON.stringify(doc));

for (const persona of personasFor('scripts/state.mjs')) {
  const info = personaInfo(persona);
  const state = await import(pathToFileURL(info.path('scripts/state.mjs')).href);
  const known = info.capabilities.dispatch_target === true;

  describe(`${persona}: persona_operations (${known ? 'known' : 'carried, opaque'})`, () => {
    it('is kept byte for byte through an append and a snapshot', () => withRepo(async ({ dir, head }) => {
      const filePath = await workflowWith(state, persona, dir, head, encode(OPS));
      const before = fieldLine(readFileSync(filePath, 'utf8'));
      strictEqual(before.length, 1);
      await state.appendPhase({ workflowPath: filePath, host: 'claude', phaseNote: 'later', event: 'updated', env: cleanEnv() });
      await state.snapshot({ workflowPath: filePath, host: 'claude', trigger: 'stop', env: cleanEnv() });
      const after = readFileSync(filePath, 'utf8');
      deepStrictEqual(fieldLine(after), before);
      const { frontmatter } = state.parseWorkflowFile(after);
      if (known) deepStrictEqual(frontmatter.persona_operations, OPS, 'decoded');
      else {
        strictEqual(frontmatter.persona_operations, undefined, 'never decoded where unknown');
        deepStrictEqual(frontmatter[state.FORWARD_COMPAT_UNKNOWNS].map((u) => u.key), ['persona_operations']);
      }
    }));

    it('carries a document of a later version as read', () => withRepo(async ({ dir, head }) => {
      const later = { v: 2, ops: [{ id: 'anything', future: true }] };
      const filePath = await workflowWith(state, persona, dir, head, encode(later));
      const before = fieldLine(readFileSync(filePath, 'utf8'));
      await state.appendPhase({ workflowPath: filePath, host: 'claude', phaseNote: 'later', event: 'updated', env: cleanEnv() });
      const after = readFileSync(filePath, 'utf8');
      deepStrictEqual(fieldLine(after), before);
      if (known) deepStrictEqual(state.parseWorkflowFile(after).frontmatter.persona_operations, later);
    }));

    if (known) {
      it('is the last key this persona writes, after the verify records an autopilot step leaves', () => withRepo(async ({ dir, head }) => {
        const filePath = await workflowWith(state, persona, dir, head, encode(OPS));
        // A write under an autopilot run records the attempt mark and the
        // handoff, the keys this release wrote last before this one.
        await state.appendPhase({
          workflowPath: filePath, host: 'claude', phaseNote: 'later', event: 'updated',
          env: { ...cleanEnv(), AGENTIC_AUTOPILOT: 'autopilot-20261025T000000Z-abcdef', AGENTIC_AUTOPILOT_STEP: '1' },
        });
        const text = readFileSync(filePath, 'utf8');
        const fm = text.slice(4, text.indexOf('\n---\n', 4)).split('\n').filter((l) => /^[a-z_]+:/.test(l));
        ok(fm.some((l) => l.startsWith('verify_attempt:')), 'the autopilot write left its mark');
        ok(fm.at(-1).startsWith('persona_operations:'), fm.at(-1));
      }));

      for (const [why, doc] of [
        ['a version below 1', { v: 0, ops: [] }],
        ['no ops list', { v: 1 }],
        ['an unknown field', { v: 1, ops: [], extra: 1 }],
        ['an id outside its form', { v: 1, ops: [{ ...OPS.ops[0], id: 'op-1' }] }],
        ['an id that is no string', { v: 1, ops: [{ ...OPS.ops[0], id: [OPS.ops[0].id] }] }],
        ['an id listed twice', { v: 1, ops: [OPS.ops[0], OPS.ops[0]] }],
        ['an unknown kind', { v: 1, ops: [{ ...OPS.ops[0], kind: 'edit' }] }],
        ['an entry field it does not know', { v: 1, ops: [{ ...OPS.ops[0], pid: 1 }] }],
        ['ext not a boolean', { v: 1, ops: [{ ...OPS.ops[0], ext: 'no' }] }],
        ['opened_at not an ISO time', { v: 1, ops: [{ ...OPS.ops[0], opened_at: 'today' }] }],
      ]) {
        it(`refuses a document with ${why}`, () => withRepo(async ({ dir, head }) => {
          const filePath = await workflowWith(state, persona, dir, head, encode(doc));
          throws(() => state.parseWorkflowFile(readFileSync(filePath, 'utf8')), /persona_operations/);
        }));
      }

      it('refuses a scalar that is not JSON', () => withRepo(async ({ dir, head }) => {
        const filePath = await workflowWith(state, persona, dir, head, '"{"');
        throws(() => state.parseWorkflowFile(readFileSync(filePath, 'utf8')), /persona_operations is not JSON/);
      }));
    } else {
      it('carries even a malformed document, never reading it', () => withRepo(async ({ dir, head }) => {
        const filePath = await workflowWith(state, persona, dir, head, '"{not json"');
        const before = fieldLine(readFileSync(filePath, 'utf8'));
        await state.appendPhase({ workflowPath: filePath, host: 'claude', phaseNote: 'later', event: 'updated', env: cleanEnv() });
        deepStrictEqual(fieldLine(readFileSync(filePath, 'utf8')), before);
      }));
    }
  });
}
