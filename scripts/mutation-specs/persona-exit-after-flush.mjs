// Mutation spec — do the persona CLIs' exit-after-flush tests catch the
// defects they exist for (the owner's discussion-2 decision R2)?
//
// Run: npm run mutate -- scripts/mutation-specs/persona-exit-after-flush.mjs
//
// Each defect goes into the CANONICAL source under persona-pipeline/files and
// is regenerated into every persona, the way a real edit travels:
//
//   M  a CLI's entry tail exits at once again (exitAfterFlush(code) back to
//      process.exit(code)), each killed by that CLI's own pipe regression;
//   H  the helper (scripts/lib/cli-entry.mjs) loses one rule: stderr, the
//      code, the fallback, the 'error' listener, the second-call guard, the
//      ended-stream wait, the recorded error, absorbOutputErrors itself, the
//      error listener on a stream already finished; and
//      dispatch-peer's help path goes on to dispatch;
//   C  a control: a comment edit, regenerated everywhere (expect SURVIVED).
//
// Node writes a piped stdout asynchronously on macOS and on Linux alike; the
// pipe's buffer takes 65,536 bytes at once on macOS and 146,176 on Linux
// (Node 24, measured), and every regression writes more than either.
//
// Not here: peer-runner `run` holding its signal handlers through the flush.
// Its stdout is a result of about 1 KB, which a pipe always takes at once, so
// no test can open the window a mutation would need.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { MutationHarnessError } from '../mutation-harness.mjs';

const T_FLUSH = 'tests/persona-pipeline/test-exit-after-flush.mjs';
const T_DISPATCH = 'tests/persona-pipeline/test-dispatch-peer.mjs';
const T_PEER = 'tests/persona-pipeline/test-peer-runner.mjs';
const T_PHASE7 = 'tests/persona-pipeline/test-phase7-commit.mjs';
const T_SESSION = 'tests/persona-pipeline/test-session-start.mjs';
const T_SYNC = 'tests/persona-pipeline/test-sync-persona-pipeline.mjs';

export const TESTS = [T_FLUSH, T_SYNC];

function regenerate(copy) {
  try {
    execFileSync(process.execPath, [join(copy, 'scripts/sync-persona-pipeline.mjs'), '--write'], { cwd: copy, stdio: 'pipe' });
  } catch (err) {
    throw new MutationHarnessError(`regeneration failed in the copy: ${err.stderr?.toString() || err.message}`);
  }
}

// Edit a canonical file and regenerate every persona's copy.
const canonical = (rel, from, to) => (copy, tools) => {
  tools.applyEdit(copy, { file: `persona-pipeline/files/${rel}`, from, to });
  regenerate(copy);
};
const HELPER = 'scripts/lib/cli-entry.mjs';

export const MUTATIONS = [
  // ---- M: an entry tail exits before the pipe drained ------------------------
  {
    id: 'M1', tests: [T_DISPATCH, T_SYNC],
    prepare: canonical('scripts/dispatch-peer.mjs', '  exitAfterFlush(code);\n', '  process.exit(code);\n'),
    why: "dispatch-peer exits as soon as it has written the companion output: a reader gets only what the pipe's buffer took",
    killed_by: [/text mode passes a companion stdout over 64 KiB through a pipe whole/, /json mode passes an envelope over 64 KiB through a pipe whole/],
  },
  {
    id: 'M2', tests: [T_PEER, T_SYNC],
    prepare: canonical('scripts/peer-runner.mjs', '  exitAfterFlush(code);\n', '  process.exit(code);\n'),
    why: 'peer-runner exits as soon as it has written a sweep report that grows with the ledger',
    killed_by: /sweep previews the retention of a large ledger, and the reader gets the whole report/,
  },
  {
    id: 'M3', tests: [T_PHASE7, T_SYNC],
    prepare: canonical('scripts/phase7-commit.mjs', '    exitAfterFlush(code);\n', '    process.exit(code);\n'),
    why: 'phase7-commit exits as soon as it has written a plan that grows with the changed paths',
    killed_by: /plan mode lists 2,000 changed paths, and the reader gets the whole JSON/,
  },

  // ---- H: the helper loses one rule -----------------------------------------
  {
    id: 'H1', tests: [T_FLUSH],
    prepare: canonical(HELPER, '  streams = [process.stdout, process.stderr],\n', '  streams = [process.stdout],\n'),
    why: 'stderr is not waited for: a long diagnostic is cut',
    killed_by: /stdout and stderr over 64 KiB both reach the reader whole/,
  },
  {
    id: 'H2', tests: [T_FLUSH],
    prepare: canonical(HELPER, '    exit(code);\n', '    exit(0);\n'),
    why: 'every CLI exits 0, whatever its paths returned',
    killed_by: /a nonzero code is the exit status/,
  },
  {
    id: 'H3', tests: [T_FLUSH],
    prepare: canonical(HELPER, '  const fallback = setTimeout(() => finish(), fallbackMs);\n', '  const fallback = undefined;\n'),
    why: 'no fallback: a reader that never drains holds the CLI forever',
    killed_by: /a stream that never drains: the fallback exits with the code once it fires/,
  },
  {
    id: 'H4', tests: [T_FLUSH],
    prepare: canonical(HELPER, "    stream.once('error', finish);\n", ''),
    why: "an 'error' on a stream while it flushes is not an exit: the CLI waits for the fallback, or throws",
    killed_by: /an 'error' event on a stream exits at once with the code/,
  },
  {
    id: 'H5', tests: [T_FLUSH],
    prepare: canonical(HELPER, '  if (exiting) return;\n', ''),
    why: 'a second call while flushing changes the code and exits twice',
    killed_by: /a second call while flushing is ignored/,
  },
  {
    id: 'H6', tests: [T_FLUSH],
    prepare: canonical(HELPER, '    if (stream.destroyed || stream.writableFinished) {\n', '    if (stream.destroyed || stream.writableFinished || stream.writableEnded) {\n'),
    why: 'a stream ended but not finished counts as flushed: end(payload) is cut',
    killed_by: /an ended stream is waited for until it finishes/,
  },
  {
    id: 'H7', tests: [T_FLUSH, T_SESSION],
    prepare: canonical(HELPER, '  for (const stream of streams) {\n    if (Object.hasOwn(stream, OUTPUT_ERROR)) continue;\n', '  for (const stream of []) {\n    if (Object.hasOwn(stream, OUTPUT_ERROR)) continue;\n'),
    why: 'absorbOutputErrors does nothing: an EPIPE before the tail kills the CLI or hook with a stack',
    killed_by: [
      /a reader closed early: exit with the code, no EPIPE stack, even when the error comes before the tail/,
      /exits 0 with no EPIPE stack when stdout is closed before it writes/,
    ],
  },
  {
    id: 'H8', tests: [T_FLUSH],
    prepare: canonical(HELPER, '    if (stream[OUTPUT_ERROR] || stream.errored) {\n', '    if (stream.errored) {\n'),
    why: 'an error recorded before the tail is ignored: the CLI waits on a dead stream until the fallback',
    killed_by: /an error recorded by absorbOutputErrors before the call exits at once/,
  },
  {
    id: 'H9', tests: [T_FLUSH],
    prepare: canonical(HELPER, "      stream.write('', (error) => (error ? finish() : flushed()));\n", "      stream.write('', () => flushed());\n"),
    why: 'a write callback reporting an error counts as flushed: the CLI waits for the other stream',
    killed_by: /a write callback reporting an error exits at once, though another stream is still pending/,
  },
  {
    id: 'H10', tests: [T_DISPATCH],
    prepare: canonical('scripts/dispatch-peer.mjs', '    printHelp();\n    return 0;\n', '    printHelp();\n'),
    why: '--help with a peer and a prompt prints help and then dispatches',
    killed_by: /--help with a peer and a prompt prints help, exits 0 and resolves no companion/,
  },
  {
    id: 'H11', tests: [T_FLUSH],
    prepare: canonical(HELPER,
      "    stream.once('error', finish);\n    if (stream.destroyed || stream.writableFinished) {\n      flushed();\n      continue;\n    }\n",
      "    if (stream.destroyed || stream.writableFinished) {\n      flushed();\n      continue;\n    }\n    stream.once('error', finish);\n"),
    why: 'a stream already finished gets no error listener: its later error waits for the other stream, or throws',
    killed_by: /a stream already finished that errors while the other flushes exits at once/,
  },

  // ---- C: control -------------------------------------------------------------
  {
    id: 'C1', tests: [T_FLUSH, T_SYNC],
    prepare: canonical(HELPER, '/** How long exitAfterFlush waits for a reader before it exits anyway. */\n', '/** How long exitAfterFlush waits for a reader before it exits regardless. */\n'),
    why: 'a comment edit, regenerated everywhere, changes nothing a test reads',
    expect: 'SURVIVED',
  },
];
