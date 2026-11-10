#!/usr/bin/env node
// Reports the bytes an agent reads on a normal step of each runbook: the
// command body plus every file that step requires (its skill, the references
// its normal path sends the agent to). scripts/data/runbook-read-paths.json
// names the steps, what "normal" means, and why each file is read.
//
// A passage moved out of a body into a file the normal path still reads saves
// nothing, so the figure is the sum, not the body alone. A report only: no
// test and no budget reads it.
//
//   node scripts/measure-runbook-read.mjs                 the working tree
//   node scripts/measure-runbook-read.mjs --base <rev>    <rev> beside the tree
//   (--repo-root <dir>; --json for the figures as data)
//
// A file a step names that is absent counts 0 and is marked, in the tree or at
// the revision: a path that moved shows as one, not as a saving.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { repoRoot: resolve(HERE, '..'), base: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') out.base = argv[++i];
    else if (argv[i] === '--repo-root') out.repoRoot = resolve(argv[++i]);
    else if (argv[i] === '--json') out.json = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (out.base === undefined || (out.base !== null && !/^[A-Za-z0-9._\/~^-]+$/.test(out.base))) {
    throw new Error('--base takes a revision');
  }
  return out;
}

/** Bytes of `rel` in the working tree, or null when it is absent. */
function treeBytes(repoRoot, rel) {
  try {
    return readFileSync(join(repoRoot, rel)).length;
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

/** Bytes of `rel` at `rev`, or null when the revision does not hold it. */
function revBytes(repoRoot, rev, rel) {
  try {
    return execFileSync('git', ['-C', repoRoot, 'cat-file', '-s', `${rev}:${rel}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() * 1;
  } catch {
    return null;
  }
}

/** One step's figures: `{ body, reads: [{ path, bytes }], total, absent: [...] }`. */
export function measureStep(step, bytesOf) {
  const absent = [];
  const size = (rel) => {
    const n = bytesOf(rel);
    if (n === null) absent.push(rel);
    return n ?? 0;
  };
  const body = size(step.body);
  const reads = step.reads.map((r) => ({ path: r.path, bytes: size(r.path) }));
  return { body, reads, total: body + reads.reduce((sum, r) => sum + r.bytes, 0), absent };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // The table of the tree measured, not of the tree this script runs from.
  const table = JSON.parse(readFileSync(join(args.repoRoot, 'scripts', 'data', 'runbook-read-paths.json'), 'utf8'));
  // The baseline is that revision's own table when it holds one: the files a
  // step required then, not the ones it requires now.
  let baseTable = table;
  if (args.base !== null) {
    try {
      baseTable = JSON.parse(execFileSync('git', ['-C', args.repoRoot, 'show', `${args.base}:scripts/data/runbook-read-paths.json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch {
      baseTable = table;
    }
  }
  const rows = Object.entries(table.steps).map(([name, step]) => ({
    name,
    now: measureStep(step, (rel) => treeBytes(args.repoRoot, rel)),
    base: args.base === null ? null : measureStep(baseTable.steps[name] ?? step, (rel) => revBytes(args.repoRoot, args.base, rel)),
  }));
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ normal_step: table.normal_step, base: args.base, rows }, null, 2)}\n`);
    return;
  }
  const pct = (a, b) => (b === 0 ? 'n/a' : `${((a - b) / b * 100).toFixed(1)}%`);
  console.log(`Normal step: ${table.normal_step}`);
  for (const { name, now, base } of rows) {
    const line = base === null
      ? `${name}: body ${now.body}, read in all ${now.total}`
      : `${name}: body ${base.body} -> ${now.body} (${pct(now.body, base.body)}), read in all ${base.total} -> ${now.total} (${pct(now.total, base.total)})`;
    console.log(line);
    for (const rel of new Set([...now.absent, ...(base?.absent ?? [])])) console.log(`  absent, counted 0: ${rel}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`measure-runbook-read: ${e.message}`);
    process.exit(1);
  }
}
