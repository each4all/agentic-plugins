// plugins/orchestrator/adapters/claude/autopilot/observe.mjs
//
// ADR-0063 D4 — the observer: assembles the view the policy decides from.
// It reads, through the owning plugins' CLIs and git only (ADR-0010 §5: no
// cross-plugin import), and writes nothing in the repository's state:
//
//   - git: branch, HEAD, `status --porcelain --untracked-files=normal` (the
//     clean rule /orchestrator:next applies);
//   - runtime `context.mjs entry-brief --surface cli` (R0, read-only);
//   - orchestrator `state.mjs` state-root / scan-roots / find-active /
//     find-macro / resolve-workflow / read / next-ready / resolve-landing;
//   - engineer `state.mjs` find-active / read, and the engineer archive homes
//     for a subtask's archived workflow;
//
// ADR-0067 Decision 1 — records are found where the plugins' readers find
// them: a macro in the orchestrator homes of the checkout's read set (the
// default state root first), an engineer child, archived or claiming the
// macro, in the engineer homes of the repository-wide scan set (the read set,
// then every other worktree), each physical file once. A pointer into a record
// is spelled relative to the state root holding it (Decision 1(c)).
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

// ADR-0067 Decision 1(c) — a pointer into a record, relative to the state
// root holding it: the deepest of `roots` the file is under (a worktree may
// sit inside another's directory). A file under none keeps its absolute path.
const relTo = (roots, p) => {
  let best = null;
  for (const root of roots) {
    const rel = path.relative(root, p);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (best === null || rel.length < best.length) best = rel;
  }
  return best === null ? p : best.split(path.sep).join('/');
};

const physical = (p) => {
  try { return fs.realpathSync(p); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
};

// The read set and the repository-wide scan set of `repoRoot`, from
// orchestrator's CLI (ADR-0010 §5: no import). Either failing fails the look:
// a scan that left a root out could miss the record it is looking for.
function observeRoots(orchCli, repoRoot, o) {
  const sr = node(orchCli, ['state-root', '--repo-root', repoRoot], o);
  const report = parseJson(sr.stdout);
  if (sr.code !== 0 || !Array.isArray(report?.read_set)) return { error: failure(sr, 'orchestrator state-root') };
  const scan = node(orchCli, ['scan-roots', '--repo-root', repoRoot], o);
  const all = parseJson(scan.stdout);
  if (scan.code !== 0 || !Array.isArray(all)) return { error: failure(scan, 'orchestrator scan-roots') };
  return { readSet: report.read_set, scan: all };
}

function progressEvents(history) {
  return Array.isArray(history) ? history.filter((h) => h && h.event && h.event !== 'snapshot').length : 0;
}

// ADR-0067 Decision 8 — what a conflict gate's consensus proposal is judged
// from: the run id the gate records, the runs ensemble_results holds with the
// verdict conflict, and whether the task file for that run exists in the home
// the record was found in (a stat; its content is never read). Only a live
// record (in a home's workflows/) has one; the policy checks every part again.
const CONSENSUS_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
function consensusFacts(fm, file, roots) {
  const runId = typeof fm.awaiting_owner_run_id === 'string' ? fm.awaiting_owner_run_id : null;
  const conflictRuns = Array.isArray(fm.ensemble_results)
    ? fm.ensemble_results.filter((e) => e?.verdict === 'conflict' && typeof e?.run_id === 'string').map((e) => e.run_id)
    : [];
  const dir = path.dirname(file);
  let task = null;
  if (path.basename(dir) === 'workflows' && runId !== null && CONSENSUS_NAME_RE.test(runId)
    && typeof fm.workflow_id === 'string' && CONSENSUS_NAME_RE.test(fm.workflow_id)) {
    const p = path.join(path.dirname(dir), 'consensus', `${fm.workflow_id}.${runId}.md`);
    let exists = false;
    try { exists = fs.statSync(p).isFile(); } catch { exists = false; }
    task = { path: p, relPath: relTo(roots, p), exists };
  }
  return { run_id: runId, conflict_runs: conflictRuns, task };
}

function summarizeChild(fm, location, file, roots) {
  return {
    location,
    path: file,
    relPath: relTo(roots, file),
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
    consensus: consensusFacts(fm, file, roots),
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
// name was taken (both plugins' archiveWorkflow). Every root's homes, each
// physical file once (a home linked to another root's is read once).
function archivedCandidates(roots, homes, id) {
  const found = [];
  const seen = new Set();
  for (const root of roots) {
    for (const home of homes) {
      const dir = path.join(root, home, 'archive');
      let names;
      // Only absence (ENOENT) is no archive; a file in a directory's place
      // (ENOTDIR) is refused, as the state library's scans refuse it.
      try { names = fs.readdirSync(dir); } catch (err) {
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      for (const n of names.sort()) {
        if (!(n === `${id}.md` || (n.startsWith(`${id}-`) && n.endsWith('.md')))) continue;
        const file = path.join(dir, n);
        const real = physical(file);
        if (real === null || seen.has(real)) continue;
        seen.add(real);
        found.push(file);
      }
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

function findArchived(stateCli, roots, homes, id, o) {
  let files;
  try { files = archivedCandidates(roots, homes, id); } catch (err) { return { error: err.message }; }
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

// resolve-workflow's exit status when no root of the read set holds the id
// (1 is an error: two files hold it, or a root cannot be read).
const RESOLVE_NOT_FOUND = 3;

function locateMacro({ orchCli, repoRoot, roots, macroId, branch, o }) {
  if (macroId) {
    const resolved = node(orchCli, ['resolve-workflow', '--repo-root', repoRoot, '--workflow-id', macroId], o);
    if (resolved.code === 0 && resolved.stdout) return { file: resolved.stdout, archived: false };
    if (resolved.code !== RESOLVE_NOT_FOUND) return { error: failure(resolved, 'orchestrator resolve-workflow') };
    const archived = findArchived(orchCli, roots.readSet, ORCHESTRATOR_STATE_HOMES, macroId, o);
    if (archived?.error) return { error: archived.error };
    if (archived?.ambiguous) return { error: `more than one archived file holds macro ${macroId}: ${archived.ambiguous.join(', ')}` };
    if (archived) return { file: archived.file, archived: true, fm: archived.fm };
    return { error: `macro ${macroId} is neither active nor archived in the read set of ${repoRoot}` };
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

function observeChild({ engCli, repoRoot, roots, macroId, subtask, o }) {
  if (typeof subtask.branch !== 'string' || subtask.branch.length === 0) {
    return { location: 'error', detail: 'the subtask records no branch' };
  }
  const active = node(engCli, ['find-active', '--repo-root', repoRoot, '--branch', subtask.branch], o);
  if (active.code !== 0) return { location: 'error', detail: failure(active, 'engineer find-active') };
  if (active.stdout) {
    const r = readFrontmatter(engCli, active.stdout, o);
    if (r.error) return { location: 'error', detail: r.error };
    const child = summarizeChild(r.fm, 'active', active.stdout, roots.scan);
    const wrong = linkageProblems(child, { macroId, subtask });
    if (wrong.length > 0) return { ...child, location: 'linkage-mismatch', detail: wrong.join(', ') };
    return child;
  }
  const id = subtask.engineer_workflow_id;
  if (!id) return { location: 'unrecorded' };
  const archived = findArchived(engCli, roots.scan, ENGINEER_STATE_HOMES, id, o);
  if (archived?.error) return { location: 'error', workflow_id: id, detail: archived.error };
  if (archived?.ambiguous) return { location: 'ambiguous', workflow_id: id, detail: archived.ambiguous.join(', ') };
  if (!archived) return { location: 'missing', workflow_id: id };
  const child = summarizeChild(archived.fm, 'archived', archived.file, roots.scan);
  const wrong = linkageProblems(child, { macroId, subtask });
  if (wrong.length > 0) return { ...child, location: 'linkage-mismatch', detail: wrong.join(', ') };
  return child;
}

function listClaims({ engCli, roots, macroId, o }) {
  const list = [];
  const seen = new Set();
  for (const dir of roots.scan.flatMap((root) => ENGINEER_STATE_HOMES.map((home) => path.join(root, home, 'workflows')))) {
    let names;
    // Only absence (ENOENT) is an empty home; a file in a directory's place
    // (ENOTDIR) is refused, as the state library's scans refuse it.
    try { names = fs.readdirSync(dir); } catch (err) {
      if (err.code === 'ENOENT') continue;
      return { error: `cannot list ${dir}: ${err.message}` };
    }
    for (const n of names.filter((x) => x.endsWith('.md')).sort()) {
      const file = path.join(dir, n);
      let real;
      try { real = physical(file); } catch (err) { return { error: `cannot read ${file}: ${err.message}` }; }
      if (real === null || seen.has(real)) continue;
      seen.add(real);
      const r = readFrontmatter(engCli, file, o);
      if (r.error) return { error: r.error };
      if (r.fm.parent_workflow !== macroId) continue;
      list.push({
        id: r.fm.workflow_id ?? null,
        path: file,
        relPath: relTo(roots.scan, file),
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

  const stateRoots = observeRoots(orchCli, repoRoot, o);
  if (stateRoots.error) { view.macroLookupError = stateRoots.error; return view; }
  const located = locateMacro({ orchCli, repoRoot, roots: stateRoots, macroId, branch: view.git.branch, o });
  if (located.error) { view.macroLookupError = located.error; return view; }
  if (located.none) return view;
  let fm = located.fm;
  if (!fm) {
    const r = readFrontmatter(orchCli, located.file, o);
    if (r.error) { view.macroLookupError = r.error; return view; }
    fm = r.fm;
  }
  const id = fm.workflow_id ?? path.basename(located.file, '.md');
  view.macro = {
    id, path: located.file, relPath: relTo(stateRoots.scan, located.file), archived: located.archived, fm,
    consensus: consensusFacts(fm, located.file, stateRoots.scan),
  };

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
    const child = observeChild({ engCli, repoRoot, roots: stateRoots, macroId: id, subtask: s, o });
    view.children[s.id] = child;
    if (child.path) childPaths.add(child.path);
  }

  // Every live engineer workflow that claims this macro, whatever its
  // branch: a dispatch interrupted before it recorded in_progress leaves one
  // behind a subtask that still reads pending.
  const claims = listClaims({ engCli, roots: stateRoots, macroId: id, o });
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
        view.foreign = { id: null, path: here.stdout, relPath: relTo(stateRoots.scan, here.stdout), detail: r.error };
      } else {
        const parent = r.fm.parent_workflow ?? null;
        const sub = subtasks.find((s) => s?.id === r.fm.originating_subtask);
        view.foreign = {
          id: r.fm.workflow_id ?? null,
          path: here.stdout,
          relPath: relTo(stateRoots.scan, here.stdout),
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
