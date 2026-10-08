// plugins/runtime/scripts/lib/state-root.mjs
//
// ADR-0067 Decision 1(a) — the default state root of a checkout and the read
// set, where existing persona and orchestrator records are found. Runtime
// computes them itself, by copy (ADR-0010 §5: it may not import a persona's
// or orchestrator's state.mjs; ADR-0067 Decision 4, item 1).
//
// - The default state root is the parent of the git common dir when that dir
//   is named `.git`, and otherwise (a git dir under another name, as a bare
//   repository's usually is, or a submodule's) the checkout's toplevel. For a
//   linked worktree it is where git placed the main worktree; for a checkout
//   without linked worktrees whose `.git` is a directory, it is the checkout.
// - The read set is the default state root, then the checkout's toplevel: one
//   location when they are the same directory. AGENTIC_STATE_BASE and the
//   shared-creation switch choose where a record is created, never where it
//   is found, so neither is read here.
//
// Spawn-free: the common dir is found the way git finds it, from the
// checkout's `.git` (a directory, or a file naming the git dir) and that git
// dir's `commondir` file. The entry-brief read layer and the dashboard's
// --watch loop run no child process (ADR-0035 executor guard; dashboard.mjs
// header). Anything unreadable falls back to the checkout, today's layout.
//
// Runtime-owned state (session capture, entry capture), each home's
// `last-session-handoff.json` with its markers, and `.agentic-plugins/runs/`
// stay per checkout (ADR-0067 W9): their readers keep using the checkout.

import fs from 'node:fs';
import path from 'node:path';

import { sameDirectory } from './path-containment.mjs';

export const STATE_LOCATION_DEFAULT_ROOT = 'default-state-root';
export const STATE_LOCATION_CHECKOUT = 'checkout';

const GITDIR_LINE_RE = /^gitdir:\s*(.+?)\s*$/;

// The git common dir of `checkout`, or null when it cannot be read.
export function gitCommonDir(checkout) {
  const dotGit = path.join(checkout, '.git');
  let stat;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return null;
  }
  let gitDir;
  if (stat.isDirectory()) {
    gitDir = dotGit;
  } else if (stat.isFile()) {
    let text;
    try {
      text = fs.readFileSync(dotGit, 'utf8');
    } catch {
      return null;
    }
    const match = GITDIR_LINE_RE.exec(text.split(/\r?\n/, 1)[0] ?? '');
    if (!match) return null;
    gitDir = path.resolve(checkout, match[1]);
  } else {
    return null;
  }
  // `commondir` is relative to the physical git dir: git resolves a gitdir
  // reached through a symlink before it reads it, and `..` from the link's
  // spelling names another directory.
  try {
    gitDir = fs.realpathSync(gitDir);
  } catch {
    return null;
  }
  let commonDir;
  try {
    commonDir = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
  } catch (error) {
    // No `commondir`: the git dir is its own common dir (a main worktree, a
    // separate-git-dir checkout, a submodule).
    return error?.code === 'ENOENT' ? gitDir : null;
  }
  return commonDir ? path.resolve(gitDir, commonDir) : gitDir;
}

export function defaultStateRoot(checkout) {
  const toplevel = path.resolve(checkout);
  const common = gitCommonDir(toplevel);
  if (common && path.basename(common) === '.git') return path.dirname(common);
  return toplevel;
}

// [{ location, root }], the default state root first. A record found under
// both is never a choice between them: readers report the ambiguity. When the
// filesystem will not say whether the two are one directory, both are read:
// the readers count a file reached twice once, by its real path.
export async function stateReadSet(checkout) {
  const toplevel = path.resolve(checkout);
  const shared = defaultStateRoot(toplevel);
  if ((await sameDirectory(shared, toplevel)).same === true) return [{ location: STATE_LOCATION_CHECKOUT, root: toplevel }];
  return [
    { location: STATE_LOCATION_DEFAULT_ROOT, root: shared },
    { location: STATE_LOCATION_CHECKOUT, root: toplevel },
  ];
}

// The checkout alone, for the readers of per-checkout state.
export function checkoutOnlyReadSet(checkout) {
  return [{ location: STATE_LOCATION_CHECKOUT, root: path.resolve(checkout) }];
}
