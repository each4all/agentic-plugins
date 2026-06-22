// ADR-0031 amendment — engineer activation sidecar tests.
//
// Proves the session-handoff projection FIRES from the must-run completion
// mutation (engineer `set-terminal`) rather than from runbook prose, and that
// it honors the amendment's binding constraints:
//   - stdout contract unchanged (path-only); the sidecar never touches stdout
//   - the projection FILE is written (the guaranteed channel)
//   - a continue-vs-fresh advisory reaches stderr (best-effort active nudge)
//   - fail-closed + non-fatal: a non-`ok` projection emits nothing and never throws
//
// This is the mandated regression guard: it FAILS if the sidecar wiring is
// dropped (a docs-only / passive regression). Host-free + deterministic — the
// integration case stands up its own throwaway git repo and never asserts on
// the current checkout branch. Run via
// `node --test tests/engineer/test-handoff-sidecar.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, doesNotReject } from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { emitTerminalHandoffSidecar } from '../../plugins/engineer/scripts/session-handoff.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE = resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs');
const BASELINE_HEAD = '1111111111111111111111111111111111111111';
const ADVISORY_MARK = 'ADR-0031 session-handoff';

function createWorkflow(repoRoot, branch) {
  return execFileSync(
    'node',
    [
      STATE, 'create',
      '--repo-root', repoRoot,
      '--verb', 'compose', '--host', 'claude', '--persona', 'engineer',
      '--git-baseline-branch', branch, '--git-baseline-head', BASELINE_HEAD,
      '--status-digest', 'deadbeef',
      '--profile', 'code', '--original-request', 'handoff sidecar test',
      '--current-phase', 'phase-0-bootstrap', '--next-action', 'Run compose skill',
    ],
    { encoding: 'utf8' },
  ).trim();
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

describe('engineer activation sidecar (ADR-0031 amendment)', () => {
  it('fires and writes the projection file for the workflow at the given path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eng-sidecar-ok-'));
    const workflowPath = createWorkflow(root, 'feat/x');
    const projectionFile = join(root, 'proj.json');
    const result = await emitTerminalHandoffSidecar({ repoRoot: root, workflowPath, projectionFile });
    strictEqual(result.emitted, true);
    strictEqual(result.status, 'ok');
    ok(await exists(projectionFile), 'projection file must be written (guaranteed channel)');
    const projection = JSON.parse(await readFile(projectionFile, 'utf8'));
    strictEqual(projection.workflow_kind, 'engineer');
    ok(projection.workflow_id && projection.archive_gate, 'projection carries bounded fields');
  });

  it('projects the workflow by PATH, not by current branch (cross-branch correctness)', async () => {
    // Two active workflows on two branches in one repo. Terminalizing workflow
    // A's path must project A — never B — regardless of any current-branch
    // resolution (the Codex Plan-verify bug: resolving by currentGitBranch
    // projected the wrong workflow).
    const root = await mkdtemp(join(tmpdir(), 'eng-sidecar-xbranch-'));
    const pathA = createWorkflow(root, 'feat/a');
    createWorkflow(root, 'feat/b');
    const idA = basename(pathA, '.md');
    const projectionFile = join(root, 'proj.json');
    const result = await emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: pathA, projectionFile });
    strictEqual(result.emitted, true);
    const projection = JSON.parse(await readFile(projectionFile, 'utf8'));
    strictEqual(projection.workflow_id, idA, 'must project the path-targeted workflow A, not branch B');
  });

  it('is fail-closed silent when the workflow path does not resolve (no file, no throw)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eng-sidecar-none-'));
    const projectionFile = join(root, 'proj.json');
    const result = await emitTerminalHandoffSidecar({
      repoRoot: root, workflowPath: join(root, 'does-not-exist.md'), projectionFile,
    });
    strictEqual(result.emitted, false);
    strictEqual(await exists(projectionFile), false, 'no projection file on a non-ok status');
  });

  it('stays non-fatal when the projection file cannot be written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eng-sidecar-wfail-'));
    const workflowPath = createWorkflow(root, 'feat/x');
    // Point the projection file under an existing FILE so mkdir(dirname) fails
    // (ENOTDIR) — the sidecar must swallow it, not throw.
    const blocker = join(root, 'blocker');
    await writeFile(blocker, 'x', 'utf8');
    const projectionFile = join(blocker, 'nested', 'proj.json');
    await doesNotReject(() => emitTerminalHandoffSidecar({ repoRoot: root, workflowPath, projectionFile }));
    const result = await emitTerminalHandoffSidecar({ repoRoot: root, workflowPath, projectionFile });
    strictEqual(result.emitted, false);
  });

  it('never throws on missing inputs (non-fatal contract)', async () => {
    await doesNotReject(() => emitTerminalHandoffSidecar({}));
    const r = await emitTerminalHandoffSidecar({});
    strictEqual(r.emitted, false);
  });

  it('CLI set-terminal fires the sidecar without polluting stdout (docs-only regression guard)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eng-sidecar-cli-'));
    // Throwaway git repo so the sidecar's currentGitBranch resolves a branch
    // and probeHead has a HEAD. The branch is one we create here — we never
    // assert on the test runner's own checkout branch.
    execFileSync('git', ['init', '-q', '-b', 'feat/x'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'sidecar-e2e'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'sidecar-e2e@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'baseline', '--no-verify'], { cwd: root });

    const workflowPath = createWorkflow(root, 'feat/x');

    const res = spawnSync(
      'node',
      [
        STATE, 'set-terminal',
        '--workflow-path', workflowPath, '--host', 'claude',
        '--terminal-phase', 'summary-complete', '--terminal-marker', 'true',
        '--next-action', 'Critique the composed artifact', '--event', 'updated',
      ],
      { encoding: 'utf8', cwd: root },
    );

    strictEqual(res.status, 0, `set-terminal exited non-zero: ${res.stderr}`);
    // stdout contract is load-bearing: path only, byte-for-byte. The sidecar
    // must never add prose to stdout (ADR-0031 amendment decision 2).
    strictEqual(res.stdout, `${workflowPath}\n`);
    // The advisory fired on stderr (the active nudge).
    ok(res.stderr.includes(ADVISORY_MARK), `stderr must carry the handoff advisory; got: ${res.stderr}`);
    // The guaranteed channel: the projection file landed under the engineer state root.
    const projectionFile = join(root, '.agentic-plugins/state/engineer/last-session-handoff.json');
    ok(await exists(projectionFile), 'projection file must be written by the CLI sidecar');
    const projection = JSON.parse(await readFile(projectionFile, 'utf8'));
    strictEqual(projection.workflow_kind, 'engineer');

    // The terminal mutation itself still landed.
    const wf = await readFile(workflowPath, 'utf8');
    ok(/terminal_marker:\s*true/.test(wf), 'terminal_marker must be set on the workflow');
  });
});
