// plugins/orchestrator/adapters/claude/autopilot/stall.mjs
//
// ADR-0068 Decision 3 — the stall detector of one worker step. Pure: it is
// fed the step's stream events and the run's process-table samples
// (stall-sampler.mjs, procs.mjs), each with the monotonic and the wall time
// it was taken at, and answers with the verdict each time it changes.
//
// A step is `stalled` when, for the last 10 minutes of its life, its stream
// carried no event but `tool_progress` heartbeats and hook events, AND the CPU
// time its descendants used, summed, grew by under 1 s, every sample of that
// window known. A step younger than the window is `active`; a window holding
// an unknown sample is `unknown`, never `stalled` (items 1 and 4).
//
// Whose CPU (item 3): the worker's descendants by parent pid and every member
// of its process group, the worker itself excluded. A process is its pid with
// its start time (procs.mjs `key`), so a reused pid is a new process; a member
// stays one until it leaves a known sample, so a descendant reparented when
// its parent exits is still counted. Growth is per identity, between two
// samples: a process first seen counts the CPU it used since its start when it
// started inside the window (attributed to the interval it was first seen in,
// with which it ages out: an over-count that can only make a window `active`);
// a process that exits keeps what the samples saw of it.
//
// Clocks (item 5): every interval and the quiet time are on the monotonic
// clock. An interval is unknown when either of its samples is (its read
// failed, timed out, did not parse, was coarse, or a pid could not be read),
// when its spacing exceeds three sample intervals, when the wall clock
// moved forward more than an interval further than the monotonic clock (a
// suspend, or a forward clock step), or when a member's counter went back.
// The CPU of an interval counts in a window when the interval ends inside it;
// one that straddles the window's start counts whole, an over-count that can
// only make a window `active`. A window's CPU is known only up to its last
// sample, so `stalled` is judged at a sample, never at a stream event or at
// the watch's end, which can only make a verdict `active` or `unknown`.
//
// What the step waits on (item 2), facts that can hold together: how many
// background tasks are pending; whether a foreground tool of the main thread
// runs (its heartbeats arriving, within 75 s of the last, until its
// tool_result); whether an answer of the model is owed (after the step's
// prompt, a main-thread tool result or a task notification, with no
// main-thread answer since).

export const STALL_WINDOW_MS = 600_000;
export const SAMPLE_INTERVAL_MS = 10_000;
export const CPU_THRESHOLD_MS = 1000;
export const HEARTBEAT_GRACE_MS = 75_000;
export const STALLED_WAITS_MAX = 20;
// macOS `etime` is in whole seconds: a process first seen counts as started
// inside the window when its age is within the window plus this.
const AGE_SLACK_MS = 1000;

/** Whether a stream event is activity: anything but a heartbeat or a hook event. */
export function isActivity(ev) {
  if (!ev || typeof ev !== 'object') return false;
  if (ev.type === 'tool_progress' && ev.heartbeat === true) return false;
  if (ev.type === 'system' && (ev.subtype === 'hook_started' || ev.subtype === 'hook_response')) return false;
  return true;
}

const blocks = (ev) => (Array.isArray(ev?.message?.content) ? ev.message.content : []);
const mainThread = (ev) => ev.parent_tool_use_id === null || ev.parent_tool_use_id === undefined;

/**
 * The members of a worker's tree in one known table, and whether the table is
 * complete for it: { members: Map key → proc, complete, why }. A pid the
 * table could not read may be a member the sample misses: no pid can be ruled
 * out of the tree without its identity, so the table is complete for no worker.
 */
export function membersOf(snapshot, workerPid, sticky) {
  const procs = snapshot.procs;
  const children = new Map();
  for (const p of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }
  const members = new Map();
  const queue = [];
  const visit = (p) => {
    if (p.pid === workerPid || members.has(p.key)) return;
    members.set(p.key, p);
    queue.push(p.pid);
  };
  for (const c of children.get(workerPid) ?? []) visit(c);
  for (const p of procs) if (p.pgid === workerPid || sticky.has(p.key)) visit(p);
  while (queue.length > 0) for (const c of children.get(queue.pop()) ?? []) visit(c);
  // A pid the table could not read leaves the worker's sample unknown, whoever
  // it was before: a live member, one never seen, or one the previous table
  // read outside the tree, whose pid may have been reused by a descendant
  // since (an unreadable entry carries no start time to tell them apart).
  const lost = (snapshot.unreadable ?? []).length > 0;
  return { members, complete: !lost, why: lost ? 'unreadable-member' : null };
}

/**
 * One step's detector.
 *
 * @param a.workerPid   the worker process (excluded from its own CPU)
 * @param a.startMono, a.startWall  the spawn, on each clock (ms)
 * @returns { observeEvent(ev, mono, wall), observeSample(snapshot, mono, wall),
 *            close(mono, wall), summary(), verdict }
 *   observeEvent / observeSample return the record of a verdict change, or
 *   null; close returns { record, summary }.
 */
export function createStallDetector({
  workerPid, startMono, startWall, windowMs = STALL_WINDOW_MS, intervalMs = SAMPLE_INTERVAL_MS,
  cpuThresholdMs = CPU_THRESHOLD_MS, heartbeatGraceMs = HEARTBEAT_GRACE_MS, stalledWaitsMax = STALLED_WAITS_MAX,
}) {
  let lastActivity = startMono;
  let longestQuiet = 0;
  let lowestWindowCpu = null;
  let unknownTotal = 0;
  let ended = false;
  // The latest time any observation was made at, for the summary's open wait.
  let lastMono = startMono;
  // The wait.
  let pendingTasks = 0;
  let owed = true;
  let owedSince = startMono;
  let owedMax = 0;
  const mainTools = new Set();
  const heartbeats = new Map(); // tool id → mono of its last heartbeat
  // The samples: the spawn is a known one with nothing in the tree.
  let prev = { mono: startMono, wall: startWall, known: true, cpu: new Map() };
  const intervals = []; // { start, end, known, cpuMs, why }
  const sticky = new Map(); // key → pid
  let current = 'active';
  const counts = { active: 1, stalled: 0, unknown: 0 };
  const stalledWaits = [];
  let stalledWaitsTruncated = 0;

  const setOwed = (v, mono) => {
    if (v === owed) return;
    if (v) owedSince = mono;
    else owedMax = Math.max(owedMax, mono - owedSince);
    owed = v;
  };
  const toolRunning = (mono) => {
    for (const [id, at] of heartbeats) {
      if (mono - at <= heartbeatGraceMs) return true;
      heartbeats.delete(id);
    }
    return false;
  };

  const windowAt = (mono) => {
    const from = mono - windowMs;
    let cpu = 0;
    let unknown = 0;
    let why = null;
    for (const i of intervals) {
      if (i.end <= from || i.end > mono) continue;
      if (i.known) cpu += i.cpuMs;
      else {
        unknown += i.end - Math.max(i.start, from);
        why ??= i.why;
      }
    }
    // The time since the last sample, once it is not known to be short.
    const tail = mono - prev.mono;
    if (tail > 3 * intervalMs) {
      unknown += Math.min(tail, windowMs);
      why ??= 'no-sample';
    }
    return { cpu: unknown > 0 ? null : cpu, unknown, why };
  };

  const judge = (mono) => {
    const quiet = mono - lastActivity;
    const w = windowAt(mono);
    let verdict;
    let why;
    if (mono - startMono < windowMs) { verdict = 'active'; why = 'young'; }
    else if (quiet < windowMs) { verdict = 'active'; why = 'stream'; }
    else if (w.cpu === null) { verdict = 'unknown'; why = w.why; }
    else if (w.cpu >= cpuThresholdMs) { verdict = 'active'; why = 'cpu'; }
    else { verdict = 'stalled'; why = 'quiet-and-idle'; }
    return { verdict, why, quiet, window: w };
  };

  // `atSample`: the window's CPU is known to this moment. Elsewhere (a stream
  // event, the watch's end) the time since the last sample is unseen, so no
  // verdict turns `stalled` there.
  const evaluate = (mono, wall, atSample = false) => {
    const j = judge(mono);
    longestQuiet = Math.max(longestQuiet, j.quiet);
    if (atSample && mono - startMono >= windowMs && j.window.cpu !== null) {
      lowestWindowCpu = lowestWindowCpu === null ? j.window.cpu : Math.min(lowestWindowCpu, j.window.cpu);
    }
    if (j.verdict === current || (j.verdict === 'stalled' && !atSample)) return null;
    current = j.verdict;
    counts[current] += 1;
    const record = {
      verdict: current, at: new Date(wall).toISOString(), quiet_ms: j.quiet, window_cpu_ms: j.window.cpu,
      unknown_ms: j.window.unknown, pending_tasks: pendingTasks, tool_running: toolRunning(mono), answer_owed: owed, why: j.why,
    };
    if (current === 'stalled') {
      const wait = { at: record.at, quiet_ms: record.quiet_ms, window_cpu_ms: record.window_cpu_ms, pending_tasks: record.pending_tasks, tool_running: record.tool_running, answer_owed: record.answer_owed };
      if (stalledWaits.length < stalledWaitsMax) stalledWaits.push(wait);
      else stalledWaitsTruncated += 1;
    }
    return record;
  };

  const sampleOf = (snapshot) => {
    if (!snapshot || snapshot.ok !== true || !Array.isArray(snapshot.procs)) {
      return { known: false, why: typeof snapshot?.why === 'string' ? snapshot.why : 'failed', members: null };
    }
    const m = membersOf(snapshot, workerPid, sticky);
    return { known: m.complete, why: m.why, members: m.members };
  };

  return {
    get verdict() { return current; },

    observeEvent(ev, mono, wall) {
      if (ended || !ev || typeof ev !== 'object') return null;
      lastMono = Math.max(lastMono, mono);
      if (ev.type === 'system' && ev.subtype === 'background_tasks_changed') {
        pendingTasks = Array.isArray(ev.tasks) ? ev.tasks.length : 0;
      } else if (ev.type === 'system' && ev.subtype === 'task_notification') {
        setOwed(true, mono);
      } else if (ev.type === 'tool_progress' && ev.heartbeat === true) {
        // A heartbeat names its tool; only a main-thread tool is the step's
        // foreground wait (a subagent's tool is the subagent's).
        if (mainTools.has(ev.parent_tool_use_id)) heartbeats.set(ev.parent_tool_use_id, mono);
      } else if (ev.type === 'assistant' && mainThread(ev)) {
        setOwed(false, mono);
        for (const b of blocks(ev)) if (b?.type === 'tool_use' && typeof b.id === 'string') mainTools.add(b.id);
      } else if (ev.type === 'user' && mainThread(ev)) {
        let answered = false;
        for (const b of blocks(ev)) {
          if (b?.type !== 'tool_result') continue;
          answered = true;
          heartbeats.delete(b.tool_use_id);
        }
        if (answered) setOwed(true, mono);
      } else if (ev.type === 'result') {
        setOwed(false, mono);
      }
      if (isActivity(ev)) {
        longestQuiet = Math.max(longestQuiet, mono - lastActivity);
        lastActivity = mono;
      }
      return evaluate(mono, wall);
    },

    observeSample(snapshot, mono, wall) {
      if (ended || !(mono > prev.mono)) return null;
      lastMono = Math.max(lastMono, mono);
      const s = sampleOf(snapshot);
      const dMono = mono - prev.mono;
      const dWall = wall - prev.wall;
      let known = s.known && prev.known;
      let why = !s.known ? s.why : !prev.known ? 'after-unknown' : null;
      if (known && dMono > 3 * intervalMs) { known = false; why = 'spacing'; }
      if (known && dWall - dMono > intervalMs) { known = false; why = 'clock'; }
      const cpu = new Map();
      let growth = 0;
      if (s.members) {
        for (const [key, p] of s.members) {
          cpu.set(key, p.cpuMs);
          if (!known) continue;
          if (prev.cpu.has(key)) {
            const d = p.cpuMs - prev.cpu.get(key);
            if (d < 0) { known = false; why = 'regression'; continue; }
            growth += d;
          } else if (p.ageMs <= windowMs + AGE_SLACK_MS) {
            growth += p.cpuMs;
          }
        }
        // A key absent from a table that read it has exited; one whose pid
        // the table could not read is still a member.
        if (snapshot.ok === true) {
          const present = new Set(snapshot.procs.map((p) => p.key));
          const unread = new Set(snapshot.unreadable ?? []);
          for (const [key, pid] of [...sticky]) if (!present.has(key) && !unread.has(pid)) sticky.delete(key);
        }
        for (const [key, p] of s.members) sticky.set(key, p.pid);
      }
      intervals.push({ start: prev.mono, end: mono, known, cpuMs: known ? growth : 0, why });
      if (!known) unknownTotal += dMono;
      prev = { mono, wall, known: s.known, cpu };
      while (intervals.length > 0 && intervals[0].end <= mono - windowMs) intervals.shift();
      return evaluate(mono, wall, true);
    },

    close(mono, wall) {
      if (ended) return { record: null, summary: this.summary() };
      lastMono = Math.max(lastMono, mono);
      const record = evaluate(mono, wall);
      const tail = mono - prev.mono;
      if (tail > 3 * intervalMs) unknownTotal += tail;
      setOwed(false, mono);
      ended = true;
      return { record, summary: this.summary() };
    },

    summary() {
      return {
        longest_quiet_ms: longestQuiet,
        lowest_window_cpu_ms: lowestWindowCpu,
        unknown_ms: unknownTotal,
        verdict_counts: { ...counts },
        answer_owed_max_ms: owed ? Math.max(owedMax, lastMono - owedSince) : owedMax,
        stalled_waits: stalledWaits.map((x) => ({ ...x })),
        stalled_waits_truncated: stalledWaitsTruncated,
        last: current,
      };
    },
  };
}

const round = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : v);

/** A summary with its times in whole milliseconds, as the records keep it. */
export function roundedSummary(s) {
  if (!s) return null;
  return {
    ...s,
    longest_quiet_ms: round(s.longest_quiet_ms), lowest_window_cpu_ms: s.lowest_window_cpu_ms === null ? null : round(s.lowest_window_cpu_ms),
    unknown_ms: round(s.unknown_ms), answer_owed_max_ms: round(s.answer_owed_max_ms),
    stalled_waits: (s.stalled_waits ?? []).map((w) => ({ ...w, quiet_ms: round(w.quiet_ms), window_cpu_ms: w.window_cpu_ms === null ? null : round(w.window_cpu_ms) })),
  };
}

/** A verdict's steps.jsonl line: `stall`, the step's seq and lane, the record in whole ms. */
export function stallStepLine(record, { seq, lane = null, mode }) {
  return {
    event: 'stall', seq, lane, at: record.at, mode, verdict: record.verdict,
    quiet_ms: round(record.quiet_ms), window_cpu_ms: record.window_cpu_ms === null ? null : round(record.window_cpu_ms),
    unknown_ms: round(record.unknown_ms), pending_tasks: record.pending_tasks, tool_running: record.tool_running,
    answer_owed: record.answer_owed, why: record.why,
  };
}

/** The wait a record names, in words (a halt's detail). */
export function waitText(r) {
  const parts = [];
  if (r.answer_owed) parts.push('an answer of the model owed');
  if (r.tool_running) parts.push('a foreground tool running');
  if (r.pending_tasks > 0) parts.push(`${r.pending_tasks} background task${r.pending_tasks === 1 ? '' : 's'} pending`);
  return parts.length > 0 ? parts.join(', ') : 'nothing the stream named';
}

/** The detail of a step a `stalled` verdict aborted. */
export function stalledDetail(r) {
  const min = Math.floor(r.quiet_ms / 60_000);
  const cpu = r.window_cpu_ms === null ? '?' : (r.window_cpu_ms / 1000).toFixed(2);
  return `the step stalled: no stream activity for ${min} min and its descendants used ${cpu} s of CPU in the last 10 min (waiting on: ${waitText(r)}); its process group was killed`;
}
