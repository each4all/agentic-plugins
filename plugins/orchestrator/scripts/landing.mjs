#!/usr/bin/env node
// plugins/orchestrator/scripts/landing.mjs
//
// ADR-0062 §Decisions 1-2 — find the commit that landed a macro subtask.
//
// A subtask's `commit` is the merge commit of the pull request that carried
// its work: the squash commit for a squash merge, the last rebased commit for
// a rebase merge (GitHub reports both as `mergeCommit`). The subtask branch
// tip is never that commit here, because this repository squash- or
// rebase-merges every pull request.
//
// The pull request is bound to this attempt: its head is the subtask branch
// and it was created after the engineer workflow was dispatched, so a branch
// name reused by an older, already merged pull request is not mistaken for
// this one. The merge commit must be reachable from the integration branch's
// remote-tracking ref; a local-only integration commit proves nothing.
//
// `gh` is invoked through PATH. Without a working `gh` the operator supplies
// the commit, and only its ancestry can be verified.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GH_FIELDS = 'number,url,state,mergeCommit,baseRefName,headRefName,createdAt';

async function runGit(repoRoot, args) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
    return { ok: true, stdout: stdout.trim() };
  } catch (err) {
    return { ok: false, code: typeof err.code === 'number' ? err.code : null, stderr: String(err.stderr ?? err.message) };
  }
}

async function runGh(repoRoot, args) {
  try {
    const { stdout } = await execFileAsync('gh', args, {
      cwd: repoRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, detail: String(err.stderr || err.message).trim() };
  }
}

// `compose-20260927T100000Z-abcdef` → Date of 2026-09-27T10:00:00Z, or null.
export function dispatchTimeFromWorkflowId(workflowId) {
  const m = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]+$/.exec(workflowId ?? '');
  if (!m) return null;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return Number.isNaN(t) ? null : new Date(t);
}

const refuse = (reason, detail) => ({ ok: false, reason, detail });

async function isAncestor(repoRoot, commit, ref) {
  const r = await runGit(repoRoot, ['merge-base', '--is-ancestor', commit, ref]);
  return r.ok;
}

/**
 * @returns {Promise<
 *   {ok: true, commit: string, pr_url: ?string, pr_number: ?number,
 *    verification: 'merge-commit'|'ancestry-only', integration_ref: string}
 *   | {ok: false, reason: string, detail: string}>}
 */
export async function resolveLanding({
  repoRoot,
  subtaskBranch,
  integrationBranch,
  dispatchedAt = null,
  explicitCommit = null,
  explicitPr = null,
}) {
  for (const [name, value] of [['repoRoot', repoRoot], ['subtaskBranch', subtaskBranch], ['integrationBranch', integrationBranch]]) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`resolveLanding: ${name} must be a non-empty string`);
    }
  }
  const integrationRef = `refs/remotes/origin/${integrationBranch}`;
  if (!(await runGit(repoRoot, ['show-ref', '--verify', '--quiet', integrationRef])).ok) {
    return refuse('no_integration_ref',
      `${integrationRef} does not exist. Run git fetch origin ${integrationBranch}; ` +
        `a local-only integration branch cannot prove that work landed.`);
  }

  // The dispatch time is what binds a pull request to this attempt. Without
  // it an older merge of a reused branch name would be accepted.
  if (!(dispatchedAt instanceof Date) || Number.isNaN(dispatchedAt.getTime())) {
    return refuse('no_dispatch_time',
      'The subtask records no engineer workflow to date this attempt from; ' +
        'pass --engineer-workflow-id=<the engineer workflow that did the work>.');
  }
  const since = dispatchedAt.getTime();
  // A pull request opened before this attempt was dispatched belongs to an
  // earlier one, even when it is named explicitly.
  const openedInAttempt = (p) => Date.parse(p.createdAt) >= since;

  let commit = null;
  if (explicitCommit) {
    const r = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${explicitCommit}^{commit}`]);
    if (!r.ok || !r.stdout) return refuse('unknown_commit', `${explicitCommit} does not name a commit in this repository.`);
    commit = r.stdout;
  }

  const listed = await runGh(repoRoot, [
    'pr', 'list', '--head', subtaskBranch, '--state', 'all', '--limit', '100', '--json', GH_FIELDS,
  ]);
  if (!listed.ok) {
    if (!commit) {
      return refuse('gh_unavailable',
        `gh could not list pull requests (${listed.detail}). ` +
          `Pass --commit=<the merge commit on ${integrationBranch}>; it will be verified by ancestry only.`);
    }
    if (!(await isAncestor(repoRoot, commit, integrationRef))) {
      return refuse('not_reachable', `${commit} is not reachable from ${integrationRef}.`);
    }
    return {
      ok: true, commit, pr_url: null, pr_number: null,
      verification: 'ancestry-only', integration_ref: integrationRef,
    };
  }

  let prs;
  try {
    prs = JSON.parse(listed.stdout);
  } catch (err) {
    return refuse('gh_unavailable', `gh returned output that is not JSON: ${err.message}`);
  }
  if (!Array.isArray(prs)) return refuse('gh_unavailable', 'gh returned a non-array pull request list.');
  const forBranch = prs.filter((p) => p && p.headRefName === subtaskBranch);

  let pr;
  if (explicitPr !== null && explicitPr !== undefined) {
    pr = forBranch.find((p) => String(p.number) === String(explicitPr));
    if (!pr) return refuse('pr_not_for_branch', `Pull request #${explicitPr} does not have ${subtaskBranch} as its head.`);
    if (!openedInAttempt(pr)) {
      return refuse('pr_before_dispatch',
        `Pull request #${pr.number} was opened before this attempt was dispatched (${dispatchedAt.toISOString()}).`);
    }
    if (pr.state !== 'MERGED') return refuse('not_merged', `Pull request #${pr.number} is ${pr.state}, not merged.`);
  } else {
    const attempt = forBranch.filter(openedInAttempt);
    const merged = attempt.filter((p) => p.state === 'MERGED');
    if (merged.length === 0) {
      const open = attempt.filter((p) => p.state === 'OPEN');
      if (open.length > 0) {
        return refuse('not_merged',
          `Pull request ${open.map((p) => `#${p.number}`).join(', ')} for ${subtaskBranch} is open; record the subtask after it merges.`);
      }
      return refuse('no_pr',
        `No pull request with head ${subtaskBranch} was opened after this attempt was dispatched.`);
    }
    if (merged.length > 1) {
      return refuse('ambiguous',
        `Pull requests ${merged.map((p) => `#${p.number}`).join(', ')} all merged ${subtaskBranch}; name one with --pr=<number>.`);
    }
    [pr] = merged;
  }

  if (pr.baseRefName !== integrationBranch) {
    return refuse('base_mismatch',
      `Pull request #${pr.number} merged into ${pr.baseRefName}, not the integration branch ${integrationBranch}.`);
  }
  const mergeCommit = pr.mergeCommit?.oid;
  if (typeof mergeCommit !== 'string' || mergeCommit.length === 0) {
    return refuse('no_merge_commit', `GitHub reports no merge commit for pull request #${pr.number}.`);
  }
  if (commit && commit !== mergeCommit) {
    return refuse('commit_mismatch',
      `--commit ${commit} is not the merge commit of pull request #${pr.number} (${mergeCommit}).`);
  }
  if (!(await isAncestor(repoRoot, mergeCommit, integrationRef))) {
    return refuse('not_reachable',
      `${mergeCommit} is not reachable from ${integrationRef}. Run git fetch origin ${integrationBranch} and retry.`);
  }
  return {
    ok: true, commit: mergeCommit, pr_url: pr.url ?? null, pr_number: pr.number ?? null,
    verification: 'merge-commit', integration_ref: integrationRef,
  };
}
