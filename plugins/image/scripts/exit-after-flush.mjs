#!/usr/bin/env node
// plugins/image/scripts/exit-after-flush.mjs (C93)
//
// End a CLI with a code once stdout and stderr have flushed what was written.
// `process.exit` right after a write drops what a pipe has not taken yet: the
// runbooks read these CLIs through `$(…)`, and a result past 64 KiB (Codex's
// whole assessment, from critique-dispatch) arrived cut.
//
// exitAfterFlush(code) writes nothing itself. It asks each stream to call back
// once everything written before has been handed on (`write('', cb)`), then
// exits with the code. A stream error (EPIPE, a reader that went away) exits
// with the same code at once. A ref'd fallback timer exits anyway, so a reader
// that never drains cannot hang the process. A second call while flushing is
// ignored. Each CLI calls it once, at its entry tail; everything before
// returns its code instead of exiting, so nothing runs after a refusal.

export const EXIT_FLUSH_FALLBACK_MS = 10_000;

let started = false;

export function exitAfterFlush(code, fallbackMs = EXIT_FLUSH_FALLBACK_MS) {
  if (started) return;
  started = true;
  const exit = () => process.exit(code);
  setTimeout(exit, fallbackMs);
  let pending = 2;
  const settle = () => { if (--pending === 0) exit(); };
  for (const stream of [process.stdout, process.stderr]) {
    stream.once('error', exit);
    try {
      stream.write('', settle);
    } catch {
      exit();
      return;
    }
  }
}
