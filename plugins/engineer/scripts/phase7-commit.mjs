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
const TRAILER_RE =
  /^(BREAKING CHANGE|BREAKING-CHANGE|Co-Authored-By|Closes|Fixes|Refs):/i;

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

const REPEATABLE_FLAGS = new Set(['subject-pkg']);
const BOOLEAN_FLAGS = new Set([
  'accept-current-tree',
  'non-interactive',
  'confirm-non-interactive',
  'strict-cc',
  'lenient-cc',
  'help',
]);

export function parseFlags(argv) {
  const out = { 'subject-pkg': [] };
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

export function composeBody({ originalRequest, diffStat, ensembleSummary }) {
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
  return parts.join('\n\n');
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

function packageScope(packageKey) {
  if (!packageKey) return null;
  // 'plugins/engineer' → 'engineer', 'plugins/runtime' → 'runtime',
  // 'companions' → 'companions'.
  const slash = packageKey.lastIndexOf('/');
  return slash === -1 ? packageKey : packageKey.slice(slash + 1);
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

export function inferSubject({ packageKey, frontmatter }) {
  const type = suggestType(frontmatter);
  const scope = packageScope(packageKey);
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
 *   {branch: 'manifest-subset-of-git',  stagingSet: gitChanges, askUser: true, extras}
 *   {branch: 'empty-manifest',          stagingSet: gitChanges, askUser: true}
 *   {branch: 'accept-current-tree',     stagingSet: gitChanges, askUser: false}
 *   {branch: 'no-changes',              stagingSet: [],         askUser: false}
 */
export function decideStagingBranch({
  gitChanges,
  manifestPaths,
  acceptCurrentTree = false,
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
  const gitSet = new Set(gitChanges);
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
  return {
    branch: 'manifest-subset-of-git',
    stagingSet: intersection,
    askUser: true,
    extras,
  };
}

// =============================================================================
// Mixed-hunk detection (ADR-0028 §Layer-3 cached-vs-HEAD predicate)
// =============================================================================

export function detectMixedHunk({ repoRoot, path }) {
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
  // Mixed hunk iff cached strictly undercounts HEAD totals.
  return c.add < h.add || c.del < h.del;
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
  const branchDecision = decideStagingBranch({
    gitChanges,
    manifestPaths,
    acceptCurrentTree,
  });
  const stagingSet = branchDecision.stagingSet;
  const packageMap = await readPackageMap(
    join(repoRoot, 'release-please-config.json'),
    { strict: false },
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
    suggested_subject: inferSubject({ packageKey: c.package, frontmatter }),
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

function pickSubjectForCommit({ commit, flags, requiresSplit }) {
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
      map.set(raw.slice(0, eq), raw.slice(eq + 1));
    }
    // Docs commit uses the special key 'docs' OR `null`. We accept both.
    const key = pkg === null ? (map.has('docs') ? 'docs' : null) : pkg;
    if (key === null || !map.has(key)) {
      throw new Error(
        `--subject-pkg missing for commit ${pkg ?? 'docs'} ` +
        `(saw keys: ${[...map.keys()].join(', ') || 'none'})`,
      );
    }
    return map.get(key);
  }
  // Single commit
  if (typeof flags.subject !== 'string' || flags.subject.length === 0) {
    throw new Error('--subject is required when the staging set is a single commit.');
  }
  return flags.subject;
}

function checkSubjectAgainstCC({ subject, strictCC, stderr }) {
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

async function commitOnce({ repoRoot, paths, subject, body, stderr }) {
  // N1 read-side defense — re-validate every path immediately before
  // git add. assertSafePath is cheap; running it here closes the
  // window between manifest read at planMode time and the actual git
  // add invocation. Hand-edited workflow files would be rejected here
  // even if the planMode re-validation was bypassed.
  for (const p of paths) assertSafePath(p);
  // Use `--` separator so any path that begins with `-` despite the
  // earlier assertion is still safe at the argv boundary. The catch
  // converts git-add failure into a structured refine-fallback row
  // rather than letting the throw escape commitOnce (Phase 5 M2 —
  // surface stage-failed reason alongside the existing mixed-hunk /
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
  // Mixed-hunk detection per staged path (ADR-0028 §Layer-3).
  const mixed = paths.filter((p) => detectMixedHunk({ repoRoot, path: p }));
  if (mixed.length > 0) {
    stderr.write(
      `⚠ mixed-hunk paths detected (HEAD delta larger than staged): ${mixed.join(', ')}\n` +
      `   Run \`git add --patch <path>\` interactively or split before retrying.\n`,
    );
    // Unstage everything we just staged so the user can address the
    // mixed-hunk manually (refuse-and-ask).
    gitSync(repoRoot, ['reset', 'HEAD', '--', ...paths], { allowFailure: true });
    return { ok: false, reason: 'mixed-hunk', mixed };
  }
  // git commit -m subject -F body-file. The body lives in a tmp file
  // to avoid shell-escape issues on multi-line / special-character
  // bodies.
  const tmpDir = await mkdtemp(join(tmpdir(), 'phase7-body-'));
  const bodyPath = join(tmpDir, 'BODY');
  try {
    await writeFile(bodyPath, body ?? '');
    try {
      gitSync(repoRoot, ['commit', '-m', subject, '-F', bodyPath]);
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
  const branchDecision = decideStagingBranch({
    gitChanges,
    manifestPaths,
    acceptCurrentTree,
  });
  if (branchDecision.branch === 'no-changes') {
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
  const packageMap = await readPackageMap(
    join(repoRoot, 'release-please-config.json'),
    { strict: false },
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

  // Compose body once (shared across split commits per P1).
  const diffStat = gitSync(repoRoot, ['diff', '--stat', 'HEAD'], { allowFailure: true }) ?? '';
  const ensembleSummary = pickLatestEnsembleSummary(frontmatter);
  const body = composeBody({
    originalRequest: frontmatter.original_request,
    diffStat,
    ensembleSummary,
  });

  // Per-commit pass with P2 partial-split recovery.
  const landed = [];
  for (let i = 0; i < shape.commits.length; i++) {
    const commit = shape.commits[i];
    const subject = pickSubjectForCommit({
      commit,
      flags,
      requiresSplit: shape.requiresSplit,
    });
    checkSubjectAgainstCC({ subject, strictCC, stderr });
    const result = await commitOnce({
      repoRoot,
      paths: commit.files,
      subject,
      body,
      stderr,
    });
    if (!result.ok) {
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
    }
    const sha = gitSync(repoRoot, ['rev-parse', 'HEAD']);
    landed.push(`${sha} ${subject}`);
  }

  // Post-commit gates (P11 / no-children / clean-after-commit / P10 / P5).
  // Re-read frontmatter — write helpers may have updated it; we want
  // current state for the live gate (P11 closes the Stop-hook gap by
  // checking the in-process value rather than the snapshot).
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
  // Clean-after-commit gate. The .gitignore already excludes workflow
  // storage, but we ask porcelain anyway so any user-side dirt is
  // caught.
  const afterCommit = gitSync(repoRoot, ['status', '--porcelain=v1'], { allowFailure: true }) ?? '';
  if (afterCommit.trim().length > 0) {
    stderr.write(
      `✗ working tree is not clean after commit; refusing set-terminal.\n` +
      `  Surfaced:\n` +
      afterCommit.split('\n').map((l) => `    ${l}`).join('\n') +
      `\n  Resolve via /engineer:refine or commit the remainder manually.\n`,
    );
    return { ok: false, reason: 'unclean-after-commit', landed };
  }

  // P10 — synchronous writebackParent. Skipped when this workflow has
  // no orchestrator parent linkage (direct /engineer:start invocation).
  if (
    typeof fresh.parent_workflow === 'string' &&
    fresh.parent_workflow.length > 0 &&
    typeof fresh.originating_subtask === 'string' &&
    fresh.originating_subtask.length > 0
  ) {
    const commitSha = gitSync(repoRoot, ['rev-parse', 'HEAD']);
    const closedAtIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const wbResult = await writebackParent({
      repoRoot,
      parentWorkflowId: fresh.parent_workflow,
      originatingSubtaskId: fresh.originating_subtask,
      engineerWorkflowId: fresh.id,
      commit: commitSha,
      closedAt: closedAtIso,
      host: flags.host,
      stderr,
    });
    if (wbResult && wbResult.ok === false && wbResult.skipped !== true) {
      stderr.write(
        `⚠ parent-writeback failed but Phase 7 will continue: ${wbResult.reason}\n` +
        `  The Stop hook deferred-writeback path is the backstop ` +
        `(idempotent compare-and-no-op).\n`,
      );
      // ADR-0028 §P10 second paragraph: failure is not fatal because
      // the Stop hook + subtask-update if_match guards provide a
      // backup. We proceed to set-terminal.
    }
  }

  // P5 — set-terminal LAST. Picks 'commit-complete' phase as the
  // terminal whitelist value used by the auto-archive gate.
  await setTerminal({
    workflowPath,
    host: flags.host,
    terminalPhase: 'commit-complete',
    terminalMarker: true,
    nextAction: 'archive',
    event: 'updated',
  });
  return { ok: true, landed };
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
