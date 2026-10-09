// A stand-in for a driver with lanes, for tests/orchestrator/test-autopilot-lanes.mjs:
// it takes a run's lock, writes its open-run record, starts two worker groups (each a process-group
// leader with a member of its group, like a worker and its tool calls),
// records each group in the lock with addWorkerGroup, writes their pids to
// argv[3] and waits to be killed. The test kills it, so the groups survive
// their driver. Used by tests/orchestrator/test-autopilot-dead-runs.mjs too.
//
//   node autopilot-lane-driver.mjs <lock dir> <ready file> <run id> <macro id> <cwd A> <cwd B> [--no-groups | --group-on-term]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [lock, ready, runId, macroId, cwdA, cwdB, flag] = process.argv.slice(2);
// --no-groups: a driver between steps, which a SIGTERM kills before it records
// its end (a crash on the way out).
// --group-on-term: a driver between steps that, on stop's SIGTERM, starts a
// group (a step admitted as the signal came) and dies without recording its
// end or releasing that group's entry; the group's pid goes to <ready>.term.
const lanes = flag === '--no-groups' || flag === '--group-on-term' ? [] : [['A', cwdA], ['B', cwdB]];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { acquireLock, processFingerprint } = await import(path.join(root, 'plugins/orchestrator/scripts/lib/run-locks.mjs'));
const { autopilotDir, mainWorktreeRoot, writeOpenRun } = await import(path.join(root, 'plugins/orchestrator/adapters/claude/autopilot/ledger.mjs'));

const held = await acquireLock(lock, { record: { run_id: runId, macro_id: macroId, repo: cwdA } });
// As a driver does before its first spawn: its open-run record, pointing at
// the ledger the test wrote in cwdA (ADR-0067 Decision 6, Locks).
writeOpenRun(mainWorktreeRoot(cwdA), {
  runId, macroId, checkout: cwdA, runDir: path.join(autopilotDir(cwdA), runId),
  pid: process.pid, fingerprint: await processFingerprint(process.pid), startedAt: new Date().toISOString(),
});
async function startGroup(lane, cwd) {
  const leader = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    setInterval(() => {}, 1000);
  `], { cwd, detached: true, stdio: 'ignore' });
  leader.unref();
  await new Promise((r) => { setTimeout(r, 200); });
  held.addWorkerGroup({ pid: leader.pid, pgid: leader.pid, fingerprint: await processFingerprint(leader.pid), session_id: `s-${lane}`, lane, cwd });
  return leader.pid;
}
const groups = [];
for (const [lane, cwd] of lanes) groups.push(await startGroup(lane, cwd));
if (flag === '--group-on-term') {
  process.on('SIGTERM', async () => {
    const pid = await startGroup('A', cwdA);
    fs.writeFileSync(`${ready}.term`, JSON.stringify({ group: pid }));
    process.exit(0);
  });
}
fs.writeFileSync(ready, JSON.stringify({ groups }));
setInterval(() => {}, 1000);
