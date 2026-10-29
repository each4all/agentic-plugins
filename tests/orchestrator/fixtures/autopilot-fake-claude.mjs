#!/usr/bin/env node
// A stand-in for `claude -p --input-format stream-json --output-format
// stream-json …`, for the autopilot tests (AUTOPILOT_CLAUDE_BIN). It never
// calls a model. FAKE_CLAUDE_MODE picks the shape of the stream:
//
//   simple      init, one assistant message, one result
//   background  a result while a background task is pending, then the task's
//               notification and a follow-up turn (probe D2)
//   background-slow  the same, with the task running 3 s and the follow-up
//               turn 2.5 s after its notification — both longer than the
//               host's 2 s close debounce
//   precompact  a PreCompact hook event, then hang until killed
//   hang        start a grandchild in this process group (its pid goes to
//               FAKE_CLAUDE_PIDFILE), then hang until killed
//   stubborn    the same, with a grandchild that ignores SIGTERM
//   deaf        ignore SIGTERM itself (its pid goes to FAKE_CLAUDE_PIDFILE),
//               then hang until killed
//   leaves-child  a result, after starting a grandchild in this process group
//               that outlives this process (its pid goes to FAKE_CLAUDE_PIDFILE);
//               this process exits when stdin closes
//   pipe-holder a result, then a descendant in its own process group that
//               keeps this process's stdout and stderr open (its pid goes to
//               FAKE_CLAUDE_PIDFILE); this process exits when stdin closes
//   subagent    a subagent message with a large context, a main message with
//               a small one
//   two-models  main-thread messages from two models with different windows
//   noresult    exit 3 without a result
//   script      delegate the step to FAKE_WORKER_SCRIPT (a module whose
//               `perform({prompt, cwd, env})` does the step with the real
//               state CLIs and returns {report, cost})
//   background-forever  a background task that never ends (a grandchild in
//               this process group, its pid to FAKE_CLAUDE_PIDFILE, listed in
//               background_tasks_changed), then a result with FAKE_REPORT
//   events      FAKE_EVENTS, a JSON array of {delay, event} emitted in order,
//               each `delay` ms after the one before; an event {result,
//               cost} emits a result with that report (no cost when `cost`
//               is null); an event {exit, holdPipes} exits with that code,
//               first leaving a descendant in its own group that holds the
//               output pipes (its pid to FAKE_CLAUDE_PIDFILE) when holdPipes
//
// FAKE_IGNORE_STDIN_CLOSE=1: stdin closing does not end this process.
// FAKE_BUSY_CHILD=1: after init, a child in this process group that burns CPU
// for up to a minute (its pid to FAKE_CLAUDE_PIDFILE): quiet but busy.
// FAKE_IGNORE_SIGTERM=1: this process ignores SIGTERM.
//
// FAKE_MODEL_USAGE, a JSON object, replaces the result's `modelUsage` (the
// real CLI keys it by model, a 1M-token window as `<model>[1m]`).
//
// Every start appends {argv, env, cwd, locks} to FAKE_CLAUDE_LOG when it is
// set; `locks` holds the entries of the driven checkout's worktree lock as the
// worker finds them.
// `--version` and `--help` answer like the real CLI does for preflight.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write('9.9.9 (Fake Claude)\n');
  process.exit(0);
}
if (argv[0] === '--help') {
  process.stdout.write('--input-format --output-format --permission-prompts --include-hook-events --max-budget-usd --json-schema\n');
  process.exit(0);
}
if (process.env.FAKE_CLAUDE_LOG) {
  const lockDir = `${process.cwd()}/.agentic-plugins/runs/autopilot/worktree.lock`;
  let locks = [];
  try {
    locks = fs.readdirSync(lockDir).filter((n) => n.endsWith('.json')).sort()
      .map((n) => JSON.parse(fs.readFileSync(`${lockDir}/${n}`, 'utf8')));
  } catch { /* no lock there */ }
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ argv, env: process.env, cwd: process.cwd(), locks })}\n`);
}

const mode = process.env.FAKE_CLAUDE_MODE || 'simple';
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const model = 'fake-model';
const usage = (n) => ({ input_tokens: 10, cache_creation_input_tokens: n, cache_read_input_tokens: 0, output_tokens: 5 });
const defaultReport = {
  outcome: 'completed', workflow: null, next_step: null, awaiting_owner: null, summary: 'fake step', waiting_on_background: false,
};
const report = process.env.FAKE_REPORT ? JSON.parse(process.env.FAKE_REPORT) : defaultReport;
// background modes: the report of the turn that ends while the task is
// pending — by default the provisional one the worker prompt asks for.
const firstReport = process.env.FAKE_FIRST_REPORT
  ? JSON.parse(process.env.FAKE_FIRST_REPORT)
  : { ...defaultReport, outcome: 'failed', summary: 'provisional: waiting for t1', waiting_on_background: true };
const plugins = process.env.FAKE_PLUGINS ? JSON.parse(process.env.FAKE_PLUGINS) : [];
const result = (cost, structured = report) => ({
  type: 'result', subtype: 'success', is_error: false, ...(cost === null ? {} : { total_cost_usd: cost }), num_turns: 1,
  modelUsage: process.env.FAKE_MODEL_USAGE ? JSON.parse(process.env.FAKE_MODEL_USAGE)
    : { [model]: { contextWindow: 1000000 }, 'fake-subagent-model': { contextWindow: 200000 } },
  permission_denials: [], structured_output: structured,
});
if (process.env.FAKE_IGNORE_SIGTERM === '1') process.on('SIGTERM', () => {});

let started = false;
readline.createInterface({ input: process.stdin })
  .on('line', async (line) => {
    if (started) return;
    started = true;
    const prompt = JSON.parse(line).message.content[0].text;
    emit({ type: 'system', subtype: 'init', model, tools: [], plugins, cwd: process.cwd() });
    // FAKE_RATE_LIMIT: a rate_limit_info object, or an array of them, emitted
    // as rate_limit_events after init (the real CLI sends one with its first
    // model response).
    if (process.env.FAKE_RATE_LIMIT) {
      const infos = [JSON.parse(process.env.FAKE_RATE_LIMIT)].flat();
      for (const info of infos) emit({ type: 'rate_limit_event', rate_limit_info: info, uuid: 'fake', session_id: 'fake' });
    }
    if (process.env.FAKE_BUSY_CHILD === '1') {
      const busy = spawn(process.execPath, ['-e', 'const end = Date.now() + 60000; while (Date.now() < end) {}'], { stdio: 'ignore' });
      if (process.env.FAKE_CLAUDE_PIDFILE) fs.writeFileSync(process.env.FAKE_CLAUDE_PIDFILE, String(busy.pid));
    }
    if (mode === 'noresult') process.exit(3);
    emit({ type: 'assistant', message: { model, usage: usage(40000), content: [] } });
    if (mode === 'background' || mode === 'background-slow') {
      const slow = mode === 'background-slow';
      emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1' }] });
      emit(result(0.10, firstReport));
      setTimeout(() => {
        emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
        emit({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed' });
        setTimeout(() => {
          emit({ type: 'assistant', message: { model, usage: usage(52000), content: [] } });
          emit(result(0.15));
        }, slow ? 2500 : 300);
      }, slow ? 3000 : 500);
    } else if (mode === 'background-forever') {
      const task = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      if (process.env.FAKE_CLAUDE_PIDFILE) fs.writeFileSync(process.env.FAKE_CLAUDE_PIDFILE, String(task.pid));
      emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bt1', run_id: 'r-bt1', task_type: 'local_bash', description: 'Run the full suite in background' }] });
      emit(result(0.12));
    } else if (mode === 'events') {
      for (const { delay = 0, event } of JSON.parse(process.env.FAKE_EVENTS ?? '[]')) {
        await new Promise((r) => { setTimeout(r, delay); });
        if (event && Object.hasOwn(event, 'result')) emit(result(event.cost === undefined ? 0.05 : event.cost, event.result));
        else if (event && Object.hasOwn(event, 'exit')) {
          if (event.holdPipes) {
            const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
            if (process.env.FAKE_CLAUDE_PIDFILE) fs.writeFileSync(process.env.FAKE_CLAUDE_PIDFILE, String(holder.pid));
            holder.unref();
          }
          process.exit(event.exit);
        } else emit(event);
      }
    } else if (mode === 'precompact') {
      emit({ type: 'system', subtype: 'hook_started', hook_event: 'PreCompact', hook_name: 'PreCompact' });
      setInterval(() => {}, 1000);
    } else if (mode === 'hang' || mode === 'stubborn') {
      const code = mode === 'stubborn' ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)" : 'setInterval(() => {}, 1000)';
      const grandchild = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
      // Give the grandchild time to install its handler before the pid is
      // reported (and before a timeout can signal it).
      setTimeout(() => fs.writeFileSync(process.env.FAKE_CLAUDE_PIDFILE, String(grandchild.pid)), 300);
      setInterval(() => {}, 1000);
    } else if (mode === 'deaf') {
      process.on('SIGTERM', () => {});
      fs.writeFileSync(process.env.FAKE_CLAUDE_PIDFILE, String(process.pid));
      setInterval(() => {}, 1000);
    } else if (mode === 'leaves-child') {
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(process.env.FAKE_CLAUDE_PIDFILE, String(grandchild.pid));
      grandchild.unref();
      emit(result(0.05));
    } else if (mode === 'pipe-holder') {
      const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
      fs.writeFileSync(process.env.FAKE_CLAUDE_PIDFILE, String(holder.pid));
      holder.unref();
      emit(result(0.05));
    } else if (mode === 'two-models') {
      emit({ type: 'assistant', message: { model: 'fake-subagent-model', usage: usage(52000), content: [] } });
      emit(result(0.06));
    } else if (mode === 'subagent') {
      emit({ type: 'assistant', parent_tool_use_id: 'toolu_x', message: { model: 'fake-subagent-model', usage: usage(190000), content: [] } });
      emit(result(0.07));
    } else if (mode === 'script') {
      try {
        const m = await import(process.env.FAKE_WORKER_SCRIPT);
        const r = await m.perform({ prompt, cwd: process.cwd(), env: process.env });
        // `background`: tasks still pending at the result, one of them a
        // grandchild in this process group that never ends.
        if (Array.isArray(r.background)) {
          spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
          emit({ type: 'system', subtype: 'background_tasks_changed', tasks: r.background });
        }
        emit(result(r.cost ?? 0.01, r.report ?? defaultReport));
      } catch (err) {
        process.stderr.write(`fake worker: ${err.stack ?? err}\n`);
        emit({ type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0.01 });
      }
    } else {
      emit(result(0.05));
    }
  })
  .on('close', () => {
    emit({ type: 'system', subtype: 'fake_stdin_closed' });
    if (process.env.FAKE_IGNORE_STDIN_CLOSE === '1') {
      setInterval(() => {}, 1000);
      return;
    }
    setTimeout(() => process.exit(0), 20);
  });
