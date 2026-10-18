// Shared cases for `peer-runner.mjs new-run-id` (C119/C26), run against every
// persona copy (tests/persona-pipeline/test-peer-runner.mjs) and the
// orchestrator's (tests/orchestrator/test-peer-runner.mjs).
//
// The allocator prints one id, `<prefix>-<UTC yyyymmddThhmmssZ>-<6 lowercase
// hex>`, for a runbook to pass with --run-id; its prefixes are the ones the
// plugin's runbooks dispatch under today, read here from the runbook text so
// the allowed set and the runbooks cannot drift apart.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const ID_SHAPE = /^([a-z][a-z-]*)-(\d{8}T\d{6}Z)-([0-9a-f]{6})$/;

function markdownFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries.flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return markdownFiles(p);
    return e.isFile() && e.name.endsWith('.md') ? [p] : [];
  });
}

/**
 * The run-id prefixes the runbooks of `pluginRoots` dispatch under: a literal
 * `RUN_ID="<prefix>-$(…)"`, a `--run-id <prefix>-<…>` placeholder, an
 * allocator call's `--prefix <prefix>`, and, where a run id is built from the
 * ensemble type (`withEnsembleTypes`), every `ENSEMBLE_TYPE='<type>'` and
 * `--ensemble-type <type>`.
 */
export function runbookRunIdPrefixes(pluginRoots, { withEnsembleTypes }) {
  const patterns = [
    /RUN_ID="([a-z][a-z-]*?)-\$\(/g,
    /--run-id[ =]([a-z][a-z-]*?)-</g,
    /--prefix[ =]['"]?([a-z][a-z-]*)/g,
  ];
  if (withEnsembleTypes) {
    patterns.push(/ENSEMBLE_TYPE='([a-z][a-z-]*)'/g, /--ensemble-type[ =]['"]?([a-z][a-z-]*)/g);
  }
  const found = new Set();
  for (const root of pluginRoots) {
    for (const file of [...markdownFiles(join(root, 'commands')), ...markdownFiles(join(root, 'core', 'skills'))]) {
      const text = readFileSync(file, 'utf8');
      for (const re of patterns) for (const m of text.matchAll(re)) found.add(m[1]);
    }
  }
  return found;
}

function stampToMs(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function spawnAllocator(peerRunnerPath, args, opts) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, [peerRunnerPath, 'new-run-id', ...args], { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', rejectP);
    child.on('close', (status) => resolveP({ status, stdout, stderr }));
  });
}

/**
 * The allocator's cases for one peer-runner copy. `mod` is its imported
 * module, `expectedPrefixes` the prefixes its plugin's runbooks use (from
 * runbookRunIdPrefixes), `foreignPrefix` one that another plugin's runbooks
 * use and this copy must refuse.
 */
export function describeRunIdAllocator({ label, peerRunnerPath, mod, expectedPrefixes, foreignPrefix, env }) {
  const { RUN_ID_PREFIXES, allocateRunId, peerRunPaths } = mod;
  const run = (args, cwd) => spawnSync(process.execPath, [peerRunnerPath, 'new-run-id', ...args], { encoding: 'utf8', env, cwd });

  describe(`${label}: peer-runner.mjs new-run-id (C119/C26)`, () => {
    it('allows exactly the run-id prefixes the runbooks dispatch under', () => {
      ok(expectedPrefixes.size > 0, 'the runbook scan found prefixes');
      deepStrictEqual([...RUN_ID_PREFIXES].sort(), [...expectedPrefixes].sort());
      ok(!RUN_ID_PREFIXES.has(foreignPrefix), `${foreignPrefix} is another plugin's prefix`);
    });

    it('prints one <prefix>-<UTC stamp>-<6 hex> id per prefix, exit 0, nothing on stderr, a safe ledger name', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'run-id-allocator-'));
      try {
        for (const prefix of RUN_ID_PREFIXES) {
          const before = Math.floor(Date.now() / 1000) * 1000;
          const cp = run(['--prefix', prefix], cwd);
          const after = Date.now();
          strictEqual(cp.status, 0, `stderr: ${cp.stderr}`);
          strictEqual(cp.stderr, '');
          ok(cp.stdout.endsWith('\n') && !cp.stdout.slice(0, -1).includes('\n'), `one line: ${JSON.stringify(cp.stdout)}`);
          const id = cp.stdout.slice(0, -1);
          const m = ID_SHAPE.exec(id);
          ok(m, `shape: ${id}`);
          strictEqual(m[1], prefix);
          const at = stampToMs(m[2]);
          ok(at >= before && at <= after, `the stamp is the current UTC second: ${m[2]}`);
          peerRunPaths(cwd, id, { home: 'canonical' });
        }
        deepStrictEqual(await readdir(cwd), [], 'the allocator writes nothing');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('the stamp is the UTC second of the time given, the suffix 6 lowercase hex', () => {
      const [prefix] = RUN_ID_PREFIXES;
      const id = allocateRunId(prefix, new Date('2026-01-02T03:04:05.987Z'));
      const m = ID_SHAPE.exec(id);
      ok(m, id);
      strictEqual(m[2], '20260102T030405Z');
    });

    it('refuses an unknown, foreign or missing prefix, and a repeated one, with exit 2 and no id', () => {
      for (const args of [
        ['--prefix', foreignPrefix],
        ['--prefix', 'manual'],
        ['--prefix', ''],
        ['--prefix', 'PEER-NOW'],
        ['--prefix', 'peer-now-x'],
        ['--prefix', '../peer-now'],
        [],
        ['--prefix'],
        ['--prefix', 'peer-now', '--prefix', 'peer-now'],
        ['--prefix', 'peer-now', '--bogus'],
      ]) {
        const cp = run(args);
        strictEqual(cp.status, 2, `${JSON.stringify(args)}: exit ${cp.status}, stderr ${cp.stderr}`);
        strictEqual(cp.stdout, '', `${JSON.stringify(args)}: no id`);
        ok(/--prefix|Unknown argument/.test(cp.stderr), `${JSON.stringify(args)}: ${cp.stderr}`);
      }
      throws(() => allocateRunId(foreignPrefix), /--prefix must be one of/);
    });

    // A runbook captures the id with $(…): an entry guard that compared the
    // unresolved argv path would skip the CLI and exit 0 with no id.
    it('prints an id when started through a linked directory whose path has a space and a #', async () => {
      const scratch = await mkdtemp(join(tmpdir(), 'run-id-allocator-link-'));
      try {
        const link = join(scratch, 'linked scripts #1');
        symlinkSync(dirname(realpathSync(peerRunnerPath)), link, 'dir');
        const [prefix] = RUN_ID_PREFIXES;
        const cp = spawnSync(process.execPath, [join(link, basename(peerRunnerPath)), 'new-run-id', '--prefix', prefix], { encoding: 'utf8', env, cwd: scratch });
        strictEqual(cp.status, 0, `stderr: ${cp.stderr}`);
        ok(ID_SHAPE.test(cp.stdout.trim()), `an id, got ${JSON.stringify(cp.stdout)}`);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });

    it('concurrent calls print distinct ids', async () => {
      const [prefix] = RUN_ID_PREFIXES;
      const results = await Promise.all(Array.from({ length: 12 }, () => spawnAllocator(peerRunnerPath, ['--prefix', prefix], { env })));
      for (const r of results) strictEqual(r.status, 0, r.stderr);
      const ids = results.map((r) => r.stdout.trim());
      ok(ids.every((id) => ID_SHAPE.test(id)), ids.join(' '));
      strictEqual(new Set(ids).size, ids.length, `distinct: ${ids.join(' ')}`);
    });
  });
}
