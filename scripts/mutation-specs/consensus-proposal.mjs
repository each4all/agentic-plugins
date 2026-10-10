// Mutation spec — do the consensus proposal's tests catch the defects they
// exist for? (ADR-0067 Decision 8, items 1 and 5)
//
// Run: npm run mutate -- scripts/mutation-specs/consensus-proposal.mjs
//
// A conflict ends decide, critique, investigate and orchestrator plan on a
// conflict gate bound to its run, with the contested items written as a
// consensus task file; the proposal of a bounded round is current only while
// the gate names the run, the run is recorded as a conflict and the file
// exists; every way the gate leaves retires the file; and the autopilot's halt
// carries the proposal, display only. Each defect below is quiet: a stale or
// unbound proposal shown, a gate that closes a workflow over a conflict, a
// file that outlives its gate. Each mutation breaks one rule and names the
// test that must notice; every new test is bitten by one of them.
//
// Groups: P the persona state (engineer's generated copy) and its start
// lifecycle, R the persona finalize templates, O the orchestrator state and plan
// runbook, A the autopilot policy, scheduler, previews and observer, D the
// driver end to end (fake claude), C the cutover and its rollback.

const TP = 'tests/persona-pipeline/test-consensus-task.mjs';
const TR = 'tests/persona-pipeline/test-runbook-contracts.mjs';
const TO = 'tests/orchestrator/test-plan-consensus.mjs';
const TA = 'tests/orchestrator/test-autopilot-consensus.mjs';
const TD = 'tests/orchestrator/test-autopilot-driver.mjs';
const TC = 'tests/orchestrator/test-cutover.mjs';
const TOBS = 'tests/orchestrator/test-autopilot-observe.mjs';

const ENG_STATE = 'plugins/engineer/scripts/state.mjs';
const VARIANT = 'persona-pipeline/regions/verb-finalize-consensus.md';
const PLAIN = 'persona-pipeline/regions/verb-finalize.md';
const MANIFEST = 'persona-pipeline/manifest.json';
const ORCH_STATE = 'plugins/orchestrator/scripts/state.mjs';
const PLAN = 'plugins/orchestrator/commands/plan.md';
const ENG_START = 'plugins/engineer/commands/start.md';
const AP = 'plugins/orchestrator/adapters/claude/autopilot';
const POLICY = `${AP}/policy.mjs`;
const DRIVER = `${AP}/driver.mjs`;
const OBSERVE = `${AP}/observe.mjs`;
const SCHED = `${AP}/scheduler.mjs`;
const CLI = `${AP}/cli.mjs`;
const CUTOVER = 'plugins/orchestrator/scripts/lib/cutover.mjs';

const VERDICT_CHECK = "  if (result.verdict !== 'conflict') {\n    throw new Error(\n      `consensus-task: run ${runId} is recorded with verdict";
const LOCK_CHECK = '  if (!(await holdsLock(ownership))) {\n';
const PUBLISH = '  await atomicWrite(paths.file, `${scrubSecrets(text).trim()}\\n`, ownership);\n';
const PRIVATE_DIR = '  await ensureDir(paths.dir, 0o700);\n';
const CLEAR_RETIRE = '    const retired = runId === undefined\n      ? { retired: null, warning: null }\n      : await retireConsensusTask(workflowPath, frontmatter.workflow_id, runId, { lockPath, token });\n';

// The lanes path and the previews (M4, M5, M7 of the CP critique), by the
// test that names each.
const LANES_E2E = /a lane whose step ends on its conflict gate while the run drains keeps its proposal/;
const RETIRED = /a task file retired while the run drains is not reported/;
const SERIAL_PREVIEW = /serial: a child on its conflict gate, in the preview/;
const LANES_MACRO_PREVIEW = /with lanes: a macro on plan-conflict halts the preview plan-unapproved/;
const OBS_MACRO = /a macro on plan-conflict: its run, its recorded conflict and its task file in the orchestrator home/;
const OBS_CHILD = /an engineer child on peer-conflict: its facts in the engineer home/;

export const TESTS = [TP, TR, TO, TA, TOBS, TD, TC];

export const MUTATIONS = [
  // ---- P: the persona state (engineer's generated copy) ---------------------
  {
    id: 'P1', file: ENG_STATE, tests: [TP],
    from: "  'decide-conflict',\n  'peer-conflict',\n  'recurring-finding',",
    to: "  'decide-conflict',\n  'recurring-finding',",
    why: 'peer-conflict is not a gate a workflow file may hold',
    killed_by: /the conflict gates are decide-conflict and peer-conflict/,
  },
  {
    id: 'P2', file: ENG_STATE, tests: [TP],
    from: 'function shellWord(text) {\n',
    to: 'function shellWord(text) {\n  return text;\n',
    why: 'a task file path with a space splits into two words of the proposed command',
    killed_by: /prints the bounded round with the absolute path/,
  },
  {
    id: 'P3', file: ENG_STATE, tests: [TP],
    from: VERDICT_CHECK,
    to: VERDICT_CHECK.replace("if (result.verdict !== 'conflict')", 'if (false)'),
    why: 'a run recorded concerns or failed gets a task file and a proposal',
    killed_by: /consensus-task refuses an unrecorded run, another verdict/,
  },
  {
    id: 'P4', file: ENG_STATE, tests: [TP],
    from: "  order.push('awaiting_owner_run_id');\n",
    to: "  order.splice(order.indexOf('next_step_kind'), 0, 'awaiting_owner_run_id');\n",
    why: 'the run id is not the last key, so an older carrier moves it on every write',
    killed_by: /records a conflict gate with its run id, serialized last/,
  },
  {
    id: 'P5', file: ENG_STATE, tests: [TP],
    from: '  if (ownerGate.runId !== undefined) {\n    if (!CONFLICT_OWNER_GATES.has(ownerGate.gate)) {',
    to: '  if (ownerGate.runId !== undefined) {\n    if (false) {',
    why: 'scope-routing records a run id, and its proposal can become current',
    killed_by: /only a conflict gate records a run id/,
  },
  {
    id: 'P6', file: ENG_STATE, tests: [TP],
    from: "  if (result.verdict !== 'conflict') return not(`run ${runId} is recorded with verdict ${result.verdict}`);\n",
    to: '',
    why: 'a gate naming a run recorded concerns still proposes a round',
    killed_by: /a proposal is current only with the gate, its run id, the recorded conflict and the file/,
  },
  {
    id: 'P7', file: ENG_STATE, tests: [TP], count: 1,
    from: CLEAR_RETIRE,
    to: '    const retired = { retired: null, warning: null };\n',
    why: 'the owner\'s clear leaves the task file live',
    killed_by: /the clear retires the file and records the run/,
  },
  {
    id: 'P8', file: ENG_STATE, tests: [TP],
    from: "  if ('awaiting_owner_run_id' in fm && !isSafeConsensusRunId(fm.awaiting_owner_run_id)) {",
    to: "  if ('awaiting_owner_run_id' in fm && (!isSafeConsensusRunId(fm.awaiting_owner_run_id) || fm.awaiting_owner_gate === undefined)) {",
    why: 'a run id an older script left without its gate makes the workflow unreadable',
    killed_by: /a run id a pre-CP script left without its gate still reads/,
  },
  {
    id: 'P9', file: ENG_STATE, tests: [TP],
    from: '  const proposal = CONFLICT_OWNER_GATES.has(gate.gate) ? await consensusProposal({ workflowPath, host }) : null;',
    to: '  const proposal = null;',
    why: 'the interactive preflight puts the gate to the owner without the proposed round',
    killed_by: /the interactive preflight puts the proposed round to the owner/,
  },
  {
    id: 'P10', file: ENG_STATE, tests: [TP],
    from: "        process.stdout.write(`${result?.verdict ?? ''}\\n`);",
    to: "        process.stdout.write(`${result?.verdict ?? 'none'}\\n`);",
    why: 'no recorded verdict reads as one, so the finalize branch misjudges a run that never launched',
    killed_by: /ensemble-verdict prints the verdict recorded for a run/,
  },
  {
    id: 'P11', file: ENG_STATE, tests: [TP],
    from: PUBLISH,
    to: PUBLISH.replace(', ownership);', ', null);'),
    why: 'a writer whose lock was reclaimed overwrites the new owner\'s task file',
    killed_by: /a writer whose lock was reclaimed neither publishes nor retires a task file/,
  },
  {
    id: 'P12', file: ENG_STATE, tests: [TP],
    from: LOCK_CHECK,
    to: '  if (false) {\n',
    why: 'a writer whose lock was reclaimed retires a file the new owner made current',
    killed_by: /a writer whose lock was reclaimed neither publishes nor retires a task file/,
  },
  {
    id: 'P13', file: ENG_STATE, tests: [TP],
    from: PRIVATE_DIR,
    to: '  await ensureDir(paths.dir);\n',
    why: 'the consensus directory is created readable by others, as the state homes never are',
    killed_by: /the consensus directory is private/,
  },
  {
    id: 'P14', file: ENG_START, tests: [TP],
    from: '--run-id <that run id> --text-file <that file>`',
    to: '--run-id <that run id> --text <that file>`',
    why: 'inside a start lifecycle the contested items go on the command line, where the shell reads them',
    killed_by: /inside a start lifecycle, the consensus-task and awaiting-owner-set commands/,
  },
  {
    id: 'P15', file: ENG_START, tests: [TP],
    from: '`state.mjs consensus-task --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --run-id',
    to: '`state.mjs consensus-task --workflow-path "$ACTIVE" --run-id',
    why: 'a lifecycle on Codex proposes the round in the slash form',
    killed_by: /inside a start lifecycle, the consensus-task and awaiting-owner-set commands/,
  },

  // ---- R: the persona finalize templates (each run renders every persona) ----
  {
    id: 'R1', file: VARIANT, tests: [TR],
    from: 'elif [ "$RECORDED" != conflict ] || [ "$VERDICT" != conflict ]; then\n',
    to: 'elif false; then\n',
    why: 'a conflict recorded by an earlier attempt takes the gate although VERDICT now says concerns',
    killed_by: /a recorded conflict writes the task file, then the conflict gate with the run id/,
  },
  {
    id: 'R2', file: MANIFEST, tests: [TR], count: 2,
    from: '"conflict_gate_word": {\n          "value": "peer-conflict",',
    to: '"conflict_gate_word": {\n          "value": "decide-conflict",',
    why: 'critique and investigate record decide-conflict, whose resolving step is decide\'s',
    killed_by: /the manifest renders it into exactly decide, critique and investigate/,
  },
  {
    id: 'R3', file: VARIANT, tests: [TR],
    from: '    --next-step-confidence "<HIGH|MEDIUM|LOW>" || exit $?\nelif',
    to: '    --next-step-confidence "<HIGH|MEDIUM|LOW>"\nelif',
    why: 'the variant\'s typical last write drifts from the plain one (a failed finish-verb no longer stops the block)',
    killed_by: /verb-finalize-consensus\.md: rebuilt from verb-finalize\.md/,
  },
  {
    id: 'R4', file: PLAIN, tests: [TR],
    from: '# ADR-0066 PC2b — settle the ensemble attempt from its ledger (never launched,\n',
    to: '# runtime:consensus is proposed here too\n# ADR-0066 PC2b — settle the ensemble attempt from its ledger (never launched,\n',
    why: 'compose, frame and refine propose a consensus round',
    killed_by: /the finalize has no conflict branch/,
  },
  {
    id: 'R5', file: VARIANT, tests: [TR],
    from: '    --text-file "$CONTESTED_FILE")" || exit $?\n',
    to: '    --text "$(cat "$CONTESTED_FILE")")" || exit $?\n',
    why: 'the contested items pass through the shell as an argument (a leading -- reads as a flag)',
    killed_by: /a recorded conflict writes the task file, then the conflict gate with the run id/,
  },
  {
    id: 'R6', file: VARIANT, tests: [TR],
    from: '  [ -n "${CONTESTED_FILE:-}" ] || { echo "✗ CONTESTED_FILE names no file of contested items; the gate was not recorded." >&2; exit 1; }\n',
    to: '',
    why: 'a block run with no contested-items file goes on toward the gate',
    killed_by: /a recorded conflict writes the task file, then the conflict gate with the run id/,
  },
  {
    id: 'R7', file: VARIANT, tests: [TR],
    from: 'Set VERDICT to the recorded verdict (and CONTESTED_FILE when that is conflict) and run this block again: its settle does nothing for a recorded run, and the matching branch runs, consensus-task first on a conflict. Nothing more was written.',
    to: 'Set VERDICT to the recorded verdict and run the matching last write by itself; nothing more was written.',
    why: 'the recovery from a recorded conflict sets the gate with no task file',
    killed_by: /a recorded conflict writes the task file, then the conflict gate with the run id/,
  },

  // ---- O: the orchestrator state and the plan runbook ------------------------
  {
    id: 'O1', file: ORCH_STATE, tests: [TO],
    from: "    if (verdict !== 'conflict') {\n      throw new Error('setPlan: a run id goes with the verdict conflict",
    to: "    if (false) {\n      throw new Error('setPlan: a run id goes with the verdict conflict",
    why: 'a run id rides on plan-approval',
    killed_by: /a run id needs the verdict conflict/,
  },
  {
    id: 'O2', file: ORCH_STATE, tests: [TO],
    from: VERDICT_CHECK,
    to: VERDICT_CHECK.replace("if (result.verdict !== 'conflict')", 'if (false)'),
    why: 'a Plan-verify run that passed gets a task file',
    killed_by: /consensus-task writes the file only for a committed conflict/,
  },
  {
    id: 'O3', file: ORCH_STATE, tests: [TO],
    from: '    for (const old of await liveConsensusRuns(workflowPath, frontmatter.workflow_id)) {',
    to: '    for (const old of []) {',
    why: 'a re-plan leaves the previous plan\'s task file live',
    killed_by: /a re-plan retires every task file before it writes/,
  },
  {
    id: 'O4', file: ORCH_STATE, tests: [TO], count: 1,
    from: CLEAR_RETIRE,
    to: '    const retired = { retired: null, warning: null };\n',
    why: 'clearing plan-conflict leaves its task file live',
    killed_by: /the owner's clear and a re-set of the gate retire the file of the run/,
  },
  {
    id: 'O5', file: ORCH_STATE, tests: [TO],
    from: '  if (AWAITING_OWNER_RUN_ID in fm && !isSafeConsensusRunId(fm[AWAITING_OWNER_RUN_ID])) {',
    to: "  if (AWAITING_OWNER_RUN_ID in fm && (!isSafeConsensusRunId(fm[AWAITING_OWNER_RUN_ID]) || fm.awaiting_owner_gate !== 'plan-conflict')) {",
    why: 'a run id an older script left beside plan-approval makes the macro unreadable',
    killed_by: /an orphan run id left by a pre-CP script reads/,
  },
  {
    id: 'O6', file: PLAN, tests: [TO],
    from: '  --verdict "$VERDICT" --run-id "$PLAN_RUN_ID" \\\n',
    to: '  --verdict "$VERDICT" \\\n',
    why: 'plan-conflict records no run, so no proposal is ever current',
    killed_by: /a conflict passes the run id to plan-set/,
  },
  {
    id: 'O7', file: PLAN, tests: [TO],
    from: '    --text-file "$CONTESTED_FILE")" || exit $?\n',
    to: '    --text-file "$CONTESTED_FILE")"\n',
    why: 'a refused task file passes, and an empty proposal is printed',
    killed_by: /an empty set of contested items writes no task file and fails the block/,
  },
  {
    id: 'O8', file: ORCH_STATE, tests: [TO],
    from: PUBLISH,
    to: PUBLISH.replace(', ownership);', ', null);'),
    why: 'a writer whose lock was reclaimed overwrites the new owner\'s task file',
    killed_by: /a writer whose lock was reclaimed neither publishes nor retires a task file/,
  },
  {
    id: 'O9', file: ORCH_STATE, tests: [TO],
    from: LOCK_CHECK,
    to: '  if (false) {\n',
    why: 'a writer whose lock was reclaimed retires a file the new owner made current',
    killed_by: /a writer whose lock was reclaimed neither publishes nor retires a task file/,
  },
  {
    id: 'O10', file: ORCH_STATE, tests: [TO],
    from: PRIVATE_DIR,
    to: '  await ensureDir(paths.dir);\n',
    why: 'the consensus directory is created readable by others',
    killed_by: /the consensus directory is private/,
  },
  {
    id: 'O11', file: PLAN, tests: [TO],
    from: '  [ -n "${CONTESTED_FILE:-}" ] || { echo "✗ CONTESTED_FILE names no file of contested items; no task file was written." >&2; exit 1; }\n',
    to: '',
    why: 'a block run with no contested-items file fails with no word of what is missing',
    killed_by: /an empty set of contested items writes no task file and fails the block/,
  },

  // ---- A: the autopilot policy -----------------------------------------------
  {
    id: 'A1', file: POLICY, tests: [TA],
    from: "  'scope-routing', 'decide-conflict', 'peer-conflict', 'recurring-finding', 'staging-set', 'pr-handling',",
    to: "  'scope-routing', 'decide-conflict', 'recurring-finding', 'staging-set', 'pr-handling',",
    why: 'the driver halts owner-choice on an unknown gate instead of awaiting-owner:peer-conflict',
    killed_by: /peer-conflict is an engineer gate the driver reads/,
  },
  {
    id: 'A2', file: POLICY, tests: [TA],
    from: '  if (!Array.isArray(runs) || !runs.includes(runId)) return null;\n',
    to: '',
    why: 'a gate naming a run not recorded as a conflict proposes a round',
    killed_by: /no proposal unless the task file is current/,
  },
  {
    id: 'A3', file: POLICY, tests: [TA],
    from: 'const pathWord = (p) => (',
    to: 'const pathWord = (p) => p || (',
    why: 'a task file path with a space splits the printed command',
    killed_by: /a path that needs quoting is one shell word/,
  },
  {
    id: 'A4', file: POLICY, tests: [TA],
    from: "    && m && !m.archived && m.fm?.awaiting_owner_gate === 'plan-conflict') {",
    to: '    && m && !m.archived) {',
    why: 'plan-approval proposes a consensus round from a stale file',
    killed_by: /plan-approval and an approved plan carry none/,
  },
  {
    id: 'A5', file: POLICY, tests: [TA],
    from: '    laneHalts: d.laneHalts.map((h) => withProposals(h, view)),\n',
    to: '    laneHalts: d.laneHalts,\n',
    why: 'with lanes, a lane\'s conflict halt carries no proposal',
    killed_by: /with lanes, the lane halt on the gate carries the round/,
  },
  {
    id: 'A6', file: POLICY, tests: [TA],
    from: '    if (p?.pointer) lines.push(`    pointer: ${p.pointer}`);\n',
    to: '',
    why: 'the report names no task file to read before running the round',
    killed_by: /proposalLines words the proposal for the owner/,
  },
  {
    id: 'A7', file: POLICY, tests: [TA],
    from: "    pointer: typeof task.relPath === 'string' ? task.relPath : task.path,",
    to: '    pointer: task.path,',
    why: 'the pointer is spelled absolute, not from the state root (Decision 1(c))',
    killed_by: /a child on peer-conflict with a current task file/,
  },
  // ---- the scheduler's end (M4, M7a) -----------------------------------------
  {
    id: 'A8', file: POLICY, tests: [TA],
    from: '  const current = (ps) => (fresh?.lookError ? [] : currentProposals(fresh, ps));\n',
    to: '  const current = (ps) => ps;\n',
    why: 'the run\'s end does not judge again: a task file retired while the run drains still has its round reported (M4)',
    killed_by: RETIRED,
  },
  {
    id: 'A9', file: SCHED, tests: [TA],
    from: '      if (proposals.length) lane(id).proposals = proposals;\n',
    to: '',
    why: 'a lane whose in-flight step ends on its conflict gate during the drain has no halt, and its round is lost (M7a)',
    killed_by: LANES_E2E,
  },
  {
    id: 'A10', file: SCHED, tests: [TA],
    from: '      if (hh.proposals?.length) lane(hh.subtaskId).proposals = hh.proposals;\n',
    to: '',
    why: 'a second lane halted on its gate (kept in also) loses its round',
    killed_by: LANES_E2E,
  },
  {
    id: 'A11', file: POLICY, tests: [TA],
    from: '  return list.filter((p) => !seen.has(p.command) && seen.add(p.command));\n',
    to: '  return list;\n',
    why: 'the run\'s halt and its lane report the same round twice',
    killed_by: LANES_E2E,
  },

  // ---- the preview (M5) -------------------------------------------------------
  {
    id: 'A12', file: CLI, tests: [TA],
    from: '    proposals: decision?.proposals ?? lanesPreview?.proposals ?? [],\n',
    to: '    proposals: decision?.proposals ?? lanesPreview?.halt?.proposals ?? [],\n',
    why: 'the lanes preview\'s JSON carries the first lane halt\'s round only (M5)',
    killed_by: LANES_E2E,
  },
  {
    id: 'A13', file: CLI, tests: [TA],
    from: '  for (const line of haltProposalLines(lp.proposals)) out(line);\n',
    to: '',
    why: 'the lanes preview prints no round (M5)',
    killed_by: [LANES_E2E, LANES_MACRO_PREVIEW],
  },
  {
    id: 'A14', file: CLI, tests: [TA],
    from: '    result.proposals = d.proposals ?? [];\n',
    to: '',
    why: 'a run-wide halt of the lanes preview (the macro on plan-conflict) carries no round',
    killed_by: LANES_MACRO_PREVIEW,
  },
  {
    id: 'A15', file: CLI, tests: [TA],
    from: '    proposals: decision?.proposals ?? lanesPreview?.proposals ?? [],\n',
    to: '    proposals: lanesPreview?.proposals ?? [],\n',
    why: 'the serial preview\'s JSON carries no round (M5)',
    killed_by: SERIAL_PREVIEW,
  },

  // ---- the observer (M7b) -----------------------------------------------------
  {
    id: 'A16', file: OBSERVE, tests: [TOBS],
    from: '    consensus: consensusFacts(fm, located.file, stateRoots.scan),\n',
    to: '    consensus: null,\n',
    why: 'the macro\'s facts are never read, so plan-conflict never proposes its round (M7b)',
    killed_by: OBS_MACRO,
  },
  {
    id: 'A17', file: OBSERVE, tests: [TOBS],
    from: '    consensus: consensusFacts(fm, file, roots),\n',
    to: '    consensus: null,\n',
    why: 'a child\'s facts are never read, so its conflict gate never proposes its round',
    killed_by: OBS_CHILD,
  },
  {
    id: 'A18', file: OBSERVE, tests: [TOBS],
    from: "    const p = path.join(path.dirname(dir), 'consensus', `${fm.workflow_id}.${runId}.md`);\n",
    to: "    const p = path.join(dir, 'consensus', `${fm.workflow_id}.${runId}.md`);\n",
    why: 'the task file is looked for in the wrong home (under workflows/), so a current file is never found (M7b)',
    killed_by: [OBS_MACRO, OBS_CHILD],
  },

  // ---- the policy (minor findings) --------------------------------------------
  {
    id: 'A19', file: POLICY, tests: [TA],
    from: "  if (d?.outcome !== 'halt') return [];\n",
    to: '',
    why: 'a step, not a halt, is given a proposal',
    killed_by: /consensusProposals reads only halts/,
  },
  {
    id: 'A20', file: POLICY, tests: [TA],
    from: "    const what = p?.gate ? ` for ${p.subtask_id ? `subtask ${p.subtask_id}` : 'the macro'} (${p.gate})` : '';\n",
    to: "    const what = '';\n",
    why: 'the printed round names no subtask or gate, so a run with lanes cannot tell whose it is (M4)',
    killed_by: /proposalLines words the proposal for the owner, naming its subtask or the macro/,
  },
  {
    id: 'A21', file: POLICY, tests: [TA],
    from: '    subtask_id: subtaskId,\n    gate,\n',
    to: '',
    why: 'the halt record\'s entry has no subtask_id or gate (M4)',
    killed_by: /a child on peer-conflict with a current task file/,
  },

  {
    id: 'A22', file: POLICY, tests: [TA],
    from: '  const held = [...(d?.proposals ?? []), ...lanes.flatMap((l) => l.proposals ?? [])];\n',
    to: '  const held = d ? [...(d?.proposals ?? []), ...lanes.flatMap((l) => l.proposals ?? [])] : [];\n',
    why: 'a run that completes keeps a lane\'s proposal whose gate was cleared, or whose task file was retired, while it went on',
    killed_by: /proposalsAtEnd judges every proposal a run met again as it ends, whether it halts or completes/,
  },

  // ---- D: the driver end to end ----------------------------------------------
  {
    id: 'D1', file: DRIVER, tests: [TD],
    from: '    proposals: d.proposals ?? [],\n',
    to: '    proposals: [],\n',
    why: 'halt.json drops the proposal the policy built',
    killed_by: /the halt record and report carry the bounded consensus round/,
  },
  {
    id: 'D2', file: OBSERVE, tests: [TD],
    from: '    try { exists = fs.statSync(p).isFile(); } catch { exists = false; }',
    to: '    exists = true;',
    why: 'a gate whose task file is missing proposes a round on a file that is not there',
    killed_by: /a conflict gate whose task file is missing halts on it with no proposal/,
  },

  // ---- C: the cutover --------------------------------------------------------
  {
    id: 'C1', file: CUTOVER, tests: [TC],
    from: '    for (const name of consensusFilesOf(source, record.workflow_id)) {\n      addPair({',
    to: '    for (const name of []) {\n      addPair({',
    why: 'a moved workflow strands its consensus task files in the old home',
    killed_by: /a moving record takes its consensus task files, live and retired, with it/,
  },
  {
    id: 'C2', file: CUTOVER, tests: [TC],
    from: '    for (const name of consensusFilesOf(from, record.workflow_id)) {\n      pairs.push({',
    to: '    for (const name of []) {\n      pairs.push({',
    why: 'a rollback strands a record\'s consensus task files in the default state root',
    killed_by: /sends a moved record's consensus task files, live and retired, back with it/,
  },
];
