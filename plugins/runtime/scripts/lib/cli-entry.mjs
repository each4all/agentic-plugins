// COPIED from persona-pipeline — do not edit this copy.
// Source: persona-pipeline/files/scripts/lib/cli-entry.mjs, byte for byte below these
// three lines; tests/scripts/test-orchestrator-peer-snapshot-parity.mjs checks it.
// scripts/lib/cli-entry.mjs — the canonical-path CLI entry guard (ADR-0066 D1).
//
// A script runs its CLI only when it is the process entry point. The old guard,
// import.meta.url === `file://${process.argv[1]}`, compared a URL with a path:
// it was false, and the CLI silently did nothing (exit 0), whenever the script
// was reached through a symlink or sat under a directory whose name needs URL
// escaping — a space, '#', non-ASCII. Comparing pathToFileURL(argv[1]) fixed
// the escaping but not the symlink. Comparing both sides canonical, as paths,
// fixes both, with or without --preserve-symlinks-main (#812, ADR-0061 S2).
//
// Comparing canonical paths alone is not enough, though. Under
// --preserve-symlinks-main the entry module keeps its symlinked URL, while a
// module it imports reaches the same file through its real path: two instances
// of one file, and both pass the comparison. state.mjs `set-terminal` imports
// session-handoff.mjs, which imports state.mjs again, so the CLI ran twice. So
// the first instance of a file to ask claims the entry for the process, and
// any later instance of the same file is not the entry.
//
// It also holds how such a CLI exits (the owner's discussion-2 decision R2).
// process.exit() drops whatever stdout and stderr still hold: where Node
// writes a pipe asynchronously (macOS), a reader of a CLI that wrote 300 KB
// and then exited got the first 65,536 bytes. exitAfterFlush(code) waits for
// both streams to take what was written, then exits, with a ref'd fallback so
// a reader that never drains cannot hang the process. Each CLI calls it once,
// at its entry tail, with the code its paths return; absorbOutputErrors(),
// called first, keeps an EPIPE before the tail (a reader gone early) from
// killing the process with a stack before it reaches the tail.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLAIMS = Symbol.for('agentic-plugins.cli-entry.claims');

/** Whether the module at `importMetaUrl` is the process entry point. */
export function isCliEntry(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  let entry;
  let self;
  try {
    entry = realpathSync(argv1);
    self = realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
  if (entry !== self) return false;
  const claims = (globalThis[CLAIMS] ??= new Set());
  if (claims.has(self)) return false;
  claims.add(self);
  return true;
}

/** How long exitAfterFlush waits for a reader before it exits anyway. */
export const FLUSH_FALLBACK_MS = 10_000;

// The error an output stream reported, kept on the stream itself so every
// instance of this module sees it.
const OUTPUT_ERROR = Symbol.for('agentic-plugins.cli-entry.output-error');

/**
 * Keep an error on stdout or stderr (an EPIPE from a reader that closed
 * early) from being thrown: the error is recorded, and exitAfterFlush exits
 * at once with the CLI's code. Idempotent; call it first in an entry.
 */
export function absorbOutputErrors(streams = [process.stdout, process.stderr]) {
  for (const stream of streams) {
    if (Object.hasOwn(stream, OUTPUT_ERROR)) continue;
    stream[OUTPUT_ERROR] = null;
    stream.on('error', (error) => {
      stream[OUTPUT_ERROR] ??= error;
    });
  }
}

let exiting = false;

/**
 * Exit with `code` once stdout and stderr have taken what was written to
 * them. A stream error exits at once with the same code; after `fallbackMs`
 * it exits anyway. A second call is ignored. `streams` and `exit` are seams
 * for tests.
 */
export function exitAfterFlush(code, {
  streams = [process.stdout, process.stderr],
  fallbackMs = FLUSH_FALLBACK_MS,
  exit = (c) => process.exit(c),
} = {}) {
  if (exiting) return;
  exiting = true;
  process.exitCode = code;
  let done = false;
  let pending = streams.length;
  // Ref'd: it keeps the process alive until it fires, so the exit is never
  // left to the event loop draining.
  const fallback = setTimeout(() => finish(), fallbackMs);
  function finish() {
    if (done) return;
    done = true;
    clearTimeout(fallback);
    exit(code);
  }
  if (pending === 0) return finish();
  for (const stream of streams) {
    if (stream[OUTPUT_ERROR] || stream.errored) {
      finish();
      return;
    }
    let counted = false;
    const flushed = () => {
      if (counted) return;
      counted = true;
      pending -= 1;
      if (pending === 0) finish();
    };
    // Before the fast path: a stream already finished can still error (a
    // write after its end) while the other one flushes.
    stream.once('error', finish);
    if (stream.destroyed || stream.writableFinished) {
      flushed();
      continue;
    }
    if (stream.writableEnded) {
      // end() was called and the stream has not finished: write('') would
      // fail, so wait for it to finish (or close) instead.
      stream.once('finish', flushed);
      stream.once('close', flushed);
      continue;
    }
    try {
      // Queued behind every earlier write: its callback runs once they are
      // done.
      stream.write('', (error) => (error ? finish() : flushed()));
    } catch {
      finish();
      return;
    }
  }
}
