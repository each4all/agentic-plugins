// Mutation spec — do the engineer schema 1.4 tests catch the defects they
// exist for? (ADR-0063 D6, slice S1)
//
// Run: npm run mutate -- scripts/mutation-specs/engineer-schema-14.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. The autopilot driver will halt or proceed on
// these keys alone, so each rule fails in a way nobody sees at the time: a
// stale next_step_verb sends the driver to the wrong verb, a half-written
// awaiting_owner reads as "not waiting", an autopilot run that clears an owner
// gate removes the only thing that would have stopped it, and a key that is
// not at the tail is reordered by every 1.3 reader that touches the file.
//
// Groups: V the validator, W the write paths, G the owner gates, A the
// autopilot predicate, B the phase-note boundary, F forward compatibility,
// T the tests' own controls. V8, W7, W8, G6–G9 and B1 are the survivors the
// Codex Plan-verify review found against the first version of the tests.

const T14 = 'tests/engineer/test-state-schema-14.mjs';
const TFC = 'tests/engineer/test-state-schema-forward-compat.mjs';

const STATE = 'plugins/engineer/scripts/state.mjs';

export const TESTS = [T14, TFC];

export const MUTATIONS = [
  // ---- V: the parser's validator ---------------------------------------------
  {
    id: 'V1', file: STATE, tests: [T14],
    from: "  if (('next_step_kind' in fm) !== ('next_step_confidence' in fm)) {",
    to: '  if (false) {',
    why: 'a next step without a confidence (or the reverse) passes',
  },
  {
    id: 'V2', file: STATE, tests: [T14],
    from: "  if (('next_step_verb' in fm) !== (fm.next_step_kind === 'verb')) {",
    to: '  if (false) {',
    why: 'a verb survives next to kind=commit, or kind=verb names no verb',
  },
  {
    id: 'V3', file: STATE, tests: [T14],
    from: '  if (present.length > 0 && present.length < awaiting.length) {',
    to: '  if (false) {',
    why: 'a half-written awaiting_owner parses as not waiting',
  },
  {
    id: 'V4', file: STATE, tests: [T14],
    from: "    !value.includes('..');",
    to: '    true;',
    why: 'a pointer can climb out of the repository',
  },
  {
    id: 'V5', file: STATE, tests: [T14],
    from: "    !value.startsWith('/') &&",
    to: '',
    why: 'a pointer can be absolute',
  },
  {
    id: 'V6', file: STATE, tests: [T14],
    from: '    isoUtc(Date.parse(value)) === value;',
    to: '    true;',
    why: 'an impossible date (Feb 30) is stored as since',
  },
  {
    id: 'V7', file: STATE, tests: [T14],
    from: "    validateEnumScalar('awaiting_owner_gate', fm.awaiting_owner_gate, VALID_ENGINEER_OWNER_GATES);",
    to: '',
    why: 'a macro-owned gate (plan-approval) is stored on an engineer workflow',
  },

  {
    id: 'V8', file: STATE, tests: [T14],
    from: "  'scope-routing',\n  'decide-conflict',",
    to: "  'decide-conflict',",
    why: 'a routing refusal can no longer be recorded as an owner gate',
  },

  // ---- W: the write paths ----------------------------------------------------
  {
    id: 'W1', file: STATE, tests: [T14],
    from: '  for (const k of NEXT_STEP_KEYS) delete frontmatter[k];',
    to: '',
    why: 'a new next step keeps the previous next_step_verb',
  },
  {
    id: 'W2', file: STATE, tests: [T14],
    from: '  Object.assign(frontmatter, write);\n',
    to: '  Object.assign(frontmatter, write);\n  frontmatter.schema = SCHEMA_VERSION;\n',
    why: 'a next_step write silently promotes a 1.3 file to 1.4',
  },
  {
    id: 'W3', file: STATE, tests: [T14],
    from: "          clearNextStep: cliBoolean(flags, 'clear-next-step', false),",
    to: '          clearNextStep: false,',
    why: '--clear-next-step is accepted and ignored, so a crashed verb leaves the previous next step',
  },
  {
    id: 'W4', file: STATE, tests: [T14],
    from: "          nextStep: cliNextStep(flags),\n          event: flags.event ?? 'updated',",
    to: "          event: flags.event ?? 'updated',",
    why: 'set-terminal drops the next step the interactive verb recorded',
  },
  {
    id: 'W5', file: STATE, tests: [T14],
    from: "  if (clearNextStep && nextStep !== undefined) {",
    to: '  if (false) {',
    why: 'clear and write together: one of them is silently ignored',
  },
  {
    id: 'W6', file: STATE, tests: [T14],
    from: "  if (v === 'false') return false;\n  throw new Error",
    to: "  if (v === 'false') return false;\n  return false;\n  throw new Error",
    why: 'a typo in --clear-next-step reads as false',
  },

  {
    id: 'W7', file: STATE, tests: [T14],
    from: "  if (v === 'false') return false;",
    to: "  if (v === 'false') return true;",
    why: '--clear-next-step false clears the next step',
  },
  {
    id: 'W8', file: STATE, tests: [T14],
    from: '    applyNextStepWrite(frontmatter, nextStepWrite);\n    frontmatter.terminal_marker = terminalMarker;',
    to: '    applyNextStepWrite(frontmatter, nextStepWrite);\n    frontmatter.schema = SCHEMA_VERSION;\n    frontmatter.terminal_marker = terminalMarker;',
    why: 'set-terminal silently promotes a 1.3 file to 1.4',
  },

  // ---- G: the owner gates ----------------------------------------------------
  {
    id: 'G1', file: STATE, tests: [T14],
    from: '  if (current !== undefined && current !== fields.awaiting_owner_gate) {',
    to: '  if (false) {',
    why: 'a second gate overwrites the first',
  },
  {
    id: 'G2', file: STATE, tests: [T14],
    from: '    if (current !== gate) {',
    to: '    if (false) {',
    why: 'clearing one gate clears a different one',
  },
  {
    id: 'G3', file: STATE, tests: [T14],
    from: '    if (current === undefined) {',
    to: '    if (false) {',
    why: 'clearing when nothing is set reports a mismatch instead of the real state',
  },
  {
    id: 'G4', file: STATE, tests: [T14],
    from: '  if (isAutopilotRun(env)) {',
    to: '  if (false) {',
    why: 'an autopilot run clears the owner gate that should stop it (ADR-0063 Q2)',
  },
  {
    id: 'G5', file: STATE, tests: [T14],
    from: '      `### Owner gate resolved: ${gate} at ${nowIso}\\n\\n` +',
    to: '      `` +',
    why: 'the resolution leaves no record once the keys are deleted',
  },

  {
    id: 'G6', file: STATE, tests: [T14],
    from: '  Object.assign(frontmatter, fields);\n',
    to: '  Object.assign(frontmatter, fields);\n  frontmatter.schema = SCHEMA_VERSION;\n',
    why: 'awaiting-owner-set silently promotes a 1.3 file to 1.4',
  },
  {
    id: 'G7', file: STATE, tests: [T14],
    from: '    for (const k of AWAITING_OWNER_KEYS) delete frontmatter[k];',
    to: '    for (const k of AWAITING_OWNER_KEYS) delete frontmatter[k];\n    frontmatter.schema = SCHEMA_VERSION;',
    why: 'awaiting-owner-clear silently promotes a 1.3 file to 1.4',
  },
  {
    id: 'G8', file: STATE, tests: [T14],
    from: '    for (const k of AWAITING_OWNER_KEYS) delete frontmatter[k];',
    to: '    for (const k of [...AWAITING_OWNER_KEYS, ...NEXT_STEP_KEYS]) delete frontmatter[k];',
    why: 'resolving the owner gate also erases the next step the verb recorded',
  },
  {
    id: 'G9', file: STATE, tests: [T14],
    from: '    awaiting_owner_since: ownerGate.since ?? isoUtc(now),',
    to: "    awaiting_owner_since: ownerGate.since ?? '2000-01-01T00:00:00Z',",
    why: 'since defaults to a fixed instant instead of now',
  },

  // ---- A: the autopilot predicate --------------------------------------------
  {
    id: 'A1', file: STATE, tests: [T14],
    from: "  return /^autopilot-\\d{8}T\\d{6}Z-[0-9a-f]{6}$/.test(env?.AGENTIC_AUTOPILOT ?? '');",
    to: "  return Boolean(env?.AGENTIC_AUTOPILOT);",
    why: 'any non-empty AGENTIC_AUTOPILOT, e.g. an accidental global export, turns autopilot on',
  },

  // ---- B: the phase-note boundary ---------------------------------------------
  {
    id: 'B1', file: STATE, tests: [T14],
    from: "  const sep = body.length === 0 || body.endsWith('\\n') ? '' : '\\n';",
    to: "  const sep = '';",
    why: 'a heading appended to a body that ends without a newline joins the previous line',
  },

  // ---- F: forward compatibility ----------------------------------------------
  {
    id: 'F1', tests: [TFC],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, {
        file: STATE,
        from: "  'parent_writeback_at',\n  // ADR-0063 D6 schema 1.4",
        to: '  // ADR-0063 D6 schema 1.4',
      });
      tools.applyEdit(copy, {
        file: STATE,
        from: "  'awaiting_owner_pointer',\n];",
        to: "  'awaiting_owner_pointer',\n  'parent_writeback_at',\n];",
      });
    },
    why: 'the 1.4 keys are not at the tail, so every 1.3 reader write reorders them',
  },

  // ---- T: the tests' own controls --------------------------------------------
  {
    id: 'T1', file: T14, tests: [T14],
    from: '  delete env.AGENTIC_AUTOPILOT;',
    to: '  void 0;',
    why: 'the CLI child inherits the runner\'s AGENTIC_AUTOPILOT, so clears are refused for the wrong reason',
  },
  {
    id: 'T2', file: TFC, tests: [TFC],
    from: "  const reader = src.replace(keyOrderLine, '')",
    to: '  const reader = src',
    why: 'the "1.3 reader" still knows the keys, so the carrier path is never exercised',
  },
];
