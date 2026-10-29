// Mutation spec — do the stall detector's tests catch the defects ADR-0068
// Decision 3 guards against?
//
// Run: npm run mutate -- scripts/mutation-specs/impl-stall.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. The detector ships log-only: a defect in it
// stops no step and fails no run, so every run stays green while its verdicts
// are wrong — a heartbeat counted as activity hides every foreground stall, a
// failed sample read as zero CPU turns a probe outage into `stalled`, a reused
// pid read as a counter that went back hides a stall behind `unknown`, and
// none of it shows until the owner reviews the log to switch the detector on
// (Decision 3, item 8). Each mutation breaks one rule and names the test that
// must notice it; each new test of impl-stall has one here.
//
// Groups: S the detector (stall.mjs), P the process table (procs.mjs), M the
// run's sampler (stall-sampler.mjs), K the worker's watch (worker.mjs). The
// run's side (the policy, the ledger readers, the events, the driver, the
// scheduler and the CLI) is impl-stall-run.mjs: kept apart because a spec
// selects every test it names for each file it anchors (verify-select.mjs),
// and these tests are not the policy's.
//
// Not guarded by a mutation: the young-step rule (a step younger than the
// window is active), which the quiet rule implies (the quiet time is never
// longer than the step's age), so removing it is an equivalent mutation; and
// dead-runs.mjs passing `stall` lines over, which no reader of its result can
// tell from merging them (a `stall` line is never a step's first or last
// line: the watch ends before the finished line is written).

const ST = 'plugins/orchestrator/adapters/claude/autopilot/stall.mjs';
const PR = 'plugins/orchestrator/adapters/claude/autopilot/procs.mjs';
const SM = 'plugins/orchestrator/adapters/claude/autopilot/stall-sampler.mjs';
const WK = 'plugins/orchestrator/adapters/claude/autopilot/worker.mjs';

const TS = 'tests/orchestrator/test-autopilot-stall.mjs';
const TP = 'tests/orchestrator/test-autopilot-procs.mjs';
const TM = 'tests/orchestrator/test-autopilot-stall-sampler.mjs';
const TW = 'tests/orchestrator/test-autopilot-worker.mjs';

export const TESTS = [TS, TP, TM, TW];

export const MUTATIONS = [
  // ---- S: the detector -------------------------------------------------------
  {
    id: 'S1', file: ST, tests: [TS],
    from: "  if (ev.type === 'tool_progress' && ev.heartbeat === true) return false;\n",
    to: '',
    why: 'a heartbeat counts as activity, so a foreground wait on nothing never stalls',
    killed_by: [/heartbeats and hook events are not activity/, /a foreground wait on nothing with heartbeats only/],
  },
  {
    id: 'S2', file: ST, tests: [TS],
    from: "  if (ev.type === 'system' && (ev.subtype === 'hook_started' || ev.subtype === 'hook_response')) return false;\n",
    to: '',
    why: 'a hook event counts as activity',
    killed_by: /a stream of hook events only stalls too/,
  },
  {
    id: 'S3', file: ST, tests: [TS],
    from: '    if (p.pid === workerPid || members.has(p.key)) return;',
    to: '    if (members.has(p.key)) return;',
    why: 'the worker process itself counts, its idle 0.6 s per 10 s hiding every stall',
    killed_by: /the worker process itself is excluded/,
  },
  {
    id: 'S4', file: ST, tests: [TS],
    from: '  for (const p of procs) if (p.pgid === workerPid || sticky.has(p.key)) visit(p);',
    to: '  for (const p of procs) if (p.pgid === workerPid) visit(p);',
    why: 'membership does not stick: a descendant reparented when its parent exits is no longer counted',
    killed_by: /membership sticks/,
  },
  {
    id: 'S5', file: ST, tests: [TS],
    from: '  for (const p of procs) if (p.pgid === workerPid || sticky.has(p.key)) visit(p);',
    to: '  for (const p of procs) if (sticky.has(p.key)) visit(p);',
    why: 'a member of the worker\'s process group whose parent is not in the tree is not counted',
    killed_by: /every member of the worker's process group counts/,
  },
  {
    id: 'S6', file: ST, tests: [TS],
    from: '    members.set(p.key, p);',
    to: '    members.set(String(p.pid), p);',
    why: 'identity is the pid alone: a reused pid reads as a counter that went back',
    killed_by: /identity is the pid with its start time/,
  },
  {
    id: 'S7', file: ST, tests: [TS],
    from: '            growth += p.cpuMs;\n',
    to: '',
    why: 'a process first seen counts nothing: a short process seen once is never work',
    killed_by: [/a short process seen once counts what it used/, /a polling loop of short processes/],
  },
  {
    id: 'S8', file: ST, tests: [TS],
    from: '          } else if (p.ageMs <= windowMs + AGE_SLACK_MS) {',
    to: '          } else {',
    why: 'a process first seen counts its whole life, the CPU it used before the window included',
    killed_by: /a process first seen that started before the window counts nothing/,
  },
  {
    id: 'S8b', file: ST, tests: [TS],
    from: '          } else if (p.ageMs <= windowMs + AGE_SLACK_MS) {',
    to: '          } else if (p.ageMs <= dMono + AGE_SLACK_MS) {',
    why: 'a process first seen counts only when it started inside its interval: one a scan missed is lost',
    killed_by: /a process first seen that started inside the window, before its interval/,
  },
  {
    id: 'S9', file: ST, tests: [TS],
    from: "      return { known: false, why: typeof snapshot?.why === 'string' ? snapshot.why : 'failed', members: null };",
    to: '      return { known: true, why: null, members: new Map() };',
    why: 'a missing sample reads as zero CPU, so a probe outage turns a window stalled',
    killed_by: [/a failed sample in a quiet, idle window makes it unknown/, /a slow sample never yields stalled/],
  },
  {
    id: 'S10', file: ST, tests: [TS],
    from: "      if (known && dMono > 3 * intervalMs) { known = false; why = 'spacing'; }\n",
    to: '',
    why: 'samples spaced beyond three intervals are trusted',
    killed_by: /samples spaced more than three intervals apart/,
  },
  {
    id: 'S11', file: ST, tests: [TS],
    from: "      if (known && dWall - dMono > intervalMs) { known = false; why = 'clock'; }\n",
    to: '',
    why: 'a suspend (the wall clock ahead of the monotonic one) reads as a quiet window',
    killed_by: /a suspend longer than an interval/,
  },
  {
    id: 'S12', file: ST, tests: [TS],
    from: '      if (known && dWall - dMono > intervalMs) {',
    to: '      if (known && Math.abs(dWall - dMono) > intervalMs) {',
    why: 'a wall-clock step backward turns a window unknown',
    killed_by: /a suspend shorter than an interval, and a wall-clock step backward/,
  },
  {
    id: 'S13', file: ST, tests: [TS],
    from: '      intervals.push({ start: prev.mono, end: mono, known, cpuMs: known ? growth : 0, why });',
    to: '      if (s.members && [...s.members.keys()].some((k) => !prev.cpu.has(k))) lastActivity = mono;\n      intervals.push({ start: prev.mono, end: mono, known, cpuMs: known ? growth : 0, why });',
    why: 'a new process counts as activity, hiding the polling stall',
    killed_by: /a polling loop of short processes/,
  },
  {
    id: 'S14', file: ST, tests: [TS],
    from: '        if (mainTools.has(ev.parent_tool_use_id)) heartbeats.set(ev.parent_tool_use_id, mono);',
    to: '        heartbeats.set(ev.parent_tool_use_id, mono);',
    why: 'a subagent\'s heartbeat is taken for the step\'s foreground tool',
    killed_by: /a subagent's heartbeat is not the step's foreground tool/,
  },
  {
    id: 'S15', file: ST, tests: [TS],
    from: "      } else if (ev.type === 'assistant' && mainThread(ev)) {\n        setOwed(false, mono);",
    to: "      } else if (ev.type === 'assistant' && mainThread(ev)) {",
    why: 'an answer of the model never clears the owed answer',
    killed_by: /a foreground wait on nothing with heartbeats only/,
  },
  {
    id: 'S16', file: ST, tests: [TS],
    from: '          heartbeats.delete(b.tool_use_id);\n',
    to: '',
    why: 'a tool keeps running after its result',
    killed_by: /a tool result owes an answer, and ends its tool/,
  },
  {
    id: 'S17', file: ST, tests: [TS],
    from: '      if (mono - at <= heartbeatGraceMs) return true;\n      heartbeats.delete(id);',
    to: '      return true;',
    why: 'a tool runs forever after its last heartbeat',
    killed_by: /a subagent's heartbeat is not the step's foreground tool/,
  },
  {
    id: 'S18', file: ST, tests: [TS],
    from: '    else if (w.cpu >= cpuThresholdMs) {',
    to: '    else if (w.cpu > cpuThresholdMs) {',
    why: 'exactly 1 s of CPU in the window stalls',
    killed_by: /the threshold: 999 ms in the window stalls/,
  },
  {
    id: 'S19', file: ST, tests: [TS],
    from: "    if (tail > 3 * intervalMs) {\n      unknown += Math.min(tail, windowMs);\n      why ??= 'no-sample';\n    }\n",
    to: '',
    why: 'no sample for a long time is trusted as a quiet, idle window',
    killed_by: /no sample for over three intervals is unknown/,
  },
  {
    id: 'S20', file: ST, tests: [TS],
    from: "            if (d < 0) { known = false; why = 'regression'; continue; }",
    to: '            if (d < 0) continue;',
    why: 'a counter that went back is passed over as no growth',
    killed_by: /a counter that goes back on one identity makes the window unknown/,
  },
  {
    id: 'S21', file: ST, tests: [TS],
    from: '  const lost = (snapshot.unreadable ?? []).length > 0;',
    to: '  const lost = false;',
    why: 'a live member that cannot be read is taken for an idle one',
    killed_by: /a live member that cannot be read leaves the sample unknown/,
  },
  {
    id: 'S21b', file: ST, tests: [TS],
    from: '  const lost = (snapshot.unreadable ?? []).length > 0;',
    to: '  const lost = (snapshot.unreadable ?? []).some((pid) => [...sticky.values()].includes(pid));',
    why: 'only a known member\'s unreadable pid counts: one never seen, or one a descendant reused since the table before read it outside the tree, is ruled out and its CPU read as zero',
    killed_by: [/a pid that cannot be read and was never seen leaves the sample unknown/, /a pid the table before read outside the tree, unreadable once, is unknown/],
  },
  {
    id: 'S21d', file: ST, tests: [TS],
    from: '          for (const [key, pid] of [...sticky]) if (!present.has(key) && !unread.has(pid)) sticky.delete(key);',
    to: '          for (const [key] of [...sticky]) if (!present.has(key)) sticky.delete(key);',
    why: 'a member that cannot be read is forgotten, and its CPU once readable again is not counted',
    killed_by: /a member that cannot be read stays a member/,
  },
  {
    id: 'S21e', file: ST, tests: [TS],
    from: "    if (j.verdict === current || (j.verdict === 'stalled' && !atSample)) return null;",
    to: '    if (j.verdict === current) return null;',
    why: 'a stream event or the watch\'s end decides stalled over CPU no sample has seen',
    killed_by: [/a heartbeat after the last sample never decides stalled/, /close records the final verdict/],
  },
  {
    id: 'S21f', file: ST, tests: [TS],
    from: '      unknown += Math.min(tail, windowMs);',
    to: '      unknown += tail;',
    why: 'a window\'s unknown time exceeds the window',
    killed_by: /no sample for over three intervals is unknown/,
  },
  {
    id: 'S22', file: ST, tests: [TS],
    from: '    else owedMax = Math.max(owedMax, mono - owedSince);\n',
    to: '',
    why: 'the longest owed answer is never recorded',
    killed_by: /the summary: longest quiet/,
  },
  {
    id: 'S23', file: ST, tests: [TS],
    from: '      if (stalledWaits.length < stalledWaitsMax) stalledWaits.push(wait);',
    to: '      if (true) stalledWaits.push(wait);',
    why: 'the stalled waits a summary keeps are unbounded',
    killed_by: /the stalled waits are bounded/,
  },
  {
    id: 'S24', file: ST, tests: [TS],
    from: '      return evaluate(mono, wall);\n    },\n\n    observeSample',
    to: '      return null;\n    },\n\n    observeSample',
    why: 'activity between samples is judged only at the next sample',
    killed_by: /activity between samples ends a stall at the activity/,
  },
  {
    id: 'S25', file: ST, tests: [TS],
    from: '      const record = evaluate(mono, wall);\n      const tail',
    to: '      const record = null;\n      const tail',
    why: 'the watch\'s end records no final verdict',
    killed_by: /close records the final verdict/,
  },
  {
    id: 'S26', file: ST, tests: [TS],
    from: "const round = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : v);",
    to: 'const round = (v) => v;',
    why: 'a steps.jsonl line keeps fractional milliseconds',
    killed_by: /the steps.jsonl line and the halt detail/,
  },

  // ---- P: the process table --------------------------------------------------
  {
    id: 'P1', file: PR, tests: [TP],
    from: "export const psEnv = (base = process.env) => ({ ...base, LC_ALL: 'C', LANG: 'C' });",
    to: 'export const psEnv = (base = process.env) => ({ ...base });',
    why: 'ps runs in the caller\'s locale, whose start time does not parse',
    killed_by: /runs ps with LC_ALL and LANG pinned to C/,
  },
  {
    id: 'P2', file: PR, tests: [TP],
    from: "      if (e?.code === 'ENOENT' || e?.code === 'ESRCH') exited.push(pid);",
    to: '      if (false) exited.push(pid);',
    why: 'a process that exited between the listing and its read is a gap, not an exit',
    killed_by: /a process gone between the listing and its read is an exit/,
  },
  {
    id: 'P3', file: PR, tests: [TP],
    from: "  if (resolutionMs > MAX_RESOLUTION_MS) return { ok: false, why: 'coarse' };\n  return { ok: true, procs, unreadable: [], exited: [], resolutionMs };",
    to: '  return { ok: true, procs, unreadable: [], exited: [], resolutionMs };',
    why: 'a CPU time in whole seconds is trusted',
    killed_by: /a CPU time in whole seconds is coarser than 0.1 s/,
  },
  {
    id: 'P4', file: PR, tests: [TP],
    from: "    if (!m) return { ok: false, why: 'parse' };",
    to: '    if (!m) continue;',
    why: 'a line that does not parse is passed over, so a localized table reads as no process at all',
    killed_by: /a line that does not parse fails the whole table/,
  },
  {
    id: 'P5', file: PR, tests: [TP],
    from: '  return { pid, ppid, pgid, startTicks, cpuTicks: utime + stime };',
    to: '  return { pid, ppid, pgid, startTicks, cpuTicks: utime + stime + Number(f[13]) + Number(f[14]) };',
    why: 'exited children\'s CPU (cutime, cstime) is added to their parent',
    killed_by: /parses each process after the command name's last/,
  },
  {
    id: 'P6', file: PR, tests: [TP],
    from: "const PS_ARGS = Object.freeze(['-A', '-o', 'pid=,ppid=,pgid=,etime=,lstart=,time=']);",
    to: "const PS_ARGS = Object.freeze(['-A', '-S', '-o', 'pid=,ppid=,pgid=,etime=,lstart=,time=']);",
    why: 'ps -S adds exited children\'s CPU to their parent',
    killed_by: /runs ps with LC_ALL and LANG pinned to C/,
  },
  {
    id: 'P7', file: PR, tests: [TP],
    from: '    return await Promise.race([read, deadline]);',
    to: '    return await read;',
    why: 'a read has no deadline',
    killed_by: /a read past its deadline is a timeout/,
  },
  {
    id: 'P9', file: PR, tests: [TP],
    from: "  if (running !== null) return { ok: false, why: 'slow' };\n",
    to: '',
    why: 'a read starts while the one past its deadline still runs, so reads pile up',
    killed_by: /a read still under way after its deadline makes the next one slow/,
  },
  {
    id: 'P10', file: PR, tests: [TP],
    from: "    if (stopped()) return { ok: false, why: 'timeout' };\n",
    to: '',
    why: 'a walk past its deadline goes on reading every process',
    killed_by: /a read still under way after its deadline makes the next one slow/,
  },
  {
    id: 'P8', file: PR, tests: [TP],
    from: '  if (cachedHz === null) {',
    to: '  if (true) {',
    why: 'getconf runs at every read',
    killed_by: /getconf is asked once/,
  },

  // ---- M: the run's sampler --------------------------------------------------
  {
    id: 'M1', file: SM, tests: [TM],
    from: '      listeners.add(listener);\n      start();',
    to: '      listeners.add(listener);\n      start();\n      const own = setInterval(() => { scans += 1; Promise.resolve(readTable({ deadlineMs })).then(() => {}, () => {}); }, intervalMs);\n      own.unref?.();',
    why: 'each worker reads the process table itself, one read per worker per tick',
    killed_by: /one read per tick for every registered worker/,
  },
  {
    id: 'M2', file: SM, tests: [TM],
    from: "    if (inFlight) {\n      deliver(to, { ok: false, why: 'slow' });\n      return;\n    }\n",
    to: '',
    why: 'a read starts while another is still running',
    killed_by: /a read that never settles is a timeout, then every tick it still runs is slow/,
  },
  {
    id: 'M3', file: SM, tests: [TM],
    from: '      if (settled) return; // late: its tick was already judged unknown\n',
    to: '',
    why: 'a late answer is delivered after its tick was judged unknown',
    killed_by: /a late answer is dropped/,
  },
  {
    id: 'M4', file: SM, tests: [TM],
    from: '      if (!listeners.has(l)) continue;\n',
    to: '',
    why: 'a worker whose watch ended still gets the read in flight',
    killed_by: /a worker unregistered while a read is in flight gets nothing/,
  },

  // ---- K: the worker's watch -------------------------------------------------
  {
    id: 'K1', file: WK, tests: [TW],
    from: "    if (act && stallMode === 'on' && record.verdict === 'stalled' && stall.watching) abort(",
    to: "    if (act && record.verdict === 'stalled' && stall.watching) abort(",
    why: 'log mode stops a stalled step',
    killed_by: /log mode records a stall through onStall and never stops the step/,
  },
  {
    id: 'K2', file: WK, tests: [TW],
    from: '  const closeStdin = () => {\n    if (st.stdinClosed) return;\n    st.stdinClosed = true;',
    to: '  const closeStdin = () => {\n    if (st.stdinClosed) return;\n    st.stdinClosed = true;\n    endWatch();',
    why: 'an idle close of stdin ends the watch, so a worker that ignores it is never judged',
    killed_by: /a worker that ignores an idle close of stdin is judged until it exits/,
  },
  {
    id: 'K3', file: WK, tests: [TW],
    from: '    endWatch();\n    closeStdin();',
    to: '    closeStdin();',
    why: 'a close on a finished report leaves the watch running',
    killed_by: /a close on a finished report ends the watch/,
  },
  {
    id: 'K4', file: WK, tests: [TW],
    from: '      st.exit = { code, signal };\n      endWatch();',
    to: '      st.exit = { code, signal };',
    why: 'the worker\'s exit leaves the watch running until its output closes',
    killed_by: /the worker's exit ends the watch before its output closes/,
  },
  {
    id: 'K5', file: WK, tests: [TW],
    from: '    // An abort under way ends the stall watch (Decision 3, item 10).\n    endWatch();\n',
    to: '',
    why: 'an abort under way leaves the watch running',
    killed_by: /an abort ends the watch/,
  },
  {
    id: 'K6', file: WK, tests: [TW],
    from: "    } catch {\n      try { record = stall.detector.observeSample({ ok: false, why: 'probe-error' }",
    to: "    } catch (e) {\n      if (e) throw e;\n      try { record = stall.detector.observeSample({ ok: false, why: 'probe-error' }",
    why: 'a detector that throws throws into the worker host',
    killed_by: /a detector that throws on a sample reads it as unknown/,
  },
  {
    id: 'K7', file: WK, tests: [TW],
    from: '      try { o.onStall(record); } catch { /* the driver\'s, not the step\'s */ }',
    to: '      o.onStall(record);',
    why: 'a throwing onStall reaches the step',
    killed_by: /a throwing onStall never changes the step's outcome/,
  },

];
