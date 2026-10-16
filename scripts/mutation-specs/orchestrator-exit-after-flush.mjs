// Mutation spec — do the orchestrator CLIs' exit-after-flush tests catch the
// defects they exist for (the owner's discussion-2 decision R2)?
//
// Run: npm run mutate -- scripts/mutation-specs/orchestrator-exit-after-flush.mjs
//
// The orchestrator's CLIs and hooks import its copy of the helper,
// plugins/orchestrator/scripts/lib/cli-entry.mjs (the persona-pipeline source
// byte for byte under a copy notice; the helper's own rules are mutated in
// scripts/mutation-specs/persona-exit-after-flush.mjs, and the copy runs the
// same behaviour tests). The installed autopilot launcher is one standalone
// file and carries its own inline helper. Each defect goes into the
// orchestrator's file directly:
//
//   M  an entry tail exits at once again (exitAfterFlush(code) back to
//      process.exit(code)), or the launcher's inline helper exits before the
//      flush, each killed by that CLI's own pipe regression;
//   S  a structural rule: the copy drifts from its source, a session-start
//      hook no longer absorbs an early EPIPE, the launcher's discovery error
//      runs on past its exit, the launcher drops its signal handlers when the
//      entry exits, dispatch-peer's help path goes on to dispatch;
//   C  a control: a comment edit (expect SURVIVED).
//
// Every pipe regression writes more than a pipe's buffer takes at once:
// 65,536 bytes on macOS and 146,176 on Linux (Node 24, measured).
//
// Not here: the discover CLIs' tails. Their output is a line or a small JSON
// object, which a pipe always takes at once, so no test can open the window a
// mutation would need; the parity test holds that they exit through the copy.

const T_FLUSH = 'tests/persona-pipeline/test-exit-after-flush.mjs';
const T_PARITY = 'tests/scripts/test-orchestrator-peer-snapshot-parity.mjs';
const T_DISPATCH = 'tests/orchestrator/test-dispatch-peer.mjs';
const T_PEER = 'tests/orchestrator/test-peer-runner.mjs';
const T_HANDOFF = 'tests/orchestrator/test-session-handoff.mjs';
const T_HOOKS = 'tests/orchestrator/test-hooks.mjs';
const T_LAUNCHER = 'tests/orchestrator/test-autopilot-cli.mjs';

export const TESTS = [T_FLUSH, T_PARITY];

const ORCH = 'plugins/orchestrator';
const LAUNCHER = `${ORCH}/adapters/claude/autopilot/launcher.template.mjs`;
const edit = (file, from, to) => (copy, tools) => tools.applyEdit(copy, { file, from, to });

export const MUTATIONS = [
  // ---- M: an entry tail exits before the pipe drained ------------------------
  {
    id: 'M1', tests: [T_DISPATCH],
    prepare: edit(`${ORCH}/scripts/dispatch-peer.mjs`, '  exitAfterFlush(code);\n', '  process.exit(code);\n'),
    why: "dispatch-peer exits as soon as it has written the companion output: a reader gets only what the pipe's buffer took",
    killed_by: [/text mode passes a companion stdout over 64 KiB through a pipe whole/, /json mode passes an envelope over 64 KiB through a pipe whole/],
  },
  {
    id: 'M2', tests: [T_PEER],
    prepare: edit(`${ORCH}/scripts/peer-runner.mjs`, '  exitAfterFlush(code);\n', '  process.exit(code);\n'),
    why: 'peer-runner exits as soon as it has written a sweep report that grows with the ledger',
    killed_by: /sweep previews the retention of a large ledger, and the reader gets the whole report/,
  },
  {
    id: 'M3', tests: [T_HANDOFF],
    prepare: edit(`${ORCH}/scripts/session-handoff.mjs`, '    exitAfterFlush(code);\n', '    process.exit(code);\n'),
    why: 'session-handoff exits as soon as it has written a projection that carries next_action and checkpoint text without a bound',
    killed_by: /prints a macro whose next_action is over 64 KiB as whole, parseable JSON/,
  },
  {
    id: 'M4', tests: [T_LAUNCHER],
    prepare: edit(LAUNCHER, '  exitFlushStarted = true;\n', '  exitFlushStarted = true;\n  process.exit(code);\n'),
    why: "the installed launcher's inline helper exits at once: a diagnostic past a pipe's buffer is cut",
    killed_by: /a diagnostic past a pipe's buffer reaches the reader whole/,
  },

  // ---- S: structural rules ---------------------------------------------------
  {
    id: 'S1', tests: [T_PARITY],
    prepare: edit(`${ORCH}/scripts/lib/cli-entry.mjs`, '/** How long exitAfterFlush waits for a reader before it exits anyway. */\n', '/** How long exitAfterFlush waits for a reader before it exits regardless. */\n'),
    why: 'the copy drifts from the persona-pipeline source',
    killed_by: /plugins\/orchestrator\/scripts\/lib\/cli-entry\.mjs is its notice, then the source byte for byte/,
  },
  {
    id: 'S2', tests: [T_HOOKS],
    prepare: edit(`${ORCH}/adapters/claude/hooks/session-start.mjs`, '\nabsorbOutputErrors();\nconst code = await main();\n', '\nconst code = await main();\n'),
    why: 'the Claude session-start hook no longer absorbs an EPIPE before its tail: an early-closed reader kills it with a stack',
    killed_by: /Claude hook: exits 0 with no EPIPE stack when stdout is closed before it writes/,
  },
  {
    id: 'S3', tests: [T_HOOKS],
    prepare: edit(`${ORCH}/adapters/codex/hooks/session-start.mjs`, '\nabsorbOutputErrors();\nconst code = await main();\n', '\nconst code = await main();\n'),
    why: 'the Codex session-start hook no longer absorbs an EPIPE before its tail: an early-closed reader kills it with a stack',
    killed_by: /Codex hook: exits 0 with no EPIPE stack when stdout is closed before it writes/,
  },
  {
    id: 'S4', tests: [T_LAUNCHER],
    prepare: edit(LAUNCHER, '    exitAfterFlush(1);\n    return;\n  }\n', '    exitAfterFlush(1);\n  }\n'),
    why: "the launcher's discovery error runs on past its exit, into spawning a root it does not have",
    killed_by: /a discovery error prints its one diagnostic, exits 1 and runs nothing past it/,
  },
  {
    id: 'S5', tests: [T_LAUNCHER],
    prepare: edit(LAUNCHER,
      "  child.on('exit', (code, signal) => {\n",
      "  child.on('exit', (code, signal) => {\n    for (const s of ['SIGINT', 'SIGTERM']) process.removeAllListeners(s);\n"),
    why: 'the launcher drops its signal handlers when the entry exits: a signal while the output drains kills it',
    killed_by: /a signal while the output drains leaves the entry's code as it is/,
  },
  {
    id: 'S6', tests: [T_DISPATCH],
    prepare: edit(`${ORCH}/scripts/dispatch-peer.mjs`, '    printHelp();\n    return 0;\n', '    printHelp();\n'),
    why: '--help with a peer and a prompt prints help and then dispatches',
    killed_by: /--help with a peer and a prompt prints help, exits 0 and resolves no companion/,
  },

  // ---- C: control -------------------------------------------------------------
  {
    id: 'C1', tests: [T_DISPATCH, T_PARITY],
    prepare: edit(`${ORCH}/scripts/dispatch-peer.mjs`,
      '// Run as a CLI only when this file is the entry point. A refusal dispatchPeer\n',
      '// Run as a CLI only when this file is the entry point; a refusal dispatchPeer\n'),
    why: 'a comment edit changes nothing a test reads',
    expect: 'SURVIVED',
  },
];
