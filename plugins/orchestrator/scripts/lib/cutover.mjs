// scripts/lib/cutover.mjs — the operator cutover's plan, move and verify
// (ADR-0067 Decision 4, item 4, steps 3, 4 and 6;
// docs/runbooks/state-root-cutover.md).
//
// It moves into the default state root each macro living in a linked
// worktree's own orchestrator home, and every engineer workflow, active and
// archived, that a linked worktree's own homes hold of a macro moved or
// already there, with the peer-run ledgers each moved workflow names. The
// handoff slots stay: they belong to the checkout (Decision 1(a)).
//
// Orchestrator only. It finds engineer records by their homes' paths and reads
// their frontmatter with a minimal scan, as noActiveEngineerChildrenScan does
// (ADR-0010 §5: no plugin imports another's script). The locks it takes are
// the writers' own, through the helpers state.mjs hands it: a workflow file
// under its write lock, an archived file or a peer-run directory under the
// creation locks archive takes once the switch is on, the repository's (the
// destination home's), then the source home's (Decision 2).
//
// Only renames are used, never a copy: a pair on two filesystems is refused.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CUTOVER_MANIFEST_SCHEMA,
  CUTOVER_RUNS_REL,
  SHARED_HOMES,
  StateRootError,
  attestationChecks,
  claimName,
  defaultRootWritable,
  defaultStateRoot,
  disableSharedCreation,
  isUnderLanesDirectory,
  newestOpenCutoverManifest,
  otherWorktreeRoots,
  readSharedCreation,
  sameDirectory,
  samePhysicalFile,
  workflowIdOfText,
} from './state-root.mjs';

export const CUTOVER_PLAN_SCHEMA = 'agentic-state-cutover-plan-1.0';
export const CUTOVER_VERIFY_SCHEMA = 'agentic-state-cutover-verify-1.0';

// The plugins the cutover moves records of; a rollback sends back a record
// of any plugin with a shared home.
const PLUGINS = ['engineer', 'orchestrator'];
const ALL_PLUGINS = [...new Set(SHARED_HOMES.map((h) => h.plugin))];
const MACRO_FILE_RE = /^macro-[a-z]+-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}\.md$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function homeRel(plugin, home) {
  const spec = SHARED_HOMES.find((h) => h.plugin === plugin && h.home === home);
  if (!spec) throw new Error(`no ${home} home for ${plugin}`);
  return spec.rel;
}

// A home's paths under `root`, in the shape state.mjs's directory lock takes.
export function homeStorage(root, plugin, home = 'canonical') {
  const base = path.join(root, homeRel(plugin, home));
  return {
    plugin,
    home,
    stateRoot: root,
    root: base,
    workflows: path.join(base, 'workflows'),
    archive: path.join(base, 'archive'),
    peerRuns: path.join(base, 'peer-runs'),
    // ADR-0067 Decision 8 — a conflict gate's consensus task files.
    consensus: path.join(base, 'consensus'),
    creationLock: path.join(base, '.creation-lock'),
  };
}

// ADR-0067 Decision 8 — the consensus task files of a workflow in a home, live
// and retired: `<workflow-id>.<run-id>.md` and `<workflow-id>.<run-id>.resolved.md`.
// A record moves with them, as with its peer-run ledgers (Decision 4, item 4).
function consensusFilesOf(storage, workflowId) {
  if (typeof workflowId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(workflowId)) return [];
  return entriesOf(storage.consensus)
    .filter((n) => n.startsWith(`${workflowId}.`) && /^[A-Za-z0-9][A-Za-z0-9_-]*(\.resolved)?\.md$/.test(n.slice(workflowId.length + 1)))
    .sort();
}

function present(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function entriesOf(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

// The frontmatter text of a workflow file, LF line endings, or null.
function frontmatterOf(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  return end < 0 ? null : text.slice(4, end);
}

function unquote(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1);
  return value === '' || value === 'null' ? null : value;
}

function topScalar(fm, key) {
  for (const line of fm.split('\n')) {
    if (line.startsWith(`${key}:`)) return unquote(line.slice(key.length + 1));
  }
  return null;
}

// The lines of a top-level block (`key:` and the indented lines after it).
function blockLines(fm, key) {
  const lines = fm.split('\n');
  const start = lines.findIndex((l) => l === `${key}:` || l.startsWith(`${key}: `));
  if (start < 0) return null;
  const out = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (line !== '' && !line.startsWith(' ')) break;
    out.push(line);
  }
  return out;
}

function branchOf(fm) {
  const block = blockLines(fm, 'git_baseline');
  if (!block) return null;
  for (const line of block.slice(1)) {
    const m = /^ {2}branch:(.*)$/.exec(line);
    if (m) return unquote(m[1]);
  }
  return null;
}

// The run ids an ensemble list names, and how many entries it has.
function ensembleList(fm, key) {
  const block = blockLines(fm, key);
  if (!block) return { entries: 0, runIds: [] };
  if (/^[^:]+:\s*\[\s*\]\s*$/.test(block[0])) return { entries: 0, runIds: [] };
  let entries = 0;
  const runIds = [];
  for (const line of block.slice(1)) {
    if (/^ {2}- /.test(line)) entries += 1;
    const m = /^ {2}(?:- | {2})run_id:(.*)$/.exec(line);
    if (m) {
      const id = unquote(m[1]);
      if (id) runIds.push(id);
    }
  }
  return { entries, runIds };
}

// Every workflow record of `plugin` under `root`, in both homes, active
// (`workflows/`) and archived (`archive/`).
function recordsUnder(root, plugin, { isMain }) {
  const records = [];
  for (const { home } of SHARED_HOMES.filter((h) => h.plugin === plugin)) {
    const storage = homeStorage(root, plugin, home);
    for (const dir of ['workflows', 'archive']) {
      const abs = storage[dir];
      for (const name of entriesOf(abs)) {
        if (!name.endsWith('.md')) continue;
        if (plugin === 'orchestrator' && dir === 'workflows' && !MACRO_FILE_RE.test(name)) continue;
        const file = path.join(abs, name);
        let st;
        try {
          st = fs.lstatSync(file);
        } catch (error) {
          if (error?.code === 'ENOENT') continue;
          throw error;
        }
        if (!st.isFile()) continue;
        const fm = frontmatterOf(file);
        if (fm === null) continue;
        const ensembles = ensembleList(fm, 'ensemble_results');
        const pending = ensembleList(fm, 'pending_ensemble');
        records.push({
          plugin,
          home,
          dir,
          root,
          main: isMain,
          name,
          file,
          workflow_id: workflowIdOfText(`---\n${fm}\n---\n`) ?? name.slice(0, -3),
          parent_workflow: topScalar(fm, 'parent_workflow'),
          repo_root: topScalar(fm, 'repo_root'),
          branch: branchOf(fm),
          run_ids: [...new Set([...ensembles.runIds, ...pending.runIds])],
          pending_entries: pending.entries,
        });
      }
    }
  }
  return records;
}

// A home holds state as the writers judge it (stateHomeHasState): its
// creation lock, or an entry in workflows/, archive/ or peer-runs/.
function homeHasState(root, plugin, home) {
  const storage = homeStorage(root, plugin, home);
  if (present(storage.creationLock)) return true;
  return ['workflows', 'archive', 'peerRuns'].some((d) => entriesOf(storage[d]).length > 0);
}

function legacyHasState(root, plugin) {
  return homeHasState(root, plugin, 'legacy');
}

// `state.mjs cutover --plan`: read-only. The set, its (source, destination)
// pairs in move order, and every refusal step 3 names.
export function planCutover(checkout) {
  const main = path.resolve(checkout);
  const root = defaultStateRoot(main);
  const refusals = [];
  const notes = [];
  const attestation = attestationChecks(main);
  if (!attestation.ok) {
    refusals.push({
      code: 'attestation-failed',
      detail: `${main} does not pass the main-checkout checks: ` +
        attestation.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`).join('; ') +
        '. Run the cutover in the main checkout; a repository without one has no shared root.',
    });
  }
  if (!defaultRootWritable(main)) {
    refusals.push({ code: 'root-unwritable', detail: `the default state root ${root} cannot be written` });
  }
  const others = otherWorktreeRoots(main);
  const records = [];
  for (const plugin of PLUGINS) {
    records.push(...recordsUnder(root, plugin, { isMain: true }));
    for (const other of others) records.push(...recordsUnder(other, plugin, { isMain: false }));
  }

  const macros = records.filter((r) => r.plugin === 'orchestrator' && !r.main && r.dir === 'workflows');
  const parents = new Set([
    ...macros.map((r) => r.workflow_id),
    ...records.filter((r) => r.plugin === 'orchestrator' && r.main).map((r) => r.workflow_id),
  ]);
  const children = records.filter((r) => r.plugin === 'engineer' && !r.main && parents.has(r.parent_workflow));
  const moving = [...children, ...macros];

  const pairs = [];
  const destinations = new Map();
  const addPair = (pair) => {
    const seen = destinations.get(pair.destination);
    if (seen && !samePhysicalFile(seen.source, pair.source)) {
      refusals.push({
        code: 'duplicate-destination',
        detail: `${pair.source} and ${seen.source} would both move to ${pair.destination}`,
      });
      return;
    }
    if (seen) return;
    destinations.set(pair.destination, pair);
    pairs.push(pair);
  };

  for (const record of moving) {
    if (record.home === 'legacy') {
      refusals.push({
        code: 'source-legacy-home',
        detail: `${record.file} is in a legacy home: run runtime:migrate in ${record.root} first, ` +
          'so that every home involved is canonical (ADR-0067 Decision 4, item 4, step 3)',
      });
    }
    if (record.pending_entries > 0) {
      refusals.push({
        code: 'pending-ensemble',
        detail: `${record.file} has ${record.pending_entries} pending ensemble(s): collect or settle them first`,
      });
    }
    const source = homeStorage(record.root, record.plugin, record.home);
    const destination = homeStorage(root, record.plugin, 'canonical');
    for (const runId of record.run_ids) {
      if (!RUN_ID_RE.test(runId) || runId === '.' || runId === '..') {
        refusals.push({ code: 'run-id-invalid', detail: `${record.file} names the run id ${JSON.stringify(runId)}` });
        continue;
      }
      const ledger = path.join(source.peerRuns, runId);
      if (!present(ledger)) {
        if (present(path.join(source.peerRuns, claimName(runId)))) {
          refusals.push({
            code: 'ledger-claimed',
            detail: `the ledger of ${runId} (${record.file}) is claimed by an interrupted prune: run the peer runner's sweep in ${record.root} first`,
          });
        } else {
          notes.push(`no ledger for ${runId} under ${source.peerRuns} (pruned, or never written); nothing to move`);
        }
        continue;
      }
      addPair({
        kind: 'peer-run',
        plugin: record.plugin,
        workflow_id: record.workflow_id,
        run_id: runId,
        source_checkout: record.root,
        source: ledger,
        destination: path.join(destination.peerRuns, runId),
      });
    }
    for (const name of consensusFilesOf(source, record.workflow_id)) {
      addPair({
        kind: 'consensus',
        plugin: record.plugin,
        workflow_id: record.workflow_id,
        source_checkout: record.root,
        source: path.join(source.consensus, name),
        destination: path.join(destination.consensus, name),
      });
    }
  }
  for (const record of moving.filter((r) => r.dir === 'archive')) {
    const destination = homeStorage(root, record.plugin, 'canonical');
    addPair({
      kind: 'archive',
      plugin: record.plugin,
      workflow_id: record.workflow_id,
      source_checkout: record.root,
      source: record.file,
      destination: path.join(destination.archive, record.name),
    });
  }
  for (const record of [...children, ...macros].filter((r) => r.dir === 'workflows')) {
    const destination = homeStorage(root, record.plugin, 'canonical');
    addPair({
      kind: 'workflow',
      plugin: record.plugin,
      workflow_id: record.workflow_id,
      branch: record.branch,
      source_checkout: record.root,
      source: record.file,
      destination: path.join(destination.workflows, record.name),
    });
  }

  for (const pair of pairs) {
    if (present(pair.destination)) {
      refusals.push({ code: 'name-exists', detail: `${pair.destination} exists: ${pair.source} cannot move there` });
    }
  }
  for (const plugin of new Set(pairs.map((p) => p.plugin))) {
    if (legacyHasState(root, plugin)) {
      refusals.push({
        code: 'destination-legacy-home',
        detail: `the ${plugin} legacy home under ${root} holds state: run runtime:migrate in the main checkout ` +
          'first, so the move does not leave both homes populated (ADR-0067 Decision 4, item 4, step 3)',
      });
    }
  }

  // Branch keys: no active workflow to move may share its plugin's branch key
  // with another active workflow anywhere in the repository, the set included.
  const active = records.filter((r) => r.dir === 'workflows');
  for (const record of moving.filter((r) => r.dir === 'workflows')) {
    if (record.branch === null) {
      refusals.push({ code: 'branch-unknown', detail: `${record.file} names no git_baseline.branch` });
      continue;
    }
    const others_ = active.filter((r) => r.plugin === record.plugin && r.branch === record.branch &&
      !samePhysicalFile(r.file, record.file));
    if (others_.length > 0) {
      refusals.push({
        code: 'branch-key',
        detail: `${record.file} and ${others_.map((r) => r.file).join(', ')} are active ${record.plugin} workflows ` +
          `on the branch key ${JSON.stringify(record.branch)}: finish, finalize or archive all but one first ` +
          '(docs/runbooks/state-root-cutover.md, "Two active workflows on one branch")',
      });
    }
  }

  return {
    schema: CUTOVER_PLAN_SCHEMA,
    ok: refusals.length === 0,
    main_checkout: main,
    default_state_root: root,
    worktrees: others,
    pairs,
    refusals,
    notes,
  };
}

function isoUtc(now) {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Rename `source` to `destination`, never over an existing one and never by a
// copy (another filesystem is refused).
function renameInto(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (present(destination)) {
    throw new StateRootError(`${destination} exists: ${source} was not moved`, 'name-exists');
  }
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if (error?.code === 'EXDEV') {
      throw new StateRootError(
        `${source} and ${destination} are on two filesystems: the cutover moves by rename only, never by a copy`,
        'cross-device',
      );
    }
    throw error;
  }
}

function pairProblem(pair) {
  if (!pair || typeof pair !== 'object') return 'not an object';
  if (!['workflow', 'archive', 'peer-run', 'consensus'].includes(pair.kind)) return `kind ${JSON.stringify(pair.kind)}`;
  if (!ALL_PLUGINS.includes(pair.plugin)) return `plugin ${JSON.stringify(pair.plugin)}`;
  for (const key of ['source', 'destination', 'source_checkout']) {
    if (typeof pair[key] !== 'string' || !path.isAbsolute(pair[key])) return `${key} is not an absolute path`;
  }
  return null;
}

// The home of `plugin` under `root` that holds `file`, canonical when none
// does by its path.
function homeHolding(root, plugin, file) {
  return SHARED_HOMES.find((h) => h.plugin === plugin && file.startsWith(`${path.join(root, h.rel)}${path.sep}`))?.home ?? 'canonical';
}

// One pair: a workflow file under its write lock; an archived file or a
// ledger under the creation locks, the default state root's home first, then
// the checkout's (Decision 2's order). A cutover pair goes from its
// source_checkout to the root; a rollback pair from the root to its
// destination_checkout.
async function movePair(pair, root, { withFileLock, withDirectoryLock }) {
  if (pair.kind === 'workflow') {
    await withFileLock(pair.source, async () => renameInto(pair.source, pair.destination));
    return;
  }
  const back = typeof pair.destination_checkout === 'string';
  const checkout = back ? pair.destination_checkout : pair.source_checkout;
  const atRoot = back ? pair.source : pair.destination;
  const atCheckout = back ? pair.destination : pair.source;
  const first = homeStorage(root, pair.plugin, homeHolding(root, pair.plugin, atRoot));
  const second = homeStorage(checkout, pair.plugin, homeHolding(checkout, pair.plugin, atCheckout));
  await withDirectoryLock(root, () => withDirectoryLock(checkout, async () => {
    renameInto(pair.source, pair.destination);
  }, { storage: second }), { storage: first });
}

// Every pair judged before any moves: source only, move it; destination only,
// it has moved; both (a copy) or neither (a loss), refuse.
function judgePairs(file, pairs) {
  const judged = pairs.map((pair) => {
    const problem = pairProblem(pair);
    if (problem) return { pair, problem };
    return { pair, source: present(pair.source), destination: present(pair.destination) };
  });
  const refusals = [];
  for (const j of judged) {
    if (j.problem) refusals.push({ code: 'manifest-invalid', detail: `${file}: a pair's ${j.problem}` });
    else if (j.source && j.destination) {
      refusals.push({ code: 'pair-copied', detail: `${j.pair.source} and ${j.pair.destination} both exist: one is a copy` });
    } else if (!j.source && !j.destination) {
      refusals.push({ code: 'pair-lost', detail: `neither ${j.pair.source} nor ${j.pair.destination} exists` });
    }
  }
  return { judged, refusals };
}

// Move every judged pair still at its source, appending each moved record to
// the manifest after its rename; a pair already moved but not recorded is
// recorded. Returns the sources moved now.
async function moveJudged(file, doc, judged, root, locks) {
  const movedNow = [];
  const recorded = new Set(doc.moved.map((m) => m.source));
  for (const { pair, source } of judged) {
    if (source) {
      await movePair(pair, root, locks);
      movedNow.push(pair.source);
    } else if (recorded.has(pair.source)) {
      continue;
    }
    doc.moved.push({
      kind: pair.kind,
      plugin: pair.plugin,
      workflow_id: pair.workflow_id ?? null,
      run_id: pair.run_id ?? null,
      source_checkout: pair.source_checkout,
      ...(pair.destination_checkout ? { destination_checkout: pair.destination_checkout } : {}),
      source: pair.source,
      destination: pair.destination,
      moved_at: isoUtc(new Date()),
    });
    recorded.add(pair.source);
    writeJsonAtomic(file, doc);
  }
  return movedNow;
}

// Whether a pair of the manifest is still at its source: a move it began has
// not finished.
function hasPairAtSource(doc) {
  return (Array.isArray(doc.pairs) ? doc.pairs : []).some((p) => typeof p?.source === 'string' && present(p.source));
}

// `state.mjs cutover --move`: the manifest first, then each pair, its `moved`
// record appended after it. A rerun continues the open manifest (one without
// an inventory) while a pair of it is still at its source: it judges every
// pair before moving any, and refuses a pair whose source and destination
// both exist (a copy) or neither does (a loss). Once none is, the move it
// holds has finished (enable never closes one made after the switch is on),
// so the rerun plans again: a macro or child that has come into a linked
// worktree's own home since moves under a manifest of its own. A move killed
// after its last rename, before that pair's record, has finished too: the
// rerun records each pair found at its destination and not yet recorded in
// that manifest first.
export async function moveCutover(checkout, { withFileLock, withDirectoryLock, now = new Date() }) {
  const main = path.resolve(checkout);
  const root = defaultStateRoot(main);
  const attestation = attestationChecks(main);
  if (!attestation.ok) {
    return { ok: false, refusals: [{ code: 'attestation-failed', detail: `${main} does not pass the main-checkout checks` }] };
  }
  if (!defaultRootWritable(main)) {
    return { ok: false, refusals: [{ code: 'root-unwritable', detail: `the default state root ${root} cannot be written` }] };
  }
  let open = newestOpenCutoverManifest(main);
  if (open && Array.isArray(open.doc.pairs) && !hasPairAtSource(open.doc)) {
    if (Array.isArray(open.doc.moved)) {
      const finished = open.doc.pairs.filter((pair) => !pairProblem(pair) && present(pair.destination));
      await moveJudged(open.file, open.doc, finished.map((pair) => ({ pair, source: false })), root, { withFileLock, withDirectoryLock });
    }
    open = null;
  }
  let resumed = true;
  if (!open) {
    resumed = false;
    const plan = planCutover(main);
    if (!plan.ok) return { ok: false, refusals: plan.refusals, plan };
    if (plan.pairs.length === 0) {
      return { ok: true, manifest: null, moved: [], resumed: false, notes: [...plan.notes, 'nothing to move'] };
    }
    const at = isoUtc(now);
    const file = path.join(root, CUTOVER_RUNS_REL, `${at.replace(/[-:]/g, '')}-${randomBytes(3).toString('hex')}.json`);
    const doc = {
      schema: CUTOVER_MANIFEST_SCHEMA,
      kind: 'cutover',
      created_at: at,
      main_checkout: main,
      pairs: plan.pairs,
      moved: [],
      inventory: null,
    };
    writeJsonAtomic(file, doc);
    open = { file, doc };
  }
  const { file, doc } = open;
  if (!Array.isArray(doc.pairs) || !Array.isArray(doc.moved)) {
    throw new StateRootError(`${file} has no pairs or moved list: repair or remove it by hand`, 'manifest-invalid');
  }
  const { judged, refusals } = judgePairs(file, doc.pairs);
  if (refusals.length > 0) return { ok: false, manifest: file, refusals };
  const movedNow = await moveJudged(file, doc, judged, root, { withFileLock, withDirectoryLock });
  const left = doc.pairs.filter((p) => present(p.source));
  if (left.length > 0) {
    return {
      ok: false,
      manifest: file,
      refusals: left.map((p) => ({ code: 'source-left', detail: `${p.source} still exists after the move` })),
    };
  }
  return { ok: true, manifest: file, moved: movedNow, resumed };
}

// `state.mjs cutover --verify` (step 6), run from the main checkout or any
// other: it judges the repository from its default state root. The switch is
// on; every macro a cutover in force moved is judged by where it is now:
// still active, it resolves, from every checkout of the repository, to its
// destination, by its id and by each subtask branch, and its plan reads as
// next-ready reads it; archived since (its Stop archives it once it
// finishes), it is in the default state root's archive and no checkout
// resolves its id to an active file. No source path of those cutovers has
// come back, and no linked worktree's own home holds an active child of a
// macro under the default state root. Every cutover manifest not rolled back
// is read, so an enable interrupted after it closed the move's manifest, and
// rerun into an inventory-only one, still verifies the move, and so does a
// later move's manifest.
export async function verifyCutover(checkout, { resolveMacroById, findMacroBySubtaskBranch, readWorkflow, subtaskReadiness }) {
  const root = defaultStateRoot(path.resolve(checkout));
  const main = root;
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok, detail });
  const switchState = readSharedCreation(main).state;
  add('shared-creation-on', switchState === 'on', `the shared-creation switch is ${switchState}`);
  const inForce = manifestsUnder(root).filter((m) => m.doc.kind === 'cutover' && !m.doc.rolled_back_at);
  const pairs = inForce.flatMap((m) => (Array.isArray(m.doc.pairs) ? m.doc.pairs : []));
  add('manifest', inForce.length > 0, inForce.length > 0
    ? inForce.map((m) => m.file).join(', ')
    : 'no cutover manifest under the default state root');
  const others = otherWorktreeRoots(main);
  const rootMacros = recordsUnder(root, 'orchestrator', { isMain: true });
  for (const pair of pairs.filter((p) => p.kind === 'workflow' && p.plugin === 'orchestrator')) {
    const archived = present(pair.destination)
      ? []
      : rootMacros.filter((r) => r.dir === 'archive' && r.workflow_id === pair.workflow_id);
    if (archived.length > 0) {
      for (const at of [main, ...others]) {
        let found = null;
        let error = null;
        try {
          found = await resolveMacroById(at, pair.workflow_id);
        } catch (err) {
          error = err.message;
        }
        add('macro-archived', found === null && error === null, `${pair.workflow_id} from ${at}: ` +
          (error ?? (found ? `active at ${found}` : `archived at ${archived.map((r) => r.file).join(', ')}`)));
      }
      continue;
    }
    for (const at of [main, ...others]) {
      let found = null;
      let error = null;
      try {
        found = await resolveMacroById(at, pair.workflow_id);
      } catch (err) {
        error = err.message;
      }
      const ok = found !== null && samePhysicalFile(found, pair.destination);
      add('macro-resolves', ok, `${pair.workflow_id} from ${at}: ${error ?? found ?? 'not found'}`);
    }
    // next-ready's own judgment: the parse refuses a plan it cannot work from
    // (subtasks not a list, an unknown blocked_by id, a cycle), and next-ready
    // refuses a schema 1.0 plan.
    let subtasks = [];
    try {
      const { frontmatter } = await readWorkflow(pair.destination);
      subtasks = frontmatter.plan?.subtasks ?? [];
      const readiness = subtaskReadiness(subtasks);
      const problem = frontmatter.schema === '1.0' ? 'a schema 1.0 plan, which next-ready refuses' : null;
      add('next-ready', problem === null, problem === null
        ? `${pair.workflow_id}: ${subtasks.length} subtask(s), ${readiness.filter((r) => r.ready).length} ready`
        : `${pair.destination}: ${problem}`);
    } catch (err) {
      add('next-ready', false, `${pair.destination}: ${err.message}`);
    }
    for (const branch of new Set(subtasks.map((s) => s?.branch).filter((b) => typeof b === 'string' && b))) {
      for (const at of [main, ...others]) {
        let found = null;
        let error = null;
        try {
          found = await findMacroBySubtaskBranch(at, branch);
        } catch (err) {
          error = err.message;
        }
        add('find-macro', found !== null && samePhysicalFile(found, pair.destination),
          `subtask branch ${branch} from ${at}: ${error ?? found ?? 'not found'}`);
      }
    }
  }
  const back = pairs.filter((p) => typeof p.source === 'string' && present(p.source));
  add('sources-absent', back.length === 0, back.length === 0
    ? `none of the ${pairs.length} source paths exists`
    : `back at their source: ${back.map((p) => p.source).join(', ')}`);
  const macroIds = new Set(rootMacros.map((r) => r.workflow_id));
  const stray = others.flatMap((other) => recordsUnder(other, 'engineer', { isMain: false }))
    .filter((r) => r.dir === 'workflows' && macroIds.has(r.parent_workflow));
  add('no-stray-children', stray.length === 0, stray.length === 0
    ? 'no linked worktree holds an active child of a macro under the default state root'
    : `active children left in linked worktrees: ${stray.map((r) => r.file).join(', ')}`);
  return {
    schema: CUTOVER_VERIFY_SCHEMA,
    ok: checks.every((c) => c.ok),
    main_checkout: main,
    default_state_root: root,
    manifests: inForce.map((m) => m.file),
    checks,
  };
}

// ---------------------------------------------------------------------------
// Rollback (Decision 4, item 4, Rollback): `state.mjs cutover --rollback
// --plan | --move`, refused once lanes have first run. Plan first: every
// refusal is found before anything changes, so a refused rollback leaves the
// switch on. Then the rollback writes its own manifest, turns shared creation
// off and moves, by the cutover's rules and locks.

export const ROLLBACK_PLAN_SCHEMA = 'agentic-state-rollback-plan-1.0';
const SETTLED_SUBTASK = new Set(['completed', 'deferred', 'abandoned']);
const KIND_ORDER = { 'peer-run': 0, consensus: 0, archive: 1, workflow: 2 };

// Every manifest under the default state root, oldest first. One that cannot
// be read refuses: the rollback takes its destinations from all of them.
function manifestsUnder(root) {
  const dir = path.join(root, CUTOVER_RUNS_REL);
  const out = [];
  for (const name of entriesOf(dir).filter((n) => n.endsWith('.json'))) {
    const file = path.join(dir, name);
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new StateRootError(
        `${file} cannot be read or parsed (${error?.code || error?.message}): the rollback takes each record's checkout from the manifests`,
        'manifest-invalid',
      );
    }
    if (doc?.schema === CUTOVER_MANIFEST_SCHEMA) out.push({ file, doc });
  }
  return out;
}

export async function planRollback(checkout, { readWorkflow }) {
  const main = path.resolve(checkout);
  const root = defaultStateRoot(main);
  const refusals = [];
  const attestation = attestationChecks(main);
  if (!attestation.ok) {
    refusals.push({
      code: 'attestation-failed',
      detail: `${main} does not pass the main-checkout checks: ` +
        attestation.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`).join('; '),
    });
  }
  if (!defaultRootWritable(main)) {
    refusals.push({ code: 'root-unwritable', detail: `the default state root ${root} cannot be written` });
  }
  const switchInfo = readSharedCreation(main);
  if (switchInfo.state === 'unreadable') refusals.push({ code: 'switch-unreadable', detail: switchInfo.error });
  if (switchInfo.record?.lanes_first_run_at) {
    refusals.push({
      code: 'lanes-have-run',
      detail: `lanes first ran at ${switchInfo.record.lanes_first_run_at}: the cutover can no longer be rolled back; repair forward`,
    });
  }
  const cutovers = manifestsUnder(root).filter((m) => m.doc.kind === 'cutover' && !m.doc.rolled_back_at);
  const others = otherWorktreeRoots(main);
  // A cutover's move interrupted (no inventory, a pair still at its source:
  // before step 5, or a later move after it) is reversed from its manifest,
  // by step 4's rule with the pairs swapped: a pair it moved goes back to its
  // source, one it never moved stays, and one found at both ends or at
  // neither is refused, as a rerun of the move would refuse it. The records
  // found afresh below leave alone what a swapped pair already sends back.
  const swapped = [];
  for (const m of cutovers.filter((x) => !x.doc.inventory)) {
    const pairsOf = Array.isArray(m.doc.pairs) ? m.doc.pairs : [];
    if (!hasPairAtSource(m.doc)) continue;
    const judged = judgePairs(m.file, pairsOf);
    refusals.push(...judged.refusals);
    for (const j of judged.judged) {
      if (j.problem || j.source || !j.destination) continue;
      if (!others.some((o) => sameDirectory(o, j.pair.source_checkout))) {
        refusals.push({
          code: 'checkout-gone',
          detail: `${j.pair.destination} (moved by the interrupted cutover ${m.file}) goes back to ${j.pair.source_checkout}, which is no worktree of this repository now`,
        });
        continue;
      }
      swapped.push({
        ...j.pair,
        source_checkout: root,
        destination_checkout: j.pair.source_checkout,
        source: j.pair.destination,
        destination: j.pair.source,
      });
    }
  }
  const swappedFrom = new Map(swapped.map((p) => [p.source, p.destination_checkout]));
  // Each moved record's source checkout, by workflow id (a later manifest
  // wins), and the inventory of what the default state root held at step 5.
  const sourceOf = new Map();
  const inventory = new Set();
  for (const m of cutovers) {
    for (const p of Array.isArray(m.doc.pairs) ? m.doc.pairs : []) {
      if (p?.kind !== 'peer-run' && typeof p?.workflow_id === 'string' && typeof p?.source_checkout === 'string') {
        sourceOf.set(p.workflow_id, p.source_checkout);
      }
    }
    for (const id of m.doc.inventory?.workflow_ids ?? []) inventory.add(id);
  }

  const rootRecords = ALL_PLUGINS.flatMap((p) => recordsUnder(root, p, { isMain: true }));
  const otherRecords = others.flatMap((o) => ALL_PLUGINS.flatMap((p) => recordsUnder(o, p, { isMain: false })));
  const endsIn = new Map();
  const pairs = [...swapped];
  for (const record of rootRecords) {
    if (swappedFrom.has(record.file)) {
      endsIn.set(record.file, swappedFrom.get(record.file));
      continue;
    }
    let target = null;
    let why = null;
    if (sourceOf.has(record.workflow_id)) {
      target = sourceOf.get(record.workflow_id);
      why = 'moved by the cutover';
    } else if (!inventory.has(record.workflow_id) && typeof record.repo_root === 'string' &&
        path.isAbsolute(record.repo_root) && !sameDirectory(record.repo_root, main)) {
      // Created after the switch: repo_root names the creating checkout. It
      // is never read for a record the inventory holds.
      target = record.repo_root;
      why = 'created after the switch';
    }
    if (target === null || sameDirectory(target, root)) {
      endsIn.set(record.file, root);
      continue;
    }
    const live = others.find((o) => sameDirectory(o, target));
    if (!live) {
      refusals.push({
        code: 'checkout-gone',
        detail: `${record.file} (${why}) goes back to ${target}, which is no worktree of this repository now`,
      });
      continue;
    }
    if (isUnderLanesDirectory(live, root)) {
      refusals.push({
        code: 'checkout-is-lane',
        detail: `${record.file} (${why}) would go back to the lane ${live}, whose home no older tuple reads`,
      });
      continue;
    }
    endsIn.set(record.file, live);
    // The checkout's writers refuse a plugin whose two homes both hold state
    // (ADR-0025): a record sent into one while the other holds state would
    // stop every write there.
    const otherHome = record.home === 'canonical' ? 'legacy' : 'canonical';
    if (SHARED_HOMES.some((h) => h.plugin === record.plugin && h.home === otherHome) &&
        homeHasState(live, record.plugin, otherHome)) {
      refusals.push({
        code: 'destination-two-homes',
        detail: `${record.file} would go back to ${live}'s ${record.home} ${record.plugin} home while its ${otherHome} ` +
          `home holds state, and that checkout's writers refuse both: run runtime:migrate in ${live} first`,
      });
    }
    const from = homeStorage(root, record.plugin, record.home);
    const to = homeStorage(live, record.plugin, record.home);
    for (const runId of record.run_ids) {
      if (!RUN_ID_RE.test(runId) || runId === '.' || runId === '..') continue;
      const ledger = path.join(from.peerRuns, runId);
      if (!present(ledger)) {
        // A prune killed after its claim leaves the ledger under another name,
        // where the old tuple would never find it; the cutover's plan refuses
        // it the same way.
        if (present(path.join(from.peerRuns, claimName(runId)))) {
          refusals.push({
            code: 'ledger-claimed',
            detail: `the ledger of ${runId} (${record.file}) is claimed by an interrupted prune: run the peer runner's sweep in ${root} first`,
          });
        }
        continue;
      }
      pairs.push({
        kind: 'peer-run', plugin: record.plugin, workflow_id: record.workflow_id, run_id: runId,
        source_checkout: root, destination_checkout: live, source: ledger, destination: path.join(to.peerRuns, runId),
      });
    }
    for (const name of consensusFilesOf(from, record.workflow_id)) {
      pairs.push({
        kind: 'consensus', plugin: record.plugin, workflow_id: record.workflow_id,
        source_checkout: root, destination_checkout: live, source: path.join(from.consensus, name), destination: path.join(to.consensus, name),
      });
    }
    pairs.push({
      kind: record.dir === 'archive' ? 'archive' : 'workflow', plugin: record.plugin, workflow_id: record.workflow_id,
      source_checkout: root, destination_checkout: live, source: record.file, destination: path.join(to[record.dir], record.name),
    });
  }
  for (const record of otherRecords) endsIn.set(record.file, record.root);
  pairs.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const seen = new Set();
  for (const pair of pairs) {
    if (present(pair.destination)) {
      refusals.push({ code: 'name-exists', detail: `${pair.destination} exists: ${pair.source} cannot go back there` });
    }
    if (seen.has(pair.destination)) refusals.push({ code: 'duplicate-destination', detail: `two records would go to ${pair.destination}` });
    seen.add(pair.destination);
  }

  // An active macro and a child it still needs end in one checkout: the old
  // tuple's writeback and child scans search one checkout each.
  const all = [...rootRecords, ...otherRecords];
  for (const macro of all.filter((r) => r.plugin === 'orchestrator' && r.dir === 'workflows')) {
    let subtasks = [];
    try {
      subtasks = (await readWorkflow(macro.file)).frontmatter.plan?.subtasks ?? [];
    } catch (error) {
      refusals.push({ code: 'macro-unreadable', detail: `${macro.file}: ${error.message}` });
      continue;
    }
    const awaited = new Set(subtasks
      .filter((s) => s && !SETTLED_SUBTASK.has(s.status) && typeof s.engineer_workflow_id === 'string')
      .map((s) => s.engineer_workflow_id));
    const macroAt = endsIn.get(macro.file);
    for (const child of all.filter((r) => r.plugin === 'engineer' && r.parent_workflow === macro.workflow_id)) {
      if (child.dir !== 'workflows' && !awaited.has(child.workflow_id)) continue;
      const childAt = endsIn.get(child.file);
      if (macroAt === undefined || childAt === undefined || sameDirectory(macroAt, childAt)) continue;
      refusals.push({
        code: 'macro-child-split',
        detail: `the active macro ${macro.workflow_id} would end in ${macroAt} and its child ${child.workflow_id}, ` +
          `which it still needs, in ${childAt}: land and record that subtask, or finish or detach the child, first`,
      });
    }
  }
  return {
    schema: ROLLBACK_PLAN_SCHEMA,
    ok: refusals.length === 0,
    main_checkout: main,
    default_state_root: root,
    shared_creation: switchInfo.state,
    cutover_manifests: cutovers.map((m) => m.file),
    pairs,
    refusals,
  };
}

function newestOpenRollbackManifest(root) {
  const open = manifestsUnder(root).filter((m) => m.doc.kind === 'rollback' && !m.doc.completed_at);
  return open.length > 0 ? open[open.length - 1] : null;
}

export async function moveRollback(checkout, { withFileLock, withDirectoryLock, readWorkflow, now = new Date() }) {
  const main = path.resolve(checkout);
  const root = defaultStateRoot(main);
  if (!attestationChecks(main).ok) {
    return { ok: false, refusals: [{ code: 'attestation-failed', detail: `${main} does not pass the main-checkout checks` }] };
  }
  if (!defaultRootWritable(main)) {
    return { ok: false, refusals: [{ code: 'root-unwritable', detail: `the default state root ${root} cannot be written` }] };
  }
  let open = newestOpenRollbackManifest(root);
  const resumed = open !== null;
  if (!open) {
    const plan = await planRollback(main, { readWorkflow });
    if (!plan.ok) return { ok: false, refusals: plan.refusals, plan };
    const at = isoUtc(now);
    const file = path.join(root, CUTOVER_RUNS_REL, `${at.replace(/[-:]/g, '')}-${randomBytes(3).toString('hex')}.json`);
    const doc = {
      schema: CUTOVER_MANIFEST_SCHEMA,
      kind: 'rollback',
      created_at: at,
      main_checkout: main,
      cutover_manifests: plan.cutover_manifests,
      pairs: plan.pairs,
      moved: [],
      completed_at: null,
    };
    writeJsonAtomic(file, doc);
    open = { file, doc };
  }
  const { file, doc } = open;
  if (!Array.isArray(doc.pairs) || !Array.isArray(doc.moved)) {
    throw new StateRootError(`${file} has no pairs or moved list: repair or remove it by hand`, 'manifest-invalid');
  }
  // Nothing more is created under the default state root from here on.
  const switched = disableSharedCreation({ checkout: main, now });
  const { judged, refusals } = judgePairs(file, doc.pairs);
  if (refusals.length > 0) return { ok: false, manifest: file, refusals };
  const movedNow = await moveJudged(file, doc, judged, root, { withFileLock, withDirectoryLock });
  const left = doc.pairs.filter((p) => present(p.source));
  if (left.length > 0) {
    return { ok: false, manifest: file, refusals: left.map((p) => ({ code: 'source-left', detail: `${p.source} still exists after the move` })) };
  }
  const at = isoUtc(new Date());
  for (const cutoverFile of Array.isArray(doc.cutover_manifests) ? doc.cutover_manifests : []) {
    const m = JSON.parse(fs.readFileSync(cutoverFile, 'utf8'));
    if (!m.rolled_back_at) writeJsonAtomic(cutoverFile, { ...m, rolled_back_at: at, rolled_back_by: file });
  }
  doc.completed_at = at;
  writeJsonAtomic(file, doc);
  return { ok: true, manifest: file, moved: movedNow, resumed, shared_creation: switched.switch?.enabled ? 'on' : 'off' };
}
