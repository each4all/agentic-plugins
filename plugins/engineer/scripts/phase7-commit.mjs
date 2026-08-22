#!/usr/bin/env node
// plugins/engineer/scripts/phase7-commit.mjs
//
// ADR-0028 §Layer-3 — engineer /engineer:start Phase 7 commit automation
// driver. Host-shared: commands/start.md Phase 7 (Claude) and
// skills/start/SKILL.md Phase 7 narration (Codex) both invoke this CLI.
//
// Two modes (per the in-loop agent flow — neither host has stdin
// pipelines to prompt the user from inside Node):
//
//   --mode plan
//     Read the workflow, compute the staging set (git_changes vs
//     commit_manifest), classify cross-package routes (P12 enum), and
//     suggest subjects. Emit a structured JSON plan on stdout. NO git
//     mutations. The agent presents the plan to the user; the user
//     accepts / edits / cancels via the agent dialog.
//
//   --mode execute
//     Receive the user-approved subject(s), stage with explicit
//     pathspecs, commit, run post-commit gates (P11 / no-children /
//     clean-after-commit / P10 sync writebackParent), and finally
//     write set-terminal (P5 terminal-marker-last invariant). Any
//     failure surfaces a refine-fallback message to stderr with a
//     non-zero exit code; the workflow stays active (terminal_marker
//     unset) for the user to address via /engineer:refine.
//
// Never throws past main(); every error path returns an exit code +
// stderr message. P14 — PR2 itself is hand-landed; the first observed
// invocation of this driver is the next /engineer:start after PR2
// merges.

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  CONVENTIONAL_COMMIT_RE,
  parseCommitSubject,
  readPackageMap,
  detectCrossPackageRoutes,
  classifyMixedCase,
  assertSafePath,
} from './validate-commit.mjs';
import {
  parseWorkflowFile,
  noPendingEnsembleCheck,
  noActiveChildrenCheck,
  setTerminal,
  setParentWritebackMarker,
  clearParentWritebackMarker,
} from './state.mjs';
import { writebackParent } from './parent-writeback.mjs';

const execFileAsync = promisify(execFile);

// =============================================================================
// Constants
// =============================================================================

const WORKFLOW_STORAGE_PREFIX = '.agentic-plugins/state/';

// P9 — trailer allowlist (case-insensitive). Lines beginning with these
// are stripped from sources 1 and 3 of body composition so accidental
// `BREAKING CHANGE:` propagation does not route to every package
// release-please tracks (ADR-0016 §28b5eb8 incident).
//
// PR4 review F2 (Phase 5 Angle E): `Workflow-ID` is included so a prior
// commit's Workflow-ID trailer, if it ever rides into
// `original_request` or `ensemble_results.summary` (e.g. user pastes a
// previous commit message into the feature description), does not
// propagate into the new commit body. composeBody re-appends a fresh
// Workflow-ID for THIS workflow AFTER stripTrailers runs — see the
// `parts.push(\`${WORKFLOW_ID_TRAILER_PREFIX} ${workflowId}\`)` block
// below — so the only Workflow-ID that survives is the current one.
// This closes the A2 false-positive recovery vector where a stale
// trailer would cause probeLandedRecovery to match an old workflow.
const TRAILER_RE =
  /^(BREAKING CHANGE|BREAKING-CHANGE|Co-Authored-By|Closes|Fixes|Refs|Workflow-ID):/i;

// P12 — classifyMixedCase enum surface. Any consumer switch that does
// not match every value is a programmer error; default-throws inside
// the exhaustive helper below.
const VALID_CLASSIFICATIONS = new Set([
  'single-package',
  'single-package-with-docs',
  'multi-package',
  'multi-package-with-docs',
  'docs-only',
  'empty',
]);

// =============================================================================
// CLI flag parser — supports repeatable --subject-pkg + boolean flags
// =============================================================================

// ADR-0028 PR4 A4 — `include-extra` is repeatable so the user can opt
// specific entries from the plan-mode extras list back into the
// execute-mode staging set without the all-or-nothing
// `--accept-current-tree` bypass.
const REPEATABLE_FLAGS = new Set(['subject-pkg', 'include-extra']);
const BOOLEAN_FLAGS = new Set([
  'accept-current-tree',
  'non-interactive',
  'confirm-non-interactive',
  'strict-cc',
  'lenient-cc',
  'help',
]);

export function parseFlags(argv) {
  const out = { 'subject-pkg': [], 'include-extra': [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${a}`);
    }
    const name = a.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      const next = argv[i + 1];
      if (next === 'true' || next === 'false') {
        out[name] = next === 'true';
        i += 1;
      } else {
        out[name] = true;
      }
      continue;
    }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) {
      throw new Error(`Missing value for flag --${name}`);
    }
    if (REPEATABLE_FLAGS.has(name)) {
      out[name].push(val);
    } else {
      out[name] = val;
    }
    i += 1;
  }
  return out;
}

// =============================================================================
// Git probe helpers
// =============================================================================

function gitSync(repoRoot, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\n$/, '');
  } catch (err) {
    if (allowFailure) return null;
    const stderr = err && err.stderr ? String(err.stderr).trim() : '';
    throw new Error(
      `git ${args.join(' ')} failed: ${err.message}${stderr ? `\n${stderr}` : ''}`,
    );
  }
}

function notWorkflowStorage(p) {
  return !p.startsWith(WORKFLOW_STORAGE_PREFIX);
}

// =============================================================================
// Body composition (P1 + P9 trailer strip)
// =============================================================================

export function stripTrailers(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  return text
    .split('\n')
    .filter((line) => !TRAILER_RE.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ADR-0028 PR4 A2 — `Workflow-ID:` is the stable trailer that the
// idempotent-recovery fast-path uses to identify commits that already
// landed for THIS workflow. `git log $baseline..HEAD --grep "Workflow-ID:
// $id"` returns the exact set of commits to inspect before reaching the
// post-commit gates. Older commits (PR3 and earlier) do not carry the
// trailer, so A2 fast-path is a going-forward capability — workflows
// bootstrapped pre-PR4 fall back to the existing no-changes error.
const WORKFLOW_ID_TRAILER_PREFIX = 'Workflow-ID:';

export function composeBody({ originalRequest, diffStat, ensembleSummary, workflowId }) {
  const parts = [];
  const cleanedRequest = stripTrailers(originalRequest ?? '');
  if (cleanedRequest.length > 0) parts.push(cleanedRequest);
  if (typeof diffStat === 'string' && diffStat.length > 0) {
    // Truncate diff stat to 20 lines per ADR §P1.
    const lines = diffStat.split('\n').filter((l) => l.length > 0);
    const truncated = lines.slice(0, 20).join('\n');
    parts.push('```\n' + truncated + '\n```');
  }
  const cleanedSummary = stripTrailers(ensembleSummary ?? '');
  if (cleanedSummary.length > 0 && cleanedSummary.length < 200) {
    parts.push(cleanedSummary);
  }
  // PR4 A2 — append the Workflow-ID trailer as the LAST block. Trailer
  // shape (`Key: value`) keeps it harmless to readers that ignore
  // unknown trailers and easy to grep for with `git log --grep`.
  if (typeof workflowId === 'string' && workflowId.length > 0) {
    parts.push(`${WORKFLOW_ID_TRAILER_PREFIX} ${workflowId}`);
  }
  return parts.join('\n\n');
}

/**
 * ADR-0028 PR4 A2 — Pure decision: given the workflow's baseline head,
 * the workflow id, the manifest paths, and parsed `git log` output
 * (rev list + per-rev touched-paths map), determine whether the
 * workflow's commit set has ALREADY landed on the current branch.
 *
 * The check is a conjunction:
 *   1. At least one commit in baseline..HEAD carries the
 *      `Workflow-ID: <id>` trailer (the going-forward marker).
 *   2. The union of touched-paths across those marked commits covers
 *      every entry in commit_manifest (so the recovery fast-path
 *      does not fire when only a partial subset landed).
 *
 * Pure / testable: the caller (idempotentRecoveryCheck) shells out to
 * git and feeds this function strings. A nullish or empty baselineHead
 * disables the check (returns {landed: false} — the fast-path is a
 * recovery aid, not a correctness gate, so missing baseline data
 * should fail open).
 *
 * @param {object}   args
 * @param {string}   args.workflowId
 * @param {string[]} args.manifestPaths   — manifest entries' paths (deduped)
 * @param {object[]} args.markedCommits   — [{sha, touched: string[]}]
 * @returns {{ landed: boolean, coveredBy: string[], missingManifest: string[] }}
 */
export function evaluateLandedRecovery({ workflowId, manifestPaths, markedCommits }) {
  if (typeof workflowId !== 'string' || workflowId.length === 0) {
    return { landed: false, coveredBy: [], missingManifest: manifestPaths };
  }
  if (!Array.isArray(markedCommits) || markedCommits.length === 0) {
    return { landed: false, coveredBy: [], missingManifest: manifestPaths };
  }
  const touchedUnion = new Set();
  const coveredBy = [];
  for (const commit of markedCommits) {
    if (!commit || typeof commit.sha !== 'string') continue;
    coveredBy.push(commit.sha);
    for (const p of (commit.touched ?? [])) touchedUnion.add(p);
  }
  const missingManifest = manifestPaths.filter((p) => !touchedUnion.has(p));
  return {
    landed: missingManifest.length === 0,
    coveredBy,
    missingManifest,
  };
}

// =============================================================================
// Subject inference (P6)
// =============================================================================

function suggestType(frontmatter) {
  // verb + profile → conventional-commit type. Engineering rules of
  // thumb that match the existing repo's commit history.
  if (frontmatter.verb === 'refine') return 'fix';
  if (frontmatter.verb === 'compose' && frontmatter.profile === 'code') return 'feat';
  if (frontmatter.verb === 'compose' && frontmatter.profile === 'plan') return 'docs';
  if (frontmatter.verb === 'critique') return 'chore';
  return 'chore';
}

/**
 * Convert a release-please package key to a conventional-commit scope.
 *
 * Default: lastSegment heuristic ('plugins/engineer' → 'engineer',
 * 'companions' → 'companions') — matches the dominant convention in
 * the existing repo (e.g. `feat(engineer): ...` on commit 80b6770).
 *
 * Disambiguation (Phase 5 M1 — `packages/companions` vs root
 * `companions` both produce 'companions'): when a second packageKey
 * in `packageMap` shares the lastSegment, the `plugins/<name>` form
 * uses the slash-disambiguating scope `plugin/<name>` (matches commit
 * 91d1de9 `feat(plugin/engineer): ...`), and the root form keeps the
 * bare lastSegment. With no packageMap supplied the helper degrades
 * to the lastSegment heuristic — safe for callers that have not yet
 * adopted the disambiguation path.
 */
function lastSegment(packageKey) {
  const slash = packageKey.lastIndexOf('/');
  return slash === -1 ? packageKey : packageKey.slice(slash + 1);
}

export function packageScope(packageKey, packageMap = null) {
  if (!packageKey) return null;
  const seg = lastSegment(packageKey);
  if (!Array.isArray(packageMap) || packageMap.length === 0) {
    return seg;
  }
  const collides = packageMap.some(
    (k) => k !== packageKey && lastSegment(k) === seg,
  );
  if (!collides) return seg;
  // Disambiguate: 'plugins/<name>' adopts the slash-form scope
  // 'plugin/<name>' (matches the explicit-prefix convention used on
  // 91d1de9); non-plugins keys keep the bare lastSegment, leaving the
  // explicit form to the plugins/* variant.
  if (packageKey.startsWith('plugins/')) {
    return `plugin/${seg}`;
  }
  return seg;
}

function trimSubjectDescription(text) {
  if (!text) return 'work in progress';
  // Single line only; subject is the first line of the user's
  // original request. Cap to 60 chars so the suggested subject does
  // not overshoot conventional 72-char limits when combined with
  // type / scope.
  const firstLine = text.replace(/\r?\n.*$/s, '').trim();
  if (firstLine.length === 0) return 'work in progress';
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
}

export function inferSubject({ packageKey, frontmatter, packageMap = null }) {
  const type = suggestType(frontmatter);
  const scope = packageScope(packageKey, packageMap);
  const desc = trimSubjectDescription(frontmatter.original_request);
  return scope ? `${type}(${scope}): ${desc}` : `${type}: ${desc}`;
}

// =============================================================================
// P13 — .agentic-plugins/config.toml inline parser (flat, no nested tables)
// =============================================================================

export function parseSimpleToml(text) {
  if (typeof text !== 'string' || text.length === 0) return {};
  const out = {};
  let section = null;
  for (const raw of text.split('\n')) {
    const stripped = raw.replace(/#.*$/, '').trim();
    if (stripped.length === 0) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(stripped);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      if (!out[section]) out[section] = {};
      continue;
    }
    const kvMatch = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(stripped);
    if (!kvMatch) continue;
    const key = kvMatch[1];
    let val = kvMatch[2].trim();
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (/^-?\d+$/.test(val)) val = Number.parseInt(val, 10);
    else if (/^"([^"]*)"$/.test(val)) val = val.slice(1, -1);
    else if (/^'([^']*)'$/.test(val)) val = val.slice(1, -1);
    if (section) out[section][key] = val;
    else out[key] = val;
  }
  return out;
}

export async function readPhase7Config(repoRoot) {
  const path = join(repoRoot, '.agentic-plugins', 'config.toml');
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    // Absent or unreadable → lenient default per ADR §P13.
    return { strictCC: false };
  }
  const parsed = parseSimpleToml(text);
  const strictCC = parsed.phase7 && parsed.phase7.strictCC === true;
  return { strictCC: Boolean(strictCC) };
}

// =============================================================================
// A5 — agentic-plugins self-detection (ADR-0028 §P3 strict mode)
// =============================================================================
//
// The `readPackageMap(configPath, {strict})` helper degrades gracefully in
// consumer repos but MUST throw on malformed config inside agentic-plugins
// itself — that is exactly the bug class ADR-0016 was written to prevent.
// PR2 always passed `{strict: false}` regardless of repo; PR3 closes the
// gap by detecting the in-repo case from `package.json` `name` and
// flipping strict on automatically. Consumer repos keep the lenient
// default; fork repos that rename `package.json` opt out (intentional —
// they choose their own enforcement).
//
// Lenient on every failure mode (absent file, malformed JSON, missing
// name field) — false-positive strict would block legitimate consumer
// repos. The trade-off favors consumer safety; the in-repo strict path
// fires only when the marker is unambiguous.

export async function isAgenticPluginsRepo(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return false;
  let text;
  try {
    text = await readFile(join(repoRoot, 'package.json'), 'utf8');
  } catch {
    return false;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  return parsed && typeof parsed === 'object' && parsed.name === 'agentic-plugins';
}

// =============================================================================
// Staging set computation (Layer 3 core)
// =============================================================================

function computeGitChanges(repoRoot) {
  // git_changes = (git diff --name-only HEAD) ∪ (git ls-files -o
  // --exclude-standard) \ workflow storage
  const diffNames = gitSync(repoRoot, ['diff', '--name-only', 'HEAD'], { allowFailure: true }) ?? '';
  const untracked = gitSync(repoRoot, ['ls-files', '-o', '--exclude-standard'], { allowFailure: true }) ?? '';
  const all = new Set();
  for (const p of diffNames.split('\n').filter((l) => l.length > 0)) all.add(p);
  for (const p of untracked.split('\n').filter((l) => l.length > 0)) all.add(p);
  return [...all].filter(notWorkflowStorage).sort();
}

/**
 * Decide the staging set + branch verdict.
 *
 * Returns one of:
 *   {branch: 'manifest-intersects-git', stagingSet, askUser: false, ...}
 *   {branch: 'manifest-subset-of-git',  stagingSet, askUser: true, extras}
 *   {branch: 'empty-manifest',          stagingSet: gitChanges, askUser: true}
 *   {branch: 'accept-current-tree',     stagingSet: gitChanges, askUser: false}
 *   {branch: 'no-changes',              stagingSet: [],         askUser: false}
 *
 * ADR-0028 PR4 A4 — `includeExtras` is a per-path opt-in list (subset
 * of the extras list reported by an earlier plan-mode call). When
 * the branch resolves to `manifest-subset-of-git`, listed extras are
 * unioned back into the staging set (`intersection ∪ includeExtras`).
 * On any other branch the parameter is a no-op (accept-current-tree
 * already stages everything, etc.). An entry in `includeExtras` that
 * is NOT a member of the computed extras set is a programmer error
 * (the caller MUST validate against the plan-mode extras list) and
 * throws — silent-drop would re-introduce the very bug A4 fixes.
 */
export function decideStagingBranch({
  gitChanges,
  manifestPaths,
  acceptCurrentTree = false,
  includeExtras = [],
}) {
  if (acceptCurrentTree) {
    return {
      branch: 'accept-current-tree',
      stagingSet: gitChanges,
      askUser: false,
    };
  }
  if (gitChanges.length === 0) {
    return { branch: 'no-changes', stagingSet: [], askUser: false };
  }
  if (manifestPaths.length === 0) {
    return { branch: 'empty-manifest', stagingSet: gitChanges, askUser: true };
  }
  const manifestSet = new Set(manifestPaths);
  const intersection = gitChanges.filter((p) => manifestSet.has(p));
  const extras = gitChanges.filter((p) => !manifestSet.has(p));
  const manifestSupersetOfGit = gitChanges.every((p) => manifestSet.has(p));
  if (manifestSupersetOfGit) {
    return {
      branch: 'manifest-intersects-git',
      stagingSet: intersection,
      askUser: false,
    };
  }
  // PR4 A4 — manifest-subset-of-git: optionally union opted-in extras
  // back into the staging set. The extras-membership check fails fast
  // so a typo / stale plan-mode output cannot smuggle a path that the
  // user never saw in the dialog.
  const includeExtrasList = Array.isArray(includeExtras) ? includeExtras : [];
  const extrasSet = new Set(extras);
  const invalid = includeExtrasList.filter((p) => !extrasSet.has(p));
  if (invalid.length > 0) {
    throw new Error(
      `--include-extra entries not in the manifest-subset-of-git extras set: ${invalid.join(', ')}. ` +
      'includeExtras must be a subset of the plan-mode extras list (ADR-0028 PR4 A4).',
    );
  }
  const stagingSet = includeExtrasList.length === 0
    ? intersection
    : [...intersection, ...includeExtrasList];
  return {
    branch: 'manifest-subset-of-git',
    stagingSet,
    askUser: true,
    extras,
  };
}

// =============================================================================
// Mixed-hunk detection (ADR-0028 §Layer-3 cached-vs-HEAD predicate)
// =============================================================================

export function detectMixedHunk({ repoRoot, path }) {
  // ADR-0028 §Layer-3 — mixed-hunk detection is meaningful ONLY before
  // Phase 7's own `git add` runs, because `git add <path>` (without
  // `--patch`) stages everything in the working tree's delta and
  // collapses cached == HEAD trivially (Codex peer review A3).
  //
  // The detection catches: user partially pre-staged file X via
  // `git add --patch X` (some hunks staged, some not) before Phase 7
  // ran. Phase 7's bulk `git add X` would then sweep the unstaged
  // hunks — contrary to the user's pre-stage intent. We refuse the
  // path so the user resolves via `git add --patch` interactively or
  // unstages first.
  //
  // Predicate:
  //   pre_cached > 0 AND pre_cached < HEAD delta
  // The "pre_cached > 0" guard distinguishes "no pre-stage" (the
  // normal Phase 7 flow) from "partial pre-stage" (the refuse case).
  const cached =
    gitSync(repoRoot, ['diff', '--cached', '--numstat', '--', path], { allowFailure: true }) ?? '';
  const head =
    gitSync(repoRoot, ['diff', '--numstat', 'HEAD', '--', path], { allowFailure: true }) ?? '';
  const parseRow = (text) => {
    const line = text.split('\n').find((l) => l.length > 0);
    if (!line) return { add: 0, del: 0 };
    const cols = line.split('\t');
    const add = Number.parseInt(cols[0], 10);
    const del = Number.parseInt(cols[1], 10);
    return {
      add: Number.isFinite(add) ? add : 0,
      del: Number.isFinite(del) ? del : 0,
    };
  };
  const c = parseRow(cached);
  const h = parseRow(head);
  const hasPreStage = c.add > 0 || c.del > 0;
  const undercountsHead = c.add < h.add || c.del < h.del;
  return hasPreStage && undercountsHead;
}

// =============================================================================
// P12 — exhaustive switch over classifyMixedCase enum
// =============================================================================

export function commitShapeFor({ classification, perPackageCommits, docsCommit }) {
  if (!VALID_CLASSIFICATIONS.has(classification)) {
    throw new Error(
      `phase7-commit: unknown classification '${classification}'; ` +
      `expected one of ${[...VALID_CLASSIFICATIONS].join(', ')}`,
    );
  }
  switch (classification) {
    case 'single-package':
      // Exactly one perPackageCommits entry, no docs.
      return { commits: perPackageCommits, requiresSplit: false };
    case 'single-package-with-docs':
      // Exactly one perPackageCommits entry that already folded
      // exempt files in (detectCrossPackageRoutes does that). Author
      // discretion: 1 combined commit (default) or 2 (folded vs split
      // docs — out of scope here; we use the default).
      return { commits: perPackageCommits, requiresSplit: false };
    case 'multi-package':
      // N package commits, no docs.
      return { commits: perPackageCommits, requiresSplit: true };
    case 'multi-package-with-docs':
      // N package commits + 1 docs commit (last).
      return {
        commits: [
          ...perPackageCommits,
          { package: null, files: docsCommit.files },
        ],
        requiresSplit: true,
      };
    case 'docs-only':
      // 0 package commits, 1 docs commit only.
      return {
        commits: [{ package: null, files: docsCommit.files }],
        requiresSplit: false,
      };
    case 'empty':
      // Nothing to commit.
      return { commits: [], requiresSplit: false };
    default:
      // Unreachable per VALID_CLASSIFICATIONS guard above; kept so
      // future enum additions trigger a compile-style fault.
      throw new Error(
        `phase7-commit: classifyMixedCase emitted unknown case '${classification}'`,
      );
  }
}

// =============================================================================
// Plan-mode JSON output
// =============================================================================

async function planMode({ workflowPath, repoRoot, frontmatter, acceptCurrentTree }) {
  const gitChanges = computeGitChanges(repoRoot);
  const manifest = Array.isArray(frontmatter.commit_manifest)
    ? frontmatter.commit_manifest
    : [];
  // N1 read-side defense — re-validate every manifest path with
  // assertSafePath BEFORE the value is used for any git invocation. A
  // workflow file edited by hand could carry an injected path; the
  // shared helper rejects the four pathspec vectors.
  for (const entry of manifest) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(
        `commit_manifest entry is not an object: ${JSON.stringify(entry)}`,
      );
    }
    assertSafePath(entry.path);
  }
  const manifestPaths = manifest.map((e) => e.path);
  // ADR-0028 PR4 A4 — plan mode previews the intersection-only staging
  // set and lists extras separately so the user can decide which extras
  // to opt in via `--include-extra` on the execute call. Plan does NOT
  // accept includeExtras itself; the preview is always intersection-
  // only (otherwise the agent loop has no clean baseline to show the
  // user).
  const branchDecision = decideStagingBranch({
    gitChanges,
    manifestPaths,
    acceptCurrentTree,
  });
  const stagingSet = branchDecision.stagingSet;
  // A5 — ADR-0028 §P3 strict mode flips on automatically inside the
  // agentic-plugins repo (self-detection via package.json name); consumer
  // repos keep the lenient default so a missing or malformed
  // release-please-config.json does not block their workflow.
  const strictPackageMap = await isAgenticPluginsRepo(repoRoot);
  const packageMap = await readPackageMap(
    join(repoRoot, 'release-please-config.json'),
    { strict: strictPackageMap },
  );
  const routes = detectCrossPackageRoutes(stagingSet, packageMap);
  const shape = commitShapeFor({
    classification: routes.classification,
    perPackageCommits: routes.perPackageCommits,
    docsCommit: routes.docsCommit,
  });
  const suggestedSubjects = shape.commits.map((c) => ({
    package: c.package,
    files: c.files,
    suggested_subject: inferSubject({
      packageKey: c.package,
      frontmatter,
      packageMap,
    }),
  }));
  const phase7Config = await readPhase7Config(repoRoot);
  return {
    mode: 'plan',
    workflow_path: workflowPath,
    branch: branchDecision.branch,
    ask_user: branchDecision.askUser,
    extras: branchDecision.extras ?? [],
    git_changes: gitChanges,
    manifest_paths: manifestPaths,
    staging_set: stagingSet,
    classification: routes.classification,
    requires_split: shape.requiresSplit,
    package_map: packageMap,
    commits: suggestedSubjects,
    strict_cc: phase7Config.strictCC,
    notes: [
      shape.requiresSplit
        ? 'shouldSplit=true — pass repeated --subject-pkg <pkg>=<subj> in execute mode (ADR-0028 §P8).'
        : 'single-commit path — pass --subject "<text>" in execute mode.',
      branchDecision.askUser
        ? 'ask_user=true — confirm the staging set with the user before --mode execute.'
        : 'ask_user=false — staging set fully implied by manifest or accept-current-tree.',
    ],
  };
}

// =============================================================================
// Execute-mode pipeline
// =============================================================================

// ADR-0028 PR4 N2 — multiline subject is a body-injection vector. A
// subject with a CR or LF would make git treat anything past the first
// line as body, and a forged trailer-shaped line (e.g.
// `Co-Authored-By: attacker`) could land in the commit message past
// stripTrailers. Guard at the earliest point a subject is selected
// AND again right before the CC format check; both layers reject the
// same vector so a future caller that bypasses one still hits the
// other (defense in depth — Codex plan-verify F1).
function assertSingleLineSubject(subject, label) {
  if (typeof subject === 'string' && /[\r\n]/.test(subject)) {
    throw new Error(
      `${label}: multiline subject is not allowed (newline / line break in subject is a ` +
      `body-injection vector — ADR-0028 PR4 N2); got ${JSON.stringify(subject)}`,
    );
  }
}

export function pickSubjectForCommit({ commit, flags, requiresSplit }) {
  // flags['subject'] is a string or undefined; flags['subject-pkg'] is
  // an array of "pkg=subject" strings.
  const pkg = commit.package; // null for docs-only commit
  if (requiresSplit) {
    if (typeof flags.subject === 'string') {
      throw new Error(
        '--subject is not allowed when the staging set requires a split. ' +
        'Use repeatable --subject-pkg <pkg>=<subj> instead (ADR-0028 §P8).',
      );
    }
    const map = new Map();
    for (const raw of flags['subject-pkg']) {
      const eq = raw.indexOf('=');
      if (eq <= 0) {
        throw new Error(
          `--subject-pkg expects '<pkg>=<subject>' (got ${JSON.stringify(raw)})`,
        );
      }
      const subjectValue = raw.slice(eq + 1);
      assertSingleLineSubject(subjectValue, `--subject-pkg ${raw.slice(0, eq)}`);
      map.set(raw.slice(0, eq), subjectValue);
    }
    // ADR-0028 Codex peer review A6 — docs-only commit (package=null)
    // uses the literal CLI key 'docs'. CLI values are strings; a
    // bare `null` token has no useful encoding here. Plan-mode JSON
    // emits package=null for docs commits and the agent loop is
    // expected to translate that to `--subject-pkg docs=<text>`.
    const key = pkg === null ? 'docs' : pkg;
    if (!map.has(key)) {
      throw new Error(
        `--subject-pkg missing for commit '${key}' ` +
        `(saw keys: ${[...map.keys()].join(', ') || 'none'}). ` +
        `For docs-only commits use --subject-pkg docs=<text>.`,
      );
    }
    return map.get(key);
  }
  // Single commit
  if (typeof flags.subject !== 'string' || flags.subject.length === 0) {
    throw new Error('--subject is required when the staging set is a single commit.');
  }
  assertSingleLineSubject(flags.subject, '--subject');
  return flags.subject;
}

export function checkSubjectAgainstCC({ subject, strictCC, stderr }) {
  // PR4 N2 — multiline guard is a security gate (not a style preference)
  // so it fires in BOTH strict and lenient modes; bypassing it would let
  // a forged trailer line slip past stripTrailers.
  assertSingleLineSubject(subject, 'subject');
  if (CONVENTIONAL_COMMIT_RE.test(subject)) return true;
  if (strictCC) {
    throw new Error(
      `subject does not match Conventional Commit format and strictCC is on: ${JSON.stringify(subject)}`,
    );
  }
  stderr.write(
    `⚠ subject does not match Conventional Commit format (lenient mode); proceeding: ${subject}\n`,
  );
  return false;
}

// ADR-0028 PR4 N1 — split the original `commitOnce` into two phases so
// per-commit diff stats can be computed BETWEEN stage and commit:
//
//   1. preflightAndStage — assertSafePath + detectMixedHunk + `git add`.
//      Mixed-hunk detection MUST run BEFORE `git add` (Codex peer
//      review A3 — after a bulk `git add <path>` the cached column
//      equals HEAD trivially and the refusal is defeated). Returns
//      {ok, reason?, message?, mixed?}.
//   2. commitStaged — `git commit -F message-file` with the
//      caller-composed body. The body is built per-commit in
//      executeMode so the diff-stat reflects ONLY the paths that
//      belong to this commit (N1 — was previously a worktree-wide
//      shared body across split commits, mis-attributing changes).
//
// The split also lets executeMode compute `git diff --cached --stat
// HEAD -- <paths>` AFTER stage but BEFORE commit, which is the only
// point where the cache reflects exactly this commit's contribution.

async function preflightAndStage({ repoRoot, paths, stderr }) {
  for (const p of paths) assertSafePath(p);
  // PR4 review C1 (Codex Phase 5): `commitStaged`'s `git commit -F` runs
  // without a pathspec, so anything already in the index — even files
  // outside this commit's planned set — would be swept into the commit.
  // That defeats A4's "intersection only unless --include-extra" guarantee
  // and could land an unapproved file in the wrong release-please package
  // commit. Refuse here when the index already holds entries we did not
  // plan for, with an actionable resolution path (git reset HEAD -- <p>
  // to drop the pre-stage, or --include-extra <p> if the user actually
  // wants it in this commit).
  //
  // Uses `-z` to handle paths with spaces / tabs / quotes (PR4 N4-quoted
  // pattern). Within executeMode's split-commit loop, this fires only at
  // the first iteration because git clears the index after each commit;
  // subsequent iterations see an empty pre-staged set.
  const preStagedRaw =
    gitSync(repoRoot, ['diff', '--cached', '--name-only', '-z'], { allowFailure: true }) ?? '';
  const preStaged = preStagedRaw.split('\0').filter((s) => s.length > 0);
  if (preStaged.length > 0) {
    const allowed = new Set(paths);
    const unapproved = preStaged.filter((p) => !allowed.has(p));
    if (unapproved.length > 0) {
      stderr.write(
        `⚠ unapproved pre-staged path(s) detected — refusing to commit them into this ` +
        `package (PR4 review C1; ADR-0028 A4 intersection-only invariant):\n` +
        unapproved.map((p) => `    ${p}`).join('\n') +
        `\n   Resolve with one of:\n` +
        `     git reset HEAD -- ${unapproved.map((p) => JSON.stringify(p)).join(' ')}\n` +
        `       (drop the pre-stage; Phase 7 will then stage only its planned files)\n` +
        `     re-run with --include-extra <path> for each path you DO want in this commit\n` +
        `       (subject to subset-of-extras validation)\n`,
      );
      return { ok: false, reason: 'unapproved-pre-staged', unapproved };
    }
  }
  const mixed = paths.filter((p) => detectMixedHunk({ repoRoot, path: p }));
  if (mixed.length > 0) {
    stderr.write(
      `⚠ mixed-hunk paths detected (user pre-staged a partial subset against HEAD): ${mixed.join(', ')}\n` +
      `   Run \`git add --patch <path>\` to finish staging the intended hunks, ` +
      `or \`git reset HEAD -- <path>\` to clear the pre-stage and let Phase 7 ` +
      `commit the full file delta.\n`,
    );
    return { ok: false, reason: 'mixed-hunk', mixed };
  }
  // Use `--` separator so any path that begins with `-` despite the
  // earlier assertion is still safe at the argv boundary. The catch
  // converts git-add failure into a structured refine-fallback row
  // rather than letting the throw escape (Phase 5 M2 — surface
  // stage-failed reason alongside the existing mixed-hunk /
  // commit-failed reasons).
  try {
    gitSync(repoRoot, ['add', '--', ...paths]);
  } catch (err) {
    return {
      ok: false,
      reason: 'stage-failed',
      message: err.message,
    };
  }
  return { ok: true };
}

/**
 * ADR-0028 PR4 A2 — CLI-side wrapper for the idempotent-recovery
 * fast-path. Shells out to `git log` to find marked commits in
 * baseline..HEAD, then to `git show --name-only` for each marked
 * commit's touched-paths list, and finally delegates the pure
 * yes/no to `evaluateLandedRecovery`.
 *
 * Returns the same shape as `evaluateLandedRecovery`. Git failures
 * (e.g. baseline ref not found) fail open with `landed: false` so
 * the caller falls back to the legacy no-changes error rather than
 * incorrectly skipping the commit loop.
 */
function probeLandedRecovery({ repoRoot, baselineHead, workflowId, manifestPaths }) {
  // Step 1 — rev list with the workflow's marker. `--grep` matches
  // against the full commit message (subject + body), and the
  // trailer is in the body block. `-F` makes the match literal so a
  // workflow id containing regex metacharacters does not blow up.
  // Failures fall open (empty list → not landed).
  const grepArg = `${WORKFLOW_ID_TRAILER_PREFIX} ${workflowId}`;
  const revRange = `${baselineHead}..HEAD`;
  const revList = gitSync(
    repoRoot,
    ['log', '--format=%H', '-F', `--grep=${grepArg}`, revRange],
    { allowFailure: true },
  );
  if (revList === null || typeof revList !== 'string' || revList.trim().length === 0) {
    return { landed: false, coveredBy: [], missingManifest: manifestPaths };
  }
  const shas = revList.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);

  // Step 2 — per-sha touched-paths list. `git show --name-only
  // --pretty=format:` emits the paths one per line.
  const markedCommits = [];
  for (const sha of shas) {
    const paths = gitSync(
      repoRoot,
      ['show', '--name-only', '--pretty=format:', sha],
      { allowFailure: true },
    );
    const touched = (paths ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    markedCommits.push({ sha, touched });
  }

  return evaluateLandedRecovery({ workflowId, manifestPaths, markedCommits });
}

/**
 * ADR-0028 PR4 A2 — post-commit gate block extracted from executeMode
 * so the idempotent-recovery fast-path can invoke it after deciding
 * that this run's "commit" work is provably done (commits already
 * landed on a prior run, but the workflow never reached set-terminal
 * because a gate failed back then).
 *
 * Mirror of the gate block in executeMode's normal path: P11
 * pending_ensemble, no-active-children, clean-after-commit, P10
 * synchronous writebackParent, P5 setTerminal LAST. `landed` is
 * forwarded back into the result so the caller can render the same
 * landed-commits summary.
 */
async function runPostCommitGates({ workflowPath, repoRoot, flags, stderr, landed }) {
  const freshText = await readFile(workflowPath, 'utf8');
  const { frontmatter: fresh } = parseWorkflowFile(freshText);
  if (!noPendingEnsembleCheck(fresh)) {
    stderr.write(
      `✗ pending_ensemble is non-empty; refusing set-terminal (ADR-0028 §P11).\n` +
      `  Pending entries: ${fresh.pending_ensemble.map((e) => e.run_id).join(', ')}\n` +
      `  Wait for the peer ensemble to settle or run /engineer:refine to address.\n`,
    );
    return { ok: false, reason: 'pending_ensemble:non_empty', landed };
  }
  if (!noActiveChildrenCheck(fresh)) {
    stderr.write(
      `✗ child_completions contains an entry without commit/closed_at; refusing set-terminal.\n` +
      `  Address via /orchestrator:done <subtask> or /engineer:refine.\n`,
    );
    return { ok: false, reason: 'active-children', landed };
  }
  // PR4 review F1 (Phase 5 Angle A+B): use `-z` for parity with the
  // Layer-1 clean-baseline parser (state.mjs runCleanBaselineCheck).
  // Plain `--porcelain=v1` C-quotes paths containing spaces / tabs /
  // quotes, which would surface as e.g. `"a b.md"` and confuse the
  // surfaced-paths block below. `-z` emits raw bytes with a NUL
  // terminator per entry; we split on NUL and drop the trailing empty
  // chunk.
  // drift-digest: --untracked-files=normal so untracked files are seen even under a
  // user's status.showUntrackedFiles=no (without it such a tree hashes/classifies as
  // CLEAN). `normal` — not `all` — is deliberate and measured: it overrides the config
  // exactly the same way, but keeps git's directory collapsing, so the output bytes are
  // IDENTICAL to the historical default-config behaviour (`?? sub/`). `all` would expand
  // each untracked dir into its files, changing every digest and dirty_count (measured:
  // an untracked dir of 3 files counts 1 under normal, 3 under all) and paying a full
  // recursive walk on huge untracked trees.
  // Pinning the mode also makes the digest MACHINE-INDEPENDENT: a user configured
  // `all` previously produced per-file entries, so the same tree digested
  // differently per machine. Dirty/clean is unaffected either way (both non-empty);
  // only listing granularity narrows for those users.
  const afterCommit = gitSync(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { allowFailure: true }) ?? '';
  const surfacedEntries = afterCommit.split('\0').filter((s) => s.length > 0);
  if (surfacedEntries.length > 0) {
    stderr.write(
      `✗ working tree is not clean after commit; refusing set-terminal.\n` +
      `  Surfaced:\n` +
      surfacedEntries.map((l) => `    ${l}`).join('\n') +
      `\n  Resolve via /engineer:refine or commit the remainder manually.\n`,
    );
    return { ok: false, reason: 'unclean-after-commit', landed };
  }
  // P10 — synchronous writebackParent. Skipped when this workflow has
  // no orchestrator parent linkage (direct /engineer:start invocation).
  //
  // PR4 review C2 (Codex Phase 5): the orchestrator `updateSubtask`
  // path allows same-owner completed updates and rewrites
  // `commit`/`closed_at`/`updated_at`/`host_history` rather than
  // no-op'ing when the subtask is already completed. That means the
  // A2 fast-path rerun (and any normal-path rerun after gate failure)
  // would mutate parent state again instead of being idempotent.
  //
  // PR3 §P10 already installs the M3 write-ahead marker:
  // `setParentWritebackMarker` writes `parent_writeback_at` BEFORE
  // calling `writebackParent`, and `clearParentWritebackMarker` fires
  // on failure. So a non-empty `fresh.parent_writeback_at` here means
  // either (a) writeback was already attempted successfully in a
  // prior run, OR (b) it was attempted, failed, and the clear-on-fail
  // path also failed (a vanishingly rare crash-window case). Treat
  // (a) as the dominant case — skip writebackParent and proceed to
  // setTerminal. If (b) materializes the operator can clear the
  // marker via /engineer:refine and rerun.
  if (
    typeof fresh.parent_workflow === 'string' &&
    fresh.parent_workflow.length > 0 &&
    typeof fresh.originating_subtask === 'string' &&
    fresh.originating_subtask.length > 0
  ) {
    const alreadyAttempted =
      typeof fresh.parent_writeback_at === 'string' &&
      fresh.parent_writeback_at.length > 0;
    if (alreadyAttempted) {
      stderr.write(
        `ℹ parent-writeback already attempted (parent_writeback_at=${fresh.parent_writeback_at}); ` +
        `skipping writebackParent for idempotency (PR4 review C2). Proceeding to setTerminal.\n`,
      );
    } else {
      const commitSha = gitSync(repoRoot, ['rev-parse', 'HEAD']);
      const closedAtIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      await setParentWritebackMarker({
        workflowPath, host: flags.host, at: closedAtIso,
      });
      const wbResult = await writebackParent({
        repoRoot,
        parentWorkflowId: fresh.parent_workflow,
        originatingSubtaskId: fresh.originating_subtask,
        engineerWorkflowId: fresh.workflow_id,
        commit: commitSha,
        closedAt: closedAtIso,
        host: flags.host,
        stderr,
      });
      if (wbResult && wbResult.ok === false) {
        await clearParentWritebackMarker({ workflowPath, host: flags.host });
        stderr.write(
          `⚠ parent-writeback failed but Phase 7 will continue: ${wbResult.reason}\n` +
          `  The Stop hook deferred-writeback path is the backstop ` +
          `(idempotent compare-and-no-op).\n`,
        );
      }
    }
  }
  await setTerminal({
    workflowPath,
    host: flags.host,
    terminalPhase: 'commit-complete',
    terminalMarker: true,
    nextAction: 'archive',
    event: 'updated',
    // ADR-0031 amendment — Phase 7 commit is a production completion entry
    // point; fire the session-handoff sidecar (after the terminal write).
    emitHandoff: true,
  });
  return { ok: true, landed };
}

/**
 * ADR-0028 PR4 A2 — thin wrapper used by the fast-path branch so the
 * caller-side does not have to reconstruct the post-commit-gate
 * envelope or remember to honor the landedSummary alias.
 */
async function runPostCommitGatesOnly({
  workflowPath, repoRoot, frontmatter: _frontmatter, flags, stderr, landedSummary,
}) {
  return runPostCommitGates({
    workflowPath,
    repoRoot,
    flags,
    stderr,
    landed: landedSummary,
  });
}

async function commitStaged({ repoRoot, subject, body, stderr }) {
  // git commit -F message-file. We pass subject + body as a single
  // file because git rejects `-m` and `-F` together (Phase 5 e2e
  // smoke caught the prior `-m subject -F body` combination). The
  // file contains the subject line, a blank separator, and the body
  // — matching git's standard "summary, blank, details" commit
  // message layout. The temp file isolates multi-line / special-char
  // bodies from shell escape rules.
  const tmpDir = await mkdtemp(join(tmpdir(), 'phase7-body-'));
  const msgPath = join(tmpDir, 'COMMIT_EDITMSG');
  try {
    const trimmedBody = (body ?? '').replace(/^\s+|\s+$/g, '');
    const message = trimmedBody.length > 0 ? `${subject}\n\n${trimmedBody}\n` : `${subject}\n`;
    await writeFile(msgPath, message);
    try {
      gitSync(repoRoot, ['commit', '-F', msgPath]);
      return { ok: true };
    } catch (err) {
      // Pre-commit / commit-msg hook failures land here. ADR §P4: both
      // produce the same refine-fallback outcome.
      return {
        ok: false,
        reason: 'commit-failed',
        message: err.message,
      };
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function executeMode({
  workflowPath,
  repoRoot,
  frontmatter,
  flags,
  stderr,
}) {
  // Re-derive everything (do NOT trust caller-supplied plan; planMode
  // is informational, executeMode is authoritative).
  const acceptCurrentTree =
    flags['accept-current-tree'] === true ||
    process.env.ACCEPT_CURRENT_TREE === '1';
  const gitChanges = computeGitChanges(repoRoot);
  const manifest = Array.isArray(frontmatter.commit_manifest)
    ? frontmatter.commit_manifest
    : [];
  for (const entry of manifest) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`commit_manifest entry is not an object: ${JSON.stringify(entry)}`);
    }
    assertSafePath(entry.path);
  }
  const manifestPaths = manifest.map((e) => e.path);
  // ADR-0028 PR4 A4 — forward the user-confirmed extras opt-in list
  // (subset of the plan-mode extras report). Empty list preserves the
  // pre-PR4 intersection-only behavior; populated list unions only the
  // listed paths back into the staging set. assertSafePath defends
  // against pathspec injection — every entry the user types must clear
  // the same `git add`-safety gate as a manifest entry.
  const includeExtras = Array.isArray(flags['include-extra'])
    ? flags['include-extra']
    : [];
  for (const p of includeExtras) assertSafePath(p);
  const branchDecision = decideStagingBranch({
    gitChanges,
    manifestPaths,
    acceptCurrentTree,
    includeExtras,
  });
  if (branchDecision.branch === 'no-changes') {
    // ADR-0028 PR4 A2 — idempotent-recovery fast-path.
    //
    // Scenario: first run committed everything but a post-commit gate
    // (P11 pending_ensemble, no-active-children, clean-after-commit, P10
    // writeback) failed BEFORE setTerminal could write. The commit
    // landed; the workflow is still active. The user clears the gate
    // (e.g. settles pending_ensemble) and reruns /engineer:start. The
    // working tree is now clean because the commit already swept it —
    // throwing `no-changes` here would leave the workflow permanently
    // un-terminated.
    //
    // Recovery decision: if a marked commit (carrying
    // `Workflow-ID: <id>`) exists in baseline..HEAD AND the union of
    // its touched paths covers every commit_manifest entry, the commit
    // work is provably already done. Skip the commit loop, fall
    // through to the post-commit gate block (lines below), and let
    // setTerminal close the workflow.
    //
    // Pre-PR4 workflows lack the Workflow-ID trailer, so the fast-path
    // does not fire for them — they keep the original throw and
    // require /engineer:resume archive (the documented manual path).
    const baselineHead = frontmatter.git_baseline && frontmatter.git_baseline.head;
    const workflowId = frontmatter.workflow_id;
    if (
      typeof baselineHead === 'string' && baselineHead.length > 0 &&
      typeof workflowId === 'string' && workflowId.length > 0 &&
      manifestPaths.length > 0
    ) {
      const recovery = probeLandedRecovery({
        repoRoot,
        baselineHead,
        workflowId,
        manifestPaths,
      });
      if (recovery.landed) {
        stderr.write(
          `ℹ A2 fast-path: commits for workflow_id=${workflowId} already landed ` +
          `(${recovery.coveredBy.length} commit${recovery.coveredBy.length === 1 ? '' : 's'}: ` +
          `${recovery.coveredBy.map((s) => s.slice(0, 7)).join(', ')}). ` +
          `Skipping commit loop; running post-commit gates + set-terminal.\n`,
        );
        // Fall through to the post-commit gate block below WITHOUT
        // entering the commit loop. `landed` is intentionally empty
        // here — the gates only check workflow state, not what landed
        // this invocation, so an empty list is safe and accurate
        // (nothing landed THIS run).
        return await runPostCommitGatesOnly({
          workflowPath,
          repoRoot,
          frontmatter,
          flags,
          stderr,
          landedSummary: recovery.coveredBy.map((s) => `${s} (prior run)`),
        });
      }
    }
    throw new Error(
      'no-changes: working tree is clean and there is nothing to commit. ' +
      'Phase 7 cannot fire on an empty diff. /engineer:resume archive may be the right action.',
    );
  }
  if (branchDecision.askUser && !(flags['confirm-non-interactive'] === true || flags['non-interactive'] === true)) {
    throw new Error(
      `ask-user-required: staging branch '${branchDecision.branch}' requires user ` +
      'confirmation. The agent must confirm with the user and then re-run with ' +
      '--confirm-non-interactive (or pass ACCEPT_CURRENT_TREE=1 to bypass).',
    );
  }
  const stagingSet = branchDecision.stagingSet;
  // A5 — same self-detection as plan-mode (the in-repo strict path
  // throws on malformed/missing release-please-config.json so the
  // ADR-0016 routing convention cannot silently degrade).
  const strictPackageMap = await isAgenticPluginsRepo(repoRoot);
  const packageMap = await readPackageMap(
    join(repoRoot, 'release-please-config.json'),
    { strict: strictPackageMap },
  );
  const routes = detectCrossPackageRoutes(stagingSet, packageMap);
  const shape = commitShapeFor({
    classification: routes.classification,
    perPackageCommits: routes.perPackageCommits,
    docsCommit: routes.docsCommit,
  });
  if (shape.commits.length === 0) {
    throw new Error('empty-shape: nothing to commit after classification.');
  }
  // CC enforcement (P13): in-repo strictCC default = true via
  // .agentic-plugins/config.toml; otherwise lenient. The CLI flags
  // --strict-cc / --lenient-cc override.
  const phase7Config = await readPhase7Config(repoRoot);
  let strictCC = phase7Config.strictCC;
  if (flags['strict-cc'] === true) strictCC = true;
  if (flags['lenient-cc'] === true) strictCC = false;

  // Compose body context once (shared across split commits per P1 —
  // original_request + ensemble summary are workflow-level, not
  // per-commit). The diffStat is per-commit evidence per ADR-0028 PR4
  // N1 and is computed inside the loop right after stage, so split
  // commits each carry the diff for the files THEY actually contain
  // (the previous worktree-wide `git diff --stat HEAD` mis-attributed
  // every split commit's body to the entire worktree change set).
  const ensembleSummary = pickLatestEnsembleSummary(frontmatter);

  // Per-commit pass with P2 partial-split recovery. Each iteration:
  //   1. pick + validate the subject (PR4 N2 single-line + CC gate)
  //   2. preflight + stage (PR4 N1 split — mixed-hunk MUST run before
  //      `git add` per Codex A3, so it lives in step 2 not after)
  //   3. compute per-commit diffStat from the just-staged cache and
  //      compose this commit's body
  //   4. commit
  const landed = [];
  for (let i = 0; i < shape.commits.length; i++) {
    const commit = shape.commits[i];
    const subject = pickSubjectForCommit({
      commit,
      flags,
      requiresSplit: shape.requiresSplit,
    });
    checkSubjectAgainstCC({ subject, strictCC, stderr });

    const failHere = (result) => {
      // P2 + P4 refine fallback. Surface what landed and what failed.
      stderr.write(
        `\n✗ phase7-commit aborted at commit ${i + 1}/${shape.commits.length} ` +
        `(package=${commit.package ?? 'docs'}): ${result.reason}\n` +
        (result.message ? `   ${result.message.split('\n').join('\n   ')}\n` : '') +
        `\nLanded commits (preserved):\n` +
        landed.map((c) => `  - ${c}`).join('\n') +
        `\n\nRemaining commits to land manually or via /engineer:refine:\n` +
        shape.commits.slice(i).map((c, k) => `  ${k + 1}. package=${c.package ?? 'docs'} files=${c.files.length}`).join('\n') +
        `\n\nRecommended action: /engineer:refine "${result.reason}" — address the ` +
        `failure (subject edit, hook compliance, hunk split) and re-run /engineer:start ` +
        `which will resume at Phase 7.\n`,
      );
      return { ok: false, reason: result.reason, landed };
    };

    const stageResult = await preflightAndStage({
      repoRoot,
      paths: commit.files,
      stderr,
    });
    if (!stageResult.ok) return failHere(stageResult);

    // PR4 N1 — `git diff --cached --stat` (no HEAD arg → defaults to
    // HEAD vs index) reports exactly the paths just staged. Restrict
    // to commit.files via `-- <paths>` so even if the user had unrelated
    // staged hunks pre-loop, this commit's body only documents its own.
    const diffStat =
      gitSync(repoRoot, ['diff', '--cached', '--stat', '--', ...commit.files], { allowFailure: true }) ?? '';
    const body = composeBody({
      originalRequest: frontmatter.original_request,
      diffStat,
      ensembleSummary,
      // PR4 A2 — embed Workflow-ID so the idempotent-recovery fast-path
      // can identify this commit as belonging to the workflow on a
      // future rerun.
      workflowId: frontmatter.workflow_id,
    });

    const commitResult = await commitStaged({
      repoRoot,
      subject,
      body,
      stderr,
    });
    if (!commitResult.ok) return failHere(commitResult);

    const sha = gitSync(repoRoot, ['rev-parse', 'HEAD']);
    landed.push(`${sha} ${subject}`);
  }

  // Post-commit gates extracted into runPostCommitGates so the
  // ADR-0028 PR4 A2 fast-path can reuse the same code (see the
  // no-changes branch above). The helper handles: re-read frontmatter
  // → P11 pending_ensemble → no-active-children → clean-after-commit
  // → P10 synchronous writebackParent (with M3 write-ahead marker) →
  // P5 set-terminal LAST.
  return runPostCommitGates({ workflowPath, repoRoot, flags, stderr, landed });
}

function pickLatestEnsembleSummary(frontmatter) {
  const list = Array.isArray(frontmatter.ensemble_results)
    ? frontmatter.ensemble_results
    : [];
  if (list.length === 0) return null;
  const last = list[list.length - 1];
  return last && typeof last.summary === 'string' ? last.summary : null;
}

// =============================================================================
// CLI main + help
// =============================================================================

const HELP = `Usage: phase7-commit.mjs --mode <plan|execute> --workflow-path <p> --repo-root <p> --host <h> [flags]

ADR-0028 §Layer-3 — engineer /engineer:start Phase 7 commit driver.

Required:
  --mode plan | execute
  --workflow-path <path>
  --repo-root <path>
  --host claude | codex

Plan mode:
  Emits a JSON plan on stdout (staging set, classification, suggested
  subjects). NO git mutations. Use the plan to confirm the staging
  intent with the user before --mode execute.

Execute mode requires the user-confirmed subject:
  --subject <text>                  Single-commit subject (rejected when shouldSplit).
  --subject-pkg <pkg>=<subj>        Per-package subject (repeatable; required when shouldSplit).
  --confirm-non-interactive         Skip the staging-intent confirm gate.
  --non-interactive                 Alias for --confirm-non-interactive.

CC enforcement (P13, default from .agentic-plugins/config.toml [phase7] strictCC):
  --strict-cc                       Block on non-conventional subject.
  --lenient-cc                      Warn-only.

Layer 1 forwarding (ADR-0028 §Layer-1 accept-current-tree):
  --accept-current-tree             Stage all git_changes (skip manifest intersection).
                                    Honors ACCEPT_CURRENT_TREE=1 in environment.

Per-path opt-in extras (ADR-0028 PR4 A4 — manifest-subset-of-git):
  --include-extra <path>            Add a single plan-mode "extra" path back into the
                                    staging set (repeatable). Use when the agent
                                    dialog confirms specific extras but the user does
                                    NOT want the all-or-nothing --accept-current-tree
                                    sweep. Path MUST appear in the plan-mode extras
                                    list, MUST be repo-relative, and MUST clear the
                                    same pathspec-safety checks as a manifest entry.

Exit codes:
  0   — plan emitted (plan mode) OR commit landed + set-terminal fired (execute mode).
  ≠ 0 — refine fallback emitted to stderr; workflow remains active.
`;

export async function main(argv) {
  let flags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${HELP}\n`);
    return 2;
  }
  if (flags.help === true) {
    process.stdout.write(HELP);
    return 0;
  }
  for (const required of ['mode', 'workflow-path', 'repo-root', 'host']) {
    if (!flags[required]) {
      process.stderr.write(`✗ Missing required flag --${required}\n\n${HELP}\n`);
      return 2;
    }
  }
  if (flags.mode !== 'plan' && flags.mode !== 'execute') {
    process.stderr.write(`✗ --mode must be 'plan' or 'execute' (got '${flags.mode}')\n`);
    return 2;
  }
  // Read + parse workflow file
  let workflowText;
  try {
    workflowText = await readFile(flags['workflow-path'], 'utf8');
  } catch (err) {
    process.stderr.write(`✗ cannot read --workflow-path '${flags['workflow-path']}': ${err.message}\n`);
    return 1;
  }
  let frontmatter;
  try {
    ({ frontmatter } = parseWorkflowFile(workflowText));
  } catch (err) {
    process.stderr.write(`✗ workflow file did not parse: ${err.message}\n`);
    return 1;
  }
  // Branch on mode
  const acceptCurrentTree =
    flags['accept-current-tree'] === true ||
    process.env.ACCEPT_CURRENT_TREE === '1';
  if (flags.mode === 'plan') {
    try {
      const plan = await planMode({
        workflowPath: flags['workflow-path'],
        repoRoot: flags['repo-root'],
        frontmatter,
        acceptCurrentTree,
      });
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`✗ plan-mode failed: ${err.message}\n`);
      return 1;
    }
  }
  // execute mode
  try {
    const result = await executeMode({
      workflowPath: flags['workflow-path'],
      repoRoot: flags['repo-root'],
      frontmatter,
      flags,
      stderr: process.stderr,
    });
    if (!result.ok) {
      // Stderr already received the refine-fallback message in
      // executeMode; emit a stable exit code mapped to reason.
      const codeMap = {
        'stage-failed': 8,
        'mixed-hunk': 3,
        'commit-failed': 4,
        'pending_ensemble:non_empty': 5,
        'active-children': 6,
        'unclean-after-commit': 7,
      };
      return codeMap[result.reason] ?? 1;
    }
    process.stdout.write(`${JSON.stringify({ ok: true, landed: result.landed }, null, 2)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`✗ execute-mode failed: ${err.message}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // ES-module CLI entry — async IIFE wrapper avoids top-level-await
  // deadlocks under dynamic-import circular edges (engineer plugin
  // convention captured in `project_cli_entry_iife_pattern`).
  (async () => {
    try {
      const code = await main(process.argv.slice(2));
      process.exit(code);
    } catch (err) {
      process.stderr.write(`phase7-commit: ${err.message}\n`);
      process.exit(1);
    }
  })();
}
