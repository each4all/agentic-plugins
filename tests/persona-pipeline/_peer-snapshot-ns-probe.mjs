// C142 U-F1 — a judgment or a cancel of a peer snapshot's run, read through a
// Linux /proc this process makes up, run in a process of its own: the library
// keeps the fs/promises functions it loaded with (its `system`), so they are
// replaced here before it loads, as the fourteenth review's probe did. Every
// other path reads the real file system.
//
// argv[2] is JSON: { runner, lib } (the scripts' paths), `action` ('judge' or
// 'cancel', or 'reclaim' for judgeSnapshot with `ttlMs`), `pgid` (the real group the made-up /proc names a member of, in
// `cwd`), `entry` (the pid of that member, the only one /proc lists; 234 by
// default) and its `starttime` (1200 by default), `self` (what /proc/self
// names; this process's pid by default),
// `pidNamespace` (/proc/self/ns/pid), and `owner` and `tree` for a judgment,
// or `repo` and `runId` for a cancel. It prints { result, sent }: what the
// call answered, and every signal other than 0 sent to the group.

import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';

const given = JSON.parse(process.argv[2]);
const { pgid } = given;
const self = given.self ?? String(process.pid);
const entry = String(given.entry ?? 234);
const original = { readdir: fsp.readdir, readlink: fsp.readlink, readFile: fsp.readFile };
const missing = () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
const ours = (path) => typeof path === 'string' && (path === '/proc' || path.startsWith('/proc/'));
fsp.readdir = (path, ...rest) => (path === '/proc' ? Promise.resolve([entry]) : ours(path) ? missing() : original.readdir(path, ...rest));
fsp.readlink = (path, ...rest) => {
  if (path === '/proc/self') return Promise.resolve(self);
  if (path === '/proc/self/ns/pid') return Promise.resolve(given.pidNamespace);
  if (path === '/proc/self/ns/time') return Promise.resolve('time:[1]');
  if (path === `/proc/${entry}/cwd`) return Promise.resolve(given.cwd);
  return ours(path) ? missing() : original.readlink(path, ...rest);
};
fsp.readFile = (path, ...rest) => {
  if (path === '/proc/sys/kernel/random/boot_id') return Promise.resolve('boot-a\n');
  if (path === `/proc/${entry}/stat`) return Promise.resolve(`${entry} (worker) S 1 ${pgid} ${pgid} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${given.starttime ?? 1200} 0 0`);
  if (path === `/proc/${entry}/cmdline`) return Promise.resolve('worker\0');
  return ours(path) ? missing() : original.readFile(path, ...rest);
};
syncBuiltinESMExports();
Object.defineProperty(process, 'platform', { value: 'linux' });
const sent = [];
const kill = process.kill;
process.kill = (target, sig) => {
  if (target === -pgid && sig !== 0) sent.push(sig ?? 'SIGTERM');
  return kill.call(process, target, sig);
};

let result;
if (given.action === 'judge') {
  const lib = await import(pathToFileURL(given.lib).href);
  const { verdict, why } = await lib.snapshotEnded(given.owner, { tree: given.tree, listProcesses: async () => [] });
  result = [verdict, why];
} else if (given.action === 'reclaim') {
  const lib = await import(pathToFileURL(given.lib).href);
  const { verdict, why } = await lib.judgeSnapshot(given.owner, { ttlMs: given.ttlMs, tree: given.tree, listProcesses: async () => [] });
  result = [verdict, why];
} else {
  const runner = await import(pathToFileURL(given.runner).href);
  result = await runner.cancelPeerRun({ repoRoot: given.repo, runId: given.runId, graceMs: 25 });
}
process.stdout.write(`${JSON.stringify({ result, sent })}\n`);
