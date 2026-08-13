#!/usr/bin/env node
// Enforcement for the ADR-0051 §Decision 2 release obligation, decided by
// ADR-0052: a change to a packaged asset a runtime command reads to reach a
// verdict is not in force until a `plugins/runtime` release ships it.
//
// This is a HISTORY-AND-TAG RECONCILIATION check, not a PR-time metadata gate.
// The distinction is the whole decision, so it is worth stating plainly:
//
//   The natural check — "a protected asset changed AND the version changed in
//   the same diff" — cannot work in this repository. A feature PR never
//   changes the version; release-please changes it later, in its own PR. That
//   check rejects every legitimate refresh, and exempting source PRs re-opens
//   the hole it exists to close. So the invariant is evaluated ACROSS the
//   merge->release boundary instead: at a ref, do the released bytes match the
//   accepted bytes?
//
// What it verifies (ADR-0052 §Decision 5): the newest `plugin-runtime-v*` tag
// reachable from the evaluated ref must carry that ref's protected tree. The
// state classifies as one of:
//
//   fulfilled          — a reachable tag carries the current protected tree
//   release_in_flight  — the manifest advanced, the tag is not yet cut
//   outstanding_debt   — same released version, different protected tree  (FAILS)
//
// Main going red between a protected change and its release is the INTENDED
// signal, not a defect — the same posture release-please.yml already documents
// for the proof-coupled assertion. The measured median window is 5.3h.
//
// What it deliberately does NOT do:
//
//   - It does not prove causation. A later unrelated runtime release
//     legitimately clears the debt because it ships the bytes, which is
//     exactly what plugin-runtime-v0.90.0 did for the 16b1833 counterexample.
//     What it measures is how long accepted and released bytes disagreed,
//     which is the harm.
//   - It does not read commit types, PR titles, or authors. There is no
//     actor-wide bypass for release-please: a release commit passes because
//     its tag carries the tree, which is the same invariant everyone else
//     satisfies.
//   - It does not diff against a PR base. There is no base to be absent, no
//     base/head union to compute, and no rename detection to tune, because
//     the comparison is between two full protected file SETS rather than
//     between two diffs. Deleting a protected file cannot evade the check:
//     the entry disappears from the set, so the digest moves.
//
// Usage:
//   node scripts/check-release-obligation.mjs                 # report + exit code
//   node scripts/check-release-obligation.mjs --json
//   node scripts/check-release-obligation.mjs --ref <commit>   # evaluate at a ref
//   node scripts/check-release-obligation.mjs --epoch <commit> # override the epoch
//
// Exit codes:
//   0 — fulfilled, release in flight, or divergence predating the epoch
//   1 — outstanding debt, or the check could not run (fail-closed)

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gitHistoryAvailable } from './check-doc-evidence.mjs';

/**
 * Protected paths, as git pathspecs, per ADR-0052 §Decision 2.
 *
 * A DIRECTORY pattern rather than a file list, deliberately. An enumerated
 * list has to be kept in sync with `PACKAGED_SCHEMA_FILES`, and this
 * repository already has a live instance of that failure mode:
 * `check-doc-evidence.mjs`'s `EVIDENCE_DOCS` is a literal array that does not
 * expand globs. `plugins/runtime/data/schemas` therefore covers the next
 * schema added without an edit here, and settles the one genuinely ambiguous
 * member — `runtime-plugin-set-1.0.json`, registered in
 * `PACKAGED_SCHEMA_FILES` but loaded today only by tests.
 *
 * `plugins/attention/data/runtime-floors.json` is a genuine verdict input
 * (`session-readiness.mjs` resolves and reads it) but is OUT of first scope
 * per §Decision 3: it is owned by a different release-please package, so
 * covering it needs an asset->owning-package registry and a cross-package
 * promotion rule. That is ADR-0052 item 6's follow-up, not this file's job.
 */
export const PROTECTED_PATHS = Object.freeze([
  'plugins/runtime/docs/host-parity-baseline.md',
  'plugins/runtime/data/plugin-set.json',
  'plugins/runtime/data/schemas',
]);

export const RUNTIME_PACKAGE = 'plugins/runtime';
export const TAG_PREFIX = 'plugin-runtime-v';

/**
 * Commits at or before this one are grandfathered.
 *
 * Without an epoch the check retroactively condemns historical protected
 * changes and main is red from the first run — the repository has 47 such
 * commits, and 24 of the 38 baseline changes among them were authored under
 * the `docs(runtime): refresh …` form that routes no release.
 *
 * ADR-0052 §Decision 5 names "this ADR's implementing commit" as the epoch.
 * That commit's own sha cannot be known while it is being authored, so the
 * epoch is pinned to its immediate predecessor — the last ADR-0052 commit.
 * The two boundaries are equivalent because the implementing commit does not
 * itself touch a protected path, which `tests/scripts/test-release-obligation.mjs`
 * asserts rather than assumes.
 *
 * The clause is inert once any post-epoch protected change exists, which is
 * what makes it a one-time grandfather rather than a standing exemption.
 */
export const ADOPTION_EPOCH = '84de4864463cfcec6cf7083b37863c717f3e4c1b';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function gitOk(repoRoot, args) {
  try {
    git(repoRoot, args);
    return true;
  } catch {
    return false;
  }
}

export function parseSemver(value) {
  const m = typeof value === 'string' ? value.match(SEMVER) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * The protected file SET at a ref: every tracked file under a protected
 * pathspec, as (mode, blob, path).
 *
 * Mode is included so a permission flip counts as a change, and path is
 * included so a rename counts as one — both alter what a release ships. The
 * set is compared whole rather than diffed, which is what makes deletion and
 * rename evasion structurally impossible instead of a case to remember.
 */
export function protectedEntries(repoRoot, ref) {
  const out = git(repoRoot, ['ls-tree', '-r', ref, '--', ...PROTECTED_PATHS]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      const [mode, type, object] = line.slice(0, tab).split(' ');
      return { mode, type, object, path: line.slice(tab + 1) };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function digestEntries(entries) {
  const h = createHash('sha256');
  for (const e of entries) h.update(`${e.mode} ${e.object} ${e.path}\n`);
  return h.digest('hex');
}

/**
 * Runtime tags reachable from `ref`, newest first.
 *
 * A tag whose suffix is not a plain X.Y.Z is reported rather than skipped. A
 * silent skip would let a tag-grammar change (a prerelease scheme, say) move
 * which tag counts as "newest" without anyone noticing, and the newest tag is
 * the entire anchor of this check.
 */
export function reachableRuntimeTags(repoRoot, ref) {
  const names = git(repoRoot, ['tag', '--list', `${TAG_PREFIX}*`, '--merged', ref])
    .split('\n')
    .filter(Boolean);
  const parsed = [];
  const unparsed = [];
  for (const name of names) {
    const version = name.slice(TAG_PREFIX.length);
    if (parseSemver(version)) parsed.push({ name, version });
    else unparsed.push(name);
  }
  parsed.sort((a, b) => compareSemver(a.version, b.version));
  return { tags: parsed.reverse(), unparsed };
}

function jsonAtRef(repoRoot, ref, path) {
  try {
    return JSON.parse(git(repoRoot, ['show', `${ref}:${path}`]));
  } catch {
    return null;
  }
}

/**
 * The runtime version at a ref, plus the two plugin manifests as
 * corroboration.
 *
 * Per ADR-0052 §Decision 4 the plugin manifests are promotion EVIDENCE, never
 * protected triggers: they are what release-please rewrites to discharge an
 * obligation, so treating a change to them as a new obligation would recurse
 * without end. They are read here only to catch a half-applied bump, which no
 * other gate would see.
 */
export function releaseStateAt(repoRoot, ref) {
  const manifest = jsonAtRef(repoRoot, ref, '.release-please-manifest.json');
  const claude = jsonAtRef(repoRoot, ref, `${RUNTIME_PACKAGE}/.claude-plugin/plugin.json`);
  const codex = jsonAtRef(repoRoot, ref, `${RUNTIME_PACKAGE}/.codex-plugin/plugin.json`);
  return {
    manifestVersion: manifest ? manifest[RUNTIME_PACKAGE] ?? null : null,
    claudeVersion: claude ? claude.version ?? null : null,
    codexVersion: codex ? codex.version ?? null : null,
  };
}

/** Post-epoch commits in `sinceRef..ref` that touched a protected path. */
export function protectedChangesInScope(repoRoot, { sinceRef, ref, epoch }) {
  const commits = git(repoRoot, ['rev-list', `${sinceRef}..${ref}`, '--', ...PROTECTED_PATHS])
    .split('\n')
    .filter(Boolean);
  return commits
    .filter((sha) => gitOk(repoRoot, ['merge-base', '--is-ancestor', epoch, sha]))
    .map((sha) => ({
      sha,
      subject: git(repoRoot, ['show', '-s', '--format=%s', sha]).trim(),
    }));
}

/**
 * Classify the release-obligation state at a ref.
 *
 * Returns `{ ran: false, reason }` for every condition under which the check
 * cannot reach a trustworthy verdict. Callers must treat that as FAILURE, not
 * as a skip: a check that silently no-ops reads as coverage it does not have,
 * which is the reason full-tests.yml already checks out at fetch-depth: 0.
 */
export function classify(repoRoot, { ref = 'HEAD', epoch = ADOPTION_EPOCH } = {}) {
  const fail = (reason) => ({ ran: false, reason, state: null });

  const availability = gitHistoryAvailable(repoRoot);
  if (!availability.ok) return fail(availability.reason);

  let head;
  try {
    head = git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  } catch {
    return fail(`ref '${ref}' does not resolve to a commit in this repository`);
  }
  if (!gitOk(repoRoot, ['rev-parse', '--verify', `${epoch}^{commit}`])) {
    return fail(`adoption epoch '${epoch}' does not resolve to a commit in this repository`);
  }

  const entries = protectedEntries(repoRoot, head);
  // A zero-size protected set is fail-closed, never "nothing changed". It
  // means either the pathspecs drifted away from the tree or every protected
  // asset was deleted, and a digest over an empty set would compare equal at
  // every ref — a permanently vacuous green, which is the exact failure mode
  // this repository's test conventions exist to prevent.
  if (entries.length === 0) {
    return fail(
      `no tracked files matched the protected pathspecs at ${ref} `
        + `(${PROTECTED_PATHS.join(', ')}) — the patterns have drifted from the tree, `
        + 'or every protected asset was deleted; both need a human',
    );
  }

  const { tags, unparsed } = reachableRuntimeTags(repoRoot, head);
  if (unparsed.length > 0) {
    return fail(
      `${unparsed.length} ${TAG_PREFIX}* tag(s) are not plain X.Y.Z (${unparsed.join(', ')}) — `
        + 'the newest-tag anchor is no longer well defined; teach this check the new grammar',
    );
  }
  if (tags.length === 0) return fail(`no ${TAG_PREFIX}* tag is reachable from ${ref}`);

  const newestTag = tags[0];
  const release = releaseStateAt(repoRoot, head);
  if (!parseSemver(release.manifestVersion)) {
    return fail(
      `.release-please-manifest.json at ${ref} does not carry a plain X.Y.Z version for `
        + `${RUNTIME_PACKAGE} (got ${JSON.stringify(release.manifestVersion)})`,
    );
  }

  const headDigest = digestEntries(entries);
  const tagDigest = digestEntries(protectedEntries(repoRoot, newestTag.name));

  const base = {
    ran: true,
    reason: null,
    ref,
    resolvedRef: head,
    epoch,
    protectedFiles: entries.map((e) => e.path),
    headDigest,
    tagDigest,
    newestTag: newestTag.name,
    tagVersion: newestTag.version,
    ...release,
  };

  // §Decision 4 — evidence, not trigger. A disagreement here means a bump was
  // applied to some but not all of the three version sources, which no other
  // gate inspects.
  const versions = [release.manifestVersion, release.claudeVersion, release.codexVersion];
  if (new Set(versions).size !== 1) {
    return {
      ...base,
      state: 'manifest_disagreement',
      failing: true,
      detail:
        `the three runtime version sources disagree at ${ref}: `
        + `.release-please-manifest.json=${release.manifestVersion}, `
        + `.claude-plugin/plugin.json=${release.claudeVersion}, `
        + `.codex-plugin/plugin.json=${release.codexVersion}`,
    };
  }

  if (headDigest === tagDigest) {
    return { ...base, state: 'fulfilled', failing: false, detail: `${newestTag.name} carries the protected tree at ${ref}` };
  }

  const versionDelta = compareSemver(release.manifestVersion, newestTag.version);

  // A released version that DECREASED, or was reused for different bytes, is
  // the one rollback shape this design cannot express. Rolling a protected
  // asset back is legitimate; doing it by reusing or lowering a version is
  // not, because the released identity would then name two different trees.
  // The rollback path is a forward patch carrying the restored bytes.
  if (versionDelta < 0) {
    return {
      ...base,
      state: 'version_regression',
      failing: true,
      detail:
        `${RUNTIME_PACKAGE} is ${release.manifestVersion} at ${ref} but ${newestTag.name} is already `
        + `released — a version may never decrease. Roll a protected asset back with a FORWARD patch `
        + 'that carries the restored bytes and takes the next version, never by reusing or lowering one.',
    };
  }

  const inScope = protectedChangesInScope(repoRoot, { sinceRef: newestTag.name, ref: head, epoch });

  if (versionDelta > 0) {
    // A release commit is on this ref but its tag is not reachable yet. The
    // window is short — the median gap from the preceding main commit to the
    // release commit is 4m48s across 163 releases — and it self-corrects: once
    // the tag exists the versions are equal again and any protected change the
    // tag did not carry re-classifies as debt on the very next run.
    return {
      ...base,
      state: 'release_in_flight',
      failing: false,
      inScopeChanges: inScope,
      detail:
        `${RUNTIME_PACKAGE} advanced to ${release.manifestVersion} at ${ref} but the newest reachable tag `
        + `is ${newestTag.name}; the tag has not been cut yet`,
    };
  }

  if (inScope.length === 0) {
    return {
      ...base,
      state: 'pre_epoch_divergence',
      failing: false,
      inScopeChanges: [],
      detail:
        `the protected tree at ${ref} differs from ${newestTag.name}, but no commit after the adoption `
        + `epoch ${epoch.slice(0, 7)} touched a protected path — grandfathered by ADR-0052 §Decision 5`,
    };
  }

  return {
    ...base,
    state: 'outstanding_debt',
    failing: true,
    inScopeChanges: inScope,
    detail:
      `${RUNTIME_PACKAGE} is released at ${newestTag.version} and stayed there, but the protected tree at `
      + `${ref} differs from the one ${newestTag.name} carries. ${inScope.length} post-epoch commit(s) changed `
      + 'a protected path without a release shipping the result.',
  };
}

const invokedAsCLI = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedAsCLI) {
  const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
  const argOf = (flag) => {
    const i = process.argv.indexOf(flag);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
  };
  const result = classify(REPO_ROOT, { ref: argOf('--ref') ?? 'HEAD', epoch: argOf('--epoch') ?? ADOPTION_EPOCH });

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.ran) {
    console.error(`release-obligation: COULD NOT RUN — ${result.reason}`);
  } else {
    const mark = result.failing ? '✗' : '✓';
    console.log(`${mark} release-obligation: ${result.state}`);
    console.log(`  ${result.detail}`);
    console.log(
      `  ref=${result.resolvedRef.slice(0, 7)} protected=${result.protectedFiles.length} file(s) `
        + `newest-tag=${result.newestTag} manifest=${result.manifestVersion}`,
    );
    for (const c of result.inScopeChanges ?? []) console.log(`  · ${c.sha.slice(0, 7)} ${c.subject}`);
    if (result.failing) {
      console.log('  Remedy: land a plugins/runtime release that ships these bytes (a bump-inducing');
      console.log('  conventional type on the squash subject routes one — see AGENTS.md §Release process).');
    }
  }

  process.exit(!result.ran || result.failing ? 1 : 0);
}
