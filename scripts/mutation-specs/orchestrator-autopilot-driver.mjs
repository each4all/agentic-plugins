// Mutation spec — do the autopilot driver tests catch the defects they exist
// for? (ADR-0063 S8: the driver and /orchestrator:autopilot)
//
// Run: npm run mutate -- scripts/mutation-specs/orchestrator-autopilot-driver.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. The driver runs unattended, and every guard in
// it fails toward doing more than the owner approved: a policy that skips a
// gate runs a step the owner had to judge, a host that closes stdin early drops
// a peer's result, a lock that two runs can both take lets two drivers switch
// one checkout's branch, a scrub that misses a variable hands a worker the
// launching session's permissions or another macro's parentage, and a ledger
// written after the spawn leaves a step no record. A green suite proves none of
// that; breaking each guard on purpose does.
//
// Groups: P the policy, V verifyStep, W the worker host, L the ledger and
// locks, O the observer, D the driver loop, C the CLI.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TP = 'tests/orchestrator/test-autopilot-policy.mjs';
const TW = 'tests/orchestrator/test-autopilot-worker.mjs';
const TL = 'tests/orchestrator/test-autopilot-ledger.mjs';
const TO = 'tests/orchestrator/test-autopilot-observe.mjs';
const TD = 'tests/orchestrator/test-autopilot-driver.mjs';
const TC = 'tests/orchestrator/test-autopilot-cli.mjs';

const AP = 'plugins/orchestrator/adapters/claude/autopilot';
const POLICY = `${AP}/policy.mjs`;
const WORKER = `${AP}/worker.mjs`;
// The locks, which the autopilot ledger re-exports (ADR-0067 Decision 4,
// item 5); the ledger tests reach them through it.
const LOCKS = 'plugins/orchestrator/scripts/lib/run-locks.mjs';
const OBSERVE = `${AP}/observe.mjs`;
const DRIVER = `${AP}/driver.mjs`;
const BUDGET = `${AP}/budget.mjs`;
const CLI = `${AP}/cli.mjs`;

export const TESTS = [TP, TW, TL, TO, TD, TC];

export const MUTATIONS = [
  // ---- P: decide --------------------------------------------------------------
  {
    id: 'P1', file: POLICY, tests: [TP],
    from: "  const approved = approval?.status === 'approved' && approval?.hash_ok === true;",
    to: "  const approved = approval?.status === 'approved';",
    why: 'a plan edited after its approval runs under the old approval',
  },
  {
    id: 'P2', file: POLICY, tests: [TP, TO],
    from: '    if (!approved) {\n      const h = unapproved();',
    to: '    if (false) {\n      const h = unapproved();',
    why: 'an archived macro whose plan changed during the last step counts as completed',
  },
  {
    id: 'P3', file: POLICY, tests: [TP, TO],
    from: '  const claim = claimProblem(view, subtasks);',
    to: '  const claim = null;',
    why: 'an interrupted dispatch is dispatched again beside the child it left',
  },
  {
    id: 'P4', file: POLICY, tests: [TP],
    from: "    if (child.current_phase === 'phase-7-commit'\n      || ",
    to: '    if (',
    why: 'an interrupted commit follows its stale next step instead of recovering',
  },
  {
    id: 'P5', file: POLICY, tests: [TP],
    from: '    if ((child.pending_ensemble ?? 0) > 0) {',
    to: '    if (false) {',
    why: 'a step starts while the previous verb\'s peer is still pending',
  },
  {
    id: 'P6', file: POLICY, tests: [TP],
    from: "    if (ns.confidence !== 'HIGH') {\n      return { kind: 'active', judgment: true, halt: halt('low-confidence', `subtask ${id}: ${label}`",
    to: "    if (false) {\n      return { kind: 'active', judgment: true, halt: halt('low-confidence', `subtask ${id}: ${label}`",
    why: 'a next step below HIGH confidence runs (R4)',
  },
  {
    id: 'P7', file: POLICY, tests: [TP],
    from: "    if (c.kind === 'halt') return c.halt;",
    to: '    void c;',
    why: 'an owner gate is checked only after --next was applied, so --next can step past it',
  },
  {
    id: 'P8', file: POLICY, tests: [TP],
    from: '\n      if (waitingOn.length) return nope(',
    to: '\n      if (false) return nope(',
    why: '--next dispatches a subtask whose predecessors have not landed',
  },
  {
    id: 'P9', file: POLICY, tests: [TP],
    from: '    if (s.branch !== view.git.branch) {',
    to: '    if (false) {',
    why: 'an engineer step runs on whatever branch is checked out, against another workflow',
  },
  {
    id: 'P10', file: POLICY, tests: [TP, TD],
    from: '    if (!view.git.clean) return dirtyTree(view, ready.id);',
    to: '',
    why: 'a dispatch starts on a dirty tree',
  },
  {
    id: 'P11', file: POLICY, tests: [TP],
    from: '    const safe = isSafeBranch(w.branch) && isSafeBranch(integrationBranch);',
    to: '    const safe = true;',
    why: 'a branch name carrying shell text is printed as a command for the owner to paste',
  },
  {
    id: 'P12', file: POLICY, tests: [TP],
    from: '    if (!isSafeSubtaskId(ready.id)) {',
    to: '    if (false) {',
    why: 'a subtask id carrying text reaches a worker\'s prompt (R5)',
  },
  {
    id: 'P13', file: POLICY, tests: [TP],
    from: '    if (live.length >= 2) {',
    to: '    if (live.length >= 3) {',
    why: 'two live workflows competing on the branch (duplicate-workflow) do not halt',
  },
  {
    id: 'P14', file: POLICY, tests: [TP],
    from: '    if (!ALLOWED_LEAD_COMMANDS.includes(cmd)) {',
    to: '    if (false) {',
    why: 'an entry-brief lead outside the step table is ignored',
  },
  {
    id: 'P15', file: POLICY, tests: [TP],
    from: "  return Array.isArray(history) ? history.filter((h) => h && h.event && h.event !== 'snapshot').length : 0;",
    to: '  return Array.isArray(history) ? history.length : 0;',
    why: 'a Stop snapshot reads as progress, so a step that did nothing never halts no-progress',
  },

  // ---- V: verifyStep ----------------------------------------------------------
  {
    id: 'V1', file: POLICY, tests: [TP],
    from: '    if (r.workflow !== child.workflow_id || !same) {',
    to: '    if (!same) {',
    why: 'a report about another workflow (the macro\'s proposal) passes the D11 cross-check',
  },
  {
    id: 'V2', file: POLICY, tests: [TP],
    from: '    if (r.workflow !== child.workflow_id || !same) {',
    to: '    if (false) {',
    why: 'the worker\'s next step is never compared with the state',
  },
  {
    id: 'V3', file: POLICY, tests: [TP],
    from: '      if (after?.git?.head && after.git.head !== before?.git?.head) return null;\n      return `the commit step left',
    to: '      return null;\n      return `the commit step left',
    why: 'a commit recovery that the Stop hook keeps refusing repeats until the budget runs out',
  },
  {
    id: 'V5', file: POLICY, tests: [TP, TD],
    from: "  if (w.groupTeardown === 'lingering') {",
    to: '  if (false) {',
    why: 'a step whose process group outlived SIGKILL is judged like any other, and the run goes on beside it (round 4)',
  },
  {
    id: 'V4', file: POLICY, tests: [TP, TD],
    from: '    : fingerprint(before) === fingerprint(after);',
    to: '    : false;',
    why: 'a step that changed nothing runs again and again',
  },

  {
    id: 'V6', file: POLICY, tests: [TP],
    from: "      : halt('no-progress', 'the step exited 0 and changed no state', { subtaskId: s.subtaskId ?? null });\n  }\n  return null;",
    to: "      : halt('no-progress', 'the step exited 0 and changed no state', { subtaskId: s.subtaskId ?? null });\n  }\n  if (typeof w.peakPct === 'number' && w.peakPct > 0.25) return halt('step-oversized', 'peak context over 25%', { subtaskId: s.subtaskId ?? null });\n  return null;",
    why: 'the size halt comes back: a step that ended well halts on its peak context (ADR-0063 D7, amendment of 2026-10-13)',
    killed_by: /records a step's size and never judges it/,
  },
  {
    id: 'V7', file: POLICY, tests: [TP],
    from: '  if (unread) {\n    const runWide',
    to: '  if (false) {\n    const runWide',
    why: 'a look that could not read what verifyStep compares is reported as the step\'s failure: a postcondition or cross-check over nothing (C92)',
    killed_by: [/the macro: halts owner-choice naming the read/, /its readiness: halts owner-choice naming the read/, /the step's own child: halts owner-choice naming the read/],
  },
  {
    id: 'V8', file: POLICY, tests: [TP],
    from: '  if (after?.readyError) return',
    to: '  if (false) return',
    why: 'a look that could not read the macro\'s readiness passes as one that did (C92)',
    killed_by: /its readiness: halts owner-choice naming the read/,
  },
  {
    id: 'V9', file: POLICY, tests: [TP],
    from: "  if (child?.location === 'error') return",
    to: '  if (false) return',
    why: 'a look that could not read the step\'s own engineer workflow passes as one that did (C92)',
    killed_by: /the step's own child: halts owner-choice naming the read/,
  },
  {
    id: 'V10', file: POLICY, tests: [TP],
    from: '  const closedByReport = w.closedOnReport === true && w.lastResult.is_error !== true;',
    to: '  const closedByReport = w.lastResult.is_error !== true;',
    why: 'any step that ended with a result is exempt from its exit status, not only one closed on its finished report (C127)',
    killed_by: /is judged as any other when the close was not on its report/,
  },
  {
    id: 'V11', file: POLICY, tests: [TP],
    from: '  if (r.waiting_on_background === true) {',
    to: '  if (false) {',
    why: 'a last report that still waits, from a worker that exited, passes (C127)',
    killed_by: /a last report that still waits, from a worker that exited/,
  },
  {
    id: 'P18', file: POLICY, tests: [TP],
    from: '  const named = list.slice(0, SKIPPED_MAX)',
    to: '  const named = list',
    why: 'an indeterminate brief\'s skipped sources are relayed without a bound',
    killed_by: /relays at most the schema's eleven/,
  },
  {
    id: 'P16', file: POLICY, tests: [TP],
    from: "    return `entry-brief is indeterminate (the branch moved while it read, or a source it could not read could outrank the rest)${skipped ? `; skipped: ${skipped}` : ''}`;",
    to: "    return 'entry-brief is indeterminate (the branch moved while it read, or a source it could not read could outrank the rest)';",
    why: 'an indeterminate entry-brief halt hides the sources runtime skipped and why',
    killed_by: /relays each skipped source and its reason/,
  },
  {
    id: 'P17', file: POLICY, tests: [TP],
    from: '    .filter((x) => x && typeof x === \'object\' && code(x.source) && (x.kind === null || code(x.kind)) && (x.reason === null || code(x.reason)))',
    to: '    .filter((x) => x && typeof x === \'object\')',
    why: 'a skipped-source entry of any shape, shell text in its name included, reaches the halt text',
    killed_by: /drops an entry of any other shape/,
  },

  // ---- W: the worker host -----------------------------------------------------
  {
    id: 'W1', file: WORKER, tests: [TW],
    from: "    if (st.pending === 0) return 'idle';",
    to: "    if (true) return 'idle';",
    why: 'stdin closes while a background task (a peer) is still running, which kills it (probe D)',
  },
  {
    id: 'W2', file: WORKER, tests: [TW],
    from: '    if (st.stdinClosed || st.aborted || st.exit !== null || st.results.length === 0 || st.awaitingFollowUp) return null;',
    to: '    if (st.stdinClosed || st.aborted || st.exit !== null || st.results.length === 0) return null;',
    why: 'stdin closes before the turn a finished background task triggers (probe D2)',
  },
  {
    id: 'W3', file: WORKER, tests: [TW],
    from: '      if (!ev.parent_tool_use_id) {',
    to: '      if (true) {',
    why: 'a subagent\'s context counts as the step\'s: the peak the ledger records is a subagent\'s, not the step\'s (an observation since ADR-0063 D7\'s amendment of 2026-10-13, no halt)',
  },
  {
    id: 'W4', file: WORKER, tests: [TW],
    from: "  const denied = stepKind === 'commit' ? DENIED_TOOLS : [...DENIED_TOOLS, COMMIT_DENY];",
    to: '  const denied = DENIED_TOOLS;',
    why: 'a verb step may run git commit',
  },
  {
    id: 'W5', file: WORKER, tests: [TW],
    from: "  'CLAUDE_CODE_SESSION_', 'CLAUDE_CODE_MESSAGING_', 'CLAUDE_CODE_CHILD_', 'CLAUDE_BG_', 'CLAUDE_RELAUNCH_',",
    to: "  'CLAUDE_CODE_SESSION_', 'CLAUDE_CODE_MESSAGING_', 'CLAUDE_CODE_CHILD_', 'CLAUDE_RELAUNCH_',",
    why: 'a background session\'s permission rules reach the worker',
  },
  {
    id: 'W6', file: WORKER, tests: [TW],
    from: '  Object.assign(env, pushBlockConfig(base, remotes));',
    to: '',
    why: 'a worker can push with git -C, which the denylist does not match',
  },
  {
    id: 'W7', file: WORKER, tests: [TW],
    from: '    try { process.kill(-child.pid, signal); } catch {',
    to: '    try { child.kill(signal); } catch {',
    why: 'a timeout kills the worker but not what it started',
  },
  {
    id: 'W8', file: WORKER, tests: [TW, TD],
    from: "        if (problem) abort('provenance', problem);",
    to: '        void problem;',
    why: 'a worker running other plugin code than the run pinned goes ahead',
  },
  {
    id: 'W9', file: WORKER, tests: [TW],
    from: '    if (ESCALATION.some((re) => re.test(a))) throw',
    to: '    if (false) throw',
    why: 'an escalation flag passes the argv guard',
  },
  {
    id: 'W10', file: WORKER, tests: [TW],
    from: "  'AGENTIC_PARENT_WORKFLOW', 'AGENTIC_ORIGINATING_SUBTASK', 'AGENTIC_PROFILE', 'AGENTIC_TOPIC',",
    to: "  'AGENTIC_ORIGINATING_SUBTASK', 'AGENTIC_PROFILE', 'AGENTIC_TOPIC',",
    why: 'an outer session\'s dispatch parent reaches the worker\'s engineer workflow',
  },

  {
    id: 'W11', file: WORKER, tests: [TW, TD],
    from: "        : await (o.terminateGroup ?? terminateGroup)(child.pid, { signalled, signalledAt: st.abortedAt ?? st.reportSignalledAt ?? Date.now() });",
    to: "        : 'empty';",
    why: 'a group member that ignores SIGTERM outlives the step, and the driver releases its locks and exits before any escalation (round 3)',
  },
  {
    id: 'W12', file: WORKER, tests: [TW],
    from: '      setTimeout(() => finish(code, signal), DRAIN_AFTER_EXIT_MS).unref?.();',
    to: '      void code;',
    why: 'a descendant holding the output pipes keeps the step open forever',
  },
  {
    id: 'W14', file: WORKER, tests: [TW],
    from: "    setTimeout(() => { if (st.exit === null) killGroup('SIGKILL'); }, timing.killGraceMs).unref?.();",
    to: '',
    why: 'a worker that ignores SIGTERM never exits, so its step never ends',
  },
  {
    id: 'W15', file: WORKER, tests: [TW],
    from: '      const signalled = st.aborted !== null || st.reportTeardown !== null;',
    to: '      const signalled = true;',
    why: 'what a step that ended normally left in its group gets no SIGTERM, only a SIGKILL after the grace',
  },
  {
    id: 'W13', file: WORKER, tests: [TW],
    from: '  return { sessionId, pid: child.pid, begin, abort, done };',
    to: '  begin();\n  return { sessionId, pid: child.pid, begin, abort, done };',
    why: 'a worker gets its prompt before the driver has recorded it',
  },
  {
    id: 'W16', file: WORKER, tests: [TW],
    from: '    if (baseModel(key) === base && isWindow(w)',
    to: '    if (key === model && isWindow(w)',
    why: 'a result that keys the model with a window suffix (`[1m]`) records no context window and no peak share (C136)',
    killed_by: /records the share when the result keys the model with a window suffix/,
  },
  {
    id: 'W17', file: WORKER, tests: [TW],
    from: '(best === null || w > best)) best = w;',
    to: 'best === null) best = w;',
    why: 'two keys that are one model once their suffixes are dropped answer by the keys\' order, not the larger window',
    killed_by: /contextWindowFor:/,
  },
  {
    id: 'W18', file: WORKER, tests: [TW],
    from: "    return last.is_error !== true && reportSaysFinished(last.structured_output) ? 'report' : null;",
    to: '    return null;',
    why: 'a finished report with a background task pending holds the step open to its timeout (C127)',
    killed_by: /a finished report with a never-ending background task ends the step ok/,
  },
  {
    id: 'W20', file: POLICY, tests: [TP, TW],
    from: "  if (typeof r.waiting_on_background !== 'boolean') return 'waiting_on_background';",
    to: '',
    why: 'a report with the field missing or mistyped counts as valid (C127)',
    killed_by: /reportSaysFinished: only a report valid in every field/,
  },
  {
    id: 'W21', file: WORKER, tests: [TW],
    from: "    if (mode !== null && st.closeArm?.mode === 'report' && st.closeArm.result === last) return;",
    to: '',
    why: 'every stream event pushes the close on a report back, so a chatty worker is held open (C127)',
    killed_by: /other stream events do not push the close back/,
  },
  {
    id: 'W26', file: WORKER, tests: [TW],
    from: "    if (mode !== null && st.closeArm?.mode === 'report' && st.closeArm.result === last) return;",
    to: "    if (mode === 'report' && st.closeArm?.mode === 'report' && st.closeArm.result === last) return;",
    why: 'the task list moving to empty and back re-arms the close on a report each time, so it can be put off for ever (C127)',
    killed_by: /the task list moving to empty and back does not push an armed close back/,
  },
  {
    id: 'W27', file: WORKER, tests: [TW],
    from: '    if (st.stdinClosed || st.aborted || st.exit !== null) return;',
    to: '    if (st.stdinClosed || st.aborted) return;',
    why: 'a worker that exited before the debounce fired is closed on its report, and its failing exit goes unjudged (C127)',
    killed_by: /a worker that exits before the debounce fires is never closed on its report/,
  },
  {
    id: 'W22', file: WORKER, tests: [TW],
    from: '        abandonedBackground: reportEof ? st.abandoned : [],',
    to: '        abandonedBackground: [],',
    why: 'the step record does not name the background tasks the close abandoned (C127)',
    killed_by: /a finished report with a never-ending background task ends the step ok/,
  },
  {
    id: 'W23', file: WORKER, tests: [TW],
    from: "      st.reportSignalledAt = Date.now();\n      killGroup('SIGTERM');",
    to: '      st.reportSignalledAt = Date.now();',
    why: 'a host that ignores the EOF after a finished report is never signalled, so it runs to its timeout (C127)',
    killed_by: /a host that ignores stdin closure is signalled after the grace/,
  },
  {
    id: 'W24', file: WORKER, tests: [TW],
    from: "        st.reportTeardown = 'killed';\n        killGroup('SIGKILL');",
    to: "        st.reportTeardown = 'killed';",
    why: 'a host that ignores the EOF and SIGTERM after a finished report is never killed (C127)',
    killed_by: /a host that ignores stdin closure and SIGTERM is killed after the kill grace/,
  },
  {
    id: 'W25', file: WORKER, tests: [TW],
    from: '      const closedOnReport = reportEof && st.closeResult === last;',
    to: '      const closedOnReport = reportEof;',
    why: 'a result after the EOF still counts as closed on the earlier report, so its exit is not judged (C127)',
    killed_by: /a result after EOF ends the exemption, never the history/,
  },

  // ---- L: the ledger and locks --------------------------------------------------
  {
    id: 'L1', file: LOCKS, tests: [TL],
    from: "    const rival = after.find((e) => e.state !== 'gone');\n    if (!rival) {",
    to: '    const rival = undefined;\n    if (!rival) {',
    why: 'contenders that added their entries at the same time all take the lock',
  },
  {
    id: 'L2', file: LOCKS, tests: [TL],
    from: "  if (worker === 'live') return true;",
    to: "  if (false) return true;",
    why: 'a dead driver\'s lock is reclaimed while its worker still runs',
  },
  {
    id: 'L3', file: LOCKS, tests: [TL],
    from: '    unlinkQuiet(mine);\n    if (attempt === attempts)',
    to: '    if (attempt === attempts)',
    why: 'a contender that backs off leaves its entry, so every later run is refused',
  },
  {
    id: 'L4', file: LOCKS, tests: [TL],
    from: "  if (comparable && startDiffers(recorded, current)) return 'other';",
    to: "  if (!comparable || startDiffers(recorded, current)) return 'other';",
    why: 'a fingerprint that cannot be read counts as stale, so a live run\'s lock is taken',
  },
  {
    id: 'L5', file: LOCKS, tests: [TL],
    from: "    if (before.some((e) => e.state === 'busy')) { await pause(100); continue; }",
    to: '',
    why: 'an entry that cannot be read yet is reported as a live holder instead of waited for',
  },
  {
    id: 'L6', file: LOCKS, tests: [TL],
    from: '    if (m && !(await isProcessAlive(Number(m[1])))) unlinkQuiet(path.join(lock, n));',
    to: '    if (m) unlinkQuiet(path.join(lock, n));',
    why: 'a live participant\'s half-written entry is removed under it',
  },
  {
    id: 'L7', file: LOCKS, tests: [TL],
    from: "  if (e.holder === null) return now() - e.mtimeMs < FRESH_UNPARSED_MS ? 'busy' : 'gone';",
    to: "  if (e.holder === null) return 'gone';",
    why: 'an entry that does not parse is removed however fresh it is',
  },
  {
    id: 'L8', file: LOCKS, tests: [TL],
    from: "    for (let rereads = 0; state === 'gone'; rereads += 1) {",
    to: '    for (let rereads = 0; false; rereads += 1) {',
    why: 'an entry judged on a record its owner has since rewritten — recording a live worker, then dying — is removed, and a second run starts beside that worker (round 4)',
  },
  {
    id: 'L10', file: LOCKS, tests: [TL],
    from: "  if (worker === 'other' && holder.worker?.pgid === holder.worker?.pid) return false;",
    to: '',
    why: 'a group that reused the worker\'s id keeps a dead run\'s lock held until that unrelated group ends (round 5)',
  },
  {
    id: 'L11', file: LOCKS, tests: [TL],
    from: "  if (comparable && startDiffers(recorded, current)) return 'other';",
    to: "  if (comparable && !fingerprintsMatch(recorded, current)) return 'other';",
    why: 'a worker whose command line changed with an exec in place counts as a reused pid, and its live run\'s lock is taken (round 6)',
  },
  {
    id: 'L12', file: LOCKS, tests: [TL],
    from: "  return Boolean(current && current.kind !== 'none' && current.zombie !== true && fingerprintsMatch(recorded, current));",
    to: "  return Boolean(current && current.kind !== 'none' && current.zombie !== true && !startDiffers(recorded, current));",
    why: 'stop signals a pid whose start time matches but whose command does not — proof weakened to what only keeps a lock held (round 7)',
  },
  {
    id: 'L13', file: LOCKS, tests: [TL, TD],
    from: "  if (current?.zombie === true) return 'dead';\n",
    to: '',
    why: 'an exited driver its parent has not reaped yet still holds its lock, and stop waits on it (CI, Linux)',
  },
  {
    id: 'L14', file: LOCKS, tests: [TL],
    from: "env: { ...process.env, LC_ALL: 'C' },",
    to: 'env: process.env,',
    why: 'the start time is read in the caller\'s locale, so outside the C locale it cannot be told from the command line',
  },
  {
    id: 'L15', file: LOCKS, tests: [TL],
    from: "current.kind !== 'none' && current.zombie !== true && fingerprintsMatch(recorded, current)",
    to: "current.kind !== 'none' && fingerprintsMatch(recorded, current)",
    why: 'an exited, unreaped process counts as proof for a signal',
  },
  {
    id: 'L16', file: LOCKS, tests: [TL],
    from: "  if (comparable && startDiffers(recorded, current)) return 'other';\n  // The recorded process, exited and not yet reaped by its parent (CI,\n  // 2026-10-03: a driver whose parent was blocked in spawnSync held its lock\n  // until the wait ended).\n  if (current?.zombie === true) return 'dead';\n",
    to: "  if (current?.zombie === true) return 'dead';\n  if (comparable && startDiffers(recorded, current)) return 'other';\n  // The recorded process, exited and not yet reaped by its parent (CI,\n  // 2026-10-03: a driver whose parent was blocked in spawnSync held its lock\n  // until the wait ended).\n",
    why: 'a stranger that reused the worker\'s pid and then exited is taken for the worker having exited, so its group keeps a dead run\'s lock held (round 8)',
  },
  {
    id: 'L9', file: LOCKS, tests: [TL, TD],
    from: '  return groupAlive(holder.worker?.pgid);',
    to: '  return false;',
    why: 'a lock whose worker\'s group outlived SIGKILL is reclaimed while that group still has members (round 4)',
  },

  // ---- O: the observer ------------------------------------------------------------
  {
    id: 'O1', file: OBSERVE, tests: [TO],
    from: '  const child = summarizeChild(archived.fm, \'archived\', archived.file, roots.scan);\n  const wrong = linkageProblems(child, { macroId, subtask });',
    to: '  const child = summarizeChild(archived.fm, \'archived\', archived.file, roots.scan);\n  const wrong = [];',
    why: 'an earlier attempt\'s archive on another branch completes the revised subtask',
  },
  {
    id: 'O2', file: OBSERVE, tests: [TO],
    from: '    if (fetch && integration) {',
    to: '    if (false) {',
    why: 'a landing is judged against a stale origin ref and the run halts awaiting-landing after the merge',
  },
  {
    id: 'O3', file: OBSERVE, tests: [TO],
    from: '      if (r.fm.parent_workflow !== macroId) continue;',
    to: '      continue;',
    why: 'no claim is ever seen, so an interrupted dispatch goes unnoticed',
  },

  // ---- D: the driver loop -------------------------------------------------------------
  {
    id: 'D1', file: DRIVER, tests: [TD],
    prepare(copy) {
      // Write the started record after the worker has run, not before.
      const file = join(copy, DRIVER);
      const t = readFileSync(file, 'utf8');
      const start = t.indexOf('      // D1: the spawn is on record before it starts.\n');
      const end = t.indexOf('      out(`[${seq}] ${command}');
      const done = '      const w = await current.done;\n';
      if (start < 0 || end < start || !t.includes(done)) throw new Error('D1: anchors moved');
      const block = t.slice(start, end);
      writeFileSync(file, t.slice(0, start) + t.slice(end).replace(done, `${done}${block}`));
    },
    why: 'a step runs before it is on record, so a driver that dies mid-step leaves no trace of it',
  },
  {
    id: 'D2', file: DRIVER, tests: [TD],
    from: '      locks.push(await acquireLock(worktreeLockPath(repoRoot), { record, now }));\n      if (macroId) locks.push(',
    to: '      if (macroId) locks.push(',
    why: 'two runs of different macros switch one checkout\'s branch at once',
  },
  {
    id: 'D3', file: DRIVER, tests: [TD],
    from: '      if (macroId) locks.push(await acquireLock(macroLockPath(',
    to: '      if (false) locks.push(await acquireLock(macroLockPath(',
    why: 'a second run drives a macro a live run holds',
  },
  {
    id: 'D4', file: BUDGET, tests: [TD],
    from: '      const charged = reported ? costUsd : reservation.usd;',
    to: '      const charged = reported ? costUsd : 0;',
    why: 'a killed step costs nothing, so the run cap is never reached',
  },
  {
    id: 'D5', file: DRIVER, tests: [TD],
    from: '      const drift = seq > 1 ? driftOf(pinned, await resolveRootsNow({ env })) : [];\n      // C123',
    to: '      const drift = [];\n      // C123',
    why: 'an install that changed mid-run is used without notice',
  },
  {
    id: 'D6', file: DRIVER, tests: [TD],
    from: '        cancelled = (deps.cancelPeerRuns ?? cancelPeerRuns)(newPendingRuns(ownChildOnly(before, id), ownChildOnly(view, id), id), { roots, checkout: repoRoot, env });',
    to: '        cancelled = [];',
    why: 'a killed step\'s peer keeps running, detached from the worker\'s group',
  },
  {
    id: 'D7', file: DRIVER, tests: [TD],
    from: "    if (isWithin(path, canonical(repoRoot))) {",
    to: '    if (false) {',
    why: 'plugin code loaded from the driven checkout changes with each branch switch',
  },

  {
    id: 'D8', file: DRIVER, tests: [TD],
    from: "      const d = decide(view, ctx);\n      if (d.outcome === 'completed') {",
    to: "      if (seq > options.maxSteps) return await finish('halted', { reason: 'budget', detail: 'cap' });\n      const d = decide(view, ctx);\n      if (d.outcome === 'completed') {",
    why: 'completion on the last step the cap allowed is reported as a budget halt',
  },
  {
    id: 'D9', file: DRIVER, tests: [TD],
    from: '    for (const id of c?.pending_runs ?? []) ids.add(id);',
    to: '',
    why: 'a dispatch killed before it recorded its subtask leaves its peer running',
  },
  {
    id: 'D10', file: DRIVER, tests: [TD],
    from: '  if (unguarded.length > 0) {',
    to: '  if (false) {',
    why: 'a repository whose pushurl the git-level block cannot cover is driven anyway',
  },
  {
    id: 'D12', file: DRIVER, tests: [TD],
    from: "      if (w.groupTeardown === 'lingering') lingering = true;\n      else setWorker(null);",
    to: '      setWorker(null);',
    why: 'a run halted beside a group that outlived SIGKILL releases its locks, so the next run starts beside it (round 4)',
  },
  {
    id: 'D13', file: DRIVER, tests: [TD],
    from: '    if (lingering) locks.length = 0;\n',
    to: '',
    why: 'the locks a lingering group must keep are released when the run halts (round 4)',
  },
  {
    id: 'D14', file: DRIVER, tests: [TD],
    from: '    view = look(macroId);\n    if ((view.macro?.id ?? null) !== macroId) {',
    to: '    if ((view.macro?.id ?? null) !== macroId) {',
    why: 'the first step is decided from a look taken before the locks, so a halt another run set in between is stepped past (round 6)',
  },
  {
    id: 'D15', file: DRIVER, tests: [TD],
    prepare(copy) {
      // Take the second look before the locks instead of after them.
      const file = join(copy, DRIVER);
      const t = readFileSync(file, 'utf8');
      const look = '    view = look(macroId);\n';
      const locks = '    const record = { run_id: runId, repo: repoRoot, macro_id: macroId, started_at: run.started_at, token_digest: tokenDigest(token), capabilities: run.capabilities, lanes };\n';
      if (t.split(look).length !== 2 || t.split(locks).length !== 2) throw new Error('D15: anchors moved');
      writeFileSync(file, t.replace(look, '').replace(locks, `${look}${locks}`));
    },
    why: 'the look the first step is decided from is taken before the locks, so a halt set before the locks were held is stepped past (round 7)',
  },
  {
    id: 'D11', file: DRIVER, tests: [TD],
    from: "      if (Number.isInteger(current.pid)) setWorker({ pid: current.pid, pgid: process.platform === 'win32' ? null : current.pid, fingerprint: await processFingerprint(current.pid), session_id: sessionId });\n      current.begin();",
    to: '      current.begin();',
    why: 'a driver that dies after the spawn leaves a working worker no lock records',
  },

  {
    id: 'D16', file: DRIVER, tests: [TD],
    from: '      let unaccounted = afterUnread(view, id) !== null;',
    to: '      let unaccounted = false;',
    why: 'a serial step judged from a look that could not read the macro, its readiness or its child halts, and the run drops its open-run record: the step\'s peers are never cancelled',
    killed_by: /halts on that read and keeps the run's open-run record/,
  },
  {
    id: 'D19', file: DRIVER, tests: [TD],
    from: '        if (settled.keep) unaccounted = true;\n',
    to: '',
    why: 'a peer the serial run could not cancel, or could not list, is forgotten: the run removes its open-run record, so no later cleanup finds that peer',
    killed_by: /a peer the serial run could not cancel/,
  },
  {
    id: 'D20', file: DRIVER, tests: [TD],
    from: '        const settled = peerCancellationOutcome(verdict, cancelled, peersUnlisted(view, id));',
    to: '        const settled = peerCancellationOutcome(verdict, cancelled, null);',
    why: 'a failed serial step judged from a look that could not list its peers finds none, and the run removes its open-run record: no later cleanup finds them (lanes keeps it)',
    killed_by: /a look that cannot list the claims: nothing is cancelled/,
  },
  {
    id: 'D21', file: DRIVER, tests: [TD],
    from: 'newPendingRuns(ownChildOnly(before, id), ownChildOnly(view, id), id)',
    to: 'newPendingRuns(before, view, id)',
    why: 'a workflow read in place of the subtask\'s child is a source of the serial step\'s peer cancellations: a failed step cancels an unrelated workflow\'s peer',
    killed_by: /a workflow read in place of the subtask's child: its peer is not cancelled/,
  },
  {
    id: 'D22', file: DRIVER, tests: [TD],
    from: '      if (peersUnlisted(view, id)) view = look(before.macro.id);\n',
    to: '',
    why: 'a serial look that meets a child archived between its scan and its read is not taken again: the step halts owner-choice on a legitimate transition',
    killed_by: /could not read the step's child once is taken again/,
  },
  {
    id: 'D17', file: DRIVER, tests: [TD],
    from: "      const r = budget.reserve();\n      if (!r.ok) return await finish('halted', { reason: 'budget', detail: r.detail ?? r.why });",
    to: "      const r = now() - startedAt > 86_400_000 ? { detail: 'the run reached its wall clock (86400 s)' } : budget.reserve();\n      if (!r.ok) return await finish('halted', { reason: 'budget', detail: r.detail ?? r.why });",
    why: 'a run clock comes back in the serial run: a run three days old halts budget though its steps and cost are far from their caps',
    killed_by: /a step started three days into the run gets the whole step timeout/,
  },
  {
    id: 'D18', file: DRIVER, tests: [TD],
    from: '      const stepTimeoutSec = reservation.timeoutSec;',
    to: '      const stepTimeoutSec = Math.floor(Math.min(reservation.timeoutSec, 7000 - (now() - startedAt) / 1000));',
    why: 'the run deadline comes back at the serial spawn: a late step gets what is left of the runbook\'s old two hours, here less than nothing',
    killed_by: /a step started three days into the run gets the whole step timeout/,
  },
  {
    id: 'D23', file: DRIVER, tests: [TD],
    from: '      if (!verdict && w.reportEof === true) {',
    to: '      if (false) {',
    why: 'a step closed on its finished report leaves its peer pending, and the run halts on it at the next decision (C127)',
    killed_by: /the step passes, its abandoned task is named, and its peer is cancelled and settled/,
  },
  {
    id: 'D29', file: DRIVER, tests: [TD],
    from: '            else if (targets.length > 0) verdict = peersOnlyProgress({ step: s, before, after: view });',
    to: '',
    why: 'a step whose only change is the peer it left passes, and the next decision runs it again (C127)',
    killed_by: /a step whose only change is the peer it left halts no-progress/,
  },
  {
    id: 'V12', file: POLICY, tests: [TP, TD],
    from: '  const opts = { withoutPeers: true };',
    to: '  const opts = { withoutPeers: false };',
    why: 'the progress check after the cleanup counts the settled peer row as progress (C127)',
    killed_by: [/a step that changed nothing but a peer row/, /a step whose only change is the peer it left halts no-progress/],
  },
  {
    id: 'D24', file: DRIVER, tests: [TD],
    from: "    const settle = peerRunner(roots, ['settle',",
    to: "    const settle = { exit: 0, result: null, command: null } ?? peerRunner(roots, ['settle',",
    why: 'the abandoned peer is cancelled but never settled: its pending row stays (C127)',
    killed_by: /the step passes, its abandoned task is named, and its peer is cancelled and settled/,
  },
  {
    id: 'D25', file: DRIVER, tests: [TD],
    from: '            else if (targets.length > 0) verdict = peersOnlyProgress({ step: s, before, after: view });\n            view = look(',
    to: '            else if (targets.length > 0) verdict = peersOnlyProgress({ step: s, before, after: view });\n            void (',
    why: 'the next decision reads the look from before the cleanup, and halts on the row it settled (C127)',
    killed_by: /the step passes, its abandoned task is named, and its peer is cancelled and settled/,
  },
  {
    id: 'D26', file: DRIVER, tests: [TD],
    from: "      if (interrupted) {\n        budget.settle(reservation, { spawned: false });\n        reservation = null;\n        return await finish('halted', { reason: 'interrupted', detail: 'the owner interrupted the run' });\n      }\n      if (drift.length > 0) {",
    to: '      if (drift.length > 0) {',
    why: 'a signal during the drift check before a spawn starts the next worker anyway (C123)',
    killed_by: /starts no worker and no step, releases the step's reservation/,
  },
  {
    id: 'D27', file: DRIVER, tests: [TD],
    from: "      if (interrupted) {\n        budget.settle(reservation, { spawned: false });\n        reservation = null;\n        return await finish('halted', { reason: 'interrupted'",
    to: "      if (interrupted) {\n        reservation = null;\n        return await finish('halted', { reason: 'interrupted'",
    why: 'the interrupted step\'s reservation is never released (C123)',
    killed_by: /starts no worker and no step, releases the step's reservation/,
  },
  {
    id: 'D28', file: 'plugins/orchestrator/adapters/claude/autopilot/roots.mjs', tests: [TD],
    from: "    ['scripts/peer-runner.mjs', \"opts.subcommand === 'settle'\",",
    to: "    ['scripts/peer-runner.mjs', 'peer-runner',",
    why: 'a run starts on an engineer whose peer-runner cannot settle the peers a step closed on its report left (C127)',
    killed_by: /refuses a pinned engineer whose peer-runner has no settle/,
  },

  // ---- C: the CLI -----------------------------------------------------------------------
  {
    id: 'C1', file: CLI, tests: [TC],
    from: "  if (o.sub === 'start' && o.execute && isAutopilotRun(env)) {",
    to: '  if (false) {',
    why: 'a worker of a run can start another run',
  },
  {
    id: 'C2', file: CLI, tests: [TC],
    from: '    } else if (io.stdin.isTTY) {',
    to: '    } else if (true) {',
    why: 'a non-interactive start asks a question no one can answer instead of refusing (D5)',
  },
  {
    id: 'C3', file: CLI, tests: [TC],
    from: '  if (!(await provablySame(holder.pid, holder.fingerprint))) return stopDeadDriver(holder, entries);',
    to: '  if (!(await holderAlive({ pid: holder.pid, fingerprint: holder.fingerprint }))) return stopDeadDriver(holder, entries);',
    why: 'stop signals a pid it cannot prove is the run\'s process (round 2: a reused pid)',
  },
  {
    id: 'C5', file: CLI, tests: [TC],
    from: '      const outcome = await terminateGroup(w.pid);',
    to: "      try { process.kill(-w.pid, 'SIGTERM'); } catch { /* gone */ }\n      const outcome = 'terminated';",
    why: 'stop reports an orphaned worker stopped while a member of its group that ignores SIGTERM runs on (round 3)',
  },
  {
    id: 'C4', file: CLI, tests: [TC],
    from: '  if (n < min) throw new UsageError(',
    to: '  if (false) throw new UsageError(',
    why: 'a time bound under a minute is accepted, then quietly raised',
  },
  {
    id: 'C6', file: CLI, tests: [TC],
    from: "      case '--lanes':",
    to: "      case '--max-time': o.maxTimeSec = Number(value()); break;\n      case '--lanes':",
    why: 'an args file written for the old runbook passes --max-time and is read, not refused (ADR-0063 D1, amendment of 2026-10-13)',
    killed_by: [/refuses what it does not know/, /reads an ADR-0059 args file/],
  },
  {
    id: 'C7', file: CLI, tests: [TC],
    from: "      case '--lanes':",
    to: "      case '--oversize-pct': o.oversizePct = Number(value()); break;\n      case '--lanes':",
    why: 'the retired size bound\'s option is read, not refused (ADR-0063 D7, amendment of 2026-10-13)',
    killed_by: /refuses what it does not know/,
  },
  {
    id: 'C8', file: CLI, tests: [TC],
    from: '  if (n > max) throw new UsageError(',
    to: '  if (false) throw new UsageError(',
    why: 'a step timeout past the longest timer the worker host holds is accepted, and its timer fires at once',
    killed_by: /refuses what it does not know/,
  },
];
