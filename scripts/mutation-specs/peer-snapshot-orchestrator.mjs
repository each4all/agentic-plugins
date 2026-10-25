// Mutation spec — do the orchestrator's C96 peer-snapshot tests catch the
// defects they exist for?
//
// Run: npm run mutate -- scripts/mutation-specs/peer-snapshot-orchestrator.mjs
//
// The orchestrator's peer-runner.mjs and dispatch-peer.mjs give a codex peer
// a snapshot of the checkout, as the persona copies do (their spec:
// peer-snapshot.mjs), through copies of the shared libraries. Each defect
// below puts one route back to the live tree, breaks the lifecycle that
// removes the snapshot, lets a copy drift from its source, or breaks what the
// orchestrator keeps of its own: the companion resolved before anything is
// recorded, reclaimed or captured.
//
// Groups: P the runner, D the dispatcher, O the orchestrator's order, L the
// library copies.

const T_SNAP = 'tests/orchestrator/test-peer-snapshot.mjs';
const T_PARITY = 'tests/scripts/test-orchestrator-peer-snapshot-parity.mjs';

export const TESTS = [T_SNAP, T_PARITY];

const RUNNER = 'plugins/orchestrator/scripts/peer-runner.mjs';
const DISPATCH = 'plugins/orchestrator/scripts/dispatch-peer.mjs';
const LOCKS = 'plugins/orchestrator/scripts/lib/run-locks.mjs';
const SNAPSHOT_LIB = 'plugins/orchestrator/scripts/lib/peer-snapshot.mjs';
// A definition of the run locks' own, the same rule as the shared one.
const L2_LOCAL = "export { isProcessAlive };\nexport function fingerprintsMatch(recorded, current) {\n  if (!recorded || recorded.kind === 'none') return false;\n  if (!current || current.kind !== recorded.kind) return false;\n  if (recorded.kind === 'linux_proc_starttime') return recorded.starttime === current.starttime;\n  if (recorded.kind === 'macos_lstart_command') return recorded.lstart === current.lstart && recorded.command === current.command;\n  return false;\n}";

export const MUTATIONS = [
  // ── P: the runner ──────────────────────────────────────────────────────
  {
    id: 'P1', file: RUNNER, tests: [T_SNAP],
    from: '    const peerCwd = snapshot?.peer_cwd ?? options.cwd;',
    to: '    const peerCwd = options.cwd;',
    why: 'the companion is handed the live checkout as its --cwd',
    killed_by: /the vandal peer tidies only the snapshot; its paths and prompt name the snapshot/,
  },
  {
    id: 'P2', file: RUNNER, tests: [T_SNAP],
    from: '      companionPromptFile = copy.path;\n',
    to: '',
    why: "the companion reads the caller's prompt, whose absolute paths name the live checkout",
    killed_by: /the vandal peer tidies only the snapshot; its paths and prompt name the snapshot/,
  },
  {
    id: 'P3', file: RUNNER, tests: [T_SNAP],
    from: "    if (options.peer === 'codex') options.env = scrubGitSelectors(options.env);",
    to: '    if (snapshot) options.env = scrubGitSelectors(options.env);',
    why: 'a codex peer outside a checkout inherits a GIT_DIR naming the live repository',
    killed_by: /a codex peer outside any checkout still gets no git selector naming the live repository/,
  },
  {
    id: 'P4', file: RUNNER, tests: [T_SNAP],
    from: '      const removed = await removePeerSnapshot(snapshot, { env: options.env });',
    to: '      const removed = { removed: false, error: null };',
    why: 'the snapshot outlives the run that made it',
    killed_by: /a failed peer run removes its snapshot too/,
  },
  {
    id: 'P5', file: RUNNER, tests: [T_SNAP],
    from: '    return { failed };\n  }\n  if (snapshot.isolation',
    to: '    return { snapshot: null };\n  }\n  if (snapshot.isolation',
    why: 'a snapshot that cannot be made runs the peer in the live tree instead',
    killed_by: /a snapshot that cannot be made fails the run before any companion runs \(snapshot_failed\)/,
  },
  {
    id: 'P6', file: RUNNER, tests: [T_SNAP],
    from: "      if (isTerminalStatus(h.status) && h.status !== 'cancelled' && (cancellation?.signal || before === 'cancel_requested' || before === 'cancelled')) {",
    to: '      if (false) {',
    why: 'a cancellation decided outside the serialized terminal write is overwritten by the status computed from an earlier read',
    killed_by: /a cancellation that comes after the run read its handle and before the terminal write still ends it cancelled/,
  },
  {
    id: 'P7', file: RUNNER, tests: [T_SNAP],
    from: " || before === 'cancel_requested' || before === 'cancelled')) {",
    to: " || before === 'cancel_requested')) {",
    why: "a cancel's `cancelled` record landing before the terminal write is replaced by the peer's own end",
    killed_by: /a cancel whose cancelled record lands between the run's last read and its terminal write keeps the run cancelled/,
  },
  {
    id: 'P8', file: RUNNER, tests: [T_SNAP],
    from: '  const next = await mutator(handle) ?? handle;\n  hook?.(next, before);\n  next.updated_at = new Date().toISOString();\n  return await writeHandle(handlePath, next, { guard }) ? next : null;',
    to: '  const next = await mutator(handle) ?? handle;\n  next.updated_at = new Date().toISOString();\n  if (!await writeHandle(handlePath, next, { guard })) return null;\n  hook?.(next, before);\n  return next;',
    why: 'process control is armed only when the ledger takes the write that records the running peer',
    killed_by: /a cancellation still reaches the peer when the ledger refuses the write that records it running/,
  },
  {
    id: 'P9', file: RUNNER, tests: [T_SNAP],
    from: '    retireCancel?.();\n    handleHooks.delete(paths.handle);',
    to: '    handleHooks.delete(paths.handle);',
    why: "a cancellation after the run ended signals the ended peer's pid, which may be another process's",
    killed_by: /a cancellation requested after the run ended signals nothing of its peer/,
  },
  {
    id: 'P10', file: RUNNER, tests: [T_SNAP],
    from: '      if (Number.isInteger(peerProcess.pgid)) {\n        let goneSince = null;',
    to: '      if (false) {\n        let goneSince = null;',
    why: "a child holding the companion's pipes holds the run open",
    killed_by: /a child holding the companion's stdout open does not hold the run/,
  },
  {
    id: 'P11', file: RUNNER, tests: [T_SNAP],
    from: '      for (const [sig, fn] of handlers) process.on(sig, fn);',
    to: '      void handlers;',
    why: 'a signal to the CLI kills the runner before it stops the peer and removes the snapshot',
    killed_by: /the CLI ends on SIGTERM \(repeated\) with 143/,
  },
  {
    id: 'P12', file: RUNNER, tests: [T_SNAP],
    from: 'env: options.env, signal: abort.signal });',
    to: 'env: options.env });',
    why: 'a cancellation does not stop a capture under way',
    killed_by: /a cancellation requested before the spawn ends the run cancelled — the capture itself stopped/,
  },
  {
    id: 'P13', file: RUNNER, tests: [T_SNAP],
    from: "  if (['queued', 'spawning', 'running', 'cancel_requested'].includes(handle.status)) {",
    to: "  if (['spawning', 'running', 'cancel_requested'].includes(handle.status)) {",
    why: 'a runner killed during the capture leaves a queued ledger no sweep ever ends',
    killed_by: /a queued ledger older than the stale grace is orphaned/,
  },
  {
    id: 'P14', file: RUNNER, tests: [T_SNAP],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, {
        file: RUNNER,
        from: '  const snapshots = await reclaimPeerSnapshots({ cwd: repoRoot }).catch(',
        to: '  const snapshots = () => reclaimPeerSnapshots({ cwd: repoRoot }).catch(',
      });
      tools.applyEdit(copy, { file: RUNNER, from: '  merged.snapshots = snapshots;', to: '  merged.snapshots = await snapshots();' });
    },
    why: 'the sweep reclaims snapshots after its ledger scan, so a scan that refuses keeps them',
    killed_by: /a sweep that refuses its ledger scan \(two homes holding ledgers\) still reclaims the abandoned snapshots first/,
  },
  {
    id: 'P15', file: RUNNER, tests: [T_SNAP],
    from: "        if (!['queued', 'spawning', 'running', 'cancel_requested'].includes(h.status)) return h;\n        h.status = 'orphaned';",
    to: "        if (!['spawning', 'running', 'cancel_requested'].includes(h.status)) return h;\n        h.status = 'orphaned';",
    why: "the orphan write skips a queued ledger the staleness rule judged abandoned",
    killed_by: /a queued ledger older than the stale grace is orphaned/,
  },
  // ── D: the dispatcher ──────────────────────────────────────────────────
  {
    id: 'D1', file: DISPATCH, tests: [T_SNAP],
    from: "    if (peer === 'codex') {\n      const base = cwd ?? process.cwd();",
    to: "    if (false) {\n      const base = cwd ?? process.cwd();",
    why: 'a codex peer is dispatched in the live checkout',
    killed_by: /the vandal peer tidies only the snapshot, which is removed when the dispatch ends/,
  },
  {
    id: 'D2', file: DISPATCH, tests: [T_SNAP],
    from: '      spawnEnv = scrubGitSelectors(env);\n',
    to: '',
    why: 'a codex peer inherits a GIT_DIR naming the live repository',
    killed_by: /a codex peer outside any checkout gets no git selector naming the live repository/,
  },
  {
    id: 'D3', file: DISPATCH, tests: [T_SNAP],
    from: "    const detached = process.platform !== 'win32';",
    to: '    const detached = false;',
    why: "the companion shares the wrapper's process group, so what it leaves holding its pipes is never stopped",
    killed_by: /a child holding the companion's pipes is stopped once the companion exits, and the dispatch ends/,
  },
  {
    id: 'D4', file: DISPATCH, tests: [T_SNAP],
    from: '  for (const sig of DISPATCH_SIGNALS) process.on(sig, () => cancellation.request(sig));',
    to: '',
    why: 'a signal to the CLI kills it before it stops the peer and removes the snapshot',
    killed_by: /SIGTERM stops the peer group, removes the snapshot and exits 143/,
  },
  {
    id: 'D5', file: DISPATCH, tests: [T_SNAP],
    from: '      if (!detached) return;\n      lingerTimer',
    to: '      return;\n      lingerTimer',
    why: "a child holding the companion's pipes holds the dispatch open",
    killed_by: /a child holding the companion's pipes is stopped once the companion exits, and the dispatch ends/,
  },
  {
    id: 'D6', file: DISPATCH, tests: [T_SNAP],
    from: "          kind: 'snapshot_failed',",
    to: "          kind: 'peer_cli_not_found',",
    why: 'a snapshot that cannot be made reads as a missing companion',
    killed_by: /a snapshot that cannot be made: companion_error \/ snapshot_failed/,
  },
  // ── O: the orchestrator's order — resolve before record ─────────────────
  {
    id: 'O1', file: RUNNER, tests: [T_SNAP],
    from: '  const companion = await resolveCompanion(options.peer, { env: options.env });',
    to: "  await reclaimPeerSnapshots({ cwd: options.cwd, env: options.env }).catch(() => {});\n  const companion = await resolveCompanion(options.peer, { env: options.env });",
    why: 'the runner reclaims snapshots before it knows a companion exists',
    killed_by: /peer-runner: a missing companion leaves no ledger, no pending row and no snapshot, and reclaims none/,
  },
  {
    id: 'O2', file: DISPATCH, tests: [T_SNAP],
    from: '  const companion = await resolveCompanion(peer, { env, home, selfPath });',
    to: '  await reclaimPeerSnapshots({ cwd: cwd ?? process.cwd(), env }).catch(() => {});\n  const companion = await resolveCompanion(peer, { env, home, selfPath });',
    why: 'the dispatcher reclaims snapshots before it knows a companion exists',
    killed_by: /dispatch-peer: a missing companion is LOCAL-ONLY, with no pending row, no snapshot and no reclaim/,
  },
  {
    id: 'O3', file: DISPATCH, tests: [T_SNAP],
    from: '  const companion = await resolveCompanion(peer, { env, home, selfPath });',
    to: "  if (peer === 'codex') await createPeerSnapshot({ cwd: cwd ?? process.cwd(), persona: 'orchestrator', env }).catch(() => {});\n  const companion = await resolveCompanion(peer, { env, home, selfPath });",
    why: 'the dispatcher makes a snapshot before it knows a companion exists, and a missing one leaves it behind',
    killed_by: /dispatch-peer: a missing companion is LOCAL-ONLY, with no pending row, no snapshot and no reclaim/,
  },
  {
    id: 'O4', file: RUNNER, tests: [T_SNAP],
    from: '  const companion = await resolveCompanion(options.peer, { env: options.env });',
    to: "  if (options.peer === 'codex') await createPeerSnapshot({ cwd: options.cwd, runId, persona: 'orchestrator', env: options.env }).catch(() => {});\n  const companion = await resolveCompanion(options.peer, { env: options.env });",
    why: 'the runner makes a snapshot before it knows a companion exists, and a missing one leaves it behind',
    killed_by: /peer-runner: a missing companion leaves no ledger, no pending row and no snapshot, and reclaims none/,
  },
  // ── L: the library copies ──────────────────────────────────────────────
  {
    id: 'L1', file: SNAPSHOT_LIB, tests: [T_PARITY],
    from: "export const SNAPSHOT_EXCLUDED_PATHSPECS = ['.agentic-plugins/state', ':(glob).claude/agentic-*/**'];",
    to: "export const SNAPSHOT_EXCLUDED_PATHSPECS = ['.agentic-plugins/state'];",
    why: "the orchestrator's copy drifts from the shared source, so its snapshots differ from the personas'",
    killed_by: /plugins\/orchestrator\/scripts\/lib\/peer-snapshot\.mjs is its notice, then the source byte for byte/,
  },
  {
    id: 'L2', tests: [T_PARITY],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, { file: LOCKS, from: "import { fingerprintsMatch, isProcessAlive } from './process-identity.mjs';", to: "import { isProcessAlive } from './process-identity.mjs';" });
      tools.applyEdit(copy, { file: LOCKS, from: 'export { fingerprintsMatch, isProcessAlive };', to: L2_LOCAL });
    },
    why: 'the run locks keep a definition of their own, which a later change to the shared rule would leave behind',
    killed_by: /the run locks and the runner judge a process by the copy's one definition/,
  },
  // ── H: a run its host killed before its cleanup (C142) ─────────────────
  {
    id: 'H1', file: RUNNER, tests: [T_SNAP],
    from: "    if (verified.reason === 'not_running' && snapshotOwnerPath(handle) !== null) return finishHostKilledRun(paths, handle, graceMs);\n",
    to: '',
    why: "the orchestrator's cancel answers not_running for a run its host killed: the run stays live and its snapshot stays",
    killed_by: /the host leaves the snapshot and a cancel_requested handle; cancel finishes the run cancelled/,
  },
  {
    id: 'H2', file: RUNNER, tests: [T_SNAP],
    from: "      ...(await snapshotCleanupField(paths, handle, run)),\n    };\n  }\n  if (handle.status !== 'running' && handle.status !== 'cancel_requested') {",
    to: "    };\n  }\n  if (handle.status !== 'running' && handle.status !== 'cancel_requested') {",
    why: "a runner killed inside its cleanup leaves its snapshot, which the orchestrator's cancel of the ended run never removes",
    killed_by: /a runner killed inside its cleanup \(terminal, its snapshot not removed\)/,
  },
  {
    id: 'H3', file: RUNNER, tests: [T_SNAP],
    from: "    const left = await stopHandleGroup(handle, graceMs, 'snapshot-gone');\n    if (left !== null) return refused(left.reason, left.why);\n",
    to: '',
    why: "the orchestrator's cancel takes a snapshot a reclaim removed on age alone for the end of its run while a process of its companion's group still runs",
    killed_by: /a snapshot a reclaim removed on age alone is no proof its peer stopped/,
  },
  {
    id: 'H4', file: RUNNER, tests: [T_SNAP],
    from: "    if (removed.refused) return { snapshot_cleanup: { removed: false, skipped: removed.refused, error: null } };\n",
    to: '',
    why: "the orchestrator's cancel reports and records a removal refused for a record that names another snapshot as no refusal",
    killed_by: /an owner record naming another worktree than the tree its handle recorded removes nothing/,
  },
  {
    id: 'H5', file: RUNNER, tests: [T_SNAP],
    from: "      const left = await stopHandleGroup(handle, graceMs, 'owner-unreadable');\n      if (left !== null) return { ok: false, run_id: runId, status: handle.status, ...left };\n",
    to: '',
    why: "the orchestrator's cancel answers already_terminal for a run whose snapshot a reclaim removed while a process of its companion's group still runs",
    killed_by: /a terminal run whose snapshot a reclaim removed on age alone/,
  },
  {
    id: 'H6', file: RUNNER, tests: [T_SNAP],
    from: "  if (leader !== 'gone' && leader !== 'match') return { reason: 'supervisor_unknown', why: `${why}-group-leader-${leader}` };\n",
    to: '',
    why: "the orchestrator's cancel signals the group a handle names although the handle's own process is now another's, or cannot be told",
    killed_by: /a group its handle names is signalled only while the handle's own process, its leader, is gone or still the one recorded/,
  },
  {
    id: 'H7', file: RUNNER, tests: [T_SNAP],
    from: "      run = { ...run, judged: { verdict: 'ended', why: 'snapshot-gone', supervisor: null, companion: null }, gone: true };\n",
    to: '',
    why: "the orchestrator's cancel never records a terminal run's gone snapshot, so every later cancel signals the group its handle names again",
    killed_by: [/a group its handle names is signalled only while the handle's own process/, /a terminal run whose snapshot a reclaim removed on age alone/],
  },
  {
    id: 'H8', file: SNAPSHOT_LIB, tests: [T_SNAP],
    from: "  if (companion === 'alive' && companionIdentity === 'unknown') return judged('unknown', 'companion-unknown');\n",
    to: '',
    why: "the orchestrator's cancel stops a live group under a companion pid whose process cannot be told, and removes the snapshot",
    killed_by: /while its supervisor lives or cannot be told, or its companion cannot be, cancel writes and removes nothing/,
  },
  {
    id: 'H9', file: SNAPSHOT_LIB, tests: [T_SNAP],
    from: " || typeof owner.tree !== 'string' || companionIncomplete || handleDisagrees || supervisorDisagrees) {",
    to: " || typeof owner.tree !== 'string' || handleDisagrees || supervisorDisagrees) {",
    why: "the orchestrator's cancel reads a companion named without its group as one whose group ended, and removes the snapshot",
    killed_by: /while its supervisor lives or cannot be told, or its companion cannot be, cancel writes and removes nothing/,
  },
  {
    id: 'H10', file: SNAPSHOT_LIB, tests: [T_SNAP],
    from: " || !id(named.pid) || named.pgid !== named.pid);",
    to: " || !id(named.pid) || !id(named.pgid));",
    why: "the orchestrator's cancel stops a group an owner record's companion does not lead, another process's, and removes the snapshot",
    killed_by: /while its supervisor lives or cannot be told, or its companion cannot be, cancel writes and removes nothing/,
  },
  {
    id: 'H11', file: SNAPSHOT_LIB, tests: [T_SNAP],
    from: "  if (supervisor === 'unknown' || supervisor === 'differ') return judged('unknown', 'supervisor-unknown');",
    to: "  if (supervisor === 'unknown') return judged('unknown', 'supervisor-unknown');",
    why: "the orchestrator's cancel judges a live supervisor whose fingerprint reads `differ` gone: it answers ok, ends the run and removes its snapshot instead of refusing `supervisor_unknown`",
    killed_by: /while its supervisor lives or cannot be told, or its companion cannot be, cancel writes and removes nothing/,
  },
  {
    id: 'H12', file: RUNNER, tests: [T_SNAP],
    from: "const supervisorGone = (judged) => judged.supervisor === 'gone';",
    to: "const supervisorGone = (judged) => judged.supervisor === 'gone' || judged.supervisor === 'differ';",
    why: "the orchestrator's cancel stops a companion's group left under a supervisor that only reads `differ`: its why turns from `companion-alive` to `supervisor-unknown` and the group is signalled",
    killed_by: /while its supervisor lives or cannot be told, or its companion cannot be, cancel writes and removes nothing/,
  },
  {
    id: 'H13', file: RUNNER, tests: [T_SNAP],
    from: "    if (run.judged.why === 'owner-unreadable' && await snapshotGone(handle, run.ownerPath)) {\n      // The supervisor the handle keeps must be gone too",
    to: "    if (run.judged.why === 'owner-unreadable') {\n      await stopHandleGroup(handle, graceMs, 'owner-unreadable');\n      if (!(await snapshotGone(handle, run.ownerPath))) return { ok: true, run_id: runId, status: handle.status, reason: 'already_terminal', ...(await snapshotCleanupField(paths, handle, run)) };\n      // The supervisor the handle keeps must be gone too",
    why: "the orchestrator's cancel stops the group a terminal handle names while the run's owner record exists but cannot be read, its supervisor not proven gone; the answer and the kept snapshot read as before",
    killed_by: /a terminal run whose owner record still exists but cannot be read/,
  },
  {
    id: 'H14', file: SNAPSHOT_LIB, tests: [T_SNAP],
    from: " || typeof owner.tree !== 'string' || companionIncomplete || handleDisagrees || supervisorDisagrees) {",
    to: " || typeof owner.tree !== 'string' || companionIncomplete || supervisorDisagrees) {",
    why: "the orchestrator's cancel reads an owner record that omits the companion its handle names as `ended`, and one naming another companion has that group stopped as the run's",
    killed_by: /while its supervisor lives or cannot be told, or its companion cannot be, cancel writes and removes nothing/,
  },
  {
    id: 'H15', file: RUNNER, tests: [T_SNAP],
    from: '  let run = await judgeRunEnded(ownerPath, { runId: handle.run_id, handle });\n',
    to: '  let run = await judgeRunEnded(ownerPath, { runId: handle.run_id });\n',
    why: "the orchestrator's cancel judges a host-killed run's owner record without its handle: a record that omits or replaces the companion is taken at its word",
    killed_by: /while its supervisor lives or cannot be told, or its companion cannot be, cancel writes and removes nothing/,
  },
  {
    id: 'H16', file: SNAPSHOT_LIB, tests: [T_SNAP],
    from: 'const isRunPid = (n) => Number.isInteger(n) && n > 1 && n <= PID_MAX;',
    to: 'const isRunPid = (n) => Number.isInteger(n) && n > 1;',
    why: "the orchestrator's cancel takes a supervisor pid past the range a pid takes for a process it can judge, and no longer refuses it `owner-incomplete`",
    killed_by: /while its supervisor lives or cannot be told, or its companion cannot be, cancel writes and removes nothing/,
  },
  {
    id: 'H17', file: RUNNER, tests: [T_SNAP],
    from: '        h.peer_process = { pid: child.pid, pgid: h.pgid };\n',
    to: '',
    why: "the orchestrator's handle keeps no peer process past an orphan write: a terminal cancel judges a record that omits the companion alone, reads `ended`, and removes the snapshot while a child of the companion's group runs",
    killed_by: /a terminal run whose owner record names no companion is judged against the peer process its handle keeps/,
  },
  {
    id: 'H18', file: SNAPSHOT_LIB, tests: [T_SNAP],
    from: "  if (companion === 'alive' && companionIdentity === 'gone' && (await groupTiedToTree(named.pgid, tree ?? owner.tree, { clock: owner.supervisor.fingerprint?.clock })) !== 'tied') return judged('unknown', 'companion-untied');\n",
    to: '',
    why: "the orchestrator's cancel takes a live group whose leader is gone for the run's by its id alone, and stops a group another process started under it (C142 K-F1)",
    killed_by: /while its supervisor lives or cannot be told, or its companion cannot be, cancel writes and removes nothing/,
  },
  {
    id: 'H19', file: RUNNER, tests: [T_SNAP],
    from: "    if (tie !== 'tied') return { reason: 'supervisor_unknown', why: `${why}-group-${tie}` };\n",
    to: '',
    why: "the orchestrator's cancel stops the group a handle names, its leader gone, by its id alone once a reclaim removed the snapshot (C142 K-F1)",
    killed_by: /a group its handle names is signalled only while the handle's own process, its leader, is gone or still the one recorded/,
  },
  {
    id: 'H20', file: RUNNER, tests: [T_SNAP],
    from: '  const pgid = proc?.pgid ?? null;\n  if (!isGroupAlive(pgid)) return null;',
    to: '  const pgid = handle.pgid ?? null;\n  if (!isGroupAlive(pgid)) return null;',
    why: "the orchestrator's terminal cancel reads the group from `pgid` alone, which an orphan write clears: it answers ok while the run's group runs (C142 K-F2)",
    killed_by: [/a terminal run whose handle's pid and pgid a later write cleared/, /a group its handle names is signalled only while the handle's own process/],
  },
  {
    id: 'H21', file: RUNNER, tests: [T_SNAP],
    from: "  if (proc?.malformed) return { ok: false, run_id: runId, status: handle.status, reason: 'unsupported_unverifiable', why: 'handle-malformed' };\n",
    to: '',
    why: "the orchestrator's cancel of a live run whose handle names a group its process does not lead signals the peer instead of refusing the handle",
    killed_by: /a cancel of a live run whose handle names a group its process does not lead signals nothing/,
  },
  {
    id: 'H22', file: RUNNER, tests: [T_SNAP],
    from: "  if (proc?.malformed) return { reason: 'supervisor_unknown', why: `${why}-handle-malformed` };\n",
    to: '',
    why: "the orchestrator's terminal cancel reads a handle whose process fields the runner did not write as naming no group, and finishes while the run's group may run",
    killed_by: /a group its handle names is signalled only while the handle's own process/,
  },
  {
    id: 'H23', file: RUNNER, tests: [T_SNAP],
    from: "    if (supervisor !== 'gone' && supervisor !== 'unrecorded') return refused(supervisor === 'match' ? 'supervisor_alive' : 'supervisor_unknown', `snapshot-gone-supervisor-${supervisor}`);\n",
    to: '',
    why: "the orchestrator's cancel finishes a stale run whose snapshot a reclaim removed while the supervisor its handle keeps cannot be told (refine-verify F2)",
    killed_by: /a snapshot a reclaim removed is no proof its supervisor is gone/,
  },
  {
    id: 'H24', file: SNAPSHOT_LIB, tests: [T_SNAP],
    from: "  if (companion === 'alive' && companionIdentity === 'unknown') return judged('unknown', 'companion-unknown');\n",
    to: '',
    why: "the orchestrator's terminal cancel stops a live group under a companion pid whose process cannot be told, though the record and handle agree on it, and removes the snapshot (C142 K-F3)",
    killed_by: /a terminal run whose owner record and handle agree on a live group that cannot be told/,
  },
  {
    id: 'H25', file: SNAPSHOT_LIB, tests: [T_SNAP],
    from: "  if (occupancy !== 'none') return judged('unknown', `tree-${occupancy}`);\n",
    to: '',
    why: "the orchestrator's copy judges a run over while a process of another group runs in its tree, and its cancel removes the worktree under it (C142 M-F1)",
    killed_by: /while its supervisor lives or cannot be told, or its companion cannot be, cancel writes and removes nothing/,
  },
  {
    id: 'H26', file: SNAPSHOT_LIB, tests: [T_SNAP],
    from: "  if (occupancy !== 'none') return old(Date.parse(owner.created_at)) ? { verdict: 'reclaim', why: `tree-${occupancy}-expired` } : { verdict: 'keep', why: `tree-${occupancy}` };\n",
    to: '',
    why: "the orchestrator's reclaim removes a snapshot whose owners are gone while a process still runs in its tree (C142 M-F1)",
    killed_by: /a process the companion left in a group of its own runs on in the tree/,
  },
  {
    id: 'H27', file: RUNNER, tests: [T_SNAP],
    from: "    if (occupancy !== 'none') return refused('supervisor_unknown', `snapshot-gone-tree-${occupancy}`);\n",
    to: '',
    why: "the orchestrator's cancel finishes a stale run whose snapshot a reclaim removed while a process runs on in the removed tree (C142 M-F1)",
    killed_by: /a process the companion left in a group of its own runs on in the tree/,
  },
  {
    id: 'H28', file: RUNNER, tests: [T_SNAP],
    from: "      if (occupancy !== 'none') {\n        return { ok: true, run_id: runId, status: handle.status, reason: 'already_terminal', snapshot_cleanup: { removed: false, skipped: `tree-${occupancy}`, error: null } };\n      }\n",
    to: '',
    why: "the orchestrator's terminal cancel records a removal while a process runs on in the removed tree (C142 M-F1)",
    killed_by: /a process the companion left in a group of its own runs on in the tree/,
  },
  {
    id: 'H29', file: SNAPSHOT_LIB, tests: [T_SNAP],
    from: '  const supervisorDisagrees = kept !== null && !sameSupervisor(owner.supervisor, kept);',
    to: '  const supervisorDisagrees = false;',
    why: "the orchestrator's copy lets an owner record naming an exited supervisor override the live one the handle keeps (C142 M-F2)",
    killed_by: /while its supervisor lives or cannot be told, or its companion cannot be, cancel writes and removes nothing/,
  },
  {
    id: 'H30', file: SNAPSHOT_LIB, tests: [T_SNAP],
    from: "  return typeof hook === 'function' ? hook(() => allProcessCwds(options)) : allProcessCwds(options);",
    to: '  return allProcessCwds();',
    why: "the orchestrator's copy ignores the listing a test installs and reads the system's alone, so its runner cases hang on what else runs on the machine (C142 O-F2)",
    killed_by: /cancel judges the listing the suite preloads into it/,
  },
  {
    id: 'H31', file: 'tests/persona-pipeline/_peer-snapshot-fixtures.mjs', tests: [T_SNAP],
    from: 'export const cleanEnv = (extra = {}) => withListing({',
    to: 'export const cleanEnv = (extra = {}) => ({',
    why: "the orchestrator's runners a case starts are not given the suites' listing (C142 O-F2)",
    killed_by: /cancel judges the listing the suite preloads into it/,
  },
  {
    id: 'H32', file: SNAPSHOT_LIB, tests: [T_SNAP],
    from: "  return typeof hook === 'function' ? hook(() => allProcessCwds(options)) : allProcessCwds(options);",
    to: "  return typeof hook === 'function' ? hook(() => allProcessCwds(options)) : Promise.resolve([]);",
    why: "the orchestrator's copy, with no hook installed as in production, names no process: its cancel removes a tree under a live process while the suites stay green (C142 P-F2)",
    killed_by: /cancel judges the listing the suite preloads into it/,
  },
  {
    id: 'H33', file: RUNNER, tests: [T_SNAP],
    from: ', { clock: handleSupervisor(handle)?.fingerprint?.clock });',
    to: ');',
    why: "the orchestrator's hand-kept cancel of a run whose snapshot a reclaim removed reads the handle's group with no clock, so on Linux a group of the run's id in another pid namespace than its supervisor's is tied and signalled (C142 U-F1; the fifteenth review's V-F1)",
    killed_by: /on Linux, cancel signals no group listed in another pid namespace/,
  },
  // The persona spec's runner cases whose edit applies to this hand-kept
  // runner, each the same edit here, killed by an orchestrator case
  // (the sixteenth review's W-F1;
  // tests/scripts/test-orchestrator-peer-snapshot-parity.mjs holds the list
  // complete).
  {
    id: 'H34', file: RUNNER, tests: [T_SNAP],
    from: "    if (options.peer === 'codex') options.env = scrubGitSelectors(options.env);\n",
    to: '',
    why: "the orchestrator's companion inherits the caller's git selectors, which send its git commands to the live tree (persona P2)",
    killed_by: /the vandal peer tidies only the snapshot; its paths and prompt name the snapshot/,
  },
  {
    id: 'H35', file: RUNNER, tests: [T_SNAP],
    from: '    await stopProcessGroup(peerProcess?.pgid, graceMs);\n    if (snapshot) {',
    to: '    if (snapshot) {\n      await stopProcessGroup(peerProcess?.pgid, graceMs);',
    why: "an orchestrator peer with no snapshot (a claude peer) leaves its children running after the run (persona P10)",
    killed_by: /a claude peer's leftover child is stopped too/,
  },
  {
    id: 'H36', file: RUNNER, tests: [T_SNAP],
    from: "      if (isTerminalStatus(h.status)) return h;\n      h.status = 'failed';\n      h.completed_at = nowIso();\n      h.exit_code = null;\n      h.error_kind = err?.code ?? 'runner_error';",
    to: '      return h;',
    why: "an orchestrator run that throws once its snapshot exists leaves its ledger queued or spawning, read as live (persona P14)",
    killed_by: /a run that throws once its snapshot exists \(an unreadable prompt\) ends failed/,
  },
  {
    id: 'H37', file: RUNNER, tests: [T_SNAP],
    from: " || before === 'cancel_requested' || before === 'cancelled')) {",
    to: " || before === 'cancelled')) {",
    why: "an orchestrator cancel requested after the run read its handle is overwritten by the terminal write's completed (persona P20)",
    killed_by: /a cancel whose cancel_requested record lands between the run's last read and its terminal write keeps the run cancelled/,
  },
  {
    id: 'H38', file: RUNNER, tests: [T_SNAP],
    from: '  if (!isTerminalStatus(final.status)) {\n    final = await updateHandle(paths.handle, (h) => {',
    to: '  if (false) {\n    final = await updateHandle(paths.handle, (h) => {',
    why: "the orchestrator's cancel removes the snapshot of a run proven over but leaves the run live in its ledger (persona H2)",
    killed_by: /the host leaves the snapshot and a cancel_requested handle; cancel finishes the run cancelled/,
  },
  {
    id: 'H39', file: RUNNER, tests: [T_SNAP],
    from: '    const removed = gone ? { removed: true, error: null } : await removeOwnedSnapshot(ownerPath, owner, { root: handle.snapshot.root ?? null });',
    to: '    const removed = { removed: false, error: null };',
    why: "an orchestrator run proven over is finished, and its own snapshot is left (persona H3)",
    killed_by: /the host leaves the snapshot and a cancel_requested handle; cancel finishes the run cancelled/,
  },
  {
    id: 'H40', file: RUNNER, tests: [T_SNAP],
    from: '  if (await exists(paths.envelope)) final = await reconcileOne(paths, handle, { staleGraceMs: DEFAULT_STALE_GRACE_MS, now: new Date() });',
    to: '  if (false) final = await reconcileOne(paths, handle, { staleGraceMs: DEFAULT_STALE_GRACE_MS, now: new Date() });',
    why: "the answer a killed orchestrator runner wrote is recorded cancelled (persona H5)",
    killed_by: /cancel records the answer the runner wrote before it was killed, never cancelled/,
  },
  {
    id: 'H41', file: RUNNER, tests: [T_SNAP],
    from: '    await stopProcessGroup(run.owner?.companion?.pgid, graceMs);\n',
    to: '',
    why: "an orchestrator companion group outliving its dead supervisor is left running, and the run with it (persona H7; the sixteenth review's X7)",
    killed_by: /a dead supervisor is no proof its peer stopped/,
  },
  {
    id: 'H42', file: RUNNER, tests: [T_SNAP],
    from: '  await stopProcessGroup(peerGroup, graceMs);\n',
    to: '',
    why: "an orchestrator cancel of a live run answers while a child its peer left runs on in the group (persona H10; the sixteenth review's X6)",
    killed_by: /a cancel of a live run ends only once the companion's whole group is gone/,
  },
  {
    id: 'H43', file: RUNNER, tests: [T_SNAP],
    from: '    let run = await judgeHostKilledRun(handle, graceMs);\n    if (refusalReason',
    to: '    let run = await judgeRunEnded(snapshotOwnerPath(handle), { runId: handle.run_id });\n    if (refusalReason',
    why: "an orchestrator terminal run whose dead runner left a process of its peer's group is judged without it (persona H14)",
    killed_by: /a runner killed inside its own end that leaves a process of its peer's group/,
  },
  {
    id: 'H50', file: RUNNER, tests: [T_SNAP],
    from: '    let run = await judgeHostKilledRun(handle, graceMs);\n    if (refusalReason',
    to: '    let run = { ...(await judgeRunEnded(snapshotOwnerPath(handle), { runId: handle.run_id, handle })), ownerPath: snapshotOwnerPath(handle) };\n    if (refusalReason',
    why: "an orchestrator terminal run whose dead runner left a process of its peer's group is judged with its handle, but that group is never stopped (persona H130)",
    killed_by: /a runner killed inside its own end that leaves a process of its peer's group/,
  },
  {
    id: 'H51', file: RUNNER, tests: [T_SNAP],
    from: "      if (supervisor !== 'gone' && supervisor !== 'unrecorded') {\n        return { ok: true, run_id: runId, status: handle.status, reason: 'already_terminal', snapshot_cleanup: { removed: false, skipped: `supervisor-${supervisor}`, error: null } };\n      }\n      const left = await stopHandleGroup(handle, graceMs, 'owner-unreadable');\n",
    to: "      const left = await stopHandleGroup(handle, graceMs, 'owner-unreadable');\n      if (supervisor !== 'gone' && supervisor !== 'unrecorded') {\n        return { ok: true, run_id: runId, status: handle.status, reason: 'already_terminal', snapshot_cleanup: { removed: false, skipped: `supervisor-${supervisor}`, error: null } };\n      }\n",
    why: "an orchestrator terminal run whose snapshot a reclaim removed has its group signalled before the refusal its untold supervisor earns (persona H131)",
    killed_by: /a terminal run whose snapshot a reclaim removed on age alone/,
  },
  {
    id: 'H44', file: RUNNER, tests: [T_SNAP],
    from: "  if (run.judged.why === 'owner-unreadable' && await snapshotGoneAndStale(handle, run.ownerPath)) {",
    to: '  if (false) {',
    why: "an orchestrator run whose snapshot a reclaim removed can never be cancelled: the dead-run cleanup halts on it for good (persona H15)",
    killed_by: /a snapshot a reclaim removed leaves no owner record/,
  },
  {
    id: 'H45', file: RUNNER, tests: [T_SNAP],
    from: '  if (!Number.isFinite(updated) || Date.now() - updated <= DEFAULT_STALE_GRACE_MS) return false;',
    to: '  if (!Number.isFinite(updated)) return false;',
    why: "an orchestrator run whose handle moved within the stale grace is finished cancelled under its runner once a reclaim has removed its snapshot (persona H16)",
    killed_by: /a snapshot a reclaim removed leaves no owner record/,
  },
  {
    id: 'H46', file: RUNNER, tests: [T_SNAP],
    from: 'await snapshotGoneAndStale(handle, run.ownerPath)',
    to: 'await snapshotGone(handle, run.ownerPath)',
    why: "the orchestrator's live cancel takes a snapshot a reclaim removed as gone before the stale grace (the sixteenth review's X4)",
    killed_by: /a snapshot a reclaim removed leaves no owner record/,
  },
  {
    id: 'H47', file: RUNNER, tests: [T_SNAP],
    from: '  await stopProcessGroup(pgid, graceMs);\n  return isGroupAlive(pgid)',
    to: '  return isGroupAlive(pgid)',
    why: "an orchestrator run whose snapshot a reclaim removed is refused group_alive for a group its cancel could have stopped (persona H18)",
    killed_by: [/a snapshot a reclaim removed on age alone is no proof its peer stopped/, /a terminal run whose snapshot a reclaim removed on age alone/],
  },
  {
    id: 'H48', file: RUNNER, tests: [T_SNAP],
    from: "      if (supervisor !== 'gone' && supervisor !== 'unrecorded') {\n        return { ok: true, run_id: runId, status: handle.status, reason: 'already_terminal', snapshot_cleanup: { removed: false, skipped: `supervisor-${supervisor}`, error: null } };\n      }\n",
    to: '',
    why: "an orchestrator terminal run whose snapshot a reclaim removed has its group signalled and its removal recorded while the supervisor its handle keeps cannot be told (persona H53; the sixteenth review's X1)",
    killed_by: /a snapshot a reclaim removed is no proof its supervisor is gone/,
  },
  {
    id: 'H49', file: 'scripts/mutation-specs/peer-snapshot-orchestrator.mjs', tests: [T_PARITY],
    // Split, so the anchor is H48's line alone, never this one.
    from: "    id: 'H48', " + 'file: RUNNER,',
    to: "    id: 'H48', " + 'file: DISPATCH,',
    why: 'a persona runner rule the orchestrator runner shares loses its orchestrator mutation, and nothing names the gap (the sixteenth review\'s W-F1)',
    killed_by: /each persona edit of engineer's peer-runner\.mjs whose text the orchestrator runner holds/,
  },
  {
    id: 'H52', file: RUNNER, tests: [T_SNAP],
    from: "    if (supervisor !== 'gone' && supervisor !== 'unrecorded') return refused(supervisor === 'match' ? 'supervisor_alive' : 'supervisor_unknown', `snapshot-gone-supervisor-${supervisor}`);\n    const left = await stopHandleGroup(handle, graceMs, 'snapshot-gone');\n",
    to: "    const left = await stopHandleGroup(handle, graceMs, 'snapshot-gone');\n    if (supervisor !== 'gone' && supervisor !== 'unrecorded') return refused(supervisor === 'match' ? 'supervisor_alive' : 'supervisor_unknown', `snapshot-gone-supervisor-${supervisor}`);\n",
    why: "an orchestrator run: a live run whose snapshot a reclaim removed has its group stopped before the refusal its supervisor, at work or untold, still earns: the answer is the same, and the group is killed under it (persona H132)",
    killed_by: /signals none of it while the supervisor its handle keeps is at work or cannot be told/,
  },
  {
    id: 'H53', file: RUNNER, tests: [T_SNAP],
    from: "    const supervisor = await handleSupervisorState(handle);\n    if (supervisor !== 'gone' && supervisor !== 'unrecorded') return refused(",
    to: "    const supervisor = await handleSupervisorState(handle);\n    { const g = handlePeerProcess(handle)?.pgid; if (Number.isInteger(g) && g > 1) try { process.kill(-g, 'SIGTERM'); } catch {} }\n    if (supervisor !== 'gone' && supervisor !== 'unrecorded') return refused(",
    why: "an orchestrator run: a live run whose snapshot a reclaim removed has its group sent a SIGTERM before the refusal its supervisor, at work or untold, still earns: the group, deaf to it, survives (persona H133)",
    killed_by: /signals none of it while the supervisor its handle keeps is at work or cannot be told/,
  },
  {
    id: 'H54', file: RUNNER, tests: [T_SNAP],
    from: "      const supervisor = await handleSupervisorState(handle);\n      if (supervisor !== 'gone' && supervisor !== 'unrecorded') {\n",
    to: "      const supervisor = await handleSupervisorState(handle);\n      { const g = handlePeerProcess(handle)?.pgid; if (Number.isInteger(g) && g > 1) try { process.kill(-g, 'SIGTERM'); } catch {} }\n      if (supervisor !== 'gone' && supervisor !== 'unrecorded') {\n",
    why: "an orchestrator run: a terminal run whose snapshot a reclaim removed has its group sent a SIGTERM before the refusal its untold supervisor earns: the group, deaf to it, survives (persona H134)",
    killed_by: /a terminal run whose snapshot a reclaim removed on age alone/,
  },
  {
    id: 'H55', file: RUNNER, tests: [T_SNAP],
    from: "    if (run.judged.why === 'owner-unreadable' && await snapshotGone(handle, run.ownerPath)) {\n",
    to: "    { const g = handlePeerProcess(handle)?.pgid; if (Number.isInteger(g) && g > 1) try { process.kill(-g, 'SIGTERM'); } catch {} }\n    if (run.judged.why === 'owner-unreadable' && await snapshotGone(handle, run.ownerPath)) {\n",
    why: "an orchestrator run: a terminal run has its handle's group sent a SIGTERM before cancel checks that its owner record is gone: under a record that exists but cannot be read, the group, deaf to it, survives (persona H135)",
    killed_by: /owner record still exists but cannot be read/,
  },
  {
    id: 'H56', file: RUNNER, tests: [T_SNAP],
    from: "  if (proc?.malformed) return { ok: false, run_id: runId, status: handle.status, reason: 'unsupported_unverifiable', why: 'handle-malformed' };\n",
    to: "  if (Number.isInteger(handle.pid) && handle.pid > 1) try { process.kill(handle.pid, 'SIGTERM'); } catch {}\n  if (proc?.malformed) return { ok: false, run_id: runId, status: handle.status, reason: 'unsupported_unverifiable', why: 'handle-malformed' };\n",
    why: "an orchestrator run: a live cancel sends its process a SIGTERM before it refuses a handle naming a group that process does not lead: the companion, deaf to it, survives (persona H136)",
    killed_by: /handle names a group its process does not lead/,
  },
  {
    id: 'H57', file: RUNNER, tests: [T_SNAP],
    from: "  if (run.judged.why === 'companion-alive' && supervisorGone(run.judged)) {\n",
    to: "  { const g = run.owner?.companion?.pgid; if (run.judged.why === 'companion-alive' && Number.isInteger(g) && g > 1) try { process.kill(-g, 'SIGTERM'); } catch {} }\n  if (run.judged.why === 'companion-alive' && supervisorGone(run.judged)) {\n",
    why: "an orchestrator run: the host-killed judgment sends a SIGTERM to a companion group left running before it checks that the supervisor is gone (persona H137)",
    killed_by: /while its supervisor lives/,
  },
  {
    id: 'H58', file: RUNNER, tests: [T_SNAP],
    from: "  if (leader !== 'gone' && leader !== 'match') return { reason: 'supervisor_unknown', why: `${why}-group-leader-${leader}` };\n",
    to: "  if (leader !== 'gone' && leader !== 'match') try { process.kill(-pgid, 'SIGTERM'); } catch {}\n  if (leader !== 'gone' && leader !== 'match') return { reason: 'supervisor_unknown', why: `${why}-group-leader-${leader}` };\n",
    why: "an orchestrator run: a handle's group is sent a SIGTERM before the refusal of a leader another process now has, or one that cannot be told (persona H138)",
    killed_by: /a group its handle names is signalled only while/,
  },
  {
    id: 'H59', file: RUNNER, tests: [T_SNAP],
    from: "    if (tie !== 'tied') return { reason: 'supervisor_unknown', why: `${why}-group-${tie}` };\n",
    to: "    if (tie !== 'tied') try { process.kill(-pgid, 'SIGTERM'); } catch {}\n    if (tie !== 'tied') return { reason: 'supervisor_unknown', why: `${why}-group-${tie}` };\n",
    why: "an orchestrator run: a handle's group whose leader is gone is sent a SIGTERM before the refusal of a group nothing ties to the run's tree (persona H139)",
    killed_by: /a group its handle names is signalled only while|pid namespace/,
  },
  {
    id: 'H60', file: RUNNER, tests: [T_SNAP],
    from: "  if (run.judged.why === 'owner-unreadable' && await snapshotGoneAndStale(handle, run.ownerPath)) {\n",
    to: "  { const g = handlePeerProcess(handle)?.pgid; if (Number.isInteger(g) && g > 1) try { process.kill(-g, 'SIGTERM'); } catch {} }\n  if (run.judged.why === 'owner-unreadable' && await snapshotGoneAndStale(handle, run.ownerPath)) {\n",
    why: "an orchestrator run: a live run has its handle's group sent a SIGTERM before cancel checks that its snapshot is gone and its handle stale: under a supervisor at work or untold, the group, deaf to it, survives (persona H140)",
    killed_by: /signals none of it while the supervisor its handle keeps is at work or cannot be told/,
  },
  {
    id: 'H61', file: RUNNER, tests: [T_SNAP],
    from: "  if (run.judged.verdict !== 'ended') return refused(refusalReason(run.judged), run.judged.why);\n",
    to: "  if (run.judged.verdict !== 'ended') { const g = handlePeerProcess(handle)?.pgid; if (Number.isInteger(g) && g > 1) try { process.kill(-g, 'SIGTERM'); } catch {} }\n  if (run.judged.verdict !== 'ended') return refused(refusalReason(run.judged), run.judged.why);\n",
    why: "an orchestrator run: a live run not proven over has its handle's group sent a SIGTERM before it is refused: under a snapshot gone while the handle is fresh, the group, deaf to it, survives (persona H141)",
    killed_by: /signals none of it while the supervisor its handle keeps is at work or cannot be told/,
  },
  {
    id: 'H62', file: RUNNER, tests: [T_SNAP],
    from: "  if (proc?.malformed) return { reason: 'supervisor_unknown', why: `${why}-handle-malformed` };\n",
    to: "  { const g = [handle.pgid, handle.peer_process?.pgid].find((v) => Number.isInteger(v) && v > 1); if (proc?.malformed && g) try { process.kill(-g, 'SIGTERM'); } catch {} }\n  if (proc?.malformed) return { reason: 'supervisor_unknown', why: `${why}-handle-malformed` };\n",
    why: "an orchestrator run: a handle whose process fields the runner did not write has the group it names sent a SIGTERM before stopHandleGroup refuses it (persona H142)",
    killed_by: /a group its handle names is signalled only while/,
  },
  {
    id: 'H63', file: RUNNER, tests: [T_SNAP],
    from: 'fingerprintForPid(handle.pid, { clock: handleSupervisor(handle)?.fingerprint?.clock ?? null });',
    to: 'fingerprintForPid(handle.pid);',
    why: "an orchestrator run: a cancel of a running run verifies its handle's process in the reader's own pid namespace, and another namespace's process under that pid is signalled (persona H148)",
    killed_by: /a live companion read by a reader in another pid namespace than the run's supervisor's clock names/,
  },
  {
    id: 'H64', file: RUNNER, tests: [T_SNAP],
    from: 'identityState({ pid: proc.pid, fingerprint }, { clock: handleSupervisor(handle)?.fingerprint?.clock ?? null });',
    to: 'identityState({ pid: proc.pid, fingerprint });',
    why: "an orchestrator run: stopHandleGroup reads its leader in the reader's own pid namespace, and with the snapshot gone another namespace's process under that pid has its group stopped (persona H149)",
    killed_by: /a live companion read by a reader in another pid namespace than the run's supervisor's clock names/,
  },
];
