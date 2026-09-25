// Shared fixture for the ADR-0061 §Decision 4 tests: a REAL git repository standing in
// for the registered Codex marketplace clone, and installs extracted from it with
// `git archive` the way a successful materialization produces them.

import { execFile, execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SHA = 'a'.repeat(40);

export function pinned(name, version, sha = SHA, extra = {}) {
  return { name, source: { source: 'git-subdir', url: './', path: `plugins/${name}`, ref: `plugin-${name}-v${version}`, sha, ...extra } };
}

export function okResult(stdout = '') {
  return { ok: true, exit_code: 0, stdout, stderr: '', error_code: null, timed_out: false };
}
export function enoent(command) {
  return { ok: false, exit_code: null, stdout: '', stderr: '', error_code: 'ENOENT', error_message: `spawn ${command} ENOENT`, timed_out: false };
}

// The probe's injected runner: host CLIs are faked, `git` really runs — the identity
// read is the thing under test. Every git call's env is recorded.
export function mixedRunner(map, gitCalls = []) {
  return async (command, args, { cwd, env } = {}) => {
    if (command === 'git') {
      gitCalls.push({ args, env });
      return new Promise((resolvePromise) => {
        execFile('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (!err) resolvePromise({ ok: true, exit_code: 0, stdout, stderr, error_code: null });
          else resolvePromise({ ok: false, exit_code: typeof err.code === 'number' ? err.code : null, stdout, stderr, error_code: typeof err.code === 'string' ? err.code : null });
        });
      });
    }
    return map[`${command} ${args.join(' ')}`] ?? enoent(command);
  };
}

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

// A marketplace clone with two commits of plugins/runtime: C1 = 0.1.0, C2 = 0.2.0.
export async function buildClone() {
  const clone = await realpath(await mkdtemp(join(tmpdir(), 'codex-identity-clone-')));
  git(clone, 'init', '-q', '-b', 'main');
  const plugin = join(clone, 'plugins', 'runtime');
  await mkdir(join(plugin, '.codex-plugin'), { recursive: true });
  await mkdir(join(plugin, 'scripts'), { recursive: true });
  const write = async (version, body) => {
    await writeFile(join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'runtime', version }));
    await writeFile(join(plugin, 'scripts', 'a.mjs'), body);
    await writeFile(join(plugin, 'scripts', 'run.sh'), '#!/bin/sh\necho run\n');
    await chmod(join(plugin, 'scripts', 'run.sh'), 0o755);
  };
  await write('0.1.0', 'export const v = 1;\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'C1');
  const c1 = git(clone, 'rev-parse', 'HEAD');
  await write('0.2.0', 'export const v = 2;\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'C2');
  const c2 = git(clone, 'rev-parse', 'HEAD');
  return { clone, c1, c2 };
}

export async function writeCatalog(clone, entries) {
  await mkdir(join(clone, '.agents', 'plugins'), { recursive: true });
  await writeFile(join(clone, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'agentic-plugins', plugins: entries }));
}

// Materialize plugins/runtime at `commit` into the Codex install cache under `version`.
export async function installFromClone(clone, commit, codexHome, version) {
  const extract = await mkdtemp(join(tmpdir(), 'codex-identity-extract-'));
  execFileSync('/bin/sh', ['-c', `git -C "${clone}" archive ${commit} plugins/runtime | tar -x -C "${extract}"`]);
  const dest = join(codexHome, 'plugins', 'cache', 'agentic-plugins', 'runtime', version);
  await rm(dest, { recursive: true, force: true });
  await mkdir(join(dest, '..'), { recursive: true });
  await cp(join(extract, 'plugins', 'runtime'), dest, { recursive: true });
  return dest;
}
