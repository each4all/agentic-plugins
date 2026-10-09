// Mutation spec — do the ADR-0067 Decision 3 (B′) tests catch the defects
// they exist for?
//
// Run: npm run mutate -- scripts/mutation-specs/parent-workflow-path.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. Every rule here fails quietly. A child that
// does not record its macro's path is still a valid, linked child; a
// writeback that ignores the path still writes back wherever the macro
// happens to sit under the child's own checkout; a writeback that guesses
// past a wrong file, or picks one of two copies, writes a plausible note to
// the wrong record. Only a lane or a cutover shows the difference. Each
// mutation below removes one rule and names the test that must notice.
//
// The mutations edit the generated copies the tests import (ADR-0066):
// engineer is the one persona with dispatch_target on; founder carries the
// off side.
//
// Groups: C create (the key, its place, its checks), W the writeback's
// resolution, O the orchestrator's re-check under its lock, S the callers
// that pass the path, D the dispatch (next.md, its Codex mirror and the
// bootstrap), E the scrubs.

const T_PATH = 'tests/persona-pipeline/test-parent-workflow-path.mjs';
const T_COMPAT = 'tests/persona-pipeline/test-state-schema-forward-compat.mjs';
const T_STOP = 'tests/persona-pipeline/test-stop-archive.mjs';
const T_P7 = 'tests/persona-pipeline/test-phase7-commit.mjs';
const T_NEXT = 'tests/orchestrator/test-next-parent-path.mjs';
const T_WORKER = 'tests/orchestrator/test-autopilot-worker.mjs';
const T_HERMETIC = 'tests/test-hermetic-env.mjs';
const T_TERMINAL = 'tests/orchestrator/test-engineer-terminal.mjs';

const STATE = 'plugins/engineer/scripts/state.mjs';
const FOUNDER_STATE = 'plugins/founder/scripts/state.mjs';
const WRITEBACK = 'plugins/engineer/scripts/parent-writeback.mjs';
const STOP = 'plugins/engineer/scripts/stop-archive.mjs';
const PHASE7 = 'plugins/engineer/scripts/phase7-commit.mjs';
const COMPOSE = 'plugins/engineer/commands/compose.md';
const FRAME = 'plugins/engineer/commands/frame.md';
const NEXT = 'plugins/orchestrator/commands/next.md';
const CODEX_NEXT = 'plugins/orchestrator/core/skills/next/SKILL.md';
const ORCH_STATE = 'plugins/orchestrator/scripts/state.mjs';
const WORKER = 'plugins/orchestrator/adapters/claude/autopilot/worker.mjs';
const SESSION_ENV = 'scripts/lib/session-env.mjs';

export const TESTS = [T_PATH, T_COMPAT, T_STOP, T_P7, T_NEXT, T_WORKER, T_HERMETIC, T_TERMINAL];

export const MUTATIONS = [
  // ---- C: create --------------------------------------------------------------
  {
    id: 'C1', file: STATE, tests: [T_PATH],
    from: '    frontmatter.parent_workflow_path = parentWorkflowPath;',
    to: '    void parentWorkflowPath;',
    why: 'create checks the path but does not record it',
    killed_by: /records the path beside the two ids, last in the frontmatter/,
  },
  {
    id: 'C2', file: STATE, tests: [T_COMPAT],
    from: "    order.push('parent_workflow_path');",
    to: "    order.splice(order.indexOf('next_step_kind'), 0, 'parent_workflow_path');",
    why: 'the key sits before keys an older reader knows, so that reader\'s writes move it',
    killed_by: /the key sits last, and the previous reader round-trips it byte for byte/,
  },
  {
    id: 'C3', file: STATE, tests: [T_PATH],
    from: '    const problem = await checkParentWorkflowPath(parentWorkflowPath, frontmatter.parent_workflow);',
    to: '    const problem = null;',
    why: 'create records any path, one naming no file or another macro included',
    killed_by: /refuses, writing nothing: the path without the ids, a malformed path/,
  },
  {
    id: 'C4', file: STATE, tests: [T_PATH],
    from: '  if (parentWorkflowPath !== undefined && parentWorkflowPath !== null) {',
    to: "  if (('parent_workflow' in frontmatter) || (parentWorkflowPath !== undefined && parentWorkflowPath !== null)) {",
    why: 'the ids without a path (an older orchestrator) are refused',
    killed_by: /the ids without a path stay valid, and record no path/,
  },
  {
    id: 'C5', file: FOUNDER_STATE, tests: [T_PATH],
    from: "        if (!capabilityOn('dispatch_target') && flags['parent-workflow-path'] !== undefined) {",
    to: '        if (false) {',
    why: 'a persona that is no dispatch target silently drops the flag',
    killed_by: /the flag is refused, alone or with a path that names a real macro/,
  },

  // ---- W: the writeback's resolution ------------------------------------------
  {
    id: 'W1', file: WRITEBACK, tests: [T_PATH],
    from: '  const recordedPath = parentWorkflowPath ?? null;',
    to: '  const recordedPath = null;',
    why: 'the recorded path is ignored: a macro in another checkout is never reached',
    killed_by: /writes back through the recorded path when the candidates under repoRoot would miss/,
  },
  {
    id: 'W2', file: WRITEBACK, tests: [T_PATH],
    from: '    const { physical, problem } = await inspectMacroFile(recordedPath, parentWorkflowId);',
    to: '    const { physical, problem } = { physical: realpathSync(recordedPath), problem: null };',
    why: 'a recorded path naming another macro\'s file is taken as the macro',
    killed_by: /refuses a recorded path naming a file that is not the macro, or a malformed one/,
  },
  {
    id: 'W3', file: WRITEBACK, tests: [T_PATH],
    from: '    const shape = parentPathShapeProblem(recordedPath, parentWorkflowId);',
    to: '    const shape = null;',
    why: 'a malformed recorded path is not refused, so the candidates are searched past it',
    killed_by: /refuses a recorded path naming a file that is not the macro, or a malformed one/,
  },
  {
    id: 'W4', file: WRITEBACK, tests: [T_PATH],
    from: '  if (copies.size > 1) {',
    to: '  if (false) {',
    why: 'two copies of the macro: one is picked and the other goes stale',
    killed_by: /refuses when a second file holds the macro id/,
  },
  {
    id: 'W5', file: WRITEBACK, tests: [T_PATH],
    from: '    const physical = physicalPath(candidatePath);',
    to: '    const physical = candidatePath;',
    why: 'one file reached through two spellings counts as two copies',
    killed_by: /refuses when a second file holds the macro id/,
  },
  {
    id: 'W6', file: WRITEBACK, tests: [T_PATH],
    from: '  if (recordedPhysical !== null) copies.set(recordedPhysical, recordedPath);',
    to: "  if (recordedPath !== null && !recordedNamesFile) return { ok: false, skipped: true, reason: 'parent-not-found' };\n  if (recordedPhysical !== null) copies.set(recordedPhysical, recordedPath);",
    why: 'a recorded path naming no file (the macro moved) ends the search',
    killed_by: /a recorded path that names no file falls back to the candidates/,
  },
  {
    id: 'W7', file: WRITEBACK, tests: [T_PATH],
    from: '    const archiveDirs = roots.flatMap(orchArchiveDirs);',
    to: '    const archiveDirs = readSet(resolve(repoRoot)).flatMap(orchArchiveDirs);',
    why: 'a macro archived in another checkout reads as a dangling linkage',
    killed_by: /a macro archived in the recorded home reads as archived/,
  },
  {
    id: 'W8', file: WRITEBACK, tests: [T_PATH],
    from: '    const { physical, problem } = await inspectMacroFile(candidatePath, parentWorkflowId);',
    to: '    const { physical, problem } = { physical: realpathSync(candidatePath), problem: null };',
    why: 'a candidate named after the macro but holding another one gets the note',
    killed_by: /refuses a candidate that is not the macro/,
  },
  {
    id: 'W9', file: WRITEBACK, tests: [T_PATH],
    from: '        archived = archiveEntries.some((name) => isArchivedName(name, parentWorkflowId));',
    to: '        archived = archiveEntries.some((name) => name.startsWith(parentWorkflowId));',
    why: 'the prefix match: another macro whose id starts with this one reads as this one archived',
    killed_by: /counts only `<id>\.md` or `<id>-…` in archive\/ as the macro archived/,
  },
  {
    id: 'W10', file: WRITEBACK, tests: [T_PATH],
    from: '  for (const [dir, candidate] of searchedDirs) {',
    to: '  for (const [dir, candidate] of (recordedPath === null ? [] : searchedDirs)) {',
    why: 'a child with no recorded path (written before ADR-0067) no longer writes back',
    killed_by: /writes back through the candidates under repoRoot, as before/,
  },
  {
    id: 'W11', file: WRITEBACK, tests: [T_PATH],
    from: '  if (shape) return { problem: `the file it resolves to, ${physical}: ${shape}` };',
    to: '  void shape;',
    why: 'a symlinked workflows home or macro file routes the note into an archived macro',
    killed_by: [/refuses a recorded path or a candidate that resolves into archive\/ through a symlink/, /refuses, writing nothing: the path without the ids, a malformed path/],
  },
  {
    id: 'W12', file: WRITEBACK, tests: [T_PATH],
    from: '    ...roots.flatMap(orchWorkflowDirs).map((dir) => [dir, true]),',
    to: '    ...readSet(resolve(repoRoot)).flatMap(orchWorkflowDirs).map((dir) => [dir, true]),',
    why: 'a second copy in the other home of the recorded checkout goes unseen, and a migrated macro is lost',
    killed_by: [/refuses when a second file holds the macro id/, /a recorded path in a legacy home reaches the macro there/],
  },
  {
    id: 'W13', file: WRITEBACK, tests: [T_PATH],
    from: '    if (Object.hasOwn(fields, key)) return { problem: `its frontmatter sets ${key} more than once` };',
    to: '    void 0;',
    why: 'a workflow_id written twice is read one way here and the other way by the orchestrator',
    killed_by: [/refuses a candidate whose frontmatter sets workflow_id twice/, /refuses, writing nothing: the path without the ids, a malformed path/],
  },
  {
    id: 'W14', file: WRITEBACK, tests: [T_PATH],
    from: "    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { kind: 'absent' };",
    to: "    return { kind: 'absent' };",
    why: 'a recorded path that cannot be inspected reads as missing, and the candidates are searched past it',
    killed_by: /refuses a recorded path it cannot inspect instead of searching the candidates/,
  },
  {
    id: 'W15', file: WRITEBACK, tests: [T_PATH],
    from: '    `--expect-workflow-id=${parentWorkflowId}`,',
    to: '',
    why: 'the orchestrator is not asked to re-check the id on its locked read',
    killed_by: /passes the macro id to the orchestrator for its re-check under the lock/,
  },
  {
    id: 'W16', file: WRITEBACK, tests: [T_PATH],
    from: '  return { physical };',
    to: '  return { physical: path };',
    why: 'the orchestrator is handed a symlink\'s spelling: its atomic replace turns the link into a copy holding the note, and the macro stays unchanged',
    killed_by: /writes the macro itself when a candidate or the recorded path is a symlink to it/,
  },
  {
    id: 'W17', file: WRITEBACK, tests: [T_PATH],
    from: '  if (recordedPhysical !== null) copies.set(recordedPhysical, recordedPath);',
    to: '  if (recordedPhysical !== null) copies.set(recordedPath, recordedPath);',
    why: 'the recorded path counts by its spelling, so the same file found in its checkout\'s home reads as a second copy and the writeback is refused',
    killed_by: /a recorded path spelled through a symlinked checkout is one file/,
  },
  {
    id: 'O1', file: ORCH_STATE, tests: [T_TERMINAL],
    from: '    if (expectWorkflowId !== undefined && frontmatter.workflow_id !== expectWorkflowId) {',
    to: '    if (false) {',
    why: 'the orchestrator writes a note to a file that holds another macro by the time it locks it',
    killed_by: /refuses a file whose workflow_id is not the expected one, on the locked read/,
  },

  // ---- S: the callers pass the path ---------------------------------------------
  {
    id: 'S1', file: STOP, tests: [T_STOP],
    from: '      parentWorkflowPath: frontmatter.parent_workflow_path,',
    to: '      parentWorkflowPath: undefined,',
    why: 'the Stop (and the sweep) drop the recorded path',
    killed_by: /notes the terminal commit through the recorded parent_workflow_path when its own checkout holds no copy/,
  },
  {
    id: 'S2', file: PHASE7, tests: [T_P7],
    from: '      parentWorkflowPath: fresh.parent_workflow_path,',
    to: '      parentWorkflowPath: undefined,',
    why: 'Phase 7\'s P10 drops the recorded path',
    killed_by: /P10 — a child whose checkout holds no copy of the macro notes it through the recorded parent_workflow_path/,
  },

  // ---- D: the dispatch ------------------------------------------------------------
  {
    id: 'D1', file: NEXT, tests: [T_NEXT],
    from: 'export AGENTIC_PARENT_WORKFLOW_PATH="$MACRO_PATH"',
    to: ': no path export',
    why: '/orchestrator:next exports no path, so no child records one',
    killed_by: [/bash, compose: the dispatched child records parent_workflow_path/, /bash, frame: the dispatched child records parent_workflow_path/],
  },
  {
    id: 'D2', file: COMPOSE, tests: [T_NEXT],
    from: '    PARENT_ARGS+=(--parent-workflow-path "$AGENTIC_PARENT_WORKFLOW_PATH")',
    to: '    :',
    why: 'the profiled bootstrap does not pass the path to create',
    killed_by: /bash, compose: the dispatched child records parent_workflow_path/,
  },
  {
    id: 'D3', file: FRAME, tests: [T_NEXT],
    from: '    PARENT_ARGS+=(--parent-workflow-path "$AGENTIC_PARENT_WORKFLOW_PATH")',
    to: '    :',
    why: 'the plain bootstrap does not pass the path to create',
    killed_by: /bash, frame: the dispatched child records parent_workflow_path/,
  },
  {
    id: 'D4', file: COMPOSE, tests: [T_NEXT],
    from: 'elif [ -n "${AGENTIC_PARENT_WORKFLOW_PATH:-}" ]; then',
    to: 'elif false; then',
    why: 'a path without the ids creates an unlinked workflow instead of stopping',
    killed_by: /bash, compose: the path without the two ids stops the bootstrap before any write/,
  },
  {
    id: 'D6', file: CODEX_NEXT, tests: [T_NEXT],
    from: 'export AGENTIC_PARENT_WORKFLOW_PATH="$MACRO_PATH"',
    to: ': no path export',
    why: '$orchestrator:next on Codex exports no path, so its children record none',
    killed_by: /bash, Codex prelude: the dispatched child records parent_workflow_path/,
  },
  {
    id: 'D7', file: FRAME, tests: [T_NEXT],
    from: 'elif [ -n "${AGENTIC_PARENT_WORKFLOW_PATH:-}" ]; then',
    to: 'elif false; then',
    why: 'the plain bootstrap creates an unlinked workflow from a path without the ids',
    killed_by: /bash, frame: the path without the two ids stops the bootstrap before any write/,
  },
  {
    id: 'D5', file: COMPOSE, tests: [T_NEXT],
    from: '  if [ -n "${AGENTIC_PARENT_WORKFLOW_PATH:-}" ]; then',
    to: '  if true; then',
    why: 'the bootstrap passes an empty path when an older orchestrator exports none',
    killed_by: /bash: an orchestrator that exports no path still dispatches a child linked by id/,
  },

  // ---- E: the scrubs --------------------------------------------------------------
  {
    id: 'E1', file: WORKER, tests: [T_WORKER],
    from: "  'AGENTIC_PARENT_WORKFLOW_PATH',",
    to: '',
    why: 'an inherited macro path reaches the worker and points its child at a foreign macro',
    killed_by: /scrubs the launching session and the dispatch contract/,
  },
  {
    id: 'E2', file: SESSION_ENV, tests: [T_HERMETIC],
    from: "  'AGENTIC_PARENT_WORKFLOW_PATH',",
    to: '',
    why: 'a test run inside a dispatched session inherits the macro path (C88)',
    killed_by: /the dispatch contract is scrubbed by name/,
  },
];
