// plugins/orchestrator/adapters/claude/autopilot/retention.mjs
//
// ADR-0068, amendment of 2026-11-10 (C175) — a cap on what the runs of a
// checkout keep, owned by this plugin (not a runtime:retention family: the
// run ledger's readers and citations are this plugin's to know).
//
// WHAT IS TRIMMED is only a run's BULK: its raw worker streams
// (`worker-<seq>.jsonl`) and its verification logs (`verify/`). run.json,
// steps.jsonl, halt.json, landing.jsonl and lanes.jsonl always stay, so every
// reader of a run keeps its answer: status, a hold's handoff, the event
// reader's reconciliation, a halt's resume, the pairing of a request with its
// step. run.json records the trim (`retention`).
//
// WHICH RUNS. An ended run (completed, halted, error) beyond BOTH floors: not
// among the newest KEEP_RUNS ended runs of the checkout, and ended more than
// KEEP_DAYS days ago. Never one that may still be in use: a run with an
// open-run record, a cleanup lock or a temporary root on the index
// (scratch.mjs), one whose run.json does not read, or one still `running` or
// `draining`.
//
// CITATIONS keep a run WHOLE, its worker streams with its verification logs,
// whatever its age: a run id an engineer workflow names (its request's run, a
// batch's, a carried result's source, a reused pass) is one that workflow's
// results point at. The read is by text and so errs toward keeping: every run
// id that appears in an active workflow of any state home of the repository's
// checkouts, in a workflow archived within KEEP_DAYS, or in a verification
// journal written within KEEP_DAYS or of an active workflow, is cited. A
// source that does not read keeps every run past the floors whole (fail
// closed). Only what an interrupted pass left renamed is still finished.
//
// HOW. One retention at a time (`retention.lock` beside the open-run
// records); each run is judged again under it, just before its files go. A
// file or directory is renamed `.removing-<name>` inside its run directory,
// then removed, so a pass a crash interrupted is finished by the next.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { AUTOPILOT_DIR_REL, LockHeldError, acquireLock } from '../../../scripts/lib/run-locks.mjs';
import { autopilotDir, listRuns, openRunsDir, writeRun } from './ledger.mjs';
import { ENGINEER_STATE_HOMES } from './observe.mjs';
import { scratchIndexDir } from './scratch.mjs';
import { JOURNAL_DIR_REL } from './verify-journal.mjs';

export const KEEP_RUNS = 20;
export const KEEP_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const ENDED = new Set(['completed', 'halted', 'error']);
const RUN_ID_RE = /autopilot-\d{8}T\d{6}Z-[0-9a-f]{6}/g;
const WORKER_STREAM = /^worker-\d+\.jsonl$/;
const VERIFY_DIR = 'verify';
const REMOVING = '.removing-';

const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

function checkoutsOf(repoRoot) {
  const r = spawnSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8', env: gitEnv(), timeout: 30_000 });
  if (r.status !== 0) return null;
  return r.stdout.split('\0').filter((f) => f.startsWith('worktree ')).map((f) => f.slice('worktree '.length));
}

// Every entry under `dir` that is no directory (a link included: the
// workflow readers follow one to a file); ENOENT is none, anything else throws.
function filesUnder(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(cur, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    for (const e of ents) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else out.push(p);
    }
  }
  return out;
}

/**
 * The run ids the repository's engineer workflows and verification journals
 * name: { ok: true, cited: Set } or { ok: false, problem } when a source does
 * not read (every run past the floors is then kept whole).
 */
export function citedRuns({ repoRoot, mainRoot, now = () => Date.now(), keepDays = KEEP_DAYS, checkouts = checkoutsOf }) {
  const cited = new Set();
  // Through a link, as the workflow readers read; anything but a regular
  // file there (a directory, a FIFO) fails the read, which keeps every run.
  const regular = (file) => {
    const st = fs.statSync(file);
    if (!st.isFile()) throw Object.assign(new Error(`${file} is not a regular file`), { code: 'ENOTFILE' });
    return st;
  };
  const recent = (file) => now() - regular(file).mtimeMs <= keepDays * DAY_MS;
  const scan = (file) => {
    regular(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(RUN_ID_RE)) cited.add(m[0]);
    return text;
  };
  try {
    const roots = checkouts(repoRoot);
    if (roots === null) return { ok: false, problem: `the checkouts of ${repoRoot} cannot be listed` };
    const seen = new Set();
    const active = new Set();
    for (const root of [repoRoot, mainRoot, ...roots]) {
      let real;
      try { real = fs.realpathSync(root); } catch (err) { if (err.code === 'ENOENT') continue; throw err; }
      if (seen.has(real)) continue;
      seen.add(real);
      for (const home of ENGINEER_STATE_HOMES) {
        for (const f of filesUnder(path.join(real, home, 'workflows'))) {
          const text = scan(f);
          // Its journal is named by its id: the file's name, and the id its
          // frontmatter gives when they differ.
          active.add(path.basename(f, '.md'));
          const id = /^workflow_id: "?([A-Za-z0-9._:-]+)"?\s*$/m.exec(text);
          if (id) active.add(id[1]);
        }
        for (const f of filesUnder(path.join(real, home, 'archive'))) if (recent(f)) scan(f);
      }
    }
    for (const f of filesUnder(path.join(mainRoot, JOURNAL_DIR_REL))) {
      if (active.has(path.basename(f, '.jsonl')) || recent(f)) scan(f);
    }
  } catch (err) {
    return { ok: false, problem: `a workflow or journal does not read (${err.code ?? err.message})` };
  }
  return { ok: true, cited };
}

const exists = (p) => {
  try { fs.lstatSync(p); return true; } catch (err) { return err.code !== 'ENOENT'; }
};

// Why a run is never trimmed now, or null: read fresh each time it is asked.
function inUse({ repoRoot, mainRoot, runDir, runId }) {
  // The checkout's own directory, reached through no link: one that is a
  // link, or that resolves anywhere but under the checkout's real root (a
  // link at the run directory or at any directory above it, the ledger's own
  // included), is another place's run, whose records and citations this
  // checkout does not know.
  try {
    const st = fs.lstatSync(runDir);
    const own = path.join(fs.realpathSync(repoRoot), AUTOPILOT_DIR_REL, runId);
    if (st.isSymbolicLink() || !st.isDirectory() || fs.realpathSync(runDir) !== own) return { why: 'its directory is a link, or not a directory', run: null };
    if (!fs.lstatSync(path.join(runDir, 'run.json')).isFile()) return { why: 'its run.json does not read', run: null };
  } catch {
    return { why: 'its run.json does not read', run: null };
  }
  let run;
  try { run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')); } catch { return { why: 'its run.json does not read', run: null }; }
  if (run?.run_id !== runId) return { why: 'its run.json names another run', run: null };
  if (!ENDED.has(run.status)) return { why: `it is ${run.status ?? 'of no status'}`, run };
  if (exists(path.join(openRunsDir(mainRoot), `${runId}.json`))) return { why: 'it has an open-run record', run };
  if (exists(path.join(openRunsDir(mainRoot), `${runId}.cleanup.lock`))) return { why: 'a cleanup of it holds its lock', run };
  if (exists(path.join(scratchIndexDir(mainRoot), `${runId}.json`))) return { why: 'its temporary root is not gone yet', run };
  return { why: null, run };
}

function sizeOf(p) {
  try {
    const st = fs.lstatSync(p);
    if (!st.isDirectory()) return st.size;
    return filesUnder(p).reduce((a, f) => { try { return a + fs.lstatSync(f).size; } catch { return a; } }, 0);
  } catch {
    return 0;
  }
}

// What of a run's directory is bulk: its worker streams, its verify
// directory, and what an interrupted pass left renamed.
function bulkOf(runDir) {
  let names = [];
  try { names = fs.readdirSync(runDir); } catch { return { workers: [], verify: null, leftovers: [] }; }
  return {
    workers: names.filter((n) => WORKER_STREAM.test(n)).sort(),
    verify: names.includes(VERIFY_DIR) ? VERIFY_DIR : null,
    leftovers: names.filter((n) => n.startsWith(REMOVING) && (WORKER_STREAM.test(n.slice(REMOVING.length)) || n.slice(REMOVING.length) === VERIFY_DIR)).sort(),
  };
}

/**
 * What a retention would do, changing nothing: { runs: [{ run_id, dir,
 * action: 'trim' | 'keep', why, items, bytes }], citations: { ok, problem } }.
 */
export function planRetention({ repoRoot, mainRoot, now = () => Date.now(), keepRuns = KEEP_RUNS, keepDays = KEEP_DAYS, citations = null }) {
  // Read only when a run is past both floors: most starts trim nothing.
  let cites = citations;
  const citesNow = () => { cites ??= citedRuns({ repoRoot, mainRoot, now, keepDays }); return cites; };
  const ids = listRuns(repoRoot);
  const judged = ids.map((runId) => {
    const dir = path.join(autopilotDir(repoRoot), runId);
    return { run_id: runId, dir, ...inUse({ repoRoot, mainRoot, runDir: dir, runId }) };
  });
  // The newest ended runs, by their id (its stamp orders them).
  const ended = judged.filter((j) => j.run && ENDED.has(j.run.status)).map((j) => j.run_id);
  const newest = new Set(ended.slice(-keepRuns));
  const runs = judged.map((j) => {
    const base = { run_id: j.run_id, dir: j.dir, action: 'keep', why: j.why, items: [], bytes: 0 };
    if (j.why) return base;
    const bulk = bulkOf(j.dir);
    // A pass a crash interrupted is finished whatever the floors say now:
    // the run was eligible when its files were renamed.
    const items = [...bulk.leftovers];
    let why = null;
    if (newest.has(j.run_id)) why = `it is among the newest ${keepRuns} ended runs`;
    else {
      const endedAt = Date.parse(j.run.ended_at ?? '');
      if (!Number.isFinite(endedAt)) why = 'its end is not dated';
      else if (now() - endedAt <= keepDays * DAY_MS) why = `it ended within ${keepDays} days`;
    }
    // A run a workflow names is kept whole: the citation is read before any
    // of its files is chosen, its worker streams as much as its logs, and a
    // read that fails keeps every run past the floors.
    if (why === null && (bulk.workers.length > 0 || bulk.verify)) {
      if (!citesNow().ok) why = `citations do not read: ${cites.problem}`;
      else if (cites.cited.has(j.run_id)) why = 'a workflow names the run';
      else items.push(...bulk.workers, ...(bulk.verify ? [bulk.verify] : []));
    }
    if (items.length === 0) return { ...base, why: why ?? (j.run.retention ? 'it was trimmed before' : 'it holds nothing to trim') };
    return { ...base, action: 'trim', why: why ? `finishing an interrupted trim (${why})` : null, items, bytes: items.reduce((a, n) => a + sizeOf(path.join(j.dir, n)), 0) };
  });
  return { runs, citations: { ok: cites?.ok !== false, problem: cites?.ok === false ? cites.problem : null } };
}

/**
 * Trim what the plan names, one retention at a time. Resolves { ok, busy,
 * trimmed: [{ run_id, bytes }], kept, failures: [{ run_id, error }], citations }.
 * `busy` true when another retention holds the lock (nothing was done).
 * `hooks` are test seams: afterPlan(plan), beforeTrim(run), afterRename(path).
 */
export async function applyRetention({ repoRoot, mainRoot, now = () => Date.now(), keepRuns = KEEP_RUNS, keepDays = KEEP_DAYS, by = null, rm = fs.promises.rm, hooks = {} }) {
  const lockDir = path.join(mainRoot, AUTOPILOT_DIR_REL, 'retention.lock');
  let lock;
  try {
    lock = await acquireLock(lockDir, { record: { run_id: by, retention_of: repoRoot }, now });
  } catch (e) {
    if (e instanceof LockHeldError) return { ok: true, busy: true, trimmed: [], kept: 0, failures: [], citations: { ok: true, problem: null } };
    throw e;
  }
  const trimmed = [];
  const failures = [];
  let kept = 0;
  let plan;
  try {
    // Planned under the lock: what another retention trimmed is seen.
    plan = planRetention({ repoRoot, mainRoot, now, keepRuns, keepDays });
    if (hooks.afterPlan) await hooks.afterPlan(plan);
    for (const r of plan.runs) {
      if (r.action !== 'trim') { kept += 1; continue; }
      try {
        // Judged again just before its files go: a run a cleanup or a
        // relaunch took up since is left whole.
        const again = inUse({ repoRoot, mainRoot, runDir: r.dir, runId: r.run_id });
        if (again.why) { kept += 1; continue; }
        if (hooks.beforeTrim) await hooks.beforeTrim(r);
        for (const name of r.items) {
          let target = path.join(r.dir, name);
          if (!name.startsWith(REMOVING)) {
            const renamed = path.join(r.dir, `${REMOVING}${name}`);
            // A leftover of the same name is finished first.
            await rm(renamed, { recursive: true, force: true });
            try {
              fs.renameSync(target, renamed);
            } catch (err) {
              if (err.code === 'ENOENT') continue;
              throw err;
            }
            target = renamed;
          }
          if (hooks.afterRename) await hooks.afterRename(target);
          await rm(target, { recursive: true, force: true, maxRetries: 2 });
        }
        // run.json as it is now, read again: what another writer recorded
        // while the files went is kept.
        const fresh = inUse({ repoRoot, mainRoot, runDir: r.dir, runId: r.run_id }).run ?? again.run;
        const prev = fresh.retention ?? {};
        writeRun(r.dir, { ...fresh, retention: { trimmed_at: new Date(now()).toISOString(), bytes: (Number.isFinite(prev.bytes) ? prev.bytes : 0) + r.bytes, verify_kept: fs.existsSync(path.join(r.dir, VERIFY_DIR)) } });
        trimmed.push({ run_id: r.run_id, bytes: r.bytes });
      } catch (err) {
        failures.push({ run_id: r.run_id, error: String(err?.message ?? err).slice(0, 300) });
      }
    }
  } finally {
    lock.release();
    try { fs.rmdirSync(lockDir); } catch { /* another joined it, or gone */ }
  }
  return { ok: failures.length === 0, busy: false, trimmed, kept, failures, citations: plan.citations };
}

const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** The lines a plan prints, one per run. */
export function describePlan(plan, { execute = false } = {}) {
  const lines = [];
  for (const r of plan.runs) {
    if (r.action === 'trim') lines.push(`${execute ? 'trimmed' : 'would trim'} ${r.run_id}: ${r.items.length} item${r.items.length === 1 ? '' : 's'}, ${mb(r.bytes)}${r.why ? ` (${r.why})` : ''}`);
    else lines.push(`kept ${r.run_id}: ${r.why}`);
  }
  if (!plan.citations.ok) lines.push(`⚠ every run past the floors is kept whole: ${plan.citations.problem}`);
  return lines;
}

/** One line for a run's start, or null when nothing was trimmed and nothing failed. */
export function describeApplied(r) {
  if (r.busy) return null;
  const bytes = r.trimmed.reduce((a, t) => a + t.bytes, 0);
  const parts = [];
  if (r.trimmed.length > 0) parts.push(`trimmed the worker streams and verification logs of ${r.trimmed.length} old run${r.trimmed.length === 1 ? '' : 's'} (${mb(bytes)})`);
  if (r.failures.length > 0) parts.push(`⚠ ${r.failures.length} run${r.failures.length === 1 ? '' : 's'} could not be trimmed (${r.failures[0].error})`);
  if (!r.citations.ok) parts.push(`⚠ every run past the floors is kept whole: ${r.citations.problem}`);
  return parts.length > 0 ? `retention: ${parts.join('; ')}` : null;
}
