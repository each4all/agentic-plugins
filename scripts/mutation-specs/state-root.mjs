// Mutation spec — do the ADR-0067 shared-state-root tests (subtask SR) catch
// the defects they exist for?
//
// Run: npm run mutate -- scripts/mutation-specs/state-root.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. Until the cutover, every rule here fails
// quietly: the default state root and the checkout are the same directory in
// a repository without linked worktrees, so a lookup that ignores the read
// set, a create that checks one home, or an archive that follows the caller
// still works there. Only a linked worktree, a second copy, or the switch
// shows the difference. Each mutation below removes one rule and names the
// test that must notice.
//
// The library tests import the canonical source
// (persona-pipeline/files/scripts/lib/state-root.mjs); the CLI tests run the
// generated copies (engineer's) and orchestrator's copy, so L* mutate the
// source, C* the copies. A source or orchestrator-copy mutation also breaks
// the byte-for-byte copy test; killed_by names the contract that must fail.
//
// Groups: L the library, C the CLI copies, W the persona writers, E the scrubs,
// U the units after U2: one writable copy (U2b), and the sidecar, peer runs and
// writeback of a record under another root (U3); O orchestrator's state script
// (U4a); P what derives from a macro under another root (U4b); V the second
// Plan-verify's findings (U4c): fail closed, a copy by workflow id, the branch
// key on path writes, the check under the lock, aliased homes, run ids; R the
// runbooks' --workflow=<id> resolvers (U5a); S the repository-wide scan set
// (U5b); X the third Plan-verify's findings (U4d): an unreadable identity, the
// caller's checkout, one file through two names, aliased slots, run-directory
// identity, the sweep's own directory, a FIFO or a vanished file in a scan.
// F the rest of U5b: finalize's and abort's child detach pass over the
// repository-wide scan set, and resume's archive <workflow-id> resolver; G the
// autopilot observer (U6): the pinned macro, archives and claims where the
// readers find them, pointers relative to the root holding the record. Y the
// fourth Plan-verify's findings (U4e): every --repo-root command in that
// checkout, a lost identity, the frontmatter read through, one rule for every
// run-directory listing, a file reached through two read roots. Z the
// driver's state root (U7a): resolved once, recorded, exported to workers. Q
// the fifth Plan-verify's findings (U4f): a --repo-root outside the repository,
// each ledger judged with all its names in view, a linear frontmatter read, a
// commondir link to nothing, the name that is not a link from every lister, a
// non-regular workflow name refused, an ensemble run refused before its ledger.
// K the admission entries (U7b): the interactive commands in the run locks,
// live until released, a run's workers passing by its secret. J the sixth
// Plan-verify's findings (U4g): a link is no run directory, as runtime's
// readers list them; a FIFO never waited on (the write guard, the listers, the
// Stop's macro facts, resolve-workflow, a commondir); the sweep's plan checked
// again before each change (ledger identity, selection); runPeer and settle as
// an API in the checkout they name. Removed with U4g: the mutations of the
// link-following run-directory rule it replaced, and those it made equivalent
// (a sweep's selection is re-asked by stillSole, an invalid run id is refused
// by peerRunPaths, one directory reached through two roots is deduplicated
// before selection, and runPeer and settleEnsemble now run in the checkout
// they name themselves, so the runners' CLI wrap is no longer the only one;
// the listing loop's early check, now that each write and the deletion ask
// again). H the seventh Plan-verify's findings (U4h): a run id with no run
// directory is never read through what stands at its path, the sweep asks
// again in every home, at the reconciling write and last before the deletion,
// and a file in a directory's place is no absence. I (U4i): the SessionStart
// hooks report a lookup the scans refuse instead of hiding it. A (U7c): the
// runbooks join the run locks before their first guarded action, read again
// what a run could change before the join, check before each guarded block,
// release on every exit; status lists the admissions; the driver refuses a
// pinned orchestrator without the subcommand. B the eighth Plan-verify's
// findings (U4j): a prune claims the run directory before it judges and
// deletes it, a handle write asks again right before its rename, a missing run
// is no path to read, a guard error is no corrupt envelope, and only absence
// is absence (the sweep's later listing, the observer); the SessionStart
// backstop runs after a refusal. Removed with U4j: H14 and H15, the order of
// the last check, now made on the claimed directory (B1, B2). Not kept: a
// mutation of the hooks' backstop catch survives, as no input reaches it (the
// backstop's functions catch every error themselves). B19 and B20 (U4k): a
// reconciling write is bound to the ledger it read (its run id and start).
// A21-A27 (U7d): next reads the selected subtask again after its join, on both
// hosts; the Codex done --no-commit block scans for an active child after its
// join; the Codex finalize and abort check the admission in Phases 2 and 3. M
// (U4l, U4m): a prune's claim, named from its run id with a bounded name, is
// that run id's ledger in every ownership check; the sweep puts back one an
// interrupted prune left; every prune failure names where the claim is; and
// orchestrator's reconciling writes keep a terminal status already on disk.
// Not kept: M8, the selection's merge of a run id's claim into its holders,
// is equivalent: the listing loop's stillSole asks ledgersHolding, which
// counts the claim (M1), before any reconcile or plan. N (U8a): the operator
// cutover's plan, move and verify: the set (a linked worktree's macros, their
// children active and archived wherever their macro is, the ledgers they
// name), every refusal of step 3, a move judged pair by pair before any
// rename and continued from its manifest, the writers' locks, and each check
// of verify (U8a, N1-N20, and its Plan-verify's findings, N32 and N34-N41:
// the subtasks read where a macro keeps them, the manifest written first,
// both creation locks, a missing --repo-root value, every manifest in force,
// verify judged from the default state root); the rollback (U8b, N21-N31,
// N33). RA-RE, the final critique's findings: next reads every dispatch field
// again after its join, and Phase 5 and the Codex Phase 4 set what they use
// (RA); an admission is keyed by its checkout's toplevel, and the Stop reads
// another worktree's status without its index lock (RB); a later --move plans
// again, and verify judges a moved macro by where it is now and by what
// next-ready refuses (RC); archive finds a record's home from its resolved
// path, and resume archive <id> resolves over the read set (RD); with the
// switch on, create and archive wait on each of their two creation locks, two
// checkouts' writes to one macro meet on its file lock, an override naming the
// checkout keeps creation there, and a local record is updated where it is
// (RE). RF, the refine's Refine-verify: next judges the selected subtask's
// readiness again after its join, and its writeback binds the child only to the
// subtask it dispatched (subtask-update's expected branch, verb, profile and
// topic, checked under the macro's file lock), on both hosts. DS, the
// recurring finding N1 fixed at its root: the dispatched child records the
// selection Phase 1 made, and every binding of a child to a subtask compares
// it under the macro's file lock (the engineer's terminal note through Phase
// 7 and the Stop, next's Phase 5 on both hosts, done's scanned owner on both
// hosts), a child from before the record judged by its creation branch; the
// record is written, checked and forwarded at create, and the dispatch
// preflight requires an engineer that records and sends it.

import { readFileSync } from 'node:fs';

const T_ROOT = 'tests/persona-pipeline/test-state-root.mjs';
const T_WRITERS = 'tests/persona-pipeline/test-state-root-writers.mjs';
const T_WORKER = 'tests/orchestrator/test-autopilot-worker.mjs';
const T_HERMETIC = 'tests/test-hermetic-env.mjs';
const T_ORCH = 'tests/orchestrator/test-state-root-orchestrator.mjs';
const T_RESOLVER = 'tests/orchestrator/test-runbook-workflow-resolver.mjs';
const T_OBSERVE = 'tests/orchestrator/test-autopilot-observe.mjs';
const T_DRIVER = 'tests/orchestrator/test-autopilot-driver.mjs';
const T_ADMISSION = 'tests/orchestrator/test-admission.mjs';
const T_ADMISSION_RUNBOOKS = 'tests/orchestrator/test-admission-runbooks.mjs';
const T_DONE_RUNBOOK = 'tests/orchestrator/test-done-runbook.mjs';
const T_CLI = 'tests/orchestrator/test-autopilot-cli.mjs';
const T_CUTOVER = 'tests/orchestrator/test-cutover.mjs';

const LIB = 'persona-pipeline/files/scripts/lib/state-root.mjs';
const ENG_LIB = 'plugins/engineer/scripts/lib/state-root.mjs';
const ORCH_LIB = 'plugins/orchestrator/scripts/lib/state-root.mjs';
const STATE = 'plugins/engineer/scripts/state.mjs';
const STOP = 'plugins/engineer/scripts/stop-archive.mjs';
const WORKER = 'plugins/orchestrator/adapters/claude/autopilot/worker.mjs';
const SESSION_ENV = 'scripts/lib/session-env.mjs';
const HANDOFF = 'plugins/engineer/scripts/session-handoff.mjs';
const RUNNER = 'plugins/engineer/scripts/peer-runner.mjs';
const WRITEBACK = 'plugins/engineer/scripts/parent-writeback.mjs';
const ORCH_STATE = 'plugins/orchestrator/scripts/state.mjs';
const ORCH_HANDOFF = 'plugins/orchestrator/scripts/session-handoff.mjs';
const ORCH_RUNNER = 'plugins/orchestrator/scripts/peer-runner.mjs';
const ORCH_STOP = 'plugins/orchestrator/scripts/stop-archive.mjs';
const OBSERVE = 'plugins/orchestrator/adapters/claude/autopilot/observe.mjs';
const PHASE7 = 'plugins/engineer/scripts/phase7-commit.mjs';
const RUN_LOCKS = 'plugins/orchestrator/scripts/lib/run-locks.mjs';
const DRIVER = 'plugins/orchestrator/adapters/claude/autopilot/driver.mjs';
const CUTOVER = 'plugins/orchestrator/scripts/lib/cutover.mjs';

// Unit ra — M6 (next re-reads every dispatch field after the join) and M7
// (Phase 5 sets its own plugin root and host; the Codex Phase 4 finds the
// engineer workflow itself).
const T_RA = 'tests/orchestrator/test-admission-runbooks.mjs';
const NEXT_RA = 'plugins/orchestrator/commands/next.md';
const SKILL_RA = 'plugins/orchestrator/core/skills/next/SKILL.md';
const R1_RA = 'CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"';
const R2_RA = `[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"`;
const HOST_RA = 'case "$ORCH_PLUGIN_ROOT" in\n  *"/.codex/"*) DETECTED_HOST="codex" ;;\n  *"/.claude/"*) DETECTED_HOST="claude" ;;\n  *) DETECTED_HOST="${AGENTIC_HOST:-claude}" ;;\nesac\n';
const REVISION_RA = /a plan revision during the join that changes the subtask's branch, verb, profile or topic is read after it/;
// The completed-subtask case, whose run's step lands during the join (the
// Refine-verify's weak-test MINOR): a re-read moved before the join misses it.
const COMPLETED_RA = /a subtask a run's step completes during the join is read again after it/;

// Unit rf — the SR refine's Refine-verify: F1 (next judges readiness again
// after its join) and F2 (Phase 5's writeback expects the dispatched branch,
// verb, profile and topic, under the macro's file lock).
const T_PROV_RF = 'tests/orchestrator/test-subtask-provenance.mjs';
const WAITING_RF = /a plan revision during the join that makes the subtask wait on a predecessor is judged after it/;
const BINDING_RF = /a plan revision after the switch that changes the subtask's branch, verb, profile or topic refuses the writeback/;
const EXPECT_API_RF = /refuses the write when the subtask verb, profile or topic no longer matches the expectation/;

/** Move the re-read chunk of `file` (from `startMarker` through `endMarker`) to just before `before`. */
function moveBefore_RA(file, startMarker, endMarker, before) {
  return (copy, tools) => {
        const text = readFileSync(`${copy}/${file}`, 'utf8');
    const at = text.indexOf(startMarker);
    const end = text.indexOf(endMarker, at);
    if (at < 0 || end < 0) throw new Error(`moveBefore_RA: markers not found in ${file}`);
    const chunk = text.slice(at, end + endMarker.length);
    tools.applyEdit(copy, { file, from: chunk, to: '' });
    tools.applyEdit(copy, { file, from: before, to: `${chunk}${before}` });
  };
}

// Unit rb (SR refine): M4 (admission --checkout keyed by its toplevel, empty refused)
// and M8 (the orchestrator Stop's status of another worktree takes no optional lock).
const RUN_LOCKS_RB = 'plugins/orchestrator/scripts/lib/run-locks.mjs';
const ORCH_STOP_RB = 'plugins/orchestrator/scripts/stop-archive.mjs';
const T_ADMISSION_RB = 'tests/orchestrator/test-admission.mjs';
const T_STOP_RB = 'tests/orchestrator/test-stop-archive.mjs';

// Unit rc: the cutover's rerun, verify's lifecycle and readiness judgments, and
// the reach from a worktree added after the cutover (findings M1, M2, M10(b)).
const T_RC = ['tests/orchestrator/test-cutover.mjs'];

// Unit rd (SR refine): M3 (archive reads the record's home from the resolved
// path, persona and orchestrator) and M5 (resume archive <id> resolves over the
// read set: persona resolve-workflow / list-workflows and the runbook block).
const ENG_RD = 'plugins/engineer/scripts/state.mjs';
const ORCH_RD = 'plugins/orchestrator/scripts/state.mjs';
const ENG_RESUME_RD = 'plugins/engineer/commands/resume.md';
const T_RD = 'tests/persona-pipeline/test-state-root-archive-resume.mjs';

// Unit "re" — test findings M9 and M10 (e), (f), (g) of the SR final review.
const W_RE = 'tests/persona-pipeline/test-state-root-writers.mjs';
const O_RE = 'tests/orchestrator/test-state-root-orchestrator.mjs';
const S_RE = 'tests/persona-pipeline/test-state-root.mjs';
const ENG_RE = 'plugins/engineer/scripts/state.mjs';
const ORCH_RE = 'plugins/orchestrator/scripts/state.mjs';


// withCreationLocks' two-lock path, as written in both state scripts.
const TWO_LOCKS_RE = 'return withDirectoryLock(defaultRoot, () => withDirectoryLock(storage.stateRoot, fn, { storage }), { storage: repoStorage });';
// The repository lock dropped, its directory still made (the existing test
// only looked for that directory).
const NO_REPO_LOCK_RE = 'await ensureDir(repoStorage.workflows, 0o700);\n  return withDirectoryLock(storage.stateRoot, fn, { storage });';
// The record home's lock dropped: `fn` runs under the repository lock alone.
const NO_HOME_LOCK_RE = 'return withDirectoryLock(defaultRoot, async (held) => { await ensureDir(storage.workflows, 0o700); return fn({ ...held, storage }); }, { storage: repoStorage });';

const lockMutations_RE = (prefix, n, file, tests) => [
  { id: `${prefix}${n}`, file, tests, from: TWO_LOCKS_RE, to: NO_REPO_LOCK_RE,
    why: "create skips the repository's creation lock (directory kept)", killed_by: /create waits on the repository's creation lock/ },
  { id: `${prefix}${n + 1}`, file, tests, from: TWO_LOCKS_RE, to: NO_REPO_LOCK_RE,
    why: "archive skips the repository's creation lock (directory kept)", killed_by: /archive waits on the repository's creation lock/ },
  { id: `${prefix}${n + 2}`, file, tests, from: TWO_LOCKS_RE, to: NO_HOME_LOCK_RE,
    why: "create skips the record home's creation lock", killed_by: /create waits on the record home's creation lock/ },
  { id: `${prefix}${n + 3}`, file, tests, from: TWO_LOCKS_RE, to: NO_HOME_LOCK_RE,
    why: "archive skips the record home's creation lock", killed_by: /archive waits on the record home's creation lock/ },
];

const STATE_BASE_CHECKOUT_RE = '    return { set: true, ok: true, value, root: toplevel };';
const STATE_BASE_IGNORED_RE = '    return { set: false };';

// Group DS: the dispatch selection the child records (ADR-0067 Decision 4,
// item 5; the N1 root fix).
const ORCH_DS = 'plugins/orchestrator/scripts/state.mjs';
const ENG_STATE_DS = 'plugins/engineer/scripts/state.mjs';
const ENG_PW_DS = 'plugins/engineer/scripts/parent-writeback.mjs';
const NEXT_DS = 'plugins/orchestrator/commands/next.md';
const NEXT_SKILL_DS = 'plugins/orchestrator/core/skills/next/SKILL.md';
const DONE_DS = 'plugins/orchestrator/commands/done.md';
const DONE_SKILL_DS = 'plugins/orchestrator/core/skills/done/SKILL.md';
const T_TERM_DS = 'tests/orchestrator/test-engineer-terminal.mjs';
const T_P7_DS = 'tests/persona-pipeline/test-phase7-commit.mjs';
const T_STOP_DS = 'tests/persona-pipeline/test-stop-archive.mjs';
const T_NPP_DS = 'tests/orchestrator/test-next-parent-path.mjs';
const T_SEL_DS = 'tests/persona-pipeline/test-dispatch-selection.mjs';
const T_DISC_DS = 'tests/orchestrator/test-discover-engineer.mjs';
const STOP_REFUSED_DS = /a recorded dispatch, the branch revised — the Stop binds nothing on the macro/;

export const TESTS = [T_ROOT, T_WRITERS, T_WORKER, T_HERMETIC, T_ORCH, T_RESOLVER, T_OBSERVE, T_DRIVER, T_ADMISSION, T_ADMISSION_RUNBOOKS, T_DONE_RUNBOOK, T_CLI, T_CUTOVER, 'tests/orchestrator/test-stop-archive.mjs', 'tests/persona-pipeline/test-state-root-archive-resume.mjs', T_TERM_DS, T_P7_DS, T_STOP_DS, T_NPP_DS, T_SEL_DS, T_DISC_DS];

export const MUTATIONS = [
  // ---- L: the library -------------------------------------------------------
  {
    id: 'L1', file: LIB, tests: [T_ROOT],
    from: "  if (common && path.basename(common) === '.git') return path.dirname(common);",
    to: '  if (common) return path.dirname(common);',
    why: 'a git dir under another name makes its parent the state root',
    killed_by: /a git dir not named \.git: the checkout is its own default state root/,
  },
  {
    id: 'L2', file: LIB, tests: [T_ROOT],
    from: '  return [shared, toplevel];',
    to: '  return [toplevel];',
    why: 'the read set forgets the default state root',
    killed_by: /a linked worktree: the default state root is the main checkout, read first/,
  },
  {
    id: 'L3', file: LIB, tests: [T_ROOT],
    from: "    return { state: 'unreadable', path: file, record: null, error: `cannot parse ${file} (${error.message})` };",
    to: "    return { state: 'off', path: file, record: null };",
    why: 'an unparseable switch reads as off, and creation guesses',
    killed_by: /an unreadable or malformed switch refuses every creation, never guesses/,
  },
  {
    id: 'L4', file: LIB, tests: [T_ROOT],
    from: '  if (record.schema !== SHARED_CREATION_SCHEMA) return `schema is not ${SHARED_CREATION_SCHEMA}`;',
    to: '',
    why: 'a switch of another schema is believed',
    killed_by: /an unreadable or malformed switch refuses every creation, never guesses/,
  },
  {
    id: 'L5', file: LIB, tests: [T_ROOT],
    from: "    if (switchState === 'on') return { set: true, ok: true, value, root: shared };",
    to: '    return { set: true, ok: true, value, root: shared };',
    why: 'the override names the default state root before shared creation is on',
    killed_by: /AGENTIC_STATE_BASE naming the default state root: refused while off, allowed once on/,
  },
  {
    id: 'L6', file: LIB, tests: [T_ROOT],
    from: '    if (!sameDirectory(shared, toplevel) && isUnderLanesDirectory(toplevel, shared)) {',
    to: '    if (false) {',
    why: 'a lane may keep records that go when it is removed',
    killed_by: /AGENTIC_STATE_BASE naming a lane/,
  },
  {
    id: 'L7', file: LIB, tests: [T_ROOT],
    from: '  if (path.normalize(value) !== value || (value.length > 1 && value.endsWith(path.sep))) {',
    to: '  if (false) {',
    why: 'an unnormalized spelling of the checkout is accepted',
    killed_by: /AGENTIC_STATE_BASE anywhere else, relative or unnormalized fails closed/,
  },
  {
    id: 'L8', file: LIB, tests: [T_ROOT],
    from: "  return { root: base.set ? base.root : defaultStateRoot(toplevel), sharedCreation: 'on', defaultRoot: defaultStateRoot(toplevel) };",
    to: "  return { root: toplevel, sharedCreation: 'on', defaultRoot: defaultStateRoot(toplevel) };",
    why: 'the switch is read but creation stays in the checkout',
    killed_by: /switch on: creation goes to the default state root, from any checkout/,
  },
  {
    id: 'L9', file: LIB, tests: [T_ROOT],
    from: "  const commonOk = realOr(gitDir) === realOr(commonDir) && path.basename(commonDir) === '.git';",
    to: '  const commonOk = true;',
    why: 'the attestation accepts a linked worktree as the main checkout',
    killed_by: /a linked worktree fails the first two/,
  },
  {
    id: 'L10', file: LIB, tests: [T_ROOT],
    from: "      if (!entry.startsWith('H ')) continue;",
    to: "      if (!entry.startsWith('H ') && !entry.startsWith('S ')) continue;",
    why: 'a skip-worktree entry counts as checked out',
    killed_by: /skip-worktree \(S\) entries are not counted/,
  },
  {
    id: 'L11', file: LIB, tests: [T_ROOT],
    from: '        fs.lstatSync(path.join(toplevel, rel));',
    to: '        void rel;',
    why: 'an index entry counts without its file on disk',
    killed_by: /a checkout whose every checked-out file is missing on disk fails the third/,
  },
  // ---- C: the CLI copies ----------------------------------------------------
  {
    id: 'C1', file: ENG_LIB, tests: [T_ROOT],
    from: '  if (!attestation.ok) {',
    to: '  if (false) {',
    why: 'shared-creation --enable runs anywhere',
    killed_by: /engineer state\.mjs state-root and shared-creation > shared-creation --enable refuses outside the main checkout/,
  },
  {
    id: 'C2', file: ENG_LIB, tests: [T_ROOT],
    from: "  if (current.state === 'on') return { changed: false,",
    to: "  if (false) return { changed: false,",
    why: 'a second --enable rewrites the inventory the rollback reads',
    killed_by: /engineer state\.mjs state-root and shared-creation > --enable in the main checkout records the inventory/,
  },
  {
    id: 'C3', file: ENG_LIB, tests: [T_ROOT],
    from: '  if (current.record.lanes_first_run_at) {',
    to: '  if (false) {',
    why: 'the rollback runs after lanes have run',
    killed_by: /engineer state\.mjs state-root and shared-creation > --disable is refused once lanes have run/,
  },
  {
    id: 'C4', file: ENG_LIB, tests: [T_ROOT],
    from: "    for (const dir of ['workflows', 'archive']) {",
    to: "    for (const dir of ['workflows']) {",
    why: 'the inventory forgets archived records',
    killed_by: /engineer state\.mjs state-root and shared-creation > --enable in the main checkout records the inventory/,
  },
  {
    id: 'C5', file: ORCH_LIB, tests: [T_ROOT],
    from: '  if (!attestation.ok) {',
    to: '  if (false) {',
    why: "orchestrator's --enable runs anywhere",
    killed_by: /orchestrator state\.mjs state-root and shared-creation > shared-creation --enable refuses outside the main checkout/,
  },
  // ---- W: the persona writers -----------------------------------------------
  {
    id: 'W1', file: STATE, tests: [T_WRITERS],
    from: '  return findActiveWorkflowByBranchInRoots(lookupRoots(repoRoot), branch);',
    to: '  return findActiveWorkflowByBranchInRoots([repoRoot], branch);',
    why: 'find-active looks only in the checkout',
    killed_by: /engineer: .*find-active from a linked worktree finds a workflow stored in the main checkout/,
  },
  {
    id: 'W2', file: STATE, tests: [T_WRITERS],
    from: '  if (found.length <= 1) return found[0] ?? null;',
    to: '  if (found.length >= 1) return found[0] ?? null;',
    why: 'two copies of a branch key: the first wins',
    killed_by: /engineer: .*two active workflows for one branch, one per root, are an error naming both/,
  },
  {
    id: 'W3', file: STATE, tests: [T_WRITERS],
    from: '  for (const root of [storage.stateRoot, ...otherWorktreeRoots(repoRoot)]) {',
    to: '  for (const root of [storage.stateRoot]) {',
    why: "create does not scan the other worktrees' own homes",
    killed_by: /engineer: .*create refuses a branch key active in another worktree's own home/,
  },
  {
    id: 'W4', file: STATE, tests: [T_WRITERS],
    from: '  const searched = [...lookupRoots(repoRoot)];',
    to: '  const searched = [repoRoot];',
    why: "create's branch check skips the default state root",
    killed_by: /engineer: .*create refuses a branch key active in the read set/,
  },
  {
    id: 'W5', file: STATE, tests: [T_WRITERS],
    from: '    if (beside) return { ...placement, root: beside };',
    to: '    void beside;',
    why: 'a dispatched child is created where its macro is not',
    killed_by: /engineer: a dispatched child goes beside its macro/,
  },
  {
    id: 'W6', file: STATE, tests: [T_WRITERS],
    from: '        if (statSync(join(root, rel, `${parentWorkflow}.md`)).isFile()) return root;',
    to: '        void root;',
    why: 'without a recorded path the child cannot find its macro',
    killed_by: /engineer: a dispatched child goes beside its macro/,
  },
  {
    id: 'W7', file: STATE, tests: [T_WRITERS],
    from: "  if (switchState === 'off') return withDirectoryLock(storage.stateRoot, fn, { storage });",
    to: '  return withDirectoryLock(storage.stateRoot, fn, { storage });',
    why: "with the switch on, create skips the repository's creation lock",
    killed_by: /engineer: .*under the repository's lock too/,
  },
  {
    id: 'W8', file: STATE, tests: [T_WRITERS],
    from: '  const effectiveRepoRoot = inferred?.stateRoot ?? repoRoot;',
    to: '  const effectiveRepoRoot = repoRoot ?? inferred?.stateRoot;',
    why: "archive follows the caller's checkout, not the record's home",
    killed_by: /engineer: .*archive puts a record in its own home's archive/,
  },
  {
    id: 'W9', file: STOP, tests: [T_WRITERS],
    from: "    if (elsewhere.branches.has(branch)) continue; // another worktree's Stop owns it",
    to: '',
    why: "the sweep archives a workflow another worktree's Stop owns",
    killed_by: /engineer: the Stop sweep leaves branches other worktrees have out/,
  },
  // ---- E: the scrubs --------------------------------------------------------
  {
    id: 'E1', file: SESSION_ENV, tests: [T_HERMETIC],
    from: "  'AGENTIC_STATE_BASE',\n",
    to: '',
    why: 'a test inherits the session\'s state base',
    killed_by: /ADR-0067's three variables are listed by name/,
  },
  {
    id: 'E2', file: WORKER, tests: [T_WORKER],
    from: "  'AGENTIC_STATE_BASE', 'AGENTIC_AUTOPILOT_TOKEN',",
    to: "  'AGENTIC_AUTOPILOT_TOKEN',",
    why: "a worker inherits an outer session's state base",
    killed_by: /scrubs the launching session and the dispatch contract/,
  },
  {
    id: 'E3', file: WORKER, tests: [T_WORKER],
    from: "  'AGENTIC_STATE_BASE', 'AGENTIC_AUTOPILOT_TOKEN',",
    to: "  'AGENTIC_STATE_BASE',",
    why: "a worker inherits another run's admission secret",
    killed_by: /scrubs the launching session and the dispatch contract/,
  },
  // ---- U: one writable copy (U2b) -------------------------------------------
  {
    id: 'U1', file: STATE, tests: [T_WRITERS],
    from: "    await assertSingleCopy(workflowPath);\n    const result = await fn(",
    to: "    const result = await fn(",
    why: "a write goes to one of two copies of a workflow",
    killed_by: /a workflow held at one relative path under two roots refuses every write to either file/,
  },
  {
    id: 'U2', file: STATE, tests: [T_WRITERS],
    from: '  if (st.isSymbolicLink()) {',
    to: '  if (false) {',
    why: 'a write through a symlink replaces the alias with a second copy',
    killed_by: /a write through a symbolic link to the workflow file is refused/,
  },
  {
    id: 'U3', file: ENG_LIB, tests: [T_WRITERS],
    from: '  return [...readSet(checkout), ...otherWorktreeRoots(checkout)];',
    to: '  return readSet(checkout);',
    why: "the copy check misses another worktree's own home",
    killed_by: /a copy in another worktree's own home, outside the read set, refuses the write too/,
  },
  {
    id: 'U4', file: ENG_LIB, tests: [T_WRITERS],
    from: '      if (samePhysicalFile(candidate, file) || copies.some((c) => samePhysicalFile(c, candidate))) continue;',
    to: '      if (candidate === file) continue;',
    why: 'one file reached through a symlinked home counts as two',
    killed_by: /the same file reached through a symlinked home directory is one copy, not two/,
  },
  {
    id: 'U5', file: ENG_LIB, tests: [T_WRITERS],
    from: "    if (fs.readdirSync(path.join(common, 'worktrees')).length === 0) return [];",
    to: '    return [];',
    why: 'the no-linked-worktree shortcut also skips a repository that has them',
    killed_by: [
      /a copy in another worktree's own home, outside the read set, refuses the write too/,
      /create refuses a branch key active in another worktree's own home/,
    ],
  },
  // ---- U: a record under another root (U3) ----------------------------------
  {
    id: 'U6', file: STATE, tests: [T_WRITERS],
    from: '        const repoRoot = checkout ?? commandCheckout(stateRoot);',
    to: '        const repoRoot = stateRoot;',
    why: "the sidecar writes the slot beside the record and probes the storage root's HEAD",
    killed_by: /the terminal sidecar probes the lane's HEAD, writes the slot in the lane/,
  },
  {
    id: 'U7', file: HANDOFF, tests: [T_WRITERS],
    from: "  if (out.state === 'branch' && out.branch === branch) return probeHead(checkout);",
    to: '  return probeHead(checkout);',
    why: "a checkout without the branch judges the workflow by its own HEAD",
    killed_by: /run from the main checkout, the sidecar reads the lane's branch tip from refs\/heads/,
  },
  {
    id: 'U8', file: HANDOFF, tests: [T_WRITERS],
    from: '  return repoRelativePointer(workflowStateRoot(workflowPath) ?? repoRoot, workflowPath);',
    to: '  return repoRelativePointer(repoRoot, workflowPath);',
    why: 'the projection points into the record relative to the checkout (an absolute path)',
    killed_by: /the terminal sidecar probes the lane's HEAD, writes the slot in the lane, and points into the state root/,
  },
  {
    id: 'U9', file: RUNNER, tests: [T_WRITERS],
    from: "  if (own) return peerRunPaths(own.stateRoot, runId, { home: capabilityOn('legacy_homes') ? own.home : 'canonical' });\n",
    to: '',
    why: "a run's ledger goes to the checkout, not its workflow's home",
    killed_by: /a run of a workflow under the state root is kept in its home, and settled from the lane/,
  },
  {
    id: 'U10', file: RUNNER, tests: [T_WRITERS],
    from: '  for (const root of [...(own ? [own] : []), ...readSet(resolve(repoRoot))]) {',
    to: '  for (const root of [resolve(repoRoot)]) {',
    why: "status and settle look only in the checkout's home",
    killed_by: /a run of a workflow under the state root is kept in its home, and settled from the lane/,
  },
  {
    id: 'U11', file: RUNNER, tests: [T_WRITERS],
    from: '  if (found.length > 1) {',
    to: '  if (false) {',
    why: 'a run id in two read roots is picked, not refused',
    killed_by: /a run of a workflow under the state root is kept in its home, and settled from the lane/,
  },
  {
    id: 'U12', file: WRITEBACK, tests: [T_WRITERS],
    from: '  for (const root of [...readSet(resolve(repoRoot)), ...(recordedCheckout === null ? [] : [recordedCheckout])]) {',
    to: '  for (const root of [resolve(repoRoot), ...(recordedCheckout === null ? [] : [recordedCheckout])]) {',
    why: "the writeback searches only the lane's homes for its macro",
    killed_by: /a child committed in the lane writes back to its macro in the main checkout/,
  },
  {
    id: 'U13', file: WRITEBACK, tests: [T_WRITERS],
    from: '    otherRoots = repositoryRoots(resolve(repoRoot)).filter((root) => !roots.some((r) => sameDirectory(r, root)));',
    to: '    otherRoots = [];',
    why: "a stray macro copy in another worktree's own home goes unseen",
    killed_by: /a child committed in the lane writes back to its macro in the main checkout/,
  },
  // ---- O: orchestrator's state script (U4a) ---------------------------------
  {
    id: 'O1', file: ORCH_STATE, tests: [T_ORCH],
    from: '  assertAbsoluteRepoRoot(repoRoot);\n  return readSet(repoRoot);',
    to: '  assertAbsoluteRepoRoot(repoRoot);\n  return [repoRoot];',
    why: "a linked worktree's lookups miss the main checkout's macros",
    killed_by: [
      /find-active, find-macro and resolve-workflow from a linked worktree find a macro in the main checkout/,
      /create refuses a branch key active in the read set/,
    ],
  },
  {
    id: 'O2', file: ORCH_STATE, tests: [T_ORCH],
    from: "    await assertSingleCopy(workflowPath);\n    const result = await fn(",
    to: "    const result = await fn(",
    why: "a write goes to one of two copies of a macro",
    killed_by: /a macro held by two files refuses every write, and the resolver names both/,
  },
  {
    id: 'O3', file: ORCH_STATE, tests: [T_ORCH],
    from: '  for (const root of [storage.stateRoot, ...otherWorktreeRoots(repoRoot)]) {',
    to: '  for (const root of [storage.stateRoot]) {',
    why: "create misses a macro in another worktree's own home",
    killed_by: /create refuses a branch key active in the read set, or in another worktree's own home/,
  },
  {
    id: 'O4', file: ORCH_STATE, tests: [T_ORCH],
    from: '  const effectiveRepoRoot = inferred?.stateRoot ?? repoRoot;',
    to: '  const effectiveRepoRoot = repoRoot ?? inferred?.stateRoot;',
    why: "a Stop in a linked worktree archives the macro into its own checkout",
    killed_by: /archive puts a macro in its own home's archive, whatever checkout asks/,
  },
  {
    id: 'O5', file: ORCH_STATE, tests: [T_ORCH],
    from: '  const dirs = repositoryRoots(repoRoot).flatMap((root) => [',
    to: '  const dirs = [repoRoot].flatMap((root) => [',
    why: "the archive guard misses a child in another worktree's own home",
    killed_by: /the archive guard counts a child in any worktree's own home, once/,
  },
  {
    id: 'O6', file: ORCH_STATE, tests: [T_ORCH],
    from: '  const placement = creationRoot(args.repoRoot, { env: args.env ?? process.env });',
    to: '  const placement = { root: defaultStateRoot(args.repoRoot) };',
    why: 'a macro is created under the default state root while shared creation is off',
    killed_by: /a macro in the linked worktree's own home is found and updated in place, never copied/,
  },
  {
    id: 'O7', file: ORCH_STATE, tests: [T_ORCH],
    from: 'export async function withFileLock(workflowPath, fn) {\n  const lockPath = fileLockPath(workflowPath);',
    to: 'export async function withFileLock(workflowPath, fn) {\n  const lockPath = `${fileLockPath(workflowPath)}.${pid}`;',
    why: 'two writers of one macro stop excluding each other',
    killed_by: /two worktrees writing one macro meet on one lock, and lose neither write/,
  },
  // ---- P: what derives from a macro under another root (U4b) ----------------
  {
    id: 'P1', file: ORCH_STATE, tests: [T_ORCH],
    from: '    const repoRoot = commandCheckout(stateRoot);',
    to: '    const repoRoot = stateRoot;',
    why: 'the macro sidecar writes the slot beside the macro',
    killed_by: /the terminal sidecar writes the slot in the command's checkout and points into the state root/,
  },
  {
    id: 'P2', file: ORCH_HANDOFF, tests: [T_ORCH],
    from: '  return repoRelativePointer(workflowStateRoot(macroPath) ?? repoRoot, macroPath);',
    to: '  return repoRelativePointer(repoRoot, macroPath);',
    why: 'the projection points into the macro relative to the checkout (an absolute path)',
    killed_by: /the terminal sidecar writes the slot in the command's checkout and points into the state root/,
  },
  {
    id: 'P3', file: ORCH_RUNNER, tests: [T_ORCH],
    from: '  if (own) return peerRunPaths(own.stateRoot, runId, { home: own.home });\n',
    to: '',
    why: "a macro's run is written in a path rebuilt from the checkout",
    killed_by: /a macro's peer run is kept in the macro's home, found from the lane/,
  },
  {
    id: 'P4', file: ORCH_RUNNER, tests: [T_ORCH],
    from: '  for (const root of [...(own ? [own] : []), ...readSet(resolve(repoRoot))]) {',
    to: '  for (const root of [resolve(repoRoot)]) {',
    why: "status looks only in the checkout's home",
    killed_by: /a macro's peer run is kept in the macro's home, found from the lane/,
  },
  {
    id: 'P5', file: ORCH_RUNNER, tests: [T_ORCH],
    from: '  if (found.length > 1) {',
    to: '  if (false) {',
    why: 'a run id in two read roots is picked, not refused',
    killed_by: /a macro's peer run is kept in the macro's home, found from the lane/,
  },
  {
    id: 'P6', file: ORCH_STOP, tests: [T_ORCH],
    from: "  if (typeof branch !== 'string' || branch.length === 0 || ownBranch === `refs/heads/${branch}`) {",
    to: '  if (true) {',
    why: "a Stop stamps its own checkout's facts on every macro",
    killed_by: /a Stop records each macro's git facts from the worktree that has its branch, or none/,
  },
  {
    id: 'P7', file: ORCH_STOP, tests: [T_ORCH],
    from: '  const holder = worktreeHoldingBranch(repoRoot, branch);',
    to: '  const holder = null;',
    why: "the worktree that has the branch is never asked for its working tree",
    killed_by: /a Stop records each macro's git facts from the worktree that has its branch, or none/,
  },
  // ---- V: the second Plan-verify's findings (U4c) -----------------------------
  {
    id: 'V1', file: LIB, tests: [T_ROOT],
    from: '    throw unlisted(`git worktree list failed (${error?.code || error?.status || error?.message})`);',
    to: '    return [];',
    why: 'a repository whose worktrees git cannot list reads as one with none',
    killed_by: /otherWorktreeRoots fails closed when git cannot list a repository that has linked worktrees/,
  },
  {
    id: 'V2', file: ENG_LIB, tests: [T_WRITERS],
    from: '    throw unlisted(`git worktree list failed (${error?.code || error?.status || error?.message})`);',
    to: '    return [];',
    why: "a persona write and create pass without seeing other worktrees' homes",
    killed_by: /worktrees git cannot list refuse a write and a create/,
  },
  {
    id: 'V3', file: ORCH_LIB, tests: [T_ORCH],
    from: '    throw unlisted(`git worktree list failed (${error?.code || error?.status || error?.message})`);',
    to: '    return [];',
    why: "a macro write and create pass without seeing other worktrees' homes",
    killed_by: /worktrees git cannot list refuse a write and a create/,
  },
  {
    id: 'V4', file: LIB, tests: [T_ROOT],
    from: '      return isWorkingTreeOf(current, checkout) ? current : null;',
    to: '      return current;',
    why: 'the git dir a separate-git-dir layout lists stands in for a working tree',
    killed_by: /worktreeHoldingBranch names a working tree only/,
  },
  {
    id: 'V5', file: LIB, tests: [T_ROOT],
    from: "      return holder !== null && samePhysicalFile(own, holder) ? unknown : outside;",
    to: "      return outside;",
    why: "a checkout git cannot name falls back to the storage root",
    killed_by: /commandCheckout: this repository's checkout, the storage root for anything else, null when git fails inside it/,
  },
  {
    id: 'V6', file: ENG_LIB, tests: [T_WRITERS],
    from: "      return holder !== null && samePhysicalFile(own, holder) ? unknown : outside;",
    to: "      return outside;",
    why: "a lane whose git fails writes the storage root's slot",
    killed_by: /a checkout that cannot be told writes no handoff slot/,
  },
  {
    id: 'V7', file: ORCH_LIB, tests: [T_ORCH],
    from: "      return holder !== null && samePhysicalFile(own, holder) ? unknown : outside;",
    to: "      return outside;",
    why: "a lane whose git fails writes the storage root's macro slot",
    killed_by: /a checkout that cannot be told writes no handoff slot/,
  },
  {
    id: 'V8', file: LIB, tests: [T_ROOT],
    from: '      if (fs.lstatSync(dir).isSymbolicLink()) return dir;',
    to: '      fs.lstatSync(dir);',
    why: 'a symlinked directory on the way is not reported',
    killed_by: /aliasedComponent finds a symbolic link on the way down/,
  },
  {
    id: 'V9', file: HANDOFF, tests: [T_WRITERS],
    from: '    if (aliased) {',
    to: '    if (false) {',
    why: "a home linked to another checkout's gets that checkout's slot",
    killed_by: /a home linked to another checkout's gets no handoff slot/,
  },
  {
    id: 'V10', file: ORCH_HANDOFF, tests: [T_ORCH],
    from: '    if (aliased) {',
    to: '    if (false) {',
    why: "a home linked to another checkout's gets that checkout's macro slot",
    killed_by: /a home linked to another checkout's gets no handoff slot/,
  },
  {
    id: 'V11', file: LIB, tests: [T_ROOT],
    from: "      if (entry === name || (workflowId && workflowIdOfText(head, { partial: true }) === workflowId)) copies.push(candidate);",
    to: '      if (entry === name) copies.push(candidate);',
    why: 'a copy under another name is not a copy',
    killed_by: /otherCopiesOf: a copy is the same name or the same workflow id/,
  },
  {
    id: 'V12', file: ENG_LIB, tests: [T_WRITERS],
    from: "      if (entry === name || (workflowId && workflowIdOfText(head, { partial: true }) === workflowId)) copies.push(candidate);",
    to: '      if (entry === name) copies.push(candidate);',
    why: 'a persona workflow copied under another name is written',
    killed_by: [
      /a copy under another file name with the same workflow id refuses the write/,
      /a macro copy under another file name refuses the writeback/,
    ],
  },
  {
    id: 'V13', file: ORCH_LIB, tests: [T_ORCH],
    from: "      if (entry === name || (workflowId && workflowIdOfText(head, { partial: true }) === workflowId)) copies.push(candidate);",
    to: '      if (entry === name) copies.push(candidate);',
    why: 'a macro copied under another name is written',
    killed_by: /a copy under another file name with the same workflow id refuses the write/,
  },
  {
    id: 'V14', file: WRITEBACK, tests: [T_WRITERS],
    from: '  for (const copy of renamed) {',
    to: '  for (const copy of []) {',
    why: 'the writeback misses a macro copy under another name',
    killed_by: /a macro copy under another file name refuses the writeback/,
  },
  {
    id: 'V15', file: STATE, tests: [T_WRITERS],
    from: '    if (branch) await findActiveWorkflowByBranchInRoots(writerRoots(inferred.stateRoot), branch);',
    to: '    void branch;',
    why: "a path write ignores the branch key's second active workflow",
    killed_by: /a second active workflow on the record's branch key refuses a path write/,
  },
  {
    id: 'V16', file: ORCH_STATE, tests: [T_ORCH],
    from: '    if (branch) await findActiveWorkflowByBranchInRoots(writerRoots(inferred.stateRoot), branch);',
    to: '    void branch;',
    why: "a macro write ignores the integration branch's second active macro",
    killed_by: /a second active macro on the integration branch refuses a path write/,
  },
  {
    id: 'V17', file: ENG_LIB, tests: [T_WRITERS],
    from: "  for (const root of everyRoot ? repositoryRoots(stateRoot) : [...readSet(stateRoot), ...readSet(at.checkout ?? stateRoot)]) {",
    to: "  for (const root of everyRoot ? repositoryRoots(stateRoot) : readSet(stateRoot)) {",
    why: "the branch check ignores the read set of the checkout the command runs in",
    killed_by: /a second active workflow on the record's branch key refuses a path write/,
  },
  {
    id: 'V18', file: STATE, tests: [T_WRITERS],
    from: 'export async function withFileLock(workflowPath, fn) {\n  const lockPath = fileLockPath(workflowPath);\n  const token = await acquireLock(lockPath);\n  let releaseOk = false;\n  try {\n    // ADR-0067 Decision 4, item 2 — checked holding the lock, so a copy that\n    // appears while this writer waits for it is seen.\n    await assertSingleCopy(workflowPath);',
    to: 'export async function withFileLock(workflowPath, fn) {\n  await assertSingleCopy(workflowPath);\n  const lockPath = fileLockPath(workflowPath);\n  const token = await acquireLock(lockPath);\n  let releaseOk = false;\n  try {',
    why: 'the copy check runs before the lock, so a copy made while the writer waits is missed',
    killed_by: /the copy check runs holding the lock/,
  },
  {
    id: 'V19', file: ORCH_STATE, tests: [T_ORCH],
    from: 'export async function withFileLock(workflowPath, fn) {\n  const lockPath = fileLockPath(workflowPath);\n  const token = await acquireLock(lockPath);\n  let releaseOk = false;\n  try {\n    // ADR-0067 Decision 4, item 2 — checked holding the lock, so a copy that\n    // appears while this writer waits for it is seen.\n    await assertSingleCopy(workflowPath);',
    to: 'export async function withFileLock(workflowPath, fn) {\n  await assertSingleCopy(workflowPath);\n  const lockPath = fileLockPath(workflowPath);\n  const token = await acquireLock(lockPath);\n  let releaseOk = false;\n  try {',
    why: 'the macro copy check runs before the lock',
    killed_by: /the copy check runs holding the lock/,
  },
  {
    id: 'V20', file: RUNNER, tests: [T_WRITERS],
    from: "      if (runDirectoryAt(paths.dir) && !found.some(",
    to: "      if ((await exists(paths.handle) || await exists(paths.dir)) && !found.some(",
    why: "a run directory that cannot be judged reads as absent, and a link to a file reads as a ledger",
    killed_by: [/a peer-run directory that cannot be judged is not read as absent/, /a link to a file under a run id is no ledger/],
  },
  {
    id: 'V21', file: ORCH_RUNNER, tests: [T_ORCH],
    from: "      if (runDirectoryAt(paths.dir) && !found.some(",
    to: "      if ((await exists(paths.handle) || await exists(paths.dir)) && !found.some(",
    why: "a macro run directory that cannot be judged reads as absent, and a link to a file reads as a ledger",
    killed_by: [/a peer-run directory that cannot be judged is not read as absent/, /a link to a file under a run id is no ledger/],
  },
  {
    id: 'V22', file: ENG_LIB, tests: [T_WRITERS],
    from: "    if (blocked.has(ledger)) continue;",
    to: "",
    why: "the sweep prunes a run id two directories hold",
    killed_by: /the sweep leaves a run id two directories hold alone/,
  },
  {
    id: 'V23', file: ORCH_LIB, tests: [T_ORCH],
    from: "    if (blocked.has(ledger)) continue;",
    to: "",
    why: "the macro sweep prunes a run id two directories hold",
    killed_by: /a new run refuses a run id another read root holds, and the sweep leaves one two directories hold alone/,
  },
  {
    id: 'V24', file: RUNNER, tests: [T_WRITERS],
    from: '  const merged = { ...reports[reports.length - 1], root: own, roots: reports.map((r) => r.root) };',
    to: '  const merged = { ...reports[0], roots: reports.map((r) => r.root) };',
    why: "the report's root is the first directory read, not the checkout's own",
    killed_by: /the sweep leaves a run id two directories hold alone/,
  },
  {
    id: 'V25', file: RUNNER, tests: [T_WRITERS],
    from: '  merged.retention_applied = applyRetention;',
    to: '',
    why: "a missing own directory reports that retention did not run",
    killed_by: /the sweep leaves a run id two directories hold alone/,
  },
  {
    id: 'V26', file: ORCH_RUNNER, tests: [T_ORCH],
    from: '  if (await exists(paths.dir) || (await findPeerRunPaths(options.repoRoot, runId, options.workflowPath)).length > 0) {',
    to: '  if (await exists(paths.dir)) {',
    why: 'a new macro run reuses a run id another read root holds',
    killed_by: /a new run refuses a run id another read root holds/,
  },
  {
    id: 'V27', file: RUNNER, tests: [T_WRITERS],
    from: "    if (typeof handle.workflow_path !== 'string' || !samePhysicalFile(handle.workflow_path, workflowPath)) continue;",
    to: "    if (typeof handle.workflow_path !== 'string' || resolve(handle.workflow_path) !== workflowPath) continue;",
    why: 'an attempt recorded under another spelling of the workflow is missed',
    killed_by: /settle and the unsettled-attempt scan judge the workflow by its file/,
  },
  {
    id: 'V28', file: RUNNER, tests: [T_WRITERS],
    from: "  if (typeof handle.workflow_path !== 'string' || !samePhysicalFile(handle.workflow_path, wf)) {",
    to: "  if (typeof handle.workflow_path !== 'string' || resolve(handle.workflow_path) !== wf) {",
    why: "settle refuses its own workflow's run under another spelling",
    killed_by: /settle and the unsettled-attempt scan judge the workflow by its file/,
  },
  {
    id: 'V29', file: ORCH_STATE, tests: [T_ORCH],
    from: '    lookupRoots(repoRoot).flatMap((root) => Object.keys(STATE_HOMES).map((home) => workflowDir(root, { home }))),',
    to: '    lookupRoots(repoRoot).reverse().flatMap((root) => Object.keys(STATE_HOMES).map((home) => workflowDir(root, { home }))),',
    why: "the Stop's macro list spells a file as the checkout, not the default state root",
    killed_by: /the Stop's macro list keeps the default state root's spelling/,
  },
  {
    id: 'V30', file: ORCH_STATE, tests: [T_ORCH],
    from: '    lookupRoots(repoRoot).flatMap((root) => Object.keys(STATE_HOMES).map((home) => workflowDir(root, { home }))),',
    to: "    lookupRoots(repoRoot).flatMap((root) => ['canonical'].map((home) => workflowDir(root, { home }))),",
    why: "the Stop's macro list hides an active legacy macro",
    killed_by: /the Stop's macro list keeps an active legacy macro/,
  },
  // ---- R: the runbooks' --workflow=<id> resolvers (U5a) -----------------------
  {
    id: 'R1', file: 'plugins/orchestrator/commands/next.md', tests: [T_RESOLVER],
    from: '  if ! MACRO_PATH="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \\\n    resolve-workflow --repo-root "$REPO_ROOT" --workflow-id "$EXPLICIT_WORKFLOW_ID")"; then',
    to: '  MACRO_PATH="$REPO_ROOT/.agentic-plugins/state/orchestrator/workflows/${EXPLICIT_WORKFLOW_ID}.md"\n  if [ ! -f "$MACRO_PATH" ]; then',
    why: "next.md's --workflow looks only in the checkout's own home",
    killed_by: /next\.md \(bash\): from a linked worktree, --workflow finds the macro stored in the main checkout/,
  },
  {
    id: 'R2', file: 'plugins/orchestrator/commands/approve.md', tests: [T_RESOLVER],
    from: '  if ! MACRO_PATH="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \\\n    resolve-workflow --repo-root "$REPO_ROOT" --workflow-id "$EXPLICIT_WORKFLOW_ID")"; then',
    to: '  MACRO_PATH="$REPO_ROOT/.agentic-plugins/state/orchestrator/workflows/${EXPLICIT_WORKFLOW_ID}.md"\n  if [ ! -f "$MACRO_PATH" ]; then',
    why: "approve.md's --workflow looks only in the checkout's own home",
    killed_by: /approve\.md \(bash\): from a linked worktree, --workflow finds the macro stored in the main checkout/,
  },
  {
    id: 'R3', file: 'plugins/orchestrator/commands/done.md', tests: [T_RESOLVER],
    from: '  if ! MACRO_PATH="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \\\n    resolve-workflow --repo-root "$REPO_ROOT" --workflow-id "$EXPLICIT_WORKFLOW_ID")"; then',
    to: '  MACRO_PATH="$REPO_ROOT/.agentic-plugins/state/orchestrator/workflows/${EXPLICIT_WORKFLOW_ID}.md"\n  if [ ! -f "$MACRO_PATH" ]; then',
    why: "done.md's --workflow looks only in the checkout's own home",
    killed_by: /done\.md \(bash\): from a linked worktree, --workflow finds the macro stored in the main checkout/,
  },
  {
    id: 'R4', file: 'plugins/orchestrator/commands/finalize.md', tests: [T_RESOLVER],
    from: '  if ! MACRO_PATH="$(node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" \\\n    resolve-workflow --repo-root "$REPO_ROOT" --workflow-id "$EXPLICIT_WORKFLOW_ID")"; then',
    to: '  MACRO_PATH="$REPO_ROOT/.agentic-plugins/state/orchestrator/workflows/${EXPLICIT_WORKFLOW_ID}.md"\n  if [ ! -f "$MACRO_PATH" ]; then',
    why: "finalize.md's --workflow looks only in the checkout's own home",
    killed_by: /finalize\.md \(bash\): from a linked worktree, --workflow finds the macro stored in the main checkout/,
  },
  {
    id: 'R5', file: 'plugins/orchestrator/commands/abort.md', tests: [T_RESOLVER],
    from: '  if ! MACRO_PATH="$(node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" \\\n    resolve-workflow --repo-root "$REPO_ROOT" --workflow-id "$EXPLICIT_WORKFLOW_ID")"; then',
    to: '  MACRO_PATH="$REPO_ROOT/.agentic-plugins/state/orchestrator/workflows/${EXPLICIT_WORKFLOW_ID}.md"\n  if [ ! -f "$MACRO_PATH" ]; then',
    why: "abort.md's --workflow looks only in the checkout's own home",
    killed_by: /abort\.md \(bash\): from a linked worktree, --workflow finds the macro stored in the main checkout/,
  },
  // ---- S: the repository-wide scan set (U5b) ----------------------------------
  {
    id: 'S1', file: ORCH_STATE, tests: [T_ORCH],
    from: "        process.stdout.write(`${JSON.stringify(repositoryRoots(flags['repo-root']))}\\n`);",
    to: "        process.stdout.write(`${JSON.stringify(readSet(flags['repo-root']))}\\n`);",
    why: "the scan set leaves out the other worktrees' own homes",
    killed_by: /lists the read set first, then every other worktree, each once/,
  },
  // done's owner scan and --no-commit's active-child scan are one reader now
  // (state.mjs engineerWorkflowFiles, behind owner-dispatch and active-child),
  // so D1 holds both; D2, the active-child scan's own copy, went with it.
  {
    id: 'D1', file: ORCH_STATE, tests: [T_RESOLVER],
    from: "  for (const root of repositoryRoots(repoRoot)) {\n    for (const home of ENGINEER_HOMES) {",
    to: "  for (const root of repositoryRoots(repoRoot).slice(0, 2)) {\n    for (const home of ENGINEER_HOMES) {",
    why: "done's owner and active-child scans leave out the other worktrees' own homes",
    killed_by: [/the owner scan finds a child held only in a third worktree's own home/, /--no-commit refuses while the active child sits in a third worktree's own home/],
  },
  // ---- G: the autopilot observer (U6) -----------------------------------------
  {
    id: 'G1', file: OBSERVE, tests: [T_OBSERVE],
    from: '    const archived = findArchived(orchCli, roots.readSet, ORCHESTRATOR_STATE_HOMES, macroId, o);',
    to: '    const archived = findArchived(orchCli, [repoRoot], ORCHESTRATOR_STATE_HOMES, macroId, o);',
    why: "the observer looks for an archived macro only in the checkout's own homes",
    killed_by: /the archived macro, pinned by id, is found in the read set from a lane/,
  },
  {
    id: 'G2', file: OBSERVE, tests: [T_OBSERVE],
    from: '  const archived = findArchived(engCli, roots.scan, ENGINEER_STATE_HOMES, id, o);',
    to: '  const archived = findArchived(engCli, [repoRoot], ENGINEER_STATE_HOMES, id, o);',
    why: "the observer looks for an archived child only in the checkout's own homes",
    killed_by: /a child archived in a third worktree's own home is found/,
  },
  {
    id: 'G3', file: OBSERVE, tests: [T_OBSERVE],
    from: '  for (const dir of roots.scan.flatMap((root) => ENGINEER_STATE_HOMES.map((home) => path.join(root, home, \'workflows\')))) {',
    to: '  for (const dir of roots.readSet.flatMap((root) => ENGINEER_STATE_HOMES.map((home) => path.join(root, home, \'workflows\')))) {',
    why: "the observer's claims leave out the other worktrees' own homes",
    killed_by: /a live engineer workflow claiming the macro in a third worktree's own home is a claim/,
  },
  {
    id: 'G4', file: OBSERVE, tests: [T_OBSERVE],
    from: '  view.macro = { id, path: located.file, relPath: relTo(stateRoots.scan, located.file), archived: located.archived, fm };',
    to: '  view.macro = { id, path: located.file, relPath: relTo([repoRoot], located.file), archived: located.archived, fm };',
    why: "the macro's pointer is spelled against the checkout, absolute for a macro under the default state root",
    killed_by: /a macro in the main checkout, pinned by id, is found from a lane and pointed to relative to its root/,
  },
  {
    id: 'G5', file: OBSERVE, tests: [T_OBSERVE],
    from: '    if (resolved.code !== RESOLVE_NOT_FOUND) return { error: failure(resolved, \'orchestrator resolve-workflow\') };',
    to: '',
    why: 'a failed macro lookup (two files hold the id) falls through to the archive instead of stopping',
    killed_by: /two files holding the pinned macro are an error, never one of them/,
  },
  {
    id: 'G6', file: OBSERVE, tests: [T_OBSERVE],
    from: "    const resolved = node(orchCli, ['resolve-workflow', '--repo-root', repoRoot, '--workflow-id', macroId], o);",
    to: "    const resolved = { code: RESOLVE_NOT_FOUND, stdout: '', stderr: '' };",
    why: 'the pinned macro is never found active outside the checkout',
    killed_by: /a macro in the main checkout, pinned by id, is found from a lane/,
  },
  {
    id: 'G7', file: ORCH_STATE, tests: [T_OBSERVE, T_ORCH],
    from: '          // 3, not 1: the autopilot observer then looks in the archive, which\n          // it must not do when the lookup failed (exit 1).\n          return 3;',
    to: '          return 1;',
    why: 'resolve-workflow reports "none holds it" as an error, and the observer never reaches the archive',
    killed_by: [/the archived macro, pinned by id, is found in the read set from a lane/, /find-active, find-macro and resolve-workflow from a linked worktree/],
  },
  // ---- F: finalize/abort's child detach pass and resume's archive <id> (U5b) ---
  {
    id: 'F1', file: 'plugins/orchestrator/commands/finalize.md', tests: [T_RESOLVER],
    from: '        const ENG_WORKFLOW_DIRS = JSON.parse(SCAN_ROOTS).flatMap((root) => [',
    to: '        const ENG_WORKFLOW_DIRS = [REPO_ROOT].flatMap((root) => [',
    why: "finalize's detach pass reads only the checkout's own homes, and closes the macro over a child elsewhere",
    killed_by: /finalize\.md \(bash\): run from a lane, the detach pass archives a child held only in a third worktree's own home/,
  },
  {
    id: 'F2', file: 'plugins/orchestrator/commands/abort.md', tests: [T_RESOLVER],
    from: '        const ENG_WORKFLOW_DIRS = JSON.parse(SCAN_ROOTS).flatMap((root) => [',
    to: '        const ENG_WORKFLOW_DIRS = [REPO_ROOT].flatMap((root) => [',
    why: "abort's detach pass reads only the checkout's own homes",
    killed_by: /abort\.md \(bash\): run from a lane, the detach pass archives a child held only in a third worktree's own home/,
  },
  {
    id: 'F3', file: 'plugins/orchestrator/commands/finalize.md', tests: [T_RESOLVER],
    from: 'SCAN_ROOTS="$(node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" scan-roots --repo-root "$REPO_ROOT")" || {',
    to: 'SCAN_ROOTS="$(node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" scan-roots --repo-root "$REPO_ROOT")" || SCAN_ROOTS="[\\"$REPO_ROOT\\"]" || {',
    why: "finalize falls back to the checkout's own homes when the worktrees cannot be listed",
    killed_by: /finalize\.md: a worktree list git cannot give refuses the step/,
  },
  {
    id: 'F4', file: 'plugins/orchestrator/commands/finalize.md', tests: [T_RESOLVER],
    from: '            process.stderr.write(`  ! cannot read ${childPath}: ${err.code || err.message}\\n`);\n            failures += 1;\n',
    to: '',
    why: "finalize reads a child file it cannot read as no child",
    killed_by: /finalize\.md: a file that cannot be read counts as a failure/,
  },
  {
    id: 'F5', file: 'plugins/orchestrator/commands/abort.md', tests: [T_RESOLVER],
    from: '              process.stderr.write(`  ! cannot read ${childPath}: ${err.code || err.message}\\n`);\n              failures += 1;\n',
    to: '',
    why: "abort reads a child file it cannot read as no child",
    killed_by: /abort\.md: a file that cannot be read counts as a failure/,
  },
  {
    id: 'F6', file: 'plugins/orchestrator/commands/resume.md', tests: [T_RESOLVER],
    from: 'if ! WORKFLOW="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \\\n    resolve-workflow --repo-root "$REPO_ROOT" --workflow-id "$ARCHIVE_WORKFLOW_ID")"; then',
    to: 'WORKFLOW="$REPO_ROOT/.agentic-plugins/state/orchestrator/workflows/${ARCHIVE_WORKFLOW_ID}.md"\nif [ ! -f "$WORKFLOW" ]; then',
    why: "resume's archive <workflow-id> looks only in the checkout's own home",
    killed_by: /resume\.md \(bash\): archive <workflow-id> from a linked worktree resolves the macro stored in the main checkout/,
  },
  // ---- X: the third Plan-verify's findings (U4d) ------------------------------
  {
    id: 'X1', file: LIB, tests: [T_ROOT],
    from: "  if (identity.state === 'unreadable') throw unlisted(`its repository identity cannot be read: ${identity.why}`);",
    to: "  if (identity.state === 'unreadable') return [];",
    why: 'a repository whose identity cannot be read reads as one with no other worktree',
    killed_by: /a \.git that cannot be read is an unreadable identity, and the worktree list fails closed/,
  },
  {
    id: 'X2', file: ENG_LIB, tests: [T_WRITERS],
    from: "  if (identity.state === 'unreadable') throw unlisted(`its repository identity cannot be read: ${identity.why}`);",
    to: "  if (identity.state === 'unreadable') return [];",
    why: 'a write to a record in a checkout whose identity cannot be read goes through',
    killed_by: /a repository whose identity cannot be read refuses a write/,
  },
  {
    id: 'X3', file: LIB, tests: [T_ROOT],
    from: "  if (holderIdentity.state === 'unreadable') return unknown;\n",
    to: "",
    why: "a storage root whose identity cannot be read hands out its own slot as the command's",
    killed_by: /a \.git that cannot be read is an unreadable identity, and the worktree list fails closed/,
  },
  {
    id: 'X4', file: ENG_LIB, tests: [T_WRITERS],
    from: 'export function writerRoots(stateRoot, cwd = commandDirectory()) {',
    to: 'export function writerRoots(stateRoot, cwd = process.cwd()) {',
    why: "the write guard judges the process's working directory, not the checkout its caller names",
    killed_by: /the Stop judges the checkout it is given, not the process's working directory/,
  },
  {
    id: 'X5', file: STOP, tests: [T_WRITERS],
    from: '  return args?.repoRoot ? runInCommandDirectory(args.repoRoot, () => runStopArchiveInCheckout(args)) : runStopArchiveInCheckout(args);',
    to: '  return runStopArchiveInCheckout(args);',
    why: 'the Stop writes outside the checkout it was given',
    killed_by: /the Stop judges the checkout it is given, not the process's working directory/,
  },
  {
    id: 'X6', file: WRITEBACK, tests: [T_WRITERS],
    from: "      { encoding: 'utf8', timeout: 30_000, cwd: resolve(repoRoot) },",
    to: "      { encoding: 'utf8', timeout: 30_000 },",
    why: "the writeback's orchestrator subprocess judges the caller's working directory, not the child's checkout",
    killed_by: /written back from a process elsewhere, is judged in the lane/,
  },
  {
    id: 'X7', file: ORCH_LIB, tests: [T_ORCH],
    from: 'export function writerRoots(stateRoot, cwd = commandDirectory()) {',
    to: 'export function writerRoots(stateRoot, cwd = process.cwd()) {',
    why: "orchestrator's write guard judges the process's working directory",
    killed_by: /orchestrator: the writers judge the caller's checkout and one file once .* > the Stop judges the checkout it is given/,
  },
  {
    id: 'X8', file: STATE, tests: [T_WRITERS],
    from: '      if (fmBranch === branch) addPhysicalMatch(matching, file);',
    to: '      if (fmBranch === branch) matching.push(file);',
    why: 'one workflow reached through two names in its home is two',
    killed_by: /one workflow reached through two names in its home is one workflow/,
  },
  {
    id: 'X10', file: STATE, tests: [T_WRITERS],
    from: '    if (lstatSync(matching[index]).isSymbolicLink() && !lstatSync(file).isSymbolicLink()) matching[index] = file;\n',
    to: '',
    why: 'the branch lookup hands a writer the link, which it refuses, rather than the file',
    killed_by: /one workflow reached through two names in its home is one workflow/,
  },
  {
    id: 'X11', file: ORCH_STATE, tests: [T_ORCH],
    from: '      if (fmBranch === branch) addPhysicalMatch(matching, file);',
    to: '      if (fmBranch === branch) matching.push(file);',
    why: 'one macro reached through two names in its home is two',
    killed_by: /one macro reached through two names in its home is one macro/,
  },
  {
    id: 'X13', file: HANDOFF, tests: [T_WRITERS],
    from: '    if (repoRoot && slotAliasedComponent(repoRoot, target) !== null) continue;\n',
    to: '',
    why: "a SessionStart reads, then consumes, another checkout's slot through a linked home",
    killed_by: /a slot under a home linked to another checkout's is neither read nor consumed/,
  },
  {
    id: 'X14', file: HANDOFF, tests: [T_WRITERS],
    from: '  if (repoRoot && slotAliasedComponent(repoRoot, projectionFile) !== null) return;\n',
    to: '',
    why: "consuming a slot path through a linked home removes another checkout's slot",
    killed_by: /a slot under a home linked to another checkout's is neither read nor consumed/,
  },
  {
    id: 'X15', file: ORCH_HANDOFF, tests: [T_ORCH],
    from: '    if (repoRoot && slotAliasedComponent(repoRoot, target) !== null) continue;\n',
    to: '',
    why: "orchestrator's SessionStart reads, then consumes, another checkout's slot",
    killed_by: /orchestrator: the writers judge the caller's checkout .* > a slot under a home linked to another checkout's/,
  },
  {
    id: 'X16', file: ORCH_HANDOFF, tests: [T_ORCH],
    from: '  if (repoRoot && slotAliasedComponent(repoRoot, projectionFile) !== null) return;\n',
    to: '',
    why: "consuming an orchestrator slot path through a linked home removes another checkout's slot",
    killed_by: /orchestrator: the writers judge the caller's checkout .* > a slot under a home linked to another checkout's/,
  },
  {
    id: 'X17', file: RUNNER, tests: [T_WRITERS],
    from: '    if (!(await present(paths.handle))) continue;\n    let handle;',
    to: '    if (!(await exists(paths.handle))) continue;\n    let handle;',
    why: 'an inaccessible ledger reads as no attempt, and settle with no run id reports skipped',
    killed_by: /a ledger that cannot be judged is no absence/,
  },
  {
    id: 'X22', file: RUNNER, tests: [T_WRITERS],
    from: "  const merged = { ...reports[reports.length - 1], root: own, roots",
    to: "  const merged = { ...reports[reports.length - 1], root: (scans.find((scan) => sameDirectory(scan.stateRoot, resolve(repoRoot))) ?? scans[scans.length - 1]).dir, roots",
    why: "the sweep reports another root's directory as the checkout's own when they are linked",
    killed_by: /the sweep reports the checkout's own directory when it is linked to another root's/,
  },
  {
    id: 'X23', file: ORCH_RUNNER, tests: [T_ORCH],
    from: "  const merged = { ...reports[reports.length - 1], root: own, roots",
    to: "  const merged = { ...reports[reports.length - 1], root: (scans.find((scan) => sameDirectory(scan.stateRoot, resolve(repoRoot))) ?? scans[scans.length - 1]).dir, roots",
    why: "orchestrator's sweep reports another root's directory as the checkout's own",
    killed_by: /orchestrator: the writers judge the caller's checkout .* > the sweep reports the checkout's own directory/,
  },
  {
    id: 'X24', file: ENG_LIB, tests: [T_WRITERS],
    from: '  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));',
    to: '  const fd = fs.openSync(file, fs.constants.O_RDONLY);',
    why: "a FIFO in another root's home stalls every write's copy scan",
    killed_by: /a FIFO in another root refuses the copy scan at once/,
  },
  {
    id: 'X25', file: STATE, tests: [T_WRITERS],
    from: "      if (err.code === 'ENOENT') continue;\n      throw new Error(\n        `findActiveWorkflowByBranch: failed to read workflow file",
    to: "      throw new Error(\n        `findActiveWorkflowByBranch: failed to read workflow file",
    why: 'a workflow archived between the listing and its read makes the branch lookup throw',
    killed_by: /a name listed but gone by its read is no workflow and no copy/,
  },
  {
    id: 'X26', file: ENG_LIB, tests: [T_WRITERS],
    from: "      let head;\n      try {\n        head = readFrontmatterText(candidate);",
    to: "      if (entry === name) { copies.push(candidate); continue; }\n      let head;\n      try {\n        head = readFrontmatterText(candidate);",
    why: "a same-name file gone since the listing counts as a copy and refuses the write",
    killed_by: /a name listed but gone by its read is no workflow and no copy/,
  },
  {
    id: 'X27', file: LIB, tests: [T_ROOT],
    from: '  if (isUnder(realOr(holder), realOr(own))) return false;\n',
    to: '',
    why: 'the git dir git names as the main worktree, holding a .git, is taken for a working tree',
    killed_by: /the git dir git names is no working tree, even holding a \.git/,
  },
  {
    id: 'X28', file: LIB, tests: [T_ROOT],
    from: '  return checkedOutEntryOnDisk(holder) !== null;\n}',
    to: '  return true;\n}',
    why: 'the metadata directory git names as the main worktree is taken for a working tree',
    killed_by: /a separate git dir named \.git: the metadata directory git names is no working tree/,
  },
  {
    id: 'X29', file: LIB, tests: [T_ROOT],
    from: '  return commandDirectoryStore.run(path.resolve(dir), fn);',
    to: '  return fn();',
    why: 'runInCommandDirectory names no checkout, and every writer falls back to the working directory',
    killed_by: /runInCommandDirectory names the checkout a writer judges/,
  },
  // ---- Y: the fourth Plan-verify's findings (U4e) ----------------------------
  {
    id: 'Y1', file: STATE, tests: [T_WRITERS],
    from: "    return runInCommandDirectory(flags['repo-root'], () => cliRun(subcommand, flags));",
    to: '    return cliRun(subcommand, flags);',
    why: 'a persona CLI given --repo-root judges the process\'s working directory, and an archive from outside the lane passes a second workflow there',
    killed_by: /archive --repo-root <lane>, run from outside every repository, judges the lane: a second workflow there refuses/,
  },
  {
    id: 'Y3', file: ORCH_STATE, tests: [T_ORCH],
    from: "    return runInCommandDirectory(flags['repo-root'], () => cliRun(subcommand, flags));",
    to: '    return cliRun(subcommand, flags);',
    why: "orchestrator's CLI given --repo-root judges the working directory, and archives beside a second macro in the lane",
    killed_by: /archive --repo-root <lane>, run from outside every repository, judges the lane: a second macro there refuses/,
  },
  {
    id: 'Y5', file: LIB, tests: [T_ROOT],
    from: '    // lost, not the absence of one.\n    return unreadable(dotGit, error);',
    to: "    // lost, not the absence of one.\n    return { state: 'none' };",
    why: 'a .git link to nothing reads as no repository, and the worktree list comes back empty',
    killed_by: /a \.git link that names nothing is a lost identity/,
  },
  {
    id: 'Y6', file: LIB, tests: [T_ROOT],
    from: '  } catch (error) {\n    return unreadable(named, error, named);\n  }',
    to: "  } catch (error) {\n    return { state: 'ok', commonDir: named };\n  }",
    why: 'a common dir that is gone reads as a repository with no linked worktree',
    killed_by: /a commondir naming a directory that is gone is a lost identity/,
  },
  {
    id: 'Y7', file: LIB, tests: [T_ROOT],
    from: "  return identity.state === 'unreadable' ? identity.readerCommonDir : null;",
    to: '  return null;',
    why: "the readers' common dir parts from runtime's copy for a common dir that is gone",
    killed_by: /a commondir naming a directory that is gone is a lost identity; readers keep the name, as runtime does/,
  },
  {
    id: 'Y8', file: ENG_LIB, tests: [T_WRITERS],
    from: "      const start = length;\n      length += n;",
    to: "      const start = length;\n      length += n;\n      if (length >= 256 * 1024) break;",
    why: "the copy scan reads a head again, and a workflow_id past it is no copy",
    killed_by: /a copy whose workflow_id sits past the first 256 KiB of its frontmatter is a copy/,
  },
  {
    id: 'Y9', file: LIB, tests: [T_ROOT],
    from: "      const searched = Buffer.concat([carry, got]);\n      const windowStart = start - carry.length;",
    to: "      const searched = got;\n      const windowStart = start;",
    why: "the close is looked for in the last chunk only: one straddling two chunks is missed",
    killed_by: /readFrontmatterText reads through the frontmatter, never a FIFO, never past the close/,
  },
  {
    id: 'Y10', file: STATE, tests: [T_WRITERS],
    from: '      text = readFrontmatterText(file);',
    to: "      text = await readFile(file, 'utf8');",
    why: "the persona branch scan opens a FIFO and waits on it under the writer's lock",
    killed_by: /a FIFO in a home of the read set refuses the branch scan at once/,
  },
  {
    id: 'Y11', file: ORCH_STATE, tests: [T_ORCH],
    from: '      text = readFrontmatterText(file);',
    to: "      text = await readFile(file, 'utf8');",
    why: "orchestrator's branch scan opens a FIFO and waits on it under the writer's lock",
    killed_by: /a FIFO in a home of the read set refuses the branch scan and find-macro at once/,
  },
  // ---- Z: the driver's state root (U7a) --------------------------------------
  {
    id: 'Y12', file: STATE, tests: [T_WRITERS],
    from: '    if (file) addPhysicalMatch(found, file);',
    to: '    if (file && !found.some((f) => samePhysicalFile(f, file))) found.push(file);',
    why: "a file reached through two read roots is handed over under the default root's link, which every writer refuses",
    killed_by: /a file reached through two read roots is handed to a writer under the name that is not a link/,
  },
  {
    id: 'Y13', file: ORCH_STATE, tests: [T_ORCH],
    from: '    if (file) addPhysicalMatch(found, file);',
    to: '    if (file && !found.some((f) => samePhysicalFile(f, file))) found.push(file);',
    why: "a macro reached through two read roots is handed over under the default root's link",
    killed_by: /a macro reached through two read roots is handed to a writer under the name that is not a link/,
  },
  {
    id: 'Z1', file: WORKER, tests: [T_WORKER, T_DRIVER],
    from: "  if (typeof stateBase === 'string' && stateBase !== '') env.AGENTIC_STATE_BASE = stateBase;",
    to: '',
    why: "a worker gets no state root, and its scripts create where the switch says, not where the run resolved",
    killed_by: [/exports the run's state root, never the inherited one/, /is resolved once at start, recorded in run\.json and exported to every worker/],
  },
  {
    id: 'Z2', file: DRIVER, tests: [T_DRIVER],
    from: '        stateBase: stateRoot.root,',
    to: '',
    why: "the driver resolves a state root it never hands to its workers",
    killed_by: /is resolved once at start, recorded in run\.json and exported to every worker/,
  },
  {
    id: 'Z3', file: DRIVER, tests: [T_DRIVER],
    from: '  if (!exported.ok) return { stateRoot: null, problem: ',
    to: '  if (false) return { stateRoot: null, problem: ',
    why: "a run driven from a lane starts, and exports a state root every worker's create then refuses",
    killed_by: /a driven checkout that is a lane refuses the start/,
  },
  {
    id: 'Z4', file: DRIVER, tests: [T_DRIVER],
    from: '    state_root: stateRoot,',
    to: '',
    why: "run.json does not record the state root the run used",
    killed_by: /is resolved once at start, recorded in run\.json and exported to every worker/,
  },
  // ---- Q: the fifth Plan-verify's findings (U4f) ----------------------------
  {
    id: 'Q1', file: LIB, tests: [T_ROOT],
    from: "  const everyRoot = at.kind === 'unknown' || (at.kind === 'outside' && named !== undefined && path.resolve(cwd) === named);",
    to: "  const everyRoot = at.kind === 'unknown';",
    why: "a directory the caller names outside the repository narrows the write guard to the storage root",
    killed_by: /writerRoots: a directory the caller names that is no checkout of the repository reads every root of it/,
  },
  {
    id: 'Q2', file: ENG_LIB, tests: [T_WRITERS],
    from: "  const everyRoot = at.kind === 'unknown' || (at.kind === 'outside' && named !== undefined && path.resolve(cwd) === named);",
    to: "  const everyRoot = at.kind === 'unknown';",
    why: "a mistyped --repo-root lets an archive through beside a second workflow in another worktree",
    killed_by: /an explicit --repo-root that names no checkout of the repository reads every root of it/,
  },
  {
    id: 'Q3', file: ORCH_LIB, tests: [T_ORCH],
    from: "  const everyRoot = at.kind === 'unknown' || (at.kind === 'outside' && named !== undefined && path.resolve(cwd) === named);",
    to: "  const everyRoot = at.kind === 'unknown';",
    why: "a mistyped --repo-root lets a macro archive through beside a second macro in another worktree",
    killed_by: /an explicit --repo-root that names no checkout of the repository reads every root of it/,
  },
  {
    id: 'Q10', file: LIB, tests: [T_ROOT],
    from: "      const searched = Buffer.concat([carry, got]);\n      const windowStart = start - carry.length;",
    to: "      const searched = Buffer.concat(chunks, length);\n      const windowStart = 0;",
    why: "the frontmatter read searches the whole prefix per chunk: quadratic under a writer's lock",
    killed_by: /readFrontmatterText reads no body, and joins what it reads about once: linear, never quadratic/,
  },
  {
    id: 'Q11', file: LIB, tests: [T_ROOT],
    from: "    fs.lstatSync(commonDirFile);",
    to: "    fs.statSync(commonDirFile);",
    why: "a commondir link to nothing reads as no commondir, and the identity as whole",
    killed_by: /a commondir link that names nothing is a lost identity/,
  },
  {
    id: 'Q12', file: ORCH_STATE, tests: [T_ORCH],
    from: "          if (lstatSync(files[index]).isSymbolicLink() && !lstatSync(file).isSymbolicLink()) files[index] = file;",
    to: "",
    why: "find-macro hands out the link spelling of a macro reached through two read roots",
    killed_by: /a macro reached through two read roots is handed to a writer under the name that is not a link/,
  },
  {
    id: 'Q13', file: ORCH_STATE, tests: [T_ORCH],
    from: "      addPhysicalMatch(found, candidate);",
    to: "      if (!found.some((f) => samePhysicalFile(f, candidate))) found.push(candidate);",
    why: "resolve-workflow hands out the link spelling of a macro reached through two read roots",
    killed_by: /a macro reached through two read roots is handed to a writer under the name that is not a link/,
  },
  {
    id: 'Q14', file: STATE, tests: [T_WRITERS],
    from: "          if (lstatSync(files[index]).isSymbolicLink() && !lstatSync(file).isSymbolicLink()) files[index] = file;",
    to: "",
    why: "the persona lister hands the Stop's sweep the link spelling of a workflow reached through two read roots",
    killed_by: /the lister hands out the name that is not a link/,
  },
  {
    id: 'Q16', file: RUNNER, tests: [T_WRITERS],
    from: "  if (options.kind === 'ensemble' && options.workflowPath) await assertWorkflowWritable(options.workflowPath);\n",
    to: "",
    why: "an ensemble run beside a refused workflow writes its ledger and calls the companion",
    killed_by: /an ensemble run the write guard refuses writes no ledger and calls no companion/,
  },
  {
    id: 'Q17', file: ORCH_RUNNER, tests: [T_ORCH],
    from: "  if (options.kind === 'ensemble' && options.workflowPath) await assertWorkflowWritable(options.workflowPath);\n",
    to: "",
    why: "a macro ensemble run beside a refused macro writes its ledger and calls the companion",
    killed_by: /is refused beside a second macro: no ledger, no companion call/,
  },
  {
    id: 'Q18', file: ENG_LIB, tests: [T_WRITERS],
    from: "      if (head === null) throw failed(candidate, { message: 'not a regular file' });",
    to: "      if (head === null) continue;",
    why: "the copy scan passes over a FIFO under a workflow name, which runtime reads as no regular file",
    killed_by: /a FIFO in another root refuses the copy scan at once/,
  },
  {
    id: 'Q19', file: LIB, tests: [T_ROOT],
    from: "      if (head === null) throw failed(candidate, { message: 'not a regular file' });",
    to: "      if (head === null) continue;",
    why: "a workflow name that is no regular file is no copy",
    killed_by: /otherCopiesOf: a workflow name that is no regular file fails closed/,
  },
  {
    id: 'Q20', file: STATE, tests: [T_WRITERS],
    from: "    if (text === null) {\n      throw new Error(\n        `findActiveWorkflowByBranch: workflow file",
    to: "    if (text === null) continue;\n    if (false) {\n      throw new Error(\n        `findActiveWorkflowByBranch: workflow file",
    why: "the branch scan passes over a FIFO under a workflow name",
    killed_by: /a FIFO in a home of the read set refuses the branch scan at once/,
  },
  {
    id: 'Q21', file: ORCH_STATE, tests: [T_ORCH],
    from: "    if (text === null) {\n      throw new Error(\n        `findActiveWorkflowByBranch: workflow file",
    to: "    if (text === null) continue;\n    if (false) {\n      throw new Error(\n        `findActiveWorkflowByBranch: workflow file",
    why: "orchestrator's branch scan passes over a FIFO under a macro name",
    killed_by: /a FIFO in a home of the read set refuses the branch scan and find-macro at once/,
  },
  {
    id: 'Q22', file: RUNNER, tests: [T_WRITERS],
    from: "        if (typeof opts.repoRoot !== 'string' || opts.repoRoot === '' || opts.repoRoot.startsWith('--')) {\n          throw new Error('--repo-root needs a path');\n        }\n",
    to: "",
    why: "--repo-root with no path crashes the runner outside its handled path",
    killed_by: /peer-runner --repo-root with no path is a usage error, not a crash/,
  },
  {
    id: 'Q23', file: ORCH_RUNNER, tests: [T_ORCH],
    from: "        if (typeof opts.repoRoot !== 'string' || opts.repoRoot === '' || opts.repoRoot.startsWith('--')) {\n          throw new Error('--repo-root needs a path');\n        }\n",
    to: "",
    why: "--repo-root with no path crashes orchestrator's runner",
    killed_by: /peer-runner --repo-root with no path is a usage error, not a crash/,
  },
  {
    id: 'Q24', file: PHASE7, tests: [T_WRITERS],
    from: "  return repoRoot ? runInCommandDirectory(repoRoot, () => runMain(argv)) : runMain(argv);",
    to: "  return runMain(argv);",
    why: "Phase 7 run from outside judges the storage root, not the lane --repo-root names",
    killed_by: /Phase 7 from outside every repository judges the lane it names/,
  },
  // ---- K: the admission entries (U7b) ----------------------------------------
  {
    id: 'K1', file: RUN_LOCKS, tests: [T_ADMISSION],
    from: "  if (e.session) return e.holder === null && now() - e.mtimeMs < FRESH_UNPARSED_MS ? 'busy' : 'live';\n",
    to: "",
    why: "an admission entry is judged by a pid it does not have: gone, cleared as debris, and a run starts beside the session",
    killed_by: [/an admission blocks a run starting, and is never cleared/, /a second join beside a live admission is refused/],
  },
  {
    id: 'K2', file: RUN_LOCKS, tests: [T_ADMISSION],
    from: "  for (const name of names.filter((n) => ENTRY.test(n) || ADMISSION_ENTRY.test(n)).sort()) {",
    to: "  for (const name of names.filter((n) => ENTRY.test(n)).sort()) {",
    why: "the lock's readers do not see an admission entry, as an older driver would not",
    killed_by: [/an admission blocks a run starting, and is never cleared/, /a second join beside a live admission is refused/],
  },
  {
    id: 'K3', file: RUN_LOCKS, tests: [T_ADMISSION],
    from: "      if (rival) throw new LockHeldError(lock, rival.holder ?? { run_id: 'a participant taking the lock' }, { now: now() });\n      await clearDebris(lock, after);",
    to: "      await clearDebris(lock, after);",
    why: "a join does not look again after writing its entries, so a run that added its own meanwhile runs beside the session",
    killed_by: /a run that adds its entry while a session joins is seen on the second look/,
  },
  {
    id: 'K4', file: RUN_LOCKS, tests: [T_ADMISSION],
    from: "  return got.length === want.length && got.length > 0 && timingSafeEqual(got, want);",
    to: "  return true;",
    why: "any session naming the holding run passes as its worker, whatever its token",
    killed_by: /the holding run's workers pass with no entry; another run's worker, a wrong token or none is refused/,
  },
  {
    id: 'K5', file: RUN_LOCKS, tests: [T_ADMISSION],
    from: "  return [...(command === 'next' ? [worktreeLockPath(root)] : []), macroLockPath(mainWorktreeRoot(root), macroId)];",
    to: "  return [macroLockPath(mainWorktreeRoot(root), macroId)];",
    why: "/orchestrator:next does not join its checkout's worktree lock, so it can switch the branch under a run of another macro",
    killed_by: [/join writes one entry in each lock its command joins/, /a second join beside a live admission is refused/],
  },
  {
    id: 'K6', file: RUN_LOCKS, tests: [T_ADMISSION],
    from: "    if (!readEntryOrNull(admissionEntryPath(lock, admissionId))) return { ok: false, why: ",
    to: "    if (false) return { ok: false, why: ",
    why: "check looks at the macro lock's entry only: a released worktree entry goes unseen",
    killed_by: /check stops when any entry of the admission is gone/,
  },
  {
    id: 'K7', file: RUN_LOCKS, tests: [T_ADMISSION],
    from: "  if (path.resolve(own.holder.checkout ?? '') !== path.resolve(checkout)) {",
    to: "  if (false) {",
    why: "an admission made for one checkout guards an action in another",
    killed_by: /check stops when any entry of the admission is gone, or it was made for another checkout/,
  },
  {
    id: 'K8', file: RUN_LOCKS, tests: [T_ADMISSION],
    from: "  for (const lock of admissionLocks({ command: 'next', checkout, macroId })) {\n    const file = admissionEntryPath(lock, admissionId);\n    try {",
    to: "  for (const lock of admissionLocks({ command: 'done', checkout, macroId })) {\n    const file = admissionEntryPath(lock, admissionId);\n    try {",
    why: "release leaves /orchestrator:next's worktree-lock entry behind",
    killed_by: /join writes one entry in each lock its command joins; check sees it; release removes it/,
  },
  {
    id: 'K9', file: RUN_LOCKS, tests: [T_ADMISSION],
    from: "${age > ADMISSION_STALE_MS ? ' (stale: older than 4 h; judge whether that session is gone)' : ''}",
    to: "",
    why: "an admission older than 4 h is not shown as stale",
    killed_by: /shown as stale past 4 h/,
  },
  {
    id: 'K10', file: DRIVER, tests: [T_DRIVER],
    from: ", token_digest: tokenDigest(token) };",
    to: " };",
    why: "the run's lock entry holds no digest, so its workers cannot pass the admission",
    killed_by: /draws a secret its workers carry, and writes only the secret's digest/,
  },
  {
    id: 'K11', file: DRIVER, tests: [T_DRIVER],
    from: "        autopilotToken: token,\n",
    to: "",
    why: "the driver never hands its workers the run's secret",
    killed_by: /draws a secret its workers carry, and writes only the secret's digest/,
  },
  {
    id: 'K12', file: WORKER, tests: [T_WORKER, T_DRIVER],
    from: "  if (typeof autopilotToken === 'string' && autopilotToken !== '') env.AGENTIC_AUTOPILOT_TOKEN = autopilotToken;\n",
    to: "",
    why: "a worker's environment lacks the run's secret",
    killed_by: [/exports the run's admission secret, never an inherited one/, /draws a secret its workers carry/],
  },
  // ---- J: the sixth Plan-verify's findings (U4g) -----------------------------
  {
    id: 'J1', file: ENG_LIB, tests: [T_WRITERS],
    from: "    if (entry.isDirectory()) out.push({ runId: entry.name, runDir: path.join(dir, entry.name) });",
    to: "    if (entry.isDirectory() || entry.isSymbolicLink()) out.push({ runId: entry.name, runDir: path.join(dir, entry.name) });",
    why: "a link in a peer-runs directory is listed as a run directory, unlike runtime's readers",
    killed_by: /a link in place of a run directory is no ledger: settle with no run id and the sweep pass it by/,
  },
  {
    id: 'J2', file: ORCH_LIB, tests: [T_ORCH],
    from: "    if (entry.isDirectory()) out.push({ runId: entry.name, runDir: path.join(dir, entry.name) });",
    to: "    if (entry.isDirectory() || entry.isSymbolicLink()) out.push({ runId: entry.name, runDir: path.join(dir, entry.name) });",
    why: "orchestrator's sweep and status read a ledger through a link (the sweep's stillSole check also refuses one in place of a run directory)",
    killed_by: [/a link in a peer-runs directory is no ledger, whatever it names/, /a link beside a ledger is no second name/],
  },
  {
    id: 'J3', file: LIB, tests: [T_ROOT],
    from: "  return own.isDirectory();\n}",
    to: "  return own.isDirectory() || own.isSymbolicLink();\n}",
    why: "a link is taken for a run directory",
    killed_by: /runDirectoryEntries: a directory is a run directory, a link never is/,
  },
  {
    id: 'J7', file: STATE, tests: [T_WRITERS],
    from: "      if (problem === 'gone') continue;\n      if (problem !== null) {\n        throw new Error(\n          `${personaName()} workflow home",
    to: "      if (problem === 'gone') continue;\n      if (problem !== null && false) {\n        throw new Error(\n          `${personaName()} workflow home",
    why: "the persona lister hands the Stop's sweep a FIFO",
    killed_by: /the lister refuses a FIFO in a workflow home/,
  },
  {
    id: 'J8', file: ORCH_STATE, tests: [T_ORCH],
    from: "      if (problem === 'gone') continue;\n      if (problem !== null) {\n        throw new Error(\n          `orchestrator workflow home",
    to: "      if (problem === 'gone') continue;\n      if (problem !== null && false) {\n        throw new Error(\n          `orchestrator workflow home",
    why: "the Stop's macro list hands out a FIFO",
    killed_by: /a FIFO in a macro's place is refused at once/,
  },
  {
    id: 'J9', file: ORCH_STATE, tests: [T_ORCH],
    from: "      if (problem !== null) {\n        throw new Error(`orchestrator workflow storage: ${JSON.stringify(candidate)}",
    to: "      if (problem !== null && false) {\n        throw new Error(`orchestrator workflow storage: ${JSON.stringify(candidate)}",
    why: "resolve-workflow hands out a FIFO as the macro",
    killed_by: /a FIFO in a macro's place is refused at once/,
  },
  {
    id: 'J10', file: STATE, tests: [T_WRITERS],
    from: "    text = readFrontmatterText(absolute);\n  } catch (err) {\n    if (err.code === 'ENOENT') return;\n    throw err;\n  }\n  if (text === null) {",
    to: "    text = await readFile(absolute, 'utf8');\n  } catch (err) {\n    if (err.code === 'ENOENT') return;\n    throw err;\n  }\n  if (text === null) {",
    why: "the persona write guard waits on a FIFO in the record's place",
    killed_by: /a FIFO in the record's place is refused by the write guard at once/,
  },
  {
    id: 'J11', file: ORCH_STATE, tests: [T_ORCH],
    from: "    text = readFrontmatterText(absolute);\n  } catch (err) {\n    if (err.code === 'ENOENT') return;\n    throw err;\n  }\n  if (text === null) {",
    to: "    text = await readFile(absolute, 'utf8');\n  } catch (err) {\n    if (err.code === 'ENOENT') return;\n    throw err;\n  }\n  if (text === null) {",
    why: "orchestrator's write guard waits on a FIFO in the macro's place",
    killed_by: /a FIFO in a macro's place is refused at once/,
  },
  {
    id: 'J12', file: ORCH_STOP, tests: [T_ORCH],
    from: "    const text = readFrontmatterText(workflowPath);\n    if (text === null) return { statusDigest, headSubject };",
    to: "    const text = await readFile(workflowPath, 'utf8');",
    why: "the Stop's macro facts wait on a FIFO",
    killed_by: /a FIFO in a macro's place is refused at once/,
  },
  {
    id: 'J13', file: LIB, tests: [T_ROOT],
    from: "    const fd = fs.openSync(commonDirFile, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));\n    try {\n      if (!fs.fstatSync(fd).isFile()) return unreadable(commonDirFile, 'not a regular file');\n      commonDir = fs.readFileSync(fd, 'utf8').trim();\n    } finally {\n      fs.closeSync(fd);\n    }",
    to: "    commonDir = fs.readFileSync(commonDirFile, 'utf8').trim();",
    why: "a commondir that is a FIFO stalls every writer's identity read",
    killed_by: /a commondir that is a FIFO is a lost identity, read at once/,
  },
  {
    id: 'J14', file: RUNNER, tests: [T_WRITERS],
    from: "      if (identity === null || now !== identity) {",
    to: "      if (identity === null) {",
    why: "the persona sweep deletes a ledger recreated under its run id since the plan",
    killed_by: /the sweep deletes only the ledger it planned/,
  },
  {
    id: 'J15', file: ORCH_RUNNER, tests: [T_ORCH],
    from: "      if (identity === null || now !== identity) {",
    to: "      if (identity === null) {",
    why: "orchestrator's sweep deletes a ledger recreated since the plan",
    killed_by: /the sweep deletes only the ledger it planned/,
  },
  {
    id: 'J16', file: RUNNER, tests: [T_WRITERS],
    from: "      if (held.length > 0) {",
    to: "      if (false) {",
    why: "the persona sweep prunes a ledger whose run id a second ledger took since the plan",
    killed_by: /a second ledger made in an empty legacy home since the plan is seen right before the deletion/,
  },
  {
    id: 'J17', file: ORCH_RUNNER, tests: [T_ORCH],
    from: "      if (held.length > 0) {",
    to: "      if (false) {",
    why: "orchestrator's sweep prunes a ledger whose run id a second ledger took since the plan",
    killed_by: /a second ledger made in an empty legacy home since the plan is seen right before the deletion/,
  },
  {
    id: 'J18', file: RUNNER, tests: [T_WRITERS],
    from: "  return runInCommandDirectory(args?.repoRoot ?? process.cwd(), () => runPeerInCheckout(args));",
    to: "  return runPeerInCheckout(args);",
    why: "runPeer called as an API judges the storage root, not the checkout it names",
    killed_by: [/runPeer called as an API judges the checkout repoRoot names/, /a second workflow made after the precheck is refused by the locked registration/],
  },
  {
    id: 'J19', file: ORCH_RUNNER, tests: [T_ORCH],
    from: "  return runInCommandDirectory(args?.repoRoot ?? process.cwd(), () => runPeerInCheckout(args));",
    to: "  return runPeerInCheckout(args);",
    why: "orchestrator's runPeer called as an API judges the storage root",
    killed_by: /runPeer called as an API judges the checkout repoRoot names/,
  },
  {
    id: 'J20', file: RUNNER, tests: [T_WRITERS],
    from: "  return runInCommandDirectory(args.repoRoot ?? process.cwd(), () => settleEnsembleInCheckout(args));",
    to: "  return settleEnsembleInCheckout(args);",
    why: "settleEnsemble called as an API judges the storage root",
    killed_by: /settleEnsemble called as an API judges the checkout repoRoot names/,
  },
  {
    id: 'J21', file: RUNNER, tests: [T_WRITERS],
    from: "  return runDirectoryEntries(dir).length > 0;",
    to: "  return (await readdir(dir).catch(() => [])).length > 0;",
    why: "a stray file in the legacy peer-runs directory makes it a second home",
    killed_by: /a stray file or link in the legacy peer-runs directory is no ledger/,
  },
  {
    id: 'J22', file: ORCH_RUNNER, tests: [T_ORCH],
    from: "  return runDirectoryEntries(dir).length > 0;",
    to: "  return (await readdir(dir).catch(() => [])).length > 0;",
    why: "a stray file in orchestrator's legacy peer-runs directory makes it a second home",
    killed_by: /a stray file or link in the legacy peer-runs directory is no ledger/,
  },
  {
    id: 'J23', file: RUNNER, tests: [T_WRITERS],
    from: " || opts.repoRoot.startsWith('--')) {",
    to: ") {",
    why: "the persona runner takes the option after --repo-root for a path",
    killed_by: /--repo-root followed by another option is a usage error/,
  },
  {
    id: 'J24', file: ORCH_RUNNER, tests: [T_ORCH],
    from: " || opts.repoRoot.startsWith('--')) {",
    to: ") {",
    why: "orchestrator's runner takes the option after --repo-root for a path",
    killed_by: /--repo-root followed by another option is a usage error/,
  },
  // ---- H: the seventh Plan-verify's findings (U4h) ---------------------------
  {
    id: 'H1', file: RUNNER, tests: [T_WRITERS],
    from: "  if (!absentAt(fallback.dir)) {",
    to: "  if (false) {",
    why: "status and settle read a ledger through a link where the run id has no run directory",
    killed_by: /a link where a run id has no ledger is refused by status and settle/,
  },
  {
    id: 'H2', file: ORCH_RUNNER, tests: [T_ORCH],
    from: "  if (!absentAt(fallback.dir)) {",
    to: "  if (false) {",
    why: "orchestrator's status reads through a link where the run id has no run directory",
    killed_by: /a link where a run id has no ledger is refused by status/,
  },
  {
    id: 'H3', file: RUNNER, tests: [T_WRITERS],
    from: "  const dirs = peerRunReadRoots(repoRoot).flatMap((root) => Object.keys(peerRunsDirRels()).map((home) => peerRunsDir(root, { home })));",
    to: "  const dirs = scans.map((scan) => scan.dir);",
    why: "the persona sweep asks again only in the homes it selected, missing a second ledger in an empty one",
    killed_by: /a second ledger made in an empty legacy home/,
  },
  {
    id: 'H4', file: ORCH_RUNNER, tests: [T_ORCH],
    from: "  const dirs = peerRunReadRoots(repoRoot).flatMap((root) => Object.keys(PEER_RUNS_DIR_RELS).map((home) => peerRunsDir(root, { home })));",
    to: "  const dirs = scans.map((scan) => scan.dir);",
    why: "orchestrator's sweep asks again only in the homes it selected",
    killed_by: /a second ledger made in an empty legacy home/,
  },
  {
    id: 'H5', file: RUNNER, tests: [T_WRITERS],
    from: "guard: () => stillSole(runId, runDir) })",
    to: "guard: null })",
    why: "the persona sweep reconciles a ledger a second ledger joined since its check",
    killed_by: /the sweep asks again at the reconciling write/,
  },
  {
    id: 'H6', file: ORCH_RUNNER, tests: [T_ORCH],
    from: "guard: () => stillSole(runId, runDir) })",
    to: "guard: null })",
    why: "orchestrator's sweep reconciles a ledger a second ledger joined since its check",
    killed_by: /the sweep asks again at the reconciling write/,
  },
  {
    id: 'H7', file: LIB, tests: [T_ROOT],
    from: "    if (error?.code === 'ENOENT') return false;\n    throw new StateRootError(\n      `Peer-run storage: cannot tell whether",
    to: "    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;\n    throw new StateRootError(\n      `Peer-run storage: cannot tell whether",
    why: "a file in a directory's place reads as no run directory",
    killed_by: /a file in a directory's place is no absence/,
  },
  {
    id: 'H8', file: LIB, tests: [T_ROOT],
    from: "      if (error?.code === 'ENOENT') continue;\n      throw failed(dir, error);",
    to: "      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;\n      throw failed(dir, error);",
    why: "the copy scan reads a file in a home's place as an empty home",
    killed_by: /a file in a directory's place is no absence/,
  },
  {
    id: 'H9', file: LIB, tests: [T_ROOT],
    from: "    entries = fs.readdirSync(dir, { withFileTypes: true });\n  } catch (error) {\n    if (error?.code === 'ENOENT') return [];",
    to: "    entries = fs.readdirSync(dir, { withFileTypes: true });\n  } catch (error) {\n    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];",
    why: "a file in a peer-runs directory's place lists no run directory",
    killed_by: /a file in a directory's place is no absence/,
  },
  {
    id: 'H10', file: LIB, tests: [T_ROOT],
    from: "    if (error?.code === 'ENOENT') return 'gone';",
    to: "    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'gone';",
    why: "a workflow name under a file in a directory's place reads as gone",
    killed_by: /a file in a directory's place is no absence/,
  },
  {
    id: 'H11', file: STATE, tests: [T_WRITERS],
    from: "      if (err.code === 'ENOENT') continue;\n      throw err;\n    }\n    for (const name of entries.sort()) {\n      if (!name.endsWith('.md')",
    to: "      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') continue;\n      throw err;\n    }\n    for (const name of entries.sort()) {\n      if (!name.endsWith('.md')",
    why: "the persona lister reads a file in a home's place as an empty home",
    killed_by: /a file in a workflow home's place is no empty home/,
  },
  {
    id: 'H12', file: ORCH_STATE, tests: [T_ORCH],
    from: "      if (err.code === 'ENOENT') continue;\n      throw err;\n    }\n    for (const name of entries.sort()) {\n      if (!keep(name)) continue;",
    to: "      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') continue;\n      throw err;\n    }\n    for (const name of entries.sort()) {\n      if (!keep(name)) continue;",
    why: "find-macro reads a file in a macro home's place as an empty home",
    killed_by: /a file in a macro home's place is no empty home/,
  },
  {
    id: 'H13', file: LIB, tests: [T_ROOT],
    from: "    if (error?.code === 'ENOENT') return true;",
    to: "    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return true;",
    why: "a file on the way to a fallback run path reads as nothing there",
    killed_by: /a file in a directory's place is no absence/,
  },
  // ---- I: SessionStart reports a refused lookup (U4i) -------------------------
  {
    id: 'I1', file: 'plugins/engineer/adapters/claude/hooks/session-start.mjs', tests: [T_WRITERS],
    from: "    process.stderr.write(`${persona.name}/session-start: no active workflow shown: ${String(err?.message ?? err).replace(CONTROL_CHARS, ' ')}\\n`);\n",
    to: "",
    why: "the persona Claude SessionStart hides a refused lookup as no active workflow",
    killed_by: /the SessionStart hooks report a lookup the scans refuse, rather than show no active workflow/,
  },
  {
    id: 'I2', file: 'plugins/engineer/adapters/codex/hooks/session-start.mjs', tests: [T_WRITERS],
    from: "    process.stderr.write(`${persona.name}/session-start: no active workflow shown: ${String(err?.message ?? err).replace(CONTROL_CHARS, ' ')}\\n`);\n",
    to: "",
    why: "the persona Codex SessionStart hides a refused lookup",
    killed_by: /the SessionStart hooks report a lookup the scans refuse, rather than show no active workflow/,
  },
  {
    id: 'I3', file: 'plugins/orchestrator/adapters/claude/hooks/session-start.mjs', tests: [T_ORCH],
    from: "    process.stderr.write(`orchestrator/session-start: no active workflow shown: ${String(err?.message ?? err).replace(CONTROL_CHARS, ' ')}\\n`);\n",
    to: "",
    why: "the orchestrator Claude SessionStart hides a refused lookup",
    killed_by: /the SessionStart hooks report a lookup the scans refuse, rather than show no active macro/,
  },
  {
    id: 'I4', file: 'plugins/orchestrator/adapters/codex/hooks/session-start.mjs', tests: [T_ORCH],
    from: "    process.stderr.write(`orchestrator/session-start: no active workflow shown: ${String(err?.message ?? err).replace(CONTROL_CHARS, ' ')}\\n`);\n",
    to: "",
    why: "the orchestrator Codex SessionStart hides a refused lookup",
    killed_by: /the SessionStart hooks report a lookup the scans refuse, rather than show no active macro/,
  },
  // ---- B: the eighth Plan-verify's findings (U4j) ---------------------------
  {
    id: 'B1', file: RUNNER, tests: [T_WRITERS],
    from: "  const claimed = claimRunDirectory(paths.dir);",
    to: "  const claimed = { claim: paths.dir };",
    why: "the persona prune judges and deletes the run directory in place, unclaimed: a ledger put there meanwhile is what it deletes",
    killed_by: /the prune deletes only the directory it claimed and judged/,
  },
  {
    id: 'B2', file: ORCH_RUNNER, tests: [T_ORCH],
    from: "  const claimed = claimRunDirectory(paths.dir);",
    to: "  const claimed = { claim: paths.dir };",
    why: "orchestrator's prune judges and deletes the run directory in place, unclaimed",
    killed_by: /the prune deletes only the directory it claimed and judged/,
  },
  {
    id: 'B3', file: ENG_LIB, tests: [T_WRITERS],
    from: "    fs.lstatSync(runDir);\n    return false;\n  } catch (error) {\n    if (error?.code !== 'ENOENT') return false;\n  }\n",
    to: "",
    why: "a claim is put back over an empty directory a runner made under the run id, replacing it",
    killed_by: /the claim is never put back over an empty directory/,
  },
  {
    id: 'B4', file: RUNNER, tests: [T_WRITERS],
    from: "    allowed = guard === null || guard();",
    to: "    allowed = true;",
    why: "the persona handle write is not asked again right before its rename",
    killed_by: /asks the guard again right before its rename/,
  },
  {
    id: 'B5', file: ORCH_RUNNER, tests: [T_ORCH],
    from: "    allowed = guard === null || guard();",
    to: "    allowed = true;",
    why: "orchestrator's handle write is not asked again right before its rename",
    killed_by: /asks the guard again right before its rename/,
  },
  {
    id: 'B6', file: RUNNER, tests: [T_WRITERS],
    from: "      shape = validateEnvelopeShape(envelope);\n    } catch {\n      envelope = null;\n    }\n    if (!allowed()) return handle;\n",
    to: "      shape = validateEnvelopeShape(envelope);\n      if (!allowed()) return handle;\n    } catch {\n      envelope = null;\n      if (!allowed()) return handle;\n    }\n",
    why: "a persona guard error is caught with the envelope's parse and recorded as envelope_parse_error",
    killed_by: /a guard that cannot judge the run directory propagates/,
  },
  {
    id: 'B7', file: ORCH_RUNNER, tests: [T_ORCH],
    from: "      shape = validateEnvelopeShape(envelope);\n    } catch {\n      envelope = null;\n    }\n    if (!allowed()) return handle;\n",
    to: "      shape = validateEnvelopeShape(envelope);\n      if (!allowed()) return handle;\n    } catch {\n      envelope = null;\n      if (!allowed()) return handle;\n    }\n",
    why: "orchestrator's guard error is recorded as envelope_parse_error",
    killed_by: /a guard that cannot judge the run directory propagates/,
  },
  {
    id: 'B8', file: RUNNER, tests: [T_WRITERS],
    from: "  if (!paths.missing) return;",
    to: "  return;",
    why: "the persona status reads through a link made at a missing run's path after the look",
    killed_by: /right after the look, is never read through/,
  },
  {
    id: 'B9', file: ORCH_RUNNER, tests: [T_ORCH],
    from: "  if (!paths.missing) return;",
    to: "  return;",
    why: "orchestrator's status and cancel read through a link made after the look",
    killed_by: /right after the look, is never read through/,
  },
  {
    id: 'B10', file: RUNNER, tests: [T_WRITERS],
    from: "  if (paths.missing || !(await present(paths.handle))) {",
    to: "  if (!(await present(paths.handle))) {",
    why: "settle reads through a link made at a missing run's path after the look",
    killed_by: /right after the look, is never read through: status and settle/,
  },
  {
    id: 'B11', file: RUNNER, tests: [T_WRITERS],
    from: "    if (error?.code !== 'ENOENT') throw error;\n    report.missing = true;",
    to: "    report.missing = true;",
    why: "the persona sweep reads a peer-runs directory it cannot list as missing",
    killed_by: /turns into a file after the sweep's selection is refused/,
  },
  {
    id: 'B12', file: ORCH_RUNNER, tests: [T_ORCH],
    from: "    if (error?.code !== 'ENOENT') throw error;\n    report.missing = true;",
    to: "    report.missing = true;",
    why: "orchestrator's sweep reads a peer-runs directory it cannot list as missing",
    killed_by: /turns into a file after the sweep's selection is refused/,
  },
  {
    id: 'B13', file: OBSERVE, tests: [T_OBSERVE],
    from: "        if (err.code === 'ENOENT') continue;\n        throw err;",
    to: "        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') continue;\n        throw err;",
    why: "the observer skips a file in an archive's place as no archive",
    killed_by: /a file in an engineer archive's place in a third worktree is an error/,
  },
  {
    id: 'B14', file: OBSERVE, tests: [T_OBSERVE],
    from: "      if (err.code === 'ENOENT') continue;\n      return { error:",
    to: "      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') continue;\n      return { error:",
    why: "the observer's claims scan reads a file in a workflow home's place as no claim",
    killed_by: /a file in an engineer workflow home's place in a third worktree is a claims error/,
  },
  {
    id: 'B17', file: 'plugins/engineer/adapters/claude/hooks/session-start.mjs', tests: [T_WRITERS],
    from: "    active = null;\n  }\n  if (active) {",
    to: "    return 0;\n  }\n  if (active) {",
    why: "the persona Claude SessionStart stops at the refusal, skipping the handoff backstop",
    killed_by: /go on to the handoff backstop/,
  },
  {
    id: 'B18', file: 'plugins/orchestrator/adapters/claude/hooks/session-start.mjs', tests: [T_ORCH],
    from: "    active = null;\n  }\n  if (active) {",
    to: "    return 0;\n  }\n  if (active) {",
    why: "the orchestrator Claude SessionStart stops at the refusal, skipping the handoff backstop",
    killed_by: /go on to the handoff backstop/,
  },
  // ---- U4k: the reconciling write bound to the ledger it read ----------------
  {
    id: 'B19', file: RUNNER, tests: [T_WRITERS],
    from: "  const sameRun = (h) => h.run_id === handle.run_id && h.started_at === handle.started_at;",
    to: "  const sameRun = () => true;",
    why: "the persona sweep gives a ledger made anew under the run id the old run's result",
    killed_by: /the reconciling write is bound to the ledger it read/,
  },
  {
    id: 'B20', file: ORCH_RUNNER, tests: [T_ORCH],
    from: "  const sameRun = (h) => h.run_id === handle.run_id && h.started_at === handle.started_at;",
    to: "  const sameRun = () => true;",
    why: "orchestrator's sweep gives a ledger made anew under the run id the old run's result",
    killed_by: /the reconciling write is bound to the ledger it read/,
  },
  // ---- A: the runbooks join the run locks (U7c) ------------------------------
  {
    id: 'A1', file: 'plugins/orchestrator/commands/next.md', tests: [T_ADMISSION_RUNBOOKS],
    from: "  --macro \"$MACRO_ID\" --checkout \"$REPO_ROOT\" --command next \\\n  --host \"$DETECTED_HOST\"",
    to: "  --macro \"$MACRO_ID\" --checkout \"$REPO_ROOT\" --command done \\\n  --host \"$DETECTED_HOST\"",
    why: "next joins the macro lock only, not its checkout's worktree lock",
    killed_by: /contention — another session's \/orchestrator:next is refused/,
  },
  {
    id: 'A2', file: 'plugins/orchestrator/commands/next.md', tests: [T_ADMISSION_RUNBOOKS],
    from: "}\ntrap 'release_admission' EXIT\nif [ -n \"$(git -C \"$REPO_ROOT\" status",
    to: "}\nif [ -n \"$(git -C \"$REPO_ROOT\" status",
    why: "Phase 3b leaves its admission behind when it stops before the switch",
    killed_by: /what a run's step could change before the join is read again/,
  },
  {
    id: 'A3', file: 'plugins/orchestrator/commands/next.md', tests: [T_ADMISSION_RUNBOOKS],
    from: "if [ -n \"$(git -C \"$REPO_ROOT\" status --porcelain --untracked-files=normal)\" ]; then\n  echo \"✗ The working tree changed after Phase 2's clean check",
    to: "if false; then\n  echo \"✗ The working tree changed after Phase 2's clean check",
    why: "the tree is not read again after the join",
    killed_by: /what a run's step could change before the join is read again/,
  },
  {
    id: 'A4', file: 'plugins/orchestrator/commands/next.md', tests: [T_ADMISSION_RUNBOOKS],
    from: "if [ \"$NOW_ENG_PATH\" != \"$EXISTING_ENG_PATH\" ]; then",
    to: "if false; then",
    why: "the subtask branch's engineer workflow is not compared again after the join",
    killed_by: /what a run's step could change before the join is read again/,
  },
  {
    id: 'A5', file: 'plugins/orchestrator/commands/next.md', tests: [T_ADMISSION_RUNBOOKS],
    from: "# Switched: from here the admission is held until Phase 5 releases it.\ntrap - EXIT\n",
    to: "",
    why: "Phase 3b releases the admission when it ends, so the dispatch runs unadmitted",
    killed_by: /joins both locks, switches, and holds the admission until Phase 5/,
  },
  {
    id: 'A6', file: 'plugins/orchestrator/commands/next.md', tests: [T_ADMISSION_RUNBOOKS],
    from: "node \"$ORCH_PLUGIN_ROOT/scripts/state.mjs\" admission check \\\n  --macro \"$MACRO_ID\" --checkout \"$REPO_ROOT\" --admission \"$ADMISSION\" || exit 1\n\nexport CLAUDE_PLUGIN_ROOT",
    to: "export CLAUDE_PLUGIN_ROOT",
    why: "the Phase 4 prelude dispatches with its admission gone",
    killed_by: /a released admission is seen by check/,
  },
  {
    id: 'A7', file: 'plugins/orchestrator/commands/next.md', tests: [T_ADMISSION_RUNBOOKS],
    from: "node \"$ORCH_PLUGIN_ROOT/scripts/state.mjs\" admission check \\\n  --macro \"$MACRO_ID\" --checkout \"$REPO_ROOT\" --admission \"$ADMISSION\" || exit 1\n# The child is bound only to the subtask",
    to: "# The child is bound only to the subtask",
    why: "Phase 5 writes the macro with its admission gone",
    killed_by: /a released admission is seen by check/,
  },
  {
    id: 'A8', file: 'plugins/orchestrator/commands/next.md', tests: [T_ADMISSION_RUNBOOKS],
    from: "}\ntrap 'release_admission' EXIT\nACTIVE_PATH=",
    to: "}\nACTIVE_PATH=",
    why: "Phase 5 never releases the admission",
    killed_by: /Phase 5's no-active-workflow exit releases the admission/,
  },
  {
    id: 'A9', file: 'plugins/orchestrator/commands/done.md', tests: [T_DONE_RUNBOOK],
    from: "# from here releases the admission. subtask-update checks ownership and\n# provenance itself, under the macro's file lock.\nADMISSION=\"$(node \"$CLAUDE_PLUGIN_ROOT/scripts/state.mjs\" admission join \\",
    to: "# from here releases the admission. subtask-update checks ownership and\n# provenance itself, under the macro's file lock.\nADMISSION=\"$(true \\",
    why: "done records a landing beside a session holding the macro lock",
    killed_by: /a session holding the macro lock refuses the write, naming it/,
  },
  {
    id: 'A10', file: 'plugins/orchestrator/commands/done.md', tests: [T_DONE_RUNBOOK],
    from: "}\ntrap 'release_admission' EXIT\n\nUPDATE_ARGS=",
    to: "}\n\nUPDATE_ARGS=",
    why: "done's landing path never releases its admission",
    killed_by: /every exit after the join releases/,
  },
  {
    id: 'A11', file: 'plugins/orchestrator/commands/done.md', tests: [T_DONE_RUNBOOK],
    from: "  # A run's step could have dispatched the subtask again before the join.\n  no_active_child || exit 1\n",
    to: "",
    why: "--no-commit does not read the active children again after the join",
    killed_by: /--no-commit reads the active children again after the join/,
  },
  {
    id: 'A12', file: 'plugins/orchestrator/commands/done.md', tests: [T_DONE_RUNBOOK],
    from: "  # nothing. Every exit from here releases the admission.\n  ADMISSION=\"$(node \"$CLAUDE_PLUGIN_ROOT/scripts/state.mjs\" admission join \\",
    to: "  # nothing. Every exit from here releases the admission.\n  ADMISSION=\"$(true \\",
    why: "--no-commit completes beside a session holding the macro lock",
    killed_by: /a session holding the macro lock refuses the write, naming it/,
  },
  {
    id: 'A13', file: 'plugins/orchestrator/commands/finalize.md', tests: [T_ADMISSION_RUNBOOKS],
    from: "ADMISSION=\"$(node \"$ORCH_PLUGIN_ROOT/scripts/state.mjs\" admission join \\\n  --macro \"$MACRO_ID\" --checkout \"$REPO_ROOT\" --command finalize",
    to: "ADMISSION=\"$(true \\\n  --macro \"$MACRO_ID\" --checkout \"$REPO_ROOT\" --command finalize",
    why: "finalize writes beside a session holding the macro lock",
    killed_by: /finalize\.md \(\w+\): a session holding the macro lock refuses before the first write/,
  },
  {
    id: 'A14', file: 'plugins/orchestrator/commands/finalize.md', tests: [T_ADMISSION_RUNBOOKS],
    from: "}\ntrap 'release_admission' EXIT\nnode \"$ORCH_PLUGIN_ROOT/scripts/state.mjs\" \\\n  bulk-subtask-status \\\n  --workflow-path \"$MACRO_PATH\" \\\n  --host \"$DETECTED_HOST\" \\\n  --from-statuses pending,blocked,in_progress \\\n  --to-status deferred",
    to: "}\nnode \"$ORCH_PLUGIN_ROOT/scripts/state.mjs\" \\\n  bulk-subtask-status \\\n  --workflow-path \"$MACRO_PATH\" \\\n  --host \"$DETECTED_HOST\" \\\n  --from-statuses pending,blocked,in_progress \\\n  --to-status deferred",
    why: "finalize never releases its admission",
    killed_by: /finalize\.md: a step that fails after the first write releases the admission|finalize\.md \(\w+\): a session holding/,
  },
  {
    id: 'A15', file: 'plugins/orchestrator/commands/abort.md', tests: [T_ADMISSION_RUNBOOKS],
    from: "ADMISSION=\"$(node \"$ORCH_PLUGIN_ROOT/scripts/state.mjs\" admission join \\\n  --macro \"$MACRO_ID\" --checkout \"$REPO_ROOT\" --command abort",
    to: "ADMISSION=\"$(true \\\n  --macro \"$MACRO_ID\" --checkout \"$REPO_ROOT\" --command abort",
    why: "abort writes beside a session holding the macro lock",
    killed_by: /abort\.md \(\w+\): a session holding the macro lock refuses before the first write/,
  },
  {
    id: 'A16', file: 'plugins/orchestrator/commands/resume.md', tests: [T_ADMISSION_RUNBOOKS],
    from: "ADMISSION=\"$(node \"$CLAUDE_PLUGIN_ROOT/scripts/state.mjs\" admission join \\\n  --macro \"$MACRO_ID\" --checkout \"$REPO_ROOT\" --command resume",
    to: "ADMISSION=\"$(true \\\n  --macro \"$MACRO_ID\" --checkout \"$REPO_ROOT\" --command resume",
    why: "resume archives beside a session holding the macro lock",
    killed_by: /resume\.md \(\w+\): the archive refuses while a session holds the macro lock/,
  },
  {
    id: 'A17', file: 'plugins/orchestrator/core/skills/next/SKILL.md', tests: [T_ADMISSION_RUNBOOKS],
    from: "node \"$ORCH_PLUGIN_ROOT/scripts/state.mjs\" admission check \\\n  --macro \"$MACRO_ID\" --checkout \"$REPO_ROOT\" --admission \"$ADMISSION\" || exit 1\nexport CLAUDE_PLUGIN_ROOT",
    to: "export CLAUDE_PLUGIN_ROOT",
    why: "the Codex prelude dispatches with its admission gone",
    killed_by: /a released admission is seen by check/,
  },
  {
    id: 'A18', file: 'plugins/orchestrator/adapters/claude/autopilot/cli.mjs', tests: [T_CLI],
    from: "      out(`no autopilot runs in ${repoRoot}`);\n      printAdmissions(admissions, out);\n",
    to: "      out(`no autopilot runs in ${repoRoot}`);\n",
    why: "status hides the admissions when the checkout has no run",
    killed_by: /status lists the session admissions/,
  },
  {
    id: 'A19', file: 'plugins/orchestrator/adapters/claude/autopilot/cli.mjs', tests: [T_CLI],
    from: "    const id = l.holder?.admission_id ?? l.entry;",
    to: "    const id = l.entry;",
    why: "status shows one admission once per lock it joined",
    killed_by: /status lists the session admissions/,
  },
  {
    id: 'A20', file: 'plugins/orchestrator/adapters/claude/autopilot/roots.mjs', tests: [T_ADMISSION],
    from: "    ['scripts/state.mjs', \"case 'admission'\", 'the admission entries the runbooks join (ADR-0067 Decision 4, item 5, SR)'],\n",
    to: "",
    why: "a run starts on a pinned orchestrator whose runbooks would fail at the join",
    killed_by: /the driver refuses a pinned orchestrator whose state.mjs has no admission subcommand/,
  },
  // ---- A21-A27: the U7c review's findings (U7d) ---------------------------------
  {
    id: 'A21', file: 'plugins/orchestrator/commands/next.md', tests: [T_ADMISSION_RUNBOOKS],
    from: 'if [ -n "$SUBTASK_CHANGES" ]; then',
    to: 'if false; then',
    why: "next switches and dispatches a subtask a run's step completed during the join",
    killed_by: COMPLETED_RA,
  },
  {
    id: 'A22', file: 'plugins/orchestrator/core/skills/next/SKILL.md', tests: [T_ADMISSION_RUNBOOKS],
    from: '[ -z "$SUBTASK_CHANGES" ] \\\n  ||',
    to: 'true \\\n  ||',
    why: "the Codex next goes on to the switch for a subtask a run's step completed during the join",
    killed_by: COMPLETED_RA,
  },
  {
    id: 'A23', file: 'plugins/orchestrator/core/skills/done/SKILL.md', tests: [T_DONE_RUNBOOK],
    from: '[ -z "$ACTIVE_CHILD" ] || {',
    to: 'true || {',
    why: "the Codex done --no-commit completes a subtask whose engineer child is still active",
    killed_by: /Codex --no-commit: the Phase 4 block reads the active children after its join/,
  },
  ...['finalize', 'abort'].flatMap((name, i) => [
    {
      id: `A${24 + 2 * i}`, file: `plugins/orchestrator/core/skills/${name}/SKILL.md`, tests: [T_ADMISSION_RUNBOOKS],
      from: "trap 'release_admission' EXIT\nnode \"<orchestrator-plugin-root>/scripts/state.mjs\" admission check \\\n  --macro \"$MACRO_ID\" --checkout \"$REPO_ROOT\" --admission \"$ADMISSION\" || exit 1\n# ARCHIVE TIMING",
      to: "trap 'release_admission' EXIT\n# ARCHIVE TIMING",
      why: `the Codex ${name} sets the macro terminal after its admission was released`,
      killed_by: new RegExp(`${name} \\(Codex mirror\\): an admission released after Phase 1 stops Phases 2 and 3`),
    },
    {
      id: `A${25 + 2 * i}`, file: `plugins/orchestrator/core/skills/${name}/SKILL.md`, tests: [T_ADMISSION_RUNBOOKS],
      from: '--admission "$ADMISSION" || {\n  node "<orchestrator-plugin-root>/scripts/state.mjs" admission release \\\n    --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION"\n  exit 1\n}\n```\n\n---\n\n## Phase 3',
      to: '--admission "$ADMISSION" || true\n```\n\n---\n\n## Phase 3',
      why: `the Codex ${name} archives children after its admission was released`,
      killed_by: new RegExp(`${name} \\(Codex mirror\\): an admission released after Phase 1 stops Phases 2 and 3`),
    },
    {
      id: `A${28 + i}`, file: `plugins/orchestrator/core/skills/${name}/SKILL.md`, tests: [T_ADMISSION_RUNBOOKS],
      from: '--admission "$ADMISSION" || {\n  node "<orchestrator-plugin-root>/scripts/state.mjs" admission release \\\n    --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION"\n  exit 1\n}\n```\n\n---\n\n## Phase 3',
      to: '--admission "$ADMISSION" || exit 1\n```\n\n---\n\n## Phase 3',
      why: `the Codex ${name} leaves its admission behind when the Phase 2 check fails on a permission error`,
      killed_by: new RegExp(`${name} \\(Codex mirror\\): a Phase 2 check that fails on a permission error releases the admission`),
    },
  ]),
  {
    id: 'A30', file: 'plugins/orchestrator/core/skills/done/SKILL.md', tests: [T_DONE_RUNBOOK],
    from: 'if [ "${NO_COMMIT:-}" = "1" ] || [ -z "${COMMIT_SHA:-}" ]; then',
    to: 'if [ "${NO_COMMIT:-}" = "1" ]; then',
    why: "the Codex done skips the active-child check when the agent leaves NO_COMMIT unset",
    killed_by: /Codex --no-commit: the Phase 4 block reads the active children after its join/,
  },
  {
    id: 'A31', file: 'plugins/orchestrator/core/skills/next/SKILL.md', tests: [T_ADMISSION_RUNBOOKS],
    from: '# Switched: from here the admission is held until Phase 4 releases it.\ntrap - EXIT\n',
    to: '',
    why: "the Codex next releases its admission at the end of the switching block, before Phase 3 dispatches",
    killed_by: COMPLETED_RA,
  },
  // ---- M: the U4j review's remaining findings (U4l) and the U4k review's item 7 (U4m)
  {
    id: 'M1', file: ENG_LIB, tests: [T_WRITERS],
    from: '    for (const runDir of [path.join(dir, runId), path.join(dir, claimName(runId))]) {',
    to: '    for (const runDir of [path.join(dir, runId)]) {',
    why: "the ownership checks no longer count a prune's claim as a ledger of its run id",
    killed_by: /a claim made after the selection leaves its run id alone from then on/,
  },
  {
    id: 'M2', file: ENG_LIB, tests: [T_WRITERS],
    from: ".digest('hex').slice(0, 32)}`;",
    to: ".digest('hex').slice(0, 32)}${'~'.repeat(String(runId).length)}`;",
    why: 'a claim name grows with its run id, past the name limit for a long valid one',
    killed_by: /a run id of any valid length is pruned: the claim name is bounded/,
  },
  {
    id: 'M3', file: RUNNER, tests: [T_WRITERS],
    from: '    graceMs: options.staleGraceMs ?? DEFAULT_STALE_GRACE_MS,',
    to: '    graceMs: Infinity,',
    why: 'a claim an interrupted prune left is never put back',
    killed_by: /the sweep puts back a claim an interrupted prune left/,
  },
  {
    id: 'M4', file: ENG_LIB, tests: [T_WRITERS],
    from: '      if (now.getTime() - st.ctimeMs < graceMs) {',
    to: '      if (false) {',
    why: 'the sweep puts back a claim a prune may be judging',
    killed_by: /the sweep puts back a claim an interrupted prune left once no prune can hold it, and leaves a younger one/,
  },
  {
    id: 'M5', file: ENG_LIB, tests: [T_WRITERS],
    from: '      if (ledgersHolding(dirs, runId).some((h) => !samePhysicalFile(h, claim)) || !releaseClaim(claim, runDir)) {',
    to: '      if (!releaseClaim(claim, runDir)) {',
    why: 'a claim is put back while another ledger holds its run id',
    killed_by: /a claim whose run id another ledger holds stays/,
  },
  {
    id: 'M6', file: RUNNER, tests: [T_WRITERS],
    from: '  if (found[0]?.claim) {',
    to: '  if (false) {',
    why: 'status, cancel and settle read a claimed ledger as the run',
    killed_by: /a claim an interrupted prune left is its run id's ledger/,
  },
  {
    id: 'M7', file: RUNNER, tests: [T_WRITERS],
    from: '      if (runDirectoryAt(claim) && !found.some((f) => sameDirectory(f.dir, claim))) {',
    to: '      if (false) {',
    why: 'a claimed run reads as no run, and its run id is free to take',
    killed_by: /a claim an interrupted prune left is its run id's ledger/,
  },
  {
    id: 'M9', file: RUNNER, tests: [T_WRITERS],
    from: '    if (isClaimName(runId)) {',
    to: '    if (false) {',
    why: 'an attempt whose ledger a prune claimed drops out of the unsettled-attempt scan',
    killed_by: /the unsettled-attempt scan counts an attempt whose ledger a prune claimed/,
  },
  ...[[RUNNER, T_WRITERS, 'M10', 'M11'], [ORCH_RUNNER, T_ORCH, 'M12', 'M13']].flatMap(([file, test, judged, deleted]) => [
    {
      id: judged, file, tests: [test],
      from: '    const back = releaseClaim(claim, paths.dir);\n    throw new StateRootError(',
      to: '    releaseClaim(claim, paths.dir);\n    throw error;\n    throw new StateRootError(',
      why: 'a failed judgment does not say where the claimed directory is left',
      killed_by: /a judgment that fails names where the claimed directory is left/,
    },
    {
      id: deleted, file, tests: [test],
      from: '      await rm(claim, { recursive: true, force: true });\n    } catch (error) {\n      throw new StateRootError(',
      to: '      await rm(claim, { recursive: true, force: true });\n    } catch (error) {\n      throw error;\n      throw new StateRootError(',
      why: 'a failed deletion does not name the claim it left partly deleted',
      killed_by: /a deletion that fails names the claimed directory it left partly deleted/,
    },
  ]),
  {
    id: 'M14', file: ORCH_RUNNER, tests: [T_ORCH],
    from: '  if (found[0]?.claim) {',
    to: '  if (false) {',
    why: "orchestrator's status and cancel read a claimed ledger as the run",
    killed_by: /a claim an interrupted prune left is its run id's ledger/,
  },
  {
    id: 'M15', file: ORCH_RUNNER, tests: [T_ORCH],
    from: '    graceMs: options.staleGraceMs ?? DEFAULT_STALE_GRACE_MS,',
    to: '    graceMs: Infinity,',
    why: "orchestrator's sweep never puts back a claim an interrupted prune left",
    killed_by: /the sweep puts back a claim an interrupted prune left/,
  },
  {
    id: 'M16', file: ORCH_LIB, tests: [T_ORCH],
    from: '      if (ledgersHolding(dirs, runId).some((h) => !samePhysicalFile(h, claim)) || !releaseClaim(claim, runDir)) {',
    to: '      if (!releaseClaim(claim, runDir)) {',
    why: "orchestrator's sweep puts a claim back while another ledger holds its run id",
    killed_by: /a claim whose run id another ledger holds stays/,
  },
  {
    id: 'M17', file: ORCH_RUNNER, tests: [T_ORCH],
    from: '    const next = await updateHandle(paths.handle, (h) => {\n      if (isTerminalStatus(h.status)) return h;\n',
    to: '    const next = await updateHandle(paths.handle, (h) => {\n',
    why: "orchestrator's reconciling write replaces a cancel written after the caller's read with the envelope's result",
    killed_by: /keeps a terminal status a cancel wrote after the caller's read \(envelope branch\)/,
  },
  {
    id: 'M18', file: ORCH_RUNNER, tests: [T_ORCH],
    from: "        if (!['spawning', 'running', 'cancel_requested'].includes(h.status)) return h;\n        h.status = 'orphaned';",
    to: "        h.status = 'orphaned';",
    why: "orchestrator's orphan write replaces a cancel written after the caller's read",
    killed_by: /keeps a terminal status a cancel wrote after the caller's read \(orphan branch\)/,
  },

  // ---- N: the operator cutover's plan, move and verify (U8a)
  {
    id: 'N1', file: CUTOVER, tests: [T_CUTOVER],
    from: "  const children = records.filter((r) => r.plugin === 'engineer' && !r.main && parents.has(r.parent_workflow));",
    to: "  const children = records.filter((r) => r.plugin === 'engineer' && !r.main && r.dir === 'workflows' && parents.has(r.parent_workflow));",
    why: "an archived child of a moved macro stays in the linked worktree's own home",
    killed_by: /plan lists a linked worktree's macro, its children active and archived, and their ledgers/,
  },
  {
    id: 'N2', file: CUTOVER, tests: [T_CUTOVER],
    from: "    ...records.filter((r) => r.plugin === 'orchestrator' && r.main).map((r) => r.workflow_id),\n",
    to: '',
    why: "a linked worktree's child of a macro already under the default state root is left behind",
    killed_by: /a linked worktree's child of a macro already in the main checkout moves; the macro stays/,
  },
  {
    id: 'N3', file: CUTOVER, tests: [T_CUTOVER],
    from: "    const destination = homeStorage(root, record.plugin, 'canonical');\n    for (const runId of record.run_ids) {",
    to: "    const destination = homeStorage(root, record.plugin, 'canonical');\n    for (const runId of []) {",
    why: 'the peer-run ledgers a moved workflow names stay behind',
    killed_by: /plan lists a linked worktree's macro, its children active and archived, and their ledgers/,
  },
  {
    id: 'N4', file: CUTOVER, tests: [T_CUTOVER],
    from: '    if (record.pending_entries > 0) {',
    to: '    if (false) {',
    why: 'a workflow with a pending ensemble is moved while its run may still write back',
    killed_by: /refuses a branch key held by a second active workflow, a pending ensemble/,
  },
  {
    id: 'N5', file: CUTOVER, tests: [T_CUTOVER],
    from: '    if (others_.length > 0) {',
    to: '    if (false) {',
    why: 'a workflow is moved onto a branch key another active workflow holds',
    killed_by: /refuses a branch key held by a second active workflow/,
  },
  {
    id: 'N6', file: CUTOVER, tests: [T_CUTOVER],
    from: "    if (present(pair.destination)) {\n      refusals.push({ code: 'name-exists', detail: `${pair.destination} exists: ${pair.source} cannot move there`",
    to: "    if (false) {\n      refusals.push({ code: 'name-exists', detail: `${pair.destination} exists: ${pair.source} cannot move there`",
    why: 'the plan does not see a destination that exists',
    killed_by: /an existing destination/,
  },
  {
    id: 'N7', file: CUTOVER, tests: [T_CUTOVER],
    from: "    if (record.home === 'legacy') {",
    to: '    if (false) {',
    why: 'a record in a legacy home is moved into a canonical one without the migration',
    killed_by: /and a legacy home/,
  },
  {
    id: 'N8', file: CUTOVER, tests: [T_CUTOVER],
    from: '    if (legacyHasState(root, plugin)) {',
    to: '    if (false) {',
    why: "the move fills the canonical home of a root whose legacy home holds state, which blocks every later write",
    killed_by: /and a legacy home/,
  },
  {
    id: 'N9', file: CUTOVER, tests: [T_CUTOVER],
    from: "  if (!attestation.ok) {\n    refusals.push({\n      code: 'attestation-failed',\n      detail: `${main} does not pass the main-checkout checks: ` +\n        attestation.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`).join('; ') +\n",
    to: "  if (false) {\n    refusals.push({\n      code: 'attestation-failed',\n      detail: `${main} does not pass the main-checkout checks: ` +\n        attestation.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`).join('; ') +\n",
    why: 'the plan runs outside the main checkout',
    killed_by: /refuses outside the main checkout/,
  },
  {
    id: 'N10', file: CUTOVER, tests: [T_CUTOVER],
    from: "  if (!attestation.ok) {\n    return { ok: false, refusals: [{ code: 'attestation-failed'",
    to: "  if (false) {\n    return { ok: false, refusals: [{ code: 'attestation-failed'",
    why: 'an open manifest is continued from a checkout that is not the main one',
    killed_by: /a rerun continues an interrupted move/,
  },
  {
    id: 'N11', file: CUTOVER, tests: [T_CUTOVER],
    from: '    else if (j.source && j.destination) {',
    to: '    else if (false) {',
    why: 'a pair found at both ends (a copy) is not refused before the move',
    killed_by: /a rerun refuses a pair found at both ends or at neither, and moves nothing/,
  },
  {
    id: 'N12', file: CUTOVER, tests: [T_CUTOVER],
    from: '    } else if (!j.source && !j.destination) {',
    to: '    } else if (false) {',
    why: 'a pair found at neither end (a loss) is passed over',
    killed_by: /a rerun refuses a pair found at both ends or at neither, and moves nothing/,
  },
  {
    id: 'N13', file: CUTOVER, tests: [T_CUTOVER],
    from: '  if (refusals.length > 0) return { ok: false, manifest: file, refusals };\n  const movedNow = await moveJudged(file, doc, judged, root, { withFileLock, withDirectoryLock });\n  const left = doc.pairs.filter((p) => present(p.source));\n  if (left.length > 0) {\n    return {\n',
    to: '  const movedNow = await moveJudged(file, doc, judged, root, { withFileLock, withDirectoryLock });\n  const left = doc.pairs.filter((p) => present(p.source));\n  if (left.length > 0) {\n    return {\n',
    why: 'the rerun moves the pairs it can before it meets the one it must refuse',
    killed_by: /a rerun refuses a pair found at both ends or at neither, and moves nothing/,
  },
  {
    id: 'N14', file: CUTOVER, tests: [T_CUTOVER],
    from: '    } else if (recorded.has(pair.source)) {\n      continue;\n    }\n',
    to: '    }\n',
    why: 'a rerun records again a pair the manifest already holds',
    killed_by: /a rerun continues an interrupted move/,
  },
  {
    id: 'N15', file: CUTOVER, tests: [T_CUTOVER],
    from: "  add('sources-absent', back.length === 0, ",
    to: "  add('sources-absent', true, ",
    why: 'verify misses a source path that came back',
    killed_by: /verify fails when a source path comes back/,
  },
  {
    id: 'N16', file: CUTOVER, tests: [T_CUTOVER],
    from: "    .filter((r) => r.dir === 'workflows' && macroIds.has(r.parent_workflow));",
    to: '    .filter(() => false);',
    why: "verify misses a linked worktree's active child of a macro under the default state root",
    killed_by: /or a linked worktree holds an active child of a moved macro/,
  },
  {
    id: 'N17', file: CUTOVER, tests: [T_CUTOVER],
    from: '      const ok = found !== null && samePhysicalFile(found, pair.destination);',
    to: '      const ok = true;',
    why: 'verify does not resolve the moved macro from each checkout',
    killed_by: /verify fails when a source path comes back/,
  },
  {
    id: 'N18', file: CUTOVER, tests: [T_CUTOVER],
    from: "  add('shared-creation-on', switchState === 'on', ",
    to: "  add('shared-creation-on', true, ",
    why: 'verify passes with the shared-creation switch off',
    killed_by: /move renames every pair into the default state root; enable and verify pass/,
  },
  {
    id: 'N19', file: CUTOVER, tests: [T_CUTOVER],
    from: '    await withFileLock(pair.source, async () => renameInto(pair.source, pair.destination));',
    to: '    renameInto(pair.source, pair.destination);',
    why: 'a workflow file is moved without its write lock',
    killed_by: /moves a workflow under its write lock/,
  },
  {
    id: 'N20', file: CUTOVER, tests: [T_CUTOVER],
    from: "  await withDirectoryLock(root, () => withDirectoryLock(checkout, async () => {\n    renameInto(pair.source, pair.destination);\n  }, { storage: second }), { storage: first });",
    to: '  renameInto(pair.source, pair.destination);',
    why: "a ledger or an archived file is moved without the creation locks archive takes",
    killed_by: /a ledger or an archived file under the destination home's creation lock/,
  },
  {
    id: 'N21', file: CUTOVER, tests: [T_CUTOVER],
    from: '    if (sourceOf.has(record.workflow_id)) {',
    to: '    if (false) {',
    why: 'the rollback leaves a record the cutover moved under the default state root',
    killed_by: /sends each moved record back to its checkout/,
  },
  {
    id: 'N22', file: CUTOVER, tests: [T_CUTOVER],
    from: "    } else if (!inventory.has(record.workflow_id) && typeof record.repo_root === 'string' &&",
    to: "    } else if (false && typeof record.repo_root === 'string' &&",
    why: 'a record created after the switch in a linked worktree stays under the default state root',
    killed_by: /and one created after the switch to its own/,
  },
  {
    id: 'N23', file: CUTOVER, tests: [T_CUTOVER],
    from: "    } else if (!inventory.has(record.workflow_id) && typeof record.repo_root === 'string' &&",
    to: "    } else if (typeof record.repo_root === 'string' &&",
    why: "the rollback reads repo_root for a record the inventory holds, and sends a record that lived in the main checkout away",
    killed_by: /the main checkout's records stay/,
  },
  {
    id: 'N24', file: CUTOVER, tests: [T_CUTOVER],
    from: '    if (!live) {',
    to: '    if (false) {',
    why: "the rollback does not refuse a record whose checkout is gone",
    killed_by: /is refused, leaving the switch on, when a record's checkout is gone/,
  },
  {
    id: 'N25', file: CUTOVER, tests: [T_CUTOVER],
    from: '  if (switchInfo.record?.lanes_first_run_at) {',
    to: '  if (false) {',
    why: 'the rollback plans past the first lane',
    killed_by: /or lanes have run/,
  },
  {
    id: 'N26', file: CUTOVER, tests: [T_CUTOVER],
    from: '      if (macroAt === undefined || childAt === undefined || sameDirectory(macroAt, childAt)) continue;',
    to: '      continue;',
    why: 'the rollback splits an active macro from a child it still needs',
    killed_by: /refuses while an active macro and a child it still needs would end in two checkouts/,
  },
  {
    id: 'N27', file: CUTOVER, tests: [T_CUTOVER],
    from: '  const switched = disableSharedCreation({ checkout: main, now });',
    to: '  const switched = { switch: readSharedCreation(main).record };',
    why: 'the rollback moves records back with shared creation still on',
    killed_by: /the switch goes off/,
  },
  {
    id: 'N28', file: CUTOVER, tests: [T_CUTOVER],
    from: '    if (!m.rolled_back_at) writeJsonAtomic(cutoverFile, { ...m, rolled_back_at: at, rolled_back_by: file });\n',
    to: '',
    why: 'a cutover the rollback reversed stays open',
    killed_by: /closes a cutover it reversed before the switch/,
  },
  {
    id: 'N29', file: ORCH_LIB, tests: [T_CUTOVER],
    from: "doc.kind === 'cutover' && !doc.inventory && !doc.rolled_back_at) return { file, doc };",
    to: "doc.kind === 'cutover' && !doc.inventory) return { file, doc };",
    why: 'enable appends its inventory to a cutover a rollback reversed',
    killed_by: /enable then starts a manifest of its own/,
  },
  {
    id: 'N30', file: CUTOVER, tests: [T_CUTOVER],
    from: "      if (child.dir !== 'workflows' && !awaited.has(child.workflow_id)) continue;",
    to: "      if (child.dir !== 'workflows') continue;",
    why: 'the rollback splits a macro from an archived child a subtask not yet settled still names',
    killed_by: /counts an archived child as still needed only while a subtask not yet settled names it/,
  },
  {
    id: 'N31', file: CUTOVER, tests: [T_CUTOVER],
    from: "      if (child.dir !== 'workflows' && !awaited.has(child.workflow_id)) continue;\n",
    to: '',
    why: 'the rollback refuses for an archived child no subtask awaits',
    killed_by: /counts an archived child as still needed only while a subtask not yet settled names it/,
  },
  {
    id: 'N32', file: CUTOVER, tests: [T_CUTOVER],
    from: '      subtasks = frontmatter.plan?.subtasks ?? [];',
    to: '      subtasks = frontmatter.subtasks ?? [];',
    why: "verify reads the subtasks where a macro does not keep them, and its find-macro check never runs",
    killed_by: /move renames every pair into the default state root; enable and verify pass/,
  },
  {
    id: 'N33', file: CUTOVER, tests: [T_CUTOVER],
    from: '(await readWorkflow(macro.file)).frontmatter.plan?.subtasks ?? [];',
    to: '(await readWorkflow(macro.file)).frontmatter.subtasks ?? [];',
    why: 'the rollback reads the subtasks where a macro does not keep them, and awaits no archived child',
    killed_by: /counts an archived child as still needed only while a subtask not yet settled names it/,
  },
  // The U8a Plan-verify's findings.
  {
    id: 'N34', file: CUTOVER, tests: [T_CUTOVER],
    from: '      inventory: null,\n    };\n    writeJsonAtomic(file, doc);\n    open = { file, doc };',
    to: '      inventory: null,\n    };\n    open = { file, doc };',
    why: 'the cutover manifest is first written after the first rename, so a kill before it leaves a move no manifest names',
    killed_by: /moves a workflow under its write lock, and a ledger or an archived file under the destination home's creation lock/,
  },
  {
    id: 'N35', file: CUTOVER, tests: [T_CUTOVER],
    from: '  await withDirectoryLock(root, () => withDirectoryLock(checkout, async () => {\n    renameInto(pair.source, pair.destination);\n  }, { storage: second }), { storage: first });',
    to: '  await withDirectoryLock(root, async () => {\n    renameInto(pair.source, pair.destination);\n  }, { storage: first });',
    why: "a ledger or an archived file moves without its checkout home's creation lock",
    killed_by: /moves a workflow under its write lock, and a ledger or an archived file under the destination home's creation lock/,
  },
  {
    id: 'N36', file: CUTOVER, tests: [T_CUTOVER],
    from: "  if (pair.kind === 'workflow') {\n    await withFileLock(",
    to: "  if (pair.kind !== 'peer-run') {\n    await withFileLock(",
    why: 'an archived file moves under a file lock of its own instead of the creation locks archive takes',
    killed_by: /moves a workflow under its write lock, and a ledger or an archived file under the destination home's creation lock/,
  },
  {
    id: 'N37', file: CUTOVER, tests: [T_CUTOVER],
    from: "    ...records.filter((r) => r.plugin === 'orchestrator' && r.main).map((r) => r.workflow_id),",
    to: "    ...records.filter((r) => r.plugin === 'orchestrator' && r.main && r.dir === 'workflows').map((r) => r.workflow_id),",
    why: "a linked worktree's child of a macro archived under the default state root is left behind",
    killed_by: /a linked worktree's child of a macro already in the main checkout moves; the macro stays/,
  },
  {
    id: 'N38', file: ORCH_STATE, tests: [T_CUTOVER],
    from: "        if (flags['repo-root'] === '') throw new Error('--repo-root needs a value: the main checkout');\n",
    to: '',
    why: 'a --repo-root left without its value moves the records of the working directory',
    killed_by: /refuses a --repo-root left without its value, rather than act in the working directory/,
  },
  {
    id: 'N39', file: CUTOVER, tests: [T_CUTOVER],
    from: "  const inForce = manifestsUnder(root).filter((m) => m.doc.kind === 'cutover' && !m.doc.rolled_back_at);\n",
    to: "  const inForce = manifestsUnder(root).filter((m) => m.doc.kind === 'cutover' && !m.doc.rolled_back_at).slice(-1);\n",
    why: "verify reads the newest manifest only, an inventory-only one after an interrupted enable, and checks no move",
    killed_by: /still verifies a move whose enable was interrupted and rerun/,
  },
  {
    id: 'N40', file: CUTOVER, tests: [T_CUTOVER],
    from: '  const root = defaultStateRoot(path.resolve(checkout));\n  const main = root;\n',
    to: '  const main = path.resolve(checkout);\n  const root = defaultStateRoot(main);\n',
    why: "verify run from a linked worktree judges from it, and misses its own home's stray children",
    killed_by: /verifies from the home worktree too/,
  },
  {
    id: 'N41', file: CUTOVER, tests: [T_CUTOVER],
    from: '      for (const at of [main, ...others]) {\n        let found = null;\n        let error = null;\n        try {\n          found = await findMacroBySubtaskBranch(at, branch);',
    to: '      for (const at of [main]) {\n        let found = null;\n        let error = null;\n        try {\n          found = await findMacroBySubtaskBranch(at, branch);',
    why: 'verify looks a subtask branch up from the main checkout only',
    killed_by: /enable and verify pass, and every checkout resolves the macro there/,
  },
  {
    id: 'N42', file: CUTOVER, tests: [T_CUTOVER],
    from: '  if (!ALL_PLUGINS.includes(pair.plugin)) return `plugin ${JSON.stringify(pair.plugin)}`;',
    to: '  if (!PLUGINS.includes(pair.plugin)) return `plugin ${JSON.stringify(pair.plugin)}`;',
    why: "a rollback pair of a founder or designer record is judged a damaged manifest, after the switch went off",
    killed_by: /sends each moved record back to its checkout and one created after the switch to its own/,
  },
  {
    id: 'N43', file: CUTOVER, tests: [T_CUTOVER],
    from: '    const judged = judgePairs(m.file, pairsOf);\n    refusals.push(...judged.refusals);\n',
    to: "    refusals.push({ code: 'cutover-unfinished', detail: m.file });\n    const judged = { judged: [] };\n",
    why: 'the rollback refuses a cutover interrupted before step 5 instead of reversing it from its manifest',
    killed_by: /reverses a cutover interrupted before step 5 from its manifest/,
  },
  {
    id: 'N44', file: CUTOVER, tests: [T_CUTOVER],
    from: '    if (swappedFrom.has(record.file)) {',
    to: '    if (false) {',
    why: 'a record a swapped pair already sends back is planned a second time',
    killed_by: /reverses a cutover interrupted before step 5 from its manifest/,
  },
  {
    id: 'N45', file: CUTOVER, tests: [T_CUTOVER],
    from: '        homeHasState(live, record.plugin, otherHome)) {',
    to: '        false) {',
    why: "the rollback sends a record into a checkout whose other home holds state, where every write then fails",
    killed_by: /refuses, leaving the switch on, a destination whose other home holds state/,
  },
  {
    id: 'N46', file: CUTOVER, tests: [T_CUTOVER],
    from: '        if (present(path.join(from.peerRuns, claimName(runId)))) {',
    to: '        if (false) {',
    why: 'the rollback leaves a ledger an interrupted prune claimed under the default state root',
    killed_by: /refuses, leaving the switch on, a destination whose other home holds state and a ledger an interrupted prune claimed/,
  },
  {
    id: 'N47', file: CUTOVER, tests: [T_CUTOVER],
    from: '  let open = newestOpenRollbackManifest(root);',
    to: '  let open = null;',
    why: 'a rerun plans a second rollback and leaves the interrupted one open',
    killed_by: /a rerun continues an interrupted rollback under its own manifest/,
  },

  // ---- RA: the final critique's findings (refine) ----
  // ---- M6: the re-read after the join compares every dispatch field ----------
  {
    id: 'RA1', tests: [T_RA],
    prepare: moveBefore_RA(NEXT_RA,
      '# The subtask as Phase 1 selected it, every field',
      'Rerun /orchestrator:next." >&2\n  exit 1\nfi\n',
      'ADMISSION="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" admission join'),
    why: "next.md reads the subtask again before the join, so a plan revision or a run's step landing during the join is missed",
    killed_by: [REVISION_RA, COMPLETED_RA],
  },
  {
    id: 'RA2', file: NEXT_RA, tests: [T_RA],
    from: '  branch "$SUBTASK_BRANCH" verb "$SUBTASK_VERB"',
    to: '  verb "$SUBTASK_VERB"',
    why: "next.md does not compare the subtask's branch after the join",
    killed_by: REVISION_RA,
  },
  {
    id: 'RA3', tests: [T_RA],
    prepare: moveBefore_RA(SKILL_RA,
      'SUBTASK_CHANGES="$(node',
      'nothing was switched." >&2; exit 1; }\n',
      'ADMISSION="$(node "<orchestrator-plugin-root>/scripts/state.mjs" admission join'),
    why: 'the Codex next reads the subtask again in its join block, before the join',
    killed_by: [REVISION_RA, COMPLETED_RA],
  },
  {
    id: 'RA4', file: SKILL_RA, tests: [T_RA],
    from: '  branch "$SUBTASK_BRANCH" verb "$SUBTASK_VERB"',
    to: '  verb "$SUBTASK_VERB"',
    why: "the Codex next does not compare the subtask's branch after the join",
    killed_by: REVISION_RA,
  },
  {
    id: 'RA5', file: NEXT_RA, tests: [T_RA],
    from: '"$SUBTASK_PROFILE" topic "$SUBTASK_TOPIC")" || exit 1\nif',
    to: '"$SUBTASK_PROFILE")" || exit 1\nif',
    why: "next.md does not compare the subtask's topic after the join",
    killed_by: REVISION_RA,
  },
  {
    id: 'RA6', file: NEXT_RA, tests: [T_RA],
    from: 'const now=String(s[a[i]]||"").replace(/\\n+$/,"");',
    to: 'const now=String(s[a[i]]||"");',
    why: 'next.md compares a topic with trailing newlines against the value the command substitution stripped, and refuses every dispatch of it',
    killed_by: REVISION_RA,
  },
  // ---- M7: Phase 5 sets its own root and host --------------------------------
  {
    id: 'RA7', file: NEXT_RA, tests: [T_RA],
    from: `${R1_RA}\n${R2_RA}\nORCH_PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT"\n${HOST_RA}`,
    to: HOST_RA,
    why: "Phase 5 depends on Phase 4's ORCH_PLUGIN_ROOT: in a fresh Bash call its check and release run /scripts/state.mjs and leave the admission in both locks",
    killed_by: [/joins both locks, switches, and holds the admission until Phase 5/, /Phase 5 sets its own plugin root and host/],
  },
  {
    id: 'RA8', file: NEXT_RA, tests: [T_RA],
    from: `${R1_RA}\n${R2_RA}\nORCH_PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT"\n${HOST_RA}`,
    to: `ORCH_PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT"\n${HOST_RA}`,
    why: "Phase 5 takes the root from CLAUDE_PLUGIN_ROOT as it finds it: unset in a fresh call, the engineer's in the engineer call's shell",
    killed_by: [/joins both locks, switches, and holds the admission until Phase 5/, /Phase 5 sets its own plugin root and host/],
  },
  {
    id: 'RA9', file: NEXT_RA, tests: [T_RA],
    from: `ORCH_PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT"\n${HOST_RA}`,
    to: 'ORCH_PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT"\n',
    why: "Phase 5 depends on Phase 4's DETECTED_HOST: in a fresh Bash call the writeback has no host",
    killed_by: [/joins both locks, switches, and holds the admission until Phase 5/, /Phase 5 sets its own plugin root and host/],
  },
  {
    id: 'RA10', file: SKILL_RA, tests: [T_RA],
    from: 'ACTIVE_PATH="$(node "$ENGINEER_PLUGIN_ROOT/scripts/state.mjs" \\\n  find-active --repo-root "$REPO_ROOT" --branch "$SUBTASK_BRANCH" 2>/dev/null)"\n[ -n "$ACTIVE_PATH" ] || { echo "✗ no active engineer workflow on $SUBTASK_BRANCH" >&2; exit 1; }\nENGINEER_WF_ID="$(basename "$ACTIVE_PATH" .md)"\n',
    to: '[ -n "$ENGINEER_WF_ID" ] || { echo "✗ no active engineer workflow on $SUBTASK_BRANCH" >&2; exit 1; }\n',
    why: "the Codex Phase 4 depends on an ENGINEER_WF_ID no block sets, so in a fresh call it never writes the child back",
    killed_by: /the Codex Phase 4 block, in a fresh shell call, finds the engineer workflow/,
  },

  // ---- RF: the SR refine's Refine-verify (F1, F2) ----------------------------
  // ---- F1: readiness judged again after the join -----------------------------
  {
    id: 'RF1', file: NEXT_RA, tests: [T_RA],
    from: 'if [ "$SUBTASK_STATUS" = "pending" ]; then\n  WAITING_NOW="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" subtask-readiness',
    to: 'if false; then\n  WAITING_NOW="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" subtask-readiness',
    why: 'next.md switches to a subtask that a plan revision during the join made wait on a predecessor',
    killed_by: WAITING_RF,
  },
  {
    id: 'RF2', tests: [T_RA],
    prepare: moveBefore_RA(NEXT_RA,
      "# Phase 1's dependency gate, judged again",
      '    exit 1\n  fi\nfi\n',
      'ADMISSION="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" admission join'),
    why: 'next.md judges readiness before the join, so a plan revision landing during the join is missed',
    killed_by: WAITING_RF,
  },
  {
    id: 'RF3', file: SKILL_RA, tests: [T_RA],
    from: 'if [ "$SUBTASK_STATUS" = "pending" ]; then\n  WAITING_NOW="$(node "<orchestrator-plugin-root>/scripts/state.mjs" subtask-readiness',
    to: 'if false; then\n  WAITING_NOW="$(node "<orchestrator-plugin-root>/scripts/state.mjs" subtask-readiness',
    why: 'the Codex next switches to a subtask that a plan revision during the join made wait on a predecessor',
    killed_by: WAITING_RF,
  },
  {
    id: 'RF4', tests: [T_RA],
    prepare: moveBefore_RA(SKILL_RA,
      'if [ "$SUBTASK_STATUS" = "pending" ]; then\n  WAITING_NOW',
      'exit 1; }\nfi\n',
      'ADMISSION="$(node "<orchestrator-plugin-root>/scripts/state.mjs" admission join'),
    why: 'the Codex next judges readiness in its join block, before the join',
    killed_by: WAITING_RF,
  },
  // ---- F2: the writeback binds the child only to the subtask it dispatched ---
  ...[[NEXT_RA, 'next.md Phase 5', 5], [SKILL_RA, 'the Codex Phase 4', 7]].flatMap(([file, where, n]) => [
    {
      id: `RF${n}`, file, tests: [T_RA],
      from: '  --expect-branch="$SUBTASK_BRANCH" --expect-verb="$SUBTASK_VERB" \\\n',
      to: '',
      why: `${where} binds the child to a subtask that a plan revision since its dispatch moved to another branch or verb`,
      killed_by: BINDING_RF,
    },
    {
      id: `RF${n + 1}`, file, tests: [T_RA],
      from: '  --expect-profile="$SUBTASK_PROFILE" --expect-topic="$SUBTASK_TOPIC" \\\n',
      to: '',
      why: `${where} binds the child to a subtask whose profile or topic a plan revision since its dispatch changed`,
      killed_by: BINDING_RF,
    },
  ]),
  {
    id: 'RF9', file: ORCH_STATE, tests: [T_RA, T_PROV_RF],
    from: '      if (now !== expected) {',
    to: '      if (false) {',
    why: 'subtask-update takes --expect-verb, --expect-profile and --expect-topic and checks none of them',
    killed_by: [BINDING_RF, EXPECT_API_RF],
  },
  {
    id: 'RF10', file: ORCH_STATE, tests: [T_RA, T_PROV_RF],
    from: "      const now = String(current[field] || '').replace(/\\n+$/, '');",
    to: "      const now = String(current[field] || '');",
    why: "a topic ending in a newline never matches the value a runbook's command substitution carries, so its every dispatch is refused",
    killed_by: [BINDING_RF, EXPECT_API_RF],
  },
  {
    id: 'RF11', file: ORCH_STATE, tests: [T_PROV_RF],
    from: "      const expected = opts[option].replace(/\\n+$/, '');",
    to: '      const expected = opts[option];',
    why: 'an expected topic that keeps its trailing newline is refused against the same topic',
    killed_by: EXPECT_API_RF,
  },
  {
    id: 'RF12', file: ORCH_STATE, tests: [T_RA, T_PROV_RF],
    from: "      const now = String(current[field] || '').replace(/\\n+$/, '');",
    to: "      const now = String(current[field]).replace(/\\n+$/, '');",
    why: 'an empty expected profile is refused against a subtask with none (it reads "undefined")',
    killed_by: [BINDING_RF, EXPECT_API_RF],
  },
  ...[['expectVerb', 'expect-verb', 13], ['expectProfile', 'expect-profile', 14], ['expectTopic', 'expect-topic', 15]].map(([option, flag, n]) => ({
    id: `RF${n}`, file: ORCH_STATE, tests: [T_RA],
    from: `          ${option}: flags['${flag}'],\n`,
    to: '',
    why: `the subtask-update CLI drops --${flag}, so the writeback binds the child whatever that field now says`,
    killed_by: BINDING_RF,
  })),
  {
    id: 'RF16', file: ORCH_STATE, tests: [T_PROV_RF],
    from: "    if (typeof expected !== 'string' || (option === 'expectVerb' && expected.length === 0)) {",
    to: "    if (typeof expected !== 'string') {",
    why: 'an empty expected verb is taken, and expects a subtask with no verb',
    killed_by: EXPECT_API_RF,
  },
  // ---- the cutover journal (MINOR, folded in) --------------------------------
  {
    id: 'RF17', file: CUTOVER, tests: [T_CUTOVER],
    from: '      await moveJudged(open.file, open.doc, finished.map((pair) => ({ pair, source: false })), root, { withFileLock, withDirectoryLock });\n',
    to: '',
    why: "a move killed after its last rename leaves that pair's record out of its manifest for good: the rerun plans again past it",
    killed_by: /a move killed after its last rename, before that pair's record/,
  },

  // ---- RB: the final critique's findings (refine) ----
  {
    id: 'RB1', file: RUN_LOCKS_RB, tests: [T_ADMISSION_RB],
    from: '    return fs.realpathSync(top);\n',
    to: '    return path.resolve(checkout);\n',
    why: 'a checkout is keyed by the path given, not its toplevel: a session in a subdirectory joins another worktree lock',
    killed_by: /a checkout is keyed by its toplevel/,
  },
  {
    id: 'RB2', file: RUN_LOCKS_RB, tests: [T_ADMISSION_RB],
    from: "  if (typeof checkout !== 'string' || checkout === '') {\n",
    to: "  if (typeof checkout !== 'string') {\n",
    why: 'an empty --checkout is not refused: git reads it as the working directory',
    killed_by: /an empty --checkout is refused before anything is written/,
  },
  {
    id: 'RB3', file: RUN_LOCKS_RB, tests: [T_ADMISSION_RB],
    from: '  checkout = checkoutRoot(checkout);\n  const macroLock',
    to: '  checkout = path.resolve(checkout);\n  const macroLock',
    why: 'check keys the checkout by the path given: an admission checked from a subdirectory reads as made for another checkout',
    killed_by: /a checkout is keyed by its toplevel/,
  },
  {
    id: 'RB4', file: RUN_LOCKS_RB, tests: [T_ADMISSION_RB],
    from: "  checkout = checkoutRoot(checkout);\n  if (admissionId === ''",
    to: "  checkout = path.resolve(checkout);\n  if (admissionId === ''",
    why: "release keys the checkout by the path given: released from a subdirectory, the worktree-lock entry stays",
    killed_by: /a checkout is keyed by its toplevel/,
  },
  {
    id: 'RB5', file: ORCH_STOP_RB, tests: [T_STOP_RB],
    from: "execFileSync('git', ['--no-optional-locks', '-C', holder, 'status',",
    to: "execFileSync('git', ['-C', holder, 'status',",
    why: "the Stop's status of the worktree holding the macro branch refreshes and rewrites that worktree's index under its index.lock",
    killed_by: /leaves that worktree's index untouched/,
  },

  // ---- RC: the final critique's findings (refine) ----
  {
    id: 'RC1', file: 'plugins/orchestrator/scripts/lib/cutover.mjs', tests: T_RC,
    from: '  if (open && Array.isArray(open.doc.pairs) && !hasPairAtSource(open.doc)) {\n',
    to: '  if (false) {\n',
    why: '--move resumes any open manifest, even one whose pairs have all moved, so a later macro is never planned',
    killed_by: [/before the switch, plans again/, /after the switch, each later --move plans again/],
  },
  {
    id: 'RC2', file: 'plugins/orchestrator/scripts/lib/cutover.mjs', tests: T_RC,
    from: '    if (archived.length > 0) {',
    to: '    if (false) {',
    why: 'verify judges a moved macro archived since as an active one (macro-resolves, next-ready ENOENT)',
    killed_by: /archived since by its Stop/,
  },
  {
    id: 'RC3', file: 'plugins/orchestrator/scripts/lib/cutover.mjs', tests: T_RC,
    from: "add('macro-archived', found === null && error === null,",
    to: "add('macro-archived', true,",
    why: 'an archived macro passes even when a checkout still resolves its id to an active copy',
    killed_by: /archived since by its Stop/,
  },
  {
    id: 'RC4', file: 'plugins/orchestrator/scripts/lib/cutover.mjs', tests: T_RC,
    from: "add('next-ready', problem === null,",
    to: "add('next-ready', Array.isArray(subtasks),",
    why: 'the next-ready check judges the presence of the subtask array, not what next-ready refuses',
    killed_by: /plan is one next-ready cannot work from/,
  },
  {
    id: 'RC5', file: 'plugins/orchestrator/scripts/lib/state-root.mjs', tests: T_RC,
    from: '  return [shared, toplevel];',
    to: '  return [toplevel];',
    why: "orchestrator's read set of a linked worktree is its own home only (resolve-workflow, find-macro, find-active from a worktree added later miss the macro)",
    killed_by: /a linked worktree added after the cutover reaches the moved macro/,
  },
  {
    id: 'RC6', file: 'plugins/engineer/scripts/lib/state-root.mjs', tests: T_RC,
    from: '  return [shared, toplevel];',
    to: '  return [toplevel];',
    why: "engineer's read set of a linked worktree is its own home only (find-active for the moved child from a worktree added later misses it)",
    killed_by: /a linked worktree added after the cutover reaches the moved macro/,
  },

  // ---- RD: the final critique's findings (refine) ----
  {
    id: 'RD1', file: ENG_RD, tests: [T_RD],
    from: 'const inferred = workflowStorage(workflowPath);',
    to: 'const inferred = inferStorageFromWorkflowPath(workflowPath);',
    why: "archive infers the record's home from the unresolved path: a relative path goes to --repo-root's archive, a ./ path throws",
    killed_by: [/engineer: archive and resume archive .* > archive: a relative --workflow-path from the main checkout/, /engineer: archive and resume archive .* > archive: a '\.\/'-relative --workflow-path/],
  },
  {
    id: 'RD2', file: ORCH_RD, tests: [T_RD],
    from: 'const inferred = workflowStorage(workflowPath);',
    to: 'const inferred = inferStorageFromWorkflowPath(workflowPath);',
    why: "the orchestrator archive infers the macro's home from the unresolved path",
    killed_by: [/orchestrator: archive reads .* > a relative --workflow-path from the main checkout/, /orchestrator: archive reads .* > a '\.\/'-relative --workflow-path archives/],
  },
  {
    id: 'RD3', file: ENG_RD, tests: [T_RD],
    from: '  for (const root of lookupRoots(repoRoot)) {\n    for (const home of homeNames()) {\n      const candidate = workflowFilePath(root, workflowId, { home });',
    to: '  for (const root of [repoRoot]) {\n    for (const home of homeNames()) {\n      const candidate = workflowFilePath(root, workflowId, { home });',
    why: "resolve-workflow reads only the checkout's own home, not the read set",
    killed_by: [/engineer: .* > resolve-workflow from a lane finds a record in the default state root/, /engineer: .* > resume\.md \(bash\): archive <id> from a lane/],
  },
  {
    id: 'RD4', file: ENG_RD, tests: [T_RD],
    from: '  if (found.length > 1) {\n    throw new Error(\n      `Ambiguous ${personaName()} workflow storage: workflow ${workflowId}',
    to: '  if (found.length > 99) {\n    throw new Error(\n      `Ambiguous ${personaName()} workflow storage: workflow ${workflowId}',
    why: 'resolve-workflow picks one of two files holding the id instead of refusing',
    killed_by: /engineer: .* > resolve-workflow refuses two files holding one id/,
  },
  {
    id: 'RD5', file: ENG_RD, tests: [T_RD],
    from: "of the read set of ${flags['repo-root']}\\n`,\n          );\n          return 3;",
    to: "of the read set of ${flags['repo-root']}\\n`,\n          );\n          return 1;",
    why: 'resolve-workflow reports not-found with the error exit code, not 3',
    killed_by: /engineer: .* > resolve-workflow refuses two files holding one id, naming both; exits 3 when none holds it/,
  },
  {
    id: 'RD6', file: ENG_RD, tests: [T_RD],
    from: "for (const file of await listWorkflowFiles(flags['repo-root']))",
    to: "for (const file of await workflowFilesIn([workflowDir(flags['repo-root'])]))",
    why: "list-workflows lists only the checkout's own home, not the read set",
    killed_by: /engineer: .* > resolve-workflow from a lane finds a record in the default state root and one in its own home/,
  },
  {
    id: 'RD7', file: ENG_RESUME_RD, tests: [T_RD],
    from: 'if ! WORKFLOW="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \\\n    resolve-workflow --repo-root "$REPO_ROOT" --workflow-id "$ARCHIVE_WORKFLOW_ID")"; then',
    to: 'WORKFLOW="$REPO_ROOT/.agentic-plugins/state/engineer/workflows/$ARCHIVE_WORKFLOW_ID.md"\nif ! [ -f "$WORKFLOW" ]; then',
    why: "the resume archive block resolves the id to the checkout's own workflows home only (the old path)",
    killed_by: /engineer: .* > resume\.md \((bash|zsh)\): archive <id> from a lane resolves the record/,
  },

  // ---- RE: the final critique's findings (refine) ----
  // M9 — each lock, each writer (the shared helper; killed_by names the writer's test).
  ...lockMutations_RE('RE', 1, ENG_RE, [W_RE]),
  ...lockMutations_RE('RE', 5, ORCH_RE, [O_RE]),
  // M9 — a writer forced onto the single-lock path at its call site.
  { id: 'RE9', file: ENG_RE, tests: [W_RE],
    from: 'return withCreationLocks(storage, ({ lockPath, token }) =>',
    to: 'return withDirectoryLock(storage.stateRoot, ({ lockPath, token }) =>',
    why: 'persona create takes only the record home lock', killed_by: /create waits on the repository's creation lock/ },
  { id: 'RE10', file: ENG_RE, tests: [W_RE],
    from: 'return withCreationLocks(sourceStorage, async () => {',
    to: 'return withDirectoryLock(sourceStorage.stateRoot, async () => {',
    why: 'persona archive takes only the record home lock', killed_by: /archive waits on the repository's creation lock/ },
  { id: 'RE11', file: ORCH_RE, tests: [O_RE],
    from: 'return withCreationLocks(storage, ({ lockPath, token }) =>',
    to: 'return withDirectoryLock(storage.stateRoot, ({ lockPath, token }) =>',
    why: 'orchestrator create takes only the record home lock', killed_by: /create waits on the repository's creation lock/ },
  { id: 'RE12', file: ORCH_RE, tests: [O_RE],
    from: 'return withCreationLocks(sourceStorage, async () => {',
    to: 'return withDirectoryLock(sourceStorage.stateRoot, async () => {',
    why: 'orchestrator archive takes only the record home lock', killed_by: /archive waits on the repository's creation lock/ },
  // M10 (e) — subtask-update writes without the macro's file lock.
  { id: 'RE13', file: ORCH_RE, tests: [O_RE],
    from: "  const result = await withFileLock(workflowPath, async ({ lockPath, token }) => {\n    const text = await readFile(workflowPath, 'utf8');\n    const { frontmatter, body } = parseWorkflowFile(text);\n    ensureMutable(frontmatter);\n\n    const subtasks = frontmatter.plan?.subtasks;",
    to: "  const result = await (async (f) => f({ lockPath: null, token: null }))(async ({ lockPath, token }) => {\n    const text = await readFile(workflowPath, 'utf8');\n    const { frontmatter, body } = parseWorkflowFile(text);\n    ensureMutable(frontmatter);\n\n    const subtasks = frontmatter.plan?.subtasks;",
    why: 'subtask-update takes no macro file lock', killed_by: /two worktrees writing one macro meet on one lock/ },
  // M10 (f) — AGENTIC_STATE_BASE naming the checkout ignored: creation falls
  // through to the default state root (the git common dir's).
  { id: 'RE14', file: 'persona-pipeline/files/scripts/lib/state-root.mjs', tests: [S_RE],
    from: STATE_BASE_CHECKOUT_RE, to: STATE_BASE_IGNORED_RE,
    why: 'override naming the checkout ignored (library)', killed_by: /AGENTIC_STATE_BASE naming the checkout keeps creation in it/ },
  { id: 'RE15', file: 'plugins/engineer/scripts/lib/state-root.mjs', tests: [W_RE],
    from: STATE_BASE_CHECKOUT_RE, to: STATE_BASE_IGNORED_RE,
    why: "override naming the checkout ignored (engineer's copy)", killed_by: /AGENTIC_STATE_BASE naming the checkout: the record stays home/ },
  { id: 'RE16', file: 'plugins/orchestrator/scripts/lib/state-root.mjs', tests: [O_RE],
    from: STATE_BASE_CHECKOUT_RE, to: STATE_BASE_IGNORED_RE,
    why: "override naming the checkout ignored (orchestrator's copy)", killed_by: /create waits on the record home's creation lock/ },
  // M10 (g) — an update of a record found in the checkout's own home written
  // where a new record would be created (the default state root once shared
  // creation is on), not where it is.
  { id: 'RE17', file: ENG_RE, tests: [W_RE],
    from: '    await atomicWrite(\n      workflowPath,\n      assembleWorkflowFile(frontmatter, newBody),\n      { lockPath, token },\n    );\n    return { frontmatter, workflowPath };',
    to: "    const updateDir = join(creationRoot(resolvePath(workflowPath, '../../../../..')).root, stateDirRel(), 'workflows');\n    await ensureDir(updateDir, 0o700);\n    await atomicWrite(\n      join(updateDir, basename(workflowPath)),\n      assembleWorkflowFile(frontmatter, newBody),\n      { lockPath, token },\n    );\n    return { frontmatter, workflowPath };",
    why: 'append writes a local record under the creation root', killed_by: /updated in place, never copied/ },
  { id: 'RE18', file: ORCH_RE, tests: [O_RE],
    from: '    await atomicWrite(\n      workflowPath,\n      assembleWorkflowFile(frontmatter, newBody),\n      { lockPath, token },\n    );\n    return { frontmatter, workflowPath, promoted, allTerminal };',
    to: "    const updateDir = join(creationRoot(resolvePath(workflowPath, '../../../../..')).root, STATE_DIR_REL, 'workflows');\n    await ensureDir(updateDir, 0o700);\n    await atomicWrite(\n      join(updateDir, basename(workflowPath)),\n      assembleWorkflowFile(frontmatter, newBody),\n      { lockPath, token },\n    );\n    return { frontmatter, workflowPath, promoted, allTerminal };",
    why: 'plan-set writes a local macro under the creation root', killed_by: /updated in place, never copied/ },

  // ---- DS: the dispatch selection the child records, compared by every binding
  // The orchestrator's two writers that bind a child.
  { id: 'DS1', file: ORCH_DS, tests: [T_TERM_DS],
    from: "      if (mismatch) throw dispatchRefusal('recordEngineerTerminal', subtaskId, mismatch);",
    to: "      if (mismatch && false) throw dispatchRefusal('recordEngineerTerminal', subtaskId, mismatch);",
    why: 'the engineer terminal note binds a child to a subtask revised since its dispatch',
    killed_by: /recordEngineerTerminal: a branch revised since the dispatch binds nothing/ },
  { id: 'DS2', file: ORCH_DS, tests: [T_TERM_DS],
    from: "      if (mismatch) throw dispatchRefusal('updateSubtask', subtaskId, mismatch);",
    to: "      if (mismatch && false) throw dispatchRefusal('updateSubtask', subtaskId, mismatch);",
    why: 'subtask-update binds a child to a subtask revised since its dispatch',
    killed_by: /updateSubtask: a branch revised since the dispatch refuses the binding write/ },
  // The engineer's terminal note: sent with the dispatch, from P10 and the Stop.
  { id: 'DS3', file: ENG_PW_DS, tests: [T_STOP_DS],
    from: '  if (expectDispatch !== null && expectDispatch !== undefined) {\n    args.push(',
    to: '  if (false) {\n    args.push(',
    why: 'the writeback does not send the dispatch the child records', killed_by: STOP_REFUSED_DS },
  { id: 'DS4', file: 'plugins/engineer/scripts/stop-archive.mjs', tests: [T_STOP_DS],
    from: '      expectDispatch: dispatchExpectation(frontmatter),',
    to: '      expectDispatch: null,',
    why: "the Stop's writeback omits the child's dispatch", killed_by: STOP_REFUSED_DS },
  { id: 'DS5', file: 'plugins/engineer/scripts/phase7-commit.mjs', tests: [T_P7_DS],
    from: '      expectDispatch: dispatchExpectation(fresh),',
    to: '      expectDispatch: null,',
    why: "P10's writeback omits the child's dispatch",
    killed_by: [/P10 \(claude\) — a subtask revised after its child was dispatched is not bound to it/, /P10 \(codex\) — a subtask revised after its child was dispatched is not bound to it/] },
  { id: 'DS6', file: ENG_PW_DS, tests: [T_STOP_DS],
    from: "  return { macro, subtask, branch: frontmatter.git_baseline?.branch ?? '' };",
    to: '  return null;',
    why: 'a child from before the record is bound unchecked',
    killed_by: /no record \(a child created before it\), the branch revised — the Stop binds nothing/ },
  // The record at create.
  { id: 'DS7', file: ENG_STATE_DS, tests: [T_SEL_DS],
    from: "    frontmatter.dispatched_branch = dispatchSelection.branch;\n    frontmatter.dispatched_verb = dispatchSelection.verb;\n    frontmatter.dispatched_profile = dispatchSelection.profile ?? '';\n    frontmatter.dispatched_topic = dispatchSelection.topic ?? '';",
    to: '',
    why: 'create records no dispatch selection', killed_by: /records the four fields beside the ids/ },
  { id: 'DS8', file: ENG_STATE_DS, tests: [T_SEL_DS],
    from: '    const problem = dispatchSelectionProblem(dispatchSelection, {',
    to: '    const problem = null && dispatchSelectionProblem(dispatchSelection, {',
    why: 'create records a selection naming another branch, verb or subtask',
    killed_by: [/create refuses a selection with another branch/, /create refuses a selection with another verb/] },
  { id: 'DS9', file: 'plugins/engineer/commands/compose.md', tests: [T_NPP_DS],
    from: '    PARENT_ARGS+=(--dispatch-selection "$AGENTIC_DISPATCH_SELECTION")',
    to: '    :',
    why: 'the bootstrap does not forward the selection to create',
    killed_by: /compose: the dispatched child records parent_workflow_path beside the two ids/ },
  { id: 'DS10', file: NEXT_DS, tests: [T_NPP_DS],
    from: 'export AGENTIC_DISPATCH_SELECTION\n',
    to: 'unset AGENTIC_DISPATCH_SELECTION\n',
    why: "next's Phase 4 exports no selection",
    killed_by: /compose: the dispatched child records parent_workflow_path beside the two ids/ },
  { id: 'DS11', file: NEXT_SKILL_DS, tests: [T_NPP_DS],
    from: 'export AGENTIC_DISPATCH_SELECTION\n',
    to: 'unset AGENTIC_DISPATCH_SELECTION\n',
    why: "the Codex next's Phase 3 exports no selection",
    killed_by: /Codex prelude: the dispatched child records parent_workflow_path/ },
  // next's Phase 5 on both hosts: the child's own record.
  { id: 'DS12', file: NEXT_DS, tests: [T_ADMISSION_RUNBOOKS],
    from: '  --expect-dispatch="$CHILD_DISPATCH" \\\n  --event=updated',
    to: '  --event=updated',
    why: "next's Phase 5 binds a re-attached child its revised subtask no longer matches",
    killed_by: /re-attached child whose recorded dispatch the revised subtask no longer matches/ },
  { id: 'DS13', file: NEXT_SKILL_DS, tests: [T_ADMISSION_RUNBOOKS],
    from: '  --expect-dispatch="$CHILD_DISPATCH" \\\n  --event updated',
    to: '  --event updated',
    why: "the Codex next's Phase 4 binds a re-attached child its revised subtask no longer matches",
    killed_by: /re-attached child whose recorded dispatch the revised subtask no longer matches/ },
  // done's owner found by the scan, on both hosts and both write paths.
  { id: 'DS14', file: DONE_DS, tests: [T_DONE_RUNBOOK],
    from: '  DISPATCH_ARGS=(--expect-dispatch="$OWNER_DISPATCH")',
    to: '  DISPATCH_ARGS=()',
    why: "done keeps no dispatch of the owner it found",
    killed_by: /a child that predates the record, the branch revised \(--no-commit\)/ },
  { id: 'DS15', file: DONE_DS, tests: [T_DONE_RUNBOOK],
    from: '    "${DISPATCH_ARGS[@]}" --reason-file="$REASON_FILE" --event=updated || exit $?',
    to: '    --reason-file="$REASON_FILE" --event=updated || exit $?',
    why: "done --no-commit binds the scanned owner to a revised subtask",
    killed_by: /a recorded dispatch, the topic revised \(--no-commit\)/ },
  { id: 'DS16', file: DONE_DS, tests: [T_DONE_RUNBOOK],
    from: 'UPDATE_ARGS+=("${DISPATCH_ARGS[@]}")\n',
    to: '',
    why: "done's landing binds the scanned owner to a revised subtask",
    killed_by: /a recorded dispatch, the topic revised \(the landing\)/ },
  { id: 'DS17', file: DONE_SKILL_DS, tests: [T_DONE_RUNBOOK],
    from: '  "${DISPATCH_ARGS[@]}" \\\n',
    to: '',
    why: "the Codex done's write omits the scanned owner's dispatch",
    killed_by: /Codex: the Phase 4 write is refused when the subtask is no longer the one the scanned owner was dispatched for/ },
  // The dispatch preflight.
  { id: 'DS18', file: 'plugins/orchestrator/scripts/discover-engineer.mjs', tests: [T_DISC_DS],
    from: "  if (!stateText.includes(\"'dispatch-selection'\") || !writebackText.includes('--expect-dispatch=')) {",
    to: '  if (false) {',
    why: 'next dispatches into an engineer that neither records nor sends the selection',
    killed_by: /predates the dispatch selection/ },
  // The Refine-verify's P1-P3 (refine-verify-20261009T024621Z-8558b5).
  { id: 'DS19', file: NEXT_SKILL_DS, tests: [T_NPP_DS],
    from: 'process.stdout.write(JSON.stringify({ subtask, branch, verb, profile, topic }))',
    to: 'process.stdout.write(JSON.stringify({ subtask, branch, verb, profile: "", topic: "" }))',
    why: "the Codex next's selection drops the profile and topic (RX1)",
    killed_by: /Codex prelude: the dispatched child records parent_workflow_path/ },
  { id: 'DS20', file: NEXT_DS, tests: [T_NPP_DS],
    from: '"${SUBTASK_TOPIC:-}")" || exit 1\nexport AGENTIC_DISPATCH_SELECTION',
    to: '"${SUBTASK_TOPIC:-}")"\nexport AGENTIC_DISPATCH_SELECTION',
    why: "next's prelude goes on when the selection cannot be built, creating a child without the record",
    killed_by: /Claude prelude: a selection that cannot be built stops the dispatch before create/ },
  { id: 'DS21', file: NEXT_SKILL_DS, tests: [T_NPP_DS],
    from: '"${SUBTASK_TOPIC:-}")" || exit 1\nexport AGENTIC_DISPATCH_SELECTION',
    to: '"${SUBTASK_TOPIC:-}")"\nexport AGENTIC_DISPATCH_SELECTION',
    why: "the Codex next's prelude goes on when the selection cannot be built",
    killed_by: /Codex prelude: a selection that cannot be built stops the dispatch before create/ },
  // P1's recorded owner: owner-dispatch takes the owner the subtask records and
  // reads that workflow's own file (DS22 was done.md's lookup of it, gone with
  // the inline scan; DS24 below is the case where no file of it is left).
  { id: 'DS22', file: ORCH_DS, tests: [T_DONE_RUNBOOK],
    from: "    if (claims.has(owner)) return { status: 'found', claim: claims.get(owner) };",
    to: "    if (claims.has(owner)) return { status: 'found', claim: { ...claims.get(owner), dispatch: { macro: macroId, subtask: subtaskId, branch: claims.get(owner).dispatch.branch } } };",
    why: 'done compares only the branch of the dispatch its recorded owner records (P1)',
    killed_by: [/a recorded owner is not bound to a subtask revised since its dispatch: the owner recorded on the subtask, the topic revised \(--no-commit\)/, /a recorded owner is not bound to a subtask revised since its dispatch: the owner recorded on the subtask, the topic revised \(the landing\)/] },
  // The fault cases inject their fault during the join: the active-child scan
  // after it still refuses what it cannot list (off-branch-archive G3 is the
  // same reader's listing; this is its unlistable-home case under --no-commit).
  { id: 'DS23', file: ORCH_DS, tests: [T_DONE_RUNBOOK],
    from: "          names = readdirSync(dir);\n        } catch (err) {\n          if (err.code === 'ENOENT') continue;\n          throw err;\n        }",
    to: "          names = readdirSync(dir);\n        } catch (err) {\n          continue;\n        }",
    why: "done --no-commit's active-child scan reads a home it cannot list as empty",
    killed_by: /--no-commit refuses when an engineer workflow home cannot be listed/ },
  // The Refine-verify's R1-R3 (refine-verify-20261009T035420Z-ed9f8f): a
  // completion in a child's name compares that child's dispatch, and fails
  // closed when it cannot be read.
  { id: 'DS24', file: DONE_DS, tests: [T_DONE_RUNBOOK],
    from: 'elif [ "$OWNER_RC" -eq 3 ] && [ "${WAIVE_DISPATCH:-}" = "1" ]; then\n  # The recorded owner\'s file is gone, and the operator completes in its name\n  # anyway; subtask-update records the waiver and the reason in the macro.\n  DISPATCH_ARGS=(--waive-dispatch)',
    to: 'elif [ "$OWNER_RC" -eq 3 ]; then\n  DISPATCH_ARGS=()',
    why: 'done takes a recorded owner whose file is gone as recorded and completes without the comparison (R1)',
    killed_by: [/a recorded owner with no file left refuses; --waive-dispatch with a reason completes and is recorded \(the landing\)/, /a recorded owner with no file left refuses; --waive-dispatch with a reason completes and is recorded \(--no-commit\)/] },
  { id: 'DS25', file: DONE_SKILL_DS, tests: [T_DONE_RUNBOOK],
    from: 'elif [ "$OWNER_RC" -eq 3 ] && [ "${WAIVE_DISPATCH:-}" = "1" ] && [ "$RECORDED_OWNER" = "$ENGINEER_WF_ID" ]; then\n  DISPATCH_ARGS=(--waive-dispatch)',
    to: 'elif [ "$OWNER_RC" -eq 3 ]; then\n  DISPATCH_ARGS=()',
    why: "the Codex done takes a recorded owner whose file is gone as recorded (R1)",
    killed_by: /Codex: a recorded owner with no file left refuses; WAIVE_DISPATCH=1 with a reason completes and is recorded/ },
  { id: 'DS26', file: ORCH_DS, tests: [T_DONE_RUNBOOK],
    from: "  if (!raw.startsWith('\"')) return raw.trim();",
    to: "  if (raw.startsWith('\"')) return raw.slice(1, -1);\n  if (!raw.startsWith('\"')) return raw.trim();",
    why: "the owner and active-child scans compare the serialized text of a value, not the value (R3)",
    killed_by: [/a subtask id holding a quote: the claimant is found by its value and the subtask completes/, /a subtask id holding a quote: its recorded owner's dispatch is read and compared/, /a subtask id holding a quote: --no-commit refuses while its child is active/] },
  { id: 'DS27', file: ORCH_DS, tests: [T_DONE_RUNBOOK],
    from: "    const newBody = `${body}${noteHeading}${noteSummary}${correctionNote}${waiverNote}${reasonNote}`;",
    to: "    const newBody = `${body}${noteHeading}${noteSummary}${correctionNote}${reasonNote}`;",
    why: 'a write not compared with its owner\'s dispatch leaves no record of the waiver',
    killed_by: /a recorded owner with no file left refuses; --waive-dispatch with a reason completes and is recorded \(the landing\)/ },
  { id: 'DS28', file: ORCH_DS, tests: [T_DONE_RUNBOOK],
    from: "  if (waiveDispatch) {\n    if (reasonText.length === 0) {",
    to: "  if (waiveDispatch) {\n    if (false) {",
    why: 'subtask-update waives the comparison without a reason',
    killed_by: /the waiver needs a reason, names an owner, and excludes a dispatch to compare/ },
  { id: 'DS29', file: ORCH_DS, tests: [T_DONE_RUNBOOK],
    from: "            `--expect-dispatch=${shellWord(JSON.stringify(claim.dispatch))}`);",
    to: "            '');",
    why: "done's ambiguity refusal prints a binding line that compares nothing (R2)",
    killed_by: /two claimants: each binding line carries its dispatch, refuses a revised subtask, and binds an unrevised one/ },
  { id: 'DS30', file: ORCH_DS, tests: [T_DONE_RUNBOOK],
    from: "    if (others.has(owner)) return { status: 'elsewhere', files: others.get(owner) };\n",
    to: '',
    why: 'a recorded owner dispatched for another subtask reads as gone, which the waiver then completes',
    killed_by: /a recorded owner whose file claims another subtask refuses, --waive-dispatch or not/ },
  { id: 'DS31', file: DONE_DS, tests: [T_DONE_RUNBOOK],
    from: '  if [ "${WAIVE_DISPATCH:-}" = "1" ]; then\n    echo "✗ --waive-dispatch applies only',
    to: '  if false; then\n    echo "✗ --waive-dispatch applies only',
    why: "--waive-dispatch is taken when the owner's dispatch was read, and the comparison is dropped",
    killed_by: /--waive-dispatch is refused while the owner's dispatch can be read, and nothing is written/ },
  // The fourth Refine-verify's findings (refine-verify-20261009T044549Z-bc0075).
  { id: 'DS32', file: DONE_SKILL_DS, tests: [T_DONE_RUNBOOK],
    from: "if [ -n \"$RECORDED_OWNER\" ] && [ \"$RECORDED_OWNER\" != \"$ENGINEER_WF_ID\" ]; then\n  echo \"✗ $SUBTASK_ID now records owner $RECORDED_OWNER, not $ENGINEER_WF_ID, the owner Phase 3 resolved the landing for; nothing was written. Rerun from Phase 2.\" >&2\n  exit 1\nfi\nOWNER_ARGS=(--repo-root \"$REPO_ROOT\" --macro-id \"$MACRO_ID\" --workflow-path \"$MACRO_PATH\" --subtask-id \"$SUBTASK_ID\" --host codex --engineer-workflow-id \"$ENGINEER_WF_ID\")\n# Under set -e an unguarded nonzero exit would end the block before OWNER_RC.\nOWNER_JSON=\"$(node \"<orchestrator-plugin-root>/scripts/state.mjs\" owner-dispatch \"${OWNER_ARGS[@]}\")\" && OWNER_RC=0 || OWNER_RC=$?\nif [ \"$OWNER_RC\" -eq 0 ]; then\n  [ \"${WAIVE_DISPATCH:-}\" != \"1\" ] || { echo \"✗ --waive-dispatch applies only when the owner's dispatch cannot be read; it was read, and the write compares it.\" >&2; exit 1; }\n  OWNER_DISPATCH=\"$(printf '%s' \"$OWNER_JSON\" | JSON_KEY=dispatch node -e \"$JSON_FIELD\")\"",
    to: "OWNER_ARGS=(--repo-root \"$REPO_ROOT\" --macro-id \"$MACRO_ID\" --workflow-path \"$MACRO_PATH\" --subtask-id \"$SUBTASK_ID\" --host codex)\n[ -n \"$RECORDED_OWNER\" ] && OWNER_ARGS+=(--engineer-workflow-id \"$RECORDED_OWNER\")\nOWNER_JSON=\"$(node \"<orchestrator-plugin-root>/scripts/state.mjs\" owner-dispatch \"${OWNER_ARGS[@]}\")\" && OWNER_RC=0 || OWNER_RC=$?\nif [ \"$OWNER_RC\" -eq 0 ]; then\n  ENGINEER_WF_ID=\"$(printf '%s' \"$OWNER_JSON\" | JSON_KEY=engineer_workflow_id node -e \"$JSON_FIELD\")\"\n  OWNER_DISPATCH=\"$(printf '%s' \"$OWNER_JSON\" | JSON_KEY=dispatch node -e \"$JSON_FIELD\")\"",
    why: "the Codex done's Phase 4 takes the owner recorded now, not the one its landing was resolved for (finding 1)",
    killed_by: /Codex: a landing resolved for one owner is not written for an owner bound since/ },
  { id: 'DS33', file: DONE_DS, tests: [T_DONE_RUNBOOK],
    from: "OWNER_JSON=\"$(node \"$CLAUDE_PLUGIN_ROOT/scripts/state.mjs\" owner-dispatch \"${OWNER_ARGS[@]}\")\" && OWNER_RC=0 || OWNER_RC=$?",
    to: "OWNER_JSON=\"$(node \"$CLAUDE_PLUGIN_ROOT/scripts/state.mjs\" owner-dispatch \"${OWNER_ARGS[@]}\")\"\nOWNER_RC=$?",
    why: "under set -e, done ends at owner-dispatch's exit 3 and the waiver never runs (finding 3)",
    killed_by: /under set -e, --waive-dispatch with a reason still completes \(Claude and Codex\)/ },
  { id: 'DS34', file: DONE_SKILL_DS, tests: [T_DONE_RUNBOOK],
    from: "OWNER_JSON=\"$(node \"<orchestrator-plugin-root>/scripts/state.mjs\" owner-dispatch \"${OWNER_ARGS[@]}\")\" && OWNER_RC=0 || OWNER_RC=$?",
    to: "OWNER_JSON=\"$(node \"<orchestrator-plugin-root>/scripts/state.mjs\" owner-dispatch \"${OWNER_ARGS[@]}\")\"\nOWNER_RC=$?",
    why: "under set -e, the Codex done ends at owner-dispatch's exit 3 (finding 3)",
    killed_by: /under set -e, --waive-dispatch with a reason still completes \(Claude and Codex\)/ },
  { id: 'DS35', file: DONE_SKILL_DS, tests: [T_DONE_RUNBOOK],
    from: '  --engineer-workflow-id "$ENGINEER_WF_ID" [--pr "$PR"] [--commit "$COMMIT"]',
    to: '  [--pr "$PR"] [--commit "$COMMIT"]',
    why: "the Codex done resolves the landing without the owner Phase 2 printed, so a recovered owner has no dispatch time",
    killed_by: /Codex: the Phase 3 block resolves the landing for the owner Phase 2 printed/ },
];
