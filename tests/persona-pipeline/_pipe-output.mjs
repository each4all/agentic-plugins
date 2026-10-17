// Shared helper for the persona CLIs' pipe-output regressions (the owner's
// discussion-2 decision R2, exitAfterFlush in scripts/lib/cli-entry.mjs).
//
// A CLI that writes more than a pipe holds and then calls process.exit()
// loses the rest: Node writes a piped stdout asynchronously, and the exit
// drops what was still queued. The reader gets what the pipe's buffer took —
// 65,536 bytes on macOS, 146,176 on Linux (Node 24, measured) — so a
// regression's payload must be larger than any of them: PIPE_FLOOR_BYTES.
//
// runThroughPipe reads stdout and stderr from pipes, as a host or a runbook's
// `$(...)` does, until the child closes them, and kills the child at a
// deadline so a hang is a fast failure, never a harness TIMEOUT.
//
// A reader that drains while the child writes lets one write() take more than
// the buffer: on Linux the kernel keeps copying into the pipe as the reader
// empties it, and a bare exit then delivered all 524,288 bytes in 1 run of
// 1,000 (Node 24, node:24-slim, measured). A control that must show output
// lost passes readAfterExit: nothing is consumed until the child has exited,
// so what arrives is bounded by the pipe's buffer and the reader's own
// high-water mark (at most 182,720 bytes in 1,000 Linux runs, 131,072 in 50
// on macOS), never by timing.

import { spawn } from 'node:child_process';

/** More than a pipe's buffer takes at once on any platform measured. */
export const PIPE_FLOOR_BYTES = 256 * 1024;

/**
 * The environment for a child CLI: the caller's, without the variables that
 * would bind it to an autopilot run or another state base.
 */
export function pipeEnv(base = process.env, extra = {}) {
  const env = { ...base };
  for (const key of ['AGENTIC_AUTOPILOT', 'AGENTIC_AUTOPILOT_TOKEN', 'AGENTIC_STATE_BASE']) delete env[key];
  return { ...env, ...extra };
}

/**
 * Run `command args` with stdout and stderr on pipes, read both whole, and
 * resolve { status, signal, stdout, stderr, timedOut, elapsedMs }. With
 * readAfterExit, the pipes are read only once the child has exited.
 */
export function runThroughPipe(command, args, { cwd, env, timeoutMs = 60_000, readAfterExit = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let timedOut = false;
    const read = () => {
      child.stdout.on('data', (c) => out.push(c));
      child.stderr.on('data', (c) => err.push(c));
    };
    if (readAfterExit) child.once('exit', read);
    else read();
    const watchdog = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(watchdog);
      rejectRun(error);
    });
    child.once('close', (status, signal) => {
      clearTimeout(watchdog);
      resolveRun({
        status,
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        elapsedMs: Date.now() - started,
      });
    });
  });
}
