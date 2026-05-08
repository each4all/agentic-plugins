// Cross-host integration test — Stop hook runStopArchive contract identity
// (engineer schema 1.1, ADR-0018 §sub-decision 5 PR4 test extension).
// Identical fixture state + different host parameter MUST produce
// identical archive outcomes.
//
// Scope: engineer ONLY. orchestrator MVP's Stop hook is snapshot-only
// (no auto-archive); orchestrator Stop semantics are verified by
// tests/orchestrator/test-hooks.mjs.
//
// In-process invocation: runStopArchive imported directly per ADR-0018
// §sub-5 "Hooks for both hosts are simulated in-process". Stop-script
// stdin/cwd asymmetry is verified separately by
// tests/engineer/test-stop-archive.mjs.
//
// Run via `npm run test:cross-host`.

import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withTmpGitRepo } from './_helpers.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');

const engineerState = await import(
  resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs')
);
const stopArchive = await import(
  resolve(REPO_ROOT, 'plugins/engineer/scripts/stop-archive.mjs')
);

const MIN_DIGEST =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

async function setFrontmatter(workflowPath, mutator) {
  const text = await readFile(workflowPath, 'utf8');
  const { frontmatter, body } = engineerState.parseWorkflowFile(text);
  mutator(frontmatter);
  await writeFile(
    workflowPath,
    engineerState.assembleWorkflowFile(frontmatter, body),
  );
}

function advanceHead(repoRoot, env, subject = 'feat(plugins/engineer): advance') {
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', subject], {
    cwd: repoRoot, env,
  });
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot, env, encoding: 'utf8',
  }).trim();
}

async function setupArchivableFixture(host) {
  return withTmpGitRepo(`cross-host-stop-fixture-${host}`, async ({ repoRoot, env }) => {
    const baselineHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot, env, encoding: 'utf8',
    }).trim();
    const { filePath } = await engineerState.createWorkflow({
      repoRoot,
      verb: 'compose',
      originalRequest: 'cross-host stop-archive',
      gitBaseline: {
        branch: 'main',
        head: baselineHead,
        status_digest: MIN_DIGEST,
      },
      host,
    });
    await setFrontmatter(filePath, (fm) => {
      fm.current_phase = 'summary-complete';
      fm.terminal_marker = true;
      fm.child_completions = [];
    });
    const advancedHead = advanceHead(repoRoot, env);
    const headSubject = execFileSync(
      'git',
      ['log', '-1', '--pretty=%s'],
      { cwd: repoRoot, env, encoding: 'utf8' },
    ).trim();

    const result = await stopArchive.runStopArchive({
      workflowPath: filePath,
      host,
      repoRoot,
      statusDigest: MIN_DIGEST,
      headSha: advancedHead,
      headSubject,
    });
    const archiveFiles = await readdir(
      join(repoRoot, engineerState.ARCHIVE_DIR_REL),
    );
    let archivedText = null;
    if (result.archived && result.to) {
      archivedText = await readFile(result.to, 'utf8');
    }
    return {
      repoRoot,
      filePath,
      result,
      archiveFiles,
      archivedText,
    };
  });
}

// Normalize a frontmatter object so cross-host invocations on identical
// fixture *contracts* (not identical bytes) can be compared. Strips:
//   - workflow_id, started_at, updated_at: timestamped per fixture
//   - repo_root: tmp dir per fixture
//   - git_baseline.head: commit SHA varies across fixtures because
//     `git commit` includes its own timestamp in the commit object
//     (Codex review P2 finding — without this, the comparison is
//     non-deterministic / CI-flaky)
//   - last_snapshot.at: snapshot timestamp
//   - last_snapshot.host (defensive): MVP shape has no host field but
//     a future addition would silently mask divergence; strip for
//     forward-compatibility
//   - host_history[*].at: per-event timestamps
//
// Does NOT strip host_history[*].host or last entry's archived host —
// per-entry host attribution MUST survive the host boundary write.
// Stripping host would mask a host-inversion bug (claude call writing
// 'codex' to history, or vice versa). Critical issue from review.
function normalizeFrontmatter(fm) {
  const clone = structuredClone(fm);
  delete clone.workflow_id;
  delete clone.started_at;
  delete clone.updated_at;
  delete clone.repo_root;
  if (clone.git_baseline) {
    delete clone.git_baseline.head;
  }
  if (clone.last_snapshot) {
    delete clone.last_snapshot.at;
    delete clone.last_snapshot.host;
  }
  if (Array.isArray(clone.host_history)) {
    clone.host_history = clone.host_history.map(({ at, ...rest }) => rest);
  }
  return clone;
}

// Apply a host-rename to A's normalized form so comparison against B's
// normalized form succeeds when the only legitimate difference is the
// host name. This catches inversion bugs: if A (created with
// host='claude') wrote 'codex' anywhere, the rename would not align
// with B's structure and the deepStrictEqual would fail.
function renameHostInHistory(fm, fromHost, toHost) {
  const clone = structuredClone(fm);
  if (Array.isArray(clone.host_history)) {
    clone.host_history = clone.host_history.map((e) =>
      e.host === fromHost ? { ...e, host: toHost } : e,
    );
  }
  return clone;
}

// ---------------------------------------------------------------------------

describe('cross-host stop-archive — engineer (schema 1.1)', () => {
  it('runStopArchive(host=claude) and runStopArchive(host=codex) on identical fixture both archive', async () => {
    const a = await setupArchivableFixture('claude');
    const b = await setupArchivableFixture('codex');

    strictEqual(a.result.archived, true);
    strictEqual(b.result.archived, true);
    ok(a.result.to);
    ok(b.result.to);
  });

  it('archive relative path identical (workflow_id varies but archive subdir + filename pattern match)', async () => {
    const a = await setupArchivableFixture('claude');
    const b = await setupArchivableFixture('codex');

    strictEqual(a.archiveFiles.length, 1);
    strictEqual(b.archiveFiles.length, 1);
    ok(a.archiveFiles[0].endsWith('.md'));
    ok(b.archiveFiles[0].endsWith('.md'));
    strictEqual(basename(a.result.to), a.archiveFiles[0]);
    strictEqual(basename(b.result.to), b.archiveFiles[0]);
  });

  it('archived frontmatter is structurally identical after normalization + host rename', async () => {
    const a = await setupArchivableFixture('claude');
    const b = await setupArchivableFixture('codex');

    const fmA = engineerState.parseWorkflowFile(a.archivedText).frontmatter;
    const fmB = engineerState.parseWorkflowFile(b.archivedText).frontmatter;
    // Rename A's claude→codex hosts so the only legitimate cross-host
    // difference is normalized away. The deepStrictEqual then catches
    // any structural divergence beyond the host name itself, including
    // host inversion bugs (where A would have written 'codex'
    // instead of 'claude' anywhere in host_history).
    deepStrictEqual(
      normalizeFrontmatter(renameHostInHistory(fmA, 'claude', 'codex')),
      normalizeFrontmatter(fmB),
      'normalized frontmatter must match across host transitions (host rename applied)',
    );
  });

  it('host_history records each host correctly (per-entry attribution survives)', async () => {
    const a = await setupArchivableFixture('claude');
    const b = await setupArchivableFixture('codex');

    const fmA = engineerState.parseWorkflowFile(a.archivedText).frontmatter;
    const fmB = engineerState.parseWorkflowFile(b.archivedText).frontmatter;

    // Event sequence identical regardless of host.
    const eventsA = fmA.host_history.map((e) => e.event);
    const eventsB = fmB.host_history.map((e) => e.event);
    deepStrictEqual(eventsA, eventsB);
    ok(eventsA.includes('archived'));

    // Per-entry host attribution: every entry written by the
    // claude-side run must record host='claude', and likewise for
    // codex. This catches host inversion bugs that the structural
    // comparison above (with rename) cannot.
    for (const entry of fmA.host_history) {
      strictEqual(entry.host, 'claude', 'all engineer-claude entries must record host=claude');
    }
    for (const entry of fmB.host_history) {
      strictEqual(entry.host, 'codex', 'all engineer-codex entries must record host=codex');
    }
  });

  it('gate failure is host-invariant — fixture missing terminal_marker fails identically under both hosts', async () => {
    async function setupNonArchivableFixture(host) {
      return withTmpGitRepo(`cross-host-stop-gate-fail-${host}`, async ({ repoRoot, env }) => {
        const baselineHead = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: repoRoot, env, encoding: 'utf8',
        }).trim();
        const { filePath } = await engineerState.createWorkflow({
          repoRoot,
          verb: 'compose',
          originalRequest: 'gate fail',
          gitBaseline: {
            branch: 'main',
            head: baselineHead,
            status_digest: MIN_DIGEST,
          },
          host,
        });
        // Intentionally do NOT set terminal_marker → A1 fails.
        await setFrontmatter(filePath, (fm) => {
          fm.current_phase = 'summary-complete';
          fm.child_completions = [];
        });
        const advancedHead = advanceHead(repoRoot, env);
        const headSubject = execFileSync('git', ['log', '-1', '--pretty=%s'], {
          cwd: repoRoot, env, encoding: 'utf8',
        }).trim();

        return stopArchive.runStopArchive({
          workflowPath: filePath,
          host,
          repoRoot,
          statusDigest: MIN_DIGEST,
          headSha: advancedHead,
          headSubject,
        });
      });
    }

    const a = await setupNonArchivableFixture('claude');
    const b = await setupNonArchivableFixture('codex');

    strictEqual(a.archived, false);
    strictEqual(b.archived, false);
    strictEqual(a.reason, 'gate-not-met');
    strictEqual(b.reason, 'gate-not-met');
    ok(a.gateFailures.includes('terminal_marker'));
    ok(b.gateFailures.includes('terminal_marker'));
    deepStrictEqual(a.gateFailures.sort(), b.gateFailures.sort());
  });
});
