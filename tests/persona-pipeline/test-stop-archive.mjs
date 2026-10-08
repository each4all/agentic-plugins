// plugins/<persona>/scripts/stop-archive.mjs +
// adapters/{claude,codex}/hooks/stop.mjs integration tests
// (ADR-0017 §sub-decision 5), run once for every persona the persona
// pipeline generates stop-archive.mjs into (ADR-0066 Decision 5).
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
// Each persona's generated copy is imported from its own plugin
// (plugins/<persona>/scripts/...), so every case exercises the file that
// persona ships.
//
// A case about one capability (ADR-0066 Decision 3) registers only for the
// personas whose declaration sets it that way: the parent writeback, the
// detach-archive CLI and the parent-linked sweep cases with dispatch_target
// on, their absence with it off; the legacy-home sweep with legacy_homes on,
// its absence with it off. The dispatch_target-on cases drive the
// repository's orchestrator plugin (plugins/orchestrator) as the parent.
//
// Run via `node --test tests/persona-pipeline/test-stop-archive.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, match, deepStrictEqual } from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT, personasFor, personaInfo } from './_personas.mjs';

const PERSONAS = personasFor('scripts/stop-archive.mjs');

// Import every persona's generated copies before any suite is declared, so
// the suites below are registered synchronously.
const MODULES = new Map();
for (const persona of PERSONAS) {
  const P = personaInfo(persona);
  MODULES.set(persona, {
    state: await import(pathToFileURL(P.path('scripts/state.mjs')).href),
    stopArchive: await import(pathToFileURL(P.path('scripts/stop-archive.mjs')).href),
  });
}

const MIN_DIGEST =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// -----------------------------------------------------------------------------
// Persona-independent helpers

async function withTmpGitRepo(prefix, fn) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
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

async function listMarkdown(dir) {
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith('.md'));
  } catch {
    return [];
  }
}

// The parent of a dispatch_target workflow: the repository's orchestrator
// plugin, reached through the AGENTIC_ORCHESTRATOR_ROOT override that
// parent-writeback.mjs honours before any other discovery.
const ORCHESTRATOR_ROOT = join(REPO_ROOT, 'plugins', 'orchestrator');
const ORCHESTRATOR_STATE = join(ORCHESTRATOR_ROOT, 'scripts', 'state.mjs');

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
  // production semantics. The macro lands in the orchestrator's own workflow
  // home; `create` prints its path.
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

for (const persona of PERSONAS) {
  const P = personaInfo(persona);
  // A capability's cases register only for a persona that declares it the way
  // the case needs (ADR-0066 Decision 3): the Off helpers for a persona that
  // declares it off, the On helpers for one that declares it on.
  const describeDispatchOff = P.capabilities.dispatch_target ? () => {} : describe;
  const itDispatchOff = P.capabilities.dispatch_target ? () => {} : it;
  const itLegacyOff = P.capabilities.legacy_homes ? () => {} : it;
  const describeDispatchOn = P.capabilities.dispatch_target ? describe : () => {};
  const itDispatchOn = P.capabilities.dispatch_target ? it : () => {};
  const itLegacyOn = P.capabilities.legacy_homes ? it : () => {};
  const STATE_PATH = P.path('scripts/state.mjs');
  const CLAUDE_STOP_PATH = P.path('adapters/claude/hooks/stop.mjs');
  const CODEX_STOP_PATH = P.path('adapters/codex/hooks/stop.mjs');
  const CODEX_PRE_COMPACT_PATH = P.path('adapters/codex/hooks/pre-compact.mjs');

  const {
    createWorkflow,
    parseWorkflowFile,
    assembleWorkflowFile,
    branchRefState,
    archiveDirRel,
    workflowDirRel,
  } = MODULES.get(persona).state;
  const { evaluateStopArchive, runStopArchive, runStopArchiveOrphanSweep } =
    MODULES.get(persona).stopArchive;

  // ---------------------------------------------------------------------------
  // Pure unit tests for evaluateStopArchive

  describe(`${persona}: evaluateStopArchive — pure unit cases (ADR-0017 §sub-5 gates)`, () => {
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
        headSubject: `feat(plugins/${persona}): something`,
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
        headSubject: `fix(plugins/${persona}): leak`,
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

  // ---------------------------------------------------------------------------
  // Integration tests: spawn stop.mjs against a tmp git repo

  const withRepo = (fn) => withTmpGitRepo(`${persona}-stop-archive-`, fn);

  async function setFrontmatter(workflowPath, mutator) {
    const text = await readFile(workflowPath, 'utf8');
    const { frontmatter, body } = parseWorkflowFile(text);
    mutator(frontmatter);
    // Re-serialize via state.mjs's CLI? No — we can write the YAML
    // ourselves trivially since these are scalar / list overrides on
    // already-valid frontmatter. We round-trip through the persona's
    // assembleWorkflowFile helper.
    await writeFile(workflowPath, assembleWorkflowFile(frontmatter, body));
  }

  const listWorkflows = (repoRoot) => listMarkdown(join(repoRoot, workflowDirRel()));
  const listArchive = (repoRoot) => listMarkdown(join(repoRoot, archiveDirRel()));

  function makeAdvanceCommit(repoRoot, subject = `feat(plugins/${persona}): work`) {
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

  describe(`${persona}: Codex pre-compact hook — snapshot parity`, () => {
    it('writes last_snapshot trigger=pre-compact with host="codex"', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
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

  describe(`${persona}: Claude stop hook — case (a) all gates pass → archive`, () => {
    it('moves the workflow into archive/ and exits 0', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
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

  describe(`${persona}: Claude stop hook — case (g) cross-branch workflow → no archive (ADR-0018 §sub-2)`, () => {
    it('leaves a workflow on another branch whose own tip has not moved, although HEAD has', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
        // 'other' is a REAL branch here. Fixture is on 'main', so
        // findActiveWorkflow returns null for the 'other' workflow and
        // runStopArchive leaves it. The sweep judges it against 'other''s own
        // tip, which is still the baseline: the commit below moves HEAD on
        // 'main' only, and HEAD must never stand in for another branch. A kept
        // branch that did move is archived (covered with the sweep tests).
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

  describe(`${persona}: Claude stop hook — case (b) terminal_marker unset → no archive`, () => {
    it('leaves the workflow in workflows/ and exits 0', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
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

  describe(`${persona}: Claude stop hook — case (c) HEAD has not moved → no archive`, () => {
    it('leaves the workflow in workflows/ when HEAD == baseline', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
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

  describe(`${persona}: Claude stop hook — case (d) active children present → no archive`, () => {
    it('leaves the workflow when child_completions has incomplete entry', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
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

  describe(`${persona}: Claude stop hook — case (e) phase outside whitelist → no archive`, () => {
    it('leaves the workflow in workflows/ when phase is phase-2-presented', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
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

  describe(`${persona}: Claude stop hook — case (f) non-conventional subject → warning + archive`, () => {
    it('emits a stderr warning but still archives when other gates pass', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
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

  describe(`${persona}: Claude stop hook — no active workflow → no-op`, () => {
    it('exits 0 cleanly when no workflow file exists', async () => {
      await withRepo(async ({ repoRoot }) => {
        const { code, stderr } = spawnStopHook({
          hostScript: CLAUDE_STOP_PATH,
          cwd: repoRoot,
        });
        strictEqual(code, 0, `stderr: ${stderr}`);
        strictEqual((await listArchive(repoRoot)).length, 0);
      });
    });
  });

  describe(`${persona}: Codex stop hook — parity: case (a) all gates pass → archive`, () => {
    it('archives via Codex script with host="codex" recorded', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
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
          join(repoRoot, archiveDirRel(), archived[0]),
          'utf8',
        );
        const { frontmatter } = parseWorkflowFile(archivedText);
        const last = frontmatter.host_history.at(-1);
        strictEqual(last.event, 'archived');
        strictEqual(last.host, 'codex');
      });
    });
  });

  // ==========================================================================
  // The parent step — ADR-0066 Decision 3. A persona with dispatch_target on
  // notes the archived workflow's terminal commit on its orchestrator parent
  // at this point in the stop lifecycle (ADR-0019 §4, as changed by ADR-0062;
  // the cases after these). A persona with dispatch_target off must archive
  // cleanly with ZERO cross-plugin side effects, even when an engineer-shaped
  // file carries parent keys (forward-compat unknowns).
  // ==========================================================================

  describeDispatchOff(`${persona}: stop-archive — no parent writeback ever (dispatch_target off, ADR-0066 Decision 3)`, () => {
    it('archives normally; no orchestrator CLI is spawned (no parent linkage exists)', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
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
      await withRepo(async ({ repoRoot, baselineHead }) => {
        const { filePath } = await createWorkflow({
          repoRoot,
          verb: 'compose',
          originalRequest: 'engineer-shaped parent keys ride as unknowns',
          gitBaseline: { branch: 'main', head: baselineHead, status_digest: MIN_DIGEST },
          host: 'claude',
        });
        // Hand-inject engineer-shaped parent keys (forward-compat unknowns
        // for this persona's reader) plus the terminal state.
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

  // dispatch_target on — ADR-0019 PR-C, as changed by ADR-0062. These cases
  // drive runStopArchive directly (rather than spawning the host stop.mjs
  // entrypoint) so the orchestrator root is injected via env and the parent
  // file is inspected in-process. The note heading (`### engineer terminal:`)
  // and the subtask's `engineer_workflow_id` are the orchestrator's own format.

  describeDispatchOn(`${persona}: ADR-0019 PR-C / ADR-0062 — runStopArchive parent writeback (parent in workflows/, dispatch_target on)`, () => {
    async function terminalChild(repoRoot, baselineHead, macroId, extra = () => {}) {
      const { filePath, workflowId } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'pr-c child workflow',
        gitBaseline: { branch: 'main', head: baselineHead, status_digest: MIN_DIGEST },
        host: 'claude',
        parentWorkflow: macroId,
        originatingSubtask: 'T1',
      });
      await setFrontmatter(filePath, (fm) => {
        fm.current_phase = 'summary-complete';
        fm.terminal_marker = true;
        extra(fm);
      });
      return { childPath: filePath, childId: workflowId };
    }

    const stop = (childPath, repoRoot, headSha, stderrBuf) => withOrchestratorEnv(ORCHESTRATOR_ROOT, () =>
      runStopArchive({
        workflowPath: childPath,
        host: 'claude',
        repoRoot,
        headSha,
        headSubject: `feat(plugins/${persona}): pr-c child terminal commit`,
        stderr: { write: (s) => stderrBuf.push(s) },
      }));

    // ADR-0062 §Decision 2: the child's terminal commit is a branch commit
    // that a squash or rebase merge never lands, so the Stop hook notes it and
    // leaves the subtask open for /orchestrator:done.
    it('notes the terminal commit on the parent without completing the subtask', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
        const { macroPath, macroId } = await bootstrapMacroPlan(repoRoot, 'T1');
        const { childPath, childId } = await terminalChild(repoRoot, baselineHead, macroId);
        const newHead = makeAdvanceCommit(repoRoot);
        const stderrBuf = [];
        const result = await stop(childPath, repoRoot, newHead, stderrBuf);

        strictEqual(result.archived, true);
        strictEqual((await listWorkflows(repoRoot)).length, 0);
        strictEqual((await listArchive(repoRoot)).length, 1);

        const macroText = await readFile(macroPath, 'utf8');
        match(macroText, /status: "in_progress"/);
        ok(!/^\s*commit: /m.test(macroText), 'no commit is recorded on the subtask');
        ok(!/terminal_marker: true/.test(macroText), 'the macro is not promoted to terminal');
        match(macroText, new RegExp(`engineer_workflow_id: "${childId}"`));
        ok(macroText.includes(`### engineer terminal: "T1" @ ${childId} ${newHead}`), macroText);
      });
    });

    it('with the P10 marker set and the note already written, writes nothing more', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
        const { macroPath, macroId } = await bootstrapMacroPlan(repoRoot, 'T1');
        const { childPath, childId } = await terminalChild(repoRoot, baselineHead, macroId,
          (fm) => { fm.parent_writeback_at = '2026-09-27T10:00:00Z'; });
        const newHead = makeAdvanceCommit(repoRoot);
        // What P10 wrote before this Stop.
        execFileSync(process.execPath, [
          ORCHESTRATOR_STATE, 'subtask-engineer-terminal', `--workflow-path=${macroPath}`,
          '--host=claude', '--subtask-id=T1', `--engineer-workflow-id=${childId}`, `--branch-commit=${newHead}`,
        ], { encoding: 'utf8' });
        const before = await readFile(macroPath, 'utf8');
        const result = await stop(childPath, repoRoot, newHead, []);
        strictEqual(result.archived, true);
        strictEqual(await readFile(macroPath, 'utf8'), before);
      });
    });

    // ADR-0066 PC3 — the canonical stop-archive re-checks the gates on the bytes
    // archiveWorkflow reads under the file lock. An owner gate written after the
    // first read refuses the archive, and a refused archive notes nothing on the
    // parent: the note follows a successful archive only.
    it('an owner gate written between the read and the lock: no archive, and no note on the parent', async () => {
      const { setAwaitingOwner, archiveWorkflow } = MODULES.get(persona).state;
      await withRepo(async ({ repoRoot, baselineHead }) => {
        const { macroPath, macroId } = await bootstrapMacroPlan(repoRoot, 'T1');
        const { childPath } = await terminalChild(repoRoot, baselineHead, macroId);
        const newHead = makeAdvanceCommit(repoRoot);
        const before = await readFile(macroPath, 'utf8');
        const result = await withOrchestratorEnv(ORCHESTRATOR_ROOT, () => runStopArchive({
          workflowPath: childPath,
          host: 'claude',
          repoRoot,
          headSha: newHead,
          headSubject: `feat(plugins/${persona}): pr-c child terminal commit`,
          stderr: { write: () => true },
          archive: async (args) => {
            await setAwaitingOwner({ workflowPath: childPath, host: 'claude', gate: 'scope-routing', anchor: 'routing-recommendation' });
            return archiveWorkflow(args);
          },
        }));
        strictEqual(result.archived, false);
        ok(result.gateFailures.includes('awaiting_owner'), JSON.stringify(result.gateFailures));
        strictEqual((await listWorkflows(repoRoot)).length, 1);
        strictEqual(await readFile(macroPath, 'utf8'), before, 'the parent is untouched');
      });
    });

    // ADR-0067 Decision 3 — the Stop passes the child's recorded
    // parent_workflow_path, the only thing that reaches a macro kept in
    // another checkout. The orphan sweep's kept-branch path calls the same
    // noteTerminalOnParent.
    // Contract: noteTerminalOnParent hands writebackParent the recorded path —
    // without it a lane's Stop searches only its own checkout and notes nothing.
    it('notes the terminal commit through the recorded parent_workflow_path when its own checkout holds no copy of the macro', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
        const elsewhere = await mkdtemp(join(tmpdir(), `${persona}-stop-macro-home-`));
        try {
          const { macroPath, macroId } = await bootstrapMacroPlan(elsewhere, 'T1');
          const { filePath: childPath, workflowId: childId } = await createWorkflow({
            repoRoot,
            verb: 'compose',
            originalRequest: 'child of a macro in another checkout',
            gitBaseline: { branch: 'main', head: baselineHead, status_digest: MIN_DIGEST },
            host: 'claude',
            parentWorkflow: macroId,
            originatingSubtask: 'T1',
            parentWorkflowPath: macroPath,
          });
          await setFrontmatter(childPath, (fm) => {
            fm.current_phase = 'summary-complete';
            fm.terminal_marker = true;
          });
          const newHead = makeAdvanceCommit(repoRoot);
          const stderrBuf = [];
          const result = await stop(childPath, repoRoot, newHead, stderrBuf);
          strictEqual(result.archived, true, stderrBuf.join(''));
          ok((await readFile(macroPath, 'utf8')).includes(`### engineer terminal: "T1" @ ${childId} ${newHead}`), stderrBuf.join(''));
        } finally {
          await rm(elsewhere, { recursive: true, force: true });
        }
      });
    });

    it('with the P10 marker set but no note (a crash between the two), still writes the note', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
        const { macroPath, macroId } = await bootstrapMacroPlan(repoRoot, 'T1');
        const { childPath, childId } = await terminalChild(repoRoot, baselineHead, macroId,
          (fm) => { fm.parent_writeback_at = '2026-09-27T10:00:00Z'; });
        const newHead = makeAdvanceCommit(repoRoot);
        const result = await stop(childPath, repoRoot, newHead, []);
        strictEqual(result.archived, true);
        ok((await readFile(macroPath, 'utf8')).includes(`### engineer terminal: "T1" @ ${childId} ${newHead}`));
      });
    });
  });

  describeDispatchOn(`${persona}: ADR-0019 PR-C — parent_workflow unset → no writeback attempted (dispatch_target on)`, () => {
    it('archives normally without spawning the orchestrator CLI', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
        const { filePath: childPath } = await createWorkflow({
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
        await setFrontmatter(childPath, (fm) => {
          fm.current_phase = 'summary-complete';
          fm.terminal_marker = true;
        });
        const newHead = makeAdvanceCommit(repoRoot);

        const stderrBuf = [];
        const result = await withOrchestratorEnv(ORCHESTRATOR_ROOT, () =>
          runStopArchive({
            workflowPath: childPath,
            host: 'claude',
            repoRoot,
            headSha: newHead,
            headSubject: `feat(plugins/${persona}): unparented terminal commit`,
            stderr: { write: (s) => stderrBuf.push(s) },
          }),
        );

        strictEqual(result.archived, true);
        // No writeback diagnostics emitted (writeback path skipped): neither
        // parent-writeback.mjs's own nor stop-archive's report of a writeback
        // that threw, which an attempt without a parent id ends in.
        const stderrStr = stderrBuf.join('');
        ok(!/writeback|orchestrator/i.test(stderrStr),
          `did not expect parent-writeback diagnostics, got: ${stderrStr}`);
      });
    });
  });

  describeDispatchOn(`${persona}: ADR-0019 PR-C — parent in archive/ → archive proceeds, writeback skipped with warning (dispatch_target on)`, () => {
    it('emits the archive-fallback warning and leaves the archived parent untouched', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
        const { macroPath, macroId } = await bootstrapMacroPlan(repoRoot, 'T1');

        // Move the macro into the orchestrator's archive/ to simulate
        // /orchestrator:finalize having beat us to it.
        const orchArchiveDir = join(repoRoot, '.claude', 'agentic-orchestrator', 'archive');
        await mkdir(orchArchiveDir, { recursive: true });
        const archivedMacro = join(orchArchiveDir, `${macroId}.md`);
        const macroText = await readFile(macroPath, 'utf8');
        await writeFile(archivedMacro, macroText);
        await rm(macroPath);

        const { filePath: childPath } = await createWorkflow({
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
        await setFrontmatter(childPath, (fm) => {
          fm.current_phase = 'summary-complete';
          fm.terminal_marker = true;
        });
        const newHead = makeAdvanceCommit(repoRoot);

        const stderrBuf = [];
        const result = await withOrchestratorEnv(ORCHESTRATOR_ROOT, () =>
          runStopArchive({
            workflowPath: childPath,
            host: 'claude',
            repoRoot,
            headSha: newHead,
            headSubject: `feat(plugins/${persona}): post-finalize child`,
            stderr: { write: (s) => stderrBuf.push(s) },
          }),
        );

        strictEqual(result.archived, true,
          `the ${persona} archive should still succeed even when parent is frozen`);
        const stderrStr = stderrBuf.join('');
        // The archive fallback itself, not the dangling-linkage warning (which
        // also names parent_workflow and the archive homes).
        ok(stderrStr.includes(`${persona}/parent-writeback: parent_workflow=${macroId} is in archive/`), stderrStr);
        ok(!/dangling/i.test(stderrStr), stderrStr);

        // Archived macro must remain untouched (frozen state).
        const archivedText = await readFile(archivedMacro, 'utf8');
        ok(!archivedText.includes('status: "completed"'),
          'archived macro must not be mutated');
      });
    });
  });

  describeDispatchOn(`${persona}: ADR-0019 PR-C — orchestrator root unresolved → archive proceeds, writeback skipped (dispatch_target on)`, () => {
    it(`emits the orchestrator-not-found warning without rolling back the ${persona} archive`, async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
        const { macroId } = await bootstrapMacroPlan(repoRoot, 'T1');

        const { filePath: childPath } = await createWorkflow({
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
        await setFrontmatter(childPath, (fm) => {
          fm.current_phase = 'summary-complete';
          fm.terminal_marker = true;
        });
        const newHead = makeAdvanceCommit(repoRoot);

        const stderrBuf = [];
        // Force discovery failure via AGENTIC_ORCHESTRATOR_ROOT pointing
        // at a garbage absolute path — the env override branch short-
        // circuits all other discovery (Claude cache / Codex cache /
        // sibling fallback are not attempted when env override is set),
        // so the discovery returns null regardless of where the persona
        // plugin itself is.
        const result = await withOrchestratorEnv('/nonexistent/orchestrator/install/path', () =>
          runStopArchive({
            workflowPath: childPath,
            host: 'claude',
            repoRoot,
            headSha: newHead,
            headSubject: `feat(plugins/${persona}): no orch root`,
            stderr: { write: (s) => stderrBuf.push(s) },
          }),
        );
        strictEqual(result.archived, true);

        const stderrStr = stderrBuf.join('');
        match(stderrStr, /orchestrator.*not.*found/i);
        // the persona's workflow is still archived
        strictEqual((await listWorkflows(repoRoot)).length, 0);
        strictEqual((await listArchive(repoRoot)).length, 1);
      });
    });
  });

  describe(`${persona}: Stop hook — idempotency: re-running on already-archived workflow no-ops`, () => {
    it('second invocation finds no active workflow → exits 0 without error', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
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

  // ---------------------------------------------------------------------------
  // The persona's state.mjs CLI surface around archiving (ADR-0019 PR-E,
  // ADR-0066 Decision 3):
  //
  //   stop-archive     — every persona: wraps runStopArchive with explicit
  //                      --head-sha / --head-subject / --status-digest so
  //                      the A3 head_moved gate is evaluated against an
  //                      explicitly-supplied SHA (with dispatch_target on,
  //                      the terminal child's own branch HEAD, which
  //                      orchestrator /finalize·/abort probe; off, no
  //                      cross-plugin caller exists). Emits a JSON envelope
  //                      on stdout.
  //   detach-archive   — dispatch_target on only: the orchestrator
  //                      /finalize·/abort mid-flight detach writes
  //                      parent_detached:true + terminal_marker:false, then
  //                      archives, with no parent writeback (the
  //                      orchestrator already marked the subtask in its
  //                      step 1). Off, orchestrator dispatch to the persona
  //                      is out of scope and the subcommand stays unknown.
  //
  // orchestrator invokes both through `execFile(node, [stateMjsPath, ...])`;
  // the JSON envelope on stdout is the contract it parses.

  function runStateCli(args, { cwd } = {}) {
    const cp = spawnSync(
      process.execPath,
      [STATE_PATH, ...args],
      { cwd: cwd ?? process.cwd(), encoding: 'utf8' },
    );
    return { code: cp.status, stdout: cp.stdout, stderr: cp.stderr };
  }

  describeDispatchOff(`${persona}: CLI — no detach-archive subcommand (dispatch_target off, ADR-0066 Decision 3)`, () => {
    it('rejects detach-archive as an unknown subcommand', async () => {
      await withRepo(async ({ repoRoot }) => {
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

  describeDispatchOn(`${persona}: ADR-0019 PR-E — state.mjs detach-archive CLI (mid-flight child path, dispatch_target on)`, () => {
    it('writes parent_detached:true + terminal_marker:false then archives + emits JSON envelope', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
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
          typeof envelope.to === 'string' && envelope.to.includes(archiveDirRel()),
          `expected envelope.to under ${archiveDirRel()}, got ${envelope.to}`,
        );

        // File is now in archive/ with mutated frontmatter.
        strictEqual((await listWorkflows(repoRoot)).length, 0, 'workflow file should be archived');
        const archived = await listArchive(repoRoot);
        strictEqual(archived.length, 1, 'archive should contain one entry');
        const archivedPath = join(repoRoot, archiveDirRel(), archived[0]);
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
      await withRepo(async ({ repoRoot, baselineHead }) => {
        // Bootstrap a macro parent + mid-flight child with parent linkage.
        const { macroPath, macroId } = await bootstrapMacroPlan(repoRoot, 'T1');
        const { filePath: childPath } = await createWorkflow({
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
        // Pre-snapshot the macro text — the persona's parseWorkflowFile
        // rejects orchestrator's schema (different frontmatter key set), so we
        // compare raw bytes the same way the parent-writeback cases above do.
        const beforeText = await readFile(macroPath, 'utf8');

        await withOrchestratorEnv(ORCHESTRATOR_ROOT, async () => {
          const { code } = runStateCli(
            [
              'detach-archive',
              '--workflow-path', childPath,
              '--host', 'claude',
              '--repo-root', repoRoot,
            ],
            { cwd: repoRoot },
          );
          strictEqual(code, 0);
        });

        // Macro must be byte-identical — detach-archive does NOT fire any
        // parent writeback (no orchestrator CLI spawn). The only writes were
        // to the child file + its archive destination, both outside the
        // orchestrator workflow file.
        const afterText = await readFile(macroPath, 'utf8');
        strictEqual(
          afterText,
          beforeText,
          'detach-archive must NOT mutate the orchestrator macro file (no parent writeback)',
        );
      });
    });

    it('returns non-zero exit when workflow-path does not exist', async () => {
      await withRepo(async ({ repoRoot }) => {
        const ghost = join(repoRoot, P.workflowDirRel, 'no-such.md');
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

  describe(`${persona}: ADR-0019 PR-E — state.mjs stop-archive CLI (terminal-child path)`, () => {
    it('archives and emits {archived:true, to:<archive-path>} when all gates pass', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
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
          `feat(plugins/${persona}): terminal commit`,
        );

        const { code, stdout, stderr } = runStateCli(
          [
            'stop-archive',
            '--workflow-path', filePath,
            '--host', 'claude',
            '--repo-root', repoRoot,
            '--head-sha', advancedHead,
            '--head-subject', `feat(plugins/${persona}): terminal commit`,
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
        ok(typeof envelope.to === 'string' && envelope.to.includes(archiveDirRel()));
        strictEqual((await listWorkflows(repoRoot)).length, 0);
        strictEqual((await listArchive(repoRoot)).length, 1);
      });
    });

    it('emits {archived:false, reason:"gate-not-met", gateFailures:[head_moved]} when --head-sha equals baseline', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
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
      await withRepo(async ({ repoRoot, baselineHead }) => {
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
            '--head-subject', `feat(plugins/${persona}): work`,
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
      await withRepo(async ({ repoRoot, baselineHead }) => {
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
            '--head-subject', `feat(plugins/${persona}): cross-branch`,
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

  // ---------------------------------------------------------------------------
  // ADR-0031 branch-deletion orphan sweep

  describe(`${persona}: branchRefState — local branch ref classification`, () => {
    it('present for an existing branch, absent for a missing one', async () => {
      await withRepo(async ({ repoRoot }) => {
        strictEqual(branchRefState(repoRoot, 'main'), 'present');
        strictEqual(branchRefState(repoRoot, 'feat/never-existed'), 'absent');
      });
    });

    it('unknown (conservative) when the probe fails — non-repo dir or empty branch', async () => {
      const dir = await mkdtemp(join(tmpdir(), `${persona}-not-a-repo-`));
      try {
        strictEqual(branchRefState(dir, 'main'), 'unknown');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      await withRepo(async ({ repoRoot }) => {
        strictEqual(branchRefState(repoRoot, ''), 'unknown');
        // Invalid refnames must NOT classify as 'absent' (show-ref --verify
        // returns 1 for them too) — check-ref-format guards them to 'unknown'.
        strictEqual(branchRefState(repoRoot, 'bad..name'), 'unknown');
        strictEqual(branchRefState(repoRoot, 'has space'), 'unknown');
        strictEqual(branchRefState(repoRoot, 'trailing/'), 'unknown');
      });
    });
  });

  describe(`${persona}: runStopArchiveOrphanSweep — workflows whose branch is not checked out (deleted: ADR-0031; kept: C3)`, () => {
    async function makeTerminal(filePath) {
      await setFrontmatter(filePath, (fm) => {
        fm.current_phase = 'summary-complete';
        fm.terminal_marker = true;
      });
    }

    it('archives a terminal workflow whose baseline branch was deleted (orphan)', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
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

    // C3: a terminal workflow on a branch that still exists but is not checked
    // out is judged against that branch's own tip, as if the Stop had fired
    // there. HEAD belongs to another branch and must never stand in for it.
    for (const [host, hostScript] of [['claude', CLAUDE_STOP_PATH], ['codex', CODEX_STOP_PATH]]) {
      it(`the ${host} Stop hook archives a terminal workflow on a kept branch that is not checked out once that branch has moved`, async () => {
        await withRepo(async ({ repoRoot, baselineHead }) => {
          execFileSync('git', ['switch', '-q', '-c', 'feat/kept'], { cwd: repoRoot });
          makeAdvanceCommit(repoRoot);
          execFileSync('git', ['switch', '-q', '-c', 'feat/next'], { cwd: repoRoot });
          const { filePath } = await createWorkflow({
            repoRoot, verb: 'compose', originalRequest: 'kept branch',
            gitBaseline: { branch: 'feat/kept', head: baselineHead, status_digest: MIN_DIGEST },
            host,
          });
          await makeTerminal(filePath);
          const { code, stderr } = spawnStopHook({
            hostScript, cwd: repoRoot, payload: JSON.stringify({ cwd: repoRoot }),
          });
          strictEqual(code, 0, `stderr: ${stderr}`);
          strictEqual((await listWorkflows(repoRoot)).length, 0, stderr);
          strictEqual((await listArchive(repoRoot)).length, 1);
        });
      });
    }

    // dispatch_target on: the parent note the sweep writes carries the kept
    // branch's own tip, never the checked-out HEAD.
    itDispatchOn('archives a terminal workflow on a kept branch that is not checked out, noting that branch tip (not HEAD) on the parent', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
        const { macroPath, macroId } = await bootstrapMacroPlan(repoRoot, 'T1');
        execFileSync('git', ['switch', '-q', '-c', 'feat/t1'], { cwd: repoRoot });
        const tip = makeAdvanceCommit(repoRoot, `feat(plugins/${persona}): t1 work`);
        execFileSync('git', ['switch', '-q', 'main'], { cwd: repoRoot });
        const head = makeAdvanceCommit(repoRoot, `feat(plugins/${persona}): unrelated main work`);
        ok(head !== tip);
        const { filePath, workflowId } = await createWorkflow({
          repoRoot, verb: 'compose', originalRequest: 'kept off-branch child',
          gitBaseline: { branch: 'feat/t1', head: baselineHead, status_digest: MIN_DIGEST },
          host: 'claude', parentWorkflow: macroId, originatingSubtask: 'T1',
        });
        await setFrontmatter(filePath, (fm) => {
          fm.current_phase = 'commit-complete';
          fm.terminal_marker = true;
        });
        const results = await withOrchestratorEnv(ORCHESTRATOR_ROOT, () =>
          runStopArchiveOrphanSweep({ repoRoot, host: 'claude', stderr: { write() {} } }));
        strictEqual(results.filter((r) => r.archived).length, 1);
        strictEqual((await listWorkflows(repoRoot)).length, 0);
        strictEqual((await listArchive(repoRoot)).length, 1);
        const macroText = await readFile(macroPath, 'utf8');
        ok(macroText.includes(`### engineer terminal: "T1" @ ${workflowId} ${tip}`), macroText);
        ok(!macroText.includes(head), 'the checked-out HEAD is never written to the parent');
      });
    });

    it('leaves a terminal workflow on a kept branch whose tip has not moved, and writes nothing to it', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
        execFileSync('git', ['branch', 'feat/live'], { cwd: repoRoot });
        makeAdvanceCommit(repoRoot); // HEAD moved on main; feat/live did not
        const { filePath } = await createWorkflow({
          repoRoot, verb: 'compose', originalRequest: 'live, no commit',
          gitBaseline: { branch: 'feat/live', head: baselineHead, status_digest: MIN_DIGEST },
          host: 'claude',
        });
        await makeTerminal(filePath);
        const before = await readFile(filePath, 'utf8');
        for (let i = 0; i < 2; i += 1) {
          const results = await runStopArchiveOrphanSweep({ repoRoot, host: 'claude' });
          strictEqual(results.length, 0);
        }
        // No snapshot or host_history entry per Stop: a workflow that can never
        // pass must not grow with every Stop on another branch.
        strictEqual(await readFile(filePath, 'utf8'), before);
      });
    });

    it('leaves the checked-out branch\'s workflow to the per-branch Stop path', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
        const { filePath } = await createWorkflow({
          repoRoot, verb: 'compose', originalRequest: 'current branch',
          gitBaseline: { branch: 'main', head: baselineHead, status_digest: MIN_DIGEST },
          host: 'claude',
        });
        await makeTerminal(filePath);
        makeAdvanceCommit(repoRoot);
        const results = await runStopArchiveOrphanSweep({ repoRoot, host: 'claude' });
        strictEqual(results.length, 0);
        strictEqual((await listWorkflows(repoRoot)).length, 1);
      });
    });

    it('leaves every kept branch when git cannot say which branch is checked out', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
        // The checked-out branch's workflow belongs to the per-branch path; with
        // the checkout unknown, any kept branch could be that one.
        const { filePath } = await createWorkflow({
          repoRoot, verb: 'compose', originalRequest: 'checkout unknown',
          gitBaseline: { branch: 'main', head: baselineHead, status_digest: MIN_DIGEST },
          host: 'claude',
        });
        await makeTerminal(filePath);
        makeAdvanceCommit(repoRoot);
        const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
        const bin = await mkdtemp(join(tmpdir(), 'fake-git-'));
        await writeFile(join(bin, 'git'),
          `#!/bin/sh\nif [ "$1" = "symbolic-ref" ]; then exit 128; fi\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
        const savedPath = process.env.PATH;
        process.env.PATH = `${bin}:${savedPath}`;
        try {
          const results = await runStopArchiveOrphanSweep({ repoRoot, host: 'claude' });
          strictEqual(results.length, 0);
        } finally {
          process.env.PATH = savedPath;
          await rm(bin, { recursive: true, force: true });
        }
        strictEqual((await listWorkflows(repoRoot)).length, 1);
      });
    });

    it('judges kept branches against their own tips on a detached HEAD', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
        execFileSync('git', ['switch', '-q', '-c', 'feat/kept'], { cwd: repoRoot });
        makeAdvanceCommit(repoRoot);
        execFileSync('git', ['switch', '-q', '--detach', baselineHead], { cwd: repoRoot });
        const { filePath } = await createWorkflow({
          repoRoot, verb: 'compose', originalRequest: 'detached checkout',
          gitBaseline: { branch: 'feat/kept', head: baselineHead, status_digest: MIN_DIGEST },
          host: 'claude',
        });
        await makeTerminal(filePath);
        const results = await runStopArchiveOrphanSweep({ repoRoot, host: 'claude' });
        strictEqual(results.filter((r) => r.archived).length, 1);
        strictEqual((await listWorkflows(repoRoot)).length, 0);
      });
    });

    it('leaves a kept branch reset below its baseline, and writes nothing to it', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
        // The tip differs from the baseline but went backwards: nothing on the
        // branch is evidence of the workflow's work.
        execFileSync('git', ['switch', '-q', '-c', 'feat/rewound'], { cwd: repoRoot });
        const workflowBaseline = makeAdvanceCommit(repoRoot);
        execFileSync('git', ['reset', '-q', '--hard', baselineHead], { cwd: repoRoot });
        execFileSync('git', ['switch', '-q', 'main'], { cwd: repoRoot });
        const { filePath } = await createWorkflow({
          repoRoot, verb: 'compose', originalRequest: 'rewound branch',
          gitBaseline: { branch: 'feat/rewound', head: workflowBaseline, status_digest: MIN_DIGEST },
          host: 'claude',
        });
        await makeTerminal(filePath);
        const before = await readFile(filePath, 'utf8');
        const results = await runStopArchiveOrphanSweep({ repoRoot, host: 'claude' });
        strictEqual(results.length, 0);
        strictEqual(await readFile(filePath, 'utf8'), before);
      });
    });

    it('leaves a moved kept branch whose workflow still has an unfinished child, and writes nothing to it', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
        execFileSync('git', ['switch', '-q', '-c', 'feat/kept'], { cwd: repoRoot });
        makeAdvanceCommit(repoRoot);
        execFileSync('git', ['switch', '-q', 'main'], { cwd: repoRoot });
        const { filePath } = await createWorkflow({
          repoRoot, verb: 'compose', originalRequest: 'unfinished child',
          gitBaseline: { branch: 'feat/kept', head: baselineHead, status_digest: MIN_DIGEST },
          host: 'claude',
        });
        await setFrontmatter(filePath, (fm) => {
          fm.current_phase = 'summary-complete';
          fm.terminal_marker = true;
          fm.child_completions = [{ child_id: 'wf-unfinished-child', spawned_at: '2026-09-28T00:00:00Z', commit: 'abc1234', closed_at: '' }];
        });
        const before = await readFile(filePath, 'utf8');
        const results = await runStopArchiveOrphanSweep({ repoRoot, host: 'claude' });
        strictEqual(results.length, 0);
        strictEqual(await readFile(filePath, 'utf8'), before);
      });
    });

    it('leaves a terminal workflow whose kept branch does not resolve to a commit', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
        // A ref that exists (show-ref succeeds) but names a blob: the tip cannot
        // be read, so the branch is neither judged nor treated as deleted.
        const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
          cwd: repoRoot, input: 'not a commit\n', encoding: 'utf8',
        }).trim();
        await mkdir(join(repoRoot, '.git/refs/heads/feat'), { recursive: true });
        await writeFile(join(repoRoot, '.git/refs/heads/feat/blob'), `${blob}\n`);
        strictEqual(branchRefState(repoRoot, 'feat/blob'), 'present');
        const { filePath } = await createWorkflow({
          repoRoot, verb: 'compose', originalRequest: 'unresolvable tip',
          gitBaseline: { branch: 'feat/blob', head: baselineHead, status_digest: MIN_DIGEST },
          host: 'claude',
        });
        await makeTerminal(filePath);
        const results = await runStopArchiveOrphanSweep({ repoRoot, host: 'claude' });
        strictEqual(results.length, 0);
        strictEqual((await listWorkflows(repoRoot)).length, 1);
      });
    });

    // The C3 sequence (dispatch_target on): commit and set-terminal on the
    // subtask branch, merge, /orchestrator:done, then /orchestrator:next
    // switches branches, all before the turn's Stop. That Stop runs on the
    // successor branch. The orchestrator's A4 child scan reads the engineer
    // homes, engineer being the persona with dispatch_target on.
    for (const [host, hostScript] of [['claude', CLAUDE_STOP_PATH], ['codex', CODEX_STOP_PATH]]) {
      itDispatchOn(`the ${host} Stop hook on the successor branch archives a completed subtask's child left on its kept branch`, async () => {
        await withRepo(async ({ repoRoot, baselineHead }) => {
          const { macroPath, macroId } = await bootstrapMacroPlan(repoRoot, 'T1');
          execFileSync('git', ['switch', '-q', '-c', 'feat/t1'], { cwd: repoRoot });
          makeAdvanceCommit(repoRoot, `feat(plugins/${persona}): t1 work`);
          const { filePath, workflowId } = await createWorkflow({
            repoRoot, verb: 'compose', originalRequest: 'c3 child',
            gitBaseline: { branch: 'feat/t1', head: baselineHead, status_digest: MIN_DIGEST },
            host, parentWorkflow: macroId, originatingSubtask: 'T1',
          });
          await setFrontmatter(filePath, (fm) => {
            fm.current_phase = 'commit-complete';
            fm.terminal_marker = true;
          });
          execFileSync('git', ['switch', '-q', 'main'], { cwd: repoRoot });
          const landed = makeAdvanceCommit(repoRoot, `feat(plugins/${persona}): t1 work (#1)`);
          execFileSync(process.execPath, [
            ORCHESTRATOR_STATE, 'subtask-update', `--workflow-path=${macroPath}`, `--host=${host}`,
            '--subtask-id=T1', '--status=completed', `--engineer-workflow-id=${workflowId}`,
            `--commit=${landed}`, '--closed-at=2026-09-28T00:00:00Z', '--event=updated',
          ], { encoding: 'utf8' });
          execFileSync('git', ['switch', '-q', '-c', 'feat/t2'], { cwd: repoRoot });
          const { noActiveEngineerChildrenScan } = await import(pathToFileURL(ORCHESTRATOR_STATE).href);
          strictEqual(await noActiveEngineerChildrenScan(repoRoot, macroId), 1);

          const { code, stderr } = await withOrchestratorEnv(ORCHESTRATOR_ROOT, () => spawnStopHook({
            hostScript, cwd: repoRoot, payload: JSON.stringify({ cwd: repoRoot }),
          }));
          strictEqual(code, 0, `stderr: ${stderr}`);
          strictEqual((await listWorkflows(repoRoot)).length, 0, stderr);
          strictEqual(await noActiveEngineerChildrenScan(repoRoot, macroId), 0);
          const macroText = await readFile(macroPath, 'utf8');
          match(macroText, new RegExp(`commit: "${landed}"`));
          ok(!macroText.includes('### engineer terminal:'), 'a completed subtask takes no terminal note');
        });
      });
    }

    it('leaves a NON-terminal workflow on a deleted branch (terminal_marker gate guards it)', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
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

    itLegacyOn('archives a LEGACY-home orphan into the legacy archive (both-homes sweep)', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
        const { filePath } = await createWorkflow({
          repoRoot, verb: 'compose', originalRequest: 'legacy-orphan',
          gitBaseline: { branch: 'feat/gone', head: baselineHead, status_digest: MIN_DIGEST },
          host: 'claude',
        });
        await makeTerminal(filePath);
        // Relocate the workflow into the persona's LEGACY home (ADR-0025) so the
        // sweep must reach it via listWorkflowFilesAllHomes, and archiveWorkflow
        // must route it back into the LEGACY archive
        // (inferStorageFromWorkflowPath).
        const legacyDir = join(repoRoot, `.claude/agentic-${persona}/workflows`);
        await mkdir(legacyDir, { recursive: true });
        await rename(filePath, join(legacyDir, basename(filePath)));
        const results = await runStopArchiveOrphanSweep({ repoRoot, host: 'claude' });
        strictEqual(results.filter((r) => r.archived).length, 1);
        const legacyArchive = await readdir(join(repoRoot, `.claude/agentic-${persona}/archive`)).catch(() => []);
        strictEqual(legacyArchive.filter((e) => e.endsWith('.md')).length, 1);
        strictEqual((await listArchive(repoRoot)).length, 0, 'nothing lands in the canonical archive');
      });
    });

    itLegacyOff('ignores files in a legacy-shaped home entirely (canonical-only sweep, legacy_homes off)', async () => {
      // Registered only for a persona that declares legacy_homes off
      // (ADR-0066 Decision 3); the on counterpart is the case above.
      strictEqual(P.capabilities.legacy_homes, false);
      await withRepo(async ({ repoRoot, baselineHead }) => {
        const { filePath } = await createWorkflow({
          repoRoot, verb: 'compose', originalRequest: 'legacy-orphan',
          gitBaseline: { branch: 'feat/gone', head: baselineHead, status_digest: MIN_DIGEST },
          host: 'claude',
        });
        await makeTerminal(filePath);
        // Relocate into a legacy-shaped home: the sweep walks the persona's
        // canonical home only (legacy_homes off, ADR-0066 Decision 3), so this
        // file must be invisible — neither archived nor reported.
        const legacyDir = join(repoRoot, `.claude/agentic-${persona}/workflows`);
        await mkdir(legacyDir, { recursive: true });
        await rename(filePath, join(legacyDir, basename(filePath)));
        const results = await runStopArchiveOrphanSweep({ repoRoot, host: 'claude' });
        strictEqual(results.length, 0, `legacy-shaped homes are outside the ${persona} sweep`);
        const strayLeft = await readdir(legacyDir);
        strictEqual(strayLeft.filter((e) => e.endsWith('.md')).length, 1,
          'the stray file must be left untouched where it is');
      });
    });

    it('the Claude Stop hook runs the orphan sweep even when no workflow is active on the current branch', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
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
      await withRepo(async ({ repoRoot, baselineHead }) => {
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

    itDispatchOff('archives an orphan carrying engineer-shaped parent keys as a PLAIN orphan (no parent special-casing)', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
        const { filePath } = await createWorkflow({
          repoRoot, verb: 'compose', originalRequest: 'parent-keyed orphan',
          gitBaseline: { branch: 'feat/gone', head: baselineHead, status_digest: MIN_DIGEST },
          host: 'claude',
        });
        await makeTerminal(filePath);
        // Raw-inject engineer-shaped parent keys (forward-compat unknowns
        // for this persona's reader — the closed-schema serializer would
        // reject them via setFrontmatter, which is itself part of the
        // dispatch_target-off contract).
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
          `${persona} sweep must not special-case parent keys (dispatch_target off, ADR-0066 Decision 3)`);
      });
    });

    // dispatch_target on: archiving the orphan is the cleanup the macro's A4
    // gate waits for, and the sweep says so, since the parent note cannot be
    // replayed for a deleted branch (A3 still guards the macro).
    itDispatchOn('archives a PARENT-LINKED orphan (A4 cleanup; A3 still guards the macro)', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
        const { filePath } = await createWorkflow({
          repoRoot, verb: 'compose', originalRequest: 'parent-linked orphan',
          gitBaseline: { branch: 'feat/gone', head: baselineHead, status_digest: MIN_DIGEST },
          host: 'claude',
        });
        await setFrontmatter(filePath, (fm) => {
          fm.current_phase = 'summary-complete';
          fm.terminal_marker = true;
          fm.parent_workflow = 'macro-plan-20260101T000000Z-aaaaaa';
          fm.originating_subtask = 'sub1';
        });
        const stderrChunks = [];
        const results = await runStopArchiveOrphanSweep({ repoRoot, host: 'claude', stderr: { write: (s) => stderrChunks.push(s) } });
        strictEqual(results.filter((r) => r.archived).length, 1);
        strictEqual((await listWorkflows(repoRoot)).length, 0);
        const said = stderrChunks.join('');
        ok(said.includes('archiving parent-linked orphan')
          && said.includes('parent=macro-plan-20260101T000000Z-aaaaaa, subtask=sub1')
          && said.includes('/orchestrator:done'),
        `the sweep names the parent and the reconciliation step: ${said}`);
      });
    });

    it('leaves a terminal orphan whose stored branch name is MALFORMED (probe → unknown)', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
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
      await withRepo(async ({ repoRoot, baselineHead }) => {
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

  // ---------------------------------------------------------------------------
  // Gate 5 (ADR-0063 D6, ADR-0066 PC2b): a workflow waiting on its owner is not
  // archived on any path, whatever its terminal marker says. Each case ends
  // with its control: the same workflow with the gate removed archives.

  describe(`${persona}: gate 5 — a pending owner gate refuses the archive (ADR-0063 D6, PC2b)`, () => {
    const GATE = {
      awaiting_owner_gate: 'decide-conflict',
      awaiting_owner_since: '2026-10-06T00:00:00Z',
      awaiting_owner_pointer: `.agentic-plugins/state/${persona}/workflows/decide-x.md#ensemble-synthesis`,
    };
    const ungate = (fm) => {
      for (const k of Object.keys(GATE)) delete fm[k];
    };

    it('the evaluator reports awaiting_owner alone when every other gate passes', () => {
      const frontmatter = {
        current_phase: 'summary-complete',
        terminal_marker: true,
        git_baseline: { branch: 'main', head: 'a'.repeat(40), status_digest: '' },
        child_completions: [],
      };
      const pass = evaluateStopArchive({ frontmatter, headSha: 'b'.repeat(40), headSubject: 'feat: x' });
      deepStrictEqual([pass.shouldArchive, pass.gateFailures], [true, []]);
      const gated = evaluateStopArchive({ frontmatter: { ...frontmatter, ...GATE }, headSha: 'b'.repeat(40), headSubject: 'feat: x' });
      deepStrictEqual([gated.shouldArchive, gated.gateFailures], [false, ['awaiting_owner']]);
    });

    for (const [host, hostScript] of [['claude', CLAUDE_STOP_PATH], ['codex', CODEX_STOP_PATH]]) {
      it(`the ${host} Stop hook leaves a gated workflow whose marker was forced on and whose HEAD moved; without the gate it archives`, async () => {
        await withRepo(async ({ repoRoot, baselineHead }) => {
          const { filePath } = await createWorkflow({
            repoRoot, verb: 'decide', originalRequest: 'gated on stop',
            gitBaseline: { branch: 'main', head: baselineHead, status_digest: MIN_DIGEST },
            host,
          });
          await setFrontmatter(filePath, (fm) => {
            fm.current_phase = 'summary-complete';
            fm.terminal_marker = true;
            Object.assign(fm, GATE);
          });
          makeAdvanceCommit(repoRoot);
          const payload = JSON.stringify({ cwd: repoRoot });
          const first = spawnStopHook({ hostScript, cwd: repoRoot, payload });
          strictEqual(first.code, 0, `stderr: ${first.stderr}`);
          strictEqual((await listWorkflows(repoRoot)).length, 1, 'the gated workflow stays live');
          strictEqual((await listArchive(repoRoot)).length, 0);
          const { frontmatter } = parseWorkflowFile(await readFile(filePath, 'utf8'));
          strictEqual(frontmatter.awaiting_owner_gate, GATE.awaiting_owner_gate, 'the gate is still set');

          await setFrontmatter(filePath, ungate);
          const second = spawnStopHook({ hostScript, cwd: repoRoot, payload });
          strictEqual(second.code, 0, `stderr: ${second.stderr}`);
          strictEqual((await listWorkflows(repoRoot)).length, 0, 'without the gate it archives');
          strictEqual((await listArchive(repoRoot)).length, 1);
        });
      });
    }

    it('the sweep leaves a gated workflow whose branch was deleted; without the gate it archives', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
        const { filePath } = await createWorkflow({
          repoRoot, verb: 'decide', originalRequest: 'gated orphan',
          gitBaseline: { branch: 'feat/gone', head: baselineHead, status_digest: MIN_DIGEST },
          host: 'claude',
        });
        await setFrontmatter(filePath, (fm) => {
          fm.current_phase = 'summary-complete';
          fm.terminal_marker = true;
          Object.assign(fm, GATE);
        });
        const before = await readFile(filePath, 'utf8');
        strictEqual((await runStopArchiveOrphanSweep({ repoRoot, host: 'claude' })).length, 0);
        strictEqual(await readFile(filePath, 'utf8'), before, 'nothing written to it');

        await setFrontmatter(filePath, ungate);
        strictEqual((await runStopArchiveOrphanSweep({ repoRoot, host: 'claude' })).filter((r) => r.archived).length, 1);
        strictEqual((await listWorkflows(repoRoot)).length, 0);
      });
    });

    it('the sweep leaves a gated workflow on a kept branch that has moved; without the gate it archives', async () => {
      await withRepo(async ({ repoRoot, baselineHead }) => {
        execFileSync('git', ['switch', '-q', '-c', 'feat/kept'], { cwd: repoRoot });
        makeAdvanceCommit(repoRoot);
        execFileSync('git', ['switch', '-q', '-c', 'feat/next'], { cwd: repoRoot });
        const { filePath } = await createWorkflow({
          repoRoot, verb: 'decide', originalRequest: 'gated kept branch',
          gitBaseline: { branch: 'feat/kept', head: baselineHead, status_digest: MIN_DIGEST },
          host: 'claude',
        });
        await setFrontmatter(filePath, (fm) => {
          fm.current_phase = 'summary-complete';
          fm.terminal_marker = true;
          Object.assign(fm, GATE);
        });
        const before = await readFile(filePath, 'utf8');
        strictEqual((await runStopArchiveOrphanSweep({ repoRoot, host: 'claude' })).length, 0);
        strictEqual(await readFile(filePath, 'utf8'), before, 'nothing written to it');

        await setFrontmatter(filePath, ungate);
        strictEqual((await runStopArchiveOrphanSweep({ repoRoot, host: 'claude' })).filter((r) => r.archived).length, 1);
        strictEqual((await listWorkflows(repoRoot)).length, 0);
      });
    });

    // Review of code step 6 (finding 1): each path decides on
    // its own read, then archiveWorkflow reads again under the file lock. An
    // owner gate written in between, here by a wrapper around archiveWorkflow
    // that runs the real setter first, keeps the workflow live; an unrelated
    // write in the same place (a snapshot) does not.
    const { archiveWorkflow, setAwaitingOwner, snapshot } = MODULES.get(persona).state;
    const between = (filePath, write) => async (args) => {
      await write(filePath);
      return archiveWorkflow(args);
    };
    const gateIt = (filePath) => setAwaitingOwner({ workflowPath: filePath, host: 'claude', gate: 'recurring-finding', anchor: 'recurring-finding' });
    const snapshotIt = (filePath) => snapshot({ workflowPath: filePath, host: 'claude', trigger: 'stop', statusDigest: MIN_DIGEST });
    const refusedUnderLock = async (result, { repoRoot, filePath }, label) => {
      strictEqual(result.archived, false, `${label}: not archived`);
      strictEqual(result.reason, 'gate-not-met-under-lock', `${label}: refused on the locked read`);
      ok(result.gateFailures.includes('awaiting_owner'), `${label}: ${result.gateFailures}`);
      strictEqual((await listArchive(repoRoot)).length, 0, `${label}: nothing archived`);
      const { frontmatter } = parseWorkflowFile(await readFile(filePath, 'utf8'));
      strictEqual(frontmatter.awaiting_owner_gate, 'recurring-finding', `${label}: live, with the gate`);
    };
    const terminal = (fm) => {
      fm.current_phase = 'summary-complete';
      fm.terminal_marker = true;
    };

    it('the Stop path: an owner gate written between the gates\' read and the archive keeps the workflow; a snapshot written there does not', async () => {
      for (const [write, archived] of [[gateIt, false], [snapshotIt, true]]) {
        await withRepo(async ({ repoRoot, baselineHead }) => {
          const { filePath } = await createWorkflow({
            repoRoot, verb: 'refine', originalRequest: 'gated between reads',
            gitBaseline: { branch: 'main', head: baselineHead, status_digest: MIN_DIGEST },
            host: 'claude',
          });
          await setFrontmatter(filePath, terminal);
          const headSha = makeAdvanceCommit(repoRoot);
          const result = await runStopArchive({ workflowPath: filePath, host: 'claude', repoRoot, headSha, headSubject: 'feat: x', stderr: { write() {} }, archive: between(filePath, write) });
          if (archived) {
            strictEqual(result.archived, true, `control: ${JSON.stringify(result)}`);
            strictEqual((await listWorkflows(repoRoot)).length, 0);
          } else {
            await refusedUnderLock(result, { repoRoot, filePath }, 'Stop');
            strictEqual((await listWorkflows(repoRoot)).length, 1);
          }
        });
      }
    });

    // Re-review: the recheck runs on the read archiveWorkflow makes under the
    // file lock. The test holds that lock, lets archiveWorkflow take the
    // directory lock and wait, writes the gate, then releases it.
    it('archiveWorkflow re-checks on the read it makes under the file lock: a gate written while it waits for the lock keeps the workflow', async () => {
      const { withFileLock, creationLockRel } = MODULES.get(persona).state;
      await withRepo(async ({ repoRoot, baselineHead }) => {
        const { filePath } = await createWorkflow({
          repoRoot, verb: 'refine', originalRequest: 'gated under the lock',
          gitBaseline: { branch: 'feat/gone', head: baselineHead, status_digest: MIN_DIGEST },
          host: 'claude',
        });
        await setFrontmatter(filePath, terminal);
        const dirLock = join(repoRoot, creationLockRel());
        let pending;
        await withFileLock(filePath, async () => {
          const gates = (fm) => (fm.awaiting_owner_gate !== undefined ? ['awaiting_owner'] : []);
          pending = archiveWorkflow({ workflowPath: filePath, host: 'claude', repoRoot, recheck: gates });
          const deadline = Date.now() + 4000;
          while (!existsSync(dirLock)) {
            if (Date.now() > deadline) throw new Error('archiveWorkflow never took the directory lock');
            await new Promise((r) => setTimeout(r, 10));
          }
          // Written raw: this test holds the lock a setter would take.
          await setFrontmatter(filePath, (fm) => Object.assign(fm, GATE));
        });
        const result = await pending;
        deepStrictEqual([result.archived, result.reason, result.gateFailures], [false, 'gate-not-met-under-lock', ['awaiting_owner']]);
        strictEqual((await listWorkflows(repoRoot)).length, 1);
      });
    });

    for (const kept of [false, true]) {
      it(`the sweep, ${kept ? 'kept branch' : 'deleted branch'}: an owner gate written between the sweep's read and the archive keeps the workflow; a snapshot written there does not`, async () => {
        for (const [write, archived] of [[gateIt, false], [snapshotIt, true]]) {
          await withRepo(async ({ repoRoot, baselineHead }) => {
            const branch = kept ? 'feat/kept' : 'feat/gone';
            if (kept) {
              execFileSync('git', ['switch', '-q', '-c', branch], { cwd: repoRoot });
              makeAdvanceCommit(repoRoot);
              execFileSync('git', ['switch', '-q', '-c', 'feat/next'], { cwd: repoRoot });
            }
            const { filePath } = await createWorkflow({
              repoRoot, verb: 'refine', originalRequest: 'gated between reads',
              gitBaseline: { branch, head: baselineHead, status_digest: MIN_DIGEST },
              host: 'claude',
            });
            await setFrontmatter(filePath, terminal);
            const results = await runStopArchiveOrphanSweep({ repoRoot, host: 'claude', stderr: { write() {} }, archive: between(filePath, write) });
            strictEqual(results.length, 1, `the sweep acted on it: ${JSON.stringify(results)}`);
            if (archived) {
              strictEqual(results[0].archived, true, `control: ${JSON.stringify(results[0])}`);
              strictEqual((await listWorkflows(repoRoot)).length, 0);
            } else {
              await refusedUnderLock(results[0], { repoRoot, filePath }, kept ? 'kept branch' : 'deleted branch');
              strictEqual((await listWorkflows(repoRoot)).length, 1);
            }
          });
        }
      });
    }
  });
}
