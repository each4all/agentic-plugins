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
];
