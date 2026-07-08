// plugins/designer/scripts/stop-archive.mjs +
// adapters/{claude,codex}/hooks/stop.mjs integration tests
// (ADR-0017 §sub-decision 5).
//
// Validation contract per ADR-0017 §sub-decision 5 §Validation:
//   (a) all conditions met → archive
//   (b) terminal_marker unset → no archive (default off)
//   (c) head moved but no terminal marker → no archive (subsumed by b)
//   (d) active children present → no archive
//   (e) terminal phase outside whitelist → no archive
// Plus the conventional-commit soft gate:
//   (f) HEAD subject is non-conventional → stderr warning, archive proceeds
//
// Two surfaces are exercised:
//   1. Pure `evaluateStopArchive` — fast unit cases over the gate logic.
//   2. The `stop.mjs` script for both hosts (Claude + Codex) spawned as a
//      child process — same surface the host's lifecycle event invokes.
//
// Run via `node --test tests/designer/test-stop-archive.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, match } from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE_PATH = resolve(REPO_ROOT, 'plugins/designer/scripts/state.mjs');
const STOP_ARCHIVE_PATH = resolve(
  REPO_ROOT,
  'plugins/designer/scripts/stop-archive.mjs',
);
const CLAUDE_STOP_PATH = resolve(
  REPO_ROOT,
  'plugins/designer/adapters/claude/hooks/stop.mjs',
);
const CODEX_STOP_PATH = resolve(
  REPO_ROOT,
  'plugins/designer/adapters/codex/hooks/stop.mjs',
);
const CODEX_PRE_COMPACT_PATH = resolve(
  REPO_ROOT,
  'plugins/designer/adapters/codex/hooks/pre-compact.mjs',
);

const { createWorkflow, parseWorkflowFile, branchRefState, ARCHIVE_DIR_REL, WORKFLOW_DIR_REL } =
  await import(STATE_PATH);
const { evaluateStopArchive, runStopArchive, runStopArchiveOrphanSweep } =
  await import(STOP_ARCHIVE_PATH);

const MIN_DIGEST =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// -----------------------------------------------------------------------------
// Pure unit tests for evaluateStopArchive

describe('evaluateStopArchive — pure unit cases (ADR-0017 §sub-5 gates)', () => {
  const baselineHead = 'a'.repeat(40);
  const advancedHead = 'b'.repeat(40);
  const baseFm = {
    current_phase: 'summary-complete',
    terminal_marker: true,
    git_baseline: { branch: 'main', head: baselineHead, status_digest: '' },
    child_completions: [],
  };

  it('all 4 hard gates pass + conventional subject → shouldArchive=true, no warnings', () => {
    const v = evaluateStopArchive({
      frontmatter: baseFm,
      headSha: advancedHead,
      headSubject: 'feat(plugins/designer): something',
    });
    strictEqual(v.shouldArchive, true);
    strictEqual(v.gateFailures.length, 0);
    strictEqual(v.warnings.length, 0);
  });

  it('terminal_marker absent → gateFailures includes terminal_marker', () => {
    const v = evaluateStopArchive({
      frontmatter: { ...baseFm, terminal_marker: undefined },
      headSha: advancedHead,
      headSubject: 'feat: x',
    });
    strictEqual(v.shouldArchive, false);
    ok(v.gateFailures.includes('terminal_marker'));
  });

  it('terminal_marker set to "true" string → still rejected (Codex M5 strict)', () => {
    const v = evaluateStopArchive({
      frontmatter: { ...baseFm, terminal_marker: 'true' },
      headSha: advancedHead,
      headSubject: 'feat: x',
    });
    strictEqual(v.shouldArchive, false);
    ok(v.gateFailures.includes('terminal_marker'));
  });

  it('current_phase outside whitelist → gateFailures includes terminal_phase', () => {
    const v = evaluateStopArchive({
      frontmatter: { ...baseFm, current_phase: 'phase-2-presented' },
      headSha: advancedHead,
      headSubject: 'feat: x',
    });
    strictEqual(v.shouldArchive, false);
    ok(v.gateFailures.includes('terminal_phase'));
  });

  it('HEAD has not moved (headSha equals baseline) → gateFailures includes head_moved', () => {
    const v = evaluateStopArchive({
      frontmatter: baseFm,
      headSha: baselineHead,
      headSubject: 'feat: x',
    });
    strictEqual(v.shouldArchive, false);
    ok(v.gateFailures.includes('head_moved'));
  });

  it('git probe failure (headSha=null) → gateFailures includes head_moved (defensive)', () => {
    const v = evaluateStopArchive({
      frontmatter: baseFm,
      headSha: null,
      headSubject: null,
    });
    strictEqual(v.shouldArchive, false);
    ok(v.gateFailures.includes('head_moved'));
  });

  it('child_completions has entry missing closed_at → gateFailures includes no_active_children', () => {
    const v = evaluateStopArchive({
      frontmatter: {
        ...baseFm,
        child_completions: [{ commit: 'abc', closed_at: '' }],
      },
      headSha: advancedHead,
      headSubject: 'feat: x',
    });
    strictEqual(v.shouldArchive, false);
    ok(v.gateFailures.includes('no_active_children'));
  });

  it('non-conventional subject → archive still pass, warnings populated', () => {
    const v = evaluateStopArchive({
      frontmatter: baseFm,
      headSha: advancedHead,
      headSubject: 'wip stuff',
    });
    strictEqual(v.shouldArchive, true);
    strictEqual(v.gateFailures.length, 0);
    strictEqual(v.warnings.length, 1);
    match(v.warnings[0], /^conventional_commit:non_conventional_subject:/);
  });

  it('conventional subject with scope passes the soft gate', () => {
    const v = evaluateStopArchive({
      frontmatter: baseFm,
      headSha: advancedHead,
      headSubject: 'fix(plugins/designer): leak',
    });
    strictEqual(v.shouldArchive, true);
    strictEqual(v.warnings.length, 0);
  });

  it('null subject → soft gate skipped (no false-positive warning)', () => {
    const v = evaluateStopArchive({
      frontmatter: baseFm,
      headSha: advancedHead,
      headSubject: null,
    });
    strictEqual(v.shouldArchive, true);
    strictEqual(v.warnings.length, 0);
  });

  it('all 4 hard gates fail simultaneously → all four reasons reported', () => {
    const v = evaluateStopArchive({
      frontmatter: {
        current_phase: 'phase-2-presented',
        terminal_marker: false,
        git_baseline: { head: baselineHead },
        child_completions: [{ commit: 'abc' /* closed_at missing */ }],
      },
      headSha: baselineHead,
      headSubject: 'feat: x',
    });
    strictEqual(v.shouldArchive, false);
    ok(v.gateFailures.includes('terminal_marker'));
    ok(v.gateFailures.includes('terminal_phase'));
    ok(v.gateFailures.includes('head_moved'));
    ok(v.gateFailures.includes('no_active_children'));
  });
});

// -----------------------------------------------------------------------------
// Integration tests: spawn stop.mjs against a tmp git repo

async function withTmpGitRepo(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'designer-stop-archive-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    await writeFile(join(dir, 'README.md'), '# tmp\n');
    execFileSync('git', ['add', 'README.md'], { cwd: dir });
    execFileSync(
      'git',
      ['commit', '-q', '-m', 'feat: initial commit'],
      { cwd: dir },
    );
    const baselineHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
    await fn({ repoRoot: dir, baselineHead });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function setFrontmatter(workflowPath, mutator) {
  const text = await readFile(workflowPath, 'utf8');
  const { frontmatter, body } = parseWorkflowFile(text);
  mutator(frontmatter);
  // Re-serialize via state.mjs's CLI? No — we can write the YAML
  // ourselves trivially since these are scalar / list overrides on
  // already-valid frontmatter. We round-trip through assembleWorkflowFile
  // by importing the helper.
  const { assembleWorkflowFile } = await import(STATE_PATH);
  await writeFile(workflowPath, assembleWorkflowFile(frontmatter, body));
}

function spawnStopHook({
  hostScript,
  cwd,
  payload = '{}',
}) {
  const cp = spawnSync(process.execPath, [hostScript], {
    cwd,
    input: payload,
    encoding: 'utf8',
  });
  return { code: cp.status, stdout: cp.stdout, stderr: cp.stderr };
}

async function listWorkflows(repoRoot) {
  const dir = join(repoRoot, WORKFLOW_DIR_REL);
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith('.md'));
  } catch {
    return [];
  }
}

async function listArchive(repoRoot) {
  const dir = join(repoRoot, ARCHIVE_DIR_REL);
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith('.md'));
  } catch {
    return [];
  }
}

function makeAdvanceCommit(repoRoot, subject = 'feat(plugins/designer): work') {
  // Empty commit advances HEAD without touching tree, ideal for the
  // HEAD-moved gate without dragging the test into source-tree concerns.
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', subject], {
    cwd: repoRoot,
  });
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
}

describe('Codex pre-compact hook — snapshot parity', () => {
  it('writes last_snapshot trigger=pre-compact with host="codex"', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'codex precompact',
        gitBaseline: {
          branch: 'main',
          head: baselineHead,
          status_digest: MIN_DIGEST,
        },
        host: 'codex',
      });

      const { code, stderr } = spawnStopHook({
        hostScript: CODEX_PRE_COMPACT_PATH,
        cwd: repoRoot,
        payload: JSON.stringify({ cwd: repoRoot }),
      });

      strictEqual(code, 0, `stderr: ${stderr}`);
      const { frontmatter } = parseWorkflowFile(await readFile(filePath, 'utf8'));
      strictEqual(frontmatter.last_snapshot.trigger, 'pre-compact');
      ok(frontmatter.host_history.some((entry) => entry.host === 'codex' && entry.event === 'snapshot'));
    });
  });
});

describe('Claude stop hook — case (a) all gates pass → archive', () => {
  it('moves the workflow into archive/ and exits 0', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'test stop archive',
        gitBaseline: {
          branch: 'main',
          head: baselineHead,
          status_digest: MIN_DIGEST,
        },
        host: 'claude',
      });
      await setFrontmatter(filePath, (fm) => {
        fm.current_phase = 'summary-complete';
        fm.terminal_marker = true;
      });
      makeAdvanceCommit(repoRoot);

      const { code, stderr } = spawnStopHook({
        hostScript: CLAUDE_STOP_PATH,
        cwd: repoRoot,
      });

      strictEqual(code, 0, `stderr: ${stderr}`);
      const live = await listWorkflows(repoRoot);
      const archived = await listArchive(repoRoot);
      strictEqual(live.length, 0, 'workflow file should have been archived');
      strictEqual(archived.length, 1, 'archive should contain one entry');
    });
  });
});

describe('Claude stop hook — case (g) cross-branch workflow → no archive (ADR-0018 §sub-2)', () => {
  it('leaves the workflow in workflows/ when its git_baseline.branch differs from current branch', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      // 'other' is a REAL branch here. Fixture is on 'main', so
      // findActiveWorkflow returns null for the 'other' workflow and
      // runStopArchive leaves it. The ADR-0031 orphan sweep ALSO leaves it,
      // because branchRefState('other')='present' — a terminal cross-branch
      // workflow whose branch still exists is something you can switch back
      // to; only a DELETED-branch orphan is swept (covered separately).
      execFileSync('git', ['branch', 'other'], { cwd: repoRoot });
      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'cross-branch stop',
        gitBaseline: {
          branch: 'other',
          head: baselineHead,
          status_digest: MIN_DIGEST,
        },
        host: 'claude',
      });
      await setFrontmatter(filePath, (fm) => {
        fm.current_phase = 'summary-complete';
        fm.terminal_marker = true;
      });
      makeAdvanceCommit(repoRoot);
      const { code, stderr } = spawnStopHook({
        hostScript: CLAUDE_STOP_PATH,
        cwd: repoRoot,
      });
      strictEqual(code, 0, `stderr: ${stderr}`);
      strictEqual(
        (await listWorkflows(repoRoot)).length,
        1,
        'workflow should remain in workflows/ (cross-branch silent)',
      );
      strictEqual(
        (await listArchive(repoRoot)).length,
        0,
        'archive/ should remain empty',
      );
    });
  });
});

describe('Claude stop hook — case (b) terminal_marker unset → no archive', () => {
  it('leaves the workflow in workflows/ and exits 0', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'no terminal marker',
        gitBaseline: {
          branch: 'main',
          head: baselineHead,
          status_digest: MIN_DIGEST,
        },
        host: 'claude',
      });
      // NOTE: terminal_marker intentionally NOT set; current_phase still
      // also outside whitelist — both fail.
      await setFrontmatter(filePath, (fm) => {
        fm.current_phase = 'summary-complete';
        // terminal_marker omitted on purpose
      });
      makeAdvanceCommit(repoRoot);

      const { code } = spawnStopHook({
        hostScript: CLAUDE_STOP_PATH,
        cwd: repoRoot,
      });

      strictEqual(code, 0);
      strictEqual((await listWorkflows(repoRoot)).length, 1);
      strictEqual((await listArchive(repoRoot)).length, 0);
    });
  });
});

describe('Claude stop hook — case (c) HEAD has not moved → no archive', () => {
  it('leaves the workflow in workflows/ when HEAD == baseline', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'head not moved',
        gitBaseline: {
          branch: 'main',
          head: baselineHead,
          status_digest: MIN_DIGEST,
        },
        host: 'claude',
      });
      await setFrontmatter(filePath, (fm) => {
        fm.current_phase = 'summary-complete';
        fm.terminal_marker = true;
      });
      // No advance commit — HEAD === baselineHead.

      const { code } = spawnStopHook({
        hostScript: CLAUDE_STOP_PATH,
        cwd: repoRoot,
      });

      strictEqual(code, 0);
      strictEqual((await listWorkflows(repoRoot)).length, 1);
      strictEqual((await listArchive(repoRoot)).length, 0);
    });
  });
});

describe('Claude stop hook — case (d) active children present → no archive', () => {
  it('leaves the workflow when child_completions has incomplete entry', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'active child',
        gitBaseline: {
          branch: 'main',
          head: baselineHead,
          status_digest: MIN_DIGEST,
        },
        host: 'claude',
      });
      await setFrontmatter(filePath, (fm) => {
        fm.current_phase = 'summary-complete';
        fm.terminal_marker = true;
        // Incomplete entry: closed_at is empty string → noActiveChildrenCheck=false.
        // child_id is REQUIRED by the schema serializer (ADR-0017) — set it so
        // the disk write succeeds; the gate's verdict is what we want to assert.
        fm.child_completions = [
          {
            child_id: 'wf-test-child-1',
            spawned_at: '2026-05-07T00:00:00Z',
            commit: 'abc1234',
            closed_at: '',
          },
        ];
      });
      makeAdvanceCommit(repoRoot);

      const { code } = spawnStopHook({
        hostScript: CLAUDE_STOP_PATH,
        cwd: repoRoot,
      });

      strictEqual(code, 0);
      strictEqual((await listWorkflows(repoRoot)).length, 1);
      strictEqual((await listArchive(repoRoot)).length, 0);
    });
  });
});

describe('Claude stop hook — case (e) phase outside whitelist → no archive', () => {
  it('leaves the workflow in workflows/ when phase is phase-2-presented', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'wrong phase',
        gitBaseline: {
          branch: 'main',
          head: baselineHead,
          status_digest: MIN_DIGEST,
        },
        host: 'claude',
      });
      await setFrontmatter(filePath, (fm) => {
        fm.current_phase = 'phase-2-presented'; // outside whitelist
        fm.terminal_marker = true;
      });
      makeAdvanceCommit(repoRoot);

      const { code } = spawnStopHook({
        hostScript: CLAUDE_STOP_PATH,
        cwd: repoRoot,
      });

      strictEqual(code, 0);
      strictEqual((await listWorkflows(repoRoot)).length, 1);
      strictEqual((await listArchive(repoRoot)).length, 0);
    });
  });
});

describe('Claude stop hook — case (f) non-conventional subject → warning + archive', () => {
  it('emits a stderr warning but still archives when other gates pass', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'non-conventional subject',
        gitBaseline: {
          branch: 'main',
          head: baselineHead,
          status_digest: MIN_DIGEST,
        },
        host: 'claude',
      });
      await setFrontmatter(filePath, (fm) => {
        fm.current_phase = 'summary-complete';
        fm.terminal_marker = true;
      });
      makeAdvanceCommit(repoRoot, 'wip-progress'); // non-conventional

      const { code, stderr } = spawnStopHook({
        hostScript: CLAUDE_STOP_PATH,
        cwd: repoRoot,
      });

      strictEqual(code, 0);
      match(
        stderr,
        /conventional_commit:non_conventional_subject:wip-progress/,
        `stderr should mention non-conventional subject; got: ${stderr}`,
      );
      strictEqual((await listWorkflows(repoRoot)).length, 0, 'should still archive');
      strictEqual((await listArchive(repoRoot)).length, 1);
    });
  });
});

describe('Claude stop hook — no active workflow → no-op', () => {
  it('exits 0 cleanly when no workflow file exists', async () => {
    await withTmpGitRepo(async ({ repoRoot }) => {
      const { code, stderr } = spawnStopHook({
        hostScript: CLAUDE_STOP_PATH,
        cwd: repoRoot,
      });
      strictEqual(code, 0, `stderr: ${stderr}`);
      strictEqual((await listArchive(repoRoot)).length, 0);
    });
  });
});

describe('Codex stop hook — parity: case (a) all gates pass → archive', () => {
  it('archives via Codex script with host="codex" recorded', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'codex parity',
        gitBaseline: {
          branch: 'main',
          head: baselineHead,
          status_digest: MIN_DIGEST,
        },
        host: 'codex',
      });
      await setFrontmatter(filePath, (fm) => {
        fm.current_phase = 'summary-complete';
        fm.terminal_marker = true;
      });
      makeAdvanceCommit(repoRoot);

      const { code, stderr } = spawnStopHook({
        hostScript: CODEX_STOP_PATH,
        cwd: repoRoot,
        payload: '', // codex stop.mjs does not read stdin
      });

      strictEqual(code, 0, `stderr: ${stderr}`);
      strictEqual((await listWorkflows(repoRoot)).length, 0);
      const archived = await listArchive(repoRoot);
      strictEqual(archived.length, 1);

      // host_history should record event=archived with host=codex
      const archivedText = await readFile(
        join(repoRoot, ARCHIVE_DIR_REL, archived[0]),
        'utf8',
      );
      const { frontmatter } = parseWorkflowFile(archivedText);
      const last = frontmatter.host_history.at(-1);
      strictEqual(last.event, 'archived');
      strictEqual(last.host, 'codex');
    });
  });
});

// ============================================================================
// designer trim guard — ADR-0042 Non-Goal 2. The engineer sibling fires the
// ADR-0019 §4 parent writeback at this point in the stop lifecycle; designer
// must archive cleanly with ZERO cross-plugin side effects, even when an
// engineer-shaped file carries parent keys (forward-compat unknowns).
// ============================================================================

describe('designer stop-archive — no parent writeback ever (ADR-0042 Non-Goal 2)', () => {
  it('archives normally; no orchestrator CLI is spawned (no parent linkage exists)', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'no parent linkage',
        gitBaseline: { branch: 'main', head: baselineHead, status_digest: MIN_DIGEST },
        host: 'claude',
      });
      await setFrontmatter(filePath, (fm) => {
        fm.current_phase = 'summary-complete';
        fm.terminal_marker = true;
      });
      const advancedHead = makeAdvanceCommit(repoRoot);
      const stderrChunks = [];
      const fakeStderr = { write: (s) => stderrChunks.push(s) };
      const result = await runStopArchive({
        workflowPath: filePath,
        host: 'claude',
        repoRoot,
        headSha: advancedHead,
        headSubject: 'feat(x): advance',
        stderr: fakeStderr,
      });
      strictEqual(result.archived, true, stderrChunks.join(''));
      const joined = stderrChunks.join('');
      ok(!/writeback|orchestrator/i.test(joined),
        `stop lifecycle must not mention writeback/orchestrator: ${joined}`);
    });
  });

  it('archives an engineer-shaped file carrying parent keys WITHOUT attempting writeback', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'engineer-shaped parent keys ride as unknowns',
        gitBaseline: { branch: 'main', head: baselineHead, status_digest: MIN_DIGEST },
        host: 'claude',
      });
      // Hand-inject engineer-shaped parent keys (forward-compat unknowns
      // for the designer reader) plus the terminal state.
      const raw = await readFile(filePath, 'utf8');
      const injected = raw.replace(
        '\ncurrent_phase:',
        '\nparent_workflow: "macro-plan-20260101T000000Z-aaaaaa"\noriginating_subtask: "PR9"\ncurrent_phase:',
      );
      await writeFile(filePath, injected);
      await setFrontmatter(filePath, (fm) => {
        fm.current_phase = 'summary-complete';
        fm.terminal_marker = true;
      });
      const advancedHead = makeAdvanceCommit(repoRoot);
      const stderrChunks = [];
      const fakeStderr = { write: (s) => stderrChunks.push(s) };
      const result = await runStopArchive({
        workflowPath: filePath,
        host: 'claude',
        repoRoot,
        headSha: advancedHead,
        headSubject: 'feat(x): advance',
        stderr: fakeStderr,
      });
      strictEqual(result.archived, true, stderrChunks.join(''));
      ok(!/writeback|orchestrator|subtask-update/i.test(stderrChunks.join('')),
        'parent keys on disk must not trigger any writeback attempt');
    });
  });
});

describe('Stop hook — idempotency: re-running on already-archived workflow no-ops', () => {
  it('second invocation finds no active workflow → exits 0 without error', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'idempotency',
        gitBaseline: {
          branch: 'main',
          head: baselineHead,
          status_digest: MIN_DIGEST,
        },
        host: 'claude',
      });
      await setFrontmatter(filePath, (fm) => {
        fm.current_phase = 'summary-complete';
        fm.terminal_marker = true;
      });
      makeAdvanceCommit(repoRoot);

      // First run — archives.
      const first = spawnStopHook({
        hostScript: CLAUDE_STOP_PATH,
        cwd: repoRoot,
      });
      strictEqual(first.code, 0);
      strictEqual((await listArchive(repoRoot)).length, 1);

      // Second run — no active workflow now; should no-op.
      const second = spawnStopHook({
        hostScript: CLAUDE_STOP_PATH,
        cwd: repoRoot,
      });
      strictEqual(second.code, 0, `stderr: ${second.stderr}`);
      strictEqual((await listArchive(repoRoot)).length, 1, 'archive count unchanged');
    });
  });
});

// -----------------------------------------------------------------------------
// designer state.mjs CLI surface around archiving (designer trim per
// ADR-0042 Non-Goal 2):
//
//   stop-archive     — RETAINED as a general remote-archive surface:
//                      wraps runStopArchive with explicit --head-sha /
//                      --head-subject / --status-digest so the A3
//                      head_moved gate is evaluated against an
//                      explicitly-supplied SHA. Emits a JSON envelope
//                      on stdout. No cross-plugin caller exists.
//   detach-archive   — INTENTIONALLY ABSENT: the engineer sibling ships
//                      it solely for orchestrator /finalize·/abort
//                      mid-flight detach, and orchestrator→designer
//                      dispatch is out of scope. The suite below
//                      asserts the subcommand stays unknown.

function runStateCli(args, { cwd } = {}) {
  const cp = spawnSync(
    process.execPath,
    [STATE_PATH, ...args],
    { cwd: cwd ?? process.cwd(), encoding: 'utf8' },
  );
  return { code: cp.status, stdout: cp.stdout, stderr: cp.stderr };
}

describe('designer CLI — no detach-archive subcommand (ADR-0042 Non-Goal 2)', () => {
  it('rejects detach-archive as an unknown subcommand', async () => {
    await withTmpGitRepo(async ({ repoRoot }) => {
      const result = spawnSync(process.execPath, [
        STATE_PATH, 'detach-archive',
        '--workflow-path', '/tmp/nonexistent.md',
        '--host', 'claude',
        '--repo-root', repoRoot,
      ], { encoding: 'utf8' });
      strictEqual(result.status, 2, `expected unknown-subcommand exit 2: ${result.stderr}`);
      match(result.stderr, /unknown subcommand: detach-archive/);
      ok(!/detached/.test(result.stdout),
        'no detach envelope may be emitted — the subcommand must not exist');
    });
  });
});

describe('ADR-0019 PR-E — state.mjs stop-archive CLI (terminal-child path)', () => {
  it('archives and emits {archived:true, to:<archive-path>} when all gates pass', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'stop-archive happy path',
        gitBaseline: {
          branch: 'main',
          head: baselineHead,
          status_digest: MIN_DIGEST,
        },
        host: 'claude',
      });
      await setFrontmatter(filePath, (fm) => {
        fm.current_phase = 'summary-complete';
        fm.terminal_marker = true;
      });
      // Probe a real advanced HEAD on the workflow's branch so A3 passes
      // with explicit --head-sha (mirrors orchestrator /finalize step 2's
      // `git rev-parse <child_baseline_branch>` flow).
      const advancedHead = makeAdvanceCommit(
        repoRoot,
        'feat(plugins/designer): terminal commit',
      );

      const { code, stdout, stderr } = runStateCli(
        [
          'stop-archive',
          '--workflow-path', filePath,
          '--host', 'claude',
          '--repo-root', repoRoot,
          '--head-sha', advancedHead,
          '--head-subject', 'feat(plugins/designer): terminal commit',
          '--status-digest', MIN_DIGEST,
        ],
        { cwd: repoRoot },
      );
      strictEqual(code, 0, `stderr: ${stderr}`);
      let envelope;
      try {
        envelope = JSON.parse(stdout.trim());
      } catch (err) {
        throw new Error(`stop-archive stdout not JSON: ${stdout.trim()} (${err.message})`);
      }
      strictEqual(envelope.archived, true);
      ok(typeof envelope.to === 'string' && envelope.to.includes(ARCHIVE_DIR_REL));
      strictEqual((await listWorkflows(repoRoot)).length, 0);
      strictEqual((await listArchive(repoRoot)).length, 1);
    });
  });

  it('emits {archived:false, reason:"gate-not-met", gateFailures:[head_moved]} when --head-sha equals baseline', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'stop-archive head_moved fail',
        gitBaseline: {
          branch: 'main',
          head: baselineHead,
          status_digest: MIN_DIGEST,
        },
        host: 'claude',
      });
      await setFrontmatter(filePath, (fm) => {
        fm.current_phase = 'summary-complete';
        fm.terminal_marker = true;
      });
      const { code, stdout, stderr } = runStateCli(
        [
          'stop-archive',
          '--workflow-path', filePath,
          '--host', 'claude',
          '--repo-root', repoRoot,
          // Pass baselineHead as --head-sha — A3 must fail.
          '--head-sha', baselineHead,
          '--head-subject', 'feat: no-op',
          '--status-digest', MIN_DIGEST,
        ],
        { cwd: repoRoot },
      );
      strictEqual(code, 0, `stderr: ${stderr}`);
      const envelope = JSON.parse(stdout.trim());
      strictEqual(envelope.archived, false);
      strictEqual(envelope.reason, 'gate-not-met');
      ok(Array.isArray(envelope.gateFailures));
      ok(
        envelope.gateFailures.includes('head_moved'),
        `expected gateFailures to include 'head_moved', got ${JSON.stringify(envelope.gateFailures)}`,
      );
      // File remains in workflows/
      strictEqual((await listWorkflows(repoRoot)).length, 1);
      strictEqual((await listArchive(repoRoot)).length, 0);
    });
  });

  it('emits {archived:false, gateFailures:[terminal_marker]} when terminal_marker is unset', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'stop-archive terminal_marker fail',
        gitBaseline: {
          branch: 'main',
          head: baselineHead,
          status_digest: MIN_DIGEST,
        },
        host: 'claude',
      });
      // Leave terminal_marker unset; head advanced — only A1 fails.
      const advancedHead = makeAdvanceCommit(repoRoot);

      const { code, stdout, stderr } = runStateCli(
        [
          'stop-archive',
          '--workflow-path', filePath,
          '--host', 'claude',
          '--repo-root', repoRoot,
          '--head-sha', advancedHead,
          '--head-subject', 'feat(plugins/designer): work',
          '--status-digest', MIN_DIGEST,
        ],
        { cwd: repoRoot },
      );
      strictEqual(code, 0, `stderr: ${stderr}`);
      const envelope = JSON.parse(stdout.trim());
      strictEqual(envelope.archived, false);
      ok(envelope.gateFailures.includes('terminal_marker'));
      strictEqual((await listWorkflows(repoRoot)).length, 1);
    });
  });

  it('accepts cross-branch invocation — --head-sha differs from current-process HEAD', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      // Workflow anchored to 'feat/child-branch' branch — different from
      // the test process's working-branch HEAD. Orchestrator probes the
      // child's branch HEAD via `git rev-parse refs/heads/<branch>` and
      // passes that explicitly. We simulate that here by passing a
      // synthetic --head-sha that is NOT the current HEAD.
      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'stop-archive cross-branch',
        gitBaseline: {
          branch: 'feat/child-branch',
          head: baselineHead,
          status_digest: MIN_DIGEST,
        },
        host: 'claude',
      });
      await setFrontmatter(filePath, (fm) => {
        fm.current_phase = 'summary-complete';
        fm.terminal_marker = true;
      });

      // Cross-branch: pass an explicit advanced sha that differs from the
      // workflow baselineHead (A3 passes via explicit arg, even though
      // makeAdvanceCommit is on the test's current branch).
      const crossBranchHead = 'f'.repeat(40);
      const { code, stdout, stderr } = runStateCli(
        [
          'stop-archive',
          '--workflow-path', filePath,
          '--host', 'claude',
          '--repo-root', repoRoot,
          '--head-sha', crossBranchHead,
          '--head-subject', 'feat(plugins/engineer): cross-branch',
          '--status-digest', MIN_DIGEST,
        ],
        { cwd: repoRoot },
      );
      strictEqual(code, 0, `stderr: ${stderr}`);
      const envelope = JSON.parse(stdout.trim());
      strictEqual(envelope.archived, true);
    });
  });
});

// -----------------------------------------------------------------------------
// ADR-0031 branch-deletion orphan sweep

describe('branchRefState — local branch ref classification', () => {
  it('present for an existing branch, absent for a missing one', async () => {
    await withTmpGitRepo(async ({ repoRoot }) => {
      strictEqual(branchRefState(repoRoot, 'main'), 'present');
      strictEqual(branchRefState(repoRoot, 'feat/never-existed'), 'absent');
    });
  });

  it('unknown (conservative) when the probe fails — non-repo dir or empty branch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'designer-not-a-repo-'));
    try {
      strictEqual(branchRefState(dir, 'main'), 'unknown');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    await withTmpGitRepo(async ({ repoRoot }) => {
      strictEqual(branchRefState(repoRoot, ''), 'unknown');
      // Invalid refnames must NOT classify as 'absent' (show-ref --verify
      // returns 1 for them too) — check-ref-format guards them to 'unknown'.
      strictEqual(branchRefState(repoRoot, 'bad..name'), 'unknown');
      strictEqual(branchRefState(repoRoot, 'has space'), 'unknown');
      strictEqual(branchRefState(repoRoot, 'trailing/'), 'unknown');
    });
  });
});

describe('runStopArchiveOrphanSweep — ADR-0031 branch-deletion orphan sweep', () => {
  async function makeTerminal(filePath) {
    await setFrontmatter(filePath, (fm) => {
      fm.current_phase = 'summary-complete';
      fm.terminal_marker = true;
    });
  }

  it('archives a terminal workflow whose baseline branch was deleted (orphan)', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      const { filePath } = await createWorkflow({
        repoRoot, verb: 'compose', originalRequest: 'orphan',
        gitBaseline: { branch: 'feat/gone', head: baselineHead, status_digest: MIN_DIGEST },
        host: 'claude',
      });
      await makeTerminal(filePath); // feat/gone has no git ref → branchRefState='absent'
      const results = await runStopArchiveOrphanSweep({ repoRoot, host: 'claude' });
      strictEqual(results.filter((r) => r.archived).length, 1);
      strictEqual((await listWorkflows(repoRoot)).length, 0);
      strictEqual((await listArchive(repoRoot)).length, 1);
    });
  });

  it('leaves a terminal workflow whose branch still exists (it archives normally on that branch)', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      execFileSync('git', ['branch', 'feat/live'], { cwd: repoRoot });
      const { filePath } = await createWorkflow({
        repoRoot, verb: 'compose', originalRequest: 'live',
        gitBaseline: { branch: 'feat/live', head: baselineHead, status_digest: MIN_DIGEST },
        host: 'claude',
      });
      await makeTerminal(filePath); // feat/live exists → branchRefState='present' → leave
      const results = await runStopArchiveOrphanSweep({ repoRoot, host: 'claude' });
      strictEqual(results.length, 0);
      strictEqual((await listWorkflows(repoRoot)).length, 1);
      strictEqual((await listArchive(repoRoot)).length, 0);
    });
  });

  it('leaves a NON-terminal workflow on a deleted branch (terminal_marker gate guards it)', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      await createWorkflow({
        repoRoot, verb: 'compose', originalRequest: 'nonterminal-orphan',
        gitBaseline: { branch: 'feat/gone', head: baselineHead, status_digest: MIN_DIGEST },
        host: 'claude',
      });
      // Left non-terminal (no set-terminal): even though feat/gone is absent,
      // an in-progress workflow must NOT be swept.
      const results = await runStopArchiveOrphanSweep({ repoRoot, host: 'claude' });
      strictEqual(results.length, 0);
      strictEqual((await listWorkflows(repoRoot)).length, 1);
    });
  });

  it('ignores files in a legacy-shaped home entirely (designer canonical-only sweep)', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      const { filePath } = await createWorkflow({
        repoRoot, verb: 'compose', originalRequest: 'legacy-orphan',
        gitBaseline: { branch: 'feat/gone', head: baselineHead, status_digest: MIN_DIGEST },
        host: 'claude',
      });
      await makeTerminal(filePath);
      // Relocate into a legacy-shaped home: the designer sweep walks the
      // canonical home only (ADR-0042 SD7), so this file must be invisible
      // — neither archived nor reported.
      const legacyDir = join(repoRoot, '.claude/agentic-designer/workflows');
      await mkdir(legacyDir, { recursive: true });
      await rename(filePath, join(legacyDir, basename(filePath)));
      const results = await runStopArchiveOrphanSweep({ repoRoot, host: 'claude' });
      strictEqual(results.length, 0, 'legacy-shaped homes are outside the designer sweep');
      const strayLeft = await readdir(legacyDir);
      strictEqual(strayLeft.filter((e) => e.endsWith('.md')).length, 1,
        'the stray file must be left untouched where it is');
    });
  });

  it('the Claude Stop hook runs the orphan sweep even when no workflow is active on the current branch', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      // Orphan on a gone branch; current branch (main) has NO active workflow,
      // so the pre-ADR-0031 hook would early-return without archiving it.
      const { filePath } = await createWorkflow({
        repoRoot, verb: 'compose', originalRequest: 'hook-orphan',
        gitBaseline: { branch: 'feat/gone', head: baselineHead, status_digest: MIN_DIGEST },
        host: 'claude',
      });
      await makeTerminal(filePath);
      const { code, stderr } = spawnStopHook({
        hostScript: CLAUDE_STOP_PATH,
        cwd: repoRoot,
        payload: JSON.stringify({ cwd: repoRoot }),
      });
      strictEqual(code, 0, `stderr: ${stderr}`);
      strictEqual((await listWorkflows(repoRoot)).length, 0);
      strictEqual((await listArchive(repoRoot)).length, 1);
    });
  });

  it('the Codex Stop hook also runs the orphan sweep', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      const { filePath } = await createWorkflow({
        repoRoot, verb: 'compose', originalRequest: 'codex-hook-orphan',
        gitBaseline: { branch: 'feat/gone', head: baselineHead, status_digest: MIN_DIGEST },
        host: 'codex',
      });
      await makeTerminal(filePath);
      const { code, stderr } = spawnStopHook({
        hostScript: CODEX_STOP_PATH,
        cwd: repoRoot,
        payload: JSON.stringify({ cwd: repoRoot }),
      });
      strictEqual(code, 0, `stderr: ${stderr}`);
      strictEqual((await listWorkflows(repoRoot)).length, 0);
      strictEqual((await listArchive(repoRoot)).length, 1);
    });
  });

  it('archives an orphan carrying engineer-shaped parent keys as a PLAIN orphan (no parent special-casing)', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      const { filePath } = await createWorkflow({
        repoRoot, verb: 'compose', originalRequest: 'parent-keyed orphan',
        gitBaseline: { branch: 'feat/gone', head: baselineHead, status_digest: MIN_DIGEST },
        host: 'claude',
      });
      await makeTerminal(filePath);
      // Raw-inject engineer-shaped parent keys (forward-compat unknowns
      // for the designer reader — the closed-schema serializer would
      // reject them via setFrontmatter, which is itself part of the
      // trimmed contract).
      const raw = await readFile(filePath, 'utf8');
      await writeFile(filePath, raw.replace(
        '\ncurrent_phase:',
        '\nparent_workflow: "macro-plan-20260101T000000Z-aaaaaa"\noriginating_subtask: "sub1"\ncurrent_phase:',
      ));
      const stderrChunks = [];
      const fakeStderr = { write: (s) => stderrChunks.push(s) };
      const results = await runStopArchiveOrphanSweep({ repoRoot, host: 'claude', stderr: fakeStderr });
      strictEqual(results.filter((r) => r.archived).length, 1);
      strictEqual((await listWorkflows(repoRoot)).length, 0);
      ok(!/parent-linked|writeback|orchestrator/i.test(stderrChunks.join('')),
        'designer sweep must not special-case parent keys (ADR-0042 Non-Goal 2)');
    });
  });

  it('leaves a terminal orphan whose stored branch name is MALFORMED (probe → unknown)', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      const { filePath } = await createWorkflow({
        repoRoot, verb: 'compose', originalRequest: 'malformed-branch',
        gitBaseline: { branch: 'main', head: baselineHead, status_digest: MIN_DIGEST },
        host: 'claude',
      });
      await setFrontmatter(filePath, (fm) => {
        fm.current_phase = 'summary-complete';
        fm.terminal_marker = true;
        fm.git_baseline = { ...fm.git_baseline, branch: 'bad..name' };
      });
      const results = await runStopArchiveOrphanSweep({ repoRoot, host: 'claude' });
      strictEqual(results.length, 0); // 'unknown' → conservative leave, never a false archive
      strictEqual((await listWorkflows(repoRoot)).length, 1);
    });
  });

  it('sweeps multiple orphans in a single pass', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      for (const b of ['feat/gone-1', 'feat/gone-2', 'feat/gone-3']) {
        const { filePath } = await createWorkflow({
          repoRoot, verb: 'compose', originalRequest: `orphan ${b}`,
          gitBaseline: { branch: b, head: baselineHead, status_digest: MIN_DIGEST },
          host: 'claude',
        });
        await makeTerminal(filePath);
      }
      const results = await runStopArchiveOrphanSweep({ repoRoot, host: 'claude' });
      strictEqual(results.filter((r) => r.archived).length, 3);
      strictEqual((await listWorkflows(repoRoot)).length, 0);
      strictEqual((await listArchive(repoRoot)).length, 3);
    });
  });
});
