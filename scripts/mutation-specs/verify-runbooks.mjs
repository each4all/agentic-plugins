// Mutation spec — do the verify-runbooks tests catch the defects they exist
// for? (ADR-0068 Decision 5, item 1: the runbooks hand long checks to the
// driver's verification step and read the results when they resume.)
//
// Run: npm run mutate -- scripts/mutation-specs/verify-runbooks.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. The runbook half is text an LLM step follows
// and blocks it runs: a check that no longer stops the block, a branch that no
// longer takes the request, a resume that no longer reads the results, or a
// rule that again sends long checks to a background task all leave a green
// suite and a step that waits for hours, or writes half a handoff. Each
// mutation below breaks one guarantee and names the test that must notice.
//
// Groups: K the check before the first write (state.mjs verify-request-check),
// F the finalize's verify form, R the results on resume and the tree digest
// they are judged against, G the long-check guidance, W the worker's rules.
// The runbook mutations edit engineer's committed runbooks and skills, which
// the tests read; the template they come from is held to them by the
// persona-pipeline drift check.

const T_REC = 'tests/persona-pipeline/test-verify-record.mjs';
const T_VR = 'tests/persona-pipeline/test-verify-runbooks.mjs';
const T_WORK = 'tests/orchestrator/test-autopilot-worker.mjs';

const STATE = 'plugins/engineer/scripts/state.mjs';
const ENG = 'plugins/engineer';
const WORKER = 'plugins/orchestrator/adapters/claude/autopilot/worker.mjs';

export const TESTS = [T_REC, T_VR, T_WORK];

export const MUTATIONS = [
  // ---- K: the check before the first write ---------------------------------
  {
    id: 'K1', file: STATE, tests: [T_REC],
    from: '  const { id } = bindVerifyRequest(frontmatter, { workflowPath, parsed, env, host, cwd, settling });\n  return { ok: true, request_id: id };\n',
    to: '  return { ok: true, request_id: null };\n',
    why: 'the check accepts what the last write refuses, so the finalize settles and appends before finish-verb refuses: half a handoff',
    killed_by: /each refusal of finish-verb, with the same message/,
  },
  {
    id: 'K2', file: STATE, tests: [T_REC],
    from: "    .filter((e) => settling === null || settling === '' || e?.run_id !== settling);\n",
    to: '    .filter(() => true);\n',
    why: 'the run the finalize settles first is counted as pending, so every verify form with a peer run stops the block',
    killed_by: /the run being settled is not counted/,
  },
  {
    id: 'K3', file: STATE, tests: [T_REC],
    from: "    .filter((e) => settling === null || settling === '' || e?.run_id !== settling);\n",
    to: "    .filter((e) => settling === null || settling === '');\n",
    why: 'naming any run sets every pending run aside, so a run the finalize does not settle is hidden from the check',
    killed_by: /the run being settled is not counted/,
  },
  {
    id: 'K5', file: STATE, tests: [T_REC],
    from: "  if (scalarBytes('verify_request', request) > MAX_REQUEST_BYTES) {\n",
    to: '  if (false) {\n',
    why: 'a request over the byte cap passes the check and the write: the record grows past what every reader budgets for',
    killed_by: /a request over the byte cap: the check refuses it with finish-verb's message/,
  },
  {
    id: 'K6', file: STATE, tests: [T_REC],
    from: '  validateStoredRequest(request, { verbs: VALID_VERBS });\n  return { bound, id, request };\n',
    to: '  return { bound, id, request };\n',
    why: 'the check no longer holds the record to its reader, so a request the record refuses (a check with args null) passes it: settle and the note land, then finish-verb refuses',
    killed_by: /each refusal of finish-verb, with the same message/,
  },
  {
    id: 'K7', file: STATE, tests: [T_VR],
    from: "    const offer = surface === 'verb' ? verifyOffer({ env, host, cwd }) : null;\n",
    to: '    const offer = null;\n',
    why: 'the preflight banner no longer says whether the run offers verification, so a step cannot tell which branch of the long-check guidance applies',
    killed_by: /Phase 0: the preflight banner says whether the run offers verification/,
  },
  {
    id: 'K4', file: `${ENG}/commands/compose.md`, tests: [T_VR],
    from: '    --settling-run-id "$RUN_ID" > /dev/null \\\n    || { echo "✗ The last write would refuse',
    to: '    --settling-run-id "$RUN_ID" > /dev/null \\\n    || true || { echo "✗ The last write would refuse',
    why: 'a refused request no longer stops the block: settle and the note land, then finish-verb refuses',
    killed_by: /compose: no offer, a request the last write would refuse, or a conflict verdict stops the block before any write/,
  },

  // ---- F: the finalize's verify form ---------------------------------------
  {
    id: 'F1', file: `${ENG}/commands/compose.md`, tests: [T_VR],
    from: 'if [ -z "$VERIFY_FORM" ]; then\n',
    to: 'if true; then\n',
    why: 'a checked request is dropped and the verb form is written: the long checks are never run',
    killed_by: /compose: a request under an offering run ends with next step verify/,
  },
  {
    id: 'F2', file: `${ENG}/commands/compose.md`, tests: [T_VR],
    from: '    --operation-dir "$OP_DIR" \\\n    --next-action-file "$TEXT_DIR/next-action.txt" \\\n    --next-step-kind verify',
    to: '    --next-action-file "$TEXT_DIR/next-action.txt" \\\n    --next-step-kind verify',
    why: 'the verify form leaves the persona operation Phase 0 opened, so the lane stays held by a step that ended',
    killed_by: /compose: a request under an offering run ends with next step verify, the request, the operation closed/,
  },
  {
    id: 'F3', file: `${ENG}/commands/compose.md`, tests: [T_VR],
    from: '  3) echo "✗ finalize-verify.json in TEXT_DIR',
    to: '  3) ;; 9) echo "✗ finalize-verify.json in TEXT_DIR',
    why: 'run again, the block takes another form or another request than its first run did',
    killed_by: /run again with the same TEXT_DIR: the request removed, changed or added since stops the block before any write/,
  },
  {
    id: 'F4', file: `${ENG}/commands/critique.md`, tests: [T_VR],
    from: '  [ "$VERDICT" != conflict ] || { echo "✗ verify-request.json is in TEXT_DIR',
    to: '  true || { echo "✗ verify-request.json is in TEXT_DIR',
    why: 'a conflict verdict takes a request, so a verb that must end on its conflict gate may hand off to the driver',
    killed_by: /critique: a conflict verdict for a real completed peer run, with a request beside it, stops the block before settle/,
  },
  {
    id: 'F5', file: `${ENG}/commands/refine.md`, tests: [T_VR],
    from: '  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" verify-request-check \\\n',
    to: '  true "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" verify-request-check \\\n',
    why: 'refine\'s check never runs (its text still reads as the check), so a refused request settles and appends before finish-verb refuses',
    killed_by: /refine: no offer, a request the last write would refuse, or a conflict verdict stops the block before any write/,
  },
  {
    id: 'F6', file: `${ENG}/commands/compose.md`, tests: [T_VR],
    from: '    --request-file "$VERIFY_FILE" --next-step-confidence "$CONFIDENCE" \\\n    --settling-run-id "$RUN_ID" > /dev/null \\\n',
    to: '    --request-file "$VERIFY_FILE" --next-step-confidence "$CONFIDENCE" \\\n    > /dev/null \\\n',
    why: 'the check counts the peer run the block settles first as pending, so every verify form after a peer run (Plan-verify, Review, Refine-verify) stops the block',
    killed_by: /compose: a real completed peer run with a non-conflict verdict and a request: settled, then the verify form records the request/,
  },
  {
    id: 'F7', file: `${ENG}/commands/refine.md`, tests: [T_VR],
    from: "[ -n \"$OWNER_GATE\" ] || ! grep -Eq '^ {0,3}###[[:blank:]]+(Recurring finding|Routing recommendation|Outward action needed)([[:space:]]|$)' \"$TEXT_DIR/note.md\" 2>/dev/null \\\n",
    to: 'true || ! false \\\n',
    why: 'an owner gate\'s note with OWNER_GATE empty is taken: a request beside it hides the gate behind next step verify, and the driver runs on_pass past the owner\'s judgment',
    killed_by: /refine: an owner gate \(OWNER_GATE, or its note's heading\) beside a request stops the block before any write/,
  },
  {
    id: 'F9', file: `${ENG}/commands/compose.md`, tests: [T_VR],
    from: 'if [ -n "$OWNER_GATE" ]; then\n',
    to: 'if false; then\n',
    why: 'a named gate selects nothing: the verb form closes the step past the owner\'s judgment, and the gate is never recorded',
    killed_by: /compose: OWNER_GATE makes the last write the owner-decision form/,
  },
  {
    id: 'F10', file: `${ENG}/commands/critique.md`, tests: [T_VR],
    from: '  if [ -n "$OWNER_GATE" ]; then\n',
    to: '  if false; then\n',
    why: 'the consensus finalize drops a named gate and writes the verb form',
    killed_by: /critique: OWNER_GATE makes the last write the owner-decision form/,
  },
  {
    id: 'F11', file: `${ENG}/commands/decide.md`, tests: [T_VR],
    from: "  decide-conflict) [ 'decide' != decide ] || OWNER_GATE_ANCHOR=ensemble-synthesis ;;\n",
    to: '  decide-conflict) OWNER_GATE_ANCHOR=decide-conflict ;;\n',
    why: 'decide\'s owner selection points its gate at a section the note does not have, so the owner is shown nothing',
    killed_by: /decide: OWNER_GATE makes the last write the owner-decision form with the gate's anchor/,
  },
  {
    id: 'F12', file: `${ENG}/commands/compose.md`, tests: [T_VR],
    from: "  recurring-finding) [ 'compose' != refine ] || OWNER_GATE_ANCHOR=recurring-finding ;;\n",
    to: '  recurring-finding) OWNER_GATE_ANCHOR=recurring-finding ;;\n',
    why: 'compose ends on refine\'s recurring-finding gate, which only refine\'s Owner decision step resolves',
    killed_by: /compose: OWNER_GATE makes the last write the owner-decision form[^\n]*a gate the verb does not end on/,
  },
  {
    id: 'F13', file: `${ENG}/commands/critique.md`, tests: [T_VR],
    from: '[ -z "$OWNER_GATE" ] || [ "$VERDICT" != conflict ] \\\n',
    to: 'true || [ "$VERDICT" != conflict ] \\\n',
    why: 'a named gate beside VERDICT conflict passes the checks: settle records the conflict, then the conflict branch sets its own gate and the named one is dropped',
    killed_by: /critique: OWNER_GATE makes the last write the owner-decision form/,
  },
  {
    id: 'F8', file: `${ENG}/commands/decide.md`, tests: [T_VR],
    from: '  [ -z "$OWNER_GATE" ] || { echo "✗ verify-request.json is in TEXT_DIR',
    to: '  true || { echo "✗ verify-request.json is in TEXT_DIR',
    why: 'decide\'s owner selection or veto (decide-conflict, under its ordinary synthesis heading) takes a request: next step verify hides the gate, and the driver runs on_pass past the owner\'s selection',
    killed_by: /decide: an owner gate \(OWNER_GATE, or its note's heading\) beside a request stops the block before any write/,
  },

  {
    id: 'F14', file: `${ENG}/commands/compose.md`, tests: [T_VR],
    from: '  [ "$VERDICT" != conflict ] || { echo "✗ verify-request.json is in TEXT_DIR',
    to: '  true || { echo "✗ verify-request.json is in TEXT_DIR',
    why: 'the plain template takes a request beside VERDICT conflict: next step verify hides the conflict, and the driver runs on_pass past it',
    killed_by: /compose: no offer, a request the last write would refuse, or a conflict verdict stops the block before any write/,
  },
  {
    id: 'F15', file: `${ENG}/commands/compose.md`, tests: [T_VR],
    from: '  scope-routing) OWNER_GATE_ANCHOR=routing-recommendation ;;\n',
    to: '  scope-routing) OWNER_GATE_ANCHOR=pr-handling ;;\n',
    why: 'scope-routing points its gate at the outward-action section, not the routing recommendation the note holds, so the owner is shown the wrong judgment',
    killed_by: /compose: OWNER_GATE makes the last write the owner-decision form with the gate's anchor/,
  },
  {
    id: 'F16', file: `${ENG}/commands/compose.md`, tests: [T_VR],
    from: "grep -Eq '^ {0,3}###[[:blank:]]+(Recurring finding|",
    to: "grep -Eq '^### (Recurring finding|",
    why: 'a gate heading indented by one to three spaces, or with more than one space or a tab after its ### (still a Markdown heading), with OWNER_GATE empty passes, and the verb form closes the step past the owner\'s judgment',
    killed_by: /compose: OWNER_GATE makes the last write the owner-decision form[^\n]*a gate's heading with OWNER_GATE empty/,
  },
  {
    // The form kept before the text checks, as it was: a refused run keeps
    // the verb form, and a rerun that adds a request is refused.
    id: 'F17', file: `${ENG}/commands/compose.md`, tests: [T_VR],
    from: 'for TEXT_FILE in note.md summary.txt next-action.txt; do\n',
    to: 'node -e \'const f=process.argv[1],fs=require("fs");fs.existsSync(f)||fs.writeFileSync(f,JSON.stringify({request_sha256:null})+"\\n")\' "$TEXT_DIR/finalize-verify.json"\nfor TEXT_FILE in note.md summary.txt next-action.txt; do\n',
    why: 'the form is kept before the text checks, so a run they stop fixes the verb form and a rerun that adds a request needs a fresh TEXT_DIR',
    killed_by: /compose: a run a check before settle stops keeps no form/,
  },
  // ---- R: the results on resume and the tree they apply to -----------------
  {
    id: 'R1', file: `${ENG}/commands/critique.md`, tests: [T_VR],
    from: '  --workflow-path "$ACTIVE" --current-tree true --format text \\\n',
    to: '  --workflow-path "$ACTIVE" --format text \\\n',
    why: 'the resume no longer says whether a result applies to the tree now, so a pass on an older tree reads as current',
    killed_by: /a passed batch: on_pass critique reads the results as applying; once the tree changed, as not applying/,
  },
  {
    id: 'R2', file: `${ENG}/commands/refine.md`, tests: [T_VR],
    from: '  || echo "⚠ The verification results could not be read (the error is above); ${VERB} goes on without them." >&2\n',
    to: '  || exit $?\n',
    why: 'a results record the verb cannot read stops the verb\'s Phase 0, where it should only warn',
    killed_by: /a results record a later release wrote: a warning, and the verb goes on/,
  },
  {
    id: 'R3', file: STATE, tests: [T_VR],
    from: "      for (let i = 0; i < hidden.length; i += 500) git(root, ['update-index', flag, '--', ...hidden.slice(i, i + 500)], withIndex);\n",
    to: '',
    why: 'the persona\'s digest misses an edit to an assume-unchanged or skip-worktree file, which the driver\'s sees: applies no longer means what the driver tested',
    killed_by: /digest alike; each change moves it/,
  },
  {
    id: 'R4', file: STATE, tests: [T_VR],
    from: "    git(root, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', LANE_WORKTREE_LOCK_REL], withIndex);\n",
    to: '',
    why: 'the driver\'s lock fence moves the persona\'s digest and not the driver\'s',
    killed_by: /digest alike; each change moves it/,
  },
  {
    id: 'R5', file: STATE, tests: [T_VR],
    from: '      if (r && r.failing_tests.length > 0) {\n',
    to: '      if (false) {\n',
    why: 'the resumed verb never sees which tests failed, the evidence it works from',
    killed_by: /a failed batch: the resumed verb \(compose\) reads the failing test/,
  },

  {
    id: 'R6', file: STATE, tests: [T_VR],
    from: "  const added = last ? last.checks.filter((c) => c.origin === 'driver').length : 0;\n",
    to: '  const added = 0;\n',
    why: 'the header counts the request\'s checks while the rows list the batch\'s, the driver\'s additions among them',
    killed_by: /the header counts the checks requested and those the driver added apart/,
  },
  {
    id: 'R7', file: STATE, tests: [T_VR],
    from: "        lines.push(typeof r.log === 'string' && r.log !== ''\n",
    to: '        lines.push(true\n',
    why: 'a result that kept no log prints a log path ending /null',
    killed_by: /a result with no log says so/,
  },
  {
    id: 'R8', file: STATE, tests: [T_VR],
    from: "        if ('current-tree' in flags && flags['current-tree'] !== 'true' && flags['current-tree'] !== 'false') throw new Error('--current-tree is true or false');\n",
    to: '',
    why: '--current-tree yes, 1 or TRUE is silently read as false, and the results are read against no tree',
    killed_by: /verify-results reads --current-tree as true or false/,
  },
  // ---- G: the long-check guidance ------------------------------------------
  {
    id: 'G1', file: `${ENG}/core/skills/refine/SKILL.md`, tests: [T_VR],
    from: '1. Run the relevant tests (if available) and confirm green: the\n   quick ones in the step, the long ones as the long-check guidance\n   below says.\n',
    to: '1. Run the relevant test suite (if available) and confirm green.\n',
    why: 'the skill again tells the step to run the suite itself, which /engineer:start follows under any run',
    killed_by: /engineer\/core\/skills\/refine\/SKILL\.md: carries the guidance, and no instruction to run the suite bypasses it/,
  },
  {
    id: 'G2', file: `${ENG}/core/skills/compose/SKILL.md`, tests: [T_VR],
    from: '  step, and never wait for the heavy-work lock there — a wait on a lock is\n',
    to: '  step, and wait for the heavy-work lock there — a wait on a lock is\n',
    why: 'under the offer the guidance lets the step wait for the heavy-work lock, a quiet idle wait the driver judges stalled',
    killed_by: /engineer\/core\/skills\/compose\/SKILL\.md: carries the guidance/,
  },

  {
    id: 'G3', file: `${ENG}/commands/frame.md`, tests: [T_VR],
    from: 'step ends (§ Long checks in `/engineer:compose`, `/engineer:refine` and\n`/engineer:critique` says which are long).\n',
    to: "step ends (the long-check guidance in this verb's skill says which are long).\n",
    why: 'frame\'s verify form points at long-check guidance its runbook does not render, so its step cannot tell which checks are long',
    killed_by: /every runbook rendering the verify form points at long-check guidance that runbook can reach/,
  },
  // ---- W: the worker's rules -----------------------------------------------
  {
    id: 'W1', file: WORKER, tests: [T_WORK],
    from: '    verifyOffered\n      ? \'4. Run peer ensembles as host background tasks,',
    to: '    false\n      ? \'4. Run peer ensembles as host background tasks,',
    why: 'under the offer rule 4 again sends long work to a background task the step waits on',
    killed_by: /offered: rule 4 keeps peer ensembles as background tasks and sends long checks to rule 7/,
  },
  {
    id: 'W2', file: WORKER, tests: [T_WORK],
    from: ' When this step resumes a verb after a verification batch, read the results its Phase 0 prints before acting: the failing tests named there are the evidence.',
    to: '',
    why: 'a resumed worker is not told to read the results before it acts',
    killed_by: /offered: rule 4 keeps peer ensembles as background tasks and sends long checks to rule 7, which hands them over and reads the results/,
  },
];
