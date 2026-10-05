// C70 — every `state.mjs` CLI ended with `process.exit(code)` right after
// writing its JSON. Where stdout is an asynchronous pipe (macOS), exit() drops
// whatever the pipe has not taken yet, so a reader got exactly 65,536 bytes of
// a longer document and failed to parse it. The autopilot driver reads the
// macro through a pipe: a 66,052-byte macro halted it with "macro lookup
// failed: ... printed no JSON" (2026-10-05). The four copies share the entry
// block (ADR-0010 §5), so one test covers them.
//
// The document is pushed past the pipe buffer through `original_request`,
// which `read` echoes back. 100,000 bytes clears 64 KiB and stays under
// Linux's 128 KiB limit on a single argv string.

import { describe, it } from 'node:test';
import { strictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REQUEST = 'x'.repeat(100_000);

// [plugin, a verb its `create` accepts]
const CLIS = [
  ['orchestrator', 'plan'],
  ['engineer', 'investigate'],
  ['founder', 'investigate'],
  ['designer', 'investigate'],
];

async function withRepo(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'state-cli-stdout-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('state.mjs CLI stdout survives a pipe (C70)', () => {
  for (const [plugin, verb] of CLIS) {
    it(`${plugin}: read returns the whole document through a pipe`, async () => {
      const cli = join(REPO, 'plugins', plugin, 'scripts', 'state.mjs');
      await withRepo(async (root) => {
        const workflowPath = execFileSync(process.execPath, [
          cli, 'create', '--repo-root', root, '--verb', verb, '--host', 'claude',
          '--git-baseline-branch', 'main',
          '--git-baseline-head', '0000000000000000000000000000000000000000',
          '--original-request', REQUEST,
        ], { encoding: 'utf8' }).trim();
        // spawnSync reads stdout through a pipe, as the autopilot driver does.
        const r = spawnSync(process.execPath, [cli, 'read', '--workflow-path', workflowPath], {
          encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
        });
        strictEqual(r.status, 0, r.stderr);
        const bytes = Buffer.byteLength(r.stdout);
        let fm;
        try {
          fm = JSON.parse(r.stdout);
        } catch (err) {
          throw new Error(`${plugin} read printed ${bytes} bytes that do not parse: ${err.message}`);
        }
        strictEqual(fm.original_request, REQUEST);
      });
    });
  }
});
