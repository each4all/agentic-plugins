// Mutation spec — do the C67 tests catch the defects they exist for?
//
// Run: npm run mutate -- scripts/mutation-specs/command-substitution.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. The defect is invisible to a test that runs a
// command file as written: Claude rewrites `$1` before the agent reads it, so
// the file and the runbook the agent runs differ. A green suite shows only
// that the file works. Putting each defect back, and taking the rendering out
// of the runbook test, shows which test sees what. The harness counts any
// failure as a kill, so each F mutation names one test file, and the failing
// test names it prints are the ones to read.
//
// Groups: F the command bodies, G the guard, the port it relies on, and the
// runbook test's rendering.

const T_SHAPE = 'tests/plugin-shape/test-command-argument-substitution.mjs';
const T_DONE = 'tests/orchestrator/test-done-runbook.mjs';
const PORT = 'tests/_claude-command-substitution.mjs';
const DONE = 'plugins/orchestrator/commands/done.md';
const NEXT = 'plugins/orchestrator/commands/next.md';

export const TESTS = [T_SHAPE, T_DONE];

const SUBTASK_READ = `SUBTASK_BRANCH="$(printf '%s' "$SUBTASK_JSON" | JSON_KEY=branch node -e "$JSON_FIELD")"`;
const SUBTASK_READ_POSITIONAL =
  `field() { printf '%s' "$SUBTASK_JSON" | JSON_KEY="$1" node -e "$JSON_FIELD"; }\nSUBTASK_BRANCH="$(field branch)"`;
const LANDING_READ = `COMMIT_SHA="$(printf '%s' "$LANDING" | JSON_KEY=commit node -e "$JSON_FIELD")"`;
const LANDING_READ_POSITIONAL =
  `landing() { printf '%s' "$LANDING" | JSON_KEY="$1" node -e "$JSON_FIELD"; }\nCOMMIT_SHA="$(landing commit)"`;

export const MUTATIONS = [
  // ── F: the command bodies ────────────────────────────────────────────────
  {
    id: 'F1', file: DONE, tests: [T_SHAPE], from: SUBTASK_READ, to: SUBTASK_READ_POSITIONAL,
    why: 'the subtask reader takes its key from "$1" again — the shape guard sees the token',
  },
  {
    id: 'F2', file: DONE, tests: [T_DONE], from: SUBTASK_READ, to: SUBTASK_READ_POSITIONAL,
    why: 'the subtask reader takes its key from "$1" again — the rendered runbook reads a flag as the key',
  },
  {
    id: 'F3', file: DONE, tests: [T_SHAPE], from: LANDING_READ, to: LANDING_READ_POSITIONAL,
    why: 'the landing reader takes its key from "$1" again — the shape guard sees the token',
  },
  {
    id: 'F4', file: DONE, tests: [T_DONE], from: LANDING_READ, to: LANDING_READ_POSITIONAL,
    why: 'the landing reader takes its key from "$1" again — the rendered runbook records no commit',
  },
  {
    id: 'F5', file: NEXT, tests: [T_SHAPE],
    from: '## Phase 0 — Workflow continuity',
    to: 'An escaped `\\$1` is read as a bare one.\n\n## Phase 0 — Workflow continuity',
    why: 'an escaped positional token only: Claude eats the backslash, so the guard must not',
  },
  {
    id: 'F6', file: NEXT, tests: [T_SHAPE],
    from: '## Phase 0 — Workflow continuity',
    to: 'The subtask id is `$ARGUMENTS[0]`.\n\n## Phase 0 — Workflow continuity',
    why: 'an indexed argument token',
  },
  {
    id: 'F7', file: DONE, tests: [T_SHAPE],
    from: 'argument-hint: <subtask-id>',
    to: 'arguments: [subtask]\nargument-hint: <subtask-id>',
    why: 'a named-argument declaration makes $<name> a substitution',
  },
  {
    id: 'F8', file: NEXT, tests: [T_SHAPE],
    from: '# Follow $ENGINEER_PLUGIN_ROOT/commands/$SUBTASK_VERB.md as if the user',
    to: '# $ARGUMENTS\n# Follow $ENGINEER_PLUGIN_ROOT/commands/$SUBTASK_VERB.md as if the user',
    why: 'typed text lands in a bash block the ADR-0059 list does not name (the next.md comment C67 reworded)',
  },
  {
    id: 'F9', file: DONE, tests: [T_DONE],
    from: SUBTASK_READ,
    to: `SUBTASK_BRANCH="$(echo "$SUBTASK_JSON" | JSON_KEY=branch node -e "$JSON_FIELD")"`,
    why: 'the document goes through echo again, which zsh (and bash under xpg_echo) lets expand the escapes in JSON',
  },
  {
    id: 'F10', file: DONE, tests: [T_DONE],
    from: SUBTASK_READ,
    to: `SUBTASK_BRANCH="$(JSON_DOC="$SUBTASK_JSON" JSON_KEY=branch node -e 'process.stdout.write(String(JSON.parse(process.env.JSON_DOC)[process.env.JSON_KEY] ?? ""))')"`,
    why: 'the document goes through the environment, which an exec bounds in size',
  },

  // ── G: the guard, the port, and the rendering ────────────────────────────
  {
    id: 'G1', file: T_SHAPE, tests: [T_SHAPE],
    from: "  { name: 'positional parameter', re: /\\$\\d/g },",
    to: "  { name: 'positional parameter', re: /(?<!\\\\)\\$\\d/g },",
    why: 'the scanner skips the escaped form; the check against the port must notice',
  },
  {
    id: 'G2', file: 'plugins/runtime/commands/doctor.md', tests: [T_SHAPE],
    from: 'node "$RUNTIME_ROOT/scripts/doctor.mjs" --repo-root "$REPO_ROOT" $ARGUMENTS',
    to: 'node "$RUNTIME_ROOT/scripts/doctor.mjs" --repo-root "$REPO_ROOT"',
    why: 'a splice line goes but the list still names it — the list is exact, so it stays true as ADR-0059 lands',
  },
  {
    id: 'G3', file: PORT, tests: [T_SHAPE],
    from: '    const token = tokens[parseInt(digits, 10)];\n    if (token === undefined) return whole;',
    to: '    const token = tokens[parseInt(digits, 10) - 1];\n    if (token === undefined) return whole;',
    why: 'the port counts $N from 1; the measured cells must notice',
  },
  {
    id: 'G4', file: PORT, tests: [T_SHAPE],
    from: "'g'), PROTECTED_DOLLAR);",
    to: "'g'), (m) => m);",
    why: 'the port keeps the backslash of \\$1; the measured cells must notice',
  },
  {
    id: 'G5', file: PORT, tests: [T_SHAPE],
    from: '  return argv && argv.length > 0 ? argv : args.split(/\\s+/).filter(Boolean);',
    to: '  return args.split(/\\s+/).filter(Boolean);',
    why: 'the port splits on whitespace only; the quoted and shell-syntax cells must notice',
  },
  {
    id: 'G6', file: T_DONE, tests: [T_DONE],
    from: "import { substituteClaudeArguments } from '../_claude-command-substitution.mjs';",
    to: 'const substituteClaudeArguments = (text) => text;',
    why: 'the runbook test stops rendering and runs the file as written again (the C67 blind spot); its check that the substitution ran must fail',
  },
  {
    id: 'G7', file: T_DONE, tests: [T_DONE],
    from: 'const renderPhases = (args) => substituteClaudeArguments(PHASES, args, { appendIfUnused: false });',
    to: "const renderPhases = (args) => { const w = substituteClaudeArguments(DONE_TEXT, args); return w.slice(w.indexOf('## Phase 0'), w.indexOf('## Completion')); };",
    why: 'the section is found after rendering, so typed headings can move it',
  },
];
