#!/usr/bin/env node
// plugins/engineer/scripts/start-args.mjs
//
// `/engineer:start` argument extraction — ADR-0059 Decision 7.
//
// The start runbook used to split its arguments with `set -- $ARGUMENTS`,
// which put the typed text into shell source: an apostrophe aborted the
// block, `;` cut the description, `$(…)` ran. The runbook now has the model
// write the text into an ADR-0059 args file, and this CLI reads it. Its
// grammar is `extractStartArguments` in lib/args-file.mjs: a feature
// description holding at most one `--base-branch <ref>`, anywhere in it.
//
// CLI:
//   node start-args.mjs --args-file <path>
//     stdout — {"base_branch": "<ref>", "base_branch_explicit": <bool>, "feature": "<description>"}
//     exit 0 — extracted
//     exit 2 — the file, or the text in it, is outside the grammar (stderr says which)

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ArgsFileError, extractStartArguments, readArgsFile, soleArgsFilePath } from './lib/args-file.mjs';

const USAGE = 'usage: node start-args.mjs --args-file <path>\n';

export function runStartArgs(argv) {
  try {
    const path = soleArgsFilePath(argv);
    if (path === null) return { code: 2, stderr: USAGE };
    const { baseBranch, baseBranchExplicit, feature } = extractStartArguments(readArgsFile(path));
    const out = { base_branch: baseBranch, base_branch_explicit: baseBranchExplicit, feature };
    return { code: 0, stdout: `${JSON.stringify(out)}\n` };
  } catch (error) {
    if (!(error instanceof ArgsFileError)) throw error;
    return { code: 2, stderr: `✗ ${error.message}\n` };
  }
}

// Run as a CLI only when this file is the entry point, compared canonically so
// an install reached through a symlink or a path that needs URL escaping still
// runs (the state.mjs guard, ADR-0061 S2).
function invokedAsCli() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsCli()) {
  const { code, stdout, stderr } = runStartArgs(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}
