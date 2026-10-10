// tests/orchestrator/test-autopilot-cli.mjs
//
// ADR-0063 D2/D9 — `/orchestrator:autopilot`'s entry (plugins/orchestrator/
// adapters/claude/autopilot/cli.mjs), its runbook (commands/autopilot.md)
// run as written in bash and zsh, and the optional launcher
// (launcher.template.mjs): dry-run by default (preview spawns no worker),
// arguments through the ADR-0059 args file, a model plan required to start
// (owner decision D5), Claude only, never from inside a run, status and stop
// over the ledger, and a launcher that finds the installed orchestrator.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRepo, ORCH, ENG, RUNTIME } from './fixtures/autopilot-repo.mjs';
import { installLikeRelease } from './fixtures/install-cache.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const CLI = join(AP, 'cli.mjs');
const C = await import(CLI);
const L = await import(join(AP, 'ledger.mjs'));
const { encodeArgsFile } = await import(resolve(REPO_ROOT, 'plugins/orchestrator/scripts/lib/args-file.mjs'));
const FAKE = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-fake-claude.mjs');
chmodSync(FAKE, 0o755);
const RUNBOOK = readFileSync(resolve(ORCH, 'commands/autopilot.md'), 'utf8');
const { findOrchestrator } = await import(join(AP, 'launcher.template.mjs'));

const version = (root) => JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;

async function withRepo(fn, opts) {
  const fx = await makeRepo(opts);
  fx.env.HOME = join(fx.dir, 'home');
  mkdirSync(fx.env.HOME);
  const env = {
    ...fx.env, AUTOPILOT_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: join(fx.dir, 'claude.log'),
    AGENTIC_ORCHESTRATOR_ROOT: ORCH, AGENTIC_ENGINEER_ROOT: ENG, AGENTIC_RUNTIME_ROOT: RUNTIME,
  };
  try {
    return await fn(fx, env, realpathSync(fx.work));
  } finally {
    fx.cleanup();
  }
}

async function main(argv, env, cwd = process.cwd()) {
  const out = [];
  const err = [];
  const here = process.cwd();
  process.chdir(cwd);
  try {
    const code = await C.main(argv, { env, io: { stdin: { isTTY: false }, stderr: process.stderr }, out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    process.chdir(here);
  }
}

describe('parseCli', () => {
  it('defaults to a dry-run preview with the D10 budgets', () => {
    const o = C.parseCli([]);
    deepStrictEqual([o.sub, o.execute, o.models, o.maxSteps, o.maxCostUsd, o.stepBudgetUsd, o.stepTimeoutSec, o.maxTimeSec, o.oversizePct],
      ['preview', false, null, 60, 250, 25, 3600, 86400, 0.25]);
  });

  it('reads options as separate words or with =, and a closed --next', () => {
    const o = C.parseCli(['start', '--execute', '--models=mixed', '--model', 'sonnet', '--effort', 'low', '--max-steps', '3', '--next', '/engineer:refine', '--notify-local']);
    deepStrictEqual([o.sub, o.execute, o.models, o.model, o.effort, o.maxSteps, o.forced, o.notifyLocal], ['start', true, 'mixed', 'sonnet', 'low', 3, { kind: 'verb', verb: 'refine' }, true]);
  });

  it('refuses what it does not know', () => {
    for (const [argv, re] of [
      [['go'], /unknown subcommand/], [['--bogus'], /unknown option/], [['preview', '--execute'], /--execute applies only to start/],
      [['--models', 'cheap'], /--models must be one of/], [['--effort', 'huge'], /--effort must be one of/], [['--model', 'a b'], /not a model name/],
      [['--macro', '../x'], /not a macro workflow id/], [['--max-steps', '0'], /positive integer/], [['--oversize-pct', '2'], /up to 1/],
      [['--next', 'Reply with OK'], /not a step command/], [['--run', 'x'], /--run applies only to status/], [['--json=yes'], /takes no value/],
      [['--step-timeout', '5'], /at least 60 seconds/], [['--max-time', '30'], /at least 60 seconds/], [['--next', '/orchestrator:done A'], /not a step command/],
      // ADR-0067 Decision 6, Budgets: a step reserved below the minimum never spawns.
      [['--step-budget', '0.1'], /--step-budget must be at least 0\.5/],
    ]) throws(() => C.parseCli(argv), re, argv.join(' '));
    strictEqual(C.parseCli(['--step-budget', '0.5']).stepBudgetUsd, 0.5, 'the minimum itself is accepted');
  });

  it('reads an ADR-0059 args file, quoting and all, and removes it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentic-args.'));
    const file = join(dir, 'args.json');
    writeFileSync(file, encodeArgsFile('start --next "/orchestrator:next S2" --models sonnet'));
    const o = C.parseCli(['--args-file', file, '--max-time', '7000']);
    deepStrictEqual([o.sub, o.forced, o.models, o.maxTimeSec], ['start', { kind: 'dispatch', subtaskId: 'S2' }, 'sonnet', 7000]);
    ok(!existsSync(dir), 'the reader removed what it read');
    const bad = mkdtempSync(join(tmpdir(), 'agentic-args.'));
    writeFileSync(join(bad, 'args.json'), encodeArgsFile('preview; rm -rf /'));
    throws(() => C.parseCli(['--args-file', join(bad, 'args.json')]), /arguments:/);
    rmSync(bad, { recursive: true, force: true });
  });

  it('reads --lanes, and --lane <subtask> --next "<step>" pairs, each --next paired with the --lane before it (ADR-0067 Decision 6)', () => {
    strictEqual(C.parseCli([]).lanes, 1, 'absent: the serial driver');
    const o = C.parseCli(['start', '--lanes', '2', '--lane', 'A', '--next', '/engineer:commit', '--next', '/orchestrator:next B']);
    deepStrictEqual([o.lanes, o.forced, o.forcedPairs], [2, null, [
      { lane: 'A', step: { kind: 'commit' } }, { lane: null, step: { kind: 'dispatch', subtaskId: 'B' } },
    ]]);
    deepStrictEqual(C.parseCli(['--next', '/engineer:refine']).forced, { kind: 'verb', verb: 'refine' }, 'serial: one --next, as before');
    for (const [argv, re] of [
      [['--lanes', '2', '--lane', 'A'], /--lane A needs a --next after it/],
      [['--lanes', '2', '--lane', 'A', '--lane', 'B', '--next', '/engineer:commit'], /--lane A needs a --next after it/],
      [['--lane', 'A', '--next', '/engineer:commit'], /--lane applies only with --lanes 2 or more/],
      [['--next', '/engineer:commit', '--next', '/engineer:refine'], /--next is given once without lanes/],
      [['--lanes', '2', '--lane', '../A', '--next', '/engineer:commit'], /is not a subtask id/],
      [['--lanes', '0'], /positive integer/], [['--lanes', '1.5'], /positive integer/],
    ]) throws(() => C.parseCli(argv), re, argv.join(' '));
  });
});

describe('refusals', () => {
  it('runs on Claude Code only (D9)', () => {
    ok(/Claude Code adapter/.test(C.hostRefusal({ AGENTIC_HOST: 'codex' })));
    ok(/Codex install/.test(C.hostRefusal({ CODEX_HOME: '/tmp/ch' }, '/tmp/ch/plugins/cache/agentic-plugins/orchestrator/1.0.0/adapters/claude/autopilot/cli.mjs')));
    strictEqual(C.hostRefusal({}, CLI, '/nonexistent-home'), null);
  });

  it('a step of a run never starts another run, and a start needs a model plan', async () => {
    await withRepo(async (fx, env, work) => {
      const nested = await main(['start', '--execute', '--models', 'sonnet'], { ...env, AGENTIC_AUTOPILOT: 'autopilot-20261001T000000Z-abcdef' }, work);
      strictEqual(nested.code, 1);
      ok(/never starts another run/.test(nested.err));
      const plan = await main(['start', '--execute'], env, work);
      strictEqual(plan.code, 1);
      ok(/needs a model plan: --models owner-default\|mixed\|sonnet/.test(plan.err), plan.err);
      ok(!existsSync(join(fx.dir, 'claude.log')), 'no worker started');
    });
  });
});

describe('preview is a dry run', () => {
  it('prints the decision and the posture and spawns no worker', async () => {
    await withRepo(async (fx, env, work) => {
      const r = await main(['preview', '--json'], env, work);
      strictEqual(r.code, 0, r.err);
      const report = JSON.parse(r.out);
      strictEqual(report.dry_run, true);
      strictEqual(report.start_conditions.ok, true, JSON.stringify(report.start_conditions));
      deepStrictEqual([report.decision.outcome, report.decision.step.kind, report.decision.command], ['step', 'dispatch', `/orchestrator:next A --workflow=${fx.macroId}`]);
      strictEqual(report.posture.permission_mode, 'manual');
      ok(report.launcher_install.includes('launcher.template.mjs'));
      deepStrictEqual(report.plugins.engineer.version, version(ENG));
      ok(!existsSync(join(fx.dir, 'claude.log')), 'preview spawned no worker');
      ok(!existsSync(join(work, '.agentic-plugins', 'runs', 'autopilot')), 'preview wrote no ledger');
      const text = await main([], env, work);
      strictEqual(text.code, 0);
      ok(/a dry run: nothing is spawned/.test(text.out));
      ok(/next step: \/orchestrator:next A/.test(text.out));
      const start = await main(['start'], env, work);
      ok(/This was a preview\. Add --execute to run\./.test(start.out));
    });
  });

  it('exits 2 when the run would halt, and 1 when a start condition fails', async () => {
    await withRepo(async (fx, env, work) => {
      const m = await fx.readMacro();
      await fx.orch.setPlan({ workflowPath: fx.macroPath, host: 'claude', subtasks: m.plan.subtasks });
      const halted = await main(['preview'], env, work);
      strictEqual(halted.code, 2);
      ok(/would halt: plan-unapproved/.test(halted.out), halted.out);
      writeFileSync(join(work, '.gitignore'), '');
      const broken = await main(['preview'], env, work);
      strictEqual(broken.code, 1);
      ok(/is not gitignored/.test(broken.out), broken.out);
    });
  });
});

// ADR-0067 Decision 8, item 4 — preview carries the launch proposals in its
// report and its text; start refuses roots inside the repository with the
// concrete setup.
describe('launch proposals in preview and start', () => {
  // Releases laid out as this repository's plugins are: runtime ships no
  // scripts/state.mjs (fixtures/install-cache.mjs).
  const installAll = (home) => Object.fromEntries([['orchestrator', '0.10.0'], ['engineer', '0.26.0'], ['runtime', '0.102.0']]
    .map(([plugin, version]) => [plugin, installLikeRelease(home, plugin, version)]));

  it('preview on the main checkout proposes the home worktree; from a linked worktree it proposes none', async () => {
    await withRepo(async (fx, env, work) => {
      const pins = installAll(env.HOME);
      const r = await main(['preview', '--json'], env, work);
      strictEqual(r.code, 0, r.err);
      const report = JSON.parse(r.out);
      strictEqual(report.proposals.length, 1, JSON.stringify(report.proposals));
      const [p] = report.proposals;
      strictEqual(p.kind, 'worktree');
      ok(p.command.startsWith(`git -C ${work} worktree add -b autopilot/home `), p.command);
      ok(p.command.includes(`AGENTIC_ENGINEER_ROOT=${pins.engineer} `), p.command);
      ok(p.command.includes(` start --execute --macro ${fx.macroId} --repo `), p.command);
      const text = await main(['preview'], env, work);
      ok(/→ Proposed \(main-checkout\): this is the main checkout, whose branch a serial run switches at each dispatch/.test(text.out), text.out);
      ok(!/A dedicated worktree is recommended/.test(text.out), 'the unconditional line is gone');

      const linked = join(fx.dir, 'linked');
      execFileSync('git', ['-C', work, 'worktree', 'add', '-q', '-b', 'feat/linked', linked]);
      // The macro named, so the absence is the linked-worktree rule's and not
      // a macro the linked worktree could not find by its branch.
      const fromLinked = JSON.parse((await main(['preview', '--json', '--macro', fx.macroId], env, realpathSync(linked))).out);
      strictEqual(fromLinked.view.macro.id, fx.macroId, 'the linked worktree found the macro');
      deepStrictEqual(fromLinked.proposals, []);
    });
  });

  it('start refuses an engineer root inside the repository, with the pinned setup and, on the main checkout, the home worktree', async () => {
    await withRepo(async (fx, env, work) => {
      const pins = installAll(env.HOME);
      const inside = join(work, 'vendored-engineer');
      cpSync(ENG, inside, { recursive: true });
      const r = await main(['start', '--execute', '--models', 'sonnet'], { ...env, AGENTIC_ENGINEER_ROOT: inside }, work);
      strictEqual(r.code, 1);
      ok(/engineer root .* is inside the repository this run drives/.test(r.err), r.err);
      ok(r.err.includes('→ Proposed (roots-in-repo): engineer root is inside the repository this run drives: pin every root to the installed release cache'), r.err);
      ok(r.err.includes(`AGENTIC_ORCHESTRATOR_ROOT=${pins.orchestrator} AGENTIC_ENGINEER_ROOT=${pins.engineer} AGENTIC_RUNTIME_ROOT=${pins.runtime} node `), r.err);
      // The pins alone do not move a directory marketplace here: the refusal
      // says so, and judges the main-checkout trigger too, as preview does.
      ok(r.err.includes('  (these pins move the scripts the runbooks run, not the commands and hooks Claude Code loads: '), r.err);
      const lines = r.err.split('\n');
      const home = lines.findIndex((l) => l.startsWith('→ Proposed (main-checkout): this is the main checkout'));
      ok(home > 0 && lines[home + 1].startsWith(`    git -C ${work} worktree add -b autopilot/home `), r.err);
      ok(lines[home + 1].includes(`AGENTIC_RUNTIME_ROOT=${pins.runtime} node `), lines[home + 1]);
      // Started without --macro: the refusal looks the macro up, as preview
      // does, and the home command names it (the home finds none by branch).
      ok(lines[home + 1].includes(` start --execute --macro ${fx.macroId} --repo `), lines[home + 1]);
    });
  });
});

describe('status and stop', () => {
  it('status reads the latest run, and notices a driver that is gone', async () => {
    await withRepo(async (fx, env, work) => {
      strictEqual((await main(['status'], env, work)).out, `no autopilot runs in ${work}`);
      const id = L.newRunId();
      const dir = L.createRunDir(work, id);
      L.writeRun(dir, { run_id: id, status: 'running', macro_id: fx.macroId, steps: 1, cost_usd: 0.5, started_at: 'then' });
      L.appendStep(dir, { event: 'started', seq: 1, command: '/engineer:critique', session_id: 's1' });
      const r = await main(['status'], env, work);
      ok(r.out.includes(`${id} · gone (the driver exited without recording an end`), r.out);
      ok(/\[1\] \/engineer:critique → running or interrupted/.test(r.out), r.out);
      const json = JSON.parse((await main(['status', '--json'], env, work)).out);
      deepStrictEqual([json.run.run_id, json.live], [id, false]);
      strictEqual((await main(['stop'], env, work)).out, 'no autopilot run is active');
    });
  });

  // ADR-0067 Decision 4, item 5 — status shows each session's admission once,
  // with its age (stale past 4 h) and the command that releases it, with or
  // without a run in this checkout.
  it('status lists the session admissions, once each, stale past 4 h, with the release command', async () => {
    await withRepo(async (fx, env, work) => {
      const orchState = join(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');
      const joined = spawnSync(process.execPath, [orchState, 'admission', 'join', '--macro', fx.macroId, '--checkout', work, '--command', 'next', '--host', 'claude', '--session-id', 'sess-9'], { encoding: 'utf8', env });
      strictEqual(joined.status, 0, joined.stderr);
      const id = joined.stdout.trim();
      const entry = join(L.macroLockPath(L.mainWorktreeRoot(work), fx.macroId), `s-${id}.json`);
      writeFileSync(entry, `${JSON.stringify({ ...JSON.parse(readFileSync(entry, 'utf8')), acquired_at: new Date(Date.now() - 5 * 3600_000).toISOString() })}\n`);
      const none = (await main(['status'], env, work)).out;
      ok(none.startsWith(`no autopilot runs in ${work}\nsession admissions (1):\n`), none);
      ok(none.includes(`/orchestrator:next, checkout ${work}, host claude, session sess-9, admitted 5 h 0 min ago (stale: older than 4 h`), none);
      ok(none.includes(`state.mjs admission release --macro ${fx.macroId} --checkout ${work} --admission ${id}`), none);
      deepStrictEqual(JSON.parse((await main(['status', '--json'], env, work)).out).admissions.map((a) => [a.holder.admission_id, a.locks.length]), [[id, 2]]);
      const runId = L.newRunId();
      L.writeRun(L.createRunDir(work, runId), { run_id: runId, status: 'running', macro_id: fx.macroId, steps: 0, cost_usd: 0, started_at: 'then' });
      const withRun = (await main(['status'], env, work)).out;
      strictEqual(withRun.split('session admissions (1):').length, 2, withRun);
    });
  });

  it('stop signals nothing it cannot prove is the run\'s process', async () => {
    await withRepo(async (fx, env, work) => {
      const { spawn } = await import('node:child_process');
      const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      try {
        // A lock whose pid is alive but carries no fingerprint: live for the
        // lock's purposes, unproven for a signal.
        const lock = L.worktreeLockPath(work);
        mkdirSync(lock, { recursive: true });
        writeFileSync(join(lock, `h-${bystander.pid}-cccc.json`), JSON.stringify({ run_id: 'autopilot-20261001T000000Z-cccccc', macro_id: fx.macroId, pid: bystander.pid, fingerprint: { kind: 'none' }, worker: null }));
        const r = await main(['stop'], env, work);
        strictEqual(r.code, 1);
        ok(/nothing was signalled/.test(r.err), r.err);
        let alive = true;
        try { process.kill(bystander.pid, 0); } catch { alive = false; }
        ok(alive, 'the bystander was not signalled');
      } finally {
        bystander.kill('SIGKILL');
      }
    });
  });
});

describe('stop, when the driver is gone', () => {
  it('empties the orphaned worker\'s whole process group — a member that ignores SIGTERM included — before it reports success (round 3)', { timeout: 60_000 }, async (t) => {
    const { spawn } = await import('node:child_process');
    const fingerprintForPid = L.processFingerprint;
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await withRepo(async (fx, env, work) => {
      const pidfile = join(fx.dir, 'grandchild.pid');
      // A worker as the driver leaves it: a process-group leader that exits on
      // SIGTERM, with a member that does not.
      const leader = spawn(process.execPath, ['-e', `
        const { spawn } = require('node:child_process');
        const g = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
        setTimeout(() => require('node:fs').writeFileSync(process.argv[1], String(g.pid)), 300);
        setInterval(() => {}, 1000);
      `, pidfile], { detached: true, stdio: 'ignore' });
      try {
        const fingerprint = await fingerprintForPid(leader.pid);
        if (fingerprint.kind === 'none') { t.skip('no process fingerprint on this platform'); return; }
        for (let i = 0; i < 50 && !existsSync(pidfile); i += 1) await new Promise((r) => { setTimeout(r, 100); });
        const grandchild = Number(readFileSync(pidfile, 'utf8'));
        const deadDriver = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
        const lock = L.worktreeLockPath(work);
        mkdirSync(lock, { recursive: true });
        writeFileSync(join(lock, `h-${deadDriver}-dddd.json`), JSON.stringify({
          run_id: 'autopilot-20261001T000000Z-dddddd', macro_id: fx.macroId, pid: Number(deadDriver), fingerprint: { kind: 'none' },
          worker: { pid: leader.pid, fingerprint },
        }));
        const r = await main(['stop'], env, work);
        strictEqual(r.code, 0, r.err + r.out);
        ok(/process group is empty \(killed\)/.test(r.out), r.out);
        ok(!alive(leader.pid), 'the worker is gone');
        ok(!alive(grandchild), `grandchild ${grandchild}, which ignores SIGTERM, outlived a stop that reported success`);
      } finally {
        try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* gone */ }
      }
    });
  });
});

describe('the runbook, as written', () => {
  const blocks = [...RUNBOOK.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  const preview = blocks.find((b) => b.includes('cli.mjs" --args-file') && !b.includes('MODELS'));
  const start = blocks.find((b) => b.includes('MODELS='));

  it('has the preview and the start block, both reading the args file', () => {
    // Contract: the runs below find the two blocks by these calls and fill in the
    // ARGS_DIR placeholder — a block the agent must edit first, before the root is
    // resolved and the CLI runs (args-file transport, then call order).
    ok(preview && start);
    for (const b of [preview, start]) {
      ok(b.startsWith("ARGS_DIR='<directory from step 1>'\n"), 'the args directory comes first');
      const resolver = b.indexOf('CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"');
      ok(resolver > 0 && resolver < b.indexOf('node "$CLAUDE_PLUGIN_ROOT/adapters/claude/autopilot/cli.mjs"'), 'the root is resolved before the CLI runs');
    }
  });

  for (const shell of ['bash', 'zsh']) {
    const available = spawnSync(shell, ['-c', 'exit 0']).status === 0;
    it(`${shell}: the preview block previews; the start block passes the model plan and the wall clock`, { skip: available ? false : `${shell} is not installed` }, async () => {
      await withRepo(async (fx, env, work) => {
        const argsDir = () => {
          const d = mkdtempSync(join(tmpdir(), 'agentic-args.'));
          return d;
        };
        const d1 = argsDir();
        writeFileSync(join(d1, 'args.json'), encodeArgsFile('preview --json'));
        const p = spawnSync(shell, ['-c', preview.replace("ARGS_DIR='<directory from step 1>'", `ARGS_DIR='${d1}'`)], { cwd: work, env, encoding: 'utf8' });
        strictEqual(p.status, 0, p.stderr);
        strictEqual(JSON.parse(p.stdout).decision.step.kind, 'dispatch');

        // The start block, with the model plan the owner chose and the
        // two-hour guard. The worker loads a mismatched engineer, so the run
        // stops at its first step's init.
        const d2 = argsDir();
        writeFileSync(join(d2, 'args.json'), encodeArgsFile('start --execute --max-steps 2'));
        const plugins = ['orchestrator', 'engineer', 'runtime'].map((name) => ({ name, path: { orchestrator: ORCH, engineer: ENG, runtime: RUNTIME }[name], source: `${name}@agentic-plugins`, version: name === 'engineer' ? '0.0.1' : version({ orchestrator: ORCH, runtime: RUNTIME }[name]) }));
        const script = start.replace("ARGS_DIR='<directory from step 1>'", `ARGS_DIR='${d2}'`).replace("MODELS=''", "MODELS='sonnet'");
        const s = spawnSync(shell, ['-c', script], { cwd: work, env: { ...env, FAKE_CLAUDE_MODE: 'precompact', FAKE_PLUGINS: JSON.stringify(plugins) }, encoding: 'utf8' });
        strictEqual(s.status, 2, s.stderr + s.stdout);
        const run = L.readRun(work, L.listRuns(work).at(-1)).run;
        deepStrictEqual([run.options.model_plan, run.options.max_time_sec, run.options.max_steps, run.halt.reason], ['sonnet', 7000, 2, 'version-drift']);
        const argv = JSON.parse(readFileSync(join(fx.dir, 'claude.log'), 'utf8').trim().split('\n')[0]).argv;
        strictEqual(argv[argv.indexOf('--model') + 1], 'sonnet');
      });
    });
  }
});

describe('the launcher', () => {

  it('finds the newest installed orchestrator that ships the autopilot', () => {
    const home = mkdtempSync(join(tmpdir(), 'autopilot-launcher-'));
    try {
      const base = join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'orchestrator');
      const make = (v, { entry = true, name = 'orchestrator' } = {}) => {
        const root = join(base, v);
        mkdirSync(join(root, '.claude-plugin'), { recursive: true });
        writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: v }));
        if (entry) {
          mkdirSync(join(root, 'adapters', 'claude', 'autopilot'), { recursive: true });
          writeFileSync(join(root, 'adapters', 'claude', 'autopilot', 'cli.mjs'), '');
        }
        return root;
      };
      strictEqual(findOrchestrator({}, home).error.includes('ships the autopilot'), true);
      make('0.9.0');
      const want = make('0.17.0');
      make('0.18.0', { entry: false });
      make('0.20.0', { name: 'engineer' });
      mkdirSync(join(base, '0.30.0-rc1'));
      deepStrictEqual(findOrchestrator({}, home), { root: want });
      ok(findOrchestrator({ AGENTIC_ORCHESTRATOR_ROOT: 'relative/path' }, home).error.includes('AGENTIC_ORCHESTRATOR_ROOT'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('runs as an installed, extensionless executable and hands over argv and the exit code', () => {
    const bin = mkdtempSync(join(tmpdir(), 'autopilot-bin-'));
    try {
      const installed = join(bin, 'agentic-autopilot');
      cpSync(join(AP, 'launcher.template.mjs'), installed);
      chmodSync(installed, 0o755);
      const help = spawnSync(installed, ['--help'], { env: { ...process.env, AGENTIC_ORCHESTRATOR_ROOT: ORCH }, encoding: 'utf8' });
      strictEqual(help.status, 0, help.stderr);
      ok(help.stdout.startsWith('Usage: autopilot'));
      const bad = spawnSync(installed, ['bogus'], { env: { ...process.env, AGENTIC_ORCHESTRATOR_ROOT: ORCH }, encoding: 'utf8' });
      strictEqual(bad.status, 1);
      ok(/unknown subcommand/.test(bad.stderr));
      ok(/ships the autopilot/.test(spawnSync(installed, [], { env: { ...process.env, AGENTIC_ORCHESTRATOR_ROOT: '', HOME: bin }, encoding: 'utf8' }).stderr));
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('the template is executable, and importing it runs nothing', () => {
    ok(execFileSync('ls', ['-l', join(AP, 'launcher.template.mjs')], { encoding: 'utf8' }).startsWith('-rwx'));
  });
});
