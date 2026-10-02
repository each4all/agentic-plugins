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
const LEDGER = `${AP}/ledger.mjs`;
const OBSERVE = `${AP}/observe.mjs`;
const DRIVER = `${AP}/driver.mjs`;
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
    from: "    if (ns.confidence !== 'HIGH') {",
    to: '    if (false) {',
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
    from: '      if (waitingOn.length) return nope(',
    to: '      if (false) return nope(',
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
    from: '  if (fingerprint(before) === fingerprint(after)) {',
    to: '  if (false) {',
    why: 'a step that changed nothing runs again and again',
  },

  // ---- W: the worker host -----------------------------------------------------
  {
    id: 'W1', file: WORKER, tests: [TW],
    from: '    if (st.results.length > 0 && st.pending === 0 && !st.awaitingFollowUp) {',
    to: '    if (st.results.length > 0 && !st.awaitingFollowUp) {',
    why: 'stdin closes while a background task (a peer) is still running, which kills it (probe D)',
  },
  {
    id: 'W2', file: WORKER, tests: [TW],
    from: '    if (st.results.length > 0 && st.pending === 0 && !st.awaitingFollowUp) {',
    to: '    if (st.results.length > 0 && st.pending === 0) {',
    why: 'stdin closes before the turn a finished background task triggers (probe D2)',
  },
  {
    id: 'W3', file: WORKER, tests: [TW],
    from: '      if (!ev.parent_tool_use_id) {',
    to: '      if (true) {',
    why: 'a subagent\'s context counts as the step\'s and trips step-oversized',
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
    from: "        : await (o.terminateGroup ?? terminateGroup)(child.pid, { signalled: st.aborted !== null, signalledAt: st.abortedAt ?? Date.now() });",
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
    from: "    setTimeout(() => { if (st.exit === null) killGroup('SIGKILL'); }, KILL_GRACE_MS).unref?.();",
    to: '',
    why: 'a worker that ignores SIGTERM never exits, so its step never ends',
  },
  {
    id: 'W15', file: WORKER, tests: [TW],
    from: '{ signalled: st.aborted !== null, signalledAt:',
    to: '{ signalled: true, signalledAt:',
    why: 'what a step that ended normally left in its group gets no SIGTERM, only a SIGKILL after the grace',
  },
  {
    id: 'W13', file: WORKER, tests: [TW],
    from: '  return { sessionId, pid: child.pid, begin, abort, done };',
    to: '  begin();\n  return { sessionId, pid: child.pid, begin, abort, done };',
    why: 'a worker gets its prompt before the driver has recorded it',
  },

  // ---- L: the ledger and locks --------------------------------------------------
  {
    id: 'L1', file: LEDGER, tests: [TL],
    from: "    const rival = after.find((e) => e.state !== 'gone');",
    to: '    const rival = undefined;',
    why: 'contenders that added their entries at the same time all take the lock',
  },
  {
    id: 'L2', file: LEDGER, tests: [TL],
    from: "  if (worker === 'live') return true;",
    to: "  if (false) return true;",
    why: 'a dead driver\'s lock is reclaimed while its worker still runs',
  },
  {
    id: 'L3', file: LEDGER, tests: [TL],
    from: '    unlinkQuiet(mine);\n    if (attempt === attempts)',
    to: '    if (attempt === attempts)',
    why: 'a contender that backs off leaves its entry, so every later run is refused',
  },
  {
    id: 'L4', file: LEDGER, tests: [TL],
    from: "  if (!current || current.kind === 'none') return 'live';",
    to: "  if (!current || current.kind === 'none') return 'dead';",
    why: 'a fingerprint that cannot be read counts as stale, so a live run\'s lock is taken',
  },
  {
    id: 'L5', file: LEDGER, tests: [TL],
    from: "    if (before.some((e) => e.state === 'busy')) { await pause(100); continue; }",
    to: '',
    why: 'an entry that cannot be read yet is reported as a live holder instead of waited for',
  },
  {
    id: 'L6', file: LEDGER, tests: [TL],
    from: '    if (m && !(await isProcessAlive(Number(m[1])))) unlinkQuiet(path.join(lock, n));',
    to: '    if (m) unlinkQuiet(path.join(lock, n));',
    why: 'a live participant\'s half-written entry is removed under it',
  },
  {
    id: 'L7', file: LEDGER, tests: [TL],
    from: "  if (e.holder === null) return now() - e.mtimeMs < FRESH_UNPARSED_MS ? 'busy' : 'gone';",
    to: "  if (e.holder === null) return 'gone';",
    why: 'an entry that does not parse is removed however fresh it is',
  },
  {
    id: 'L8', file: LEDGER, tests: [TL],
    from: "    for (let rereads = 0; state === 'gone'; rereads += 1) {",
    to: '    for (let rereads = 0; false; rereads += 1) {',
    why: 'an entry judged on a record its owner has since rewritten — recording a live worker, then dying — is removed, and a second run starts beside that worker (round 4)',
  },
  {
    id: 'L10', file: LEDGER, tests: [TL],
    from: "  if (worker === 'other' && holder.worker?.pgid === holder.worker?.pid) return false;",
    to: '',
    why: 'a group that reused the worker\'s id keeps a dead run\'s lock held until that unrelated group ends (round 5)',
  },
  {
    id: 'L11', file: LEDGER, tests: [TL],
    from: "  return startDiffers(recorded, current) ? 'other' : 'live';",
    to: "  return 'other';",
    why: 'a worker whose command line changed with an exec in place counts as a reused pid, and its live run\'s lock is taken (round 6)',
  },
  {
    id: 'L12', file: LEDGER, tests: [TL],
    from: "  return Boolean(current && current.kind !== 'none' && fingerprintsMatch(recorded, current));",
    to: "  return Boolean(current && current.kind !== 'none' && !startDiffers(recorded, current));",
    why: 'stop signals a pid whose start time matches but whose command does not — proof weakened to what only keeps a lock held (round 7)',
  },
  {
    id: 'L9', file: LEDGER, tests: [TL, TD],
    from: '  return groupAlive(holder.worker?.pgid);',
    to: '  return false;',
    why: 'a lock whose worker\'s group outlived SIGKILL is reclaimed while that group still has members (round 4)',
  },

  // ---- O: the observer ------------------------------------------------------------
  {
    id: 'O1', file: OBSERVE, tests: [TO],
    from: '  const child = summarizeChild(archived.fm, \'archived\', archived.file, repoRoot);\n  const wrong = linkageProblems(child, { macroId, subtask });',
    to: '  const child = summarizeChild(archived.fm, \'archived\', archived.file, repoRoot);\n  const wrong = [];',
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
    id: 'D4', file: DRIVER, tests: [TD],
    from: '      const cost = w.costUsd ?? stepBudgetUsd;',
    to: '      const cost = w.costUsd ?? 0;',
    why: 'a killed step costs nothing, so the run cap is never reached',
  },
  {
    id: 'D5', file: DRIVER, tests: [TD],
    from: '        const drift = driftOf(pinned, await resolveRoots({ env }));',
    to: '        const drift = [];',
    why: 'an install that changed mid-run is used without notice',
  },
  {
    id: 'D6', file: DRIVER, tests: [TD],
    from: '        cancelled = cancelPeerRuns(newPendingRuns(before, view), { roots, repoRoot, env });',
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
    to: "      if (seq > options.maxSteps) return finish('halted', { reason: 'budget', detail: 'cap' });\n      const d = decide(view, ctx);\n      if (d.outcome === 'completed') {",
    why: 'completion on the last step the cap allowed is reported as a budget halt',
  },
  {
    id: 'D9', file: DRIVER, tests: [TD],
    from: '  for (const c of view?.claims ?? []) for (const id of c?.pending_runs ?? []) ids.add(id);',
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
    from: '    view = observe({ repoRoot, roots, macroId, fetch: true, env });\n    if ((view.macro?.id ?? null) !== macroId) {',
    to: '    if ((view.macro?.id ?? null) !== macroId) {',
    why: 'the first step is decided from a look taken before the locks, so a halt another run set in between is stepped past (round 6)',
  },
  {
    id: 'D15', file: DRIVER, tests: [TD],
    prepare(copy) {
      // Take the second look before the locks instead of after them.
      const file = join(copy, DRIVER);
      const t = readFileSync(file, 'utf8');
      const look = '    view = observe({ repoRoot, roots, macroId, fetch: true, env });\n';
      const locks = '    const record = { run_id: runId, repo: repoRoot, macro_id: macroId, started_at: run.started_at };\n';
      if (t.split(look).length !== 2 || t.split(locks).length !== 2) throw new Error('D15: anchors moved');
      writeFileSync(file, t.replace(look, '').replace(locks, `${look}${locks}`));
    },
    why: 'the look the first step is decided from is taken before the locks, so a halt set before the locks were held is stepped past (round 7)',
  },
  {
    id: 'D11', file: DRIVER, tests: [TD],
    from: "      if (Number.isInteger(current.pid)) setWorker({ pid: current.pid, pgid: process.platform === 'win32' ? null : current.pid, fingerprint: await fingerprintForPid(current.pid), session_id: sessionId });\n      current.begin();",
    to: '      current.begin();',
    why: 'a driver that dies after the spawn leaves a working worker no lock records',
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
    from: '  if (await provablySame(holder.pid, holder.fingerprint)) {',
    to: '  if (await holderAlive({ pid: holder.pid, fingerprint: holder.fingerprint })) {',
    why: 'stop signals a pid it cannot prove is the run\'s process (round 2: a reused pid)',
  },
  {
    id: 'C5', file: CLI, tests: [TC],
    from: '    const outcome = await terminateGroup(holder.worker.pid);',
    to: "    try { process.kill(-holder.worker.pid, 'SIGTERM'); } catch { /* gone */ }\n    const outcome = 'terminated';",
    why: 'stop reports an orphaned worker stopped while a member of its group that ignores SIGTERM runs on (round 3)',
  },
  {
    id: 'C4', file: CLI, tests: [TC],
    from: '  if (n < min) throw new UsageError(',
    to: '  if (false) throw new UsageError(',
    why: 'a time bound under a minute is accepted, then quietly raised',
  },
];
