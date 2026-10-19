// node:test reporter that records how long each test file took, for
// scripts/shard-tests.mjs (ADR-0033, amendment of 2026-10-19).
//
// It writes one JSON line per test file, `{ file, duration_ms }`, then
// `{ summary: true, success, duration_ms, counts }` for the run as a whole.
// A file that runs `node:test` tests ends with a `test:summary` event naming
// it; a file that never imports `node:test` gets none, and Node reports it
// instead as one top-level test named after the file (`test:pass` or
// `test:fail` at nesting 0), whose duration is taken. The run's own summary is
// the `test:summary` Node emits last and without a `file`.
// `shard-tests.mjs record` reads those lines and refuses a recording whose
// last line is not a successful run's summary: a run that was stopped never
// wrote one.
//
// A file's duration is its own run as Node timed it, with the process start
// and the --import preload left out, under whatever concurrency the run had.
// The shard script therefore treats it as an estimate and adds a fixed
// per-file overhead.
//
// Use it beside a human reporter, on a full run from the repository root:
//
//   npm test -- --test-reporter=./scripts/lib/duration-reporter.mjs \
//     --test-reporter-destination=<file.jsonl> \
//     --test-reporter=spec --test-reporter-destination=stdout

import path from 'node:path';

// Node names the file-level test by the path it was given: absolute for an
// absolute argument, relative to the working directory under discovery,
// while `file` is absolute (and may spell the directory through its real
// path). A test named after its own file therefore ends `file`.
function namesFile(name, file) {
  return typeof name === 'string' && name !== ''
    && (name === file || file.endsWith(`${path.sep}${path.normalize(name)}`));
}

export default async function* durationReporter(source) {
  for await (const event of source) {
    const { data } = event;
    if (event.type === 'test:summary') {
      const { file, duration_ms: durationMs, success, counts } = data;
      if (file === undefined) {
        yield `${JSON.stringify({ summary: true, success, duration_ms: durationMs, counts })}\n`;
      } else {
        yield `${JSON.stringify({ file, duration_ms: durationMs })}\n`;
      }
    } else if ((event.type === 'test:pass' || event.type === 'test:fail')
      && data.nesting === 0 && typeof data.file === 'string' && namesFile(data.name, data.file)) {
      yield `${JSON.stringify({ file: data.file, duration_ms: data.details?.duration_ms })}\n`;
    }
  }
}
