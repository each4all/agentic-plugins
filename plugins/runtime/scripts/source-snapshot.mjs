import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

const SOURCE_SNAPSHOT_SCHEMA = 'runtime-source-snapshot-1.0';
const GIT_TIMEOUT_MS = 3000;
const LINE_TERMINATOR_RE = /\r?\n$/;

export async function resolveSourceSnapshot({ repoRoot, snapshot, observedAt }) {
  if (snapshot) {
    return normalizeSourceSnapshot(snapshot, observedAt);
  }
  return observeGitSnapshot(repoRoot, observedAt);
}

export function buildSourceFreshness({ artifactSnapshot, currentSnapshot }) {
  const artifactCommit = artifactSnapshot?.commit ?? null;
  const currentCommit = currentSnapshot?.commit ?? null;
  const base = {
    artifact_kind: artifactSnapshot?.kind ?? 'git',
    current_kind: currentSnapshot?.kind ?? 'git',
    artifact_commit: artifactCommit,
    current_commit: currentCommit,
    artifact_branch: artifactSnapshot?.branch ?? null,
    current_branch: currentSnapshot?.branch ?? null,
    artifact_dirty: artifactSnapshot?.dirty ?? null,
    current_dirty: currentSnapshot?.dirty ?? null,
  };
  if (artifactSnapshot?.status !== 'observed' || !artifactCommit) {
    return {
      ...base,
      status: 'unknown',
      reason: 'context artifact has no observed git commit snapshot',
    };
  }
  if (currentSnapshot?.status !== 'observed' || !currentCommit) {
    return {
      ...base,
      status: 'unknown',
      reason: 'current git commit could not be observed',
    };
  }
  if (artifactCommit !== currentCommit) {
    return {
      ...base,
      status: 'stale',
      reason: 'current git commit differs from the context artifact commit',
    };
  }
  if (artifactSnapshot.dirty === true) {
    return {
      ...base,
      status: 'dirty_artifact',
      reason: 'context artifact was captured from a dirty worktree; the uncommitted source state cannot be verified from the commit alone',
    };
  }
  return {
    ...base,
    status: 'current',
    reason: currentSnapshot.dirty === true
      ? 'current git commit matches the context artifact commit; current worktree has uncommitted changes'
      : 'current git commit matches the context artifact commit',
  };
}

export function formatSourceFreshness(freshness) {
  return [
    'source freshness:',
    `- source status: ${freshness.status}`,
    `- artifact_commit: ${shortCommit(freshness.artifact_commit)}`,
    `- current_commit: ${shortCommit(freshness.current_commit)}`,
    `- artifact_dirty: ${freshness.artifact_dirty}`,
    `- current_dirty: ${freshness.current_dirty}`,
    `- reason: ${freshness.reason}`,
  ];
}

async function observeGitSnapshot(repoRoot, observedAt) {
  try {
    const commit = (await execGit(repoRoot, ['rev-parse', 'HEAD'])).trim();
    let branch = null;
    try {
      const branchText = (await execGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      branch = branchText && branchText !== 'HEAD' ? branchText : null;
    } catch {
      branch = null;
    }
    let dirty = null;
    try {
      // drift-digest: --untracked-files=normal so untracked files are seen even under a
      // user's status.showUntrackedFiles=no (without it such a tree hashes/classifies as
      // CLEAN). `normal` — not `all` — is deliberate and measured: it overrides the config
      // exactly the same way, but keeps git's directory collapsing, so the output bytes are
      // IDENTICAL to the historical default-config behaviour (`?? sub/`). `all` would expand
      // each untracked dir into its files, changing every digest and dirty_count and paying
      // a full recursive walk on huge untracked trees.
      dirty = Boolean((await execGit(repoRoot, ['status', '--porcelain', '--untracked-files=normal'])).trim());
    } catch {
      dirty = null;
    }
    return normalizeSourceSnapshot({
      status: 'observed',
      kind: 'git',
      commit,
      branch,
      dirty,
    }, observedAt);
  } catch (error) {
    return normalizeSourceSnapshot({
      status: 'unavailable',
      kind: 'git',
      reason: sanitizeSourceReason(error?.message ?? 'git unavailable'),
    }, observedAt);
  }
}

// ADR-0044 §6 repo-root probe, split from the structural facts below so
// the publisher's gate-off path costs exactly ONE spawn per turn (the
// accepted notify cost shape, ADR-0044 Consequences) and the remaining
// probes can run in their §10 transaction position — inside the slot
// lock, after the committed-generation read. Failure or a suspicious
// toplevel ⇒ null (non-git start dir; the publisher no-ops upstream).
export async function resolveGitTopLevel(startDir) {
  try {
    // Strip ONLY git's terminating line break — never trim(): a repository
    // path may legitimately begin or end with spaces, and trimming them
    // resolves a DIFFERENT sibling directory, redirecting every subsequent
    // write outside the real repo (plan-verify peer critical, reproduced
    // with sibling dirs `repo ` vs `repo`).
    const top = String(await execGit(startDir, ['rev-parse', '--show-toplevel'])).replace(LINE_TERMINATOR_RE, '');
    if (!top || /[\r\n\u0000]/.test(top)) return null;
    return top;
  } catch {
    return null;
  }
}

// ADR-0044 §6/§9 — the publish-session publisher's bounded structural git
// observation over an ALREADY-RESOLVED repo root (resolveGitTopLevel above).
// Sequential bounded probes under the execGit discipline (~3 s timeout,
// 1 MiB maxBuffer per probe), with per-field HONEST degradation
// (session-capture-contract.md §6): a failed probe nulls its own fields and
// the capture still publishes.
//   - branch: `git branch --show-current` (the contract-normative probe);
//     detached HEAD ⇒ empty output ⇒ null.
//   - head: short form; unborn HEAD / non-hex output ⇒ null.
//   - status digest + dirty count: sha256 hex over the
//     `git status --porcelain=v1 -z --untracked-files=normal` output with the
//     entry count; output past
//     the probe byte cap (maxBuffer) or a probe error ⇒ BOTH null — a null
//     digest is "unknown", never "clean".
export async function observeSessionGitFacts(repoRoot) {
  const facts = { branch: null, headShort: null, dirtyCount: null, statusDigest: null };
  // The capture contract collapses detached HEAD ('') into null (§6); only
  // the entry-side observeCurrentBranch keeps the distinction.
  const branch = await probeCurrentBranch(repoRoot);
  facts.branch = branch === '' ? null : branch;
  try {
    const head = (await execGit(repoRoot, ['rev-parse', '--short', 'HEAD'])).trim();
    facts.headShort = /^[0-9a-f]{7,40}$/.test(head) ? head : null;
  } catch {
    facts.headShort = null;
  }
  try {
    const porcelain = await probeStatusPorcelain(repoRoot);
    facts.statusDigest = createHash('sha256').update(Buffer.from(porcelain, 'latin1')).digest('hex');
    facts.dirtyCount = countPorcelainEntries(porcelain);
  } catch {
    facts.statusDigest = null;
    facts.dirtyCount = null;
  }
  return facts;
}

// ADR-0045 §3/§5 — the entry arbiter's branch probe, satisfying the S7a
// collectEntrySources branchProbe contract exactly: a branch name string,
// '' for detached HEAD, or null when the probe fails or the value is
// hostile (>256 chars or control characters — degraded, never surfaced).
// Shared primitive with observeSessionGitFacts so the two surfaces cannot
// drift on the probe argv or the hostile-value guard.
export async function observeCurrentBranch(repoRoot) {
  return probeCurrentBranch(repoRoot);
}

// ADR-0045 §5.3 — the dirty gate's worktree probe (`orchestrator:next` is
// synthesized only on a provably clean tree; null is "unknown, never
// clean"). Same bounded porcelain probe the capture publisher uses.
export async function observeWorktreeDirtyCount(repoRoot) {
  try {
    return countPorcelainEntries(await probeStatusPorcelain(repoRoot));
  } catch {
    return null;
  }
}

async function probeCurrentBranch(repoRoot) {
  try {
    const branch = (await execGit(repoRoot, ['branch', '--show-current'])).trim();
    if (branch === '') return '';
    return branch.length <= 256 && !/[\u0000-\u001f\u007f]/.test(branch) ? branch : null;
  } catch {
    return null;
  }
}

// --no-optional-locks: a plain `git status` may refresh and WRITE the
// index under .git — outside the declared session-capture / entry-brief
// write authority (ADR-0035 M1/R0; plan-verify peer). The exact argv form
// is registered in the guard's git verb-path allowlist.
// latin1 decoding is byte-preserving (1:1 code points), so hashing its
// re-encoding digests the ACTUAL porcelain output bytes even for
// non-UTF-8 filenames (contract §6: sha256 over the command output);
// NUL positions are byte-identical, so the entry counter is unaffected.
function probeStatusPorcelain(repoRoot) {
  // drift-digest: --untracked-files=normal so untracked files are seen even under a
  // user's status.showUntrackedFiles=no (without it such a tree hashes/classifies as
  // CLEAN). `normal` — not `all` — is deliberate and measured: it overrides the config
  // exactly the same way, but keeps git's directory collapsing, so the output bytes are
  // IDENTICAL to the historical default-config behaviour (`?? sub/`). `all` would expand
  // each untracked dir into its files, changing every digest and dirty_count and paying
  // a full recursive walk on huge untracked trees.
  return execGit(repoRoot, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=normal'], { encoding: 'latin1' });
}

// porcelain v1 -z: each entry is `XY PATH\0`, and a rename/copy entry carries
// one extra `ORIG\0` field — count entries, not NUL-separated fragments. The
// rename/copy marker can sit in EITHER column (index `R `, worktree ` R` —
// plan-verify peer reproduced the worktree form miscounting as two entries).
function countPorcelainEntries(porcelain) {
  const parts = String(porcelain).split('\0');
  let count = 0;
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] === '') continue;
    count += 1;
    const status = parts[i].slice(0, 2);
    if (/[RC]/.test(status)) i += 1;
  }
  return count;
}

function execGit(repoRoot, args, { encoding = 'utf8' } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      'git',
      ['-C', repoRoot, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding },
      (error, stdout) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

function normalizeSourceSnapshot(snapshot, observedAt) {
  const status = snapshot.status === 'observed' && snapshot.commit
    ? 'observed'
    : 'unavailable';
  return {
    schema_version: SOURCE_SNAPSHOT_SCHEMA,
    kind: 'git',
    status,
    commit: status === 'observed'
      ? requireSingleLine(String(snapshot.commit), 'source_snapshot.commit')
      : null,
    branch: status === 'observed' && snapshot.branch
      ? requireSingleLine(String(snapshot.branch), 'source_snapshot.branch')
      : null,
    dirty: status === 'observed' && typeof snapshot.dirty === 'boolean'
      ? snapshot.dirty
      : null,
    observed_at: observedAt,
    reason: status === 'observed'
      ? null
      : sanitizeSourceReason(snapshot.reason ?? 'git source snapshot unavailable'),
  };
}

function shortCommit(value) {
  return value ? String(value).slice(0, 12) : 'unknown';
}

function sanitizeSourceReason(value) {
  return String(value ?? 'unknown').replace(/[\r\n]+/g, ' ').slice(0, 200);
}

function requireSingleLine(value, flag) {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${flag} must be a single-line value`);
  }
  return value;
}
