// plugins/engineer — peer-now command + peer-runner operational
// controls tests (ADR-0017 §sub-decision-3 + ADR-0023 PR-E).
//
// Validation contract per ADR-0017 §sub-decision 3:
//   - Reuses peer-runner.mjs text mode for verbatim prompt pass-through
//     while adding run_id-based status/cancel ledger support.
//   - [Peer] label injection in the workflow body when an active
//     workflow exists (additive, side-channel).
//   - Excluded from `ensemble_results` frontmatter (peer-now mirrors
//     omcc-dev's `codex-now` Result Bookkeeping exclusion).
//
// The command body itself is exercised by static shape assertions —
// the command is a markdown shim the LLM reads and executes, so the
// regression value is in pinning the shell skeleton (state.mjs find-
// active, peer-runner.mjs invocation pattern, [Peer] label, no
// current_phase mutation).
//
// dispatch-peer.mjs remains covered as the blocking compatibility
// surface. peer-now itself is pinned to peer-runner.mjs --kind peer-now
// so operational status/cancel can target the hidden ledger by run_id.
//
// Run via `node --test tests/engineer/test-peer-now.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, match } from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE_PATH = resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs');
const DISPATCH_PATH = resolve(
  REPO_ROOT,
  'plugins/engineer/scripts/dispatch-peer.mjs',
);
const PEER_RUNNER_PATH = resolve(
  REPO_ROOT,
  'plugins/engineer/scripts/peer-runner.mjs',
);
const COMMAND_PATH = resolve(
  REPO_ROOT,
  'plugins/engineer/commands/peer-now.md',
);

const { createWorkflow, listWorkflowFiles, readWorkflow } = await import(
  STATE_PATH
);

const MIN_BASELINE = {
  branch: 'test',
  head: '0'.repeat(40),
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
  const dir = await mkdtemp(join(tmpdir(), 'engineer-peer-now-test-'));
  try {
    gitInit(dir, branch);
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function frontmatterBlock(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

// --- Command body shape conformance ----------------------------------------

describe('/engineer:peer-now — commands/peer-now.md shape conformance', () => {
  it('exists at the canonical path', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(text.length > 0, 'commands/peer-now.md is empty');
  });

  it('frontmatter has non-empty description and argument-hint with --peer flag', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    const fm = frontmatterBlock(text);
    ok(fm, 'no YAML frontmatter');
    match(fm, /^description:\s*\S/m);
    match(fm, /^argument-hint:\s*.*--peer/m);
  });

  it('argument-hint surfaces both prompt-text and prompt-file forms', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    const fm = frontmatterBlock(text);
    ok(/--prompt-text/.test(fm), 'argument-hint missing --prompt-text form');
    ok(/--prompt-file/.test(fm), 'argument-hint missing --prompt-file form');
  });

  it('body cross-references ADR-0017 §sub-decision-3', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(
      /ADR-0017.*sub-decision-3|ADR-0017.*sub-3/i.test(text),
      'body should cite ADR-0017 §sub-decision-3',
    );
  });

  it('body invokes peer-runner.mjs with --kind peer-now and --output-format text', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(
      /peer-runner\.mjs"\s+run[\s\S]{0,260}--kind peer-now[\s\S]{0,260}--output-format text/.test(text),
      'body should call peer-runner.mjs run --kind peer-now --output-format text',
    );
    ok(
      /RUN_ID="peer-now-/.test(text) && /run_id=\$RUN_ID/.test(text),
      'body should allocate and surface a peer-now run_id for status/cancel controls',
    );
  });

  it('body documents peer-now status and cancel commands by run_id', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(
      /peer-runner\.mjs"\s+status[\s\S]{0,160}--run-id "\$RUN_ID"/.test(text),
      'body should document peer-runner status --run-id "$RUN_ID"',
    );
    ok(
      /peer-runner\.mjs"\s+cancel[\s\S]{0,160}--run-id "\$RUN_ID"/.test(text),
      'body should document peer-runner cancel --run-id "$RUN_ID"',
    );
  });

  it('body locates the active workflow via state.mjs find-active', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(
      /state\.mjs[\s\S]{0,120}find-active/.test(text),
      'body should call state.mjs find-active to detect active workflow',
    );
  });

  it('body uses the [Peer] label phase note injection (state.mjs append)', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(
      /\[Peer\]/.test(text),
      'body should inject the [Peer] label per ADR-0017 §sub-decision-3',
    );
    ok(
      /state\.mjs[\s\S]{0,120}\bappend\b/.test(text),
      'body should call state.mjs append to record the [Peer] phase note',
    );
  });

  it('body explicitly excludes peer-now from ensemble_results / phase advance', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(
      /ensemble_results/.test(text) && /(exclude|excluded|side-channel|does NOT)/i.test(text),
      'body should explicitly note exclusion from ensemble_results / phase machine',
    );
    // Should NOT pass --current-phase or --next-action when calling append
    // (peer-now is a side-channel that does not advance phase).
    ok(
      /Do NOT pass `--current-phase`|do NOT[\s\S]{0,80}current-phase/i.test(text),
      'body should explicitly forbid --current-phase / --next-action mutation',
    );
  });

  it('body covers all three outcome branches (single / multi / no-active)', async () => {
    const text = await readFile(COMMAND_PATH, 'utf8');
    ok(/single path/i.test(text), 'body missing single-active branch');
    ok(
      /per-branch duplicate/i.test(text),
      'body missing per-branch duplicate branch (ADR-0018 §sub-2 cascade of multi-active)',
    );
    ok(/standalone|no active workflow/i.test(text), 'body missing standalone branch');
  });
});

// --- state.mjs append CLI: phase-note without phase mutation ---------------

describe('state.mjs append — phase-note only (no current_phase change)', () => {
  it('append without --current-phase preserves the existing phase value', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'peer-now phase-preservation test',
        currentPhase: 'phase-1-running',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const cp = spawnSync(
        process.execPath,
        [
          STATE_PATH,
          'append',
          '--workflow-path',
          filePath,
          '--host',
          'claude',
          '--phase-label',
          '[Peer] codex consultation',
          '--phase-note',
          'verbatim peer probe — does not advance phase',
          '--event',
          'updated',
        ],
        { encoding: 'utf8' },
      );
      strictEqual(cp.status, 0, `stderr: ${cp.stderr}`);

      const { frontmatter, body } = await readWorkflow(filePath);
      strictEqual(
        frontmatter.current_phase,
        'phase-1-running',
        'current_phase should be unchanged when --current-phase is omitted',
      );
      ok(
        /\[Peer\] codex consultation/.test(body),
        'phase note should appear in body',
      );
      ok(
        /verbatim peer probe/.test(body),
        'phase note text should appear in body',
      );
    });
  });

  it('append without --next-action preserves the existing next_action value', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'peer-now next-action preservation test',
        nextAction: 'investigate the auth flow',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const cp = spawnSync(
        process.execPath,
        [
          STATE_PATH,
          'append',
          '--workflow-path',
          filePath,
          '--host',
          'claude',
          '--phase-label',
          '[Peer] claude consultation',
          '--phase-note',
          'asked for a second opinion',
          '--event',
          'updated',
        ],
        { encoding: 'utf8' },
      );
      strictEqual(cp.status, 0, `stderr: ${cp.stderr}`);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(
        frontmatter.next_action,
        'investigate the auth flow',
        'next_action should be preserved when --next-action is omitted',
      );
    });
  });
});

// --- peer-runner.mjs CLI surface (peer-now path, no companion) -------------

describe('peer-runner.mjs peer-now CLI surface', () => {
  it('kind=peer-now creates a ledger and status can read it when companion is missing', async () => {
    await withTmpRepo(async (repoRoot) => {
      const promptFile = join(repoRoot, 'p.txt');
      await writeFile(promptFile, 'verbatim probe');
      await writeFile(
        join(repoRoot, 'discover-peer.mjs'),
        'export async function discoverPeerCompanion() { return { ok: false, reason: "test miss" }; }\n',
      );
      const cleanEnv = { ...process.env };
      cleanEnv.AGENTIC_COMPANIONS_ROOT = repoRoot;
      cleanEnv.HOME = repoRoot;

      const runId = 'peer-now-missing-companion';
      const cp = spawnSync(
        process.execPath,
        [
          PEER_RUNNER_PATH,
          'run',
          '--repo-root',
          repoRoot,
          '--run-id',
          runId,
          '--kind',
          'peer-now',
          '--peer',
          'codex',
          '--prompt-file',
          promptFile,
          '--output-format',
          'text',
          '--cwd',
          repoRoot,
        ],
        {
          encoding: 'utf8',
          env: cleanEnv,
          cwd: repoRoot,
        },
      );

      strictEqual(cp.status, 3, `expected missing companion exit 3; stderr: ${cp.stderr}`);
      const result = JSON.parse(cp.stdout);
      strictEqual(result.run_id, runId);
      strictEqual(result.status, 'failed');
      strictEqual(result.error_kind, 'peer_cli_not_found');
      ok(result.handle_path.endsWith('handle.json'), 'run result should expose handle_path');

      const status = spawnSync(
        process.execPath,
        [
          PEER_RUNNER_PATH,
          'status',
          '--repo-root',
          repoRoot,
          '--run-id',
          runId,
          '--json',
        ],
        { encoding: 'utf8', env: cleanEnv, cwd: repoRoot },
      );
      strictEqual(status.status, 0, `status stderr: ${status.stderr}`);
      const parsed = JSON.parse(status.stdout);
      strictEqual(parsed.handle.kind, 'peer-now');
      strictEqual(parsed.status, 'failed');
      strictEqual(parsed.handle.workflow_path, null);
    });
  });
});

// --- dispatch-peer.mjs CLI surface (compatibility path, no companion) ------

describe('dispatch-peer.mjs verbatim CLI surface (peer-now path)', () => {
  it('rejects when --peer is missing', () => {
    const cp = spawnSync(
      process.execPath,
      [DISPATCH_PATH, '--prompt-text', 'hello'],
      { encoding: 'utf8' },
    );
    strictEqual(cp.status, 2, `expected misuse exit 2; stderr: ${cp.stderr}`);
    match(cp.stderr, /--peer/);
  });

  it('rejects when --peer value is invalid', () => {
    const cp = spawnSync(
      process.execPath,
      [DISPATCH_PATH, '--peer', 'gpt', '--prompt-text', 'hello'],
      { encoding: 'utf8' },
    );
    ok(cp.status !== 0, 'invalid --peer should not exit 0');
  });

  it('rejects when both --prompt-text and --prompt-file are provided', () => {
    const cp = spawnSync(
      process.execPath,
      [
        DISPATCH_PATH,
        '--peer',
        'codex',
        '--prompt-text',
        'hello',
        '--prompt-file',
        '/dev/null',
      ],
      { encoding: 'utf8' },
    );
    ok(cp.status !== 0, 'both prompt forms should be rejected');
  });

  it('returns companion_error / exit 3 when no companion can be located', async () => {
    await withTmpRepo(async (repoRoot) => {
      // Empty repo, no companions cache, no env override → companion not found.
      const promptFile = join(repoRoot, 'p.txt');
      await writeFile(promptFile, 'verbatim probe');
      // Strip AGENTIC_COMPANIONS_ROOT so dispatch-peer falls through to the
      // cache lookup, then point HOME at an empty tmp dir so the cache miss
      // returns the well-typed companion_error instead of throwing on a
      // bogus override path.
      const cleanEnv = { ...process.env };
      delete cleanEnv.AGENTIC_COMPANIONS_ROOT;
      cleanEnv.HOME = repoRoot;

      const cp = spawnSync(
        process.execPath,
        [
          DISPATCH_PATH,
          '--peer',
          'codex',
          '--prompt-file',
          promptFile,
          '--output-format',
          'json',
        ],
        {
          encoding: 'utf8',
          env: cleanEnv,
          // cwd outside the agentic-plugins repo so the in-repo dev
          // companions are not auto-discovered.
          cwd: repoRoot,
        },
      );
      strictEqual(
        cp.status,
        3,
        `expected exit 3 (peer CLI not found); got ${cp.status}; stderr: ${cp.stderr}`,
      );
      match(cp.stderr, /companion/i);
    });
  });
});
