// plugins/engineer/commands/resume.md unit tests (ADR-0017 §sub-decision-1).
//
// Validation surface required by the ADR:
//   (a) find-active workflow + drift report (clean / dirty)
//   (b) archive with confirmation
//   (c) no-active edge case ("no active workflow; nothing to resume")
//
// `/engineer:resume` is a markdown command — the LLM reads it and
// executes shell snippets that drive `state.mjs` CLI subcommands. This
// test exercises both halves:
//
//   1. The state.mjs primitives the command relies on (find-active
//      null / single, read frontmatter as JSON, archive CLI round-trip)
//      so the command's underlying contract is regression-protected.
//   2. The command body itself for shape conformance — frontmatter
//      fields, the four documented outcomes (single / multi / none /
//      archive), and ADR-0017 cross-reference.
//
// Multi-active behavior is covered by test-state.mjs single-active
// invariant tests; this file's expectation is that the command body
// surfaces the multi-active branch with the right state.mjs call,
// which is verified by string assertions.
//
// Run via `node --test tests/engineer/test-resume.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, match } from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE_PATH = resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs');
const COMMAND_PATH = resolve(
  REPO_ROOT,
  'plugins/engineer/commands/resume.md',
);

const {
  createWorkflow,
  listWorkflowFiles,
  findActiveWorkflow,
  readWorkflow,
  archiveWorkflow,
  ARCHIVE_DIR_REL,
} = await import(STATE_PATH);

const MIN_BASELINE = {
  branch: 'test',
  head: '0000000000000000000000000000000000000000',
  status_digest: '',
};

// Real git repo so findActiveWorkflow's `git branch --show-current`
// probe (ADR-0018 §sub-2) returns the expected name.
function gitInit(dir, branch) {
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, stdio: 'ignore' });
}

async function withTmpRepo(fn, { branch = 'test' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'engineer-resume-test-'));
  try {
    gitInit(dir, branch);
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

// --- (c) no-active edge case -------------------------------------------

describe('/engineer:resume — (c) no-active edge case (ADR-0017 §sub-decision-1)', () => {
  it('findActiveWorkflow returns null on an empty repo (resume command treats null as "no active")', async () => {
    await withTmpRepo(async (repoRoot) => {
      const result = await findActiveWorkflow(repoRoot);
      strictEqual(result, null);
    });
  });

  it('state.mjs find-active CLI exits 0 with empty stdout when no workflow exists', async () => {
    await withTmpRepo(async (repoRoot) => {
      const cp = spawnSync(
        process.execPath,
        [STATE_PATH, 'find-active', '--repo-root', repoRoot],
        { encoding: 'utf8' },
      );
      strictEqual(cp.status, 0, `stderr: ${cp.stderr}`);
      strictEqual(cp.stdout.trim(), '', 'expected empty stdout');
    });
  });
});

// --- (a) find-active + drift report (clean / dirty) --------------------

describe('/engineer:resume — (a) single-active resume + drift inputs (ADR-0017 §sub-decision-1)', () => {
  it('findActiveWorkflow returns the single workflow path after createWorkflow', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'resume test',
      });
      const found = await findActiveWorkflow(repoRoot);
      ok(found, 'expected non-null path');
      const [listed] = await listWorkflowFiles(repoRoot);
      strictEqual(found, listed, 'find-active path must match listWorkflowFiles');
    });
  });

  it('state.mjs read --workflow-path emits parseable JSON with git_baseline (drift report inputs)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: {
          branch: 'feature/x',
          head: 'abcdef0123456789abcdef0123456789abcdef01',
          status_digest:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
        originalRequest: 'drift inputs',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const cp = spawnSync(
        process.execPath,
        [STATE_PATH, 'read', '--workflow-path', filePath],
        { encoding: 'utf8' },
      );
      strictEqual(cp.status, 0, `stderr: ${cp.stderr}`);
      const parsed = JSON.parse(cp.stdout);
      strictEqual(parsed.git_baseline.branch, 'feature/x');
      strictEqual(
        parsed.git_baseline.head,
        'abcdef0123456789abcdef0123456789abcdef01',
      );
      ok(
        typeof parsed.git_baseline.status_digest === 'string',
        'status_digest must be a string',
      );
      // current_phase + next_action are required for the drift report
      // header per the command body Phase 2 layout.
      ok(parsed.current_phase, 'current_phase missing');
      ok('next_action' in parsed, 'next_action key missing');
    });
  });

  it('drift inputs distinguish clean (HEAD/digest unchanged) from dirty (HEAD or digest changed)', async () => {
    // The command body classifies by comparing current `git rev-parse
    // HEAD` and `git status --porcelain | shasum` against
    // git_baseline. Here we simulate the comparison directly.
    await withTmpRepo(async (repoRoot) => {
      const baseHead = '1111111111111111111111111111111111111111';
      const baseDigest =
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: {
          branch: 'main',
          head: baseHead,
          status_digest: baseDigest,
        },
        originalRequest: 'drift classify',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const { frontmatter: fm } = await readWorkflow(filePath);

      // Clean: identical HEAD + digest
      const cleanIsDirty =
        fm.git_baseline.branch !== 'main' ||
        fm.git_baseline.head !== baseHead ||
        (fm.git_baseline.status_digest &&
          fm.git_baseline.status_digest !== baseDigest);
      strictEqual(cleanIsDirty, false, 'unchanged inputs must classify as clean');

      // Dirty (head advanced)
      const advancedHead = '2222222222222222222222222222222222222222';
      const dirtyByHead =
        fm.git_baseline.head !== advancedHead;
      ok(dirtyByHead, 'advanced HEAD must classify as dirty');

      // Dirty (digest changed) — non-empty baseline digest mismatches
      const newDigest =
        'aaaa000000000000000000000000000000000000000000000000000000000000';
      const dirtyByDigest =
        fm.git_baseline.status_digest && fm.git_baseline.status_digest !== newDigest;
      ok(dirtyByDigest, 'digest delta must classify as dirty');
    });
  });
});

// --- (b) archive with confirmation -------------------------------------

describe('/engineer:resume — (b) archive flow (ADR-0017 §sub-decision-1)', () => {
  it('state.mjs archive CLI moves single active workflow into archive/', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'archive test',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const cp = spawnSync(
        process.execPath,
        [
          STATE_PATH,
          'archive',
          '--workflow-path',
          filePath,
          '--host',
          'claude',
          '--repo-root',
          repoRoot,
        ],
        { encoding: 'utf8' },
      );
      strictEqual(cp.status, 0, `stderr: ${cp.stderr}`);
      ok(cp.stdout.includes(ARCHIVE_DIR_REL), `unexpected stdout: ${cp.stdout}`);

      // Active list now empty.
      const remaining = await listWorkflowFiles(repoRoot);
      strictEqual(remaining.length, 0, 'archive must remove from active list');

      // host_history records the archive event (matches the command's
      // post-archive sanity-check requirement).
      const archivedPath = cp.stdout.trim();
      const { frontmatter: fm } = await readWorkflow(archivedPath);
      strictEqual(fm.host_history.at(-1).event, 'archived');
    });
  });

  it('archive is idempotent — second call on a missing source returns archived=false', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'idempotent archive',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const result1 = await archiveWorkflow({
        workflowPath: filePath,
        host: 'claude',
        repoRoot,
      });
      strictEqual(result1.archived, true);

      // Re-attempt on the now-missing source.
      const result2 = await archiveWorkflow({
        workflowPath: filePath,
        host: 'claude',
        repoRoot,
      });
      strictEqual(result2.archived, false);
      strictEqual(result2.reason, 'source-missing');
    });
  });
});

// --- Command body shape conformance ------------------------------------

describe('/engineer:resume — commands/resume.md shape conformance', () => {
  it('exists at the canonical path', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(text.length > 0, 'commands/resume.md is empty');
  });

  it('frontmatter has non-empty description and argument-hint', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    const fm = frontmatter(text);
    ok(fm, 'no YAML frontmatter');
    match(fm, /^description:\s*\S/m);
    match(fm, /^argument-hint:\s*\S/m);
  });

  it('argument-hint surfaces the archive sub-form', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    const fm = frontmatter(text);
    match(fm, /archive/, 'argument-hint should mention archive');
  });

  it('body classifies drift as exactly clean / dirty (ADR-0017 §sub-decision-1 two-tier)', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(/clean/i.test(text), 'body missing "clean" classification');
    ok(/dirty/i.test(text), 'body missing "dirty" classification');
    // Defer-to-Stage-3+ note required to prevent scope creep.
    ok(
      /4-tier|compatible|conflicting|rewound/i.test(text),
      'body should reference the deferred 4-tier vocabulary so the OUT-OF-SCOPE intent is explicit',
    );
  });

  it('body covers all four outcome paths (single / multi / none / archive)', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(/single active/i.test(text), 'body missing single-active branch');
    ok(
      /per-branch duplicate/i.test(text),
      'body missing per-branch duplicate branch (ADR-0018 §sub-2 cascade of multi-active)',
    );
    ok(/no active workflow/i.test(text), 'body missing no-active branch');
    ok(/archive mode/i.test(text), 'body missing archive-mode branch');
  });

  it('body references the state.mjs subcommands the command depends on', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    // Snippets use `state.mjs` followed by an optional shell
    // line-continuation (`\`) and indentation before the subcommand.
    // Accept up to 120 intervening chars to span that wrap.
    ok(
      /state\.mjs[\s\S]{0,120}find-active/.test(text),
      'find-active subcommand call missing',
    );
    ok(
      /state\.mjs[\s\S]{0,120}\bread\b/.test(text),
      'read subcommand call missing',
    );
    ok(
      /state\.mjs[\s\S]{0,120}archive/.test(text),
      'archive subcommand call missing',
    );
    ok(
      /state\.mjs[\s\S]{0,120}append/.test(text),
      'append subcommand call missing (resume marker)',
    );
  });

  it('body cites ADR-0017 §sub-decision-1 (provenance + scope discipline)', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(/ADR-0017/.test(text), 'body missing ADR-0017 reference');
    ok(/sub-decision-1/.test(text), 'body missing sub-decision-1 reference');
  });

  it('append uses --event resumed so SessionStart suffix sees the resume marker', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(/--event resumed/.test(text), 'append must record --event resumed');
  });

  it('dirty case enriches output with ADR-0018 §sub-decision-3 four git introspection probes', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(
      /git\s+log\s+"\$BASE_HEAD\.\.HEAD"\s+--oneline/.test(text),
      'probe #1 (git log <baseline.head>..HEAD --oneline) missing',
    );
    ok(
      /git\s+diff\s+--stat\s+HEAD/.test(text),
      'probe #2 (git diff --stat HEAD) missing',
    );
    ok(
      /git\s+log\s+--diff-filter=R\s+--name-status\s+"\$BASE_HEAD\.\.HEAD"/.test(text),
      'probe #3 (git log --diff-filter=R --name-status <baseline.head>..HEAD) missing',
    );
    ok(
      /git\s+log\s+--diff-filter=D\s+--name-status\s+"\$BASE_HEAD\.\.HEAD"/.test(text),
      'probe #4 (git log --diff-filter=D --name-status <baseline.head>..HEAD) missing',
    );
  });

  it('dirty case includes ADR-0018 §sub-decision-3 auto-reconcile-not-supported notice', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(
      text.includes(
        'current plugin does not auto-reconcile; review and decide [resume / archive / abort]',
      ),
      'ADR-0018 §sub-3 exact notice text missing or altered',
    );
  });

  it('body cites ADR-0018 §sub-decision-3 (drift enrichment provenance)', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(/ADR-0018/.test(text), 'body missing ADR-0018 reference');
    ok(/sub-decision[ -]?3/i.test(text), 'body missing §sub-decision-3 reference');
  });

  it('dirty enrichment guards against empty BASE_HEAD before running range probes', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    // Either an empty/null check on BASE_HEAD, or an "Invalid baseline" diagnostic.
    ok(
      /-z\s+"\$BASE_HEAD"|BASE_HEAD"\s*=\s*"null"|Invalid baseline/i.test(text),
      'BASE_HEAD non-empty guard missing — range probes can fatal on empty baseline.head',
    );
  });
});
