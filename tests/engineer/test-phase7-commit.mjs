// plugins/engineer/scripts/phase7-commit.mjs — helper unit tests
// (ADR-0028 §Layer-3).
//
// The driver itself is exercised end-to-end via /engineer:start Phase 7
// dogfood (P14 — PR2 is hand-landed). These tests cover the pure
// helpers + the CLI flag parser; staging logic is structured so the
// branch decision (decideStagingBranch), classification consumer
// (commitShapeFor — P12 exhaustive switch), and body composition
// (composeBody + stripTrailers) are testable without git.
//
// Run via `node --test tests/engineer/test-phase7-commit.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok, throws } from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PHASE7_PATH = resolve(REPO_ROOT, 'plugins/engineer/scripts/phase7-commit.mjs');

const {
  parseFlags,
  stripTrailers,
  composeBody,
  inferSubject,
  parseSimpleToml,
  readPhase7Config,
  decideStagingBranch,
  commitShapeFor,
} = await import(PHASE7_PATH);

// -----------------------------------------------------------------------------
// parseFlags — argv → flag map with repeatable + boolean support

describe('parseFlags — CLI argv parser', () => {
  it('parses simple value flags', () => {
    const f = parseFlags(['--mode', 'plan', '--workflow-path', '/a.md', '--host', 'claude']);
    strictEqual(f.mode, 'plan');
    strictEqual(f['workflow-path'], '/a.md');
    strictEqual(f.host, 'claude');
  });

  it('repeats --subject-pkg into an array', () => {
    const f = parseFlags([
      '--subject-pkg', 'plugins/engineer=feat(engineer): a',
      '--subject-pkg', 'plugins/runtime=docs(runtime): b',
    ]);
    deepStrictEqual(f['subject-pkg'], [
      'plugins/engineer=feat(engineer): a',
      'plugins/runtime=docs(runtime): b',
    ]);
  });

  it('handles boolean flags with optional explicit true/false', () => {
    strictEqual(parseFlags(['--accept-current-tree'])['accept-current-tree'], true);
    strictEqual(parseFlags(['--accept-current-tree', 'true'])['accept-current-tree'], true);
    strictEqual(parseFlags(['--accept-current-tree', 'false'])['accept-current-tree'], false);
  });

  it('rejects an unknown positional argument', () => {
    throws(() => parseFlags(['positional', '--mode', 'plan']), /Unexpected positional/);
  });

  it('rejects a value flag missing its value', () => {
    throws(() => parseFlags(['--subject']), /Missing value/);
    throws(() => parseFlags(['--subject', '--mode']), /Missing value/);
  });
});

// -----------------------------------------------------------------------------
// stripTrailers — P9 trailer-allowlist policy

describe('stripTrailers — P9 trailer allowlist (ADR-0028)', () => {
  it('removes BREAKING CHANGE / Co-Authored-By / Closes / Fixes / Refs lines', () => {
    const text =
      'Some change body.\n' +
      'BREAKING CHANGE: drop the old API\n' +
      'Closes: #123\n' +
      'Co-Authored-By: Bot <noreply@example.com>\n' +
      'Fixes: #456\n' +
      'Refs: ABC-789\n' +
      'BREAKING-CHANGE: dashed variant\n' +
      'Last line.\n';
    const out = stripTrailers(text);
    ok(!/BREAKING CHANGE/.test(out));
    ok(!/BREAKING-CHANGE/.test(out));
    ok(!/Co-Authored-By/.test(out));
    ok(!/Closes:/.test(out));
    ok(!/Fixes:/.test(out));
    ok(!/Refs:/.test(out));
    ok(/Some change body\./.test(out));
    ok(/Last line\./.test(out));
  });

  it('case-insensitive trailer match', () => {
    const out = stripTrailers('co-authored-by: x\nbody\n');
    strictEqual(out, 'body');
  });

  it('returns empty string for empty / non-string input', () => {
    strictEqual(stripTrailers(''), '');
    strictEqual(stripTrailers(null), '');
    strictEqual(stripTrailers(undefined), '');
  });
});

// -----------------------------------------------------------------------------
// composeBody — P1 three-source composition

describe('composeBody — P1 source composition (ADR-0028)', () => {
  it('concatenates original_request + diff stat + ensemble summary in order', () => {
    const body = composeBody({
      originalRequest: 'Add ADR-0028 Phase 7 driver',
      diffStat:
        ' plugins/engineer/scripts/phase7-commit.mjs | 900 +++++++\n' +
        ' tests/engineer/test-phase7-commit.mjs       | 200 ++++\n',
      ensembleSummary: 'plan-verify agreed; review found 0 issues',
    });
    ok(body.startsWith('Add ADR-0028 Phase 7 driver'));
    ok(body.includes('plugins/engineer/scripts/phase7-commit.mjs'));
    ok(body.includes('plan-verify agreed'));
  });

  it('omits the ensemble summary when it exceeds 200 chars', () => {
    const long = 'x'.repeat(250);
    const body = composeBody({
      originalRequest: 'subject',
      diffStat: '',
      ensembleSummary: long,
    });
    ok(!body.includes(long));
  });

  it('strips trailer-shaped lines from original_request and ensemble summary', () => {
    // P9 — the body composition MUST scan sources 1 and 3 for trailers.
    const body = composeBody({
      originalRequest: 'Refactor.\nBREAKING CHANGE: yes\nDetails.\n',
      diffStat: '',
      ensembleSummary: 'Fixes: #999\nAGREED on plan',
    });
    ok(!body.includes('BREAKING CHANGE'));
    ok(!body.includes('Fixes:'));
    ok(body.includes('Refactor'));
    ok(body.includes('AGREED on plan'));
  });

  it('truncates diff stat to 20 lines per P1', () => {
    const big = Array.from({ length: 30 }, (_, i) => ` file${i}.mjs | 10 +++++`).join('\n');
    const body = composeBody({
      originalRequest: 'work',
      diffStat: big,
      ensembleSummary: '',
    });
    // Body wraps diff in ```; count fenced lines.
    const fence = body.split('```')[1] || '';
    strictEqual(fence.trim().split('\n').length, 20);
  });
});

// -----------------------------------------------------------------------------
// inferSubject — P6 conventional-commit shape

describe('inferSubject — P6 subject inference', () => {
  it('produces feat(engineer): … for compose code on plugins/engineer', () => {
    const s = inferSubject({
      packageKey: 'plugins/engineer',
      frontmatter: {
        verb: 'compose',
        profile: 'code',
        original_request: 'Add Phase 7 driver',
      },
    });
    strictEqual(s, 'feat(engineer): Add Phase 7 driver');
  });

  it('produces fix(runtime): … for refine on plugins/runtime', () => {
    const s = inferSubject({
      packageKey: 'plugins/runtime',
      frontmatter: { verb: 'refine', original_request: 'fix cutover footer' },
    });
    strictEqual(s, 'fix(runtime): fix cutover footer');
  });

  it('produces docs(adr): … for compose plan', () => {
    const s = inferSubject({
      packageKey: 'docs',
      frontmatter: { verb: 'compose', profile: 'plan', original_request: 'propose ADR' },
    });
    // packageScope() takes the last path segment.
    strictEqual(s, 'docs(docs): propose ADR');
  });

  it('emits a scopeless subject when packageKey is null (root-docs commit)', () => {
    const s = inferSubject({
      packageKey: null,
      frontmatter: { verb: 'refine', original_request: 'sync AGENTS.md' },
    });
    strictEqual(s, 'fix: sync AGENTS.md');
  });

  it('caps the description at 60 chars with ellipsis', () => {
    const long = 'x'.repeat(80);
    const s = inferSubject({
      packageKey: 'plugins/engineer',
      frontmatter: { verb: 'refine', original_request: long },
    });
    ok(s.endsWith('...'));
    ok(s.length <= 'fix(engineer): '.length + 60);
  });
});

// -----------------------------------------------------------------------------
// parseSimpleToml + readPhase7Config — P13 inline parser

describe('parseSimpleToml — P13 inline parser', () => {
  it('parses [phase7] strictCC = true', () => {
    const parsed = parseSimpleToml('[phase7]\nstrictCC = true\n');
    strictEqual(parsed.phase7.strictCC, true);
  });

  it('parses strings, ints, booleans', () => {
    const parsed = parseSimpleToml('[section]\na = "hello"\nb = 42\nc = false\n');
    strictEqual(parsed.section.a, 'hello');
    strictEqual(parsed.section.b, 42);
    strictEqual(parsed.section.c, false);
  });

  it('ignores comments and blank lines', () => {
    const parsed = parseSimpleToml('# header\n\n[phase7]\n# inline\nstrictCC = true\n');
    strictEqual(parsed.phase7.strictCC, true);
  });

  it('returns {} for non-string input', () => {
    deepStrictEqual(parseSimpleToml(null), {});
    deepStrictEqual(parseSimpleToml(undefined), {});
    deepStrictEqual(parseSimpleToml(''), {});
  });
});

describe('readPhase7Config — fixture round-trip', () => {
  it('returns strictCC=false when config.toml is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phase7-cfg-'));
    try {
      const cfg = await readPhase7Config(dir);
      strictEqual(cfg.strictCC, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns strictCC=true when [phase7] strictCC=true', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phase7-cfg-'));
    try {
      const ap = join(dir, '.agentic-plugins');
      await import('node:fs/promises').then((m) => m.mkdir(ap));
      await writeFile(join(ap, 'config.toml'), '[phase7]\nstrictCC = true\n');
      const cfg = await readPhase7Config(dir);
      strictEqual(cfg.strictCC, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns strictCC=false for malformed config.toml (lenient default)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phase7-cfg-'));
    try {
      const ap = join(dir, '.agentic-plugins');
      await import('node:fs/promises').then((m) => m.mkdir(ap));
      await writeFile(join(ap, 'config.toml'), 'this is not valid TOML\n');
      const cfg = await readPhase7Config(dir);
      strictEqual(cfg.strictCC, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// decideStagingBranch — the three Layer 3 branches (⊇ / ⊊ / ∅)
// plus accept-current-tree forwarding and no-changes early exit.

describe('decideStagingBranch — staging set branch decision (ADR-0028 §Layer-3)', () => {
  it('returns no-changes when git_changes is empty', () => {
    const r = decideStagingBranch({ gitChanges: [], manifestPaths: ['a.mjs'] });
    strictEqual(r.branch, 'no-changes');
    strictEqual(r.askUser, false);
  });

  it('returns empty-manifest when manifest is empty but git has changes', () => {
    const r = decideStagingBranch({ gitChanges: ['x.mjs'], manifestPaths: [] });
    strictEqual(r.branch, 'empty-manifest');
    strictEqual(r.askUser, true);
    deepStrictEqual(r.stagingSet, ['x.mjs']);
  });

  it('returns manifest-intersects-git when manifest ⊇ git_changes (validated, no prompt)', () => {
    const r = decideStagingBranch({
      gitChanges: ['a.mjs', 'b.mjs'],
      manifestPaths: ['a.mjs', 'b.mjs', 'c.mjs'],
    });
    strictEqual(r.branch, 'manifest-intersects-git');
    strictEqual(r.askUser, false);
    deepStrictEqual(r.stagingSet, ['a.mjs', 'b.mjs']);
  });

  it('returns manifest-subset-of-git with extras when manifest ⊊ git_changes', () => {
    const r = decideStagingBranch({
      gitChanges: ['a.mjs', 'b.mjs', 'extra.mjs'],
      manifestPaths: ['a.mjs', 'b.mjs'],
    });
    strictEqual(r.branch, 'manifest-subset-of-git');
    strictEqual(r.askUser, true);
    deepStrictEqual(r.stagingSet, ['a.mjs', 'b.mjs']);
    deepStrictEqual(r.extras, ['extra.mjs']);
  });

  it('accept-current-tree overrides everything; stages all git_changes', () => {
    const r = decideStagingBranch({
      gitChanges: ['a.mjs', 'extra.mjs'],
      manifestPaths: ['a.mjs'],
      acceptCurrentTree: true,
    });
    strictEqual(r.branch, 'accept-current-tree');
    strictEqual(r.askUser, false);
    deepStrictEqual(r.stagingSet, ['a.mjs', 'extra.mjs']);
  });
});

// -----------------------------------------------------------------------------
// commitShapeFor — P12 exhaustive enum switch

describe('commitShapeFor — P12 classifyMixedCase exhaustive switch (ADR-0028)', () => {
  it('single-package: 1 commit, requiresSplit=false', () => {
    const shape = commitShapeFor({
      classification: 'single-package',
      perPackageCommits: [{ package: 'plugins/engineer', files: ['a.mjs'] }],
    });
    strictEqual(shape.commits.length, 1);
    strictEqual(shape.requiresSplit, false);
  });

  it('single-package-with-docs: 1 commit (folded), requiresSplit=false', () => {
    const shape = commitShapeFor({
      classification: 'single-package-with-docs',
      perPackageCommits: [
        { package: 'plugins/engineer', files: ['a.mjs', 'docs/x.md'] },
      ],
    });
    strictEqual(shape.commits.length, 1);
    strictEqual(shape.requiresSplit, false);
  });

  it('multi-package: N commits, requiresSplit=true', () => {
    const shape = commitShapeFor({
      classification: 'multi-package',
      perPackageCommits: [
        { package: 'plugins/engineer', files: ['a.mjs'] },
        { package: 'plugins/runtime', files: ['b.mjs'] },
      ],
    });
    strictEqual(shape.commits.length, 2);
    strictEqual(shape.requiresSplit, true);
  });

  it('multi-package-with-docs: N+1 commits with docs commit appended last', () => {
    const shape = commitShapeFor({
      classification: 'multi-package-with-docs',
      perPackageCommits: [
        { package: 'plugins/engineer', files: ['a.mjs'] },
        { package: 'plugins/runtime', files: ['b.mjs'] },
      ],
      docsCommit: { files: ['docs/x.md'] },
    });
    strictEqual(shape.commits.length, 3);
    strictEqual(shape.commits[2].package, null);
    deepStrictEqual(shape.commits[2].files, ['docs/x.md']);
    strictEqual(shape.requiresSplit, true);
  });

  it('docs-only: 1 commit (docs), requiresSplit=false', () => {
    const shape = commitShapeFor({
      classification: 'docs-only',
      perPackageCommits: [],
      docsCommit: { files: ['docs/x.md'] },
    });
    strictEqual(shape.commits.length, 1);
    strictEqual(shape.commits[0].package, null);
    strictEqual(shape.requiresSplit, false);
  });

  it('empty: 0 commits, requiresSplit=false', () => {
    const shape = commitShapeFor({
      classification: 'empty',
      perPackageCommits: [],
    });
    strictEqual(shape.commits.length, 0);
    strictEqual(shape.requiresSplit, false);
  });

  it('throws on unknown classification (P12 exhaustive guard)', () => {
    throws(
      () => commitShapeFor({ classification: 'not-a-real-case', perPackageCommits: [] }),
      /unknown classification/,
    );
  });
});
