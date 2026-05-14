import { execFile } from 'node:child_process';

const SOURCE_SNAPSHOT_SCHEMA = 'runtime-source-snapshot-1.0';
const GIT_TIMEOUT_MS = 3000;

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
      dirty = Boolean((await execGit(repoRoot, ['status', '--porcelain'])).trim());
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

function execGit(repoRoot, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      'git',
      ['-C', repoRoot, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
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
