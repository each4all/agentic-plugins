// ADR-0043 S3 — founder activation sidecar tests.
//
// Proves the session-handoff projection FIRES from the must-run completion
// mutation (founder `set-terminal`) rather than from runbook prose, and that
// it honors the ADR-0043 §2 fail-closed baseline (engineer's path-targeted
// projection + orchestrator's hardened stale-file handling):
//   - stdout contract unchanged (path-only); the sidecar never touches stdout
//   - the projection FILE is written (the guaranteed channel)
//   - a continue-vs-fresh advisory reaches stderr (best-effort active nudge)
//   - fail-closed + non-fatal: a non-`ok` projection emits nothing, never
//     throws, AND clears a stale projection from a prior successful emit
//   - the setTerminal helper is opt-in: direct JS calls never emit
//
// Host-free + deterministic — integration cases stand up throwaway git repos
// and never assert on the current checkout branch. Run via
// `node --test tests/founder/test-handoff-sidecar.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, doesNotReject } from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { emitTerminalHandoffSidecar } from '../../plugins/founder/scripts/session-handoff.mjs';
import { setTerminal } from '../../plugins/founder/scripts/state.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE = resolve(REPO_ROOT, 'plugins/founder/scripts/state.mjs');
const BASELINE_HEAD = '1111111111111111111111111111111111111111';
const ADVISORY_MARK = 'ADR-0031 session-handoff';

function createWorkflow(repoRoot, branch) {
  return execFileSync(
    'node',
    [
      STATE, 'create',
      '--repo-root', repoRoot,
      '--verb', 'compose', '--host', 'claude', '--persona', 'founder',
      '--git-baseline-branch', branch, '--git-baseline-head', BASELINE_HEAD,
      '--status-digest', 'deadbeef',
      '--profile', 'plan', '--original-request', 'handoff sidecar test',
      '--current-phase', 'phase-0-bootstrap', '--next-action', 'Run compose skill',
    ],
    { encoding: 'utf8' },
  ).trim();
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

describe('founder activation sidecar (ADR-0043 S3)', () => {
  it('fires and writes the projection file for the workflow at the given path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fdr-sidecar-ok-'));
    const workflowPath = createWorkflow(root, 'feat/x');
    const projectionFile = join(root, 'proj.json');
    const result = await emitTerminalHandoffSidecar({ repoRoot: root, workflowPath, projectionFile });
    strictEqual(result.emitted, true);
    strictEqual(result.status, 'ok');
    ok(await exists(projectionFile), 'projection file must be written (guaranteed channel)');
    const projection = JSON.parse(await readFile(projectionFile, 'utf8'));
    strictEqual(projection.workflow_kind, 'founder');
    ok(projection.workflow_id && projection.archive_gate, 'projection carries bounded fields');
  });

  it('projects the workflow by PATH, not by current branch (cross-branch correctness)', async () => {
    // Two active workflows on two branches in one repo. Terminalizing workflow
    // A's path must project A — never B — regardless of any current-branch
    // resolution (the ADR-0043 §2 path-targeted baseline).
    const root = await mkdtemp(join(tmpdir(), 'fdr-sidecar-xbranch-'));
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
    const root = await mkdtemp(join(tmpdir(), 'fdr-sidecar-none-'));
    const projectionFile = join(root, 'proj.json');
    const result = await emitTerminalHandoffSidecar({
      repoRoot: root, workflowPath: join(root, 'does-not-exist.md'), projectionFile,
    });
    strictEqual(result.emitted, false);
    strictEqual(await exists(projectionFile), false, 'no projection file on a non-ok status');
  });

  it('a failed emit CLEARS the stale projection from a prior successful emit (ADR-0043 §2 baseline)', async () => {
    // Prior successful emit leaves a projection; a later emit that cannot
    // project (missing workflow) must remove it — the stable file always
    // reflects THIS emit, never an older completion the footer would misread.
    const root = await mkdtemp(join(tmpdir(), 'fdr-sidecar-staleclear-'));
    const workflowPath = createWorkflow(root, 'feat/x');
    const projectionFile = join(root, 'proj.json');
    const first = await emitTerminalHandoffSidecar({ repoRoot: root, workflowPath, projectionFile });
    strictEqual(first.emitted, true);
    ok(await exists(projectionFile), 'precondition: prior emit wrote the projection');
    const second = await emitTerminalHandoffSidecar({
      repoRoot: root, workflowPath: join(root, 'gone.md'), projectionFile,
    });
    strictEqual(second.emitted, false);
    strictEqual(await exists(projectionFile), false, 'the stale projection must be cleared on a failed emit');
  });

  it('stays non-fatal when the projection file cannot be written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fdr-sidecar-wfail-'));
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

  it('direct setTerminal JS calls do NOT emit (emitHandoff is opt-in for the production CLI)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fdr-sidecar-optin-'));
    const workflowPath = createWorkflow(root, 'feat/x');
    await setTerminal({
      workflowPath,
      host: 'claude',
      terminalPhase: 'summary-complete',
      terminalMarker: true,
      nextAction: 'Save/commit the deliverable',
    });
    const projectionFile = join(root, '.agentic-plugins/state/founder/last-session-handoff.json');
    strictEqual(await exists(projectionFile), false,
      'a library setTerminal call (no emitHandoff) must not fire the sidecar');
  });

  it('un-marking (--terminal-marker false) is not a terminal transition: no sidecar (orchestrator parity)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fdr-sidecar-unmark-'));
    const workflowPath = createWorkflow(root, 'feat/x');
    const res = spawnSync(
      'node',
      [
        STATE, 'set-terminal',
        '--workflow-path', workflowPath, '--host', 'claude',
        '--terminal-phase', 'summary-complete', '--terminal-marker', 'false',
        '--next-action', 'keep working', '--event', 'updated',
      ],
      { encoding: 'utf8', cwd: root },
    );
    strictEqual(res.status, 0, res.stderr);
    strictEqual(res.stdout, `${workflowPath}\n`);
    ok(!res.stderr.includes(ADVISORY_MARK), 'no handoff advisory on an un-marking write');
    const projectionFile = join(root, '.agentic-plugins/state/founder/last-session-handoff.json');
    strictEqual(await exists(projectionFile), false,
      'terminal_marker=false must not emit a terminal handoff (Codex Plan-verify edge case)');
  });

  it('a RELATIVE --workflow-path still fires the sidecar (absolute-path resolution before home inference)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fdr-sidecar-relpath-'));
    const workflowPath = createWorkflow(root, 'feat/x');
    const relPath = workflowPath.slice(root.length + 1); // repo-relative spelling
    const res = spawnSync(
      'node',
      [
        STATE, 'set-terminal',
        '--workflow-path', relPath, '--host', 'claude',
        '--terminal-phase', 'summary-complete', '--terminal-marker', 'true',
        '--next-action', 'Save/commit the deliverable', '--event', 'updated',
      ],
      { encoding: 'utf8', cwd: root },
    );
    strictEqual(res.status, 0, res.stderr);
    ok(res.stderr.includes(ADVISORY_MARK),
      `a relative workflow path must not silently skip the sidecar; got: ${res.stderr}`);
    const projectionFile = join(root, '.agentic-plugins/state/founder/last-session-handoff.json');
    ok(await exists(projectionFile), 'projection written despite the relative CLI spelling');
  });

  it('CLI set-terminal fires the sidecar without polluting stdout (docs-only regression guard)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fdr-sidecar-cli-'));
    // Throwaway git repo so the sidecar's probeHead has a HEAD. The branch is
    // one we create here — we never assert on the test runner's own branch.
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
        '--next-action', 'Critique the composed planning artifact', '--event', 'updated',
      ],
      { encoding: 'utf8', cwd: root },
    );

    strictEqual(res.status, 0, `set-terminal exited non-zero: ${res.stderr}`);
    // stdout contract is load-bearing: path only, byte-for-byte. The sidecar
    // must never add prose to stdout (ADR-0031 amendment decision 2).
    strictEqual(res.stdout, `${workflowPath}\n`);
    // The advisory fired on stderr (the active nudge).
    ok(res.stderr.includes(ADVISORY_MARK), `stderr must carry the handoff advisory; got: ${res.stderr}`);
    // The guaranteed channel: the projection file landed under the founder state root.
    const projectionFile = join(root, '.agentic-plugins/state/founder/last-session-handoff.json');
    ok(await exists(projectionFile), 'projection file must be written by the CLI sidecar');
    const projection = JSON.parse(await readFile(projectionFile, 'utf8'));
    strictEqual(projection.workflow_kind, 'founder');

    // The terminal mutation itself still landed.
    const wf = await readFile(workflowPath, 'utf8');
    ok(/terminal_marker:\s*true/.test(wf), 'terminal_marker must be set on the workflow');
  });
});
