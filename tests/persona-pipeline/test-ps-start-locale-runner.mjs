// C141 — the sweep and the cancel of a peer run judge its process by the
// macOS fingerprint the runner recorded, read again by a caller in another
// locale and time zone. These drive peer-runner's own paths (reconcileOne,
// cancelPeerRun) on a darwin reading: the process platform is set to darwin
// before peer-runner loads, and a `ps` on PATH prints what a real one prints
// under the environment it runs in. The pid is a child this file starts,
// leading a process group of its own, as the runner's companion does.
//
// A run recorded by one caller is the same process to another: the sweep
// leaves it running and a cancel signals it. A pid that names another
// process is orphaned. A record with no reading under LC_ALL=C and TZ=UTC0
// (an earlier writer's) is neither: the sweep leaves it and a cancel refuses.

import { after, before, describe, it } from 'node:test';
import { strictEqual } from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { personaInfo, personasFor } from './_personas.mjs';
import { fileTmpDirs } from '../_tmp.mjs';

const makeTmp = fileTmpDirs();
const COMMAND = 'node /x/peer-runner.mjs run --peer codex';
// One start, as `ps -o lstart=` prints it per locale and zone; PS_REUSED
// makes the pid name a process that started later (a reused pid).
const FAKE_PS = `#!/bin/sh
loc="\${LC_ALL:-\${LANG:-C}}"
if [ -n "$PS_REUSED" ]; then printf 'Thu Oct 15 09:00:00 2026 /usr/bin/other\\n'; exit 0; fi
case "$loc" in
  C) case "$TZ" in UTC0|UTC) s='Wed Oct 14 01:31:38 2026';; America/New_York) s='Tue Oct 13 21:31:38 2026';; *) s='Wed Oct 14 10:31:38 2026';; esac;;
  ko*) s='수 10/14 10:31:38 2026';;
  *) s='Tue 13 Oct 21:31:38 2026';;
esac
printf '%s %s\\n' "$s" '${COMMAND}'
`;
const KOREAN_TERMINAL = { LANG: 'ko_KR.UTF-8', TZ: 'Asia/Seoul' };
const ENGLISH_WORKER = { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TZ: 'America/New_York' };
const KEYS = ['LANG', 'LC_ALL', 'TZ', 'PS_REUSED'];
const saved = Object.fromEntries(['PATH', ...KEYS].map((k) => [k, process.env[k]]));
function caller(env) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
}

const platform = Object.getOwnPropertyDescriptor(process, 'platform');
// Every child this file starts, each stopped at the end, a case that failed
// before its own kill included.
const children = [];
before(() => {
  const bin = join(makeTmp('fake-ps-'), 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'ps'), FAKE_PS);
  chmodSync(join(bin, 'ps'), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
});
after(() => {
  Object.defineProperty(process, 'platform', platform);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* gone */ }
  }
});

for (const persona of personasFor('scripts/peer-runner.mjs')) {
  describe(`${persona}: the sweep and the cancel judge a macOS run across locales (C141)`, () => {
    let runner;
    before(async () => {
      // Loaded with the platform set: process-identity reads it at load.
      runner = await import(`${pathToFileURL(personaInfo(persona).path('scripts/peer-runner.mjs')).href}?darwin`);
    });
    const handleOf = (repoRoot, runId, pid, fingerprint) => ({
      schema_version: runner.HANDLE_SCHEMA_VERSION, run_id: runId, plugin: persona, kind: 'manual',
      workflow_path: null, phase: null, ensemble_type: null, host: 'codex', peer_host: 'claude', model: null, effort: null,
      cwd: repoRoot, output_format: 'json', status: 'running', pid, pgid: pid, process_fingerprint: fingerprint,
      started_at: '2026-10-14T01:31:40.000Z', updated_at: '2026-10-14T01:31:40.000Z', completed_at: null, last_output_at: null,
      stdout_bytes: 0, stderr_bytes: 0, exit_code: null, error_kind: null, prompt_retained: false,
    });
    async function ledger(runId, pid, fingerprint) {
      const repoRoot = makeTmp(`${persona}-c141-`);
      const paths = runner.peerRunPaths(repoRoot, runId);
      mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
      writeFileSync(paths.stdout, '');
      writeFileSync(paths.stderr, '');
      await runner.writeHandle(paths.handle, handleOf(repoRoot, runId, pid, fingerprint));
      return { repoRoot, paths };
    }
    const sweep = async ({ paths }) => (await runner.reconcileOne(paths, await runner.readHandle(paths.handle), { staleGraceMs: 0, now: new Date() })).status;
    const sleeper = () => {
      const c = spawn('sleep', ['60'], { stdio: 'ignore', detached: true });
      children.push(c);
      return c;
    };

    it('the sweep leaves a run recorded by a caller in another locale and zone running, and orphans a reused pid', async () => {
      const proc = sleeper();
      caller(KOREAN_TERMINAL);
      const recorded = await runner.fingerprintForPid(proc.pid);
      strictEqual(recorded.pinned?.lstart, 'Wed Oct 14 01:31:38 2026');
      caller(ENGLISH_WORKER);
      strictEqual(await sweep(await ledger('c141-sweep-live', proc.pid, recorded)), 'running');
      caller({ ...ENGLISH_WORKER, PS_REUSED: '1' });
      strictEqual(await sweep(await ledger('c141-sweep-reused', proc.pid, recorded)), 'orphaned');
      // An earlier writer's record, no pinned reading: never orphaned under it.
      const { pinned: _, ...earlier } = recorded;
      strictEqual(await sweep(await ledger('c141-sweep-earlier', proc.pid, earlier)), 'running');
      proc.kill('SIGKILL');
    });

    it('a cancel refuses an earlier writer\'s record and signals the run a caller in another locale recorded', async () => {
      const proc = sleeper();
      const exited = new Promise((resolve) => proc.on('exit', (code, signal) => resolve(signal)));
      caller(KOREAN_TERMINAL);
      const recorded = await runner.fingerprintForPid(proc.pid);
      const { pinned: _, ...earlier } = recorded;
      caller(ENGLISH_WORKER);
      const refused = await ledger('c141-cancel-earlier', proc.pid, earlier);
      const r1 = await runner.cancelPeerRun({ repoRoot: refused.repoRoot, runId: 'c141-cancel-earlier', graceMs: 50 });
      strictEqual(r1.reason, 'unsupported_unverifiable');
      strictEqual(proc.exitCode === null && proc.signalCode === null, true, 'not signalled');
      const live = await ledger('c141-cancel-live', proc.pid, recorded);
      const r2 = await runner.cancelPeerRun({ repoRoot: live.repoRoot, runId: 'c141-cancel-live', graceMs: 5000 });
      strictEqual(r2.ok, true, JSON.stringify(r2));
      strictEqual(await exited, 'SIGTERM');
    });
  });
}
