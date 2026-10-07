// Mutation spec — do the S3+S4 tests catch the defects they exist for?
// (ADR-0063 D3, D4, D6; the verb runbook deltas and /engineer:commit)
//
// Run: npm run mutate -- scripts/mutation-specs/engineer-autopilot-verbs.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. Every rule here fails silently in the run it
// was written for. An autopilot verb that writes the terminal marker gets
// archived by the next Stop that sees HEAD moved; a split commit that fails
// halfway under an inherited marker is archived half-committed and noted on
// the macro; a close decided from an empty change list completes a subtask
// whose staged change was never looked at; a bypass flag commits a staging set
// only the owner could have judged; a Phase 2 that ignores a failed write
// publishes a next step for a verb that did not finish. None of those shows up
// until a later step has built on it.
//
// Groups: S the state script, P the Phase 7 driver, K the Stop hook, R the
// runbooks, C the tests' own controls.

const T_AV = 'tests/persona-pipeline/test-autopilot-verbs.mjs';
const T_EC = 'tests/persona-pipeline/test-commit-surface.mjs';
// The verb runbooks' blocks, run for every persona (PC3b U4b: moved from
// tests/engineer/test-verb-runbook-autopilot.mjs); engineer's committed
// runbooks and scripts are what the R and X mutations below break.
const T_RB = 'tests/persona-pipeline/test-verb-runbook-runs.mjs';
const T_SH = 'tests/plugin-shape/test-engineer-autopilot-runbooks.mjs';
// The commit surface's runbook blocks, run (PC3b U4: moved from T_RB with the
// commit regions).
const T_CR = 'tests/persona-pipeline/test-commit-runbook.mjs';

const STATE = 'plugins/engineer/scripts/state.mjs';
const P7 = 'plugins/engineer/scripts/phase7-commit.mjs';
const STOP = 'plugins/engineer/scripts/stop-archive.mjs';
const CRITIQUE = 'plugins/engineer/commands/critique.md';
const COMMIT_MD = 'plugins/engineer/commands/commit.md';

export const TESTS = [T_AV, T_EC, T_RB, T_SH, T_CR];

const BEGIN_COMMIT_LOOP = '  await beginCommit({ workflowPath, host: flags.host });\n  for (let i = 0; i < shape.commits.length; i++) {';
const LOOP_ONLY = '  for (let i = 0; i < shape.commits.length; i++) {';
// T_EC wraps its cases in a persona loop (ADR-0066 Stage 3), two spaces deeper.
const PHASE_ASSERT = "        deepStrictEqual([fm.current_phase, fm.terminal_marker], ['phase-7-commit', false]);\n";
const INHERITED_MARKER_SETUP =
  '        // The verb ended interactively: summary-complete with the marker.\n' +
  "        sh(dir, 'node', [STATE_BIN, 'finish-verb', '--workflow-path', wf, '--host', 'claude', '--next-action', 'commit',\n" +
  "          '--next-step-kind', 'commit', '--next-step-confidence', 'HIGH']);\n" +
  '        strictEqual((await readWorkflow(wf)).frontmatter.terminal_marker, true);\n';

export const MUTATIONS = [
  // ---- S: state.mjs ------------------------------------------------------------
  {
    id: 'S1', file: STATE, tests: [T_AV, T_RB],
    from: '  if (autopilot || ownerGate !== undefined) {',
    to: '  if (ownerGate !== undefined) {',
    why: 'an autopilot verb ends terminal, so the next Stop archives it before /engineer:commit',
  },
  {
    id: 'S2', file: STATE, tests: [T_AV],
    from: '    if (!noPendingEnsembleCheck(frontmatter)) {',
    to: '    if (false) {',
    why: 'an autopilot verb publishes its next step with its peer still running',
  },
  {
    id: 'S3', file: STATE, tests: [T_AV],
    from: '    if (clearTerminalMarker && frontmatter.terminal_marker === true) frontmatter.terminal_marker = false;',
    to: '',
    why: 'an interactive verb\'s terminal marker survives into an autopilot step or an owner pause',
  },
  {
    id: 'S4', file: STATE, tests: [T_AV],
    from: '        if (terminalMarker && autopilotMode({ env: process.env, host: flags.host }).active) {',
    to: '        if (false) {',
    why: 'a verb that calls set-terminal under autopilot closes the workflow',
  },
  {
    id: 'S5', file: STATE, tests: [T_AV, T_RB],
    from: '  if (mode.active && gate) {',
    to: '  if (false) {',
    why: 'an autopilot step runs over a pending owner gate',
  },
  {
    id: 'S6', file: STATE, tests: [T_AV, T_RB],
    from: "  if (mode.active) {\n    return {\n      mode: 'autopilot',\n      gate: null,",
    to: "  if (true) {\n    return {\n      mode: 'autopilot',\n      gate: null,",
    why: 'the rules banner prints interactively, so an interactive run follows autopilot rules',
  },
  {
    id: 'S7', file: STATE, tests: [T_AV],
    from: '    if (gateFields) applyOwnerGate(frontmatter, gateFields);',
    to: '',
    why: 'finish-verb --owner-gate records no gate, so the driver proceeds past the conflict',
  },
  {
    id: 'S8', file: STATE, tests: [T_AV],
    from: "  if (ownerGate !== undefined && nextStep.kind !== 'owner-decision') {",
    to: '  if (false) {',
    why: 'a gate is recorded next to a next step the driver would run',
  },
  {
    id: 'S9', file: STATE, tests: [T_AV],
    from: '    for (const k of AWAITING_OWNER_KEYS) delete frontmatter[k];\n    applyNextStepWrite(frontmatter, nextStepWrite);',
    to: '    for (const k of AWAITING_OWNER_KEYS) delete frontmatter[k];',
    why: 'the owner\'s resolution leaves owner-decision behind, and the driver halts again',
  },

  // ---- P: phase7-commit.mjs ----------------------------------------------------
  {
    id: 'P1', file: P7, tests: [T_EC],
    from: BEGIN_COMMIT_LOOP,
    to: LOOP_ONLY,
    why: 'a split that fails halfway keeps the inherited marker, and Stop archives it half-committed',
  },
  {
    id: 'P2', file: P7, tests: [T_EC],
    from: '  if (statusPaths.length > 0) {',
    to: '  if (false) {',
    why: 'a staged change the working tree reverted counts as a clean tree, and the workflow closes',
  },
  {
    id: 'P3', file: P7, tests: [T_EC],
    from: "  if (frontmatter.workflow_type === 'start') {\n    return { path: 'blocked', reason: 'start-workflow', ...facts };",
    to: "  if (false) {\n    return { path: 'blocked', reason: 'start-workflow', ...facts };",
    why: 'an /engineer:start workflow a verb wrote done on is closed without its Phase 7',
  },
  {
    id: 'P4', file: P7, tests: [T_EC],
    from: "  if (frontmatter.next_step_kind === 'done') {",
    to: '  if (true) {',
    why: 'a workflow whose verb asked for a commit is closed without one',
  },
  {
    id: 'P5', file: P7, tests: [T_EC],
    from: '  if (probe.coveredBy.length > 0) {',
    to: '  if (false) {',
    why: 'marked commits that miss a manifest path read as unmarked, hiding the partial commit',
  },
  {
    id: 'P6', file: P7, tests: [T_EC],
    from: '  if (headMoved) {',
    to: '  if (false) {',
    why: 'a workflow with unlanded hand commits is closed as if it had none',
  },
  {
    id: 'P7', file: P7, tests: [T_EC],
    from: '  if (autopilot.active) {\n    const bypass = [',
    to: '  if (false) {\n    const bypass = [',
    why: 'under autopilot a confirm flag or ACCEPT_CURRENT_TREE bypasses the staging-set gate',
  },
  {
    id: 'P8', file: P7, tests: [T_EC],
    from: "  if (!cleanBaseline) whyOwner.push(",
    to: '  if (false) whyOwner.push(',
    why: 'autopilot stages whole manifest paths of a workflow that began on a dirty tree',
  },
  {
    id: 'P9', file: P7, tests: [T_EC],
    from: '  if (preStaged.length > 0) whyOwner.push(',
    to: '  if (false) whyOwner.push(',
    why: 'autopilot commits over an index the owner pre-staged',
  },
  {
    id: 'P10', file: P7, tests: [T_EC],
    from: '  if (plan.ask_user) whyOwner.push(',
    to: '  if (false) whyOwner.push(',
    why: 'a staging set that needs the owner is not recorded as the staging-set gate',
  },
  {
    id: 'P11', file: P7, tests: [T_EC],
    from: '    emitHandoff: false,',
    to: '    emitHandoff: true,',
    why: 'the close prints a handoff that tells the owner to commit',
  },
  {
    id: 'P12', file: P7, tests: [T_EC],
    from: '  // owner confirms the set and /engineer:commit clears the gate first.\n  refuseOwnerGate(frontmatter);',
    to: '  // owner confirms the set and /engineer:commit clears the gate first.',
    why: 'execute commits over a pending owner gate',
  },
  {
    id: 'P13', file: P7, tests: [T_EC],
    from: "async function closeMode({ workflowPath, repoRoot, frontmatter, flags, stderr }) {\n  refuseOwnerGate(frontmatter);",
    to: 'async function closeMode({ workflowPath, repoRoot, frontmatter, flags, stderr }) {',
    why: 'close alone crosses a pending owner gate',
  },
  {
    id: 'P14', file: P7, tests: [T_EC],
    from: '  if (frontmatter.awaiting_owner_gate !== undefined) {\n    stderr.write(',
    to: '  if (false) {\n    stderr.write(',
    why: 'the autopilot mode, run directly, re-records over the gate the owner has not resolved',
  },
  {
    id: 'P15', file: P7, tests: [T_EC],
    from: '  if (!noPendingEnsembleCheck(frontmatter)) {\n    stderr.write(\n      `✗ pending_ensemble is non-empty; nothing is committed',
    to: '  if (false) {\n    stderr.write(\n      `✗ pending_ensemble is non-empty; nothing is committed',
    why: 'autopilot commits and only then fails P11, leaving a commit to recover',
  },
  {
    id: 'P16', file: P7, tests: [T_EC],
    from: '    const subject = suggested\n      ? inferSubject(',
    to: '    const subject = false\n      ? inferSubject(',
    why: '--suggested-subjects is ignored, and a split needs subjects passed through a shell',
  },
  {
    id: 'P17', file: P7, tests: [T_EC, T_SH],
    from: "      ownerGate: { gate: 'staging-set', anchor: 'phase7-plan' },",
    to: "      ownerGate: { gate: 'staging-set', anchor: 'phase7' },",
    why: 'the staging-set pointer names a section the note does not have',
  },

  // ---- K: the Stop hook --------------------------------------------------------
  {
    id: 'K1', file: STOP, tests: [T_EC],
    from: '  if (frontmatter?.awaiting_owner_gate !== undefined) {',
    to: '  if (false) {',
    why: 'Stop archives a workflow that waits on its owner, burying the gate',
  },
  {
    id: 'K2', file: STOP, tests: [T_EC],
    from: "  if (frontmatter.current_phase === 'close-complete') return;",
    to: '',
    why: 'a close that a crash left active is noted on the macro with someone else\'s commit',
  },

  // ---- R: the runbooks ---------------------------------------------------------
  {
    // PC3 U7: critique's finalize is generated and settles the attempt.
    id: 'R1', file: CRITIQUE, tests: [T_RB, T_SH],
    from: '  --verdict "$VERDICT" --summary "$SUMMARY" || exit $?',
    to: '  --verdict "$VERDICT" --summary "$SUMMARY"',
    why: 'a refused settlement is ignored and finish-verb publishes the next step anyway',
  },
  {
    id: 'R2', file: CRITIQUE, tests: [T_RB, T_SH],
    from: 'node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" autopilot-preflight \\\n  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" || exit $?\n',
    to: '',
    why: 'Phase 0 never learns the mode, and an autopilot step runs over an owner gate',
  },
  {
    id: 'R3', file: CRITIQUE, tests: [T_RB, T_SH],
    from: '  --clear-next-step true \\\n',
    to: '',
    why: 'a verb that dies after Phase 0 leaves the previous verb\'s next step, which reads as progress',
  },
  {
    id: 'R4', file: CRITIQUE, tests: [T_SH],
    from: '  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err"\n',
    to: '  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err" &\n',
    why: 'the peer runner is detached where the host cannot wait for it',
  },
  {
    id: 'R5', file: COMMIT_MD, tests: [T_CR],
    from: '  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host "${AGENTIC_HOST:-claude}"\n```\n\nReport its JSON `action`',
    to: '  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host "${AGENTIC_HOST:-claude}" --confirm-non-interactive\n```\n\nReport its JSON `action`',
    why: 'the autopilot block passes a confirm flag',
  },
  {
    id: 'R6', file: COMMIT_MD, tests: [T_CR],
    from: ' --surface commit || exit $?',
    to: ' || exit $?',
    why: '/engineer:commit prints the verb banner, which forbids the commit it exists to make',
  },

  // ---- X: the Codex round-2 findings -------------------------------------------
  {
    id: 'X1', file: STATE, tests: [T_AV, T_EC],
    from: '  Object.assign(frontmatter, fields);\n  if (frontmatter.terminal_marker === true) frontmatter.terminal_marker = false;\n  validateSchema14Fields(frontmatter);',
    to: '  Object.assign(frontmatter, fields);\n  validateSchema14Fields(frontmatter);',
    why: 'an owner gate is recorded on a terminal workflow, and a later refusal leaves it for the Stop hook to archive',
  },
  {
    id: 'X2', file: P7, tests: [T_EC],
    from: "      if (typeof parts[i] === 'string' && parts[i].length > 0) paths.push(parts[i]);\n",
    to: '',
    why: 'a rename into workflow storage reads as a clean tree, and the workflow closes over a staged deletion',
  },
  {
    id: 'X3', file: P7, tests: [T_EC],
    from: "  if ((flags.mode === 'execute' || flags.mode === 'close') && autopilot.active) {",
    to: '  if (false) {',
    why: 'under autopilot a direct execute steps around the clean-baseline and pre-staged rules',
  },
  {
    id: 'X4', file: STOP, tests: [T_EC],
    from: "  if (frontmatter?.awaiting_owner_gate !== undefined) failures.push('awaiting_owner');\n",
    to: '',
    why: 'the orphan sweep archives a workflow that waits on its owner once its branch is gone',
  },
  {
    id: 'X5', file: 'plugins/engineer/scripts/session-handoff.mjs', tests: [T_AV],
    from: "  } else if (phase === 'close-complete') {\n",
    to: "  } else if (phase === 'no-such-phase') {\n",
    why: 'an interrupted close tells the owner to commit',
  },
  {
    id: 'X6', file: 'plugins/engineer/core/skills/commit/SKILL.md', tests: [T_CR],
    from: '```bash\nPERSONA=\'engineer\'\nREPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1\nACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?\n[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }\nnode "<plugin-root>/scripts/phase7-commit.mjs" --mode plan \\',
    to: '```bash\nPERSONA=\'engineer\'\nnode "<plugin-root>/scripts/phase7-commit.mjs" --mode plan \\',
    why: 'the Codex plan block reuses a variable an earlier Bash call set, and fails in a fresh shell',
  },
  {
    id: 'X7', file: COMMIT_MD, tests: [T_CR],
    from: '  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --gate staging-set \\\n  --next-action "Commit the confirmed staging set with /${PERSONA}:commit" \\\n  --next-step-kind commit --next-step-confidence HIGH || exit $?\n',
    to: '  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --gate staging-set || exit $?\n',
    why: 'the owner resolves the staging set, the commit fails, and owner-decision stops the driver again',
  },
  {
    id: 'X8', file: 'plugins/engineer/commands/decide.md', tests: [T_RB, T_SH],
    from: '  "${NEXT_STEP[@]}" || exit $?\n',
    to: '  "${NEXT_STEP[@]}"\n',
    why: 'a refused clear is ignored, and the selection is written over another pending gate',
  },

  {
    id: 'X9', file: STATE, tests: [T_AV, T_RB],
    from: "      (resolution !== undefined ? `${resolution.trim()}\\n\\n` : '') +\n",
    to: '',
    why: 'the owner\'s decision is dropped, so the next step is published without it (round-3 F1)',
  },
  {
    id: 'X10', file: 'plugins/engineer/commands/decide.md', tests: [T_RB, T_SH],
    from: 'REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1\nACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?\n[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }\n# A gate met inside a /start lifecycle',
    to: '# A gate met inside a /start lifecycle',
    why: 'the Owner selection block reuses $ACTIVE from another Bash call, and fails in a fresh shell (round-3 F2)',
  },

  // ---- C: the tests' own controls ----------------------------------------------
  {
    id: 'C1', file: T_RB, tests: [T_RB],
    from: '              const r = runBlock(shell, dir, find, { STUB_ACTIVE: wf }, old);',
    to: '              const r = runBlock(shell, dir, find, { STUB_ACTIVE: wf }, P.root);',
    why: 'the old-install case runs the current scripts, so it cannot fail: its stand-in really lacks the preflight. (The released-scripts case skips in this harness, whose copy has no git tags.)',
  },
  // Why P1 bites. The half-commit case has two assertions that can see a
  // missing beginCommit: the phase it leaves, and the Stop verdict. C2 keeps
  // only the Stop verdict and still kills; C3 also drops the inherited-marker
  // setup, and then nothing can see it — the setup is what makes the Stop
  // verdict meaningful.
  {
    id: 'C2', tests: [T_EC],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: P7, from: BEGIN_COMMIT_LOOP, to: LOOP_ONLY });
      tools.applyEdit(copy, { file: T_EC, from: PHASE_ASSERT, to: '' });
    },
    why: 'the Stop verdict alone catches a missing beginCommit: the inherited marker archives the half-committed workflow',
  },
  {
    id: 'C3', tests: [T_EC],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: P7, from: BEGIN_COMMIT_LOOP, to: LOOP_ONLY });
      tools.applyEdit(copy, { file: T_EC, from: PHASE_ASSERT, to: '' });
      tools.applyEdit(copy, { file: T_EC, from: INHERITED_MARKER_SETUP, to: '' });
    },
    why: 'without the inherited marker the Stop verdict cannot see a missing beginCommit',
    expect: 'SURVIVED',
  },
];
