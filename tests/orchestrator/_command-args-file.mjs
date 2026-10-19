// tests/orchestrator/_command-args-file.mjs
//
// The args file an agent writes for an orchestrator command (ADR-0059,
// C134(a)): `{"agentic_args": 1, "text": "<the arguments as typed>"}` in a
// directory `mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"` made. The
// runbooks' blocks read it with `state.mjs command-args`, which removes the
// file and its directory once read, so every run of a block takes a new one.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodeArgsFile } from '../../plugins/orchestrator/scripts/lib/args-file.mjs';

/** The directory, under `base`, holding the args file for `text`. */
export function argsDir(text, { base = tmpdir() } = {}) {
  const dir = mkdtempSync(join(base, 'agentic-args.'));
  writeFileSync(join(dir, 'args.json'), encodeArgsFile(text));
  return dir;
}

/**
 * `block` with its ARGS_DIR line naming a new args file for `text`, as the
 * agent fills it. A block without the line fails here rather than run without
 * its arguments.
 */
export function withArgs(block, text, { line = "ARGS_DIR='<directory from step 1>'", base } = {}) {
  if (!block.includes(line)) throw new Error(`the block has no line ${line}`);
  const dir = argsDir(text, { base });
  return block.replace(line, () => `ARGS_DIR='${dir}'`);
}
