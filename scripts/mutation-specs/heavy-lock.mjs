// Mutation spec — do the heavy-work lock's tests catch the defects ADR-0068
// Decision 6 guards against?
//
// Run: npm run mutate -- scripts/mutation-specs/heavy-lock.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. Each defect below leaves the lock working for
// one holder alone: a join that skips the proof, a group judged gone that runs,
// a release that ignores the ownership, or a wrapper that releases before its
// group has stopped all show only when holders, their groups and their nested
// acquirers meet. Each mutation breaks one rule and names the test that must
// notice. The lock's moved parts (L1, L3–L7, L10–L12, L15) stay in
// mutation-harness.mjs with their tests.
//
// Groups: P the protocol (lib/heavy-lock.mjs: stale judgment, the ownership
// registry, the proof, release and cancellation), H the mutation harness as a
// holder (the go line, the group teardown, joining), W the wrapper
// (lib/heavy-run.mjs and the CLI), E who must not inherit the proof.
//
// Two guards have no mutation of their own: the harness and the wrapper send
// each kill through the leader-start check (signalGroup, groupState), which
// its own test holds, and no test can make a pid be reused on cue.
//
// Four new tests have no mutation. The fixture provenance test compares the
// older harness copy with its commit, and the copy a mutation runs in has no
// .git, so it skips there. Three tests record what the lock does not cover,
// and assert only a limit: an older holder's window is narrower, a process
// that left its holder's group survives the release, and a SIGHUP to the
// launcher's pid ends the launcher alone (the launcher is a copied file this
// release leaves as it is). No defect in this tree makes those limits fail.
//
// The harness's own wait for a run's group (groupAlive) judges it through
// groupState, whose rule (gone only on ESRCH) P30 and P31 hold; no test makes a
// harness test run leave zombies its parent never reaps.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCK = 'plugins/orchestrator/scripts/lib/heavy-lock.mjs';

// Apply each [from, to] to `file` in `copy`; a from that is not there once is
// a drifted anchor.
function edit(copy, file, pairs) {
  const path = join(copy, file);
  let text = readFileSync(path, 'utf8');
  for (const [from, to] of pairs) {
    if (text.split(from).length !== 2) throw new Error(`anchor drifted in ${file}: ${JSON.stringify(from.slice(0, 60))}`);
    text = text.replace(from, () => to);
  }
  writeFileSync(path, text);
}
const RUN = 'plugins/orchestrator/scripts/lib/heavy-run.mjs';
const CLI = 'plugins/orchestrator/adapters/claude/autopilot/cli.mjs';
const WORKER = 'plugins/orchestrator/adapters/claude/autopilot/worker.mjs';
const H = 'scripts/mutation-harness.mjs';
const SESSION = 'scripts/lib/session-env.mjs';

const TL = 'tests/orchestrator/test-heavy-lock.mjs';
const TW = 'tests/orchestrator/test-heavy-lock-wrapper.mjs';
const TC = 'tests/orchestrator/test-heavy-lock-compat.mjs';
const TH = 'tests/scripts/test-mutation-harness-heavy-lock.mjs';
const TA = 'tests/orchestrator/test-autopilot-cli.mjs';

// tests/orchestrator/test-heavy-lock.mjs
const T_PARSE = /^reaps a record that does not parse, and never judges a holder on another host$/;
const T_DEAD_HOLDER = /^keeps a dead holder's lock while a group of its ownership runs, and takes it once the group ends$/;
const T_GROUP_STATE = /^a group whose leader is gone runs; a reused leader with another start is not ours; what cannot be told runs$/;
const T_REUSED = /^a live group whose leader started at another time is not counted$/;
const T_CLOSE = /^a registration after the close fails; one landed just before it is judged$/;
const T_UNREGISTER = /^an unregister removes its own entry only, wherever it lies, never a newer one for the same group$/;
const T_COLLECT = /^a holder collects only foreign ownerships with no running group$/;
const T_ORPHAN = /^waits for the running groups of an ownership that holds no lock, naming them$/;
const T_MALFORMED = /^a token or a process group that is not well-formed touches no path$/;
const T_ABORT = /^an abort ends the wait with nothing placed$/;
const T_PROOF = /^a running holder's proof joins it without waiting; a wrong or stale proof is no join$/;
const T_RECORD = /^records what an older harness reads, and the start as this platform spells it$/;
const T_LATE = /^a process of an earlier holder that registers after the acquirer's last look makes it withdraw and wait$/;
const T_SCAN = /^a scan that the close of its directory overtakes still finds the entry$/;
const T_RELEASE_RACE = /^a registration that lands just before the release's close keeps the lock$/;
const T_WAITED = /^repeats a waiting line with how long the wait has lasted$/;
const T_ANCESTORS = /^a process whose holder ended while its ownership runs is refused, not left to wait on its own ancestors$/;
const T_DEPTH = /^refuses a chain of handles too deep or malformed to extend$/;
const T_EPERM_LEADER = /^EPERM from the group probe still checks the leader: another user's process that took the id is not ours$/;
const T_ZOMBIES = /^only ESRCH ends a group: a group of zombies only runs until it is reaped$/;
const T_REAL_ZOMBIE = /^a real group whose only process is an unreaped zombie runs until it is reaped, then is gone$/;
const T_SIGNAL_GROUP = /^sends to the group it registered, never to one that took its id since$/;

// tests/orchestrator/test-heavy-lock-wrapper.mjs
const T_TURNS = /^two wrappers in two worktrees take turns: the second's command never starts while the first's runs$/;
const T_CADENCE = /^repeats its waiting line at its cadence, and escapes the holder's purpose$/;
const T_NESTING = /^a wrapper in a wrapper, the harness in a wrapper, and npm run mutate in a wrapper in a wrapper all join$/;
const T_EXIT = /^the command's own status, 128\+n for a signal that ended it, 126 and 127$/;
const T_NO_REPORT = /^a supervisor that dies before the go line, or ends with no report, is 125$/;
const T_RUNNING = (signal) => new RegExp(`^${signal} while the command runs reaches its group, which is gone before the lock is$`);
const T_WAITING = (signal) => new RegExp(`^${signal} while waiting ends the wait: 128\\+n, the command never ran, the holder's lock untouched$`);
const T_LATE_KILL = /^a command that ignores the signal gets SIGKILL 5 s later$/;
const T_JOINED_CANCEL = /^a joined wrapper's cancellation stops its own group only$/;
const T_HOLDER_WAITS = /^a holder's release is refused while a joined wrapper that left its group runs$/;
const T_LAUNCHER = /^runs the wrapper, forwards SIGTERM to it, and passes its exit status through$/;
const T_DRIVER = /^refuses to start, naming the holder, with nothing created; a stale proof is no refusal$/;
const T_DECLARED = /^is refused with 125 from the committed declaration, never the working tree$/;
const T_DECLARED_PARSE = /^one that does not parse at the ref refuses, naming it$/;
const T_JOIN_CLOSED = /^a joined wrapper whose holder's ownership has closed starts nothing$/;
const T_WRAPPER_SIGKILL = /^SIGKILL to the wrapper: its supervisor stops the group, and the next wrapper then takes the lock$/;
const T_ORDERLY = /^an orderly end: what the command left in its group is stopped before the lock goes$/;
const T_LEFT_BEHIND = /^an orderly end leaves no record, guard or ownership$/;
const T_GO_WRAPPER = /^the command starts only once its group is registered, at the go line$/;
const T_EXEC_FAILURE = /^126 for an exec failure Node throws \(ENOEXEC, ENOTDIR\); 125 when the system has no room to start it$/;
const T_SPAWN_REFUSED = /^a supervisor the system refuses to start is 125, and the lock is released$/;

// tests/orchestrator/test-heavy-lock-compat.mjs
const T_OLD_BOTH_WAYS = /^an older harness waits for a wrapper, naming its purpose; a wrapper waits for an older harness$/;
const T_OLD_SCRIPT = /^an older harness started through a script under the wrapper cannot join: it waits, naming the wrapper$/;
const T_OLD_KILLED_WRAPPER = /^a wrapper holder: no acquirer of this release takes the lock before its group ends; an older one does \(measured\)$/;

// tests/scripts/test-mutation-harness-heavy-lock.mjs
const T_GO = /^a harness killed between a run's spawn and its registration runs no test$/;
const T_REFUSED = /^a registration refused because the ownership closed starts nothing$/;
const T_SETTLES = /^waits for what the run left in its group before it settles$/;
const T_STUCK = /^a group that will not end fails the run as no verdict and stays in the ownership$/;
const T_NPM_JOIN = /^npm run mutate, through a script, joins the wrapper's lock without waiting; a wrong proof waits, naming the holder$/;
const T_HARNESS_SIGKILL = /^SIGKILL to a harness holder: no acquirer takes the lock while a group of its test runs lives$/;
const T_KEPT = /^the CLI keeps the copies while a group that would not end still runs there$/;
const T_SCRUB = /^a test run, a test process and an autopilot worker are each started without the proof and the chain$/;

// tests/orchestrator/test-autopilot-cli.mjs
const T_WORDS = /^reads its options before --, and nothing after it$/;
const T_EXEMPT = /^is exempt from the host refusal and runs inside an autopilot step: the lock is host-neutral$/;

export const TESTS = [TL];

export const MUTATIONS = [
  // ---- P: the protocol --------------------------------------------------------
  {
    id: 'P1', file: LOCK,
    from: '    } else if (seen.record === null || !holderRunning(seen.record)) {',
    to: '    } else if (!holderRunning(seen.record ?? {})) {',
    why: 'a record that does not parse is judged as a holder on another host: it is waited for for ever',
    killed_by: T_PARSE,
  },
  {
    id: 'P2', file: LOCK,
    from: '  if (token === null || !UUID.test(token)) return [];\n  const out = [];\n',
    to: '  return [];\n  const out = [];\n',
    why: 'the ownership is never read: a dead holder\'s lock is taken while its groups still run (item 2)',
    tests: [TL, TC, TH],
    killed_by: [T_DEAD_HOLDER, T_OLD_KILLED_WRAPPER, T_HARNESS_SIGKILL],
  },
  {
    id: 'P3', file: LOCK,
    from: "  if (leaderStarted !== now.started) return 'foreign';\n",
    to: '',
    why: 'a reused live leader counts as the registered group: an unrelated process keeps a dead holder\'s lock',
    killed_by: [T_GROUP_STATE, T_REUSED],
  },
  {
    id: 'P4', file: LOCK,
    from: "    if (err.code === 'ESRCH') return 'gone';\n    if (err.code !== 'EPERM') return 'running';\n",
    to: "    return 'gone';\n",
    why: 'a group probe that fails, or EPERM, counts as gone: a group that cannot be judged loses its lock',
    killed_by: T_GROUP_STATE,
  },
  {
    id: 'P5', file: LOCK,
    from: '    renameSync(join(groupsDir(path), token), join(groupsDir(path), `${token}.closed.${randomUUID()}`));',
    to: '    void randomUUID;',
    why: 'closing is skipped: a registration after the judgment lands, and its group runs with no lock',
    killed_by: T_CLOSE,
  },
  {
    id: 'P6', file: LOCK,
    from: '          unlinkSync(join(d, name));\n          return;\n',
    to: '          for (const n of readdirSync(d).filter((x) => x.startsWith(`${pgid}-`))) unlinkSync(join(d, n));\n          return;\n',
    why: 'an unregister removes every entry of its process group: a newer registration of the same pgid goes with it',
    killed_by: T_UNREGISTER,
  },
  {
    id: 'P7', file: LOCK,
    from: '    if (left.length > 0) {\n      running.push(',
    to: '    if (false) {\n      running.push(',
    why: 'a holder collects a foreign ownership whose group still runs: the group is no longer waited for',
    killed_by: T_COLLECT,
  },
  {
    // Both looks go: the one before placing the lock spares a lock placed and
    // withdrawn, and the one after it closes what registered in between, so
    // either alone keeps the rule.
    id: 'P8',
    prepare: (copy) => edit(copy, LOCK, [
      ['    let orphans = orphanGroups(path);\n', '    let orphans = [];\n'],
      ['    if (late.length > 0) withdraw(path, record);\n    return late;\n', '    return [];\n'],
    ]),
    why: 'an ownership left running without its lock (an older reaper removed it) is ignored: the lock is placed beside it',
    killed_by: T_ORPHAN,
  },
  {
    id: 'P29', file: LOCK,
    from: '    let orphans = orphanGroups(path);\n',
    to: '    let orphans = [];\n',
    why: 'the look before placing the lock goes: while an orphan runs, every poll places the lock and withdraws it, so an older reader sees a holder flicker',
    killed_by: [T_ORPHAN, T_LATE],
  },
  {
    id: 'P30', file: LOCK,
    from: "  // The registered leader, a zombie or not: its group is not reaped yet.\n  return 'running';\n",
    to: "  // The registered leader, a zombie or not: its group is not reaped yet.\n  return now.zombie ? 'gone' : 'running';\n",
    why: 'a zombie leader reads as a group that has ended: absence judged from a look at a process, which can miss a running member, not from ESRCH',
    killed_by: [T_ZOMBIES, T_REAL_ZOMBIE],
  },
  {
    id: 'P31', file: LOCK,
    from: "  if (!leaderAlive) return 'running';\n",
    to: "  if (!leaderAlive) return 'gone';\n",
    why: 'a group whose leader has exited reads as ended: its members, alive or not yet reaped, lose the lock',
    killed_by: [T_GROUP_STATE, T_ZOMBIES],
  },
  {
    id: 'P37', file: LOCK,
    from: "    if (err.code !== 'EPERM') return 'running';\n  }\n",
    to: "    return 'running';\n  }\n",
    why: 'EPERM from the group probe skips the leader check: another user\'s group that took a dead entry\'s id blocks every heavy job while it lives',
    killed_by: T_EPERM_LEADER,
  },
  {
    id: 'P9', file: LOCK,
    from: "  if (token === null || !UUID.test(String(token))) throw new HeavyLockError(`the ownership token ${shown(token)} is not a UUID`);\n",
    to: '',
    why: 'a token that is not a UUID is a path component: a record\'s token writes outside the lock\'s ownership',
    killed_by: T_MALFORMED,
  },
  {
    id: 'P10', file: LOCK,
    from: '      if (left.length > 0) {\n        const groups = ',
    to: '      if (false) {\n        const groups = ',
    why: 'a release ignores the ownership: the lock goes while a group of it still runs',
    killed_by: T_CLOSE,
  },
  {
    id: 'P11', file: LOCK,
    from: '      removeOwnership(path, record.token);\n      if (readLock(path)',
    to: '      if (readLock(path)',
    why: 'a release leaves its closed ownership behind, for every later holder to read',
    tests: [TW],
    killed_by: T_LEFT_BEHIND,
  },
  {
    id: 'P12', file: LOCK,
    from: '  signal?.throwIfAborted();\n  const path = lockPath(repoRoot);\n',
    to: '  const path = lockPath(repoRoot);\n',
    why: 'an acquirer cancelled before it starts joins the holder whose proof it carries',
    killed_by: T_ABORT,
  },
  {
    id: 'P13', file: LOCK,
    from: '  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;\n',
    to: '',
    why: 'any proof joins a holder that minted one: an unrelated process runs inside its lock',
    killed_by: T_PROOF,
  },
  {
    id: 'P14', file: LOCK,
    from: '  if (tokenOf(record) === null || !holderRunning(record)) return null;\n',
    to: '  if (tokenOf(record) === null) return null;\n',
    why: 'a dead holder\'s proof still joins: its lock is never reaped by the processes it left',
    killed_by: T_PROOF,
  },
  {
    id: 'P15', file: LOCK,
    from: "  kind = 'harness', purpose = '', spec = purpose,",
    to: "  kind = 'harness', purpose = '', spec = '',",
    why: 'a wrapper writes no spec: an older harness names its holder by nothing',
    tests: [TL, TC],
    killed_by: [T_RECORD, T_OLD_BOTH_WAYS, T_OLD_SCRIPT],
  },
  {
    id: 'P16', file: LOCK,
    from: "export const holderName = (h) => shown(h.purpose || h.spec || 'a spec');",
    to: "export const holderName = (h) => String(h.purpose || h.spec || 'a spec');",
    why: 'a holder\'s purpose reaches the terminal as written: a line separator in it forges a line',
    tests: [TW],
    killed_by: T_CADENCE,
  },
  {
    id: 'P17', file: LOCK,
    from: '    if (key === reported && Date.now() - reportedAt < reportMs) return;',
    to: '    if (key === reported) return;',
    why: 'the waiting line is said once: a long wait goes silent',
    tests: [TW],
    killed_by: T_CADENCE,
  },
  {
    id: 'P18', file: LOCK,
    from: '    linkSync(tmp, target);',
    to: '    writeFileSync(target, readFileSync(tmp));',
    why: 'taking the lock replaces the holder\'s: two wrappers run their commands at once',
    tests: [TW],
    killed_by: T_TURNS,
  },
  {
    id: 'P19', file: LOCK,
    from: '      path, joined: true, record: h, token: h.token, chain, proof: join_.proof,',
    to: '      path, joined: true, record: h, token: h.token, chain, proof: mintProof(),',
    why: 'a joined wrapper hands its command a proof of its own, which matches no holder: npm run mutate two levels down waits on its own holder',
    tests: [TW],
    killed_by: T_NESTING,
  },
  {
    id: 'P20', file: LOCK,
    from: '        if (orphans.length === 0) break;\n',
    to: '        break;\n',
    why: 'an acquirer keeps the lock it placed beside a group of an earlier holder that registered after its last look',
    killed_by: T_LATE,
  },
  {
    id: 'P21', file: LOCK,
    from: "        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') { moved = true; continue; }",
    to: "        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') { continue; }",
    why: 'a directory its holder closes during a scan is skipped: the entries it held are not seen, and a joined wrapper ends beside them',
    killed_by: T_SCAN,
  },
  {
    id: 'P22', file: LOCK,
    from: '      beforeClose();\n      closeOwnership(path, record.token);\n      const left = ownershipGroups(path, record.token);\n',
    to: '      const left = ownershipGroups(path, record.token);\n      beforeClose();\n      closeOwnership(path, record.token);\n',
    why: 'a release judges before it closes: a registration between the two is removed with the ownership, and its group runs with no lock',
    killed_by: T_RELEASE_RACE,
  },
  {
    id: 'P23', file: LOCK,
    from: '    log(key === reported ? `${line}; waited ${Math.round((Date.now() - since) / 1000)} s so far` : line);',
    to: '    log(line);',
    why: 'a waiter does not say how long it has waited (item 5)',
    tests: [TL, TW],
    killed_by: [T_WAITED, T_CADENCE],
  },
  {
    id: 'P24', file: LOCK,
    from: '        if (inherited !== null && h.token === inherited) throw ownAncestors(inherited, path, h.pid);\n',
    to: '',
    why: 'a process inside an ownership whose holder died waits for that ownership, so for its own ancestors, which wait for it',
    killed_by: T_ANCESTORS,
  },
  {
    id: 'P25', file: LOCK,
    from: '    if (inherited !== null && orphans.some((o) => o.token === inherited)) throw ownAncestors(inherited, path, null);\n',
    to: '',
    why: 'the same, once an older reaper has removed the dead holder\'s lock',
    killed_by: T_ANCESTORS,
  },
  {
    id: 'P26', file: LOCK,
    from: '    if (join_.chain === null || join_.chain.length >= MAX_CHAIN) {',
    to: '    if (join_.chain === null) {',
    why: 'a chain at its bound is extended past it, and the next reader drops it: the handles above lose their descendants',
    killed_by: T_DEPTH,
  },
  {
    id: 'P27', file: LOCK,
    from: '  return ids.length <= MAX_CHAIN && ids.every((id) => UUID.test(id)) ? ids : null;',
    to: '  return ids.length <= MAX_CHAIN && ids.every((id) => UUID.test(id)) ? ids : [];',
    why: 'a malformed chain is read as none: the joined process loses the handles above it',
    killed_by: T_DEPTH,
  },
  {
    id: 'P28', file: LOCK,
    from: "  if (groupState(pgid, leaderStarted, sys) !== 'running') return false;\n",
    to: '',
    why: 'a kill goes by the group id alone: it reaches a group that took the id after the registered one ended',
    killed_by: T_SIGNAL_GROUP,
  },

  // ---- H: the harness as a holder ---------------------------------------------
  {
    id: 'H1', file: H,
    from: "  'function go() {',\n",
    to: "  'go(); function go() {',\n",
    why: 'the supervisor runs the test without waiting for the go line: a run starts before its group is registered',
    tests: [TH],
    killed_by: T_GO,
  },
  {
    id: 'H2', file: H,
    from: '        if (ownership) entry = harnessError(() => registerGroup(ownership, child.pid, { leaderStarted }));\n',
    to: '        if (ownership) try { entry = harnessError(() => registerGroup(ownership, child.pid, { leaderStarted })); } catch { /* ignored */ }\n',
    why: 'a registration the closed ownership refuses is ignored: the run starts outside any lock',
    tests: [TH],
    killed_by: T_REFUSED,
  },
  {
    id: 'H3', file: H,
    from: '        if (ownership) entry = harnessError(() => registerGroup(ownership, child.pid, { leaderStarted }));\n',
    to: '        if (false) entry = harnessError(() => registerGroup(ownership, child.pid, { leaderStarted }));\n',
    why: 'a test run is never registered: a harness killed with SIGKILL leaves its run beside the next holder',
    tests: [TH],
    killed_by: [T_REFUSED, T_HARNESS_SIGKILL],
  },
  {
    id: 'H4', file: H,
    from: "    child.on('close', () => { groupEnded(child.pid).then((ended) => settle(() => {",
    to: "    child.on('close', () => { Promise.resolve(true).then((ended) => settle(() => {",
    why: 'a run settles while its group still runs: its copy is removed and its entry dropped under a live process',
    tests: [TH],
    killed_by: [T_SETTLES, T_STUCK],
  },
  {
    id: 'H5', file: H,
    from: "    handle = await acquire(repoRoot, { kind: 'harness', purpose: spec, spec, log, pollMs, env, prefix: 'mutation-harness' });",
    to: "    handle = await acquire(repoRoot, { kind: 'harness', purpose: spec, spec, log, pollMs, env: {}, prefix: 'mutation-harness' });",
    why: 'the harness never joins: npm run mutate under a wrapper waits on its own holder for ever',
    tests: [TH],
    killed_by: T_NPM_JOIN,
  },
  {
    id: 'H6', file: H,
    from: "        if (ownership) entry = harnessError(() => registerGroup(ownership, child.pid, { leaderStarted }));\n        beforeGo(child);\n        child.stdin.write('go\\n');\n",
    to: "        beforeGo(child);\n        child.stdin.write('go\\n');\n        if (ownership) entry = harnessError(() => registerGroup(ownership, child.pid, { leaderStarted }));\n",
    why: 'a test run is registered after its go line: a harness killed between the two leaves a run no reader sees',
    tests: [TH],
    killed_by: T_GO,
  },
  {
    id: 'H7', file: H,
    from: '      const stuck = [...STUCK].filter(groupAlive);',
    to: '      const stuck = [];',
    why: 'the copies are removed under a test run\'s group that would not end, while it may still write there',
    tests: [TH],
    killed_by: T_KEPT,
  },

  // ---- W: the wrapper ---------------------------------------------------------
  {
    id: 'W1', file: RUN,
    from: "const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];",
    to: "const SIGNALS = ['SIGTERM', 'SIGHUP'];",
    why: 'SIGINT kills the wrapper outright: its group and its lock outlive it',
    tests: [TW],
    killed_by: T_RUNNING('SIGINT'),
  },
  {
    id: 'W2', file: RUN,
    from: "const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];",
    to: "const SIGNALS = ['SIGINT', 'SIGHUP'];",
    why: 'SIGTERM kills the wrapper outright: its group and its lock outlive it, through the launcher too',
    tests: [TW],
    killed_by: [T_RUNNING('SIGTERM'), T_LAUNCHER],
  },
  {
    id: 'W3', file: RUN,
    from: "const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];",
    to: "const SIGNALS = ['SIGINT', 'SIGTERM'];",
    why: 'SIGHUP kills the wrapper outright: its group and its lock outlive it',
    tests: [TW],
    killed_by: T_RUNNING('SIGHUP'),
  },
  {
    id: 'W4', file: RUN,
    from: '    if (group === null) {\n      cancel.abort();\n      return;\n    }\n',
    to: '    if (group === null) {\n      return;\n    }\n',
    why: 'a signal while waiting does not cancel the wait: the wrapper takes the lock later and runs the command',
    tests: [TW],
    killed_by: [T_WAITING('SIGINT'), T_WAITING('SIGTERM'), T_WAITING('SIGHUP')],
  },
  {
    id: 'W5', file: RUN,
    from: "    killTimer = setTimeout(() => { signalGroup(group.pgid, group.started, 'SIGKILL'); }, KILL_GRACE_MS);\n",
    to: '',
    why: 'a command that ignores the signal is never killed: the wrapper and its lock wait for ever',
    tests: [TW],
    killed_by: T_LATE_KILL,
  },
  {
    id: 'W6', file: RUN,
    from: "  if (code === 'ENOENT') return 127;\n  return RESOURCE_ERRORS.has(code) ? 125 : 126;\n",
    to: '  return 127;\n',
    why: 'a command that cannot be executed reads as one that is not found',
    tests: [TW],
    killed_by: T_EXIT,
  },
  {
    id: 'W7', file: RUN,
    from: "    status({ state: 'ended', refused: 'the command\\'s supervisor ended without reporting how the command ended' });\n    return 125;\n",
    to: "    status({ state: 'ended', refused: 'the command\\'s supervisor ended without reporting how the command ended' });\n    return 0;\n",
    why: 'a supervisor that died with no report reads as a command that passed',
    tests: [TW],
    killed_by: T_NO_REPORT,
  },
  {
    id: 'W8', file: RUN,
    from: "  \"process.stdin.on('end', stop);\",\n",
    to: '',
    why: 'the supervisor ignores the end of its lifeline: a wrapper killed with SIGKILL leaves its command running',
    tests: [TW],
    killed_by: T_WRAPPER_SIGKILL,
  },
  {
    id: 'W9', file: RUN,
    from: "  for (let said = Date.now(); groupState(g.pgid, g.started) === 'running';) {",
    to: '  for (let said = Date.now(); false;) {',
    why: 'the wrapper releases once the command exits, while what it left in its group still runs',
    tests: [TW],
    killed_by: T_ORDERLY,
  },
  {
    id: 'W10', file: RUN,
    from: '    const left = ownershipGroups(handle.path, handle.token, { via: self })',
    to: '    const left = ownershipGroups(handle.path, handle.token, { via: null })',
    why: 'a joined wrapper waits for every group of the ownership, its holder\'s and its siblings\' too: a cancelled one never ends',
    tests: [TW],
    killed_by: T_JOINED_CANCEL,
  },
  {
    id: 'W11', file: RUN,
    from: '        if (!(e instanceof HeavyLockBusyError)) throw e;\n        if (Date.now() - said >= reportMs) {',
    to: '        if (!(e instanceof HeavyLockBusyError)) throw e;\n        return;\n        if (Date.now() - said >= reportMs) {',
    why: 'a holder whose release is refused exits anyway, while a joined process it started still runs under its lock',
    tests: [TW],
    killed_by: T_HOLDER_WAITS,
  },
  {
    id: 'W12', file: RUN,
    from: '    entry = registerGroup(handle.ownership, sup.pid);\n',
    to: "    try { entry = registerGroup(handle.ownership, sup.pid); } catch { entry = { name: '', unregister() {} }; }\n",
    why: 'a joined wrapper runs its command though the holder\'s ownership has closed',
    tests: [TW],
    killed_by: T_JOIN_CLOSED,
  },
  {
    id: 'W13', file: RUN,
    from: '  if (refusal !== null) { err(`heavy: ✗ ${refusal}`); return refused(125, refusal); }',
    to: '  if (false) { err(`heavy: ✗ ${refusal}`); return refused(125, refusal); }',
    why: 'a command declared as taking the lock itself runs under the wrapper: an older harness waits on its own holder',
    tests: [TW],
    killed_by: [T_DECLARED, T_DECLARED_PARSE],
  },
  {
    id: 'W14', file: RUN,
    from: '  const shownAt = git(repoRoot, [\'show\', `${sha}:${DECLARATION_PATH}`]);',
    to: "  const shownAt = spawnSync('cat', [`${repoRoot}/${DECLARATION_PATH}`], { encoding: 'utf8' });",
    why: 'the declaration is read from the working tree: an uncommitted edit lets a self-locking command through',
    tests: [TW],
    killed_by: T_DECLARED,
  },
  {
    id: 'W15', file: RUN,
    from: '    return `${where} does not parse: ${shown(err.message)}`;',
    to: '    return null;',
    why: 'a declaration that does not parse refuses nothing: a self-locking command it would mark runs',
    tests: [TW],
    killed_by: T_DECLARED_PARSE,
  },
  {
    id: 'W16', file: CLI,
    from: '    if (holder !== null) {\n      err(`✗ this shell runs inside the heavy-work lock',
    to: '    if (false) {\n      err(`✗ this shell runs inside the heavy-work lock',
    why: 'a driver starts inside a holder\'s ownership: every lane\'s heavy work joins that one holder at once',
    tests: [TW],
    killed_by: T_DRIVER,
  },
  {
    id: 'W17', file: CLI,
    from: "  if (argv[0] === 'heavy') return runHeavy(argv.slice(1), { env, out, err });\n",
    to: '',
    why: 'heavy goes through the driver\'s parser and refusals: it is unknown, and refused on Codex and inside an autopilot step',
    tests: [TA],
    killed_by: T_EXEMPT,
  },
  {
    id: 'W18', file: RUN,
    from: "    if (w === '--') { o.command = words.slice(i + 1); break; }",
    to: "    if (w === '--') { o.command = words.slice(i + 1); }",
    why: 'the command\'s own words are read as the wrapper\'s options',
    tests: [TA],
    killed_by: T_WORDS,
  },
  {
    id: 'W19', file: RUN,
    from: '    signalGroup(group.pgid, group.started, signal);\n',
    to: "    signalGroup(group.pgid, group.started, 'SIGKILL');\n",
    why: 'the command\'s group gets SIGKILL for any signal: it has no chance to stop in order',
    tests: [TW],
    killed_by: [T_RUNNING('SIGINT'), T_RUNNING('SIGTERM'), T_RUNNING('SIGHUP')],
  },
  {
    id: 'W20', file: RUN,
    from: "  'function go() {',\n",
    to: "  'go(); function go() {',\n",
    why: 'the wrapper\'s supervisor runs the command without waiting for the go line: it starts before its group is registered',
    tests: [TW],
    killed_by: T_GO_WRAPPER,
  },
  {
    id: 'W21', file: RUN,
    from: '    // Thrown, not emitted: an argument list the system refuses (E2BIG).\n    await releaseLock();\n',
    to: '    throw e;\n',
    why: 'a supervisor the system refuses to start throws out of the wrapper: it exits 1 and leaves its lock held',
    tests: [TW],
    killed_by: T_SPAWN_REFUSED,
  },
  {
    id: 'W22', file: RUN,
    from: "  \"try { run = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] }); } catch (err) { report({ error: err.code ?? err.message }); stop(); return; }\",",
    to: "  \"run = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });\",",
    why: 'an exec failure Node throws (ENOEXEC, ENOTDIR) crashes the supervisor with no report: 125 where it is 126',
    tests: [TW],
    killed_by: T_EXEC_FAILURE,
  },
  {
    id: 'W23', file: RUN,
    from: '  return RESOURCE_ERRORS.has(code) ? 125 : 126;',
    to: '  return 126;',
    why: 'a system out of processes or descriptors reads as a command that cannot be executed, not as the wrapper\'s own failure',
    tests: [TW],
    killed_by: T_EXEC_FAILURE,
  },

  // ---- E: who must not inherit the proof ----------------------------------------
  {
    id: 'E1', file: SESSION,
    from: "  'AGENTIC_HEAVY_LOCK_PROOF',\n  'AGENTIC_HEAVY_LOCK_VIA',\n",
    to: '',
    why: 'a test run and a test process inherit the proof: a fixture\'s harness joins the operator\'s lock instead of its own',
    tests: [TH],
    killed_by: T_SCRUB,
  },
  {
    id: 'E2', file: WORKER,
    from: "  'AGENTIC_HEAVY_LOCK_PROOF', 'AGENTIC_HEAVY_LOCK_VIA',\n",
    to: '',
    why: 'an autopilot worker inherits the proof: its checks join the holder that started the driver',
    tests: [TH],
    killed_by: T_SCRUB,
  },
];
