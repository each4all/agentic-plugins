// plugins/orchestrator/adapters/claude/autopilot/instruct-cli.mjs
//
// ADR-0068 Decision 7, item 2 — the owner's instruction to a lane, reached
// through `agentic-autopilot` and `/orchestrator:autopilot instruct`:
//
//   instruct <subtask> --macro <id> --note-file <path> [--next <step>]
//            [--revises <instruction id>:<revision>]
//                                     write one (or revise a pending one in its place)
//   instruct <subtask> --macro <id> --withdraw <instruction id>
//                                     withdraw a pending one
//
// With or without a live run. The note crosses as a file (ADR-0059), never a
// word of the command line, and is never printed: the command prints the
// instruction's id and state. A caller whose AGENTIC_AUTOPILOT names a run is
// refused (cli.mjs): a worker never instructs a lane, its own included.

import fs from 'node:fs';
import path from 'node:path';

import { archivedChildren } from '../../../scripts/lib/hold-ops.mjs';
import { branchWorkflows, laneBusy, liveRuns, readWorkflowFacts } from '../../../scripts/lib/holds.mjs';
import {
  describeEntries, gateWitnessOf, INSTRUCTIONS_CAPABILITY, InstructionRefusal, laneApplicationIds, listInstructionIds, NOTE_REFUSALS,
  parseInstructionStep, READ_CODES, readEndedInstructions, readInstructions, readNoteFile, STEP_REFUSALS, withdrawInstruction, writeInstruction,
} from '../../../scripts/lib/instructions.mjs';
import { repositoryRoots } from '../../../scripts/lib/state-root.mjs';
import { applyLaneInstructions } from '../../../scripts/state.mjs';

import { readMacro } from './holds-cli.mjs';
import { mainWorktreeRoot } from './ledger.mjs';

/**
 * The state roots a lane's child may live in: the main checkout's first, then
 * every worktree's. It throws when git cannot list the worktrees: the main
 * checkout alone would miss a child in a worktree's state root, and a lane
 * whose child cannot be found reads as one with none.
 */
export function childStateRoots(mainRoot) {
  return [...new Set([mainRoot, ...repositoryRoots(mainRoot)])];
}

/**
 * Whether an instruction may be written for `subtaskId` now (item 2): `{
 * subtask, child, childPath, witness }`, `child` null for a subtask with no
 * child yet, or `{ problem, code }`. It refuses an ended macro, a subtask not
 * in the plan or recorded completed, deferred or abandoned, one that names no
 * branch (or another one than `branch`, when given), a child that has
 * archived, and a lane whose child cannot be told (two linked, or a home that
 * cannot be read).
 */
export function instructEligibility(mainRoot, macroId, subtaskId, { branch = null, stateRoots: given = null } = {}) {
  let stateRoots = given;
  if (stateRoots === null) {
    try {
      stateRoots = childStateRoots(mainRoot);
    } catch (err) {
      return { problem: `the repository's worktrees cannot be listed (${err.message}): whether subtask ${subtaskId} has a child in one cannot be told`, code: 'unreadable' };
    }
  }
  const macro = readMacro(mainRoot, macroId);
  if (macro.problem) return { problem: macro.problem, code: 'macro' };
  if (macro.archived || macro.fm?.terminal_marker === true) {
    return { problem: `macro ${macroId} has ended (${macro.archived ? 'archived' : `current_phase ${macro.fm?.current_phase ?? '?'}`}): there is no lane to instruct`, code: 'ended' };
  }
  const s = (Array.isArray(macro.fm?.plan?.subtasks) ? macro.fm.plan.subtasks : []).find((x) => x?.id === subtaskId);
  if (!s) return { problem: `subtask ${subtaskId} is not in macro ${macroId}'s plan`, code: 'not-in-plan' };
  if (['completed', 'deferred', 'abandoned'].includes(s.status)) return { problem: `subtask ${subtaskId} is ${s.status}: there is no lane to instruct`, code: 'closed' };
  if (typeof s.branch !== 'string' || s.branch === '') return { problem: `subtask ${subtaskId} names no branch`, code: 'no-branch' };
  if (branch !== null && s.branch !== branch) return { problem: `the plan's branch for subtask ${subtaskId} is ${s.branch} now, not ${branch}: write the instruction again`, code: 'branch' };
  const wf = branchWorkflows({ stateRoots, branch: s.branch, macroId, subtaskId });
  if (wf.unreadable.length) {
    return { problem: `the workflow homes subtask ${subtaskId}'s child may be in cannot all be read (${wf.unreadable.map((u) => u.file).join(', ')}): whose lane it is cannot be told`, code: 'unreadable' };
  }
  if (wf.linked.length > 1) {
    return { problem: `subtask ${subtaskId} has ${wf.linked.length} active children (${wf.linked.join(', ')}): which one an instruction tells cannot be told`, code: 'ambiguous' };
  }
  if (wf.linked.length === 1) {
    const childPath = wf.linked[0];
    const facts = readWorkflowFacts(childPath);
    // The witness reads the child as the application will: the lane's own
    // application notes (its record's receipts) are the owner's, nothing else.
    const rec = readInstructions(mainRoot, macroId, subtaskId);
    if (rec.state === 'unreadable') return { problem: `subtask ${subtaskId}'s instructions record cannot be read (${READ_CODES[rec.code]}): which notes in its child are the owner's cannot be told`, code: 'unreadable' };
    const id = facts.state === 'ok' ? facts.fields.workflow_id : null;
    const witness = facts.state === 'ok' ? gateWitnessOf(facts.text, laneApplicationIds(rec.state === 'ok' ? rec.record : null, id)) : null;
    if (typeof id !== 'string' || id === '' || !witness) return { problem: `subtask ${subtaskId}'s child ${childPath} cannot be read`, code: 'unreadable' };
    return { subtask: s, child: id, childPath, witness };
  }
  // No active child: one that archived means the lane's next work is
  // landing (a commit, a close).
  const archived = archivedChildren(stateRoots, { macroId, subtaskId, branch: s.branch });
  if (archived.unreadable.length) {
    return { problem: `the archives subtask ${subtaskId}'s child may be in cannot all be read: whether it has archived cannot be told`, code: 'unreadable' };
  }
  if (archived.latest) {
    return { problem: `subtask ${subtaskId}'s child ${path.basename(archived.latest, '.md')} has archived (committed or closed): the lane's next work is landing, and no instruction reaches it`, code: 'archived' };
  }
  // The plan names an owner no home holds: which child the lane has cannot
  // be told.
  const owner = typeof s.engineer_workflow_id === 'string' && s.engineer_workflow_id !== '' ? s.engineer_workflow_id : null;
  if (owner) return { problem: `subtask ${subtaskId}'s recorded child ${owner} is in no workflow home on ${s.branch}: whose lane it is cannot be told`, code: 'missing' };
  return { subtask: s, child: null, childPath: null, witness: null };
}

/** Parse `<16 hex>:<revision>`: `{ id, revision }` or null. */
export function parseRevises(text) {
  const m = /^([0-9a-f]{16}):([1-9][0-9]{0,5})$/.exec(String(text ?? ''));
  return m ? { id: m[1], revision: Number(m[2]) } : null;
}

/**
 * `instruct <subtask> --macro <id> …`. `o`: { subtask, macro, noteFile,
 * instructNext, revises, withdraw }. `deps.applyNow` (impl-instruct's
 * boundary application, absent until it is wired) applies the lane's pending
 * instructions when no run is live and the lane is at a boundary.
 */
export async function instructCmd(o, repoRoot, { out, err, applyNow = null }) {
  const mainRoot = mainWorktreeRoot(repoRoot);
  if (o.withdraw) {
    try {
      const e = await withdrawInstruction({ mainRoot, macroId: o.macro, subtaskId: o.subtask, id: o.withdraw, by: 'owner' });
      out(`✓ instruction ${e.id} r${e.revision} of subtask ${o.subtask}: withdrawn`);
      return 0;
    } catch (e) {
      if (!(e instanceof InstructionRefusal)) throw e;
      err(`✗ ${e.message}`);
      return 1;
    }
  }
  let step = null;
  if (o.instructNext !== null && o.instructNext !== undefined) {
    const p = parseInstructionStep(o.instructNext);
    if (!p.ok) { err(`✗ --next ${JSON.stringify(o.instructNext)} ${STEP_REFUSALS[p.code]}; nothing was written`); return 1; }
    step = p.step;
  }
  const note = readNoteFile(o.noteFile);
  if (!note.ok) { err(`✗ --note-file ${JSON.stringify(o.noteFile)} ${NOTE_REFUSALS[note.code]}; nothing was written`); return 1; }
  const first = instructEligibility(mainRoot, o.macro, o.subtask);
  if (first.problem) { err(`✗ ${first.problem}; nothing was written`); return 1; }
  const stepRefusal = (el) => {
    if (step === null) return null;
    if (el.child === null) {
      return `subtask ${o.subtask} has no child yet: an instruction before its dispatch takes a note only, which reaches the child after the dispatch step (ADR-0068 Decision 7, item 2)`;
    }
    if (el.witness?.gate) {
      return `subtask ${o.subtask}'s child ${el.child} has the owner gate ${el.witness.gate} set: an instruction never clears a gate, which only its resolution does (ADR-0068 Decision 7, item 5); resolve it in a session first`;
    }
    return null;
  };
  const refused = stepRefusal(first);
  if (refused) { err(`✗ ${refused}; nothing was written`); return 1; }
  let revises = null;
  if (o.revises !== null && o.revises !== undefined) {
    revises = parseRevises(o.revises);
    if (!revises) { err(`✗ --revises ${JSON.stringify(o.revises)} is not <instruction id>:<revision>`); return 1; }
  }
  let entry;
  try {
    entry = await writeInstruction({
      mainRoot, macroId: o.macro, subtaskId: o.subtask, branch: first.subtask.branch, child: first.child, step, note,
      witness: first.witness, writtenBy: 'owner', revises,
      // Asked again under the holds lock: a plan revised, a child archived
      // or a gate set since the look above refuses the write.
      still: () => {
        const now = instructEligibility(mainRoot, o.macro, o.subtask, { branch: first.subtask.branch });
        if (now.problem) return now.problem;
        if (now.child !== first.child) return `subtask ${o.subtask}'s child changed while the instruction was written (${first.child ?? 'none'} → ${now.child ?? 'none'}): write it again`;
        return stepRefusal(now);
      },
    });
  } catch (e) {
    if (!(e instanceof InstructionRefusal)) throw e;
    err(`✗ ${e.message}`);
    return 1;
  }
  out(`✓ instruction ${entry.id} r${entry.revision} for subtask ${o.subtask} of macro ${o.macro}: ${entry.state}${step ? ` (next ${step})` : ' (note only)'}`);
  out(entry.child ? `  for child ${entry.child}` : '  waiting for the dispatch: it reaches the child after the dispatch step');
  out(`  revise it: --revises ${entry.id}:${entry.revision} · withdraw it: agentic-autopilot instruct ${o.subtask} --macro ${o.macro} --withdraw ${entry.id}`);
  const live = await liveRuns(mainRoot, o.macro);
  if (live.live) {
    const blind = live.runs.filter((r) => !r.capabilities.includes(INSTRUCTIONS_CAPABILITY));
    if (blind.length) {
      out(`  ⚠ ${blind.map((r) => (r.run_id ? `run ${r.run_id}` : live.why)).join(', ')} does not apply instructions (${INSTRUCTIONS_CAPABILITY}): the instruction waits for a run that does`);
    } else out('  the live run applies it at the lane\'s next step boundary');
    return 0;
  }
  if (applyNow) return applyNow({ mainRoot, macroId: o.macro, subtaskId: o.subtask, entry, out, err });
  out('  no run is live: the next run applies it at the lane\'s next step boundary');
  return 0;
}

/**
 * The command's own application with no run live (item 3): the lane's pending
 * instructions applied when it is at a boundary, under an admission of
 * `instruct` (state.mjs applyLaneInstructions), and no event written (item
 * 8): the result shows here and in `status` only. A lane not at a boundary
 * keeps them for the next run, which applies them before it acts on the lane.
 */
export function applyNowWith({ engineerRoot, env = process.env, home }) {
  return async ({ mainRoot, macroId, subtaskId, out, err }) => {
    const macro = readMacro(mainRoot, macroId);
    if (macro.problem) { err(`✗ ${macro.problem}`); return 1; }
    let r;
    try {
      r = await applyLaneInstructions({
        workflowPath: macro.path, host: 'claude', engineerRoot, subtaskId, env, ...(home ? { home } : {}), by: 'instruct',
        laneBusyOf: ({ mainRoot: m, macroId: id, subtaskId: sid }) => laneBusy(m, id, sid),
      });
    } catch (e) {
      out(`  not applied now (${String(e?.message ?? e).split('\n')[0]}): the next run applies it at the lane's next step boundary`);
      return 0;
    }
    for (const d of r.dropped ?? []) out(`  instruction ${d.id} r${d.revision} dropped, never applied (${d.ack?.cause ?? '?'})`);
    if (r.state === 'applied') {
      out(`  applied now as ${r.applicationId}: ${r.entries.length} instruction(s)${r.effective ? `, next step ${r.effective}` : ', no next step set'}${r.superseded.length ? `; superseded: ${r.superseded.map((x) => `${x.id} (${x.cause})`).join(', ')}` : ''}`);
    } else if (r.state === 'none') {
      out('  nothing pending to apply now');
    } else {
      out(`  not applied now (${r.state}${r.detail ? `: ${r.detail}` : ''}): the next run applies it at the lane's next step boundary`);
    }
    return 0;
  };
}

/**
 * P2 — the steps the run ledgers under `runDirs` started from an application:
 * application id → { run, seq }. A ledger that cannot be read is passed over.
 */
export function stepsFromApplications(runDirs) {
  const out = new Map();
  for (const dir of [...new Set(runDirs)]) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.startsWith('autopilot-')).sort(); } catch { continue; }
    for (const n of names) {
      let text = '';
      try { text = fs.readFileSync(path.join(dir, n, 'steps.jsonl'), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.includes('instruction_application')) continue;
        try {
          const s = JSON.parse(line);
          if (s?.event === 'started' && typeof s.instruction_application === 'string') out.set(s.instruction_application, { run: n, seq: s.seq });
        } catch { /* torn */ }
      }
    }
  }
  return out;
}

/**
 * `status --macro <id>`'s lines for the macro's instructions: ids, states and
 * what became of each, never a note. An applied one with a step says whether
 * that step ran (a run's step ledger names its application), or not yet.
 */
export function instructionStatusLines(mainRoot, macroId, { runDirs = [] } = {}) {
  const ran = stepsFromApplications(runDirs);
  const ids = listInstructionIds(mainRoot, macroId);
  if (ids.state === 'absent') {
    // An ended macro: the outcomes its retirement kept (item 6).
    const ended = readEndedInstructions(mainRoot, macroId) ?? [];
    return ended.length
      ? [`instructions of ${macroId} (the macro ended):`, ...ended.map((e) => `    ${e.subtask_id}: instruction ${e.id ?? '(unreadable record)'}${e.revision ? ` r${e.revision}` : ''}: ${e.state}${e.cause ? ` (${e.cause})` : ''}`)]
      : [];
  }
  if (ids.state === 'unreadable') return [`instructions of ${macroId}: cannot be read (${READ_CODES[ids.code]})`];
  const lines = [];
  for (const id of ids.ids) {
    const r = readInstructions(mainRoot, macroId, id);
    if (r.state === 'unreadable') { lines.push(`${id}: the instructions record cannot be read (${READ_CODES[r.code]})`); continue; }
    if (r.state !== 'ok' || r.record.entries.length === 0) continue;
    lines.push(`${id}:`);
    const described = describeEntries(r.record);
    r.record.entries.forEach((e, i) => {
      let tail = '';
      if (e.state === 'applied' && e.step !== null && e.ack?.application_id) {
        const s = ran.get(e.ack.application_id);
        const receipts = r.record.receipts ?? [];
        const at = receipts.findIndex((x) => x.application_id === e.ack.application_id);
        const later = at < 0 ? null : receipts.slice(at + 1).find((x) => x.state === 'done' && x.effective_step !== null);
        tail = s ? `; its step ran (run ${s.run}, step ${s.seq})`
          : later ? `; its step was replaced before it ran (by ${later.application_id})` : '; its step has not run yet';
      }
      lines.push(`  ${described[i]}${tail}`);
    });
  }
  return lines.length ? [`instructions of ${macroId}:`, ...lines.map((l) => `  ${l}`)] : [];
}
