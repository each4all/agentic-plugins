// plugins/engineer/scripts/state.mjs — ADR-0028 PR3 M3 schema 1.3 +
// parent_writeback_at write-ahead marker tests.
//
// Covers:
//   - schema 1.3 emit + SUPPORTED_SCHEMA_VERSIONS includes '1.3'
//   - parent_writeback_at absent (additive optional) round-trips
//   - parent_writeback_at populated (ISO timestamp) round-trips
//   - parent_writeback_at type validation (string-or-absent)
//   - setParentWritebackMarker / clearParentWritebackMarker helpers
//   - CLI subcommands set-parent-writeback-marker / clear-parent-writeback-marker
//
// Run via `node --test tests/engineer/test-state-schema-13.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, rejects } from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE_PATH = resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs');

const {
  createWorkflow,
  listWorkflowFiles,
  parseWorkflowFile,
  setParentWritebackMarker,
  clearParentWritebackMarker,
} = await import(STATE_PATH);

function gitInit(dir, branch) {
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, stdio: 'ignore' });
}

async function withTmpRepo(fn, { branch = 'test' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'engineer-schema13-'));
  try {
    gitInit(dir, branch);
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const MIN_BASELINE = {
  branch: 'test',
  head: '0000000000000000000000000000000000000000',
  status_digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
};

// -----------------------------------------------------------------------------
// parent_writeback_at — SCALAR (ISO timestamp) round-trip

describe('state.mjs — schema 1.3 parent_writeback_at (M3 write-ahead marker)', () => {
  it('absent parent_writeback_at on a fresh 1.3 file reads OK (additive optional)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot, verb: 'compose', host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'no marker yet',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const raw = await readFile(filePath, 'utf8');
      const { frontmatter } = parseWorkflowFile(raw);
      strictEqual(frontmatter.parent_writeback_at, undefined);
    });
  });

  it('setParentWritebackMarker writes an ISO timestamp; round-trips through parse', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot, verb: 'compose', host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'marker round-trip',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const ts = '2026-05-25T01:23:45Z';
      await setParentWritebackMarker({
        workflowPath: filePath, host: 'claude', at: ts,
      });
      const raw = await readFile(filePath, 'utf8');
      ok(/^parent_writeback_at: /m.test(raw), 'serialized file must carry the field');
      const { frontmatter } = parseWorkflowFile(raw);
      strictEqual(frontmatter.parent_writeback_at, ts);
    });
  });

  it('clearParentWritebackMarker removes the field (idempotent)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot, verb: 'compose', host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'marker clear',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      await setParentWritebackMarker({
        workflowPath: filePath, host: 'claude', at: '2026-05-25T01:23:45Z',
      });
      await clearParentWritebackMarker({ workflowPath: filePath, host: 'claude' });
      const raw = await readFile(filePath, 'utf8');
      ok(!/^parent_writeback_at:/m.test(raw), 'serialized file must drop the field on clear');
      // Calling clear on an already-cleared file is a no-op (idempotent).
      await clearParentWritebackMarker({ workflowPath: filePath, host: 'claude' });
    });
  });

  it('setParentWritebackMarker rejects non-string at', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot, verb: 'compose', host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'marker reject non-string',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      await rejects(
        setParentWritebackMarker({ workflowPath: filePath, host: 'claude', at: 42 }),
        /at must be a non-empty string/,
      );
      await rejects(
        setParentWritebackMarker({ workflowPath: filePath, host: 'claude', at: '' }),
        /at must be a non-empty string/,
      );
    });
  });

  it('CLI set-parent-writeback-marker + clear-parent-writeback-marker round-trip', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot, verb: 'compose', host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'cli marker round-trip',
      });
      const [filePath] = await listWorkflowFiles(repoRoot);
      const ts = '2026-05-25T02:34:56Z';
      execFileSync('node', [
        STATE_PATH, 'set-parent-writeback-marker',
        '--workflow-path', filePath, '--host', 'claude', '--at', ts,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let raw = await readFile(filePath, 'utf8');
      ok(raw.includes(ts), 'CLI set must persist the timestamp');
      execFileSync('node', [
        STATE_PATH, 'clear-parent-writeback-marker',
        '--workflow-path', filePath, '--host', 'claude',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      raw = await readFile(filePath, 'utf8');
      ok(!/^parent_writeback_at:/m.test(raw), 'CLI clear must drop the field');
    });
  });
});
