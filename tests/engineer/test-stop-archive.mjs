// plugins/engineer/scripts/stop-archive.mjs +
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
// Run via `node --test tests/engineer/test-stop-archive.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, match } from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE_PATH = resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs');
const STOP_ARCHIVE_PATH = resolve(
  REPO_ROOT,
  'plugins/engineer/scripts/stop-archive.mjs',
);
const CLAUDE_STOP_PATH = resolve(
  REPO_ROOT,
  'plugins/engineer/adapters/claude/hooks/stop.mjs',
);
const CODEX_STOP_PATH = resolve(
  REPO_ROOT,
  'plugins/engineer/adapters/codex/hooks/stop.mjs',
);
const ORCHESTRATOR_ROOT = resolve(REPO_ROOT, 'plugins/orchestrator');
const ORCHESTRATOR_STATE = resolve(ORCHESTRATOR_ROOT, 'scripts/state.mjs');

const { createWorkflow, parseWorkflowFile, ARCHIVE_DIR_REL, WORKFLOW_DIR_REL } =
  await import(STATE_PATH);
const { evaluateStopArchive, runStopArchive } = await import(STOP_ARCHIVE_PATH);

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
      headSubject: 'feat(plugins/engineer): something',
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
      headSubject: 'fix(plugins/engineer): leak',
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
  const dir = await mkdtemp(join(tmpdir(), 'engineer-stop-archive-'));
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

function makeAdvanceCommit(repoRoot, subject = 'feat(plugins/engineer): work') {
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
      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'cross-branch stop',
        // Fixture is on 'main' (withTmpGitRepo init -b main); workflow
        // is anchored to 'other'. findActiveWorkflow returns null even
        // though all four other gates would pass.
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

// -----------------------------------------------------------------------------
// ADR-0019 PR-C — parent-writeback integration inside runStopArchive.
// These cases drive runStopArchive directly (rather than spawning the
// host stop.mjs entrypoint) so we can inject orchestratorRoot via env
// and inspect the parent file mutations in-process.

async function withOrchestratorEnv(value, fn) {
  const saved = process.env.AGENTIC_ORCHESTRATOR_ROOT;
  if (value === null || value === undefined) {
    delete process.env.AGENTIC_ORCHESTRATOR_ROOT;
  } else {
    process.env.AGENTIC_ORCHESTRATOR_ROOT = value;
  }
  try {
    return await fn();
  } finally {
    if (saved === undefined) {
      delete process.env.AGENTIC_ORCHESTRATOR_ROOT;
    } else {
      process.env.AGENTIC_ORCHESTRATOR_ROOT = saved;
    }
  }
}

async function bootstrapMacroPlan(repoRoot, subtaskId = 'T1') {
  // Create the orchestrator macro workflow + a single in_progress subtask.
  // Uses the real orchestrator state.mjs CLI so the on-disk shape matches
  // production semantics. The macro workflow lives under
  // <repoRoot>/.claude/agentic-orchestrator/workflows/<id>.md.
  const createOut = execFileSync(
    process.execPath,
    [
      ORCHESTRATOR_STATE,
      'create',
      '--repo-root', repoRoot,
      '--verb', 'plan',
      '--host', 'claude',
      '--git-baseline-branch', 'orch-macro',
      '--git-baseline-head', 'a'.repeat(40),
      '--status-digest', MIN_DIGEST,
      '--original-request', 'pr-c stop-archive integration macro',
    ],
    { encoding: 'utf8' },
  ).trim();
  const macroPath = createOut;
  const macroId = macroPath.split('/').pop().replace(/\.md$/, '');
  const subtasksFile = join(repoRoot, `subtasks-${subtaskId}.json`);
  await writeFile(
    subtasksFile,
    JSON.stringify([{
      id: subtaskId,
      verb: 'compose',
      branch: `feat/${subtaskId.toLowerCase()}`,
      blocked_by: [],
      status: 'in_progress',
    }]),
  );
  execFileSync(
    process.execPath,
    [
      ORCHESTRATOR_STATE,
      'plan-set',
      '--workflow-path', macroPath,
      '--host', 'claude',
      '--subtasks-json-file', subtasksFile,
    ],
    { encoding: 'utf8' },
  );
  return { macroPath, macroId };
}

describe('ADR-0019 PR-C — runStopArchive parent-writeback (parent in workflows/)', () => {
  it('marks the parent subtask completed after engineer archive succeeds', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      const { macroPath, macroId } = await bootstrapMacroPlan(repoRoot, 'T1');

      const { filePath: engineerPath, workflowId: engineerId } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'pr-c child workflow',
        gitBaseline: {
          branch: 'main',
          head: baselineHead,
          status_digest: MIN_DIGEST,
        },
        host: 'claude',
        parentWorkflow: macroId,
        originatingSubtask: 'T1',
      });
      await setFrontmatter(engineerPath, (fm) => {
        fm.current_phase = 'summary-complete';
        fm.terminal_marker = true;
      });
      const newHead = makeAdvanceCommit(repoRoot);

      const stderrBuf = [];
      const result = await withOrchestratorEnv(ORCHESTRATOR_ROOT, () =>
        runStopArchive({
          workflowPath: engineerPath,
          host: 'claude',
          repoRoot,
          headSha: newHead,
          headSubject: 'feat(plugins/engineer): pr-c child terminal commit',
          stderr: { write: (s) => stderrBuf.push(s) },
        }),
      );

      strictEqual(result.archived, true);
      // engineer file moved to archive/
      strictEqual((await listWorkflows(repoRoot)).length, 0);
      strictEqual((await listArchive(repoRoot)).length, 1);

      // Parent macro now has the subtask completed + auto-terminal.
      const macroText = await readFile(macroPath, 'utf8');
      match(macroText, /status: "completed"/);
      match(macroText, new RegExp(`commit: "${newHead}"`));
      match(macroText, new RegExp(`engineer_workflow_id: "${engineerId}"`));
      match(macroText, /terminal_marker: true/);
    });
  });
});

describe('ADR-0019 PR-C — parent_workflow unset → no writeback attempted', () => {
  it('archives normally without spawning the orchestrator CLI', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      const { filePath: engineerPath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'no parent linkage',
        gitBaseline: {
          branch: 'main',
          head: baselineHead,
          status_digest: MIN_DIGEST,
        },
        host: 'claude',
      });
      await setFrontmatter(engineerPath, (fm) => {
        fm.current_phase = 'summary-complete';
        fm.terminal_marker = true;
      });
      const newHead = makeAdvanceCommit(repoRoot);

      const stderrBuf = [];
      const result = await withOrchestratorEnv(ORCHESTRATOR_ROOT, () =>
        runStopArchive({
          workflowPath: engineerPath,
          host: 'claude',
          repoRoot,
          headSha: newHead,
          headSubject: 'feat(plugins/engineer): unparented terminal commit',
          stderr: { write: (s) => stderrBuf.push(s) },
        }),
      );

      strictEqual(result.archived, true);
      // No parent-writeback diagnostics emitted (writeback path skipped).
      const stderrStr = stderrBuf.join('');
      ok(!stderrStr.includes('engineer/parent-writeback'),
        `did not expect parent-writeback diagnostics, got: ${stderrStr}`);
    });
  });
});

describe('ADR-0019 PR-C — parent in archive/ → archive proceeds, writeback skipped with warning', () => {
  it('emits the archive-fallback warning and leaves the archived parent untouched', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      const { macroPath, macroId } = await bootstrapMacroPlan(repoRoot, 'T1');

      // Move the macro into the orchestrator's archive/ to simulate
      // /orchestrator:finalize having beat us to it.
      const orchArchiveDir = join(repoRoot, '.claude', 'agentic-orchestrator', 'archive');
      await mkdir(orchArchiveDir, { recursive: true });
      const archivedMacro = join(orchArchiveDir, `${macroId}.md`);
      const macroText = await readFile(macroPath, 'utf8');
      await writeFile(archivedMacro, macroText);
      await rm(macroPath);

      const { filePath: engineerPath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'parent already archived',
        gitBaseline: {
          branch: 'main',
          head: baselineHead,
          status_digest: MIN_DIGEST,
        },
        host: 'claude',
        parentWorkflow: macroId,
        originatingSubtask: 'T1',
      });
      await setFrontmatter(engineerPath, (fm) => {
        fm.current_phase = 'summary-complete';
        fm.terminal_marker = true;
      });
      const newHead = makeAdvanceCommit(repoRoot);

      const stderrBuf = [];
      const result = await withOrchestratorEnv(ORCHESTRATOR_ROOT, () =>
        runStopArchive({
          workflowPath: engineerPath,
          host: 'claude',
          repoRoot,
          headSha: newHead,
          headSubject: 'feat(plugins/engineer): post-finalize child',
          stderr: { write: (s) => stderrBuf.push(s) },
        }),
      );

      strictEqual(result.archived, true,
        'engineer archive should still succeed even when parent is frozen');
      const stderrStr = stderrBuf.join('');
      match(stderrStr, /parent_workflow.*archive/i);

      // Archived macro must remain untouched (frozen state).
      const archivedText = await readFile(archivedMacro, 'utf8');
      ok(!archivedText.includes('status: "completed"'),
        'archived macro must not be mutated');
    });
  });
});

describe('ADR-0019 PR-C — orchestrator root unresolved → archive proceeds, writeback skipped', () => {
  it('emits the orchestrator-not-found warning without rolling back the engineer archive', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      const { macroId } = await bootstrapMacroPlan(repoRoot, 'T1');

      const { filePath: engineerPath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'orchestrator not found',
        gitBaseline: {
          branch: 'main',
          head: baselineHead,
          status_digest: MIN_DIGEST,
        },
        host: 'claude',
        parentWorkflow: macroId,
        originatingSubtask: 'T1',
      });
      await setFrontmatter(engineerPath, (fm) => {
        fm.current_phase = 'summary-complete';
        fm.terminal_marker = true;
      });
      const newHead = makeAdvanceCommit(repoRoot);

      const stderrBuf = [];
      // Force discovery failure via AGENTIC_ORCHESTRATOR_ROOT pointing
      // at a garbage absolute path — the env override branch short-
      // circuits all other discovery (Claude cache / Codex cache /
      // sibling fallback are not attempted when env override is set),
      // so the discovery returns null regardless of the real engineer
      // plugin's location.
      const result = await withOrchestratorEnv('/nonexistent/orchestrator/install/path', () =>
        runStopArchive({
          workflowPath: engineerPath,
          host: 'claude',
          repoRoot,
          headSha: newHead,
          headSubject: 'feat(plugins/engineer): no orch root',
          stderr: { write: (s) => stderrBuf.push(s) },
        }),
      );
      strictEqual(result.archived, true);

      const stderrStr = stderrBuf.join('');
      match(stderrStr, /orchestrator.*not.*found/i);
      // engineer file still archived
      strictEqual((await listWorkflows(repoRoot)).length, 0);
      strictEqual((await listArchive(repoRoot)).length, 1);
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
// ADR-0019 PR-E — engineer CLI surface used by orchestrator /finalize + /abort
// step 2 (active-children detach pass). Two new state.mjs subcommands:
//
//   detach-archive   — mid-flight child: write parent_detached:true +
//                      terminal_marker:false, then archive. No parent
//                      writeback (the orchestrator already marked the
//                      subtask deferred/abandoned in step 1).
//   stop-archive     — terminal child: wrap runStopArchive with explicit
//                      --head-sha / --head-subject / --status-digest so
//                      the gate A3 head_moved is evaluated against the
//                      child's own branch HEAD (not the orchestrator's
//                      current branch). Emits a JSON envelope on stdout.
//
// Both CLIs are invoked from orchestrator /finalize / /abort runbooks via
// `execFile(node, [stateMjsPath, 'detach-archive'|'stop-archive', ...])`.
// The JSON envelope on stdout is the contract orchestrator parses.

function runStateCli(args, { cwd } = {}) {
  const cp = spawnSync(
    process.execPath,
    [STATE_PATH, ...args],
    { cwd: cwd ?? process.cwd(), encoding: 'utf8' },
  );
  return { code: cp.status, stdout: cp.stdout, stderr: cp.stderr };
}

describe('ADR-0019 PR-E — state.mjs detach-archive CLI (mid-flight child path)', () => {
  it('writes parent_detached:true + terminal_marker:false then archives + emits JSON envelope', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      const { filePath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'detach-archive happy path',
        gitBaseline: {
          branch: 'feat/child-mid-flight',
          head: baselineHead,
          status_digest: MIN_DIGEST,
        },
        host: 'claude',
      });
      // No terminal_marker, no terminal phase — this is mid-flight.

      const { code, stdout, stderr } = runStateCli(
        [
          'detach-archive',
          '--workflow-path', filePath,
          '--host', 'claude',
          '--repo-root', repoRoot,
        ],
        { cwd: repoRoot },
      );
      strictEqual(code, 0, `stderr: ${stderr}`);

      // JSON envelope on stdout: {detached:true, to:<archive-path>}
      let envelope;
      try {
        envelope = JSON.parse(stdout.trim());
      } catch (err) {
        throw new Error(`detach-archive stdout is not JSON: ${stdout.trim()} (${err.message})`);
      }
      strictEqual(envelope.detached, true);
      ok(
        typeof envelope.to === 'string' && envelope.to.includes(ARCHIVE_DIR_REL),
        `expected envelope.to under ${ARCHIVE_DIR_REL}, got ${envelope.to}`,
      );

      // File is now in archive/ with mutated frontmatter.
      strictEqual((await listWorkflows(repoRoot)).length, 0, 'workflow file should be archived');
      const archived = await listArchive(repoRoot);
      strictEqual(archived.length, 1, 'archive should contain one entry');
      const archivedPath = join(repoRoot, ARCHIVE_DIR_REL, archived[0]);
      const archivedText = await readFile(archivedPath, 'utf8');
      const { frontmatter } = parseWorkflowFile(archivedText);
      strictEqual(
        frontmatter.parent_detached,
        true,
        'parent_detached must be true after detach-archive',
      );
      strictEqual(
        frontmatter.terminal_marker,
        false,
        'terminal_marker must be explicitly false (not absent)',
      );
    });
  });

  it('does NOT fire parent writeback even when parent_workflow is set', async () => {
    await withTmpGitRepo(async ({ repoRoot, baselineHead }) => {
      // Bootstrap a macro parent + mid-flight engineer child with parent linkage.
      const { macroPath, macroId } = await bootstrapMacroPlan(repoRoot, 'T1');
      const { filePath: engineerPath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'detach-archive: parent writeback must NOT fire',
        gitBaseline: {
          branch: 'feat/t1',
          head: baselineHead,
          status_digest: MIN_DIGEST,
        },
        host: 'claude',
        parentWorkflow: macroId,
        originatingSubtask: 'T1',
      });
      // Pre-snapshot the macro text — engineer's parseWorkflowFile rejects
      // orchestrator's schema (different frontmatter key set), so we
      // compare raw bytes / regex shape the same way PR-C parent-writeback
      // tests do (see line 698 precedent).
      const beforeText = await readFile(macroPath, 'utf8');

      await withOrchestratorEnv(ORCHESTRATOR_ROOT, async () => {
        const { code } = runStateCli(
          [
            'detach-archive',
            '--workflow-path', engineerPath,
            '--host', 'claude',
            '--repo-root', repoRoot,
          ],
          { cwd: repoRoot },
        );
        strictEqual(code, 0);
      });

      // Macro must be byte-identical — detach-archive does NOT fire any
      // parent writeback (no `subtask-update` CLI spawn). The only writes
      // were to the engineer child file + its archive destination, both
      // outside the orchestrator workflow file.
      const afterText = await readFile(macroPath, 'utf8');
      strictEqual(
        afterText,
        beforeText,
        'detach-archive must NOT mutate the orchestrator macro file (no parent writeback)',
      );
    });
  });

  it('returns non-zero exit when workflow-path does not exist', async () => {
    await withTmpGitRepo(async ({ repoRoot }) => {
      const ghost = join(repoRoot, '.claude/agentic-engineer/workflows/no-such.md');
      const { code, stderr } = runStateCli(
        [
          'detach-archive',
          '--workflow-path', ghost,
          '--host', 'claude',
          '--repo-root', repoRoot,
        ],
        { cwd: repoRoot },
      );
      ok(code !== 0, 'detach-archive on missing file must exit non-zero');
      ok(
        stderr.length > 0,
        'stderr must surface a diagnostic when workflow file is absent',
      );
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
        'feat(plugins/engineer): subtask commit',
      );

      const { code, stdout, stderr } = runStateCli(
        [
          'stop-archive',
          '--workflow-path', filePath,
          '--host', 'claude',
          '--repo-root', repoRoot,
          '--head-sha', advancedHead,
          '--head-subject', 'feat(plugins/engineer): subtask commit',
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
          '--head-subject', 'feat(plugins/engineer): work',
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
