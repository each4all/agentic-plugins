// scripts/lib/worktree-proposal.mjs — the worktree /orchestrator:next selects
// first when a dirty tree stops its dispatch (ADR-0067 Decision 8, item 3).
//
// The command is rendered from a fixed template with values resolved and
// checked here, at `<parent>/<repo>-<slug>`, the path runtime:worktree uses
// (plugins/runtime/scripts/worktree.mjs, defaultWorktreePath):
//   - the subtask branch absent, with an `origin` remote: Decision 5's fetch
//     of that one remote-tracking ref (`--no-tags`, an empty `--refmap=`), then
//     `git worktree add --no-track -b <branch> <path> refs/remotes/origin/<baseline>`,
//     the base next.md itself would use. The fetch comes first because
//     next.md, run again in the new worktree, finds the branch and takes its
//     switch path, which skips its own fetch;
//   - the subtask branch absent, with no `origin` remote:
//     `git worktree add -b <branch> <path> refs/heads/<baseline>`;
//   - the subtask branch present: `git worktree add <path> <branch>`, or, when
//     another worktree has it checked out, that worktree.
// When this checkout has the subtask's branch checked out and the subtask is
// in progress, no worktree: the changes are its engineer workflow's, and the
// ordinary resume of that workflow here is the selection (Decision 8, item 3
// keeps it). That needs no other worktree, so it is decided before the macro's
// location is.
// A worktree is proposed only when the new worktree can find the macro: when
// it lies in a home of the default state root, which every worktree's read set
// holds (Decision 1(a)). A macro in a linked worktree's own home is in no other
// worktree's read set; the refusal then names the cutover (Decision 4, item 4)
// as what makes a second worktree usable.
//
// Read-only: it runs git to read, and never creates a branch or a worktree.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { defaultStateRoot, gitCommonDir, SHARED_HOMES, worktreeHoldingBranch } from './state-root.mjs';

const CUTOVER_RUNBOOK = 'docs/runbooks/state-root-cutover.md';
const MACRO_ID_RE = /^macro-[a-z][a-z0-9-]*-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const realOr = (p) => {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
};
const isWithin = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// A shell word: bare when it needs no quoting, else single-quoted.
export const shellQuote = (value) => {
  const text = String(value);
  return /^[A-Za-z0-9_./:@=+-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
};

// A branch name git accepts and a shell line can carry bare: what plan-set's
// ref-format gate lets through, minus anything a word would need quoted for.
export function isPlainBranch(name) {
  return typeof name === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)
    && !name.includes('..') && !name.includes('//') && !name.endsWith('/')
    && !name.endsWith('.') && !name.endsWith('.lock') && !name.split('/').some((c) => c.startsWith('.'));
}

/**
 * Whether `macroPath` lies in an orchestrator home of `checkout`'s default
 * state root, in a repository that has one (a git common dir named .git):
 * then every worktree of the repository reads it.
 */
export function macroInDefaultRoot(checkout, macroPath) {
  if (typeof macroPath !== 'string' || macroPath === '') return false;
  const common = gitCommonDir(path.resolve(checkout));
  if (!common || path.basename(common) !== '.git') return false;
  const root = defaultStateRoot(checkout);
  const real = realOr(macroPath);
  return SHARED_HOMES.filter((h) => h.plugin === 'orchestrator').some((h) => isWithin(real, realOr(path.join(root, h.rel))));
}

/** runtime:worktree's path for a branch: `<parent>/<repo>-<slug>`. */
export function worktreePathFor(toplevel, branch) {
  const top = path.resolve(toplevel);
  const slug = String(branch).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
  return path.resolve(path.dirname(top), `${path.basename(top)}-${slug}`);
}

function gitOk(cwd, args) {
  try {
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns {{proposed: boolean, reason?: string, resume?: boolean, path?: string,
 *   held?: boolean, path_exists?: boolean, commands?: string[], then?: string,
 *   note?: ?string}}
 */
export function nextWorktreeProposal({ repoRoot, macroPath, macroId, subtaskId, branch, baseline, status = null, host = 'claude' }) {
  const top = path.resolve(repoRoot);
  if (status === 'in_progress' && isPlainBranch(branch)) {
    const holder = worktreeHoldingBranch(top, branch);
    if (holder && realOr(holder) === realOr(top)) {
      const which = SAFE_ID_RE.test(String(subtaskId ?? '')) ? `subtask ${subtaskId}` : 'its subtask';
      return {
        proposed: false, resume: true, then: `${host === 'codex' ? '$' : '/'}engineer:resume`,
        reason: `${branch} is checked out in this checkout and ${which} is in progress, so these changes are its engineer workflow's work`,
      };
    }
  }
  if (!macroInDefaultRoot(top, macroPath)) {
    return {
      proposed: false,
      reason: `the macro ${macroPath} is not in a home of the default state root ${defaultStateRoot(top)}, so ` +
        `/orchestrator:next run in a new worktree would not find it; the state-root cutover (${CUTOVER_RUNBOOK}) ` +
        'makes a second worktree usable',
    };
  }
  if (!MACRO_ID_RE.test(String(macroId ?? ''))) return { proposed: false, reason: `${JSON.stringify(macroId)} is not a macro workflow id` };
  if (!SAFE_ID_RE.test(String(subtaskId ?? ''))) return { proposed: false, reason: `${JSON.stringify(subtaskId)} is not a subtask id a command can carry` };
  if (!isPlainBranch(branch)) return { proposed: false, reason: `the subtask branch ${JSON.stringify(branch)} is not a plain branch name` };
  const then = `${host === 'codex' ? '$' : '/'}orchestrator:next ${subtaskId} --workflow=${macroId}`;
  const present = gitOk(top, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (present) {
    const holder = worktreeHoldingBranch(top, branch);
    // git checks a branch out in one worktree only. Held here, the changes are
    // on the subtask's own branch, where no other worktree can take it.
    if (holder && realOr(holder) === realOr(top)) {
      return { proposed: false, reason: `${branch} is checked out in this checkout, so its changes are on the subtask's own branch and no other worktree can take it` };
    }
    if (holder) return { proposed: true, held: true, path: holder, commands: [], then, note: `${branch} is already checked out` };
  }
  const where = worktreePathFor(top, branch);
  const proposal = { proposed: true, held: false, path: where, path_exists: fs.existsSync(where), then, note: null };
  const git = `git -C ${shellQuote(top)}`;
  if (present) {
    proposal.commands = [`${git} worktree add ${shellQuote(where)} ${branch}`];
    return proposal;
  }
  if (!isPlainBranch(baseline)) return { proposed: false, reason: `the macro's baseline branch ${JSON.stringify(baseline)} is not a plain branch name` };
  if (gitOk(top, ['remote', 'get-url', 'origin'])) {
    proposal.commands = [
      `${git} fetch --no-tags --refmap= origin +refs/heads/${baseline}:refs/remotes/origin/${baseline}`,
      `${git} worktree add --no-track -b ${branch} ${shellQuote(where)} refs/remotes/origin/${baseline}`,
    ];
    proposal.note = `when the fetch fails, the add starts from the last fetched origin/${baseline}, as /orchestrator:next would; with none fetched, it fails`;
  } else {
    proposal.commands = [`${git} worktree add -b ${branch} ${shellQuote(where)} refs/heads/${baseline}`];
  }
  return proposal;
}

/** The lines the runbook prints under its refusal. */
export function worktreeProposalText(p) {
  if (p.resume) {
    return `→ Proposed: no new worktree: ${p.reason}. Continue that workflow on this branch (${p.then}); it commits them through its own steps. Commit, stash or revert them by hand only if they are not its work.`;
  }
  if (!p.proposed) return `→ A new worktree would not help here: ${p.reason}.`;
  if (p.held) return `→ Proposed: run ${p.then} in ${p.path}, where ${p.note}; this checkout's changes stay where they are.`;
  const lines = ['→ Proposed: a worktree first, so this checkout\'s changes stay where they are:'];
  for (const c of p.commands) lines.push(`    ${c}`);
  lines.push(`  then, in ${p.path}: ${p.then}`);
  if (p.note) lines.push(`  (${p.note})`);
  if (p.path_exists) lines.push(`  ⚠ ${p.path} already exists: remove it, or give git worktree add another path.`);
  return lines.join('\n');
}
