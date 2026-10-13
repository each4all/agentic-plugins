// Mutation spec — do the C96 peer-snapshot tests catch the defects they exist
// for?
//
// Run: npm run mutate -- scripts/mutation-specs/peer-snapshot.mjs
//
// A codex peer used to run in the live checkout, where it was measured
// reverting uncommitted edits and deleting untracked files. Each defect below
// puts one route back to the live tree — the capture writing the real index,
// the peer handed the checkout, a git selector or a prompt path pointing it
// there — or breaks the lifecycle that removes the snapshot without touching
// a live peer's. The test suite runs the generated copies of every persona, so
// each defect is written into all three copies at once.
//
// Groups: C the capture and materialize, P the runner and dispatcher, R the
// reclaim, S the state guard.

const T_SNAP = 'tests/persona-pipeline/test-peer-snapshot.mjs';

export const TESTS = [T_SNAP];

const PERSONAS = ['designer', 'engineer', 'founder'];
const inEveryCopy = (rel, from, to) => (copy, tools) => {
  for (const persona of PERSONAS) tools.applyEdit(copy, { file: `plugins/${persona}/scripts/${rel}`, from, to });
};
const LIB = 'lib/peer-snapshot.mjs';

export const MUTATIONS = [
  // ── C: capture and materialize ─────────────────────────────────────────
  {
    id: 'C1', tests: [T_SNAP],
    prepare: inEveryCopy(LIB,
      "  await gitOk(top, ['add', '-A'], 'worktree-unreadable', { env, signal, indexFile: worktree });",
      "  await gitOk(top, ['add', '-A'], 'worktree-unreadable', { env, signal });"),
    why: 'the working tree is captured through the live index, which the capture then writes',
    killed_by: /keeps every working-tree and index state, leaves the live index untouched/,
  },
  {
    id: 'C2', tests: [T_SNAP],
    prepare: inEveryCopy(LIB,
      "    await gitOk(tree, ['read-tree', snap.indexTree], 'materialize-failed', { env, signal });\n",
      ''),
    why: 'the snapshot keeps the working tree but loses what was staged: every change reads as staged',
    killed_by: /keeps every working-tree and index state/,
  },
  {
    id: 'C3', tests: [T_SNAP],
    prepare: inEveryCopy(LIB,
      "  return { ...scrubGitSelectors(env), LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };",
      "  return { ...env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };"),
    why: "the caller's GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE point the capture and the materialize at the live tree",
    killed_by: /git selectors in the caller's environment cannot point the capture or the snapshot at the live tree/,
  },
  {
    id: 'C4', tests: [T_SNAP],
    prepare: inEveryCopy(LIB,
      "  await gitOk(top, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...SNAPSHOT_EXCLUDED_PATHSPECS], 'worktree-unreadable', { env, signal, indexFile: worktree });\n",
      ''),
    why: 'a state home .gitignore does not ignore travels into the snapshot, a second copy of every record',
    killed_by: /a live workflow stays writable while a snapshot exists/,
  },
  {
    id: 'C5', tests: [T_SNAP],
    prepare: inEveryCopy(LIB,
      "  const { text: rewritten, count } = rewritePromptPaths(text, toplevelSpellings(snapshot, callerPaths), snapshot.root);",
      '  const rewritten = text;\n  const count = 0;'),
    why: "the prompt's absolute paths still send the peer to the live checkout",
    killed_by: [/the vandal peer tidies only the snapshot; its paths and prompt name the snapshot/, /the vandal peer tidies only the snapshot, which is removed when the dispatch ends/],
  },
  {
    id: 'C6', tests: [T_SNAP],
    prepare: inEveryCopy(LIB,
      '      if (!snap.moved) break;',
      '      break;'),
    why: 'a HEAD that moved during the capture is kept: the index and working tree of one commit over another',
    killed_by: /HEAD moving during the capture is captured again/,
  },
  // ── P: the runner and the dispatcher ───────────────────────────────────
  {
    id: 'P1', tests: [T_SNAP],
    prepare: inEveryCopy('peer-runner.mjs',
      '    const peerCwd = snapshot?.peer_cwd ?? options.cwd;',
      '    const peerCwd = options.cwd;'),
    why: 'peer-runner hands the codex peer the live checkout again',
    killed_by: /the vandal peer tidies only the snapshot; its paths and prompt name the snapshot/,
  },
  {
    id: 'P2', tests: [T_SNAP],
    prepare: inEveryCopy('peer-runner.mjs',
      "    if (options.peer === 'codex') options.env = scrubGitSelectors(options.env);\n",
      ''),
    why: "the companion inherits the caller's git selectors, which send its git commands to the live tree",
    killed_by: /the vandal peer tidies only the snapshot; its paths and prompt name the snapshot/,
  },
  {
    id: 'P3', tests: [T_SNAP],
    prepare: inEveryCopy('peer-runner.mjs',
      '      const removed = await removePeerSnapshot(snapshot, { env: options.env });',
      '      const removed = { removed: false, error: null };'),
    why: 'a finished run leaves its snapshot behind',
    killed_by: /a failed peer run removes its snapshot too/,
  },
  {
    id: 'P4', tests: [T_SNAP],
    prepare: inEveryCopy('peer-runner.mjs',
      '    return { failed };\n  }\n  if (snapshot.isolation',
      '    return { snapshot: null };\n  }\n  if (snapshot.isolation'),
    why: 'a snapshot that cannot be made falls back to running the peer in the live tree',
    killed_by: /a snapshot that cannot be made fails the run before any companion runs/,
  },
  {
    id: 'P5', tests: [T_SNAP],
    prepare: inEveryCopy('peer-runner.mjs',
      '      for (const [sig, fn] of handlers) process.on(sig, fn);',
      '      void handlers;'),
    why: 'a signal kills the runner outright: no cancellation, no cleanup, the snapshot left behind',
    killed_by: /the CLI ends on SIGTERM \(repeated\) with 143/,
  },
  {
    id: 'P6', tests: [T_SNAP],
    prepare: inEveryCopy('lib/process-identity.mjs',
      '  if (!Number.isInteger(pgid) || pgid <= 0 || !isGroupAlive(pgid)) return;',
      '  return;'),
    why: 'a child the companion leaves running keeps working in the snapshot as it is removed',
    killed_by: /a child the companion leaves running is stopped before the snapshot is removed/,
  },
  {
    id: 'P7', tests: [T_SNAP],
    prepare: inEveryCopy('dispatch-peer.mjs',
      '    if (peer === \'codex\') {\n      const base = cwd ?? process.cwd();',
      '    if (false) {\n      const base = cwd ?? process.cwd();'),
    why: 'dispatch-peer hands the codex peer the live checkout again',
    killed_by: /the vandal peer tidies only the snapshot, which is removed when the dispatch ends/,
  },
  {
    id: 'P8', tests: [T_SNAP],
    prepare: inEveryCopy('peer-runner.mjs',
      "    if (options.peer === 'codex') options.env = scrubGitSelectors(options.env);",
      '    if (snapshot) options.env = scrubGitSelectors(options.env);'),
    why: 'a codex peer outside any checkout inherits a git selector naming the live repository',
    killed_by: /a codex peer outside any checkout still gets no git selector naming the live repository/,
  },
  {
    id: 'P9', tests: [T_SNAP],
    prepare: inEveryCopy('peer-runner.mjs',
      '      if (Number.isInteger(peerProcess.pgid)) {\n        let goneSince = null;',
      '      if (false) {\n        let goneSince = null;'),
    why: "a child holding the companion's pipes keeps the run waiting on its close forever",
    killed_by: /a child holding the companion's stdout open does not hold the run/,
  },
  {
    id: 'P10', tests: [T_SNAP],
    prepare: inEveryCopy('peer-runner.mjs',
      '    await stopProcessGroup(peerProcess?.pgid, graceMs);\n    if (snapshot) {',
      '    if (snapshot) {\n      await stopProcessGroup(peerProcess?.pgid, graceMs);'),
    why: "a peer with no snapshot (a claude peer) leaves its children running after the run",
    killed_by: /a claude peer's leftover child is stopped too/,
  },
  {
    id: 'P11', tests: [T_SNAP],
    prepare: inEveryCopy('peer-runner.mjs',
      'env: options.env, signal: abort.signal });',
      'env: options.env });'),
    why: 'a cancellation waits for the whole capture (a hung filter holds it forever) instead of stopping it',
    killed_by: /a cancellation requested before the spawn ends the run cancelled — the capture itself stopped/,
  },
  {
    id: 'P12', tests: [T_SNAP],
    prepare: inEveryCopy('dispatch-peer.mjs',
      '      spawnEnv = scrubGitSelectors(env);\n',
      ''),
    why: "dispatch-peer hands a codex peer the caller's git selectors",
    killed_by: /a codex peer outside any checkout gets no git selector naming the live repository/,
  },
  {
    id: 'P13', tests: [T_SNAP],
    prepare: inEveryCopy('dispatch-peer.mjs',
      '      if (!detached) return;\n      lingerTimer',
      '      return;\n      lingerTimer'),
    why: "a child holding the companion's pipes keeps dispatch-peer waiting forever",
    killed_by: /a child holding the companion's pipes is stopped once the companion exits, and the dispatch ends/,
  },
  // ── R: reclaim ─────────────────────────────────────────────────────────
  {
    id: 'R1', tests: [T_SNAP],
    prepare: inEveryCopy(LIB,
      "  if (companion === 'alive') return { verdict: 'keep', why: 'companion-alive' };\n",
      ''),
    why: 'a snapshot is reclaimed while the peer that outlived its supervisor still runs in it',
    killed_by: /keeps a snapshot whose supervisor died while its companion still runs/,
  },
  {
    id: 'R2', tests: [T_SNAP],
    prepare: inEveryCopy(LIB,
      "  if (supervisor === 'unknown' || companion === 'unknown' || unnamedLaunch) {",
      '  if (false) {'),
    why: 'a process whose identity cannot be told is taken for gone, and its snapshot reclaimed at once',
    killed_by: /an identity that cannot be told is kept until the record is older than the TTL/,
  },
  {
    id: 'R3', tests: [T_SNAP],
    prepare: inEveryCopy(LIB,
      "  if (supervisor === 'match') return { verdict: 'keep', why: 'supervisor-alive' };\n",
      ''),
    why: "a run's own live snapshot is reclaimed by another run",
    killed_by: /reclaims a snapshot whose supervisor and companion are gone; keeps a live one/,
  },
  {
    id: 'R4', tests: [T_SNAP],
    prepare: inEveryCopy(LIB,
      "  const unnamedLaunch = companion === null && typeof owner.launched_at === 'string';",
      '  const unnamedLaunch = false;'),
    why: 'a peer launched and not yet recorded loses its snapshot as soon as its supervisor dies',
    killed_by: /a launch whose companion was never recorded is kept after its supervisor dies/,
  },
  {
    id: 'C7', tests: [T_SNAP],
    prepare: inEveryCopy(LIB,
      '  const r = await runProcess(\'git\', [\'-c\', \'core.hooksPath=/dev/null\', \'-c\', \'core.fsmonitor=false\', \'-C\', dir, ...args], { env: e, input, signal });\n  if (signal?.aborted) throw cancelled();',
      '  const r = await runProcess(\'git\', [\'-c\', \'core.hooksPath=/dev/null\', \'-c\', \'core.fsmonitor=false\', \'-C\', dir, ...args], { env: e, input, signal });'),
    why: 'a git call stopped by the cancellation is read as a failure of the repository, not a cancellation',
    killed_by: /a cancellation while a git call runs \(a slow clean filter\) stops that call, the filter with it, and reads as cancelled/,
  },
  // ── Refine of 2026-10-13: the review of the snapshot's own implementation ──
  {
    id: 'C8', tests: [T_SNAP],
    prepare: inEveryCopy(LIB,
      "      if (detached && Number.isInteger(child.pid)) stopped = stopProcessGroup(child.pid, ABORT_GRACE_MS);",
      "      if (false) stopped = stopProcessGroup(child.pid, ABORT_GRACE_MS);"),
    why: "an aborted git call stops git alone: the clean filter it started runs on",
    killed_by: /a cancellation while a git call runs \(a slow clean filter\) stops that call, the filter with it/,
  },
  {
    id: 'C9', tests: [T_SNAP],
    prepare: inEveryCopy(LIB,
      "      if (!replacements.has(escaped)) replacements.set(escaped, root);",
      '      void escaped;'),
    why: 'a checkout path an XML prompt escapes (`&amp;`) is not rewritten and still names the live tree',
    killed_by: /rewrites the toplevel as an XML prompt escapes it/,
  },
  {
    id: 'C10', tests: [T_SNAP],
    prepare: inEveryCopy(LIB,
      '      signal?.removeEventListener(\'abort\', stop);\n      await stopped;\n',
      '      signal?.removeEventListener(\'abort\', stop);\n'),
    why: 'an aborted git call settles before its group is gone: a caller that then exits takes the SIGKILL a TERM-ignoring descendant still needs with it',
    killed_by: /a cancellation while a git call runs \(a slow clean filter\) stops that call, the filter with it/,
  },
  {
    id: 'C11', tests: [T_SNAP],
    prepare: inEveryCopy(LIB,
      '  const base = candidates.find((c) => !isWithinOrEqual(c, top) && !XML_SPECIAL.test(c));',
      '  const base = candidates.find((c) => !isWithinOrEqual(c, top));'),
    why: 'a snapshot root carries a character XML escapes, so a rewritten path reads differently in a prompt than on disk',
    killed_by: /a TMPDIR whose path XML would escape is passed over/,
  },
  {
    id: 'P14', tests: [T_SNAP],
    prepare: inEveryCopy('peer-runner.mjs',
      "      if (isTerminalStatus(h.status)) return h;\n      h.status = 'failed';\n      h.completed_at = nowIso();\n      h.exit_code = null;\n      h.error_kind = err?.code ?? 'runner_error';",
      '      return h;'),
    why: 'a run that throws once its snapshot exists leaves its ledger queued or spawning, read as live',
    killed_by: /a run that throws once its snapshot exists \(an unreadable prompt\) ends failed/,
  },
  {
    id: 'P15', tests: [T_SNAP],
    prepare: inEveryCopy('peer-runner.mjs',
      '  const next = await mutator(handle) ?? handle;\n  hook?.(next, before);\n  next.updated_at = new Date().toISOString();\n  return await writeHandle(handlePath, next, { guard }) ? next : null;',
      '  const next = await mutator(handle) ?? handle;\n  next.updated_at = new Date().toISOString();\n  if (!await writeHandle(handlePath, next, { guard })) return null;\n  hook?.(next, before);\n  return next;'),
    why: 'process control is armed only once the ledger has taken the running record: a failed write leaves a cancellation unable to reach the peer',
    killed_by: /a cancellation still reaches the peer when the ledger refuses the write that records it running/,
  },
  // No case pins cancelOwnPeer's `ended` guard: it covers a cancellation
  // between the terminal write and the finally, a window no test can hold
  // open without a seam inside the four-copy spawn section.
  {
    id: 'P16', tests: [T_SNAP],
    prepare: inEveryCopy('peer-runner.mjs',
      "      if (isTerminalStatus(h.status) && h.status !== 'cancelled' && (cancellation?.signal || before === 'cancel_requested' || before === 'cancelled')) {",
      '      if (false) {'),
    why: 'a cancellation that lands after the run read its handle is overwritten by the terminal write',
    killed_by: /a cancellation that comes after the run read its handle and before the terminal write still ends it cancelled/,
  },
  // Refine of 2026-10-13, round 4 (the owner's fix-now of the recurring
  // finding): the terminal write's own status comes from a read in the spawn
  // section, so each status a concurrent `cancel` can leave on the handle has
  // its clause in the hook and its case here.
  {
    id: 'P19', tests: [T_SNAP],
    prepare: inEveryCopy('peer-runner.mjs',
      " || before === 'cancel_requested' || before === 'cancelled')) {",
      " || before === 'cancel_requested')) {"),
    why: "a cancel that finished as the peer exited on its own is overwritten by the terminal write's completed",
    killed_by: /a cancel whose cancelled record lands between the run's last read and its terminal write keeps the run cancelled/,
  },
  {
    id: 'P20', tests: [T_SNAP],
    prepare: inEveryCopy('peer-runner.mjs',
      " || before === 'cancel_requested' || before === 'cancelled')) {",
      " || before === 'cancelled')) {"),
    why: "a cancel requested after the run read its handle is overwritten by the terminal write's completed",
    killed_by: /a cancel whose cancel_requested record lands between the run's last read and its terminal write keeps the run cancelled/,
  },
  {
    id: 'P17', tests: [T_SNAP],
    prepare: inEveryCopy('peer-runner.mjs',
      '    retireCancel?.();\n    handleHooks.delete(paths.handle);',
      '    handleHooks.delete(paths.handle);'),
    why: "a cancellation after the run ended signals the ended peer's pid and group, which may be another process's",
    killed_by: /a cancellation requested after the run ended signals nothing of its peer/,
  },
  {
    id: 'P18', tests: [T_SNAP],
    prepare: (copy, tools) => {
      for (const persona of PERSONAS) {
        const file = `plugins/${persona}/scripts/dispatch-peer.mjs`;
        tools.applyEdit(copy, { file, from: "    // group).\n    retireCancel?.();\n", to: '    // group).\n' });
        tools.applyEdit(copy, { file, from: '  } finally {\n    retireCancel?.();\n', to: '  } finally {\n' });
      }
    },
    why: "a cancellation after the dispatch ended signals the ended peer's pid and group",
    killed_by: /a cancellation requested after the dispatch ended signals nothing of its peer/,
  },
  {
    id: 'R9', tests: [T_SNAP],
    prepare: inEveryCopy(LIB,
      "      if (errors.length > 0) return { removed: false, error: errors.join('; ') };\n",
      ''),
    why: 'a snapshot whose branch could not be deleted loses the owner record a retry needs, and the branch stays',
    killed_by: /a branch that cannot be deleted keeps the owner record/,
  },
  {
    id: 'R5', tests: [T_SNAP],
    prepare: inEveryCopy(LIB,
      '  const again = await readOwner(ownerPath);\n  if (JSON.stringify(again) === JSON.stringify(first)) return { judged, owner: first };',
      '  const again = first;\n  if (JSON.stringify(again) === JSON.stringify(first)) return { judged, owner: first };'),
    why: 'a reclaim acts on an owner record read before its supervisor recorded a launch and died',
    killed_by: /a launch its supervisor records while the reclaim judges it is read again/,
  },
  {
    id: 'R6', tests: [T_SNAP],
    prepare: inEveryCopy(LIB,
      "  if (group && state !== 'differ') return 'alive';\n",
      ''),
    why: 'a live companion group whose leader exited is reclaimed once the record is old',
    killed_by: /a live companion group whose leader exited blocks the reclaim/,
  },
  {
    id: 'R7', tests: [T_SNAP],
    prepare: inEveryCopy(LIB,
      "  if (typeof owner.common_dir === 'string') return owner.common_dir === live.commonDir;\n",
      ''),
    why: 'an interrupted creation from a linked worktree is reclaimed from that worktree only',
    killed_by: /an interrupted creation from a linked worktree is reclaimed from the main checkout/,
  },
  {
    id: 'R8', tests: [T_SNAP],
    prepare: inEveryCopy(LIB,
      '  if (top && snapshot.branch) {',
      '  if (top && tree && snapshot.branch) {'),
    why: "an interrupted creation's orphan branch is left behind",
    killed_by: /an interrupted creation's orphan branch is deleted with it/,
  },
];
