// plugins/attention/scripts/lib/exit-after-flush.mjs
//
// Exit only once stdout and stderr have flushed what was written (R2).
// `process.exit` right after a write to a pipe drops whatever the pipe has not
// taken yet: discover-runtime.mjs's diagnostic echoing a long flag reached its
// reader as its first 64 KiB. The hooks write at most one short line today,
// and end through it too, so a longer line cannot be cut later.
//
// `write('', cb)` calls back after every earlier write on the stream. A ref'd
// fallback timer exits anyway when a reader never drains, and a stream error
// (EPIPE from a reader that closed early) exits with the same code. It writes
// nothing itself, and a second call while flushing is ignored. Each entry
// point calls it once, at its tail.
//
// COPY-NOT-IMPORT (ADR-0010 §5): the same body as the runtime plugin's
// scripts/lib/exit-after-flush.mjs; each copy is tested by
// tests/_exit-after-flush-suite.mjs. Library only — no CLI entry.

export const EXIT_FLUSH_FALLBACK_MS = 10_000;
let exitFlushStarted = false;
export function exitAfterFlush(code, fallbackMs = EXIT_FLUSH_FALLBACK_MS) {
  if (exitFlushStarted) return;
  exitFlushStarted = true;
  const exit = () => process.exit(code);
  setTimeout(exit, fallbackMs);
  let pending = 2;
  const settle = () => {
    pending -= 1;
    if (pending === 0) exit();
  };
  for (const stream of [process.stdout, process.stderr]) {
    stream.once('error', exit);
    try {
      stream.write('', settle);
    } catch {
      exit();
    }
  }
}
