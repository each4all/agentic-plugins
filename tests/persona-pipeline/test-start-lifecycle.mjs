// The start lifecycle's rules (ADR-0066 PC2b RV3), run through each persona's
// real state.mjs and peer-runner.mjs CLIs the way the runbook names them:
// every phase's ensemble attempt is settled from its run ledger, a repeated
// phase settles each attempt under its own run id, no phase closes the
// workflow, an owner gate met mid-lifecycle pauses it without a terminal write
// and the Stop evaluator keeps it, and the one terminal write at the end is
// finish-verb kind commit (commit_surface off: the owner saves and commits).

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { personaInfo, personasFor } from './_personas.mjs';

const HEAD = '0000000000000000000000000000000000000000';
const MOVED = '1111111111111111111111111111111111111111';
const DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// A companion that answers every task with a successful envelope.
async function writeCompanions(root) {
  const dir = join(root, 'fake-companions');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'discover-peer.mjs'), 'export async function discoverPeerCompanion({ peer } = {}) { return { ok: true, path: new URL("./" + peer + "-companion.mjs", import.meta.url).pathname }; }\n');
  const companion = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ status: 'success', peer_host: 'codex', peer_model: null, stdout: 'the peer answer', exit_code: 0 }));
`;
  for (const peer of ['claude', 'codex']) {
    await writeFile(join(dir, `${peer}-companion.mjs`), companion);
    await chmod(join(dir, `${peer}-companion.mjs`), 0o755);
  }
  return dir;
}

// The environment the runbook's blocks run in, without any AGENTIC_* the test
// process inherited (an autopilot step's variables must not reach them).
function cleanEnv(extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('NODE_TEST')));
  return { ...env, ...extra };
}

for (const persona of personasFor('scripts/peer-runner.mjs')) {
  const P = personaInfo(persona);
  const STATE = P.path('scripts/state.mjs');
  const RUNNER = P.path('scripts/peer-runner.mjs');
  const { parseWorkflowFile } = await import(pathToFileURL(STATE).href);
  const { evaluateStopArchive } = await import(pathToFileURL(P.path('scripts/stop-archive.mjs')).href);

  describe(`${persona}: the start lifecycle (PC2b RV3)`, () => {
    it('settles every phase attempt, pauses on a decide CONFLICT without a terminal write, continues once the owner decides, settles two refine attempts apart, and closes once with finish-verb kind commit', async () => {
      const repoRoot = await mkdtemp(join(tmpdir(), `${persona}-start-lifecycle-`));
      try {
        const env = cleanEnv({ AGENTIC_COMPANIONS_ROOT: await writeCompanions(repoRoot) });
        const run = (script, args) => spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, env, encoding: 'utf8' });
        const state = (...args) => {
          const r = run(STATE, args);
          strictEqual(r.status, 0, `state.mjs ${args[0]}: ${r.stderr}`);
          return r.stdout.trim();
        };
        const fm = async (path) => parseWorkflowFile(await readFile(path, 'utf8')).frontmatter;

        const active = state('create', '--repo-root', repoRoot, '--verb', 'investigate', '--host', 'claude', '--persona', persona,
          '--git-baseline-branch', 'test', '--git-baseline-head', HEAD, '--status-digest', DIGEST,
          '--original-request', 'a lifecycle', '--workflow-type', 'start',
          '--current-phase', 'phase-1-investigate', '--next-action', 'Run investigate');
        const W = ['--workflow-path', active, '--host', 'claude'];
        const dispatch = (verb, type, runId) => {
          const r = run(RUNNER, ['run', '--repo-root', repoRoot, '--kind', 'ensemble', '--peer', 'codex',
            '--prompt-text', '<task>phase</task>', '--output-format', 'json', '--workflow-path', active,
            '--phase', verb, '--host', 'claude', '--cwd', repoRoot, '--ensemble-type', type, '--run-id', runId]);
          strictEqual(r.status, 0, `run ${runId}: ${r.stderr}`);
        };
        const settle = (verb, runId, verdict) => run(RUNNER, ['settle', '--repo-root', repoRoot, ...W, '--phase', verb,
          '--run-id', runId, '--verdict', verdict, '--summary', `${verb} synthesis`]);
        const boundary = (verb) => state('append', ...W, '--verb', verb, '--current-phase', `phase-${verb}`,
          '--next-action', `Run ${verb}`, '--event', 'updated');
        const stays = async (what) => {
          const f = await fm(active);
          ok(f.terminal_marker !== true && f.current_phase !== 'summary-complete', `${what}: the lifecycle is not closed`);
          strictEqual(f.workflow_type, 'start', what);
        };

        // Phase 1 decide meets a CONFLICT: its attempt is settled, then the
        // gate is recorded after the synthesis note, and nothing closes.
        boundary('decide');
        dispatch('decide', 'brainstorm', 'brainstorm-decide-1');
        state('append', ...W, '--phase-label', 'Phase 1: Decide (synthesized)', '--phase-note',
          '### Ensemble synthesis: decide verdict=conflict\n\nA or B, the owner picks.', '--event', 'updated');
        strictEqual(settle('decide', 'brainstorm-decide-1', 'conflict').status, 0, 'the decide attempt settles');
        state('awaiting-owner-set', ...W, '--gate', 'decide-conflict', '--anchor', 'ensemble-synthesis');
        await stays('paused on the gate');
        let f = await fm(active);
        strictEqual(f.awaiting_owner_gate, 'decide-conflict');
        // The Stop hook keeps it even with the HEAD moved: no marker, and the gate.
        const paused = evaluateStopArchive({ frontmatter: f, headSha: MOVED, headSubject: 'work' });
        ok(paused.gateFailures.includes('awaiting_owner'), `gate 5 refuses: ${paused.gateFailures.join(', ')}`);
        ok(paused.gateFailures.includes('terminal_marker'), 'and nothing marked it terminal');

        // The owner decides: the clear names the next phase, and the lifecycle
        // continues without decide's own finish-verb.
        state('awaiting-owner-clear', ...W, '--gate', 'decide-conflict', '--resolution', 'Owner selection: A',
          '--next-step-kind', 'verb', '--next-step-verb', 'compose', '--next-step-confidence', 'HIGH');
        f = await fm(active);
        deepStrictEqual([f.awaiting_owner_gate, f.next_step_kind, f.next_step_verb], [undefined, 'verb', 'compose']);
        await stays('resolved');

        // Phase 4 refine twice: each attempt under its own run id, each settled.
        boundary('refine');
        dispatch('refine', 'refine-verify', 'refine-verify-1');
        strictEqual(settle('refine', 'refine-verify-1', 'concerns').status, 0, 'the first refine attempt settles');
        dispatch('refine', 'refine-verify', 'refine-verify-2');
        // An empty run id would hide the second attempt: refused.
        strictEqual(settle('refine', '', 'resolved').status, 1, 'an empty run id is refused while an attempt is unsettled');
        strictEqual(settle('refine', 'refine-verify-2', 'resolved').status, 0, 'the second refine attempt settles');
        await stays('after the refine passes');
        f = await fm(active);
        deepStrictEqual((f.ensemble_results ?? []).map((r) => [r.phase, r.run_id, r.verdict]),
          [['decide', 'brainstorm-decide-1', 'conflict'], ['refine', 'refine-verify-1', 'concerns'], ['refine', 'refine-verify-2', 'resolved']]);
        deepStrictEqual(f.pending_ensemble ?? [], [], 'no attempt is left pending');

        // The one terminal write: finish-verb kind commit.
        state('finish-verb', ...W, '--next-action', 'Save/commit the deliverable', '--next-step-kind', 'commit', '--next-step-confidence', 'HIGH');
        f = await fm(active);
        deepStrictEqual([f.current_phase, f.terminal_marker, f.next_step_kind, f.workflow_type], ['summary-complete', true, 'commit', 'start']);
        deepStrictEqual(evaluateStopArchive({ frontmatter: f, headSha: MOVED, headSubject: 'save' }).gateFailures, [], 'archived once the owner\'s save moves HEAD');
      } finally {
        await rm(repoRoot, { recursive: true, force: true });
      }
    });
  });
}
