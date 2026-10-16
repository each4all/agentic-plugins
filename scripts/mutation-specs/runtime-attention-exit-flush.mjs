// Mutation spec — do the exit-after-flush tests catch the defects they exist
// for (R2)?
//
// Run: npm run mutate -- scripts/mutation-specs/runtime-attention-exit-flush.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. An exit that drops buffered output fails
// quietly: anything a pipe or socket buffer holds still arrives whole, and a
// test that reads a small report passes against the defect. T restores the
// defect at each CLI's own tail, where it lived, so each regression is shown to
// catch it at the CLI under test and not in its fixture: a bare
// `process.exit(code)` (truncation), and `process.exitCode` alone (a probe
// child that ignores SIGTERM holds the CLI open). M moves an exit back into
// the middle of a function, or lets help fall through into work, which the
// exit code and stdout alone do not show. G breaks the R2 handling of a
// mutating command still running after its timeout (settings): its result,
// its classification, its per-host follow-up, the block on its host's further
// commands (both executors), the hold on every command the report offers on
// that host, and the CLI's wait for it after the report or a failure. S
// covers the statusline's inline copy and its released-shape registration. H
// breaks one rule of the helper at a time, once per package copy (R runtime,
// A attention): each case names the one test built to catch it.
//
// NOT SCORED, on purpose:
//   - the SessionStart and Stop hook tails and the statusline tail
//     (`exitAfterFlush(0)` → `process.exit(0)`): each writes one bounded line
//     at most (a brief line, nothing, a status line under 512 bytes), which a
//     pipe always takes whole, so the two tails are equivalent today and no
//     test can tell them apart. Their tests hold the contract (exit 0, silent).
//   - the statusline helper's behaviour: it is held byte-equal to the runtime
//     copy (S1), whose behaviour the R cases score.

const T_HELPER_RUNTIME = 'tests/runtime/test-exit-after-flush.mjs';
const T_BOOTSTRAP = 'tests/runtime/test-bootstrap-exit-flush.mjs';
const T_DOCTOR_SETTINGS = 'tests/runtime/test-doctor-settings-exit-flush.mjs';
const T_STATUSLINE = 'tests/runtime/test-statusline-plan.mjs';
const T_RECEIVERS = 'tests/runtime/test-receiver-inventory.mjs';
const T_ATTENTION = 'tests/attention/test-exit-after-flush.mjs';

const BOOTSTRAP = 'plugins/runtime/scripts/bootstrap.mjs';
const DOCTOR = 'plugins/runtime/scripts/doctor.mjs';
const SETTINGS = 'plugins/runtime/scripts/settings.mjs';
const STATUSLINE = 'plugins/runtime/receivers/agentic-statusline.mjs';
const SHAPES = 'plugins/runtime/data/released-receiver-shapes.json';
const INVENTORY = 'plugins/runtime/scripts/lib/receiver-inventory.mjs';
const PLAN = 'plugins/runtime/scripts/lib/plugin-management-plan.mjs';
const LIB_RUNTIME = 'plugins/runtime/scripts/lib/exit-after-flush.mjs';
const LIB_ATTENTION = 'plugins/attention/scripts/lib/exit-after-flush.mjs';
const DISCOVER = 'plugins/attention/scripts/discover-runtime.mjs';

export const TESTS = [T_HELPER_RUNTIME, T_BOOTSTRAP, T_DOCTOR_SETTINGS, T_STATUSLINE, T_RECEIVERS, T_ATTENTION];

const TAIL_FROM = '(code) => exitAfterFlush(code),';
const TAIL_EXIT = '(code) => process.exit(code),';
const TAIL_EXIT_CODE = '(code) => { process.exitCode = code; },';

const helperMutations = (prefix, file, test) => [
  {
    id: `${prefix}-H1`, file, tests: [test],
    from: '  setTimeout(exit, fallbackMs);\n',
    to: '',
    why: 'no fallback timer: a reader that never drains holds the process forever',
    killed_by: [/exits by the fallback, with the code, when the reader never drains/],
  },
  {
    id: `${prefix}-H2`, file, tests: [test],
    from: "    stream.once('error', exit);\n",
    to: "    if (stream !== process.stdout) stream.once('error', exit);\n",
    why: 'no error listener on stdout: an EPIPE from a stdout reader that closed early crashes with exit 1',
    killed_by: [/exits with the code when the reader of stdout closed early/],
  },
  {
    id: `${prefix}-H7`, file, tests: [test],
    from: "    stream.once('error', exit);\n",
    to: "    if (stream !== process.stderr) stream.once('error', exit);\n",
    why: 'no error listener on stderr: an EPIPE from a stderr reader that closed early crashes with exit 1',
    killed_by: [/exits with the code when the reader of stderr closed early/],
  },
  {
    id: `${prefix}-H8`, file, tests: [test],
    from: 'export function exitAfterFlush(code, fallbackMs = EXIT_FLUSH_FALLBACK_MS) {',
    to: 'export function exitAfterFlush(code, fallbackMs = 1_000) {',
    why: 'the default fallback is not the exported 10 s',
    killed_by: [/the fallback defaults to EXIT_FLUSH_FALLBACK_MS/],
  },
  {
    id: `${prefix}-H9`, file, tests: [test],
    from: '  setTimeout(exit, fallbackMs);\n',
    to: '  setTimeout(exit, fallbackMs * 2);\n',
    why: 'the fallback fires later than the delay it was given',
    killed_by: [/exits by the fallback, with the code, when the reader never drains/],
  },
  {
    id: `${prefix}-H3`, file, tests: [test],
    from: '  if (exitFlushStarted) return;\n',
    to: '',
    why: 'a second call while flushing is not ignored: its code and fallback win',
    killed_by: [/a second call while flushing is ignored/],
  },
  {
    id: `${prefix}-H4`, file, tests: [test],
    from: "      stream.write('', settle);\n",
    to: '      settle();\n',
    why: 'exits at once instead of waiting for the streams to flush',
    killed_by: [/reach a reader that drains late, whole/],
  },
  {
    id: `${prefix}-H5`, file, tests: [test],
    from: '  let pending = 2;\n  const settle = () => {\n    pending -= 1;\n    if (pending === 0) exit();\n  };\n  for (const stream of [process.stdout, process.stderr]) {',
    to: '  let pending = 1;\n  const settle = () => {\n    pending -= 1;\n    if (pending === 0) exit();\n  };\n  for (const stream of [process.stdout]) {',
    why: 'waits for stdout only, so buffered stderr is dropped',
    killed_by: [/waits for stderr as well/],
  },
  {
    id: `${prefix}-H6`, file, tests: [test],
    from: '  setTimeout(exit, fallbackMs);\n',
    to: '  setTimeout(exit, fallbackMs).unref();\n',
    why: 'an unref\'d fallback: with nothing else holding the loop the process ends with 0, not the code',
    killed_by: [/the fallback timer is ref'd/],
  },
];

export const MUTATIONS = [
  // ---- T: the defect restored at each CLI's tail --------------------------
  {
    id: 'T-B1', file: BOOTSTRAP, tests: [T_BOOTSTRAP],
    from: TAIL_FROM, to: TAIL_EXIT,
    why: 'bootstrap exits as soon as main() returns, dropping a report past the pipe buffer',
    killed_by: [/\(i\) a plan report past 1 MiB reaches a pipe reader whole and parses/],
  },
  {
    id: 'T-B2', file: BOOTSTRAP, tests: [T_BOOTSTRAP],
    from: TAIL_FROM, to: TAIL_EXIT_CODE,
    why: 'bootstrap ends with process.exitCode alone, so a probe child that ignores SIGTERM holds it open',
    killed_by: [/\(ii\) exits with a whole report while a probe child that ignores SIGTERM outlives its timeout/],
  },
  {
    id: 'T-D1', file: DOCTOR, tests: [T_DOCTOR_SETTINGS],
    from: "    process.stderr.write(`${err.message}\\n${usage()}`);\n    return EXIT.INVALID;\n",
    to: "    process.stderr.write(`${err.message}\\n${usage()}`);\n    process.exit(EXIT.INVALID);\n",
    why: 'doctor exits right after a usage error that echoes the argument, cutting it at the pipe buffer',
    killed_by: [/runtime:doctor CLI — exit after stdout and stderr flush \(R2\) > a usage error echoing a 1 MB argument/],
  },
  {
    id: 'T-D2', file: DOCTOR, tests: [T_DOCTOR_SETTINGS],
    from: TAIL_FROM, to: TAIL_EXIT_CODE,
    why: 'doctor ends with process.exitCode alone (its old report path), so a probe child that ignores SIGTERM holds it open',
    killed_by: [/runtime:doctor CLI — exits while a probe child that ignores SIGTERM outlives its timeout/],
  },
  {
    id: 'T-S1', file: SETTINGS, tests: [T_DOCTOR_SETTINGS],
    from: "    process.stderr.write(`${err.message}\\n${usage()}`);\n    return 2;\n",
    to: "    process.stderr.write(`${err.message}\\n${usage()}`);\n    process.exit(2);\n",
    why: 'settings exits right after a usage error that echoes the argument, cutting it at the pipe buffer',
    killed_by: [/runtime:settings CLI — exit after stdout and stderr flush \(R2\) > a usage error echoing a 1 MB argument/],
  },
  {
    id: 'T-S2', file: SETTINGS, tests: [T_DOCTOR_SETTINGS],
    from: TAIL_FROM, to: TAIL_EXIT_CODE,
    why: 'settings waits for every live handle (its old natural exit), so a probe child that ignores SIGTERM holds it open',
    killed_by: [/runtime:settings CLI — exits while a probe child that ignores SIGTERM outlives its timeout/],
  },
  {
    id: 'T-A1', file: DISCOVER, tests: [T_ATTENTION],
    from: '(code) => exitAfterFlush(code ?? 0),', to: '(code) => process.exit(code ?? 0),',
    why: 'discover-runtime exits as soon as cliMain() returns, cutting a diagnostic that echoes a long flag',
    killed_by: [/the unknown-flag diagnostic reaches a late pipe reader whole/],
  },

  // ---- M: work after help or a refusal -------------------------------------
  {
    id: 'M-D1', file: DOCTOR, tests: [T_DOCTOR_SETTINGS],
    from: '    process.stdout.write(usage());\n    return EXIT.OK;\n',
    to: '    process.stdout.write(usage());\n',
    why: 'doctor --help falls through into the diagnosis, starting host CLIs and recording an artifact',
    killed_by: [/runtime:doctor CLI — nothing runs after help or a refusal \(R2\) > --help beside proof and record flags/],
  },
  {
    id: 'M-S1', file: SETTINGS, tests: [T_DOCTOR_SETTINGS],
    from: '    process.stdout.write(usage());\n    return 0;\n',
    to: '    process.stdout.write(usage());\n',
    why: 'settings --help falls through into apply and execute, starting host CLIs and writing config',
    killed_by: [/runtime:settings CLI — nothing runs after help or a refusal \(R2\) > --help beside apply and execute flags/],
  },

  // ---- G: a mutating command still running after its timeout ---------------
  {
    id: 'G1', file: DOCTOR, tests: [T_DOCTOR_SETTINGS],
    from: "      const grace = setTimeout(() => resolvePromise(Object.defineProperty(timedOut(true), 'closed', { value: closed })), closeGraceMs);\n      closed.then(() => {\n        clearTimeout(grace);\n        resolvePromise(timedOut(false));\n      });\n",
    to: '      resolvePromise(timedOut(false));\n',
    why: 'runCommand does not wait the grace for close, so a child still running reads as gone',
    killed_by: [/with closeGraceMs, reports the child still running and its pid once the grace passes/],
  },
  {
    id: 'G2', file: SETTINGS, tests: [T_DOCTOR_SETTINGS],
    from: '  if (result.child_running === true) {\n',
    to: '  if (false) {\n',
    why: 'a command still running after its timeout is classified a plain, retryable timeout',
    killed_by: [/reports the live child and its pid, not retryable/],
  },
  {
    id: 'G3', file: SETTINGS, tests: [T_DOCTOR_SETTINGS],
    from: '    const result = await runner(plan.argv.command, plan.argv.args, { cwd, env, timeoutMs, closeGraceMs: MUTATING_COMMAND_CLOSE_GRACE_MS });\n    trackStillRunningCommand(stillRunningCommands, plan.host, result);\n    const completedAt = new Date();\n    // ADR-0035 §6 post-verify',
    to: '    const result = await runner(plan.argv.command, plan.argv.args, { cwd, env, timeoutMs });\n    trackStillRunningCommand(stillRunningCommands, plan.host, result);\n    const completedAt = new Date();\n    // ADR-0035 §6 post-verify',
    why: 'the plugin-management command runs without the close grace, so a live child is never reported',
    killed_by: [/passes the close grace only to the mutating command/],
  },

  {
    id: 'G4', file: PLAN, tests: [T_DOCTOR_SETTINGS],
    from: '      && plan.result?.child_running !== true\n',
    to: '',
    why: 'a cleanup command still running is offered for a re-run that would race it',
    killed_by: [/names the pid to wait for and drops the re-run command/],
  },
  {
    id: 'G5', file: PLAN, tests: [T_DOCTOR_SETTINGS],
    from: "  followups.push(...stillRunningFollowups(plans, 'plugin-management'));\n",
    to: '',
    why: 'no follow-up names a plugin-management command still running',
    killed_by: [/reports the live child and its pid, not retryable/],
  },
  {
    id: 'G6', file: SETTINGS, tests: [T_DOCTOR_SETTINGS],
    from: '    await Promise.all(stillRunningCommands.map(({ closed }) => closed));\n',
    to: '',
    why: 'settings exits once its report flushed, closing the pipes of a mutating command still running, which dies at its next write',
    killed_by: [/reports the command still running, then exits only after it finished/],
  },
  {
    id: 'G7', file: PLAN, tests: [T_DOCTOR_SETTINGS],
    from: '      id: `${host}-${area}-command-still-running`,\n',
    to: '      id: `${area}-command-still-running`,\n',
    why: 'the per-host still-running follow-ups share an id, and the merge keeps only the first host',
    killed_by: [/with --host all, keeps one still-running follow-up per host in the merged report/],
  },
  {
    id: 'G8', file: SETTINGS, tests: [T_DOCTOR_SETTINGS],
    from: "    if (!stream.listeners('error').includes(ignoreOutputError)) stream.on('error', ignoreOutputError);\n",
    to: '',
    why: 'a reader closing stdout or stderr raises an unhandled EPIPE during the wait, which exits settings and cuts the command short',
    killed_by: [/a reader that closes stdout does not end the wait/, /a reader that closes stderr does not end the wait/],
  },
  {
    id: 'G9', file: SETTINGS, tests: [T_DOCTOR_SETTINGS],
    from: "    if (opts.format === 'json') {\n      process.stdout.write(`${JSON.stringify(report, null, 2)}\\n`);\n",
    to: "    await Promise.all(stillRunningCommands.map(({ closed }) => closed));\n    if (opts.format === 'json') {\n      process.stdout.write(`${JSON.stringify(report, null, 2)}\\n`);\n",
    why: 'settings waits for the command before writing its report, so the operator sees nothing until it ends',
    killed_by: [/reports the command still running, then exits only after it finished/],
  },
  {
    id: 'G10', file: SETTINGS, tests: [T_DOCTOR_SETTINGS],
    from: '    const result = await runner(plan.argv.command, plan.argv.args, { cwd, env, timeoutMs, closeGraceMs: MUTATING_COMMAND_CLOSE_GRACE_MS });\n    trackStillRunningCommand(stillRunningCommands, plan.host, result);\n    const completedAt = new Date();\n    const semanticFailure',
    to: '    const result = await runner(plan.argv.command, plan.argv.args, { cwd, env, timeoutMs });\n    trackStillRunningCommand(stillRunningCommands, plan.host, result);\n    const completedAt = new Date();\n    const semanticFailure',
    why: 'the cleanup uninstall runs without the close grace, so a live child is never reported',
    killed_by: [/gives the uninstall the close grace, reports it still running, and starts no further uninstall/],
  },
  {
    id: 'G11', file: SETTINGS, tests: [T_DOCTOR_SETTINGS],
    from: '    const result = await runner(plan.argv.command, plan.argv.args, { cwd, env, timeoutMs, closeGraceMs: MUTATING_COMMAND_CLOSE_GRACE_MS });\n    trackStillRunningCommand(stillRunningCommands, plan.host, result);\n    const completedAt = new Date();\n    const semanticFailure',
    to: '    const result = await runner(plan.argv.command, plan.argv.args, { cwd, env, timeoutMs, closeGraceMs: MUTATING_COMMAND_CLOSE_GRACE_MS });\n    const completedAt = new Date();\n    const semanticFailure',
    why: 'a cleanup uninstall still running is not tracked: the next uninstall races it and the CLI does not wait for it',
    killed_by: [/gives the uninstall the close grace, reports it still running, and starts no further uninstall/],
  },
  {
    id: 'G12', file: SETTINGS, tests: [T_DOCTOR_SETTINGS],
    from: "    if (blockBehindStillRunningCommand(plan, stillRunningCommands)) {\n      if (onAction) await onAction(makeExecutionJournalEntry({ area: 'plugin-management', plan }));\n      continue;\n    }\n",
    to: '',
    why: 'the plugin-management executor starts the next command on a host whose earlier command is still running',
    killed_by: [/blocks the host's remaining plugin-management and cleanup commands/],
  },
  {
    id: 'G13', file: SETTINGS, tests: [T_DOCTOR_SETTINGS],
    from: "    if (blockBehindStillRunningCommand(plan, stillRunningCommands)) {\n      if (onAction) await onAction(makeExecutionJournalEntry({ area: 'plugin-cleanup', plan }));\n      continue;\n    }\n",
    to: '',
    why: 'the cleanup executor starts an uninstall on a host whose earlier command is still running',
    killed_by: [/blocks the host's remaining plugin-management and cleanup commands/, /starts no further uninstall/],
  },
  {
    id: 'G14', file: SETTINGS, tests: [T_DOCTOR_SETTINGS],
    from: "  } catch (err) {\n    ignoreOutputErrorsWhileWaiting(stillRunningCommands);\n    process.stderr.write(`runtime:settings failed: ${err.stack ?? err.message}\\n`);\n    code = 1;\n  }\n",
    to: '  } catch (err) {\n    throw err;\n  }\n',
    why: 'a failure after a command started exits at once (the tail), closing the pipes of the command still running',
    killed_by: [/a failure after the command started still waits for it, then exits 1/],
  },
  {
    id: 'G17', file: SETTINGS, tests: [T_DOCTOR_SETTINGS],
    from: "  } catch (err) {\n    ignoreOutputErrorsWhileWaiting(stillRunningCommands);\n",
    to: '  } catch (err) {\n',
    why: 'on a failure after a command started, a reader closing stderr raises an unhandled EPIPE during the wait, cutting the command short',
    killed_by: [/a failure after the command started, with a reader that closed stderr, still waits for it/],
  },
  {
    id: 'G15', file: PLAN, tests: [T_DOCTOR_SETTINGS],
    from: '      && plan.block_reason !== HOST_COMMAND_STILL_RUNNING\n  ));\n  if (cleanupPlans.length === 0) return running;\n',
    to: '  ));\n  if (cleanupPlans.length === 0) return running;\n',
    why: 'an uninstall not started behind a running command is reported again as a cleanup that could not be completed (held, since G18 holds its host)',
    killed_by: [/blocks the host's remaining plugin-management and cleanup commands/],
  },
  {
    id: 'G16', file: PLAN, tests: [T_DOCTOR_SETTINGS],
    from: '      && plan.block_reason !== HOST_COMMAND_STILL_RUNNING\n  ));\n  if (codexInstallBlocked.length > 0) {\n',
    to: '  ));\n  if (codexInstallBlocked.length > 0) {\n',
    why: 'a Codex install not started behind a running command is reported as unsafe by its install policy, with the command to run',
    killed_by: [/a Codex install not started behind a running command is not read as a policy block/],
  },
  {
    id: 'G18', file: SETTINGS, tests: [T_DOCTOR_SETTINGS],
    from: '    holdCommandsOnBusyHosts({\n      busyHosts: busyHostsOf(stillRunningCommands),\n',
    to: '    ({\n      busyHosts: busyHostsOf(stillRunningCommands),\n',
    why: 'nothing is held on a busy host: plans, recommendations and follow-ups offer commands that would race the one still running',
    killed_by: [/holds every Claude command/, /does not offer an earlier failed uninstall again while a later one is still running/],
  },
  {
    id: 'G19', file: SETTINGS, tests: [T_DOCTOR_SETTINGS],
    from: '    recommendations.push(plan.held_by_pids ? holdRecommendation(recommendation, plan.held_by_pids) : recommendation);\n',
    to: '    recommendations.push(recommendation);\n',
    why: 'the top-level cleanup recommendations still offer the uninstall on a busy host',
    killed_by: [/holds every Claude command/],
  },
  {
    id: 'G20', file: PLAN, tests: [T_DOCTOR_SETTINGS],
    from: '    followup.commands = [];\n',
    to: '',
    why: 'a follow-up on a busy host (an earlier failure, a cleanup not requested, an install-policy block) still offers its commands',
    killed_by: [/holds every Claude command/, /does not offer an earlier failed uninstall again/, /holds a Codex install-policy follow-up/],
  },
  {
    id: 'G21', file: PLAN, tests: [T_DOCTOR_SETTINGS],
    from: '  recommendation.command = null;\n',
    to: '',
    why: 'a recommendation on a busy host still carries its command',
    killed_by: [/holds every Claude command/],
  },
  {
    id: 'G24', file: PLAN, tests: [T_DOCTOR_SETTINGS],
    from: '  recommendation.argv = null;\n',
    to: '',
    why: 'a recommendation on a busy host still carries the argv of its command',
    killed_by: [/holds every Claude command/],
  },
  {
    id: 'G22', file: SETTINGS, tests: [T_DOCTOR_SETTINGS],
    from: "    const command = plan.command ? ` ${plan.held_by_pids ? 'held-command' : 'command'}=${plan.command}` : '';\n",
    to: "    const command = plan.command ? ` command=${plan.command}` : '';\n",
    why: 'the text output prints a held plugin-management plan as a command to run',
    killed_by: [/holds every Claude command/],
  },
  {
    id: 'G23', file: SETTINGS, tests: [T_DOCTOR_SETTINGS],
    from: "executed=${plan.executed}; ${plan.held_by_pids ? 'held-command' : 'command'}=${plan.command}`);\n",
    to: "executed=${plan.executed}; command=${plan.command}`);\n",
    why: 'the text output prints a held cleanup plan as a command to run',
    killed_by: [/holds every Claude command/, /does not offer an earlier failed uninstall again/],
  },

  // ---- S: the statusline's inline copy and its released shape --------------
  {
    id: 'S1', file: STATUSLINE, tests: [T_STATUSLINE],
    from: '  setTimeout(exit, fallbackMs);\n',
    to: '  setTimeout(exit, fallbackMs).unref();\n',
    why: 'the inline copy drifts from the runtime copy whose behaviour is tested',
    killed_by: [/the template's inline helper is the runtime lib's helper body/],
  },
  {
    id: 'S2', file: SHAPES, tests: [T_RECEIVERS],
    from: '"046631eed57a2fb084e8b4ddd6e1e4eda524cf122d5de18146f19d99fa161b90": "plugin-runtime-v0.92.0 … v0.97.4",\n      "70660a7d17591a15bf0955d0e6b4074d0e4315b13fdd05c120778fb6c0384092": "plugin-runtime-v0.98.0 … v0.103.1"\n',
    to: '"046631eed57a2fb084e8b4ddd6e1e4eda524cf122d5de18146f19d99fa161b90": "plugin-runtime-v0.92.0 … v0.97.4"\n',
    why: 'the outgoing v2 shape is not registered, so every installed v2 shim reads foreign after the release',
    killed_by: [/the outgoing v2 shim \(ending in a bare process\.exit\) is registered/],
  },
  {
    id: 'S3', file: INVENTORY, tests: [T_RECEIVERS],
    from: "  return typeof marker === 'string' && /\\bdelegating-shim v\\d+$/.test(marker);\n",
    to: '  return false;\n',
    why: 'the rollback guidance calls a delegating legacy shim self-contained',
    killed_by: [/does not call a delegating legacy shim self-contained/],
  },

  // ---- H: the helper, once per package copy --------------------------------
  ...helperMutations('R', LIB_RUNTIME, T_HELPER_RUNTIME),
  ...helperMutations('A', LIB_ATTENTION, T_ATTENTION),
];
