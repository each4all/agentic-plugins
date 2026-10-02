// plugins/orchestrator/adapters/claude/autopilot/observe.mjs
//
// ADR-0063 D4 — the observer: assembles the view the policy decides from.
// It reads, through the owning plugins' CLIs and git only (ADR-0010 §5: no
// cross-plugin import), and writes nothing in the repository's state:
//
//   - git: branch, HEAD, `status --porcelain --untracked-files=normal` (the
//     clean rule /orchestrator:next applies);
//   - runtime `context.mjs entry-brief --surface cli` (R0, read-only);
//   - orchestrator `state.mjs` find-active / find-macro / read / next-ready /
//     resolve-landing;
//   - engineer `state.mjs` find-active / read, and the engineer archive homes
//     for a subtask's archived workflow;
//   - `git fetch origin <integration branch>` before a landing check, as
//     /orchestrator:done does (it updates remote-tracking refs only). Preview
//     skips it.
//
// "Waiting to land" is derived from these facts (an in_progress subtask whose
// engineer workflow is archived terminal, and resolve-landing's answer), never
// from a note's text (R5).
//
// `gh` is whatever PATH finds: resolve-landing runs it, and that is the seam
// tests use to move a pull request from open to merged.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const ENGINEER_STATE_HOMES = Object.freeze(['.agentic-plugins/state/engineer', '.claude/agentic-engineer']);
export const ORCHESTRATOR_STATE_HOMES = Object.freeze(['.agentic-plugins/state/orchestrator', '.claude/agentic-orchestrator']);

const CLI_TIMEOUT_MS = 60_000;
const NETWORK_TIMEOUT_MS = 120_000;

function run(cmd, args, { cwd, env, timeout = CLI_TIMEOUT_MS }) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  return {
    code: r.status,
    signal: r.signal,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim() || (r.error ? r.error.message : ''),
  };
}

const node = (script, args, o) => run(process.execPath, [script, ...args], o);
const failure = (r, what) => `${what} exited ${r.code ?? r.signal ?? '?'}${r.stderr ? `: ${r.stderr.split('\n').slice(-3).join(' ')}` : ''}`;

function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

const relTo = (repoRoot, p) => {
  const rel = path.relative(repoRoot, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : p;
};

function progressEvents(history) {
  return Array.isArray(history) ? history.filter((h) => h && h.event && h.event !== 'snapshot').length : 0;
}

function summarizeChild(fm, location, file, repoRoot) {
  return {
    location,
    path: file,
    relPath: relTo(repoRoot, file),
    workflow_id: fm.workflow_id ?? null,
    branch: fm.git_baseline?.branch ?? null,
    current_phase: fm.current_phase ?? null,
    terminal_marker: fm.terminal_marker === true,
    next_step: fm.next_step_kind
      ? { kind: fm.next_step_kind, verb: fm.next_step_verb ?? null, confidence: fm.next_step_confidence ?? null }
      : null,
    awaiting_owner: fm.awaiting_owner_gate
      ? { gate: fm.awaiting_owner_gate, pointer: fm.awaiting_owner_pointer ?? null, since: fm.awaiting_owner_since ?? null }
      : null,
    workflow_type: fm.workflow_type ?? 'verb-chain',
    parent_detached: fm.parent_detached === true,
    pending_ensemble: Array.isArray(fm.pending_ensemble) ? fm.pending_ensemble.length : 0,
    pending_runs: Array.isArray(fm.pending_ensemble)
      ? fm.pending_ensemble.map((p) => p?.run_id).filter((id) => typeof id === 'string')
      : [],
    ensemble_results: Array.isArray(fm.ensemble_results) ? fm.ensemble_results.length : 0,
    commit_manifest: Array.isArray(fm.commit_manifest) ? fm.commit_manifest.length : 0,
    progress: progressEvents(fm.host_history),
    parent_workflow: fm.parent_workflow ?? null,
    originating_subtask: fm.originating_subtask ?? null,
  };
}

// Archived files are named `<id>.md`, or `<id>-<isoCompact>-<hex>.md` when the
// name was taken (both plugins' archiveWorkflow).
function archivedCandidates(repoRoot, homes, id) {
  const found = [];
  for (const home of homes) {
    const dir = path.join(repoRoot, home, 'archive');
    let names;
    try { names = fs.readdirSync(dir); } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    for (const n of names) {
      if (n === `${id}.md` || (n.startsWith(`${id}-`) && n.endsWith('.md'))) found.push(path.join(dir, n));
    }
  }
  return found;
}

function readFrontmatter(stateCli, file, o) {
  const r = node(stateCli, ['read', '--workflow-path', file], o);
  if (r.code !== 0) return { error: failure(r, `state.mjs read ${file}`) };
  const fm = parseJson(r.stdout);
  return fm && typeof fm === 'object' ? { fm } : { error: `state.mjs read ${file} printed no JSON` };
}

function findArchived(stateCli, repoRoot, homes, id, o) {
  let files;
  try { files = archivedCandidates(repoRoot, homes, id); } catch (err) { return { error: err.message }; }
  const matches = [];
  for (const f of files) {
    const r = readFrontmatter(stateCli, f, o);
    if (r.error) return { error: r.error };
    if (r.fm.workflow_id === id) matches.push({ file: f, fm: r.fm });
  }
  if (matches.length > 1) return { ambiguous: matches.map((m) => m.file) };
  return matches[0] ?? null;
}

function observeGit(repoRoot, o) {
  const branch = run('git', ['-C', repoRoot, 'branch', '--show-current'], o);
  const head = run('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', 'HEAD'], o);
  const status = run('git', ['-C', repoRoot, 'status', '--porcelain', '--untracked-files=normal'], o);
  const git = {
    branch: branch.code === 0 ? branch.stdout : '',
    head: head.code === 0 ? head.stdout : null,
    porcelain: status.code === 0 ? status.stdout : null,
  };
  git.detached = git.branch === '';
  git.clean = git.porcelain === '';
  if (branch.code !== 0 || status.code !== 0) git.error = failure(branch.code !== 0 ? branch : status, 'git');
  return git;
}

function observeBrief(roots, repoRoot, o) {
  const r = node(path.join(roots.runtime, 'scripts', 'context.mjs'),
    ['entry-brief', '--host', 'claude', '--surface', 'cli', '--format', 'json', '--repo-root', repoRoot], o);
  const report = parseJson(r.stdout);
  if (r.code !== 0 || !report) return { briefError: failure(r, 'runtime:context entry-brief') };
  if (report.status !== 'computed') return { briefError: `entry-brief ${report.status} (${report.reason ?? 'no reason'})` };
  return { brief: report.brief };
}

function locateMacro({ orchCli, repoRoot, macroId, branch, o }) {
  if (macroId) {
    for (const home of ORCHESTRATOR_STATE_HOMES) {
      const file = path.join(repoRoot, home, 'workflows', `${macroId}.md`);
      if (fs.existsSync(file)) return { file, archived: false };
    }
    const archived = findArchived(orchCli, repoRoot, ORCHESTRATOR_STATE_HOMES, macroId, o);
    if (archived?.error) return { error: archived.error };
    if (archived?.ambiguous) return { error: `more than one archived file holds macro ${macroId}: ${archived.ambiguous.join(', ')}` };
    if (archived) return { file: archived.file, archived: true, fm: archived.fm };
    return { error: `macro ${macroId} is neither active nor archived in this repository` };
  }
  const active = node(orchCli, ['find-active', '--repo-root', repoRoot], o);
  if (active.code !== 0) return { error: failure(active, 'orchestrator find-active') };
  if (active.stdout) return { file: active.stdout, archived: false };
  if (!branch) return { none: true };
  const bySubtask = node(orchCli, ['find-macro', '--repo-root', repoRoot, '--subtask-branch', branch], o);
  if (bySubtask.code !== 0) return { error: failure(bySubtask, 'orchestrator find-macro') };
  if (bySubtask.stdout) return { file: bySubtask.stdout, archived: false };
  return { none: true };
}

// Whether a workflow file belongs to this attempt of the subtask: its parent,
// its subtask, its branch and (once recorded) its id. An archived file is
// held to the same test — a plan revision may move an in_progress subtask to
// another branch while it keeps the old engineer id.
function linkageProblems(child, { macroId, subtask }) {
  const wrong = [];
  if (child.parent_workflow !== macroId) wrong.push(`parent_workflow=${child.parent_workflow ?? 'none'}`);
  if (child.originating_subtask !== subtask.id) wrong.push(`originating_subtask=${child.originating_subtask ?? 'none'}`);
  if (child.branch !== subtask.branch) wrong.push(`branch=${child.branch ?? 'none'}, the plan says ${subtask.branch}`);
  if (subtask.engineer_workflow_id && child.workflow_id !== subtask.engineer_workflow_id) {
    wrong.push(`workflow_id=${child.workflow_id}, recorded ${subtask.engineer_workflow_id}`);
  }
  return wrong;
}

function observeChild({ engCli, repoRoot, macroId, subtask, o }) {
  if (typeof subtask.branch !== 'string' || subtask.branch.length === 0) {
    return { location: 'error', detail: 'the subtask records no branch' };
  }
  const active = node(engCli, ['find-active', '--repo-root', repoRoot, '--branch', subtask.branch], o);
  if (active.code !== 0) return { location: 'error', detail: failure(active, 'engineer find-active') };
  if (active.stdout) {
    const r = readFrontmatter(engCli, active.stdout, o);
    if (r.error) return { location: 'error', detail: r.error };
    const child = summarizeChild(r.fm, 'active', active.stdout, repoRoot);
    const wrong = linkageProblems(child, { macroId, subtask });
    if (wrong.length > 0) return { ...child, location: 'linkage-mismatch', detail: wrong.join(', ') };
    return child;
  }
  const id = subtask.engineer_workflow_id;
  if (!id) return { location: 'unrecorded' };
  const archived = findArchived(engCli, repoRoot, ENGINEER_STATE_HOMES, id, o);
  if (archived?.error) return { location: 'error', workflow_id: id, detail: archived.error };
  if (archived?.ambiguous) return { location: 'ambiguous', workflow_id: id, detail: archived.ambiguous.join(', ') };
  if (!archived) return { location: 'missing', workflow_id: id };
  const child = summarizeChild(archived.fm, 'archived', archived.file, repoRoot);
  const wrong = linkageProblems(child, { macroId, subtask });
  if (wrong.length > 0) return { ...child, location: 'linkage-mismatch', detail: wrong.join(', ') };
  return child;
}

function listClaims({ engCli, repoRoot, macroId, o }) {
  const list = [];
  for (const home of ENGINEER_STATE_HOMES) {
    const dir = path.join(repoRoot, home, 'workflows');
    let names;
    try { names = fs.readdirSync(dir); } catch (err) {
      if (err.code === 'ENOENT') continue;
      return { error: `cannot list ${dir}: ${err.message}` };
    }
    for (const n of names.filter((x) => x.endsWith('.md')).sort()) {
      const file = path.join(dir, n);
      const r = readFrontmatter(engCli, file, o);
      if (r.error) return { error: r.error };
      if (r.fm.parent_workflow !== macroId) continue;
      list.push({
        id: r.fm.workflow_id ?? null,
        path: file,
        relPath: relTo(repoRoot, file),
        originating_subtask: r.fm.originating_subtask ?? null,
        branch: r.fm.git_baseline?.branch ?? null,
        pending_runs: Array.isArray(r.fm.pending_ensemble)
          ? r.fm.pending_ensemble.map((p) => p?.run_id).filter((id) => typeof id === 'string')
          : [],
      });
    }
  }
  return { list };
}

const needsLanding = (child) => child.location === 'archived' && child.terminal_marker === true
  && child.current_phase !== 'close-complete';

/**
 * Assemble the view.
 *
 * @param o.repoRoot  the repository (worktree toplevel) the run drives
 * @param o.roots     {orchestrator, engineer, runtime}
 * @param o.macroId   the macro this run is pinned to (null on the first look)
 * @param o.fetch     fetch origin's integration branch before a landing check
 * @param o.env       the environment for every CLI (PATH finds gh)
 */
export function observe({ repoRoot, roots, macroId = null, fetch = true, env = process.env }) {
  const o = { cwd: repoRoot, env };
  const orchCli = path.join(roots.orchestrator, 'scripts', 'state.mjs');
  const engCli = path.join(roots.engineer, 'scripts', 'state.mjs');
  const view = {
    repoRoot,
    git: observeGit(repoRoot, o),
    brief: null, briefError: null,
    macro: null, macroLookupError: null,
    ready: null, readyError: null,
    children: {}, foreign: null, claims: [], claimsError: null,
    landing: {}, fetch: { attempted: false, ok: null, detail: null },
  };
  Object.assign(view, observeBrief(roots, repoRoot, o));

  const located = locateMacro({ orchCli, repoRoot, macroId, branch: view.git.branch, o });
  if (located.error) { view.macroLookupError = located.error; return view; }
  if (located.none) return view;
  let fm = located.fm;
  if (!fm) {
    const r = readFrontmatter(orchCli, located.file, o);
    if (r.error) { view.macroLookupError = r.error; return view; }
    fm = r.fm;
  }
  const id = fm.workflow_id ?? path.basename(located.file, '.md');
  view.macro = { id, path: located.file, relPath: relTo(repoRoot, located.file), archived: located.archived, fm };

  // next-ready reads an archived file too: the approval facts decide whether
  // an archived macro counts as completed (a plan edited during the last step).
  const ready = node(orchCli, ['next-ready', '--workflow-path', located.file], o);
  const readyJson = parseJson(ready.stdout);
  if (ready.code !== 0 || !readyJson) view.readyError = failure(ready, 'orchestrator next-ready');
  else view.ready = readyJson;
  if (located.archived) return view;

  const subtasks = Array.isArray(fm.plan?.subtasks) ? fm.plan.subtasks : [];
  const childPaths = new Set();
  for (const s of subtasks) {
    if (s?.status !== 'in_progress') continue;
    const child = observeChild({ engCli, repoRoot, macroId: id, subtask: s, o });
    view.children[s.id] = child;
    if (child.path) childPaths.add(child.path);
  }

  // Every live engineer workflow that claims this macro, whatever its
  // branch: a dispatch interrupted before it recorded in_progress leaves one
  // behind a subtask that still reads pending.
  const claims = listClaims({ engCli, repoRoot, macroId: id, o });
  if (claims.error) view.claimsError = claims.error;
  else view.claims = claims.list;

  // A live engineer workflow on the checked-out branch that is none of the
  // in_progress subtasks' children.
  if (view.git.branch) {
    const here = node(engCli, ['find-active', '--repo-root', repoRoot], o);
    if (here.code !== 0) {
      view.foreign = { id: null, path: null, relPath: null, detail: failure(here, 'engineer find-active') };
    } else if (here.stdout && !childPaths.has(here.stdout)) {
      const r = readFrontmatter(engCli, here.stdout, o);
      if (r.error) {
        view.foreign = { id: null, path: here.stdout, relPath: relTo(repoRoot, here.stdout), detail: r.error };
      } else {
        const parent = r.fm.parent_workflow ?? null;
        const sub = subtasks.find((s) => s?.id === r.fm.originating_subtask);
        view.foreign = {
          id: r.fm.workflow_id ?? null,
          path: here.stdout,
          relPath: relTo(repoRoot, here.stdout),
          detail: parent !== id ? `its parent is ${parent ?? 'none'}`
            : `its subtask ${r.fm.originating_subtask ?? '?'} is ${sub?.status ?? 'not in the plan'}`,
        };
      }
    }
  }

  const toLand = subtasks.filter((s) => s?.status === 'in_progress' && view.children[s.id] && needsLanding(view.children[s.id]));
  if (toLand.length > 0) {
    const integration = fm.git_baseline?.branch ?? null;
    if (fetch && integration) {
      const f = run('git', ['-C', repoRoot, 'fetch', '--quiet', 'origin', integration], { ...o, timeout: NETWORK_TIMEOUT_MS });
      view.fetch = { attempted: true, ok: f.code === 0, detail: f.code === 0 ? null : failure(f, `git fetch origin ${integration}`) };
    }
    for (const s of toLand) {
      const r = node(orchCli, ['resolve-landing', '--repo-root', repoRoot, '--workflow-path', located.file, '--subtask-id', s.id],
        { ...o, timeout: NETWORK_TIMEOUT_MS });
      const json = parseJson(r.stdout);
      if (json && typeof json === 'object' && typeof json.ok === 'boolean') view.landing[s.id] = json;
      else view.landing[s.id] = { error: failure(r, `resolve-landing ${s.id}`) };
    }
  }
  return view;
}
