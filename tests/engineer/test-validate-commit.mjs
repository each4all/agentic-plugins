// plugins/engineer/scripts/validate-commit.mjs unit tests
// (ADR-0028 §Centralization).
//
// Validation contract per ADR-0028:
//   - parseCommitSubject — RFC-style Conventional Commit parse with `!` breaking
//   - CONVENTIONAL_COMMIT_RE — single source of truth for the regex
//   - readPackageMap(configPath, {strict}) — graceful in lenient mode,
//     throws in strict mode for the agentic-plugins repo
//   - isExemptPath — STRUCTURAL "not in any package prefix" predicate
//   - detectCrossPackageRoutes — segment-aware partition over staged files
//   - classifyMixedCase — 4-enum classification per ADR-0028 §P12
//
// Module is pure (no I/O, no globals) per the stop-archive.mjs:222-228
// purity invariant; readPackageMap is the one exception and accepts the
// config file path as a parameter so tests drive it with fixtures.
//
// Run via `node --test tests/engineer/test-validate-commit.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok, throws } from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const VALIDATE_COMMIT_PATH = resolve(
  REPO_ROOT,
  'plugins/engineer/scripts/validate-commit.mjs',
);

const {
  CONVENTIONAL_COMMIT_RE,
  parseCommitSubject,
  readPackageMap,
  isExemptPath,
  detectCrossPackageRoutes,
  classifyMixedCase,
} = await import(VALIDATE_COMMIT_PATH);

// -----------------------------------------------------------------------------
// CONVENTIONAL_COMMIT_RE — the single canonical regex.

describe('CONVENTIONAL_COMMIT_RE — matches Conventional Commit subjects', () => {
  it('matches the 7 allowed types without scope', () => {
    for (const type of ['feat', 'fix', 'docs', 'ci', 'refactor', 'chore', 'test']) {
      ok(
        CONVENTIONAL_COMMIT_RE.test(`${type}: short summary`),
        `expected match for "${type}: ..."`,
      );
    }
  });

  it('matches with an optional scope', () => {
    ok(CONVENTIONAL_COMMIT_RE.test('feat(engineer): add Phase 7 driver'));
    ok(CONVENTIONAL_COMMIT_RE.test('docs(adr): finalize ADR-0028'));
  });

  it('matches with the `!` breaking marker (ADR-0028 §P7)', () => {
    ok(CONVENTIONAL_COMMIT_RE.test('feat!: drop legacy field'));
    ok(CONVENTIONAL_COMMIT_RE.test('feat(engineer)!: rename schema key'));
  });

  it('rejects subjects without a recognized type', () => {
    strictEqual(CONVENTIONAL_COMMIT_RE.test('wip: experiment'), false);
    strictEqual(CONVENTIONAL_COMMIT_RE.test('Feat: capitalized'), false);
    strictEqual(CONVENTIONAL_COMMIT_RE.test('add a thing'), false);
  });

  it('rejects subjects with malformed scope syntax', () => {
    strictEqual(CONVENTIONAL_COMMIT_RE.test('feat(unclosed: x'), false);
    strictEqual(CONVENTIONAL_COMMIT_RE.test('feat scope: x'), false);
  });
});

// -----------------------------------------------------------------------------
// parseCommitSubject — structured parse with `!` breaking awareness.

describe('parseCommitSubject — structured parse', () => {
  it('returns null for non-conventional subjects', () => {
    strictEqual(parseCommitSubject(''), null);
    strictEqual(parseCommitSubject('not a commit subject'), null);
    strictEqual(parseCommitSubject(null), null);
    strictEqual(parseCommitSubject(undefined), null);
    strictEqual(parseCommitSubject(42), null);
  });

  it('parses {type, description} when no scope and no breaking', () => {
    deepStrictEqual(parseCommitSubject('feat: add Phase 7 driver'), {
      type: 'feat',
      scope: null,
      breaking: false,
      description: 'add Phase 7 driver',
    });
  });

  it('parses {type, scope, description} when scope is present', () => {
    deepStrictEqual(parseCommitSubject('docs(adr): finalize ADR-0028'), {
      type: 'docs',
      scope: 'adr',
      breaking: false,
      description: 'finalize ADR-0028',
    });
  });

  it('parses {type, breaking: true} when bare `!` is present (ADR-0028 §P7)', () => {
    deepStrictEqual(parseCommitSubject('feat!: drop legacy field'), {
      type: 'feat',
      scope: null,
      breaking: true,
      description: 'drop legacy field',
    });
  });

  it('parses {type, scope, breaking: true} when scope and `!` both present', () => {
    deepStrictEqual(parseCommitSubject('feat(engineer)!: rename schema key'), {
      type: 'feat',
      scope: 'engineer',
      breaking: true,
      description: 'rename schema key',
    });
  });

  it('preserves additional `:` characters in description', () => {
    const r = parseCommitSubject('feat(engineer): add validate-commit.mjs: centralize regex');
    deepStrictEqual(r, {
      type: 'feat',
      scope: 'engineer',
      breaking: false,
      description: 'add validate-commit.mjs: centralize regex',
    });
  });
});

// -----------------------------------------------------------------------------
// readPackageMap — strict / lenient gradient over a fixture config file.

describe('readPackageMap — strict / lenient gradient (ADR-0028 §P3)', () => {
  it('returns sorted package keys from a well-formed config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rpmap-'));
    try {
      const cfg = join(dir, 'release-please-config.json');
      await writeFile(
        cfg,
        JSON.stringify({
          packages: {
            'companions': {},
            'plugins/runtime': {},
            'plugins/engineer': {},
          },
        }),
      );
      const keys = await readPackageMap(cfg, { strict: false });
      deepStrictEqual(
        [...keys].sort(),
        ['companions', 'plugins/engineer', 'plugins/runtime'],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns [] when the config file is missing (lenient)', async () => {
    const keys = await readPackageMap('/nonexistent/release-please-config.json', { strict: false });
    deepStrictEqual(keys, []);
  });

  it('returns [] when the config has no "packages" key (lenient)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rpmap-'));
    try {
      const cfg = join(dir, 'rp.json');
      await writeFile(cfg, JSON.stringify({}));
      const keys = await readPackageMap(cfg, { strict: false });
      deepStrictEqual(keys, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns [] when packages is not an object (lenient)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rpmap-'));
    try {
      const cfg = join(dir, 'rp.json');
      await writeFile(cfg, JSON.stringify({ packages: ['companions'] }));
      const keys = await readPackageMap(cfg, { strict: false });
      deepStrictEqual(keys, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns [] for malformed JSON (lenient)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rpmap-'));
    try {
      const cfg = join(dir, 'rp.json');
      await writeFile(cfg, '{this is not json');
      const keys = await readPackageMap(cfg, { strict: false });
      deepStrictEqual(keys, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws in strict mode when JSON is malformed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rpmap-'));
    try {
      const cfg = join(dir, 'rp.json');
      await writeFile(cfg, '{nope');
      await assertRejects(() => readPackageMap(cfg, { strict: true }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws in strict mode when packages is not an object', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rpmap-'));
    try {
      const cfg = join(dir, 'rp.json');
      await writeFile(cfg, JSON.stringify({ packages: 'string' }));
      await assertRejects(() => readPackageMap(cfg, { strict: true }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('strips trailing slashes from package keys (ADR-0028 §P12)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rpmap-'));
    try {
      const cfg = join(dir, 'rp.json');
      await writeFile(cfg, JSON.stringify({
        packages: {
          'plugins/engineer/': {},
          'plugins/runtime': {},
        },
      }));
      const keys = await readPackageMap(cfg, { strict: false });
      deepStrictEqual(
        [...keys].sort(),
        ['plugins/engineer', 'plugins/runtime'],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// isExemptPath — STRUCTURAL predicate, not a hand-curated allowlist.

describe('isExemptPath — STRUCTURAL exemption (ADR-0028 §Centralization, M5)', () => {
  const PKG_MAP = [
    'companions',
    'plugins/companions',
    'plugins/engineer',
    'plugins/orchestrator',
    'plugins/runtime',
  ];

  it('exempts root-level files that are not under any package prefix', () => {
    strictEqual(isExemptPath('AGENTS.md', PKG_MAP), true);
    strictEqual(isExemptPath('README.md', PKG_MAP), true);
    strictEqual(isExemptPath('LICENSE', PKG_MAP), true);
    strictEqual(isExemptPath('package.json', PKG_MAP), true);
  });

  it('exempts files in docs/, scripts/, tests/, kit/', () => {
    strictEqual(isExemptPath('docs/adr/0028-engineer-phase7-commit-automation.md', PKG_MAP), true);
    strictEqual(isExemptPath('scripts/validate-marketplace.mjs', PKG_MAP), true);
    strictEqual(isExemptPath('tests/engineer/test-validate-commit.mjs', PKG_MAP), true);
    strictEqual(isExemptPath('kit/lint/check-plugin-shape.mjs', PKG_MAP), true);
  });

  it('exempts future root files NOT in any allowlist (ADR-0028 §M5)', () => {
    // The whole point of structural-not-allowlist: brand-new files we
    // have never seen still get the right answer.
    strictEqual(isExemptPath('.nvmrc', PKG_MAP), true);
    strictEqual(isExemptPath('tsconfig.json', PKG_MAP), true);
    strictEqual(isExemptPath('.editorconfig', PKG_MAP), true);
  });

  it('does NOT exempt files under any package prefix', () => {
    strictEqual(isExemptPath('plugins/engineer/scripts/validate-commit.mjs', PKG_MAP), false);
    strictEqual(isExemptPath('plugins/runtime/scripts/x.mjs', PKG_MAP), false);
    strictEqual(isExemptPath('companions/contract.md', PKG_MAP), false);
  });

  it('uses segment-aware match (ADR-0028 §P11) — never substring', () => {
    // 'plugins/engineer-extras' is NOT under 'plugins/engineer'.
    strictEqual(isExemptPath('plugins/engineer-extras/x.mjs', PKG_MAP), true);
    // 'companions-doc.md' (root level) is exempt because there is no
    // 'companions' segment-prefix.
    strictEqual(isExemptPath('companions-doc.md', PKG_MAP), true);
  });
});

// -----------------------------------------------------------------------------
// detectCrossPackageRoutes — partition staged files into per-package + docs.

describe('detectCrossPackageRoutes — partition + classification', () => {
  const PKG_MAP = [
    'companions',
    'plugins/companions',
    'plugins/engineer',
    'plugins/orchestrator',
    'plugins/runtime',
  ];

  it('single-package: 1 package + 0 exempt → shouldSplit=false, 1 commit', () => {
    const r = detectCrossPackageRoutes(
      ['plugins/engineer/scripts/x.mjs', 'plugins/engineer/skills/y/SKILL.md'],
      PKG_MAP,
    );
    strictEqual(r.shouldSplit, false);
    strictEqual(r.classification, 'single-package');
    strictEqual(r.perPackageCommits.length, 1);
    strictEqual(r.perPackageCommits[0].package, 'plugins/engineer');
    strictEqual(r.docsCommit, undefined);
  });

  it('single-package-with-docs: 1 package + exempt → shouldSplit=false, 1 commit', () => {
    const r = detectCrossPackageRoutes(
      ['plugins/engineer/scripts/x.mjs', 'docs/adr/0028.md', 'AGENTS.md'],
      PKG_MAP,
    );
    strictEqual(r.shouldSplit, false);
    strictEqual(r.classification, 'single-package-with-docs');
    strictEqual(r.perPackageCommits.length, 1);
    deepStrictEqual(r.perPackageCommits[0].files.sort(), [
      'AGENTS.md',
      'docs/adr/0028.md',
      'plugins/engineer/scripts/x.mjs',
    ]);
  });

  it('multi-package: 2+ packages + 0 exempt → shouldSplit=true, N commits', () => {
    const r = detectCrossPackageRoutes(
      [
        'plugins/engineer/scripts/x.mjs',
        'plugins/runtime/skills/y.mjs',
      ],
      PKG_MAP,
    );
    strictEqual(r.shouldSplit, true);
    strictEqual(r.classification, 'multi-package');
    strictEqual(r.perPackageCommits.length, 2);
    strictEqual(r.docsCommit, undefined);
  });

  it('multi-package-with-docs: 2+ packages + exempt → shouldSplit=true, N + 1 commits', () => {
    const r = detectCrossPackageRoutes(
      [
        'plugins/engineer/scripts/x.mjs',
        'plugins/runtime/skills/y.mjs',
        'docs/adr/0028.md',
        'AGENTS.md',
      ],
      PKG_MAP,
    );
    strictEqual(r.shouldSplit, true);
    strictEqual(r.classification, 'multi-package-with-docs');
    strictEqual(r.perPackageCommits.length, 2);
    ok(r.docsCommit);
    deepStrictEqual(
      r.docsCommit.files.sort(),
      ['AGENTS.md', 'docs/adr/0028.md'],
    );
  });

  it('respects segment-aware matching (`engineer-extras` is not `engineer`)', () => {
    const r = detectCrossPackageRoutes(
      ['plugins/engineer-extras/x.mjs', 'plugins/engineer/scripts/y.mjs'],
      PKG_MAP,
    );
    // engineer-extras goes to the docs/exempt bucket.
    strictEqual(r.classification, 'single-package-with-docs');
    strictEqual(r.perPackageCommits.length, 1);
    strictEqual(r.perPackageCommits[0].package, 'plugins/engineer');
    deepStrictEqual(
      r.perPackageCommits[0].files.sort(),
      ['plugins/engineer-extras/x.mjs', 'plugins/engineer/scripts/y.mjs'],
    );
  });

  it('handles overlapping package keys by picking the longest prefix', () => {
    // 'plugins/companions' is more specific than 'companions'.
    const r = detectCrossPackageRoutes(
      ['plugins/companions/skills/x.mjs'],
      PKG_MAP,
    );
    strictEqual(r.perPackageCommits[0].package, 'plugins/companions');
  });

  it('returns empty result for no files', () => {
    const r = detectCrossPackageRoutes([], PKG_MAP);
    strictEqual(r.shouldSplit, false);
    strictEqual(r.perPackageCommits.length, 0);
    strictEqual(r.docsCommit, undefined);
  });

  it('returns single docs commit when only exempt paths changed', () => {
    const r = detectCrossPackageRoutes(
      ['docs/adr/0028.md', 'AGENTS.md'],
      PKG_MAP,
    );
    // No package keys matched → classification reflects the docs-only case.
    strictEqual(r.classification, 'docs-only');
    strictEqual(r.shouldSplit, false);
    strictEqual(r.perPackageCommits.length, 0);
    ok(r.docsCommit);
  });
});

// -----------------------------------------------------------------------------
// classifyMixedCase — the standalone enum classifier (ADR-0028 §P12).

describe('classifyMixedCase — explicit enum surface', () => {
  it('single-package: 1 package + no exempt remainder', () => {
    strictEqual(
      classifyMixedCase({ packageCount: 1, hasExempt: false }),
      'single-package',
    );
  });

  it('single-package-with-docs: 1 package + exempt remainder', () => {
    strictEqual(
      classifyMixedCase({ packageCount: 1, hasExempt: true }),
      'single-package-with-docs',
    );
  });

  it('multi-package: 2+ packages + no exempt remainder', () => {
    strictEqual(
      classifyMixedCase({ packageCount: 2, hasExempt: false }),
      'multi-package',
    );
    strictEqual(
      classifyMixedCase({ packageCount: 5, hasExempt: false }),
      'multi-package',
    );
  });

  it('multi-package-with-docs: 2+ packages + exempt remainder', () => {
    strictEqual(
      classifyMixedCase({ packageCount: 2, hasExempt: true }),
      'multi-package-with-docs',
    );
  });

  it('docs-only: 0 packages + exempt remainder', () => {
    strictEqual(
      classifyMixedCase({ packageCount: 0, hasExempt: true }),
      'docs-only',
    );
  });

  it('empty: 0 packages + no exempt remainder (degenerate)', () => {
    strictEqual(
      classifyMixedCase({ packageCount: 0, hasExempt: false }),
      'empty',
    );
  });
});

// -----------------------------------------------------------------------------
// Helpers

async function assertRejects(fn) {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  ok(threw, 'expected the function to throw');
}
