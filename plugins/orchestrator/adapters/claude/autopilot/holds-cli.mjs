// plugins/orchestrator/adapters/claude/autopilot/holds-cli.mjs
//
// ADR-0068 Decision 2 — the owner's hold commands, reached through
// `agentic-autopilot` and `/orchestrator:autopilot`:
//
//   hold <subtask> --macro <id>                 hold a lane for a person
//   release <subtask> --macro <id> --hold <id>  give a held lane back
//   release <subtask> --macro <id> --discard-unreadable
//                                               discard a record that cannot be read
//   writer-clear <subtask> --macro <id> --operation <id>
//                                               the owner's word that an operation's session is gone
//   status --macro <id>                         the macro's holds, from any checkout, run or none
//
// A caller whose AGENTIC_AUTOPILOT names a run is refused (cli.mjs): a worker
// never holds or releases a lane. Every text crosses as ids only.

import fs from 'node:fs';
import path from 'node:path';

import {
  appendHoldEvent, clearOperation, describeOperations, readWorkflowFacts, discardedDir, HOLD_PERSONA_CAPABILITY, HOLDS_CAPABILITY,
  holdStateOf, isSafeSubtaskId, listRecordIds, liveRuns, OPERATION_ID_RE, openOperations, readJson, readKeptPark,
  newRecordId, readActivation, readOps, readOwnerHold, readRecord, readRegular, recordPath, unlinkQuiet, withHoldsLock, writeWhole,
} from '../../../scripts/lib/holds.mjs';
import { removeSubtaskFences } from '../../../scripts/lib/run-locks.mjs';
import {
  branchLane, completeHandoff, HoldRefusal, laneOf, orphanStale, releaseHold, repairHoldFence, retireMacroHolds, retireSubtaskHolds, setHold,
  withdrawUnhandedHold,
} from '../../../scripts/lib/hold-ops.mjs';
import { activateHolds } from '../../../scripts/lib/hold-activation.mjs';
import { repositoryRoots } from '../../../scripts/lib/state-root.mjs';
import { contentDigest, treeDigest, TREE_DIGEST_VERSION, unignoredStatePaths } from '../../../scripts/lib/lane-digest.mjs';
import { parseWorkflowFile } from '../../../scripts/state.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { laneHome, lanePath, listWorktrees, parseLockReason } from './lanes.mjs';
import { mainWorktreeRoot } from './ledger.mjs';
import { observe } from './observe.mjs';
import { deletePark, readPark } from './parks.mjs';
import { parkFingerprint, PARK_FINGERPRINT_VERSION } from './policy.mjs';
import { resolveRoots } from './roots.mjs';

const STATE_REL = '.agentic-plugins/state/orchestrator';

/** The macro's plan from its workflow file under the main checkout, live or archived: `{ fm, path, archived }` or `{ problem }`. */
export function readMacro(mainRoot, macroId) {
  for (const sub of ['workflows', 'archive']) {
    const file = path.join(mainRoot, STATE_REL, sub, `${macroId}.md`);
    const r = readRegular(file);
    if (r.absent) continue;
    if (r.error) return { problem: r.error };
    try {
      return { fm: parseWorkflowFile(r.text).frontmatter, path: file, archived: sub === 'archive' };
    } catch (err) {
      return { problem: `${file} cannot be parsed (${err.message})` };
    }
  }
  return { problem: `macro ${macroId} has no workflow file under ${path.join(mainRoot, STATE_REL)}` };
}

/**
 * The lane's fingerprint as a park takes it (policy.mjs `parkFingerprint`,
 * peer bookkeeping included, P13), for a release's basis and the driver's
 * comparison alike: the lane's own look, or with no worktree a look of the
 * main checkout with the subtask's branch tip. `{ version, fingerprint }`.
 */
export function releaseFingerprint({ mainRoot, macroId, subtaskId, env = process.env, roots = null }) {
  return async ({ laneRoot, hold }) => {
    const r = roots ?? await resolveRoots({ env });
    const rootsNow = r.roots ?? r;
    const view = observe({ repoRoot: laneRoot ?? mainRoot, roots: rootsNow, macroId, fetch: false, env });
    let branchTip = null;
    if (!laneRoot) {
      try {
        branchTip = execFileSync('git', ['-C', mainRoot, 'rev-parse', '--verify', '-q', `refs/heads/${hold.branch}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
      } catch { branchTip = null; }
    }
    const fingerprint = parkFingerprint(view, subtaskId, laneRoot ? { form: 'lane' } : { form: 'no-worktree', branch: hold.branch, branchTip });
    return { version: PARK_FINGERPRINT_VERSION, fingerprint };
  };
}

/**
 * The basis of a held lane's release (I1): fingerprint, tree digest, content
 * digest, and the child those were read from (its workflow id, or the one the
 * hold names when none was found), which the comparison finds again by that
 * id, archived or not. With `mainRoot`, it records the branch's tip too
 * (`branch_tip`, null when the branch is gone): a consumed release vouches
 * for that tip when its subtask is still pending (lanes.mjs row 12, ADR-0062
 * Decision 2, amendment of 2026-10-27). The fingerprint and the tree digest
 * already cover it, so the comparison does not read it.
 */
export function basisFor({ engineerRoot, fingerprintOf, mainRoot = null }) {
  return async ({ laneRoot, childPath, hold }) => {
    const fp = await fingerprintOf({ laneRoot, childPath, hold });
    const found = childPath ? readWorkflowFacts(childPath) : null;
    if (found && found.state !== 'ok') throw new HoldRefusal(`the lane's child ${childPath} cannot be read (${found.error ?? found.state}), so its content cannot be compared`, 'unreadable');
    let branchTip = null;
    if (mainRoot && typeof hold?.branch === 'string') {
      try {
        branchTip = execFileSync('git', ['-C', mainRoot, 'rev-parse', '--verify', '-q', `refs/heads/${hold.branch}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
      } catch { branchTip = null; }
    }
    return {
      fingerprint_version: fp.version, fingerprint: fp.fingerprint,
      tree_digest: laneRoot ? `${TREE_DIGEST_VERSION}:${treeDigest(laneRoot).digest}` : 'no worktree',
      content_digest: childPath ? contentDigest(engineerRoot, childPath) : 'no child',
      child: found?.fields.workflow_id ?? hold.child ?? null,
      ...(mainRoot ? { branch_tip: branchTip } : {}),
    };
  };
}

// The id of the last session that worked a subtask's lane, from the run
// ledgers of the checkouts given: `claude --resume <id>` (Decision 2, item 5).
// Only runs of this macro count (another macro may have a subtask of the same
// id), and the latest step started across every ledger wins.
function lastSessionOf(dirs, macroId, subtaskId) {
  let best = null;
  for (const dir of [...new Set(dirs)]) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.startsWith('autopilot-')).sort(); } catch { continue; }
    for (const n of names) {
      let run = null;
      try { run = JSON.parse(readRegular(path.join(dir, n, 'run.json')).text ?? 'null'); } catch { run = null; }
      if (run?.macro_id !== macroId) continue;
      const r = readRegular(path.join(dir, n, 'steps.jsonl'));
      if (!r.text) continue;
      for (const line of r.text.split('\n')) {
        try {
          const s = JSON.parse(line);
          if (s?.event !== 'started' || s.subtask_id !== subtaskId || typeof s.session_id !== 'string') continue;
          const at = Date.parse(s.started_at ?? '') || 0;
          if (!best || at >= best.at) best = { run: n, session: s.session_id, cwd: s.cwd ?? null, at };
        } catch { /* torn */ }
      }
    }
  }
  return best;
}

function describeHold(mainRoot, macroId, subtaskId) {
  const st = holdStateOf(mainRoot, macroId, subtaskId);
  const r = st.hold?.record;
  if (st.state === 'unreadable') return { state: 'unreadable', line: `${subtaskId}: unreadable (${st.hold?.error ?? st.release?.error ?? st.why}) — agentic-autopilot release ${subtaskId} --macro ${macroId} --discard-unreadable` };
  if (st.state === 'none') return { state: 'none', line: null };
  const release = `agentic-autopilot release ${subtaskId} --macro ${macroId} --hold ${r.hold_id}`;
  const lines = {
    pending: `${subtaskId}: pending (hold ${r.hold_id}) — the lane is not handed over yet; release: ${release}`,
    held: `${subtaskId}: held (hold ${r.hold_id}) — work in ${r.lane ?? '(no lane: unfenced)'}; release: ${release}`,
    'released-uncompared': `${subtaskId}: released (hold ${r.hold_id}), waiting for the driver's comparison`,
    consumed: `${subtaskId}: released and consumed (hold ${r.hold_id})`,
    rejected: `${subtaskId}: release rejected (hold ${r.hold_id}): the lane changed after its release; stop editing, close the session, then hold and release it again`,
    withdrawn: `${subtaskId}: released before its handoff (hold ${r.hold_id})`,
    retired: `${subtaskId}: retired (hold ${r.hold_id})`,
    orphaned: `${subtaskId}: orphaned (hold ${r.hold_id}: ${r.orphaned?.why ?? '?'})`,
  };
  return { state: st.state, line: lines[st.state], hold: r };
}

/**
 * `hold <subtask> --macro <id>`. `deps`: { engineerRoot (the launcher's pin),
 * env, home, runDirs (the run ledgers to find the lane's last session in) }.
 */
/**
 * Whether the plan lets `hold` hold a subtask: `{ subtask }`, or `{ problem }`
 * when the macro has ended, the subtask is not in its plan or is closed, or
 * names no branch (or, with `branch`, another one than the hold was set on).
 */
function holdEligibility(mainRoot, macroId, subtaskId, branch = null) {
  const macro = readMacro(mainRoot, macroId);
  if (macro.problem) return { problem: macro.problem };
  // Decision 2, item 8 — an ended macro retires its holds directory: a hold
  // set on one would be retired with it, or outlive it.
  if (macro.archived || macro.fm?.terminal_marker === true) {
    return { problem: `macro ${macroId} has ended (${macro.archived ? 'archived' : `current_phase ${macro.fm?.current_phase ?? '?'}`}): there is nothing to hold` };
  }
  const subtasks = Array.isArray(macro.fm?.plan?.subtasks) ? macro.fm.plan.subtasks : [];
  const s = subtasks.find((x) => x?.id === subtaskId);
  if (!s) return { problem: `subtask ${subtaskId} is not in macro ${macroId}'s plan` };
  if (['completed', 'deferred', 'abandoned'].includes(s.status)) return { problem: `subtask ${subtaskId} is ${s.status}: there is nothing to hold` };
  if (typeof s.branch !== 'string' || s.branch === '') return { problem: `subtask ${subtaskId} names no branch` };
  if (branch !== null && s.branch !== branch) return { problem: `the plan's branch for subtask ${subtaskId} is ${s.branch} now, not ${branch}: hold it again` };
  return { subtask: s, baseline: macro.fm?.git_baseline?.branch ?? null };
}

/** Whether the main checkout has `refs/heads/<branch>`. */
function branchExists(mainRoot, branch) {
  try {
    execFileSync('git', ['-C', mainRoot, 'rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

export async function holdCmd(o, repoRoot, { out, err, env = process.env, home, engineerRoot, runDirs = [], hooks = {} }) {
  const mainRoot = mainWorktreeRoot(repoRoot);
  const first = holdEligibility(mainRoot, o.macro, o.subtask);
  if (first.problem) { err(`✗ ${first.problem}`); return 1; }
  const s = first.subtask;
  const live = await liveRuns(mainRoot, o.macro);
  for (const r of live.runs) {
    if (!r.capabilities.includes(HOLDS_CAPABILITY)) {
      err(r.run_id === null
        ? `✗ ${live.why}: a hold is not set beside a run whose capabilities cannot be read`
        : `✗ run ${r.run_id} is live and does not honour holds (${HOLDS_CAPABILITY}): a serial run drives the checkout a person would work in. Stop it first: agentic-autopilot stop --macro ${o.macro}`);
      return 1;
    }
  }
  const a = activateHolds({ mainRoot, macroId: o.macro, pinnedEngineerRoot: engineerRoot, env, ...(home ? { home } : {}), writtenBy: 'agentic-autopilot hold' });
  if (!a.ok) {
    err('✗ holds cannot turn on for this macro yet:');
    for (const p of a.problems) err(`  - ${p}`);
    return 1;
  }
  // The lane the branch is checked out in now, as an orphaning compares it;
  // null with none (I1: a worktree path or null), never the path a run would
  // create, which a worktree of the person's own would orphan. A worktree
  // that holds the branch by the handoff is taken then (completeHandoff).
  const at = branchLane(mainRoot, s.branch);
  const lane = at ?? null;
  // Tests: what ends the macro, or retires its holds, between the looks
  // above and the hold's lock.
  if (hooks.beforeSet) await hooks.beforeSet();
  let record;
  try {
    record = await setHold({
      mainRoot, macroId: o.macro, subtaskId: o.subtask, branch: s.branch, lane, child: s.engineer_workflow_id ?? null,
      // Asked again under the holds lock, before any write: an abort,
      // finalize or done that ended the macro, or retired its holds, since
      // the looks above refuses the hold (I7's limit).
      stillEligible: () => {
        const now = holdEligibility(mainRoot, o.macro, o.subtask, s.branch);
        if (now.problem) return now.problem;
        const act = readActivation(mainRoot, o.macro);
        return act.state === 'active' ? null
          : `the holds of macro ${o.macro} are ${act.state} now (${act.error ?? 'retired since this hold turned them on'}): there is nothing to hold`;
      },
    });
  } catch (e) {
    if (!(e instanceof HoldRefusal)) throw e;
    err(`✗ ${e.message}`);
    return 1;
  }
  // Look again, now the hold is published: a serial run (or one without the
  // capability) that took its locks after the first look either saw the hold
  // in its own second look, or this look sees it, and the hold is withdrawn.
  if (hooks.afterPublish) await hooks.afterPublish();
  const again = await liveRuns(mainRoot, o.macro);
  const blind = again.runs.find((r) => !r.capabilities.includes(HOLDS_CAPABILITY));
  if (blind) {
    try {
      await withdrawUnhandedHold({ mainRoot, macroId: o.macro, subtaskId: o.subtask, holdId: record.hold_id });
    } catch (e) {
      if (!(e instanceof HoldRefusal)) throw e;
      err(`✗ a run that does not honour holds started meanwhile (${blind.run_id ?? again.why}), and the hold ${record.hold_id} could not be withdrawn: ${e.message}. Stop the run (agentic-autopilot stop --macro ${o.macro}), then release the hold: agentic-autopilot release ${o.subtask} --macro ${o.macro} --hold ${record.hold_id}`);
      return 1;
    }
    err(`✗ a run that does not honour holds started meanwhile (${blind.run_id ?? again.why}): the hold is withdrawn. Stop it first: agentic-autopilot stop --macro ${o.macro}`);
    return 1;
  }
  let handoff = { state: 'pending', blocker: again.live ? `run ${again.runs[0]?.run_id ?? 'unknown'} completes the handoff once nothing of the lane is in flight` : null };
  if (!again.live) handoff = await completeHandoff({ mainRoot, macroId: o.macro, subtaskId: o.subtask, stateRoots: [mainRoot] });
  out(`✓ hold ${record.hold_id} set on subtask ${o.subtask} of macro ${o.macro} (${handoff.state})`);
  if (handoff.state === 'pending' && handoff.blocker) out(`  waiting for: ${handoff.blocker}`);
  out(handoff.state === 'held' ? '  the lane is yours: start once it shows held (it does)' : '  start once `agentic-autopilot status --macro <id>` shows it held');
  // The lane as the owner record names it now: the handoff takes a worktree
  // made for the branch since the hold was set.
  const now = readOwnerHold(mainRoot, o.macro, o.subtask);
  const laneNow = now.state === 'ok' && now.record.hold_id === record.hold_id ? now.record.lane : record.lane;
  if (laneNow && fs.existsSync(laneNow)) {
    out(`  lane: ${laneNow}`);
    const foreign = foreignLaneRefusal({ mainRoot, macroId: o.macro, subtaskId: o.subtask })(laneNow);
    if (foreign) out(`  ⚠ this worktree is not a run's lane: before the release, commit your work there and remove it (git worktree remove ${laneNow}); a release refuses while it has the branch`);
    const last = lastSessionOf(runDirs, o.macro, o.subtask);
    if (last) out(`  its last session: claude --resume ${last.session}${last.cwd ? ` (worked in ${last.cwd})` : ''}`);
    try {
      const unignored = unignoredStatePaths(laneNow);
      if (unignored.length) out(`  ⚠ the lane does not ignore ${unignored.join(', ')}: a session left open after the release writes there, and the release is then rejected`);
    } catch { /* no git: nothing to say */ }
  } else {
    out('  ⚠ the subtask has no lane yet: this hold means "do not dispatch it", and no worktree lock fences it from an older driver; rolling the orchestrator back below this release while a hold exists is unsupported');
    // A branch dispatch has not created yet is created from the baseline's
    // tip, as a run would cut it (lanes.mjs row 12's ancestor rule), and with
    // no upstream, as the run's own creation (--no-track): tracking the
    // baseline would point the person's push at it.
    const add = branchExists(mainRoot, s.branch)
      ? `git worktree add <path> ${s.branch}`
      : `git worktree add --no-track -b ${s.branch} <path> origin/${first.baseline ?? '<baseline>'}`;
    out(`  to work in a worktree of your own (${add}): before the release, commit your work there and remove it (git worktree remove <path>); a release refuses while it has the branch`);
  }
  if (s.status === 'pending') {
    const base = `origin/${first.baseline ?? '<baseline>'}`;
    out(`  ⚠ subtask ${o.subtask} is not dispatched yet: a run dispatches it on ${s.branch} at ${base}'s tip, or at the tip this hold's release records once the run has compared it equal, when that tip contains ${base} (ADR-0062 Decision 2, amendment of 2026-10-27): commit your work on ${s.branch}, rebased onto ${base}, before the release`);
  }
  out(`  your session needs the hold-aware engineer (${HOLD_PERSONA_CAPABILITY}): an older one writes terminal and leaves no operation visible`);
  out(`  give it back with: agentic-autopilot release ${o.subtask} --macro ${o.macro} --hold ${record.hold_id}`);
  return 0;
}

/**
 * Why a held lane's release refuses its worktree: null when it is a run's lane
 * for the subtask, by the rule reconciliation uses (lanes.mjs
 * `gatherLaneFacts`: a worktree locked with the lock reason naming this macro
 * and subtask, wherever it is), or when no run could have one (the lane home
 * has a problem); else the order that works. A worktree of the person's own
 * is no lane of a run's, even at the path a run would use: kept, the run parks
 * the subtask (row 11); removed after the release, the comparison finds the
 * lane the basis named gone, and rejects it. Removed before, the release's
 * basis is the branch's tip. Worktrees that cannot be listed refuse: whose
 * lane it is cannot be told.
 */
export function foreignLaneRefusal({ mainRoot, macroId, subtaskId, env = process.env }) {
  return (laneRoot) => {
    const home = laneHome(mainRoot);
    if (home.problem) return null;
    const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
    let worktrees;
    try {
      worktrees = listWorktrees(home.mainRoot, { env });
    } catch (e) {
      return `the worktrees of ${home.mainRoot} cannot be listed (${e.message}), so whether ${laneRoot} is a run's lane for subtask ${subtaskId} cannot be told: try again`;
    }
    const w = worktrees.find((x) => real(x.path) === real(laneRoot));
    const reason = w?.locked && w.lockReason !== null ? parseLockReason(w.lockReason) : null;
    if (reason && reason.macroId === macroId && reason.subtaskId === subtaskId) return null;
    return `subtask ${subtaskId}'s branch is checked out in ${laneRoot}, a worktree that is not a run's lane for it (no run's lock names it): a run steps the subtask only in its own lane, and parks it while another worktree has its branch. ` +
      `Commit your work there, remove that worktree (git worktree remove ${laneRoot}), then release again: the release then records the branch as you left it`;
  };
}

/** `release <subtask> --macro <id> --hold <id>`. `deps.fingerprintOf` reads the lane's fingerprint. */
export async function releaseHoldCmd(o, repoRoot, { out, err, env = process.env, engineerRoot, fingerprintOf = null, wake = () => {} }) {
  const mainRoot = mainWorktreeRoot(repoRoot);
  fingerprintOf ??= releaseFingerprint({ mainRoot, macroId: o.macro, subtaskId: o.subtask, env });
  let r;
  try {
    r = await releaseHold({
      mainRoot, macroId: o.macro, subtaskId: o.subtask, holdId: o.hold, stateRoots: [mainRoot],
      basisOf: basisFor({ engineerRoot, fingerprintOf, mainRoot }),
      keptParkId: (id) => { const p = readPark(mainRoot, o.macro, id); return p.state === 'ok' ? p.record.record_id : null; },
      laneRefusal: foreignLaneRefusal({ mainRoot, macroId: o.macro, subtaskId: o.subtask }),
    });
  } catch (e) {
    if (!(e instanceof HoldRefusal)) throw e;
    err(`✗ ${e.message}`);
    return 1;
  }
  if (r.state === 'withdrawn' && r.restored) {
    out(`✓ hold ${o.hold} of subtask ${o.subtask} withdrawn before its handoff: the release it was set over stands again (${r.restored === 'rejected'
      ? 'rejected: hold and release the lane again once it is as it should be' : 'the driver compares it before the lane steps'})`);
  } else if (r.state === 'withdrawn') out(`✓ hold ${o.hold} of subtask ${o.subtask} withdrawn before its handoff: nothing to compare`);
  else out(`✓ released hold ${o.hold} of subtask ${o.subtask}${r.again ? ' (it was released already)' : ''}: the driver compares the lane once before it steps`);
  out('  stop editing and close the session first: an edit after the release makes the driver reject it');
  wake();
  return 0;
}

/**
 * `release <subtask> --macro <id> --discard-unreadable` (Decision 2, item 8):
 * keep a copy of each record that cannot be read, then replace it so the lane
 * is never given back unguarded: an owner's record becomes a new hold; a
 * handoff or release record goes, so the lane is held or compared again; a
 * rejection is never lost.
 */
export async function discardCmd(o, repoRoot, { out, err, hooks = {} }) {
  const mainRoot = mainWorktreeRoot(repoRoot);
  // A discarded owner's record becomes a new hold on the subtask's branch and
  // lane as the plan names them, so it applies where the old one did: read
  // under the holds lock (`readPlan`), so a plan revised while the discard
  // waited for it is the one the replacement follows. An ended macro is read
  // as any other: its records are discarded too.
  let macro = null;
  let replacement = null;
  const readPlan = () => {
    macro = readMacro(mainRoot, o.macro);
    const s = macro.fm?.plan?.subtasks?.find?.((x) => x?.id === o.subtask) ?? null;
    // Its lane as `hold` records one: the worktree holding the branch, or null.
    const named = s && typeof s.branch === 'string' && s.branch !== '';
    replacement = named
      ? { branch: s.branch, lane: branchLane(mainRoot, s.branch) ?? null, child: s.engineer_workflow_id ?? null }
      : null;
  };
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  // The bytes as read now, never by a blocking open (a FIFO is described).
  const snapshot = (file) => {
    const r = readRegular(file);
    const bytes = r.text ?? `(not a readable file: ${r.error ?? 'absent'})\n`;
    return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
  };
  const keep = (kind, snap) => {
    const copy = path.join(discardedDir(mainRoot, o.macro), `${kind}-${o.subtask}-${stamp}.json`);
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, snap.bytes, { flag: 'wx' });
    return copy;
  };
  // The worktrees a fence of the subtask may be in: every one of the
  // repository (the old record's lane cannot be read, and a plan revision may
  // have moved the subtask since), and the replacement's lane. Should git not
  // list them, the owner's record is not replaced: its fences could not all
  // be found, and once replaced nothing would name them.
  const fenceLanes = () => {
    const roots = repositoryRoots(mainRoot);
    return [...new Set([...roots, ...(replacement?.lane ? [replacement.lane] : [])])].filter((l) => fs.existsSync(l));
  };
  // A hold whose handoff, or a release of it, was discarded may have been
  // handed over: its release is compared, never withdrawn with nothing to
  // compare (hold-ops.mjs comparesOnRelease).
  const markCompared = () => {
    const h = readOwnerHold(mainRoot, o.macro, o.subtask);
    if (h.state === 'ok' && h.record.compare_on_release !== true) writeWhole(h.path, { ...h.record, compare_on_release: true });
  };
  const done = [];
  // The holds' own records, judged, kept and replaced under the holds lock,
  // each only while it is the record judged (a newer one is never touched).
  let refusal = null;
  await withHoldsLock(mainRoot, o.macro, () => {
    readPlan();
    for (const kind of ['holds', 'handoffs', 'releases']) {
      const r = readRecord(mainRoot, o.macro, kind, o.subtask);
      if (r.state !== 'unreadable') continue;
      const file = recordPath(mainRoot, o.macro, kind, o.subtask);
      if (kind === 'holds' && !replacement) {
        refusal = `the hold record of ${o.subtask} is not discarded: the plan of ${o.macro} names no branch for it${macro.problem ? ` (${macro.problem})` : ''}, so its replacement could not hold the lane`;
        return;
      }
      let lanes = [];
      if (kind === 'holds') {
        try {
          lanes = fenceLanes();
        } catch (e) {
          refusal = `the hold record of ${o.subtask} is not discarded: the worktrees its fences may be in cannot be listed (${e.message}); run it again once git lists them`;
          return;
        }
      }
      const copy = keep(kind, snapshot(file));
      if (kind === 'holds') {
        // A new hold, pending, which a release ends as any other: written over
        // the unreadable record in one rename, so no moment leaves the lane
        // unguarded (I3). The old record's fences go, in every worktree: its
        // id and lane cannot be read. Whether the old hold was handed over
        // cannot be told either, so its release is compared.
        const rec = {
          schema: 'agentic-hold-1', hold_id: newRecordId(), subtask_id: o.subtask, ...replacement,
          state: 'held', set_by: 'discard', set_at: new Date().toISOString(), compare_on_release: true,
        };
        for (const l of lanes) removeSubtaskFences(l, { macroId: o.macro, subtaskId: o.subtask });
        writeWhole(file, rec);
        done.push(`✓ discarded the hold record of ${o.subtask} (copy: ${copy}); it is replaced by hold ${rec.hold_id}, which holds the lane until released`);
      } else if (kind === 'releases') {
        // Whether it was rejected cannot be told, so it counts as rejected
        // (never lost) until a new hold and release. A held owner record keeps
        // the lane held: its release is compared, marked so before the record
        // it depends on changes, so a crash between never drops the rejection.
        markCompared();
        if (hooks.beforeDependentWrite) hooks.beforeDependentWrite(kind);
        writeWhole(file, { schema: 'agentic-hold-release-1', release_id: '0'.repeat(16), hold_id: readOwnerHold(mainRoot, o.macro, o.subtask).record?.hold_id ?? '0'.repeat(16), subtask_id: o.subtask, state: 'rejected', basis: { fingerprint: '', tree_digest: '', content_digest: '' }, park_record_id: null, park_ended: false, released_at: null, compared_at: new Date().toISOString(), discarded_copy: copy });
        done.push(`✓ discarded the release record of ${o.subtask} (copy: ${copy}); it counts as rejected: hold and release the lane again`);
      } else {
        markCompared();
        if (hooks.beforeDependentWrite) hooks.beforeDependentWrite(kind);
        unlinkQuiet(file);
        done.push(`✓ discarded the handoff record of ${o.subtask} (copy: ${copy}); the lane is handed over again`);
      }
      appendHoldEvent(mainRoot, o.macro, { event: 'discarded', subtask_id: o.subtask, kind, copy });
    }
  });
  if (refusal) { err(`✗ ${refusal}`); return 1; }
  // A kept park, deleted under its own lock only while its bytes are the ones
  // copied (parks.mjs's conditional delete).
  const park = readPark(mainRoot, o.macro, o.subtask);
  if (park.state === 'unreadable') {
    const file = recordPath(mainRoot, o.macro, 'parks', o.subtask);
    const copy = keep('parks', snapshot(file));
    const d = await deletePark(mainRoot, o.macro, o.subtask, { expectDigest: park.digest, event: 'discarded', fields: { by: 'owner', copy } });
    if (!d.ok) { err(`✗ subtask ${o.subtask}'s park changed while it was discarded (copy: ${copy}); nothing was deleted`); return 1; }
    done.push(`✓ discarded the park record of ${o.subtask} (copy: ${copy}); the next run compares the lane again, and parks it if it changed`);
    appendHoldEvent(mainRoot, o.macro, { event: 'discarded', subtask_id: o.subtask, kind: 'parks', copy });
  }
  if (done.length === 0) { err(`✗ subtask ${o.subtask} of macro ${o.macro} has no record that cannot be read`); return 1; }
  for (const l of done) out(l);
  return 0;
}

/** `writer-clear <subtask> --macro <id> --operation <id>` (Decision 2, item 7). */
export function writerClearCmd(o, repoRoot, { out, err }) {
  const mainRoot = mainWorktreeRoot(repoRoot);
  if (!OPERATION_ID_RE.test(o.operation ?? '')) { err(`✗ --operation ${JSON.stringify(o.operation)} is not an operation id`); return 1; }
  const known = readOps(mainRoot, o.macro, o.subtask).ops.some((x) => x.id === o.operation);
  const r = clearOperation(mainRoot, o.macro, o.subtask, o.operation, { by: 'owner' });
  out(r.cleared
    ? `✓ operation ${o.operation} of subtask ${o.subtask} cleared${known ? '' : ' (no record of it here: an entry on the child alone)'}: it is no longer excluded, and its own last write refuses`
    : `operation ${o.operation} was cleared already`);
  appendHoldEvent(mainRoot, o.macro, { event: 'writer-cleared', subtask_id: o.subtask, operation_id: o.operation });
  return 0;
}

/**
 * The macro's holds, macro-scoped (P8): one line per subtask with a record,
 * with the open operations of each, and any repair of a fence. Works from any
 * checkout and with no run history. With no live run, a pending handoff is
 * attempted here (Decision 2, item 4).
 */
export async function holdsStatusLines(mainRoot, macroId) {
  const lines = [];
  // Decision 2, item 8 — what ended retires here too (I3): an archived
  // macro's holds directory, a hold the plan no longer matches (orphaned),
  // and a completed subtask's records, each unless a lane is still written.
  const macro = readMacro(mainRoot, macroId);
  // The plan as the file holds it now, read again under the holds lock by
  // each retirement: a plan revised since this look may reuse an id.
  const planNow = () => {
    const m = readMacro(mainRoot, macroId);
    return m.fm && Array.isArray(m.fm.plan?.subtasks) ? m.fm.plan.subtasks : null;
  };
  let roots = [mainRoot];
  try { roots = [...new Set([mainRoot, ...repositoryRoots(mainRoot)])]; } catch { /* the main checkout alone */ }
  try {
    const subtasks = Array.isArray(macro.fm?.plan?.subtasks) ? macro.fm.plan.subtasks : [];
    if (macro.archived || macro.fm?.terminal_marker === true) {
      const r = await retireMacroHolds({ mainRoot, macroId, subtasks, stateRoots: roots });
      if (r.state === 'retired') return [`holds of ${macroId}: retired (the macro ${macro.archived ? 'is archived' : 'has ended'})`];
      if (r.state !== 'none') lines.push(`the macro has ended; its holds are not retired yet: ${r.why}`);
    } else if (macro.fm) {
      const laneNow = (s) => branchLane(mainRoot, s.branch);
      for (const o of await orphanStale({ mainRoot, macroId, planNow, stateRoots: roots, laneOf: laneNow })) lines.push(`${o.subtaskId}: hold ${o.holdId} orphaned now: ${o.why}`);
      for (const s of subtasks.filter((x) => x?.status === 'completed')) {
        const stillCompleted = () => planNow()?.find((x) => x?.id === s.id)?.status === 'completed';
        const r = await retireSubtaskHolds({ mainRoot, macroId, subtaskId: s.id, branch: s.branch ?? null, stateRoots: roots, stillCompleted });
        if (r.state === 'retired') lines.push(`${s.id}: completed: its hold records retired now`);
        else if (r.state === 'waiting' || r.state === 'unreadable') lines.push(`${s.id}: completed; its hold records retire once nothing writes the lane: ${r.why}`);
      }
    }
  } catch (e) {
    lines.push(`the macro's ended holds could not be retired (${e?.message ?? e})`);
  }
  const ids = listRecordIds(mainRoot, macroId, 'holds');
  if (ids.state === 'unreadable') return [`holds: cannot be read (${ids.error}): every lane of the macro counts held`];
  const live = await liveRuns(mainRoot, macroId);
  for (const id of ids.ids) {
    let handoff = null;
    if (!live.live) {
      try {
        handoff = await completeHandoff({ mainRoot, macroId, subtaskId: id, stateRoots: [mainRoot] });
      } catch (e) {
        handoff = { state: 'pending', blocker: `the handoff could not run (${e?.message ?? e})` };
      }
    }
    const fence = await repairHoldFence({ mainRoot, macroId, subtaskId: id });
    const d = describeHold(mainRoot, macroId, id);
    if (!d.line) continue;
    lines.push(d.line);
    if (d.state === 'pending') lines.push(`  waiting for: ${handoff?.blocker ?? (live.live ? `run ${live.runs[0].run_id ?? '?'} completes the handoff once nothing of the lane is in flight` : 'nothing; run status again')}`);
    if (fence.repaired !== 'none') lines.push(`  fence ${fence.repaired} (repaired)`);
    if (fence.blocker) lines.push(`  fence not repaired: ${fence.blocker}`);
    const hold = d.hold;
    if (hold) {
      const lane = laneOf({ hold, stateRoots: [mainRoot], macroId });
      const ops = openOperations({ mainRoot, macroId, subtaskId: id, childPath: lane.childPath });
      if (ops.open.length) lines.push(`  open operations: ${describeOperations(ops.open)} (clear one whose session is gone: agentic-autopilot writer-clear ${id} --macro ${macroId} --operation <id>)`);
    }
  }
  return lines.length ? [`holds of ${macroId}:`, ...lines.map((l) => `  ${l}`)] : [];
}

export { isSafeSubtaskId, readJson, readKeptPark };
