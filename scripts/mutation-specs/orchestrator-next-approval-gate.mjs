// Mutation spec — do the /orchestrator:next approval-gate tests catch the
// defects they exist for? (ADR-0063 D4 rule 3, owner decision D3, slice S6)
//
// Run: npm run mutate -- scripts/mutation-specs/orchestrator-next-approval-gate.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. The gate stands between an autopilot worker
// and work the owner did not approve, and every way it can break fails in the
// worker's favour: a gate that misreads the run, ignores the hash, lets a
// never-approved macro through, or checks the plan but not the subtask the
// runbook selected from an earlier read dispatches unapproved work, and a
// runbook that drops the exit code prints the refusal and dispatches anyway. The
// interactive side breaks the other way, and D3 is the owner's decision: a
// refusal, a second line, or a line for a legacy macro changes the dispatch
// the owner kept.
//
// Groups: G the gate function, B its binding to the selected subtask, C the
// CLI, R the runbooks, T the tests' own controls.

const TG = 'tests/orchestrator/test-next-approval-gate.mjs';

const STATE = 'plugins/orchestrator/scripts/state.mjs';
const NEXT_MD = 'plugins/orchestrator/commands/next.md';
const NEXT_SKILL = 'plugins/orchestrator/core/skills/next/SKILL.md';

export const TESTS = [TG];

export const MUTATIONS = [
  // ---- G: planApprovalGate -------------------------------------------------------
  {
    id: 'G1', file: STATE, tests: [TG],
    from: '  const autopilot = isAutopilotRun(env);\n  const pointer =',
    to: '  const autopilot = false;\n  const pointer =',
    why: 'the gate never sees the autopilot run, so it only ever warns',
  },
  {
    id: 'G2', file: STATE, tests: [TG],
    from: "  const approved = approval.status === 'approved' && approval.hash_ok === true;",
    to: "  const approved = approval.status === 'approved';",
    why: 'an approval whose hash no longer matches the plan passes the autopilot',
  },
  {
    id: 'G3', file: STATE, tests: [TG],
    from: " || (!autopilot && approval.status === 'absent')) {",
    to: " || (approval.status === 'absent')) {",
    why: 'a macro no one approved passes the autopilot because it predates approvals',
  },
  {
    id: 'G4', file: STATE, tests: [TG],
    from: " || (!autopilot && approval.status === 'absent')) {",
    to: ' || false) {',
    why: 'a legacy macro gets a warning line interactively (D3: legacy behaves as today)',
  },
  {
    id: 'G5', file: STATE, tests: [TG],
    from: '  if (autopilot) {\n    return {\n      verdict: \'refuse\'',
    to: '  if (true) {\n    return {\n      verdict: \'refuse\'',
    why: 'interactive dispatch of a pending plan is refused (D3 decided warn only)',
  },
  {
    id: 'G6', file: STATE, tests: [TG],
    from: '      `⚠ This plan ${state}; dispatching anyway, which an autopilot run would refuse (${pointer}). ` +\n        `The owner ${owner}.`,',
    to: '      `⚠ This plan ${state}; dispatching anyway, which an autopilot run would refuse (${pointer}).`,\n      `The owner ${owner}.`,',
    why: 'the interactive warning is two lines, not the one D3 allows',
  },
  {
    id: 'G7', file: STATE, tests: [TG],
    from: '  const pointer = frontmatter?.awaiting_owner_pointer ?? macroPointer(workflowPath, MACRO_PLAN_ANCHOR);',
    to: '  const pointer = macroPointer(workflowPath, MACRO_PLAN_ANCHOR);',
    why: 'a refusal over a Plan-verify conflict points at the plan, not at the synthesis the owner must settle',
  },
  {
    id: 'G8', file: STATE, tests: [TG],
    from: "  const sigil = host === 'codex' ? '$' : '/';",
    to: "  const sigil = '/';",
    why: 'the Codex refusal names a Claude slash command',
  },
  {
    id: 'G9', file: STATE, tests: [TG],
    from: '  validateHost(host);\n  if (typeof selected',
    to: '  if (typeof selected',
    why: 'an unknown host is accepted and spelled as Claude',
  },

  {
    id: 'G10', file: STATE, tests: [TG],
    from: "  if (typeof selected !== 'object' || selected === null || Array.isArray(selected) || typeof selected.id !== 'string') {",
    to: '  if (false) {',
    why: 'a selection that is no subtask is compared as one, and an interactive dispatch of it passes',
  },

  // ---- B: the binding to the selected subtask ----------------------------------
  {
    id: 'B1', file: STATE, tests: [TG],
    from: '  if ((approved && (selectedInPlan || !autopilot)) ||',
    to: '  if ((approved) ||',
    why: 'a plan rewritten and approved after the selection passes, and the old subtask is dispatched',
  },
  {
    id: 'B2', file: STATE, tests: [TG],
    from: '    && canonicalJson(planHashProjection([current])) === canonicalJson(planHashProjection([selected]));',
    to: ';',
    why: 'only the id is bound, so a selected subtask whose topic or branch nobody approved passes',
  },
  {
    id: 'B3', file: STATE, tests: [TG],
    from: '  if ((approved && (selectedInPlan || !autopilot)) ||',
    to: '  if ((approved && selectedInPlan) ||',
    why: 'interactive dispatch is refused over a stale selection (D3: interactive is never refused)',
  },
  {
    id: 'B4', file: STATE, tests: [TG],
    from: '    && canonicalJson(planHashProjection([current])) === canonicalJson(planHashProjection([selected]));',
    to: '    && canonicalJson(current) === canonicalJson(selected);',
    why: 'progress binds too, so a subtask that moved to in_progress after the selection is refused',
  },

  // ---- C: the CLI ------------------------------------------------------------------
  {
    id: 'C1', file: STATE, tests: [TG],
    from: "        return gate.verdict === 'refuse' ? 1 : 0;",
    to: '        return 0;',
    why: 'a refusal exits 0, so the runbook prints it and dispatches anyway',
  },
  {
    id: 'C2', file: STATE, tests: [TG],
    from: '        for (const line of lines) process.stderr.write(`${line}\\n`);\n',
    to: '',
    why: 'the refusal and the warning are silent; the owner is never told why or where to act',
  },

  // ---- R: the runbooks -------------------------------------------------------------
  {
    id: 'R1', file: NEXT_MD, tests: [TG],
    from: '  --subtask-json "$SUBTASK_JSON" >/dev/null || exit 1\n',
    to: '  --subtask-json "$SUBTASK_JSON" >/dev/null\n',
    why: 'the runbook prints the refusal and goes on to Phase 2',
  },
  {
    id: 'R2', file: NEXT_MD, tests: [TG],
    from: 'node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" approval-gate \\\n  --workflow-path "$MACRO_PATH" --host claude \\\n  --subtask-json "$SUBTASK_JSON" >/dev/null || exit 1\n',
    to: ':\n',
    why: 'Phase 1 has no gate at all',
  },
  {
    id: 'R3', file: NEXT_MD, tests: [TG],
    from: '  --subtask-json "$SUBTASK_JSON" >/dev/null || exit 1\n',
    to: '  --subtask-json "$SUBTASK_JSON" || exit 1\n',
    why: 'the JSON verdict lands in the dispatch output',
  },
  {
    id: 'R4', file: NEXT_SKILL, tests: [TG],
    from: '  --subtask-json "$SUBTASK_JSON" >/dev/null || exit 1\n',
    to: '  --subtask-json "$SUBTASK_JSON" >/dev/null\n',
    why: 'the Codex mirror dispatches past a refusal',
  },

  // ---- T: the tests' own controls ----------------------------------------------------
  {
    id: 'T1', file: TG, tests: [TG],
    from: '    if (!(k in extra)) delete env[k];',
    to: '    void k;',
    why: 'a runner that exports AGENTIC_AUTOPILOT turns every interactive case into an autopilot one',
  },
];
