// ADR-0031 amendment — orchestrator activation sidecar tests.
//
// Proves the MACRO session-handoff projection FIRES from the must-run macro
// completion mutations rather than from runbook prose, and honors the
// amendment's binding constraints:
//   - stdout contracts unchanged (`set-terminal` = path-only; `subtask-update`
//     = JSON envelope); the sidecar never touches stdout
//   - the projection FILE is written (the guaranteed channel)
//   - a continue-vs-fresh advisory reaches stderr (best-effort active nudge)
//   - fail-closed + non-fatal: a non-`ok` projection emits nothing, never throws
//
// NOT a blind engineer mirror: the orchestrator has TWO macro terminal surfaces
//   - `setMacroTerminal` (the /finalize + /abort CLI `set-terminal` case), and
//   - `updateSubtask`'s auto-terminal pass (the happy-path /done CLI
//     `subtask-update` case) — which fires ONLY on the transition that lands the
//     last subtask, never on a mid-flight subtask update.
//
// This is the mandated regression guard: it FAILS if the sidecar wiring is
// dropped (a docs-only / passive regression). Host-free + deterministic — each
// case stands up its own throwaway macro and never asserts on the current
// checkout branch. Run via `node --test tests/orchestrator/test-handoff-sidecar.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, doesNotReject } from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { emitTerminalHandoffSidecar } from '../../plugins/orchestrator/scripts/session-handoff.mjs';
import { createWorkflow, setPlan } from '../../plugins/orchestrator/scripts/state.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE = resolve(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');
const ADVISORY_MARK = 'ADR-0031 session-handoff';
const PROJECTION_REL = '.agentic-plugins/state/orchestrator/last-session-handoff.json';

const MIN_BASELINE = (branch = 'main') => ({
  branch,
  head: '0000000000000000000000000000000000000000',
  status_digest: '',
});

const SUBTASK = (id, overrides = {}) => ({
  id,
  verb: 'compose',
  branch: `feat/${id.toLowerCase()}`,
  blocked_by: [],
  status: 'pending',
  ...overrides,
});

// Build a macro fixture in the canonical home: create (verb=plan → macro id)
// then optionally set plan.subtasks[]. Returns the macro workflow path.
async function bootstrapMacro(repoRoot, { branch = 'main', subtasks = [] } = {}) {
  const { filePath } = await createWorkflow({
    repoRoot,
    verb: 'plan',
    host: 'claude',
    gitBaseline: MIN_BASELINE(branch),
    currentPhase: 'phase-2-presented',
    nextAction: 'Dispatch the first ready subtask',
    originalRequest: 'orchestrator sidecar fixture',
  });
  if (subtasks.length > 0) {
    await setPlan({ workflowPath: filePath, host: 'claude', subtasks });
  }
  return filePath;
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

describe('orchestrator activation sidecar (ADR-0031 amendment)', () => {
  it('fires and writes the macro projection file for the macro at the given path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-sidecar-ok-'));
    const macroPath = await bootstrapMacro(root, { subtasks: [SUBTASK('T1')] });
    const projectionFile = join(root, 'proj.json');
    const result = await emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: macroPath, projectionFile });
    strictEqual(result.emitted, true);
    strictEqual(result.status, 'ok');
    ok(await exists(projectionFile), 'projection file must be written (guaranteed channel)');
    const projection = JSON.parse(await readFile(projectionFile, 'utf8'));
    strictEqual(projection.workflow_kind, 'orchestrator');
    ok(projection.workflow_id && projection.archive_gate, 'projection carries bounded macro fields');
  });

  it('projects the macro by PATH, not by current branch (cross-branch correctness)', async () => {
    // Two macros on two branches in one repo. Terminalizing macro A's path must
    // project A — never B — regardless of any current-branch resolution.
    const root = await mkdtemp(join(tmpdir(), 'orch-sidecar-xbranch-'));
    const pathA = await bootstrapMacro(root, { branch: 'macro/a', subtasks: [SUBTASK('T1')] });
    await bootstrapMacro(root, { branch: 'macro/b', subtasks: [SUBTASK('T1')] });
    const idA = basename(pathA, '.md');
    const projectionFile = join(root, 'proj.json');
    const result = await emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: pathA, projectionFile });
    strictEqual(result.emitted, true);
    const projection = JSON.parse(await readFile(projectionFile, 'utf8'));
    strictEqual(projection.workflow_id, idA, 'must project the path-targeted macro A, not macro B');
  });

  it('is fail-closed silent when the macro path does not resolve (no file, no throw)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-sidecar-none-'));
    const projectionFile = join(root, 'proj.json');
    const result = await emitTerminalHandoffSidecar({
      repoRoot: root, workflowPath: join(root, 'does-not-exist.md'), projectionFile,
    });
    strictEqual(result.emitted, false);
    strictEqual(await exists(projectionFile), false, 'no projection file on a non-ok status');
  });

  it('stays non-fatal when the projection file cannot be written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-sidecar-wfail-'));
    const macroPath = await bootstrapMacro(root, { subtasks: [SUBTASK('T1')] });
    // Point the projection file under an existing FILE so mkdir(dirname) fails
    // (ENOTDIR) — the sidecar must swallow it, not throw.
    const blocker = join(root, 'blocker');
    await writeFile(blocker, 'x', 'utf8');
    const projectionFile = join(blocker, 'nested', 'proj.json');
    await doesNotReject(() => emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: macroPath, projectionFile }));
    const result = await emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: macroPath, projectionFile });
    strictEqual(result.emitted, false);
  });

  it('never throws on missing inputs (non-fatal contract)', async () => {
    await doesNotReject(() => emitTerminalHandoffSidecar({}));
    const r = await emitTerminalHandoffSidecar({});
    strictEqual(r.emitted, false);
  });

  it('CLI set-terminal (/finalize + /abort surface) fires the sidecar without polluting stdout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-sidecar-setterminal-'));
    const macroPath = await bootstrapMacro(root, { subtasks: [SUBTASK('T1')] });

    const res = spawnSync(
      'node',
      [
        STATE, 'set-terminal',
        '--workflow-path', macroPath, '--host', 'claude',
        '--terminal-phase', 'finalized', '--terminal-marker', 'true',
        '--next-action', 'Macro finalized', '--event', 'updated',
      ],
      { encoding: 'utf8', cwd: root },
    );

    strictEqual(res.status, 0, `set-terminal exited non-zero: ${res.stderr}`);
    // stdout contract is load-bearing: path only, byte-for-byte.
    strictEqual(res.stdout, `${macroPath}\n`);
    // The advisory fired on stderr (the active nudge).
    ok(res.stderr.includes(ADVISORY_MARK), `stderr must carry the handoff advisory; got: ${res.stderr}`);
    // The guaranteed channel: the projection file landed under the orchestrator state root.
    const projectionFile = join(root, PROJECTION_REL);
    ok(await exists(projectionFile), 'projection file must be written by the CLI sidecar');
    const projection = JSON.parse(await readFile(projectionFile, 'utf8'));
    strictEqual(projection.workflow_kind, 'orchestrator');
    // The terminal mutation itself still landed.
    const wf = await readFile(macroPath, 'utf8');
    ok(/terminal_marker:\s*true/.test(wf), 'terminal_marker must be set on the macro');
  });

  it('CLI subtask-update fires the sidecar ONLY on the auto-terminal transition (/done surface)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-sidecar-autoterminal-'));
    // Two subtasks: completing T1 leaves T2 pending (mid-flight → no fire);
    // completing T2 makes all subtasks terminal → auto-terminal → fire.
    const macroPath = await bootstrapMacro(root, { subtasks: [SUBTASK('T1'), SUBTASK('T2')] });
    const projectionFile = join(root, PROJECTION_REL);

    const completeSubtask = (id, eng, commit) => spawnSync(
      'node',
      [
        STATE, 'subtask-update',
        '--workflow-path', macroPath, '--host', 'claude',
        '--subtask-id', id, '--status', 'completed',
        '--engineer-workflow-id', eng, '--commit', commit,
      ],
      { encoding: 'utf8', cwd: root },
    );

    // Complete T1 — mid-flight (T2 still pending), must NOT fire.
    const r1 = completeSubtask('T1', 'eng-t1', 'a'.repeat(40));
    strictEqual(r1.status, 0, `subtask-update T1 failed: ${r1.stderr}`);
    strictEqual(JSON.parse(r1.stdout).autoTerminal, false);
    strictEqual(await exists(projectionFile), false, 'a mid-flight subtask update must NOT fire the sidecar');
    ok(!r1.stderr.includes(ADVISORY_MARK), 'no handoff advisory on a mid-flight update');

    // Complete T2 — lands the last subtask → auto-terminal → fire.
    const r2 = completeSubtask('T2', 'eng-t2', 'b'.repeat(40));
    strictEqual(r2.status, 0, `subtask-update T2 failed: ${r2.stderr}`);
    const envelope = JSON.parse(r2.stdout); // stdout = JSON envelope, unchanged.
    strictEqual(envelope.autoTerminal, true);
    ok(r2.stderr.includes(ADVISORY_MARK), `stderr must carry the advisory on auto-terminal; got: ${r2.stderr}`);
    ok(await exists(projectionFile), 'the auto-terminal transition must fire the sidecar');
    const projection = JSON.parse(await readFile(projectionFile, 'utf8'));
    strictEqual(projection.workflow_kind, 'orchestrator');
  });

  it('clears a stale projection when a later emit cannot project (fail-closed guaranteed channel)', async () => {
    // Codex Plan-verify finding: the stable file is the guaranteed channel, so a
    // non-ok emit must not leave a PRIOR completion's projection behind — a
    // footer would otherwise read the wrong (older) macro.
    const root = await mkdtemp(join(tmpdir(), 'orch-sidecar-stale-'));
    const macroPath = await bootstrapMacro(root, { subtasks: [SUBTASK('T1')] });
    const projectionFile = join(root, 'proj.json');
    // First emit succeeds → the channel holds macro A's projection.
    const ok1 = await emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: macroPath, projectionFile });
    strictEqual(ok1.emitted, true);
    ok(await exists(projectionFile), 'first emit writes the projection');
    // A later emit that cannot project (macro path does not resolve) MUST clear
    // the stale file rather than serve macro A's projection.
    const ok2 = await emitTerminalHandoffSidecar({
      repoRoot: root, workflowPath: join(root, 'gone.md'), projectionFile,
    });
    strictEqual(ok2.emitted, false);
    strictEqual(await exists(projectionFile), false, 'a non-ok emit must clear the stale projection (fail-closed)');
  });

  it('CLI set-terminal --terminal-marker false does NOT fire the sidecar (only a true terminal marks the macro)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-sidecar-unmark-'));
    const macroPath = await bootstrapMacro(root, { subtasks: [SUBTASK('T1')] });
    const projectionFile = join(root, PROJECTION_REL);
    const res = spawnSync(
      'node',
      [
        STATE, 'set-terminal',
        '--workflow-path', macroPath, '--host', 'claude',
        '--terminal-phase', 'commit-complete', '--terminal-marker', 'false',
        '--next-action', 'not terminal', '--event', 'updated',
      ],
      { encoding: 'utf8', cwd: root },
    );
    strictEqual(res.status, 0, `set-terminal exited non-zero: ${res.stderr}`);
    strictEqual(res.stdout, `${macroPath}\n`);
    strictEqual(await exists(projectionFile), false, '--terminal-marker false must not fire the sidecar');
    ok(!res.stderr.includes(ADVISORY_MARK), 'no advisory when the macro is not marked terminal');
  });
});
