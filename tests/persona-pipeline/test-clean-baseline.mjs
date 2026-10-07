// scripts/state.mjs — evaluateCleanBaseline, the start bootstrap's
// clean-baseline decision (ADR-0028 §Layer-1), canonical in persona-pipeline/
// and run for every persona that receives state.mjs (moved from
// tests/engineer/test-start-command.mjs in ADR-0066 PC3b U2; the runbook
// blocks that call it are run in test-runbook-contracts.mjs).

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

import { personaInfo, personasFor } from './_personas.mjs';

// -----------------------------------------------------------------------------
// Layer 1 — Phase 0 clean-baseline gate (ADR-0028 §Layer-1)
//
// `evaluateCleanBaseline` is the pure decision function: given the
// porcelain output and the accept-current-tree bypass flag, it returns
// {status, categories}. The CLI wrapper in state.mjs runs
// `git status --porcelain=v1` and forwards the result.

// ADR-0028 PR4 N4-quoted — fixtures use the NUL-separated wire format
// emitted by `git status --porcelain=v1 -z`:
//   non-rename:  "XY <path>\0"
//   rename/copy: "R  <new>\0<old>\0"   (newpath first, then oldpath)
// `-z` turns off git's C-quoting of paths with spaces / special chars,
// so the workflow-storage exclusion prefix check works regardless of
// the filename shape (PR3 N4-quoted Codex peer deferral).
for (const persona of personasFor('scripts/state.mjs')) {
const { evaluateCleanBaseline } = await import(pathToFileURL(personaInfo(persona).path('scripts/state.mjs')).href);

describe(`${persona}: evaluateCleanBaseline — pure decision function (ADR-0028 §Layer-1)`, () => {
  it('returns status=clean for empty porcelain output', () => {
    const r = evaluateCleanBaseline({ statusPorcelain: '' });
    strictEqual(r.status, 'clean');
    deepStrictEqual(r.categories, { modified: [], staged: [], untracked: [] });
  });

  it('classifies a modified tracked file (" M") as modified', () => {
    const r = evaluateCleanBaseline({ statusPorcelain: ' M plugins/x/scripts/state.mjs\0' });
    strictEqual(r.status, 'dirty');
    deepStrictEqual(r.categories.modified, ['plugins/x/scripts/state.mjs']);
    deepStrictEqual(r.categories.staged, []);
    deepStrictEqual(r.categories.untracked, []);
  });

  it('classifies a staged-add ("A ") as staged', () => {
    const r = evaluateCleanBaseline({ statusPorcelain: 'A  docs/new.md\0' });
    strictEqual(r.status, 'dirty');
    deepStrictEqual(r.categories.staged, ['docs/new.md']);
  });

  it('classifies a staged-modify ("M ") as staged', () => {
    const r = evaluateCleanBaseline({ statusPorcelain: 'M  AGENTS.md\0' });
    strictEqual(r.status, 'dirty');
    deepStrictEqual(r.categories.staged, ['AGENTS.md']);
  });

  it('classifies an untracked file ("??") as untracked', () => {
    const r = evaluateCleanBaseline({ statusPorcelain: '?? scratch.txt\0' });
    strictEqual(r.status, 'dirty');
    deepStrictEqual(r.categories.untracked, ['scratch.txt']);
  });

  it('excludes .agentic-plugins/state/** from all categories (workflow storage)', () => {
    // ADR-0028 §Layer-1: "tracked modifications, staged changes, or
    // untracked files **excluding** the `.agentic-plugins/state` workflow
    // storage". A workflow file change does NOT make the baseline dirty.
    const r = evaluateCleanBaseline({
      statusPorcelain:
        `?? .agentic-plugins/state/${persona}/workflows/x.md\0` +
        ` M .agentic-plugins/state/${persona}/workflows/y.md\0` +
        `A  .agentic-plugins/state/${persona}/workflows/z.md\0`,
    });
    strictEqual(r.status, 'clean');
    deepStrictEqual(r.categories, { modified: [], staged: [], untracked: [] });
  });

  it('preserves non-workflow-storage dirty entries alongside excluded workflow entries', () => {
    const r = evaluateCleanBaseline({
      statusPorcelain:
        ' M plugins/x/scripts/state.mjs\0' +
        ` M .agentic-plugins/state/${persona}/workflows/x.md\0`,
    });
    strictEqual(r.status, 'dirty');
    deepStrictEqual(r.categories.modified, ['plugins/x/scripts/state.mjs']);
  });

  it('returns status=accepted when acceptCurrentTree=true overrides a dirty tree', () => {
    // ADR-0028 §Layer-1 accept-current-tree bypass: ACCEPT_CURRENT_TREE=1
    // env-var lets the workflow sweep the current tree into its commit.
    // The categories field still surfaces what is dirty so phase7-commit.mjs
    // can act on it.
    const r = evaluateCleanBaseline({
      statusPorcelain: ' M plugins/x/scripts/state.mjs\0',
      acceptCurrentTree: true,
    });
    strictEqual(r.status, 'accepted');
    deepStrictEqual(r.categories.modified, ['plugins/x/scripts/state.mjs']);
  });

  it('returns status=clean when acceptCurrentTree=true but tree is clean (idempotent)', () => {
    const r = evaluateCleanBaseline({ statusPorcelain: '', acceptCurrentTree: true });
    strictEqual(r.status, 'clean');
  });

  it('handles rename ("R ") porcelain entries with the renamed-to path', () => {
    // -z format: "R  new\0old\0" (newpath first; opposite of plain v1
    // "R  old -> new"). PR3 Codex peer plan-verify confirmed the -z
    // rename row shape (`["R  new name.md", "old.md", ""]`).
    const r = evaluateCleanBaseline({
      statusPorcelain: 'R  docs/renamed.md\0old.md\0',
    });
    strictEqual(r.status, 'dirty');
    deepStrictEqual(r.categories.staged, ['docs/renamed.md']);
  });

  it('N4 — inside-to-inside workflow-storage rename stays clean', () => {
    // Both OLD and NEW are workflow storage → the persona's own bookkeeping
    // moving between workflows/ and archive/. Counts as clean.
    const r = evaluateCleanBaseline({
      statusPorcelain:
        `R  .agentic-plugins/state/${persona}/archive/x.md\0` +
        `.agentic-plugins/state/${persona}/workflows/x.md\0`,
    });
    strictEqual(r.status, 'clean');
    deepStrictEqual(r.categories, { modified: [], staged: [], untracked: [] });
  });

  it('N4 — outside-into-workflow-storage rename is dirty (surfaces the OLD outside path)', () => {
    // OLD is outside workflow-storage → user is moving a real source file
    // into the workflow storage. The OLD path disappears from the
    // working tree; phase7 must surface that endpoint so the user can
    // resolve. PR3 Codex peer review MINOR N4-assert: explicit endpoint
    // check (length-only was too weak).
    const r = evaluateCleanBaseline({
      statusPorcelain:
        `R  .agentic-plugins/state/${persona}/workflows/AGENTS.md\0AGENTS.md\0`,
    });
    strictEqual(r.status, 'dirty');
    const allSurfaced = [...r.categories.staged, ...r.categories.modified];
    ok(
      allSurfaced.includes('AGENTS.md'),
      `rename outside→inside must surface OLD path 'AGENTS.md' (got: ${JSON.stringify(allSurfaced)})`,
    );
  });

  it('N4 — workflow-storage-into-outside rename is dirty (surfaces the NEW outside path)', () => {
    // OLD inside, NEW outside → workflow-storage content is being moved
    // out into the tracked tree. Dirty so phase7 stages or refuses.
    // PR3 N4-assert: explicit endpoint check.
    const r = evaluateCleanBaseline({
      statusPorcelain:
        `R  docs/y.md\0.agentic-plugins/state/${persona}/workflows/y.md\0`,
    });
    strictEqual(r.status, 'dirty');
    const allSurfaced = [...r.categories.staged, ...r.categories.modified];
    ok(
      allSurfaced.includes('docs/y.md'),
      `rename inside→outside must surface NEW path 'docs/y.md' (got: ${JSON.stringify(allSurfaced)})`,
    );
  });

  // ----------------------------------------------------------------------
  // ADR-0028 PR4 N4-quoted — special-char paths inside workflow storage
  // must still be EXCLUDED. Under plain `--porcelain=v1` the path would
  // be C-quoted (`"a b.md"`), and the workflow-storage prefix check
  // (which expects `.agentic-plugins/...`) would see a literal `"` and
  // incorrectly classify the file as outside the workflow storage.
  // `-z` emits raw bytes (no quoting), so the prefix check works.
  describe('N4-quoted (PR4) — special-char paths under workflow storage', () => {
    it('excludes a workflow-storage path containing a space', () => {
      const r = evaluateCleanBaseline({
        statusPorcelain:
          ` M .agentic-plugins/state/${persona}/workflows/with space.md\0`,
      });
      strictEqual(r.status, 'clean');
      deepStrictEqual(r.categories, { modified: [], staged: [], untracked: [] });
    });

    it('excludes a workflow-storage path containing a literal " character', () => {
      // A real path on disk with an embedded double-quote — plain v1
      // would surround it with quotes AND escape the inner quote.
      // Under -z the byte is raw.
      const r = evaluateCleanBaseline({
        statusPorcelain:
          `A  .agentic-plugins/state/${persona}/workflows/q"x.md\0`,
      });
      strictEqual(r.status, 'clean');
    });

    it('excludes a workflow-storage path with a tab byte', () => {
      const r = evaluateCleanBaseline({
        statusPorcelain:
          `?? .agentic-plugins/state/${persona}/workflows/with\ttab.md\0`,
      });
      strictEqual(r.status, 'clean');
    });

    it('excludes an inside-to-inside rename whose endpoints contain spaces', () => {
      const r = evaluateCleanBaseline({
        statusPorcelain:
          `R  .agentic-plugins/state/${persona}/archive/new name.md\0` +
          `.agentic-plugins/state/${persona}/workflows/old name.md\0`,
      });
      strictEqual(r.status, 'clean');
    });

    it('still surfaces dirty when an outside path with special chars is touched', () => {
      const r = evaluateCleanBaseline({
        statusPorcelain: ' M docs/note with space.md\0',
      });
      strictEqual(r.status, 'dirty');
      deepStrictEqual(r.categories.modified, ['docs/note with space.md']);
    });
  });
});
}
