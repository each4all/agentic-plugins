// A scratch orchestrator half for the Decision 2, item 10 takeover prototype
// (ADR-0068, implementation note of 2026-10-25). It is NOT the orchestrator's
// hold implementation: `impl-hold` writes that in plugins/orchestrator, with
// its own record layout, locks, crash recovery and commands. This file is the
// smallest reader and writer of the shared files (N1-N3, N6, N7) that can
// drive a takeover end to end against the real persona scripts, so that the
// persona half is proven against an orchestrator half before it ships.
//
// What it does, and nothing more:
// - activate: writes `protocol.json` (N2);
// - hold: writes the owner's record (N3) and a pending handoff;
// - handoff: completes it once nothing of the lane is open (item 4): no
//   persona operation (an entry of the child, or a record under ops/ with no
//   `.cleared` beside it), no pending ensemble, no workflow file lock;
// - release: refuses while a writer may still be active (item 7), withdraws a
//   pending hold, and otherwise records the comparison basis: the lane's tree
//   digest (every non-ignored file) and the child's content digest, read
//   through the persona's own `state.mjs content-digest`;
// - compare: before the lane's next step, once: consumed (equal) or rejected
//   (different, the lane parks owner-choice);
// - resumeFrom: what the driver does next (item 10): the child's next_step, a
//   committed child waiting to land, or no child to dispatch.
//
// It takes no lock of its own (its records are written whole), runs no driver
// and spawns no worker: a test drives the persona's runbook blocks itself.
// Known limits, each impl-hold's to get right: the tree digest reads no
// checked-out submodule (item 7 covers them; a submodule's directory is
// skipped here), there is no lane fingerprint, no live-run or worker check,
// no crash recovery, and records are trusted as well formed.
// Not discovered by `node --test`: the stem starts with `_`.

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HOLDS_REL = '.agentic-plugins/runs/autopilot/holds';

function writeWhole(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}
const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);

// The child's frontmatter, read as data: the scratch half needs a handful of
// scalar fields and the operations document, never the persona's parser.
const frontmatterOf = (text) => text.slice(0, text.indexOf('\n---\n', 4) + 1);
function frontmatterScalar(text, key) {
  const m = new RegExp(`^${key}: (.*)$`, 'm').exec(frontmatterOf(text));
  if (!m) return undefined;
  const raw = m[1].trim();
  if (raw === '[]') return [];
  return raw.startsWith('"') ? JSON.parse(raw) : raw;
}

export function scratchOrchestrator({ main, macro, engineerStateBin, env }) {
  const dir = join(main, HOLDS_REL, macro);
  const file = (kind, subtask) => join(dir, kind, `${subtask}.json`);
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env }).trimEnd();

  function contentDigest(workflowPath) {
    const r = spawnSync(process.execPath, [engineerStateBin, 'content-digest', '--workflow-path', workflowPath], { encoding: 'utf8', env });
    if (r.status !== 0) throw new Error(`content-digest failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    if (out.schema !== 'agentic-workflow-content-digest-1') throw new Error(`content-digest schema ${out.schema}`);
    return out.digest;
  }

  // Every non-ignored file of the lane, by path and content (a link by its
  // target, a deleted tracked file as deleted), and HEAD.
  function treeDigest(lane) {
    const h = createHash('sha256');
    h.update(`head ${git(lane, 'rev-parse', 'HEAD')}\n`);
    const names = git(lane, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean);
    for (const name of [...new Set(names)].sort()) {
      const p = join(lane, name);
      let st;
      try { st = lstatSync(p); } catch { h.update(`deleted ${name}\n`); continue; }
      if (st.isDirectory()) { h.update(`directory ${name}\n`); continue; }
      if (st.isSymbolicLink()) h.update(`link ${name} ${readlinkSync(p)}\n`);
      else h.update(`file ${name} ${st.mode & 0o111 ? 'x' : '-'} ${createHash('sha256').update(readFileSync(p)).digest('hex')}\n`);
    }
    return h.digest('hex');
  }

  // What still blocks a handoff or a release in the lane (items 4 and 7).
  function blockers(subtask, childPath) {
    const out = [];
    const opsDir = join(dir, 'ops', subtask);
    // A `.cleared` counts by its name in the directory, as the persona reads
    // it (operationCleared), a dangling link included.
    const names = existsSync(opsDir) ? readdirSync(opsDir) : [];
    const cleared = (id) => names.includes(`${id}.cleared`);
    {
      for (const n of names) {
        const m = /^(op-\d{8}T\d{6}Z-[0-9a-f]{8})\.json$/.exec(n);
        if (m && !cleared(m[1])) out.push(`persona operation ${m[1]} (record)`);
      }
    }
    if (childPath && existsSync(childPath)) {
      const text = readFileSync(childPath, 'utf8');
      const ops = frontmatterScalar(text, 'persona_operations');
      for (const op of ops ? JSON.parse(ops).ops : []) {
        if (!cleared(op.id)) out.push(`persona operation ${op.id} (entry)`);
      }
      if (/^pending_ensemble:[ \t]*\n[ \t]+- /m.test(frontmatterOf(text))) out.push('a pending peer ensemble');
    }
    // Judged by its presence, never by taking it (N5), whether or not the
    // workflow file is still there.
    if (childPath && existsSync(`${childPath}.lock`)) out.push('the workflow file lock');
    return [...new Set(out)];
  }

  return {
    dir,
    contentDigest,
    treeDigest,
    blockers,

    activate() {
      writeWhole(join(dir, 'protocol.json'), { schema: 'agentic-holds-protocol-1', protocol: 1, written_by: 'scratch-orchestrator', at: new Date().toISOString() });
    },

    hold({ subtask, branch, lane, child }) {
      const holdId = randomBytes(8).toString('hex');
      writeWhole(file('holds', subtask), {
        schema: 'agentic-hold-1', hold_id: holdId, subtask_id: subtask, branch, lane, child, state: 'held', set_by: 'owner', set_at: new Date().toISOString(),
      });
      writeWhole(file('handoffs', subtask), { hold_id: holdId, state: 'pending' });
      return holdId;
    },

    // Completes a pending handoff once nothing of the lane is open.
    handoff(subtask, childPath) {
      const h = readJson(file('handoffs', subtask));
      if (h.state === 'held') return { state: 'held', blockers: [] };
      const b = blockers(subtask, childPath);
      if (b.length > 0) return { state: 'pending', blockers: b };
      writeWhole(file('handoffs', subtask), { ...h, state: 'held' });
      return { state: 'held', blockers: [] };
    },

    release({ subtask, holdId, lane, childPath }) {
      const hold = readJson(file('holds', subtask));
      if (hold?.hold_id !== holdId || hold.state !== 'held') return { refused: `no hold ${holdId} held on ${subtask}` };
      const handoff = readJson(file('handoffs', subtask));
      if (handoff.state === 'pending') {
        writeWhole(file('holds', subtask), { ...hold, state: 'released' });
        return { withdrawn: true };
      }
      const b = blockers(subtask, childPath);
      if (b.length > 0) return { refused: `a writer may still be active in the lane: ${b.join(', ')}` };
      const basis = { tree: treeDigest(lane), workflow: childPath && existsSync(childPath) ? contentDigest(childPath) : null };
      writeWhole(file('releases', subtask), { hold_id: holdId, state: 'awaiting', basis });
      writeWhole(file('holds', subtask), { ...hold, state: 'released' });
      return { released: true, basis };
    },

    // Before the lane's next step, once (item 7).
    compare({ subtask, lane, childPath }) {
      const rel = readJson(file('releases', subtask));
      if (rel.state !== 'awaiting') return { state: rel.state, compared: false };
      const now = { tree: treeDigest(lane), workflow: childPath && existsSync(childPath) ? contentDigest(childPath) : null };
      const equal = now.tree === rel.basis.tree && now.workflow === rel.basis.workflow;
      writeWhole(file('releases', subtask), { ...rel, state: equal ? 'consumed' : 'rejected', at_compare: now });
      // Equal: the lane's kept park ends (item 7). Different: it parks.
      if (equal) rmSync(file('parks', subtask), { force: true });
      else writeWhole(file('parks', subtask), { schema: 'agentic-autopilot-park-1.0', record_id: randomBytes(8).toString('hex'), subtask_id: subtask, state: 'parked', reason: 'owner-choice' });
      return { state: equal ? 'consumed' : 'rejected', compared: true, now, basis: rel.basis };
    },

    // Item 10: what the driver does next, after a consumed release.
    resumeFrom({ childPath, archivedPath = null }) {
      if (childPath && existsSync(childPath)) {
        const text = readFileSync(childPath, 'utf8');
        const kind = frontmatterScalar(text, 'next_step_kind');
        if (kind === 'verb') return { action: 'dispatch-verb', verb: frontmatterScalar(text, 'next_step_verb') };
        if (kind === 'commit') return { action: 'commit' };
        if (kind === 'owner-decision') return { action: 'park', gate: frontmatterScalar(text, 'awaiting_owner_gate') };
        return { action: 'unknown', kind };
      }
      if (archivedPath && existsSync(archivedPath)) {
        const phase = frontmatterScalar(readFileSync(archivedPath, 'utf8'), 'current_phase');
        return phase === 'commit-complete' ? { action: 'wait-to-land' } : { action: 'unknown', phase };
      }
      return { action: 'dispatch' };
    },
  };
}
