// plugins/orchestrator/scripts/lib/land-prepare-plan.mjs
//
// ADR-0062, amendment of 2026-11-11 — the decisions of the landing preparation
// helper (`scripts/land-prepare.mjs`), as pure functions of the facts it read
// from git and GitHub. Nothing here runs a process or touches a file, so each
// rule is a small test; the CLI gathers the facts, asks these functions, and
// acts.

// The commit and pull request text rules the release tooling needs: a line
// that release-please would read as a conventional headline, or a footer it
// routes, must not reach a squash message or a commit body unasked (AGENTS.md
// § Release process). The same headline rule as Phase 7's body check
// (persona-pipeline phase7-commit.mjs HEADLINE_LINE_RE).
export const HEADLINE_LINE_RE = /^(?:(?:feat|fix|docs|ci|refactor|chore|test|perf|build|style|revert|deps)(?:\([^)]*\))?!?:|[A-Za-z][\w-]*(?:\([^)]*\))?!:)/i;
export const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:/i;
// release-please reads a `Release-As: x.y.z` line in a commit body as a
// version override for every package the commit routes to.
export const RELEASE_AS_RE = /^Release[ -]As:/i;
export const TITLE_MAX_CHARS = 256;
export const BODY_MAX_CHARS = 60_000;

// The workflows whose runs on the head decide CI, by file name.
export const DEFAULT_CI_WORKFLOWS = Object.freeze(['full-tests.yml', 'validate.yml']);

const TRAILER_LINE = /^Workflow-ID:[ \t]*(\S+)[ \t]*$/;
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const isOid = (v) => typeof v === 'string' && OID_RE.test(v);

/** The text as a message holds it: BOM removed, CRLF and CR read as LF, blanks at both ends trimmed. */
export function normalizeText(text) {
  return String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
}

/**
 * Why an owner-supplied pull request title cannot be used, or null. The title
 * becomes a squash subject: one line, not empty, bounded.
 */
export function titleProblem(raw) {
  const text = normalizeText(raw);
  if (text === '') return 'the title is blank';
  if (text.includes('\0')) return 'the title holds a NUL byte';
  if (text.includes('\n')) return 'the title is more than one line';
  if (text.length > TITLE_MAX_CHARS) return `the title is longer than ${TITLE_MAX_CHARS} characters`;
  return null;
}

/**
 * Why an owner-supplied pull request body cannot be used, or null. A squash
 * merge makes it the commit body, so a line release-please reads as a
 * conventional headline, a breaking-change footer or a Release-As override is
 * refused (AGENTS.md:
 * neither belongs in a pull request body unless release-please should route
 * it). Prose that mentions a breaking change is fine.
 */
export function bodyProblem(raw) {
  const text = normalizeText(raw);
  if (text === '') return 'the body is blank';
  if (text.includes('\0')) return 'the body holds a NUL byte';
  if (text.length > BODY_MAX_CHARS) return `the body is longer than ${BODY_MAX_CHARS} characters`;
  for (const [i, line] of text.split('\n').entries()) {
    const bare = line.trimStart();
    if (BREAKING_FOOTER_RE.test(bare)) return `line ${i + 1} is a breaking-change footer, which release-please routes`;
    if (RELEASE_AS_RE.test(bare)) return `line ${i + 1} is a Release-As footer, which release-please reads as a version override`;
    if (HEADLINE_LINE_RE.test(bare)) return `line ${i + 1} reads as a conventional headline, which release-please routes`;
  }
  return null;
}

/**
 * The squash subject and body a single-commit landing takes, read from the
 * open pull request as it is now (AGENTS.md: the squash message comes from the
 * pull request), held to the same rules as an owner's text. `{ problem }` when
 * the pull request's title or body is missing or would be refused; the helper
 * then prints no squash command.
 */
export function squashText(pr) {
  if (typeof pr?.title !== 'string') return { problem: 'title could not be read' };
  if (typeof pr?.body !== 'string') return { problem: 'body could not be read' };
  const tp = titleProblem(pr.title);
  if (tp) return { problem: `title: ${tp}` };
  const bp = bodyProblem(pr.body);
  if (bp) return { problem: `body: ${bp}` };
  return { title: normalizeText(pr.title), body: normalizeText(pr.body) };
}

/** The workflow a commit message names in its last Workflow-ID trailer, or null. */
export function workflowOfMessage(message) {
  let named = null;
  for (const line of String(message).split(/\r?\n/)) {
    const m = TRAILER_LINE.exec(line);
    if (m) named = m[1];
  }
  return named;
}

/**
 * A commit message split into its subject and its body without the trailer
 * block git appended last (the lines from the last blank line on that are all
 * `Key: value` with a Workflow-ID among them).
 */
export function splitMessage(message) {
  const text = String(message).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const [subject, ...rest] = text.split('\n');
  const paragraphs = rest.join('\n').replace(/^\n+/, '').split(/\n\n/);
  const last = paragraphs.at(-1) ?? '';
  const lines = last.split('\n');
  const trailerBlock = lines.length > 0 && lines.every((l) => /^[A-Za-z][\w-]*:[ \t]/.test(l)) && lines.some((l) => TRAILER_LINE.test(l));
  const body = (trailerBlock ? paragraphs.slice(0, -1) : paragraphs).join('\n\n').trim();
  return { subject: subject ?? '', body };
}

/**
 * The release-please package a path belongs to: the longest key of
 * `packages` it lies under, or null (an exempt path).
 */
export function packageOf(filePath, packageKeys) {
  let best = null;
  for (const key of packageKeys) {
    if (key === '.' || key === '') continue;
    if (filePath === key || filePath.startsWith(`${key}/`)) {
      if (best === null || key.length > best.length) best = key;
    }
  }
  return best;
}

/** The package keys of a release-please-config.json text, or null when it cannot be read as one. */
export function packageKeysOf(configText) {
  let doc;
  try {
    doc = JSON.parse(configText);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object' || !doc.packages || typeof doc.packages !== 'object') return null;
  return Object.keys(doc.packages);
}

/**
 * The checks every commit of the interval must pass before anything is
 * rewritten or published (ADR-0062 amendment; plan revisions R5 and R10).
 * `commits` is the interval oldest first: { sha, parents, message, paths }.
 * Returns { ok: true, packages } with the package of each commit (null for
 * one touching only exempt paths), or { ok: false, reason, detail }.
 */
export function checkInterval(commits, { child, packageKeys }) {
  const refuse = (reason, detail) => ({ ok: false, reason, detail });
  if (!Array.isArray(commits) || commits.length === 0) {
    return refuse('empty-interval', 'the branch holds no commit that the integration branch does not; there is nothing to land');
  }
  const packages = [];
  for (const c of commits) {
    const short = String(c.sha).slice(0, 12);
    if (Array.isArray(c.parents) && c.parents.length > 1) {
      return refuse('merge-commit', `${short} is a merge commit; the helper keeps each commit as it is and lands a linear series only. Rebase the branch by hand, keeping each commit's message, then run it again`);
    }
    const named = workflowOfMessage(c.message);
    if (named === null) {
      return refuse('commit-without-workflow', `${short} carries no Workflow-ID trailer; a commit no workflow made makes the landing not comparable (ADR-0069). Commit it through /engineer:commit, or land it by hand`);
    }
    if (named !== child) {
      return refuse('commit-of-other-workflow', `${short} names workflow ${named}, not the subtask's ${child}`);
    }
    const touched = new Set((c.paths ?? []).map((p) => packageOf(p, packageKeys)).filter((p) => p !== null));
    if (touched.size > 1) {
      return refuse('cross-package-commit', `${short} touches the packages ${[...touched].sort().join(', ')}; release-please would route it to each (AGENTS.md § Cross-package commit splitting). Split it, one commit per package`);
    }
    packages.push(touched.size === 1 ? [...touched][0] : null);
  }
  return { ok: true, packages };
}

/**
 * Whether a rebased series is the original one moved: as many commits, each
 * with the same message byte for byte and the same set of paths. A commit the
 * rebase dropped (already upstream, or newly empty) or changed is refused.
 */
export function rebasedSeriesProblem(before, after) {
  if (after.length !== before.length) {
    return `the rebase gave ${after.length} commit(s) for ${before.length}: a commit is already upstream or became empty, and the helper never drops one. Rebase by hand`;
  }
  for (let i = 0; i < before.length; i += 1) {
    const a = before[i];
    const b = after[i];
    if (a.message !== b.message) return `the rebase changed the message of ${String(a.sha).slice(0, 12)}`;
    const pa = [...new Set(a.paths ?? [])].sort().join('\0');
    const pb = [...new Set(b.paths ?? [])].sort().join('\0');
    if (pa !== pb) return `the rebase changed the paths ${String(a.sha).slice(0, 12)} touches`;
  }
  return null;
}

/**
 * Whether the remote branch head may be replaced by the local one (plan
 * revision R6). The remote head is accepted when absent, equal to the local
 * head, or an ancestor of it; or when it is an ancestor of, or equal to, a
 * head the local head was rebased from, directly or through earlier rebases.
 * `lineage` is every rebase this helper made on this branch, as
 * { before, after } pairs (each rebase appends its pair, and none is ever
 * dropped); the heads the local head descends from by rebase are the chain
 * walked back from it, after to before. So a first rebase pushed and then
 * rebased again, and a rebase whose ref move never happened (the local head is
 * still the earlier one), keep the remote accepted; a head of another chain
 * (a series someone grew and rebased, while the local branch was reset to an
 * older rebase) does not. Anything else is a movement nobody explained:
 * refused.
 *
 * `ancestor(a, b)` answers whether a is an ancestor of, or equal to, b.
 */
export function remoteHeadProblem({ remote, local, lineage = [], ancestor }) {
  if (remote === null) return null;
  if (remote === local) return null;
  if (ancestor(remote, local)) return null;
  const pairs = (Array.isArray(lineage) ? lineage : []).filter((p) => p && isOid(p.before) && isOid(p.after));
  const chain = new Set([local]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of pairs) {
      if (chain.has(p.after) && !chain.has(p.before)) {
        chain.add(p.before);
        grew = true;
      }
    }
  }
  chain.delete(local);
  if ([...chain].some((h) => ancestor(remote, h))) return null;
  return `origin's branch is at ${remote.slice(0, 12)}, which is neither the local head nor a head this helper rebased it from: someone else pushed to it, or the local branch was rewritten by hand. Look at both, then reconcile them by hand`;
}

/**
 * The pull request of this attempt, chosen as `resolveLanding` chooses one
 * (landing.mjs): head the subtask branch, from this repository, opened after
 * the dispatch. Its base must be the integration branch.
 *
 * { pr: null } when none is open (create one); { pr } for the one open;
 * { refused, detail } when one already merged or closed, several are open, or
 * the open one has another base.
 */
export function selectPullRequest(prs, { branch, integration, since }) {
  const list = (Array.isArray(prs) ? prs : []).filter((p) => p && p.headRefName === branch && p.isCrossRepository !== true);
  const attempt = since instanceof Date && !Number.isNaN(since.getTime())
    ? list.filter((p) => Date.parse(p.createdAt) >= since.getTime())
    : list;
  const done = attempt.filter((p) => p.state === 'MERGED' || p.state === 'CLOSED');
  if (done.length > 0) {
    const p = done[0];
    return {
      refused: p.state === 'MERGED' ? 'already-merged' : 'closed',
      detail: p.state === 'MERGED'
        ? `pull request #${p.number} of this attempt already merged; record the subtask with /orchestrator:done`
        : `pull request #${p.number} of this attempt was closed without a merge; reopen it, or decide by hand`,
    };
  }
  const open = attempt.filter((p) => p.state === 'OPEN');
  if (open.length > 1) {
    return { refused: 'ambiguous-pr', detail: `pull requests ${open.map((p) => `#${p.number}`).join(', ')} are all open for ${branch}; close all but one` };
  }
  if (open.length === 0) return { pr: null };
  const [pr] = open;
  if (pr.baseRefName !== integration) {
    return { refused: 'base-mismatch', detail: `pull request #${pr.number} targets ${pr.baseRefName}, not the integration branch ${integration}; retarget it` };
  }
  return { pr };
}

const GREEN = new Set(['success']);

/**
 * CI on one head (plan revision R9): for each required workflow, the latest
 * attempt of its runs on that exact head decides. A run on another sha never
 * counts. Missing, queued or running is pending; any conclusion but success
 * (cancelled, skipped and neutral included) is not green.
 *
 * `runsByWorkflow` maps a workflow file to the runs `gh run list` gave for it.
 * Returns { state: 'green'|'pending'|'failed', workflows: [{ workflow, state,
 * conclusion, url, run_id }] }.
 */
export function ciVerdict(runsByWorkflow, { head, workflows = DEFAULT_CI_WORKFLOWS }) {
  const out = [];
  for (const workflow of workflows) {
    const runs = (runsByWorkflow?.[workflow] ?? []).filter((r) => r && r.headSha === head);
    if (runs.length === 0) {
      out.push({ workflow, state: 'missing', conclusion: null, url: null, run_id: null });
      continue;
    }
    // The latest attempt: a rerun of an older run starts after a newer run
    // did, so attempts are ordered by when they started (gh's startedAt, which
    // a rerun moves), then by creation, run id and attempt number.
    const when = (r) => Date.parse(r.startedAt) || Date.parse(r.createdAt) || 0;
    const latest = runs.reduce((a, b) => {
      if (when(b) !== when(a)) return when(b) > when(a) ? b : a;
      const ca = Date.parse(a.createdAt) || 0;
      const cb = Date.parse(b.createdAt) || 0;
      if (cb !== ca) return cb > ca ? b : a;
      if ((b.databaseId ?? 0) !== (a.databaseId ?? 0)) return (b.databaseId ?? 0) > (a.databaseId ?? 0) ? b : a;
      return (b.attempt ?? 0) > (a.attempt ?? 0) ? b : a;
    });
    const base = { workflow, url: latest.url ?? null, run_id: latest.databaseId ?? null };
    if (latest.status !== 'completed') out.push({ ...base, state: 'pending', conclusion: null });
    else if (GREEN.has(latest.conclusion)) out.push({ ...base, state: 'green', conclusion: latest.conclusion });
    else out.push({ ...base, state: 'failed', conclusion: latest.conclusion ?? 'unknown' });
  }
  const state = out.some((w) => w.state === 'failed') ? 'failed'
    : out.every((w) => w.state === 'green') ? 'green' : 'pending';
  return { state, workflows: out };
}

/**
 * The next stage, from the facts of one look. Each stage is derived again on
 * every run, so a run interrupted anywhere resumes where the facts say.
 *
 * facts: { contains_tip, local, remote, comparison_recorded, pr, ci }
 *   - contains_tip: the branch contains the integration tip
 *   - comparison_recorded: a committed comparison is recorded for `local`
 *   - pr: the open pull request of this attempt, or null
 *   - ci: the verdict for `local`, or null when not read yet
 */
export function nextStage(facts) {
  if (!facts.contains_tip) return 'rebase';
  if (!facts.comparison_recorded) return 'record-comparison';
  if (facts.remote !== facts.local) return 'push';
  if (facts.pr === null || facts.pr === undefined) return 'open-pr';
  if (facts.pr.headRefOid && facts.pr.headRefOid !== facts.local) return 'wait-pr-head';
  if (!facts.ci || facts.ci.state === 'pending') return 'wait-ci';
  if (facts.ci.state === 'failed') return 'ci-failed';
  return 'ready';
}

/** A pull request body for a series: the one commit's body, or each commit's subject and body in order. */
export function defaultPullRequestBody(commits) {
  const parts = commits.map((c) => splitMessage(c.message));
  if (parts.length === 1) return parts[0].body || parts[0].subject;
  return parts.map((p) => (p.body ? `- ${p.subject}\n\n${p.body.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n')}` : `- ${p.subject}`)).join('\n\n');
}

/**
 * The commands the owner runs to merge (ADR-0062: the merge is the owner's).
 * Both bind the head with --match-head-commit, so a push after the readiness
 * report makes GitHub refuse the merge. A series of several commits lands by
 * rebase, keeping each commit and its package routing; a single commit may
 * also be squashed with the title and body files the helper kept, read through
 * a variable a program filled, never interpolated text.
 */
export function mergeCommands({ repo = null, prNumber, head, commitCount, titleFile = null, bodyFile = null }) {
  const n = Number(prNumber);
  // Bound to the repository origin names, as every gh call of the helper is.
  const r = typeof repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? ` --repo ${repo}` : '';
  const lines = [`gh pr merge ${n}${r} --rebase --match-head-commit ${head}`];
  if (commitCount === 1 && titleFile && bodyFile) {
    lines.push(`TITLE="$(cat '${titleFile.replaceAll("'", "'\\''")}')" && gh pr merge ${n}${r} --squash --match-head-commit ${head} --subject "$TITLE" --body-file '${bodyFile.replaceAll("'", "'\\''")}'`);
  }
  return lines;
}
