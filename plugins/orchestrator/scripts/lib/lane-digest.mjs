// scripts/lib/lane-digest.mjs — a lane's content, as a release records it and
// the driver compares it (ADR-0068 Decision 2, item 7; N6; implementation
// note I1).
//
// The tree digest covers every non-ignored file of the lane's worktree,
// checked-out submodules included: `git add -A` and `git write-tree` through
// a temporary index seeded from a copy of the lane's own, so the lane's real
// index is never touched (a `git status` would refresh it, and the wake digest
// reads it). The copy's assume-unchanged and skip-worktree bits are cleared
// first: a file hidden by either is still a file someone may have edited.
// Every inherited `GIT_*` variable is scrubbed, so a caller inside a hook or
// another repository's command cannot redirect it. Each checked-out submodule
// is digested through its own index, recursively; one not initialized counts
// by the commit its gitlink records. A lane with no worktree has no tree
// digest (`null`): the child alone is compared.
//
// The content digest of the child's workflow is the pinned engineer's
// (`state.mjs content-digest`, N6): the frontmatter without the fields a
// snapshot writes, and the body. Neither digest is this module's to define
// beyond calling it.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TREE_DIGEST_VERSION = 1;
const WORKTREE_LOCK_REL = '.agentic-plugins/runs/autopilot/worktree.lock';
export const CONTENT_DIGEST_SCHEMA = 'agentic-workflow-content-digest-1';

const scrubbed = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  ...extra,
});

function git(cwd, args, env = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: scrubbed(env), maxBuffer: 256 * 1024 * 1024, timeout: 120_000,
  });
}

/**
 * The lane's tree digest: `{ digest, head }` — a sha256 over the worktree's
 * tree (every non-ignored file), its HEAD, and each checked-out submodule's
 * own digest. Throws when git cannot read the lane.
 */
export function treeDigest(laneRoot) {
  const top = git(laneRoot, ['rev-parse', '--show-toplevel']).trim();
  const realIndex = path.resolve(top, git(top, ['rev-parse', '--git-path', 'index']).trim());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-lane-digest-'));
  const index = path.join(dir, 'index');
  try {
    // A lane with no index yet (a fresh worktree before any add) starts from an
    // empty one.
    if (fs.existsSync(realIndex)) {
      fs.copyFileSync(realIndex, index);
      // The copy's time is now, later than every entry's: git would trust each
      // entry's stat and miss an edit of the same size in the same second (or
      // one whose times were put back). Dated a second after the epoch (git
      // ignores a time of 0), every entry is
      // racily clean, so git compares each file's content.
      fs.utimesSync(index, 1, 1);
    }
    const env = { GIT_INDEX_FILE: index };
    // `ls-files -v`: a lowercase tag marks assume-unchanged, `S` skip-worktree.
    const hidden = git(top, ['ls-files', '-v', '-z'], env).split('\0').filter(Boolean)
      .filter((l) => /^[a-zS] /.test(l)).map((l) => l.slice(2));
    // One flag per call: given both, update-index applies only the first.
    for (const flag of ['--no-assume-unchanged', '--no-skip-worktree']) {
      for (let i = 0; i < hidden.length; i += 500) git(top, ['update-index', flag, '--', ...hidden.slice(i, i + 500)], env);
    }
    // The lane's worktree lock is the orchestrator's bookkeeping, not the
    // lane's content: a release removes its own fence after it records the
    // basis, which must not move the digest where the lock is not ignored.
    git(top, ['add', '-A', '--', '.'], env);
    git(top, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', WORKTREE_LOCK_REL], env);
    const tree = git(top, ['write-tree'], env).trim();
    let head = null;
    try { head = git(top, ['rev-parse', '--verify', '-q', 'HEAD']).trim(); } catch { head = null; }
    const h = createHash('sha256').update(`tree ${tree}\nhead ${head ?? 'none'}\n`);
    // Each gitlink: a checked-out submodule through its own index, an
    // uninitialized one by the commit the tree records.
    const links = git(top, ['ls-files', '-s', '-z'], env).split('\0').filter((l) => l.startsWith('160000 '));
    for (const l of links.sort()) {
      const rel = l.slice(l.indexOf('\t') + 1);
      const sub = path.join(top, rel);
      const checkedOut = fs.existsSync(path.join(sub, '.git'));
      h.update(`submodule ${rel} ${checkedOut ? treeDigest(sub).digest : `gitlink ${l.split(' ')[1]}`}\n`);
    }
    return { digest: h.digest('hex'), head };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The child's content digest from the pinned engineer (N6), its schema
 * checked: the digest string. Throws when the engineer gives none.
 */
export function contentDigest(engineerRoot, workflowPath) {
  const out = execFileSync(process.execPath, [path.join(engineerRoot, 'scripts', 'state.mjs'), 'content-digest', '--workflow-path', workflowPath], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: scrubbed(), timeout: 60_000,
  });
  let r;
  try { r = JSON.parse(out); } catch { throw new Error(`the engineer's content-digest printed no JSON: ${out.slice(0, 200)}`); }
  if (r?.schema !== CONTENT_DIGEST_SCHEMA || typeof r.digest !== 'string' || !/^[0-9a-f]{64}$/.test(r.digest)) {
    throw new Error(`the engineer's content-digest is not ${CONTENT_DIGEST_SCHEMA}: ${out.slice(0, 200)}`);
  }
  return r.digest;
}

/**
 * Which paths a lane does not ignore of its generated state (P17): the
 * session-capture and persona records under `.agentic-plugins/state/` and the
 * run ledgers under `.agentic-plugins/runs/`, which a session left open after
 * the release would change in the tree digest. `[]` when both are ignored.
 */
export function unignoredStatePaths(laneRoot) {
  const out = [];
  for (const rel of ['.agentic-plugins/state/', '.agentic-plugins/runs/']) {
    try {
      git(laneRoot, ['check-ignore', '-q', '--no-index', `${rel}probe`]);
    } catch (err) {
      if (err.status === 1) out.push(rel);
      else throw err;
    }
  }
  return out;
}
