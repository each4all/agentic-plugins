// C141 (= C81) — a macOS process's fingerprint is its `ps` start time, which
// `ps` prints in the caller's locale and time zone. Each fingerprint keeps
// the fields an earlier reader compares and adds `pinned`, the start and
// command read under LC_ALL=C and TZ=UTC0, which alone a reader compares
// now: one process fingerprints the same from a Korean terminal and from a
// worker in another zone, and a record with no `pinned` (an earlier
// writer's) is one that cannot be told, never another process to signal,
// reclaim or orphan, and never proof for a signal.
//
// `ps` is injected: these run on any platform, and the fake prints what a real
// `ps` prints under the environment it is given.

import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT, personaInfo, personasFor } from './_personas.mjs';

// One process, started 2026-10-14 01:31:38 UTC, as `ps -o lstart=` prints
// its start under the environment it runs in (a missing LC_ALL falls back to
// LANG, as setlocale does).
const START_UTC = Date.UTC(2026, 9, 14, 1, 31, 38) / 1000;
const ZONES = { UTC0: 0, UTC: 0, 'Asia/Seoul': 9, 'America/New_York': -4 };
function lstartUnder(env) {
  const locale = env.LC_ALL ?? env.LANG ?? 'C';
  const shift = ZONES[env.TZ ?? 'Asia/Seoul'];
  const t = new Date((START_UTC + shift * 3600) * 1000);
  const hms = t.toISOString().slice(11, 19);
  if (locale === 'C') {
    const day = String(t.getUTCDate()).padStart(2, ' ');
    return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][t.getUTCDay()]} Oct ${day} ${hms} 2026`;
  }
  if (locale.startsWith('ko')) return `수 10/${t.getUTCDate()} ${hms} 2026`;
  return `Wed ${t.getUTCDate()} Oct ${hms} 2026`;
}
const COMMAND = 'node /x/peer-runner.mjs run --peer codex';
const PINNED = { lstart: 'Wed Oct 14 01:31:38 2026', command: COMMAND };
const KOREAN_TERMINAL = { LANG: 'ko_KR.UTF-8', TZ: 'Asia/Seoul' };
const ENGLISH_WORKER = { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TZ: 'America/New_York' };

// A darwin system for process-identity whose `ps` answers as above, run
// from a caller whose environment is `callerEnv`. `ps -A` lists one other
// process, pid 70, with this start.
const darwinSystem = (callerEnv) => ({
  platform: 'darwin', pid: 1, env: callerEnv, now: () => 0, uptime: () => 0,
  spawnSync(cmd, args, options) {
    const env = options.env ?? callerEnv;
    if (cmd.endsWith('sysctl')) return { status: 0, stdout: '{ sec = 1000, usec = 5 }\n' };
    if (args[0] === '-A') return { status: 0, stdout: `   70     1   501 Ss   ${lstartUnder(env)}\n    1     0     0 Ss   ${lstartUnder(env)}\n` };
    return { status: 0, stdout: `${lstartUnder(env)} ${COMMAND}\n`, stderr: '' };
  },
});

// The lock readers run `ps` in `process.env` merged with what they pin: the
// caller's environment is set there for the read.
function asCaller(callerEnv, fn) {
  const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, TZ: process.env.TZ };
  for (const k of Object.keys(saved)) delete process.env[k];
  Object.assign(process.env, callerEnv);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
const darwinExecFile = (cmd, args, options) => `Ss   ${lstartUnder(options.env)} ${COMMAND}\n`;

for (const persona of personasFor('scripts/lib/process-identity.mjs')) {
  describe(`${persona}: process-identity compares a macOS start read in the C locale and UTC (C141)`, async () => {
    const identity = await import(pathToFileURL(personaInfo(persona).path('scripts/lib/process-identity.mjs')).href);
    const fingerprint = (callerEnv) => identity.fingerprintForPid(process.pid, { system: darwinSystem(callerEnv) });

    it('one process fingerprints the same pinned reading from callers in two locales and time zones, its earlier fields kept', async () => {
      const fromTerminal = await fingerprint(KOREAN_TERMINAL);
      const fromWorker = await fingerprint(ENGLISH_WORKER);
      deepStrictEqual(fromTerminal, { kind: 'macos_lstart_command', lstart: `수 10/14 10:31:38 2026 ${COMMAND}`, command: '', pinned: PINNED });
      deepStrictEqual(fromWorker.pinned, PINNED);
      strictEqual(identity.fingerprintsMatch(fromTerminal, fromWorker), true);
    });

    it('cancel and reclaim see the recording run as itself; a start that differs as read the same way is a reused pid', async () => {
      const recorded = await fingerprint(KOREAN_TERMINAL);
      // process.pid is alive, so the state comes from the comparison alone:
      // 'match' keeps a snapshot (supervisor-alive) and lets a cancel signal.
      strictEqual(await identity.identityState({ pid: process.pid, fingerprint: recorded }, { system: darwinSystem(ENGLISH_WORKER) }), 'match');
      const reused = { ...recorded, pinned: { ...PINNED, lstart: 'Thu Jan  1 00:00:00 2026' } };
      strictEqual(await identity.identityState({ pid: process.pid, fingerprint: reused }, { system: darwinSystem(ENGLISH_WORKER) }), 'differ');
    });

    it('a record with no pinned reading is unknown, and no proof for a signal, even when its start reads the same', async () => {
      // An earlier writer in Seoul, C locale: 10:31:38 local. A process the
      // pid now names that started at 10:31:38 UTC, nine hours later, reads
      // the same text to a reader in UTC: equal text is no proof.
      const earlier = { kind: 'macos_lstart_command', lstart: 'Wed Oct 14 10:31:38 2026', command: COMMAND };
      const utcReader = { LANG: 'C', TZ: 'UTC0' };
      const later = { ...darwinSystem(utcReader), spawnSync: () => ({ status: 0, stdout: `Wed Oct 14 10:31:38 2026 ${COMMAND}\n` }) };
      strictEqual(await identity.identityState({ pid: process.pid, fingerprint: earlier }, { system: later }), 'unknown');
      strictEqual(identity.fingerprintsMatch(earlier, await identity.fingerprintForPid(process.pid, { system: later })), false);
      strictEqual(identity.fingerprintComparison(earlier, await fingerprint(KOREAN_TERMINAL)), 'unknown');
    });

    it('the process table reads one start in seconds from callers in two locales and time zones', async () => {
      const a = await identity.processLineage(70, { system: darwinSystem(KOREAN_TERMINAL) });
      const b = await identity.processLineage(70, { system: darwinSystem(ENGLISH_WORKER) });
      strictEqual(a?.starttime, String(START_UTC));
      strictEqual(b?.starttime, String(START_UTC));
    });

    it('the earlier fields are read as an earlier writer read them: no ps on PATH, or a failed read, fingerprints none', async () => {
      // An earlier writer ran `ps` from PATH alone and fingerprinted none when
      // it failed; a record holding fields it would not have written would be
      // judged by an earlier reader on a reading it cannot make (C141).
      const noPathPs = { ...darwinSystem(KOREAN_TERMINAL), spawnSync: (cmd, args, options) => (cmd === 'ps' ? { error: Object.assign(new Error('spawnSync ps ENOENT'), { code: 'ENOENT' }), status: null } : darwinSystem(KOREAN_TERMINAL).spawnSync(cmd, args, options)) };
      deepStrictEqual(await identity.fingerprintForPid(process.pid, { system: noPathPs }), { kind: 'none' });
      const failing = { ...darwinSystem(KOREAN_TERMINAL), spawnSync: (cmd, args, options) => (options.env ? darwinSystem(KOREAN_TERMINAL).spawnSync(cmd, args, options) : { status: 1, stdout: '' }) };
      deepStrictEqual(await identity.fingerprintForPid(process.pid, { system: failing }), { kind: 'none' });
      // An output an earlier writer's buffer (1 MiB) could not hold: none, as it was.
      const long = `${lstartUnder(KOREAN_TERMINAL)} ${'x'.repeat(2 * 1024 * 1024)}\n`;
      const bounded = { ...darwinSystem(KOREAN_TERMINAL), spawnSync: (cmd, args, options) => (options.env ? darwinSystem(KOREAN_TERMINAL).spawnSync(cmd, args, options) : long.length > (options.maxBuffer ?? 1024 * 1024) ? { error: Object.assign(new Error('spawnSync ps ENOBUFS'), { code: 'ENOBUFS' }), status: null, stdout: long.slice(0, options.maxBuffer) } : { status: 0, stdout: long }) };
      deepStrictEqual(await identity.fingerprintForPid(process.pid, { system: bounded }), { kind: 'none' });
      // A `ps` that answers late (15 s): an earlier writer waited for it, so the
      // fields it read are recorded, never none (a sweep reads none as gone).
      const slow = { ...darwinSystem(KOREAN_TERMINAL), spawnSync: (cmd, args, options) => (!options.env && (options.timeout ?? Infinity) < 15000 ? { error: Object.assign(new Error('spawnSync ps ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null } : darwinSystem(KOREAN_TERMINAL).spawnSync(cmd, args, options)) };
      strictEqual((await identity.fingerprintForPid(process.pid, { system: slow })).kind, 'macos_lstart_command');
      // A pinned read that ends in an error is no reading, whatever it printed.
      const erring = { ...darwinSystem(KOREAN_TERMINAL), spawnSync: (cmd, args, options) => ({ ...darwinSystem(KOREAN_TERMINAL).spawnSync(cmd, args, options), ...(options.env ? { error: Object.assign(new Error('spawnSync ps ETIMEDOUT'), { code: 'ETIMEDOUT' }) } : {}) }) };
      strictEqual('pinned' in await identity.fingerprintForPid(process.pid, { system: erring }), false);
    });

    it('a pid that passes to another process between the reads keeps no pinned reading', async () => {
      // The first pinned read names the recorded process; the pid then names
      // another, which the earlier read and the last pinned read see.
      let pinnedReads = 0;
      const base = darwinSystem(KOREAN_TERMINAL);
      const reused = { ...base, spawnSync(cmd, args, options) {
        if (options.env?.TZ === 'UTC0' && ++pinnedReads === 1) return { status: 0, stdout: `Thu Jan  1 00:00:00 2026 /usr/bin/other\n` };
        return base.spawnSync(cmd, args, options);
      } };
      const fp = await identity.fingerprintForPid(process.pid, { system: reused });
      strictEqual(pinnedReads, 2);
      strictEqual(fp.kind, 'macos_lstart_command');
      strictEqual('pinned' in fp, false);
      strictEqual(identity.fingerprintComparison(fp, await fingerprint(KOREAN_TERMINAL)), 'unknown');
    });

    it('a pid that passes in the same second to another command keeps no pinned reading; the reads run pinned, earlier, pinned', async () => {
      // The start alone cannot tell them (an exec in place, or a pid taken
      // within the second): the command line must agree too.
      const order = [];
      const base = darwinSystem(KOREAN_TERMINAL);
      const execd = { ...base, spawnSync(cmd, args, options) {
        order.push(options.env?.TZ === 'UTC0' ? 'pinned' : 'earlier');
        if (options.env?.TZ === 'UTC0' && order.length === 1) return { status: 0, stdout: `${PINNED.lstart} /usr/bin/other\n` };
        return base.spawnSync(cmd, args, options);
      } };
      const fp = await identity.fingerprintForPid(process.pid, { system: execd });
      deepStrictEqual(order, ['pinned', 'earlier', 'pinned']);
      strictEqual('pinned' in fp, false);
    });

    it('the pinned reads close their stdin, so a sandbox that refuses the pipe keeps the reading', async () => {
      // A sandboxed spawn may print the tool's output and still end EPERM
      // when it opened a pipe for stdin (measured under the Codex sandbox).
      const base = darwinSystem(KOREAN_TERMINAL);
      const sandboxed = { ...base, spawnSync(cmd, args, options) {
        const run = base.spawnSync(cmd, args, options);
        const stdin = Array.isArray(options.stdio) ? options.stdio[0] : options.stdio;
        return stdin === 'ignore' ? run : { ...run, error: Object.assign(new Error('spawnSync ps EPERM'), { code: 'EPERM' }) };
      } };
      deepStrictEqual((await identity.fingerprintForPid(process.pid, { system: sandboxed })).pinned, PINNED);
    });

    it('settle waits on a supervisor unchanged but for its locale, as an earlier runner judged it otherwise', async () => {
      // A supervisor record as the runner writes it: the fingerprint, the
      // process table's start in seconds, the clock and the ancestors.
      const sup = (callerEnv) => fingerprint(callerEnv).then((fp) => ({ ...fp, starttime: String(START_UTC), clock: 'boot/pid:[1]', ancestors: [{ pid: 1, starttime: '0' }] }));
      const terminal = await sup(KOREAN_TERMINAL);
      const worker = await sup(ENGLISH_WORKER);
      strictEqual(identity.supervisorUnchanged(terminal, worker), true);
      // `pinned` written back with its keys in another order is the same reading.
      strictEqual(identity.supervisorUnchanged({ ...terminal, pinned: { command: PINNED.command, lstart: PINNED.lstart } }, worker), true);
      strictEqual(identity.supervisorUnchanged(terminal, { ...worker, pinned: { ...PINNED, lstart: 'Thu Oct 15 01:31:38 2026' } }), false);
      strictEqual(identity.supervisorUnchanged(terminal, { ...worker, pinned: { ...PINNED, command: 'node other' } }), false);
      strictEqual(identity.supervisorUnchanged(terminal, { ...worker, starttime: '1' }), false);
      strictEqual(identity.supervisorUnchanged(terminal, { ...worker, clock: 'boot/pid:[2]' }), false);
      // An earlier runner's record, no pinned reading: compared as it always
      // was, so it waits in the writer's environment and not across it.
      const { pinned: _p, ...earlier } = terminal;
      strictEqual(identity.supervisorUnchanged(earlier, await sup(KOREAN_TERMINAL)), true);
      strictEqual(identity.supervisorUnchanged(earlier, worker), false);
      // A Linux record has no pinned reading: every field decides.
      const linux = { kind: 'linux_proc_starttime', starttime: '42', command: 'node x', clock: 'boot/pid:[1]', ancestors: [] };
      strictEqual(identity.supervisorUnchanged(linux, { ...linux }), true);
      strictEqual(identity.supervisorUnchanged(linux, { ...linux, clock: 'boot/pid:[2]' }), false);
      strictEqual(identity.supervisorUnchanged(linux, { ...linux, command: 'node y' }), false);
    });

    it('a pinned start with anything after it is no pinned reading', () => {
      strictEqual(identity.isPinnedReading(PINNED), true);
      const trailing = { lstart: `${PINNED.lstart} ${COMMAND}`, command: '' };
      strictEqual(identity.isPinnedReading(trailing), false);
      strictEqual(identity.fingerprintComparison({ kind: 'macos_lstart_command', lstart: '', command: '', pinned: trailing }, { kind: 'macos_lstart_command', lstart: '', command: '', pinned: PINNED }), 'unknown');
    });
  });
}

for (const persona of personasFor('scripts/lib/holds.mjs')) {
  describe(`${persona}: holds compares a macOS start read in the C locale and UTC (C141)`, async () => {
    const holds = await import(pathToFileURL(personaInfo(persona).path('scripts/lib/holds.mjs')).href);
    const read = (callerEnv) => asCaller(callerEnv, () => holds.processFingerprint(process.pid, { platform: 'darwin', execFile: darwinExecFile }));

    it('one process reads one pinned start from two callers; a live recorder is live, a reused pid is not', () => {
      const a = read(KOREAN_TERMINAL);
      const b = read(ENGLISH_WORKER);
      deepStrictEqual(a, { kind: 'macos_lstart_command', lstart: 'Wed Oct 14 10:31:38 2026', command: COMMAND, pinned: PINNED });
      deepStrictEqual(b.pinned, PINNED);
      strictEqual(holds.recordedProcessLive(process.pid, a, { probe: () => b }), true);
      strictEqual(holds.recordedProcessLive(process.pid, { ...a, pinned: { ...PINNED, lstart: 'Thu Jan  1 00:00:00 2026' } }, { probe: () => b }), false);
    });

    it('a record with no pinned reading, its start read in another time zone, is not taken for a reused pid', () => {
      const earlier = { kind: 'macos_lstart_command', lstart: 'Wed Oct 14 10:31:38 2026', command: COMMAND };
      strictEqual(holds.recordedProcessLive(process.pid, earlier, { probe: () => read(ENGLISH_WORKER) }), true);
      // A malformed pinned start (a start with text after it) proves nothing either.
      const malformed = { ...earlier, pinned: { lstart: `${PINNED.lstart} x`, command: COMMAND } };
      strictEqual(holds.recordedProcessLive(process.pid, malformed, { probe: () => ({ ...read(ENGLISH_WORKER), pinned: { ...PINNED, lstart: 'Thu Jan  1 00:00:00 2026' } }) }), true);
    });

    it('a pid that passes to another process between the reads keeps no pinned reading', () => {
      let reads = 0;
      const execFile = (cmd, args, options) => (++reads === 1 ? `Ss   Thu Jan  1 00:00:00 2026 /usr/bin/other\n` : darwinExecFile(cmd, args, options));
      const fp = asCaller(KOREAN_TERMINAL, () => holds.processFingerprint(process.pid, { platform: 'darwin', execFile }));
      strictEqual(reads, 3);
      strictEqual('pinned' in fp, false);
    });

    it('a pid that passes in the same second to another command keeps no pinned reading; the reads run pinned, earlier, pinned', () => {
      const zones = [];
      const execFile = (cmd, args, options) => {
        zones.push(options.env.TZ);
        return zones.length === 1 ? `Ss   ${PINNED.lstart} /usr/bin/other\n` : darwinExecFile(cmd, args, options);
      };
      const fp = asCaller(KOREAN_TERMINAL, () => holds.processFingerprint(process.pid, { platform: 'darwin', execFile }));
      deepStrictEqual(zones, ['UTC0', 'Asia/Seoul', 'UTC0']);
      strictEqual('pinned' in fp, false);
    });
  });
}

describe('orchestrator run-locks compares a macOS start read in the C locale and UTC (C141)', async () => {
  const locks = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/run-locks.mjs')).href);
  const read = (callerEnv) => asCaller(callerEnv, () => locks.processFingerprint(process.pid, { platform: 'darwin', execFile: darwinExecFile }));

  it('one process reads one pinned start from two callers; a holder recorded by one is live, and provably the same, to the other', async () => {
    const a = await read(KOREAN_TERMINAL);
    const b = await read(ENGLISH_WORKER);
    deepStrictEqual(a, { kind: 'macos_lstart_command', lstart: 'Wed Oct 14 10:31:38 2026', command: COMMAND, pinned: PINNED });
    deepStrictEqual(b.pinned, PINNED);
    strictEqual(await locks.holderAlive({ pid: process.pid, fingerprint: a }, { probe: async () => b }), true);
    strictEqual(await locks.provablySame(process.pid, a, { probe: async () => b }), true);
  });

  it('a holder with no pinned reading is live, and never proof for a signal, even when its start reads the same', async () => {
    const now = await read(ENGLISH_WORKER);
    const earlier = { kind: 'macos_lstart_command', lstart: now.lstart, command: COMMAND };
    strictEqual(await locks.holderAlive({ pid: process.pid, fingerprint: { ...earlier, lstart: 'Wed Oct 14 10:31:38 2026' }, worker: null }, { probe: async () => now }), true);
    strictEqual(await locks.provablySame(process.pid, earlier, { probe: async () => now }), false);
  });

  it('a pid that passes to another process between the reads keeps no pinned reading', async () => {
    let reads = 0;
    const execFile = (cmd, args, options) => (++reads === 3 ? `Ss   Thu Jan  1 00:00:00 2026 /usr/bin/other\n` : darwinExecFile(cmd, args, options));
    const fp = await asCaller(KOREAN_TERMINAL, () => locks.processFingerprint(process.pid, { platform: 'darwin', execFile }));
    strictEqual(reads, 3);
    strictEqual('pinned' in fp, false);
    strictEqual(await locks.provablySame(process.pid, fp, { probe: async () => read(ENGLISH_WORKER) }), false);
  });

  it('a pid that passes in the same second to another command keeps no pinned reading; the reads run pinned, earlier, pinned', async () => {
    const zones = [];
    const execFile = (cmd, args, options) => {
      zones.push(options.env.TZ);
      return zones.length === 3 ? `Ss   ${PINNED.lstart} /usr/bin/other\n` : darwinExecFile(cmd, args, options);
    };
    const fp = await asCaller(KOREAN_TERMINAL, () => locks.processFingerprint(process.pid, { platform: 'darwin', execFile }));
    deepStrictEqual(zones, ['UTC0', 'Asia/Seoul', 'UTC0']);
    strictEqual('pinned' in fp, false);
  });
});
