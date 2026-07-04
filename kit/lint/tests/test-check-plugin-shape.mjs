// kit/lint/check-plugin-shape.mjs conformance test.
//
// Spawns the lint script against several fixtures and asserts exit codes
// + relevant stderr substrings. Run via:
//   node --test kit/lint/tests/test-check-plugin-shape.mjs

import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../..');
const LINT_SCRIPT = resolve(REPO_ROOT, 'kit/lint/check-plugin-shape.mjs');
const FIXTURES = resolve(REPO_ROOT, 'kit/lint/tests/fixtures');

function runLint(targetPath) {
  return new Promise((resolveP) => {
    const child = spawn('node', [LINT_SCRIPT, targetPath], { cwd: REPO_ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('close', (code) => resolveP({ code, stdout, stderr }));
  });
}

describe('kit/lint/check-plugin-shape', () => {
  it('exits 0 on a valid plugin (plugins/companions)', async () => {
    const result = await runLint(resolve(REPO_ROOT, 'plugins/companions'));
    strictEqual(result.code, 0, `expected exit 0, got ${result.code}; stderr=${result.stderr}`);
    ok(result.stdout.includes('shape OK'));
  });

  it('exits 1 when the Claude manifest is missing', async () => {
    const result = await runLint(resolve(FIXTURES, 'missing-claude'));
    strictEqual(result.code, 1);
    ok(result.stderr.includes('.claude-plugin/plugin.json: missing'));
  });

  it('exits 1 when the Codex manifest is missing', async () => {
    const result = await runLint(resolve(FIXTURES, 'missing-codex'));
    strictEqual(result.code, 1);
    ok(result.stderr.includes('.codex-plugin/plugin.json: missing'));
  });

  it('exits 1 when manifest names disagree across hosts', async () => {
    const result = await runLint(resolve(FIXTURES, 'name-mismatch'));
    strictEqual(result.code, 1);
    ok(result.stderr.includes('manifest name mismatch'));
  });

  it('exits 0 on a valid hook-only plugin fixture (ADR-0040 §3 category)', async () => {
    const result = await runLint(resolve(FIXTURES, 'hook-only-valid'));
    strictEqual(result.code, 0, `expected exit 0, got ${result.code}; stderr=${result.stderr}`);
    ok(result.stdout.includes('shape OK'));
  });

  it('exits 0 on the real hook-only plugin (plugins/attention)', async () => {
    const result = await runLint(resolve(REPO_ROOT, 'plugins/attention'));
    strictEqual(result.code, 0, `expected exit 0, got ${result.code}; stderr=${result.stderr}`);
    ok(result.stdout.includes('shape OK'));
  });

  it('exits 1 when hooks/hooks.json is not parseable JSON', async () => {
    const result = await runLint(resolve(FIXTURES, 'hooks-bad-json'));
    strictEqual(result.code, 1);
    ok(result.stderr.includes('hooks/hooks.json:'), `stderr=${result.stderr}`);
  });

  it('exits 1 when hooks/hooks.json top-level hooks key has the wrong shape', async () => {
    const result = await runLint(resolve(FIXTURES, 'hooks-bad-structure'));
    strictEqual(result.code, 1);
    ok(
      result.stderr.includes('"hooks" must be an object mapping event names'),
      `stderr=${result.stderr}`,
    );
  });

  it('exits 1 when a hook command target does not exist in the plugin', async () => {
    const result = await runLint(resolve(FIXTURES, 'hooks-missing-target'));
    strictEqual(result.code, 1);
    ok(
      result.stderr.includes('command target "adapters/claude/hooks/missing-sensor.mjs" does not exist'),
      `stderr=${result.stderr}`,
    );
  });

  it('exits 1 when a hook command references no ${CLAUDE_PLUGIN_ROOT} target', async () => {
    const result = await runLint(resolve(FIXTURES, 'hooks-no-root-command'));
    strictEqual(result.code, 1);
    ok(
      result.stderr.includes('must reference at least one ${CLAUDE_PLUGIN_ROOT}'),
      `stderr=${result.stderr}`,
    );
  });

  it('exits 2 with no arguments', async () => {
    const result = await new Promise((resolveP) => {
      const child = spawn('node', [LINT_SCRIPT], { cwd: REPO_ROOT });
      let stderr = '';
      child.stderr.on('data', (b) => (stderr += b.toString()));
      child.on('close', (code) => resolveP({ code, stderr }));
    });
    strictEqual(result.code, 2);
    ok(result.stderr.includes('Usage:'));
  });

  it('exits 2 when target is not a directory', async () => {
    const result = await runLint(resolve(REPO_ROOT, 'package.json'));
    strictEqual(result.code, 2);
  });
});
