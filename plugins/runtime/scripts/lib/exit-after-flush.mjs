// Exit only once stdout and stderr have flushed what was written (R2).
//
// `process.exit` right after a write to a pipe drops whatever the pipe has not
// taken yet, so a `bootstrap --format json` report past 65,536 bytes reached
// its reader cut short and failed to parse. `process.exitCode` keeps the
// report whole but waits on every live handle, and a probe child that ignored
// SIGTERM after a timeout keeps its pipes live until it ends. This helper does
// both: it waits until stdout and stderr have flushed (`write('', cb)` calls
// back after every earlier write on the stream), then exits with the code.
//
// A ref'd fallback timer exits anyway when a reader never drains, and a stream
// error (EPIPE from a reader that closed early) exits with the same code. It
// writes nothing itself, and a second call while flushing is ignored. Each CLI
// calls it once, at its entry tail; a mid-function exit returns its code
// instead, so nothing runs after help or a refusal.
//
// The same body is inlined in receivers/agentic-statusline.mjs (the installed
// shim is standalone) and copied in plugins/attention/scripts/lib/; each copy
// is tested by tests/_exit-after-flush-suite.mjs. Library only — no CLI entry.

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
