// Mutation spec — do the tests of a harness test launch's scope catch the
// defects C154 guards against (ADR-0023 §6, amendments of 2026-11-22 and
// 2026-11-24, the mutation harness)?
//
// Run: npm run mutate -- scripts/mutation-specs/harness-scope.mjs
//
// Each case removes one gate or fail-closed rule: a reader that lets a scope
// not read gone go, a kill written while the harness that launched the scope
// lives, a copied identity that grants a kill, a harness that unregisters its
// entry (and so frees its copy and the lock) on a scope it did not read gone,
// one that starts another run while it keeps such an entry, and one that sends
// the go line with no identity on its entry. S7–S10 are an autopilot check's
// record (lib/heavy-check.mjs checkHolds, which verify-run's release and the
// scratch sweep take): a harness test run that still runs or whose scope is
// not read gone, a copy an entry names inside the check's directory, a lock
// directory that is not the recorded one, and a record that is missing where
// records are required, each of which keeps the directory. S11–S16 are the
// first critique's round (refine): an entry read again whose directory a close
// renamed between the listing and the read, a group still running at a run's
// end whose scope reads gone later, a signal's stop that answers settled while
// a scoped end is pending, the CLI's copies while a kept scope is not read
// gone, a mount over the groups directory or an entry, and a dead run whose
// check's harness left work not over. The live boundary (a real scope
// whose leftover outlives its group) is held by
// tests/scripts/test-mutation-harness-scope-live.mjs, a large-tier file no
// case here selects.

const LOCK = 'plugins/orchestrator/scripts/lib/heavy-lock.mjs';
const SCOPE = 'plugins/orchestrator/scripts/lib/heavy-scope.mjs';
const CHECK = 'plugins/orchestrator/scripts/lib/heavy-check.mjs';
const H = 'scripts/mutation-harness.mjs';

const DEAD_RUNS = 'plugins/orchestrator/adapters/claude/autopilot/dead-runs.mjs';

const TS = 'tests/orchestrator/test-heavy-scope.mjs';
const THS = 'tests/scripts/test-mutation-harness-scope.mjs';
const THSS = 'tests/scripts/test-mutation-harness-scope-stop.mjs';
const TC = 'tests/orchestrator/test-heavy-check.mjs';
const TDR = 'tests/orchestrator/test-autopilot-dead-runs.mjs';

export const TESTS = [TS, THS, THSS, TC, TDR];

export const MUTATIONS = [
  {
    id: 'S1', file: LOCK,
    from: "      if (reading?.state === 'gone') return;\n",
    to: '      return;\n',
    why: 'a reader lets an entry go whose group ended while its scope is not read gone: the lock is taken beside what left the group',
    tests: [TS],
    killed_by: /a dead group whose scope is not read gone keeps the entry running/,
  },
  {
    id: 'S2', file: SCOPE,
    from: '          if (!gone) continue;\n',
    to: '',
    why: 'a collector writes the kill while the harness that launched the scope still lives',
    tests: [TS],
    killed_by: /writes no kill while the supervisor lives/,
  },
  {
    id: 'S3', file: SCOPE,
    from: "  if (owner.kind !== 'harness-launch' || owner.entry !== name || owner.token !== token || identity.gate.pid !== entry.pgid) {\n",
    to: '  if (false) {\n',
    why: 'an identity copied from another entry grants a kill and holds the lock',
    tests: [TS],
    killed_by: [/a copied identity grants nothing/, /judged by its group alone/],
  },
  {
    id: 'S4', file: H,
    from: "      if (reading.state !== 'gone') {\n        KEPT.set(child.pid, { unit, identity });\n",
    to: "      if (false) {\n        KEPT.set(child.pid, { unit, identity });\n",
    why: 'the harness unregisters a run\'s entry on a scope it did not read gone, and scores the run',
    tests: [THS],
    killed_by: /a scope not read gone fails the run as no verdict/,
  },
  {
    id: 'S5', file: H,
    from: '  if (KEPT.size > 0) {\n',
    to: '  if (false) {\n',
    why: 'the harness starts another run while it keeps the entry of a scope not read gone',
    tests: [THS],
    killed_by: /a scope not read gone fails the run as no verdict/,
  },
  {
    id: 'S6', file: H,
    from: '            harnessError(() => entry.recordScope(scopedRecord(identity)));\n',
    to: '',
    why: 'the gate\'s word and the go line are sent with no identity on the run\'s entry: a harness killed then leaves a scope no reader can end',
    tests: [THS],
    killed_by: /records the identity on its entry before the go line/,
  },
  {
    id: 'S7', file: CHECK,
    from: '      if (held.length > 0) return ',
    to: '      if (false) return ',
    why: 'a check\'s directory and lock entries go while a test run of its harness still runs or its scope is not read gone',
    tests: [TC],
    killed_by: /a row \(a group that runs, a scope not read gone\) keeps the directory/,
  },
  {
    id: 'S8', file: CHECK,
    from: '    if (copies.length > 0) return ',
    to: '    if (false) return ',
    why: 'a check\'s directory is removed while a heavy-work entry still names a copy inside it',
    tests: [TC],
    killed_by: /naming a copy inside the directory keeps it/,
  },
  {
    id: 'S9', file: CHECK,
    from: " || String(st.dev) !== String(lockDir.dev) || String(st.ino) !== String(lockDir.ino)) {\n",
    to: ') {\n',
    why: 'an ownership is read absent (retired) under a lock directory that is not the one the harness recorded',
    tests: [TC],
    killed_by: /not the recorded one/,
  },
  {
    id: 'S10', file: CHECK,
    from: '      if (!required && /is missing$/.test(read.problem)) return null;\n',
    to: '      if (/is missing$/.test(read.problem)) return null;\n',
    why: 'a check record lost in a root whose checks have records lets the directory go',
    tests: [TC],
    killed_by: /a missing record keeps the directory where records are required/,
  },
  {
    id: 'S11', file: LOCK,
    from: '          if ((d !== first || listed.includes(d)) && !existsSync(d)) moved = true;\n',
    to: '          if (d !== first && !existsSync(d)) moved = true;\n',
    why: 'an entry read again is read absent when a close renamed its directory between the listing and the read: a scope recorded meanwhile is let go',
    tests: [TS],
    killed_by: /a close that renames the entry's directory between the read again's listing and its read/,
  },
  {
    id: 'S12', file: H,
    from: '      if (!ended) STUCK.add(child.pid);\n',
    to: '',
    why: 'a run whose group still runs at its end and whose scope is not read gone is not marked stuck: a scope read gone later lets the copies go under the live group',
    tests: [THS],
    killed_by: /keeps its entry and copies/,
  },
  {
    id: 'S13', file: H,
    from: '    if (PENDING.size === 0 && [...HALTED]',
    to: '    if ([...HALTED]',
    why: 'a signal\'s stop answers settled while a scoped run is still ending its scope: the copies are removed and the lock released under it',
    tests: [THSS],
    killed_by: /stopRuns does not answer settled while a scoped run's end is pending/,
  },
  {
    id: 'S14', file: H,
    from: '  if (kept.length > 0) {\n',
    to: '  if (false) {\n',
    why: 'the CLI removes its copies while a scope kept at a run\'s end is not read gone',
    tests: [THS],
    killed_by: /keeps its entry and copies/,
  },
  {
    id: 'S15', file: CHECK,
    from: '      if (check(fd, what, dir) !== mnt) throw new Error(`a mount is placed over ${what}`);\n',
    to: '      check(fd, what, dir);\n',
    why: 'a check record\'s ownership is read through a mount placed over the groups directory or an entry: an absent ownership there reads as retired',
    tests: [TC],
    killed_by: /reads pinned to the lock directory's mount/,
  },
  {
    id: 'S16', file: DEAD_RUNS,
    from: '    complete = unresolved.length === 0 && held.length === 0;\n',
    to: '    complete = unresolved.length === 0;\n',
    why: 'a dead run whose verification check\'s harness left work not over is cleaned up: its record goes, and the leftover sweep may remove the check\'s directory',
    tests: [TDR],
    killed_by: /a dead run whose verification check's harness left work not over is live/,
  },
];
