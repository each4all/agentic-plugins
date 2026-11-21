// tests/orchestrator/test-autopilot-claude-launch-driver.mjs
//
// C180 — the driver end to end, with no model (the fake `claude` and the
// scripted worker of test-autopilot-driver.mjs, whose setup this repeats): the
// preflight resolves and probes Claude Code once, every worker of the run
// spawns that launch, and a launch target removed after the preflight fails
// its step with the reason, starting no worker. The resolution's own cases are
// in test-autopilot-claude-launch.mjs.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeRepo, ORCH, ENG, RUNTIME } from './fixtures/autopilot-repo.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const { startRun, DEFAULTS } = await import(resolve(AP, 'driver.mjs'));
const L = await import(resolve(AP, 'ledger.mjs'));
const { startWorker: realStartWorker } = await import(resolve(AP, 'worker.mjs'));
const FAKE = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-fake-claude.mjs');
const { shellQuote } = await import(resolve(REPO_ROOT, 'plugins/orchestrator/scripts/lib/worktree-proposal.mjs'));
const SCRIPTED = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-scripted-worker.mjs');
const COMMIT = { kind: 'commit', verb: null, confidence: 'HIGH' };
const DONE = { kind: 'done', verb: null, confidence: 'HIGH' };

const version = (root) => JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const ROOTS = { orchestrator: ORCH, engineer: ENG, runtime: RUNTIME };
const PLUGINS = Object.entries(ROOTS).map(([name, root]) => ({ name, path: root, source: `${name}@agentic-plugins`, version: version(root) }));

// The run, with AUTOPILOT_CLAUDE_BIN naming a launcher of the fake of its own,
// which a test can remove.
async function setup(scenario) {
  const fx = await makeRepo();
  const work = realpathSync(fx.work);
  fx.env.HOME = join(fx.dir, 'home');
  mkdirSync(fx.env.HOME);
  const scen = join(fx.dir, 'scenario.json');
  writeFileSync(scen, JSON.stringify(scenario));
  const launcher = join(fx.dir, 'claude-launcher.mjs');
  writeFileSync(launcher, `#!/usr/bin/env node\nawait import(${JSON.stringify(pathToFileURL(FAKE).href)});\n`);
  chmodSync(launcher, 0o755);
  const env = {
    ...fx.env,
    AUTOPILOT_CLAUDE_BIN: launcher, FAKE_CLAUDE_MODE: 'script', FAKE_WORKER_SCRIPT: SCRIPTED, FAKE_SCENARIO: scen,
    FAKE_CLAUDE_LOG: join(fx.dir, 'claude.log'),
    AGENTIC_ORCHESTRATOR_ROOT: ORCH, AGENTIC_ENGINEER_ROOT: ENG, AGENTIC_RUNTIME_ROOT: RUNTIME,
    FAKE_PLUGINS: JSON.stringify(PLUGINS),
  };
  const lines = [];
  const run = (deps = {}) => startRun({
    repoRoot: work,
    options: { ...DEFAULTS, models: 'owner-default', model: null, effort: null, macro: null, forced: null, forcedText: null, notifyLocal: false },
    env, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`), deps: { signals: new EventEmitter(), ...deps },
  });
  const latest = () => L.readRun(work, L.listRuns(work).at(-1));
  return { fx, launcher, run, lines, latest };
}

describe('the preflight and every worker run one resolved Claude Code (C180)', () => {
  it('each step spawns the launch the preflight resolved and probed', async () => {
    const t = await setup({ A: { next: [COMMIT], file: true }, B: { next: [DONE] } });
    const given = [];
    try {
      const code = await t.run({ startWorker: (o) => { given.push(o.claudeLaunch); return realStartWorker(o); } });
      strictEqual(code, 2, t.lines.join('\n'));
      const halt = t.latest().halt;
      strictEqual(halt.reason, 'awaiting-landing');
      ok(halt.resume.some((l) => l.startsWith(`${shellQuote(t.launcher)} --resume `)), `the resume runs the run's claude: ${halt.resume.join(' | ')}`);
      strictEqual(given.length, 2);
      for (const l of given) {
        deepStrictEqual([l.command, l.argsPrefix, l.variable], [t.launcher, [], 'AUTOPILOT_CLAUDE_BIN']);
        strictEqual(l, given[0], 'one launch for the run');
      }
    } finally {
      t.fx.cleanup();
    }
  });

  it('a launch target removed after the preflight fails the step with that reason, and no worker runs', async () => {
    const t = await setup({ A: { next: [COMMIT], file: true }, B: { next: [DONE] } });
    try {
      const code = await t.run({ startWorker: (o) => { rmSync(t.launcher, { force: true }); return realStartWorker(o); } });
      strictEqual(code, 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.steps.map((s) => [s.kind, s.outcome]), [['dispatch', 'worker-failed']]);
      strictEqual(r.halt.reason, 'worker-failed');
      match(r.halt.detail, /the worker could not start: the Claude Code CLI the run resolved at its start .* no longer exists; restore it, or set AUTOPILOT_CLAUDE_BIN/);
      ok(!existsSync(join(t.fx.dir, 'claude.log')), 'the fake never started a step');
      ok(!r.halt.resume.some((l) => l.includes('--resume')), 'no session that never existed is offered');
    } finally {
      t.fx.cleanup();
    }
  });
});
