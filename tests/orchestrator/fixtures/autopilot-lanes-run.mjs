// tests/orchestrator/fixtures/autopilot-lanes-run.mjs
//
// A run with lanes against the fake claude, for the scheduler's end-to-end
// tests (test-autopilot-scheduler.mjs, test-autopilot-lanes-supervision.mjs):
// a clone with a bare origin and a fake `gh`, shared creation on, the
// scripted worker (autopilot-scripted-worker.mjs) doing each step through the
// real state CLIs, and `run(options, deps)` starting the driver with --lanes 2.

import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRepo, ORCH, ENG, RUNTIME } from './autopilot-repo.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../..');
export const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const { startRun, DEFAULTS } = await import(resolve(AP, 'driver.mjs'));
export const L = await import(resolve(AP, 'ledger.mjs'));
export const LN = await import(resolve(AP, 'lanes.mjs'));
const SR = await import(resolve(REPO_ROOT, 'plugins/orchestrator/scripts/lib/state-root.mjs'));
const FAKE = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-fake-claude.mjs');
const SCRIPTED = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-scripted-worker.mjs');

const version = (root) => JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
export const ROOTS = { orchestrator: ORCH, engineer: ENG, runtime: RUNTIME };
const PLUGINS = Object.entries(ROOTS).map(([name, root]) => ({ name, path: root, source: `${name}@agentic-plugins`, version: version(root) }));
export const COMMIT = { kind: 'commit', verb: null, confidence: 'HIGH' };
export const CRITIQUE = { kind: 'verb', verb: 'critique', confidence: 'HIGH' };
export const hour = () => Math.floor(Date.now() / 1000) + 3600;
// A rate_limit_event's info as the CLI sends it, five-hour window open.
export const OPEN = () => ({
  status: 'allowed', rateLimitType: 'five_hour', resetsAt: hour(),
  unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: hour() }, seven_day: { utilization: 0.4, resetsAt: hour() + 86400 } },
});

export async function setup({ scenario, subtasks = [{ id: 'A' }, { id: 'B' }], rateLimit = OPEN() } = {}) {
  const fx = await makeRepo({ subtasks });
  const work = realpathSync(fx.work);
  SR.enableSharedCreation({ checkout: work, versions: { orchestrator: 'test' } });
  fx.env.HOME = join(fx.dir, 'home');
  mkdirSync(fx.env.HOME);
  const scen = join(fx.dir, 'scenario.json');
  writeFileSync(scen, JSON.stringify({ seqFromArgv: true, ...scenario }));
  const env = {
    ...fx.env,
    AUTOPILOT_CLAUDE_BIN: FAKE, FAKE_CLAUDE_MODE: 'script', FAKE_WORKER_SCRIPT: SCRIPTED, FAKE_SCENARIO: scen,
    FAKE_DRIVER_CHECKOUT: work, FAKE_CLAUDE_LOG: join(fx.dir, 'claude.log'),
    ...(rateLimit ? { FAKE_RATE_LIMIT: JSON.stringify(rateLimit) } : {}),
    AGENTIC_ORCHESTRATOR_ROOT: ORCH, AGENTIC_ENGINEER_ROOT: ENG, AGENTIC_RUNTIME_ROOT: RUNTIME,
    FAKE_PLUGINS: JSON.stringify(PLUGINS),
  };
  const lines = [];
  const signals = new EventEmitter();
  const run = (opts = {}, deps = {}) => startRun({
    repoRoot: work,
    options: {
      ...DEFAULTS, models: 'owner-default', model: null, effort: null, macro: fx.macroId, forced: null, forcedText: null,
      forcedPairs: null, notifyLocal: false, lanes: 2, ...opts,
    },
    env, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`), deps: { signals, ...deps },
  });
  const latest = () => L.readRun(work, L.listRuns(work).at(-1));
  const home = LN.laneHome(work);
  const lane = (id) => LN.lanePath(home, fx.macroId, id);
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: fx.env, encoding: 'utf8' }).trim();
  return { fx, work, env, run, lines, latest, scen, signals, home, lane, git, dir: fx.dir };
}

export const stepsOf = (r) => r.steps.map((s) => [s.seq, s.lane, s.kind, s.subtask_id, s.outcome]);
export const bySubtask = (r) => Object.fromEntries((r.run.lanes?.lanes ?? []).map((l) => [l.subtask_id, l]));

// Writes <name> beside the scenario once a line the run prints matches.
export function markOn(t, re, name) {
  const out = t.lines.push.bind(t.lines);
  t.lines.push = (line) => {
    if (re.test(line)) writeFileSync(join(t.dir, name), '1');
    return out(line);
  };
}
