// tests/orchestrator/test-autopilot-events.mjs
//
// ADR-0068 Decision 4, items 2 to 5 — the event file's writer
// (plugins/orchestrator/adapters/claude/autopilot/events.mjs): machine data
// only, identity by (run, seq), whole lines under the file's lock, a torn
// line recovered, `run-ended` at most once, and a failed write returned and
// counted, never thrown.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const E = await import(resolve(AP, 'events.mjs'));
const { OWNER_GATES } = await import(resolve(AP, 'codes.mjs'));

const RUN = 'autopilot-20261019T090000Z-aaaaaa';
const RUN2 = 'autopilot-20261019T091500Z-bbbbbb';
const MACRO = 'macro-plan-20261019T084450Z-b66aaa';
const P = '/repo/.agentic-plugins/runs/autopilot/autopilot-20261019T090000Z-aaaaaa/run.json';

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ap-events-'));
  return { dir, file: join(dir, 'events', `${MACRO}.jsonl`), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};
const lines = (file) => readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');
const parsed = (file) => lines(file).map((l) => { try { return JSON.parse(l); } catch { return null; } });
const writer = (file, o = {}) => {
  const failures = [];
  const w = E.createEventWriter({ file, runId: RUN, macroId: MACRO, onFailure: (e) => failures.push(e), ...o });
  return { w, failures };
};
// The writer is synchronous: a lock wait with no bound never returns, so each
// case that waits on a lock runs in a child the test can time out.
const boundedChild = (file, body) => spawnSync(process.execPath, ['--input-type=module', '-e', `
  const E = await import(${JSON.stringify(resolve(AP, 'events.mjs'))});
  const file = process.argv[1];
  const failures = [];
  ${body}
`, file], { encoding: 'utf8', timeout: 15_000 });
const held = { hold_id: '0123456789abcdef', pointer: P };
const ended = (o = {}) => ({ status: 'halted', reason: 'interrupted', exit: 2, pointer: P, cleanup: false, ...o });

describe('machine data only (Decision 4, item 2)', () => {
  it('a line carries the fixed head, its kind\'s fields, and terminal only on run-ended', () => {
    const t = tmp();
    try {
      const { w } = writer(t.file, { now: () => Date.parse('2026-10-19T09:00:01.000Z') });
      deepStrictEqual(w.emit('lane-held', held, { subtaskId: 'A' }), { ok: true, seq: 1 });
      deepStrictEqual(w.emit('run-ended', ended()), { ok: true, seq: 2 });
      deepStrictEqual(parsed(t.file), [
        { schema: E.EVENT_SCHEMA, run_id: RUN, seq: 1, at: '2026-10-19T09:00:01.000Z', kind: 'lane-held', macro_id: MACRO, subtask_id: 'A', ...held },
        { schema: E.EVENT_SCHEMA, run_id: RUN, seq: 2, at: '2026-10-19T09:00:01.000Z', kind: 'run-ended', macro_id: MACRO, subtask_id: null, ...ended(), terminal: true },
      ]);
    } finally {
      t.cleanup();
    }
  });

  it('refuses text, a field its kind does not list, a missing field and a value outside its set, and counts each as a failed write', () => {
    const t = tmp();
    try {
      const { w, failures } = writer(t.file);
      const refused = [
        ['halt', { reason: 'owner-choice', step: null, pointer: P, step_record: null, detail: 'the worker said: rm -rf /' }],
        ['halt', { reason: 'the worker said so', step: null, pointer: P, step_record: null }],
        ['halt', { reason: 'awaiting-owner:not-a-gate', step: null, pointer: P, step_record: null }],
        ['halt', { reason: 'owner-choice', step: null, step_record: null }],
        ['lane-held', { hold_id: 'peer text', pointer: P }],
        ['lane-held', { hold_id: '0123456789abcdef', pointer: 'relative/path' }],
        ['lane-held', { hold_id: '0123456789abcdef', pointer: '/a\nsecond line' }],
        // A path names a record the driver writes, every name from its set.
        ['lane-held', { hold_id: '0123456789abcdef', pointer: '/a worker wrote this sentence' }],
        ['lane-held', { hold_id: '0123456789abcdef', pointer: P.replace('run.json', 'notes.txt') }],
        ['lane-held', { hold_id: '0123456789abcdef', pointer: `/repo‮/${P.slice('/repo/'.length)}` }],
        ['run-started', { lanes: 1, detector: 'off', run_dir: '/repo/.agentic-plugins/runs/autopilot/a sentence', pointer: P }],
        ['commit-finished', { step: 1, commit: 'a'.repeat(39), readiness: 'ready', pointer: P }],
        ['commit-finished', { step: 1, commit: 'a'.repeat(40), readiness: 'maybe', pointer: P }],
        ['step-failed', { step: 1, reason: 'worker-failed', abort: 'killed by a peer', pointer: P }],
        ['not-a-kind', {}],
        // A name every object inherits is no kind.
        ['constructor', { name: 'a worker wrote this' }],
        ['toString', {}],
      ];
      for (const [kind, fields] of refused) strictEqual(w.emit(kind, fields).ok, false, `${kind} ${JSON.stringify(fields)}`);
      strictEqual(w.emit('lane-held', held, { subtaskId: 'a subtask; with text' }).ok, false);
      // A run-ended refused is still the run's last: the writer closes.
      strictEqual(w.emit('run-ended', { status: 'halted', reason: null, exit: 2, pointer: P, cleanup: 'no' }).ok, false);
      strictEqual(failures.length, refused.length + 2);
      strictEqual(w.failures, refused.length + 2);
      strictEqual(w.closed, true);
      ok(!existsSync(t.file), 'nothing reached the file');
    } finally {
      t.cleanup();
    }
  });

  it('takes every owner gate as awaiting-owner:<gate>, every halt code, and a commit of either hash length', () => {
    const t = tmp();
    try {
      const { w, failures } = writer(t.file);
      for (const gate of OWNER_GATES) strictEqual(w.emit('halt', { reason: `awaiting-owner:${gate}`, step: 3, pointer: P, step_record: P }).ok, true, gate);
      for (const code of E.STEP_OUTCOMES) strictEqual(w.emit('step-failed', { step: 1, reason: code, abort: null, pointer: P }).ok, true, code);
      for (const commit of ['a'.repeat(40), 'b'.repeat(64)]) strictEqual(w.emit('commit-finished', { step: 2, commit, readiness: 'needs-sync', pointer: P }).ok, true);
      deepStrictEqual(failures, []);
    } finally {
      t.cleanup();
    }
  });
});

describe('identity and recoverable lines (Decision 4, items 4 and 5)', () => {
  it('a write that failed before any byte landed, then a success: the seq it used is not used again', () => {
    const t = tmp();
    try {
      let calls = 0;
      const { w, failures } = writer(t.file, {
        writeSync: (...a) => { calls += 1; if (calls === 1) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }); return writeSync(...a); },
      });
      strictEqual(w.emit('lane-held', held).ok, false);
      strictEqual(failures.length, 1);
      deepStrictEqual(w.emit('lane-held', held), { ok: true, seq: 2 });
      deepStrictEqual(parsed(t.file).map((e) => e.seq), [2]);
    } finally {
      t.cleanup();
    }
  });

  it('a writer killed mid-line, then another writer: the torn line is ended first and holds no identity, and the next line parses', () => {
    const t = tmp();
    try {
      const { w } = writer(t.file);
      w.emit('lane-held', held);
      appendFileSync(t.file, '{"schema":"agentic-autopilot-event/1","run_id":"' + RUN + '","seq":2,"ki');
      const { w: cleanup } = writer(t.file);
      deepStrictEqual(cleanup.emit('run-ended', ended({ cleanup: true })), { ok: true, seq: 2 });
      const p = parsed(t.file);
      strictEqual(p.length, 3);
      strictEqual(p[1], null, 'the torn line stays, ended, and parses as nothing');
      deepStrictEqual(p.filter(Boolean).map((e) => [e.seq, e.kind]), [[1, 'lane-held'], [2, 'run-ended']]);
    } finally {
      t.cleanup();
    }
  });

  it('a torn last line holding complete JSON counts for the next seq, is not duplicated, and is ended', () => {
    const t = tmp();
    try {
      const { w } = writer(t.file);
      w.emit('lane-held', held);
      const torn = JSON.stringify({ schema: E.EVENT_SCHEMA, run_id: RUN, seq: 7, at: '2026-10-19T09:00:02.000Z', kind: 'lane-held', macro_id: MACRO, subtask_id: null, ...held });
      appendFileSync(t.file, torn);
      const { w: next } = writer(t.file);
      deepStrictEqual(next.emit('lane-held', held), { ok: true, seq: 8 });
      deepStrictEqual(parsed(t.file).map((e) => e.seq), [1, 7, 8]);
      strictEqual(lines(t.file)[1], torn);
    } finally {
      t.cleanup();
    }
  });

  it('lines of two writers in two processes appending at once are whole and their identities unique', async () => {
    const t = tmp();
    try {
      const child = (n) => new Promise((done) => {
        const p = spawn(process.execPath, ['--input-type=module', '-e', `
          const E = await import(${JSON.stringify(resolve(AP, 'events.mjs'))});
          const w = E.createEventWriter({ file: process.argv[1], runId: ${JSON.stringify(RUN)}, macroId: ${JSON.stringify(MACRO)}, lockWaitMs: 20000 });
          let bad = 0;
          for (let i = 0; i < ${n}; i += 1) if (!w.emit('lane-held', { hold_id: '0123456789abcdef', pointer: ${JSON.stringify(P)} }).ok) bad += 1;
          process.exit(bad);
        `, t.file], { stdio: 'inherit' });
        p.on('exit', (code) => done(code));
      });
      deepStrictEqual(await Promise.all([child(60), child(60)]), [0, 0]);
      const p = parsed(t.file);
      strictEqual(p.length, 120);
      ok(p.every(Boolean), 'every line parses');
      strictEqual(new Set(p.map((e) => `${e.run_id}:${e.seq}`)).size, 120);
    } finally {
      t.cleanup();
    }
  });
});

describe('run-ended at most once (Decision 4, item 3)', () => {
  it('across a driver\'s writer, a cleanup\'s and a cleanup retried after it wrote its own', () => {
    const t = tmp();
    try {
      const { w: driver } = writer(t.file);
      deepStrictEqual(driver.emit('run-ended', ended()), { ok: true, seq: 1 });
      const { w: cleanup, failures } = writer(t.file);
      deepStrictEqual(cleanup.emit('run-ended', ended({ cleanup: true })), { ok: true, suppressed: true, seq: 1, run_id: RUN });
      const { w: retried } = writer(t.file);
      strictEqual(retried.emit('run-ended', ended({ cleanup: true })).suppressed, true);
      deepStrictEqual(failures, []);
      deepStrictEqual(parsed(t.file).map((e) => [e.seq, e.kind, e.cleanup]), [[1, 'run-ended', false]]);
    } finally {
      t.cleanup();
    }
  });

  it('a complete run-ended its writer did not end with a newline is not written again, and is ended for the reader', () => {
    const t = tmp();
    try {
      E.lockEventFile(t.file)(); // makes the directory
      const torn = JSON.stringify({ schema: E.EVENT_SCHEMA, run_id: RUN, seq: 1, at: '2026-10-19T09:00:02.000Z', kind: 'run-ended', macro_id: MACRO, subtask_id: null, ...ended(), terminal: true });
      writeFileSync(t.file, torn);
      const { w } = writer(t.file);
      strictEqual(w.emit('run-ended', ended({ cleanup: true })).suppressed, true);
      strictEqual(readFileSync(t.file, 'utf8'), `${torn}\n`);
    } finally {
      t.cleanup();
    }
  });

  it('a lane-released is written once per release id, across writers and runs', () => {
    const t = tmp();
    try {
      const rel = { hold_id: '0123456789abcdef', release_id: 'fedcba9876543210', verdict: 'consumed', pointer: P };
      const { w } = writer(t.file);
      strictEqual(w.emit('lane-released', rel, { subtaskId: 'A' }).seq, 1);
      const w2 = E.createEventWriter({ file: t.file, runId: RUN2, macroId: MACRO });
      strictEqual(w2.emit('lane-released', rel, { subtaskId: 'A' }).suppressed, true);
      strictEqual(w2.emit('lane-released', { ...rel, release_id: '0000000000000001' }, { subtaskId: 'A' }).seq, 1);
      deepStrictEqual(parsed(t.file).map((e) => [e.run_id, e.release_id]), [[RUN, rel.release_id], [RUN2, '0000000000000001']]);
    } finally {
      t.cleanup();
    }
  });

  it('a forged run-ended or lane-released, which every reader skips, suppresses nothing: the real line is written after it, its seq above it', () => {
    const t = tmp();
    try {
      E.lockEventFile(t.file)(); // makes the directory
      const rel = { hold_id: '0123456789abcdef', release_id: 'fedcba9876543210', verdict: 'consumed', pointer: P };
      const head = { schema: E.EVENT_SCHEMA, run_id: RUN, at: '2026-10-19T09:00:02.000Z', macro_id: MACRO, subtask_id: null };
      writeFileSync(t.file, [
        JSON.stringify({ ...head, seq: 1, kind: 'lane-released', subtask_id: 'A', ...rel, detail: 'a person wrote this' }),
        JSON.stringify({ ...head, seq: 2, kind: 'run-ended', ...ended(), terminal: true, detail: 'a person wrote this' }),
      ].map((l) => `${l}\n`).join(''));
      const { w, failures } = writer(t.file);
      deepStrictEqual(w.emit('lane-released', rel, { subtaskId: 'A' }), { ok: true, seq: 3 });
      deepStrictEqual(w.emit('run-ended', ended({ cleanup: true })), { ok: true, seq: 4 });
      deepStrictEqual(failures, []);
      // Each real line is one a reader delivers.
      deepStrictEqual(parsed(t.file).slice(2).map((e) => [e.seq, e.kind, Boolean(E.eventOfLine(e))]), [[3, 'lane-released', true], [4, 'run-ended', true]]);
    } finally {
      t.cleanup();
    }
  });

  it('nothing is written after the run\'s run-ended, and nothing is counted for it', () => {
    const t = tmp();
    try {
      const { w, failures } = writer(t.file);
      w.emit('run-ended', ended());
      deepStrictEqual(w.emit('lane-held', held), { ok: false, closed: true });
      deepStrictEqual(failures, []);
      strictEqual(lines(t.file).length, 1);
    } finally {
      t.cleanup();
    }
  });
});

describe('the file\'s lock', () => {
  it('a lock whose writer died is taken over', () => {
    const t = tmp();
    try {
      const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
      E.lockEventFile(t.file)();
      writeFileSync(`${t.file}.lock`, JSON.stringify({ pid: Number(dead.stdout), at: new Date().toISOString() }));
      const { w, failures } = writer(t.file, { lockWaitMs: 200 });
      strictEqual(w.emit('lane-held', held).ok, true);
      deepStrictEqual(failures, []);
      ok(!existsSync(`${t.file}.lock`), 'the lock is released');
    } finally {
      t.cleanup();
    }
  });

  it('a lock a live writer holds past the bound is a counted failure, and the next write goes through once it is gone', () => {
    const t = tmp();
    try {
      const release = E.lockEventFile(t.file);
      // In a child (boundedChild): a wait with no bound fails, never hangs.
      const r = boundedChild(t.file, `
        const w = E.createEventWriter({ file, runId: ${JSON.stringify(RUN)}, macroId: ${JSON.stringify(MACRO)}, onFailure: (e) => failures.push(e), lockWaitMs: 50 });
        const res = w.emit('lane-held', ${JSON.stringify(held)});
        const f = failures.length;
        // The live writer's lock gone (its release, done here for it), the
        // same writer writes: no seq was chosen without the lock, so none was used.
        (await import('node:fs')).unlinkSync(file + '.lock');
        const next = w.emit('lane-held', ${JSON.stringify(held)});
        process.stdout.write(JSON.stringify({ ok: res.ok, failures: f, next }));
      `);
      strictEqual(r.error?.code, undefined, 'the write returned');
      deepStrictEqual(JSON.parse(r.stdout), { ok: false, failures: 1, next: { ok: true, seq: 1 } }, r.stderr);
      release();
    } finally {
      t.cleanup();
    }
  });

  // The removal of the dead writer's lock fails (EPERM, as an immutable lock
  // or a directory not writable makes it), injected at that removal itself,
  // so every system reaches the branch that waits to the bound.
  it('a dead writer\'s lock that cannot be removed is a counted failure at the bound, never a wait without end', () => {
    const t = tmp();
    const lock = `${t.file}.lock`;
    try {
      const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
      E.lockEventFile(t.file)();
      writeFileSync(lock, JSON.stringify({ pid: Number(dead.stdout), at: new Date().toISOString() }));
      const r = boundedChild(t.file, `
        const fs = (await import('node:fs')).default;
        const unlink = fs.unlinkSync;
        let refused = 0;
        fs.unlinkSync = (p, ...a) => {
          if (String(p) === file + '.lock') { refused += 1; throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' }); }
          return unlink(p, ...a);
        };
        const w = E.createEventWriter({ file, runId: ${JSON.stringify(RUN)}, macroId: ${JSON.stringify(MACRO)}, onFailure: (e) => failures.push(e), lockWaitMs: 200 });
        const t0 = performance.now();
        const res = w.emit('lane-held', ${JSON.stringify(held)});
        process.stdout.write(JSON.stringify({ ok: res.ok, failures: failures.length, ms: performance.now() - t0, refused }));
      `);
      strictEqual(r.error?.code, undefined, 'the write returned');
      const got = JSON.parse(r.stdout);
      deepStrictEqual([got.ok, got.failures], [false, 1], r.stderr);
      ok(got.refused > 0, 'the writer reached the removal of the dead writer\'s lock');
      ok(got.ms >= 150 && got.ms < 1500, `returned at its 200 ms bound (${got.ms} ms)`);
      ok(existsSync(lock), 'the lock it could not remove is left');
    } finally {
      t.cleanup();
    }
  });

  it('a lock is never seen empty: one taken and released in a loop by another process reads whole, or not at all', async () => {
    const t = tmp();
    let exited = Promise.resolve();
    try {
      E.lockEventFile(t.file)();
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        const E = await import(${JSON.stringify(resolve(AP, 'events.mjs'))});
        const end = Date.now() + 1500;
        while (Date.now() < end) E.lockEventFile(process.argv[1])();
      `, t.file], { stdio: 'ignore' });
      exited = new Promise((r) => { child.on('exit', r); });
      const lock = `${t.file}.lock`;
      const end = Date.now() + 1500;
      let seen = 0;
      let empty = 0;
      while (Date.now() < end) {
        let raw;
        try { raw = readFileSync(lock, 'utf8'); } catch { continue; }
        seen += 1;
        try { JSON.parse(raw); } catch { empty += 1; }
      }
      child.kill();
      await exited;
      ok(seen > 0, 'the lock was read while held');
      strictEqual(empty, 0, `${empty} of ${seen} reads found the lock not yet written`);
    } finally {
      await exited;
      t.cleanup();
    }
  });

  it('the bound is the wall clock\'s: a frozen event clock still ends the wait', () => {
    const t = tmp();
    try {
      const r = boundedChild(t.file, `
        const release = E.lockEventFile(file);
        const w = E.createEventWriter({ file, runId: ${JSON.stringify(RUN)}, macroId: ${JSON.stringify(MACRO)}, onFailure: (e) => failures.push(e), lockWaitMs: 100, now: () => Date.parse('2026-10-19T09:00:01.000Z') });
        const res = w.emit('lane-held', ${JSON.stringify(held)});
        release();
        process.stdout.write(JSON.stringify({ ok: res.ok, failures: failures.length }));
      `);
      strictEqual(r.error?.code, undefined, 'the write returned within the bound');
      deepStrictEqual(JSON.parse(r.stdout), { ok: false, failures: 1 }, r.stderr);
    } finally {
      t.cleanup();
    }
  });
});

describe('a live writer\'s lock', () => {
  it('is never taken, however old: a writer suspended while it holds the lock still holds it', () => {
    const t = tmp();
    try {
      E.lockEventFile(t.file)();
      writeFileSync(`${t.file}.lock`, JSON.stringify({ pid: process.pid, token: 'x', at: '2026-01-01T00:00:00.000Z' }));
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(`${t.file}.lock`, old, old);
      // This process holds it, alive; the writer waits in a child (boundedChild).
      const r = boundedChild(t.file, `
        const w = E.createEventWriter({ file, runId: ${JSON.stringify(RUN)}, macroId: ${JSON.stringify(MACRO)}, onFailure: (e) => failures.push(e), lockWaitMs: 50 });
        const res = w.emit('lane-held', ${JSON.stringify(held)});
        process.stdout.write(JSON.stringify({ ok: res.ok, failures: failures.length }));
      `);
      strictEqual(r.error?.code, undefined, 'the write returned');
      deepStrictEqual(JSON.parse(r.stdout), { ok: false, failures: 1 }, r.stderr);
      ok(existsSync(`${t.file}.lock`), 'the lock stays its writer\'s');
    } finally {
      t.cleanup();
    }
  });

  it('is removed by its writer\'s release only while it is still that writer\'s', () => {
    const t = tmp();
    try {
      const release = E.lockEventFile(t.file);
      // Another writer's lock in its place (taken over after this one died).
      const other = JSON.stringify({ pid: process.pid, token: 'other', at: new Date().toISOString() });
      writeFileSync(`${t.file}.lock`, other);
      release();
      strictEqual(readFileSync(`${t.file}.lock`, 'utf8'), other);
    } finally {
      t.cleanup();
    }
  });
});

describe('where the file is (Decision 4, item 1)', () => {
  it('a macro\'s beside its landing log under the main worktree; a verb chain\'s in its checkout', () => {
    strictEqual(E.eventsPath({ mainRoot: '/main', macroId: MACRO, checkout: '/lane' }), `/main/.agentic-plugins/runs/autopilot/events/${MACRO}.jsonl`);
    strictEqual(E.eventsPath({ mainRoot: '/main', macroId: null, checkout: '/lane' }), '/lane/.agentic-plugins/runs/autopilot/events.jsonl');
    strictEqual(E.watchCommand({ macroId: MACRO, checkout: '/lane', runId: RUN }), `agentic-autopilot events --macro ${MACRO} --after ${RUN}:0 --follow`);
  });

  it('a verb chain\'s watch command, run by a shell, passes its checkout as one word, a space or a quote in it too', () => {
    // A shell runs the printed line, an `agentic-autopilot` on its PATH
    // standing in for the CLI: it prints each argument it was given on a line
    // of its own.
    const t = tmp();
    const bin = t.dir;
    writeFileSync(join(bin, 'agentic-autopilot'), '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n');
    chmodSync(join(bin, 'agentic-autopilot'), 0o755);
    const argv = (checkout) => {
      const line = E.watchCommand({ macroId: null, checkout, runId: RUN });
      const r = spawnSync('sh', ['-c', line], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      strictEqual(r.status, 0, r.stderr);
      return r.stdout.split('\n').slice(0, -1);
    };
    try {
      for (const checkout of ['/lane', '/Users/me/My Lanes/impl events', "/tmp/it's here"]) {
        deepStrictEqual(argv(checkout), ['events', '--checkout', checkout, '--after', `${RUN}:0`, '--follow'], checkout);
      }
    } finally {
      t.cleanup();
    }
  });
});
