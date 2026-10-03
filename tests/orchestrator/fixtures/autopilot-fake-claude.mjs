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
//
// Every start appends {argv, env, cwd} to FAKE_CLAUDE_LOG when it is set.
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
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ argv, env: process.env, cwd: process.cwd() })}\n`);
}

const mode = process.env.FAKE_CLAUDE_MODE || 'simple';
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const model = 'fake-model';
const usage = (n) => ({ input_tokens: 10, cache_creation_input_tokens: n, cache_read_input_tokens: 0, output_tokens: 5 });
const defaultReport = {
  outcome: 'completed', workflow: null, next_step: null, awaiting_owner: null, summary: 'fake step',
};
const report = process.env.FAKE_REPORT ? JSON.parse(process.env.FAKE_REPORT) : defaultReport;
const plugins = process.env.FAKE_PLUGINS ? JSON.parse(process.env.FAKE_PLUGINS) : [];
const result = (cost, structured = report) => ({
  type: 'result', subtype: 'success', is_error: false, total_cost_usd: cost, num_turns: 1,
  modelUsage: { [model]: { contextWindow: 1000000 }, 'fake-subagent-model': { contextWindow: 200000 } },
  permission_denials: [], structured_output: structured,
});

let started = false;
readline.createInterface({ input: process.stdin })
  .on('line', async (line) => {
    if (started) return;
    started = true;
    const prompt = JSON.parse(line).message.content[0].text;
    emit({ type: 'system', subtype: 'init', model, tools: [], plugins, cwd: process.cwd() });
    if (mode === 'noresult') process.exit(3);
    emit({ type: 'assistant', message: { model, usage: usage(40000), content: [] } });
    if (mode === 'background' || mode === 'background-slow') {
      const slow = mode === 'background-slow';
      emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1' }] });
      emit(result(0.10));
      setTimeout(() => {
        emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
        emit({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed' });
        setTimeout(() => {
          emit({ type: 'assistant', message: { model, usage: usage(52000), content: [] } });
          emit(result(0.15));
        }, slow ? 2500 : 300);
      }, slow ? 3000 : 500);
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
    setTimeout(() => process.exit(0), 20);
  });
