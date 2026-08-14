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
 * What makes the two boundaries equivalent is not that the implementing commit
 * touches no protected path (an assertion about a moving branch, which goes
 * permanently red the first time a legitimate refresh lands) but that the
 * epoch itself classifies as `fulfilled`: the clause therefore grandfathers
 * nothing. `tests/scripts/test-release-obligation.mjs` asserts that, and it
 * stays true forever.
 *
 * Scope is decided by comparing the protected tree here against the tree at
 * the epoch, never by asking which commits descend from it — see the comment
 * on `protectedChangesInWindow` for the merge that defeated the graph-walking
 * version. The clause is inert as soon as the tree moves.
 */
export const ADOPTION_EPOCH = '84de4864463cfcec6cf7083b37863c717f3e4c1b';

// Strict: SemVer forbids leading zeroes, so `01.0.0` is not a version. A
// permissive pattern would let two spellings compare equal and make the
// newest-tag anchor depend on enumeration order.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const RELEASE_MANIFEST = '.release-please-manifest.json';

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
  const manifest = jsonAtRef(repoRoot, ref, RELEASE_MANIFEST);
  const claude = jsonAtRef(repoRoot, ref, `${RUNTIME_PACKAGE}/.claude-plugin/plugin.json`);
  const codex = jsonAtRef(repoRoot, ref, `${RUNTIME_PACKAGE}/.codex-plugin/plugin.json`);
  return {
    manifestVersion: manifest ? manifest[RUNTIME_PACKAGE] ?? null : null,
    claudeVersion: claude ? claude.version ?? null : null,
    codexVersion: codex ? codex.version ?? null : null,
  };
}

/**
 * Commits in `sinceRef..ref` that touched a protected path — REPORTING ONLY.
 *
 * No verdict depends on this list, and that separation is deliberate.
 * Path-limited `rev-list` applies git's default history simplification, so a
 * merge that first introduces a protected change to the integration branch
 * can be omitted in favour of the side-branch commit it came from. An earlier
 * revision of this file decided epoch scope by walking that list and asking
 * whether each commit descended from the epoch, and a merge of a side branch
 * forked BEFORE the epoch grandfathered bytes that entered main AFTER it —
 * reproduced, not theorised. `--show-pulls` restores the introducing merge for
 * the report; the verdict now compares content instead, which no simplification
 * rule can perturb.
 */
export function protectedChangesInWindow(repoRoot, { sinceRef, ref }) {
  return git(repoRoot, ['rev-list', '--show-pulls', `${sinceRef}..${ref}`, '--', ...PROTECTED_PATHS])
    .split('\n')
    .filter(Boolean)
    .map((sha) => ({
      sha,
      subject: git(repoRoot, ['show', '-s', '--format=%s', sha]).trim(),
    }));
}

/** The newest commit in `sinceRef..ref` that rewrote the release-please manifest. */
function newestManifestAdvance(repoRoot, { sinceRef, ref }) {
  const out = git(repoRoot, ['rev-list', '--show-pulls', '-1', `${sinceRef}..${ref}`, '--', RELEASE_MANIFEST]).trim();
  return out || null;
}

function isAncestor(repoRoot, a, b) {
  return gitOk(repoRoot, ['merge-base', '--is-ancestor', a, b]);
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

  // A tag must name the version its own commit set. Verified to hold across
  // all 139 runtime tags at authoring time, so asserting it costs nothing
  // today and refuses a whole class of corrupt anchor: a tag moved onto a
  // commit from a different release, or fabricated at a version no release
  // commit ever declared. Without it, tagging any commit
  // `plugin-runtime-v<anything-higher>` discharges every outstanding
  // obligation — reproduced against this checker before the assertion existed.
  //
  // It does NOT close tag mutability in general: a tag force-moved WITHIN one
  // version's window still satisfies this. ADR-0052 §Consequences records that
  // residual honestly rather than claiming immutability is proven.
  const tagRelease = releaseStateAt(repoRoot, newestTag.name);
  if (tagRelease.manifestVersion !== newestTag.version) {
    return fail(
      `${newestTag.name} points at a commit whose ${RELEASE_MANIFEST} declares `
        + `${JSON.stringify(tagRelease.manifestVersion)} for ${RUNTIME_PACKAGE}, not ${newestTag.version} — `
        + 'a release tag must name the version its own commit set; this one was moved or fabricated',
    );
  }
  const tagEntries = protectedEntries(repoRoot, newestTag.name);
  if (tagEntries.length === 0) {
    return fail(
      `${newestTag.name} carries no files under the protected pathspecs — the released tree cannot be `
        + 'compared against, and treating "nothing released" as a match would pass everything',
    );
  }

  const release = releaseStateAt(repoRoot, head);
  if (!parseSemver(release.manifestVersion)) {
    return fail(
      `${RELEASE_MANIFEST} at ${ref} does not carry a plain X.Y.Z version for `
        + `${RUNTIME_PACKAGE} (got ${JSON.stringify(release.manifestVersion)})`,
    );
  }

  const headDigest = digestEntries(entries);
  const tagDigest = digestEntries(tagEntries);

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

  const versionDelta = compareSemver(release.manifestVersion, newestTag.version);

  // Checked BEFORE the digest comparison, not after. A version decrease with
  // an unchanged protected tree is still a decrease, and behind the
  // `fulfilled` short-circuit this branch was unreachable in exactly that
  // case — the original test passed only because its fixture happened to move
  // the tree as well.
  //
  // Rolling a protected asset back is legitimate; doing it by reusing or
  // lowering a version is not, because the released identity would then name
  // two different trees. The rollback path is a forward patch carrying the
  // restored bytes.
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

  if (headDigest === tagDigest) {
    return { ...base, state: 'fulfilled', failing: false, detail: `${newestTag.name} carries the protected tree at ${ref}` };
  }

  const inWindow = protectedChangesInWindow(repoRoot, { sinceRef: newestTag.name, ref: head });

  if (versionDelta > 0) {
    // A release commit is on this ref but its tag is not reachable yet. The
    // window is short — the median gap from the preceding main commit to the
    // release commit is 4m48s across 163 releases.
    //
    // In-flight is credible only for bytes the PENDING tag will actually
    // carry. release-please cuts that tag at the commit that advanced the
    // manifest, so a protected change landing after it is already provably
    // unreleased — not a timing artifact, and not something to wait for the
    // tag to reveal. Comparing the tree at that commit against the tree here
    // decides it from content; an earlier revision passed unconditionally on
    // `versionDelta > 0` and masked such changes for as long as the tag stayed
    // uncut, which is indefinitely if the release workflow fails.
    const advance = newestManifestAdvance(repoRoot, { sinceRef: newestTag.name, ref: head });
    const pendingDigest = advance ? digestEntries(protectedEntries(repoRoot, advance)) : null;
    if (advance && pendingDigest !== headDigest) {
      return {
        ...base,
        state: 'outstanding_debt',
        failing: true,
        inScopeChanges: inWindow,
        detail:
          `${RUNTIME_PACKAGE} advanced to ${release.manifestVersion} at ${advance.slice(0, 7)}, but the protected `
          + `tree moved again after it. The pending ${TAG_PREFIX}${release.manifestVersion} tag is cut at that `
          + 'commit and will not carry the current bytes, so they owe a release of their own.',
      };
    }
    return {
      ...base,
      state: 'release_in_flight',
      failing: false,
      inScopeChanges: inWindow,
      detail:
        `${RUNTIME_PACKAGE} advanced to ${release.manifestVersion} at ${ref} but the newest reachable tag `
        + `is ${newestTag.name}; the tag has not been cut yet`,
    };
  }

  // Epoch scope, decided by CONTENT rather than by walking the commit graph.
  //
  // Two questions, in order. Does this ref predate adoption at all? If the
  // epoch is not an ancestor, the ref is older history and nothing here is in
  // scope. Otherwise: has the protected tree moved since the epoch? If it has
  // not, whatever divergence exists was already present when the rule was
  // adopted and is exactly what the grandfather clause is for. If it has, the
  // change is post-epoch by definition — no matter which commit git's history
  // simplification decides to attribute it to.
  if (!isAncestor(repoRoot, epoch, head)) {
    return {
      ...base,
      state: 'pre_epoch_divergence',
      failing: false,
      inScopeChanges: [],
      detail:
        `${ref} predates the adoption epoch ${epoch.slice(0, 7)} (the epoch is not among its ancestors), `
        + 'so ADR-0052 §Decision 5 does not reach it',
    };
  }
  // Both halves are required. Equal trees alone is not enough: a tree can move
  // away and come back, and a revert of released bytes back to their
  // pre-release state reproduces the epoch's tree exactly while genuinely
  // owing a release. Requiring the anchor tag to be unchanged too says what is
  // actually meant — this is the same divergence, against the same release,
  // that existed when the rule was adopted. Once a release goes by without
  // discharging it, the amnesty is spent and it is live debt.
  const epochDigest = digestEntries(protectedEntries(repoRoot, epoch));
  const epochTags = reachableRuntimeTags(repoRoot, epoch).tags;
  const epochAnchor = epochTags.length > 0 ? epochTags[0].name : null;
  if (epochDigest === headDigest && epochAnchor === newestTag.name) {
    return {
      ...base,
      state: 'pre_epoch_divergence',
      failing: false,
      inScopeChanges: [],
      detail:
        `the protected tree at ${ref} differs from ${newestTag.name}, but it is unchanged since the adoption `
        + `epoch ${epoch.slice(0, 7)} and no release has been cut since — the divergence predates the rule `
        + 'and is grandfathered',
    };
  }

  return {
    ...base,
    state: 'outstanding_debt',
    failing: true,
    inScopeChanges: inWindow,
    detail:
      `${RUNTIME_PACKAGE} is released at ${newestTag.version} and stayed there, but the protected tree at `
      + `${ref} differs both from the one ${newestTag.name} carries and from the adoption epoch — a change `
      + 'after adoption has not been shipped by a release.',
  };
}

const invokedAsCLI = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedAsCLI) {
  const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
  // A flag given without a value is an error, never a silent fall back to the
  // default: `--ref` with a typo'd argument would otherwise audit HEAD and
  // report green for a ref nobody asked about.
  const argOf = (flag) => {
    const i = process.argv.indexOf(flag);
    if (i === -1) return undefined;
    const value = process.argv[i + 1];
    if (!value || value.startsWith('--')) {
      console.error(`✗ ${flag} requires a value`);
      process.exit(1);
    }
    return value;
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
