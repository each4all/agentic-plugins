// tests/orchestrator/test-autopilot-worker.mjs
//
// ADR-0063 D5/D7 — the autopilot's worker host (plugins/orchestrator/
// adapters/claude/autopilot/worker.mjs), against a fake `claude`
// (tests/orchestrator/fixtures/autopilot-fake-claude.mjs, through
// AUTOPILOT_CLAUDE_BIN): stdin is held open until a result has arrived and no
// background task or follow-up turn is pending (probe D2), a PreCompact event
// and a timeout abort the step and kill the whole process group, the context
// sensor counts main-thread messages only, the posture never escalates, the
// environment is scrubbed, and network pushes fail at the git level.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const W = await import(resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/worker.mjs'));
const FAKE = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-fake-claude.mjs');
chmodSync(FAKE, 0o755);

const RUN = 'autopilot-20261001T000000Z-123456';
const ROOTS = { orchestrator: '/roots/orchestrator', engineer: '/roots/engineer', runtime: '/roots/runtime' };

function scratch() {
  return mkdtempSync(join(tmpdir(), 'autopilot-worker-'));
}

async function run(mode, over = {}, envOver = {}) {
  const dir = scratch();
  const log = join(dir, 'claude.log');
  try {
    const handle = W.startWorker({
      cwd: dir, prompt: '/engineer:critique', stepKind: 'verb', runId: RUN, seq: 1, roots: ROOTS,
      stepBudgetUsd: 1, stepTimeoutSec: 30, model: null, effort: null, rawPath: join(dir, 'worker-1.jsonl'),
      env: { ...process.env, AUTOPILOT_CLAUDE_BIN: FAKE, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: log, ...envOver },
      ...over,
    });
    if (!over.noBegin) handle.begin();
    const w = await handle.done;
    const lines = existsSync(join(dir, 'worker-1.jsonl'))
      ? readFileSync(join(dir, 'worker-1.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const started = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    return { w, lines, started, dir };
  } finally {
    if (!over.keep) rmSync(dir, { recursive: true, force: true });
  }
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

describe('stream-json hosting', () => {
  it('holds stdin open until the background task and its follow-up turn finish (probe D2)', async () => {
    const { w, lines } = await run('background');
    strictEqual(w.turns, 2);
    strictEqual(w.costUsd, 0.15, 'the step costs what the last result reports (cumulative)');
    strictEqual(w.peakCtx, 52010);
    const closedAt = lines.findIndex((e) => e.subtype === 'fake_stdin_closed');
    const lastResult = lines.map((e) => e.type).lastIndexOf('result');
    ok(closedAt > lastResult, 'stdin closes only after the follow-up result');
    strictEqual(w.exitCode, 0);
  });

  it('the step\'s report is the follow-up turn\'s, not the one taken while the task was pending', async () => {
    // The worker prompt tells the model a report filed while it waits is
    // provisional and only the last one counts; this is the host side of that.
    const first = { outcome: 'failed', workflow: 'refine-x', next_step: null, awaiting_owner: null, summary: 'provisional: waiting for the peer' };
    const last = { outcome: 'completed', workflow: 'refine-x', next_step: { kind: 'commit', verb: null, confidence: 'HIGH' }, awaiting_owner: null, summary: 'settled' };
    const { w } = await run('background', {}, { FAKE_FIRST_REPORT: JSON.stringify(first), FAKE_REPORT: JSON.stringify(last) });
    strictEqual(w.turns, 2);
    deepStrictEqual(w.report, last);
  });

  it('waits out a background task and a follow-up turn that each outlast the 2 s close debounce', async () => {
    const { w, lines } = await run('background-slow');
    strictEqual(w.turns, 2, 'stdin stayed open for the follow-up turn');
    strictEqual(w.costUsd, 0.15);
    const closedAt = lines.findIndex((e) => e.subtype === 'fake_stdin_closed');
    ok(closedAt > lines.map((e) => e.type).lastIndexOf('result'));
  });

  it('a simple step resolves with one turn and its report', async () => {
    const report = { outcome: 'completed', workflow: 'compose-x', next_step: null, awaiting_owner: null, summary: 's' };
    const { w } = await run('simple', {}, { FAKE_REPORT: JSON.stringify(report) });
    deepStrictEqual([w.turns, w.exitCode, w.aborted, w.costUsd], [1, 0, null, 0.05]);
    deepStrictEqual(w.report, report);
    deepStrictEqual(w.lastResult, { is_error: false, subtype: 'success', num_turns: 1 });
  });

  it('a PreCompact hook event aborts the step', async () => {
    const { w } = await run('precompact');
    strictEqual(w.aborted, 'compaction-imminent');
    strictEqual(w.costUsd, null, 'a killed worker reports no cost; the driver charges its budget');
  });

  it('a timeout kills the whole process group, a grandchild included', async () => {
    const dir = scratch();
    const pidfile = join(dir, 'grandchild.pid');
    try {
      const { w } = await run('hang', { stepTimeoutSec: 1 }, { FAKE_CLAUDE_PIDFILE: pidfile });
      strictEqual(w.aborted, 'timeout');
      ok(w.groupTeardown === 'empty' || w.groupTeardown === 'terminated', `the whole group took the SIGTERM, and nothing needed SIGKILL: ${w.groupTeardown}`);
      const grandchild = Number(readFileSync(pidfile, 'utf8'));
      ok(Number.isInteger(grandchild) && grandchild > 0);
      for (let i = 0; i < 50 && alive(grandchild); i += 1) await new Promise((r) => { setTimeout(r, 100); });
      ok(!alive(grandchild), `grandchild ${grandchild} survived the group kill`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the kill escalates to SIGKILL for a group member that ignores SIGTERM, after the worker itself is gone', async () => {
    const dir = scratch();
    const pidfile = join(dir, 'grandchild.pid');
    try {
      const { w } = await run('stubborn', { stepTimeoutSec: 1 }, { FAKE_CLAUDE_PIDFILE: pidfile });
      strictEqual(w.aborted, 'timeout');
      strictEqual(w.groupTeardown, 'killed');
      // Checked at once: the step is not over while its group holds anything.
      const grandchild = Number(readFileSync(pidfile, 'utf8'));
      ok(!alive(grandchild), `grandchild ${grandchild} survived SIGTERM and the escalation`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a descendant that keeps the output pipes open does not hold the step open', { timeout: 60_000 }, async () => {
    const dir = scratch();
    const pidfile = join(dir, 'holder.pid');
    let holder = null;
    // A watchdog, so that a host that does wait on the pipes fails this test
    // instead of hanging the run: it kills the holder after 20 s.
    let watchdog = null;
    const watch = (async () => {
      for (let i = 0; i < 100 && !existsSync(pidfile); i += 1) await new Promise((r) => { setTimeout(r, 50); });
      const pid = Number(readFileSync(pidfile, 'utf8'));
      watchdog = setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }, 20_000);
    })();
    try {
      const t0 = Date.now();
      const { w } = await run('pipe-holder', { stepTimeoutSec: 60 }, { FAKE_CLAUDE_PIDFILE: pidfile });
      await watch;
      clearTimeout(watchdog);
      holder = Number(readFileSync(pidfile, 'utf8'));
      ok(alive(holder), 'the holder is outside the worker\'s group and still holds the pipes');
      deepStrictEqual([w.exitCode, w.turns, w.aborted], [0, 1, null]);
      ok(Date.now() - t0 < 20_000, `the step ended ${Date.now() - t0} ms after it started`);
    } finally {
      clearTimeout(watchdog);
      if (holder) { try { process.kill(holder, 'SIGKILL'); } catch { /* gone */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a worker that ignores SIGTERM itself is killed after the grace', { timeout: 60_000 }, async () => {
    const dir = scratch();
    const pidfile = join(dir, 'worker.pid');
    // A watchdog, so that a host that never escalates fails this test instead
    // of hanging the run.
    let watchdog = null;
    const watch = (async () => {
      for (let i = 0; i < 100 && !existsSync(pidfile); i += 1) await new Promise((r) => { setTimeout(r, 50); });
      const pid = Number(readFileSync(pidfile, 'utf8'));
      watchdog = setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 20_000);
    })();
    try {
      const t0 = Date.now();
      const { w } = await run('deaf', { stepTimeoutSec: 1 }, { FAKE_CLAUDE_PIDFILE: pidfile });
      await watch;
      clearTimeout(watchdog);
      deepStrictEqual([w.aborted, w.signal], ['timeout', 'SIGKILL']);
      ok(Date.now() - t0 < 15_000, `the step ended ${Date.now() - t0} ms after it started`);
    } finally {
      clearTimeout(watchdog);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a step that ends normally leaves nothing running in its process group', async () => {
    const dir = scratch();
    const pidfile = join(dir, 'grandchild.pid');
    try {
      const { w } = await run('leaves-child', {}, { FAKE_CLAUDE_PIDFILE: pidfile });
      deepStrictEqual([w.exitCode, w.aborted, w.groupTeardown], [0, null, 'terminated']);
      const grandchild = Number(readFileSync(pidfile, 'utf8'));
      ok(!alive(grandchild), `grandchild ${grandchild} outlived its step`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the worker gets no prompt until begin(): a driver that dies before it leaves a worker with nothing to do', async () => {
    const dir = scratch();
    try {
      const handle = W.startWorker({
        cwd: dir, prompt: '/engineer:critique', stepKind: 'verb', runId: RUN, seq: 1, roots: ROOTS,
        stepBudgetUsd: 1, stepTimeoutSec: 30, model: null, effort: null, rawPath: join(dir, 'worker-1.jsonl'),
        env: { ...process.env, AUTOPILOT_CLAUDE_BIN: FAKE, FAKE_CLAUDE_MODE: 'simple' },
      });
      await new Promise((r) => { setTimeout(r, 700); });
      strictEqual(readFileSync(join(dir, 'worker-1.jsonl'), 'utf8'), '', 'no output: the worker never saw a message');
      handle.abort('interrupted');
      const w = await handle.done;
      deepStrictEqual([w.aborted, w.turns], ['interrupted', 0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a raw-stream path that cannot be opened fails before any worker starts', () => {
    const dir = scratch();
    const log = join(dir, 'claude.log');
    try {
      throws(() => W.startWorker({
        cwd: dir, prompt: '/engineer:critique', stepKind: 'verb', runId: RUN, seq: 1, roots: ROOTS,
        stepBudgetUsd: 1, stepTimeoutSec: 30, model: null, effort: null, rawPath: join(dir, 'missing', 'worker-1.jsonl'),
        env: { ...process.env, AUTOPILOT_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log },
      }), /ENOENT/);
      ok(!existsSync(log), 'no worker was spawned');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a worker that exits without a result is reported as such', async () => {
    const { w } = await run('noresult');
    deepStrictEqual([w.exitCode, w.lastResult, w.report, w.costUsd], [3, null, null, null]);
  });

  it('a binary that does not start is a spawn error, not a hang', async () => {
    const { w } = await run('simple', {}, { AUTOPILOT_CLAUDE_BIN: '/nonexistent/claude' });
    ok(w.spawnError, 'spawnError is set');
    strictEqual(w.lastResult, null);
  });

  it('the raw stream is capped, with a marker', async () => {
    const { w, lines } = await run('background', { rawMaxBytes: 300 });
    strictEqual(w.rawTruncated, true);
    strictEqual(lines.at(-1).subtype, 'raw_stream_truncated');
    strictEqual(w.turns, 2, 'the host still read the whole stream');
  });
});

describe('the context sensor (D7)', () => {
  it('divides each model\'s peak by that model\'s window', async () => {
    const { w } = await run('two-models');
    // fake-model: 40010 of 1,000,000; fake-subagent-model on the main thread:
    // 52010 of 200,000 — the step's peak share is the second.
    strictEqual(w.peakCtx, 52010);
    strictEqual(w.contextWindow, 200000);
    strictEqual(w.peakPct, 52010 / 200000);
  });

  it('counts main-thread messages only, against their own model\'s window', async () => {
    const { w } = await run('subagent');
    strictEqual(w.peakCtx, 40010, 'the subagent\'s 190K context is its own, not the step\'s');
    strictEqual(w.contextWindow, 1000000);
    strictEqual(w.peakPct, 40010 / 1000000);
  });
});

describe('plugin provenance at init', () => {
  it('aborts before the first turn when checkInit refuses the loaded plugins', async () => {
    const plugins = [{ name: 'engineer', path: '/repo/plugins/engineer', source: 'engineer@agentic-plugins', version: '0.23.0' }];
    let seen = null;
    const { w } = await run('precompact', {
      checkInit: (p) => { seen = p; return { reason: 'version-drift', detail: 'engineer 0.23.0' }; },
    }, { FAKE_PLUGINS: JSON.stringify(plugins) });
    deepStrictEqual(seen, plugins, 'checkInit gets the init event\'s plugins');
    deepStrictEqual([w.aborted, w.abortReason, w.abortDetail], ['provenance', 'version-drift', 'engineer 0.23.0']);
    deepStrictEqual(w.plugins, plugins);
  });
});

describe('the posture (D5)', () => {
  const argsFor = (stepKind, extra = {}) => W.workerArgs({ sessionId: 's', stepKind, runId: RUN, seq: 1, stepBudgetUsd: 25, model: null, effort: null, ...extra });
  const valueOf = (args, flag) => args[args.indexOf(flag) + 1];

  it('manual mode, no prompts, the exact lists; git commit denied except on /engineer:commit', () => {
    const verb = argsFor('verb');
    deepStrictEqual([valueOf(verb, '--permission-mode'), valueOf(verb, '--permission-prompts')], ['manual', 'none']);
    strictEqual(valueOf(verb, '--allowedTools'), 'Bash Read Edit Write NotebookEdit Task Skill WebFetch WebSearch TaskStop Monitor');
    ok(valueOf(verb, '--disallowedTools').split(' ').includes('Bash(git'), 'a deny rule with a space stays in one string');
    ok(valueOf(verb, '--disallowedTools').endsWith('Bash(git commit:*)'));
    ok(!valueOf(argsFor('commit'), '--disallowedTools').includes('git commit'));
    for (const kind of ['dispatch', 'done', 'done-no-commit', 'finalize']) ok(valueOf(argsFor(kind), '--disallowedTools').includes('Bash(git commit:*)'), kind);
    strictEqual(valueOf(verb, '--max-budget-usd'), '25');
    ok(JSON.parse(valueOf(verb, '--json-schema')).required.includes('workflow'));
    ok(!verb.includes('--model') && !verb.includes('--effort'), 'the owner\'s default when the plan says so');
    deepStrictEqual([valueOf(argsFor('verb', { model: 'sonnet', effort: 'low' }), '--model'), valueOf(argsFor('verb', { model: 'sonnet', effort: 'low' }), '--effort')], ['sonnet', 'low']);
    ok(!/CLAUDE_PLUGIN_ROOT is NOT set|plugin roots/i.test(valueOf(verb, '--append-system-prompt')), 'SHIM-3 is gone (S0 released)');
    ok(valueOf(verb, '--append-system-prompt').includes('A report the host takes when you end a turn to wait for a background task is provisional'), 'a report taken mid-wait does not end the step');
    ok(valueOf(verb, '--append-system-prompt').includes('Only the last report counts.'));
  });

  it('refuses any escalation', () => {
    for (const bad of [['--dangerously-skip-permissions'], ['--permission-mode', 'bypassPermissions'], ['--permission-mode', 'auto'],
      ['--permission-prompts', 'host'], ['--resume', 'x'], ['--continue'], ['--fork-session'], ['--allow-dangerously-skip-permissions']]) {
      throws(() => W.assertNoEscalation(['-p', ...bad]), /escalation|must be|bypassPermissions/, bad.join(' '));
    }
  });

  it('scrubs the launching session and the dispatch contract, sets the run and the roots', async () => {
    const { started } = await run('simple', {}, {
      CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'outer', CLAUDE_CODE_SESSION_KIND: 'bg',
      CLAUDE_BG_SESSION_PERMISSION_RULES: '{"allow":["Bash(*)"],"deny":[]}', CLAUDE_CODE_MESSAGING_SOCKET: '/s',
      CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_RELAUNCH_SESSION_ADD_DIRS: '[]', CLAUDE_PID: '1', CLAUDE_EFFORT: 'max',
      CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_EXECPATH: '/x', AGENTIC_NOTIFY_EGRESS_CHANNEL: 'telegram',
      AGENTIC_COMPANION_DEPTH: '1', AGENTIC_PARENT_WORKFLOW: 'macro-other', AGENTIC_ORIGINATING_SUBTASK: 'Z',
      AGENTIC_PROFILE: 'x', AGENTIC_TOPIC: 'y', AGENTIC_HOST: 'codex', CLAUDE_PLUGIN_ROOT: '/stale',
      AGENTIC_AUTOPILOT: 'autopilot-19990101T000000Z-000000', KEEP_ME: 'yes',
    });
    const env = started[0].env;
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_KIND', 'CLAUDE_BG_SESSION_PERMISSION_RULES',
      'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_RELAUNCH_SESSION_ADD_DIRS', 'CLAUDE_PID', 'CLAUDE_EFFORT',
      'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'AGENTIC_NOTIFY_EGRESS_CHANNEL', 'AGENTIC_COMPANION_DEPTH',
      'AGENTIC_PARENT_WORKFLOW', 'AGENTIC_ORIGINATING_SUBTASK', 'AGENTIC_PROFILE', 'AGENTIC_TOPIC', 'AGENTIC_HOST', 'CLAUDE_PLUGIN_ROOT']) {
      ok(!(k in env), `${k} reached the worker`);
    }
    strictEqual(env.KEEP_ME, 'yes');
    strictEqual(env.AGENTIC_AUTOPILOT, RUN);
    deepStrictEqual([env.AGENTIC_ORCHESTRATOR_ROOT, env.AGENTIC_ENGINEER_ROOT, env.AGENTIC_RUNTIME_ROOT], [ROOTS.orchestrator, ROOTS.engineer, ROOTS.runtime]);
    ok(Number(env.GIT_CONFIG_COUNT) >= 4, 'the push block is in the worker environment');
  });
});

describe('the git-level push block', () => {
  const GIT_ENV = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  const push = (cwd, env, ...args) => spawnSync('git', ['-C', cwd, 'push', ...args], { encoding: 'utf8', env, timeout: 20_000 });

  it('fails every network push at once, leaves local pushes and fetches alone, and keeps existing GIT_CONFIG entries', () => {
    const dir = scratch();
    try {
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(dir, 'origin.git')], { env: { ...process.env, ...GIT_ENV } });
      execFileSync('git', ['clone', '-q', join(dir, 'origin.git'), join(dir, 'work')], { env: { ...process.env, ...GIT_ENV } });
      const work = join(dir, 'work');
      execFileSync('git', ['-C', work, 'commit', '-q', '--allow-empty', '-m', 'x'], { env: { ...process.env, ...GIT_ENV } });
      execFileSync('git', ['-C', work, 'remote', 'add', 'gh', 'git@github.com:o/r.git'], { env: { ...process.env, ...GIT_ENV } });
      execFileSync('git', ['-C', work, 'remote', 'add', 'pushy', join(dir, 'origin.git')], { env: { ...process.env, ...GIT_ENV } });
      execFileSync('git', ['-C', work, 'config', 'remote.pushy.pushurl', 'https://example.invalid/r.git'], { env: { ...process.env, ...GIT_ENV } });
      // A push the block misses would reach this mock ssh, not the network.
      const base = { ...process.env, ...GIT_ENV, GIT_SSH_COMMAND: 'false', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Kept' };
      const remotes = { fetchUrls: [join(dir, 'origin.git'), 'git@github.com:o/r.git', join(dir, 'origin.git')], pushUrls: ['https://example.invalid/r.git'] };
      const env = { ...base, ...W.pushBlockConfig(base, remotes) };
      strictEqual(env.GIT_CONFIG_KEY_0, 'user.name', 'an existing entry keeps its index');

      for (const target of [['https://example.invalid/x.git', 'HEAD'], ['gh', 'HEAD'], ['pushy', 'HEAD:main'], ['ssh://git@example.invalid/x.git', 'HEAD'], ['git@elsewhere.invalid:owner/other.git', 'HEAD']]) {
        const r = push(work, env, ...target);
        ok(r.status !== 0 && /autopilot-push-blocked/.test(r.stderr), `${target[0]}: ${r.stderr}`);
      }
      const own = push(work, env, 'origin', 'HEAD:main');
      ok(own.status !== 0 && /autopilot-push-blocked/.test(own.stderr), 'the repository\'s own origin is blocked even as a path');
      const local = spawnSync('git', ['-C', work, 'push', join(dir, 'origin.git'), 'HEAD:refs/heads/side'], { encoding: 'utf8', env: { ...env, ...W.pushBlockConfig(base, { fetchUrls: [] }) }, timeout: 20_000 });
      strictEqual(local.status, 0, `a local push outside the repository's remotes is untouched: ${local.stderr}`);
      strictEqual(spawnSync('git', ['-C', work, 'fetch', '-q', 'origin'], { env, timeout: 20_000 }).status, 0, 'fetch still works');
      strictEqual(spawnSync('git', ['-C', work, 'config', 'user.name'], { env, encoding: 'utf8' }).stdout.trim(), 'Kept');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves an explicit pushurl that is also a fetch URL open, as documented', () => {
    const cfg = W.pushBlockConfig({}, { fetchUrls: ['https://h/r.git'], pushUrls: ['https://h/r.git'] });
    const values = Object.entries(cfg).filter(([k]) => k.startsWith('GIT_CONFIG_KEY_')).map(([k, v]) => [v, cfg[k.replace('KEY', 'VALUE')]]);
    ok(!values.some(([k, v]) => k.endsWith('.insteadOf') && v === 'https://h/r.git'), 'no insteadOf that would break the fetch');
  });
});

// The fixture must stay executable for the AUTOPILOT_CLAUDE_BIN path.
describe('fixture', () => {
  it('answers --version and --help like the real CLI does for preflight', () => {
    ok(/Fake Claude/.test(execFileSync(FAKE, ['--version'], { encoding: 'utf8' })));
    ok(execFileSync(FAKE, ['--help'], { encoding: 'utf8' }).includes('--permission-prompts'));
  });
});
