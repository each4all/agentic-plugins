// tests/orchestrator/test-autopilot-events-reader.mjs
//
// ADR-0068 Decision 4, item 6 — the reader of the event file
// (plugins/orchestrator/adapters/claude/autopilot/events-reader.mjs, behind
// `agentic-autopilot events`): replay after a cursor, follow across a
// relaunch, interleaved runs, a held partial line, gaps, unparsable lines, a
// run missing its terminal event, `R:0` before anything is on file, errors,
// and the volume bound on `stall` lines.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const E = await import(resolve(AP, 'events.mjs'));
const R = await import(resolve(AP, 'events-reader.mjs'));

const MACRO = 'macro-plan-20261019T084450Z-b66aaa';
const R1 = 'autopilot-20261019T090000Z-aaaaaa';
const R2 = 'autopilot-20261019T091500Z-bbbbbb';
const R3 = 'autopilot-20261019T093000Z-cccccc';
const P = `/repo/.agentic-plugins/runs/autopilot/${R1}/run.json`;
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
// Whether this system fails a write of no bytes to a shell pipe (a FIFO)
// whose reader is gone (macOS does; Linux takes it as done): only there can
// the CLI's idle probe of its output (cli.mjs outputProbe) notice a gone
// reader. Measured through bash and `head -1`, as a person pipes the reader.
const NULL_WRITE_FAILS = (() => {
  const probe = 'const fs = require("node:fs"); fs.writeSync(1, "x\\n"); setTimeout(() => { try { fs.writeSync(1, Buffer.alloc(0)); process.exit(3); } catch (e) { process.exit(e.code === "EPIPE" ? 0 : 4); } }, 300);';
  const r = spawnSync('bash', ['-c', '"$0" -e "$1" | head -1 > /dev/null; exit "${PIPESTATUS[0]}"', process.execPath, probe], { timeout: 10_000 });
  return r.status === 0;
})();

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ap-reader-'));
  const file = join(dir, 'events', `${MACRO}.jsonl`);
  mkdirSync(join(dir, 'events'));
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};
// A line of run `run`, as a writer would write it; `at` defaults to the run's start.
const line = (run, seq, kind = 'lane-held', extra = {}) => JSON.stringify({
  schema: E.EVENT_SCHEMA, run_id: run, seq, at: extra.at ?? `${run.slice(10, 14)}-${run.slice(14, 16)}-${run.slice(16, 18)}T${run.slice(19, 21)}:${run.slice(21, 23)}:${run.slice(23, 25)}.500Z`,
  kind, macro_id: MACRO, subtask_id: null,
  ...(kind === 'run-ended' ? { status: 'halted', reason: 'interrupted', exit: 2, pointer: P, cleanup: false, terminal: true } : {}),
  ...(kind === 'stall' ? { step: 1, verdict: extra.verdict ?? 'active', mode: 'log', waiting: false, quiet_ms: 1, window_cpu_ms: null, pointer: P } : {}),
  ...(kind === 'lane-held' ? { hold_id: '0123456789abcdef', pointer: P } : {}),
});
const put = (file, ...ls) => appendFileSync(file, ls.map((l) => `${l}\n`).join(''));
const cur = (s) => R.parseCursor(s);

// Read once (no follow): the lines printed, parsed.
async function read(file, cursors, o = {}) {
  const outLines = [];
  const code = await R.readEvents({ file, cursors: cursors.map(cur), out: (l) => outLines.push(JSON.parse(l)), ...o });
  return { code, lines: outLines, events: outLines.filter((x) => x.schema === E.EVENT_SCHEMA), reader: outLines.filter((x) => x.schema === E.READER_SCHEMA) };
}
const ids = (events) => events.map((e) => `${e.run_id}:${e.seq}`);

// Follow in process: lines as they arrive; `stop()` ends it.
function follow(file, cursors, o = {}) {
  const ac = new AbortController();
  const got = [];
  const done = R.readEvents({ file, cursors: cursors.map(cur), follow: true, out: (l) => got.push(JSON.parse(l)), signal: ac.signal, pollMs: 20, ...o });
  return {
    got, done,
    stop: async () => { ac.abort(); return done; },
    until: async (pred, ms = 5000) => { for (let t = 0; t < ms && !pred(got); t += 20) await pause(20); ok(pred(got), JSON.stringify(got)); },
  };
}

describe('replay after a cursor (Decision 4, item 6)', () => {
  it('prints every event after the cursor, in file order, interleaved runs included, and nothing before it', async () => {
    const t = tmp();
    try {
      put(t.file, line(R1, 1), line(R1, 2), line(R2, 1), line(R1, 3, 'run-ended'), line(R2, 2));
      const r = await read(t.file, [`${R1}:2`]);
      strictEqual(r.code, 0);
      deepStrictEqual(ids(r.events), [`${R2}:1`, `${R1}:3`, `${R2}:2`]);
      strictEqual(r.reader[0].kind, 'reader-armed');
      deepStrictEqual([r.reader[0].run_id, r.reader[0].last_seq, r.reader[0].cursor], [R2, 2, `${R1}:2`]);
    } finally {
      t.cleanup();
    }
  });

  it('R:0 is from the run\'s first line, or the first line written since it began, whichever comes first', async () => {
    const t = tmp();
    try {
      // R1's cleanup line, written after R2 began, comes before R2's first.
      put(t.file, line(R1, 1), line(R1, 2, 'run-ended', { at: '2026-10-19T09:15:00.200Z' }), line(R2, 1));
      deepStrictEqual(ids((await read(t.file, [`${R2}:0`])).events), [`${R1}:2`, `${R2}:1`]);
      deepStrictEqual(ids((await read(t.file, [`${R1}:0`])).events), [`${R1}:1`, `${R1}:2`, `${R2}:1`]);
    } finally {
      t.cleanup();
    }
  });

  it('a cursor naming a seq its run\'s lines on file do not hold is an error: a reader-error line, then exit 1', async () => {
    const t = tmp();
    try {
      put(t.file, line(R1, 1), line(R1, 2));
      const r = await read(t.file, [`${R1}:5`]);
      strictEqual(r.code, 1);
      deepStrictEqual(r.events, []);
      deepStrictEqual(r.reader.map((x) => [x.kind, x.code, x.run_id, x.seq]), [['reader-error', 'cursor-not-on-file', R1, 5]]);
      const none = await read(join(t.dir, 'nothing.jsonl'), [`${R1}:1`]);
      deepStrictEqual([none.code, none.reader.map((x) => x.code)], [1, ['cursor-not-on-file']]);
    } finally {
      t.cleanup();
    }
  });

  it('a file that cannot be read is a reader-error and exit 1', async () => {
    const t = tmp();
    try {
      mkdirSync(t.file);
      const r = await read(t.file, [`${R1}:0`]);
      deepStrictEqual([r.code, r.reader.map((x) => x.kind)], [1, ['reader-error']]);
    } finally {
      t.cleanup();
    }
  });

  it('a seq missing within a run is a reader-gap hint, and a line that does not parse a reader-skipped, each carrying the cursor before it', async () => {
    const t = tmp();
    try {
      put(t.file, line(R1, 1), line(R1, 2), '{"schema":"agentic-autopilot-event/1","run_id":"x', line(R1, 5));
      const r = await read(t.file, [`${R1}:1`]);
      deepStrictEqual(r.lines.slice(1).map((x) => [x.kind, x.seq ?? null, x.cursor ?? null]), [
        ['lane-held', 2, null], ['reader-skipped', null, `${R1}:2`], ['reader-gap', 5, `${R1}:2`], ['lane-held', 5, null],
      ]);
      deepStrictEqual([r.lines[3].after_seq, r.lines[3].seq], [2, 5]);
    } finally {
      t.cleanup();
    }
  });
});

describe('volume (Decision 4, item 6)', () => {
  it('a backlog folds only stall lines past the window\'s budget, in file order, and a re-arm from the summary\'s cursor neither repeats nor skips', async () => {
    const t = tmp();
    try {
      const ls = [];
      let seq = 0;
      const add = (kind, extra) => { seq += 1; ls.push(line(R1, seq, kind, extra)); };
      for (let i = 0; i < 4; i += 1) add('stall', { verdict: 'active' });
      add('lane-held');
      for (let i = 0; i < 3; i += 1) add('stall', { verdict: i === 0 ? 'stalled' : 'active' });
      add('run-ended');
      put(t.file, ...ls);
      const r = await read(t.file, [`${R1}:0`], { stallBudget: 2 });
      // 2 stalls passed, 2 folded; lane-held; 3 folded (the budget is not
      // reset by the line between); run-ended.
      deepStrictEqual(r.lines.slice(1).map((x) => (x.kind === 'reader-summary' ? `summary:${x.count}:${x.cursor}` : `${x.kind}:${x.seq}`)), [
        'stall:1', 'stall:2', `summary:2:${R1}:4`, 'lane-held:5', `summary:3:${R1}:8`, 'run-ended:9',
      ]);
      deepStrictEqual(r.lines.find((x) => x.cursor === `${R1}:8` && x.kind === 'reader-summary').verdicts, { stalled: 1, active: 2 });
      // Re-armed from the first summary's cursor: from lane-held on.
      deepStrictEqual(ids((await read(t.file, [`${R1}:4`], { stallBudget: 2 })).events).slice(0, 1), [`${R1}:5`]);
      // Every other kind is passed on its own, whatever the budget.
      ok((await read(t.file, [`${R1}:0`], { stallBudget: 0 })).events.every((e) => e.kind !== 'stall'));
      strictEqual((await read(t.file, [`${R1}:0`], { stallBudget: 0 })).events.length, 2);
    } finally {
      t.cleanup();
    }
  });
});

describe('reader lines among folded stalls', () => {
  it('a gap between folded stall lines is still a reader-gap line, in file order', async () => {
    const t = tmp();
    try {
      put(t.file, line(R1, 1, 'stall'), line(R1, 4, 'stall'), line(R1, 5, 'run-ended'));
      const r = await read(t.file, [`${R1}:0`], { stallBudget: 1 });
      deepStrictEqual(r.lines.slice(1).map((x) => x.kind), ['stall', 'reader-gap', 'reader-summary', 'run-ended']);
      deepStrictEqual([r.lines[2].after_seq, r.lines[2].seq], [1, 4]);
    } finally {
      t.cleanup();
    }
  });
});

describe('follow (Decision 4, item 6)', () => {
  it('R:0 and a file not yet created wait; a partial last line is held until its newline arrives', async () => {
    const t = tmp();
    const f = follow(t.file, [`${R1}:0`]);
    try {
      await pause(100);
      deepStrictEqual(f.got.map((x) => x.kind), ['reader-armed']);
      writeFileSync(t.file, `${line(R1, 1)}\n${line(R1, 2).slice(0, 30)}`);
      await f.until((g) => g.length === 2);
      await pause(100);
      strictEqual(f.got.length, 2, 'the partial line is held');
      appendFileSync(t.file, `${line(R1, 2).slice(30)}\n`);
      await f.until((g) => g.length === 3);
      deepStrictEqual(ids(f.got.filter((x) => x.schema === E.EVENT_SCHEMA)), [`${R1}:1`, `${R1}:2`]);
      strictEqual(await f.stop(), 0);
    } finally {
      await f.stop();
      t.cleanup();
    }
  });

  it('a file truncated or replaced while followed is a reader-error, and exit 1', async () => {
    const t = tmp();
    try {
      put(t.file, line(R1, 1), line(R1, 2));
      const f = follow(t.file, [`${R1}:0`]);
      await f.until((g) => g.length === 3);
      writeFileSync(t.file, `${line(R1, 1)}\n`);
      // Bounded: a reader that missed it would follow on forever.
      const code = await Promise.race([f.done, pause(3000).then(() => 'still following')]);
      if (code === 'still following') await f.stop();
      strictEqual(code, 1);
      deepStrictEqual(f.got.at(-1).code, 'truncated');
    } finally {
      t.cleanup();
    }
  });

  it('a file replaced by another as large or larger (an atomic rename over it) while followed is a reader-error `replaced`, and exit 1', async () => {
    const t = tmp();
    try {
      put(t.file, line(R1, 1), line(R1, 2));
      const f = follow(t.file, [`${R1}:0`]);
      await f.until((g) => g.length === 3);
      // Another file, its size not shrinking, renamed into place: only its
      // identity tells it from the one being read.
      const other = `${t.file}.new`;
      writeFileSync(other, `${line(R1, 1)}\n${line(R1, 2)}\n${line(R1, 3)}\n`);
      renameSync(other, t.file);
      const code = await Promise.race([f.done, pause(3000).then(() => 'still following')]);
      if (code === 'still following') await f.stop();
      strictEqual(code, 1);
      deepStrictEqual(f.got.at(-1).code, 'replaced');
      deepStrictEqual(ids(f.got.filter((x) => x.schema === E.EVENT_SCHEMA)), [`${R1}:1`, `${R1}:2`], 'nothing of the other file is passed on');
    } finally {
      t.cleanup();
    }
  });

  it('replay from a recorded position across a relaunch, through the CLI, neither loses nor repeats an event', async () => {
    const t = tmp();
    // The CLI as Monitor runs it: --checkout names a verb chain's checkout.
    const checkout = join(t.dir, 'co');
    const file = join(checkout, '.agentic-plugins/runs/autopilot/events.jsonl');
    mkdirSync(join(checkout, '.agentic-plugins/runs/autopilot'), { recursive: true });
    const git = (...a) => spawn('git', ['-C', checkout, ...a]);
    await new Promise((r) => { mkdirSync(checkout, { recursive: true }); git('init', '-q').on('exit', r); });
    const watch = (after) => {
      const p = spawn(process.execPath, [resolve(AP, 'cli.mjs'), 'events', '--checkout', checkout, ...after.flatMap((a) => ['--after', a]), '--follow'], { cwd: checkout });
      const got = [];
      let buf = '';
      p.stdout.on('data', (d) => {
        buf += d;
        for (let i = buf.indexOf('\n'); i !== -1; i = buf.indexOf('\n')) { got.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
      });
      return { p, got, until: async (pred) => { for (let i = 0; i < 300 && !pred(got); i += 1) await pause(20); ok(pred(got), JSON.stringify(got)); } };
    };
    try {
      const run1 = E.createEventWriter({ file, runId: R1, macroId: null });
      // Records under the checkout: the CLI holds each path to the repository's checkouts.
      const at = (run, name) => join(checkout, '.agentic-plugins/runs/autopilot', run, name);
      const fields = { hold_id: '0123456789abcdef', pointer: at(R1, 'lanes.jsonl') };
      const w1 = watch([`${R1}:0`]);
      run1.emit('lane-held', fields);
      run1.emit('lane-held', fields);
      await w1.until((g) => g.filter((x) => x.schema === E.EVENT_SCHEMA).length === 2);
      // The watch expires; meanwhile run 1 ends and run 2 (the relaunch)
      // writes to the same file, interleaved with run 1's late line.
      await pause(1200); // past two polls: a line read twice would show
      w1.p.kill();
      const last = w1.got.filter((x) => x.schema === E.EVENT_SCHEMA).at(-1);
      const run2 = E.createEventWriter({ file, runId: R2, macroId: null });
      run2.emit('lane-held', fields);
      run1.emit('run-ended', { status: 'halted', reason: 'interrupted', exit: 2, pointer: at(R1, 'run.json'), cleanup: true });
      run2.emit('lane-held', fields);
      const w2 = watch([`${last.run_id}:${last.seq}`]);
      await w2.until((g) => g.filter((x) => x.schema === E.EVENT_SCHEMA).length === 3);
      run2.emit('run-ended', { status: 'completed', reason: null, exit: 0, pointer: at(R2, 'run.json'), cleanup: false });
      await w2.until((g) => g.filter((x) => x.schema === E.EVENT_SCHEMA).length === 4);
      await pause(1200);
      w2.p.kill();
      const seen = [...w1.got, ...w2.got].filter((x) => x.schema === E.EVENT_SCHEMA).map((e) => `${e.run_id}:${e.seq}`);
      deepStrictEqual(seen, [`${R1}:1`, `${R1}:2`, `${R2}:1`, `${R1}:3`, `${R2}:2`, `${R2}:3`]);
    } finally {
      t.cleanup();
    }
  });
});

describe('a run missing its terminal event (Decision 4, item 6)', () => {
  // runFacts as the CLI answers it, from a table: run → facts.
  const facts = (table) => async (runId) => table[runId] ?? null;
  const took = (o = {}) => ({ runJsonPath: `/r/${o.id ?? 'x'}/run.json`, run: { status: 'halted', events: { path: '/f', failed_writes: o.failed ?? 0 }, ...(o.run ?? {}) }, live: false, cleaning: false, ...o.f });

  it('a run whose every write failed, then the next run\'s lines: a watch armed at its R:0 reports its terminal missing and delivers the next run\'s lines', async () => {
    const t = tmp();
    try {
      put(t.file, line(R2, 1), line(R2, 2, 'run-ended'));
      const r = await read(t.file, [`${R1}:0`], { runFacts: facts({ [R1]: took({ id: R1, failed: 3 }), [R2]: took({ id: R2 }) }) });
      deepStrictEqual(ids(r.events), [`${R2}:1`, `${R2}:2`]);
      const missing = r.reader.filter((x) => x.kind === 'reader-terminal-missing');
      deepStrictEqual(missing.map((x) => [x.run_id, x.failed_writes, x.pointer, x.status]), [[R1, 3, `/r/${R1}/run.json`, 'halted']]);
    } finally {
      t.cleanup();
    }
  });

  it('is not reported while the driver lives (its terminal append under way), nor while a cleanup runs, nor for a run that never took part (a launch refused at its locks)', async () => {
    const t = tmp();
    try {
      put(t.file, line(R1, 1), line(R2, 1), line(R3, 1));
      const table = {
        [R1]: took({ id: R1, run: { status: 'halted' }, f: { live: true } }),
        [R2]: took({ id: R2, f: { cleaning: true } }),
        [R3]: { runJsonPath: '/r/3/run.json', run: { status: 'halted' }, live: false, cleaning: false },
      };
      const r = await read(t.file, [`${R1}:0`], { runFacts: facts(table) });
      deepStrictEqual(r.reader.filter((x) => x.kind === 'reader-terminal-missing'), []);
      // The driver gone and its run-ended never written: reported once.
      table[R1] = took({ id: R1 });
      const again = await read(t.file, [`${R1}:0`], { runFacts: facts(table) });
      deepStrictEqual(again.reader.filter((x) => x.kind === 'reader-terminal-missing').map((x) => x.run_id), [R1]);
    } finally {
      t.cleanup();
    }
  });

  it('a failed last write is found by the 30 s reconciliation while it follows, with no re-arm; a run-ended that lands is delivered instead', async () => {
    const t = tmp();
    try {
      put(t.file, line(R1, 1), line(R2, 1));
      const table = { [R1]: took({ id: R1, f: { live: true } }), [R2]: took({ id: R2, f: { live: true } }) };
      const f = follow(t.file, [`${R1}:0`], { runFacts: facts(table), reconcileMs: 60 });
      await f.until((g) => g.filter((x) => x.schema === E.EVENT_SCHEMA).length === 2);
      // R1's driver ends with its last write failed; R2's run-ended lands.
      table[R1] = took({ id: R1, failed: 1 });
      put(t.file, line(R2, 2, 'run-ended'));
      table[R2] = took({ id: R2 });
      await f.until((g) => g.some((x) => x.kind === 'reader-terminal-missing'));
      await pause(200);
      deepStrictEqual(f.got.filter((x) => x.kind === 'reader-terminal-missing').map((x) => [x.run_id, x.failed_writes]), [[R1, 1]]);
      ok(f.got.some((x) => x.kind === 'run-ended' && x.run_id === R2));
      await f.stop();
    } finally {
      t.cleanup();
    }
  });

  it('a re-arm past an unfinished run\'s lines (from a later run\'s cursor) still reports its end missing once its record is left with its driver gone', async () => {
    const t = tmp();
    try {
      put(t.file, line(R1, 1), line(R2, 1), line(R2, 2));
      const table = { [R1]: took({ id: R1, run: { status: 'running' }, f: { open: true } }), [R2]: took({ id: R2, f: { live: true } }) };
      const r = await read(t.file, [`${R2}:1`], { runFacts: facts(table) });
      deepStrictEqual(ids(r.events), [`${R2}:2`]);
      deepStrictEqual(r.reader.filter((x) => x.kind === 'reader-terminal-missing').map((x) => x.run_id), [R1]);
      // Its end write failed while no reader watched (no record left, nothing
      // live): still owed its end, so a re-arm past it reports it again.
      table[R1] = took({ id: R1 });
      deepStrictEqual((await read(t.file, [`${R2}:1`], { runFacts: facts(table) })).reader.filter((x) => x.kind === 'reader-terminal-missing').map((x) => x.run_id), [R1]);
      // Once its end is on file, it is not.
      put(t.file, line(R1, 2, 'run-ended'));
      deepStrictEqual((await read(t.file, [`${R2}:2`], { runFacts: facts(table) })).reader.filter((x) => x.kind === 'reader-terminal-missing'), []);
    } finally {
      t.cleanup();
    }
  });

  it('after a restart armed at two runs\' R:0, the one with no line yet is the latest armed, and a re-arm from the other\'s line keeps the run still owed its end once it has a line', async () => {
    const t = tmp();
    try {
      put(t.file, line(R1, 1), line(R1, 2));
      const table = { [R1]: took({ id: R1, f: { live: true } }), [R2]: took({ id: R2, f: { live: true } }) };
      const r = await read(t.file, [`${R1}:0`, `${R2}:0`], { runFacts: facts(table) });
      deepStrictEqual(r.reader.find((x) => x.kind === 'reader-armed').run_id, R2);
      // R2's first line lands, R1 ends; the session re-arms from R1's last
      // line it received, then R2 dies with its end never written.
      put(t.file, line(R2, 1), line(R1, 3, 'run-ended'));
      table[R1] = took({ id: R1 });
      table[R2] = took({ id: R2 });
      const again = await read(t.file, [`${R1}:2`], { runFacts: facts(table) });
      deepStrictEqual(ids(again.events), [`${R2}:1`, `${R1}:3`]);
      deepStrictEqual(again.reader.filter((x) => x.kind === 'reader-terminal-missing').map((x) => x.run_id), [R2]);
      // And from R1's run-ended, past R2's only line.
      const past = await read(t.file, [`${R1}:3`], { runFacts: facts(table) });
      deepStrictEqual(past.reader.filter((x) => x.kind === 'reader-terminal-missing').map((x) => x.run_id), [R2]);
    } finally {
      t.cleanup();
    }
  });

  it('a run-ended written after the reader read the file is not reported missing (the driver\'s last line, then its record gone)', async () => {
    const t = tmp();
    try {
      put(t.file, line(R1, 1));
      // The driver appends its run-ended and removes its record as the reader
      // asks after the run: it reads as ended, not live.
      let written = false;
      const runFacts = async (runId) => {
        if (runId === R1 && !written) {
          written = true;
          put(t.file, line(R1, 2, 'run-ended'));
        }
        return took({ id: runId });
      };
      const r = await read(t.file, [`${R1}:0`], { runFacts });
      ok(written);
      deepStrictEqual(r.reader.filter((x) => x.kind === 'reader-terminal-missing'), []);
    } finally {
      t.cleanup();
    }
  });

  it('a complete run-ended with no newline, its driver gone and no cleanup under way, is reported missing until its newline comes, then delivered', async () => {
    const t = tmp();
    try {
      writeFileSync(t.file, `${line(R1, 1)}\n${line(R1, 2, 'run-ended')}`);
      const table = { [R1]: took({ id: R1 }) };
      const f = follow(t.file, [`${R1}:0`], { runFacts: facts(table), reconcileMs: 40 });
      await f.until((g) => g.some((x) => x.kind === 'reader-terminal-missing' && x.run_id === R1));
      deepStrictEqual(f.got.filter((x) => x.kind === 'run-ended'), [], 'the partial line is held');
      appendFileSync(t.file, '\n');
      await f.until((g) => g.some((x) => x.kind === 'run-ended' && x.run_id === R1));
      await pause(150);
      strictEqual(f.got.filter((x) => x.kind === 'reader-terminal-missing').length, 1, 'reported once');
      await f.stop();
    } finally {
      t.cleanup();
    }
  });

  it('a complete run-ended a cleanup ended with its newline is delivered, and its run not reported', async () => {
    const t = tmp();
    try {
      writeFileSync(t.file, `${line(R1, 1)}\n${line(R1, 2, 'run-ended')}`);
      // The cleanup under way while the line has no newline.
      const table = { [R1]: took({ id: R1, f: { cleaning: true } }) };
      const f = follow(t.file, [`${R1}:0`], { runFacts: facts(table), reconcileMs: 40 });
      await f.until((g) => g.filter((x) => x.schema === E.EVENT_SCHEMA).length === 1);
      // A cleanup finds the run-ended on file: it writes none, but ends the line.
      E.createEventWriter({ file: t.file, runId: R1, macroId: MACRO }).emit('run-ended', { status: 'halted', reason: 'interrupted', exit: 2, pointer: P, cleanup: true });
      table[R1] = took({ id: R1 });
      await f.until((g) => g.some((x) => x.kind === 'run-ended'));
      await pause(150);
      deepStrictEqual(f.got.filter((x) => x.kind === 'reader-terminal-missing'), []);
      await f.stop();
    } finally {
      t.cleanup();
    }
  });
});

describe('a line the writer could not have written (Decision 4, item 2)', () => {
  // A writer's line of `run`, changed: what anyone who can append to the file
  // could put there.
  const forged = (run, seq, kind, change) => {
    const v = JSON.parse(line(run, seq, kind));
    change(v);
    return JSON.stringify(v);
  };
  const TEXT = 'a worker wrote this sentence';
  const facts = (table) => async (runId) => table[runId] ?? null;
  const took = (run = {}) => ({ runJsonPath: '/r/run.json', run: { status: 'halted', events: { path: '/f', failed_writes: 0 }, ...run }, live: false, cleaning: false });

  it('a field outside its kind\'s allow-list, an unknown kind, another schema, a value outside its set, a `__proto__` key, a forged macro id: each skipped by its offset, its content never printed', async () => {
    const t = tmp();
    try {
      const bad = [
        forged(R1, 2, 'lane-held', (v) => { v.detail = TEXT; }),
        forged(R1, 3, 'lane-held', (v) => { v.kind = 'note'; v.text = TEXT; }),
        forged(R1, 4, 'lane-held', (v) => { v.schema = 'agentic-autopilot-event/2'; }),
        forged(R1, 5, 'lane-held', (v) => { v.hold_id = TEXT; }),
        forged(R1, 6, 'lane-held', (v) => { v.at = TEXT; }),
        forged(R1, 7, 'lane-held', (v) => { v.terminal = true; }),
        line(R1, 8, 'lane-held').replace('{', `{"__proto__":{"text":"${TEXT}"},`),
        forged(R1, 9, 'lane-held', (v) => { v.macro_id = TEXT; }),
      ];
      put(t.file, line(R1, 1), ...bad, line(R1, 10));
      const r = await read(t.file, [`${R1}:0`]);
      strictEqual(r.code, 0);
      deepStrictEqual(ids(r.events), [`${R1}:1`, `${R1}:10`]);
      const skipped = r.reader.filter((x) => x.kind === 'reader-skipped');
      strictEqual(skipped.length, bad.length);
      deepStrictEqual(skipped.map((x) => Object.keys(x)), skipped.map(() => ['schema', 'kind', 'at', 'cursor', 'offset']));
      ok(!JSON.stringify(r.lines).includes(TEXT), 'no line printed carries the forged text');
      // Each line printed is the writer's line as it is on file.
      deepStrictEqual(r.events.map((e) => JSON.stringify(e)), [line(R1, 1), line(R1, 10)]);
    } finally {
      t.cleanup();
    }
  });

  it('a forged run-ended is no end: its run is still watched, and reported missing its terminal event once its driver is gone', async () => {
    const t = tmp();
    try {
      put(t.file, line(R1, 1), forged(R1, 2, 'run-ended', (v) => { v.status = TEXT; }));
      const r = await read(t.file, [`${R1}:0`], { runFacts: facts({ [R1]: took() }) });
      deepStrictEqual(ids(r.events), [`${R1}:1`]);
      deepStrictEqual(r.reader.filter((x) => x.kind === 'reader-terminal-missing').map((x) => x.run_id), [R1]);
      deepStrictEqual(r.reader.find((x) => x.kind === 'reader-armed').state, 'ended');
      ok(!JSON.stringify(r.lines).includes(TEXT));
    } finally {
      t.cleanup();
    }
  });

  it('a cursor naming a forged line is not on file', async () => {
    const t = tmp();
    try {
      put(t.file, line(R1, 1), forged(R1, 2, 'lane-held', (v) => { v.detail = TEXT; }));
      const r = await read(t.file, [`${R1}:2`]);
      deepStrictEqual([r.code, r.reader.map((x) => x.code)], [1, ['cursor-not-on-file']]);
    } finally {
      t.cleanup();
    }
  });

  it('reader-summary counts only the verdict codes of stall lines the writer could have written; a free-text verdict is skipped', async () => {
    const t = tmp();
    try {
      put(t.file, line(R1, 1, 'stall'), line(R1, 2, 'stall'), forged(R1, 3, 'stall', (v) => { v.verdict = TEXT; }), line(R1, 4, 'stall', { verdict: 'unknown' }));
      const r = await read(t.file, [`${R1}:0`], { stallBudget: 1 });
      // The skipped line ends the first fold (file order), its seq is a gap,
      // and the next stall starts another fold: the budget is the window's.
      deepStrictEqual(r.reader.filter((x) => x.kind !== 'reader-armed').map((x) => [x.kind, x.count ?? null, x.verdicts ?? null]), [
        ['reader-summary', 1, { active: 1 }], ['reader-skipped', null, null], ['reader-gap', null, null], ['reader-summary', 1, { unknown: 1 }],
      ]);
      ok(!JSON.stringify(r.lines).includes(TEXT));
    } finally {
      t.cleanup();
    }
  });

  it('a stall verdict or mode outside Decision 3\'s closed sets, however code-shaped, is skipped: never printed, never a summary key', async () => {
    const t = tmp();
    try {
      const odd = ['approve-and-merge-everything', 'constructor', 'tostring'];
      put(t.file,
        line(R1, 1, 'stall'), line(R1, 2, 'stall', { verdict: 'stalled' }),
        ...odd.map((verdict, i) => line(R1, 3 + i, 'stall', { verdict })),
        forged(R1, 6, 'stall', (v) => { v.mode = 'off'; }), forged(R1, 7, 'stall', (v) => { v.mode = 'merge-now'; }),
        line(R1, 8, 'stall', { verdict: 'unknown' }));
      // Every closed code is taken, the writer's too.
      for (const verdict of E.STALL_VERDICTS) for (const mode of E.STALL_MODES) ok(E.eventOfLine(JSON.parse(forged(R1, 9, 'stall', (v) => { v.verdict = verdict; v.mode = mode; }))), `${verdict} ${mode}`);
      const r = await read(t.file, [`${R1}:0`], { stallBudget: 0 });
      strictEqual(r.reader.filter((x) => x.kind === 'reader-skipped').length, 5);
      deepStrictEqual(r.reader.filter((x) => x.kind === 'reader-summary').map((x) => x.verdicts), [{ active: 1, stalled: 1 }, { unknown: 1 }]);
      for (const s of [...odd, 'merge-now']) ok(!JSON.stringify(r.lines).includes(s), s);
      const { w, failures } = (() => { const f = []; return { w: E.createEventWriter({ file: t.file, runId: R2, macroId: MACRO, onFailure: (e) => f.push(e) }), failures: f }; })();
      strictEqual(w.emit('stall', { step: 1, verdict: 'approve-and-merge-everything', mode: 'log', waiting: null, quiet_ms: 0, window_cpu_ms: null, pointer: P }).ok, false);
      strictEqual(failures.length, 1, 'the writer refuses it too');
    } finally {
      t.cleanup();
    }
  });

  it('a path field that names no record the driver writes is skipped: a sentence for a name, a bidi override, a `..` step, a record outside the set, a run directory that is text', async () => {
    const t = tmp();
    try {
      const tree = '/repo/.agentic-plugins/runs/autopilot';
      const bad = [
        forged(R1, 2, 'lane-held', (v) => { v.pointer = `/${TEXT}`; }),
        forged(R1, 3, 'lane-held', (v) => { v.pointer = `${tree}/${TEXT}/run.json`; }),
        forged(R1, 4, 'lane-held', (v) => { v.pointer = `${tree}/${R1}/${TEXT}`; }),
        forged(R1, 5, 'lane-held', (v) => { v.pointer = `/repo‮txt.json/.agentic-plugins/runs/autopilot/${R1}/run.json`; }),
        forged(R1, 6, 'lane-held', (v) => { v.pointer = `/repo/../${TEXT.replaceAll(' ', '-')}/.agentic-plugins/runs/autopilot/${R1}/run.json`; }),
        forged(R1, 7, 'lane-held', (v) => { v.pointer = `${tree}/landing/${TEXT}.jsonl`; }),
        forged(R1, 8, 'lane-held', (v) => { v.pointer = `${tree}/holds/${MACRO}/parks/${TEXT}.json`; }),
        forged(R1, 9, 'run-started', (v) => { Object.assign(v, { lanes: 1, detector: 'off', run_dir: `${tree}/${TEXT}`, pointer: P }); delete v.hold_id; }),
        forged(R1, 10, 'run-started', (v) => { Object.assign(v, { lanes: 1, detector: 'off', run_dir: `${tree}/${R1}`, pointer: `${tree}/${R1}` }); delete v.hold_id; }),
      ];
      // Every record the driver names is taken.
      const good = [`${tree}/${R1}/run.json`, ...E.RUN_RECORDS.map((n) => `${tree}/${R2}/${n}`), `${tree}/landing/${MACRO}.jsonl`, `${tree}/holds/${MACRO}/parks/A.json`];
      for (const p of good) ok(E.eventOfLine(JSON.parse(forged(R1, 11, 'lane-held', (v) => { v.pointer = p; }))), p);
      ok(E.eventOfLine(JSON.parse(forged(R1, 11, 'run-started', (v) => { Object.assign(v, { lanes: 1, detector: 'off', run_dir: `${tree}/${R1}`, pointer: P }); delete v.hold_id; }))));
      put(t.file, line(R1, 1), ...bad, line(R1, 12));
      const r = await read(t.file, [`${R1}:0`]);
      deepStrictEqual(ids(r.events), [`${R1}:1`, `${R1}:12`]);
      strictEqual(r.reader.filter((x) => x.kind === 'reader-skipped').length, bad.length);
      ok(!JSON.stringify(r.lines).includes('worker'), 'no forged word printed');
      ok(!JSON.stringify(r.lines).includes('‮'), 'no bidi override printed');
    } finally {
      t.cleanup();
    }
  });

  it('through the CLI, a path under a directory that is no checkout of the repository is printed null, one under a checkout added after the arm as it is, and a checkout removed since leaves its lines events, their paths null', async () => {
    const t = tmp();
    const co = join(t.dir, 'co');
    const co2 = join(t.dir, 'co2');
    try {
      mkdirSync(co);
      for (const a of [['init', '-q'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x']]) strictEqual(spawnSync('git', ['-C', co, ...a]).status, 0);
      const file = join(co, '.agentic-plugins/runs/autopilot/events.jsonl');
      const at = (root) => join(root, '.agentic-plugins/runs/autopilot', R1, 'lanes.jsonl');
      const held = (seq, pointer) => forged(R1, seq, 'lane-held', (v) => { v.macro_id = null; v.pointer = pointer; });
      mkdirSync(join(co, '.agentic-plugins/runs/autopilot'), { recursive: true });
      put(file, held(1, at(co)), held(2, at(`/${TEXT}`)), held(3, at(join(t.dir, 'not-a-checkout'))));
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('NODE_TEST')));
      const p = spawn(process.execPath, [resolve(AP, 'cli.mjs'), 'events', '--checkout', co, '--after', `${R1}:0`, '--follow'], { cwd: co, env: { ...env, AGENTIC_HOST: 'claude' } });
      const got = [];
      let buf = '';
      p.stdout.on('data', (d) => {
        buf += d;
        for (let i = buf.indexOf('\n'); i !== -1; i = buf.indexOf('\n')) { got.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
      });
      const until = async (pred) => { for (let i = 0; i < 300 && !pred(got); i += 1) await pause(20); ok(pred(got), JSON.stringify(got)); };
      const events = () => got.filter((x) => x.schema === E.EVENT_SCHEMA);
      try {
        // Each line is the event it is; only a path under a checkout is printed.
        await until((g) => g.filter((x) => x.schema === E.EVENT_SCHEMA).length === 3);
        deepStrictEqual(events().map((e) => [e.seq, e.pointer]), [[1, at(co)], [2, null], [3, null]]);
        deepStrictEqual(got.filter((x) => x.kind === 'reader-skipped'), []);
        // A relaunch from a worktree added since the arm.
        strictEqual(spawnSync('git', ['-C', co, 'worktree', 'add', '-q', '--detach', co2]).status, 0);
        put(file, held(4, at(co2)));
        await until((g) => g.some((x) => x.seq === 4));
        strictEqual(events().find((e) => e.seq === 4).pointer, at(co2));
        ok(!JSON.stringify(got).includes('worker'), 'no forged word printed');
      } finally {
        p.kill();
      }
      // The worktree removed: a replay still finds its line, its cursor
      // included, and prints its path null.
      strictEqual(spawnSync('git', ['-C', co, 'worktree', 'remove', '--force', co2]).status, 0);
      const replay = (cursor) => spawnSync(process.execPath, [resolve(AP, 'cli.mjs'), 'events', '--checkout', co, '--after', cursor], { cwd: co, env: { ...env, AGENTIC_HOST: 'claude' }, encoding: 'utf8' });
      const r3 = replay(`${R1}:3`);
      strictEqual(r3.status, 0, r3.stdout);
      deepStrictEqual(r3.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.schema === E.EVENT_SCHEMA).map((e) => [e.seq, e.pointer]), [[4, null]]);
      strictEqual(replay(`${R1}:4`).status, 0, 'a cursor on that line is on file');
    } finally {
      t.cleanup();
    }
  });

  it('reader-terminal-missing repeats a run.json status only from the driver\'s set', async () => {
    const t = tmp();
    try {
      put(t.file, line(R1, 1));
      const r = await read(t.file, [`${R1}:0`], { runFacts: facts({ [R1]: took({ status: TEXT }) }) });
      deepStrictEqual(r.reader.filter((x) => x.kind === 'reader-terminal-missing').map((x) => [x.run_id, x.status]), [[R1, null]]);
      ok(!JSON.stringify(r.lines).includes(TEXT));
    } finally {
      t.cleanup();
    }
  });
});

describe('the reader\'s own output (Decision 4, item 6)', () => {
  it('`events --follow` whose stdout is a closed pipe stops: it does not poll on for nobody', { skip: process.platform === 'win32' ? 'no EPIPE on a closed pipe' : false }, async () => {
    const t = tmp();
    try {
      // A checkout of its own: the reader waits for a file not created yet.
      strictEqual(spawnSync('git', ['init', '-q', t.dir]).status, 0);
      const CLI = resolve(AP, 'cli.mjs');
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('NODE_TEST')));
      // The CLI as its own entry: one reader.
      const p = spawn(process.execPath, [CLI, 'events', '--checkout', t.dir, '--after', `${R1}:0`, '--follow'], { cwd: t.dir, env: { ...env, AGENTIC_HOST: 'claude' }, stdio: ['ignore', 'pipe', 'ignore'] });
      p.stdout.destroy();
      let killed = false;
      const killer = setTimeout(() => { killed = true; p.kill('SIGKILL'); }, 20_000);
      const [code, signal] = await new Promise((r) => { p.on('exit', (c, s) => r([c, s])); });
      clearTimeout(killer);
      ok(!killed, 'the reader stopped once its output was gone');
      deepStrictEqual([signal, code], [null, 0]);
    } finally {
      t.cleanup();
    }
  });

  it('the CLI\'s probe of its output: gone once a line\'s write failed, whatever the stream; a stream it does not own is never written to', async () => {
    const C = await import(resolve(AP, 'cli.mjs'));
    let writes = 0;
    const stream = { write: () => { writes += 1; } };
    deepStrictEqual([C.outputProbe({ failed: false, stream })(), C.outputProbe({ failed: true, stream })()], [true, false]);
    strictEqual(writes, 0);
  });

  it('an idle `events --follow` whose pipe reader closes after a line (`| head -1`) stops within a few polls, with no line left to write', { skip: NULL_WRITE_FAILS ? false : 'this system takes a write of no bytes to a closed pipe as done, so a follow notices a gone reader only at its next line (ADR-0068 E5)' }, async () => {
    const t = tmp();
    try {
      strictEqual(spawnSync('git', ['init', '-q', t.dir]).status, 0);
      const CLI = resolve(AP, 'cli.mjs');
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('NODE_TEST')));
      // A shell pipe (a FIFO, which tells its writer nothing until it writes,
      // unlike the socket a Node parent hands its child): `head -1` takes the
      // armed line and exits; nothing is appended after it. The pipeline ends
      // only once the reader does; its status is the reader's. The CLI is its
      // own entry: one reader, which writes nothing after its armed line.
      const p = spawn('bash', ['-c', '"$0" "$1" events --checkout "$2" --after "$3" --follow | head -1; exit "${PIPESTATUS[0]}"',
        process.execPath, CLI, t.dir, `${R1}:0`], { cwd: t.dir, env: { ...env, AGENTIC_HOST: 'claude' }, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
      let first = '';
      p.stdout.on('data', (d) => { first += d; });
      const t0 = Date.now();
      let killed = false;
      const killer = setTimeout(() => { killed = true; try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } }, 20_000);
      const [code, signal] = await new Promise((r) => { p.on('exit', (c, s) => r([c, s])); });
      clearTimeout(killer);
      strictEqual(JSON.parse(first.trim()).kind, 'reader-armed', 'head took the armed line');
      ok(!killed, 'the idle reader noticed its output was gone');
      deepStrictEqual([signal, code], [null, 0]);
      ok(Date.now() - t0 < 5000, `it stopped within a few polls (${Date.now() - t0} ms)`);
    } finally {
      t.cleanup();
    }
  });
});
