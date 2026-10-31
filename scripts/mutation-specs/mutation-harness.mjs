// Mutation spec — do the harness's own tests catch the defects C135, C102 and
// C101 were about?
//
// Run: npm run mutate -- scripts/mutation-specs/mutation-harness.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. Every defect below leaves the harness working
// on an ordinary spec: a timeout that is ignored, or scored as a kill, shows
// only on a run that hangs; a lock that two runs both take, or that nobody
// recovers, shows only when runs meet; a repeated id shows only in a spec that
// repeats one. Each mutation breaks one rule and names the test that must
// notice.
//
// Groups: O the timeout's sources and its refusals, R what a run past the
// timeout is and what it leaves behind, I the mutation ids, L the run lock and
// the CLI's cleanup on a signal; R9–R10 are the supervisor's report, the only
// test result. Two defects have no mutation: a test run that leads no process
// group of its own cannot be stopped at its timeout, so its test hangs instead
// of failing; and a zombie holder is not a case a test can make, since node
// reaps the children it spawns. S is the static check (`--static`): the cases
// it reports, the copy each case gets, and its CLI. C is the files the control
// runs.

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const T = 'tests/scripts/test-mutation-harness.mjs';
const H = 'scripts/mutation-harness.mjs';
// The lock itself moved to the shared heavy-work lock (ADR-0068 Decision 6);
// its cases keep their ids and their tests.
const LOCK = 'plugins/orchestrator/scripts/lib/heavy-lock.mjs';

const T_FLAG = /^defaults to 900 s; the flag beats the environment$/;
const T_REFUSE = /^refuses a value that is not a whole number of seconds from 1, naming its source$/;
const T_HUNG = /^scores the hung mutation TIMEOUT, never a kill or a failure to start, stops what it started, and goes on$/;
const T_CONTROL_HUNG = /^refuses to score anything when the control passes the timeout$/;
const T_LEFTOVER = /^stops what a finished test run left running$/;
const T_ESCAPE = /^bounds the output too: a process that left the group holding the pipe does not hold the harness$/;
const T_NESTED = /^a nested harness's test run ends with the outer run that stopped it$/;
const T_CLI_TIMEOUT = /^the CLI hands --timeout and the environment's timeout to its runs, and refuses a bad one without waiting$/;
const T_SIGKILL = /^a CLI killed with SIGKILL: its test run ends with it, and the next run takes its lock$/;
const T_GUARD = /^leaves a stale lock to the reaper whose guard holds it until that reaper is gone$/;
const T_IDS = /^refuses a repeated or missing id, and an --only id the spec lacks even beside one it has$/;
const T_IDS_RUN = /^runSpec refuses them before running anything$/;
const T_ALL_SPECS = /^every spec in scripts\/mutation-specs passes the id check$/;
const T_SHARED = /^worktrees share one lock; the second waits until the first releases it$/;
const T_STALE = /^takes over a lock whose holder is gone: dead, a reused pid, or no holder named$/;
const T_HOST = /^waits for a holder on another host instead of judging it$/;
const T_TURNS = /^two CLI runs in two worktrees take turns: their test runs never overlap$/;
const T_SIGNAL = /^a signal to the CLI stops its test run, and only then releases the lock$/;
const T_LAUNCH = /^a runner that cannot start, or a supervisor that dies without a report, is no verdict$/;
const T_GUARD_SAME = /^removes a dead reaper's guard only while it is still the guard it judged$/;
const T_GUARD_CAPTURE = /^captures only the dead reaper's guard it judged, whatever replaced it after its last read$/;
const T_TZ = /^judges a live holder running whatever time zone the waiter runs in$/;
const T_SCHEME = /^does not compare a start spelled in a scheme the reader does not use$/;
const T_STOPPING = /^starts no test run once its runs are being stopped$/;
const T_UNKILLABLE = /^a signal keeps the lock while a test run will not end, and releases it once it has$/;
const T_STATIC_CASES = /^reports each case that would not apply, and runs no test$/;
const T_STATIC_SPECS = /^reports a spec that does not load, or names a test file the tree lacks, and goes on$/;
const T_STATIC_COPY = /^gives each case the copy as it was: what an earlier case added, removed or changed is undone$/;
const T_STATIC_DANGLING = /^replaces a copy whose root became a link that points nowhere, and goes on$/;
const T_STATIC_COARSE = /^tells a same-size rewrite of a file just put back, on a filesystem whose times are coarse$/;
const T_STATIC_CLI = /^the CLI checks every spec in scripts\/mutation-specs by default, and exits 1 on drift$/;
const T_CONTROL_ONLY = /^runs the control over the selected cases' files only, the spec default for a case that names none$/;
const T_CONTROL_BARE = /^refuses a selected case scored against no test file, beside one that names a passing file$/;

export const TESTS = [T];

export const MUTATIONS = [
  // ---- O: the timeout -----------------------------------------------------
  {
    id: 'O1', file: H,
    from: "  if (flag !== undefined) return parseTimeoutSeconds(flag, '--timeout');\n",
    to: '',
    why: '--timeout is ignored: the operator cannot give a long suite more time (C135)',
    killed_by: T_FLAG,
  },
  {
    id: 'O2', file: H,
    from: '  if (env[TIMEOUT_ENV] !== undefined) return parseTimeoutSeconds(env[TIMEOUT_ENV], TIMEOUT_ENV);\n',
    to: '',
    why: 'MUTATION_HARNESS_TIMEOUT is ignored',
    killed_by: T_FLAG,
  },
  {
    id: 'O3', file: H,
    from: '!/^[1-9][0-9]*$/.test(text)',
    to: '!/^[0-9]+$/.test(text)',
    why: 'a timeout of 0 s, or one with a leading zero, is accepted',
    killed_by: T_REFUSE,
  },
  {
    id: 'O4', file: H,
    from: ' || Number(text) > MAX_TIMEOUT_SECONDS',
    to: '',
    why: 'a timeout setTimeout cannot hold is accepted, and fires at once',
    killed_by: T_REFUSE,
  },

  // ---- R: a run past the timeout is no verdict -------------------------------
  {
    id: 'R1', file: H,
    from: '      if (timedOut) {\n        done(',
    to: '      if (false) {\n        done(',
    why: 'a stopped run is read as an exit: a timeout becomes a kill or "did not exit" (C135)',
    killed_by: [T_HUNG, T_CONTROL_HUNG],
  },
  {
    id: 'R2', file: H,
    from: '    if (out.timedOut) {',
    to: '    if (false) {',
    why: 'a mutation run stopped at the timeout is scored KILLED (C135)',
    killed_by: T_HUNG,
  },
  {
    id: 'R3', file: H,
    from: '  if (control.timedOut) throw',
    to: '  if (false) throw',
    why: 'a control stopped at the timeout is reported as a control that is not green',
    killed_by: T_CONTROL_HUNG,
  },
  {
    id: 'R4', file: H,
    from: '    process.kill(GROUPS ? -pid : pid, signal);',
    to: '    process.kill(pid, signal);',
    why: 'only the runner is stopped: the test files and what they started keep running',
    killed_by: [T_HUNG, T_LEFTOVER],
  },
  {
    id: 'R5', file: H,
    from: "      // What the run left behind ends with it, and its output pipe closes.\n      stopRun(child.pid, 'SIGKILL');\n",
    to: '',
    why: 'a process a passing run left behind outlives it',
    // Equivalent since the run settles only once its group is gone (ADR-0068
    // Decision 6; heavy-lock.mjs H4 holds that wait): the teardown at the
    // run's close kills what it left. The kill at the runner's exit still
    // closes the output pipe early for a process the runner itself started
    // holding it, a case no test makes.
    expect: 'SURVIVED',
  },
  {
    id: 'R6', file: H,
    from: `  "process.stdin.on('end', stop);",\n`,
    to: '',
    why: 'the supervisor ignores the end of its lifeline: a test run outlives a harness killed with SIGKILL, or a nested one',
    killed_by: [T_SIGKILL, T_NESTED],
  },
  {
    id: 'R7', file: H,
    from: '      exit = { code, signal };\n',
    to: '      exit = { code, signal };\n      clearTimeout(timer);\n',
    why: 'the deadline ends at the runner\'s exit: a process holding the output pipe holds the harness',
    killed_by: T_ESCAPE,
  },
  {
    id: 'R8', file: H,
    from: '    const timeoutSeconds = resolveTimeoutSeconds(opts.timeout);\n',
    to: '    const timeoutSeconds = DEFAULT_TIMEOUT_SECONDS; resolveTimeoutSeconds(opts.timeout);\n',
    why: 'the CLI checks --timeout and the environment but runs with the default',
    killed_by: T_CLI_TIMEOUT,
  },
  {
    id: 'R9', file: H,
    from: "  \"run.on('error', (err) => { report({ error: err.message }); process.exit(1); });\",\n",
    to: "  \"run.on('error', () => process.exit(127));\",\n",
    why: 'a runner that cannot start goes unreported: "failed to start" becomes a run with no report',
    killed_by: T_LAUNCH,
  },
  {
    id: 'R10', file: H,
    from: '      if (report === null) {\n',
    to: '      if (report === null) {\n        done({ status: exit.code, timedOut: false, failing: [], failingPaths: [], stdout });\n        return;\n',
    why: 'the supervisor\'s exit status is read as the test result: a supervisor that died scores as a test that failed, so as a kill',
    killed_by: T_LAUNCH,
  },

  // ---- I: mutation ids ------------------------------------------------------
  {
    id: 'I1', file: H,
    from: '  if (repeated.size > 0) {',
    to: '  if (false) {',
    why: 'a repeated id is accepted: two cases share a copy and a verdict (C102)',
    killed_by: [T_IDS, T_IDS_RUN],
  },
  {
    id: 'I2', file: H,
    from: '  if (unknown.length > 0) {',
    to: '  if (false) {',
    why: 'an --only id the spec lacks is dropped while another one runs',
    killed_by: [T_IDS, T_IDS_RUN],
  },
  {
    id: 'I3', file: H,
    from: '  if (missing > 0) throw',
    to: '  if (false) throw',
    why: 'a mutation without an id is accepted',
    killed_by: T_IDS,
  },
  {
    id: 'I4',
    prepare: (copy) => appendFileSync(
      join(copy, 'scripts/mutation-specs/landing-ready.mjs'),
      '\nMUTATIONS.push({ ...MUTATIONS[0] });\n',
    ),
    why: 'a spec in the repository repeats an id',
    killed_by: T_ALL_SPECS,
  },

  // ---- L: the run lock and the CLI's cleanup ----------------------------------
  {
    id: 'L1', file: LOCK,
    from: '    linkSync(tmp, target);',
    to: '    writeFileSync(target, readFileSync(tmp));',
    why: 'taking the lock replaces the holder\'s: two runs run at once (C101)',
    killed_by: [T_SHARED, T_TURNS],
  },
  {
    id: 'L2', file: H,
    from: '    lock = await acquireRunLock(repoRoot, { spec: opts.spec });',
    to: '    lock = { release() {} };',
    why: 'the CLI takes no lock (C101 as it was)',
    killed_by: [T_TURNS, T_SIGNAL],
  },
  {
    id: 'L3', file: LOCK,
    from: '  if (!processAlive(record.pid)) return false;\n',
    to: '',
    why: 'a lock whose holder was killed is never recovered: every later run waits for ever',
    killed_by: [T_STALE, T_SIGKILL],
  },
  {
    id: 'L4', file: LOCK,
    from: '  return record.started === info.started;\n',
    to: '  return true;\n',
    why: 'a dead holder\'s pid, reused by another process, keeps its lock held for ever',
    killed_by: T_STALE,
  },
  {
    id: 'L5', file: LOCK,
    from: '      if (reaper.record !== null && reaper.record.token === name && running(reaper.record)) continue;\n',
    to: '',
    why: 'a live reaper\'s guard is taken: two reapers, and one may remove the lock the other\'s run took',
    killed_by: T_GUARD,
  },
  {
    id: 'L6', file: LOCK,
    from: '  if (record.host !== hostname()) return true;\n',
    to: '',
    why: 'a holder on another host is judged by a pid that means nothing here',
    killed_by: T_HOST,
  },
  {
    id: 'L7', file: LOCK,
    from: '      if (readLock(path)?.record?.token === record.token) unlinkSync(path);',
    to: '      unlinkSync(path);',
    why: 'a run releases the lock another run holds',
    killed_by: T_SHARED,
  },
  {
    id: 'L8', file: H,
    from: '      }\n      cleanUp();\n    } catch (err) {',
    to: '      }\n    } catch (err) {',
    why: 'a signal to the CLI leaves its lock behind, for the next run to wait on until it judges it stale',
    killed_by: T_SIGNAL,
  },
  {
    id: 'L9', file: H,
    from: '    try {\n      while (!(await stopRuns())) {',
    to: '    try {\n      cleanUp();\n      while (!(await stopRuns())) {',
    why: 'a signal releases the lock while the run still runs: another harness can start beside it',
    killed_by: T_SIGNAL,
  },
  {
    id: 'L10', file: LOCK,
    from: '        renameSync(join(guard, name), captured);\n',
    to: '        rmSync(guard, { recursive: true, force: true });\n',
    why: 'a waiter removes the guard by its name, not the entry it judged: the guard a live reaper placed meanwhile goes, two reapers, two holders',
    killed_by: [T_GUARD_SAME, T_GUARD_CAPTURE],
  },
  {
    id: 'L11', file: LOCK,
    from: "LC_ALL: 'C', TZ: 'UTC' }",
    to: "LC_ALL: 'C' }",
    why: 'ps spells a start time in the reader\'s time zone: a waiter elsewhere takes a live holder\'s lock',
    // Equivalent on Linux, whose reader takes the start from /proc, not ps.
    ...(process.platform === 'linux' ? { expect: 'SURVIVED' } : { killed_by: T_TZ }),
  },
  {
    id: 'L12', file: LOCK,
    from: " || startScheme(record.started) !== startScheme(info.started)) return true;",
    to: ') return true;',
    why: 'a start another version of the harness spelled reads as a reused pid: a live holder loses its lock',
    killed_by: T_SCHEME,
  },
  {
    id: 'L13', file: H,
    from: '      while (!(await stopRuns())) {',
    to: '      if (!(await stopRuns())) {',
    why: 'a signal releases the lock once its wait for the runs times out, while a run still runs',
    killed_by: T_UNKILLABLE,
  },
  {
    id: 'L14', file: H,
    from: '    if (stopping) {\n',
    to: '    if (false) {\n',
    why: 'a run starts while the harness stops its runs: nothing stops it, and the lock is released beside it',
    killed_by: T_STOPPING,
  },
  {
    id: 'L15', file: LOCK,
    from: '      judged();\n      const captured',
    to: '      const again = readLock(join(guard, name));\n      judged();\n      if (again?.raw === reaper.raw) { rmSync(guard, { recursive: true, force: true }); log(`mutation-harness: removed the guard of a reaper that is not running (${guard})`); continue; }\n      const captured',
    why: 'the re-check, then remove, is back: a waiter re-reads the dead reaper\'s guard, then removes the guard by its name, and the guard a live reaper placed after that read goes with it (C101)',
    killed_by: T_GUARD_CAPTURE,
  },

  // ---- S: the static check ------------------------------------------------
  {
    id: 'S1', file: H,
    from: '        states = restoreCopy(work, pristine, states, lstat);\n',
    to: '',
    why: 'one copy serves every case and nothing puts it back: a case sees what the cases before it did',
    killed_by: T_STATIC_COPY,
  },
  {
    id: 'S2', file: H,
    from: '    if (!states.has(path)) removePath(join(work, path));\n',
    to: '',
    why: 'a path a case added stays for the cases after it',
    killed_by: T_STATIC_COPY,
  },
  {
    id: 'S3', file: H,
    from: '`${st.mode}:${st.size}:${st.ino}:${st.mtimeNs}:${st.ctimeNs}`',
    to: '`${st.size}`',
    why: 'a change is told by the size alone: a same-size rewrite stays for the cases after it',
    killed_by: T_STATIC_COPY,
  },
  {
    id: 'S4', file: H,
    from: "      if (current !== undefined && !current.startsWith('dir:')) removePath(abs);\n",
    to: '',
    why: 'a file a case put where a directory was is not removed, so the directory cannot be put back',
    killed_by: T_STATIC_COPY,
  },
  {
    id: 'S5', file: H,
    from: "        lacking('tests', mutation.tests ?? []);\n",
    to: '',
    why: 'a case naming a test file the tree lacks passes the check, and its run fails at the control',
    killed_by: T_STATIC_CASES,
  },
  {
    id: 'S6', file: H,
    from: "      lacking('TESTS', spec.TESTS ?? []);\n",
    to: '',
    why: 'a spec whose TESTS name a file the tree lacks passes the check',
    killed_by: T_STATIC_SPECS,
  },
  {
    id: 'S7', file: H,
    from: '      } catch (err) {\n        const detail = ',
    to: '      } catch (err) {\n        if (!(err instanceof MutationHarnessError)) throw err;\n        const detail = ',
    why: 'a prepare that throws outside the harness stops the whole check instead of being reported',
    killed_by: T_STATIC_CASES,
  },
  {
    id: 'S8', file: H,
    from: '    } catch (err) {\n      const error = ',
    to: '    } catch (err) {\n      throw err;\n      const error = ',
    why: 'a spec that does not load stops the check: the specs after it are never checked',
    killed_by: T_STATIC_SPECS,
  },
  {
    id: 'S9', file: H,
    from: '      return drift === 0 ? 0 : 1;\n',
    to: '      return 0;\n',
    why: 'the CLI exits 0 whatever drifted',
    killed_by: T_STATIC_CLI,
  },
  {
    id: 'S10', file: H,
    from: '      const specs = opts.specs.length > 0 ? opts.specs : listSpecs(repoRoot);\n',
    to: '      const specs = opts.specs;\n',
    why: 'with no spec named the CLI checks none, and reports no drift',
    killed_by: T_STATIC_CLI,
  },
  {
    id: 'S11', file: H,
    from: '      if (opts.only.length > 0 && specs.length !== 1) {\n',
    to: '      if (false) {\n',
    why: '--only beside several specs is taken, though an id names a case of one spec',
    killed_by: T_STATIC_CLI,
  },
  {
    id: 'S12', file: H,
    from: '      chmodSync(abs, Number(state.slice(4)) & 0o7777);\n',
    to: '',
    why: 'a directory\'s mode is not put back: a case sees the mode an earlier case left',
    killed_by: T_STATIC_COPY,
  },
  {
    id: 'S13', file: H,
    from: '  if ((mode & 0o700) !== 0o700) chmodSync(abs, (mode & 0o7777) | 0o700);\n',
    to: '',
    why: 'a directory a case closed is not opened, so the restore cannot read it',
    killed_by: T_STATIC_COPY,
  },
  {
    id: 'S14', file: H,
    from: "          log(`${specPath}  ${mutation.id}  the copy could not be put back (${thrown(err)}); it is made again`);\n          states = freshWork();\n",
    to: '          throw err;\n',
    why: 'a copy the restore cannot put back stops the whole check',
    killed_by: T_STATIC_COPY,
  },
  {
    id: 'S15', file: H,
    from: '      controlTestsOf(specPath, spec, mutations);\n',
    to: '',
    why: 'a spec that names no test file passes the check, though a run refuses it',
    killed_by: T_STATIC_SPECS,
  },
  {
    id: 'S16', file: H,
    from: '  if (err instanceof Error) return `${err.name}: ${err.message}`;\n',
    to: '  return `${err.name}: ${err.message}`;\n',
    why: 'a prepare that throws what is not an Error stops the whole check',
    killed_by: T_STATIC_CASES,
  },
  {
    id: 'S17', file: H,
    from: '  if (specs.length === 0) throw new MutationHarnessError(`${SPEC_DIR} holds no spec`);\n',
    to: '',
    why: 'with no spec to check, the CLI reports no drift and exits 0',
    killed_by: T_STATIC_CLI,
  },
  {
    // Not dropping ctimeNs: on a filesystem with fine change times it tells
    // too, so the modification time is tested where the change time is coarse.
    id: 'S18', file: H,
    from: '`${st.mode}:${st.size}:${st.ino}:${st.mtimeNs}:${st.ctimeNs}`',
    to: '`${st.mode}:${st.size}:${st.ino}:${st.ctimeNs}`',
    why: 'a change is told by the change time: where it is coarse, a same-size rewrite in the tick of the restore stays',
    killed_by: T_STATIC_COARSE,
  },
  {
    id: 'S19', file: H,
    from: '    lutimesSync(abs, SETTLED, SETTLED);\n',
    to: '',
    why: 'a file the restore put back keeps the time it was written at: a same-size rewrite in that tick stays',
    killed_by: T_STATIC_COARSE,
  },
  {
    id: 'S20', file: H,
    from: '    settleTimes(work);\n',
    to: '',
    why: 'the files of a new copy keep the time they were copied at: a same-size rewrite in that tick stays',
    killed_by: T_STATIC_COARSE,
  },
  {
    id: 'S21', file: H,
    from: "    out.set('', dirState(root));\n",
    to: '',
    why: 'the copy\'s own mode is not put back: a case closes it, and the next one\'s edit at the top cannot be undone',
    killed_by: T_STATIC_COPY,
  },
  {
    id: 'S22', file: H,
    from: '    if (!lstatSync(root).isDirectory()) throw new MutationHarnessError(`the work copy ${root} is no longer a directory`);\n',
    to: '',
    why: 'a link put where the copy was is followed: the restore empties the directory it points to and writes the copy there',
    killed_by: T_STATIC_COPY,
  },
  {
    // Killed on node 24 before 24.13.1 (measured on 24.11.1), whose rmSync
    // leaves a link that points nowhere in place; on a fixed node it is an
    // equivalent mutation. The isolation test fails too (case G).
    id: 'S23', file: H,
    from: '  else unlinkSync(abs);\n',
    to: '  else rmSync(abs, { recursive: true, force: true });\n',
    why: 'a link that points nowhere is left in place: it stays for the cases after it, and one where the copy was aborts the check',
    killed_by: T_STATIC_DANGLING,
  },

  // ---- C: the control's files -----------------------------------------------
  {
    id: 'C1', file: H,
    from: '  const tests = [...new Set(mutations.flatMap((m) => m.tests ?? spec.TESTS ?? []))];\n',
    to: '  const tests = [...new Set([...(spec.TESTS ?? []), ...mutations.flatMap((m) => m.tests ?? [])])];\n',
    why: 'the control runs the spec default for a case scored against its own files: --only one case of a slow spec passes the timeout with no verdict',
    killed_by: T_CONTROL_ONLY,
  },
  {
    id: 'C2', file: H,
    from: '  const tests = [...new Set(mutations.flatMap((m) => m.tests ?? spec.TESTS ?? []))];\n',
    to: '  const tests = [...new Set(mutations.flatMap((m) => m.tests ?? []))];\n',
    why: 'a case that names no file of its own is scored against a default the control never ran',
    killed_by: T_CONTROL_ONLY,
  },
  {
    id: 'C3', file: H,
    from: '  const tests = [...new Set(mutations.flatMap((m) => m.tests ?? spec.TESTS ?? []))];\n',
    to: '  const tests = [...new Set(mutations[0]?.tests ?? spec.TESTS ?? [])];\n',
    why: 'the control runs the first selected case\'s files only: a second case is scored against a set the control never ran',
    killed_by: T_CONTROL_ONLY,
  },
  {
    id: 'C4', file: H,
    from: '  if (bare.length > 0) {\n',
    to: '  if (false) {\n',
    why: 'a case scored against no file runs node --test with none, the whole suite the control never ran: a failure anywhere in it scores the case KILLED',
    killed_by: T_CONTROL_BARE,
  },
];
