// plugins/orchestrator/adapters/claude/autopilot/events-reader.mjs
//
// ADR-0068 Decision 4, item 6 — the reader of a run's event file
// (events.mjs), behind `agentic-autopilot events`, which the main session's
// Monitor runs.
//
// It prints on stdout, one JSON object per line and in file order, every
// event after its cursor, and with --follow waits for more, across
// relaunches (a relaunch writes to the same file). A cursor is an event's
// identity, `<run-id>:<seq>`, never a position in a run's sequence:
//   - `<run-id>:<seq>` (seq ≥ 1): after that line. A seq its run's lines on
//     file do not hold is an error (`reader-error`, exit 1), never read as
//     "from the start";
//   - `<run-id>:0`: from that run's first line, whenever it arrives: from the
//     first line of the run on file, or the first line written since the run
//     began (its id's stamp), whichever comes first; a file not created yet is
//     waited for.
// With several cursors (a session that lost its own re-arms from `<run>:0`
// of every run it has not seen end), it starts at the earliest of them; the
// session drops what it had by identity. The runs whose end it watches are
// every run a cursor names and every run with a line on file and no
// `run-ended` there, before the cursor too: a re-arm from one line's cursor
// keeps every run still owed its end that has a line on file.
//
// Beside the events it prints its own lines (schema READER_SCHEMA), each with
// `cursor`, the identity of the last event it passed on (or the cursor it was
// armed with), so a re-arm from any line it printed neither repeats nor skips:
//   reader-armed            at each arm: the latest run (by its id's stamp,
//                           on file or named by a cursor), live or ended,
//                           its last seq on file and its failed writes
//   reader-gap              a seq missing within a run (a hint: a seq may be
//                           skipped by a failed write)
//   reader-skipped          a line that is not an event the writer could
//                           have written (events.mjs eventOfLine): only its
//                           offset is printed, never its content
//   reader-terminal-missing a run that ended or died with no `run-ended` on
//                           file, judged at the arm and every 30 s
//   reader-error            the file cannot be read, was truncated or
//                           replaced, or the cursor names no line; exit 1
//   reader-summary          `stall` lines past the window's budget, folded:
//                           counts by verdict, `cursor` the last one covered
// A partial last line is held until its newline arrives.
//
// A run is reported missing its terminal event only when its run.json
// records that it took part (`events`), no `run-ended` of it is on file when
// the file is read again, its driver is not alive (no open-run record whose
// process lives, and no lock entry of it whose process lives), and no cleanup
// of it is under way: a driver appends `run-ended` after its run.json records
// the end and before its open-run record goes, or, when it ends before it
// writes that record (a halt or an error at its start), before it releases
// its locks, so a terminal append in progress is never reported. A launch
// refused at its locks never took part, and is never reported.

import fs from 'node:fs';

import { eventOfLine, isRunId, READER_SCHEMA, RUN_STATUSES, shownEvent, TERMINAL_KINDS } from './events.mjs';

export const POLL_MS = 500;
export const RECONCILE_MS = 30_000;
// Stall lines passed on one by one per delivery window; the rest are folded.
export const STALL_BUDGET = 20;

/** `<run-id>:<seq>` → { runId, seq }, or null. */
export function parseCursor(s) {
  const m = typeof s === 'string' ? /^(.+):(0|[1-9][0-9]{0,15})$/.exec(s) : null;
  if (!m || !isRunId(m[1])) return null;
  return { runId: m[1], seq: Number(m[2]) };
}
export const cursorText = (c) => `${c.runId}:${c.seq}`;

// The moment a run's id was stamped (autopilot-YYYYMMDDTHHMMSSZ-xxxxxx).
function runStampMs(runId) {
  const m = /^autopilot-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(runId);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

// The complete lines of a buffer from `from`: [{ offset, raw }], and where
// the held partial line starts.
function completeLines(buf, from) {
  const lines = [];
  let at = from;
  for (;;) {
    const nl = buf.indexOf(0x0a, at);
    if (nl === -1) break;
    lines.push({ offset: at, raw: buf.subarray(at, nl).toString('utf8') });
    at = nl + 1;
  }
  return { lines, rest: at };
}

// A line is an event only when the writer could have written it
// (events.mjs eventOfLine): anything else, a field outside its kind's
// allow-list, an unknown kind or schema, a value outside its set, a path that
// names no record the driver writes, is skipped and never printed, counted,
// or taken for a run's end or a cursor's line.
const parse = (raw) => {
  if (!raw.trim()) return { blank: true };
  try {
    const v = eventOfLine(JSON.parse(raw));
    return v ? { event: v } : { bad: true };
  } catch {
    return { bad: true };
  }
};
// A run.json status the reader repeats: the driver's, or none.
const RUN_JSON_STATUSES = Object.freeze([...RUN_STATUSES, 'running', 'draining']);

/**
 * Read (and with `follow`, watch) an event file.
 *
 * @param a.file       the event file
 * @param a.cursors    [{ runId, seq }] (at least one)
 * @param a.follow     keep watching after the backlog
 * @param a.out        prints one line
 * @param a.runFacts   async (runId, { runDir }) → { runJsonPath, run, live, open, cleaning } or null:
 *                     the run's run.json as found, whether its driver lives, whether its
 *                     open-run record is there, whether a cleanup of it is under way
 * @param a.signal     an AbortSignal that ends a follow (tests; the CLI's follow ends on outputOpen)
 * @param a.isRoot     (dir) → whether a path field's checkout is one of the repository's:
 *                     a path under none is printed null (events.mjs shownEvent); none
 *                     given, and every path is printed as it is
 * @param a.outputOpen () → false once the output is known gone, asked at each idle poll
 *                     of a follow (the CLI's probe of its stdout)
 * @returns the exit code: 0, or 1 after a reader-error
 */
export async function readEvents({
  file, cursors, follow = false, out, runFacts = async () => null, signal = null, isRoot = null, outputOpen = () => true,
  pollMs = POLL_MS, reconcileMs = RECONCILE_MS, stallBudget = STALL_BUDGET, now = () => Date.now(),
}) {
  const iso = () => new Date(now()).toISOString();
  let lastCursor = cursorText(cursors[0]);
  const say = (kind, fields = {}) => out(JSON.stringify({ schema: READER_SCHEMA, kind, at: iso(), cursor: lastCursor, ...fields }));
  const lastSeq = new Map(); // run → the highest seq read so far, in file order
  const ended = new Set(); // runs with a run-ended on file
  const runDirs = new Map(); // run → its run_dir, as its run-started line names it
  const tracked = new Set(cursors.map((c) => c.runId)); // runs whose end is watched
  const reported = new Set(); // runs reported missing their terminal event
  let order = []; // runs in the order their lines appear

  const note = (e) => {
    if (!order.includes(e.run_id)) order = [...order, e.run_id];
    if (e.kind === 'run-started' && typeof e.run_dir === 'string') runDirs.set(e.run_id, e.run_dir);
    if (TERMINAL_KINDS.includes(e.kind)) ended.add(e.run_id);
  };

  // One delivery window: every line passed on its own, except `stall` lines
  // past the budget, folded into a summary that keeps file order.
  const deliver = (lines) => {
    let budget = stallBudget;
    let folded = null;
    const flush = () => {
      if (!folded) return;
      lastCursor = folded.last;
      say('reader-summary', { kind_folded: 'stall', count: folded.count, verdicts: folded.verdicts });
      folded = null;
    };
    for (const { offset, raw } of lines) {
      const p = parse(raw);
      if (p.blank) continue;
      if (p.bad) {
        flush();
        say('reader-skipped', { offset });
        continue;
      }
      const e = p.event;
      const id = `${e.run_id}:${e.seq}`;
      const prev = lastSeq.get(e.run_id);
      // A gap is a reader line, passed on its own, a folded stall's too.
      if (prev !== undefined && e.seq > prev + 1) {
        flush();
        say('reader-gap', { run_id: e.run_id, after_seq: prev, seq: e.seq });
      }
      if (e.kind === 'stall' && budget <= 0) {
        // Its keys are Decision 3's verdict codes only (eventOfLine).
        folded ??= { count: 0, verdicts: {}, last: null };
        folded.count += 1;
        const v = typeof e.verdict === 'string' ? e.verdict : 'unknown';
        folded.verdicts[v] = (folded.verdicts[v] ?? 0) + 1;
        folded.last = id;
      } else {
        flush();
        if (e.kind === 'stall') budget -= 1;
        out(JSON.stringify(shownEvent(e, isRoot)));
        lastCursor = id;
      }
      if (prev === undefined || e.seq > prev) lastSeq.set(e.run_id, e.seq);
      if (!ended.has(e.run_id)) tracked.add(e.run_id);
      note(e);
    }
    flush();
  };

  // Each run watched with no run-ended on file: reported once its end is
  // known (above), the file read again first.
  const reconcile = async () => {
    for (const runId of tracked) {
      if (ended.has(runId) || reported.has(runId)) continue;
      const f = await runFacts(runId, { runDir: runDirs.get(runId) ?? null });
      if (!f || !f.run || typeof f.run.events !== 'object' || f.run.events === null) continue;
      if (f.live || f.cleaning) continue;
      // A read that fails tells nothing: never a missing end.
      if (endedOnFile(file, runId) !== false) continue;
      reported.add(runId);
      say('reader-terminal-missing', {
        run_id: runId, status: RUN_JSON_STATUSES.includes(f.run.status) ? f.run.status : null,
        failed_writes: Number.isInteger(f.run.events.failed_writes) ? f.run.events.failed_writes : null, pointer: f.runJsonPath,
      });
    }
  };

  // The latest run, by its id's stamp, of those on file and those the
  // cursors name (a run just launched has no line yet), and its last seq on
  // file.
  const armed = async (events) => {
    let latest = null;
    for (const runId of [...order, ...cursors.map((c) => c.runId).filter((r) => !order.includes(r))]) {
      if (latest === null || (runStampMs(runId) ?? -Infinity) >= (runStampMs(latest) ?? -Infinity)) latest = runId;
    }
    const seqs = events.filter((e) => e.run_id === latest).map((e) => e.seq);
    const f = await runFacts(latest, { runDir: runDirs.get(latest) ?? null });
    say('reader-armed', {
      run_id: latest,
      state: ended.has(latest) || (f && !f.live) ? 'ended' : (f ? 'live' : 'unknown'),
      last_seq: seqs.length ? Math.max(...seqs) : null,
      failed_writes: Number.isInteger(f?.run?.events?.failed_writes) ? f.run.events.failed_writes : null,
    });
  };

  const fail = (code, fields = {}) => {
    say('reader-error', { code, path: file, ...fields });
    return 1;
  };

  // The file as it stands.
  let buf;
  let ident = null;
  let readTo = 0; // bytes read
  let held = 0; // where the held partial line starts
  const stat = () => {
    try {
      return fs.statSync(file);
    } catch (e) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
  };
  let st;
  try {
    st = stat();
    if (st && !st.isFile()) return fail('unreadable');
    buf = st ? fs.readFileSync(file) : Buffer.alloc(0);
  } catch {
    return fail('unreadable');
  }
  if (st) ident = { dev: st.dev, ino: st.ino };
  readTo = buf.length;
  const first = completeLines(buf, 0);
  held = first.rest;

  // Where delivery starts: the earliest position any cursor names, which is
  // the cursor the reader's own lines carry until it passes an event on.
  let start = Infinity;
  for (const c of cursors) {
    let at;
    if (c.seq > 0) {
      const i = first.lines.findIndex((l) => { const p = parse(l.raw); return p.event && p.event.run_id === c.runId && p.event.seq === c.seq; });
      if (i === -1) return fail('cursor-not-on-file', { run_id: c.runId, seq: c.seq });
      at = i + 1;
    } else {
      const stamp = runStampMs(c.runId);
      at = first.lines.findIndex((l) => {
        const p = parse(l.raw);
        if (!p.event) return false;
        if (p.event.run_id === c.runId) return true;
        const t = Date.parse(p.event.at);
        return stamp !== null && Number.isFinite(t) && t >= stamp;
      });
      if (at === -1) at = first.lines.length;
    }
    if (at < start) {
      start = at;
      lastCursor = cursorText(c);
    }
  }
  // What came before the cursor is known, not passed on.
  for (const l of first.lines.slice(0, start)) {
    const p = parse(l.raw);
    if (!p.event) continue;
    const prev = lastSeq.get(p.event.run_id);
    if (prev === undefined || p.event.seq > prev) lastSeq.set(p.event.run_id, p.event.seq);
    note(p.event);
  }
  // A run's end anywhere in the file counts, and the latest run is the
  // file's, for the armed line.
  const pending = first.lines.slice(start);
  for (const l of pending) {
    const p = parse(l.raw);
    if (!p.event) continue;
    if (TERMINAL_KINDS.includes(p.event.kind)) ended.add(p.event.run_id);
    if (!order.includes(p.event.run_id)) order = [...order, p.event.run_id];
  }
  // Every run with a line on file and no end there is watched, wherever its
  // lines sit against the cursor: a re-arm past them (from a later run's
  // cursor, or from the one cursor of a session that had several) does not
  // drop its end, and a run whose end write failed while no reader watched
  // is reported at this arm. Such a run is reported again at each arm, as
  // its end is still not on file; a session drops it by its run_id.
  for (const runId of order) if (!ended.has(runId)) tracked.add(runId);
  await armed(first.lines.map((l) => parse(l.raw).event).filter(Boolean));
  deliver(pending);
  await reconcile();
  if (!follow) return 0;

  let lastReconcile = now();
  // Each poll's listener goes with its wait, so a follow that runs for hours
  // holds one at a time.
  const wait = (ms) => new Promise((r) => {
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      r();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
  while (!signal?.aborted) {
    await wait(pollMs);
    if (signal?.aborted) break;
    // An output found gone while the file is idle ends the follow too, as a
    // write that fails does: no line would reach anybody.
    if (!outputOpen()) break;
    let s;
    try {
      s = stat();
    } catch {
      return fail('unreadable');
    }
    if (ident && !s) return fail('replaced');
    if (s) {
      if (!s.isFile()) return fail('unreadable');
      if (ident && (s.dev !== ident.dev || s.ino !== ident.ino)) return fail('replaced');
      if (s.size < readTo) return fail('truncated');
      if (!ident) ident = { dev: s.dev, ino: s.ino };
      if (s.size > readTo) {
        let more;
        try {
          const fd = fs.openSync(file, 'r');
          try {
            more = Buffer.alloc(s.size - readTo);
            let got = 0;
            while (got < more.length) {
              const n = fs.readSync(fd, more, got, more.length - got, readTo + got);
              if (n <= 0) break;
              got += n;
            }
            more = more.subarray(0, got);
          } finally {
            fs.closeSync(fd);
          }
        } catch {
          return fail('unreadable');
        }
        buf = Buffer.concat([buf.subarray(held), more]);
        readTo += more.length;
        const next = completeLines(buf, 0);
        buf = buf.subarray(next.rest);
        held = 0;
        deliver(next.lines);
      }
    }
    if (now() - lastReconcile >= reconcileMs) {
      lastReconcile = now();
      await reconcile();
    }
  }
  return 0;
}

// Whether the file, read again, holds a run-ended of the run on a complete
// line (a file not there holds none); null when it cannot be read. A last
// line with no newline is not counted, whatever it parses to: delivery holds
// it until its newline comes, so counting it here would leave a run with
// neither its end nor a report of it.
function endedOnFile(file, runId) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return e?.code === 'ENOENT' ? false : null; }
  const complete = text.split('\n');
  complete.pop();
  for (const raw of complete) {
    const p = parse(raw);
    if (p.event && p.event.run_id === runId && TERMINAL_KINDS.includes(p.event.kind)) return true;
  }
  return false;
}
