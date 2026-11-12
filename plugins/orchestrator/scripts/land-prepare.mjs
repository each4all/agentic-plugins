#!/usr/bin/env node
// plugins/orchestrator/scripts/land-prepare.mjs
//
// ADR-0062, amendment of 2026-11-11 — prepare a committed macro subtask for
// its landing, for the owner to merge. Owner-invoked only: it refuses under an
// autopilot run (AGENTIC_AUTOPILOT), so a worker's no-push boundary and the
// git-level push block stay as they are, and it never merges (ADR-0062: the
// merge is the owner's; /orchestrator:done records it afterwards).
//
//   node land-prepare.mjs --subtask <id> (--macro <id> | --workflow-path <macro.md>)
//        [--repo <checkout>] [--title-file <f>] [--body-file <f>]
//        [--workflow <file.yml>]... [--ci-timeout <s>] [--poll <s>]
//        [--format text|json] [--execute]
//
// Dry-run by default: it fetches the integration branch and the subtask
// branch into their remote-tracking refs, reads, and reports the stage the
// branch is at and what --execute would do. It writes no branch ref, makes no
// scratch worktree, pushes nothing and opens no pull request.
//
// With --execute it runs the stages, each derived again from git and GitHub
// on every look, so a run interrupted anywhere resumes on the next one:
//
//   1. preflight, before any write: the subtask's engineer workflow is
//      archived commit-complete; every commit of origin/<integration>..<branch>
//      names it in its Workflow-ID trailer, is not a merge, and touches at most
//      one release-please package; the title and body files pass the release
//      text rules; gh is authenticated; a push to origin reaches the URL its
//      fetch does (no pushurl or pushInsteadOf elsewhere); the engineer CLI can
//      record a committed comparison;
//   2. rebase onto origin/<integration> when the branch does not contain its
//      tip, in a scratch detached worktree with hooks, update-refs and
//      autosquash off; a conflict leaves the branch ref untouched; the result
//      must keep every commit, message and path set, and the ref moves by
//      compare-and-swap, refused while any worktree has the branch checked out;
//   3. the committed comparison (ADR-0069 Decision 2) recorded for the head
//      when none is (a rebase changes the head), through the engineer's
//      `state.mjs review-binding-record`, in a scratch worktree at the head;
//   4. push the head sha with a lease on the remote head it read, so a remote
//      that moved since is refused, never overwritten; a remote at a head the
//      local head was rebased from (the chain of lineage.jsonl walked back) is
//      the helper's own and may be replaced;
//   5. the pull request of this attempt reused (head the branch, base the
//      integration branch, opened after the dispatch), or opened;
//   6. CI: the latest run of each required workflow on that exact head;
//   7. a recheck of the local head, remote head, pull request head and
//      integration tip, then the readiness report with the merge command,
//      which binds the head (--match-head-commit).
//
// Exit codes: 0 ready (or the dry-run report), 1 refused, 2 usage,
// 3 not ready yet (CI pending past --ci-timeout), 4 CI failed.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { absorbOutputErrors, exitAfterFlush, isCliEntry } from './lib/cli-entry.mjs';
import {
  DEFAULT_CI_WORKFLOWS, bodyProblem, checkInterval, ciVerdict, defaultPullRequestBody, isOid,
  mergeCommands, nextStage, normalizeText, packageKeysOf, rebasedSeriesProblem, remoteHeadProblem,
  selectPullRequest, splitMessage, squashText, titleProblem,
} from './lib/land-prepare-plan.mjs';
import { defaultStateRoot, repositoryRoots } from './lib/state-root.mjs';

export const EXIT = Object.freeze({ READY: 0, REFUSED: 1, USAGE: 2, PENDING: 3, CI_FAILED: 4 });
export const LANDING_RUNS_REL = '.agentic-plugins/runs/landing';
export const SCRATCH_PREFIX = 'agentic-land-prepare-';
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PR_FIELDS = 'number,url,state,baseRefName,headRefName,createdAt,headRefOid,isCrossRepository,title,body';
const RUN_FIELDS = 'databaseId,headSha,status,conclusion,createdAt,startedAt,attempt,url,workflowName';
// Stages that change something, at most this many per run: a loop that keeps
// finding work stops rather than spins.
const MAX_ACTIONS = 12;
// A fetch that writes the one ref its refspec names: no configured mapping
// (an empty --refmap), no pruning, no tags, no submodules.
const OWNER_FILE = 'owner.json';
const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
};
const FETCH_OPTS = ['--no-tags', '--quiet', '--refmap=', '--no-prune', '--no-recurse-submodules', '--no-write-fetch-head'];

export class Refusal extends Error {
  constructor(reason, detail, code = EXIT.REFUSED) {
    super(detail);
    this.reason = reason;
    this.code = code;
  }
}
const refuse = (reason, detail) => { throw new Refusal(reason, detail); };

// The dispatch time a workflow id carries (landing.mjs keeps the same rule).
function dispatchTimeOf(workflowId) {
  const m = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]+$/.exec(workflowId ?? '');
  if (!m) return null;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return Number.isNaN(t) ? null : new Date(t);
}

// Variables that select a repository, worktree or index for git, or a
// repository for gh: inherited, they would point a command meant for a scratch
// worktree at the checkout (or a gh call at another repository), so every
// subprocess runs without them.
const SELECTOR_VARS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_QUARANTINE_PATH',
  'GH_REPO', 'GH_HOST',
];
// Variables that inject configuration as `git -c` does (a parent git process,
// a hook, passes them on): inherited, they could set remote.origin.pushurl or
// a url rewrite that no configuration file shows. GIT_CONFIG goes too: it
// makes `git config` read one file in place of the configuration the
// transport uses, so the checks below would read another configuration than
// the push. The owner's configuration files (GIT_CONFIG_GLOBAL, _SYSTEM,
// _NOSYSTEM) stay: every git command, `git config` included, reads them alike.
const CONFIG_INJECTION_VARS = ['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG'];
const CONFIG_INJECTION_RE = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

export function subprocessEnv(env) {
  const out = { ...env };
  for (const k of SELECTOR_VARS) delete out[k];
  for (const k of CONFIG_INJECTION_VARS) delete out[k];
  for (const k of Object.keys(out)) if (CONFIG_INJECTION_RE.test(k)) delete out[k];
  return out;
}

/**
 * Why a push to origin would not reach the repository the helper reads and
 * binds gh to, or null. git applies url.<base>.insteadOf to the fetch and the
 * push alike, and remote.origin.pushurl and url.<base>.pushInsteadOf to the
 * push alone; `git remote get-url` expands them as the push will. The push
 * must go exactly where the fetch goes (one URL, the same), and a fetch URL
 * served by GitHub must name origin's repository: a rewrite to a mirror that
 * is not on GitHub (a local or private copy) is the owner's to make. A
 * transport override (remote.origin.receivepack, uploadpack or vcs) can serve
 * another repository behind the same URL, so any is refused. The ssh command
 * (core.sshCommand, GIT_SSH_COMMAND) and credential helpers stay the owner's.
 */
export function pushDestinationProblem({ slug, fetchUrl, pushUrls, overrides = [] }) {
  const fetch = String(fetchUrl ?? '').trim();
  if (fetch === '') return 'git cannot expand origin\'s URL';
  if (overrides.length > 0) return `origin sets ${overrides.join(', ')}, which can reach another repository behind the same URL`;
  const fetchSlug = githubSlugOf(fetch);
  if (isGithubUrl(fetch) && (fetchSlug === null || slug === null || fetchSlug.toLowerCase() !== slug.toLowerCase())) {
    return `origin's configured URL names ${slug ?? 'no GitHub repository'}, but git reaches ${fetchSlug ?? fetch} (a url.<base>.insteadOf rewrite)`;
  }
  const pushes = (pushUrls ?? []).map((u) => String(u).trim()).filter(Boolean);
  if (pushes.length !== 1) return `origin pushes to ${pushes.length} URLs (${pushes.join(', ') || 'none'}), not the one it fetches from`;
  if (pushes[0] !== fetch) return `origin pushes to ${pushes[0]} but fetches from ${fetch} (remote.origin.pushurl or url.<base>.pushInsteadOf)`;
  return null;
}

// The hosts that serve github.com repositories (ssh.github.com is its ssh
// over port 443).
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com', 'ssh.github.com']);

/**
 * A remote URL's host (lower case) and path: a URL with a scheme (any port or
 * user), or git's scp form `[user@]host:path`; host null for a local path.
 */
function remoteUrlParts(url) {
  const s = String(url ?? '').trim();
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(s)) {
    try {
      const u = new URL(s);
      return { host: u.hostname.toLowerCase().replace(/\.$/, ''), path: decodeURIComponent(u.pathname) };
    } catch {
      return { host: '', path: '' };
    }
  }
  const scp = /^(?:[^@/:]+@)?([^/:]+):(?!\/\/)(.*)$/.exec(s);
  // git strips brackets around an scp host (`git@[host]:path`).
  if (scp && scp[1].length > 1) return { host: scp[1].toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, ''), path: scp[2] };
  return { host: null, path: s };
}

/** Whether a remote URL is served by GitHub, in any spelling git accepts. */
export function isGithubUrl(url) {
  return GITHUB_HOSTS.has(remoteUrlParts(url).host ?? '');
}

/**
 * The GitHub repository a remote URL names, as `owner/name`, or null: any
 * scheme, port, user or host case git accepts. Read from origin's config as
 * written, so a url.<base>.insteadOf rewrite that git applies when it talks to
 * the remote does not change the identity gh is bound to (the push check
 * below compares the rewritten one).
 */
export function githubSlugOf(url) {
  const { host, path: p } = remoteUrlParts(url);
  if (!GITHUB_HOSTS.has(host ?? '')) return null;
  const m = /^\/?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(p);
  return m ? `${m[1]}/${m[2]}` : null;
}

function makeRunners(rawEnv) {
  const env = subprocessEnv(rawEnv);
  const run = (cmd, args, { cwd, input, timeout = 120_000 } = {}) => {
    const r = spawnSync(cmd, args, { cwd, env, input, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
    return {
      ok: r.status === 0, code: r.status, stdout: r.stdout ?? '',
      stderr: ((r.stderr ?? '').trim() || (r.error ? r.error.message : '')),
    };
  };
  return {
    git: (cwd, args, o = {}) => run('git', ['-C', cwd, ...args], o),
    gh: (cwd, args, o = {}) => run('gh', args, { cwd, timeout: 60_000, ...o }),
    node: (cwd, args, o = {}) => run(process.execPath, args, { cwd, ...o }),
  };
}

const firstLine = (s) => String(s ?? '').split('\n')[0];

/** The macro file for --macro <id>: the one active macro of that id in the repository's roots. */
function findMacro(repoRoot, macroId) {
  if (!SAFE_ID.test(macroId)) refuse('bad-macro-id', `--macro ${JSON.stringify(macroId)} is not a workflow id`);
  const found = [];
  for (const root of repositoryRoots(repoRoot)) {
    const file = path.join(root, '.agentic-plugins', 'state', 'orchestrator', 'workflows', `${macroId}.md`);
    try {
      const real = fs.realpathSync(file);
      if (!found.includes(real)) found.push(real);
    } catch { /* absent here */ }
  }
  if (found.length === 0) refuse('no-macro', `no active macro ${macroId} in this repository's state roots; pass --workflow-path`);
  if (found.length > 1) refuse('ambiguous-macro', `macro ${macroId} has several active files (${found.join(', ')}); pass --workflow-path`);
  return found[0];
}

function readText(file, what) {
  try {
    const buf = fs.readFileSync(file);
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (err) {
    refuse('unreadable-file', `${what} ${file} cannot be read as UTF-8 text (${err.message})`);
  }
  return null;
}

/**
 * The committed comparison the child workflow records for `commit`, read from
 * its frontmatter (`review_bindings`, a JSON document in a string scalar):
 * { state, record } with state 'recorded', 'none' or 'unreadable'.
 */
export function readComparison(childFile, commit) {
  let text;
  try {
    text = fs.readFileSync(childFile, 'utf8');
  } catch {
    return { state: 'unreadable', record: null };
  }
  const end = text.indexOf('\n---\n', 4);
  const fm = end === -1 ? text : text.slice(0, end);
  const m = /^review_bindings:[ \t]*(.*)$/m.exec(fm);
  if (!m) return { state: 'none', record: null };
  try {
    const raw = JSON.parse(m[1]);
    const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
    // The engineer's reader refuses a later version, and a record with no
    // manifest digest answers nothing (review-attempts.mjs decodeReviewBindings,
    // change-identity.mjs compareLanded).
    if (!doc || typeof doc !== 'object' || !Number.isInteger(doc.v) || doc.v > 1) return { state: 'unreadable', record: null };
    const comparisons = doc.comparisons && typeof doc.comparisons === 'object' ? doc.comparisons : {};
    if (!Object.hasOwn(comparisons, commit)) return { state: 'none', record: null };
    const record = comparisons[commit];
    if (!record || typeof record !== 'object' || !/^[0-9a-f]{64}$/.test(record.manifest_sha256 ?? '')) return { state: 'unreadable', record: null };
    return { state: 'recorded', record };
  } catch {
    return { state: 'unreadable', record: null };
  }
}

/**
 * Prepare one subtask for its landing. Returns { code, report }; the report is
 * what the CLI prints. `env`, `sleep`, `now` and `discoverEngineer` are seams.
 */
export async function prepareLanding({
  repo = process.cwd(), macroId = null, workflowPath = null, subtaskId,
  execute = false, titleFile = null, bodyFile = null,
  workflows = DEFAULT_CI_WORKFLOWS, ciTimeoutS = 1800, pollS = 30,
  env = process.env,
  sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }),
  now = () => new Date(),
  discoverEngineer = null,
  log = () => {},
}) {
  const { git, gh, node } = makeRunners(env);
  const report = { mode: execute ? 'execute' : 'dry-run', actions: [], notes: [] };
  const act = (what) => { report.actions.push(what); log(`· ${what}`); };

  // ADR-0063 — never inside an autopilot run: a worker does not push.
  if (typeof env.AGENTIC_AUTOPILOT === 'string' && env.AGENTIC_AUTOPILOT !== '') {
    refuse('autopilot', `refused under an autopilot run (AGENTIC_AUTOPILOT=${env.AGENTIC_AUTOPILOT}): landing preparation is the owner's, outside the run; the worker's no-push boundary stays`);
  }
  if (typeof subtaskId !== 'string' || !SAFE_ID.test(subtaskId)) refuse('usage', '--subtask <id> is required');
  const top = git(repo, ['rev-parse', '--show-toplevel']);
  if (!top.ok) refuse('not-a-checkout', `${repo} is not a git checkout (${top.stderr})`);
  const repoRoot = top.stdout.trim();

  // The macro, the subtask, its branch, its child and the integration branch.
  const macroFile = workflowPath ? path.resolve(workflowPath) : findMacro(repoRoot, macroId ?? '');
  const macroName = path.basename(macroFile, '.md');
  const { readWorkflow, ownerDispatch } = await import('./state.mjs');
  const { frontmatter } = await readWorkflow(macroFile);
  const subtasks = Array.isArray(frontmatter?.plan?.subtasks) ? frontmatter.plan.subtasks : [];
  const subtask = subtasks.find((s) => s?.id === subtaskId);
  if (!subtask) refuse('no-subtask', `subtask ${subtaskId} is not in ${macroName}'s plan`);
  const branch = subtask.branch;
  const child = subtask.engineer_workflow_id;
  const integration = frontmatter?.git_baseline?.branch;
  if (!SAFE_NAME.test(branch ?? '') || !git(repoRoot, ['check-ref-format', '--branch', branch]).ok) refuse('bad-branch', `subtask ${subtaskId} records no usable branch (${JSON.stringify(branch)})`);
  if (!SAFE_NAME.test(integration ?? '') || !git(repoRoot, ['check-ref-format', '--branch', integration]).ok) refuse('bad-integration', `${macroName} records no usable git_baseline.branch (${JSON.stringify(integration)})`);
  if (typeof child !== 'string' || child === '') {
    refuse('no-child', `subtask ${subtaskId} records no engineer workflow; record it first (/orchestrator:done prints the subtask-update), then run this again`);
  }
  Object.assign(report, { macro: macroName, subtask: subtaskId, branch, integration, child });

  // Plan revision R5 — the child is archived, committed, and claims the subtask.
  let found;
  try {
    found = ownerDispatch({ repoRoot, macroId: macroName, subtaskId, owner: child });
  } catch (err) {
    refuse('child-unreadable', `the engineer workflow homes cannot be read (${err.message})`);
  }
  if (found.status !== 'found') refuse('child-not-found', `engineer workflow ${child} is ${found.status === 'elsewhere' ? 'not dispatched for this subtask' : 'not in any engineer home of the repository'}`);
  const claim = found.claim;
  if (claim.active) refuse('child-active', `engineer workflow ${child} is still active; it lands once /engineer:commit has committed it and it is archived`);
  const phases = new Set(claim.files.map((f) => f.values.current_phase));
  if (phases.size !== 1 || !phases.has('commit-complete')) {
    refuse('child-not-committed', `engineer workflow ${child} ended ${[...phases].join(', ') || 'with no phase'}, not commit-complete; there is no commit to land`);
  }
  const childFile = claim.paths[0];

  // Plan revision R4 — the owner's title and body, checked before any write.
  let title = null;
  let body = null;
  if (titleFile) {
    title = readText(titleFile, '--title-file');
    const p = titleProblem(title);
    if (p) refuse('bad-title', `--title-file: ${p}`);
    title = title.replace(/^﻿/, '').trim();
  }
  if (bodyFile) {
    body = readText(bodyFile, '--body-file');
    const p = bodyProblem(body);
    if (p) refuse('bad-body', `--body-file: ${p}`);
    body = body.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  }

  // gh: required to execute; a dry run reports without it. Every gh call is
  // bound to the repository origin names (--repo), never to GH_REPO or gh's
  // own default, so the pull request is the one of the branch this pushes.
  const slug = githubSlugOf(git(repoRoot, ['config', '--get', 'remote.origin.url']).stdout);
  if (slug === null && execute) refuse('origin-not-github', 'origin is not a github.com repository URL, so no pull request can be bound to it; push and open the pull request by hand');
  let ghOk = false;
  if (slug !== null) {
    const auth = gh(repoRoot, ['auth', 'status']);
    if (!auth.ok && execute) refuse('gh-unavailable', `gh is not available or not authenticated (${firstLine(auth.stderr)}); run gh auth login, or push and open the pull request by hand`);
    if (auth.ok) {
      const view = gh(repoRoot, ['repo', 'view', slug, '--json', 'nameWithOwner']);
      let name = null;
      try { name = JSON.parse(view.stdout).nameWithOwner ?? null; } catch { /* below */ }
      if (!view.ok || typeof name !== 'string' || name.toLowerCase() !== slug.toLowerCase()) {
        if (execute) refuse('repo-unknown', `gh does not confirm origin's repository ${slug} (${view.ok ? `it answered ${JSON.stringify(name)}` : firstLine(view.stderr)})`);
        report.notes.push(`gh does not confirm origin's repository ${slug}: the pull request and CI are not read`);
      } else {
        ghOk = true;
      }
    } else {
      report.notes.push(`gh is not available (${firstLine(auth.stderr)}): the pull request and CI are not read`);
    }
  } else {
    report.notes.push('origin is not a github.com repository URL: the pull request and CI are not read');
  }
  report.repository = slug;
  // The push goes where the fetch goes, the repository gh is bound to.
  {
    const fetchUrl = git(repoRoot, ['remote', 'get-url', 'origin']);
    const pushUrls = git(repoRoot, ['remote', 'get-url', '--push', '--all', 'origin']);
    // Exit 1 is "no such key"; anything else cannot vouch for their absence.
    const transport = git(repoRoot, ['config', '--get-regexp', '^remote\\.origin\\.(receivepack|uploadpack|vcs)$']);
    const overrides = transport.ok ? transport.stdout.split('\n').filter(Boolean).map((l) => l.split(' ')[0]) : [];
    const problem = !fetchUrl.ok || !pushUrls.ok
      ? `git remote get-url origin failed (${firstLine(fetchUrl.stderr || pushUrls.stderr)})`
      : !transport.ok && transport.code !== 1
        ? `git config cannot read origin's transport settings (${firstLine(transport.stderr)})`
        : pushDestinationProblem({ slug, fetchUrl: fetchUrl.stdout, pushUrls: pushUrls.stdout.split('\n'), overrides });
    if (problem && execute) refuse('push-destination', `${problem}; the push would not reach the repository whose pull request and CI are read. Remove the setting, or push and open the pull request by hand`);
    if (problem) report.notes.push(`${problem}: --execute would refuse`);
  }
  const ghR = (args) => gh(repoRoot, [...args, '--repo', slug]);

  // The engineer CLI that records a committed comparison.
  let engineerRoot = null;
  {
    const discover = discoverEngineer ?? (async () => {
      const { discoverEngineerPluginRoot } = await import('./discover-engineer.mjs');
      return discoverEngineerPluginRoot({ env });
    });
    try { engineerRoot = await discover(); } catch { engineerRoot = null; }
    let capable = false;
    if (engineerRoot) {
      try { capable = fs.readFileSync(path.join(engineerRoot, 'scripts', 'state.mjs'), 'utf8').includes("'review-binding-record'"); } catch { capable = false; }
    }
    if (!capable) {
      if (execute) refuse('engineer-incapable', `no installed engineer CLI records a committed comparison (review-binding-record${engineerRoot ? `, not in ${engineerRoot}` : ''}); install an engineer release that ships it`);
      report.notes.push('no installed engineer CLI records a committed comparison; --execute would refuse');
      engineerRoot = null;
    }
  }

  // Plan revision R10 — a shallow clone cannot show the interval.
  if (git(repoRoot, ['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true') {
    refuse('shallow', 'the clone is shallow; run git fetch --unshallow origin, then run this again');
  }

  const runDir = path.join(defaultStateRoot(repoRoot), LANDING_RUNS_REL, macroName, subtaskId);
  // Every head this helper rebased the branch from or to, one line per
  // rebase, appended and never rewritten: an interrupted rebase, a lost
  // compare-and-swap or a rebase of a pushed rebase leaves every earlier pair
  // readable, so the remote stays accepted for what the helper itself made. A
  // line cut short is skipped (each append starts on a new line).
  const lineageFile = path.join(runDir, 'lineage.jsonl');
  const readLineage = () => {
    let text;
    try { text = fs.readFileSync(lineageFile, 'utf8'); } catch { return []; }
    const pairs = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let r = null;
      try { r = JSON.parse(line); } catch { continue; }
      if (r && r.branch === branch && isOid(r.before) && isOid(r.after)) pairs.push({ before: r.before, after: r.after });
    }
    return pairs;
  };

  const tipRef = `refs/remotes/origin/${integration}`;
  const remoteRef = `refs/remotes/origin/${branch}`;
  const ancestor = (a, b) => a === b || git(repoRoot, ['merge-base', '--is-ancestor', a, b]).ok;
  const commitsOf = (from, to) => {
    const list = git(repoRoot, ['rev-list', '--reverse', '--topo-order', '--parents', `${from}..${to}`]);
    if (!list.ok) refuse('interval-unreadable', `git rev-list ${from}..${to} failed (${list.stderr})`);
    return list.stdout.split('\n').filter(Boolean).map((line) => {
      const [sha, ...parents] = line.split(' ');
      const raw = git(repoRoot, ['cat-file', 'commit', sha]);
      if (!raw.ok) refuse('interval-unreadable', `git cat-file commit ${sha} failed`);
      const at = raw.stdout.indexOf('\n\n');
      const message = at === -1 ? '' : raw.stdout.slice(at + 2);
      const names = git(repoRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', sha]);
      return { sha, parents, message, paths: names.stdout.split('\0').filter(Boolean) };
    });
  };

  // One look: fetch, then every fact the stages are derived from.
  const look = () => {
    const fetched = git(repoRoot, ['fetch', ...FETCH_OPTS, 'origin', `+refs/heads/${integration}:${tipRef}`]);
    if (!fetched.ok) refuse('fetch-failed', `git fetch origin ${integration} failed (${firstLine(fetched.stderr)})`);
    const ls = git(repoRoot, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
    if (!ls.ok) refuse('ls-remote-failed', `git ls-remote origin failed (${firstLine(ls.stderr)})`);
    const remoteLine = ls.stdout.split('\n').find((l) => l.endsWith(`\trefs/heads/${branch}`));
    const remote = remoteLine ? remoteLine.split('\t')[0] : null;
    if (remote !== null) {
      const f = git(repoRoot, ['fetch', ...FETCH_OPTS, 'origin', `+refs/heads/${branch}:${remoteRef}`]);
      if (!f.ok) refuse('fetch-failed', `git fetch origin ${branch} failed (${firstLine(f.stderr)})`);
    }
    const localRead = git(repoRoot, ['show-ref', '--verify', '--hash', `refs/heads/${branch}`]);
    if (!localRead.ok) refuse('no-branch', `the branch ${branch} does not exist in this repository`);
    const local = localRead.stdout.trim();
    const tip = git(repoRoot, ['show-ref', '--verify', '--hash', tipRef]).stdout.trim();
    if (!isOid(tip)) refuse('no-integration-ref', `${tipRef} cannot be read after the fetch`);
    const bases = git(repoRoot, ['merge-base', '--all', local, tip]).stdout.split('\n').filter(Boolean);
    if (bases.length === 0) refuse('unrelated-histories', `${branch} and origin/${integration} share no history`);
    if (bases.length > 1) refuse('several-merge-bases', `${branch} and origin/${integration} have ${bases.length} merge bases (a criss-cross history); land it by hand`);
    return { local, remote, tip, contains_tip: ancestor(tip, local) };
  };

  // The package map from the integration tip (R10); none when it has no config.
  const packageKeys = (tip) => {
    const cfg = git(repoRoot, ['show', `${tip}:release-please-config.json`]);
    if (!cfg.ok) return [];
    const keys = packageKeysOf(cfg.stdout);
    if (keys === null) refuse('config-unreadable', `release-please-config.json at origin/${integration} cannot be read`);
    return keys;
  };

  const preflight = (facts) => {
    const commits = commitsOf(facts.tip, facts.local);
    const checked = checkInterval(commits, { child, packageKeys: packageKeys(facts.tip) });
    if (!checked.ok) refuse(checked.reason, checked.detail);
    const problem = remoteHeadProblem({ remote: facts.remote, local: facts.local, lineage: readLineage(), ancestor });
    if (problem) refuse('remote-moved', problem);
    return { commits, packages: checked.packages };
  };

  // Every worktree that has the branch checked out (R7); a list git cannot
  // give refuses, since it could hide one.
  const holders = () => {
    const r = git(repoRoot, ['worktree', 'list', '--porcelain', '-z']);
    if (!r.ok) refuse('worktrees-unreadable', `git worktree list failed (${r.stderr})`);
    const out = [];
    let at = null;
    for (const field of r.stdout.split('\0')) {
      if (field.startsWith('worktree ')) at = field.slice(9);
      else if (field === `branch refs/heads/${branch}` && at !== null) out.push(at);
    }
    return out;
  };

  const scratchRoots = new Set();
  const newScratch = (commit) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), SCRATCH_PREFIX));
    scratchRoots.add(dir);
    const wt = path.join(dir, 'wt');
    // Its owner, so a later run tells an orphan from a scratch in use.
    fs.writeFileSync(path.join(dir, OWNER_FILE), `${JSON.stringify({ pid: process.pid, at: now().toISOString() })}\n`);
    const add = git(repoRoot, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--quiet', '--detach', wt, commit]);
    if (!add.ok) {
      dropScratch(dir);
      refuse('scratch-failed', `git worktree add failed (${firstLine(add.stderr)})`);
    }
    // The scratch must be its own worktree of this repository before anything
    // runs in it: a command there must never reach the checkout.
    const top = git(wt, ['rev-parse', '--show-toplevel']).stdout.trim();
    let same = false;
    try { same = top !== '' && fs.realpathSync(top) === fs.realpathSync(wt); } catch { same = false; }
    if (!same) {
      dropScratch(dir);
      refuse('scratch-failed', `the scratch worktree ${wt} resolves to ${JSON.stringify(top)}, not itself; nothing was changed`);
    }
    return { dir, wt };
  };
  // A scratch is removed only once git has let go of its worktree: a
  // directory git still registers (a locked worktree, a removal refused) stays.
  function dropScratch(dir) {
    const wt = path.join(dir, 'wt');
    const removed = git(repoRoot, ['worktree', 'remove', '--force', wt]);
    if (removed.ok || !fs.existsSync(wt)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* left in the temp directory */ }
    }
    git(repoRoot, ['worktree', 'prune']);
    scratchRoots.delete(dir);
  }
  // Scratch worktrees an interrupted run left behind: ones whose directory is
  // gone (git worktree prune), and ones whose owner process is dead and that
  // are not locked. A scratch of a run going on now keeps its own.
  const pruneOrphans = () => {
    const r = git(repoRoot, ['worktree', 'list', '--porcelain', '-z']);
    const entries = [];
    for (const field of r.stdout.split('\0')) {
      if (field.startsWith('worktree ')) entries.push({ wt: field.slice(9), locked: false });
      else if (field === 'locked' || field.startsWith('locked ')) { if (entries.length) entries.at(-1).locked = true; }
    }
    for (const { wt, locked } of entries) {
      const dir = path.dirname(wt);
      if (locked || path.basename(wt) !== 'wt' || !path.basename(dir).startsWith(SCRATCH_PREFIX)) continue;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8')); } catch { owner = null; }
      if (!owner || !Number.isInteger(owner.pid) || processAlive(owner.pid)) continue;
      dropScratch(dir);
    }
    git(repoRoot, ['worktree', 'prune']);
  };

  const rebase = (facts, before) => {
    const held = holders();
    if (held.length > 0) {
      refuse('branch-checked-out', `${branch} is checked out in ${held.join(', ')}; moving its ref would leave that worktree's index behind. Switch it away (git -C <worktree> switch --detach), then run this again`);
    }
    const { dir, wt } = newScratch(facts.local);
    try {
      const r = git(wt, [
        '-c', 'rebase.updateRefs=false', '-c', 'rebase.autoSquash=false', '-c', 'core.hooksPath=/dev/null',
        'rebase', '--no-autosquash', '--quiet', tipRef,
      ]);
      if (!r.ok) {
        const conflicted = git(wt, ['diff', '--name-only', '--diff-filter=U', '-z']).stdout.split('\0').filter(Boolean);
        const at = git(wt, ['rev-parse', '--verify', '--quiet', 'REBASE_HEAD']).stdout.trim();
        git(wt, ['rebase', '--abort']);
        refuse('rebase-conflict', `rebasing onto origin/${integration} stops${at ? ` at ${at.slice(0, 12)}` : ''}${conflicted.length ? ` with conflicts in ${conflicted.join(', ')}` : ` (${firstLine(r.stderr)})`}; the branch is untouched. Rebase it by hand, keeping each commit's message, then run this again`);
      }
      const rebased = git(wt, ['rev-parse', 'HEAD']).stdout.trim();
      const after = commitsOf(facts.tip, rebased);
      const problem = rebasedSeriesProblem(before, after);
      if (problem) refuse('rebase-changed-series', `${problem}; the branch is untouched`);
      const again = holders();
      if (again.length > 0) refuse('branch-checked-out', `${branch} was checked out in ${again.join(', ')} during the rebase; the branch is untouched`);
      fs.mkdirSync(runDir, { recursive: true });
      // Appended before the ref moves: if the move never happens (an
      // interruption, a run that wins the compare-and-swap), the local head is
      // still one the lineage holds, and the pair added is never used.
      fs.appendFileSync(lineageFile, `\n${JSON.stringify({ branch, before: facts.local, after: rebased, onto: facts.tip, remote_seen: facts.remote, at: now().toISOString() })}\n`);
      const moved = git(repoRoot, ['update-ref', '-m', `land-prepare: rebase onto origin/${integration}`, `refs/heads/${branch}`, rebased, facts.local]);
      if (!moved.ok) refuse('ref-moved', `refs/heads/${branch} moved during the rebase (${firstLine(moved.stderr)}); run this again`);
      act(`rebased ${branch} onto origin/${integration} (${facts.local.slice(0, 12)} → ${rebased.slice(0, 12)})`);
    } finally {
      dropScratch(dir);
    }
  };

  const recordComparison = (commit) => {
    const { dir, wt } = newScratch(commit);
    try {
      const r = node(repoRoot, [
        path.join(engineerRoot, 'scripts', 'state.mjs'), 'review-binding-record',
        '--workflow-path', childFile, '--repo-root', wt, '--landing-branch', integration, '--host', 'claude',
      ]);
      let out = null;
      try { out = JSON.parse(r.stdout); } catch { /* below */ }
      if (!r.ok || !out || out.recorded !== true || out.commit !== commit) {
        refuse('record-failed', `review-binding-record recorded no committed comparison for ${commit.slice(0, 12)} (${out ? `${out.state ?? 'no state'}${out.reason ? `: ${out.reason}` : ''}` : firstLine(r.stderr)}); nothing was pushed`);
      }
      if (readComparison(childFile, commit).state !== 'recorded') {
        refuse('record-failed', `review-binding-record answered, but ${childFile} holds no readable comparison for ${commit.slice(0, 12)}; nothing was pushed`);
      }
      act(`recorded the committed comparison for ${commit.slice(0, 12)}: ${out.state}`);
      return out;
    } finally {
      dropScratch(dir);
    }
  };

  const push = (facts) => {
    const lease = `--force-with-lease=refs/heads/${branch}:${facts.remote ?? ''}`;
    const r = git(repoRoot, ['push', '--quiet', lease, 'origin', `${facts.local}:refs/heads/${branch}`]);
    if (!r.ok) refuse('push-refused', `git push of ${facts.local.slice(0, 12)} to origin/${branch} was refused (${firstLine(r.stderr)}); the remote may have moved. Run this again to look`);
    act(`pushed ${facts.local.slice(0, 12)} to origin/${branch}${facts.remote ? ` (lease on ${facts.remote.slice(0, 12)})` : ' (new branch)'}`);
  };

  const since = dispatchTimeOf(child);
  const listPrs = () => {
    if (!ghOk) return { unknown: true };
    const r = ghR(['pr', 'list', '--head', branch, '--state', 'all', '--limit', '100', '--json', PR_FIELDS]);
    let prs = null;
    try { prs = JSON.parse(r.stdout); } catch { /* below */ }
    if (!r.ok || !Array.isArray(prs)) refuse('gh-failed', `gh pr list failed (${firstLine(r.stderr)})`);
    const chosen = selectPullRequest(prs, { branch, integration, since });
    if (chosen.refused) refuse(chosen.refused, chosen.detail);
    return chosen;
  };

  const ciOf = (head) => {
    const byWorkflow = {};
    for (const wf of workflows) {
      const r = ghR(['run', 'list', '--workflow', wf, '--commit', head, '--limit', '50', '--json', RUN_FIELDS]);
      let runs = [];
      if (r.ok) {
        try { runs = JSON.parse(r.stdout); } catch { runs = []; }
      }
      byWorkflow[wf] = Array.isArray(runs) ? runs : [];
    }
    return ciVerdict(byWorkflow, { head, workflows });
  };

  // The pull request text the helper would write, the owner's or the
  // default, held to the same rules before any write: a default body made of a
  // bare conventional headline (a commit with no body) would be routed again.
  const effectiveText = (commits) => {
    const t = title ?? splitMessage(commits[0].message).subject;
    let b = body ?? defaultPullRequestBody(commits);
    if (body === null && (normalizeText(b) === '' || bodyProblem(b) !== null)) b = `Subtask ${subtaskId} of ${macroName}.`;
    const tp = titleProblem(t);
    if (tp) refuse('bad-title', `the pull request title (${title ? '--title-file' : 'the commit subject'}): ${tp}`);
    const bp = bodyProblem(b);
    if (bp) refuse('bad-body', `the pull request body: ${bp}`);
    return { title: t, body: b };
  };
  const prBodyFile = (commits) => {
    fs.mkdirSync(runDir, { recursive: true });
    const file = path.join(runDir, 'pr-body.md');
    fs.writeFileSync(file, `${effectiveText(commits).body}\n`);
    return file;
  };

  let facts = look();
  let { commits, packages } = preflight(facts);
  // Every refusal the pull request can give comes before any write: one of
  // this attempt merged or closed, several open, another base (listPrs), and
  // the text a new or edited one would carry.
  const firstPrs = listPrs();
  if (execute && !firstPrs.unknown && firstPrs.pr === null && commits.length > 1 && !title) {
    refuse('title-required', `${commits.length} commits land together, so a pull request needs a title: pass --title-file`);
  }
  if (execute) effectiveText(commits);
  if (execute) pruneOrphans();

  let actions = 0;
  let editedPr = false;
  const deadline = Date.now() + Math.max(0, ciTimeoutS) * 1000;
  let stage;
  let pr = null;
  let ci = null;
  let comparison;
  for (;;) {
    comparison = readComparison(childFile, facts.local);
    const prChoice = listPrs();
    pr = prChoice.unknown ? null : prChoice.pr ?? null;
    ci = pr && facts.remote === facts.local && ghOk ? ciOf(facts.local) : null;
    stage = nextStage({
      contains_tip: facts.contains_tip,
      comparison_recorded: comparison.state === 'recorded',
      local: facts.local, remote: facts.remote, pr, ci,
    });
    if (!execute) break;
    // The open pull request's text, once, when the owner passed a title or a
    // body and the branch is pushed (an opened one already took them).
    if (pr && !editedPr && (title || body) && !['rebase', 'record-comparison', 'push', 'open-pr'].includes(stage)) {
      const args = ['pr', 'edit', String(pr.number)];
      if (title) args.push('--title', title);
      if (body) args.push('--body-file', prBodyFile(commits));
      const r = ghR(args);
      if (!r.ok) refuse('pr-edit-failed', `gh pr edit #${pr.number} failed (${firstLine(r.stderr)})`);
      editedPr = true;
      act(`updated pull request #${pr.number}'s ${[title && 'title', body && 'body'].filter(Boolean).join(' and ')}`);
    }
    if (stage === 'ready') {
      // R9 — recheck every head before the report; any movement starts over.
      const again = look();
      const prAgain = listPrs();
      if (again.local === facts.local && again.remote === facts.local && again.contains_tip
        && prAgain.pr && prAgain.pr.number === pr.number && prAgain.pr.headRefOid === facts.local) {
        // The pull request as it reads now, after any edit above: its title
        // and body are what a squash merge takes.
        pr = prAgain.pr;
        break;
      }
      facts = again;
      ({ commits, packages } = preflight(facts));
      if ((actions += 1) > MAX_ACTIONS) refuse('unsettled', 'the branch, the remote or the integration branch kept moving; run this again later');
      continue;
    }
    if (stage === 'ci-failed') break;
    if (stage === 'wait-ci' || stage === 'wait-pr-head') {
      if (Date.now() >= deadline) break;
      await sleep(Math.max(0, pollS) * 1000);
      facts = { ...facts, ...look() };
      ({ commits, packages } = preflight(facts));
      continue;
    }
    if ((actions += 1) > MAX_ACTIONS) refuse('unsettled', `the helper kept finding work (last stage ${stage}); run this again`);
    if (stage === 'rebase') {
      rebase(facts, commits);
    } else if (stage === 'record-comparison') {
      recordComparison(facts.local);
    } else if (stage === 'push') {
      push(facts);
    } else if (stage === 'open-pr') {
      const r = ghR(['pr', 'create', '--base', integration, '--head', branch, '--title', effectiveText(commits).title, '--body-file', prBodyFile(commits)]);
      if (!r.ok) refuse('pr-create-failed', `gh pr create failed (${firstLine(r.stderr)}); run this again, or open it by hand`);
      act(`opened a pull request: ${r.stdout.trim().split('\n').pop()}`);
      editedPr = true;
    }
    facts = look();
    ({ commits, packages } = preflight(facts));
  }

  comparison = readComparison(childFile, facts.local);
  Object.assign(report, {
    stage,
    head: facts.local,
    remote_head: facts.remote,
    integration_tip: facts.tip,
    fresh: facts.contains_tip,
    commits: commits.map((c, i) => ({ sha: c.sha, subject: splitMessage(c.message).subject, package: packages[i] })),
    packages: [...new Set(packages.filter(Boolean))].sort(),
    comparison: comparison.state === 'recorded'
      ? { state: comparison.record?.state ?? 'unknown', reason: comparison.record?.reason ?? null, paths: comparison.record?.paths ?? [], accepted: comparison.record?.accepted ?? null }
      : { state: comparison.state === 'unreadable' ? 'unreadable' : 'none' },
    pull_request: pr ? { number: pr.number, url: pr.url ?? null, head: pr.headRefOid ?? null } : null,
    ci,
    merge_commands: [],
  });
  if (stage === 'ready' && pr) {
    let titleOut = null;
    let bodyOut = null;
    if (execute && commits.length === 1) {
      // AGENTS.md: the squash message comes from the pull request, not from
      // the branch or this invocation's inputs. A rerun without the first
      // run's --title-file/--body-file, or an owner's edit on GitHub, keeps
      // the text the owner reviewed (this run's own files were written to the
      // pull request above, so they agree with it).
      const text = squashText(pr);
      if (text.problem) {
        report.notes.push(`no squash command: pull request #${pr.number}'s ${text.problem}; fix it on GitHub, or pass --title-file/--body-file to set it, and run this again`);
      } else {
        fs.mkdirSync(runDir, { recursive: true });
        titleOut = path.join(runDir, 'squash-title.txt');
        bodyOut = path.join(runDir, 'squash-body.txt');
        fs.writeFileSync(titleOut, `${text.title} (#${pr.number})\n`);
        fs.writeFileSync(bodyOut, `${text.body}\n`);
      }
    }
    report.merge_commands = mergeCommands({ repo: slug, prNumber: pr.number, head: facts.local, commitCount: commits.length, titleFile: titleOut, bodyFile: bodyOut });
  }
  const code = stage === 'ready' || !execute ? EXIT.READY : stage === 'ci-failed' ? EXIT.CI_FAILED : EXIT.PENDING;
  return { code, report };
}

const COMPARISON_TEXT = {
  same: 'same — the landing compares with what was reviewed',
  'no-reviews': 'no reviews — nothing is bound; the outcome gate alone speaks',
  different: 'different — the landing will read different; accept it (review-binding-accept) or review again',
  'not-comparable': 'not comparable — the landing will read not comparable',
  none: 'none recorded for this head — the landing will read not comparable',
  unreadable: 'the child workflow cannot be read',
};

/** The readiness report as text. */
export function reportText(report) {
  const lines = [];
  const short = (s) => (s ? s.slice(0, 12) : 'none');
  lines.push(`${report.stage === 'ready' ? '✓ Ready to merge' : `◆ ${report.mode === 'dry-run' ? 'Dry run' : 'Not ready'}`}: ${report.macro} ${report.subtask} (${report.branch} → ${report.integration})`);
  if (report.mode === 'dry-run' && report.stage !== 'ready') lines.push(`  next stage: ${report.stage} (run with --execute to carry it out)`);
  else if (report.stage !== 'ready') lines.push(`  stage: ${report.stage}`);
  lines.push(`  head: ${report.head}`);
  lines.push(`  origin/${report.branch}: ${short(report.remote_head)}${report.remote_head === report.head ? ' (pushed)' : ''}`);
  lines.push(`  origin/${report.integration}: ${short(report.integration_tip)} — ${report.fresh ? 'contained (fresh)' : 'not contained (needs a rebase)'}`);
  lines.push(`  commits: ${report.commits.length}`);
  for (const c of report.commits) lines.push(`    ${short(c.sha)} ${c.subject}${c.package ? `  [${c.package}]` : ''}`);
  lines.push(`  release-please packages: ${report.packages.length ? report.packages.join(', ') : 'none'}`);
  const cmp = report.comparison;
  lines.push(`  committed comparison: ${COMPARISON_TEXT[cmp.state] ?? cmp.state}${cmp.reason ? ` (${cmp.reason})` : ''}${cmp.accepted ? ' [accepted]' : ''}`);
  if (cmp.paths?.length) lines.push(`    paths: ${cmp.paths.join(', ')}`);
  lines.push(`  pull request: ${report.pull_request ? `#${report.pull_request.number} ${report.pull_request.url ?? ''}`.trim() : 'none'}`);
  if (report.ci) {
    for (const w of report.ci.workflows) lines.push(`  CI ${w.workflow}: ${w.state}${w.conclusion && w.state !== 'green' ? ` (${w.conclusion})` : ''}${w.url ? ` ${w.url}` : ''}`);
  }
  for (const a of report.actions) lines.push(`  did: ${a}`);
  for (const n of report.notes) lines.push(`  note: ${n}`);
  if (report.merge_commands.length) {
    lines.push('  merge (yours to run; then /orchestrator:done records it):');
    for (const c of report.merge_commands) lines.push(`    ${c}`);
  }
  return `${lines.join('\n')}\n`;
}

const USAGE = `usage: land-prepare.mjs --subtask <id> (--macro <id> | --workflow-path <macro.md>)
       [--repo <checkout>] [--title-file <f>] [--body-file <f>] [--workflow <file.yml>]...
       [--ci-timeout <seconds>] [--poll <seconds>] [--format text|json] [--execute]
Prepares a committed macro subtask for its landing: rebase onto the integration
branch, committed comparison, push, pull request, CI. Dry-run by default; it never
merges, and refuses under an autopilot run (ADR-0062, amendment of 2026-11-11).
`;

export function parseArgs(argv) {
  const out = { workflows: [], execute: false, format: 'text' };
  const valued = new Set(['subtask', 'macro', 'workflow-path', 'repo', 'title-file', 'body-file', 'workflow', 'ci-timeout', 'poll', 'format']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--execute') { out.execute = true; continue; }
    const m = /^--([a-z-]+)$/.exec(a);
    if (!m || !valued.has(m[1])) throw new Refusal('usage', `unknown option ${a}`, EXIT.USAGE);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Refusal('usage', `${a} needs a value`, EXIT.USAGE);
    i += 1;
    if (m[1] === 'workflow') { out.workflows.push(v); continue; }
    if (Object.hasOwn(out, m[1]) && m[1] !== 'format') throw new Refusal('usage', `${a} was given twice`, EXIT.USAGE);
    out[m[1]] = v;
  }
  if (!out.subtask) throw new Refusal('usage', '--subtask is required', EXIT.USAGE);
  if (!out.macro === !out['workflow-path']) throw new Refusal('usage', 'pass one of --macro and --workflow-path', EXIT.USAGE);
  if (!['text', 'json'].includes(out.format)) throw new Refusal('usage', '--format takes text or json', EXIT.USAGE);
  for (const k of ['ci-timeout', 'poll']) {
    if (out[k] !== undefined && !/^\d+$/.test(out[k])) throw new Refusal('usage', `--${k} takes whole seconds`, EXIT.USAGE);
  }
  for (const wf of out.workflows) {
    if (!/^[A-Za-z0-9._-]+\.ya?ml$/.test(wf)) throw new Refusal('usage', `--workflow ${JSON.stringify(wf)} is not a workflow file name`, EXIT.USAGE);
  }
  return out;
}

export async function cliMain(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    stderr.write(`✗ ${err.message}\n${USAGE}`);
    return EXIT.USAGE;
  }
  if (args.help) {
    stdout.write(USAGE);
    return EXIT.READY;
  }
  try {
    const { code, report } = await prepareLanding({
      repo: args.repo ?? process.cwd(),
      macroId: args.macro ?? null,
      workflowPath: args['workflow-path'] ?? null,
      subtaskId: args.subtask,
      execute: args.execute,
      titleFile: args['title-file'] ?? null,
      bodyFile: args['body-file'] ?? null,
      workflows: args.workflows.length ? args.workflows : DEFAULT_CI_WORKFLOWS,
      ciTimeoutS: args['ci-timeout'] !== undefined ? Number(args['ci-timeout']) : 1800,
      pollS: args.poll !== undefined ? Number(args.poll) : 30,
      env,
      log: (line) => stderr.write(`${line}\n`),
    });
    stdout.write(args.format === 'json' ? `${JSON.stringify(report)}\n` : reportText(report));
    return code;
  } catch (err) {
    if (err instanceof Refusal) {
      if (args.format === 'json') stdout.write(`${JSON.stringify({ refused: err.reason, detail: err.message })}\n`);
      stderr.write(`✗ Refused (${err.reason}): ${err.message}\n`);
      return err.code;
    }
    stderr.write(`✗ land-prepare failed: ${err?.stack ?? err}\n`);
    return EXIT.REFUSED;
  }
}

if (isCliEntry(import.meta.url)) {
  absorbOutputErrors();
  (async () => {
    exitAfterFlush(await cliMain(process.argv.slice(2)));
  })();
}
