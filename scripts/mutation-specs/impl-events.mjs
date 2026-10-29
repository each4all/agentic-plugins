// Mutation spec — do the event file's tests catch the defects ADR-0068
// Decision 4 guards against?
//
// Run: npm run mutate -- scripts/mutation-specs/impl-events.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. The event file is a signal beside records
// that stay the truth, so a defect in it leaves every run working: a line
// that repeats an identity, a torn line joined to the next, a run-ended
// written twice or never, a halt published twice, a reader that skips, repeats
// or reports a pending terminal append as missing all show only to the session
// that watches. Each mutation breaks one rule and names the test that must
// notice it; each new test of impl-events has one here.
//
// Groups: W the writer (events.mjs), R the reader (events-reader.mjs and the
// CLI), D a serial run's publications (driver.mjs), L a run with lanes'
// (scheduler.mjs), C a dead run's cleanup (dead-runs.mjs), P the Monitor
// recipe (commands/autopilot.md).
//
// W7 (two writers in two processes) is probabilistic: without the lock, two
// processes appending 60 lines each repeat a seq in practice, not by proof.
// W20 too: a lock created empty is read empty by a polling reader in
// practice. W18's dead-lock test injects the failure at the removal of the
// lock itself, so it reaches the unremovable lock's branch on every system.
// R45 is killed only where a write of no bytes to a pipe whose reader is gone
// fails (macOS); its test is skipped where it does not (Linux takes the write
// as done), the platform's limit, not a test gap (ADR-0068 E6).
//
// Not guarded by a mutation: the reader's reconciliation taking a read that
// fails (other than a missing file) as "cannot tell" (no test makes a file
// unreadable between two polls of an unchanged size); the error path's
// release after its run-ended, guarded as finish's is (D15), so a lock entry
// that cannot be removed never replaces the run's own error. Each halt's place
// against run.json (L8, L12, L13) is read at the write itself, through the
// driver's `eventsWriteSync` seam.

const EV = 'plugins/orchestrator/adapters/claude/autopilot/events.mjs';
const RD = 'plugins/orchestrator/adapters/claude/autopilot/events-reader.mjs';
const DRV = 'plugins/orchestrator/adapters/claude/autopilot/driver.mjs';
const SCH = 'plugins/orchestrator/adapters/claude/autopilot/scheduler.mjs';
const DR = 'plugins/orchestrator/adapters/claude/autopilot/dead-runs.mjs';
const CLI = 'plugins/orchestrator/adapters/claude/autopilot/cli.mjs';
const DOC = 'plugins/orchestrator/commands/autopilot.md';

const TW = 'tests/orchestrator/test-autopilot-events.mjs';
const TR = 'tests/orchestrator/test-autopilot-events-reader.mjs';
const TD = 'tests/orchestrator/test-autopilot-events-driver.mjs';
const TL = 'tests/orchestrator/test-autopilot-events-lanes.mjs';
const TC = 'tests/orchestrator/test-autopilot-events-cleanup.mjs';
const TP = 'tests/orchestrator/test-autopilot-events-recipe.mjs';
// A dead run's stop tests, which hold what stop reports of a run it finds live.
const TDR = 'tests/orchestrator/test-autopilot-dead-runs.mjs';

export const TESTS = [TW, TR, TD, TL, TC, TP];

export const MUTATIONS = [
  // ---- W: the writer ---------------------------------------------------------
  {
    id: 'W1', file: EV, tests: [TW],
    from: '          ...(TERMINAL_KINDS.includes(kind) ? { terminal: true } : {}),',
    to: '',
    why: 'run-ended is no longer marked terminal, so a narrowed watch drops it',
    killed_by: /a line carries the fixed head, its kind's fields, and terminal only on run-ended/,
  },
  {
    id: 'W2', file: EV, tests: [TW],
    from: '  for (const k of Object.keys(fields)) if (!Object.hasOwn(spec, k)) return `${kind}: field ${k} is not one of its fields`;',
    to: '',
    why: 'a field outside its kind\'s allow-list (a detail, a summary) reaches the file',
    killed_by: /refuses text, a field its kind does not list/,
  },
  {
    id: 'W3', file: EV, tests: [TW],
    from: '  return Boolean(m && OWNER_GATES.includes(m[1]));',
    to: '  return false;',
    why: 'an owner gate\'s halt code is refused, so every gate halt goes unpublished',
    killed_by: /takes every owner gate as awaiting-owner:<gate>/,
  },
  {
    id: 'W4', file: EV, tests: [TW],
    from: '        used = seq;\n',
    to: '',
    why: 'a seq whose write failed is chosen again, so a line it may have torn and the next share an identity',
    killed_by: /a write that failed before any byte landed, then a success/,
  },
  {
    id: 'W5', file: EV, tests: [TW],
    from: '        appendLine(file, JSON.stringify(line), writeSync ? { writeSync } : {});',
    to: '        fs.appendFileSync(file, `${JSON.stringify(line)}\\n`);',
    why: 'a torn last line is not ended first, so the next line joins it and neither parses',
    killed_by: /a writer killed mid-line, then another writer/,
  },
  {
    id: 'W6', file: EV, tests: [TW],
    from: '    if (raw.trim()) {\n      try {',
    to: '    if (raw.trim() && complete) {\n      try {',
    why: 'a torn last line holding complete JSON does not count for the next seq, so its identity is repeated',
    killed_by: /a torn last line holding complete JSON counts for the next seq/,
  },
  {
    id: 'W7', file: EV, tests: [TW],
    from: '        release = lockEventFile(file, { waitMs });',
    to: '        release = () => {};',
    why: 'appends are not serialized: two writers choose the same seq',
    killed_by: /lines of two writers in two processes appending at once/,
  },
  {
    id: 'W8', file: EV, tests: [TW],
    from: "          if (kind === 'run-ended' && e.kind === 'run-ended' && e.run_id === runId && eventOfLine(e)) existing = e;",
    to: '',
    why: 'run-ended is written again by a cleanup after the driver\'s own',
    killed_by: /across a driver's writer, a cleanup's and a cleanup retried/,
  },
  {
    id: 'W9', file: EV, tests: [TW, TR],
    from: "          if (text.length > 0 && !text.endsWith('\\n')) fs.appendFileSync(file, '\\n');",
    to: '',
    why: 'a complete run-ended left with no newline stays held by every reader',
    killed_by: [/a complete run-ended its writer did not end with a newline/, /a complete run-ended a cleanup ended with its newline is delivered/],
  },
  {
    id: 'W10', file: EV, tests: [TW],
    from: "          if (kind === 'lane-released' && e.kind === 'lane-released' && e.release_id === fields.release_id && eventOfLine(e)) existing = e;",
    to: '',
    why: 'a release compared once is published by each run that finishes it',
    killed_by: /a lane-released is written once per release id/,
  },
  {
    id: 'W11', file: EV, tests: [TW],
    from: "      if (kind === 'run-ended') closed = true;",
    to: '',
    why: 'what a run does after its end (its last handoffs) is published after its run-ended',
    killed_by: /nothing is written after the run's run-ended/,
  },
  {
    id: 'W12', file: EV, tests: [TW],
    from: '    const stale = holder ? !pidAlive(holder.pid) : Date.now() - st.mtimeMs > LOCK_TORN_MS;',
    to: '    const stale = holder ? false : Date.now() - st.mtimeMs > LOCK_TORN_MS;',
    why: 'a lock whose writer died is waited on, and every write fails until it is old',
    killed_by: /a lock whose writer died is taken over/,
  },
  {
    id: 'W13', file: EV, tests: [TW],
    from: '    const stale = holder ? !pidAlive(holder.pid) : Date.now() - st.mtimeMs > LOCK_TORN_MS;',
    to: '    const stale = true;',
    why: 'a live writer\'s lock is taken from it',
    killed_by: /a lock a live writer holds past the bound is a counted failure/,
  },
  {
    id: 'W18', file: EV, tests: [TW],
    from: '    if (tried && clockMs() >= deadline) throw',
    to: '    if (tried && clockMs() >= deadline && !holder) throw',
    why: 'a retry after a lock that read whole (a live writer\'s, or a dead one\'s that cannot be removed) skips the bound: the synchronous writer never returns',
    killed_by: [/a dead writer's lock that cannot be removed is a counted failure at the bound/, /a lock a live writer holds past the bound is a counted failure/],
  },
  {
    id: 'W20', file: EV, tests: [TW],
    from: "      fs.writeFileSync(tmp, mine, { flag: 'wx' });\n      try {\n        fs.linkSync(tmp, lock);\n      } finally {\n        try { fs.unlinkSync(tmp); } catch { /* gone */ }\n      }",
    to: "      const fd = fs.openSync(lock, 'wx');\n      try {\n        fs.writeSync(fd, mine);\n      } finally {\n        fs.closeSync(fd);\n      }",
    why: 'the lock is created empty and written after: a live writer\'s lock can be read empty, and taken for a torn one',
    killed_by: /a lock is never seen empty/,
  },
  {
    id: 'W21', file: EV, tests: [TW],
    from: '`--checkout ${shellQuote(checkout)}`',
    to: '`--checkout ${checkout}`',
    why: 'a verb chain\'s watch command splits a checkout path with a space in it',
    killed_by: /a verb chain's watch command, run by a shell, passes its checkout as one word/,
  },
  {
    id: 'W19', file: EV, tests: [TW],
    from: '        release = lockEventFile(file, { waitMs });',
    to: '        release = lockEventFile(file, { waitMs, clockMs: now });',
    why: 'the lock\'s bound is measured on the run\'s event clock, which a frozen clock never moves past',
    killed_by: /a frozen event clock still ends the wait/,
  },
  {
    id: 'W14', file: EV, tests: [TW],
    from: "    return path.join(mainRoot, AUTOPILOT_DIR_REL, 'events', `${macroId}.jsonl`);",
    to: '    return path.join(mainRoot, AUTOPILOT_DIR_REL, `${macroId}.jsonl`);',
    why: 'a macro\'s file is not where the ADR fixes it',
    killed_by: /a macro's beside its landing log under the main worktree/,
  },

  // ---- R: the reader ----------------------------------------------------------
  {
    id: 'R1', file: RD, tests: [TR],
    from: '      at = i + 1;',
    to: '      at = i;',
    why: 'the cursor\'s own line is printed again on a re-arm',
    killed_by: /prints every event after the cursor, in file order/,
  },
  {
    id: 'R2', file: RD, tests: [TR],
    from: '        return stamp !== null && Number.isFinite(t) && t >= stamp;',
    to: '        return false;',
    why: 'R:0 starts at the run\'s first line only, losing a line another writer wrote after the run began',
    killed_by: /R:0 is from the run's first line, or the first line written since it began/,
  },
  {
    id: 'R3', file: RD, tests: [TR],
    from: "      if (i === -1) return fail('cursor-not-on-file', { run_id: c.runId, seq: c.seq });",
    to: '      if (i === -1) { at = 0; if (at < start) { start = at; lastCursor = cursorText(c); } continue; }',
    why: 'a cursor not found is read as "from the start"',
    killed_by: /a cursor naming a seq its run's lines on file do not hold is an error/,
  },
  {
    id: 'R4', file: RD, tests: [TR],
    from: "    if (st && !st.isFile()) return fail('unreadable');",
    to: '    if (st && !st.isFile()) return 0;',
    why: 'a file that cannot be read ends the watch silently',
    killed_by: /a file that cannot be read is a reader-error and exit 1/,
  },
  {
    id: 'R5a', file: RD, tests: [TR],
    from: "        say('reader-skipped', { offset });",
    to: '',
    why: 'a line that does not parse is dropped without a word',
    killed_by: /a seq missing within a run is a reader-gap hint/,
  },
  {
    id: 'R5b', file: RD, tests: [TR],
    from: "        say('reader-gap', { run_id: e.run_id, after_seq: prev, seq: e.seq });",
    to: '',
    why: 'a seq missing within a run is not hinted',
    killed_by: /a seq missing within a run is a reader-gap hint/,
  },
  {
    id: 'R6', file: RD, tests: [TR],
    from: '      folded = null;\n    };',
    to: '      folded = null;\n      budget = stallBudget;\n    };',
    why: 'a line between stall bursts resets the window\'s budget, so alternating bursts are never bounded',
    killed_by: /a backlog folds only stall lines past the window's budget/,
  },
  {
    id: 'R7', file: RD, tests: [TR],
    from: '    if (nl === -1) break;',
    to: '    if (nl === -1) { if (at < buf.length) lines.push({ offset: at, raw: buf.subarray(at).toString(\'utf8\') }); at = buf.length; break; }',
    why: 'a partial last line is passed on before its newline arrives',
    killed_by: /R:0 and a file not yet created wait; a partial last line is held/,
  },
  {
    id: 'R8', file: RD, tests: [TR],
    from: "      if (s.size < readTo) return fail('truncated');",
    to: '',
    why: 'a truncated file is followed on as if nothing happened',
    killed_by: /a file truncated or replaced while followed is a reader-error/,
  },
  {
    id: 'R9', file: RD, tests: [TR],
    from: '        readTo += more.length;',
    to: '',
    why: 'what follow read is read again, repeating events across the watch',
    killed_by: [/replay from a recorded position across a relaunch, through the CLI/, /a partial last line is held until its newline arrives/],
  },
  {
    id: 'R10', file: RD, tests: [TR],
    from: '  const tracked = new Set(cursors.map((c) => c.runId)); // runs whose end is watched',
    to: '  const tracked = new Set(); // runs whose end is watched',
    why: 'a run with no line on file (every write failed) is never reported missing its end',
    killed_by: /a run whose every write failed, then the next run's lines/,
  },
  {
    id: 'R11', file: RD, tests: [TR],
    from: '      if (f.live || f.cleaning) continue;',
    to: '      if (f.cleaning) continue;',
    why: 'a terminal append under way (the driver alive) is reported missing',
    killed_by: /is not reported while the driver lives/,
  },
  {
    id: 'R12', file: RD, tests: [TR],
    from: '    if (now() - lastReconcile >= reconcileMs) {',
    to: '    if (false) {',
    why: 'a failed last write is found only at the next arm',
    killed_by: /a failed last write is found by the 30 s reconciliation while it follows/,
  },
  {
    id: 'R13', file: RD, tests: [TR],
    from: '      if (endedOnFile(file, runId) !== false) continue;',
    to: '',
    why: 'a run-ended written after the reader read the file (the driver\'s last line, then its record gone) is reported missing',
    killed_by: /a run-ended written after the reader read the file is not reported missing/,
  },
  {
    id: 'R17', file: RD, tests: [TR],
    from: '  const complete = text.split(\'\\n\');\n  complete.pop();',
    to: '  const complete = text.split(\'\\n\');',
    why: 'a complete run-ended with no newline counts as the run\'s end while delivery holds it: neither the end nor its report is printed',
    killed_by: /a complete run-ended with no newline, its driver gone and no cleanup under way/,
  },
  {
    id: 'R18', file: RD, tests: [TR],
    from: '  for (const runId of order) if (!ended.has(runId)) tracked.add(runId);',
    to: '  for (const runId of order) { if (ended.has(runId) || tracked.has(runId)) continue; const f = await runFacts(runId, { runDir: runDirs.get(runId) ?? null }); if (f && (f.live || f.open)) tracked.add(runId); }',
    why: 'a re-arm watches a run before its cursor only while its driver lives or its record is left: one whose end write failed while no reader watched is dropped',
    killed_by: [/a re-arm past an unfinished run's lines/, /after a restart armed at two runs' R:0/],
  },
  {
    id: 'R19', file: RD, tests: [TR],
    from: '    for (const runId of [...order, ...cursors.map((c) => c.runId).filter((r) => !order.includes(r))]) {',
    to: '    for (const runId of order.length ? order : cursors.map((c) => c.runId)) {',
    why: 'the armed line names the latest run on file, not a later run a cursor names that has no line yet',
    killed_by: /after a restart armed at two runs' R:0/,
  },

  // ---- D: a serial run --------------------------------------------------------
  {
    id: 'D1', file: DRV, tests: [TD],
    from: '        publishCommits(landing);\n      } catch (e) {',
    to: '      } catch (e) {',
    why: 'a serial run\'s commit is never published',
    killed_by: /a halt and a completion: each kind once/,
  },
  {
    id: 'D2', file: DRV, tests: [TD],
    from: '      publishStepEnd(seq, s, id, verdict, w.aborted);',
    to: '',
    why: 'a serial step that fails publishes nothing of it',
    killed_by: /a step that fails: its step-failed with the halt code/,
  },
  {
    id: 'D3', file: DRV, tests: [TD],
    from: '    step: seq, reason, abort: ABORT_KINDS.includes(aborted) ? aborted : null, pointer: stepsFile,',
    to: '    step: seq, reason, abort: null, pointer: stepsFile,',
    why: 'a step\'s abort kind is lost',
    killed_by: /an interrupt during a step: step-failed with its abort kind/,
  },
  {
    id: 'D4', file: DRV, tests: [TD],
    from: "    if (active) publishStepFailed(active.seq, active.subtaskId, 'error', active.aborted);",
    to: '',
    why: 'a step in flight when the run stops on an error publishes nothing',
    killed_by: /a run that stops on an error: the step in flight's step-failed/,
  },
  {
    id: 'D5', file: RD, tests: [TD],
    from: "      if (!f || !f.run || typeof f.run.events !== 'object' || f.run.events === null) continue;",
    to: '      if (!f || !f.run) continue;',
    why: 'a launch refused at its locks is reported missing its terminal event',
    killed_by: /a launch refused at its locks writes no line/,
  },
  {
    id: 'D6', file: DRV, tests: [TD],
    from: '        run.events.failed_writes += 1;',
    to: '',
    why: 'a failed write is not counted in run.json',
    killed_by: /a write that fails is printed and counted in run.json/,
  },
  {
    id: 'D7', file: DRV, tests: [TD],
    from: '    message.slice(0, 180), title,',
    to: '    title, message.slice(0, 180),',
    why: '--notify-local\'s argument vector changes',
    killed_by: /--notify-local is unchanged/,
  },
  {
    id: 'D8', file: DR, tests: [TD],
    from: '    if (complete && !publishEnd({ mainRoot, record, run, dir: r.dir, now, haltFile })) writeRun(r.dir, run);',
    to: '',
    why: 'a dead run cleaned up at the next run\'s start gets no run-ended',
    killed_by: /the next run's start cleans up after a dead run/,
  },

  // ---- L: a run with lanes ----------------------------------------------------
  {
    id: 'L1', file: SCH, tests: [TL],
    from: '    pub.emit(\'lane-parked\', { reason: h.reason, step: Number.isInteger(h.seq) ? h.seq : null, kept, pointer: kept ? parkPath(mainRoot, macroId, id) : pub.lanesFile }, id);',
    to: '    pub.emit(\'lane-parked\', { reason: h.reason, step: Number.isInteger(h.seq) ? h.seq : null, kept, pointer: pub.lanesFile }, id);',
    why: 'a kept park\'s line points at the lane event, not at the park that holds the rest',
    killed_by: /a gate parks its lane \(kept, pointing at the park\)/,
  },
  {
    id: 'L2', file: SCH, tests: [TL],
    from: '    appendLaneEvent(runDir, { event: \'resumed\', subtask_id: id, why, record_id: rec?.record_id ?? null, run_id: runId, at: at() });\n    publishResumed(id, cause);',
    to: '    appendLaneEvent(runDir, { event: \'resumed\', subtask_id: id, why, record_id: rec?.record_id ?? null, run_id: runId, at: at() });',
    why: 'a parked lane picked up again publishes nothing',
    killed_by: /the parked lane picked up once its gate is cleared/,
  },
  {
    id: 'L3', file: SCH, tests: [TL],
    from: '    pub.stepEnd(entry.seq, s, id, verdict, w.aborted);',
    to: '',
    why: 'a lane\'s step that fails publishes nothing',
    killed_by: /a step that fails in a lane: its step-failed/,
  },
  {
    id: 'L4', file: SCH, tests: [TL],
    from: "        pub.emit('lane-held', { hold_id: r.holdId, pointer: pub.lanesFile }, id);",
    to: '',
    why: 'a hold handed over publishes nothing',
    killed_by: /a hold handed over: lane-held once/,
  },
  {
    id: 'L5', file: SCH, tests: [TL],
    from: '        publishRelease(id, holdId, r.release.release_id, r.verdict);',
    to: '',
    why: 'a release the driver compares publishes nothing',
    killed_by: /a release consumed: lane-released once/,
  },
  {
    id: 'L6', file: SCH, tests: [TL],
    from: '        publishRelease(id, holdId, r.release.release_id, r.verdict);',
    to: "        publishRelease(id, holdId, r.release.release_id, 'consumed');",
    why: 'a rejected release is published consumed',
    killed_by: /a release rejected: lane-released rejected/,
  },
  {
    id: 'L7', file: SCH, tests: [TL],
    from: "          publishRelease(id, holdId, st.release.record.release_id, 'consumed', { recovered: true });\n",
    to: '',
    why: 'a comparison whose park\'s end failed after it recorded consumed is never published',
    killed_by: /a comparison whose park's end failed after it recorded consumed/,
  },
  {
    id: 'L8', file: SCH, tests: [TL],
    from: '      lanes: run.lanes.lanes, rateLimit: throttleText(throttle, nowSec), publishHalt: () => { if (endHalt) publishHalt(endHalt); },',
    to: '      lanes: run.lanes.lanes, rateLimit: throttleText(throttle, nowSec), publishHalt: () => {},',
    why: 'a halt that ends the run with no drain (a refused forced step, every lane waiting) is not published',
    killed_by: /a forced step refused on a held lane ends the run with its halt/,
  },
  {
    id: 'L12', file: SCH, tests: [TL],
    from: '    const endHalt = d;\n    clearTimeout(resetTimer);',
    to: '    const endHalt = d;\n    if (d) publishHalt(d);\n    clearTimeout(resetTimer);',
    why: 'the halt that ends the run is published before run.json records it, while handoffs and removals still run',
    killed_by: [/a gate parks its lane/, /a forced step refused on a held lane ends the run with its halt/],
  },
  {
    id: 'L13', file: SCH, tests: [TL],
    from: '    if (!draining) {\n      draining = hh;',
    to: '    if (!draining) publishHalt(hh);\n    if (!draining) {\n      draining = hh;',
    why: 'a drain\'s halt is published before run.json records the run draining',
    killed_by: /a drain publishes its halt as it is met/,
  },
  {
    id: 'L9', file: SCH, tests: [TL],
    from: '    // Once run.json records the run draining (the first halt).\n    publishHalt(hh);',
    to: '',
    why: 'a drain\'s halt is published only at the run\'s end, not as it is met',
    killed_by: /a drain publishes its halt as it is met/,
  },
  {
    id: 'L10', file: SCH, tests: [TL],
    from: "    const key = h.reason === 'interrupted' ? 'interrupted' : `${h.reason}\\0${h.subtaskId ?? ''}`;",
    to: "    const key = `${h.reason}\\0${h.subtaskId ?? ''}`;",
    why: 'one interrupt publishes a halt per lane it stopped',
    killed_by: /an interrupt ends the run with the interrupted halt/,
  },

  // ---- C: a dead run's cleanup ------------------------------------------------
  {
    id: 'C1', file: DR, tests: [TC],
    from: "    pointer: path.join(dir, haltFile ? 'halt.json' : 'run.json'), cleanup: true,",
    to: "    pointer: path.join(dir, haltFile ? 'halt.json' : 'run.json'), cleanup: false,",
    why: 'a cleanup\'s run-ended is not told from a driver\'s',
    killed_by: /a driver killed mid-line, then a cleanup/,
  },
  {
    id: 'C2', file: EV, tests: [TC],
    from: "          if (kind === 'run-ended' && e.kind === 'run-ended' && e.run_id === runId && eventOfLine(e)) existing = e;",
    to: '',
    why: 'a cleanup retried after it wrote run-ended writes a second',
    killed_by: /a cleanup retried after it wrote run-ended/,
  },
  {
    id: 'C3', file: DR, tests: [TC],
    from: "  const status = RUN_STATUSES.includes(run.status) ? run.status : 'halted';",
    to: "  const status = 'halted';",
    why: 'a run that recorded completed and died before its line is published halted',
    killed_by: /a run that recorded its end and died before its line keeps that end/,
  },
  {
    id: 'C4', file: EV, tests: [TC],
    from: '          if (e.run_id === runId && e.seq > max) max = e.seq;',
    to: '          if (e.seq > max) max = e.seq;',
    why: 'a run\'s seq counts other runs\' lines, so interleaved runs skip each other\'s numbers',
    killed_by: /a dead run's cleanup finishing after the next run began/,
  },
  {
    id: 'C5', file: DR, tests: [TC],
    from: "  if (!run.events || typeof run.events !== 'object') return true;",
    to: "  if (!run.events || typeof run.events !== 'object') run.events = { failed_writes: 0 };",
    why: 'a run that took no part in the file gets a run-ended there',
    killed_by: /a run that took no part in the file/,
  },
  {
    id: 'C6', file: DR, tests: [TC],
    from: '    file = eventsPath({ mainRoot, macroId, checkout: record.checkout });',
    to: '    file = eventsPath({ mainRoot, macroId: null, checkout: record.checkout });',
    why: 'a macro run\'s cleanup writes its run-ended to the checkout\'s file, where its watch never looks',
    killed_by: /through stop: the run-ended is written/,
  },
  {
    id: 'C7', file: CLI, tests: [TC],
    from: '    let live = open ? await holderAlive({ pid: open.pid, fingerprint: open.fingerprint, worker: null }) : false;',
    to: '    let live = Boolean(open);',
    why: 'a dead run whose record is left counts as live, and is never reported missing its end',
    killed_by: /a dead uncleaned run is reported missing its terminal event/,
  },

  // ---- Found by the Plan-verify review of the code ---------------------------
  {
    id: 'W15', file: EV, tests: [TW],
    from: "  const spec = typeof kind === 'string' && Object.hasOwn(FIELDS, kind) ? FIELDS[kind] : null;",
    to: '  const spec = FIELDS[kind];',
    why: 'a name every object inherits (constructor) passes as a kind, and its text reaches the file',
    killed_by: /refuses text, a field its kind does not list/,
  },
  {
    id: 'W16', file: EV, tests: [TW],
    from: "          if (fs.readFileSync(lock, 'utf8') === mine) fs.unlinkSync(lock);",
    to: '          fs.unlinkSync(lock);',
    why: 'a writer whose lock was taken over removes its successor\'s lock',
    killed_by: /is removed by its writer's release only while it is still that writer's/,
  },
  {
    id: 'W17', file: EV, tests: [TW],
    from: "    const stale = holder ? !pidAlive(holder.pid) : Date.now() - st.mtimeMs > LOCK_TORN_MS;",
    to: "    const stale = Date.now() - st.mtimeMs > 30_000 || (holder ? !pidAlive(holder.pid) : Date.now() - st.mtimeMs > LOCK_TORN_MS);",
    why: 'an old lock of a live, suspended writer is taken from it',
    killed_by: /is never taken, however old/,
  },
  {
    id: 'R14', file: RD, tests: [TR],
    from: '      if (prev !== undefined && e.seq > prev + 1) {\n        flush();',
    to: "      if (prev !== undefined && e.seq > prev + 1 && !(e.kind === 'stall' && budget <= 0)) {\n        flush();",
    why: 'a gap among folded stall lines goes unreported',
    killed_by: /a gap between folded stall lines is still a reader-gap line/,
  },
  {
    id: 'R15', file: RD, tests: [TR],
    from: '  for (const runId of order) if (!ended.has(runId)) tracked.add(runId);',
    to: '',
    why: 'a re-arm past an unfinished run\'s lines drops its missing end',
    killed_by: /a re-arm past an unfinished run's lines/,
  },
  {
    id: 'R16', file: RD, tests: [TD],
    from: "  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return e?.code === 'ENOENT' ? false : null; }",
    to: "  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }",
    why: 'a run every write of which failed, its file never created, is never reported missing its end',
    killed_by: /a write that fails is printed and counted in run.json/,
  },
  {
    id: 'C8', file: CLI, tests: [TC],
    from: '      for (const e of readLockEntries(join(autopilotDir(mainRoot), \'open\', `${runId}.cleanup.lock`))) if (await holderAlive(e.holder)) cleaning = true;',
    to: '      for (const e of readLockEntries(join(autopilotDir(mainRoot), \'open\', `${runId}.cleanup.lock`))) if (await holderAlive(e)) cleaning = true;',
    why: 'a cleanup under way is taken for none, and its run reported missing its end',
    killed_by: /is not reported while a cleanup of it runs/,
  },
  {
    id: 'C9', file: CLI, tests: [TC],
    from: "          if (l.holder?.run_id === runId && await holderAlive({ pid: l.holder.pid, fingerprint: l.holder.fingerprint, worker: null })) live = true;",
    to: '',
    why: 'a run that holds its locks and has not written its open-run record yet is reported missing its end',
    killed_by: /is not reported while a cleanup of it runs, nor while a lock entry of it lives/,
  },
  {
    id: 'C10', file: DR, tests: [TC],
    from: '      haltFile = !r.halt;',
    to: '      haltFile = true;',
    why: 'the cleanup\'s run-ended points at a halt.json that holds another halt',
    killed_by: /a run whose driver died after writing halt.json, before run.json recorded it/,
  },
  {
    id: 'D9', file: DRV, tests: [TD],
    from: '    if (!report || committed.size === 0 || report.publishError) return;',
    to: '    if (!report || committed.size === 0) return;',
    why: 'a report that could not be recorded is taken for one already recorded, and its commit-finished points at nothing',
    killed_by: /a landing report that could not be recorded publishes no commit-finished/,
  },
  {
    id: 'D11', file: DRV, tests: [TL],
    from: '    if (run.halt && pendingEndHalt) {\n      const publishEnd = pendingEndHalt;\n      pendingEndHalt = null;\n      publishEnd();\n    }\n',
    to: '',
    why: 'a halt the end recorded is never published when a record write of finish throws before its publication',
    killed_by: /a record write of the run's end that throws: the error path publishes the recorded halt/,
  },
  {
    id: 'D10', file: DRV, tests: [TD],
    from: '      publishEnd();\n    }\n    if (d) {',
    to: "      publishEnd();\n    }\n    runEnded(status, d ? run.halt : null, status === 'completed' ? 0 : 2);\n    if (d) {",
    why: 'run-ended is published before the output that can still fail the run, and contradicts its error',
    killed_by: /output that fails after the halt is recorded/,
  },
  {
    id: 'D12', file: DRV, tests: [TD],
    from: '    if (!unrecorded) {\n      try {\n        release();',
    to: '    if (true) {\n      try {\n        release();',
    why: 'a run that halts at its start releases its locks before its run-ended, and a reader then reports its live driver missing its end',
    killed_by: /a run that halts at its start, after it joined the file and before its open-run record/,
  },
  {
    id: 'D13', file: DRV, tests: [TD],
    from: "    if (openRecorded) {\n      try {\n        release();\n      } catch { /* judged gone once the driver exits */ }\n      if (afterRelease) await afterRelease().catch(() => {});\n    }\n    runEnded('error', run.halt, 1);",
    to: "    try {\n      release();\n    } catch { /* judged gone once the driver exits */ }\n    if (afterRelease) await afterRelease().catch(() => {});\n    runEnded('error', run.halt, 1);",
    why: 'a run that stops on an error at its start releases its locks before its run-ended',
    killed_by: /a run that stops on an error at its start, before its open-run record/,
  },
  {
    id: 'D14', file: DRV, tests: [TD],
    from: '    writeRun(runDir, { ...run, events: evRecord });\n    run.events = evRecord;',
    to: '    run.events = evRecord;\n    writeRun(runDir, run);',
    why: 'a run whose record of its part failed is recorded as taking part by its error path, with no line on file',
    killed_by: /a run whose record of its part in the event file failed records none after/,
  },
  {
    id: 'D15', file: DRV, tests: [TD],
    from: '      try {\n        release();\n      } catch (e) {\n        late(',
    to: '      release();\n      try {\n      } catch (e) {\n        late(',
    why: 'a lock entry that cannot be removed after an early end\'s run-ended turns the published end into an error',
    killed_by: /a lock entry that cannot be removed after an early end's run-ended/,
  },
  {
    id: 'D16', file: DRV, tests: [TD],
    from: '      await last().catch(() => {});\n    }\n    out(`  run ${runId}',
    to: '      await last().catch(() => {});\n    }\n    detach();\n    out(`  run ${runId}',
    why: 'the signal handlers go before the end is notified and published: a closed terminal then kills the driver short of its run-ended',
    killed_by: /a signal while the run's end is notified interrupts nothing/,
  },
  {
    id: 'D17', file: DRV, tests: [TD],
    from: '    if (!unrecorded) {\n      try {\n        release();\n      } catch (e) {',
    to: '    if (!unrecorded) {\n      release();\n      try {\n      } catch (e) {',
    why: 'a lock entry that cannot be removed at a recorded run\'s end skips its run-ended and turns the end into an error',
    killed_by: /a lock entry that cannot be removed at a recorded run's end/,
  },
  {
    id: 'D18', file: DRV, tests: [TD],
    from: '      try {\n        release();\n      } catch { /* judged gone once the driver exits */ }',
    to: '      release();',
    why: 'a lock entry that cannot be removed on the error path skips the run-ended, replaces the run\'s own error and leaves the signal handlers attached',
    killed_by: /a lock entry that cannot be removed when a recorded run stops on an error/,
  },
  {
    id: 'D19', file: DRV, tests: [TD],
    from: '        late(`⚠ a lock entry',
    to: '        out(`⚠ a lock entry',
    why: 'a warning that fails after an early end\'s run-ended rewrites the run to an error under its published end',
    killed_by: /a warning that cannot be printed after the run-ended leaves the end it published standing/,
  },
  {
    id: 'D20', file: DRV, tests: [TD],
    from: '        late(`⚠ the run\'s open-run record',
    to: '        out(`⚠ the run\'s open-run record',
    why: 'a warning that fails after a recorded end\'s run-ended rewrites the run to an error under its published end',
    killed_by: /a warning that cannot be printed after the run-ended leaves the end it published standing/,
  },
  {
    id: 'R20', file: CLI, tests: [TD],
    from: '    if (!live) {\n      let again = null;',
    to: '    if (false) {\n      let again = null;',
    why: 'a reader that missed the open-run record before it was written, and the locks after they went, reports a live driver missing its end',
    killed_by: /a reader that finds no open-run record, then no lock entry, reads the record again/,
  },
  {
    id: 'L11', file: SCH, tests: [TL],
    from: "    if (recovered) appendLaneEvent(runDir, { event: 'released', subtask_id: id, hold_id: holdId ?? null, release_id: releaseId, verdict, recovered: true, run_id: runId, at: at() });",
    to: '',
    why: 'a recovered release\'s line points at a lane event this run never wrote',
    killed_by: /a comparison whose park's end failed after it recorded consumed/,
  },

  // ---- P: the Monitor recipe --------------------------------------------------
  {
    id: 'P1', file: DOC, tests: [TP],
    from: '"terminal":true|"kind":"reader-',
    to: '"terminal":true',
    why: 'the documented pattern drops the reader\'s own lines',
    killed_by: /the documented pattern matches a line of every terminal kind and every reader- kind/,
  },
  {
    id: 'P3', file: DOC, tests: [TP],
    from: "grep -E --line-buffered '",
    to: "grep --line-buffered '",
    why: 'the documented filter, run as written, is a basic pattern that matches no line',
    killed_by: /the documented pattern matches a line of every terminal kind and every reader- kind/,
  },
  {
    id: 'P4', file: DOC, tests: [TP],
    from: "grep -E --line-buffered '",
    to: "grep -E '",
    why: 'the documented filter holds each line until the reader exits',
    killed_by: /the documented pattern matches a line of every terminal kind and every reader- kind/,
  },
  {
    id: 'P5', file: DOC, tests: [TP],
    from: 'or stops early for any cause other than a\n   `reader-error`, re-arm it with the cursor',
    to: 'or stops early for any cause, re-arm it with the cursor',
    why: 'the recipe re-arms from a reader-error\'s cursor, which fails the same way',
    killed_by: /after a reader-error, never re-arms from its cursor/,
  },
  {
    id: 'P6', file: DOC, tests: [TP],
    from: '; when that ends in a\n   `reader-error` too, stop re-arming and report it to the owner.',
    to: '.',
    why: 'a reader-error that recurs is re-armed without end',
    killed_by: /after a reader-error, never re-arms from its cursor/,
  },
  {
    id: 'P2', file: DOC, tests: [TP],
    from: '`timeout_ms` 1800000',
    to: '`timeout_ms` 600000',
    why: 'the recipe arms Monitor below its maximum',
    killed_by: /arms Monitor at its 30-minute maximum/,
  },

  // ---- Refine pass 4: the CLI's printer (D21), the step being settled (L14,
  // L15), each lane-resumed cause (L16-L19), the reader's rules for a line
  // (R21-R29)
  {
    id: 'D21', file: CLI, tests: [TL],
    from: "  absorbOutputErrors([stream]);\n  let failed = false;\n  stream.on('error', () => { failed = true; });\n",
    to: '  let failed = false;\n',
    why: 'a write to a closed pipe or terminal kills the driver later, as an unhandled stream error: exit 1 under a halted run, or no run-ended at all',
    killed_by: /a driver whose stdout and stderr are a closed pipe runs to its end/,
  },
  {
    id: 'L14', file: SCH, tests: [TL],
    from: "    if (settling) pub.stepFailed(settling.seq, settling.subtaskId, 'error', settling.w?.aborted ?? null);\n",
    to: '',
    why: 'a step the run\'s error meets while it is settled ends with no step-failed',
    killed_by: /a step the run's error meets while it is settled/,
  },
  {
    id: 'L15', file: SCH, tests: [TL],
    from: '    settling = entry;\n',
    to: '',
    why: 'the step being settled is out of `inflight` and tracked nowhere, so the error path passes it by',
    killed_by: /a step the run's error meets while it is settled/,
  },
  {
    id: 'L16', file: SCH, tests: [TL],
    from: "consumed ? 'release' : 'hold-ended')) changed = true;",
    to: "'hold-ended')) changed = true;",
    why: 'a passed-by lane given back by its consumed release is published as its hold ending without one',
    killed_by: /a lane the relaunch passed by, given back once its release is consumed: cause release/,
  },
  {
    id: 'L17', file: SCH, tests: [TL],
    from: "consumed ? 'release' : 'hold-ended')) changed = true;",
    to: "consumed ? 'release' : 'release')) changed = true;",
    why: 'a passed-by lane whose hold ended with no release is published as released',
    killed_by: /a lane the relaunch passed by whose hold ended without a release: cause hold-ended/,
  },
  {
    id: 'L18', file: SCH, tests: [TL],
    from: "        publishResumed(id, 'forced');",
    to: "        publishResumed(id, 'record-changed');",
    why: 'a forced step\'s resumption is published as a record change',
    killed_by: /a forced step on a lane its park keeps: lane-resumed, cause forced/,
  },
  {
    id: 'L19', file: SCH, tests: [TL],
    from: "[why, cause] = ['released', 'release'];",
    to: "[why, cause] = ['released', 'record-changed'];",
    why: 'the owner\'s release of a kept park is published as a record change',
    killed_by: /a kept park the owner releases while the run lives: lane-resumed, cause release/,
  },
  {
    id: 'R21', file: EV, tests: [TR],
    from: '  if (!hasIdentity(v) || v.schema !== EVENT_SCHEMA || !EVENT_KINDS.includes(v.kind)) return null;',
    to: '  if (!hasIdentity(v)) return null;',
    why: 'a line of another schema, or of a kind the writer has no fields for, is printed',
    killed_by: /a field outside its kind's allow-list, an unknown kind, another schema/,
  },
  {
    id: 'R22', file: EV, tests: [TR],
    from: '  if (eventProblem(v.kind, v.subtask_id, fields) !== null) return null;\n',
    to: '',
    why: 'a line\'s fields are not held to its kind\'s allow-list: free text appended to the file reaches the session',
    killed_by: /a field outside its kind's allow-list, an unknown kind, another schema/,
  },
  {
    id: 'R23', file: EV, tests: [TR],
    from: "  const fields = Object.fromEntries(Object.entries(v).filter(([k]) => !HEAD_KEYS.includes(k) && k !== 'terminal'));",
    to: "  const fields = {};\n  for (const [k, x] of Object.entries(v)) if (!HEAD_KEYS.includes(k) && k !== 'terminal') fields[k] = x;",
    why: 'a `__proto__` key becomes the prototype of the fields checked, not a field, and the line passes with it',
    killed_by: /a `__proto__` key, a forged macro id: each skipped/,
  },
  {
    id: 'R24', file: EV, tests: [TR],
    from: "  if (terminal ? v.terminal !== true : Object.hasOwn(v, 'terminal')) return null;\n",
    to: '',
    why: 'a line of a kind that is not terminal passes with `terminal: true`, which the documented filter takes for a run\'s end',
    killed_by: /a field outside its kind's allow-list, an unknown kind, another schema/,
  },
  {
    id: 'R25', file: EV, tests: [TR],
    from: "  if (typeof v.at !== 'string' || !AT_RE.test(v.at) || !Number.isFinite(Date.parse(v.at))) return null;\n",
    to: '',
    why: 'free text in a line\'s `at` is printed',
    killed_by: /a field outside its kind's allow-list, an unknown kind, another schema/,
  },
  {
    id: 'R26', file: EV, tests: [TR],
    from: "  if (!Object.hasOwn(v, 'macro_id') || !(v.macro_id === null || isSafeMacroId(v.macro_id))) return null;\n",
    to: '',
    why: 'free text in a line\'s `macro_id` is printed',
    killed_by: /a `__proto__` key, a forged macro id: each skipped/,
  },
  {
    id: 'R27', file: RD, tests: [TR],
    from: '    const v = eventOfLine(JSON.parse(raw));',
    to: '    const v = JSON.parse(raw);',
    why: 'the reader takes any parsed object for an event: a forged run-ended ends a run, and its text is printed',
    killed_by: [/a forged run-ended is no end/, /a cursor naming a forged line is not on file/],
  },
  {
    id: 'R28', file: RD, tests: [TR],
    from: 'status: RUN_JSON_STATUSES.includes(f.run.status) ? f.run.status : null,',
    to: "status: typeof f.run.status === 'string' ? f.run.status : null,",
    why: 'a run.json status that is free text is repeated on the reader\'s line',
    killed_by: /reader-terminal-missing repeats a run\.json status only from the driver's set/,
  },
  {
    id: 'R29', file: RD, tests: [TR],
    from: '    const v = eventOfLine(JSON.parse(raw));',
    to: '    const v = JSON.parse(raw);',
    why: 'a stall line with a free-text verdict is folded and its verdict counted as a key of the summary',
    killed_by: /reader-summary counts only the verdict codes of stall lines the writer could have written/,
  },
  {
    id: 'W22', file: EV, tests: [TW],
    from: "          if (kind === 'run-ended' && e.kind === 'run-ended' && e.run_id === runId && eventOfLine(e)) existing = e;",
    to: "          if (kind === 'run-ended' && e.kind === 'run-ended' && e.run_id === runId) existing = e;",
    why: 'a forged run-ended, which every reader skips, suppresses the run\'s real one',
    killed_by: /a forged run-ended or lane-released, which every reader skips, suppresses nothing/,
  },
  {
    id: 'W23', file: EV, tests: [TW],
    from: "          if (kind === 'lane-released' && e.kind === 'lane-released' && e.release_id === fields.release_id && eventOfLine(e)) existing = e;",
    to: "          if (kind === 'lane-released' && e.kind === 'lane-released' && e.release_id === fields.release_id) existing = e;",
    why: 'a forged lane-released, which every reader skips, suppresses the real one',
    killed_by: /a forged run-ended or lane-released, which every reader skips, suppresses nothing/,
  },
  {
    id: 'R30', file: CLI, tests: [TR],
    from: '    if (print.failed) return false;\n',
    to: '',
    why: 'a follow whose output failed polls on for nobody where a null write cannot tell (Linux, a terminal)',
    killed_by: /the CLI's probe of its output: gone once a line's write failed/,
  },
  // ---- refine pass 5 (critique round 5, N1-N8) ------------------------------
  {
    id: 'D22', file: CLI, tests: [TD],
    from: '      if (await recordDriverAlive(left)) {',
    to: '      if (false) {',
    why: 'stop takes a run ending cleanly (its locks released, its notification and run-ended under way) for a dead driver, and exits 1',
    killed_by: /a run whose end is slow .* is stopped, not reported dead/,
  },
  {
    id: 'D23', file: CLI, tests: [TD],
    from: '    cleanupPending = left !== null && !(await recordDriverAlive(left));',
    to: '    cleanupPending = left !== null;',
    why: 'status shows a run ending cleanly as one whose cleanup is pending',
    killed_by: /a run whose end is slow .* status shows no cleanup pending/,
  },
  {
    id: 'D24', file: DRV, tests: [TD],
    from: "    runEnded(status, d ? run.halt : null, status === 'completed' ? 0 : 2);",
    to: "    if (!lingering && !keepRecord) removeOpenRun(mainRoot, runId);\n    runEnded(status, d ? run.halt : null, status === 'completed' ? 0 : 2);",
    why: 'a recorded run\'s open-run record goes before its run-ended: a reader in between finds no live driver and no end, and reports the end missing',
    killed_by: /a recorded run's run-ended is on file before its open-run record goes/,
  },
  {
    id: 'D25', file: CLI, tests: [TD],
    from: '        if (await recordDriverAlive(record)) left.push(record.run_id);',
    to: '        if (false) left.push(record.run_id);',
    why: 'stop asked after an ending run released its locks cleans up after a live driver, and exits 1',
    killed_by: /stop asked once the run has released its locks, its record still there and its driver alive/,
  },
  {
    id: 'D26', file: CLI, tests: [TDR],
    from: "typeof record.run_dir !== 'string' || !ended(record)) continue;",
    to: "typeof record.run_dir !== 'string') continue;",
    why: 'stop takes a live run whose lock it could not read, its run.json still running, for one ending: it waits out its bound instead of reporting the run live',
    killed_by: /exits 1 when it finds no run in the locks but the record of a live one/,
  },
  {
    id: 'R48', file: RD, tests: [TR],
    from: '        out(JSON.stringify(shownEvent(e, isRoot)));',
    to: '        out(JSON.stringify(e));',
    why: 'the reader prints each path as it is on file, under any directory',
    killed_by: /through the CLI, a path under a directory that is no checkout of the repository is printed null/,
  },
  {
    id: 'R32', file: EV, tests: [TR],
    from: '  if (UNSAFE_PATH_RE.test(v) || path.posix.normalize(v) !== v) return null;',
    to: '  if (path.posix.normalize(v) !== v) return null;',
    why: 'a path with a bidi override (or another control or format character) in its checkout is printed',
    killed_by: /a path field that names no record the driver writes is skipped/,
  },
  {
    id: 'R33', file: EV, tests: [TR],
    from: '  if (UNSAFE_PATH_RE.test(v) || path.posix.normalize(v) !== v) return null;',
    to: '  if (UNSAFE_PATH_RE.test(v)) return null;',
    why: 'a path whose checkout steps out with `..` through a directory named by text is printed',
    killed_by: /a path field that names no record the driver writes is skipped/,
  },
  {
    id: 'R34', file: EV, tests: [TR],
    from: "  if (rest.length === 2 && isRunId(rest[0]) && RUN_RECORDS.includes(rest[1])) return { root, kind: 'record' };",
    to: "  if (rest.length === 2 && isRunId(rest[0])) return { root, kind: 'record' };",
    why: 'a record name that is text, in a run\'s directory, is printed',
    killed_by: /a path field that names no record the driver writes is skipped/,
  },
  {
    id: 'R35', file: EV, tests: [TR],
    from: "  if (rest.length === 2 && isRunId(rest[0]) && RUN_RECORDS.includes(rest[1])) return { root, kind: 'record' };",
    to: "  if (rest.length === 2 && RUN_RECORDS.includes(rest[1])) return { root, kind: 'record' };",
    why: 'a run directory named by text is printed in a record\'s path',
    killed_by: /a path field that names no record the driver writes is skipped/,
  },
  {
    id: 'R36', file: EV, tests: [TR],
    from: "  if (rest.length === 1 && isRunId(rest[0])) return { root, kind: 'run-dir' };",
    to: "  if (rest.length === 1) return { root, kind: 'run-dir' };",
    why: 'a run_dir named by text is printed',
    killed_by: /a path field that names no record the driver writes is skipped/,
  },
  {
    id: 'R37', file: EV, tests: [TR],
    from: "rest[0] === 'landing' && rest[1].endsWith('.jsonl') && isSafeMacroId(rest[1].slice(0, -'.jsonl'.length))",
    to: "rest[0] === 'landing' && rest[1].endsWith('.jsonl')",
    why: 'a landing log named by text is printed',
    killed_by: /a path field that names no record the driver writes is skipped/,
  },
  {
    id: 'R38', file: EV, tests: [TR],
    from: "rest[3].endsWith('.json') && isSafeSubtaskId(rest[3].slice(0, -'.json'.length))",
    to: "rest[3].endsWith('.json')",
    why: 'a park named by text is printed',
    killed_by: /a path field that names no record the driver writes is skipped/,
  },
  {
    id: 'R39', file: EV, tests: [TR],
    from: "const recordPath = (v) => recordPathParts(v)?.kind === 'record';",
    to: 'const recordPath = (v) => recordPathParts(v) !== null;',
    why: 'a pointer that names a run\'s directory, not a record, passes',
    killed_by: /a path field that names no record the driver writes is skipped/,
  },
  {
    id: 'R40', file: EV, tests: [TR],
    from: '    if (!isRoot(recordPathParts(e[k]).root)) shown = { ...shown, [k]: null };\n',
    to: '',
    why: 'the reader prints a path whose checkout is no checkout of the repository: a directory named by text reaches the session',
    killed_by: /through the CLI, a path under a directory that is no checkout of the repository is printed null/,
  },
  {
    id: 'R41', file: CLI, tests: [TR],
    from: '    isRoot: checkouts.isRoot, outputOpen: outputProbe(out),',
    to: '    isRoot: null, outputOpen: outputProbe(out),',
    why: 'the CLI gives the reader no checkouts: a path under a directory named by text is printed',
    killed_by: /through the CLI, a path under a directory that is no checkout of the repository is printed null/,
  },
  {
    id: 'R42', file: CLI, tests: [TR],
    from: '      read();\n      if (known.has(r)) return true;\n      misses.add(r);',
    to: '      misses.add(r);',
    why: 'a relaunch from a worktree added since the arm has every path printed null',
    killed_by: /one under a checkout added after the arm as it is/,
  },
  {
    id: 'R43', file: EV, tests: [TR],
    from: '    step: int(1), verdict: oneOf(STALL_VERDICTS), mode: oneOf(STALL_MODES),',
    to: "    step: int(1), verdict: (v) => typeof v === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(v), mode: oneOf(STALL_MODES),",
    why: 'a stall verdict that is any code-shaped word is printed and becomes a summary key',
    killed_by: /a stall verdict or mode outside Decision 3's closed sets/,
  },
  {
    id: 'R44', file: EV, tests: [TR],
    from: '    step: int(1), verdict: oneOf(STALL_VERDICTS), mode: oneOf(STALL_MODES),',
    to: "    step: int(1), verdict: oneOf(STALL_VERDICTS), mode: (v) => typeof v === 'string',",
    why: 'a stall mode that is any word is printed',
    killed_by: /a stall verdict or mode outside Decision 3's closed sets/,
  },
  {
    id: 'R45', file: CLI, tests: [TR],
    from: '      writeSync(fd, Buffer.alloc(0));\n      return true;',
    to: '      return true;',
    why: 'an idle follow whose pipe reader is gone polls on until the next line, forever for a macro whose runs have ended',
    killed_by: /an idle `events --follow` whose pipe reader closes after a line/,
  },
  {
    id: 'R46', file: RD, tests: [TR],
    from: '    if (!outputOpen()) break;\n',
    to: '',
    why: 'a follow never asks whether its output is gone: it polls on for nobody',
    killed_by: [/`events --follow` whose stdout is a closed pipe stops/, /an idle `events --follow` whose pipe reader closes after a line/],
  },
  {
    id: 'R47', file: RD, tests: [TR],
    from: "      if (ident && (s.dev !== ident.dev || s.ino !== ident.ino)) return fail('replaced');\n",
    to: '',
    why: 'a file replaced by another as large or larger is read on as the same file',
    killed_by: /a file replaced by another as large or larger .* is a reader-error `replaced`/,
  },
  {
    id: 'P7', file: DOC, tests: [TP],
    from: '--args-file "$ARGS_DIR/args.json" 2>&1\n',
    to: '--args-file "$ARGS_DIR/args.json"\n',
    why: 'a refusal before the reader starts goes to stderr, which the session never sees: it re-arms the same failing arguments',
    killed_by: /the watch block, run as written, hands the session a refusal the CLI prints before the reader starts/,
  },
  {
    id: 'P8', file: DOC, tests: [TP],
    from: ' Each re-arm is steps 1 and 2\n   again, with a new args directory.',
    to: '',
    why: 'a re-arm reuses the args directory the CLI removed',
    killed_by: /each re-arm takes a new args directory, and an exit 1 with no reader line is a reader-error/,
  },
  {
    id: 'P9', file: DOC, tests: [TP],
    from: ' An exit 1 with no reader line (the CLI\n   refused before the reader started: what it printed says why) counts as a\n   `reader-error`: never re-arm the same arguments.',
    to: '',
    why: 'an early refusal is re-armed with the same arguments without bound',
    killed_by: /each re-arm takes a new args directory, and an exit 1 with no reader line is a reader-error/,
  },
];
