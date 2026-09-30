// Mutation spec — do the orchestrator schema 1.2 tests catch the defects they
// exist for? (ADR-0063 D6, slice S2)
//
// Run: npm run mutate -- scripts/mutation-specs/orchestrator-schema-12.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. The autopilot driver dispatches a macro only
// when these keys say the owner approved this exact plan, so each rule fails
// silently and in the driver's favour: a hash that ignores a field lets a plan
// change keep its approval, a plan-set that does not revoke leaves the old
// approval standing, an approval under autopilot or over a conflict removes
// the only thing that would have stopped the run, and a key that is not at the
// tail is reordered by every 1.1 reader that touches the file.
//
// Groups: V the validator, H the plan hash, P plan-set, G the owner gates,
// A plan-approve, N next-ready, R the runbooks, F forward compatibility,
// L the lock, T the tests' own controls.

const T12 = 'tests/orchestrator/test-state-schema-12.mjs';
const TFC = 'tests/orchestrator/test-state-schema-forward-compat.mjs';
const TRB = 'tests/orchestrator/test-approve-runbook.mjs';

const STATE = 'plugins/orchestrator/scripts/state.mjs';
const PLAN_MD = 'plugins/orchestrator/commands/plan.md';
const APPROVE_MD = 'plugins/orchestrator/commands/approve.md';

export const TESTS = [T12, TFC, TRB];

export const MUTATIONS = [
  // ---- V: the parser's validator ---------------------------------------------
  {
    id: 'V1', file: STATE, tests: [T12],
    from: '    if ((key in fm) !== approved) {',
    to: '    if (false) {',
    why: 'an approval without its hash or time parses, and a pending plan can carry a stale hash',
  },
  {
    id: 'V2', file: STATE, tests: [T12],
    from: '  if (present.length > 0 && present.length < AWAITING_OWNER_KEYS.length) {',
    to: '  if (false) {',
    why: 'a half-written awaiting_owner parses',
  },
  {
    id: 'V3', file: STATE, tests: [T12],
    from: '  if (pending !== gated) {',
    to: '  if (false) {',
    why: 'a pending plan with no gate to halt on parses',
  },
  {
    id: 'V4', file: STATE, tests: [T12],
    from: '  if (pending !== gated) {',
    to: '  if (pending && !gated) {',
    why: 'the converse is lost: a plan gate survives on an approved plan',
  },
  {
    id: 'V5', file: STATE, tests: [T12],
    from: "    validateEnumScalar('plan_approval_status', fm.plan_approval_status, VALID_PLAN_APPROVAL_STATUSES);",
    to: '',
    why: 'an unknown approval status is stored',
  },
  {
    id: 'V6', file: STATE, tests: [T12],
    from: "  if (typeof value !== 'string' || !PLAN_HASH_RE.test(value)) {",
    to: "  if (typeof value !== 'string') {",
    why: 'a hash in the wrong form (uppercase, short) is stored and never matches',
  },
  {
    id: 'V7', file: STATE, tests: [T12],
    from: "    !value.includes('..');",
    to: '    true;',
    why: 'a pointer can climb out of the repository',
  },
  {
    id: 'V8', file: STATE, tests: [T12],
    from: "    !value.startsWith('/') &&",
    to: '',
    why: 'a pointer can be absolute',
  },
  {
    id: 'V9', file: STATE, tests: [T12],
    from: '    isoUtc(Date.parse(value)) === value;',
    to: '    true;',
    why: 'an impossible date (Feb 30) is stored as approved_at or since',
  },
  {
    id: 'V10', file: STATE, tests: [T12],
    from: "export const VALID_MACRO_OWNER_GATES = new Set(['plan-approval', 'plan-conflict']);",
    to: "export const VALID_MACRO_OWNER_GATES = new Set(['plan-approval', 'plan-conflict', 'decide-conflict']);",
    why: 'an engineer gate is stored on the macro',
  },

  // ---- H: the plan hash --------------------------------------------------------
  {
    id: 'H1', file: STATE, tests: [T12],
    from: '    const keys = Object.keys(value).sort();',
    to: '    const keys = Object.keys(value);',
    why: 'the hash depends on the order a subtask\'s keys were written in',
  },
  {
    id: 'H2', file: STATE, tests: [T12],
    from: "const PLAN_HASH_SUBTASK_KEYS = ['id', 'label', 'branch', 'blocked_by', 'verb', 'profile', 'topic'];",
    to: "const PLAN_HASH_SUBTASK_KEYS = ['id', 'label', 'branch', 'blocked_by', 'verb', 'profile', 'topic', 'status'];",
    why: 'progress changes the hash, so an approval breaks as soon as the plan executes',
  },
  {
    id: 'H3', file: STATE, tests: [T12],
    from: "const PLAN_HASH_SUBTASK_KEYS = ['id', 'label', 'branch', 'blocked_by', 'verb', 'profile', 'topic'];",
    to: "const PLAN_HASH_SUBTASK_KEYS = ['id', 'label', 'branch', 'blocked_by', 'verb', 'profile'];",
    why: 'a change of topic keeps the approval',
  },
  {
    id: 'H4', file: STATE, tests: [T12],
    from: '      if (s[k] !== undefined && s[k] !== null) out[k] = s[k];',
    to: '      if (s[k] !== undefined) out[k] = s[k];',
    why: 'a null optional field hashes differently from the absent field the serializer writes',
  },
  {
    id: 'H5', file: STATE, tests: [T12],
    from: "    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;",
    to: "    return `{${keys.map((k) => `${JSON.stringify(k)}: ${canonicalJson(value[k])}`).join(', ')}}`;",
    why: 'the canonical form gains whitespace, so the hash is not the documented one',
  },
  {
    id: 'H6', file: STATE, tests: [T12],
    from: "  return createHash('sha256').update(canonicalJson(planHashProjection(subtasks)), 'utf8').digest('hex');",
    to: "  return createHash('sha256').update(canonicalJson(planHashProjection(subtasks.slice().sort((a, b) => String(a.id).localeCompare(String(b.id))))), 'utf8').digest('hex');",
    why: 'reordering the subtasks keeps the approval',
  },

  // ---- P: plan-set ---------------------------------------------------------------
  {
    id: 'P1', file: STATE, tests: [T12],
    from: '    resetPlanApproval(frontmatter, workflowPath, nowIso, { conflict });\n    validateSchema12Fields(frontmatter);\n',
    to: '',
    why: 'a plan write keeps the earlier approval',
  },
  {
    id: 'P2', file: STATE, tests: [T12],
    from: '  delete frontmatter.plan_approval_plan_hash;\n',
    to: '',
    why: 'the revoked hash is left on a pending plan',
  },
  {
    id: 'P3', file: STATE, tests: [T12],
    from: "  const home = inferStorageFromWorkflowPath(workflowPath)?.home ?? 'canonical';",
    to: "  const home = 'canonical';",
    why: 'a legacy-home macro points at a file that does not exist',
  },

  {
    id: 'P4', file: STATE, tests: [T12],
    from: "    const conflict = verdict === 'conflict';",
    to: '    const conflict = false;',
    why: 'a conflict verdict opens plan-approval, so a disputed plan is approvable',
  },
  {
    id: 'P5', file: STATE, tests: [T12],
    from: '  if (verdict !== undefined && !PLAN_VERIFY_VERDICTS.has(verdict)) {',
    to: '  if (false) {',
    why: 'a misspelt verdict (CONFLICT, agree) is read as "no conflict"',
  },

  // ---- L: the lock -----------------------------------------------------------------
  // Each removes the lock and the ownership recheck together, so the write
  // still succeeds and only the concurrency guarantee is lost.
  {
    id: 'L1', tests: [T12],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, {
        file: STATE,
        from: "  ensureNotArchived(workflowPath, 'plan-approve');\n  return withFileLock(workflowPath, async ({ lockPath, token }) => {",
        to: "  ensureNotArchived(workflowPath, 'plan-approve');\n  return (async (fn) => fn({}))(async ({ lockPath, token }) => {",
      });
      tools.applyEdit(copy, {
        file: STATE,
        from: '      { lockPath, token },\n    );\n    return { frontmatter, workflowPath, planHash, approvedAt: nowIso, noop: false };',
        to: '      null,\n    );\n    return { frontmatter, workflowPath, planHash, approvedAt: nowIso, noop: false };',
      });
    },
    why: 'plan-approve writes without the macro lock, racing plan-set and the gate writes',
  },
  {
    id: 'L2', tests: [T12],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, {
        file: STATE,
        from: "  ensureNotArchived(workflowPath, 'awaiting-owner-clear');\n  return withFileLock(workflowPath, async ({ lockPath, token }) => {",
        to: "  ensureNotArchived(workflowPath, 'awaiting-owner-clear');\n  return (async (fn) => fn({}))(async ({ lockPath, token }) => {",
      });
      tools.applyEdit(copy, {
        file: STATE,
        from: '      { lockPath, token },\n    );\n    return { frontmatter, workflowPath };\n  });\n}\n\n/**\n * ADR-0063 D6 — the owner approves',
        to: '      null,\n    );\n    return { frontmatter, workflowPath };\n  });\n}\n\n/**\n * ADR-0063 D6 — the owner approves',
      });
    },
    why: 'awaiting-owner-clear writes without the macro lock',
  },

  // ---- G: the owner gates --------------------------------------------------------
  {
    id: 'G1', file: STATE, tests: [T12],
    from: "    if (current !== gate && !(current === 'plan-approval' && gate === 'plan-conflict')) {",
    to: '    if (false) {',
    why: 'plan-approval is set over plan-conflict, and the conflict disappears',
  },
  {
    id: 'G2', file: STATE, tests: [T12],
    from: "    if (current !== gate && !(current === 'plan-approval' && gate === 'plan-conflict')) {",
    to: '    if (current !== gate) {',
    why: 'the conflict path cannot raise the gate plan-set opened',
  },
  {
    id: 'G3', file: STATE, tests: [T12],
    from: "    if (frontmatter.plan_approval_status !== 'pending') {",
    to: '    if (false) {',
    why: 'a gate is set on a plan that is not pending approval',
  },
  {
    id: 'G4', file: STATE, tests: [T12],
    from: "  refuseUnderAutopilot(env, 'awaiting-owner-clear');",
    to: '',
    why: 'an autopilot run clears the conflict it is supposed to halt on',
  },
  {
    id: 'G5', file: STATE, tests: [T12],
    from: "    setMacroGate(frontmatter, 'plan-approval', {\n      since: nowIso,",
    to: "    clearMacroGate(frontmatter); ({\n      since: nowIso,",
    why: 'clearing plan-conflict leaves a pending plan with no gate',
  },
  {
    id: 'G6', file: STATE, tests: [T12],
    from: "    if (gate === 'plan-approval') {",
    to: '    if (false) {',
    why: 'plan-approval is cleared without approving',
  },

  // ---- A: plan-approve -----------------------------------------------------------
  {
    id: 'A1', file: STATE, tests: [T12],
    from: "  refuseUnderAutopilot(env, 'plan-approve');",
    to: '',
    why: 'an autopilot run approves its own plan',
  },
  {
    id: 'A2', file: STATE, tests: [T12],
    from: '    if (expectHash !== undefined && expectHash !== planHash) {',
    to: '    if (false) {',
    why: 'a plan that changed after it was shown is approved',
  },
  {
    id: 'A3', file: STATE, tests: [T12],
    from: "    if (frontmatter.awaiting_owner_gate === 'plan-conflict') {",
    to: '    if (false) {',
    why: 'a plan the ensemble disagreed on is approved without the conflict being decided',
  },
  {
    id: 'A4', file: STATE, tests: [T12],
    from: "      frontmatter.plan_approval_status === 'approved'\n      && frontmatter.plan_approval_plan_hash === planHash\n",
    to: '      false\n',
    why: 'approving the same hash again rewrites the approval time',
  },
  {
    id: 'A5', file: STATE, tests: [T12],
    from: '    if (subtasks.length === 0) {\n      throw',
    to: '    if (false) {\n      throw',
    why: 'an empty plan is approved',
  },
  {
    id: 'A6', file: STATE, tests: [T12],
    from: "    if (frontmatter.terminal_marker === true) {\n      throw new Error(\n        `plan-approve:",
    to: "    if (false) {\n      throw new Error(\n        `plan-approve:",
    why: 'a closed macro is approved',
  },
  {
    id: 'A7', file: STATE, tests: [T12],
    from: '    frontmatter.plan_approval_plan_hash = planHash;',
    to: '    frontmatter.plan_approval_plan_hash = computePlanHash([]);',
    why: 'the approval records a hash that is not the plan\'s',
  },

  // ---- N: next-ready -------------------------------------------------------------
  {
    id: 'N1', file: STATE, tests: [T12],
    from: '          process.stdout.write(`${JSON.stringify({ ready: subtasks[readyIdx], approval })}\\n`);',
    to: '          process.stdout.write(`${JSON.stringify({ ready: subtasks[readyIdx] })}\\n`);',
    why: 'the ready shape, the one the driver dispatches from, carries no approval',
  },
  {
    id: 'N2', file: STATE, tests: [T12],
    from: '  return { status, hash_ok: frontmatter.plan_approval_plan_hash === computePlanHash(subtasks) };',
    to: '  return { status, hash_ok: true };',
    why: 'an approval whose hash no longer matches reads as valid',
  },

  // ---- R: the runbooks -------------------------------------------------------------
  {
    id: 'R1', file: PLAN_MD, tests: [TRB],
    from: '  --verdict "$VERDICT" \\\n  --event updated\n',
    to: '  --event updated\n',
    why: '/orchestrator:plan writes a disputed plan with the plan-approval gate, so it is approvable',
  },
  {
    id: 'R4', file: PLAN_MD, tests: [TRB],
    from: '  --event updated --require-open || exit 1\n',
    to: '  --event updated --require-open\n',
    why: 'a refused append (terminal macro) is followed by the ensemble commit anyway',
  },
  {
    id: 'R5', file: APPROVE_MD, tests: [TRB],
    from: 'const keys=["id","label","verb","profile","branch","blocked_by","topic"];',
    to: 'const keys=["id","label","verb","profile","branch","blocked_by"];',
    why: 'the topic, which the hash covers and dispatch passes to the engineer, is approved unseen',
  },
  {
    id: 'R2', file: APPROVE_MD, tests: [TRB],
    from: '  --expect-hash "$PLAN_HASH" || exit 1',
    to: '  || exit 1',
    why: '/orchestrator:approve approves whatever the plan is by then, not what it showed',
  },
  {
    id: 'R3', file: APPROVE_MD, tests: [TRB],
    from: '    MACRO_PATH="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-macro --repo-root "$REPO_ROOT" --subtask-branch "$GIT_BRANCH")" || exit 1',
    to: '    :',
    why: 'the command cannot find the macro from a subtask branch',
  },

  {
    id: 'R6', file: APPROVE_MD, tests: [TRB],
    from: '.replace(/\\r\\n|\\r|\\n/g,"\\\\n");',
    to: '.replace(/\\r?\\n/g,"\\\\n");',
    why: 'a lone carriage return in a topic reaches the terminal and overwrites the row',
  },

  // ---- F: forward compatibility ---------------------------------------------------
  {
    id: 'F1', tests: [TFC],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, {
        file: STATE,
        from: "  'terminal_marker',\n  // ADR-0063 D6 (1.2)",
        to: '  // ADR-0063 D6 (1.2)',
      });
      tools.applyEdit(copy, {
        file: STATE,
        from: "  'awaiting_owner_pointer',\n];",
        to: "  'awaiting_owner_pointer',\n  'terminal_marker',\n];",
      });
    },
    why: 'the 1.2 keys are not at the tail, so every 1.1 reader write reorders them',
  },

  // ---- T: the tests' own controls ----------------------------------------------------
  {
    id: 'T1', file: T12, tests: [T12],
    from: '  delete env.AGENTIC_AUTOPILOT;',
    to: '  void 0;',
    why: 'owner actions inherit the runner\'s AGENTIC_AUTOPILOT and are refused for the wrong reason',
  },
  {
    id: 'T2', file: TFC, tests: [TFC],
    from: "    .replace(keyOrderLine, '')\n",
    to: '',
    why: 'the "1.1 reader" still knows the keys, so the carrier path is never exercised',
  },
  {
    id: 'T3', file: TFC, tests: [TFC],
    from: "    .replace(reset, '');",
    to: ';',
    why: 'the "1.1 writer" still resets approval, so the stale-approval case never arises',
  },
];
