// Mutation spec — do the ADR-0062 tests catch the defects they exist for?
//
// Run: npm run mutate -- scripts/mutation-specs/subtask-landing.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. Every rule here fails quietly. A completion
// recorded at the branch commit still looks like a completion; a late
// writeback that replaces a recorded commit leaves a plausible sha behind (on
// subtask C58 nobody noticed for hours); a successor started from the wrong
// base builds and passes its own tests. A green suite proves nothing about
// these; deleting each rule and watching a named test fail does.
//
// Groups: P the provenance guard (C14), U the plan revision rules (C22 and
// the terminal refusal), R readiness, B the /next branch base, L landing
// resolution, E the engineer terminal note, W the engineer side and the
// version pairing, D the /done runbook, N the /plan runbook.

const T_PROV = 'tests/orchestrator/test-subtask-provenance.mjs';
const T_PLAN = 'tests/orchestrator/test-plan-revision.mjs';
const T_READY = 'tests/orchestrator/test-subtask-readiness.mjs';
const T_NEXT_RB = 'tests/orchestrator/test-next-readiness-runbook.mjs';
const T_BASE = 'tests/orchestrator/test-next-branch-base.mjs';
const T_LAND = 'tests/orchestrator/test-landing.mjs';
const T_TERM = 'tests/orchestrator/test-engineer-terminal.mjs';
const T_DONE = 'tests/orchestrator/test-done-runbook.mjs';
const T_PRE = 'tests/orchestrator/test-discover-engineer.mjs';
const T_RB = 'tests/plugin-shape/test-orchestrator-landing-runbooks.mjs';
const T_WB = 'tests/persona-pipeline/test-parent-writeback.mjs';
const T_STOP = 'tests/persona-pipeline/test-stop-archive.mjs';
const T_P7 = 'tests/persona-pipeline/test-phase7-commit.mjs';

const STATE = 'plugins/orchestrator/scripts/state.mjs';
const LANDING = 'plugins/orchestrator/scripts/landing.mjs';
const PREFLIGHT = 'plugins/orchestrator/scripts/discover-engineer.mjs';
const NEXT = 'plugins/orchestrator/commands/next.md';
const DONE = 'plugins/orchestrator/commands/done.md';
const PLAN = 'plugins/orchestrator/commands/plan.md';
const WRITEBACK = 'plugins/engineer/scripts/parent-writeback.mjs';
const PHASE7 = 'plugins/engineer/scripts/phase7-commit.mjs';
const STOP = 'plugins/engineer/scripts/stop-archive.mjs';

export const TESTS = [
  T_PROV, T_PLAN, T_READY, T_NEXT_RB, T_BASE, T_LAND, T_TERM, T_DONE, T_PRE, T_RB, T_WB, T_STOP, T_P7,
];

export const MUTATIONS = [
  // ---- P: a recorded value is not replaced silently (C14) --------------------
  {
    id: 'P1', file: STATE, tests: [T_PROV],
    from: "if (typeof recorded !== 'string' || recorded.length === 0 || recorded === payload[key]) continue;",
    to: 'continue;',
    why: 'a late writeback replaces the recorded commit (the C58 overwrite)',
  },
  {
    id: 'P2', file: STATE, tests: [T_PROV],
    from: '        delete payload.closed_at;',
    to: '        void 0;',
    why: 'a re-run rewrites the recorded completion time',
  },
  {
    id: 'P3', file: STATE, tests: [T_PROV],
    from: '    if (changedKeys.length === 0) {',
    to: '    if (false) {',
    why: 'a call that changes nothing still writes the file and host_history',
  },
  {
    id: 'P4', file: STATE, tests: [T_PROV],
    from: "  if (correct && reasonText.length === 0) {\n    throw new Error(\n      'updateSubtask: --correct",
    to: "  if (false) {\n    throw new Error(\n      'updateSubtask: --correct",
    why: 'a correction goes through without saying why',
  },
  {
    id: 'P5', file: STATE, tests: [T_PROV, T_DONE],
    from: '    if (expectBranch !== undefined && current.branch !== expectBranch) {',
    to: '    if (false) {',
    why: 'a landing resolved for one branch completes a subtask the plan moved to another',
  },

  // ---- U: what a plan revision may do (C22, terminal refusal, carry) ---------
  {
    id: 'U1', file: STATE, tests: [T_PLAN],
    from: '    const promoted = applyUnblockPass(merged);',
    to: '    const promoted = [];',
    why: 'plan-set leaves a satisfied subtask blocked (C22)',
  },
  {
    id: 'U2', file: STATE, tests: [T_PLAN],
    from: '    if (deps.every((depId) => completedIds.has(depId))) {',
    to: '    if (deps.length > 0 && deps.every((depId) => completedIds.has(depId))) {',
    why: 'a revision that empties blocked_by leaves the subtask blocked',
  },
  {
    id: 'U3', file: STATE, tests: [T_PLAN],
    from: "    if (frontmatter.terminal_marker === true) {\n      throw new Error(\n        `setPlan: this terminal macro",
    to: "    if (false) {\n      throw new Error(\n        `setPlan: this terminal macro",
    why: 'a terminal macro is revised and strands its marker',
  },
  {
    id: 'U4', file: STATE, tests: [T_PLAN],
    from: '    frontmatter.plan = plan;',
    to: "    frontmatter.plan = plan;\n    if (allTerminal) { frontmatter.terminal_marker = true; frontmatter.current_phase = 'commit-complete'; }",
    why: 'plan-set closes the macro itself, which the runbook then overwrites',
  },
  {
    id: 'U5', file: STATE, tests: [T_PLAN],
    from: '    const allTerminal = merged.length > 0',
    to: '    const allTerminal = merged.length >= 0',
    why: 'an empty plan is reported as all-terminal',
  },
  {
    id: 'U6', file: STATE, tests: [T_PLAN],
    from: '        next[key] = prev[key];\n        continue;',
    to: '        continue;',
    why: 'a revision that omits a completed subtask\'s provenance drops it',
  },
  {
    id: 'U7', file: STATE, tests: [T_PLAN],
    from: '      if (!correct) refuse(`completed subtask ${JSON.stringify(prev.id)} is missing from the revision`);',
    to: '      void 0;',
    why: 'a revision silently removes a completed subtask',
  },
  {
    id: 'U8', file: STATE, tests: [T_PLAN],
    from: '      if (same(next[key], prev[key])) continue;\n      if (!correct) {',
    to: '      if (same(next[key], prev[key])) continue;\n      if (false) {',
    why: 'a revision silently changes a completed subtask (its commit, status or work)',
  },
  {
    id: 'U9', file: STATE, tests: [T_PLAN],
    from: '    for (const key of Object.keys(prev)) {',
    to: "    for (const key of Object.keys(prev).filter((k) => ['status', 'engineer_workflow_id', 'commit', 'pr_url', 'closed_at'].includes(k))) {",
    why: 'only the provenance is protected, so a revision can swap the work a completion names (review finding)',
  },
  {
    id: 'U10', file: STATE, tests: [T_PLAN],
    from: '    if (requireOpen && frontmatter.terminal_marker === true) {',
    to: '    if (false) {',
    why: 'append --require-open writes to a terminal macro',
  },
  {
    id: 'U11', file: STATE, tests: [T_PROV],
    from: "  if (basename(dirname(workflowPath)) === 'archive') {",
    to: '  if (false) {',
    why: 'a correction rewrites an archived macro in place',
  },
  {
    id: 'U12', file: STATE, tests: [T_TERM],
    from: "    } else if (payload.status === 'completed' && current.status !== 'completed') {",
    to: '    } else if (false) {',
    why: 'after a non-final completion next_action still says to record that subtask',
  },

  // ---- R: readiness comes from the plan --------------------------------------
  {
    id: 'R1', file: STATE, tests: [T_READY, T_NEXT_RB],
    from: "      stale_blocked: s?.status === 'blocked' && waitingOn.length === 0,",
    to: '      stale_blocked: false,',
    why: 'a stale blocked status is reported as waiting',
  },
  {
    id: 'R2', file: NEXT, tests: [T_NEXT_RB],
    from: '    if [ "$STALE_BLOCKED" = "true" ]; then',
    to: '    if false; then',
    why: '/next prints the status-only diagnosis again (C22)',
  },

  // ---- B: /next starts a new branch from the integration branch --------------
  {
    id: 'B1', file: NEXT, tests: [T_BASE],
    from: '  git -C "$REPO_ROOT" switch --no-track -c "$SUBTASK_BRANCH" "refs/remotes/origin/$INTEGRATION_BRANCH" || exit $?',
    to: '  git -C "$REPO_ROOT" switch -c "$SUBTASK_BRANCH" || exit $?',
    why: 'a successor starts from the checked-out HEAD, i.e. the previous subtask\'s branch',
  },
  {
    id: 'B2', file: NEXT, tests: [T_BASE],
    from: 'switch --no-track -c "$SUBTASK_BRANCH"',
    to: 'switch -c "$SUBTASK_BRANCH"',
    why: 'the new branch tracks origin/main, so a bare push targets main',
  },
  {
    id: 'B3', file: NEXT, tests: [T_BASE],
    from: '  if ! git -C "$REPO_ROOT" show-ref --verify --quiet "refs/remotes/origin/$INTEGRATION_BRANCH"; then',
    to: '  if false; then',
    why: 'a missing remote-tracking ref surfaces as a raw git failure',
  },

  // ---- L: the landing is the merge commit of this attempt's pull request -----
  {
    id: 'L1', file: LANDING, tests: [T_LAND],
    from: '    const attempt = forBranch.filter(openedInAttempt);',
    to: '    const attempt = forBranch;',
    why: 'a reused branch name picks up an older, unrelated merge',
  },
  {
    id: 'L2', file: LANDING, tests: [T_LAND],
    from: '  if (pr.baseRefName !== integrationBranch) {',
    to: '  if (false) {',
    why: 'a pull request merged into another base counts as landed',
  },
  {
    id: 'L3', file: LANDING, tests: [T_LAND],
    from: '  if (commit && commit !== mergeCommit) {',
    to: '  if (false) {',
    why: '--commit accepts the branch tip instead of the merge commit',
  },
  {
    id: 'L4', file: LANDING, tests: [T_LAND],
    from: '  if (!(await isAncestor(repoRoot, mergeCommit, integrationRef))) {',
    to: '  if (false) {',
    why: 'a merge commit the integration branch does not contain is recorded',
  },
  {
    id: 'L5', file: LANDING, tests: [T_LAND],
    from: '    if (!(await isAncestor(repoRoot, commit, integrationRef))) {',
    to: '    if (false) {',
    why: 'without gh, any commit is accepted',
  },
  {
    id: 'L6', file: LANDING, tests: [T_LAND],
    from: '  const integrationRef = `refs/remotes/origin/${integrationBranch}`;',
    to: '  const integrationRef = `refs/heads/${integrationBranch}`;',
    why: 'an unpushed local commit proves a landing',
  },
  {
    id: 'L8', file: LANDING, tests: [T_LAND],
    from: '  if (!(dispatchedAt instanceof Date) || Number.isNaN(dispatchedAt.getTime())) {',
    to: '  if (false) {',
    why: 'an attempt with no dispatch time is resolved without the attempt filter',
  },
  {
    id: 'L9', file: LANDING, tests: [T_LAND],
    from: '    if (!openedInAttempt(pr)) {',
    to: '    if (false) {',
    why: '--pr names an older attempt\'s pull request (review finding)',
  },
  {
    id: 'L10', file: LANDING, tests: [T_LAND],
    from: '  const openedInAttempt = (p) => Date.parse(p.createdAt) >= since;',
    to: '  const openedInAttempt = (p) => Date.parse(p.createdAt) >= since - 10 * 60 * 1000;',
    why: 'a skew allowance admits a pull request opened before the dispatch (review finding)',
  },
  {
    id: 'L7', file: LANDING, tests: [T_LAND],
    from: '      if (open.length > 0) {',
    to: '      if (false) {',
    why: 'an open pull request is reported as no pull request at all',
  },

  // ---- E: the engineer terminal note -----------------------------------------
  {
    id: 'E1', file: STATE, tests: [T_TERM, T_WB],
    from: '    if (!boundOwner && !promotedToInProgress && body.includes(heading)) {',
    to: '    if (false) {',
    why: 'Phase 7 and the Stop hook each rewrite the macro',
  },
  {
    id: 'E2', file: STATE, tests: [T_TERM, T_WB],
    from: "    if (TERMINAL_SUBTASK_STATUSES.has(current.status) || current.status === 'blocked') {",
    to: "    if (current.status === 'blocked') {",
    why: 'a completed, deferred or abandoned subtask is reopened to in_progress',
  },
  {
    id: 'E3', file: STATE, tests: [T_TERM],
    from: "if (typeof recordedOwner === 'string' && recordedOwner.length > 0 && recordedOwner !== engineerWorkflowId) {",
    to: 'if (false) {',
    why: 'a stale child takes over another workflow\'s subtask',
  },

  // ---- W: the engineer side and the version pairing ---------------------------
  {
    id: 'W1', file: STATE, tests: [T_TERM, T_WB, T_STOP, T_P7],
    from: '    const updated = { ...current, engineer_workflow_id: engineerWorkflowId };',
    to: "    const updated = { ...current, engineer_workflow_id: engineerWorkflowId, status: 'completed', commit: branchCommit };",
    why: 'the engineer terminal commit completes the subtask again (the pre-ADR-0062 contract)',
  },
  {
    id: 'W2', file: PHASE7, tests: [T_P7],
    from: '      ? `Open and merge the pull request, then run ${doneCommand}`',
    to: "      ? 'archive'",
    why: 'the engineer workflow no longer points at the step that completes the subtask',
  },
  {
    id: 'W3', file: STOP, tests: [T_STOP],
    // The canonical stop-archive imports parent-writeback.mjs inside the try
    // (ADR-0066 Decision 3: never statically), since Stage 3.
    from: "  try {\n    const { writebackParent, dispatchExpectation } = await import('./parent-writeback.mjs');\n",
    to: "  if (frontmatter.parent_writeback_at) return;\n  try {\n    const { writebackParent, dispatchExpectation } = await import('./parent-writeback.mjs');\n",
    why: 'the P10 marker gates the Stop call, so a crash after the marker loses the note',
  },
  {
    id: 'W4', file: PREFLIGHT, tests: [T_PRE],
    from: `  if (!writebackText.includes("'subtask-engineer-terminal'")) {`,
    to: '  if (false) {',
    why: '/next dispatches into an engineer that still completes at its branch commit',
  },
  {
    id: 'W6', file: PREFLIGHT, tests: [T_PRE],
    from: "  if (purpose === 'lifecycle') return { ok: true };",
    to: '  void 0;',
    why: '/finalize and /abort stop halfway on the dispatch-only check (review finding)',
  },
  {
    id: 'W7', file: 'plugins/orchestrator/commands/finalize.md', tests: [T_RB],
    from: 'preflight --root "$ENGINEER_PLUGIN_ROOT" --purpose lifecycle || exit 1',
    to: 'preflight --root "$ENGINEER_PLUGIN_ROOT" || exit 1',
    why: '/finalize runs the dispatch check after its bulk deferral',
  },
  {
    id: 'W5', file: WRITEBACK, tests: [T_WB],
    from: '    if (exitCode === 2 && /unknown subcommand: subtask-engineer-terminal/.test(cliStderr)) {',
    to: '    if (false) {',
    why: 'an orchestrator too old for the note is reported as a generic CLI failure',
  },

  // ---- D: the /done runbook ---------------------------------------------------
  {
    id: 'D1', file: DONE, tests: [T_DONE],
    from: `COMMIT_SHA="$(printf '%s' "$LANDING" | JSON_KEY=commit node -e "$JSON_FIELD")"`,
    to: 'COMMIT_SHA="$(git -C "$REPO_ROOT" rev-parse "refs/heads/$SUBTASK_BRANCH")"',
    why: '/done records the branch tip again',
  },
  {
    id: 'D2', file: 'plugins/orchestrator/scripts/state.mjs', tests: [T_DONE],
    from: "      for (const sub of activeOnly ? ['workflows'] : ['workflows', 'archive']) {",
    to: "      for (const sub of activeOnly ? ['workflows'] : ['workflows']) {",
    why: 'the owner of an archived child cannot be found after the merge',
  },
  {
    id: 'D3', file: DONE, tests: [T_DONE],
    from: '    if [ "$HAS_REASON" -eq 1 ]; then cat "$REASON_FILE"; fi',
    to: '    if [ "$HAS_REASON" -eq 1 ]; then eval "printf \'%s\' \\"$(cat "$REASON_FILE")\\""; fi',
    why: 'the shell evaluates the reason text',
  },
  {
    id: 'D7', file: DONE, tests: [T_DONE],
    from: ' --integration-branch "$INTEGRATION_BRANCH" --engineer-workflow-id "$EXISTING_ENG_WF_ID")',
    to: ' --integration-branch "$INTEGRATION_BRANCH")',
    why: 'an owner recovered from the archive is not used to date the attempt (review finding)',
  },
  {
    id: 'D8', file: DONE, tests: [T_DONE],
    from: "    */*|*\\\\*|..|.*)",
    to: "    */*|*\\\\*|..|.*|*$'\\0'*)",
    why: 'the NUL case pattern rejects every --workflow id under bash (review finding)',
  },
  {
    id: 'D4', file: DONE, tests: [T_DONE],
    from: '  if [ -n "$ACTIVE_CHILD" ]; then',
    to: '  if false; then',
    why: '--no-commit completes a subtask whose child can never archive',
  },
  {
    id: 'D5', file: DONE, tests: [T_DONE],
    from: '  --closed-at="$(date -u +%Y-%m-%dT%H:%M:%SZ)" --expect-branch="$SUBTASK_BRANCH" --event=updated)',
    to: '  --closed-at="$(date -u +%Y-%m-%dT%H:%M:%SZ)" --event=updated)',
    why: 'a plan revision during resolution lets the stale landing complete moved work',
  },
  {
    id: 'D6', file: DONE, tests: [T_DONE],
    from: 'if [ "${NO_COMMIT:-}" = "1" ] && { [ -n "${EXPLICIT_COMMIT:-}" ]',
    to: 'if false && { [ -n "${EXPLICIT_COMMIT:-}" ]',
    why: '--no-commit is combined with a commit',
  },

  // ---- N: the /plan runbook ---------------------------------------------------
  {
    id: 'N1', file: PLAN, tests: [T_RB],
    from: '    --next-action "Run plan skill" --event resumed --require-open || exit 1',
    to: '    --next-action "Run plan skill" --event resumed',
    why: '/plan rewrites the phase of a terminal macro before plan-set refuses',
  },
  {
    id: 'N2', file: PLAN, tests: [T_RB],
    from: '  --event updated --require-open',
    to: '  --event updated',
    why: 'the post-plan append can land on a macro finalized in between (review finding)',
  },
];
