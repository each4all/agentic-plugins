// Centralized Conventional Commit + release-please cross-package
// routing utilities for the engineer plugin (ADR-0028 §Centralization).
//
// Pure module per the stop-archive.mjs:222-228 purity invariant.
// `readPackageMap` is the only exception: it accepts the config file
// path as a parameter so tests can drive it with fixtures rather than
// reading whatever happens to live at the repo root.
//
// stop-archive.mjs and plugins/engineer/adapters/claude/hooks/_shared.mjs
// re-export `CONVENTIONAL_COMMIT_RE` from this module — that collapses
// the previous two-inline-copies arrangement to a single source of
// truth (ADR-0028 §Context).

import { readFile } from 'node:fs/promises';

// -----------------------------------------------------------------------------
// CONVENTIONAL_COMMIT_RE — the single canonical regex.

export const CONVENTIONAL_COMMIT_RE =
  /^(feat|fix|docs|ci|refactor|chore|test)(\([^)]+\))?!?:/;

// -----------------------------------------------------------------------------
// parseCommitSubject — structured parse with `!` breaking awareness.

const STRUCTURED_RE =
  /^(feat|fix|docs|ci|refactor|chore|test)(\(([^)]+)\))?(!)?:\s?(.*)$/;

export function parseCommitSubject(subject) {
  if (typeof subject !== 'string' || subject.length === 0) return null;
  const m = STRUCTURED_RE.exec(subject);
  if (!m) return null;
  const [, type, , rawScope, bang, description] = m;
  return {
    type,
    scope: rawScope ?? null,
    breaking: bang === '!',
    description: description ?? '',
  };
}

// -----------------------------------------------------------------------------
// readPackageMap — strict / lenient gradient over a config file.

export async function readPackageMap(configPath, { strict = false } = {}) {
  let raw;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    if (strict) {
      throw new Error(
        `readPackageMap: cannot read ${configPath} in strict mode: ${err.message}`,
      );
    }
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (strict) {
      throw new Error(
        `readPackageMap: ${configPath} is not valid JSON in strict mode: ${err.message}`,
      );
    }
    return [];
  }

  const pkgs = parsed && typeof parsed === 'object' ? parsed.packages : undefined;
  if (!pkgs || typeof pkgs !== 'object' || Array.isArray(pkgs)) {
    if (strict) {
      throw new Error(
        `readPackageMap: ${configPath} packages must be an object in strict mode`,
      );
    }
    return [];
  }

  return Object.keys(pkgs)
    .map((key) => key.replace(/\/+$/, ''))
    .filter((key) => key.length > 0)
    .sort();
}

// -----------------------------------------------------------------------------
// assertSafePath — pathspec injection defense (ADR-0028 N1).
//
// Single source of truth for the four checks that protect every `git add
// <path>` consumer of a stored path (Layer 2 write helpers in state.mjs
// and Layer 3 phase7-commit.mjs read-side pre-stage re-validation). The
// helper throws on any of:
//
//   - empty / non-string input
//   - leading "-"  (flag injection vector: -A / -f / --force)
//   - leading ":"  (git pathspec magic: `:(top)`, `:!exclude`, `:/from-root`)
//   - absolute     (`/etc/passwd`, `/tmp/...`)
//   - ".." traversal segments (`..`, `../escape`, `foo/../bar`)
//
// PR1 (ADR-0028 §Layer-2) inlined these checks in state.mjs
// recordManifestEntry; the N1 deferral filed in PR1's merge commit body
// promoted the checks into a shared helper for Layer 3 to re-use without
// duplication.

export function assertSafePath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error(
      `assertSafePath: path must be a non-empty string (got ${JSON.stringify(filePath)})`,
    );
  }
  if (filePath.startsWith('-')) {
    throw new Error(
      `assertSafePath: path must not start with "-" (leading dash is a flag injection vector: -A / -f); ` +
      `got ${JSON.stringify(filePath)}`,
    );
  }
  if (filePath.startsWith(':')) {
    throw new Error(
      `assertSafePath: path must not start with ":" (git pathspec magic prefix broadens scope); ` +
      `got ${JSON.stringify(filePath)}`,
    );
  }
  if (filePath.startsWith('/')) {
    throw new Error(
      `assertSafePath: path must be repo-relative, not absolute; got ${JSON.stringify(filePath)}`,
    );
  }
  if (filePath === '..' || filePath.startsWith('../') || filePath.includes('/../')) {
    throw new Error(
      `assertSafePath: path must not contain ".." traversal segments; got ${JSON.stringify(filePath)}`,
    );
  }
}

// -----------------------------------------------------------------------------
// isExemptPath — STRUCTURAL "not in any package prefix" predicate.

export function isExemptPath(path, packageMap) {
  if (typeof path !== 'string' || path.length === 0) return true;
  return !packageMap.some((prefix) => isSegmentPrefixOf(prefix, path));
}

function isSegmentPrefixOf(prefix, path) {
  if (typeof prefix !== 'string' || prefix.length === 0) return false;
  if (path === prefix) return true;
  return path.startsWith(`${prefix}/`);
}

function pickLongestPrefix(path, packageMap) {
  let best = null;
  for (const prefix of packageMap) {
    if (!isSegmentPrefixOf(prefix, path)) continue;
    if (best === null || prefix.length > best.length) best = prefix;
  }
  return best;
}

// -----------------------------------------------------------------------------
// detectCrossPackageRoutes — partition staged files + classify.

export function detectCrossPackageRoutes(files, packageMap) {
  const perPackageMap = new Map(); // package-key → files[]
  const exemptFiles = [];

  for (const file of files) {
    const prefix = pickLongestPrefix(file, packageMap);
    if (prefix === null) {
      exemptFiles.push(file);
    } else {
      const arr = perPackageMap.get(prefix) ?? [];
      arr.push(file);
      perPackageMap.set(prefix, arr);
    }
  }

  const packageCount = perPackageMap.size;
  const hasExempt = exemptFiles.length > 0;
  const classification = classifyMixedCase({ packageCount, hasExempt });

  // Per ADR-0028 §P12:
  //   single-package: 1 commit (package files only)
  //   single-package-with-docs: 1 commit (package files + exempt folded in)
  //   multi-package: N commits (each package only)
  //   multi-package-with-docs: N + 1 commits (last commit is docs-only)
  //   docs-only: 0 package commits + 1 docs commit
  //   empty: nothing to commit

  const perPackageCommits = [];
  let docsCommit;

  if (classification === 'single-package') {
    const [pkg] = perPackageMap.keys();
    perPackageCommits.push({ package: pkg, files: perPackageMap.get(pkg) });
  } else if (classification === 'single-package-with-docs') {
    const [pkg] = perPackageMap.keys();
    perPackageCommits.push({
      package: pkg,
      files: [...perPackageMap.get(pkg), ...exemptFiles],
    });
  } else if (classification === 'multi-package') {
    for (const [pkg, pkgFiles] of perPackageMap) {
      perPackageCommits.push({ package: pkg, files: pkgFiles });
    }
  } else if (classification === 'multi-package-with-docs') {
    for (const [pkg, pkgFiles] of perPackageMap) {
      perPackageCommits.push({ package: pkg, files: pkgFiles });
    }
    docsCommit = { files: exemptFiles };
  } else if (classification === 'docs-only') {
    docsCommit = { files: exemptFiles };
  }
  // 'empty' → perPackageCommits stays empty, docsCommit stays undefined

  const shouldSplit =
    classification === 'multi-package' ||
    classification === 'multi-package-with-docs';

  return {
    shouldSplit,
    classification,
    perPackageCommits,
    ...(docsCommit ? { docsCommit } : {}),
  };
}

// -----------------------------------------------------------------------------
// classifyMixedCase — explicit enum surface (ADR-0028 §P12).

export function classifyMixedCase({ packageCount, hasExempt }) {
  if (packageCount === 0) return hasExempt ? 'docs-only' : 'empty';
  if (packageCount === 1) {
    return hasExempt ? 'single-package-with-docs' : 'single-package';
  }
  return hasExempt ? 'multi-package-with-docs' : 'multi-package';
}
