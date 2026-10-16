// Mutation spec — do the exit-after-flush tests catch the defects they exist
// for (C125)?
//
// Run: npm run mutate -- scripts/mutation-specs/companions-exit-flush.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. An exit that drops buffered output fails
// quietly: anything under 64 KiB still arrives whole, and a test that reads a
// small answer passes against the defect. T restores the immediate exit at each
// CLI's own tail, where the defect lived, so each regression is shown to catch
// it at the CLI under test and not in its fixture. H breaks one rule of the
// helper at a time, once per inline copy (C claude-companion, X
// codex-companion, D discover-peer): each case names the one test built to
// catch it. R runs discovery before a refusal returns, which the exit code and
// stdout alone do not show. The bundle copies are held to the canonical ones by the
// byte-identity tests, not here.

const T_CLAUDE = 'companions/tests/claude-companion.test.mjs';
const T_CODEX = 'companions/tests/codex-companion.test.mjs';
const T_DISCOVER = 'tests/companions/test-discover-peer.mjs';

const CLAUDE = 'companions/claude-companion.mjs';
const CODEX = 'companions/codex-companion.mjs';
const DISCOVER = 'companions/discover-peer.mjs';

export const TESTS = [T_CLAUDE, T_CODEX, T_DISCOVER];

const TAIL_FROM = '(code) => exitAfterFlush(code),';
const TAIL_TO = '(code) => process.exit(code),';
const LARGE_ANSWER = [/JSON mode: the envelope past 64 KiB parses/, /text mode: the answer past 64 KiB arrives whole/];

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
    id: 'T1', file: CLAUDE, tests: [T_CLAUDE],
    from: TAIL_FROM, to: TAIL_TO,
    why: 'claude-companion exits as soon as main() returns, dropping an envelope past 64 KiB',
    killed_by: LARGE_ANSWER,
  },
  {
    id: 'T2', file: CODEX, tests: [T_CODEX],
    from: TAIL_FROM, to: TAIL_TO,
    why: 'codex-companion exits as soon as main() returns, dropping an envelope past 64 KiB',
    killed_by: LARGE_ANSWER,
  },
  {
    id: 'T3', file: DISCOVER, tests: [T_DISCOVER],
    from: TAIL_FROM, to: TAIL_TO,
    why: 'discover-peer exits as soon as runCli() returns, dropping a diagnostic past 64 KiB',
    killed_by: [/the CLI delivers a diagnostic past 64 KiB to a pipe reader whole/],
  },
  {
    id: 'R1', file: DISCOVER, tests: [T_DISCOVER],
    from: '      return 2;\n    }\n  }\n',
    to: "      await discoverPeerCompanion({ peer: 'claude' });\n      return 2;\n    }\n  }\n",
    why: 'discover-peer runs discovery before refusing an unknown argument, though it still exits 2 with nothing on stdout',
    killed_by: [/the CLI refuses an unknown argument with exit 2 and never runs discovery/],
  },

  // ---- H: the helper, once per inline copy --------------------------------
  ...helperMutations('C', CLAUDE, T_CLAUDE),
  ...helperMutations('X', CODEX, T_CODEX),
  ...helperMutations('D', DISCOVER, T_DISCOVER),
];
