#!/usr/bin/env node
// Read-only collision check for ADR-0067 Decision 4, item 1, run before the
// RR release of runtime and attention is installed on either host or pulled
// into a directory marketplace (runbook: docs/runbooks/shared-state-readers.md).
//
// From RR on, the runtime readers in a checkout (entry brief, dashboard,
// doctor) read workflow records across its read set: the default state root
// (where git placed the main worktree) and the checkout's own homes. A branch
// key, or a workflow id, held by two files in one read set is then ambiguity:
// those readers report it, and stop leading, in that checkout; so is one
// pointer spelling naming two files. This check lists every such pair in every
// checkout of the repository, with the files, so the owner can finish,
// finalize or archive one of each first, and every file or `workflows/`
// directory the readers could not read, on which they degrade too.
//
// It reads the same homes the runtime readers read (engineer and
// orchestrator with their legacy homes; founder and designer canonical only),
// and only `workflows/`: a file there is active for its branch key, as the
// owners' own lookups count it (a macro's key is its git_baseline.branch).
// It writes nothing.
//
// Usage: node scripts/check-state-collisions.mjs [--repo <checkout>] [--format text|json]
// Exit 0: no collision. 1: collisions listed. 2: usage error, or git failed.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listingFailed, scanWorkflowFiles, workflowFileKeys } from '../plugins/runtime/scripts/lib/state-readers.mjs';
import { STATE_LOCATION_DEFAULT_ROOT, defaultStateRoot, stateReadSet } from '../plugins/runtime/scripts/lib/state-root.mjs';

const NAMESPACES = Object.freeze([
  { plugin: 'engineer', legacy: 'agentic-engineer' },
  { plugin: 'orchestrator', legacy: 'agentic-orchestrator' },
  { plugin: 'founder', legacy: null },
  { plugin: 'designer', legacy: null },
]);

export function parseWorktreeList(text) {
  const worktrees = [];
  for (const line of String(text).split('\n')) {
    if (line.startsWith('worktree ')) worktrees.push({ path: line.slice('worktree '.length), bare: false });
    else if (line === 'bare' && worktrees.length > 0) worktrees[worktrees.length - 1].bare = true;
  }
  return worktrees;
}

function listWorktrees(repo) {
  const result = spawnSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git worktree list failed in ${repo}: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  return parseWorktreeList(result.stdout).filter(({ bare }) => !bare).map(({ path }) => path);
}

// The workflow files of a namespace under one state root, keyed by their raw
// workflow id and branch (a sanitized value can redact two branches alike),
// and the `workflows/` directories that could not be listed: an inventory
// with a hole in it is not a clean one.
async function workflowFiles(stateRoot, { plugin, legacy }) {
  const homes = [join(stateRoot, '.agentic-plugins', 'state', plugin)];
  if (legacy) homes.push(join(stateRoot, '.claude', legacy));
  const files = [];
  const unlisted = [];
  for (const home of homes) {
    const scan = await scanWorkflowFiles(join(home, 'workflows'));
    if (listingFailed(scan)) unlisted.push(scan.dir);
    for (const file of scan.files) {
      const path = join(scan.dir, file.file);
      let real = path;
      try {
        real = await realpath(path);
      } catch {
        // A file that vanished is not part of the pair; its path stands in.
      }
      const pointer = relative(stateRoot, path).split(sep).join('/');
      files.push({ path, real, pointer, ...workflowFileKeys(file), status: file.status });
    }
  }
  return { files, unlisted };
}

// Every key held by two distinct files in one checkout's read set.
export async function findStateCollisions(repo) {
  const checkouts = listWorktrees(repo);
  const sharedRoot = defaultStateRoot(resolve(repo));
  const filesByRoot = new Map();
  const collect = async (root, namespace) => {
    const key = `${root}\0${namespace.plugin}`;
    if (!filesByRoot.has(key)) filesByRoot.set(key, await workflowFiles(root, namespace));
    return filesByRoot.get(key);
  };
  const collisions = [];
  const unreadable = [];
  for (const checkout of checkouts) {
    const readSet = await stateReadSet(checkout);
    // What the default state root holds alone is reported once, for the
    // checkout that is the default state root, not again for every other.
    const crossesRoots = readSet.length > 1;
    for (const namespace of NAMESPACES) {
      const seen = new Set();
      const files = [];
      // Every listing of every file, the alias of a file already listed
      // included: the pointer key is grouped over these (see below).
      const spellings = [];
      for (const { location, root } of readSet) {
        const ownRoot = !(crossesRoots && location === STATE_LOCATION_DEFAULT_ROOT);
        const inventory = await collect(root, namespace);
        if (ownRoot) {
          for (const dir of inventory.unlisted) unreadable.push({ checkout, plugin: namespace.plugin, path: dir });
        }
        for (const file of inventory.files) {
          spellings.push({ ...file, location });
          if (seen.has(file.real)) continue;
          seen.add(file.real);
          // A file whose branch cannot be read degrades the readers as a pair
          // does (the entry brief's missing-workflow-branch).
          if (ownRoot && (file.status !== 'available' || !file.branch)) {
            unreadable.push({ checkout, plugin: namespace.plugin, path: file.path });
          }
          files.push({ ...file, location });
        }
      }
      // `pointer`: one spelling naming two files, which a consumer resolving
      // default-root-first would confuse (Decision 1(c)). It is grouped over
      // every spelling: an alias's spelling reaches the aliased file, so a
      // second file under it is a pair even when the first was counted under
      // another spelling. A group is two distinct files at least.
      for (const key of ['branch', 'workflow_id', 'pointer']) {
        const groups = new Map();
        for (const file of key === 'pointer' ? spellings : files) {
          const value = file[key];
          if (typeof value !== 'string' || value.length === 0) continue;
          if (!groups.has(value)) groups.set(value, new Map());
          const group = groups.get(value);
          if (!group.has(file.real)) group.set(file.real, file);
        }
        for (const [value, byReal] of groups) {
          const group = [...byReal.values()];
          if (group.length < 2) continue;
          if (crossesRoots && group.every(({ location }) => location === STATE_LOCATION_DEFAULT_ROOT)) continue;
          collisions.push({
            checkout,
            plugin: namespace.plugin,
            key,
            value,
            files: group.map(({ path, location }) => ({ path, location })),
          });
        }
      }
    }
  }
  return { repo: resolve(repo), default_state_root: sharedRoot, checkouts, collisions, unreadable };
}

function renderText(report) {
  const lines = [
    `default state root: ${report.default_state_root}`,
    `checkouts: ${report.checkouts.length}`,
  ];
  if (report.collisions.length === 0) {
    lines.push('no collision: every branch key and workflow id is held by one file in each checkout\'s read set');
  }
  for (const c of report.collisions) {
    lines.push(`collision in ${c.checkout}: ${c.plugin} ${c.key} ${JSON.stringify(c.value)}`);
    for (const file of c.files) lines.push(`  - ${file.path} (${file.location})`);
  }
  for (const u of report.unreadable) {
    lines.push(`unreadable in ${u.checkout}: ${u.plugin} ${u.path} (unreadable, or no branch; check it by hand)`);
  }
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const options = { repo: process.cwd(), format: 'text' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo' && i + 1 < argv.length) options.repo = argv[++i];
    else if (arg === '--format' && ['text', 'json'].includes(argv[i + 1])) options.format = argv[++i];
    else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\nUsage: node scripts/check-state-collisions.mjs [--repo <checkout>] [--format text|json]\n`);
    return 2;
  }
  let report;
  try {
    report = await findStateCollisions(options.repo);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  process.stdout.write(options.format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : renderText(report));
  return report.collisions.length > 0 || report.unreadable.length > 0 ? 1 : 0;
}

// CLI entry. Both sides are realpath'd: Node resolves the main module through
// symlinks before building import.meta.url, so comparing it with argv[1] as
// spelled makes a linked invocation exit 0 having done nothing.
function invokedAsCLI() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsCLI()) {
  main().then((code) => { process.exitCode = code; });
}
