// tests/orchestrator/test-autopilot-procs.mjs
//
// ADR-0068 Decision 3, item 6 — the stall detector's process table
// (plugins/orchestrator/adapters/claude/autopilot/procs.mjs): macOS `ps` in
// the C locale (a table read under another locale is a failed read, never a
// table of idle processes), Linux `/proc/<pid>/stat` trees (a command name
// holding `) `, a process that exits between the listing and its read, one
// that cannot be read, a coarse clock tick), and the read's deadline.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const P = await import(resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/procs.mjs'));

// Measured on macOS, 2026-10-29: the same process under three locales.
const C_TABLE = [
  '    1     0     1 08-23:53:53 Tue Oct 20 11:29:57 2026     298:41.42',
  '  139     1   139 08-13:52:18 Tue Oct 20 21:30:32 2026       0:03.81',
  '71547 66886 71547       00:07 Thu Oct  1 11:23:50 2026       0:00.02',
].join('\n');
const KO_TABLE = '    1     0     1 08-23:53:53 2026년 10월 20일 화요일 11시 29분 57초 298:41.42\n';
const DE_TABLE = '    1     0     1 08-23:53:53 Di. 20 Okt. 11:29:57 2026    298:41.42\n';

describe('macOS: ps with its locale pinned to C', () => {
  it('parses a C-locale table: parent, group, age, CPU (minutes past 59) and the start time in the identity', () => {
    const t = P.parsePsTable(C_TABLE);
    strictEqual(t.ok, true);
    deepStrictEqual(t.procs[0], { pid: 1, ppid: 0, pgid: 1, key: '1@Tue Oct 20 11:29:57 2026', ageMs: (8 * 86400 + 23 * 3600 + 53 * 60 + 53) * 1000, cpuMs: (298 * 60 + 41) * 1000 + 420 });
    deepStrictEqual(t.procs[2], { pid: 71547, ppid: 66886, pgid: 71547, key: '71547@Thu Oct 1 11:23:50 2026', ageMs: 7000, cpuMs: 20 });
    strictEqual(t.resolutionMs, 10);
  });

  it('a table printed under another locale (ko_KR, de_DE) does not parse: a failed read, never zero CPU', () => {
    deepStrictEqual(P.parsePsTable(KO_TABLE), { ok: false, why: 'parse' });
    deepStrictEqual(P.parsePsTable(DE_TABLE), { ok: false, why: 'parse' });
  });

  it('a line that does not parse fails the whole table; an empty one is no table', () => {
    deepStrictEqual(P.parsePsTable(`${C_TABLE}\n  12 garbage`), { ok: false, why: 'parse' });
    deepStrictEqual(P.parsePsTable(''), { ok: false, why: 'parse' });
    deepStrictEqual(P.parsePsTable('  5 1 5 00:07 Thu Oct  1 11:23:50 2026 0:61.00'), { ok: false, why: 'parse' });
  });

  it('a CPU time in whole seconds is coarser than 0.1 s', () => {
    deepStrictEqual(P.parsePsTable('  5 1 5 00:07 Thu Oct  1 11:23:50 2026 0:03'), { ok: false, why: 'coarse' });
  });

  it('runs ps with LC_ALL and LANG pinned to C, whatever the caller\'s locale', async () => {
    const calls = [];
    const r = await P.readProcessTable({
      platform: 'darwin', env: { LC_ALL: 'ko_KR.UTF-8', LANG: 'de_DE.UTF-8', HOME: '/h' },
      execFile: async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { stdout: C_TABLE }; },
    });
    strictEqual(r.ok, true);
    strictEqual(calls[0].cmd, 'ps');
    deepStrictEqual(calls[0].args, ['-A', '-o', 'pid=,ppid=,pgid=,etime=,lstart=,time=']);
    deepStrictEqual([calls[0].opts.env.LC_ALL, calls[0].opts.env.LANG, calls[0].opts.env.HOME], ['C', 'C', '/h']);
  });

  it('a ps that fails is a failed read', async () => {
    const r = await P.readProcessTable({ platform: 'darwin', execFile: async () => { throw new Error('ENOENT'); } });
    deepStrictEqual(r, { ok: false, why: 'failed' });
  });

  it('reads this machine\'s table when it is macOS', { skip: process.platform !== 'darwin' }, async () => {
    const r = await P.readProcessTable();
    strictEqual(r.ok, true);
    ok(r.procs.some((p) => p.pid === process.pid), 'this process is listed');
  });
});

describe('Linux: /proc/<pid>/stat', () => {
  const stat = (pid, comm, { ppid = 1, pgrp = pid, utime = 0, stime = 0, start = 1000 } = {}) => {
    // cutime and cstime (fields 16, 17) are an exited child's CPU, never counted.
    const f = ['S', ppid, pgrp, 0, 0, 0, 0, 0, 0, 0, 0, utime, stime, 777, 888, 20, 0, 1, 0, start, 0, 0];
    return `${pid} (${comm}) ${f.join(' ')}\n`;
  };

  function tree(entries, { uptime = '5000.50 100.00' } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'autopilot-proc-'));
    writeFileSync(join(root, 'uptime'), `${uptime}\n`);
    for (const [pid, text] of Object.entries(entries)) {
      mkdirSync(join(root, pid));
      if (text !== null) writeFileSync(join(root, pid, 'stat'), text);
    }
    mkdirSync(join(root, 'self'));
    return root;
  }

  it('parses each process after the command name\'s last `)`, a name holding `) ` included', async () => {
    const root = tree({ 10: stat(10, 'a) b (c', { ppid: 7, pgrp: 3, utime: 150, stime: 50, start: 400000 }) });
    try {
      P.resetClockTick();
      const r = await P.readProcessTable({ platform: 'linux', procRoot: root, getconf: async () => '100\n' });
      strictEqual(r.ok, true);
      deepStrictEqual(r.procs, [{ pid: 10, ppid: 7, pgid: 3, key: '10@400000', ageMs: 5000500 - 4000000, cpuMs: 2000 }]);
      strictEqual(r.resolutionMs, 10);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a process gone between the listing and its read is an exit; one that cannot be read, or reads malformed, is unreadable', async () => {
    const root = tree({ 10: stat(10, 'ok'), 11: null, 12: 'garbage', 13: stat(13, 'x') });
    const realRead = (await import('node:fs/promises')).readFile;
    try {
      P.resetClockTick();
      const r = await P.readProcessTable({
        platform: 'linux', procRoot: root, getconf: async () => '100',
        readFile: async (p, enc) => {
          if (p.endsWith('/13/stat')) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; }
          return realRead(p, enc);
        },
      });
      strictEqual(r.ok, true);
      deepStrictEqual(r.procs.map((p) => p.pid), [10]);
      deepStrictEqual(r.exited, [11]);
      deepStrictEqual(r.unreadable.sort(), [12, 13]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a clock tick coarser than 0.1 s is coarse; getconf is asked once', async () => {
    const root = tree({ 10: stat(10, 'x') });
    try {
      P.resetClockTick();
      deepStrictEqual(await P.readProcessTable({ platform: 'linux', procRoot: root, getconf: async () => '5' }), { ok: false, why: 'coarse' });
      P.resetClockTick();
      let asked = 0;
      const getconf = async () => { asked += 1; return '100'; };
      await P.readProcessTable({ platform: 'linux', procRoot: root, getconf });
      await P.readProcessTable({ platform: 'linux', procRoot: root, getconf });
      strictEqual(asked, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const settled = async () => { for (let i = 0; i < 200 && P.readInFlight(); i += 1) await new Promise((r) => { setTimeout(r, 10); }); };

  it('a read past its deadline is a timeout, getconf and ps included', { timeout: 10_000 }, async () => {
    P.resetClockTick();
    const slow = (ms, v) => () => new Promise((r) => { setTimeout(() => r(v), ms); });
    const r = await P.readProcessTable({ platform: 'linux', procRoot: '/nonexistent', getconf: slow(300, '100'), deadlineMs: 50 });
    deepStrictEqual(r, { ok: false, why: 'timeout' });
    await settled();
    const r2 = await P.readProcessTable({ platform: 'darwin', execFile: slow(300, { stdout: '' }), deadlineMs: 50 });
    deepStrictEqual(r2, { ok: false, why: 'timeout' });
    await settled();
  });

  it('a read still under way after its deadline makes the next one slow, starting nothing; the walk stops at its next process', { timeout: 10_000 }, async () => {
    const root = tree({ 10: stat(10, 'a'), 11: stat(11, 'b'), 12: stat(12, 'c') });
    const realRead = (await import('node:fs/promises')).readFile;
    let statReads = 0;
    try {
      P.resetClockTick();
      const readFile = async (p, enc) => {
        if (p.endsWith('/stat')) {
          statReads += 1;
          await new Promise((r) => { setTimeout(r, 150); });
        }
        return realRead(p, enc);
      };
      const first = await P.readProcessTable({ platform: 'linux', procRoot: root, getconf: async () => '100', readFile, deadlineMs: 50 });
      deepStrictEqual(first, { ok: false, why: 'timeout' });
      strictEqual(P.readInFlight(), true);
      let started = 0;
      const second = await P.readProcessTable({ platform: 'linux', procRoot: root, getconf: async () => { started += 1; return '100'; }, readFile, deadlineMs: 50 });
      deepStrictEqual(second, { ok: false, why: 'slow' });
      strictEqual(started, 0);
      await settled();
      strictEqual(P.readInFlight(), false);
      strictEqual(statReads, 1, 'the walk stopped after the process it was reading at the deadline');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('parseProcStat refuses a line with too few fields or a negative count', () => {
    strictEqual(P.parseProcStat('10 (x) S 1 2'), null);
    strictEqual(P.parseProcStat('10 x S 1 2 0 0 0 0 0 0 0 0 1 1 0 0 0 0 0 0 5 0 0'), null);
  });
});
